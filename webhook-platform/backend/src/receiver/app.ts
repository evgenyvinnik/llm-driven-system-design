/**
 * Mock receiver: the customer's server, with switchable failure modes.
 *
 * `POST /hooks/:name` behaves like a well-written webhook consumer:
 * 1. Faults that mean "the server is unhealthy" come first: `error500`,
 *    `gone410`, `rate429` (with Retry-After) answer before any processing.
 * 2. Verify `Webhook-Signature` against the secrets this path knows, and
 *    reject timestamps outside the replay window (401).
 * 3. Dedupe on `Webhook-Id` (the event id). A duplicate is acknowledged with
 *    200 but not applied again: that is what makes at-least-once safe.
 * 4. If the event has an ordering key, discard it as stale when a higher
 *    sequence for that key was already applied (still 200).
 * 5. Faults that happen after processing: `slow` answers late (past the
 *    platform's timeout if slowMs is large), `drop_ack` closes the socket
 *    without answering. Either way the event WAS processed and the platform
 *    doesn't know, so it retries, and step 3 flags the retry as a duplicate.
 *
 * Secrets: by default each path asks the platform for its endpoint's current
 * signing secrets (standing in for the customer copying the secret into
 * their config). `pinnedSecrets` overrides that, to simulate a receiver that
 * hasn't picked up a rotation yet.
 *
 * `/_control/*` (X-Internal-Token) reads and changes toggles and the log.
 * @module receiver/app
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { verifySignature, parseSignatureHeader } from '../delivery/signing.js'
import { pathPatchSchema, ReceiverState } from './state.js'

export type SecretSource = (path: string) => Promise<string[]>

/** Fetches a path's valid secrets from the platform, cached briefly. */
export function platformSecrets(apiUrl: string, token: string, ttlMs = 2000): SecretSource {
  const cache = new Map<string, { at: number; secrets: string[] }>()
  return async (path) => {
    const hit = cache.get(path)
    if (hit && Date.now() - hit.at < ttlMs) return hit.secrets
    try {
      const res = await fetch(`${apiUrl}/api/v1/internal/receiver-secrets?path=${encodeURIComponent(path)}`, { headers: { 'x-internal-token': token } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { secrets: string[] }
      cache.set(path, { at: Date.now(), secrets: body.secrets })
      return body.secrets
    } catch (err) {
      logger.warn({ err: (err as Error).message, path }, 'could not fetch secrets from the platform')
      return hit?.secrets ?? []
    }
  }
}

function header(req: Request, name: string): string | null {
  const v = req.get(name)
  return v === undefined ? null : v
}

export function createReceiverApp(state: ReceiverState, secretsFor: SecretSource, opts: { token: string; toleranceSeconds: number }) {
  const app = express()
  app.disable('x-powered-by')

  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    const got = Buffer.from(req.get('x-internal-token') ?? '')
    const want = Buffer.from(opts.token)
    if (got.length !== want.length || !timingSafeEqual(got, want)) return void res.status(401).json({ error: { code: 'BAD_TOKEN', message: 'X-Internal-Token required' } })
    next()
  }

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mock-receiver' }))

  app.post('/hooks/:name', express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
    const name = req.params.name
    const path = `/hooks/${name}`
    const raw = typeof req.body === 'string' ? req.body : ''
    let parsed: { id?: string; type?: string; ordering_key?: string; sequence?: number } = {}
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Left empty: signature check below reports the problem.
    }
    const eventId = header(req, 'webhook-id') ?? parsed.id ?? null
    const attempt = Number(header(req, 'webhook-attempt')) || null
    const fault = state.takeFault(name)
    const cfg = state.path(name)
    state.begin(name)
    res.on('close', () => state.end(name))
    const base = {
      path: name,
      receivedAt: new Date().toISOString(),
      eventId,
      deliveryId: header(req, 'webhook-delivery'),
      type: parsed.type ?? null,
      attempt,
      orderingKey: parsed.ordering_key ?? header(req, 'webhook-ordering-key'),
      sequence: typeof parsed.sequence === 'number' ? parsed.sequence : Number(header(req, 'webhook-sequence')) || null,
      signaturesPresented: parseSignatureHeader(header(req, 'webhook-signature'))?.signatures.length ?? 0,
      fault,
    }

    // 1. Unhealthy-server faults answer before doing any work.
    if (fault === 'error500' || fault === 'gone410' || fault === 'rate429') {
      const status = fault === 'error500' ? 500 : fault === 'gone410' ? 410 : 429
      state.add({ ...base, signatureValid: null, signatureReason: null, duplicate: false, stale: false, processed: false, responseStatus: status, note: `Fault ${fault}: not processed` })
      if (fault === 'rate429') res.set('Retry-After', String(cfg.retryAfterSeconds))
      return void res.status(status).json({ error: fault })
    }

    // 2. Signature and replay window.
    const secrets = cfg.pinnedSecrets ?? (await secretsFor(path))
    const verdict = verifySignature(header(req, 'webhook-signature'), raw, secrets, { toleranceSeconds: opts.toleranceSeconds })
    if (!verdict.ok) {
      state.add({ ...base, signatureValid: false, signatureReason: verdict.reason, duplicate: false, stale: false, processed: false, responseStatus: 401, note: `Rejected: ${verdict.reason}` })
      return void res.status(401).json({ error: 'invalid_signature', reason: verdict.reason })
    }

    // 3. Dedupe, 4. stale check.
    const duplicate = eventId ? state.markSeen(name, eventId) : false
    const stale = !duplicate && base.orderingKey && base.sequence ? state.checkStale(name, base.orderingKey, base.sequence) : false
    const note = duplicate ? 'Duplicate event id: acknowledged, not applied again' : stale ? 'Older sequence than one already applied: discarded' : 'Applied'
    const entry = state.add({ ...base, signatureValid: true, signatureReason: verdict.matchedSecretIndex === 0 ? 'secret #1' : `secret #${verdict.matchedSecretIndex + 1}`, duplicate, stale, processed: true, responseStatus: null, note })

    // 5. Faults after processing.
    if (fault === 'drop_ack') {
      state.setStatus(entry.seq, null, `${note}; then dropped the connection without answering`)
      setTimeout(() => req.socket.destroy(), Math.min(cfg.slowMs, 50))
      return
    }
    const answer = () => {
      if (res.writableEnded || req.socket.destroyed) {
        state.setStatus(entry.seq, null, `${note}; the platform hung up before the answer`)
        return
      }
      state.setStatus(entry.seq, 200)
      res.status(200).json({ received: true, duplicate, stale })
    }
    if (fault === 'slow') setTimeout(answer, cfg.slowMs)
    else answer()
  })

  app.use('/_control', express.json(), requireToken)
  app.get('/_control/paths', (_req, res) => res.json({ paths: state.listPaths().map((p) => ({ ...p, ...state.concurrency(p.name) })) }))
  app.get('/_control/paths/:name', (req, res) => res.json({ path: { ...state.path(req.params.name), ...state.concurrency(req.params.name) } }))
  app.put('/_control/paths/:name', (req, res) => {
    const parsed = pathPatchSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: parsed.error.issues.map((i) => i.message).join('; ') } })
    res.json({ path: state.update(req.params.name, parsed.data) })
  })
  const pathsParam = (req: Request) => (typeof req.query.paths === 'string' && req.query.paths !== '' ? req.query.paths.split(',') : null)
  app.get('/_control/received', (req, res) => {
    const limit = Math.min(1000, Number(req.query.limit) || 200)
    res.json({ received: state.received(pathsParam(req), limit), stats: state.stats(pathsParam(req)) })
  })
  app.delete('/_control/received', (req, res) => {
    state.clear(pathsParam(req))
    res.status(204).end()
  })
  return app
}

export const defaultReceiverOptions = { token: config.internalToken, toleranceSeconds: config.signing.toleranceSeconds }

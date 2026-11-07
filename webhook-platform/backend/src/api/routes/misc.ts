/**
 * Notifications, API keys, the mock receiver proxy, the operator overview and
 * the internal endpoint the mock receiver uses to learn its secrets.
 */
import { Router } from 'express'
import { z } from 'zod'
import { orgOf, requireCustomer, requireInternal, requireOperator } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { activeSigningSecrets } from '../../delivery/signing.js'
import type { EndpointRow } from '../services/dto.js'
import { opsOverview } from '../services/ops.js'

export const miscRouter = Router()

miscRouter.get(
  '/notifications',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<{ id: string; endpoint_id: string | null; kind: string; title: string; body: string; created_at: Date; read_at: Date | null }>(
      'SELECT * FROM notifications WHERE org_id = $1 ORDER BY id DESC LIMIT 100',
      [orgOf(req)],
    )
    res.json({
      unread: rows.filter((r) => !r.read_at).length,
      notifications: rows.map((r) => ({
        id: Number(r.id),
        endpointId: r.endpoint_id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        createdAt: r.created_at.toISOString(),
        readAt: r.read_at?.toISOString() ?? null,
      })),
    })
  }),
)

miscRouter.post(
  '/notifications/read-all',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const r = await pool.query('UPDATE notifications SET read_at = now() WHERE org_id = $1 AND read_at IS NULL', [orgOf(req)])
    res.json({ marked: r.rowCount })
  }),
)

miscRouter.get(
  '/api-keys',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<{ id: string; name: string; key_prefix: string; created_at: Date; last_used_at: Date | null }>(
      'SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE org_id = $1 AND revoked_at IS NULL ORDER BY created_at',
      [orgOf(req)],
    )
    res.json({
      apiKeys: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.key_prefix, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null })),
    })
  }),
)

// ── Mock receiver proxy ─────────────────────────────────────────────────────
// The receiver is shared by both demo orgs. Every call is filtered to the
// receiver paths of the caller's own endpoints, so Acme never sees what was
// delivered to Globex even though one process received both.

/** Receiver path names (the part after /hooks/) of this org's endpoints that point at the mock receiver. */
async function orgReceiverPaths(orgId: string): Promise<{ name: string; endpointId: string; description: string; status: string }[]> {
  const { rows } = await pool.query<Pick<EndpointRow, 'id' | 'url' | 'description' | 'status'>>(
    'SELECT id, url, description, status FROM endpoints WHERE org_id = $1 ORDER BY created_at',
    [orgId],
  )
  const out: { name: string; endpointId: string; description: string; status: string }[] = []
  for (const r of rows) {
    try {
      const u = new URL(r.url)
      const m = u.pathname.match(/^\/hooks\/([A-Za-z0-9_-]+)$/)
      if (m && Number(u.port || 80) === config.receiverPort) out.push({ name: m[1], endpointId: r.id, description: r.description, status: r.status })
    } catch {
      // Not a URL we can map to the receiver.
    }
  }
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function receiverCall(path: string, init: RequestInit = {}): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${config.receiverUrl}${path}`, {
      ...init,
      headers: { 'x-internal-token': config.internalToken, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    throw new HttpError(503, 'RECEIVER_UNAVAILABLE', `The mock receiver at ${config.receiverUrl} is not running`)
  }
  if (res.status === 204) return null
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & Record<string, unknown>
  if (!res.ok) throw new HttpError(res.status, body?.error?.code ?? 'RECEIVER_ERROR', body?.error?.message ?? 'Receiver call failed')
  return body
}

miscRouter.get(
  '/receiver',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const paths = await orgReceiverPaths(orgOf(req))
    const names = paths.map((p) => p.name)
    if (names.length === 0) return void res.json({ receiverUrl: config.receiverUrl, paths: [], received: [], stats: null })
    const configs = await Promise.all(names.map((n) => receiverCall(`/_control/paths/${n}`)))
    const limit = Math.min(500, Number(req.query.limit) || 100)
    const log = await receiverCall(`/_control/received?paths=${names.join(',')}&limit=${limit}`)
    res.json({
      receiverUrl: config.receiverUrl,
      paths: paths.map((p, i) => {
        const { pinnedSecrets, ...rest } = configs[i].path as { pinnedSecrets: string[] | null } & Record<string, unknown>
        return { ...p, config: { ...rest, pinnedSecrets: pinnedSecrets ? pinnedSecrets.length : null } }
      }),
      received: log.received,
      stats: log.stats,
    })
  }),
)

const togglesSchema = z
  .object({
    mode: z.enum(['ok', 'slow', 'error500', 'drop_ack', 'gone410', 'rate429']),
    remaining: z.number().int().min(1).max(1000).nullable(),
    slowMs: z.number().int().min(0).max(120_000),
    retryAfterSeconds: z.number().int().min(0).max(3600),
  })
  .partial()
  .strict()

miscRouter.put(
  '/receiver/paths/:name',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const patch = togglesSchema.parse(req.body)
    const paths = await orgReceiverPaths(orgOf(req))
    if (!paths.some((p) => p.name === req.params.name)) throw new HttpError(404, 'NOT_FOUND', 'None of your endpoints use that receiver path')
    res.json(await receiverCall(`/_control/paths/${req.params.name}`, { method: 'PUT', body: JSON.stringify(patch) }))
  }),
)

miscRouter.delete(
  '/receiver/received',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const names = (await orgReceiverPaths(orgOf(req))).map((p) => p.name)
    if (names.length > 0) await receiverCall(`/_control/received?paths=${names.join(',')}`, { method: 'DELETE' })
    res.status(204).end()
  }),
)

// ── Operator ────────────────────────────────────────────────────────────────

miscRouter.get(
  '/ops/overview',
  requireOperator,
  asyncHandler(async (_req, res) => {
    res.json(await opsOverview())
  }),
)

// ── Internal (mock receiver) ────────────────────────────────────────────────

/** The secrets a receiver path should currently accept: what a customer would have pasted into their config. */
miscRouter.get(
  '/internal/receiver-secrets',
  requireInternal,
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '')
    if (!/^\/hooks\/[A-Za-z0-9_-]+$/.test(path)) throw new HttpError(422, 'BAD_PATH', 'path must look like /hooks/<name>')
    const { rows } = await pool.query<EndpointRow>(`SELECT * FROM endpoints WHERE url LIKE '%' || $1`, [path])
    const secrets = new Set<string>()
    for (const r of rows) {
      try {
        if (new URL(r.url).pathname !== path) continue
      } catch {
        continue
      }
      for (const s of activeSigningSecrets({ secretCurrent: r.secret_current, secretPrevious: r.secret_previous, previousExpiresAt: r.previous_expires_at })) secrets.add(s)
    }
    res.json({ secrets: [...secrets] })
  }),
)

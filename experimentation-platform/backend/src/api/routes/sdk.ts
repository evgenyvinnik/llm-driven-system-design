/**
 * The SDK surface (in production: its own hostname behind a CDN).
 *
 *   GET  /sdk/v1/snapshot            latest ruleset; ETag + If-None-Match → 304
 *   GET  /sdk/v1/snapshots/:version  one immutable version (cacheable forever)
 *   GET  /sdk/v1/stream              SSE: hello {version}, then snapshot {version} on every change
 *   POST /sdk/v1/events              exposure / assignment / conversion batches (JSON or a text/plain beacon)
 *   POST /sdk/v1/clients/report      the version this SDK instance has applied (live client view)
 *   POST /sdk/v1/identify            server key: link anonymous id → user, returns the stable id
 *   POST /sdk/v1/evaluate            server key: evaluate keys for a context with the same core as the SDK
 *
 * Client keys are public (they ship in the bundle) and only read rulesets and
 * write events. Server keys are secret.
 * @module api/routes/sdk
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { etagMatches } from '../../domain/compile.js'
import { batchEnvelopeSchema } from '../../ingest/batch.js'
import { config } from '../../shared/config.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { evaluate } from '../../shared/evaluation.js'
import { snapshotRequests } from '../../shared/metrics.js'
import { markStream, reportClient } from '../../services/client-registry.js'
import { environmentForClientKey, environmentForServerKey, type EnvironmentRow } from '../../services/environment-service.js'
import { linkIdentity, resolveStableId } from '../../services/identity-service.js'
import { ingestBatch } from '../../services/ingest-service.js'
import { getByVersion, getLatest } from '../../services/snapshot-service.js'
import { addStreamClient, writeEvent } from '../live.js'

export const sdkRouter = Router()

/** Any origin may call the SDK surface; nothing here uses cookies. */
sdkRouter.use((req: Request, res: Response, next: NextFunction) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client-Key, X-Server-Key, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag, X-Snapshot-Version, X-Instance-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  if (req.method === 'OPTIONS') return void res.status(204).end()
  next()
})

async function clientEnvironment(req: Request): Promise<EnvironmentRow> {
  const fromBody = typeof req.body === 'object' && req.body ? (req.body as { clientKey?: unknown }).clientKey : undefined
  const key = req.get('X-Client-Key') ?? (typeof req.query.key === 'string' ? req.query.key : undefined) ?? (typeof fromBody === 'string' ? fromBody : undefined)
  const env = await environmentForClientKey(key)
  if (!env) throw new HttpError(401, 'INVALID_CLIENT_KEY', 'Unknown or missing client key')
  return env
}

async function serverEnvironment(req: Request): Promise<EnvironmentRow> {
  const env = await environmentForServerKey(req.get('X-Server-Key'))
  if (!env) throw new HttpError(401, 'INVALID_SERVER_KEY', 'Unknown or missing server key')
  return env
}

sdkRouter.get(
  '/snapshot',
  asyncHandler(async (req, res) => {
    const env = await clientEnvironment(req)
    const snap = await getLatest(env.key)
    if (!snap) throw new HttpError(503, 'NO_SNAPSHOT', 'No snapshot compiled yet')
    res.set({ ETag: snap.etag, 'Cache-Control': 'no-cache', 'X-Snapshot-Version': String(snap.version) })
    if (etagMatches(req.get('If-None-Match'), snap.etag)) {
      snapshotRequests.inc({ environment: env.key, result: '304' })
      return void res.status(304).end()
    }
    snapshotRequests.inc({ environment: env.key, result: '200' })
    res.type('application/json').send(snap.json)
  }),
)

sdkRouter.get(
  '/snapshots/:version',
  asyncHandler(async (req, res) => {
    const env = await clientEnvironment(req)
    const version = Number(req.params.version)
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'BAD_VERSION', 'Version must be a positive integer')
    const snap = await getByVersion(env.key, version)
    if (!snap) throw new HttpError(404, 'NOT_FOUND', `No snapshot v${version}`)
    snapshotRequests.inc({ environment: env.key, result: 'by_version' })
    res.set({ ETag: snap.etag, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Snapshot-Version': String(snap.version) })
    if (etagMatches(req.get('If-None-Match'), snap.etag)) return void res.status(304).end()
    res.type('application/json').send(snap.json)
  }),
)

const streamQuery = z.object({
  sdk: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).optional(),
  label: z.string().max(80).optional(),
  version: z.coerce.number().int().min(0).optional(),
})

sdkRouter.get(
  '/stream',
  asyncHandler(async (req, res) => {
    const env = await clientEnvironment(req)
    const q = streamQuery.parse(req.query)
    const sdkInstanceId = q.sdk ?? `anon-${Math.random().toString(36).slice(2, 10)}`
    const connId = `${config.instanceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
    res.write('retry: 2000\n\n')
    // Register before reading the latest version: a snapshot published in between
    // is then pushed (possibly before hello) instead of falling into a gap.
    const remove = addStreamClient({ environment: env.key, sdkInstanceId, label: q.label ?? '', res })
    const heartbeat = setInterval(() => res.write(': ping\n\n'), config.sseHeartbeatMs)
    req.on('close', () => {
      clearInterval(heartbeat)
      remove()
      void markStream(env.key, sdkInstanceId, q.label ?? '', config.instanceId, false, connId).catch(() => undefined)
    })
    const snap = await getLatest(env.key)
    writeEvent(res, 'hello', { instanceId: config.instanceId, environment: env.key, version: snap?.version ?? 0, etag: snap?.etag ?? null })
    await markStream(env.key, sdkInstanceId, q.label ?? '', config.instanceId, true, connId).catch(() => undefined)
  }),
)

/** sendBeacon can't set headers or a JSON content type cross-origin, so beacons arrive as text/plain JSON. */
const beaconText = express.text({ type: 'text/plain', limit: '512kb' })

sdkRouter.post(
  '/events',
  beaconText,
  asyncHandler(async (req, res) => {
    if (typeof req.body === 'string') {
      try {
        req.body = JSON.parse(req.body)
      } catch {
        throw new HttpError(400, 'INVALID_JSON', 'Body is not valid JSON')
      }
    }
    const env = await clientEnvironment(req)
    const envelope = batchEnvelopeSchema.parse(req.body)
    if (envelope.events.length > config.ingest.maxEventsPerBatch) throw new HttpError(413, 'BATCH_TOO_LARGE', `At most ${config.ingest.maxEventsPerBatch} events per batch`)
    const result = await ingestBatch(env.key, envelope)
    res.status(202).json({ accepted: result.accepted, rejected: result.rejected.length, rejections: result.rejected.slice(0, 10), duplicate: result.duplicate })
  }),
)

const reportSchema = z
  .object({
    sdkInstanceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
    label: z.string().max(80).optional(),
    version: z.number().int().min(0),
    source: z.enum(['network', 'cache', 'bootstrap', 'defaults']).optional(),
    transport: z.enum(['sse', 'poll']).optional(),
    clientKey: z.string().optional(),
  })
  .strict()

sdkRouter.post(
  '/clients/report',
  beaconText,
  asyncHandler(async (req, res) => {
    if (typeof req.body === 'string') req.body = JSON.parse(req.body || '{}')
    const env = await clientEnvironment(req)
    const { clientKey: _clientKey, ...report } = reportSchema.parse(req.body)
    const state = await reportClient(env.key, report, config.instanceId)
    res.json({ ok: true, latencyMs: state.lastUpdate?.latencyMs ?? null })
  }),
)

const identifySchema = z.object({ userId: z.string().min(1).max(128), anonymousId: z.string().min(1).max(128) }).strict()

sdkRouter.post(
  '/identify',
  asyncHandler(async (req, res) => {
    const env = await serverEnvironment(req)
    const { userId, anonymousId } = identifySchema.parse(req.body)
    res.json(await linkIdentity(env.key, userId, anonymousId))
  }),
)

const evaluateSchema = z
  .object({
    context: z
      .object({
        anonymousId: z.string().max(128).optional(),
        userId: z.string().max(128).optional(),
        stableId: z.string().max(128).optional(),
        orgId: z.string().max(128).optional(),
        attributes: z.record(z.string(), z.string().max(128)).optional(),
      })
      .strict(),
    keys: z.array(z.string()).max(100).optional(),
  })
  .strict()

sdkRouter.post(
  '/evaluate',
  asyncHandler(async (req, res) => {
    const env = await serverEnvironment(req)
    const { context, keys } = evaluateSchema.parse(req.body)
    const snap = await getLatest(env.key)
    if (!snap) throw new HttpError(503, 'NO_SNAPSHOT', 'No snapshot compiled yet')
    // A signed-in user without a stable id in the request gets their alias, exactly as the SDK would after sign-in.
    const ctx = { ...context }
    if (ctx.userId && !ctx.stableId) ctx.stableId = (await resolveStableId(env.key, ctx.userId)) ?? undefined
    const wanted = keys ?? Object.keys(snap.body.flags)
    const evaluations = Object.fromEntries(wanted.map((k) => [k, evaluate(snap.body, k, ctx)]))
    res.json({ environment: env.key, snapshotVersion: snap.version, stableId: ctx.stableId ?? null, evaluations })
  }),
)

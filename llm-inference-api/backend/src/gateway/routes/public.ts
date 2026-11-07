/**
 * Public API, authenticated by API key (x-api-key or Authorization: Bearer).
 *
 *   GET  /v1/models
 *   POST /v1/messages                sync (default) or stream (`"stream": true`)
 *   POST /v1/messages/async          202 + request id; fetch the result later
 *   GET  /v1/requests                recent requests of the key's org
 *   GET  /v1/requests/:id            status, result, usage, latency split
 *   GET  /v1/requests/:id/events     SSE attach (resumable with Last-Event-ID)
 *   POST /v1/requests/:id/cancel     the response says which transition won
 *   GET  /v1/usage                   last 24 h usage of the org
 * @module gateway/routes/public
 */
import { Router } from 'express'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { getRequest, getUsage, toPublicRequest, type RequestRow, type UsageRow } from '../../shared/requests.js'
import { cancelRequest } from '../cancel.js'
import { requirePrincipal } from '../principal.js'
import { respondAsync, respondAttach, respondStream, respondSync } from '../respond.js'
import { MODELS, submit } from '../submit.js'

export const publicRouter = Router()

publicRouter.get('/models', (_req, res) => {
  res.json({ data: MODELS.map((m) => ({ type: 'model', id: m.id, display_name: m.displayName, context_window: m.contextWindow })) })
})

publicRouter.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const p = await requirePrincipal(req)
    const stream = req.body?.stream === true
    const { row, replayed } = await submit(p, req.body, stream ? 'stream' : 'sync', req.get('idempotency-key') ?? null)
    if (stream) await respondStream(req, res, row, replayed)
    else await respondSync(req, res, row, replayed)
  }),
)

publicRouter.post(
  '/messages/async',
  asyncHandler(async (req, res) => {
    const p = await requirePrincipal(req)
    const { row, replayed } = await submit(p, req.body, 'async', req.get('idempotency-key') ?? null)
    respondAsync(res, row, replayed)
  }),
)

publicRouter.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const p = await requirePrincipal(req)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
    const { rows } = await pool.query<RequestRow & UsageRow>(
      `SELECT r.*, u.input_tokens, u.cached_input_tokens, u.output_tokens, u.reserved_tokens, u.refunded_tokens,
              u.queue_ms, u.ttft_ms, u.exec_ms, u.total_ms, u.tokens_per_sec
       FROM requests r LEFT JOIN usage u ON u.request_id = r.id
       WHERE r.org_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
      [p.orgId, limit],
    )
    res.json({ data: rows.map((r) => toPublicRequest(r, r.reserved_tokens === null ? null : r)) })
  }),
)

publicRouter.get(
  '/requests/:id',
  asyncHandler(async (req, res) => {
    const p = await requirePrincipal(req)
    const row = await getRequest(pool, req.params.id, [p.orgId])
    if (!row) throw notFound('Request')
    res.json(toPublicRequest(row, await getUsage(pool, row.id)))
  }),
)

publicRouter.get(
  '/requests/:id/events',
  asyncHandler(async (req, res) => {
    const p = await requirePrincipal(req)
    const row = await getRequest(pool, req.params.id, [p.orgId])
    if (!row) throw notFound('Request')
    await respondAttach(req, res, row)
  }),
)

publicRouter.post(
  '/requests/:id/cancel',
  asyncHandler(async (req, res) => {
    const p = await requirePrincipal(req)
    const { won, row } = await cancelRequest(req.params.id, 'client_request', [p.orgId])
    if (!row) throw notFound('Request')
    res.json({ ...toPublicRequest(row, await getUsage(pool, row.id)), cancelled: won })
  }),
)

publicRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const p = await requirePrincipal(req)
    const { rows } = await pool.query(
      `SELECT count(*)::int AS requests, coalesce(sum(input_tokens),0)::int AS input_tokens,
              coalesce(sum(cached_input_tokens),0)::int AS cache_read_input_tokens, coalesce(sum(output_tokens),0)::int AS output_tokens
       FROM usage WHERE org_id = $1 AND created_at > now() - interval '24 hours'`,
      [p.orgId],
    )
    res.json({ org: p.orgSlug, tier: p.tier, limits: { tokens_per_minute: p.tokensPerMinute, requests_per_minute: p.requestsPerMinute }, last_24h: rows[0] })
  }),
)

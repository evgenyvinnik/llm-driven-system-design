/**
 * Developer console API (session auth). A member picks one of their org's API
 * keys; requests then run through the same submit/admission/queue path as the
 * public API, charged to that key's org.
 * @module gateway/routes/console
 */
import { Router, type Request } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { keys, redis } from '../../shared/cache.js'
import { pool } from '../../shared/db.js'
import { ApiError, asyncHandler, notFound } from '../../shared/errors.js'
import { getRequest, getUsage, toRequestDto, type RequestRow, type UsageRow } from '../../shared/requests.js'
import { bucketLevel, limitsPerMinute } from '../../shared/bucket.js'
import { cancelRequest } from '../cancel.js'
import { principalForMember } from '../principal.js'
import { respondAsync, respondAttach, respondStream, respondSync } from '../respond.js'
import { submit } from '../submit.js'

export const consoleRouter = Router()
consoleRouter.use(requireAuth)

/** Org ids the signed-in user can see (admins: all). */
async function visibleOrgIds(req: Request): Promise<string[]> {
  const user = req.user!
  const { rows } = user.isAdmin
    ? await pool.query<{ id: string }>('SELECT id FROM orgs')
    : await pool.query<{ id: string }>('SELECT org_id AS id FROM memberships WHERE user_id = $1', [user.id])
  return rows.map((r) => r.id)
}

consoleRouter.get(
  '/orgs',
  asyncHandler(async (req, res) => {
    const orgIds = await visibleOrgIds(req)
    const { rows } = await pool.query(
      `SELECT o.id, o.slug, o.name, o.tier, t.tokens_per_minute, t.requests_per_minute, t.max_queued_interactive, t.max_queued_batch, t.weight,
              EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.user_id = $2) AS is_member,
              coalesce(json_agg(json_build_object('id', k.id, 'name', k.name, 'prefix', k.key_prefix, 'lastUsedAt', k.last_used_at) ORDER BY k.created_at, k.name)
                FILTER (WHERE k.id IS NOT NULL AND k.revoked_at IS NULL), '[]') AS keys
       FROM orgs o JOIN tiers t ON t.name = o.tier LEFT JOIN api_keys k ON k.org_id = o.id
       WHERE o.id = ANY($1::uuid[]) GROUP BY o.id, t.name ORDER BY is_member DESC, o.name`,
      [orgIds, req.user!.id],
    )
    const now = Date.now()
    const buckets = await Promise.all(rows.map((r) => redis.hmget(keys.tokenBucket(r.id), 't', 'ts')))
    res.json({
      orgs: rows.map((r, i) => {
        const [t, ts] = buckets[i]
        const level = bucketLevel(t === null || ts === null ? null : { tokens: Number(t), updatedAt: Number(ts) }, now, limitsPerMinute(r.tokens_per_minute))
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          tier: r.tier,
          isMember: r.is_member,
          limits: { tokensPerMinute: r.tokens_per_minute, requestsPerMinute: r.requests_per_minute, maxQueuedInteractive: r.max_queued_interactive, maxQueuedBatch: r.max_queued_batch, weight: r.weight },
          tokensAvailable: Math.floor(level),
          keys: r.keys,
        }
      }),
    })
  }),
)

consoleRouter.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const { keyId, mode, ...body } = (req.body ?? {}) as Record<string, unknown>
    if (typeof keyId !== 'string') throw new ApiError(400, 'invalid_request_error', 'keyId is required')
    if (mode !== 'sync' && mode !== 'stream' && mode !== 'async') throw new ApiError(400, 'invalid_request_error', 'mode must be sync, stream or async')
    const p = await principalForMember(keyId, req.user!.id, req.user!.isAdmin)
    const { row, replayed } = await submit(p, { ...body, stream: mode === 'stream' }, mode, req.get('idempotency-key') ?? null)
    if (mode === 'stream') await respondStream(req, res, row, replayed)
    else if (mode === 'sync') await respondSync(req, res, row, replayed)
    else respondAsync(res, row, replayed)
  }),
)

consoleRouter.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const orgIds = await visibleOrgIds(req)
    const filterOrg = typeof req.query.orgId === 'string' ? req.query.orgId : null
    const filterKey = typeof req.query.keyId === 'string' ? req.query.keyId : null
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const { rows } = await pool.query<RequestRow & UsageRow & { key_name: string; org_name: string }>(
      `SELECT r.*, k.name AS key_name, o.name AS org_name,
              u.input_tokens, u.cached_input_tokens, u.output_tokens, u.reserved_tokens, u.refunded_tokens,
              u.queue_ms, u.ttft_ms, u.exec_ms, u.total_ms, u.tokens_per_sec
       FROM requests r JOIN api_keys k ON k.id = r.api_key_id JOIN orgs o ON o.id = r.org_id
       LEFT JOIN usage u ON u.request_id = r.id
       WHERE r.org_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR r.org_id = $2) AND ($3::uuid IS NULL OR r.api_key_id = $3)
       ORDER BY r.created_at DESC LIMIT $4`,
      [orgIds, filterOrg, filterKey, limit],
    )
    res.json({
      requests: rows.map((r) => toRequestDto({ ...r, input: null } as RequestRow, r.reserved_tokens === null ? null : r, { keyName: r.key_name, orgName: r.org_name })),
    })
  }),
)

consoleRouter.get(
  '/requests/:id',
  asyncHandler(async (req, res) => {
    const row = await getRequest(pool, req.params.id, await visibleOrgIds(req))
    if (!row) throw notFound('Request')
    const { rows: meta } = await pool.query<{ key_name: string; org_name: string }>(
      'SELECT k.name AS key_name, o.name AS org_name FROM api_keys k JOIN orgs o ON o.id = k.org_id WHERE k.id = $1',
      [row.api_key_id],
    )
    res.json({ request: toRequestDto(row, await getUsage(pool, row.id), { keyName: meta[0]?.key_name, orgName: meta[0]?.org_name }) })
  }),
)

consoleRouter.get(
  '/requests/:id/events',
  asyncHandler(async (req, res) => {
    const row = await getRequest(pool, req.params.id, await visibleOrgIds(req))
    if (!row) throw notFound('Request')
    await respondAttach(req, res, row)
  }),
)

consoleRouter.post(
  '/requests/:id/cancel',
  asyncHandler(async (req, res) => {
    const { won, row } = await cancelRequest(req.params.id, 'console', await visibleOrgIds(req))
    if (!row) throw notFound('Request')
    res.json({ cancelled: won, request: toRequestDto(row, await getUsage(pool, row.id)) })
  }),
)

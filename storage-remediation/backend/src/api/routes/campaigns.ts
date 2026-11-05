/**
 * Campaigns: preview, create (idempotent with Idempotency-Key), lifecycle
 * transitions (each a conditional UPDATE, so repeating one is harmless), and
 * live progress over SSE backed by the executor's Valkey event stream.
 */
import { Router, type Request, type Response } from 'express'
import { ownerScope, requireAuth, requireRole } from '../../shared/auth.js'
import { createRedisConnection, redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { sseConnections } from '../../shared/metrics.js'
import { audit } from '../../store/audit.js'
import { campaignInputSchema, createCampaign, previewPlan } from '../services/campaigns.js'

export const campaignsRouter = Router()

const COUNT_COLUMNS = `count(*)::int AS total,
  count(*) FILTER (WHERE t.state = 'pending')::int AS pending,
  count(*) FILTER (WHERE t.state = 'queued')::int AS queued,
  count(*) FILTER (WHERE t.state = 'applying')::int AS applying,
  count(*) FILTER (WHERE t.state = 'baking')::int AS baking,
  count(*) FILTER (WHERE t.state = 'rolling_back')::int AS rolling_back,
  count(*) FILTER (WHERE t.state = 'verified')::int AS verified,
  count(*) FILTER (WHERE t.state = 'rolled_back')::int AS rolled_back,
  count(*) FILTER (WHERE t.state = 'skipped')::int AS skipped,
  count(*) FILTER (WHERE t.state = 'escalated')::int AS escalated,
  count(*) FILTER (WHERE t.state = 'failed')::int AS failed,
  count(*) FILTER (WHERE t.state = 'cancelled')::int AS cancelled,
  count(*) FILTER (WHERE t.state = 'queued' AND t.not_before > now())::int AS deferred,
  count(*) FILTER (WHERE t.write_outcome = 'recovered')::int AS recovered,
  count(*) FILTER (WHERE t.write_outcome IN ('confirmed_after_5xx', 'confirmed_after_timeout'))::int AS reconciled,
  COALESCE(sum(t.throttle_count), 0)::int AS throttles`

function campaignDto(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    controlId: r.control_id,
    status: r.status,
    statusReason: r.status_reason,
    config: r.config,
    plan: r.plan_summary,
    selfService: r.self_service,
    createdBy: r.created_by_name ?? r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

campaignsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT c.*, u.display_name AS created_by_name, (SELECT row_to_json(x) FROM (SELECT ${COUNT_COLUMNS} FROM campaign_targets t WHERE t.campaign_id = c.id) x) AS counts,
              (SELECT min(wave_no) FROM campaign_waves w WHERE w.campaign_id = c.id AND w.status <> 'completed') AS current_wave,
              (SELECT count(*)::int FROM campaign_waves w WHERE w.campaign_id = c.id) AS wave_count
         FROM campaigns c JOIN users u ON u.id = c.created_by ORDER BY c.created_at DESC LIMIT 100`,
    )
    res.json({ campaigns: rows.map((r) => ({ ...campaignDto(r), counts: r.counts, currentWave: r.current_wave, waveCount: r.wave_count })) })
  }),
)

campaignsRouter.post(
  '/preview',
  requireRole('security'),
  asyncHandler(async (req, res) => {
    res.json({ plan: await previewPlan(pool, campaignInputSchema.parse(req.body)) })
  }),
)

campaignsRouter.post(
  '/',
  requireRole('security'),
  asyncHandler(async (req, res) => {
    const input = campaignInputSchema.parse(req.body)
    const result = await createCampaign(pool, input, req.user!, { idempotencyKey: req.header('idempotency-key') ?? undefined })
    res.status(result.replayed ? 200 : 201).json(result)
  }),
)

export async function campaignSnapshot(id: string, req: Request) {
  const { rows } = await pool.query(`SELECT c.*, u.display_name AS created_by_name FROM campaigns c JOIN users u ON u.id = c.created_by WHERE c.id = $1`, [id])
  if (!rows[0]) throw notFound('Campaign')
  const params: unknown[] = [id]
  const scope = ownerScope(req.user!, 'a', params)
  const [waves, counts, recent] = await Promise.all([
    pool.query(
      `SELECT w.wave_no, w.ring, w.label, w.status, w.target_count, w.started_at, w.finished_at, w.acknowledged_failures,
              (SELECT row_to_json(x) FROM (SELECT ${COUNT_COLUMNS} FROM campaign_targets t WHERE t.campaign_id = w.campaign_id AND t.wave_no = w.wave_no) x) AS counts
         FROM campaign_waves w WHERE w.campaign_id = $1 ORDER BY w.wave_no`,
      [id],
    ),
    pool.query(`SELECT ${COUNT_COLUMNS} FROM campaign_targets t WHERE t.campaign_id = $1`, [id]),
    pool.query(
      `SELECT t.id, t.account_id, a.name AS account_name, a.environment, t.wave_no, t.state, t.attempts, t.write_outcome, t.applied_at, t.bake_until,
              t.rollback_reason, t.last_error, t.not_before, t.updated_at, t.before_value, t.after_value
         FROM campaign_targets t JOIN storage_accounts a ON a.id = t.account_id
        WHERE t.campaign_id = $1 AND t.state <> 'pending' AND ${scope}
        ORDER BY (t.state IN ('rolling_back', 'rolled_back', 'failed', 'escalated')) DESC, t.updated_at DESC LIMIT 40`,
      params,
    ),
  ])
  return {
    campaign: campaignDto(rows[0]),
    counts: counts.rows[0],
    waves: waves.rows.map((w) => ({ waveNo: w.wave_no, ring: w.ring, label: w.label, status: w.status, targetCount: w.target_count, startedAt: w.started_at, finishedAt: w.finished_at, acknowledgedFailures: w.acknowledged_failures, counts: w.counts })),
    recent: recent.rows.map((t) => ({
      id: t.id,
      accountId: t.account_id,
      accountName: t.account_name,
      environment: t.environment,
      waveNo: t.wave_no,
      state: t.state,
      attempts: t.attempts,
      writeOutcome: t.write_outcome,
      appliedAt: t.applied_at,
      bakeUntil: t.bake_until,
      rollbackReason: t.rollback_reason,
      lastError: t.last_error,
      notBefore: t.not_before,
      updatedAt: t.updated_at,
      beforeValue: t.before_value,
      afterValue: t.after_value,
    })),
  }
}

async function recentEvents(id: string, count = 60) {
  const entries = (await redis.xrevrange(config.stream.campaignEvents(id), '+', '-', 'COUNT', count)) as [string, string[]][]
  return entries.map(([eventId, fields]) => ({ id: eventId, ...JSON.parse(fields[1] ?? '{}') }))
}

campaignsRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const snapshot = await campaignSnapshot(req.params.id, req)
    res.json({ ...snapshot, events: await recentEvents(req.params.id).catch(() => []) })
  }),
)

const TRANSITIONS: Record<string, { from: string[]; to: string; action: string }> = {
  start: { from: ['draft'], to: 'running', action: 'campaign.started' },
  pause: { from: ['running'], to: 'paused', action: 'campaign.paused' },
  resume: { from: ['paused'], to: 'running', action: 'campaign.resumed' },
  kill: { from: ['draft', 'running', 'paused'], to: 'killed', action: 'campaign.killed' },
}

campaignsRouter.post(
  '/:id/:transition(start|pause|resume|kill)',
  requireRole('security'),
  asyncHandler(async (req, res) => {
    const t = TRANSITIONS[req.params.transition]
    const user = req.user!
    const result = await withTransaction(async (c) => {
      const { rows } = await c.query<{ status: string; control_id: string }>('SELECT status, control_id FROM campaigns WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!rows[0]) throw notFound('Campaign')
      if (rows[0].status === t.to) return { status: t.to, changed: false }
      if (!t.from.includes(rows[0].status)) throw new HttpError(409, 'INVALID_TRANSITION', `Cannot ${req.params.transition} a ${rows[0].status} campaign`)
      await c.query(
        `UPDATE campaigns SET status = $2, status_reason = $3, updated_at = now(),
                started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
                finished_at = CASE WHEN $2 = 'killed' THEN now() ELSE finished_at END
          WHERE id = $1`,
        [req.params.id, t.to, t.to === 'paused' ? `Paused by ${user.displayName}` : t.to === 'killed' ? `Killed by ${user.displayName}` : null],
      )
      if (req.params.transition === 'resume') {
        // The human has seen the failures that paused the wave; only new ones count against the budget.
        await c.query(
          `UPDATE campaign_waves w SET acknowledged_failures = (SELECT count(*) FROM campaign_targets t WHERE t.campaign_id = w.campaign_id AND t.wave_no = w.wave_no AND t.state IN ('rolled_back', 'failed'))
            WHERE w.campaign_id = $1 AND w.status IN ('halted', 'running')`,
          [req.params.id],
        )
      }
      if (t.to === 'killed') {
        // Stop new writes. Targets already changed keep baking, and can still roll back.
        await c.query(`UPDATE campaign_targets SET state = 'cancelled', finished_at = now(), updated_at = now() WHERE campaign_id = $1 AND state IN ('pending', 'queued')`, [req.params.id])
      }
      await audit(c, { actor: `user:${user.username}`, action: t.action, campaignId: req.params.id, controlId: rows[0].control_id })
      return { status: t.to, changed: true }
    })
    res.json(result)
  }),
)

campaignsRouter.get(
  '/:id/events',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id
    await campaignSnapshot(id, req) // 404s and scope checks before the stream opens
    const key = config.stream.campaignEvents(id)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.flushHeaders?.()
    sseConnections.inc()
    const conn = createRedisConnection('sse')
    let closed = false
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
    req.on('close', () => {
      closed = true
      clearInterval(heartbeat)
      sseConnections.dec()
      conn.disconnect()
    })
    const sendSnapshot = async () => res.write(`event: snapshot\ndata: ${JSON.stringify(await campaignSnapshot(id, req))}\n\n`)
    // Resume from Last-Event-ID; otherwise start after the newest event that exists now.
    let lastId = req.header('last-event-id') ?? ((await redis.xrevrange(key, '+', '-', 'COUNT', 1)) as [string, string[]][])[0]?.[0] ?? '0'
    await sendSnapshot()
    let lastSnapshot = Date.now()
    while (!closed) {
      const result = (await conn.xread('COUNT', 100, 'BLOCK', 3000, 'STREAMS', key, lastId).catch(() => null)) as [string, [string, string[]][]][] | null
      if (closed) break
      for (const [eventId, fields] of result?.[0]?.[1] ?? []) {
        lastId = eventId
        res.write(`id: ${eventId}\nevent: progress\ndata: ${fields[1]}\n\n`)
      }
      if (Date.now() - lastSnapshot >= 1000 && (result || Date.now() - lastSnapshot >= 5000)) {
        await sendSnapshot().catch(() => undefined)
        lastSnapshot = Date.now()
      }
    }
    res.end()
  }),
)

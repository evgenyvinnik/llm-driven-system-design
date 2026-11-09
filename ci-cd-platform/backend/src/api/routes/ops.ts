/**
 * Operations overview: queue depth per label, per-repository concurrency, the fleet's
 * capacity and how the last few minutes of work were shared out. Scoped to the viewer's
 * repositories; an admin sees all of them.
 * @module api/routes/ops
 */
import { Router } from 'express'
import { z } from 'zod'
import { readableRepoIds } from '../../shared/access.js'
import { userOf } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { burstReport, startsTimeline } from '../services/ops.js'

export const opsRouter = Router()

opsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const ids = await readableRepoIds(pool, userOf(req))
    const since = z.coerce.number().int().min(10).max(3600).default(300).parse(req.query.windowSeconds)
    const [labels, repos, fleet, timeline, burst] = await Promise.all([
      pool.query<{ label: string; queued: number; oldest_ms: number }>(
        `SELECT label, count(*)::int AS queued, (EXTRACT(EPOCH FROM (now() - min(queued_at))) * 1000)::int AS oldest_ms
           FROM jobs, unnest(runs_on) AS label WHERE status = 'queued' AND repo_id = ANY($1::text[]) GROUP BY label ORDER BY label`,
        [ids],
      ),
      pool.query<{ id: string; full_name: string; limit: number; running: number; queued: number; waiting: number; attention: number; oldest_ms: number | null; last_claimed_at: Date | null }>(
        `SELECT r.id, r.full_name, r.max_concurrent_jobs AS limit,
                count(*) FILTER (WHERE j.status = 'running')::int AS running,
                count(*) FILTER (WHERE j.status = 'queued')::int AS queued,
                count(*) FILTER (WHERE j.status = 'waiting')::int AS waiting,
                count(*) FILTER (WHERE j.status = 'needs_attention')::int AS attention,
                (EXTRACT(EPOCH FROM (now() - min(j.queued_at) FILTER (WHERE j.status = 'queued'))) * 1000)::int AS oldest_ms,
                r.last_claimed_at
           FROM repositories r LEFT JOIN jobs j ON j.repo_id = r.id
          WHERE r.id = ANY($1::text[]) GROUP BY r.id ORDER BY r.full_name`,
        [ids],
      ),
      pool.query<{ online: number; total: number; slots: number; busy: number }>(
        `SELECT count(*) FILTER (WHERE last_seen_at > now() - make_interval(secs => $1::float8 / 1000))::int AS online, count(*)::int AS total,
                COALESCE(sum(slots) FILTER (WHERE last_seen_at > now() - make_interval(secs => $1::float8 / 1000)), 0)::int AS slots,
                (SELECT count(*)::int FROM jobs WHERE status = 'running') AS busy
           FROM runners`,
        [config.runnerOfflineMs],
      ),
      startsTimeline(ids, since, Math.max(1, Math.round(since / 60))),
      burstReport(ids, new Date(Date.now() - since * 1000)),
    ])
    res.json({
      windowSeconds: since,
      queues: labels.rows.map((l) => ({ label: l.label, queued: l.queued, oldestMs: l.oldest_ms })),
      repositories: repos.rows.map((r) => ({ id: r.id, fullName: r.full_name, limit: r.limit, running: r.running, queued: r.queued, waiting: r.waiting, attention: r.attention, oldestQueuedMs: r.oldest_ms, lastClaimedAt: r.last_claimed_at?.toISOString() ?? null })),
      fleet: fleet.rows[0],
      timeline,
      burst,
    })
  }),
)

opsRouter.get(
  '/burst-report',
  asyncHandler(async (req, res) => {
    const ids = await readableRepoIds(pool, userOf(req))
    const since = z.coerce.date().parse(req.query.since)
    res.json({ repositories: await burstReport(ids, since) })
  }),
)

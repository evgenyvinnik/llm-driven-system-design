/**
 * Operator views: run health over the last 24 hours, live executors, and the
 * mock model's failure/latency knobs (for exercising error paths on demand).
 */
import { Router } from 'express'
import { requireAdmin, requireAuth } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { modelSettingsPatchSchema } from '../../shared/model-settings.js'

export const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [statusCounts, active, perModel, hourly, topUsers, failures, executors] = await Promise.all([
      pool.query(
        `SELECT status, count(*)::int AS count FROM runs WHERE created_at > now() - interval '24 hours' GROUP BY status`,
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
                count(*) FILTER (WHERE status = 'running')::int AS running,
                extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'queued')) AS oldest_queued_seconds
           FROM runs WHERE status IN ('queued', 'running')`,
      ),
      pool.query(
        `SELECT model,
                count(*)::int AS runs,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_token_at - started_at) * 1000) AS ttft_p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM first_token_at - started_at) * 1000) AS ttft_p95,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - created_at) * 1000) AS queue_p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at) * 1000) AS duration_p95,
                coalesce(sum(input_tokens), 0)::int AS input_tokens,
                coalesce(sum(output_tokens), 0)::int AS output_tokens
           FROM runs
          WHERE created_at > now() - interval '24 hours'
          GROUP BY model
          ORDER BY model`,
      ),
      pool.query(
        `SELECT date_trunc('hour', created_at) AS hour,
                count(*)::int AS runs,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM runs
          WHERE created_at > now() - interval '24 hours'
          GROUP BY 1 ORDER BY 1`,
      ),
      pool.query(
        `SELECT u.display_name, count(*)::int AS runs,
                coalesce(sum(r.input_tokens + r.output_tokens), 0)::int AS tokens
           FROM runs r JOIN users u ON u.id = r.created_by
          WHERE r.created_at > now() - interval '24 hours'
          GROUP BY u.display_name
          ORDER BY tokens DESC
          LIMIT 5`,
      ),
      pool.query(
        `SELECT r.id, r.model, r.error_code, r.error_message, r.created_at, p.title
           FROM runs r JOIN prompts p ON p.id = r.prompt_id
          WHERE r.status = 'failed'
          ORDER BY r.created_at DESC
          LIMIT 8`,
      ),
      readExecutors(),
    ])

    res.json({
      statusCounts: Object.fromEntries(statusCounts.rows.map((r) => [r.status, r.count])),
      active: {
        queued: active.rows[0].queued,
        running: active.rows[0].running,
        oldestQueuedSeconds: num(active.rows[0].oldest_queued_seconds),
      },
      perModel: perModel.rows.map((r) => ({
        model: r.model,
        runs: r.runs,
        failed: r.failed,
        ttftP50Ms: num(r.ttft_p50),
        ttftP95Ms: num(r.ttft_p95),
        queueP50Ms: num(r.queue_p50),
        durationP95Ms: num(r.duration_p95),
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
      })),
      hourly: hourly.rows.map((r) => ({ hour: r.hour.toISOString(), runs: r.runs, failed: r.failed })),
      topUsers: topUsers.rows.map((r) => ({ displayName: r.display_name, runs: r.runs, tokens: r.tokens })),
      recentFailures: failures.rows.map((r) => ({
        id: r.id,
        model: r.model,
        errorCode: r.error_code,
        errorMessage: r.error_message,
        promptTitle: r.title,
        createdAt: r.created_at.toISOString(),
      })),
      executors,
    })
  }),
)

async function readExecutors() {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'executor:*', 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  if (keys.length === 0) return []
  const values = await redis.mget(keys)
  return values.filter((v): v is string => v !== null).map((v) => JSON.parse(v))
}

adminRouter.get(
  '/model-settings',
  asyncHandler(async (_req, res) => {
    res.json(await callModel('GET'))
  }),
)

adminRouter.put(
  '/model-settings',
  asyncHandler(async (req, res) => {
    res.json(await callModel('PUT', modelSettingsPatchSchema.parse(req.body)))
  }),
)

async function callModel(method: 'GET' | 'PUT', body?: unknown) {
  try {
    const response = await fetch(`${config.modelBaseUrl}/admin/settings`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new HttpError(502, 'MODEL_SETTINGS_FAILED', `Model service returned ${response.status}`)
    return await response.json()
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(502, 'MODEL_UNREACHABLE', 'The mock model service is not reachable')
  }
}

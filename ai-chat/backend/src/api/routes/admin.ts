/**
 * Operator views: generation health over the last 24 hours, recent
 * generations, and the knobs for producing slow, failing and disconnecting
 * answers on demand (the mock model's settings and the API's stream-drop setting).
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin, requireAuth } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { STREAM_DROP_SETTING_KEY } from '../../shared/generation-events.js'
import { modelSettingsPatchSchema } from '../../shared/model-settings.js'

export const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [statusCounts, perModel, recent] = await Promise.all([
      pool.query(
        `SELECT status, count(*)::int AS count FROM generations
          WHERE created_at > now() - interval '24 hours' GROUP BY status`,
      ),
      pool.query(
        `SELECT model,
                count(*)::int AS generations,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_token_at - started_at) * 1000) AS ttft_p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM first_token_at - started_at) * 1000) AS ttft_p95,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at) * 1000) AS duration_p95,
                coalesce(sum(output_tokens), 0)::int AS output_tokens
           FROM generations
          WHERE created_at > now() - interval '24 hours'
          GROUP BY model ORDER BY model`,
      ),
      pool.query(
        `SELECT g.id, g.status, g.kind, g.model, g.output_tokens, g.error_code, g.created_at,
                extract(epoch FROM g.first_token_at - g.started_at) * 1000 AS ttft_ms,
                u.display_name, c.title
           FROM generations g
           JOIN users u ON u.id = g.user_id
           JOIN conversations c ON c.id = g.conversation_id
          ORDER BY g.created_at DESC LIMIT 15`,
      ),
    ])
    res.json({
      statusCounts: Object.fromEntries(statusCounts.rows.map((r) => [r.status, r.count])),
      models: perModel.rows.map((r) => ({
        model: r.model,
        generations: r.generations,
        failed: r.failed,
        cancelled: r.cancelled,
        ttftP50Ms: num(r.ttft_p50),
        ttftP95Ms: num(r.ttft_p95),
        durationP95Ms: num(r.duration_p95),
        outputTokens: r.output_tokens,
      })),
      recent: recent.rows.map((r) => ({
        id: r.id,
        status: r.status,
        kind: r.kind,
        model: r.model,
        outputTokens: r.output_tokens,
        errorCode: r.error_code,
        ttftMs: num(r.ttft_ms),
        user: r.display_name,
        conversationTitle: r.title,
        createdAt: r.created_at.toISOString(),
      })),
    })
  }),
)

async function modelService(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${config.modelBaseUrl}${path}`, init)
  } catch {
    throw new HttpError(502, 'MODEL_UNREACHABLE', 'The model service is not reachable')
  }
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (!response.ok) {
    throw new HttpError(response.status, body.error?.code ?? 'MODEL_ERROR', body.error?.message ?? 'Model service error')
  }
  return body as Record<string, unknown>
}

adminRouter.get(
  '/model-settings',
  asyncHandler(async (_req, res) => {
    const [model, drop] = await Promise.all([modelService('/admin/settings'), redis.get(STREAM_DROP_SETTING_KEY)])
    res.json({ ...model, streamDropAfterEvents: Number(drop) || 0 })
  }),
)

adminRouter.put(
  '/model-settings',
  asyncHandler(async (req, res) => {
    const patch = modelSettingsPatchSchema.parse(req.body)
    const model = await modelService('/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const drop = await redis.get(STREAM_DROP_SETTING_KEY)
    res.json({ ...model, streamDropAfterEvents: Number(drop) || 0 })
  }),
)

const dropSchema = z.object({ afterEvents: z.number().int().min(0).max(10_000) }).strict()

/** Makes every API instance end generation streams after N events, so client resume can be watched. */
adminRouter.put(
  '/stream-drop',
  asyncHandler(async (req, res) => {
    const { afterEvents } = dropSchema.parse(req.body)
    if (afterEvents === 0) await redis.del(STREAM_DROP_SETTING_KEY)
    else await redis.set(STREAM_DROP_SETTING_KEY, String(afterEvents))
    res.json({ streamDropAfterEvents: afterEvents })
  }),
)

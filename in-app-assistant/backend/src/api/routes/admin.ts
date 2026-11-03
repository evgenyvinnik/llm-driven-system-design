/**
 * Operator views: turn traces, aggregate quality and cost metrics, index
 * health, the mock model's failure switches, and eval results.
 */
import { Router } from 'express'
import { requireAdmin, requireAuth } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'
import { enqueueBackfill } from '../../indexer/backfill.js'
import { indexStatus } from '../../indexer/worker.js'
import { runningCount } from '../../orchestrator/run-turn.js'

export const adminRouter = Router()
adminRouter.use(requireAuth, requireAdmin)

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [turns, latency, tools, policy, actions, apps, feedback] = await Promise.all([
      pool.query<{ status: string; count: string }>(`SELECT status, count(*) AS count FROM turns WHERE created_at > now() - interval '24 hours' GROUP BY status`),
      pool.query<{ p50: number | null; p95: number | null; steps: number | null; input: string | null; cached: string | null; output: string | null }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY active_ms) AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY active_ms) AS p95,
                avg(steps)::float AS steps, sum(input_tokens) AS input, sum(cache_read_tokens) AS cached, sum(output_tokens) AS output
           FROM turns WHERE created_at > now() - interval '24 hours' AND status IN ('completed', 'failed', 'cancelled')`,
      ),
      pool.query<{ name: string; calls: string; errors: string; p50: number | null }>(
        `SELECT name, count(*) AS calls, count(*) FILTER (WHERE (detail->>'ok')::boolean IS FALSE) AS errors,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50
           FROM turn_steps WHERE kind = 'tool_call' AND created_at > now() - interval '24 hours' GROUP BY name ORDER BY calls DESC`,
      ),
      pool.query<{ action: string; rule: string; count: string }>(
        `SELECT detail->>'action' AS action, detail->>'rule' AS rule, count(*) AS count FROM turn_steps
          WHERE kind = 'policy' AND detail ? 'action' AND created_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
      pool.query<{ status: string; count: string }>(`SELECT status, count(*) AS count FROM pending_actions WHERE created_at > now() - interval '24 hours' GROUP BY status`),
      pool.query<{ app: string; count: string }>(
        `SELECT c.app, count(*) AS count FROM turns t JOIN conversations c ON c.id = t.conversation_id WHERE t.created_at > now() - interval '24 hours' GROUP BY c.app`,
      ),
      pool.query<{ kind: string; count: string }>(`SELECT kind, count(*) AS count FROM assistant_feedback WHERE created_at > now() - interval '7 days' GROUP BY kind`),
    ])
    const l = latency.rows[0]
    const input = Number(l?.input ?? 0)
    res.json({
      turnsByStatus: Object.fromEntries(turns.rows.map((r) => [r.status, Number(r.count)])),
      turnsByApp: Object.fromEntries(apps.rows.map((r) => [r.app, Number(r.count)])),
      activeMs: { p50: l?.p50 ?? null, p95: l?.p95 ?? null },
      avgSteps: l?.steps ?? null,
      tokens: { input, cacheRead: Number(l?.cached ?? 0), output: Number(l?.output ?? 0), cacheHitRate: input ? Number(l?.cached ?? 0) / input : null },
      tools: tools.rows.map((r) => ({ name: r.name, calls: Number(r.calls), errors: Number(r.errors), p50Ms: r.p50 })),
      policy: policy.rows.map((r) => ({ action: r.action, rule: r.rule, count: Number(r.count) })),
      confirmations: Object.fromEntries(actions.rows.map((r) => [r.status, Number(r.count)])),
      feedback: Object.fromEntries(feedback.rows.map((r) => [r.kind, Number(r.count)])),
      model: { provider: config.model.provider, primary: config.model.primary, fallback: config.model.fallback },
      instance: { id: config.instanceId, runningTurns: runningCount() },
    })
  }),
)

adminRouter.get(
  '/turns',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT t.id, t.status, t.user_text, t.steps, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.active_ms, t.tainted, t.model,
              t.created_at, t.error_code, c.app, u.display_name
         FROM turns t JOIN conversations c ON c.id = t.conversation_id JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at DESC LIMIT 60`,
    )
    res.json({
      turns: rows.map((r) => ({
        id: r.id,
        status: r.status,
        userText: r.user_text,
        app: r.app,
        user: r.display_name,
        steps: r.steps,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        activeMs: r.active_ms,
        tainted: r.tainted,
        model: r.model,
        errorCode: r.error_code,
        createdAt: r.created_at.toISOString(),
      })),
    })
  }),
)

adminRouter.get(
  '/turns/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Turn')
    const { rows } = await pool.query('SELECT * FROM turns WHERE id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Turn not found')
    const t = rows[0]
    const [steps, actions] = await Promise.all([
      pool.query('SELECT step, kind, name, detail, latency_ms, input_tokens, output_tokens, cache_read_tokens, created_at FROM turn_steps WHERE turn_id = $1 ORDER BY id', [id]),
      pool.query('SELECT id, tool, args, reason, tainted, status, created_at, decided_at FROM pending_actions WHERE turn_id = $1 ORDER BY created_at', [id]),
    ])
    res.json({
      turn: {
        id: t.id,
        status: t.status,
        userText: t.user_text,
        finalText: t.final_text,
        tainted: t.tainted,
        model: t.model,
        steps: t.steps,
        activeMs: t.active_ms,
        errorMessage: t.error_message,
        citations: t.citations,
        clientContext: t.client_context,
        messages: t.messages,
        createdAt: t.created_at.toISOString(),
      },
      steps: steps.rows.map((s) => ({
        step: s.step,
        kind: s.kind,
        name: s.name,
        detail: s.detail,
        latencyMs: s.latency_ms,
        inputTokens: s.input_tokens,
        outputTokens: s.output_tokens,
        cacheReadTokens: s.cache_read_tokens,
        createdAt: s.created_at.toISOString(),
      })),
      actions: actions.rows.map((a) => ({ id: a.id, tool: a.tool, args: a.args, reason: a.reason, tainted: a.tainted, status: a.status, createdAt: a.created_at.toISOString(), decidedAt: a.decided_at?.toISOString() ?? null })),
    })
  }),
)

adminRouter.get(
  '/index',
  asyncHandler(async (_req, res) => {
    res.json({ index: await indexStatus() })
  }),
)

adminRouter.post(
  '/index/backfill',
  asyncHandler(async (_req, res) => {
    res.status(202).json({ queued: await enqueueBackfill() })
  }),
)

const modelAdminUrl = `http://localhost:${config.modelPort}/admin/settings`

adminRouter.get(
  '/model',
  asyncHandler(async (_req, res) => {
    if (config.model.provider !== 'mock') {
      res.json({ provider: config.model.provider, settings: null })
      return
    }
    const response = await fetch(modelAdminUrl).catch(() => null)
    if (!response?.ok) throw new HttpError(503, 'MODEL_UNREACHABLE', 'The mock model service is not running')
    res.json({ provider: 'mock', ...((await response.json()) as object) })
  }),
)

adminRouter.put(
  '/model',
  asyncHandler(async (req, res) => {
    if (config.model.provider !== 'mock') throw new HttpError(409, 'NOT_MOCK', 'Failure switches only exist on the mock model')
    const response = await fetch(modelAdminUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }).catch(() => null)
    if (!response) throw new HttpError(503, 'MODEL_UNREACHABLE', 'The mock model service is not running')
    res.status(response.status).json({ provider: 'mock', ...((await response.json()) as object) })
  }),
)

adminRouter.get(
  '/evals',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query('SELECT id, model, summary, results, created_at FROM eval_runs ORDER BY created_at DESC LIMIT 1')
    res.json({ run: rows[0] ? { id: Number(rows[0].id), model: rows[0].model, summary: rows[0].summary, results: rows[0].results, createdAt: rows[0].created_at.toISOString() } : null })
  }),
)

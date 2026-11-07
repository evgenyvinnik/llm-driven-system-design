/**
 * Admin API (platform operators): the live overview, runtime knobs, and
 * backend controls (drain/undrain, rolling version upgrade, chaos switches),
 * which the gateway forwards to the backend's own admin endpoint.
 * @module gateway/routes/admin
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { ApiError, asyncHandler } from '../../shared/errors.js'
import { resetRuntimeConfig, runtimeConfigSchema, setRuntimeConfig } from '../../shared/runtime-config.js'
import { adminOverview, routingView } from '../admin-overview.js'

export const adminRouter = Router()
adminRouter.use(requireAdmin)

adminRouter.get('/overview', asyncHandler(async (_req, res) => res.json(await adminOverview())))
adminRouter.get('/routing', asyncHandler(async (_req, res) => res.json(await routingView())))

adminRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    res.json({ config: await setRuntimeConfig(runtimeConfigSchema.parse(req.body)) })
  }),
)

adminRouter.post('/config/reset', asyncHandler(async (_req, res) => res.json({ config: await resetRuntimeConfig() })))

async function forward(backendId: string, method: 'POST' | 'PUT', path: string, body: unknown) {
  const b = config.backends.find((x) => x.id === backendId)
  if (!b) throw new ApiError(404, 'not_found_error', `backend ${backendId} not found`)
  let r: globalThis.Response
  try {
    r = await fetch(`${b.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
  } catch {
    throw new ApiError(502, 'api_error', `backend ${backendId} is unreachable`)
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, 'invalid_request_error', `backend ${backendId}: ${JSON.stringify(data)}`)
  return data
}

adminRouter.post(
  '/backends/:id/drain',
  asyncHandler(async (req, res) => {
    const { draining } = z.object({ draining: z.boolean() }).parse(req.body)
    res.json({ backend: await forward(req.params.id, 'POST', '/admin/drain', { draining }) })
  }),
)

adminRouter.post(
  '/backends/:id/upgrade',
  asyncHandler(async (req, res) => {
    const { version } = z.object({ version: z.string().min(1).max(64) }).parse(req.body)
    res.json({ backend: await forward(req.params.id, 'POST', '/admin/upgrade', { version }) })
  }),
)

const backendSettings = z
  .object({
    ttftMs: z.number().int().min(0).max(20_000),
    prefillMsPerToken: z.number().min(0).max(10),
    tokensPerSecond: z.number().int().min(1).max(2000),
    admitOverheadMs: z.number().int().min(0).max(5000),
    crashAfterTokens: z.number().int().min(1).max(10_000),
    slots: z.number().int().min(1).max(1000),
    batching: z.enum(['continuous', 'static']),
    chaos: z.record(z.enum(['crash_mid_stream', 'refuse', 'slow', 'overload']), z.number().int().min(0).max(50)),
  })
  .partial()

adminRouter.put(
  '/backends/:id/settings',
  asyncHandler(async (req, res) => {
    res.json({ backend: await forward(req.params.id, 'PUT', '/admin/settings', backendSettings.parse(req.body)) })
  }),
)

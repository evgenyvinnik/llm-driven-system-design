/**
 * Lets the browser drive the simulator. The simulator's control port has no auth
 * of its own, so everything goes through here with a role check, and the API is
 * the only thing that talks to it on the browser's behalf.
 */
import { Router } from 'express'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'

export const simRouter = Router()

async function forward(path: string, method: string, body?: unknown) {
  let response: Response
  try {
    response = await fetch(`${config.simulatorUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(180_000),
    })
  } catch {
    throw new HttpError(503, 'SIMULATOR_DOWN', 'The simulator is not running. Start it with npm run dev:simulator.')
  }
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data }
}

simRouter.get(
  '/sim/state',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { status, data } = await forward('/control/state', 'GET')
    res.status(status).json(data)
  }),
)

simRouter.post(
  '/sim/control/:action',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const { status, data } = await forward(`/control/${encodeURIComponent(req.params.action)}`, 'POST', req.body ?? {})
    res.status(status).json(data)
  }),
)

simRouter.post(
  '/sim/scenario/:name',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const { status, data } = await forward(`/scenario/${encodeURIComponent(req.params.name)}`, 'POST', req.body ?? {})
    res.status(status).json(data)
  }),
)

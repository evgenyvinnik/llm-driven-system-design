/**
 * Dev-only endpoints: the armed-count chaos switch (per user) and which
 * instance answered. Mounted only when CHAOS_ENABLED (default on outside production).
 *
 *   GET /api/v1/dev/chaos      → { dropNextPatchResponses }
 *   PUT /api/v1/dev/chaos      { dropNextPatchResponses: n } arms the next n PATCHes to lose their response after commit
 *   GET /api/v1/dev/instance   → { instanceId }
 * @module api/routes/dev
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { armChaos, getChaos } from '../../shared/chaos.js'
import { config } from '../../shared/config.js'
import { asyncHandler } from '../../shared/errors.js'

export const devRouter = Router()

const chaosSchema = z.object({ dropNextPatchResponses: z.number().int().min(0).max(20) }).strict()

devRouter.get(
  '/chaos',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await getChaos(req.user!.id))
  }),
)

devRouter.put(
  '/chaos',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await armChaos(req.user!.id, chaosSchema.parse(req.body)))
  }),
)

devRouter.get('/instance', (_req, res) => {
  res.json({ instanceId: config.instanceId })
})

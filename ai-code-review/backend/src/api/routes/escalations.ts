import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, userOf } from '../../shared/auth.js'
import { asyncHandler } from '../../shared/errors.js'
import { claimEscalation, decideEscalation, releaseEscalation } from '../services/escalations.js'
import { listEscalations } from '../services/views.js'

export const escalationsRouter = Router()
escalationsRouter.use(requireAuth)

escalationsRouter.get(
  '/escalations',
  asyncHandler(async (req, res) => {
    res.json({ escalations: await listEscalations(userOf(req), { status: (req.query.status as string | undefined) ?? 'active', repo: req.query.repo as string | undefined }) })
  }),
)

escalationsRouter.post(
  '/escalations/:id/claim',
  asyncHandler(async (req, res) => {
    await claimEscalation(req.params.id, userOf(req))
    res.json({ ok: true })
  }),
)

escalationsRouter.post(
  '/escalations/:id/release',
  asyncHandler(async (req, res) => {
    await releaseEscalation(req.params.id, userOf(req))
    res.json({ ok: true })
  }),
)

const decideBody = z.object({ decision: z.enum(['approve', 'reject']), headSha: z.string().length(40), note: z.string().max(1000).optional() }).strict()

escalationsRouter.post(
  '/escalations/:id/decide',
  asyncHandler(async (req, res) => {
    res.json(await decideEscalation(req.params.id, userOf(req), decideBody.parse(req.body)))
  }),
)

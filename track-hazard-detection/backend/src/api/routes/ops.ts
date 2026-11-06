/**
 * Platform operations (admin): streams, consumer lag, outbox, projections,
 * gateways, dead letters, sensor registration, replay.
 */
import { Router } from 'express'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { asyncHandler } from '../../shared/errors.js'
import { deadLetters, discard, overview, redrive, registerSensor, registerSensorSchema, replay } from '../services/ops.js'

export const opsRouter = Router()
opsRouter.use(requireAuth)

// Everyone signed in can see pipeline health; only admins change anything.
opsRouter.get('/overview', asyncHandler(async (_req, res) => res.json(await overview())))
opsRouter.get('/dlq', asyncHandler(async (_req, res) => res.json({ deadLetters: await deadLetters() })))

opsRouter.post('/dlq/:id/redrive', requireRole('admin'), asyncHandler(async (req, res) => res.json(await redrive(req.params.id, req.user!))))
opsRouter.post(
  '/dlq/:id/discard',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    await discard(req.params.id, req.user!)
    res.status(204).end()
  }),
)
opsRouter.post('/sensors', requireRole('admin'), asyncHandler(async (req, res) => res.status(201).json(await registerSensor(registerSensorSchema.parse(req.body), req.user!))))
opsRouter.post('/replay/:projection', requireRole('admin'), asyncHandler(async (req, res) => res.json(await replay(req.params.projection))))

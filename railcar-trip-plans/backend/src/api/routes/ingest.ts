import { Router } from 'express'
import { requireIngestOrOps, requireIngestToken } from '../../shared/auth.js'
import { withTransaction } from '../../shared/db.js'
import { config } from '../../shared/config.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { createTrip, PlanningError } from '../../shared/plans.js'
import { z } from 'zod'
import { IngestBatch, ingest } from '../services/ingest.js'

export const ingestRouter = Router()

/** Facts from producers: AEI gateways, yard systems, the train-movement system, the interchange EDI bridge. */
ingestRouter.post(
  '/events',
  requireIngestToken,
  asyncHandler(async (req, res) => {
    const { events } = IngestBatch.parse(req.body)
    res.json(await ingest(events))
  }),
)

const CreateTrip = z.object({
  tripId: z.string().min(1).max(40),
  carId: z.string().min(1).max(20),
  shipperId: z.string().min(1).max(10),
  originYard: z.string().min(2).max(8),
  destinationYard: z.string().min(2).max(8),
  destinationCustomer: z.string().min(1).max(40),
  via: z.string().max(8).nullable().optional(),
  handoffRoad: z.string().max(8).nullable().optional(),
  releasedAt: z.string().datetime({ offset: true }),
})

/** A waybill: plan the trip and append TripPlanCreated (idempotent on tripId). */
ingestRouter.post(
  '/trips',
  asyncHandler(requireIngestOrOps),
  asyncHandler(async (req, res) => {
    const input = CreateTrip.parse(req.body)
    try {
      const viaToken = req.get('x-ingest-token') === config.ingestToken
      const result = await withTransaction((tx) => createTrip(tx, input, viaToken || !req.user ? 'waybill-feed' : `ops:${req.user.username}`))
      res.status(result.status === 'appended' ? 201 : 200).json(result)
    } catch (err) {
      if (err instanceof PlanningError) throw new HttpError(422, 'PLANNING_FAILED', err.message)
      throw err
    }
  }),
)

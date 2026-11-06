/**
 * Gateway-facing ingest endpoints. Authenticated with X-Ingest-Token, never a
 * user session. All are idempotent and safe to retry.
 */
import { Router } from 'express'
import { requireIngestToken } from '../../shared/auth.js'
import { now } from '../../shared/clock.js'
import { asyncHandler } from '../../shared/errors.js'
import { publishEvents } from '../../shared/events.js'
import { consistSchema, heartbeatSchema, recordHeartbeats, recordTripEvent, tripEventSchema, upsertConsist } from '../services/feeds.js'
import { batchSchema, ingestBatch } from '../services/ingest.js'

export const ingestRouter = Router()
ingestRouter.use(requireIngestToken)

ingestRouter.post(
  '/passes',
  asyncHandler(async (req, res) => {
    const batch = batchSchema.parse(req.body)
    const result = await ingestBatch(batch, now())
    // 200 for a batch that was entirely duplicates, 201 when something new was stored: both tell the gateway to drop its copy.
    res.status(result.accepted > 0 ? 201 : 200).json(result)
  }),
)

ingestRouter.post(
  '/heartbeats',
  asyncHandler(async (req, res) => {
    const updated = await recordHeartbeats(heartbeatSchema.parse(req.body))
    res.json({ updated })
  }),
)

ingestRouter.post(
  '/consists',
  asyncHandler(async (req, res) => {
    const input = consistSchema.parse(req.body)
    const result = await upsertConsist(input)
    await publishEvents([{ type: 'trip.updated', tripId: input.tripId }])
    res.status(result.status === 'created' ? 201 : 200).json(result)
  }),
)

ingestRouter.post(
  '/trip-events',
  asyncHandler(async (req, res) => {
    const input = tripEventSchema.parse(req.body)
    const status = await recordTripEvent(input)
    if (status === 'recorded') await publishEvents([{ type: 'trip.updated', tripId: input.tripId }])
    res.status(status === 'recorded' ? 201 : 200).json({ status })
  }),
)

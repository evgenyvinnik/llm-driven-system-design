/**
 * Edge ingest: gateways and the PTC feed post batches here (X-Ingest-Token;
 * per-gateway mTLS in production).
 */
import { Router } from 'express'
import { requireIngestToken } from '../../shared/auth.js'
import { asyncHandler } from '../../shared/errors.js'
import { batchSchema, ingestBatch } from '../services/ingest.js'

export const ingestRouter = Router()

ingestRouter.post(
  '/batches',
  requireIngestToken,
  asyncHandler(async (req, res) => {
    const batch = batchSchema.parse(req.body)
    res.json(await ingestBatch(batch))
  }),
)

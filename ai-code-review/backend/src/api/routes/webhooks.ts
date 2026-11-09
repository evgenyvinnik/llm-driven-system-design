/**
 * The webhook receiver: raw bytes in, because a signature covers bytes, not a
 * re-serialized object. Everything else is in services/deliveries.ts.
 * @module api/routes/webhooks
 */
import express, { Router } from 'express'
import { asyncHandler } from '../../shared/errors.js'
import { processDelivery } from '../services/deliveries.js'

export const webhooksRouter = Router()

webhooksRouter.post(
  '/git-host',
  express.raw({ type: '*/*', limit: '20mb' }),
  asyncHandler(async (req, res) => {
    const result = await processDelivery({
      deliveryId: req.header('x-hook-delivery'),
      event: req.header('x-hook-event'),
      signature: req.header('x-hook-signature'),
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from(''),
    })
    res.status(result.status).json(result.body)
  }),
)

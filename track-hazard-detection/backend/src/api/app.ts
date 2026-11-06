/**
 * API service: edge ingest, read APIs, hazard commands, ops, and the SSE stream.
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { pinoHttp } from 'pino-http'
import { attachUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { authRouter } from './routes/auth.js'
import { hazardsRouter } from './routes/hazards.js'
import { ingestRouter } from './routes/ingest.js'
import { liveRouter } from './routes/live.js'
import { opsRouter } from './routes/ops.js'
import { readRouter } from './routes/read.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' || req.url?.startsWith('/api/v1/live') === true || req.url?.startsWith('/api/v1/ingest') === true },
    }),
  )
  app.use(httpMetrics)
  // A reconnecting gateway can deliver thousands of buffered events in one batch.
  app.use('/api/v1/ingest', express.json({ limit: '16mb' }))
  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())
  app.use(asyncHandler(attachUser))

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      await Promise.all([pool.query('SELECT 1'), redis.ping()])
      res.json({ status: 'ready' })
    }),
  )
  app.get('/metrics', metricsHandler)

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/ingest', ingestRouter)
  app.use('/api/v1/hazards', hazardsRouter)
  app.use('/api/v1/ops', opsRouter)
  app.use('/api/v1/live', liveRouter)
  app.use('/api/v1', readRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

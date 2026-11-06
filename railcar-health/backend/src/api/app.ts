/**
 * API service: gateway ingest, read APIs for the dispatcher, yard and
 * reliability UIs, the yard workflow, admin, and the SSE live-update stream.
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { pinoHttp } from 'pino-http'
import { attachUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { clockInfo } from '../shared/clock.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { adminRouter } from './routes/admin.js'
import { alertsRouter } from './routes/alerts.js'
import { authRouter } from './routes/auth.js'
import { carsRouter } from './routes/cars.js'
import { eventLogRouter } from './routes/event-log.js'
import { eventsRouter } from './routes/events.js'
import { ingestRouter } from './routes/ingest.js'
import { networkRouter } from './routes/network.js'
import { opsRouter } from './routes/ops.js'
import { tripsRouter } from './routes/trips.js'
import { workOrdersRouter, yardsRouter } from './routes/yards.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/metrics' || req.url?.startsWith('/api/v1/events') === true || req.url?.startsWith('/api/v1/ingest/heartbeats') === true,
      },
    }),
  )
  app.use(httpMetrics)
  // Ingest batches carry ~700 readings per pass; everything else is small.
  app.use('/api/v1/ingest', express.json({ limit: '8mb' }))
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
  app.get('/api/v1/clock', (_req, res) => res.json(clockInfo()))

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/ingest', ingestRouter)
  app.use('/api/v1/alerts', alertsRouter)
  app.use('/api/v1/trips', tripsRouter)
  app.use('/api/v1/cars', carsRouter)
  app.use('/api/v1/yards', yardsRouter)
  app.use('/api/v1/work-orders', workOrdersRouter)
  app.use('/api/v1/network', networkRouter)
  app.use('/api/v1/admin', adminRouter)
  app.use('/api/v1/events', eventsRouter)
  app.use('/api/v1/event-log', eventLogRouter)
  app.use('/api/v1/ops', opsRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

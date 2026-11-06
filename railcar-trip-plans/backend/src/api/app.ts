/**
 * API service: producer ingest, waybill intake, the shipper portal and operations reads, exception and plan
 * commands, and the streams/DLQ operations page.
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
import { authRouter } from './routes/auth.js'
import { carsRouter, eventsRouter } from './routes/cars.js'
import { ingestRouter } from './routes/ingest.js'
import { opsRouter } from './routes/ops.js'
import { streamsRouter } from './routes/streams.js'
import { streamsOverview } from './services/streams.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' || req.url?.startsWith('/api/v1/ingest/events') === true },
    }),
  )
  app.use(httpMetrics)
  app.use('/api/v1/ingest', express.json({ limit: '4mb' }))
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
  // Lag, pending, staleness and DLQ gauges are refreshed from Valkey at scrape time.
  app.get(
    '/metrics',
    asyncHandler(async (req, res) => {
      await streamsOverview().catch(() => undefined)
      await metricsHandler(req, res)
    }),
  )
  app.get('/api/v1/clock', (_req, res) => res.json(clockInfo()))

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/ingest', ingestRouter)
  app.use('/api/v1/cars', carsRouter)
  app.use('/api/v1/events', eventsRouter)
  app.use('/api/v1/streams', streamsRouter)
  app.use('/api/v1', opsRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

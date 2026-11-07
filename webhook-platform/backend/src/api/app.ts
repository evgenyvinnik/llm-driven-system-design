/**
 * API service: producer intake, the customer console API, the operator
 * overview and the mock receiver proxy. Stateless apart from Valkey sessions,
 * so dev:server1/dev:server2 run more instances behind a load balancer.
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { pinoHttp } from 'pino-http'
import { attachUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { authRouter } from './routes/auth.js'
import { deliveriesRouter } from './routes/deliveries.js'
import { endpointsRouter } from './routes/endpoints.js'
import { eventsRouter } from './routes/events.js'
import { miscRouter } from './routes/misc.js'

const QUIET = ['/health', '/metrics', '/api/v1/internal/']

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: { ignore: (req) => QUIET.some((p) => req.url?.startsWith(p)) || req.method === 'GET' },
    }),
  )
  app.use(httpMetrics)
  // Event payloads are capped at MAX_PAYLOAD_BYTES; leave room for the envelope.
  app.use(express.json({ limit: config.delivery.maxPayloadBytes + 16 * 1024 }))
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
  app.use('/api/v1', eventsRouter)
  app.use('/api/v1', endpointsRouter)
  app.use('/api/v1', deliveriesRouter)
  app.use('/api/v1', miscRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

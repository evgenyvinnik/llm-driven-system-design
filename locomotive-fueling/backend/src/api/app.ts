/**
 * API service: telemetry ingest, integration endpoints, the fuel desk / crew /
 * admin REST API and SSE live updates. Stateless apart from Valkey sessions,
 * so dev:server1/dev:server2 run more instances behind a load balancer.
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
import { adminRouter } from './routes/admin.js'
import { authRouter } from './routes/auth.js'
import { eventsRouter } from './routes/events.js'
import { fleetRouter } from './routes/fleet.js'
import { integrationsRouter, telemetryRouter } from './routes/integrations.js'
import { opsRouter } from './routes/ops.js'

const QUIET = ['/health', '/metrics', '/api/v1/telemetry/batch', '/api/v1/integrations/clock', '/api/v1/events']

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: { ignore: (req) => QUIET.some((p) => req.url?.startsWith(p)) || req.url?.includes('/instructions') === true },
    }),
  )
  app.use(httpMetrics)
  app.use(express.json({ limit: '1mb' }))
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

  app.use('/api/v1/telemetry', telemetryRouter)
  app.use('/api/v1/integrations', integrationsRouter)
  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/events', eventsRouter)
  app.use('/api/v1', fleetRouter)
  app.use('/api/v1', opsRouter)
  app.use('/api/v1', adminRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

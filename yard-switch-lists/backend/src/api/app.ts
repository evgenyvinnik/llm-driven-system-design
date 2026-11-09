/**
 * API service: the yardmaster and crew REST API plus machine integrations.
 * Stateless apart from Valkey sessions, so dev:server1/dev:server2 run more
 * instances behind a load balancer.
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
import { analysisRouter } from './routes/analysis.js'
import { authRouter } from './routes/auth.js'
import { plansRouter } from './routes/plans.js'
import { simRouter } from './routes/sim.js'
import { integrationsRouter, yardRouter } from './routes/yard.js'

const QUIET = ['/health', '/metrics', '/api/v1/yard/board', '/api/v1/crew/moves', '/api/v1/integrations', '/api/v1/sim/state']

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: { ignore: (req) => QUIET.some((p) => req.url?.startsWith(p)) },
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

  app.use('/api/v1/integrations', integrationsRouter)
  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1', yardRouter)
  app.use('/api/v1', plansRouter)
  app.use('/api/v1', analysisRouter)
  app.use('/api/v1', simRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

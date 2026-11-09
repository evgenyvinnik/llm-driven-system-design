/**
 * API service: the webhook receiver and the review console's API. Stateless apart
 * from Valkey sessions, so dev:server1/dev:server2 run more instances.
 * @module api/app
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
import { auditRouter } from './routes/audit.js'
import { authRouter } from './routes/auth.js'
import { escalationsRouter } from './routes/escalations.js'
import { evaluationsRouter } from './routes/evaluations.js'
import { fixturesRouter } from './routes/fixtures.js'
import { prsRouter } from './routes/prs.js'
import { reposRouter } from './routes/repos.js'
import { webhooksRouter } from './routes/webhooks.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: { ignore: (req) => req.method === 'GET' || req.url === '/health' },
    }),
  )
  app.use(httpMetrics)

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      await Promise.all([pool.query('SELECT 1'), redis.ping()])
      res.json({ status: 'ready' })
    }),
  )
  app.get('/metrics', metricsHandler)

  // Mounted before the JSON parser: a signature covers the raw bytes.
  app.use('/webhooks', webhooksRouter)

  app.use(express.json({ limit: '2mb' }))
  app.use(cookieParser())
  app.use(asyncHandler(attachUser))

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1', prsRouter)
  app.use('/api/v1', escalationsRouter)
  app.use('/api/v1', auditRouter)
  app.use('/api/v1', evaluationsRouter)
  app.use('/api/v1', reposRouter)
  app.use('/api/v1', fixturesRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

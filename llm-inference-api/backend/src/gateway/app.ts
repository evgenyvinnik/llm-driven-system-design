/**
 * Gateway: the public inference API (API keys), the developer console API and
 * the admin API (sessions). Stateless apart from Valkey and PostgreSQL, so
 * several instances run side by side (dev:server1 on 3001); any instance can
 * serve any request id.
 * @module gateway/app
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { pinoHttp } from 'pino-http'
import { attachUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, ApiError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { adminRouter } from './routes/admin.js'
import { authRouter } from './routes/auth.js'
import { consoleRouter } from './routes/console.js'
import { publicRouter } from './routes/public.js'

const QUIET = ['/health', '/ready', '/metrics', '/api/v1/admin/overview', '/api/v1/admin/routing']

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
  app.use(express.json({ limit: '2mb' }))
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

  app.use('/v1', publicRouter)
  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/console', consoleRouter)
  app.use('/api/v1/admin', adminRouter)

  app.use((_req, _res, next) => next(new ApiError(404, 'not_found_error', 'Route not found')))
  app.use(errorHandler)
  return app
}

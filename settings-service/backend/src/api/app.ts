/**
 * The settings API. Stateless apart from Valkey sessions, so `npm run dev`
 * runs two instances (api-a, api-b) and either can serve any request.
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
import { adminRouter } from './routes/admin.js'
import { authRouter } from './routes/auth.js'
import { devRouter } from './routes/dev.js'
import { eventsRouter } from './routes/events.js'
import { settingsRouter } from './routes/settings.js'

const QUIET = ['/health', '/ready', '/metrics', '/api/v1/events']

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
  app.use((_req, res, next) => {
    res.set('X-Instance-Id', config.instanceId)
    next()
  })
  // JSON merge patch (RFC 7396) is the PATCH media type; plain JSON is accepted too.
  app.use(express.json({ limit: '64kb', type: ['application/json', 'application/merge-patch+json'] }))
  app.use(cookieParser())
  app.use(asyncHandler(attachUser))

  app.get('/health', (_req, res) => res.json({ status: 'ok', instanceId: config.instanceId }))
  app.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      await Promise.all([pool.query('SELECT 1'), redis.ping()])
      res.json({ status: 'ready', instanceId: config.instanceId })
    }),
  )
  app.get('/metrics', metricsHandler)

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/events', eventsRouter)
  app.use('/api/v1/admin', adminRouter)
  if (config.chaosEnabled) app.use('/api/v1/dev', devRouter)
  app.use('/api/v1', settingsRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

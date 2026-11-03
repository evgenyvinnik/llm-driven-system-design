/**
 * API service: REST endpoints plus two SSE streams (per generation, and per
 * user for device sync). Stateless; any number of instances can run behind a
 * load balancer (dev:server1..3).
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { pinoHttp } from 'pino-http'
import { attachUser, requireAuth } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { MODELS } from '../shared/catalog.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { adminRouter } from './routes/admin.js'
import { authRouter } from './routes/auth.js'
import { conversationsRouter } from './routes/conversations.js'
import { generationsRouter } from './routes/generations.js'
import { streamUserEvents } from './services/user-event-hub.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: {
        ignore: (req) =>
          req.url === '/health' || req.url === '/metrics' || req.url?.endsWith('/events') === true,
      },
    }),
  )
  app.use(httpMetrics)
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
  app.get('/api/v1/models', requireAuth, (_req, res) => {
    res.json({
      models: MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        contextTokens: m.contextTokens,
      })),
    })
  })
  app.use('/api/v1/conversations', conversationsRouter)
  app.use('/api/v1/generations', generationsRouter)
  /** Device sync stream: this user's changes from any device, as hints to re-read. */
  app.get('/api/v1/events', requireAuth, asyncHandler(streamUserEvents))
  app.use('/api/v1/admin', adminRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

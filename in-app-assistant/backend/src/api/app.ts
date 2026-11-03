/**
 * API service: the host app's REST endpoints, the assistant endpoints and
 * their SSE event streams. It also runs the agent loop for turns it starts
 * or resumes; turn state lives in PostgreSQL, so any instance can resume any
 * turn (dev:server1/dev:server2 run more instances).
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
import { assistantRouter } from './routes/assistant.js'
import { authRouter } from './routes/auth.js'
import { calendarRouter } from './routes/calendar.js'
import { docsRouter } from './routes/docs.js'
import { mailRouter } from './routes/mail.js'
import { quickRouter } from './routes/quick.js'
import { settingsRouter } from './routes/settings.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    pinoHttp({
      logger,
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' || req.url?.includes('/events') === true },
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
  app.use('/api/v1/mail', mailRouter)
  app.use('/api/v1/docs', docsRouter)
  app.use('/api/v1/calendar', calendarRouter)
  app.use('/api/v1/settings', settingsRouter)
  app.use('/api/v1/assistant/quick', quickRouter)
  app.use('/api/v1/assistant', assistantRouter)
  app.use('/api/v1/admin', adminRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

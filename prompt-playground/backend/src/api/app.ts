/**
 * API service: REST endpoints plus the SSE run event stream. Stateless; any
 * number of instances can run behind a load balancer (dev:server1..3).
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
import { modelsRouter } from './routes/models.js'
import { presetsRouter } from './routes/presets.js'
import { promptsRouter } from './routes/prompts.js'
import { runsRouter } from './routes/runs.js'
import { sharesRouter } from './routes/shares.js'

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
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' || req.url?.endsWith('/events') === true },
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
  app.use('/api/v1/models', modelsRouter)
  app.use('/api/v1/prompts', promptsRouter)
  app.use('/api/v1/presets', presetsRouter)
  app.use('/api/v1/admin', adminRouter)
  app.use('/api/v1', runsRouter)
  app.use('/api/v1', sharesRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

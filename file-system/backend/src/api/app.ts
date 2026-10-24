/**
 * The API: a thin HTTP layer over an FsBackend. Stateless with the PostgreSQL
 * backend, so any number of instances can run behind a load balancer
 * (dev:server1..3).
 */
import express from 'express'
import { pinoHttp } from 'pino-http'
import { seedDemo } from '../db/seed-data.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import type { FsBackend } from '../store/backend.js'
import { fsRouter } from './routes/fs.js'
import { usersRouter } from './routes/users.js'

export function createApp(backend: FsBackend, ready: () => Promise<unknown> = async () => {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
    }),
  )
  app.use(httpMetrics)
  app.use(express.json({ limit: '16kb' }))

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      await ready()
      res.json({ status: 'ready', store: backend.kind })
    }),
  )
  app.get('/metrics', metricsHandler)

  app.get('/api/v1/info', (_req, res) => res.json({ store: backend.kind }))
  app.use('/api/v1/fs', fsRouter(backend))
  app.use('/api/v1/users', usersRouter(backend))
  app.post(
    '/api/v1/admin/reset',
    asyncHandler(async (_req, res) => {
      await seedDemo(backend)
      res.json({ status: 'reset' })
    }),
  )

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

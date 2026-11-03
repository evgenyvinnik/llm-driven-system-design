/**
 * API service: auth, dashboard queries, freshness, pipeline health and export
 * jobs. Stateless; any number of instances can run behind a load balancer
 * (dev:server1..3).
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { pinoHttp } from 'pino-http'
import { attachUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { clickhouse } from '../shared/clickhouse.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { authRouter } from './routes/auth.js'
import { exportsRouter } from './routes/exports.js'
import { metaRouter } from './routes/meta.js'
import { queryRouter } from './routes/query.js'

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
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' || req.url?.startsWith('/api/v1/freshness') === true },
    }),
  )
  app.use(httpMetrics)
  app.use(express.json({ limit: '64kb' }))
  app.use(cookieParser())
  app.use(asyncHandler(attachUser))

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const [, , ch] = await Promise.all([pool.query('SELECT 1'), redis.ping(), clickhouse.ping()])
      if (!ch.success) throw new HttpError(503, 'CLICKHOUSE_DOWN', 'ClickHouse is not reachable')
      res.json({ status: 'ready' })
    }),
  )
  app.get('/metrics', metricsHandler)

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/query', queryRouter)
  app.use('/api/v1/exports', exportsRouter)
  app.use('/api/v1', metaRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

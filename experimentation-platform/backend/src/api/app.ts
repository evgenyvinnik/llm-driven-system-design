/**
 * The API. Stateless apart from Valkey (sessions, snapshot cache, pub/sub), so
 * `npm run dev` runs two instances and either can serve any request: a kill
 * switch written through api-a reaches SDK streams held open on api-b.
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { pinoHttp } from 'pino-http'
import { attachUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { clickhouse } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { authRouter } from './routes/auth.js'
import { consoleRouter } from './routes/console.js'
import { sdkRouter } from './routes/sdk.js'
import { shopRouter } from './routes/shop.js'

const QUIET = ['/health', '/ready', '/metrics', '/sdk/v1/stream', '/sdk/v1/clients/report', '/sdk/v1/snapshot', '/api/v1/clients', '/api/v1/system']

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.set('etag', false) // ETags here are snapshot versions, set explicitly.
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
  app.use(express.json({ limit: '512kb' }))
  app.use(cookieParser())

  app.get('/health', (_req, res) => res.json({ status: 'ok', instanceId: config.instanceId }))
  app.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      await Promise.all([pool.query('SELECT 1'), redis.ping(), clickhouse.ping()])
      res.json({ status: 'ready', instanceId: config.instanceId })
    }),
  )
  app.get('/metrics', metricsHandler)

  app.use('/sdk/v1', sdkRouter)
  app.use('/api/v1/shop', shopRouter)
  app.use(asyncHandler(attachUser))
  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1', consoleRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

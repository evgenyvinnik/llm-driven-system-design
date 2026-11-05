/**
 * API service: session auth, posture, findings, accounts, campaigns (with SSE
 * progress), exceptions, controls/policy, audit and notifications. Stateless
 * apart from Valkey sessions, so dev:server1/dev:server2 can run beside it.
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
import { accountsRouter } from './routes/accounts.js'
import { authRouter } from './routes/auth.js'
import { campaignsRouter } from './routes/campaigns.js'
import { exceptionsRouter } from './routes/exceptions.js'
import { findingsRouter } from './routes/findings.js'
import { adminRouter, auditRouter, controlsRouter, notificationsRouter } from './routes/governance.js'
import { postureRouter } from './routes/posture.js'

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
  app.use('/api/v1/posture', postureRouter)
  app.use('/api/v1/findings', findingsRouter)
  app.use('/api/v1/accounts', accountsRouter)
  app.use('/api/v1/campaigns', campaignsRouter)
  app.use('/api/v1/exceptions', exceptionsRouter)
  app.use('/api/v1/controls', controlsRouter)
  app.use('/api/v1/audit', auditRouter)
  app.use('/api/v1/notifications', notificationsRouter)
  app.use('/api/v1/admin', adminRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

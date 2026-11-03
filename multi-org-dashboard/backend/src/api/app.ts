/**
 * API service: REST endpoints plus the per-tab event stream. Stateless apart
 * from open streams; any number of instances can run behind a load balancer
 * (dev:server1..3).
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
import { agentsRouter } from './routes/agents.js'
import { authRouter } from './routes/auth.js'
import { conversationsRouter } from './routes/conversations.js'
import { eventsRouter } from './routes/events.js'
import { exportsRouter } from './routes/exports.js'
import { orgRouter } from './routes/org.js'
import { promptsRouter } from './routes/prompts.js'
import { publicRouter } from './routes/public.js'

/** Every org-scoped router is mounted here, and nowhere else. */
export const ORG_BASE = '/api/v1/orgs/:orgId'

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
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' || req.url === '/api/v1/events' },
    }),
  )
  app.use(httpMetrics)
  app.use(express.json({ limit: '128kb' }))
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
  app.use('/api/v1', eventsRouter)
  app.use('/api/v1', publicRouter)
  for (const routes of [orgRouter, agentsRouter, conversationsRouter, promptsRouter, adminRouter, exportsRouter]) {
    app.use(ORG_BASE, routes.router)
  }

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

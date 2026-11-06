/**
 * The quote API's Express app, built from injected services so tests can
 * construct it without a database or Valkey.
 * @module api/app
 */
import express from 'express'
import cookieParser from 'cookie-parser'
import { pinoHttp } from 'pino-http'
import type { Redis } from 'ioredis'
import { logger } from '../shared/logger.js'
import { errorHandler } from '../shared/errors.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { attachPrincipal } from '../shared/auth.js'
import { config } from '../shared/config.js'
import { authRouter } from './routes/auth.js'
import { quotesRouter } from './routes/quotes.js'
import { opsRouter } from './routes/ops.js'
import { eventsRouter } from './routes/events.js'
import { streamsRouter } from './routes/streams.js'
import { analyticsRouter, referenceRouter } from './routes/analytics.js'
import type { QuoteService } from './services/quotes.js'
import type { OpsStats } from './services/ops-stats.js'

export interface AppServices {
  redis: Redis
  quotes: QuoteService
  stats: OpsStats
}

export function createApp(services: AppServices): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))
  app.use(cookieParser())
  app.use(httpMetrics)
  if (process.env.LOG_LEVEL !== 'silent') {
    app.use(
      pinoHttp({
        logger,
        // Never log headers: they carry session cookies and API keys.
        serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }), res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }) },
        autoLogging: { ignore: (req: express.Request) => req.method === 'GET' || req.url === '/api/v1/quotes' },
      }),
    )
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'quote-api', instance: config.instanceId })
  })
  app.get('/metrics', metricsHandler)

  app.use('/api/v1', attachPrincipal)
  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/reference', referenceRouter())
  app.use('/api/v1/quotes', quotesRouter(services.quotes))
  app.use('/api/v1/ops', opsRouter(services.redis, services.stats))
  app.use('/api/v1/events', eventsRouter(services.redis))
  app.use('/api/v1/streams', streamsRouter(services.redis))
  app.use('/api/v1/analytics', analyticsRouter())

  app.use(errorHandler)
  return app
}

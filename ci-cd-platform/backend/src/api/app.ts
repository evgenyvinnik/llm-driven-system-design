/**
 * API service: auth, webhook intake, repositories, runs, jobs, logs, artifacts, runners,
 * ops, the fixture panel and the runner API. Stateless apart from PostgreSQL and Valkey,
 * so `dev:server1` runs a second instance: a runner can upload to one and a viewer can read
 * from the other.
 * @module api/app
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { attachUser, requireAuth } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { artifactsRouter } from './routes/artifacts.js'
import { authRouter } from './routes/auth.js'
import { fixturesRouter } from './routes/fixtures.js'
import { jobsRouter } from './routes/jobs.js'
import { opsRouter } from './routes/ops.js'
import { reposRouter } from './routes/repos.js'
import { runnerRouter } from './routes/runner-api.js'
import { runnersRouter } from './routes/runners.js'
import { runsRouter } from './routes/runs.js'
import { webhooksRouter } from './routes/webhooks.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(httpMetrics)

  // These two read their own bodies: a webhook has to be verified against its raw bytes, and runners upload binaries.
  app.use('/api/v1/webhooks', webhooksRouter)
  app.use('/api/v1/runner', runnerRouter)

  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())
  app.use(attachUser)
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Served-By', config.instanceId)
    next()
  })

  app.get('/health', (_req, res) => res.json({ status: 'ok', instance: config.instanceId }))
  app.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      await Promise.all([pool.query('SELECT 1'), redis.ping()])
      res.json({ status: 'ready' })
    }),
  )
  app.get('/metrics', metricsHandler)

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/repos', requireAuth, reposRouter)
  app.use('/api/v1/runs', requireAuth, runsRouter)
  app.use('/api/v1/jobs', requireAuth, jobsRouter)
  app.use('/api/v1/artifacts', requireAuth, artifactsRouter)
  app.use('/api/v1/runners', requireAuth, runnersRouter)
  app.use('/api/v1/ops', requireAuth, opsRouter)
  app.use('/api/v1/fixtures', requireAuth, fixturesRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

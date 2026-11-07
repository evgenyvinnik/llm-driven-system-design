/**
 * API service: auth, the document library (upload, versions, sharing,
 * delete), groups, answer runs with SSE, and the operator overview.
 * Stateless apart from Valkey (sessions, run streams), so `dev:server1` runs
 * a second instance; a run started on one instance can be streamed from the
 * other.
 * @module api/app
 */
import cookieParser from 'cookie-parser'
import express from 'express'
import { attachUser } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { asyncHandler, errorHandler, HttpError } from '../shared/errors.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { answersRouter } from './routes/answers.js'
import { authRouter } from './routes/auth.js'
import { documentsRouter } from './routes/documents.js'
import { groupsRouter } from './routes/groups.js'
import { opsRouter } from './routes/ops.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(httpMetrics)
  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())
  app.use(attachUser)
  // Document text, answers and citations must never be served from a browser or proxy cache after access changes.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

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
  app.use('/api/v1/documents', documentsRouter)
  app.use('/api/v1/groups', groupsRouter)
  app.use('/api/v1/answers', answersRouter)
  app.use('/api/v1/ops', opsRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')))
  app.use(errorHandler)
  return app
}

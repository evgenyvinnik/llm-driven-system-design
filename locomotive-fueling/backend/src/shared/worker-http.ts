/**
 * Tiny HTTP server for background workers: /health, /ready and /metrics.
 * @module shared/worker-http
 */
import express from 'express'
import type { Server } from 'node:http'
import { metricsHandler } from './metrics.js'
import { logger } from './logger.js'

export function startWorkerHttp(port: number, name: string, ready: () => Promise<void>, extra?: (app: express.Express) => void): Server {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: name }))
  app.get('/ready', (_req, res) => {
    ready()
      .then(() => res.json({ status: 'ready' }))
      .catch((err: Error) => res.status(503).json({ status: 'not_ready', error: err.message }))
  })
  app.get('/metrics', (req, res) => void metricsHandler(req, res))
  extra?.(app)
  return app.listen(port, () => logger.info({ port }, `${name} http listening`))
}

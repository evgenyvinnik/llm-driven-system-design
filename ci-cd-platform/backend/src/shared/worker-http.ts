/**
 * Tiny HTTP server for background processes: /health, /ready and /metrics.
 * A second copy started on the same port logs a warning and keeps working
 * without its metrics endpoint instead of crashing (EADDRINUSE).
 * @module shared/worker-http
 */
import express from 'express'
import type { Server } from 'node:http'
import { metricsHandler } from './metrics.js'
import { logger } from './logger.js'

export function startWorkerHttp(port: number, name: string, ready: () => Promise<void>): Server {
  const app = express()
  app.disable('x-powered-by')
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: name }))
  app.get('/ready', (_req, res) => {
    ready()
      .then(() => res.json({ status: 'ready' }))
      .catch((err: Error) => res.status(503).json({ status: 'not_ready', error: err.message }))
  })
  app.get('/metrics', (req, res) => void metricsHandler(req, res))
  const server = app.listen(port, () => logger.info({ port }, `${name} http listening`))
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') logger.warn({ port }, `${name}: metrics port in use; continuing without /metrics`)
    else logger.error({ err }, `${name}: http server error`)
  })
  return server
}

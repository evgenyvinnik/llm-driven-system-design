/**
 * Tiny health and metrics server for headless processes (worker, poster).
 * It must survive EADDRINUSE: losing a metrics port should never stop a worker.
 * @module shared/worker-http
 */
import { createServer, type Server } from 'node:http'
import { logger } from './logger.js'
import { registry } from './metrics.js'

export function startOpsServer(port: number, name: string): Server {
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      void registry.metrics().then((body) => {
        res.setHeader('Content-Type', registry.contentType)
        res.end(body)
      })
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', service: name }))
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.warn({ port, code: err.code }, 'ops port unavailable; continuing without it')
  })
  server.listen(port)
  return server
}

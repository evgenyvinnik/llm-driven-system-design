/**
 * Mock embedding service entry point (default port 3100, EMBEDDER_PORT).
 * @module embedder/index
 */
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { createEmbedderApp } from './app.js'

const server = createEmbedderApp().listen(config.embedderPort, () => logger.info({ port: config.embedderPort }, 'mock embedder listening'))

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

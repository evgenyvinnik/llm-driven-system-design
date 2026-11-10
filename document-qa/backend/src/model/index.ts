/**
 * Mock model service entry point (default port 3101, MODEL_PORT).
 * @module model/index
 */
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { createModelApp } from './app.js'

const server = createModelApp().listen(config.modelPort, () => logger.info({ port: config.modelPort }, 'mock model listening'))

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME so lines
 * from the api, publisher, scheduler, workers and receiver can be told apart.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'webhook-platform' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

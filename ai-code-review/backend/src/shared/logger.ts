/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'ai-code-review' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

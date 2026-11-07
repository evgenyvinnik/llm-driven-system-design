/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME so lines
 * from the api, workers, mock model and mock judge can be told apart.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'llm-eval-dashboard' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

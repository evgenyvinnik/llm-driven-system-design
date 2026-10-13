/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME so log lines
 * from the API, executor, and mock model can be told apart.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'prompt-playground' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

export function childLogger(service: string) {
  return logger.child({ service })
}

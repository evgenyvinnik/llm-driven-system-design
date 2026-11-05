/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME so lines
 * from the cloud simulator, API, scanner and executor can be told apart.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'storage-remediation' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

export function childLogger(component: string) {
  return logger.child({ component })
}

/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME so log lines from the API, the relay,
 * the consumers and the replanner can be told apart.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'railcar-trip-plans' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

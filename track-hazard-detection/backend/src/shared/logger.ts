/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME so log lines
 * from the API, relay, correlator, alerting, projector and notifier can be told apart.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'track-hazard' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

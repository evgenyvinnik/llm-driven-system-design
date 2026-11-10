/**
 * Structured JSON logging with pino. Every line carries the instance id, so a
 * write on api-a and the SSE delivery on api-b can be followed across processes.
 * @module shared/logger
 */
import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'settings-service', instance: config.instanceId },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

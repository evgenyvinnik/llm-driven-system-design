/**
 * Structured JSON logging with pino. Every line carries the instance id, so a
 * kill switch on api-a and its push on api-b can be followed across processes.
 * @module shared/logger
 */
import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'experimentation-platform', instance: process.env.WORKER_ID && !process.env.PORT ? config.worker.id : config.instanceId },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

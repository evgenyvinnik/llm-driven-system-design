/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME so lines
 * from the api, processor, planner, vendor and simulator can be told apart.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'locomotive-fueling' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

/**
 * Structured JSON logging with pino. Each process sets SERVICE_NAME so lines
 * from the API instances, workers, mock embedder and mock model can be told apart.
 * @module shared/logger
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'document-qa' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
})

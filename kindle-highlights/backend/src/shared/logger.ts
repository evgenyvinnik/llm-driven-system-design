/**
 * Structured logger using Pino
 * @module shared/logger
 */
import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

/** Logger instance */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      }
    : undefined,
})

/**
 * Create a child logger with a service name
 * @param service - Service name
 * @returns Child logger
 */
export function createLogger(service: string): pino.Logger {
  return logger.child({ service })
}

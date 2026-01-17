/**
 * Logger module providing structured logging for the job scheduler.
 * Uses Winston for flexible, level-based logging with JSON formatting.
 * In production, logs are also written to files for debugging and auditing.
 * @module utils/logger
 */

import winston from 'winston';

/** Log level from environment, defaults to 'info' */
const logLevel = process.env.LOG_LEVEL || 'info';

/**
 * Winston logger instance configured for the job scheduler.
 * Includes timestamp, error stack traces, and service metadata.
 * Console output uses colorized simple format; JSON for structured parsing.
 */
export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: process.env.SERVICE_NAME || 'job-scheduler',
    instance: process.env.WORKER_ID || process.env.SCHEDULER_INSTANCE_ID || 'unknown'
  },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

/**
 * Production logging enhancement.
 * Adds file transports for persistent log storage when NODE_ENV is 'production'.
 * Separate files for errors and combined logs enable easier debugging.
 */
if (process.env.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    })
  );
  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
    })
  );
}

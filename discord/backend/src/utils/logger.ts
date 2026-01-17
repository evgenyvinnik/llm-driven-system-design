/**
 * Logging Module
 *
 * Provides a configured Winston logger for the Baby Discord application.
 * Supports multiple instances via INSTANCE_ID environment variable,
 * making logs distinguishable when running multiple server instances.
 *
 * Log levels can be controlled via LOG_LEVEL environment variable.
 */

import winston from 'winston';

const { combine, timestamp, printf, colorize, align } = winston.format;

/** Log level from environment, defaults to 'info' */
const logLevel = process.env.LOG_LEVEL || 'info';

/** Instance ID for distinguishing logs from multiple server instances */
const instanceId = process.env.INSTANCE_ID || '0';

/**
 * Custom log format that includes instance ID and optional metadata.
 * Format: "TIMESTAMP [instance-N] LEVEL: message {metadata}"
 */
const customFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [instance-${instanceId}] ${level}: ${message}${metaStr}`;
});

/**
 * Configured Winston logger instance.
 *
 * Features:
 * - Timestamps with millisecond precision
 * - Instance ID prefix for multi-instance deployments
 * - Colorized console output
 * - JSON metadata support
 *
 * @example
 * logger.info('User connected', { userId: 123, transport: 'tcp' });
 * logger.error('Database error', { error: err.message });
 * logger.debug('Processing message', { roomName: 'general' });
 */
export const logger = winston.createLogger({
  level: logLevel,
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), customFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize({ all: true }), align(), customFormat),
    }),
  ],
});

export default logger;

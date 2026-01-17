import winston from 'winston';

/**
 * Application-wide logger configured with Winston.
 * Provides structured JSON logging with timestamps for production debugging
 * and colorized console output for development. Used throughout the API
 * and scraper services to track operations, errors, and performance.
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'price-tracker' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

export default logger;

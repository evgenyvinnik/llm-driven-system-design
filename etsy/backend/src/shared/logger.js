import pino from 'pino';
import pinoHttp from 'pino-http';
import config from '../config.js';

// Structured JSON logger with context support
const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  base: {
    service: 'etsy-backend',
    environment: config.nodeEnv,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty print in development
  transport:
    config.nodeEnv !== 'production'
      ? {
          target: 'pino/file',
          options: { destination: 1 }, // stdout
        }
      : undefined,
});

// HTTP request logger middleware
export const httpLogger = pinoHttp({
  logger,
  // Don't log health checks
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/metrics',
  },
  // Custom serializers
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      query: req.query,
      userId: req.raw?.session?.userId || null,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
  // Add custom fields
  customProps: (req) => ({
    userId: req.session?.userId || null,
    sessionId: req.sessionID || null,
  }),
  // Custom log level based on status code
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Custom success message
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  // Custom error message
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} failed: ${err.message}`;
  },
});

// Create child loggers for specific contexts
export function createLogger(context) {
  return logger.child({ context });
}

// Specific module loggers
export const dbLogger = createLogger('database');
export const cacheLogger = createLogger('cache');
export const searchLogger = createLogger('elasticsearch');
export const orderLogger = createLogger('orders');
export const paymentLogger = createLogger('payment');

export default logger;

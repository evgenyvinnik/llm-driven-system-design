import pino, { Logger } from 'pino';
import pinoHttpModule from 'pino-http';
import type { HttpLogger, Options as PinoHttpOptions } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'http';
import config from '../config.js';

const pinoHttp = (pinoHttpModule as unknown as { default?: typeof pinoHttpModule }).default || pinoHttpModule;

// Structured JSON logger with context support
const logger: Logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  formatters: {
    level: (label: string) => {
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
export const httpLogger: HttpLogger = pinoHttp({
  logger,
  // Don't log health checks
  autoLogging: {
    ignore: (req: IncomingMessage) => req.url === '/api/health' || req.url === '/metrics',
  },
  // Custom serializers
  serializers: {
    req: (req: IncomingMessage & { method?: string; url?: string; query?: object; raw?: { session?: { userId?: number } } }) => ({
      method: req.method,
      url: req.url,
      query: req.query,
      userId: req.raw?.session?.userId || null,
    }),
    res: (res: ServerResponse & { statusCode?: number }) => ({
      statusCode: res.statusCode,
    }),
  },
  // Add custom fields
  customProps: (req: IncomingMessage & { session?: { userId?: number }; sessionID?: string }) => ({
    userId: req.session?.userId || null,
    sessionId: req.sessionID || null,
  }),
  // Custom log level based on status code
  customLogLevel: (_req: IncomingMessage, res: ServerResponse & { statusCode: number }, err: Error | undefined) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Custom success message
  customSuccessMessage: (req: IncomingMessage & { method?: string; url?: string }, res: ServerResponse & { statusCode?: number }) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  // Custom error message
  customErrorMessage: (req: IncomingMessage & { method?: string; url?: string }, _res: ServerResponse, err: Error) => {
    return `${req.method} ${req.url} failed: ${err.message}`;
  },
} as PinoHttpOptions);

// Create child loggers for specific contexts
export function createLogger(context: string): Logger {
  return logger.child({ context });
}

// Specific module loggers
export const dbLogger: Logger = createLogger('database');
export const cacheLogger: Logger = createLogger('cache');
export const searchLogger: Logger = createLogger('elasticsearch');
export const orderLogger: Logger = createLogger('orders');
export const paymentLogger: Logger = createLogger('payment');

export default logger;

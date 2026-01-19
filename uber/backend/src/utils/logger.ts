import pino, { Logger } from 'pino';
import type { Request, Response, NextFunction } from 'express';
import config from '../config/index.js';

const isDev = config.nodeEnv === 'development';

// Configure pino logger with JSON structured logging
const logger: Logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  formatters: {
    level: (label: string) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      host: bindings.hostname,
      service: 'uber-backend',
      version: '1.0.0',
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty print in development
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

// Create child loggers for specific components
export const createLogger = (component: string): Logger => {
  return logger.child({ component });
};

// Extended request interface for logging
interface LoggableRequest extends Request {
  requestId?: string;
  log?: Logger;
}

// Request logging middleware
export const requestLogger = (req: LoggableRequest, res: Response, next: NextFunction): void => {
  const startTime = Date.now();
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();

  // Attach request ID to request object
  req.requestId = requestId;

  // Create request-scoped logger
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
  });

  // Log request start
  req.log.info({ query: req.query, body: req.body }, 'Request started');

  // Capture response
  const originalSend = res.send.bind(res);
  res.send = function (body: unknown): Response {
    const duration = Date.now() - startTime;

    req.log?.info(
      {
        statusCode: res.statusCode,
        duration,
        responseSize: body ? String(body).length : 0,
      },
      'Request completed'
    );

    return originalSend(body);
  };

  next();
};

// Error context interface
interface ErrorContext {
  [key: string]: unknown;
}

// Error with optional code
interface ErrorWithCode extends Error {
  code?: string;
}

// Error logging helper
export const logError = (component: string, error: ErrorWithCode, context: ErrorContext = {}): void => {
  const componentLogger = createLogger(component);
  componentLogger.error(
    {
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code,
        ...context,
      },
    },
    'Error occurred'
  );
};

export default logger;

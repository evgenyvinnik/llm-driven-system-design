import pino from 'pino';
import config from '../config/index.js';

const isDev = config.nodeEnv === 'development';

// Configure pino logger with JSON structured logging
const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  formatters: {
    level: (label) => ({ level: label }),
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
export const createLogger = (component) => {
  return logger.child({ component });
};

// Request logging middleware
export const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

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
  const originalSend = res.send;
  res.send = function (body) {
    const duration = Date.now() - startTime;

    req.log.info(
      {
        statusCode: res.statusCode,
        duration,
        responseSize: body ? body.length : 0,
      },
      'Request completed'
    );

    return originalSend.call(this, body);
  };

  next();
};

// Error logging helper
export const logError = (component, error, context = {}) => {
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

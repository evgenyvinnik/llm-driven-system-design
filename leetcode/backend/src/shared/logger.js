const pino = require('pino');

// Configure pino logger with structured JSON output
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Use pretty printing in development for readability
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  } : undefined,
  // In production, output structured JSON
  formatters: {
    level: (label) => ({ level: label }),
    bindings: () => ({}) // Remove pid and hostname in production
  },
  base: {
    service: 'leetcode-backend',
    env: process.env.NODE_ENV || 'development'
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`
});

// Create child loggers for specific modules
const createModuleLogger = (module) => {
  return logger.child({ module });
};

// Express middleware for request logging
const requestLogger = (req, res, next) => {
  const startTime = Date.now();

  // Log on response finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      userId: req.session?.userId || null,
      userAgent: req.get('user-agent'),
      ip: req.ip
    };

    // Log at different levels based on status code
    if (res.statusCode >= 500) {
      logger.error(logData, 'Request failed with server error');
    } else if (res.statusCode >= 400) {
      logger.warn(logData, 'Request failed with client error');
    } else if (duration > 1000) {
      logger.warn(logData, 'Slow request detected');
    } else {
      logger.info(logData, 'Request completed');
    }
  });

  next();
};

module.exports = {
  logger,
  createModuleLogger,
  requestLogger
};

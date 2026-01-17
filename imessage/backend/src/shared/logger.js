import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const logger = pino({
  level,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'imessage-backend',
    pid: process.pid,
    env: process.env.NODE_ENV || 'development',
  },
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname,service,env',
      },
    },
  }),
});

// Create child loggers for different contexts
export function createLogger(context) {
  return logger.child({ context });
}

// Request logging middleware
export function requestLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  req.log = logger.child({
    requestId,
    method: req.method,
    url: req.url,
  });

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    req.log[level]({
      statusCode: res.statusCode,
      durationMs: duration,
      contentLength: res.get('content-length'),
    }, 'request completed');
  });

  next();
}

export default logger;

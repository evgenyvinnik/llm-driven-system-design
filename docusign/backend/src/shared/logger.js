import pino from 'pino';

// Structured JSON logging with pino
// In production, these logs can be shipped to ELK/Datadog/CloudWatch
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      host: bindings.hostname,
      service: 'docusign-backend',
    }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  // In development, use pino-pretty for readable output
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
});

// Create child logger with request context
export function createRequestLogger(req) {
  return logger.child({
    requestId: req.headers['x-request-id'] || crypto.randomUUID(),
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection?.remoteAddress,
  });
}

// Audit-specific logger for compliance events
export const auditLogger = logger.child({
  type: 'audit',
  compliance: true,
});

// Performance logger for timing events
export const perfLogger = logger.child({
  type: 'performance',
});

export default logger;

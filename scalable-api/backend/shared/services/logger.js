import pino from 'pino';
import config from '../config/index.js';

/**
 * Structured JSON logger using pino
 *
 * WHY structured logging:
 * - Machine-parseable for log aggregation (ELK, Loki, CloudWatch)
 * - Consistent format across all services
 * - Enables filtering and alerting on specific fields
 * - Correlates requests via request IDs for distributed tracing
 */

const isProduction = config.env === 'production';

// Configure pino transport
const transport = isProduction
  ? undefined // JSON output in production
  : pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    });

// Create base logger
const logger = pino(
  {
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    base: {
      instanceId: config.instanceId,
      service: process.env.SERVICE_NAME || 'api-server',
      version: process.env.APP_VERSION || '1.0.0',
    },
    // Redact sensitive fields
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'password', 'apiKey', 'token'],
      censor: '[REDACTED]',
    },
    // Serializers for common objects
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        path: req.path,
        requestId: req.id,
        ip: req.ip || req.headers?.['x-forwarded-for']?.split(',')[0],
        userAgent: req.headers?.['user-agent'],
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
      err: pino.stdSerializers.err,
    },
    // Timestamp in ISO format for easier parsing
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport
);

/**
 * Create a child logger with request context
 */
export function createRequestLogger(req) {
  return logger.child({
    requestId: req.id,
    userId: req.user?.id,
    method: req.method,
    path: req.path,
  });
}

/**
 * Log levels available:
 * - fatal: System is unusable
 * - error: Error conditions requiring attention
 * - warn: Warning conditions that may need attention
 * - info: Normal operational messages
 * - debug: Debug-level messages for development
 * - trace: Very detailed tracing messages
 */

export default logger;

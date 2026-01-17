import pino from 'pino';
import pinoHttp from 'pino-http';

/**
 * Structured Logger using Pino
 *
 * WHY: Structured logging enables:
 * - Machine-parseable logs for aggregation (ELK, Datadog, etc.)
 * - Consistent log format across all services
 * - Correlation via trace_id/request_id for distributed tracing
 * - Log levels that can be adjusted at runtime
 * - High performance (pino is 5x faster than alternatives)
 */

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SERVICE_NAME = process.env.SERVICE_NAME || 'apple-maps-backend';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Base logger configuration
const loggerConfig = {
  level: LOG_LEVEL,
  base: {
    service: SERVICE_NAME,
    env: NODE_ENV,
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // In development, use pretty printing
  ...(NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
  // Redact sensitive fields
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token'],
    remove: true,
  },
};

// Create the base logger
const logger = pino(loggerConfig);

// HTTP request logger middleware
const httpLogger = pinoHttp({
  logger,
  // Generate request ID if not present
  genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
  // Custom serializers for cleaner logs
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      query: req.query,
      params: req.params,
      // Anonymize client info for privacy
      remoteAddress: req.remoteAddress?.replace(/\d+$/, 'xxx'),
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
  // Custom log message
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Add custom properties to each request log
  customProps: (req, res) => ({
    responseTime: res.responseTime,
  }),
  // Paths to skip logging (e.g., health checks for noise reduction)
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/metrics',
  },
});

/**
 * Create a child logger with additional context
 * Use for per-request or per-operation logging
 */
function createChildLogger(context) {
  return logger.child(context);
}

/**
 * Audit logger for compliance-critical events
 * These logs have longer retention and are immutable
 */
const auditLogger = logger.child({
  audit: true,
  retention: '1year',
});

function logAudit(event, actor, details) {
  auditLogger.info({
    event,
    actor: {
      id: actor.id,
      type: actor.type,
      ip: actor.ip?.replace(/\d+$/, 'xxx'), // Anonymize last octet
    },
    details,
    timestamp: new Date().toISOString(),
  });
}

export { logger, httpLogger, createChildLogger, logAudit };
export default logger;

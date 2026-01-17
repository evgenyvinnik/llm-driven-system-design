/**
 * Structured JSON Logging with Pino
 *
 * Provides consistent logging across all services with:
 * - JSON format for log aggregation
 * - Request correlation via trace IDs
 * - Log levels (info, warn, error, debug)
 * - Service/instance identification
 */
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'twitch-api',
    instance: process.env.INSTANCE_ID || `port-${process.env.PORT || 3001}`,
    pid: process.pid
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

/**
 * Create a child logger with additional context
 * @param {Object} bindings - Additional context to include in all log entries
 * @returns {pino.Logger}
 */
function createChildLogger(bindings) {
  return logger.child(bindings);
}

/**
 * Express middleware for request logging
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const traceId = req.headers['x-trace-id'] || generateTraceId();

  // Attach trace ID to request for downstream use
  req.traceId = traceId;

  // Set trace ID in response headers
  res.setHeader('x-trace-id', traceId);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
      user_id: req.userId || null,
      trace_id: traceId,
      ip: req.ip || req.connection.remoteAddress,
      user_agent: req.headers['user-agent']
    };

    if (res.statusCode >= 500) {
      logger.error(logData, 'request completed with server error');
    } else if (res.statusCode >= 400) {
      logger.warn(logData, 'request completed with client error');
    } else if (duration > 1000) {
      logger.warn(logData, 'slow request completed');
    } else {
      logger.info(logData, 'request completed');
    }
  });

  next();
}

/**
 * Generate a trace ID for request correlation
 */
function generateTraceId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Log a business event
 * @param {string} eventType - Type of event (e.g., 'stream.start', 'chat.message')
 * @param {Object} data - Event-specific data
 */
function logEvent(eventType, data = {}) {
  logger.info({
    event_type: eventType,
    ...data,
    timestamp: new Date().toISOString()
  }, `event: ${eventType}`);
}

/**
 * Log a stream-related event
 */
function logStreamEvent(eventType, channelId, metadata = {}) {
  logEvent(`stream.${eventType}`, {
    channel_id: channelId,
    ...metadata
  });
}

/**
 * Log a chat-related event
 */
function logChatEvent(eventType, channelId, metadata = {}) {
  logEvent(`chat.${eventType}`, {
    channel_id: channelId,
    ...metadata
  });
}

module.exports = {
  logger,
  createChildLogger,
  requestLogger,
  generateTraceId,
  logEvent,
  logStreamEvent,
  logChatEvent
};

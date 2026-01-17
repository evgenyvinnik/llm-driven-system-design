import pino from 'pino';

/**
 * Structured JSON logger using Pino.
 * Provides consistent, machine-parseable logs for monitoring and debugging.
 *
 * Log levels: trace, debug, info, warn, error, fatal
 *
 * All logs include:
 * - timestamp (ISO 8601)
 * - level (numeric and string)
 * - service name
 * - hostname
 *
 * Financial operations should use auditLogger for compliance.
 */
export const logger = pino({
  name: 'payment-system',
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'payment-system',
    env: process.env.NODE_ENV || 'development',
  },
});

/**
 * Creates a child logger with additional context.
 * Use for request-scoped logging with trace IDs.
 *
 * @param bindings - Additional fields to include in all logs
 * @returns Child logger instance
 */
export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

/**
 * Audit-level logger for financial operations.
 * Ensures all sensitive operations are logged for PCI compliance.
 *
 * IMPORTANT: Use this logger for:
 * - Payment creation, capture, void
 * - Refund processing
 * - Chargeback handling
 * - Merchant account changes
 *
 * All audit logs include:
 * - Timestamp
 * - Actor information (merchant, system)
 * - Entity type and ID
 * - Action performed
 * - Request IP and User-Agent
 */
export const auditLogger = logger.child({ audit: true });

/**
 * Logs a structured audit event for financial operations.
 * Required for PCI-DSS compliance and forensic analysis.
 *
 * @param event - Audit event type (e.g., 'payment.created', 'refund.processed')
 * @param data - Audit data including entity IDs, actor info, and changes
 */
export function logAuditEvent(
  event: string,
  data: {
    entityType: 'transaction' | 'refund' | 'chargeback' | 'merchant';
    entityId: string;
    actorType: 'api_key' | 'admin' | 'system';
    actorId: string;
    action: string;
    changes?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }
) {
  auditLogger.info(
    {
      event,
      entity_type: data.entityType,
      entity_id: data.entityId,
      actor_type: data.actorType,
      actor_id: data.actorId,
      action: data.action,
      changes: data.changes,
      metadata: data.metadata,
      ip_address: data.ipAddress,
      user_agent: data.userAgent,
    },
    `Audit: ${event}`
  );
}

export default logger;

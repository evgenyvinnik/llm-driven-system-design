/**
 * @fileoverview Structured JSON logging with pino.
 *
 * Provides a centralized logger with:
 * - JSON output for log aggregation (e.g., ELK, CloudWatch)
 * - Contextual fields (service, server_id, version)
 * - Log levels configurable via environment
 * - Specialized loggers for operations, connections, conflicts
 *
 * Usage:
 * ```typescript
 * import { logger, logOperation, logConnection, logConflict } from './shared/logger.js';
 * logger.info({ event: 'startup' }, 'Server started');
 * logOperation(documentId, clientId, operation, result);
 * ```
 */

import pino from 'pino';

/**
 * Server identifier for distinguishing logs from multiple instances.
 * Set via SERVER_ID environment variable (e.g., 'server1', 'server2').
 */
const SERVER_ID = process.env.SERVER_ID || `server-${process.env.PORT || '3001'}`;

/**
 * Main logger instance with base context fields.
 * All child loggers inherit these fields.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'collab-editor',
    server_id: SERVER_ID,
    version: process.env.APP_VERSION || '1.0.0',
  },
  // In development, use pino-pretty if available
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino/file',
      options: { destination: 1 }, // stdout
    },
  }),
});

/**
 * Log an OT operation application with detailed context.
 * Used for debugging sync issues and monitoring latency.
 *
 * @param documentId - The document being edited
 * @param clientId - The client that sent the operation
 * @param operation - The operation data
 * @param result - The result of applying the operation
 */
export function logOperation(
  documentId: string,
  clientId: string,
  operation: {
    ops: unknown[];
    baseLength: number;
    targetLength: number;
  },
  result: {
    version: number;
    transformCount?: number;
    latencyMs?: number;
  }
): void {
  const firstOp = operation.ops[0] as { insert?: string; delete?: number; retain?: number } | undefined;
  let operationType = 'unknown';
  if (firstOp) {
    if ('insert' in firstOp) operationType = 'insert';
    else if ('delete' in firstOp) operationType = 'delete';
    else if ('retain' in firstOp) operationType = 'retain';
  }

  logger.info({
    event: 'operation_applied',
    document_id: documentId,
    client_id: clientId,
    operation_type: operationType,
    operation_size: JSON.stringify(operation).length,
    base_length: operation.baseLength,
    target_length: operation.targetLength,
    result_version: result.version,
    transform_count: result.transformCount ?? 0,
    latency_ms: result.latencyMs ?? 0,
  });
}

/**
 * Log WebSocket connection events.
 * Tracks client joins and leaves for presence debugging.
 *
 * @param event - The connection event type
 * @param clientId - The client's session ID
 * @param documentId - The document being accessed
 * @param userId - The authenticated user ID
 */
export function logConnection(
  event: 'connect' | 'disconnect',
  clientId: string,
  documentId: string,
  userId: string
): void {
  logger.info({
    event: `ws_${event}`,
    client_id: clientId,
    document_id: documentId,
    user_id: userId,
  });
}

/**
 * Log OT conflict resolution details.
 * Critical for debugging sync issues when operations need transformation.
 *
 * @param documentId - The document where conflict occurred
 * @param clientId - The client whose operation was transformed
 * @param details - Conflict resolution details
 */
export function logConflict(
  documentId: string,
  clientId: string,
  details: {
    clientVersion: number;
    serverVersion: number;
    concurrentOpCount: number;
    transformedOp: unknown;
    originalOp: unknown;
  }
): void {
  logger.info({
    event: 'ot_conflict_resolved',
    document_id: documentId,
    client_id: clientId,
    client_version: details.clientVersion,
    server_version: details.serverVersion,
    concurrent_ops: details.concurrentOpCount,
    // Only log summary to avoid huge log entries
    transformed_ops_count: Array.isArray((details.transformedOp as { ops?: unknown[] })?.ops)
      ? (details.transformedOp as { ops: unknown[] }).ops.length
      : 0,
    original_ops_count: Array.isArray((details.originalOp as { ops?: unknown[] })?.ops)
      ? (details.originalOp as { ops: unknown[] }).ops.length
      : 0,
  });
}

/**
 * Log an error with full context.
 *
 * @param context - The context where the error occurred
 * @param error - The error object
 */
export function logError(context: string, error: Error): void {
  logger.error({
    event: 'error',
    context,
    error_type: error.constructor.name,
    error_message: error.message,
    stack: error.stack,
  });
}

/**
 * Log a circuit breaker state change.
 *
 * @param service - The service protected by the circuit breaker
 * @param state - The new circuit breaker state
 */
export function logCircuitBreaker(
  service: string,
  state: 'open' | 'half_open' | 'close'
): void {
  const level = state === 'open' ? 'warn' : 'info';
  logger[level]({
    event: `circuit_${state}`,
    service,
  });
}

/**
 * Log RabbitMQ message events.
 *
 * @param event - The event type
 * @param details - Event details
 */
export function logQueue(
  event: 'publish' | 'consume' | 'ack' | 'nack' | 'duplicate',
  details: {
    exchange?: string;
    routingKey?: string;
    messageId?: string;
    documentId?: string;
    queue?: string;
  }
): void {
  logger.debug({
    event: `queue_${event}`,
    ...details,
  });
}

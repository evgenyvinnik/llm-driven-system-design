import pino, { Logger, LoggerOptions } from 'pino';

// Create structured JSON logger with pino
const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label: string) => {
      return { level: label };
    }
  },
  base: {
    service: 'spotlight',
    version: '1.0.0',
    pid: process.pid
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  // In development, use pino-pretty if available
  transport: process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY === 'true'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined
};

const logger: Logger = pino(loggerOptions);

// Create child loggers for specific components
export const searchLogger: Logger = logger.child({ component: 'search' });
export const indexLogger: Logger = logger.child({ component: 'index' });
export const suggestionsLogger: Logger = logger.child({ component: 'suggestions' });
export const healthLogger: Logger = logger.child({ component: 'health' });

// Audit logger for security-relevant events
export const auditLogger: Logger = logger.child({ component: 'audit', audit: true });

export interface SearchLogParams {
  query: string;
  userId?: string | null;
  resultCount: number;
  latencyMs: number;
  sources: string[];
  requestId?: string;
}

/**
 * Log search operation with standardized fields
 */
export function logSearch({ query, userId, resultCount, latencyMs, sources, requestId }: SearchLogParams): void {
  searchLogger.info({
    query,
    userId,
    resultCount,
    latencyMs,
    sources,
    requestId
  }, 'Search completed');
}

export interface IndexLogParams {
  operation: string;
  documentType: string;
  documentId: string;
  latencyMs: number;
  success: boolean;
  error?: string;
  idempotencyKey?: string;
}

/**
 * Log index operation with standardized fields
 */
export function logIndexOperation({ operation, documentType, documentId, latencyMs, success, error, idempotencyKey }: IndexLogParams): void {
  const logData: Record<string, unknown> = {
    operation,
    documentType,
    documentId,
    latencyMs,
    success
  };

  if (idempotencyKey) {
    logData.idempotencyKey = idempotencyKey;
  }

  if (error) {
    logData.error = error;
    indexLogger.error(logData, 'Index operation failed');
  } else {
    indexLogger.info(logData, 'Index operation completed');
  }
}

export interface AuditEventParams {
  eventType: string;
  userId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

/**
 * Log audit event for security tracking
 */
export function logAuditEvent({ eventType, userId, ip, details }: AuditEventParams): void {
  auditLogger.info({
    eventType,
    userId,
    ip,
    details
  }, `Audit: ${eventType}`);
}

export interface CircuitBreakerStateParams {
  name: string;
  state: string;
  failures: number;
}

/**
 * Log circuit breaker state change
 */
export function logCircuitBreakerState({ name, state, failures }: CircuitBreakerStateParams): void {
  const logLevel = state === 'OPEN' ? 'warn' : 'info';
  logger[logLevel]({
    component: 'circuit_breaker',
    name,
    state,
    failures
  }, `Circuit breaker ${name} is ${state}`);
}

export default logger;

/**
 * Audit Logging Module for Payment Operations
 *
 * Provides immutable audit trail for all financial and security-critical operations.
 * Designed for compliance (PCI-DSS, SOX) and forensic analysis.
 *
 * WHY Audit Logging is Critical:
 * 1. PCI-DSS requires logging all access to cardholder data
 * 2. SOX compliance requires financial transaction audit trails
 * 3. Fraud investigation needs complete operation history
 * 4. Security incidents require forensic analysis capability
 * 5. Dispute resolution needs transaction evidence
 *
 * Audit Log Properties:
 * - Immutable: Once written, cannot be modified or deleted
 * - Complete: Captures who, what, when, where, and result
 * - Secure: Sensitive data is redacted (PAN, CVV)
 * - Queryable: Indexed by user, action, and timestamp
 *
 * Storage Strategy:
 * - Primary: PostgreSQL with append-only table
 * - Secondary: Structured log output for log aggregation
 * - Archive: Old logs moved to cold storage (not implemented in demo)
 */
import { query } from '../db/index.js';
import { createChildLogger } from './logger.js';
import { Request } from 'express';

const auditLogger = createChildLogger({ module: 'AuditLog' });

/**
 * Audit action categories for filtering and reporting.
 */
export enum AuditAction {
  // Authentication
  LOGIN_SUCCESS = 'auth.login.success',
  LOGIN_FAILURE = 'auth.login.failure',
  LOGOUT = 'auth.logout',
  SESSION_EXPIRED = 'auth.session.expired',

  // Card Operations
  CARD_PROVISIONED = 'card.provisioned',
  CARD_SUSPENDED = 'card.suspended',
  CARD_REACTIVATED = 'card.reactivated',
  CARD_REMOVED = 'card.removed',
  CARD_SET_DEFAULT = 'card.set_default',

  // Payment Operations
  PAYMENT_INITIATED = 'payment.initiated',
  PAYMENT_APPROVED = 'payment.approved',
  PAYMENT_DECLINED = 'payment.declined',
  PAYMENT_ERROR = 'payment.error',

  // Refund Operations
  REFUND_INITIATED = 'refund.initiated',
  REFUND_APPROVED = 'refund.approved',
  REFUND_DECLINED = 'refund.declined',

  // Device Operations
  DEVICE_REGISTERED = 'device.registered',
  DEVICE_REMOVED = 'device.removed',
  DEVICE_LOST = 'device.lost',

  // Biometric Operations
  BIOMETRIC_INITIATED = 'biometric.initiated',
  BIOMETRIC_SUCCESS = 'biometric.success',
  BIOMETRIC_FAILURE = 'biometric.failure',

  // Administrative
  ADMIN_ACCESS = 'admin.access',
  CONFIG_CHANGED = 'admin.config.changed',
}

/**
 * Audit log entry structure.
 */
export interface AuditLogEntry {
  /** Unique identifier for the audit entry */
  id?: string;
  /** Timestamp of the action */
  timestamp: Date;
  /** User who performed the action (null for system actions) */
  userId: string | null;
  /** User email for display purposes */
  userEmail?: string;
  /** The action that was performed */
  action: AuditAction;
  /** Resource type being acted upon */
  resourceType: string;
  /** Resource identifier (e.g., card_id, transaction_id) */
  resourceId: string | null;
  /** Result of the action */
  result: 'success' | 'failure' | 'error';
  /** IP address of the client */
  ipAddress: string | null;
  /** User agent string */
  userAgent: string | null;
  /** Session ID for correlation */
  sessionId: string | null;
  /** Request ID for correlation with logs */
  requestId: string | null;
  /** Additional context (redacted of sensitive data) */
  metadata: Record<string, unknown>;
  /** Error message if result is failure/error */
  errorMessage?: string;
}

/**
 * Redacts sensitive fields from metadata before logging.
 */
function redactSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...data };
  const sensitiveFields = [
    'pan',
    'cvv',
    'card_number',
    'token',
    'token_dpan',
    'cryptogram',
    'password',
    'password_hash',
    'authorization',
  ];

  for (const field of sensitiveFields) {
    if (field in redacted) {
      redacted[field] = '[REDACTED]';
    }
  }

  return redacted;
}

/**
 * Writes an audit log entry to the database and structured log.
 *
 * @param entry - The audit log entry to write
 *
 * @example
 * await writeAuditLog({
 *   timestamp: new Date(),
 *   userId: req.userId,
 *   action: AuditAction.PAYMENT_APPROVED,
 *   resourceType: 'transaction',
 *   resourceId: transactionId,
 *   result: 'success',
 *   ipAddress: req.ip,
 *   userAgent: req.headers['user-agent'],
 *   sessionId: req.headers['x-session-id'],
 *   requestId: req.requestId,
 *   metadata: { amount, currency, merchantId }
 * });
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  const redactedMetadata = redactSensitiveData(entry.metadata);

  // Log to structured logger for immediate visibility
  const logLevel = entry.result === 'error' ? 'error' : entry.result === 'failure' ? 'warn' : 'info';
  auditLogger[logLevel](
    {
      action: entry.action,
      userId: entry.userId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      result: entry.result,
      metadata: redactedMetadata,
      errorMessage: entry.errorMessage,
    },
    `Audit: ${entry.action}`
  );

  // Persist to database for compliance
  try {
    await query(
      `INSERT INTO audit_logs
        (user_id, user_email, action, resource_type, resource_id, result,
         ip_address, user_agent, session_id, request_id, metadata, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.userId,
        entry.userEmail,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.result,
        entry.ipAddress,
        entry.userAgent,
        entry.sessionId,
        entry.requestId,
        JSON.stringify(redactedMetadata),
        entry.errorMessage,
      ]
    );
  } catch (error) {
    // Never fail the operation due to audit logging failure
    // But alert for monitoring
    auditLogger.error(
      { error: (error as Error).message, action: entry.action },
      'Failed to persist audit log to database'
    );
  }
}

/**
 * Helper to create audit entry from Express request context.
 */
export function createAuditEntryFromRequest(
  req: Request & { userId?: string; userEmail?: string; requestId?: string },
  action: AuditAction,
  resourceType: string,
  resourceId: string | null,
  result: 'success' | 'failure' | 'error',
  metadata: Record<string, unknown> = {},
  errorMessage?: string
): AuditLogEntry {
  return {
    timestamp: new Date(),
    userId: req.userId || null,
    userEmail: req.userEmail,
    action,
    resourceType,
    resourceId,
    result,
    ipAddress: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
    sessionId: (req.headers['x-session-id'] as string) || null,
    requestId: req.requestId || null,
    metadata,
    errorMessage,
  };
}

/**
 * Convenience functions for common audit actions.
 */
export const auditLog = {
  /**
   * Log a payment transaction.
   */
  async payment(
    req: Request & { userId?: string; requestId?: string },
    transactionId: string,
    result: 'approved' | 'declined' | 'error',
    details: {
      amount: number;
      currency: string;
      merchantId: string;
      cardLast4: string;
      network: string;
      transactionType: string;
      authCode?: string;
      declineReason?: string;
    }
  ): Promise<void> {
    const action =
      result === 'approved'
        ? AuditAction.PAYMENT_APPROVED
        : result === 'declined'
          ? AuditAction.PAYMENT_DECLINED
          : AuditAction.PAYMENT_ERROR;

    await writeAuditLog(
      createAuditEntryFromRequest(
        req,
        action,
        'transaction',
        transactionId,
        result === 'approved' ? 'success' : 'failure',
        {
          amount: details.amount,
          currency: details.currency,
          merchantId: details.merchantId,
          cardLast4: details.cardLast4,
          network: details.network,
          transactionType: details.transactionType,
          authCode: details.authCode,
        },
        details.declineReason
      )
    );
  },

  /**
   * Log a card provisioning event.
   */
  async cardProvisioned(
    req: Request & { userId?: string; requestId?: string },
    cardId: string,
    details: { network: string; last4: string; deviceId: string }
  ): Promise<void> {
    await writeAuditLog(
      createAuditEntryFromRequest(req, AuditAction.CARD_PROVISIONED, 'card', cardId, 'success', {
        network: details.network,
        last4: details.last4,
        deviceId: details.deviceId,
      })
    );
  },

  /**
   * Log a card suspension event.
   */
  async cardSuspended(
    req: Request & { userId?: string; requestId?: string },
    cardId: string,
    reason: string
  ): Promise<void> {
    await writeAuditLog(
      createAuditEntryFromRequest(req, AuditAction.CARD_SUSPENDED, 'card', cardId, 'success', {
        reason,
      })
    );
  },

  /**
   * Log a login attempt.
   */
  async login(
    req: Request & { requestId?: string },
    userId: string | null,
    email: string,
    success: boolean,
    failureReason?: string
  ): Promise<void> {
    const entry = createAuditEntryFromRequest(
      req,
      success ? AuditAction.LOGIN_SUCCESS : AuditAction.LOGIN_FAILURE,
      'user',
      userId,
      success ? 'success' : 'failure',
      { email },
      failureReason
    );
    entry.userId = userId;
    await writeAuditLog(entry);
  },

  /**
   * Log a refund event.
   */
  async refund(
    req: Request & { userId?: string; requestId?: string },
    refundId: string,
    originalTransactionId: string,
    result: 'approved' | 'declined' | 'error',
    details: { amount: number; currency: string; reason?: string }
  ): Promise<void> {
    const action =
      result === 'approved'
        ? AuditAction.REFUND_APPROVED
        : result === 'declined'
          ? AuditAction.REFUND_DECLINED
          : AuditAction.REFUND_INITIATED;

    await writeAuditLog(
      createAuditEntryFromRequest(
        req,
        action,
        'refund',
        refundId,
        result === 'approved' ? 'success' : 'failure',
        {
          originalTransactionId,
          amount: details.amount,
          currency: details.currency,
        },
        details.reason
      )
    );
  },

  /**
   * Log a device lost event (security critical).
   */
  async deviceLost(
    req: Request & { userId?: string; requestId?: string },
    deviceId: string,
    suspendedCardCount: number
  ): Promise<void> {
    await writeAuditLog(
      createAuditEntryFromRequest(req, AuditAction.DEVICE_LOST, 'device', deviceId, 'success', {
        suspendedCardCount,
      })
    );
  },

  /**
   * Log a biometric authentication event.
   */
  async biometric(
    req: Request & { userId?: string; requestId?: string },
    sessionId: string,
    result: 'success' | 'failure',
    authType: string
  ): Promise<void> {
    const action = result === 'success' ? AuditAction.BIOMETRIC_SUCCESS : AuditAction.BIOMETRIC_FAILURE;

    await writeAuditLog(
      createAuditEntryFromRequest(req, action, 'biometric_session', sessionId, result, {
        authType,
      })
    );
  },
};

/**
 * Query audit logs with filters (for admin interface).
 */
export async function queryAuditLogs(filters: {
  userId?: string;
  action?: AuditAction;
  resourceType?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}): Promise<{ logs: AuditLogEntry[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${paramIndex}`);
    params.push(filters.userId);
    paramIndex++;
  }

  if (filters.action) {
    conditions.push(`action = $${paramIndex}`);
    params.push(filters.action);
    paramIndex++;
  }

  if (filters.resourceType) {
    conditions.push(`resource_type = $${paramIndex}`);
    params.push(filters.resourceType);
    paramIndex++;
  }

  if (filters.startDate) {
    conditions.push(`created_at >= $${paramIndex}`);
    params.push(filters.startDate);
    paramIndex++;
  }

  if (filters.endDate) {
    conditions.push(`created_at <= $${paramIndex}`);
    params.push(filters.endDate);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) FROM audit_logs ${whereClause}`, params);

  const limit = filters.limit || 100;
  const offset = filters.offset || 0;

  const result = await query(
    `SELECT * FROM audit_logs ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  return {
    logs: result.rows.map((row) => ({
      id: row.id,
      timestamp: row.created_at,
      userId: row.user_id,
      userEmail: row.user_email,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      result: row.result,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      sessionId: row.session_id,
      requestId: row.request_id,
      metadata: row.metadata,
      errorMessage: row.error_message,
    })),
    total: parseInt(countResult.rows[0].count),
  };
}

export default auditLog;

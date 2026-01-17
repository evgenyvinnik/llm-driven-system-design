import { query } from '../db/connection.js';
import { logAuditEvent } from './logger.js';

/**
 * Audit logging service for financial operations.
 *
 * WHY AUDIT LOGGING IS REQUIRED:
 *
 * 1. PCI-DSS COMPLIANCE (Requirement 10):
 *    - Must log all access to cardholder data
 *    - Must track all changes to system components
 *    - Logs must be immutable and retained for 1 year
 *
 * 2. SOX COMPLIANCE:
 *    - Financial transactions must have complete audit trails
 *    - Changes must be traceable to specific actors
 *
 * 3. FRAUD INVESTIGATION:
 *    - Reconstruct exact sequence of events
 *    - Identify suspicious patterns
 *    - Support dispute resolution
 *
 * 4. OPERATIONAL DEBUGGING:
 *    - Understand what happened when things go wrong
 *    - Correlate events across services
 *
 * AUDIT LOG STRUCTURE:
 * - entity_type: Type of resource (transaction, refund, merchant)
 * - entity_id: UUID of the affected resource
 * - action: What happened (created, updated, status_changed)
 * - actor_type: Who did it (api_key, admin, system)
 * - actor_id: Identifier of the actor
 * - changes: JSON diff of what changed
 * - ip_address: Client IP for fraud detection
 * - user_agent: Client info for forensics
 */

export type AuditEntityType = 'transaction' | 'refund' | 'chargeback' | 'merchant' | 'ledger';
export type AuditActorType = 'api_key' | 'admin' | 'system';
export type AuditAction =
  | 'created'
  | 'authorized'
  | 'captured'
  | 'voided'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'status_changed'
  | 'updated'
  | 'deleted';

export interface AuditLogEntry {
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  actorType: AuditActorType;
  actorId: string;
  changes?: Record<string, { from?: unknown; to: unknown }>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Records an audit log entry to both the database and structured logger.
 *
 * Dual logging ensures:
 * - Database: Queryable, long-term retention, compliance
 * - Logger: Real-time monitoring, log aggregation (ELK, Splunk)
 *
 * @param entry - Audit log entry details
 */
export async function recordAuditLog(entry: AuditLogEntry): Promise<void> {
  const {
    entityType,
    entityId,
    action,
    actorType,
    actorId,
    changes,
    metadata,
    ipAddress,
    userAgent,
  } = entry;

  // Log to structured logger (real-time)
  logAuditEvent(`${entityType}.${action}`, {
    entityType,
    entityId,
    action,
    actorType,
    actorId,
    changes,
    metadata,
    ipAddress,
    userAgent,
  });

  // Persist to database (compliance)
  try {
    await query(
      `INSERT INTO audit_log (
        entity_type, entity_id, action, actor_type, actor_id,
        changes, ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        entityType,
        entityId,
        action,
        actorType,
        actorId,
        changes ? JSON.stringify(changes) : null,
        ipAddress,
        userAgent,
      ]
    );
  } catch (error) {
    // Log failure but don't throw - audit logging should not break transactions
    // In production, this would trigger an alert
    logAuditEvent('audit.write_failed', {
      entityType,
      entityId,
      action,
      actorType,
      actorId,
      metadata: { error: error instanceof Error ? error.message : 'Unknown error' },
    });
  }
}

/**
 * Records audit log for payment creation.
 */
export async function auditPaymentCreated(
  transactionId: string,
  merchantId: string,
  amount: number,
  currency: string,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await recordAuditLog({
    entityType: 'transaction',
    entityId: transactionId,
    action: 'created',
    actorType: 'api_key',
    actorId: merchantId,
    metadata: { amount, currency },
    ipAddress,
    userAgent,
  });
}

/**
 * Records audit log for payment authorization.
 */
export async function auditPaymentAuthorized(
  transactionId: string,
  merchantId: string,
  processorRef?: string,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await recordAuditLog({
    entityType: 'transaction',
    entityId: transactionId,
    action: 'authorized',
    actorType: 'api_key',
    actorId: merchantId,
    metadata: { processor_ref: processorRef },
    ipAddress,
    userAgent,
  });
}

/**
 * Records audit log for payment capture.
 */
export async function auditPaymentCaptured(
  transactionId: string,
  merchantId: string,
  amount: number,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await recordAuditLog({
    entityType: 'transaction',
    entityId: transactionId,
    action: 'captured',
    actorType: 'api_key',
    actorId: merchantId,
    metadata: { captured_amount: amount },
    ipAddress,
    userAgent,
  });
}

/**
 * Records audit log for payment void.
 */
export async function auditPaymentVoided(
  transactionId: string,
  merchantId: string,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await recordAuditLog({
    entityType: 'transaction',
    entityId: transactionId,
    action: 'voided',
    actorType: 'api_key',
    actorId: merchantId,
    ipAddress,
    userAgent,
  });
}

/**
 * Records audit log for payment failure.
 */
export async function auditPaymentFailed(
  transactionId: string,
  merchantId: string,
  reason: string,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await recordAuditLog({
    entityType: 'transaction',
    entityId: transactionId,
    action: 'failed',
    actorType: 'api_key',
    actorId: merchantId,
    metadata: { failure_reason: reason },
    ipAddress,
    userAgent,
  });
}

/**
 * Records audit log for refund creation.
 */
export async function auditRefundCreated(
  refundId: string,
  transactionId: string,
  merchantId: string,
  amount: number,
  isFullRefund: boolean,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await recordAuditLog({
    entityType: 'refund',
    entityId: refundId,
    action: 'created',
    actorType: 'api_key',
    actorId: merchantId,
    metadata: {
      original_transaction_id: transactionId,
      refund_amount: amount,
      is_full_refund: isFullRefund,
    },
    ipAddress,
    userAgent,
  });
}

/**
 * Records audit log for chargeback events.
 */
export async function auditChargebackCreated(
  chargebackId: string,
  transactionId: string,
  merchantId: string,
  amount: number,
  reasonCode: string
): Promise<void> {
  await recordAuditLog({
    entityType: 'chargeback',
    entityId: chargebackId,
    action: 'created',
    actorType: 'system',
    actorId: 'processor',
    metadata: {
      original_transaction_id: transactionId,
      merchant_id: merchantId,
      amount,
      reason_code: reasonCode,
    },
  });
}

/**
 * Records audit log for merchant status changes.
 */
export async function auditMerchantStatusChanged(
  merchantId: string,
  actorId: string,
  actorType: AuditActorType,
  fromStatus: string,
  toStatus: string,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await recordAuditLog({
    entityType: 'merchant',
    entityId: merchantId,
    action: 'status_changed',
    actorType,
    actorId,
    changes: {
      status: { from: fromStatus, to: toStatus },
    },
    ipAddress,
    userAgent,
  });
}

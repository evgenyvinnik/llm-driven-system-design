import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import logger from './logger.js';

/**
 * Audit Logging Service
 *
 * Records all financial operations for compliance and forensic analysis.
 * Required for:
 * - PCI DSS compliance (Requirement 10: Track and monitor all access)
 * - SOX compliance for financial record keeping
 * - Fraud investigation and dispute resolution
 * - Regulatory audits
 *
 * All audit logs are immutable once written.
 */

// Audit action types for financial operations
export const AuditAction = {
  // Payment Intent actions
  PAYMENT_INTENT_CREATED: 'payment_intent.created',
  PAYMENT_INTENT_CONFIRMED: 'payment_intent.confirmed',
  PAYMENT_INTENT_CAPTURED: 'payment_intent.captured',
  PAYMENT_INTENT_CANCELED: 'payment_intent.canceled',
  PAYMENT_INTENT_FAILED: 'payment_intent.failed',

  // Charge actions
  CHARGE_CREATED: 'charge.created',
  CHARGE_SUCCEEDED: 'charge.succeeded',
  CHARGE_FAILED: 'charge.failed',

  // Refund actions
  REFUND_CREATED: 'refund.created',
  REFUND_SUCCEEDED: 'refund.succeeded',
  REFUND_FAILED: 'refund.failed',

  // Ledger actions
  LEDGER_ENTRY_CREATED: 'ledger.entry_created',
  LEDGER_IMBALANCE_DETECTED: 'ledger.imbalance_detected',

  // Fraud actions
  FRAUD_CHECK_PERFORMED: 'fraud.check_performed',
  FRAUD_BLOCKED: 'fraud.blocked',
  FRAUD_REVIEW_REQUIRED: 'fraud.review_required',

  // API Key actions
  API_KEY_CREATED: 'api_key.created',
  API_KEY_ROTATED: 'api_key.rotated',
  API_KEY_REVOKED: 'api_key.revoked',

  // Webhook actions
  WEBHOOK_CONFIGURED: 'webhook.configured',
  WEBHOOK_DELIVERED: 'webhook.delivered',
  WEBHOOK_FAILED: 'webhook.failed',

  // Merchant actions
  MERCHANT_CREATED: 'merchant.created',
  MERCHANT_UPDATED: 'merchant.updated',
  MERCHANT_SUSPENDED: 'merchant.suspended',
} as const;

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

// Actor types
export const ActorType = {
  MERCHANT: 'merchant',
  ADMIN: 'admin',
  SYSTEM: 'system',
  API: 'api',
} as const;

export type ActorTypeValue = (typeof ActorType)[keyof typeof ActorType];

// Resource types
export const ResourceType = {
  PAYMENT_INTENT: 'payment_intent',
  CHARGE: 'charge',
  REFUND: 'refund',
  LEDGER_ENTRY: 'ledger_entry',
  MERCHANT: 'merchant',
  CUSTOMER: 'customer',
  PAYMENT_METHOD: 'payment_method',
  WEBHOOK: 'webhook',
  API_KEY: 'api_key',
} as const;

export type ResourceTypeValue = (typeof ResourceType)[keyof typeof ResourceType];

// Interfaces
export interface AuditEvent {
  actorType?: ActorTypeValue;
  actorId?: string;
  action: AuditActionType;
  resourceType: ResourceTypeValue;
  resourceId: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor_type: ActorTypeValue;
  actor_id: string;
  action: AuditActionType;
  resource_type: ResourceTypeValue;
  resource_id: string;
  old_value: string | null;
  new_value: string | null;
  ip_address: string | null;
  user_agent: string | null;
  trace_id: string | null;
  metadata: string | null;
}

export interface AuditLogRow {
  id: string;
  timestamp: Date;
  actor_type: ActorTypeValue;
  actor_id: string;
  action: AuditActionType;
  resource_type: ResourceTypeValue;
  resource_id: string;
  old_value: string | null;
  new_value: string | null;
  ip_address: string | null;
  user_agent: string | null;
  trace_id: string | null;
  metadata: string | null;
}

export interface FormattedAuditLog {
  id: string;
  timestamp: Date;
  actor_type: ActorTypeValue;
  actor_id: string;
  action: AuditActionType;
  resource_type: ResourceTypeValue;
  resource_id: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  trace_id: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PaymentIntentRow {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  auth_code?: string;
  payment_method_id?: string;
}

export interface ChargeRow {
  id: string;
  merchant_id: string;
  amount: number;
  amount_refunded: number;
}

export interface RefundRow {
  id: string;
  charge_id: string;
  amount: number;
  reason?: string;
  status: string;
}

export interface LedgerEntry {
  account: string;
  debit: number;
  credit: number;
}

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit Logger class for recording financial operations
 */
class AuditLogger {
  /**
   * Log an audit event
   */
  async log(event: AuditEvent): Promise<void> {
    const auditRecord: AuditRecord = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      actor_type: event.actorType || ActorType.SYSTEM,
      actor_id: event.actorId || 'system',
      action: event.action,
      resource_type: event.resourceType,
      resource_id: event.resourceId,
      old_value: event.oldValue ? JSON.stringify(event.oldValue) : null,
      new_value: event.newValue ? JSON.stringify(event.newValue) : null,
      ip_address: event.ipAddress || null,
      user_agent: event.userAgent || null,
      trace_id: event.traceId || null,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    };

    try {
      await this.persistAuditLog(auditRecord);

      // Also log to structured logger for real-time monitoring
      logger.info({
        event: 'audit_log',
        ...auditRecord,
        old_value: event.oldValue,
        new_value: event.newValue,
        metadata: event.metadata,
      });
    } catch (error) {
      // Audit log failures are critical - log but don't throw
      logger.error({
        event: 'audit_log_failure',
        error_message: (error as Error).message,
        audit_record: auditRecord,
      });
    }
  }

  /**
   * Persist audit log to database
   */
  private async persistAuditLog(record: AuditRecord): Promise<void> {
    await query(
      `
      INSERT INTO audit_log (
        id, timestamp, actor_type, actor_id, action, resource_type, resource_id,
        old_value, new_value, ip_address, user_agent, trace_id, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `,
      [
        record.id,
        record.timestamp,
        record.actor_type,
        record.actor_id,
        record.action,
        record.resource_type,
        record.resource_id,
        record.old_value,
        record.new_value,
        record.ip_address,
        record.user_agent,
        record.trace_id,
        record.metadata,
      ]
    );
  }

  // ========================
  // Payment Intent Audit Methods
  // ========================

  async logPaymentIntentCreated(
    intent: PaymentIntentRow,
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.MERCHANT,
      actorId: intent.merchant_id,
      action: AuditAction.PAYMENT_INTENT_CREATED,
      resourceType: ResourceType.PAYMENT_INTENT,
      resourceId: intent.id,
      newValue: {
        amount: intent.amount,
        currency: intent.currency,
        status: intent.status,
      },
      ...context,
    });
  }

  async logPaymentIntentConfirmed(
    intent: PaymentIntentRow,
    previousStatus: string,
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.SYSTEM,
      actorId: 'payment-service',
      action: AuditAction.PAYMENT_INTENT_CONFIRMED,
      resourceType: ResourceType.PAYMENT_INTENT,
      resourceId: intent.id,
      oldValue: { status: previousStatus },
      newValue: {
        status: intent.status,
        auth_code: intent.auth_code,
        payment_method_id: intent.payment_method_id,
      },
      ...context,
    });
  }

  async logPaymentIntentCaptured(
    intent: PaymentIntentRow,
    captureAmount: number,
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.MERCHANT,
      actorId: intent.merchant_id,
      action: AuditAction.PAYMENT_INTENT_CAPTURED,
      resourceType: ResourceType.PAYMENT_INTENT,
      resourceId: intent.id,
      oldValue: { status: 'requires_capture' },
      newValue: {
        status: 'succeeded',
        captured_amount: captureAmount,
      },
      ...context,
    });
  }

  async logPaymentIntentFailed(
    intent: PaymentIntentRow,
    declineCode: string,
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.SYSTEM,
      actorId: 'payment-service',
      action: AuditAction.PAYMENT_INTENT_FAILED,
      resourceType: ResourceType.PAYMENT_INTENT,
      resourceId: intent.id,
      newValue: {
        status: 'failed',
        decline_code: declineCode,
      },
      ...context,
    });
  }

  // ========================
  // Refund Audit Methods
  // ========================

  async logRefundCreated(
    refund: RefundRow,
    charge: ChargeRow,
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.MERCHANT,
      actorId: charge.merchant_id,
      action: AuditAction.REFUND_CREATED,
      resourceType: ResourceType.REFUND,
      resourceId: refund.id,
      newValue: {
        amount: refund.amount,
        charge_id: refund.charge_id,
        reason: refund.reason,
        status: refund.status,
      },
      metadata: {
        original_charge_amount: charge.amount,
        previous_refund_amount: charge.amount_refunded,
      },
      ...context,
    });
  }

  // ========================
  // Fraud Audit Methods
  // ========================

  async logFraudCheck(
    intentId: string,
    riskScore: number,
    decision: string,
    rules: string[],
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.SYSTEM,
      actorId: 'fraud-service',
      action:
        decision === 'block'
          ? AuditAction.FRAUD_BLOCKED
          : decision === 'review'
            ? AuditAction.FRAUD_REVIEW_REQUIRED
            : AuditAction.FRAUD_CHECK_PERFORMED,
      resourceType: ResourceType.PAYMENT_INTENT,
      resourceId: intentId,
      newValue: {
        risk_score: riskScore,
        decision,
        rules_triggered: rules,
      },
      ...context,
    });
  }

  // ========================
  // Ledger Audit Methods
  // ========================

  async logLedgerEntry(
    transactionId: string,
    entries: LedgerEntry[],
    paymentIntentId: string,
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.SYSTEM,
      actorId: 'ledger-service',
      action: AuditAction.LEDGER_ENTRY_CREATED,
      resourceType: ResourceType.LEDGER_ENTRY,
      resourceId: transactionId,
      newValue: {
        entries: entries.map((e) => ({
          account: e.account,
          debit: e.debit,
          credit: e.credit,
        })),
        payment_intent_id: paymentIntentId,
      },
      ...context,
    });
  }

  async logLedgerImbalance(
    transactionId: string,
    totalDebit: number,
    totalCredit: number,
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.SYSTEM,
      actorId: 'ledger-service',
      action: AuditAction.LEDGER_IMBALANCE_DETECTED,
      resourceType: ResourceType.LEDGER_ENTRY,
      resourceId: transactionId,
      newValue: {
        total_debit: totalDebit,
        total_credit: totalCredit,
        imbalance: totalDebit - totalCredit,
      },
      ...context,
    });
  }

  // ========================
  // API Key Audit Methods
  // ========================

  async logApiKeyRotated(
    merchantId: string,
    keyPrefix: string,
    context: AuditContext = {}
  ): Promise<void> {
    await this.log({
      actorType: ActorType.MERCHANT,
      actorId: merchantId,
      action: AuditAction.API_KEY_ROTATED,
      resourceType: ResourceType.API_KEY,
      resourceId: merchantId,
      newValue: {
        key_prefix: keyPrefix,
        rotated_at: new Date().toISOString(),
      },
      ...context,
    });
  }

  // ========================
  // Query Methods
  // ========================

  /**
   * Query audit logs for a specific resource
   */
  async getAuditLogsForResource(
    resourceType: ResourceTypeValue,
    resourceId: string,
    limit: number = 100
  ): Promise<FormattedAuditLog[]> {
    const result = await query<AuditLogRow>(
      `
      SELECT * FROM audit_log
      WHERE resource_type = $1 AND resource_id = $2
      ORDER BY timestamp DESC
      LIMIT $3
    `,
      [resourceType, resourceId, limit]
    );

    return result.rows.map(this.formatAuditLog);
  }

  /**
   * Query audit logs for a specific actor
   */
  async getAuditLogsForActor(
    actorType: ActorTypeValue,
    actorId: string,
    limit: number = 100
  ): Promise<FormattedAuditLog[]> {
    const result = await query<AuditLogRow>(
      `
      SELECT * FROM audit_log
      WHERE actor_type = $1 AND actor_id = $2
      ORDER BY timestamp DESC
      LIMIT $3
    `,
      [actorType, actorId, limit]
    );

    return result.rows.map(this.formatAuditLog);
  }

  /**
   * Query audit logs by action type within a time range
   */
  async getAuditLogsByAction(
    action: AuditActionType,
    startTime: string,
    endTime: string,
    limit: number = 1000
  ): Promise<FormattedAuditLog[]> {
    const result = await query<AuditLogRow>(
      `
      SELECT * FROM audit_log
      WHERE action = $1 AND timestamp >= $2 AND timestamp <= $3
      ORDER BY timestamp DESC
      LIMIT $4
    `,
      [action, startTime, endTime, limit]
    );

    return result.rows.map(this.formatAuditLog);
  }

  /**
   * Format audit log for API response
   */
  private formatAuditLog(row: AuditLogRow): FormattedAuditLog {
    return {
      id: row.id,
      timestamp: row.timestamp,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      old_value: row.old_value ? JSON.parse(row.old_value) : null,
      new_value: row.new_value ? JSON.parse(row.new_value) : null,
      ip_address: row.ip_address,
      trace_id: row.trace_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }
}

// Singleton instance
export const auditLogger = new AuditLogger();

export default auditLogger;

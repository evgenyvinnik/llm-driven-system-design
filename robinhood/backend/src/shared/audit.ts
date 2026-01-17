/**
 * Audit logging service for regulatory compliance.
 *
 * SEC Rule 17a-4 and FINRA Rule 4511 require broker-dealers to:
 * - Maintain complete records of all securities transactions
 * - Retain records in non-rewritable, non-erasable format (WORM)
 * - Keep records accessible for specified retention periods
 *
 * This module provides:
 * - Immutable audit log entries in PostgreSQL
 * - Structured data for each trade action
 * - Timestamps, user context, and action details
 * - Query capabilities for compliance audits
 */

import { pool } from '../database.js';
import { logger } from './logger.js';
import { auditEntriesTotal } from './metrics.js';

/**
 * Types of actions that require audit logging.
 */
export type AuditAction =
  | 'ORDER_PLACED'
  | 'ORDER_FILLED'
  | 'ORDER_PARTIALLY_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED'
  | 'ORDER_EXPIRED'
  | 'POSITION_OPENED'
  | 'POSITION_UPDATED'
  | 'POSITION_CLOSED'
  | 'BUYING_POWER_RESERVED'
  | 'BUYING_POWER_RELEASED'
  | 'BUYING_POWER_ADJUSTED'
  | 'LOGIN'
  | 'LOGOUT'
  | 'SESSION_EXPIRED';

/**
 * Audit log entry with complete transaction context.
 */
export interface AuditEntry {
  /** User who performed the action */
  userId: string;
  /** Type of action performed */
  action: AuditAction;
  /** Related entity type (order, position, session) */
  entityType: 'order' | 'position' | 'user' | 'session';
  /** Related entity ID */
  entityId: string;
  /** Detailed data about the action */
  details: Record<string, unknown>;
  /** IP address of the request (if applicable) */
  ipAddress?: string;
  /** User agent of the request (if applicable) */
  userAgent?: string;
  /** Request ID for correlation */
  requestId?: string;
  /** Idempotency key (if applicable) */
  idempotencyKey?: string;
  /** Status of the action */
  status: 'success' | 'failure' | 'pending';
  /** Error message if status is failure */
  errorMessage?: string;
}

/**
 * Audit logging service.
 * Writes immutable audit records for all financial transactions.
 */
class AuditLogger {
  private initialized = false;

  /**
   * Initializes the audit log table if it doesn't exist.
   * Creates indexes for efficient querying.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID NOT NULL,
          action VARCHAR(50) NOT NULL,
          entity_type VARCHAR(20) NOT NULL,
          entity_id UUID NOT NULL,
          details JSONB NOT NULL,
          ip_address INET,
          user_agent TEXT,
          request_id VARCHAR(100),
          idempotency_key VARCHAR(100),
          status VARCHAR(20) NOT NULL,
          error_message TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_id ON audit_logs(entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_idempotency_key ON audit_logs(idempotency_key);
      `);

      this.initialized = true;
      logger.info('Audit log table initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize audit log table');
      throw error;
    }
  }

  /**
   * Logs an audit entry to the database.
   * This is a fire-and-forget operation - it logs errors but doesn't throw.
   * @param entry - Audit log entry to record
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, user_agent, request_id, idempotency_key, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          entry.userId,
          entry.action,
          entry.entityType,
          entry.entityId,
          JSON.stringify(entry.details),
          entry.ipAddress || null,
          entry.userAgent || null,
          entry.requestId || null,
          entry.idempotencyKey || null,
          entry.status,
          entry.errorMessage || null,
        ]
      );

      auditEntriesTotal.inc({ action: entry.action, status: entry.status });

      logger.debug(
        {
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          status: entry.status,
        },
        'Audit entry logged'
      );
    } catch (error) {
      // Log the error but don't throw - audit failures shouldn't break transactions
      logger.error({ error, entry }, 'Failed to write audit log entry');
    }
  }

  /**
   * Logs an order placement action.
   */
  async logOrderPlaced(
    userId: string,
    orderId: string,
    details: Record<string, unknown>,
    context?: { requestId?: string; ipAddress?: string; userAgent?: string; idempotencyKey?: string }
  ): Promise<void> {
    await this.log({
      userId,
      action: 'ORDER_PLACED',
      entityType: 'order',
      entityId: orderId,
      details,
      status: 'success',
      ...context,
    });
  }

  /**
   * Logs an order fill action.
   */
  async logOrderFilled(
    userId: string,
    orderId: string,
    details: Record<string, unknown>,
    context?: { requestId?: string }
  ): Promise<void> {
    await this.log({
      userId,
      action: 'ORDER_FILLED',
      entityType: 'order',
      entityId: orderId,
      details,
      status: 'success',
      ...context,
    });
  }

  /**
   * Logs an order cancellation action.
   */
  async logOrderCancelled(
    userId: string,
    orderId: string,
    details: Record<string, unknown>,
    context?: { requestId?: string }
  ): Promise<void> {
    await this.log({
      userId,
      action: 'ORDER_CANCELLED',
      entityType: 'order',
      entityId: orderId,
      details,
      status: 'success',
      ...context,
    });
  }

  /**
   * Logs an order rejection action.
   */
  async logOrderRejected(
    userId: string,
    orderId: string,
    reason: string,
    details: Record<string, unknown>,
    context?: { requestId?: string; idempotencyKey?: string }
  ): Promise<void> {
    await this.log({
      userId,
      action: 'ORDER_REJECTED',
      entityType: 'order',
      entityId: orderId,
      details,
      status: 'failure',
      errorMessage: reason,
      ...context,
    });
  }

  /**
   * Queries audit logs for a specific user.
   * @param userId - User to query for
   * @param options - Query options
   * @returns Array of audit log entries
   */
  async queryByUser(
    userId: string,
    options?: { action?: AuditAction; startDate?: Date; endDate?: Date; limit?: number }
  ): Promise<Array<AuditEntry & { id: string; createdAt: Date }>> {
    let query = 'SELECT * FROM audit_logs WHERE user_id = $1';
    const params: unknown[] = [userId];

    if (options?.action) {
      params.push(options.action);
      query += ` AND action = $${params.length}`;
    }

    if (options?.startDate) {
      params.push(options.startDate);
      query += ` AND created_at >= $${params.length}`;
    }

    if (options?.endDate) {
      params.push(options.endDate);
      query += ` AND created_at <= $${params.length}`;
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit) {
      params.push(options.limit);
      query += ` LIMIT $${params.length}`;
    }

    const result = await pool.query(query, params);
    return result.rows.map((row) => ({
      userId: row.user_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      requestId: row.request_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      errorMessage: row.error_message,
      id: row.id,
      createdAt: row.created_at,
    }));
  }

  /**
   * Queries audit logs for a specific order.
   * @param orderId - Order ID to query for
   * @returns Array of audit log entries for the order
   */
  async queryByOrder(orderId: string): Promise<Array<AuditEntry & { id: string; createdAt: Date }>> {
    const result = await pool.query(
      `SELECT * FROM audit_logs WHERE entity_type = 'order' AND entity_id = $1 ORDER BY created_at ASC`,
      [orderId]
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      requestId: row.request_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      errorMessage: row.error_message,
      id: row.id,
      createdAt: row.created_at,
    }));
  }
}

/** Singleton audit logger instance */
export const auditLogger = new AuditLogger();

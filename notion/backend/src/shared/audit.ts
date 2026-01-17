/**
 * @fileoverview Audit logging for security-relevant events.
 * Logs page sharing, permission changes, and other security events
 * to both the database and structured logs for compliance and debugging.
 */

import pool from '../models/db.js';
import { logger } from './logger.js';

/**
 * Audit event types for security tracking.
 */
export const AuditEventTypes = {
  // Page events
  PAGE_CREATED: 'page.created',
  PAGE_UPDATED: 'page.updated',
  PAGE_DELETED: 'page.deleted',
  PAGE_ARCHIVED: 'page.archived',
  PAGE_SHARED: 'page.shared',
  PAGE_UNSHARED: 'page.unshared',
  PAGE_EXPORTED: 'page.exported',

  // Permission events
  PERMISSION_GRANTED: 'permission.granted',
  PERMISSION_REVOKED: 'permission.revoked',
  PERMISSION_CHANGED: 'permission.changed',

  // Workspace events
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_DELETED: 'workspace.deleted',
  WORKSPACE_MEMBER_ADDED: 'workspace.member_added',
  WORKSPACE_MEMBER_REMOVED: 'workspace.member_removed',
  WORKSPACE_MEMBER_ROLE_CHANGED: 'workspace.member_role_changed',

  // User events
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  USER_REGISTERED: 'user.registered',
  USER_PASSWORD_CHANGED: 'user.password_changed',

  // Block events (for sensitive operations)
  BLOCK_DELETED: 'block.deleted',
} as const;

export type AuditEventType = (typeof AuditEventTypes)[keyof typeof AuditEventTypes];

/**
 * Resource types for audit logging.
 */
export type ResourceType = 'page' | 'workspace' | 'block' | 'user' | 'permission';

/**
 * Action types for audit logging.
 */
export type ActionType = 'create' | 'read' | 'update' | 'delete' | 'share' | 'export' | 'login' | 'logout';

/**
 * Audit event data structure.
 */
export interface AuditEvent {
  timestamp: string;
  eventType: AuditEventType;
  userId: string;
  resourceType: ResourceType;
  resourceId: string;
  action: ActionType;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Audit logger for security-relevant events.
 * Logs to both the database (for compliance) and structured logs (for real-time alerting).
 */
class AuditLogger {
  /**
   * Logs an audit event to the database and structured logs.
   */
  async log(event: Omit<AuditEvent, 'timestamp'>): Promise<void> {
    const auditRecord: AuditEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    // Log to structured logs immediately for real-time alerting
    logger.info(
      {
        audit: true,
        eventType: auditRecord.eventType,
        userId: auditRecord.userId,
        resourceType: auditRecord.resourceType,
        resourceId: auditRecord.resourceId,
        action: auditRecord.action,
        metadata: auditRecord.metadata,
        ipAddress: auditRecord.ipAddress,
      },
      `audit: ${auditRecord.eventType}`
    );

    // Write to database for long-term storage and compliance
    try {
      await pool.query(
        `INSERT INTO audit_log (timestamp, event_type, user_id, resource_type, resource_id, action, metadata, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          auditRecord.timestamp,
          auditRecord.eventType,
          auditRecord.userId,
          auditRecord.resourceType,
          auditRecord.resourceId,
          auditRecord.action,
          JSON.stringify(auditRecord.metadata),
          auditRecord.ipAddress,
          auditRecord.userAgent,
        ]
      );
    } catch (error) {
      // Log error but don't throw - audit logging should not break operations
      logger.error({ error, auditRecord }, 'Failed to write audit log to database');
    }
  }

  /**
   * Logs a page sharing event.
   */
  async logPageShared(
    userId: string,
    pageId: string,
    metadata: {
      sharedWith: string;
      permission: string;
      shareType: 'user' | 'link';
    },
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    await this.log({
      eventType: AuditEventTypes.PAGE_SHARED,
      userId,
      resourceType: 'page',
      resourceId: pageId,
      action: 'share',
      metadata,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Logs a permission change event.
   */
  async logPermissionChanged(
    userId: string,
    pageId: string,
    metadata: {
      targetUserId: string;
      previousPermission: string | null;
      newPermission: string;
      changeType: 'grant' | 'revoke' | 'modify';
    },
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    const eventType =
      metadata.changeType === 'grant'
        ? AuditEventTypes.PERMISSION_GRANTED
        : metadata.changeType === 'revoke'
          ? AuditEventTypes.PERMISSION_REVOKED
          : AuditEventTypes.PERMISSION_CHANGED;

    await this.log({
      eventType,
      userId,
      resourceType: 'permission',
      resourceId: pageId,
      action: 'update',
      metadata,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Logs a workspace member event.
   */
  async logWorkspaceMemberChange(
    userId: string,
    workspaceId: string,
    metadata: {
      targetUserId: string;
      action: 'added' | 'removed' | 'role_changed';
      role?: string;
      previousRole?: string;
    },
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    const eventType =
      metadata.action === 'added'
        ? AuditEventTypes.WORKSPACE_MEMBER_ADDED
        : metadata.action === 'removed'
          ? AuditEventTypes.WORKSPACE_MEMBER_REMOVED
          : AuditEventTypes.WORKSPACE_MEMBER_ROLE_CHANGED;

    await this.log({
      eventType,
      userId,
      resourceType: 'workspace',
      resourceId: workspaceId,
      action: metadata.action === 'added' ? 'create' : metadata.action === 'removed' ? 'delete' : 'update',
      metadata,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Logs an authentication event.
   */
  async logAuthEvent(
    userId: string,
    eventType: typeof AuditEventTypes.USER_LOGIN | typeof AuditEventTypes.USER_LOGOUT | typeof AuditEventTypes.USER_LOGIN_FAILED,
    metadata: {
      method?: string;
      reason?: string;
      attemptCount?: number;
    },
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    await this.log({
      eventType,
      userId,
      resourceType: 'user',
      resourceId: userId,
      action: eventType === AuditEventTypes.USER_LOGOUT ? 'logout' : 'login',
      metadata,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Logs a page export event.
   */
  async logPageExported(
    userId: string,
    pageId: string,
    metadata: {
      format: string;
      includeSubpages: boolean;
    },
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    await this.log({
      eventType: AuditEventTypes.PAGE_EXPORTED,
      userId,
      resourceType: 'page',
      resourceId: pageId,
      action: 'export',
      metadata,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Logs a page deletion event.
   */
  async logPageDeleted(
    userId: string,
    pageId: string,
    metadata: {
      title: string;
      permanent: boolean;
      workspaceId: string;
    },
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    await this.log({
      eventType: metadata.permanent ? AuditEventTypes.PAGE_DELETED : AuditEventTypes.PAGE_ARCHIVED,
      userId,
      resourceType: 'page',
      resourceId: pageId,
      action: 'delete',
      metadata,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Retrieves audit logs for a specific resource.
   */
  async getLogsForResource(
    resourceType: ResourceType,
    resourceId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<AuditEvent[]> {
    const { limit = 100, offset = 0 } = options;

    const result = await pool.query<{
      timestamp: Date;
      event_type: AuditEventType;
      user_id: string;
      resource_type: ResourceType;
      resource_id: string;
      action: ActionType;
      metadata: Record<string, unknown>;
      ip_address: string | null;
      user_agent: string | null;
    }>(
      `SELECT timestamp, event_type, user_id, resource_type, resource_id, action, metadata, ip_address, user_agent
       FROM audit_log
       WHERE resource_type = $1 AND resource_id = $2
       ORDER BY timestamp DESC
       LIMIT $3 OFFSET $4`,
      [resourceType, resourceId, limit, offset]
    );

    return result.rows.map((row) => ({
      timestamp: row.timestamp.toISOString(),
      eventType: row.event_type,
      userId: row.user_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      action: row.action,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    }));
  }

  /**
   * Retrieves audit logs for a specific user.
   */
  async getLogsForUser(
    userId: string,
    options: { limit?: number; offset?: number; eventTypes?: AuditEventType[] } = {}
  ): Promise<AuditEvent[]> {
    const { limit = 100, offset = 0, eventTypes } = options;

    let query = `
      SELECT timestamp, event_type, user_id, resource_type, resource_id, action, metadata, ip_address, user_agent
      FROM audit_log
      WHERE user_id = $1
    `;
    const params: unknown[] = [userId];
    let paramIndex = 2;

    if (eventTypes && eventTypes.length > 0) {
      query += ` AND event_type = ANY($${paramIndex++})`;
      params.push(eventTypes);
    }

    query += ` ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);

    const result = await pool.query<{
      timestamp: Date;
      event_type: AuditEventType;
      user_id: string;
      resource_type: ResourceType;
      resource_id: string;
      action: ActionType;
      metadata: Record<string, unknown>;
      ip_address: string | null;
      user_agent: string | null;
    }>(query, params);

    return result.rows.map((row) => ({
      timestamp: row.timestamp.toISOString(),
      eventType: row.event_type,
      userId: row.user_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      action: row.action,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    }));
  }
}

/**
 * Singleton audit logger instance.
 */
export const auditLogger = new AuditLogger();

export default auditLogger;

/**
 * Audit logging for security-sensitive operations.
 * Tracks profile changes, authentication events, and admin actions
 * for compliance and account recovery.
 *
 * @module utils/audit
 */
import { query, queryOne, execute } from './db.js';
import { logger } from './logger.js';

/**
 * Audit log event types.
 */
export enum AuditEventType {
  // Authentication events
  LOGIN_SUCCESS = 'auth.login.success',
  LOGIN_FAILURE = 'auth.login.failure',
  LOGOUT = 'auth.logout',
  SESSION_EXPIRED = 'auth.session.expired',

  // Profile events
  PROFILE_CREATED = 'profile.created',
  PROFILE_UPDATED = 'profile.updated',
  PROFILE_DELETED = 'profile.deleted',
  EXPERIENCE_ADDED = 'profile.experience.added',
  EXPERIENCE_UPDATED = 'profile.experience.updated',
  EXPERIENCE_DELETED = 'profile.experience.deleted',
  EDUCATION_ADDED = 'profile.education.added',
  EDUCATION_DELETED = 'profile.education.deleted',
  SKILL_ADDED = 'profile.skill.added',
  SKILL_REMOVED = 'profile.skill.removed',

  // Connection events
  CONNECTION_REQUEST_SENT = 'connection.request.sent',
  CONNECTION_REQUEST_ACCEPTED = 'connection.request.accepted',
  CONNECTION_REQUEST_REJECTED = 'connection.request.rejected',
  CONNECTION_REMOVED = 'connection.removed',

  // Content events
  POST_CREATED = 'content.post.created',
  POST_UPDATED = 'content.post.updated',
  POST_DELETED = 'content.post.deleted',
  COMMENT_CREATED = 'content.comment.created',
  COMMENT_DELETED = 'content.comment.deleted',

  // Admin events
  ADMIN_USER_BANNED = 'admin.user.banned',
  ADMIN_USER_UNBANNED = 'admin.user.unbanned',
  ADMIN_ROLE_CHANGED = 'admin.role.changed',
  ADMIN_CONTENT_REMOVED = 'admin.content.removed',
}

/**
 * Target types for audit logs.
 */
export type TargetType = 'user' | 'profile' | 'connection' | 'post' | 'comment' | 'job' | 'session';

/**
 * Audit log entry interface.
 */
export interface AuditLogEntry {
  id: number;
  event_type: string;
  actor_id: number | null;
  actor_ip: string | null;
  target_type: TargetType | null;
  target_id: number | null;
  action: string;
  details: Record<string, unknown>;
  created_at: Date;
}

/**
 * Input for creating an audit log entry.
 */
export interface AuditLogInput {
  eventType: AuditEventType;
  actorId?: number | null;
  actorIp?: string | null;
  targetType?: TargetType;
  targetId?: number | null;
  action: string;
  details?: Record<string, unknown>;
}

/**
 * Creates an audit log entry in the database.
 * Logs are persisted for compliance and security investigations.
 *
 * @param input - Audit log data
 * @returns The created audit log entry
 */
export async function createAuditLog(input: AuditLogInput): Promise<AuditLogEntry | null> {
  try {
    const entry = await queryOne<AuditLogEntry>(
      `INSERT INTO audit_logs (event_type, actor_id, actor_ip, target_type, target_id, action, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.eventType,
        input.actorId || null,
        input.actorIp || null,
        input.targetType || null,
        input.targetId || null,
        input.action,
        JSON.stringify(input.details || {}),
      ]
    );

    logger.debug(
      {
        eventType: input.eventType,
        actorId: input.actorId,
        targetType: input.targetType,
        targetId: input.targetId,
      },
      'Audit log created'
    );

    return entry;
  } catch (error) {
    logger.error({ error, input }, 'Failed to create audit log');
    // Don't throw - audit logging should not break the main operation
    return null;
  }
}

/**
 * Logs a successful login.
 */
export async function logLoginSuccess(
  userId: number,
  email: string,
  ipAddress: string,
  userAgent: string
): Promise<void> {
  await createAuditLog({
    eventType: AuditEventType.LOGIN_SUCCESS,
    actorId: userId,
    actorIp: ipAddress,
    targetType: 'user',
    targetId: userId,
    action: 'login',
    details: { email, userAgent },
  });
}

/**
 * Logs a failed login attempt.
 */
export async function logLoginFailure(
  email: string,
  ipAddress: string,
  userAgent: string,
  reason: string
): Promise<void> {
  await createAuditLog({
    eventType: AuditEventType.LOGIN_FAILURE,
    actorId: null,
    actorIp: ipAddress,
    targetType: 'user',
    targetId: null,
    action: 'login_failed',
    details: { email, userAgent, reason },
  });
}

/**
 * Logs a profile update with changed fields.
 * Hashes sensitive values for privacy.
 */
export async function logProfileUpdate(
  userId: number,
  ipAddress: string,
  changedFields: string[],
  previousValues: Record<string, unknown>,
  newValues: Record<string, unknown>
): Promise<void> {
  // Mask sensitive data
  const maskValue = (value: unknown): unknown => {
    if (typeof value === 'string' && value.length > 4) {
      return `${value.substring(0, 2)}***${value.substring(value.length - 2)}`;
    }
    return value;
  };

  const maskedPrevious: Record<string, unknown> = {};
  const maskedNew: Record<string, unknown> = {};

  for (const field of changedFields) {
    maskedPrevious[field] = maskValue(previousValues[field]);
    maskedNew[field] = maskValue(newValues[field]);
  }

  await createAuditLog({
    eventType: AuditEventType.PROFILE_UPDATED,
    actorId: userId,
    actorIp: ipAddress,
    targetType: 'profile',
    targetId: userId,
    action: 'update',
    details: {
      changedFields,
      previous: maskedPrevious,
      new: maskedNew,
    },
  });
}

/**
 * Logs a connection event.
 */
export async function logConnectionEvent(
  eventType: AuditEventType,
  actorId: number,
  targetUserId: number,
  ipAddress: string
): Promise<void> {
  const actions: Record<string, string> = {
    [AuditEventType.CONNECTION_REQUEST_SENT]: 'request_sent',
    [AuditEventType.CONNECTION_REQUEST_ACCEPTED]: 'request_accepted',
    [AuditEventType.CONNECTION_REQUEST_REJECTED]: 'request_rejected',
    [AuditEventType.CONNECTION_REMOVED]: 'removed',
  };

  await createAuditLog({
    eventType,
    actorId,
    actorIp: ipAddress,
    targetType: 'connection',
    targetId: targetUserId,
    action: actions[eventType] || 'unknown',
    details: { targetUserId },
  });
}

/**
 * Logs an admin action.
 */
export async function logAdminAction(
  eventType: AuditEventType,
  adminId: number,
  targetUserId: number,
  ipAddress: string,
  reason: string,
  additionalDetails?: Record<string, unknown>
): Promise<void> {
  await createAuditLog({
    eventType,
    actorId: adminId,
    actorIp: ipAddress,
    targetType: 'user',
    targetId: targetUserId,
    action: eventType.split('.').pop() || 'admin_action',
    details: {
      reason,
      ...additionalDetails,
    },
  });
}

/**
 * Retrieves audit logs for a specific user.
 * Used for account recovery and security review.
 *
 * @param userId - User ID to query logs for
 * @param limit - Maximum logs to return
 * @param offset - Number of logs to skip
 * @returns Array of audit log entries
 */
export async function getAuditLogsForUser(
  userId: number,
  limit = 50,
  offset = 0
): Promise<AuditLogEntry[]> {
  return query<AuditLogEntry>(
    `SELECT * FROM audit_logs
     WHERE actor_id = $1 OR (target_type = 'user' AND target_id = $1)
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
}

/**
 * Retrieves all admin actions.
 * Used for compliance auditing.
 *
 * @param startDate - Start of date range
 * @param endDate - End of date range
 * @param limit - Maximum logs to return
 * @returns Array of admin audit log entries
 */
export async function getAdminAuditLogs(
  startDate: Date,
  endDate: Date,
  limit = 100
): Promise<AuditLogEntry[]> {
  return query<AuditLogEntry>(
    `SELECT * FROM audit_logs
     WHERE event_type LIKE 'admin.%'
     AND created_at BETWEEN $1 AND $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [startDate, endDate, limit]
  );
}

/**
 * Retrieves failed login attempts for security monitoring.
 *
 * @param hours - Number of hours to look back
 * @param limit - Maximum logs to return
 * @returns Array of failed login audit entries
 */
export async function getFailedLoginAttempts(
  hours = 24,
  limit = 100
): Promise<AuditLogEntry[]> {
  return query<AuditLogEntry>(
    `SELECT * FROM audit_logs
     WHERE event_type = $1
     AND created_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY created_at DESC
     LIMIT $2`,
    [AuditEventType.LOGIN_FAILURE, limit]
  );
}

export default createAuditLog;

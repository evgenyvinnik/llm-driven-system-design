import { pool } from '../db.js';
import logger from './logger.js';

/**
 * Audit logging for sensitive operations.
 * Persists to PostgreSQL for compliance and debugging.
 */

// SQL to create audit_logs table (should be added to migrations)
export const AUDIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMP DEFAULT NOW(),
    actor_id UUID,
    actor_ip INET,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id UUID,
    details JSONB DEFAULT '{}',
    success BOOLEAN DEFAULT TRUE,
    request_id VARCHAR(100)
  );
  CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON audit_logs(actor_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
`;

/**
 * Audited action categories
 */
export const AuditActions = {
  // Authentication
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_REGISTER: 'user.register',

  // Account changes
  USER_UPDATE_PROFILE: 'user.update_profile',
  USER_UPDATE_PASSWORD: 'user.update_password',
  USER_UPDATE_EMAIL: 'user.update_email',

  // Subscription
  SUBSCRIPTION_UPGRADE: 'subscription.upgrade',
  SUBSCRIPTION_DOWNGRADE: 'subscription.downgrade',
  SUBSCRIPTION_CANCEL: 'subscription.cancel',

  // Admin actions
  ADMIN_USER_BAN: 'admin.user_ban',
  ADMIN_USER_UNBAN: 'admin.user_unban',
  ADMIN_CONTENT_REMOVE: 'admin.content_remove',
  ADMIN_ROLE_CHANGE: 'admin.role_change',

  // Playlist permissions
  PLAYLIST_ADD_COLLABORATOR: 'playlist.add_collaborator',
  PLAYLIST_REMOVE_COLLABORATOR: 'playlist.remove_collaborator',
  PLAYLIST_MAKE_PUBLIC: 'playlist.make_public',
  PLAYLIST_MAKE_PRIVATE: 'playlist.make_private',

  // Data export (GDPR)
  DATA_EXPORT_REQUEST: 'data.export_request',
  DATA_DELETE_REQUEST: 'data.delete_request',
};

/**
 * Log an audit event to the database.
 *
 * @param {Object} req - Express request object (for actor info)
 * @param {string} action - Action being audited (from AuditActions)
 * @param {string} resourceType - Type of resource being acted upon
 * @param {string|null} resourceId - ID of the resource (can be null)
 * @param {Object} details - Additional details about the action
 * @param {boolean} success - Whether the action succeeded
 */
export async function auditLog(
  req,
  action,
  resourceType,
  resourceId,
  details = {},
  success = true
) {
  const log = req?.log || logger;

  try {
    // Get actor information from request
    const actorId = req?.session?.userId || null;
    const actorIp = req?.ip || null;
    const requestId = req?.requestId || null;

    // Insert audit log entry
    await pool.query(
      `INSERT INTO audit_logs
       (actor_id, actor_ip, action, resource_type, resource_id, details, success, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        actorId,
        actorIp,
        action,
        resourceType,
        resourceId,
        JSON.stringify(details),
        success,
        requestId,
      ]
    );

    // Also log to structured logger for real-time observability
    const logData = {
      action,
      resourceType,
      resourceId,
      actorId,
      actorIp,
      details,
      success,
      audit: true, // Tag for log filtering
    };

    if (success) {
      log.info(logData, `Audit: ${action}`);
    } else {
      log.warn(logData, `Audit failed: ${action}`);
    }
  } catch (error) {
    // Don't fail the request if audit logging fails
    log.error(
      {
        error: error.message,
        action,
        resourceType,
        resourceId,
      },
      'Failed to write audit log'
    );
  }
}

/**
 * Query audit logs (for admin dashboard).
 *
 * @param {Object} filters - Filter options
 * @returns {Promise<Array>} Matching audit log entries
 */
export async function queryAuditLogs({
  actorId = null,
  action = null,
  resourceType = null,
  resourceId = null,
  startDate = null,
  endDate = null,
  success = null,
  limit = 100,
  offset = 0,
}) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (actorId) {
    conditions.push(`actor_id = $${paramIndex++}`);
    params.push(actorId);
  }
  if (action) {
    conditions.push(`action = $${paramIndex++}`);
    params.push(action);
  }
  if (resourceType) {
    conditions.push(`resource_type = $${paramIndex++}`);
    params.push(resourceType);
  }
  if (resourceId) {
    conditions.push(`resource_id = $${paramIndex++}`);
    params.push(resourceId);
  }
  if (startDate) {
    conditions.push(`timestamp >= $${paramIndex++}`);
    params.push(startDate);
  }
  if (endDate) {
    conditions.push(`timestamp <= $${paramIndex++}`);
    params.push(endDate);
  }
  if (success !== null) {
    conditions.push(`success = $${paramIndex++}`);
    params.push(success);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT al.*, u.username as actor_username, u.email as actor_email
     FROM audit_logs al
     LEFT JOIN users u ON al.actor_id = u.id
     ${whereClause}
     ORDER BY timestamp DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, limit, offset]
  );

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM audit_logs ${whereClause}`,
    params
  );

  return {
    logs: result.rows,
    total: parseInt(countResult.rows[0].count),
    limit,
    offset,
  };
}

export default {
  AUDIT_TABLE_SQL,
  AuditActions,
  auditLog,
  queryAuditLogs,
};

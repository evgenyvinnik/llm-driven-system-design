import { query } from '../db/index.js';
import logger from './logger.js';

/**
 * Audit logging for security-sensitive operations
 *
 * Captures:
 * - Repository access and modifications
 * - Permission changes
 * - Authentication events
 * - Admin actions
 *
 * Enables:
 * - Security investigations
 * - Compliance reporting
 * - Access pattern analysis
 */

// Actions that should be audited
export const AUDITED_ACTIONS = {
  // Repository operations
  REPO_CREATE: 'repo.create',
  REPO_DELETE: 'repo.delete',
  REPO_VISIBILITY_CHANGE: 'repo.visibility_change',
  REPO_SETTINGS_CHANGE: 'repo.settings_change',
  REPO_TRANSFER: 'repo.transfer',

  // PR operations
  PR_CREATE: 'pr.create',
  PR_MERGE: 'pr.merge',
  PR_CLOSE: 'pr.close',

  // Issue operations
  ISSUE_CREATE: 'issue.create',
  ISSUE_CLOSE: 'issue.close',

  // Permission operations
  COLLABORATOR_ADD: 'collaborator.add',
  COLLABORATOR_REMOVE: 'collaborator.remove',
  COLLABORATOR_PERMISSION_CHANGE: 'collaborator.permission_change',

  // Webhook operations
  WEBHOOK_CREATE: 'webhook.create',
  WEBHOOK_DELETE: 'webhook.delete',
  WEBHOOK_UPDATE: 'webhook.update',

  // Branch protection
  BRANCH_PROTECTION_CREATE: 'branch_protection.create',
  BRANCH_PROTECTION_UPDATE: 'branch_protection.update',
  BRANCH_PROTECTION_DELETE: 'branch_protection.delete',

  // Authentication
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_LOGIN_FAILED: 'user.login_failed',

  // Admin operations
  ADMIN_USER_CREATE: 'admin.user_create',
  ADMIN_USER_DELETE: 'admin.user_delete',
  ADMIN_USER_ROLE_CHANGE: 'admin.user_role_change',
};

/**
 * Create an audit log entry
 *
 * @param {string} action - Action from AUDITED_ACTIONS
 * @param {string} resourceType - Type of resource (repository, user, webhook, etc.)
 * @param {string|number} resourceId - ID of the resource
 * @param {object} details - Additional details about the action
 * @param {object} req - Express request object for extracting context
 * @param {string} outcome - success, denied, or error
 */
export async function auditLog(action, resourceType, resourceId, details = {}, req = null, outcome = 'success') {
  try {
    const userId = req?.user?.id || null;
    const ipAddress = req?.ip || req?.connection?.remoteAddress || null;
    const userAgent = req?.headers?.['user-agent'] || null;
    const requestId = req?.headers?.['x-request-id'] || null;

    await query(
      `INSERT INTO audit_logs
       (user_id, action, resource_type, resource_id, ip_address, user_agent, request_id, details, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        action,
        resourceType,
        String(resourceId),
        ipAddress,
        userAgent,
        requestId,
        JSON.stringify(details),
        outcome,
      ]
    );

    // Also log to structured logger for real-time monitoring
    logger.info({
      type: 'audit',
      action,
      resourceType,
      resourceId,
      userId,
      ipAddress,
      outcome,
      details,
    }, `Audit: ${action} on ${resourceType}:${resourceId}`);

  } catch (err) {
    // Don't fail the operation if audit logging fails
    logger.error({ err, action, resourceType, resourceId }, 'Failed to write audit log');
  }
}

/**
 * Query audit logs with filters
 *
 * @param {object} filters - Query filters
 * @param {number} filters.userId - Filter by user ID
 * @param {string} filters.action - Filter by action
 * @param {string} filters.resourceType - Filter by resource type
 * @param {string} filters.resourceId - Filter by resource ID
 * @param {Date} filters.startDate - Filter by start date
 * @param {Date} filters.endDate - Filter by end date
 * @param {string} filters.outcome - Filter by outcome
 * @param {number} limit - Maximum results
 * @param {number} offset - Pagination offset
 */
export async function queryAuditLogs(filters = {}, limit = 100, offset = 0) {
  const conditions = [];
  const params = [];

  if (filters.userId) {
    params.push(filters.userId);
    conditions.push(`user_id = $${params.length}`);
  }

  if (filters.action) {
    params.push(filters.action);
    conditions.push(`action = $${params.length}`);
  }

  if (filters.resourceType) {
    params.push(filters.resourceType);
    conditions.push(`resource_type = $${params.length}`);
  }

  if (filters.resourceId) {
    params.push(filters.resourceId);
    conditions.push(`resource_id = $${params.length}`);
  }

  if (filters.startDate) {
    params.push(filters.startDate);
    conditions.push(`timestamp >= $${params.length}`);
  }

  if (filters.endDate) {
    params.push(filters.endDate);
    conditions.push(`timestamp <= $${params.length}`);
  }

  if (filters.outcome) {
    params.push(filters.outcome);
    conditions.push(`outcome = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit, offset);

  const result = await query(
    `SELECT al.*, u.username
     FROM audit_logs al
     LEFT JOIN users u ON al.user_id = u.id
     ${whereClause}
     ORDER BY al.timestamp DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return result.rows;
}

/**
 * Get audit logs for a specific repository
 */
export async function getRepoAuditLogs(repoId, limit = 50) {
  return queryAuditLogs({
    resourceType: 'repository',
    resourceId: String(repoId),
  }, limit);
}

/**
 * Get audit logs for a specific user
 */
export async function getUserAuditLogs(userId, limit = 50) {
  return queryAuditLogs({ userId }, limit);
}

export default {
  auditLog,
  queryAuditLogs,
  getRepoAuditLogs,
  getUserAuditLogs,
  AUDITED_ACTIONS,
};

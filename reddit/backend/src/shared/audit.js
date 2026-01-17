import { query } from '../db/index.js';
import logger from './logger.js';
import { auditEventsTotal } from './metrics.js';

/**
 * Audit logging for moderation and security-relevant actions.
 *
 * Why audit logging enables moderation transparency:
 * - Creates immutable record of all mod actions for accountability
 * - Enables review of ban/removal patterns to detect mod abuse
 * - Supports appeals process by showing what actions were taken and why
 * - Required for legal compliance in some jurisdictions
 *
 * Events to audit:
 * - user.login, user.login_failed - Security monitoring
 * - post.delete, comment.delete - Content moderation
 * - user.ban, user.unban - User moderation
 * - subreddit.settings_change - Configuration changes
 * - vote.suspicious - Potential vote manipulation
 */

/**
 * @typedef {Object} AuditEvent
 * @property {number|null} actorId - User who performed the action
 * @property {string} actorIp - IP address of the actor
 * @property {string} action - Action type (e.g., 'post.delete', 'user.ban')
 * @property {'post'|'comment'|'user'|'subreddit'|null} [targetType] - Type of entity affected
 * @property {number|null} [targetId] - ID of affected entity
 * @property {Object|null} [details] - Additional context (reason, before/after values)
 * @property {number|null} [subredditId] - Subreddit context if applicable
 */

/**
 * Log an audit event to the database.
 * @param {AuditEvent} event - The audit event to log
 */
export async function audit(event) {
  const {
    actorId,
    actorIp,
    action,
    targetType = null,
    targetId = null,
    details = null,
    subredditId = null,
  } = event;

  try {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_ip, action, target_type, target_id, details, subreddit_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        actorId,
        actorIp,
        action,
        targetType,
        targetId,
        details ? JSON.stringify(details) : null,
        subredditId,
      ]
    );

    // Update metrics
    auditEventsTotal.inc({ action, target_type: targetType || 'none' });

    logger.debug({
      action,
      actorId,
      targetType,
      targetId,
    }, 'Audit event logged');
  } catch (error) {
    // Audit failures should not break the main operation
    // but should be logged for investigation
    logger.error({
      err: error,
      event,
    }, 'Failed to log audit event');
  }
}

/**
 * Helper to extract IP from request, handling proxies.
 */
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

/**
 * Audit middleware helper - creates audit context for a request.
 */
export function createAuditContext(req) {
  return {
    actorId: req.user?.id || null,
    actorIp: getClientIp(req),
  };
}

// ============================================================================
// Convenience functions for common audit events
// ============================================================================

export async function auditLogin(req, userId, success) {
  await audit({
    actorId: userId,
    actorIp: getClientIp(req),
    action: success ? 'user.login' : 'user.login_failed',
    targetType: 'user',
    targetId: userId,
    details: {
      userAgent: req.headers['user-agent'],
      success,
    },
  });
}

export async function auditPostDelete(req, postId, subredditId, reason = null) {
  const context = createAuditContext(req);
  await audit({
    ...context,
    action: 'post.delete',
    targetType: 'post',
    targetId: postId,
    subredditId,
    details: {
      reason,
      deletedByAuthor: req.user?.id === req.body?.authorId,
    },
  });
}

export async function auditCommentDelete(req, commentId, postId, subredditId, reason = null) {
  const context = createAuditContext(req);
  await audit({
    ...context,
    action: 'comment.delete',
    targetType: 'comment',
    targetId: commentId,
    subredditId,
    details: {
      postId,
      reason,
      deletedByAuthor: req.user?.id === req.body?.authorId,
    },
  });
}

export async function auditUserBan(req, targetUserId, subredditId, duration, reason) {
  const context = createAuditContext(req);
  await audit({
    ...context,
    action: 'user.ban',
    targetType: 'user',
    targetId: targetUserId,
    subredditId,
    details: {
      duration, // null = permanent
      reason,
    },
  });
}

export async function auditSuspiciousVoting(userId, ip, targetType, targetId, pattern) {
  await audit({
    actorId: userId,
    actorIp: ip,
    action: 'vote.suspicious',
    targetType,
    targetId,
    details: {
      pattern, // e.g., 'rapid_voting', 'coordinated_upvotes'
    },
  });
}

export default audit;

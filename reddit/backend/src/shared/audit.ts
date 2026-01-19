import { query } from '../db/index.js';
import logger from './logger.js';
import { auditEventsTotal } from './metrics.js';
import type { AuthenticatedRequest } from './logger.js';

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

export type TargetType = 'post' | 'comment' | 'user' | 'subreddit';

export interface AuditEvent {
  actorId: number | null;
  actorIp: string;
  action: string;
  targetType?: TargetType | null;
  targetId?: number | null;
  details?: Record<string, unknown> | null;
  subredditId?: number | null;
}

export interface AuditContext {
  actorId: number | null;
  actorIp: string;
}

/**
 * Log an audit event to the database.
 */
export async function audit(event: AuditEvent): Promise<void> {
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
export function getClientIp(req: AuthenticatedRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return forwardedStr.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Audit middleware helper - creates audit context for a request.
 */
export function createAuditContext(req: AuthenticatedRequest): AuditContext {
  return {
    actorId: req.user?.id ?? null,
    actorIp: getClientIp(req),
  };
}

// ============================================================================
// Convenience functions for common audit events
// ============================================================================

export async function auditLogin(req: AuthenticatedRequest, userId: number | null, success: boolean): Promise<void> {
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

export async function auditPostDelete(
  req: AuthenticatedRequest,
  postId: number,
  subredditId: number,
  reason: string | null = null
): Promise<void> {
  const context = createAuditContext(req);
  const body = req.body as { authorId?: number } | undefined;
  await audit({
    ...context,
    action: 'post.delete',
    targetType: 'post',
    targetId: postId,
    subredditId,
    details: {
      reason,
      deletedByAuthor: req.user?.id === body?.authorId,
    },
  });
}

export async function auditCommentDelete(
  req: AuthenticatedRequest,
  commentId: number,
  postId: number,
  subredditId: number,
  reason: string | null = null
): Promise<void> {
  const context = createAuditContext(req);
  const body = req.body as { authorId?: number } | undefined;
  await audit({
    ...context,
    action: 'comment.delete',
    targetType: 'comment',
    targetId: commentId,
    subredditId,
    details: {
      postId,
      reason,
      deletedByAuthor: req.user?.id === body?.authorId,
    },
  });
}

export async function auditUserBan(
  req: AuthenticatedRequest,
  targetUserId: number,
  subredditId: number,
  duration: number | null,
  reason: string
): Promise<void> {
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

export async function auditSuspiciousVoting(
  userId: number,
  ip: string,
  targetType: TargetType,
  targetId: number,
  pattern: string
): Promise<void> {
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

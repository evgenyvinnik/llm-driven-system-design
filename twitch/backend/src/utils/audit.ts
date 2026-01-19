/**
 * Audit Logging for Moderation Actions
 *
 * Provides tamper-evident logging for:
 * - User bans and timeouts
 * - Message deletions
 * - Moderator assignments
 * - Stream key regeneration
 * - Account actions
 *
 * Audit logs are critical for:
 * - Handling user appeals
 * - Investigating abuse reports
 * - Compliance and legal requirements
 * - Platform transparency
 */
import pino from 'pino';
import { Request, Response, NextFunction } from 'express';
import { incModerationAction } from './metrics.js';

interface Actor {
  userId: number | null;
  username: string;
  ip: string;
}

interface Target {
  type: string;
  id: string | number;
}

interface ModerationDetails {
  channelId?: number;
  reason?: string | null;
  duration?: number;
  metadata?: Record<string, unknown>;
}

interface AuditEntry {
  action: string;
  actor: {
    user_id: number | null;
    username: string;
    ip: string;
  };
  target: Target;
  channel_id?: number;
  reason: string | null;
  duration_seconds: number | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

// Separate logger for audit events
// In production, this would write to a separate, append-only store
const auditLogger = pino({
  level: 'info',
  formatters: {
    level: (label: string) => ({ level: label })
  },
  base: {
    type: 'audit',
    service: 'twitch-api',
    instance: process.env.INSTANCE_ID || `port-${process.env.PORT || 3000}`
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

// Moderation action types
const MODERATION_ACTIONS = {
  BAN_USER: 'ban_user',
  UNBAN_USER: 'unban_user',
  TIMEOUT_USER: 'timeout_user',
  DELETE_MESSAGE: 'delete_message',
  CLEAR_CHAT: 'clear_chat',
  ADD_MODERATOR: 'add_moderator',
  REMOVE_MODERATOR: 'remove_moderator',
  ENABLE_SLOW_MODE: 'enable_slow_mode',
  DISABLE_SLOW_MODE: 'disable_slow_mode',
  ENABLE_SUB_ONLY: 'enable_sub_only',
  DISABLE_SUB_ONLY: 'disable_sub_only',
  ENABLE_EMOTE_ONLY: 'enable_emote_only',
  DISABLE_EMOTE_ONLY: 'disable_emote_only'
} as const;

// Account action types
const ACCOUNT_ACTIONS = {
  STREAM_KEY_REGENERATE: 'stream_key_regenerate',
  ACCOUNT_SUSPEND: 'account_suspend',
  ACCOUNT_UNSUSPEND: 'account_unsuspend',
  ROLE_CHANGE: 'role_change',
  EMAIL_CHANGE: 'email_change',
  PASSWORD_CHANGE: 'password_change'
} as const;

// Authentication action types
const AUTH_ACTIONS = {
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILURE: 'login_failure',
  LOGOUT: 'logout',
  SESSION_EXPIRE: 'session_expire',
  ADMIN_LOGIN: 'admin_login'
} as const;

/**
 * Log a moderation action
 */
function logModeration(action: string, actor: Actor, target: Target, details: ModerationDetails = {}): AuditEntry {
  const entry: AuditEntry = {
    action,
    actor: {
      user_id: actor.userId,
      username: actor.username,
      ip: actor.ip
    },
    target: {
      type: target.type,
      id: target.id
    },
    channel_id: details.channelId,
    reason: details.reason || null,
    duration_seconds: details.duration || null,
    metadata: details.metadata || {},
    timestamp: new Date().toISOString()
  };

  auditLogger.info(entry, `moderation: ${action}`);

  // Update metrics
  if (details.channelId) {
    incModerationAction(action, details.channelId);
  }

  return entry;
}

/**
 * Log a user ban
 */
function logUserBan(
  actor: Actor,
  targetUserId: number,
  targetUsername: string,
  channelId: number,
  reason?: string,
  expiresAt: Date | null = null
): AuditEntry {
  return logModeration(MODERATION_ACTIONS.BAN_USER, actor, {
    type: 'user',
    id: targetUserId
  }, {
    channelId,
    reason,
    metadata: {
      target_username: targetUsername,
      is_permanent: !expiresAt,
      expires_at: expiresAt
    }
  });
}

/**
 * Log a user unban
 */
function logUserUnban(
  actor: Actor,
  targetUserId: number,
  targetUsername: string,
  channelId: number
): AuditEntry {
  return logModeration(MODERATION_ACTIONS.UNBAN_USER, actor, {
    type: 'user',
    id: targetUserId
  }, {
    channelId,
    metadata: { target_username: targetUsername }
  });
}

/**
 * Log a user timeout
 */
function logUserTimeout(
  actor: Actor,
  targetUserId: number,
  targetUsername: string,
  channelId: number,
  durationSeconds: number,
  reason?: string
): AuditEntry {
  return logModeration(MODERATION_ACTIONS.TIMEOUT_USER, actor, {
    type: 'user',
    id: targetUserId
  }, {
    channelId,
    reason,
    duration: durationSeconds,
    metadata: { target_username: targetUsername }
  });
}

/**
 * Log a message deletion
 */
function logMessageDelete(
  actor: Actor,
  messageId: string,
  channelId: number,
  reason?: string
): AuditEntry {
  return logModeration(MODERATION_ACTIONS.DELETE_MESSAGE, actor, {
    type: 'message',
    id: messageId
  }, {
    channelId,
    reason
  });
}

/**
 * Log clearing entire chat
 */
function logChatClear(actor: Actor, channelId: number): AuditEntry {
  return logModeration(MODERATION_ACTIONS.CLEAR_CHAT, actor, {
    type: 'channel',
    id: channelId
  }, {
    channelId
  });
}

/**
 * Log adding a moderator
 */
function logModeratorAdd(
  actor: Actor,
  targetUserId: number,
  targetUsername: string,
  channelId: number
): AuditEntry {
  return logModeration(MODERATION_ACTIONS.ADD_MODERATOR, actor, {
    type: 'user',
    id: targetUserId
  }, {
    channelId,
    metadata: { target_username: targetUsername }
  });
}

/**
 * Log removing a moderator
 */
function logModeratorRemove(
  actor: Actor,
  targetUserId: number,
  targetUsername: string,
  channelId: number
): AuditEntry {
  return logModeration(MODERATION_ACTIONS.REMOVE_MODERATOR, actor, {
    type: 'user',
    id: targetUserId
  }, {
    channelId,
    metadata: { target_username: targetUsername }
  });
}

interface AccountAuditEntry {
  action: string;
  actor: {
    user_id: number | null;
    username: string;
    ip: string;
  };
  target: {
    type: string;
    id: number;
  };
  metadata: Record<string, unknown>;
  timestamp: string;
}

/**
 * Log an account action
 */
function logAccountAction(
  action: string,
  actor: Actor,
  targetUserId: number,
  details: Record<string, unknown> = {}
): AccountAuditEntry {
  const entry: AccountAuditEntry = {
    action,
    actor: {
      user_id: actor.userId,
      username: actor.username,
      ip: actor.ip
    },
    target: {
      type: 'user',
      id: targetUserId
    },
    metadata: details,
    timestamp: new Date().toISOString()
  };

  auditLogger.info(entry, `account: ${action}`);
  return entry;
}

/**
 * Log stream key regeneration
 */
function logStreamKeyRegenerate(actor: Actor, channelId: number): AccountAuditEntry {
  return logAccountAction(ACCOUNT_ACTIONS.STREAM_KEY_REGENERATE, actor, actor.userId!, {
    channel_id: channelId
  });
}

interface AuthAuditEntry {
  action: string;
  user_id: number | null;
  username: string | null;
  ip: string;
  success: boolean;
  metadata: Record<string, unknown>;
  timestamp: string;
}

/**
 * Log an authentication event
 */
function logAuthEvent(
  action: string,
  userId: number | null,
  username: string | null,
  ip: string,
  success: boolean = true,
  details: Record<string, unknown> = {}
): AuthAuditEntry {
  const entry: AuthAuditEntry = {
    action,
    user_id: userId,
    username,
    ip,
    success,
    metadata: details,
    timestamp: new Date().toISOString()
  };

  if (success) {
    auditLogger.info(entry, `auth: ${action}`);
  } else {
    auditLogger.warn(entry, `auth: ${action} failed`);
  }

  return entry;
}

/**
 * Express middleware to attach audit context to request
 */
function auditContext(req: Request, _res: Response, next: NextFunction): void {
  req.auditActor = () => ({
    userId: req.userId || null,
    username: req.username || 'unknown',
    ip: req.ip || req.socket.remoteAddress || 'unknown'
  });
  next();
}

interface ChannelAuditLogsResult {
  logs: unknown[];
  total: number;
  message: string;
}

/**
 * Get audit logs for a specific channel (would query from storage in production)
 * This is a placeholder - in production, you'd query from an audit log store
 */
async function getChannelAuditLogs(_channelId: number, _options: Record<string, unknown> = {}): Promise<ChannelAuditLogsResult> {
  // In production, this would query from a database or log aggregation service
  // For now, return empty array as logs are written to stdout
  return {
    logs: [],
    total: 0,
    message: 'Audit logs are written to stdout in development. Query log aggregation service in production.'
  };
}

export {
  auditLogger,
  MODERATION_ACTIONS,
  ACCOUNT_ACTIONS,
  AUTH_ACTIONS,
  // Moderation logging
  logModeration,
  logUserBan,
  logUserUnban,
  logUserTimeout,
  logMessageDelete,
  logChatClear,
  logModeratorAdd,
  logModeratorRemove,
  // Account logging
  logAccountAction,
  logStreamKeyRegenerate,
  // Auth logging
  logAuthEvent,
  // Middleware
  auditContext,
  // Query
  getChannelAuditLogs
};

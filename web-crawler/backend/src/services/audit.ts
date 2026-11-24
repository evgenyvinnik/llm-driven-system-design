/**
 * @fileoverview Audit trail of operator actions (PostgreSQL `audit_log`).
 *
 * Every state-changing operator action - and every sign-in attempt - is
 * recorded with who did it, from where, what it targeted, and the relevant
 * details. The table is append-only (an UPDATE trigger rejects edits); rows
 * are removed only by the retention job.
 *
 * Writes are awaited but best-effort: the action they describe has already
 * happened, so a failed audit insert is logged at error level (and counted)
 * rather than turned into a failed request. A deployment that must never lose
 * an entry would write the audit row in the same transaction as the change,
 * or ship entries to an external append-only sink.
 *
 * Secrets never go into `details`: password changes are recorded as
 * `{ passwordReset: true }`, never the value.
 *
 * @module services/audit
 */

import type { Request } from 'express';
import { pool } from '../models/database.js';
import { logger } from '../shared/logger.js';

/** Every action the audit log knows about, grouped by prefix for filtering. */
export const AUDIT_ACTIONS = [
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.password.change',
  'auth.sessions.revoke_others',
  'user.create',
  'user.update',
  'user.delete',
  'user.sessions.revoke',
  'frontier.add',
  'frontier.seed',
  'frontier.recover',
  'frontier.clear',
  'stats.reset',
  'domain.settings.update',
  'domain.robots.refresh',
  'domain.reset',
  'pages.purge',
  'maintenance.cleanup',
  'ip_policy.refresh',
  'system.admin.bootstrap',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: number;
  at: Date;
  actorId: number | null;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}

let failedWrites = 0;
/** Number of audit inserts that failed since process start (exposed for monitoring). */
export function getFailedWriteCount(): number {
  return failedWrites;
}

/**
 * Records one audit entry. Never throws.
 */
export async function record(entry: {
  action: AuditAction;
  actor?: { id: number; username: string } | null;
  /** Used when there is no account (failed login): the attempted username */
  actorUsername?: string | null;
  targetType?: string;
  targetId?: string | number;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log
         (actor_id, actor_username, action, target_type, target_id, details, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.actor?.id ?? null,
        (entry.actor?.username ?? entry.actorUsername ?? null)?.slice(0, 64) ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId !== undefined ? String(entry.targetId) : null,
        JSON.stringify(entry.details ?? {}),
        entry.ip?.slice(0, 64) ?? null,
        entry.userAgent?.slice(0, 300) ?? null,
      ]
    );
  } catch (error) {
    failedWrites++;
    logger.error({ err: error, action: entry.action }, 'Audit write failed');
  }
}

/**
 * Convenience for route handlers: actor, IP and user agent come from the
 * request (`req.user` is set by requireAuth / requireRole).
 */
export function audit(
  req: Request,
  action: AuditAction,
  target?: { type: string; id: string | number },
  details?: Record<string, unknown>
): Promise<void> {
  return record({
    action,
    actor: req.user ? { id: req.user.id, username: req.user.username } : null,
    targetType: target?.type,
    targetId: target?.id,
    details,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });
}

/**
 * Lists entries newest first with keyset pagination (`before` = last id seen),
 * which stays correct while new entries are being appended - unlike OFFSET.
 *
 * @param action - Prefix filter, e.g. "user." or "auth.login"
 */
export async function list(options: {
  limit?: number;
  before?: number;
  action?: string;
  actor?: string;
}): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.before) where.push(`id < $${params.push(options.before)}`);
  if (options.action) where.push(`left(action, length($${params.push(options.action)})) = $${params.length}`);
  if (options.actor) where.push(`actor_username = $${params.push(options.actor.toLowerCase())}`);

  const result = await pool.query(
    `SELECT id, at, actor_id, actor_username, action, target_type, target_id, details, ip, user_agent
     FROM audit_log
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC
     LIMIT $${params.push(limit + 1)}`,
    params
  );

  const rows = result.rows.slice(0, limit);
  return {
    entries: rows.map((r) => ({
      id: Number(r.id),
      at: r.at,
      actorId: r.actor_id,
      actorUsername: r.actor_username,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: r.details ?? {},
      ip: r.ip,
      userAgent: r.user_agent,
    })),
    nextBefore: result.rows.length > limit ? Number(rows[rows.length - 1].id) : null,
  };
}

/**
 * Deletes entries older than `retentionDays` (run by the cleanup job).
 * @returns Number of rows deleted
 */
export async function prune(retentionDays: number): Promise<number> {
  const result = await pool.query(
    `DELETE FROM audit_log WHERE at < NOW() - ($1::int * INTERVAL '1 day')`,
    [retentionDays]
  );
  return result.rowCount ?? 0;
}

/**
 * Audit trail writer. Entries are appended in the same transaction as the
 * state change they describe; the table rejects UPDATE and DELETE.
 * @module store/audit
 */
import type { Queryable } from '../shared/db.js'

export interface AuditEntry {
  actor: string
  action: string
  accountId?: string | null
  controlId?: string | null
  campaignId?: string | null
  before?: unknown
  after?: unknown
  details?: Record<string, unknown>
}

export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, action, account_id, control_id, campaign_id, before, after, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.actor,
      e.action,
      e.accountId ?? null,
      e.controlId ?? null,
      e.campaignId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      JSON.stringify(e.details ?? {}),
    ],
  )
}

export async function notify(
  db: Queryable,
  n: { audience: 'owner' | 'security' | 'approver'; team?: string | null; kind: string; accountId?: string; controlId?: string; message: string; dueAt?: Date | null; dedupeKey?: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO notifications (audience, team, kind, account_id, control_id, message, due_at, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dedupe_key) DO NOTHING`,
    [n.audience, n.team ?? null, n.kind, n.accountId ?? null, n.controlId ?? null, n.message, n.dueAt ?? null, n.dedupeKey ?? null],
  )
  return (rowCount ?? 0) > 0
}

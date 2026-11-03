/**
 * Audit events are written inside the same transaction as the change they
 * describe, so an admin action and its record commit or roll back together.
 * @module shared/audit
 */
import type { Queryable } from './db.js'

export interface AuditInput {
  orgId: string
  actor: { id: string; displayName: string }
  action: string
  targetType: string
  targetId?: string | null
  targetName?: string | null
  before?: unknown
  after?: unknown
}

export async function writeAudit(db: Queryable, event: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (org_id, actor_id, actor_name, action, target_type, target_id, target_name, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.orgId,
      event.actor.id,
      event.actor.displayName,
      event.action,
      event.targetType,
      event.targetId ?? null,
      event.targetName ?? null,
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
    ],
  )
}

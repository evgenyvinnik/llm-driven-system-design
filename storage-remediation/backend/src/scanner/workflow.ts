/**
 * Owner workflow and exception lifecycle, run by one scanner at a time
 * (advisory lock):
 * - approved exceptions past expiry flip to expired and their findings reopen
 * - exceptions expiring within 7 days warn the owning team
 * - findings that need the owner (migration or missing evidence) produce one
 *   digest per team and control per day, with the earliest due date
 * - findings past due escalate to security and approvers
 * @module scanner/workflow
 */
import type { PoolClient } from 'pg'
import { getControl } from '../domain/controls.js'
import { pool } from '../shared/db.js'
import { audit, notify } from '../store/audit.js'

const WORKFLOW_LOCK = 0x5e_c0_01

export interface WorkflowStats {
  expired: number
  expiring: number
  digests: number
  escalations: number
}

export async function expireExceptions(db: PoolClient): Promise<number> {
  const { rows } = await db.query<{ id: string; account_id: string; control_id: string; owner: string | null; name: string }>(
    `UPDATE exceptions e SET status = 'expired' FROM storage_accounts a
      WHERE e.account_id = a.id AND e.status = 'approved' AND e.expires_at <= now()
      RETURNING e.id, e.account_id, e.control_id, a.owner, a.name`,
  )
  for (const e of rows) {
    await db.query(`UPDATE findings SET status = 'open' WHERE account_id = $1 AND control_id = $2 AND status = 'exempt'`, [e.account_id, e.control_id])
    await audit(db, { actor: 'service:scanner', action: 'exception.expired', accountId: e.account_id, controlId: e.control_id, details: { exceptionId: e.id } })
    await notify(db, {
      audience: 'owner',
      team: e.owner,
      kind: 'exception_expired',
      accountId: e.account_id,
      controlId: e.control_id,
      message: `Exception for ${e.control_id} on ${e.name} expired; the finding is open again.`,
      dedupeKey: `expired:${e.id}`,
    })
  }
  return rows.length
}

export async function runWorkflow(): Promise<WorkflowStats | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: lock } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [WORKFLOW_LOCK])
    if (!lock[0].ok) {
      await client.query('ROLLBACK')
      return null
    }
    const stats: WorkflowStats = { expired: await expireExceptions(client), expiring: 0, digests: 0, escalations: 0 }

    const { rows: expiring } = await client.query<{ id: string; control_id: string; account_id: string; owner: string | null; name: string; expires_at: Date }>(
      `SELECT e.id, e.control_id, e.account_id, a.owner, a.name, e.expires_at FROM exceptions e JOIN storage_accounts a ON a.id = e.account_id
        WHERE e.status = 'approved' AND e.expires_at > now() AND e.expires_at <= now() + interval '7 days'`,
    )
    for (const e of expiring) {
      const sent = await notify(client, {
        audience: 'owner',
        team: e.owner,
        kind: 'exception_expiring',
        accountId: e.account_id,
        controlId: e.control_id,
        message: `Exception for ${e.control_id} on ${e.name} expires ${e.expires_at.toISOString().slice(0, 16).replace('T', ' ')} UTC. Fix or renew before then.`,
        dueAt: e.expires_at,
        dedupeKey: `expiring:${e.id}`,
      })
      if (sent) stats.expiring++
    }

    const day = new Date().toISOString().slice(0, 10)
    const { rows: digests } = await client.query<{ owner: string | null; control_id: string; n: number; earliest: Date; migrate: number; insufficient: number }>(
      `SELECT a.owner, f.control_id, count(*)::int AS n, min(f.due_at) AS earliest,
              count(*) FILTER (WHERE f.evidence_class = 'needs_owner_migration')::int AS migrate,
              count(*) FILTER (WHERE f.evidence_class = 'insufficient_evidence')::int AS insufficient
         FROM findings f JOIN storage_accounts a ON a.id = f.account_id
        WHERE f.status = 'open' AND f.evidence_class IN ('needs_owner_migration', 'insufficient_evidence') AND a.deleted_at IS NULL
        GROUP BY a.owner, f.control_id`,
    )
    for (const d of digests) {
      const control = getControl(d.control_id)
      const sent = await notify(client, {
        audience: 'owner',
        team: d.owner,
        kind: 'action_required',
        controlId: d.control_id,
        message: `${d.n} account${d.n === 1 ? '' : 's'} need you for ${d.control_id} (${control.title}): ${d.migrate} have callers to migrate, ${d.insufficient} lack enough logs to prove it is safe.`,
        dueAt: d.earliest,
        dedupeKey: `digest:${d.owner ?? 'unowned'}:${d.control_id}:${day}`,
      })
      if (sent) stats.digests++
    }

    const { rows: overdue } = await client.query<{ owner: string | null; control_id: string; n: number }>(
      `SELECT a.owner, f.control_id, count(*)::int AS n FROM findings f JOIN storage_accounts a ON a.id = f.account_id
        WHERE f.status = 'open' AND f.due_at < now() AND a.deleted_at IS NULL GROUP BY a.owner, f.control_id`,
    )
    for (const o of overdue) {
      const sent = await notify(client, {
        audience: 'security',
        team: o.owner,
        kind: 'escalated',
        controlId: o.control_id,
        message: `${o.n} ${o.control_id} finding${o.n === 1 ? '' : 's'} owned by ${o.owner ?? 'nobody (no owner tag)'} are past due.`,
        dedupeKey: `escalation:${o.owner ?? 'unowned'}:${o.control_id}:${day}`,
      })
      if (sent) stats.escalations++
    }
    await client.query('COMMIT')
    return stats
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

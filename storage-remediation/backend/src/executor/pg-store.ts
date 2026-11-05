/**
 * PostgreSQL implementation of the target store. Every mutation is a single
 * conditional UPDATE keyed by (id, fence) and the expected state, so a stale
 * worker, a duplicate message or a concurrent executor changes nothing.
 * Audit entries are written in the same transaction as the transition.
 * @module executor/pg-store
 */
import type { MetricWindow } from '../domain/bake.js'
import type { EvidenceClass, Ring } from '../domain/types.js'
import { pool, withTransaction } from '../shared/db.js'
import { audit, notify } from '../store/audit.js'
import type { CampaignInfo, DeferKind, FinishState, TargetRow, TargetStore, WriteOutcome } from './types.js'

interface Row {
  id: number
  campaign_id: string
  account_id: string
  subscription_id: string
  wave_no: number
  state: TargetRow['state']
  attempts: number
  throttle_count: number
  planned_ring: Ring | null
  operation_id: string | null
  fence: number
  before_value: unknown
  etag_before: string | null
  after_value: unknown
  etag_after: string | null
  baseline: MetricWindow | null
  applied_at: Date | null
  bake_until: Date | null
  write_outcome: string | null
  rollback_reason: string | null
}

function toTarget(r: Row): TargetRow {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    accountId: r.account_id,
    subscriptionId: r.subscription_id,
    waveNo: r.wave_no,
    state: r.state,
    attempts: r.attempts,
    throttleCount: r.throttle_count,
    plannedRing: r.planned_ring ?? null,
    operationId: r.operation_id,
    fence: r.fence,
    beforeValue: r.before_value,
    etagBefore: r.etag_before,
    afterValue: r.after_value,
    etagAfter: r.etag_after,
    baseline: r.baseline,
    appliedAt: r.applied_at,
    bakeUntil: r.bake_until,
    writeOutcome: r.write_outcome,
    rollbackReason: r.rollback_reason,
  }
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))

/** RETURNING list for claims: the row plus the ring of the wave it was planned in. */
const RETURNING = `RETURNING campaign_targets.*, (SELECT w.ring FROM campaign_waves w WHERE w.campaign_id = campaign_targets.campaign_id AND w.wave_no = campaign_targets.wave_no) AS planned_ring`

export class PgTargetStore implements TargetStore {
  async claim(id: number, owner: string, leaseMs: number): Promise<TargetRow | null> {
    const { rows } = await pool.query<Row>(
      `UPDATE campaign_targets SET state = 'applying', claimed_by = $2, lease_until = now() + make_interval(secs => $3),
              fence = fence + 1, enqueued_at = NULL, updated_at = now()
        WHERE id = $1 AND ((state = 'queued' AND (not_before IS NULL OR not_before <= now())) OR (state = 'applying' AND lease_until < now()))
        ${RETURNING}`,
      [id, owner, leaseMs / 1000],
    )
    return rows[0] ? toTarget(rows[0]) : null
  }

  async campaign(id: string): Promise<CampaignInfo | null> {
    const { rows } = await pool.query<{ id: string; control_id: string; status: CampaignInfo['status']; bake: number; include: EvidenceClass[] | null }>(
      `SELECT id, control_id, status, (config->>'bakeSeconds')::int AS bake, config->'includeClasses' AS include FROM campaigns WHERE id = $1`,
      [id],
    )
    const r = rows[0]
    return r ? { id: r.id, controlId: r.control_id, status: r.status, bakeSeconds: r.bake, includeClasses: r.include ?? ['safe_to_fix'] } : null
  }

  async currentEvidence(accountId: string, controlId: string): Promise<EvidenceClass | null> {
    const { rows } = await pool.query<{ evidence_class: EvidenceClass | null }>('SELECT evidence_class FROM findings WHERE account_id = $1 AND control_id = $2', [accountId, controlId])
    return rows[0]?.evidence_class ?? null
  }

  async exceptionActive(accountId: string, controlId: string): Promise<boolean> {
    const { rowCount } = await pool.query(`SELECT 1 FROM exceptions WHERE account_id = $1 AND control_id = $2 AND status = 'approved' AND expires_at > now()`, [accountId, controlId])
    return (rowCount ?? 0) > 0
  }

  async recordIntent(t: TargetRow, intent: { beforeValue: unknown; etagBefore: string | null; baseline: MetricWindow; operationId: string }): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE campaign_targets SET before_value = $3, etag_before = $4, baseline = $5, operation_id = $6, updated_at = now()
        WHERE id = $1 AND fence = $2 AND state = 'applying' AND before_value IS NULL`,
      [t.id, t.fence, json(intent.beforeValue), intent.etagBefore, json(intent.baseline), intent.operationId],
    )
    return (rowCount ?? 0) > 0
  }

  async markApplied(t: TargetRow, r: { afterValue: unknown; etagAfter: string | null; outcome: WriteOutcome; bakeUntil: Date }, actor: string, controlId: string): Promise<boolean> {
    return withTransaction(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE campaign_targets SET state = 'baking', after_value = $3, etag_after = $4, write_outcome = $5, applied_at = now(), bake_until = $6,
                claimed_by = NULL, lease_until = NULL, last_error = NULL, updated_at = now()
          WHERE id = $1 AND fence = $2 AND state = 'applying'`,
        [t.id, t.fence, json(r.afterValue), r.etagAfter, r.outcome, r.bakeUntil],
      )
      if (!rowCount) return false
      await audit(c, {
        actor,
        action: r.outcome === 'written' ? 'remediation.applied' : `remediation.applied.${r.outcome}`,
        accountId: t.accountId,
        controlId,
        campaignId: t.campaignId,
        before: t.beforeValue,
        after: r.afterValue,
        details: { etagBefore: t.etagBefore, etagAfter: r.etagAfter, wave: t.waveNo, outcome: r.outcome, operationId: t.operationId },
      })
      return true
    })
  }

  async defer(t: TargetRow, notBefore: Date, reason: string, kind: DeferKind): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE campaign_targets SET state = 'queued', not_before = $3, last_error = $4,
              attempts = attempts + CASE WHEN $5 = 'error' THEN 1 ELSE 0 END,
              throttle_count = throttle_count + CASE WHEN $5 = 'throttle' THEN 1 ELSE 0 END,
              claimed_by = NULL, lease_until = NULL, enqueued_at = NULL, updated_at = now()
        WHERE id = $1 AND fence = $2 AND state = 'applying'`,
      [t.id, t.fence, notBefore, reason, kind],
    )
    return (rowCount ?? 0) > 0
  }

  async release(t: TargetRow): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE campaign_targets SET state = 'queued', claimed_by = NULL, lease_until = NULL, enqueued_at = NULL, updated_at = now()
        WHERE id = $1 AND fence = $2 AND state = 'applying'`,
      [t.id, t.fence],
    )
    return (rowCount ?? 0) > 0
  }

  async finish(t: TargetRow, state: FinishState, reason: string, actor: string, controlId: string): Promise<boolean> {
    return withTransaction(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE campaign_targets SET state = $3, last_error = $4, finished_at = now(), claimed_by = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND fence = $2 AND state IN ('applying', 'baking', 'rolling_back')`,
        [t.id, t.fence, state, reason],
      )
      if (!rowCount) return false
      if (state !== 'cancelled') {
        await audit(c, { actor, action: `remediation.${state}`, accountId: t.accountId, controlId, campaignId: t.campaignId, details: { reason, wave: t.waveNo, operationId: t.operationId } })
      }
      if (state === 'escalated' || reason.startsWith('ROLLBACK')) {
        await notify(c, { audience: 'security', kind: state === 'escalated' ? 'escalated_target' : 'rollback_failed', accountId: t.accountId, controlId, message: `${controlId} on ${t.accountId.split('/').pop()}: ${reason}`, dedupeKey: `${state}:${t.id}` })
      }
      return true
    })
  }

  async claimBaking(owner: string, leaseMs: number, limit: number): Promise<TargetRow[]> {
    const { rows } = await pool.query<Row>(
      `WITH due AS (
         SELECT id FROM campaign_targets
          WHERE state IN ('baking', 'rolling_back') AND (lease_until IS NULL OR lease_until < now())
          ORDER BY state DESC, updated_at LIMIT $3 FOR UPDATE SKIP LOCKED)
       UPDATE campaign_targets t SET claimed_by = $1, lease_until = now() + make_interval(secs => $2), fence = t.fence + 1
         FROM due WHERE t.id = due.id RETURNING t.*, NULL::text AS planned_ring`,
      [owner, leaseMs / 1000, limit],
    )
    return rows.map(toTarget)
  }

  async releaseBaking(t: TargetRow, countAttempt = false): Promise<void> {
    await pool.query(`UPDATE campaign_targets SET claimed_by = NULL, lease_until = NULL, attempts = attempts + CASE WHEN $3 THEN 1 ELSE 0 END WHERE id = $1 AND fence = $2`, [t.id, t.fence, countAttempt])
  }

  async startRollback(t: TargetRow, reason: string, actor: string, controlId: string): Promise<boolean> {
    return withTransaction(async (c) => {
      const { rows } = await c.query<{ owner: string | null; name: string }>(
        `UPDATE campaign_targets t SET state = 'rolling_back', rollback_reason = $3, updated_at = now() FROM storage_accounts a
          WHERE t.id = $1 AND t.fence = $2 AND t.state = 'baking' AND a.id = t.account_id RETURNING a.owner, a.name`,
        [t.id, t.fence, reason],
      )
      if (rows.length === 0) return false
      // The logs were wrong about this account: refresh its evidence so it is reclassified.
      await c.query('UPDATE usage_evidence SET stale = true WHERE account_id = $1', [t.accountId])
      await audit(c, { actor, action: 'remediation.rollback_triggered', accountId: t.accountId, controlId, campaignId: t.campaignId, details: { reason, wave: t.waveNo } })
      const message = `${controlId} change on ${rows[0].name} caused ${reason}; rolled back automatically.`
      await notify(c, { audience: 'owner', team: rows[0].owner, kind: 'rollback', accountId: t.accountId, controlId, message, dedupeKey: `rollback:${t.id}` })
      await notify(c, { audience: 'security', team: rows[0].owner, kind: 'rollback', accountId: t.accountId, controlId, message, dedupeKey: `rollback-sec:${t.id}` })
      return true
    })
  }

  async markRolledBack(t: TargetRow, r: { restoredValue: unknown; etagAfter: string | null; outcome: 'written' | 'already_restored' }, actor: string, controlId: string): Promise<boolean> {
    return withTransaction(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE campaign_targets SET state = 'rolled_back', etag_after = $3, finished_at = now(), claimed_by = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND fence = $2 AND state = 'rolling_back'`,
        [t.id, t.fence, r.etagAfter],
      )
      if (!rowCount) return false
      await audit(c, {
        actor,
        action: 'remediation.rolled_back',
        accountId: t.accountId,
        controlId,
        campaignId: t.campaignId,
        before: t.afterValue,
        after: r.restoredValue,
        details: { reason: t.rollbackReason, outcome: r.outcome, wave: t.waveNo },
      })
      return true
    })
  }

  async markVerified(t: TargetRow, actor: string, controlId: string): Promise<boolean> {
    return withTransaction(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE campaign_targets SET state = 'verified', finished_at = now(), claimed_by = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND fence = $2 AND state = 'baking'`,
        [t.id, t.fence],
      )
      if (!rowCount) return false
      await audit(c, { actor, action: 'remediation.verified', accountId: t.accountId, controlId, campaignId: t.campaignId, details: { wave: t.waveNo } })
      return true
    })
  }
}

/**
 * Campaign coordinator: moves each running campaign through its waves, and
 * the reconciler that makes the queue self-healing.
 *
 * Per tick and campaign (row locked with SKIP LOCKED, so one executor
 * coordinates a campaign at a time):
 * - no unfinished wave → campaign completed
 * - wave failures (rolled back + failed, minus those a human acknowledged)
 *   above the budget → campaign auto-paused, wave halted
 * - wave pending (or halted and resumed) → start it: targets pending → queued, enqueue
 * - every target terminal → wave completed; the next wave starts next tick
 * @module executor/coordinator
 */
import { pool, withTransaction } from '../shared/db.js'
import { audit, notify } from '../store/audit.js'
import type { TaskQueue } from './queue.js'
import type { CampaignEvent } from './types.js'

export interface CoordinatorDeps {
  queue: TaskQueue
  events: (campaignId: string, event: CampaignEvent) => Promise<void>
  instanceId: string
  requeueAfterMs: number
}

export function waveOverBudget(failures: number, acknowledged: number, maxFailures: number): boolean {
  return failures - acknowledged > maxFailures
}

async function advanceCampaign(deps: CoordinatorDeps, campaignId: string): Promise<void> {
  const toEnqueue: number[] = []
  const events: CampaignEvent[] = []
  await withTransaction(async (c) => {
    const { rows: camps } = await c.query<{ id: string; status: string; control_id: string; name: string; config: { maxFailuresPerWave: number } }>(
      `SELECT id, status, control_id, name, config FROM campaigns WHERE id = $1 FOR UPDATE SKIP LOCKED`,
      [campaignId],
    )
    const camp = camps[0]
    if (!camp || camp.status !== 'running') return
    const { rows: waves } = await c.query<{ wave_no: number; status: string; label: string; acknowledged_failures: number }>(
      `SELECT wave_no, status, label, acknowledged_failures FROM campaign_waves WHERE campaign_id = $1 ORDER BY wave_no`,
      [campaignId],
    )
    const wave = waves.find((w) => w.status !== 'completed')
    const actor = `service:${deps.instanceId}`
    if (!wave) {
      await c.query(`UPDATE campaigns SET status = 'completed', finished_at = now(), updated_at = now() WHERE id = $1`, [campaignId])
      await audit(c, { actor, action: 'campaign.completed', campaignId, controlId: camp.control_id })
      events.push({ type: 'campaign.completed' })
      return
    }
    const { rows: counts } = await c.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM campaign_targets WHERE campaign_id = $1 AND wave_no = $2 GROUP BY state`,
      [campaignId, wave.wave_no],
    )
    const count = (s: string) => counts.find((r) => r.state === s)?.n ?? 0
    const failures = count('rolled_back') + count('failed')
    const max = camp.config.maxFailuresPerWave ?? 0
    if (waveOverBudget(failures, wave.acknowledged_failures, max)) {
      const reason = `Wave ${wave.wave_no} (${wave.label}): ${failures - wave.acknowledged_failures} failure(s) exceeded the budget of ${max}. Review rollbacks, then resume or kill.`
      await c.query(`UPDATE campaigns SET status = 'paused', status_reason = $2, updated_at = now() WHERE id = $1`, [campaignId, reason])
      await c.query(`UPDATE campaign_waves SET status = 'halted' WHERE campaign_id = $1 AND wave_no = $2`, [campaignId, wave.wave_no])
      await audit(c, { actor, action: 'campaign.auto_paused', campaignId, controlId: camp.control_id, details: { reason, wave: wave.wave_no, failures } })
      await notify(c, { audience: 'security', kind: 'campaign_paused', controlId: camp.control_id, message: `Campaign "${camp.name}" paused itself. ${reason}`, dedupeKey: `paused:${campaignId}:${wave.wave_no}:${failures}` })
      events.push({ type: 'campaign.paused', waveNo: wave.wave_no, message: reason })
      return
    }
    if (wave.status === 'pending' || wave.status === 'halted') {
      await c.query(`UPDATE campaign_waves SET status = 'running', started_at = COALESCE(started_at, now()) WHERE campaign_id = $1 AND wave_no = $2`, [campaignId, wave.wave_no])
      const { rows } = await c.query<{ id: number }>(
        `UPDATE campaign_targets SET state = 'queued', enqueued_at = now(), updated_at = now()
          WHERE campaign_id = $1 AND wave_no = $2 AND state = 'pending' RETURNING id`,
        [campaignId, wave.wave_no],
      )
      toEnqueue.push(...rows.map((r) => r.id))
      if (wave.status === 'pending') events.push({ type: 'wave.started', waveNo: wave.wave_no, message: `${wave.label}: ${rows.length} accounts` })
      return
    }
    const active = count('pending') + count('queued') + count('applying') + count('baking') + count('rolling_back')
    if (active === 0) {
      await c.query(`UPDATE campaign_waves SET status = 'completed', finished_at = now() WHERE campaign_id = $1 AND wave_no = $2`, [campaignId, wave.wave_no])
      events.push({ type: 'wave.completed', waveNo: wave.wave_no, message: `${wave.label}: ${count('verified')} verified, ${count('rolled_back')} rolled back, ${count('failed')} failed, ${count('skipped')} skipped` })
    }
  })
  // Enqueue after commit. If we crash in between, the reconciler re-sends them.
  await deps.queue.enqueue(toEnqueue)
  for (const e of events) await deps.events(campaignId, e)
}

/** Re-sends work the stream may have lost: expired claims and queued targets nobody picked up. */
export async function reconcile(deps: CoordinatorDeps): Promise<number> {
  await pool.query(
    `UPDATE campaign_targets SET state = 'queued', claimed_by = NULL, lease_until = NULL, enqueued_at = NULL,
            last_error = 'Lease expired (executor lost mid-step); resuming from recorded intent', updated_at = now()
      WHERE state = 'applying' AND lease_until < now()`,
  )
  const { rows } = await pool.query<{ id: number }>(
    `WITH due AS (
       SELECT t.id FROM campaign_targets t JOIN campaigns c ON c.id = t.campaign_id
        WHERE c.status = 'running' AND t.state = 'queued' AND (t.not_before IS NULL OR t.not_before <= now())
          AND (t.enqueued_at IS NULL OR t.enqueued_at < now() - make_interval(secs => $1))
        ORDER BY t.id LIMIT 1000 FOR UPDATE OF t SKIP LOCKED)
     UPDATE campaign_targets t SET enqueued_at = now() FROM due WHERE t.id = due.id RETURNING t.id`,
    [deps.requeueAfterMs / 1000],
  )
  await deps.queue.enqueue(rows.map((r) => r.id))
  return rows.length
}

export async function coordinate(deps: CoordinatorDeps): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM campaigns WHERE status = 'running' ORDER BY created_at`)
  for (const { id } of rows) await advanceCampaign(deps, id)
  await reconcile(deps)
}

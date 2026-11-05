/**
 * Campaign planning and creation. A campaign freezes its target list at
 * creation (the plan the human approved), then the executor re-checks each
 * target right before writing: exceptions granted since, accounts fixed by
 * someone else, accounts that vanished.
 */
import { z } from 'zod'
import { getControl } from '../../domain/controls.js'
import { ringOf, type EvidenceClass } from '../../domain/types.js'
import { planWaves, type PlanCandidate, type WavePlan } from '../../domain/waves.js'
import type { SessionUser } from '../../shared/auth.js'
import { withTransaction, type Queryable } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { audit } from '../../store/audit.js'

const evidenceClasses = ['safe_to_fix', 'needs_owner_migration', 'insufficient_evidence'] as const

export const campaignInputSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    controlId: z.string(),
    scope: z
      .object({
        environments: z.array(z.string()).max(20).optional(),
        subscriptionIds: z.array(z.string()).max(500).optional(),
        owners: z.array(z.string()).max(100).optional(),
      })
      .strict()
      .default({}),
    canaryPercent: z.number().min(1).max(100).default(5),
    growthFactor: z.number().min(1.5).max(10).default(4),
    maxWaveSize: z.number().int().min(1).max(2000).default(400),
    includeClasses: z.array(z.enum(evidenceClasses)).min(1).default(['safe_to_fix']),
    bakeSeconds: z.number().int().min(5).max(86_400).default(20),
    maxFailuresPerWave: z.number().int().min(0).max(1000).default(1),
  })
  .strict()

export type CampaignInput = z.infer<typeof campaignInputSchema>

export interface PlanSummary {
  eligible: number
  waves: { waveNo: number; ring: string; label: string; size: number }[]
  excluded: Record<string, number>
}

async function loadCandidates(db: Queryable, input: CampaignInput, accountIds?: string[]): Promise<{ candidates: PlanCandidate[]; busy: string[] }> {
  const { rows } = await db.query<{ account_id: string; subscription_id: string; environment: string; evidence_class: EvidenceClass | null; status: string; traffic: number; risk_score: number; busy: boolean }>(
    `SELECT f.account_id, a.subscription_id, a.environment, f.evidence_class, f.status, a.traffic_per_min::float AS traffic, f.risk_score,
            EXISTS (SELECT 1 FROM campaign_targets t JOIN campaigns c ON c.id = t.campaign_id
                     WHERE t.account_id = f.account_id AND c.control_id = f.control_id AND c.status IN ('draft', 'running', 'paused')
                       AND t.state IN ('pending', 'queued', 'applying', 'baking', 'rolling_back')) AS busy
       FROM findings f JOIN storage_accounts a ON a.id = f.account_id
      WHERE f.control_id = $1 AND f.status IN ('open', 'exempt') AND a.deleted_at IS NULL
        AND ($2::text[] IS NULL OR a.environment = ANY($2))
        AND ($3::text[] IS NULL OR a.subscription_id = ANY($3))
        AND ($4::text[] IS NULL OR a.owner = ANY($4))
        AND ($5::text[] IS NULL OR a.id = ANY($5))`,
    [input.controlId, input.scope.environments ?? null, input.scope.subscriptionIds ?? null, input.scope.owners ?? null, accountIds ?? null],
  )
  const busy = rows.filter((r) => r.busy).map((r) => r.account_id)
  const candidates = rows
    .filter((r) => !r.busy)
    .map((r) => ({ accountId: r.account_id, subscriptionId: r.subscription_id, ring: ringOf(r.environment), evidenceClass: r.evidence_class, exempt: r.status === 'exempt', traffic: Number(r.traffic), riskScore: r.risk_score }))
  return { candidates, busy }
}

export function summarize(plan: WavePlan, busy: number): PlanSummary {
  const excluded: Record<string, number> = {}
  for (const e of plan.excluded) excluded[e.reason] = (excluded[e.reason] ?? 0) + 1
  if (busy > 0) excluded.in_other_campaign = busy
  return {
    eligible: plan.waves.reduce((n, w) => n + w.accountIds.length, 0),
    waves: plan.waves.map((w) => ({ waveNo: w.waveNo, ring: w.ring, label: w.label, size: w.accountIds.length })),
    excluded,
  }
}

export async function previewPlan(db: Queryable, input: CampaignInput): Promise<PlanSummary> {
  getControl(input.controlId)
  const { candidates, busy } = await loadCandidates(db, input)
  return summarize(planWaves(candidates, input), busy.length)
}

export interface CreateOptions {
  idempotencyKey?: string
  selfService?: boolean
  accountIds?: string[]
  start?: boolean
}

export async function createCampaign(db: Queryable, input: CampaignInput, user: SessionUser, opts: CreateOptions = {}): Promise<{ campaignId: string; plan: PlanSummary; replayed: boolean }> {
  const control = getControl(input.controlId)
  if (opts.idempotencyKey) {
    const { rows } = await db.query<{ id: string; plan_summary: PlanSummary }>('SELECT id, plan_summary FROM campaigns WHERE idempotency_key = $1', [opts.idempotencyKey])
    if (rows[0]) return { campaignId: rows[0].id, plan: rows[0].plan_summary, replayed: true }
  }
  return withTransaction(async (c) => {
    const { candidates, busy } = await loadCandidates(c, input, opts.accountIds)
    const plan = planWaves(candidates, input)
    const summary = summarize(plan, busy.length)
    if (summary.eligible === 0) throw new HttpError(409, 'NO_ELIGIBLE_TARGETS', 'No accounts match this campaign after exclusions', summary)
    const id = newId('cmp')
    const status = opts.start ? 'running' : 'draft'
    try {
      await c.query(
        `INSERT INTO campaigns (id, name, control_id, status, config, plan_summary, self_service, created_by, idempotency_key, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, input.name, control.id, status, JSON.stringify(input), JSON.stringify(summary), opts.selfService ?? false, user.id, opts.idempotencyKey ?? null, opts.start ? new Date() : null],
      )
    } catch (err) {
      // Two concurrent requests with the same key: the loser returns the winner's campaign.
      if ((err as { code?: string }).code === '23505' && opts.idempotencyKey) throw new HttpError(409, 'DUPLICATE_REQUEST', 'A campaign with this idempotency key is being created; retry')
      throw err
    }
    const bySub = new Map(candidates.map((x) => [x.accountId, x.subscriptionId]))
    for (const w of plan.waves) {
      await c.query(`INSERT INTO campaign_waves (campaign_id, wave_no, ring, label, status, target_count) VALUES ($1, $2, $3, $4, 'pending', $5)`, [id, w.waveNo, w.ring, w.label, w.accountIds.length])
      await c.query(
        `INSERT INTO campaign_targets (campaign_id, account_id, subscription_id, wave_no, state)
         SELECT $1, x.account_id, x.subscription_id, $2, 'pending' FROM jsonb_to_recordset($3::jsonb) AS x(account_id text, subscription_id text)`,
        [id, w.waveNo, JSON.stringify(w.accountIds.map((a) => ({ account_id: a, subscription_id: bySub.get(a) })))],
      )
    }
    await audit(c, {
      actor: `user:${user.username}`,
      action: opts.selfService ? 'campaign.self_service' : 'campaign.created',
      campaignId: id,
      controlId: control.id,
      accountId: opts.accountIds?.length === 1 ? opts.accountIds[0] : null,
      details: { name: input.name, plan: summary, config: input },
    })
    return { campaignId: id, plan: summary, replayed: false }
  })
}

/**
 * Account detail (config, findings, usage evidence, change history) and the
 * owner's self-service "fix it now", which runs through the same executor
 * path as any campaign: intent, If-Match write, bake, automatic rollback.
 */
import { Router } from 'express'
import { z } from 'zod'
import { CONTROLS, getControl, propsFor } from '../../domain/controls.js'
import type { AccountSnapshot } from '../../domain/types.js'
import { requireAuth, type SessionUser } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { createCampaign } from '../services/campaigns.js'

export const accountsRouter = Router()

export async function loadAccountForUser(name: string, user: SessionUser) {
  const { rows } = await pool.query(
    `SELECT a.*, s.display_name AS subscription_name, s.management_group FROM storage_accounts a
       LEFT JOIN subscriptions s ON s.subscription_id = a.subscription_id WHERE a.name = $1`,
    [name],
  )
  const account = rows[0]
  if (!account) throw notFound('Storage account')
  if (user.role === 'owner' && account.owner !== user.team) throw new HttpError(403, 'NOT_YOUR_ACCOUNT', 'This account belongs to another team')
  return account
}

accountsRouter.get(
  '/:name',
  requireAuth,
  asyncHandler(async (req, res) => {
    const a = await loadAccountForUser(req.params.name, req.user!)
    const [findings, evidence, history, targets, exceptions] = await Promise.all([
      pool.query('SELECT * FROM findings WHERE account_id = $1 ORDER BY control_id', [a.id]),
      pool.query('SELECT * FROM usage_evidence WHERE account_id = $1', [a.id]),
      pool.query('SELECT * FROM audit_log WHERE account_id = $1 ORDER BY at DESC LIMIT 50', [a.id]),
      pool.query(
        `SELECT t.*, c.name AS campaign_name, c.control_id FROM campaign_targets t JOIN campaigns c ON c.id = t.campaign_id
          WHERE t.account_id = $1 ORDER BY t.updated_at DESC LIMIT 20`,
        [a.id],
      ),
      pool.query(`SELECT e.*, u.display_name AS requested_by_name FROM exceptions e JOIN users u ON u.id = e.requested_by WHERE e.account_id = $1 ORDER BY e.created_at DESC`, [a.id]),
    ])
    const snapshot: AccountSnapshot = { id: a.id, subscriptionId: a.subscription_id, resourceGroup: a.resource_group, name: a.name, location: a.location, tags: a.tags, properties: a.properties, blobService: a.blob_service, diagnostics: a.diagnostics }
    const e = evidence.rows[0]
    res.json({
      account: {
        id: a.id,
        name: a.name,
        subscriptionId: a.subscription_id,
        subscriptionName: a.subscription_name,
        managementGroup: a.management_group,
        resourceGroup: a.resource_group,
        location: a.location,
        tags: a.tags,
        owner: a.owner,
        ownerSource: a.owner_source,
        environment: a.environment,
        dataClassification: a.data_classification,
        properties: a.properties,
        blobService: a.blob_service,
        diagnostics: a.diagnostics,
        observedVia: a.observed_via,
        observedAt: a.observed_at,
        propertiesModifiedAt: a.properties_modified_at,
        trafficPerMin: Number(a.traffic_per_min),
      },
      controls: CONTROLS.map((c) => {
        const props = propsFor(snapshot, c.kind)
        const current = props ? c.read(props) : null
        const finding = findings.rows.find((f) => f.control_id === c.id)
        return {
          controlId: c.id,
          title: c.title,
          property: c.property,
          desired: c.desiredLabel,
          current,
          compliant: props ? c.isCompliant(current) : null,
          breaking: c.breaking,
          finding: finding
            ? { id: finding.id, status: finding.status, severity: finding.severity, riskScore: finding.risk_score, evidenceClass: finding.evidence_class, evidenceReason: finding.evidence_reason, dueAt: finding.due_at, firstSeenAt: finding.first_seen_at, reopenedCount: finding.reopened_count }
            : null,
        }
      }),
      evidence: e ? { computedAt: e.computed_at, lookbackDays: e.lookback_days, windowDays: e.window_days, hasLogs: e.has_logs, counts: e.counts, callers: e.callers, stale: e.stale } : null,
      history: history.rows.map((h) => ({ id: h.id, at: h.at, actor: h.actor, action: h.action, controlId: h.control_id, campaignId: h.campaign_id, before: h.before, after: h.after, details: h.details })),
      targets: targets.rows.map((t) => ({ id: t.id, campaignId: t.campaign_id, campaignName: t.campaign_name, controlId: t.control_id, state: t.state, waveNo: t.wave_no, writeOutcome: t.write_outcome, appliedAt: t.applied_at, rollbackReason: t.rollback_reason, lastError: t.last_error })),
      exceptions: exceptions.rows.map((x) => ({ id: x.id, controlId: x.control_id, status: x.status, justification: x.justification, requestedByName: x.requested_by_name, expiresAt: x.expires_at, createdAt: x.created_at })),
    })
  }),
)

accountsRouter.post(
  '/:name/fix',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    if (user.role === 'approver') throw new HttpError(403, 'FORBIDDEN', 'Approvers cannot change resources')
    const { controlId } = z.object({ controlId: z.string() }).strict().parse(req.body)
    const control = getControl(controlId)
    const a = await loadAccountForUser(req.params.name, user)
    const { rows } = await pool.query(`SELECT status FROM findings WHERE account_id = $1 AND control_id = $2`, [a.id, controlId])
    if (rows[0]?.status !== 'open') throw new HttpError(409, 'NOTHING_TO_FIX', `No open ${controlId} finding on ${a.name}`)
    const result = await createCampaign(
      pool,
      {
        name: `Self-service: ${control.id} on ${a.name}`,
        controlId,
        scope: {},
        canaryPercent: 100,
        growthFactor: 4,
        maxWaveSize: 1,
        includeClasses: ['safe_to_fix', 'needs_owner_migration', 'insufficient_evidence'],
        bakeSeconds: 20,
        maxFailuresPerWave: 0,
      },
      user,
      { accountIds: [a.id], selfService: true, start: true, idempotencyKey: req.header('idempotency-key') ?? undefined },
    )
    res.status(result.replayed ? 200 : 201).json(result)
  }),
)

/**
 * The webhook receiver's logic. A delivery is recorded in the same transaction as
 * its effects: a duplicate after success changes nothing, and a retry after a
 * failure runs again from clean. Signature and replay checks happen first, on the
 * raw bytes, before anything is parsed.
 * @module api/services/deliveries
 */
import type { PoolClient } from 'pg'
import { appendAudit } from '../../shared/audit.js'
import { config } from '../../shared/config.js'
import { withTransaction } from '../../shared/db.js'
import type { HostPull } from '../../shared/host-types.js'
import { webhooksReceived } from '../../shared/metrics.js'
import { loadRepoByName, type RepoRow } from '../../shared/repos.js'
import { isBot, requestReevaluation, syncPullRequest } from '../../shared/review-state.js'
import type { PrRow } from '../../shared/rows.js'
import { verifySignature } from '../../shared/webhook-signature.js'

export interface DeliveryArgs {
  deliveryId?: string
  event?: string
  signature?: string
  rawBody: Buffer | string
  now?: number
}

export interface DeliveryResponse {
  status: number
  body: Record<string, unknown>
}

interface WebhookPayload {
  action?: string
  repository?: { full_name?: string }
  pull_request?: HostPull
  check_suite?: { head_sha: string; conclusion: string; pull_requests: { number: number }[] }
  review?: { id: number; user: { login: string }; state: string; commit_id: string }
}

async function lockPull(tx: PoolClient, repoId: string, number: number): Promise<PrRow | null> {
  const res = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2 FOR UPDATE`, [repoId, number])
  return res.rows[0] ?? null
}

async function onCheckSuite(tx: PoolClient, repo: RepoRow, p: WebhookPayload): Promise<string> {
  const suite = p.check_suite
  if (!suite) return 'malformed'
  let outcome = 'stale_sha'
  for (const { number } of suite.pull_requests) {
    const pr = await lockPull(tx, repo.id, number)
    // A result for an older commit says nothing about this one.
    if (!pr || pr.head_sha !== suite.head_sha) continue
    await appendAudit(tx, { repoId: repo.id, kind: 'ci_reported', actor: 'webhook', prNumber: number, headSha: suite.head_sha, payload: { conclusion: suite.conclusion } })
    await requestReevaluation(tx, repo, pr, 'check_suite', 'webhook')
    outcome = 'applied'
  }
  return outcome
}

async function onReview(tx: PoolClient, repo: RepoRow, p: WebhookPayload): Promise<string> {
  const review = p.review
  const number = p.pull_request?.number
  if (!review || !number) return 'malformed'
  // The bot's own review coming back must not trigger more work.
  if (isBot(repo, review.user.login)) return 'own_review'
  const pr = await lockPull(tx, repo.id, number)
  if (!pr) return 'unknown_pr'
  await appendAudit(tx, { repoId: repo.id, kind: 'human_review_observed', actor: review.user.login, prNumber: number, headSha: review.commit_id, payload: { state: review.state, action: p.action, reviewId: review.id } })
  if (p.action === 'submitted' && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')) {
    await tx.query(`UPDATE decisions SET human_outcome = $3 WHERE pr_id = $1 AND head_sha = $2 AND outcome = 'shadow'`, [pr.id, review.commit_id, review.state === 'APPROVED' ? 'approved' : 'changes_requested'])
  }
  await requestReevaluation(tx, repo, pr, 'review', 'webhook')
  return 'applied'
}

export async function processDelivery(args: DeliveryArgs): Promise<DeliveryResponse> {
  const event = args.event ?? 'unknown'
  const verified = verifySignature(args.signature, args.rawBody, config.webhookSecret, config.webhookToleranceSeconds, args.now)
  if (!verified.ok) {
    webhooksReceived.inc({ event, outcome: verified.reason === 'replay' ? 'replay' : 'bad_signature' })
    if (verified.reason === 'replay') return { status: 400, body: { error: { code: 'REPLAY', message: 'The signature timestamp is outside the allowed window' } } }
    return { status: 401, body: { error: { code: 'BAD_SIGNATURE', message: 'The signature is missing or does not verify' } } }
  }
  if (!args.deliveryId) return { status: 400, body: { error: { code: 'NO_DELIVERY_ID', message: 'A delivery id is required' } } }

  let payload: WebhookPayload
  try {
    payload = JSON.parse(args.rawBody.toString()) as WebhookPayload
  } catch {
    return { status: 400, body: { error: { code: 'INVALID_JSON', message: 'The body is not JSON' } } }
  }

  const deliveryId = args.deliveryId
  const result = await withTransaction(async (tx) => {
    const fullName = payload.repository?.full_name ?? null
    const claim = await tx.query(
      `INSERT INTO webhook_deliveries (delivery_id, event, action, repo, pr_number, head_sha, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,'processing') ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, event, payload.action ?? null, fullName, payload.pull_request?.number ?? null, payload.pull_request?.head.sha ?? payload.check_suite?.head_sha ?? null],
    )
    if (claim.rowCount === 0) return { duplicate: true, outcome: 'duplicate' }

    const repo = fullName ? await loadRepoByName(tx, fullName) : null
    let outcome = 'ignored_unknown_repo'
    if (repo) {
      if (event === 'pull_request' && payload.pull_request) outcome = await syncPullRequest(tx, repo, payload.pull_request, 'webhook')
      else if (event === 'check_suite') outcome = await onCheckSuite(tx, repo, payload)
      else if (event === 'pull_request_review') outcome = await onReview(tx, repo, payload)
      else outcome = 'ignored_event'
    }
    await tx.query(`UPDATE webhook_deliveries SET outcome = $2 WHERE delivery_id = $1`, [deliveryId, outcome])
    return { duplicate: false, outcome }
  })
  webhooksReceived.inc({ event, outcome: result.outcome })
  return { status: 200, body: { received: true, deliveryId, ...result } }
}

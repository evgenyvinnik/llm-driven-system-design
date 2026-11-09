/**
 * One review run, from claim to decision.
 *
 *   read facts → build prompt → model (with allowlisted tools) → strict parse
 *   → scan → read facts again → gate → decide → fenced write
 *
 * Failures of the model become a decision to escalate, never an approval and
 * never a silently stuck run. Nothing here can post: this process holds a
 * read-only credential, and all it can do is leave an intent for the poster.
 * @module worker/pipeline
 */
import type { PoolClient } from 'pg'
import { appendAudit, sanitizeForStorage } from '../shared/audit.js'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { toGateFacts } from '../shared/facts.js'
import { decide, type DecisionResult, type ModelSignal } from '../shared/gate/decide.js'
import { evaluateGate, withinSizeLimits } from '../shared/gate/rules.js'
import type { GateResult } from '../shared/gate/types.js'
import { HostUnavailable, type HostReader, type PullSnapshot } from '../shared/host-types.js'
import { logger } from '../shared/logger.js'
import { decisionsMade, modelLatency, modelOverrules, runsFinished, toolRequests } from '../shared/metrics.js'
import { parseModelOutput, type ModelOutput } from '../shared/model-output.js'
import { ModelCallError, type ModelCaller } from '../shared/model-types.js'
import { loadRepo, policyOf, type RepoRow } from '../shared/repos.js'
import { recordDecision, signalOf, syncPullRequest } from '../shared/review-state.js'
import type { DecisionRow, PrRow, RunRow } from '../shared/rows.js'
import { scanForInjection, type ScanHit, type ScanInput } from '../shared/scanner.js'
import { runConversation } from './conversation.js'
import { buildPrompt, newNonce } from './prompt.js'
import type { ToolRecord } from './tools.js'

export interface PipelineDeps {
  reader: HostReader
  caller: ModelCaller
  actor?: string
  /** A nonce override for deterministic replays. */
  nonce?: string
}

export type RunEnd = 'completed' | 'failed' | 'cancelled' | 'fenced' | 'retry_later'

class FencedOut extends Error {}

/** What the model contributed: one signal, however it was obtained. */
export interface ModelContribution {
  signal: ModelSignal
  output: ModelOutput | null
  raw: string | null
  tools: ToolRecord[]
  scannerHits: ScanHit[]
  modelVersion: string
  outcome: string
  usage: { inputTokens: number; outputTokens: number; ttftMs: number | null; generationMs: number | null; calls: number }
}

export function scanInputs(s: PullSnapshot, tools: ToolRecord[]): ScanInput[] {
  return [
    { source: 'title', text: s.pull.title },
    { source: 'body', text: s.pull.body },
    { source: 'diff', text: s.files.map((f) => f.patch ?? '').join('\n') },
    { source: 'comment', text: s.comments.map((c) => c.body).join('\n') },
    ...tools.filter((t) => t.allowed).map((t) => ({ source: 'tool_result' as const, text: t.result })),
  ]
}

function failureSignal(err: ModelCallError): ModelSignal {
  if (err.code === 'timeout') return { kind: 'failure', code: 'model_timeout', detail: err.message }
  return { kind: 'failure', code: 'model_unavailable', detail: err.message }
}

async function callModel(deps: PipelineDeps, repo: RepoRow, run: RunRow, snapshot: PullSnapshot, signal: AbortSignal): Promise<ModelContribution> {
  const built = buildPrompt(snapshot, repo.model_version, deps.nonce ?? newNonce())
  const fenceOk = await pool.query(`UPDATE review_runs SET diff_hash = $3, prompt_hash = $4, prompt_text = $5, files_snapshot = $6, model_version = $7 WHERE id = $1 AND lease_token = $2`, [
    run.id,
    run.lease_token,
    built.diffHash,
    built.promptHash,
    sanitizeForStorage(built.promptText.slice(0, 200_000)),
    JSON.stringify(sanitizeForStorage(snapshot.files.slice(0, 400))),
    repo.model_version,
  ])
  if (!fenceOk.rowCount) throw new FencedOut()
  await withTransaction((tx) =>
    appendAudit(tx, {
      repoId: repo.id,
      kind: 'run_started',
      actor: deps.actor ?? 'worker',
      prNumber: run.pr_number,
      headSha: run.head_sha,
      runId: run.id,
      payload: { attempt: run.attempt, diffHash: built.diffHash, promptHash: built.promptHash, modelVersion: repo.model_version, settingsVersion: repo.settings_version, trigger: run.trigger },
    }),
  )

  const base = { tools: [] as ToolRecord[], scannerHits: [] as ScanHit[], modelVersion: repo.model_version, usage: { inputTokens: 0, outputTokens: 0, ttftMs: null, generationMs: null, calls: 0 } }

  // Do not ask for an opinion on what cannot be read in full. The gate refuses this anyway.
  const size = withinSizeLimits(toGateFacts(snapshot, run.head_sha, run.base_ref), policyOf(repo))
  if (size.status !== 'pass') {
    const signal_: ModelSignal = { kind: 'failure', code: 'model_not_called', detail: `Not sent to the model: ${size.reason}` }
    return { ...base, signal: signal_, output: null, raw: null, outcome: 'model_not_called', scannerHits: scanForInjection(scanInputs({ ...snapshot, files: snapshot.files.slice(0, 50) }, [])) }
  }

  const toolRecords: ToolRecord[] = []
  try {
    const convo = await runConversation({
      caller: deps.caller,
      request: built.request,
      maxRounds: config.worker.maxToolRounds,
      signal,
      runId: run.id,
      tools: {
        maxCalls: config.worker.maxToolCalls,
        // The SHA comes from the run, never from the model.
        readFile: (path) => deps.reader.readFile(repo.full_name, path, run.head_sha),
        changedFiles: () => snapshot.files.map((f) => ({ path: f.filename, previousPath: f.previous_filename, status: f.status })),
      },
      onTool: async (record) => {
        toolRecords.push(record)
        toolRequests.inc({ tool: record.allowed ? record.name : 'denied', result: record.allowed ? 'allowed' : 'denied' })
        // Written immediately: a denied request must leave a trace even if this worker dies next.
        await withTransaction((tx) =>
          appendAudit(tx, {
            repoId: repo.id,
            kind: record.allowed ? 'tool_requested' : 'tool_denied',
            actor: 'model',
            prNumber: run.pr_number,
            headSha: run.head_sha,
            runId: run.id,
            payload: { tool: record.name, input: record.input, allowed: record.allowed, denialReason: record.denialReason ?? null, resultBytes: record.resultBytes, result: record.allowed ? record.result.slice(0, 2000) : record.result },
          }),
        )
      },
    })
    const parsed = parseModelOutput(convo.text)
    const scannerHits = scanForInjection(scanInputs(snapshot, toolRecords))
    const usage = { inputTokens: convo.inputTokens, outputTokens: convo.outputTokens, ttftMs: convo.ttftMs, generationMs: convo.generationMs, calls: convo.calls }
    if (!parsed.ok) {
      return { signal: { kind: 'failure', code: 'model_malformed', detail: parsed.error }, output: null, raw: convo.text, tools: toolRecords, scannerHits, modelVersion: convo.modelVersion, outcome: 'model_malformed', usage }
    }
    const o = parsed.output
    return { signal: { kind: 'assessment', verdict: o.verdict, risk: o.risk, confidence: o.confidence }, output: o, raw: convo.text, tools: toolRecords, scannerHits, modelVersion: convo.modelVersion, outcome: 'assessment', usage }
  } catch (err) {
    if (err instanceof ModelCallError) {
      if (err.code === 'aborted') throw err
      const s = failureSignal(err)
      return { ...base, tools: toolRecords, signal: s, output: null, raw: null, outcome: s.kind === 'failure' ? s.code : 'model_unavailable' }
    }
    throw err
  }
}

function endStatus(outcome: string): 'completed' | 'failed' {
  return outcome === 'assessment' || outcome === 'reused' ? 'completed' : outcome === 'model_not_called' ? 'completed' : 'failed'
}

async function finalize(run: RunRow, repo: RepoRow, c: ModelContribution, gate: GateResult, result: DecisionResult, actor: string, skipIfSame: boolean): Promise<'completed' | 'failed'> {
  const status = run.kind === 'gate_only' ? 'completed' : endStatus(c.outcome)
  return withTransaction(async (tx) => {
    const locked = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE id = $1 FOR UPDATE`, [run.pr_id])
    const pr = locked.rows[0]
    // The push transaction takes this same lock: either it already ran and we stop here, or it will see our decision.
    if (pr.head_sha !== run.head_sha || pr.base_ref !== run.base_ref) throw new FencedOut()
    const raw = c.raw === null ? null : sanitizeForStorage(c.raw)
    const output = c.output === null ? null : JSON.stringify(sanitizeForStorage(c.output))
    const errorCode = c.signal.kind === 'failure' ? c.signal.code : null
    const errorDetail = c.signal.kind === 'failure' ? sanitizeForStorage(c.signal.detail) : null
    const fenced = await tx.query(
      `UPDATE review_runs SET status = $3, lease_token = NULL, finished_at = now(), model_outcome = $4, model_version = $5,
         raw_output = COALESCE($6, raw_output), parsed_output = COALESCE($7::jsonb, parsed_output), tool_calls = $8, scanner_hits = $9,
         input_tokens = $10, output_tokens = $11, ttft_ms = $12, generation_ms = $13, model_calls = $14, error_code = $15, error_detail = $16
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [run.id, run.lease_token, status, run.kind === 'gate_only' ? 'reused' : c.outcome, c.modelVersion, raw, output, JSON.stringify(sanitizeForStorage(c.tools)), JSON.stringify(c.scannerHits), c.usage.inputTokens, c.usage.outputTokens, c.usage.ttftMs, c.usage.generationMs, c.usage.calls, errorCode, errorDetail],
    )
    if (!fenced.rowCount) throw new FencedOut()

    if (run.kind === 'full') {
      await appendAudit(tx, {
        repoId: repo.id,
        kind: 'model_output',
        actor: 'model',
        prNumber: pr.number,
        headSha: run.head_sha,
        runId: run.id,
        payload: { modelVersion: c.modelVersion, outcome: c.outcome, rawOutput: raw, parsedOutput: c.output, toolsRequested: c.tools.map((t) => ({ name: t.name, allowed: t.allowed, denialReason: t.denialReason ?? null })), scannerHits: c.scannerHits, usage: c.usage, error: errorDetail },
      })
      if (status === 'failed') await appendAudit(tx, { repoId: repo.id, kind: 'run_failed', actor, prNumber: pr.number, headSha: run.head_sha, runId: run.id, payload: { code: errorCode, detail: errorDetail } })
    }

    const prior = await tx.query<DecisionRow>(`SELECT outcome, reason_code, head_sha FROM decisions WHERE pr_id = $1 AND state = 'active'`, [pr.id])
    const before = prior.rows[0]
    if (skipIfSame && before && before.head_sha === run.head_sha && before.outcome === result.outcome && before.reason_code === result.reasonCode) return status

    await appendAudit(tx, { repoId: repo.id, kind: 'gate_evaluated', actor, prNumber: pr.number, headSha: run.head_sha, runId: run.id, payload: { policyVersion: gate.policyVersion, settingsVersion: repo.settings_version, category: gate.category, passed: gate.passed, rules: gate.rules, trigger: run.trigger } })
    await recordDecision(tx, { repo, pr, runId: run.id, headSha: run.head_sha, result, gate, modelVersion: c.modelVersion, modelOutput: c.output, actor })
    return status
  })
}

/** The worker exhausted its attempts: this fails closed like any other model failure. */
export async function failExhausted(deps: PipelineDeps, run: RunRow): Promise<RunEnd> {
  const repo = await loadRepo(pool, run.repo_id)
  if (!repo) return 'cancelled'
  const detail = `Gave up after ${run.attempt - 1} attempts`
  const snapshot = await deps.reader.getSnapshot(repo.full_name, run.pr_number).catch(() => null)
  const gate = snapshot ? evaluateGate(toGateFacts(snapshot, run.head_sha, run.base_ref), policyOf(repo)) : unknownGate(detail)
  const signal: ModelSignal = { kind: 'failure', code: 'model_unavailable', detail }
  const c: ModelContribution = { signal, output: null, raw: null, tools: [], scannerHits: [], modelVersion: repo.model_version, outcome: 'model_unavailable', usage: { inputTokens: 0, outputTokens: 0, ttftMs: null, generationMs: null, calls: 0 } }
  const result = decide({ mode: repo.mode, killSwitch: repo.kill_switch, gate, model: signal, signals: { injection: false, toolDenied: false }, minConfidence: config.decision.minConfidence })
  try {
    const end = await finalize(run, repo, c, gate, result, deps.actor ?? 'worker', false)
    runsFinished.inc({ status: end, kind: run.kind })
    return end
  } catch (err) {
    if (err instanceof FencedOut) return 'fenced'
    throw err
  }
}

export function unknownGate(reason: string): GateResult {
  const ids = ['bound_to_current_head', 'ci_green_at_head', 'required_reviewers_approved', 'no_protected_paths', 'within_size_limits', 'not_self_authored', 'no_ci_config_changes', 'no_policy_changes', 'no_opaque_files', 'category_in_scope'] as const
  return { policyVersion: 'unavailable', category: 'other', categoryReasons: [], rules: ids.map((id) => ({ id, status: 'unknown', reason })), passed: false, failed: [], unknown: [...ids] }
}

export async function executeRun(deps: PipelineDeps, run: RunRow, signal: AbortSignal): Promise<RunEnd> {
  const actor = deps.actor ?? 'worker'
  if (run.attempt > config.worker.maxRunAttempts) return failExhausted(deps, run)
  const repo = await loadRepo(pool, run.repo_id)
  if (!repo) return 'cancelled'

  let snapshot: PullSnapshot
  try {
    snapshot = await deps.reader.getSnapshot(repo.full_name, run.pr_number)
  } catch (err) {
    // No facts at all, and the host may recover. The expiring lease is the backoff; attempts are bounded.
    logger.warn({ runId: run.id, err: (err as Error).message }, 'host read failed; leaving the run for its lease to expire')
    return 'retry_later'
  }

  const stale = async (fresh: PullSnapshot): Promise<RunEnd> => {
    await withTransaction(async (tx: PoolClient) => {
      await tx.query(`UPDATE review_runs SET status = 'cancelled', cancel_reason = COALESCE(cancel_reason, 'head_moved'), lease_token = NULL, finished_at = now() WHERE id = $1 AND lease_token = $2 AND status = 'running'`, [run.id, run.lease_token])
      await syncPullRequest(tx, repo, fresh.pull, actor)
    })
    runsFinished.inc({ status: 'cancelled', kind: run.kind })
    return 'cancelled'
  }
  const moved = (s: PullSnapshot) => s.pull.head.sha !== run.head_sha || s.pull.base.ref !== run.base_ref || s.pull.state !== 'open'
  if (moved(snapshot)) return stale(snapshot)

  try {
    let contribution: ModelContribution
    if (run.kind === 'gate_only') {
      // Reuse the opinion already formed for this exact commit. No new model call.
      const prior = await pool.query<RunRow>(`SELECT * FROM review_runs WHERE pr_id = $1 AND head_sha = $2 AND kind = 'full' AND status IN ('completed','failed') ORDER BY created_at DESC LIMIT 1`, [run.pr_id, run.head_sha])
      const source = prior.rows[0]
      if (!source) return 'retry_later'
      const sourceTools = (source.tool_calls ?? []) as ToolRecord[]
      contribution = {
        signal: signalOf(source),
        output: source.parsed_output,
        raw: null,
        tools: sourceTools,
        scannerHits: (source.scanner_hits ?? []) as ScanHit[],
        modelVersion: source.model_version ?? repo.model_version,
        outcome: source.model_outcome ?? 'model_unavailable',
        usage: { inputTokens: 0, outputTokens: 0, ttftMs: null, generationMs: null, calls: 0 },
      }
    } else {
      contribution = await callModel(deps, repo, run, snapshot, signal)
      if (contribution.usage.ttftMs !== null) modelLatency.observe({ phase: 'ttft' }, contribution.usage.ttftMs / 1000)
      if (contribution.usage.generationMs !== null) modelLatency.observe({ phase: 'generation' }, contribution.usage.generationMs / 1000)
      if (run.queue_ms !== null) modelLatency.observe({ phase: 'queue' }, run.queue_ms / 1000)
    }

    // Facts may have changed while the model was thinking. A failed read becomes unknown, which fails closed.
    const fresh = await deps.reader.getSnapshot(repo.full_name, run.pr_number).catch((err) => {
      if (err instanceof HostUnavailable) return { ...snapshot, checks: null, reviews: null }
      throw err
    })
    if (moved(fresh)) return stale(fresh)

    // Settings could have changed too: the kill switch must apply from this moment.
    const current = (await loadRepo(pool, run.repo_id)) ?? repo
    const gate = evaluateGate(toGateFacts(fresh, run.head_sha, run.base_ref), policyOf(current))
    const result = decide({
      mode: current.mode,
      killSwitch: current.kill_switch,
      gate,
      model: contribution.signal,
      signals: { injection: contribution.scannerHits.length > 0, toolDenied: contribution.tools.some((t) => !t.allowed) },
      minConfidence: config.decision.minConfidence,
      ciDeadlineExceeded: run.trigger === 'ci_deadline',
    })
    const end = await finalize(run, current, contribution, gate, result, actor, run.kind === 'gate_only')
    runsFinished.inc({ status: end, kind: run.kind })
    decisionsMade.inc({ mode: current.mode, outcome: result.outcome, reason: result.reasonCode })
    if (result.modelOverruled) modelOverrules.inc()
    return end
  } catch (err) {
    if (err instanceof FencedOut) {
      runsFinished.inc({ status: 'cancelled', kind: run.kind })
      return 'fenced'
    }
    if (err instanceof ModelCallError && err.code === 'aborted') {
      runsFinished.inc({ status: 'cancelled', kind: run.kind })
      return 'cancelled'
    }
    throw err
  }
}

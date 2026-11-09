/**
 * Database row shapes shared by the worker, the poster and the API. Handlers
 * never return these directly: api/services/views.ts maps them to DTOs.
 * @module shared/rows
 */
import type { GateResult } from './gate/types.js'
import type { ModelOutput } from './model-output.js'

export interface PrRow {
  id: string
  repo_id: string
  number: number
  title: string
  author: string
  base_ref: string
  head_sha: string
  head_seq: number
  state: string
  created_at: Date
  updated_at: Date
}

export interface RunRow {
  id: string
  repo_id: string
  pr_id: string
  pr_number: number
  head_sha: string
  base_ref: string
  kind: 'full' | 'gate_only'
  trigger: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  attempt: number
  claimed_by: string | null
  lease_token: string | null
  lease_expires_at: Date | null
  cancel_reason: string | null
  superseded_by_sha: string | null
  model_version: string | null
  model_outcome: string | null
  error_code: string | null
  error_detail: string | null
  diff_hash: string | null
  prompt_hash: string | null
  prompt_text: string | null
  files_snapshot: unknown
  raw_output: string | null
  parsed_output: ModelOutput | null
  tool_calls: unknown[]
  scanner_hits: unknown[]
  input_tokens: number
  output_tokens: number
  queue_ms: number | null
  ttft_ms: number | null
  generation_ms: number | null
  model_calls: number
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

export interface DecisionRow {
  id: string
  repo_id: string
  pr_id: string
  pr_number: number
  run_id: string | null
  head_sha: string
  mode: string
  outcome: 'auto_approved' | 'escalated' | 'shadow' | 'waiting_ci' | 'human_approved' | 'human_rejected'
  would: 'approve' | 'escalate' | 'wait_ci'
  reason_code: string
  reason: string
  model_overruled: boolean
  policy_version: string
  settings_version: number
  category: string | null
  gate: GateResult | null
  model_version: string | null
  actor: string
  state: 'active' | 'invalidated'
  invalidated_reason: string | null
  invalidated_at: Date | null
  posted_review_id: number | null
  posted_at: Date | null
  dismissed_at: Date | null
  human_outcome: string | null
  false_approval_reported_at: Date | null
  false_approval_reported_by: string | null
  false_approval_note: string | null
  waiting_since: Date | null
  created_at: Date
}

export interface IntentRow {
  id: string
  repo_id: string
  pr_id: string
  pr_number: number
  decision_id: string | null
  head_sha: string
  kind: 'approve' | 'comment' | 'dismiss'
  body: string
  actor: string
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'failed'
  outcome: string | null
  attempts: number
  claimed_by: string | null
  lease_token: string | null
  lease_expires_at: Date | null
  next_attempt_at: Date
  review_ids: number[]
  error: string | null
  created_at: Date
  finished_at: Date | null
}

export interface EscalationRow {
  id: string
  repo_id: string
  pr_id: string
  pr_number: number
  decision_id: string | null
  head_sha: string
  reason_code: string
  reason: string
  model_overruled: boolean
  status: 'open' | 'claimed' | 'decided' | 'invalidated'
  claimed_by: string | null
  claimed_at: Date | null
  decided_by: string | null
  decided_at: Date | null
  resolution: 'approved' | 'rejected' | null
  note: string | null
  invalidated_reason: string | null
  created_at: Date
}

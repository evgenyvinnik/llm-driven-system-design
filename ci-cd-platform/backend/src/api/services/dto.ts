/**
 * Row-to-response mapping. No handler returns a raw row, and no DTO has a place for a
 * secret value, a ciphertext, a webhook key or a runner token.
 * @module api/services/dto
 */

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null)

export interface RunDbRow {
  id: string
  repo_id: string
  run_number: number
  event_type: string
  ref: string
  branch: string
  commit_sha: string
  commit_message: string
  workflow_path: string
  workflow_sha: string
  workflow_name: string
  is_fork: boolean
  head_repo: string | null
  pr_number: number | null
  sender: string
  status: string
  run_attempt: number
  error_code: string | null
  error_message: string | null
  error_details: unknown
  cancel_requested_at: Date | null
  cancelled_by: string | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

export function runDto(r: RunDbRow) {
  return {
    id: r.id,
    repoId: r.repo_id,
    number: r.run_number,
    eventType: r.event_type,
    ref: r.ref,
    branch: r.branch,
    commitSha: r.commit_sha,
    commitMessage: r.commit_message,
    workflowPath: r.workflow_path,
    workflowSha: r.workflow_sha,
    workflowName: r.workflow_name,
    isFork: r.is_fork,
    headRepo: r.head_repo,
    prNumber: r.pr_number,
    sender: r.sender,
    status: r.status,
    runAttempt: r.run_attempt,
    error: r.error_code ? { code: r.error_code, message: r.error_message, details: r.error_details } : null,
    cancelRequestedAt: iso(r.cancel_requested_at),
    cancelledBy: r.cancelled_by,
    createdAt: iso(r.created_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  }
}

export interface JobDbRow {
  id: string
  run_id: string
  repo_id: string
  job_key: string
  name: string
  needs: string[]
  runs_on: string[]
  environment: string | null
  requested_secrets: string[]
  steps: { name: string; run: string; idempotent: boolean; timeoutSeconds: number }[]
  uploads: { name: string; path: string; retentionDays: number }[]
  matrix: Record<string, string> | null
  has_non_idempotent: boolean
  status: string
  status_reason: string | null
  attempt: number
  cancel_requested: boolean
  runner_name: string | null
  fencing_token: number | null
  lease_expires_at: Date | null
  last_heartbeat_at: Date | null
  queued_at: Date | null
  started_at: Date | null
  finished_at: Date | null
}

export function jobDto(j: JobDbRow) {
  return {
    id: j.id,
    runId: j.run_id,
    key: j.job_key,
    name: j.name,
    needs: j.needs,
    runsOn: j.runs_on,
    environment: j.environment,
    requestedSecrets: j.requested_secrets,
    steps: j.steps.map((s) => ({ name: s.name, idempotent: s.idempotent, timeoutSeconds: s.timeoutSeconds })),
    uploads: j.uploads,
    matrix: j.matrix,
    hasNonIdempotent: j.has_non_idempotent,
    status: j.status,
    statusReason: j.status_reason,
    attempt: j.attempt,
    cancelRequested: j.cancel_requested,
    runnerName: j.runner_name,
    fencingToken: j.fencing_token,
    leaseExpiresAt: iso(j.lease_expires_at),
    lastHeartbeatAt: iso(j.last_heartbeat_at),
    queuedAt: iso(j.queued_at),
    startedAt: iso(j.started_at),
    finishedAt: iso(j.finished_at),
  }
}

export interface AttemptDbRow {
  job_id: string
  attempt: number
  run_attempt: number
  trigger: string
  triggered_by: string | null
  confirmed_non_idempotent: boolean
  status: string
  status_reason: string | null
  runner_name: string | null
  fencing_token: number | null
  secrets_released: string[]
  secrets_withheld: { name: string; reason: string }[]
  closed_by: string | null
  late_report: unknown
  resolved_decision: string | null
  resolved_note: string | null
  resolved_by: string | null
  resolved_at: Date | null
  created_at: Date
  queued_at: Date | null
  started_at: Date | null
  finished_at: Date | null
}

export function attemptDto(a: AttemptDbRow) {
  return {
    attempt: a.attempt,
    runAttempt: a.run_attempt,
    trigger: a.trigger,
    triggeredBy: a.triggered_by,
    confirmedNonIdempotent: a.confirmed_non_idempotent,
    status: a.status,
    statusReason: a.status_reason,
    runnerName: a.runner_name,
    fencingToken: a.fencing_token,
    secretsReleased: a.secrets_released,
    secretsWithheld: a.secrets_withheld,
    closedBy: a.closed_by,
    lateReport: a.late_report,
    resolution: a.resolved_decision ? { decision: a.resolved_decision, note: a.resolved_note, by: a.resolved_by, at: iso(a.resolved_at) } : null,
    createdAt: iso(a.created_at),
    queuedAt: iso(a.queued_at),
    startedAt: iso(a.started_at),
    finishedAt: iso(a.finished_at),
  }
}

export interface ArtifactDbRow {
  id: string
  run_id: string
  job_id: string
  job_key: string
  attempt: number
  name: string
  size_bytes: number
  sha256: string
  retention_days: number
  expires_at: Date
  deleted_at: Date | null
  created_at: Date
}

export function artifactDto(a: ArtifactDbRow) {
  return {
    id: a.id,
    runId: a.run_id,
    jobId: a.job_id,
    jobKey: a.job_key,
    attempt: a.attempt,
    name: a.name,
    sizeBytes: a.size_bytes,
    sha256: a.sha256,
    retentionDays: a.retention_days,
    expiresAt: iso(a.expires_at),
    expired: a.deleted_at !== null || new Date(a.expires_at).getTime() <= Date.now(),
    createdAt: iso(a.created_at),
  }
}

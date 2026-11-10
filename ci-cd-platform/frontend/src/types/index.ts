export interface User {
  id: string
  username: string
  displayName: string
  orgId: string
  orgName: string
  isAdmin: boolean
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'needs_attention' | 'success' | 'failure' | 'cancelled' | 'invalid'
export type JobStatus = 'blocked' | 'queued' | 'waiting' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'needs_attention'

export interface Run {
  id: string
  repoId: string
  number: number
  eventType: string
  ref: string
  branch: string
  commitSha: string
  commitMessage: string
  workflowPath: string
  workflowSha: string
  workflowName: string
  isFork: boolean
  headRepo: string | null
  prNumber: number | null
  sender: string
  status: RunStatus
  runAttempt: number
  error: { code: string; message: string; details: { code: string; path: string; message: string }[] | null } | null
  cancelRequestedAt: string | null
  cancelledBy: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface RunListItem extends Run {
  jobCounts: Partial<Record<JobStatus, number>>
  redeliveries: number
  deliveryId: string
}

export interface Repository {
  id: string
  fullName: string
  defaultBranch: string
  org: string
  role: 'maintainer' | 'read'
  maxConcurrentJobs: number
  runningJobs: number
  queuedJobs: number
  attentionJobs: number
  totalRuns: number
  lastRun: Run | null
}

export interface RepositoryDetail {
  id: string
  fullName: string
  defaultBranch: string
  maxConcurrentJobs: number
  role: 'maintainer' | 'read'
  webhookUrl: string
}

export interface WithheldSecret {
  name: string
  reason: string
}

export interface Job {
  id: string
  runId: string
  key: string
  name: string
  needs: string[]
  runsOn: string[]
  environment: string | null
  requestedSecrets: string[]
  steps: { name: string; idempotent: boolean; timeoutSeconds: number }[]
  uploads: { name: string; path: string; retentionDays: number }[]
  matrix: Record<string, string> | null
  hasNonIdempotent: boolean
  status: JobStatus
  statusReason: string | null
  attempt: number
  cancelRequested: boolean
  runnerName: string | null
  fencingToken: number | null
  leaseExpiresAt: string | null
  lastHeartbeatAt: string | null
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface RunJob extends Job {
  secretsReleased: string[]
  secretsWithheld: WithheldSecret[]
  approval: { decision: string; by: string } | null
  lastRunnerName: string | null
}

export interface Artifact {
  id: string
  runId: string
  jobId: string
  jobKey: string
  attempt: number
  name: string
  sizeBytes: number
  sha256: string
  retentionDays: number
  expiresAt: string
  expired: boolean
  createdAt: string
}

export interface RunDetail {
  run: Run & { repositoryName: string | null }
  canManage: boolean
  trigger: { deliveryId: string; redeliveries: number; receivedAt: string; lastReceivedAt: string } | null
  jobs: RunJob[]
  artifacts: Artifact[]
}

export interface StepExecution {
  index: number
  name: string
  idempotent: boolean
  status: string
  exitCode: number | null
  startedAt: string | null
  finishedAt: string | null
}

export interface Transition {
  id: number
  from: string | null
  to: string
  reason: string | null
  actor: string | null
  at: string
}

export interface Attempt {
  attempt: number
  runAttempt: number
  trigger: string
  triggeredBy: string | null
  confirmedNonIdempotent: boolean
  status: string
  statusReason: string | null
  runnerName: string | null
  fencingToken: number | null
  secretsReleased: string[]
  secretsWithheld: WithheldSecret[]
  closedBy: string | null
  lateReport: { conclusion: string; reason: string | null; at: string } | null
  resolution: { decision: string; note: string | null; by: string | null; at: string | null } | null
  createdAt: string
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  steps: StepExecution[]
  transitions: Transition[]
  artifacts: Artifact[]
  log: { lineCount: number; closed: boolean; archived: boolean; gapChunks: number } | null
  approval: { decision: string; by: string; comment: string | null; at: string } | null
}

export interface JobDetail {
  canManage: boolean
  run: Run
  job: Job
  attempts: Attempt[]
}

export interface Environment {
  id: string
  name: string
  requiredApproval: boolean
  allowedBranches: string[]
  secretCount: number
}

export interface SecretMeta {
  id: string
  name: string
  scope: 'repository' | 'environment'
  environment: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  lastReleasedAt: string | null
  releaseCount: number
}

export interface SecretRelease {
  id: number
  secretName: string
  scope: string
  runId: string
  runNumber: number | null
  jobId: string
  jobKey: string
  attempt: number
  runnerName: string
  releasedAt: string
}

export type RunnerJob =
  | { visible: true; jobId: string; runId: string; runNumber: number; repository: string; jobName: string; attempt: number; fencingToken: number; leaseExpiresInMs: number; lastHeartbeatMs: number }
  | { visible: false; leaseExpiresInMs: number; lastHeartbeatMs: number }

export interface Runner {
  id: string
  name: string
  labels: string[]
  slots: number
  pid: number | null
  incarnation: number
  registeredAt: string
  lastSeenMs: number
  online: boolean
  jobs: RunnerJob[]
}

export interface BurstRow {
  repoId: string
  fullName: string
  limit: number
  jobs: number
  finished: number
  peakConcurrent: number
  waitP50Ms: number
  waitMaxMs: number
  firstStartMs: number | null
}

export interface OpsOverview {
  windowSeconds: number
  queues: { label: string; queued: number; oldestMs: number }[]
  repositories: { id: string; fullName: string; limit: number; running: number; queued: number; waiting: number; attention: number; oldestQueuedMs: number | null; lastClaimedAt: string | null }[]
  fleet: { online: number; total: number; slots: number; busy: number }
  timeline: { at: string; starts: Record<string, number> }[]
  burst: BurstRow[]
}

export interface Scenario {
  name: string
  title: string
  description: string
  event: 'push' | 'pull_request'
  fork: boolean
  killableStep: string | null
}

export interface Delivery {
  deliveryId: string
  repoId: string
  repository: string
  eventType: string
  branch: string
  commitSha: string
  isFork: boolean
  outcome: string
  outcomeDetail: string | null
  runId: string | null
  runNumber: number | null
  redeliveries: number
  createdAt: string
}

export interface TriggerResult {
  runId: string | null
  runNumber: number | null
  duplicate: boolean
  outcome: string
  detail: string | null
  deliveryId: string
  commitSha?: string
  httpStatus: number
}

export interface LogLine {
  n: number
  step: number
  text: string
  at: string
}

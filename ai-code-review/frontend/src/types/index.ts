export type Role = 'reviewer' | 'repo_admin' | 'admin'

export interface User {
  id: string
  username: string
  displayName: string
  orgId: string | null
  orgName: string | null
  role: Role
}

export type RepoMode = 'observe' | 'narrow_auto'
export type Outcome = 'auto_approved' | 'escalated' | 'shadow' | 'waiting_ci' | 'human_approved' | 'human_rejected'
export type RuleStatus = 'pass' | 'fail' | 'unknown'

export interface RuleResult {
  id: string
  status: RuleStatus
  reason: string
  evidence?: unknown
}

export interface GateResult {
  policyVersion: string
  category: string
  categoryReasons: string[]
  rules: RuleResult[]
  passed: boolean
  failed: string[]
  unknown: string[]
}

export interface Decision {
  id: string
  runId: string | null
  headSha: string
  mode: RepoMode
  outcome: Outcome
  would: 'approve' | 'escalate' | 'wait_ci'
  reasonCode: string
  reason: string
  modelOverruled: boolean
  policyVersion: string
  settingsVersion: number
  category: string | null
  gate: GateResult | null
  modelVersion: string | null
  actor: string
  state: 'active' | 'invalidated'
  invalidatedReason: string | null
  invalidatedAt: string | null
  postedReviewId: number | null
  postedAt: string | null
  dismissedAt: string | null
  humanOutcome: string | null
  falseApprovalReportedAt: string | null
  falseApprovalReportedBy: string | null
  createdAt: string
}

export interface Finding {
  severity: 'info' | 'warning' | 'critical'
  path?: string
  line?: number
  title: string
  detail: string
}

export interface ModelOutput {
  verdict: 'approve' | 'needs_human' | 'request_changes'
  risk: 'low' | 'medium' | 'high'
  confidence: number
  summary: string
  findings: Finding[]
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
  allowed: boolean
  denialReason?: string
  result: string
  resultBytes: number
}

export interface ScanHit {
  source: string
  pattern: string
  excerpt: string
}

export interface DiffFile {
  filename: string
  previous_filename: string | null
  status: string
  additions: number
  deletions: number
  patch: string | null
  binary: boolean
  mode: string
}

export interface Run {
  id: string
  headSha: string
  baseRef: string
  kind: 'full' | 'gate_only'
  trigger: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  attempt: number
  cancelReason: string | null
  supersededBySha: string | null
  modelVersion: string | null
  modelOutcome: string | null
  errorCode: string | null
  errorDetail: string | null
  diffHash: string | null
  promptHash: string | null
  rawOutput: string | null
  parsedOutput: ModelOutput | null
  toolCalls: ToolCall[]
  scannerHits: ScanHit[]
  files: DiffFile[] | null
  usage: { inputTokens: number; outputTokens: number; queueMs: number | null; ttftMs: number | null; generationMs: number | null; modelCalls: number }
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface Intent {
  id: string
  kind: 'approve' | 'comment' | 'dismiss'
  headSha: string
  status: string
  outcome: string | null
  attempts: number
  actor: string
  reviewIds: number[]
  error: string | null
  createdAt: string
  finishedAt: string | null
}

export interface Escalation {
  id: string
  prNumber: number
  headSha: string
  reasonCode: string
  reason: string
  modelOverruled: boolean
  status: 'open' | 'claimed' | 'decided' | 'invalidated'
  claimedBy: string | null
  claimedAt: string | null
  decidedBy: string | null
  decidedAt: string | null
  resolution: 'approved' | 'rejected' | null
  note: string | null
  invalidatedReason: string | null
  createdAt: string
}

export interface QueueEscalation extends Escalation {
  repo: string
  mode: RepoMode
  title: string
  author: string
  currentHead: string
}

export interface AuditEntry {
  repoId: string
  repo: string
  seq: number
  prevHash: string
  hash: string
  kind: string
  actor: string
  prNumber: number | null
  headSha: string | null
  runId: string | null
  decisionId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface HostReview {
  id: number
  user: { login: string }
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
  commit_id: string
  body: string
  dismissed: boolean
  submitted_at: string
}

export interface Repo {
  id: string
  orgId: string
  fullName: string
  mode: RepoMode
  killSwitch: boolean
  protectedPaths: string[]
  ciConfigPaths: string[]
  policyPaths: string[]
  maxFiles: number
  maxChangedLines: number
  autoApproveScope: ('docs' | 'tests')[]
  requiredChecks: string[]
  requiredReviewers: string[]
  botLogins: string[]
  linkAllowlist: string[]
  modelVersion: string
  settingsVersion: number
  demotedAt: string | null
  demotedReason: string | null
  modeChangedAt: string
  updatedAt: string
}

export interface PrRow {
  repo: { id: string; fullName: string; mode: RepoMode; killSwitch: boolean }
  number: number
  title: string
  author: string
  baseRef: string
  headSha: string
  state: string
  updatedAt: string
  run: { status: string; headSha: string; modelOutcome: string | null; modelVerdict: string | null; modelConfidence: number | null } | null
  decision: { id: string; outcome: Outcome; would: string; reasonCode: string; reason: string; modelOverruled: boolean; state: string; headSha: string; postedReviewId: number | null; dismissedAt: string | null; invalidatedReason: string | null } | null
}

export interface PrDetail {
  repo: Repo
  pr: { number: number; title: string; author: string; baseRef: string; headSha: string; headSeq: number; state: string; createdAt: string; updatedAt: string }
  runs: Run[]
  decisions: Decision[]
  escalations: Escalation[]
  intents: Intent[]
  timeline: AuditEntry[]
  hostReviews: HostReview[] | null
  mergeBlockers: string[] | null
}

export interface PromotionCheck {
  id: string
  passed: boolean
  required: string
  actual: string
}

export interface ModeChange {
  id: string
  kind: 'promote' | 'promote_refused' | 'demote'
  fromMode: string
  toMode: string
  actor: string
  reason: string
  evaluationId: string | null
  createdAt: string
}

export interface RepoDetail {
  repo: Repo
  policyVersion: string
  modelVersions: string[]
  promotion: { allowed: boolean; checks: PromotionCheck[]; reasons: string[] }
  shadow: { decisions: number; labeled: number; agreed: number; unsafeApprovals: number }
  modeChanges: ModeChange[]
}

export interface PipelineMetrics {
  pipeline: string
  total: number
  approved: number
  escalated: number
  confusion: { dangerousApproved: number; dangerousEscalated: number; safeApproved: number; safeEscalated: number }
  dangerous: { total: number; falseApprovals: number; rate: number; upperBound95: number; ruleOfThree: number | null }
  falseEscalations: { count: number; total: number; rate: number; inScopeCount: number; inScopeTotal: number; inScopeRate: number }
  humanAgreement: { agree: number; total: number; rate: number; unsafeDisagreements: number }
  injection: { total: number; modelApproved: number; approved: number; dangerousApproved: number }
  automationRate: number
}

export interface ClassRow {
  class: string
  total: number
  dangerous: number
  modelOnlyApproved: number
  gatedApproved: number
}

export interface EvaluationSummary {
  corpus: { size: number; dangerous: number; injections: number; inScope: number; humanRejected: number }
  modelOnly: PipelineMetrics
  modelPlusGate: PipelineMetrics
  observe: PipelineMetrics
  byClass: ClassRow[]
}

export interface Evaluation {
  id: string
  status: string
  modelVersion: string
  policyVersion: string
  corpusHash: string
  corpusSize: number
  partial: boolean
  summary: EvaluationSummary | null
  createdBy: string
  createdAt: string
  finishedAt: string | null
}

export interface EvaluationCase {
  caseId: string
  title: string
  class: string
  dangerous: boolean
  injection: boolean
  humanDecision: string
  inScope: boolean
  modelVerdict: string
  modelConfidence: number | null
  modelOnly: string
  gated: string
  observeWould: string
  reasonCode: string
  reason: string
  failedRules: string[]
  toolsDenied: number
  scannerHit: boolean
}

export interface SystemView {
  model: { settings: ModelSettings; stats: { calls: number; active: number; outcomes: Record<string, number> } } | null
  host: { dropNext: number; duplicateNext: number; reviewDelayMs: number } | null
}

export interface ModelSettings {
  ttftMs: number
  tokensPerSecond: number
  failureRate: number
  maxConcurrent: number
  followInjections: boolean
  chaos: Record<string, number>
}

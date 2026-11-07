export interface User {
  id: string
  username: string
  displayName: string
  workspaceId: string
  workspaceName: string
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'errored' | 'cancelled'

export interface RunHeader {
  id: string
  name: string
  status: RunStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  cancelRequestedAt: string | null
  createdBy: string
  retryRound: number
  failureReason: string | null
  samplesPerCase: number
  concurrencyLimit: number
  totalTasks: number
  dataset: { id: string; name: string; versionId: string; version: number; caseCount: number }
  prompt: { id: string; name: string; versionId: string; version: number }
  modelConfig: ModelConfig
}

export interface Aggregate {
  totalCases: number
  scoredCases: number
  mean: number | null
  ci: [number, number] | null
  bootstrapCi: [number, number] | null
  ciHalfWidth: number | null
  totalTasks: number
  succeededTasks: number
  erroredTasks: number
  cancelledTasks: number
  pendingTasks: number
  unscoredTasks: number
  erroredCases: number
  partialCases: number
  unscoredCases: number
  flakyCases: number
  meanWithinVariance: number | null
  betweenVariance: number | null
}

export type Progress = Record<TaskStatus, number>

export interface RunListItem extends RunHeader {
  progress: Progress
  primary: { name: string; version: number; aggregate: Aggregate } | null
}

export interface RunScorer {
  scorerVersionId: string
  scorerId: string
  name: string
  kind: ScorerKind
  version: number
  origin: 'pinned' | 'rescore'
  addedAt: string
  coverage: { scored: number; pending: number; errored: number; cancelled: number }
  complete: boolean
  aggregate: Aggregate
}

export interface RunDetail {
  run: RunHeader
  progress: Progress
  usage: { inputTokens: number; outputTokens: number; modelCalls: number; avgQueueMs: number | null; avgTtftMs: number | null; avgGenerationMs: number | null; liveLeases: number }
  scorers: RunScorer[]
  samePins: { id: string; name: string; samplesPerCase: number; status: RunStatus; scorers: { scorerVersionId: string; mean: number | null; ciHalfWidth: number | null }[] }[]
}

export interface ScoreCell {
  status: string
  score: number | null
  passed: boolean | null
  confidence: number | null
  rationale: string | null
  errorCode: string | null
}

export interface Annotation {
  label: 'pass' | 'fail'
  note: string
  by: string
  at: string
}

export interface SampleView {
  id: string
  sampleIndex: number
  status: TaskStatus
  attempts: number
  output: string | null
  finishReason: string | null
  errorCode: string | null
  errorMessage: string | null
  inputTokens: number | null
  outputTokens: number | null
  queueMs: number | null
  ttftMs: number | null
  generationMs: number | null
  scores: Record<string, ScoreCell>
  annotation: Annotation | null
}

export interface CaseView {
  caseId: string
  caseKey: string
  ordinal: number
  tags: string[]
  input: Record<string, unknown>
  reference: string
  samples: SampleView[]
  stats: Record<string, { mean: number | null; variance: number; flaky: boolean; scored: number; errored: number }>
}

export interface Attempt {
  attempt: number
  workerId: string
  outcome: string
  errorCode: string | null
  httpStatus: number | null
  delayMs: number | null
  startedAt: string
  finishedAt: string | null
}

export interface ProvenanceWarning {
  code: string
  severity: 'block' | 'warn' | 'info'
  message: string
}

export interface Provenance {
  rows: { key: string; label: string; a: string; b: string; changed: boolean; role: 'factor' | 'must_match' | 'context' }[]
  factorsChanged: string[]
  configFieldsChanged: string[]
  mode: 'paired' | 'unpaired_shared_cases' | 'not_comparable'
  scorer: { aVersions: number[]; bVersions: number[]; commonVersionId: string | null; commonVersion: number | null; latestA: number | null; latestB: number | null; rescoreSuggestion: { runId: string; scorerVersionId: string; version: number } | null }
  warnings: ProvenanceWarning[]
  requirements: { key: string; label: string; met: boolean | null; detail: string }[]
  claimEligible: boolean
}

export interface CompareSample {
  sampleIndex: number
  status: string
  output: string | null
  score: number | null
  passed: boolean | null
  errorCode: string | null
}

export interface CompareCase {
  caseKey: string
  tags: string[]
  input: Record<string, unknown>
  reference: string
  meanA: number | null
  meanB: number | null
  diff: number | null
  excluded: string | null
  samplesA: CompareSample[]
  samplesB: CompareSample[]
}

export type VerdictCode = 'improvement' | 'regression' | 'not_significant' | 'confounded' | 'not_claimable' | 'indicative_only' | 'not_comparable' | 'insufficient_data'

export interface Comparison {
  a: RunHeader
  b: RunHeader
  scorer: { id: string; name: string; kind: string }
  provenance: Provenance
  paired: { n: number; meanA: number; meanB: number; meanDiff: number; sdDiff: number; ci: [number, number]; bootstrapCi: [number, number]; wins: number; losses: number; ties: number; verdict: string } | null
  unpaired: { nA: number; nB: number; meanA: number; meanB: number; meanDiff: number; df: number; ci: [number, number]; verdict: string; sharedCases: number; onlyA: number; onlyB: number; changed: number } | null
  excludedCases: number
  totalCases: number
  verdict: { code: VerdictCode; headline: string; detail: string }
  cases: CompareCase[]
}

export interface DatasetSummary {
  id: string
  name: string
  description: string
  headVersion: number
  caseCount: number
  updatedAt: string
  runs: number
}

export interface DatasetVersion {
  id: string
  version: number
  message: string
  caseCount: number
  contentHash: string
  createdAt: string
  createdBy: string
  runs: number
}

export interface DatasetDetail {
  id: string
  name: string
  description: string
  headVersion: number
  versions: DatasetVersion[]
}

export interface DatasetCase {
  id: string
  caseKey: string
  ordinal: number
  input: Record<string, string>
  reference: string
  tags: string[]
  contentHash: string
}

export interface CaseDiff {
  added: DatasetCase[]
  removed: DatasetCase[]
  modified: { caseKey: string; fields: ('input' | 'reference' | 'tags')[]; from: DatasetCase; to: DatasetCase }[]
  unchanged: number
}

export interface PromptSummary {
  id: string
  name: string
  description: string
  headVersion: number
  updatedAt: string
  runs: number
}

export interface PromptVersion {
  id: string
  version: number
  system: string
  template: string
  variables: string[]
  message: string
  createdAt: string
  createdBy: string
  runs: number
}

export interface PromptDetail {
  id: string
  name: string
  description: string
  headVersion: number
  versions: PromptVersion[]
}

export interface ModelConfig {
  id: string
  name: string
  model: string
  temperature: number
  maxTokens: number
  seed: number
}

export type ScorerKind = 'exact_match' | 'regex' | 'contains' | 'json_shape' | 'model_graded' | 'human'

export interface Scorer {
  id: string
  name: string
  kind: ScorerKind
  description: string
  headVersion: number
  versions: { id: string; version: number; config: Record<string, unknown>; message: string; createdAt: string }[]
}

export interface QueueItem {
  caseResultId: string
  caseKey: string
  sampleIndex: number
  input: Record<string, unknown>
  reference: string
  output: string
  reasons: ('low_confidence' | 'samples_disagree' | 'spot_check')[]
  judge: { scorerVersionId: string; name: string; version: number; score: number | null; passed: boolean | null; confidence: number | null; rationale: string | null }[]
  primary: { scorerVersionId: string; passed: boolean | null } | null
  annotation: Annotation | null
}

export interface AgreementStats {
  n: number
  agree: number
  rate: number | null
  kappa: number | null
  judgePassRate: number | null
  humanPassRate: number | null
}

export interface AnnotationQueue {
  items: QueueItem[]
  agreement: { scorerVersionId: string; name: string; version: number; overall: AgreementStats; spotCheck: AgreementStats; queue: AgreementStats }[]
  labeled: number
  total: number
}

export interface MockState {
  settings: Record<string, unknown>
  chaos: { armed: Record<string, number>; rates: Record<string, number>; fired: Record<string, number> }
  stats: { total: number; active: number; maxActive: number; byOutcome: Record<string, number>; runs: number }
}

export interface SystemView {
  model: MockState | null
  judge: MockState | null
  queue: { pendingTasks: number; liveLeases: number; pendingScores: number; activeRuns: number }
}

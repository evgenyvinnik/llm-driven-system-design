/** API shapes, mirroring backend/src/api/services/dto.ts and the route files. */

export type Role = 'member' | 'org_admin' | 'operator'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  orgId: string | null
  orgName: string | null
  groupIds: string[]
}

export type Scope = 'private' | 'group' | 'org'

export interface StageState {
  stage: string
  status: string
  attempts: number
  maxAttempts: number
  progress: Record<string, unknown>
  lastError: string | null
}

export interface PurgeArtifact {
  artifact: string
  status: string
  removed: number
  attempts: number
  lastError: string | null
  completedAt: string | null
}

export interface PurgeState {
  done: number
  total: number
  completedAt: string | null
  lastError: string | null
  artifacts: PurgeArtifact[]
}

export interface DocumentItem {
  id: string
  title: string
  ownerId: string
  ownerName: string | null
  isOwner: boolean
  scope: Scope
  groupId: string | null
  groupName: string | null
  status: string
  currentVersionNo: number | null
  latestVersionNo: number
  latestVersionStatus: string | null
  latestVersionFailure: string | null
  filename: string | null
  sizeBytes: number | null
  chunkCount: number | null
  contentHash: string | null
  aclEpoch: number
  staleIndexRows: number
  failureReason: string | null
  createdAt: string | null
  updatedAt: string | null
  deletedAt: string | null
  purgeCompletedAt: string | null
  stages: StageState[]
  purge: PurgeState | null
}

export interface DeletedItem {
  id: string
  title: string
  deletedAt: string | null
  purgeCompletedAt: string | null
  purge: PurgeState | null
}

export interface VersionItem {
  id: string
  versionNo: number
  contentHash: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: string
  failureReason: string | null
  charCount: number | null
  chunkCount: number | null
  liveChunks: number
  createdAt: string | null
  readyAt: string | null
  activatedAt: string | null
  supersededAt: string | null
  retiredAt: string | null
}

export interface AttemptItem {
  attemptNo: number
  workerId: string
  startedAt: string | null
  finishedAt: string | null
  outcome: string | null
  error: string | null
  detail: Record<string, unknown>
}

export interface JobItem {
  id: string
  versionId: string | null
  stage: string
  status: string
  attempts: number
  maxAttempts: number
  progress: Record<string, unknown>
  lastError: string | null
  nextRunAt: string | null
  leaseOwner: string | null
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  attemptLog: AttemptItem[]
}

export interface DocEvent {
  id: number
  kind: string
  detail: Record<string, unknown>
  actor: string | null
  createdAt: string
}

export interface DocumentDetail {
  document: DocumentItem
  versions: VersionItem[]
  jobs: JobItem[]
  events: DocEvent[]
}

export interface DocumentText {
  document: DocumentItem
  versionId: string
  versionNo: number
  versionStatus: string
  text: string | null
  headings: unknown
}

export interface ChunkItem {
  id: string
  versionId: string
  ordinal: number
  text: string
  charStart: number
  charEnd: number
  heading: string | null
  tokenCount: number
  embedded: boolean
  indexed: boolean
}

export interface UploadResponse {
  duplicate: boolean
  unchanged: boolean
  document: DocumentItem
  versionId?: string
  versionNo?: number
}

export interface SourceRef {
  n: number
  documentId: string
  versionId: string
  versionNo: number
  title: string
  chunkId: string
  ordinal: number
  heading: string | null
  charStart: number
  charEnd: number
}

export interface Citation {
  n: number
  documentId: string
  versionId: string
  versionNo: number
  title: string
  chunkId: string
  charStart: number
  charEnd: number
  quote: string
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'

export interface DropSummary {
  reason: string
  count: number
  staleIndex: number
}

export interface RetrievalInfo {
  candidates?: number
  belowThreshold?: number
  kept?: number
  dropped?: DropSummary[]
  claimedGroups?: string[]
  liveGroups?: string[]
  ms?: number
  fromCache?: boolean
}

export interface CacheInfo {
  status?: 'hit' | 'miss' | 'rejected'
  reason?: string
  fromRunId?: string
  cachedAt?: string
  validatedDocuments?: number
  scrubbed?: string
}

export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  queueMs: number | null
  retrievalMs: number | null
  ttftMs: number | null
  generationMs: number | null
}

export interface Run {
  id: string
  question: string
  status: RunStatus
  outputText: string
  redacted: string | null
  error: string | null
  sources: SourceRef[]
  citations: Citation[]
  retrieval: RetrievalInfo
  cache: CacheInfo
  model: string | null
  executor: string | null
  usage: Usage
  createdAt: string | null
  startedAt: string | null
  firstTokenAt: string | null
  finishedAt: string | null
}

export interface GroupMember {
  userId: string
  displayName: string
  username: string
  addedAt: string
}

export interface Group {
  id: string
  name: string
  documentCount: number
  members: GroupMember[]
}

export interface OrgUser {
  id: string
  displayName: string
  username: string
  role: string
}

export type ChaosName = 'kill_mid_chunk' | 'blob_outage' | 'acl_sync_paused' | 'purge_paused' | 'activation_delay_ms'

export interface EmbedderSettings {
  settings: { latencyMs: number; failureRate: number; retryAfterSeconds: number; armed: { rate_limited: number; server_error: number } }
  stats: Record<string, number>
}

export interface ModelSettings {
  settings: {
    ttftMs: number
    tokensPerSecond: number
    maxConcurrent: number
    failureRate: number
    disconnectAfterTokens: number
    armed: { overloaded: number; server_error: number; midstream_disconnect: number }
  }
  stats: Record<string, number>
  active: number
}

export interface OpsOverview {
  queue: { ready: number; unacked: number; consumers: number; poison: number } | null
  jobs: { stage: string; status: string; n: number }[]
  runningByWorker: { worker: string; running: number }[]
  poisoned: {
    id: string
    documentId: string
    versionId: string | null
    stage: string
    attempts: number
    maxAttempts: number
    lastError: string | null
    finishedAt: string | null
    orgName: string
  }[]
  purgeBacklog: { documentId: string; orgName: string; deletedAt: string; purgeCompletedAt: string | null; purge: PurgeState | null }[]
  staleIndex: { rows: number; documents: number; oldestChangeAt: string | null }
  runs: {
    id: string
    status: RunStatus
    cacheStatus: string | null
    citations: number
    inputTokens: number | null
    outputTokens: number | null
    queueMs: number | null
    retrievalMs: number | null
    ttftMs: number | null
    generationMs: number | null
    createdAt: string
  }[]
  chaos: Record<ChaosName, number>
  embedder: EmbedderSettings | null
  model: ModelSettings | null
}

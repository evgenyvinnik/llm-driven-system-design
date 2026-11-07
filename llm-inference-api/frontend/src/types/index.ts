export interface User {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  lastUsedAt: string | null
}

export interface Org {
  id: string
  slug: string
  name: string
  tier: string
  isMember: boolean
  limits: { tokensPerMinute: number; requestsPerMinute: number; maxQueuedInteractive: number; maxQueuedBatch: number; weight: number }
  tokensAvailable: number
  keys: ApiKey[]
}

export type RequestStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
export type Mode = 'sync' | 'stream' | 'async'
export type Priority = 'interactive' | 'batch'

export interface Usage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reservedTokens: number
  refundedTokens: number
  queueMs: number | null
  ttftMs: number | null
  execMs: number | null
  totalMs: number | null
  tokensPerSec: number | null
}

export interface RequestRecord {
  id: string
  orgId: string
  apiKeyId: string
  keyName?: string
  orgName?: string
  model: string
  mode: Mode
  priorityClass: Priority
  status: RequestStatus
  maxTokens: number
  estimatedInputTokens: number
  reservedTokens: number
  prefixKey: string
  input: { system: string | null; messages: { role: string; content: string }[] } | null
  outputText: string | null
  stopReason: string | null
  error: { type: string; message: string } | null
  cancelReason: string | null
  backendId: string | null
  modelVersion: string | null
  batchId: string | null
  attempts: number
  affinity: 'primary' | 'spill' | null
  createdAt: string
  dispatchedAt: string | null
  firstTokenAt: string | null
  finishedAt: string | null
  deadlineAt: string
  usage: Usage | null
}

export interface BackendView {
  id: string
  url: string
  reachable: boolean
  routable?: boolean
  status: 'ok' | 'draining' | 'restarting' | 'unknown'
  version?: string
  targetVersion?: string | null
  batching?: string
  slots?: number
  inUse?: number
  active?: number
  prefilling?: number
  decoding?: number
  dispatcherInflight?: number
  cooldownReason?: string | null
  cache?: { entries: number; capacity: number; hitRate: number | null; hits: number; misses: number }
  chaos?: Record<string, number>
  settings?: Record<string, number>
  counters?: Record<string, number>
}

export interface QueueView {
  class: Priority
  depth: number
  limit: number
  oldestWaitMs: number | null
  tenants: { orgId: string; orgName: string; depth: number }[]
}

export interface BatchRow {
  id: string
  priorityClass: Priority
  size: number
  maxSize: number
  trigger: 'full' | 'max_wait' | 'deadline'
  oldestWaitMs: number
  backends: Record<string, number>
  createdAt: string
}

export interface TenantUsage {
  orgId: string
  orgName: string
  tier: string
  requests: number
  completed: number
  cancelled: number
  failed: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  refundedTokens: number
  p50QueueMs: number | null
  p95QueueMs: number | null
  p50TtftMs: number | null
  admitted: number
  rateLimited: number
  overloaded: number
}

export interface RuntimeConfig {
  batchMaxSize: number
  interactiveMaxWaitMs: number
  batchMaxWaitMs: number
  deadlineSlackMs: number
  interactiveQueueLimit: number
  batchQueueLimit: number
  batchMinShare: number
  batchMaxShare: number
}

export interface Overview {
  generatedAt: string
  queues: QueueView[]
  backends: BackendView[]
  batches: { recent: BatchRow[]; summary: { priorityClass: Priority; trigger: string; count: number; avgFill: number; avgSize: number; avgOldestWaitMs: number }[] }
  usage: TenantUsage[]
  latency: { priorityClass: Priority; count: number; queueP50Ms: number | null; queueP95Ms: number | null; ttftP50Ms: number | null; ttftP95Ms: number | null; totalP50Ms: number | null; tokensPerSec: number | null }[]
  config: RuntimeConfig
  dispatcher: { leader: string | null; inflight: number }
  open: { priorityClass: Priority; status: RequestStatus; count: number }[]
}

export interface MembershipChange {
  backend: string
  keys: number
  movedConsistent: number
  movedModulo: number
  shares: Record<string, number>
}

export interface RoutingView {
  backends: string[]
  virtualNodes: number
  epsilon: number
  lowLoadFraction: number
  shares: Record<string, number>
  add: MembershipChange
  remove: MembershipChange
  observed: { affinity: string; count: number; cacheHits: number; ttftHitMs: number | null; ttftMissMs: number | null }[]
  prefixes: { prefixKey: string; requests: number; backends: number; mainBackend: string; owner: string; avgTtftMs: number | null }[]
}

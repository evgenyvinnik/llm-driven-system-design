/**
 * Row → DTO mapping. Handlers never return raw rows: every response is
 * camelCase and carries only what that caller may see.
 * @module api/services/dto
 */

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null)

export interface StageState {
  stage: string
  status: string
  attempts: number
  maxAttempts: number
  progress: Record<string, unknown>
  lastError: string | null
}

export interface PurgeState {
  done: number
  total: number
  completedAt: string | null
  lastError: string | null
  artifacts: { artifact: string; status: string; removed: number; attempts: number; lastError: string | null; completedAt: string | null }[]
}

export interface DocumentRow {
  id: string
  org_id: string
  owner_id: string
  owner_name?: string
  title: string
  scope: string
  group_id: string | null
  group_name?: string | null
  status: string
  current_version_id: string | null
  current_version_no: number | null
  latest_version_no: number
  content_hash: string | null
  acl_epoch: string | number
  failure_reason: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  purge_completed_at: Date | null
  latest_status?: string | null
  latest_failure?: string | null
  latest_filename?: string | null
  latest_size?: number | null
  chunk_count?: number | null
  stale_index_rows?: number | null
}

export function documentDto(r: DocumentRow, viewerId: string, stages: StageState[] = [], purge: PurgeState | null = null) {
  return {
    id: r.id,
    title: r.title,
    ownerId: r.owner_id,
    ownerName: r.owner_name ?? null,
    isOwner: r.owner_id === viewerId,
    scope: r.scope,
    groupId: r.group_id,
    groupName: r.group_name ?? null,
    status: r.status,
    currentVersionNo: r.current_version_no,
    latestVersionNo: r.latest_version_no,
    latestVersionStatus: r.latest_status ?? null,
    latestVersionFailure: r.latest_failure ?? null,
    filename: r.latest_filename ?? null,
    sizeBytes: r.latest_size ?? null,
    chunkCount: r.chunk_count ?? null,
    contentHash: r.content_hash,
    aclEpoch: Number(r.acl_epoch),
    staleIndexRows: r.stale_index_rows ?? 0,
    failureReason: r.failure_reason,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: iso(r.deleted_at),
    purgeCompletedAt: iso(r.purge_completed_at),
    stages,
    purge,
  }
}

export type DocumentDto = ReturnType<typeof documentDto>

export function versionDto(r: {
  id: string
  version_no: number
  content_hash: string
  filename: string
  mime_type: string
  size_bytes: number
  status: string
  failure_reason: string | null
  char_count: number | null
  chunk_count: number | null
  created_at: Date
  ready_at: Date | null
  activated_at: Date | null
  superseded_at: Date | null
  retired_at: Date | null
  live_chunks?: number
}) {
  return {
    id: r.id,
    versionNo: r.version_no,
    contentHash: r.content_hash,
    filename: r.filename,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    status: r.status,
    failureReason: r.failure_reason,
    charCount: r.char_count,
    chunkCount: r.chunk_count,
    liveChunks: r.live_chunks ?? 0,
    createdAt: iso(r.created_at),
    readyAt: iso(r.ready_at),
    activatedAt: iso(r.activated_at),
    supersededAt: iso(r.superseded_at),
    retiredAt: iso(r.retired_at),
  }
}

export function jobDto(
  r: {
    id: string
    version_id: string | null
    stage: string
    status: string
    attempts: number
    max_attempts: number
    progress: Record<string, unknown>
    last_error: string | null
    next_run_at: Date
    created_at: Date
    started_at: Date | null
    finished_at: Date | null
    lease_owner: string | null
  },
  attempts: {
    attempt_no: number
    worker_id: string
    started_at: Date
    finished_at: Date | null
    outcome: string | null
    error: string | null
    detail: Record<string, unknown>
  }[] = [],
) {
  return {
    id: r.id,
    versionId: r.version_id,
    stage: r.stage,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    progress: r.progress,
    lastError: r.last_error,
    nextRunAt: iso(r.next_run_at),
    leaseOwner: r.lease_owner,
    createdAt: iso(r.created_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    attemptLog: attempts.map((a) => ({
      attemptNo: a.attempt_no,
      workerId: a.worker_id,
      startedAt: iso(a.started_at),
      finishedAt: iso(a.finished_at),
      outcome: a.outcome,
      error: a.error,
      detail: a.detail,
    })),
  }
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

export interface RunRow {
  id: string
  user_id: string
  question: string
  status: string
  output_text: string
  error: string | null
  sources: SourceRef[]
  citations: Citation[]
  retrieval: Record<string, unknown>
  cache: Record<string, unknown>
  model: string | null
  executor: string | null
  input_tokens: number | null
  output_tokens: number | null
  queue_ms: number | null
  retrieval_ms: number | null
  ttft_ms: number | null
  generation_ms: number | null
  created_at: Date
  started_at: Date | null
  first_token_at: Date | null
  finished_at: Date | null
}

export function runDto(r: RunRow, redaction: string | null = null) {
  return {
    id: r.id,
    question: r.question,
    status: r.status,
    outputText: redaction ? '' : r.output_text,
    redacted: redaction,
    error: r.error,
    sources: redaction ? [] : r.sources,
    citations: redaction ? [] : r.citations,
    retrieval: r.retrieval,
    cache: r.cache,
    model: r.model,
    executor: r.executor,
    usage: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      queueMs: r.queue_ms,
      retrievalMs: r.retrieval_ms,
      ttftMs: r.ttft_ms,
      generationMs: r.generation_ms,
    },
    createdAt: iso(r.created_at),
    startedAt: iso(r.started_at),
    firstTokenAt: iso(r.first_token_at),
    finishedAt: iso(r.finished_at),
  }
}

export type RunDto = ReturnType<typeof runDto>

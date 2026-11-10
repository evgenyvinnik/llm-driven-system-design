/**
 * Failure classification and retry timing for model and judge calls. Pure.
 *
 * Transient (retry the task with backoff): 429 (honour Retry-After), 5xx and
 * 529 overload, client-side timeout, connection refused/reset, and a stream
 * that ends without its `done` event (mid-stream disconnect or error event).
 * Permanent (record and stop): 4xx other than 408/429, e.g. the case doesn't
 * fit the model's context window. Retrying those burns quota for nothing.
 *
 * Delays are only DECIDED here; the database writes `now() + delay`, so every
 * timestamp shares one clock (the Docker VM clock lags the host after sleeps).
 * @module shared/retry
 */

export type FailureKind =
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'stream_disconnected'
  | 'stream_error'
  | 'invalid_request'
  | 'context_length_exceeded'
  | 'auth'
  | 'bad_response'

export interface CallFailure {
  kind: FailureKind
  message: string
  httpStatus?: number
  /** Parsed Retry-After, milliseconds. */
  retryAfterMs?: number
}

const TRANSIENT: ReadonlySet<FailureKind> = new Set([
  'rate_limited',
  'overloaded',
  'server_error',
  'timeout',
  'network',
  'stream_disconnected',
  'stream_error',
])

export function isTransient(kind: FailureKind): boolean {
  return TRANSIENT.has(kind)
}

/** Maps an HTTP error response (status + provider error type) to a failure kind. */
export function classifyHttpFailure(status: number, errorType?: string): FailureKind {
  if (status === 429) return 'rate_limited'
  if (status === 529 || status === 503 || errorType === 'overloaded_error') return 'overloaded'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500) return 'server_error'
  if (status === 401 || status === 403) return 'auth'
  if (errorType === 'context_length_exceeded') return 'context_length_exceeded'
  return 'invalid_request'
}

/** Retry-After as seconds or an HTTP date; clamped to [0, maxMs]. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number, maxMs = 60_000): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.min(maxMs, Math.max(0, Math.round(seconds * 1000)))
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.min(maxMs, Math.max(0, date - nowMs))
  return undefined
}

/** Full jitter: attempt n (1-based) waits uniform(0, min(cap, base·2^(n−1))). */
export function backoffMs(attempt: number, baseMs: number, capMs: number, rand: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))
  return Math.floor(rand() * ceiling)
}

export type RetryDecision = { action: 'retry'; delayMs: number; reason: string } | { action: 'give_up'; reason: string }

/**
 * What to do after attempt `attempt` (1-based, counted within the current
 * retry round) failed with `failure`.
 */
export function decideRetry(
  failure: CallFailure,
  attempt: number,
  policy: { maxAttempts: number; baseMs: number; capMs: number },
  rand: () => number = Math.random,
): RetryDecision {
  if (!isTransient(failure.kind)) return { action: 'give_up', reason: `permanent: ${failure.kind}` }
  if (attempt >= policy.maxAttempts) return { action: 'give_up', reason: `retries exhausted after ${attempt} attempts (last: ${failure.kind})` }
  const jittered = backoffMs(attempt, policy.baseMs, policy.capMs, rand)
  // The server told us when to come back: never earlier than that.
  const delayMs = failure.retryAfterMs !== undefined ? Math.max(failure.retryAfterMs, jittered) : jittered
  return { action: 'retry', delayMs, reason: failure.kind }
}

/**
 * Failure classification and the outcome of one attempt.
 *
 * | Result                         | Class            | Disposition                     |
 * |--------------------------------|------------------|---------------------------------|
 * | 2xx                            | ok               | delivered                       |
 * | 5xx, 408, 425                  | http_5xx/http_4xx| retry with backoff              |
 * | 429                            | http_429         | retry after Retry-After; pause the endpoint until then |
 * | timeout, reset, refused        | timeout / connection_error | retry                 |
 * | DNS failure                    | dns_error        | retry (DNS outages are transient) |
 * | 410 Gone                       | http_410         | fail, disable the endpoint      |
 * | invalid URL, SSRF-blocked      | invalid_url / ssrf_blocked | fail, disable the endpoint |
 * | 3xx                            | http_3xx         | fail (redirects are never followed) |
 * | other 4xx                      | http_4xx         | fail this delivery only         |
 *
 * Other 4xx are permanent for that delivery: the receiver read the request
 * and refused it, and the same bytes will get the same answer. Retrying for
 * three days would only fill the receiver's logs. The customer fixes their
 * handler and replays. The endpoint stays enabled because other events may
 * be accepted.
 * @module delivery/classify
 */
import { fullJitterDelayMs } from './backoff.js'

export type ErrorClass =
  | 'ok'
  | 'http_5xx'
  | 'http_429'
  | 'http_410'
  | 'http_4xx'
  | 'http_3xx'
  | 'timeout'
  | 'connection_error'
  | 'dns_error'
  | 'ssrf_blocked'
  | 'invalid_url'

export type Disposition = 'delivered' | 'retry' | 'fail' | 'fail_and_disable'

export interface Classification {
  errorClass: ErrorClass
  disposition: Disposition
}

export function classifyStatus(status: number): Classification {
  if (status >= 200 && status < 300) return { errorClass: 'ok', disposition: 'delivered' }
  if (status === 429) return { errorClass: 'http_429', disposition: 'retry' }
  if (status === 410) return { errorClass: 'http_410', disposition: 'fail_and_disable' }
  if (status === 408 || status === 425) return { errorClass: 'http_4xx', disposition: 'retry' }
  if (status >= 500) return { errorClass: 'http_5xx', disposition: 'retry' }
  if (status >= 400) return { errorClass: 'http_4xx', disposition: 'fail' }
  if (status >= 300) return { errorClass: 'http_3xx', disposition: 'fail' }
  // 1xx or nonsense: treat as a transient protocol problem.
  return { errorClass: 'connection_error', disposition: 'retry' }
}

export function classifyTransportError(kind: 'timeout' | 'connection_error' | 'dns_error' | 'ssrf_blocked' | 'invalid_url'): Classification {
  switch (kind) {
    case 'timeout':
    case 'connection_error':
    case 'dns_error':
      return { errorClass: kind, disposition: 'retry' }
    case 'ssrf_blocked':
    case 'invalid_url':
      return { errorClass: kind, disposition: 'fail_and_disable' }
  }
}

export interface OutcomeInput {
  classification: Classification
  /** Number of the attempt that just finished (1-based). */
  attemptNo: number
  now: Date
  retryDeadline: Date
  /** Seconds from a 429's Retry-After header, if any. */
  retryAfterSeconds: number | null
  policy: { backoffBaseMs: number; backoffCapMs: number; maxRetryAfterSeconds: number }
  random?: () => number
}

export interface Outcome {
  state: 'delivered' | 'scheduled' | 'failed'
  /** Stored on the attempt row. */
  outcome: 'delivered' | 'retry' | 'failed'
  nextAttemptAt: Date | null
  delayMs: number | null
  /** The retry window ran out on this attempt. */
  exhausted: boolean
  /** Disable the endpoint now (410, invalid URL, SSRF block). */
  disableReason: string | null
  /** 429: hold every delivery to this endpoint until then. */
  pauseUntil: Date | null
  /** Counts toward the endpoint's consecutive-failure streak (transient failures and 410). */
  endpointFailure: boolean
}

export function decideOutcome(input: OutcomeInput): Outcome {
  const { classification: c, now } = input
  const base = { pauseUntil: null, disableReason: null, exhausted: false, nextAttemptAt: null, delayMs: null }
  if (c.disposition === 'delivered') return { ...base, state: 'delivered', outcome: 'delivered', endpointFailure: false }
  if (c.disposition === 'fail') return { ...base, state: 'failed', outcome: 'failed', endpointFailure: false }
  if (c.disposition === 'fail_and_disable') {
    const reason = c.errorClass === 'http_410' ? 'gone_410' : c.errorClass
    return { ...base, state: 'failed', outcome: 'failed', disableReason: reason, endpointFailure: true }
  }
  let delayMs: number
  if (c.errorClass === 'http_429' && input.retryAfterSeconds !== null) {
    delayMs = Math.min(input.retryAfterSeconds, input.policy.maxRetryAfterSeconds) * 1000
  } else {
    delayMs = fullJitterDelayMs(input.attemptNo, input.policy.backoffBaseMs, input.policy.backoffCapMs, input.random)
  }
  const nextAttemptAt = new Date(now.getTime() + delayMs)
  const pauseUntil = c.errorClass === 'http_429' ? nextAttemptAt : null
  if (nextAttemptAt.getTime() > input.retryDeadline.getTime()) {
    return { ...base, state: 'failed', outcome: 'failed', exhausted: true, pauseUntil, endpointFailure: true, delayMs }
  }
  return { ...base, state: 'scheduled', outcome: 'retry', nextAttemptAt, delayMs, pauseUntil, endpointFailure: true }
}

/**
 * End of a delivery's retry window. The window opens at the delivery's first
 * attempt (or the first attempt after a replay), never at event creation: if
 * the platform was down or backlogged for longer than the horizon, the first
 * attempt still gets a full window, and an endpoint is only disabled after it
 * has itself failed for the whole horizon.
 */
export function retryWindowDeadline(windowStartedAt: Date | null, attemptStartedAt: Date, horizonSeconds: number): Date {
  return new Date((windowStartedAt ?? attemptStartedAt).getTime() + horizonSeconds * 1000)
}

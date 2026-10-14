/**
 * Crawl politeness policy: how to ask a feed for changes, and when to ask again.
 *
 * Everything here is a pure function with no I/O, so the scheduling rules can
 * be unit-tested without a network or a database. The crawler applies them:
 * - Conditional GETs replay the validators (ETag, Last-Modified) of the last
 *   successful fetch, so an unchanged feed costs a 304 with no body to parse.
 * - A source that fails waits interval * 2^failures before the next attempt
 *   (capped), and never sooner than the Retry-After it sent.
 * - Every delay gets +/-10% jitter so sources added together drift apart
 *   instead of being fetched in lockstep forever.
 * @module services/crawl-policy
 */

/** How one fetch attempt ended, from the scheduler's point of view. */
export type FetchOutcomeKind = 'fetched' | 'not_modified' | 'failed';

/** Validators remembered from the last 200 response for a source. */
export interface ConditionalValidators {
  etag: string | null;
  lastModified: string | null;
}

/** Inputs for computing the next crawl time of one source. */
export interface NextCrawlInput {
  /** Outcome of the attempt that just finished */
  outcome: FetchOutcomeKind;
  /** The source's normal polling interval */
  intervalMinutes: number;
  /** Consecutive failures including this attempt (0 after a success) */
  consecutiveFailures: number;
  /** Delay the server asked for via Retry-After, if any */
  retryAfterSeconds?: number | null;
  /** Upper bound for backoff and for honoring Retry-After */
  maxBackoffMinutes: number;
  /** Injectable randomness for tests (defaults to Math.random) */
  random?: () => number;
}

/** Highest exponent used for backoff; 2^16 already exceeds any sane cap. */
const MAX_BACKOFF_EXPONENT = 16;

/** Jitter applied to every delay: the result lands in [0.9, 1.1] x base. */
const JITTER_FRACTION = 0.1;

/**
 * Build conditional-GET request headers from stored validators.
 * Sending both is correct: servers that support ETags prefer If-None-Match,
 * and older servers fall back to If-Modified-Since.
 * @param validators - Validators from the last 200 response
 * @returns Headers to merge into the feed request (possibly empty)
 */
export function conditionalHeaders(validators: ConditionalValidators): Record<string, string> {
  const headers: Record<string, string> = {};
  if (validators.etag) headers['If-None-Match'] = validators.etag;
  if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;
  return headers;
}

/**
 * Map an HTTP status to a crawl outcome.
 * 2xx means a body to parse, 304 means nothing changed, everything else
 * (including redirects fetch() could not follow) counts as a failure.
 * @param status - HTTP status code
 * @returns The crawl outcome kind
 */
export function classifyStatus(status: number): FetchOutcomeKind {
  if (status === 304) return 'not_modified';
  if (status >= 200 && status < 300) return 'fetched';
  return 'failed';
}

/**
 * Parse a Retry-After header (RFC 9110): either delay-seconds or an HTTP-date.
 * @param value - Raw header value
 * @param nowMs - Current time in epoch milliseconds (injectable for tests)
 * @returns Seconds to wait, or null when the header is absent or invalid
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
}

/**
 * Compute how many seconds to wait before crawling a source again.
 * - fetched / not_modified: the source's own interval.
 * - failed: interval x 2^failures, capped at maxBackoffMinutes, so a feed that
 *   has been down all day is asked once an hour or so instead of every cycle.
 * - Retry-After is a floor (also capped): we never come back sooner than the
 *   server asked.
 * @param input - Outcome, interval, failure count and server hints
 * @returns Delay in whole seconds (at least 1)
 */
export function nextCrawlDelaySeconds(input: NextCrawlInput): number {
  const random = input.random ?? Math.random;
  const intervalSeconds = Math.max(1, input.intervalMinutes) * 60;
  const capSeconds = Math.max(intervalSeconds, input.maxBackoffMinutes * 60);

  let base = intervalSeconds;
  if (input.outcome === 'failed') {
    const exponent = Math.min(Math.max(input.consecutiveFailures, 1), MAX_BACKOFF_EXPONENT);
    base = Math.min(intervalSeconds * 2 ** exponent, capSeconds);
  }

  const jitter = 1 - JITTER_FRACTION + 2 * JITTER_FRACTION * random();
  const jittered = Math.min(Math.round(base * jitter), capSeconds);
  const retryAfter = input.retryAfterSeconds ? Math.min(input.retryAfterSeconds, capSeconds) : 0;

  return Math.max(jittered, retryAfter, 1);
}

import { describe, expect, it } from 'vitest'
import { backoffCeilingMs, fullJitterDelayMs, parseRetryAfter } from './backoff.js'
import { classifyStatus, classifyTransportError, decideOutcome, retryWindowDeadline, type Classification } from './classify.js'
import { matchesEventType } from './filter.js'

const policy = { backoffBaseMs: 1000, backoffCapMs: 20_000, maxRetryAfterSeconds: 60 }
const now = new Date('2026-11-05T12:00:00Z')
const deadline = new Date(now.getTime() + 180_000)

function outcome(c: Classification, extra: Partial<Parameters<typeof decideOutcome>[0]> = {}) {
  return decideOutcome({ classification: c, attemptNo: 1, now, retryDeadline: deadline, retryAfterSeconds: null, policy, random: () => 0.5, ...extra })
}

describe('backoff with full jitter', () => {
  it('doubles the ceiling per attempt up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffCeilingMs(n, 1000, 20_000))).toEqual([1000, 2000, 4000, 8000, 16000, 20000, 20000])
  })

  it('draws uniformly between 0 and the ceiling', () => {
    expect(fullJitterDelayMs(4, 1000, 20_000, () => 0)).toBe(0)
    expect(fullJitterDelayMs(4, 1000, 20_000, () => 0.999)).toBe(7992)
    const draws = Array.from({ length: 2000 }, () => fullJitterDelayMs(3, 1000, 20_000))
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...draws)).toBeLessThan(4000)
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length
    expect(mean).toBeGreaterThan(1700)
    expect(mean).toBeLessThan(2300)
  })

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('7')).toBe(7)
    expect(parseRetryAfter(new Date(now.getTime() + 30_000).toUTCString(), now)).toBe(30)
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
  })
})

describe('classification', () => {
  it('retries 5xx, 429, 408, timeouts, connection errors and DNS errors', () => {
    expect(classifyStatus(500).disposition).toBe('retry')
    expect(classifyStatus(503).disposition).toBe('retry')
    expect(classifyStatus(429)).toEqual({ errorClass: 'http_429', disposition: 'retry' })
    expect(classifyStatus(408).disposition).toBe('retry')
    for (const k of ['timeout', 'connection_error', 'dns_error'] as const) expect(classifyTransportError(k).disposition).toBe('retry')
  })

  it('stops on 410 and on invalid or blocked URLs, and disables the endpoint', () => {
    expect(classifyStatus(410)).toEqual({ errorClass: 'http_410', disposition: 'fail_and_disable' })
    expect(classifyTransportError('ssrf_blocked').disposition).toBe('fail_and_disable')
    expect(classifyTransportError('invalid_url').disposition).toBe('fail_and_disable')
  })

  it('treats other 4xx and redirects as permanent for that delivery only', () => {
    expect(classifyStatus(400)).toEqual({ errorClass: 'http_4xx', disposition: 'fail' })
    expect(classifyStatus(401).disposition).toBe('fail')
    expect(classifyStatus(404).disposition).toBe('fail')
    expect(classifyStatus(302)).toEqual({ errorClass: 'http_3xx', disposition: 'fail' })
    expect(classifyStatus(204)).toEqual({ errorClass: 'ok', disposition: 'delivered' })
  })
})

describe('decideOutcome', () => {
  it('schedules a jittered retry inside the window', () => {
    const o = outcome(classifyStatus(503), { attemptNo: 3 })
    expect(o).toMatchObject({ state: 'scheduled', outcome: 'retry', delayMs: 2000, endpointFailure: true, exhausted: false })
    expect(o.nextAttemptAt?.toISOString()).toBe('2026-11-05T12:00:02.000Z')
  })

  it('fails as exhausted when the next attempt would land past the horizon', () => {
    const o = outcome(classifyStatus(503), { attemptNo: 9, retryDeadline: new Date(now.getTime() + 5_000) })
    expect(o).toMatchObject({ state: 'failed', outcome: 'failed', exhausted: true })
  })

  it('honours Retry-After on 429 (clamped) and pauses the endpoint until then', () => {
    const o = outcome(classifyStatus(429), { retryAfterSeconds: 7 })
    expect(o.delayMs).toBe(7000)
    expect(o.pauseUntil?.toISOString()).toBe('2026-11-05T12:00:07.000Z')
    expect(outcome(classifyStatus(429), { retryAfterSeconds: 3600 }).delayMs).toBe(60_000)
  })

  it('disables on 410 without retrying, and leaves the endpoint alone on a 400', () => {
    expect(outcome(classifyStatus(410))).toMatchObject({ state: 'failed', disableReason: 'gone_410', nextAttemptAt: null })
    expect(outcome(classifyStatus(400))).toMatchObject({ state: 'failed', disableReason: null, endpointFailure: false })
    expect(outcome(classifyStatus(200))).toMatchObject({ state: 'delivered', endpointFailure: false })
  })
})

describe('retry window', () => {
  it('opens at the first attempt, so a platform outage longer than the horizon does not exhaust it', () => {
    // Event created at 12:00, platform asleep until 12:30, horizon 3 minutes.
    const firstAttempt = new Date('2026-11-05T12:30:00Z')
    const deadline = retryWindowDeadline(null, firstAttempt, 180)
    expect(deadline.toISOString()).toBe('2026-11-05T12:33:00.000Z')
    const o = decideOutcome({ classification: classifyStatus(503), attemptNo: 1, now: firstAttempt, retryDeadline: deadline, retryAfterSeconds: null, policy, random: () => 0.5 })
    expect(o).toMatchObject({ state: 'scheduled', exhausted: false })
  })

  it('keeps the window that opened at the first attempt for later retries', () => {
    const opened = new Date('2026-11-05T12:30:00Z')
    expect(retryWindowDeadline(opened, new Date('2026-11-05T12:32:00Z'), 180).toISOString()).toBe('2026-11-05T12:33:00.000Z')
  })
})

describe('event-type filters', () => {
  it('matches *, families and exact types', () => {
    expect(matchesEventType(['*'], 'invoice.paid')).toBe(true)
    expect(matchesEventType(['order.*'], 'order.created')).toBe(true)
    expect(matchesEventType(['order.*'], 'orders.created')).toBe(false)
    expect(matchesEventType(['invoice.paid'], 'invoice.paid')).toBe(true)
    expect(matchesEventType(['invoice.paid'], 'invoice.failed')).toBe(false)
    expect(matchesEventType([], 'invoice.paid')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { backoffMs, classifyHttpFailure, decideRetry, isTransient, parseRetryAfter } from './retry.js'

const policy = { maxAttempts: 4, baseMs: 500, capMs: 8000 }

describe('classification', () => {
  it('maps HTTP failures to kinds', () => {
    expect(classifyHttpFailure(429)).toBe('rate_limited')
    expect(classifyHttpFailure(529)).toBe('overloaded')
    expect(classifyHttpFailure(503)).toBe('overloaded')
    expect(classifyHttpFailure(500)).toBe('server_error')
    expect(classifyHttpFailure(504)).toBe('timeout')
    expect(classifyHttpFailure(400, 'context_length_exceeded')).toBe('context_length_exceeded')
    expect(classifyHttpFailure(400, 'invalid_request_error')).toBe('invalid_request')
    expect(classifyHttpFailure(401)).toBe('auth')
  })

  it('treats overload, rate limits, timeouts and broken streams as transient', () => {
    for (const k of ['rate_limited', 'overloaded', 'server_error', 'timeout', 'network', 'stream_disconnected', 'stream_error'] as const) expect(isTransient(k)).toBe(true)
    for (const k of ['invalid_request', 'context_length_exceeded', 'auth', 'bad_response'] as const) expect(isTransient(k)).toBe(false)
  })
})

describe('Retry-After', () => {
  it('parses seconds and HTTP dates, clamped', () => {
    expect(parseRetryAfter('2', 0)).toBe(2000)
    expect(parseRetryAfter('0.5', 0)).toBe(500)
    expect(parseRetryAfter('9999', 0, 60_000)).toBe(60_000)
    const now = Date.parse('2026-11-06T10:00:00Z')
    expect(parseRetryAfter('Fri, 06 Nov 2026 10:00:05 GMT', now)).toBe(5000)
    expect(parseRetryAfter(null, 0)).toBeUndefined()
    expect(parseRetryAfter('soon', 0)).toBeUndefined()
  })
})

describe('backoff', () => {
  it('full jitter stays within the exponential ceiling and the cap', () => {
    expect(backoffMs(1, 500, 8000, () => 0.999)).toBeLessThan(500)
    expect(backoffMs(3, 500, 8000, () => 0.999)).toBeLessThan(2000)
    expect(backoffMs(10, 500, 8000, () => 0.999)).toBeLessThan(8000)
    expect(backoffMs(2, 500, 8000, () => 0)).toBe(0)
  })
})

describe('decideRetry', () => {
  it('retries transient failures until the attempt budget runs out', () => {
    expect(decideRetry({ kind: 'overloaded', message: '' }, 1, policy, () => 0.5)).toEqual({ action: 'retry', delayMs: 250, reason: 'overloaded' })
    expect(decideRetry({ kind: 'timeout', message: '' }, 4, policy).action).toBe('give_up')
  })

  it('never retries sooner than Retry-After', () => {
    const d = decideRetry({ kind: 'rate_limited', message: '', retryAfterMs: 1000 }, 1, policy, () => 0.1)
    expect(d).toEqual({ action: 'retry', delayMs: 1000, reason: 'rate_limited' })
  })

  it('gives up immediately on permanent failures', () => {
    const d = decideRetry({ kind: 'context_length_exceeded', message: '' }, 1, policy)
    expect(d.action).toBe('give_up')
    expect(d.reason).toContain('permanent')
  })
})

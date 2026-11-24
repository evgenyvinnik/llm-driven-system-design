import { describe, it, expect, vi } from 'vitest';

vi.mock('../models/redis.js', () => ({ redis: { set: vi.fn(), del: vi.fn(), get: vi.fn() } }));

import { CircuitState as CockatielCircuitState, BrokenCircuitError } from 'cockatiel';
import {
  toCircuitState,
  CircuitState,
  isRetryableError,
  isCircuitOpenError,
} from './resilience.js';

describe('toCircuitState', () => {
  // Regression: cockatiel's enum is numeric, and the old code compared
  // state.toString() ('0', '2') against 'closed'/'halfOpen', so every
  // transition - including recovery - was published to Redis as OPEN.
  it('maps cockatiel numeric states to our string states', () => {
    expect(toCircuitState(CockatielCircuitState.Closed)).toBe(CircuitState.CLOSED);
    expect(toCircuitState(CockatielCircuitState.HalfOpen)).toBe(CircuitState.HALF_OPEN);
    expect(toCircuitState(CockatielCircuitState.Open)).toBe(CircuitState.OPEN);
    expect(toCircuitState(CockatielCircuitState.Isolated)).toBe(CircuitState.OPEN);
  });
});

describe('isRetryableError', () => {
  it('treats timeouts, resets and 5xx as transient', () => {
    expect(isRetryableError({ code: 'ECONNABORTED' })).toBe(true);
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ response: { status: 503 } })).toBe(true);
  });

  it('treats 4xx and unknown errors as permanent', () => {
    expect(isRetryableError({ response: { status: 404 } })).toBe(false);
    expect(isRetryableError(new Error('maxContentLength size of 10 exceeded'))).toBe(false);
  });
});

describe('isCircuitOpenError', () => {
  it('recognizes cockatiel BrokenCircuitError', () => {
    expect(isCircuitOpenError(new BrokenCircuitError())).toBe(true);
    expect(isCircuitOpenError(new Error('x'))).toBe(false);
  });
});

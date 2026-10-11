import { describe, it, expect } from 'vitest';
import {
  parseClickEventMessage,
  deriveLegacyEventId,
  decideFailureAction,
  classifyProcessingError,
  readRetryCount,
  stripBrokerHeaders,
} from './clickEvents.js';

const validEvent = {
  event_id: '3f1c9a52-6b7e-4d43-9a3e-2f5b8c1d0e47',
  short_code: 'abc123x',
  referrer: 'https://news.ycombinator.com',
  user_agent: 'Mozilla/5.0',
  ip_address: '203.0.113.7',
  device_type: 'desktop',
  timestamp: '2026-10-10T12:00:00.000Z',
};

describe('parseClickEventMessage', () => {
  it('accepts a well-formed event', () => {
    const result = parseClickEventMessage(Buffer.from(JSON.stringify(validEvent)));
    expect(result).toEqual({ ok: true, legacyId: false, event: validEvent });
  });

  it('rejects invalid JSON as malformed', () => {
    expect(parseClickEventMessage(Buffer.from('{not json'))).toEqual({
      ok: false,
      error: 'payload is not valid JSON',
    });
  });

  it('rejects non-object payloads', () => {
    expect(parseClickEventMessage('[1,2]').ok).toBe(false);
    expect(parseClickEventMessage('"text"').ok).toBe(false);
    expect(parseClickEventMessage('null').ok).toBe(false);
  });

  it('rejects missing or impossible short codes', () => {
    expect(parseClickEventMessage(JSON.stringify({ ...validEvent, short_code: undefined })).ok).toBe(false);
    expect(parseClickEventMessage(JSON.stringify({ ...validEvent, short_code: 'way-too-long-code' })).ok).toBe(false);
  });

  it('rejects an invalid timestamp', () => {
    const result = parseClickEventMessage(JSON.stringify({ ...validEvent, timestamp: 'yesterday' }));
    expect(result).toEqual({ ok: false, error: 'timestamp is missing or invalid' });
  });

  it('rejects non-string optional fields', () => {
    const result = parseClickEventMessage(JSON.stringify({ ...validEvent, referrer: 42 }));
    expect(result).toEqual({ ok: false, error: 'referrer must be a string' });
  });

  it('rejects an event_id that is not a UUID', () => {
    const result = parseClickEventMessage(JSON.stringify({ ...validEvent, event_id: 'abc' }));
    expect(result).toEqual({ ok: false, error: 'event_id is not a UUID' });
  });

  it('derives a stable id for legacy messages without event_id', () => {
    const { event_id: _omit, ...legacy } = validEvent;
    const raw = Buffer.from(JSON.stringify(legacy));
    const first = parseClickEventMessage(raw);
    const redelivered = parseClickEventMessage(Buffer.from(raw));
    expect(first.ok && first.legacyId).toBe(true);
    if (!first.ok || !redelivered.ok) throw new Error('expected success');
    expect(first.event.event_id).toBe(redelivered.event.event_id);
    expect(first.event.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('defaults a missing device_type to unknown', () => {
    const result = parseClickEventMessage(JSON.stringify({ ...validEvent, device_type: undefined }));
    expect(result.ok && result.event.device_type).toBe('unknown');
  });
});

describe('deriveLegacyEventId', () => {
  it('maps different payloads to different ids', () => {
    expect(deriveLegacyEventId('{"a":1}')).not.toBe(deriveLegacyEventId('{"a":2}'));
  });
});

describe('decideFailureAction', () => {
  it('retries transient failures with an incremented counter', () => {
    expect(decideFailureAction(0, 5, 'transient')).toEqual({ action: 'retry', retryCount: 1 });
    expect(decideFailureAction(3, 5, 'transient')).toEqual({ action: 'retry', retryCount: 4 });
  });

  it('dead-letters once the attempt budget is used up', () => {
    // retryCount 4 means this was the 5th attempt
    expect(decideFailureAction(4, 5, 'transient')).toEqual({ action: 'dead-letter', reason: 'max_attempts' });
    expect(decideFailureAction(9, 5, 'transient')).toEqual({ action: 'dead-letter', reason: 'max_attempts' });
  });

  it('dead-letters permanent failures immediately', () => {
    expect(decideFailureAction(0, 5, 'permanent')).toEqual({ action: 'dead-letter', reason: 'permanent_error' });
  });

  it('never retries when only one attempt is allowed', () => {
    expect(decideFailureAction(0, 1, 'transient')).toEqual({ action: 'dead-letter', reason: 'max_attempts' });
  });
});

describe('classifyProcessingError', () => {
  it('treats data exceptions and integrity violations as permanent', () => {
    expect(classifyProcessingError(Object.assign(new Error('fk'), { code: '23503' }))).toBe('permanent');
    expect(classifyProcessingError(Object.assign(new Error('bad inet'), { code: '22P02' }))).toBe('permanent');
  });

  it('treats connection and unknown errors as transient', () => {
    expect(classifyProcessingError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe('transient');
    expect(classifyProcessingError(Object.assign(new Error('deadlock'), { code: '40P01' }))).toBe('transient');
    expect(classifyProcessingError(new Error('boom'))).toBe('transient');
    expect(classifyProcessingError('string error')).toBe('transient');
  });
});

describe('readRetryCount', () => {
  it('reads numeric and string headers', () => {
    expect(readRetryCount({ 'x-retry-count': 3 })).toBe(3);
    expect(readRetryCount({ 'x-retry-count': '2' })).toBe(2);
  });

  it('defaults to 0 for missing or invalid values', () => {
    expect(readRetryCount(undefined)).toBe(0);
    expect(readRetryCount({})).toBe(0);
    expect(readRetryCount({ 'x-retry-count': -1 })).toBe(0);
    expect(readRetryCount({ 'x-retry-count': 'many' })).toBe(0);
  });
});

describe('stripBrokerHeaders', () => {
  it('drops dead-lettering bookkeeping but keeps our headers', () => {
    expect(
      stripBrokerHeaders({
        'x-death': [{ count: 1 }],
        'x-first-death-queue': 'click-events.retry',
        'x-last-death-reason': 'expired',
        'x-retry-count': 2,
        'x-last-error': 'timeout',
      })
    ).toEqual({ 'x-retry-count': 2, 'x-last-error': 'timeout' });
  });
});

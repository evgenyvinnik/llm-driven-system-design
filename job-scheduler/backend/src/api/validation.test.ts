import { describe, it, expect } from 'vitest';
import { validateCreateJob, validateUpdateJob } from './validation';

describe('validateCreateJob', () => {
  it('accepts a recurring job and normalizes it', () => {
    const result = validateCreateJob({
      name: '  nightly-report ',
      handler: 'test.echo',
      schedule: ' 0 2 * * * ',
      priority: 70,
      max_retries: 3,
      misfire_policy: 'skip',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'nightly-report',
        handler: 'test.echo',
        schedule: '0 2 * * *',
        priority: 70,
        max_retries: 3,
        misfire_policy: 'skip',
      },
    });
  });

  it('treats an empty schedule as an on-demand job', () => {
    const result = validateCreateJob({ name: 'adhoc', handler: 'test.echo', schedule: '' });
    expect(result.ok && result.value.schedule).toBeFalsy();
  });

  it('requires a name and a registered handler', () => {
    const result = validateCreateJob({ handler: 'does.not.exist' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('name is required (1-255 characters)');
      expect(result.errors.join(' ')).toMatch(/handler "does.not.exist" is not registered \(known: .*test\.echo/);
    }
  });

  it('rejects invalid cron expressions, including ones with too few fields', () => {
    for (const schedule of ['not a cron', '* * * *', '61 * * * *']) {
      const result = validateCreateJob({ name: 'x', handler: 'test.echo', schedule });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects out-of-range numbers and inconsistent backoff bounds', () => {
    const result = validateCreateJob({
      name: 'x',
      handler: 'test.echo',
      priority: 101,
      max_retries: 2.5,
      timeout_ms: 10,
      initial_backoff_ms: 5000,
      max_backoff_ms: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        'priority must be an integer between 0 and 100',
        'max_retries must be an integer between 0 and 10',
        'timeout_ms must be an integer between 1000 and 86400000',
        'initial_backoff_ms must not exceed max_backoff_ms',
      ]));
    }
  });

  it('rejects a schedule combined with scheduled_at, bad payloads and unknown policies', () => {
    const result = validateCreateJob({
      name: 'x',
      handler: 'test.echo',
      schedule: '* * * * *',
      scheduled_at: '2030-01-01T00:00:00Z',
      payload: [1, 2],
      misfire_policy: 'catch_up_everything',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(3);
    }
  });

  it('accepts a one-time job with an ISO timestamp', () => {
    const result = validateCreateJob({ name: 'once', handler: 'test.echo', scheduled_at: '2030-01-01T00:00:00Z' });
    expect(result.ok && result.value.scheduled_at).toEqual(new Date('2030-01-01T00:00:00Z'));
  });
});

describe('validateUpdateJob', () => {
  it('only returns the fields that were provided', () => {
    expect(validateUpdateJob({ priority: 10 })).toEqual({ ok: true, value: { priority: 10 } });
    expect(validateUpdateJob({})).toEqual({ ok: true, value: {} });
  });

  it('refuses to move a one-time job', () => {
    expect(validateUpdateJob({ scheduled_at: '2030-01-01T00:00:00Z' }).ok).toBe(false);
  });
});

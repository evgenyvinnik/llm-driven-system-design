import { describe, it, expect } from 'vitest';
import { cronValidationError, nextCronTime, planFiring } from './cron';

const at = (iso: string) => new Date(iso);
const GRACE_MS = 60_000;

describe('nextCronTime', () => {
  it('returns the first match strictly after the reference time, in UTC', () => {
    expect(nextCronTime('* * * * *', at('2026-01-01T10:00:00Z'))).toEqual(at('2026-01-01T10:01:00Z'));
    expect(nextCronTime('* * * * *', at('2026-01-01T09:59:59.999Z'))).toEqual(at('2026-01-01T10:00:00Z'));
    expect(nextCronTime('0 2 * * *', at('2026-03-08T01:00:00Z'))).toEqual(at('2026-03-08T02:00:00Z'));
  });
});

describe('cronValidationError', () => {
  it('accepts 5-field and 6-field expressions', () => {
    expect(cronValidationError('*/5 * * * *')).toBeNull();
    expect(cronValidationError('*/10 * * * * *')).toBeNull();
  });

  it('rejects expressions cron-parser would silently complete or cannot parse', () => {
    expect(cronValidationError('* * * *')).toMatch(/5 or 6 fields/);
    expect(cronValidationError('not a cron expression')).toMatch(/5 or 6 fields/);
    expect(cronValidationError('61 * * * *')).toMatch(/0-59/);
  });
});

describe('planFiring', () => {
  it('fires a one-time job once, however late, and clears next_run_time', () => {
    const job = { schedule: null, next_run_time: at('2026-01-01T08:00:00Z'), misfire_policy: 'skip' as const };
    const plan = planFiring(job, at('2026-01-01T10:00:00Z'), GRACE_MS);
    expect(plan).toEqual({ fireSlot: job.next_run_time, nextRunTime: null, misfired: true });
  });

  it('advances an on-time recurring job from its slot, not from now', () => {
    const job = { schedule: '*/5 * * * *', next_run_time: at('2026-01-01T10:00:00Z'), misfire_policy: 'fire_once' as const };
    const plan = planFiring(job, at('2026-01-01T10:00:30Z'), GRACE_MS);
    expect(plan.fireSlot).toEqual(at('2026-01-01T10:00:00Z'));
    expect(plan.nextRunTime).toEqual(at('2026-01-01T10:05:00Z'));
    expect(plan.misfired).toBe(false);
  });

  it('catches up within the grace window instead of skipping slots', () => {
    // Every 10 seconds; the tick is 35 s late. The 10:00:00 slot fires now and the
    // 10:00:10 slot is already due, so the next tick fires it too.
    const job = { schedule: '*/10 * * * * *', next_run_time: at('2026-01-01T10:00:00Z'), misfire_policy: 'fire_once' as const };
    const now = at('2026-01-01T10:00:35Z');
    const plan = planFiring(job, now, GRACE_MS);
    expect(plan.fireSlot).toEqual(at('2026-01-01T10:00:00Z'));
    expect(plan.nextRunTime).toEqual(at('2026-01-01T10:00:10Z'));
    expect(plan.nextRunTime!.getTime()).toBeLessThan(now.getTime());
  });

  it('coalesces a gap longer than the grace window into one run (fire_once)', () => {
    const job = { schedule: '0 * * * *', next_run_time: at('2026-01-01T07:00:00Z'), misfire_policy: 'fire_once' as const };
    const now = at('2026-01-01T10:00:30Z');
    const plan = planFiring(job, now, GRACE_MS);
    expect(plan.misfired).toBe(true);
    expect(plan.fireSlot).toEqual(at('2026-01-01T07:00:00Z'));
    expect(plan.nextRunTime).toEqual(at('2026-01-01T11:00:00Z'));
  });

  it('drops the missed slots under the skip policy but still moves next_run_time forward', () => {
    const job = { schedule: '0 * * * *', next_run_time: at('2026-01-01T07:00:00Z'), misfire_policy: 'skip' as const };
    const now = at('2026-01-01T10:00:30Z');
    const plan = planFiring(job, now, GRACE_MS);
    expect(plan.fireSlot).toBeNull();
    expect(plan.nextRunTime!.getTime()).toBeGreaterThan(now.getTime());
  });
});

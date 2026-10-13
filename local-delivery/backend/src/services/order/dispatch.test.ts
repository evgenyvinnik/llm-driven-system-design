import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../utils/db.js', () => ({ query, queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('../../utils/redis.js', () => ({ publisher: { publish: vi.fn() } }));

import { claimDueOrders, startDispatchSweeper } from './dispatch.js';

beforeEach(() => query.mockReset());

describe('claimDueOrders', () => {
  it('claims only unassigned orders with a missing or expired lease, skipping rows other sweepers hold', async () => {
    query.mockResolvedValueOnce([{ id: 'o1' }, { id: 'o2' }]);

    const claimed = await claimDueOrders('instance-a', 5);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('dispatch_lease_until IS NULL OR dispatch_lease_until < NOW()');
    expect(sql).toContain('driver_id IS NULL');
    expect(params[0]).toBe('instance-a');
    expect(params[3]).toBe(5);
    expect(claimed).toEqual(['o1', 'o2']);
  });
});

describe('startDispatchSweeper', () => {
  it('never runs two matching loops for the same order in one process', async () => {
    let finish!: () => void;
    const dispatch = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const claim = vi.fn().mockResolvedValue(['o1']);
    const sweeper = startDispatchSweeper({ dispatch, claim, intervalMs: 60_000 });

    await sweeper.sweepOnce();
    await sweeper.sweepOnce(); // o1 is still being matched
    expect(dispatch).toHaveBeenCalledTimes(1);

    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sweeper.sweepOnce(); // the loop ended; o1 may be resumed
    expect(dispatch).toHaveBeenCalledTimes(2);
    sweeper.stop();
  });

  it('runs housekeeping before claiming and survives a failing claim', async () => {
    const beforeSweep = vi.fn().mockResolvedValue(0);
    const claim = vi.fn().mockRejectedValue(new Error('db down'));
    const sweeper = startDispatchSweeper({ dispatch: vi.fn(), claim, beforeSweep, intervalMs: 60_000 });

    await expect(sweeper.sweepOnce()).resolves.toBe(0);
    expect(beforeSweep).toHaveBeenCalled();
    sweeper.stop();
  });
});

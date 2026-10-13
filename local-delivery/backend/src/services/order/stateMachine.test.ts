import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQuery, publish } = vi.hoisted(() => ({ poolQuery: vi.fn(), publish: vi.fn() }));
vi.mock('../../utils/db.js', () => ({ pool: { query: poolQuery } }));
vi.mock('../../utils/redis.js', () => ({ publisher: { publish } }));

import {
  canTransition,
  sourcesFor,
  transitionOrder,
  OrderTransitionError,
  OrderAccessError,
  OrderNotFoundError,
  DISPATCHABLE_STATUSES,
} from './stateMachine.js';

describe('order transition table', () => {
  it('lets every pre-pickup status be assigned or cancelled', () => {
    for (const status of DISPATCHABLE_STATUSES) {
      expect(canTransition(status, 'driver_assigned')).toBe(true);
      expect(canTransition(status, 'cancelled')).toBe(true);
    }
  });

  it('never leaves a terminal status', () => {
    expect(canTransition('delivered', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'driver_assigned')).toBe(false);
    expect(canTransition('cancelled', 'pending')).toBe(false);
  });

  it('cannot cancel once a courier holds the order', () => {
    expect(canTransition('driver_assigned', 'cancelled')).toBe(false);
    expect(canTransition('picked_up', 'cancelled')).toBe(false);
  });

  it('reaches picked_up only from driver_assigned', () => {
    expect(sourcesFor('picked_up')).toEqual(['driver_assigned']);
  });
});

describe('transitionOrder', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    publish.mockReset();
    publish.mockResolvedValue(1);
  });

  it('guards on the allowed source statuses and the owner, then publishes a versioned event', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ id: 'o1', status: 'picked_up', driver_id: 'd1', version: 3 }],
    });

    const order = await transitionOrder('o1', 'picked_up', { driverId: 'd1' });

    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain('status = ANY($3::text[])');
    expect(sql).toContain('driver_id = $4');
    expect(sql).toContain('version = version + 1');
    expect(sql).toContain('picked_up_at = NOW()');
    expect(params).toEqual(['picked_up', 'o1', ['driver_assigned'], 'd1']);
    expect(order.status).toBe('picked_up');
    expect(publish).toHaveBeenCalledWith('order:o1:status', expect.stringContaining('"version":3'));
  });

  it('assigns a courier only while the order is unassigned, and drops the dispatch lease', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'o1', status: 'driver_assigned', version: 2 }] });

    await transitionOrder('o1', 'driver_assigned', { assignDriverId: 'd9' });

    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain('driver_id IS NULL');
    expect(sql).toContain('dispatch_owner = NULL');
    expect(params).toContain('d9');
  });

  it('narrows the sources by route policy (customer cancel)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'o1', status: 'cancelled', version: 2 }] });

    await transitionOrder('o1', 'cancelled', {
      from: ['pending', 'confirmed'],
      customerId: 'c1',
      cancellationReason: 'changed my mind',
    });

    const [sql, params] = poolQuery.mock.calls[0];
    expect(params[2]).toEqual(['pending', 'confirmed']);
    expect(sql).toContain('customer_id = $5');
    expect(params).toEqual(['cancelled', 'o1', ['pending', 'confirmed'], 'changed my mind', 'c1']);
  });

  it('reports the current status (409) when the guard rejects the move, and publishes nothing', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'cancelled', driver_id: null, customer_id: 'c1' }] });

    const attempt = transitionOrder('o1', 'driver_assigned', { assignDriverId: 'd1' });

    await expect(attempt).rejects.toBeInstanceOf(OrderTransitionError);
    await expect(attempt).rejects.toMatchObject({ from: 'cancelled', to: 'driver_assigned', statusCode: 409 });
    expect(publish).not.toHaveBeenCalled();
  });

  it("distinguishes someone else's order (403) from a missing one (404)", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'driver_assigned', driver_id: 'other', customer_id: 'c1' }] });
    await expect(transitionOrder('o1', 'picked_up', { driverId: 'd1' })).rejects.toBeInstanceOf(OrderAccessError);

    poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(transitionOrder('missing', 'picked_up', { driverId: 'd1' })).rejects.toBeInstanceOf(
      OrderNotFoundError
    );
  });

  it("uses the caller's transaction and leaves publishing to after COMMIT", async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 'o1', status: 'cancelled' }] }) };

    await transitionOrder('o1', 'cancelled', { client });

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

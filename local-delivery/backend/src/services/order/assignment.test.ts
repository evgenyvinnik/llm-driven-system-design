import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  publish: vi.fn(),
  addDriverOrder: vi.fn(),
}));

vi.mock('../../utils/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../utils/db.js')>('../../utils/db.js');
  return {
    isUniqueViolation: actual.isUniqueViolation,
    queryOne: mocks.queryOne,
    execute: mocks.execute,
    pool: { query: vi.fn() },
    // No real rollback: the tests assert which statements ran and what the caller saw.
    withTransaction: (fn: (client: { query: typeof mocks.clientQuery }) => unknown) =>
      fn({ query: mocks.clientQuery }),
  };
});
vi.mock('../../utils/redis.js', () => ({
  publisher: { publish: mocks.publish },
  addDriverOrder: mocks.addDriverOrder,
}));

import { acceptDriverOffer, createDriverOffer, waitForOfferResponse } from './assignment.js';

const uniqueViolation = (constraint: string) => Object.assign(new Error('duplicate key'), { code: '23505', constraint });

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.publish.mockResolvedValue(1);
  mocks.addDriverOrder.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue(1);
});

describe('acceptDriverOffer (the atomic claim)', () => {
  it('claims the offer, assigns the order and marks the courier busy in one transaction', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ order_id: 'o1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'o1', status: 'driver_assigned', driver_id: 'd1', version: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await acceptDriverOffer('offer1', 'd1');

    expect(result.status).toBe('accepted');
    const [offerSql] = mocks.clientQuery.mock.calls[0];
    expect(offerSql).toContain("status = 'pending' AND expires_at > NOW()");
    const [orderSql] = mocks.clientQuery.mock.calls[1];
    expect(orderSql).toContain('driver_id IS NULL');
    expect(mocks.addDriverOrder).toHaveBeenCalledWith('d1', 'o1');
    expect(mocks.publish).toHaveBeenCalledWith('order:o1:status', expect.any(String));
  });

  it('refuses an order that was cancelled while the offer was open, and withdraws the offer', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ order_id: 'o1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'cancelled', driver_id: null, customer_id: 'c1' }] });

    const result = await acceptDriverOffer('offer1', 'd1');

    expect(result.status).toBe('order_unavailable');
    expect(mocks.execute).toHaveBeenCalledWith(expect.stringContaining("SET status = 'expired'"), ['offer1']);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.addDriverOrder).not.toHaveBeenCalled();
  });

  it('reports an expired or already-answered offer without touching the order', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [] });

    const result = await acceptDriverOffer('offer1', 'd1');

    expect(result.status).toBe('offer_unavailable');
    expect(mocks.clientQuery).toHaveBeenCalledTimes(1);
  });

  it('rolls back when the courier went offline before accepting', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ order_id: 'o1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'o1', status: 'driver_assigned' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await acceptDriverOffer('offer1', 'd1');

    expect(result.status).toBe('driver_offline');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe('createDriverOffer', () => {
  it('reports a courier who already holds another live offer', async () => {
    mocks.queryOne.mockRejectedValueOnce(uniqueViolation('uniq_driver_offers_pending_per_driver'));
    expect(await createDriverOffer('o1', 'd1')).toEqual({ status: 'driver_busy' });
  });

  it('reports an order that already has a live offer from another loop', async () => {
    mocks.queryOne.mockRejectedValueOnce(uniqueViolation('uniq_driver_offers_pending_per_order'));
    expect(await createDriverOffer('o1', 'd1')).toEqual({ status: 'order_has_offer' });
  });

  it('expires lapsed offers first, then notifies the courier', async () => {
    mocks.queryOne.mockResolvedValueOnce({ id: 'offer1', order_id: 'o1', driver_id: 'd1', status: 'pending' });

    const result = await createDriverOffer('o1', 'd1');

    expect(result.status).toBe('created');
    expect(mocks.execute.mock.calls[0][0]).toContain('expires_at <= NOW()');
    expect(mocks.publish).toHaveBeenCalledWith('driver:d1:offers', expect.stringContaining('"offer_id":"offer1"'));
  });
});

describe('waitForOfferResponse', () => {
  it("keeps the courier's answer when they accept between the last poll and the expiry", async () => {
    mocks.queryOne
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'accepted' });
    mocks.execute.mockResolvedValueOnce(0); // compare-and-set expiry found nothing pending

    const result = await waitForOfferResponse('offer1', Date.now() + 5, 10);

    expect(result).toBe('accepted');
  });

  it('expires an unanswered offer', async () => {
    mocks.queryOne.mockResolvedValue({ status: 'pending' });
    mocks.execute.mockResolvedValueOnce(1);

    expect(await waitForOfferResponse('offer1', Date.now() + 5, 10)).toBe('expired');
  });

  it('returns a rejection as soon as it is seen', async () => {
    mocks.queryOne.mockResolvedValueOnce({ status: 'rejected' });

    expect(await waitForOfferResponse('offer1', Date.now() + 60_000, 10)).toBe('rejected');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

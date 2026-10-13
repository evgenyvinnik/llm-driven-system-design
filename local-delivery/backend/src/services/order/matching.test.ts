import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  findBestDriver: vi.fn(),
  getOrderWithDetails: vi.fn(),
  createDriverOffer: vi.fn(),
  waitForOfferResponse: vi.fn(),
  getOfferedDriverIds: vi.fn(),
  cancelOrder: vi.fn(),
  renewDispatchLease: vi.fn(),
  releaseDispatchLease: vi.fn(),
}));

vi.mock('../driverService.js', () => ({
  findBestDriver: m.findBestDriver,
  updateDriverAcceptanceRate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./tracking.js', () => ({ getOrderWithDetails: m.getOrderWithDetails }));
vi.mock('./assignment.js', () => ({
  createDriverOffer: m.createDriverOffer,
  waitForOfferResponse: m.waitForOfferResponse,
  getOfferedDriverIds: m.getOfferedDriverIds,
  OFFER_DEADLINE_GRACE_MS: 1000,
}));
vi.mock('./cancel.js', () => ({ cancelOrder: m.cancelOrder }));
vi.mock('./dispatch.js', () => ({
  DISPATCH_OWNER: 'me',
  DISPATCH_RETRY_DELAY_SECONDS: 10,
  DISPATCH_FAILURE_BACKOFF_SECONDS: 30,
  renewDispatchLease: m.renewDispatchLease,
  releaseDispatchLease: m.releaseDispatchLease,
}));
vi.mock('../../utils/db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../utils/redis.js', () => ({ publisher: { publish: vi.fn() } }));

import { startDriverMatching } from './matching.js';
import { OrderTransitionError } from './stateMachine.js';

const offer = (id: string) => ({ status: 'created', offer: { id } });

beforeEach(() => {
  Object.values(m).forEach((mock) => mock.mockReset());
  m.getOrderWithDetails.mockResolvedValue({ id: 'o1', merchant: { lat: '37.77', lng: '-122.41' } });
  m.renewDispatchLease.mockResolvedValue({ pastDeadline: false });
  m.getOfferedDriverIds.mockResolvedValue(new Set());
  m.releaseDispatchLease.mockResolvedValue(undefined);
});

describe('startDriverMatching', () => {
  it('stops as soon as it no longer holds the lease', async () => {
    m.renewDispatchLease.mockResolvedValueOnce(null);
    expect(await startDriverMatching('o1', 'me')).toBe('lease_lost');
    expect(m.createDriverOffer).not.toHaveBeenCalled();
  });

  it('hands the order back to the sweepers when nobody is nearby', async () => {
    m.findBestDriver.mockResolvedValueOnce(null);
    expect(await startDriverMatching('o1', 'me')).toBe('deferred');
    expect(m.releaseDispatchLease).toHaveBeenCalledWith('o1', 'me', 10);
  });

  it('skips a courier who holds another offer and offers the next one', async () => {
    m.findBestDriver.mockResolvedValueOnce({ id: 'busy' }).mockResolvedValueOnce({ id: 'free' });
    m.createDriverOffer.mockResolvedValueOnce({ status: 'driver_busy' }).mockResolvedValueOnce(offer('offer-2'));
    m.waitForOfferResponse.mockResolvedValueOnce('accepted');

    expect(await startDriverMatching('o1', 'me')).toBe('assigned');
    const excluded = m.findBestDriver.mock.calls[1][1] as Set<string>;
    expect(excluded.has('busy')).toBe(true);
  });

  it('moves on after a decline, excluding couriers recorded in driver_offers', async () => {
    m.findBestDriver.mockResolvedValueOnce({ id: 'd1' }).mockResolvedValueOnce({ id: 'd2' });
    m.createDriverOffer.mockResolvedValueOnce(offer('offer-1')).mockResolvedValueOnce(offer('offer-2'));
    m.waitForOfferResponse.mockResolvedValueOnce('rejected').mockResolvedValueOnce('accepted');
    m.getOfferedDriverIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set(['d1']));

    expect(await startDriverMatching('o1', 'me')).toBe('assigned');
    expect((m.findBestDriver.mock.calls[1][1] as Set<string>).has('d1')).toBe(true);
  });

  it('cancels after the offer limit, only while still unassigned', async () => {
    m.getOfferedDriverIds.mockResolvedValueOnce(new Set(['a', 'b', 'c', 'd', 'e']));
    m.cancelOrder.mockResolvedValueOnce({ id: 'o1', status: 'cancelled' });

    expect(await startDriverMatching('o1', 'me')).toBe('cancelled');
    expect(m.cancelOrder).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ from: ['pending', 'confirmed', 'preparing', 'ready_for_pickup'] })
    );
  });

  it('gives up at the dispatch deadline, but not if a courier won the race', async () => {
    m.renewDispatchLease.mockResolvedValue({ pastDeadline: true });
    m.cancelOrder.mockRejectedValueOnce(new OrderTransitionError('o1', 'driver_assigned', 'cancelled'));

    expect(await startDriverMatching('o1', 'me')).toBe('lease_lost');
  });
});

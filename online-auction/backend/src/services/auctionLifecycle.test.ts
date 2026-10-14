import { describe, expect, it, vi } from 'vitest';

// Mock shared modules before importing the module under test.
vi.mock('../db.js', () => ({ withTransaction: vi.fn(), query: vi.fn() }));
vi.mock('../redis.js', () => ({
  invalidateAuctionCache: vi.fn(),
  publishBidUpdate: vi.fn(),
  removeAuctionFromSchedule: vi.fn(),
  scheduleAuctionEnd: vi.fn(),
}));

import { decideClose } from './auctionLifecycle.js';

const now = Date.parse('2026-10-10T12:00:00Z');
const due = { status: 'active', end_time: new Date(now - 1_000), reserve_price: null };
const bid = (amount: string) => ({ id: 'bid-1', bidder_id: 'winner', amount });

describe('decideClose', () => {
  it('does nothing for an auction another instance already closed', () => {
    expect(decideClose({ ...due, status: 'ended' }, bid('10.00'), now)).toEqual({ action: 'skip' });
  });

  it('reschedules an auction whose end moved (snipe extension) instead of closing it', () => {
    const extended = new Date(now + 120_000);
    expect(decideClose({ ...due, end_time: extended }, bid('10.00'), now)).toEqual({ action: 'reschedule', endTime: extended });
  });

  it('lets an admin force-close before the end time', () => {
    const early = { ...due, end_time: new Date(now + 60_000) };
    expect(decideClose(early, bid('10.00'), now, true)).toMatchObject({ action: 'close', outcome: 'sold' });
  });

  it('closes without a winner when nobody bid', () => {
    expect(decideClose(due, null, now)).toMatchObject({ action: 'close', outcome: 'no_bids', winnerId: null });
  });

  it('compares the reserve as money, not as strings', () => {
    // As strings, "950.00" > "1000.00" - the old check called this reserve met.
    expect(decideClose({ ...due, reserve_price: '1000.00' }, bid('950.00'), now)).toMatchObject({ outcome: 'reserve_not_met' });
    expect(decideClose({ ...due, reserve_price: '1000.00' }, bid('1000.00'), now)).toEqual({
      action: 'close',
      outcome: 'sold',
      winnerId: 'winner',
      winningBidId: 'bid-1',
    });
  });
});

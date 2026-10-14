import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import { invalidateAuctionCache, publishBidUpdate, removeAuctionFromSchedule, scheduleAuctionEnd } from '../redis.js';
import logger, { logAuctionEvent } from '../shared/logger.js';
import { auctionsEndedTotal } from '../shared/metrics.js';
import { fromCents, toCents } from './bidEngine.js';

/**
 * Auction state transitions that must happen exactly once: closing (by the
 * scheduler or an admin) and cancelling (by the seller or an admin).
 *
 * Both run as one transaction that starts with `SELECT ... FOR UPDATE` on the
 * auction row - the same lock every bid takes. That single choice is what makes
 * them safe:
 * - a close waits for an in-flight bid to commit, then sees its price and any
 *   snipe extension (an extended auction is rescheduled, not closed);
 * - two scheduler instances racing on one auction serialize, and the second
 *   finds `status <> 'active'` and does nothing, so notifications are written
 *   once, in the same transaction as the status change;
 * - a seller's "cancel if there are no bids" check runs after the lock, so a
 *   bid cannot slip in between the check and the update.
 * Redis (schedule, cache, pub/sub) is only touched after COMMIT.
 */

export type CloseDecision =
  | { action: 'skip' }
  | { action: 'reschedule'; endTime: Date }
  | {
      action: 'close';
      outcome: 'sold' | 'reserve_not_met' | 'no_bids';
      winnerId: string | null;
      winningBidId: string | null;
    };

interface LockedAuction {
  status: string;
  end_time: Date | string;
  reserve_price: string | number | null;
}

interface LeadingBid {
  id: string;
  bidder_id: string;
  amount: string | number;
}

/**
 * Pure decision for closing an auction from its locked row and leading bid (the
 * earliest bid at the highest amount). Money is compared in cents: `pg` returns
 * DECIMAL as strings, and the old string comparison treated "950.00" as above a
 * "1000.00" reserve.
 */
export function decideClose(
  auction: LockedAuction,
  leading: LeadingBid | null,
  now: number,
  force = false
): CloseDecision {
  if (auction.status !== 'active') return { action: 'skip' };
  const endTime = new Date(auction.end_time);
  if (!force && endTime.getTime() > now) return { action: 'reschedule', endTime };
  if (!leading) return { action: 'close', outcome: 'no_bids', winnerId: null, winningBidId: null };
  if (auction.reserve_price !== null && toCents(leading.amount) < toCents(auction.reserve_price)) {
    return { action: 'close', outcome: 'reserve_not_met', winnerId: null, winningBidId: null };
  }
  return { action: 'close', outcome: 'sold', winnerId: leading.bidder_id, winningBidId: leading.id };
}

export interface CloseResult {
  outcome: 'sold' | 'reserve_not_met' | 'no_bids' | 'not_due' | 'not_active' | 'not_found';
  winnerId: string | null;
  winningAmount: number | null;
}

const notify = (client: PoolClient, userId: string, auctionId: string, type: string, message: string) =>
  client.query('INSERT INTO notifications (user_id, auction_id, type, message) VALUES ($1, $2, $3, $4)', [
    userId,
    auctionId,
    type,
    message,
  ]);

/** Closes an auction if it is active and due (or `force`), exactly once across instances. */
export async function closeAuction(auctionId: string, options: { force?: boolean } = {}): Promise<CloseResult> {
  const tx = await withTransaction(async (client) => {
    const auctionResult = await client.query(
      'SELECT id, seller_id, title, status, end_time, reserve_price FROM auctions WHERE id = $1 FOR UPDATE',
      [auctionId]
    );
    if (auctionResult.rows.length === 0) return { kind: 'not_found' as const };
    const auction = auctionResult.rows[0];

    const leadingResult = await client.query(
      'SELECT id, bidder_id, amount FROM bids WHERE auction_id = $1 ORDER BY amount DESC, sequence_num ASC LIMIT 1',
      [auctionId]
    );
    const leading: LeadingBid | null = leadingResult.rows[0] ?? null;
    const decision = decideClose(auction, leading, Date.now(), options.force);
    if (decision.action === 'skip') return { kind: 'not_active' as const };
    if (decision.action === 'reschedule') return { kind: 'not_due' as const, endTime: decision.endTime };

    const priceCents = leading ? toCents(leading.amount) : 0;
    const price = `$${fromCents(priceCents)}`;
    const updated = await client.query(
      `UPDATE auctions SET status = 'ended', winner_id = $2, winning_bid_id = $3, version = version + 1
       WHERE id = $1 RETURNING version`,
      [auctionId, decision.winnerId, decision.winningBidId]
    );

    if (decision.outcome === 'sold' && decision.winnerId) {
      await notify(client, decision.winnerId, auctionId, 'auction_won',
        `Congratulations! You won the auction for "${auction.title}" with a bid of ${price}.`);
      await notify(client, auction.seller_id, auctionId, 'auction_sold',
        `Your auction "${auction.title}" has been sold for ${price}.`);
      await client.query(
        `INSERT INTO notifications (user_id, auction_id, type, message)
         SELECT DISTINCT bidder_id, $1::uuid, 'auction_lost', $3 FROM bids WHERE auction_id = $1 AND bidder_id <> $2`,
        [auctionId, decision.winnerId,
          `The auction for "${auction.title}" has ended. Unfortunately, you were not the winning bidder.`]
      );
    } else if (decision.outcome === 'reserve_not_met') {
      await notify(client, auction.seller_id, auctionId, 'reserve_not_met',
        `Your auction "${auction.title}" ended at ${price} without meeting its reserve.`);
    } else {
      await notify(client, auction.seller_id, auctionId, 'no_bids', `Your auction "${auction.title}" has ended with no bids.`);
    }

    await client.query('UPDATE auto_bids SET is_active = false WHERE auction_id = $1 AND is_active', [auctionId]);
    return {
      kind: 'closed' as const,
      outcome: decision.outcome,
      winnerId: decision.winnerId,
      priceCents: decision.outcome === 'sold' ? priceCents : null,
      sellerId: auction.seller_id as string,
      version: updated.rows[0].version as number,
    };
  });

  // After COMMIT: the database is the source of truth, Redis only follows it. A
  // failure here is logged, not thrown - the close itself has already happened.
  try {
    if (tx.kind === 'not_due') {
      await scheduleAuctionEnd(auctionId, tx.endTime);
      return { outcome: 'not_due', winnerId: null, winningAmount: null };
    }
    await removeAuctionFromSchedule(auctionId);
    if (tx.kind !== 'closed') return { outcome: tx.kind, winnerId: null, winningAmount: null };

    await invalidateAuctionCache(auctionId);
    await publishBidUpdate(auctionId, {
      type: 'auction_ended',
      auction_id: auctionId,
      outcome: tx.outcome,
      winner_id: tx.winnerId,
      final_price: tx.priceCents === null ? null : tx.priceCents / 100,
      version: tx.version,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ err: error, auctionId }, 'Post-close Redis update failed');
  }

  if (tx.kind !== 'closed') return { outcome: tx.kind, winnerId: null, winningAmount: null };
  auctionsEndedTotal.inc({ outcome: tx.outcome });
  logAuctionEvent({
    action: `closed_${tx.outcome}`,
    auctionId,
    sellerId: tx.sellerId,
    winnerId: tx.winnerId ?? undefined,
    finalPrice: tx.priceCents === null ? undefined : tx.priceCents / 100,
  });
  return { outcome: tx.outcome, winnerId: tx.winnerId, winningAmount: tx.priceCents === null ? null : tx.priceCents / 100 };
}

export type CancelResult = 'cancelled' | 'not_found' | 'not_active' | 'has_bids';

/** Cancels an active auction. Sellers may only cancel before the first bid; admins may override. */
export async function cancelAuction(auctionId: string, options: { allowWithBids: boolean }): Promise<CancelResult> {
  const result = await withTransaction(async (client): Promise<CancelResult> => {
    const locked = await client.query('SELECT status FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);
    if (locked.rows.length === 0) return 'not_found';
    if (locked.rows[0].status !== 'active') return 'not_active';
    if (!options.allowWithBids) {
      // Read after taking the row lock, so a bid that committed while we waited is visible.
      const bids = await client.query('SELECT 1 FROM bids WHERE auction_id = $1 LIMIT 1', [auctionId]);
      if (bids.rows.length > 0) return 'has_bids';
    }
    await client.query("UPDATE auctions SET status = 'cancelled', version = version + 1 WHERE id = $1", [auctionId]);
    await client.query('UPDATE auto_bids SET is_active = false WHERE auction_id = $1 AND is_active', [auctionId]);
    return 'cancelled';
  });

  if (result === 'cancelled') {
    auctionsEndedTotal.inc({ outcome: 'cancelled' });
    try {
      await removeAuctionFromSchedule(auctionId);
      await invalidateAuctionCache(auctionId);
      await publishBidUpdate(auctionId, {
        type: 'auction_ended',
        auction_id: auctionId,
        outcome: 'cancelled',
        winner_id: null,
        final_price: null,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ err: error, auctionId }, 'Post-cancel Redis update failed');
    }
  }
  return result;
}

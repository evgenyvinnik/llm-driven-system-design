import { query } from '../db.js';
import { claimAuctionEnd, getEndingAuctions, scheduleAuctionEnd, scheduleAuctionEnds } from '../redis.js';
import logger from '../shared/logger.js';
import { closeAuction } from './auctionLifecycle.js';

/**
 * Auction-ending scheduler, run in every API instance.
 *
 * Three layers, each with one job:
 * 1. The Redis sorted set `auction_endings` (score = end time in ms) answers
 *    "what is due now" cheaply; every tick reads at most 100 due entries.
 * 2. ZREM is the claim: only the instance that removes an entry closes it.
 * 3. closeAuction() re-checks the row under FOR UPDATE, so even a double claim
 *    cannot close twice, and a snipe-extended auction is rescheduled instead.
 *
 * PostgreSQL stays the source of truth. The reconciler re-adds every active
 * auction ending within the next window (and any overdue one) at startup and
 * then periodically, so a flushed Redis, a crash between claim and close, or
 * rows inserted straight into SQL (the seed) delay a close by at most one
 * reconcile interval instead of stranding the auction forever.
 */

const TICK_MS = parseInt(process.env.SCHEDULER_TICK_MS || '1000');
const RECONCILE_MS = parseInt(process.env.SCHEDULER_RECONCILE_MS || '30000');
const RECONCILE_WINDOW_MS = parseInt(process.env.SCHEDULER_RECONCILE_WINDOW_MS || '120000');
const RETRY_DELAY_MS = 5000;

/** Re-adds active auctions that end within the window (or are overdue) to the sorted set. */
export const reconcileSchedule = async (): Promise<number> => {
  const result = await query(
    `SELECT id, end_time FROM auctions
     WHERE status = 'active' AND end_time <= NOW() + ($1::double precision * INTERVAL '1 millisecond')`,
    [RECONCILE_WINDOW_MS]
  );
  await scheduleAuctionEnds(result.rows);
  return result.rows.length;
};

let ticking = false;

/** Claims and closes every due auction; returns how many were actually closed. */
export const processDueAuctions = async (now: number = Date.now()): Promise<number> => {
  if (ticking) return 0; // a slow tick must not overlap the next one
  ticking = true;
  let closed = 0;
  try {
    for (const auctionId of await getEndingAuctions(now, 100)) {
      if (!(await claimAuctionEnd(auctionId))) continue; // another instance has it
      try {
        const result = await closeAuction(auctionId);
        if (['sold', 'reserve_not_met', 'no_bids'].includes(result.outcome)) closed++;
      } catch (error) {
        logger.error({ err: error, auctionId }, 'Failed to close auction; retrying shortly');
        await scheduleAuctionEnd(auctionId, new Date(Date.now() + RETRY_DELAY_MS));
      }
    }
  } finally {
    ticking = false;
  }
  return closed;
};

/** Starts the tick and reconcile loops; returns a function that stops both. */
export const startScheduler = (): (() => void) => {
  const run = (fn: () => Promise<unknown>, label: string) => (): void => {
    fn().catch((error) => logger.error({ err: error }, label));
  };
  const reconcile = run(reconcileSchedule, 'Schedule reconcile failed');
  const tick = run(processDueAuctions, 'Scheduler tick failed');

  reconcile();
  const tickTimer = setInterval(tick, TICK_MS);
  const reconcileTimer = setInterval(reconcile, RECONCILE_MS);
  logger.info({ tickMs: TICK_MS, reconcileMs: RECONCILE_MS, windowMs: RECONCILE_WINDOW_MS }, 'Auction scheduler started');

  return () => {
    clearInterval(tickTimer);
    clearInterval(reconcileTimer);
  };
};

export default { startScheduler };

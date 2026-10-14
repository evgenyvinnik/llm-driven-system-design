import express, { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import {
  acquireLock,
  releaseLock,
  publishBidUpdate,
  scheduleAuctionEnd,
  invalidateAuctionCache,
  getCachedBidHistory,
  cacheBidHistory,
  checkRateLimit,
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKey,
} from '../redis.js';
import logger, { logBidEvent, logError } from '../shared/logger.js';
import { bidsPlacedTotal, bidLatency, idempotentRequestsTotal } from '../shared/metrics.js';
import { readIdempotencyKey, requestFingerprint } from '../shared/idempotency.js';
import { fromCents, parseAmountToCents, resolveBid, toCents, type BidAction } from '../services/bidEngine.js';
import type { AuthenticatedRequest, Bid, Lock } from '../types.js';

/**
 * The bid path. Manual bids (`POST /:auctionId`) and proxy maximums
 * (`POST /:auctionId/auto`) share one pipeline:
 *
 *   Idempotency-Key claim (Redis SET NX, scoped to the user)
 *   -> per-user rate limit
 *   -> per-auction admission lock (Redis, bounded wait)
 *   -> one PostgreSQL transaction: SELECT ... FOR UPDATE on the auction row,
 *      durable idempotency check, resolveBid() (pure, services/bidEngine.ts),
 *      bid rows, proxy rows, price/version/end_time, outbid notifications
 *   -> after COMMIT: store the response for replay, reschedule the end if snipe
 *      protection extended it, publish a versioned `new_bid` event.
 *
 * The row lock is what makes bids correct; the Redis lock only keeps a burst on
 * one auction from parking dozens of pooled connections on that row lock.
 */

const router = express.Router();

const BID_RATE_LIMIT = 10; // bids + proxy changes per user per minute
const BID_RATE_WINDOW = 60;
const LOCK_TTL_SECONDS = 5;
/** How long a request may wait for the per-auction admission lock before a 429. */
const LOCK_WAIT_MS = 1500;
const DEFAULT_INCREMENT_CENTS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

interface BidOutcome {
  status: number;
  body: Record<string, unknown>;
  /** `new_bid` event to publish after COMMIT; null when the visible price did not change. */
  event: Record<string, unknown> | null;
  extendedTo: Date | null;
}

const BID_COLUMNS = 'id, auction_id, bidder_id, amount, is_auto_bid, created_at, sequence_num';

/**
 * Runs a Redis step of the bid pipeline. Bidding without the idempotency claim
 * or the admission lock would give up retry safety, so a Redis failure fails
 * the bid fast with 503 + Retry-After instead of hanging or guessing.
 */
const redisStep = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    logError(error as Error, { action: 'bid_redis_unavailable' });
    throw new HttpError(503, 'Bidding is temporarily unavailable, please retry', { retry_after: 1 });
  }
};

/** The leader is the earliest bid at the highest amount (see bidEngine.ts). */
const loadLeader = async (client: PoolClient, auctionId: string) => {
  const result = await client.query(
    'SELECT bidder_id, created_at FROM bids WHERE auction_id = $1 ORDER BY amount DESC, sequence_num ASC LIMIT 1',
    [auctionId]
  );
  return (result.rows[0] as { bidder_id: string; created_at: Date } | undefined) ?? null;
};

/** Everything that happens while the auction row is locked. Throws HttpError for 4xx outcomes. */
async function applyBid(
  client: PoolClient,
  auctionId: string,
  action: BidAction,
  idempotencyKey: string | null
): Promise<BidOutcome> {
  const auctionResult = await client.query(
    `SELECT id, seller_id, title, status, end_time, current_price, bid_increment, reserve_price,
            snipe_protection_minutes, version
     FROM auctions WHERE id = $1 FOR UPDATE`,
    [auctionId]
  );
  if (auctionResult.rows.length === 0) throw new HttpError(404, 'Auction not found');
  const auction = auctionResult.rows[0];

  // Durable idempotency: the caller's bid row carries the key under a unique
  // index, so a retry after a lost Redis record (or a crash between COMMIT and
  // storing the response) finds the bid instead of placing a second one.
  if (idempotencyKey) {
    const prior = await client.query(`SELECT ${BID_COLUMNS} FROM bids WHERE bidder_id = $1 AND idempotency_key = $2`, [
      action.bidderId,
      idempotencyKey,
    ]);
    if (prior.rows.length > 0) {
      if (prior.rows[0].auction_id !== auctionId) {
        throw new HttpError(422, 'Idempotency-Key was already used for a different request');
      }
      const leader = await loadLeader(client, auctionId);
      return {
        status: 200,
        body: {
          bid: prior.rows[0],
          current_price: toCents(auction.current_price) / 100,
          is_winning: leader?.bidder_id === action.bidderId,
          version: auction.version,
          end_time: new Date(auction.end_time).toISOString(),
          extended: false,
        },
        event: null,
        extendedTo: null,
      };
    }
  }

  if (auction.status !== 'active') throw new HttpError(400, 'Auction is not active');
  const endTime = new Date(auction.end_time);
  if (endTime.getTime() <= action.at) throw new HttpError(400, 'Auction has ended');
  if (auction.seller_id === action.bidderId) throw new HttpError(400, 'Cannot bid on your own auction');

  const leader = await loadLeader(client, auctionId);
  const proxies = await client.query(
    'SELECT bidder_id, max_amount, updated_at FROM auto_bids WHERE auction_id = $1 AND is_active',
    [auctionId]
  );

  const priceCents = toCents(auction.current_price);
  const resolution = resolveBid(
    {
      priceCents,
      incrementCents: toCents(auction.bid_increment) || DEFAULT_INCREMENT_CENTS,
      reserveCents: auction.reserve_price === null ? null : toCents(auction.reserve_price),
      leaderId: leader?.bidder_id ?? null,
      leaderSince: leader ? new Date(leader.created_at).getTime() : 0,
      proxies: proxies.rows.map((p) => ({
        bidderId: p.bidder_id,
        maxCents: toCents(p.max_amount),
        since: new Date(p.updated_at).getTime(),
      })),
    },
    action
  );

  if (!resolution.ok) {
    if (resolution.reason === 'already_leading') {
      throw new HttpError(409, 'You are already the highest bidder. To bid more, raise your maximum with an auto-bid.', {
        code: 'already_leading',
      });
    }
    const label = action.kind === 'manual' ? 'Bid' : 'Maximum bid';
    throw new HttpError(400, `${label} must be at least ${fromCents(resolution.minimumCents)}`, {
      minimum_bid: resolution.minimumCents / 100,
    });
  }

  // Proxy row first, then deactivate beaten proxies, then the bid rows.
  let autoBid: unknown = null;
  if (resolution.proxy) {
    const upsert = await client.query(
      `INSERT INTO auto_bids (auction_id, bidder_id, max_amount, is_active) VALUES ($1, $2, $3, $4)
       ON CONFLICT (auction_id, bidder_id)
       DO UPDATE SET max_amount = EXCLUDED.max_amount, is_active = EXCLUDED.is_active
       RETURNING *`,
      [auctionId, action.bidderId, fromCents(resolution.proxy.maxCents), resolution.proxy.active]
    );
    autoBid = upsert.rows[0];
  }
  if (resolution.deactivate.length > 0) {
    await client.query(
      'UPDATE auto_bids SET is_active = false WHERE auction_id = $1 AND bidder_id = ANY($2::uuid[]) AND is_active',
      [auctionId, resolution.deactivate]
    );
  }

  // Insert in the engine's order: sequence_num then encodes "earliest bid at
  // the highest amount wins". Only the caller's row carries the idempotency key.
  const inserted: Bid[] = [];
  let keyStored = false;
  for (const bid of resolution.bids) {
    const carriesKey: boolean = !keyStored && bid.bidderId === action.bidderId && idempotencyKey !== null;
    keyStored = keyStored || carriesKey;
    const row = await client.query(
      `INSERT INTO bids (auction_id, bidder_id, amount, is_auto_bid, idempotency_key)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${BID_COLUMNS}`,
      [auctionId, bid.bidderId, fromCents(bid.amountCents), bid.isAuto, carriesKey ? idempotencyKey : null]
    );
    inserted.push(row.rows[0] as Bid);
  }

  const priceChanged = resolution.priceCents !== priceCents;
  let version: number = auction.version;
  let newEndTime = endTime;
  let extendedTo: Date | null = null;
  if (priceChanged) {
    // Anti-sniping: a price change inside the final window moves the end so a
    // full window remains. Done under the row lock, so no bid is ever judged
    // against an end time that another request is in the middle of changing.
    const windowMs = Number(auction.snipe_protection_minutes ?? 0) * 60_000;
    if (windowMs > 0 && endTime.getTime() - action.at < windowMs) {
      extendedTo = new Date(action.at + windowMs);
    }
    const updated = await client.query(
      `UPDATE auctions SET current_price = $2, version = version + 1, end_time = COALESCE($3::timestamptz, end_time)
       WHERE id = $1 RETURNING version, end_time`,
      [auctionId, fromCents(resolution.priceCents), extendedTo]
    );
    version = updated.rows[0].version;
    newEndTime = new Date(updated.rows[0].end_time);
  }

  // Outbid notices go only to bidders who just lost the lead or whose proxy was
  // exhausted, in the same transaction as the bid that caused them.
  if (resolution.outbid.length > 0) {
    await client.query(
      `INSERT INTO notifications (user_id, auction_id, type, message)
       SELECT u, $2, 'outbid', $3 FROM unnest($1::uuid[]) AS u`,
      [
        resolution.outbid,
        auctionId,
        `You have been outbid on "${auction.title}". Current price: $${fromCents(resolution.priceCents)}`,
      ]
    );
  }

  const names =
    inserted.length > 0
      ? await client.query('SELECT id, username FROM users WHERE id = ANY($1::uuid[])', [
          [...new Set(inserted.map((b) => b.bidder_id))],
        ])
      : { rows: [] as Array<{ id: string; username: string }> };
  const nameOf = new Map(names.rows.map((r) => [r.id, r.username]));
  const bids = inserted.map((b) => ({ ...b, bidder_name: nameOf.get(b.bidder_id) ?? 'unknown' }));
  const currentPrice = resolution.priceCents / 100;
  const leaderBid = bids.find((b) => b.bidder_id === resolution.leaderId);

  return {
    status: action.kind === 'manual' ? 201 : 200,
    body: {
      bid: bids.find((b) => b.bidder_id === action.bidderId) ?? null,
      current_price: currentPrice,
      is_winning: resolution.isLeading,
      version,
      end_time: newEndTime.toISOString(),
      extended: extendedTo !== null,
      ...(autoBid ? { auto_bid: autoBid } : {}),
    },
    event: priceChanged
      ? {
          type: 'new_bid',
          auction_id: auctionId,
          version,
          current_price: currentPrice,
          leader_id: resolution.leaderId,
          bidder_id: resolution.leaderId,
          bid_amount: currentPrice,
          is_auto_bid: leaderBid?.is_auto_bid ?? false,
          end_time: newEndTime.toISOString(),
          extended: extendedTo !== null,
          bids,
          timestamp: new Date().toISOString(),
        }
      : null,
    extendedTo,
  };
}

/** Shared HTTP handler for manual bids and proxy maximums. */
const placeBid =
  (kind: BidAction['kind']) =>
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auctionId = req.params.auctionId as string;
    const bidderId = req.user!.id;
    const startTime = Date.now();

    const amountCents = parseAmountToCents(kind === 'manual' ? req.body?.amount : req.body?.max_amount);
    if (amountCents === null) {
      res.status(400).json({ error: kind === 'manual' ? 'Valid bid amount is required' : 'Valid maximum amount is required' });
      return;
    }
    if (!UUID_RE.test(auctionId)) {
      res.status(404).json({ error: 'Auction not found' });
      return;
    }

    const key = readIdempotencyKey(req.headers);
    if (key === false) {
      res.status(400).json({ error: 'Idempotency-Key must be 1-255 characters' });
      return;
    }
    const fingerprint = requestFingerprint(kind, auctionId, amountCents);

    let lock: Lock | null = null;
    let claimed = false;
    let committed = false;
    try {
      if (key) {
        const claim = await redisStep(() => claimIdempotencyKey(bidderId, key, fingerprint));
        if (claim.state === 'replay') {
          idempotentRequestsTotal.inc({ status: 'duplicate' });
          res.set('Idempotent-Replayed', 'true').status(claim.status).json(claim.body);
          return;
        }
        if (claim.state === 'in_flight') {
          res.set('Retry-After', '1').status(409).json({ error: 'A request with this Idempotency-Key is still in progress' });
          return;
        }
        if (claim.state === 'mismatch') {
          res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
          return;
        }
        claimed = true;
        idempotentRequestsTotal.inc({ status: 'new' });
      }

      const rateLimit = await redisStep(() => checkRateLimit(bidderId, 'bid', BID_RATE_LIMIT, BID_RATE_WINDOW));
      if (!rateLimit.allowed) {
        throw new HttpError(429, 'Rate limit exceeded', {
          message: `Maximum ${BID_RATE_LIMIT} bids per minute`,
          retry_after: rateLimit.resetIn,
        });
      }
      lock = await redisStep(() => acquireLock(`auction:${auctionId}`, LOCK_TTL_SECONDS, LOCK_WAIT_MS));
      if (!lock) throw new HttpError(429, 'Too many concurrent bids, please try again', { retry_after: 1 });

      const outcome = await withTransaction((client) =>
        applyBid(client, auctionId, { bidderId, kind, amountCents, at: Date.now() }, key)
      );
      committed = true;

      // The bid is committed; Redis only follows. Failures here are logged, and
      // the durable key on the bid row still protects retries.
      try {
        if (key) await completeIdempotencyKey(bidderId, key, fingerprint, outcome.status, outcome.body);
        if (outcome.extendedTo) await scheduleAuctionEnd(auctionId, outcome.extendedTo);
        if (outcome.event) {
          await invalidateAuctionCache(auctionId);
          await publishBidUpdate(auctionId, outcome.event);
        }
      } catch (error) {
        logger.error({ err: error, auctionId }, 'Post-commit Redis update failed');
      }

      const durationMs = Date.now() - startTime;
      bidLatency.observe({ status: 'success' }, durationMs / 1000);
      bidsPlacedTotal.inc({ kind, status: 'success' });
      logBidEvent({
        auctionId,
        bidderId,
        amount: Number(outcome.body.current_price),
        isAutoBid: kind === 'proxy',
        durationMs,
        idempotencyKey: key ?? undefined,
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      if (key && claimed && !committed) await releaseIdempotencyKey(bidderId, key).catch(() => undefined);

      if (error instanceof HttpError) {
        bidsPlacedTotal.inc({ kind, status: 'rejected' });
        if (error.status === 429 || error.status === 503) res.set('Retry-After', String(error.extra.retry_after ?? 1));
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      if ((error as { code?: string }).code === '23505') {
        // The unique (bidder_id, idempotency_key) index caught a duplicate that
        // got past Redis (e.g. Redis unavailable): never two bids for one key.
        res.status(409).json({ error: 'A request with this Idempotency-Key was already processed' });
        return;
      }

      bidLatency.observe({ status: 'error' }, (Date.now() - startTime) / 1000);
      bidsPlacedTotal.inc({ kind, status: 'error' });
      logError(error as Error, { action: kind === 'manual' ? 'bid_placement' : 'auto_bid', auctionId, bidderId });
      res.status(500).json({ error: kind === 'manual' ? 'Failed to place bid' : 'Failed to set auto-bid' });
    } finally {
      await releaseLock(lock).catch(() => undefined);
    }
  };

// Place a bid
router.post('/:auctionId', authenticate as express.RequestHandler, placeBid('manual') as express.RequestHandler);

// Set or raise an auto-bid (proxy maximum)
router.post('/:auctionId/auto', authenticate as express.RequestHandler, placeBid('proxy') as express.RequestHandler);

// Cancel auto-bid
router.delete(
  '/:auctionId/auto',
  authenticate as express.RequestHandler,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auctionId = req.params.auctionId as string;
    if (!UUID_RE.test(auctionId)) {
      res.status(404).json({ error: 'Auction not found' });
      return;
    }

    try {
      await withTransaction(async (client) => {
        // Take the auction row lock so a bid being resolved right now sees either
        // the proxy or its cancellation, never a proxy the user already withdrew.
        await client.query('SELECT 1 FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);
        await client.query('UPDATE auto_bids SET is_active = false WHERE auction_id = $1 AND bidder_id = $2', [
          auctionId,
          req.user!.id,
        ]);
      });
      res.json({ message: 'Auto-bid cancelled' });
    } catch (error) {
      logError(error as Error, { action: 'cancel_auto_bid', auctionId });
      res.status(500).json({ error: 'Failed to cancel auto-bid' });
    }
  }
);

// Get bid history for an auction, leader first (highest amount, earliest first)
router.get('/:auctionId', async (req: Request, res: Response): Promise<void> => {
  const auctionId = req.params.auctionId as string;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50')) || 50, 1), 100);
  if (!UUID_RE.test(auctionId)) {
    res.status(404).json({ error: 'Auction not found' });
    return;
  }

  try {
    // Only the default page is cached; the cache is invalidated on every price change.
    const cachedBids = limit === 50 ? await getCachedBidHistory(auctionId) : null;
    if (cachedBids) {
      res.json({ bids: cachedBids, _cached: true });
      return;
    }

    const result = await query(
      `SELECT b.id, b.bidder_id, b.amount, b.is_auto_bid, b.created_at, b.sequence_num, u.username as bidder_name
       FROM bids b
       JOIN users u ON b.bidder_id = u.id
       WHERE b.auction_id = $1
       ORDER BY b.amount DESC, b.sequence_num ASC
       LIMIT $2`,
      [auctionId, limit]
    );

    if (limit === 50) await cacheBidHistory(auctionId, result.rows as Bid[]);
    res.json({ bids: result.rows });
  } catch (error) {
    logError(error as Error, { action: 'fetch_bids', auctionId });
    res.status(500).json({ error: 'Failed to fetch bids' });
  }
});

/** Router for bid placement: idempotency, admission lock, row-locked proxy resolution, snipe protection. */
export default router;

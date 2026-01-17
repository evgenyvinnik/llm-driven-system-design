import express from 'express';
import { query, getClient } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import {
  acquireLock,
  releaseLock,
  publishBidUpdate,
  scheduleAuctionEnd,
  invalidateAuctionCache,
  getIdempotentBid,
  setIdempotentBid,
  markBidInProgress,
  clearBidInProgress,
  cacheCurrentBid,
  getCachedBidHistory,
  cacheBidHistory,
  checkRateLimit,
} from '../redis.js';
import logger, { logBidEvent, logError } from '../shared/logger.js';
import { bidsPlacedTotal, bidLatency, bidAmountGauge, idempotentRequestsTotal } from '../shared/metrics.js';

const router = express.Router();

const MIN_BID_INCREMENT = 1.0;
const BID_RATE_LIMIT = 10; // Max bids per minute
const BID_RATE_WINDOW = 60; // 60 seconds

/**
 * Generate idempotency key from request if not provided
 * Uses auction ID, user ID, amount, and timestamp window
 */
const getIdempotencyKey = (req, auctionId, bidderId) => {
  // Check for client-provided idempotency key
  const clientKey = req.headers['x-idempotency-key'];
  if (clientKey) {
    return clientKey;
  }

  // Generate key from request fingerprint (prevents rapid duplicate clicks)
  // Uses a 1-second window to group rapid identical requests
  const timestamp = Math.floor(Date.now() / 1000);
  const amount = req.body.amount;
  return `${auctionId}:${bidderId}:${amount}:${timestamp}`;
};

// Place a bid
router.post('/:auctionId', authenticate, async (req, res) => {
  const { auctionId } = req.params;
  const { amount } = req.body;
  const bidderId = req.user.id;
  const startTime = Date.now();

  if (!amount || isNaN(parseFloat(amount))) {
    return res.status(400).json({ error: 'Valid bid amount is required' });
  }

  const bidAmount = parseFloat(amount);

  // Generate or use provided idempotency key
  const idempotencyKey = getIdempotencyKey(req, auctionId, bidderId);

  // Check for duplicate request (idempotency)
  const existingResult = await getIdempotentBid(idempotencyKey);
  if (existingResult) {
    idempotentRequestsTotal.inc({ status: 'duplicate' });
    logger.info(
      {
        action: 'bid_duplicate',
        auctionId,
        bidderId,
        idempotencyKey,
      },
      'Duplicate bid request detected, returning cached result'
    );
    return res.status(200).json({
      ...existingResult,
      _idempotent: true,
      _message: 'Duplicate request - returning previously processed result',
    });
  }

  // Mark this request as in-progress to prevent concurrent duplicates
  const canProceed = await markBidInProgress(idempotencyKey);
  if (!canProceed) {
    return res.status(409).json({
      error: 'This bid request is already being processed',
      retry_after: 5,
    });
  }

  idempotentRequestsTotal.inc({ status: 'new' });

  // Check rate limit
  const rateLimit = await checkRateLimit(bidderId, 'bid', BID_RATE_LIMIT, BID_RATE_WINDOW);
  if (!rateLimit.allowed) {
    await clearBidInProgress(idempotencyKey);
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Maximum ${BID_RATE_LIMIT} bids per minute`,
      retry_after: rateLimit.resetIn,
    });
  }

  // Acquire distributed lock for this auction
  const lock = await acquireLock(`auction:${auctionId}`, 5);

  if (!lock) {
    await clearBidInProgress(idempotencyKey);
    return res.status(429).json({ error: 'Too many concurrent bids, please try again' });
  }

  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Fetch current auction state with row lock
    const auctionResult = await client.query(
      'SELECT * FROM auctions WHERE id = $1 FOR UPDATE',
      [auctionId]
    );

    if (auctionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Auction not found' });
    }

    const auction = auctionResult.rows[0];

    // Validate auction status
    if (auction.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Auction is not active' });
    }

    // Check if auction has ended
    if (new Date(auction.end_time) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Auction has ended' });
    }

    // Check if seller is bidding on own auction
    if (auction.seller_id === bidderId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot bid on your own auction' });
    }

    // Calculate minimum bid
    const minBid = parseFloat(auction.current_price) + (parseFloat(auction.bid_increment) || MIN_BID_INCREMENT);

    if (bidAmount < minBid) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Bid must be at least ${minBid.toFixed(2)}`,
        minimum_bid: minBid,
      });
    }

    // Check for competing auto-bids
    const autoBidsResult = await client.query(
      `SELECT * FROM auto_bids
       WHERE auction_id = $1 AND bidder_id != $2 AND is_active = true AND max_amount >= $3
       ORDER BY max_amount DESC`,
      [auctionId, bidderId, bidAmount]
    );

    let finalPrice = bidAmount;
    let winnerId = bidderId;
    let isAutoBid = false;
    const bidsToCreate = [];

    if (autoBidsResult.rows.length > 0) {
      // There's a competing auto-bid with higher max
      const highestAutoBid = autoBidsResult.rows[0];

      if (highestAutoBid.max_amount > bidAmount) {
        // Auto-bidder wins, their new bid is one increment above manual bid
        finalPrice = bidAmount + (parseFloat(auction.bid_increment) || MIN_BID_INCREMENT);
        winnerId = highestAutoBid.bidder_id;
        isAutoBid = true;

        // Create the manual bid first
        bidsToCreate.push({
          auction_id: auctionId,
          bidder_id: bidderId,
          amount: bidAmount,
          is_auto_bid: false,
        });

        // Then create the auto-bid response
        bidsToCreate.push({
          auction_id: auctionId,
          bidder_id: highestAutoBid.bidder_id,
          amount: finalPrice,
          is_auto_bid: true,
        });
      } else {
        // New bidder wins (tied max goes to new bidder as they bid first at this level)
        finalPrice = highestAutoBid.max_amount + (parseFloat(auction.bid_increment) || MIN_BID_INCREMENT);

        // Deactivate the outbid auto-bid
        await client.query(
          'UPDATE auto_bids SET is_active = false WHERE id = $1',
          [highestAutoBid.id]
        );

        bidsToCreate.push({
          auction_id: auctionId,
          bidder_id: bidderId,
          amount: finalPrice,
          is_auto_bid: false,
        });
      }
    } else {
      // No competing auto-bids
      bidsToCreate.push({
        auction_id: auctionId,
        bidder_id: bidderId,
        amount: bidAmount,
        is_auto_bid: false,
      });
    }

    // Insert all bids
    let lastBid = null;
    for (const bid of bidsToCreate) {
      const bidResult = await client.query(
        `INSERT INTO bids (auction_id, bidder_id, amount, is_auto_bid)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [bid.auction_id, bid.bidder_id, bid.amount, bid.is_auto_bid]
      );
      lastBid = bidResult.rows[0];
    }

    // Update auction current price
    await client.query(
      `UPDATE auctions
       SET current_price = $1, version = version + 1
       WHERE id = $2`,
      [finalPrice, auctionId]
    );

    // Check for snipe protection
    const timeRemaining = new Date(auction.end_time) - new Date();
    const snipeWindow = (auction.snipe_protection_minutes || 2) * 60 * 1000;

    if (timeRemaining < snipeWindow && timeRemaining > 0) {
      const newEndTime = new Date(Date.now() + snipeWindow);
      await client.query(
        'UPDATE auctions SET end_time = $1 WHERE id = $2',
        [newEndTime, auctionId]
      );
      await scheduleAuctionEnd(auctionId, newEndTime);
    }

    await client.query('COMMIT');

    // Invalidate cache
    await invalidateAuctionCache(auctionId);

    // Publish real-time update
    const bidUpdate = {
      type: 'new_bid',
      auction_id: auctionId,
      current_price: finalPrice,
      bidder_id: winnerId,
      bid_amount: finalPrice,
      is_auto_bid: isAutoBid,
      timestamp: new Date().toISOString(),
    };

    await publishBidUpdate(auctionId, bidUpdate);

    // Create outbid notifications for other bidders
    const previousBidders = await query(
      `SELECT DISTINCT bidder_id FROM bids
       WHERE auction_id = $1 AND bidder_id != $2`,
      [auctionId, winnerId]
    );

    for (const row of previousBidders.rows) {
      await query(
        `INSERT INTO notifications (user_id, auction_id, type, message)
         VALUES ($1, $2, 'outbid', $3)`,
        [row.bidder_id, auctionId, `You have been outbid on "${auction.title}". Current price: $${finalPrice.toFixed(2)}`]
      );
    }

    // Build success response
    const successResponse = {
      bid: lastBid,
      current_price: finalPrice,
      is_winning: winnerId === bidderId,
    };

    // Cache the result for idempotency
    await setIdempotentBid(idempotencyKey, successResponse);
    await clearBidInProgress(idempotencyKey);

    // Update current bid cache
    await cacheCurrentBid(auctionId, {
      amount: finalPrice,
      bidder_id: winnerId,
      timestamp: new Date().toISOString(),
    });

    // Record metrics
    const durationSeconds = (Date.now() - startTime) / 1000;
    bidLatency.observe({ status: 'success' }, durationSeconds);
    bidsPlacedTotal.inc({ auction_id: auctionId, is_auto_bid: String(isAutoBid), status: 'success' });
    bidAmountGauge.set({ auction_id: auctionId }, finalPrice);

    // Log the successful bid
    logBidEvent({
      auctionId,
      bidderId,
      amount: finalPrice,
      isAutoBid,
      durationMs: Date.now() - startTime,
      idempotencyKey,
    });

    res.status(201).json(successResponse);
  } catch (error) {
    await client.query('ROLLBACK');
    await clearBidInProgress(idempotencyKey);

    // Record metrics
    const durationSeconds = (Date.now() - startTime) / 1000;
    bidLatency.observe({ status: 'error' }, durationSeconds);
    bidsPlacedTotal.inc({ auction_id: auctionId, is_auto_bid: 'false', status: 'error' });

    logError(error, {
      action: 'bid_placement',
      auctionId,
      bidderId,
      amount: bidAmount,
    });

    res.status(500).json({ error: 'Failed to place bid' });
  } finally {
    client.release();
    await releaseLock(lock);
  }
});

// Set auto-bid (proxy bid)
router.post('/:auctionId/auto', authenticate, async (req, res) => {
  const { auctionId } = req.params;
  const { max_amount } = req.body;
  const bidderId = req.user.id;

  if (!max_amount || isNaN(parseFloat(max_amount))) {
    return res.status(400).json({ error: 'Valid maximum amount is required' });
  }

  const maxAmount = parseFloat(max_amount);

  const lock = await acquireLock(`auction:${auctionId}`, 5);

  if (!lock) {
    return res.status(429).json({ error: 'Too many concurrent requests, please try again' });
  }

  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Fetch auction
    const auctionResult = await client.query(
      'SELECT * FROM auctions WHERE id = $1 FOR UPDATE',
      [auctionId]
    );

    if (auctionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Auction not found' });
    }

    const auction = auctionResult.rows[0];

    if (auction.status !== 'active' || new Date(auction.end_time) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Auction is not active' });
    }

    if (auction.seller_id === bidderId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot bid on your own auction' });
    }

    const minBid = parseFloat(auction.current_price) + (parseFloat(auction.bid_increment) || MIN_BID_INCREMENT);

    if (maxAmount < minBid) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Maximum bid must be at least ${minBid.toFixed(2)}`,
        minimum_bid: minBid,
      });
    }

    // Upsert auto-bid
    const autoBidResult = await client.query(
      `INSERT INTO auto_bids (auction_id, bidder_id, max_amount, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (auction_id, bidder_id)
       DO UPDATE SET max_amount = $3, is_active = true, updated_at = NOW()
       RETURNING *`,
      [auctionId, bidderId, maxAmount]
    );

    const autoBid = autoBidResult.rows[0];

    // Check for competing auto-bids
    const competingAutoBids = await client.query(
      `SELECT * FROM auto_bids
       WHERE auction_id = $1 AND bidder_id != $2 AND is_active = true
       ORDER BY max_amount DESC`,
      [auctionId, bidderId]
    );

    let newPrice = parseFloat(auction.current_price);
    let winnerId = null;

    if (competingAutoBids.rows.length > 0) {
      const highestCompeting = competingAutoBids.rows[0];

      if (highestCompeting.max_amount >= maxAmount) {
        // Competing auto-bid wins
        newPrice = maxAmount + (parseFloat(auction.bid_increment) || MIN_BID_INCREMENT);
        winnerId = highestCompeting.bidder_id;

        // Deactivate our auto-bid since it's been outbid
        await client.query(
          'UPDATE auto_bids SET is_active = false WHERE id = $1',
          [autoBid.id]
        );
      } else {
        // We win
        newPrice = highestCompeting.max_amount + (parseFloat(auction.bid_increment) || MIN_BID_INCREMENT);
        winnerId = bidderId;

        // Deactivate the competing auto-bid
        await client.query(
          'UPDATE auto_bids SET is_active = false WHERE id = $1',
          [highestCompeting.id]
        );
      }

      // Only update if we need to increase the price
      if (newPrice > parseFloat(auction.current_price)) {
        // Create bid record
        await client.query(
          `INSERT INTO bids (auction_id, bidder_id, amount, is_auto_bid)
           VALUES ($1, $2, $3, true)`,
          [auctionId, winnerId, newPrice]
        );

        // Update auction
        await client.query(
          `UPDATE auctions SET current_price = $1, version = version + 1 WHERE id = $2`,
          [newPrice, auctionId]
        );
      }
    } else {
      // No competing auto-bids, place initial bid at current minimum
      newPrice = minBid;
      winnerId = bidderId;

      await client.query(
        `INSERT INTO bids (auction_id, bidder_id, amount, is_auto_bid)
         VALUES ($1, $2, $3, true)`,
        [auctionId, bidderId, newPrice]
      );

      await client.query(
        `UPDATE auctions SET current_price = $1, version = version + 1 WHERE id = $2`,
        [newPrice, auctionId]
      );
    }

    await client.query('COMMIT');

    await invalidateAuctionCache(auctionId);

    // Publish update
    const bidUpdate = {
      type: 'new_bid',
      auction_id: auctionId,
      current_price: newPrice,
      bidder_id: winnerId,
      bid_amount: newPrice,
      is_auto_bid: true,
      timestamp: new Date().toISOString(),
    };

    await publishBidUpdate(auctionId, bidUpdate);

    res.json({
      auto_bid: autoBid,
      current_price: newPrice,
      is_winning: winnerId === bidderId,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error setting auto-bid:', error);
    res.status(500).json({ error: 'Failed to set auto-bid' });
  } finally {
    client.release();
    await releaseLock(lock);
  }
});

// Cancel auto-bid
router.delete('/:auctionId/auto', authenticate, async (req, res) => {
  const { auctionId } = req.params;

  try {
    await query(
      'UPDATE auto_bids SET is_active = false WHERE auction_id = $1 AND bidder_id = $2',
      [auctionId, req.user.id]
    );

    res.json({ message: 'Auto-bid cancelled' });
  } catch (error) {
    console.error('Error cancelling auto-bid:', error);
    res.status(500).json({ error: 'Failed to cancel auto-bid' });
  }
});

// Get bid history for an auction
router.get('/:auctionId', async (req, res) => {
  const { auctionId } = req.params;
  const { limit = 50 } = req.query;

  try {
    // Try to get from cache first
    const cachedBids = await getCachedBidHistory(auctionId);
    if (cachedBids) {
      return res.json({ bids: cachedBids, _cached: true });
    }

    const result = await query(
      `SELECT b.id, b.amount, b.is_auto_bid, b.created_at, u.username as bidder_name
       FROM bids b
       JOIN users u ON b.bidder_id = u.id
       WHERE b.auction_id = $1
       ORDER BY b.sequence_num DESC
       LIMIT $2`,
      [auctionId, parseInt(limit)]
    );

    // Cache the result
    await cacheBidHistory(auctionId, result.rows);

    res.json({ bids: result.rows });
  } catch (error) {
    logError(error, { action: 'fetch_bids', auctionId });
    res.status(500).json({ error: 'Failed to fetch bids' });
  }
});

export default router;

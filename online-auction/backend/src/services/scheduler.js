import { query } from '../db.js';
import { getEndingAuctions, removeAuctionFromSchedule, publishBidUpdate } from '../redis.js';

// Close an auction and determine winner
export const closeAuction = async (auctionId) => {
  try {
    console.log(`Closing auction: ${auctionId}`);

    // Get auction details
    const auctionResult = await query(
      'SELECT * FROM auctions WHERE id = $1 AND status = $2',
      [auctionId, 'active']
    );

    if (auctionResult.rows.length === 0) {
      console.log(`Auction ${auctionId} not found or already closed`);
      return;
    }

    const auction = auctionResult.rows[0];

    // Get the highest bid
    const highestBidResult = await query(
      `SELECT b.*, u.username as bidder_name, u.email as bidder_email
       FROM bids b
       JOIN users u ON b.bidder_id = u.id
       WHERE b.auction_id = $1
       ORDER BY b.amount DESC, b.sequence_num ASC
       LIMIT 1`,
      [auctionId]
    );

    let winnerId = null;
    let winningBidId = null;
    let winningAmount = null;

    if (highestBidResult.rows.length > 0) {
      const winningBid = highestBidResult.rows[0];

      // Check if reserve price was met
      if (auction.reserve_price && winningBid.amount < parseFloat(auction.reserve_price)) {
        console.log(`Auction ${auctionId} did not meet reserve price`);
        // Notify seller that reserve was not met
        await query(
          `INSERT INTO notifications (user_id, auction_id, type, message)
           VALUES ($1, $2, 'reserve_not_met', $3)`,
          [
            auction.seller_id,
            auctionId,
            `Your auction "${auction.title}" has ended but the reserve price was not met.`,
          ]
        );
      } else {
        winnerId = winningBid.bidder_id;
        winningBidId = winningBid.id;
        winningAmount = winningBid.amount;

        // Notify winner
        await query(
          `INSERT INTO notifications (user_id, auction_id, type, message)
           VALUES ($1, $2, 'auction_won', $3)`,
          [
            winnerId,
            auctionId,
            `Congratulations! You won the auction for "${auction.title}" with a bid of $${winningAmount.toFixed(2)}.`,
          ]
        );

        // Notify seller
        await query(
          `INSERT INTO notifications (user_id, auction_id, type, message)
           VALUES ($1, $2, 'auction_sold', $3)`,
          [
            auction.seller_id,
            auctionId,
            `Your auction "${auction.title}" has been sold for $${winningAmount.toFixed(2)}.`,
          ]
        );

        console.log(`Auction ${auctionId} won by ${winningBid.bidder_name} for $${winningAmount}`);
      }
    } else {
      console.log(`Auction ${auctionId} ended with no bids`);
      // Notify seller that there were no bids
      await query(
        `INSERT INTO notifications (user_id, auction_id, type, message)
         VALUES ($1, $2, 'no_bids', $3)`,
        [auction.seller_id, auctionId, `Your auction "${auction.title}" has ended with no bids.`]
      );
    }

    // Update auction status
    await query(
      `UPDATE auctions
       SET status = 'ended', winner_id = $1, winning_bid_id = $2
       WHERE id = $3`,
      [winnerId, winningBidId, auctionId]
    );

    // Remove from schedule
    await removeAuctionFromSchedule(auctionId);

    // Notify all bidders who didn't win
    if (winnerId) {
      const otherBidders = await query(
        `SELECT DISTINCT b.bidder_id, u.email
         FROM bids b
         JOIN users u ON b.bidder_id = u.id
         WHERE b.auction_id = $1 AND b.bidder_id != $2`,
        [auctionId, winnerId]
      );

      for (const bidder of otherBidders.rows) {
        await query(
          `INSERT INTO notifications (user_id, auction_id, type, message)
           VALUES ($1, $2, 'auction_lost', $3)`,
          [
            bidder.bidder_id,
            auctionId,
            `The auction for "${auction.title}" has ended. Unfortunately, you were not the winning bidder.`,
          ]
        );
      }
    }

    // Deactivate all auto-bids for this auction
    await query('UPDATE auto_bids SET is_active = false WHERE auction_id = $1', [auctionId]);

    // Publish auction ended event
    await publishBidUpdate(auctionId, {
      type: 'auction_ended',
      auction_id: auctionId,
      winner_id: winnerId,
      final_price: winningAmount,
      timestamp: new Date().toISOString(),
    });

    return { winnerId, winningAmount };
  } catch (error) {
    console.error(`Error closing auction ${auctionId}:`, error);
    throw error;
  }
};

// Scheduler service that checks for ending auctions
export const startScheduler = () => {
  console.log('Starting auction scheduler...');

  const checkEndingAuctions = async () => {
    try {
      const now = Date.now();
      const endingAuctions = await getEndingAuctions(now);

      for (const auctionId of endingAuctions) {
        try {
          await closeAuction(auctionId);
        } catch (error) {
          console.error(`Failed to close auction ${auctionId}:`, error);
        }
      }
    } catch (error) {
      console.error('Scheduler error:', error);
    }
  };

  // Check every second for ending auctions
  setInterval(checkEndingAuctions, 1000);

  // Also check immediately on startup
  checkEndingAuctions();

  console.log('Auction scheduler started');
};

export default { closeAuction, startScheduler };

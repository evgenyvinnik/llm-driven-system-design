/**
 * Transfer Service - Core P2P Payment Logic
 *
 * This service handles:
 * - Atomic money transfers between users
 * - Funding waterfall (balance -> bank -> card)
 * - Social feed fan-out
 * - Audit logging for compliance
 * - Metrics for observability
 */

const { pool, transaction } = require('../db/pool');
const { invalidateBalanceCache } = require('../db/redis');
const { logger, formatAmount } = require('../shared/logger');
const {
  transfersTotal,
  transferAmountHistogram,
  feedFanoutDuration,
} = require('../shared/metrics');
const { logTransfer, AUDIT_ACTIONS, OUTCOMES } = require('../shared/audit');

// Maximum transfer amount in cents ($5,000)
const MAX_TRANSFER_AMOUNT = 500000;

/**
 * Determine funding source for a transfer
 * Waterfall: Venmo Balance -> Bank Account -> Card
 */
async function determineFunding(client, userId, amount, wallet) {
  let remaining = amount;
  const plan = { fromBalance: 0, fromExternal: 0, source: null };

  // Priority 1: Use Venmo balance
  if (wallet.balance >= remaining) {
    plan.fromBalance = remaining;
    return plan;
  }

  plan.fromBalance = wallet.balance;
  remaining -= wallet.balance;

  // Priority 2: Use linked bank account (free)
  const bankAccount = await client.query(
    `SELECT * FROM payment_methods
     WHERE user_id = $1 AND type = 'bank' AND is_default = true AND verified = true`,
    [userId]
  );

  if (bankAccount.rows.length > 0) {
    plan.fromExternal = remaining;
    plan.source = { type: 'bank', id: bankAccount.rows[0].id, name: bankAccount.rows[0].bank_name };
    return plan;
  }

  // Priority 3: Use any verified bank account
  const anyBank = await client.query(
    `SELECT * FROM payment_methods
     WHERE user_id = $1 AND type = 'bank' AND verified = true LIMIT 1`,
    [userId]
  );

  if (anyBank.rows.length > 0) {
    plan.fromExternal = remaining;
    plan.source = { type: 'bank', id: anyBank.rows[0].id, name: anyBank.rows[0].bank_name };
    return plan;
  }

  // Priority 4: Use card (would have fee in real system)
  const card = await client.query(
    `SELECT * FROM payment_methods
     WHERE user_id = $1 AND type IN ('card', 'debit_card') AND verified = true LIMIT 1`,
    [userId]
  );

  if (card.rows.length > 0) {
    plan.fromExternal = remaining;
    plan.source = { type: 'card', id: card.rows[0].id, name: `Card ending ${card.rows[0].last4}` };
    return plan;
  }

  throw new Error('Insufficient funds and no payment method available');
}

/**
 * Execute an atomic P2P transfer
 *
 * @param {string} senderId - UUID of the sender
 * @param {string} receiverId - UUID of the receiver
 * @param {number} amount - Amount in cents
 * @param {string} note - Transaction note
 * @param {string} visibility - 'public', 'friends', or 'private'
 * @param {Object} options - Additional options
 * @param {string} options.idempotencyKey - Client-provided idempotency key
 * @param {Object} options.request - Express request object for audit logging
 */
async function executeTransfer(senderId, receiverId, amount, note, visibility = 'public', options = {}) {
  const { idempotencyKey = null, request = null } = options;
  const startTime = Date.now();

  // Create logger with context
  const log = logger.child({
    operation: 'transfer',
    senderId,
    receiverId,
    amount: formatAmount(amount),
  });

  log.info({ event: 'transfer_initiated' });

  // Validate amount
  if (amount <= 0) {
    log.warn({ event: 'transfer_validation_failed', reason: 'non_positive_amount' });
    throw new Error('Amount must be positive');
  }
  if (amount > MAX_TRANSFER_AMOUNT) {
    log.warn({ event: 'transfer_validation_failed', reason: 'exceeds_max', maxAmount: formatAmount(MAX_TRANSFER_AMOUNT) });
    throw new Error(`Maximum transfer amount is $${MAX_TRANSFER_AMOUNT / 100}`);
  }

  // Cannot send to self
  if (senderId === receiverId) {
    log.warn({ event: 'transfer_validation_failed', reason: 'self_transfer' });
    throw new Error('Cannot send money to yourself');
  }

  let transfer;
  let fundingSource = 'balance';

  try {
    transfer = await transaction(async (client) => {
      // Check for duplicate transfer using idempotency key (database level)
      if (idempotencyKey) {
        const existingTransfer = await client.query(
          'SELECT * FROM transfers WHERE sender_id = $1 AND idempotency_key = $2',
          [senderId, idempotencyKey]
        );

        if (existingTransfer.rows.length > 0) {
          log.info({
            event: 'transfer_idempotency_hit',
            existingTransferId: existingTransfer.rows[0].id,
            idempotencyKey,
          });
          // Return existing transfer - prevents duplicate charges
          return { ...existingTransfer.rows[0], _cached: true };
        }
      }

      // Lock sender's wallet row to prevent race conditions
      const senderWalletResult = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [senderId]
      );

      if (senderWalletResult.rows.length === 0) {
        throw new Error('Sender wallet not found');
      }

      const senderWallet = senderWalletResult.rows[0];

      // Verify receiver exists
      const receiverResult = await client.query(
        'SELECT id FROM users WHERE id = $1',
        [receiverId]
      );

      if (receiverResult.rows.length === 0) {
        throw new Error('Receiver not found');
      }

      // Lock receiver's wallet
      await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [receiverId]
      );

      // Determine funding source
      const fundingPlan = await determineFunding(client, senderId, amount, senderWallet);

      // Determine funding source label for metrics
      if (fundingPlan.fromExternal > 0) {
        fundingSource = fundingPlan.source.type;
      }

      // Debit sender (only the balance portion)
      if (fundingPlan.fromBalance > 0) {
        await client.query(
          'UPDATE wallets SET balance = balance - $2, updated_at = NOW() WHERE user_id = $1',
          [senderId, fundingPlan.fromBalance]
        );
      }

      // Credit receiver with full amount
      await client.query(
        'UPDATE wallets SET balance = balance + $2, updated_at = NOW() WHERE user_id = $1',
        [receiverId, amount]
      );

      // Build funding source description
      let fundingSourceLabel = 'Venmo Balance';
      if (fundingPlan.fromExternal > 0) {
        if (fundingPlan.fromBalance > 0) {
          fundingSourceLabel = `Venmo Balance + ${fundingPlan.source.name}`;
        } else {
          fundingSourceLabel = fundingPlan.source.name;
        }
      }

      // Create transfer record with idempotency key
      const transferResult = await client.query(
        `INSERT INTO transfers (sender_id, receiver_id, amount, note, visibility, status, funding_source, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7)
         RETURNING *`,
        [senderId, receiverId, amount, note, visibility, fundingSourceLabel, idempotencyKey]
      );

      return transferResult.rows[0];
    });

    // Record success metrics
    const durationMs = Date.now() - startTime;
    transfersTotal.inc({ status: 'completed', funding_source: fundingSource });
    transferAmountHistogram.observe(amount);

    log.info({
      event: 'transfer_completed',
      transferId: transfer.id,
      durationMs,
      fundingSource,
      cached: transfer._cached || false,
    });

    // Skip post-processing for cached (idempotent) responses
    if (transfer._cached) {
      return transfer;
    }

    // Invalidate balance caches
    await invalidateBalanceCache(senderId);
    await invalidateBalanceCache(receiverId);

    // Audit log for compliance
    await logTransfer(AUDIT_ACTIONS.TRANSFER_COMPLETED, transfer, OUTCOMES.SUCCESS, request, {
      durationMs,
      idempotencyKey,
    });

    // Fan out to social feed (async, handled separately)
    await fanOutToFeed(transfer);

    return transfer;
  } catch (error) {
    // Record failure metrics
    const durationMs = Date.now() - startTime;
    const failureType = error.message.includes('Insufficient')
      ? 'insufficient_funds'
      : 'failed';
    transfersTotal.inc({ status: failureType, funding_source: fundingSource });

    log.error({
      event: 'transfer_failed',
      error: error.message,
      durationMs,
    });

    // Audit log for failed transfer attempt
    if (request) {
      await logTransfer(
        AUDIT_ACTIONS.TRANSFER_FAILED,
        { sender_id: senderId, receiver_id: receiverId, amount },
        OUTCOMES.FAILURE,
        request,
        { error: error.message, durationMs, idempotencyKey }
      );
    }

    throw error;
  }
}

/**
 * Fan out transfer to social feeds
 */
async function fanOutToFeed(transfer) {
  const startTime = Date.now();
  const log = logger.child({ operation: 'feed_fanout', transferId: transfer.id });

  try {
    if (transfer.visibility === 'private') {
      // Only sender and receiver see it
      await pool.query(
        `INSERT INTO feed_items (user_id, transfer_id, created_at)
         VALUES ($1, $3, $4), ($2, $3, $4)`,
        [transfer.sender_id, transfer.receiver_id, transfer.id, transfer.created_at]
      );

      const durationSec = (Date.now() - startTime) / 1000;
      feedFanoutDuration.observe(durationSec);
      log.debug({ event: 'feed_fanout_complete', visibility: 'private', recipients: 2, durationMs: durationSec * 1000 });
      return;
    }

    // Get friends of both participants who should see this
    const result = await pool.query(
      `INSERT INTO feed_items (user_id, transfer_id, created_at)
       SELECT DISTINCT user_id, $1, $4
       FROM (
         -- Sender sees it
         SELECT $2 as user_id
         UNION
         -- Receiver sees it
         SELECT $3
         UNION
         -- Friends of sender see it
         SELECT friend_id FROM friendships WHERE user_id = $2 AND status = 'accepted'
         UNION
         -- Friends of receiver see it
         SELECT friend_id FROM friendships WHERE user_id = $3 AND status = 'accepted'
       ) feed_users
       RETURNING user_id`,
      [transfer.id, transfer.sender_id, transfer.receiver_id, transfer.created_at]
    );

    const durationSec = (Date.now() - startTime) / 1000;
    feedFanoutDuration.observe(durationSec);

    log.debug({
      event: 'feed_fanout_complete',
      visibility: transfer.visibility,
      recipients: result.rowCount,
      durationMs: durationSec * 1000,
    });
  } catch (error) {
    // Log but don't fail the transfer
    log.error({
      event: 'feed_fanout_error',
      error: error.message,
    });
  }
}

/**
 * Get transfer by ID
 */
async function getTransferById(transferId) {
  const result = await pool.query(
    `SELECT t.*,
            sender.username as sender_username, sender.name as sender_name, sender.avatar_url as sender_avatar,
            receiver.username as receiver_username, receiver.name as receiver_name, receiver.avatar_url as receiver_avatar
     FROM transfers t
     JOIN users sender ON t.sender_id = sender.id
     JOIN users receiver ON t.receiver_id = receiver.id
     WHERE t.id = $1`,
    [transferId]
  );
  return result.rows[0];
}

module.exports = {
  executeTransfer,
  getTransferById,
  determineFunding,
  fanOutToFeed,
  MAX_TRANSFER_AMOUNT,
};

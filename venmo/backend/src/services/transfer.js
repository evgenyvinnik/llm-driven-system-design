const { pool, transaction } = require('../db/pool');
const { invalidateBalanceCache } = require('../db/redis');

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
 */
async function executeTransfer(senderId, receiverId, amount, note, visibility = 'public') {
  // Validate amount
  if (amount <= 0) {
    throw new Error('Amount must be positive');
  }
  if (amount > MAX_TRANSFER_AMOUNT) {
    throw new Error(`Maximum transfer amount is $${MAX_TRANSFER_AMOUNT / 100}`);
  }

  // Cannot send to self
  if (senderId === receiverId) {
    throw new Error('Cannot send money to yourself');
  }

  const transfer = await transaction(async (client) => {
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
    let fundingSource = 'Venmo Balance';
    if (fundingPlan.fromExternal > 0) {
      if (fundingPlan.fromBalance > 0) {
        fundingSource = `Venmo Balance + ${fundingPlan.source.name}`;
      } else {
        fundingSource = fundingPlan.source.name;
      }
    }

    // Create transfer record
    const transferResult = await client.query(
      `INSERT INTO transfers (sender_id, receiver_id, amount, note, visibility, status, funding_source)
       VALUES ($1, $2, $3, $4, $5, 'completed', $6)
       RETURNING *`,
      [senderId, receiverId, amount, note, visibility, fundingSource]
    );

    return transferResult.rows[0];
  });

  // Invalidate balance caches
  await invalidateBalanceCache(senderId);
  await invalidateBalanceCache(receiverId);

  // Fan out to social feed (async, handled separately)
  await fanOutToFeed(transfer);

  return transfer;
}

/**
 * Fan out transfer to social feeds
 */
async function fanOutToFeed(transfer) {
  try {
    if (transfer.visibility === 'private') {
      // Only sender and receiver see it
      await pool.query(
        `INSERT INTO feed_items (user_id, transfer_id, created_at)
         VALUES ($1, $3, $4), ($2, $3, $4)`,
        [transfer.sender_id, transfer.receiver_id, transfer.id, transfer.created_at]
      );
      return;
    }

    // Get friends of both participants who should see this
    await pool.query(
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
       ) feed_users`,
      [transfer.id, transfer.sender_id, transfer.receiver_id, transfer.created_at]
    );
  } catch (error) {
    // Log but don't fail the transfer
    console.error('Feed fan-out error:', error);
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

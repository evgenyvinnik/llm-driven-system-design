const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { getCachedBalance, setCachedBalance } = require('../db/redis');

const router = express.Router();

// Get wallet balance
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    // Try cache first
    let balance = await getCachedBalance(req.user.id);

    if (balance === null) {
      const result = await pool.query(
        'SELECT balance, pending_balance FROM wallets WHERE user_id = $1',
        [req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      balance = result.rows[0].balance;
      await setCachedBalance(req.user.id, balance);
    }

    res.json({ balance });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// Get wallet details with payment methods
router.get('/', authMiddleware, async (req, res) => {
  try {
    const walletResult = await pool.query(
      'SELECT balance, pending_balance, created_at FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    const paymentMethodsResult = await pool.query(
      `SELECT id, type, is_default, name, last4, bank_name, verified, created_at
       FROM payment_methods WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
      [req.user.id]
    );

    const wallet = walletResult.rows[0] || { balance: 0, pending_balance: 0 };

    res.json({
      balance: wallet.balance,
      pendingBalance: wallet.pending_balance,
      createdAt: wallet.created_at,
      paymentMethods: paymentMethodsResult.rows,
    });
  } catch (error) {
    console.error('Get wallet error:', error);
    res.status(500).json({ error: 'Failed to get wallet details' });
  }
});

// Get transaction history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT t.*,
              sender.username as sender_username, sender.name as sender_name, sender.avatar_url as sender_avatar,
              receiver.username as receiver_username, receiver.name as receiver_name, receiver.avatar_url as receiver_avatar,
              CASE WHEN t.sender_id = $1 THEN 'sent' ELSE 'received' END as direction
       FROM transfers t
       JOIN users sender ON t.sender_id = sender.id
       JOIN users receiver ON t.receiver_id = receiver.id
       WHERE t.sender_id = $1 OR t.receiver_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, parseInt(limit), parseInt(offset)]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Failed to get transaction history' });
  }
});

// Add deposit (simulated - for testing)
router.post('/deposit', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0 || amount > 1000000) {
      return res.status(400).json({ error: 'Invalid amount (max $10,000)' });
    }

    const amountCents = Math.round(amount * 100);

    const result = await pool.query(
      `UPDATE wallets SET balance = balance + $1, updated_at = NOW()
       WHERE user_id = $2
       RETURNING balance`,
      [amountCents, req.user.id]
    );

    res.json({
      message: 'Deposit successful',
      newBalance: result.rows[0].balance,
    });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

module.exports = router;

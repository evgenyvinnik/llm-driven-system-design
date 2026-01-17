const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool, transaction } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { invalidateBalanceCache } = require('../db/redis');

const router = express.Router();

// Get all payment methods
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, is_default, name, last4, bank_name, verified, created_at
       FROM payment_methods
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ error: 'Failed to get payment methods' });
  }
});

// Add bank account (simulated - no real Plaid integration)
router.post('/bank', authMiddleware, async (req, res) => {
  try {
    const { bankName, accountType, routingNumber, accountNumber, nickname } = req.body;

    if (!bankName || !routingNumber || !accountNumber) {
      return res.status(400).json({ error: 'Bank name, routing number, and account number are required' });
    }

    // Validate routing number format (9 digits)
    if (!/^\d{9}$/.test(routingNumber)) {
      return res.status(400).json({ error: 'Invalid routing number format' });
    }

    // Validate account number (4-17 digits)
    if (!/^\d{4,17}$/.test(accountNumber)) {
      return res.status(400).json({ error: 'Invalid account number format' });
    }

    const last4 = accountNumber.slice(-4);
    const name = nickname || `${bankName} ${accountType || 'Checking'} (...${last4})`;

    // Check if this is the first payment method (make it default)
    const existingResult = await pool.query(
      'SELECT COUNT(*) as count FROM payment_methods WHERE user_id = $1',
      [req.user.id]
    );
    const isFirst = parseInt(existingResult.rows[0].count) === 0;

    const result = await pool.query(
      `INSERT INTO payment_methods (user_id, type, is_default, name, last4, bank_name, routing_number, account_number_encrypted, verified)
       VALUES ($1, 'bank', $2, $3, $4, $5, $6, $7, true)
       RETURNING id, type, is_default, name, last4, bank_name, verified, created_at`,
      [req.user.id, isFirst, name, last4, bankName, routingNumber, `encrypted_${accountNumber}`]
    );

    res.status(201).json({
      ...result.rows[0],
      message: 'Bank account linked successfully (simulated verification)',
    });
  } catch (error) {
    console.error('Add bank account error:', error);
    res.status(500).json({ error: 'Failed to add bank account' });
  }
});

// Add card (simulated)
router.post('/card', authMiddleware, async (req, res) => {
  try {
    const { cardNumber, expiryMonth, expiryYear, cvv, nickname, type = 'debit_card' } = req.body;

    if (!cardNumber || !expiryMonth || !expiryYear || !cvv) {
      return res.status(400).json({ error: 'Card details are required' });
    }

    // Basic card number validation (16 digits for most cards)
    const cleanCardNumber = cardNumber.replace(/\s/g, '');
    if (!/^\d{13,19}$/.test(cleanCardNumber)) {
      return res.status(400).json({ error: 'Invalid card number' });
    }

    const last4 = cleanCardNumber.slice(-4);
    const name = nickname || `Card ending in ${last4}`;

    // Check if this is the first payment method
    const existingResult = await pool.query(
      'SELECT COUNT(*) as count FROM payment_methods WHERE user_id = $1',
      [req.user.id]
    );
    const isFirst = parseInt(existingResult.rows[0].count) === 0;

    const result = await pool.query(
      `INSERT INTO payment_methods (user_id, type, is_default, name, last4, card_token, verified)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, type, is_default, name, last4, verified, created_at`,
      [req.user.id, type, isFirst, name, last4, `tok_${uuidv4()}`]
    );

    res.status(201).json({
      ...result.rows[0],
      message: 'Card added successfully (simulated verification)',
    });
  } catch (error) {
    console.error('Add card error:', error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// Set default payment method
router.post('/:id/default', authMiddleware, async (req, res) => {
  try {
    await transaction(async (client) => {
      // Remove default from all
      await client.query(
        'UPDATE payment_methods SET is_default = false WHERE user_id = $1',
        [req.user.id]
      );

      // Set new default
      const result = await client.query(
        `UPDATE payment_methods SET is_default = true
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [req.params.id, req.user.id]
      );

      if (result.rows.length === 0) {
        throw new Error('Payment method not found');
      }

      return result.rows[0];
    });

    res.json({ message: 'Default payment method updated' });
  } catch (error) {
    console.error('Set default error:', error);
    res.status(500).json({ error: error.message || 'Failed to set default' });
  }
});

// Delete payment method
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM payment_methods WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment method not found' });
    }

    // If deleted was default, set another as default
    if (result.rows[0].is_default) {
      await pool.query(
        `UPDATE payment_methods SET is_default = true
         WHERE user_id = $1 AND id = (
           SELECT id FROM payment_methods WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1
         )`,
        [req.user.id]
      );
    }

    res.json({ message: 'Payment method removed' });
  } catch (error) {
    console.error('Delete payment method error:', error);
    res.status(500).json({ error: 'Failed to delete payment method' });
  }
});

// Cashout to bank account
router.post('/cashout', authMiddleware, async (req, res) => {
  try {
    const { amount, speed = 'standard', paymentMethodId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const amountCents = Math.round(parseFloat(amount) * 100);

    const result = await transaction(async (client) => {
      // Lock wallet
      const walletResult = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [req.user.id]
      );

      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const wallet = walletResult.rows[0];

      if (wallet.balance < amountCents) {
        throw new Error('Insufficient balance');
      }

      // Get payment method
      let pmQuery = 'SELECT * FROM payment_methods WHERE user_id = $1 AND type = $2';
      let pmParams = [req.user.id, 'bank'];

      if (paymentMethodId) {
        pmQuery += ' AND id = $3';
        pmParams.push(paymentMethodId);
      } else {
        pmQuery += ' AND is_default = true';
      }

      const pmResult = await client.query(pmQuery, pmParams);

      if (pmResult.rows.length === 0) {
        throw new Error('No bank account linked');
      }

      const paymentMethod = pmResult.rows[0];

      // Calculate fee for instant
      let fee = 0;
      let estimatedArrival = new Date();

      if (speed === 'instant') {
        fee = Math.min(Math.round(amountCents * 0.015), 1500); // 1.5%, max $15
        estimatedArrival = new Date(); // Now
      } else {
        // Standard: 1-3 business days
        estimatedArrival.setDate(estimatedArrival.getDate() + 3);
      }

      // Debit balance
      await client.query(
        'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
        [amountCents, req.user.id]
      );

      // Create cashout record
      const cashoutResult = await client.query(
        `INSERT INTO cashouts (user_id, amount, fee, speed, status, payment_method_id, estimated_arrival)
         VALUES ($1, $2, $3, $4, 'processing', $5, $6)
         RETURNING *`,
        [req.user.id, amountCents, fee, speed, paymentMethod.id, estimatedArrival]
      );

      return {
        cashout: cashoutResult.rows[0],
        newBalance: wallet.balance - amountCents,
      };
    });

    await invalidateBalanceCache(req.user.id);

    res.json({
      message: `Cashout initiated (${speed})`,
      cashout: result.cashout,
      newBalance: result.newBalance,
      fee: result.cashout.fee,
      estimatedArrival: result.cashout.estimated_arrival,
    });
  } catch (error) {
    console.error('Cashout error:', error);
    res.status(400).json({ error: error.message || 'Cashout failed' });
  }
});

// Get cashout history
router.get('/cashouts', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, pm.name as payment_method_name, pm.last4
       FROM cashouts c
       LEFT JOIN payment_methods pm ON c.payment_method_id = pm.id
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get cashouts error:', error);
    res.status(500).json({ error: 'Failed to get cashout history' });
  }
});

module.exports = router;

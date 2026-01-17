const express = require('express');
const { pool, transaction } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { executeTransfer, MAX_TRANSFER_AMOUNT } = require('../services/transfer');

const router = express.Router();

// Create a payment request
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { recipientUsername, amount, note } = req.body;

    if (!recipientUsername || !amount) {
      return res.status(400).json({ error: 'Recipient and amount are required' });
    }

    // Convert amount to cents
    const amountCents = Math.round(parseFloat(amount) * 100);

    if (isNaN(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    if (amountCents > MAX_TRANSFER_AMOUNT) {
      return res.status(400).json({ error: `Maximum request amount is $${MAX_TRANSFER_AMOUNT / 100}` });
    }

    // Look up recipient (the person who will pay)
    const recipientResult = await pool.query(
      'SELECT id, username, name FROM users WHERE username = $1',
      [recipientUsername.toLowerCase()]
    );

    if (recipientResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const requestee = recipientResult.rows[0];

    if (requestee.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot request money from yourself' });
    }

    // Create the request
    const result = await pool.query(
      `INSERT INTO payment_requests (requester_id, requestee_id, amount, note)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.id, requestee.id, amountCents, note || '']
    );

    res.status(201).json({
      ...result.rows[0],
      requestee_username: requestee.username,
      requestee_name: requestee.name,
    });
  } catch (error) {
    console.error('Create request error:', error);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// Get requests sent by current user
router.get('/sent', authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT r.*,
             u.username as requestee_username,
             u.name as requestee_name,
             u.avatar_url as requestee_avatar
      FROM payment_requests r
      JOIN users u ON r.requestee_id = u.id
      WHERE r.requester_id = $1
    `;
    const params = [req.user.id];

    if (status) {
      query += ' AND r.status = $2';
      params.push(status);
    }

    query += ' ORDER BY r.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get sent requests error:', error);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

// Get requests received by current user
router.get('/received', authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT r.*,
             u.username as requester_username,
             u.name as requester_name,
             u.avatar_url as requester_avatar
      FROM payment_requests r
      JOIN users u ON r.requester_id = u.id
      WHERE r.requestee_id = $1
    `;
    const params = [req.user.id];

    if (status) {
      query += ' AND r.status = $2';
      params.push(status);
    }

    query += ' ORDER BY r.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get received requests error:', error);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

// Pay a request
router.post('/:id/pay', authMiddleware, async (req, res) => {
  try {
    const requestId = req.params.id;

    // Get the request
    const requestResult = await pool.query(
      'SELECT * FROM payment_requests WHERE id = $1 AND status = $2',
      [requestId, 'pending']
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }

    const request = requestResult.rows[0];

    // Verify the current user is the requestee
    if (request.requestee_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to pay this request' });
    }

    // Execute the transfer
    const transfer = await executeTransfer(
      req.user.id,
      request.requester_id,
      request.amount,
      request.note,
      'public'
    );

    // Update request status
    await pool.query(
      `UPDATE payment_requests
       SET status = 'paid', transfer_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [requestId, transfer.id]
    );

    res.json({
      message: 'Request paid successfully',
      transfer_id: transfer.id,
    });
  } catch (error) {
    console.error('Pay request error:', error);
    res.status(400).json({ error: error.message || 'Failed to pay request' });
  }
});

// Decline a request
router.post('/:id/decline', authMiddleware, async (req, res) => {
  try {
    const requestId = req.params.id;

    const result = await pool.query(
      `UPDATE payment_requests
       SET status = 'declined', updated_at = NOW()
       WHERE id = $1 AND requestee_id = $2 AND status = 'pending'
       RETURNING *`,
      [requestId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or not authorized' });
    }

    res.json({ message: 'Request declined', request: result.rows[0] });
  } catch (error) {
    console.error('Decline request error:', error);
    res.status(500).json({ error: 'Failed to decline request' });
  }
});

// Cancel a request (by requester)
router.post('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const requestId = req.params.id;

    const result = await pool.query(
      `UPDATE payment_requests
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND requester_id = $2 AND status = 'pending'
       RETURNING *`,
      [requestId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or not authorized' });
    }

    res.json({ message: 'Request cancelled', request: result.rows[0] });
  } catch (error) {
    console.error('Cancel request error:', error);
    res.status(500).json({ error: 'Failed to cancel request' });
  }
});

// Send a reminder (by requester)
router.post('/:id/remind', authMiddleware, async (req, res) => {
  try {
    const requestId = req.params.id;

    const result = await pool.query(
      `UPDATE payment_requests
       SET reminder_sent_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND requester_id = $2 AND status = 'pending'
       RETURNING *`,
      [requestId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or not authorized' });
    }

    res.json({ message: 'Reminder sent', request: result.rows[0] });
  } catch (error) {
    console.error('Send reminder error:', error);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

module.exports = router;

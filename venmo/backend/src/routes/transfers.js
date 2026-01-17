const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { idempotencyMiddleware, STATUS } = require('../shared/idempotency');
const { logger } = require('../shared/logger');
const { executeTransfer, getTransferById, MAX_TRANSFER_AMOUNT } = require('../services/transfer');

const router = express.Router();

/**
 * Send money to another user
 *
 * CRITICAL: This endpoint uses idempotency middleware to prevent duplicate transfers.
 * Clients MUST provide an Idempotency-Key header (UUID v4 recommended).
 *
 * WHY: Without idempotency, network retries or double-clicks could result in
 * sending money twice. The idempotency key ensures each logical payment intent
 * is only processed once, even if the request is received multiple times.
 */
router.post('/send', authMiddleware, idempotencyMiddleware('transfer'), async (req, res) => {
  const log = logger.child({
    operation: 'send_transfer',
    userId: req.user.id,
    requestId: req.requestId,
  });

  try {
    const { recipientUsername, amount, note, visibility = 'public' } = req.body;

    if (!recipientUsername || !amount) {
      return res.status(400).json({ error: 'Recipient and amount are required' });
    }

    // Convert amount to cents
    const amountCents = Math.round(parseFloat(amount) * 100);

    if (isNaN(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    if (amountCents > MAX_TRANSFER_AMOUNT) {
      return res.status(400).json({ error: `Maximum transfer amount is $${MAX_TRANSFER_AMOUNT / 100}` });
    }

    // Look up recipient by username
    const recipientResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [recipientUsername.toLowerCase()]
    );

    if (recipientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const recipientId = recipientResult.rows[0].id;

    // Execute the transfer with idempotency key and request context
    const transfer = await executeTransfer(
      req.user.id,
      recipientId,
      amountCents,
      note || '',
      visibility,
      {
        idempotencyKey: req.idempotencyKey, // From idempotency middleware
        request: req, // For audit logging (IP, user agent)
      }
    );

    // Get full transfer details
    const fullTransfer = await getTransferById(transfer.id);

    // Store success in idempotency cache (if middleware is active)
    if (req.storeIdempotencyResult && !transfer._cached) {
      await req.storeIdempotencyResult(STATUS.COMPLETED, fullTransfer);
    }

    log.info({
      event: 'transfer_sent',
      transferId: transfer.id,
      amount: amountCents,
      recipient: recipientUsername,
      cached: transfer._cached || false,
    });

    res.status(201).json(fullTransfer);
  } catch (error) {
    log.error({
      event: 'transfer_failed',
      error: error.message,
    });

    // Store failure in idempotency cache
    if (req.storeIdempotencyResult) {
      await req.storeIdempotencyResult(STATUS.FAILED, {
        error: error.message,
        statusCode: 400,
      });
    }

    res.status(400).json({ error: error.message || 'Transfer failed' });
  }
});

// Get transfer by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const transfer = await getTransferById(req.params.id);

    if (!transfer) {
      return res.status(404).json({ error: 'Transfer not found' });
    }

    // Check if user is participant or can see based on visibility
    const isParticipant = transfer.sender_id === req.user.id || transfer.receiver_id === req.user.id;

    if (!isParticipant && transfer.visibility === 'private') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get likes count
    const likesResult = await pool.query(
      'SELECT COUNT(*) as count FROM transfer_likes WHERE transfer_id = $1',
      [req.params.id]
    );

    // Check if current user liked
    const userLikedResult = await pool.query(
      'SELECT 1 FROM transfer_likes WHERE user_id = $1 AND transfer_id = $2',
      [req.user.id, req.params.id]
    );

    // Get comments
    const commentsResult = await pool.query(
      `SELECT c.*, u.username, u.name, u.avatar_url
       FROM transfer_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.transfer_id = $1
       ORDER BY c.created_at ASC`,
      [req.params.id]
    );

    res.json({
      ...transfer,
      likes_count: parseInt(likesResult.rows[0].count),
      user_liked: userLikedResult.rows.length > 0,
      comments: commentsResult.rows,
    });
  } catch (error) {
    logger.error({
      event: 'get_transfer_error',
      error: error.message,
      transferId: req.params.id,
    });
    res.status(500).json({ error: 'Failed to get transfer' });
  }
});

// Like a transfer
router.post('/:id/like', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO transfer_likes (user_id, transfer_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, req.params.id]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM transfer_likes WHERE transfer_id = $1',
      [req.params.id]
    );

    res.json({ likes_count: parseInt(countResult.rows[0].count), user_liked: true });
  } catch (error) {
    logger.error({
      event: 'like_transfer_error',
      error: error.message,
      transferId: req.params.id,
    });
    res.status(500).json({ error: 'Failed to like transfer' });
  }
});

// Unlike a transfer
router.delete('/:id/like', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM transfer_likes WHERE user_id = $1 AND transfer_id = $2',
      [req.user.id, req.params.id]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM transfer_likes WHERE transfer_id = $1',
      [req.params.id]
    );

    res.json({ likes_count: parseInt(countResult.rows[0].count), user_liked: false });
  } catch (error) {
    logger.error({
      event: 'unlike_transfer_error',
      error: error.message,
      transferId: req.params.id,
    });
    res.status(500).json({ error: 'Failed to unlike transfer' });
  }
});

// Add comment to transfer
router.post('/:id/comments', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    const result = await pool.query(
      `INSERT INTO transfer_comments (user_id, transfer_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.user.id, req.params.id, content.trim()]
    );

    res.status(201).json({
      ...result.rows[0],
      username: req.user.username,
      name: req.user.name,
      avatar_url: req.user.avatar_url,
    });
  } catch (error) {
    logger.error({
      event: 'add_comment_error',
      error: error.message,
      transferId: req.params.id,
    });
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

module.exports = router;

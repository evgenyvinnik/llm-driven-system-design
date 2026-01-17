import express from 'express';
import { query } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { getConnectionStats } from '../services/websocket.js';
import { closeAuction } from '../services/scheduler.js';

const router = express.Router();

// All admin routes require authentication and admin role
router.use(authenticate, requireAdmin);

// Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const [usersResult, auctionsResult, bidsResult, activeResult] = await Promise.all([
      query('SELECT COUNT(*) FROM users'),
      query('SELECT COUNT(*) FROM auctions'),
      query('SELECT COUNT(*) FROM bids'),
      query("SELECT COUNT(*) FROM auctions WHERE status = 'active'"),
    ]);

    const websocketStats = getConnectionStats();

    res.json({
      users: parseInt(usersResult.rows[0].count),
      auctions: parseInt(auctionsResult.rows[0].count),
      bids: parseInt(bidsResult.rows[0].count),
      activeAuctions: parseInt(activeResult.rows[0].count),
      websocket: websocketStats,
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let queryText = `
      SELECT id, username, email, role, created_at,
        (SELECT COUNT(*) FROM auctions WHERE seller_id = users.id) as auction_count,
        (SELECT COUNT(*) FROM bids WHERE bidder_id = users.id) as bid_count
      FROM users
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (search) {
      queryText += ` AND (username ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    queryText += ` ORDER BY created_at DESC`;
    queryText += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), offset);

    const result = await query(queryText, params);

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Update user role
router.put('/users/:id/role', async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const result = await query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, email, role',
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Get all auctions for admin
router.get('/auctions', async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let queryText = `
      SELECT a.*, u.username as seller_name,
        (SELECT COUNT(*) FROM bids WHERE auction_id = a.id) as bid_count
      FROM auctions a
      JOIN users u ON a.seller_id = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status) {
      queryText += ` AND a.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    queryText += ` ORDER BY a.created_at DESC`;
    queryText += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), offset);

    const result = await query(queryText, params);

    res.json({ auctions: result.rows });
  } catch (error) {
    console.error('Error fetching auctions:', error);
    res.status(500).json({ error: 'Failed to fetch auctions' });
  }
});

// Force close an auction
router.post('/auctions/:id/close', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await closeAuction(id);
    res.json({ message: 'Auction closed', ...result });
  } catch (error) {
    console.error('Error closing auction:', error);
    res.status(500).json({ error: 'Failed to close auction' });
  }
});

// Cancel an auction (admin override)
router.post('/auctions/:id/cancel', async (req, res) => {
  const { id } = req.params;

  try {
    await query("UPDATE auctions SET status = 'cancelled' WHERE id = $1", [id]);
    res.json({ message: 'Auction cancelled' });
  } catch (error) {
    console.error('Error cancelling auction:', error);
    res.status(500).json({ error: 'Failed to cancel auction' });
  }
});

// Get recent notifications
router.get('/notifications', async (req, res) => {
  const { limit = 50 } = req.query;

  try {
    const result = await query(
      `SELECT n.*, u.username
       FROM notifications n
       JOIN users u ON n.user_id = u.id
       ORDER BY n.created_at DESC
       LIMIT $1`,
      [parseInt(limit)]
    );

    res.json({ notifications: result.rows });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Get system health
router.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
    });
  }
});

export default router;

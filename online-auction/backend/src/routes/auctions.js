import express from 'express';
import multer from 'multer';
import path from 'path';
import { query } from '../db.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { scheduleAuctionEnd, removeAuctionFromSchedule, invalidateAuctionCache } from '../redis.js';

const router = express.Router();

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  },
});

// Get all auctions with filters
router.get('/', optionalAuth, async (req, res) => {
  const { status = 'active', sort = 'end_time', order = 'asc', page = 1, limit = 20, search } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const validSorts = ['end_time', 'current_price', 'created_at', 'title'];
  const sortColumn = validSorts.includes(sort) ? sort : 'end_time';
  const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

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

    if (status !== 'all') {
      queryText += ` AND a.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (search) {
      queryText += ` AND (a.title ILIKE $${paramIndex} OR a.description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    queryText += ` ORDER BY a.${sortColumn} ${sortOrder}`;
    queryText += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), offset);

    const result = await query(queryText, params);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) FROM auctions WHERE 1=1';
    const countParams = [];
    let countIndex = 1;

    if (status !== 'all') {
      countQuery += ` AND status = $${countIndex}`;
      countParams.push(status);
      countIndex++;
    }

    if (search) {
      countQuery += ` AND (title ILIKE $${countIndex} OR description ILIKE $${countIndex})`;
      countParams.push(`%${search}%`);
    }

    const countResult = await query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    res.json({
      auctions: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching auctions:', error);
    res.status(500).json({ error: 'Failed to fetch auctions' });
  }
});

// Get single auction with bid history
router.get('/:id', optionalAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const auctionResult = await query(
      `SELECT a.*, u.username as seller_name
       FROM auctions a
       JOIN users u ON a.seller_id = u.id
       WHERE a.id = $1`,
      [id]
    );

    if (auctionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    const auction = auctionResult.rows[0];

    // Get bid history
    const bidsResult = await query(
      `SELECT b.id, b.amount, b.is_auto_bid, b.created_at, u.username as bidder_name, u.id as bidder_id
       FROM bids b
       JOIN users u ON b.bidder_id = u.id
       WHERE b.auction_id = $1
       ORDER BY b.sequence_num DESC
       LIMIT 50`,
      [id]
    );

    // Get user's auto-bid if authenticated
    let userAutoBid = null;
    if (req.user) {
      const autoBidResult = await query(
        'SELECT * FROM auto_bids WHERE auction_id = $1 AND bidder_id = $2 AND is_active = true',
        [id, req.user.id]
      );
      userAutoBid = autoBidResult.rows[0] || null;
    }

    // Check if user is watching this auction
    let isWatching = false;
    if (req.user) {
      const watchResult = await query(
        'SELECT 1 FROM watchlist WHERE user_id = $1 AND auction_id = $2',
        [req.user.id, id]
      );
      isWatching = watchResult.rows.length > 0;
    }

    res.json({
      auction,
      bids: bidsResult.rows,
      userAutoBid,
      isWatching,
    });
  } catch (error) {
    console.error('Error fetching auction:', error);
    res.status(500).json({ error: 'Failed to fetch auction' });
  }
});

// Create new auction
router.post('/', authenticate, upload.single('image'), async (req, res) => {
  const {
    title,
    description,
    starting_price,
    reserve_price,
    bid_increment = 1,
    duration_hours = 24,
    snipe_protection_minutes = 2,
  } = req.body;

  if (!title || !starting_price) {
    return res.status(400).json({ error: 'Title and starting price are required' });
  }

  const startingPriceNum = parseFloat(starting_price);
  if (isNaN(startingPriceNum) || startingPriceNum <= 0) {
    return res.status(400).json({ error: 'Starting price must be a positive number' });
  }

  try {
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + parseInt(duration_hours) * 60 * 60 * 1000);
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await query(
      `INSERT INTO auctions
        (seller_id, title, description, image_url, starting_price, current_price, reserve_price, bid_increment, start_time, end_time, snipe_protection_minutes, status)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, 'active')
       RETURNING *`,
      [
        req.user.id,
        title,
        description,
        imageUrl,
        startingPriceNum,
        reserve_price ? parseFloat(reserve_price) : null,
        parseFloat(bid_increment),
        startTime,
        endTime,
        parseInt(snipe_protection_minutes),
      ]
    );

    const auction = result.rows[0];

    // Schedule auction ending
    await scheduleAuctionEnd(auction.id, auction.end_time);

    res.status(201).json({ auction });
  } catch (error) {
    console.error('Error creating auction:', error);
    res.status(500).json({ error: 'Failed to create auction' });
  }
});

// Update auction (only by seller, only if no bids)
router.put('/:id', authenticate, upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const { title, description, reserve_price, snipe_protection_minutes } = req.body;

  try {
    // Check if auction exists and belongs to user
    const auctionResult = await query('SELECT * FROM auctions WHERE id = $1', [id]);

    if (auctionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    const auction = auctionResult.rows[0];

    if (auction.seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to update this auction' });
    }

    // Check if there are any bids
    const bidCount = await query('SELECT COUNT(*) FROM bids WHERE auction_id = $1', [id]);

    if (parseInt(bidCount.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot update auction with existing bids' });
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : auction.image_url;

    const result = await query(
      `UPDATE auctions
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           reserve_price = COALESCE($3, reserve_price),
           snipe_protection_minutes = COALESCE($4, snipe_protection_minutes),
           image_url = COALESCE($5, image_url)
       WHERE id = $6
       RETURNING *`,
      [title, description, reserve_price, snipe_protection_minutes, imageUrl, id]
    );

    await invalidateAuctionCache(id);

    res.json({ auction: result.rows[0] });
  } catch (error) {
    console.error('Error updating auction:', error);
    res.status(500).json({ error: 'Failed to update auction' });
  }
});

// Cancel auction (only by seller, only if no bids)
router.delete('/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const auctionResult = await query('SELECT * FROM auctions WHERE id = $1', [id]);

    if (auctionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    const auction = auctionResult.rows[0];

    if (auction.seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to cancel this auction' });
    }

    if (auction.status !== 'active') {
      return res.status(400).json({ error: 'Can only cancel active auctions' });
    }

    // Check if there are any bids
    const bidCount = await query('SELECT COUNT(*) FROM bids WHERE auction_id = $1', [id]);

    if (parseInt(bidCount.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot cancel auction with existing bids' });
    }

    await query("UPDATE auctions SET status = 'cancelled' WHERE id = $1", [id]);
    await removeAuctionFromSchedule(id);
    await invalidateAuctionCache(id);

    res.json({ message: 'Auction cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling auction:', error);
    res.status(500).json({ error: 'Failed to cancel auction' });
  }
});

// Add to watchlist
router.post('/:id/watch', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    await query(
      'INSERT INTO watchlist (user_id, auction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, id]
    );

    res.json({ message: 'Added to watchlist' });
  } catch (error) {
    console.error('Error adding to watchlist:', error);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

// Remove from watchlist
router.delete('/:id/watch', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    await query('DELETE FROM watchlist WHERE user_id = $1 AND auction_id = $2', [req.user.id, id]);

    res.json({ message: 'Removed from watchlist' });
  } catch (error) {
    console.error('Error removing from watchlist:', error);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

// Get user's watchlist
router.get('/user/watchlist', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT a.*, u.username as seller_name,
        (SELECT COUNT(*) FROM bids WHERE auction_id = a.id) as bid_count
       FROM watchlist w
       JOIN auctions a ON w.auction_id = a.id
       JOIN users u ON a.seller_id = u.id
       WHERE w.user_id = $1
       ORDER BY a.end_time ASC`,
      [req.user.id]
    );

    res.json({ auctions: result.rows });
  } catch (error) {
    console.error('Error fetching watchlist:', error);
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

// Get user's auctions (as seller)
router.get('/user/selling', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT a.*,
        (SELECT COUNT(*) FROM bids WHERE auction_id = a.id) as bid_count
       FROM auctions a
       WHERE a.seller_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );

    res.json({ auctions: result.rows });
  } catch (error) {
    console.error('Error fetching selling auctions:', error);
    res.status(500).json({ error: 'Failed to fetch selling auctions' });
  }
});

// Get user's bid history
router.get('/user/bids', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT DISTINCT ON (a.id) a.*, b.amount as user_bid, b.created_at as bid_time,
        (SELECT MAX(amount) FROM bids WHERE auction_id = a.id) as highest_bid,
        u.username as seller_name
       FROM bids b
       JOIN auctions a ON b.auction_id = a.id
       JOIN users u ON a.seller_id = u.id
       WHERE b.bidder_id = $1
       ORDER BY a.id, b.created_at DESC`,
      [req.user.id]
    );

    res.json({ auctions: result.rows });
  } catch (error) {
    console.error('Error fetching bid history:', error);
    res.status(500).json({ error: 'Failed to fetch bid history' });
  }
});

export default router;

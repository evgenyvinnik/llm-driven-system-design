import { Router, type Request, type Response } from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Create review (for a completed booking)
router.post('/', authenticate, async (req, res) => {
  const { booking_id, rating, cleanliness_rating, communication_rating, location_rating, value_rating, content } = req.body;

  if (!booking_id || !rating) {
    return res.status(400).json({ error: 'booking_id and rating are required' });
  }

  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  try {
    // Get booking details
    const bookingResult = await query(
      `SELECT b.*, l.host_id FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      WHERE b.id = $1 AND b.status = 'completed'`,
      [booking_id]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Completed booking not found' });
    }

    const booking = bookingResult.rows[0];

    // Determine author type
    let authorType;
    if (req.user!.id === booking.guest_id) {
      authorType = 'guest';
    } else if (req.user!.id === booking.host_id) {
      authorType = 'host';
    } else {
      return res.status(403).json({ error: 'Not authorized to review this booking' });
    }

    // Check if already reviewed
    const existingReview = await query(
      'SELECT id FROM reviews WHERE booking_id = $1 AND author_type = $2',
      [booking_id, authorType]
    );

    if (existingReview.rows.length > 0) {
      return res.status(400).json({ error: 'You have already reviewed this booking' });
    }

    // Create review
    const result = await query(
      `INSERT INTO reviews (
        booking_id, author_id, author_type, rating,
        cleanliness_rating, communication_rating, location_rating, value_rating, content
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        booking_id, req.user!.id, authorType, rating,
        cleanliness_rating, communication_rating, location_rating, value_rating, content,
      ]
    );

    res.status(201).json({ review: result.rows[0] });
  } catch (error) {
    console.error('Create review error:', error);
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// Get reviews for a listing (only public/visible ones)
router.get('/listing/:listingId', async (req, res) => {
  const { listingId } = req.params;
  const { limit = 10, offset = 0 } = req.query;

  try {
    const result = await query(
      `SELECT r.*, u.name as author_name, u.avatar_url as author_avatar
      FROM reviews r
      JOIN users u ON r.author_id = u.id
      JOIN bookings b ON r.booking_id = b.id
      WHERE b.listing_id = $1 AND r.is_public = TRUE AND r.author_type = 'guest'
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3`,
      [listingId, parseInt(String(limit)), parseInt(String(offset))]
    );

    // Get average ratings
    const statsResult = await query(
      `SELECT
        COUNT(*) as total,
        ROUND(AVG(rating)::numeric, 2) as avg_rating,
        ROUND(AVG(cleanliness_rating)::numeric, 2) as avg_cleanliness,
        ROUND(AVG(communication_rating)::numeric, 2) as avg_communication,
        ROUND(AVG(location_rating)::numeric, 2) as avg_location,
        ROUND(AVG(value_rating)::numeric, 2) as avg_value
      FROM reviews r
      JOIN bookings b ON r.booking_id = b.id
      WHERE b.listing_id = $1 AND r.is_public = TRUE AND r.author_type = 'guest'`,
      [listingId]
    );

    res.json({
      reviews: result.rows,
      stats: statsResult.rows[0],
    });
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// Get reviews about a user (as host or guest)
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const { type = 'all' } = req.query;

  try {
    let sql = `
      SELECT r.*, u.name as author_name, u.avatar_url as author_avatar,
        l.title as listing_title
      FROM reviews r
      JOIN users u ON r.author_id = u.id
      JOIN bookings b ON r.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      WHERE r.is_public = TRUE
    `;

    const params = [userId];

    if (type === 'as_host') {
      // Reviews written by guests about this host's listings
      sql += ` AND l.host_id = $1 AND r.author_type = 'guest'`;
    } else if (type === 'as_guest') {
      // Reviews written by hosts about this guest
      sql += ` AND b.guest_id = $1 AND r.author_type = 'host'`;
    } else {
      // All reviews about this user
      sql += ` AND ((l.host_id = $1 AND r.author_type = 'guest') OR (b.guest_id = $1 AND r.author_type = 'host'))`;
    }

    sql += ' ORDER BY r.created_at DESC LIMIT 50';

    const result = await query(sql, params);

    res.json({ reviews: result.rows });
  } catch (error) {
    console.error('Get user reviews error:', error);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// Get review status for a booking (what reviews exist, visibility)
router.get('/booking/:bookingId/status', authenticate, async (req, res) => {
  const { bookingId } = req.params;

  try {
    // Verify access
    const bookingResult = await query(
      `SELECT b.guest_id, l.host_id FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (req.user!.id !== booking.guest_id && req.user!.id !== booking.host_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const reviewsResult = await query(
      'SELECT author_type, is_public FROM reviews WHERE booking_id = $1',
      [bookingId]
    );

    const hostReviewed = reviewsResult.rows.some((r) => r.author_type === 'host');
    const guestReviewed = reviewsResult.rows.some((r) => r.author_type === 'guest');
    const visible = reviewsResult.rows.some((r) => r.is_public);

    res.json({
      host_reviewed: hostReviewed,
      guest_reviewed: guestReviewed,
      visible,
      can_review: req.user!.id === booking.guest_id ? !guestReviewed : !hostReviewed,
    });
  } catch (error) {
    console.error('Get review status error:', error);
    res.status(500).json({ error: 'Failed to fetch review status' });
  }
});

export default router;

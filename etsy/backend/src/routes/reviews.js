import { Router } from 'express';
import db from '../db/index.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();

// Get reviews for a product
router.get('/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { limit = 10, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT r.*, u.username, u.avatar_url
       FROM reviews r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [parseInt(productId), parseInt(limit), parseInt(offset)]
    );

    const countResult = await db.query(
      'SELECT COUNT(*) FROM reviews WHERE product_id = $1',
      [parseInt(productId)]
    );

    const avgResult = await db.query(
      'SELECT AVG(rating)::numeric(2,1) as avg_rating FROM reviews WHERE product_id = $1',
      [parseInt(productId)]
    );

    res.json({
      reviews: result.rows,
      total: parseInt(countResult.rows[0].count),
      averageRating: parseFloat(avgResult.rows[0].avg_rating) || 0,
    });
  } catch (error) {
    console.error('Get product reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// Get reviews for a shop
router.get('/shop/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { limit = 10, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT r.*, u.username, u.avatar_url, p.title as product_title
       FROM reviews r
       LEFT JOIN users u ON r.user_id = u.id
       LEFT JOIN products p ON r.product_id = p.id
       WHERE r.shop_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [parseInt(shopId), parseInt(limit), parseInt(offset)]
    );

    const countResult = await db.query(
      'SELECT COUNT(*) FROM reviews WHERE shop_id = $1',
      [parseInt(shopId)]
    );

    const avgResult = await db.query(
      'SELECT AVG(rating)::numeric(2,1) as avg_rating FROM reviews WHERE shop_id = $1',
      [parseInt(shopId)]
    );

    res.json({
      reviews: result.rows,
      total: parseInt(countResult.rows[0].count),
      averageRating: parseFloat(avgResult.rows[0].avg_rating) || 0,
    });
  } catch (error) {
    console.error('Get shop reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// Create review (after purchase)
router.post('/', isAuthenticated, async (req, res) => {
  try {
    const { orderId, productId, rating, comment, images } = req.body;

    if (!orderId || !productId || !rating) {
      return res.status(400).json({ error: 'Order ID, product ID, and rating are required' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    // Verify order belongs to user and contains the product
    const orderResult = await db.query(
      `SELECT o.*, oi.id as item_id
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1 AND o.buyer_id = $2 AND oi.product_id = $3`,
      [parseInt(orderId), req.session.userId, parseInt(productId)]
    );

    if (orderResult.rows.length === 0) {
      return res.status(403).json({ error: 'You can only review products you have purchased' });
    }

    const order = orderResult.rows[0];

    // Check if already reviewed
    const existingReview = await db.query(
      'SELECT id FROM reviews WHERE order_id = $1 AND product_id = $2',
      [parseInt(orderId), parseInt(productId)]
    );

    if (existingReview.rows.length > 0) {
      return res.status(400).json({ error: 'You have already reviewed this product for this order' });
    }

    // Create review
    const result = await db.query(
      `INSERT INTO reviews (order_id, product_id, shop_id, user_id, rating, comment, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        parseInt(orderId),
        parseInt(productId),
        order.shop_id,
        req.session.userId,
        parseInt(rating),
        comment || null,
        images || [],
      ]
    );

    // Update shop rating
    const shopRatingResult = await db.query(
      `SELECT AVG(rating)::numeric(2,1) as avg_rating, COUNT(*) as review_count
       FROM reviews WHERE shop_id = $1`,
      [order.shop_id]
    );

    await db.query(
      'UPDATE shops SET rating = $1, review_count = $2 WHERE id = $3',
      [
        parseFloat(shopRatingResult.rows[0].avg_rating),
        parseInt(shopRatingResult.rows[0].review_count),
        order.shop_id,
      ]
    );

    res.status(201).json({ review: result.rows[0] });
  } catch (error) {
    console.error('Create review error:', error);
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// Update review
router.put('/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment, images } = req.body;

    // Check ownership
    const reviewResult = await db.query(
      'SELECT * FROM reviews WHERE id = $1 AND user_id = $2',
      [parseInt(id), req.session.userId]
    );

    if (reviewResult.rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }

    const result = await db.query(
      `UPDATE reviews SET
        rating = COALESCE($1, rating),
        comment = COALESCE($2, comment),
        images = COALESCE($3, images),
        updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        rating ? parseInt(rating) : null,
        comment,
        images,
        parseInt(id),
      ]
    );

    // Update shop rating
    const shopRatingResult = await db.query(
      `SELECT AVG(rating)::numeric(2,1) as avg_rating FROM reviews WHERE shop_id = $1`,
      [reviewResult.rows[0].shop_id]
    );

    await db.query(
      'UPDATE shops SET rating = $1 WHERE id = $2',
      [parseFloat(shopRatingResult.rows[0].avg_rating), reviewResult.rows[0].shop_id]
    );

    res.json({ review: result.rows[0] });
  } catch (error) {
    console.error('Update review error:', error);
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// Delete review
router.delete('/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;

    const reviewResult = await db.query(
      'SELECT * FROM reviews WHERE id = $1 AND user_id = $2',
      [parseInt(id), req.session.userId]
    );

    if (reviewResult.rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }

    await db.query('DELETE FROM reviews WHERE id = $1', [parseInt(id)]);

    // Update shop rating
    const shopRatingResult = await db.query(
      `SELECT AVG(rating)::numeric(2,1) as avg_rating, COUNT(*) as review_count
       FROM reviews WHERE shop_id = $1`,
      [reviewResult.rows[0].shop_id]
    );

    await db.query(
      'UPDATE shops SET rating = COALESCE($1, 0), review_count = $2 WHERE id = $3',
      [
        parseFloat(shopRatingResult.rows[0].avg_rating) || 0,
        parseInt(shopRatingResult.rows[0].review_count),
        reviewResult.rows[0].shop_id,
      ]
    );

    res.json({ message: 'Review deleted' });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

export default router;

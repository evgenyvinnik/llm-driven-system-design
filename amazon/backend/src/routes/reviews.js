import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../services/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { cacheDel } from '../services/redis.js';

const router = Router();

// Get reviews for a product
router.get('/product/:productId', async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { page = 0, limit = 10, sort = 'newest' } = req.query;

    let orderBy = 'r.created_at DESC';
    switch (sort) {
      case 'helpful':
        orderBy = 'r.helpful_count DESC, r.created_at DESC';
        break;
      case 'highest':
        orderBy = 'r.rating DESC, r.created_at DESC';
        break;
      case 'lowest':
        orderBy = 'r.rating ASC, r.created_at DESC';
        break;
    }

    const offset = parseInt(page) * parseInt(limit);

    const result = await query(
      `SELECT r.*, u.name as user_name
       FROM reviews r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.product_id = $1
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [productId, parseInt(limit), offset]
    );

    // Get rating summary
    const summaryResult = await query(
      `SELECT
         COUNT(*) as total_reviews,
         AVG(rating)::numeric(2,1) as average_rating,
         COUNT(*) FILTER (WHERE rating = 5) as five_star,
         COUNT(*) FILTER (WHERE rating = 4) as four_star,
         COUNT(*) FILTER (WHERE rating = 3) as three_star,
         COUNT(*) FILTER (WHERE rating = 2) as two_star,
         COUNT(*) FILTER (WHERE rating = 1) as one_star
       FROM reviews
       WHERE product_id = $1`,
      [productId]
    );

    res.json({
      reviews: result.rows,
      summary: summaryResult.rows[0],
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    next(error);
  }
});

// Create review
router.post('/',
  requireAuth,
  body('productId').isInt(),
  body('rating').isInt({ min: 1, max: 5 }),
  body('title').optional().trim().isLength({ max: 255 }),
  body('content').optional().trim(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { productId, rating, title, content, orderId } = req.body;

      // Check if user already reviewed this product
      const existingResult = await query(
        'SELECT id FROM reviews WHERE product_id = $1 AND user_id = $2',
        [productId, req.user.id]
      );

      if (existingResult.rows.length > 0) {
        return res.status(409).json({ error: 'You have already reviewed this product' });
      }

      // Check if this is a verified purchase
      let verifiedPurchase = false;
      if (orderId) {
        const orderResult = await query(
          `SELECT o.id FROM orders o
           JOIN order_items oi ON o.id = oi.order_id
           WHERE o.id = $1 AND o.user_id = $2 AND oi.product_id = $3 AND o.status = 'delivered'`,
          [orderId, req.user.id, productId]
        );
        verifiedPurchase = orderResult.rows.length > 0;
      } else {
        // Check if user ever purchased this product
        const purchaseResult = await query(
          `SELECT o.id FROM orders o
           JOIN order_items oi ON o.id = oi.order_id
           WHERE o.user_id = $1 AND oi.product_id = $2 AND o.status = 'delivered'
           LIMIT 1`,
          [req.user.id, productId]
        );
        verifiedPurchase = purchaseResult.rows.length > 0;
      }

      const result = await query(
        `INSERT INTO reviews (product_id, user_id, order_id, rating, title, content, verified_purchase)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [productId, req.user.id, orderId, rating, title, content, verifiedPurchase]
      );

      // Invalidate product cache
      await cacheDel(`product:${productId}`);

      res.status(201).json({ review: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

// Update review
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rating, title, content } = req.body;

    const result = await query(
      `UPDATE reviews
       SET rating = COALESCE($1, rating),
           title = COALESCE($2, title),
           content = COALESCE($3, content),
           updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [rating, title, content, id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Invalidate product cache
    await cacheDel(`product:${result.rows[0].product_id}`);

    res.json({ review: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Delete review
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get the review first to check ownership and get product_id
    const reviewResult = await query(
      'SELECT * FROM reviews WHERE id = $1',
      [id]
    );

    if (reviewResult.rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }

    const review = reviewResult.rows[0];

    // Check if user owns the review or is admin
    if (review.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to delete this review' });
    }

    await query('DELETE FROM reviews WHERE id = $1', [id]);

    // Invalidate product cache
    await cacheDel(`product:${review.product_id}`);

    res.json({ message: 'Review deleted' });
  } catch (error) {
    next(error);
  }
});

// Mark review as helpful
router.post('/:id/helpful', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE reviews
       SET helpful_count = helpful_count + 1
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }

    res.json({ review: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

export default router;

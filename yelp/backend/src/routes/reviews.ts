import { Router } from 'express';
import { pool } from '../utils/db.js';
import { cache } from '../utils/redis.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { publishBusinessIndexUpdate } from '../utils/queue.js';
import { logger } from '../utils/logger.js';
import {
  recordReviewCreated,
  recordReviewRejected,
  reviewVotesTotal,
} from '../utils/metrics.js';
import { idempotencyMiddleware } from '../utils/idempotency.js';
import {
  reviewRateLimit,
  voteRateLimit,
  canReviewBusiness,
  recordReviewAction,
} from '../utils/reviewRateLimit.js';

const router = Router();

// ============================================================================
// Create a Review
// With idempotency protection and rate limiting
// ============================================================================
router.post(
  '/',
  authenticate,
  reviewRateLimit,
  idempotencyMiddleware({ required: false }),
  async (req, res) => {
    try {
      const { business_id, rating, text } = req.body;

      // Validate required fields
      if (!business_id || !rating || !text) {
        recordReviewRejected('missing_fields');
        return res.status(400).json({
          error: { message: 'Business ID, rating, and text are required' }
        });
      }

      // Validate rating range
      if (rating < 1 || rating > 5) {
        recordReviewRejected('invalid_rating');
        return res.status(400).json({ error: { message: 'Rating must be between 1 and 5' } });
      }

      // Validate text length
      if (text.length < 10) {
        recordReviewRejected('text_too_short');
        return res.status(400).json({ error: { message: 'Review text must be at least 10 characters' } });
      }

      if (text.length > 5000) {
        recordReviewRejected('text_too_long');
        return res.status(400).json({ error: { message: 'Review text must not exceed 5000 characters' } });
      }

      // Check if business exists
      const businessCheck = await pool.query('SELECT id FROM businesses WHERE id = $1', [business_id]);
      if (businessCheck.rows.length === 0) {
        recordReviewRejected('business_not_found');
        return res.status(404).json({ error: { message: 'Business not found' } });
      }

      // Check rate limit for this specific business
      const businessRateCheck = await canReviewBusiness(req.user.id, business_id);
      if (!businessRateCheck.allowed) {
        recordReviewRejected('rate_limited_business');
        return res.status(429).json({ error: { message: businessRateCheck.message } });
      }

      // Check if user already reviewed this business
      const existingReview = await pool.query(
        'SELECT id FROM reviews WHERE business_id = $1 AND user_id = $2',
        [business_id, req.user.id]
      );

      if (existingReview.rows.length > 0) {
        recordReviewRejected('duplicate');
        return res.status(409).json({
          error: { message: 'You have already reviewed this business' }
        });
      }

      // Create review (trigger will update business rating)
      const result = await pool.query(
        `INSERT INTO reviews (business_id, user_id, rating, text)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [business_id, req.user.id, rating, text]
      );

      const review = result.rows[0];

      // Record the review action for rate limiting
      await recordReviewAction(req.user.id, business_id);

      // Get updated business rating for ES update
      const businessResult = await pool.query(
        'SELECT rating, review_count FROM businesses WHERE id = $1',
        [business_id]
      );

      // Update Elasticsearch asynchronously via queue
      publishBusinessIndexUpdate(business_id, {
        rating: parseFloat(businessResult.rows[0].rating),
        review_count: parseInt(businessResult.rows[0].review_count)
      });

      // Clear caches
      await cache.delPattern(`business:${business_id}*`);
      await cache.delPattern(`search:*`); // Invalidate search cache as ratings changed

      // Record metrics
      recordReviewCreated(rating);

      logger.info({
        component: 'review',
        userId: req.user.id,
        businessId: business_id,
        reviewId: review.id,
        rating,
      }, 'Review created');

      res.status(201).json({
        review: {
          ...review,
          user_name: req.user.name,
          user_avatar: req.user.avatar_url
        }
      });
    } catch (error) {
      logger.error({ component: 'review', error: error.message }, 'Create review error');
      res.status(500).json({ error: { message: 'Failed to create review' } });
    }
  }
);

// ============================================================================
// Get a Specific Review
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Try cache first
    const cacheKey = `review:${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ review: cached });
    }

    const result = await pool.query(
      `SELECT r.*,
              u.name as user_name, u.avatar_url as user_avatar, u.review_count as user_review_count,
              b.name as business_name, b.slug as business_slug,
              rr.text as response_text, rr.created_at as response_created_at,
              array_agg(DISTINCT rp.url) FILTER (WHERE rp.url IS NOT NULL) as photos
       FROM reviews r
       JOIN users u ON r.user_id = u.id
       JOIN businesses b ON r.business_id = b.id
       LEFT JOIN review_responses rr ON r.id = rr.review_id
       LEFT JOIN review_photos rp ON r.id = rp.review_id
       WHERE r.id = $1
       GROUP BY r.id, u.name, u.avatar_url, u.review_count, b.name, b.slug, rr.text, rr.created_at`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Review not found' } });
    }

    const review = result.rows[0];

    // Cache for 5 minutes
    await cache.set(cacheKey, review, 300);

    res.json({ review });
  } catch (error) {
    logger.error({ component: 'review', error: error.message }, 'Get review error');
    res.status(500).json({ error: { message: 'Failed to fetch review' } });
  }
});

// ============================================================================
// Update a Review
// ============================================================================
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, text } = req.body;

    // Check ownership
    const reviewCheck = await pool.query(
      'SELECT user_id, business_id, rating as old_rating FROM reviews WHERE id = $1',
      [id]
    );

    if (reviewCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Review not found' } });
    }

    if (reviewCheck.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: { message: 'Not authorized to update this review' } });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (rating !== undefined) {
      if (rating < 1 || rating > 5) {
        return res.status(400).json({ error: { message: 'Rating must be between 1 and 5' } });
      }
      updates.push(`rating = $${paramIndex++}`);
      values.push(rating);
    }

    if (text !== undefined) {
      if (text.length < 10 || text.length > 5000) {
        return res.status(400).json({
          error: { message: 'Review text must be between 10 and 5000 characters' }
        });
      }
      updates.push(`text = $${paramIndex++}`);
      values.push(text);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: { message: 'No updates provided' } });
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE reviews SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    // Get updated business rating for ES update
    const businessId = reviewCheck.rows[0].business_id;
    const businessResult = await pool.query(
      'SELECT rating, review_count FROM businesses WHERE id = $1',
      [businessId]
    );

    // Update Elasticsearch asynchronously via queue
    publishBusinessIndexUpdate(businessId, {
      rating: parseFloat(businessResult.rows[0].rating),
      review_count: parseInt(businessResult.rows[0].review_count)
    });

    // Clear caches
    await cache.delPattern(`business:${businessId}*`);
    await cache.del(`review:${id}`);

    logger.info({
      component: 'review',
      userId: req.user.id,
      reviewId: id,
      updates: Object.keys(req.body),
    }, 'Review updated');

    res.json({ review: result.rows[0] });
  } catch (error) {
    logger.error({ component: 'review', error: error.message }, 'Update review error');
    res.status(500).json({ error: { message: 'Failed to update review' } });
  }
});

// ============================================================================
// Delete a Review
// ============================================================================
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership
    const reviewCheck = await pool.query(
      'SELECT user_id, business_id FROM reviews WHERE id = $1',
      [id]
    );

    if (reviewCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Review not found' } });
    }

    if (reviewCheck.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: { message: 'Not authorized to delete this review' } });
    }

    const businessId = reviewCheck.rows[0].business_id;

    // Delete review (trigger will update business rating)
    await pool.query('DELETE FROM reviews WHERE id = $1', [id]);

    // Get updated business rating for ES update
    const businessResult = await pool.query(
      'SELECT rating, review_count FROM businesses WHERE id = $1',
      [businessId]
    );

    // Update Elasticsearch asynchronously via queue
    publishBusinessIndexUpdate(businessId, {
      rating: parseFloat(businessResult.rows[0].rating) || 0,
      review_count: parseInt(businessResult.rows[0].review_count) || 0
    });

    // Clear caches
    await cache.delPattern(`business:${businessId}*`);
    await cache.del(`review:${id}`);

    logger.info({
      component: 'review',
      userId: req.user.id,
      reviewId: id,
      businessId,
    }, 'Review deleted');

    res.json({ message: 'Review deleted successfully' });
  } catch (error) {
    logger.error({ component: 'review', error: error.message }, 'Delete review error');
    res.status(500).json({ error: { message: 'Failed to delete review' } });
  }
});

// ============================================================================
// Vote on a Review (helpful/funny/cool)
// With rate limiting
// ============================================================================
router.post('/:id/vote', authenticate, voteRateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const { vote_type } = req.body;

    if (!['helpful', 'funny', 'cool'].includes(vote_type)) {
      return res.status(400).json({
        error: { message: 'Vote type must be helpful, funny, or cool' }
      });
    }

    // Check if review exists
    const reviewCheck = await pool.query('SELECT id FROM reviews WHERE id = $1', [id]);
    if (reviewCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Review not found' } });
    }

    // Check if already voted
    const existingVote = await pool.query(
      'SELECT id FROM review_votes WHERE review_id = $1 AND user_id = $2 AND vote_type = $3',
      [id, req.user.id, vote_type]
    );

    if (existingVote.rows.length > 0) {
      // Remove vote
      await pool.query(
        'DELETE FROM review_votes WHERE review_id = $1 AND user_id = $2 AND vote_type = $3',
        [id, req.user.id, vote_type]
      );

      await pool.query(
        `UPDATE reviews SET ${vote_type}_count = ${vote_type}_count - 1 WHERE id = $1`,
        [id]
      );

      // Clear review cache
      await cache.del(`review:${id}`);

      res.json({ message: 'Vote removed', voted: false });
    } else {
      // Add vote
      await pool.query(
        'INSERT INTO review_votes (review_id, user_id, vote_type) VALUES ($1, $2, $3)',
        [id, req.user.id, vote_type]
      );

      await pool.query(
        `UPDATE reviews SET ${vote_type}_count = ${vote_type}_count + 1 WHERE id = $1`,
        [id]
      );

      // Record metric
      reviewVotesTotal.inc({ vote_type });

      // Clear review cache
      await cache.del(`review:${id}`);

      res.json({ message: 'Vote added', voted: true });
    }
  } catch (error) {
    logger.error({ component: 'review', error: error.message }, 'Vote error');
    res.status(500).json({ error: { message: 'Failed to vote' } });
  }
});

// ============================================================================
// Add Photos to a Review
// ============================================================================
router.post('/:id/photos', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { url, caption } = req.body;

    if (!url) {
      return res.status(400).json({ error: { message: 'Photo URL is required' } });
    }

    // Check ownership
    const reviewCheck = await pool.query(
      'SELECT user_id FROM reviews WHERE id = $1',
      [id]
    );

    if (reviewCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Review not found' } });
    }

    if (reviewCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: { message: 'Not authorized' } });
    }

    const result = await pool.query(
      'INSERT INTO review_photos (review_id, url, caption) VALUES ($1, $2, $3) RETURNING *',
      [id, url, caption]
    );

    // Clear review cache
    await cache.del(`review:${id}`);

    res.status(201).json({ photo: result.rows[0] });
  } catch (error) {
    logger.error({ component: 'review', error: error.message }, 'Add photo error');
    res.status(500).json({ error: { message: 'Failed to add photo' } });
  }
});

// ============================================================================
// Business Owner Respond to Review
// ============================================================================
router.post('/:id/respond', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: { message: 'Response text is required' } });
    }

    if (text.length > 2000) {
      return res.status(400).json({ error: { message: 'Response text must not exceed 2000 characters' } });
    }

    // Get review and check business ownership
    const reviewCheck = await pool.query(
      `SELECT r.business_id, b.owner_id
       FROM reviews r
       JOIN businesses b ON r.business_id = b.id
       WHERE r.id = $1`,
      [id]
    );

    if (reviewCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Review not found' } });
    }

    if (reviewCheck.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: { message: 'Not authorized to respond to this review' } });
    }

    // Check if response already exists
    const existingResponse = await pool.query(
      'SELECT id FROM review_responses WHERE review_id = $1',
      [id]
    );

    let result;
    if (existingResponse.rows.length > 0) {
      result = await pool.query(
        `UPDATE review_responses SET text = $1, updated_at = NOW()
         WHERE review_id = $2
         RETURNING *`,
        [text, id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO review_responses (review_id, business_id, text)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [id, reviewCheck.rows[0].business_id, text]
      );
    }

    // Clear review cache
    await cache.del(`review:${id}`);

    logger.info({
      component: 'review',
      userId: req.user.id,
      reviewId: id,
      businessId: reviewCheck.rows[0].business_id,
    }, 'Review response added');

    res.json({ response: result.rows[0] });
  } catch (error) {
    logger.error({ component: 'review', error: error.message }, 'Respond to review error');
    res.status(500).json({ error: { message: 'Failed to respond to review' } });
  }
});

export default router;

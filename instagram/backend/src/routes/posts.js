import { Router } from 'express';
import multer from 'multer';
import { query, getClient } from '../services/db.js';
import { storeOriginalImage, FILTERS } from '../services/storage.js';
import { publishImageProcessingJob, isQueueReady } from '../services/queue.js';
import { timelineAdd, timelineRemove, cacheGet, cacheSet, cacheDel } from '../services/redis.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { postRateLimiter, likeRateLimiter } from '../services/rateLimiter.js';
import logger from '../services/logger.js';
import {
  postsCreatedTotal,
  postsDeletedTotal,
  likesTotal,
  likesDuplicateTotal,
} from '../services/metrics.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Create post with async image processing.
 *
 * Flow:
 * 1. Store original images in MinIO
 * 2. Create post with status 'processing'
 * 3. Publish job to RabbitMQ
 * 4. Return 202 Accepted immediately
 * 5. Worker processes images and updates status to 'published'
 */
router.post('/', requireAuth, postRateLimiter, upload.array('media', 10), async (req, res) => {
  const client = await getClient();

  try {
    const { caption, location, filters } = req.body;
    const userId = req.session.userId;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one image is required' });
    }

    // Parse filters (JSON array or default to 'none' for all)
    let filterArray = [];
    try {
      filterArray = filters ? JSON.parse(filters) : [];
    } catch {
      filterArray = [];
    }

    await client.query('BEGIN');

    // Create post with 'processing' status
    const postResult = await client.query(
      `INSERT INTO posts (user_id, caption, location, status)
       VALUES ($1, $2, $3, 'processing')
       RETURNING *`,
      [userId, caption || '', location || null]
    );
    const post = postResult.rows[0];

    // Store original images and create media records
    const mediaItems = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filterName = filterArray[i] || 'none';

      // Store original in MinIO
      const { key: originalKey } = await storeOriginalImage(file.buffer, file.originalname);

      // Create media record with original_key (no processed URLs yet)
      const mediaInsert = await client.query(
        `INSERT INTO post_media (post_id, media_type, original_key, filter_applied, order_index)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [post.id, 'image', originalKey, filterName, i]
      );

      mediaItems.push({
        originalKey,
        filterName,
        orderIndex: i,
      });
    }

    await client.query('COMMIT');

    // Publish job to queue for async processing
    const jobPublished = await publishImageProcessingJob({
      postId: post.id,
      userId,
      mediaItems,
    });

    if (!jobPublished) {
      logger.warn({ postId: post.id }, 'Failed to publish job, post will remain in processing state');
    }

    // Increment metrics
    postsCreatedTotal.inc();

    logger.info({
      type: 'post_created',
      postId: post.id,
      userId,
      mediaCount: files.length,
      status: 'processing',
    }, `Post created (processing): ${post.id}`);

    // Return 202 Accepted for async processing
    res.status(202).json({
      post: {
        id: post.id,
        userId: post.user_id,
        caption: post.caption,
        location: post.location,
        status: 'processing',
        likeCount: post.like_count,
        commentCount: post.comment_count,
        createdAt: post.created_at,
        media: mediaItems.map((m, i) => ({
          orderIndex: i,
          filterApplied: m.filterName,
          status: 'processing',
        })),
      },
      message: 'Post is being processed. Images will be available shortly.',
    });
  } catch (error) {
    await client.query('ROLLBACK');

    logger.error({
      type: 'post_create_error',
      error: error.message,
      userId: req.session.userId,
    }, `Create post error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get single post
router.get('/:postId', optionalAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session?.userId;

    // Try cache first
    const cached = await cacheGet(`post:${postId}`);
    if (cached) {
      // Add user-specific data
      if (userId) {
        const likeCheck = await query(
          'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
          [userId, postId]
        );
        cached.isLiked = likeCheck.rows.length > 0;

        const savedCheck = await query(
          'SELECT 1 FROM saved_posts WHERE user_id = $1 AND post_id = $2',
          [userId, postId]
        );
        cached.isSaved = savedCheck.rows.length > 0;
      }
      return res.json({ post: cached });
    }

    const postResult = await query(
      `SELECT p.*, u.username, u.display_name, u.profile_picture_url
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`,
      [postId]
    );

    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = postResult.rows[0];

    const mediaResult = await query(
      'SELECT * FROM post_media WHERE post_id = $1 ORDER BY order_index',
      [postId]
    );

    const postData = {
      id: post.id,
      userId: post.user_id,
      username: post.username,
      displayName: post.display_name,
      profilePictureUrl: post.profile_picture_url,
      caption: post.caption,
      location: post.location,
      likeCount: post.like_count,
      commentCount: post.comment_count,
      createdAt: post.created_at,
      media: mediaResult.rows.map((m) => ({
        id: m.id,
        mediaType: m.media_type,
        mediaUrl: m.media_url,
        thumbnailUrl: m.thumbnail_url,
        filterApplied: m.filter_applied,
        width: m.width,
        height: m.height,
        orderIndex: m.order_index,
      })),
    };

    // Cache for 5 minutes
    await cacheSet(`post:${postId}`, postData, 300);

    // Add user-specific data
    if (userId) {
      const likeCheck = await query(
        'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
        [userId, postId]
      );
      postData.isLiked = likeCheck.rows.length > 0;

      const savedCheck = await query(
        'SELECT 1 FROM saved_posts WHERE user_id = $1 AND post_id = $2',
        [userId, postId]
      );
      postData.isSaved = savedCheck.rows.length > 0;
    }

    res.json({ post: postData });
  } catch (error) {
    logger.error({
      type: 'post_get_error',
      error: error.message,
      postId: req.params.postId,
    }, `Get post error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete post
router.delete('/:postId', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session.userId;

    // Check ownership
    const postCheck = await query('SELECT user_id FROM posts WHERE id = $1', [postId]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    if (postCheck.rows[0].user_id !== userId && req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Delete post (cascade will handle media, likes, comments)
    await query('DELETE FROM posts WHERE id = $1', [postId]);

    // Increment metrics
    postsDeletedTotal.inc();

    logger.info({
      type: 'post_deleted',
      postId,
      userId,
    }, `Post deleted: ${postId}`);

    // Remove from timelines
    const followers = await query(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [userId]
    );
    for (const follower of followers.rows) {
      await timelineRemove(follower.follower_id, postId);
    }
    await timelineRemove(userId, postId);

    // Clear cache
    await cacheDel(`post:${postId}`);

    res.json({ message: 'Post deleted' });
  } catch (error) {
    logger.error({
      type: 'post_delete_error',
      error: error.message,
      postId: req.params.postId,
    }, `Delete post error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Like post - IDEMPOTENT operation
 *
 * WHY IDEMPOTENCY PREVENTS DUPLICATE LIKES:
 *
 * The `ON CONFLICT DO NOTHING` clause in PostgreSQL makes this operation
 * idempotent, meaning calling it multiple times produces the same result.
 *
 * Without idempotency:
 * - User clicks "like" button
 * - Network delay, button is clicked again
 * - Two like records created, count inflated
 *
 * With idempotency:
 * - UNIQUE constraint on (user_id, post_id) prevents duplicates
 * - ON CONFLICT DO NOTHING silently ignores duplicate attempts
 * - Response indicates if like was new or already existed
 * - like_count trigger only fires on actual inserts
 *
 * This is especially important for:
 * - Mobile apps with unreliable network
 * - Double-click prevention
 * - Retry logic in the client
 */
router.post('/:postId/like', requireAuth, likeRateLimiter, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session.userId;

    // Check if already liked (for idempotency tracking)
    const existingLike = await query(
      'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    const alreadyLiked = existingLike.rows.length > 0;

    if (alreadyLiked) {
      // Already liked - idempotent response
      likesDuplicateTotal.inc();
      logger.debug({
        type: 'like_duplicate',
        postId,
        userId,
      }, `Duplicate like attempt: ${postId}`);
      return res.json({ message: 'Post already liked', idempotent: true });
    }

    // Insert like - ON CONFLICT handles race conditions
    const result = await query(
      'INSERT INTO likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
      [userId, postId]
    );

    if (result.rows.length === 0) {
      // Race condition - another request inserted first
      likesDuplicateTotal.inc();
      return res.json({ message: 'Post already liked', idempotent: true });
    }

    // Track metrics
    likesTotal.labels('like').inc();

    logger.info({
      type: 'like_created',
      postId,
      userId,
    }, `Post liked: ${postId}`);

    // Clear post cache to reflect new like count
    await cacheDel(`post:${postId}`);

    res.json({ message: 'Post liked', idempotent: false });
  } catch (error) {
    logger.error({
      type: 'like_error',
      error: error.message,
      postId: req.params.postId,
    }, `Like post error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Unlike post - IDEMPOTENT operation
 *
 * Same idempotency pattern as liking:
 * - DELETE returns the deleted row if it existed
 * - If no row exists, operation succeeds silently
 * - Multiple unlike requests have the same effect as one
 */
router.delete('/:postId/like', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session.userId;

    // Delete like - returns deleted row if it existed
    const result = await query(
      'DELETE FROM likes WHERE user_id = $1 AND post_id = $2 RETURNING id',
      [userId, postId]
    );

    const wasLiked = result.rows.length > 0;

    if (!wasLiked) {
      // Already not liked - idempotent response
      logger.debug({
        type: 'unlike_idempotent',
        postId,
        userId,
      }, `Idempotent unlike: ${postId}`);
      return res.json({ message: 'Post was not liked', idempotent: true });
    }

    // Track metrics
    likesTotal.labels('unlike').inc();

    logger.info({
      type: 'unlike',
      postId,
      userId,
    }, `Post unliked: ${postId}`);

    await cacheDel(`post:${postId}`);

    res.json({ message: 'Post unliked', idempotent: false });
  } catch (error) {
    logger.error({
      type: 'unlike_error',
      error: error.message,
      postId: req.params.postId,
    }, `Unlike post error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save post
router.post('/:postId/save', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session.userId;

    await query(
      'INSERT INTO saved_posts (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, postId]
    );

    res.json({ message: 'Post saved' });
  } catch (error) {
    logger.error({
      type: 'save_error',
      error: error.message,
      postId: req.params.postId,
    }, `Save post error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unsave post
router.delete('/:postId/save', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session.userId;

    await query('DELETE FROM saved_posts WHERE user_id = $1 AND post_id = $2', [userId, postId]);

    res.json({ message: 'Post unsaved' });
  } catch (error) {
    logger.error({
      type: 'unsave_error',
      error: error.message,
      postId: req.params.postId,
    }, `Unsave post error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get post likes
router.get('/:postId/likes', async (req, res) => {
  try {
    const { postId } = req.params;
    const { cursor, limit = 20 } = req.query;

    let queryText = `
      SELECT u.id, u.username, u.display_name, u.profile_picture_url, l.created_at
      FROM likes l
      JOIN users u ON l.user_id = u.id
      WHERE l.post_id = $1
    `;
    const params = [postId];

    if (cursor) {
      queryText += ` AND l.created_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY l.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const likes = result.rows.slice(0, limit);

    res.json({
      likes: likes.map((l) => ({
        id: l.id,
        username: l.username,
        displayName: l.display_name,
        profilePictureUrl: l.profile_picture_url,
      })),
      nextCursor: hasMore ? likes[likes.length - 1].created_at : null,
    });
  } catch (error) {
    logger.error({
      type: 'get_likes_error',
      error: error.message,
      postId: req.params.postId,
    }, `Get likes error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available filters
router.get('/filters/list', (req, res) => {
  res.json({ filters: Object.keys(FILTERS) });
});

export default router;

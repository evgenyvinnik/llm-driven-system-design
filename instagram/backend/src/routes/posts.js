import { Router } from 'express';
import multer from 'multer';
import { query, getClient } from '../services/db.js';
import { processAndUploadImage, FILTERS } from '../services/storage.js';
import { timelineAdd, timelineRemove, cacheGet, cacheSet, cacheDel } from '../services/redis.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Create post
router.post('/', requireAuth, upload.array('media', 10), async (req, res) => {
  const client = await getClient();

  try {
    const { caption, location, filters } = req.body;
    const userId = req.session.userId;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one image is required' });
    }

    await client.query('BEGIN');

    // Create post
    const postResult = await client.query(
      `INSERT INTO posts (user_id, caption, location)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, caption || '', location || null]
    );
    const post = postResult.rows[0];

    // Parse filters (JSON array or default to 'none' for all)
    let filterArray = [];
    try {
      filterArray = filters ? JSON.parse(filters) : [];
    } catch {
      filterArray = [];
    }

    // Process and upload each media file
    const mediaItems = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filterName = filterArray[i] || 'none';

      const mediaResult = await processAndUploadImage(file.buffer, file.originalname, filterName);

      const mediaInsert = await client.query(
        `INSERT INTO post_media (post_id, media_type, media_url, thumbnail_url, filter_applied, width, height, order_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [post.id, 'image', mediaResult.mediaUrl, mediaResult.thumbnailUrl, filterName, mediaResult.width, mediaResult.height, i]
      );
      mediaItems.push(mediaInsert.rows[0]);
    }

    await client.query('COMMIT');

    // Fan out to followers' timelines
    const followers = await query(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [userId]
    );

    const timestamp = new Date(post.created_at).getTime();
    for (const follower of followers.rows) {
      await timelineAdd(follower.follower_id, post.id, timestamp);
    }
    // Add to own timeline too
    await timelineAdd(userId, post.id, timestamp);

    res.status(201).json({
      post: {
        id: post.id,
        userId: post.user_id,
        caption: post.caption,
        location: post.location,
        likeCount: post.like_count,
        commentCount: post.comment_count,
        createdAt: post.created_at,
        media: mediaItems.map((m) => ({
          id: m.id,
          mediaType: m.media_type,
          mediaUrl: m.media_url,
          thumbnailUrl: m.thumbnail_url,
          filterApplied: m.filter_applied,
          width: m.width,
          height: m.height,
          orderIndex: m.order_index,
        })),
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create post error:', error);
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
    console.error('Get post error:', error);
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
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Like post
router.post('/:postId/like', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session.userId;

    await query(
      'INSERT INTO likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, postId]
    );

    // Clear post cache to reflect new like count
    await cacheDel(`post:${postId}`);

    res.json({ message: 'Post liked' });
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlike post
router.delete('/:postId/like', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.session.userId;

    await query('DELETE FROM likes WHERE user_id = $1 AND post_id = $2', [userId, postId]);

    await cacheDel(`post:${postId}`);

    res.json({ message: 'Post unliked' });
  } catch (error) {
    console.error('Unlike post error:', error);
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
    console.error('Save post error:', error);
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
    console.error('Unsave post error:', error);
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
    console.error('Get likes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available filters
router.get('/filters/list', (req, res) => {
  res.json({ filters: Object.keys(FILTERS) });
});

export default router;

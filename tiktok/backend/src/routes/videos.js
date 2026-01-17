import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { uploadFile, getPublicUrl } from '../storage.js';
import { getRedis } from '../redis.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for video uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  },
});

// Helper to format video response
const formatVideo = (video, userId = null, likedVideoIds = []) => ({
  id: video.id,
  creatorId: video.creator_id,
  creatorUsername: video.creator_username,
  creatorDisplayName: video.creator_display_name,
  creatorAvatarUrl: video.creator_avatar_url,
  videoUrl: video.video_url,
  thumbnailUrl: video.thumbnail_url,
  duration: video.duration_seconds,
  description: video.description,
  hashtags: video.hashtags || [],
  viewCount: video.view_count,
  likeCount: video.like_count,
  commentCount: video.comment_count,
  shareCount: video.share_count,
  isLiked: likedVideoIds.includes(video.id),
  isOwnVideo: userId === video.creator_id,
  createdAt: video.created_at,
});

// Upload video
router.post('/', requireAuth, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Video file is required' });
    }

    const { description = '', hashtags = '' } = req.body;
    const hashtagArray = hashtags
      .split(',')
      .map(tag => tag.trim().toLowerCase())
      .filter(tag => tag.length > 0);

    // Generate unique filename
    const videoId = uuidv4();
    const extension = req.file.originalname.split('.').pop() || 'mp4';
    const videoKey = `${req.session.userId}/${videoId}.${extension}`;

    // Upload to MinIO
    const bucket = process.env.MINIO_BUCKET_VIDEOS || 'videos';
    const videoUrl = await uploadFile(
      bucket,
      videoKey,
      req.file.buffer,
      req.file.mimetype
    );

    // For simplicity, we'll use a placeholder thumbnail
    // In production, you'd generate this from the video
    const thumbnailUrl = null;

    // Insert video record
    const result = await query(
      `INSERT INTO videos (creator_id, video_url, thumbnail_url, description, hashtags, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id, creator_id, video_url, thumbnail_url, description, hashtags,
                 view_count, like_count, comment_count, share_count, status, created_at`,
      [req.session.userId, videoUrl, thumbnailUrl, description, hashtagArray]
    );

    // Update user video count
    await query(
      'UPDATE users SET video_count = video_count + 1 WHERE id = $1',
      [req.session.userId]
    );

    // Update user hashtag preferences
    if (hashtagArray.length > 0) {
      await updateUserHashtagPreferences(req.session.userId, hashtagArray, 1.0);
    }

    const video = result.rows[0];

    res.status(201).json({
      message: 'Video uploaded successfully',
      video: {
        id: video.id,
        creatorId: video.creator_id,
        videoUrl: video.video_url,
        thumbnailUrl: video.thumbnail_url,
        description: video.description,
        hashtags: video.hashtags,
        viewCount: video.view_count,
        likeCount: video.like_count,
        commentCount: video.comment_count,
        shareCount: video.share_count,
        status: video.status,
        createdAt: video.created_at,
      },
    });
  } catch (error) {
    console.error('Upload video error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single video
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
              u.avatar_url as creator_avatar_url
       FROM videos v
       JOIN users u ON v.creator_id = u.id
       WHERE v.id = $1 AND v.status = 'active'`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = result.rows[0];

    // Check if user liked this video
    let likedVideoIds = [];
    if (req.session?.userId) {
      const likeResult = await query(
        'SELECT video_id FROM likes WHERE user_id = $1 AND video_id = $2',
        [req.session.userId, id]
      );
      likedVideoIds = likeResult.rows.map(r => r.video_id);
    }

    res.json(formatVideo(video, req.session?.userId, likedVideoIds));
  } catch (error) {
    console.error('Get video error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's videos
router.get('/user/:username', optionalAuth, async (req, res) => {
  try {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const userResult = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await query(
      `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
              u.avatar_url as creator_avatar_url
       FROM videos v
       JOIN users u ON v.creator_id = u.id
       WHERE v.creator_id = $1 AND v.status = 'active'
       ORDER BY v.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userResult.rows[0].id, limit, offset]
    );

    // Get liked video IDs if user is logged in
    let likedVideoIds = [];
    if (req.session?.userId) {
      const videoIds = result.rows.map(v => v.id);
      if (videoIds.length > 0) {
        const likeResult = await query(
          'SELECT video_id FROM likes WHERE user_id = $1 AND video_id = ANY($2)',
          [req.session.userId, videoIds]
        );
        likedVideoIds = likeResult.rows.map(r => r.video_id);
      }
    }

    res.json({
      videos: result.rows.map(v => formatVideo(v, req.session?.userId, likedVideoIds)),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Get user videos error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete video
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership
    const videoResult = await query(
      'SELECT creator_id FROM videos WHERE id = $1',
      [id]
    );

    if (videoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (videoResult.rows[0].creator_id !== req.session.userId && req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to delete this video' });
    }

    // Soft delete
    await query("UPDATE videos SET status = 'deleted' WHERE id = $1", [id]);

    // Update user video count
    await query(
      'UPDATE users SET video_count = GREATEST(video_count - 1, 0) WHERE id = $1',
      [videoResult.rows[0].creator_id]
    );

    res.json({ message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Delete video error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Record view
router.post('/:id/view', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { watchDurationMs, completionRate } = req.body;

    // Increment view count in Redis (fast path)
    const redis = getRedis();
    await redis.incr(`video:${id}:views`);

    // Record watch history if user is logged in
    if (req.session?.userId) {
      await query(
        `INSERT INTO watch_history (user_id, video_id, watch_duration_ms, completion_rate)
         VALUES ($1, $2, $3, $4)`,
        [req.session.userId, id, watchDurationMs || 0, completionRate || 0]
      );

      // Get video hashtags for preference update
      const videoResult = await query('SELECT hashtags FROM videos WHERE id = $1', [id]);
      if (videoResult.rows.length > 0 && videoResult.rows[0].hashtags) {
        // Weight based on completion rate
        const weight = (completionRate || 0) * 0.5;
        if (weight > 0.1) {
          await updateUserHashtagPreferences(req.session.userId, videoResult.rows[0].hashtags, weight);
        }
      }
    }

    // Periodically flush to database (every 100 views)
    const views = await redis.get(`video:${id}:views`);
    if (parseInt(views) % 100 === 0) {
      await query(
        'UPDATE videos SET view_count = view_count + 100 WHERE id = $1',
        [id]
      );
      await redis.decrBy(`video:${id}:views`, 100);
    }

    res.json({ message: 'View recorded' });
  } catch (error) {
    console.error('Record view error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Like video
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if video exists
    const videoResult = await query(
      'SELECT id, hashtags, creator_id FROM videos WHERE id = $1 AND status = $2',
      [id, 'active']
    );
    if (videoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Check if already liked
    const existingLike = await query(
      'SELECT id FROM likes WHERE user_id = $1 AND video_id = $2',
      [req.session.userId, id]
    );

    if (existingLike.rows.length > 0) {
      return res.status(409).json({ error: 'Already liked' });
    }

    // Create like
    await query(
      'INSERT INTO likes (user_id, video_id) VALUES ($1, $2)',
      [req.session.userId, id]
    );

    // Update video like count
    await query(
      'UPDATE videos SET like_count = like_count + 1 WHERE id = $1',
      [id]
    );

    // Update creator's total like count
    await query(
      'UPDATE users SET like_count = like_count + 1 WHERE id = $1',
      [videoResult.rows[0].creator_id]
    );

    // Update user hashtag preferences (strong signal from like)
    if (videoResult.rows[0].hashtags) {
      await updateUserHashtagPreferences(req.session.userId, videoResult.rows[0].hashtags, 2.0);
    }

    res.json({ message: 'Liked successfully', isLiked: true });
  } catch (error) {
    console.error('Like video error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlike video
router.delete('/:id/like', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get video creator for updating their like count
    const videoResult = await query('SELECT creator_id FROM videos WHERE id = $1', [id]);
    if (videoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Delete like
    const deleteResult = await query(
      'DELETE FROM likes WHERE user_id = $1 AND video_id = $2 RETURNING id',
      [req.session.userId, id]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Not liked' });
    }

    // Update video like count
    await query(
      'UPDATE videos SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1',
      [id]
    );

    // Update creator's total like count
    await query(
      'UPDATE users SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1',
      [videoResult.rows[0].creator_id]
    );

    res.json({ message: 'Unliked successfully', isLiked: false });
  } catch (error) {
    console.error('Unlike video error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper to update user hashtag preferences
async function updateUserHashtagPreferences(userId, hashtags, weight) {
  try {
    // Get current preferences
    const result = await query(
      'SELECT hashtag_preferences FROM user_embeddings WHERE user_id = $1',
      [userId]
    );

    let preferences = {};
    if (result.rows.length > 0 && result.rows[0].hashtag_preferences) {
      preferences = result.rows[0].hashtag_preferences;
    }

    // Update preferences with decay
    for (const [tag, value] of Object.entries(preferences)) {
      preferences[tag] = value * 0.99; // Small decay
    }

    // Add new hashtag weights
    for (const tag of hashtags) {
      preferences[tag] = (preferences[tag] || 0) + weight;
    }

    // Keep only top 100 hashtags
    const sortedTags = Object.entries(preferences)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);
    preferences = Object.fromEntries(sortedTags);

    // Update or insert
    await query(
      `INSERT INTO user_embeddings (user_id, hashtag_preferences, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET hashtag_preferences = $2, updated_at = NOW()`,
      [userId, JSON.stringify(preferences)]
    );
  } catch (error) {
    console.error('Update hashtag preferences error:', error);
  }
}

export default router;

import { Router, Response, NextFunction, Request } from 'express';
import multer from 'multer';
import { query } from '../services/db.js';
import { processAndUploadImage } from '../services/storage.js';
import { storyTrayGet, storyTraySet, StoryTrayUser } from '../services/redis.js';
import { requireAuth, optionalAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { storyRateLimiter } from '../services/rateLimiter.js';
import { createCircuitBreaker, fallbackWithError } from '../services/circuitBreaker.js';
import logger from '../services/logger.js';
import { storiesCreatedTotal, storyViewsTotal, imageProcessingDuration } from '../services/metrics.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Database row types
interface StoryRow {
  id: string;
  user_id: string;
  media_url: string;
  media_type: string;
  thumbnail_url: string | null;
  filter_applied: string;
  view_count: number;
  created_at: Date;
  expires_at: Date;
  has_viewed?: boolean;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  profile_picture_url: string | null;
}

interface StoryTrayRow {
  id: string;
  username: string;
  display_name: string;
  profile_picture_url: string | null;
  latest_story_time: Date;
  story_count: string;
  has_seen: boolean;
}

interface ViewerRow {
  id: string;
  username: string;
  display_name: string;
  profile_picture_url: string | null;
  viewed_at: Date;
}

interface StoryResponse {
  id: string;
  mediaUrl: string;
  mediaType: string;
  thumbnailUrl: string | null;
  filterApplied: string;
  viewCount: number;
  hasViewed?: boolean;
  createdAt: Date;
  expiresAt: Date;
}

interface ImageProcessResult {
  mediaUrl: string;
  thumbnailUrl: string;
}

interface CircuitBreakerError extends Error {
  code?: string;
}

// Circuit breaker for story image processing
const storyImageBreaker = createCircuitBreaker(
  'story_image_processing',
  async (fileBuffer: Buffer, originalName: string, filterName: string): Promise<ImageProcessResult> => {
    const startTime = Date.now();
    const result = await processAndUploadImage(fileBuffer, originalName, filterName);
    imageProcessingDuration.labels('story').observe((Date.now() - startTime) / 1000);
    return result;
  },
  {
    timeout: 30000,
    errorThresholdPercentage: 50,
    resetTimeout: 60000,
    volumeThreshold: 3,
  }
);

storyImageBreaker.fallback(
  fallbackWithError('Story upload is temporarily unavailable. Please try again later.')
);

// Extend Request for multer file
interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

// Create story
router.post('/', requireAuth, storyRateLimiter, upload.single('media'), async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId;
    const { filter } = req.body as { filter?: string };

    if (!req.file) {
      res.status(400).json({ error: 'Media file is required' });
      return;
    }

    // Process and upload image using circuit breaker
    const mediaResult = await storyImageBreaker.fire(req.file.buffer, req.file.originalname, filter || 'none') as ImageProcessResult;

    // Create story with 24h expiration
    const result = await query<StoryRow>(
      `INSERT INTO stories (user_id, media_url, media_type, thumbnail_url, filter_applied)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, mediaResult.mediaUrl, 'image', mediaResult.thumbnailUrl, filter || 'none']
    );

    const story = result.rows[0];

    // Track metrics
    storiesCreatedTotal.inc();

    logger.info({
      type: 'story_created',
      storyId: story.id,
      userId,
    }, `Story created: ${story.id}`);

    res.status(201).json({
      story: {
        id: story.id,
        userId: story.user_id,
        mediaUrl: story.media_url,
        mediaType: story.media_type,
        thumbnailUrl: story.thumbnail_url,
        filterApplied: story.filter_applied,
        viewCount: story.view_count,
        createdAt: story.created_at,
        expiresAt: story.expires_at,
      },
    });
  } catch (error) {
    const err = error as CircuitBreakerError;
    if (err.code === 'SERVICE_UNAVAILABLE') {
      res.status(503).json({ error: err.message });
      return;
    }
    logger.error({
      type: 'story_create_error',
      error: err.message,
      userId: req.session.userId,
    }, `Create story error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get story tray (list of users with active stories)
router.get('/tray', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId!;

    // Try cache first
    const cached = await storyTrayGet(userId);
    if (cached) {
      res.json({ users: cached });
      return;
    }

    // Get users we follow who have active stories
    const result = await query<StoryTrayRow>(
      `SELECT DISTINCT u.id, u.username, u.display_name, u.profile_picture_url,
              MAX(s.created_at) as latest_story_time,
              (SELECT COUNT(*) FROM stories WHERE user_id = u.id AND expires_at > NOW()) as story_count,
              EXISTS(
                SELECT 1 FROM story_views sv
                JOIN stories st ON sv.story_id = st.id
                WHERE st.user_id = u.id AND sv.viewer_id = $1 AND st.expires_at > NOW()
              ) as has_seen
       FROM users u
       JOIN stories s ON u.id = s.user_id
       WHERE s.expires_at > NOW()
         AND (u.id = $1 OR u.id IN (SELECT following_id FROM follows WHERE follower_id = $1))
       GROUP BY u.id
       ORDER BY (CASE WHEN u.id = $1 THEN 0 ELSE 1 END), has_seen ASC, latest_story_time DESC`,
      [userId]
    );

    const users: StoryTrayUser[] = result.rows.map((u: StoryTrayRow) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      profilePictureUrl: u.profile_picture_url,
      storyCount: parseInt(u.story_count),
      hasSeen: u.has_seen,
      latestStoryTime: u.latest_story_time.toISOString(),
    }));

    // Cache for 5 minutes
    await storyTraySet(userId, users, 300);

    res.json({ users });
  } catch (error) {
    const err = error as Error;
    logger.error({
      type: 'story_tray_error',
      error: err.message,
      userId: req.session.userId,
    }, `Get story tray error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's stories
router.get('/user/:userId', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { userId: targetUserId } = req.params;
    const currentUserId = req.session.userId;

    // Get active stories for user
    const result = await query<StoryRow>(
      `SELECT s.*,
              EXISTS(SELECT 1 FROM story_views WHERE story_id = s.id AND viewer_id = $2) as has_viewed
       FROM stories s
       WHERE s.user_id = $1 AND s.expires_at > NOW()
       ORDER BY s.created_at ASC`,
      [targetUserId, currentUserId]
    );

    // Get user info
    const userResult = await query<UserRow>(
      'SELECT id, username, display_name, profile_picture_url FROM users WHERE id = $1',
      [targetUserId]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = userResult.rows[0];

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        profilePictureUrl: user.profile_picture_url,
      },
      stories: result.rows.map((s: StoryRow): StoryResponse => ({
        id: s.id,
        mediaUrl: s.media_url,
        mediaType: s.media_type,
        thumbnailUrl: s.thumbnail_url,
        filterApplied: s.filter_applied,
        viewCount: s.view_count,
        hasViewed: s.has_viewed,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error({
      type: 'get_user_stories_error',
      error: err.message,
      targetUserId: req.params.userId,
    }, `Get user stories error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// View story (track view) - idempotent operation
router.post('/:storyId/view', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { storyId } = req.params;
    const viewerId = req.session.userId!;

    // Check story exists and is active
    const storyCheck = await query<{ user_id: string }>(
      'SELECT user_id FROM stories WHERE id = $1 AND expires_at > NOW()',
      [storyId]
    );

    if (storyCheck.rows.length === 0) {
      res.status(404).json({ error: 'Story not found or expired' });
      return;
    }

    // Don't track views on own stories
    if (storyCheck.rows[0].user_id === viewerId) {
      res.json({ message: 'View not tracked for own story' });
      return;
    }

    // Insert view (ignore if already viewed) - idempotent
    const result = await query<{ id: string }>(
      'INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
      [storyId, viewerId]
    );

    if (result.rows.length > 0) {
      // New view - track metric
      storyViewsTotal.inc();

      logger.debug({
        type: 'story_viewed',
        storyId,
        viewerId,
      }, `Story viewed: ${storyId}`);
    }

    res.json({ message: 'Story viewed' });
  } catch (error) {
    const err = error as Error;
    logger.error({
      type: 'story_view_error',
      error: err.message,
      storyId: req.params.storyId,
    }, `View story error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get story viewers (only for story owner)
router.get('/:storyId/viewers', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const storyId = req.params.storyId as string;
    const userId = req.session.userId!;
    const cursorParam = req.query.cursor;
    const cursor = typeof cursorParam === 'string' ? cursorParam : undefined;
    const limitParam = req.query.limit;
    const parsedLimit = parseInt(typeof limitParam === 'string' ? limitParam : '20');

    // Check ownership
    const storyCheck = await query<{ user_id: string }>('SELECT user_id FROM stories WHERE id = $1', [storyId]);
    if (storyCheck.rows.length === 0) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    if (storyCheck.rows[0].user_id !== userId) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    let queryText = `
      SELECT u.id, u.username, u.display_name, u.profile_picture_url, sv.viewed_at
      FROM story_views sv
      JOIN users u ON sv.viewer_id = u.id
      WHERE sv.story_id = $1
    `;
    const params: (string | number)[] = [storyId];

    if (cursor) {
      queryText += ` AND sv.viewed_at < $${params.length + 1}`;
      params.push(cursor);
    }

    queryText += ` ORDER BY sv.viewed_at DESC LIMIT $${params.length + 1}`;
    params.push(parsedLimit + 1);

    const result = await query<ViewerRow>(queryText, params);

    const hasMore = result.rows.length > parsedLimit;
    const viewers = result.rows.slice(0, parsedLimit);

    res.json({
      viewers: viewers.map((v: ViewerRow) => ({
        id: v.id,
        username: v.username,
        displayName: v.display_name,
        profilePictureUrl: v.profile_picture_url,
        viewedAt: v.viewed_at,
      })),
      nextCursor: hasMore ? viewers[viewers.length - 1].viewed_at : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error({
      type: 'get_story_viewers_error',
      error: err.message,
      storyId: req.params.storyId,
    }, `Get story viewers error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete story
router.delete('/:storyId', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { storyId } = req.params;
    const userId = req.session.userId;

    // Check ownership
    const storyCheck = await query<{ user_id: string }>('SELECT user_id FROM stories WHERE id = $1', [storyId]);
    if (storyCheck.rows.length === 0) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    if (storyCheck.rows[0].user_id !== userId && req.session.role !== 'admin') {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    await query('DELETE FROM stories WHERE id = $1', [storyId]);

    logger.info({
      type: 'story_deleted',
      storyId,
      userId,
    }, `Story deleted: ${storyId}`);

    res.json({ message: 'Story deleted' });
  } catch (error) {
    const err = error as Error;
    logger.error({
      type: 'story_delete_error',
      error: err.message,
      storyId: req.params.storyId,
    }, `Delete story error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// My stories (for current user)
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.session.userId;

    const result = await query<StoryRow>(
      `SELECT * FROM stories WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at ASC`,
      [userId]
    );

    res.json({
      stories: result.rows.map((s: StoryRow): StoryResponse => ({
        id: s.id,
        mediaUrl: s.media_url,
        mediaType: s.media_type,
        thumbnailUrl: s.thumbnail_url,
        filterApplied: s.filter_applied,
        viewCount: s.view_count,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error({
      type: 'get_my_stories_error',
      error: err.message,
      userId: req.session.userId,
    }, `Get my stories error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

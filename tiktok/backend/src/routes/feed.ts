import express, { Request, Response, NextFunction, Router } from 'express';
import { query } from '../db.js';
import { getRedis } from '../redis.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { createLogger } from '../shared/logger.js';
import { getRateLimiters } from '../index.js';
import {
  fypLatencyHistogram,
  recommendationLatencyHistogram,
  timeAsync,
} from '../shared/metrics.js';
import { createCircuitBreaker, withCircuitBreaker } from '../shared/circuitBreaker.js';
import { getEmbeddingBasedRecommendations, generateUserEmbedding } from '../services/embeddings.js';

const router: Router = express.Router();
const logger = createLogger('feed');

// Video row type
interface VideoRow {
  id: number;
  creator_id: number;
  creator_username: string;
  creator_display_name: string;
  creator_avatar_url: string | null;
  video_url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  description: string | null;
  hashtags: string[] | null;
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
  status: string;
  created_at: string;
  source?: string;
  score?: number;
  similarity?: number;
}

// Helper to get rate limiters
const getLimiters = () => getRateLimiters();

// Exploration rate for new content discovery
const EXPLORE_RATE = 0.2; // 20% exploration

// Helper to format video response
const formatVideo = (
  video: VideoRow,
  userId: number | null = null,
  likedVideoIds: number[] = []
): Record<string, unknown> => ({
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

// Circuit breaker for recommendation service
const recommendationBreaker = createCircuitBreaker(
  'recommendation',
  async (...args: unknown[]): Promise<VideoRow[]> => {
    const [userId, limit, offset] = args as [number, number, number];
    return await getPersonalizedFeedInternal(userId, limit, offset);
  },
  {
    timeout: 5000, // 5 seconds max
    errorThresholdPercentage: 50,
    resetTimeout: 15000,
    volumeThreshold: 20,
  }
);

// For You Page - personalized feed
router.get('/fyp', optionalAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Apply rate limiting
  const limiters = getLimiters();
  if (limiters?.feed) {
    limiters.feed(req, res, async () => {
      await handleFYP(req, res, next);
    });
    return;
  }
  await handleFYP(req, res, next);
});

async function handleFYP(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const startTime = Date.now();

  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const offset = parseInt(req.query.offset as string) || 0;

    let videos: VideoRow[];
    const userId = req.session?.userId;
    const userType = userId ? 'authenticated' : 'anonymous';

    if (userId) {
      // Personalized feed with circuit breaker
      try {
        videos = await recommendationBreaker.fire(userId, limit, offset) as VideoRow[];
      } catch (error) {
        if ((error as Error).message === 'Breaker is open') {
          logger.warn({ userId }, 'Recommendation circuit open, falling back to trending');
          // Fallback to trending when recommendation service is down
          videos = await getTrendingFeed(limit, offset);
        } else {
          throw error;
        }
      }
    } else {
      // Trending feed for anonymous users
      videos = await getTrendingFeed(limit, offset);
    }

    // Get liked video IDs if user is logged in
    let likedVideoIds: number[] = [];
    if (userId) {
      const videoIds = videos.map((v) => v.id);
      if (videoIds.length > 0) {
        const likeResult = await query(
          'SELECT video_id FROM likes WHERE user_id = $1 AND video_id = ANY($2)',
          [userId, videoIds]
        );
        likedVideoIds = likeResult.rows.map((r: { video_id: number }) => r.video_id);
      }
    }

    // Record FYP latency metric
    const durationSeconds = (Date.now() - startTime) / 1000;
    fypLatencyHistogram.labels(userType).observe(durationSeconds);

    res.json({
      videos: videos.map((v) => formatVideo(v, userId, likedVideoIds)),
      hasMore: videos.length === limit,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, userId: req.session?.userId }, 'Get FYP error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Following feed - videos from followed users
router.get('/following', requireAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const limiters = getLimiters();
  if (limiters?.feed) {
    limiters.feed(req, res, async () => {
      await handleFollowing(req, res, next);
    });
    return;
  }
  await handleFollowing(req, res, next);
});

async function handleFollowing(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const offset = parseInt(req.query.offset as string) || 0;
    const userId = req.session.userId as number;

    const result = await query(
      `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
              u.avatar_url as creator_avatar_url
       FROM videos v
       JOIN users u ON v.creator_id = u.id
       JOIN follows f ON f.following_id = v.creator_id
       WHERE f.follower_id = $1 AND v.status = 'active'
       ORDER BY v.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    // Get liked video IDs
    const videoIds = result.rows.map((v: VideoRow) => v.id);
    let likedVideoIds: number[] = [];
    if (videoIds.length > 0) {
      const likeResult = await query(
        'SELECT video_id FROM likes WHERE user_id = $1 AND video_id = ANY($2)',
        [userId, videoIds]
      );
      likedVideoIds = likeResult.rows.map((r: { video_id: number }) => r.video_id);
    }

    res.json({
      videos: result.rows.map((v: VideoRow) => formatVideo(v, userId, likedVideoIds)),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, userId: req.session.userId }, 'Get following feed error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Trending feed
router.get('/trending', optionalAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const limiters = getLimiters();
  if (limiters?.feed) {
    limiters.feed(req, res, async () => {
      await handleTrending(req, res, next);
    });
    return;
  }
  await handleTrending(req, res, next);
});

async function handleTrending(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const offset = parseInt(req.query.offset as string) || 0;
    const userId = req.session?.userId;

    const videos = await getTrendingFeed(limit, offset);

    // Get liked video IDs if user is logged in
    let likedVideoIds: number[] = [];
    if (userId) {
      const videoIds = videos.map((v) => v.id);
      if (videoIds.length > 0) {
        const likeResult = await query(
          'SELECT video_id FROM likes WHERE user_id = $1 AND video_id = ANY($2)',
          [userId, videoIds]
        );
        likedVideoIds = likeResult.rows.map((r: { video_id: number }) => r.video_id);
      }
    }

    res.json({
      videos: videos.map((v) => formatVideo(v, userId, likedVideoIds)),
      hasMore: videos.length === limit,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Get trending error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Hashtag feed
router.get('/hashtag/:tag', optionalAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const tag = req.params.tag as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const offset = parseInt(req.query.offset as string) || 0;
    const userId = req.session?.userId;

    const result = await query(
      `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
              u.avatar_url as creator_avatar_url
       FROM videos v
       JOIN users u ON v.creator_id = u.id
       WHERE $1 = ANY(v.hashtags) AND v.status = 'active'
       ORDER BY v.like_count DESC, v.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tag.toLowerCase(), limit, offset]
    );

    // Get liked video IDs if user is logged in
    let likedVideoIds: number[] = [];
    if (userId) {
      const videoIds = result.rows.map((v: VideoRow) => v.id);
      if (videoIds.length > 0) {
        const likeResult = await query(
          'SELECT video_id FROM likes WHERE user_id = $1 AND video_id = ANY($2)',
          [userId, videoIds]
        );
        likedVideoIds = likeResult.rows.map((r: { video_id: number }) => r.video_id);
      }
    }

    res.json({
      hashtag: tag.toLowerCase(),
      videos: result.rows.map((v: VideoRow) => formatVideo(v, userId, likedVideoIds)),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, hashtag: req.params.tag }, 'Get hashtag feed error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search videos
router.get('/search', optionalAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const limiters = getLimiters();
  if (limiters?.search) {
    limiters.search(req, res, async () => {
      await handleSearch(req, res, next);
    });
    return;
  }
  await handleSearch(req, res, next);
});

async function handleSearch(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const { q } = req.query as { q?: string };
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const offset = parseInt(req.query.offset as string) || 0;
    const userId = req.session?.userId;

    if (!q || q.trim().length === 0) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const searchTerm = `%${q.trim().toLowerCase()}%`;

    const result = await query(
      `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
              u.avatar_url as creator_avatar_url
       FROM videos v
       JOIN users u ON v.creator_id = u.id
       WHERE v.status = 'active' AND (
         LOWER(v.description) LIKE $1
         OR LOWER(u.username) LIKE $1
         OR LOWER(u.display_name) LIKE $1
         OR EXISTS (SELECT 1 FROM unnest(v.hashtags) AS tag WHERE LOWER(tag) LIKE $1)
       )
       ORDER BY v.like_count DESC, v.created_at DESC
       LIMIT $2 OFFSET $3`,
      [searchTerm, limit, offset]
    );

    // Get liked video IDs if user is logged in
    let likedVideoIds: number[] = [];
    if (userId) {
      const videoIds = result.rows.map((v: VideoRow) => v.id);
      if (videoIds.length > 0) {
        const likeResult = await query(
          'SELECT video_id FROM likes WHERE user_id = $1 AND video_id = ANY($2)',
          [userId, videoIds]
        );
        likedVideoIds = likeResult.rows.map((r: { video_id: number }) => r.video_id);
      }
    }

    logger.debug({ query: q, resultCount: result.rows.length }, 'Search completed');

    res.json({
      query: q,
      videos: result.rows.map((v: VideoRow) => formatVideo(v, userId, likedVideoIds)),
      hasMore: result.rows.length === limit,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, query: req.query.q }, 'Search error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Internal personalized feed function (wrapped by circuit breaker)
async function getPersonalizedFeedInternal(
  userId: number,
  limit: number,
  offset: number
): Promise<VideoRow[]> {
  // Phase 1: Candidate Generation with metrics
  const candidates = await timeAsync(
    recommendationLatencyHistogram,
    { phase: 'candidate_generation' },
    () => generateCandidates(userId, limit * 5 + offset)
  );

  // Phase 2: Ranking with metrics
  const ranked = await timeAsync(
    recommendationLatencyHistogram,
    { phase: 'ranking' },
    () => rankVideos(userId, candidates)
  );

  // Apply offset and limit
  return ranked.slice(offset, offset + limit);
}

// Generate candidate videos from multiple sources
async function generateCandidates(userId: number, count: number): Promise<VideoRow[]> {
  const candidateMap = new Map<number, VideoRow>();

  // Source 1: Videos from followed creators (30%)
  const followedCount = Math.floor(count * 0.3);
  const followedResult = await query(
    `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
            u.avatar_url as creator_avatar_url
     FROM videos v
     JOIN users u ON v.creator_id = u.id
     JOIN follows f ON f.following_id = v.creator_id
     WHERE f.follower_id = $1 AND v.status = 'active'
     ORDER BY v.created_at DESC
     LIMIT $2`,
    [userId, followedCount]
  );
  for (const video of followedResult.rows as VideoRow[]) {
    candidateMap.set(video.id, { ...video, source: 'followed' });
  }

  // Source 2: Videos with hashtags user has engaged with (20%)
  const hashtagCount = Math.floor(count * 0.2);
  const prefResult = await query(
    'SELECT hashtag_preferences FROM user_embeddings WHERE user_id = $1',
    [userId]
  );

  interface HashtagPrefs {
    hashtag_preferences: Record<string, number> | null;
  }

  if (
    prefResult.rows.length > 0 &&
    (prefResult.rows[0] as HashtagPrefs).hashtag_preferences
  ) {
    const prefs = (prefResult.rows[0] as HashtagPrefs).hashtag_preferences!;
    const topHashtags = Object.entries(prefs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);

    if (topHashtags.length > 0) {
      const hashtagResult = await query(
        `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
                u.avatar_url as creator_avatar_url
         FROM videos v
         JOIN users u ON v.creator_id = u.id
         WHERE v.status = 'active' AND v.hashtags && $1
         AND v.id NOT IN (SELECT video_id FROM watch_history WHERE user_id = $2)
         ORDER BY v.like_count DESC
         LIMIT $3`,
        [topHashtags, userId, hashtagCount]
      );
      for (const video of hashtagResult.rows as VideoRow[]) {
        if (!candidateMap.has(video.id)) {
          candidateMap.set(video.id, { ...video, source: 'hashtag' });
        }
      }
    }
  }

  // Source 3: Embedding-based similar videos (20%)
  const embeddingCount = Math.floor(count * 0.2);
  try {
    const embeddingVideos = await getEmbeddingBasedRecommendations(userId, embeddingCount);
    for (const video of embeddingVideos as VideoRow[]) {
      if (!candidateMap.has(video.id)) {
        candidateMap.set(video.id, { ...video, source: 'embedding' });
      }
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message, userId }, 'Embedding recommendations failed, skipping');
  }

  // Source 4: Trending videos for exploration (30%)
  const trendingCount = Math.floor(count * 0.3);
  const trendingResult = await query(
    `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
            u.avatar_url as creator_avatar_url
     FROM videos v
     JOIN users u ON v.creator_id = u.id
     WHERE v.status = 'active'
     AND v.id NOT IN (SELECT video_id FROM watch_history WHERE user_id = $1)
     ORDER BY (v.like_count * 2 + v.view_count * 0.1 + v.comment_count * 3) DESC
     LIMIT $2`,
    [userId, trendingCount]
  );
  for (const video of trendingResult.rows as VideoRow[]) {
    if (!candidateMap.has(video.id)) {
      candidateMap.set(video.id, { ...video, source: 'trending' });
    }
  }

  return Array.from(candidateMap.values());
}

// Rank videos based on predicted engagement
async function rankVideos(userId: number, candidates: VideoRow[]): Promise<VideoRow[]> {
  // Get user preferences
  const prefResult = await query(
    'SELECT hashtag_preferences FROM user_embeddings WHERE user_id = $1',
    [userId]
  );

  interface HashtagPrefs {
    hashtag_preferences: Record<string, number> | null;
  }

  const userPrefs =
    (prefResult.rows[0] as HashtagPrefs)?.hashtag_preferences || {};

  // Score each video
  const scored = candidates.map((video) => {
    let score = 0;

    // Base score from engagement metrics (normalized)
    const engagementScore =
      (video.like_count * 2 + video.view_count * 0.01 + video.comment_count * 3) / 1000;
    score += Math.min(engagementScore, 10); // Cap at 10

    // Hashtag preference match
    if (video.hashtags) {
      for (const tag of video.hashtags) {
        if (userPrefs[tag]) {
          score += userPrefs[tag] * 0.5;
        }
      }
    }

    // Source boost
    if (video.source === 'followed') {
      score += 5; // Strong boost for followed creators
    } else if (video.source === 'embedding') {
      score += 4; // Boost for embedding similarity match
      // Add extra boost based on similarity score if available
      if (video.similarity) {
        score += video.similarity * 3;
      }
    } else if (video.source === 'hashtag') {
      score += 2;
    }

    // Freshness boost (videos from last 24h get a boost)
    const ageHours = (Date.now() - new Date(video.created_at).getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) {
      score += ((24 - ageHours) / 24) * 3;
    }

    // Exploration: Add randomness
    if (Math.random() < EXPLORE_RATE) {
      score += Math.random() * 5;
    }

    return { ...video, score };
  });

  // Sort by score
  scored.sort((a, b) => (b.score || 0) - (a.score || 0));

  return scored;
}

// Get trending feed for anonymous users
async function getTrendingFeed(limit: number, offset: number): Promise<VideoRow[]> {
  const result = await query(
    `SELECT v.*, u.username as creator_username, u.display_name as creator_display_name,
            u.avatar_url as creator_avatar_url
     FROM videos v
     JOIN users u ON v.creator_id = u.id
     WHERE v.status = 'active'
     ORDER BY (v.like_count * 2 + v.view_count * 0.1 + v.comment_count * 3) DESC,
              v.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows as VideoRow[];
}

export default router;

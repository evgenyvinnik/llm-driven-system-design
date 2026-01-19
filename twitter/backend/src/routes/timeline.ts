import express, { Request, Response, NextFunction, Router } from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { getFollowedCelebrities } from '../services/fanout.js';
import { timelineLatency, timelineRequestsTotal } from '../shared/metrics.js';

const router: Router = express.Router();

interface TweetRow {
  id: number;
  content: string;
  media_urls: string[];
  hashtags: string[];
  like_count: number;
  retweet_count: number;
  reply_count: number;
  created_at: Date;
  author_id: number;
  username: string;
  display_name: string;
  avatar_url: string;
  retweet_of: number | null;
}

// GET /api/timeline/home
router.get('/home', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  try {
    if (!req.session || !req.session.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userId = req.session.userId;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    // Get cached timeline from Redis
    const timelineKey = `timeline:${userId}`;
    const cachedIds = await redis.lrange(timelineKey, offset, offset + limit - 1);
    let cacheHit = cachedIds.length > 0;

    let tweets: TweetRow[] = [];

    if (cachedIds.length > 0) {
      // Get tweets from cache
      const result = await pool.query(
        `SELECT t.*, u.username, u.display_name, u.avatar_url
         FROM tweets t
         JOIN users u ON t.author_id = u.id
         WHERE t.id = ANY($1) AND t.is_deleted = false
         ORDER BY t.created_at DESC`,
        [cachedIds.map(id => parseInt(id))],
      );
      tweets = result.rows;
    }

    // Get celebrity tweets (pull strategy)
    const celebrities = await getFollowedCelebrities(userId);
    if (celebrities.length > 0) {
      const celebrityResult = await pool.query(
        `SELECT t.*, u.username, u.display_name, u.avatar_url
         FROM tweets t
         JOIN users u ON t.author_id = u.id
         WHERE t.author_id = ANY($1) AND t.is_deleted = false
         ORDER BY t.created_at DESC
         LIMIT 50`,
        [celebrities],
      );
      tweets = [...tweets, ...celebrityResult.rows];
    }

    // Sort and deduplicate
    const seen = new Set<number>();
    tweets = tweets
      .filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);

    // Get like/retweet status
    const likeStatus: Record<number, boolean> = {};
    const retweetStatus: Record<number, boolean> = {};
    const tweetIds = tweets.map(t => t.id);

    if (tweetIds.length > 0) {
      const likeCheck = await pool.query(
        'SELECT tweet_id FROM likes WHERE user_id = $1 AND tweet_id = ANY($2)',
        [userId, tweetIds],
      );
      likeCheck.rows.forEach((row: { tweet_id: number }) => {
        likeStatus[row.tweet_id] = true;
      });

      const retweetCheck = await pool.query(
        'SELECT tweet_id FROM retweets WHERE user_id = $1 AND tweet_id = ANY($2)',
        [userId, tweetIds],
      );
      retweetCheck.rows.forEach((row: { tweet_id: number }) => {
        retweetStatus[row.tweet_id] = true;
      });
    }

    const duration = (Date.now() - startTime) / 1000;
    timelineLatency.observe({ timeline_type: 'home', cache_hit: cacheHit ? 'true' : 'false' }, duration);
    timelineRequestsTotal.inc({ timeline_type: 'home', status: 'success' });

    res.json({
      tweets: tweets.map((tweet) => ({
        id: tweet.id.toString(),
        content: tweet.content,
        mediaUrls: tweet.media_urls,
        hashtags: tweet.hashtags,
        likeCount: tweet.like_count,
        retweetCount: tweet.retweet_count,
        replyCount: tweet.reply_count,
        createdAt: tweet.created_at,
        author: {
          id: tweet.author_id,
          username: tweet.username,
          displayName: tweet.display_name,
          avatarUrl: tweet.avatar_url,
        },
        isLiked: likeStatus[tweet.id] || false,
        isRetweeted: retweetStatus[tweet.id] || false,
      })),
    });
  } catch (error) {
    timelineRequestsTotal.inc({ timeline_type: 'home', status: 'error' });
    next(error);
  }
});

// GET /api/timeline/user/:username
router.get('/user/:username', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()],
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const userId = userResult.rows[0].id;

    const result = await pool.query(
      `SELECT t.*, u.username, u.display_name, u.avatar_url
       FROM tweets t
       JOIN users u ON t.author_id = u.id
       WHERE t.author_id = $1 AND t.is_deleted = false
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    const likeStatus: Record<number, boolean> = {};
    const retweetStatus: Record<number, boolean> = {};
    if (req.session && req.session.userId) {
      const tweetIds = result.rows.map((t: TweetRow) => t.id);
      if (tweetIds.length > 0) {
        const likeCheck = await pool.query(
          'SELECT tweet_id FROM likes WHERE user_id = $1 AND tweet_id = ANY($2)',
          [req.session.userId, tweetIds],
        );
        likeCheck.rows.forEach((row: { tweet_id: number }) => {
          likeStatus[row.tweet_id] = true;
        });

        const retweetCheck = await pool.query(
          'SELECT tweet_id FROM retweets WHERE user_id = $1 AND tweet_id = ANY($2)',
          [req.session.userId, tweetIds],
        );
        retweetCheck.rows.forEach((row: { tweet_id: number }) => {
          retweetStatus[row.tweet_id] = true;
        });
      }
    }

    res.json({
      tweets: result.rows.map((tweet: TweetRow) => ({
        id: tweet.id.toString(),
        content: tweet.content,
        mediaUrls: tweet.media_urls,
        hashtags: tweet.hashtags,
        likeCount: tweet.like_count,
        retweetCount: tweet.retweet_count,
        replyCount: tweet.reply_count,
        createdAt: tweet.created_at,
        author: {
          id: tweet.author_id,
          username: tweet.username,
          displayName: tweet.display_name,
          avatarUrl: tweet.avatar_url,
        },
        isLiked: likeStatus[tweet.id] || false,
        isRetweeted: retweetStatus[tweet.id] || false,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/timeline/explore
router.get('/explore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await pool.query(
      `SELECT t.*, u.username, u.display_name, u.avatar_url
       FROM tweets t
       JOIN users u ON t.author_id = u.id
       WHERE t.is_deleted = false
       ORDER BY t.like_count + t.retweet_count DESC, t.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    res.json({
      tweets: result.rows.map((tweet: TweetRow) => ({
        id: tweet.id.toString(),
        content: tweet.content,
        mediaUrls: tweet.media_urls,
        hashtags: tweet.hashtags,
        likeCount: tweet.like_count,
        retweetCount: tweet.retweet_count,
        replyCount: tweet.reply_count,
        createdAt: tweet.created_at,
        author: {
          id: tweet.author_id,
          username: tweet.username,
          displayName: tweet.display_name,
          avatarUrl: tweet.avatar_url,
        },
        isLiked: false,
        isRetweeted: false,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/timeline/hashtag/:tag
router.get('/hashtag/:tag', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tag } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await pool.query(
      `SELECT t.*, u.username, u.display_name, u.avatar_url
       FROM tweets t
       JOIN users u ON t.author_id = u.id
       WHERE $1 = ANY(t.hashtags) AND t.is_deleted = false
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tag.toLowerCase(), limit, offset],
    );

    res.json({
      tweets: result.rows.map((tweet: TweetRow) => ({
        id: tweet.id.toString(),
        content: tweet.content,
        mediaUrls: tweet.media_urls,
        hashtags: tweet.hashtags,
        likeCount: tweet.like_count,
        retweetCount: tweet.retweet_count,
        replyCount: tweet.reply_count,
        createdAt: tweet.created_at,
        author: {
          id: tweet.author_id,
          username: tweet.username,
          displayName: tweet.display_name,
          avatarUrl: tweet.avatar_url,
        },
        isLiked: false,
        isRetweeted: false,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;

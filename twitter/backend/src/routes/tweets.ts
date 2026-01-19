import express, { Request, Response, NextFunction, Router } from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { requireAuth } from '../middleware/auth.js';
import { fanoutTweet } from '../services/fanout.js';
import logger from '../shared/logger.js';
import { tweetIdempotencyMiddleware } from '../shared/idempotency.js';
import { publishTweet, publishLike } from '../shared/kafka.js';
import {
  tweetCounter,
  tweetCreationDuration,
} from '../shared/metrics.js';

const router: Router = express.Router();

const tweetIdempotency = tweetIdempotencyMiddleware(redis);

function extractHashtagsAndMentions(content: string): { hashtags: string[]; mentionUsernames: string[] } {
  const hashtags = content.match(/#\w+/g)?.map((h) => h.toLowerCase().slice(1)) || [];
  const mentionUsernames = content.match(/@\w+/g)?.map((m) => m.toLowerCase().slice(1)) || [];
  return { hashtags, mentionUsernames };
}

// POST /api/tweets
router.post('/', requireAuth, tweetIdempotency, async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  const tweetLog = logger.child({
    requestId: req.requestId,
    userId: req.session.userId,
    idempotencyKey: req.idempotencyKey,
  });

  try {
    const { content, mediaUrls, replyTo, quoteOf } = req.body;
    const authorId = req.session.userId!;

    if (!content || content.trim().length === 0) {
      tweetCounter.inc({ status: 'validation_error' });
      res.status(400).json({ error: 'Tweet content is required' });
      return;
    }

    if (content.length > 280) {
      tweetCounter.inc({ status: 'validation_error' });
      res.status(400).json({ error: 'Tweet content must be 280 characters or less' });
      return;
    }

    const { hashtags, mentionUsernames } = extractHashtagsAndMentions(content);

    let mentions: number[] = [];
    if (mentionUsernames.length > 0) {
      const mentionResult = await pool.query(
        'SELECT id FROM users WHERE username = ANY($1)',
        [mentionUsernames],
      );
      mentions = mentionResult.rows.map((r: { id: number }) => r.id);
    }

    if (replyTo) {
      const replyCheck = await pool.query('SELECT id FROM tweets WHERE id = $1', [replyTo]);
      if (replyCheck.rows.length === 0) {
        tweetCounter.inc({ status: 'validation_error' });
        res.status(400).json({ error: 'Reply-to tweet not found' });
        return;
      }
    }

    if (quoteOf) {
      const quoteCheck = await pool.query('SELECT id FROM tweets WHERE id = $1', [quoteOf]);
      if (quoteCheck.rows.length === 0) {
        tweetCounter.inc({ status: 'validation_error' });
        res.status(400).json({ error: 'Quote tweet not found' });
        return;
      }
    }

    const result = await pool.query(
      `INSERT INTO tweets (author_id, content, media_urls, hashtags, mentions, reply_to, quote_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [authorId, content.trim(), mediaUrls || [], hashtags, mentions, replyTo || null, quoteOf || null],
    );

    const tweet = result.rows[0];

    tweetLog.info({ tweetId: tweet.id }, 'Tweet created');

    for (const hashtag of hashtags) {
      await pool.query(
        'INSERT INTO hashtag_activity (hashtag, tweet_id) VALUES ($1, $2)',
        [hashtag, tweet.id],
      );
      const bucket = Math.floor(Date.now() / 1000 / 60);
      await redis.incr(`trend:${hashtag}:${bucket}`);
      await redis.expire(`trend:${hashtag}:${bucket}`, 3600);
    }

    publishTweet(tweet).catch((err: Error) => {
      tweetLog.error({ error: err.message, tweetId: tweet.id }, 'Kafka publish error');
    });

    fanoutTweet(tweet.id, authorId).catch((err: Error) => {
      tweetLog.error({ error: err.message, tweetId: tweet.id }, 'Fanout error');
    });

    const authorResult = await pool.query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [authorId],
    );
    const author = authorResult.rows[0];

    const duration = (Date.now() - startTime) / 1000;
    tweetCounter.inc({ status: 'success' });
    tweetCreationDuration.observe({ status: 'success' }, duration);

    res.status(201).json({
      tweet: {
        id: tweet.id.toString(),
        content: tweet.content,
        mediaUrls: tweet.media_urls,
        hashtags: tweet.hashtags,
        mentions: tweet.mentions,
        replyTo: tweet.reply_to?.toString() || null,
        quoteOf: tweet.quote_of?.toString() || null,
        likeCount: tweet.like_count,
        retweetCount: tweet.retweet_count,
        replyCount: tweet.reply_count,
        createdAt: tweet.created_at,
        author: {
          id: authorId,
          username: author.username,
          displayName: author.display_name,
          avatarUrl: author.avatar_url,
        },
        isLiked: false,
        isRetweeted: false,
      },
    });
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    tweetCounter.inc({ status: 'error' });
    tweetCreationDuration.observe({ status: 'error' }, duration);
    tweetLog.error({ error: (error as Error).message }, 'Tweet creation failed');
    next(error);
  }
});

// GET /api/tweets/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tweetId = req.params.id;

    const result = await pool.query(
      `SELECT t.*, u.username, u.display_name, u.avatar_url
       FROM tweets t
       JOIN users u ON t.author_id = u.id
       WHERE t.id = $1 AND t.is_deleted = false`,
      [tweetId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Tweet not found' });
      return;
    }

    const tweet = result.rows[0];

    let isLiked = false;
    let isRetweeted = false;
    if (req.session && req.session.userId) {
      const likeCheck = await pool.query(
        'SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2',
        [req.session.userId, tweetId],
      );
      isLiked = likeCheck.rows.length > 0;

      const retweetCheck = await pool.query(
        'SELECT 1 FROM retweets WHERE user_id = $1 AND tweet_id = $2',
        [req.session.userId, tweetId],
      );
      isRetweeted = retweetCheck.rows.length > 0;
    }

    res.json({
      tweet: {
        id: tweet.id.toString(),
        content: tweet.content,
        mediaUrls: tweet.media_urls,
        hashtags: tweet.hashtags,
        mentions: tweet.mentions,
        replyTo: tweet.reply_to?.toString() || null,
        quoteOf: tweet.quote_of?.toString() || null,
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
        isLiked,
        isRetweeted,
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/tweets/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId!;

    const tweetCheck = await pool.query(
      'SELECT author_id FROM tweets WHERE id = $1',
      [tweetId],
    );

    if (tweetCheck.rows.length === 0) {
      res.status(404).json({ error: 'Tweet not found' });
      return;
    }

    if (tweetCheck.rows[0].author_id !== userId && req.session.role !== 'admin') {
      res.status(403).json({ error: 'Not authorized to delete this tweet' });
      return;
    }

    await pool.query(
      'UPDATE tweets SET is_deleted = true, deleted_at = NOW() WHERE id = $1',
      [tweetId],
    );

    res.json({ message: 'Tweet deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// POST /api/tweets/:id/like
router.post('/:id/like', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId!;

    const tweetCheck = await pool.query('SELECT id FROM tweets WHERE id = $1', [tweetId]);
    if (tweetCheck.rows.length === 0) {
      res.status(404).json({ error: 'Tweet not found' });
      return;
    }

    const likeCheck = await pool.query(
      'SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2',
      [userId, tweetId],
    );

    if (likeCheck.rows.length > 0) {
      res.status(409).json({ error: 'Already liked this tweet' });
      return;
    }

    await pool.query(
      'INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)',
      [userId, tweetId],
    );

    publishLike({ userId, tweetId }).catch((err: Error) => {
      logger.error({ error: err.message, tweetId, userId }, 'Kafka like publish error');
    });

    const countResult = await pool.query(
      'SELECT like_count FROM tweets WHERE id = $1',
      [tweetId],
    );

    res.status(201).json({
      message: 'Tweet liked',
      likeCount: countResult.rows[0].like_count,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/tweets/:id/like
router.delete('/:id/like', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId!;

    const result = await pool.query(
      'DELETE FROM likes WHERE user_id = $1 AND tweet_id = $2 RETURNING *',
      [userId, tweetId],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Like not found' });
      return;
    }

    const countResult = await pool.query(
      'SELECT like_count FROM tweets WHERE id = $1',
      [tweetId],
    );

    res.json({
      message: 'Tweet unliked',
      likeCount: countResult.rows[0].like_count,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/tweets/:id/retweet
router.post('/:id/retweet', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId!;

    const tweetCheck = await pool.query('SELECT id, author_id FROM tweets WHERE id = $1', [tweetId]);
    if (tweetCheck.rows.length === 0) {
      res.status(404).json({ error: 'Tweet not found' });
      return;
    }

    const retweetCheck = await pool.query(
      'SELECT 1 FROM retweets WHERE user_id = $1 AND tweet_id = $2',
      [userId, tweetId],
    );

    if (retweetCheck.rows.length > 0) {
      res.status(409).json({ error: 'Already retweeted this tweet' });
      return;
    }

    await pool.query(
      'INSERT INTO retweets (user_id, tweet_id) VALUES ($1, $2)',
      [userId, tweetId],
    );

    const retweetResult = await pool.query(
      `INSERT INTO tweets (author_id, content, retweet_of)
       VALUES ($1, '', $2)
       RETURNING *`,
      [userId, tweetId],
    );

    const retweet = retweetResult.rows[0];

    publishTweet(retweet).catch((err: Error) => {
      logger.error({ error: err.message }, 'Kafka retweet publish error');
    });

    fanoutTweet(retweet.id, userId).catch((err: Error) => {
      logger.error({ error: err.message }, 'Retweet fanout error');
    });

    const countResult = await pool.query(
      'SELECT retweet_count FROM tweets WHERE id = $1',
      [tweetId],
    );

    res.status(201).json({
      message: 'Tweet retweeted',
      retweetCount: countResult.rows[0].retweet_count,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/tweets/:id/retweet
router.delete('/:id/retweet', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId!;

    const result = await pool.query(
      'DELETE FROM retweets WHERE user_id = $1 AND tweet_id = $2 RETURNING *',
      [userId, tweetId],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Retweet not found' });
      return;
    }

    await pool.query(
      'DELETE FROM tweets WHERE author_id = $1 AND retweet_of = $2',
      [userId, tweetId],
    );

    const countResult = await pool.query(
      'SELECT retweet_count FROM tweets WHERE id = $1',
      [tweetId],
    );

    res.json({
      message: 'Retweet removed',
      retweetCount: countResult.rows[0].retweet_count,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/tweets/:id/replies
router.get('/:id/replies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tweetId = req.params.id;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await pool.query(
      `SELECT t.*, u.username, u.display_name, u.avatar_url
       FROM tweets t
       JOIN users u ON t.author_id = u.id
       WHERE t.reply_to = $1 AND t.is_deleted = false
       ORDER BY t.created_at ASC
       LIMIT $2 OFFSET $3`,
      [tweetId, limit, offset],
    );

    const likeStatus: Record<number, boolean> = {};
    const retweetStatus: Record<number, boolean> = {};
    if (req.session && req.session.userId) {
      const tweetIds = result.rows.map((t: { id: number }) => t.id);
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
      tweets: result.rows.map((tweet: {
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
      }) => ({
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

export default router;

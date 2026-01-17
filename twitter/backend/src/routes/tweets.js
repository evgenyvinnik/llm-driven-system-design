import express from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { requireAuth } from '../middleware/auth.js';
import { fanoutTweet } from '../services/fanout.js';

const router = express.Router();

// Helper to extract hashtags and mentions from content
function extractHashtagsAndMentions(content) {
  const hashtags = content.match(/#\w+/g)?.map(h => h.toLowerCase().slice(1)) || [];
  const mentionUsernames = content.match(/@\w+/g)?.map(m => m.toLowerCase().slice(1)) || [];
  return { hashtags, mentionUsernames };
}

// POST /api/tweets - Create a new tweet
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { content, mediaUrls, replyTo, quoteOf } = req.body;
    const authorId = req.session.userId;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Tweet content is required' });
    }

    if (content.length > 280) {
      return res.status(400).json({ error: 'Tweet content must be 280 characters or less' });
    }

    const { hashtags, mentionUsernames } = extractHashtagsAndMentions(content);

    // Resolve mentions to user IDs
    let mentions = [];
    if (mentionUsernames.length > 0) {
      const mentionResult = await pool.query(
        'SELECT id FROM users WHERE username = ANY($1)',
        [mentionUsernames]
      );
      mentions = mentionResult.rows.map(r => r.id);
    }

    // Validate replyTo tweet exists
    if (replyTo) {
      const replyCheck = await pool.query('SELECT id FROM tweets WHERE id = $1', [replyTo]);
      if (replyCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Reply-to tweet not found' });
      }
    }

    // Validate quoteOf tweet exists
    if (quoteOf) {
      const quoteCheck = await pool.query('SELECT id FROM tweets WHERE id = $1', [quoteOf]);
      if (quoteCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Quote tweet not found' });
      }
    }

    // Create the tweet
    const result = await pool.query(
      `INSERT INTO tweets (author_id, content, media_urls, hashtags, mentions, reply_to, quote_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [authorId, content.trim(), mediaUrls || [], hashtags, mentions, replyTo || null, quoteOf || null]
    );

    const tweet = result.rows[0];

    // Record hashtag activity for trending
    for (const hashtag of hashtags) {
      await pool.query(
        'INSERT INTO hashtag_activity (hashtag, tweet_id) VALUES ($1, $2)',
        [hashtag, tweet.id]
      );
      // Increment Redis trend counter (sliding window)
      const bucket = Math.floor(Date.now() / 1000 / 60); // 1-minute bucket
      await redis.incr(`trend:${hashtag}:${bucket}`);
      await redis.expire(`trend:${hashtag}:${bucket}`, 3600); // 1 hour expiry
    }

    // Fanout tweet to followers' timelines
    await fanoutTweet(tweet.id, authorId);

    // Get author info for response
    const authorResult = await pool.query(
      'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
      [authorId]
    );
    const author = authorResult.rows[0];

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
    next(error);
  }
});

// GET /api/tweets/:id - Get a single tweet
router.get('/:id', async (req, res, next) => {
  try {
    const tweetId = req.params.id;

    const result = await pool.query(
      `SELECT t.*,
              u.username, u.display_name, u.avatar_url
       FROM tweets t
       JOIN users u ON t.author_id = u.id
       WHERE t.id = $1 AND t.is_deleted = false`,
      [tweetId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tweet not found' });
    }

    const tweet = result.rows[0];

    // Check if current user has liked/retweeted
    let isLiked = false;
    let isRetweeted = false;
    if (req.session && req.session.userId) {
      const likeCheck = await pool.query(
        'SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2',
        [req.session.userId, tweetId]
      );
      isLiked = likeCheck.rows.length > 0;

      const retweetCheck = await pool.query(
        'SELECT 1 FROM retweets WHERE user_id = $1 AND tweet_id = $2',
        [req.session.userId, tweetId]
      );
      isRetweeted = retweetCheck.rows.length > 0;
    }

    // If this is a retweet, get the original tweet
    let originalTweet = null;
    if (tweet.retweet_of) {
      const originalResult = await pool.query(
        `SELECT t.*, u.username, u.display_name, u.avatar_url
         FROM tweets t
         JOIN users u ON t.author_id = u.id
         WHERE t.id = $1`,
        [tweet.retweet_of]
      );
      if (originalResult.rows.length > 0) {
        const orig = originalResult.rows[0];
        originalTweet = {
          id: orig.id.toString(),
          content: orig.content,
          mediaUrls: orig.media_urls,
          author: {
            id: orig.author_id,
            username: orig.username,
            displayName: orig.display_name,
            avatarUrl: orig.avatar_url,
          },
        };
      }
    }

    // If this is a quote tweet, get the quoted tweet
    let quotedTweet = null;
    if (tweet.quote_of) {
      const quotedResult = await pool.query(
        `SELECT t.*, u.username, u.display_name, u.avatar_url
         FROM tweets t
         JOIN users u ON t.author_id = u.id
         WHERE t.id = $1`,
        [tweet.quote_of]
      );
      if (quotedResult.rows.length > 0) {
        const quoted = quotedResult.rows[0];
        quotedTweet = {
          id: quoted.id.toString(),
          content: quoted.content,
          mediaUrls: quoted.media_urls,
          author: {
            id: quoted.author_id,
            username: quoted.username,
            displayName: quoted.display_name,
            avatarUrl: quoted.avatar_url,
          },
        };
      }
    }

    res.json({
      tweet: {
        id: tweet.id.toString(),
        content: tweet.content,
        mediaUrls: tweet.media_urls,
        hashtags: tweet.hashtags,
        mentions: tweet.mentions,
        replyTo: tweet.reply_to?.toString() || null,
        retweetOf: tweet.retweet_of?.toString() || null,
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
        originalTweet,
        quotedTweet,
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/tweets/:id - Delete a tweet
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId;

    // Check if tweet exists and belongs to user
    const tweetCheck = await pool.query(
      'SELECT author_id FROM tweets WHERE id = $1',
      [tweetId]
    );

    if (tweetCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tweet not found' });
    }

    if (tweetCheck.rows[0].author_id !== userId && req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to delete this tweet' });
    }

    // Soft delete the tweet
    await pool.query(
      'UPDATE tweets SET is_deleted = true WHERE id = $1',
      [tweetId]
    );

    res.json({ message: 'Tweet deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// POST /api/tweets/:id/like - Like a tweet
router.post('/:id/like', requireAuth, async (req, res, next) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId;

    // Check if tweet exists
    const tweetCheck = await pool.query('SELECT id FROM tweets WHERE id = $1', [tweetId]);
    if (tweetCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tweet not found' });
    }

    // Check if already liked
    const likeCheck = await pool.query(
      'SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2',
      [userId, tweetId]
    );

    if (likeCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Already liked this tweet' });
    }

    // Create like
    await pool.query(
      'INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)',
      [userId, tweetId]
    );

    // Get updated like count
    const countResult = await pool.query(
      'SELECT like_count FROM tweets WHERE id = $1',
      [tweetId]
    );

    res.status(201).json({
      message: 'Tweet liked',
      likeCount: countResult.rows[0].like_count,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/tweets/:id/like - Unlike a tweet
router.delete('/:id/like', requireAuth, async (req, res, next) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId;

    const result = await pool.query(
      'DELETE FROM likes WHERE user_id = $1 AND tweet_id = $2 RETURNING *',
      [userId, tweetId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Like not found' });
    }

    // Get updated like count
    const countResult = await pool.query(
      'SELECT like_count FROM tweets WHERE id = $1',
      [tweetId]
    );

    res.json({
      message: 'Tweet unliked',
      likeCount: countResult.rows[0].like_count,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/tweets/:id/retweet - Retweet a tweet
router.post('/:id/retweet', requireAuth, async (req, res, next) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId;

    // Check if tweet exists
    const tweetCheck = await pool.query('SELECT id, author_id FROM tweets WHERE id = $1', [tweetId]);
    if (tweetCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tweet not found' });
    }

    // Check if already retweeted
    const retweetCheck = await pool.query(
      'SELECT 1 FROM retweets WHERE user_id = $1 AND tweet_id = $2',
      [userId, tweetId]
    );

    if (retweetCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Already retweeted this tweet' });
    }

    // Create retweet record
    await pool.query(
      'INSERT INTO retweets (user_id, tweet_id) VALUES ($1, $2)',
      [userId, tweetId]
    );

    // Create a retweet tweet entry
    const retweetResult = await pool.query(
      `INSERT INTO tweets (author_id, content, retweet_of)
       VALUES ($1, '', $2)
       RETURNING *`,
      [userId, tweetId]
    );

    const retweet = retweetResult.rows[0];

    // Fanout retweet to followers
    await fanoutTweet(retweet.id, userId);

    // Get updated retweet count
    const countResult = await pool.query(
      'SELECT retweet_count FROM tweets WHERE id = $1',
      [tweetId]
    );

    res.status(201).json({
      message: 'Tweet retweeted',
      retweetCount: countResult.rows[0].retweet_count,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/tweets/:id/retweet - Undo retweet
router.delete('/:id/retweet', requireAuth, async (req, res, next) => {
  try {
    const tweetId = req.params.id;
    const userId = req.session.userId;

    // Delete retweet record
    const result = await pool.query(
      'DELETE FROM retweets WHERE user_id = $1 AND tweet_id = $2 RETURNING *',
      [userId, tweetId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Retweet not found' });
    }

    // Delete the retweet tweet entry
    await pool.query(
      'DELETE FROM tweets WHERE author_id = $1 AND retweet_of = $2',
      [userId, tweetId]
    );

    // Get updated retweet count
    const countResult = await pool.query(
      'SELECT retweet_count FROM tweets WHERE id = $1',
      [tweetId]
    );

    res.json({
      message: 'Retweet removed',
      retweetCount: countResult.rows[0].retweet_count,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/tweets/:id/replies - Get replies to a tweet
router.get('/:id/replies', async (req, res, next) => {
  try {
    const tweetId = req.params.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT t.*, u.username, u.display_name, u.avatar_url
       FROM tweets t
       JOIN users u ON t.author_id = u.id
       WHERE t.reply_to = $1 AND t.is_deleted = false
       ORDER BY t.created_at ASC
       LIMIT $2 OFFSET $3`,
      [tweetId, limit, offset]
    );

    // Get like/retweet status for current user
    let likeStatus = {};
    let retweetStatus = {};
    if (req.session && req.session.userId) {
      const tweetIds = result.rows.map(t => t.id);
      if (tweetIds.length > 0) {
        const likeCheck = await pool.query(
          'SELECT tweet_id FROM likes WHERE user_id = $1 AND tweet_id = ANY($2)',
          [req.session.userId, tweetIds]
        );
        likeCheck.rows.forEach(row => {
          likeStatus[row.tweet_id] = true;
        });

        const retweetCheck = await pool.query(
          'SELECT tweet_id FROM retweets WHERE user_id = $1 AND tweet_id = ANY($2)',
          [req.session.userId, tweetIds]
        );
        retweetCheck.rows.forEach(row => {
          retweetStatus[row.tweet_id] = true;
        });
      }
    }

    res.json({
      tweets: result.rows.map(tweet => ({
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

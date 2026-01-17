import express from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { requireAuth } from '../middleware/auth.js';
import { getFollowedCelebrities } from '../services/fanout.js';

const router = express.Router();

// Helper to format tweet for response
function formatTweet(tweet, likeStatus = {}, retweetStatus = {}) {
  return {
    id: tweet.id.toString(),
    content: tweet.content,
    mediaUrls: tweet.media_urls || [],
    hashtags: tweet.hashtags || [],
    mentions: tweet.mentions || [],
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
    isLiked: likeStatus[tweet.id] || false,
    isRetweeted: retweetStatus[tweet.id] || false,
  };
}

// GET /api/timeline/home - Get home timeline (hybrid push/pull)
router.get('/home', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before; // cursor for pagination

    // Step 1: Get cached timeline (pushed tweets from non-celebrities)
    const timelineKey = `timeline:${userId}`;
    let cachedTweetIds = await redis.lrange(timelineKey, 0, limit * 2);
    cachedTweetIds = cachedTweetIds.map(id => parseInt(id));

    // Step 2: Get followed celebrities for pull
    const celebrityIds = await getFollowedCelebrities(userId);

    // Step 3: Fetch tweets from celebrities (pull strategy)
    let celebrityTweets = [];
    if (celebrityIds.length > 0) {
      const celebrityResult = await pool.query(
        `SELECT t.*, u.username, u.display_name, u.avatar_url
         FROM tweets t
         JOIN users u ON t.author_id = u.id
         WHERE t.author_id = ANY($1)
           AND t.is_deleted = false
           AND t.reply_to IS NULL
         ORDER BY t.created_at DESC
         LIMIT $2`,
        [celebrityIds, limit]
      );
      celebrityTweets = celebrityResult.rows;
    }

    // Step 4: Fetch cached tweets from database
    let cachedTweets = [];
    if (cachedTweetIds.length > 0) {
      const cachedResult = await pool.query(
        `SELECT t.*, u.username, u.display_name, u.avatar_url
         FROM tweets t
         JOIN users u ON t.author_id = u.id
         WHERE t.id = ANY($1) AND t.is_deleted = false`,
        [cachedTweetIds]
      );
      cachedTweets = cachedResult.rows;
    }

    // Step 5: Merge and deduplicate tweets
    const tweetMap = new Map();

    for (const tweet of cachedTweets) {
      tweetMap.set(tweet.id.toString(), tweet);
    }

    for (const tweet of celebrityTweets) {
      tweetMap.set(tweet.id.toString(), tweet);
    }

    // Step 6: Sort by created_at DESC
    let allTweets = Array.from(tweetMap.values());
    allTweets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Apply cursor-based pagination
    if (before) {
      const beforeIndex = allTweets.findIndex(t => t.id.toString() === before);
      if (beforeIndex !== -1) {
        allTweets = allTweets.slice(beforeIndex + 1);
      }
    }

    allTweets = allTweets.slice(0, limit);

    // Step 7: Get like/retweet status for current user
    const tweetIds = allTweets.map(t => t.id);
    let likeStatus = {};
    let retweetStatus = {};

    if (tweetIds.length > 0) {
      const likeCheck = await pool.query(
        'SELECT tweet_id FROM likes WHERE user_id = $1 AND tweet_id = ANY($2)',
        [userId, tweetIds]
      );
      likeCheck.rows.forEach(row => {
        likeStatus[row.tweet_id] = true;
      });

      const retweetCheck = await pool.query(
        'SELECT tweet_id FROM retweets WHERE user_id = $1 AND tweet_id = ANY($2)',
        [userId, tweetIds]
      );
      retweetCheck.rows.forEach(row => {
        retweetStatus[row.tweet_id] = true;
      });
    }

    // Step 8: Fetch original tweets for retweets
    const retweetOfIds = allTweets
      .filter(t => t.retweet_of)
      .map(t => t.retweet_of);

    let originalTweets = {};
    if (retweetOfIds.length > 0) {
      const origResult = await pool.query(
        `SELECT t.*, u.username, u.display_name, u.avatar_url
         FROM tweets t
         JOIN users u ON t.author_id = u.id
         WHERE t.id = ANY($1)`,
        [retweetOfIds]
      );
      origResult.rows.forEach(tweet => {
        originalTweets[tweet.id] = {
          id: tweet.id.toString(),
          content: tweet.content,
          mediaUrls: tweet.media_urls || [],
          hashtags: tweet.hashtags || [],
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
        };
      });
    }

    res.json({
      tweets: allTweets.map(tweet => {
        const formatted = formatTweet(tweet, likeStatus, retweetStatus);
        if (tweet.retweet_of && originalTweets[tweet.retweet_of]) {
          formatted.originalTweet = originalTweets[tweet.retweet_of];
        }
        return formatted;
      }),
      nextCursor: allTweets.length > 0 ? allTweets[allTweets.length - 1].id.toString() : null,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/timeline/user/:username - Get user's tweets (profile timeline)
router.get('/user/:username', async (req, res, next) => {
  try {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before;

    // Get user
    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].id;

    // Build query with optional cursor
    let query = `
      SELECT t.*, u.username, u.display_name, u.avatar_url
      FROM tweets t
      JOIN users u ON t.author_id = u.id
      WHERE t.author_id = $1 AND t.is_deleted = false AND t.reply_to IS NULL
    `;
    const params = [userId];

    if (before) {
      query += ` AND t.id < $${params.length + 1}`;
      params.push(before);
    }

    query += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);

    // Get like/retweet status for current user
    const tweetIds = result.rows.map(t => t.id);
    let likeStatus = {};
    let retweetStatus = {};

    if (req.session && req.session.userId && tweetIds.length > 0) {
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

    // Fetch original tweets for retweets
    const retweetOfIds = result.rows
      .filter(t => t.retweet_of)
      .map(t => t.retweet_of);

    let originalTweets = {};
    if (retweetOfIds.length > 0) {
      const origResult = await pool.query(
        `SELECT t.*, u.username, u.display_name, u.avatar_url
         FROM tweets t
         JOIN users u ON t.author_id = u.id
         WHERE t.id = ANY($1)`,
        [retweetOfIds]
      );
      origResult.rows.forEach(tweet => {
        originalTweets[tweet.id] = {
          id: tweet.id.toString(),
          content: tweet.content,
          mediaUrls: tweet.media_urls || [],
          author: {
            id: tweet.author_id,
            username: tweet.username,
            displayName: tweet.display_name,
            avatarUrl: tweet.avatar_url,
          },
        };
      });
    }

    res.json({
      tweets: result.rows.map(tweet => {
        const formatted = formatTweet(tweet, likeStatus, retweetStatus);
        if (tweet.retweet_of && originalTweets[tweet.retweet_of]) {
          formatted.originalTweet = originalTweets[tweet.retweet_of];
        }
        return formatted;
      }),
      nextCursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].id.toString() : null,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/timeline/explore - Get explore/public timeline
router.get('/explore', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before;

    // Build query with optional cursor
    let query = `
      SELECT t.*, u.username, u.display_name, u.avatar_url
      FROM tweets t
      JOIN users u ON t.author_id = u.id
      WHERE t.is_deleted = false AND t.reply_to IS NULL AND t.retweet_of IS NULL
    `;
    const params = [];

    if (before) {
      query += ` AND t.id < $${params.length + 1}`;
      params.push(before);
    }

    query += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);

    // Get like/retweet status for current user
    const tweetIds = result.rows.map(t => t.id);
    let likeStatus = {};
    let retweetStatus = {};

    if (req.session && req.session.userId && tweetIds.length > 0) {
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

    res.json({
      tweets: result.rows.map(tweet => formatTweet(tweet, likeStatus, retweetStatus)),
      nextCursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].id.toString() : null,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/timeline/hashtag/:tag - Get tweets by hashtag
router.get('/hashtag/:tag', async (req, res, next) => {
  try {
    const hashtag = req.params.tag.toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before;

    let query = `
      SELECT t.*, u.username, u.display_name, u.avatar_url
      FROM tweets t
      JOIN users u ON t.author_id = u.id
      WHERE $1 = ANY(t.hashtags) AND t.is_deleted = false
    `;
    const params = [hashtag];

    if (before) {
      query += ` AND t.id < $${params.length + 1}`;
      params.push(before);
    }

    query += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);

    // Get like/retweet status for current user
    const tweetIds = result.rows.map(t => t.id);
    let likeStatus = {};
    let retweetStatus = {};

    if (req.session && req.session.userId && tweetIds.length > 0) {
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

    res.json({
      hashtag,
      tweets: result.rows.map(tweet => formatTweet(tweet, likeStatus, retweetStatus)),
      nextCursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].id.toString() : null,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

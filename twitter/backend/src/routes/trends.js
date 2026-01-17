import express from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';

const router = express.Router();

const BUCKET_SIZE = 60; // 1 minute in seconds
const WINDOW_SIZE = 60; // 60 buckets = 1 hour

/**
 * Calculate trend score with exponential decay
 * Recent activity is weighted more heavily
 */
async function getTrendScore(hashtag) {
  const now = Math.floor(Date.now() / 1000 / BUCKET_SIZE);
  let score = 0;

  const pipeline = redis.pipeline();
  for (let i = 0; i < WINDOW_SIZE; i++) {
    const bucket = now - i;
    pipeline.get(`trend:${hashtag}:${bucket}`);
  }

  const results = await pipeline.exec();

  for (let i = 0; i < results.length; i++) {
    const [err, count] = results[i];
    if (!err && count) {
      // Apply exponential decay: more recent = higher weight
      score += parseInt(count) * Math.pow(0.95, i);
    }
  }

  return score;
}

/**
 * Calculate trend velocity (change over time)
 */
async function getTrendVelocity(hashtag) {
  const now = Math.floor(Date.now() / 1000 / BUCKET_SIZE);

  // Last 30 minutes
  let recentCount = 0;
  const recentPipeline = redis.pipeline();
  for (let i = 0; i < 30; i++) {
    recentPipeline.get(`trend:${hashtag}:${now - i}`);
  }
  const recentResults = await recentPipeline.exec();
  for (const [err, count] of recentResults) {
    if (!err && count) recentCount += parseInt(count);
  }

  // Previous 30 minutes
  let previousCount = 0;
  const prevPipeline = redis.pipeline();
  for (let i = 30; i < 60; i++) {
    prevPipeline.get(`trend:${hashtag}:${now - i}`);
  }
  const prevResults = await prevPipeline.exec();
  for (const [err, count] of prevResults) {
    if (!err && count) previousCount += parseInt(count);
  }

  if (previousCount === 0) {
    return recentCount > 5 ? Infinity : 0;
  }

  return (recentCount - previousCount) / previousCount;
}

// GET /api/trends - Get trending hashtags
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    // Get hashtags from the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const result = await pool.query(
      `SELECT hashtag, COUNT(*) as count
       FROM hashtag_activity
       WHERE created_at > $1
       GROUP BY hashtag
       ORDER BY count DESC
       LIMIT $2`,
      [oneHourAgo, limit * 2] // Get more than needed to calculate scores
    );

    // Calculate scores and velocities for each hashtag
    const trends = [];
    for (const row of result.rows) {
      const score = await getTrendScore(row.hashtag);
      const velocity = await getTrendVelocity(row.hashtag);

      trends.push({
        hashtag: row.hashtag,
        tweetCount: parseInt(row.count),
        score: Math.round(score * 100) / 100,
        velocity: velocity === Infinity ? 'rising' : Math.round(velocity * 100) / 100,
        isRising: velocity > 0.2,
      });
    }

    // Sort by score
    trends.sort((a, b) => b.score - a.score);

    res.json({
      trends: trends.slice(0, limit),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/trends/all-time - Get all-time popular hashtags (from database)
router.get('/all-time', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const result = await pool.query(
      `SELECT hashtag, COUNT(*) as count
       FROM hashtag_activity
       GROUP BY hashtag
       ORDER BY count DESC
       LIMIT $1`,
      [limit]
    );

    res.json({
      trends: result.rows.map(row => ({
        hashtag: row.hashtag,
        tweetCount: parseInt(row.count),
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;

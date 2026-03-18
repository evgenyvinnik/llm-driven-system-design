import express, { Request, Response, NextFunction, Router } from 'express';
import redis from '../db/redis.js';
import pool from '../db/pool.js';

const router: Router = express.Router();

interface TrendingHashtag {
  hashtag: string;
  tweetCount: number;
  score: number;
}

// GET /api/trends
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const now = Math.floor(Date.now() / 1000 / 60);

    // Get all hashtags from recent buckets
    const hashtagScores: Record<string, number> = {};
    const BUCKET_WINDOW = 60; // 60 minutes

    // Scan for trend keys
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', 'trend:*:*', 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...foundKeys);
    } while (cursor !== '0');

    // Calculate scores with exponential decay
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length !== 3) continue;

      const hashtag = parts[1];
      const bucket = parseInt(parts[2]);
      const age = now - bucket;

      if (age < 0 || age > BUCKET_WINDOW) continue;

      const count = parseInt(await redis.get(key) || '0');
      const decay = Math.pow(0.95, age);
      const score = count * decay;

      hashtagScores[hashtag] = (hashtagScores[hashtag] || 0) + score;
    }

    // Sort and get top trends
    const trends: TrendingHashtag[] = Object.entries(hashtagScores)
      .map(([hashtag, score]) => ({ hashtag, score, tweetCount: 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Get tweet counts from database
    if (trends.length > 0) {
      const hashtags = trends.map(t => t.hashtag);
      const result = await pool.query(
        `SELECT hashtag, COUNT(*) as count
         FROM hashtag_activity
         WHERE hashtag = ANY($1)
           AND created_at > NOW() - INTERVAL '24 hours'
         GROUP BY hashtag`,
        [hashtags],
      );

      const counts: Record<string, number> = {};
      result.rows.forEach((row: { hashtag: string; count: string }) => {
        counts[row.hashtag] = parseInt(row.count);
      });

      trends.forEach(trend => {
        trend.tweetCount = counts[trend.hashtag] || 0;
      });
    }

    res.json({ trends, updatedAt: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

// GET /api/trends/all-time
router.get('/all-time', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    const result = await pool.query(
      `SELECT hashtag, COUNT(*) as count
       FROM hashtag_activity
       GROUP BY hashtag
       ORDER BY count DESC
       LIMIT $1`,
      [limit],
    );

    const trends: TrendingHashtag[] = result.rows.map((row: { hashtag: string; count: string }) => ({
      hashtag: row.hashtag,
      tweetCount: parseInt(row.count),
      score: parseInt(row.count),
    }));

    res.json({ trends });
  } catch (error) {
    next(error);
  }
});

/** Trends router returning trending hashtags scored with exponential time decay. */
export default router;

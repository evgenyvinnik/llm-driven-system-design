import dotenv from 'dotenv';
import redis from '../db/redis.js';
import pool from '../db/pool.js';
import logger from '../shared/logger.js';

dotenv.config();

const CALCULATION_INTERVAL = parseInt(process.env.TRENDING_INTERVAL_MS || '') || 60000; // 1 minute

interface TrendingHashtag {
  hashtag: string;
  score: number;
}

async function calculateTrends(): Promise<TrendingHashtag[]> {
  const now = Math.floor(Date.now() / 1000 / 60);
  const hashtagScores: Record<string, number> = {};
  const BUCKET_WINDOW = 60;

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

  // Sort and return top trends
  return Object.entries(hashtagScores)
    .map(([hashtag, score]) => ({ hashtag, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}

async function updateTrendingCache(trends: TrendingHashtag[]): Promise<void> {
  if (trends.length === 0) return;

  const pipeline = redis.pipeline();

  // Store in sorted set
  pipeline.del('trending:current');
  for (const trend of trends) {
    pipeline.zadd('trending:current', trend.score, trend.hashtag);
  }
  pipeline.expire('trending:current', 300); // 5 minutes

  await pipeline.exec();

  logger.info({ trendCount: trends.length }, 'Updated trending cache');
}

async function cleanupOldBuckets(): Promise<number> {
  const now = Math.floor(Date.now() / 1000 / 60);
  const BUCKET_WINDOW = 120; // Clean up buckets older than 2 hours
  let cleaned = 0;

  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', 'trend:*:*', 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...foundKeys);
  } while (cursor !== '0');

  for (const key of keys) {
    const parts = key.split(':');
    if (parts.length !== 3) continue;

    const bucket = parseInt(parts[2]);
    const age = now - bucket;

    if (age > BUCKET_WINDOW) {
      await redis.del(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up old trend buckets');
  }

  return cleaned;
}

async function runCalculation(): Promise<void> {
  try {
    const trends = await calculateTrends();
    await updateTrendingCache(trends);
    await cleanupOldBuckets();

    if (trends.length > 0) {
      logger.debug(
        { topTrends: trends.slice(0, 5).map(t => t.hashtag) },
        'Top trending hashtags',
      );
    }
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Error calculating trends');
  }
}

async function main(): Promise<void> {
  logger.info('Starting trending worker');

  // Run immediately
  await runCalculation();

  // Then run periodically
  setInterval(runCalculation, CALCULATION_INTERVAL);

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down trending worker');
    await redis.quit();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info({ intervalMs: CALCULATION_INTERVAL }, 'Trending worker running');
}

main();

import dotenv from 'dotenv';
import { query } from '../db/index.js';
import { calculateHotScore } from '../utils/ranking.js';
import logger from '../shared/logger.js';
import { hotScoreCalculationDuration, hotScorePostsProcessed } from '../shared/metrics.js';
import pool from '../db/index.js';
import redis from '../db/redis.js';

dotenv.config();

const RANKING_INTERVAL = parseInt(process.env.RANKING_CALCULATION_INTERVAL) || 60000;

let isShuttingDown = false;

const recalculateHotScores = async () => {
  if (isShuttingDown) return;

  const start = Date.now();

  try {
    // Get all posts from the last 7 days (older posts don't need recalculation)
    const result = await query(`
      SELECT id, upvotes, downvotes, created_at
      FROM posts
      WHERE created_at > NOW() - INTERVAL '7 days'
        AND (is_archived IS NULL OR is_archived = FALSE)
    `);

    let updated = 0;
    for (const post of result.rows) {
      if (isShuttingDown) break;

      const hotScore = calculateHotScore(post.upvotes, post.downvotes, new Date(post.created_at));
      await query(`UPDATE posts SET hot_score = $1 WHERE id = $2`, [hotScore, post.id]);
      updated++;
    }

    const duration = (Date.now() - start) / 1000;

    // Record metrics
    hotScoreCalculationDuration.observe(duration);
    hotScorePostsProcessed.set(updated);

    logger.info({
      postsProcessed: updated,
      durationMs: Math.round(duration * 1000),
    }, 'Hot score recalculation completed');
  } catch (error) {
    logger.error({ err: error }, 'Error recalculating hot scores');
  }
};

const run = async () => {
  logger.info({
    interval: RANKING_INTERVAL,
  }, 'Ranking calculator started');

  // Initial calculation
  await recalculateHotScores();

  // Periodic recalculation
  setInterval(recalculateHotScores, RANKING_INTERVAL);
};

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Ranking calculator shutting down');
  isShuttingDown = true;

  try {
    await pool.end();
    await redis.quit();
    logger.info('Ranking calculator shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

run();

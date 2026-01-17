import dotenv from 'dotenv';
import { aggregateAllVotes } from '../models/vote.js';
import logger from '../shared/logger.js';
import { voteAggregationLag, voteAggregationDuration } from '../shared/metrics.js';
import pool from '../db/index.js';
import redis from '../db/redis.js';

dotenv.config();

const AGGREGATION_INTERVAL = parseInt(process.env.VOTE_AGGREGATION_INTERVAL) || 5000;

let lastAggregationTime = Date.now();
let isShuttingDown = false;

const run = async () => {
  logger.info({
    interval: AGGREGATION_INTERVAL,
  }, 'Vote aggregator started');

  // Update lag metric continuously
  setInterval(() => {
    const lagSeconds = (Date.now() - lastAggregationTime) / 1000;
    voteAggregationLag.set(lagSeconds);
  }, 1000);

  // Periodic aggregation
  const runAggregation = async () => {
    if (isShuttingDown) return;

    const start = Date.now();
    try {
      const result = await aggregateAllVotes();
      const duration = (Date.now() - start) / 1000;

      voteAggregationDuration.observe(duration);
      lastAggregationTime = Date.now();

      if (result.postsAggregated > 0 || result.commentsAggregated > 0) {
        logger.debug({
          postsAggregated: result.postsAggregated,
          commentsAggregated: result.commentsAggregated,
          durationMs: Math.round(duration * 1000),
        }, 'Vote aggregation completed');
      }
    } catch (error) {
      logger.error({ err: error }, 'Error aggregating votes');
    }
  };

  // Run immediately on startup
  await runAggregation();

  // Then run periodically
  setInterval(runAggregation, AGGREGATION_INTERVAL);
};

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Vote aggregator shutting down');
  isShuttingDown = true;

  try {
    await pool.end();
    await redis.quit();
    logger.info('Vote aggregator shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

run();

/**
 * @fileoverview Crawler worker entry point.
 *
 * This is the entry point for running a crawler worker process.
 * Each worker runs independently and processes URLs from the shared frontier.
 * Multiple workers can run in parallel for horizontal scaling.
 *
 * A worker:
 * - Initializes database connections
 * - Creates and starts a CrawlerService instance
 * - Handles graceful shutdown on SIGTERM/SIGINT
 *
 * Usage:
 *   WORKER_ID=1 npm run dev:worker
 *   WORKER_ID=2 npm run dev:worker
 *
 * @module worker
 */

import { config } from './config.js';
import { initDatabase, closeDatabase } from './models/database.js';
import { closeRedis } from './models/redis.js';
import { CrawlerService } from './services/crawler.js';

/**
 * Worker ID from configuration.
 * Each worker should have a unique ID for tracking and debugging.
 */
const workerId = config.crawler.workerId;

/**
 * Crawler service instance.
 * Null until start() is called.
 */
let crawler: CrawlerService | null = null;

/**
 * Starts the crawler worker.
 *
 * Initializes the database, creates a CrawlerService, and starts
 * the main crawl loop. This function blocks until the worker is stopped.
 */
async function start() {
  try {
    console.log(`Starting crawler worker ${workerId}...`);

    // Initialize database
    await initDatabase();
    console.log('Database initialized');

    // Create and start crawler
    crawler = new CrawlerService(workerId);
    await crawler.start();
  } catch (error) {
    console.error('Failed to start worker:', error);
    process.exit(1);
  }
}

/**
 * Gracefully shuts down the worker.
 *
 * Stops the crawler (allowing current operation to complete),
 * closes database and Redis connections, then exits.
 */
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return; // a second Ctrl+C shouldn't close pools twice
  shuttingDown = true;
  console.log(`Worker ${workerId} shutting down...`);

  if (crawler) {
    await crawler.stop();
  }

  await closeDatabase();
  await closeRedis();

  console.log(`Worker ${workerId} shutdown complete`);
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the worker
start();

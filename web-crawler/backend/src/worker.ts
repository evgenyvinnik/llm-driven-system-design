import { config } from './config.js';
import { initDatabase, closeDatabase } from './models/database.js';
import { closeRedis } from './models/redis.js';
import { CrawlerService } from './services/crawler.js';

const workerId = config.crawler.workerId;
let crawler: CrawlerService | null = null;

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

// Handle graceful shutdown
async function shutdown() {
  console.log(`Worker ${workerId} shutting down...`);

  if (crawler) {
    await crawler.stop();
  }

  await closeDatabase();
  await closeRedis();

  console.log(`Worker ${workerId} shutdown complete`);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();

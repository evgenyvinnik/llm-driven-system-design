import { pool, initDatabase, closeDatabase } from '../models/database.js';
import { frontierService } from '../services/frontier.js';
import { closeRedis } from '../models/redis.js';

const SEED_URLS = [
  'https://example.com',
  'https://en.wikipedia.org/wiki/Main_Page',
  'https://news.ycombinator.com',
  'https://www.reddit.com',
  'https://github.com',
  'https://www.bbc.com/news',
  'https://www.cnn.com',
  'https://www.nytimes.com',
  'https://techcrunch.com',
  'https://www.wired.com',
];

async function seed() {
  try {
    console.log('Initializing database...');
    await initDatabase();

    console.log('Adding seed URLs to frontier...');

    // Add to seed_urls table
    for (const url of SEED_URLS) {
      await pool.query(
        `INSERT INTO seed_urls (url, priority) VALUES ($1, 3)
         ON CONFLICT (url) DO NOTHING`,
        [url]
      );
    }

    // Add to frontier with high priority
    const added = await frontierService.addUrls(SEED_URLS, {
      priority: 3,
      depth: 0,
    });

    console.log(`Added ${added} seed URLs to frontier`);
    console.log('Seed completed successfully');
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
    await closeRedis();
  }
}

seed();

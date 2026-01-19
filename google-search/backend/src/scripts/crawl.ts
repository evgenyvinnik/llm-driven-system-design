/**
 * Crawl script - runs the web crawler
 * Usage: npm run crawl
 */

import { crawler, urlFrontier } from '../services/crawler.js';
import { config } from '../config/index.js';
import { db } from '../models/db.js';
import { redis } from '../models/redis.js';

async function main(): Promise<void> {
  console.log('Starting web crawler...');

  // Parse command line arguments
  const args = process.argv.slice(2);
  let maxPages = config.crawler.maxPages;
  let seedUrl: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-pages' && args[i + 1]) {
      maxPages = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--seed' && args[i + 1]) {
      seedUrl = args[i + 1];
      i++;
    }
  }

  // Add seed URL if provided
  if (seedUrl) {
    console.log(`Adding seed URL: ${seedUrl}`);
    await urlFrontier.addUrl(seedUrl, 1.0);
  }

  // Run the crawler
  const stats = await crawler.run(maxPages);

  console.log('\n=== Crawl Complete ===');
  console.log(`Pages crawled: ${stats.crawled}`);
  console.log(`Errors: ${stats.errors}`);

  // Clean up
  await redis.quit();
  await db.end();

  process.exit(0);
}

main().catch((error) => {
  console.error('Crawler error:', error);
  process.exit(1);
});

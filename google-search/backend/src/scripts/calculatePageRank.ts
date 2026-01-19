/**
 * Calculate PageRank script - computes PageRank for all crawled URLs
 * Usage: npm run calculate-pagerank
 */

import { pageRankCalculator } from '../services/pagerank.js';
import { db } from '../models/db.js';
import { redis } from '../models/redis.js';

async function main(): Promise<void> {
  console.log('Starting PageRank calculation...');

  // Calculate PageRank
  const topPages = await pageRankCalculator.calculate();

  console.log('\n=== PageRank Calculation Complete ===');

  // Display top pages
  if (topPages.length > 0) {
    console.log('\nTop 10 Pages by PageRank:');
    for (const [urlId, rank] of topPages) {
      const result = await db.query<{ url: string }>('SELECT url FROM urls WHERE id = $1', [urlId]);
      const url = result.rows[0]?.url || 'Unknown';
      console.log(`  ${rank.toFixed(6)} - ${url}`);
    }
  }

  // Get stats
  const stats = await pageRankCalculator.getStats();
  console.log('\nPageRank Statistics:');
  console.log(`  Total pages with rank: ${stats.stats.total}`);
  console.log(`  Average rank: ${parseFloat(stats.stats.avg_rank).toFixed(8)}`);
  console.log(`  Max rank: ${parseFloat(stats.stats.max_rank).toFixed(6)}`);
  console.log(`  Min rank: ${parseFloat(stats.stats.min_rank).toFixed(8)}`);

  // Clean up
  await redis.quit();
  await db.end();

  process.exit(0);
}

main().catch((error) => {
  console.error('PageRank calculation error:', error);
  process.exit(1);
});

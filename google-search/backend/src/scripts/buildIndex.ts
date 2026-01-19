/**
 * Build Index script - indexes all crawled documents into Elasticsearch
 * Usage: npm run build-index
 */

import { indexer } from '../services/indexer.js';
import { db } from '../models/db.js';
import { redis } from '../models/redis.js';
import { initElasticsearch } from '../models/elasticsearch.js';

async function main(): Promise<void> {
  console.log('Starting index build...');

  // Initialize Elasticsearch
  await initElasticsearch();

  // Update inlink counts first (for ranking)
  await indexer.updateInlinkCounts();

  // Index all documents
  const indexed = await indexer.indexAll();

  console.log('\n=== Index Build Complete ===');
  console.log(`Documents indexed: ${indexed}`);

  // Get final stats
  const stats = await indexer.getStats();
  console.log('\nIndex Statistics:');
  console.log(`  URLs: ${stats.urls.total} total, ${stats.urls.crawled} crawled, ${stats.urls.pending} pending`);
  console.log(`  Documents: ${stats.documents.total}`);
  console.log(`  Links: ${stats.links.total}`);

  // Clean up
  await redis.quit();
  await db.end();

  process.exit(0);
}

main().catch((error) => {
  console.error('Index build error:', error);
  process.exit(1);
});

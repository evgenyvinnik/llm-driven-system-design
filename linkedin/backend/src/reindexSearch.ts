/**
 * Queues every user and job for the Elasticsearch outbox relay.
 * Use after restoring a database, losing an index, or changing a mapping; the
 * running API (services/searchIndexer.ts) does the actual indexing.
 * Usage: npm run search:reindex
 */
import { pool } from './utils/db.js';
import { enqueueFullReindex } from './services/searchIndexer.js';

try {
  const queued = await enqueueFullReindex();
  console.log(`Queued ${queued} documents for reindexing`);
} catch (error) {
  console.error('Reindex failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit();
}

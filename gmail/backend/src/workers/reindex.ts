/**
 * Rebuilds the search index from PostgreSQL: deletes and recreates the
 * `emails` index, then clears every message's indexed marker so the running
 * indexer re-indexes everything. Use after resetting Elasticsearch, which used
 * to leave old mail permanently unsearchable.
 */
import { query } from '../services/db.js';
import { esClient, EMAIL_INDEX, initializeIndex } from '../services/elasticsearch.js';
import pool from '../services/db.js';

const run = async () => {
  await esClient.indices.delete({ index: EMAIL_INDEX, ignore_unavailable: true });
  await initializeIndex();
  const result = await query(
    `UPDATE messages SET indexed_at = NULL, index_attempts = 0, index_error = NULL`
  );
  console.log(`Index recreated; ${result.rowCount} messages queued for re-indexing.`);
  await pool.end();
};

run().catch((error) => {
  console.error('Reindex failed:', error);
  process.exit(1);
});

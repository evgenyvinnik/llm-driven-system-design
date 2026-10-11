/**
 * Keeps the Elasticsearch indices in step with PostgreSQL through a transactional outbox.
 *
 * Writers never call Elasticsearch. In the same transaction as the data change they
 * upsert one row into `search_index_queue` meaning "this user/job is dirty". A relay
 * loop claims due rows, rebuilds each document from the current database state,
 * indexes it, and deletes the row only if nobody re-dirtied it in the meantime.
 *
 * Why this shape:
 * - A failed or slow Elasticsearch can no longer fail a registration or profile edit
 *   (the old code awaited the index call after the row was committed, so the client
 *   saw a 500 for a write that had succeeded).
 * - Nothing is lost while Elasticsearch is down: rows wait with exponential backoff.
 * - One row per entity coalesces bursts of edits, and documents are rebuilt from the
 *   source of truth, so retries and reordering cannot leave an old version indexed.
 *   Each re-enqueue bumps the row's `version`; the relay deletes only the version it
 *   claimed, so an edit that lands mid-index keeps its row for the next pass.
 * - `FOR UPDATE SKIP LOCKED` plus a 30-second lease lets several API instances run
 *   the relay without double-processing a row.
 *
 * @module services/searchIndexer
 */
import type { PoolClient } from 'pg';
import { query, queryOne, execute } from '../utils/db.js';
import { indexUser, indexJob, deleteSearchDocument, isSearchAvailable } from '../utils/elasticsearch.js';
import { logger } from '../utils/logger.js';
import { searchIndexOperationsTotal } from '../utils/metrics.js';

export type SearchEntity = 'user' | 'job';

interface QueueRow {
  entity_type: SearchEntity;
  entity_id: number;
  /** BIGINT arrives as a string from pg; compared verbatim */
  version: string;
  attempts: number;
}

/** A claimed row is invisible to other relays for this long. */
const LEASE_SECONDS = 30;
/** Retry delays grow 2, 4, 8 ... seconds, capped at five minutes. */
const MAX_BACKOFF_SECONDS = 300;
const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 2000;

/**
 * Marks an entity as needing reindexing. Call inside the writer's transaction.
 *
 * @param client - The transaction's client
 * @param entityType - 'user' or 'job'
 * @param entityId - Row id
 */
export async function enqueueSearchIndex(
  client: PoolClient,
  entityType: SearchEntity,
  entityId: number
): Promise<void> {
  await client.query(
    `INSERT INTO search_index_queue (entity_type, entity_id)
     VALUES ($1, $2)
     ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET version = search_index_queue.version + 1, enqueued_at = NOW(),
           attempts = 0, next_attempt_at = NOW(), last_error = NULL`,
    [entityType, entityId]
  );
}

/**
 * Queues every user and job for reindexing (fresh cluster, lost index, mapping change).
 *
 * @returns Number of rows queued
 */
export async function enqueueFullReindex(): Promise<number> {
  const queued = await execute(
    `INSERT INTO search_index_queue (entity_type, entity_id)
     SELECT 'user', id FROM users
     UNION ALL
     SELECT 'job', id FROM jobs
     ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET version = search_index_queue.version + 1, enqueued_at = NOW(),
           attempts = 0, next_attempt_at = NOW(), last_error = NULL`
  );
  logger.info({ queued }, 'Queued full search reindex');
  return queued;
}

/** Retry delay in seconds after the given number of failed attempts. */
export function backoffSeconds(attempts: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.max(1, attempts));
}

async function claimDueRows(limit: number): Promise<QueueRow[]> {
  return query<QueueRow>(
    `UPDATE search_index_queue q
     SET next_attempt_at = clock_timestamp() + make_interval(secs => $2)
     FROM (
       SELECT entity_type, entity_id
       FROM search_index_queue
       WHERE next_attempt_at <= clock_timestamp()
       ORDER BY next_attempt_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ) due
     WHERE q.entity_type = due.entity_type AND q.entity_id = due.entity_id
     RETURNING q.entity_type, q.entity_id, q.version, q.attempts`,
    [limit, LEASE_SECONDS]
  );
}

async function syncUser(id: number): Promise<void> {
  const user = await queryOne<{
    id: number;
    first_name: string;
    last_name: string;
    headline?: string;
    summary?: string;
    location?: string;
    industry?: string;
  }>(
    `SELECT id, first_name, last_name, headline, summary, location, industry
     FROM users WHERE id = $1`,
    [id]
  );
  if (!user) {
    await deleteSearchDocument('users', id);
    return;
  }
  const [skills, companies] = await Promise.all([
    query<{ name: string }>(
      `SELECT s.name FROM user_skills us JOIN skills s ON s.id = us.skill_id WHERE us.user_id = $1`,
      [id]
    ),
    query<{ company_name: string }>(
      `SELECT DISTINCT company_name FROM experiences WHERE user_id = $1`,
      [id]
    ),
  ]);
  await indexUser({
    ...user,
    headline: user.headline ?? undefined,
    summary: user.summary ?? undefined,
    location: user.location ?? undefined,
    industry: user.industry ?? undefined,
    skills: skills.map((s) => s.name),
    companies: companies.map((c) => c.company_name),
  });
}

async function syncJob(id: number): Promise<void> {
  const job = await queryOne<{
    id: number;
    title: string;
    description: string;
    company_name: string;
    location?: string;
    is_remote: boolean;
    employment_type?: string;
    experience_level?: string;
    status: string;
  }>(
    `SELECT j.id, j.title, j.description, c.name AS company_name, j.location, j.is_remote,
            j.employment_type, j.experience_level, j.status
     FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.id = $1`,
    [id]
  );
  if (!job) {
    await deleteSearchDocument('jobs', id);
    return;
  }
  const skills = await query<{ name: string }>(
    `SELECT s.name FROM job_skills js JOIN skills s ON s.id = js.skill_id WHERE js.job_id = $1`,
    [id]
  );
  await indexJob({
    ...job,
    location: job.location ?? undefined,
    employment_type: job.employment_type ?? undefined,
    experience_level: job.experience_level ?? undefined,
    skills: skills.map((s) => s.name),
  });
}

async function processRow(row: QueueRow): Promise<boolean> {
  try {
    if (row.entity_type === 'user') await syncUser(row.entity_id);
    else await syncJob(row.entity_id);
    // Delete only the version we indexed; a newer edit keeps its row for the next pass.
    await execute(
      `DELETE FROM search_index_queue
       WHERE entity_type = $1 AND entity_id = $2 AND version = $3`,
      [row.entity_type, row.entity_id, row.version]
    );
    searchIndexOperationsTotal.inc({ entity: row.entity_type, result: 'indexed' });
    return true;
  } catch (error) {
    const attempts = row.attempts + 1;
    await execute(
      `UPDATE search_index_queue
       SET attempts = $4, last_error = $5,
           next_attempt_at = clock_timestamp() + make_interval(secs => $6)
       WHERE entity_type = $1 AND entity_id = $2 AND version = $3`,
      [
        row.entity_type,
        row.entity_id,
        row.version,
        attempts,
        String((error as Error).message ?? error).slice(0, 500),
        backoffSeconds(attempts),
      ]
    );
    searchIndexOperationsTotal.inc({ entity: row.entity_type, result: 'retry' });
    return false;
  }
}

/**
 * Claims and processes one batch of due rows.
 *
 * @param limit - Maximum rows to claim
 * @returns Counts of indexed and failed rows
 */
export async function processSearchIndexBatch(
  limit = BATCH_SIZE
): Promise<{ indexed: number; failed: number }> {
  // While Elasticsearch is known to be down, leave rows untouched instead of
  // burning an attempt on each one.
  if (!isSearchAvailable()) return { indexed: 0, failed: 0 };

  const rows = await claimDueRows(limit);
  let indexed = 0;
  let failed = 0;
  for (const row of rows) {
    if (await processRow(row)) indexed++;
    else failed++;
  }
  if (rows.length > 0) logger.debug({ indexed, failed }, 'Search index batch processed');
  return { indexed, failed };
}

/**
 * Number of rows waiting to be indexed (exported as a gauge).
 */
export async function getSearchIndexBacklog(): Promise<number> {
  const row = await queryOne<{ count: string }>(`SELECT COUNT(*)::text AS count FROM search_index_queue`);
  return Number(row?.count ?? 0);
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Starts the relay loop in this process. Safe to run on every API instance.
 */
export function startSearchIndexer(): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processSearchIndexBatch();
    } catch (error) {
      logger.error({ error }, 'Search index relay failed');
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
  timer.unref();
}

/**
 * Stops the relay loop (graceful shutdown).
 */
export function stopSearchIndexer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

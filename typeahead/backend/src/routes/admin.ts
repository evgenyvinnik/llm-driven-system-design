import express, { Router, Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { adminRateLimiter } from '../shared/rate-limiter.js';
import { idempotencyMiddleware } from '../shared/idempotency.js';
import logger, { auditLogger } from '../shared/logger.js';
import { suggestionRequests, suggestionLatency } from '../shared/metrics.js';
import { normalizePhrase } from '../data-structures/trie.js';
import type { Trie } from '../data-structures/trie.js';
import type { SuggestionService } from '../services/suggestion-service.js';
import type { AggregationService } from '../services/aggregation-service.js';

const router: Router = express.Router();

// Apply admin rate limiting to all admin routes
router.use(adminRateLimiter);

// Column limits from init.sql: phrase VARCHAR(200), filtered_phrases.reason VARCHAR(50)
const MAX_PHRASE_LENGTH = 200;
const MAX_REASON_LENGTH = 50;
// Well above any real count (seed max is 200000) and inside BIGINT and Number's safe range
const MAX_PHRASE_COUNT = 1_000_000_000;

interface FilteredPhraseRow {
  phrase: string;
  reason: string;
  added_at: Date;
}

interface PhraseCountRow {
  count: string;
  last_updated_ms: string;
}

interface UpsertedPhraseRow extends PhraseCountRow {
  previous_count: string | null;
  was_filtered: boolean | null;
}

/**
 * Parse an integer query parameter, clamped to [min, max].
 * Missing or non-integer values get the fallback.
 */
function parseIntParam(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string' || !/^\s*-?\d+\s*$/.test(value)) {
    return fallback;
  }
  return Math.min(Math.max(Number(value), min), max);
}

/**
 * Normalize a phrase from a request, or return null if it is empty or too long to store.
 */
function parsePhrase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizePhrase(value);
  return normalized.length > 0 && normalized.length <= MAX_PHRASE_LENGTH ? normalized : null;
}

/**
 * Update the Redis blocked set, which mirrors filtered_phrases (Postgres stays the source of
 * truth and is checked on every logged search). Skipped while Redis is disconnected, where
 * ioredis would queue the command through its reconnect retries; AggregationService
 * re-syncs the set from filtered_phrases when Redis reconnects.
 */
async function updateBlockedSet(redis: Redis, call: (redis: Redis) => Promise<unknown>): Promise<void> {
  if (redis.status !== 'ready') {
    logger.warn({ event: 'blocked_set_update_skipped', reason: `Redis ${redis.status}` });
    return;
  }
  try {
    await call(redis);
  } catch (error) {
    logger.warn({ event: 'blocked_set_update_failed', error: (error as Error).message });
  }
}

/**
 * GET /api/v1/admin/trie/stats
 * Get trie statistics.
 */
router.get('/trie/stats', async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const trie = req.app.get('trie') as Trie;
    const stats = trie.getStats();

    timer({ endpoint: 'admin_trie_stats', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_trie_stats', status: 'success' });

    res.json(stats);
  } catch (error) {
    timer({ endpoint: 'admin_trie_stats', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_trie_stats', status: 'error' });

    logger.error({
      event: 'trie_stats_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/v1/admin/trie/rebuild
 * Rebuild the trie from the database.
 *
 * WHY idempotency: Prevents duplicate rebuilds on retry
 */
router.post('/trie/rebuild', idempotencyMiddleware('trie_rebuild'), async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();
  const startTime = Date.now();

  try {
    const aggregationService = req.app.get('aggregationService') as AggregationService;

    logger.info({
      event: 'trie_rebuild_started',
      idempotencyKey: req.idempotencyKey,
    });

    await aggregationService.rebuildTrie();

    const trie = req.app.get('trie') as Trie;
    const stats = trie.getStats();
    const durationMs = Date.now() - startTime;

    auditLogger.logTrieRebuild('manual', stats.phraseCount, durationMs);

    timer({ endpoint: 'admin_trie_rebuild', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_trie_rebuild', status: 'success' });

    res.json({
      success: true,
      message: 'Trie rebuilt successfully',
      stats,
      durationMs,
      idempotencyKey: req.idempotencyKey,
    });
  } catch (error) {
    timer({ endpoint: 'admin_trie_rebuild', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_trie_rebuild', status: 'error' });

    logger.error({
      event: 'trie_rebuild_error',
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/v1/admin/phrases
 * Add a phrase to the trie, or raise the count of an existing one.
 *
 * WHY idempotency: Prevents duplicate phrase inserts on retry
 *
 * Adding never lowers a count: an existing phrase keeps max(existing, requested), so the
 * form's default count of 1 can't wipe out accumulated popularity. Re-adding a removed
 * phrase restores it. Phrases on the filter list are rejected with 409.
 *
 * Body:
 * - phrase: The phrase to add (required, at most 200 characters after trimming)
 * - count: Count to set if it is higher than the existing one (integer >= 1, default: 1)
 *
 * Response: count is the stored count; created, previousCount and restored describe
 * what the phrase looked like before.
 */
router.post('/phrases', idempotencyMiddleware('phrase_add'), async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { phrase, count = 1 } = (req.body ?? {}) as { phrase?: unknown; count?: unknown };
    const normalizedPhrase = parsePhrase(phrase);

    if (!normalizedPhrase) {
      timer({ endpoint: 'admin_phrase_add', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'admin_phrase_add', status: 'validation_error' });
      res.status(400).json({
        error: `"phrase" must be a non-empty string of at most ${MAX_PHRASE_LENGTH} characters`,
      });
      return;
    }

    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_PHRASE_COUNT
    ) {
      timer({ endpoint: 'admin_phrase_add', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'admin_phrase_add', status: 'validation_error' });
      res.status(400).json({
        error: `"count" must be an integer from 1 to ${MAX_PHRASE_COUNT}`,
      });
      return;
    }

    const trie = req.app.get('trie') as Trie;
    const pgPool = req.app.get('pgPool') as Pool;
    const suggestionService = req.app.get('suggestionService') as SuggestionService;

    // A filtered phrase must stay out of suggestions until its filter is removed
    const filtered = await pgPool.query('SELECT 1 FROM filtered_phrases WHERE phrase = $1', [
      normalizedPhrase,
    ]);
    if (filtered.rows.length > 0) {
      timer({ endpoint: 'admin_phrase_add', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'admin_phrase_add', status: 'conflict' });
      res.status(409).json({
        error: 'Phrase is on the filter list; remove the filter to restore it',
      });
      return;
    }

    // Write to the database first, so a failed write never leaves an unpersisted phrase in
    // the trie. Clearing is_filtered keeps a re-added phrase across rebuilds and restarts.
    // The CTE reads the row as it was before the upsert.
    const result = await pgPool.query<UpsertedPhraseRow>(
      `
      WITH previous AS (
        SELECT count, is_filtered FROM phrase_counts WHERE phrase = $1
      )
      INSERT INTO phrase_counts (phrase, count, last_updated, is_filtered)
      VALUES ($1, $2, NOW(), false)
      ON CONFLICT (phrase)
      DO UPDATE SET count = GREATEST(phrase_counts.count, EXCLUDED.count),
                    last_updated = NOW(),
                    is_filtered = false
      RETURNING count,
                EXTRACT(EPOCH FROM last_updated::timestamptz) * 1000 AS last_updated_ms,
                (SELECT count FROM previous) AS previous_count,
                (SELECT is_filtered FROM previous) AS was_filtered
    `,
      [normalizedPhrase, count]
    );

    const row = result.rows[0];
    const storedCount = Number(row.count);
    const previousCount = row.previous_count === null ? null : Number(row.previous_count);
    const restored = row.was_filtered === true;

    trie.insert(normalizedPhrase, storedCount, Number(row.last_updated_ms));

    // Clear every cached prefix list the phrase can appear in
    await suggestionService.invalidatePhrase(normalizedPhrase);
    auditLogger.logCacheInvalidation(normalizedPhrase, 'phrase_added');

    logger.info({
      event: 'phrase_added',
      phrase: normalizedPhrase.substring(0, 50),
      requestedCount: count,
      count: storedCount,
      previousCount,
      restored,
      idempotencyKey: req.idempotencyKey,
    });

    timer({ endpoint: 'admin_phrase_add', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_phrase_add', status: 'success' });

    let message: string;
    if (previousCount === null) {
      message = 'Phrase added successfully';
    } else if (storedCount > previousCount) {
      message = `Phrase already existed; count raised from ${previousCount} to ${storedCount}`;
    } else if (count < previousCount) {
      message = `Phrase already existed with higher count ${previousCount}; adding never lowers a count`;
    } else {
      message = `Phrase already existed with count ${previousCount}`;
    }
    if (restored) {
      message += ' (restored to suggestions)';
    }

    res.json({
      success: true,
      message,
      phrase: normalizedPhrase,
      count: storedCount,
      requestedCount: count,
      created: previousCount === null,
      previousCount,
      restored,
      idempotencyKey: req.idempotencyKey,
    });
  } catch (error) {
    timer({ endpoint: 'admin_phrase_add', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_phrase_add', status: 'error' });

    logger.error({
      event: 'add_phrase_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * DELETE /api/v1/admin/phrases/:phrase
 * Remove a phrase from suggestions. Its row stays in phrase_counts with is_filtered = true,
 * which keeps it out of rebuilds and aggregation flushes; DELETE /filter/:phrase restores it.
 *
 * WHY idempotency: Replays the first response when a client retries with the same
 * X-Idempotency-Key. Without one, a repeated delete is harmless and simply runs again.
 */
router.delete('/phrases/:phrase', idempotencyMiddleware('phrase_delete'), async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const normalizedPhrase = normalizePhrase(req.params.phrase);
    const idempotencyKey = req.idempotencyKey;

    const trie = req.app.get('trie') as Trie;
    const pgPool = req.app.get('pgPool') as Pool;
    const suggestionService = req.app.get('suggestionService') as SuggestionService;
    const aggregationService = req.app.get('aggregationService') as AggregationService;

    // Mark as filtered in the database first, so a failed write leaves the phrase visible
    // rather than gone from the trie but back on the next rebuild
    const updated = await pgPool.query(
      `
      UPDATE phrase_counts
      SET is_filtered = true
      WHERE phrase = $1 AND is_filtered = false
    `,
      [normalizedPhrase]
    );

    // Remove from trie, and drop its pending count and trending entries
    const removedFromTrie = trie.remove(normalizedPhrase);
    const removed = removedFromTrie || (updated.rowCount ?? 0) > 0;
    await aggregationService.discardPhrase(normalizedPhrase);

    // Clear every cached prefix list the phrase can appear in
    await suggestionService.invalidatePhrase(normalizedPhrase);
    auditLogger.logCacheInvalidation(normalizedPhrase, 'phrase_removed');

    const result = {
      success: removed,
      message: removed ? 'Phrase removed successfully' : 'Phrase not found',
      idempotencyKey,
    };

    logger.info({
      event: 'phrase_removed',
      phrase: normalizedPhrase.substring(0, 50),
      removed,
      idempotencyKey,
    });

    timer({ endpoint: 'admin_phrase_delete', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_phrase_delete', status: 'success' });

    res.json(result);
  } catch (error) {
    timer({ endpoint: 'admin_phrase_delete', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_phrase_delete', status: 'error' });

    logger.error({
      event: 'remove_phrase_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/v1/admin/filter
 * Add a phrase to the filter list.
 *
 * WHY idempotency: Prevents duplicate filter additions
 *
 * Body:
 * - phrase: The phrase to filter (required, at most 200 characters after trimming)
 * - reason: Reason for filtering (optional, at most 50 characters)
 */
router.post('/filter', idempotencyMiddleware('filter_add'), async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { phrase, reason = 'manual' } = (req.body ?? {}) as {
      phrase?: unknown;
      reason?: unknown;
    };
    const normalizedPhrase = parsePhrase(phrase);

    if (!normalizedPhrase) {
      timer({ endpoint: 'admin_filter_add', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'admin_filter_add', status: 'validation_error' });
      res.status(400).json({
        error: `"phrase" must be a non-empty string of at most ${MAX_PHRASE_LENGTH} characters`,
      });
      return;
    }

    if (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH) {
      timer({ endpoint: 'admin_filter_add', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'admin_filter_add', status: 'validation_error' });
      res.status(400).json({
        error: `"reason" must be a string of at most ${MAX_REASON_LENGTH} characters`,
      });
      return;
    }

    const pgPool = req.app.get('pgPool') as Pool;
    const redis = req.app.get('redis') as Redis;
    const trie = req.app.get('trie') as Trie;
    const suggestionService = req.app.get('suggestionService') as SuggestionService;
    const aggregationService = req.app.get('aggregationService') as AggregationService;

    // Add to filtered phrases
    await pgPool.query(
      `
      INSERT INTO filtered_phrases (phrase, reason, added_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (phrase) DO NOTHING
    `,
      [normalizedPhrase, reason]
    );

    // Add to Redis blocked set for fast lookup
    await updateBlockedSet(redis, (client) => client.sadd('blocked_phrases', normalizedPhrase));

    // Remove from trie, and drop its pending count and trending entries now rather than at
    // the next trending aggregation
    trie.remove(normalizedPhrase);
    await aggregationService.discardPhrase(normalizedPhrase);

    // Update phrase_counts
    await pgPool.query(
      `
      UPDATE phrase_counts
      SET is_filtered = true
      WHERE phrase = $1
    `,
      [normalizedPhrase]
    );

    // Clear every cached prefix list the phrase can appear in
    await suggestionService.invalidatePhrase(normalizedPhrase);

    auditLogger.logFilterChange('add', normalizedPhrase, reason);
    auditLogger.logCacheInvalidation(normalizedPhrase, 'filter_added');

    logger.info({
      event: 'phrase_filtered',
      phrase: normalizedPhrase.substring(0, 50),
      reason,
      idempotencyKey: req.idempotencyKey,
    });

    timer({ endpoint: 'admin_filter_add', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_filter_add', status: 'success' });

    res.json({
      success: true,
      message: 'Phrase filtered successfully',
      phrase: normalizedPhrase,
      idempotencyKey: req.idempotencyKey,
    });
  } catch (error) {
    timer({ endpoint: 'admin_filter_add', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_filter_add', status: 'error' });

    logger.error({
      event: 'filter_phrase_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/v1/admin/filtered
 * Get list of filtered phrases.
 *
 * Query params:
 * - limit: Max number of phrases (default: 100, max: 1000)
 */
router.get('/filtered', async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const limit = parseIntParam(req.query.limit, 100, 1, 1000);
    const pgPool = req.app.get('pgPool') as Pool;

    const result = await pgPool.query<FilteredPhraseRow>(
      `
      SELECT phrase, reason, added_at
      FROM filtered_phrases
      ORDER BY added_at DESC
      LIMIT $1
    `,
      [limit]
    );

    timer({ endpoint: 'admin_filtered_list', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_filtered_list', status: 'success' });

    res.json({
      filtered: result.rows,
      meta: {
        count: result.rows.length,
      },
    });
  } catch (error) {
    timer({ endpoint: 'admin_filtered_list', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_filtered_list', status: 'error' });

    logger.error({
      event: 'get_filtered_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * DELETE /api/v1/admin/filter/:phrase
 * Remove a phrase from the filter list and put it back into suggestions with its stored
 * count. Also restores a phrase removed with DELETE /phrases/:phrase.
 */
router.delete('/filter/:phrase', async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const normalizedPhrase = normalizePhrase(req.params.phrase);
    const pgPool = req.app.get('pgPool') as Pool;
    const redis = req.app.get('redis') as Redis;
    const trie = req.app.get('trie') as Trie;
    const suggestionService = req.app.get('suggestionService') as SuggestionService;

    // Remove from filtered phrases
    await pgPool.query(
      `
      DELETE FROM filtered_phrases WHERE phrase = $1
    `,
      [normalizedPhrase]
    );

    // Remove from Redis blocked set
    await updateBlockedSet(redis, (client) => client.srem('blocked_phrases', normalizedPhrase));

    // Unmark in phrase_counts and reinsert into the trie, which dropped it when filtered
    const unfiltered = await pgPool.query<PhraseCountRow>(
      `
      UPDATE phrase_counts
      SET is_filtered = false
      WHERE phrase = $1 AND is_filtered = true
      RETURNING count, EXTRACT(EPOCH FROM last_updated::timestamptz) * 1000 AS last_updated_ms
    `,
      [normalizedPhrase]
    );

    const row = unfiltered.rows[0];
    if (row) {
      trie.insert(normalizedPhrase, Number(row.count), Number(row.last_updated_ms));
    }

    // Clear every cached prefix list the phrase can appear in
    await suggestionService.invalidatePhrase(normalizedPhrase);

    auditLogger.logFilterChange('remove', normalizedPhrase, 'manual_removal');
    auditLogger.logCacheInvalidation(normalizedPhrase, 'filter_removed');

    logger.info({
      event: 'filter_removed',
      phrase: normalizedPhrase.substring(0, 50),
      restored: !!row,
    });

    timer({ endpoint: 'admin_filter_remove', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_filter_remove', status: 'success' });

    res.json({
      success: true,
      message: row
        ? 'Filter removed; phrase restored to suggestions'
        : 'Filter removed successfully',
      restored: !!row,
    });
  } catch (error) {
    timer({ endpoint: 'admin_filter_remove', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_filter_remove', status: 'error' });

    logger.error({
      event: 'remove_filter_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/v1/admin/cache/clear
 * Clear the suggestion cache.
 */
router.post('/cache/clear', idempotencyMiddleware('cache_clear'), async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const suggestionService = req.app.get('suggestionService') as SuggestionService;
    await suggestionService.clearCache();

    auditLogger.logCacheInvalidation('*', 'manual_clear');

    logger.info({
      event: 'cache_cleared',
      idempotencyKey: req.idempotencyKey,
    });

    timer({ endpoint: 'admin_cache_clear', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_cache_clear', status: 'success' });

    res.json({
      success: true,
      message: 'Cache cleared successfully',
      idempotencyKey: req.idempotencyKey,
    });
  } catch (error) {
    timer({ endpoint: 'admin_cache_clear', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_cache_clear', status: 'error' });

    logger.error({
      event: 'clear_cache_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/v1/admin/status
 * Get overall system status.
 */
router.get('/status', async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const redis = req.app.get('redis') as Redis;
    const pgPool = req.app.get('pgPool') as Pool;
    const trie = req.app.get('trie') as Trie;
    const aggregationService = req.app.get('aggregationService') as AggregationService;

    // Check Redis
    let redisStatus = 'unknown';
    try {
      // Fail at once while disconnected instead of waiting in ioredis's offline queue
      if (redis.status !== 'ready') throw new Error(`Redis ${redis.status}`);
      const pong = await redis.ping();
      redisStatus = pong === 'PONG' ? 'connected' : 'error';
    } catch {
      redisStatus = 'error';
    }

    // Check PostgreSQL
    let pgStatus = 'unknown';
    try {
      await pgPool.query('SELECT 1');
      pgStatus = 'connected';
    } catch {
      pgStatus = 'error';
    }

    timer({ endpoint: 'admin_status', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'admin_status', status: 'success' });

    res.json({
      status: redisStatus === 'connected' && pgStatus === 'connected' ? 'healthy' : 'degraded',
      services: {
        redis: redisStatus,
        postgres: pgStatus,
      },
      trie: trie.getStats(),
      aggregation: aggregationService.getStats(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    timer({ endpoint: 'admin_status', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'admin_status', status: 'error' });

    logger.error({
      event: 'status_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

export default router;

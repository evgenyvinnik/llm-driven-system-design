/**
 * AggregationService processes query logs and updates the trie.
 * Implements buffered writes and periodic flushing for efficiency.
 */
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Trie } from '../data-structures/trie.js';
import { aggregationMetrics } from '../shared/metrics.js';

interface BufferEntry {
  count: number;
  firstSeen: number;
  lastSeen?: number;
}

interface AggregationStats {
  bufferSize: number;
  isRunning: boolean;
  flushInterval: number;
}

/**
 * Outcome of processQuery. Rejected queries are not counted, trended, or logged.
 * reason: invalid | too_long | low_quality | inappropriate | filter_unavailable
 */
export interface ProcessQueryResult {
  accepted: boolean;
  reason?: string;
}

type BlockStatus = 'blocked' | 'clear' | 'unknown';

const MAX_QUERY_LENGTH = 100;
// Distinct phrases held between flushes. If flushes keep failing, new phrases are dropped past this.
const MAX_BUFFER_SIZE = 50000;

const TRENDING_KEY = 'trending_queries';
const BLOCKED_KEY = 'blocked_phrases';
const TRENDING_WINDOW_MS = 300000; // 5-minute windows
const TRENDING_WINDOW_COUNT = 12; // 1 hour of windows

// A letters-only word this long with no vowel (y counts) is a smash: real words and acronyms have one
const MIN_VOWELLESS_WORD = 6;
// Runs of 7 adjacent keys on one QWERTY row, either direction ("asdfghj", "poiuytr").
// No word contains one, while 6 would already reject "qwerty".
const KEYBOARD_RUN_LENGTH = 7;
const KEYBOARD_RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
  .flatMap((row) => [row, [...row].reverse().join('')])
  .flatMap((row) =>
    Array.from({ length: row.length - KEYBOARD_RUN_LENGTH + 1 }, (_, i) =>
      row.slice(i, i + KEYBOARD_RUN_LENGTH)
    )
  );

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SQLSTATE classes 22 (data exception) and 23 (integrity violation) mean this row can never be
 * written, so retrying it would fail on every flush. Anything else (connection loss, timeouts,
 * a missing table during startup) is worth retrying.
 */
function isPermanentRowError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^2[23]/.test(code);
}

export class AggregationService {
  private redis: Redis;
  private pgPool: Pool;
  private trie: Trie;
  private buffer: Map<string, BufferEntry> = new Map();
  private flushInterval: number = 30000; // 30 seconds
  private flushTimer: NodeJS.Timeout | null = null;
  private trendingTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private droppedCounts: number = 0;
  private isRunning: boolean = false;

  constructor(redis: Redis, pgPool: Pool, trie: Trie) {
    this.redis = redis;
    this.pgPool = pgPool;
    this.trie = trie;
  }

  /**
   * Start the aggregation service. Calling it again while running does nothing.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Periodic flush to database and trie
    this.flushTimer = setInterval(() => {
      this.flush().catch((err: Error) => console.error('Error flushing:', err.message));
    }, this.flushInterval);

    // Trending is recomputed from the windows on its own timer, whether or not anything was
    // searched, so phrases stop trending once their windows expire
    this.trendingTimer = setInterval(() => this.aggregateTrendingWindows(), this.flushInterval);

    // Mirror filtered_phrases into the Redis blocked set, then publish a fresh trending set
    void this.syncBlockedPhrases().then(() => this.aggregateTrendingWindows());

    console.log('Aggregation service started');
  }

  /**
   * Stop the aggregation service, resolving after the final flush.
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.trendingTimer) {
      clearInterval(this.trendingTimer);
      this.trendingTimer = null;
    }

    // Final flush: let a running flush finish, then write what was buffered since it started
    try {
      if (this.flushPromise) await this.flushPromise;
      await this.flush();
    } catch (error) {
      console.error('Error in final flush:', (error as Error).message);
    }
    console.log('Aggregation service stopped');
  }

  /**
   * Process a search query.
   */
  async processQuery(
    query: string,
    userId: string | null = null,
    sessionId: string | null = null
  ): Promise<ProcessQueryResult> {
    if (!query || typeof query !== 'string') return this.reject('invalid');

    const normalizedQuery = query.toLowerCase().trim();

    // Filter low-quality queries
    if (normalizedQuery.length > MAX_QUERY_LENGTH) return this.reject('too_long');
    if (this.isLowQuality(normalizedQuery)) return this.reject('low_quality');

    // Filter inappropriate content; fail closed when the blocklist can't be read at all
    const blockStatus = await this.checkBlocked(normalizedQuery);
    if (blockStatus === 'blocked') return this.reject('inappropriate');
    if (blockStatus === 'unknown') return this.reject('filter_unavailable');

    // Update buffer
    this.addToBuffer(normalizedQuery, 1, Date.now());

    // Update trending in real-time
    await this.updateTrending(normalizedQuery);

    // Log to PostgreSQL (async, non-blocking)
    this.logQuery(normalizedQuery, userId, sessionId).catch((err: Error) => {
      console.error('Error logging query:', err.message);
    });

    return { accepted: true };
  }

  private reject(reason: string): ProcessQueryResult {
    aggregationMetrics.queriesFiltered.inc({ reason });
    return { accepted: false, reason };
  }

  /**
   * Add a count to the buffer, merging with any pending count for the phrase.
   * Bounded: when it already holds MAX_BUFFER_SIZE phrases, counts for new phrases are dropped.
   */
  private addToBuffer(phrase: string, count: number, firstSeen: number, lastSeen: number = firstSeen): void {
    const entry = this.buffer.get(phrase);
    if (entry) {
      entry.count += count;
      entry.firstSeen = Math.min(entry.firstSeen, firstSeen);
      entry.lastSeen = Math.max(entry.lastSeen ?? entry.firstSeen, lastSeen);
      return;
    }

    if (this.buffer.size >= MAX_BUFFER_SIZE) {
      if (this.droppedCounts === 0) {
        console.warn(`Aggregation buffer full (${MAX_BUFFER_SIZE} phrases); dropping counts for new phrases`);
      }
      this.droppedCounts += count;
      return;
    }

    this.buffer.set(phrase, { count, firstSeen, lastSeen });
  }

  /**
   * Check if a query is low quality.
   */
  isLowQuality(query: string): boolean {
    // Too short
    if (query.length < 2) return true;

    // Too long
    if (query.length > MAX_QUERY_LENGTH) return true;

    // Mostly numbers
    if (/^\d+$/.test(query)) return true;

    // Control characters (Postgres also rejects NUL in text)
    if (/[\u0000-\u001f\u007f]/.test(query)) return true;

    // Random characters (keyboard smash detection): a vowelless word, or a run of adjacent keys
    for (const word of query.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (word.length >= MIN_VOWELLESS_WORD && !/[aeiouy]/.test(word)) return true;
      if (KEYBOARD_RUNS.some((run) => word.includes(run))) return true;
    }

    // Excessive repeated characters (not digits or spaces: "100000 yen to usd" is a real query)
    if (/([^\d\s])\1{4,}/.test(query)) return true;

    return false;
  }

  /**
   * Check if a query contains inappropriate content.
   * Fails closed: true when the blocklist could not be checked.
   */
  async isInappropriate(query: string): Promise<boolean> {
    return (await this.checkBlocked(query)) !== 'clear';
  }

  /**
   * Check a phrase against the Redis blocked set (fast path), then filtered_phrases.
   * Each source can block on its own, so an error in one doesn't let a blocked phrase through.
   * 'unknown' means neither could be read.
   */
  private async checkBlocked(query: string): Promise<BlockStatus> {
    let redisAnswered = false;
    try {
      if (await this.redis.sismember(BLOCKED_KEY, query)) return 'blocked';
      redisAnswered = true;
    } catch (error) {
      console.error('Error checking blocked set:', (error as Error).message);
    }

    try {
      const result = await this.pgPool.query('SELECT 1 FROM filtered_phrases WHERE phrase = $1', [
        query,
      ]);
      return result.rows.length > 0 ? 'blocked' : 'clear';
    } catch (error) {
      console.error('Error checking filtered phrases:', (error as Error).message);
      // The Redis set mirrors filtered_phrases (synced on start), so its answer stands alone
      return redisAnswered ? 'clear' : 'unknown';
    }
  }

  /**
   * Copy filtered_phrases into the Redis blocked set, so the fast-path check and the trending
   * exclusion also cover phrases filtered directly in Postgres (e.g. by the seed file).
   */
  async syncBlockedPhrases(): Promise<void> {
    try {
      const result = await this.pgPool.query<{ phrase: string }>('SELECT phrase FROM filtered_phrases');
      if (result.rows.length > 0) {
        await this.redis.sadd(BLOCKED_KEY, ...result.rows.map((row) => row.phrase));
      }
    } catch (error) {
      console.error('Error syncing blocked phrases:', (error as Error).message);
    }
  }

  /**
   * Update trending scores for real-time trending.
   */
  async updateTrending(query: string): Promise<void> {
    try {
      // Use sliding window counters
      const now = Date.now();
      const windowKey = `trending_window:${Math.floor(now / TRENDING_WINDOW_MS)}`; // 5-min windows

      await this.redis.zincrby(windowKey, 1, query);
      await this.redis.expire(windowKey, 3600); // Keep 1 hour of windows

      // Recent windows are aggregated by aggregateTrendingWindows on its own timer
    } catch (error) {
      console.error('Error updating trending:', (error as Error).message);
    }
  }

  /**
   * Log query to PostgreSQL for analytics.
   */
  async logQuery(
    query: string,
    userId: string | null,
    sessionId: string | null
  ): Promise<void> {
    // user_id is a UUID column: store other ids as NULL rather than failing the insert.
    // session_id is VARCHAR(100).
    const userUuid = typeof userId === 'string' && UUID_PATTERN.test(userId) ? userId : null;
    const session = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 100) : null;

    try {
      await this.pgPool.query(
        `INSERT INTO query_logs (query, user_id, session_id, timestamp)
         VALUES ($1, $2, $3, NOW())`,
        [query, userUuid, session]
      );
    } catch (error) {
      console.error('Error logging query:', (error as Error).message);
    }
  }

  /**
   * Flush buffer to database and update trie.
   * One flush runs at a time; calling flush() while one is running returns that flush.
   */
  flush(): Promise<void> {
    if (!this.flushPromise) {
      this.flushPromise = this.flushBuffer().finally(() => {
        this.flushPromise = null;
      });
    }
    return this.flushPromise;
  }

  private async flushBuffer(): Promise<void> {
    if (this.droppedCounts > 0) {
      console.warn(`Aggregation buffer was full: dropped ${this.droppedCounts} counts`);
      this.droppedCounts = 0;
    }

    if (this.buffer.size === 0) return;

    const endTimer = aggregationMetrics.flushDuration.startTimer();
    const updates = Array.from(this.buffer.entries());
    this.buffer.clear();

    console.log(`Flushing ${updates.length} phrase updates...`);

    // Phrases blocked since they were buffered must not go back into the trie
    const blocked = await this.blockedMembers(updates.map(([phrase]) => phrase));

    for (let i = 0; i < updates.length; i++) {
      const [phrase, entry] = updates[i];
      try {
        // Upsert to database. Filtered (blocked or admin-removed) rows stay is_filtered.
        const result = await this.pgPool.query<{
          count: string;
          is_filtered: boolean;
          last_updated_ms: string;
        }>(
          `INSERT INTO phrase_counts (phrase, count, last_updated, is_filtered)
           VALUES ($1::text, $2, NOW(), $3 OR EXISTS (SELECT 1 FROM filtered_phrases WHERE phrase = $1::text))
           ON CONFLICT (phrase)
           DO UPDATE SET count = phrase_counts.count + EXCLUDED.count, last_updated = NOW(),
             is_filtered = phrase_counts.is_filtered OR EXCLUDED.is_filtered
           RETURNING count, is_filtered,
             EXTRACT(EPOCH FROM last_updated::timestamptz) * 1000 AS last_updated_ms`,
          [phrase, entry.count, blocked[i]]
        );

        // Update trie with the stored total, unless the phrase is filtered
        const row = result.rows[0];
        if (!row.is_filtered) {
          this.trie.insert(phrase, Number(row.count), Number(row.last_updated_ms));
        }
      } catch (error) {
        console.error(`Error flushing phrase "${phrase}":`, (error as Error).message);
        if (isPermanentRowError(error)) continue;

        // Postgres is likely unavailable: keep this and the remaining counts for the next flush
        for (const [pending, pendingEntry] of updates.slice(i)) {
          this.addToBuffer(pending, pendingEntry.count, pendingEntry.firstSeen, pendingEntry.lastSeen);
        }
        console.warn(`Requeued ${updates.length - i} phrase updates for the next flush`);
        break;
      }
    }

    endTimer();
    console.log('Flush complete');
  }

  /**
   * Which phrases are in the Redis blocked set. On a Redis error the upsert's own
   * filtered_phrases check still applies, so none are reported blocked here.
   */
  private async blockedMembers(phrases: string[]): Promise<boolean[]> {
    try {
      const flags = await this.redis.smismember(BLOCKED_KEY, ...phrases);
      return flags.map((flag) => flag === 1);
    } catch (error) {
      console.error('Error checking blocked set:', (error as Error).message);
      return phrases.map(() => false);
    }
  }

  /**
   * Keys of the last 12 trending windows (1 hour), newest first.
   */
  private recentWindowKeys(): string[] {
    const currentWindow = Math.floor(Date.now() / TRENDING_WINDOW_MS);
    return Array.from({ length: TRENDING_WINDOW_COUNT }, (_, i) => `trending_window:${currentWindow - i}`);
  }

  /**
   * Aggregate recent trending windows into main trending set.
   * A window i steps old is weighted 0.9^i; that weighting is the trending decay.
   */
  async aggregateTrendingWindows(): Promise<void> {
    try {
      // Missing windows are empty sets to ZUNIONSTORE, so all keys are passed and weights follow age
      const windows = this.recentWindowKeys();
      const weights = windows.map((_, i) => Math.pow(0.9, i)); // More recent windows have higher weight
      const unionKey = `${TRENDING_KEY}:union`;

      // Union, then replace trending_queries without blocked phrases in one transaction.
      // An empty result deletes trending_queries, so nothing trends after an hour without searches.
      const results = await this.redis
        .multi()
        .zunionstore(unionKey, windows.length, ...windows, 'WEIGHTS', ...weights)
        .zdiffstore(TRENDING_KEY, 2, unionKey, BLOCKED_KEY)
        .del(unionKey)
        .exec();

      const failed = results?.find(([err]) => err);
      if (failed) throw failed[0];
    } catch (error) {
      console.error('Error aggregating trending:', (error as Error).message);
    }
  }

  /**
   * Drop a phrase that was just filtered or removed: its pending count and its trending entries,
   * so it leaves /trending now instead of at the next aggregation.
   */
  async discardPhrase(phrase: string): Promise<void> {
    const normalizedPhrase = phrase.toLowerCase().trim();
    this.buffer.delete(normalizedPhrase);

    try {
      const pipeline = this.redis.pipeline().zrem(TRENDING_KEY, normalizedPhrase);
      for (const windowKey of this.recentWindowKeys()) {
        pipeline.zrem(windowKey, normalizedPhrase);
      }
      await pipeline.exec();
    } catch (error) {
      console.error('Error discarding phrase from trending:', (error as Error).message);
    }
  }

  /**
   * Rebuild the entire trie from database.
   */
  async rebuildTrie(): Promise<void> {
    console.log('Rebuilding trie from database...');

    try {
      const result = await this.pgPool.query(
        `SELECT phrase, count, EXTRACT(EPOCH FROM last_updated::timestamptz) * 1000 AS last_updated_ms
         FROM phrase_counts
         WHERE is_filtered = false
         ORDER BY count DESC
         LIMIT 100000`
      );

      // Clear and rebuild
      this.trie.root = { children: new Map(), suggestions: [], isEndOfWord: false, count: 0, lastUpdated: Date.now() } as typeof this.trie.root;
      this.trie.size = 0;
      this.trie.phraseMap.clear();

      for (const row of result.rows) {
        const lastUpdated = row.last_updated_ms === null ? undefined : Number(row.last_updated_ms);
        this.trie.insert(row.phrase, parseInt(row.count), lastUpdated);
      }

      console.log(`Trie rebuilt with ${this.trie.size} phrases`);

      // Clear suggestion cache
      const keys = await this.redis.keys('suggestions:*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      console.error('Error rebuilding trie:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get aggregation stats.
   */
  getStats(): AggregationStats {
    return {
      bufferSize: this.buffer.size,
      isRunning: this.isRunning,
      flushInterval: this.flushInterval,
    };
  }
}

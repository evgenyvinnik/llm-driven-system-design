/**
 * TrieSyncService keeps this instance's in-memory trie in step with Postgres when several
 * API instances run against the same database.
 *
 * WHY: each instance builds its own trie at startup and then only sees its own writes (its
 * aggregation flushes, the admin calls it served). Without a sync, three instances drift
 * apart within one flush interval, and they share one Redis cache, so whichever instance
 * fills a cache key decides what everyone serves for the next minute.
 *
 * HOW: every write to phrase_counts sets changed_at = NOW(). Every SYNC_INTERVAL_MS this
 * service reads the rows whose changed_at is newer than its watermark and applies their
 * absolute state (count, is_filtered) to the trie, so a missed or repeated read is harmless.
 * Postgres stays the source of truth: a restarted instance or a dropped message catches up
 * on the next poll. A Redis pub/sub message after each write triggers an immediate poll on
 * the other instances, so admin changes spread in well under a second; it is only a hint.
 */
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { Trie } from '../data-structures/trie.js';
import type { SuggestionService } from './suggestion-service.js';
import logger from '../shared/logger.js';

const CHANNEL = 'typeahead:phrases-changed';
const DEFAULT_INTERVAL_MS = 5000;
// Rows are re-read this far behind the watermark: a write whose NOW() is older than a row we
// already saw can commit after our read (single-statement writes commit within milliseconds)
const OVERLAP = '10 seconds';

interface ChangedRow {
  phrase: string;
  count: string;
  is_filtered: boolean;
  last_updated_ms: string | null;
  changed_at: string;
  changed_at_ms: string;
}

export interface TrieSyncStats {
  instanceId: string;
  intervalMs: number;
  watermark: string | null;
  lastSyncAt: string | null;
  lastRowsRead: number;
  lastPhrasesApplied: number;
  totalPhrasesApplied: number;
  syncErrors: number;
}

export class TrieSyncService {
  private pgPool: Pool;
  private redis: Redis;
  private trie: Trie;
  private suggestionService: SuggestionService;
  private intervalMs: number;
  private instanceId = randomUUID();
  private subscriber: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watermark: string | null = null;
  private watermarkMs = 0;
  private running: Promise<void> | null = null;
  private rerunRequested = false;
  private stats = {
    lastSyncAt: null as string | null,
    lastRowsRead: 0,
    lastPhrasesApplied: 0,
    totalPhrasesApplied: 0,
    syncErrors: 0,
  };

  constructor(
    pgPool: Pool,
    redis: Redis,
    trie: Trie,
    suggestionService: SuggestionService,
    intervalMs: number = DEFAULT_INTERVAL_MS
  ) {
    this.pgPool = pgPool;
    this.redis = redis;
    this.trie = trie;
    this.suggestionService = suggestionService;
    this.intervalMs = intervalMs;
  }

  /**
   * Read the database clock. Call it right before the startup load and pass the result to
   * start(), so writes that land during the load are picked up by the first sync.
   */
  async currentDbTime(): Promise<{ text: string; ms: number }> {
    const result = await this.pgPool.query<{ now: string; now_ms: string }>(
      'SELECT NOW()::text AS now, EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms'
    );
    return { text: result.rows[0].now, ms: Number(result.rows[0].now_ms) };
  }

  /**
   * Begin polling from the given watermark (a timestamptz string from the database clock).
   */
  start(watermark: { text: string; ms: number }): void {
    if (this.timer) return;
    this.watermark = watermark.text;
    this.watermarkMs = watermark.ms;
    this.timer = setInterval(() => void this.syncNow(), this.intervalMs);
    this.subscribe();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    await this.running;
  }

  /**
   * Tell the other instances that phrase_counts changed (after a flush or an admin write).
   * Best effort: if Redis is down they still catch up on their next poll.
   */
  notifyChanged(): void {
    if (this.redis.status !== 'ready') return;
    this.redis.publish(CHANNEL, this.instanceId).catch(() => {
      // Redis went away between the status check and the publish; polling covers it
    });
  }

  /**
   * Apply every phrase_counts change since the watermark. Concurrent calls share one run and
   * schedule one more, so a burst of notifications costs at most two queries.
   */
  syncNow(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.runSync().finally(() => {
      this.running = null;
      if (this.rerunRequested && this.timer) {
        this.rerunRequested = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  getStats(): TrieSyncStats {
    return {
      instanceId: this.instanceId,
      intervalMs: this.intervalMs,
      watermark: this.watermark,
      ...this.stats,
    };
  }

  private subscribe(): void {
    // A connection in subscriber mode can't run other commands, so it gets its own
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', () => {
      // The main client already logs Redis outages; polling keeps the trie in step meanwhile
    });
    this.subscriber.on('message', (_channel: string, sender: string) => {
      if (sender !== this.instanceId) void this.syncNow();
    });
    // ioredis re-subscribes on reconnect
    this.subscriber.subscribe(CHANNEL).catch(() => {
      // Redis is down at startup; ioredis retries the subscription when it reconnects
    });
  }

  private async runSync(): Promise<void> {
    if (this.watermark === null) return;

    let rows: ChangedRow[];
    try {
      const result = await this.pgPool.query<ChangedRow>(
        `SELECT phrase, count, is_filtered,
                EXTRACT(EPOCH FROM last_updated::timestamptz) * 1000 AS last_updated_ms,
                changed_at::text AS changed_at,
                EXTRACT(EPOCH FROM changed_at) * 1000 AS changed_at_ms
         FROM phrase_counts
         WHERE changed_at > $1::timestamptz - INTERVAL '${OVERLAP}'
         ORDER BY changed_at`,
        [this.watermark]
      );
      rows = result.rows;
    } catch (error) {
      this.stats.syncErrors++;
      logger.warn({ event: 'trie_sync_error', error: (error as Error).message });
      return;
    }

    let applied = 0;
    const membershipChanged: string[] = [];

    for (const row of rows) {
      const wasPresent = this.trie.has(row.phrase);

      if (row.is_filtered) {
        if (wasPresent) {
          this.trie.remove(row.phrase);
          membershipChanged.push(row.phrase);
          applied++;
        }
        continue;
      }

      const count = Number(row.count);
      if (wasPresent && this.trie.getCount(row.phrase) === count) continue;

      const lastUpdated = row.last_updated_ms === null ? undefined : Number(row.last_updated_ms);
      this.trie.insert(row.phrase, count, lastUpdated);
      applied++;
      if (!wasPresent) membershipChanged.push(row.phrase);
    }

    // A count change only reorders lists, and cached lists expire within a minute anyway. A
    // phrase appearing or disappearing must not be hidden behind a list another instance cached
    // before it synced, so those prefixes are invalidated here as well.
    for (const phrase of membershipChanged) {
      await this.suggestionService.invalidatePhrase(phrase);
    }

    // No LIMIT on the read: it only spans the overlap plus one interval of writes, and a page
    // limit could stall when more rows than the limit share the overlap window
    if (rows.length > 0) {
      const newest = rows[rows.length - 1];
      if (Number(newest.changed_at_ms) > this.watermarkMs) {
        this.watermark = newest.changed_at;
        this.watermarkMs = Number(newest.changed_at_ms);
      }
    }

    this.stats.lastSyncAt = new Date().toISOString();
    this.stats.lastRowsRead = rows.length;
    this.stats.lastPhrasesApplied = applied;
    this.stats.totalPhrasesApplied += applied;

    if (applied > 0) {
      logger.info({ event: 'trie_synced', phrasesApplied: applied, rowsRead: rows.length });
    }
  }
}

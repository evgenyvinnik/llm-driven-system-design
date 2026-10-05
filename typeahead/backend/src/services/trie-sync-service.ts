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
 * service reads the rows whose changed_at is newer than its read floor and applies their
 * absolute state (count, recency, is_filtered) to the trie, so a missed or repeated read is
 * harmless. Postgres stays the source of truth: a restarted instance or a dropped message
 * catches up on the next poll. A Redis pub/sub message after each write triggers an
 * immediate poll on the other instances, so admin changes spread in well under a second; it
 * is only a hint.
 *
 * Rows that disappear (TRUNCATE by a reseed, a manual DELETE) leave no changed_at behind, so
 * every RECONCILE_EVERY polls the service compares the trie's phrase count with the live rows
 * in Postgres and reloads the trie when it holds phrases the database no longer has.
 */
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { Trie } from '../data-structures/trie.js';
import type { SuggestionService } from './suggestion-service.js';
import logger from '../shared/logger.js';

const CHANNEL = 'typeahead:phrases-changed';
const DEFAULT_INTERVAL_MS = 5000;
// Each poll re-reads writes this far back: a write whose NOW() is older than the poll can
// commit after it (single-statement writes commit within milliseconds)
const OVERLAP = '10 seconds';
// Compare phrase counts with Postgres every this many polls (every minute at the default)
const RECONCILE_EVERY = 12;
// A connected but unresponsive Redis must not hold up applying Postgres state
const INVALIDATE_TIMEOUT_MS = 250;

interface ChangedRow {
  phrase: string;
  count: string;
  is_filtered: boolean;
  last_updated_ms: string | null;
}

export interface TrieSyncStats {
  instanceId: string;
  intervalMs: number;
  readFrom: string | null;
  lastSyncAt: string | null;
  lastRowsRead: number;
  lastPhrasesApplied: number;
  totalPhrasesApplied: number;
  reloads: number;
  syncErrors: number;
}

export interface TrieSyncOptions {
  intervalMs?: number;
  /** Rebuild the trie from Postgres (and clear the suggestion cache). Used after deletions. */
  reload: () => Promise<void>;
}

export class TrieSyncService {
  private pgPool: Pool;
  private redis: Redis;
  private trie: Trie;
  private suggestionService: SuggestionService;
  private intervalMs: number;
  private reload: () => Promise<void>;
  private instanceId = randomUUID();
  private subscriber: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  // Rows with changed_at after this database timestamp are read on the next poll
  private readFrom: string | null = null;
  private pollCount = 0;
  private running: Promise<void> | null = null;
  private rerunRequested = false;
  private stats = {
    lastSyncAt: null as string | null,
    lastRowsRead: 0,
    lastPhrasesApplied: 0,
    totalPhrasesApplied: 0,
    reloads: 0,
    syncErrors: 0,
  };

  constructor(
    pgPool: Pool,
    redis: Redis,
    trie: Trie,
    suggestionService: SuggestionService,
    options: TrieSyncOptions
  ) {
    this.pgPool = pgPool;
    this.redis = redis;
    this.trie = trie;
    this.suggestionService = suggestionService;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.reload = options.reload;
  }

  /**
   * The read floor for a load starting now: the database clock minus the overlap. Call it right
   * before the startup load and pass the result to start(), so writes that land during the load
   * are picked up by the first poll.
   */
  async startPoint(): Promise<string> {
    const result = await this.pgPool.query<{ floor: string }>(
      `SELECT (NOW() - INTERVAL '${OVERLAP}')::text AS floor`
    );
    return result.rows[0].floor;
  }

  /**
   * Begin polling from the given read floor (a timestamptz string from the database clock).
   */
  start(readFrom: string): void {
    if (this.timer) return;
    this.readFrom = readFrom;
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
   * Apply every phrase_counts change since the read floor. Concurrent calls share one run and
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
      readFrom: this.readFrom,
      ...this.stats,
    };
  }

  private subscribe(): void {
    // A connection in subscriber mode can't run other commands, so it gets its own. Unlike the
    // main client (maxRetriesPerRequest: 3), its SUBSCRIBE waits in the offline queue until
    // Redis is reachable, so an instance that starts during a Redis outage still subscribes;
    // ioredis then re-subscribes by itself after later reconnects.
    this.subscriber = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.subscriber.on('error', () => {
      // The main client already logs Redis outages; polling keeps the trie in step meanwhile
    });
    this.subscriber.on('message', (_channel: string, sender: string) => {
      if (sender !== this.instanceId) void this.syncNow();
    });
    this.subscriber.subscribe(CHANNEL).catch(() => {
      // Only rejected if the subscriber is disconnected by stop()
    });
  }

  private async runSync(): Promise<void> {
    if (this.readFrom === null) return;

    let rows: ChangedRow[];
    let nextReadFrom: string;
    try {
      // Taken before the read: anything committed after this, minus the overlap, is read next time
      const floor = await this.pgPool.query<{ floor: string }>(
        `SELECT (NOW() - INTERVAL '${OVERLAP}')::text AS floor`
      );
      nextReadFrom = floor.rows[0].floor;

      // No LIMIT: the read spans one interval plus the overlap, and a page limit could stall
      // when more rows than the limit share that window
      const result = await this.pgPool.query<ChangedRow>(
        `SELECT phrase, count, is_filtered,
                EXTRACT(EPOCH FROM last_updated::timestamptz) * 1000 AS last_updated_ms
         FROM phrase_counts
         WHERE changed_at > $1::timestamptz
         ORDER BY changed_at`,
        [this.readFrom]
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
      const lastUpdated = row.last_updated_ms === null ? undefined : Number(row.last_updated_ms);
      if (wasPresent && this.trie.getCount(row.phrase) === count) {
        // Same count: still apply a newer last_updated (an admin re-add), since it feeds recency
        const stored = this.trie.getLastUpdated(row.phrase);
        if (lastUpdated === undefined || (stored !== undefined && Math.abs(stored - lastUpdated) < 1)) {
          continue;
        }
      }

      this.trie.insert(row.phrase, count, lastUpdated);
      applied++;
      if (!wasPresent) membershipChanged.push(row.phrase);
    }

    // A count change only reorders lists, and cached lists expire within a minute anyway. A
    // phrase appearing or disappearing must not be hidden behind a list another instance cached
    // before it synced, so those prefixes are invalidated here as well (bounded, so a stalled
    // Redis can't hold up the next poll).
    if (membershipChanged.length > 0) {
      await Promise.race([
        Promise.allSettled(membershipChanged.map((phrase) => this.suggestionService.invalidatePhrase(phrase))),
        new Promise((resolve) => setTimeout(resolve, INVALIDATE_TIMEOUT_MS)),
      ]);
    }

    this.readFrom = nextReadFrom;
    this.stats.lastSyncAt = new Date().toISOString();
    this.stats.lastRowsRead = rows.length;
    this.stats.lastPhrasesApplied = applied;
    this.stats.totalPhrasesApplied += applied;

    if (applied > 0) {
      logger.info({ event: 'trie_synced', phrasesApplied: applied, rowsRead: rows.length });
    }

    this.pollCount++;
    if (this.pollCount % RECONCILE_EVERY === 0) {
      await this.reconcile();
    }
  }

  /**
   * Reload the trie when it holds more phrases than Postgres has live rows: some rows were
   * deleted outright (a reseed's TRUNCATE, a manual DELETE), which leaves nothing to poll.
   * Fewer phrases in the trie is normal (the startup load reads at most 100,000).
   */
  private async reconcile(): Promise<void> {
    try {
      const result = await this.pgPool.query<{ live: string }>(
        'SELECT COUNT(*) AS live FROM phrase_counts WHERE is_filtered = false'
      );
      const live = Number(result.rows[0].live);
      const inTrie = this.trie.getStats().phraseCount;
      if (inTrie <= live) return;

      logger.warn({ event: 'trie_sync_reload', phrasesInTrie: inTrie, liveRows: live });
      await this.reload();
      this.stats.reloads++;
    } catch (error) {
      this.stats.syncErrors++;
      logger.warn({ event: 'trie_sync_reconcile_error', error: (error as Error).message });
    }
  }
}

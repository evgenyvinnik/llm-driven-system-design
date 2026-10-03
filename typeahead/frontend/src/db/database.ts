/**
 * IndexedDB persistence layer using Dexie.
 * Provides offline caching for suggestions, user history, and trie data.
 */
import Dexie, { type Table } from 'dexie';
import type { Suggestion } from '../types';

// Cached suggestion entry
export interface CachedSuggestion {
  id?: number;
  prefix: string; // a suggestionCacheKey(), not just the typed prefix
  suggestions: Suggestion[]; // kept whole so isFuzzy/scores survive a cache hit
  timestamp: number;
  ttl: number; // TTL in milliseconds
}

// User search history entry
export interface HistoryEntry {
  id?: number;
  phrase: string;
  timestamp: number;
  count: number;
}

// Local popularity tracking
export interface PopularQuery {
  id?: number;
  phrase: string;
  count: number;
  lastUpdated: number;
}

// Offline trie node data
export interface TrieNodeData {
  id?: number;
  prefix: string;
  topSuggestions: Array<{
    phrase: string;
    count: number;
  }>;
  updatedAt: number;
}

// Sync metadata for offline/online coordination
export interface SyncMetadata {
  id?: number;
  key: string;
  value: string;
  updatedAt: number;
}

class TypeaheadDatabase extends Dexie {
  suggestions!: Table<CachedSuggestion>;
  history!: Table<HistoryEntry>;
  popularQueries!: Table<PopularQuery>;
  trieNodes!: Table<TrieNodeData>;
  syncMetadata!: Table<SyncMetadata>;

  constructor() {
    super('TypeaheadDB');

    this.version(1).stores({
      // Indexed by prefix for quick lookup
      suggestions: '++id, prefix, timestamp',
      // Indexed by phrase and timestamp for history queries
      history: '++id, phrase, timestamp',
      // Indexed by phrase for popularity updates
      popularQueries: '++id, phrase, count, lastUpdated',
      // Indexed by prefix for trie traversal
      trieNodes: '++id, prefix, updatedAt',
      // Key-value store for sync state
      syncMetadata: '++id, &key, updatedAt',
    });
  }
}

export const db = new TypeaheadDatabase();

// Constants
const SUGGESTION_TTL = 60 * 60 * 1000; // 1 hour
const MAX_HISTORY_ENTRIES = 500;
const MAX_POPULAR_ENTRIES = 1000;

/**
 * IndexedDB key for a suggestion list. The server returns a different ranked list per limit,
 * fuzzy mode and user, so a key on the prefix alone would show one widget's list in another.
 */
export function suggestionCacheKey(
  prefix: string,
  variant: { limit: number; fuzzy: boolean; userId?: string }
): string {
  return `${variant.limit}|${variant.fuzzy ? 'fuzzy' : 'exact'}|${variant.userId ?? ''}|${prefix}`;
}

/**
 * Cache suggestions for a prefix (or a suggestionCacheKey).
 */
export async function cacheSuggestions(
  prefix: string,
  suggestions: CachedSuggestion['suggestions'],
  ttl: number = SUGGESTION_TTL
): Promise<void> {
  const normalized = prefix.toLowerCase().trim();

  // Delete existing entry for this prefix
  await db.suggestions.where('prefix').equals(normalized).delete();

  await db.suggestions.add({
    prefix: normalized,
    suggestions,
    timestamp: Date.now(),
    ttl,
  });

  // Cleanup old entries (older than max TTL)
  const cutoff = Date.now() - SUGGESTION_TTL * 2;
  await db.suggestions.where('timestamp').below(cutoff).delete();
}

/**
 * Get cached suggestions for a prefix.
 * Returns null if not found or expired.
 */
export async function getCachedSuggestions(
  prefix: string
): Promise<CachedSuggestion['suggestions'] | null> {
  const normalized = prefix.toLowerCase().trim();

  const entry = await db.suggestions.where('prefix').equals(normalized).first();

  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.timestamp > entry.ttl) {
    await db.suggestions.delete(entry.id!);
    return null;
  }

  return entry.suggestions;
}

/**
 * Add a phrase to user search history.
 */
export async function addToHistory(phrase: string): Promise<void> {
  const normalized = phrase.toLowerCase().trim();
  if (!normalized) return;

  const existing = await db.history.where('phrase').equals(normalized).first();

  if (existing) {
    await db.history.update(existing.id!, {
      count: existing.count + 1,
      timestamp: Date.now(),
    });
  } else {
    await db.history.add({
      phrase: normalized,
      timestamp: Date.now(),
      count: 1,
    });

    // Enforce max history size
    const count = await db.history.count();
    if (count > MAX_HISTORY_ENTRIES) {
      const oldest = await db.history.orderBy('timestamp').first();
      if (oldest) {
        await db.history.delete(oldest.id!);
      }
    }
  }
}

/**
 * Get user search history, sorted by recency.
 */
export async function getHistory(limit: number = 20): Promise<HistoryEntry[]> {
  return db.history.orderBy('timestamp').reverse().limit(limit).toArray();
}

/**
 * Clear user search history.
 */
export async function clearHistory(): Promise<void> {
  await db.history.clear();
}

/**
 * Update local popularity for a phrase.
 */
export async function updatePopularity(phrase: string, increment: number = 1): Promise<void> {
  const normalized = phrase.toLowerCase().trim();
  if (!normalized) return;

  const existing = await db.popularQueries.where('phrase').equals(normalized).first();

  if (existing) {
    await db.popularQueries.update(existing.id!, {
      count: existing.count + increment,
      lastUpdated: Date.now(),
    });
  } else {
    await db.popularQueries.add({
      phrase: normalized,
      count: increment,
      lastUpdated: Date.now(),
    });

    // Enforce max entries
    const count = await db.popularQueries.count();
    if (count > MAX_POPULAR_ENTRIES) {
      const oldest = await db.popularQueries.orderBy('lastUpdated').first();
      if (oldest) {
        await db.popularQueries.delete(oldest.id!);
      }
    }
  }
}

/**
 * Get top popular queries.
 */
export async function getTopPopular(limit: number = 20): Promise<PopularQuery[]> {
  return db.popularQueries.orderBy('count').reverse().limit(limit).toArray();
}

/**
 * Cache trie node data for offline use.
 */
export async function cacheTrieNode(
  prefix: string,
  topSuggestions: TrieNodeData['topSuggestions']
): Promise<void> {
  const normalized = prefix.toLowerCase();

  await db.trieNodes.where('prefix').equals(normalized).delete();

  await db.trieNodes.add({
    prefix: normalized,
    topSuggestions,
    updatedAt: Date.now(),
  });
}

/**
 * Get cached trie node data.
 */
export async function getTrieNode(prefix: string): Promise<TrieNodeData | undefined> {
  const normalized = prefix.toLowerCase();
  return db.trieNodes.where('prefix').equals(normalized).first();
}

/**
 * Set sync metadata value.
 */
export async function setSyncMeta(key: string, value: string): Promise<void> {
  const existing = await db.syncMetadata.where('key').equals(key).first();

  if (existing) {
    await db.syncMetadata.update(existing.id!, {
      value,
      updatedAt: Date.now(),
    });
  } else {
    await db.syncMetadata.add({
      key,
      value,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Get sync metadata value.
 */
export async function getSyncMeta(key: string): Promise<string | null> {
  const entry = await db.syncMetadata.where('key').equals(key).first();
  return entry?.value ?? null;
}

/**
 * Get last sync timestamp.
 */
export async function getLastSyncTime(): Promise<number | null> {
  const value = await getSyncMeta('lastSync');
  return value ? parseInt(value, 10) : null;
}

/**
 * Update last sync timestamp.
 */
export async function updateLastSyncTime(): Promise<void> {
  await setSyncMeta('lastSync', Date.now().toString());
}

/**
 * Clear all cached data (for debugging/reset).
 */
export async function clearAllData(): Promise<void> {
  await Promise.all([
    db.suggestions.clear(),
    db.history.clear(),
    db.popularQueries.clear(),
    db.trieNodes.clear(),
    db.syncMetadata.clear(),
  ]);
}

/**
 * Get database statistics.
 */
export async function getDbStats(): Promise<{
  suggestions: number;
  history: number;
  popular: number;
  trieNodes: number;
}> {
  const [suggestions, history, popular, trieNodes] = await Promise.all([
    db.suggestions.count(),
    db.history.count(),
    db.popularQueries.count(),
    db.trieNodes.count(),
  ]);

  return { suggestions, history, popular, trieNodes };
}

/**
 * In-memory LRU cache with TTL expiration.
 * Used as the first layer of caching before IndexedDB and network.
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

class MemoryCache {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private readonly DEFAULT_TTL = 60_000; // 60 seconds
  private readonly MAX_ENTRIES = 1000;

  /**
   * Store a value in the cache with optional TTL.
   * Implements LRU eviction when at capacity.
   */
  set<T>(key: string, data: T, ttl: number = this.DEFAULT_TTL): void {
    // Re-setting a key must move it to the MRU end (Map.set keeps the old position)
    // and must not evict an unrelated entry, since the size does not grow.
    if (!this.cache.delete(key) && this.cache.size >= this.MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }

    this.cache.set(key, { data, timestamp: Date.now(), ttl });
  }

  /**
   * Retrieve a value from the cache.
   * Returns null if not found or expired.
   * Moves accessed items to the end for LRU ordering.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    // Check TTL expiration
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    // Move to end for LRU (delete and re-add)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete a specific key from the cache.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Invalidate all entries with keys starting with the given prefix.
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current cache size.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; maxSize: number; defaultTtl: number } {
    return {
      size: this.cache.size,
      maxSize: this.MAX_ENTRIES,
      defaultTtl: this.DEFAULT_TTL,
    };
  }
}

export const memoryCache = new MemoryCache();

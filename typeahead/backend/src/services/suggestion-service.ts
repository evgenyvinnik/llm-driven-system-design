/**
 * SuggestionService handles fetching and caching suggestions.
 * In a distributed system, this would route to different sharded trie servers.
 * For local development, it uses a single trie with Redis caching.
 */
import type { Redis } from 'ioredis';
import { normalizePhrase, normalizePrefix } from '../data-structures/trie.js';
import type { Trie, Suggestion } from '../data-structures/trie.js';
import type { RankingService, RankedSuggestion } from './ranking-service.js';

export interface SuggestionOptions {
  userId?: string | null;
  limit?: number;
  skipCache?: boolean;
}

export interface FuzzySuggestionOptions extends SuggestionOptions {
  maxDistance?: number;
}

export interface SuggestionResult {
  suggestions: RankedSuggestion[];
  cached: boolean;
}

interface FuzzyMatch extends RankedSuggestion {
  distance: number;
  isFuzzy: boolean;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;
// phrase_counts.phrase is VARCHAR(200): a longer prefix can't match, so skip the trie and cache
const MAX_PREFIX_LENGTH = 200;
// Fuzzy work grows with prefix length; long prefixes aren't worth correcting
const MAX_FUZZY_PREFIX_LENGTH = 50;
// Fuzzy candidates passed to the ranker (each costs Redis lookups)
const FUZZY_CANDIDATES = 20;
// A cache read slower than this is treated as a miss and served from the trie
const CACHE_READ_TIMEOUT_MS = 50;

export class SuggestionService {
  private trie: Trie;
  private redis: Redis;
  private rankingService: RankingService;
  private cachePrefix: string = 'suggestions:';
  // Prefix entries live under their own namespace, so no prefix can collide with the popular key
  private prefixCachePrefix: string = `${this.cachePrefix}prefix:`;
  private popularCacheKey: string = `${this.cachePrefix}popular`;
  private cacheTTL: number = 60; // 1 minute cache

  constructor(trie: Trie, redis: Redis, rankingService: RankingService) {
    this.trie = trie;
    this.redis = redis;
    this.rankingService = rankingService;
  }

  /**
   * Get suggestions for a prefix with caching and ranking.
   */
  async getSuggestions(
    prefix: string,
    options: SuggestionOptions = {}
  ): Promise<RankedSuggestion[]> {
    const { suggestions } = await this.getSuggestionsWithMeta(prefix, options);
    return suggestions;
  }

  /**
   * Get suggestions for a prefix, reporting whether the base list came from the Redis cache.
   */
  async getSuggestionsWithMeta(
    prefix: string,
    options: SuggestionOptions = {}
  ): Promise<SuggestionResult> {
    const { userId = null, skipCache = false } = options;
    const limit = this._normalizeLimit(options.limit);

    // Keeps a trailing space, so "java " completes the next word instead of matching "javascript"
    const normalizedPrefix = normalizePrefix(prefix || '');

    if (normalizedPrefix.length === 0) {
      // Return top popular queries when no prefix
      const { suggestions: popular, cached } = await this._getPopularQueries(limit);
      // Convert Suggestion[] to RankedSuggestion[]
      return {
        suggestions: popular.map((s) => ({
          ...s,
          score: s.count,
          scores: { popularity: s.count, recency: 0, personal: 0, trending: 0, match: 0 },
        })),
        cached,
      };
    }

    if (normalizedPrefix.length > MAX_PREFIX_LENGTH) {
      return { suggestions: [], cached: false };
    }

    const cacheKey = `${this.prefixCachePrefix}${normalizedPrefix}`;

    // Try cache first (unless skipped)
    let baseSuggestions = skipCache ? null : await this._getCached(cacheKey);
    const cached = baseSuggestions !== null;

    if (baseSuggestions === null) {
      // Get from trie, and cache the base suggestions without waiting on Redis
      baseSuggestions = this.trie.getSuggestions(normalizedPrefix);
      void this._cache(cacheKey, baseSuggestions);
    }

    // Apply ranking
    const rankedSuggestions = await this.rankingService.rank(baseSuggestions, {
      userId,
      prefix: normalizedPrefix,
    });

    return { suggestions: rankedSuggestions.slice(0, limit), cached };
  }

  /**
   * Get fuzzy suggestions for typo correction.
   * Exact prefix matches come first; the rest are phrases whose start is within a small
   * edit distance of the prefix, ranked with a penalty per edit.
   */
  async getFuzzySuggestions(
    prefix: string,
    options: FuzzySuggestionOptions = {}
  ): Promise<(RankedSuggestion | FuzzyMatch)[]> {
    const { maxDistance = 2, userId = null } = options;
    const limit = this._normalizeLimit(options.limit);

    // First get exact matches
    const exactMatches = await this.getSuggestions(prefix, { ...options, limit });

    if (exactMatches.length >= limit) {
      return exactMatches;
    }

    // Get fuzzy matches from nearby prefixes
    const fuzzyMatches = await this._getFuzzyMatches(
      normalizePrefix(prefix || ''),
      maxDistance,
      limit,
      userId
    );

    // Merge and deduplicate: exact matches first, then fuzzy matches by score
    const allMatches: (RankedSuggestion | FuzzyMatch)[] = [...exactMatches];
    const seen = new Set(exactMatches.map((m) => m.phrase));
    for (const match of fuzzyMatches) {
      if (!seen.has(match.phrase)) {
        seen.add(match.phrase);
        allMatches.push(match);
      }
    }

    return allMatches.slice(0, limit);
  }

  /**
   * Get fuzzy matches using edit distance.
   */
  private async _getFuzzyMatches(
    normalizedPrefix: string,
    maxDistance: number,
    limit: number,
    userId: string | null
  ): Promise<FuzzyMatch[]> {
    const length = normalizedPrefix.length;
    if (length === 0 || length > MAX_FUZZY_PREFIX_LENGTH) {
      return [];
    }

    // Allow 1 edit for 3-5 characters and 2 beyond that: on shorter prefixes nearly
    // every phrase is within reach, so "corrections" would just be noise
    const lengthBudget = length <= 2 ? 0 : length <= 5 ? 1 : 2;
    const distanceBudget = Math.min(Number.isFinite(maxDistance) ? maxDistance : 2, lengthBudget);
    if (distanceBudget < 1) {
      return [];
    }

    // Distance 0 means an exact prefix match, which getSuggestions already returned
    const candidates = this.trie
      .findFuzzy(normalizedPrefix, distanceBudget)
      .filter((m) => m.distance > 0)
      .sort((a, b) => a.distance - b.distance || b.count - a.count)
      .slice(0, Math.max(limit, FUZZY_CANDIDATES))
      .map((m) => ({ ...m, fuzzyPenalty: m.distance * 0.2 }));

    const ranked = (await this.rankingService.rank(candidates, {
      userId,
      prefix: normalizedPrefix,
    })) as Array<RankedSuggestion & { distance: number }>;

    return ranked.map((m) => ({ ...m, isFuzzy: true }));
  }

  /**
   * Get popular queries when no prefix is provided.
   */
  private async _getPopularQueries(
    limit: number
  ): Promise<{ suggestions: Suggestion[]; cached: boolean }> {
    const cached = await this._getCached(this.popularCacheKey);
    if (cached) {
      return { suggestions: cached.slice(0, limit), cached: true };
    }

    // Get from trie root
    const popular = this.trie.getSuggestions('');
    void this._cache(this.popularCacheKey, popular);

    return { suggestions: popular.slice(0, limit), cached: false };
  }

  /**
   * Whether the Redis client can serve commands now. While it is reconnecting, ioredis
   * queues commands and waits out its retries (seconds), so skip the cache instead.
   */
  private _cacheAvailable(): boolean {
    return !this.redis.status || this.redis.status === 'ready';
  }

  /**
   * Get cached suggestions. Any Redis failure or slow read is a miss, never an error.
   */
  private async _getCached(cacheKey: string): Promise<Suggestion[] | null> {
    if (!this._cacheAvailable()) {
      return null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CACHE_READ_TIMEOUT_MS);
      });
      const cached = await Promise.race([this.redis.get(cacheKey), timeout]);
      if (cached) {
        const parsed: unknown = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          return parsed as Suggestion[];
        }
      }
    } catch (error) {
      console.error('Redis error:', (error as Error).message);
    } finally {
      clearTimeout(timer);
    }

    return null;
  }

  /**
   * Cache suggestions.
   */
  private async _cache(cacheKey: string, suggestions: Suggestion[]): Promise<void> {
    // An empty trie (still loading, or failed to load) would cache [] for every instance
    if (this.trie.size === 0 || !this._cacheAvailable()) {
      return;
    }

    try {
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(suggestions));
    } catch (error) {
      console.error('Redis cache error:', (error as Error).message);
    }
  }

  /**
   * Invalidate every cached list a phrase can appear in: each of its prefixes and the
   * popular list. Call after adding, updating or removing the phrase in the trie.
   */
  async invalidatePhrase(phrase: string): Promise<void> {
    const normalizedPhrase = normalizePhrase(phrase || '');
    if (normalizedPhrase.length === 0 || !this._cacheAvailable()) {
      return;
    }

    const keys = [this.popularCacheKey];
    let prefix = '';
    for (const char of normalizedPhrase) {
      prefix += char;
      if (prefix.length > MAX_PREFIX_LENGTH) break; // longer prefixes are never cached
      keys.push(`${this.prefixCachePrefix}${prefix}`);
    }

    try {
      await this.redis.del(...keys);
    } catch (error) {
      console.error('Redis invalidate error:', (error as Error).message);
    }
  }

  /**
   * Clear cache for a prefix and every longer prefix starting with it, or all suggestion
   * caches when no prefix is given (call when trie is updated).
   */
  async clearCache(prefix: string | null = null): Promise<void> {
    if (!this._cacheAvailable()) {
      console.error('Redis clear cache skipped: Redis not ready');
      return;
    }

    try {
      if (prefix) {
        // Escape glob characters so the prefix is matched literally
        const pattern = normalizePrefix(prefix).replace(/[*?[\]\\]/g, '\\$&');
        await this._deleteMatching(`${this.prefixCachePrefix}${pattern}*`);
      } else {
        // Clear all suggestion caches
        await this._deleteMatching(`${this.cachePrefix}*`);
      }
    } catch (error) {
      console.error('Redis clear cache error:', (error as Error).message);
    }
  }

  /**
   * Delete keys matching a pattern with SCAN, which doesn't block Redis like KEYS.
   */
  private async _deleteMatching(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      cursor = next;
    } while (cursor !== '0');
  }

  /**
   * Coerce limit to an integer in [1, MAX_LIMIT]; anything non-numeric gets the default.
   */
  private _normalizeLimit(limit: number | undefined): number {
    const n = Math.floor(Number(limit));
    if (!Number.isFinite(n)) {
      return DEFAULT_LIMIT;
    }
    return Math.min(Math.max(n, 1), MAX_LIMIT);
  }

  /**
   * Get shard ID for a prefix (for distributed deployment).
   * In a real system, this would route to different trie servers.
   */
  static getShardForPrefix(prefix: string, totalShards: number): number {
    if (!prefix || prefix.length === 0) {
      return 0;
    }
    const firstChar = prefix.charAt(0).toLowerCase();
    return firstChar.charCodeAt(0) % totalShards;
  }
}

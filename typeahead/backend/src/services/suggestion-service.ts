/**
 * SuggestionService handles fetching and caching suggestions.
 * In a distributed system, this would route to different sharded trie servers.
 * For local development, it uses a single trie with Redis caching.
 */
export class SuggestionService {
  constructor(trie, redis, rankingService) {
    this.trie = trie;
    this.redis = redis;
    this.rankingService = rankingService;
    this.cachePrefix = 'suggestions:';
    this.cacheTTL = 60; // 1 minute cache
  }

  /**
   * Get suggestions for a prefix with caching and ranking.
   * @param {string} prefix - The search prefix
   * @param {object} options - Options: userId, limit, skipCache
   * @returns {Promise<Array>} Ranked suggestions
   */
  async getSuggestions(prefix, options = {}) {
    const { userId = null, limit = 5, skipCache = false } = options;

    if (!prefix || prefix.trim().length === 0) {
      // Return top popular queries when no prefix
      return this._getPopularQueries(limit);
    }

    const normalizedPrefix = prefix.toLowerCase().trim();

    // Try cache first (unless skipped)
    if (!skipCache) {
      const cached = await this._getCached(normalizedPrefix);
      if (cached) {
        const rankedSuggestions = await this.rankingService.rank(
          cached,
          { userId, prefix: normalizedPrefix }
        );
        return rankedSuggestions.slice(0, limit);
      }
    }

    // Get from trie
    const baseSuggestions = this.trie.getSuggestions(normalizedPrefix);

    // Cache the base suggestions
    await this._cache(normalizedPrefix, baseSuggestions);

    // Apply ranking
    const rankedSuggestions = await this.rankingService.rank(
      baseSuggestions,
      { userId, prefix: normalizedPrefix }
    );

    return rankedSuggestions.slice(0, limit);
  }

  /**
   * Get fuzzy suggestions for typo correction.
   * Uses Levenshtein distance to find close matches.
   */
  async getFuzzySuggestions(prefix, options = {}) {
    const { maxDistance = 2, limit = 5 } = options;

    // First get exact matches
    const exactMatches = await this.getSuggestions(prefix, options);

    if (exactMatches.length >= limit) {
      return exactMatches;
    }

    // Get fuzzy matches from nearby prefixes
    const fuzzyMatches = await this._getFuzzyMatches(prefix, maxDistance);

    // Merge and deduplicate
    const allMatches = [...exactMatches];
    for (const match of fuzzyMatches) {
      if (!allMatches.some(m => m.phrase === match.phrase)) {
        allMatches.push({
          ...match,
          isFuzzy: true,
        });
      }
    }

    // Sort by score (exact matches first, then fuzzy by count)
    allMatches.sort((a, b) => {
      if (a.isFuzzy && !b.isFuzzy) return 1;
      if (!a.isFuzzy && b.isFuzzy) return -1;
      return (b.score || b.count) - (a.score || a.count);
    });

    return allMatches.slice(0, limit);
  }

  /**
   * Get fuzzy matches using edit distance.
   */
  async _getFuzzyMatches(prefix, maxDistance) {
    const normalizedPrefix = prefix.toLowerCase().trim();
    const fuzzyMatches = [];

    // Generate variations with 1-character edits
    const variations = this._generateEditVariations(normalizedPrefix);

    for (const variation of variations) {
      const suggestions = this.trie.getSuggestions(variation);
      for (const suggestion of suggestions) {
        const distance = this._levenshteinDistance(
          normalizedPrefix,
          suggestion.phrase.slice(0, normalizedPrefix.length + maxDistance)
        );

        if (distance <= maxDistance && distance > 0) {
          fuzzyMatches.push({
            ...suggestion,
            distance,
            fuzzyPenalty: distance * 0.2,
          });
        }
      }
    }

    // Deduplicate and sort by count
    const seen = new Set();
    return fuzzyMatches
      .filter(m => {
        if (seen.has(m.phrase)) return false;
        seen.add(m.phrase);
        return true;
      })
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Generate single-character edit variations of a prefix.
   */
  _generateEditVariations(prefix) {
    const variations = new Set();
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 ';

    // Deletions
    for (let i = 0; i < prefix.length; i++) {
      variations.add(prefix.slice(0, i) + prefix.slice(i + 1));
    }

    // Substitutions
    for (let i = 0; i < prefix.length; i++) {
      for (const char of chars) {
        variations.add(prefix.slice(0, i) + char + prefix.slice(i + 1));
      }
    }

    // Insertions (only at end to limit variations)
    for (const char of chars) {
      variations.add(prefix + char);
    }

    return Array.from(variations).filter(v => v.length > 0);
  }

  /**
   * Calculate Levenshtein distance between two strings.
   */
  _levenshteinDistance(s1, s2) {
    const m = s1.length;
    const n = s2.length;

    if (m === 0) return n;
    if (n === 0) return m;
    if (s1 === s2) return 0;

    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(
            dp[i - 1][j],     // deletion
            dp[i][j - 1],     // insertion
            dp[i - 1][j - 1]  // substitution
          );
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Get popular queries when no prefix is provided.
   */
  async _getPopularQueries(limit) {
    const cacheKey = `${this.cachePrefix}popular`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached).slice(0, limit);
      }
    } catch (error) {
      console.error('Redis error:', error.message);
    }

    // Get from trie root
    const popular = this.trie.getSuggestions('');

    try {
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(popular));
    } catch (error) {
      console.error('Redis cache error:', error.message);
    }

    return popular.slice(0, limit);
  }

  /**
   * Get cached suggestions.
   */
  async _getCached(prefix) {
    const cacheKey = `${this.cachePrefix}${prefix}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.error('Redis error:', error.message);
    }

    return null;
  }

  /**
   * Cache suggestions.
   */
  async _cache(prefix, suggestions) {
    const cacheKey = `${this.cachePrefix}${prefix}`;

    try {
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(suggestions));
    } catch (error) {
      console.error('Redis cache error:', error.message);
    }
  }

  /**
   * Clear cache for a prefix (call when trie is updated).
   */
  async clearCache(prefix = null) {
    try {
      if (prefix) {
        await this.redis.del(`${this.cachePrefix}${prefix}`);
      } else {
        // Clear all suggestion caches
        const keys = await this.redis.keys(`${this.cachePrefix}*`);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      }
    } catch (error) {
      console.error('Redis clear cache error:', error.message);
    }
  }

  /**
   * Get shard ID for a prefix (for distributed deployment).
   * In a real system, this would route to different trie servers.
   */
  static getShardForPrefix(prefix, totalShards) {
    if (!prefix || prefix.length === 0) {
      return 0;
    }
    const firstChar = prefix.charAt(0).toLowerCase();
    return firstChar.charCodeAt(0) % totalShards;
  }
}

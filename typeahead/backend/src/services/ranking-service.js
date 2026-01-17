/**
 * RankingService implements multi-factor scoring for suggestions.
 * Combines popularity, recency, personalization, and trending signals.
 */
export class RankingService {
  constructor(redis) {
    this.redis = redis;
  }

  /**
   * Rank suggestions using multiple scoring factors.
   * @param {Array} suggestions - Base suggestions with phrase and count
   * @param {object} context - Ranking context: userId, prefix, deviceType
   * @returns {Promise<Array>} Ranked suggestions with scores
   */
  async rank(suggestions, context = {}) {
    const { userId = null, prefix = '' } = context;

    if (!suggestions || suggestions.length === 0) {
      return [];
    }

    const scored = await Promise.all(
      suggestions.map(async (suggestion) => {
        // Base popularity score (logarithmic scaling)
        const popularityScore = this._calculatePopularityScore(suggestion.count);

        // Recency score (decay older queries)
        const recencyScore = this._calculateRecencyScore(suggestion.lastUpdated);

        // Personalization score (user history)
        let personalScore = 0;
        if (userId) {
          personalScore = await this._getPersonalScore(userId, suggestion.phrase);
        }

        // Trending boost
        const trendingBoost = await this._getTrendingBoost(suggestion.phrase);

        // Prefix match quality (exact match vs partial)
        const matchQuality = this._calculateMatchQuality(prefix, suggestion.phrase);

        // Apply fuzzy penalty if present
        const fuzzyPenalty = suggestion.fuzzyPenalty || 0;

        // Combine scores with weights
        const finalScore =
          popularityScore * 0.3 +
          recencyScore * 0.15 +
          personalScore * 0.25 +
          trendingBoost * 0.2 +
          matchQuality * 0.1 -
          fuzzyPenalty;

        return {
          ...suggestion,
          score: Math.max(0, finalScore),
          scores: {
            popularity: popularityScore,
            recency: recencyScore,
            personal: personalScore,
            trending: trendingBoost,
            match: matchQuality,
          },
        };
      })
    );

    // Sort by final score descending
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }

  /**
   * Calculate popularity score using logarithmic scaling.
   * This prevents very popular queries from completely dominating.
   */
  _calculatePopularityScore(count) {
    if (!count || count <= 0) return 0;
    // Log10 scaling, normalized to 0-1 range (assuming max ~1B queries)
    return Math.log10(count + 1) / 9; // log10(1B) ≈ 9
  }

  /**
   * Calculate recency score with exponential decay.
   * More recent updates get higher scores.
   */
  _calculateRecencyScore(lastUpdated) {
    if (!lastUpdated) return 0.5; // Default if no timestamp

    const ageInHours = (Date.now() - lastUpdated) / (1000 * 60 * 60);

    // Exponential decay with half-life of 1 week (168 hours)
    return Math.exp(-ageInHours / 168);
  }

  /**
   * Calculate match quality between prefix and phrase.
   * Rewards exact prefix matches and word boundary matches.
   */
  _calculateMatchQuality(prefix, phrase) {
    if (!prefix || !phrase) return 0;

    const lowerPrefix = prefix.toLowerCase();
    const lowerPhrase = phrase.toLowerCase();

    // Exact start match is best
    if (lowerPhrase.startsWith(lowerPrefix)) {
      // Bonus for shorter phrases (more specific match)
      const lengthRatio = lowerPrefix.length / lowerPhrase.length;
      return 0.8 + lengthRatio * 0.2;
    }

    // Word boundary match is good
    if (lowerPhrase.includes(' ' + lowerPrefix)) {
      return 0.7;
    }

    // Substring match
    if (lowerPhrase.includes(lowerPrefix)) {
      return 0.4;
    }

    return 0;
  }

  /**
   * Get personalization score based on user history.
   */
  async _getPersonalScore(userId, phrase) {
    if (!userId) return 0;

    try {
      const historyKey = `user_history:${userId}`;
      const userHistory = await this.redis.get(historyKey);

      if (!userHistory) return 0;

      const history = JSON.parse(userHistory);
      const match = history.find(h => h.phrase.toLowerCase() === phrase.toLowerCase());

      if (match) {
        // Recency-weighted personal score
        const daysSince = (Date.now() - match.timestamp) / (1000 * 60 * 60 * 24);
        // Higher score for more recent searches, with 30-day decay
        const recencyWeight = Math.exp(-daysSince / 30);
        // Also factor in how many times they've searched this
        const frequencyWeight = Math.min(match.count / 10, 1);

        return (recencyWeight * 0.7 + frequencyWeight * 0.3);
      }
    } catch (error) {
      console.error('Error getting personal score:', error.message);
    }

    return 0;
  }

  /**
   * Get trending boost for a phrase.
   */
  async _getTrendingBoost(phrase) {
    try {
      const score = await this.redis.zscore('trending_queries', phrase.toLowerCase());

      if (!score) return 0;

      // Normalize trending score (assuming max score of ~1000)
      return Math.min(parseFloat(score) / 1000, 1.0);
    } catch (error) {
      console.error('Error getting trending boost:', error.message);
      return 0;
    }
  }

  /**
   * Record a user's search for personalization.
   */
  async recordUserSearch(userId, phrase) {
    if (!userId || !phrase) return;

    try {
      const historyKey = `user_history:${userId}`;
      const maxHistorySize = 100;

      // Get existing history
      let history = [];
      const existing = await this.redis.get(historyKey);
      if (existing) {
        history = JSON.parse(existing);
      }

      // Update or add the phrase
      const existingIndex = history.findIndex(
        h => h.phrase.toLowerCase() === phrase.toLowerCase()
      );

      if (existingIndex !== -1) {
        history[existingIndex].count++;
        history[existingIndex].timestamp = Date.now();
      } else {
        history.unshift({
          phrase: phrase.toLowerCase(),
          count: 1,
          timestamp: Date.now(),
        });
      }

      // Trim to max size
      history = history.slice(0, maxHistorySize);

      // Save with 90-day expiration
      await this.redis.setex(historyKey, 90 * 24 * 60 * 60, JSON.stringify(history));
    } catch (error) {
      console.error('Error recording user search:', error.message);
    }
  }

  /**
   * Get user's search history.
   */
  async getUserHistory(userId, limit = 10) {
    if (!userId) return [];

    try {
      const historyKey = `user_history:${userId}`;
      const existing = await this.redis.get(historyKey);

      if (!existing) return [];

      const history = JSON.parse(existing);
      return history.slice(0, limit);
    } catch (error) {
      console.error('Error getting user history:', error.message);
      return [];
    }
  }

  /**
   * Update trending scores for a phrase.
   */
  async updateTrending(phrase, increment = 1) {
    if (!phrase) return;

    try {
      const normalizedPhrase = phrase.toLowerCase().trim();

      // Increment score in trending sorted set
      await this.redis.zincrby('trending_queries', increment, normalizedPhrase);

      // Set expiration if not already set (expire trending data after 24 hours of inactivity)
      // Note: EXPIRE on sorted set will expire the whole set, not individual members
      // For production, use time-windowed keys instead
    } catch (error) {
      console.error('Error updating trending:', error.message);
    }
  }

  /**
   * Get top trending queries.
   */
  async getTopTrending(limit = 10) {
    try {
      const trending = await this.redis.zrevrange('trending_queries', 0, limit - 1, 'WITHSCORES');

      const results = [];
      for (let i = 0; i < trending.length; i += 2) {
        results.push({
          phrase: trending[i],
          score: parseFloat(trending[i + 1]),
        });
      }

      return results;
    } catch (error) {
      console.error('Error getting trending:', error.message);
      return [];
    }
  }

  /**
   * Decay trending scores periodically.
   * Call this on a schedule (e.g., every hour).
   */
  async decayTrendingScores(decayFactor = 0.9) {
    try {
      const trending = await this.redis.zrange('trending_queries', 0, -1, 'WITHSCORES');

      const pipeline = this.redis.pipeline();
      for (let i = 0; i < trending.length; i += 2) {
        const phrase = trending[i];
        const score = parseFloat(trending[i + 1]) * decayFactor;

        if (score < 0.1) {
          // Remove if score too low
          pipeline.zrem('trending_queries', phrase);
        } else {
          pipeline.zadd('trending_queries', score, phrase);
        }
      }

      await pipeline.exec();
    } catch (error) {
      console.error('Error decaying trending:', error.message);
    }
  }
}

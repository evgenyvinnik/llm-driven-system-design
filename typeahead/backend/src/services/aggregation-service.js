/**
 * AggregationService processes query logs and updates the trie.
 * Implements buffered writes and periodic flushing for efficiency.
 */
export class AggregationService {
  constructor(redis, pgPool, trie) {
    this.redis = redis;
    this.pgPool = pgPool;
    this.trie = trie;
    this.buffer = new Map(); // phrase -> { count, timestamps }
    this.flushInterval = 30000; // 30 seconds
    this.flushTimer = null;
    this.trendingDecayTimer = null;
    this.isRunning = false;
  }

  /**
   * Start the aggregation service.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Periodic flush to database and trie
    this.flushTimer = setInterval(() => this.flush(), this.flushInterval);

    // Periodic trending decay (every hour)
    this.trendingDecayTimer = setInterval(
      () => this.decayTrending(),
      60 * 60 * 1000
    );

    console.log('Aggregation service started');
  }

  /**
   * Stop the aggregation service.
   */
  stop() {
    this.isRunning = false;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.trendingDecayTimer) {
      clearInterval(this.trendingDecayTimer);
      this.trendingDecayTimer = null;
    }

    // Final flush
    this.flush();
    console.log('Aggregation service stopped');
  }

  /**
   * Process a search query.
   * @param {string} query - The search query
   * @param {string} userId - Optional user ID
   * @param {string} sessionId - Optional session ID
   */
  async processQuery(query, userId = null, sessionId = null) {
    if (!query || typeof query !== 'string') return;

    const normalizedQuery = query.toLowerCase().trim();

    // Filter low-quality queries
    if (this.isLowQuality(normalizedQuery)) {
      return;
    }

    // Filter inappropriate content
    if (await this.isInappropriate(normalizedQuery)) {
      return;
    }

    // Update buffer
    if (!this.buffer.has(normalizedQuery)) {
      this.buffer.set(normalizedQuery, { count: 0, firstSeen: Date.now() });
    }
    const entry = this.buffer.get(normalizedQuery);
    entry.count++;
    entry.lastSeen = Date.now();

    // Update trending in real-time
    await this.updateTrending(normalizedQuery);

    // Log to PostgreSQL (async, non-blocking)
    this.logQuery(normalizedQuery, userId, sessionId).catch(err => {
      console.error('Error logging query:', err.message);
    });
  }

  /**
   * Check if a query is low quality.
   */
  isLowQuality(query) {
    // Too short
    if (query.length < 2) return true;

    // Too long
    if (query.length > 100) return true;

    // Mostly numbers
    if (/^\d+$/.test(query)) return true;

    // Random characters (keyboard smash detection)
    if (/^[asdfghjklqwertyuiopzxcvbnm]{10,}$/i.test(query)) return true;

    // Excessive repeated characters
    if (/(.)\1{4,}/.test(query)) return true;

    return false;
  }

  /**
   * Check if a query contains inappropriate content.
   */
  async isInappropriate(query) {
    try {
      // Check against filtered phrases in database
      const result = await this.pgPool.query(
        'SELECT 1 FROM filtered_phrases WHERE phrase = $1',
        [query]
      );

      if (result.rows.length > 0) {
        return true;
      }

      // Check Redis cache for blocked phrases
      const blocked = await this.redis.sismember('blocked_phrases', query);
      if (blocked) {
        return true;
      }
    } catch (error) {
      console.error('Error checking inappropriate:', error.message);
    }

    return false;
  }

  /**
   * Update trending scores for real-time trending.
   */
  async updateTrending(query) {
    try {
      // Use sliding window counters
      const now = Date.now();
      const windowKey = `trending_window:${Math.floor(now / 300000)}`; // 5-min windows

      await this.redis.zincrby(windowKey, 1, query);
      await this.redis.expire(windowKey, 3600); // Keep 1 hour of windows

      // Aggregate recent windows periodically (done in flush)
    } catch (error) {
      console.error('Error updating trending:', error.message);
    }
  }

  /**
   * Log query to PostgreSQL for analytics.
   */
  async logQuery(query, userId, sessionId) {
    try {
      await this.pgPool.query(
        `INSERT INTO query_logs (query, user_id, session_id, timestamp)
         VALUES ($1, $2, $3, NOW())`,
        [query, userId, sessionId]
      );
    } catch (error) {
      console.error('Error logging query:', error.message);
    }
  }

  /**
   * Flush buffer to database and update trie.
   */
  async flush() {
    if (this.buffer.size === 0) return;

    const updates = Array.from(this.buffer.entries());
    this.buffer.clear();

    console.log(`Flushing ${updates.length} phrase updates...`);

    for (const [phrase, { count }] of updates) {
      try {
        // Upsert to database
        await this.pgPool.query(
          `INSERT INTO phrase_counts (phrase, count, last_updated)
           VALUES ($1, $2, NOW())
           ON CONFLICT (phrase)
           DO UPDATE SET count = phrase_counts.count + $2, last_updated = NOW()`,
          [phrase, count]
        );

        // Update trie
        this.trie.incrementCount(phrase, count);
      } catch (error) {
        console.error(`Error flushing phrase "${phrase}":`, error.message);
      }
    }

    // Aggregate trending windows
    await this.aggregateTrendingWindows();

    console.log('Flush complete');
  }

  /**
   * Aggregate recent trending windows into main trending set.
   */
  async aggregateTrendingWindows() {
    try {
      const now = Date.now();
      const recentWindows = [];

      // Get last 12 windows (1 hour of 5-minute windows)
      for (let i = 0; i < 12; i++) {
        const windowKey = `trending_window:${Math.floor((now - i * 300000) / 300000)}`;
        recentWindows.push(windowKey);
      }

      // Check which windows exist
      const existingWindows = [];
      for (const key of recentWindows) {
        const exists = await this.redis.exists(key);
        if (exists) {
          existingWindows.push(key);
        }
      }

      if (existingWindows.length > 0) {
        // Union all windows into trending_queries
        await this.redis.zunionstore(
          'trending_queries',
          existingWindows.length,
          ...existingWindows,
          'WEIGHTS',
          ...existingWindows.map((_, i) => Math.pow(0.9, i)) // More recent windows have higher weight
        );
      }
    } catch (error) {
      console.error('Error aggregating trending:', error.message);
    }
  }

  /**
   * Decay trending scores over time.
   */
  async decayTrending() {
    try {
      const trending = await this.redis.zrange('trending_queries', 0, -1, 'WITHSCORES');

      if (trending.length === 0) return;

      const pipeline = this.redis.pipeline();
      for (let i = 0; i < trending.length; i += 2) {
        const phrase = trending[i];
        const score = parseFloat(trending[i + 1]) * 0.9; // 10% decay

        if (score < 0.1) {
          pipeline.zrem('trending_queries', phrase);
        } else {
          pipeline.zadd('trending_queries', score, phrase);
        }
      }

      await pipeline.exec();
      console.log('Trending decay complete');
    } catch (error) {
      console.error('Error decaying trending:', error.message);
    }
  }

  /**
   * Rebuild the entire trie from database.
   */
  async rebuildTrie() {
    console.log('Rebuilding trie from database...');

    try {
      const result = await this.pgPool.query(
        `SELECT phrase, count FROM phrase_counts
         WHERE is_filtered = false
         ORDER BY count DESC
         LIMIT 100000`
      );

      // Clear and rebuild
      this.trie.root = { children: new Map(), suggestions: [] };
      this.trie.size = 0;
      this.trie.phraseMap.clear();

      for (const row of result.rows) {
        this.trie.insert(row.phrase, parseInt(row.count));
      }

      console.log(`Trie rebuilt with ${this.trie.size} phrases`);

      // Clear suggestion cache
      const keys = await this.redis.keys('suggestions:*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      console.error('Error rebuilding trie:', error.message);
      throw error;
    }
  }

  /**
   * Get aggregation stats.
   */
  getStats() {
    return {
      bufferSize: this.buffer.size,
      isRunning: this.isRunning,
      flushInterval: this.flushInterval,
    };
  }
}

/**
 * RankingService implements multi-factor scoring for suggestions.
 * Combines popularity, recency, personalization, and trending signals.
 */
import type { Redis } from 'ioredis';
import type { Suggestion } from '../data-structures/trie.js';

export interface RankingContext {
  userId?: string | null;
  prefix?: string;
}

export interface RankedSuggestion extends Suggestion {
  score: number;
  scores: {
    popularity: number;
    recency: number;
    personal: number;
    trending: number;
    match: number;
  };
  fuzzyPenalty?: number;
}

interface UserHistoryEntry {
  phrase: string;
  count: number;
  timestamp: number;
}

interface TrendingResult {
  phrase: string;
  score: number;
}

/**
 * Longest ranking waits on Redis before degrading a signal to 0. Well under the
 * suggestions circuit breaker's 100ms budget; a healthy local round trip is ~1ms.
 */
const REDIS_TIMEOUT_MS = 30;

const MAX_HISTORY_SIZE = 100;
const HISTORY_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Atomically record a search in the user's history blob (a JSON array, most recent
 * first). Doing the read-modify-write inside Redis means concurrent /log calls for
 * one user can't overwrite each other's entries or count increments.
 * KEYS[1] = history key; ARGV = normalized phrase, timestamp (ms), max size, TTL (s).
 */
const RECORD_HISTORY_SCRIPT = `
local history = {}
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then history = decoded end
end
local count = 0
local updated = {}
for _, entry in ipairs(history) do
  if type(entry) == 'table' and type(entry.phrase) == 'string' then
    if entry.phrase:lower():match('^%s*(.-)%s*$') == ARGV[1] then
      count = count + (tonumber(entry.count) or 0)
    else
      updated[#updated + 1] = entry
    end
  end
end
-- Move the phrase to the front so eviction drops the least recently searched phrase
table.insert(updated, 1, { phrase = ARGV[1], count = count + 1, timestamp = tonumber(ARGV[2]) })
for i = #updated, tonumber(ARGV[3]) + 1, -1 do updated[i] = nil end
redis.call('SET', KEYS[1], cjson.encode(updated), 'EX', ARGV[4])
return count + 1
`;

/** Same normalization the trie and AggregationService apply to phrases. */
function normalizePhrase(phrase: string): string {
  return phrase.toLowerCase().trim();
}

export class RankingService {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Run a Redis call, failing fast when the client isn't connected or the call stalls.
   * ioredis would otherwise queue the command offline and wait out its reconnect
   * retries (seconds), so a Redis outage would time out the whole request instead of
   * just dropping the personal/trending signals.
   */
  private async _withRedis<T>(call: () => Promise<T>): Promise<T> {
    if (this.redis.status !== 'ready') {
      throw new Error(`Redis not ready (status: ${this.redis.status})`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Redis call timed out after ${REDIS_TIMEOUT_MS}ms`)),
        REDIS_TIMEOUT_MS
      );
    });

    try {
      return await Promise.race([call(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Rank suggestions using multiple scoring factors.
   */
  async rank(suggestions: Suggestion[], context: RankingContext = {}): Promise<RankedSuggestion[]> {
    const { userId = null, prefix = '' } = context;

    if (!suggestions || suggestions.length === 0) {
      return [];
    }

    const scored = await Promise.all(
      suggestions.map(async (suggestion): Promise<RankedSuggestion> => {
        // Base popularity score (logarithmic scaling)
        const popularityScore = this._calculatePopularityScore(suggestion.count);

        // Recency score (decay older queries)
        const recencyScore = this._calculateRecencyScore(suggestion.lastUpdated);

        // Personalization score (user history) and trending boost, fetched in parallel
        // so a slow Redis costs at most one REDIS_TIMEOUT_MS
        const [personalScore, trendingBoost] = await Promise.all([
          userId ? this._getPersonalScore(userId, suggestion.phrase) : 0,
          this._getTrendingBoost(suggestion.phrase),
        ]);

        // Prefix match quality (exact match vs partial)
        const matchQuality = this._calculateMatchQuality(prefix, suggestion.phrase);

        // Apply fuzzy penalty if present
        const fuzzyPenalty = (suggestion as Suggestion & { fuzzyPenalty?: number }).fuzzyPenalty || 0;

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
  private _calculatePopularityScore(count: number): number {
    if (!count || count <= 0) return 0;
    // Log10 scaling, normalized to 0-1 range (assuming max ~1B queries)
    return Math.log10(count + 1) / 9; // log10(1B) ≈ 9
  }

  /**
   * Calculate recency score with exponential decay.
   * More recent updates get higher scores.
   * lastUpdated is epoch ms of the phrase's last count change (phrase_counts.last_updated).
   */
  private _calculateRecencyScore(lastUpdated: number | undefined): number {
    // Number() also accepts a numeric string (pg returns EXTRACT(EPOCH ...) as numeric)
    const timestamp = Number(lastUpdated);
    if (!lastUpdated || !Number.isFinite(timestamp) || timestamp <= 0) return 0.5; // Default if no timestamp

    // Clamp so a timestamp in the future (clock skew) can't score above 1
    const ageInHours = Math.max(0, Date.now() - timestamp) / (1000 * 60 * 60);

    // Exponential decay with a 1-week (168 hour) time constant, i.e. a half-life of ~116 hours
    return Math.exp(-ageInHours / 168);
  }

  /**
   * Calculate match quality between prefix and phrase.
   * Rewards exact prefix matches and word boundary matches.
   */
  private _calculateMatchQuality(prefix: string, phrase: string): number {
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
  private async _getPersonalScore(userId: string, phrase: string): Promise<number> {
    if (!userId) return 0;

    try {
      const historyKey = `user_history:${userId}`;
      const userHistory = await this._withRedis(() => this.redis.get(historyKey));

      if (!userHistory) return 0;

      const history: UserHistoryEntry[] = JSON.parse(userHistory);
      const normalizedPhrase = normalizePhrase(phrase);
      const match = history.find((h) => normalizePhrase(h.phrase) === normalizedPhrase);

      if (match) {
        // Recency-weighted personal score
        const daysSince = (Date.now() - match.timestamp) / (1000 * 60 * 60 * 24);
        // Higher score for more recent searches, with 30-day decay
        const recencyWeight = Math.exp(-daysSince / 30);
        // Also factor in how many times they've searched this
        const frequencyWeight = Math.min(match.count / 10, 1);

        return recencyWeight * 0.7 + frequencyWeight * 0.3;
      }
    } catch (error) {
      console.error('Error getting personal score:', (error as Error).message);
    }

    return 0;
  }

  /**
   * Get trending boost for a phrase.
   */
  private async _getTrendingBoost(phrase: string): Promise<number> {
    try {
      const score = await this._withRedis(() =>
        this.redis.zscore('trending_queries', normalizePhrase(phrase))
      );

      if (!score) return 0;

      // Normalize trending score (assuming max score of ~1000)
      return Math.min(parseFloat(score) / 1000, 1.0);
    } catch (error) {
      console.error('Error getting trending boost:', (error as Error).message);
      return 0;
    }
  }

  /**
   * Record a user's search for personalization.
   * The phrase moves to the front of the history (most recent first) with its count
   * incremented; the least recently searched phrase is evicted past MAX_HISTORY_SIZE.
   */
  async recordUserSearch(userId: string, phrase: string): Promise<void> {
    if (!userId || !phrase) return;

    const normalizedPhrase = normalizePhrase(phrase);
    if (!normalizedPhrase) return;

    try {
      const historyKey = `user_history:${userId}`;

      // Read-modify-write runs atomically in Redis; saved with 90-day expiration
      await this._withRedis(() =>
        this.redis.eval(
          RECORD_HISTORY_SCRIPT,
          1,
          historyKey,
          normalizedPhrase,
          Date.now(),
          MAX_HISTORY_SIZE,
          HISTORY_TTL_SECONDS
        )
      );
    } catch (error) {
      console.error('Error recording user search:', (error as Error).message);
    }
  }

  /**
   * Get user's search history.
   */
  async getUserHistory(userId: string, limit: number = 10): Promise<UserHistoryEntry[]> {
    if (!userId) return [];

    try {
      const historyKey = `user_history:${userId}`;
      const existing = await this._withRedis(() => this.redis.get(historyKey));

      if (!existing) return [];

      const history: UserHistoryEntry[] = JSON.parse(existing);
      return history.slice(0, limit);
    } catch (error) {
      console.error('Error getting user history:', (error as Error).message);
      return [];
    }
  }

  /**
   * Update trending scores for a phrase.
   */
  async updateTrending(phrase: string, increment: number = 1): Promise<void> {
    if (!phrase) return;

    try {
      const normalizedPhrase = phrase.toLowerCase().trim();

      // Increment score in trending sorted set
      await this.redis.zincrby('trending_queries', increment, normalizedPhrase);

      // Set expiration if not already set (expire trending data after 24 hours of inactivity)
      // Note: EXPIRE on sorted set will expire the whole set, not individual members
      // For production, use time-windowed keys instead
    } catch (error) {
      console.error('Error updating trending:', (error as Error).message);
    }
  }

  /**
   * Get top trending queries.
   */
  async getTopTrending(limit: number = 10): Promise<TrendingResult[]> {
    try {
      const trending = await this._withRedis(() =>
        this.redis.zrevrange('trending_queries', 0, limit - 1, 'WITHSCORES')
      );

      const results: TrendingResult[] = [];
      for (let i = 0; i < trending.length; i += 2) {
        results.push({
          phrase: trending[i],
          score: parseFloat(trending[i + 1]),
        });
      }

      return results;
    } catch (error) {
      console.error('Error getting trending:', (error as Error).message);
      return [];
    }
  }

  /**
   * Decay trending scores periodically.
   * Call this on a schedule (e.g., every hour).
   */
  async decayTrendingScores(decayFactor: number = 0.9): Promise<void> {
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
      console.error('Error decaying trending:', (error as Error).message);
    }
  }
}

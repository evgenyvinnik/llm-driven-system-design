# Typeahead - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design a typeahead/autocomplete system that provides instant search suggestions as users type. The core challenge is achieving sub-50ms latency for prefix matching across billions of possible queries while balancing popularity, personalization, and trending topics in the ranking.

This involves three key technical challenges: building a trie data structure with pre-computed top-k suggestions at each node, designing a sharded serving layer that can handle 100k+ QPS, and implementing a real-time data pipeline that surfaces trending queries within minutes."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Suggest**: Return top suggestions for any prefix
- **Rank**: Order by relevance (popularity, recency, personalization)
- **Personalize**: User-specific suggestion boosting
- **Update**: Reflect trending topics in near real-time
- **Filter**: Remove inappropriate or blocked content

### Non-Functional Requirements
- **Latency**: < 50ms P99
- **Availability**: 99.99%
- **Scale**: 100K+ QPS
- **Freshness**: Trending within 5 minutes

### Scale Estimates
- **Unique queries**: 1 billion
- **QPS at peak**: 100,000+
- **Suggestions per request**: 5-10
- **Index update frequency**: Every minute

### Key Questions I'd Ask
1. How important is personalization vs. global popularity?
2. What's the acceptable staleness for trending boosts?
3. Should we support fuzzy matching (typo correction)?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│              Search Box | Mobile App | API                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│               (Load Balancing, Caching)                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Suggestion Service                             │
│         (Prefix Matching, Ranking, Personalization)             │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Trie Servers │    │Ranking Service│    │   User Data   │
│               │    │               │    │               │
│ - Prefix match│    │ - Score calc  │    │ - History     │
│ - Sharded     │    │ - Trending    │    │ - Preferences │
└───────────────┘    └───────────────┘    └───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Aggregation Pipeline                          │
│          Query Logs → Count → Filter → Trie Build              │
└─────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Trie Servers**: Prefix matching with pre-computed top-k
2. **Suggestion Service**: Orchestrates trie lookup, ranking, personalization
3. **Ranking Service**: Multi-factor scoring (popularity, recency, trending)
4. **Aggregation Pipeline**: Processes query logs, updates trie data

## Deep Dive: Trie with Pre-computed Top-K (8 minutes)

This is the key data structure enabling sub-50ms latency.

### Trie Implementation

```javascript
class TrieNode {
  constructor() {
    this.children = new Map();   // Character -> TrieNode
    this.isEndOfWord = false;
    this.suggestions = [];        // Pre-computed top-k at this prefix
    this.count = 0;
  }
}

class Trie {
  constructor(topK = 10) {
    this.root = new TrieNode();
    this.topK = topK;
  }

  insert(phrase, count) {
    let node = this.root;

    for (const char of phrase.toLowerCase()) {
      if (!node.children.has(char)) {
        node.children.set(char, new TrieNode());
      }
      node = node.children.get(char);

      // Update top-k suggestions at each prefix node
      this.updateSuggestions(node, phrase, count);
    }

    node.isEndOfWord = true;
    node.count = count;
  }

  updateSuggestions(node, phrase, count) {
    // Add or update this phrase in suggestions
    const existing = node.suggestions.find(s => s.phrase === phrase);
    if (existing) {
      existing.count = count;
    } else {
      node.suggestions.push({ phrase, count });
    }

    // Sort and keep top-k
    node.suggestions.sort((a, b) => b.count - a.count);
    if (node.suggestions.length > this.topK) {
      node.suggestions = node.suggestions.slice(0, this.topK);
    }
  }

  getSuggestions(prefix) {
    let node = this.root;

    for (const char of prefix.toLowerCase()) {
      if (!node.children.has(char)) {
        return []; // No matches for this prefix
      }
      node = node.children.get(char);
    }

    return node.suggestions;
  }
}
```

### Why Pre-compute Top-K?

| Approach | Query Time | Space | Update Cost |
|----------|------------|-------|-------------|
| Traverse subtree | O(subtree size) | Low | O(1) |
| Pre-computed top-k | O(prefix length) | Higher | O(k log k) |

**Trade-off**: We use more memory to store top-k at each node, but queries are O(prefix_length) instead of O(subtree). For 100K QPS, this is essential.

### Sharding Strategy

```javascript
class TrieServer {
  constructor(shardId, totalShards) {
    this.shardId = shardId;
    this.totalShards = totalShards;
    this.trie = new Trie();
  }

  // Route by first character for prefix locality
  static getShardForPrefix(prefix, totalShards) {
    const firstChar = prefix.charAt(0).toLowerCase();
    return firstChar.charCodeAt(0) % totalShards;
  }
}

class SuggestionService {
  async getSuggestions(prefix, options = {}) {
    // Route to correct shard
    const shardId = TrieServer.getShardForPrefix(prefix, this.shards.length);
    const shardAddress = this.shards[shardId];

    // Check cache first
    const cacheKey = `suggestions:${prefix}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Query shard
    const suggestions = await this.queryShard(shardAddress, prefix);

    // Cache with short TTL (60 seconds)
    await redis.setex(cacheKey, 60, JSON.stringify(suggestions));

    return suggestions;
  }
}
```

### Why Shard by First Character?

- Queries for "app" and "apple" go to same shard (prefix locality)
- Even distribution across alphabet
- Simple routing logic
- Alternative: Hash-based (loses locality, need scatter-gather)

## Deep Dive: Multi-Factor Ranking (7 minutes)

Raw popularity isn't enough. We need to blend multiple signals.

### Ranking Algorithm

```javascript
class RankingService {
  async rank(suggestions, context) {
    const { userId, prefix } = context;

    const scored = await Promise.all(
      suggestions.map(async suggestion => {
        // Base popularity score (logarithmic scaling)
        const popularityScore = Math.log10(suggestion.count + 1);

        // Recency score (decay older queries)
        const recencyScore = this.calculateRecency(suggestion.lastUpdated);

        // Personalization score
        let personalScore = 0;
        if (userId) {
          personalScore = await this.getPersonalScore(userId, suggestion.phrase);
        }

        // Trending boost
        const trendingBoost = await this.getTrendingBoost(suggestion.phrase);

        // Prefix match quality
        const matchQuality = this.calculateMatchQuality(prefix, suggestion.phrase);

        // Combine with weights
        const finalScore =
          popularityScore * 0.30 +
          recencyScore * 0.15 +
          personalScore * 0.25 +
          trendingBoost * 0.20 +
          matchQuality * 0.10;

        return { ...suggestion, score: finalScore };
      })
    );

    return scored.sort((a, b) => b.score - a.score);
  }

  calculateRecency(lastUpdated) {
    const ageInHours = (Date.now() - lastUpdated) / (1000 * 60 * 60);
    // Exponential decay with 1-week half-life
    return Math.exp(-ageInHours / 168);
  }

  calculateMatchQuality(prefix, phrase) {
    const lowerPrefix = prefix.toLowerCase();
    const lowerPhrase = phrase.toLowerCase();

    // Exact start match is best
    if (lowerPhrase.startsWith(lowerPrefix)) {
      return 1.0;
    }

    // Word boundary match
    if (lowerPhrase.includes(' ' + lowerPrefix)) {
      return 0.8;
    }

    // Substring match
    if (lowerPhrase.includes(lowerPrefix)) {
      return 0.5;
    }

    return 0;
  }

  async getPersonalScore(userId, phrase) {
    const userHistory = await redis.get(`user_history:${userId}`);
    if (!userHistory) return 0;

    const history = JSON.parse(userHistory);
    const match = history.find(h => h.phrase === phrase);

    if (match) {
      // Decay personal relevance over time
      const daysSince = (Date.now() - match.timestamp) / (1000 * 60 * 60 * 24);
      return Math.exp(-daysSince / 30); // 30-day half-life
    }

    return 0;
  }
}
```

### Trending Boost

```javascript
async getTrendingBoost(phrase) {
  // Real-time trending score from sliding window counters
  const trending = await redis.zscore('trending_queries', phrase);
  if (!trending) return 0;

  // Normalize to 0-1 range
  return Math.min(trending / 1000, 1.0);
}
```

## Deep Dive: Real-Time Aggregation Pipeline (5 minutes)

### Query Log Processing

```javascript
class AggregationPipeline {
  constructor() {
    this.buffer = new Map();  // phrase -> count
    this.flushInterval = 60000; // 1 minute
  }

  async start() {
    // Subscribe to query log stream
    kafka.subscribe('query_logs', async (message) => {
      await this.processQuery(message);
    });

    // Periodic flush to trie servers
    setInterval(() => this.flush(), this.flushInterval);
  }

  async processQuery(message) {
    const { query, timestamp, userId } = JSON.parse(message);

    // Filter inappropriate content
    if (await this.isInappropriate(query)) return;

    // Filter low-quality queries
    if (this.isLowQuality(query)) return;

    // Increment buffer count
    const current = this.buffer.get(query) || 0;
    this.buffer.set(query, current + 1);

    // Update trending counters
    await this.updateTrending(query, timestamp);
  }

  isLowQuality(query) {
    if (query.length < 2) return true;         // Too short
    if (query.length > 100) return true;       // Too long
    if (/^\d+$/.test(query)) return true;      // Only numbers
    if (/^[asdfghjklqwertyuiopzxcvbnm]{10,}$/i.test(query)) return true; // Keyboard smash
    return false;
  }

  async updateTrending(query, timestamp) {
    // Sliding window counter (5-minute windows)
    const windowKey = `trending_window:${Math.floor(timestamp / 300000)}`;

    await redis.zincrby(windowKey, 1, query);
    await redis.expire(windowKey, 3600); // Keep 1 hour of windows

    // Periodically aggregate for trending
    await this.aggregateTrending();
  }

  async aggregateTrending() {
    const recentWindows = [];
    const now = Date.now();

    for (let i = 0; i < 12; i++) { // Last hour (12 x 5-min windows)
      recentWindows.push(`trending_window:${Math.floor((now - i * 300000) / 300000)}`);
    }

    await redis.zunionstore('trending_queries', recentWindows.length, ...recentWindows);
  }

  async flush() {
    if (this.buffer.size === 0) return;

    const updates = Array.from(this.buffer.entries());
    this.buffer.clear();

    // Group by shard and send updates
    const shardUpdates = new Map();
    for (const [phrase, count] of updates) {
      const shardId = TrieServer.getShardForPrefix(phrase, this.shardCount);
      if (!shardUpdates.has(shardId)) {
        shardUpdates.set(shardId, []);
      }
      shardUpdates.get(shardId).push({ phrase, count });
    }

    for (const [shardId, phraseUpdates] of shardUpdates) {
      await this.sendUpdates(shardId, phraseUpdates);
    }
  }
}
```

### Trie Rebuild Strategy

- **Incremental updates**: Add delta counts every minute
- **Full rebuild**: Nightly rebuild from aggregated data
- **A/B deployment**: Build new trie, swap atomically

## Trade-offs and Alternatives (5 minutes)

### 1. Trie vs. Inverted Index

**Chose: Trie with pre-computed top-k**
- Pro: O(prefix_length) lookup
- Pro: Natural prefix matching
- Con: Higher memory usage
- Alternative: Inverted index (good for full-text, worse for prefix)

### 2. Pre-computed vs. On-demand Top-K

**Chose: Pre-computed at each node**
- Pro: Constant-time retrieval
- Con: More memory, update cost
- Trade-off: Worth it for 100K QPS

### 3. Caching Strategy

**Chose: Short TTL (60 seconds) + trending overlay**
- Pro: Base suggestions stable
- Pro: Trending computed separately
- Con: 60-second staleness
- Alternative: No cache (simpler, higher load)

### 4. Sharding Strategy

**Chose: By first character**
- Pro: Prefix locality preserved
- Pro: Simple routing
- Con: Uneven distribution (more 's' than 'x' queries)
- Alternative: Consistent hashing (even distribution, loses locality)

### 5. Personalization Approach

**Chose: User history boost**
- Pro: Relevant suggestions
- Pro: Privacy-preserving (no profile sharing)
- Con: Cold start problem
- Alternative: Collaborative filtering (more complex)

### Fuzzy Matching (Optional)

```javascript
class FuzzyMatcher {
  findMatches(prefix, candidates, maxDistance = 2) {
    return candidates.filter(candidate => {
      const distance = this.levenshteinDistance(
        prefix.toLowerCase(),
        candidate.phrase.slice(0, prefix.length + maxDistance).toLowerCase()
      );
      return distance <= maxDistance;
    });
  }

  // Could use keyboard proximity for smarter typo correction
  isKeyboardAdjacent(char1, char2) {
    const keyboard = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    // Check if characters are adjacent on keyboard
  }
}
```

## Closing Summary (1 minute)

"The typeahead system is built around three key innovations:

1. **Trie with pre-computed top-k** - By storing the top 10 suggestions at every prefix node, we achieve O(prefix_length) query time instead of traversing the subtree. This is essential for sub-50ms latency at 100K QPS.

2. **Multi-factor ranking** - We blend popularity (30%), personalization (25%), trending (20%), recency (15%), and match quality (10%) to surface the most relevant suggestions. Weights are tuned via A/B testing.

3. **Real-time aggregation pipeline** - Query logs flow through Kafka, get filtered for quality, and update both the trie (every minute) and sliding window trending counters (continuously).

The main trade-off is memory vs. latency. We use more memory for pre-computed suggestions because at 100K QPS, even milliseconds matter. Future improvements would include fuzzy matching for typo correction and implementing phrase-level embeddings for semantic similarity in ranking."

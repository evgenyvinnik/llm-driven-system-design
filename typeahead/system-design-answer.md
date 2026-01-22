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

## Deep Dive: Frontend Architecture (10 minutes)

As a frontend engineer, the typeahead system presents unique challenges: delivering suggestions before the user finishes typing, managing multiple concurrent widget instances, and implementing a multi-layer caching strategy that spans browser memory, service workers, and CDN edge nodes.

### Widget Types and UX Patterns

Modern applications require multiple typeahead widgets with different behaviors:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Typeahead Widget Types                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. SEARCH BOX (Primary)              2. INLINE FORM COMPLETION             │
│  ┌─────────────────────────┐          ┌─────────────────────────────┐      │
│  │ 🔍 weat                 │          │ Email: john@gma             │      │
│  ├─────────────────────────┤          │        ┌─────────────────┐  │      │
│  │ weather forecast        │          │        │ gmail.com       │  │      │
│  │ weather today           │          │        │ googlemail.com  │  │      │
│  │ weather radar           │          │        └─────────────────┘  │      │
│  │ 🔥 weather alert [TREND]│          │ Address: 123 Main St        │      │
│  │ 📍 weather seattle [LOC]│          │         ┌───────────────┐   │      │
│  └─────────────────────────┘          │         │ 123 Main St,  │   │      │
│                                       │         │ Seattle, WA   │   │      │
│  3. COMMAND PALETTE                   │         └───────────────┘   │      │
│  ┌─────────────────────────┐          └─────────────────────────────┘      │
│  │ ⌘K  git sta             │                                               │
│  ├─────────────────────────┤          4. RICH SUGGESTIONS                  │
│  │ ⚡ git status           │          ┌─────────────────────────────┐      │
│  │ ⚙️ git stash            │          │ 🔍 taylor swi               │      │
│  │ 📝 git stage all        │          ├─────────────────────────────┤      │
│  │ 🔀 git switch branch    │          │ 🎤 Taylor Swift             │      │
│  └─────────────────────────┘          │    Artist • 89M followers   │      │
│                                       │ 🎵 Taylor Swift - Anti-Hero │      │
│  5. MOBILE TYPEAHEAD                  │    Song • 1.2B plays        │      │
│  ┌─────────────────────────┐          │ 📰 Taylor Swift news        │      │
│  │ ┌───────────────────┐   │          │    Category                 │      │
│  │ │ weat          [X] │   │          └─────────────────────────────┘      │
│  │ └───────────────────┘   │                                               │
│  │ weather forecast    →   │                                               │
│  │ weather today       →   │                                               │
│  │ ───────────────────── │                                               │
│  │ RECENT SEARCHES        │                                               │
│  │ weather yesterday   🕐 │                                               │
│  └─────────────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Widget Architecture

Each widget type requires different data sources, ranking, and display:

```typescript
// Widget configuration interface
interface TypeaheadWidgetConfig {
  id: string
  type: 'search' | 'form' | 'command' | 'rich' | 'mobile'

  // Data sources (can combine multiple)
  sources: {
    api?: { endpoint: string; minChars: number }
    local?: { data: string[]; fuzzy: boolean }
    recent?: { storageKey: string; maxItems: number }
    static?: string[]  // Always show (e.g., popular searches)
  }

  // Behavior
  debounceMs: number
  minQueryLength: number
  maxSuggestions: number
  highlightMatches: boolean

  // Caching
  cacheStrategy: 'none' | 'memory' | 'session' | 'persistent'
  cacheTTLSeconds: number

  // Ranking
  rankingWeights: {
    relevance: number
    recency: number
    frequency: number
    personalization: number
  }
}

// Example configurations for different widgets
const searchBoxConfig: TypeaheadWidgetConfig = {
  id: 'main-search',
  type: 'search',
  sources: {
    api: { endpoint: '/api/v1/suggestions', minChars: 1 },
    recent: { storageKey: 'recent-searches', maxItems: 5 }
  },
  debounceMs: 150,
  minQueryLength: 1,
  maxSuggestions: 8,
  highlightMatches: true,
  cacheStrategy: 'memory',
  cacheTTLSeconds: 60,
  rankingWeights: { relevance: 0.4, recency: 0.2, frequency: 0.3, personalization: 0.1 }
}

const commandPaletteConfig: TypeaheadWidgetConfig = {
  id: 'command-palette',
  type: 'command',
  sources: {
    local: { data: registeredCommands, fuzzy: true },
    recent: { storageKey: 'recent-commands', maxItems: 3 }
  },
  debounceMs: 50,  // Faster for local data
  minQueryLength: 0,  // Show all commands initially
  maxSuggestions: 10,
  highlightMatches: true,
  cacheStrategy: 'session',
  cacheTTLSeconds: 3600,
  rankingWeights: { relevance: 0.5, recency: 0.3, frequency: 0.2, personalization: 0 }
}
```

### Request Management: Debouncing, Throttling, and Cancellation

```typescript
class TypeaheadRequestManager {
  private pendingRequest: AbortController | null = null
  private debounceTimer: number | null = null
  private cache: Map<string, { data: Suggestion[]; timestamp: number }> = new Map()

  constructor(
    private config: TypeaheadWidgetConfig,
    private onSuggestions: (suggestions: Suggestion[]) => void,
    private onLoading: (loading: boolean) => void,
    private onError: (error: Error) => void
  ) {}

  async query(prefix: string): Promise<void> {
    // Clear previous debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    // Minimum query length check
    if (prefix.length < this.config.minQueryLength) {
      this.onSuggestions([])
      return
    }

    // Check memory cache first (instant response)
    const cached = this.checkCache(prefix)
    if (cached) {
      this.onSuggestions(cached)
      return
    }

    // Debounce the request
    this.debounceTimer = window.setTimeout(async () => {
      await this.executeQuery(prefix)
    }, this.config.debounceMs)
  }

  private async executeQuery(prefix: string): Promise<void> {
    // Cancel any pending request
    if (this.pendingRequest) {
      this.pendingRequest.abort()
    }

    this.pendingRequest = new AbortController()
    this.onLoading(true)

    try {
      const response = await fetch(
        `${this.config.sources.api!.endpoint}?q=${encodeURIComponent(prefix)}`,
        {
          signal: this.pendingRequest.signal,
          headers: {
            'Accept': 'application/json',
            'X-Client-Version': '1.0.0'
          }
        }
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()

      // Merge with local sources
      const merged = this.mergeWithLocalSources(prefix, data.suggestions)

      // Update cache
      this.setCache(prefix, merged)

      // Deliver results
      this.onSuggestions(merged)
      this.onLoading(false)

    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // Request was cancelled, ignore
        return
      }
      this.onError(error as Error)
      this.onLoading(false)

      // Fallback to stale cache
      const stale = this.checkCache(prefix, { ignoreExpiry: true })
      if (stale) {
        this.onSuggestions(stale)
      }
    }
  }

  private checkCache(
    prefix: string,
    options: { ignoreExpiry?: boolean } = {}
  ): Suggestion[] | null {
    const entry = this.cache.get(prefix)
    if (!entry) return null

    const age = Date.now() - entry.timestamp
    const expired = age > this.config.cacheTTLSeconds * 1000

    if (expired && !options.ignoreExpiry) {
      return null
    }

    return entry.data
  }

  private setCache(prefix: string, data: Suggestion[]): void {
    this.cache.set(prefix, { data, timestamp: Date.now() })

    // Also cache prefix substrings for faster navigation
    // e.g., "weather" caches "weathe", "weath", "weat" with subset
    for (let i = prefix.length - 1; i >= this.config.minQueryLength; i--) {
      const subPrefix = prefix.substring(0, i)
      if (!this.cache.has(subPrefix)) {
        const subData = data.filter(s =>
          s.phrase.toLowerCase().startsWith(subPrefix.toLowerCase())
        )
        this.cache.set(subPrefix, { data: subData, timestamp: Date.now() })
      }
    }
  }

  private mergeWithLocalSources(prefix: string, apiResults: Suggestion[]): Suggestion[] {
    const merged: Suggestion[] = []
    const seen = new Set<string>()

    // Add recent searches first (if matching)
    if (this.config.sources.recent) {
      const recent = this.getRecentSearches(prefix)
      for (const item of recent) {
        if (!seen.has(item.phrase)) {
          merged.push({ ...item, source: 'recent' })
          seen.add(item.phrase)
        }
      }
    }

    // Add API results
    for (const item of apiResults) {
      if (!seen.has(item.phrase)) {
        merged.push({ ...item, source: 'api' })
        seen.add(item.phrase)
      }
    }

    // Apply ranking and limit
    return this.rankAndLimit(merged)
  }

  private rankAndLimit(suggestions: Suggestion[]): Suggestion[] {
    const weights = this.config.rankingWeights

    const scored = suggestions.map(s => ({
      ...s,
      score:
        (s.relevanceScore || 0) * weights.relevance +
        (s.recencyScore || 0) * weights.recency +
        (s.frequencyScore || 0) * weights.frequency +
        (s.personalizationScore || 0) * weights.personalization
    }))

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, this.config.maxSuggestions)
  }
}
```

### Multi-Layer Caching Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Frontend Caching Layers                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Layer 1: In-Memory Cache (Fastest - 0ms)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Map<prefix, { suggestions, timestamp }>                             │   │
│  │  - Survives during session                                           │   │
│  │  - TTL: 60 seconds                                                   │   │
│  │  - Size: ~500 entries                                                │   │
│  │  - Prefix substring caching enabled                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓ miss                                         │
│  Layer 2: Service Worker Cache (Fast - 1-5ms)                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Cache API with stale-while-revalidate                               │   │
│  │  - Survives page refresh                                             │   │
│  │  - TTL: 5 minutes (popular), 1 minute (long-tail)                    │   │
│  │  - Offline fallback                                                  │   │
│  │  - Automatic background refresh                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓ miss                                         │
│  Layer 3: IndexedDB (Medium - 5-20ms)                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Larger dataset storage                                              │   │
│  │  - User history (unlimited)                                          │   │
│  │  - Popular queries dataset (preloaded)                               │   │
│  │  - Fuzzy matching trie (for offline)                                 │   │
│  │  - Persists across sessions                                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓ miss                                         │
│  Layer 4: CDN Edge Cache (Fast - 10-50ms)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Edge nodes cache popular prefixes                                   │   │
│  │  - Geographic proximity                                              │   │
│  │  - TTL: 60 seconds + stale-while-revalidate                         │   │
│  │  - Vary: Accept-Encoding                                             │   │
│  │  - Cache key: /api/v1/suggestions?q={prefix}                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓ miss                                         │
│  Layer 5: Origin Server (Slowest - 50-200ms)                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Trie lookup + ranking + personalization                             │   │
│  │  - Redis cache (60s TTL)                                             │   │
│  │  - Trie in-memory                                                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Service Worker Implementation

```typescript
// service-worker.ts
const CACHE_NAME = 'typeahead-cache-v1'
const SUGGESTIONS_PATTERN = /\/api\/v1\/suggestions\?q=/

// Cache strategies by prefix popularity
const POPULAR_PREFIXES = new Set(['a', 'the', 'how', 'what', 'why', 'best', 'top'])

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url)

  if (SUGGESTIONS_PATTERN.test(url.pathname + url.search)) {
    event.respondWith(handleSuggestionRequest(event.request, url))
  }
})

async function handleSuggestionRequest(request: Request, url: URL): Promise<Response> {
  const prefix = url.searchParams.get('q') || ''
  const isPopular = POPULAR_PREFIXES.has(prefix.charAt(0).toLowerCase()) &&
                    prefix.length <= 3

  // Stale-while-revalidate for popular prefixes
  if (isPopular) {
    return staleWhileRevalidate(request, {
      cacheName: CACHE_NAME,
      maxAge: 300,  // 5 minutes
      staleMaxAge: 3600  // 1 hour stale OK
    })
  }

  // Network-first for long-tail queries
  return networkFirst(request, {
    cacheName: CACHE_NAME,
    maxAge: 60,  // 1 minute
    timeout: 3000  // 3 second network timeout
  })
}

async function staleWhileRevalidate(
  request: Request,
  options: { cacheName: string; maxAge: number; staleMaxAge: number }
): Promise<Response> {
  const cache = await caches.open(options.cacheName)
  const cached = await cache.match(request)

  // Start network fetch in background
  const networkPromise = fetch(request).then(async (response) => {
    if (response.ok) {
      const clone = response.clone()
      // Add timestamp header for cache validation
      const headers = new Headers(clone.headers)
      headers.set('X-Cache-Timestamp', Date.now().toString())

      const timedResponse = new Response(await clone.blob(), {
        status: clone.status,
        statusText: clone.statusText,
        headers
      })

      await cache.put(request, timedResponse)
    }
    return response
  })

  if (cached) {
    const timestamp = parseInt(cached.headers.get('X-Cache-Timestamp') || '0')
    const age = Date.now() - timestamp

    if (age < options.maxAge * 1000) {
      // Fresh cache, return immediately
      return cached
    }

    if (age < options.staleMaxAge * 1000) {
      // Stale but acceptable, return cached and revalidate
      networkPromise.catch(() => {}) // Ignore revalidation errors
      return cached
    }
  }

  // Cache miss or too stale, wait for network
  return networkPromise
}

async function networkFirst(
  request: Request,
  options: { cacheName: string; maxAge: number; timeout: number }
): Promise<Response> {
  const cache = await caches.open(options.cacheName)

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), options.timeout)

    const response = await fetch(request, { signal: controller.signal })
    clearTimeout(timeoutId)

    if (response.ok) {
      const headers = new Headers(response.headers)
      headers.set('X-Cache-Timestamp', Date.now().toString())

      const timedResponse = new Response(await response.clone().blob(), {
        status: response.status,
        statusText: response.statusText,
        headers
      })

      await cache.put(request, timedResponse)
    }

    return response
  } catch (error) {
    // Network failed, try cache
    const cached = await cache.match(request)
    if (cached) {
      return cached
    }
    throw error
  }
}
```

### CDN Caching Configuration

```nginx
# nginx.conf - CDN edge caching for typeahead
location /api/v1/suggestions {
    # Proxy to backend
    proxy_pass http://suggestion-service;

    # Enable caching
    proxy_cache typeahead_cache;
    proxy_cache_key "$scheme$request_method$host$request_uri";

    # Cache successful responses
    proxy_cache_valid 200 60s;

    # Stale-while-revalidate: serve stale for 5 minutes while fetching fresh
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_background_update on;
    proxy_cache_lock on;

    # Add cache status header for debugging
    add_header X-Cache-Status $upstream_cache_status;

    # Cache-Control header for browser
    add_header Cache-Control "public, max-age=60, stale-while-revalidate=300";

    # Vary by encoding only (not cookies for anonymous suggestions)
    add_header Vary "Accept-Encoding";

    # Enable gzip for smaller payloads
    gzip on;
    gzip_types application/json;
}

# Popular prefix warm-up endpoint (called by CDN warmer)
location /api/v1/suggestions/warmup {
    internal;
    proxy_pass http://suggestion-service;
    proxy_cache typeahead_cache;
    proxy_cache_valid 200 300s;  # 5 minute cache for warmed entries
}
```

### Cache Key Design for CDN

```typescript
// Backend: Set appropriate headers for CDN caching
app.get('/api/v1/suggestions', (req, res) => {
  const prefix = req.query.q as string
  const userId = req.userId  // From session/JWT

  // Determine if response is personalized
  const isPersonalized = userId && hasUserHistory(userId)

  if (isPersonalized) {
    // Don't cache personalized responses at CDN
    res.setHeader('Cache-Control', 'private, max-age=0')
    res.setHeader('Vary', 'Cookie, Authorization')
  } else {
    // Cache anonymous responses at CDN edge
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
    res.setHeader('Vary', 'Accept-Encoding')

    // Surrogate-Control for CDN-specific TTL (Fastly, Cloudflare)
    res.setHeader('Surrogate-Control', 'max-age=120')
  }

  // ETags for conditional requests
  const etag = generateETag(prefix, suggestions)
  res.setHeader('ETag', etag)

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end()
  }

  res.json({ suggestions })
})
```

### Prefetching Strategy

```typescript
class TypeaheadPrefetcher {
  private prefetchQueue: Set<string> = new Set()
  private prefetchedPrefixes: Set<string> = new Set()

  constructor(private cache: TypeaheadCache) {}

  // Called on input focus
  async prefetchPopular(): Promise<void> {
    const popularPrefixes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
                             'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r',
                             's', 't', 'u', 'v', 'w', 'x', 'y', 'z']

    // Prefetch single-character suggestions
    for (const prefix of popularPrefixes) {
      this.queuePrefetch(prefix)
    }
  }

  // Called when user types
  async prefetchAdjacent(currentPrefix: string): Promise<void> {
    if (currentPrefix.length < 2) return

    // Prefetch likely next characters based on keyboard layout
    const lastChar = currentPrefix.slice(-1).toLowerCase()
    const adjacentChars = this.getAdjacentKeys(lastChar)

    for (const char of adjacentChars) {
      this.queuePrefetch(currentPrefix + char)
    }

    // Also prefetch likely word completions
    const commonSuffixes = ['ing', 'tion', 'ness', 'ment', 'able', 'ful']
    for (const suffix of commonSuffixes) {
      if (suffix.startsWith(currentPrefix.slice(-1))) {
        this.queuePrefetch(currentPrefix + suffix.slice(1))
      }
    }
  }

  private getAdjacentKeys(char: string): string[] {
    const keyboardLayout: Record<string, string[]> = {
      'a': ['q', 'w', 's', 'z'],
      'b': ['v', 'g', 'h', 'n'],
      'c': ['x', 'd', 'f', 'v'],
      // ... full keyboard adjacency map
    }
    return keyboardLayout[char] || []
  }

  private queuePrefetch(prefix: string): void {
    if (this.prefetchedPrefixes.has(prefix)) return
    if (this.cache.has(prefix)) return

    this.prefetchQueue.add(prefix)
    this.processPrefetchQueue()
  }

  private async processPrefetchQueue(): Promise<void> {
    if (this.prefetchQueue.size === 0) return

    // Use requestIdleCallback for non-blocking prefetch
    requestIdleCallback(async (deadline) => {
      while (deadline.timeRemaining() > 0 && this.prefetchQueue.size > 0) {
        const prefix = this.prefetchQueue.values().next().value
        this.prefetchQueue.delete(prefix)

        try {
          await this.cache.prefetch(prefix)
          this.prefetchedPrefixes.add(prefix)
        } catch {
          // Ignore prefetch failures
        }
      }

      // Continue processing if more items remain
      if (this.prefetchQueue.size > 0) {
        this.processPrefetchQueue()
      }
    })
  }
}
```

### Offline Support with IndexedDB

```typescript
// IndexedDB schema for offline typeahead
interface TypeaheadDB {
  popularQueries: {
    key: string  // prefix
    value: {
      suggestions: Suggestion[]
      lastUpdated: number
    }
  }
  userHistory: {
    key: string  // phrase
    value: {
      phrase: string
      count: number
      lastUsed: number
    }
  }
  offlineTrie: {
    key: 'trie'
    value: SerializedTrie
  }
}

class OfflineTypeahead {
  private db: IDBDatabase | null = null
  private trie: Trie | null = null

  async initialize(): Promise<void> {
    this.db = await this.openDatabase()
    await this.loadTrie()
  }

  private async openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('typeahead', 1)

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // Popular queries store
        const popularStore = db.createObjectStore('popularQueries', { keyPath: 'prefix' })
        popularStore.createIndex('lastUpdated', 'lastUpdated')

        // User history store
        const historyStore = db.createObjectStore('userHistory', { keyPath: 'phrase' })
        historyStore.createIndex('lastUsed', 'lastUsed')
        historyStore.createIndex('count', 'count')

        // Offline trie store
        db.createObjectStore('offlineTrie', { keyPath: 'id' })
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  async getSuggestions(prefix: string): Promise<Suggestion[]> {
    // Try in-memory trie first
    if (this.trie) {
      const trieSuggestions = this.trie.getSuggestions(prefix)
      const historySuggestions = await this.getHistorySuggestions(prefix)
      return this.mergeAndRank(trieSuggestions, historySuggestions)
    }

    // Fallback to IndexedDB lookup
    return this.getStoredSuggestions(prefix)
  }

  private async getHistorySuggestions(prefix: string): Promise<Suggestion[]> {
    if (!this.db) return []

    return new Promise((resolve) => {
      const tx = this.db!.transaction('userHistory', 'readonly')
      const store = tx.objectStore('userHistory')
      const suggestions: Suggestion[] = []

      store.openCursor().onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          const value = cursor.value
          if (value.phrase.toLowerCase().startsWith(prefix.toLowerCase())) {
            suggestions.push({
              phrase: value.phrase,
              count: value.count,
              source: 'history',
              recencyScore: this.calculateRecency(value.lastUsed)
            })
          }
          cursor.continue()
        } else {
          resolve(suggestions)
        }
      }
    })
  }

  async recordSearch(phrase: string): Promise<void> {
    if (!this.db) return

    const tx = this.db.transaction('userHistory', 'readwrite')
    const store = tx.objectStore('userHistory')

    const existing = await this.getFromStore<{ phrase: string; count: number; lastUsed: number }>(
      store, phrase
    )

    if (existing) {
      store.put({
        phrase,
        count: existing.count + 1,
        lastUsed: Date.now()
      })
    } else {
      store.add({
        phrase,
        count: 1,
        lastUsed: Date.now()
      })
    }
  }

  // Periodic sync with server
  async syncWithServer(): Promise<void> {
    try {
      const response = await fetch('/api/v1/suggestions/popular-data')
      const data = await response.json()

      // Update IndexedDB with popular queries
      const tx = this.db!.transaction('popularQueries', 'readwrite')
      const store = tx.objectStore('popularQueries')

      for (const [prefix, suggestions] of Object.entries(data.prefixes)) {
        store.put({ prefix, suggestions, lastUpdated: Date.now() })
      }

      // Update offline trie
      if (data.trie) {
        const trieStore = this.db!.transaction('offlineTrie', 'readwrite')
          .objectStore('offlineTrie')
        trieStore.put({ id: 'main', data: data.trie, lastUpdated: Date.now() })
        this.trie = Trie.deserialize(data.trie)
      }
    } catch (error) {
      console.warn('Failed to sync typeahead data:', error)
    }
  }
}
```

### Accessibility (ARIA) Implementation

```tsx
// Accessible typeahead component
function AccessibleTypeahead({
  id,
  label,
  suggestions,
  onSelect
}: TypeaheadProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex(prev => prev > 0 ? prev - 1 : -1)
        break
      case 'Enter':
        if (activeIndex >= 0 && suggestions[activeIndex]) {
          onSelect(suggestions[activeIndex])
          setIsOpen(false)
        }
        break
      case 'Escape':
        setIsOpen(false)
        setActiveIndex(-1)
        inputRef.current?.focus()
        break
      case 'Tab':
        setIsOpen(false)
        break
    }
  }

  return (
    <div className="typeahead-container">
      <label
        id={`${id}-label`}
        htmlFor={id}
        className="sr-only"
      >
        {label}
      </label>

      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-expanded={isOpen}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={
          activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined
        }
        aria-autocomplete="list"
        aria-haspopup="listbox"
        onKeyDown={handleKeyDown}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
      />

      {isOpen && suggestions.length > 0 && (
        <ul
          ref={listRef}
          id={`${id}-listbox`}
          role="listbox"
          aria-labelledby={`${id}-label`}
          className="suggestions-list"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.phrase}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? 'active' : ''}
              onClick={() => onSelect(suggestion)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <HighlightedMatch
                text={suggestion.phrase}
                query={inputRef.current?.value || ''}
              />
              {suggestion.source === 'history' && (
                <span className="sr-only">(from your search history)</span>
              )}
              {suggestion.trending && (
                <span aria-label="trending">🔥</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Screen reader announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {isOpen && suggestions.length > 0 && (
          `${suggestions.length} suggestions available. Use up and down arrows to navigate.`
        )}
        {isOpen && suggestions.length === 0 && (
          'No suggestions available.'
        )}
      </div>
    </div>
  )
}
```

### Performance Metrics and Monitoring

```typescript
// Client-side performance tracking
class TypeaheadMetrics {
  private observer: PerformanceObserver | null = null

  constructor() {
    this.initObserver()
  }

  private initObserver(): void {
    if (!window.PerformanceObserver) return

    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.includes('/api/v1/suggestions')) {
          this.recordMetric('suggestion_request', {
            duration: entry.duration,
            size: (entry as PerformanceResourceTiming).transferSize,
            cached: (entry as PerformanceResourceTiming).transferSize === 0
          })
        }
      }
    })

    this.observer.observe({ entryTypes: ['resource'] })
  }

  recordMetric(name: string, data: Record<string, unknown>): void {
    // Send to analytics
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/v1/metrics', JSON.stringify({
        name,
        ...data,
        timestamp: Date.now(),
        userAgent: navigator.userAgent,
        connection: (navigator as any).connection?.effectiveType
      }))
    }
  }

  // Core Web Vitals impact tracking
  trackInteractionToSuggestion(prefix: string): () => void {
    const start = performance.now()

    return () => {
      const duration = performance.now() - start
      this.recordMetric('time_to_suggestion', {
        prefixLength: prefix.length,
        duration,
        // INP-relevant: was this blocking?
        wasBlocking: duration > 200
      })
    }
  }
}
```

### Cache Warming Strategy

```typescript
// CDN and browser cache warming
class CacheWarmer {
  private warmupPrefixes: string[] = []

  async initialize(): Promise<void> {
    // Fetch popular prefixes from server
    const response = await fetch('/api/v1/suggestions/warmup-list')
    const data = await response.json()
    this.warmupPrefixes = data.prefixes
  }

  async warmBrowserCache(): Promise<void> {
    // Use idle time to prefetch popular suggestions
    for (const prefix of this.warmupPrefixes) {
      await new Promise(resolve => {
        requestIdleCallback(async () => {
          try {
            await fetch(`/api/v1/suggestions?q=${encodeURIComponent(prefix)}`)
          } catch {
            // Ignore warmup failures
          }
          resolve(null)
        })
      })
    }
  }

  // Server-side: CDN warmup job
  // async warmCDNEdge(edgeLocations: string[]): Promise<void> {
  //   for (const location of edgeLocations) {
  //     for (const prefix of this.warmupPrefixes) {
  //       await fetch(`${location}/api/v1/suggestions?q=${prefix}`, {
  //         headers: { 'X-Warmup': 'true' }
  //       })
  //     }
  //   }
  // }
}
```

### Frontend Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Debounce timing | 150ms | 50ms / 300ms | Balance responsiveness vs. request volume |
| Cache strategy | Multi-layer | Single memory cache | Offline support + persistence |
| Prefetching | Idle-time adjacent | Aggressive all | Respect bandwidth, avoid cache pollution |
| CDN caching | Public for anonymous | Per-user everywhere | High hit rate on common prefixes |
| Offline storage | IndexedDB + Trie | LocalStorage | Larger storage, complex queries |
| Request cancellation | AbortController | No cancellation | Avoid stale responses overwriting fresh |

## Closing Summary (1 minute)

"The typeahead system is built around four key innovations:

1. **Trie with pre-computed top-k** - By storing the top 10 suggestions at every prefix node, we achieve O(prefix_length) query time instead of traversing the subtree. This is essential for sub-50ms latency at 100K QPS.

2. **Multi-factor ranking** - We blend popularity (30%), personalization (25%), trending (20%), recency (15%), and match quality (10%) to surface the most relevant suggestions. Weights are tuned via A/B testing.

3. **Real-time aggregation pipeline** - Query logs flow through Kafka, get filtered for quality, and update both the trie (every minute) and sliding window trending counters (continuously).

4. **Multi-layer frontend caching** - From a frontend perspective, we implement five caching layers: in-memory cache (0ms), Service Worker cache (1-5ms), IndexedDB (5-20ms), CDN edge (10-50ms), and origin server (50-200ms). This enables offline support, reduces server load by 80%+, and ensures users see suggestions before their next keystroke.

The main trade-off is memory vs. latency. We use more memory for pre-computed suggestions because at 100K QPS, even milliseconds matter. On the frontend, the trade-off is complexity vs. resilience—multiple caching layers add implementation overhead but provide graceful degradation and offline capability. Future improvements would include fuzzy matching for typo correction, phrase-level embeddings for semantic similarity, and WebSocket streaming for instant trending updates."

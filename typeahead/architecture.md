# Design Typeahead - Architecture

## System Overview

Typeahead is an autocomplete suggestion system with low-latency requirements. Core challenges involve prefix matching, ranking, and real-time updates.

**Learning Goals:**
- Build trie-based data structures
- Design low-latency serving systems
- Implement real-time aggregation pipelines
- Handle personalized ranking

---

## Requirements

### Functional Requirements

1. **Suggest**: Return top suggestions for prefix
2. **Rank**: Order by relevance/popularity
3. **Personalize**: User-specific suggestions
4. **Update**: Reflect trending topics
5. **Filter**: Remove inappropriate content

### Non-Functional Requirements

- **Latency**: < 50ms P99
- **Availability**: 99.99%
- **Scale**: 100K QPS
- **Freshness**: Trending within minutes

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│              Search Box │ Mobile App │ API                      │
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
│  Trie Servers │    │ Ranking Service│    │   User Data   │
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

---

## Core Components

### 1. Trie Data Structure

**Memory-Efficient Trie:**
```javascript
class TrieNode {
  constructor() {
    this.children = new Map() // Character -> TrieNode
    this.isEndOfWord = false
    this.suggestions = [] // Top-k suggestions at this prefix
    this.count = 0
  }
}

class Trie {
  constructor(topK = 10) {
    this.root = new TrieNode()
    this.topK = topK
  }

  insert(phrase, count) {
    let node = this.root

    for (const char of phrase.toLowerCase()) {
      if (!node.children.has(char)) {
        node.children.set(char, new TrieNode())
      }
      node = node.children.get(char)

      // Update top-k suggestions at each prefix node
      this.updateSuggestions(node, phrase, count)
    }

    node.isEndOfWord = true
    node.count = count
  }

  updateSuggestions(node, phrase, count) {
    // Add or update this phrase
    const existing = node.suggestions.find(s => s.phrase === phrase)
    if (existing) {
      existing.count = count
    } else {
      node.suggestions.push({ phrase, count })
    }

    // Sort and keep top-k
    node.suggestions.sort((a, b) => b.count - a.count)
    if (node.suggestions.length > this.topK) {
      node.suggestions = node.suggestions.slice(0, this.topK)
    }
  }

  getSuggestions(prefix) {
    let node = this.root

    for (const char of prefix.toLowerCase()) {
      if (!node.children.has(char)) {
        return [] // No matches
      }
      node = node.children.get(char)
    }

    return node.suggestions
  }

  // Serialize for network transfer
  serialize() {
    const serializeNode = (node, prefix) => {
      const result = {
        suggestions: node.suggestions,
        children: {}
      }

      for (const [char, child] of node.children) {
        result.children[char] = serializeNode(child, prefix + char)
      }

      return result
    }

    return JSON.stringify(serializeNode(this.root, ''))
  }
}
```

### 2. Sharded Trie Service

**Distributed Prefix Matching:**
```javascript
class TrieServer {
  constructor(shardId, totalShards) {
    this.shardId = shardId
    this.totalShards = totalShards
    this.trie = new Trie()
  }

  // Determine which shard handles this prefix
  static getShardForPrefix(prefix, totalShards) {
    // Shard by first character for even distribution
    const firstChar = prefix.charAt(0).toLowerCase()
    return firstChar.charCodeAt(0) % totalShards
  }

  async loadData(dataPath) {
    // Load only phrases belonging to this shard
    const phrases = await this.loadShardData(dataPath)

    for (const { phrase, count } of phrases) {
      this.trie.insert(phrase, count)
    }
  }

  getSuggestions(prefix) {
    return this.trie.getSuggestions(prefix)
  }
}

class SuggestionService {
  constructor(shardAddresses) {
    this.shards = shardAddresses
  }

  async getSuggestions(prefix, options = {}) {
    const { userId, limit = 5 } = options

    // Route to correct shard
    const shardId = TrieServer.getShardForPrefix(prefix, this.shards.length)
    const shardAddress = this.shards[shardId]

    // Get base suggestions
    const baseSuggestions = await this.queryShardWithCache(shardAddress, prefix)

    // Apply personalization if user is known
    let rankedSuggestions = baseSuggestions
    if (userId) {
      rankedSuggestions = await this.personalize(baseSuggestions, userId, prefix)
    }

    // Apply trending boost
    rankedSuggestions = await this.boostTrending(rankedSuggestions)

    return rankedSuggestions.slice(0, limit)
  }

  async queryShardWithCache(shardAddress, prefix) {
    // Check cache first
    const cacheKey = `suggestions:${prefix}`
    const cached = await redis.get(cacheKey)

    if (cached) {
      return JSON.parse(cached)
    }

    // Query shard
    const suggestions = await this.queryShard(shardAddress, prefix)

    // Cache for short period (handle freshness)
    await redis.setex(cacheKey, 60, JSON.stringify(suggestions))

    return suggestions
  }
}
```

### 3. Ranking System

**Multi-Factor Ranking:**
```javascript
class RankingService {
  async rank(suggestions, context) {
    const { userId, prefix, deviceType } = context

    const scored = await Promise.all(
      suggestions.map(async suggestion => {
        // Base popularity score (logarithmic scaling)
        const popularityScore = Math.log10(suggestion.count + 1)

        // Recency score (decay older queries)
        const recencyScore = this.calculateRecency(suggestion.lastUpdated)

        // Personalization score
        let personalScore = 0
        if (userId) {
          personalScore = await this.getPersonalScore(userId, suggestion.phrase)
        }

        // Trending boost
        const trendingBoost = await this.getTrendingBoost(suggestion.phrase)

        // Prefix match quality (exact match vs partial)
        const matchQuality = this.calculateMatchQuality(prefix, suggestion.phrase)

        // Combine scores
        const finalScore =
          popularityScore * 0.3 +
          recencyScore * 0.2 +
          personalScore * 0.2 +
          trendingBoost * 0.2 +
          matchQuality * 0.1

        return {
          ...suggestion,
          score: finalScore
        }
      })
    )

    // Sort by final score
    scored.sort((a, b) => b.score - a.score)

    return scored
  }

  calculateRecency(lastUpdated) {
    const ageInHours = (Date.now() - lastUpdated) / (1000 * 60 * 60)

    // Exponential decay
    return Math.exp(-ageInHours / 168) // Half-life of 1 week
  }

  calculateMatchQuality(prefix, phrase) {
    const lowerPrefix = prefix.toLowerCase()
    const lowerPhrase = phrase.toLowerCase()

    // Exact start match is best
    if (lowerPhrase.startsWith(lowerPrefix)) {
      return 1.0
    }

    // Word boundary match is good
    if (lowerPhrase.includes(' ' + lowerPrefix)) {
      return 0.8
    }

    // Substring match
    if (lowerPhrase.includes(lowerPrefix)) {
      return 0.5
    }

    return 0
  }

  async getPersonalScore(userId, phrase) {
    // Check user's search history
    const userHistory = await redis.get(`user_history:${userId}`)
    if (!userHistory) return 0

    const history = JSON.parse(userHistory)
    const match = history.find(h => h.phrase === phrase)

    if (match) {
      // Recency-weighted personal score
      const daysSince = (Date.now() - match.timestamp) / (1000 * 60 * 60 * 24)
      return Math.exp(-daysSince / 30) // Decay over 30 days
    }

    return 0
  }

  async getTrendingBoost(phrase) {
    const trending = await redis.zscore('trending_queries', phrase)
    if (!trending) return 0

    // Normalize trending score
    return Math.min(trending / 1000, 1.0)
  }
}
```

### 4. Real-Time Updates

**Query Log Aggregation:**
```javascript
class AggregationPipeline {
  constructor() {
    this.buffer = new Map() // phrase -> count
    this.flushInterval = 60000 // 1 minute
  }

  async start() {
    // Subscribe to query log stream
    kafka.subscribe('query_logs', async (message) => {
      await this.processQuery(message)
    })

    // Periodic flush to trie servers
    setInterval(() => this.flush(), this.flushInterval)
  }

  async processQuery(message) {
    const { query, timestamp, userId } = JSON.parse(message)

    // Filter inappropriate content
    if (await this.isInappropriate(query)) {
      return
    }

    // Filter low-quality queries
    if (this.isLowQuality(query)) {
      return
    }

    // Increment buffer count
    const current = this.buffer.get(query) || 0
    this.buffer.set(query, current + 1)

    // Update trending
    await this.updateTrending(query, timestamp)
  }

  async updateTrending(query, timestamp) {
    // Sliding window counter for trending
    const windowKey = `trending_window:${Math.floor(timestamp / 300000)}` // 5-min windows

    await redis.zincrby(windowKey, 1, query)
    await redis.expire(windowKey, 3600) // Keep 1 hour of windows

    // Aggregate recent windows for trending
    const recentWindows = []
    const now = Date.now()
    for (let i = 0; i < 12; i++) { // Last hour
      recentWindows.push(`trending_window:${Math.floor((now - i * 300000) / 300000)}`)
    }

    await redis.zunionstore('trending_queries', recentWindows.length, ...recentWindows)
  }

  async flush() {
    if (this.buffer.size === 0) return

    const updates = Array.from(this.buffer.entries())
    this.buffer.clear()

    // Group by shard
    const shardUpdates = new Map()
    for (const [phrase, count] of updates) {
      const shardId = TrieServer.getShardForPrefix(phrase, this.shardCount)
      if (!shardUpdates.has(shardId)) {
        shardUpdates.set(shardId, [])
      }
      shardUpdates.get(shardId).push({ phrase, count })
    }

    // Send to trie servers
    for (const [shardId, phraseUpdates] of shardUpdates) {
      await this.sendUpdates(shardId, phraseUpdates)
    }
  }

  isLowQuality(query) {
    // Too short
    if (query.length < 2) return true

    // Too long
    if (query.length > 100) return true

    // Mostly numbers
    if (/^\d+$/.test(query)) return true

    // Random characters (keyboard smash)
    if (/^[asdfghjklqwertyuiopzxcvbnm]{10,}$/i.test(query)) return true

    return false
  }
}
```

### 5. Fuzzy Matching

**Approximate String Matching:**
```javascript
class FuzzyMatcher {
  constructor(maxDistance = 2) {
    this.maxDistance = maxDistance
  }

  findMatches(prefix, candidates) {
    const matches = []

    for (const candidate of candidates) {
      // Only consider candidates that are close in length
      if (Math.abs(candidate.phrase.length - prefix.length) > this.maxDistance) {
        continue
      }

      const distance = this.levenshteinDistance(
        prefix.toLowerCase(),
        candidate.phrase.slice(0, prefix.length + this.maxDistance).toLowerCase()
      )

      if (distance <= this.maxDistance) {
        matches.push({
          ...candidate,
          distance,
          // Penalize fuzzy matches in ranking
          fuzzyPenalty: distance * 0.2
        })
      }
    }

    return matches
  }

  levenshteinDistance(s1, s2) {
    const m = s1.length
    const n = s2.length

    // Early exit for common cases
    if (m === 0) return n
    if (n === 0) return m
    if (s1 === s2) return 0

    // DP matrix
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0))

    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1]
        } else {
          dp[i][j] = 1 + Math.min(
            dp[i - 1][j],     // deletion
            dp[i][j - 1],     // insertion
            dp[i - 1][j - 1]  // substitution
          )
        }
      }
    }

    return dp[m][n]
  }

  // Keyboard proximity for typo correction
  isKeyboardAdjacent(char1, char2) {
    const keyboard = [
      'qwertyuiop',
      'asdfghjkl',
      'zxcvbnm'
    ]

    let pos1, pos2

    for (let row = 0; row < keyboard.length; row++) {
      const col1 = keyboard[row].indexOf(char1.toLowerCase())
      const col2 = keyboard[row].indexOf(char2.toLowerCase())

      if (col1 !== -1) pos1 = { row, col: col1 }
      if (col2 !== -1) pos2 = { row, col: col2 }
    }

    if (!pos1 || !pos2) return false

    return Math.abs(pos1.row - pos2.row) <= 1 &&
           Math.abs(pos1.col - pos2.col) <= 1
  }
}
```

---

## Database Schema

```sql
-- Phrase counts (aggregated)
CREATE TABLE phrase_counts (
  phrase VARCHAR(200) PRIMARY KEY,
  count BIGINT DEFAULT 0,
  last_updated TIMESTAMP DEFAULT NOW(),
  is_filtered BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_phrase_count ON phrase_counts(count DESC);

-- Query logs (raw, for aggregation)
CREATE TABLE query_logs (
  id BIGSERIAL PRIMARY KEY,
  query VARCHAR(200) NOT NULL,
  user_id UUID,
  timestamp TIMESTAMP DEFAULT NOW(),
  session_id VARCHAR(100)
);

CREATE INDEX idx_query_logs_time ON query_logs(timestamp);

-- User search history (for personalization)
CREATE TABLE user_history (
  user_id UUID NOT NULL,
  phrase VARCHAR(200) NOT NULL,
  count INTEGER DEFAULT 1,
  last_searched TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, phrase)
);

-- Filtered phrases (inappropriate content)
CREATE TABLE filtered_phrases (
  phrase VARCHAR(200) PRIMARY KEY,
  reason VARCHAR(50),
  added_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Trie with Pre-computed Top-K

**Decision**: Store top-k suggestions at each trie node

**Rationale**:
- O(prefix_length) query time
- No traversal of subtree needed
- Trade-off: more memory, but fast reads

### 2. Sharding by First Character

**Decision**: Route requests based on first character

**Rationale**:
- Simple routing logic
- Even distribution for most alphabets
- Prefix locality preserved

### 3. Hybrid Freshness

**Decision**: Cache with short TTL + real-time trending

**Rationale**:
- Base suggestions stable (1 min cache OK)
- Trending computed in real-time
- Balance freshness and performance

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Data structure | Trie | Inverted index | Prefix efficiency |
| Storage | Pre-computed top-k | On-demand traversal | Latency |
| Freshness | Short cache + trending | Real-time | Performance |
| Sharding | By first char | By hash | Prefix locality |

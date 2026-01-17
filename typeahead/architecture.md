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

---

## Consistency and Idempotency Semantics

### Write Consistency Model

The typeahead system uses **eventual consistency** for most operations, which is appropriate given the read-heavy workload and latency requirements.

**Write Categories:**

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Query log ingestion | Eventual | Loss of a few queries is acceptable; high throughput matters |
| Phrase count updates | Eventual | Aggregated counts tolerate minor drift |
| Trending score updates | Eventual | Real-time approximation is sufficient |
| Filter list updates | Strong | Inappropriate content must be blocked immediately |
| User history updates | Eventual | Personalization can lag slightly |

**Phrase Count Aggregation:**
```javascript
// Aggregation uses last-write-wins with timestamp ordering
class PhraseCountAggregator {
  async updateCount(phrase, deltaCount, timestamp) {
    // Upsert with conflict resolution on timestamp
    await db.query(`
      INSERT INTO phrase_counts (phrase, count, last_updated)
      VALUES ($1, $2, $3)
      ON CONFLICT (phrase) DO UPDATE
      SET count = phrase_counts.count + EXCLUDED.count,
          last_updated = GREATEST(phrase_counts.last_updated, EXCLUDED.last_updated)
    `, [phrase, deltaCount, timestamp])
  }
}
```

### Idempotency for Core Writes

**Query Log Ingestion:**
Each query log message includes an idempotency key to prevent duplicate processing:

```javascript
// Message structure from Kafka
{
  idempotencyKey: "user123_1704067200000_abc123",  // userId_timestamp_randomSuffix
  query: "weather forecast",
  userId: "user123",
  timestamp: 1704067200000,
  sessionId: "session456"
}

class IdempotentAggregator {
  constructor() {
    // In-memory set for recent keys (last 5 minutes)
    this.processedKeys = new Set()
    this.keyExpiry = 300000  // 5 minutes
  }

  async processQuery(message) {
    const { idempotencyKey } = message

    // Check in-memory first (fast path)
    if (this.processedKeys.has(idempotencyKey)) {
      return { status: 'duplicate', processed: false }
    }

    // Check Redis for distributed deduplication
    const exists = await redis.setnx(`idem:${idempotencyKey}`, '1')
    if (!exists) {
      return { status: 'duplicate', processed: false }
    }

    // Set expiry on the idempotency key
    await redis.expire(`idem:${idempotencyKey}`, 300)

    // Add to local cache
    this.processedKeys.add(idempotencyKey)
    setTimeout(() => this.processedKeys.delete(idempotencyKey), this.keyExpiry)

    // Process the query
    await this.doProcessQuery(message)
    return { status: 'processed', processed: true }
  }
}
```

**Trie Update Idempotency:**
Trie updates are idempotent by design since they use absolute counts rather than deltas:

```javascript
// Trie rebuild uses snapshot isolation
class TrieRebuilder {
  async rebuildFromSnapshot(snapshotId) {
    // Check if this snapshot was already applied
    const lastApplied = await redis.get('trie:last_snapshot')
    if (lastApplied === snapshotId) {
      console.log(`Snapshot ${snapshotId} already applied, skipping`)
      return
    }

    // Build new trie from phrase_counts table
    const phrases = await db.query(`
      SELECT phrase, count FROM phrase_counts
      WHERE is_filtered = FALSE
      ORDER BY count DESC
    `)

    const newTrie = new Trie()
    for (const { phrase, count } of phrases.rows) {
      newTrie.insert(phrase, count)
    }

    // Atomic swap
    this.trie = newTrie
    await redis.set('trie:last_snapshot', snapshotId)
  }
}
```

### Replay Handling

**Kafka Consumer Replay:**
When a consumer restarts or replays from an earlier offset:

```javascript
class ReplayAwareConsumer {
  constructor() {
    this.highWaterMark = new Map()  // partition -> highest processed offset
  }

  async processMessage(message, partition, offset) {
    // Skip if we have already processed a higher offset for this partition
    const hwm = this.highWaterMark.get(partition) || -1
    if (offset <= hwm) {
      console.log(`Skipping replay: partition=${partition}, offset=${offset}, hwm=${hwm}`)
      return
    }

    // Process with idempotency key
    const result = await this.idempotentAggregator.processQuery(message)

    // Update high water mark
    if (result.processed) {
      this.highWaterMark.set(partition, offset)
      // Checkpoint periodically
      if (offset % 1000 === 0) {
        await this.checkpointOffsets()
      }
    }
  }
}
```

### Conflict Resolution

**Concurrent Trie Updates:**
When multiple aggregation workers update the same phrase:

```javascript
// Redis-based atomic counter updates
class DistributedCounter {
  async incrementPhrase(phrase, delta) {
    // Atomic increment in Redis
    const newCount = await redis.incrby(`phrase:${phrase}:count`, delta)

    // Batch persist to PostgreSQL every 30 seconds (handled by separate job)
    return newCount
  }
}

// PostgreSQL conflict resolution uses SUM for counts
class BatchPersister {
  async persistCounts() {
    const keys = await redis.keys('phrase:*:count')
    const batch = []

    for (const key of keys) {
      const phrase = key.split(':')[1]
      const count = await redis.getdel(key)  // Atomic get-and-delete
      if (count) {
        batch.push({ phrase, count: parseInt(count) })
      }
    }

    // Upsert batch
    await db.query(`
      INSERT INTO phrase_counts (phrase, count, last_updated)
      SELECT phrase, count, NOW() FROM UNNEST($1::phrase_count[])
      ON CONFLICT (phrase) DO UPDATE
      SET count = phrase_counts.count + EXCLUDED.count,
          last_updated = NOW()
    `, [batch])
  }
}
```

---

## Observability

### Metrics

**Key Metrics to Instrument (Prometheus format):**

```javascript
// metrics.js - Using prom-client for Node.js
const promClient = require('prom-client')

// Request latency histogram
const suggestionLatency = new promClient.Histogram({
  name: 'typeahead_suggestion_latency_seconds',
  help: 'Latency of suggestion requests',
  labelNames: ['endpoint', 'cache_hit'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5]  // 5ms to 500ms
})

// Request counter
const suggestionRequests = new promClient.Counter({
  name: 'typeahead_suggestion_requests_total',
  help: 'Total suggestion requests',
  labelNames: ['endpoint', 'status']
})

// Cache metrics
const cacheHitRate = new promClient.Gauge({
  name: 'typeahead_cache_hit_rate',
  help: 'Cache hit rate (0-1)',
  labelNames: ['cache_type']  // redis, local
})

// Trie metrics
const trieNodeCount = new promClient.Gauge({
  name: 'typeahead_trie_node_count',
  help: 'Number of nodes in trie',
  labelNames: ['shard_id']
})

const triePhraseCount = new promClient.Gauge({
  name: 'typeahead_trie_phrase_count',
  help: 'Number of phrases in trie',
  labelNames: ['shard_id']
})

// Aggregation pipeline metrics
const kafkaLag = new promClient.Gauge({
  name: 'typeahead_kafka_consumer_lag',
  help: 'Kafka consumer lag (messages behind)',
  labelNames: ['partition']
})

const aggregationBufferSize = new promClient.Gauge({
  name: 'typeahead_aggregation_buffer_size',
  help: 'Current size of aggregation buffer'
})

const queriesFiltered = new promClient.Counter({
  name: 'typeahead_queries_filtered_total',
  help: 'Queries filtered out',
  labelNames: ['reason']  // inappropriate, low_quality, duplicate
})

// Example usage in suggestion endpoint
app.get('/api/v1/suggestions', async (req, res) => {
  const timer = suggestionLatency.startTimer()
  const prefix = req.query.q

  try {
    const cacheKey = `suggestions:${prefix}`
    let cached = await redis.get(cacheKey)
    let cacheHit = !!cached

    let suggestions
    if (cached) {
      suggestions = JSON.parse(cached)
    } else {
      suggestions = await suggestionService.getSuggestions(prefix, req.userId)
      await redis.setex(cacheKey, 60, JSON.stringify(suggestions))
    }

    timer({ endpoint: 'suggestions', cache_hit: cacheHit })
    suggestionRequests.inc({ endpoint: 'suggestions', status: 'success' })

    res.json({ suggestions })
  } catch (error) {
    timer({ endpoint: 'suggestions', cache_hit: 'false' })
    suggestionRequests.inc({ endpoint: 'suggestions', status: 'error' })
    res.status(500).json({ error: 'Internal error' })
  }
})
```

### SLI Dashboard Configuration

**Grafana Dashboard Panels:**

```yaml
# grafana-dashboard.yaml
panels:
  - title: "Request Latency (P50, P95, P99)"
    type: graph
    queries:
      - expr: histogram_quantile(0.50, rate(typeahead_suggestion_latency_seconds_bucket[5m]))
        legend: P50
      - expr: histogram_quantile(0.95, rate(typeahead_suggestion_latency_seconds_bucket[5m]))
        legend: P95
      - expr: histogram_quantile(0.99, rate(typeahead_suggestion_latency_seconds_bucket[5m]))
        legend: P99
    thresholds:
      - value: 0.05  # 50ms SLO
        color: red

  - title: "Request Rate"
    type: graph
    queries:
      - expr: rate(typeahead_suggestion_requests_total[1m])
        legend: "{{status}}"

  - title: "Cache Hit Rate"
    type: gauge
    queries:
      - expr: typeahead_cache_hit_rate{cache_type="redis"}
    thresholds:
      - value: 0.8
        color: yellow
      - value: 0.9
        color: green

  - title: "Kafka Consumer Lag"
    type: graph
    queries:
      - expr: sum(typeahead_kafka_consumer_lag)
    thresholds:
      - value: 10000
        color: yellow
      - value: 100000
        color: red

  - title: "Error Rate"
    type: singlestat
    queries:
      - expr: |
          rate(typeahead_suggestion_requests_total{status="error"}[5m])
          / rate(typeahead_suggestion_requests_total[5m])
    thresholds:
      - value: 0.001  # 0.1% error rate
        color: yellow
      - value: 0.01   # 1% error rate
        color: red
```

### Alert Thresholds

```yaml
# prometheus-alerts.yaml
groups:
  - name: typeahead_alerts
    rules:
      # Latency SLO breach
      - alert: TypeaheadHighLatency
        expr: histogram_quantile(0.99, rate(typeahead_suggestion_latency_seconds_bucket[5m])) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Typeahead P99 latency above 50ms"
          description: "P99 latency is {{ $value | humanizeDuration }}"

      # Error rate
      - alert: TypeaheadHighErrorRate
        expr: |
          rate(typeahead_suggestion_requests_total{status="error"}[5m])
          / rate(typeahead_suggestion_requests_total[5m]) > 0.01
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Typeahead error rate above 1%"

      # Kafka lag
      - alert: TypeaheadKafkaLagHigh
        expr: sum(typeahead_kafka_consumer_lag) > 50000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka consumer lag is high"
          description: "Lag is {{ $value }} messages"

      # Cache hit rate
      - alert: TypeaheadLowCacheHitRate
        expr: typeahead_cache_hit_rate{cache_type="redis"} < 0.7
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 70%"

      # Trie size anomaly
      - alert: TypeaheadTrieSizeAnomaly
        expr: |
          abs(typeahead_trie_phrase_count - avg_over_time(typeahead_trie_phrase_count[1h]))
          / avg_over_time(typeahead_trie_phrase_count[1h]) > 0.2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Trie size changed by more than 20%"
```

### Structured Logging

```javascript
// logger.js - Using pino for structured logging
const pino = require('pino')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'typeahead',
    version: process.env.APP_VERSION || '1.0.0',
    env: process.env.NODE_ENV || 'development'
  }
})

// Request logging middleware
function requestLogger(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID()
  req.requestId = requestId

  const startTime = process.hrtime.bigint()

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6

    logger.info({
      type: 'request',
      requestId,
      method: req.method,
      path: req.path,
      query: req.query.q?.substring(0, 50),  // Truncate for privacy
      userId: req.userId || 'anonymous',
      statusCode: res.statusCode,
      durationMs: durationMs.toFixed(2),
      cacheHit: res.locals.cacheHit || false,
      suggestionCount: res.locals.suggestionCount || 0
    })
  })

  next()
}

// Aggregation pipeline logging
class LoggingAggregator {
  async processQuery(message) {
    const { query, userId, idempotencyKey } = message

    logger.debug({
      type: 'query_ingested',
      idempotencyKey,
      queryLength: query.length,
      userId: userId?.substring(0, 8)  // Partial for privacy
    })

    if (await this.isFiltered(query)) {
      logger.info({
        type: 'query_filtered',
        reason: 'content_filter',
        idempotencyKey
      })
      return
    }

    // ... process
  }
}
```

### Distributed Tracing

```javascript
// tracing.js - Using OpenTelemetry
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')
const { trace, context, SpanStatusCode } = require('@opentelemetry/api')

// Initialize tracer
const provider = new NodeTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(new JaegerExporter({
  endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces'
})))
provider.register()

const tracer = trace.getTracer('typeahead-service')

// Traced suggestion handler
async function getSuggestionsTraced(prefix, userId) {
  return tracer.startActiveSpan('getSuggestions', async (span) => {
    span.setAttribute('prefix.length', prefix.length)
    span.setAttribute('user.id', userId || 'anonymous')

    try {
      // Check cache
      const cacheSpan = tracer.startSpan('cache.get', {}, context.active())
      const cached = await redis.get(`suggestions:${prefix}`)
      cacheSpan.setAttribute('cache.hit', !!cached)
      cacheSpan.end()

      if (cached) {
        span.setAttribute('cache.hit', true)
        return JSON.parse(cached)
      }

      // Query trie shard
      const trieSpan = tracer.startSpan('trie.query', {}, context.active())
      const shardId = getShardForPrefix(prefix)
      trieSpan.setAttribute('shard.id', shardId)
      const suggestions = await queryTrieShard(shardId, prefix)
      trieSpan.setAttribute('result.count', suggestions.length)
      trieSpan.end()

      // Apply ranking
      const rankSpan = tracer.startSpan('ranking.apply', {}, context.active())
      const ranked = await rankingService.rank(suggestions, { userId, prefix })
      rankSpan.end()

      span.setAttribute('result.count', ranked.length)
      return ranked

    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
}
```

### Audit Logging

```javascript
// audit.js - Security and admin action logging
class AuditLogger {
  constructor() {
    this.logger = pino({
      level: 'info',
      base: { type: 'audit' }
    })
  }

  // Log filter list changes
  logFilterChange(action, phrase, reason, adminUserId) {
    this.logger.info({
      event: 'filter_change',
      action,  // 'add' or 'remove'
      phrase: phrase.substring(0, 50),
      reason,
      adminUserId,
      timestamp: new Date().toISOString(),
      ipAddress: this.getClientIP()
    })

    // Also persist to database for compliance
    db.query(`
      INSERT INTO audit_log (event_type, action, target, actor_id, metadata, created_at)
      VALUES ('filter_change', $1, $2, $3, $4, NOW())
    `, [action, phrase, adminUserId, { reason }])
  }

  // Log trie rebuilds
  logTrieRebuild(triggeredBy, snapshotId, phraseCount, durationMs) {
    this.logger.info({
      event: 'trie_rebuild',
      triggeredBy,  // 'scheduled', 'manual', 'threshold'
      snapshotId,
      phraseCount,
      durationMs,
      timestamp: new Date().toISOString()
    })
  }

  // Log cache invalidation
  logCacheInvalidation(pattern, reason, adminUserId) {
    this.logger.info({
      event: 'cache_invalidation',
      pattern,
      reason,
      adminUserId,
      timestamp: new Date().toISOString()
    })
  }

  // Log rate limit violations
  logRateLimitViolation(userId, endpoint, currentRate, limit) {
    this.logger.warn({
      event: 'rate_limit_exceeded',
      userId,
      endpoint,
      currentRate,
      limit,
      timestamp: new Date().toISOString()
    })
  }
}
```

---

## Failure Handling

### Retry Strategy with Idempotency Keys

```javascript
// retry.js - Exponential backoff with jitter
class RetryHandler {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3
    this.baseDelayMs = options.baseDelayMs || 100
    this.maxDelayMs = options.maxDelayMs || 5000
  }

  async withRetry(operation, idempotencyKey, context = {}) {
    let lastError
    let attempt = 0

    while (attempt < this.maxRetries) {
      try {
        // Pass idempotency key to operation
        return await operation({ idempotencyKey, attempt })
      } catch (error) {
        lastError = error
        attempt++

        // Don't retry non-retryable errors
        if (this.isNonRetryable(error)) {
          throw error
        }

        if (attempt < this.maxRetries) {
          const delay = this.calculateDelay(attempt)
          logger.warn({
            event: 'retry_attempt',
            idempotencyKey,
            attempt,
            delayMs: delay,
            error: error.message,
            ...context
          })
          await this.sleep(delay)
        }
      }
    }

    logger.error({
      event: 'retry_exhausted',
      idempotencyKey,
      attempts: attempt,
      error: lastError.message,
      ...context
    })

    throw lastError
  }

  calculateDelay(attempt) {
    // Exponential backoff with jitter
    const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt - 1)
    const jitter = Math.random() * 0.3 * exponentialDelay
    return Math.min(exponentialDelay + jitter, this.maxDelayMs)
  }

  isNonRetryable(error) {
    // Don't retry validation errors
    if (error.statusCode === 400) return true
    // Don't retry auth errors
    if (error.statusCode === 401 || error.statusCode === 403) return true
    // Don't retry not found
    if (error.statusCode === 404) return true
    return false
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Usage in trie shard communication
const retryHandler = new RetryHandler({ maxRetries: 3, baseDelayMs: 50 })

async function queryShard(shardAddress, prefix) {
  const idempotencyKey = `query_${prefix}_${Date.now()}`

  return retryHandler.withRetry(
    async ({ idempotencyKey, attempt }) => {
      const response = await fetch(`${shardAddress}/query`, {
        method: 'POST',
        headers: {
          'X-Idempotency-Key': idempotencyKey,
          'X-Retry-Attempt': attempt.toString()
        },
        body: JSON.stringify({ prefix }),
        timeout: 100  // 100ms timeout per attempt
      })

      if (!response.ok) {
        const error = new Error(`Shard query failed: ${response.status}`)
        error.statusCode = response.status
        throw error
      }

      return response.json()
    },
    idempotencyKey,
    { prefix, shardAddress }
  )
}
```

### Circuit Breaker Pattern

```javascript
// circuit-breaker.js
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'default'
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeoutMs = options.resetTimeoutMs || 30000
    this.halfOpenRequests = options.halfOpenRequests || 3

    this.state = 'CLOSED'  // CLOSED, OPEN, HALF_OPEN
    this.failures = 0
    this.successes = 0
    this.lastFailureTime = null
    this.halfOpenAttempts = 0
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN'
        this.halfOpenAttempts = 0
        logger.info({ event: 'circuit_half_open', circuit: this.name })
      } else {
        throw new CircuitOpenError(`Circuit ${this.name} is OPEN`)
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failures = 0

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++
      if (this.halfOpenAttempts >= this.halfOpenRequests) {
        this.state = 'CLOSED'
        logger.info({ event: 'circuit_closed', circuit: this.name })
      }
    }
  }

  onFailure() {
    this.failures++
    this.lastFailureTime = Date.now()

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN'
      logger.warn({ event: 'circuit_reopened', circuit: this.name })
    } else if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      logger.warn({
        event: 'circuit_opened',
        circuit: this.name,
        failures: this.failures
      })
    }
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime
    }
  }
}

// Circuit breakers for each shard
const shardCircuits = new Map()

function getShardCircuit(shardId) {
  if (!shardCircuits.has(shardId)) {
    shardCircuits.set(shardId, new CircuitBreaker({
      name: `shard_${shardId}`,
      failureThreshold: 5,
      resetTimeoutMs: 10000
    }))
  }
  return shardCircuits.get(shardId)
}

async function queryShardWithCircuitBreaker(shardId, prefix) {
  const circuit = getShardCircuit(shardId)

  try {
    return await circuit.execute(() => queryShard(shardAddresses[shardId], prefix))
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      // Fallback: return cached or empty results
      logger.warn({
        event: 'shard_circuit_open_fallback',
        shardId,
        prefix: prefix.substring(0, 3)
      })
      return await getCachedOrEmpty(prefix)
    }
    throw error
  }
}
```

### Graceful Degradation

```javascript
// degradation.js - Fallback strategies when components fail
class DegradationHandler {
  constructor() {
    this.degradationFlags = {
      skipPersonalization: false,
      skipTrending: false,
      useStaleCache: false,
      reduceSuggestionCount: false
    }
  }

  async getSuggestionsWithFallbacks(prefix, userId, options) {
    let suggestions = []

    // Primary path: try to get fresh suggestions
    try {
      suggestions = await this.primarySuggestionPath(prefix, userId)
    } catch (error) {
      logger.warn({ event: 'primary_path_failed', error: error.message })

      // Fallback 1: Try stale cache
      const staleCache = await redis.get(`suggestions:stale:${prefix}`)
      if (staleCache) {
        logger.info({ event: 'using_stale_cache', prefix: prefix.substring(0, 3) })
        suggestions = JSON.parse(staleCache)
        this.degradationFlags.useStaleCache = true
      } else {
        // Fallback 2: Return popular suggestions
        logger.info({ event: 'using_popular_fallback' })
        suggestions = await this.getPopularSuggestions(prefix)
      }
    }

    // Try to apply personalization (skip if failing)
    if (userId && !this.degradationFlags.skipPersonalization) {
      try {
        suggestions = await this.applyPersonalization(suggestions, userId)
      } catch (error) {
        logger.warn({ event: 'personalization_skipped', error: error.message })
        this.degradationFlags.skipPersonalization = true
      }
    }

    // Try to apply trending boost (skip if failing)
    if (!this.degradationFlags.skipTrending) {
      try {
        suggestions = await this.applyTrendingBoost(suggestions)
      } catch (error) {
        logger.warn({ event: 'trending_skipped', error: error.message })
        this.degradationFlags.skipTrending = true
      }
    }

    // Reduce count if under heavy load
    const limit = this.degradationFlags.reduceSuggestionCount ? 3 : options.limit || 5
    return suggestions.slice(0, limit)
  }

  async getPopularSuggestions(prefix) {
    // Pre-computed popular suggestions by first character
    const cacheKey = `popular:${prefix.charAt(0).toLowerCase()}`
    const cached = await redis.get(cacheKey)

    if (cached) {
      const allPopular = JSON.parse(cached)
      return allPopular.filter(s =>
        s.phrase.toLowerCase().startsWith(prefix.toLowerCase())
      ).slice(0, 10)
    }

    return []
  }
}
```

### Backup and Restore (Local Development)

```javascript
// backup.js - Local development backup/restore procedures
class BackupManager {
  constructor(backupDir = './backups') {
    this.backupDir = backupDir
  }

  // Backup trie state to JSON file
  async backupTrie(trie, backupName) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `${this.backupDir}/trie_${backupName}_${timestamp}.json`

    const serialized = trie.serialize()
    await fs.writeFile(filename, serialized)

    logger.info({
      event: 'trie_backup_created',
      filename,
      sizeBytes: serialized.length
    })

    return filename
  }

  // Restore trie from backup
  async restoreTrie(filename) {
    const data = await fs.readFile(filename, 'utf-8')
    const parsed = JSON.parse(data)

    const trie = new Trie()
    this.deserializeIntoTrie(trie.root, parsed)

    logger.info({
      event: 'trie_restored',
      filename
    })

    return trie
  }

  deserializeIntoTrie(node, data) {
    node.suggestions = data.suggestions || []
    for (const [char, childData] of Object.entries(data.children || {})) {
      node.children.set(char, new TrieNode())
      this.deserializeIntoTrie(node.children.get(char), childData)
    }
  }

  // Backup PostgreSQL tables
  async backupDatabase(backupName) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `${this.backupDir}/db_${backupName}_${timestamp}.sql`

    // Use pg_dump for PostgreSQL
    await execPromise(`pg_dump -h localhost -U typeahead -d typeahead_dev -t phrase_counts -t filtered_phrases -f ${filename}`)

    logger.info({
      event: 'database_backup_created',
      filename,
      tables: ['phrase_counts', 'filtered_phrases']
    })

    return filename
  }

  // Restore database from backup
  async restoreDatabase(filename) {
    // Drop and recreate tables
    await db.query('TRUNCATE phrase_counts, filtered_phrases')

    // Restore from dump
    await execPromise(`psql -h localhost -U typeahead -d typeahead_dev -f ${filename}`)

    logger.info({
      event: 'database_restored',
      filename
    })
  }

  // Redis backup (RDB snapshot)
  async backupRedis(backupName) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `${this.backupDir}/redis_${backupName}_${timestamp}.rdb`

    // Trigger Redis BGSAVE
    await redis.bgsave()

    // Wait for completion
    let saving = true
    while (saving) {
      await new Promise(r => setTimeout(r, 100))
      const info = await redis.info('persistence')
      saving = info.includes('rdb_bgsave_in_progress:1')
    }

    // Copy the dump file
    await execPromise(`cp /var/lib/redis/dump.rdb ${filename}`)

    logger.info({
      event: 'redis_backup_created',
      filename
    })

    return filename
  }

  // List available backups
  async listBackups() {
    const files = await fs.readdir(this.backupDir)
    return files
      .filter(f => f.endsWith('.json') || f.endsWith('.sql') || f.endsWith('.rdb'))
      .sort()
      .reverse()
  }
}

// Admin endpoints for backup/restore
app.post('/api/v1/admin/backup', authMiddleware, async (req, res) => {
  const { type, name } = req.body  // type: 'trie', 'database', 'redis', 'all'
  const backupManager = new BackupManager()
  const results = {}

  if (type === 'trie' || type === 'all') {
    results.trie = await backupManager.backupTrie(globalTrie, name)
  }
  if (type === 'database' || type === 'all') {
    results.database = await backupManager.backupDatabase(name)
  }
  if (type === 'redis' || type === 'all') {
    results.redis = await backupManager.backupRedis(name)
  }

  auditLogger.logBackup(type, name, req.userId, results)
  res.json({ success: true, backups: results })
})
```

### Health Checks

```javascript
// health.js - Comprehensive health check endpoints
app.get('/health', async (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/health/ready', async (req, res) => {
  const checks = {
    trie: { status: 'unknown' },
    redis: { status: 'unknown' },
    postgres: { status: 'unknown' },
    kafka: { status: 'unknown' }
  }

  // Check trie is loaded
  try {
    const phraseCount = globalTrie ? globalTrie.getPhraseCount() : 0
    checks.trie = {
      status: phraseCount > 0 ? 'healthy' : 'degraded',
      phraseCount
    }
  } catch (error) {
    checks.trie = { status: 'unhealthy', error: error.message }
  }

  // Check Redis connectivity
  try {
    const pong = await redis.ping()
    checks.redis = { status: pong === 'PONG' ? 'healthy' : 'unhealthy' }
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: error.message }
  }

  // Check PostgreSQL connectivity
  try {
    const result = await db.query('SELECT 1')
    checks.postgres = { status: 'healthy' }
  } catch (error) {
    checks.postgres = { status: 'unhealthy', error: error.message }
  }

  // Check Kafka consumer
  try {
    const lag = await getKafkaConsumerLag()
    checks.kafka = {
      status: lag < 10000 ? 'healthy' : 'degraded',
      consumerLag: lag
    }
  } catch (error) {
    checks.kafka = { status: 'unhealthy', error: error.message }
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy')
  const anyUnhealthy = Object.values(checks).some(c => c.status === 'unhealthy')

  const overallStatus = allHealthy ? 'healthy' : (anyUnhealthy ? 'unhealthy' : 'degraded')

  res.status(overallStatus === 'unhealthy' ? 503 : 200).json({
    status: overallStatus,
    checks,
    timestamp: new Date().toISOString()
  })
})

// Circuit breaker status endpoint
app.get('/health/circuits', async (req, res) => {
  const circuits = {}
  for (const [shardId, circuit] of shardCircuits) {
    circuits[`shard_${shardId}`] = circuit.getState()
  }
  res.json({ circuits })
})
```

### Multi-Region Disaster Recovery (Design Notes)

For a local development project, true multi-region DR is not implemented. However, the architecture supports the following patterns if needed:

**Active-Passive Setup:**
```
Primary Region (active):
  - Receives all writes
  - Handles read traffic
  - Replicates to secondary

Secondary Region (passive):
  - Receives replicated data
  - Read-only mode
  - Can be promoted on primary failure

Replication Strategy:
  - PostgreSQL: Streaming replication (async, ~1s lag)
  - Redis: Redis replication or Valkey cluster
  - Kafka: MirrorMaker 2 for topic replication
  - Trie: Rebuild from replicated PostgreSQL data
```

**Failover Procedure (documented for learning):**
1. Detect primary region failure (health check timeout)
2. Promote secondary PostgreSQL to primary
3. Update DNS/load balancer to point to secondary
4. Rebuild trie from promoted database
5. Resume Kafka consumers in secondary region
6. Mark old primary as secondary for repair

---

## Implementation Notes

This section documents the production-ready features implemented in the backend and explains **why** each is critical for a typeahead system.

### Redis Caching for Popular Queries

**Location:** `/backend/src/shared/metrics.js`, `/backend/src/services/suggestion-service.js`

**WHY caching is CRITICAL for typeahead latency (<50ms):**

1. **User Experience Depends on Speed**: Users type at 150-300ms per keystroke. If suggestions take >50ms, they arrive after the next keystroke, causing jarring UI updates and perceived lag.

2. **Hot Prefixes Dominate Traffic**: The Zipf distribution applies to search queries. The top 1% of prefixes (like "a", "th", "wh") receive >50% of traffic. Caching these provides massive latency wins.

3. **Trie Traversal is Fast but Not Free**: While trie lookups are O(prefix_length), the ranking, personalization, and trending boost calculations add latency. Caching the final ranked results avoids repeated computation.

4. **Cache Effectiveness is High**: With a 60-second TTL and prefix locality, cache hit rates typically exceed 80%. This means 4 out of 5 requests skip trie operations entirely.

```javascript
// Cache key design: prefix -> ranked suggestions
// TTL: 60 seconds balances freshness vs performance
const cacheKey = `suggestions:${prefix}`;
await redis.setex(cacheKey, 60, JSON.stringify(suggestions));
```

### Rate Limiting for Query Protection

**Location:** `/backend/src/shared/rate-limiter.js`

**WHY rate limiting prevents search abuse:**

1. **Bot Protection**: Scrapers and automated tools can flood the typeahead API to extract trending data or map the entire suggestion space. Rate limiting forces them to slow down.

2. **DoS Mitigation**: A single malicious user could send thousands of requests per second, degrading service for legitimate users. Per-client rate limits prevent this.

3. **Resource Protection**: Each suggestion request consumes CPU (trie traversal), memory (result building), and potentially database connections (logging). Unbounded requests exhaust these resources.

4. **Fair Usage**: Rate limits ensure no single user monopolizes capacity during peak times, maintaining consistent latency for everyone.

```javascript
// Tiered rate limits by endpoint sensitivity:
// - Suggestions: 20 req/sec (fast typing)
// - Query logging: 5 req/sec (writes to DB)
// - Admin operations: 30 req/min (expensive)
```

### Circuit Breakers for Search Index Protection

**Location:** `/backend/src/shared/circuit-breaker.js`, `/backend/src/routes/suggestions.js`

**WHY circuit breakers protect the search index:**

1. **Cascading Failure Prevention**: If the trie or Redis becomes slow or unresponsive, continued requests pile up, exhausting connection pools and memory. Circuit breakers fail fast when problems are detected.

2. **Automatic Recovery Testing**: The half-open state allows controlled testing of recovery. Rather than flooding a recovering service, circuit breakers send limited probe requests.

3. **Graceful Degradation**: When circuits open, fallback behavior returns empty suggestions or cached stale data. The user experience degrades gracefully rather than failing completely.

4. **Thundering Herd Prevention**: Without circuit breakers, when a service recovers, all backed-up requests surge simultaneously. Circuit breakers' gradual reopening prevents this.

```javascript
// Circuit configuration for typeahead:
// - 100ms timeout (fail fast, typeahead must be fast)
// - 30% error threshold (open if 3 of 10 fail)
// - 5 second reset (try again quickly)
const circuit = createCircuitBreaker('suggestions', fn, {
  timeout: 100,
  errorThresholdPercentage: 30,
  resetTimeout: 5000,
});
```

### Prometheus Metrics for Ranking Optimization

**Location:** `/backend/src/shared/metrics.js`, `/backend/src/routes/suggestions.js`

**WHY query metrics enable ranking optimization:**

1. **Latency SLO Monitoring**: Prometheus histograms track P50/P95/P99 latency. Alerts fire when P99 exceeds 50ms, enabling proactive capacity planning before users notice degradation.

2. **Cache Effectiveness Tuning**: Cache hit rate metrics reveal whether TTLs are too short (low hit rate) or too long (stale data). Adjusting TTLs based on data improves both freshness and performance.

3. **Query Pattern Analysis**: Prefix length distribution reveals user behavior. If most queries are 1-2 characters, prefix precomputation should focus there. If 5+ characters dominate, different optimization strategies apply.

4. **Ranking Quality Signals**: By tracking which suggestions are returned and correlating with click-through data (from query logging), ranking weights can be optimized. A/B testing becomes data-driven.

5. **Capacity Planning**: Request rate trends and suggestion count distributions help predict when to scale horizontally or add trie shards.

```javascript
// Key metrics for typeahead optimization:
typeahead_suggestion_latency_seconds{endpoint, cache_hit, status}
typeahead_suggestion_requests_total{endpoint, status}
typeahead_cache_hit_rate{cache_type}
typeahead_query_prefix_length (histogram)
typeahead_suggestion_count (histogram)
```

### Structured JSON Logging with Pino

**Location:** `/backend/src/shared/logger.js`

**WHY structured logging is essential:**

1. **Machine Parseable**: JSON logs integrate with log aggregation systems (ELK, Splunk, Datadog) for searching, filtering, and dashboards.

2. **Correlation IDs**: Each request gets a unique ID that propagates through all log entries, enabling end-to-end tracing of individual requests.

3. **Audit Trail**: Sensitive operations (filter changes, trie rebuilds, cache invalidations) are logged with actor information for compliance and debugging.

4. **Performance Context**: Log entries include latency, cache hit status, and suggestion count, enabling performance analysis from logs alone.

```javascript
// Structured log entry example:
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "service": "typeahead",
  "requestId": "abc-123",
  "event": "suggestion_request",
  "prefix": "weat",
  "durationMs": 12,
  "cacheHit": true,
  "suggestionCount": 5
}
```

### Idempotency for Index Updates

**Location:** `/backend/src/shared/idempotency.js`, `/backend/src/routes/admin.js`

**WHY idempotency is critical for typeahead index updates:**

1. **Safe Retries**: Network failures, timeouts, and client crashes mean requests may be sent multiple times. Without idempotency, phrase counts could be incremented multiple times erroneously.

2. **Distributed Consistency**: In a multi-server deployment, the same update might arrive at different servers. Idempotency keys prevent duplicate processing regardless of which server handles retries.

3. **At-Least-Once Semantics**: Kafka message consumption and webhook delivery often use at-least-once delivery. Idempotency enables exactly-once processing semantics.

4. **Replay Safety**: During disaster recovery, message queues may be replayed from earlier offsets. Idempotent handlers skip already-processed messages.

```javascript
// Idempotency key generation:
// Hash of operation + payload = deterministic key
const key = generateIdempotencyKey('phrase_add', { phrase, count });

// Check before processing:
const cached = await idempotencyHandler.check(key);
if (cached) {
  return cached.result; // Skip duplicate
}
```

### Health Check Endpoints

**Location:** `/backend/src/index.js`

**Implementation:**

- `/health` - Basic liveness probe (always returns 200 if server is running)
- `/health/ready` - Readiness probe checking trie, Redis, PostgreSQL
- `/health/circuits` - Circuit breaker states for debugging
- `/status` - Detailed system status with memory, connections, trie stats

**WHY comprehensive health checks matter:**

1. **Load Balancer Integration**: Kubernetes and nginx use readiness probes to route traffic only to healthy instances.

2. **Graceful Rollouts**: During deployments, new instances become ready only after the trie is loaded, preventing empty-trie responses.

3. **Debugging Production Issues**: Circuit breaker and connection pool visibility helps diagnose cascading failures.

---

## API Endpoints Summary

### Metrics and Monitoring

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/metrics` | GET | Prometheus metrics endpoint |
| `/health` | GET | Basic liveness probe |
| `/health/ready` | GET | Readiness probe with dependency checks |
| `/health/circuits` | GET | Circuit breaker states |
| `/status` | GET | Detailed system status |

### Suggestion API

| Endpoint | Method | Rate Limit | Description |
|----------|--------|------------|-------------|
| `/api/v1/suggestions?q=...` | GET | 20/sec | Get suggestions for prefix |
| `/api/v1/suggestions/log` | POST | 5/sec | Log completed search |
| `/api/v1/suggestions/trending` | GET | - | Get trending queries |
| `/api/v1/suggestions/popular` | GET | - | Get popular queries |
| `/api/v1/suggestions/history?userId=...` | GET | - | Get user history |

### Admin API

| Endpoint | Method | Idempotent | Description |
|----------|--------|------------|-------------|
| `/api/v1/admin/trie/stats` | GET | N/A | Get trie statistics |
| `/api/v1/admin/trie/rebuild` | POST | Yes | Rebuild trie from database |
| `/api/v1/admin/phrases` | POST | Yes | Add/update phrase |
| `/api/v1/admin/phrases/:phrase` | DELETE | Yes | Remove phrase |
| `/api/v1/admin/filter` | POST | Yes | Add to filter list |
| `/api/v1/admin/filter/:phrase` | DELETE | No | Remove from filter list |
| `/api/v1/admin/filtered` | GET | N/A | List filtered phrases |
| `/api/v1/admin/cache/clear` | POST | Yes | Clear suggestion cache |
| `/api/v1/admin/status` | GET | N/A | System status |

---

## Frontend Architecture

The frontend is built with React, TypeScript, and Tailwind CSS, following a component-based architecture with clear separation of concerns.

### Directory Structure

```
frontend/src/
├── components/
│   ├── admin/                    # Admin dashboard components
│   │   ├── index.ts              # Barrel export for admin components
│   │   ├── TabButton.tsx         # Navigation tab button
│   │   ├── StatusCard.tsx        # Service status indicator card
│   │   ├── StatCard.tsx          # Simple statistics display card
│   │   ├── LoadingState.tsx      # Loading spinner component
│   │   ├── ErrorState.tsx        # Error message display
│   │   ├── OverviewTab.tsx       # System overview dashboard tab
│   │   ├── AnalyticsTab.tsx      # Analytics and charts tab
│   │   └── ManagementTab.tsx     # Admin management controls tab
│   ├── icons/                    # Reusable SVG icon components
│   │   ├── index.ts              # Barrel export for icons
│   │   ├── CheckCircleIcon.tsx   # Success/health status icon
│   │   ├── ServerIcon.tsx        # Server/infrastructure icon
│   │   └── DatabaseIcon.tsx      # Database service icon
│   ├── index.ts                  # Main components barrel export
│   ├── SearchBox.tsx             # Main search input with autocomplete
│   ├── TrendingList.tsx          # Trending searches display
│   └── SearchSettings.tsx        # Search configuration panel
├── routes/
│   ├── __root.tsx                # Root layout component
│   ├── index.tsx                 # Home page (search interface)
│   └── admin.tsx                 # Admin dashboard page
├── services/
│   └── api.ts                    # API client service
├── stores/
│   └── search-store.ts           # Zustand store for search state
├── hooks/
│   └── index.ts                  # Custom React hooks
├── types/
│   └── index.ts                  # TypeScript type definitions
└── utils/
    ├── index.ts                  # Utilities barrel export
    └── formatters.ts             # Formatting utility functions
```

### Component Organization Principles

1. **Feature-based grouping**: Components are grouped by feature area (admin, icons) rather than by type.

2. **Barrel exports**: Each directory has an `index.ts` that re-exports all public components, enabling clean imports:
   ```typescript
   import { OverviewTab, TabButton } from '../components/admin';
   import { CheckCircleIcon } from '../components/icons';
   ```

3. **Icon components**: SVG icons are extracted into separate component files, avoiding inline SVG clutter and enabling reusability.

4. **Sub-components**: Large components are split into smaller, focused sub-components within the same file when tightly coupled, or into separate files when reusable.

### Admin Dashboard Components

The admin dashboard (`/admin` route) uses a tabbed interface with three main sections:

| Component | Lines | Description |
|-----------|-------|-------------|
| `TabButton` | 27 | Reusable navigation tab button |
| `StatusCard` | 35 | Service health indicator with icon |
| `StatCard` | 18 | Simple metric display card |
| `LoadingState` | 12 | Centered loading spinner |
| `ErrorState` | 17 | Error message container |
| `OverviewTab` | 160 | System status, metrics, and resources |
| `AnalyticsTab` | 118 | Query charts and top phrases table |
| `ManagementTab` | 228 | System actions and phrase management |

### Utility Functions

The `utils/formatters.ts` file contains pure formatting functions:

- `formatUptime(seconds)` - Converts seconds to human-readable duration (e.g., "2d 5h")
- `formatBytes(bytes)` - Converts bytes to human-readable size (e.g., "256.0 MB")

### State Management

- **Zustand** for global state (`search-store.ts`) - manages search query, suggestions, and user preferences
- **React state** for local UI state - tab selection, form inputs, loading states

### API Integration

The `api.ts` service provides a typed API client with methods for:
- Suggestions: `getSuggestions()`, `logSearch()`, `getTrending()`, `getHistory()`
- Analytics: `getAnalyticsSummary()`, `getHourlyStats()`, `getTopPhrases()`
- Admin: `getSystemStatus()`, `rebuildTrie()`, `clearCache()`, `addPhrase()`, `filterPhrase()`

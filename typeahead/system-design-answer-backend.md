# Typeahead - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 📋 Introduction

"Today I'll design the backend infrastructure for a typeahead autocomplete system. This is one of the most latency-sensitive systems in any search product - users expect instant suggestions as they type, typically within 50 milliseconds. I'll walk through the core data structures, sharding strategy, ranking approach, and the real-time pipeline that keeps suggestions fresh."

---

## 🎯 Requirements

### Functional Requirements

1. **Suggest** - Return top suggestions for any prefix typed by the user
2. **Rank** - Order suggestions by relevance combining popularity, recency, and personalization
3. **Personalize** - Boost suggestions based on user's search history
4. **Update** - Reflect trending topics in near real-time (within 5 minutes)
5. **Filter** - Remove inappropriate or blocked content from suggestions

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Latency | P99 < 50ms | Users expect instant feedback while typing |
| Availability | 99.99% | Core to search experience |
| Scale | 100K+ QPS | Peak traffic during major events |
| Freshness | < 5 minutes | Trending topics must surface quickly |

### Scale Estimates

- Unique phrases indexed: 1 billion
- Queries per second at peak: 100,000+
- Suggestions per request: 5-10
- Index update frequency: Every minute for trending, nightly for full rebuild

---

## 🏗️ High-Level Design

"Let me sketch the high-level architecture on the whiteboard."

```
+------------------------------------------------------------------+
|                        CLIENT LAYER                               |
|              Search Box  |  Mobile App  |  API                    |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                       API GATEWAY                                 |
|              Load Balancing  |  Rate Limiting  |  CDN             |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                   SUGGESTION SERVICE                              |
|        Prefix Matching  |  Ranking  |  Personalization            |
+------------------------------------------------------------------+
        |                      |                      |
        v                      v                      v
+----------------+    +----------------+    +----------------+
|  TRIE SERVERS  |    | RANKING SERVICE|    |   USER DATA    |
|                |    |                |    |                |
| - Sharded by   |    | - Score calc   |    | - History      |
|   first char   |    | - Trending     |    | - Preferences  |
| - In-memory    |    | - Weights      |    | - Redis cache  |
+----------------+    +----------------+    +----------------+
                               |
                               v
+------------------------------------------------------------------+
|                  AGGREGATION PIPELINE                             |
|      Query Logs --> Kafka --> Count --> Filter --> Trie Build     |
+------------------------------------------------------------------+
        |                      |                      |
        v                      v                      v
+----------------+    +----------------+    +----------------+
|    KAFKA       |    |  POSTGRESQL    |    |     REDIS      |
|                |    |                |    |                |
| - Query stream |    | - Phrase counts|    | - Trending     |
| - Partitioned  |    | - User history |    | - Cache layer  |
+----------------+    +----------------+    +----------------+
```

"The key insight is separating the read path from the write path. The read path needs to be extremely fast - we serve suggestions directly from in-memory tries. The write path can be eventually consistent - we aggregate query logs through Kafka and periodically update the tries."

---

## 🔍 Deep Dive: Trie Data Structure

"The core of this system is choosing the right data structure for prefix matching. Let me walk through the options."

### Why Trie Over Inverted Index or Elasticsearch?

| Approach | Prefix Lookup | Memory | Update Cost | Fuzzy Support | Best For |
|----------|---------------|--------|-------------|---------------|----------|
| **Trie with Top-K** | O(prefix_len) | Higher | O(k log k) | No | Exact prefix matching |
| Radix Trie | O(prefix_len) | Medium | O(k log k) | No | Memory-constrained prefix |
| DAWG | O(prefix_len) | Low | Expensive rebuild | No | Static datasets |
| Inverted Index | O(1) hash + scan | Medium | O(1) | Yes | Full-text search |
| Elasticsearch | O(1) | High | Near real-time | Yes | Complex queries |

**Decision: Trie with pre-computed top-K**

"I'm choosing a trie with pre-computed top-K suggestions at each node because our primary access pattern is exact prefix matching. When a user types 'weat', I need to instantly return 'weather', 'weather forecast', 'weather today'. A trie gives me O(prefix_length) lookup - I just traverse down the tree following each character.

The key optimization is storing the top-K suggestions at every node, not just at leaf nodes. When I reach the node for 'weat', I already have the top 10 suggestions pre-computed. I don't need to traverse the entire subtree to find them.

Elasticsearch would work for fuzzy matching, but it adds network latency and complexity we don't need for exact prefix matching. An inverted index is great for full-text search but doesn't handle the 'starts with' pattern efficiently."

### Why Pre-computed Top-K Over Traversal?

| Approach | Query Time | Space | Update Cost | When to Use |
|----------|------------|-------|-------------|-------------|
| **Pre-computed top-K** | O(prefix_len) | Higher | O(k log k) per update | High QPS, latency-critical |
| Traverse subtree | O(subtree size) | Lower | O(1) | Low QPS, memory-constrained |
| Hybrid (lazy compute) | O(prefix_len) + compute | Medium | O(1) | Medium QPS |

**Decision: Pre-computed top-K at each node**

"The trade-off here is memory versus latency. By storing top-10 suggestions at every node in the trie, I'm using significantly more memory - roughly 10x more. But at 100K QPS, I cannot afford to traverse subtrees. A popular prefix like 'the' might have millions of completions.

With pre-computed top-K, my lookup is always O(prefix_length) - typically 3-10 character comparisons. I can serve suggestions in under 10 milliseconds, leaving plenty of headroom for network latency and ranking.

The update cost is O(k log k) per insertion, since I need to re-sort the suggestions. But updates happen in the background aggregation pipeline, not in the request path."

---

## 🔍 Deep Dive: Sharding Strategy

"With a billion phrases, I need to shard the trie across multiple servers. Let me discuss the options."

### Why First-Character Sharding Over Consistent Hashing?

| Strategy | Prefix Locality | Distribution | Routing | Hot Spots |
|----------|-----------------|--------------|---------|-----------|
| **First character** | Excellent | Uneven (s > x) | Simple | Yes ('s', 'a', 't') |
| First 2 characters | Good | Better | Simple | Fewer |
| Consistent hashing | None | Even | Hash lookup | No |
| Range-based | Good | Configurable | Range lookup | Tunable |

**Decision: First-character sharding with hot spot mitigation**

"I'm choosing first-character sharding because it preserves prefix locality. When a user types 'a', then 'ap', then 'app', all these queries go to the same shard. This means I can cache effectively at the shard level, and I don't need to fan out queries to multiple shards.

The downside is uneven distribution. The 's' shard will be much larger than the 'x' shard. To handle this, I use sub-sharding for hot characters:

```
+------------------+     +------------------+     +------------------+
|   SHARD 'a'      |     |   SHARD 'a'      |     |   SHARD 'a'      |
|   (sub-shard 1)  |     |   (sub-shard 2)  |     |   (sub-shard 3)  |
|   aa-ah          |     |   ai-ap          |     |   aq-az          |
+------------------+     +------------------+     +------------------+
```

For the 'a' prefix, I look at the second character to pick the sub-shard. The 'x' shard might only have one server, while 's' has three. This lets me scale hot spots independently.

Consistent hashing would give even distribution, but I'd need to query all shards for every prefix - that's unacceptable latency at our scale."

---

## 🔍 Deep Dive: Ranking Algorithm

"Once I have candidate suggestions from the trie, I need to rank them. Let me walk through the ranking approach."

### Why Weighted Formula Over ML Ranking?

| Approach | Personalization | Latency | Complexity | Explainability |
|----------|-----------------|---------|------------|----------------|
| **Weighted formula** | Basic | <1ms | Low | High |
| ML model (LTR) | Advanced | 5-20ms | High | Low |
| Two-stage ranking | Advanced | 2-10ms | Medium | Medium |
| Contextual bandits | Adaptive | 1-5ms | Medium | Medium |

**Decision: Weighted formula with tunable weights**

"I'm choosing a weighted formula because it's fast, explainable, and sufficient for our needs. At sub-50ms latency requirements, I cannot afford 10-20ms for ML model inference.

My ranking formula combines five signals:

```
+------------------------+--------+------------------------------------+
|       Signal           | Weight |           Calculation              |
+------------------------+--------+------------------------------------+
| Popularity             |  30%   | log10(search_count + 1)            |
| Recency                |  15%   | Exponential decay, 1-week half-life|
| Personalization        |  25%   | Match against user's search history|
| Trending               |  20%   | Sliding window counter score       |
| Match quality          |  10%   | How closely prefix matches phrase  |
+------------------------+--------+------------------------------------+
```

Logarithmic scaling for popularity prevents mega-popular queries from dominating. Recency decay means suggestions stay fresh. Personalization uses the user's recent searches stored in Redis. Trending comes from sliding window counters that detect spikes in the last few minutes.

If we needed deeper personalization later, I could add a lightweight ML re-ranker as a second stage - retrieve 50 candidates with the formula, then re-rank to top 10 with ML. But I'd start simple."

---

## 🔍 Deep Dive: Real-Time Aggregation Pipeline

"The aggregation pipeline is what keeps our suggestions fresh. Let me explain the architecture."

### Why Kafka for Aggregation Over Direct DB Writes?

| Approach | Throughput | Latency to Trie | Complexity | Durability |
|----------|------------|-----------------|------------|------------|
| **Kafka stream** | 100K+/sec | 1-5 min | Medium | High |
| Direct DB writes | 10K/sec | Real-time | Low | High |
| In-memory only | 500K+/sec | Immediate | Low | None |
| Redis Streams | 50K+/sec | Seconds | Low | Medium |

**Decision: Kafka with buffered aggregation**

"I'm using Kafka because I need to handle 100K+ queries per second reliably. Direct database writes would bottleneck at 10-20K per second, and I'd risk losing data during spikes.

The pipeline works like this:

```
+------------+     +------------+     +------------+     +------------+
|   Query    |     |   Kafka    |     | Aggregator |     |   Trie     |
|   Logs     | --> |   Topic    | --> |  Workers   | --> |  Servers   |
+------------+     +------------+     +------------+     +------------+
                        |
                        v
               +----------------+
               |  Partitioned   |
               |  by first char |
               +----------------+

Aggregator Workers:
+-------------------------------------------------------+
| 1. Buffer queries in memory (30-60 seconds)           |
| 2. Filter low-quality: too short, too long, spam      |
| 3. Filter inappropriate: blocked phrase list          |
| 4. Aggregate counts per phrase                        |
| 5. Flush to PostgreSQL (phrase_counts table)          |
| 6. Update trending counters in Redis                  |
| 7. Send delta updates to trie servers                 |
+-------------------------------------------------------+
```

I partition Kafka by first character to match my trie sharding. This means the aggregator worker for 'a' phrases only talks to the 'a' trie shard - no cross-shard coordination needed.

The buffering is important. Instead of updating the trie on every query, I batch updates every 30-60 seconds. This reduces write amplification and lets me do incremental top-K updates efficiently."

### Why Redis for Trending Over PostgreSQL?

| Storage | Read Latency | Write Throughput | Data Structure | Best For |
|---------|--------------|------------------|----------------|----------|
| **Redis sorted sets** | <1ms | 100K+/sec | ZINCRBY + ZRANGE | Real-time counters |
| PostgreSQL | 5-20ms | 10K/sec | Row updates | Persistent storage |
| ClickHouse | 10-50ms | High batch | Aggregation | Analytics queries |
| In-memory counter | <0.1ms | Unlimited | Map | Single-node only |

**Decision: Redis sorted sets with sliding windows**

"For trending detection, I use Redis sorted sets because I need sub-millisecond reads and very high write throughput.

I implement sliding window counters:

```
+------------------+     +------------------+     +------------------+
| Window 1         |     | Window 2         |     | Window 3         |
| (5 min bucket)   |     | (5 min bucket)   |     | (5 min bucket)   |
| trending:12345   |     | trending:12346   |     | trending:12347   |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        +------------------------+------------------------+
                                 |
                                 v
                    +------------------------+
                    | Aggregate last 6 windows|
                    | to get 30-min trending  |
                    +------------------------+
```

Each 5-minute window is a Redis sorted set. The key includes the timestamp bucket. I ZINCRBY to increment counts, and ZRANGE to get top trending. Windows expire after an hour automatically.

To get trending, I read the last 6 windows and merge them. A query that spiked from 100/hour to 10,000/hour gets a high trending boost. PostgreSQL could store this, but the read latency would hurt my P99."

---

## 📊 Data Models

"Let me describe the key data entities without getting into schema details."

### Phrase Counts Table

The primary storage for aggregated phrase popularity. Each row represents a unique search phrase with its cumulative count, last update timestamp, and filter status. Indexed by count descending for efficient top-K queries during trie rebuilds.

### Query Logs Table

Raw query stream for aggregation and analytics. Stores each query with user ID, timestamp, and session ID. High-volume append-only table, partitioned by time. Retained for 30 days for analytics, then archived.

### User History Table

Per-user search history for personalization. Keyed by user ID and phrase, stores count and recency. Limited to last 1000 searches per user. Also cached in Redis for fast lookup during ranking.

### Filtered Phrases Table

Blocklist for inappropriate content. Checked during aggregation pipeline before phrases enter the trie. Managed by content moderation team through admin interface.

### Redis Data Structures

- **Suggestion cache**: Key-value with prefix as key, top-K suggestions as value, 60-second TTL
- **Trending counters**: Sorted sets keyed by time bucket, phrase as member, count as score
- **User history cache**: Hash map keyed by user ID, recent phrases with timestamps

---

## 🔍 Deep Dive: Caching Strategy

"Caching is critical for hitting our latency targets. Let me walk through the multi-layer approach."

```
+------------------------------------------------------------------+
|                         REQUEST                                   |
|              GET /api/v1/suggestions?q=weat                       |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                    LAYER 1: CDN EDGE                              |
|              Popular prefixes cached at edge                      |
|              Hit rate: 30-40% for hot prefixes                    |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                    LAYER 2: REDIS                                 |
|              Full suggestion cache                                |
|              Key: suggestions:{prefix}                            |
|              TTL: 60 seconds                                      |
|              Hit rate: 60-70% after CDN                           |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                    LAYER 3: TRIE SERVER                           |
|              In-memory trie lookup                                |
|              Pre-computed top-K at each node                      |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                    LAYER 4: RANKING                               |
|              Apply personalization + trending                     |
|              Cache result back to Redis                           |
+------------------------------------------------------------------+
```

**Cache key design matters.** I use the raw prefix as the key, not a hash. This lets me do prefix-based cache warming - when I update the trie for "weather", I can invalidate all keys starting with "weat".

**TTL of 60 seconds** balances freshness with hit rate. For trending events, I might reduce this to 30 seconds. For stable phrases, I could extend to 5 minutes. Adaptive TTL based on phrase volatility is a future optimization.

**Stale-while-revalidate** at the CDN layer means users always get a fast response, even if slightly stale. The CDN serves the cached response while fetching a fresh one in the background.

---

## ⚖️ Trade-offs Summary

| Decision | Chose | Over | Rationale |
|----------|-------|------|-----------|
| Data structure | Trie with top-K | Elasticsearch | O(prefix_len) lookup, no network hop |
| Query optimization | Pre-computed top-K | Subtree traversal | 100K QPS requires <10ms lookup |
| Sharding | First character | Consistent hashing | Prefix locality enables effective caching |
| Ranking | Weighted formula | ML ranking | Sub-1ms compute, explainable, tunable |
| Ingestion | Kafka pipeline | Direct DB writes | Handles 100K+/sec, decouples read/write |
| Trending | Redis sorted sets | PostgreSQL | Sub-1ms reads, native counter support |
| Cache TTL | 60 seconds | Longer/shorter | Balance freshness vs hit rate |

---

## 🚀 Future Enhancements

**Fuzzy Matching**: Add edit-distance tolerance for typo correction. Could use a secondary index mapping common misspellings to correct phrases, or BK-trees for edit distance lookup.

**ML-Based Ranking**: Once we have sufficient click-through data, train a learning-to-rank model. Use the weighted formula as a first-stage retriever (top 50), then ML for final ranking (top 10).

**Real-Time Streaming**: WebSocket connections for instant trending updates. When a major event happens, push new suggestions to connected clients without waiting for their next keystroke.

**Geo-Sharding**: Region-specific suggestions. "Pizza near me" should return different results in New York versus Tokyo. Separate tries per region, or geo-tagged phrases with location-aware ranking.

**A/B Testing Framework**: Experiment with ranking weights systematically. Run parallel ranking algorithms and measure click-through rate, time-to-click, and search success rate.

---

## 📝 Summary

"To summarize the typeahead system I've designed:

**Core architecture**: In-memory tries with pre-computed top-K suggestions, sharded by first character across multiple servers. This gives O(prefix_length) lookups regardless of how many phrases match.

**Ranking**: A weighted formula combining popularity, recency, personalization, and trending. Fast enough to compute in under 1ms, and tunable based on A/B test results.

**Real-time pipeline**: Kafka ingests query logs at 100K+/sec, aggregator workers buffer and filter, then push delta updates to tries every minute. Redis tracks trending with sliding window counters.

**Caching**: Three-layer cache with CDN edge, Redis, and in-memory trie. Combined hit rate over 95% for popular prefixes.

**Key trade-offs**: I optimized for latency over memory (pre-computed top-K), simplicity over sophistication (weighted formula over ML), and locality over balance (first-character sharding over consistent hashing).

The system handles 100K+ QPS at sub-50ms P99 latency while keeping suggestions fresh within 5 minutes. Questions?"

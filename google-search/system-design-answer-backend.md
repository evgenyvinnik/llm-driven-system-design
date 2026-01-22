# Google Search - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 📋 Introduction

"Thank you for this opportunity. I'll be designing the backend infrastructure for a web search engine. This is one of the most challenging distributed systems problems because it touches on web crawling at scale, inverted index construction, graph algorithms for ranking, and real-time query processing with strict latency requirements.

Let me start by clarifying requirements, then walk through the high-level architecture, and finally deep dive into the key backend components with explicit trade-off discussions for each decision."

---

## 🎯 Requirements

### Functional Requirements

1. **Web Crawling** - Discover and fetch web pages while respecting robots.txt
2. **Indexing** - Build and maintain an inverted index for fast keyword lookups
3. **PageRank** - Calculate link-based authority scores for ranking
4. **Query Processing** - Parse, expand, and execute search queries
5. **Ranking** - Combine multiple signals (text relevance, authority, freshness) for result ordering

### Non-Functional Requirements

1. **Scale** - Index 100B+ pages across petabytes of data
2. **Latency** - Less than 200ms p99 query response time
3. **Freshness** - Update popular pages daily, news content hourly
4. **Availability** - 99.99% uptime for query serving

### Scale Estimates

| Metric | Value | Implication |
|--------|-------|-------------|
| Total pages | 100 billion | Petabyte-scale storage |
| Average page size | 50 KB | 5 PB raw content |
| Inverted index size | ~500 TB | Compressed with posting lists |
| Daily queries | 8 billion | ~100K QPS at peak |
| Daily crawl target | 1 billion pages | Freshness maintenance |

---

## 🏗️ High-Level Design

"Let me draw the three main subsystems: the Crawl System, the Indexing Pipeline, and the Serving Layer."

```
+------------------------------------------------------------------+
|                       CRAWL SYSTEM                                |
|                                                                   |
|   +-------------+     +-------------+     +-------------+         |
|   |    URL      |---->|   Fetcher   |---->|   Parser    |         |
|   |  Frontier   |     |   Workers   |     |  (Extract)  |         |
|   | (Priority Q)|     |             |     |             |         |
|   +-------------+     +-------------+     +------+------+         |
|         ^                                        |                |
|         |                                        v                |
|         |                                 +-------------+         |
|         +<--------------------------------|   Deduper   |         |
|              (new URLs discovered)        |  (SimHash)  |         |
|                                           +-------------+         |
+------------------------------------------------------------------+
                              |
                              | (raw documents)
                              v
+------------------------------------------------------------------+
|                     INDEXING PIPELINE                             |
|                                                                   |
|   +-------------+     +-------------+     +-------------+         |
|   | Tokenizer   |---->|   Index     |---->|  Sharder    |         |
|   | (Stemming)  |     |  Builder    |     | (Term Hash) |         |
|   +-------------+     +-------------+     +------+------+         |
|                                                  |                |
|   +-------------+                                |                |
|   | PageRank    |<-------------------------------+                |
|   |   (Batch)   |     (link graph extracted)                      |
|   +-------------+                                                 |
+------------------------------------------------------------------+
                              |
                              | (indexed shards)
                              v
+------------------------------------------------------------------+
|                      SERVING LAYER                                |
|                                                                   |
|   +-------------+     +-------------+     +-------------+         |
|   |   Query     |---->|   Index     |---->|   Ranker    |         |
|   |   Parser    |     |   Servers   |     | (Two-Phase) |         |
|   | (Expansion) |     |  (Sharded)  |     |             |         |
|   +-------------+     +-------------+     +------+------+         |
|                                                  |                |
|                                           +------v------+         |
|                                           |   Result    |         |
|                                           |   Cache     |         |
|                                           +-------------+         |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                       DATA LAYER                                  |
|                                                                   |
|   +----------------+  +----------------+  +----------------+      |
|   |   PostgreSQL   |  |  Elasticsearch |  |     Redis      |      |
|   |  (URL State,   |  | (Inverted      |  |  (Query Cache, |      |
|   |   Link Graph)  |  |  Index)        |  |   Rate Limits) |      |
|   +----------------+  +----------------+  +----------------+      |
+------------------------------------------------------------------+
```

---

## 🔍 Deep Dive

### Trade-off 1: Priority-Based URL Frontier vs FIFO or Random

"The URL frontier is the brain of the crawler. I'm choosing a priority-based approach over simpler alternatives."

| Approach | ✅ Chosen / ❌ Alternative | Pros | Cons |
|----------|--------------------------|------|------|
| **Priority Queue** | ✅ Chosen | Crawls important pages first; maximizes value from limited bandwidth | Complex priority computation; requires maintaining priority signals |
| FIFO Queue | ❌ Alternative | Simple implementation; easy to distribute | Wastes resources on low-value pages; ignores page importance |
| Random Sampling | ❌ Alternative | Even coverage across web; simple to implement | Misses time-sensitive content; no control over crawl quality |

> "I'm choosing priority-based scheduling because with 100 billion pages and a budget to crawl 1 billion per day, we can only refresh 1% daily. We need to ensure that 1% includes the most important and frequently-changing pages. Priority signals include inbound link count, PageRank score from previous iteration, historical change frequency, and content type. News sites get higher priority than static documentation."

**Politeness Architecture:**

```
+-------------------+
|   Global Queue    |
| (sorted by host   |
|   priority)       |
+--------+----------+
         |
         v
+--------+----------+      +------------------+
|   Host Router     |----->|  Per-Host Queue  |----> host-a.com
+--------+----------+      +------------------+
         |
         +---------------->+------------------+
                           |  Per-Host Queue  |----> host-b.com
                           +------------------+

Each host queue enforces:
- Minimum delay between requests (from robots.txt or default 1s)
- Maximum concurrent connections
- Exponential backoff on errors
```

---

### Trade-off 2: Shard Inverted Index by Term vs by Document

"For the inverted index, I need to decide how to partition data across index servers."

| Strategy | ✅ Chosen / ❌ Alternative | Query Pattern | Pros | Cons |
|----------|--------------------------|---------------|------|------|
| **Shard by Term** | ✅ Chosen | Query only term-relevant shards | All posting lists for a term co-located; efficient single-term lookups | Multi-term queries require cross-shard coordination |
| Shard by Document | ❌ Alternative | Scatter-gather to all shards | Simple partitioning; each shard is self-contained | Every query hits ALL shards regardless of query complexity |

> "I'm choosing term-based sharding because of the query pattern. Most queries have 2-5 terms. With 256 shards, a 3-term query only needs to contact 3 shards instead of all 256. This reduces query fan-out by roughly 50x on average, which directly impacts latency and infrastructure cost.

The trade-off is that multi-term queries require a coordination layer to merge results. But this is a solved problem with scatter-gather patterns, and the latency savings from reduced fan-out far outweigh the coordination overhead."

**Index Shard Architecture:**

```
Query: "machine learning tutorial"
              |
              v
    +---------+---------+
    |  Query Coordinator |
    +---------+---------+
              |
    +---------+---------+---------+
    |         |         |         |
    v         v         v         v
+-------+ +-------+ +-------+ +-------+
|Shard  | |Shard  | |Shard  | | ...   |
|  12   | |  47   | | 183   | |       |
|"learn"| |"mach" | |"tutor"| |       |
+-------+ +-------+ +-------+ +-------+
    |         |         |
    +---------+---------+
              |
              v
    +---------+---------+
    |   Merge & Rank    |
    +-------------------+
```

---

### Trade-off 3: Batch Weekly PageRank vs Incremental or Real-Time

"PageRank computation is the core ranking signal. I need to decide update frequency."

| Strategy | ✅ Chosen / ❌ Alternative | Update Cycle | Pros | Cons |
|----------|--------------------------|--------------|------|------|
| **Batch Weekly** | ✅ Chosen | Full recompute every 7 days | Stable rankings; predictable compute cost; simple implementation | New pages wait up to a week for authority scores |
| Incremental | ❌ Alternative | After each crawl batch | Fresh ranks for new content | Complex implementation; potential oscillation; higher compute cost |
| Real-Time | ❌ Alternative | Continuous stream processing | Immediate authority updates | Very expensive; unstable rankings; may enable gaming |

> "I'm choosing weekly batch computation because PageRank is fundamentally stable. The web's link structure changes slowly relative to content. A page that has 10,000 inbound links today will have roughly 10,000 next week too.

For truly new pages, I use a hybrid approach: they get a provisional PageRank based on the authority of pages linking to them, which is refined in the next full batch run. This prevents new quality content from being completely invisible."

**PageRank Computation Flow:**

```
+------------------+
|   Link Graph     |
|   (PostgreSQL)   |
+--------+---------+
         |
         | Export to distributed
         | processing cluster
         v
+------------------+     +------------------+
|   PageRank       |---->|   Convergence    |
|   Iteration 1    |     |   Check          |
+--------+---------+     +--------+---------+
         ^                        |
         |                        | Not converged
         +------------------------+
                                  |
                                  | Converged (typically 50-100 iterations)
                                  v
                        +------------------+
                        |   Write Scores   |
                        |   to Index       |
                        +------------------+
```

---

### Trade-off 4: Two-Phase Ranking (BM25 + Re-ranking) vs Single-Phase

"Query latency is critical. I'm using a two-phase ranking approach."

| Approach | ✅ Chosen / ❌ Alternative | Latency Budget | Pros | Cons |
|----------|--------------------------|----------------|------|------|
| **Two-Phase** | ✅ Chosen | 100ms + 50ms | Fast first phase; expensive signals only on top candidates | May miss relevant docs in first phase |
| Single-Phase | ❌ Alternative | Full budget on all docs | Considers all signals for all documents | Cannot meet latency SLA at scale |
| Three-Phase | ❌ Alternative | 50ms + 50ms + 50ms | More refinement opportunities | Increased coordination overhead; complexity |

> "I'm choosing two-phase ranking because applying all ranking signals to millions of candidate documents is impossible within 200ms.

Phase 1 uses BM25 text matching to retrieve the top 1,000 candidates in about 50-100ms. This is purely lexical matching optimized for speed.

Phase 2 applies expensive signals to just these 1,000 documents: PageRank lookup, freshness decay calculation, click-through rate adjustment, and field boosts for title matches. This takes another 50-100ms but now we're only scoring 1,000 documents, not millions."

**Two-Phase Query Flow:**

```
Query enters
     |
     v
+-----------+
|  Parse &  |
|  Tokenize |  (5ms)
+-----------+
     |
     v
+-----------+
|  Phase 1  |
|   BM25    |  (50-100ms)
|  Top 1000 |
+-----------+
     |
     v
+-----------+
|  Phase 2  |
| Re-rank   |  (50-100ms)
| + PageRank|
| + Fresh   |
| + Clicks  |
+-----------+
     |
     v
+-----------+
| Return    |
| Top 10    |
+-----------+

Total: < 200ms
```

---

### Trade-off 5: Elasticsearch for Inverted Index vs Custom Implementation

"For the core inverted index, I need to decide between using existing infrastructure or building custom."

| Approach | ✅ Chosen / ❌ Alternative | Development Time | Pros | Cons |
|----------|--------------------------|------------------|------|------|
| **Elasticsearch** | ✅ Chosen | Days to weeks | Battle-tested; built-in BM25; sharding included; active community | Less control over storage format; potential overhead |
| Custom Inverted Index | ❌ Alternative | Months to years | Full control; optimized for specific access patterns | Massive engineering investment; operational burden |
| Apache Solr | ❌ Alternative | Days to weeks | Similar capabilities to ES; strong for faceting | Smaller ecosystem; less momentum |

> "I'm choosing Elasticsearch because building a custom inverted index is a multi-year engineering effort for questionable benefit. Elasticsearch provides distributed sharding, replication, BM25 scoring, and query DSL out of the box.

At Google scale, yes, you'd build custom. But for 99% of search applications, Elasticsearch's overhead is negligible compared to the development time saved. The key is understanding what Elasticsearch is doing under the hood so we can configure it properly."

---

### Trade-off 6: PostgreSQL for URL State vs Cassandra or DynamoDB

"The URL frontier and link graph need persistent storage. I need to choose the right database."

| Database | ✅ Chosen / ❌ Alternative | Access Pattern | Pros | Cons |
|----------|--------------------------|----------------|------|------|
| **PostgreSQL** | ✅ Chosen | Complex queries on URL metadata | ACID transactions; rich query language; efficient for PageRank graph queries | Scaling requires sharding strategy |
| Cassandra | ❌ Alternative | High-volume writes | Linear write scaling; no single point of failure | Poor for PageRank (cross-partition reads); eventual consistency |
| DynamoDB | ❌ Alternative | Key-value lookups | Managed scaling; predictable performance | Expensive at scale; limited query flexibility |

> "I'm choosing PostgreSQL for URL state because the access patterns are read-heavy and require complex queries. Finding the next URLs to crawl means filtering by host, sorting by priority, and respecting crawl delay constraints. PageRank computation requires traversing the link graph which benefits from SQL joins.

Cassandra would be better if we were doing simple key-value lookups at massive write scale, but our write pattern is relatively modest (1 billion URL updates per day is easily handled by sharded PostgreSQL) and our read pattern requires relational queries."

---

### Trade-off 7: Redis for Query Caching vs In-Memory Application Cache

"Query results need caching to reduce index server load. I need to choose the caching strategy."

| Approach | ✅ Chosen / ❌ Alternative | Consistency | Pros | Cons |
|----------|--------------------------|-------------|------|------|
| **Redis (Distributed)** | ✅ Chosen | Shared across instances | Single source of truth; warm cache persists across deploys; built-in TTL | Network hop for every cache check; additional infrastructure |
| In-Memory (Per-Instance) | ❌ Alternative | Local only | Zero network latency; simple implementation | Cold cache on restart; duplicated storage across instances |
| Memcached | ❌ Alternative | Shared | Battle-tested; simple protocol | Less feature-rich than Redis; no persistence option |

> "I'm choosing Redis for distributed caching because query servers are stateless and horizontally scaled. If each instance had its own cache, a popular query hitting 10 different instances would execute 10 times before all caches are warm.

With Redis, the first query execution populates the cache for all query servers. The network hop adds maybe 1-2ms but saves 100ms+ of index query time on cache hits. At 100K QPS, even a 30% cache hit rate means 30K fewer index queries per second."

---

### Trade-off 8: Adaptive TTL for Cache vs Fixed TTL

"Cache TTL strategy affects both freshness and hit rate."

| Strategy | ✅ Chosen / ❌ Alternative | Cache Hit Rate | Pros | Cons |
|----------|--------------------------|----------------|------|------|
| **Adaptive TTL** | ✅ Chosen | Higher for stable queries | Fresh results for trending topics; long cache for stable queries | Implementation complexity; requires query classification |
| Fixed TTL | ❌ Alternative | Uniform | Simple implementation; predictable behavior | Either too stale for news or too aggressive invalidation for stable queries |
| No Cache | ❌ Alternative | 0% | Always fresh | Cannot meet latency SLA at scale |

> "I'm choosing adaptive TTL because query types have vastly different freshness requirements. A query for 'today's news' needs results refreshed every 60 seconds. A query for 'python tutorial' can be cached for 10 minutes without issue.

I classify queries based on keywords (news, today, live, breaking -> short TTL) and query patterns (site: filters -> longer TTL since they're searching a specific stable site). This maximizes cache hit rate while maintaining appropriate freshness per query type."

---

## 📊 Data Flow

### End-to-End Query Path

```
User types: "machine learning python"
                    |
                    v
            +---------------+
            | Load Balancer |
            +-------+-------+
                    |
                    v
            +---------------+
            | Query Server  |
            +-------+-------+
                    |
        +-----------+-----------+
        |                       |
        v                       v
+---------------+       +---------------+
| Redis Cache   |       | (cache miss)  |
| Check         |       |               |
+-------+-------+       +-------+-------+
        |                       |
   (hit)|                       v
        |               +---------------+
        |               | Query Parser  |
        |               | - Tokenize    |
        |               | - Stem        |
        |               | - Expand      |
        |               +-------+-------+
        |                       |
        |                       v
        |               +---------------+
        |               | Term Shards   |
        |               | (parallel)    |
        |               +-------+-------+
        |                       |
        |                       v
        |               +---------------+
        |               | Merge + BM25  |
        |               | (top 1000)    |
        |               +-------+-------+
        |                       |
        |                       v
        |               +---------------+
        |               | Re-Rank       |
        |               | + PageRank    |
        |               | + Freshness   |
        |               +-------+-------+
        |                       |
        |                       v
        |               +---------------+
        |               | Store in      |
        |               | Redis Cache   |
        |               +-------+-------+
        |                       |
        +-----------+-----------+
                    |
                    v
            +---------------+
            | Return Top 10 |
            | Results       |
            +---------------+
```

### Crawl-to-Index Pipeline

```
Seed URLs
    |
    v
+----------+     +----------+     +----------+
|   URL    |---->| Fetcher  |---->|  Parser  |
| Frontier |     | (HTTP)   |     | (HTML)   |
+----------+     +----------+     +----+-----+
    ^                                  |
    |                           +------+------+
    |                           |             |
    |                           v             v
    |                    +----------+   +----------+
    |                    |  Links   |   | Content  |
    |                    | Extracted|   | Cleaned  |
    |                    +----+-----+   +----+-----+
    |                         |              |
    +-------------------------+              |
         (new URLs added)                    v
                                      +----------+
                                      | Tokenize |
                                      |  + Stem  |
                                      +----+-----+
                                           |
                                           v
                                      +----------+
                                      |  Index   |
                                      |  Build   |
                                      +----+-----+
                                           |
                                           v
                                      +----------+
                                      | Write to |
                                      |   ES     |
                                      +----------+
```

---

## ⚖️ Trade-offs Summary

| Decision | What I Chose | Why | What I Gave Up |
|----------|--------------|-----|----------------|
| URL Frontier | Priority Queue | Maximize value from limited crawl budget | Simplicity of FIFO |
| Index Sharding | Shard by Term | 50x reduction in query fan-out | Simple document partitioning |
| PageRank Update | Weekly Batch | Stable rankings, predictable costs | Instant authority for new pages |
| Ranking | Two-Phase | Meet latency SLA while using rich signals | May miss some relevant docs in phase 1 |
| Inverted Index | Elasticsearch | Time-to-market, battle-tested | Full control over storage format |
| URL Storage | PostgreSQL | Rich queries for frontier and PageRank | Cassandra's write throughput |
| Query Cache | Redis | Shared cache across instances | In-memory speed |
| Cache TTL | Adaptive | Balance freshness and hit rate | Implementation simplicity |

---

## 🚀 Future Enhancements

1. **Real-Time Indexing Pipeline**
   - Add Kafka streaming for breaking news and social content
   - Bypass batch indexing for time-sensitive content
   - Target sub-minute indexing latency for news

2. **Learning to Rank**
   - Train ML models on click-through data
   - Move from hand-tuned weights to learned ranking functions
   - A/B test ranking changes systematically

3. **Query Understanding**
   - Add entity recognition (people, places, organizations)
   - Intent classification (navigational vs informational vs transactional)
   - Query rewriting and expansion using NLP

4. **Personalization Layer**
   - Incorporate user search history
   - Geographic and language preferences
   - Privacy-preserving personalization techniques

5. **Incremental PageRank**
   - Move toward streaming PageRank updates
   - Process link graph changes incrementally
   - Reduce authority update lag for new pages

---

## 📝 Summary

"To summarize my design for the Google Search backend:

I've architected three main subsystems. The **Crawl System** uses a priority-based URL frontier to maximize value from our crawl budget, with per-host politeness queues to respect robots.txt.

The **Indexing Pipeline** builds term-sharded inverted indexes using Elasticsearch, with weekly batch PageRank computation for authority scores. I chose term sharding over document sharding to reduce query fan-out by 50x.

The **Serving Layer** uses two-phase ranking to meet the 200ms latency SLA: fast BM25 retrieval for candidates, then expensive re-ranking with PageRank and freshness signals. Redis caching with adaptive TTL reduces load on index servers.

Key infrastructure decisions include PostgreSQL for URL state and link graph, Elasticsearch for the inverted index, and Redis for distributed caching. Each choice involved explicit trade-offs between simplicity, performance, and operational complexity.

The system scales horizontally at each layer: crawl workers, index shards, query servers, and cache nodes can all be independently scaled based on load. With this architecture, we can meet our targets of 100B indexed pages and 100K QPS with sub-200ms latency."

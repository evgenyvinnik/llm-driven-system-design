# Design Typeahead - Architecture

## System Overview

Typeahead is an autocomplete suggestion system that returns ranked suggestions as users type. It must respond in under 50ms while incorporating popularity, personalization, trending signals, and content safety filtering. Core challenges involve trie-based prefix matching at scale, real-time aggregation of query logs, multi-factor ranking, and sharded serving infrastructure.

**Learning Goals:**
- Build trie-based data structures with pre-computed top-k
- Design low-latency serving systems with aggressive caching
- Implement real-time aggregation pipelines (Kafka to trie)
- Handle personalized ranking with privacy considerations

---

## Requirements

### Functional Requirements

1. **Suggest**: Return top-k suggestions for any prefix, ordered by relevance
2. **Rank**: Combine popularity, recency, personalization, trending, and match quality
3. **Personalize**: Boost suggestions based on individual user search history
4. **Update**: Surface trending topics within minutes of them spiking
5. **Filter**: Remove inappropriate, offensive, or dangerous content from suggestions

### Non-Functional Requirements

- **Latency**: < 50ms P99 for suggestion queries
- **Availability**: 99.99% uptime (search box failure is highly visible)
- **Scale**: 100K QPS sustained, 300K QPS peak
- **Freshness**: Trending topics reflected within 5 minutes
- **Accuracy**: Top-k suggestions match user intent > 60% of the time

---

## Capacity Estimation

### Production Scale

| Metric | Estimate |
|--------|----------|
| Daily active users | 500M |
| Queries per user per day | 5-10 |
| Keystrokes per query (avg) | 8 |
| Suggestion requests per day | ~20B (500M * 8 * 5) |
| Suggestion QPS (average) | ~230K |
| Suggestion QPS (peak) | ~700K |
| Unique phrases in trie | 50M - 100M |
| Trie memory (all shards) | ~20GB |
| Redis cache memory | ~5GB |
| Query log volume | ~50TB/day |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Seeded phrases | ~100 (102 in `backend/db-seed/seed.sql`) |
| Trie memory | < 50MB |
| Redis cache | < 10MB |
| PostgreSQL storage | < 100MB |
| Concurrent users | 1-5 |
| QPS | < 50 |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                │
│              Search Box  │  Mobile App  │  API Consumers             │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          API Gateway                                 │
│        (CDN edge cache, rate limiting, load balancing)               │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│Suggestion Service│ │Suggestion Service│ │Suggestion Service│
│   (Instance 1)   │ │   (Instance 2)   │ │   (Instance N)   │
│                  │ │                  │ │                  │
│ - Trie lookup    │ │ - Trie lookup    │ │ - Trie lookup    │
│ - Ranking        │ │ - Ranking        │ │ - Ranking        │
│ - Cache check    │ │ - Cache check    │ │ - Cache check    │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                      │
         └────────────────────┼──────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│ Trie Shards  │    │     Redis        │    │  PostgreSQL  │
│              │    │                  │    │              │
│ Shard 0: a-d │    │ - Suggestion     │    │ - phrase_    │
│ Shard 1: e-h │    │   cache (60s)    │    │   counts     │
│ Shard 2: i-l │    │ - Trending       │    │ - query_logs │
│ ...          │    │   counters       │    │ - user_      │
│ Shard N: w-z │    │ - User history   │    │   history    │
└──────────────┘    │ - Idempotency    │    │ - filtered_  │
                    └──────────────────┘    │   phrases    │
                                           └──────────────┘
                              ▲
                              │
┌──────────────────────────────────────────────────────────────────────┐
│                    Aggregation Pipeline                               │
│                                                                      │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐  │
│  │  Query    │───▶│  Kafka   │───▶│ Consumer │───▶│ Trie Builder │  │
│  │  Logs     │    │  Topics  │    │ Workers  │    │ (Periodic)   │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────────┘  │
│                                       │                             │
│                                       ▼                             │
│                                ┌──────────────┐                     │
│                                │   Filters    │                     │
│                                │ (Quality +   │                     │
│                                │  Safety)     │                     │
│                                └──────────────┘                     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Trie Data Structure

The trie stores all known phrases with pre-computed top-k suggestions at each prefix node. This enables O(prefix_length) lookups regardless of the total number of phrases.

**Design choices:**
- Each `TrieNode` holds a `Map<char, TrieNode>`, a boolean `isEndOfWord`, a pre-sorted `suggestions[]` array (top 10), a `count` and a `lastUpdated` timestamp
- `insert(phrase, count, lastUpdated)` updates the top-k list at every prefix node along the path, root included, so the root holds the global top-k. When a count drops at a node whose list is full, that node's list is rebuilt from its own phrase plus its children's lists; `remove(phrase)` repairs ancestors the same way and prunes empty nodes
- `getSuggestions(prefix)` traverses to the prefix node and returns the pre-computed list
- `findFuzzy(prefix, maxDistance)` walks the trie as a bounded DFS carrying one edit-distance row per node (used by `?fuzzy=true`)
- `serialize()` / `deserialize()` enable network transfer and persistence (not used by the local server, which rebuilds from Postgres)

**Trade-off**: Pre-computing top-k at every node uses more memory (O(phrases * avgLength * k)) but eliminates subtree traversal at query time. For 50M phrases with average length 15 and k=10, this adds ~7.5GB of suggestion pointers, but query time drops from O(subtree) to O(1) after prefix traversal.

### 2. Sharded Trie Service

At production scale, a single trie cannot fit in memory. Sharding by first character distributes load:

- **Shard assignment**: `firstChar.charCodeAt(0) % totalShards`
- **Routing**: The suggestion service routes each prefix to the correct shard
- **Locality**: All phrases starting with the same character are on the same shard, enabling efficient prefix matching without cross-shard coordination

**Alternative considered**: Hash-based sharding. This would distribute load more evenly but would break prefix locality: a query for "app" might need to query multiple shards to find all suggestions starting with "app". First-character sharding keeps all "app*" phrases on one shard.

**What we give up**: Uneven shard sizes (more phrases start with "s" than "z"). Mitigated by range-based sharding at scale (e.g., shard 0: a-c, shard 1: d-f) with rebalancing.

### 3. Multi-Factor Ranking

Each suggestion is scored by combining five signals:

| Signal | Weight | Calculation |
|--------|--------|-------------|
| Popularity | 0.30 | `log10(count + 1) / 9` - logarithmic scaling prevents dominant phrases (normalized so ~1B searches scores 1.0) |
| Recency | 0.15 | `exp(-ageInHours / 168)` of `phrase_counts.last_updated` - exponential decay with a 1-week time constant (half-life ≈ 116 hours); 0.5 when there is no timestamp |
| Personalization | 0.25 | `0.7 × exp(-daysSinceLastSearch / 30) + 0.3 × min(searchCount / 10, 1)` from the user's history; 0 without a `userId` |
| Trending boost | 0.20 | `min(trendingScore / 1000, 1)` from the `trending_queries` zset (5-minute windows aggregated over the last hour) |
| Match quality | 0.10 | 0.8-1.0 when the phrase starts with the prefix (higher the more of the phrase the prefix covers), 0.7 for a word-boundary match, 0.4 for a substring |

Fuzzy candidates additionally lose 0.2 per edit. The ranking service queries Redis for trending scores and user history, combines them with the base trie scores, and returns the re-ranked top-k. The weights are constants in `backend/src/services/ranking-service.ts`, not configuration. Locally, each Redis lookup is skipped while Redis is disconnected and raced against a 30ms timeout, so a Redis problem drops the personal and trending signals to 0 instead of failing the request.

### 4. Aggregation Pipeline

Query logs flow through a pipeline that filters, counts, and rebuilds the trie:

1. **Ingestion**: Queries arrive via Kafka topics from search service logs
2. **Quality filter**: Reject queries < 2 chars, > 100 chars, pure numbers, keyboard smash patterns
3. **Content filter**: Block phrases matching the `filtered_phrases` table (inappropriate content)
4. **Buffering**: Accumulate counts in memory for 30 seconds
5. **Flush**: Batch UPSERT to `phrase_counts` table in PostgreSQL
6. **Trending update**: Sliding window counters in Redis (5-minute windows, 1-hour retention)
7. **Trie rebuild**: Periodic full rebuild from `phrase_counts` (or incremental updates for hot phrases)

**Locally**, step 1 is `POST /api/v1/suggestions/log` (a selected suggestion or submitted query, not a keystroke) calling `AggregationService.processQuery()`. The quality filter rejects queries shorter than 2 or longer than 100 characters after normalization, all-digit queries, control characters, keyboard smash (a letters-only word of 6+ letters with no vowel, or a run of 7 adjacent keys on one QWERTY row) and 5+ repeated non-digit characters. Rejected queries return `accepted: false` with a reason and are not counted. Each flush upserts the buffered deltas and inserts the stored total into the trie (incremental updates); a full rebuild happens only at startup and on `POST /api/v1/admin/trie/rebuild`.

### 5. Content Safety Filtering

Suggestions must never show offensive, dangerous, or illegal content. The filtering operates at two levels:

- **Blocklist**: The `filtered_phrases` table contains phrases that are never suggested (locally: exact matches on the normalized phrase, no patterns)
- **Real-time filtering**: The aggregation pipeline checks each incoming query against the blocklist before counting
- **Admin controls**: Admin API endpoints to add/remove filtered phrases with audit logging
- **Strong consistency**: Filter list changes take effect immediately (not eventually consistent)

Locally, `POST /api/v1/admin/filter` writes `filtered_phrases`, adds the phrase to the Redis `blocked_phrases` set, marks its `phrase_counts` row `is_filtered`, removes it from the trie, drops its buffered count and trending entries, and deletes every cached prefix key of the phrase. Trending is recomputed with the blocked set subtracted, and a flush never reinserts a filtered row. What the server cannot reach is client-side caches: a response already in another browser's HTTP cache (anonymous requests, `max-age=60`) or in-memory cache (60s TTL) can show the phrase for up to a minute.

---

## Database Schema

```sql
-- Phrase counts (aggregated from query logs)
CREATE TABLE IF NOT EXISTS phrase_counts (
  phrase VARCHAR(200) PRIMARY KEY,
  count BIGINT DEFAULT 0,
  last_updated TIMESTAMP DEFAULT NOW(),
  is_filtered BOOLEAN DEFAULT FALSE,
  -- Set by every write (count, filter, restore); other API instances poll it to sync their tries.
  -- last_updated is only the count's age (it feeds the recency score), so filter changes don't touch it.
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phrase_count ON phrase_counts(count DESC);
CREATE INDEX IF NOT EXISTS idx_phrase_changed_at ON phrase_counts(changed_at);

-- Query logs (raw, for aggregation and analytics)
CREATE TABLE IF NOT EXISTS query_logs (
  id BIGSERIAL PRIMARY KEY,
  query VARCHAR(200) NOT NULL,
  user_id UUID,
  timestamp TIMESTAMP DEFAULT NOW(),
  session_id VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_query_logs_time ON query_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_query_logs_query ON query_logs(query);

-- User search history (for personalization)
CREATE TABLE IF NOT EXISTS user_history (
  user_id UUID NOT NULL,
  phrase VARCHAR(200) NOT NULL,
  count INTEGER DEFAULT 1,
  last_searched TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, phrase)
);

-- Filtered phrases (inappropriate content blocklist)
CREATE TABLE IF NOT EXISTS filtered_phrases (
  phrase VARCHAR(200) PRIMARY KEY,
  reason VARCHAR(50),
  added_at TIMESTAMP DEFAULT NOW()
);

-- Analytics summary (daily aggregates)
CREATE TABLE IF NOT EXISTS analytics_summary (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_queries BIGINT DEFAULT 0,
  unique_queries BIGINT DEFAULT 0,
  unique_users BIGINT DEFAULT 0,
  avg_query_length DECIMAL(5,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(date)
);

-- Trending query snapshots
CREATE TABLE IF NOT EXISTS trending_snapshots (
  id SERIAL PRIMARY KEY,
  phrase VARCHAR(200) NOT NULL,
  score DECIMAL(10,2) NOT NULL,
  snapshot_time TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trending_time ON trending_snapshots(snapshot_time DESC);
```

The local schema is `backend/src/db/init.sql` (mounted into the Postgres container). The local server reads and writes only `phrase_counts`, `query_logs` and `filtered_phrases`. `user_history`, `analytics_summary` and `trending_snapshots` belong to the production design; locally no code touches them (the last two hold seed rows only). `query_logs.user_id` is stored only when the client's `userId` is a UUID, otherwise NULL.

### Redis Data Structures

```
# Suggestion cache (STRING, 60s TTL). Prefix entries have their own namespace, so no
# prefix can collide with the popular list
suggestions:prefix:{prefix}  →  JSON array of unranked suggestions (trie top-k)
suggestions:popular          →  JSON array of the global top-k

# Blocklist mirror of filtered_phrases (SET), resynced on start and on Redis reconnect
blocked_phrases  →  { phrase, ... }

# Trending counters (SORTED SET, 5-min windows, 1-hour TTL)
trending_window:{timestamp_bucket}  →  { phrase: score, ... }

# Aggregated trending (SORTED SET, rebuilt from windows via ZUNIONSTORE)
trending_queries  →  { phrase: aggregated_score, ... }

# User search history (STRING, JSON, 90-day TTL, most recent first, max 100 entries;
# updated atomically by a Lua script)
user_history:{userId}  →  [{ phrase, timestamp, count }, ...]

# Idempotency records for admin mutations sent with X-Idempotency-Key
# (STRING, JSON: 60s in-flight reservation via SET NX, then the response for 5 min)
idem:http:{operation}:{idempotencyKey}  →  { state, fingerprint, token | result }

```

Locally, the aggregation buffer and the rate-limit counters live in process memory, not Redis, and per-user history exists only in the `user_history:{userId}` key (the Postgres `user_history` table is never written).

---

## API Design

These are the routes the local server implements (`backend/src/routes/suggestions.ts`, `analytics.ts`, `admin.ts`, and `index.ts` for operations).

### Suggestion Endpoints

```
GET  /api/v1/suggestions?q={prefix}&limit={n}&userId={id}&fuzzy=true  → Ranked suggestions
POST /api/v1/suggestions/log           → Log a completed search { query, userId?, sessionId? }
GET  /api/v1/suggestions/trending?limit={n}    → Trending queries
GET  /api/v1/suggestions/popular?limit={n}     → Global top-k (trie root)
GET  /api/v1/suggestions/history?userId={id}&limit={n}  → User search history, most recent first
```

- A `q` longer than 200 characters returns an empty list (no stored phrase is longer); a logged `query` over 200 characters gets 400; `userId`/`sessionId` to 100. `limit` is clamped to 1-100 (default 5 for suggestions, 10 elsewhere), and an invalid value falls back to the default. Each node holds a top-10, so more than 10 suggestions are never returned.
- The prefix is lowercased and leading whitespace trimmed; one trailing space is kept, so `q=java%20` returns phrases continuing with a new word (`java vs javascript`) rather than `javascript`.
- The suggestion response is `{ prefix, suggestions: [{ phrase, count, lastUpdated, score, scores }], meta: { count, responseTimeMs, cached, degraded } }`. `meta.cached` reports that the base list came from Redis; `meta.degraded` marks a circuit-breaker fallback (an empty list sent with `Cache-Control: no-store`).
- `POST /log` always answers 200 with `{ success, accepted, reason?, message }`. `reason` is `invalid`, `too_long`, `low_quality`, `inappropriate` or `filter_unavailable`; only accepted queries are counted and added to the user's history.

### Analytics Endpoints

```
GET  /api/v1/analytics/summary                          → Today's and all-time query stats, phrase totals, trie and buffer stats
GET  /api/v1/analytics/queries?limit={n}&offset={n}&search={text}  → Raw query log (limit 1-500, default 50)
GET  /api/v1/analytics/top-phrases?limit={n}            → Top phrases from phrase_counts (limit 1-500, default 50)
GET  /api/v1/analytics/hourly                           → Query volume per hour, last 24 hours
```

The summary is computed from `query_logs` and `phrase_counts` on every request; the `analytics_summary` table is not read. All four are sent with `private, no-cache`.

### Admin Endpoints

```
GET    /api/v1/admin/status           → Redis/Postgres status, trie and buffer stats, uptime
GET    /api/v1/admin/trie/stats       → Phrase count, node count, max depth
POST   /api/v1/admin/trie/rebuild     → Rebuild the trie from phrase_counts, clear the suggestion cache
POST   /api/v1/admin/phrases          → Add a phrase or raise its count { phrase, count? }
DELETE /api/v1/admin/phrases/{phrase} → Remove a phrase from suggestions (row kept, is_filtered = true)
POST   /api/v1/admin/filter           → Add a phrase to the blocklist { phrase, reason? }
DELETE /api/v1/admin/filter/{phrase}  → Remove a filter and restore the phrase with its stored count
GET    /api/v1/admin/filtered?limit={n}  → List blocked phrases (limit 1-1000, default 100)
POST   /api/v1/admin/cache/clear      → Clear the Redis suggestion cache
```

- Adding never lowers a count: the stored count is `max(existing, requested)`, and the response reports `count` (stored), `requestedCount`, `created`, `previousCount` and `restored`. A phrase on the blocklist gets 409. Phrases are limited to 200 characters, `count` to an integer from 1 to 1e9, `reason` to 50 characters.
- Every mutation except `DELETE /filter/{phrase}` accepts an `X-Idempotency-Key` header (see Idempotency below). Admin add, remove, filter and unfilter delete every cached prefix of the phrase plus the popular list.
- 500 responses are `{ "error": "Internal server error" }` with no database error text.

### Operations Endpoints

```
GET  /health               → Liveness: 200 while the process runs
GET  /health/ready          → Readiness: 503 until the trie has loaded, and whenever Redis or Postgres is unreachable
GET  /health/circuits       → Circuit breaker status
GET  /status                → Detailed system status with Redis memory, PG pool counts
GET  /metrics               → Prometheus metrics
```

The global rate limiter does not count `/health`, `/health/*` or `/metrics`.

---

## Key Design Decisions

### 1. Trie with Pre-computed Top-K vs On-Demand Subtree Traversal

**Decision**: Store the top-k suggestions at every trie node.

**Why it works**: Suggestion queries must complete in < 50ms. With pre-computed top-k, the query is a simple trie traversal to the prefix node (O(prefix_length)) followed by reading the cached suggestions list (O(1)). No subtree traversal, no sorting at query time.

**Why on-demand traversal fails at scale**: For a prefix like "a", the subtree might contain millions of phrases. Traversing and sorting even a fraction of them would blow the 50ms budget. Even with early termination heuristics, the variance is too high for P99 guarantees.

**What we give up**: Memory. Each of the ~50M trie nodes stores up to 10 suggestion pointers. More importantly, insert operations are O(phrase_length * k) instead of O(phrase_length) because every prefix node's top-k list must be checked and potentially updated. This is acceptable because inserts happen in the background aggregation pipeline, not on the user-facing read path.

### 2. Redis Caching with Short TTL vs Direct Trie Queries

**Decision**: Cache each prefix's unranked top-k candidates in Redis with a 60-second TTL; ranking (which includes per-user personalization) runs after the cache read.

**Why it works**: Most prefixes are queried thousands of times per minute (e.g., "wea" as users type "weather"). A 60-second cache eliminates >95% of trie lookups while keeping suggestions reasonably fresh. Because the cached value is the same for every user, one entry serves everyone typing that prefix. The cache key is the normalized prefix (`suggestions:prefix:{prefix}`), so invalidating a phrase means deleting one key per prefix of it plus `suggestions:popular`, which the local admin routes do through `SuggestionService.invalidatePhrase()`. Count changes from the 30-second flush are not invalidated; they wait out the TTL.

**Why longer TTL fails**: Trending topics must surface within minutes. A 10-minute cache would mean users see stale suggestions long after a topic trends. The 60-second TTL balances cache efficiency (~95% hit rate) with freshness.

**Why no cache fails**: At 100K QPS, every request hitting the trie directly would require massive trie server capacity. The cache absorbs the request amplification from users typing the same popular prefixes.

### 3. Kafka for Query Log Ingestion vs Direct Database Writes

**Decision**: Query logs flow through Kafka before aggregation.

**Why it works**: Query logs arrive at 200K+ per second at peak. Writing each one directly to PostgreSQL would overwhelm the database. Kafka absorbs the write burst, and consumer workers batch-process logs at a sustainable rate, flushing aggregated counts every 30 seconds.

**Why direct writes fail**: PostgreSQL can handle ~10K inserts/second with WAL. At 200K QPS, the database would fall behind, causing backpressure that degrades the search service. Kafka decouples the write rate from the processing rate.

**What we give up**: Operational complexity (Kafka cluster management, consumer group coordination, offset management). At smaller scale, a simple in-memory buffer with periodic flush to PostgreSQL works fine (which is what the local implementation does). Locally only the `phrase_counts` upserts are buffered: each logged search (`POST /log`, i.e. a completed search, not a keystroke) still does a blocklist lookup (Redis, then a Postgres SELECT) and one `query_logs` INSERT.

---

## Consistency and Idempotency

### Write Consistency Model

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Query log ingestion | Eventual | Loss of a few queries is acceptable; throughput matters |
| Phrase count updates | Eventual | Aggregated counts tolerate minor drift |
| Trending score updates | Eventual | Real-time approximation is sufficient |
| Filter list updates | Strong | Inappropriate content must be blocked immediately |
| User history updates | Eventual | Personalization can lag slightly |

### Idempotency

At production scale, query log messages would carry an idempotency key (`userId_timestamp_randomSuffix`) checked against an in-memory set (fast path) and Redis `SETNX` (cross-instance) with a 5-minute TTL.

Locally, `POST /api/v1/suggestions/log` is **not** deduplicated: a retried log counts twice, which is acceptable because counts feed a ranking. Admin mutations (`trie/rebuild`, `phrases`, `phrases/:phrase`, `filter`, `cache/clear`; `DELETE /filter/:phrase` has no middleware and is idempotent by itself) run behind `idempotencyMiddleware(operation)` in `backend/src/shared/idempotency.ts`, which deduplicates only when the client sends an `X-Idempotency-Key` header:

1. The key (1-128 characters, otherwise 400) is scoped by operation and reserved with `SET NX PX 60000` (in-memory fallback while Redis is down); a concurrent duplicate gets 409 with `Retry-After`.
2. A 2xx-4xx response is stored for 5 minutes and replayed with `Idempotency-Replayed: true`; a 5xx releases the reservation so a retry runs again.
3. The same key with a different body or path parameters gets 422.

The admin UI sends a fresh key per user action, so double-click protection comes from disabling the button, not from the key.

Trie updates are idempotent by design: the flush and the admin routes insert the absolute count stored in `phrase_counts` rather than a delta. Rebuilding the trie from the same snapshot produces the same result regardless of how many times it runs.

---

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `typeahead_suggestion_latency_seconds` | Histogram | endpoint, cache_hit | Query latency SLI |
| `typeahead_suggestion_requests_total` | Counter | endpoint, status | Request rate and error rate |
| `typeahead_cache_hit_rate` | Gauge | cache_type (redis, local) | Cache efficiency |
| `typeahead_cache_operations_total` | Counter | operation, result | Redis prefix-cache hits and misses (real lookups only; fuzzy and fallback responses are not counted) |
| `typeahead_trie_node_count` | Gauge | shard_id | Trie size monitoring |
| `typeahead_trie_phrase_count` | Gauge | shard_id | Data volume |
| `typeahead_kafka_consumer_lag` | Gauge | partition | Pipeline backlog |
| `typeahead_aggregation_buffer_size` | Gauge | - | Memory pressure |
| `typeahead_aggregation_flush_duration_seconds` | Histogram | - | Flush cost (Postgres upserts + trie updates) |
| `typeahead_queries_filtered_total` | Counter | reason | Content safety effectiveness |

Locally, the trie gauges have no `shard_id` label (one trie per process), `typeahead_trie_max_depth` is added, and `typeahead_kafka_consumer_lag` does not exist. `typeahead_cache_hit_rate` is set for `cache_type="redis"` only. `/metrics` also exposes circuit-breaker state, failure and fallback counters, rate-limit hits and allowed requests, idempotency duplicates, and prefix-length and suggestion-count histograms (`backend/src/shared/metrics.ts`). `queries_filtered_total` reasons are `invalid`, `too_long`, `low_quality`, `inappropriate` and `filter_unavailable`.

### Structured Logging (Pino)

JSON logs with request IDs, query truncation (privacy), and correlation:

```
{"level":"info","type":"request","requestId":"abc","path":"/api/v1/suggestions","query":"wea","durationMs":12,"cacheHit":true,"suggestionCount":5}
```

Locally (`backend/src/shared/logger.ts`), the logged path omits the query string, `q` is truncated to 50 characters, and a `userId` (query parameter or `X-User-Id` header) is logged as a 12-hex-character SHA-256 pseudonym.

### Health Checks

- `/health` - Simple liveness (process alive)
- `/health/ready` - Readiness (trie loaded with > 0 phrases, Redis PONG, PG SELECT 1); 503 if any check fails, including while the trie is still loading at startup
- `/health/circuits` - Circuit breaker states (production: per shard connection; locally: the single `suggestions` breaker)

### Alert Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High latency | P99 > 50ms for 2 min | Warning |
| High error rate | Error rate > 1% for 1 min | Critical |
| Kafka lag | Consumer lag > 50K for 5 min | Warning |
| Low cache hit rate | < 70% for 10 min | Warning |
| Trie size anomaly | > 20% change from 1-hour average | Warning |

---

## Failure Handling

### Circuit Breakers (Opossum)

At production scale, circuit breakers wrap shard connections and external service calls:

- **Failure threshold**: 5 consecutive failures
- **Reset timeout**: 10-30 seconds
- **Half-open**: Allow 3 test requests before closing
- **Fallback**: When a shard circuit opens, return cached or empty results

Locally there is one breaker, created in `backend/src/routes/suggestions.ts` around `SuggestionService.getSuggestionsWithMeta()` (cache read, trie lookup and ranking): 100ms timeout, opens when 30% of calls fail once at least 10 have been seen, and tries again after 5 seconds. Its fallback is an empty list marked `meta.degraded: true`, sent with `Cache-Control: no-store` and logged with the reason (`circuit_open`, `timeout` or `error`). Fuzzy requests bypass it. The Redis and database breaker factories in `backend/src/shared/circuit-breaker.ts` are not used; Redis calls are protected by fail-fast checks and short timeouts instead (see Graceful Degradation).

### Retry Strategy

Exponential backoff with jitter for shard queries:
- Base delay: 50ms, max delay: 5s, max retries: 3
- Each retry includes the idempotency key and retry attempt number
- Non-retryable: 400, 401, 403, 404

Locally there are no request-level retries. The startup trie load retries with exponential backoff (1s, 2s, 4s ... capped at 30s) until Postgres is reachable, and the server answers liveness meanwhile. A flush that fails on a transient Postgres error puts the remaining counts back in the buffer (capped at 50,000 distinct phrases); row-level data errors are dropped. SIGTERM/SIGINT close the server, await a final flush, then close Redis and Postgres, with a 10-second safety exit.

### Graceful Degradation

When components fail, the system progressively drops features:

| Component Down | Impact | Mitigation |
|----------------|--------|------------|
| Redis cache | Higher trie load | Direct trie queries (acceptable at lower QPS) |
| User history (Redis) | No personalization | Return popularity-ranked suggestions |
| Trending counters (Redis) | No trending boost | Rank by popularity and recency only |
| Trie shard | Missing some prefixes | Return cached results or empty for that prefix range |
| Kafka | No new phrases ingested | Trie serves with existing data (stale but functional) |
| PostgreSQL | No trie rebuild possible | In-memory trie continues serving |

Locally, with Redis down the suggestion service skips the cache (a read slower than 50ms also counts as a miss), and ranking drops the personal and trending signals to 0, so suggestions still come from the in-memory trie in a few milliseconds. `/suggestions/trending` returns an empty list marked `meta.degraded` and sent `no-store`, `POST /admin/cache/clear` answers 503, `/health/ready` reports 503, and the blocked set is resynced from `filtered_phrases` when Redis reconnects. With Postgres down the trie keeps serving; logged searches are still buffered (the blocklist check falls back to the Redis set) and flushed once Postgres returns. If neither blocklist source can be read, `/log` rejects the query with `filter_unavailable`.

---

## Scalability Considerations

### Horizontal Scaling

1. **Suggestion service**: Stateless instances behind a load balancer; each loads the full trie or queries sharded trie servers. Locally, `dev:server1/2/3` each hold a full trie and converge through `phrase_counts.changed_at` polling plus a Redis pub/sub nudge (`trie-sync-service.ts`), the small-scale form of consuming a shared change log
2. **Trie shards**: Scale shards by splitting character ranges (a-c, d-f, ...) across more servers
3. **Redis**: Redis Cluster for cache and trending counter distribution
4. **Kafka**: Add partitions and consumer workers for higher ingestion throughput
5. **PostgreSQL**: Read replicas for analytics queries; primary for aggregation writes

### Edge Deployment

For global < 50ms P99, deploy trie servers at CDN edge locations:
- Trie snapshots replicated to edge every 5 minutes
- Trending updates pushed via pub/sub to edge servers
- User history kept centrally (personalization adds ~10ms, acceptable for non-edge requests)

### Bottleneck Analysis

| Component | Breaks at | Solution |
|-----------|-----------|----------|
| Single trie server memory | ~20GB (100M phrases) | Shard by character range |
| Redis cache memory | ~5GB (10M cached prefixes) | TTL tuning, LRU eviction |
| Kafka consumer throughput | ~50K msg/sec per partition | Add partitions + consumers |
| PostgreSQL write throughput | ~10K UPSERT/sec | Batch writes, reduce flush frequency |
| Network RTT to trie shards | > 20ms cross-region | Edge deployment with local replicas |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Data structure | Trie with pre-computed top-k | Inverted index | O(prefix_length) lookup, no subtree traversal |
| Cache strategy | Redis, 60s TTL | No cache / longer TTL | 95% hit rate with < 1 min staleness |
| Query ingestion | Kafka stream processing | Direct PG writes | Decouples 200K QPS from database write rate |
| Sharding | First character | Hash-based | Preserves prefix locality on single shard |
| Freshness | Short cache + real-time trending | Periodic batch rebuild | Trending within minutes, stable base suggestions |
| Ranking | Multi-factor weighted scoring | Popularity only | Personalization and trending improve relevance |
| Content filtering | Strong consistency blocklist | Eventual consistency | Safety-critical: inappropriate content must never appear |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + Express + React.

### Local Architecture

```
┌──────────────────────────────────────────────────────┐
│              React Frontend (:5173)                  │
│  TanStack Router + Zustand + Tailwind CSS            │
│  /         SearchBox (Zustand store), TrendingList   │
│  /widgets  4 useTypeahead widgets: Command Palette,  │
│            Rich, Mobile, Inline Form                 │
│  /admin    Overview, Analytics, Management tabs      │
└────────────────────────┬─────────────────────────────┘
                         │ HTTP (fetch, via Vite proxy)
                         ▼
┌──────────────────────────────────────────────────────┐
│       Express Backend (:3000 / :3001-3003)           │
│  In-process: trie, ranking, aggregation buffer       │
│  /api/v1/suggestions, /api/v1/analytics,             │
│  /api/v1/admin                                       │
│  /health, /health/ready, /metrics, /status           │
└──────────┬───────────────────────┬───────────────────┘
           │                       │
           ▼                       ▼
   ┌───────────────┐       ┌────────────────────┐
   │    Valkey     │       │     PostgreSQL     │
   │    (:6379)    │       │      (:5432)       │
   │               │       │                    │
   │ - Suggestion  │       │ - phrase_counts    │
   │   cache       │       │ - query_logs       │
   │ - Trending    │       │ - filtered_phrases │
   │   windows     │       │                    │
   │ - Blocked set │       │ Schema/seed only,  │
   │ - User        │       │ never read or      │
   │   history     │       │ written by code:   │
   │ - Idempotency │       │ - user_history     │
   │   records     │       │ - analytics_summary│
   └───────────────┘       │ - trending_        │
                           │   snapshots        │
                           └────────────────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | Library | File | Purpose |
|---------|---------|------|---------|
| Trie with pre-computed top-10 | Custom | `backend/src/data-structures/trie.ts` | O(prefix_length) lookups |
| Multi-factor ranking | Custom | `backend/src/services/ranking-service.ts` | 5-signal weighted scoring |
| Aggregation pipeline | Custom | `backend/src/services/aggregation-service.ts` | Buffered writes, 30s flush, quality filtering |
| Circuit breakers | Opossum | `backend/src/shared/circuit-breaker.ts`, `backend/src/routes/suggestions.ts` | One breaker around the suggestion lookup (100ms timeout); fallback is an empty `degraded` list |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | Latency, cache hits, trie size, aggregation buffer |
| Structured logging | Pino + pino-http | `backend/src/shared/logger.ts` | JSON logs with request IDs, audit trail |
| Rate limiting | express-rate-limit | `backend/src/shared/rate-limiter.ts` | Fixed windows per client IP, in process memory: suggestions 20/s, log 5/s, admin 30/min, global 1000/min (health and metrics exempt) |
| Idempotency | Custom + Redis | `backend/src/shared/idempotency.ts` | `X-Idempotency-Key` deduplication for admin mutations |
| HTTP cache headers | Custom middleware | `backend/src/shared/cache-headers.ts` | Public Cache-Control for anonymous reads, `private, no-cache` for personalized ones, weak ETags, `no-store` for errors and degraded fallbacks |
| Content filtering | Database-backed + Redis set | `backend/src/services/aggregation-service.ts`, `backend/src/routes/admin.ts` | Blocklist check on logged searches; filtered phrases removed from the trie and trending |
| Client-side caching | Custom | `frontend/src/services/cache.ts`, `frontend/src/sw.ts` | In-memory LRU suggestion cache; service worker in production builds |
| Graceful shutdown | Custom | `backend/src/index.ts` | Final aggregation flush on SIGTERM/SIGINT before the pools close |
| Multi-instance trie sync | Postgres change marker + Redis pub/sub | `backend/src/services/trie-sync-service.ts` | Every write sets `phrase_counts.changed_at`; each instance polls changed rows every 5s and applies absolute counts, recency and filter state, and a pub/sub message triggers an immediate poll. Every minute it compares its phrase count with the live rows and reloads the trie if rows were deleted outright (a reseed) |
| Client performance metrics | Custom | `frontend/src/services/performance.ts`, `frontend/src/components/PerformancePanel.tsx` | Per-tab lookups and tab-cache hit rate, requests sent, network latency p50/p95, keystroke-to-suggestions and keystroke-to-selection times, shown on the home page |

### Simplifications and Substitutions

| Production Design | Local Substitute | Reason |
|-------------------|------------------|--------|
| Sharded trie across N servers | One full in-memory trie per instance, kept in step by polling `phrase_counts.changed_at` | ~100 seeded phrases (the startup load reads at most 100,000) fit in one process |
| Kafka stream processing | In-memory buffer of `phrase_counts` deltas with 30s flush to PG (each logged search still does a blocklist lookup and a `query_logs` INSERT) | No need for distributed log at this scale |
| CDN edge caching | Browser cache + HTTP cache headers | No multi-region deployment |
| API Gateway | Express middleware (rate limit, CORS) | Single process handles routing |
| Distributed Redis Cluster | Single Valkey instance | All data fits in < 10MB |
| A/B testing for ranking weights | Fixed weights in ranking service | No experimentation framework |
| OAuth / SSO authentication | No auth (open endpoints) | Not studying auth in this project |
| Dedicated trie rebuild workers | In-process rebuild via admin API | Single server handles both serving and rebuilding |
| Durable per-user history | Redis JSON blob `user_history:{userId}` (90-day TTL, max 100 entries); the Postgres `user_history` table is unused | Personalization tolerates loss; history is gone if Redis is flushed |
| Trending snapshots and daily analytics rollups | `trending_queries` recomputed in Redis every 30s; analytics computed from `query_logs` per request | The `trending_snapshots` and `analytics_summary` tables only hold seed rows |

### What Was Omitted

- **CDN and edge deployment**: No multi-region trie replication
- **Kubernetes orchestration**: Docker Compose runs Valkey and PostgreSQL only (no Kafka; `kafkajs` is an unused dependency)
- **Client-side prefetching**: `frontend/src/services/prefetch.ts` was deleted because nothing imported it
- **Distributed trie sharding**: Single trie instance per server process
- **ML-based ranking**: Rule-based weighted scoring, no learned models
- **A/B testing framework**: Single ranking configuration
- **WebSocket streaming**: one REST request per debounced keystroke
- **Geographic/language-specific suggestions**: Single language, no geo-targeting
- **Audit log persistence**: Audit events logged to stdout via Pino, not persisted to database

---

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (layout shell with header + navigation)
├── index.tsx (HomePage)
│   ├── SearchBox (core typeahead input with suggestion dropdown)
│   ├── TrendingList (live trending queries sidebar)
│   ├── SearchSettings (fuzzy toggle, max suggestions slider)
│   └── FeatureCard / Step (static informational cards)
├── admin.tsx (Admin Dashboard)
│   ├── OverviewTab (service health, trie phrases/nodes, uptime, buffer size, today's queries and users)
│   │   ├── StatCard (individual metric display)
│   │   └── StatusCard (service health indicator)
│   ├── AnalyticsTab (hourly query volume, top phrases)
│   ├── ManagementTab (add phrases, add a filter, rebuild trie, clear cache; no filter list or removal UI)
│   ├── TabButton (tab navigation within admin)
│   ├── ErrorState / LoadingState (shared status components)
│   └── icons/ (CheckCircleIcon, DatabaseIcon, ServerIcon)
└── widgets.lazy.tsx (lazy /widgets demo: 4 widgets over the useTypeahead hook)
    ├── CommandPalette (macOS Spotlight-style overlay)
    ├── RichTypeahead (enhanced with icons and metadata)
    ├── MobileTypeahead (touch-optimized full-screen)
    └── InlineFormTypeahead (embedded in a form field)
```

### Zustand Stores

**`useSearchStore`** (`stores/search-store.ts`) -- Single store managing all search-related state:

- **User identity**: `userId` (persisted in localStorage) and `sessionId` (persisted in sessionStorage) for personalization and analytics tracking; every storage access is wrapped so blocked storage falls back to in-memory values
- **Search state**: `query`, `suggestions[]`, `isLoading`, `error`, `responseTime` -- the core suggestion lifecycle
- **History**: `recentSearches[]` persisted in localStorage, capped at 10 entries
- **Settings**: `fuzzyEnabled` toggle and `maxSuggestions` count, controlling API request parameters
- **Actions**: `search(prefix)` fetches from API (ignored if the input no longer holds that prefix, and its result dropped if a newer search started), `selectSuggestion(phrase)` logs to backend and updates history, `clearSuggestions()` resets dropdown

### Routing

TanStack Router with file-based routing:

| Route | File | Description |
|-------|------|-------------|
| `/` | `routes/index.tsx` | Home page with SearchBox, TrendingList, feature cards |
| `/admin` | `routes/admin.tsx` | Admin dashboard with 3-tab interface (Overview, Analytics, Management) |
| `/widgets` | `routes/widgets.lazy.tsx` | Lazy-loaded demo of the four `useTypeahead` widgets |

The root layout (`__root.tsx`) provides a shared header with navigation links to the search page, the widgets demo and the admin dashboard.

### Data Fetching

The search page runs `SearchBox` → `stores/search-store.ts` → `services/api.ts`. The `/widgets` demo runs `useTypeahead` → `services/api.ts`, with an IndexedDB layer on top. The caching tiers are:

1. **Memory cache** (`services/cache.ts`) -- LRU cache with TTL (60s for suggestions, 30s for trending). Keys include the normalized prefix, userId, limit and fuzzy flag. Max 1000 entries; the least recently used entry is evicted when a new key is added at capacity. Degraded (circuit-breaker) responses are never cached; a logged search invalidates every prefix of the phrase, and admin mutations invalidate all suggestion entries.
2. **IndexedDB** (`db/database.ts`, `/widgets` only) -- `useTypeahead` checks it when the memory cache misses and writes it (best effort) after each network response, keyed per prefix/limit/fuzzy/userId variant. Also stores search history and popularity counters.
3. **Network** (`services/api.ts`) -- `ApiService` class with per-input request cancellation (AbortController), timeout handling (5s default), and cache population on response. Personalized requests use `cache: 'no-cache'`, so the HTTP cache revalidates them (ETag, usually a 304). Admin mutations send a fresh `X-Idempotency-Key` and tell the service worker to drop its API cache.
4. **Service worker** (`src/sw.ts`, production builds) -- network-first for navigations (cached shell only offline), versioned caches, API cache capped at 200 entries with 24h maximum staleness.

**Client metrics**: `stores/search-store.ts` records into `services/performance.ts`: every shown lookup (timed inside `api.getSuggestions`, so rendering isn't counted) and whether the tab's memory cache answered it, every request actually sent (including superseded ones), the time from a keystroke to the first paint of the suggestions for that keystroke (dropped if a newer keystroke came first or the tab was hidden), the time from the last keystroke to a pick from the typed list, every selection, and failed requests. Network latency percentiles exclude tab-cache answers. The home page's `PerformancePanel` shows them for the current tab, next to the server-side numbers on the admin dashboard.

**Response ordering**: Abort is only an optimization. Ordering is guaranteed by a request sequence number (`searchSeq` in the store, `requestSeq` in `useTypeahead`): every settle of a superseded request is ignored, so a slow response for "co" cannot overwrite "coff", a cleared input, or a selection, even when the newer request was answered synchronously from the memory cache.

### Key UI Patterns

- **Debounced input**: `SearchBox` (via `useDebounce`, cancellable on clear and select) and the `useTypeahead` hook debounce API calls (150ms; the command palette passes 100ms), preventing a request on every keystroke while remaining responsive
- **ARIA combobox**: Full ARIA implementation with `role="combobox"`, `aria-expanded`, `aria-activedescendant`, and `role="listbox"` for screen reader accessibility
- **Keyboard navigation**: Arrow keys move through suggestions, Enter selects, Escape dismisses, Tab moves focus away
- **4 widget variants on `/widgets`**: Demonstrate how the same `useTypeahead` hook powers different UI paradigms (command palette, rich cards, mobile full-screen, inline form); the home page's `SearchBox` uses the Zustand store instead

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation covers what the pattern is, why it exists, how it works mechanically, and when you would use it.

### Redis Cache-Aside

**What it is**: Cache-aside (also called "lazy loading") is a caching strategy where the application code is responsible for reading from and writing to the cache. The cache does not communicate with the database directly -- the application sits between them and orchestrates data flow.

**How it works**: When a request arrives, the application first checks Redis for the data. If the data is present and not expired (a "cache hit"), it is returned immediately without touching the database. If the data is absent or expired (a "cache miss"), the application queries the database, returns the result to the caller, and simultaneously writes the result to Redis with a time-to-live (TTL). The next request for the same data will find it in Redis.

**Why it matters**: Database queries involve disk I/O, query parsing, and potentially complex joins. Redis stores data in memory, so reads complete in microseconds rather than milliseconds. For a typeahead system handling 100K+ queries per second, the difference between a 1ms Redis read and a 10ms PostgreSQL query means the difference between 10 servers and 100 servers. In this project the source behind the cache is the in-memory trie rather than a database, and the cached value is the unranked candidate list, so one entry serves every user. The 60-second TTL balances freshness (trending topics appear within a minute) with cache efficiency (95%+ hit rate for popular prefixes); admin changes delete the affected prefix keys instead of waiting for it.

**When to use it**: Cache-aside is appropriate when reads vastly outnumber writes, when slightly stale data is acceptable, and when the cache is not the system of record. It is not appropriate when every read must reflect the absolute latest write (use write-through caching instead) or when the dataset is small enough to fit entirely in memory (use an in-process cache instead).

### Circuit Breaker (Opossum)

**What it is**: A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing service. It works like an electrical circuit breaker: when failures exceed a threshold, the circuit "opens" and all subsequent calls fail immediately without attempting the operation. After a timeout period, the circuit enters a "half-open" state where a limited number of test requests are allowed through to check if the downstream service has recovered.

**How it works**: The circuit breaker tracks the success and failure rate of calls to a protected resource. In this project, one Opossum breaker wraps the whole suggestion lookup (`getSuggestionsWithMeta`: cache read, trie lookup, ranking), with three states:
- **Closed** (normal): All requests pass through. A call slower than 100ms counts as a failure; once at least 10 calls have been seen and 30% of them failed, the circuit opens.
- **Open** (failing): All requests are immediately answered by the fallback, an empty list marked `degraded` and sent with `Cache-Control: no-store`. After 5 seconds, the circuit transitions to half-open.
- **Half-open** (testing): The next request is let through as a test. If it succeeds, the circuit closes; if it fails, the circuit reopens.

Redis is not behind a breaker here: every Redis call on the request path fails fast while the client is disconnected and is raced against a short timeout (50ms for cache reads, 30ms for ranking signals), so a Redis outage degrades ranking instead of tripping the breaker.

**Why it matters**: Without a circuit breaker, when a downstream service (like a trie shard or Redis) becomes slow or unavailable, every incoming request would wait for the full timeout duration before failing. This ties up server threads, causes request queues to build up, and eventually crashes the calling service -- a phenomenon called cascading failure. The circuit breaker stops this cascade by failing fast, returning a degraded response (like cached suggestions or an empty list) in milliseconds rather than waiting seconds for a timeout.

**When to use it**: Use circuit breakers around any call to an external service that could fail or become slow: database connections, HTTP calls to other services, message queue operations. Do not use them for in-process function calls or operations that are expected to fail frequently (like user input validation).

### Structured Logging (Pino)

**What it is**: Structured logging produces log entries as machine-parseable JSON objects rather than human-readable text strings. Each log entry is a flat or nested JSON object with consistent field names, enabling automated parsing, filtering, indexing, and alerting by log aggregation systems.

**How it works**: Instead of writing `console.log('Request to /suggestions took 12ms')`, structured logging produces `{"level":"info","type":"request","path":"/api/v1/suggestions","durationMs":12,"cacheHit":true,"requestId":"abc-123"}`. Every log entry includes a severity level, a timestamp, and contextual fields. The `pino-http` middleware automatically logs every HTTP request with method, path, status code, and duration. Developers add domain-specific fields (like `query`, `cacheHit`, `suggestionCount`) when logging business events.

**Why it matters**: In production, an application might produce millions of log lines per hour. Text-based logs require regular expressions to extract useful information, which is fragile and slow. JSON logs can be directly indexed by systems like Elasticsearch, Datadog, or CloudWatch, enabling queries like "show me all requests where durationMs > 100 and cacheHit is false" in seconds. Request IDs (correlation IDs) link related log entries across services, enabling end-to-end request tracing. In this project, query strings are truncated in logs to protect user privacy while still enabling debugging.

**When to use it**: Always in production environments. Text-based "pretty" logging is appropriate only during local development (Pino supports both via `pino-pretty` in dev mode). Structured logging is especially critical when running multiple service instances, as it enables correlating logs across instances using request IDs.

### Prometheus Metrics (prom-client)

**What it is**: Prometheus is a monitoring system that collects numerical time-series data from applications. The application exposes a `/metrics` HTTP endpoint that Prometheus periodically scrapes (typically every 15-30 seconds). The `prom-client` library provides four metric types: Counter (only goes up), Gauge (goes up and down), Histogram (distribution of values in configurable buckets), and Summary (similar to histogram with quantile calculation).

**How it works**: The application creates metric objects at startup (e.g., a Histogram for request latency, a Counter for total requests, a Gauge for cache hit rate). During request processing, the application records observations: `latencyHistogram.observe(0.012)` records a 12ms request, `requestCounter.inc({status: "200"})` counts a successful request. Prometheus scrapes the `/metrics` endpoint and stores the time-series data. Grafana dashboards visualize the data, and alerting rules trigger notifications when metrics cross thresholds.

**Why it matters**: Logs tell you what happened to individual requests; metrics tell you what is happening to the system as a whole. A single slow request might not matter, but if the P99 latency crosses 50ms for 2 minutes, that is an SLO violation that needs investigation. Metrics enable capacity planning (how many QPS can we handle before latency degrades?), anomaly detection (why did cache hit rate drop from 95% to 60%?), and alerting (page the on-call engineer when error rate exceeds 1%). In this project, metrics track suggestion latency, cache hit rates, trie size, aggregation buffer depth, and filtered query counts.

**When to use it**: In any production system. Metrics are the foundation of observability and are required for SLO-based operations. Even in development, metrics help identify performance bottlenecks and validate that optimizations work.

### Rate Limiting

**What it is**: Rate limiting restricts the number of requests a client can make within a time window. It protects the service from abuse (intentional or accidental) by rejecting excess requests with HTTP 429 (Too Many Requests) responses before they consume server resources.

**How it works**: The server maintains a counter for each client (identified by IP address, API key, or user ID). When a request arrives, the counter is checked against the configured limit. If the count is below the limit, the request proceeds and the counter increments. If the count exceeds the limit, the request is immediately rejected with a 429 response and a `Retry-After` header indicating when the client can try again. The counter resets at the end of each time window. This project uses `express-rate-limit` with fixed windows per client IP, kept in each process's memory: 20 suggestion requests per second (fast typing), 5 search logs per second, 30 admin requests per minute, and 1,000 requests per minute overall, with `/health`, `/health/*` and `/metrics` exempt. The key is the socket address; `X-Forwarded-For` is honored only when `TRUST_PROXY` is set, so a client cannot pick its own rate-limit key.

**Why it matters**: Without rate limiting, a single misbehaving client (a buggy script, a crawler, or an attacker) can consume all server resources, causing the service to become unavailable for legitimate users. Rate limiting also prevents brute-force attacks on admin endpoints and reduces the impact of DDoS attacks. In a typeahead system, rate limiting is especially important because every keystroke could trigger a request -- a fast typist hitting 10 characters per second generates 10 requests per second per user.

**When to use it**: On every externally-facing API. Apply stricter limits to expensive operations (search, write operations) and more generous limits to cheap operations (health checks). Rate limiting should be applied at the API gateway level in production and at the application level for defense in depth.

### Idempotency

**What it is**: Idempotency means that performing the same operation multiple times produces the same result as performing it once. In the context of APIs, an idempotent operation can be safely retried without causing duplicate side effects (double counting, duplicate records, or double charges).

**How it works**: The client includes a unique idempotency key with each request (e.g., `userId_timestamp_randomSuffix`). The server checks whether it has already processed a request with that key. If yes, it returns the cached result from the first processing. If no, it processes the request, caches the result keyed by the idempotency key, and returns the result. The cached result has a TTL (5 minutes in this project) after which the key expires and the same operation could be processed again. In this project only admin mutations take part, and only when the client sends `X-Idempotency-Key`: the key is reserved with Redis `SET NX` (an in-memory map while Redis is down), a concurrent duplicate gets 409, a completed 2xx-4xx response is replayed for 5 minutes, and reusing the key with a different body gets 422. Without the header, every request runs; the server never derives a key from the request body, since two identical "clear cache" clicks are two intended actions.

**Why it matters**: Network communication is unreliable. A client might send a request, the server processes it successfully, but the response is lost due to a network timeout. The client, not knowing if the request succeeded, retries. Without idempotency, the query log would count the same search twice, inflating metrics and corrupting trending rankings. At 200K queries per second, even a 0.1% retry rate means 200 duplicate operations per second. (Locally `POST /log` accepts that: it is not deduplicated, and a retry counts twice.) Trie updates in this project are idempotent by design: the flush and admin routes insert the absolute count stored in `phrase_counts` rather than a delta, so rebuilding from the same snapshot always produces the same trie.

**When to use it**: For any operation that has side effects (writes data, sends messages, charges money). Read-only operations (GET requests) are naturally idempotent and do not need explicit idempotency keys. Operations that are inherently idempotent by their data model (like UPSERT or SET) may not need application-level idempotency keys.

### Health Checks

**What it is**: Health checks are dedicated HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers, container orchestrators (Kubernetes), and monitoring systems to make automated decisions about routing traffic and restarting failed instances.

**How it works**: This project implements three health check endpoints:
- **`/health`** (liveness): Returns 200 if the process is alive. Used by Kubernetes to decide whether to restart the container. Should never check external dependencies -- if the process can respond to HTTP, it is alive.
- **`/health/ready`** (readiness): Returns 200 only if the trie is loaded with at least one phrase, Redis responds to PING, and PostgreSQL responds to `SELECT 1`; otherwise 503. Used by load balancers to decide whether to route traffic to this instance. A new instance that has not finished loading its trie reports "not ready" so it does not receive traffic before it can serve suggestions.
- **`/health/circuits`**: Reports the state of each circuit breaker (closed, open, half-open). Used by operators to diagnose cascading failures.

**Why it matters**: Without health checks, a load balancer has no way to know if a server instance is healthy. It would continue sending traffic to a server whose database connection is broken, resulting in every request failing with a 500 error. With readiness checks, the load balancer removes the unhealthy instance from rotation, and traffic flows only to healthy instances. Liveness checks enable automatic recovery: if a process enters a deadlocked state where it cannot serve requests but has not crashed, the liveness check will fail and the orchestrator will restart it.

**When to use it**: Every production service needs at least liveness and readiness checks. The liveness check should be trivially simple (return 200). The readiness check should verify that all critical dependencies are reachable. Avoid making health checks too expensive (do not run a full database query; a simple connection test is sufficient).

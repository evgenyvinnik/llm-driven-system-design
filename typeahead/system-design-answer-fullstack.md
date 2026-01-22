# Typeahead - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 📋 Introduction

"I'll design an end-to-end typeahead/autocomplete system. This is a great full-stack problem because success depends on tight integration between frontend caching layers and backend serving infrastructure. The user experience requires sub-50ms perceived latency, which we can only achieve by coordinating caches at every layer - from browser memory to CDN edge to backend Redis to the trie itself."

---

## 🎯 Requirements

### Functional Requirements

1. **Suggest** - Return top suggestions as the user types each character
2. **Rank** - Multi-factor scoring combining popularity, recency, personalization, and trending
3. **Cache** - Multi-layer caching from browser memory to CDN to origin
4. **Update** - Surface trending topics within 5 minutes
5. **Offline** - Work without network using cached data

### Non-Functional Requirements

1. **Latency** - Sub-50ms P99 end-to-end (perceived)
2. **Availability** - 99.99% uptime
3. **Scale** - 100K+ QPS at peak
4. **Cache Hit Rate** - Greater than 80% at CDN level
5. **Freshness** - Trending topics visible within 5 minutes

### Scale Estimates

- Unique queries in index: 1 billion
- Peak QPS: 100,000+
- Keystrokes per session: 50-100
- API calls per session: 10-20 (after frontend caching/debouncing)

---

## 🏗️ High-Level Design

"Let me draw the end-to-end architecture showing how frontend and backend work together."

```
+-------------------------------------------------------------------------+
|                              FRONTEND                                    |
+-------------------------------------------------------------------------+
|                                                                          |
|   +---------------+   +----------------+   +------------------+          |
|   |  Search Box   |   | Command Palette|   | Rich Typeahead   |          |
|   +-------+-------+   +-------+--------+   +--------+---------+          |
|           |                   |                     |                    |
|           +---------+---------+----------+----------+                    |
|                     |                    |                               |
|                     v                    v                               |
|   +--------------------------------------------------------------+      |
|   |              Typeahead Core Module                            |      |
|   |   Debounce --> Cache Check --> Fetch --> Merge --> Re-rank   |      |
|   +--------------------------------------------------------------+      |
|           |                   |                     |                    |
|           v                   v                     v                    |
|   +---------------+   +----------------+   +------------------+          |
|   | Memory Cache  |   | Service Worker |   | IndexedDB        |          |
|   | 0ms, 500 items|   | 1-5ms, SW-R    |   | 5-20ms, offline  |          |
|   +---------------+   +----------------+   +------------------+          |
|                                                                          |
+------------------------------------+------------------------------------+
                                     |
                                     | HTTPS
                                     v
+-------------------------------------------------------------------------+
|                              NETWORK                                     |
+-------------------------------------------------------------------------+
|                                                                          |
|   CDN Edge (10-50ms) ---> API Gateway ---> Load Balancer                |
|                                                                          |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                              BACKEND                                     |
+-------------------------------------------------------------------------+
|                                                                          |
|   +--------------------------------------------------------------+      |
|   |                   Suggestion Service                          |      |
|   |        Prefix Match --> Score --> Personalize --> Respond    |      |
|   +--------------------------------------------------------------+      |
|           |                   |                     |                    |
|           v                   v                     v                    |
|   +---------------+   +----------------+   +------------------+          |
|   | Trie Servers  |   | Ranking Service|   | User Data Store  |          |
|   | (Sharded)     |   | (Real-time)    |   | (Redis)          |          |
|   +---------------+   +----------------+   +------------------+          |
|                               |                                          |
|                               v                                          |
|   +--------------------------------------------------------------+      |
|   |                  Aggregation Pipeline                         |      |
|   |      Query Logs --> Kafka --> Filter --> Count --> Trie      |      |
|   +--------------------------------------------------------------+      |
|                                                                          |
+-------------------------------------------------------------------------+
```

### End-to-End Request Flow

```
User types "wea"
      |
      v
+---------------------+
| 1. Debounce (150ms) |  <-- Frontend waits for typing pause
+----------+----------+
           |
           v
+---------------------+
| 2. Memory Cache?    |  <-- Check in-memory LRU cache (0ms)
+----------+----------+
           | MISS
           v
+---------------------+
| 3. Service Worker?  |  <-- Check SW cache (1-5ms)
+----------+----------+
           | MISS
           v
+---------------------+
| 4. CDN Edge Cache?  |  <-- Check CDN cache (10-50ms)
+----------+----------+
           | MISS
           v
+---------------------+
| 5. Redis Cache?     |  <-- Backend Redis (1-5ms)
+----------+----------+
           | MISS
           v
+---------------------+
| 6. Trie Lookup      |  <-- Query sharded trie (1-3ms)
+----------+----------+
           |
           v
+---------------------+
| 7. Apply Ranking    |  <-- Score with weights (1-2ms)
+----------+----------+
           |
           v
+---------------------+
| 8. Response flows   |
| back through layers |  <-- Each layer caches for next time
+----------+----------+
           |
           v
+---------------------+
| 9. Frontend re-rank |  <-- Boost based on local history
+----------+----------+
           |
           v
+---------------------+
| 10. Render dropdown |
+---------------------+
```

---

## 🔍 Deep Dive

### Deep Dive 1: API Contract and Type Sharing

"The API contract is the critical integration point. Let me discuss how we share types between frontend and backend."

**Trade-off: Shared TypeScript Types vs OpenAPI Codegen**

| Approach | Pros | Cons |
|----------|------|------|
| **Shared TypeScript Types (Monorepo)** | Simple setup, instant IDE support, refactor-friendly | Only works for TypeScript clients, requires monorepo |
| **OpenAPI/Swagger Codegen** | Multi-language clients, formal contract, API documentation | More tooling, generated code can be verbose |
| **GraphQL Schema** | Strong typing, introspection, single endpoint | Overkill for simple suggest API, learning curve |

**Decision: Shared TypeScript Types**

> "Since we're a TypeScript monorepo with one frontend client, I'd use shared types in a common package. This gives us instant type safety with zero codegen overhead. If we later need mobile clients, we can add OpenAPI generation from those same types."

**Trade-off: REST vs GraphQL for Suggestions API**

| Approach | Pros | Cons |
|----------|------|------|
| **REST with query params** | Simple, CDN-cacheable with URL as key, widely understood | Less flexible for complex queries |
| **GraphQL** | Flexible field selection, single endpoint, introspection | Harder to cache at CDN, more complex setup |
| **gRPC** | High performance, streaming support | Not browser-friendly without proxy |

**Decision: REST with Query Parameters**

> "For typeahead, REST is ideal because the CDN can cache based on the URL. A request like `/api/v1/suggestions?q=wea&limit=5` becomes a simple cache key. GraphQL's POST requests make CDN caching much harder, and we need that 80%+ cache hit rate."

### Deep Dive 2: Multi-Layer Caching Architecture

"Achieving sub-50ms latency requires caching at every layer. Let me walk through the cache hierarchy."

```
Request Flow with Cache Layers
==============================

User types --> [Frontend Memory] --> [Service Worker] --> [CDN Edge]
                   0ms                   1-5ms             10-50ms
                 500 items             Stale-WR           Public cache
                                                              |
                                                              v
                                    [Redis Backend] <-- [Origin Server]
                                        1-5ms              5-10ms
                                       60s TTL          Trie lookup
```

**Trade-off: Cache Strategy for Anonymous vs Personalized**

| Approach | Pros | Cons |
|----------|------|------|
| **CDN-cache everything, personalize client-side** | Maximum cache hit rate, simple | Limited personalization |
| **No CDN cache, personalize server-side** | Rich personalization | Poor latency, expensive |
| **Hybrid: CDN for anonymous, private for logged-in** | Best of both | Two code paths |

**Decision: Hybrid CDN Strategy**

> "I'd cache anonymous requests publicly at the CDN with a 60-second TTL. For logged-in users, we set `Cache-Control: private` and let the browser/service worker cache. The backend adds personalization, and the frontend re-ranks based on local history. This gives us 80%+ CDN hits for anonymous users while still personalizing for logged-in users."

**Trade-off: Multi-Layer vs Single Cache**

| Approach | Pros | Cons |
|----------|------|------|
| **Multi-layer (Memory, SW, IndexedDB, CDN, Redis)** | Offline support, resilience, optimal latency | Complexity, cache invalidation |
| **Single CDN cache** | Simple, one cache to manage | No offline, single point of failure |
| **Client-side only** | Offline works, user controls data | Cold start penalty, no cross-device |

**Decision: Multi-Layer Caching**

> "For typeahead, multi-layer is worth the complexity because users expect instant responses. Memory cache gives 0ms for repeated prefixes. Service worker enables stale-while-revalidate. IndexedDB provides offline. CDN reduces origin load. Redis prevents trie pressure. Each layer serves a purpose."

### Deep Dive 3: Trie with Pre-computed Top-K

"The core data structure is a trie with pre-computed suggestions at each node."

```
Trie Structure with Pre-computed Top-K
======================================

                          [root]
                       /    |    \
                      /     |     \
                   [w]    [s]    [a]
                    |      |      |
              top-k:     top-k:   top-k:
              weather    sport    apple
              world      search   amazon
              work       social   android
                    |
                   [e]
                    |
              top-k:
              weather
              web
              welcome
                    |
                   [a]
                    |
              top-k:
              weather
              wealth
              weapon
```

**Trade-off: Pre-computed Top-K vs On-Demand Traversal**

| Approach | Pros | Cons |
|----------|------|------|
| **Pre-computed Top-K** | O(1) lookup after prefix walk | Higher memory, updates require propagation |
| **On-demand Traversal** | Less memory, always fresh | O(n) worst case, slower queries |
| **Hybrid (cache hot paths)** | Good performance, less memory | Complexity, cold cache penalty |

**Decision: Pre-computed Top-K**

> "I'd pre-compute top-10 suggestions at each node. With 1 billion phrases and average 10-character prefixes, we're storing roughly 10 billion node-suggestion pairs. That's a lot of memory, but lookup is O(prefix_length) which is typically 3-5 characters. For a latency-critical system, I'll trade memory for speed."

### Deep Dive 4: Sharding Strategy

"With 1 billion phrases, we need to shard the trie across multiple servers."

```
First-Character Sharding
========================

Prefix "weather" --> hash('w') % 26 --> Shard-22
Prefix "search"  --> hash('s') % 26 --> Shard-18
Prefix "apple"   --> hash('a') % 26 --> Shard-0

Hot Spot Handling (for popular letters)
=======================================

Letter 's' is hot --> Sub-shard by second character
  - "sa..." --> s-shard-1
  - "se..." --> s-shard-2
  - "so..." --> s-shard-3
```

**Trade-off: First-Character Sharding vs Consistent Hashing**

| Approach | Pros | Cons |
|----------|------|------|
| **First-character sharding** | Prefix locality, predictable routing | Uneven distribution, hot spots |
| **Consistent hashing on full phrase** | Even distribution | Loses prefix locality, must query all shards |
| **Range-based sharding** | Good locality | Rebalancing pain, hot ranges |

**Decision: First-Character Sharding with Sub-sharding**

> "I'd shard by first character because all prefixes starting with 's' go to the same shard - no scatter-gather needed. The downside is letters like 's' and 'a' are hotter than 'x' or 'z'. I'd handle this with sub-sharding: if 's' is overloaded, split it into 's-a-m' and 's-n-z'. This maintains prefix locality while addressing hot spots."

### Deep Dive 5: Request Reduction Strategy

"We need to minimize requests at every layer to hit our latency targets."

```
Request Reduction Flow
======================

User types: w...e...a...t...h...e...r

Without debounce: 7 API requests
With 150ms debounce: 2-3 API requests
With memory cache: 1-2 API requests
With prefix caching: often 0 API requests

Prefix Caching Strategy
=======================

API returns results for "wea":
  [weather, wealth, weapon, wear, weave]

Frontend caches:
  "wea" --> [weather, wealth, weapon, wear, weave]
  "we"  --> [weather, wealth, weapon, wear, weave, web, welcome]  (subset)
  "w"   --> [weather, world, work, web, welcome, ...] (subset)

When user backspaces "wea" -> "we":
  Memory cache HIT! No API call needed.
```

**Trade-off: Debounce vs Throttle**

| Approach | Pros | Cons |
|----------|------|------|
| **Debounce (150ms)** | Waits for pause, fewer requests | Slight delay after last keystroke |
| **Throttle (100ms)** | Consistent updates, feels responsive | More requests, may feel laggy |
| **Adaptive (vary by network)** | Best UX across conditions | Complex to implement |

**Decision: Debounce with Immediate First Request**

> "I'd use 150ms debounce with immediate first character. User types 'w' - immediate request. Types 'we' within 150ms - debounced. Pauses - request fires. This balances responsiveness with request reduction. Combined with prefix caching, we often serve from memory cache anyway."

### Deep Dive 6: Multi-Factor Ranking

"Ranking combines multiple signals. The backend does heavy lifting, frontend adds personalization."

```
Backend Ranking (5 factors)
===========================

Final Score = Popularity (30%)  --> log10(search_count)
            + Recency (15%)     --> exp(-hours / 168)  [1-week half-life]
            + Personal (25%)    --> user history match
            + Trending (20%)    --> sliding window velocity
            + Match (10%)       --> prefix match quality

Frontend Re-ranking
===================

Backend returns: [weather, wealth, weapon, wear, weave]

User has searched "weather forecast" 5x this week
User searched "wear shoes" yesterday

Frontend boosts:
  "weather" --> +0.3 (frequency boost)
  "wear"    --> +0.2 (recency boost)

Final: [weather, wear, wealth, weapon, weave]
```

**Trade-off: ML-Based Learning-to-Rank vs Weighted Formula**

| Approach | Pros | Cons |
|----------|------|------|
| **Weighted formula** | Simple, explainable, easy to tune | Less adaptive, manual tuning |
| **ML-based LTR** | Learns from user behavior, more accurate | Black box, training pipeline needed |
| **Hybrid (ML for weights)** | Best of both | Complexity |

**Decision: Weighted Formula with A/B Testing**

> "I'd start with a weighted formula because it's explainable - we can debug why 'weather' ranked above 'wealth'. We tune weights through A/B testing on click-through rate. If we hit a ceiling, we can add ML to learn optimal weights or introduce neural ranking. Don't over-engineer on day one."

### Deep Dive 7: Real-Time Aggregation Pipeline

"To surface trending topics within 5 minutes, we need a real-time aggregation pipeline."

```
Aggregation Pipeline
====================

User selects      Query Log        Kafka Topic     Stream Processor
"weather" ------> (sendBeacon) --> query_logs ---> [Filter + Count]
                                                          |
                                                          v
                                                   Sliding Window
                                                   (5-min buckets)
                                                          |
                                                          v
                                                   Trending Sorted Set
                                                   (Redis ZSET)
                                                          |
                                                          v
                                                   Trie Update
                                                   (every 60s flush)
```

**Trade-off: Kafka for Log Aggregation vs Direct Database Writes**

| Approach | Pros | Cons |
|----------|------|------|
| **Kafka queue** | High throughput, decoupled, replay | Extra infrastructure, slight delay |
| **Direct PostgreSQL writes** | Simple, transactional | Write bottleneck at scale |
| **In-memory aggregation only** | Fast, no persistence | Data loss on restart |

**Decision: Kafka with Buffered Trie Updates**

> "At 100K QPS, direct database writes would bottleneck. I'd send query logs to Kafka, consume with a stream processor that updates sliding window counters in Redis, then batch-flush to the trie every 60 seconds. This gives us 5-minute freshness for trending while protecting the trie from write storms."

**Trade-off: Beacon API vs Fetch for Logging**

| Approach | Pros | Cons |
|----------|------|------|
| **Beacon API (sendBeacon)** | Non-blocking, survives page close | Fire-and-forget, no response |
| **Fetch with keepalive** | Can get response, more control | Blocks if not using keepalive |
| **Background sync (SW)** | Reliable delivery, offline queue | More complex, browser support |

**Decision: Beacon API with Fetch Fallback**

> "For logging completed searches, I'd use `navigator.sendBeacon`. It's non-blocking - the user clicks a result, we log it, they navigate away. The beacon still sends. If sendBeacon isn't available, fall back to fetch with keepalive. We don't need the response, so fire-and-forget is perfect."

### Deep Dive 8: Error Handling and Graceful Degradation

"The system must degrade gracefully when components fail."

```
Fallback Chain
==============

Primary Path:
[Trie] --> [Ranking] --> [Response]
   |           |
   v           v
[Circuit Breaker Opens]
   |
   v
Fallback 1: Stale Redis Cache
   |
   v
Fallback 2: Popular suggestions for prefix letter
   |
   v
Fallback 3: Empty response (frontend shows history)
```

**Trade-off: Circuit Breaker Pattern vs Retry with Backoff**

| Approach | Pros | Cons |
|----------|------|------|
| **Circuit breaker** | Fails fast, prevents cascade | Needs careful tuning |
| **Retry with exponential backoff** | Simple, handles transient failures | Can amplify load during outages |
| **Bulkhead isolation** | Contains failures | Resource overhead |

**Decision: Circuit Breaker with Retry for Transient Failures**

> "I'd implement circuit breakers around the trie service and ranking service. After 5 failures in 30 seconds, the circuit opens and we fail fast to fallback. This prevents a struggling trie from taking down the whole system. For transient network blips, we retry once with 50ms delay before tripping the breaker."

### Deep Dive 9: Frontend Offline Support

"Users should get suggestions even without network."

```
Offline Architecture
====================

Online:
  API Response --> Memory Cache --> IndexedDB (background sync)
                                         |
                                         v
                              Serialize popular prefixes
                              + local trie subset

Offline:
  User types --> Memory Cache --> IndexedDB Trie --> Local History
     |               |                |                  |
     v               v                v                  v
  [Check]         [HIT?]          [Lookup]           [Merge]
     |               |                |                  |
     +---------------+----------------+------------------+
                               |
                               v
                       Render suggestions
```

**Trade-off: Full Trie Download vs Popular Prefixes Only**

| Approach | Pros | Cons |
|----------|------|------|
| **Full trie download** | Complete offline | Massive download (GBs) |
| **Top 10K queries** | Small download, covers 80% | Long-tail queries fail |
| **User-personalized subset** | Relevant to user | Requires user model |

**Decision: Popular Prefixes + User History**

> "I'd sync the top 10,000 queries covering 80% of searches - that's maybe 500KB compressed. Plus the user's own search history. This gives good offline coverage for common queries and personal queries. For rare queries offline, we show 'no suggestions' gracefully."

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Type sharing | Shared TS types | OpenAPI codegen | Monorepo simplicity |
| API style | REST | GraphQL | CDN cacheability |
| Caching | Multi-layer | Single CDN | Offline + resilience |
| Anonymous vs personal | Hybrid CDN | All private | 80% cache hits |
| Trie structure | Pre-computed Top-K | On-demand traversal | O(1) lookup speed |
| Sharding | First-character | Consistent hash | Prefix locality |
| Request reduction | Debounce + prefix cache | Throttle | Fewer requests |
| Ranking | Weighted formula | ML-based LTR | Explainability |
| Log aggregation | Kafka | Direct DB writes | Throughput |
| Search logging | Beacon API | Fetch | Non-blocking |
| Error handling | Circuit breaker | Retry only | Fail fast |
| Offline | Popular + history | Full trie | Reasonable size |

---

## 🚀 Future Enhancements

1. **WebSocket Streaming** - Push updated suggestions as backend data changes in real-time

2. **Fuzzy Matching** - Edit-distance tolerant matching for typos (Levenshtein distance, BK-trees)

3. **ML-Based Ranking** - Learning-to-rank using click-through signals and user engagement

4. **Geo-Sharding** - Region-specific suggestions (sports teams, local businesses)

5. **A/B Testing Framework** - Experiment with ranking weights and debounce timings

6. **Voice Integration** - Speech-to-text with typeahead for voice search

7. **Rich Suggestions** - Include images, categories, and metadata in results

---

## 📝 Summary

"To summarize, I've designed a full-stack typeahead system with these key integration points:

**Frontend-Backend Coordination:**
- Shared TypeScript types ensure type safety across the stack
- REST API with URL-based cache keys enables CDN caching
- Frontend debounce reduces requests before they hit the network
- Frontend re-ranks with local history on top of backend scores

**Multi-Layer Caching:**
- Memory cache (0ms) for immediate responses
- Service worker (1-5ms) for stale-while-revalidate
- IndexedDB (5-20ms) for offline support
- CDN edge (10-50ms) for anonymous users
- Redis (1-5ms) for backend cache
- Pre-computed Top-K in trie (0ms lookup after prefix walk)

**Graceful Degradation:**
- Circuit breakers prevent cascade failures
- Fallback chain: stale cache, popular suggestions, local history
- Offline mode with synced popular queries

**Real-Time Updates:**
- Beacon API for non-blocking search logging
- Kafka pipeline for high-throughput log aggregation
- Sliding window counters for trending detection
- 5-minute freshness for trending topics

The key insight is that sub-50ms latency requires tight integration between frontend and backend caching strategies. Neither layer can achieve this alone - they must work together."

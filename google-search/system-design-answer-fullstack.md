# Google Search - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 📋 Introduction (1 minute)

"I'll design Google Search, a web search engine that indexes and searches 100+ billion web pages with sub-200ms latency. As a full-stack engineer, I'll focus on how the frontend and backend systems integrate: the search interface with autocomplete, how queries flow through the API to the index, and how results are streamed back for progressive rendering.

The key full-stack challenges are building a responsive search experience with instant feedback, designing APIs that support both fast autocomplete and comprehensive search results, and optimizing the data flow from inverted index to rendered snippets."

---

## 🎯 Requirements (3 minutes)

### Functional Requirements
- Crawl and discover web pages continuously
- Build and maintain a searchable index of content
- Process user search queries with real-time autocomplete
- Rank results by relevance, quality, and freshness
- Serve results with low latency and rich snippets

### Non-Functional Requirements
- Scale: Index 100B+ web pages
- Latency: < 200ms for search, < 50ms for autocomplete
- Freshness: Update popular pages daily
- Accessibility: WCAG 2.1 AA compliant interface

### Scale Estimates
- 100+ billion web pages indexed
- 8+ billion searches per day
- Average query touches millions of documents
- Index size: Petabytes

---

## 🏗️ High-Level Design (5 minutes)

```
+------------------+       +------------------+       +------------------+
|     FRONTEND     |       |    API LAYER     |       |   BACKEND CORE   |
|                  |       |                  |       |                  |
|  Search Box      |       |  /autocomplete   |       |  Query Processor |
|  Results List    | <---> |  /search         | <---> |  Ranker          |
|  Pagination      |       |  /suggest        |       |  Index Servers   |
|  Filters         |       |  Rate Limiter    |       |  Cache Layer     |
+------------------+       +------------------+       +------------------+
        |                          |                          |
        v                          v                          v
+------------------+       +------------------+       +------------------+
|   STATE LAYER    |       |    MIDDLEWARE    |       |    DATA LAYER    |
|                  |       |                  |       |                  |
|  Zustand Store   |       |  Authentication  |       |  Elasticsearch   |
|  Query History   |       |  Caching Logic   |       |  PostgreSQL      |
|  Preferences     |       |  Logging         |       |  Redis           |
+------------------+       +------------------+       +------------------+
```

### Why These Components?

"I'm structuring this as three horizontal layers because it maps cleanly to team ownership and allows independent scaling. The frontend layer handles user interaction and local state. The API layer acts as a gateway with cross-cutting concerns like rate limiting. The backend core contains the search logic that takes the most engineering investment."

---

## 🔍 Deep Dive (20 minutes)

### Deep Dive 1: Search Box with Autocomplete

"The search box is the most critical UI element. Users expect instant feedback as they type."

```
User Types: "javasc"
      |
      v
+-------------------+
| Debounce 150ms    |  <-- Prevents excessive API calls
+-------------------+
      |
      v
+-------------------+
| GET /autocomplete |
| ?q=javasc         |
+-------------------+
      |
      v
+-------------------+     miss      +-------------------+
|   Redis Cache     | -----------> |   Suggestion      |
|   (TTL: 5 min)    |              |   Trie Lookup     |
+-------------------+              +-------------------+
      | hit                               |
      v                                   v
+-------------------+              +-------------------+
| Return cached     |              | Merge sources:    |
| suggestions       |              | - Trie results    |
+-------------------+              | - Popular queries |
                                   | - Corrections     |
                                   +-------------------+
                                          |
                                          v
                                   +-------------------+
                                   | Cache & Return    |
                                   | Top 10 suggestions|
                                   +-------------------+
```

#### Trade-off 1: Why 150ms Debounce vs Other Values?

| Aspect | 150ms (Chosen) | 50ms | 300ms |
|--------|----------------|------|-------|
| Feel | ✅ Balanced | Too aggressive | Sluggish |
| API calls | ✅ ~85% reduction | 60% reduction | 95% reduction |
| User perception | ✅ "Instant" | Better | Noticeable delay |
| Server load | ✅ Moderate | High | Low |

"I'm choosing 150ms because user studies show anything under 200ms feels instantaneous. At 50ms, we'd make too many wasted API calls for fast typists. At 300ms, users notice the lag. 150ms hits the sweet spot where most users have paused momentarily after typing a few characters."

#### Trade-off 2: Why Trie + Redis vs Database-Only?

| Aspect | Trie + Redis (Chosen) | Database Only |
|--------|----------------------|---------------|
| Latency | ✅ < 10ms | 50-100ms |
| Memory usage | Higher (in-memory) | ✅ Lower |
| Prefix search | ✅ O(k) where k=prefix length | Table scan or LIKE query |
| Updates | Periodic rebuild | ✅ Real-time |
| Complexity | Higher | ✅ Simpler |

"I'm choosing Trie + Redis because autocomplete has a hard 50ms latency requirement. A database round-trip alone consumes most of that budget. The trie gives us O(k) prefix lookups, and Redis provides the distributed cache layer. We accept the complexity of periodic rebuilds because suggestions don't need to be real-time fresh."

---

### Deep Dive 2: API Design and Integration

"The API layer bridges frontend and backend. I need to decide on the contract between them."

```
+------------------+       +------------------+       +------------------+
|    FRONTEND      |       |     API          |       |    BACKEND       |
|                  |       |                  |       |                  |
|  TypeScript      |       |  Express +       |       |  Query Parser    |
|  Interfaces      | <---> |  TypeScript      | <---> |  Elasticsearch   |
|                  |       |                  |       |  Ranker          |
+------------------+       +------------------+       +------------------+
        |                          |                          |
        +----------+---------------+                          |
                   |                                          |
                   v                                          |
        +------------------+                                  |
        | Shared Types     | <--------------------------------+
        | (npm package or  |
        |  monorepo path)  |
        +------------------+
```

#### Trade-off 3: Why REST API vs GraphQL for Search?

| Aspect | REST (Chosen) | GraphQL |
|--------|--------------|---------|
| Caching | ✅ HTTP caching works naturally | Requires custom cache layer |
| Simplicity | ✅ Simple GET /search?q=... | Query parsing overhead |
| Response shape | Fixed, predictable | ✅ Client-specified |
| Tooling | ✅ Universal support | Needs Apollo/Relay |
| Performance | ✅ Minimal overhead | Schema validation cost |

"I'm choosing REST over GraphQL because search responses have a predictable shape. GraphQL's flexibility is wasted here since every client wants the same fields. More importantly, REST's native HTTP caching integrates with CDNs and browser caches. For a search engine, cache hit rate directly impacts infrastructure cost."

#### Trade-off 4: Why Shared TypeScript Types vs OpenAPI Codegen?

| Aspect | Shared Types (Chosen) | OpenAPI Codegen |
|--------|----------------------|-----------------|
| Setup complexity | ✅ Low (path import) | Schema definition + tooling |
| Type safety | ✅ Compile-time | ✅ Compile-time |
| Runtime validation | Manual | ✅ Auto-generated |
| Cross-language | TypeScript only | ✅ Any language |
| Maintenance | ✅ Single source | Schema drift risk |

"I'm choosing shared TypeScript types because both frontend and backend are TypeScript in this monorepo. We get compile-time safety with zero codegen overhead. If we had multiple client languages or an external API, OpenAPI would be worth the investment."

---

### Deep Dive 3: Search Execution Flow

```
User Submits: "javascript tutorial"
           |
           v
+------------------------+
| GET /search?q=...      |
| Parse query params     |
+------------------------+
           |
           v
+------------------------+       +------------------------+
|    Redis Cache         | ----> | Return cached results  |
|    Key: query hash     |  hit  | (Add timing metadata)  |
+------------------------+       +------------------------+
           | miss
           v
+------------------------+
|    Query Parser        |
|    - Extract terms     |
|    - Parse operators   |
|    - Detect phrases    |
+------------------------+
           |
           v
+------------------------+
|    Elasticsearch       |
|    - BM25 text match   |
|    - Apply filters     |
|    - Get top 1000 docs |
+------------------------+
           |
           v
+------------------------+
|    Phase 2 Ranking     |
|    - Add PageRank      |
|    - Add freshness     |
|    - Add click data    |
|    - Re-rank top 100   |
+------------------------+
           |
           v
+------------------------+
|    Snippet Generation  |
|    - Find best passage |
|    - Highlight terms   |
|    - Truncate text     |
+------------------------+
           |
           v
+------------------------+
|    Cache & Return      |
|    - Store in Redis    |
|    - Send to client    |
+------------------------+
```

#### Trade-off 5: Why Cache Results for 5 Minutes vs Other TTLs?

| TTL | Pros | Cons |
|-----|------|------|
| No cache | Always fresh | ❌ High index load |
| 1 minute | Very fresh | Moderate cache hits |
| **5 minutes** | ✅ Good hit rate (~70%) | Acceptable staleness |
| 1 hour | Excellent hit rate | ❌ Stale for trending topics |

"I'm choosing 5-minute TTL because query distribution follows a power law. Popular queries repeat frequently within 5 minutes, giving us ~70% cache hit rate. For breaking news queries, we can add a bypass mechanism. The staleness is acceptable because web content doesn't change that fast, and freshness signals are baked into the ranking."

#### Trade-off 6: Why Offset-Based Pagination vs Cursor-Based?

| Aspect | Offset-Based (Chosen) | Cursor-Based |
|--------|----------------------|--------------|
| Jump to page 5 | ✅ Simple ?page=5 | Impossible without iterating |
| URL shareability | ✅ page=3 works | Opaque cursor token |
| Implementation | ✅ Simple OFFSET/LIMIT | Keyset pagination |
| Consistency | Results can shift | ✅ Stable ordering |
| Deep pages | Performance degrades | ✅ Constant time |

"I'm choosing offset-based pagination because search users expect to jump to specific pages. 'Go to page 5' is a common action that cursor-based pagination doesn't support. The performance degradation at deep pages is acceptable because very few users go past page 3. If they do, the slight slowdown is tolerable."

---

### Deep Dive 4: Results Rendering and State

```
+------------------+                    +------------------+
|   API Response   |                    |   Zustand Store  |
|                  |                    |                  |
|  - results[]     | -----------------> |  - results       |
|  - totalResults  |                    |  - totalResults  |
|  - timing        |                    |  - isLoading     |
|  - correction    |                    |  - error         |
+------------------+                    |  - currentPage   |
                                        |  - history       |
                                        +------------------+
                                                 |
                         +-----------------------+----------------------+
                         |                       |                      |
                         v                       v                      v
               +----------------+      +----------------+      +----------------+
               |  Results List  |      |   Pagination   |      |  Search Box    |
               |  Component     |      |   Component    |      |  Component     |
               +----------------+      +----------------+      +----------------+
```

#### Trade-off 7: Why Zustand for Frontend State vs Redux?

| Aspect | Zustand (Chosen) | Redux |
|--------|-----------------|-------|
| Bundle size | ✅ ~1KB | ~7KB + middleware |
| Boilerplate | ✅ Minimal | Actions, reducers, types |
| Learning curve | ✅ 10 minutes | Hours |
| DevTools | Basic | ✅ Excellent time-travel |
| Middleware | Limited | ✅ Rich ecosystem |
| Async handling | ✅ Just use async/await | Redux-thunk/saga |

"I'm choosing Zustand because search state is straightforward: query, results, loading, error. We don't need Redux's time-travel debugging or complex middleware. Zustand's hooks-based API lets us write async actions naturally without thunks. For a feature this focused, Redux would be over-engineering."

---

### Deep Dive 5: Snippet Generation

```
Document Content (2000 words)
              |
              v
+---------------------------+
|   Split into sentences    |
+---------------------------+
              |
              v
+---------------------------+
|   Score each sentence     |
|   - Term frequency        |
|   - Consecutive terms     |
|   - Position in document  |
+---------------------------+
              |
              v
+---------------------------+
|   Select best passages    |
|   - Stay under 200 chars  |
|   - Prefer contiguous     |
+---------------------------+
              |
              v
+---------------------------+
|   Highlight query terms   |
|   - Wrap in <b> tags      |
|   - Escape HTML first     |
+---------------------------+
              |
              v
     "...Learn <b>JavaScript</b>
      basics in this <b>tutorial</b>..."
```

#### Trade-off 8: Why Server-Side Snippet Generation vs Client-Side?

| Aspect | Server-Side (Chosen) | Client-Side |
|--------|---------------------|-------------|
| Payload size | ✅ ~200 chars per result | Full document content |
| Highlighting consistency | ✅ Uniform algorithm | Browser-dependent |
| Processing cost | Server CPU | ✅ Distributed to clients |
| SEO/accessibility | ✅ Pre-rendered | Requires JS |
| Latency | Adds ~10ms | ✅ Zero server overhead |

"I'm choosing server-side snippet generation because it dramatically reduces payload size. Sending full documents to the client for 10 results would be megabytes. Pre-computing snippets keeps responses under 50KB. The 10ms server overhead is negligible compared to network savings, and we get consistent highlighting across all browsers."

---

## 📊 Data Flow (2 minutes)

### Complete Request Flow

```
   User Input                Browser                      Server
       |                        |                           |
       | Types "java"           |                           |
       +----------------------->|                           |
       |                        | [150ms debounce]          |
       |                        |                           |
       |                        | GET /autocomplete?q=java  |
       |                        +-------------------------->|
       |                        |                           | [Redis lookup]
       |                        |                           | [Trie search]
       |                        | ["javascript","java api"] |
       |                        |<--------------------------+
       | Show dropdown          |                           |
       |<-----------------------+                           |
       |                        |                           |
       | Press Enter            |                           |
       +----------------------->|                           |
       |                        | GET /search?q=javascript  |
       |                        +-------------------------->|
       |                        |                           | [Cache check]
       |                        |                           | [ES query]
       |                        |                           | [Rank]
       |                        |                           | [Snippets]
       |                        | {results, total, timing}  |
       |                        |<--------------------------+
       | Render results         |                           |
       |<-----------------------+                           |
       |                        |                           |
```

---

## ⚖️ Trade-offs Summary (2 minutes)

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Debounce timing | 150ms | 50ms or 300ms | Feels instant, reduces calls 85% |
| Autocomplete storage | Trie + Redis | Database | < 10ms latency requirement |
| API style | REST | GraphQL | HTTP caching, simpler for fixed responses |
| Type sharing | TypeScript imports | OpenAPI codegen | Both ends are TS, zero tooling overhead |
| Result cache TTL | 5 minutes | 1 min / 1 hour | 70% hit rate with acceptable freshness |
| Pagination | Offset-based | Cursor-based | Users expect "go to page 5" |
| State management | Zustand | Redux | Simple state, minimal boilerplate |
| Snippet generation | Server-side | Client-side | 100x smaller payload, consistent UX |

---

## 🚀 Future Enhancements (1 minute)

### Full-Stack Improvements
1. **Voice search**: Web Speech API with streaming transcription
2. **Infinite scroll**: Virtual list replacing pagination for smoother browsing
3. **Real-time results**: WebSocket for live trending topic updates
4. **Image search**: Grid layout with lazy loading and visual similarity
5. **Search operators UI**: Visual query builder for advanced syntax
6. **Personalization**: Re-rank using search history signals
7. **PWA support**: Offline history and cached result pages

---

## 📝 Summary (1 minute)

"The Google Search full-stack architecture connects three key layers:

**Frontend experience**: The search box uses 150ms debounced autocomplete for instant feedback. Zustand manages query state, results, and history with URL synchronization for shareability.

**API layer**: RESTful endpoints share TypeScript types with the frontend. The autocomplete endpoint uses a trie cached in Redis for sub-50ms responses. The search endpoint handles query parsing, two-phase ranking, and result caching.

**Integration points**: Results flow from Elasticsearch through the ranker, with snippets generated server-side for consistent highlighting and smaller payloads. The suggestion trie is populated from query logs, creating a feedback loop that improves autocomplete over time.

The main full-stack trade-off is cache staleness versus freshness. We accept 5-minute stale results to reduce index load by 70%, while breaking news queries can bypass cache when needed. The 150ms debounce and server-side snippets together reduce API load and payload size without perceptible user impact."

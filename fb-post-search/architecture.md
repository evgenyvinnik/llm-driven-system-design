# Facebook Post Search - Architecture Design

## System Overview

A privacy-aware search engine for social media posts with real-time indexing, personalized ranking, and sub-second latency. The core challenge is filtering search results based on who can see each post without sacrificing query performance -- solved via precomputed visibility fingerprints stored alongside documents in the search index.

**Learning goals:** Elasticsearch query construction with privacy filtering, visibility fingerprint design, two-phase ranking (retrieval + re-ranking), circuit breaker patterns for search availability, search suggestion systems.

## Requirements

### Functional Requirements

- **Full-text search** - Search posts by keywords, phrases, and hashtags
- **Filtering** - Filter by date range, post type, visibility, and author
- **Privacy-aware results** - Only show posts the searcher has permission to see
- **Personalized ranking** - Prioritize results from friends and engaged content
- **Real-time indexing** - New posts should be searchable immediately
- **Typeahead suggestions** - Autocomplete as users type

### Non-Functional Requirements

- **Scalability**: Designed for 2+ billion users, 500M+ posts per day
- **Availability**: 99.99% uptime target
- **Latency**: < 200ms p99 for search results
- **Consistency**: Eventual consistency for search; strong consistency for privacy

## Capacity Estimation

**Traffic:**
- 2 billion DAU
- Average 5 searches per user per day = 10 billion searches/day
- Peak QPS: ~350K searches/second

**Indexing:**
- 500 million new posts per day
- Average post size: ~1KB indexed
- Daily index growth: ~500GB/day

**Storage:**
- 5-year retention = 900TB+ of index data
- Sharding strategy required from day one

### Local Development Scale

| Metric | Target | Notes |
|--------|--------|-------|
| Users | 100 | Seeded test accounts |
| Posts | 10,000 | Seeded sample content |
| Searches/day | 500 | Manual + automated testing |
| Elasticsearch index | < 100MB | Single shard, no replicas |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CDN / Edge Cache                                 │
│                    (Static assets, suggestion responses)                       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│                         API Gateway / Load Balancer                            │
│                   (Rate limiting, auth, SSL termination)                       │
└──────┬─────────────────┬─────────────────┬──────────────────────────────────┘
       │                 │                 │
       ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│Search Service│  │ Post Service │  │ Auth Service  │
│- Query build │  │- CRUD        │  │- Sessions     │
│- Privacy     │  │- Index sync  │  │- RBAC         │
│  filtering   │  │              │  │               │
│- Ranking     │  │              │  │               │
│- Suggestions │  │              │  │               │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │    ┌────────────▼──────────┐      │
       │    │  Indexing Pipeline    │      │
       │    │  (Kafka consumers)   │      │
       │    │  - Extract hashtags  │      │
       │    │  - Compute           │      │
       │    │    fingerprints      │      │
       │    │  - Bulk index to ES  │      │
       │    └────────────┬─────────┘      │
       │                 │                 │
  ┌────▼─────────────────▼─────────────────▼────┐
  │            Data Layer                         │
  │                                               │
  │  ┌──────────────┐  ┌──────────────────────┐  │
  │  │ Elasticsearch│  │     PostgreSQL        │  │
  │  │ Cluster      │  │     (Sharded)         │  │
  │  │              │  │                       │  │
  │  │ - Posts index │  │ - Users              │  │
  │  │ - BM25 + rank│  │ - Posts (source of    │  │
  │  │ - Visibility │  │   truth)              │  │
  │  │   filtering  │  │ - Friendships         │  │
  │  │              │  │ - Search history      │  │
  │  └──────────────┘  └──────────────────────┘  │
  │                                               │
  │  ┌──────────────┐                             │
  │  │    Redis     │                             │
  │  │              │                             │
  │  │ - Visibility │                             │
  │  │   cache      │                             │
  │  │ - Sessions   │                             │
  │  │ - Trending   │                             │
  │  │   searches   │                             │
  │  │ - Suggestion │                             │
  │  │   cache      │                             │
  │  └──────────────┘                             │
  └───────────────────────────────────────────────┘
```

### Core Components

| Component | Responsibility | Production Technology |
|-----------|---------------|----------------------|
| **Search Service** | Query building, privacy filtering, ranking | Stateless microservice |
| **Post Service** | Post CRUD, triggers indexing pipeline | Stateless microservice |
| **Auth Service** | Session management, RBAC | Stateless microservice |
| **Indexing Pipeline** | Async post indexing with fingerprint computation | Kafka consumer workers |
| **Elasticsearch** | Full-text search, relevance scoring, filtering | ES Cluster (1000+ shards) |
| **PostgreSQL** | Source of truth for users, posts, friendships | Sharded cluster |
| **Redis** | Visibility cache, sessions, trending searches | Redis Cluster |

## Request Flows

### Search Flow (Privacy-Aware)

```
1. Client ──▶ POST /api/v1/search { query: "birthday party", filters: {...} }
                    │
                    ▼
2. Auth middleware validates session token (Redis lookup)
                    │
                    ▼
3. Build visibility set for user:
   a. Check Redis cache (visibility:{userId}, TTL 15min)
   b. On miss: Query friendships table for accepted friends
   c. Construct fingerprint set:
      ["PUBLIC", "PRIVATE:{userId}", "FRIENDS:{userId}",
       "FRIENDS:{friend1}", "FRIENDS:{friend2}", ...]
   d. Cache result in Redis
                    │
                    ▼
4. Build Elasticsearch query:
   - must: multi_match on content, author_name, hashtags (BM25)
   - filter: terms query on visibility_fingerprints (privacy)
   - filter: date_range, post_type (user filters)
   - should: boost posts from friends (terms on author_id, boost: 2.0)
   - should: boost own posts (term on author_id, boost: 3.0)
   - sort: _score DESC, engagement_score DESC, created_at DESC
                    │
                    ▼
5. Execute via circuit breaker (timeout 5s, retry 2x)
                    │
                    ▼
6. Transform results: extract highlights, compute snippets
                    │
                    ▼
7. Record search in history (async), update trending searches (async)
                    │
                    ▼
8. Return { results, next_cursor, total_estimate, took_ms }
```

### Post Indexing Flow

```
1. Client ──▶ POST /api/v1/posts { content, visibility, post_type }
                    │
                    ▼
2. Insert into PostgreSQL (source of truth)
                    │
                    ▼
3. Compute visibility fingerprints:
   - public ──▶ ["PUBLIC"]
   - friends ──▶ ["FRIENDS:{authorId}"]
   - private ──▶ ["PRIVATE:{authorId}"]
                    │
                    ▼
4. Extract hashtags (#word) and mentions (@word) from content
                    │
                    ▼
5. Calculate engagement score: likes + (comments × 2) + (shares × 3)
                    │
                    ▼
6. Index document to Elasticsearch with refresh=true
                    │
                    ▼
7. Post is immediately searchable
```

### Friendship Change Flow

```
1. User A accepts friend request from User B
                    │
                    ▼
2. Update friendships table (bidirectional rows)
                    │
                    ▼
3. Invalidate visibility cache for both users:
   - DEL visibility:{userA}
   - DEL visibility:{userB}
                    │
                    ▼
4. Next search recomputes fresh visibility set
   (no post re-indexing needed -- fingerprints are stable)
```

## Database Schema

### PostgreSQL Tables

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  visibility VARCHAR(20) DEFAULT 'friends'
    CHECK (visibility IN ('public', 'friends', 'friends_of_friends', 'private')),
  post_type VARCHAR(20) DEFAULT 'text'
    CHECK (post_type IN ('text', 'photo', 'video', 'link')),
  media_url VARCHAR(500),
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

CREATE TABLE search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query VARCHAR(500) NOT NULL,
  filters JSONB,
  results_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Key Indexes

```sql
CREATE INDEX idx_posts_author_id ON posts(author_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_visibility ON posts(visibility);
CREATE INDEX idx_friendships_user_id ON friendships(user_id);
CREATE INDEX idx_friendships_friend_id ON friendships(friend_id);
CREATE INDEX idx_friendships_status ON friendships(status);
CREATE INDEX idx_search_history_user_id ON search_history(user_id);
CREATE INDEX idx_search_history_created_at ON search_history(created_at DESC);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
```

### Triggers

`update_updated_at_column()` function automatically sets `updated_at = NOW()` on any row modification for users and posts tables.

### Elasticsearch Document Schema

```json
{
  "post_id": "uuid",
  "author_id": "user_uuid",
  "author_name": "Alice Johnson",
  "content": "Happy birthday party!",
  "hashtags": ["#birthday", "#party"],
  "mentions": ["@friend1"],
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z",
  "visibility": "friends",
  "visibility_fingerprints": ["FRIENDS:user123"],
  "post_type": "text",
  "engagement_score": 125.0,
  "like_count": 50,
  "comment_count": 25,
  "share_count": 0,
  "language": "en"
}
```

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `visibility:{userId}` | String (JSON) | 15 min | Cached visibility fingerprint set |
| `session:{token}` | String (JSON) | 24h | User session data |
| `trending:searches` | Sorted Set | Rolling | Trending search queries (score = frequency) |
| `suggestions:{prefix}` | String (JSON) | 1 min | Cached typeahead suggestions |

## API Design

### Core Endpoints

```
Search
POST   /api/v1/search                Search posts with filters
GET    /api/v1/search/suggestions     Typeahead suggestions
GET    /api/v1/search/trending        Trending search queries
GET    /api/v1/search/recent          User's recent searches
DELETE /api/v1/search/history         Clear search history

Posts
POST   /api/v1/posts                  Create post (triggers indexing)
GET    /api/v1/posts/:id              Get single post
PUT    /api/v1/posts/:id              Update post (re-indexes)
DELETE /api/v1/posts/:id              Delete post (removes from index)

Auth
POST   /api/v1/auth/register          Create account
POST   /api/v1/auth/login             Login, returns session token
POST   /api/v1/auth/logout            Invalidate session
GET    /api/v1/auth/me                Get current user

Admin
GET    /api/v1/admin/stats            System statistics
GET    /api/v1/admin/users            List all users
GET    /api/v1/admin/posts            List all posts
GET    /api/v1/admin/search-history   View search history
POST   /api/v1/admin/reindex          Trigger full reindex
```

### Search Request/Response

```
POST /api/v1/search
{
  "query": "birthday party",
  "filters": {
    "date_range": {"start": "2024-01-01", "end": "2024-12-31"},
    "post_type": ["text", "photo"],
    "visibility": ["public", "friends"]
  },
  "pagination": {"cursor": null, "limit": 20}
}

Response:
{
  "results": [...],
  "next_cursor": "20",
  "total_estimate": 1500,
  "took_ms": 45
}
```

## Key Design Decisions

### Privacy-Aware Search with Visibility Fingerprints

This is the most critical design decision. The naive approach -- searching for all matching posts, then filtering by permission -- is O(n) in the number of results and would time out at scale (10M results x permission check = seconds).

**Chosen: Precomputed visibility fingerprints.** Each post stores an array of fingerprint strings in its Elasticsearch document. At query time, we compute the user's visibility set (the set of fingerprints they can access) and use an Elasticsearch `terms` filter to include only matching documents. Elasticsearch handles this as an inverted index lookup -- O(1) per document, evaluated during query execution, not post-hoc.

The trade-off: when friendships change, visibility sets must be recomputed. But fingerprints are stable -- `FRIENDS:user123` means "visible to friends of user123" and doesn't change when user123 gains or loses friends. Only the user's visibility set (cached in Redis for 15 minutes) needs invalidation. No post re-indexing is required for friendship changes. This is a decisive advantage over alternatives that embed friend lists directly in documents.

### Two-Phase Ranking

**Phase 1 (Elasticsearch retrieval):** BM25 text relevance with fuzziness, engagement score boost, recency decay. This phase retrieves the top-N candidates efficiently using Elasticsearch's inverted index.

**Phase 2 (Application-layer re-ranking):** Friend relationship boosting (2x for friends' posts, 3x for own posts). This requires social graph data not available in the search index. The two-phase approach avoids denormalizing the entire social graph into Elasticsearch while still delivering personalized results.

The alternative -- embedding friend IDs in Elasticsearch function_score queries -- would require updating documents whenever friendships change, creating write amplification proportional to post count.

### Synchronous vs Asynchronous Indexing

**Chosen for learning: Synchronous indexing** with `refresh=true`. Posts are immediately searchable after creation. This is simple and provides a better developer experience for testing.

**Production alternative: Kafka-based async indexing.** Posts are published to a Kafka topic, consumed by indexer workers, and bulk-indexed to Elasticsearch. This decouples write throughput from index throughput, enables replay on index corruption, and allows the indexing pipeline to include enrichment (language detection, toxicity scoring). The trade-off is indexing lag (typically < 5 seconds), which is acceptable for a social search product.

## Consistency and Idempotency

### Search Consistency Model

| Data | Consistency | Rationale |
|------|-------------|-----------|
| Post visibility | Eventually consistent (< 15 min) | Visibility cache TTL; friendship changes invalidate cache |
| Search index | Eventually consistent (< 5s production, immediate local) | Async indexing pipeline in production |
| Search history | Strong (PostgreSQL) | Direct insert, no caching |
| Trending searches | Eventually consistent | Redis sorted set, approximate counts |

### Privacy Consistency

Privacy filtering must never show a post to an unauthorized user, even at the cost of temporarily hiding authorized content. The visibility cache TTL (15 minutes) means a newly accepted friend may not see your posts in search for up to 15 minutes. This is acceptable because: (1) the friendship itself is confirmed immediately, (2) the friend's feed shows posts regardless, (3) 15-minute search delay is not user-visible.

## Security

### Authentication

- **Session-based auth**: Token stored in Redis with 24-hour expiry, PostgreSQL as backup
- **Password hashing**: bcrypt with salt
- **Token format**: UUID v4, passed via `Authorization: Bearer {token}` header

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| **user** | Search, create/edit/delete own posts, manage friendships |
| **admin** | All user permissions + view all users/posts, system stats, trigger reindex |

### Input Validation

- Zod schemas for all request validation
- SQL injection prevention via parameterized queries
- IP-based rate limiting (1000 requests per 15 minutes per IP)
- Content length limits on search queries and post content

## Observability

### Metrics (Prometheus Format)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `search_queries_total` | Counter | status, has_user | Search volume and error rate |
| `search_latency_seconds` | Histogram | status | SLA monitoring (p50, p95, p99) |
| `search_results_total` | Counter | has_results | Zero-result query tracking |
| `cache_hits_total` | Counter | cache_type | Cache effectiveness |
| `cache_misses_total` | Counter | cache_type | Cache effectiveness |
| `indexing_lag_seconds` | Histogram | - | Post creation to searchable lag |
| `posts_indexed_total` | Counter | operation | Index write volume (create/update/delete) |
| `circuit_breaker_state` | Gauge | service | ES circuit breaker state |
| `http_requests_total` | Counter | method, path, status_code | API traffic |
| `http_request_duration_seconds` | Histogram | method, path | Endpoint latency |
| `db_query_latency_seconds` | Histogram | operation | Database performance |
| `elasticsearch_docs_count` | Gauge | - | Index document count |
| `elasticsearch_index_size_bytes` | Gauge | - | Index storage size |

### Health Check Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Comprehensive check (PostgreSQL, Elasticsearch, Redis) |
| `GET /livez` | Kubernetes liveness probe |
| `GET /readyz` | Kubernetes readiness probe (all dependencies) |
| `GET /metrics` | Prometheus metrics (text format) |

### Alerting Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Search latency p95 | > 300ms | > 500ms | Check ES cluster, add caching |
| Elasticsearch heap | > 70% | > 85% | Increase JVM heap or add nodes |
| PostgreSQL connections | > 80 | > 95 | Check connection leaks |
| Cache hit rate | < 80% | < 60% | Review TTLs, increase cache size |
| Error rate | > 0.5% | > 2% | Check logs, rollback if needed |
| Indexing lag p99 | > 5s | > 30s | Scale indexer workers |

### Logging

Structured JSON logs via Pino with domain-specific log functions: `logSearch()` (query, userId, filters, resultsCount, durationMs), `logIndexing()` (postId, operation, durationMs, lagMs), `logCircuitBreakerStateChange()` (service, state). Log levels configurable via `LOG_LEVEL` environment variable.

## Failure Handling

### Circuit Breaker for Elasticsearch

The circuit breaker (cockatiel library) protects against cascading failures when Elasticsearch is unavailable. Without it, application threads block on ES timeouts (5-30 seconds), exhausting the connection pool and causing the entire API to hang.

**Configuration:** Opens after 5 consecutive failures, half-opens after 30 seconds. Timeout of 5 seconds per request. Retry up to 2 times with exponential backoff (100ms to 2s).

**Graceful degradation when circuit is open:**
- Search returns "service temporarily unavailable" error
- Suggestions fall back to trending searches (Redis-only, no ES call)
- Health check shows degraded status
- Post creation still works (PostgreSQL insert succeeds, indexing queued for retry)

### Data Lifecycle Policies

| Data Type | Retention | Rationale |
|-----------|-----------|-----------|
| Posts (PostgreSQL) | Forever | Source of truth, soft delete only |
| Posts (Elasticsearch) | 2 years hot, 5 years warm | Older posts rarely searched |
| Search history | 90 days | Privacy and storage efficiency |
| Visibility cache (Redis) | 15 minutes | Invalidated on friendship changes |
| Session data (Redis) | 24 hours | Short-lived auth sessions |
| Trending searches (Redis) | Rolling 24 hours | Recency-weighted rankings |

## Scalability Considerations

### Horizontal Scaling Path

1. **Search Services**: Stateless, add instances behind load balancer.
2. **Elasticsearch**: Add shards and replicas as data grows. Target: < 50GB per primary shard.
3. **PostgreSQL**: Read replicas for friendship queries. Shard by user_id when write throughput demands it.
4. **Redis**: Cluster mode for visibility cache distribution.
5. **Indexing Pipeline**: Scale Kafka consumer workers independently based on consumer lag.

### Data Partitioning

- **Elasticsearch**: Hash by post_id across 1000+ shards. Hot/cold tiers with ILM (hot < 60 days on SSDs, warm 60-730 days on HDDs, cold > 730 days frozen).
- **PostgreSQL**: Partition posts by created_at for efficient time-range queries. Shard friendships by user_id.
- **Geographic**: Regional ES clusters with cross-cluster search for global queries.

### Search Quality at Scale

- **Bloom filters**: Compact visibility set representation for users with thousands of friends (reduces terms filter size).
- **ML re-ranking**: Gradient boosted trees trained on click-through rate for Phase 2 ranking.
- **Query caching**: Cache results for popular queries (10-second TTL) to handle search spikes.
- **Federated search**: Merge results from multiple regional clusters with latency-weighted scoring.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Privacy filtering | Visibility fingerprints | Per-query permission checks | O(1) filter vs O(n) post-hoc check |
| Ranking | Two-phase (ES + app) | Full ES function_score | Avoids denormalizing social graph into ES |
| Indexing | Synchronous (local) / Kafka (production) | Direct ES writes only | Decouples write path, enables replay |
| Search engine | Elasticsearch | Solr, Meilisearch | Better real-time indexing, operational maturity |
| Primary database | PostgreSQL | MongoDB | Relational data (friendships), ACID guarantees |
| Cache | Redis | Memcached | Data structures (sorted sets for trending), TTL |
| Session storage | Redis + PostgreSQL | JWT | Immediate revocation, simpler token management |
| Input validation | Zod schemas | Manual validation | Type-safe, composable, auto-documentation |
| Circuit breaker | Cockatiel | Opossum | Composable policies (retry + timeout + breaker) |

## Frontend Architecture

### Routing (TanStack Router, File-Based)

```
frontend/src/routes/
├── __root.tsx      → Root layout (Header + auth check on mount)
├── index.tsx       → / (search page with SearchBar, SearchFilters, SearchResults)
├── login.tsx       → /login (username + password form)
├── register.tsx    → /register (registration form)
└── admin.tsx       → /admin (admin dashboard with tabs, role-gated)
```

The root component checks authentication on mount via `checkAuth()` and renders a loading spinner until the session is validated. The `Header` component is always visible and includes navigation links and a logout button. No route guards are implemented at the router level -- the admin page checks `user.role === 'admin'` and redirects to login if unauthorized.

### Component Hierarchy

```
RootComponent (__root.tsx)
├── Header                     (nav bar with logo, links, user menu)
└── Outlet
    ├── IndexPage (/)
    │   ├── SearchBar           (input with typeahead suggestions dropdown)
    │   ├── SearchFilters       (date range, post type, visibility dropdowns)
    │   └── SearchResults       (result list with pagination)
    │       └── SearchResultCard (single result with highlights, hashtags, metadata)
    │
    ├── LoginPage (/login)
    ├── RegisterPage (/register)
    │
    └── AdminPage (/admin)
        ├── HealthStatusBar     (PostgreSQL/ES/Redis status + reindex button)
        ├── AdminTabs           (overview, users, posts, searches tab navigation)
        ├── OverviewTab         (stat cards: users, posts, index size)
        │   └── StatCard        (single metric with label and value)
        ├── UsersTable          (paginated user list)
        ├── PostsTable          (paginated post list)
        └── SearchHistoryTable  (search query log with user and timestamp)
```

### Zustand Stores

**`authStore`** -- Manages authentication state:

| State | Purpose |
|-------|---------|
| `user` | Currently authenticated user object (or null) |
| `isLoading` | True during auth checks (blocks UI rendering) |
| `isAuthenticated` | Derived from user presence |
| `error` | Last authentication error message |

Actions: `login()`, `register()`, `logout()`, `checkAuth()`, `clearError()`. The auth token is persisted to `localStorage` by the API client and sent as a `Bearer` token in the `Authorization` header on all requests.

**`searchStore`** -- Manages search state and interactions:

| State | Purpose |
|-------|---------|
| `query` | Current search query text |
| `filters` | Active filter criteria (date range, post type, visibility) |
| `results` | Array of search result objects |
| `suggestions` | Typeahead suggestions from Elasticsearch |
| `trending` | Popular search queries from Redis sorted set |
| `recentSearches` | User's personal search history |
| `totalResults` | Estimated total match count |
| `nextCursor` | Pagination cursor for "load more" |
| `searchTime` | Server-reported query duration in ms |

Actions: `search()`, `loadMore()`, `fetchSuggestions()`, `fetchTrending()`, `fetchRecentSearches()`, `clearResults()`, `clearSuggestions()`. Search and loadMore call the API client and merge results. Suggestions are fetched on every keystroke (debounced by the component, not the store).

### Data Fetching

**API Client (`services/api.ts`):** A singleton `ApiClient` class encapsulates all HTTP communication. It manages the auth token lifecycle (set on login/register, stored in localStorage, cleared on logout) and automatically injects the `Authorization` header into every request. All methods return typed promises. The class groups endpoints into categories: auth (login, register, logout, getCurrentUser), search (search, getSuggestions, getTrending, getRecentSearches), posts (createPost, getFeed, likePost, deletePost), and admin (getAdminStats, getAdminUsers, getAdminPosts, getAdminSearchHistory, reindexPosts, getAdminHealth).

**Search flow:** When the user types in `SearchBar`, each keystroke triggers `fetchSuggestions()` via the search store, which calls `api.getSuggestions()`. On Enter or suggestion click, `search()` calls `api.search()` with the query, filters, and pagination cursor. Results are stored in the search store and rendered by `SearchResults`. The "load more" button calls `loadMore()`, which appends new results to the existing array.

**Admin lazy loading:** The admin page loads stats and health on mount via `Promise.all`. Tab-specific data (users, posts, search history) is loaded lazily on first tab selection and cached in local state.

### Key UI Patterns

- **Typeahead suggestions:** `SearchBar` renders a dropdown that shows three types of content depending on context. When the user has typed 2+ characters, it shows API-sourced suggestions (hashtags, users, queries). When the input is empty or has fewer than 2 characters, it shows recent searches (personal history) and trending searches (platform-wide). Each suggestion type gets a distinct icon (Hash, User, Search, Clock, TrendingUp from lucide-react). Click-outside detection closes the dropdown.

- **Cursor-based pagination:** Search results use cursor-based pagination rather than page numbers. The server returns a `next_cursor` value with each response. The `loadMore` action passes this cursor to the next API call, appending results to the existing array. This approach handles new posts being indexed between page loads without causing duplicate or missing results.

- **Admin role gating:** The admin page checks `user.role === 'admin'` on mount and redirects to login if the check fails. This is a UI-level guard only; the backend enforces authorization independently via RBAC middleware.

- **Health status visualization:** The `HealthStatusBar` component shows colored indicators for PostgreSQL, Elasticsearch, and Redis connectivity. The reindex button triggers a full re-indexing of all posts to Elasticsearch and displays the count of indexed documents on completion.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation describes what the pattern is, why it exists, and how it works -- assuming no prior knowledge.

### RBAC (Role-Based Access Control)

**What it is:** RBAC is an authorization model where permissions are assigned to roles rather than to individual users. Each user is assigned a role, and the role determines what actions they can perform. This simplifies permission management: instead of configuring permissions for each of millions of users, you define permissions for a small number of roles and assign users to roles.

**Why it matters:** A search system needs different access levels. Regular users can search and create posts. Admins need to view all users, inspect search history for abuse detection, trigger reindexing when the search index drifts, and view system health. Without RBAC, permission checks become scattered conditional statements that are error-prone and difficult to audit.

**How it works here:** Two roles are defined: `user` (search, create/edit/delete own posts, manage friendships) and `admin` (all user permissions plus view all users/posts, system stats, trigger reindex, view search history). The role is stored in the `users.role` column with a CHECK constraint. The backend checks the role in route-level middleware before executing admin operations. The frontend additionally checks `user.role` to show or hide the admin navigation link.

### Redis Cache-Aside

**What it is:** Cache-aside (also called "lazy loading") is a caching strategy where the application checks a cache before querying the primary data store. On a cache miss, the application queries the database, stores the result in the cache, and returns it. On a cache hit, the database is skipped entirely.

**Why it matters:** The most expensive operation in this system is computing a user's visibility set -- the list of all fingerprints they are authorized to see. This requires querying the friendships table for all accepted friends, then constructing strings like `"FRIENDS:{friendId}"` for each friend. For a user with 500 friends, this means a database query returning 500 rows, followed by string construction. At 350K searches per second, recomputing this for every search would overwhelm the friendships table. Caching the result in Redis for 15 minutes reduces database load by 99%+ for active users.

**How it works here:** When a user searches, the visibility service checks Redis for key `visibility:{userId}`. If present (cache hit), the cached JSON array of fingerprints is used directly. If absent (cache miss), the service queries the friendships table, constructs the fingerprint set, stores it in Redis with a 15-minute TTL, and returns it. When a friendship changes (accepted or removed), both users' visibility cache keys are explicitly deleted (`DEL visibility:{userA}`, `DEL visibility:{userB}`), forcing recomputation on the next search.

**File:** `backend/src/services/visibilityService.ts`

### Circuit Breaker

**What it is:** A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing dependency. It works like an electrical circuit breaker: when failures exceed a threshold, the circuit "opens" and all subsequent calls fail immediately without attempting the actual operation. After a cooldown period, the circuit enters a "half-open" state where it allows one probe request through. If the probe succeeds, the circuit closes and normal operation resumes.

**Why it matters:** Elasticsearch is the most critical dependency for search. If Elasticsearch becomes slow or unresponsive (JVM garbage collection pause, cluster rebalancing, network partition), every search request would block for the full timeout (5 seconds). With thousands of concurrent searches, this blocks all Express request handlers, and the entire API becomes unresponsive -- including health checks, auth endpoints, and post creation that do not require Elasticsearch. The circuit breaker prevents this cascade by failing search requests instantly when Elasticsearch is known to be unhealthy.

**How it works here:** The Cockatiel library wraps all Elasticsearch calls with a composed policy: timeout (5 seconds per request), retry (2 attempts with exponential backoff from 100ms to 2s), and consecutive breaker (opens after 5 consecutive failures, half-opens after 30 seconds). When the circuit is open: search returns a "service temporarily unavailable" error, suggestions fall back to trending searches from Redis (no Elasticsearch needed), health check shows degraded status, and post creation still succeeds (PostgreSQL insert works, Elasticsearch indexing is queued for retry).

**File:** `backend/src/shared/circuitBreaker.ts`

### Structured Logging

**What it is:** Structured logging writes log entries as machine-parseable JSON objects rather than free-form text strings. Each log entry includes standardized fields (timestamp, level, message) plus context-specific metadata (user ID, query text, result count, duration).

**Why it matters:** When debugging why search is slow for a specific user, you need to find their search logs, see what query they ran, how many results were returned, how long it took, and whether the circuit breaker was involved. With free-form text logs, this requires fragile regex parsing. With structured JSON logs, it is a simple query: `level=info AND event=search AND userId=abc123 | sort by durationMs DESC`.

**How it works here:** Pino is configured with domain-specific log functions. `logSearch()` records query, userId, filters, resultsCount, and durationMs. `logIndexing()` records postId, operation (create/update/delete), durationMs, and lagMs (time from post creation to searchable). `logCircuitBreakerStateChange()` records the service name and new state (closed/open/half-open). In development, pino-pretty formats JSON as colored human-readable output. The `LOG_LEVEL` environment variable controls verbosity.

**File:** `backend/src/shared/logger.ts`

### Prometheus Metrics

**What it is:** Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose metrics on an HTTP endpoint in a specific text format. Prometheus scrapes this endpoint periodically and stores time-series data for visualization and alerting.

**Why it matters:** Metrics answer operational questions that logs cannot efficiently answer: "What is the p95 search latency right now?" "What is the cache hit rate for visibility lookups?" "How many posts were indexed in the last hour?" "Is the Elasticsearch circuit breaker flapping?" Without metrics, operators must manually aggregate log entries -- a process that takes minutes instead of the seconds a dashboard provides.

**How it works here:** The `prom-client` library exposes 15+ custom metrics. Key examples: `search_latency_seconds` (Histogram) records search query duration for SLA monitoring. `cache_hits_total` and `cache_misses_total` (Counters) track visibility cache effectiveness. `circuit_breaker_state` (Gauge) reports the Elasticsearch circuit breaker state. `indexing_lag_seconds` (Histogram) measures the time from post creation to searchability. `elasticsearch_docs_count` and `elasticsearch_index_size_bytes` (Gauges) track index growth. Default Node.js metrics (CPU, memory, event loop lag, GC) are collected automatically via `collectDefaultMetrics()`.

**File:** `backend/src/shared/metrics.ts`

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make within a time window. It protects the system from abuse (automated scraping, brute-force attacks) and ensures fair resource allocation across users.

**Why it matters:** Search is computationally expensive -- each query hits Elasticsearch with multi-field matching, visibility filtering, and relevance scoring. A bot scraping all public posts could issue thousands of searches per second, consuming Elasticsearch CPU that should serve real users. Rate limiting caps the damage any single source can cause.

**How it works here:** IP-based rate limiting is implemented via `express-rate-limit` middleware. The global limit is 1000 requests per 15 minutes per IP address. This is a simple sliding window counter. When the limit is exceeded, the server returns HTTP 429 (Too Many Requests) with a `Retry-After` header. The limit applies to all API endpoints uniformly. In production, per-user rate limiting (separate from IP-based) and tiered limits (lower for search, higher for reads) would be added.

**File:** `backend/src/index.ts`

### Idempotency

**What it is:** Idempotency means that performing the same operation multiple times produces the same result as performing it once. In a search system, idempotency is primarily relevant for write operations (post creation, friendship changes) where network retries could cause duplicates.

**Why it matters:** If a user creates a post, the server inserts it into PostgreSQL and indexes it in Elasticsearch. If the response is lost and the client retries, the post could be created twice. This creates duplicate search results and corrupts engagement metrics.

**How it works here:** Post creation uses PostgreSQL's UUID primary key as a natural idempotency mechanism -- duplicate UUIDs cause a constraint violation rather than a duplicate insert. For indexing, each post is indexed by its UUID as the Elasticsearch document ID. Re-indexing the same post with the same ID overwrites the existing document rather than creating a duplicate. The admin reindex operation is fully idempotent: it deletes and recreates the index, then bulk-indexes all posts from PostgreSQL. Running it multiple times always produces the same result.

### Health Checks

**What it is:** Health checks are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers, container orchestrators, and monitoring systems to detect and route around failures.

**Why it matters:** This system depends on three external services: PostgreSQL (source of truth), Elasticsearch (search index), and Redis (cache and sessions). If any one fails, different parts of the application degrade differently. Health checks enable automated systems to detect exactly what is failing and respond appropriately.

**How it works here:** Three endpoints serve different consumers. `/health` performs a comprehensive check of all three dependencies (PostgreSQL query, Elasticsearch ping, Redis ping) and returns a JSON object with the status of each. `/livez` confirms the process is alive (Kubernetes liveness probe). `/readyz` checks that all dependencies are reachable (Kubernetes readiness probe -- if Elasticsearch is down, the instance is removed from the load balancer but not restarted, allowing it to serve cached results or non-search endpoints). The admin dashboard's `HealthStatusBar` component polls the health endpoint to display colored indicators for each service.

**File:** `backend/src/shared/healthCheck.ts`

## Implementation Notes

This section maps the production architecture to the actual local implementation.

### Local Architecture

```
┌─────────────────┐
│  React Frontend │
│  Vite :5173     │
│                 │
│  Search Bar     │
│  + Typeahead    │
│  Search Filters │
│  Result Cards   │
│  Admin Dashboard│
└────────┬────────┘
         │ HTTP
         ▼
┌─────────────────┐
│  Express API    │
│  :3000          │
│                 │
│  Search Service │
│  Post Service   │
│  Visibility Svc │
│  Indexing Svc   │
│  Auth Service   │
│  Admin Ctrl     │
└──┬──────┬───┬───┘
   │      │   │
   ▼      ▼   ▼
┌─────┐┌─────┐┌──────────────┐
│ PG  ││Redis││Elasticsearch │
│:5432││:6379││    :9200     │
│fb_  ││     ││              │
│post_││     ││  posts index │
│srch ││     ││  (1 shard,   │
│     ││     ││   0 replicas)│
└─────┘└─────┘└──────────────┘
```

### Production Patterns Actually Implemented

| Pattern | File | What It Does |
|---------|------|-------------|
| **Visibility fingerprints** | `backend/src/services/visibilityService.ts` | Computes user visibility set from friendships, caches in Redis for 15 min |
| **Privacy-aware search** | `backend/src/services/searchService.ts` | Builds ES bool query with visibility_fingerprints terms filter |
| **Friend-boosted ranking** | `backend/src/services/searchService.ts` | Adds should clauses for friend posts (2x) and own posts (3x) |
| **Real-time indexing** | `backend/src/services/indexingService.ts` | Synchronous ES indexing with fingerprint computation, hashtag/mention extraction |
| **Bulk indexing** | `backend/src/services/indexingService.ts` | Batch index for seeding and reindex operations |
| **Circuit breaker** (Cockatiel) | `backend/src/shared/circuitBreaker.ts` | Wraps all ES calls with timeout (5s) + retry (2x) + consecutive breaker (5 failures) |
| **Prometheus metrics** (prom-client) | `backend/src/shared/metrics.ts` | 15+ custom metrics: search, cache, indexing, circuit breaker, HTTP, DB |
| **Structured logging** (Pino) | `backend/src/shared/logger.ts` | Domain-specific log functions (logSearch, logIndexing, logCircuitBreakerStateChange) |
| **Health checks** | `backend/src/shared/healthCheck.ts` | /health (comprehensive), /livez, /readyz with PostgreSQL + ES + Redis checks |
| **Alert thresholds** | `backend/src/shared/alertThresholds.ts` | Configurable thresholds for circuit breaker, retention, cache TTLs |
| **Data retention** | `backend/src/shared/retention.ts` | Retention constants for search history (90 days), sessions, visibility cache |
| **Search history cleanup** | `backend/src/scripts/cleanup-search-history.ts` | Removes search_history entries older than retention period |
| **Database migrations** | `backend/src/shared/migrations.ts` | Migration runner with rollback support |
| **Rate limiting** (express-rate-limit) | `backend/src/index.ts` | IP-based rate limiting (1000 req/15min) |
| **Input validation** (Zod) | Controllers | Schema-based request validation |
| **Typeahead suggestions** | `backend/src/services/searchService.ts` | Hashtag aggregations (ES), trending searches (Redis), user name matching (PG) |
| **ES index management** | `backend/src/config/elasticsearch.ts` | Index creation with mapping, analyzers, field types |
| **Admin dashboard** | `frontend/src/routes/admin.tsx` + `frontend/src/components/admin/` | System stats, user/post management, health status, search history, reindex trigger |

### What Was Simplified or Substituted

| Production Design | Local Implementation | Why |
|-------------------|---------------------|-----|
| API Gateway (Kong/Envoy) | Direct Express routing | Single service |
| Kafka indexing pipeline | Synchronous indexing with refresh=true | No async infra needed |
| ES Cluster (1000+ shards) | Single-node ES (1 shard, 0 replicas) | Dev scale |
| PostgreSQL sharding | Single PostgreSQL instance | 100 users |
| Redis Cluster | Single Valkey instance | All cache fits in memory |
| OAuth/JWT auth | Session-based with bcrypt | Simpler |
| ML re-ranking | Friend boost + engagement score | No training data |
| CDN for static assets | Vite dev server | Local only |
| ILM hot/warm/cold tiers | Single index, no lifecycle | Dev scale |
| Bloom filters for visibility | Full fingerprint arrays | Small friend lists |

### What Was Omitted

- CDN / edge caching
- Kafka for async indexing pipeline and event replay
- Elasticsearch ILM (Index Lifecycle Management) for hot/warm/cold tiers
- ML-based re-ranking (gradient boosted trees)
- Bloom filter visibility optimization
- Multi-region deployment with cross-cluster search
- Kubernetes orchestration
- MinIO/S3 for cold storage archival
- Query result caching for popular searches
- Language detection for multilingual search
- Content moderation integration
- A/B testing hooks for ranking algorithm experiments
- Load balancer (nginx/HAProxy) -- though multi-instance is supported via `npm run dev:server1/2/3`

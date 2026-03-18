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

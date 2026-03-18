# Facebook News Feed - Architecture Design

## System Overview

A personalized content feed system for social media that delivers relevant posts to users based on social connections, engagement patterns, and content freshness. The system implements a hybrid fan-out architecture balancing write efficiency for celebrities with read latency for regular users.

**Learning goals:** Feed ranking algorithms, hybrid push/pull distribution, affinity-based personalization, cache-aside patterns for read-heavy workloads.

## Requirements

### Functional Requirements

- **Post creation**: Users can create text/image posts with privacy controls (public, friends-only)
- **Feed generation**: Personalized feed ranked by engagement, recency, and user affinity
- **Social graph**: Follow/unfollow relationships with bidirectional friend detection
- **Engagement**: Likes, comments, and shares with real-time count updates
- **Real-time updates**: WebSocket-based live feed updates for new posts and engagement
- **User profiles**: Profile pages with post history and follower/following lists

### Non-Functional Requirements

- **Scalability**: Support 500M+ DAU with horizontal scaling across data centers
- **Availability**: 99.99% uptime target (< 52 minutes downtime/year)
- **Latency**: Feed load < 200ms p95, post creation < 100ms p95
- **Consistency**: Eventual consistency for feed (5-10 second propagation), strong consistency for likes/comments counts
- **Throughput**: 10M+ feed requests/second at peak, 500K+ post creations/second

## Capacity Estimation

**Production Scale:**
- 2 billion registered users, 500M DAU
- Average user refreshes feed 20x/day = 10 billion feed reads/day
- Peak QPS: ~300K feed reads/second
- 100M posts created/day = ~1,200 posts/second average, 5K/second peak
- Average post has 50 followers receiving it via fan-out

**Storage:**
- Posts: 100M/day x 2KB = 200GB/day = 73TB/year
- Feed items: 5B fan-out writes/day x 100B = 500GB/day (pruned to rolling 7 days)
- Affinity scores: 500M users x 500 connections x 50B = 12.5TB

### Local Development Scale

| Metric | Target Value | Notes |
|--------|--------------|-------|
| Daily Active Users (DAU) | 100 | Simulated via test accounts |
| Peak Concurrent Users | 20 | Local testing capacity |
| Posts per day | 500 | ~5 posts per active user |
| Feed requests per second | 10 RPS | Peak during testing |
| Post creation RPS | 2 RPS | Burst during testing |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                     CDN / Edge Cache                                  │
│                        (Static assets, cached feed responses)                         │
└──────────────────────────────────┬───────────────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼───────────────────────────────────────────────────┐
│                              API Gateway / Load Balancer                               │
│                    (Rate limiting, auth, routing, SSL termination)                     │
└──────────┬───────────────────┬───────────────────┬──────────────────────────────────┘
           │                   │                   │
           ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Feed Service    │ │  Post Service    │ │  Social Service  │
│  (Read path)     │ │  (Write path)    │ │  (Graph queries) │
│  - Aggregation   │ │  - Creation      │ │  - Follow/unfollow│
│  - Ranking       │ │  - Fan-out       │ │  - Affinity      │
│  - Caching       │ │  - Moderation    │ │  - Profile       │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                     │
         │         ┌──────────▼──────────┐          │
         │         │  Fan-out Workers    │          │
         │         │  (Async, via queue) │          │
         │         └──────────┬──────────┘          │
         │                    │                     │
    ┌────▼────────────────────▼─────────────────────▼────┐
    │                  Message Queue (Kafka)               │
    │         (Fan-out events, engagement events)          │
    └────┬────────────────────┬─────────────────────┬────┘
         │                    │                     │
         ▼                    ▼                     ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  PostgreSQL      │ │  Redis Cluster   │ │  WebSocket       │
│  (Sharded)       │ │  - Feed cache    │ │  Gateway         │
│  - Users         │ │  - Sessions      │ │  - Real-time     │
│  - Posts         │ │  - Celebrity     │ │    notifications │
│  - Friendships   │ │    posts         │ │  - Redis Pub/Sub │
│  - Feed items    │ │  - Affinity      │ │    for cross-    │
│  - Engagement    │ │    cache         │ │    instance sync │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

### Core Components

| Component | Responsibility | Production Technology |
|-----------|---------------|----------------------|
| **API Gateway** | Rate limiting, auth, request routing | Kong / Envoy |
| **Feed Service** | Aggregates push/pull feeds, applies ranking | Stateless microservice |
| **Post Service** | Post CRUD, triggers fan-out | Stateless microservice |
| **Social Service** | Social graph operations, affinity scoring | Stateless microservice |
| **Fan-out Workers** | Async post distribution to follower feeds | Kafka consumer workers |
| **PostgreSQL** | Primary data store (sharded by user_id) | PostgreSQL 16 cluster |
| **Redis Cluster** | Feed cache, sessions, celebrity posts, pub/sub | Redis 7 Cluster |
| **WebSocket Gateway** | Real-time feed updates | Dedicated WS service |

## Request Flows

### Post Creation Flow

```
1. Client ──▶ POST /api/v1/posts (content, imageUrl, privacy)
2. API Gateway validates session token (Redis lookup)
3. Post Service inserts post into PostgreSQL (posts table)
4. Post Service publishes fan-out event to Kafka
5. Fan-out workers consume event and determine author type:
   ┌─ Celebrity (≥10K followers):
   │   Store in Redis sorted set (celebrity_posts:{authorId})
   │   No write amplification
   └─ Regular user:
       a. Query all followers from friendships table
       b. Batch insert into feed_items table (PostgreSQL)
       c. Pipeline ZADD to feed:{followerId} keys (Redis)
6. WebSocket Gateway publishes to Redis pub/sub for real-time updates
7. Return 201 with created post
```

### Feed Read Flow

```
1. Client ──▶ GET /api/v1/feed?cursor=timestamp&limit=20
2. API Gateway validates session, gets userId from Redis
3. Feed Service aggregates:
   a. Fetch cached feed from Redis (ZREVRANGEBYSCORE feed:{userId})
   b. If cache miss: Query feed_items from PostgreSQL
   c. Identify followed celebrities from friendships table
   d. Fetch celebrity posts from Redis (celebrity_posts:{celebrityId})
   e. Merge and deduplicate post IDs
4. Batch fetch post data from PostgreSQL
5. For each post, calculate ranking score:
   score = engagement × recencyDecay × affinityBoost
   - engagement = likes + (comments × 3) + (shares × 5)
   - recencyDecay = 1 / (1 + ageInHours × 0.08)  [12-hour half-life]
   - affinityBoost = 1 + min(affinityScore, 100) / 100
6. Sort by score descending, apply cursor pagination
7. Return posts with next cursor
```

### Follow User Flow

```
1. Client ──▶ POST /api/v1/users/:username/follow
2. Validate session
3. Insert into friendships table (follower_id, following_id)
4. Atomically update follower_count / following_count
5. Backfill: Fetch recent posts from new followee
   a. Insert into feed_items for current user
   b. Update Redis feed cache
6. Return 200 OK
```

## Database Schema

```sql
-- Core entities
users (
  id UUID PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  bio TEXT,
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',        -- 'user' | 'admin'
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  is_celebrity BOOLEAN DEFAULT FALSE,     -- Set when follower_count >= 10K
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

posts (
  id UUID PRIMARY KEY,
  author_id UUID REFERENCES users(id),
  content TEXT,
  image_url VARCHAR(500),
  post_type VARCHAR(20),                  -- 'text' | 'image' | 'link'
  privacy VARCHAR(20),                    -- 'public' | 'friends'
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

friendships (
  id UUID PRIMARY KEY,
  follower_id UUID REFERENCES users(id),
  following_id UUID REFERENCES users(id),
  status VARCHAR(20),                     -- 'pending' | 'active' | 'blocked'
  created_at TIMESTAMPTZ,
  UNIQUE(follower_id, following_id)
)

-- Engagement
likes (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  post_id UUID REFERENCES posts(id),
  created_at TIMESTAMPTZ,
  UNIQUE(user_id, post_id)
)

comments (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  post_id UUID REFERENCES posts(id),
  content TEXT NOT NULL,
  like_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ
)

-- Feed infrastructure
feed_items (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  post_id UUID REFERENCES posts(id),
  score DOUBLE PRECISION,
  created_at TIMESTAMPTZ,
  UNIQUE(user_id, post_id)
)

affinity_scores (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  target_user_id UUID REFERENCES users(id),
  score DOUBLE PRECISION DEFAULT 0,
  last_interaction_at TIMESTAMPTZ,
  UNIQUE(user_id, target_user_id)
)

-- Auth
sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
```

### Key Indexes

```sql
-- Feed generation: posts by author, ordered by time
CREATE INDEX idx_posts_author_created ON posts(author_id, created_at DESC);

-- Follower lookup for fan-out
CREATE INDEX idx_friendships_following ON friendships(following_id);
CREATE INDEX idx_friendships_follower ON friendships(follower_id);

-- Feed retrieval
CREATE INDEX idx_feed_items_user_score ON feed_items(user_id, score DESC);

-- Affinity lookup for ranking
CREATE INDEX idx_affinity_user ON affinity_scores(user_id, score DESC);
```

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `session:{token}` | String | 24h | User session data (JSON) |
| `feed:{userId}` | Sorted Set | 24h | Cached feed (score=timestamp, value=postId) |
| `celebrity_posts:{userId}` | Sorted Set | None | Celebrity posts for pull-based retrieval |
| `affinity:{userId}` | Sorted Set | 7d | Cached affinity scores per user |
| `post:{postId}` | Hash | 1h | Cached post data (optional) |

## API Design

### Core Endpoints

```
Authentication
POST   /api/v1/auth/register     Create account
POST   /api/v1/auth/login        Login, returns session token
POST   /api/v1/auth/logout       Invalidate session
GET    /api/v1/auth/me           Get current user

Feed
GET    /api/v1/feed              Personalized feed (cursor pagination)
GET    /api/v1/feed/explore      Trending/popular posts

Posts
POST   /api/v1/posts             Create post
GET    /api/v1/posts/:id         Get single post
DELETE /api/v1/posts/:id         Delete post (soft delete)
POST   /api/v1/posts/:id/like    Like post
DELETE /api/v1/posts/:id/like    Unlike post
GET    /api/v1/posts/:id/comments   Get comments
POST   /api/v1/posts/:id/comments   Add comment

Users
GET    /api/v1/users?q=query     Search users
GET    /api/v1/users/:username   Get profile
PUT    /api/v1/users/me          Update own profile
GET    /api/v1/users/:username/posts     User's posts
GET    /api/v1/users/:username/followers Get followers
GET    /api/v1/users/:username/following Get following
POST   /api/v1/users/:username/follow    Follow user
DELETE /api/v1/users/:username/follow    Unfollow user
```

### Pagination

All list endpoints use cursor-based pagination:

```json
{
  "data": [...],
  "pagination": {
    "nextCursor": "1705084800000",
    "hasMore": true
  }
}
```

### Rate Limits

| Endpoint Category | Limit | Window |
|-------------------|-------|--------|
| Auth (login/register) | 10 | 1 minute |
| Read (GET) | 100 | 1 minute |
| Write (POST/PUT/DELETE) | 30 | 1 minute |
| Feed refresh | 20 | 1 minute |

## Key Design Decisions

### Hybrid Fan-out Strategy

The most critical design decision is how posts reach followers' feeds.

**Pure push (fan-out on write)** delivers every post to every follower's pre-materialized feed at write time. This gives fast reads (O(1) lookup) but creates catastrophic write amplification for high-follower accounts. A celebrity with 10M followers posting once means 10M feed_item inserts -- saturating disk I/O and taking minutes to propagate.

**Pure pull (fan-out on read)** stores nothing in followers' feeds. At read time, the system queries all followed accounts for recent posts and merges them. This eliminates write amplification but makes reads expensive: a user following 500 accounts requires 500 queries, killing read latency.

**Hybrid (chosen):** Regular users (< 10K followers) use push, celebrities use pull. At feed read time, the aggregator merges the pre-built feed with celebrity posts fetched from Redis. The trade-off is code complexity -- the feed aggregator must handle both paths and deduplicate -- but this is justified because 99% of users are regular (push is cheap) while the 1% of celebrities generate disproportionate fan-out cost.

### PostgreSQL over Cassandra for Feed Storage

PostgreSQL handles all data including feed_items. At production scale, Cassandra would be better for the feed_items table (write-heavy, partition-key access pattern). We chose PostgreSQL because: (1) simpler operations for a learning project, (2) rich query capabilities for ranking and analytics, (3) can serve hundreds of millions of rows with proper indexing and partitioning before needing Cassandra. The migration path is clear: extract feed_items to Cassandra when write throughput exceeds what a sharded PostgreSQL can handle.

### Redis Sorted Sets for Feed Cache

Redis sorted sets naturally model ranked feeds (score = timestamp or ranking score, member = postId). Alternatives like a dedicated feed store (Rockset, custom service) offer richer query capabilities but add operational complexity. Redis provides sub-millisecond lookups, built-in TTL, and pub/sub in a single service. The trade-off is that Redis is memory-bound -- at scale, we'd need Redis Cluster sharded by userId to distribute feed cache across hundreds of nodes.

## Consistency and Idempotency

### Post Creation Idempotency

Network failures can cause duplicate post submissions. The system uses Redis-backed idempotency keys with 24-hour TTL via `X-Idempotency-Key` header. The composite key (`userId:path:clientKey`) prevents cross-endpoint collisions. Only successful responses (2xx) are cached. On cache errors, the system fails open to avoid blocking legitimate requests.

### Feed Consistency Model

| Operation | Consistency Model | Recovery |
|-----------|-------------------|----------|
| Post creation | Strong (PostgreSQL ACID) | Automatic |
| Feed propagation | Eventual (5-10s) | Fan-out retry via message queue |
| Like/comment counts | Eventual (Redis to PostgreSQL sync) | Periodic reconciliation job |
| Affinity scores | Eventually consistent | Scores accumulate, no rollback needed |

## Security

### Authentication

- **Session-based auth**: Token stored in Redis with 24-hour expiry
- **Password hashing**: bcrypt with cost factor 10
- **Token format**: UUID v4, passed via `Authorization: Bearer {token}` header

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| **user** | CRUD own posts/comments, follow/unfollow, view public content |
| **admin** | All user permissions + view all users, delete any post, view system stats |

### Input Validation

- All inputs sanitized and validated before processing
- Content length limits: posts (5000 chars), comments (1000 chars)
- URL validation for image_url fields
- SQL injection prevention via parameterized queries

## Observability

### Metrics (Prometheus Format)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_requests_total` | Counter | method, path, status | Request volume |
| `http_request_duration_seconds` | Histogram | method, path | Latency distribution |
| `feed_generation_duration_seconds` | Histogram | cache_hit | Feed build time |
| `fanout_operations_total` | Counter | author_type | Push vs pull distribution |
| `fanout_followers_count` | Histogram | - | Fan-out breadth |
| `fanout_duration_seconds` | Histogram | - | Fan-out operation time |
| `db_query_duration_seconds` | Histogram | query_name | Database performance |
| `cache_operations_total` | Counter | cache_name, result | Cache effectiveness |
| `websocket_active_connections` | Gauge | - | Real-time connection count |
| `circuit_breaker_state` | Gauge | name | Circuit breaker monitoring |

### Logging

Structured JSON logs via Pino with consistent fields (timestamp, level, message, requestId, userId). Log levels: error (unhandled exceptions), warn (rate limits, validation), info (request lifecycle), debug (query details, cache ops).

### Health Check Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Detailed component health (database, Redis) |
| `GET /health/live` | Kubernetes liveness probe |
| `GET /health/ready` | Kubernetes readiness probe (checks DB availability) |

### Alerting Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High latency | p95 > 500ms for 5 min | Warning |
| Error rate | 5xx > 1% for 5 min | Critical |
| Database connections | Pool exhausted | Critical |
| Redis connection | Lost for > 30s | Critical |
| Cache hit rate | < 60% for 10 min | Warning |

## Failure Handling

### Circuit Breaker Pattern

Feed generation is protected by a circuit breaker (Opossum). When the database is overloaded, continuing to send queries makes the problem worse. The circuit opens after failures exceed a threshold, failing fast (< 1ms) instead of waiting for timeouts (3-5s). In half-open state, test requests probe recovery. When the feed circuit opens, users see popular/trending posts as a fallback rather than errors.

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Database write | 3 | Exponential (100ms, 200ms, 400ms) | UPSERT with unique constraints |
| Redis write | 2 | Linear (50ms) | Operations are naturally idempotent |
| Fan-out | 3 | Exponential | Dedupe by (user_id, post_id) unique constraint |

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| Redis down | Fall back to PostgreSQL for sessions and feeds (slower) |
| Celebrity posts cache miss | Query PostgreSQL for recent posts |
| WebSocket disconnect | Client polls /api/v1/feed every 30s |
| Database read replica lag | Route to primary |

## Scalability Considerations

### Horizontal Scaling Path

1. **API Servers**: Stateless, add instances behind load balancer. No session affinity needed.
2. **PostgreSQL**: Read replicas for scaling reads. Shard by user_id when write throughput requires it.
3. **Redis Cluster**: Shard by userId for feed cache distribution. Dedicated instances for pub/sub.
4. **Fan-out Workers**: Scale independently based on Kafka consumer lag.

### Celebrity Threshold Tuning

| Threshold | Push Write Cost | Pull Read Cost | Recommendation |
|-----------|-----------------|----------------|----------------|
| 1,000 | Lower | Higher | Use if write capacity limited |
| 10,000 (current) | Balanced | Balanced | Good default |
| 100,000 | Higher | Lower | Use if read latency critical |

### Sharding Strategy

At > 100M users, shard PostgreSQL by user_id hash. Feed_items and affinity_scores are naturally partitioned by user_id. Posts need a separate shard key (author_id) with a global index for post_id lookups. Cross-shard fan-out requires the message queue to route writes to the correct shard.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Feed distribution | Hybrid push/pull | Pure push or pure pull | Balances write amplification vs read latency |
| Primary database | PostgreSQL | Cassandra | Simpler ops, rich queries, sufficient with sharding |
| Feed cache | Redis Sorted Sets | Dedicated feed store | Sub-ms lookups, built-in TTL, pub/sub in one service |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler token management |
| Real-time updates | WebSocket + Redis Pub/Sub | SSE or polling | Bidirectional, cross-instance sync via pub/sub |
| Ranking algorithm | Engagement x recency x affinity | ML-based ranking | Simple, interpretable, sufficient for MVP |

## Implementation Notes

This section maps the production architecture to the actual local implementation.

### Local Architecture

```
┌─────────────────┐
│  React Frontend │
│  Vite :5173     │
└────────┬────────┘
         │ HTTP + WebSocket
         ▼
┌─────────────────┐
│  Express API    │
│  :3000          │
│  + WebSocket    │
│  (single process│
│   with fan-out, │
│   feed ranking, │
│   auth)         │
└──┬──────────┬───┘
   │          │
   ▼          ▼
┌────────┐ ┌────────┐
│Postgres│ │ Valkey  │
│ :5432  │ │ :6379  │
│newsfeed│ │(cache, │
│        │ │ pubsub)│
└────────┘ └────────┘
```

### Production Patterns Actually Implemented

| Pattern | File | What It Does |
|---------|------|-------------|
| **Circuit breaker** (Opossum) | `backend/src/shared/circuit-breaker.ts` | Wraps feed generation with configurable thresholds; tracks state via Prometheus gauges |
| **Prometheus metrics** (prom-client) | `backend/src/shared/metrics.ts` | 15+ custom metrics covering HTTP, feed, fanout, cache, WebSocket, and circuit breaker |
| **Structured logging** (Pino) | `backend/src/shared/logger.ts` | JSON logs with child loggers per component; pino-pretty for dev |
| **Idempotency middleware** | `backend/src/shared/idempotency.ts` | Redis-backed dedup for POST requests via X-Idempotency-Key header |
| **Health checks** | `backend/src/shared/health.ts` | /health, /health/live, /health/ready with per-component latency metrics |
| **Feed caching** | `backend/src/shared/cache.ts` | Redis sorted sets with 24h TTL, cache-aside with write-through on fan-out |
| **Hybrid fan-out** | `backend/src/services/fanout.ts` | Celebrity detection, batch PostgreSQL inserts, Redis pipeline for followers |
| **Affinity scoring** | `backend/src/services/fanout.ts` | Weighted interaction tracking (like=2, comment=5, share=10, view=0.5) |
| **Feed ranking** | `backend/src/services/fanout.ts` | engagement x recencyDecay x affinityBoost formula |
| **WebSocket real-time** | `backend/src/index.ts` | Redis pub/sub subscription per user, token-based WS auth |
| **Feed virtualization** | `frontend/src/routes/index.tsx` | @tanstack/react-virtual for efficient DOM rendering of large feeds |

### What Was Simplified or Substituted

| Production Design | Local Implementation | Why |
|-------------------|---------------------|-----|
| API Gateway (Kong/Envoy) | Direct Express routing | Single service, no routing needed |
| Kafka for fan-out events | In-process fan-out in Post Service | No async worker infra needed at dev scale |
| Separate microservices | Single Express process | All routes colocated for simplicity |
| PostgreSQL sharding | Single PostgreSQL instance | 100 users, no sharding needed |
| Redis Cluster | Single Valkey instance | All cache fits in 64MB |
| OAuth/JWT auth | Session-based with bcrypt | Simpler, immediate revocation |
| CDN for static assets | Vite dev server | Local development only |

### What Was Omitted

- CDN / edge caching
- Multi-region deployment with geo-routing
- Kubernetes orchestration
- ML-based ranking service
- A/B testing framework for ranking algorithms
- PostgreSQL read replicas
- Kafka / message queue infrastructure
- Load balancer (nginx/HAProxy) -- though multi-instance is supported via `npm run dev:server1/2/3`
- Content moderation / spam detection
- Image upload and storage (MinIO/S3) -- posts accept image URLs only

---

## Frontend Architecture

### Component Hierarchy

```
__root (Root)
├── Header                          # Top navigation with logo, search, profile menu
├── Outlet (route-specific content)
│   ├── / (HomePage)                # Virtualized feed with post composer
│   │   ├── PostComposer            # Create post with text, image URL, privacy
│   │   ├── Virtualized feed        # @tanstack/react-virtual with dynamic heights
│   │   │   └── PostCard[]          # Individual post with likes, comments, sharing
│   │   │       ├── Avatar          # Reusable avatar with fallback initial
│   │   │       ├── Button          # Styled button with loading state
│   │   │       └── Comments        # Expandable, lazy-loaded comment section
│   │   └── Loading / Empty / End   # Feed state indicators
│   ├── /profile/$username          # User profile with posts + follower lists
│   ├── /login                      # Login form
│   └── /register                   # Registration form
```

### Zustand Stores

**`useAuthStore`** (`stores/authStore.ts`): Manages authentication state with `persist` middleware. Unlike the other projects in this repository that use cookie-based sessions, this project uses token-based auth: the `token` field is stored in localStorage and attached to every API request as a `Bearer` token in the `Authorization` header. The `persist` middleware serializes only the `token` (not the user object) to localStorage under the key `auth-storage`. On app startup, `checkAuth` reads the token from localStorage and validates it against `/api/v1/auth/me`. If valid, the full user object is populated. If invalid or expired, the token is cleared. The `setUser` action allows profile updates to sync to the header immediately.

**`useFeedStore`** (`stores/feedStore.ts`): Manages the home feed with cursor-based pagination and optimistic updates. Stores `posts` (accumulated array), `cursor` (opaque timestamp for next page), `hasMore` (pagination flag), `isLoading`, and `error`. The store provides six actions:

- `fetchFeed(reset?)`: Loads posts from the API, appending to existing posts unless `reset=true`. Guards against concurrent loads and stops when `hasMore` is false.
- `addPost(post)`: Prepends a newly created post to the array (used by PostComposer).
- `removePost(postId)`: Removes a deleted post from the array.
- `updatePost(postId, updates)`: Merges partial updates into a post (generic update).
- `likePost(postId)`: Optimistic like with rollback on failure.
- `unlikePost(postId)`: Optimistic unlike with rollback on failure.

The like/unlike actions are the most architecturally interesting. They immediately update the local state (setting `is_liked` and incrementing/decrementing `like_count`), then fire the API call asynchronously. If the API call fails, the store rolls back to the previous state. This creates a zero-latency UI where the like button responds instantly regardless of network speed.

### Routing

TanStack Router with file-based routing. The home route uses a `beforeLoad` guard that checks for a token in localStorage and redirects to `/login` if absent. This is a declarative guard (using `throw redirect(...)`) rather than the imperative `useEffect` + `useNavigate` pattern used in the other projects.

| File | URL Pattern | Purpose |
|------|-------------|---------|
| `routes/index.tsx` | `/` | Home feed with post composer (auth required) |
| `routes/profile.$username.tsx` | `/profile/:username` | User profile with posts + followers |
| `routes/login.tsx` | `/login` | Login form |
| `routes/register.tsx` | `/register` | Registration form |

### Data Fetching

The API client (`services/api.ts`) is organized into four namespaces: `authApi`, `usersApi`, `postsApi`, and `feedApi`. It includes a custom `ApiError` class that carries the HTTP status code, enabling callers to distinguish between 401 (unauthorized), 404 (not found), and 500 (server error) responses.

Authentication is handled differently from other projects: instead of `credentials: 'include'` for cookie-based sessions, this project uses `Authorization: Bearer {token}` headers. The `request` helper reads the token from localStorage and attaches it to every request. This approach works with stateless API servers (no server-side session storage needed for auth) but requires explicit token management on the client.

Feed data flows through the `useFeedStore`, which handles pagination state. The home page triggers `fetchFeed(true)` on mount to load the initial feed, then relies on infinite scroll to load subsequent pages.

### Virtualization

The home feed uses `@tanstack/react-virtual` for efficient DOM rendering of large post lists. The virtualizer is configured with:

- `estimateSize: () => 400`: Initial height estimate per post (header + content + actions).
- `overscan: 3`: Renders 3 extra posts above and below the viewport for smoother scrolling.
- `measureElement`: Uses `getBoundingClientRect().height` for dynamic height measurement. This is necessary because posts have variable heights (text length, images, expanded comments).

Each virtualized item is positioned with `position: absolute` and `transform: translateY(...)`, which triggers GPU-accelerated compositing rather than CPU layout. The `ref={virtualizer.measureElement}` callback on each item tells the virtualizer the actual height after rendering, allowing it to correct its position estimates.

**Infinite scroll**: A scroll event listener checks if the user is within 500px of the bottom of the scrollable area. If so, it calls `fetchFeed()` to load the next page. Guards prevent concurrent loads and stop loading when `hasMore` is false.

### Optimistic Updates

The FB News Feed frontend has the most sophisticated optimistic update pattern of the four projects:

**Like/unlike with rollback**: When a user clicks "Like," the `useFeedStore.likePost` action immediately sets `is_liked: true` and increments `like_count` in the local state. The API call fires asynchronously. If the API call fails, the store reverses the change (sets `is_liked: false` and decrements `like_count`). This means the UI responds in <1ms regardless of network latency. The rollback ensures consistency: if the server rejects the like (e.g., the post was deleted), the UI self-corrects.

**Post creation insert**: After `postsApi.createPost` resolves, the `PostComposer` calls `addPost(post)` to prepend the new post to the feed. The post appears at the top immediately because it is added to the front of the array. No full feed refresh is needed.

**Post deletion**: After confirming and deleting via `postsApi.deletePost`, the `removePost(postId)` action filters the post from the array. The virtualizer automatically adjusts positions for the remaining posts.

### Key UI Patterns

**Celebrity badge**: The `PostCard` component renders a blue verified checkmark next to celebrity authors (users with `is_celebrity: true`). This surfaces the hybrid fan-out distinction in the UI: celebrity posts are pulled at read time rather than pushed.

**Privacy indicator**: Posts display a globe icon for public posts and a people icon for friends-only posts, reflecting the `privacy` field. This gives users visual feedback about their post's visibility.

**Expandable textarea**: The `PostComposer` textarea starts as a single-line pill-shaped input. On focus, it expands to 3 rows with rounded corners. On blur (if empty), it collapses back. This mimics Facebook's behavior where the composer is compact until actively used.

**Lazy comment loading**: Comments are not loaded until the user clicks "Comment" or the comment count. The `PostCard` maintains local state for `comments`, `loadingComments`, and `showComments`. This avoids loading comments for posts the user scrolls past, which would waste bandwidth on a feed where most posts are not engaged with.

---

## Deep Pattern Explanations

### Circuit Breaker

A circuit breaker is a fault-tolerance pattern that prevents an application from repeatedly calling a failing service. When a downstream service (e.g., the database) becomes slow or unresponsive, continuing to send requests makes the problem worse: each request ties up a connection and a thread, eventually exhausting the caller's resources and causing a cascading failure.

The implementation (`backend/src/shared/circuit-breaker.ts`) uses the Opossum library and wraps the feed generation function. The circuit breaker tracks the success/failure ratio of recent calls. When failures exceed the configured threshold, the circuit "opens" and immediately rejects all subsequent calls without attempting them (failing in <1ms instead of waiting 3-5 seconds for a timeout). After a cooldown period, the circuit enters "half-open" state and allows one test request. If it succeeds, normal operation resumes. If it fails, the circuit reopens.

When the feed circuit breaker is open, the system degrades gracefully by showing popular/trending posts as a fallback instead of an error page. This ensures users still see content even when the personalized feed pipeline is failing.

**Why not just set shorter timeouts?** Timeouts limit how long a single request waits, but they do not reduce load on the failing service. With a 3-second timeout and 100 concurrent users, the failing service still receives 100 requests. The circuit breaker eliminates all requests after the threshold is reached, giving the downstream service time to recover. The circuit breaker and timeout work together: the timeout detects individual failures, and the circuit breaker aggregates them into a system-level response.

The circuit breaker state is exposed as a Prometheus gauge (`circuit_breaker_state`), enabling alerting when circuits open.

### Redis Cache-Aside

Cache-aside (also called "lazy loading" or "read-aside") is a caching strategy where the application manages the cache explicitly. On a read request, the application first checks the cache. If the data is present (cache hit), it is returned immediately without touching the database. If absent (cache miss), the application queries the database, writes the result to the cache with a TTL, and returns it.

The implementation (`backend/src/shared/cache.ts`) uses Redis sorted sets for feed caching. When a user's feed is generated, the post IDs and their ranking scores are stored in a Redis sorted set (`feed:{userId}`) with a 24-hour TTL. Subsequent feed requests read from the sorted set using `ZREVRANGEBYSCORE` (retrieve by score range in descending order), which returns results in O(log N + M) time where M is the number of returned items.

**Write-through for fan-out**: When a regular user creates a post, the fan-out process writes to both the database (`feed_items` table) and the Redis cache (`ZADD` to each follower's sorted set) simultaneously. This is write-through: the cache is updated at write time rather than lazily. Write-through is chosen for fan-out because the fan-out process already iterates over all followers, making the additional Redis writes a negligible cost.

**Cache invalidation**: When a user follows or unfollows someone, their feed cache is invalidated (deleted), forcing a rebuild on the next request. This is simpler than surgically adding or removing posts from the cache, and the follow/unfollow frequency is low enough that rebuilds are inexpensive.

### Structured Logging

Structured logging means emitting log messages as JSON objects with named fields rather than concatenated text strings. Instead of `"2024-01-15 User 42 liked post abc-123"`, the log becomes `{"level":"info","msg":"post.liked","userId":"42","postId":"abc-123","component":"posts","requestId":"req-789","timestamp":"2024-01-15T10:30:00Z"}`.

The implementation (`backend/src/shared/logger.ts`) uses Pino, which outputs JSON by default. Pino creates child loggers per component (e.g., `logger.child({ component: 'fanout' })`), so every log line from the fan-out service automatically carries the `component: "fanout"` field. In development, `pino-pretty` formats the JSON into colorized, human-readable output.

**Why structured logging matters for fan-out debugging**: When a celebrity post fails to propagate to some followers, the operations team needs to trace the fan-out process. With structured logs, the query `component="fanout" AND postId="abc-123"` returns every step of that specific fan-out, including how many followers were processed, which batch failed, and what the error was. With text logs, this requires regex parsing across potentially millions of log lines.

### Prometheus Metrics

Prometheus is a time-series monitoring system that scrapes numerical measurements from your application at fixed intervals (typically every 15 seconds). The application exposes a `/metrics` endpoint that returns measurements in Prometheus text format. Prometheus stores these timestamped values, enabling temporal queries ("what was the p95 latency over the last hour") and alerting ("notify me when the error rate exceeds 1%").

The four metric types:
- **Counter**: Values that only increase (e.g., `fanout_operations_total`). Rates are derived: `rate(fanout_operations_total[5m])`.
- **Histogram**: Value distributions in buckets (e.g., `feed_generation_duration_seconds`). Enables percentile queries.
- **Gauge**: Values that can increase or decrease (e.g., `websocket_active_connections`). Represents current state.

The implementation (`backend/src/shared/metrics.ts`) defines 15+ metrics. The fan-out metrics are unique to this project: `fanout_operations_total` is labeled by `author_type` (regular vs celebrity), showing the balance between push and pull. `fanout_followers_count` is a histogram showing the distribution of fan-out breadth, which helps tune the celebrity threshold (currently 10,000 followers).

### Health Checks

Health checks are HTTP endpoints that report whether the application can serve traffic. They are consumed by two audiences: orchestration systems (Kubernetes, load balancers) and operations teams.

The implementation (`backend/src/shared/health.ts`) provides three endpoints:
- **`GET /health`**: Returns detailed component health (database latency, Redis latency) as JSON. Operations teams use this for debugging.
- **`GET /health/live`**: Returns 200 if the process is running. Kubernetes uses this to detect hung processes. Does not check external dependencies.
- **`GET /health/ready`**: Returns 200 if the application can handle requests. Checks database and Redis connectivity. Kubernetes uses this to control traffic routing.

**Why separate liveness from readiness**: If liveness checked the database and the database went down temporarily, the orchestrator would restart all API instances simultaneously. The restart surge would send connection storms to the recovering database, potentially prolonging the outage. Liveness should only detect process-level failures (deadlocks, infinite loops), while readiness reflects dependency health.

### Idempotency

An idempotent operation produces the same result regardless of how many times it is executed. Network failures are inevitable in distributed systems: a client sends a POST request, the server processes it, but the response is lost. The client retries, and without idempotency, the server processes the request again, creating a duplicate.

The implementation (`backend/src/shared/idempotency.ts`) uses Redis-backed idempotency keys. When a client sends a POST request with an `X-Idempotency-Key` header, the middleware constructs a composite key from `userId:path:clientKey`. Before processing, it checks Redis for this key. If found, the cached response is returned immediately (no database writes, no fan-out). If not found, the request is processed normally, and the response is stored in Redis with a 24-hour TTL.

Only successful responses (2xx status) are cached. This prevents a scenario where a transient error (database timeout) is cached, causing all retries to receive the same error. Failed requests return normally, allowing the client to retry and potentially succeed.

**Fail-open on cache errors**: If Redis is unavailable, the idempotency middleware allows the request through without deduplication. This trades potential duplicates for availability, which is the correct trade-off: a duplicate post is annoying but recoverable, while blocking all post creation during a Redis outage is not.

### RBAC (Role-Based Access Control)

RBAC assigns permissions to roles rather than individual users. The FB News Feed has two roles: `user` and `admin`. Instead of maintaining a permissions table listing what each user can do, the system checks the user's role and maps it to a predefined set of allowed operations.

| Role | Permissions |
|------|-------------|
| `user` | Create/delete own posts, comment, like, follow/unfollow, view public content |
| `admin` | All user permissions + view all users, delete any post, view system stats |

The auth middleware extracts the user's role from the session (Redis lookup) and attaches it to the request context. Route handlers check `req.user.role === 'admin'` for admin-only operations. This is simpler than a full permission system (no permission tables, no role-permission mapping tables) and sufficient for a system with two roles.

**Why not per-user permissions?** For 500M users, storing individual permissions would require a massive lookup table. With RBAC, role assignment is a single column on the users table. Adding a new role (e.g., `moderator`) means adding one row to the role definitions, not updating millions of user records. The trade-off: RBAC cannot express fine-grained permissions like "user 42 can edit posts in group X but not group Y." For that, you would need attribute-based access control (ABAC), which is significantly more complex.

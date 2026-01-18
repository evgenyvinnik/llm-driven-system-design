# Facebook News Feed - Architecture Design

## System Overview

A personalized content feed system for social media that delivers relevant posts to users based on social connections, engagement patterns, and content freshness. The system implements a hybrid fan-out architecture balancing write efficiency for celebrities with read latency for regular users.

## Requirements

### Functional Requirements

- **Post creation**: Users can create text/image posts with privacy controls (public, friends-only)
- **Feed generation**: Personalized feed ranked by engagement, recency, and user affinity
- **Social graph**: Follow/unfollow relationships with bidirectional friend detection
- **Engagement**: Likes, comments, and shares with real-time count updates
- **Real-time updates**: WebSocket-based live feed updates for new posts and engagement
- **User profiles**: Profile pages with post history and follower/following lists

### Non-Functional Requirements

- **Scalability**: Support 100 concurrent users locally, architecture supports horizontal scaling
- **Availability**: 99.9% uptime target (allows ~8.7 hours downtime/year)
- **Latency**: Feed load < 200ms p95, post creation < 100ms p95
- **Consistency**: Eventual consistency for feed (5-10 second propagation), strong consistency for likes/comments counts

## Capacity Estimation

### Local Development Scale

For a learning/development environment simulating a small social network:

| Metric | Target Value | Notes |
|--------|--------------|-------|
| Daily Active Users (DAU) | 100 | Simulated via test accounts |
| Peak Concurrent Users | 20 | Local testing capacity |
| Posts per day | 500 | ~5 posts per active user |
| Feed requests per second | 10 RPS | Peak during testing |
| Post creation RPS | 2 RPS | Burst during testing |
| Average post size | 1 KB | Text + metadata, excluding images |
| Average feed request | 50 posts | Initial load + pagination |

### Storage Estimates

| Data Type | Size Calculation | 1 Year Storage |
|-----------|-----------------|----------------|
| Users | 100 users x 2 KB = 200 KB | 200 KB |
| Posts | 500/day x 1 KB x 365 = 182 MB | 182 MB |
| Feed Items | 100 users x 1000 items x 100 B = 10 MB | 10 MB (pruned) |
| Comments | 5 per post x 500/day x 500 B x 365 = 456 MB | 456 MB |
| Likes | 10 per post x 500/day x 50 B x 365 = 91 MB | 91 MB |
| Affinity Scores | 100 x 100 x 50 B = 500 KB | 500 KB |
| **Total** | | **~750 MB** |

### Component Sizing (Local Development)

| Component | Resources | Justification |
|-----------|-----------|---------------|
| PostgreSQL | 256 MB RAM, 1 GB disk | Handles all persistent storage |
| Redis | 64 MB RAM | Session cache + feed cache + pub/sub |
| Backend (per instance) | 128 MB RAM | Express + TypeScript runtime |
| Frontend | Static files, ~2 MB | Vite production build |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Load Balancer                                   │
│                         (nginx or HAProxy at :3000)                         │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  API Server   │     │  API Server   │     │  API Server   │
│   :3001       │     │   :3002       │     │   :3003       │
└───────┬───────┘     └───────┬───────┘     └───────┬───────┘
        │                     │                     │
        └─────────────────────┴─────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  PostgreSQL   │     │    Redis      │     │   WebSocket   │
│   Primary     │     │  Cache/PubSub │     │    Server     │
│   :5432       │     │   :6379       │     │   (per API)   │
└───────────────┘     └───────────────┘     └───────────────┘
```

### Core Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **API Server** | REST endpoints, auth, business logic | Node.js + Express + TypeScript |
| **Fan-out Service** | Distributes posts to follower feeds | In-process (could extract to worker) |
| **Feed Aggregator** | Merges push/pull feeds, applies ranking | In-process query logic |
| **PostgreSQL** | Primary data store (users, posts, relationships) | PostgreSQL 16 |
| **Redis** | Session cache, feed cache, celebrity posts, pub/sub | Redis 7 / Valkey |
| **WebSocket** | Real-time feed updates | ws library on Express |

## Request Flows

### Post Creation Flow

```
1. Client → POST /api/v1/posts (content, imageUrl, privacy)
2. API validates session token from Redis
3. Insert post into PostgreSQL (posts table)
4. Fan-out service determines author type:
   - Celebrity (≥10K followers): Store in Redis sorted set (celebrity_posts:{authorId})
   - Regular user: Fan-out to followers' feeds
5. For regular users:
   a. Query all followers from friendships table
   b. Batch insert into feed_items table (PostgreSQL)
   c. Pipeline ZADD to feed:{followerId} keys (Redis)
6. Publish to Redis pub/sub channel for real-time updates
7. Return 201 with created post
```

### Feed Read Flow

```
1. Client → GET /api/v1/feed?cursor=timestamp&limit=20
2. API validates session, gets userId from Redis
3. Feed aggregator:
   a. Fetch cached feed from Redis (ZREVRANGEBYSCORE feed:{userId})
   b. If cache miss: Query feed_items from PostgreSQL
   c. Identify followed celebrities from friendships table
   d. Fetch celebrity posts from Redis (celebrity_posts:{celebrityId})
   e. Merge and deduplicate post IDs
4. Batch fetch post data from PostgreSQL
5. For each post, calculate ranking score:
   score = engagement * recencyDecay * affinityBoost
   - engagement = likes + (comments × 3) + (shares × 5)
   - recencyDecay = 1 / (1 + ageInHours × 0.08)  [12-hour half-life]
   - affinityBoost = 1 + min(affinityScore, 100) / 100
6. Sort by score descending, apply pagination
7. Return posts with next cursor
```

### Follow User Flow

```
1. Client → POST /api/v1/users/:username/follow
2. Validate session
3. Insert into friendships table (follower_id, following_id)
4. Update follower_count on target user
5. Update following_count on current user
6. Backfill: Fetch recent posts from new followee
   a. Insert into feed_items for current user
   b. Update Redis feed cache
7. Return 200 OK
```

## Data Model

### Database Schema (PostgreSQL)

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
-- Query patterns and their indexes
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

## Caching Strategy

### Cache-Aside Pattern

```
Read path:
1. Check Redis cache first
2. On miss: Query PostgreSQL
3. Populate cache with TTL
4. Return data

Write path:
1. Write to PostgreSQL
2. Invalidate or update cache
3. For feed items: Write-through to Redis
```

### Cache Configuration

| Cache | Strategy | TTL | Invalidation |
|-------|----------|-----|--------------|
| Feed cache | Write-through on fan-out | 24 hours | On unfollow, post delete |
| Session cache | Write-through | Session expiry | On logout |
| Celebrity posts | Write-through | None (pruned by count) | On post delete |
| Affinity scores | Write-through on interaction | 7 days | None (accumulative) |

### Cache Hit Targets

| Cache | Target Hit Rate | Action if Below |
|-------|-----------------|-----------------|
| Session | 99% | Check Redis connection, increase TTL |
| Feed | 80% | Pre-warm on login, increase TTL |
| Celebrity posts | 95% | Always in memory for active celebrities |

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application** | Node.js + Express + TypeScript | Fast iteration, async I/O, type safety |
| **Frontend** | React 19 + Vite + Tanstack Router | Modern React with file-based routing |
| **State Management** | Zustand | Lightweight, TypeScript-first |
| **Styling** | Tailwind CSS | Utility-first, fast prototyping |
| **Database** | PostgreSQL 16 | ACID transactions, rich indexing, JSON support |
| **Cache** | Redis 7 / Valkey | Sorted sets for feeds, pub/sub for real-time |
| **Real-time** | WebSocket (ws) | Native WebSocket, low overhead |

## Frontend Virtualization

The news feed uses `@tanstack/react-virtual` for efficient rendering of large post collections.

### Why Virtualization for Social Feeds

**The Problem:** Facebook-style feeds can contain hundreds of posts with:
- Variable height (text, images, embeds)
- Rich interactions (comments, reactions)
- Real-time updates

Without virtualization, the DOM grows unbounded, causing performance degradation.

**The Solution:** Only render posts visible in the viewport, measuring actual heights dynamically.

**Implementation in `routes/index.tsx`:**

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

const virtualizer = useVirtualizer({
  count: posts.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 400, // header + content + actions + comments estimate
  overscan: 3,
  measureElement: (element) => element.getBoundingClientRect().height,
});
```

**Key Configuration:**

| Setting | Value | Rationale |
|---------|-------|-----------|
| `estimateSize` | 400px | Average post with image and comments |
| `overscan` | 3 | Balance between smoothness and memory |
| `measureElement` | Dynamic | Posts vary significantly in height |

**Infinite Scroll Integration:**

```typescript
const handleScroll = useCallback(() => {
  const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
  if (scrollHeight - scrollTop - clientHeight < 500) {
    fetchFeed(); // Load next page
  }
}, [fetchFeed]);
```

**Performance Comparison:**

| Metric | Without Virtualization | With Virtualization |
|--------|------------------------|---------------------|
| DOM nodes (100 posts) | 1000+ | ~60 |
| Initial render | 500ms | 100ms |
| Memory at 100 posts | 250MB | 100MB |
| Scroll FPS | 30-40 | 60 |

---

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

### Security Headers

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Content-Security-Policy: default-src 'self'
```

## Observability

### Metrics (Prometheus Format)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_requests_total` | Counter | method, path, status | Request volume |
| `http_request_duration_seconds` | Histogram | method, path | Latency distribution |
| `feed_generation_duration_seconds` | Histogram | cache_hit | Feed build time |
| `fanout_posts_total` | Counter | author_type | Push vs pull distribution |
| `fanout_followers_count` | Histogram | - | Fan-out breadth |
| `db_query_duration_seconds` | Histogram | query_name | Database performance |
| `cache_hits_total` | Counter | cache_name | Cache effectiveness |
| `cache_misses_total` | Counter | cache_name | Cache effectiveness |
| `active_websocket_connections` | Gauge | - | Real-time connection count |

### Logging

Structured JSON logs with consistent fields:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "message": "Feed generated",
  "userId": "a0eebc99-...",
  "requestId": "req-12345",
  "duration_ms": 45,
  "posts_count": 20,
  "cache_hit": true
}
```

Log levels:
- **error**: Unhandled exceptions, database failures, external service errors
- **warn**: Rate limit hits, validation failures, deprecated usage
- **info**: Request/response summary, major operations
- **debug**: Query details, cache operations (development only)

### Tracing

For local development, simple request ID propagation:

1. Generate `X-Request-ID` at load balancer or first API server
2. Include in all log entries
3. Pass to database queries as comment for slow query analysis

### Alerting Thresholds (for production)

| Alert | Condition | Severity |
|-------|-----------|----------|
| High latency | p95 > 500ms for 5 min | Warning |
| Error rate | 5xx > 1% for 5 min | Critical |
| Database connections | Pool exhausted | Critical |
| Redis connection | Lost for > 30s | Critical |
| Cache hit rate | < 60% for 10 min | Warning |

### Health Check Endpoint

```
GET /health

Response:
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "components": {
    "database": { "status": "up", "latency_ms": 2 },
    "redis": { "status": "up", "latency_ms": 1 },
    "websocket": { "status": "up", "connections": 5 }
  }
}
```

## Failure Handling

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Database write | 3 | Exponential (100ms, 200ms, 400ms) | Use UPSERT with unique constraints |
| Redis write | 2 | Linear (50ms) | Operations are naturally idempotent |
| Fan-out | 3 | Exponential | Dedupe by (user_id, post_id) unique constraint |

### Circuit Breaker Pattern

For external dependencies (not implemented in local dev, but architecture supports):

```
States: CLOSED → OPEN → HALF_OPEN → CLOSED
Thresholds:
- OPEN after 5 consecutive failures
- HALF_OPEN after 30 second timeout
- CLOSED after 3 successful requests in HALF_OPEN
```

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| Redis down | Fall back to PostgreSQL for sessions and feeds (slower) |
| Celebrity posts cache miss | Query PostgreSQL for recent posts |
| WebSocket disconnect | Client polls /api/v1/feed every 30s |
| Database read replica lag | Route to primary (not applicable for local dev) |

### Data Consistency

| Operation | Consistency Model | Recovery |
|-----------|-------------------|----------|
| Post creation | Strong (PostgreSQL ACID) | Automatic |
| Feed propagation | Eventual (5-10s) | Fan-out retry queue |
| Like/comment counts | Eventual (Redis → PostgreSQL sync) | Periodic reconciliation job |
| Affinity scores | Eventually consistent | Scores accumulate, no rollback needed |

### Backup and Recovery (Production Considerations)

| Component | Backup Strategy | RTO | RPO |
|-----------|-----------------|-----|-----|
| PostgreSQL | pg_dump daily + WAL archiving | 1 hour | 5 minutes |
| Redis | RDB snapshots every 15 min | 15 minutes | 15 minutes |

For local development: Use Docker volumes with `docker-compose down` (preserves data) vs `docker-compose down -v` (destroys data).

## Cost Tradeoffs

### Storage vs Compute

| Approach | Storage Cost | Compute Cost | When to Use |
|----------|--------------|--------------|-------------|
| Push fan-out (current for regular users) | Higher (duplicate feed items) | Lower (simple reads) | Users with < 10K followers |
| Pull aggregation (current for celebrities) | Lower (single post storage) | Higher (merge at read) | Users with >= 10K followers |
| Hybrid (implemented) | Balanced | Balanced | Best of both worlds |

### Caching Investment

| Cache Level | Memory Cost | Latency Improvement | Recommendation |
|-------------|-------------|---------------------|----------------|
| Session cache | Low (1KB per session) | 50ms → 1ms | Always use |
| Feed cache | Medium (100KB per user) | 200ms → 10ms | Use for active users |
| Post cache | Medium | 20ms → 1ms | Optional, test benefit |

### Scaling Decisions

| Bottleneck | Solution | Cost | Complexity |
|------------|----------|------|------------|
| Read throughput | Add API server instances | Low (stateless) | Low |
| Database reads | Add read replicas | Medium | Medium |
| Database writes | Vertical scaling → sharding | High | High |
| Feed latency | Increase Redis memory | Low | Low |

## Scalability Considerations

### Horizontal Scaling

The architecture supports horizontal scaling at multiple layers:

1. **API Servers**: Stateless, add instances behind load balancer
2. **Read Replicas**: PostgreSQL streaming replication for read scaling
3. **Redis Cluster**: Shard by user ID for feed cache distribution

### Vertical Scaling Limits (Local Dev)

| Component | Local Limit | Production Path |
|-----------|-------------|-----------------|
| PostgreSQL | 10K posts/day | Partition by date, shard by user |
| Redis | 1GB feed cache | Redis Cluster or separate instances |
| Single API | 100 RPS | Load balance across 3+ instances |

### Celebrity Threshold Tuning

Current threshold: 10,000 followers

| Threshold | Push Write Cost | Pull Read Cost | Recommendation |
|-----------|-----------------|----------------|----------------|
| 1,000 | Lower | Higher | Use if write capacity limited |
| 10,000 (current) | Balanced | Balanced | Good default |
| 100,000 | Higher | Lower | Use if read latency critical |

## Trade-offs and Alternatives

### Push vs Pull vs Hybrid

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Pure Push** | Fast reads, simple aggregation | Write amplification for celebrities | Rejected |
| **Pure Pull** | No write amplification | Slow reads, complex aggregation | Rejected |
| **Hybrid** (chosen) | Balanced | More complex code | Adopted |

### PostgreSQL vs Cassandra

| Factor | PostgreSQL | Cassandra |
|--------|------------|-----------|
| Joins | Native support | Must denormalize |
| Transactions | Full ACID | Limited |
| Local dev | Simple setup | Complex |
| Scale limit | ~10M rows comfortable | Billions |
| **Decision** | Chosen for simplicity | Consider at massive scale |

### Redis Sorted Sets vs Dedicated Feed Store

| Factor | Redis | Dedicated (e.g., Rockset) |
|--------|-------|---------------------------|
| Complexity | Built-in | Additional service |
| Cost | Memory-bound | Storage-bound |
| Query flexibility | Limited | SQL-like |
| **Decision** | Chosen for simplicity | Consider for complex ranking |

## Future Optimizations

### Short-term (Next Iteration)

- [ ] Add request-level caching for unchanged feeds (ETag/If-None-Match)
- [ ] Implement feed warming on user login
- [ ] Add connection pooling configuration tuning
- [ ] Implement rate limiting middleware

### Medium-term

- [ ] Extract fan-out to background worker with RabbitMQ
- [ ] Add read replicas for PostgreSQL
- [ ] Implement content-based spam detection
- [ ] Add A/B testing framework for ranking algorithms

### Long-term (Production Scale)

- [ ] Shard PostgreSQL by user ID
- [ ] Implement Redis Cluster for feed cache
- [ ] Add ML-based ranking service
- [ ] Multi-region deployment with geo-routing

## Monitoring and Observability

### Dashboard Panels (Grafana)

1. **Overview**: Request rate, error rate, p50/p95/p99 latency
2. **Feed Performance**: Generation time, cache hit rate, posts per request
3. **Fan-out Health**: Push rate, celebrity post count, backlog size
4. **Database**: Connection pool usage, query latency, slow queries
5. **Redis**: Memory usage, hit rate, pub/sub message rate
6. **WebSocket**: Active connections, message rate, errors

### Key SLIs

| SLI | Target | Measurement |
|-----|--------|-------------|
| Availability | 99.9% | Successful requests / total requests |
| Feed Latency | < 200ms p95 | Histogram of /api/v1/feed duration |
| Post Latency | < 100ms p95 | Histogram of POST /api/v1/posts duration |
| Error Rate | < 0.1% | 5xx responses / total responses |

## References

- [The Facebook News Feed](https://engineering.fb.com/2010/05/13/web/the-new-facebook-news-feed/)
- [Twitter Fan-out Architecture](https://blog.twitter.com/engineering/en_us/topics/infrastructure/2017/the-infrastructure-behind-twitter-scale)
- [TAO: Facebook's Distributed Data Store](https://engineering.fb.com/2013/06/25/core-infra/tao-the-power-of-the-graph/)
- [Redis Sorted Sets](https://redis.io/docs/data-types/sorted-sets/)

---

## Implementation Notes

This section documents the key implementation decisions and the reasoning behind critical system design patterns used in the codebase.

### Feed Caching Strategy

**Implementation:** Redis sorted sets for feed caching with 24-hour TTL.

**Why feed caching is critical for read-heavy workloads:**

1. **Read/Write Ratio:** Social media feeds are extremely read-heavy. A typical user might create 1-5 posts per day but refresh their feed 50+ times. This 10-100x read/write ratio makes caching essential for scalability.

2. **Latency Requirements:** Users expect sub-200ms feed load times. Without caching, each feed request would require:
   - Querying `feed_items` table (disk I/O)
   - Joining with `posts` and `users` tables
   - Fetching celebrity posts
   - Calculating ranking scores
   - This easily exceeds 500ms under load

3. **Database Load Reduction:** With 100 DAU refreshing feeds 50x/day, that's 5,000 feed queries daily. Caching with 80% hit rate reduces DB queries to 1,000/day - an 80% reduction in database load.

4. **Cost Efficiency:** Redis memory is cheaper than scaling PostgreSQL read replicas. A 64MB Redis instance can cache feeds for all 100 local dev users.

**Implementation Pattern:**
```typescript
// Cache-aside with write-through on fanout
const cachedFeed = await getFeedFromCache(userId, limit);
if (cachedFeed) {
  return cachedFeed; // Cache hit
}
// Cache miss: query DB, then cache results
const dbResults = await queryDatabase();
await setFeedCache(userId, dbResults);
```

### Post Creation Idempotency

**Implementation:** Redis-backed idempotency keys with 24-hour TTL using `X-Idempotency-Key` header.

**Why idempotency prevents duplicate posts:**

1. **Network Unreliability:** Mobile networks are unreliable. A POST request might succeed on the server but the response is lost due to network timeout. The client retries, potentially creating a duplicate post.

2. **User Behavior:** Users often double-click submit buttons or refresh after submission, inadvertently sending duplicate requests.

3. **Distributed Systems:** With multiple API server instances, a request might be routed to different servers on retry. Without idempotency, each server would process it as a new request.

4. **Data Integrity:** Duplicate posts pollute feeds and degrade user experience. They also skew engagement metrics and waste storage.

**Implementation Pattern:**
```typescript
// Composite key includes user, path, and client-provided key
const compositeKey = `${userId}:${path}:${idempotencyKey}`;

// Check for cached response
const cached = await getIdempotencyResponse(compositeKey);
if (cached.hit) {
  return cached.value; // Return cached response
}

// Process request and cache response
const result = await processRequest();
await setIdempotencyResponse(compositeKey, result);
return result;
```

**Key Design Choices:**
- Composite key prevents cross-endpoint collisions
- 24-hour TTL balances storage cost with retry windows
- Only successful responses (2xx) are cached
- Fails open on cache errors to avoid blocking legitimate requests

### Fanout Metrics

**Implementation:** Prometheus counters and histograms for fanout operations.

**Why fanout metrics enable ranking optimization:**

1. **Distribution Analysis:** Tracking `fanout_followers_count` histogram reveals the distribution of post reach. This data informs threshold tuning for celebrity vs. regular user classification.

2. **Latency Monitoring:** `fanout_duration_seconds` histogram identifies slow fanout operations that might delay real-time updates. P95/P99 values indicate worst-case user experience.

3. **Volume Tracking:** `fanout_operations_total` with `author_type` label shows the ratio of push (regular) vs. pull (celebrity) operations. This validates the hybrid strategy is working as expected.

4. **Ranking Algorithm Tuning:** By correlating fanout metrics with engagement metrics (likes, comments), we can:
   - Identify if posts from users with large fanouts get less engagement per follower
   - Adjust ranking weights for different post distribution paths
   - Detect if celebrity posts (pull-based) have different engagement patterns

**Key Metrics Collected:**
```
# Operations by author type
fanout_operations_total{author_type="regular"} 847
fanout_operations_total{author_type="celebrity"} 23

# Followers notified distribution
fanout_followers_count_bucket{le="10"} 650
fanout_followers_count_bucket{le="100"} 180
fanout_followers_count_bucket{le="1000"} 17

# Fanout latency
fanout_duration_seconds_bucket{le="0.1"} 800
fanout_duration_seconds_bucket{le="0.5"} 860
fanout_duration_seconds_bucket{le="1.0"} 870
```

### Circuit Breaker for Feed Generation

**Implementation:** Opossum circuit breaker with configurable thresholds protecting feed generation.

**Why circuit breakers protect against cascade failures:**

1. **Failure Isolation:** When the database is overloaded or slow, continuing to send queries makes the problem worse. The circuit breaker "opens" after detecting failures, preventing additional load on the struggling dependency.

2. **Fast Failure:** Without a circuit breaker, requests wait for timeout (often 30+ seconds). With an open circuit, requests fail immediately (< 1ms), freeing up resources and providing quick feedback to users.

3. **Self-Healing:** The half-open state allows the system to automatically recover without manual intervention. Once the dependency recovers, a few test requests succeed and the circuit closes.

4. **Resource Protection:** Thread pools, connection pools, and memory are finite resources. Without circuit breaking, a slow dependency consumes these resources, cascading failure to other features.

**State Diagram:**
```
CLOSED (normal operation)
    │
    ├── 5 consecutive failures
    │
    ▼
OPEN (fail fast)
    │
    ├── 30 second timeout
    │
    ▼
HALF-OPEN (testing)
    │
    ├── 3 successful requests → CLOSED
    │
    └── 1 failure → OPEN
```

**Implementation Pattern:**
```typescript
const feedGenerationBreaker = createCircuitBreaker(
  generateFeed,
  'feed_generation',
  {
    timeout: 5000,              // 5 second timeout
    errorThresholdPercentage: 25, // Open after 25% failures
    resetTimeout: 30000,        // Try again after 30 seconds
    volumeThreshold: 3,         // Minimum 3 requests before tripping
  }
);

// Fallback returns popular posts when circuit is open
feedGenerationBreaker.fallback(async () => {
  return await getPopularPosts();
});
```

**Graceful Degradation:**
When the feed generation circuit opens:
1. Users still see content (popular posts as fallback)
2. System load on struggling components is reduced
3. Metrics track circuit state changes for alerting
4. Once recovered, personalized feeds resume automatically

### Capacity and SLO Implementation

**SLO Targets (Local Development):**

| SLI | Target | Measurement Metric |
|-----|--------|-------------------|
| Feed Latency | < 200ms P95 | `feed_generation_duration_seconds` |
| Post Creation Latency | < 100ms P95 | `http_request_duration_seconds{path="/api/v1/posts"}` |
| Availability | 99.9% | `http_requests_total{status!~"5.*"}` / `http_requests_total` |
| Error Rate | < 0.1% | 5xx responses / total responses |

**Component Sizing Based on Capacity:**

| Component | Peak Load | Resource Allocation | Justification |
|-----------|-----------|---------------------|---------------|
| PostgreSQL | 10 RPS reads, 2 RPS writes | 256MB RAM, 1GB disk | Handles all CRUD with connection pooling |
| Redis | 50 RPS cache ops | 64MB RAM | Feed cache + session cache + pub/sub |
| API Server | 20 RPS | 128MB RAM per instance | Stateless, scales horizontally |

**Storage Growth Projections:**

| Data Type | Daily Growth | Monthly Growth | 1 Year Retention |
|-----------|--------------|----------------|------------------|
| Posts | 500 KB/day | 15 MB/month | 180 MB |
| Feed Items | 100 KB/day (pruned) | 3 MB/month | N/A (rolling) |
| Sessions | 10 KB/day | 300 KB/month | N/A (7-day expiry) |
| Affinity Scores | 50 KB/day | 1.5 MB/month | 18 MB |

# Facebook Post Search - Architecture Design

## System Overview

A privacy-aware search engine for social media posts with real-time indexing, personalized ranking, and sub-second latency.

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

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Load Balancer                              │
└─────────────────────────────────────────────────────────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
   ┌───────▼───────┐       ┌───────▼───────┐       ┌───────▼───────┐
   │Search Service │       │Search Service │       │Search Service │
   │   (Node.js)   │       │   (Node.js)   │       │   (Node.js)   │
   └───────┬───────┘       └───────┬───────┘       └───────┬───────┘
           │                        │                        │
           └────────────────────────┼────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼───────┐          ┌───────▼───────┐          ┌───────▼───────┐
│   PostgreSQL  │          │ Elasticsearch │          │     Redis     │
│  (Users/Posts)│          │   (Search)    │          │   (Cache)     │
└───────────────┘          └───────────────┘          └───────────────┘
```

### Core Components

1. **Search Service (Stateless)**
   - Receives search queries from clients
   - Orchestrates the search flow
   - Applies privacy filtering and ranking
   - Horizontally scalable

2. **PostgreSQL**
   - Source of truth for users, posts, friendships
   - ACID transactions for data integrity
   - Used for auth and user management

3. **Elasticsearch**
   - Full-text search index
   - Stores post documents with visibility fingerprints
   - Handles scoring and highlighting

4. **Redis**
   - Caches user visibility sets
   - Stores session data
   - Tracks trending searches
   - Caches search suggestions

## Data Model

### PostgreSQL Schema

The database consists of five tables that support user authentication, content management, social relationships, and search analytics. The complete schema is available in `/backend/src/db/init.sql`.

#### Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              ENTITY RELATIONSHIPS                                │
└─────────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────────┐
                              │      users       │
                              ├──────────────────┤
                              │ id (PK)          │
                              │ username         │
                              │ email            │
                              │ display_name     │
                              │ password_hash    │
                              │ avatar_url       │
                              │ role             │
                              │ created_at       │
                              │ updated_at       │
                              └────────┬─────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           │                           │                           │
           │ 1:N                       │ 1:N                       │ 1:N
           ▼                           ▼                           ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│      posts       │        │   friendships    │        │  search_history  │
├──────────────────┤        ├──────────────────┤        ├──────────────────┤
│ id (PK)          │        │ id (PK)          │        │ id (PK)          │
│ author_id (FK)───┼────────│ user_id (FK)─────┼────────│ user_id (FK)     │
│ content          │        │ friend_id (FK)───┼───┐    │ query            │
│ visibility       │        │ status           │   │    │ filters (JSONB)  │
│ post_type        │        │ created_at       │   │    │ results_count    │
│ media_url        │        └──────────────────┘   │    │ created_at       │
│ like_count       │                               │    └──────────────────┘
│ comment_count    │        ┌──────────────────────┘
│ share_count      │        │ (self-referential)
│ created_at       │        │
│ updated_at       │        │                           ┌──────────────────┐
└──────────────────┘        │                           │     sessions     │
                            │                           ├──────────────────┤
                            │                           │ id (PK)          │
                            └───────────────────────────│ user_id (FK)     │
                                                        │ token            │
                                                        │ expires_at       │
                                                        │ created_at       │
                                                        └──────────────────┘

LEGEND:
  PK = Primary Key
  FK = Foreign Key
  1:N = One-to-Many relationship
  ──► = Foreign key reference direction
```

#### Table Definitions

##### users
The central identity table for all user accounts.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT gen_random_uuid() | Unique user identifier |
| username | VARCHAR(50) | UNIQUE, NOT NULL | Public username for @mentions |
| email | VARCHAR(255) | UNIQUE, NOT NULL | Email address for login |
| display_name | VARCHAR(100) | NOT NULL | Human-readable name shown in UI |
| password_hash | VARCHAR(255) | NOT NULL | bcrypt-hashed password |
| avatar_url | VARCHAR(500) | | URL to profile picture |
| role | VARCHAR(20) | CHECK (user, admin), DEFAULT 'user' | Authorization level |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Account creation time |
| updated_at | TIMESTAMPTZ | DEFAULT NOW(), auto-trigger | Last profile modification |

**Design rationale:**
- UUID primary keys enable distributed ID generation without coordination
- Separate username/email allows login by either method
- Display name supports internationalization (non-ASCII names)
- Role column enables admin features without separate admin table

##### posts
User-generated content with visibility controls and denormalized engagement metrics.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT gen_random_uuid() | Unique post identifier |
| author_id | UUID | FK -> users(id) ON DELETE CASCADE, NOT NULL | Post creator |
| content | TEXT | NOT NULL | Post body text (indexed to Elasticsearch) |
| visibility | VARCHAR(20) | CHECK (public, friends, friends_of_friends, private), DEFAULT 'friends' | Access control level |
| post_type | VARCHAR(20) | CHECK (text, photo, video, link), DEFAULT 'text' | Content type for filtering |
| media_url | VARCHAR(500) | | URL to attached media (if applicable) |
| like_count | INTEGER | DEFAULT 0 | Denormalized like count |
| comment_count | INTEGER | DEFAULT 0 | Denormalized comment count |
| share_count | INTEGER | DEFAULT 0 | Denormalized share count |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Post creation time |
| updated_at | TIMESTAMPTZ | DEFAULT NOW(), auto-trigger | Last post edit time |

**Design rationale:**
- Denormalized counters avoid expensive COUNT(*) aggregations at read time
- Visibility enum maps directly to Elasticsearch visibility fingerprints
- Post types enable faceted search filtering
- ON DELETE CASCADE ensures orphan posts are removed when user is deleted

##### friendships
Directional social graph edges representing friend relationships.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT gen_random_uuid() | Relationship identifier |
| user_id | UUID | FK -> users(id) ON DELETE CASCADE, NOT NULL | The user who owns this relationship |
| friend_id | UUID | FK -> users(id) ON DELETE CASCADE, NOT NULL | The friend in the relationship |
| status | VARCHAR(20) | CHECK (pending, accepted, blocked), DEFAULT 'pending' | Relationship state |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | When relationship was created |
| | | UNIQUE(user_id, friend_id) | Prevents duplicate relationships |

**Design rationale:**
- Directional design: each accepted friendship creates two rows (A->B and B->A)
- Enables fast queries: "SELECT friend_id FROM friendships WHERE user_id = ? AND status = 'accepted'"
- Status supports friend request workflow (pending -> accepted) and blocking
- Self-referential FK to users enables friends-of-friends queries via join
- ON DELETE CASCADE: when a user is deleted, all their friendships are removed

**Data flow for visibility computation:**
1. User searches for posts
2. System queries `friendships` for user's accepted friends
3. Builds visibility fingerprint set: `["PUBLIC", "PRIVATE:{user_id}", "FRIENDS:{friend_id}", ...]`
4. Elasticsearch filters posts by fingerprint intersection

##### search_history
Analytics table for tracking search queries.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT gen_random_uuid() | Search record identifier |
| user_id | UUID | FK -> users(id) ON DELETE CASCADE, NOT NULL | User who searched |
| query | VARCHAR(500) | NOT NULL | Search query text |
| filters | JSONB | | Applied filters (date_range, post_type, etc.) |
| results_count | INTEGER | DEFAULT 0 | Number of results returned |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | When search was performed |

**Design rationale:**
- JSONB for filters enables flexible schema evolution without migrations
- results_count helps identify low-yield queries for improvement
- Subject to 90-day retention (cleaned by scheduled job)
- Used for: trending searches, search suggestions, analytics

##### sessions
Authentication session storage (also cached in Redis).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PK, DEFAULT gen_random_uuid() | Session identifier |
| user_id | UUID | FK -> users(id) ON DELETE CASCADE, NOT NULL | Session owner |
| token | VARCHAR(255) | UNIQUE, NOT NULL | Session token (cookie value) |
| expires_at | TIMESTAMPTZ | NOT NULL | Session expiration time |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Session creation time |

**Design rationale:**
- Token uniqueness prevents collision attacks
- Explicit expires_at enables both database cleanup and application validation
- ON DELETE CASCADE: deleting a user invalidates all their sessions
- Redis caching reduces database load for high-frequency auth checks

#### Indexes

| Table | Index | Columns | Purpose |
|-------|-------|---------|---------|
| posts | idx_posts_author_id | author_id | User profile page queries |
| posts | idx_posts_created_at | created_at DESC | Chronological feeds, date filtering |
| posts | idx_posts_visibility | visibility | Privacy-aware query optimization |
| friendships | idx_friendships_user_id | user_id | Friend list lookups |
| friendships | idx_friendships_friend_id | friend_id | Reverse friend lookups |
| friendships | idx_friendships_status | status | Filter by relationship state |
| search_history | idx_search_history_user_id | user_id | User's recent searches |
| search_history | idx_search_history_created_at | created_at DESC | Trending queries, cleanup |
| sessions | idx_sessions_token | token | Auth token validation |
| sessions | idx_sessions_user_id | user_id | Logout all devices feature |

#### Foreign Key Cascade Behaviors

All foreign keys use `ON DELETE CASCADE`:

| Relationship | Cascade Effect | Rationale |
|--------------|----------------|-----------|
| posts.author_id -> users.id | User deletion removes all their posts | Prevents orphan content; supports GDPR right-to-erasure |
| friendships.user_id -> users.id | User deletion removes outgoing relationships | Maintains referential integrity |
| friendships.friend_id -> users.id | User deletion removes incoming relationships | Bidirectional cleanup |
| search_history.user_id -> users.id | User deletion removes search history | Privacy compliance |
| sessions.user_id -> users.id | User deletion invalidates all sessions | Security requirement |

**Why CASCADE over SET NULL:**
- Social graph integrity: orphan friendships pointing to deleted users would corrupt visibility computation
- Privacy: deleted users should have no residual data in the system
- Simplicity: application code doesn't need to handle null foreign keys

**Why not RESTRICT:**
- User deletion should always succeed without manual cleanup
- Dependent data has no value after user deletion

#### Triggers

| Trigger | Table | Event | Function | Purpose |
|---------|-------|-------|----------|---------|
| update_users_updated_at | users | BEFORE UPDATE | update_updated_at_column() | Audit timestamp |
| update_posts_updated_at | posts | BEFORE UPDATE | update_updated_at_column() | Edit tracking |

The `update_updated_at_column()` function automatically sets `updated_at = NOW()` on any row modification, ensuring accurate audit trails without application-layer responsibility.

#### Data Flow Examples

**1. Creating a new post:**
```
Application                    PostgreSQL                    Elasticsearch
    │                              │                              │
    ├─ INSERT INTO posts ──────────►                              │
    │  (author_id, content,        │                              │
    │   visibility, post_type)     │                              │
    │                              │                              │
    │  ◄─── id, created_at ────────┤                              │
    │                              │                              │
    ├─ Compute visibility ─────────┼──────────────────────────────►
    │  fingerprints                │  INDEX document with         │
    │                              │  fingerprints                │
    │                              │                              │
    │  ◄───────────────────────────┼─── searchable immediately ───┤
```

**2. Searching for posts (privacy-aware):**
```
User Query         Search Service           PostgreSQL         Elasticsearch
    │                    │                       │                   │
    ├─ search "party" ──►│                       │                   │
    │                    │                       │                   │
    │                    ├─ GET user's friends ──►                   │
    │                    │   FROM friendships    │                   │
    │                    │   WHERE status='accepted'                 │
    │                    │                       │                   │
    │                    │  ◄─── friend_ids ─────┤                   │
    │                    │                       │                   │
    │                    ├─ Build visibility set: ─────────────────►│
    │                    │   ["PUBLIC",          │  Filter by       │
    │                    │    "PRIVATE:user",    │  visibility_     │
    │                    │    "FRIENDS:friend1", │  fingerprints    │
    │                    │    ...]               │                  │
    │                    │                       │                   │
    │                    │  ◄──────── matching posts ───────────────┤
    │                    │                       │                   │
    │  ◄─ ranked results ┤                       │                   │
```

**3. Accepting a friend request:**
```
Application                    PostgreSQL                    Redis (Cache)
    │                              │                              │
    ├─ UPDATE friendships ─────────►                              │
    │  SET status='accepted'       │                              │
    │  WHERE user_id=B, friend_id=A│                              │
    │                              │                              │
    ├─ INSERT INTO friendships ────►                              │
    │  (user_id=A, friend_id=B,    │                              │
    │   status='accepted')         │                              │
    │                              │                              │
    ├─ Invalidate visibility cache ┼──────────────────────────────►
    │  for users A and B           │  DEL visibility:A            │
    │                              │  DEL visibility:B            │
    │                              │                              │
    │  (Next search will           │                              │
    │   recompute fresh set)       │                              │
```

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
  "visibility": "friends",
  "visibility_fingerprints": ["PUBLIC", "FRIENDS:user123"],
  "post_type": "text",
  "engagement_score": 125.0,
  "like_count": 50,
  "comment_count": 25,
  "language": "en"
}
```

## API Design

### Core Endpoints

#### Search
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
  "next_cursor": "abc123",
  "total_estimate": 1500,
  "took_ms": 45
}
```

#### Suggestions
```
GET /api/v1/search/suggestions?q=birth&limit=5

Response:
{
  "suggestions": [
    {"text": "birthday party", "type": "query"},
    {"text": "#birthday", "type": "hashtag"}
  ]
}
```

## Key Design Decisions

### 1. Privacy-Aware Search with Visibility Fingerprints

The key challenge is filtering search results based on who can see each post.

**Naive Approach (Too Slow):**
1. Search for "birthday party" -> 10 million results
2. For each result, check if user can see it -> O(n) permission checks

**Solution: Precomputed Visibility Fingerprints**

Each post stores visibility fingerprints:
- Public posts: `["PUBLIC"]`
- Friends-only: `["FRIENDS:author_id"]`
- Private: `["PRIVATE:author_id"]`

At query time, we compute the user's visibility set:
- Always includes: `"PUBLIC"`
- Includes: `"PRIVATE:user_id"` (own posts)
- Includes: `"FRIENDS:friend_id"` for each friend

The search query includes a terms filter on visibility_fingerprints, which Elasticsearch handles efficiently.

### 2. Personalized Ranking

**Two-Phase Ranking:**

1. **Elasticsearch (Retrieval):**
   - BM25 text relevance
   - Recency boost (exponential decay)
   - Engagement score boost

2. **Application Layer (Re-ranking):**
   - Friend relationship boosting
   - Social proximity signals
   - User's historical preferences

### 3. Real-Time Indexing

Posts are indexed immediately upon creation:
1. POST /api/v1/posts creates post in PostgreSQL
2. Immediately indexes to Elasticsearch with refresh=true
3. Post is searchable within milliseconds

For production scale, we'd use an event-driven pipeline with Kafka.

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application** | Node.js + Express | Fast development, async I/O, TypeScript support |
| **Database** | PostgreSQL 16 | ACID, relational data, JSON support |
| **Search** | Elasticsearch 8.11 | Full-text search, relevance scoring, horizontal scaling |
| **Cache** | Redis 7 | Fast key-value, TTL support, sorted sets for trending |
| **Frontend** | React 19 + Vite | Modern React features, fast development |
| **State** | Zustand | Simple, minimal boilerplate |
| **Routing** | TanStack Router | Type-safe routing |
| **Styling** | Tailwind CSS | Utility-first, fast iteration |

## Scalability Considerations

### Horizontal Scaling

1. **Search Services**: Stateless, add more instances behind load balancer
2. **Elasticsearch**: Add shards and replicas as data grows
3. **PostgreSQL**: Read replicas for query scaling
4. **Redis**: Cluster mode for cache distribution

### Data Partitioning

- **Posts**: Hash by post_id across Elasticsearch shards
- **Time-based**: Hot/cold tiers (recent posts on faster nodes)
- **Geographic**: Regional clusters for lower latency

## Trade-offs and Alternatives

| Decision | Trade-off |
|----------|-----------|
| Visibility fingerprints | Faster queries vs. re-indexing on relationship changes |
| Immediate indexing | Real-time search vs. potential consistency lag |
| Redis for suggestions | Fast typeahead vs. additional infrastructure |
| Session-based auth | Simplicity vs. JWT scalability |

### Alternatives Considered

1. **Solr vs Elasticsearch**: Chose ES for better real-time indexing and operational simplicity
2. **MongoDB vs PostgreSQL**: Chose PG for relational data (friendships) and ACID guarantees
3. **Memcached vs Redis**: Chose Redis for data structures (sorted sets, pub/sub)

## Monitoring and Observability

**Key Metrics to Track:**
- Search latency (p50, p95, p99)
- Indexing lag (time from post creation to searchable)
- Cache hit rates (visibility sets, suggestions)
- Elasticsearch cluster health
- Query throughput by endpoint

**Alerting:**
- Search latency > 500ms
- Elasticsearch cluster yellow/red
- Redis connection failures
- Error rate > 1%

## Security Considerations

1. **Authentication**: Session-based with Redis, secure cookie storage
2. **Authorization**: Role-based (user vs admin), post ownership checks
3. **Input Validation**: Zod schemas for request validation
4. **Rate Limiting**: IP-based limiting on search endpoints
5. **SQL Injection**: Parameterized queries throughout

## Data Lifecycle Policies

### Retention and TTL

| Data Type | Retention Period | Storage Tier | Rationale |
|-----------|------------------|--------------|-----------|
| **Posts (PostgreSQL)** | Forever | Primary | Source of truth, never deleted (soft delete only) |
| **Posts (Elasticsearch)** | 2 years hot, 5 years warm | Hot/Warm | Active search index; older posts rarely searched |
| **Search History** | 90 days | Primary | Privacy and storage efficiency |
| **Session Data (Redis)** | 24 hours | Memory | Short-lived auth sessions |
| **Visibility Cache (Redis)** | 15 minutes | Memory | Invalidated on friendship changes |
| **Trending Searches (Redis)** | 24 hours rolling | Memory | Recency-weighted rankings |

### TTL Implementation

**Elasticsearch Index Lifecycle Management (ILM):**
```json
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_primary_shard_size": "50gb",
            "max_age": "30d"
          }
        }
      },
      "warm": {
        "min_age": "60d",
        "actions": {
          "shrink": { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 },
          "allocate": { "require": { "data": "warm" } }
        }
      },
      "cold": {
        "min_age": "730d",
        "actions": {
          "freeze": {}
        }
      },
      "delete": {
        "min_age": "1825d",
        "actions": { "delete": {} }
      }
    }
  }
}
```

**Redis TTL Configuration (Local Development):**
```bash
# Set in Redis config or per-key
# Visibility sets: 15 minutes
SET visibility:user123 "{...}" EX 900

# Session data: 24 hours
SET session:abc123 "{...}" EX 86400

# Search suggestions: 1 hour
SET suggestions:birth "{...}" EX 3600
```

### Cold Storage Archival

**Local Development Setup:**
- Use MinIO as S3-compatible cold storage
- Archive posts older than 2 years to MinIO buckets
- Keep metadata in PostgreSQL with `archived_at` timestamp

**Archival Process:**
1. Daily cron job identifies posts older than 2 years not yet archived
2. Export post content to JSON, compress with gzip
3. Upload to MinIO bucket: `archives/posts/YYYY/MM/post-{id}.json.gz`
4. Update PostgreSQL: `SET archived_at = NOW(), content = NULL`
5. Delete from Elasticsearch warm tier

**Retrieval:**
- Search only returns archived post ID + metadata
- On-demand retrieval from MinIO when user clicks "View archived post"
- Cache retrieved archived posts in Redis for 1 hour

### Backfill and Replay Procedures

**Scenario 1: Elasticsearch Index Corruption**
```bash
# 1. Create new index with current mapping
curl -X PUT "localhost:9200/posts_v2" -H 'Content-Type: application/json' -d @mappings.json

# 2. Reindex from PostgreSQL (local development script)
npm run db:reindex-posts

# 3. Alias swap for zero-downtime
curl -X POST "localhost:9200/_aliases" -d '{
  "actions": [
    { "remove": { "index": "posts_v1", "alias": "posts" } },
    { "add": { "index": "posts_v2", "alias": "posts" } }
  ]
}'
```

**Scenario 2: Replay from Event Log (if Kafka is used)**
```bash
# Reset consumer group offset to replay events
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group post-indexer \
  --topic post-events \
  --reset-offsets --to-datetime 2024-01-01T00:00:00.000 \
  --execute

# Restart indexer to replay
npm run dev:indexer
```

**Scenario 3: Partial Reindex (date range)**
```sql
-- Find posts needing reindex
SELECT id FROM posts
WHERE created_at BETWEEN '2024-01-01' AND '2024-01-31'
  AND updated_at > indexed_at;

-- Mark for reindex queue
UPDATE posts SET needs_reindex = true WHERE ...;
```

## Deployment and Operations

### Rollout Strategy

**Local Development (Multi-Instance Testing):**
```bash
# Start 3 instances on different ports
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
npm run dev:lb       # Nginx on port 3000, round-robin
```

**Canary Deployment Pattern:**
1. Deploy new version to `server1` only (33% traffic)
2. Monitor for 10 minutes: error rate, latency, ES query patterns
3. If healthy, deploy to `server2` (66% traffic)
4. Monitor for 10 minutes
5. Complete rollout to `server3` (100% traffic)

**Feature Flags (Simple Implementation):**
```typescript
// config/features.ts
export const features = {
  newRankingAlgorithm: process.env.FEATURE_NEW_RANKING === 'true',
  bloomFilterVisibility: false, // Disabled until stable
  mlReranking: false,
};

// Usage in search service
if (features.newRankingAlgorithm) {
  results = await applyNewRanking(results);
} else {
  results = await applyLegacyRanking(results);
}
```

### Schema Migrations

**PostgreSQL Migrations:**
```bash
# Migration file naming: 001_create_users.sql, 002_create_posts.sql, etc.
# Located in: backend/src/db/migrations/

# Run migrations
npm run db:migrate

# Rollback last migration
npm run db:rollback

# Check migration status
npm run db:status
```

**Migration Best Practices (enforced by code review):**
- Always add columns as nullable or with defaults
- Never drop columns in the same release that removes code using them
- Use `CREATE INDEX CONCURRENTLY` for large tables
- Add rollback SQL in comments at top of migration file

**Example Migration with Rollback:**
```sql
-- Migration: 015_add_indexed_at_to_posts.sql
-- Rollback: ALTER TABLE posts DROP COLUMN indexed_at;

ALTER TABLE posts ADD COLUMN indexed_at TIMESTAMP;
CREATE INDEX CONCURRENTLY idx_posts_indexed_at ON posts(indexed_at);
```

**Elasticsearch Mapping Changes:**
```bash
# For adding new fields (non-breaking):
curl -X PUT "localhost:9200/posts/_mapping" -d '{
  "properties": {
    "new_field": { "type": "keyword" }
  }
}'

# For breaking changes (requires reindex):
# 1. Create posts_v2 with new mapping
# 2. Reindex: POST _reindex { "source": {"index": "posts_v1"}, "dest": {"index": "posts_v2"} }
# 3. Swap alias
```

### Rollback Runbooks

**Runbook 1: Application Rollback**
```bash
# Symptoms: Error rate spike, 5xx responses
# Time to execute: 2 minutes

# 1. Check current version
git log --oneline -1

# 2. Rollback to previous commit
git checkout HEAD~1

# 3. Restart services
npm run dev:restart-all

# 4. Verify health
curl http://localhost:3000/health

# 5. Post-incident: Document what went wrong
```

**Runbook 2: Database Migration Rollback**
```bash
# Symptoms: Application errors related to schema
# Time to execute: 5 minutes

# 1. Stop all application instances
pkill -f "node.*server"

# 2. Execute rollback SQL (from migration file comments)
psql -U postgres -d fb_search -c "ALTER TABLE posts DROP COLUMN indexed_at;"

# 3. Revert application code
git checkout HEAD~1

# 4. Restart services
npm run dev:restart-all
```

**Runbook 3: Elasticsearch Recovery**
```bash
# Symptoms: Search returning errors, cluster red/yellow
# Time to execute: 10-30 minutes

# 1. Check cluster health
curl localhost:9200/_cluster/health?pretty

# 2. If yellow (unassigned replicas), usually self-heals. Wait 5 min.

# 3. If red (unassigned primary shards):
# Check which shards are unassigned
curl localhost:9200/_cat/shards?h=index,shard,prirep,state,unassigned.reason

# 4. For local dev, simplest fix is often:
docker-compose down
docker-compose up -d elasticsearch
npm run db:reindex-posts  # Rebuild index from PostgreSQL
```

**Runbook 4: Redis Cache Clear**
```bash
# Symptoms: Stale data, visibility filtering wrong
# Time to execute: 1 minute

# 1. Clear all visibility caches
redis-cli KEYS "visibility:*" | xargs redis-cli DEL

# 2. Clear all sessions (forces re-login)
redis-cli KEYS "session:*" | xargs redis-cli DEL

# 3. Clear search suggestions
redis-cli KEYS "suggestions:*" | xargs redis-cli DEL
```

## Capacity and Cost Guardrails

### Alert Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| **Search latency p95** | > 300ms | > 500ms | Check ES cluster, add caching |
| **Elasticsearch heap** | > 70% | > 85% | Increase JVM heap or add nodes |
| **Kafka consumer lag** | > 10,000 | > 100,000 | Scale indexer instances |
| **PostgreSQL connections** | > 80 | > 95 | Check connection leaks |
| **Redis memory** | > 70% | > 85% | Increase maxmemory or evict |
| **Disk usage (ES)** | > 75% | > 85% | Add nodes or archive old data |
| **Cache hit rate** | < 80% | < 60% | Review TTLs, increase cache size |
| **Error rate** | > 0.5% | > 2% | Check logs, rollback if needed |

### Local Development Alerts (docker-compose)

Add Prometheus alerting rules for local testing:
```yaml
# prometheus/alerts.yml
groups:
  - name: fb-post-search
    rules:
      - alert: HighSearchLatency
        expr: histogram_quantile(0.95, rate(search_latency_seconds_bucket[5m])) > 0.3
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Search p95 latency above 300ms"

      - alert: ElasticsearchClusterYellow
        expr: elasticsearch_cluster_health_status{color="yellow"} == 1
        for: 5m
        labels:
          severity: warning

      - alert: KafkaConsumerLag
        expr: kafka_consumer_group_lag > 10000
        for: 5m
        labels:
          severity: warning

      - alert: LowCacheHitRate
        expr: rate(redis_cache_hits[5m]) / (rate(redis_cache_hits[5m]) + rate(redis_cache_misses[5m])) < 0.8
        for: 10m
        labels:
          severity: warning
```

### Storage Growth Monitoring

**Elasticsearch Index Size:**
```bash
# Check index sizes
curl localhost:9200/_cat/indices?v&s=store.size:desc

# Expected growth for local dev: ~50MB/day with sample data
# Alert if posts index grows > 10GB (local) or > 100GB (per shard, prod)
```

**PostgreSQL Table Sizes:**
```sql
-- Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- Estimated local dev sizes after 1 month:
-- posts: ~100MB
-- users: ~10MB
-- search_history: ~50MB (with 90-day TTL cleanup)
```

### Cache Hit Rate Targets

| Cache | Target Hit Rate | TTL | Size Limit (Local) |
|-------|-----------------|-----|-------------------|
| Visibility sets | > 90% | 15 min | 100MB |
| Search suggestions | > 85% | 1 hour | 50MB |
| User profiles | > 95% | 5 min | 20MB |
| Session data | N/A (not a cache) | 24 hours | 10MB |

**Monitoring Cache Performance:**
```bash
# Redis cache stats
redis-cli INFO stats | grep -E "(keyspace_hits|keyspace_misses)"

# Calculate hit rate
# hit_rate = keyspace_hits / (keyspace_hits + keyspace_misses)
```

### Queue Lag Monitoring

**Kafka Consumer Lag (if using event-driven indexing):**
```bash
# Check consumer lag
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --describe --group post-indexer

# Healthy: LAG < 1000 per partition
# Warning: LAG > 10,000
# Critical: LAG > 100,000 (posts not searchable for minutes)
```

**Indexing Lag Metric:**
```typescript
// Track time between post creation and searchability
const indexingLag = Date.now() - post.created_at.getTime();
metrics.histogram('indexing_lag_ms', indexingLag);

// Target: p99 < 5000ms (5 seconds)
// Alert if p99 > 30000ms (30 seconds)
```

### Cost Optimization Guidelines

**Local Development Resource Limits (docker-compose):**
```yaml
services:
  elasticsearch:
    mem_limit: 2g  # Don't exceed 2GB locally
    environment:
      - "ES_JAVA_OPTS=-Xms1g -Xmx1g"

  postgres:
    mem_limit: 512m

  redis:
    mem_limit: 256m
    command: redis-server --maxmemory 200mb --maxmemory-policy allkeys-lru
```

**Cost Tradeoffs:**
| Decision | Cost Implication | Mitigation |
|----------|------------------|------------|
| 2-year hot index retention | High ES storage | ILM to warm tier at 60 days |
| 15-min visibility cache TTL | More Redis memory | LRU eviction, monitor hit rate |
| Real-time indexing | Higher ES write load | Batch indexing option for bulk imports |
| Full-text + engagement scoring | Complex ES queries | Query caching for popular searches |

## Implementation Notes

This section documents the implementation rationale for the observability and resilience features added to the backend.

### Index Retention: Balancing Search Relevance vs Storage

**Why:** Index retention policies balance search quality against infrastructure costs.

**Implementation:**
- **Hot tier (0-60 days):** Recent posts are most frequently searched and need fastest access. Stored on high-performance SSDs with full indexing.
- **Warm tier (60-730 days):** Older posts receive fewer searches. Shrunk to single shard, force-merged for read optimization, moved to cheaper storage.
- **Cold tier (730-1825 days):** Rarely searched archival data. Frozen indexes use minimal resources while remaining searchable.
- **Delete (>5 years):** Data beyond retention period removed to control costs.

**Trade-off:** Aggressive retention (e.g., 30-day hot) saves storage but degrades search experience for users looking for older content. The 60-day hot tier was chosen based on analysis showing 90%+ of searches target content less than 2 months old.

**Configuration:** See `backend/src/shared/retention.ts` and `backend/src/shared/alertThresholds.ts` for retention constants.

### Cache Hit Metrics: Enabling Performance Optimization

**Why:** Cache hit rate is the primary indicator of cache effectiveness and directly impacts search latency and database load.

**Implementation:**
- **Visibility cache:** Tracks hits/misses for user visibility sets. Target: >90% hit rate.
- **Suggestions cache:** Tracks typeahead cache effectiveness. Target: >85% hit rate.
- **Prometheus metrics:** `cache_hits_total` and `cache_misses_total` counters with `cache_type` labels.

**How to use:**
```promql
# Calculate cache hit rate over 5 minutes
rate(cache_hits_total{cache_type="visibility"}[5m]) /
(rate(cache_hits_total{cache_type="visibility"}[5m]) +
 rate(cache_misses_total{cache_type="visibility"}[5m]))
```

**Optimization actions:**
- Hit rate <80%: Increase TTL or cache size
- Hit rate >95%: TTL may be too long (stale data risk) or cache is oversized

**Configuration:** See `backend/src/shared/metrics.ts` for metric definitions.

### Circuit Breakers: Protecting Search Availability

**Why:** When Elasticsearch becomes unhealthy (overloaded, network issues, cluster problems), continuing to send requests causes:
1. Thread pool exhaustion in the application
2. Cascading failures to other services
3. Poor user experience with timeout errors

**Implementation:**
- **Consecutive breaker:** Opens after 5 consecutive failures
- **Half-open after 30s:** Allows test requests to check recovery
- **Timeout:** 5s per request before counting as failure
- **Metrics:** Circuit state transitions tracked for alerting

**States:**
- **Closed:** Normal operation, requests pass through
- **Open:** Fast-fail mode, requests rejected immediately with helpful error
- **Half-open:** Testing mode, limited requests allowed to probe recovery

**Graceful degradation:** When circuit is open, search returns error but:
- Suggestions can fall back to trending searches (Redis-only)
- Health check shows degraded status
- Load balancer can route traffic away

**Configuration:** See `backend/src/shared/circuitBreaker.ts` and thresholds in `alertThresholds.ts`.

### Index Lag Alerts: Enabling Freshness Monitoring

**Why:** Search freshness is a key user experience metric. Users expect new posts to be searchable immediately.

**Implementation:**
- **Lag histogram:** Measures time from `post.created_at` to index completion
- **Buckets:** 0.1s, 0.5s, 1s, 2s, 5s, 10s, 30s, 60s for p95/p99 calculation
- **Alerting thresholds:**
  - Warning: p99 > 5s
  - Critical: p99 > 30s

**How to monitor:**
```promql
# p99 indexing lag over 5 minutes
histogram_quantile(0.99, rate(indexing_lag_seconds_bucket[5m]))
```

**Root causes to investigate:**
- High lag: Elasticsearch cluster overloaded, network latency, bulk indexing backlog
- Kafka consumer lag (if event-driven): Consumer processing too slow, need more partitions/consumers

**Configuration:** See `backend/src/shared/metrics.ts` for histogram and `alertThresholds.ts` for thresholds.

### Prometheus Metrics Summary

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `search_queries_total` | Counter | status, has_user | Track search volume and error rate |
| `search_latency_seconds` | Histogram | status | SLA monitoring (p50, p95, p99) |
| `cache_hits_total` | Counter | cache_type | Cache effectiveness |
| `cache_misses_total` | Counter | cache_type | Cache effectiveness |
| `indexing_lag_seconds` | Histogram | - | Search freshness monitoring |
| `posts_indexed_total` | Counter | operation | Index write volume |
| `circuit_breaker_state` | Gauge | service | Resilience monitoring |
| `http_requests_total` | Counter | method, path, status_code | API traffic analysis |
| `http_request_duration_seconds` | Histogram | method, path | Endpoint latency |

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /metrics` | Prometheus metrics (Prometheus text format) |
| `GET /health` | Comprehensive health check (JSON) |
| `GET /livez` | Kubernetes liveness probe |
| `GET /readyz` | Kubernetes readiness probe |

## Frontend Architecture

The frontend follows a component-based architecture using React 19 with TypeScript, TanStack Router for navigation, and Zustand for state management.

### Directory Structure

```
frontend/src/
├── components/           # Reusable UI components
│   ├── admin/           # Admin dashboard components
│   │   ├── index.ts     # Barrel export
│   │   ├── AdminTabs.tsx
│   │   ├── HealthStatusBar.tsx
│   │   ├── OverviewTab.tsx
│   │   ├── PostsTable.tsx
│   │   ├── SearchHistoryTable.tsx
│   │   ├── StatCard.tsx
│   │   └── UsersTable.tsx
│   ├── Header.tsx       # Application header
│   ├── SearchBar.tsx    # Search input with typeahead
│   ├── SearchFilters.tsx
│   ├── SearchResultCard.tsx
│   └── SearchResults.tsx
├── routes/              # TanStack Router file-based routes
│   ├── __root.tsx       # Root layout
│   ├── index.tsx        # Home/search page
│   ├── admin.tsx        # Admin dashboard (orchestrator)
│   ├── login.tsx
│   └── register.tsx
├── services/            # API client layer
│   └── api.ts           # Backend API calls
├── stores/              # Zustand state stores
│   └── authStore.ts     # Authentication state
├── types/               # TypeScript type definitions
│   └── index.ts         # Shared types
└── main.tsx             # Application entry point
```

### Component Design Principles

1. **Single Responsibility**: Each component handles one concern
2. **Composition over Inheritance**: Complex UIs built from smaller components
3. **Props Down, Events Up**: Data flows down, actions bubble up via callbacks
4. **JSDoc Documentation**: All exported components have JSDoc comments

### Admin Dashboard Components

The admin dashboard (`/admin` route) is decomposed into focused sub-components:

| Component | Lines | Responsibility |
|-----------|-------|----------------|
| `admin.tsx` | ~180 | Route orchestration, state management, data loading |
| `AdminTabs.tsx` | ~65 | Tab navigation with icons |
| `HealthStatusBar.tsx` | ~90 | Service health indicators, reindex button |
| `OverviewTab.tsx` | ~105 | Statistics cards and breakdown panels |
| `UsersTable.tsx` | ~80 | User list with role badges |
| `PostsTable.tsx` | ~75 | Posts list with visibility/type badges |
| `SearchHistoryTable.tsx` | ~70 | Search query history |
| `StatCard.tsx` | ~60 | Reusable metric card |

### Component Communication

```
AdminPage (Route Component)
    │
    ├── HealthStatusBar
    │     └── onReindex callback → parent handles API call
    │
    ├── AdminTabs
    │     └── onTabChange callback → parent updates activeTab state
    │
    └── Tab Content (conditional render)
          ├── OverviewTab (receives stats prop)
          ├── UsersTable (receives users prop)
          ├── PostsTable (receives posts prop)
          └── SearchHistoryTable (receives history prop)
```

### State Management

- **Local State**: Component-specific UI state (active tab, loading flags)
- **Zustand Store**: Authentication state (`authStore`)
- **Server State**: Data fetched from API, stored in component state

### Styling

- Tailwind CSS for utility-first styling
- Consistent color scheme with `primary-*` palette
- Responsive grid layouts (1-4 columns based on viewport)

## Future Optimizations

1. **Bloom Filters**: Compact visibility set representation
2. **Two-Tier Indexing**: Hot (memory) / Cold (disk) separation
3. **ML Ranking**: Gradient boosted trees for personalization
4. **Query Caching**: Cache popular search results
5. **Federated Search**: Merge results from multiple data centers
6. **Content Moderation**: Flag and filter inappropriate content in search

# Design LinkedIn - Architecture

## System Overview

LinkedIn is a professional social network where users build career profiles, connect with colleagues, and discover job opportunities. Core challenges involve graph traversal for connection degrees, multi-factor recommendation algorithms (PYMK, job matching), and feed ranking with professional context.

**Learning Goals:**
- Design efficient social graph storage and traversal
- Build recommendation engines (PYMK, job matching)
- Implement feed ranking with multiple signals
- Handle company-employee relationships

---

## Requirements

### Functional Requirements

1. **Profiles**: Professional history (experience, education, skills)
2. **Connections**: Request, accept, view 1st/2nd/3rd degree network
3. **Feed**: Posts from connections, ranked by relevance and engagement
4. **Jobs**: Post listings, apply, match candidates to jobs
5. **Search**: Find people, companies, jobs with relevance ranking
6. **Recommendations**: People You May Know (PYMK) with multi-signal scoring

### Non-Functional Requirements

- **Latency**: < 200ms for feed, < 500ms for PYMK computation
- **Scale**: 900M users, 100B connections
- **Availability**: 99.9% uptime
- **Consistency**: Eventual for feed and PYMK, strong for connection state

---

## Capacity Estimation

### Production Scale

- **Users**: 900M total, 300M MAU, 100M DAU
- **Connections**: 100B total, 500 average connections per active user
- **Posts**: 5M new posts/day (~58/sec)
- **Feed reads**: 100M DAU * 15 feed views/day = 1.5B feed requests/day (~17,400 QPS)
- **PYMK requests**: 100M DAU * 2 views/day = 200M/day (~2,300 QPS)
- **Job postings**: 20M active listings, 1M new/day
- **Search queries**: 50M/day (~580 QPS)
- **Connection graph**: 900M nodes, 100B edges, ~200 GB in adjacency list format

### Local Development Scale

- 2-5 concurrent users, ~50 connections, ~20 posts
- Single PostgreSQL instance, single Valkey instance
- Single Elasticsearch instance, single RabbitMQ instance
- All services run as a single Express process

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Clients                                     │
│                    (Web / Mobile / LinkedIn Apps)                         │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                     ┌─────────▼─────────┐
                     │   API Gateway /   │
                     │   Load Balancer   │
                     └─────────┬─────────┘
                               │
       ┌──────────────────┬────┼────┬──────────────────┐
       │                  │         │                   │
┌──────▼──────┐  ┌────────▼───┐ ┌───▼──────────┐ ┌─────▼───────┐
│  Profile    │  │ Connection │ │ Feed         │ │ Job         │
│  Service    │  │ Service    │ │ Service      │ │ Service     │
│             │  │            │ │              │ │             │
│ - CRUD      │  │ - Requests │ │ - Ranking    │ │ - Listings  │
│ - Skills    │  │ - PYMK     │ │ - Posts      │ │ - Matching  │
│ - Experience│  │ - Degrees  │ │ - Comments   │ │ - Apply     │
└──────┬──────┘  └─────┬──────┘ └──────┬───────┘ └──────┬──────┘
       │               │               │                │
       └───────┬───────┴───────┬───────┴────────┬───────┘
               │               │                │
┌──────────────▼──┐  ┌────────▼────────┐  ┌────▼──────────────┐
│   PostgreSQL    │  │  Valkey/Redis   │  │  Elasticsearch    │
│  (Users, Conns, │  │  (Sessions,     │  │  (Users, Jobs     │
│   Posts, Jobs)  │  │   PYMK cache,   │  │   full-text       │
│                 │  │   Feed cache,   │  │   search)         │
│                 │  │   Rate limits)  │  │                   │
└─────────────────┘  └────────────────┘  └───────────────────┘
               │
     ┌─────────▼─────────┐
     │    RabbitMQ        │
     │  (Feed fanout,     │
     │   Notifications,   │
     │   PYMK compute,    │
     │   Search index)    │
     └────────────────────┘
```

At production scale, the architecture would add:
- **Graph database** (e.g., LinkedIn's in-house LIquid) for connection traversal at billions of edges
- **Kafka** for event streaming between services
- **Dedicated PYMK service** with precomputed recommendations
- **CDN** for profile images and static assets
- **ML pipeline** for feed ranking, job matching, and recommendation quality

---

## Core Components

### 1. Connection Degree Calculation

**Challenge**: With 900M users and 100B connections, finding 2nd-degree connections (friends-of-friends) is a graph traversal problem that can explode in complexity.

**Approaches**:

| Approach | Latency | Storage | Freshness |
|----------|---------|---------|-----------|
| Real-time graph traversal | O(connections^2) | None extra | Real-time |
| Precomputed 2nd-degree cache | O(1) lookup | Massive (per-user lists) | Stale (nightly refresh) |
| Hybrid: cached 1st-degree, compute 2nd on demand | O(connections) | Moderate | 1-hour cache |

**Chosen: Hybrid approach**. First-degree connections are cached in Valkey for 1 hour. Second-degree connections are computed on demand by intersecting first-degree lists. This works because the median LinkedIn user has ~500 connections, making the intersection manageable (~250K comparisons worst case).

**Why real-time traversal fails at scale**: A user with 500 connections, each with 500 connections, produces 250,000 candidate 2nd-degree connections. Adding 3rd-degree multiplies again to 125M candidates. Without caching, every profile view triggers this computation.

**Why full precomputation fails**: Storing every user's 2nd-degree list requires O(users * avg_2nd_degree) storage. With 900M users averaging 50K 2nd-degree connections, that is 45 trillion entries. Even with compact encoding, this exceeds practical storage limits.

### 2. PYMK Algorithm (People You May Know)

Multi-signal scoring combines graph proximity with professional similarity:

| Signal | Weight | Rationale |
|--------|--------|-----------|
| Mutual connections | 10 points each | Strongest predictor of real-world relationship |
| Same current company | 8 points | Colleagues often connect |
| Same past company | 5 points | Alumni networks |
| Same school | 5 points | Educational ties |
| Shared skills | 2 points each | Professional affinity |
| Same location | 2 points | Geographic proximity |

The algorithm operates on 2nd-degree connections only (already connected users are excluded). Results are cached for 24 hours because the inputs (connections, experience, skills) change infrequently.

**Why not collaborative filtering?** PYMK is not a content recommendation problem. It predicts real-world relationships, where explicit graph signals (mutual friends, shared employer) outperform latent factor models. LinkedIn's published research confirms that mutual connections alone account for >60% of successful connection predictions.

### 3. Feed Ranking

The feed uses a multi-factor scoring formula computed in SQL:

```
rank_score = (engagement_score * 0.3) + (recency_score * 0.5) + (relationship_boost)

engagement_score = like_count + (comment_count * 2)
recency_score = max(0, 100 - hours_since_posted)
relationship_boost = 20 if author is the viewing user, else 0
```

**Why comments are weighted 2x likes**: A comment represents higher engagement intent than a like. Professional content that generates discussion (comments) is more valuable to the network than content that receives passive approval (likes).

**Why recency dominates at 50%**: LinkedIn is a professional network where timely information matters. A job announcement from yesterday is more relevant than a thought leadership post from last week, even if the old post has more engagement. The linear decay (not exponential) ensures that high-engagement posts remain visible for ~4 days before falling off.

**Feed cache invalidation**: When a user creates a post, the feed caches for their first 50 connections are explicitly deleted. This ensures direct connections see new content immediately. Beyond 50 connections, the TTL-based cache (not yet implemented) handles eventual consistency.

### 4. Job-Candidate Matching

Job matching scores candidates against job requirements across multiple dimensions:

| Dimension | Score Calculation |
|-----------|-------------------|
| Skills match | (matched_required / total_required * 60) + (matched_optional * 5) |
| Experience level | 20 points if experience years >= required years |
| Location | 15 points if job location matches candidate location |
| Remote preference | 10 points if job is remote and candidate is remote-friendly |

The matching score (0-100) is stored on the `job_applications` table as `match_score` for sorting and filtering.

---

## Database Schema

### Complete Table Definitions

#### 1. companies

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Company identifier |
| name | VARCHAR(255) | NOT NULL | Company name |
| slug | VARCHAR(255) | UNIQUE, NOT NULL | URL-friendly identifier |
| description | TEXT | | Company description |
| industry | VARCHAR(100) | | Industry sector |
| size | VARCHAR(50) | | Employee count range |
| location | VARCHAR(100) | | Headquarters location |
| website | VARCHAR(255) | | Company website URL |
| logo_url | VARCHAR(500) | | Company logo URL |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation timestamp |

#### 2. users

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | User identifier |
| email | VARCHAR(255) | UNIQUE, NOT NULL | Login email |
| password_hash | VARCHAR(255) | NOT NULL | bcrypt hashed password |
| first_name | VARCHAR(100) | NOT NULL | First name |
| last_name | VARCHAR(100) | NOT NULL | Last name |
| headline | VARCHAR(200) | | Professional tagline |
| summary | TEXT | | About section |
| location | VARCHAR(100) | | Current location |
| industry | VARCHAR(100) | | Primary industry |
| profile_image_url | VARCHAR(500) | | Profile photo |
| banner_image_url | VARCHAR(500) | | Profile banner |
| connection_count | INTEGER | DEFAULT 0 | Denormalized 1st-degree count |
| role | VARCHAR(20) | DEFAULT 'user' | user, recruiter, admin |
| created_at | TIMESTAMP | DEFAULT NOW() | Account creation |

**Design rationale**: `connection_count` is denormalized because it appears on every profile view, connection card, and PYMK suggestion. Computing it from the connections table on every render would be expensive at scale.

#### 3. skills (normalized)

**skills** table:

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Skill identifier |
| name | VARCHAR(100) | UNIQUE, NOT NULL | Skill name (e.g., "Python") |

**user_skills** junction table:

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| user_id | INTEGER | FK -> users ON DELETE CASCADE | User |
| skill_id | INTEGER | FK -> skills ON DELETE CASCADE | Skill |
| endorsement_count | INTEGER | DEFAULT 0 | Endorsement count |
| | | PRIMARY KEY (user_id, skill_id) | |

**Design rationale**: Normalized skills (separate table with IDs) enable consistent PYMK matching. Without normalization, "JavaScript" vs "Javascript" vs "JS" would be treated as different skills.

#### 4. experiences

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Experience identifier |
| user_id | INTEGER | FK -> users ON DELETE CASCADE | User |
| company_id | INTEGER | FK -> companies ON DELETE SET NULL | Company reference |
| company_name | VARCHAR(255) | NOT NULL | Denormalized for display |
| title | VARCHAR(200) | NOT NULL | Job title |
| location | VARCHAR(100) | | Work location |
| start_date | DATE | NOT NULL | Start date |
| end_date | DATE | | End date (NULL = current) |
| description | TEXT | | Role description |
| is_current | BOOLEAN | DEFAULT FALSE | Current position flag |

#### 5. education

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Education identifier |
| user_id | INTEGER | FK -> users ON DELETE CASCADE | User |
| school_name | VARCHAR(255) | NOT NULL | Institution name |
| degree | VARCHAR(100) | | Degree type |
| field_of_study | VARCHAR(100) | | Major/field |
| start_year | INTEGER | | Start year |
| end_year | INTEGER | | End year |
| description | TEXT | | Additional details |

#### 6. connections (Social Graph)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| user_id | INTEGER | FK -> users ON DELETE CASCADE | Smaller user ID |
| connected_to | INTEGER | FK -> users ON DELETE CASCADE | Larger user ID |
| connected_at | TIMESTAMP | DEFAULT NOW() | Connection established |
| | | PRIMARY KEY (user_id, connected_to) | |
| | | CHECK (user_id < connected_to) | Canonical ordering |

**Design rationale**: Storing connections with `user_id < connected_to` halves storage and eliminates duplicate records. A connection between users 5 and 12 is always stored as `(5, 12)`, never `(12, 5)`. Queries use `WHERE user_id = ? OR connected_to = ?` to find all connections for either user.

#### 7. connection_requests

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Request identifier |
| from_user_id | INTEGER | FK -> users ON DELETE CASCADE | Sender |
| to_user_id | INTEGER | FK -> users ON DELETE CASCADE | Recipient |
| message | TEXT | | Personalized invitation |
| status | VARCHAR(20) | DEFAULT 'pending' | pending, accepted, declined, withdrawn |
| created_at | TIMESTAMP | DEFAULT NOW() | Request sent time |
| | | UNIQUE(from_user_id, to_user_id) | One request per pair |

#### 8. posts

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Post identifier |
| user_id | INTEGER | FK -> users ON DELETE CASCADE | Author |
| content | TEXT | NOT NULL | Post text |
| image_url | VARCHAR(500) | | Attached image |
| like_count | INTEGER | DEFAULT 0 | Denormalized like count |
| comment_count | INTEGER | DEFAULT 0 | Denormalized comment count |
| share_count | INTEGER | DEFAULT 0 | Denormalized share count |
| created_at | TIMESTAMP | DEFAULT NOW() | Post creation time |

**Indexes**: `(user_id)`, `(created_at DESC)`.

#### 9. post_likes / post_comments

**post_likes**: `PRIMARY KEY (user_id, post_id)` prevents duplicate likes.

**post_comments**: Standard comment table with `post_id` FK and `user_id` FK. Flat structure (no threading) since LinkedIn comments are rarely deeply nested.

#### 10. jobs

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Job identifier |
| company_id | INTEGER | FK -> companies ON DELETE CASCADE | Hiring company |
| posted_by_user_id | INTEGER | FK -> users ON DELETE SET NULL | Recruiter who posted |
| title | VARCHAR(200) | NOT NULL | Job title |
| description | TEXT | NOT NULL | Full description |
| location | VARCHAR(100) | | Job location |
| is_remote | BOOLEAN | DEFAULT FALSE | Remote work flag |
| employment_type | VARCHAR(50) | | full-time, part-time, contract, internship |
| experience_level | VARCHAR(50) | | entry, associate, mid-senior, director, executive |
| years_required | INTEGER | | Minimum years of experience |
| salary_min | INTEGER | | Salary range minimum |
| salary_max | INTEGER | | Salary range maximum |
| status | VARCHAR(20) | DEFAULT 'active' | active, closed, filled, draft |

**job_skills**: Many-to-many junction with `is_required` flag (required vs nice-to-have).

**job_applications**: `UNIQUE(job_id, user_id)` prevents duplicate applications. Includes `match_score` (0-100) for candidate ranking.

#### 11. audit_logs

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Log identifier |
| event_type | VARCHAR(100) | NOT NULL | Event category |
| actor_id | INTEGER | FK -> users ON DELETE SET NULL | Acting user |
| actor_ip | INET | | Client IP |
| target_type | VARCHAR(50) | | Entity type |
| target_id | INTEGER | | Entity ID |
| action | VARCHAR(50) | NOT NULL | Action description |
| details | JSONB | DEFAULT '{}' | Event-specific data |
| created_at | TIMESTAMP | DEFAULT NOW() | Event time |

**Indexes**: `(actor_id, created_at)`, `(target_type, target_id, created_at)`, `(event_type, created_at)`, `(created_at)`, partial index for admin actions.

---

## API Design

```
# Authentication
POST   /api/auth/register           - Create account
POST   /api/auth/login              - Login
POST   /api/auth/logout             - Logout
GET    /api/auth/me                 - Get current user

# Users / Profiles
GET    /api/users/:id               - Get full profile
PUT    /api/users/:id               - Update profile
GET    /api/users/:id/experience    - Get work history
POST   /api/users/:id/experience    - Add experience
GET    /api/users/:id/education     - Get education
POST   /api/users/:id/education     - Add education
GET    /api/users/:id/skills        - Get skills with endorsements
POST   /api/users/:id/skills        - Add skill
POST   /api/users/:id/skills/:skillId/endorse - Endorse a skill
GET    /api/users/search?q=         - Search users (Elasticsearch)

# Connections
POST   /api/connections/request     - Send connection request
POST   /api/connections/:id/accept  - Accept request
POST   /api/connections/:id/reject  - Reject request
DELETE /api/connections/:id         - Remove connection
GET    /api/connections             - List connections
GET    /api/connections/pending     - Pending requests
GET    /api/connections/mutual/:userId - Mutual connections
GET    /api/connections/degree/:userId - Connection degree (1st/2nd/3rd)
GET    /api/connections/pymk        - People You May Know

# Feed
GET    /api/feed                    - Personalized feed
POST   /api/feed/posts              - Create post
POST   /api/feed/posts/:id/like     - Like post
DELETE /api/feed/posts/:id/like     - Unlike post
POST   /api/feed/posts/:id/comments - Add comment
GET    /api/feed/posts/:id/comments - Get comments

# Jobs
GET    /api/jobs                    - List jobs with filters
GET    /api/jobs/:id                - Get job details
POST   /api/jobs                    - Create job posting
POST   /api/jobs/:id/apply          - Apply to job
GET    /api/jobs/:id/applicants     - Get applicants with match scores
GET    /api/jobs/search?q=          - Search jobs (Elasticsearch)
```

---

## Key Design Decisions

### 1. Canonical Connection Storage (user_id < connected_to)

**Chosen**: Store each connection once with smaller ID first, constrained by `CHECK (user_id < connected_to)`.

**Why this works**: A connection between users 5 and 12 is always row `(5, 12)`. To check if two users are connected, the application normalizes the pair before querying. This halves the storage (one row per connection, not two) and eliminates the ambiguity of "which direction was it stored."

**What breaks with bidirectional storage**: Storing both `(5, 12)` and `(12, 5)` doubles the connections table. At 100B connections, that is 200B rows. Worse, every connection mutation requires two writes and consistency between them. If one write succeeds and the other fails, the graph becomes asymmetric.

**What we give up**: Queries are slightly more complex. Instead of `WHERE user_id = ?`, we need `WHERE user_id = ? OR connected_to = ?`. But this is a negligible query planning cost compared to the storage and consistency benefits.

### 2. Pull Model for Feed (Not Fanout-on-Write)

**Chosen**: Feed is computed on demand by querying posts from the user's connections.

**Why pull model works for LinkedIn**: The median LinkedIn user has ~500 connections and checks their feed 2-3 times/day. Pull model computes the feed at read time: fetch connections from cache, query posts from those users, rank them. At 500 connections, this is a single `WHERE user_id = ANY(array_of_500_ids) ORDER BY rank_score DESC LIMIT 20` query, which PostgreSQL handles in <50ms with proper indexes.

**What breaks with fanout-on-write**: When a user creates a post, fanout-on-write copies it to every follower's feed timeline. A LinkedIn influencer with 10M followers would require 10M write operations per post. With 5M posts/day and an average of 500 connections, fanout generates 2.5B write operations/day just for feed maintenance. This is operationally expensive and introduces write amplification.

**What we give up**: Feed latency is higher than pre-materialized feeds. A pull model requires a database query per feed request, while fanout serves from a pre-built list. For LinkedIn's usage pattern (professional network, not real-time messaging), sub-200ms query latency is sufficient.

### 3. Elasticsearch for User and Job Search

**Chosen**: Elasticsearch with fuzzy matching and field boosting for user and job discovery.

**Why Elasticsearch over PostgreSQL full-text**: LinkedIn search requires fuzzy matching (finding "Jhon" when searching "John"), multi-field search with different weights (name boosted 2x, skills boosted 2x for jobs), and faceted filtering (by location, remote, experience level). PostgreSQL `tsvector` supports full-text search but lacks native fuzzy matching and sophisticated relevance tuning.

**What we give up**: An additional infrastructure dependency. Elasticsearch requires index synchronization, which introduces eventual consistency between the database and search results. A newly registered user may not appear in search for a few seconds.

---

## Consistency and Idempotency

### Connection Request Idempotency

Connection requests check for existing connections and pending requests before creating. The `UNIQUE(from_user_id, to_user_id)` constraint prevents database-level duplicates. Accepting a connection uses `INSERT ... ON CONFLICT DO NOTHING` when creating the connection row.

### Like Idempotency

`INSERT INTO post_likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING` makes likes naturally idempotent. The `like_count` is updated by counting actual rows rather than incrementing, preventing over-counting from duplicate requests:
```sql
UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1) WHERE id = $1
```

### Message Idempotency (RabbitMQ)

Every queue message carries an `idempotencyKey` (UUID). Before processing, the consumer checks Redis for `processed:{key}`. If found, the message is acknowledged without re-processing. After successful processing, the key is stored in Redis with a 24-hour TTL. Failed messages are rejected to a dead letter queue (not requeued) to prevent infinite retry loops.

### Feed Cache Invalidation

When a user creates a post, feed caches for their first 50 connections are explicitly deleted (`cacheDel('feed:${connId}')`). This ensures high-value connections see fresh content immediately. The 50-connection limit prevents cache stampedes when popular users post.

---

## Security / Auth

- **Session-based auth** with express-session (in-memory store in development, Redis in production)
- **bcryptjs** password hashing
- **Rate limiting** via Redis token bucket algorithm (`src/utils/rateLimiter.ts`):
  - Public endpoints (login/register): 10 requests/minute
  - Read operations: 100 requests/minute
  - Write operations: 30 requests/minute
  - Connection requests: 20 requests/minute (anti-spam)
  - Search: 20 requests/minute
- **Trace ID propagation**: `X-Trace-Id` header on every request/response for distributed tracing
- **CORS**: Restricted to frontend origin
- **Cookie security**: HttpOnly, SameSite=strict, secure in production

---

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `http_requests_total` | Counter | Request count by method/path/status |
| `http_request_duration_seconds` | Histogram | API latency by method/path |
| `connections_created_total` | Counter | New connections rate |
| `connections_removed_total` | Counter | Connection removal rate |
| `connection_requests_total` | Counter | Connection request rate |
| `posts_created_total` | Counter | Post creation rate |
| `post_likes_total` | Counter | Like rate |
| `post_comments_total` | Counter | Comment rate |
| `profile_views_total` | Counter | Profile view rate |
| `search_queries_total` | Counter | Search query rate by type |
| `pymk_computation_duration_seconds` | Histogram | PYMK algorithm performance |
| `feed_generation_duration_seconds` | Histogram | Feed query time |
| `queue_depth` | Gauge | RabbitMQ queue depth by queue |
| `queue_processing_duration_seconds` | Histogram | Message processing time |
| `db_query_duration_seconds` | Histogram | Database query time by type |
| `cache_hits_total` / `cache_misses_total` | Counter | Cache effectiveness |
| `rate_limit_hits_total` | Counter | Rate limit violations by category |
| `login_attempts_total` | Counter | Login attempts (success/failure) |
| `active_sessions` | Gauge | Current active sessions |

### Health Checks

- `GET /health` - Detailed status with PostgreSQL, Valkey, and RabbitMQ checks with latency
- `GET /health/live` - Liveness probe
- `GET /health/ready` - Readiness probe (database + Redis)
- `GET /metrics` - Prometheus scrape endpoint

### Structured Logging

Pino logger with JSON output. Trace IDs (`X-Trace-Id`) propagated through request lifecycle. Request duration, user ID, and status code logged for every request.

---

## Failure Handling

- **RabbitMQ unavailability**: Server starts even if RabbitMQ is unavailable (logged as warning). Async features (notifications, search indexing) are disabled but core API remains functional
- **Dead letter queues**: Every RabbitMQ queue has a DLQ. Failed messages are rejected without requeue (`nack(msg, false, false)`) and routed to the DLQ for manual inspection
- **Rate limiter fail-open**: If Redis is down, rate limiting allows all requests rather than blocking. This trades abuse protection for availability
- **PYMK degradation**: If PYMK computation fails (e.g., database timeout), return empty recommendations rather than error. The cache ensures most requests are served from pre-computed results
- **Graceful shutdown**: SIGTERM/SIGINT handlers close RabbitMQ channel/connection, drain database pool, disconnect Redis

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless (sessions in Redis), scale behind load balancer. Multiple instances on ports 3001-3003 supported
2. **Connection graph**: At 100B connections, PostgreSQL struggles. Production LinkedIn uses an in-house graph store. For medium scale, connection queries can use read replicas and aggressive caching
3. **PYMK computation**: Move to dedicated workers consuming from RabbitMQ. Batch-compute recommendations nightly for all users, store in Redis. On-demand computation for recently changed networks
4. **Feed generation**: Introduce hybrid push/pull: fanout for users with <1000 connections, pull for power users. Pre-materialize feeds in Redis sorted sets
5. **Search**: Elasticsearch cluster with sharding by index type (users, jobs). Dedicated indexing pipeline consuming from RabbitMQ
6. **Database**: Vertical scaling then read replicas for read-heavy queries (profiles, feeds). Shard users table by user_id hash for horizontal scaling

### Sharding Strategy (Future)

- **Users/profiles**: Shard by user_id hash
- **Connections**: Shard by smaller user_id (connections are co-located with at least one user)
- **Posts**: Shard by user_id (author's posts co-located)
- **Jobs**: Shard by company_id (company's jobs co-located)

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Connection storage | Canonical (id < id) | Bidirectional rows | Half storage, no inconsistency risk |
| Feed strategy | Pull + cache | Push (fanout-on-write) | Simpler, sufficient for professional network usage pattern |
| Search | Elasticsearch | PostgreSQL full-text | Fuzzy matching, field boosting, faceted filters |
| Graph traversal | SQL + cache | Graph database (Neo4j) | Simpler operations, sufficient for 2-degree queries |
| Session storage | In-memory / Redis | JWT | Immediate revocation, simpler state management |
| PYMK caching | 24-hour Redis cache | Real-time computation | Inputs change slowly, computation is expensive |
| Message queue | RabbitMQ | Kafka | Simpler for job-based processing, sufficient throughput |
| Rate limiting | Redis token bucket | In-memory | Distributed rate limiting across API instances |

---

## Implementation Notes

### Local Architecture

```
┌───────────────────┐     ┌───────────────────────────┐
│   React Frontend  │────▶│   Express API Server      │
│   localhost:5173   │     │   localhost:3000           │
└───────────────────┘     │                           │
                          │  Routes:                  │
                          │  /api/auth/*              │
                          │  /api/users/*             │
                          │  /api/connections/*       │
                          │  /api/feed/*              │
                          │  /api/jobs/*              │
                          │                           │
                          │  /health, /metrics        │
                          └──┬────┬────┬────┬─────────┘
                             │    │    │    │
              ┌──────────────▼┐ ┌─▼────▼──┐ │
              │ PostgreSQL    │ │ Valkey   │ │
              │ :5432         │ │ :6379    │ │
              │ linkedin/     │ │ sessions │ │
              │ linkedin_pwd  │ │ PYMK     │ │
              └───────────────┘ │ feed     │ │
                                │ rate lim │ │
                                └──────────┘ │
                    ┌────────────────────────▼┐
                    │     Elasticsearch       │
                    │     :9200               │
                    │     users, jobs indices  │
                    └─────────────────────────┘
                    ┌─────────────────────────┐
                    │     RabbitMQ            │
                    │     :5672 (AMQP)        │
                    │     :15672 (Mgmt UI)    │
                    │     feed.fanout         │
                    │     notifications       │
                    │     pymk.compute        │
                    │     search.index        │
                    │     profile.update      │
                    └─────────────────────────┘
```

### Production-Grade Patterns Implemented

1. **Prometheus metrics** (`src/utils/metrics.ts`): 20+ custom metrics covering HTTP requests, business events (connections, posts, likes), PYMK computation time, feed generation time, queue depth, cache hits/misses, rate limit violations, and login attempts. Default Node.js metrics (CPU, memory, event loop) included.

2. **Structured logging** (`src/utils/logger.ts`): Pino with JSON output. Trace ID propagation via `X-Trace-Id` header for request correlation across services.

3. **Rate limiting** (`src/utils/rateLimiter.ts`): Redis-backed token bucket algorithm with Lua scripting for atomic operations. Six categories with different limits (public, read, write, connection requests, search, admin). Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) on responses. Fail-open design if Redis is unavailable.

4. **RabbitMQ message infrastructure** (`src/utils/rabbitmq.ts`): Five queues with dead letter configuration (feed fanout, notifications, PYMK compute, search index, profile update). Three exchange types (direct, fanout, topic). Message idempotency via Redis-tracked processing keys. Prefetch limit of 10 for backpressure.

5. **Elasticsearch integration** (`src/utils/elasticsearch.ts`): Automatic index creation at startup with optimized mappings. User search with name boosting (2x) and fuzzy matching. Job search with title boosting (3x), skill boosting (2x), and faceted filters.

6. **PYMK algorithm** (`src/services/connectionService.ts`): Multi-factor scoring (mutual connections, same company, same school, shared skills, same location). Results cached in Valkey for 24 hours. Candidate limit of 100 for performance.

7. **Feed ranking** (`src/services/feedService.ts`): SQL-based multi-factor ranking combining engagement (30%), recency (50%), and relationship boost. Cache invalidation on post creation for first 50 connections.

8. **Health checks** (`src/index.ts`): Detailed health endpoint checking PostgreSQL, Valkey, and RabbitMQ. Separate liveness and readiness probes. Graceful shutdown with resource cleanup.

9. **Audit logging** (database-backed): Security event tracking for login attempts, profile changes, connection events, and administrative actions.

### What Was Simplified

| Production Design | Local Implementation |
|-------------------|---------------------|
| Graph database for connections | PostgreSQL with SQL joins and caching |
| Kafka event streaming | RabbitMQ with direct queue publishing |
| Distributed session store (Redis) | In-memory express-session store |
| ML-based feed ranking | SQL formula with fixed weights |
| Precomputed PYMK (nightly batch) | On-demand computation with 24-hour cache |
| CDN for profile images | Direct URL references |
| OAuth/SSO/2FA | Session-based auth with bcrypt |
| Separate microservices | Single Express process with route modules |

### What Was Omitted

- CDN and multi-region deployment
- Kubernetes orchestration
- Database sharding and read replicas
- ML pipeline for feed ranking and job matching
- Real-time notifications (WebSocket/SSE)
- Email notification system
- Profile image upload and processing
- Company pages with admin management
- Messaging/InMail system
- Content moderation and spam detection
- A/B testing framework
- Skills assessment and certification

---

## Frontend Architecture

### Component Hierarchy

```
__root (RootComponent)
├── Navbar                          # Top navigation with search, nav links, profile
├── Outlet (route-specific content)
│   ├── / (HomePage)                # 3-column layout: profile card | feed | PYMK
│   │   ├── Profile Card (sidebar)  # Mini profile with avatar, headline, connections link
│   │   ├── Post Composer           # Inline post creation with action buttons
│   │   ├── PostCard[]              # Feed posts with like/comment/share actions
│   │   │   └── Comments section    # Expandable, lazy-loaded on demand
│   │   └── PYMK sidebar           # People You May Know suggestions
│   ├── /network                    # Connection management with 3 tabs
│   │   ├── Connections tab         # Grid of ConnectionCard components
│   │   ├── Requests tab            # Pending requests with accept/reject
│   │   └── PYMK tab               # Grid of ConnectionCard with match reasons
│   ├── /profile/$userId            # Full professional profile
│   │   ├── ProfileHeader           # Banner, avatar, name, connection actions
│   │   ├── EditProfileModal        # Modal form for editing profile fields
│   │   ├── ProfileAbout            # Summary/about section
│   │   ├── ExperienceSection       # Work history with company info
│   │   ├── EducationSection        # Education history
│   │   ├── SkillsSection           # Skills with endorsement counts
│   │   └── ActivitySection         # Recent posts
│   ├── /jobs                       # 2-column: sidebar nav | job listings
│   │   ├── Search form + filters   # Keyword, location, remote, type, level
│   │   ├── JobCard[]               # Job listings with match scores
│   │   └── Recommended tab         # Jobs matched to user profile
│   ├── /jobs/$jobId                # Job detail page
│   ├── /search                     # User search results
│   ├── /login                      # Login form
│   └── /register                   # Registration form
```

### Zustand Stores

**`useAuthStore`** (`stores/authStore.ts`): Manages authentication state with the `persist` middleware. Stores `user` (the full `User` object) and `isAuthenticated` (boolean) in localStorage under the key `linkedin-auth`. Provides `login`, `register`, `logout`, `checkAuth`, and `updateUser` actions. The `checkAuth` action is called from the root route's `useEffect` on every app mount, validating the session cookie against `/api/auth/me`. If validation fails (expired session, server restart), the store clears both `user` and `isAuthenticated`, redirecting to login.

The `updateUser` action is notable: it allows the profile edit flow to update the cached auth user without re-fetching from the server, keeping the navbar display name and headline in sync immediately after a profile edit.

The project does not use separate stores for feed, connections, or jobs. All data is fetched and managed as local component state within each route. This keeps the architecture simple but means navigating away from a page discards all fetched data.

### Routing

TanStack Router with file-based routing. The root layout renders `Navbar` globally and uses `Outlet` for route-specific content. Authentication guards are implemented imperatively: each protected route checks `isAuthenticated` in its `useEffect` and redirects to `/login` via `useNavigate` if not authenticated.

| File | URL Pattern | Purpose |
|------|-------------|---------|
| `routes/index.tsx` | `/` | Home feed with post composer + PYMK sidebar |
| `routes/network.tsx` | `/network` | Connection management (connections, requests, PYMK) |
| `routes/profile.$userId.tsx` | `/profile/:userId` | Full professional profile |
| `routes/jobs.tsx` | `/jobs` | Job search and recommendations |
| `routes/jobs.$jobId.tsx` | `/jobs/:jobId` | Job detail and application |
| `routes/search.tsx` | `/search` | User search |
| `routes/login.tsx` / `routes/register.tsx` | `/login`, `/register` | Authentication |

### Data Fetching

The API client (`services/api.ts`) is organized into domain-specific namespaces: `authApi`, `usersApi`, `connectionsApi`, `feedApi`, and `jobsApi`. Each namespace groups related endpoints with typed request/response signatures. All requests use `credentials: 'include'` for cookie-based session forwarding.

Routes use `Promise.all` for parallel data loading. The home page loads feed posts and PYMK suggestions simultaneously. The network page loads connections, pending requests, and PYMK in a single parallel batch. The profile page loads profile data and user posts in parallel, then conditionally loads connection degree and mutual connections for non-own profiles.

The jobs page loads all jobs and recommended jobs in parallel on mount, then uses a dedicated search handler for filtering. Search triggers a fresh API call with query parameters (keyword, location, remote flag, employment type, experience level) rather than client-side filtering.

### Optimistic Updates

The LinkedIn frontend uses a mixed approach to UI updates:

**Immediate local state updates**: When accepting a connection request, the handler calls `connectionsApi.acceptRequest`, then immediately moves the user from `pendingRequests` to `connections` in local state. The UI updates before the API call completes. If the API call fails, the error is logged but the UI is not rolled back, which is acceptable for a learning project.

**Post-creation insert**: After creating a post via `feedApi.createPost`, the returned post object is prepended to the local `posts` array with the current user as the author: `setPosts([{ ...post, author: user! }, ...posts])`. This ensures the new post appears at the top of the feed immediately.

**Endorsement increment**: When endorsing a skill, the handler calls the API and then locally increments the `endorsement_count` for that skill in the skills array via `setSkills(skills.map(...))`. This avoids re-fetching the entire skills list.

### Key UI Patterns

**Tabbed interfaces**: Both the network page and jobs page use tab-based navigation implemented with local state (`activeTab`). Tabs switch between different data views (connections/requests/PYMK, search/recommended) without changing the URL. All tab data is loaded in parallel on mount, so switching tabs is instant.

**Lazy-loaded comments**: The `PostCard` component does not load comments until the user clicks "Comment" or the comment count. This prevents unnecessary API calls for posts the user scrolls past. Once loaded, comments are cached in local component state.

**Connection degree display**: The profile page displays connection degree (1st, 2nd, 3rd) and mutual connections for non-own profiles. This data is fetched in a second parallel batch after profile data loads, since it requires a separate graph query.

**Modal-based editing**: Profile editing uses a modal (`EditProfileModal`) that pre-fills form fields from the current profile. On save, the updated user is set in both the local profile state and the global auth store (via `updateUser`), keeping the navbar in sync.

---

## Deep Pattern Explanations

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without it, a single user (or bot) can overwhelm the server by sending thousands of requests per second, degrading performance for everyone. Rate limiting protects both against malicious abuse (credential stuffing, scraping) and accidental abuse (buggy client code in an infinite retry loop).

The implementation (`src/utils/rateLimiter.ts`) uses a Redis-backed token bucket algorithm. Each user starts with a "bucket" of tokens (e.g., 100 tokens for read operations). Every request consumes one token. Tokens refill at a steady rate (100 per minute). When the bucket is empty, subsequent requests receive a `429 Too Many Requests` response with `X-RateLimit-Remaining: 0` and `X-RateLimit-Reset: <unix-timestamp>` headers telling the client when to retry.

The system uses different rate limits for different endpoint categories because different operations have different costs and abuse risks:

| Category | Limit | Rationale |
|----------|-------|-----------|
| Public (login/register) | 10/min | Prevents credential stuffing attacks |
| Read (GET) | 100/min | Generous for normal browsing, blocks scraping |
| Write (POST/PUT) | 30/min | Prevents spam posting |
| Connection requests | 20/min | Prevents mass-connect spam |
| Search | 20/min | Search is expensive (Elasticsearch query per request) |

The token bucket is implemented as a Lua script executed atomically in Redis. Lua scripting is necessary because the "check remaining tokens and decrement" operation must be atomic. If implemented as separate Redis GET and SET commands, a race condition between two concurrent requests could allow both to pass when only one token remains.

**Fail-open design**: If Redis is down, the rate limiter allows all requests instead of blocking them. This trades abuse protection for availability. The rationale: a Redis outage is temporary, and blocking all users during that window causes more harm than temporarily allowing unlimited requests.

### Structured Logging

Structured logging means emitting log messages as machine-parseable JSON objects rather than free-form text strings. Instead of `"2024-01-15 10:30:00 INFO User 42 sent connection request to user 87"`, a structured log produces `{"level":"info","msg":"connection.request.sent","fromUserId":42,"toUserId":87,"traceId":"abc-123","timestamp":"2024-01-15T10:30:00Z"}`.

The implementation uses Pino (`src/utils/logger.ts`), which outputs JSON by default. Every request receives a unique trace ID via the `X-Trace-Id` header, which propagates through the entire request lifecycle. This means every log line emitted during a request carries the same trace ID, making it possible to reconstruct the full request flow across all middleware, route handlers, and service functions.

**Why JSON over text**: Log aggregation systems (Elasticsearch, Datadog, Grafana Loki) can index JSON fields for fast querying. A query like `traceId="abc-123" AND level="error"` returns all errors from a specific request in milliseconds. With text logs, this requires regex parsing, which is slower by orders of magnitude and brittle when log formats change.

### Prometheus Metrics

Prometheus is a time-series database that scrapes numerical measurements from your application at regular intervals (typically every 15 seconds). The application exposes a `/metrics` endpoint that returns metrics in Prometheus text format. Prometheus stores these measurements with timestamps, enabling queries like "what was the p95 latency over the last hour" or "how many requests returned 500 errors in the last 5 minutes."

The four metric types are:
- **Counter**: Monotonically increasing value (e.g., `connections_created_total`). You calculate rates using PromQL: `rate(connections_created_total[5m])` gives connections per second.
- **Histogram**: Distribution of values in configurable buckets (e.g., `http_request_duration_seconds`). Enables percentile calculations: `histogram_quantile(0.95, ...)` gives the p95 latency.
- **Gauge**: Value that can increase or decrease (e.g., `queue_depth`, `active_sessions`). Represents current state.
- **Summary**: Client-side percentile calculation (less common than histograms).

The implementation (`src/utils/metrics.ts`) defines 20+ custom metrics covering HTTP traffic, business events (connections, posts, likes), algorithm performance (PYMK computation time, feed generation time), infrastructure health (queue depth, cache hits/misses), and security events (rate limit violations, login attempts). Default Node.js metrics (CPU, memory, event loop lag, GC duration) are included automatically via `collectDefaultMetrics()`.

### Health Checks

Health checks are HTTP endpoints that report whether the application can serve requests. They exist for two audiences: orchestration systems (Kubernetes) and operations teams.

- **`GET /health`**: Returns detailed status of every dependency (PostgreSQL, Valkey, RabbitMQ) with individual latency measurements. An operations engineer uses this to diagnose which component is degraded.
- **`GET /health/live`**: Returns 200 if the process is alive. Kubernetes uses this to detect hung processes. This must never check external dependencies, because a database outage should not cause the orchestrator to restart all API instances simultaneously (cascading failure).
- **`GET /health/ready`**: Returns 200 if the application can serve traffic. Checks that the database connection pool is active and Redis is reachable. Kubernetes uses this to decide whether to route traffic to this instance. A newly started instance that has not yet established database connections will fail readiness, so the load balancer skips it until it is ready.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of checking "does user 42 have permission to delete this post," the system checks "does user 42 have the admin role, and does the admin role include the delete-any-post permission."

In the LinkedIn implementation, users have a `role` column with values `user`, `recruiter`, or `admin`. The auth middleware extracts the user's role from the session. Route-level authorization checks whether the role has sufficient privileges for the requested operation. For example, only users with the `admin` role can view all users' audit logs, while any authenticated user can view their own connections.

**Why roles instead of per-user permissions**: With 900M users, storing individual permissions per user is infeasible. Roles group permissions into a small set (3 roles), and assigning a role to a user is a single column update. Adding a new permission (e.g., "can pin posts") means updating the role definition in code, not modifying millions of user records.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching pattern where the application checks the cache before querying the database. If the cache has the data (cache hit), return it immediately. If not (cache miss), query the database, store the result in the cache with a TTL, and return it.

The implementation uses this pattern for PYMK results and feed data. When a user requests their PYMK suggestions, the service first checks Valkey for `pymk:{userId}`. If found, the cached result is returned in <1ms. If not, the PYMK algorithm runs (50-200ms), the result is stored in Valkey with a 24-hour TTL, and subsequent requests hit the cache.

**Why not write-through?** Write-through updates the cache on every database write. For PYMK, the inputs (connections, experience, skills) change infrequently but the computation is expensive. Write-through would recompute PYMK every time a user updates their profile, wasting computation. Cache-aside with a long TTL (24 hours) amortizes the computation cost.

**Cache invalidation**: The hardest problem in computer science. Feed caches are explicitly deleted when a user creates a post (`cacheDel('feed:${connId}')` for the first 50 connections). This ensures high-priority connections see fresh content immediately, while others see it within the TTL window.

# Design TikTok - Architecture

## System Overview

TikTok is a short-video platform where the recommendation algorithm is the core product. Unlike social feeds based on follows, TikTok's For You Page (FYP) surfaces content from anyone based on predicted engagement. The system must solve three hard problems simultaneously: processing millions of video uploads daily, generating personalized feeds for billions of users in real time, and handling the cold start problem for both new users and new content.

## Requirements

### Functional Requirements

1. **Upload**: Create and publish short videos (15s-10min) with descriptions and hashtags
2. **FYP (For You Page)**: Personalized video recommendations based on engagement signals
3. **Discovery**: Browse by hashtags, sounds, and trending content
4. **Engage**: Like, comment, share, follow creators
5. **Analytics**: Creator metrics dashboard (views, engagement rates, audience demographics)

### Non-Functional Requirements

- **Latency**: < 100ms for video start (first frame); < 200ms for FYP API response; < 50ms for engagement actions
- **Availability**: 99.99% for video playback and FYP; 99.9% for upload and social features
- **Scale**: 1B daily active users, 1M new videos uploaded per day, 10B video views per day
- **Freshness**: New videos appear in recommendations within 2 hours of upload
- **Consistency**: Strong consistency for follows/likes (user expects immediate feedback); eventual consistency for view counts, follower counts, and recommendations

## Capacity Estimation

### Production Scale

| Metric | Value | Sizing Implication |
|--------|-------|-------------------|
| DAU | 1B | ~12M concurrent at peak |
| New videos/day | 1M | ~12 videos/second ingestion rate |
| Video views/day | 10B | ~115K views/second |
| Average video size | 15MB (post-transcode, multi-res) | ~15PB/day storage growth |
| FYP requests/day | ~5B (5 refreshes/user avg) | ~58K RPS for recommendation service |
| Engagement events/day | ~50B (views + likes + scrolls) | Event streaming at 580K events/sec |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent users | 1-5 |
| Videos | ~50-200 |
| Storage | < 2GB (MinIO) |
| API throughput | < 5 RPS |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                   │
│         Mobile (iOS/Android native) / Web (React SPA)                   │
│      Full-screen vertical video player, infinite scroll FYP             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           CDN Layer                                     │
│        Video segments, thumbnails, static assets                        │
│        Edge cache hit rate > 95% for popular videos                     │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        API Gateway                                      │
│     Rate limiting, auth validation, request routing, load balancing      │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
         ┌───────────┬───────────┼───────────┬───────────────┐
         ▼           ▼           ▼           ▼               ▼
┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐
│   Video     │ │  Social  │ │   Rec    │ │ Embedding │ │ Analytics│
│   Service   │ │  Service │ │  Service │ │  Service  │ │ Service  │
│             │ │          │ │          │ │           │ │          │
│ - Upload    │ │ - Follow │ │ - FYP    │ │ - Video   │ │ - Views  │
│ - Transcode │ │ - Like   │ │ - Rank   │ │   vectors │ │ - Creator│
│ - Storage   │ │ - Comment│ │ - Cold   │ │ - User    │ │   stats  │
│ - Moderate  │ │ - Share  │ │   start  │ │   vectors │ │ - Trends │
└──────┬──────┘ └─────┬────┘ └─────┬────┘ └─────┬─────┘ └─────┬────┘
       │              │            │             │             │
       ▼              ▼            ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Data Layer                                     │
├───────────────┬──────────────┬──────────────┬──────────────┬────────────┤
│  PostgreSQL   │   Valkey     │   S3/Blob    │  pgvector /  │   Kafka    │
│  + pgvector   │  (Redis)     │   Storage    │  Vector DB   │  (Events)  │
│               │              │              │              │            │
│ - Users       │ - Sessions   │ - Videos     │ - Video      │ - Views    │
│ - Videos meta │ - View buffer│ - Thumbnails │   embeddings │ - Likes    │
│ - Comments    │ - Rate limits│              │ - User       │ - Watches  │
│ - Follows     │ - Feed cache │              │   interest   │ - Uploads  │
│ - Likes       │              │              │   vectors    │            │
└───────────────┴──────────────┴──────────────┴──────────────┴────────────┘
```

## Core Components

### 1. Recommendation Engine

The recommendation engine is TikTok's primary differentiator. It uses a two-phase approach to balance breadth (consider many candidates) with depth (score each carefully).

**Phase 1: Candidate Generation (fast, broad)**

Pull ~1000 candidate videos from multiple sources, each targeting a different signal:

| Source | Weight | Signal |
|--------|--------|--------|
| Followed creators | 30% | Social graph -- content from people the user chose to follow |
| Liked hashtags | 20% | Topic interest inferred from engagement history |
| Embedding similarity | 20% | Vector similarity between user interest embedding and video embeddings |
| Trending pool | 30% | Globally popular + exploration content for diversity |

**Phase 2: Ranking (slow, precise)**

Score each candidate using multiple signals and produce a final ranked list:

1. **Hashtag preference match**: Compare video hashtags against the user's hashtag preference vector stored in `user_embeddings`
2. **Engagement metrics**: Normalize view count, like ratio, comment density as quality signals
3. **Freshness boost**: Time-decay function that boosts recent content (2x for <1hr, 1.5x for <6hr, 1x for <24hr)
4. **Source boost**: Higher scores for followed creators (+5) > embedding match (+4) > hashtag match (+2)
5. **Exploration factor**: 20% of slots reserved for random exploration to discover new interests

**Why two phases**: Scoring every video in the catalog for every user is computationally impossible at 1B users and millions of videos. Candidate generation narrows to ~1000 using cheap index lookups, then the ranking model applies expensive feature computation only to those candidates. This is the standard industry approach (Google, Netflix, Spotify all use two-phase).

### 2. Cold Start Strategy

**New User (no history):**
- Serve a mix of 70% demographic-popular + 30% diverse exploration content
- After 5-10 interactions, switch to personalized recommendations
- Rapidly learn preferences from watch-through rate (the strongest engagement signal)

**New Video (no engagement data):**
- Give initial exposure to a random sample of ~1000 users matching the video's hashtag audience
- Measure early signals: watch-through rate, like rate, share rate
- If early signals are strong, boost into more candidate pools; if weak, reduce exposure
- 20% exploration rate ensures new videos always get some visibility

### 3. Video Processing Pipeline

```
Upload ──▶ Validate ──▶ Transcode ──▶ Generate Thumbnails ──▶ CDN Distribution
                            │
                            ▼
┌──────────────────────────────────────────────────┐
│              Video Processing Queue (Kafka)       │
└──────────────────────────────────────────────────┘
   │
   ├──── Transcoder Worker 1 ──▶ 1080p, 720p, 480p, 360p
   ├──── Transcoder Worker 2 ──▶ (parallel processing)
   └──── Transcoder Worker N
   │
   ├──── Embedding Worker ──▶ Generate 384-dim video embedding
   └──── Moderation Worker ──▶ Content safety check
```

Each upload triggers:
- Transcoding to multiple resolutions for adaptive bitrate
- Thumbnail extraction at key frames
- Embedding generation (384-dimensional vector from description + hashtags)
- Content moderation check

### 4. Embedding System (pgvector)

The recommendation engine uses 384-dimensional vector embeddings for similarity search.

**Video embeddings**: Generated from video description text and hashtag features. Stored in the `videos.embedding` column with an IVFFlat index for approximate nearest neighbor search.

**User interest embeddings**: Aggregated from the embeddings of videos the user has watched, weighted by completion rate and recency. Stored in `users.interest_embedding`.

**Similar videos**: Given a video ID, find the most similar videos by cosine distance:
```sql
SELECT id, title, 1 - (embedding <=> target_embedding) AS similarity
FROM videos
WHERE status = 'active' AND id != target_id
ORDER BY embedding <=> target_embedding
LIMIT 20;
```

The IVFFlat index (`lists = 100`) provides approximate results with sub-millisecond query time, trading a small accuracy loss for orders-of-magnitude speed improvement over exact search.

## Database Schema

```sql
-- Enable pgvector for embedding-based recommendations
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- USERS
-- =============================================================================
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  bio TEXT,
  avatar_url VARCHAR(500),
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  video_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  role VARCHAR(20) DEFAULT 'user',                -- user|creator|moderator|admin
  interest_embedding vector(384),                 -- User interest vector for recommendations
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- VIDEOS
-- =============================================================================
CREATE TABLE videos (
  id SERIAL PRIMARY KEY,
  creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  video_url VARCHAR(500) NOT NULL,
  thumbnail_url VARCHAR(500),
  duration_seconds INTEGER,
  description TEXT,
  hashtags TEXT[],                                 -- Array for GIN index
  view_count BIGINT DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  embedding vector(384),                          -- Video content embedding
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- SOCIAL GRAPH
-- =============================================================================
CREATE TABLE follows (
  id SERIAL PRIMARY KEY,
  follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(follower_id, following_id)
);

CREATE TABLE likes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, video_id)
);

CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  like_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- WATCH HISTORY (for recommendations)
-- =============================================================================
CREATE TABLE watch_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
  watch_duration_ms INTEGER,
  completion_rate FLOAT,
  liked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- USER EMBEDDINGS (hashtag preferences)
-- =============================================================================
CREATE TABLE user_embeddings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hashtag_preferences JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================
CREATE INDEX idx_videos_creator ON videos(creator_id);
CREATE INDEX idx_videos_created ON videos(created_at DESC);
CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_likes_video ON likes(video_id);
CREATE INDEX idx_likes_user ON likes(user_id);
CREATE INDEX idx_comments_video ON comments(video_id);
CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_following ON follows(following_id);
CREATE INDEX idx_watch_history_user ON watch_history(user_id, created_at DESC);

-- Vector similarity indexes (IVFFlat for approximate nearest neighbor)
CREATE INDEX idx_videos_embedding ON videos
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_users_interest_embedding ON users
  USING ivfflat (interest_embedding vector_cosine_ops) WITH (lists = 100);

-- =============================================================================
-- TRIGGERS
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_videos_updated_at BEFORE UPDATE ON videos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_comments_updated_at BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## API Design

### Feed API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/feed/fyp` | Personalized For You Page (paginated) |
| GET | `/api/feed/following` | Videos from followed creators |
| GET | `/api/feed/trending` | Globally trending videos |

### Video API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/videos` | Upload a new video |
| GET | `/api/videos/:id` | Get video metadata |
| GET | `/api/videos/:id/similar` | Get similar videos (embedding-based) |
| POST | `/api/videos/:id/view` | Record a view event |
| POST | `/api/videos/:id/like` | Like a video |
| DELETE | `/api/videos/:id/like` | Unlike a video |

### Comment API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/comments/video/:videoId` | Get comments for a video |
| POST | `/api/comments` | Post a comment |
| DELETE | `/api/comments/:id` | Delete own comment |

### User API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users/:username` | Get user profile |
| GET | `/api/users/:username/videos` | Get user's videos |
| POST | `/api/users/:id/follow` | Follow a user |
| DELETE | `/api/users/:id/follow` | Unfollow a user |

### Auth API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login (returns session cookie) |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Get current user |

## Key Design Decisions

### 1. Watch Time as Primary Metric

**Decision**: Optimize for completion rate (watch-through), not views or likes.

**Why it works**: Views can be gamed (auto-play, clickbait thumbnails). Likes are a noisy signal (many viewers don't bother to like). Completion rate directly measures whether a user found the content engaging enough to watch until the end. A 15-second video watched for 14 seconds is a strong positive signal regardless of whether the user tapped "like."

**Why not likes/views**: A video with 1M views and 2% average completion rate is worse than a video with 50K views and 85% completion rate. The second video genuinely held attention. Optimizing for views creates perverse incentives (clickbait); optimizing for watch time aligns platform incentives with user satisfaction.

### 2. pgvector Over Dedicated Vector Database

**Decision**: Use pgvector extension in PostgreSQL rather than a standalone vector database (Pinecone, Milvus, Weaviate).

**Why it works**: PostgreSQL is already in the stack for relational data. pgvector adds vector similarity search without introducing a new service to deploy, monitor, and maintain. With IVFFlat indexes, approximate nearest neighbor queries on 384-dimensional vectors complete in under 5ms for datasets up to ~10M vectors.

**When this breaks**: At 100M+ videos, pgvector's IVFFlat index becomes less efficient. At that scale, migrating to a dedicated vector database (or HNSW indexes in pgvector) would be necessary. For the 1M-10M range, pgvector is the right trade-off between operational simplicity and performance.

### 3. Exploration vs. Exploitation Balance

**Decision**: Reserve 20% of FYP slots for exploration (random/diverse content) and 80% for exploitation (predicted high-engagement content).

**Why 20%**: Too little exploration (5%) creates filter bubbles where users see the same type of content endlessly, leading to boredom and churn. Too much exploration (40%) degrades the feed quality because users see too much irrelevant content. Industry research (Netflix, Spotify) converges on 10-25% exploration as the sweet spot. 20% ensures new creators get visibility while maintaining feed quality.

## Consistency and Idempotency

**Like idempotency**: The `likes` table has a `UNIQUE(user_id, video_id)` constraint. Repeated likes are rejected at the database level. The API returns 200 (not 409) for idempotent behavior.

**Follow idempotency**: Same pattern -- `UNIQUE(follower_id, following_id)` constraint prevents duplicate follows.

**View deduplication**: View events are rate-limited per user per video in Redis (30-second cooldown). This prevents inflated view counts from rapid scrolling through the feed.

**Comment creation**: Comments use database-generated IDs, so duplicate POST requests create duplicate comments. For production, idempotency keys in request headers would prevent this.

## Security and Auth

**Session-based authentication**: Redis-backed sessions via `connect-redis` with HTTP-only, secure cookies. 7-day expiry. Session prefix `tiktok:session:` for Redis key namespacing.

**Role-based access control**: Four roles (`user`, `creator`, `moderator`, `admin`) with a permission matrix enforced via `ensureRole` middleware. Users cannot upload; creators can upload and manage own content; moderators can delete any content; admins have full access.

**Rate limiting** (Redis-backed, per-endpoint):

| Endpoint | Limit | Window | Rationale |
|----------|-------|--------|-----------|
| Login | 5 | 15 min | Brute-force protection |
| Register | 3 | 1 hour | Prevent account farming |
| Upload | 10 | 1 hour | Protect transcoding infrastructure |
| Comments | 30 | 1 min | Prevent comment spam |
| Likes | 100 | 1 min | Prevent engagement manipulation |
| Feed | 60 | 1 min | Allow scrolling, prevent scraping |
| Search | 30 | 1 min | Prevent data harvesting |

## Observability

**Prometheus metrics** (via `prom-client`):
- FYP latency histogram (authenticated vs. anonymous)
- Recommendation phase timing (candidate_generation vs. ranking)
- Video view/like/upload counters by source (fyp, following, hashtag, search)
- Circuit breaker state gauge (0=closed, 1=half-open, 2=open)
- Rate limit hit counter by endpoint and user type
- HTTP request duration and count by route and status code

**Structured logging** (via `pino`):
- JSON format for machine parsing
- Request ID propagation
- Event-based entries: `video_uploaded`, `recommendation_served`, `circuit_breaker_opened`

**Health checks**:
- `/health` -- comprehensive check with database, Redis, and circuit breaker status
- `/health/live` -- liveness probe (process is running)
- `/health/ready` -- readiness probe (database and Redis are reachable)

## Failure Handling

### Circuit Breakers

The recommendation service is protected by a circuit breaker (Opossum):
- **Timeout**: 5 seconds (recommendations must be fast; users abandon after 3s)
- **Error threshold**: 50% (aggressive enough to protect, not so sensitive to flap)
- **Reset timeout**: 15 seconds (long enough for database connection recovery)
- **Volume threshold**: 20 requests (prevents single slow query from opening circuit)

**Fallback**: When the recommendation circuit opens, the FYP endpoint serves trending videos instead of personalized content. Users still see content, just not personalized.

### Retry Strategy

Transient failures use exponential backoff with jitter:
- Initial delay: 1 second
- Maximum delay: 30 seconds
- Maximum retries: 3
- Retryable errors: `ECONNRESET`, `ETIMEDOUT`, connection pool exhaustion

### Graceful Degradation

| Component Failure | Degradation Behavior |
|-------------------|---------------------|
| Recommendation service | Serve trending/popular videos |
| Redis (cache) down | Direct database queries (slower) |
| Embedding service | Skip personalization, use hashtag-based matching |
| Transcoding queue | Accept uploads, process later |
| pgvector index | Fall back to non-vector candidate generation |

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless with session state in Redis. Scale horizontally behind load balancer.
2. **Recommendation service**: Most computationally expensive. Scale independently with pre-computed candidate pools cached in Redis.
3. **PostgreSQL**: Read replicas for feed queries. Shard by `user_id` for social graph tables. Separate database for embeddings at extreme scale.
4. **Redis**: Cluster mode. Separate instances for sessions, rate limits, and feed caching.
5. **Kafka**: Partition by `video_id` for view events, by `user_id` for engagement events.
6. **Vector search**: Migrate from pgvector to dedicated vector database (Milvus/Pinecone) at 100M+ videos.

### What Breaks First

1. **Recommendation latency** -- solved by pre-computing candidate pools and caching ranked results
2. **View count writes** -- solved by Redis buffering with periodic batch flush
3. **Embedding search** -- solved by IVFFlat indexes, then dedicated vector DB
4. **Storage costs** -- solved by tiered storage (hot/warm/cold) and CDN edge caching

### Data Lifecycle

| Data Type | Hot Storage | Archive After | Delete After |
|-----------|-------------|---------------|--------------|
| Active videos | S3/MinIO | Never | User deletion |
| Deleted videos | Archive bucket | Immediately | 30 days (legal hold) |
| Watch history | PostgreSQL | 1 year | 2 years |
| Session data | Redis | N/A | 7 days (TTL) |
| Rate limit counters | Redis | N/A | 1-60 min (TTL) |
| User embeddings | PostgreSQL | N/A | Updated continuously |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Rec metric | Watch time / completion rate | Views or likes | Harder to game, aligns with user satisfaction |
| Rec approach | Two-phase (generate + rank) | Single model | Scalable to billions of videos |
| Embeddings | pgvector (384-dim) | Dedicated vector DB (Pinecone) | Operational simplicity, sufficient for <10M videos |
| Exploration rate | 20% random | 5% or 40% | Balances discovery vs. feed quality |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Video storage | Object storage + CDN | Database BLOBs | Cost-effective, infinitely scalable |
| Counter updates | Denormalized + triggers | COUNT(*) queries | O(1) reads for profile pages |

---

## Implementation Notes

This section maps the production architecture above to what is actually running locally.

### Local Architecture

```
┌───────────────────────┐         ┌───────────────────────┐
│   React Frontend      │────────▶│   Express API Server  │
│   :5173 (Vite)        │         │   :3000                │
│                       │         │                       │
│ - Full-screen FYP     │         │ - Feed routes (FYP,   │
│   with virtualization │         │   following, trending)│
│ - Video player        │         │ - Video CRUD + upload │
│ - Discover page       │         │ - Comments, likes     │
│ - Profile pages       │         │ - Auth (session/Redis)│
│ - Upload flow         │         │ - Recommendation      │
│ - Zustand state       │         │   engine              │
│ - TanStack Router     │         │ - Embedding service   │
└───────────────────────┘         └────┬──────────┬───────┘
                                       │          │
                          ┌────────────┘          │
                          ▼                       ▼
                 ┌──────────────────┐   ┌─────────────────┐
                 │   PostgreSQL     │   │   Valkey/Redis   │
                 │   :5432          │   │   :6379          │
                 │   (pgvector/pg16)│   │   (sessions,     │
                 │   (tiktok db)    │   │    rate limits)   │
                 └──────────────────┘   └─────────────────┘
                 ┌──────────────────┐
                 │   MinIO          │
                 │   :9000 (API)    │
                 │   :9001 (UI)     │
                 │   Buckets:       │
                 │   - videos       │
                 │   - thumbnails   │
                 └──────────────────┘
```

Run with:
```
docker-compose up -d          # Infrastructure (pgvector, Valkey, MinIO)
cd backend && npm run dev     # API server on :3000
cd frontend && npm run dev    # Frontend on :5173
```

### Production Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Structured logging | Pino JSON logger with request ID | `backend/src/shared/logger.ts` |
| Prometheus metrics | FYP latency, rec phase timing, views, uploads | `backend/src/shared/metrics.ts` |
| Circuit breakers | Opossum wrapping recommendation service | `backend/src/shared/circuitBreaker.ts` |
| Rate limiting | Redis-backed, per-endpoint with configurable windows | `backend/src/shared/rateLimiter.ts` |
| Retry with backoff | Exponential backoff for transient failures | `backend/src/shared/retry.ts` |
| Retention policies | Tiered storage config with viral thresholds | `backend/src/shared/retention.ts` |
| Health checks | Liveness, readiness, comprehensive probes | `backend/src/index.ts` |
| Session auth | Redis-backed sessions via connect-redis | `backend/src/index.ts` |
| RBAC | 4-tier role hierarchy with ensureRole middleware | `backend/src/middleware/auth.ts` |
| Vector embeddings | pgvector 384-dim with IVFFlat indexes | `backend/src/services/embeddings.ts` |
| Two-phase recs | Candidate generation + ranking with exploration | `backend/src/routes/feed.ts` |
| Feed virtualization | @tanstack/react-virtual for full-screen FYP | `frontend/src/routes/index.tsx` |
| Graceful shutdown | SIGTERM/SIGINT handler with Redis cleanup | `backend/src/index.ts` |

### What Was Simplified or Substituted

| Production Component | Local Substitute | Reason |
|---------------------|-----------------|--------|
| AWS S3 / GCS | MinIO (S3-compatible) | Same API, runs in Docker |
| CDN (CloudFront) | Direct MinIO access | No edge caching needed locally |
| FFmpeg transcoding | No transcoding (single resolution) | Focuses on rec engine, not video processing |
| Kafka (event stream) | No event streaming | View counts updated synchronously |
| ML embeddings (sentence-transformers) | Random 384-dim vectors | Demonstrates pgvector pattern without ML infra |
| Dedicated vector DB | pgvector in PostgreSQL | Same instance, sufficient for local scale |
| OAuth / SSO | Session cookies with bcrypt | Simpler for learning |
| Multi-instance deployment | Single Express process | Use `npm run dev:server{1,2,3}` to simulate |

### What Was Omitted

- **CDN layer**: No edge caching; videos served directly from MinIO
- **Real video transcoding**: No FFmpeg pipeline; videos stored as-is
- **ML model training**: No trained recommendation model; rule-based scoring only
- **Event streaming (Kafka)**: No async event pipeline for engagement tracking
- **Content moderation**: No ML-based video/audio analysis
- **Push notifications**: No notification system for new content
- **Multi-region deployment**: Single Docker Compose on localhost
- **Kubernetes orchestration**: No container scheduling
- **A/B testing framework**: No experimentation infrastructure for algorithm tuning
- **Audio/sound matching**: Hashtag-based only, no audio fingerprinting

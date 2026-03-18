# YouTube - Video Platform - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"I'll be designing the backend infrastructure for a video hosting and streaming platform like YouTube. This is one of the most challenging backend systems to design because it involves massive object storage, asynchronous transcoding pipelines, adaptive bitrate streaming with HLS, sophisticated recommendation algorithms, and global content delivery. Let me start by scoping the problem with a focus on the backend services."

---

## 1. 📋 Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Video Upload Pipeline** — Chunked/resumable uploads (up to 5GB) with S3 multipart, validation, and queue-based transcoding
2. **Transcoding Service** — Multi-resolution encoding (1080p/720p/480p/360p), HLS segment generation, thumbnail extraction
3. **Streaming Infrastructure** — HLS adaptive bitrate delivery via CDN, playback position tracking
4. **Engagement APIs** — Threaded comments, like/dislike reactions, subscriptions, watch history
5. **Recommendation Engine** — Collaborative + content-based filtering, trending with time decay, personalized feeds

### Non-Functional Requirements

- **Scale**: 500 hours video/minute upload, 1B views/day
- **Latency**: API responses < 200ms p95, video start < 2s
- **Throughput**: 17 Tbps streaming bandwidth
- **Consistency**: Eventual for view counts, strong for user actions

---

## 2. 📊 Scale Estimation (2-3 minutes)

```
Storage:
  Daily uploads: 500 hrs/min × 1440 min = 720K hours → 4.3M videos/day
  Processed per video (all resolutions): ~674 MB → ~2.9 PB/day, ~1 EB/year

Bandwidth:
  1B views/day × 5 min avg × 5 Mbps = 17.4 Tbps continuous
  CDN cache hit 95% → Origin handles ~870 Gbps

Database:
  Video metadata: 10 TB | Users: 10 TB | Comments: 50 TB | Watch history: 50 TB
```

---

## 3. 🏗️ High-Level Backend Architecture (8-10 minutes)

```
                                    ┌──────────────────────────────────────────┐
                                    │              CDN Edge Layer              │
                                    │    (Cloudflare/Akamai/Custom POPs)       │
                                    └──────────────────┬───────────────────────┘
                                                       │
                                    ┌──────────────────▼───────────────────────┐
                                    │            API Gateway / Nginx           │
                                    │   (Authentication, Rate Limiting, TLS)   │
                                    └────────────────────┬─────────────────────┘
                                                         │
           ┌─────────────────────┬───────────────────────┼───────────────────────┬──────────────────────┐
           │                     │                       │                       │                      │
  ┌────────▼────────┐  ┌────────▼────────┐  ┌───────────▼──────────┐  ┌────────▼────────┐  ┌──────────▼─────────┐
  │  Upload Service │  │ Metadata Service│  │   Streaming Service  │  │ Comment Service │  │ Recommendation Svc │
  │                 │  │                 │  │                      │  │                 │  │                    │
  │ - Chunked upload│  │ - Video CRUD    │  │ - Manifest generation│  │ - Thread mgmt   │  │ - Collaborative    │
  │ - S3 multipart  │  │ - Channel mgmt  │  │ - Segment routing    │  │ - Reactions     │  │ - Content-based    │
  │ - Validation    │  │ - Subscription  │  │ - Progress tracking  │  │ - Moderation    │  │ - Trending         │
  └────────┬────────┘  └────────┬────────┘  └───────────┬──────────┘  └────────┬────────┘  └──────────┬─────────┘
           │                    │                       │                      │                      │
           │                    │                       │                      │                      │
  ┌────────▼────────┐           │                       │                      │                      │
  │   Kafka/RMQ     │           │                       │                      │                      │
  │  (Job Queue)    │           │                       │                      │                      │
  └────────┬────────┘           │                       │                      │                      │
           │                    │                       │                      │                      │
  ┌────────▼────────┐           │                       │                      │                      │
  │ Transcoding     │           │                       │                      │                      │
  │ Workers (K8s)   │           │                       │                      │                      │
  │                 │           │                       │                      │                      │
  │ - FFmpeg encode │           │                       │                      │                      │
  │ - HLS segment   │           │                       │                      │                      │
  │ - Thumbnails    │           │                       │                      │                      │
  └────────┬────────┘           │                       │                      │                      │
           │                    │                       │                      │                      │
           └────────────────────┴───────────────────────┴──────────────────────┴──────────────────────┘
                                                        │
                     ┌──────────────────────────────────┼──────────────────────────────────┐
                     │                                  │                                  │
            ┌────────▼────────┐               ┌────────▼────────┐               ┌─────────▼────────┐
            │   PostgreSQL    │               │     Redis       │               │      MinIO       │
            │    (Primary)    │               │   (Cluster)     │               │   (S3 Storage)   │
            │                 │               │                 │               │                  │
            │ - Video metadata│               │ - Session store │               │ - Raw videos     │
            │ - Users/channels│               │ - View counters │               │ - HLS segments   │
            │ - Comments      │               │ - Cache layer   │               │ - Thumbnails     │
            │ - Watch history │               │ - Rate limits   │               │ - Avatars        │
            └─────────────────┘               └─────────────────┘               └──────────────────┘
```

### API Design

```
Upload:
  POST   /api/v1/upload/init           → Initialize multipart upload session
  POST   /api/v1/upload/:id/chunk      → Upload a single chunk
  POST   /api/v1/upload/:id/complete   → Finalize upload, trigger transcoding

Videos:
  GET    /api/v1/videos/:id            → Video metadata + resolution list
  GET    /api/v1/videos/:id/stream     → Redirect to master.m3u8 via CDN
  POST   /api/v1/videos/:id/view       → Record view event
  GET    /api/v1/videos/trending       → Trending videos (from Redis ZSET)

Engagement:
  GET    /api/v1/videos/:id/comments   → Paginated comments (cursor-based)
  POST   /api/v1/videos/:id/comments   → Create comment (or reply with parent_id)
  POST   /api/v1/videos/:id/reactions  → Like or dislike

Channels:
  GET    /api/v1/channels/:id          → Channel profile + stats
  GET    /api/v1/channels/:id/videos   → Channel videos (paginated)
  POST   /api/v1/channels/:id/subscribe → Toggle subscription

Feed:
  GET    /api/v1/feed                  → Personalized home feed
  GET    /api/v1/feed/subscriptions    → Latest from subscribed channels
```

---

## 4. 🔧 Deep Dive: Upload and Transcoding Pipeline (10-12 minutes)

### Chunked Upload with S3 Multipart

```
┌──────────┐     ┌────────────────┐     ┌──────────────┐
│  Client  │────▶│ Upload Service │────▶│ S3 Multipart │
└──────────┘     └────────────────┘     │ Upload Init  │
     │                  │               └──────┬───────┘
     │                  ▼                      │
     │           ┌──────────────┐              │
     │           │ Create upload│◀─────────────┘
     │           │ session in DB│
     │           └──────────────┘
     │
     └──── For each 5MB chunk ────▶ S3.uploadPart() + store ETag in Redis
                                           │
                                           ▼ On completion:
                                    1. Verify all chunks (Redis count vs expected)
                                    2. S3.completeMultipartUpload() with sorted ETags
                                    3. Create video record (status='processing')
                                    4. Publish transcode job to message queue
```

> "We use 5MB chunks for optimal parallelism, track ETags in Redis HSET with HINCRBY for the completion counter, and enforce a 5GB limit with MIME type validation. Upload sessions expire after 24 hours. Video IDs are YouTube-style 11-character alphanumeric strings."

**Why chunked over single-file upload?** A 2GB video upload over a mobile connection takes ~45 minutes. If it fails at 95%, single-file upload means starting over. Chunked upload with S3 multipart lets us resume from the last successful chunk. Each chunk is independently verified (ETag), so we can retry individual failures without re-uploading the entire file. The trade-off is implementation complexity -- we need upload session management, chunk ordering, and completion verification -- but for video files this is non-negotiable.

### Transcoding Worker Pipeline

```
Message Queue ──▶ Worker consumes job
                    │
                    ▼
              1. Download raw video from S3 to local temp
              2. FFprobe: extract source resolution + duration
              3. Generate thumbnails at multiple timestamps
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
     Transcode   Transcode  Transcode
      1080p*      720p     480p/360p
          │         │         │
          └─────────┼─────────┘
                    ▼
              4. Segment each resolution into 4-second HLS .ts files
              5. Generate per-resolution playlist.m3u8 + master.m3u8
              6. Upload all to S3
              7. Update DB: status='ready', publish video.published event

     * Only if source resolution supports it
```

> "We use libx264 with medium preset, VBR rate control (bufsize = 2x bitrate), AAC audio, and +faststart for progressive download. Each resolution gets its own HLS playlist; the master playlist links them all for adaptive bitrate switching."

| Resolution | Dimensions | Video Bitrate | Audio Bitrate |
|------------|-----------|---------------|---------------|
| 1080p | 1920x1080 | 5000k | 192k |
| 720p | 1280x720 | 2500k | 128k |
| 480p | 854x480 | 1000k | 96k |
| 360p | 640x360 | 500k | 64k |

---

## 5. 🔧 Deep Dive: View Counting and CDN Caching (6-8 minutes)

### Batched View Count Updates

> "Direct DB writes per view would kill PostgreSQL at 1B views/day. Instead, we buffer in Redis and flush periodically. The trade-off is eventual consistency -- view counts may lag by up to 60 seconds -- but for a vanity metric this is perfectly acceptable."

**Flow:** User watches video --> Redis INCR `views:pending:{videoId}` (atomic, no DB hit) --> optionally store view metadata (userId, timestamp, quality) in a Redis list for analytics.

**Background job (every 60 seconds):** SCAN for all `views:pending:*` keys, GETSET each to 0 (atomically read and reset), batch UPDATE to PostgreSQL, invalidate video cache, and update trending score.

**Trending score:** `score = viewDelta * 0.5^(ageHours/24)` -- score halves every 24 hours. Stored in Redis sorted sets (`ZINCRBY trending:global`, `ZINCRBY trending:{category}`), trimmed to top 1000 with ZREMRANGEBYRANK.

### Multi-Tier CDN Caching Strategy

```
┌──────────────────────────────┐
│  Edge Tier (closest to user) │  TTL: 1hr, stale-while-revalidate: 5min
└──────────────┬───────────────┘
               ▼ cache miss
┌──────────────────────────────┐
│  Regional Tier (POPs)        │  TTL: 24hr
└──────────────┬───────────────┘
               ▼ cache miss
┌──────────────────────────────┐
│  Origin Shield               │  Aggregates requests, reduces origin load 95%
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  Origin (MinIO/S3)           │
└──────────────────────────────┘
```

| Content Type | Cache Duration | Notes |
|--------------|----------------|-------|
| HLS Segments (.ts) | 7 days | Immutable content, long cache |
| Manifests (.m3u8) | 5 minutes | Short cache, can regenerate |

> "We pre-warm popular content by prefetching the master playlist and first 10 segments (~40s of video) to all edge POPs. Range request support enables efficient seeking without downloading the whole segment."

---

## 6. 🔧 Deep Dive: Recommendation System (5-6 minutes)

```
User requests home feed
        │
        ├───────────────┬───────────────┬──────────────┐
        ▼               ▼               ▼              ▼
 ┌────────────┐  ┌────────────┐  ┌───────────┐  ┌──────────┐
 │Collaborative│  │Content-   │  │Subscription│  │Trending  │
 │  Filter    │  │Based      │  │  Feed     │  │          │
 └─────┬──────┘  └─────┬──────┘  └─────┬─────┘  └────┬─────┘
       └────────────────┴──────────────┴──────────────┘
                        │
                        ▼
              Merge & Deduplicate ──▶ Score & Rank ──▶ Return top N
```

**Collaborative filtering:** Get user's last 100 watched videos (>50% completion), find similar users with at least 5 overlapping videos, surface videos those users watched that current user hasn't. Score = sum(overlap * watch_percentage).

**Content-based filtering:** Extract category preferences from 30-day watch history weighted by completion. Find unseen videos in preferred categories. Score = category_weight * engagement_ratio (likes/views).

> "We run all four candidate generators in parallel and merge results. This is critical for latency -- collaborative filtering requires joining watch_history across users (expensive), but running it concurrently with the cheaper subscription and trending lookups means total latency equals the slowest generator, not the sum. We cache collaborative filter results per user for 1 hour since taste doesn't change minute-to-minute."

**Final scoring weights:**

| Source | Weight | Additional Factors |
|--------|--------|--------------------|
| Subscribed channel | +100 | Engagement quality: likes/(likes+dislikes+1) * 40 |
| Collaborative filter | +50 | Freshness decay: score *= e^(-ageHours/48) |
| Content-based filter | +30 | (half-life of 48 hours) |
| Trending | +20 | |

---

## 7. 💾 Data Model (4-5 minutes)

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| videos | id (VARCHAR 11, PK), channel_id (FK), title, description, duration_seconds, status, visibility, view/like/dislike/comment counts, categories[], tags[], thumbnail_url, published_at | (channel_id, published_at DESC), (published_at DESC) WHERE status='ready', GIN(categories), GIN(tags) | YouTube-style 11-char alphanumeric ID. Denormalized counters for read performance |
| video_resolutions | video_id (FK), resolution, manifest_url, bitrate, width, height | PK(video_id, resolution) | One row per quality level per video |
| comments | id (UUID PK), video_id (FK), user_id (FK), parent_id (FK, nullable), text, like_count, is_edited | (video_id, created_at DESC), (parent_id) WHERE NOT NULL | Self-referential FK enables threading |
| watch_history | id (UUID PK), user_id (FK), video_id (FK), watch_duration_seconds, watch_percentage, last_position_seconds, watched_at | (user_id, watched_at DESC), (video_id, watch_percentage) | Powers recommendations and resume playback |
| users | id (UUID PK), username (unique), email (unique), display_name, avatar_url, subscriber_count, created_at | (username), (email) | subscriber_count denormalized for channel pages |
| subscriptions | subscriber_id (FK), channel_id (FK), notify (boolean), created_at | PK(subscriber_id, channel_id), (channel_id) | Drives subscription feed and notification preferences |
| reactions | id (UUID PK), user_id (FK), video_id (FK), type (like/dislike) | UNIQUE(user_id, video_id) | Upsert pattern for toggle behavior |

### Redis Data Structures

| Key Pattern | Type | Purpose |
|-------------|------|---------|
| views:pending:{videoId} | STRING | Buffered view count (flushed every minute) |
| trending:global / trending:{category} | ZSET | Trending videos with decay scores |
| session:{sessionId} | HASH | User session data |
| video:{videoId} | JSON | Cached video metadata |
| upload:{uploadId} | HASH | Upload progress tracking |
| ratelimit:{ip}:{endpoint} | STRING | Rate limit counter with TTL |

### Consistency and Idempotency

**Upload idempotency:** Each upload session gets a unique ID. If the client retries a chunk upload, S3 multipart handles deduplication by part number -- re-uploading part 5 simply overwrites the previous part 5. The completion step is idempotent because we check if the video record already exists before creating it.

**View counting deduplication:** We use a Redis SET `views:seen:{videoId}:{timeWindow}` to track which users have already been counted in the current window. This prevents refresh-spam from inflating counts. The set auto-expires every 5 minutes to bound memory usage.

**Comment creation:** Each comment POST includes a client-generated idempotency key stored in Redis with a 5-minute TTL. Duplicate requests return the original comment instead of creating a new one.

**Reaction toggling:** Likes and dislikes use an upsert pattern -- the reactions table has a unique constraint on (user_id, video_id), so repeated likes are no-ops and toggling between like/dislike is a single UPDATE.

---

## 8. ⚖️ Trade-offs and Alternatives (4-5 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Object storage | ✅ S3/MinIO | Custom distributed FS | Scalable, cheap per GB, durable. CDN solves latency. Custom FS only justified at extreme scale |
| Video format | ✅ HLS only | DASH or both | Best compatibility (Apple native + wide support). Both = 2x storage, justified only at YouTube scale |
| Transcoding arch | ✅ Async RabbitMQ | Kafka + workers, Serverless | RabbitMQ gives reliable retries. Kafka better at production scale. Lambda has cold start + duration limits |
| View counting | ✅ Redis buffer + batch | Sync DB update, HyperLogLog | Sync = DB bottleneck at 1B views/day. HLL only approximate. Redis buffer gives speed with eventual consistency |

> "The view count trade-off is the most interesting. Synchronous DB updates would mean 11,500 writes/second to a single row during a viral video -- that's a guaranteed hotspot. Redis INCR handles millions of ops/second with O(1) complexity. The 60-second flush delay is invisible to users but reduces DB write pressure by 99%. HyperLogLog was tempting for unique view counts (12KB per counter!) but we need exact counts for creator monetization, so we use it only as a secondary dedup check."

> "For transcoding, the RabbitMQ vs Kafka decision is nuanced. RabbitMQ gives us per-message acknowledgment and dead-letter queues out of the box -- if a worker crashes mid-transcode, the message returns to the queue automatically. Kafka's consumer groups would let us scale to thousands of workers with partition-based parallelism, but the operational overhead of managing offsets, rebalancing, and exactly-once semantics isn't justified until we're processing millions of videos per day. At our current scale, RabbitMQ with prefetch=1 ensures no worker takes more than it can handle."

---

## 9. 📈 Scalability Path (3-4 minutes)

**What breaks first and how to fix it:**

| Bottleneck | Symptom | Solution |
|------------|---------|----------|
| Transcoding queue depth | Upload-to-ready time > 30 min | Add workers horizontally; split into priority queues (partner vs regular) |
| PostgreSQL write load | View count flush latency spikes | Shard videos table by video_id hash; read replicas for metadata reads |
| Single Redis instance | Memory > 80%, latency spikes | Redis Cluster with hash slots; separate clusters for cache vs counters vs sessions |
| CDN cache miss storms | Origin bandwidth spikes on viral content | Pre-warm trending content; origin shield absorbs thundering herd |
| Comment reads on viral videos | p95 > 500ms for popular videos | Cache top 100 comments per video in Redis; paginate with cursor-based approach |

> "The scaling strategy is to keep services stateless so we can add instances behind the load balancer. The hardest part to scale is the transcoding pipeline because each job is CPU-intensive and takes minutes. We handle this with auto-scaling worker pools keyed to queue depth -- when pending jobs exceed 50, we spin up additional workers. At extreme scale, we'd move to Kubernetes with pod autoscaling based on custom Prometheus metrics."

---

## 10. 📈 Monitoring and Observability (2-3 minutes)

**Key Prometheus metrics:** `video_uploads_total{status}` (counter), `transcode_queue_depth` (gauge), `transcode_duration_seconds{resolution}` (histogram), `video_views_total{quality}` (counter), `cache_hit_ratio{cache_type}` (gauge).

**Critical alerts:**

| Metric | Warning | Critical |
|--------|---------|----------|
| Transcode queue depth | > 50 jobs | > 200 jobs |
| Transcode failure rate | > 5% | > 15% |
| API p95 latency | > 500ms | > 2s |
| CDN cache hit ratio | < 90% | < 70% |
| DB connection pool usage | > 80% | > 95% |

**Structured logging:** Every request gets a correlation ID propagated through all downstream services. Transcode jobs log each pipeline stage (download, probe, encode, segment, upload) with duration, enabling bottleneck identification.

---

## 11. 🎯 Summary

The architecture handles 500 hours/minute of video upload through: **chunked S3 multipart uploads** with Redis progress tracking, **async FFmpeg transcoding** via message queue workers producing multi-resolution HLS segments, **Redis-buffered view counting** with periodic PostgreSQL flushes, **multi-tier CDN** reducing origin load to 5%, and **hybrid recommendations** combining collaborative filtering, content-based filtering, and trending algorithms. All services are stateless and horizontally scalable.

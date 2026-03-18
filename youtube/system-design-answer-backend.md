# YouTube - Video Platform - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"I'll design the backend for a video platform like YouTube — covering object storage, async transcoding pipelines, HLS adaptive streaming, recommendation algorithms, and global CDN delivery."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Video Upload Pipeline** — Chunked/resumable uploads (up to 5GB) with S3 multipart, validation, and queue-based transcoding
2. **Transcoding Service** — Multi-resolution encoding (1080p/720p/480p/360p), HLS segment generation, thumbnail extraction
3. **Streaming Infrastructure** — HLS manifest delivery, CDN caching, adaptive bitrate, resume playback tracking
4. **Engagement APIs** — Threaded comments, like/dislike reactions, subscriptions, watch history
5. **Recommendation Engine** — Collaborative + content-based filtering, trending with time decay, personalized feeds

### Non-Functional Requirements

- **Scale**: 500 hours video/minute upload, 1B views/day
- **Latency**: API responses < 200ms p95, video start < 2s
- **Consistency**: Eventual for view counts, strong for user actions

---

## 2. Scale Estimation (2-3 minutes)

```
Uploads:   500 hrs/min → 4.3M videos/day → ~2.9 PB/day processed storage → ~1 EB/year
Streaming: 1B views/day × 5 min avg × 5 Mbps = 17.4 Tbps (CDN serves 95%, origin = 870 Gbps)
Database:  Video metadata 10 TB, Users 10 TB, Comments 50 TB, Watch history 50 TB
```

---

## 3. High-Level Backend Architecture (8-10 minutes)

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

---

## 4. Deep Dive: Chunked Upload and Transcoding Pipeline (10-12 minutes)

### Chunked Upload with S3 Multipart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Upload Flow                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     ┌─────────────────┐     ┌───────────────────────────┐ │
│  │   Client    │────▶│ Upload Service  │────▶│ S3 Multipart Upload Init  │ │
│  └─────────────┘     └─────────────────┘     └───────────────────────────┘ │
│        │                     │                           │                  │
│        │                     ▼                           │                  │
│        │           ┌─────────────────────┐               │                  │
│        │           │ Create Upload       │               │                  │
│        │           │ Session in DB       │◀──────────────┘                  │
│        │           └─────────────────────┘                                  │
│        │                                                                    │
│        └─────────────── For each 5MB chunk ──────────────────────────┐     │
│                              │                                        │     │
│                              ▼                                        │     │
│                    ┌─────────────────────┐                            │     │
│                    │   S3.uploadPart()   │                            │     │
│                    │   + Store ETag      │                            │     │
│                    │   in Redis          │                            │     │
│                    └─────────────────────┘                            │     │
│                                                                       │     │
│        ┌──────────────────────────────────────────────────────────────┘     │
│        │                                                                    │
│        ▼  On completion:                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  1. Verify all chunks received (compare Redis count to expected)    │   │
│  │  2. Call S3.completeMultipartUpload() with sorted ETags             │   │
│  │  3. Create video record with status='processing'                    │   │
│  │  4. Publish transcode job to message queue                          │   │
│  │  5. Cleanup Redis keys and update session status                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key details:** 5MB chunks for parallelism, Redis HSET for chunk ETag tracking, MIME validation with 5GB limit, 24-hour upload session expiry, YouTube-style 11-char alphanumeric IDs.

### Transcoding Worker Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Transcoding Pipeline                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐                                                       │
│  │  Message Queue   │ consume job                                           │
│  │  (Kafka/RMQ)     │────────────────────┐                                  │
│  └──────────────────┘                    │                                  │
│                                          ▼                                  │
│                           ┌──────────────────────────────┐                  │
│                           │  1. Download raw video from  │                  │
│                           │     S3 to local temp         │                  │
│                           └──────────────┬───────────────┘                  │
│                                          │                                  │
│                                          ▼                                  │
│                           ┌──────────────────────────────┐                  │
│                           │  2. FFprobe: Extract source  │                  │
│                           │     resolution + duration    │                  │
│                           └──────────────┬───────────────┘                  │
│                                          │                                  │
│                                          ▼                                  │
│                           ┌──────────────────────────────┐                  │
│                           │  3. Generate thumbnails at   │                  │
│                           │     multiple timestamps      │                  │
│                           └──────────────┬───────────────┘                  │
│                                          │                                  │
│                        ┌─────────────────┼─────────────────┐                │
│                        ▼                 ▼                 ▼                │
│              ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│              │ Transcode    │  │ Transcode    │  │ Transcode    │           │
│              │ 1080p        │  │ 720p         │  │ 480p, 360p   │           │
│              │ (if source   │  │              │  │              │           │
│              │  supports)   │  │              │  │              │           │
│              └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
│                     │                 │                 │                   │
│                     └─────────────────┼─────────────────┘                   │
│                                       │                                     │
│                                       ▼                                     │
│                           ┌──────────────────────────────┐                  │
│                           │  4. For each resolution:     │                  │
│                           │     - Segment into HLS .ts   │                  │
│                           │     - Generate playlist.m3u8 │                  │
│                           │     - Upload to S3           │                  │
│                           └──────────────┬───────────────┘                  │
│                                          │                                  │
│                                          ▼                                  │
│                           ┌──────────────────────────────┐                  │
│                           │  5. Generate master.m3u8     │                  │
│                           │     (links all qualities)    │                  │
│                           └──────────────┬───────────────┘                  │
│                                          │                                  │
│                                          ▼                                  │
│                           ┌──────────────────────────────┐                  │
│                           │  6. Update DB: status=ready  │                  │
│                           │     Publish video.published  │                  │
│                           │     event for notifications  │                  │
│                           └──────────────────────────────┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Transcoding details:** libx264 with VBR rate control, AAC audio, +faststart flag. Outputs at 1080p (5Mbps), 720p (2.5Mbps), 480p (1Mbps), 360p (500kbps). HLS segments are 4 seconds each, VOD playlist type.

### HLS Manifest Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        HLS Manifest Hierarchy                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  master.m3u8 (Master Playlist)                                      │   │
│  │  ──────────────────────────────                                     │   │
│  │  #EXTM3U                                                            │   │
│  │  #EXT-X-VERSION:3                                                   │   │
│  │                                                                     │   │
│  │  #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080           │   │
│  │  1080p/playlist.m3u8                                                │   │
│  │                                                                     │   │
│  │  #EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720            │   │
│  │  720p/playlist.m3u8                                                 │   │
│  │                                                                     │   │
│  │  #EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480             │   │
│  │  480p/playlist.m3u8                                                 │   │
│  │                                                                     │   │
│  │  #EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360              │   │
│  │  360p/playlist.m3u8                                                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│              ┌───────────────┼───────────────┐                             │
│              ▼               ▼               ▼                             │
│  ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐        │
│  │ 720p/playlist.m3u8│ │ 480p/playlist.m3u8│ │ ...               │        │
│  │ ──────────────────│ │                   │ │                   │        │
│  │ #EXTM3U           │ │                   │ │                   │        │
│  │ #EXT-X-VERSION:3  │ │                   │ │                   │        │
│  │ #TARGETDURATION:4 │ │                   │ │                   │        │
│  │ #PLAYLIST-TYPE:VOD│ │                   │ │                   │        │
│  │                   │ │                   │ │                   │        │
│  │ #EXTINF:4.000,    │ │                   │ │                   │        │
│  │ segment_0000.ts   │ │                   │ │                   │        │
│  │ #EXTINF:4.000,    │ │                   │ │                   │        │
│  │ segment_0001.ts   │ │                   │ │                   │        │
│  │ ...               │ │                   │ │                   │        │
│  │ #EXT-X-ENDLIST    │ │                   │ │                   │        │
│  └───────────────────┘ └───────────────────┘ └───────────────────┘        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: View Counting and CDN Caching (6-8 minutes)

### Batched View Count Updates

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     View Count Batching Flow                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User watches video                                                         │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Redis INCR views:pending:{videoId}                                 │   │
│  │  (Atomic increment, no DB hit)                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ├───▶ Optionally store view metadata for analytics                   │
│        │     (userId, timestamp, quality) in Redis list                     │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Background Job (every 60 seconds)                                  │   │
│  │  ─────────────────────────────────                                  │   │
│  │                                                                     │   │
│  │  1. SCAN for all views:pending:* keys                               │   │
│  │  2. For each key:                                                   │   │
│  │     - GETSET key to 0 (atomically get current and reset)           │   │
│  │     - If count > 0:                                                 │   │
│  │       - UPDATE videos SET view_count = view_count + count           │   │
│  │       - Invalidate video cache                                      │   │
│  │       - Update trending score                                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Trending Score Calculation                                         │   │
│  │  ─────────────────────────────                                      │   │
│  │                                                                     │   │
│  │  Score = viewDelta * decayFactor                                    │   │
│  │                                                                     │   │
│  │  decayFactor = 0.5^(ageHours/24)                                    │   │
│  │  (Score halves every 24 hours)                                      │   │
│  │                                                                     │   │
│  │  Store in Redis sorted sets:                                        │   │
│  │  - ZINCRBY trending:global score videoId                            │   │
│  │  - ZINCRBY trending:{category} score videoId                        │   │
│  │  - ZREMRANGEBYRANK trending:global 0 -1001 (keep top 1000)          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Multi-Tier CDN Caching Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     CDN Caching Architecture                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Edge Tier (Closest to users)                                       │   │
│  │  ────────────────────────────                                       │   │
│  │  TTL: 1 hour                                                        │   │
│  │  Stale-while-revalidate: 5 minutes                                  │   │
│  │  Cacheable responses: 200, 206 (partial content)                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼ Cache miss                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Regional Tier (POPs)                                               │   │
│  │  ────────────────────                                               │   │
│  │  TTL: 24 hours                                                      │   │
│  │  Min freshness: 1 hour                                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼ Cache miss                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Origin Shield (Single cache layer facing origin)                   │   │
│  │  ─────────────────────────────────────────────────                  │   │
│  │  Aggregates requests from all regional POPs                         │   │
│  │  Reduces origin load by 95%                                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Origin (MinIO/S3)                                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Caching rules:** HLS segments (.ts) cached 7 days (immutable), manifests (.m3u8) cached 5 minutes. Range requests supported for seeking. Popular content pre-warmed by prefetching first 10 segments per quality to all edge POPs.

---

## 6. Deep Dive: Recommendation System (5-6 minutes)

### Hybrid Recommendation Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Recommendation Flow                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User requests home feed                                                    │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Parallel Candidate Generation                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                    │
│        ├──────────────┬──────────────┬──────────────┐                      │
│        ▼              ▼              ▼              ▼                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │Collabor- │  │Content-  │  │Subscrib- │  │Trending  │                   │
│  │ative     │  │Based     │  │tion Feed │  │          │                   │
│  │Filter    │  │Filter    │  │          │  │          │                   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘                   │
│       │             │             │             │                          │
│       └─────────────┴─────────────┴─────────────┘                          │
│                          │                                                  │
│                          ▼                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Merge & Deduplicate                                                │   │
│  │  - Build candidate map by videoId                                   │   │
│  │  - Track which sources contributed each video                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                          │                                                  │
│                          ▼                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Score & Rank                                                       │   │
│  │  - Apply source weights                                             │   │
│  │  - Calculate engagement quality                                     │   │
│  │  - Apply freshness decay                                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                          │                                                  │
│                          ▼                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Return top N videos                                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Collaborative filtering** finds users with similar watch patterns (5+ overlapping videos with >50% completion), then recommends what those users watched. **Content-based filtering** extracts category preferences from 30-day watch history and finds unwatched videos in preferred categories weighted by engagement ratio.

### Final Scoring Formula

| Source | Weight | Additional Factors |
|--------|--------|--------------------|
| Subscribed channel | +100 | Engagement quality: likes/(likes+dislikes+1) * 40 |
| Collaborative filter | +50 | Freshness decay: score *= e^(-ageHours/48) |
| Content-based filter | +30 | (48-hour half-life) |
| Trending | +20 | |

---

## 7. Database Schema and Indexes (4-5 minutes)

### Core Tables

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PostgreSQL Schema                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  videos                                                              │   │
│  │  ──────                                                              │   │
│  │  id VARCHAR(11) PRIMARY KEY       -- YouTube-style 11-char ID       │   │
│  │  channel_id UUID FK → users                                          │   │
│  │  title VARCHAR(100)                                                  │   │
│  │  description TEXT                                                    │   │
│  │  duration_seconds INTEGER                                            │   │
│  │  status VARCHAR(20) DEFAULT 'processing'                             │   │
│  │  visibility VARCHAR(20) DEFAULT 'public'                             │   │
│  │  view_count BIGINT DEFAULT 0                                         │   │
│  │  like_count, dislike_count, comment_count BIGINT                     │   │
│  │  categories TEXT[]                                                   │   │
│  │  tags TEXT[]                                                         │   │
│  │  thumbnail_url TEXT                                                  │   │
│  │  published_at TIMESTAMP                                              │   │
│  │                                                                     │   │
│  │  Indexes:                                                           │   │
│  │  - (channel_id, published_at DESC)          -- Channel videos       │   │
│  │  - (published_at DESC) WHERE status='ready' -- Public feed          │   │
│  │  - GIN(categories)                          -- Category search      │   │
│  │  - GIN(tags)                                -- Tag search           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  video_resolutions                                                  │   │
│  │  ─────────────────                                                  │   │
│  │  video_id VARCHAR(11) FK                                            │   │
│  │  resolution VARCHAR(10)                                             │   │
│  │  manifest_url TEXT                                                  │   │
│  │  bitrate INTEGER                                                    │   │
│  │  width, height INTEGER                                              │   │
│  │  PRIMARY KEY (video_id, resolution)                                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  comments                                                            │   │
│  │  ────────                                                            │   │
│  │  id UUID PRIMARY KEY                                                 │   │
│  │  video_id VARCHAR(11) FK                                             │   │
│  │  user_id UUID FK                                                     │   │
│  │  parent_id UUID FK → comments (nullable, for threading)              │   │
│  │  text TEXT                                                           │   │
│  │  like_count INTEGER DEFAULT 0                                        │   │
│  │  is_edited BOOLEAN DEFAULT FALSE                                     │   │
│  │                                                                     │   │
│  │  Indexes:                                                           │   │
│  │  - (video_id, created_at DESC)              -- Video comments       │   │
│  │  - (parent_id) WHERE parent_id IS NOT NULL  -- Replies              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  watch_history                                                      │   │
│  │  ─────────────                                                      │   │
│  │  id UUID PRIMARY KEY                                                 │   │
│  │  user_id UUID FK                                                     │   │
│  │  video_id VARCHAR(11) FK                                             │   │
│  │  watch_duration_seconds INTEGER DEFAULT 0                            │   │
│  │  watch_percentage DECIMAL(5,2)                                       │   │
│  │  last_position_seconds INTEGER DEFAULT 0                             │   │
│  │  watched_at TIMESTAMP                                                │   │
│  │                                                                     │   │
│  │  Indexes:                                                           │   │
│  │  - (user_id, watched_at DESC)               -- User history         │   │
│  │  - (video_id, watch_percentage)             -- Recommendation query │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Redis Data Structures

| Key Pattern | Type | Purpose |
|-------------|------|---------|
| views:pending:{videoId} | STRING | Buffered view count (flushed every minute) |
| trending:global / trending:{category} | ZSET | Trending videos (score = views * decay) |
| session:{sessionId} | HASH | User session data |
| video:{videoId} | JSON | Cached video metadata |
| upload:{uploadId}:parts | HASH | Chunk ETags for multipart upload |

---

## 8. Trade-offs and Alternatives (4-5 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Object storage | S3/MinIO | Custom distributed FS | Scalable + cheap; CDN solves latency |
| Video format | HLS only | DASH or both | Best device compatibility; dual-format justified only at massive scale |
| Transcoding | Async RabbitMQ workers | Sync / Kafka / Lambda | Reliable with retries; Kafka better at scale but more complex |
| View counting | Redis buffer + batch flush | Sync DB / HyperLogLog | Fast writes, eventual consistency acceptable for counters |

> "Sync DB updates for view counts would serialize all writes to a single row — at 1B views/day that's ~12K writes/sec on hot videos. Redis INCR handles this trivially, and the 60-second flush delay is invisible to users. HyperLogLog is tempting for unique view counts but only gives approximations — we use it alongside exact counters, not as a replacement."

---

## 9. Monitoring and Observability (2-3 minutes)

Key Prometheus metrics: `video_uploads_total{status}` (upload success/failure), `transcode_queue_depth` (pending jobs gauge), `transcode_duration_seconds{resolution}` (processing time histogram), `video_views_total{quality}` (views by quality), `cache_hit_ratio` (CDN/Redis effectiveness).

**Critical alerts:** Transcode queue > 200 jobs, transcode failure rate > 15%, API p95 > 2s, CDN cache hit ratio < 70%.

---

## 10. Summary

The backend handles 500 hours/minute of video through: **chunked S3 uploads** with Redis progress tracking, **async RabbitMQ transcoding** producing multi-resolution HLS segments, **Redis-buffered view counts** with periodic DB flushes, **multi-tier CDN** reducing origin load to 5%, and **hybrid recommendations** combining collaborative filtering, content-based filtering, and trending. All services are stateless and horizontally scalable.

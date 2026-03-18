# Design Netflix - Architecture

## System Overview

Netflix is a video streaming platform with personalized content discovery. Core challenges involve video encoding, adaptive streaming, and large-scale personalization.

**Learning Goals:**
- Build adaptive bitrate streaming
- Design personalization systems
- Implement A/B testing infrastructure
- Handle global content delivery

---

## Requirements

### Functional Requirements

1. **Stream**: Watch video with adaptive quality
2. **Browse**: Personalized homepage and search
3. **Profiles**: Multiple viewing profiles per account
4. **Resume**: Continue watching across devices
5. **Experiment**: A/B test features and content

### Non-Functional Requirements

- **Latency**: < 2 seconds to start playback
- **Availability**: 99.99% for streaming
- **Scale**: 200M subscribers, 15% of global internet traffic
- **Quality**: Up to 4K HDR streaming
- **Storage**: Petabytes of encoded video across thousands of titles

---

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Subscribers | 200M+ |
| Concurrent streams | ~10M peak |
| Titles in catalog | ~15,000 |
| Encoding variants per title | ~1,200 (resolutions x bitrates x codecs x audio tracks) |
| Total stored video | ~10 PB |
| Bandwidth served | ~15% of downstream internet traffic in US |
| Viewing hours/day | ~160M hours |
| API requests/sec | ~500K |
| Homepage generates/sec | ~100K |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Accounts | 1-5 |
| Profiles | 1-10 |
| Catalog titles | 10-50 (seeded) |
| Concurrent streams | 1-3 |
| API requests/sec | < 10 |

---

# Layer 1: Production-Ready Architecture

This layer describes how Netflix works at scale -- the ideal architecture that handles 200M subscribers, petabytes of video, and 15% of global internet traffic.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client Layer                                │
│     Smart TV │ Mobile │ Web │ Gaming Console │ Set-top Box          │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ ABR Player   │  │ UI Shell     │  │ DRM Module   │              │
│  │ (DASH/HLS)   │  │ (React/      │  │ (Widevine/   │              │
│  │              │  │  Native)     │  │  FairPlay)   │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
         │ Video Streams                    │ API Calls
         ▼                                  ▼
┌──────────────────┐              ┌──────────────────────────┐
│  Open Connect    │              │      API Gateway         │
│  CDN (OCA)       │              │  (Zuul / Spring Cloud)   │
│                  │              │                          │
│  ISP-embedded    │              │  - Rate limiting         │
│  appliances      │              │  - Auth validation       │
│  ~16,000 servers │              │  - Request routing       │
│  in ~6,000 ISPs  │              │  - A/B test headers      │
└──────────────────┘              └──────────────────────────┘
                                            │
                    ┌───────────────────────┬┴──────────────────────┐
                    ▼                       ▼                       ▼
        ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
        │  Playback        │   │  Personalization  │   │  Account         │
        │  Service         │   │  Service          │   │  Service         │
        │                  │   │                  │   │                  │
        │  - Manifest gen  │   │  - Homepage rows  │   │  - Auth/Sessions │
        │  - DRM license   │   │  - Recommendations│  │  - Profiles      │
        │  - Stream URL    │   │  - Search/Browse  │   │  - Billing       │
        │  - Progress      │   │  - A/B testing    │   │  - Preferences   │
        └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
                 │                      │                       │
     ┌───────────┴───────────┐         │              ┌────────┴────────┐
     ▼                       ▼         ▼              ▼                 ▼
┌──────────┐        ┌──────────┐  ┌──────────┐  ┌──────────┐   ┌──────────┐
│ Cassandra│        │ S3/Open  │  │ EVCache  │  │PostgreSQL│   │  Redis   │
│ (viewing │        │ Connect  │  │ (Memcache│  │ (accounts│   │ (sessions│
│  history)│        │ Origin   │  │  cluster)│  │  billing)│   │  locks)  │
└──────────┘        └──────────┘  └──────────┘  └──────────┘   └──────────┘
```

```
                        Video Pipeline (Offline)

┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Content     │───▶│  Transcoding │───▶│  Packaging   │───▶│  CDN         │
│  Ingestion   │    │  (Cosmos)    │    │  (DASH/HLS)  │    │  Distribution│
│              │    │              │    │              │    │              │
│  Mezzanine   │    │  Parallel    │    │  DRM encrypt │    │  Push to     │
│  file upload │    │  per-shot    │    │  Manifest    │    │  Open Connect│
│  QC checks   │    │  encoding    │    │  generation  │    │  appliances  │
│              │    │  ~1200       │    │              │    │              │
│              │    │  variants    │    │              │    │              │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

---

## Core Components

### 1. Video Pipeline: Ingestion to CDN

The video pipeline is Netflix's most distinctive infrastructure component. Content moves through four stages:

**Ingestion**: Studios upload mezzanine files (uncompressed or high-bitrate masters, often 4K HDR at 100+ Mbps). Automated quality-control checks validate resolution, color space, audio tracks, and subtitle sync before accepting content into the pipeline.

**Transcoding (Cosmos)**: Netflix's per-title encoding optimizes bitrate ladders individually for each title. A cartoon requires fewer bits at 1080p than a visually complex action film. The encoding system:
- Analyzes each shot for complexity (motion, texture, color depth)
- Runs parallel encodes across resolutions (240p through 4K HDR)
- Tests multiple codecs: H.264 (broadest compatibility), H.265/HEVC (better compression), VP9 (royalty-free), AV1 (best compression, growing device support)
- Produces ~1,200 variants per title (resolution x bitrate x codec x audio format)

**Packaging**: Encoded files are segmented into 2-4 second chunks for adaptive streaming. Each segment is independently decodable, enabling mid-stream quality switches. DRM encryption (Widevine for Android/Chrome, FairPlay for Apple, PlayReady for Windows) is applied per-segment. DASH and HLS manifests are generated listing all available quality levels with their segment URLs.

**CDN Distribution**: Encoded content is pushed to Open Connect Appliances (OCAs) -- custom-built servers embedded inside ISP networks worldwide. Netflix operates ~16,000 OCAs in ~6,000 ISP locations. Content popularity algorithms predict what to cache where, pre-filling OCAs during off-peak hours.

### 2. Adaptive Bitrate Streaming

The client player manages quality selection using bandwidth estimation and buffer management:

**Bandwidth estimation** uses a hybrid approach:
- Measures download time for each video segment
- Applies exponential weighted moving average (EWMA) to smooth short-term fluctuations
- Factors in buffer level -- if buffer is healthy (>30 seconds), can be more aggressive with quality

**Quality selection algorithm**:
1. Estimate available bandwidth from recent segment downloads
2. Select highest quality whose bitrate is below estimated bandwidth (with safety margin)
3. If buffer is low (<10 seconds), drop quality aggressively to prevent rebuffering
4. If buffer is full (>60 seconds), allow gradual quality increase
5. Avoid rapid oscillation by requiring sustained bandwidth improvement before upgrading

**Buffer management** targets a 60-second buffer. The player pre-fetches segments during stable playback but reduces buffer targets on mobile (to save data) and increases them on TVs (more stable connections).

### 3. Recommendation Engine

Netflix's personalization system generates unique homepages for each of 200M+ subscriber profiles. The system uses multiple algorithmic approaches:

**Collaborative filtering**: Identifies users with similar viewing patterns. If users A and B both watched and rated shows 1, 2, 3 similarly, and user A also watched show 4, recommend show 4 to user B. Netflix uses matrix factorization techniques on implicit signals (watch duration, completion rate) rather than explicit ratings.

**Content-based filtering**: Analyzes metadata (genre, cast, director, themes, mood, pacing) and visual features extracted by computer vision models. Recommends content with similar attributes to what the user has enjoyed.

**Deep learning models**: Transformer-based models process a user's viewing sequence to predict the next likely watch. These models capture temporal patterns (what people watch after documentaries, viewing patterns by time of day, seasonal preferences).

**Homepage row generation** produces 40-75 rows per profile, each a horizontal carousel:
- "Continue Watching" -- in-progress content ranked by recency and predicted completion probability
- "Because You Watched [Title]" -- similar content based on the specific title
- "Trending Now" -- popularity-weighted by region and time
- Genre rows personalized by affinity (a user who watches lots of thrillers sees Thriller rows higher)
- "Top 10" -- regional popularity rankings
- "New Releases" -- recency-weighted with personalized ordering within the row

Recommendations are precomputed offline (batch ML pipelines running hourly) and cached. Real-time re-ranking happens at request time based on context (time of day, device, recent activity).

### 4. Profile Management

Each account supports up to 5 profiles with independent:
- Viewing history and recommendations
- Maturity settings (kids profiles restrict content to age-appropriate ratings)
- Language and subtitle preferences
- My List (watchlist)
- Playback settings (autoplay next episode, data usage preferences)

Kids profiles enforce strict content filtering at the API level -- maturity-restricted content never appears in responses, regardless of how the request is formed.

### 5. Content Catalog (Metadata Service)

The metadata service manages all non-video content data:
- Titles, descriptions, cast, crew, genres (structured and tag-based)
- Artwork: Netflix generates and A/B tests multiple poster images per title, selecting the most clicked variant per user segment
- Availability: Region-locked content based on licensing agreements
- Maturity ratings mapped to country-specific systems

This service handles ~500K reads/sec with aggressive caching (EVCache/Memcached clusters). Writes are infrequent (content catalog changes slowly) and propagate through eventual consistency.

### 6. Search

Search uses Elasticsearch with custom analyzers for:
- **Title matching**: Fuzzy matching to handle typos ("Straner Things" finds "Stranger Things")
- **Auto-suggest**: Prefix completion with personalized ranking (user's genre preferences influence ordering)
- **Faceted search**: Filter by genre, year, rating, availability
- **Relevance scoring**: Combines text match score with personalization score (a thriller fan's search for "dark" ranks thriller results higher)

At production scale, the search cluster handles ~50K queries/sec with p99 latency under 200ms. Elasticsearch indexes are sharded by language/region.

### 7. A/B Testing (Experimentation Platform)

Netflix runs hundreds of concurrent experiments affecting every aspect of the product. The experimentation platform provides:

**Consistent allocation**: Users are assigned to experiment variants using deterministic hashing (murmurhash of userId + experimentId). This ensures the same user always sees the same variant, even across devices and sessions.

**Orthogonal experiment layers**: Multiple experiments run simultaneously without interference. Each experiment operates in its own "layer," so a user can be in variant A of experiment 1 and variant B of experiment 2 without correlation.

**Feature flags**: Experiments gate feature rollouts. A new UI component starts at 1% rollout, increases to 5%, 25%, 50%, then 100% over weeks, with automatic rollback if error metrics spike.

**Metrics pipeline**: Every experiment tracks key metrics -- streaming hours, search success rate, title-level engagement, member retention. Statistical significance is computed using sequential testing to allow early stopping.

### 8. Playback: Progress Tracking and Resume

Viewing progress is tracked at per-profile, per-content granularity:
- Position updates sent every 30 seconds during playback
- Progress persisted to Cassandra (high-write throughput, partition key = profileId)
- Resume position served from cache (Redis/EVCache) for fast playback start
- Content marked "completed" at >95% progress
- Series advance to next episode automatically

The "Continue Watching" row requires merging progress data with content metadata and applying recency/completion-probability ranking -- a computationally expensive operation that is precomputed and cached.

### 9. DRM and Content Protection

Content protection operates at multiple levels:

**Device registration**: Each account has a limit on registered devices (varies by subscription tier). Device attestation verifies the client is a genuine Netflix application.

**Concurrent stream limits**: Basic plan allows 1 simultaneous stream, Standard allows 2, Premium allows 4. Enforced by a distributed counter service with eventual consistency (brief overages are tolerated for availability).

**DRM licensing**: When playback starts, the client requests a DRM license from the license server. The license contains decryption keys for the content, bound to the specific device. Licenses have short TTLs (hours) and are renewed during playback.

**Watermarking**: Invisible forensic watermarks embedded in video streams allow Netflix to trace leaked content back to the specific account and device.

### 10. Observability and Chaos Engineering

**Observability** at Netflix scale requires:
- Atlas (custom time-series database) for metrics -- handles billions of data points/sec
- Distributed tracing across hundreds of microservices
- Real-time anomaly detection on streaming quality metrics
- Per-title, per-region, per-device-type dashboards
- Alerting on SLO violations (rebuffer rate > 0.5%, start-up time > 3s)

**Chaos engineering** (Simian Army / Chaos Monkey) continuously tests resilience:
- Chaos Monkey: Randomly terminates instances in production to verify redundancy
- Chaos Kong: Simulates entire region failures
- FIT (Failure Injection Testing): Introduces specific failure modes (latency, errors) between services
- The philosophy: "If Netflix can't handle random failures in production, it will certainly fail during real outages"

### 11. Failure Handling

| Failure | Impact | Mitigation |
|---------|--------|------------|
| CDN appliance down | Users on that ISP lose local cache | Fallback to upstream OCA or origin; peer OCAs in same ISP |
| Recommendation service timeout | Homepage shows stale data | Precomputed fallback rows cached per-profile; generic "Popular" rows as last resort |
| Playback service down | Cannot start new streams | Circuit breaker; client retries with backoff; cached manifest allows continued playback of already-started content |
| Database partition | Writes may fail | Cassandra multi-DC replication; eventual consistency acceptable for viewing history |
| Region failure | All services in region down | Zuul routes traffic to surviving regions; stateless services enable cross-region failover |

---

## Database Schema

### Production Database Strategy

| Store | Technology | Data | Access Pattern |
|-------|-----------|------|----------------|
| Account/billing data | PostgreSQL (multi-region) | accounts, profiles, subscriptions | Low-write, strong consistency, ACID transactions |
| Viewing history | Cassandra | watch history, progress | High-write, time-ordered, partition by profileId |
| Content metadata | PostgreSQL + EVCache | titles, seasons, episodes, genres | Read-heavy, heavily cached |
| Sessions | Redis cluster | auth tokens, device sessions | High-read/write, TTL-based expiry |
| Recommendations | Redis + offline storage | precomputed row data | Read-heavy, refreshed hourly |
| Search index | Elasticsearch | title, description, cast, genre | Full-text search, faceted queries |
| Experiment allocations | Cassandra or DynamoDB | experiment-profile-variant mappings | High-read, consistent hashing for allocation |
| Analytics/metrics | Kafka + Druid/Spark | streaming events, QoE metrics | Write-heavy, batch + real-time processing |

### Schema (Used in Both Layers)

The SQL schema below runs locally in PostgreSQL but is designed with production-ready constraints and indexes.

```sql
-- Accounts (main user accounts)
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    subscription_tier VARCHAR(50) DEFAULT 'standard',
    country VARCHAR(10) DEFAULT 'US',
    is_admin BOOLEAN DEFAULT FALSE,
    role VARCHAR(50) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Profiles (multiple per account)
CREATE TABLE profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(500),
    is_kids BOOLEAN DEFAULT FALSE,
    maturity_level INTEGER DEFAULT 4,  -- 1-4, 4 = all content
    language VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Videos (movies and series)
CREATE TABLE videos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('movie', 'series')),
    release_year INTEGER,
    duration_minutes INTEGER,
    rating VARCHAR(10),
    maturity_level INTEGER DEFAULT 4,
    genres TEXT[] DEFAULT '{}',
    description TEXT,
    poster_url VARCHAR(500),
    backdrop_url VARCHAR(500),
    trailer_url VARCHAR(500),
    popularity_score FLOAT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Seasons (for series)
CREATE TABLE seasons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL,
    title VARCHAR(200),
    description TEXT,
    release_year INTEGER,
    episode_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Episodes
CREATE TABLE episodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    season_id UUID NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL,
    duration_minutes INTEGER,
    description TEXT,
    thumbnail_url VARCHAR(500),
    video_key VARCHAR(500),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Video files (multiple quality versions per content)
CREATE TABLE video_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    episode_id UUID REFERENCES episodes(id) ON DELETE CASCADE,
    quality VARCHAR(20) NOT NULL,     -- 240p, 360p, 480p, 720p, 1080p, 4k
    bitrate INTEGER,                   -- in kbps
    width INTEGER,
    height INTEGER,
    video_key VARCHAR(500) NOT NULL,   -- S3/MinIO key
    file_size_bytes BIGINT,
    codec VARCHAR(50) DEFAULT 'h264',
    container VARCHAR(20) DEFAULT 'mp4',
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK (video_id IS NOT NULL OR episode_id IS NOT NULL)
);

-- Viewing progress (for continue watching / resume)
CREATE TABLE viewing_progress (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    episode_id UUID REFERENCES episodes(id) ON DELETE CASCADE,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    last_watched_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK (video_id IS NOT NULL OR episode_id IS NOT NULL)
);

-- Unique partial indexes for upsert on progress
CREATE UNIQUE INDEX idx_viewing_progress_movie
  ON viewing_progress(profile_id, video_id) WHERE episode_id IS NULL;
CREATE UNIQUE INDEX idx_viewing_progress_episode
  ON viewing_progress(profile_id, episode_id) WHERE video_id IS NULL;

-- Watch history (completed views)
CREATE TABLE watch_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    episode_id UUID REFERENCES episodes(id) ON DELETE CASCADE,
    watched_at TIMESTAMP DEFAULT NOW()
);

-- My List (user's watchlist)
CREATE TABLE my_list (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(profile_id, video_id)
);

-- Experiments (A/B testing)
CREATE TABLE experiments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    allocation_percent INTEGER DEFAULT 100,
    variants JSONB NOT NULL DEFAULT '[]',
    target_groups JSONB DEFAULT '{}',
    metrics TEXT[] DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'draft'
      CHECK (status IN ('draft', 'active', 'paused', 'completed')),
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Experiment allocations
CREATE TABLE experiment_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    variant_id VARCHAR(100) NOT NULL,
    allocated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(experiment_id, profile_id)
);

-- Sessions
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    token VARCHAR(500) NOT NULL UNIQUE,
    device_info JSONB,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_profiles_account ON profiles(account_id);
CREATE INDEX idx_seasons_video ON seasons(video_id);
CREATE INDEX idx_episodes_season ON episodes(season_id);
CREATE INDEX idx_video_files_video ON video_files(video_id);
CREATE INDEX idx_video_files_episode ON video_files(episode_id);
CREATE INDEX idx_viewing_progress_profile ON viewing_progress(profile_id);
CREATE INDEX idx_viewing_progress_last_watched
  ON viewing_progress(profile_id, last_watched_at DESC);
CREATE INDEX idx_watch_history_profile ON watch_history(profile_id);
CREATE INDEX idx_my_list_profile ON my_list(profile_id);
CREATE INDEX idx_videos_genres ON videos USING GIN(genres);
CREATE INDEX idx_videos_popularity ON videos(popularity_score DESC);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_account ON sessions(account_id);
```

---

## API Design

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account with default profile |
| POST | `/api/auth/login` | Authenticate, create session, set httpOnly cookie |
| POST | `/api/auth/logout` | Invalidate session, clear cookie |
| GET | `/api/auth/me` | Return current session info (account + profile) |

### Profiles

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/profiles` | List all profiles for account |
| POST | `/api/profiles` | Create profile (max 5 per account) |
| PUT | `/api/profiles/:id` | Update profile settings |
| DELETE | `/api/profiles/:id` | Delete profile (not the last one) |
| POST | `/api/profiles/:id/select` | Select profile for current session |

### Video Catalog

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/videos` | List videos with type/genre/search filters |
| GET | `/api/videos/genres` | List all unique genres (cached 1hr) |
| GET | `/api/videos/trending` | Top 20 by popularity score |
| GET | `/api/videos/:id` | Video details (includes seasons/episodes for series) |
| GET | `/api/videos/:id/similar` | Genre-overlap recommendations |

### Personalized Browsing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/browse/homepage` | Personalized homepage rows (cached 5min per profile) |
| GET | `/api/browse/continue-watching` | In-progress content (5-95% complete) |
| GET | `/api/browse/my-list` | User's saved content |
| POST | `/api/browse/my-list/:videoId` | Add to My List |
| DELETE | `/api/browse/my-list/:videoId` | Remove from My List |
| GET | `/api/browse/my-list/:videoId/check` | Check if in My List |
| GET | `/api/browse/search` | Search by title, description, genre |

### Streaming

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stream/:videoId/manifest` | Streaming manifest with quality levels + resume position |
| GET | `/api/stream/:videoId/play` | Redirect to presigned MinIO/S3 stream URL |
| POST | `/api/stream/:videoId/progress` | Update viewing progress (marks completed at >95%) |
| GET | `/api/stream/:videoId/progress` | Get current progress for video/episode |
| POST | `/api/stream/:videoId/buffer` | Record buffer event (QoE metric) |
| POST | `/api/stream/:videoId/error` | Record playback error (QoE metric) |

### Experimentation

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/experiments` | List all experiments |
| GET | `/api/experiments/:id` | Get experiment details |
| POST | `/api/experiments` | Create experiment (min 2 variants, weights sum to 100) |
| PUT | `/api/experiments/:id/status` | Update status (draft/active/paused/completed) |
| GET | `/api/experiments/:id/allocation` | Get/create variant allocation for profile |
| POST | `/api/experiments/allocations` | Get all active experiment allocations for profile |

---

## Key Design Decisions

### CDN Strategy: Open Connect vs Third-Party CDN

Netflix built its own CDN (Open Connect) rather than using Akamai/CloudFront because video streaming has unique requirements that general-purpose CDNs handle poorly. Video segments are large (2-10 MB each), access patterns are predictable (popularity follows a power law), and bandwidth costs at Netflix's scale make per-GB pricing unsustainable.

Open Connect appliances are placed inside ISP networks, meaning video traffic never traverses expensive peering links. This reduces Netflix's bandwidth costs by an estimated 90% compared to commercial CDN pricing, while simultaneously improving quality for users (fewer network hops = lower latency and jitter). The trade-off is massive operational complexity: Netflix must manage hardware deployments across thousands of ISPs worldwide, handle appliance failures, and coordinate content pre-positioning. For a company where streaming quality directly drives subscriber retention, this investment is justified.

### Per-Title Encoding vs Fixed Bitrate Ladder

Traditional streaming uses a fixed bitrate ladder (e.g., 720p always at 2350 kbps). Netflix's per-title encoding analyzes each title's visual complexity to determine the optimal bitrate for each resolution. A simple animated show might look perfect at 720p/1500 kbps, while a visually dense action film needs 720p/3000 kbps.

This approach reduces total storage and bandwidth by ~20% without quality loss -- substantial savings at petabyte scale. The trade-off is encoding time: per-title analysis requires multiple encode passes with quality metrics computation, making the encoding pipeline 5-10x slower than fixed-ladder encoding. Since content is encoded once and served millions of times, this is a clear win. The complexity cost is in the encoding orchestration system (Cosmos), which must manage thousands of parallel encoding jobs with dependency tracking.

### Cassandra for Viewing History vs PostgreSQL

Viewing history writes are extremely high-volume (~10M concurrent viewers, each sending progress updates every 30 seconds = ~300K writes/sec). PostgreSQL can handle this with connection pooling and write batching, but scaling becomes expensive (vertical scaling + read replicas).

Cassandra is purpose-built for this access pattern: writes are append-only (no read-before-write), data is partitioned by profileId (natural partition key), queries are always by profileId + time range, and multi-datacenter replication is built in. The trade-off is query flexibility -- Cassandra requires knowing the partition key upfront, making ad-hoc analytics queries impossible without a separate analytics pipeline. For viewing progress, where the only access pattern is "get recent progress for profile X," this limitation is acceptable.

### Precomputed Recommendations vs Real-Time

Homepage generation involves running ML models, aggregating viewing history, fetching content metadata, and ranking results -- operations that take 100ms-1s. With 100K+ homepage requests/sec, computing recommendations in real-time for every request is infeasible.

Netflix precomputes recommendations offline (hourly batch jobs) and stores results in cache. When a user opens the app, the homepage loads from cache in <50ms. Real-time signals (what the user just watched) are applied as lightweight re-ranking on top of precomputed results, not full recomputation. The trade-off is freshness: a title the user just completed might still appear in recommendations for up to an hour. Netflix accepts this because the cost of stale recommendations (minor user annoyance) is far less than the cost of real-time computation (either massive infrastructure or degraded latency).

---

## Consistency and Idempotency

**Viewing progress updates** are idempotent by design -- the same position update applied twice produces the same result (upsert on profile_id + content_id). This is critical because clients retry progress updates on network failures.

**Experiment allocation** uses deterministic hashing (murmurhash of profileId + experimentId). The same input always produces the same variant assignment, making allocation inherently idempotent. This also ensures consistency across devices -- a user sees the same experiment variant on their phone and TV.

**My List operations** use `ON CONFLICT DO NOTHING` for adds and are naturally idempotent for deletes.

**Session creation** generates a UUID token on each login. If a login request is retried, a new session is created (the old one eventually expires). This is acceptable because session storage is cheap and multiple active sessions per account are allowed.

---

## Security / Auth

**Authentication**: Session-based with httpOnly cookies. Tokens stored in Redis with 7-day TTL. Sessions include device metadata for audit trails.

**Authorization**: Role-based access control (RBAC) with 6 roles:
- `viewer` -- browse, watch, manage own profiles
- `kids_viewer` -- browse/watch kids content only (enforced at query level)
- `account_owner` -- all viewer + billing and profile management
- `admin` -- full access
- `content_admin` -- video upload and metadata management
- `experiment_admin` -- A/B test creation and analysis

**Rate limiting**: Redis-based sliding window rate limiting, tiered by endpoint category:

| Category | Limit | Window |
|----------|-------|--------|
| Browse/Search | 100 req | 1 min |
| Playback Start | 30 req | 1 min |
| Profile Updates | 20 req | 1 min |
| Progress Updates | 60 req | 1 min |
| Auth (login) | 5 req | 5 min |

Auth endpoints use strict rate limiting (both IP-based and account-based). Rate limit fails open (allows requests) when Redis is unavailable -- availability over security for non-auth endpoints.

**Content protection**: At production scale, DRM (Widevine/FairPlay/PlayReady) encrypts video segments, device attestation validates clients, concurrent stream limits are enforced by distributed counters, and forensic watermarks trace leaks.

---

## Observability

**Prometheus metrics** (implemented with prom-client):
- HTTP request duration and count (by method, route, status code)
- Streaming QoE: starts, buffer events, playback errors, bitrate distribution, active sessions
- Circuit breaker state (closed/half-open/open), failures, successes per service
- Database query duration and connection pool status
- Cache hit/miss rates
- Rate limit exceeded counts
- Background job executions and duration

**Structured logging** (implemented with Pino):
- Domain-specific child loggers: auth, streaming, circuit breaker, job execution
- Log levels: error for failures, warn for rate limits and circuit breaker events, info for significant operations, debug for routine events
- Request context (accountId, profileId, path) attached to all log entries

**Health checks** (three levels):
- `/health` -- liveness probe (is the process running?)
- `/health/ready` -- readiness probe (all dependencies healthy?)
- `/health/details` -- detailed status including circuit breaker states, connection pool stats, process memory

---

## Failure Handling

**Circuit breakers** (implemented with Opossum) protect against cascade failures:

| Service | Timeout | Error Threshold | Reset Timeout |
|---------|---------|-----------------|---------------|
| Storage (MinIO/S3) | 8s | 50% | 30s |
| Redis | 2s | 50% | 15s |
| Cassandra/DB | 5s | 50% | 30s |
| CDN | 10s | 40% | 60s |

When a circuit opens, requests fail immediately without calling the downstream service, giving it time to recover. The half-open state allows a single probe request to test recovery.

**Retry with exponential backoff** (implemented in `utils/retry.ts`):
- Configurable max retries, base delay, maximum delay, and backoff multiplier
- Jitter (random 0-100ms) prevents thundering herd on recovery
- Retryable error classification (ECONNRESET, ETIMEDOUT, 429, 5xx)
- Idempotency key support for safe retries of non-idempotent operations

**Graceful shutdown**: SIGTERM/SIGINT handlers stop accepting new connections, allow in-flight requests 10 seconds to complete, then exit.

**Data retention**: Background job runs every 24 hours to clean up old viewing data:
- Completed viewing progress older than 90 days: deleted
- Watch history older than 2 years: archived to cold storage, then deleted
- Archived data older than 5 years: permanently deleted
- Profile data deletion for GDPR/CCPA requests

---

## Scalability Considerations

### What Breaks First

1. **Homepage generation** -- personalization queries are expensive. Solution: precompute and cache per-profile, invalidate on significant events (new watch, new content).

2. **Viewing progress writes** -- 300K writes/sec overwhelms PostgreSQL. Solution: Cassandra with profileId partition key, eventual consistency.

3. **CDN cache misses** -- long-tail content not cached on local OCA. Solution: tiered caching (local OCA -> regional OCA -> origin), popularity-based pre-filling.

4. **Search at scale** -- 50K queries/sec with personalized ranking. Solution: Elasticsearch cluster sharded by language/region, separate personalization re-ranking layer.

### Horizontal Scaling Path

- **API servers**: Stateless (sessions in Redis), scale horizontally behind load balancer
- **PostgreSQL**: Read replicas for catalog queries, separate write primary for accounts
- **Cassandra**: Add nodes to ring, data rebalances automatically
- **Redis**: Redis Cluster for sharding sessions across nodes
- **Elasticsearch**: Add shards/replicas as query volume grows
- **CDN**: Deploy more OCAs to ISPs based on regional demand

### Sharding Strategy

| Data | Shard Key | Rationale |
|------|-----------|-----------|
| Viewing history | profileId | All queries scoped to one profile |
| Experiment allocations | experimentId + profileId | Consistent hashing per experiment |
| Content metadata | Not sharded (fits in memory with caching) | Read-heavy, small dataset (~15K titles) |
| Sessions | token hash | Uniform distribution across Redis cluster |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| CDN | Open Connect (custom) | Akamai/CloudFront | 90% cost reduction, ISP-level proximity, control over hardware |
| Encoding | Per-title bitrate ladder | Fixed bitrate ladder | ~20% bandwidth savings, better quality per bit |
| Viewing history store | Cassandra | PostgreSQL | Handles 300K writes/sec, natural partition by profileId |
| Recommendations | Precomputed + cache | Real-time ML inference | <50ms homepage load vs 100ms-1s computation |
| Session storage | Redis + httpOnly cookies | JWT | Immediate revocation, server-side control |
| Search | Elasticsearch | PostgreSQL full-text | Fuzzy matching, faceted search, relevance tuning |
| A/B allocation | Deterministic hash | Random assignment | Consistent across devices, reproducible |
| DRM | Multi-DRM (Widevine/FairPlay/PlayReady) | Single DRM | Required for cross-platform device support |
| Streaming protocol | DASH + HLS | Single protocol | DASH for most devices, HLS required for Apple |
| Rate limiting | Redis sliding window | In-memory token bucket | Distributed, consistent across server instances |

---

# Layer 2: Pocket-Size Architecture (Local Implementation)

This layer documents what we actually built with Docker + Node.js + Express + React, how it maps to the production design above, and what was simplified or omitted.

---

## Local Architecture Diagram

```
┌────────────────────────────┐
│      React Frontend        │
│    (Vite, port 5173)       │
│                            │
│  ┌──────────┐ ┌──────────┐│
│  │ Browse   │ │ Video    ││
│  │ Page     │ │ Player   ││
│  │          │ │          ││
│  │ HeroBnr  │ │ Quality  ││
│  │ VideoRow │ │ Selector ││
│  │ CntWatch │ │ Progress ││
│  └──────────┘ └──────────┘│
│  Zustand stores (auth,    │
│   browse, player)          │
└────────────┬───────────────┘
             │ HTTP (fetch)
             ▼
┌────────────────────────────┐
│    Express API Server      │
│    (Node.js, port 3001)    │
│                            │
│  Routes:                   │
│   /api/auth/*              │
│   /api/profiles/*          │
│   /api/videos/*            │
│   /api/browse/*            │
│   /api/stream/*            │
│   /api/experiments/*       │
│                            │
│  Middleware:               │
│   rate-limit, rbac, auth   │
│                            │
│  Services:                 │
│   circuit-breaker, metrics │
│   health, logger, retry    │
│                            │
│  /health    /metrics       │
└─────┬──────┬──────┬────────┘
      │      │      │
      ▼      ▼      ▼
┌────────┐┌───────┐┌────────┐
│Postgres││ Redis ││ MinIO  │
│ :5432  ││ :6379 ││ :9000  │
│        ││(Valk.)││        │
│accounts││session││videos  │
│profiles││cache  ││thumbs  │
│videos  ││rate   ││        │
│progress││limits ││        │
│history ││       ││        │
│a/b test││       ││        │
└────────┘└───────┘└────────┘
```

All three infrastructure services run via `docker-compose up -d`. The backend runs as a single Express process (can be started on ports 3001-3003 for distributed testing). The frontend is served by Vite's dev server.

---

## What Was Actually Built

### Frontend (React + TypeScript + Vite + Tailwind)

**Pages implemented**:
- `LoginPage` -- email/password authentication
- `ProfilesPage` -- profile selection grid (Netflix-style "Who's watching?")
- `BrowsePage` -- personalized homepage with hero banner + horizontal rows
- `VideoDetailPage` -- title details with seasons/episodes for series
- `WatchPage` -- video player with quality selection and progress tracking
- `SearchPage` -- search with real-time results
- `MyListPage` -- user's saved content

**Key components**:
- `HeroBanner` -- featured content with backdrop image and action buttons
- `VideoRow` -- horizontal scrollable carousel of video cards
- `ContinueWatchingRow` -- special row showing progress bars
- `VideoCard` -- thumbnail card with hover state
- `VideoPlayer` -- full-screen player with control bar, quality selector, volume control, progress bar, and center play button
- `Navbar` -- top navigation with profile switcher and search

**State management**: Three Zustand stores (`authStore`, `browseStore`, `playerStore`) handle global state. API calls are centralized in `services/` directory.

### Backend (Node.js + Express + TypeScript)

**All 6 route modules implemented**:
- `auth` -- login, register, logout, session restore
- `profiles` -- CRUD with max-5 limit, profile selection stored in Redis session
- `videos` -- catalog with filtering, genre listing, similar-content recommendations
- `browse` -- personalized homepage generation with 8 row types (continue watching, my list, trending, genre rows, "because you watched," new releases, TV shows, movies)
- `streaming` -- manifest generation with quality list, presigned URL playback via MinIO, progress tracking with completion detection
- `experiments` -- A/B test CRUD, consistent hash allocation (MD5-based murmurhash), bulk allocation retrieval

**Production-grade patterns actually implemented**:

1. **Circuit breakers** (Opossum, `services/circuit-breaker.ts`) -- wraps storage, Redis, and database calls. Tracks state transitions in Prometheus metrics. Provides pre-configured breakers per service with appropriate timeouts. The `withFallback` helper enables graceful degradation.

2. **Prometheus metrics** (prom-client, `services/metrics.ts`) -- 15 custom metrics covering HTTP requests, streaming QoE (starts, buffers, errors, bitrate, active sessions), circuit breaker state, database queries, cache operations, rate limiting, and background jobs. Exposed at `/metrics` for scraping.

3. **Structured logging** (Pino, `services/logger.ts`) -- domain-specific child loggers for auth, streaming, circuit breaker, and job execution. Context-enriched log entries with accountId, profileId, and error details. HTTP request logging via pino-http.

4. **Health checks** (`services/health.ts`) -- three-tier health checking (liveness, readiness, detailed). Readiness probe checks PostgreSQL, Redis, and MinIO in parallel. Detailed endpoint includes circuit breaker states and connection pool stats. Results cached for 5 seconds to prevent health check storms.

5. **Rate limiting** (`middleware/rate-limit.ts`) -- Redis-based sliding window algorithm with tiered limits per endpoint category. Strict rate limiting (IP + account based) for auth endpoints. Fails open when Redis is unavailable. Sets standard `X-RateLimit-*` headers. Supports tiered limits based on subscription level.

6. **RBAC** (`middleware/rbac.ts`) -- 6-role permission system with hierarchical permission checking. Kids profile enforcement at the middleware level. Profile ownership validation. Generic resource ownership middleware.

7. **Retry with backoff** (`utils/retry.ts`) -- exponential backoff with jitter, retryable error classification, idempotency key support with in-memory cache and TTL-based expiry.

8. **Data retention** (`jobs/watch-history-retention.ts`) -- background job for cleaning old viewing progress, archiving watch history with batch processing and `SKIP LOCKED` for concurrent safety, GDPR/CCPA profile data deletion.

9. **Graceful shutdown** -- SIGTERM/SIGINT handlers in `index.ts` stop the server, cancel background jobs, and allow 10 seconds for in-flight requests.

---

## What Was Simplified or Substituted

| Production | Local | Simplification |
|-----------|-------|----------------|
| Open Connect CDN (~16K servers) | MinIO (single instance) | Videos served via presigned URLs from local MinIO |
| DASH/HLS adaptive streaming | JSON manifest listing qualities | No actual segment-based streaming; manifest lists available bitrates with direct file URLs |
| Per-title video encoding (Cosmos) | Pre-encoded sample videos uploaded manually | No transcoding pipeline; video_files table lists qualities but files are manually placed |
| Cassandra for viewing history | PostgreSQL | Single PostgreSQL handles all data; fine for dev scale |
| EVCache (distributed Memcached) | Redis (single instance) | Redis handles sessions, caching, and rate limiting |
| Elasticsearch for search | PostgreSQL ILIKE queries | `WHERE title ILIKE '%term%'` -- no fuzzy matching, no relevance tuning |
| Collaborative/deep learning recommendations | Genre-overlap similarity | "Similar" = shares genres, ranked by overlap count. "Because you watched" = same query. No ML. |
| DRM (Widevine/FairPlay/PlayReady) | None | Videos served unencrypted via presigned URLs |
| Device registration + concurrent stream limits | None | No device tracking or stream limit enforcement |
| Multi-region deployment | Single machine | Everything runs on localhost |
| API Gateway (Zuul) | Express middleware | Rate limiting, auth, and routing in the same process |
| Murmurhash for experiment allocation | MD5-based hash | `crypto.createHash('md5')` used as deterministic hash function |
| Artwork personalization (A/B tested posters) | Static poster URLs | Single poster per title |
| Real-time metrics pipeline (Atlas) | Prometheus endpoint | Metrics collected but no Grafana dashboards or alerting configured |
| Chaos engineering (Simian Army) | None | No fault injection testing |

---

## What Was Omitted

- **Video transcoding pipeline** -- no encoding, segmenting, or codec support
- **Actual adaptive bitrate switching** -- player UI has quality selector but no ABR algorithm
- **DRM and content protection** -- no encryption, device attestation, or watermarking
- **Multi-region / multi-datacenter** -- single machine deployment
- **CDN content positioning** -- no popularity-based cache filling
- **ML recommendation models** -- no collaborative filtering, embedding vectors, or deep learning
- **Artwork personalization** -- no per-user poster selection
- **Real-time experiment metrics** -- allocation works but no metrics collection pipeline
- **Admin dashboard** -- RBAC middleware exists but no admin UI
- **Kubernetes / container orchestration** -- Docker Compose only
- **Billing / subscription management** -- subscription_tier column exists but not enforced
- **Chaos engineering** -- no Chaos Monkey or fault injection
- **Analytics pipeline** -- no Kafka, Spark, or Druid for event processing

---

## Frontend Architecture

This section describes how the React frontend is structured and why each architectural decision was made.

### Component Hierarchy

```
App (TanStack Router + auth init)
├── LoginPage
├── ProfilesPage (profile selection grid)
├── BrowsePage
│   ├── Navbar (global nav: search, profiles, notifications)
│   ├── HeroBanner (featured content with backdrop, metadata, Play/Info buttons)
│   ├── ContinueWatchingRow (progress bars, episode info, resume links)
│   └── VideoRow[] (horizontal scrollable rows per genre/category)
│       └── VideoCard[] (poster, hover preview, My List toggle)
├── VideoDetailPage (title details, episodes, similar titles)
├── WatchPage
│   └── VideoPlayer (full-screen playback)
│       ├── TopBar (title + back navigation)
│       ├── CenterPlayButton (large play/pause overlay)
│       └── ControlBar
│           ├── ProgressBar (seek, buffered indicator)
│           ├── VolumeControl (slider + mute toggle)
│           └── QualitySelector (resolution picker)
├── SearchPage (query-driven results grid)
└── MyListPage (saved titles grid)
```

### Zustand Stores

Netflix uses three domain-separated Zustand stores, each responsible for a distinct concern. Zustand was chosen over React Context because Context triggers re-renders on every consumer when any value changes, while Zustand uses selector-based subscriptions so components only re-render when the specific slice of state they use changes. This matters when a video player updates `currentTime` 30 times per second -- without selector isolation, every component in the tree would re-render.

**`authStore`** manages authentication state: the current account, selected profile, profile list, and loading/error states. Netflix supports multiple viewing profiles per account, so this store handles both account-level auth (login/logout/register) and profile-level selection (selectProfile/clearProfile). The `checkAuth` action restores session state on page load by calling the backend's `/auth/me` endpoint, enabling seamless page refreshes without re-login. Profile selection is stored server-side in the session, so switching devices preserves the active profile.

**`browseStore`** manages content discovery: personalized homepage rows, continue watching items, My List, search results, and available genres. This store is the data layer for the browse experience. Homepage rows come from the backend's personalization service, which generates rows like "Because you watched X" and "Trending Now." The store separates homepage loading from My List loading because they have different lifecycles -- the homepage refreshes on profile switch, while My List updates optimistically when the user adds/removes a title. The `addToMyList` and `removeFromMyList` actions immediately update local state for responsive UI, then sync with the server. If the server request fails, the local state is stale until the next load.

**`playerStore`** manages playback state: play/pause, current quality, volume/mute, current time, duration, buffered amount, fullscreen, and controls visibility. This store also handles streaming manifest loading and progress saving. The manifest contains available quality levels with URLs; the player defaults to 720p and allows manual quality switching. Progress is saved to the server every 10 seconds during playback and on component unmount, enabling the "Continue Watching" feature. The store tracks both `videoId` and `episodeId` to support series playback with episode-level resume. A `reset` action cleans up all state when navigating away from the player.

### TanStack Router Structure

Netflix uses a programmatic (code-defined) router rather than file-based routing. The route tree is defined in `App.tsx` with explicit `createRoute` calls.

| Path | Component | Purpose |
|------|-----------|---------|
| `/` | Redirect | Checks auth, redirects to `/login`, `/profiles`, or `/browse` |
| `/login` | LoginPage | Email/password authentication |
| `/register` | LoginPage | Account creation (reuses login UI) |
| `/profiles` | ProfilesPage | Profile selection (Netflix-style avatar grid) |
| `/browse` | BrowsePage | Homepage with personalized rows |
| `/browse/series` | BrowsePage | Series-filtered browse |
| `/browse/movies` | BrowsePage | Movie-filtered browse |
| `/video/$videoId` | VideoDetailPage | Title details, episodes, similar |
| `/watch/$videoId` | WatchPage | Full-screen player with `?episodeId=` search param |
| `/search?q=` | SearchPage | Query-driven search results |
| `/my-list` | MyListPage | User's saved titles |

The index route (`/`) uses `beforeLoad` to check auth state from the Zustand store and redirect appropriately. This avoids rendering any page content before determining where the user belongs. The watch route uses `validateSearch` to type-check the `episodeId` search parameter, enabling direct deep links to specific episodes.

### Data Fetching Pattern

The frontend uses a service layer (`services/`) that wraps `fetch` calls with consistent error handling, cookie credentials, and JSON parsing. Each service module corresponds to a backend domain: `auth.ts` (login/logout/register/profiles), `videos.ts` (homepage, search, My List, genres), and `streaming.ts` (manifests, progress updates). Zustand store actions call service methods and update state. Components call store actions in `useEffect` hooks on mount. There is no React Query or SWR -- the stores act as a simple cache that components populate on mount. This is adequate for Netflix's navigation pattern where pages are visited sequentially (browse -> detail -> watch) rather than rapidly switched between.

### Key UI Patterns

**Video Player** -- The player is decomposed into a main `VideoPlayer` component that orchestrates sub-components (`TopBar`, `CenterPlayButton`, `ControlBar`) and a custom `useVideoPlayerControls` hook. The hook handles keyboard shortcuts (Space for play/pause, arrow keys for skip/volume, M for mute, F for fullscreen, Escape to exit), mouse-based auto-hiding of controls (3-second idle timeout), and fullscreen toggle via the Fullscreen API. This separation keeps the main component focused on video element management and progress tracking, while the hook encapsulates input handling logic that would otherwise clutter the render function.

**Horizontal Scroll Rows** -- Each `VideoRow` implements Netflix's signature horizontal carousel with arrow navigation. Arrow buttons appear on hover and scroll by 80% of the visible width with smooth scrolling. Scroll position is tracked to conditionally show/hide left and right arrows, avoiding dead-end visual cues. The rows use native CSS `overflow-x: auto` rather than a virtualized list because each row contains at most 20-30 cards, making DOM performance a non-issue.

**Continue Watching Row** -- A specialized row variant that shows progress bars (percentage complete), time remaining, and episode information for series. Each card links directly to the watch page with the correct `episodeId` search parameter, enabling one-click resume.

**Hero Banner** -- The featured content banner uses CSS gradients (`from-black/80 via-black/40 to-transparent` horizontal and `from-netflix-black via-transparent to-transparent` vertical) to ensure text readability over dynamic backdrop images. The banner occupies 80vh to create the immersive "above-the-fold" experience.

---

## Deep Pattern Explanations

This section explains the production-grade patterns implemented in this project. Each pattern is described from first principles -- what problem it solves, how it works mechanically, and why it was chosen over alternatives.

### RBAC (Role-Based Access Control)

RBAC is a security model where access to system resources is determined by a user's assigned role, rather than attaching permissions directly to individual users. The problem it solves: without RBAC, you would need to check individual user IDs against every protected resource, making authorization logic scattered, error-prone, and impossible to audit. When a new admin joins the team, you would have to update hundreds of permission entries instead of assigning one role.

**How it works in this project:** Netflix defines six roles organized in a hierarchy: `viewer`, `kids_viewer`, `account_owner`, `admin`, `content_admin`, and `experiment_admin`. Each role implies a set of permissions. The middleware chain processes each request through three stages:

1. **Authentication** -- The `authenticate` middleware extracts the session token from the HTTP-only cookie, looks up the session in Redis, and attaches the user object (including their role) to the request. If no valid session exists, the request is rejected with 401.

2. **Role check** -- The `ensureRole` middleware compares the user's role against the minimum required role for the endpoint. For example, uploading content requires `content_admin`, while browsing requires only `viewer`. This check is a single string comparison against a role hierarchy.

3. **Resource-level authorization** -- Some operations require additional checks beyond role. For example, a profile can only be modified by the account that owns it. This is checked in the route handler after the role check passes.

The role hierarchy means higher roles inherit lower role permissions. An `admin` can do everything an `account_owner` can, plus admin-specific operations. This avoids maintaining explicit permission matrices. The `kids_viewer` role is enforced at the database query level -- content queries automatically filter by maturity rating when the active profile is a kids profile.

### Redis Cache-Aside Pattern

The cache-aside pattern (also called "lazy loading") solves a fundamental performance problem: database queries are slow compared to in-memory lookups. A typical PostgreSQL query takes 2-10ms (parsing, planning, disk I/O, network round-trip), while a Redis `GET` takes 0.05-0.2ms -- a 20-100x improvement. At Netflix's scale of 500K API requests per second, this difference is the difference between needing 50 database servers and needing 5.

**How it works mechanically:**

1. **Check cache first** -- When a request arrives for video metadata, the service calls `cache.get('video:${videoId}')`. Redis responds in ~0.1ms with either the cached JSON or null.

2. **Cache miss** -- If Redis returns null (the data isn't cached), the service queries PostgreSQL: `SELECT * FROM videos WHERE id = $1`. This takes ~5ms. The service then stores the result in Redis with a TTL: `cache.set('video:${videoId}', JSON.stringify(video), 300)` (5-minute TTL for video metadata, 10-minute for channel info).

3. **Cache hit** -- If Redis returns data, the service parses the JSON and returns it immediately, skipping the database entirely.

4. **Invalidation** -- When data changes (video metadata updated, subscriber count changed), the service deletes the cache key: `cache.del('video:${videoId}')`. The next read will miss the cache and re-fetch from the database, populating a fresh cache entry.

**Why Redis instead of in-memory caching (a JavaScript Map or LRU cache):** In-memory caches are per-process. When running multiple API server instances behind a load balancer, each instance would have its own cache with different data. A user's request might hit server A (cached) then server B (not cached), causing inconsistent latency. Worse, invalidation becomes impossible -- when server A updates data, server B's cache still holds stale data. Redis provides a shared cache visible to all server instances, with atomic operations for safe concurrent access. The trade-off is network latency (~0.1ms per Redis call), but this is negligible compared to the database query it replaces.

### Circuit Breaker Pattern

A circuit breaker prevents cascading failures across services. The problem: when a downstream service (e.g., MinIO storage, Redis cache) becomes slow or unresponsive, every request that depends on it will hang for the full timeout period (typically 10-30 seconds). If your API server has 100 concurrent request slots and 50 of them are waiting on a dead storage service, only 50 slots remain for healthy requests. Eventually, all slots are consumed waiting on the dead service, and the entire API becomes unresponsive -- even for requests that don't need storage at all. This is a cascading failure.

**How the circuit breaker works (three states):**

1. **CLOSED** (normal) -- Requests flow through to the downstream service normally. The breaker tracks the recent error rate (typically using a rolling window of the last N requests).

2. **OPEN** (tripped) -- When the error rate exceeds a threshold (e.g., 50% of the last 10 requests failed), the breaker "opens." All subsequent requests fail immediately with a predefined error (no network call to the downstream service). This is the key insight: failing fast in 1ms is better than waiting 30 seconds for a timeout. The open state lasts for a configurable reset timeout (e.g., 30 seconds for storage, 15 seconds for Redis).

3. **HALF-OPEN** (testing) -- After the reset timeout expires, the breaker enters half-open state and allows a single probe request through. If the probe succeeds, the breaker closes (service recovered). If it fails, the breaker opens again for another reset period.

**Netflix's circuit breaker configuration:**

| Service | Timeout | Error Threshold | Reset Timeout |
|---------|---------|-----------------|---------------|
| Storage (MinIO/S3) | 8s | 50% | 30s |
| Redis | 2s | 50% | 15s |
| Cassandra/DB | 5s | 50% | 30s |
| CDN | 10s | 40% | 60s |

The implementation uses Opossum (a Node.js circuit breaker library) which wraps async functions and monitors their success/failure rates. When a circuit opens, the Prometheus gauge `circuit_breaker_state` changes value, enabling alerting.

### Structured Logging

Structured logging replaces `console.log` with machine-parseable JSON log entries. The problem with `console.log` at scale: when running 50 API server instances, each producing thousands of log lines per second, unstructured text logs like `"User 123 viewed video 456"` become unsearchable. You cannot filter, aggregate, or alert on them. Finding a specific user's request across thousands of concurrent requests requires manual text search through millions of lines.

**How structured logging works:** Instead of `console.log("User login failed")`, the application logs:

```json
{"level":"error","time":1710500000,"msg":"login_failed","email":"user@example.com","reason":"invalid_password","requestId":"abc-123","ip":"192.168.1.1"}
```

Every log entry is a JSON object with consistent fields: `level` (error/warn/info/debug), `time` (Unix timestamp), `msg` (event name), and arbitrary context fields. This enables:

- **Filtering**: Find all errors in the last hour: `level == "error" AND time > now() - 3600`
- **Correlation**: Trace a single request across all log entries: `requestId == "abc-123"`
- **Aggregation**: Count login failures per IP address to detect brute-force attacks
- **Alerting**: Trigger alerts when `msg == "circuit_breaker_opened"` or error rate exceeds threshold

Netflix uses Pino for structured logging because it is the fastest JSON logger in Node.js (benchmarked at 5-10x faster than Winston). Pino achieves this by writing JSON directly to stdout with zero synchronous processing, deferring log formatting to a separate transport process. Child loggers (auth, streaming, circuit breaker) inherit the parent's configuration while adding domain-specific context fields.

### Prometheus Metrics

Prometheus is a metrics collection system that enables monitoring, alerting, and capacity planning. The core problem: without metrics, you cannot answer "how is the system performing right now?" or "what changed before the outage started?" Logs tell you what happened; metrics tell you how much and how fast.

**Three metric types used:**

1. **Counter** -- A monotonically increasing number. Example: `http_requests_total` counts every HTTP request, labeled by method, route, and status code. You cannot know the current request rate from a single counter value, but you can compute it by measuring the rate of change: `rate(http_requests_total[5m])` gives requests per second over 5 minutes.

2. **Histogram** -- Records the distribution of values. Example: `http_request_duration_seconds` records how long each request takes, bucketed by duration (0.01s, 0.05s, 0.1s, 0.5s, 1s, 5s). From a histogram, you can compute percentiles: p50 (median latency), p95 (95th percentile), p99. This is critical because averages hide problems -- an average latency of 50ms could mean 95% of requests take 10ms while 5% take 850ms.

3. **Gauge** -- A value that goes up and down. Example: `circuit_breaker_state` (0=closed, 1=half-open, 2=open) or `db_pool_connections` (current active connections).

**RED method:** Netflix tracks Rate (requests/sec), Errors (5xx responses/sec), and Duration (latency percentiles) for every service endpoint. This gives a complete picture of service health with just three metrics. If the rate drops, users may be unable to reach the service. If errors spike, something is failing. If duration increases, the service is degrading.

### Rate Limiting

Rate limiting controls how many requests a client can make within a time window. Without rate limiting, a single misbehaving client (buggy app, malicious actor, or bot) can overwhelm the API server, causing slow responses or outages for all other users.

**Sliding window algorithm (used in this project):** The implementation uses Redis sorted sets. Each request adds a timestamp entry to the user's sorted set. On each new request, the algorithm: (1) removes entries older than the window, (2) counts remaining entries, (3) rejects the request if the count exceeds the limit. This provides smooth, accurate rate enforcement without burst abuse.

**Why sliding window over token bucket:** Token bucket allows accumulated tokens -- a user inactive for 10 minutes could accumulate 1000 tokens and fire them all at once, creating a spike that overwhelms downstream services. Sliding window prevents this by counting requests within a rolling time window, regardless of when they occurred. The trade-off is slightly higher Redis overhead (sorted set operations vs. simple INCR), which is negligible.

Netflix uses tiered rate limits by endpoint: strict limits on auth endpoints (5/5min to prevent brute-force), moderate on content browsing (100/min), and relaxed on progress updates (60/min since these are automated). Auth endpoints use both IP-based and account-based rate limiting to catch both distributed and single-source attacks. When Redis is unavailable, rate limiting fails open -- meaning requests are allowed through -- because blocking all API traffic due to a cache outage is worse than briefly allowing unlimited requests.

### Idempotency

Idempotency ensures that performing the same operation multiple times produces the same result as performing it once. The problem: network communication is unreliable. When a client sends a request to save viewing progress and receives a timeout, it doesn't know whether the server processed the request or not. Without idempotency, retrying the request could create duplicate records, double-count views, or corrupt data.

Netflix achieves idempotency through several mechanisms:

- **Viewing progress** uses upsert semantics (`ON CONFLICT (profile_id, content_id) DO UPDATE`). Whether the client sends the same progress update once or five times, the database row ends up with the same value.
- **Experiment allocation** uses deterministic hashing (murmurhash of profileId + experimentId). The same input always produces the same variant, making allocation inherently idempotent and consistent across devices.
- **My List operations** use `ON CONFLICT DO NOTHING` for additions -- adding a title that's already in the list is silently ignored. Deletions are naturally idempotent because deleting a non-existent row is a no-op.

### Health Checks

Health checks are HTTP endpoints that report the operational status of a service. They serve two distinct purposes in production:

**Liveness probes** (`/health`) answer "is the process running and able to handle requests?" If a liveness probe fails, the orchestrator (Kubernetes, ECS, or a load balancer) restarts the process. Liveness probes must be cheap and fast -- they should not call external dependencies, because a slow database should not cause the process to be restarted. Netflix's liveness probe simply returns 200 if the Express server is accepting connections.

**Readiness probes** (`/health/ready`) answer "is the service ready to serve traffic?" A service can be alive but not ready -- for example, it's still establishing database connections or loading configuration. If a readiness probe fails, the load balancer stops routing traffic to that instance (but does not restart it). Netflix's readiness probe checks PostgreSQL connectivity and Redis connectivity. If either is unreachable, the instance reports not ready and stops receiving traffic until the dependency recovers.

Netflix adds a third level (`/health/details`) that returns comprehensive diagnostics: circuit breaker states for each downstream service, connection pool statistics, process memory usage, and uptime. This endpoint is used by operators for debugging, not by automated routing.

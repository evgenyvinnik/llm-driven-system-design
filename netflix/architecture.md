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

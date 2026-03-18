# Design Apple TV+ - Architecture

## System Overview

Apple TV+ is a premium video streaming service delivering original content with high-quality video, adaptive streaming, and cross-device experience. Core challenges involve video transcoding, global content delivery, DRM protection, and personalization.

**Learning Goals:**
- Build video ingestion and transcoding pipelines
- Design adaptive bitrate streaming
- Implement global CDN strategies
- Handle DRM and content protection

---

## Requirements

### Functional Requirements

1. **Stream**: Watch video content with adaptive quality
2. **Browse**: Discover content through recommendations and search
3. **Download**: Save content for offline viewing
4. **Continue**: Resume playback across devices
5. **Share**: Family sharing and user profiles

### Non-Functional Requirements

- **Quality**: Support 4K HDR with Dolby Vision/Atmos
- **Latency**: < 2s to start playback
- **Availability**: 99.99% for streaming
- **Scale**: Millions of concurrent streams

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Content Ingestion                            │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │ Master Files  │  │  Transcoder   │  │   Packager    │       │
│  │               │  │               │  │               │       │
│  │ - 4K masters  │──▶│ - Multi-res   │──▶│ - HLS chunks  │       │
│  │ - Audio stems │  │ - Multi-codec │  │ - Manifests   │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Origin Storage                               │
│     (Encrypted HLS segments, manifests, DRM keys)               │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  CDN Edge A   │    │  CDN Edge B   │    │  CDN Edge C   │
│  (us-west)    │    │  (eu-west)    │    │  (ap-east)    │
└───────────────┘    └───────────────┘    └───────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Client Layer                               │
│      Apple TV │ iPhone │ iPad │ Mac │ Web │ Smart TV            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway                                │
│        (Auth, rate limiting, routing, geo-enforcement)          │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Content       │    │ Playback      │    │ Recommendation│
│ Service       │    │ Service       │    │ Service       │
│               │    │               │    │               │
│ - Catalog     │    │ - Manifests   │    │ - Personalized│
│ - Metadata    │    │ - Progress    │    │ - Trending    │
│ - Search      │    │ - DRM         │    │ - Continue    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Redis/Valkey    │   Object Storage (S3)     │
│   - Catalog     │   - Sessions      │   - Video segments        │
│   - Users       │   - Cache         │   - Thumbnails            │
│   - Progress    │   - Rate limits   │   - Master files          │
│   - Downloads   │   - Watch state   │                           │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Video Transcoding Pipeline

The ingestion pipeline takes 4K master files and produces multiple encoded variants for adaptive streaming. Each master is encoded into a ladder of resolutions and bitrates:

| Resolution | Codec | Bitrate | HDR | Target Device |
|------------|-------|---------|-----|---------------|
| 2160p (4K) | HEVC | 25 Mbps | Dolby Vision | Apple TV 4K |
| 2160p | HEVC | 15 Mbps | HDR10 | Smart TVs |
| 1080p | HEVC | 8 Mbps | SDR | iPad, Mac |
| 1080p | H.264 | 6 Mbps | SDR | Older devices |
| 720p | H.264 | 3 Mbps | SDR | iPhone cellular |
| 480p | H.264 | 1.5 Mbps | SDR | Low bandwidth |

Encoding is distributed across worker clusters. Each resolution/codec combination runs as an independent job, enabling parallelism. Per-scene quality optimization (VMAF-based) adjusts bitrate allocation -- action sequences get more bits, static dialog scenes get fewer.

After encoding, the packager segments each variant into 6-second HLS chunks (`.ts` files) and generates variant playlists. Audio tracks (multiple languages, Dolby Atmos) and subtitles are packaged separately.

### 2. Adaptive Streaming (HLS)

The master manifest lists all available quality variants. The client's ABR algorithm selects the appropriate variant based on:

- **Available bandwidth** (measured from segment download times)
- **Buffer health** (maintain 30s buffer target)
- **Device capabilities** (4K HDR only on capable hardware)
- **Battery state** (reduce quality on low battery)

The manifest includes audio groups (language tracks) and subtitle groups, allowing independent selection. Codec strings in the manifest (`hvc1.2.4.L150.B0` for Dolby Vision HEVC) enable clients to filter unsupported variants before attempting playback.

### 3. Content Delivery Network

A multi-tier CDN architecture minimizes latency:

1. **Edge nodes** (city-level): Cache popular content, serve 95%+ of requests
2. **Regional shields**: Aggregate cache misses before hitting origin
3. **Origin storage**: S3/MinIO with all content, accessed only on cache misses

Predictive pre-positioning pushes new release content to edge nodes before launch. Cache keys include content ID and variant ID; manifests have short TTLs (60s) while segments have long TTLs (24h).

Geographic licensing enforcement happens at the API layer -- the CDN serves segments to any authenticated request, but the API refuses to issue manifest URLs for content not licensed in the user's region.

### 4. DRM Protection (FairPlay)

Content is encrypted with AES-128 per-segment keys. The playback flow:

1. Client requests manifest URL from API (includes playback token)
2. Client downloads manifest from CDN
3. Before decrypting segments, client sends SPC (Server Playback Context) to license server
4. License server validates playback token, device authorization, and subscription
5. Server returns CKC (Content Key Context) containing the decryption key encrypted for the specific device's Secure Element
6. Client decrypts and plays segments

Device-specific licenses enable per-device revocation and download limits (max 25 offline downloads per account).

### 5. Watch Progress Sync

Watch progress uses a last-write-wins (LWW) strategy with client-side timestamps for conflict resolution. When a user watches on their iPhone and later switches to Apple TV, the most recent position wins:

```sql
INSERT INTO watch_progress (..., client_timestamp, ...)
ON CONFLICT (profile_id, content_id)
DO UPDATE SET
  position = CASE
    WHEN watch_progress.client_timestamp < $new_timestamp THEN $new_position
    ELSE watch_progress.position
  END,
  client_timestamp = GREATEST(watch_progress.client_timestamp, $new_timestamp);
```

"Continue Watching" shows content where `position > 60s` AND `progress < 90%`, ordered by `updated_at DESC`.

### 6. Recommendations

The recommendation engine generates multiple content rows for the home screen:

- **Continue Watching**: In-progress content (profile-specific)
- **Because You Watched X**: Content similar to recently completed shows
- **Trending**: Popular content weighted by recent view velocity
- **New Releases**: Recently added content matching profile genre preferences
- **For Kids** (kids profiles): Age-appropriate content only

### 7. Offline Downloads

Download management enforces account-wide limits (25 downloads) and time-based license expiry (30 days). The download manifest includes all segments for a selected quality tier plus audio and subtitle tracks. Expired downloads require re-licensing, which checks subscription status.

---

## Database Schema

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  subscription_tier VARCHAR(50) DEFAULT 'free' CHECK (subscription_tier IN ('free', 'monthly', 'yearly')),
  subscription_expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User profiles (multiple profiles per user for family sharing)
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  is_kids BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_profiles_user ON user_profiles(user_id);

-- User devices
CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  device_name VARCHAR(255),
  device_type VARCHAR(50),
  active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

CREATE INDEX idx_devices_user ON user_devices(user_id);

-- Content catalog
CREATE TABLE content (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  duration INTEGER NOT NULL, -- seconds
  release_date DATE,
  content_type VARCHAR(20) CHECK (content_type IN ('movie', 'series', 'episode')),
  series_id UUID REFERENCES content(id) ON DELETE SET NULL,
  season_number INTEGER,
  episode_number INTEGER,
  rating VARCHAR(10),
  genres TEXT[],
  thumbnail_url VARCHAR(500),
  banner_url VARCHAR(500),
  master_resolution VARCHAR(20),
  hdr_format VARCHAR(20),
  status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'disabled')),
  featured BOOLEAN DEFAULT false,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_content_type ON content(content_type);
CREATE INDEX idx_content_series ON content(series_id, season_number, episode_number);
CREATE INDEX idx_content_featured ON content(featured) WHERE featured = true;
CREATE INDEX idx_content_status ON content(status);

-- Encoded variants (different quality/codec versions)
CREATE TABLE encoded_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  resolution INTEGER NOT NULL,
  codec VARCHAR(20) NOT NULL,
  hdr BOOLEAN DEFAULT false,
  bitrate INTEGER NOT NULL, -- kbps
  file_path VARCHAR(500),
  file_size BIGINT,
  encoding_time INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_variants_content ON encoded_variants(content_id);

-- Video segments (HLS chunks)
CREATE TABLE video_segments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES encoded_variants(id) ON DELETE CASCADE,
  segment_number INTEGER NOT NULL,
  duration DECIMAL NOT NULL,
  segment_url VARCHAR(500),
  byte_size INTEGER
);

CREATE INDEX idx_segments_content ON video_segments(content_id, variant_id);

-- Audio tracks
CREATE TABLE audio_tracks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  codec VARCHAR(20),
  channels INTEGER DEFAULT 2,
  file_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audio_content ON audio_tracks(content_id);

-- Subtitles
CREATE TABLE subtitles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  type VARCHAR(20) DEFAULT 'subtitle' CHECK (type IN ('caption', 'subtitle')),
  file_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_subtitles_content ON subtitles(content_id);

-- Watch progress
CREATE TABLE watch_progress (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, -- seconds
  duration INTEGER NOT NULL,
  completed BOOLEAN DEFAULT false,
  client_timestamp BIGINT, -- For last-write-wins conflict resolution
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_progress_profile ON watch_progress(profile_id, updated_at DESC);

-- Watch history (completed views)
CREATE TABLE watch_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  watched_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_history_profile ON watch_history(profile_id, watched_at DESC);

-- Downloads
CREATE TABLE downloads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  quality VARCHAR(20),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'downloading', 'completed', 'expired')),
  license_expires TIMESTAMP,
  downloaded_at TIMESTAMP,
  last_played TIMESTAMP
);

CREATE INDEX idx_downloads_user ON downloads(user_id);
CREATE INDEX idx_downloads_expires ON downloads(license_expires);

-- Watchlist (My List)
CREATE TABLE watchlist (
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_watchlist_profile ON watchlist(profile_id, added_at DESC);

-- Content ratings by users
CREATE TABLE content_ratings (
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  rated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_ratings_content ON content_ratings(content_id);

-- Audit log for security-relevant events
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id VARCHAR(255),
  content_id UUID REFERENCES content(id) ON DELETE SET NULL,
  ip_address VARCHAR(45),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_event ON audit_log(event, created_at DESC);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
```

### Schema Design Rationale

**Self-referential content table**: The `content` table stores movies, series, and episodes in a single table. Episodes reference their parent series via `series_id`. This enables a single query to fetch a series with all its episodes, ordered by `(season_number, episode_number)`.

**Profile-level watch state**: Watch progress and watchlists are keyed by `profile_id`, not `user_id`. Each family member has independent watch history. The primary key `(profile_id, content_id)` ensures one progress record per content per profile.

**Encoded variants + segments**: The two-table split (`encoded_variants` -> `video_segments`) models the HLS hierarchy. Variants describe quality levels; segments are the individual chunks. This supports manifest generation without file system inspection.

**Audit log**: Compliance-grade event logging for DRM license issuance, content access, and account changes. `ON DELETE SET NULL` preserves audit records when users or content are removed.

---

## API Design

### Content

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/content` | Browse catalog with filters |
| GET | `/api/content/:id` | Content details (episodes for series) |
| GET | `/api/content/featured` | Featured/hero content |
| GET | `/api/content/search?q=` | Search catalog |

### Streaming

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/stream/:contentId/master.m3u8` | HLS master manifest |
| GET | `/api/stream/:contentId/variant/:variantId` | Variant playlist |
| GET | `/api/stream/:contentId/segment/:segmentId` | Video segment |

### Watch Progress

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/watch/continue` | Continue Watching list |
| POST | `/api/watch/progress` | Update watch position |
| POST | `/api/watch/progress/batch` | Batch sync (offline to online) |

### Watchlist

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/watchlist` | My List |
| POST | `/api/watchlist` | Add to watchlist |
| DELETE | `/api/watchlist/:contentId` | Remove from watchlist |

### Recommendations

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/recommendations` | Personalized content rows |

### Subscription

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/subscription` | Current subscription status |
| POST | `/api/subscription` | Create/upgrade subscription |

### Admin

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/admin/stats` | Platform statistics |
| GET | `/api/admin/content` | Content management list |
| POST | `/api/admin/content` | Add new content |
| PUT | `/api/admin/content/:id` | Update content metadata |

---

## Key Design Decisions

### 1. HLS over DASH

**Decision**: Use HLS (HTTP Live Streaming) as the primary streaming format.

**Why HLS works**: Native support across all Apple devices without additional player libraries. FairPlay DRM integrates natively with HLS. Every CDN supports HLS caching. The format is well-documented with Apple's HLS Authoring Specification providing clear guidelines for encoding ladders.

**Why DASH fails for this use case**: DASH requires a third-party player on Apple devices. FairPlay DRM is HLS-only; using DASH would require Widevine, adding a second DRM system. While DASH is technically more flexible (supports more codecs), the operational overhead of maintaining two DRM systems outweighs the codec flexibility benefit for an Apple-first service.

**Trade-off**: HLS has slightly higher segment overhead than DASH (TS containers vs. fMP4), and the Apple ecosystem lock-in limits flexibility. For non-Apple devices (web, smart TVs), we serve HLS in fMP4 containers which most modern players support.

### 2. Per-Segment Encryption

**Decision**: Encrypt each HLS segment with a unique key rather than using a single content-wide key.

**Why it works**: Per-segment keys enable secure seeking -- the player only needs the key for the segment being played, not the entire file. This is required for offline playback where the device stores encrypted segments and licenses separately.

**Why single-key fails**: A single key for the entire content means compromising one key exposes the whole film. Per-segment rotation limits the damage of any single key exposure to 6 seconds of content.

**Trade-off**: More key rotation requests to the license server. We mitigate this by including multiple segment keys in each license response (key rotation window of 10 segments).

### 3. Last-Write-Wins for Watch Progress

**Decision**: Use client-side timestamps with last-write-wins (LWW) for watch progress conflict resolution rather than strong consistency.

**Why LWW works**: A user only watches on one device at a time. Conflicts are rare and low-stakes -- the worst case is resuming from a position 30 seconds off. LWW enables fast writes without distributed locks, keeping progress updates under 10ms.

**Why strong consistency fails**: Serializable transactions for every progress update (every 10 seconds during playback) would create lock contention. At millions of concurrent streams, this bottleneck would degrade playback experience for a problem (conflicting progress) that almost never occurs.

**Trade-off**: In the rare case of simultaneous playback on two devices, one device's position will be silently overwritten. The client includes `client_timestamp` so the more recent write always wins, even if it arrives at the server later.

---

## Consistency and Idempotency

### Consistency Model

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Watch progress | Eventual (LWW) | One active session per profile; conflicts rare |
| Download initiation | Strong (serializable) | Must enforce download limits accurately |
| Content ingestion | Strong (per-content) | Encoding jobs depend on consistent state |
| License grants | Strong | Security-critical; must not double-issue |
| Watchlist add/remove | Eventual | Low conflict risk; UI handles stale reads |
| Profile creation | Strong | Must enforce max profiles per account |

### Idempotency

All mutating endpoints accept an `Idempotency-Key` header. The middleware checks Redis for an existing response, returning cached results for replayed requests. Concurrent duplicates receive 409 Conflict. Cached responses expire after 24 hours.

Key idempotency patterns:
- **Download initiation**: Composite key (user + content + device + quality); existing pending/active downloads returned instead of creating duplicates
- **Watch progress**: Inherently idempotent via `ON CONFLICT` upsert with `client_timestamp` comparison
- **Transcoding jobs**: Job ID derived from content ID + profile hash; workers check completion before starting

---

## Security and Auth

### Session-Based Authentication

Sessions stored in Redis via `connect-redis` with express-session. Cookies are `httpOnly`, `sameSite: lax`, with `secure: true` in production. Session secret configured via environment variable.

### Subscription Enforcement

Streaming endpoints check subscription status before generating manifest URLs. Expired subscriptions receive a 403 with redirect to subscription management. Free-tier users can browse the catalog but cannot stream.

### Profile Management

Each account supports up to 6 profiles. Kids profiles enforce content rating filters (G, PG only) at the API layer. Profile selection is stored in the session.

---

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds` | Histogram | API latency by method, route, status |
| `playback_start_latency_seconds` | Histogram | Time to first frame by device/quality |
| `active_streams_total` | Gauge | Concurrent streams by quality/device |
| `manifest_generation_duration_seconds` | Histogram | HLS manifest build time |
| `streaming_errors_total` | Counter | Errors by type (DRM, network, codec) |
| `circuit_breaker_state` | Gauge | Health of external dependencies |
| `watch_progress_updates_total` | Counter | Sync success/conflict/error rates |
| `idempotent_requests_total` | Counter | Idempotency cache hit/miss |

### SLI/SLO Targets

| SLI | Target | Warning | Critical |
|-----|--------|---------|----------|
| Playback start latency (p95) | < 2s | > 2.5s | > 4s |
| API availability | 99.9% | < 99.5% | < 99% |
| Streaming availability | 99.99% | < 99.95% | < 99.9% |
| Manifest generation (p95) | < 100ms | > 150ms | > 300ms |
| CDN cache hit rate | > 95% | < 90% | < 80% |

### Structured Logging

JSON-formatted logs via Pino with request correlation (`requestId`), user/profile context, and separate audit logging for security events (license issuance, content access, login, device registration).

---

## Failure Handling

### Circuit Breaker Pattern

Independent circuit breakers for each external dependency:

| Service | Timeout | Error Threshold | Reset Timeout |
|---------|---------|-----------------|---------------|
| CDN | 5s | 30% | 15s |
| Transcoding | 5 min | 50% | 2 min |
| DRM | 5s | 25% | 60s |
| Storage | 10s | 40% | 30s |

**Fallback strategies:**
- **CDN failure**: Return cached content from origin or error gracefully
- **Transcoding failure**: Queue job for later; content marked as "processing"
- **DRM failure**: No fallback (license required for playback); user sees retry prompt
- **Storage failure**: Return cached metadata if available

### Graceful Degradation

- **Recommendations down**: Return static "Popular Now" content
- **Under high load**: Cap max quality at 1080p/4.5Mbps to shed load
- **CDN unhealthy**: Reduce max quality to 720p/3Mbps

### Retry Strategy

Exponential backoff with jitter for retryable errors (5xx, 429, ETIMEDOUT, ECONNRESET). Max 3 retries with base delay 100ms, max delay 10s. Non-retryable errors (4xx) fail immediately.

---

## Scalability Considerations

### What Breaks First

1. **CDN cache hit rate under new releases**: A major premiere drives millions of simultaneous requests for the same content. Solution: predictive pre-positioning to edge nodes 24h before release.

2. **Watch progress write volume**: Millions of concurrent viewers updating progress every 10 seconds. Solution: batch client-side updates, write to Redis first, flush to PostgreSQL asynchronously.

3. **Transcoding backlog**: A content library expansion could overwhelm encoding workers. Solution: autoscale workers based on queue depth, prioritize by release date.

### Horizontal Scaling Path

- **API servers**: Stateless; scale horizontally behind load balancer
- **PostgreSQL**: Read replicas for catalog queries; shard user data by `user_id`
- **Redis**: Redis Cluster with slot-based sharding
- **CDN**: Multi-CDN strategy (CloudFront + Akamai) for redundancy and geographic coverage
- **Transcoding**: Spot instances for cost-effective parallel encoding

### Multi-Region Strategy

- Active-active regions with region-local databases
- Watch progress syncs across regions with LWW conflict resolution
- Content catalog replicated asynchronously (eventual consistency acceptable)
- CDN automatically routes to healthy origins on regional failure

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Streaming format | HLS | DASH | Native Apple device support, FairPlay integration |
| DRM | FairPlay | Widevine | Native on all Apple devices |
| Encoding | HEVC + H.264 | AV1 | Broader device support today |
| CDN | Multi-CDN | Single CDN | Reliability and geographic coverage |
| Watch progress | LWW (eventual) | Strong consistency | Low conflict risk, better write latency |
| Offline | License-based (30 day) | Time-based stream | More flexible, supports subscription changes |
| Retries | Exponential backoff | Fixed interval | Prevents thundering herd on recovery |
| Circuit breaker | Per-service | Global | Isolates failures to specific dependencies |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation.

### Local Architecture

```
┌─────────────────┐         ┌─────────────────┐
│   React + Vite  │────────▶│  Express API    │
│   :5173         │  HTTP   │  :3000          │
│                 │◀────────│                 │
│ - Home (Hero)   │         │ - Auth          │
│ - Content Detail│         │ - Content CRUD  │
│ - Video Player  │         │ - Streaming     │
│ - Profile Mgmt  │         │ - Watch Progress│
│ - Watchlist     │         │ - Watchlist     │
│ - Account       │         │ - Subscriptions │
│ - Admin Panel   │         │ - Recommendations│
└─────────────────┘         │ - Admin         │
                            └────────┬─────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
     ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
     │   PostgreSQL    │    │  Valkey/Redis   │    │     MinIO       │
     │   :5432         │    │  :6379          │    │  :9000 / :9001  │
     │                 │    │                 │    │                 │
     │ - All tables    │    │ - Sessions      │    │ - videos        │
     │ - Full schema   │    │ - Idempotency   │    │ - thumbnails    │
     │ - Audit log     │    │ - Cache         │    │                 │
     └─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Production Patterns Actually Implemented

**1. Prometheus Metrics** (`backend/src/shared/metrics.ts`)

Full `/metrics` endpoint with HTTP request duration histogram, playback start latency histogram, active streams gauge, manifest generation timing, streaming error counter, and circuit breaker state gauge. Includes Node.js default metrics (CPU, memory, event loop lag). Accessible at `GET /metrics`.

**2. Structured Logging with Pino** (`backend/src/shared/logger.ts`)

JSON-formatted request logging with request correlation via `X-Request-Id` header. Child loggers carry user/profile/content context. Audit events logged for security-relevant operations (login, license issuance, content access, profile changes).

**3. Circuit Breaker (Opossum)** (`backend/src/shared/circuitBreaker.ts`)

Circuit breakers wrapping external service calls (CDN, transcoding, DRM, storage) using the `opossum` library. Configured with per-service timeouts and error thresholds. Health status exposed via `/health` endpoint and Prometheus gauge metrics.

**4. Idempotency Middleware** (`backend/src/shared/idempotency.ts`)

Global `Idempotency-Key` header support with Redis-backed response caching. 24-hour TTL. Concurrent duplicate detection via Redis lock. Watch progress uses database-level LWW via `client_timestamp` column.

**5. HLS Manifest Generation** (`backend/src/routes/streaming.ts`)

Generates HLS master playlists with quality variants from `encoded_variants` table data. Includes audio track groups and subtitle groups. Variant playlists list simulated segments. Note: actual video segments are simulated -- no real FFmpeg transcoding pipeline.

**6. Enhanced Health Checks** (`backend/src/index.ts`)

Three-tier health checks: `/health/live` (liveness), `/health/ready` (DB + Redis connectivity), `/health` (deep check with component latency and circuit breaker state).

**7. Graceful Shutdown** (`backend/src/index.ts`)

SIGTERM/SIGINT handlers that close Redis connections and drain the database pool before exit.

### What Was Simplified or Substituted

| Production Component | Local Substitute | Rationale |
|----------------------|------------------|-----------|
| CDN (multi-tier) | MinIO direct URLs | No edge caching needed locally |
| FairPlay DRM | No encryption | Requires Apple developer certificates |
| FFmpeg transcoding | Simulated variants in DB | No actual encoding pipeline |
| Video segments | Simulated HLS playlists | No real .ts segment files |
| OAuth/Apple ID | Session + bcrypt | Simpler for development |
| Geo-licensing | No region enforcement | Single-region setup |
| Multi-region DB | Single PostgreSQL | One machine |
| Message queue | Synchronous processing | No Kafka/RabbitMQ needed at local scale |

### What Was Omitted

- **Real video transcoding** -- no FFmpeg pipeline; variants are seeded into the database
- **Actual HLS segment delivery** -- manifests are generated but reference simulated URLs, not real .ts files
- **DRM/FairPlay integration** -- no content encryption or license server
- **Offline downloads** -- schema exists but no download manager or license generation
- **Cross-device sync push** -- no WebSocket/push notification when progress updates on another device
- **Real ABR client** -- video player simulates playback; no actual adaptive bitrate logic
- **CDN with edge caching** -- all content served from MinIO or simulated URLs
- **Kubernetes / auto-scaling** -- runs as single-process Express server
- **Distributed tracing** -- OpenTelemetry not integrated despite being referenced in observability design
- **Backup/restore scripts** -- documented in architecture but not implemented

# Design Apple Music - Architecture

## System Overview

Apple Music is a music streaming service with library management and recommendations. Core challenges involve audio delivery, library sync, and personalization.

**Learning Goals:**
- Build audio streaming infrastructure
- Design hybrid recommendation systems
- Implement library matching and sync
- Handle DRM and offline playback

---

## Requirements

### Functional Requirements

1. **Stream**: Play music with adaptive quality
2. **Library**: Manage personal music library
3. **Discover**: Get personalized recommendations
4. **Download**: Save music for offline
5. **Share**: Connect with friends

### Non-Functional Requirements

- **Latency**: < 200ms to start playback
- **Quality**: Up to 24-bit/192kHz lossless
- **Scale**: 100M+ subscribers
- **Catalog**: 100M+ songs
- **Availability**: 99.99% for streaming

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│      iPhone │ Mac │ Apple Watch │ HomePod │ CarPlay │ Web       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CDN                                     │
│           (Audio files, artwork, encrypted content)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│        (Rate limiting, auth, routing, TLS termination)          │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Catalog Service│    │Library Service│    │  Rec Service  │
│               │    │               │    │               │
│ - Search      │    │ - Sync        │    │ - For You     │
│ - Metadata    │    │ - Matching    │    │ - Radio       │
│ - Playback    │    │ - Uploads     │    │ - Similar     │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Elasticsearch   │      Feature Store        │
│   - Catalog     │   - Full-text     │      - User embeddings    │
│   - Libraries   │   - Lyrics        │      - Song embeddings    │
│   - History     │   - Autocomplete  │      - Audio features     │
├─────────────────┼───────────────────┼───────────────────────────┤
│  Redis/Valkey   │   Object Storage  │     Message Queue         │
│  - Sessions     │   - Audio files   │     - Play events         │
│  - Cache        │   - Artwork       │     - Sync notifications  │
│  - Rate limits  │   - Uploads       │     - Rec pipeline        │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Audio Streaming

Adaptive quality streaming selects the best audio file based on subscription tier, user preference, and network conditions. The streaming service generates signed, time-limited URLs pointing to CDN-cached audio files.

**Quality tiers:**
- 256 kbps AAC (free tier, all networks)
- Lossless ALAC 16-bit/44.1kHz (premium, Wi-Fi/5G)
- Hi-Res Lossless 24-bit/192kHz (premium, Wi-Fi only)

The client requests a stream URL; the server checks subscription entitlement, selects the appropriate audio file quality, and returns a signed URL with a DRM license. For gapless playback, the client pre-fetches the next track's stream URL while the current track is still playing.

### 2. Library Matching (Audio Fingerprinting)

When users upload their own music, the system generates an acoustic fingerprint (using Chromaprint) and searches the catalog for matches. High-confidence matches (>95%) link the upload to the catalog version, giving the user access to lossless quality and lyrics. Low-confidence results are stored as user uploads with extracted metadata.

### 3. Library Sync (Cross-Device)

Library changes are tracked using a monotonically increasing sync token sequence. Each device stores its last known sync token. On sync, the device requests all changes since its token, applies them locally, and updates its token. This enables efficient delta sync without transferring the full library.

Conflict resolution uses timestamp-based last-write-wins: when two devices make conflicting changes offline, the most recent change prevails.

### 4. Recommendations

The recommendation engine combines collaborative filtering (users who like X also like Y) with content-based features (tempo, energy, genre weights). Key sections:

- **Heavy Rotation**: Albums most played in the last 14 days
- **New Releases**: From artists in the user's library
- **Genre Mixes**: Personalized playlists seeded by top genre preferences
- **Discovery**: Tracks similar to the user's taste profile but not yet heard
- **Personal Radio**: Stations seeded by a track/artist, blending 70% seed similarity with 30% user preference

---

## Database Schema

```sql
-- Sync token sequence for library sync
CREATE SEQUENCE IF NOT EXISTS sync_token_seq START 1;

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(200),
  avatar_url VARCHAR(500),
  subscription_tier VARCHAR(50) DEFAULT 'free', -- 'free', 'individual', 'family', 'student'
  role VARCHAR(20) DEFAULT 'user', -- 'user', 'admin'
  preferred_quality VARCHAR(50) DEFAULT '256_aac', -- '256_aac', 'lossless', 'hi_res_lossless'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Artists table
CREATE TABLE artists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(500) NOT NULL,
  bio TEXT,
  image_url VARCHAR(500),
  genres TEXT[], -- Array of genre tags
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Albums table
CREATE TABLE albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
  release_date DATE,
  album_type VARCHAR(50) DEFAULT 'album', -- 'album', 'single', 'ep', 'compilation'
  genres TEXT[],
  artwork_url VARCHAR(500),
  total_tracks INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  explicit BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tracks table
CREATE TABLE tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  isrc VARCHAR(20) UNIQUE,
  title VARCHAR(500) NOT NULL,
  artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  duration_ms INTEGER,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  explicit BOOLEAN DEFAULT FALSE,
  audio_features JSONB, -- tempo, energy, danceability, etc.
  fingerprint_hash VARCHAR(64),
  play_count BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audio files table (multiple qualities per track)
CREATE TABLE audio_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  quality VARCHAR(50) NOT NULL, -- '256_aac', 'lossless', 'hi_res_lossless'
  format VARCHAR(20) NOT NULL, -- 'aac', 'alac', 'flac', 'mp3'
  bitrate INTEGER,
  sample_rate INTEGER,
  bit_depth INTEGER,
  file_size BIGINT,
  minio_key VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- User library items
CREATE TABLE library_items (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  item_type VARCHAR(20) NOT NULL, -- 'track', 'album', 'artist', 'playlist'
  item_id UUID NOT NULL,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, item_type, item_id)
);

-- Library sync changes
CREATE TABLE library_changes (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  change_type VARCHAR(20) NOT NULL, -- 'add', 'remove', 'update'
  item_type VARCHAR(20) NOT NULL,
  item_id UUID NOT NULL,
  data JSONB,
  sync_token BIGINT DEFAULT nextval('sync_token_seq'),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_library_changes_sync ON library_changes(user_id, sync_token);

-- Uploaded tracks (for user uploads)
CREATE TABLE uploaded_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  original_filename VARCHAR(500),
  minio_key VARCHAR(500),
  matched_track_id UUID REFERENCES tracks(id),
  match_confidence DECIMAL,
  title VARCHAR(500),
  artist_name VARCHAR(500),
  album_name VARCHAR(500),
  duration_ms INTEGER,
  uploaded_at TIMESTAMP DEFAULT NOW()
);

-- Listening history
CREATE TABLE listening_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TIMESTAMP DEFAULT NOW(),
  duration_played_ms INTEGER,
  context_type VARCHAR(50), -- 'album', 'playlist', 'radio', 'library'
  context_id UUID,
  completed BOOLEAN DEFAULT FALSE -- true if played > 30 seconds
);

CREATE INDEX idx_history_user ON listening_history(user_id, played_at DESC);
CREATE INDEX idx_history_track ON listening_history(track_id);

-- Playlists
CREATE TABLE playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  type VARCHAR(20) DEFAULT 'regular', -- 'regular', 'smart', 'radio'
  rules JSONB, -- For smart playlists
  is_public BOOLEAN DEFAULT FALSE,
  artwork_url VARCHAR(500),
  total_tracks INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Playlist tracks
CREATE TABLE playlist_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TIMESTAMP DEFAULT NOW(),
  added_by UUID REFERENCES users(id),
  UNIQUE(playlist_id, position)
);

CREATE INDEX idx_playlist_tracks ON playlist_tracks(playlist_id, position);

-- Radio stations
CREATE TABLE radio_stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  artwork_url VARCHAR(500),
  type VARCHAR(50) DEFAULT 'curated', -- 'curated', 'personal', 'artist', 'genre'
  seed_artist_id UUID REFERENCES artists(id),
  seed_genre VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Radio station tracks
CREATE TABLE radio_station_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID REFERENCES radio_stations(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER,
  UNIQUE(station_id, track_id)
);

-- User sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  device_info JSONB,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Track genre tags for recommendations
CREATE TABLE track_genres (
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  genre VARCHAR(100) NOT NULL,
  weight DECIMAL DEFAULT 1.0,
  PRIMARY KEY (track_id, genre)
);

-- User genre preferences (calculated from listening history)
CREATE TABLE user_genre_preferences (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  genre VARCHAR(100) NOT NULL,
  score DECIMAL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, genre)
);

-- Triggers maintain denormalized totals on albums and playlists
-- (total_tracks, duration_ms updated automatically on track/playlist_track changes)
```

### Schema Design Rationale

**Separation of catalog and user data**: `artists`, `albums`, `tracks` are read-heavy and highly cacheable; `library_items`, `listening_history` are write-heavy and personalized. At scale, these can be scaled independently -- catalog on read replicas, user data sharded by user_id.

**Audio files as separate table**: One track has multiple `audio_files` rows (different qualities). This supports adaptive streaming without schema changes when new formats (e.g., Dolby Atmos) are added.

**Library items as generic entity**: `library_items(user_id, item_type, item_id)` provides a unified library API. Trade-off: no foreign key enforcement on `item_id` (polymorphic reference); the application layer validates existence.

**Sync token sequence**: A global PostgreSQL sequence guarantees monotonic ordering. Clients request "changes since token X" for efficient delta sync.

**Denormalized totals**: `total_tracks` and `duration_ms` on `playlists` and `albums` avoid expensive JOINs on reads, maintained by database triggers.

**JSONB for flexible metadata**: `audio_features` (tempo, energy), `rules` (smart playlist conditions), and `device_info` vary in structure and evolve without migrations.

---

## API Design

### Catalog

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/catalog/browse` | Browse featured content, new releases |
| GET | `/api/catalog/search?q=` | Search tracks, albums, artists |
| GET | `/api/catalog/albums/:id` | Album details with tracks |
| GET | `/api/catalog/artists/:id` | Artist details with discography |
| GET | `/api/catalog/tracks/:id` | Track details |

### Streaming

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/stream/:trackId` | Get signed stream URL for track |
| POST | `/api/stream/:trackId/prefetch` | Pre-fetch next track URL for gapless playback |

### Library

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/library` | Get user library items |
| POST | `/api/library` | Add item to library |
| DELETE | `/api/library/:itemType/:itemId` | Remove item from library |
| GET | `/api/library/sync?since=` | Delta sync since sync token |

### Playlists

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/playlists` | List user playlists |
| POST | `/api/playlists` | Create playlist |
| GET | `/api/playlists/:id` | Get playlist with tracks |
| PUT | `/api/playlists/:id` | Update playlist metadata |
| POST | `/api/playlists/:id/tracks` | Add track to playlist |
| DELETE | `/api/playlists/:id/tracks/:trackId` | Remove track from playlist |

### Radio

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/radio/stations` | List available stations |
| GET | `/api/radio/stations/:id` | Get station with track list |
| POST | `/api/radio/personal` | Create personal station from seed |

### Recommendations

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/recommendations` | Get For You sections |
| POST | `/api/recommendations/history` | Record play event |

### Admin

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/admin/stats` | Platform statistics |
| GET | `/api/admin/users` | User management |
| POST | `/api/admin/catalog/tracks` | Add track to catalog |
| PUT | `/api/admin/catalog/tracks/:id` | Update track metadata |

---

## Key Design Decisions

### 1. Audio Fingerprinting for Library Matching

**Decision**: Use acoustic fingerprints (Chromaprint) to match user uploads to catalog tracks.

**Why it works**: Fingerprinting is format-agnostic -- a 128kbps MP3 upload matches the same song available as lossless ALAC. Users get upgraded quality automatically. Metadata matching alone fails on misspelled tags, incomplete ID3 data, or regional naming differences.

**Why metadata-only fails**: User-uploaded files frequently have incorrect or missing tags. A file named "Track 01.mp3" with no ID3 tags cannot be matched by metadata, but its acoustic signature uniquely identifies it.

**Trade-off**: Fingerprinting requires compute-intensive audio analysis (~2s per track). We mitigate this with background processing via a message queue and a pre-computed fingerprint index.

### 2. Sync Token Architecture

**Decision**: Use incrementing sync tokens (PostgreSQL sequence) for library synchronization rather than full-state sync or timestamp-based approaches.

**Why it works**: Sync tokens provide efficient delta sync -- a device offline for a week only fetches the changes since its last token, not the entire library. The monotonic sequence guarantees ordering even under concurrent writes.

**Why full sync fails**: At 10,000+ library items, transferring the complete library on every sync wastes bandwidth and battery. On cellular connections, this could take 30+ seconds versus <1s for delta sync.

**Trade-off**: The change log (`library_changes`) grows indefinitely. We mitigate with periodic compaction: after all devices have synced past a token, older changes can be archived.

### 3. Adaptive Quality Streaming

**Decision**: Server-side quality selection based on subscription tier, user preference, and network type.

**Why it works**: Unlike video ABR where the client observes buffer levels, music tracks are short (3-5 minutes) and buffer fully. The server can make the optimal quality decision upfront based on subscription entitlement and the declared network type.

**Why client-side ABR fails for music**: Music quality differences are audible -- switching from lossless to 256kbps mid-song is jarring. Users expect consistent quality within a track. Server-side selection ensures the chosen quality is sustainable for the full track duration.

**Trade-off**: The server must trust the client's reported network type. A client on Wi-Fi could switch to cellular mid-stream, causing buffering. The pre-fetch mechanism for the next track partially mitigates this.

---

## Consistency and Idempotency

### Write Semantics by Operation

| Operation | Consistency | Idempotency | Conflict Resolution |
|-----------|-------------|-------------|---------------------|
| Add to Library | Strong (transaction) | `ON CONFLICT DO NOTHING` | Last-write-wins via sync tokens |
| Remove from Library | Strong | DELETE is no-op if missing | Sync token ordering |
| Create Playlist | Strong | Client-generated UUID | N/A (unique per user) |
| Record Play | Eventual (async) | Dedupe by (user, track, 30s window) | Accept all, dedupe later |
| Library Sync | Eventual | Replay-safe via monotonic tokens | Token-based ordering |

### Idempotency Key Flow

Mutation endpoints accept an `X-Idempotency-Key` header:

1. Client provides a unique key with the request
2. Server checks Redis for a cached response under that key
3. If found and completed: return cached response with `X-Idempotency-Replayed: true`
4. If found and in-progress: return 409 Conflict
5. If not found: acquire lock, execute operation, cache result for 24 hours

### Play History Deduplication

Play events are deduplicated with a 30-second window -- the same track played within 30 seconds counts as a single play event. This prevents inflated counts from network retries or UI double-taps.

---

## Security and Auth

### Session-Based Authentication

Sessions are stored in Redis with a 30-day TTL. On login, the server creates a session and sets an `httpOnly`, `sameSite: lax` cookie. Session validation happens on Redis (fast) with fallback to PostgreSQL.

**Why not JWT**: Sessions can be immediately revoked (logout, ban, subscription expiry). JWT revocation requires a blocklist, negating the stateless advantage. For a music service where subscription status changes affect streaming quality, immediate revocation matters.

### Role-Based Access Control

| Role | Permissions |
|------|-------------|
| `user` | Read catalog, manage own library, stream at subscription tier |
| `admin` | Full access: manage users, content moderation, view analytics |

### Rate Limiting

| Endpoint Category | Limit | Window | Key |
|-------------------|-------|--------|-----|
| Global API | 100 req | 1 min | IP + User ID |
| Streaming | 300 req | 1 min | User ID |
| Search | 30 req | 1 min | User ID |
| Login | 5 req | 15 min | IP |
| Admin | 50 req | 1 min | User ID |

Rate limits are backed by Redis for consistency across multiple server instances. Standard `429 Too Many Requests` responses include `Retry-After` headers.

---

## Observability

### Prometheus Metrics

Key metrics exposed at `/metrics`:

| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds` | Histogram | API latency distribution (p50/p95/p99) |
| `stream_start_latency_seconds` | Histogram | Time from request to first byte |
| `active_streams` | Gauge | Current concurrent streams |
| `library_operations_total` | Counter | Add/remove/sync by item type |
| `search_latency_seconds` | Histogram | Search query latency |
| `cache_hits_total` | Counter | Redis cache hit/miss by type |

### SLI/SLO Targets

| SLI | Target SLO | Alert Threshold |
|-----|------------|-----------------|
| Stream start latency (p95) | < 200ms | > 300ms for 5 min |
| API availability | 99.9% | < 99.5% for 10 min |
| Search latency (p95) | < 500ms | > 750ms for 5 min |
| Library sync success rate | 99.5% | < 99% for 15 min |
| Error rate (5xx) | < 0.1% | > 0.5% for 5 min |

### Structured Logging

JSON-formatted logs via Pino with request correlation (`X-Request-ID` propagation), user context, and separate audit logging for security events (login attempts, admin actions, subscription changes).

---

## Failure Handling

### Graceful Degradation

- **Elasticsearch down**: Search falls back to PostgreSQL `LIKE` queries (slower but functional)
- **Recommendation service down**: Return static "Popular Now" content instead of personalized sections
- **Object storage slow**: Serve cached stream URLs; client-side buffer provides 30s tolerance

### Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `/health` | Liveness probe | Process is running |
| `/health/ready` | Readiness probe | PostgreSQL + Redis connectivity |

---

## Scalability Considerations

### What Breaks First

1. **Listening history writes**: At 100M users, play events could reach 100K+ writes/sec. Solution: batch writes via message queue (RabbitMQ/Kafka), write to append-only log, aggregate asynchronously.

2. **Search latency**: PostgreSQL `LIKE` queries degrade with catalog size. Solution: Elasticsearch with inverted indexes, autocomplete via edge n-grams.

3. **Library sync**: Users with 50K+ library items create large change logs. Solution: periodic compaction, pagination of sync responses.

### Horizontal Scaling Path

- **Catalog reads**: Read replicas + aggressive CDN caching (catalog metadata rarely changes)
- **User data**: Shard by `user_id` hash across database clusters
- **Audio files**: CDN with multi-tier caching (edge -> regional -> origin)
- **Sessions**: Redis Cluster with consistent hashing

### Database Sharding Strategy

At production scale, shard user-specific tables (`library_items`, `listening_history`, `playlists`) by `user_id` hash. Catalog tables (`artists`, `albums`, `tracks`) remain unsharded with read replicas. Cross-shard queries (e.g., "most played tracks globally") use a separate analytics pipeline (ClickHouse or similar OLAP store).

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Audio matching | Fingerprinting | Metadata only | Accuracy regardless of file format/tags |
| Library sync | Sync tokens | Full sync | Efficient delta sync, bandwidth-friendly |
| Streaming | Server-side quality | Client-side ABR | Consistent quality per track, simpler client |
| Recommendations | Hybrid CF + content | Pure CF | Handles cold-start for new users/tracks |
| Consistency | Strong for library, eventual for plays | All strong | Performance vs correctness tradeoff |
| Auth | Session + Redis | JWT | Immediate revocation on subscription change |
| Rate limiting | Redis-backed sliding window | In-memory | Distributed, persistent across restarts |
| Search | Elasticsearch | PostgreSQL full-text | Autocomplete, relevance scoring, scale |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation.

### Local Architecture

```
┌─────────────────┐         ┌─────────────────┐
│   React + Vite  │────────▶│  Express API    │
│   :5173         │  HTTP   │  :3000          │
│                 │◀────────│                 │
│ - Browse/Search │         │ - Catalog       │
│ - Audio Player  │         │ - Library/Sync  │
│ - Library Mgmt  │         │ - Streaming     │
│ - Radio         │         │ - Playlists     │
│ - Admin Panel   │         │ - Radio         │
└─────────────────┘         │ - Recommendations│
                            │ - Admin          │
                            └────────┬─────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
     ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
     │   PostgreSQL    │    │  Valkey/Redis   │    │     MinIO       │
     │   :5432         │    │  :6379          │    │  :9000 / :9001  │
     │                 │    │                 │    │                 │
     │ - All tables    │    │ - Sessions      │    │ - audio-files   │
     │ - Full schema   │    │ - Cache         │    │ - album-artwork │
     │ - Triggers      │    │ - Rate limits   │    │                 │
     └─────────────────┘    │ - Idempotency   │    └─────────────────┘
                            └─────────────────┘
                                                   ┌─────────────────┐
                                                   │ Elasticsearch   │
                                                   │ :9200           │
                                                   │ - Catalog search│
                                                   └─────────────────┘
```

### Production Patterns Actually Implemented

**1. Structured Logging with Pino** (`backend/src/shared/logger.ts`)

JSON-formatted request logging with `X-Request-ID` correlation. Each request gets a child logger with bound context (userId, method, path). Enables log aggregation and search in ELK/Loki. Pino was chosen for its low overhead (~5x faster than Winston).

**2. Prometheus Metrics** (`backend/src/shared/metrics.ts`)

Full `/metrics` endpoint with HTTP request duration histogram, stream latency histogram, library operation counters, and cache hit/miss counters. Exposes Node.js default metrics (CPU, memory, event loop lag). Ready for Grafana dashboarding.

**3. Redis-Backed Rate Limiting** (`backend/src/shared/rateLimit.ts`)

Five tiers of rate limiting (global, streaming, search, login, admin) using `express-rate-limit` with `rate-limit-redis` store. Consistent enforcement across multiple server instances (`npm run dev:server1/2/3`).

**4. Idempotency Middleware** (`backend/src/shared/idempotency.ts`)

`X-Idempotency-Key` header support on POST endpoints. Cached responses stored in Redis with 24-hour TTL. Prevents duplicate playlist creation and library modifications on client retries.

**5. Health Checks** (`backend/src/shared/health.ts`)

`/health` liveness probe and `/health/ready` readiness probe checking PostgreSQL and Redis connectivity with latency measurements. Ready for Kubernetes integration.

**6. Elasticsearch Integration** (`backend/src/services/`, `@elastic/elasticsearch` in dependencies)

Full-text search with the Elasticsearch client. Falls back to PostgreSQL `LIKE` queries if Elasticsearch is unavailable.

### What Was Simplified or Substituted

| Production Component | Local Substitute | Rationale |
|----------------------|------------------|-----------|
| CDN (CloudFront/Akamai) | MinIO direct URLs | No edge caching needed locally |
| FairPlay DRM | No encryption | DRM requires Apple developer certificates |
| Audio fingerprinting | Schema ready, not implemented | Requires Chromaprint native library |
| ML recommendation engine | SQL-based genre scoring | No ML infrastructure locally |
| Message queue (Kafka) | Synchronous writes | Play events written directly to PostgreSQL |
| OAuth/Apple ID | Session + bcrypt | Simpler for development |
| Multi-region replication | Single PostgreSQL | One machine |

### What Was Omitted

- **Real audio file transcoding** -- placeholder audio URLs used; no actual AAC/ALAC encoding pipeline
- **Gapless playback DRM** -- no FairPlay integration; stream URLs are unsigned
- **Social features** -- no friend activity feed, no shared playlists with external users
- **Offline downloads** -- no PWA service worker or download management
- **Real-time sync notifications** -- no WebSocket push when library changes on another device
- **Upload matching pipeline** -- database schema exists but fingerprint matching not wired
- **CDN with edge caching** -- all audio served directly from MinIO
- **Kubernetes / auto-scaling** -- runs as single-process Express server
- **Distributed tracing** -- OpenTelemetry referenced in architecture but not integrated

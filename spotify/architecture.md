# Design Spotify - Architecture

## System Overview

Spotify is a music streaming platform serving personalized audio content to hundreds of millions of users across multiple device types. Core engineering challenges include low-latency audio delivery through CDN infrastructure, recommendation algorithms that balance exploration and exploitation, royalty-accurate stream counting, and offline synchronization with DRM enforcement.

**Learning Goals:**
- Build audio streaming pipelines with adaptive bitrate delivery
- Design recommendation systems combining collaborative and content-based filtering
- Implement playback analytics pipelines for royalty calculation
- Handle cross-device state synchronization and offline caching

---

## Requirements

### Functional Requirements

1. **Stream**: Play music with adaptive bitrate quality across devices
2. **Library**: Browse and search artists, albums, and tracks; save favorites
3. **Playlists**: Create, manage, and collaborate on playlists
4. **Discover**: Personalized recommendations (For You, Discover Weekly, artist radio)
5. **Offline**: Download encrypted audio for offline listening (premium)
6. **Social**: Friend activity feed, shared playlists, artist following
7. **Ads**: Targeted ad insertion for free-tier users with frequency capping
8. **Royalties**: Accurate stream counting with rights holder attribution

### Non-Functional Requirements

- **Latency**: < 200ms time-to-first-byte for audio streaming
- **Availability**: 99.99% for streaming and playback services
- **Scale**: 500M registered users, 200M monthly active, 100M+ track catalog
- **Quality**: Up to 320kbps Ogg Vorbis (premium), 160kbps AAC (free tier)
- **Consistency**: Exactly-once stream counting for royalty accuracy
- **Durability**: Zero data loss for playback events and financial records

---

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Monthly active users | 200M |
| Concurrent streams (peak) | 20M |
| Average listening time | 30 min/day per active user |
| Tracks in catalog | 100M+ |
| New tracks uploaded daily | 100K |
| Playback events per second | ~500K |
| Audio storage | ~10 PB (3 quality tiers per track) |
| Metadata storage | ~5 TB (PostgreSQL) |
| Listening history | ~50 TB (Cassandra, partitioned by user) |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Users | 2-5 (seeded) |
| Tracks | ~100 (seeded) |
| Concurrent streams | 1-3 |
| Playback events | ~1/second |
| Storage | < 1 GB |

---

## High-Level Architecture

### Production Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Client Layer                                      │
│         Mobile (iOS/Android) │ Desktop │ Web │ Car │ Smart Speaker           │
└──────────────────────────────────────────────────────────────────────────────┘
                    │ API calls                      │ Audio streams
                    ▼                                ▼
┌───────────────────────────┐         ┌────────────────────────────────────────┐
│        API Gateway        │         │              CDN (Global)              │
│  (Rate limiting, auth,    │         │  (Audio files, album art, static)      │
│   request routing)        │         │  Edge caching for popular tracks       │
└───────────────────────────┘         └────────────────────────────────────────┘
         │          │          │                      ▲
         ▼          ▼          ▼                      │ Signed URL redirect
┌──────────┐ ┌───────────┐ ┌──────────┐ ┌───────────────────┐ ┌──────────────┐
│ Catalog  │ │ Playback  │ │  Rec     │ │ Playlist Service  │ │  Ad Service  │
│ Service  │ │ Service   │ │ Service  │ │                   │ │              │
│          │ │           │ │          │ │ - CRUD            │ │ - Targeting  │
│ - Search │ │ - Stream  │ │ - CF/CB  │ │ - Collaborative   │ │ - Insertion  │
│ - Browse │ │ - Events  │ │ - Radio  │ │ - Versioning      │ │ - Frequency  │
│ - Meta   │ │ - State   │ │ - Daily  │ │                   │ │   capping    │
└──────────┘ └───────────┘ └──────────┘ └───────────────────┘ └──────────────┘
     │            │              │              │                    │
     ▼            ▼              ▼              ▼                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Message Bus (Kafka)                                │
│  Topics: playback-events, stream-counts, ad-impressions, user-actions        │
└──────────────────────────────────────────────────────────────────────────────┘
     │                    │                    │                    │
     ▼                    ▼                    ▼                    ▼
┌──────────┐    ┌───────────────┐    ┌──────────────┐    ┌────────────────────┐
│ Analytics│    │ Royalty        │    │ Rec Pipeline  │    │ User Taste         │
│ Worker   │    │ Calculator    │    │ (Spark/ML)    │    │ Profile Worker     │
└──────────┘    └───────────────┘    └──────────────┘    └────────────────────┘
     │                    │                    │                    │
     ▼                    ▼                    ▼                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Data Layer                                      │
├──────────────┬────────────────┬────────────────┬─────────────────────────────┤
│  PostgreSQL  │   Cassandra    │   Redis/Valkey │  Object Storage (S3)        │
│  - Catalog   │   - Listening  │   - Sessions   │  - Audio files (3 tiers)    │
│  - Users     │     history    │   - Playback   │  - Album art                │
│  - Playlists │   - Play events│     state      │  - Artist images            │
│  - Royalties │   (TimeUUID)   │   - Cache      │                             │
│  - Audit logs│                │   - Rate limits│                             │
└──────────────┴────────────────┴────────────────┴─────────────────────────────┘
```

---

## Core Components

### 1. Audio Streaming

**Adaptive Bitrate Delivery:**

Each track is stored in multiple quality tiers to support adaptive bitrate streaming. The encoding format is Ogg Vorbis for all tiers, with AAC as a fallback for devices that lack Vorbis support.

| Tier | Bitrate | Use Case | Target |
|------|---------|----------|--------|
| Low | 96 kbps | Mobile data, slow connections | All users |
| Normal | 160 kbps | Default quality | All users |
| High | 320 kbps | Premium quality, Wi-Fi | Premium only |

**Streaming Flow:**

1. Client requests stream URL for a track via the Playback Service
2. Service validates user subscription tier (free vs. premium) and determines max quality
3. Client network conditions inform quality selection (bandwidth probe or reported connection type)
4. Service generates a signed CDN URL with 1-hour expiry, scoped to the user for analytics attribution
5. Client fetches audio directly from the CDN edge node, bypassing origin servers
6. For popular tracks, CDN hit rates exceed 95% since the top 1% of tracks account for ~30% of all plays

**Quality Switching:**

Mid-stream quality switching happens at segment boundaries. The client pre-buffers the next segment at an alternative quality when network conditions change. On a quality downgrade, the transition is immediate; on an upgrade, the client waits until the current buffer drains to avoid wasting bandwidth.

**Why CDN with signed URLs over direct streaming:** Direct streaming from origin servers would require provisioning for 20M concurrent connections. CDN edge nodes distribute this load across hundreds of PoPs globally, reducing origin traffic by 95%+ for popular content. Signed URLs provide access control without requiring the CDN to validate sessions, and the 1-hour expiry limits the window for URL sharing. The trade-off is increased complexity in URL generation and cache invalidation when tracks are removed due to rights disputes.

### 2. Music Catalog and Metadata

The catalog service manages the artist/album/track hierarchy and serves browse and search requests.

**Entity Relationships:**

- An **artist** has many **albums** (one-to-many via `artist_id`)
- An **album** has many **tracks** (one-to-many via `album_id`, ordered by `disc_number`, `track_number`)
- A **track** can have multiple **artists** (many-to-many via `track_artists` join table with `is_primary` flag)
- Tracks store `audio_features` as JSONB (tempo, energy, danceability, acousticness, genres)

**Search Architecture (Production):**

At scale, search uses Elasticsearch with the following capabilities:
- **Fuzzy matching**: Handles typos ("bettles" matches "Beatles") using Levenshtein distance
- **Auto-complete**: Prefix queries on an edge-ngram analyzed field, returning results in < 50ms
- **Personalized ranking**: Boost scores for artists the user has listened to or followed
- **Multi-entity search**: Single query searches across artists, albums, and tracks simultaneously
- **Language-aware analysis**: ICU tokenization for CJK scripts, accent folding for Latin scripts

**Why Elasticsearch over PostgreSQL full-text search:** PostgreSQL `tsvector` search handles simple keyword matching but cannot efficiently support fuzzy matching, auto-complete with prefix queries, or personalized boosting. At 100M tracks with 500M+ daily search queries, Elasticsearch's inverted index and distributed architecture provide sub-50ms p95 latency. The trade-off is eventual consistency in the search index (1-5 second lag after catalog updates) and operational overhead of managing an Elasticsearch cluster.

### 3. Recommendation Engine

**Hybrid Approach (Collaborative Filtering + Content-Based):**

Spotify's recommendation challenge requires blending multiple signals because no single algorithm handles all scenarios well.

**Collaborative Filtering (CF):**
1. Build a user-track interaction matrix from listening history (last 28 days)
2. Factor the matrix using ALS (Alternating Least Squares) to produce 128-dimensional user and track embeddings
3. For a target user, find the 100 most similar users by cosine similarity of user embeddings
4. Aggregate tracks those similar users listened to that the target user has not
5. Rank by weighted frequency (more similar users listening = higher score)

**Content-Based Filtering (CB):**
1. Extract audio features per track: tempo, energy, danceability, acousticness, key, mode, valence
2. Combine with metadata features: genre tags, release year, artist popularity
3. Build a 128-dimensional track embedding from these features
4. For a target user, average the embeddings of their top-rated tracks
5. Find tracks with high cosine similarity to this averaged embedding using approximate nearest neighbors (ANN) search

**Blending Strategy:**
- 60% collaborative, 40% content-based for established users (> 50 tracks in history)
- 80% content-based, 20% collaborative for newer users (cold start mitigation)
- Diversification pass: max 2 tracks per artist, genre diversity target

**Discovery Products:**
- **For You**: Real-time blend refreshed hourly, personalized to current listening session
- **Discover Weekly**: Batch-generated weekly playlist, 30 tracks, emphasizes novel discoveries (tracks from artists the user has never listened to)
- **Artist Radio**: Seed artist's top tracks mixed with tracks from artists with similar listener overlap, shuffled

**Cold Start Problem:**
New users with no listening history receive recommendations based on:
1. Onboarding flow: user selects 3+ artists they like
2. Registration demographics: age bracket and region inform genre priors
3. Popular/trending tracks as a fallback
4. Rapid adaptation: after just 10 plays, collaborative signals begin contributing

**Why hybrid CF+CB over pure collaborative:** Pure collaborative filtering fails completely for new users (cold start) and for tracks with few plays (long-tail content). Content-based filtering handles both cases by leveraging audio features, but misses serendipitous discoveries that collaborative filtering excels at (e.g., "users who like indie rock also enjoy this electronic artist"). The 60/40 blend captures both signals. The trade-off is engineering complexity: two separate ML pipelines must be maintained, and the blending weights require periodic tuning via A/B testing.

### 4. Playlist Management

**Collaborative Playlists:**

Collaborative playlists allow multiple users to add, remove, and reorder tracks. Conflict resolution follows these rules:
- **Concurrent additions**: Both tracks are added; positions are auto-incremented
- **Concurrent deletions**: Idempotent (DELETE is safe to replay)
- **Track reordering**: Last-write-wins for position updates
- **Duplicate prevention**: `UNIQUE(playlist_id, track_id)` constraint with `ON CONFLICT DO NOTHING`

**Playlist Versioning:**

At production scale, playlists maintain a version history. Each modification increments a version counter, and the previous state is stored in a changelog table. This enables:
- Undo/redo functionality
- Audit trail for collaborative edits
- Recovery from accidental bulk deletions

**Smart Playlists:**

Generated playlists that auto-update based on rules:
- "Recently Added" - tracks added to library in the last 30 days
- "On Repeat" - tracks with highest play count in the last week
- "Blend" - shared playlist between two users combining both tastes

### 5. Social Features

**Friend Activity:**
- Real-time feed showing what friends are listening to
- Uses WebSocket connections for live updates
- Privacy controls: users can hide activity or go "private session"

**Shared Listening:**
- "Group Session" where multiple users control the same playback queue
- One user is the host; others can add to queue but host controls playback
- Synchronized playback with < 500ms skew tolerance

**Artist Following:**
- Follow notifications for new releases
- Monthly listener counts aggregated daily (eventual consistency acceptable)

### 6. Playback and Stream Counting

**30-Second Rule:**

A play is counted as a "stream" for royalty purposes when the user listens for at least 30 seconds. This is the industry standard adopted by all major streaming platforms.

**Stream Counting Flow:**
1. Client reports `play_started` event when playback begins
2. Client tracks elapsed time locally
3. At 30 seconds, client reports `stream_counted` event
4. Server-side deduplication prevents double-counting (idempotency key = `userId_trackId_sessionTimestamp`)
5. Stream count is persisted to the database and published to Kafka for downstream consumers
6. `play_completed` or `skipped` events are sent when playback ends

**Cross-Device Handoff:**

Playback state (current track, position, queue, shuffle/repeat mode) is persisted to Redis with a 24-hour TTL. When a user opens Spotify on a different device, the state is restored. At production scale, this uses Spotify Connect protocol for seamless handoff without interruption.

### 7. Ad Service (Free Tier)

**Ad Insertion:**
- Audio ads injected every 3-6 songs for free-tier users
- Display ads shown on track change or during browse
- Targeting based on: demographics, listening genres, time of day, geographic region

**Frequency Capping:**
- Per-user, per-campaign caps (e.g., max 3 impressions per campaign per day)
- Redis counter per user-campaign pair with daily TTL
- Prevents ad fatigue while maximizing fill rate

**Revenue Attribution:**
- Ad impressions and clicks published to Kafka
- Joined with playback events for engagement metrics
- CPM and CPC calculations for advertiser billing

### 8. Royalty Calculation

**Play Counting for Rights Holders:**

Each stream is attributed to the track's rights holders (artist, songwriter, label, distributor) based on contractual splits stored in the catalog.

**Pro-Rata Model:**
1. Total platform streams in a period are calculated
2. Each track's share = (track streams / total streams) * total royalty pool
3. Track royalty is split among rights holders per contractual percentages
4. Payments are batched monthly

**Why pro-rata over user-centric:** Pro-rata distributes the entire subscription pool proportionally to total plays, meaning a user who only listens to niche artists still contributes some royalties to mainstream artists they never played. User-centric (where each user's subscription fee goes only to artists they listened to) is fairer but harder to implement because it requires per-user accounting. The trade-off: pro-rata favors popular artists disproportionately, but it is the industry standard and simpler to audit.

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  is_premium BOOLEAN DEFAULT FALSE,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Artists
CREATE TABLE artists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  bio TEXT,
  image_url TEXT,
  verified BOOLEAN DEFAULT FALSE,
  monthly_listeners INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Albums
CREATE TABLE albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  release_date DATE,
  cover_url TEXT,
  album_type VARCHAR(50) DEFAULT 'album',  -- 'album', 'single', 'ep'
  total_tracks INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tracks
CREATE TABLE tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  duration_ms INTEGER NOT NULL,
  track_number INTEGER DEFAULT 1,
  disc_number INTEGER DEFAULT 1,
  audio_url TEXT,
  stream_count INTEGER DEFAULT 0,
  audio_features JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Track artists (many-to-many for collaborations)
CREATE TABLE track_artists (
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (track_id, artist_id)
);

-- Playlists
CREATE TABLE playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  cover_url TEXT,
  is_public BOOLEAN DEFAULT TRUE,
  is_collaborative BOOLEAN DEFAULT FALSE,
  follower_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Playlist tracks (ordered)
CREATE TABLE playlist_tracks (
  playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_by UUID REFERENCES users(id),
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (playlist_id, track_id)
);

-- User library (liked songs, albums, artists, playlists)
CREATE TABLE user_library (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  item_type VARCHAR(50) NOT NULL,  -- 'track', 'album', 'artist', 'playlist'
  item_id UUID NOT NULL,
  saved_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, item_type, item_id)
);

-- Listening history (for recommendations)
CREATE TABLE listening_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  duration_played_ms INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  played_at TIMESTAMP DEFAULT NOW()
);

-- Playback events (analytics)
CREATE TABLE playback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  position_ms INTEGER DEFAULT 0,
  device_type VARCHAR(50) DEFAULT 'web',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit logs
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id UUID,
  actor_ip INET,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID,
  details JSONB DEFAULT '{}',
  success BOOLEAN DEFAULT TRUE,
  request_id VARCHAR(100)
);

-- Indexes
CREATE INDEX idx_albums_artist_id ON albums(artist_id);
CREATE INDEX idx_tracks_album_id ON tracks(album_id);
CREATE INDEX idx_playlist_tracks_playlist_id ON playlist_tracks(playlist_id);
CREATE INDEX idx_user_library_user_id ON user_library(user_id);
CREATE INDEX idx_listening_history_user_id ON listening_history(user_id);
CREATE INDEX idx_listening_history_played_at ON listening_history(played_at DESC);
CREATE INDEX idx_playback_events_user_id ON playback_events(user_id);
CREATE INDEX idx_audit_logs_actor_id ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
```

**Production Database Selection:**

| Database | Purpose | Why This Choice |
|----------|---------|-----------------|
| PostgreSQL | Catalog, users, playlists, royalties, audit logs | ACID transactions for financial data, complex JOINs for catalog queries |
| Cassandra | Listening history, playback events | High write throughput (500K events/sec), time-ordered partitioning by user, no cross-user queries needed |
| Redis/Valkey | Sessions, playback state, rate limits, caches, taste profiles | Sub-ms latency for hot data, TTL for ephemeral state |
| Elasticsearch | Search index | Fuzzy matching, auto-complete, personalized ranking |
| S3/Object Storage | Audio files, album art | Cost-effective at petabyte scale, CDN integration |

**Why Cassandra for listening history over PostgreSQL:** Playback events are write-heavy (500K/sec at peak) and read patterns are strictly per-user (get my last 28 days of history). PostgreSQL would require horizontal sharding for this write volume, adding operational complexity. Cassandra handles this natively with its partition-key design (`user_id` as partition key, `played_at` as clustering column in DESC order). The trade-off is no cross-user JOINs, so analytics queries (e.g., "most played track globally") require a separate aggregation pipeline, not ad-hoc SQL.

---

## API Design

### Catalog

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/catalog/artists` | List/search artists (paginated) |
| GET | `/api/catalog/artists/:id` | Get artist details with top tracks |
| GET | `/api/catalog/albums` | List/search albums (with optional `artistId` filter) |
| GET | `/api/catalog/albums/:id` | Get album with track listing |
| GET | `/api/catalog/tracks/:id` | Get track details |
| GET | `/api/catalog/new-releases` | Get recently released albums |
| GET | `/api/catalog/featured` | Get editorially featured tracks |
| GET | `/api/catalog/search?q=&type=` | Search across artists, albums, tracks |

### Playback

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/playback/stream/:trackId` | Get signed stream URL for a track |
| POST | `/api/playback/event` | Record playback event (play, pause, skip, complete, stream_counted) |
| GET | `/api/playback/recently-played` | Get user's recently played tracks |
| PUT | `/api/playback/state` | Save playback state (cross-device sync) |
| GET | `/api/playback/state` | Retrieve saved playback state |
| GET | `/api/playback/stats/:trackId` | Get track play count and like count |

### Library

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/library/tracks` | Get liked songs |
| PUT | `/api/library/tracks/:id` | Like a track |
| DELETE | `/api/library/tracks/:id` | Unlike a track |
| GET | `/api/library/tracks/contains?ids=` | Check which tracks are liked |
| GET | `/api/library/albums` | Get saved albums |
| PUT/DELETE | `/api/library/albums/:id` | Save/unsave album |
| GET | `/api/library/artists` | Get followed artists |
| PUT/DELETE | `/api/library/artists/:id` | Follow/unfollow artist |

### Playlists

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/playlists/me` | Get user's playlists |
| GET | `/api/playlists/public` | Get public playlists |
| POST | `/api/playlists` | Create playlist |
| GET | `/api/playlists/:id` | Get playlist with tracks |
| PATCH | `/api/playlists/:id` | Update playlist metadata |
| DELETE | `/api/playlists/:id` | Delete playlist |
| POST | `/api/playlists/:id/tracks` | Add track (idempotent) |
| DELETE | `/api/playlists/:id/tracks/:trackId` | Remove track (idempotent) |
| PUT | `/api/playlists/:id/tracks/reorder` | Reorder tracks |

### Recommendations

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/recommendations/for-you` | Personalized recommendations |
| GET | `/api/recommendations/discover-weekly` | Weekly discovery playlist |
| GET | `/api/recommendations/popular` | Trending/popular tracks |
| GET | `/api/recommendations/similar/:trackId` | Tracks similar to a given track |
| GET | `/api/recommendations/radio/artist/:artistId` | Artist radio mix |

---

## Key Design Decisions

### 1. CDN for Audio Delivery

**Decision**: Serve all audio through a globally distributed CDN with per-user signed URLs.

Audio files are the highest-bandwidth component of the system. At 20M concurrent streams, direct origin serving would require ~3.2 Tbps of bandwidth. A CDN distributes this across edge PoPs, with popular tracks cached at the edge achieving 95%+ hit rates. Signed URLs with 1-hour expiry provide access control without requiring the CDN to authenticate every request. The trade-off is that a user who shares a signed URL can grant temporary access to that track, but the short expiry and user-scoped analytics make this low risk.

### 2. Kafka for Playback Event Pipeline

**Decision**: Publish all playback events to Kafka for asynchronous processing rather than handling them synchronously.

Synchronous processing of playback events would add latency to every play/pause/skip action and couple the playback service to all downstream consumers (analytics, royalties, recommendations, taste profiling). Kafka decouples producers and consumers, allowing the playback service to respond in < 5ms while downstream workers process at their own pace. If the royalty calculator goes down, events are durably stored in Kafka (7-day retention) and processed when the consumer recovers. The trade-off is eventual consistency: stream counts in the database may lag by seconds to minutes behind real-time, but this is acceptable for all downstream use cases.

### 3. 30-Second Stream Threshold

**Decision**: Count a stream after 30 seconds of playback, following the industry standard.

This threshold balances artist and platform interests. A lower threshold (e.g., 10 seconds) would inflate stream counts from users quickly previewing tracks, artificially boosting royalty payments for tracks that users don't actually enjoy. A higher threshold (e.g., 60 seconds) would under-count legitimate listens of short songs. The 30-second standard is used by Spotify, Apple Music, and Tidal, making cross-platform comparisons meaningful for artists and labels.

### 4. Session-Based Auth over JWT

**Decision**: Use Redis-backed sessions with HTTP-only cookies rather than JWT tokens.

Session-based auth enables immediate revocation (logout, account ban, password change) by deleting the session from Redis. JWT revocation requires either a blocklist (adding the same Redis dependency) or waiting for token expiry. For a music streaming app where premium subscriptions can be upgraded/downgraded instantly, the ability to change session state without token reissuance is valuable. The trade-off is that every API request requires a Redis lookup, but since Redis is already used for caching, rate limiting, and playback state, this adds no new infrastructure dependency.

---

## Consistency and Idempotency

### Consistency Model

**Strong Consistency (PostgreSQL):**
- User account operations (registration, subscription changes)
- Playlist ownership and permission changes
- Financial transactions (subscription billing, royalty calculations)
- Stream count increments: `UPDATE tracks SET stream_count = stream_count + 1` with row-level locking

**Eventual Consistency (acceptable):**
- Recommendation updates (regenerate hourly or weekly)
- Monthly listener counts (batch aggregated)
- Search index updates (1-5 second lag)
- Playback analytics (processed through Kafka)

### Idempotency for Core Writes

**Playback Events:**

Each playback session generates an idempotency key from `userId + trackId + sessionStartTimestamp`. Server-side deduplication uses Redis with a 24-hour TTL to prevent double-counting from network retries. The key is checked atomically with `SET NX EX`, ensuring exactly-once semantics even under concurrent retry storms.

**Playlist Modifications:**

Adding a track to a playlist uses two-level idempotency protection:
1. **Database level**: `UNIQUE(playlist_id, track_id)` with `ON CONFLICT DO NOTHING`
2. **Application level**: `X-Idempotency-Key` header checked via Redis, with cached result returned for duplicate requests

The middleware wraps the response to capture the result on first execution and returns it for subsequent identical requests within the 5-minute TTL window.

**Conflict Resolution for Collaborative Playlists:**
- Last-write-wins for track reordering (position updates)
- Concurrent additions: both tracks added, positions auto-incremented
- Concurrent deletions: idempotent (DELETE is safe to replay)
- Track already exists: `ON CONFLICT DO NOTHING` prevents duplicates

---

## Authentication, Authorization, and Rate Limiting

### Authentication

Session-based auth using Redis-backed `express-session`:
- Sessions stored in Redis with `spotify:session:` prefix and 7-day expiry
- HTTP-only, secure cookies prevent XSS-based session theft
- Sliding expiration refreshes the TTL on each request

### Authorization (RBAC)

| Role | Description | Access |
|------|-------------|--------|
| `user` | Regular user | Own library, playlists, streaming (160kbps max) |
| `premium` | Premium subscriber | High quality (320kbps), offline downloads, no ads |
| `artist` | Verified artist | Own artist page, analytics dashboard |
| `admin` | Platform admin | All data, user management, audit logs |

Playlist access control checks ownership first, then collaborative status, preventing unauthorized edits.

### Rate Limiting

Redis sliding window rate limiting per endpoint category:

| Endpoint Category | Limit | Window | Scope |
|-------------------|-------|--------|-------|
| Auth (login/register) | 5 | 15 min | IP |
| Search | 60 | 1 min | User/IP |
| Playback (stream URLs) | 300 | 1 min | User |
| Library writes | 100 | 1 min | User |
| Playlist writes | 60 | 1 min | User |
| Recommendations | 30 | 1 min | User |
| Admin endpoints | 1000 | 1 min | User |

**Why sliding window over token bucket:** Sliding window provides consistent rate enforcement without allowing burst abuse. Token bucket would allow a user to accumulate tokens during inactivity and then fire 300 requests in 1 second, overwhelming downstream services. The trade-off is slightly higher Redis overhead (sorted set vs. simple counter), but the accuracy is worth it for protecting the search and recommendation services.

---

## Observability

### Metrics (Prometheus)

Key metrics collected via `prom-client`:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_request_duration_seconds` | Histogram | method, route, status_code | Request latency SLI |
| `http_requests_total` | Counter | method, route, status_code | Throughput tracking |
| `playback_events_total` | Counter | event_type, device_type | Playback analytics |
| `stream_counts_total` | Counter | - | Royalty calculation verification |
| `active_streams` | Gauge | - | Current load |
| `search_operations_total` | Counter | type | Search usage patterns |
| `recommendation_generation_seconds` | Histogram | algorithm | Rec engine performance |
| `cache_hits_total` / `cache_misses_total` | Counter | cache_type | Cache efficiency |
| `rate_limit_hits_total` | Counter | endpoint, scope | Abuse detection |
| `idempotency_deduplications_total` | Counter | operation | Retry detection |
| `db_pool_connections` | Gauge | state | Pool health |

### Health Checks

Three-tier health check design:
- `/health` - Full dependency check (PostgreSQL + Redis), returns `ok` or `degraded` with per-dependency status
- `/health/live` - Simple liveness probe for Kubernetes (always returns 200 if process is running)
- `/health/ready` - Readiness probe verifying database and cache connectivity

### Structured Logging (Pino)

JSON-structured logs with request correlation:
- Each request gets a `requestId` (from header or generated UUID)
- Child loggers carry `userId` for request tracing
- Log levels: `fatal`, `error`, `warn`, `info`, `debug`
- Audit-tagged logs (`audit: true`) for filtering sensitive operation logs

### Alert Thresholds

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High Error Rate | 5xx rate > 1% for 5 min | Critical | Page on-call |
| Slow Playback Start | p95 > 500ms for 5 min | Warning | Investigate CDN |
| Low Cache Hit Rate | < 70% for 15 min | Warning | Check cache config |
| Kafka Consumer Lag | > 10,000 for 10 min | Warning | Scale consumers |
| Database Pool Exhaustion | > 80% used | Warning | Increase pool size |

---

## Failure Handling

### Kafka Producer Failure

If the Kafka producer fails to connect at startup, the server continues operating. Playback events are still recorded to PostgreSQL directly, but the async Kafka pipeline is skipped. This is logged as a warning, and the producer attempts reconnection on the next event.

### CDN/Origin Failover

If the CDN edge node cannot serve a cached track, it falls back to the origin (MinIO/S3). If origin is also down, the client receives a 503 and retries with exponential backoff. The player UI shows a "Playback unavailable" message after 3 retries.

### Redis Failure

Rate limiting fails open (allows the request) when Redis is unavailable, preventing a cache outage from blocking all API traffic. Session validation also fails open with a logged warning, accepting the risk of unauthenticated requests during the Redis recovery window.

### Database Connection Pool Exhaustion

The pool is configured with 20 max connections and a 2-second connection timeout. If all connections are in use, new requests wait up to 2 seconds before receiving a 503 response. The `db_pool_connections` gauge enables proactive alerting before this happens.

### Graceful Shutdown

On `SIGTERM` or `SIGINT`, the server:
1. Stops accepting new connections
2. Disconnects the Kafka producer (flushes buffered messages)
3. Closes Redis client
4. Drains the PostgreSQL connection pool
5. Exits with code 0

---

## Scalability Considerations

### What Breaks First

1. **Playback event writes** (500K/sec): PostgreSQL cannot handle this write volume on a single instance. Solution: Cassandra for event storage, partitioned by `user_id`.
2. **Stream count updates** (hot rows): Popular tracks receive millions of concurrent `UPDATE` queries. Solution: Batch stream counts in Redis and flush to PostgreSQL periodically (every 10 seconds).
3. **Recommendation generation**: Computing CF+CB recommendations for 200M users is computationally expensive. Solution: Precompute recommendations in batch (Spark) and cache; only re-score in real-time for the active session context.
4. **Search at scale**: PostgreSQL `ILIKE` searches degrade linearly with catalog size. Solution: Elasticsearch index with dedicated search replicas.

### Horizontal Scaling Path

| Component | Scaling Strategy |
|-----------|-----------------|
| API servers | Stateless, add instances behind load balancer |
| PostgreSQL | Read replicas for catalog queries, sharding by user_id for user data |
| Cassandra | Add nodes; data redistributes automatically |
| Redis | Cluster mode for sharding, replicas for read scaling |
| Kafka | Add partitions to topics, add consumer instances to groups |
| CDN | Add PoPs, increase origin shield capacity |
| Recommendation | Precompute in batch; cache per-user results |

### Multi-Region

At Spotify's scale, the system operates in multiple AWS/GCP regions:
- User requests routed to nearest region via GeoDNS
- Catalog data replicated across all regions (read-heavy, infrequent writes)
- Listening history stays in the user's home region
- CDN serves audio from edge nodes globally

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Audio delivery | CDN + signed URLs | Direct streaming | 95%+ cache hit for popular tracks, global low latency |
| Playback events | Kafka async pipeline | Synchronous processing | Decouples producer/consumer, durable retry |
| Recommendations | Hybrid CF + CB | Pure collaborative | Handles cold start and long-tail content |
| Stream threshold | 30 seconds | 10s or 60s | Industry standard, balances accuracy |
| Session storage | Redis + cookie | JWT | Immediate revocation, no blocklist needed |
| Listening history | Cassandra (production) | PostgreSQL | Write-heavy, partition-key access pattern |
| Search | Elasticsearch (production) | PostgreSQL FTS | Fuzzy matching, auto-complete, personalization |
| Rate limiting | Sliding window (Redis) | Token bucket | Prevents burst abuse, smoother enforcement |
| Royalty model | Pro-rata | User-centric | Industry standard, simpler auditing |
| Consistency | Strong writes, eventual reads | Full strong | Performance at scale, acceptable for non-financial reads |

---

## Implementation Notes

This section documents the local implementation: what was built, what was simplified, and what was omitted relative to the production architecture above.

### Local Architecture

```
┌──────────────────────────┐
│    Frontend (Vite)       │
│    localhost:5173         │
│                          │
│  React + TanStack Router │
│  + Zustand + Tailwind    │
└────────────┬─────────────┘
             │ Proxy /api
             ▼
┌──────────────────────────┐
│    Backend (Express)     │
│    localhost:3001         │
│                          │
│  Routes: auth, catalog,  │
│  library, playlists,     │
│  playback, recommendations│
│  admin                   │
└──┬────┬────┬────┬────────┘
   │    │    │    │
   ▼    ▼    ▼    ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐
│Postgres│ │Valkey│ │MinIO │ │  Kafka   │
│:5432  │ │:6379 │ │:9000 │ │  :9092   │
│       │ │      │ │      │ │          │
│spotify│ │sess. │ │audio │ │playback- │
│  DB   │ │cache │ │covers│ │events    │
└──────┘ └──────┘ └──────┘ └─────┬────┘
                                  │
                                  ▼
                          ┌──────────────┐
                          │  Analytics   │
                          │  Worker      │
                          │  (Kafka      │
                          │   consumer)  │
                          └──────────────┘
```

### Production-Grade Patterns Actually Implemented

**1. Kafka Event Pipeline** (`backend/src/shared/kafka.ts`, `backend/src/workers/analytics-worker.ts`)

Playback events are published to a Kafka topic (`playback-events`, 3 partitions) with `userId` as the message key for per-user ordering guarantees. A separate analytics worker process consumes events and updates:
- Play session tracking in Redis (start time, duration, device type)
- Daily listening statistics (plays, completions, skips)
- User taste profiles (artist affinity and genre affinity as Redis sorted sets)
- Artist stream counts and monthly listener aggregates

This demonstrates the production pattern of decoupling event producers from consumers.

**2. Prometheus Metrics** (`backend/src/shared/metrics.ts`)

Thirteen custom metrics are registered and exposed at `/metrics`:
- HTTP request duration and count (histograms/counters)
- Playback events, stream counts, active streams
- Search operations, playlist operations
- Recommendation generation latency
- Cache hit/miss ratios
- Rate limit hits, auth events, idempotency deduplications
- Database pool connection gauge

**3. Idempotency Middleware** (`backend/src/shared/idempotency.ts`)

Redis-backed idempotency for playlist track operations. Uses `SET NX EX` for atomic lock acquisition, wraps `res.json()` to capture and cache successful results, and returns cached results for duplicate requests. Supports both explicit `X-Idempotency-Key` headers and auto-generated keys from request parameters.

**4. Rate Limiting** (`backend/src/shared/rateLimit.ts`)

Sliding window rate limiting using Redis sorted sets. Seven pre-configured limiters protect different endpoint categories. On Redis failure, the limiter fails open to avoid blocking legitimate traffic.

**5. Structured Logging** (`backend/src/shared/logger.ts`)

Pino-based JSON logging with request correlation IDs, child loggers carrying `userId`, and `pino-pretty` for readable local development output.

**6. Audit Logging** (`backend/src/shared/audit.ts`)

PostgreSQL-persisted audit trail for sensitive operations. Defined action categories cover authentication, account changes, subscription management, admin actions, playlist permissions, and GDPR data requests. Queryable via the admin API with filtering by actor, action, time range, and resource.

**7. Health Checks** (`backend/src/index.ts`)

Three-tier health check (`/health`, `/health/live`, `/health/ready`) with per-dependency status and pool metrics reporting.

**8. Graceful Shutdown** (`backend/src/index.ts`)

Signal handlers for `SIGTERM` and `SIGINT` that cleanly disconnect Kafka, Redis, and PostgreSQL before exiting.

### What Was Simplified

| Production Component | Local Substitute | Why |
|---------------------|-----------------|-----|
| CDN audio delivery | MinIO presigned URLs | Single-node MinIO replaces global CDN; presigned URLs demonstrate the pattern |
| Elasticsearch search | PostgreSQL `ILIKE` queries | Full-text search via SQL is adequate for ~100 seeded tracks |
| Collaborative filtering ML | SQL-based "same artist" recommendations | Finds unlistened tracks from artists in listening history; popular tracks as fallback |
| Cassandra listening history | PostgreSQL `listening_history` table | Single table handles the write volume at local scale |
| DRM/encryption | No encryption | Audio served as plain files; license management omitted |
| Multi-device Spotify Connect | Redis playback state | State saved/restored but no real-time push to other devices |
| Ad insertion | Not implemented | No ad service, targeting, or frequency capping |
| Royalty calculation pipeline | Direct `stream_count` increment | No rights holder attribution or payment distribution |

### What Was Omitted

- **CDN infrastructure** - No global edge caching; MinIO serves directly
- **Multi-region deployment** - Single-machine Docker Compose
- **Kubernetes orchestration** - No container orchestration
- **ML recommendation pipeline** - No Spark, no model training, no vector embeddings
- **Offline downloads** - No download manager, license handling, or sync
- **Social features** - No friend activity feed, group sessions, or real-time WebSocket updates
- **Ad service** - No ad targeting, insertion, or billing
- **Royalty payment system** - No rights holder database, contractual splits, or payment processing
- **A/B testing framework** - No experiment assignment or metric comparison
- **Audio fingerprinting** - No content identification or duplicate detection

### Frontend Implementation

The React frontend (`frontend/src/`) provides a Spotify-like UI with:

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | Home page | New releases, featured, popular tracks, personalized "For You" |
| `/search` | Search | Multi-entity search across artists, albums, tracks |
| `/artist/:id` | Artist page | Artist details with albums |
| `/album/:id` | Album page | Album details with track listing |
| `/playlist/:id` | Playlist page | Playlist with track listing and management |
| `/library` | Library | Saved albums, followed artists |
| `/library/liked` | Liked Songs | Liked tracks collection |
| `/login` | Login | Email/password authentication |
| `/register` | Register | Account creation |

**Player Architecture** (`frontend/src/stores/playerStore.ts`):

A Zustand store manages all playback state:
- Queue management with original queue preserved for shuffle restore
- Shuffle (Fisher-Yates) and repeat modes (off, all, one)
- 30-second stream count detection via `setCurrentTime` callback
- Playback event reporting (play, pause, resume, skip, seek, complete) sent to the backend
- HTML5 Audio element controlled via ref

**Key UI Components:**
- `AudioProvider` - Manages the shared `<audio>` element and event listeners
- `Player` - Bottom-bar player with progress, volume, queue controls
- `Sidebar` - Navigation with playlist listing
- `Header` - Auth status and navigation
- `TrackList` - Reusable track listing with play/like actions

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
│   - Catalog     │   - Search        │      - User embeddings    │
│   - Libraries   │   - Lyrics        │      - Song embeddings    │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Audio Streaming

**Adaptive Bitrate Delivery:**
```javascript
class StreamingService {
  async getStreamUrl(trackId, userId, options = {}) {
    const { preferredQuality, networkType } = options

    // Check user subscription
    const user = await this.getUser(userId)
    const maxQuality = this.getMaxQuality(user.subscription)

    // Determine quality based on preference and network
    const quality = this.selectQuality(preferredQuality, networkType, maxQuality)

    // Get audio file info
    const audioFiles = await this.getAudioFiles(trackId)
    const selectedFile = audioFiles.find(f => f.quality === quality)

    // Generate signed URL with DRM
    const streamUrl = await this.generateSignedUrl(selectedFile, userId)

    // Generate license for FairPlay DRM
    const license = await this.generateLicense(trackId, userId)

    return {
      url: streamUrl,
      quality,
      format: selectedFile.format, // AAC, ALAC, etc.
      bitrate: selectedFile.bitrate,
      license,
      expiresAt: Date.now() + 3600000
    }
  }

  selectQuality(preferred, network, max) {
    const qualities = ['256_aac', '256_aac_plus', 'lossless', 'hi_res_lossless']
    const preferredIndex = qualities.indexOf(preferred)
    const maxIndex = qualities.indexOf(max)

    // Network constraints
    const networkMax = {
      'wifi': 'hi_res_lossless',
      'cellular_5g': 'lossless',
      'cellular_lte': '256_aac_plus',
      'cellular_3g': '256_aac'
    }[network] || '256_aac'

    const networkIndex = qualities.indexOf(networkMax)

    return qualities[Math.min(preferredIndex, maxIndex, networkIndex)]
  }

  // Gapless playback support
  async prefetchNextTrack(currentTrackId, queue, userId) {
    const nextTrack = this.getNextInQueue(currentTrackId, queue)
    if (!nextTrack) return

    // Pre-generate stream URL
    const streamInfo = await this.getStreamUrl(nextTrack.id, userId)

    // Pre-fetch first segments for gapless transition
    await this.prefetchSegments(streamInfo.url, 3)

    return streamInfo
  }
}
```

### 2. Library Matching

**Audio Fingerprinting:**
```javascript
class LibraryMatcher {
  async matchUpload(userId, uploadedFile) {
    // Generate audio fingerprint
    const fingerprint = await this.generateFingerprint(uploadedFile)

    // Search catalog for match
    const matches = await this.searchCatalog(fingerprint)

    if (matches.length > 0 && matches[0].confidence > 0.95) {
      // High confidence match - link to catalog
      const catalogTrack = matches[0]

      await db.query(`
        INSERT INTO library_tracks
          (user_id, track_id, source, matched_at, original_upload_id)
        VALUES ($1, $2, 'matched', NOW(), $3)
      `, [userId, catalogTrack.id, uploadedFile.id])

      return {
        status: 'matched',
        catalogTrack,
        confidence: matches[0].confidence
      }
    }

    // No match - store as uploaded track
    const uploadedTrack = await this.storeUpload(userId, uploadedFile)

    return {
      status: 'uploaded',
      uploadedTrack
    }
  }

  async generateFingerprint(audioFile) {
    // Extract audio features for matching
    // Use Chromaprint or similar acoustic fingerprinting
    const audioBuffer = await this.decodeAudio(audioFile)

    const fingerprint = {
      chromaprint: this.chromaprint(audioBuffer),
      duration: audioBuffer.duration,
      avgLoudness: this.calculateLoudness(audioBuffer),
      tempo: this.detectTempo(audioBuffer)
    }

    return fingerprint
  }

  async searchCatalog(fingerprint) {
    // Query fingerprint index
    const candidates = await this.fingerprintIndex.search(
      fingerprint.chromaprint,
      { topK: 10 }
    )

    // Verify candidates with additional features
    return candidates
      .map(c => ({
        ...c,
        confidence: this.verifyMatch(fingerprint, c)
      }))
      .filter(c => c.confidence > 0.5)
      .sort((a, b) => b.confidence - a.confidence)
  }
}
```

### 3. Library Sync

**Cross-Device Synchronization:**
```javascript
class LibrarySyncService {
  async syncLibrary(userId, deviceId, lastSyncToken) {
    // Get changes since last sync
    const changes = await db.query(`
      SELECT * FROM library_changes
      WHERE user_id = $1 AND sync_token > $2
      ORDER BY sync_token ASC
    `, [userId, lastSyncToken || 0])

    // Get current sync token
    const currentToken = await this.getCurrentSyncToken(userId)

    return {
      changes: changes.rows.map(c => ({
        type: c.change_type, // 'add', 'remove', 'update'
        itemType: c.item_type, // 'track', 'album', 'playlist'
        itemId: c.item_id,
        data: c.data,
        timestamp: c.created_at
      })),
      syncToken: currentToken
    }
  }

  async addToLibrary(userId, itemType, itemId) {
    await db.transaction(async (tx) => {
      // Add to library
      await tx.query(`
        INSERT INTO library_items (user_id, item_type, item_id, added_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT DO NOTHING
      `, [userId, itemType, itemId])

      // Record change for sync
      await tx.query(`
        INSERT INTO library_changes
          (user_id, change_type, item_type, item_id, sync_token)
        VALUES ($1, 'add', $2, $3, nextval('sync_token_seq'))
      `, [userId, itemType, itemId])
    })

    // Notify other devices
    await this.notifyDevices(userId, 'library_changed')
  }

  // Smart playlist sync
  async syncSmartPlaylist(userId, playlistId) {
    const playlist = await this.getPlaylist(playlistId)

    if (playlist.type !== 'smart') {
      throw new Error('Not a smart playlist')
    }

    // Evaluate rules against library
    const matchingTracks = await this.evaluateRules(
      userId,
      playlist.rules
    )

    // Update playlist contents
    await db.query(`
      DELETE FROM playlist_tracks WHERE playlist_id = $1
    `, [playlistId])

    for (const track of matchingTracks) {
      await db.query(`
        INSERT INTO playlist_tracks (playlist_id, track_id, position)
        VALUES ($1, $2, $3)
      `, [playlistId, track.id, track.position])
    }

    return matchingTracks
  }
}
```

### 4. Recommendations

**Personalized Discovery:**
```javascript
class RecommendationService {
  async getForYou(userId) {
    // Get user listening history
    const history = await this.getListeningHistory(userId, { days: 30 })

    // Get user embedding
    const userEmbedding = await this.getUserEmbedding(userId)

    // Generate recommendations
    const sections = []

    // Heavy rotation - recently played favorites
    sections.push({
      title: 'Heavy Rotation',
      type: 'albums',
      items: await this.getHeavyRotation(userId)
    })

    // New releases from followed artists
    sections.push({
      title: 'New Releases',
      type: 'albums',
      items: await this.getNewReleases(userId)
    })

    // Personalized mixes
    const genres = await this.getTopGenres(history)
    for (const genre of genres.slice(0, 3)) {
      sections.push({
        title: `${genre} Mix`,
        type: 'playlist',
        items: await this.generateMix(userEmbedding, genre)
      })
    }

    // Discovery - songs you haven't heard
    sections.push({
      title: 'Discovery',
      type: 'songs',
      items: await this.discoverNew(userEmbedding, history)
    })

    return sections
  }

  async generatePersonalStation(userId, seedTrackId) {
    // Get seed track features
    const seedTrack = await this.getTrack(seedTrackId)
    const seedEmbedding = await this.getTrackEmbedding(seedTrackId)

    // Get user preferences
    const userEmbedding = await this.getUserEmbedding(userId)

    // Combine seed and user preferences
    const targetEmbedding = this.blendEmbeddings(
      seedEmbedding,
      userEmbedding,
      0.7 // 70% seed, 30% user preferences
    )

    // Find similar tracks
    const candidates = await this.vectorDb.search({
      vector: targetEmbedding,
      topK: 100,
      filter: {
        // Same genre family
        genre: seedTrack.genre,
        // Exclude recently played
        id: { $nin: await this.getRecentlyPlayed(userId) }
      }
    })

    // Diversify results
    return this.diversify(candidates, {
      maxPerArtist: 3,
      totalCount: 25
    })
  }
}
```

---

## Database Schema

```sql
-- Tracks
CREATE TABLE tracks (
  id UUID PRIMARY KEY,
  isrc VARCHAR(20) UNIQUE,
  title VARCHAR(500) NOT NULL,
  artist_id UUID REFERENCES artists(id),
  album_id UUID REFERENCES albums(id),
  duration_ms INTEGER,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  explicit BOOLEAN DEFAULT FALSE,
  audio_features JSONB,
  fingerprint_hash VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audio Files (multiple qualities per track)
CREATE TABLE audio_files (
  id UUID PRIMARY KEY,
  track_id UUID REFERENCES tracks(id),
  quality VARCHAR(50), -- '256_aac', 'lossless', 'hi_res_lossless'
  format VARCHAR(20), -- 'aac', 'alac', 'flac'
  bitrate INTEGER,
  sample_rate INTEGER,
  bit_depth INTEGER,
  file_size BIGINT,
  s3_key VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- User Library
CREATE TABLE library_items (
  user_id UUID REFERENCES users(id),
  item_type VARCHAR(20), -- 'track', 'album', 'artist', 'playlist'
  item_id UUID,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, item_type, item_id)
);

-- Library Sync Changes
CREATE TABLE library_changes (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  change_type VARCHAR(20), -- 'add', 'remove', 'update'
  item_type VARCHAR(20),
  item_id UUID,
  data JSONB,
  sync_token BIGINT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_library_changes_sync ON library_changes(user_id, sync_token);

-- Uploaded/Matched Tracks
CREATE TABLE uploaded_tracks (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  original_filename VARCHAR(500),
  s3_key VARCHAR(500),
  matched_track_id UUID REFERENCES tracks(id),
  match_confidence DECIMAL,
  uploaded_at TIMESTAMP DEFAULT NOW()
);

-- Listening History
CREATE TABLE listening_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  track_id UUID REFERENCES tracks(id),
  played_at TIMESTAMP DEFAULT NOW(),
  duration_played_ms INTEGER,
  context_type VARCHAR(50), -- 'album', 'playlist', 'radio'
  context_id UUID
);

CREATE INDEX idx_history_user ON listening_history(user_id, played_at DESC);

-- Playlists
CREATE TABLE playlists (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  type VARCHAR(20) DEFAULT 'regular', -- 'regular', 'smart'
  rules JSONB, -- For smart playlists
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Audio Fingerprinting for Matching

**Decision**: Use acoustic fingerprints to match uploads

**Rationale**:
- Works regardless of file format/quality
- Handles slight variations
- No metadata required

### 2. Sync Token Architecture

**Decision**: Use incrementing sync tokens for library sync

**Rationale**:
- Simple change tracking
- Efficient delta sync
- Handles offline changes

### 3. Hybrid Quality Streaming

**Decision**: Adaptive quality with lossless option

**Rationale**:
- Matches user preferences
- Considers network conditions
- Premium differentiator

---

## Consistency and Idempotency

### Write Semantics by Operation

| Operation | Consistency | Idempotency | Conflict Resolution |
|-----------|-------------|-------------|---------------------|
| Add to Library | Strong (PostgreSQL transaction) | Idempotent via `ON CONFLICT DO NOTHING` | Last-write-wins with sync tokens |
| Remove from Library | Strong | Idempotent (DELETE is no-op if missing) | Sync token ordering |
| Create Playlist | Strong | Client-generated UUID prevents duplicates | N/A (unique per user) |
| Update Playlist | Strong | Version column prevents lost updates | Reject stale writes, return current state |
| Record Play | Eventual (async via queue) | Dedupe by (user_id, track_id, timestamp window) | Accept all, dedupe later |
| Library Sync | Eventual (sync tokens) | Replay-safe via monotonic sync tokens | Token-based ordering resolves conflicts |

### Idempotency Key Implementation

For operations that create resources or trigger side effects, clients include an idempotency key:

```javascript
// Client sends: X-Idempotency-Key: <uuid>
app.post('/api/v1/library/tracks', async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];

  // Check if we've seen this request before
  const cached = await redis.get(`idempotency:${req.user.id}:${idempotencyKey}`);
  if (cached) {
    return res.json(JSON.parse(cached)); // Return cached response
  }

  // Process the request
  const result = await libraryService.addTrack(req.user.id, req.body.trackId);

  // Cache response for 24 hours
  await redis.setex(
    `idempotency:${req.user.id}:${idempotencyKey}`,
    86400,
    JSON.stringify(result)
  );

  res.json(result);
});
```

### Library Sync Conflict Resolution

When devices sync after being offline, conflicts are resolved using sync tokens:

```javascript
class ConflictResolver {
  async resolveLibraryConflicts(userId, clientChanges, serverSyncToken) {
    // Get all server changes since client's last sync
    const serverChanges = await this.getChangesSince(userId, clientChanges.lastSyncToken);

    const resolved = [];
    for (const clientChange of clientChanges.items) {
      const conflicting = serverChanges.find(
        s => s.itemType === clientChange.itemType && s.itemId === clientChange.itemId
      );

      if (!conflicting) {
        // No conflict - apply client change
        resolved.push({ action: 'apply', change: clientChange });
      } else if (clientChange.timestamp > conflicting.timestamp) {
        // Client wins - more recent
        resolved.push({ action: 'apply', change: clientChange });
      } else {
        // Server wins - client should accept server state
        resolved.push({ action: 'reject', serverState: conflicting });
      }
    }
    return resolved;
  }
}
```

### Replay Handling

Play history events are deduplicated to prevent inflated counts:

```sql
-- Dedupe window: same track played within 30 seconds = single play
INSERT INTO listening_history (user_id, track_id, played_at, duration_played_ms)
SELECT $1, $2, $3, $4
WHERE NOT EXISTS (
  SELECT 1 FROM listening_history
  WHERE user_id = $1
    AND track_id = $2
    AND played_at > $3 - INTERVAL '30 seconds'
    AND played_at < $3 + INTERVAL '30 seconds'
);
```

---

## Authentication, Authorization, and Rate Limiting

### Authentication Flow

```
┌─────────┐     ┌─────────────┐     ┌─────────┐     ┌─────────┐
│  Client │────▶│ API Gateway │────▶│  Auth   │────▶│  Redis  │
│         │◀────│             │◀────│ Service │◀────│ Session │
└─────────┘     └─────────────┘     └─────────┘     └─────────┘
```

**Session-Based Auth (Local Development)**:

```javascript
// Session configuration
const sessionConfig = {
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax'
  }
};

// Login endpoint
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await userService.validateCredentials(email, password);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Create session
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.subscription = user.subscriptionTier;

  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

// Session validation middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}
```

### Role-Based Access Control (RBAC)

| Role | Permissions |
|------|-------------|
| `user` | Read catalog, manage own library, stream (based on subscription), view own history |
| `premium_user` | All `user` permissions + lossless streaming, offline downloads |
| `curator` | All `user` permissions + create public playlists, feature content |
| `admin` | Full access: manage users, content moderation, view analytics, system config |

```javascript
// RBAC middleware
const rbac = {
  user: ['catalog:read', 'library:own', 'stream:basic', 'history:own'],
  premium_user: ['catalog:read', 'library:own', 'stream:lossless', 'stream:download', 'history:own'],
  curator: ['catalog:read', 'library:own', 'stream:basic', 'playlist:public', 'content:feature'],
  admin: ['*']
};

function requirePermission(permission) {
  return (req, res, next) => {
    const role = req.session.role || 'user';
    const permissions = rbac[role] || [];

    if (permissions.includes('*') || permissions.includes(permission)) {
      return next();
    }

    res.status(403).json({ error: 'Insufficient permissions' });
  };
}

// Usage
app.delete('/api/v1/admin/tracks/:id', requireAuth, requirePermission('admin'), deleteTrack);
app.post('/api/v1/playlists/public', requireAuth, requirePermission('playlist:public'), createPublicPlaylist);
```

### API Endpoint Authorization Matrix

| Endpoint | user | premium_user | curator | admin |
|----------|------|--------------|---------|-------|
| `GET /api/v1/catalog/*` | Yes | Yes | Yes | Yes |
| `GET /api/v1/stream/:trackId` | 256 AAC | Lossless | 256 AAC | Lossless |
| `POST /api/v1/library/*` | Yes | Yes | Yes | Yes |
| `GET /api/v1/admin/*` | No | No | No | Yes |
| `POST /api/v1/playlists/public` | No | No | Yes | Yes |
| `DELETE /api/v1/tracks/:id` | No | No | No | Yes |

### Rate Limiting

Rate limits protect against abuse and ensure fair resource usage:

```javascript
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');

// Global rate limit
const globalLimiter = rateLimit({
  store: new RedisStore({ client: redisClient }),
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false
});

// Streaming-specific limits (more generous for playback)
const streamLimiter = rateLimit({
  store: new RedisStore({ client: redisClient, prefix: 'rl:stream:' }),
  windowMs: 60 * 1000,
  max: 300, // Higher limit for stream segments
  keyGenerator: (req) => req.session.userId
});

// Search rate limit (expensive operation)
const searchLimiter = rateLimit({
  store: new RedisStore({ client: redisClient, prefix: 'rl:search:' }),
  windowMs: 60 * 1000,
  max: 30, // 30 searches per minute
  keyGenerator: (req) => req.session.userId
});

// Admin endpoints - stricter limits
const adminLimiter = rateLimit({
  store: new RedisStore({ client: redisClient, prefix: 'rl:admin:' }),
  windowMs: 60 * 1000,
  max: 50
});

app.use('/api/v1', globalLimiter);
app.use('/api/v1/stream', streamLimiter);
app.use('/api/v1/search', searchLimiter);
app.use('/api/v1/admin', adminLimiter);
```

**Rate Limit Summary**:

| Endpoint Category | Limit | Window | Key |
|-------------------|-------|--------|-----|
| Global API | 100 req | 1 min | IP + User ID |
| Stream segments | 300 req | 1 min | User ID |
| Search | 30 req | 1 min | User ID |
| Admin | 50 req | 1 min | User ID |
| Login attempts | 5 req | 15 min | IP |

---

## Observability

### Metrics (Prometheus)

Key metrics exposed at `/metrics` endpoint:

```javascript
const promClient = require('prom-client');

// Enable default metrics (CPU, memory, event loop lag)
promClient.collectDefaultMetrics({ prefix: 'apple_music_' });

// Custom business metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'apple_music_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

const streamStartLatency = new promClient.Histogram({
  name: 'apple_music_stream_start_latency_seconds',
  help: 'Time from stream request to first byte',
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2]
});

const activeStreams = new promClient.Gauge({
  name: 'apple_music_active_streams',
  help: 'Number of currently active audio streams'
});

const libraryOperations = new promClient.Counter({
  name: 'apple_music_library_operations_total',
  help: 'Library operations by type',
  labelNames: ['operation', 'item_type'] // add, remove, sync
});

const searchLatency = new promClient.Histogram({
  name: 'apple_music_search_latency_seconds',
  help: 'Search query latency',
  labelNames: ['search_type'], // catalog, library
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2]
});

const cacheHitRate = new promClient.Counter({
  name: 'apple_music_cache_hits_total',
  help: 'Cache hit/miss by cache type',
  labelNames: ['cache', 'result'] // redis/memory, hit/miss
});
```

### Structured Logging

JSON-formatted logs for aggregation in Grafana Loki or similar:

```javascript
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'apple-music-api',
    version: process.env.APP_VERSION || '1.0.0'
  }
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  req.log = logger.child({ requestId, userId: req.session?.userId });

  res.on('finish', () => {
    req.log.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      userAgent: req.headers['user-agent']
    }, 'request completed');
  });

  next();
});

// Example: Streaming event log
logger.info({
  event: 'stream_started',
  userId: user.id,
  trackId: track.id,
  quality: selectedQuality,
  networkType: req.headers['x-network-type']
}, 'User started streaming');
```

### Distributed Tracing

OpenTelemetry integration for request tracing across services:

```javascript
const { trace, context, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('apple-music-api');

async function getStreamUrl(trackId, userId, options) {
  return tracer.startActiveSpan('getStreamUrl', async (span) => {
    try {
      span.setAttributes({
        'track.id': trackId,
        'user.id': userId,
        'stream.preferred_quality': options.preferredQuality
      });

      // Child span for subscription check
      const user = await tracer.startActiveSpan('checkSubscription', async (childSpan) => {
        const result = await userService.getUser(userId);
        childSpan.end();
        return result;
      });

      // Child span for URL generation
      const url = await tracer.startActiveSpan('generateSignedUrl', async (childSpan) => {
        const result = await this.generateSignedUrl(trackId, userId);
        childSpan.end();
        return result;
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return url;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### SLI/SLO Dashboard (Grafana)

**Service Level Indicators**:

| SLI | Target SLO | Alert Threshold |
|-----|------------|-----------------|
| Stream start latency (p95) | < 200ms | > 300ms for 5 min |
| API availability | 99.9% | < 99.5% for 10 min |
| Search latency (p95) | < 500ms | > 750ms for 5 min |
| Library sync success rate | 99.5% | < 99% for 15 min |
| Error rate (5xx) | < 0.1% | > 0.5% for 5 min |

**Grafana Dashboard Panels** (for local development):

```yaml
# docker-compose.yml addition for observability stack
services:
  prometheus:
    image: prom/prometheus:v2.47.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:10.1.0
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
```

**prometheus.yml**:
```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'apple-music-api'
    static_configs:
      - targets: ['host.docker.internal:3000']
    metrics_path: /metrics
```

### Alert Rules (Prometheus Alertmanager)

```yaml
groups:
  - name: apple-music-alerts
    rules:
      - alert: HighStreamLatency
        expr: histogram_quantile(0.95, rate(apple_music_stream_start_latency_seconds_bucket[5m])) > 0.3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Stream start latency is high"
          description: "p95 stream latency is {{ $value }}s (threshold: 300ms)"

      - alert: HighErrorRate
        expr: sum(rate(apple_music_http_request_duration_seconds_count{status_code=~"5.."}[5m])) / sum(rate(apple_music_http_request_duration_seconds_count[5m])) > 0.005
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High 5xx error rate"
          description: "Error rate is {{ $value | humanizePercentage }}"

      - alert: CacheHitRateLow
        expr: sum(rate(apple_music_cache_hits_total{result="hit"}[10m])) / sum(rate(apple_music_cache_hits_total[10m])) < 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 80%"
```

### Audit Logging

Security-relevant events logged to a separate audit trail:

```javascript
const auditLogger = pino({
  level: 'info',
  base: { type: 'audit' }
}).child({ stream: 'audit' });

// Audit log middleware for sensitive operations
function auditLog(action) {
  return (req, res, next) => {
    const auditEntry = {
      action,
      userId: req.session?.userId,
      targetResource: req.params.id || req.body?.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString()
    };

    res.on('finish', () => {
      auditEntry.statusCode = res.statusCode;
      auditEntry.success = res.statusCode < 400;
      auditLogger.info(auditEntry, `Audit: ${action}`);
    });

    next();
  };
}

// Usage on sensitive endpoints
app.post('/api/v1/auth/login', auditLog('user.login'), loginHandler);
app.post('/api/v1/auth/logout', auditLog('user.logout'), logoutHandler);
app.delete('/api/v1/admin/users/:id', auditLog('admin.user.delete'), deleteUserHandler);
app.put('/api/v1/admin/tracks/:id', auditLog('admin.track.update'), updateTrackHandler);
```

**Audit Events Captured**:

| Event | Details Logged |
|-------|----------------|
| `user.login` | User ID, IP, success/failure, timestamp |
| `user.logout` | User ID, session duration |
| `admin.user.delete` | Admin ID, target user ID, reason |
| `admin.track.update` | Admin ID, track ID, fields changed |
| `library.export` | User ID, export format, item count |
| `subscription.change` | User ID, old tier, new tier |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Audio matching | Fingerprinting | Metadata | Accuracy |
| Library sync | Sync tokens | Full sync | Efficiency |
| Streaming | Adaptive + lossless | Fixed bitrate | Quality, bandwidth |
| Recommendations | Hybrid CF + content | Pure CF | Cold start |
| Consistency | Strong for library, eventual for plays | All strong | Performance vs correctness tradeoff |
| Auth | Session + Redis | JWT | Easier revocation, simpler for local dev |
| Rate limiting | Redis-backed sliding window | In-memory | Distributed, persistent across restarts |

---

## Implementation Notes

This section documents the observability, security, and consistency improvements implemented in the backend codebase.

### 1. Structured Logging with Pino

**Location:** `backend/src/shared/logger.js`

**What was implemented:**
- JSON-formatted logging using pino
- Request correlation via `X-Request-ID` headers
- Separate audit logger for security events
- Stream-specific event logging

**Why this improves the system:**
- **Queryability**: JSON logs enable filtering in log aggregation tools (Loki, ELK, CloudWatch). Finding all errors for a specific user becomes a simple query: `userId="abc" AND level="error"`.
- **Correlation**: Request IDs allow tracing a single request across all log entries, essential for debugging distributed issues.
- **Compliance**: Audit logs create a separate, immutable record of security-relevant events (login attempts, admin actions, permission changes) required for SOC2/GDPR compliance.
- **Performance**: Pino is one of the fastest Node.js loggers, adding minimal overhead to request processing.

### 2. Prometheus Metrics

**Location:** `backend/src/shared/metrics.js`

**What was implemented:**
- HTTP request duration histogram (p50/p95/p99 latency)
- Stream start latency histogram (critical SLI)
- Active streams gauge (capacity planning)
- Library/playlist operation counters
- Cache hit rate counters
- Rate limit hit counters
- Idempotency cache usage counters

**Why this improves the system:**
- **SLI Tracking**: Histograms for stream latency directly map to SLOs (e.g., "95th percentile stream start < 200ms"). Dashboards can show real-time SLO compliance.
- **Capacity Planning**: Active streams gauge helps determine when to scale. If `activeStreams` approaches server capacity, auto-scaling can trigger.
- **Cache Effectiveness**: Cache hit counters reveal when Redis is providing value. A low hit rate suggests cache TTL issues or key invalidation bugs.
- **Alerting**: Metrics enable Prometheus alerting rules. Example: alert when error rate exceeds 0.5% for 5 minutes.

### 3. Rate Limiting

**Location:** `backend/src/shared/rateLimit.js`

**What was implemented:**
- Redis-backed sliding window rate limiting
- Tiered limits by endpoint category:
  - Global: 100 req/min
  - Streaming: 300 req/min (higher for segment fetching)
  - Search: 30 req/min (expensive operation)
  - Login: 5 attempts/15 min (brute force protection)
  - Admin: 50 req/min
  - Playlist creation: 10/hour (spam prevention)

**Why this improves the system:**
- **Distributed Consistency**: Redis-backed limiting ensures rate limits are enforced correctly across multiple server instances. In-memory limits would reset on restart and vary by instance.
- **Fair Resource Usage**: Different limits for different operations prevent abuse while allowing legitimate usage. Users can stream many songs but cannot spam search requests.
- **Security**: Login rate limiting prevents credential stuffing attacks. 5 attempts per 15 minutes makes brute force impractical.
- **Graceful Degradation**: Standard `429 Too Many Requests` response with `Retry-After` header tells clients exactly when to retry.

### 4. Idempotency for Playlist Operations

**Location:** `backend/src/shared/idempotency.js`, `backend/src/routes/playlists.js`

**What was implemented:**
- `X-Idempotency-Key` header support for POST operations
- 24-hour cached response storage in Redis
- Automatic response replay for duplicate requests
- Idempotency key validation (format checking)

**Why this improves the system:**
- **Network Resilience**: Mobile clients on spotty connections can safely retry requests. If a playlist creation request times out, the client can resend with the same idempotency key and either get the cached success response or trigger a new creation.
- **Duplicate Prevention**: Without idempotency, a network timeout after successful creation leads to duplicate playlists when the client retries.
- **Consistent User Experience**: Users never see unexpected duplicate content. The database stays clean.
- **24-Hour TTL**: Balances memory usage (keys are cleaned up) with a reasonable retry window (user could retry the next day).

### 5. Session-Based Authentication with RBAC

**Location:** `backend/src/middleware/auth.js`

**What was implemented:**
- Session validation with Redis caching
- Role-based permissions: `user`, `premium_user`, `curator`, `admin`
- Permission-based middleware (`requirePermission('playlist:public')`)
- Subscription tier checks
- Session invalidation for logout

**Why this improves the system:**
- **Instant Revocation**: Unlike JWTs, sessions can be invalidated immediately. If a user's subscription expires or they're banned, their access is revoked on the next request.
- **Redis Caching**: Sessions are validated from cache on most requests (avoiding database hits), with cache-aside pattern for cache misses.
- **Granular Permissions**: RBAC enables fine-grained access control. A curator can create public playlists but cannot access admin endpoints. Permissions can evolve independently of roles.
- **Subscription Enforcement**: Streaming quality is automatically limited based on subscription tier. Premium users get lossless; free users get 256 AAC.

### 6. Enhanced Health Checks

**Location:** `backend/src/shared/health.js`

**What was implemented:**
- `/health` - Simple liveness probe
- `/health/ready` - Detailed readiness check with component status
- PostgreSQL and Redis connectivity checks
- Latency measurement per component

**Why this improves the system:**
- **Load Balancer Integration**: Kubernetes and load balancers use these endpoints to route traffic only to healthy instances.
- **Component-Level Visibility**: When `/health/ready` fails, the response shows exactly which component (PostgreSQL or Redis) is unhealthy, speeding up incident diagnosis.
- **Zero-Downtime Deployments**: Readiness checks ensure new instances don't receive traffic until all dependencies are connected.

### 7. Streaming Metrics

**Location:** `backend/src/routes/streaming.js`

**What was implemented:**
- Stream start latency tracking (histogram)
- Active streams gauge by quality
- Total streams counter by quality and subscription tier
- Stream lifecycle events (started, prefetch, completed, ended)

**Why this improves the system:**
- **SLI Monitoring**: Stream start latency is a critical user experience metric. Tracking p95 latency ensures we meet the < 200ms target.
- **Quality Distribution**: Metrics show which quality tiers are most used. If 90% of streams are 256 AAC, it might indicate bandwidth issues or free tier dominance.
- **Capacity Signals**: Active streams gauge provides real-time load visibility. Correlating with CPU/memory metrics reveals per-stream resource cost.
- **User Journey Tracking**: Stream events (start, prefetch, complete, end) enable funnel analysis. High prefetch-to-start ratio indicates good UX; high start-to-end-early ratio might indicate content issues.

### Files Created/Modified

| File | Purpose |
|------|---------|
| `src/shared/logger.js` | Structured logging with pino |
| `src/shared/metrics.js` | Prometheus metrics collection |
| `src/shared/rateLimit.js` | Redis-backed rate limiting |
| `src/shared/idempotency.js` | Request idempotency handling |
| `src/shared/health.js` | Health check endpoints |
| `src/middleware/auth.js` | Enhanced auth with RBAC |
| `src/index.js` | Integration of all modules |
| `src/routes/playlists.js` | Idempotency for mutations |
| `src/routes/streaming.js` | Stream metrics and logging |

### Dependencies Added

```json
{
  "pino": "^8.x",
  "pino-http": "^9.x",
  "prom-client": "^15.x",
  "express-rate-limit": "^7.x",
  "rate-limit-redis": "^4.x"
}
```

### Endpoint Summary

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness probe |
| `GET /health/ready` | Readiness probe with component status |
| `GET /metrics` | Prometheus metrics export |

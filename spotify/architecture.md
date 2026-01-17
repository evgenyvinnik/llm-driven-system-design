# Design Spotify - Architecture

## System Overview

Spotify is a music streaming platform with personalized recommendations. Core challenges involve audio delivery, recommendation algorithms, and offline synchronization.

**Learning Goals:**
- Build audio streaming pipelines
- Design recommendation systems
- Implement offline-first architecture
- Handle playback analytics at scale

---

## Requirements

### Functional Requirements

1. **Stream**: Play music with adaptive quality
2. **Library**: Browse artists, albums, songs
3. **Playlists**: Create and manage playlists
4. **Discover**: Personalized recommendations
5. **Offline**: Download for offline listening

### Non-Functional Requirements

- **Latency**: < 200ms to start playback
- **Availability**: 99.99% for streaming
- **Scale**: 500M users, 100M songs
- **Quality**: 320kbps high quality streaming

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│       Mobile │ Desktop │ Web │ Car │ Smart Speaker              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CDN                                     │
│              (Audio files, album art, assets)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Catalog Service│    │Playback Service│    │  Rec Service  │
│               │    │               │    │               │
│ - Artists     │    │ - Stream URLs │    │ - Discovery   │
│ - Albums      │    │ - Play state  │    │ - Radio       │
│ - Tracks      │    │ - Analytics   │    │ - Similar     │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │           Feature Store + ML                  │
│   - Catalog     │           - User embeddings                   │
│   - Playlists   │           - Track embeddings                  │
│   - Users       │           - Listening history                 │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Audio Streaming

**Adaptive Bitrate Streaming:**
```
Audio Files Stored as:
├── track_123_96kbps.ogg    (Low quality, mobile data)
├── track_123_160kbps.ogg   (Normal quality)
├── track_123_320kbps.ogg   (High quality, premium)
```

**Streaming Flow:**
```javascript
async function getStreamUrl(trackId, userId) {
  // Check user subscription
  const user = await getUser(userId)
  const maxQuality = user.isPremium ? 320 : 160

  // Determine quality based on network
  const quality = determineQuality(user.connectionType, maxQuality)

  // Generate signed URL with expiry
  const url = await cdn.signedUrl(`tracks/${trackId}_${quality}kbps.ogg`, {
    expiresIn: 3600,
    userId // For analytics attribution
  })

  return { url, quality, expiresAt: Date.now() + 3600000 }
}
```

### 2. Recommendation Engine

**Hybrid Approach:**
```javascript
async function getDiscoverWeekly(userId) {
  // 1. Get user's listening history
  const history = await getListeningHistory(userId, { days: 28 })

  // 2. Get user embedding from history
  const userEmbedding = await getUserEmbedding(userId)

  // 3. Collaborative filtering: Find similar users
  const similarUsers = await findSimilarUsers(userEmbedding, 100)
  const collaborativeTracks = await getTopTracks(similarUsers, {
    excludeListened: history.trackIds
  })

  // 4. Content-based: Find similar tracks
  const likedTracks = history.filter(h => h.rating > 0.7)
  const contentBasedTracks = await findSimilarTracks(likedTracks, {
    excludeListened: history.trackIds
  })

  // 5. Blend results (60% collaborative, 40% content)
  const blended = blendResults(collaborativeTracks, contentBasedTracks, 0.6)

  // 6. Diversify (avoid too many from same artist)
  return diversify(blended, { maxPerArtist: 2, totalCount: 30 })
}
```

**Track Embeddings:**
```javascript
// Each track has a feature vector based on:
interface TrackEmbedding {
  trackId: string
  embedding: number[] // 128-dimensional vector
  // Derived from:
  // - Audio features (tempo, energy, danceability, acousticness)
  // - Genre tags
  // - User interaction patterns
  // - Co-occurrence in playlists
}

function findSimilarTracks(tracks, options) {
  const avgEmbedding = averageEmbeddings(tracks.map(t => t.embedding))

  // Approximate nearest neighbors search
  return vectorDb.query({
    vector: avgEmbedding,
    topK: 100,
    filter: { trackId: { $nin: options.excludeListened } }
  })
}
```

### 3. Offline Sync

**Download Manager:**
```javascript
class OfflineManager {
  async downloadPlaylist(playlistId) {
    const tracks = await getPlaylistTracks(playlistId)

    for (const track of tracks) {
      await this.downloadTrack(track.id)
    }

    // Store playlist metadata locally
    await localDb.put('playlists', playlistId, {
      ...playlist,
      downloadedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
    })
  }

  async downloadTrack(trackId) {
    // Check if already downloaded
    if (await localDb.has('tracks', trackId)) return

    // Get download URL with DRM
    const { url, license } = await api.getOfflineDownload(trackId)

    // Download encrypted audio
    const audioData = await fetch(url).then(r => r.arrayBuffer())

    // Store locally
    await localDb.put('tracks', trackId, {
      audio: audioData,
      license,
      downloadedAt: Date.now()
    })
  }

  async playOffline(trackId) {
    const { audio, license } = await localDb.get('tracks', trackId)

    // Verify license still valid
    if (!this.verifyLicense(license)) {
      throw new Error('License expired')
    }

    // Decrypt and play
    return this.decryptAndPlay(audio, license)
  }
}
```

### 4. Playback Analytics

**Stream Counting (for royalties):**
```javascript
// Client reports playback events
async function reportPlayback(userId, trackId, event) {
  await kafka.send('playback_events', {
    userId,
    trackId,
    event, // 'start', 'progress', 'complete', 'skip'
    timestamp: Date.now(),
    position: event.position, // Seconds into track
    deviceType: event.device
  })
}

// Stream counted after 30 seconds or 50% of track (whichever is less)
async function processPlaybackEvent(event) {
  if (event.event === 'progress' && event.position >= 30) {
    // Count as a stream
    await incrementStreamCount(event.trackId)
    await attributeRoyalty(event.trackId, event.userId)
  }
}
```

---

## Database Schema

```sql
-- Artists
CREATE TABLE artists (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  bio TEXT,
  image_url VARCHAR(500),
  verified BOOLEAN DEFAULT FALSE,
  monthly_listeners INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Albums
CREATE TABLE albums (
  id UUID PRIMARY KEY,
  artist_id UUID REFERENCES artists(id),
  title VARCHAR(200) NOT NULL,
  release_date DATE,
  cover_url VARCHAR(500),
  album_type VARCHAR(20), -- 'album', 'single', 'ep'
  total_tracks INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tracks
CREATE TABLE tracks (
  id UUID PRIMARY KEY,
  album_id UUID REFERENCES albums(id),
  title VARCHAR(200) NOT NULL,
  duration_ms INTEGER,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  explicit BOOLEAN DEFAULT FALSE,
  preview_url VARCHAR(500),
  stream_count BIGINT DEFAULT 0,
  audio_features JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Playlists
CREATE TABLE playlists (
  id UUID PRIMARY KEY,
  owner_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  cover_url VARCHAR(500),
  is_public BOOLEAN DEFAULT TRUE,
  is_collaborative BOOLEAN DEFAULT FALSE,
  follower_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Playlist tracks (ordered)
CREATE TABLE playlist_tracks (
  playlist_id UUID REFERENCES playlists(id),
  track_id UUID REFERENCES tracks(id),
  position INTEGER NOT NULL,
  added_by UUID REFERENCES users(id),
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (playlist_id, track_id)
);

-- User library (saved tracks/albums)
CREATE TABLE user_library (
  user_id UUID REFERENCES users(id),
  item_type VARCHAR(20), -- 'track', 'album', 'artist', 'playlist'
  item_id UUID,
  saved_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, item_type, item_id)
);
```

---

## Key Design Decisions

### 1. CDN for Audio

**Decision**: Serve all audio through CDN with signed URLs

**Rationale**:
- Global low-latency delivery
- Edge caching for popular tracks
- Signed URLs for access control

### 2. Hybrid Recommendations

**Decision**: Combine collaborative and content-based filtering

**Rationale**:
- Collaborative: Catches hidden preferences
- Content-based: Works for new users (cold start)
- Blend provides best of both

### 3. 30-Second Stream Threshold

**Decision**: Count stream after 30 seconds of playback

**Rationale**:
- Industry standard for royalty attribution
- Prevents accidental skips from counting
- Balances artist/label interests

---

## Consistency and Idempotency

### Consistency Model

**Strong Consistency (PostgreSQL):**
- User account operations (registration, subscription changes)
- Playlist ownership and permission changes
- Financial transactions (subscription billing)
- Stream count increments use `UPDATE tracks SET stream_count = stream_count + 1` with row-level locking

**Eventual Consistency (acceptable):**
- Recommendation updates (regenerate Discover Weekly weekly)
- Monthly listener counts (batch aggregated)
- Search index updates (lag of 1-5 seconds acceptable)
- Playback analytics (processed through Kafka, eventual)

### Idempotency for Core Writes

**Playback Events:**
```javascript
// Client generates idempotency key per playback session
const playbackEvent = {
  idempotencyKey: `${userId}_${trackId}_${sessionStartTimestamp}`,
  trackId,
  event: 'stream_counted',
  position: 32 // seconds
}

// Server-side deduplication
async function processPlaybackEvent(event) {
  // Check if already processed (Redis with 24h TTL)
  const processed = await redis.get(`playback:${event.idempotencyKey}`)
  if (processed) return { deduplicated: true }

  // Mark as processing (atomic)
  const acquired = await redis.set(
    `playback:${event.idempotencyKey}`,
    'processing',
    'NX', 'EX', 86400
  )
  if (!acquired) return { deduplicated: true }

  // Process the stream count
  await incrementStreamCount(event.trackId)
  await redis.set(`playback:${event.idempotencyKey}`, 'completed', 'EX', 86400)
}
```

**Playlist Modifications:**
```javascript
// Add track to playlist with idempotency
async function addTrackToPlaylist(playlistId, trackId, requestId) {
  // Use request ID for idempotency
  const lockKey = `playlist_add:${requestId}`
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 300)

  if (!acquired) {
    // Return cached result from previous identical request
    const cached = await redis.get(`playlist_result:${requestId}`)
    return cached ? JSON.parse(cached) : { status: 'in_progress' }
  }

  // Upsert pattern for playlist_tracks
  const result = await db.query(`
    INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by, added_at)
    VALUES ($1, $2, (SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_tracks WHERE playlist_id = $1), $3, NOW())
    ON CONFLICT (playlist_id, track_id) DO NOTHING
    RETURNING *
  `, [playlistId, trackId, userId])

  await redis.set(`playlist_result:${requestId}`, JSON.stringify(result), 'EX', 300)
  return result
}
```

**Conflict Resolution for Collaborative Playlists:**
- Last-write-wins for track reordering (position updates)
- Concurrent additions: Both tracks added, positions auto-incremented
- Concurrent deletions: Idempotent (DELETE is safe to replay)
- Track already exists: `ON CONFLICT DO NOTHING` prevents duplicates

### Replay Handling

**Kafka Consumer Replay:**
```javascript
// Consumer tracks offset, but events are idempotent anyway
consumer.on('message', async (message) => {
  const event = JSON.parse(message.value)

  // Idempotency check using event's unique key
  const eventKey = `event:${event.type}:${event.idempotencyKey}`
  if (await redis.exists(eventKey)) {
    // Already processed, acknowledge and skip
    return consumer.commit()
  }

  await processEvent(event)
  await redis.set(eventKey, '1', 'EX', 7 * 24 * 3600) // 7 day TTL
  consumer.commit()
})
```

---

## Authentication, Authorization, and Rate Limiting

### Authentication

**Session-Based Auth (for local development):**
```javascript
// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body
  const user = await db.query('SELECT * FROM users WHERE email = $1', [email])

  if (!user || !await bcrypt.compare(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  // Create session in Redis (4 hour TTL, sliding)
  const sessionId = crypto.randomUUID()
  await redis.hset(`session:${sessionId}`, {
    userId: user.id,
    email: user.email,
    isPremium: user.is_premium,
    createdAt: Date.now()
  })
  await redis.expire(`session:${sessionId}`, 14400) // 4 hours

  res.cookie('session', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 14400000
  })

  return res.json({ user: { id: user.id, email: user.email } })
})

// Session middleware
async function requireAuth(req, res, next) {
  const sessionId = req.cookies.session
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' })

  const session = await redis.hgetall(`session:${sessionId}`)
  if (!session.userId) return res.status(401).json({ error: 'Session expired' })

  // Sliding expiration
  await redis.expire(`session:${sessionId}`, 14400)

  req.user = session
  next()
}
```

### Authorization (RBAC)

**Roles:**
| Role | Description | Access |
|------|-------------|--------|
| `user` | Regular user | Own library, playlists, streaming |
| `premium` | Premium subscriber | High quality, offline, no ads |
| `artist` | Verified artist | Own artist page, analytics |
| `admin` | Platform admin | All data, user management |

**Permission Checks:**
```javascript
// Middleware for role-based access
function requireRole(...roles) {
  return async (req, res, next) => {
    const userRoles = await getUserRoles(req.user.userId)
    const hasRole = roles.some(role => userRoles.includes(role))

    if (!hasRole) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }
    next()
  }
}

// Playlist access control
async function canEditPlaylist(userId, playlistId) {
  const playlist = await db.query(
    'SELECT owner_id, is_collaborative FROM playlists WHERE id = $1',
    [playlistId]
  )

  if (!playlist) return false
  if (playlist.owner_id === userId) return true
  if (playlist.is_collaborative) {
    // Check if user is a collaborator
    const collaborator = await db.query(
      'SELECT 1 FROM playlist_collaborators WHERE playlist_id = $1 AND user_id = $2',
      [playlistId, userId]
    )
    return !!collaborator
  }
  return false
}

// Route example
app.put('/api/playlists/:id', requireAuth, async (req, res) => {
  if (!await canEditPlaylist(req.user.userId, req.params.id)) {
    return res.status(403).json({ error: 'Cannot edit this playlist' })
  }
  // ... update playlist
})
```

### Admin API Boundaries

```javascript
// Admin routes separated with prefix
app.use('/api/admin', requireAuth, requireRole('admin'))

// Admin endpoints
app.get('/api/admin/users', async (req, res) => {
  // Paginated user list
  const users = await db.query(`
    SELECT id, email, created_at, is_premium, last_login
    FROM users ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [req.query.limit || 50, req.query.offset || 0])
  res.json(users)
})

app.post('/api/admin/users/:id/ban', async (req, res) => {
  await db.query('UPDATE users SET banned = true WHERE id = $1', [req.params.id])
  // Invalidate all sessions for this user
  const sessions = await redis.keys(`session:*`)
  for (const key of sessions) {
    const session = await redis.hgetall(key)
    if (session.userId === req.params.id) {
      await redis.del(key)
    }
  }
  res.json({ success: true })
})
```

### Rate Limiting

**Configuration (per endpoint category):**
| Endpoint Category | Limit | Window | Scope |
|-------------------|-------|--------|-------|
| Auth (login/register) | 5 | 15 min | IP |
| Search | 60 | 1 min | User |
| Playback (stream URLs) | 300 | 1 min | User |
| Library writes | 100 | 1 min | User |
| Recommendations | 30 | 1 min | User |
| Admin endpoints | 1000 | 1 min | User |

**Implementation (Redis sliding window):**
```javascript
async function rateLimit(key, limit, windowSec) {
  const now = Date.now()
  const windowStart = now - (windowSec * 1000)

  // Remove old entries, add new one, count
  const multi = redis.multi()
  multi.zremrangebyscore(key, 0, windowStart)
  multi.zadd(key, now, `${now}:${crypto.randomUUID()}`)
  multi.zcard(key)
  multi.expire(key, windowSec)

  const results = await multi.exec()
  const count = results[2][1]

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(now + windowSec * 1000)
  }
}

// Middleware
function rateLimitMiddleware(limit, windowSec, keyFn) {
  return async (req, res, next) => {
    const key = `ratelimit:${keyFn(req)}`
    const result = await rateLimit(key, limit, windowSec)

    res.set('X-RateLimit-Limit', limit)
    res.set('X-RateLimit-Remaining', result.remaining)
    res.set('X-RateLimit-Reset', result.resetAt.toISOString())

    if (!result.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
      })
    }
    next()
  }
}

// Usage
app.use('/api/search', rateLimitMiddleware(60, 60, req => req.user?.userId || req.ip))
app.use('/api/auth', rateLimitMiddleware(5, 900, req => req.ip))
```

---

## Observability

### Metrics (Prometheus)

**Key Metrics to Collect:**
```javascript
const promClient = require('prom-client')

// Request latency histogram
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
})

// Playback events counter
const playbackEvents = new promClient.Counter({
  name: 'playback_events_total',
  help: 'Total playback events',
  labelNames: ['event_type', 'device_type']
})

// Active streams gauge
const activeStreams = new promClient.Gauge({
  name: 'active_streams',
  help: 'Number of currently active streams'
})

// Recommendation latency
const recLatency = new promClient.Histogram({
  name: 'recommendation_generation_seconds',
  help: 'Time to generate recommendations',
  labelNames: ['algorithm'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10]
})

// Cache hit rate
const cacheHits = new promClient.Counter({
  name: 'cache_hits_total',
  help: 'Cache hits',
  labelNames: ['cache_type']
})
const cacheMisses = new promClient.Counter({
  name: 'cache_misses_total',
  help: 'Cache misses',
  labelNames: ['cache_type']
})
```

**Express Middleware:**
```javascript
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000
    httpRequestDuration.observe(
      { method: req.method, route: req.route?.path || 'unknown', status_code: res.statusCode },
      duration
    )
  })
  next()
})

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType)
  res.send(await promClient.register.metrics())
})
```

### SLI Dashboards (Grafana)

**Dashboard Panels:**

1. **Availability SLI**
   - Query: `sum(rate(http_request_duration_seconds_count{status_code!~"5.."}[5m])) / sum(rate(http_request_duration_seconds_count[5m]))`
   - Target: 99.99%

2. **Latency SLI (p95)**
   - Query: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))`
   - Target: < 200ms for streaming endpoints

3. **Stream Start Latency**
   - Query: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{route="/api/playback/stream"}[5m])) by (le))`
   - Target: < 200ms

4. **Playback Events Throughput**
   - Query: `sum(rate(playback_events_total[5m])) by (event_type)`

5. **Cache Hit Ratio**
   - Query: `sum(rate(cache_hits_total[5m])) / (sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m])))`
   - Target: > 90%

### Alert Thresholds

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High Error Rate | 5xx rate > 1% for 5 min | Critical | Page on-call |
| Slow Playback Start | p95 > 500ms for 5 min | Warning | Investigate CDN |
| Low Cache Hit Rate | < 70% for 15 min | Warning | Check cache config |
| Kafka Consumer Lag | > 10000 for 10 min | Warning | Scale consumers |
| Database Connections | > 80% pool used | Warning | Increase pool size |
| Redis Memory | > 80% used | Warning | Review TTLs |

**Alertmanager Rules (local development):**
```yaml
groups:
  - name: spotify-alerts
    rules:
      - alert: HighErrorRate
        expr: sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[5m])) / sum(rate(http_request_duration_seconds_count[5m])) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High 5xx error rate"
          description: "Error rate is {{ $value | humanizePercentage }}"

      - alert: SlowPlaybackStart
        expr: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{route="/api/playback/stream"}[5m])) by (le)) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Slow playback start latency"
```

### Structured Logging

**Log Format:**
```javascript
const pino = require('pino')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'spotify-api',
    version: process.env.APP_VERSION || 'dev'
  }
})

// Request logging middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID()
  req.log = logger.child({ requestId, userId: req.user?.userId })

  req.log.info({ method: req.method, path: req.path }, 'request started')

  res.on('finish', () => {
    req.log.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - req.startTime
    }, 'request completed')
  })

  next()
})
```

**Key Log Events:**
```javascript
// Authentication events
logger.info({ userId, action: 'login', ip: req.ip }, 'user logged in')
logger.warn({ email, action: 'login_failed', ip: req.ip, reason: 'invalid_password' }, 'login attempt failed')

// Playback events
logger.info({ userId, trackId, event: 'stream_started' }, 'playback started')
logger.info({ userId, trackId, event: 'stream_counted', position: 32 }, 'stream counted for royalties')

// Error logging
logger.error({ err, userId, operation: 'playlist_update', playlistId }, 'failed to update playlist')
```

### Distributed Tracing (OpenTelemetry)

```javascript
const { trace, context, SpanStatusCode } = require('@opentelemetry/api')

const tracer = trace.getTracer('spotify-api')

// Trace a recommendation request
async function getRecommendations(userId) {
  return tracer.startActiveSpan('getRecommendations', async (span) => {
    span.setAttribute('user.id', userId)

    try {
      // Child span for history fetch
      const history = await tracer.startActiveSpan('fetchListeningHistory', async (historySpan) => {
        const result = await db.query('SELECT * FROM listening_history WHERE user_id = $1', [userId])
        historySpan.setAttribute('history.count', result.length)
        historySpan.end()
        return result
      })

      // Child span for ML inference
      const recommendations = await tracer.startActiveSpan('mlInference', async (mlSpan) => {
        const result = await recommendationEngine.generate(userId, history)
        mlSpan.setAttribute('recommendations.count', result.length)
        mlSpan.end()
        return result
      })

      span.setStatus({ code: SpanStatusCode.OK })
      return recommendations
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      span.recordException(error)
      throw error
    } finally {
      span.end()
    }
  })
}
```

### Audit Logging

**Sensitive Operations to Audit:**
```javascript
// Audit log table
// CREATE TABLE audit_logs (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   timestamp TIMESTAMP DEFAULT NOW(),
//   actor_id UUID REFERENCES users(id),
//   actor_ip INET,
//   action VARCHAR(100),
//   resource_type VARCHAR(50),
//   resource_id UUID,
//   details JSONB,
//   success BOOLEAN
// );

async function auditLog(req, action, resourceType, resourceId, details, success = true) {
  await db.query(`
    INSERT INTO audit_logs (actor_id, actor_ip, action, resource_type, resource_id, details, success)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    req.user?.userId,
    req.ip,
    action,
    resourceType,
    resourceId,
    JSON.stringify(details),
    success
  ])
}

// Usage in routes
app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  try {
    await db.query('UPDATE users SET banned = true WHERE id = $1', [req.params.id])
    await auditLog(req, 'user.ban', 'user', req.params.id, { reason: req.body.reason }, true)
    res.json({ success: true })
  } catch (err) {
    await auditLog(req, 'user.ban', 'user', req.params.id, { error: err.message }, false)
    throw err
  }
})

// Audit log for subscription changes
app.post('/api/subscription/upgrade', requireAuth, async (req, res) => {
  const before = await getSubscription(req.user.userId)
  await upgradeSubscription(req.user.userId, req.body.plan)
  const after = await getSubscription(req.user.userId)

  await auditLog(req, 'subscription.upgrade', 'user', req.user.userId, {
    before: before.plan,
    after: after.plan
  })
})
```

**Audited Actions:**
- User login/logout (success and failure)
- Subscription changes
- Admin actions (user bans, content removal)
- Playlist permission changes (add/remove collaborators)
- Account settings changes (email, password)
- Data export requests (GDPR)

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Audio delivery | CDN + signed URLs | Direct streaming | Scale, latency |
| Recommendations | Hybrid CF + CB | Pure collaborative | Cold start |
| Offline DRM | License + encryption | No DRM | Rights protection |
| Analytics | Event streaming | Batch | Real-time royalties |
| Consistency | Strong for writes, eventual for reads | Full strong consistency | Performance at scale |
| Auth | Session-based (Redis) | JWT tokens | Simpler revocation, local dev friendly |
| Rate limiting | Sliding window (Redis) | Token bucket | More accurate, prevents bursts |
| Observability | Prometheus + Grafana + Pino | ELK stack | Lighter weight for local dev |

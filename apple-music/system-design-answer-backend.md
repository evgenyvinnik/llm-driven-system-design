# Apple Music - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design Apple Music's backend infrastructure, focusing on audio streaming at scale, library synchronization across devices, and the recommendation engine. The key technical challenges are adaptive bitrate delivery with gapless playback, efficient delta-based library sync using sync tokens, and hybrid recommendation combining collaborative and content-based filtering.

For a music streaming platform serving 100M+ subscribers with 10M concurrent streams, we need strong consistency for library operations, eventual consistency for listening history, and highly available audio delivery through CDN."

## Requirements Clarification (3 minutes)

### Functional Requirements (Backend Scope)
- **Streaming API**: Serve audio files with quality selection based on subscription/network
- **Library Service**: CRUD operations with cross-device synchronization
- **Catalog Service**: Song/album/artist metadata with search
- **Recommendation Engine**: Personalized "For You" sections and radio stations
- **Play History**: Record and aggregate listening events

### Non-Functional Requirements
- **Latency**: < 200ms stream start time
- **Scale**: 100M songs, 100M subscribers, 10M concurrent streams
- **Consistency**: Strong for library, eventual for play history
- **Availability**: 99.9% for streaming endpoints

### Scale Estimates
- 100 million songs at avg 5MB = 500 TB of audio
- Multiple quality tiers (AAC 256kbps, ALAC lossless, Hi-Res) = 2PB total
- 10M concurrent streams at 256kbps = 2.5 Tbps egress

## High-Level Architecture (5 minutes)

```
                          Client Devices
                               |
                               v
                    +-------------------+
                    |        CDN        |
                    | (audio, artwork)  |
                    +-------------------+
                               |
                               v
                    +-------------------+
                    |   API Gateway     |
                    |   (rate limit)    |
                    +-------------------+
              /            |              \
             v             v               v
    +-------------+  +-------------+  +--------------+
    |  Streaming  |  |   Library   |  |   Discovery  |
    |   Service   |  |   Service   |  |   Service    |
    +-------------+  +-------------+  +--------------+
           |               |                 |
           v               v                 v
    +------------------------------------------------+
    |                  Data Layer                     |
    | PostgreSQL | Redis | Elasticsearch | MinIO     |
    +------------------------------------------------+
```

### Core Backend Services
1. **Streaming Service** - Audio file selection, signed URL generation, DRM licensing
2. **Library Service** - User library CRUD, sync token management, conflict resolution
3. **Catalog Service** - Metadata storage, search indexing, popularity aggregation
4. **Discovery Service** - Recommendations, radio generation, listening history
5. **Fingerprint Service** - Audio matching for user uploads

## Deep Dive: Streaming Service (8 minutes)

### Adaptive Quality Selection

```javascript
class StreamingService {
  constructor() {
    this.qualityTiers = [
      { name: '256_aac', bitrate: 256, codec: 'aac' },
      { name: 'lossless', bitrate: 1411, codec: 'alac' },
      { name: 'hi_res_lossless', bitrate: 9216, codec: 'alac' }
    ];
  }

  async getStreamUrl(trackId, userId, options) {
    const { preferredQuality, networkType } = options;

    // Check subscription tier
    const user = await this.userService.getUser(userId);
    const maxQuality = this.getMaxQuality(user.subscriptionTier);

    // Network-aware quality selection
    const quality = this.selectQuality(preferredQuality, networkType, maxQuality);

    // Get audio file for selected quality
    const audioFile = await db.query(`
      SELECT id, minio_key, bitrate, format
      FROM audio_files
      WHERE track_id = $1 AND quality = $2
    `, [trackId, quality]);

    // Generate signed URL with expiry
    const signedUrl = await this.minio.presignedGetObject(
      'audio-files',
      audioFile.minio_key,
      3600 // 1 hour expiry
    );

    // Record stream start for metrics
    this.metrics.streamsTotal.inc({ quality, tier: user.subscriptionTier });

    return {
      url: signedUrl,
      quality,
      format: audioFile.format,
      bitrate: audioFile.bitrate,
      expiresAt: Date.now() + 3600000
    };
  }

  selectQuality(preferred, network, max) {
    const qualities = ['256_aac', 'lossless', 'hi_res_lossless'];
    const preferredIndex = qualities.indexOf(preferred);
    const maxIndex = qualities.indexOf(max);

    // Network constraints
    const networkMax = {
      'wifi': 'hi_res_lossless',
      '5g': 'lossless',
      'lte': '256_aac',
      '3g': '256_aac'
    }[network] || '256_aac';

    const networkIndex = qualities.indexOf(networkMax);

    return qualities[Math.min(preferredIndex, maxIndex, networkIndex)];
  }
}
```

### Gapless Playback Support

```javascript
async prefetchNextTrack(currentTrackId, queue, userId, options) {
  const nextTrack = this.getNextInQueue(currentTrackId, queue);
  if (!nextTrack) return null;

  // Pre-generate stream URL for next track
  const streamInfo = await this.getStreamUrl(nextTrack.id, userId, options);

  // Log prefetch event
  logger.info({
    event: 'stream_prefetch',
    userId,
    trackId: nextTrack.id,
    currentTrackId,
    quality: streamInfo.quality
  });

  this.metrics.prefetchCount.inc();

  return streamInfo;
}
```

## Deep Dive: Library Sync Service (8 minutes)

### Sync Token Architecture

The library sync system uses monotonically increasing sync tokens for efficient delta updates:

```javascript
class LibrarySyncService {
  async syncLibrary(userId, deviceId, lastSyncToken) {
    // Get all changes since client's last sync
    const changes = await db.query(`
      SELECT
        change_type,
        item_type,
        item_id,
        data,
        sync_token,
        created_at
      FROM library_changes
      WHERE user_id = $1 AND sync_token > $2
      ORDER BY sync_token ASC
    `, [userId, lastSyncToken || 0]);

    // Get current sync token
    const currentToken = await this.getCurrentSyncToken(userId);

    this.metrics.libraryOperations.inc({ operation: 'sync', item_type: 'all' });

    return {
      changes: changes.rows,
      syncToken: currentToken,
      hasMore: changes.rows.length >= 1000
    };
  }

  async addToLibrary(userId, itemType, itemId) {
    await db.transaction(async (tx) => {
      // Add to library (idempotent)
      await tx.query(`
        INSERT INTO library_items (user_id, item_type, item_id, added_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT DO NOTHING
      `, [userId, itemType, itemId]);

      // Record change for sync using sequence
      await tx.query(`
        INSERT INTO library_changes
          (user_id, change_type, item_type, item_id, sync_token)
        VALUES ($1, 'add', $2, $3, nextval('sync_token_seq'))
      `, [userId, itemType, itemId]);
    });

    // Notify other devices via push
    await this.pushService.notifyDevices(userId, 'library_changed');

    this.metrics.libraryOperations.inc({ operation: 'add', item_type: itemType });
  }
}
```

### Conflict Resolution

```javascript
class ConflictResolver {
  async resolveConflicts(userId, clientChanges, serverSyncToken) {
    const serverChanges = await this.getChangesSince(
      userId,
      clientChanges.lastSyncToken
    );

    const resolved = [];

    for (const clientChange of clientChanges.items) {
      const conflict = serverChanges.find(
        s => s.itemType === clientChange.itemType &&
             s.itemId === clientChange.itemId
      );

      if (!conflict) {
        // No conflict - apply client change
        resolved.push({ action: 'apply', change: clientChange });
      } else if (clientChange.timestamp > conflict.timestamp) {
        // Client wins (more recent)
        resolved.push({ action: 'apply', change: clientChange });
      } else {
        // Server wins - client should accept server state
        resolved.push({ action: 'reject', serverState: conflict });
      }
    }

    return resolved;
  }
}
```

## Deep Dive: Recommendation Engine (5 minutes)

### Hybrid Recommendation Approach

```javascript
class RecommendationService {
  async getForYou(userId) {
    const sections = [];

    // Get user's listening history (last 30 days)
    const history = await this.getListeningHistory(userId, { days: 30 });

    // 1. Heavy Rotation - recently played favorites
    sections.push({
      title: 'Heavy Rotation',
      type: 'albums',
      items: await this.getHeavyRotation(userId)
    });

    // 2. New releases from followed artists
    sections.push({
      title: 'New Releases',
      type: 'albums',
      items: await this.getNewReleases(userId)
    });

    // 3. Genre-based mixes
    const topGenres = await this.getTopGenres(history);
    for (const genre of topGenres.slice(0, 3)) {
      sections.push({
        title: `${genre} Mix`,
        type: 'playlist',
        items: await this.generateGenreMix(userId, genre)
      });
    }

    return sections;
  }

  async getHeavyRotation(userId) {
    // Albums most played in last 2 weeks
    return db.query(`
      SELECT
        al.id, al.title, al.artwork_url,
        a.name AS artist_name,
        COUNT(*) AS play_count
      FROM listening_history lh
      JOIN tracks t ON lh.track_id = t.id
      JOIN albums al ON t.album_id = al.id
      JOIN artists a ON al.artist_id = a.id
      WHERE lh.user_id = $1
        AND lh.played_at > NOW() - INTERVAL '14 days'
        AND lh.completed = true
      GROUP BY al.id, al.title, al.artwork_url, a.name
      ORDER BY play_count DESC
      LIMIT 10
    `, [userId]);
  }
}
```

### Personal Radio Station

```javascript
async generatePersonalStation(userId, seedTrackId) {
  // Get seed track features
  const seedTrack = await this.getTrackWithFeatures(seedTrackId);

  // Find similar tracks based on audio features
  const candidates = await db.query(`
    SELECT t.id, t.title, a.name as artist_name,
           af.tempo, af.energy, af.valence, af.danceability
    FROM tracks t
    JOIN artists a ON t.artist_id = a.id
    JOIN audio_features af ON af.track_id = t.id
    WHERE t.id != $1
    ORDER BY (
      ABS(af.tempo - $2) * 0.2 +
      ABS(af.energy - $3) * 0.3 +
      ABS(af.valence - $4) * 0.3 +
      ABS(af.danceability - $5) * 0.2
    ) ASC
    LIMIT 100
  `, [seedTrackId, seedTrack.tempo, seedTrack.energy,
      seedTrack.valence, seedTrack.danceability]);

  // Diversify: max 3 tracks per artist
  return this.diversify(candidates, { maxPerArtist: 3, totalCount: 25 });
}
```

## Database Schema (5 minutes)

### Core Tables

```sql
-- Audio files with multiple quality versions
CREATE TABLE audio_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  quality VARCHAR(50) NOT NULL, -- '256_aac', 'lossless', 'hi_res_lossless'
  format VARCHAR(20) NOT NULL,   -- 'aac', 'alac', 'flac'
  bitrate INTEGER,
  sample_rate INTEGER,           -- 44100, 96000, 192000
  bit_depth INTEGER,             -- 16, 24
  file_size BIGINT,
  minio_key VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Library sync tracking with monotonic tokens
CREATE SEQUENCE sync_token_seq;

CREATE TABLE library_changes (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  change_type VARCHAR(20) NOT NULL, -- 'add', 'remove', 'update'
  item_type VARCHAR(20) NOT NULL,   -- 'track', 'album', 'artist', 'playlist'
  item_id UUID NOT NULL,
  data JSONB,
  sync_token BIGINT DEFAULT nextval('sync_token_seq'),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_library_changes_sync ON library_changes(user_id, sync_token);

-- Listening history for recommendations
CREATE TABLE listening_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TIMESTAMP DEFAULT NOW(),
  duration_played_ms INTEGER,
  context_type VARCHAR(50), -- 'album', 'playlist', 'radio', 'library'
  context_id UUID,
  completed BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_history_user ON listening_history(user_id, played_at DESC);
CREATE INDEX idx_history_track ON listening_history(track_id);

-- Audio features for recommendation
CREATE TABLE audio_features (
  track_id UUID PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  tempo DECIMAL,
  energy DECIMAL,
  valence DECIMAL,
  danceability DECIMAL,
  acousticness DECIMAL
);
```

### Play Event Deduplication

```sql
-- Dedupe window: same track within 30 seconds = single play
INSERT INTO listening_history (user_id, track_id, played_at, duration_played_ms)
SELECT $1, $2, $3, $4
WHERE NOT EXISTS (
  SELECT 1 FROM listening_history
  WHERE user_id = $1
    AND track_id = $2
    AND played_at > $3 - INTERVAL '30 seconds'
    AND played_at < $3 + INTERVAL '30 seconds'
);

-- Update global play count
UPDATE tracks SET play_count = play_count + 1 WHERE id = $2;
```

## Authentication and Authorization (3 minutes)

### Session-Based Auth with Redis

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
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
};

// RBAC permissions
const rbac = {
  user: ['catalog:read', 'library:own', 'stream:basic'],
  premium_user: ['catalog:read', 'library:own', 'stream:lossless', 'stream:download'],
  curator: ['catalog:read', 'library:own', 'stream:basic', 'playlist:public'],
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
```

### Rate Limiting by Endpoint

```javascript
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');

const streamLimiter = rateLimit({
  store: new RedisStore({ client: redisClient, prefix: 'rl:stream:' }),
  windowMs: 60 * 1000,
  max: 300, // Higher for segment fetching
  keyGenerator: (req) => req.session.userId
});

const searchLimiter = rateLimit({
  store: new RedisStore({ client: redisClient, prefix: 'rl:search:' }),
  windowMs: 60 * 1000,
  max: 30, // Expensive operation
  keyGenerator: (req) => req.session.userId
});
```

## Observability (3 minutes)

### Prometheus Metrics

```javascript
const promClient = require('prom-client');

const streamStartLatency = new promClient.Histogram({
  name: 'apple_music_stream_start_latency_seconds',
  help: 'Time from stream request to signed URL response',
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2]
});

const activeStreams = new promClient.Gauge({
  name: 'apple_music_active_streams',
  help: 'Number of currently active audio streams',
  labelNames: ['quality']
});

const libraryOperations = new promClient.Counter({
  name: 'apple_music_library_operations_total',
  help: 'Library operations by type',
  labelNames: ['operation', 'item_type']
});

const cacheHitRate = new promClient.Counter({
  name: 'apple_music_cache_hits_total',
  help: 'Cache hit/miss by cache type',
  labelNames: ['cache', 'result']
});
```

### Structured Logging

```javascript
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'apple-music-api' }
});

// Stream event logging
logger.info({
  event: 'stream_started',
  userId: user.id,
  trackId: track.id,
  quality: selectedQuality,
  networkType: req.headers['x-network-type']
}, 'User started streaming');
```

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen Approach | Alternative | Rationale |
|----------|-----------------|-------------|-----------|
| Audio Matching | Fingerprinting | Metadata matching | Accurate even with wrong/missing metadata |
| Library Sync | Sync tokens | Full refresh | Bandwidth efficient, handles offline |
| Quality Selection | Server-side | Client-side | Server controls based on subscription |
| Recommendations | SQL-based | ML embeddings | No ML infrastructure needed for demo |
| Session Storage | Redis | JWT | Instant revocation, simpler for local dev |
| Play History | Eventual consistency | Strong | Performance for high-volume writes |

### Why Sync Tokens Over Full Refresh

Sync tokens enable efficient delta updates:
- **Bandwidth**: Only transfer changed items (typically < 1% of library)
- **Offline Support**: Changes queue locally, sync on reconnect
- **Conflict Detection**: Tokens reveal concurrent modifications
- **Scalability**: O(changes) not O(library size) per sync

### Why Redis for Sessions (Not JWT)

- **Instant Revocation**: Session invalidation is immediate
- **Subscription Changes**: Premium downgrade takes effect instantly
- **Device Management**: User can see/revoke active sessions
- **Trade-off**: Requires Redis availability

## Closing Summary (1 minute)

"The Apple Music backend is built around three core systems:

1. **Streaming Service** - Network-aware quality selection with subscription enforcement, signed URL generation for CDN delivery, and gapless playback through prefetching.

2. **Library Sync** - Monotonically increasing sync tokens enable efficient delta updates across devices, with conflict resolution favoring more recent changes while preserving user intent.

3. **Recommendation Engine** - Hybrid approach combining play history analysis (collaborative signals) with audio features (content-based filtering) for personalized mixes and radio stations.

The main scalability lever is CDN offload for audio delivery, with the backend focused on metadata, authorization, and personalization. Strong consistency for library operations ensures users never lose saved content, while eventual consistency for play history prioritizes write throughput."

## Future Enhancements

1. **Audio Fingerprinting** - Chromaprint-based matching for user uploads to catalog
2. **Vector Embeddings** - ML-based track similarity for better recommendations
3. **Real-time Sync** - WebSocket connections for instant library updates
4. **Geo-distributed** - Multi-region PostgreSQL replicas for lower latency
5. **Offline Queue** - Server-side queue for changes made while offline

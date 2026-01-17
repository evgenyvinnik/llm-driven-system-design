# Apple Music - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design Apple Music, a streaming service with 100 million+ songs serving millions of concurrent listeners. The key challenges are audio streaming at scale with adaptive quality, library synchronization across devices, and personalized recommendations that help users discover new music.

The core technical challenges are gapless playback with intelligent buffering, matching user-uploaded music to the catalog using audio fingerprinting, and hybrid recommendation systems that blend collaborative filtering with content analysis."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Stream**: Play songs with adaptive quality based on network
- **Library**: Manage personal library synced across devices
- **Search**: Find songs, albums, artists, playlists
- **Discover**: Personalized recommendations and curated playlists
- **Offline**: Download music for offline playback

### Non-Functional Requirements
- **Latency**: < 2 seconds to start playback
- **Quality**: Support lossless audio (up to 24-bit/192kHz)
- **Scale**: 100M+ songs, millions of concurrent streams
- **Sync**: Library changes reflected within seconds

### Scale Estimates
- 100 million songs in catalog
- 100 million subscribers
- 10 million concurrent streams at peak
- 5 petabytes of audio content

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                     Client Layer                           |
|        iPhone | iPad | Mac | Apple TV | CarPlay | Web     |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                          CDN                               |
|              (Audio files, artwork, cached data)          |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                     API Gateway                            |
+----------------------------------------------------------+
          |                    |                    |
          v                    v                    v
+------------------+  +------------------+  +------------------+
| Streaming Service|  | Library Service  |  | Discovery Service|
|                  |  |                  |  |                  |
| - Audio delivery |  | - User libraries |  | - Recommendations|
| - Quality adapt  |  | - Sync across    |  | - Playlists      |
| - DRM licensing  |  |   devices        |  | - Radio          |
+------------------+  +------------------+  +------------------+
          |                    |                    |
          v                    v                    v
+----------------------------------------------------------+
|                      Data Layer                            |
|    PostgreSQL (catalog) | Redis (sessions, cache)          |
|    S3/MinIO (audio) | Elasticsearch (search)               |
+----------------------------------------------------------+
```

### Core Components
1. **Streaming Service** - Audio file delivery with adaptive bitrate
2. **Library Service** - Personal library management and sync
3. **Discovery Service** - Recommendations, radio, and playlists
4. **Catalog Service** - Song, album, artist metadata
5. **Search Service** - Full-text search with autocomplete

## Deep Dive: Audio Streaming (8 minutes)

### Adaptive Bitrate Selection

Apple Music offers multiple quality levels. The client selects based on network conditions:

```javascript
class StreamingService {
  constructor() {
    this.qualityTiers = [
      { name: 'low', bitrate: 64, codec: 'aac' },
      { name: 'high', bitrate: 256, codec: 'aac' },
      { name: 'lossless', bitrate: 1411, codec: 'alac' },
      { name: 'hi-res', bitrate: 9216, codec: 'alac' }  // 24-bit/192kHz
    ]
  }

  async getStreamUrl(songId, userId, deviceInfo) {
    // Check subscription tier
    const subscription = await this.getSubscription(userId)

    // Determine max quality based on subscription
    let maxQuality = 'high'
    if (subscription.tier === 'lossless') {
      maxQuality = deviceInfo.supportsLossless ? 'hi-res' : 'lossless'
    }

    // Get quality tier based on network
    const quality = this.selectQuality(deviceInfo.networkSpeed, maxQuality)

    // Generate signed URL with DRM token
    const signedUrl = await this.generateSignedUrl(songId, quality, userId)

    return {
      url: signedUrl,
      quality,
      duration: await this.getSongDuration(songId),
      expiresAt: Date.now() + 3600000  // 1 hour
    }
  }

  selectQuality(networkSpeedKbps, maxQuality) {
    // Leave headroom (use only 60% of available bandwidth)
    const availableBandwidth = networkSpeedKbps * 0.6

    // Find highest quality we can sustain
    for (const tier of this.qualityTiers.reverse()) {
      if (tier.bitrate <= availableBandwidth && this.compareTiers(tier.name, maxQuality) <= 0) {
        return tier
      }
    }

    return this.qualityTiers[0]  // Fall back to lowest
  }
}
```

### Gapless Playback

For albums, we want seamless transitions between tracks:

```javascript
class PlaybackService {
  constructor() {
    this.currentBuffer = null
    this.nextBuffer = null
    this.bufferAhead = 30  // seconds
  }

  async play(queue, startIndex) {
    // Start current track
    this.currentBuffer = await this.bufferTrack(queue[startIndex])
    this.audioPlayer.play(this.currentBuffer)

    // Pre-buffer next track
    if (startIndex + 1 < queue.length) {
      this.prefetchNext(queue[startIndex + 1])
    }

    // Handle track end
    this.audioPlayer.on('nearEnd', async (remainingMs) => {
      if (remainingMs < 2000 && this.nextBuffer) {
        // Crossfade to next track
        this.audioPlayer.queueNext(this.nextBuffer)
      }
    })
  }

  async prefetchNext(song) {
    // Start buffering next track in background
    this.nextBuffer = await this.bufferTrack(song)
  }

  async bufferTrack(song) {
    const streamUrl = await this.streamingService.getStreamUrl(
      song.id,
      this.userId,
      this.deviceInfo
    )

    // Buffer first 30 seconds
    const buffer = await this.fetchBuffer(streamUrl.url, 0, this.bufferAhead)

    return {
      url: streamUrl.url,
      initialBuffer: buffer,
      duration: streamUrl.duration
    }
  }
}
```

### Quality Adaptation During Playback

```javascript
class AdaptivePlayer {
  async monitorNetwork() {
    setInterval(async () => {
      const networkSpeed = await this.measureBandwidth()

      const currentQuality = this.currentStream.quality
      const optimalQuality = this.selectQuality(networkSpeed)

      if (optimalQuality !== currentQuality) {
        // Wait for natural segment boundary
        this.pendingQualityChange = optimalQuality
      }
    }, 5000)  // Check every 5 seconds
  }

  async onSegmentBoundary() {
    if (this.pendingQualityChange) {
      // Switch quality at segment boundary for smooth transition
      await this.switchQuality(this.pendingQualityChange)
      this.pendingQualityChange = null
    }
  }

  async measureBandwidth() {
    const startTime = Date.now()
    const testBytes = 10000  // 10KB probe

    await fetch(this.currentStream.url, {
      headers: { Range: `bytes=0-${testBytes}` }
    })

    const elapsed = (Date.now() - startTime) / 1000
    return (testBytes * 8 / 1000) / elapsed  // kbps
  }
}
```

## Deep Dive: Library Sync (7 minutes)

Users expect their library to be identical across all devices. We use sync tokens for efficient delta updates.

### Sync Token Architecture

```javascript
class LibraryService {
  async getLibrary(userId, syncToken = null) {
    if (syncToken) {
      // Return only changes since sync token
      return this.getDelta(userId, syncToken)
    }

    // Full library fetch
    const library = await db.query(`
      SELECT * FROM user_library
      WHERE user_id = $1
      ORDER BY added_at DESC
    `, [userId])

    const newSyncToken = await this.generateSyncToken(userId)

    return {
      items: library.rows,
      syncToken: newSyncToken
    }
  }

  async getDelta(userId, syncToken) {
    // Parse sync token to get last sync timestamp
    const { timestamp } = this.parseSyncToken(syncToken)

    // Get changes since that time
    const changes = await db.query(`
      SELECT * FROM library_changes
      WHERE user_id = $1 AND changed_at > $2
      ORDER BY changed_at ASC
    `, [userId, timestamp])

    const newSyncToken = await this.generateSyncToken(userId)

    return {
      changes: changes.rows,  // { action: 'add' | 'remove', item }
      syncToken: newSyncToken
    }
  }

  async addToLibrary(userId, itemId, itemType) {
    // Add to library
    await db.query(`
      INSERT INTO user_library (user_id, item_id, item_type, added_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, item_id) DO NOTHING
    `, [userId, itemId, itemType])

    // Record change for sync
    await db.query(`
      INSERT INTO library_changes (user_id, action, item_id, item_type, changed_at)
      VALUES ($1, 'add', $2, $3, NOW())
    `, [userId, itemId, itemType])

    // Notify other devices
    await this.pushService.sendToUserDevices(userId, {
      type: 'library_update',
      action: 'add',
      itemId,
      itemType
    })
  }
}
```

### Conflict Resolution

When the same action happens on multiple devices:

```javascript
async resolveConflict(userId, localChange, serverChange) {
  // Last-write-wins for most cases
  if (localChange.timestamp > serverChange.timestamp) {
    return localChange
  }

  // But for adds/removes, add wins (user intent is to keep)
  if (localChange.action === 'add' && serverChange.action === 'remove') {
    return localChange
  }

  return serverChange
}
```

### Audio Fingerprinting (for iCloud Music Library)

When users upload their own music, we match it to the catalog:

```javascript
class FingerprintService {
  async matchUpload(audioFile, userId) {
    // Generate fingerprint (e.g., Chromaprint)
    const fingerprint = await this.generateFingerprint(audioFile)

    // Search fingerprint database
    const matches = await this.searchFingerprints(fingerprint)

    if (matches.length > 0 && matches[0].confidence > 0.8) {
      // High-confidence match - link to catalog
      return {
        matched: true,
        catalogId: matches[0].songId,
        confidence: matches[0].confidence
      }
    }

    // No match - upload as user's own music
    const uploadedId = await this.uploadToCloud(audioFile, userId)
    return {
      matched: false,
      uploadedId
    }
  }

  async generateFingerprint(audioFile) {
    // Extract audio features
    // - Frequency peaks over time
    // - Spectral characteristics
    // Returns compact binary fingerprint
  }
}
```

## Deep Dive: Recommendations (5 minutes)

### Hybrid Recommendation System

```javascript
class RecommendationService {
  async getForYou(userId) {
    const sections = []

    // 1. Based on recent listening (collaborative filtering)
    sections.push({
      title: "Made For You",
      items: await this.collaborativeFiltering(userId)
    })

    // 2. Based on genres you listen to (content-based)
    sections.push({
      title: "Based on Your Library",
      items: await this.contentBased(userId)
    })

    // 3. New releases from followed artists
    sections.push({
      title: "New Releases",
      items: await this.getNewReleases(userId)
    })

    // 4. Similar to recently played
    const recent = await this.getRecentlyPlayed(userId)
    if (recent.length > 0) {
      sections.push({
        title: `Because You Listened to ${recent[0].artistName}`,
        items: await this.similarToArtist(recent[0].artistId)
      })
    }

    return sections
  }

  async collaborativeFiltering(userId) {
    // Find users with similar listening history
    const similarUsers = await db.query(`
      SELECT other_user_id, COUNT(*) as overlap
      FROM play_history p1
      JOIN play_history p2 ON p1.song_id = p2.song_id
      WHERE p1.user_id = $1 AND p2.user_id != $1
      GROUP BY other_user_id
      ORDER BY overlap DESC
      LIMIT 100
    `, [userId])

    // Get songs those users loved that this user hasn't heard
    const recommendations = await db.query(`
      SELECT song_id, COUNT(*) as score
      FROM play_history
      WHERE user_id = ANY($1)
        AND play_count >= 3
        AND song_id NOT IN (
          SELECT song_id FROM play_history WHERE user_id = $2
        )
      GROUP BY song_id
      ORDER BY score DESC
      LIMIT 50
    `, [similarUsers.rows.map(u => u.other_user_id), userId])

    return this.fetchSongDetails(recommendations.rows.map(r => r.song_id))
  }

  async contentBased(userId) {
    // Get user's top genres
    const topGenres = await db.query(`
      SELECT g.name, SUM(ph.play_count) as listens
      FROM play_history ph
      JOIN songs s ON s.id = ph.song_id
      JOIN song_genres sg ON sg.song_id = s.id
      JOIN genres g ON g.id = sg.genre_id
      WHERE ph.user_id = $1
      GROUP BY g.name
      ORDER BY listens DESC
      LIMIT 5
    `, [userId])

    // Find highly rated songs in those genres
    return db.query(`
      SELECT DISTINCT s.*
      FROM songs s
      JOIN song_genres sg ON sg.song_id = s.id
      JOIN genres g ON g.id = sg.genre_id
      WHERE g.name = ANY($1)
        AND s.popularity_score > 70
        AND s.id NOT IN (SELECT song_id FROM play_history WHERE user_id = $2)
      ORDER BY s.popularity_score DESC
      LIMIT 30
    `, [topGenres.rows.map(g => g.name), userId])
  }
}
```

### Personal Radio Station

```javascript
async createPersonalRadio(userId, seedType, seedId) {
  // Get seed characteristics
  let seedFeatures
  if (seedType === 'song') {
    seedFeatures = await this.getAudioFeatures(seedId)
  } else if (seedType === 'artist') {
    seedFeatures = await this.getArtistFeatures(seedId)
  }

  // Find similar songs
  const candidates = await db.query(`
    SELECT s.id, af.*
    FROM songs s
    JOIN audio_features af ON af.song_id = s.id
    ORDER BY (
      ABS(af.tempo - $1) * 0.2 +
      ABS(af.energy - $2) * 0.3 +
      ABS(af.valence - $3) * 0.3 +
      ABS(af.danceability - $4) * 0.2
    ) ASC
    LIMIT 200
  `, [seedFeatures.tempo, seedFeatures.energy, seedFeatures.valence, seedFeatures.danceability])

  // Add variety and avoid recently played
  return this.curate(candidates.rows, userId)
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. Progressive Download vs HLS Streaming

**Chose: Progressive download with buffering**
- Pro: Simpler implementation
- Pro: Works with standard HTTP
- Pro: Client controls buffering
- Con: Less granular quality switching
- Alternative: HLS (better for video, overkill for audio)

### 2. Audio Fingerprinting vs Metadata Matching

**Chose: Audio fingerprinting for uploads**
- Pro: Matches even if metadata is wrong/missing
- Pro: Works across different encodings
- Con: Computationally expensive
- Alternative: Metadata matching (simpler but less accurate)

### 3. Sync Token vs Full Refresh

**Chose: Sync token with delta updates**
- Pro: Bandwidth efficient
- Pro: Fast sync for small changes
- Con: Must handle token expiration
- Alternative: Always full refresh (simpler but wasteful)

### Database Schema

```sql
-- Songs (catalog)
CREATE TABLE songs (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  artist_id UUID REFERENCES artists(id),
  album_id UUID REFERENCES albums(id),
  duration_ms INTEGER,
  isrc VARCHAR(20),
  popularity_score INTEGER,
  release_date DATE
);

-- User Library
CREATE TABLE user_library (
  user_id UUID NOT NULL,
  item_id UUID NOT NULL,
  item_type VARCHAR(20) NOT NULL,  -- song, album, playlist
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, item_id)
);

-- Play History (for recommendations)
CREATE TABLE play_history (
  user_id UUID NOT NULL,
  song_id UUID REFERENCES songs(id),
  play_count INTEGER DEFAULT 0,
  last_played TIMESTAMP,
  PRIMARY KEY (user_id, song_id)
);

-- Audio Features (for radio/discovery)
CREATE TABLE audio_features (
  song_id UUID PRIMARY KEY REFERENCES songs(id),
  tempo DECIMAL,
  energy DECIMAL,
  valence DECIMAL,
  danceability DECIMAL,
  acousticness DECIMAL
);
```

## Closing Summary (1 minute)

"Apple Music is built around three key systems:

1. **Adaptive streaming** - By selecting quality based on network speed and pre-buffering next tracks, we achieve gapless playback while adapting to varying network conditions. The key is buffering ahead and switching quality only at segment boundaries.

2. **Sync token architecture** - Rather than full library syncs, we use tokens that track the last sync point and return only changes. This keeps libraries consistent across devices with minimal data transfer.

3. **Hybrid recommendations** - Combining collaborative filtering (what similar users like) with content-based filtering (audio features, genres) gives us both discovery and personalization.

The main trade-off is between streaming quality and bandwidth. We give users control through subscription tiers, but automatically adapt within their tier based on network conditions."

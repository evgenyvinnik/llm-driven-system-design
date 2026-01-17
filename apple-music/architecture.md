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

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Audio matching | Fingerprinting | Metadata | Accuracy |
| Library sync | Sync tokens | Full sync | Efficiency |
| Streaming | Adaptive + lossless | Fixed bitrate | Quality, bandwidth |
| Recommendations | Hybrid CF + content | Pure CF | Cold start |

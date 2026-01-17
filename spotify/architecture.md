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

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Audio delivery | CDN + signed URLs | Direct streaming | Scale, latency |
| Recommendations | Hybrid CF + CB | Pure collaborative | Cold start |
| Offline DRM | License + encryption | No DRM | Rights protection |
| Analytics | Event streaming | Batch | Real-time royalties |

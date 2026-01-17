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
│  │ - 4K masters  │→ │ - Multi-res   │→ │ - HLS chunks  │       │
│  │ - Audio stems │  │ - Multi-codec │  │ - Manifests   │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Content Storage                              │
│         (Origin servers with all encoded variants)               │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   CDN Edge    │    │   CDN Edge    │    │   CDN Edge    │
│   Americas    │    │    Europe     │    │     Asia      │
│               │    │               │    │               │
│ - Cache video │    │ - Cache video │    │ - Cache video │
│ - DRM license │    │ - DRM license │    │ - DRM license │
└───────────────┘    └───────────────┘    └───────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Client Devices                               │
│    iPhone | iPad | Apple TV | Mac | Samsung TV | Roku           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Video Ingestion Pipeline

**Master File Processing:**
```javascript
class IngestionService {
  async ingestContent(contentId, masterFiles) {
    const { videoFile, audioStems, subtitles, metadata } = masterFiles

    // Validate master file quality
    const videoInfo = await this.analyzeVideo(videoFile)
    if (videoInfo.resolution < 3840 || videoInfo.bitDepth < 10) {
      throw new Error('Master file must be 4K HDR minimum')
    }

    // Create content record
    await db.query(`
      INSERT INTO content
        (id, title, duration, master_resolution, hdr_format, status)
      VALUES ($1, $2, $3, $4, $5, 'ingesting')
    `, [
      contentId,
      metadata.title,
      videoInfo.duration,
      `${videoInfo.width}x${videoInfo.height}`,
      videoInfo.hdrFormat
    ])

    // Queue transcoding jobs for all profiles
    const profiles = this.getEncodingProfiles(videoInfo)
    for (const profile of profiles) {
      await this.queue.publish('transcode', {
        contentId,
        profile,
        sourceFile: videoFile,
        priority: profile.resolution >= 2160 ? 'high' : 'normal'
      })
    }

    // Process audio tracks
    for (const audio of audioStems) {
      await this.queue.publish('audio-encode', {
        contentId,
        sourceFile: audio.file,
        language: audio.language,
        codec: 'aac', // Also Dolby Atmos for supported
        channels: audio.channels
      })
    }

    // Process subtitles
    for (const subtitle of subtitles) {
      await this.queue.publish('subtitle-process', {
        contentId,
        sourceFile: subtitle.file,
        language: subtitle.language,
        type: subtitle.type // 'caption' or 'subtitle'
      })
    }

    return { contentId, profileCount: profiles.length }
  }

  getEncodingProfiles(videoInfo) {
    const profiles = [
      // 4K HDR profiles
      { resolution: 2160, codec: 'hevc', hdr: true, bitrate: 25000 },
      { resolution: 2160, codec: 'hevc', hdr: true, bitrate: 15000 },
      // 4K SDR fallback
      { resolution: 2160, codec: 'hevc', hdr: false, bitrate: 12000 },
      // 1080p profiles
      { resolution: 1080, codec: 'hevc', hdr: false, bitrate: 8000 },
      { resolution: 1080, codec: 'h264', hdr: false, bitrate: 6000 },
      { resolution: 1080, codec: 'h264', hdr: false, bitrate: 4500 },
      // 720p profiles
      { resolution: 720, codec: 'h264', hdr: false, bitrate: 3000 },
      { resolution: 720, codec: 'h264', hdr: false, bitrate: 1500 },
      // Low bandwidth
      { resolution: 480, codec: 'h264', hdr: false, bitrate: 800 },
      { resolution: 360, codec: 'h264', hdr: false, bitrate: 400 }
    ]

    return profiles.filter(p => p.resolution <= videoInfo.height)
  }
}
```

### 2. Transcoding Service

**Distributed Encoding:**
```javascript
class TranscodingService {
  async processJob(job) {
    const { contentId, profile, sourceFile } = job

    const outputPath = this.getOutputPath(contentId, profile)

    // Build FFmpeg command for encoding
    const ffmpegArgs = this.buildEncodingArgs(profile, sourceFile, outputPath)

    // Run encoding (this takes significant time)
    const startTime = Date.now()
    await this.runFFmpeg(ffmpegArgs)
    const encodingTime = Date.now() - startTime

    // Store encoding result
    await db.query(`
      INSERT INTO encoded_variants
        (content_id, resolution, codec, hdr, bitrate, file_path, encoding_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      contentId,
      profile.resolution,
      profile.codec,
      profile.hdr,
      profile.bitrate,
      outputPath,
      encodingTime
    ])

    // Segment into HLS chunks
    await this.segmentVideo(contentId, profile, outputPath)

    // Check if all variants complete
    await this.checkContentComplete(contentId)
  }

  buildEncodingArgs(profile, source, output) {
    const args = [
      '-i', source,
      '-c:v', profile.codec === 'hevc' ? 'libx265' : 'libx264',
      '-preset', 'slow',
      '-b:v', `${profile.bitrate}k`,
      '-maxrate', `${profile.bitrate * 1.5}k`,
      '-bufsize', `${profile.bitrate * 2}k`,
      '-vf', `scale=-2:${profile.resolution}`
    ]

    if (profile.hdr) {
      args.push(
        '-color_primaries', 'bt2020',
        '-color_trc', 'smpte2084',
        '-colorspace', 'bt2020nc'
      )
    }

    args.push('-an', output) // No audio (processed separately)

    return args
  }

  async segmentVideo(contentId, profile, videoFile) {
    const segmentDir = this.getSegmentDir(contentId, profile)

    // Create HLS segments
    await this.runFFmpeg([
      '-i', videoFile,
      '-c', 'copy',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', `${segmentDir}/segment_%04d.ts`,
      `${segmentDir}/playlist.m3u8`
    ])

    // Upload segments to origin
    const segments = await fs.readdir(segmentDir)
    for (const segment of segments) {
      await this.uploadToOrigin(contentId, profile, segment)
    }
  }
}
```

### 3. Adaptive Streaming (HLS)

**Master Manifest Generation:**
```javascript
class ManifestService {
  async generateMasterPlaylist(contentId) {
    // Get all encoded variants
    const variants = await db.query(`
      SELECT * FROM encoded_variants
      WHERE content_id = $1
      ORDER BY resolution DESC, bitrate DESC
    `, [contentId])

    // Get audio tracks
    const audioTracks = await db.query(`
      SELECT * FROM audio_tracks
      WHERE content_id = $1
    `, [contentId])

    // Get subtitles
    const subtitles = await db.query(`
      SELECT * FROM subtitles
      WHERE content_id = $1
    `, [contentId])

    let manifest = '#EXTM3U\n'
    manifest += '#EXT-X-VERSION:6\n'
    manifest += '#EXT-X-INDEPENDENT-SEGMENTS\n\n'

    // Add audio groups
    for (const audio of audioTracks.rows) {
      manifest += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",`
      manifest += `LANGUAGE="${audio.language}",NAME="${audio.name}",`
      manifest += `URI="${this.getAudioPlaylistUrl(contentId, audio)}"\n`
    }

    // Add subtitle groups
    for (const sub of subtitles.rows) {
      manifest += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",`
      manifest += `LANGUAGE="${sub.language}",NAME="${sub.name}",`
      manifest += `URI="${this.getSubtitlePlaylistUrl(contentId, sub)}"\n`
    }

    manifest += '\n'

    // Add video variants
    for (const variant of variants.rows) {
      const bandwidth = variant.bitrate * 1000
      const resolution = `${this.getWidth(variant.resolution)}x${variant.resolution}`
      const codecs = this.getCodecs(variant)

      manifest += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},`
      manifest += `RESOLUTION=${resolution},CODECS="${codecs}",`
      manifest += `AUDIO="audio",SUBTITLES="subs"\n`
      manifest += `${this.getVariantPlaylistUrl(contentId, variant)}\n`
    }

    return manifest
  }

  getCodecs(variant) {
    if (variant.codec === 'hevc' && variant.hdr) {
      return 'hvc1.2.4.L150.B0,mp4a.40.2'
    } else if (variant.codec === 'hevc') {
      return 'hvc1.1.6.L150.90,mp4a.40.2'
    } else {
      return 'avc1.640029,mp4a.40.2'
    }
  }
}
```

### 4. Content Delivery Network

**CDN Edge Configuration:**
```javascript
class CDNService {
  async getPlaybackUrl(contentId, userId, deviceInfo) {
    // Check content availability in user's region
    const availability = await this.checkAvailability(contentId, userId)
    if (!availability.available) {
      throw new Error(`Content not available in ${availability.region}`)
    }

    // Get nearest edge server
    const edge = await this.selectEdge(userId, deviceInfo)

    // Generate signed URL with DRM token
    const playbackToken = await this.generatePlaybackToken({
      contentId,
      userId,
      deviceId: deviceInfo.deviceId,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      maxBitrate: this.getMaxBitrate(deviceInfo)
    })

    // Return CDN URL with token
    return {
      manifestUrl: `${edge.baseUrl}/content/${contentId}/master.m3u8`,
      playbackToken,
      licenseUrl: `${edge.baseUrl}/drm/license`,
      certificateUrl: `${edge.baseUrl}/drm/certificate`
    }
  }

  async selectEdge(userId, deviceInfo) {
    // Get user's approximate location
    const location = await this.getLocation(userId)

    // Find nearest healthy edge with capacity
    const edges = await redis.zrangebyscore(
      `edges:${location.region}`,
      0, 80, // Load < 80%
      'LIMIT', 0, 5
    )

    if (edges.length === 0) {
      // Fall back to origin
      return { baseUrl: this.originUrl }
    }

    // Select based on latency history
    const best = await this.selectByLatency(edges, userId)
    return { baseUrl: `https://${best}.cdn.example.com` }
  }

  getMaxBitrate(deviceInfo) {
    // Limit bitrate based on device capabilities
    const capabilities = {
      'AppleTV4K': 25000,
      'iPad': 15000,
      'iPhone': 12000,
      'Mac': 25000,
      'Web': 8000
    }

    return capabilities[deviceInfo.deviceType] || 6000
  }
}
```

### 5. DRM Protection (FairPlay)

**License Server:**
```javascript
class DRMService {
  async getLicense(request) {
    const { playbackToken, spcMessage, deviceInfo } = request

    // Verify playback token
    const tokenData = await this.verifyToken(playbackToken)
    if (!tokenData) {
      throw new Error('Invalid playback token')
    }

    // Verify device is authorized
    const deviceAuthorized = await this.verifyDevice(
      tokenData.userId,
      deviceInfo.deviceId
    )
    if (!deviceAuthorized) {
      throw new Error('Device not authorized')
    }

    // Decrypt SPC (Server Playback Context)
    const spc = await this.decryptSPC(spcMessage)

    // Generate CKC (Content Key Context)
    const contentKey = await this.getContentKey(tokenData.contentId)
    const ckc = await this.generateCKC(spc, contentKey, {
      rental: false,
      offlineAllowed: true,
      hdcpRequired: true
    })

    // Log license issuance
    await db.query(`
      INSERT INTO license_grants
        (user_id, content_id, device_id, granted_at, expires_at)
      VALUES ($1, $2, $3, NOW(), $4)
    `, [
      tokenData.userId,
      tokenData.contentId,
      deviceInfo.deviceId,
      new Date(tokenData.expiresAt)
    ])

    return { ckc }
  }

  async generateCKC(spc, contentKey, options) {
    // FairPlay key server generates CKC
    // This contains the decryption key encrypted for the specific device
    return await this.fairplayServer.generateCKC({
      spc,
      contentKey,
      rentalDuration: options.rental ? 48 * 3600 : null,
      playbackDuration: 24 * 3600,
      offlineLease: options.offlineAllowed,
      hdcpEnforcement: options.hdcpRequired ? 2 : 0
    })
  }
}
```

### 6. User Experience

**Playback State Sync:**
```javascript
class PlaybackService {
  async updateProgress(userId, contentId, progress) {
    const { position, duration, completed } = progress

    // Update watch progress
    await db.query(`
      INSERT INTO watch_progress
        (user_id, content_id, position, duration, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, content_id)
      DO UPDATE SET
        position = $3,
        duration = $4,
        updated_at = NOW()
    `, [userId, contentId, position, duration])

    // Mark as completed if > 90%
    if (position / duration > 0.9 && !completed) {
      await this.markCompleted(userId, contentId)
    }

    // Sync to other devices (via iCloud or our sync service)
    await this.syncToDevices(userId, {
      type: 'progress_update',
      contentId,
      position,
      timestamp: Date.now()
    })
  }

  async getContinueWatching(userId, limit = 10) {
    const results = await db.query(`
      SELECT
        c.id,
        c.title,
        c.thumbnail_url,
        c.duration,
        wp.position,
        (wp.position::float / c.duration) as progress_pct
      FROM watch_progress wp
      JOIN content c ON c.id = wp.content_id
      WHERE wp.user_id = $1
        AND wp.position > 60  -- Started watching (> 1 min)
        AND (wp.position::float / c.duration) < 0.9  -- Not finished
      ORDER BY wp.updated_at DESC
      LIMIT $2
    `, [userId, limit])

    return results.rows.map(row => ({
      ...row,
      progressPercent: Math.round(row.progress_pct * 100),
      remainingMinutes: Math.round((row.duration - row.position) / 60)
    }))
  }

  async syncToDevices(userId, event) {
    // Get user's active devices
    const devices = await db.query(`
      SELECT device_token FROM user_devices
      WHERE user_id = $1 AND active = true
    `, [userId])

    // Push sync event
    for (const device of devices.rows) {
      await this.pushService.send(device.device_token, {
        type: 'sync',
        payload: event
      })
    }
  }
}
```

### 7. Offline Downloads

**Download Manager:**
```javascript
class DownloadService {
  async initiateDownload(userId, contentId, deviceId, quality) {
    // Check download limits
    const downloads = await this.getActiveDownloads(userId)
    if (downloads.length >= 25) {
      throw new Error('Download limit reached')
    }

    // Get variant for requested quality
    const variant = await this.selectVariant(contentId, quality)

    // Generate download license
    const license = await this.drmService.generateOfflineLicense(
      userId,
      contentId,
      deviceId,
      { expiresIn: 30 * 24 * 60 * 60 * 1000 } // 30 days
    )

    // Create download record
    await db.query(`
      INSERT INTO downloads
        (id, user_id, content_id, device_id, quality, status, license_expires)
      VALUES ($1, $2, $3, $4, $5, 'pending', $6)
    `, [
      uuid(),
      userId,
      contentId,
      deviceId,
      quality,
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    ])

    // Return download manifest
    return {
      manifestUrl: await this.getDownloadManifest(contentId, variant),
      license,
      estimatedSize: await this.estimateSize(contentId, variant),
      expiresAt: license.expiresAt
    }
  }

  async getDownloadManifest(contentId, variant) {
    // Generate manifest with all segments for offline
    const segments = await db.query(`
      SELECT segment_url, segment_number, duration
      FROM video_segments
      WHERE content_id = $1 AND variant_id = $2
      ORDER BY segment_number
    `, [contentId, variant.id])

    return {
      videoSegments: segments.rows,
      audioUrl: await this.getAudioUrl(contentId),
      subtitles: await this.getSubtitleUrls(contentId),
      totalDuration: variant.duration,
      totalSize: variant.file_size
    }
  }

  async checkExpiredDownloads(userId, deviceId) {
    // Find expired downloads
    const expired = await db.query(`
      SELECT id, content_id FROM downloads
      WHERE user_id = $1 AND device_id = $2
        AND license_expires < NOW()
    `, [userId, deviceId])

    return {
      expiredIds: expired.rows.map(r => r.id),
      message: `${expired.rows.length} downloads have expired`
    }
  }
}
```

---

## Database Schema

```sql
-- Content catalog
CREATE TABLE content (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  duration INTEGER NOT NULL, -- seconds
  release_date DATE,
  content_type VARCHAR(20), -- movie, series, episode
  series_id UUID REFERENCES content(id),
  season_number INTEGER,
  episode_number INTEGER,
  rating VARCHAR(10),
  genres TEXT[],
  master_resolution VARCHAR(20),
  hdr_format VARCHAR(20),
  status VARCHAR(20) DEFAULT 'processing',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_content_type ON content(content_type);
CREATE INDEX idx_content_series ON content(series_id, season_number, episode_number);

-- Encoded variants
CREATE TABLE encoded_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID REFERENCES content(id),
  resolution INTEGER NOT NULL,
  codec VARCHAR(20) NOT NULL,
  hdr BOOLEAN DEFAULT false,
  bitrate INTEGER NOT NULL,
  file_path VARCHAR(500),
  file_size BIGINT,
  encoding_time INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_variants_content ON encoded_variants(content_id);

-- Video segments (HLS)
CREATE TABLE video_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID REFERENCES content(id),
  variant_id UUID REFERENCES encoded_variants(id),
  segment_number INTEGER NOT NULL,
  duration DECIMAL NOT NULL,
  segment_url VARCHAR(500),
  byte_size INTEGER
);

CREATE INDEX idx_segments_content ON video_segments(content_id, variant_id);

-- Watch progress
CREATE TABLE watch_progress (
  user_id UUID NOT NULL,
  content_id UUID REFERENCES content(id),
  position INTEGER NOT NULL, -- seconds
  duration INTEGER NOT NULL,
  completed BOOLEAN DEFAULT false,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, content_id)
);

CREATE INDEX idx_progress_user ON watch_progress(user_id, updated_at DESC);

-- Downloads
CREATE TABLE downloads (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  content_id UUID REFERENCES content(id),
  device_id VARCHAR(100) NOT NULL,
  quality VARCHAR(20),
  status VARCHAR(20) DEFAULT 'pending',
  license_expires TIMESTAMP,
  downloaded_at TIMESTAMP,
  last_played TIMESTAMP
);

CREATE INDEX idx_downloads_user ON downloads(user_id);
CREATE INDEX idx_downloads_expires ON downloads(license_expires);

-- User profiles
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  is_kids BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_profiles_user ON user_profiles(user_id);
```

---

## Key Design Decisions

### 1. HLS over DASH

**Decision**: Use HLS (HTTP Live Streaming) as primary format

**Rationale**:
- Native support on Apple devices
- FairPlay DRM integration
- Wide CDN support
- Simpler implementation

### 2. Per-Segment Encryption

**Decision**: Encrypt each segment with unique key

**Rationale**:
- Enables secure seeking
- Better security than single key
- Required for offline playback

### 3. Device-Specific Licenses

**Decision**: Issue DRM licenses per device

**Rationale**:
- Enables device limits
- Supports offline downloads
- Can revoke individual devices

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Streaming format | HLS | DASH | Apple ecosystem |
| DRM | FairPlay | Widevine | Native integration |
| Encoding | HEVC + H.264 | AV1 | Device support |
| CDN strategy | Multi-CDN | Single CDN | Reliability |
| Offline | License-based | Time-based | Flexibility |

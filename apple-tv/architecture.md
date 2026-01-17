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

## Consistency and Idempotency Semantics

### Consistency Model by Operation

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Watch progress updates | Eventual (last-write-wins) | User only has one active playback session; conflicts rare |
| Download initiation | Strong (serializable) | Must enforce download limits accurately |
| Content ingestion | Strong (per-content) | Encoding jobs depend on consistent state |
| License grants | Strong | Security-critical; must not double-issue |
| Watchlist add/remove | Eventual | Low conflict risk; UI can handle stale reads |
| Profile creation | Strong | Must enforce max profiles per account |

### Idempotency Keys

All mutating API endpoints accept an `Idempotency-Key` header to handle client retries safely.

```javascript
// Middleware for idempotent writes
async function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['idempotency-key']
  if (!idempotencyKey) {
    return next() // Non-idempotent request, proceed normally
  }

  const cacheKey = `idempotency:${req.userId}:${idempotencyKey}`

  // Check if we already processed this request
  const cached = await redis.get(cacheKey)
  if (cached) {
    const response = JSON.parse(cached)
    return res.status(response.status).json(response.body)
  }

  // Store pending state to detect concurrent duplicates
  const lockKey = `${cacheKey}:lock`
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 30)
  if (!acquired) {
    return res.status(409).json({ error: 'Request already in progress' })
  }

  // Wrap response to capture and cache result
  const originalJson = res.json.bind(res)
  res.json = async (body) => {
    await redis.setex(cacheKey, 86400, JSON.stringify({
      status: res.statusCode,
      body
    }))
    await redis.del(lockKey)
    return originalJson(body)
  }

  next()
}
```

### Key Idempotency Patterns

**Download Initiation:**
```javascript
async initiateDownload(userId, contentId, deviceId, quality, idempotencyKey) {
  // Use composite key: user + content + device + quality
  const downloadKey = `download:${userId}:${contentId}:${deviceId}:${quality}`

  // Check for existing pending/active download
  const existing = await db.query(`
    SELECT id, status, license_expires FROM downloads
    WHERE user_id = $1 AND content_id = $2 AND device_id = $3
    AND status IN ('pending', 'downloading', 'complete')
  `, [userId, contentId, deviceId])

  if (existing.rows.length > 0) {
    // Return existing download (idempotent)
    return existing.rows[0]
  }

  // Create new download within transaction
  return await db.transaction(async (tx) => {
    const count = await tx.query(`
      SELECT COUNT(*) FROM downloads WHERE user_id = $1 AND status = 'complete'
    `, [userId])

    if (count.rows[0].count >= 25) {
      throw new Error('Download limit reached')
    }

    return await tx.query(`
      INSERT INTO downloads (id, user_id, content_id, device_id, quality, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *
    `, [uuid(), userId, contentId, deviceId, quality])
  })
}
```

**Watch Progress (Last-Write-Wins):**
```javascript
// Client includes local timestamp; server uses it for conflict resolution
async updateProgress(userId, contentId, position, clientTimestamp) {
  await db.query(`
    INSERT INTO watch_progress (user_id, content_id, position, client_timestamp, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id, content_id)
    DO UPDATE SET
      position = CASE
        WHEN watch_progress.client_timestamp < $4 THEN $3
        ELSE watch_progress.position
      END,
      client_timestamp = GREATEST(watch_progress.client_timestamp, $4),
      updated_at = NOW()
  `, [userId, contentId, position, clientTimestamp])
}
```

### Replay Handling

- **Transcoding jobs**: Job ID derived from content ID + profile hash; worker checks completion before starting
- **License grants**: License ID is deterministic (hash of user + content + device + timestamp window); duplicate requests return same license
- **Notification delivery**: Each notification has unique ID; client deduplicates on receipt

---

## Observability

### Metrics (Prometheus)

**Key Application Metrics:**
```javascript
// metrics.js - Prometheus metrics for local development
const promClient = require('prom-client')

// Request latency histogram
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
})

// Playback start latency (time to first frame)
const playbackStartLatency = new promClient.Histogram({
  name: 'playback_start_latency_seconds',
  help: 'Time from play request to first frame rendered',
  labelNames: ['device_type', 'quality'],
  buckets: [0.5, 1, 1.5, 2, 2.5, 3, 5, 10]
})

// Active streams gauge
const activeStreams = new promClient.Gauge({
  name: 'active_streams_total',
  help: 'Number of currently active video streams',
  labelNames: ['quality', 'device_type']
})

// Transcoding job duration
const transcodingDuration = new promClient.Histogram({
  name: 'transcoding_job_duration_seconds',
  help: 'Duration of transcoding jobs',
  labelNames: ['resolution', 'codec'],
  buckets: [60, 300, 600, 1800, 3600, 7200]
})

// DRM license issuance
const licenseRequests = new promClient.Counter({
  name: 'drm_license_requests_total',
  help: 'Total DRM license requests',
  labelNames: ['status', 'device_type']
})

// CDN cache hit ratio
const cdnCacheHits = new promClient.Counter({
  name: 'cdn_cache_hits_total',
  help: 'CDN cache hit count',
  labelNames: ['edge_location', 'content_type']
})

const cdnCacheMisses = new promClient.Counter({
  name: 'cdn_cache_misses_total',
  help: 'CDN cache miss count',
  labelNames: ['edge_location', 'content_type']
})
```

### SLI Definitions and Alert Thresholds

| SLI | Target | Warning Threshold | Critical Threshold |
|-----|--------|-------------------|-------------------|
| Playback start latency (p95) | < 2s | > 2.5s | > 4s |
| API availability | 99.9% | < 99.5% | < 99% |
| Streaming availability | 99.99% | < 99.95% | < 99.9% |
| Manifest generation latency (p95) | < 100ms | > 150ms | > 300ms |
| DRM license latency (p95) | < 200ms | > 300ms | > 500ms |
| CDN cache hit rate | > 95% | < 90% | < 80% |
| Transcoding success rate | > 99% | < 98% | < 95% |

**Alerting Rules (Prometheus format):**
```yaml
# alerts.yml
groups:
  - name: apple-tv-streaming
    rules:
      - alert: HighPlaybackLatency
        expr: histogram_quantile(0.95, rate(playback_start_latency_seconds_bucket[5m])) > 2.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Playback start latency exceeds 2.5s (p95)"

      - alert: CriticalPlaybackLatency
        expr: histogram_quantile(0.95, rate(playback_start_latency_seconds_bucket[5m])) > 4
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Playback start latency exceeds 4s (p95)"

      - alert: LowCacheHitRate
        expr: rate(cdn_cache_hits_total[10m]) / (rate(cdn_cache_hits_total[10m]) + rate(cdn_cache_misses_total[10m])) < 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "CDN cache hit rate below 90%"

      - alert: TranscodingFailureSpike
        expr: rate(transcoding_job_failures_total[5m]) / rate(transcoding_job_total[5m]) > 0.02
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Transcoding failure rate exceeds 2%"

      - alert: DRMLicenseErrors
        expr: rate(drm_license_requests_total{status="error"}[5m]) > 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High rate of DRM license failures"
```

### Structured Logging

```javascript
// Structured logging with correlation IDs
const logger = require('pino')({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  }
})

// Request logging middleware
function requestLogger(req, res, next) {
  const requestId = req.headers['x-request-id'] || uuid()
  req.log = logger.child({
    requestId,
    userId: req.userId,
    method: req.method,
    path: req.path
  })

  const start = Date.now()
  res.on('finish', () => {
    req.log.info({
      statusCode: res.statusCode,
      duration: Date.now() - start,
      contentLength: res.get('content-length')
    }, 'request completed')
  })

  next()
}

// Example: Playback event logging
async function logPlaybackEvent(event) {
  logger.info({
    event: 'playback',
    action: event.action, // 'start', 'pause', 'seek', 'quality_change', 'error'
    userId: event.userId,
    contentId: event.contentId,
    deviceId: event.deviceId,
    position: event.position,
    quality: event.quality,
    bufferHealth: event.bufferHealth,
    bandwidth: event.bandwidth
  }, `playback:${event.action}`)
}
```

### Distributed Tracing

```javascript
// OpenTelemetry setup for local development
const { NodeTracerProvider } = require('@opentelemetry/node')
const { SimpleSpanProcessor } = require('@opentelemetry/tracing')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')

const provider = new NodeTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(
  new JaegerExporter({
    serviceName: 'apple-tv-api',
    endpoint: 'http://localhost:14268/api/traces'
  })
))
provider.register()

const tracer = provider.getTracer('apple-tv')

// Example: Trace playback request flow
async function handlePlaybackRequest(req, res) {
  const span = tracer.startSpan('playback.request')
  span.setAttribute('user.id', req.userId)
  span.setAttribute('content.id', req.params.contentId)

  try {
    // Check subscription
    const subSpan = tracer.startSpan('subscription.check', { parent: span })
    const subscription = await checkSubscription(req.userId)
    subSpan.end()

    // Generate manifest
    const manifestSpan = tracer.startSpan('manifest.generate', { parent: span })
    const manifest = await generateManifest(req.params.contentId)
    manifestSpan.setAttribute('variant.count', manifest.variants.length)
    manifestSpan.end()

    // Issue DRM license
    const drmSpan = tracer.startSpan('drm.license', { parent: span })
    const license = await issueLicense(req.userId, req.params.contentId)
    drmSpan.end()

    span.setStatus({ code: 'OK' })
    return { manifest, license }
  } catch (error) {
    span.recordException(error)
    span.setStatus({ code: 'ERROR', message: error.message })
    throw error
  } finally {
    span.end()
  }
}
```

### Audit Logging

```javascript
// Security-relevant events logged separately for compliance
const auditLogger = require('pino')({
  level: 'info',
  transport: {
    target: 'pino/file',
    options: { destination: './logs/audit.log' }
  }
})

// Audit events
const AuditEvents = {
  LICENSE_ISSUED: 'drm.license.issued',
  LICENSE_REVOKED: 'drm.license.revoked',
  DOWNLOAD_STARTED: 'download.started',
  DOWNLOAD_DELETED: 'download.deleted',
  DEVICE_REGISTERED: 'device.registered',
  DEVICE_REMOVED: 'device.removed',
  PROFILE_CREATED: 'profile.created',
  PROFILE_DELETED: 'profile.deleted',
  SUBSCRIPTION_CHANGED: 'subscription.changed',
  CONTENT_ACCESSED: 'content.accessed'
}

async function auditLog(event, data) {
  auditLogger.info({
    timestamp: new Date().toISOString(),
    event,
    userId: data.userId,
    deviceId: data.deviceId,
    contentId: data.contentId,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
    details: data.details
  })

  // Also store in database for querying
  await db.query(`
    INSERT INTO audit_log (event, user_id, device_id, content_id, ip_address, details, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `, [event, data.userId, data.deviceId, data.contentId, data.ipAddress, JSON.stringify(data.details)])
}

// Example usage
await auditLog(AuditEvents.LICENSE_ISSUED, {
  userId: user.id,
  deviceId: device.id,
  contentId: content.id,
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
  details: { licenseType: 'streaming', expiresAt: license.expiresAt }
})
```

### Local Development Dashboard

For local development, use a simple Grafana dashboard with docker-compose:

```yaml
# docker-compose.observability.yml
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"  # UI
      - "14268:14268"  # Collector
```

---

## Failure Handling

### Retry Strategy with Backoff

```javascript
// Configurable retry with exponential backoff
class RetryHandler {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3
    this.baseDelay = options.baseDelay || 100 // ms
    this.maxDelay = options.maxDelay || 10000 // ms
    this.retryableErrors = options.retryableErrors || [
      'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'
    ]
  }

  async execute(fn, context = {}) {
    let lastError

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error

        if (!this.isRetryable(error) || attempt === this.maxRetries) {
          throw error
        }

        const delay = Math.min(
          this.baseDelay * Math.pow(2, attempt) + Math.random() * 100,
          this.maxDelay
        )

        logger.warn({
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
          delay,
          error: error.message,
          ...context
        }, 'Retrying operation')

        await this.sleep(delay)
      }
    }

    throw lastError
  }

  isRetryable(error) {
    if (error.statusCode >= 500) return true
    if (error.statusCode === 429) return true // Rate limited
    if (this.retryableErrors.includes(error.code)) return true
    return false
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Usage with idempotency key
const retry = new RetryHandler({ maxRetries: 3 })

async function fetchWithRetry(url, options) {
  return retry.execute(
    () => fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Idempotency-Key': options.idempotencyKey || uuid()
      }
    }),
    { operation: 'fetch', url }
  )
}
```

### Circuit Breaker Pattern

```javascript
// Circuit breaker for external service calls (CDN, DRM server)
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeout = options.resetTimeout || 30000 // 30 seconds
    this.halfOpenRequests = options.halfOpenRequests || 3

    this.state = 'CLOSED'
    this.failures = 0
    this.successes = 0
    this.lastFailureTime = null
    this.halfOpenAttempts = 0
  }

  async execute(fn, fallback) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN'
        this.halfOpenAttempts = 0
      } else {
        logger.warn({ state: this.state }, 'Circuit breaker open, using fallback')
        return fallback()
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      if (fallback) {
        return fallback()
      }
      throw error
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++
      if (this.halfOpenAttempts >= this.halfOpenRequests) {
        this.state = 'CLOSED'
        this.failures = 0
        logger.info('Circuit breaker closed')
      }
    }
    this.failures = 0
  }

  onFailure() {
    this.failures++
    this.lastFailureTime = Date.now()

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN'
      logger.warn('Circuit breaker opened from half-open state')
    } else if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      logger.warn({ failures: this.failures }, 'Circuit breaker opened')
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime
    }
  }
}

// Circuit breakers for each external dependency
const circuitBreakers = {
  drm: new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 }),
  cdn: new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 }),
  transcoding: new CircuitBreaker({ failureThreshold: 10, resetTimeout: 120000 })
}

// Example: DRM license with fallback
async function getLicense(userId, contentId, deviceId) {
  return circuitBreakers.drm.execute(
    async () => {
      return await drmService.issueLicense(userId, contentId, deviceId)
    },
    async () => {
      // Fallback: Return cached license if available
      const cached = await redis.get(`license:${userId}:${contentId}:${deviceId}`)
      if (cached) {
        logger.info('Using cached DRM license (circuit open)')
        return JSON.parse(cached)
      }
      throw new Error('DRM service unavailable and no cached license')
    }
  )
}
```

### Graceful Degradation

```javascript
// Degraded service modes when dependencies fail
class DegradedModeHandler {
  constructor() {
    this.degradedFeatures = new Set()
  }

  enableDegradedMode(feature) {
    this.degradedFeatures.add(feature)
    logger.warn({ feature }, 'Enabling degraded mode')
  }

  disableDegradedMode(feature) {
    this.degradedFeatures.delete(feature)
    logger.info({ feature }, 'Disabling degraded mode')
  }

  isDegraed(feature) {
    return this.degradedFeatures.has(feature)
  }
}

const degradedMode = new DegradedModeHandler()

// Example: Recommendations degrade gracefully
async function getRecommendations(userId) {
  if (degradedMode.isDegraded('recommendations')) {
    // Return static popular content instead
    return await getPopularContent()
  }

  try {
    return await recommendationService.getPersonalized(userId)
  } catch (error) {
    logger.error({ error, userId }, 'Recommendation service failed')
    degradedMode.enableDegradedMode('recommendations')
    setTimeout(() => degradedMode.disableDegradedMode('recommendations'), 60000)
    return await getPopularContent()
  }
}

// Example: Quality degradation under load
async function selectPlaybackQuality(userId, contentId, deviceInfo, networkConditions) {
  const maxQuality = cdnService.getMaxBitrate(deviceInfo)

  // Check system load
  const systemLoad = await getSystemLoad()
  if (systemLoad > 0.9) {
    // Reduce max quality to shed load
    return Math.min(maxQuality, 4500) // Cap at 1080p/4.5Mbps
  }

  // Check CDN health
  const cdnHealth = circuitBreakers.cdn.getState()
  if (cdnHealth.state !== 'CLOSED') {
    return Math.min(maxQuality, 3000) // Cap at 720p/3Mbps
  }

  return maxQuality
}
```

### Backup and Restore (Local Development)

```bash
#!/bin/bash
# scripts/backup.sh - Backup PostgreSQL and essential data

BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# PostgreSQL dump
pg_dump -h localhost -U postgres -d appletv \
  --format=custom \
  --file="$BACKUP_DIR/appletv.dump"

# Export critical tables as CSV for quick inspection
psql -h localhost -U postgres -d appletv -c \
  "COPY content TO STDOUT WITH CSV HEADER" > "$BACKUP_DIR/content.csv"

psql -h localhost -U postgres -d appletv -c \
  "COPY user_profiles TO STDOUT WITH CSV HEADER" > "$BACKUP_DIR/profiles.csv"

# Redis snapshot (if using persistence)
if [ -f /var/lib/redis/dump.rdb ]; then
  cp /var/lib/redis/dump.rdb "$BACKUP_DIR/redis.rdb"
fi

# MinIO bucket list (content storage)
mc ls local/videos --recursive > "$BACKUP_DIR/minio-inventory.txt"

echo "Backup completed: $BACKUP_DIR"
```

```bash
#!/bin/bash
# scripts/restore.sh - Restore from backup

BACKUP_DIR=$1

if [ -z "$BACKUP_DIR" ]; then
  echo "Usage: ./restore.sh <backup_directory>"
  exit 1
fi

# Restore PostgreSQL
pg_restore -h localhost -U postgres -d appletv \
  --clean --if-exists \
  "$BACKUP_DIR/appletv.dump"

# Restore Redis
if [ -f "$BACKUP_DIR/redis.rdb" ]; then
  redis-cli SHUTDOWN NOSAVE
  cp "$BACKUP_DIR/redis.rdb" /var/lib/redis/dump.rdb
  redis-server &
fi

echo "Restore completed from: $BACKUP_DIR"
```

### Backup Verification Testing

```javascript
// tests/backup-restore.test.js
const { exec } = require('child_process')
const db = require('../src/shared/db')

describe('Backup and Restore', () => {
  let originalContentCount
  let backupDir

  beforeAll(async () => {
    // Record current state
    const result = await db.query('SELECT COUNT(*) FROM content')
    originalContentCount = parseInt(result.rows[0].count)

    // Create backup
    const { stdout } = await execPromise('./scripts/backup.sh')
    backupDir = stdout.trim().split(': ')[1]
  })

  test('backup creates valid dump file', async () => {
    const { stdout } = await execPromise(`pg_restore --list ${backupDir}/appletv.dump`)
    expect(stdout).toContain('content')
    expect(stdout).toContain('watch_progress')
  })

  test('restore recovers data correctly', async () => {
    // Insert test data
    await db.query(`INSERT INTO content (id, title, duration) VALUES ($1, $2, $3)`,
      ['test-backup-id', 'Backup Test', 3600])

    // Restore from backup
    await execPromise(`./scripts/restore.sh ${backupDir}`)

    // Verify test data is gone (restored to backup state)
    const result = await db.query('SELECT * FROM content WHERE id = $1', ['test-backup-id'])
    expect(result.rows.length).toBe(0)

    // Verify original count restored
    const countResult = await db.query('SELECT COUNT(*) FROM content')
    expect(parseInt(countResult.rows[0].count)).toBe(originalContentCount)
  })

  afterAll(async () => {
    // Cleanup backup
    await execPromise(`rm -rf ${backupDir}`)
  })
})

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}
```

### Multi-Region Considerations (Learning Notes)

For local development, we simulate multi-region behavior. In production:

1. **Active-Active Regions**: Each region handles reads/writes independently
   - Watch progress uses last-write-wins with vector clocks
   - Content catalog replicated asynchronously (eventual consistency acceptable)
   - DRM licenses region-local (user connects to nearest region)

2. **Failover Strategy**:
   - DNS-based failover with health checks (30s TTL)
   - CDN automatically routes to healthy origins
   - Session affinity via regional cookie

3. **Data Replication**:
   - PostgreSQL: Streaming replication to read replicas, async to other regions
   - Redis: Redis Cluster with cross-region replication disabled (region-local cache)
   - MinIO: Cross-region replication for video segments (eventual consistency)

**Local Simulation:**
```yaml
# docker-compose.multiregion.yml - Simulate two regions
services:
  # Region A
  api-region-a:
    build: .
    ports:
      - "3001:3000"
    environment:
      - REGION=us-west
      - DATABASE_URL=postgresql://postgres:pass@db-a:5432/appletv

  db-a:
    image: postgres:16
    environment:
      - POSTGRES_DB=appletv
      - POSTGRES_PASSWORD=pass

  # Region B
  api-region-b:
    build: .
    ports:
      - "3002:3000"
    environment:
      - REGION=us-east
      - DATABASE_URL=postgresql://postgres:pass@db-b:5432/appletv

  db-b:
    image: postgres:16
    environment:
      - POSTGRES_DB=appletv
      - POSTGRES_PASSWORD=pass

  # Load balancer simulating geo-routing
  nginx:
    image: nginx:alpine
    ports:
      - "3000:80"
    volumes:
      - ./nginx-geo.conf:/etc/nginx/nginx.conf
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Streaming format | HLS | DASH | Apple ecosystem |
| DRM | FairPlay | Widevine | Native integration |
| Encoding | HEVC + H.264 | AV1 | Device support |
| CDN strategy | Multi-CDN | Single CDN | Reliability |
| Offline | License-based | Time-based | Flexibility |
| Watch progress consistency | Eventual (LWW) | Strong | Low conflict, better latency |
| Retries | Exponential backoff | Fixed interval | Avoids thundering herd |
| Circuit breaker | Per-service | Global | Isolates failures |

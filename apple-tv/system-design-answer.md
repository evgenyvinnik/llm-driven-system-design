# Apple TV+ - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design Apple TV+, a premium video streaming service delivering high-quality content globally. The key challenges are video transcoding at scale, adaptive bitrate streaming for varying network conditions, global content delivery, and DRM protection to prevent piracy.

The core technical challenges are building an efficient transcoding pipeline that creates multiple quality variants, HLS manifest generation for adaptive streaming, and FairPlay DRM integration that protects content while enabling offline downloads."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Stream**: Watch video with adaptive quality based on network
- **Browse**: Discover content through recommendations and search
- **Download**: Save content for offline viewing
- **Continue**: Resume playback across devices
- **Profiles**: Family sharing with individual profiles

### Non-Functional Requirements
- **Quality**: Support 4K HDR with Dolby Vision and Atmos
- **Latency**: < 2 seconds to start playback
- **Scale**: Millions of concurrent streams
- **Availability**: 99.99% for streaming

### Scale Estimates
- Thousands of movies and shows in catalog
- Millions of subscribers
- Each title requires 10+ encoded variants
- Petabytes of video content

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                   Content Ingestion                        |
|     Master Files -> Transcoder -> Packager -> Origin      |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                   Content Storage                          |
|        (Origin servers with all encoded variants)          |
+----------------------------------------------------------+
                           |
          +----------------+----------------+
          v                v                v
+------------------+  +------------------+  +------------------+
|    CDN Edge      |  |    CDN Edge      |  |    CDN Edge      |
|    Americas      |  |    Europe        |  |    Asia          |
+------------------+  +------------------+  +------------------+
          |                |                |
          v                v                v
+----------------------------------------------------------+
|                    Client Devices                          |
|    iPhone | iPad | Apple TV | Mac | Smart TVs | Browsers  |
+----------------------------------------------------------+
```

### Core Components
1. **Ingestion Pipeline** - Receives masters, triggers transcoding
2. **Transcoding Service** - Creates multiple quality variants
3. **Packaging Service** - Creates HLS segments and manifests
4. **DRM Service** - FairPlay licensing and content key management
5. **CDN** - Multi-tier edge caching for global delivery
6. **Playback Service** - Manages watch progress, recommendations

## Deep Dive: Video Transcoding Pipeline (8 minutes)

### Ingestion Service

When content arrives, it goes through quality validation and transcoding:

```javascript
class IngestionService {
  async ingestContent(contentId, masterFiles) {
    const { videoFile, audioStems, subtitles, metadata } = masterFiles

    // Validate master file quality
    const videoInfo = await this.analyzeVideo(videoFile)
    if (videoInfo.resolution < 3840 || videoInfo.bitDepth < 10) {
      throw new Error('Master must be 4K HDR minimum')
    }

    // Create content record
    await db.query(`
      INSERT INTO content (id, title, duration, master_resolution, hdr_format, status)
      VALUES ($1, $2, $3, $4, $5, 'ingesting')
    `, [contentId, metadata.title, videoInfo.duration,
        `${videoInfo.width}x${videoInfo.height}`, videoInfo.hdrFormat])

    // Generate encoding profiles
    const profiles = this.getEncodingProfiles(videoInfo)

    // Queue transcoding jobs (can run in parallel)
    for (const profile of profiles) {
      await this.queue.publish('transcode', {
        contentId,
        profile,
        sourceFile: videoFile,
        priority: profile.resolution >= 2160 ? 'high' : 'normal'
      })
    }

    // Process audio tracks (Stereo AAC + Dolby Atmos)
    for (const audio of audioStems) {
      await this.queue.publish('audio-encode', {
        contentId,
        sourceFile: audio.file,
        language: audio.language,
        formats: ['aac_stereo', 'aac_surround', 'atmos']
      })
    }

    return { contentId, variantCount: profiles.length }
  }

  getEncodingProfiles(videoInfo) {
    return [
      // 4K HDR (for Apple TV 4K, high-end devices)
      { resolution: 2160, codec: 'hevc', hdr: true, bitrate: 25000 },
      { resolution: 2160, codec: 'hevc', hdr: true, bitrate: 15000 },
      // 4K SDR fallback
      { resolution: 2160, codec: 'hevc', hdr: false, bitrate: 12000 },
      // 1080p (most common)
      { resolution: 1080, codec: 'hevc', hdr: false, bitrate: 8000 },
      { resolution: 1080, codec: 'h264', hdr: false, bitrate: 6000 },
      { resolution: 1080, codec: 'h264', hdr: false, bitrate: 4500 },
      // 720p (mobile, limited bandwidth)
      { resolution: 720, codec: 'h264', hdr: false, bitrate: 3000 },
      { resolution: 720, codec: 'h264', hdr: false, bitrate: 1500 },
      // Low bandwidth (cellular, slow connections)
      { resolution: 480, codec: 'h264', hdr: false, bitrate: 800 },
      { resolution: 360, codec: 'h264', hdr: false, bitrate: 400 }
    ].filter(p => p.resolution <= videoInfo.height)
  }
}
```

### Transcoding Service

```javascript
class TranscodingService {
  async processJob(job) {
    const { contentId, profile, sourceFile } = job
    const outputPath = `/tmp/${contentId}/${profile.resolution}_${profile.bitrate}.mp4`

    // Build FFmpeg command
    const ffmpegArgs = [
      '-i', sourceFile,
      '-c:v', profile.codec === 'hevc' ? 'libx265' : 'libx264',
      '-preset', 'slow',  // Quality over speed
      '-b:v', `${profile.bitrate}k`,
      '-maxrate', `${profile.bitrate * 1.5}k`,
      '-bufsize', `${profile.bitrate * 2}k`,
      '-vf', `scale=-2:${profile.resolution}`
    ]

    // Add HDR metadata if needed
    if (profile.hdr) {
      ffmpegArgs.push(
        '-color_primaries', 'bt2020',
        '-color_trc', 'smpte2084',
        '-colorspace', 'bt2020nc'
      )
    }

    ffmpegArgs.push('-an', outputPath)  // No audio (processed separately)

    // Run encoding
    await this.runFFmpeg(ffmpegArgs)

    // Segment into HLS chunks
    await this.createHLSSegments(contentId, profile, outputPath)

    // Upload to origin storage
    await this.uploadToOrigin(contentId, profile)

    // Update status
    await this.markVariantComplete(contentId, profile)
  }

  async createHLSSegments(contentId, profile, videoFile) {
    const segmentDir = `/tmp/${contentId}/segments/${profile.resolution}_${profile.bitrate}`

    await this.runFFmpeg([
      '-i', videoFile,
      '-c', 'copy',
      '-hls_time', '6',  // 6-second segments
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', `${segmentDir}/segment_%04d.ts`,
      `${segmentDir}/playlist.m3u8`
    ])
  }
}
```

### Master Manifest Generation

HLS uses a two-level manifest structure:

```javascript
class ManifestService {
  async generateMasterPlaylist(contentId) {
    const variants = await db.query(`
      SELECT * FROM encoded_variants
      WHERE content_id = $1
      ORDER BY resolution DESC, bitrate DESC
    `, [contentId])

    const audioTracks = await db.query(`
      SELECT * FROM audio_tracks WHERE content_id = $1
    `, [contentId])

    let manifest = '#EXTM3U\n#EXT-X-VERSION:6\n\n'

    // Audio groups
    for (const audio of audioTracks.rows) {
      manifest += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",`
      manifest += `LANGUAGE="${audio.language}",NAME="${audio.name}",`
      manifest += `URI="${this.getAudioUrl(contentId, audio)}"\n`
    }

    manifest += '\n'

    // Video variants
    for (const variant of variants.rows) {
      const bandwidth = variant.bitrate * 1000
      const resolution = `${this.getWidth(variant.resolution)}x${variant.resolution}`
      const codecs = this.getCodecs(variant)

      manifest += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},`
      manifest += `RESOLUTION=${resolution},CODECS="${codecs}",`
      manifest += `AUDIO="audio"\n`
      manifest += `${this.getVariantUrl(contentId, variant)}\n`
    }

    return manifest
  }
}
```

## Deep Dive: DRM Protection (FairPlay) (7 minutes)

### Content Key Flow

```javascript
class DRMService {
  async getPlaybackLicense(request) {
    const { playbackToken, spcMessage, deviceId } = request

    // Step 1: Verify playback token
    const tokenData = await this.verifyToken(playbackToken)
    if (!tokenData) {
      throw new Error('Invalid playback token')
    }

    // Step 2: Verify device is authorized
    const authorized = await this.verifyDevice(tokenData.userId, deviceId)
    if (!authorized) {
      throw new Error('Device not authorized')
    }

    // Step 3: Process Server Playback Context (SPC)
    // SPC contains device attestation from Apple's DRM framework
    const spcData = await this.decryptSPC(spcMessage)

    // Step 4: Get content key for this title
    const contentKey = await this.getContentKey(tokenData.contentId)

    // Step 5: Generate Content Key Context (CKC)
    // This encrypts the key for the specific device
    const ckc = await this.generateCKC(spcData, contentKey, {
      offlineAllowed: tokenData.downloadPermission,
      hdcpRequired: true,  // Prevent screen capture
      expiresIn: 24 * 3600  // 24-hour license
    })

    // Log for analytics and compliance
    await db.query(`
      INSERT INTO license_grants (user_id, content_id, device_id, granted_at, expires_at)
      VALUES ($1, $2, $3, NOW(), $4)
    `, [tokenData.userId, tokenData.contentId, deviceId,
        new Date(Date.now() + 24 * 3600 * 1000)])

    return { ckc }
  }

  async generateCKC(spc, contentKey, options) {
    // Apple's FairPlay server generates the CKC
    // This contains the content key encrypted for the device
    return await this.fairplayServer.generateCKC({
      spc,
      contentKey,
      rentalDuration: options.rental ? 48 * 3600 : null,
      playbackDuration: options.expiresIn,
      offlineLease: options.offlineAllowed,
      hdcpEnforcement: options.hdcpRequired ? 2 : 0
    })
  }
}
```

### Content Key Management

```javascript
class ContentKeyService {
  async generateContentKeys(contentId) {
    // Generate unique key for this content
    const contentKey = crypto.randomBytes(16)
    const keyId = uuid()

    // Store in HSM (Hardware Security Module)
    await this.hsm.storeKey(keyId, contentKey)

    // Store reference
    await db.query(`
      INSERT INTO content_keys (content_id, key_id, created_at)
      VALUES ($1, $2, NOW())
    `, [contentId, keyId])

    return { keyId }
  }

  async getContentKey(contentId) {
    const result = await db.query(`
      SELECT key_id FROM content_keys WHERE content_id = $1
    `, [contentId])

    if (result.rows.length === 0) {
      throw new Error('No content key found')
    }

    // Retrieve from HSM
    return this.hsm.getKey(result.rows[0].key_id)
  }
}
```

## Deep Dive: CDN and Global Delivery (5 minutes)

### Edge Selection

```javascript
class CDNService {
  async getPlaybackUrl(contentId, userId, deviceInfo) {
    // Check content availability in user's region
    const availability = await this.checkAvailability(contentId, userId)
    if (!availability.available) {
      throw new Error(`Not available in ${availability.region}`)
    }

    // Select optimal edge
    const edge = await this.selectEdge(userId, deviceInfo)

    // Generate playback token
    const playbackToken = await this.generatePlaybackToken({
      contentId,
      userId,
      deviceId: deviceInfo.deviceId,
      expiresAt: Date.now() + 24 * 3600 * 1000,
      maxBitrate: this.getMaxBitrate(deviceInfo)
    })

    return {
      manifestUrl: `${edge.baseUrl}/content/${contentId}/master.m3u8`,
      playbackToken,
      licenseUrl: `${edge.baseUrl}/drm/license`
    }
  }

  async selectEdge(userId, deviceInfo) {
    const location = await this.getLocation(userId)

    // Find edges with capacity in user's region
    const edges = await redis.zrangebyscore(
      `edges:${location.region}`,
      0, 80  // Load < 80%
    )

    if (edges.length === 0) {
      // Fall back to origin
      return { baseUrl: this.originUrl }
    }

    // Select by latency history
    return this.selectByLatency(edges, userId)
  }

  getMaxBitrate(deviceInfo) {
    const limits = {
      'AppleTV4K': 25000,
      'iPad': 15000,
      'iPhone': 12000,
      'Mac': 25000,
      'Browser': 8000
    }
    return limits[deviceInfo.deviceType] || 6000
  }
}
```

### Origin Shield Pattern

```
User -> Edge POP -> Regional Shield -> Origin

Benefits:
- Reduces origin load
- Single cache per region
- Faster cache warming
```

## Trade-offs and Alternatives (5 minutes)

### 1. HLS vs DASH

**Chose: HLS**
- Pro: Native Apple device support
- Pro: FairPlay DRM integration
- Pro: Wide CDN support
- Con: Slightly less efficient than DASH
- Alternative: DASH (better for non-Apple platforms)

### 2. HEVC + H.264 vs AV1

**Chose: HEVC + H.264**
- Pro: Universal hardware decode support
- Pro: HDR support with HEVC
- Con: Licensing costs for HEVC
- Alternative: AV1 (better compression but limited hardware support in 2024)

### 3. Per-Segment Encryption vs Single Key

**Chose: Per-segment key rotation**
- Pro: Better security
- Pro: Enables secure seeking
- Pro: Required for offline downloads
- Con: More key management overhead
- Alternative: Single key per content (simpler but less secure)

### 4. Device-Specific Licenses vs Concurrent Streams

**Chose: Device-specific offline licenses**
- Pro: Enables offline playback
- Pro: Can set per-device limits
- Con: More complex than stream counting
- Alternative: Concurrent stream limit (simpler for online-only)

### Database Schema

```sql
-- Content catalog
CREATE TABLE content (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  duration INTEGER NOT NULL,  -- seconds
  content_type VARCHAR(20),   -- movie, episode
  series_id UUID REFERENCES content(id),
  season_number INTEGER,
  episode_number INTEGER,
  status VARCHAR(20) DEFAULT 'processing',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Encoded variants
CREATE TABLE encoded_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID REFERENCES content(id),
  resolution INTEGER NOT NULL,
  codec VARCHAR(20) NOT NULL,
  hdr BOOLEAN DEFAULT FALSE,
  bitrate INTEGER NOT NULL,
  file_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Watch progress
CREATE TABLE watch_progress (
  user_id UUID NOT NULL,
  content_id UUID REFERENCES content(id),
  position INTEGER NOT NULL,  -- seconds
  completed BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, content_id)
);

-- Downloads (offline content)
CREATE TABLE downloads (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  content_id UUID REFERENCES content(id),
  device_id VARCHAR(100) NOT NULL,
  quality VARCHAR(20),
  license_expires TIMESTAMP,
  downloaded_at TIMESTAMP
);
```

## Closing Summary (1 minute)

"Apple TV+ is built around three key systems:

1. **Multi-variant transcoding** - Each piece of content is encoded into 10+ variants covering different resolutions, codecs, and bitrates. This enables adaptive streaming where the client selects the best quality for current network conditions.

2. **HLS adaptive streaming** - Using a two-level manifest structure, clients can seamlessly switch between quality levels mid-stream. The 6-second segments enable quick adaptation to network changes.

3. **FairPlay DRM** - Content is encrypted with unique keys, and licenses are issued per-device. The Server Playback Context / Content Key Context exchange ensures only authorized devices can decrypt content.

The main trade-off is between complexity and user experience. The multi-variant approach requires significant storage and transcoding compute, but it enables smooth playback across all network conditions and devices."

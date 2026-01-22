# YouTube - Video Platform - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"I'll be designing the backend infrastructure for a video hosting and streaming platform like YouTube. This is one of the most challenging backend systems to design because it involves massive object storage, asynchronous transcoding pipelines, adaptive bitrate streaming with HLS, sophisticated recommendation algorithms, and global content delivery. Let me start by scoping the problem with a focus on the backend services."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Video Upload Pipeline**
   - Chunked upload handling for large files (up to 5GB)
   - Resumable uploads with S3 multipart
   - Validation and malware scanning
   - Queue-based transcoding workflow

2. **Transcoding Service**
   - Convert to multiple resolutions (1080p, 720p, 480p, 360p)
   - Generate HLS segments and manifests
   - Thumbnail generation at multiple timestamps
   - Status tracking and notifications

3. **Streaming Infrastructure**
   - HLS manifest generation and delivery
   - CDN integration for segment caching
   - Adaptive bitrate support
   - Resume playback position tracking

4. **Engagement APIs**
   - Comments with threading (parent/child relationships)
   - Like/dislike reactions with counter updates
   - Subscriptions with notification preferences
   - Watch history for recommendations

5. **Recommendation Engine**
   - Collaborative filtering based on watch patterns
   - Content-based filtering using categories/tags
   - Trending algorithm with time decay
   - Personalized home feed generation

### Non-Functional Requirements

- **Scale**: 500 hours video/minute upload, 1B views/day
- **Latency**: API responses < 200ms p95, video start < 2s
- **Throughput**: 17 Tbps streaming bandwidth
- **Consistency**: Eventual for view counts, strong for user actions

---

## 2. Scale Estimation (2-3 minutes)

### Storage Requirements

```
Daily video uploads: 500 hours/min x 60 min x 24 hours = 720,000 hours/day
Average video duration: 10 minutes
Daily uploads: 4.3 million videos

Raw storage per video: 1GB average
Daily raw storage: 4.3 PB

After transcoding (10% compression + multi-resolution):
- 1080p: 500k bitrate x 10 min = 375 MB
- 720p: 250k bitrate x 10 min = 187 MB
- 480p: 100k bitrate x 10 min = 75 MB
- 360p: 50k bitrate x 10 min = 37 MB
Total processed per video: ~674 MB average

Daily processed storage: ~2.9 PB
Annual storage growth: ~1 EB
```

### Bandwidth Calculations

```
Daily views: 1 billion
Average watch duration: 5 minutes
Average bitrate: 5 Mbps (720p)

Total daily bandwidth: 1B x 5 min x 60s x 5 Mbps
                     = 1.5 Exabits/day
                     = 17.4 Tbps continuous

CDN cache hit rate: 95% (popular content)
Origin bandwidth: 17.4 Tbps x 5% = 870 Gbps
```

### Database Scale

```
Video metadata: 1B videos x 10KB = 10 TB
User accounts: 2B users x 5KB = 10 TB
Comments: 100B comments x 500 bytes = 50 TB
Watch history: 500B entries x 100 bytes = 50 TB
```

---

## 3. High-Level Backend Architecture (8-10 minutes)

```
                                    ┌──────────────────────────────────────────┐
                                    │              CDN Edge Layer              │
                                    │    (Cloudflare/Akamai/Custom POPs)       │
                                    └──────────────────┬───────────────────────┘
                                                       │
                                    ┌──────────────────▼───────────────────────┐
                                    │            API Gateway / Nginx           │
                                    │   (Authentication, Rate Limiting, TLS)   │
                                    └────────────────────┬─────────────────────┘
                                                         │
           ┌─────────────────────┬───────────────────────┼───────────────────────┬──────────────────────┐
           │                     │                       │                       │                      │
  ┌────────▼────────┐  ┌────────▼────────┐  ┌───────────▼──────────┐  ┌────────▼────────┐  ┌──────────▼─────────┐
  │  Upload Service │  │ Metadata Service│  │   Streaming Service  │  │ Comment Service │  │ Recommendation Svc │
  │                 │  │                 │  │                      │  │                 │  │                    │
  │ - Chunked upload│  │ - Video CRUD    │  │ - Manifest generation│  │ - Thread mgmt   │  │ - Collaborative    │
  │ - S3 multipart  │  │ - Channel mgmt  │  │ - Segment routing    │  │ - Reactions     │  │ - Content-based    │
  │ - Validation    │  │ - Subscription  │  │ - Progress tracking  │  │ - Moderation    │  │ - Trending         │
  └────────┬────────┘  └────────┬────────┘  └───────────┬──────────┘  └────────┬────────┘  └──────────┬─────────┘
           │                    │                       │                      │                      │
           │                    │                       │                      │                      │
  ┌────────▼────────┐           │                       │                      │                      │
  │   Kafka/RMQ     │           │                       │                      │                      │
  │  (Job Queue)    │           │                       │                      │                      │
  └────────┬────────┘           │                       │                      │                      │
           │                    │                       │                      │                      │
  ┌────────▼────────┐           │                       │                      │                      │
  │ Transcoding     │           │                       │                      │                      │
  │ Workers (K8s)   │           │                       │                      │                      │
  │                 │           │                       │                      │                      │
  │ - FFmpeg encode │           │                       │                      │                      │
  │ - HLS segment   │           │                       │                      │                      │
  │ - Thumbnails    │           │                       │                      │                      │
  └────────┬────────┘           │                       │                      │                      │
           │                    │                       │                      │                      │
           └────────────────────┴───────────────────────┴──────────────────────┴──────────────────────┘
                                                        │
                     ┌──────────────────────────────────┼──────────────────────────────────┐
                     │                                  │                                  │
            ┌────────▼────────┐               ┌────────▼────────┐               ┌─────────▼────────┐
            │   PostgreSQL    │               │     Redis       │               │      MinIO       │
            │    (Primary)    │               │   (Cluster)     │               │   (S3 Storage)   │
            │                 │               │                 │               │                  │
            │ - Video metadata│               │ - Session store │               │ - Raw videos     │
            │ - Users/channels│               │ - View counters │               │ - HLS segments   │
            │ - Comments      │               │ - Cache layer   │               │ - Thumbnails     │
            │ - Watch history │               │ - Rate limits   │               │ - Avatars        │
            └─────────────────┘               └─────────────────┘               └──────────────────┘
```

### Service Responsibilities

| Service | Technology | Key Responsibilities |
|---------|------------|---------------------|
| Upload Service | Express + Multer | Chunked upload, S3 multipart, validation |
| Metadata Service | Express | Video/channel CRUD, subscriptions |
| Streaming Service | Express/Nginx | HLS manifests, segment routing |
| Comment Service | Express | Threading, reactions, moderation |
| Recommendation Service | Express + ML | Personalization, trending |
| Transcode Workers | Node/Python + FFmpeg | Video processing, HLS packaging |

---

## 4. Deep Dive: Chunked Upload and Transcoding Pipeline (10-12 minutes)

### Chunked Upload with S3 Multipart

```typescript
// Upload Service - Initialization
async function initializeUpload(req: Request): Promise<UploadSession> {
  const { filename, fileSize, mimeType } = req.body;
  const userId = req.session.userId;

  // Validate file type and size
  if (!ALLOWED_TYPES.includes(mimeType)) {
    throw new ValidationError('Unsupported video format');
  }
  if (fileSize > MAX_FILE_SIZE) {
    throw new ValidationError('File exceeds 5GB limit');
  }

  // Calculate chunk count
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  // Initialize S3 multipart upload
  const s3UploadId = await s3.createMultipartUpload({
    Bucket: 'raw-videos',
    Key: `${generateUploadId()}/${filename}`,
    ContentType: mimeType
  });

  // Create session record
  const session = await db.uploadSessions.create({
    id: generateUploadId(),
    userId,
    filename,
    fileSize,
    totalChunks,
    uploadedChunks: 0,
    status: 'active',
    s3UploadId: s3UploadId.UploadId,
    expiresAt: addHours(new Date(), 24)
  });

  return {
    uploadId: session.id,
    chunkSize: CHUNK_SIZE,
    totalChunks
  };
}

// Chunk upload handler
async function uploadChunk(
  uploadId: string,
  chunkNumber: number,
  data: Buffer
): Promise<{ etag: string }> {
  const session = await db.uploadSessions.findById(uploadId);

  if (!session || session.status !== 'active') {
    throw new NotFoundError('Upload session not found or expired');
  }

  // Upload part to S3
  const result = await s3.uploadPart({
    Bucket: 'raw-videos',
    Key: session.s3Key,
    UploadId: session.s3UploadId,
    PartNumber: chunkNumber + 1, // S3 parts are 1-indexed
    Body: data
  });

  // Track chunk completion in Redis for parallel uploads
  await redis.hset(`upload:${uploadId}:parts`,
    chunkNumber.toString(),
    result.ETag
  );
  await redis.hincrby(`upload:${uploadId}`, 'completedChunks', 1);

  return { etag: result.ETag };
}

// Complete upload and trigger transcoding
async function completeUpload(
  uploadId: string,
  metadata: VideoMetadata
): Promise<Video> {
  const session = await db.uploadSessions.findById(uploadId);

  // Verify all chunks received
  const completedChunks = await redis.hget(`upload:${uploadId}`, 'completedChunks');
  if (parseInt(completedChunks) !== session.totalChunks) {
    throw new ValidationError('Missing chunks');
  }

  // Get ETags for multipart completion
  const parts = await redis.hgetall(`upload:${uploadId}:parts`);
  const sortedParts = Object.entries(parts)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([partNumber, etag]) => ({
      PartNumber: parseInt(partNumber) + 1,
      ETag: etag
    }));

  // Complete S3 multipart upload
  await s3.completeMultipartUpload({
    Bucket: 'raw-videos',
    Key: session.s3Key,
    UploadId: session.s3UploadId,
    MultipartUpload: { Parts: sortedParts }
  });

  // Create video record
  const videoId = generateYouTubeStyleId(); // 11-char alphanumeric
  const video = await db.videos.create({
    id: videoId,
    channelId: session.userId,
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
    categories: metadata.categories,
    status: 'processing',
    rawVideoKey: session.s3Key,
    createdAt: new Date()
  });

  // Queue transcoding job
  await messageQueue.publish('transcode.jobs', {
    jobId: generateJobId(),
    videoId: video.id,
    sourceKey: session.s3Key,
    resolutions: ['1080p', '720p', '480p', '360p'],
    priority: 'normal',
    createdAt: new Date()
  });

  // Cleanup
  await redis.del(`upload:${uploadId}:parts`, `upload:${uploadId}`);
  await db.uploadSessions.update(uploadId, { status: 'completed' });

  return video;
}
```

### Transcoding Worker with FFmpeg

```python
# Transcoding Worker (Python for FFmpeg integration)
import subprocess
import boto3
from dataclasses import dataclass

@dataclass
class TranscodeJob:
    job_id: str
    video_id: str
    source_key: str
    resolutions: list[str]
    priority: str

RESOLUTION_CONFIGS = {
    '1080p': {'width': 1920, 'height': 1080, 'bitrate': '5000k', 'audio': '192k'},
    '720p':  {'width': 1280, 'height': 720,  'bitrate': '2500k', 'audio': '128k'},
    '480p':  {'width': 854,  'height': 480,  'bitrate': '1000k', 'audio': '96k'},
    '360p':  {'width': 640,  'height': 360,  'bitrate': '500k',  'audio': '64k'}
}

HLS_SEGMENT_DURATION = 4  # seconds

async def process_transcode_job(job: TranscodeJob):
    try:
        # Update status
        await update_video_status(job.video_id, 'transcoding')

        # Download raw video
        local_path = f'/tmp/{job.video_id}/raw.mp4'
        await download_from_s3('raw-videos', job.source_key, local_path)

        # Extract source metadata
        probe = await ffprobe(local_path)
        source_resolution = (probe['width'], probe['height'])
        duration = probe['duration']

        # Generate thumbnails
        thumbnails = await generate_thumbnails(local_path, job.video_id)

        completed_resolutions = []

        # Transcode to each resolution
        for resolution in job.resolutions:
            config = RESOLUTION_CONFIGS[resolution]

            # Skip if source is lower resolution
            if not resolution_fits(source_resolution, config):
                continue

            # Transcode to intermediate MP4
            intermediate = f'/tmp/{job.video_id}/{resolution}.mp4'
            await transcode_to_resolution(local_path, intermediate, config)

            # Generate HLS segments
            segments_dir = f'/tmp/{job.video_id}/{resolution}/segments'
            manifest_path = await generate_hls_segments(
                intermediate,
                segments_dir,
                segment_duration=HLS_SEGMENT_DURATION
            )

            # Upload segments to S3
            await upload_hls_to_s3(
                segments_dir,
                f'videos/{job.video_id}/{resolution}'
            )

            # Record resolution metadata
            completed_resolutions.append({
                'resolution': resolution,
                'width': config['width'],
                'height': config['height'],
                'bitrate': int(config['bitrate'].replace('k', '')) * 1000
            })

        # Generate master manifest
        master_manifest = generate_master_manifest(
            job.video_id,
            completed_resolutions
        )
        await upload_to_s3(
            'videos',
            f'{job.video_id}/master.m3u8',
            master_manifest
        )

        # Update video record
        await update_video_complete(
            job.video_id,
            status='ready',
            duration_seconds=int(duration),
            resolutions=completed_resolutions,
            thumbnail_url=thumbnails['default'],
            published_at=datetime.now()
        )

        # Clean up local files
        shutil.rmtree(f'/tmp/{job.video_id}')

        # Publish event for notifications
        await publish_event('video.published', {
            'videoId': job.video_id,
            'channelId': video.channel_id
        })

    except Exception as e:
        logger.error(f'Transcode failed: {job.video_id}', error=str(e))
        await update_video_status(job.video_id, 'failed')
        raise  # For retry handling

async def transcode_to_resolution(input_path: str, output_path: str, config: dict):
    """Run FFmpeg transcoding to specific resolution"""
    cmd = [
        'ffmpeg', '-i', input_path,
        '-vf', f"scale={config['width']}:{config['height']}",
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-b:v', config['bitrate'],
        '-maxrate', config['bitrate'],
        '-bufsize', str(int(config['bitrate'].replace('k', '')) * 2) + 'k',
        '-c:a', 'aac',
        '-b:a', config['audio'],
        '-movflags', '+faststart',
        output_path
    ]

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        raise TranscodeError(f'FFmpeg failed: {stderr.decode()}')

async def generate_hls_segments(input_path: str, output_dir: str, segment_duration: int):
    """Generate HLS playlist and segments"""
    os.makedirs(output_dir, exist_ok=True)
    playlist_path = f'{output_dir}/playlist.m3u8'

    cmd = [
        'ffmpeg', '-i', input_path,
        '-c', 'copy',  # No re-encoding, just segment
        '-hls_time', str(segment_duration),
        '-hls_list_size', '0',  # Include all segments
        '-hls_segment_filename', f'{output_dir}/segment_%04d.ts',
        '-hls_playlist_type', 'vod',
        playlist_path
    ]

    process = await asyncio.create_subprocess_exec(*cmd)
    await process.wait()

    return playlist_path

def generate_master_manifest(video_id: str, resolutions: list) -> str:
    """Generate HLS master playlist pointing to quality variants"""
    lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3'
    ]

    for res in sorted(resolutions, key=lambda r: r['bitrate'], reverse=True):
        lines.append(
            f"#EXT-X-STREAM-INF:BANDWIDTH={res['bitrate']},"
            f"RESOLUTION={res['width']}x{res['height']}"
        )
        lines.append(f"{res['resolution']}/playlist.m3u8")

    return '\n'.join(lines)
```

### HLS Manifest Structure

```
# Master Playlist (master.m3u8)
#EXTM3U
#EXT-X-VERSION:3

#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
360p/playlist.m3u8
```

```
# Quality Playlist (720p/playlist.m3u8)
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0

#EXTINF:4.000,
segment_0000.ts
#EXTINF:4.000,
segment_0001.ts
#EXTINF:4.000,
segment_0002.ts
#EXTINF:3.500,
segment_0003.ts
#EXT-X-ENDLIST
```

---

## 5. Deep Dive: View Counting and CDN Caching (6-8 minutes)

### Batched View Count Updates

```typescript
// View Recording Service
class ViewCountService {
  private readonly BATCH_INTERVAL = 60_000; // 1 minute
  private readonly BATCH_SIZE = 1000;

  async recordView(videoId: string, userId?: string): Promise<void> {
    const viewKey = `views:pending:${videoId}`;
    const viewDetailsKey = `views:details:${videoId}`;

    // Increment counter atomically
    await redis.incr(viewKey);

    // Store additional view metadata for analytics
    if (userId) {
      await redis.lpush(viewDetailsKey, JSON.stringify({
        userId,
        timestamp: Date.now(),
        quality: req.headers['x-video-quality']
      }));
      await redis.ltrim(viewDetailsKey, 0, 999); // Keep last 1000
    }
  }

  // Background job running every minute
  async flushViewCounts(): Promise<void> {
    const pattern = 'views:pending:*';
    let cursor = '0';

    do {
      const [newCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = newCursor;

      for (const key of keys) {
        const videoId = key.split(':')[2];

        // Get and reset atomically
        const count = await redis.getset(key, '0');

        if (parseInt(count) > 0) {
          // Batch update to PostgreSQL
          await pool.query(`
            UPDATE videos
            SET view_count = view_count + $1,
                updated_at = NOW()
            WHERE id = $2
          `, [count, videoId]);

          // Invalidate cache
          await redis.del(`video:${videoId}`);

          // Update trending score
          await this.updateTrendingScore(videoId, parseInt(count));
        }

        // Delete if zero
        const remaining = await redis.get(key);
        if (remaining === '0') {
          await redis.del(key);
        }
      }
    } while (cursor !== '0');
  }

  private async updateTrendingScore(videoId: string, viewDelta: number): Promise<void> {
    // Get video metadata for category
    const video = await this.getVideo(videoId);

    // Score = views * time_decay
    // Time decay: score halves every 24 hours
    const ageHours = (Date.now() - video.publishedAt.getTime()) / (1000 * 60 * 60);
    const decayFactor = Math.pow(0.5, ageHours / 24);
    const score = viewDelta * decayFactor;

    // Update global and category-specific trending sets
    await redis.zincrby('trending:global', score, videoId);

    for (const category of video.categories) {
      await redis.zincrby(`trending:${category}`, score, videoId);
    }

    // Trim to top 1000
    await redis.zremrangebyrank('trending:global', 0, -1001);
  }
}
```

### Multi-Tier CDN Caching Strategy

```typescript
// CDN Cache Configuration
interface CDNCacheConfig {
  edge: {
    ttl: 3600,           // 1 hour at edge
    staleWhileRevalidate: 300,
    cacheableResponses: ['200', '206']
  },
  regional: {
    ttl: 86400,          // 24 hours at regional POPs
    minFreshness: 3600
  },
  origin: {
    shieldEnabled: true,  // Single origin-facing cache layer
    bypassTokens: ['X-Cache-Bypass']
  }
}

// Nginx configuration for HLS caching
const nginxCacheConfig = `
# Cache zone definitions
proxy_cache_path /var/cache/nginx/hls
    levels=1:2
    keys_zone=hls_cache:100m
    max_size=50g
    inactive=24h
    use_temp_path=off;

# HLS segment caching
location ~ ^/videos/([^/]+)/([^/]+)/segment_.*\.ts$ {
    proxy_pass http://minio;
    proxy_cache hls_cache;

    # Long cache for immutable segments
    proxy_cache_valid 200 7d;
    proxy_cache_use_stale error timeout updating;

    # Add cache status header for debugging
    add_header X-Cache-Status $upstream_cache_status;

    # Enable range requests for seeking
    proxy_set_header Range $http_range;
    proxy_cache_key "$uri$is_args$args";
}

# Manifest files - shorter cache
location ~ ^/videos/([^/]+)/.*\.m3u8$ {
    proxy_pass http://minio;
    proxy_cache hls_cache;

    # Short cache since manifests can be regenerated
    proxy_cache_valid 200 5m;
    proxy_cache_use_stale error timeout;

    add_header X-Cache-Status $upstream_cache_status;
}
`;

// Pre-warming popular content
async function prewarmVideo(videoId: string): Promise<void> {
  const video = await getVideo(videoId);

  // Get list of edge POPs
  const edgeLocations = await cdn.getEdgeLocations();

  // Prefetch master manifest and first segments of each quality
  const prefetchUrls = [
    `${CDN_URL}/videos/${videoId}/master.m3u8`,
    ...video.resolutions.map(r =>
      `${CDN_URL}/videos/${videoId}/${r.resolution}/playlist.m3u8`
    ),
    // First 10 segments of each quality (covers ~40 seconds)
    ...video.resolutions.flatMap(r =>
      Array.from({length: 10}, (_, i) =>
        `${CDN_URL}/videos/${videoId}/${r.resolution}/segment_${i.toString().padStart(4, '0')}.ts`
      )
    )
  ];

  // Issue prefetch requests to edge POPs
  await Promise.all(
    edgeLocations.map(edge =>
      edge.prefetch(prefetchUrls)
    )
  );
}
```

---

## 6. Deep Dive: Recommendation System (5-6 minutes)

### Collaborative Filtering Implementation

```typescript
// Recommendation Service
class RecommendationService {
  // Get personalized recommendations for user
  async getRecommendations(userId: string, limit: number = 50): Promise<Video[]> {
    // Gather candidates from multiple sources
    const [
      collaborative,
      contentBased,
      subscribed,
      trending
    ] = await Promise.all([
      this.collaborativeFilter(userId, limit),
      this.contentBasedFilter(userId, limit),
      this.subscriptionFeed(userId, limit),
      this.getTrending(limit)
    ]);

    // Merge and deduplicate
    const candidateMap = new Map<string, RecommendationCandidate>();

    for (const video of [...collaborative, ...contentBased, ...subscribed, ...trending]) {
      if (!candidateMap.has(video.id)) {
        candidateMap.set(video.id, {
          video,
          sources: [],
          score: 0
        });
      }
      candidateMap.get(video.id)!.sources.push(video.source);
    }

    // Score and rank candidates
    const scored = await this.scoreAndRank(userId, [...candidateMap.values()]);

    return scored.slice(0, limit).map(c => c.video);
  }

  private async collaborativeFilter(userId: string, limit: number): Promise<Video[]> {
    // Find users with similar watch patterns
    const userWatchHistory = await this.getWatchHistory(userId, 100);
    const watchedVideoIds = new Set(userWatchHistory.map(w => w.videoId));

    // Find similar users (users who watched same videos with high completion)
    const similarUsers = await pool.query(`
      WITH user_videos AS (
        SELECT video_id, watch_percentage
        FROM watch_history
        WHERE user_id = $1
        AND watch_percentage > 50
        ORDER BY watched_at DESC
        LIMIT 100
      ),
      similar_watchers AS (
        SELECT
          wh.user_id,
          COUNT(*) as overlap,
          AVG(wh.watch_percentage) as avg_completion
        FROM watch_history wh
        JOIN user_videos uv ON wh.video_id = uv.video_id
        WHERE wh.user_id != $1
        AND wh.watch_percentage > 50
        GROUP BY wh.user_id
        HAVING COUNT(*) >= 5
        ORDER BY overlap DESC, avg_completion DESC
        LIMIT 50
      )
      SELECT user_id, overlap, avg_completion
      FROM similar_watchers
    `, [userId]);

    // Get videos those users watched that current user hasn't
    const recommendations = await pool.query(`
      WITH similar_user_videos AS (
        SELECT
          wh.video_id,
          SUM(su.overlap * wh.watch_percentage / 100) as score
        FROM watch_history wh
        JOIN (VALUES ${similarUsers.rows.map((u, i) =>
          `($${i*2+2}::uuid, $${i*2+3}::int)`
        ).join(',')}) AS su(user_id, overlap)
        ON wh.user_id = su.user_id
        WHERE wh.video_id != ALL($1)
        AND wh.watch_percentage > 50
        GROUP BY wh.video_id
      )
      SELECT v.*, suv.score
      FROM videos v
      JOIN similar_user_videos suv ON v.id = suv.video_id
      WHERE v.status = 'ready'
      AND v.visibility = 'public'
      ORDER BY suv.score DESC
      LIMIT $${similarUsers.rows.length * 2 + 2}
    `, [
      Array.from(watchedVideoIds),
      ...similarUsers.rows.flatMap(u => [u.user_id, u.overlap]),
      limit
    ]);

    return recommendations.rows.map(r => ({
      ...r,
      source: 'collaborative'
    }));
  }

  private async contentBasedFilter(userId: string, limit: number): Promise<Video[]> {
    // Extract user's content preferences
    const preferences = await pool.query(`
      SELECT
        unnest(v.categories) as category,
        SUM(wh.watch_percentage) as weight
      FROM watch_history wh
      JOIN videos v ON v.id = wh.video_id
      WHERE wh.user_id = $1
      AND wh.watched_at > NOW() - INTERVAL '30 days'
      GROUP BY unnest(v.categories)
      ORDER BY weight DESC
      LIMIT 10
    `, [userId]);

    const categoryWeights = new Map(
      preferences.rows.map(p => [p.category, parseFloat(p.weight)])
    );

    // Find videos in preferred categories
    const watchedIds = await this.getWatchedVideoIds(userId);

    const candidates = await pool.query(`
      SELECT
        v.*,
        v.categories & $1 as matched_categories
      FROM videos v
      WHERE v.status = 'ready'
      AND v.visibility = 'public'
      AND v.categories && $1
      AND v.id != ALL($2)
      ORDER BY
        ARRAY_LENGTH(v.categories & $1, 1) DESC,
        v.view_count DESC
      LIMIT $3
    `, [
      Array.from(categoryWeights.keys()),
      watchedIds,
      limit * 2
    ]);

    // Score by category weights and engagement
    return candidates.rows
      .map(v => {
        const categoryScore = v.matched_categories.reduce(
          (sum: number, cat: string) => sum + (categoryWeights.get(cat) || 0),
          0
        );
        return {
          ...v,
          source: 'content-based',
          contentScore: categoryScore * (v.like_count / (v.view_count || 1))
        };
      })
      .sort((a, b) => b.contentScore - a.contentScore)
      .slice(0, limit);
  }

  private async scoreAndRank(
    userId: string,
    candidates: RecommendationCandidate[]
  ): Promise<RecommendationCandidate[]> {
    // Final scoring with source weights and time decay
    const now = Date.now();

    for (const candidate of candidates) {
      let score = 0;

      // Source weights
      if (candidate.sources.includes('subscribed')) score += 100;
      if (candidate.sources.includes('collaborative')) score += 50;
      if (candidate.sources.includes('content-based')) score += 30;
      if (candidate.sources.includes('trending')) score += 20;

      // Engagement quality
      const engagementRatio = candidate.video.like_count /
        (candidate.video.like_count + candidate.video.dislike_count + 1);
      score += engagementRatio * 40;

      // Freshness decay (half-life of 48 hours)
      const ageHours = (now - candidate.video.publishedAt.getTime()) / (1000 * 60 * 60);
      score *= Math.exp(-ageHours / 48);

      candidate.score = score;
    }

    return candidates.sort((a, b) => b.score - a.score);
  }
}
```

---

## 7. Database Schema and Indexes (4-5 minutes)

### Core Tables

```sql
-- YouTube-style 11-character video IDs
CREATE TABLE videos (
    id VARCHAR(11) PRIMARY KEY,
    channel_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    duration_seconds INTEGER,
    status VARCHAR(20) DEFAULT 'processing',
    visibility VARCHAR(20) DEFAULT 'public',
    view_count BIGINT DEFAULT 0,
    like_count BIGINT DEFAULT 0,
    dislike_count BIGINT DEFAULT 0,
    comment_count BIGINT DEFAULT 0,
    categories TEXT[] DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    thumbnail_url TEXT,
    raw_video_key TEXT,
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Composite indexes for common queries
CREATE INDEX idx_videos_channel_published
  ON videos(channel_id, published_at DESC);

CREATE INDEX idx_videos_status_published
  ON videos(published_at DESC)
  WHERE status = 'ready' AND visibility = 'public';

-- GIN indexes for array searches
CREATE INDEX idx_videos_categories ON videos USING GIN(categories);
CREATE INDEX idx_videos_tags ON videos USING GIN(tags);

-- Video resolutions for ABR streaming
CREATE TABLE video_resolutions (
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    resolution VARCHAR(10) NOT NULL,
    manifest_url TEXT,
    bitrate INTEGER,
    width INTEGER,
    height INTEGER,
    PRIMARY KEY (video_id, resolution)
);

-- Threaded comments
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    is_edited BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_comments_video_created
  ON comments(video_id, created_at DESC);
CREATE INDEX idx_comments_parent
  ON comments(parent_id) WHERE parent_id IS NOT NULL;

-- Watch history for recommendations
CREATE TABLE watch_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    watch_duration_seconds INTEGER DEFAULT 0,
    watch_percentage DECIMAL(5,2) DEFAULT 0,
    last_position_seconds INTEGER DEFAULT 0,
    watched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Composite index for user history and recommendation queries
CREATE INDEX idx_watch_history_user_recent
  ON watch_history(user_id, watched_at DESC);
CREATE INDEX idx_watch_history_video_completion
  ON watch_history(video_id, watch_percentage);
```

### Redis Data Structures

```
# View count buffering
views:pending:{videoId} -> STRING (incremented, flushed every minute)

# Trending sorted sets (score = views * time_decay)
trending:global -> ZSET { videoId: score }
trending:{category} -> ZSET { videoId: score }

# Session storage
session:{sessionId} -> HASH { userId, username, role, expiresAt }

# Video metadata cache
video:{videoId} -> JSON { title, views, likes, duration, ... }

# Upload progress tracking
upload:{uploadId} -> HASH { completedChunks, status }
upload:{uploadId}:parts -> HASH { partNumber: etag }

# Rate limiting
ratelimit:{ip}:{endpoint} -> STRING (counter with TTL)
```

---

## 8. Trade-offs and Alternatives (4-5 minutes)

### Storage Architecture

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| S3/MinIO | Scalable, cheap per GB, durable | Latency, needs CDN | **Chosen** - CDN solves latency |
| Custom distributed FS | Low latency, control | Complex ops, expensive | Avoid unless massive scale |
| Block storage + NFS | Simple | Not scalable | Local dev only |

### Video Format Strategy

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| HLS only | Wide support, Apple native | Older standard | **Chosen** - best compatibility |
| DASH only | Open standard, modern | Less iOS support | Good alternative |
| Both HLS + DASH | Maximum reach | 2x storage | Justified at scale |

### Transcoding Architecture

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Sync transcoding | Simple | Blocks upload, slow | Never for video |
| Async with RabbitMQ | Reliable, retries | Single queue bottleneck | **Chosen** for learning |
| Kafka + workers | Parallel, scalable | More complex | Production at scale |
| Serverless (Lambda) | Auto-scale | Cold start, duration limits | Good for burst |

### View Count Consistency

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Sync DB update | Accurate | DB bottleneck at scale | Never |
| Redis buffer + batch | Fast, scalable | Eventual consistency | **Chosen** |
| HyperLogLog | Very low memory | Approximate only | For unique views |

---

## 9. Monitoring and Observability (3-4 minutes)

### Key Backend Metrics

```typescript
// Prometheus metrics
const metrics = {
  // Upload metrics
  video_uploads_total: new Counter({
    name: 'video_uploads_total',
    help: 'Total video uploads',
    labelNames: ['status'] // initiated, completed, failed
  }),

  upload_size_bytes: new Histogram({
    name: 'video_upload_size_bytes',
    help: 'Size of uploaded videos',
    buckets: [1e6, 1e7, 1e8, 5e8, 1e9, 5e9] // 1MB to 5GB
  }),

  // Transcoding metrics
  transcode_queue_depth: new Gauge({
    name: 'transcode_queue_depth',
    help: 'Number of pending transcode jobs'
  }),

  transcode_duration_seconds: new Histogram({
    name: 'transcode_duration_seconds',
    help: 'Transcoding job duration',
    labelNames: ['resolution', 'status'],
    buckets: [60, 300, 600, 1800, 3600] // 1min to 1hour
  }),

  // Streaming metrics
  video_views_total: new Counter({
    name: 'video_views_total',
    help: 'Total video views',
    labelNames: ['quality']
  }),

  video_watch_duration_seconds: new Histogram({
    name: 'video_watch_duration_seconds',
    help: 'Watch duration per session'
  }),

  // Cache metrics
  cache_hit_ratio: new Gauge({
    name: 'cache_hit_ratio',
    help: 'Redis cache hit ratio',
    labelNames: ['cache_type']
  })
};
```

### Alerting Rules

| Metric | Warning | Critical |
|--------|---------|----------|
| Transcode queue depth | > 50 jobs | > 200 jobs |
| Transcode failure rate | > 5% | > 15% |
| API p95 latency | > 500ms | > 2s |
| Upload failure rate | > 2% | > 10% |
| CDN cache hit ratio | < 90% | < 70% |
| DB connection pool | > 80% used | > 95% used |

---

## 10. Summary

The backend architecture for YouTube focuses on:

1. **Chunked Upload Pipeline**: S3 multipart uploads with resumable chunks handle large files reliably while tracking progress in Redis

2. **Async Transcoding**: Kafka/RabbitMQ job queue with FFmpeg workers generates HLS segments for adaptive streaming across multiple resolutions

3. **View Count Batching**: Redis buffers view increments with periodic flushes to PostgreSQL, preventing database bottleneck while maintaining eventual consistency

4. **Multi-Tier CDN**: Edge caching with HLS segment-level granularity, regional POPs, and origin shield reduce origin load to 5% of total bandwidth

5. **Hybrid Recommendations**: Collaborative filtering (similar users), content-based filtering (categories/tags), and trending algorithms combine for personalized feeds

6. **Denormalized Counters**: View, like, and subscriber counts are denormalized for read performance with trigger-based updates maintaining consistency

The system handles 500 hours of video per minute through horizontal scaling of stateless services, massive object storage capacity, and global CDN distribution.

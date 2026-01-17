# YouTube System Design Interview Answer

## Opening Statement

"I'll be designing a video hosting and streaming platform like YouTube. This is one of the most challenging systems to design because it involves massive storage, global content delivery, complex transcoding pipelines, and sophisticated recommendation algorithms. Let me start by scoping the problem."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Video Upload**
   - Upload videos of various formats and sizes
   - Process and transcode to multiple resolutions
   - Generate thumbnails and metadata

2. **Video Streaming**
   - Stream videos with adaptive bitrate
   - Support multiple devices (web, mobile, TV)
   - Resume playback from where user left off

3. **Video Discovery**
   - Search videos by title, description, tags
   - Recommendation system for personalized content
   - Trending and category-based browsing

4. **Engagement**
   - Like, dislike, comment on videos
   - Subscribe to channels
   - Create and manage playlists

5. **Creator Features**
   - Analytics dashboard
   - Monetization (ads, memberships)
   - Content management

### Non-Functional Requirements

- **Scale**: 2 billion monthly users, 500 hours of video uploaded per minute
- **Latency**: Video start time < 2 seconds
- **Availability**: 99.99% uptime
- **Global**: Serve content worldwide with low latency

---

## 2. Scale Estimation (2-3 minutes)

**Video Upload Scale**
- 500 hours of video/minute = 720,000 hours/day
- Average video: 10 minutes, 1GB raw
- Daily uploads: 4.3 million videos
- Daily raw storage: 4.3 PB

**Storage (after transcoding)**
- Each video transcoded to 5 resolutions
- Compression reduces to ~10% of raw
- Daily storage: 430 TB
- Annual: ~150 PB

**Viewing Scale**
- 1 billion video views/day
- Average video length watched: 5 minutes
- Average bitrate: 5 Mbps
- Bandwidth: 1B x 5min x 60s x 5Mbps = 1.5 Exabits/day = 17 Tbps average

**Database Scale**
- Video metadata: 1 billion videos x 10KB = 10 TB
- User data: 2 billion users x 5KB = 10 TB
- Comments: 100 billion comments x 500 bytes = 50 TB

---

## 3. High-Level Architecture (8-10 minutes)

```
    ┌──────────────────┐
    │    Client Apps   │
    │  (Web/Mobile/TV) │
    └────────┬─────────┘
             │
             ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │                         CDN (Global Edge)                            │
    │              Cloudflare / Akamai / Custom Edge Servers               │
    │                                                                      │
    │         - Video segment caching                                      │
    │         - Thumbnail caching                                          │
    │         - Static assets                                              │
    └───────────────────────────────┬─────────────────────────────────────┘
                                    │ Cache miss
                                    ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │                         API Gateway                                  │
    │                    (Authentication, Routing)                         │
    └───────────────────────────────┬─────────────────────────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
           ▼                        ▼                        ▼
    ┌────────────┐          ┌────────────┐          ┌────────────┐
    │  Upload    │          │  Streaming │          │  Metadata  │
    │  Service   │          │  Service   │          │  Service   │
    │            │          │            │          │            │
    │- Chunked   │          │- Manifest  │          │- Search    │
    │  upload    │          │  generation│          │- Comments  │
    │- Validation│          │- ABR       │          │- Channels  │
    └─────┬──────┘          └─────┬──────┘          └─────┬──────┘
          │                       │                       │
          ▼                       ▼                       ▼
    ┌────────────┐          ┌────────────┐          ┌────────────┐
    │  Message   │          │   Object   │          │ PostgreSQL │
    │  Queue     │          │  Storage   │          │            │
    │  (Kafka)   │          │   (S3)     │          │- Video meta│
    │            │          │            │          │- Users     │
    │- Transcode │          │- Raw video │          │- Comments  │
    │  jobs      │          │- Transcoded│          │            │
    └─────┬──────┘          │- Thumbnails│          └────────────┘
          │                 └────────────┘
          ▼                                         ┌────────────┐
    ┌────────────┐                                  │   Redis    │
    │ Transcoding│                                  │            │
    │  Workers   │                                  │- Sessions  │
    │            │                                  │- View count│
    │- FFmpeg    │                                  │- Cache     │
    │- Multiple  │                                  └────────────┘
    │  resolutions│
    └────────────┘                                  ┌────────────┐
                                                    │Elasticsearch│
                                                    │            │
                                                    │- Video     │
                                                    │  search    │
                                                    └────────────┘
```

### Core Components

**1. Upload Service**
- Handles chunked file uploads (resumable)
- Validates file format and size
- Stores raw video to object storage
- Publishes transcoding job to queue

**2. Transcoding Pipeline**
- Consumes jobs from Kafka
- Converts video to multiple resolutions (1080p, 720p, 480p, 360p)
- Generates HLS/DASH segments
- Creates thumbnails
- Updates video status to "ready"

**3. Streaming Service**
- Generates manifests (m3u8/mpd)
- Handles adaptive bitrate selection
- Tracks playback progress
- Integrates with CDN for delivery

**4. Content Delivery Network**
- Caches video segments at edge locations
- Reduces origin load
- Provides low-latency playback globally

**5. Recommendation Service**
- Generates personalized video suggestions
- Handles trending videos
- Powers the home feed

---

## 4. Deep Dive: Video Upload and Transcoding (7-8 minutes)

### Chunked Upload for Large Files

```javascript
// Client-side: split file into chunks
async function uploadVideo(file) {
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // 1. Initialize upload
  const { uploadId } = await api.post('/uploads/init', {
    filename: file.name,
    fileSize: file.size,
    contentType: file.type
  });

  // 2. Upload chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    await api.put(`/uploads/${uploadId}/chunks/${i}`, chunk, {
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  }

  // 3. Complete upload
  const { videoId } = await api.post(`/uploads/${uploadId}/complete`);
  return videoId;
}
```

### Server-Side Upload Handling

```javascript
async function completeUpload(uploadId) {
  // 1. Verify all chunks received
  const chunks = await redis.lrange(`upload:${uploadId}:chunks`, 0, -1);

  // 2. Assemble chunks in object storage
  await s3.completeMultipartUpload({
    Bucket: 'raw-videos',
    Key: uploadId,
    UploadId: s3UploadId,
    MultipartUpload: { Parts: chunks }
  });

  // 3. Create video record
  const video = await db.videos.create({
    id: generateVideoId(),
    uploadId,
    status: 'processing',
    createdAt: new Date()
  });

  // 4. Queue transcoding job
  await kafka.produce('transcoding-jobs', {
    videoId: video.id,
    sourceKey: uploadId,
    requestedResolutions: ['1080p', '720p', '480p', '360p']
  });

  return video;
}
```

### Transcoding Pipeline

```python
# Transcoding worker
async def process_video(job):
    video_id = job['videoId']
    source_key = job['sourceKey']

    # 1. Download raw video
    local_path = await download_from_s3(source_key)

    # 2. Extract video metadata
    metadata = ffprobe(local_path)

    # 3. Transcode to each resolution
    for resolution in job['requestedResolutions']:
        if resolution_fits(metadata, resolution):
            output_path = transcode(local_path, resolution)

            # 4. Create HLS segments
            segments = create_hls_segments(output_path)

            # 5. Upload segments to S3
            for segment in segments:
                await upload_to_s3(
                    f'videos/{video_id}/{resolution}/{segment.name}',
                    segment.data
                )

    # 6. Generate thumbnails
    thumbnails = generate_thumbnails(local_path, count=3)
    for i, thumb in enumerate(thumbnails):
        await upload_to_s3(f'thumbnails/{video_id}/{i}.jpg', thumb)

    # 7. Update video status
    await db.videos.update(video_id, {
        'status': 'ready',
        'duration': metadata.duration,
        'resolutions': completed_resolutions
    })

def transcode(input_path, resolution):
    # FFmpeg transcoding
    resolutions = {
        '1080p': {'width': 1920, 'height': 1080, 'bitrate': '5000k'},
        '720p': {'width': 1280, 'height': 720, 'bitrate': '2500k'},
        '480p': {'width': 854, 'height': 480, 'bitrate': '1000k'},
        '360p': {'width': 640, 'height': 360, 'bitrate': '500k'}
    }

    r = resolutions[resolution]
    output_path = f'/tmp/{resolution}.mp4'

    subprocess.run([
        'ffmpeg', '-i', input_path,
        '-vf', f'scale={r["width"]}:{r["height"]}',
        '-b:v', r['bitrate'],
        '-c:v', 'libx264', '-preset', 'medium',
        '-c:a', 'aac', '-b:a', '128k',
        output_path
    ])

    return output_path
```

### HLS Segment Generation

```bash
# Create HLS playlist and segments
ffmpeg -i input.mp4 \
  -c:v libx264 -c:a aac \
  -hls_time 4 \
  -hls_segment_filename 'segment_%03d.ts' \
  -hls_playlist_type vod \
  playlist.m3u8
```

---

## 5. Deep Dive: Video Streaming and Adaptive Bitrate (6-7 minutes)

### HLS Manifest Structure

```
# Master playlist (points to quality-specific playlists)
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
# Quality-specific playlist (1080p/playlist.m3u8)
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD

#EXTINF:4.000,
segment_000.ts
#EXTINF:4.000,
segment_001.ts
#EXTINF:4.000,
segment_002.ts
...
#EXT-X-ENDLIST
```

### Adaptive Bitrate Selection

The client player handles ABR:

```javascript
// Simplified ABR algorithm
class AdaptiveBitrateController {
  constructor(qualityLevels) {
    this.levels = qualityLevels; // Sorted by bandwidth
    this.currentLevel = 0;
    this.bandwidthHistory = [];
  }

  measureBandwidth(segmentBytes, downloadTimeMs) {
    const bandwidth = (segmentBytes * 8) / (downloadTimeMs / 1000);
    this.bandwidthHistory.push(bandwidth);

    // Keep last 5 measurements
    if (this.bandwidthHistory.length > 5) {
      this.bandwidthHistory.shift();
    }
  }

  selectLevel() {
    const avgBandwidth = average(this.bandwidthHistory);
    const safetyFactor = 0.8; // Use 80% of measured bandwidth

    // Find highest quality that fits
    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (this.levels[i].bandwidth <= avgBandwidth * safetyFactor) {
        return i;
      }
    }

    return 0; // Fallback to lowest
  }
}
```

### CDN Caching Strategy

```
CDN Edge
    │
    ├── Cache HIT → Return video segment
    │
    └── Cache MISS
            │
            ├── Check Regional Cache
            │       │
            │       ├── HIT → Return + cache at edge
            │       │
            │       └── MISS → Fetch from Origin
            │
            └── Origin (S3)
                    │
                    └── Return + cache at regional + edge
```

Cache tiers:
- **Edge (POP)**: Most popular content, short TTL (1 hour)
- **Regional**: Less popular, longer TTL (24 hours)
- **Origin (S3)**: All content, permanent

---

## 6. Deep Dive: Recommendation System (5-6 minutes)

### Recommendation Signals

```javascript
const recommendationSignals = {
  // User behavior
  watchHistory: 'videos user has watched',
  watchTime: 'how much of each video was watched',
  likes: 'explicit positive signal',
  subscriptions: 'channels user follows',
  searches: 'what user searched for',

  // Video metadata
  categories: 'video categories',
  tags: 'creator-added tags',
  title: 'video title for similarity',

  // Engagement metrics
  viewCount: 'popularity signal',
  averageWatchPercentage: 'quality signal',
  likeRatio: 'audience satisfaction'
};
```

### Collaborative Filtering

```python
# Users who watched video A also watched video B
def collaborative_recommendations(user_id, limit=20):
    # Get user's watch history
    watched = get_watch_history(user_id)

    # Find similar users (users who watched same videos)
    similar_users = find_similar_users(watched)

    # Get videos those users watched that current user hasn't
    candidates = {}
    for similar_user in similar_users:
        their_videos = get_watch_history(similar_user.id)
        for video in their_videos:
            if video not in watched:
                if video not in candidates:
                    candidates[video] = 0
                candidates[video] += similar_user.similarity_score

    # Return top candidates
    sorted_candidates = sorted(candidates.items(), key=lambda x: x[1], reverse=True)
    return [video_id for video_id, score in sorted_candidates[:limit]]
```

### Content-Based Filtering

```python
def content_based_recommendations(user_id, limit=20):
    # Get user's preferences
    liked_videos = get_liked_videos(user_id)
    watch_history = get_watch_history(user_id, with_completion=True)

    # Extract preferred categories/tags
    category_weights = defaultdict(float)
    for video in liked_videos + watch_history:
        completion_weight = video.completion_percentage if hasattr(video, 'completion_percentage') else 1.0
        for category in video.categories:
            category_weights[category] += completion_weight

    # Find videos in preferred categories
    candidates = search_by_categories(
        categories=list(category_weights.keys()),
        exclude=watched_ids,
        limit=limit * 3
    )

    # Score and rank
    scored = []
    for video in candidates:
        score = sum(category_weights[c] for c in video.categories)
        score *= video.engagement_score  # Boost quality content
        scored.append((video, score))

    scored.sort(key=lambda x: x[1], reverse=True)
    return [video for video, score in scored[:limit]]
```

### Real-Time Ranking

```python
def rank_home_feed(user_id):
    # Get candidates from multiple sources
    collaborative = collaborative_recommendations(user_id, 50)
    content_based = content_based_recommendations(user_id, 50)
    trending = get_trending_videos(50)
    subscriptions = get_recent_from_subscriptions(user_id, 50)

    # Merge and dedupe
    all_candidates = list(set(collaborative + content_based + trending + subscriptions))

    # Score each candidate
    scores = {}
    for video_id in all_candidates:
        video = get_video(video_id)
        score = 0

        # Source weights
        if video_id in subscriptions: score += 100  # Subscribed channels first
        if video_id in trending: score += 20
        if video_id in collaborative: score += 50

        # Quality signals
        score += video.engagement_score * 30

        # Freshness
        age_hours = (now - video.published_at).total_seconds() / 3600
        score *= math.exp(-age_hours / 48)  # Decay over 48 hours

        scores[video_id] = score

    # Return top scored
    sorted_videos = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [video_id for video_id, score in sorted_videos[:50]]
```

---

## 7. Data Model (3-4 minutes)

### PostgreSQL Schema

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY,
    username VARCHAR(50) UNIQUE,
    email VARCHAR(255) UNIQUE,
    channel_name VARCHAR(100),
    subscriber_count BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE videos (
    id VARCHAR(11) PRIMARY KEY,  -- YouTube-style short ID
    channel_id UUID REFERENCES users(id),
    title VARCHAR(100) NOT NULL,
    description TEXT,
    duration_seconds INTEGER,
    status VARCHAR(20),  -- processing, ready, blocked
    view_count BIGINT DEFAULT 0,
    like_count BIGINT DEFAULT 0,
    dislike_count BIGINT DEFAULT 0,
    comment_count BIGINT DEFAULT 0,
    categories TEXT[],
    tags TEXT[],
    thumbnail_url TEXT,
    published_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_videos_channel ON videos(channel_id, published_at DESC);
CREATE INDEX idx_videos_published ON videos(published_at DESC);

CREATE TABLE video_resolutions (
    video_id VARCHAR(11) REFERENCES videos(id),
    resolution VARCHAR(10),  -- '1080p', '720p', etc.
    manifest_url TEXT,
    bitrate INTEGER,
    PRIMARY KEY (video_id, resolution)
);

CREATE TABLE comments (
    id UUID PRIMARY KEY,
    video_id VARCHAR(11) REFERENCES videos(id),
    user_id UUID REFERENCES users(id),
    parent_id UUID REFERENCES comments(id),
    text TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_video ON comments(video_id, created_at DESC);

CREATE TABLE subscriptions (
    subscriber_id UUID REFERENCES users(id),
    channel_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (subscriber_id, channel_id)
);
```

### Redis Cache

```
# View count buffer (batch update to DB)
video_views:{video_id} -> count (INCR, flush every minute)

# User session
session:{session_id} -> user_data

# Trending videos (sorted set)
trending:global -> ZSET { video_id: score }
trending:{category} -> ZSET { video_id: score }

# Video metadata cache
video:{video_id} -> JSON { title, views, etc. }
```

---

## 8. Trade-offs and Alternatives (4-5 minutes)

### Storage

| Option | Pros | Cons |
|--------|------|------|
| S3 | Scalable, cheap, durable | Latency, need CDN |
| GCS | Similar to S3 | Vendor lock-in |
| Custom Storage | Control | Complex to operate |

**Decision**: S3 with multi-region replication, CDN for delivery

### Video Format

| Option | Pros | Cons |
|--------|------|------|
| HLS | Wide support, adaptive | Apple-originated |
| DASH | Open standard | Slightly less support |
| Both | Maximum compatibility | Double storage |

**Decision**: HLS as primary, DASH for specific clients

### Recommendation Approach

| Option | Pros | Cons |
|--------|------|------|
| Collaborative filtering | Works with limited data | Cold start problem |
| Content-based | No cold start for items | Narrow recommendations |
| Deep learning | Best accuracy | Expensive, complex |

**Decision**: Hybrid approach with deep learning for high-traffic

---

## 9. Handling Scale Challenges (3-4 minutes)

### Popular Video Handling (Hot Spots)

```javascript
// Problem: Viral video gets millions of views per minute

// Solution 1: Multi-tier caching
// Edge CDN → Regional CDN → Origin Shield → S3

// Solution 2: Pre-warm popular content
async function prewarmVideo(videoId) {
  const edgeLocations = getEdgeLocations();
  for (const edge of edgeLocations) {
    await edge.prefetch(`/videos/${videoId}/`);
  }
}

// Solution 3: View count batching
// Don't update DB on every view
async function recordView(videoId) {
  await redis.incr(`views:${videoId}`);
}

// Background job flushes to DB every minute
async function flushViewCounts() {
  const keys = await redis.keys('views:*');
  for (const key of keys) {
    const videoId = key.split(':')[1];
    const count = await redis.getset(key, 0);
    await db.query(
      'UPDATE videos SET view_count = view_count + $1 WHERE id = $2',
      [count, videoId]
    );
  }
}
```

### Transcoding Scalability

```yaml
# Kubernetes auto-scaling for transcoding workers
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: transcoder
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: transcoder
  minReplicas: 10
  maxReplicas: 500
  metrics:
  - type: External
    external:
      metric:
        name: kafka_consumer_lag
      target:
        type: Value
        value: 100
```

---

## 10. Monitoring (2 minutes)

Key metrics:
- **Upload success rate**: Percentage of uploads that complete
- **Transcoding latency**: Time from upload to video ready
- **Playback start time**: Time to first frame
- **Buffering rate**: Percentage of playback time spent buffering
- **CDN cache hit rate**: Efficiency of edge caching

Alerts:
- Transcoding queue depth > threshold
- Playback error rate > 1%
- CDN origin load spikes

---

## Summary

The key insights for YouTube's design are:

1. **Chunked upload for reliability**: Large files need resumable uploads

2. **Async transcoding pipeline**: Decouple upload from processing with message queues

3. **HLS for adaptive streaming**: Client-side quality selection based on bandwidth

4. **Multi-tier CDN**: Edge, regional, and origin caching for global delivery

5. **Hybrid recommendations**: Combine collaborative and content-based for quality suggestions

6. **Batched view counting**: Buffer view counts in Redis, flush to database periodically

The system handles 500 hours of video per minute through horizontal scaling of stateless services, massive object storage, and a global CDN network.

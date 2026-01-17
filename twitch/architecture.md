# Design Twitch - Architecture

## System Overview

Twitch is a live streaming platform with real-time chat. Core challenges involve low-latency video delivery, chat at massive scale, and stream processing in real-time.

**Learning Goals:**
- Understand live video streaming protocols (RTMP, HLS)
- Design real-time chat systems at scale
- Handle stream transcoding pipelines
- Build subscription and monetization systems

---

## Requirements

### Functional Requirements

1. **Stream**: Broadcast live video to viewers
2. **Watch**: View streams with low latency
3. **Chat**: Real-time messaging during streams
4. **Subscribe**: Paid subscriptions to channels
5. **VOD**: Watch past broadcasts and clips

### Non-Functional Requirements

- **Latency**: < 5 seconds glass-to-glass (broadcast to viewer)
- **Scale**: 10M concurrent viewers, 100K concurrent streams
- **Chat**: 1M messages/minute during peak
- **Availability**: 99.99% for video delivery

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Broadcaster Layer                            │
│              OBS / Streamlabs (RTMP output)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ RTMP
┌─────────────────────────────────────────────────────────────────┐
│                    Ingest Layer                                 │
│    Multiple ingest servers globally (rtmp://ingest.twitch.tv)   │
│    - Authenticate stream key                                    │
│    - Forward to transcoder                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Transcoding Layer                              │
│    FFmpeg/MediaLive clusters                                    │
│    - Source → 1080p60, 720p60, 720p30, 480p, 360p               │
│    - Generate HLS segments (2-4 second chunks)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Origin Layer                                  │
│    - Store HLS manifests (.m3u8) and segments (.ts)             │
│    - Serve to CDN edge nodes                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CDN Edge Layer                              │
│    CloudFront / Fastly / Custom CDN                             │
│    - Cache segments at edge                                     │
│    - Serve to viewers globally                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Viewer Layer                                │
│    Browser (HLS.js) / Mobile / TV apps                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Stream Ingestion

**RTMP Server:**
```javascript
// Simplified RTMP server concept
const rtmpServer = new RTMPServer()

rtmpServer.on('connect', (session) => {
  const { streamKey } = session.connectCmdObj
  const channel = await validateStreamKey(streamKey)

  if (!channel) {
    session.reject()
    return
  }

  session.channelId = channel.id
  await notifyStreamStart(channel.id)
})

rtmpServer.on('publish', (session) => {
  // Forward to transcoder
  const transcoderUrl = assignTranscoder(session.channelId)
  session.pipe(transcoderUrl)
})
```

### 2. Transcoding

**FFmpeg Pipeline:**
```bash
# Transcode to multiple qualities
ffmpeg -i rtmp://input \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast -b:v 6000k -s 1920x1080 -f hls output_1080p.m3u8 \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast -b:v 3000k -s 1280x720 -f hls output_720p.m3u8 \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast -b:v 1500k -s 854x480 -f hls output_480p.m3u8
```

**HLS Manifest:**
```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480
480p/playlist.m3u8
```

### 3. Chat System

**Challenge**: Handle 100K+ concurrent users in a single chat room

**Architecture:**
```
┌─────────────────────────────────────────────────────────────────┐
│                    Chat Service Cluster                         │
├─────────────┬─────────────┬─────────────┬─────────────┬─────────┤
│  Chat Pod 1 │  Chat Pod 2 │  Chat Pod 3 │  Chat Pod N │   ...   │
│ (WS conns)  │ (WS conns)  │ (WS conns)  │ (WS conns)  │         │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Message Broker (Kafka/Valkey Pub/Sub)        │
│              channel:123 → all pods subscribed                  │
└─────────────────────────────────────────────────────────────────┘
```

**Message Flow:**
```javascript
// User sends message
async function handleChatMessage(userId, channelId, message) {
  // Validate user can chat (not banned, not slow mode limited)
  const canChat = await validateChat(userId, channelId)
  if (!canChat) return

  const chatMessage = {
    id: uuid(),
    userId,
    channelId,
    username: await getUsername(userId),
    message,
    badges: await getBadges(userId, channelId),
    timestamp: Date.now()
  }

  // Publish to all chat pods
  await redis.publish(`chat:${channelId}`, JSON.stringify(chatMessage))

  // Store for moderation/replay (optional)
  await storeChatMessage(chatMessage)
}

// Each pod receives and broadcasts to connected clients
redis.subscribe(`chat:${channelId}`)
redis.on('message', (channel, data) => {
  const message = JSON.parse(data)
  broadcastToRoom(channel, message)
})
```

### 4. VOD Recording

**Parallel Recording During Live:**
```javascript
// As transcoder outputs segments, also write to storage
async function handleSegment(channelId, segment) {
  // 1. Send to CDN for live viewers
  await cdn.uploadSegment(segment)

  // 2. Archive for VOD
  await s3.putObject({
    bucket: 'vods',
    key: `${channelId}/${streamId}/${segment.sequence}.ts`,
    body: segment.data
  })

  // 3. Update VOD manifest
  await updateVodManifest(channelId, streamId, segment)
}
```

---

## Database Schema

```sql
-- Channels
CREATE TABLE channels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  name VARCHAR(100) UNIQUE NOT NULL,
  stream_key VARCHAR(100) UNIQUE NOT NULL,
  title VARCHAR(200),
  category_id INTEGER REFERENCES categories(id),
  follower_count INTEGER DEFAULT 0,
  subscriber_count INTEGER DEFAULT 0,
  is_live BOOLEAN DEFAULT FALSE,
  current_viewers INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Streams (each broadcast)
CREATE TABLE streams (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id),
  title VARCHAR(200),
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  peak_viewers INTEGER DEFAULT 0,
  total_views INTEGER DEFAULT 0,
  vod_url VARCHAR(500)
);

-- Subscriptions
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  channel_id INTEGER REFERENCES channels(id),
  tier INTEGER DEFAULT 1, -- 1, 2, or 3
  started_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  is_gift BOOLEAN DEFAULT FALSE,
  gifted_by INTEGER REFERENCES users(id)
);

-- Chat messages (for moderation, not primary storage)
CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id),
  user_id INTEGER REFERENCES users(id),
  message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Bans
CREATE TABLE channel_bans (
  channel_id INTEGER REFERENCES channels(id),
  user_id INTEGER REFERENCES users(id),
  banned_by INTEGER REFERENCES users(id),
  reason TEXT,
  expires_at TIMESTAMP, -- NULL = permanent
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);
```

---

## Key Design Decisions

### 1. HLS over WebRTC

**Decision**: Use HLS for video delivery, not WebRTC

**Rationale**:
- WebRTC: Lower latency (~1s) but complex at scale
- HLS: Higher latency (~5s) but simple CDN distribution
- Trade-off: Accept 5s latency for simplicity

**When to use WebRTC**: Interactive streams (co-streaming, gaming)

### 2. Kafka for Chat Fan-Out

**Decision**: Pub/sub for chat message distribution

**Rationale**:
- Decouples message producers from consumers
- Horizontal scaling of chat pods
- Message ordering per channel

### 3. Segment-Based VOD

**Decision**: Store VOD as HLS segments during live

**Rationale**:
- No post-processing needed
- Instant VOD availability
- Same format for live and VOD

---

## Scalability Considerations

### Viewer Scaling

- CDN caches segments at edge
- No origin hit for popular streams
- Cache hit ratio > 99% for live streams

### Chat Scaling

- Partition chat pods by channel_id
- Large channels: Multiple pods per channel
- Rate limiting per user (1 message/second)

### Stream Processing

- Transcoder per stream (not shared)
- Horizontal scaling: Add transcoders as needed
- Stateless transcoders, state in message queue

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Video protocol | HLS | WebRTC | Scalability |
| Chat transport | WebSocket + Pub/Sub | HTTP polling | Low latency |
| VOD storage | Segment archive | Re-encode | Instant availability |
| Transcoding | Per-stream workers | Shared | Isolation |

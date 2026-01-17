# System Design Interview: Twitch - Live Streaming Platform

## Opening Statement

"Today I'll design a live streaming platform like Twitch, focusing on the core challenges of low-latency video delivery to millions of viewers, real-time chat at massive scale, and stream monetization. The key technical problems are building a video pipeline from broadcaster to viewer with under 5 seconds latency, handling chat rooms with 100K+ concurrent users, and recording live streams for VOD playback."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Stream**: Broadcasters publish live video to viewers
2. **Watch**: Viewers watch streams with low latency
3. **Chat**: Real-time messaging during streams
4. **Subscribe**: Paid channel subscriptions and donations
5. **VOD**: Watch past broadcasts and create clips

### Non-Functional Requirements

- **Latency**: < 5 seconds glass-to-glass (camera to viewer screen)
- **Scale**: 10 million concurrent viewers, 100K concurrent streams
- **Chat**: 1 million messages per minute during peak
- **Availability**: 99.99% for video delivery

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Concurrent Viewers | 10M |
| Concurrent Streams | 100K |
| Average Bitrate | 4 Mbps |
| Peak Chat Messages | 1M/min |
| VOD Storage/Day | 500TB |

---

## Step 2: High-Level Architecture (8 minutes)

### Video Pipeline Architecture

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

### Why This Layered Approach?

**Ingest Separation**: Ingest servers are globally distributed so broadcasters connect to nearby servers, reducing upload latency.

**Transcoding Layer**: Each stream needs its own transcoder - we can't share because streams are continuous. Horizontal scaling is straightforward.

**CDN is Essential**: With 10M viewers, direct delivery is impossible. CDN edge caching means each segment is fetched from origin once, then served from cache.

---

## Step 3: Stream Ingestion Deep Dive (8 minutes)

### RTMP Server Flow

```javascript
const rtmpServer = new RTMPServer()

rtmpServer.on('connect', async (session) => {
  const { streamKey } = session.connectCmdObj

  // Validate stream key against database
  const channel = await validateStreamKey(streamKey)

  if (!channel) {
    session.reject()
    return
  }

  session.channelId = channel.id
  await notifyStreamStart(channel.id)
})

rtmpServer.on('publish', (session) => {
  // Assign a transcoder for this stream
  const transcoderUrl = assignTranscoder(session.channelId)

  // Pipe RTMP stream to transcoder
  session.pipe(transcoderUrl)
})
```

### Why RTMP for Ingest?

- **Low latency**: RTMP is designed for real-time streaming
- **Widely supported**: OBS, Streamlabs, and all major software support it
- **Reliable**: TCP-based, handles packet loss
- **Alternative consideration**: SRT (Secure Reliable Transport) for even lower latency

### Transcoding Pipeline

```bash
# FFmpeg command for multi-quality output
ffmpeg -i rtmp://input \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast \
    -b:v 6000k -s 1920x1080 -f hls output_1080p.m3u8 \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast \
    -b:v 3000k -s 1280x720 -f hls output_720p.m3u8 \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast \
    -b:v 1500k -s 854x480 -f hls output_480p.m3u8
```

**HLS Output Structure:**
```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480
480p/playlist.m3u8
```

---

## Step 4: Chat System Deep Dive (10 minutes)

This is one of the hardest scaling challenges. A single channel might have 100K+ users chatting simultaneously.

### Chat Architecture

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

### Message Flow

```javascript
// User sends a message
async function handleChatMessage(userId, channelId, message) {
  // 1. Validate user can chat
  const canChat = await validateChat(userId, channelId)
  if (!canChat.allowed) {
    return { error: canChat.reason } // banned, slow mode, etc.
  }

  // 2. Build chat message
  const chatMessage = {
    id: uuid(),
    userId,
    channelId,
    username: await getUsername(userId),
    message,
    badges: await getBadges(userId, channelId), // subscriber, mod, etc.
    timestamp: Date.now()
  }

  // 3. Publish to all chat pods via pub/sub
  await redis.publish(`chat:${channelId}`, JSON.stringify(chatMessage))

  // 4. Optional: Store for moderation replay
  await storeChatMessage(chatMessage)
}

// Each chat pod subscribes and broadcasts to its connected clients
redis.subscribe(`chat:${channelId}`)
redis.on('message', (channel, data) => {
  const message = JSON.parse(data)
  broadcastToRoom(channel, message)
})
```

### Why Pub/Sub for Chat?

- **Fan-out**: One message needs to reach 100K+ users across many pods
- **Decoupling**: Sender doesn't need to know about all receivers
- **Horizontal scaling**: Add more chat pods as viewers grow

### Rate Limiting Strategies

| Mode | Limit | Use Case |
|------|-------|----------|
| Normal | 1 msg/sec | Default for all users |
| Slow Mode | 5-30 sec | High-volume channels |
| Subscribers Only | N/A | Reduce spam during events |
| Follower Mode | 10min+ | Only followers can chat |

```javascript
async function checkRateLimit(userId, channelId) {
  const key = `ratelimit:${channelId}:${userId}`
  const lastMessage = await redis.get(key)

  const channel = await getChannel(channelId)
  const cooldown = channel.slowModeSeconds || 1

  if (lastMessage && (Date.now() - lastMessage) < cooldown * 1000) {
    return { allowed: false, waitSeconds: cooldown }
  }

  await redis.set(key, Date.now(), 'EX', cooldown)
  return { allowed: true }
}
```

---

## Step 5: VOD Recording (5 minutes)

VODs should be available immediately after stream ends - no post-processing delay.

### Recording During Live Stream

```javascript
// As transcoder outputs HLS segments, also archive them
async function handleSegment(channelId, streamId, segment) {
  // 1. Send to CDN for live viewers (primary path)
  await cdn.uploadSegment(segment)

  // 2. Archive for VOD (parallel)
  await s3.putObject({
    bucket: 'vods',
    key: `${channelId}/${streamId}/${segment.sequence}.ts`,
    body: segment.data
  })

  // 3. Update VOD manifest
  await appendToVodManifest(channelId, streamId, segment)
}
```

### Why Record Segments Directly?

- **Instant VOD**: No post-processing needed after stream ends
- **Same format**: Live and VOD use identical HLS segments
- **Efficient**: Just copy bytes, no re-encoding

---

## Step 6: Database Schema (3 minutes)

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

-- Each broadcast session
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

-- Paid subscriptions
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  channel_id INTEGER REFERENCES channels(id),
  tier INTEGER DEFAULT 1, -- Tier 1, 2, or 3
  started_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  is_gift BOOLEAN DEFAULT FALSE,
  gifted_by INTEGER REFERENCES users(id)
);

-- Chat messages (partitioned for scale)
CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id),
  user_id INTEGER REFERENCES users(id),
  message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);
```

---

## Step 7: Key Design Decisions & Trade-offs (5 minutes)

### Decision 1: HLS over WebRTC

**Options:**
- **WebRTC**: ~1 second latency, peer-to-peer capable
- **HLS**: ~5 second latency, CDN-friendly

**Choice**: HLS

**Rationale**:
- WebRTC is extremely complex to scale to millions
- HLS works perfectly with CDN infrastructure
- 5 seconds is acceptable for most streams
- Would use WebRTC for co-streaming or interactive features only

### Decision 2: Kafka for Chat Fan-Out

**Options:**
- Direct WebSocket broadcast
- Redis Pub/Sub
- Kafka

**Choice**: Kafka (or Redis Pub/Sub for simpler deployments)

**Rationale**:
- Decouples message producers from consumers
- Handles backpressure gracefully
- Enables message replay for moderation

### Decision 3: Per-Stream Transcoders

**Options:**
- Shared transcoder pool
- Dedicated transcoder per stream

**Choice**: Dedicated transcoder per stream

**Rationale**:
- Isolation: One bad stream doesn't affect others
- Predictable resources: Know exactly what each stream needs
- Simpler debugging: Issues isolated to single stream

---

## Step 8: Latency Breakdown & Optimization (3 minutes)

### Glass-to-Glass Latency Sources

| Stage | Typical Latency | Optimization |
|-------|-----------------|--------------|
| Capture + Encode | 500ms | Fast encoder presets |
| Upload (RTMP) | 500ms | Regional ingest servers |
| Transcoding | 1s | Shorter segments |
| CDN Propagation | 1s | Edge push vs pull |
| Player Buffer | 2s | Reduce buffer (risky) |
| **Total** | **5 seconds** | |

### Low-Latency HLS (LL-HLS)

For sub-3-second latency:
- Partial segments (push parts before complete)
- Reduced player buffer
- Edge push (don't wait for request)
- Trade-off: More infrastructure complexity, potential for stuttering

---

## Step 9: Scaling Considerations (2 minutes)

### Viewer Scaling
- CDN handles 99%+ of video requests
- Popular streams have > 99.9% cache hit ratio
- Only origin hit is once per segment per edge location

### Chat Scaling
- Partition chat pods by channel_id
- Large channels (100K+) get multiple dedicated pods
- Rate limiting prevents abuse

### Stream Processing
- 100K concurrent streams = 100K transcoders
- Each transcoder ~2 vCPU, 4GB RAM
- Cloud auto-scaling based on stream count

---

## Closing Summary

I've designed a live streaming platform with three core systems:

1. **Video Pipeline**: RTMP ingest to global servers, real-time transcoding to multiple qualities, HLS segment distribution via CDN for sub-5-second latency

2. **Chat System**: Horizontally scaled chat pods with pub/sub fan-out, supporting 100K+ users per channel with rate limiting and moderation

3. **VOD Recording**: Parallel archival during live streaming for instant VOD availability without post-processing

**Key trade-offs:**
- HLS over WebRTC (scalability vs. latency)
- Per-stream transcoders (isolation vs. resource efficiency)
- Segment-based VOD (simplicity vs. storage optimization)

**What would I add with more time?**
- Clip creation system (extract segments + metadata)
- Live rewind (buffer last N minutes for viewers)
- Prediction market for viewer engagement

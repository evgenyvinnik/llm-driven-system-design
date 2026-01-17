# Design Twitch - Development with Claude

## Project Context

Building a live streaming platform to understand real-time video delivery, chat at scale, and subscription systems.

**Key Learning Goals:**
- Design live video streaming pipelines
- Build real-time chat for massive audiences
- Understand HLS/DASH streaming protocols
- Handle VOD recording during live streams

---

## Key Challenges to Explore

### 1. Low-Latency Streaming

**Glass-to-Glass Latency Sources:**
1. Capture → Encode (broadcaster): ~500ms
2. Upload (RTMP): ~500ms
3. Transcoding: ~1s
4. CDN propagation: ~1s
5. Player buffer: ~2s

**Total**: ~5 seconds typical

**Reducing Latency:**
- Shorter HLS segments (2s vs 6s)
- LL-HLS (Low-Latency HLS)
- Edge push vs pull
- Reduced player buffer

### 2. Chat at Scale

**Problem**: 100K+ users chatting simultaneously

**Solution Architecture:**
```
Users ──▶ Load Balancer ──▶ Chat Pods (horizontal)
                               │
                               ▼
                          Kafka/Valkey
                          (fan-out)
                               │
                               ▼
                          All Pods receive
```

**Rate Limiting:**
- Normal users: 1 msg/sec
- Slow mode: Configurable (5s, 30s, etc.)
- Subscribers: Faster rates

### 3. Stream Authentication

**Stream Key Flow:**
```
1. Streamer gets stream key from dashboard
2. OBS sends RTMP connect with stream key
3. Ingest server validates key against database
4. If valid, accept stream and start pipeline
5. If invalid, reject connection
```

---

## Development Phases

### Phase 1: Foundation (Completed)
- [x] Project structure setup
- [x] Docker compose with PostgreSQL and Redis
- [x] Database schema design
- [x] Backend API scaffolding
- [x] Frontend scaffolding with Vite + React + TypeScript

### Phase 2: Core Features (In Progress)
- [x] User authentication (session-based)
- [x] Channel management APIs
- [x] Category browsing
- [x] Real-time chat with WebSocket
- [x] Redis pub/sub for cross-instance chat
- [x] Follow/Subscribe system
- [x] Video player UI (simulated)
- [x] Stream simulation (start/stop via API)
- [x] Creator dashboard
- [ ] Actual RTMP ingest (requires nginx-rtmp)
- [ ] HLS transcoding with FFmpeg

### Phase 3: Chat System (Completed)
- [x] WebSocket connections
- [x] Pub/sub message distribution via Redis
- [x] Emotes picker and rendering
- [x] User badges (subscriber, mod, admin)
- [x] Rate limiting per user/channel
- [ ] Moderation tools (ban, timeout)
- [ ] Slow mode configuration

### Phase 4: Channel Features (Mostly Complete)
- [x] Stream key management
- [x] Go live / offline events (simulated)
- [x] Viewer counts
- [x] Follows and subscriptions
- [ ] Push notifications

### Phase 5: VOD (Pending)
- [ ] Segment archival during live
- [ ] VOD manifest generation
- [ ] Clip creation

---

## Implementation Notes

### Chat Architecture Decisions

**Chosen: Redis Pub/Sub**
- Simple to set up and operate
- Low latency message delivery
- Good enough for learning purposes
- Production alternative: Kafka for durability and replay

**WebSocket per Channel:**
- Each chat pod subscribes to `chat:{channelId}` in Redis
- Messages published to Redis, then fanned out to all pods
- Client joins channel room on WebSocket connection

### Stream Simulation

Since implementing actual RTMP ingest requires additional infrastructure (nginx-rtmp, FFmpeg), we simulate streams:

1. Users can "start stream" from dashboard
2. Backend marks channel as live
3. Viewer counts fluctuate automatically
4. Video player shows placeholder with channel info
5. Chat works exactly as in production

To add real streaming later:
1. Add nginx-rtmp module for RTMP ingest
2. Use FFmpeg for transcoding to HLS
3. Serve HLS segments from backend or CDN
4. Update VideoPlayer to use HLS.js

### Database Considerations

**Chat Message Storage:**
- Messages stored for moderation/history
- In production, partition by time for performance
- Consider TTL for old messages
- Current implementation stores all messages

**Viewer Count:**
- Stored in Redis for fast access
- Updated periodically by stream simulator
- In production: based on actual connections

---

## What Would Be Different in Production

1. **Video Pipeline:**
   - RTMP ingest servers globally distributed
   - Real-time transcoding with GPU acceleration
   - CDN for segment delivery
   - Low-latency HLS (LL-HLS)

2. **Chat:**
   - Kafka instead of Redis for message durability
   - Multiple chat pod clusters per region
   - Advanced rate limiting and spam detection
   - Machine learning for moderation

3. **Infrastructure:**
   - Kubernetes for orchestration
   - Auto-scaling based on viewer count
   - Multi-region deployment
   - Edge computing for low latency

---

## Resources

- [HLS Specification](https://developer.apple.com/streaming/)
- [Low-Latency HLS](https://developer.apple.com/documentation/http_live_streaming/enabling_low-latency_http_live_streaming_ll-hls)
- [FFmpeg Streaming Guide](https://trac.ffmpeg.org/wiki/StreamingGuide)
- [Twitch Engineering Blog](https://blog.twitch.tv/en/tags/engineering/)
- [nginx-rtmp-module](https://github.com/arut/nginx-rtmp-module)

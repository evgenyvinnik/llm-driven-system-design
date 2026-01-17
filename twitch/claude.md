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

### Phase 1: Basic Streaming
- [ ] RTMP ingest server
- [ ] Single-quality output
- [ ] HLS segment generation
- [ ] Basic playback

### Phase 2: Multi-Quality
- [ ] Transcoding pipeline
- [ ] Adaptive bitrate manifest
- [ ] Quality switching in player

### Phase 3: Chat System
- [ ] WebSocket connections
- [ ] Pub/sub message distribution
- [ ] Emotes and badges
- [ ] Moderation tools

### Phase 4: Channel Features
- [ ] Stream key management
- [ ] Go live / offline events
- [ ] Viewer counts
- [ ] Follows and notifications

### Phase 5: VOD
- [ ] Segment archival during live
- [ ] VOD manifest generation
- [ ] Clip creation

---

## Resources

- [HLS Specification](https://developer.apple.com/streaming/)
- [Low-Latency HLS](https://developer.apple.com/documentation/http_live_streaming/enabling_low-latency_http_live_streaming_ll-hls)
- [FFmpeg Streaming Guide](https://trac.ffmpeg.org/wiki/StreamingGuide)
- [Twitch Engineering Blog](https://blog.twitch.tv/en/tags/engineering/)

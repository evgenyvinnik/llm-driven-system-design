# Design Apple TV+ - Development with Claude

## Project Context

Building a premium video streaming service to understand video transcoding, adaptive streaming, and content delivery.

**Key Learning Goals:**
- Build video ingestion and encoding pipelines
- Design adaptive bitrate streaming
- Implement global CDN strategies
- Handle DRM and content protection

---

## Key Challenges to Explore

### 1. Video Transcoding

**Challenge**: Encode masters to multiple qualities efficiently

**Approaches:**
- Distributed encoding clusters
- Per-scene quality optimization
- Multi-codec support (HEVC, H.264)
- HDR tone mapping for SDR

### 2. Adaptive Streaming

**Problem**: Deliver best quality for network conditions

**Solutions:**
- HLS with multiple bitrate variants
- Buffer-based adaptation
- Quality prediction models
- Seamless quality switching

### 3. Global Delivery

**Challenge**: Low latency worldwide with high cache hit rates

**Solutions:**
- Multi-tier CDN architecture
- Predictive pre-positioning
- Origin shield pattern
- Geographic licensing enforcement

---

## Development Phases

### Phase 1: Ingestion
- [ ] Master file validation
- [ ] Transcoding pipeline
- [ ] HLS packaging
- [ ] Origin storage

### Phase 2: Delivery (In Progress)
- [x] Manifest generation (HLS master/variant playlists)
- [x] Content catalog API
- [ ] CDN integration
- [ ] DRM licensing
- [ ] Edge caching

### Phase 3: Player
- [x] Quality selection UI
- [x] Progress tracking
- [ ] Adaptive bitrate logic
- [ ] Buffer management
- [ ] Error recovery

### Phase 4: Experience
- [x] Continue watching
- [x] Watchlist (My List)
- [x] Recommendations
- [x] Profile management
- [ ] Offline downloads
- [ ] Cross-device sync

---

## Implementation Notes

### Session 1: Core Implementation

**Date**: 2025-01

**Completed:**
1. Created PostgreSQL schema with content, users, profiles, watch progress, watchlist, subscriptions
2. Built Express backend with session-based authentication (Redis store)
3. Implemented HLS manifest generation (master playlist with quality variants)
4. Created recommendation engine with genre-based, trending, and personalized sections
5. Built React frontend with Tanstack Router:
   - Home page with hero banner and content rows
   - Content detail page with episode listing for series
   - Video player with controls (play/pause, seek, volume, quality selection)
   - Profile selection and management
   - Watchlist management
   - Account and subscription pages
   - Admin dashboard with stats and content management

**Key Design Decisions:**
- Used simulated HLS manifests (real video segments would require FFmpeg transcoding)
- Profile-based watch history (each profile has independent progress)
- Subscription middleware to gate streaming access
- Redis for session storage and recommendation caching

**Next Steps:**
- Integrate actual video transcoding with FFmpeg
- Add real HLS segment generation and delivery from MinIO
- Implement DRM (FairPlay for Apple devices)
- Add offline download support

---

## Resources

- [HLS Authoring Specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
- [FairPlay Streaming](https://developer.apple.com/streaming/fps/)
- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)

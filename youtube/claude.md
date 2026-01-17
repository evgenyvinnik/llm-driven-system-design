# YouTube - Video Platform - Development with Claude

## Project Context

This document tracks the development journey of implementing a video hosting and streaming platform.

## Key Challenges to Explore

1. Video transcoding
2. CDN strategy
3. Recommendation algorithm
4. Storage optimization

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Completed items:**
- Defined core features: upload, streaming, channels, subscriptions, comments, recommendations
- Chose technology stack: Node.js/Express backend, React frontend, PostgreSQL, Redis, MinIO
- Designed database schema with users, videos, comments, subscriptions, reactions
- Created comprehensive system design documentation

### Phase 2: Initial Implementation
*In progress*

**Completed items:**
- Backend API with Express.js
- Upload service with chunked uploads for large files
- Simulated transcoding pipeline with multi-resolution output
- HLS manifest generation for adaptive streaming
- Metadata service for videos, channels, comments
- Recommendation service with collaborative and content-based filtering
- React frontend with Tanstack Router
- Video player component with quality selection
- Browse, channel, and upload views
- Authentication with session-based cookies

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer
- Optimize database queries
- Implement load balancing
- Add monitoring

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### Video Storage Strategy
**Decision**: Use MinIO (S3-compatible) for video storage
**Rationale**:
- S3-compatible API for easy migration to cloud
- Separate buckets for raw uploads, processed videos, and thumbnails
- Public access for processed videos and thumbnails

### Transcoding Simulation
**Decision**: Simulate transcoding instead of real FFmpeg processing
**Rationale**:
- Focuses on system design patterns over actual video processing
- Real transcoding requires FFmpeg installation and significant processing time
- Simulated pipeline demonstrates async job processing patterns

### Session-Based Authentication
**Decision**: Use Redis-backed sessions with HTTP-only cookies
**Rationale**:
- Simpler than JWT for a learning project
- Good enough for local development
- Easy to scale with Redis cluster

### Recommendation Algorithm
**Decision**: Hybrid approach combining collaborative and content-based filtering
**Rationale**:
- Subscription-based: prioritize subscribed channels
- Category-based: recommend similar content
- Trending: include popular videos for discovery
- Time decay: boost recent content

## Iterations and Learnings

### Iteration 1: Core Implementation
- Implemented full backend API structure
- Created frontend with React and Tanstack Router
- Integrated MinIO for object storage
- Simulated transcoding pipeline

## Questions and Discussions

### Open Questions
- How to handle video preview thumbnails at multiple timestamps?
- What caching strategy for video metadata?
- How to implement real-time notification for transcoding completion?

### Architectural Discussions
- Trade-off between simple uploads vs chunked uploads: chose chunked for reliability
- PostgreSQL for all metadata vs specialized stores: staying simple with PostgreSQL

## Resources and References

- [HLS Specification](https://tools.ietf.org/html/rfc8216)
- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)
- [MinIO Documentation](https://min.io/docs)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Add comprehensive tests
- [ ] Performance testing with load simulation
- [ ] Real transcoding with FFmpeg integration

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

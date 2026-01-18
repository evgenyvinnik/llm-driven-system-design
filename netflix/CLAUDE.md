# Design Netflix - Development with Claude

## Project Context

Building a video streaming platform to understand adaptive streaming, personalization, and A/B testing at scale.

**Key Learning Goals:**
- Build adaptive bitrate streaming
- Design personalization for millions of users
- Implement A/B testing infrastructure
- Handle video encoding optimization

---

## Key Challenges to Explore

### 1. Bandwidth Estimation

**Challenge**: Accurately predict available bandwidth

**Approaches:**
- Segment download time measurement
- Exponential moving average
- Buffer-based adaptation
- Hybrid approaches

### 2. Personalization Latency

**Problem**: Generating personalized homepage is expensive

**Solutions:**
- Precompute row candidates
- Cache per-profile recommendations
- Async row generation
- Progressive loading

### 3. Experiment Interactions

**Problem**: Multiple experiments running simultaneously

**Solutions:**
- Orthogonal experiment layers
- Holdout groups
- Interaction detection
- Careful traffic allocation

---

## Development Phases

### Phase 1: Catalog & Streaming - COMPLETED
- [x] Video metadata database schema
- [x] Basic streaming API endpoints
- [x] DASH-style manifest generation (simplified)
- [x] Quality selection support

### Phase 2: Personalization - IN PROGRESS
- [x] Profile system with CRUD operations
- [x] Per-profile viewing history tracking
- [x] Homepage row generation
- [x] Continue Watching feature
- [x] "Because you watched" recommendations
- [x] My List functionality
- [ ] Enhanced genre-based recommendations
- [ ] Popularity scoring algorithm improvements

### Phase 3: Recommendations - PENDING
- [ ] Similar titles algorithm (beyond genre matching)
- [ ] User embedding vectors
- [ ] Content embedding vectors
- [ ] Personalized genre rankings

### Phase 4: Experimentation - PARTIALLY COMPLETE
- [x] A/B test framework (database + API)
- [x] Consistent allocation service (murmurhash)
- [ ] Metrics collection pipeline
- [ ] Real-time experiment analysis
- [ ] Admin dashboard for experiments

---

## Implementation Notes

### Architecture Decisions

1. **MinIO for Video Storage**: Using S3-compatible storage allows easy migration to AWS S3 or other cloud providers. The presigned URL approach enables direct client-to-storage streaming.

2. **Redis for Sessions**: Enables stateless backend servers and easy session sharing across multiple instances. Also used for caching personalized homepage data.

3. **PostgreSQL for Everything Else**: Simplified from the architecture doc (which suggested Cassandra for viewing history). For learning purposes, PostgreSQL handles all metadata. In production, high-write workloads like viewing progress would benefit from Cassandra.

4. **Simplified DASH**: Instead of actual DASH/HLS manifests with segments, we use a JSON manifest that lists available qualities. Real implementation would require video transcoding and segmentation.

### Frontend Patterns

1. **Zustand Stores**: Separated by domain (auth, browse, player) for cleaner state management.

2. **TanStack Router**: Type-safe routing with search params validation for episodeId on watch page.

3. **Component Hierarchy**:
   - Navbar (global)
   - HeroBanner (featured content)
   - VideoRow (horizontal scroll)
   - VideoCard (individual item with hover preview)
   - ContinueWatchingRow (special row type)
   - VideoPlayer (full-screen playback)

### API Design

- RESTful endpoints grouped by resource
- Session-based auth with httpOnly cookies
- Profile selection stored in session (not URL)
- Maturity filtering applied at query level

---

## Future Improvements

### Near-term
1. Add actual video transcoding pipeline
2. Implement real ABR algorithm in player
3. Add playback analytics events
4. Build admin dashboard

### Long-term
1. Content-based filtering using embeddings
2. Collaborative filtering recommendations
3. Real-time experiment metrics
4. Multi-region CDN simulation

---

## Resources

- [Netflix Tech Blog](https://netflixtechblog.com/)
- [DASH Streaming](https://dashif.org/docs/)
- [Netflix Personalization](https://netflixtechblog.com/netflix-recommendations-beyond-the-5-stars-part-1-55838468f429)
- [A/B Testing at Netflix](https://netflixtechblog.com/its-all-a-bout-testing-the-netflix-experimentation-platform-4e1ca458c15)

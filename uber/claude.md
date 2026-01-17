# Uber - Ride Hailing - Development with Claude

## Project Context

This document tracks the development journey of implementing A ride-hailing platform connecting riders and drivers.

## Key Challenges to Explore

1. Real-time geo-matching
2. Surge pricing
3. ETA calculation
4. Driver allocation

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Decisions made:**
- Core features: ride requests, driver matching, real-time tracking, surge pricing
- Target scale: local development with 3-5 service instances
- Key constraints: must run locally, simple auth, both rider and driver personas

### Phase 2: Initial Implementation
*In progress*

**Completed:**
- Backend with Express + WebSocket server
- Location service with Redis geo commands (GEOADD, GEORADIUS)
- Matching algorithm with driver scoring (ETA + rating weighted)
- Surge pricing based on supply/demand ratio per geohash cell
- Authentication service with session-based auth
- Frontend with Rider and Driver apps using React + Zustand
- Docker Compose for PostgreSQL and Redis

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

### Redis for Geospatial Indexing
**Decision:** Use Redis Geo commands (GEOADD, GEORADIUS) for driver location tracking
**Rationale:**
- Sub-millisecond query times for finding nearby drivers
- Built-in distance calculation
- Handles millions of updates per minute
- Simple operational model vs. specialized geo databases like Tile38
**Trade-off:** Memory-bound storage, but acceptable for active driver locations (hot data)

### Greedy Matching Algorithm
**Decision:** Use simple first-match approach with scoring
**Rationale:**
- Fast matching (< 100ms)
- Good enough for learning/demo purposes
- Easy to understand and debug
**Trade-off:** Suboptimal global assignment vs. batch Hungarian algorithm
**Future:** Can add batch matching for high-demand zones

### Surge Pricing by Geohash
**Decision:** Calculate surge per ~5km geohash cell
**Rationale:**
- Natural geographic partitioning
- O(1) lookup for surge multiplier
- Smooth degradation at boundaries
**Trade-off:** Less granular than hexagonal (H3) zones

### WebSocket for Real-time Updates
**Decision:** Persistent WebSocket connections for drivers and riders
**Rationale:**
- Instant ride offers to drivers
- Real-time location tracking
- Lower latency than polling
**Trade-off:** More complex connection management

## Iterations and Learnings

*Development iterations and key learnings will be tracked here*

## Questions and Discussions

*Open questions and architectural discussions*

## Resources and References

*Relevant articles, papers, and documentation*

## Next Steps

- [ ] Define detailed requirements
- [ ] Sketch initial architecture
- [ ] Choose technology stack
- [ ] Implement MVP
- [ ] Test and iterate

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

# Tinder - Matching Platform - Development with Claude

## Project Context

This document tracks the development journey of implementing A location-based matching and recommendation system.

## Key Challenges to Explore

1. Geo-based matching
2. Recommendation algorithm
3. Real-time matching
4. Privacy and security

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Decisions made:**
- Used PostGIS-enabled PostgreSQL for geospatial data
- Elasticsearch for high-performance geo queries and candidate discovery
- Redis for caching swipes and session management
- WebSocket with Redis Pub/Sub for real-time messaging

### Phase 2: Initial Implementation
*In progress*

**Completed:**
- Backend API with Express + TypeScript
- PostgreSQL schema with geospatial support
- Redis integration for caching and pub/sub
- Elasticsearch integration for geo-based discovery
- User authentication with sessions
- Profile management with photo uploads
- Discovery deck generation with ranking
- Swipe processing with match detection
- Real-time messaging via WebSocket
- Frontend with React + TypeScript + Tanstack Router
- Admin dashboard with stats and user management

**Pending:**
- Testing suite
- Performance benchmarks
- Rate limiting

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer (partially done with Redis)
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

### Database Choice: PostgreSQL + PostGIS
**Decision:** Use PostgreSQL with PostGIS extension for geospatial data
**Rationale:**
- Native support for geography types and spatial indexing
- GIST index for efficient geo queries
- Fallback option when Elasticsearch is unavailable
- Familiar SQL interface

### Geo Search: Elasticsearch
**Decision:** Primary geo search via Elasticsearch, PostgreSQL as fallback
**Rationale:**
- Elasticsearch optimized for read-heavy geo queries
- Built-in distance sorting and scoring
- Can handle complex multi-field queries efficiently
- PostgreSQL fallback ensures reliability

### Swipe Storage: Redis Sets
**Decision:** Store swipes in Redis sets with DB persistence
**Rationale:**
- O(1) membership check for "have I seen this user?"
- Fast mutual like detection
- 24-hour TTL to manage memory
- Eventual consistency with PostgreSQL

### Match Detection: Real-time on swipe
**Decision:** Check for mutual like on every swipe action
**Rationale:**
- Immediate match notifications
- Simple implementation
- Redis lookup is fast enough (<1ms)

### Session Management: express-session
**Decision:** Use cookie-based sessions stored in memory
**Rationale:**
- Simple for learning project
- No JWT complexity
- Easy to extend to Redis session store

## Iterations and Learnings

### Iteration 1: Basic Structure
- Set up project structure
- Created docker-compose for infrastructure
- Implemented basic CRUD APIs

### Iteration 2: Discovery System
- Implemented Elasticsearch geo search
- Added preference-based filtering
- Created ranking algorithm with multiple factors

### Iteration 3: Real-time Features
- Added WebSocket gateway
- Implemented Redis Pub/Sub for cross-server messaging
- Added real-time match and message notifications

### Iteration 4: Frontend
- Built swipe card UI with drag gestures
- Implemented match modal animation
- Created chat interface
- Added admin dashboard

## Questions and Discussions

### Q: Why Elasticsearch over just PostGIS?
**A:** While PostGIS is capable of geo queries, Elasticsearch provides:
- Better performance for complex filtering (gender, age, preferences)
- Built-in relevance scoring
- Easy to scale horizontally
- Better suited for read-heavy discovery workload

### Q: How to handle users who run out of matches?
**A:** Current approach:
- Expand search radius progressively
- Show users slightly outside preferences
- Refresh deck periodically
- Consider showing less active users

### Q: Privacy considerations for location?
**A:** Implemented:
- Fuzzy location display ("5 miles away" not exact)
- Location stored but not exposed in API responses
- Only relative distance shown to other users

## Resources and References

- [PostGIS Documentation](https://postgis.net/docs/)
- [Elasticsearch Geo Queries](https://www.elastic.co/guide/en/elasticsearch/reference/current/geo-queries.html)
- [Redis Pub/Sub](https://redis.io/docs/interact/pubsub/)
- [Tanstack Router](https://tanstack.com/router/latest)

## Next Steps

- [ ] Add unit tests for services
- [ ] Add integration tests for API
- [ ] Implement rate limiting
- [ ] Add monitoring with Prometheus
- [ ] Load test with k6
- [ ] Optimize Elasticsearch queries
- [ ] Add photo moderation

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

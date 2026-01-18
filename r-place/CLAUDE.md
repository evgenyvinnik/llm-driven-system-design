# r/place - Collaborative Real-time Pixel Canvas - Development with Claude

## Project Context

This document tracks the development journey of implementing a collaborative real-time pixel art canvas where users can place colored pixels with rate limiting.

## Key Challenges to Explore

1. Real-time pixel synchronization across millions of users
2. Rate limiting at scale
3. Canvas state storage and persistence
4. Efficient broadcast of pixel updates
5. Canvas history and timelapse generation
6. Handling concurrent pixel placements

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Outcomes:**
- Defined functional requirements: shared canvas, real-time updates, rate limiting, color palette, history
- Target scale: 500x500 canvas for local development, designed for horizontal scaling
- Technology stack chosen: React/Zustand frontend, Express/WebSocket backend, Redis for state, PostgreSQL for history

### Phase 2: Initial Implementation
*In progress*

**Completed:**
- Express backend with TypeScript
- WebSocket server with Redis pub/sub for real-time updates
- Canvas state stored in Redis as byte array
- Rate limiting with Redis TTL keys
- PostgreSQL for pixel event history and snapshots
- Session-based authentication (including anonymous guests)
- React frontend with Zustand state management
- Interactive canvas with zoom/pan
- 16-color palette
- Cooldown timer UI

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

### Canvas Storage (Redis)
**Decision:** Store canvas as a single byte array in Redis using SETRANGE for atomic pixel updates.
**Rationale:** Simple, fast, atomic operations. 500x500 = 250KB fits easily in memory. Can use GETRANGE for efficient partial reads if needed.
**Trade-off:** Single key limits sharding; for larger canvases, would need tile-based approach.

### Real-time Updates (WebSocket + Redis Pub/Sub)
**Decision:** WebSocket connections for clients, Redis pub/sub for cross-server coordination.
**Rationale:** WebSocket provides efficient bidirectional communication. Redis pub/sub allows multiple server instances to broadcast updates.
**Trade-off:** Each WebSocket server subscribes to the same channel, creating redundant processing.

### Rate Limiting (Redis TTL)
**Decision:** Use Redis SET with NX and EX flags for atomic check-and-set cooldown.
**Rationale:** Atomic operation prevents race conditions. TTL auto-expires keys.
**Trade-off:** Simple per-user limiting; more complex patterns (sliding window) would need different approach.

### Authentication
**Decision:** Session-based auth with Redis session storage, plus anonymous guest option.
**Rationale:** Simple for learning project. Anonymous option reduces friction.
**Trade-off:** No persistent identity for anonymous users across sessions.

## Iterations and Learnings

### Iteration 1: Initial Implementation
- Built complete backend with Express, WebSocket, Redis, PostgreSQL
- Frontend with React, Zustand, Tailwind CSS
- Canvas rendering with HTML5 Canvas element
- Real-time pixel updates working via Redis pub/sub

## Questions and Discussions

### Open Questions
1. Should we batch WebSocket messages for high-frequency updates?
2. What's the optimal snapshot interval for timelapse generation?
3. How to handle canvas reset/moderation actions?

## Resources and References

- [Reddit's r/place technical blog post](https://www.reddit.com/r/place)
- [WebSocket scaling patterns](https://www.nginx.com/blog/websocket-nginx/)
- [Redis pub/sub documentation](https://redis.io/docs/manual/pubsub/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add admin interface
- [ ] Implement timelapse viewer
- [ ] Add monitoring/observability
- [ ] Load testing

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

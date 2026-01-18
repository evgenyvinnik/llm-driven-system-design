# Facebook Live Comments - Development with Claude

## Project Context

This document tracks the development journey of implementing A real-time commenting system for live video streams.

## Key Challenges to Explore

1. High write throughput
2. Real-time delivery
3. Comment ordering
4. Spam prevention

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Questions explored:**
- Core features: Real-time comments, reactions, batching, rate limiting
- Scale target: Designed for high-throughput with comment batching and reaction aggregation
- Technical constraints: WebSocket for real-time, Redis Pub/Sub for scaling, PostgreSQL for persistence

### Phase 2: Initial Implementation
*In progress*

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

**Implemented:**
- WebSocket gateway with connection management
- Comment batching (100ms default interval)
- Reaction aggregation (500ms default interval)
- Rate limiting (per-user, per-stream)
- Snowflake ID generation for time-ordered comments
- Redis Pub/Sub for multi-instance support
- PostgreSQL schema with indexes
- React frontend with Zustand state management
- Floating reactions animation

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

### WebSocket vs. Server-Sent Events (SSE)
- **Chosen**: WebSocket
- **Rationale**: Bidirectional communication needed for posting comments. SSE is read-only.

### Comment Batching Strategy
- **Chosen**: Time-based batching (100ms intervals)
- **Rationale**: Reduces message overhead for high-volume streams. Alternative was per-N-comments batching which could cause delays in low-activity periods.

### Snowflake IDs vs. UUID
- **Chosen**: Snowflake IDs
- **Rationale**: Time-ordered without coordination. Can sort by ID to get chronological order. UUIDs are random and require separate timestamp.

### Redis Pub/Sub vs. Kafka
- **Chosen**: Redis Pub/Sub for this implementation
- **Rationale**: Lower latency, simpler setup for learning project. Kafka would be better for durability/replay but adds complexity.

### Rate Limiting Implementation
- **Chosen**: Redis-based sliding window
- **Rationale**: Works across server instances, simple to implement. Alternative was in-memory which doesn't scale horizontally.

### Frontend State Management
- **Chosen**: Zustand
- **Rationale**: Lightweight, simple API, works well with React. Redux would be overkill for this use case.

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

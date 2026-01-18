# YouTube Top K Videos - Development with Claude

## Project Context

This document tracks the development journey of implementing a real-time analytics system for trending videos.

## Key Challenges to Explore

1. High-frequency updates
2. Aggregation at scale
3. Approximate counting
4. Time-window analytics

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Decisions made:**
- Use Redis sorted sets for windowed view counting (1-minute buckets)
- PostgreSQL for persistent video metadata storage
- Server-Sent Events for real-time updates
- Min-heap based Top K algorithm for trending calculation

### Phase 2: Initial Implementation
*In progress*

**Implemented:**
- Backend with Express.js serving REST API
- Redis-based windowed view counter with configurable time buckets
- Top K algorithm implementations (MinHeap, CountMinSketch, SpaceSaving)
- TrendingService with periodic background updates
- SSE endpoint for real-time trending pushes
- Frontend with React 19 + Tanstack Router + Zustand
- Category-based trending with live filtering
- View simulation for testing

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

### Decision 1: Redis Sorted Sets for Windowed Counting
**Context:** Need to count views within a sliding time window efficiently.
**Decision:** Use Redis sorted sets with time-bucketed keys (1-minute granularity).
**Rationale:**
- O(log N) complexity for increments and range queries
- Native support for score aggregation via ZUNIONSTORE
- Automatic expiration of old buckets
- Trade-off: Uses more memory than approximate algorithms but provides exact counts

### Decision 2: Min-Heap for Top K
**Context:** Need to maintain top K trending videos efficiently.
**Decision:** Implement classic min-heap based Top K algorithm.
**Rationale:**
- O(n log k) time complexity
- O(k) space complexity
- Simple to implement and reason about
- Future: Can switch to SpaceSaving for streaming heavy hitters

### Decision 3: SSE over WebSocket
**Context:** Need real-time updates to frontend.
**Decision:** Use Server-Sent Events instead of WebSocket.
**Rationale:**
- Simpler implementation (unidirectional)
- Auto-reconnection built-in
- Works well with HTTP/2
- No need for bidirectional communication

## Iterations and Learnings

### Iteration 1: Initial Implementation
- Implemented windowed counting with Redis sorted sets
- Created TrendingService with background update loop
- Built frontend with category filtering and live stats

**Learnings:**
- Time bucketing simplifies window management
- SSE provides smooth real-time experience
- Zustand works well for this scale of state management

## Questions and Discussions

### Open Questions
1. At what view rate would we need to switch to approximate counting?
2. Should we implement geographic-based trending?
3. How to handle sudden viral spikes (e.g., 10x normal traffic)?

### Answered Questions
1. **Q:** How granular should time buckets be?
   **A:** 1-minute buckets provide good balance of accuracy vs. key count

## Resources and References

- [Redis Sorted Sets Documentation](https://redis.io/docs/data-types/sorted-sets/)
- [Top K Algorithms Survey](https://dl.acm.org/doi/10.1145/1807167.1807197)
- [Count-Min Sketch Paper](https://www.cse.unsw.edu.au/~cs9314/07s1/lectures/Lin_CS9314_References/cm-latin.pdf)
- [Space-Saving Algorithm](https://www.cse.ust.hk/~raywong/comp5331/References/EsssentialCounting.pdf)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add admin interface
- [ ] Implement geographic trends
- [ ] Add load testing

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

# Distributed Cache - Development with Claude

## Project Context

This document tracks the development journey of implementing a high-performance distributed caching layer.

## Key Challenges to Explore

1. Consistent hashing
2. Cache invalidation
3. Replication lag
4. Hot key handling

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Completed:**
- Defined functional requirements (GET, SET, DELETE, TTL, eviction)
- Established scale targets (10K entries per node, 100MB memory)
- Identified key challenges (consistent hashing, LRU, TTL)

### Phase 2: Initial Implementation
*In progress*

**Completed:**
- Implemented consistent hash ring with virtual nodes
- Implemented LRU cache with TTL support (lazy + active expiration)
- Created cache node HTTP server
- Created coordinator for request routing
- Built frontend admin dashboard with:
  - Dashboard overview with stats
  - Key browser and management
  - Cluster management
  - Test interface
- Created Docker configuration for multi-node setup
- Documented API endpoints

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add replication for high availability
- Optimize hot key handling
- Implement connection pooling
- Add metrics/monitoring with Prometheus

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### 2024-01-16: Core Architecture Decisions

1. **Consistent Hashing with 150 Virtual Nodes**
   - *Decision:* Use MD5 hash with 150 virtual nodes per physical node
   - *Rationale:* MD5 provides good distribution, 150 virtual nodes balances memory overhead vs distribution evenness
   - *Trade-off:* More memory for routing table, but much better key distribution

2. **LRU Eviction with Approximate Memory Tracking**
   - *Decision:* Implement true LRU with doubly-linked list, estimate memory via JSON serialization
   - *Rationale:* Provides O(1) operations for get/set/evict
   - *Trade-off:* Memory overhead for linked list pointers, approximate memory tracking

3. **Lazy + Active TTL Expiration**
   - *Decision:* Combine lazy expiration (check on access) with active sampling (background cleanup)
   - *Rationale:* Lazy is efficient for most cases, active prevents memory bloat
   - *Trade-off:* Small CPU overhead for background sampling

4. **Coordinator Pattern vs Smart Client**
   - *Decision:* Use coordinator server for routing instead of smart client library
   - *Rationale:* Simpler for HTTP-based demo, easier to visualize in dashboard
   - *Trade-off:* Extra network hop, but simpler implementation

5. **Node.js with Native Structures**
   - *Decision:* Use JavaScript Map and custom linked list for cache
   - *Rationale:* Follows repo standards, sufficient for learning purposes
   - *Trade-off:* Could use optimized libraries for production, but native approach demonstrates concepts

6. **HTTP API vs Redis Protocol**
   - *Decision:* Use simple HTTP REST API instead of RESP protocol
   - *Rationale:* Easier to test with curl, visualize in dashboard, and understand
   - *Trade-off:* Higher overhead than binary protocol, but much simpler

## Iterations and Learnings

### Iteration 1: Basic Cache Node
- Implemented LRU cache with configurable size and memory limits
- Added TTL support with both lazy and active expiration
- Learned: Memory estimation is tricky; JSON serialization provides reasonable approximation

### Iteration 2: Consistent Hashing
- Implemented hash ring with virtual nodes
- Binary search for O(log n) node lookup
- Learned: Virtual nodes are essential for even distribution; without them, nodes cluster

### Iteration 3: Coordinator
- Created request router using consistent hash ring
- Added health checking and automatic node removal
- Learned: Health check interval needs tuning; too frequent wastes resources, too slow delays failure detection

### Iteration 4: Dashboard
- Built React frontend with TanStack Router
- Real-time cluster monitoring with auto-refresh
- Learned: Visualizing consistent hashing helps understand key distribution

## Questions and Discussions

### Open Questions

1. **How to handle node failure gracefully?**
   - Current: Remove from ring after 3 consecutive health check failures
   - Future: Consider replication for data durability

2. **How to handle hot keys?**
   - Current: Not implemented
   - Future: Could add read replicas or client-side caching

3. **Should we add persistence?**
   - Current: In-memory only
   - Future: Could add WAL or periodic snapshots

### Answered Questions

1. **Why 150 virtual nodes?**
   - Research shows 100-150 virtual nodes provides good balance
   - Tested distribution with 1000 keys: variance < 5% across nodes

2. **Why not use Redis?**
   - Educational purpose: building from scratch teaches core concepts
   - Simpler: can modify and extend easily

## Resources and References

- [Consistent Hashing Paper](https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chash.pdf)
- [Redis Internals](https://redis.io/docs/reference/internals/)
- [LRU Cache Implementation](https://en.wikipedia.org/wiki/Cache_replacement_policies#LRU)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Add comprehensive tests
- [ ] Implement replication
- [ ] Add performance benchmarks
- [ ] Load test and optimize

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

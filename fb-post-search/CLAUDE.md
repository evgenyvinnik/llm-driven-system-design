# Facebook Post Search - Development with Claude

## Project Context

This document tracks the development journey of implementing a search engine for social media posts.

## Key Challenges to Explore

1. Indexing at scale
2. Privacy-aware search
3. Real-time indexing
4. Relevance ranking

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Completed:**
- Defined core vs. nice-to-have features
- Identified scale requirements (designed for billions of users)
- Documented key technical constraints
- Created system design document (system-design-answer.md)

### Phase 2: Initial Implementation
*In progress*

**Focus areas:**
- [x] Implement core functionality
- [x] Get something working end-to-end
- [x] Validate basic assumptions

**Completed:**
- Backend with Express + TypeScript
- PostgreSQL for user data and posts
- Elasticsearch for full-text search
- Redis for caching visibility sets
- Privacy-aware search with visibility fingerprints
- Personalized ranking (friend boosting, engagement scoring)
- Search suggestions and typeahead
- Frontend with React 19 + TanStack Router
- Admin dashboard with system stats

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer (visibility caching implemented)
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

### 1. Visibility Fingerprints
**Decision:** Use precomputed visibility fingerprints stored in Elasticsearch for privacy filtering.

**Rationale:** Checking permissions for each post at query time would be too slow. By precomputing fingerprints (e.g., "PUBLIC", "FRIENDS:user123"), we can filter results efficiently using Elasticsearch term queries.

**Trade-off:** Visibility changes require re-indexing affected posts.

### 2. Two-Phase Ranking
**Decision:** Use Elasticsearch for initial retrieval (BM25 + engagement), then apply social proximity boosting.

**Rationale:** Elasticsearch handles text relevance efficiently. We layer on social signals (friend relationships) at the application level for personalization.

### 3. Session-Based Auth
**Decision:** Use simple session-based authentication with Redis caching.

**Rationale:** Following the project guidelines to keep auth simple for learning projects. Avoids JWT complexity while still being scalable.

### 4. Zustand for State Management
**Decision:** Use Zustand instead of Redux for frontend state.

**Rationale:** Simpler API, less boilerplate, works well with React 19. Sufficient for our search state management needs.

## Iterations and Learnings

### Iteration 1: Basic Search
- Implemented basic Elasticsearch integration
- Created post indexing pipeline
- Added search endpoint with filters

### Iteration 2: Privacy Filtering
- Added visibility fingerprints to post documents
- Implemented getUserVisibilitySet() to compute what each user can see
- Added filtering to search queries

### Iteration 3: Personalization
- Added friend relationship to ranking
- Boosted posts from friends in search results
- Added engagement score boosting

### Iteration 4: Frontend
- Created search bar with typeahead
- Implemented search results display with highlighting
- Added filters UI for date range and post type

## Questions and Discussions

### Q: How to handle visibility changes efficiently?
**A:** Currently, visibility changes (e.g., friendship changes) require invalidating the cached visibility set and potentially re-indexing posts. For production, we'd implement:
- Event-driven re-indexing via Kafka
- Background job to update affected posts
- Bloom filters for more compact visibility sets

### Q: How to scale to billions of posts?
**A:** Current implementation is single-node Elasticsearch. For production scale:
- Shard by post_id hash across 1000+ shards
- Time-based partitioning (hot/cold tiers)
- Read replicas for query scaling
- Dedicated indexing nodes

## Resources and References

- [Elasticsearch Query DSL](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl.html)
- [Facebook's Unicorn Search](https://research.facebook.com/publications/unicorn-a-system-for-searching-the-social-graph/)
- [Privacy in Social Search](https://engineering.fb.com/2013/02/20/core-data/under-the-hood-indexing-and-ranking-in-graph-search/)

## Next Steps

- [ ] Add comprehensive test suite
- [ ] Implement real-time indexing via events
- [ ] Add search analytics and A/B testing hooks
- [ ] Performance benchmarking
- [ ] Two-tier indexing (hot/cold)
- [ ] Bloom filters for visibility optimization

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

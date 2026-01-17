# Facebook News Feed - Development with Claude

## Project Context

This document tracks the development journey of implementing a personalized content feed system for social media.

## Key Challenges to Explore

1. Feed ranking at scale
2. Personalization
3. Real-time updates
4. Handling mixed content types

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Questions explored:**
- Core features: Posts, feed generation, follow system, likes/comments
- Scale target: Local development with ability to simulate distributed systems
- Key constraints: Must run locally, simple auth, PostgreSQL + Redis stack

**Decisions made:**
- Hybrid fan-out strategy (push for regular users, pull for celebrities)
- PostgreSQL for primary data, Redis for caching and sessions
- Affinity-based ranking with recency decay

### Phase 2: Initial Implementation
*In progress*

**Focus areas:**
- [x] Implement core functionality
- [x] Get something working end-to-end
- [x] Validate basic assumptions

**What was implemented:**
- Backend API with Express + TypeScript
- PostgreSQL schema with users, posts, friendships, likes, comments
- Redis caching for sessions and feed data
- Fan-out service with hybrid push/pull strategy
- Feed ranking algorithm with affinity scores
- WebSocket support for real-time updates
- React frontend with Tanstack Router
- Feed view with infinite scroll
- Post composer with image URL support
- Profile pages with follow/unfollow
- User search functionality

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

### Decision 1: Hybrid Fan-out Strategy
**Choice:** Push for regular users (< 10K followers), pull for celebrities (>= 10K followers)

**Rationale:**
- Pure push causes write amplification for celebrities (1 post = millions of writes)
- Pure pull is slow for read-heavy feeds
- Hybrid balances write cost and read latency

### Decision 2: PostgreSQL over Cassandra
**Choice:** PostgreSQL for all data

**Rationale:**
- Simpler for local development
- Sufficient for learning purposes
- Can add read replicas for scale
- Rich query capabilities for rankings

### Decision 3: Redis for Multiple Purposes
**Choice:** Redis for sessions, feed cache, and pub/sub

**Rationale:**
- Single service reduces operational complexity
- Sorted sets perfect for ranked feeds
- Pub/sub enables real-time updates
- Already proven at scale (Twitter, Instagram)

### Decision 4: Affinity-based Ranking
**Choice:** Score = engagement * recency_decay * affinity_boost

**Rationale:**
- Engagement indicates quality content
- Recency ensures freshness
- Affinity promotes content from close friends
- Simple but effective for MVP

## Iterations and Learnings

### Iteration 1: Initial Implementation
- Built complete backend with all core features
- Implemented frontend with feed, profiles, auth
- Key learning: Fan-out requires careful handling of edge cases (new followers, unfollows, deleted posts)

## Questions and Discussions

### Open Questions
1. How to handle feed for users following only celebrities?
2. Should we implement feed warming on login?
3. What's the right TTL for cached feed items?

### Resolved Questions
1. **Q:** Push vs Pull for feed generation?
   **A:** Hybrid approach - push for regular users, pull for celebrities

2. **Q:** How to rank posts?
   **A:** Engagement score with recency decay and affinity boost

## Resources and References

- [Facebook News Feed Architecture](https://engineering.fb.com/2010/05/13/web/the-new-facebook-news-feed/) - Original FB engineering post
- [Twitter Fan-out](https://blog.twitter.com/engineering/en_us/topics/infrastructure/2017/the-infrastructure-behind-twitter-scale) - Twitter's approach
- [Redis Sorted Sets](https://redis.io/docs/data-types/sorted-sets/) - Perfect for ranked feeds

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add real-time notifications
- [ ] Implement admin dashboard
- [ ] Add comprehensive tests
- [ ] Performance optimization

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

# Web Crawler - Development with Claude

## Project Context

This document tracks the development journey of implementing a distributed web crawling system for indexing the internet.

## Key Challenges to Explore

1. Distributed coordination
2. Duplicate detection
3. Crawl politeness
4. URL prioritization

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Completed:**
- Defined functional requirements (URL discovery, page fetching, content extraction, politeness)
- Established scale targets based on system-design-answer.md
- Identified key technical constraints (robots.txt compliance, rate limiting)

### Phase 2: Initial Implementation
*In Progress*

**Completed items:**
- Set up project structure (backend, frontend, Docker configuration)
- Implemented URL frontier with priority queue (PostgreSQL + Redis)
- Created crawler workers with politeness (robots.txt, rate limiting)
- Built content storage and link extraction
- Implemented API endpoints for dashboard and admin
- Created frontend dashboard with React, Vite, TanStack Router, Zustand, Tailwind CSS
- Set up Docker Compose for both development and production

**Focus areas:**
- [x] Implement core functionality
- [x] Get something working end-to-end
- [x] Validate basic assumptions

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

### 2025-01-16: Initial Implementation Decisions

1. **Database Choice: PostgreSQL for URL Frontier**
   - *Decision:* Use PostgreSQL for the URL frontier and metadata storage
   - *Rationale:* PostgreSQL provides ACID guarantees for URL state transitions, efficient indexing for priority-based queries, and good support for concurrent access
   - *Trade-off:* Slower than pure Redis for simple queue operations, but more durable and queryable
   - *Alternative considered:* Kafka for the frontier, but added complexity not needed for learning project

2. **Deduplication: Redis Sets**
   - *Decision:* Use Redis SSET for visited URL tracking
   - *Rationale:* O(1) lookup time, memory-efficient for URL hashes, natural fit with Redis rate limiting
   - *Trade-off:* Memory-bound; at 10 billion URLs with 64-byte hashes = ~640GB RAM
   - *Alternative considered:* Bloom filter would use less memory but has false positives

3. **Rate Limiting: Redis Locks with TTL**
   - *Decision:* Use Redis SET NX EX for per-domain rate limiting
   - *Rationale:* Distributed coordination without complex locking, automatic expiry
   - *Trade-off:* Lock granularity is per-domain, not per-path; slightly less optimal for large sites
   - *Alternative considered:* Token bucket algorithm for smoother rate limiting

4. **Priority Queue: Three-Level Queues**
   - *Decision:* Implement three priority levels (high, medium, low)
   - *Rationale:* Simple to understand and implement, good enough for most use cases
   - *Trade-off:* Less granular than continuous priority scores
   - *Alternative considered:* Redis sorted sets with priority scores as scores

5. **Frontend State Management: Zustand**
   - *Decision:* Use Zustand for state management
   - *Rationale:* Lightweight, simple API, good TypeScript support, no boilerplate
   - *Trade-off:* Less structured than Redux for very large applications
   - *Alternative considered:* TanStack Query for server state, but simpler polling approach chosen

6. **Routing: TanStack Router**
   - *Decision:* Use TanStack Router for frontend routing
   - *Rationale:* Type-safe routing, file-based routing option, modern API
   - *Trade-off:* Slightly newer/less ecosystem than React Router
   - *Alternative considered:* React Router v6

## Iterations and Learnings

### Iteration 1: Core Implementation (2025-01-16)
- Built complete backend with Express.js
- Implemented URL frontier, crawler workers, and API
- Created React dashboard with real-time updates
- Set up Docker deployment

**Key learnings:**
- Redis NX locks work well for distributed rate limiting
- Separating API server from workers allows independent scaling
- Priority queues need careful design to avoid starvation of low-priority URLs

## Questions and Discussions

### Open Questions
1. How to handle JavaScript-rendered pages? (Puppeteer integration)
2. What's the best approach for near-duplicate detection at scale?
3. How to efficiently rebalance work when workers are added/removed?

### Resolved Questions
1. **How to handle robots.txt caching?**
   - Cache in Redis with 1-hour TTL, also store in PostgreSQL for persistence
   - In-memory cache for hot domains

2. **How to prioritize URLs?**
   - Three-level priority based on depth, URL patterns, and domain authority
   - High: seed URLs, homepages, shallow pages
   - Medium: content pages, blog posts
   - Low: paginated content, archive pages

## Resources and References

- [Mercator paper](https://www.cs.cornell.edu/courses/cs685/2002fa/mercator.pdf) - Classic web crawler architecture
- [Google's web crawling patent](https://patents.google.com/patent/US7454444B1/en)
- [robots-parser npm](https://www.npmjs.com/package/robots-parser) - robots.txt parsing
- [Cheerio](https://cheerio.js.org/) - HTML parsing

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add comprehensive tests
- [ ] Implement monitoring (Prometheus/Grafana)
- [ ] Add content storage (S3/local)
- [ ] Implement near-duplicate detection

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

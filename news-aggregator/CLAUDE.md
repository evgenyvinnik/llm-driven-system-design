# News Aggregator - Development with Claude

## Project Context

This document tracks the development journey of implementing a content aggregation and curation platform.

## Key Challenges to Explore

1. Content deduplication
2. Real-time updates
3. Topic extraction
4. Ranking algorithm

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Outcomes:**
- Defined functional requirements: crawling, deduplication, categorization, personalization, search
- Chose technology stack: Node.js/Express, React/TypeScript, PostgreSQL, Redis, Elasticsearch
- Created detailed system design document (system-design-answer.md)

### Phase 2: Initial Implementation
*In Progress*

**Completed:**
- Docker infrastructure (PostgreSQL, Redis, Elasticsearch)
- Backend server with Express and TypeScript
- RSS/Atom feed parsing and crawling
- SimHash-based article deduplication
- Story clustering with fingerprint matching
- Keyword-based topic extraction
- Personalized feed ranking with multiple signals
- User authentication with sessions
- Admin dashboard for source management
- Frontend with React 19 and Tanstack Router
- Feed view, story view, topic browsing
- User preferences and settings

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

### SimHash for Deduplication
**Decision:** Use SimHash fingerprinting instead of exact matching or semantic embeddings.

**Rationale:**
- Fast O(1) comparison using Hamming distance
- Works well for near-duplicate text detection
- Low memory footprint (64-bit fingerprint per article)
- Simple to implement without ML dependencies

**Trade-offs:**
- May miss semantically similar but textually different articles
- Fixed threshold may not work for all content types

### Keyword-Based Topic Classification
**Decision:** Use keyword matching instead of ML models for topic extraction.

**Rationale:**
- Simple to implement and understand
- No model training or external dependencies
- Predictable and debuggable behavior
- Sufficient for learning project

**Trade-offs:**
- Less accurate than ML approaches
- Requires manual keyword list maintenance
- May struggle with nuanced or emerging topics

### Multi-Signal Ranking
**Decision:** Combine relevance, freshness, quality, and trending signals for feed ranking.

**Weights:**
- Relevance: 35% (topic match with user interests)
- Freshness: 25% (exponential decay, 6-hour half-life)
- Quality: 20% (source diversity)
- Trending: 10% (story velocity)
- Breaking: +30% boost

**Rationale:**
- Balances personalization with diversity
- Promotes recent content without burying evergreen stories
- Rewards multi-source coverage for credibility

## Iterations and Learnings

### Iteration 1: Basic Infrastructure
- Set up Docker Compose with PostgreSQL, Redis, Elasticsearch
- Learned: Elasticsearch takes significant time to start; need health checks

### Iteration 2: RSS Parsing
- Implemented RSS/Atom feed parsing with fast-xml-parser
- Learned: Feed formats vary significantly; need flexible parsing

### Iteration 3: Deduplication
- Implemented SimHash with 64-bit fingerprints
- Learned: Threshold of 3 works well for news articles

### Iteration 4: Frontend
- Built feed UI with Tanstack Router and Zustand
- Learned: Route-based data loading simplifies state management

## Questions and Discussions

**Q: How to handle sources that change their layout?**
A: Currently relying on RSS feeds. Future: add layout monitoring and alerts.

**Q: When to use semantic embeddings vs SimHash?**
A: SimHash for initial fast matching, embeddings as secondary verification for borderline cases.

**Q: How to scale crawling?**
A: Distribute crawlers by domain hash, use message queue for work distribution.

## Resources and References

- [SimHash Paper](https://www.cs.princeton.edu/courses/archive/spr04/cos598B/bib/ChsriychainS.pdf)
- [RSS 2.0 Specification](https://www.rssboard.org/rss-specification)
- [Atom Syndication Format](https://datatracker.ietf.org/doc/html/rfc4287)
- [Elasticsearch Node.js Client](https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/index.html)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Add comprehensive tests
- [ ] Add monitoring and metrics
- [ ] Implement breaking news detection
- [ ] Add source credibility scoring

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

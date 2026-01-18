# Price Tracking Service - Development with Claude

## Project Context

This document tracks the development journey of implementing an e-commerce price monitoring and alert system.

## Key Challenges to Explore

1. Scraping at scale
2. Change detection
3. Data storage
4. Alert delivery

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**What was accomplished:**
- Defined core features: product tracking, price scraping, historical charts, alerts
- Chose technology stack: Node.js/Express, React, PostgreSQL/TimescaleDB, Redis
- Designed database schema with TimescaleDB hypertables for time-series data
- Planned scraper architecture with domain-sharded queues and proxy support

### Phase 2: Initial Implementation
*In progress*

**What has been implemented:**
- Full backend API with Express (auth, products, alerts, admin endpoints)
- PostgreSQL database schema with TimescaleDB for price history
- Redis integration for caching and session management
- Scraper worker with Cheerio HTML parsing and JSON-LD extraction
- React frontend with TanStack Router, Zustand state management
- Price history charts using Recharts
- Alert notification system
- Admin dashboard with statistics

**Focus areas:**
- [x] Implement core functionality
- [x] Get something working end-to-end
- [ ] Validate basic assumptions with real-world testing

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer (Redis caching implemented)
- Optimize database queries (indexes and continuous aggregates defined)
- Implement load balancing
- Add monitoring (Prometheus/Grafana)

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### Decision 1: TimescaleDB over InfluxDB
**Rationale:** TimescaleDB is a PostgreSQL extension, allowing us to use familiar SQL and easily join time-series data with relational data (products, users). InfluxDB would require a separate query language and data synchronization.

### Decision 2: Cheerio over Puppeteer for default scraping
**Rationale:** Most e-commerce sites render prices in HTML without requiring JavaScript. Cheerio is significantly faster and uses less resources. Puppeteer is available for sites that require JS rendering.

### Decision 3: Domain-based priority queue
**Rationale:** Each e-commerce site has different rate limits and HTML structure. Sharding scrape queues by domain allows independent scaling, failure isolation, and specialized parsers.

### Decision 4: Session-based auth over JWT
**Rationale:** Following the repository guidelines for learning projects - simpler implementation with Redis-backed sessions. JWT rotation and refresh token complexity avoided.

## Iterations and Learnings

### Iteration 1: Initial Implementation
- Created full-stack application with all core features
- Used TanStack Router for type-safe routing
- Implemented Zustand for simple but effective state management
- Built responsive UI with Tailwind CSS

## Questions and Discussions

**Q: How to handle sites that require JavaScript rendering?**
A: The `scraper_configs` table has a `requires_js` flag. Sites marked as requiring JS would use Puppeteer instead of Cheerio. This is a per-domain setting.

**Q: How to detect when a site changes its HTML structure?**
A: The system tracks extraction success rate per domain. When it drops below 70%, an alert is triggered for manual parser review.

## Resources and References

- [TimescaleDB Documentation](https://docs.timescale.com/)
- [Cheerio Documentation](https://cheerio.js.org/)
- [TanStack Router](https://tanstack.com/router)
- [Recharts](https://recharts.org/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test with real e-commerce URLs
- [ ] Add integration tests
- [ ] Set up CI/CD pipeline
- [ ] Deploy to staging environment

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

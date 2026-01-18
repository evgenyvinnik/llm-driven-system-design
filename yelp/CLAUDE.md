# Yelp - Business Reviews - Development with Claude

## Project Context

This document tracks the development journey of implementing a local business review and discovery platform.

## Key Challenges to Explore

1. Geo-spatial search
2. Review ranking
3. Spam detection
4. Search relevance

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Key decisions made:**
- PostgreSQL with PostGIS for geo-spatial queries
- Elasticsearch for full-text search and geo filtering
- Redis for session management and caching
- React 19 with TanStack Router for frontend

### Phase 2: Initial Implementation
*In progress*

**Completed features:**
- Database schema with PostGIS support
- User authentication with session-based auth
- Business CRUD with geo-spatial queries
- Review system with rating aggregation
- Elasticsearch integration for search
- Frontend with home, search, business detail, and dashboard pages
- Admin panel for user/business/review management
- RabbitMQ for async Elasticsearch indexing

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

### Database Design
- **PostGIS for geo-spatial**: Using `GEOGRAPHY(POINT, 4326)` type for accurate distance calculations
- **Rating aggregation**: Storing `rating_sum` and `review_count` for incremental updates via database triggers
- **Unique constraint**: One review per user per business enforced at database level

### Search Architecture
- **Elasticsearch for search**: Better full-text search and built-in geo queries compared to PostgreSQL
- **PostgreSQL as source of truth**: All writes go to PostgreSQL, then synced to Elasticsearch
- **Cache layer with Redis**: Search results cached for 2 minutes, business details for 5 minutes

### Authentication
- **Session-based with Redis**: Simple, secure, easy to manage
- **Cookie-based tokens**: HttpOnly cookies for security
- **Role-based access**: user, business_owner, admin roles

### Async Indexing with RabbitMQ
- **Queue-based updates**: Business/review changes publish events to RabbitMQ queue
- **Index worker**: Separate process consumes queue and updates Elasticsearch
- **Decoupling benefits**: API responses are faster, index failures don't affect writes
- **Graceful degradation**: If RabbitMQ is down, server continues (search may be stale)

## Iterations and Learnings

### Iteration 1: Basic Structure
- Set up backend with Express and PostgreSQL
- Created database schema with PostGIS extensions
- Implemented basic CRUD operations

### Iteration 2: Search Integration
- Added Elasticsearch for full-text search
- Implemented geo-distance filtering
- Added autocomplete suggestions

### Iteration 3: Frontend Development
- Created React frontend with TanStack Router
- Implemented search, business detail, and review pages
- Added user dashboard and admin panel

### Iteration 4: Async Elasticsearch Indexing
- Added RabbitMQ for async processing
- Created index worker to consume queue messages
- Decoupled Elasticsearch updates from API responses
- API now publishes events to queue instead of sync updates

## Questions and Discussions

### Open Questions
1. How to handle rating recalculation at scale? (Currently using triggers)
2. Best approach for review spam detection?
3. How to implement real-time updates for reviews?

### Potential Improvements
1. Add Bayesian rating for fairer rankings
2. Implement review photo uploads with S3
3. Add real-time notifications with WebSockets
4. Implement map-based browsing with clustering

## Resources and References

- PostGIS documentation for geo-spatial queries
- Elasticsearch geo_distance query documentation
- Yelp's engineering blog for architecture insights

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Add comprehensive tests
- [ ] Performance optimization
- [ ] Deploy and iterate

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

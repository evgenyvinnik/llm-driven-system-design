# Strava - Fitness Tracking - Development with Claude

## Project Context

This document tracks the development journey of implementing a fitness tracking and social platform for athletes.

## Key Challenges to Explore

1. GPS data storage
2. Segment matching
3. Leaderboard calculation
4. Privacy zones

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Outcomes:**
- Defined core features: activity tracking, GPS visualization, segments, leaderboards, social features
- Designed database schema with PostgreSQL + PostGIS for geospatial data
- Chose Redis for leaderboards (sorted sets) and activity feeds (fan-out on write)
- Documented system architecture in `system-design-answer.md`

### Phase 2: Initial Implementation
*In progress*

**Completed:**
- Backend API with Express.js
  - Authentication (session-based with Redis)
  - Activity CRUD with GPX parsing
  - Segment matching algorithm (two-phase: bounding box + GPS point comparison)
  - Leaderboard system with Redis sorted sets
  - Social features (following, kudos, comments)
  - Activity feed with fan-out on write
  - User statistics and achievements
- Frontend with React + TypeScript
  - Activity upload and simulation
  - Map visualization with Leaflet
  - Activity detail view with GPS tracks
  - Segment exploration and leaderboards
  - User profiles and following
  - Personal stats and achievements
- Docker setup for PostgreSQL + Redis

**Remaining:**
- Add more comprehensive error handling
- Implement privacy zones fully
- Add real-time updates (WebSocket)

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer for frequently accessed data
- Optimize database queries with proper indexes
- Implement load balancing across multiple instances
- Add monitoring with Prometheus + Grafana

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### 1. GPS Data Storage
**Decision:** Store GPS points in PostgreSQL (not Cassandra) for simplicity in local development.
**Rationale:** PostgreSQL with proper indexing handles the scale for this learning project. For production scale (millions of activities/day), we would use Cassandra or TimescaleDB.

### 2. Segment Matching Algorithm
**Decision:** Two-phase matching (bounding box filter + GPS point comparison)
**Rationale:** Bounding box check quickly eliminates 99% of segments, then precise matching only runs on candidates. Uses Haversine distance with 25m threshold.

### 3. Leaderboard Implementation
**Decision:** Redis sorted sets with lower time = better ranking
**Rationale:** O(log N) insertions and O(1) rank lookups. Personal records stored separately for quick PR checks.

### 4. Activity Feed Strategy
**Decision:** Fan-out on write
**Rationale:** Trades write amplification for read performance. Works well for typical follower counts (<1000). Would need hybrid approach for celebrity athletes.

### 5. Polyline Encoding
**Decision:** Store routes as encoded polylines instead of raw GPS points for display
**Rationale:** Reduces data transfer significantly (10x compression). Full GPS points still stored for segment matching.

## Iterations and Learnings

### Iteration 1: Core Implementation
- Set up Express backend with PostgreSQL + Redis
- Implemented authentication with session-based approach
- Created activity upload with GPX parsing
- Added simulated activities for easy testing
- Built React frontend with TanStack Router

### Iteration 2: Segment System
- Implemented segment creation from activities
- Built two-phase segment matching algorithm
- Added leaderboard with Redis sorted sets
- Integrated segment efforts into activity detail view

### Iteration 3: Social Features
- Added following/followers system
- Implemented kudos and comments
- Built activity feed with Redis caching
- Created user profile pages

### Iteration 4: Statistics & Achievements
- Added user statistics aggregation
- Implemented achievement system with auto-checking
- Built stats dashboard in frontend

## Questions and Discussions

### How accurate should segment matching be?
Currently using 25m threshold. For cycling (on roads), this is appropriate. For trail running, might need looser thresholds or different algorithms.

### How to handle GPS drift?
Some devices have poor GPS accuracy. Consider Kalman filtering or path snapping for better route quality.

### How to detect fraudulent activities?
Future consideration: speed analysis, device verification, elevation profile matching.

## Resources and References

- [Strava Engineering Blog](https://engineering.strava.com/)
- [Polyline Encoding Algorithm](https://developers.google.com/maps/documentation/utilities/polylinealgorithm)
- [Haversine Formula](https://en.wikipedia.org/wiki/Haversine_formula)
- [Redis Sorted Sets](https://redis.io/docs/data-types/sorted-sets/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add WebSocket for real-time updates
- [ ] Implement privacy zones
- [ ] Add monitoring and observability
- [ ] Write comprehensive tests

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

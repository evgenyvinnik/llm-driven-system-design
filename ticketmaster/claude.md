# Ticketmaster - Event Ticketing - Development with Claude

## Project Context

This document tracks the development journey of implementing an event ticketing and inventory management platform.

## Key Challenges to Explore

1. Handling traffic spikes
2. Preventing double booking
3. Fair queue system
4. Scalper prevention

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**What was done:**
- Defined core functional requirements (event browsing, seat selection, ticket purchase, inventory management)
- Identified non-functional requirements (handle traffic spikes, no overselling, fairness, low latency)
- Created detailed system design documentation in `system-design-answer.md`
- Designed database schema with events, venues, seats, orders
- Planned distributed locking strategy with Redis

### Phase 2: Initial Implementation
*In progress*

**What has been implemented:**
- Full backend API with Express + TypeScript
  - Authentication (session-based with Redis)
  - Events and venues CRUD
  - Seat availability and reservation
  - Virtual waiting room queue
  - Checkout flow
- PostgreSQL database with seed data
- Redis for session storage, distributed locks, and queue management
- Frontend with React 19 + TypeScript
  - Event browsing with search/filter
  - Interactive seat map
  - Waiting room UI
  - Checkout with countdown timer
  - Order history

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

### 1. Redis for Distributed Seat Locks
**Decision:** Use Redis SET NX EX for seat locking instead of database-only locking.
**Rationale:** Sub-millisecond locking with automatic expiry. Redis handles high concurrency better than database locks for this use case.
**Trade-off:** Additional infrastructure component; need to handle Redis failures with database fallback.

### 2. Session-Based Authentication
**Decision:** Use simple cookie + Redis sessions instead of JWT.
**Rationale:** Simpler for learning project; easy session invalidation; no token refresh complexity.
**Trade-off:** Requires session store; not suitable for microservices without shared session.

### 3. 10-Minute Seat Hold Duration
**Decision:** Seats are held for 10 minutes during checkout.
**Rationale:** Long enough for users to complete payment; short enough for abandoned carts to release seats.
**Trade-off:** Some users may lose seats if payment takes too long.

### 4. Virtual Waiting Room
**Decision:** Implement queue system for high-demand events using Redis sorted sets.
**Rationale:** Protects backend from traffic spikes; ensures fair access; better user experience than random timeouts.
**Trade-off:** Adds perceived latency; requires additional infrastructure.

### 5. Optimistic Locking in Database
**Decision:** Use `FOR UPDATE NOWAIT` for seat status changes.
**Rationale:** Prevents race conditions at database level; fails fast instead of waiting.
**Trade-off:** Requires retry logic in application.

## Iterations and Learnings

### Iteration 1: Initial Implementation
- Created full-stack ticketing platform
- Key learning: Distributed locking is essential for preventing overselling
- Key learning: Need both Redis lock AND database transaction for safety

## Questions and Discussions

### Open Questions
1. How to handle Redis failure during high-traffic event?
2. What's the optimal waiting room admission rate?
3. How to detect and block scalper bots?

### Answered Questions
1. **Why PostgreSQL over document store?** - Strong consistency needed for financial transactions; ACID compliance for seat inventory
2. **Why Redis over in-memory locks?** - Need distributed locking across multiple server instances

## Resources and References

- [Ticketmaster Engineering Blog](https://tech.ticketmaster.com/)
- [Redis Distributed Locks (Redlock)](https://redis.io/topics/distlock)
- [PostgreSQL Locking](https://www.postgresql.org/docs/current/explicit-locking.html)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Add comprehensive tests
- [ ] Implement admin dashboard
- [ ] Add monitoring and observability
- [ ] Load testing

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

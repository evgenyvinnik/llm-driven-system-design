# Hotel Booking - Hotel Reservation and Management System - Development with Claude

## Project Context

This document tracks the development journey of implementing a hotel reservation and management system with inventory management, pricing, and booking capabilities.

## Key Challenges to Explore

1. Inventory management and room availability
2. Concurrency control for simultaneous bookings
3. Dynamic pricing strategies
4. Search and filtering at scale
5. Handling booking modifications and cancellations
6. Payment processing and transaction management
7. Overbooking strategies

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Completed:**
- Defined functional requirements based on system-design-answer.md
- Identified core features: hotel listings, search, booking, availability, admin dashboard
- Chose technology stack: PostgreSQL, Redis, Elasticsearch, Node.js, React

**Key decisions:**
- Range-based bookings over date-slots for flexibility
- Pessimistic locking for booking concurrency control
- Elasticsearch for search with PostgreSQL for consistency-critical operations

### Phase 2: Initial Implementation
*In Progress*

**Completed:**
- Database schema with users, hotels, room_types, bookings, reviews
- Backend API with Express.js
  - Authentication service with session-based auth in Redis
  - Hotel service with CRUD and Elasticsearch indexing
  - Room service with dynamic pricing support
  - Booking service with pessimistic locking for double-booking prevention
  - Search service combining Elasticsearch and real-time availability
  - Review service
- Frontend with React + TypeScript + TanStack Router + Tailwind
  - Home page with search
  - Hotel search results with filters
  - Hotel detail page with room types and availability calendar
  - Booking flow with guest details
  - My bookings page with confirm/cancel actions
  - Booking detail with review submission
  - Login/Register pages
  - Hotel admin dashboard
  - Hotel management (room types, pricing)

**Focus areas:**
- [x] Implement core functionality
- [x] Get something working end-to-end
- [x] Validate basic assumptions

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer (availability caching implemented, needs optimization)
- Optimize database queries (add explain analyze, indexes tuning)
- Implement load balancing (nginx config for multiple backend instances)
- Add monitoring (Prometheus + Grafana)

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests (unit, integration, e2e)
- Performance tuning
- Code cleanup

## Design Decisions Log

### 1. Pessimistic Locking for Bookings
**Decision:** Use PostgreSQL `SELECT ... FOR UPDATE` to lock room inventory during booking creation.

**Rationale:**
- Strong consistency is critical - users must not be double-booked
- Lower write throughput is acceptable given booking:search ratio of 1:100
- Simpler than optimistic locking with retry logic

**Trade-off:** May cause contention for very popular hotels during flash sales. Could add Redis distributed locks as overflow mechanism.

### 2. Booking Ranges vs. Date Slots
**Decision:** Store bookings as check_in/check_out ranges, not per-date slots.

**Rationale:**
- More flexible for date changes
- Less storage (one row per booking vs. row per night)
- Easier to query booking history

**Trade-off:** Availability queries are more complex (need to check overlap across date range).

### 3. Reservation Hold Pattern
**Decision:** Bookings start as "reserved" with 15-minute expiry, then "confirmed" after payment.

**Rationale:**
- Prevents cart abandonment from blocking inventory indefinitely
- Gives users time to complete payment
- Background job cleans up expired reservations

### 4. Search Architecture
**Decision:** Two-phase search - Elasticsearch for matching, PostgreSQL for availability.

**Rationale:**
- Elasticsearch excels at text/geo/filter queries
- PostgreSQL provides ACID guarantees for accurate availability
- Caching mitigates latency of availability checks

### 5. Session-Based Authentication
**Decision:** Use Redis-backed sessions instead of JWT.

**Rationale:**
- Simpler revocation (just delete session)
- No token rotation complexity
- Good enough for learning project

## Iterations and Learnings

### Iteration 1: Core Backend
- Set up PostgreSQL schema with proper indexes
- Implemented auth with bcrypt password hashing
- Created hotel/room CRUD with Elasticsearch sync
- Built booking service with transaction-based locking

**Learning:** The `generate_series` function in PostgreSQL is powerful for date-based availability queries.

### Iteration 2: Frontend Foundation
- Established TanStack Router file-based routing
- Created Zustand stores for auth and search state
- Built reusable components (HotelCard, RoomTypeCard, etc.)
- Implemented API service layer with token handling

**Learning:** Zustand's persist middleware makes auth state management trivial.

### Iteration 3: Booking Flow
- Built complete booking flow from hotel detail to confirmation
- Implemented availability calendar with pricing display
- Added booking confirmation and cancellation
- Created review submission post-stay

**Learning:** Calendar date selection UX requires careful state management for check-in/check-out flow.

### Iteration 4: Admin Dashboard
- Created hotel admin dashboard with stats
- Built hotel and room type management
- Implemented price override (dynamic pricing)
- Added booking list for hotel owners

## Questions and Discussions

### Open Questions

1. **How to handle flash sales?**
   - Current pessimistic locking may cause contention
   - Consider booking queue with rate limiting

2. **How to implement overbooking?**
   - Hotels often overbook by 5-10%
   - Need "soft" and "hard" limits in room_types table
   - Automatic rebooking workflow for overbooked guests

3. **How to scale availability checks?**
   - Pre-compute availability for next N days in nightly job?
   - Or lean on caching with aggressive invalidation?

### Resolved Questions

1. **Q: PostgreSQL vs. NoSQL for bookings?**
   A: PostgreSQL for ACID guarantees. Bookings are revenue-critical.

2. **Q: Real-time search or eventual consistency?**
   A: Eventual consistency for search is acceptable (5-min cache). Real-time for booking.

## Resources and References

- [PostgreSQL Row-Level Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [Elasticsearch Geo Queries](https://www.elastic.co/guide/en/elasticsearch/reference/current/geo-queries.html)
- [TanStack Router Documentation](https://tanstack.com/router/latest)
- [Zustand State Management](https://docs.pmnd.rs/zustand/getting-started/introduction)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Add comprehensive tests
- [ ] Load test booking concurrency
- [ ] Implement monitoring
- [ ] Add payment gateway integration

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

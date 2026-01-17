# Calendly - Meeting Scheduling Platform - Development with Claude

## Project Context

This document tracks the development journey of implementing a meeting scheduling and calendar coordination platform similar to Calendly.

## Key Challenges to Explore

1. **Double Booking Prevention**
   - How to ensure no overlapping bookings with high concurrency?
   - Database locking strategies vs. optimistic concurrency control
   - Trade-offs between consistency and availability

2. **Availability Calculation**
   - Efficiently merging multiple calendar sources
   - Computing available slots from busy periods
   - Handling buffer times and constraints
   - Caching strategies for performance

3. **Time Zone Complexity**
   - Storing times in UTC vs. local time zones
   - Displaying availability across time zones
   - Handling daylight saving time transitions
   - Edge cases (same clock time, different days)

4. **Calendar Integration**
   - OAuth flows for different providers
   - Rate limiting and quota management
   - Two-way sync (read events, write bookings)
   - Handling webhook delays and failures
   - Dealing with API inconsistencies across providers

5. **Real-Time Availability**
   - Balancing freshness vs. API costs
   - Cache invalidation strategies
   - Handling race conditions during booking

## Development Phases

### Phase 1: Requirements and Design
*Not started*

**Questions to explore with Claude:**
- What are the absolute core features vs. nice-to-have?
- What scale should we design for? (users, bookings/day)
- What are the hardest technical problems?
- Which calendar providers should we support first?

**Key discussions needed:**
- Compare different double-booking prevention approaches
- Analyze availability calculation algorithms
- Discuss time zone handling strategies
- Evaluate calendar sync approaches (polling vs. webhooks)

### Phase 2: Core Implementation (MVP)
*Not started*

**Focus areas:**
1. Basic user and meeting type management
2. Simple availability rules (weekly schedule)
3. Availability slot calculation (without external calendars)
4. Booking creation with double-booking prevention
5. Basic email notifications

**Implementation questions:**
- How to implement the availability algorithm efficiently?
- What database indexes are critical?
- How to structure the booking transaction?

### Phase 3: Calendar Integration
*Not started*

**Focus areas:**
1. Google Calendar OAuth integration
2. Fetch and cache calendar events
3. Merge calendar events into availability calculation
4. Create calendar events on booking
5. Handle calendar sync errors gracefully

**Technical challenges:**
- How to securely store and refresh OAuth tokens?
- How to handle rate limits from calendar APIs?
- What happens when calendar API is down during booking?

### Phase 4: Scaling and Optimization
*Not started*

**Focus areas:**
1. Add Valkey/Redis caching layer
2. Optimize availability queries
3. Implement background jobs for calendar sync
4. Add monitoring and metrics
5. Load testing and bottleneck identification

**Questions to explore:**
- Where are the performance bottlenecks?
- What should be cached and for how long?
- How to handle cache invalidation?
- What metrics matter most?

### Phase 5: Polish and Advanced Features
*Not started*

**Focus areas:**
1. Rescheduling and cancellation flows
2. Email reminders (scheduled notifications)
3. Time zone detection and conversion UI
4. Analytics dashboard for hosts
5. Comprehensive error handling

## Design Decisions Log

*Decisions and their rationale will be documented here as development progresses*

### Decision 1: Database Choice - PostgreSQL
**Context**: Need to choose between PostgreSQL, CouchDB, or Cassandra

**Decision**: TBD after discussion with Claude

**Questions to explore**:
- Why PostgreSQL over NoSQL for this use case?
- What specific PostgreSQL features are we leveraging?
- At what scale would we need to reconsider?
- Could we use Cassandra for bookings history while keeping PostgreSQL for active bookings?

### Decision 2: Double Booking Prevention Strategy
**Context**: Multiple users might try to book the same slot simultaneously

**Decision**: TBD after exploring options

**Options to compare**:
1. Database unique constraints + row-level locking
2. Optimistic locking with version fields
3. Distributed locks (Redis/Valkey)
4. Serializable transaction isolation
5. Hybrid approach

**Questions**:
- What are the trade-offs of each approach?
- How do they perform under high concurrency?
- What are the failure modes?

### Decision 3: Availability Caching Strategy
**Context**: Calculating availability is expensive (merges multiple data sources)

**Decision**: TBD after performance testing

**Questions**:
- What should the cache TTL be?
- How to invalidate cache when bookings change?
- Should we cache at slot level or result level?
- What's the cache hit ratio we should target?

### Decision 4: Calendar Sync Approach
**Context**: Need to keep external calendar events synchronized

**Decision**: TBD after researching calendar APIs

**Options**:
1. Periodic polling (every N minutes)
2. Webhooks/push notifications (Google Calendar supports this)
3. On-demand sync (when user requests availability)
4. Hybrid: webhooks + fallback polling

**Questions**:
- How do different calendar providers handle sync?
- What are the rate limits?
- How stale can the data be?
- What happens if webhook delivery fails?

## Iterations and Learnings

*Development iterations and key learnings will be tracked here*

## Interesting Technical Problems

### Problem 1: The "Booking Race Condition"
**Scenario**: Two invitees simultaneously try to book the last available slot

**Questions to explore**:
- How do we detect this race condition?
- What user experience do we provide when it happens?
- How do we test this scenario?
- Can we prevent it entirely or just handle it gracefully?

### Problem 2: Time Zone Edge Cases
**Scenario**: User in New York schedules availability, invitee in Tokyo books a slot during DST transition

**Questions**:
- How do we handle DST transitions?
- What if the meeting time becomes invalid after DST change?
- How do we communicate the meeting time clearly to both parties?
- Should we warn users about DST transitions?

### Problem 3: Calendar API Failures During Booking
**Scenario**: User books a meeting, but Google Calendar API is down when we try to create the event

**Questions**:
- Do we fail the booking or queue the calendar event creation?
- How do we retry failed calendar events?
- How do we communicate this to the user?
- Should we check calendar availability before booking or trust our cache?

### Problem 4: Optimal Availability Calculation
**Scenario**: User has 5 calendar integrations, each with 100+ events per month

**Questions**:
- How do we efficiently merge all busy periods?
- What data structures optimize this operation?
- Can we pre-compute anything?
- At what point do we need to paginate results?

## Questions and Discussions

### Open Questions
1. Should we support recurring meetings?
2. How do we handle group meetings (multiple attendees)?
3. Should we support team scheduling (round-robin across team members)?
4. What analytics should we provide to users?
5. How do we handle different calendar event types (tentative vs. confirmed)?

### Discussions to Have with Claude
1. **Availability Algorithm Deep Dive**
   - "I want to understand the availability calculation algorithm deeply. Let's explore:
     - Different algorithmic approaches (interval merging, segment trees, etc.)
     - Time complexity analysis
     - Space complexity and optimization opportunities
     - Implementation in TypeScript with tests"

2. **Database Transaction Design**
   - "For preventing double bookings, let's compare:
     - SERIALIZABLE isolation level
     - SELECT FOR UPDATE with row locking
     - Optimistic locking with version fields
     - Application-level distributed locks
     - Implement each and discuss trade-offs"

3. **Time Zone Handling**
   - "Time zones are complex. Let's discuss:
     - Storing UTC vs. local times
     - Libraries (moment-timezone, Luxon, date-fns-tz)
     - Edge cases (DST, leap seconds, deprecated time zones)
     - How to test time zone logic thoroughly"

4. **Calendar API Integration Patterns**
   - "Let's design the calendar integration layer:
     - How to abstract different providers (Google, Outlook, iCal)?
     - Error handling and retry strategies
     - Token refresh logic
     - Rate limiting and backoff
     - Testing without hitting real APIs"

## Resources and References

**Calendar APIs**:
- [Google Calendar API Documentation](https://developers.google.com/calendar)
- [Microsoft Graph API (Outlook)](https://docs.microsoft.com/en-us/graph/api/resources/calendar)

**Time Zone Resources**:
- [IANA Time Zone Database](https://www.iana.org/time-zones)
- [Moment Timezone](https://momentjs.com/timezone/)
- [You Don't Need Moment.js](https://github.com/you-dont-need/You-Dont-Need-Momentjs)

**Scheduling Algorithms**:
- [Interval Scheduling Problem](https://en.wikipedia.org/wiki/Interval_scheduling)
- [Merge Intervals Algorithm](https://leetcode.com/problems/merge-intervals/)

**System Design References**:
- [Designing Calendar/Scheduling Systems](https://www.youtube.com/watch?v=3qgLcmGCCjE)
- [Building Calendly - Engineering Blog](https://www.calendly.com/blog)

## Next Steps

- [ ] Discuss high-level architecture with Claude
- [ ] Deep dive into double-booking prevention strategies
- [ ] Design the availability calculation algorithm
- [ ] Choose technology stack (confirm Node.js + PostgreSQL)
- [ ] Sketch database schema
- [ ] Implement MVP (basic availability + booking)
- [ ] Add Google Calendar integration
- [ ] Add caching layer
- [ ] Load test and optimize
- [ ] Polish UX and error handling

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings from collaboration with Claude.*

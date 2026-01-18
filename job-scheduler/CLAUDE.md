# Job Scheduler - Development with Claude

## Project Context

This document tracks the development journey of implementing a distributed task scheduling system.

## Key Challenges to Explore

1. Distributed coordination
2. At-least-once execution
3. Priority scheduling
4. Failure handling

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Decisions made:**
- Used system-design-answer.md as the architecture blueprint
- Chose PostgreSQL for job storage (ACID compliance, relational model)
- Chose Redis for queues and distributed locking (speed, atomic operations)
- Designed for horizontal worker scaling

### Phase 2: Initial Implementation
*In progress*

**Focus areas:**
- [x] Implement core functionality
- [x] Get something working end-to-end
- [x] Validate basic assumptions

**Completed components:**
- Backend API server with Express
- Scheduler service with leader election
- Worker service with retry logic
- Frontend dashboard with React + TanStack Router
- Docker Compose for local development

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

### 2024-01-XX: Initial Architecture

**Decision**: Use Redis-based leader election for scheduler
- **Rationale**: Simple implementation using `SET NX EX`
- **Trade-off**: Single scheduler active at a time, but ensures no duplicate scheduling
- **Alternative considered**: Multiple schedulers with database-level locking (more complex)

**Decision**: Use Redis sorted sets for priority queue
- **Rationale**: O(log n) insertion, O(1) pop, built-in ordering
- **Trade-off**: Memory-bound, but acceptable for expected scale
- **Alternative considered**: PostgreSQL queue table (slower, but more durable)

**Decision**: Visibility timeout for at-least-once execution
- **Rationale**: Jobs in processing have a timeout; if not completed, they are recovered
- **Trade-off**: Possible duplicate execution if timeout is too short
- **Alternative considered**: Distributed transaction (overkill for this use case)

**Decision**: Separate scheduler and worker processes
- **Rationale**: Clear separation of concerns, independent scaling
- **Trade-off**: More processes to manage
- **Alternative considered**: Combined process (simpler, but less flexible)

**Decision**: PostgreSQL for job definitions and history
- **Rationale**: ACID compliance, complex queries for reporting
- **Trade-off**: Scaling limits at very high volume
- **Alternative considered**: MongoDB (flexible schema, but less suited for transactional workloads)

### Handler System

**Decision**: Plugin-based handler architecture
- **Rationale**: Easy to add new job types without modifying core logic
- **Trade-off**: Handlers must be registered at startup
- **Alternative considered**: Dynamic handler loading (more complex, security concerns)

### Frontend Architecture

**Decision**: Zustand for state management
- **Rationale**: Simple, lightweight, TypeScript-friendly
- **Trade-off**: Less opinionated than Redux
- **Alternative considered**: Redux Toolkit (more boilerplate)

**Decision**: TanStack Router for routing
- **Rationale**: Type-safe routing, modern API
- **Trade-off**: Steeper learning curve than React Router
- **Alternative considered**: React Router (more common, but less type-safe)

## Iterations and Learnings

### Iteration 1: Basic MVP
- Created job CRUD API
- Implemented simple scheduler loop
- Added worker with basic execution

### Iteration 2: Reliability Features
- Added leader election for scheduler
- Implemented visibility timeout for queue
- Added exponential backoff retries
- Created dead letter queue

### Iteration 3: Dashboard
- Built React frontend with job management
- Added execution monitoring
- Created worker status page

## Questions and Discussions

### Open Questions

1. **Job dependencies**: How to implement DAG-based workflows?
   - Current: Not implemented
   - Future: Could add `dependencies` field and trigger on completion

2. **Multi-tenancy**: How to isolate jobs between tenants?
   - Current: Single-tenant
   - Future: Add tenant_id to jobs table, separate queues per tenant

3. **Rate limiting**: How to prevent job flooding?
   - Current: Not implemented
   - Future: Token bucket per job type or tenant

### Resolved Questions

1. **How to handle time zones?**
   - Resolution: Store all times in UTC, convert on display
   - Cron expressions interpreted as UTC

2. **How to scale workers?**
   - Resolution: Stateless workers, auto-scale based on queue depth
   - Each worker polls the shared Redis queue

## Resources and References

- [Designing a Distributed Job Scheduler](https://levelup.gitconnected.com/designing-a-distributed-job-scheduler-461ac0c3a9e8)
- [Building a Job Queue with Redis](https://redis.io/docs/patterns/queues/)
- [cron-parser npm package](https://www.npmjs.com/package/cron-parser)
- [TanStack Router Documentation](https://tanstack.com/router/latest)

## Next Steps

- [ ] Add comprehensive tests (unit, integration, e2e)
- [ ] Implement job dependencies
- [ ] Add metrics/monitoring (Prometheus, Grafana)
- [ ] Implement job rate limiting
- [ ] Add webhook notifications for job completion/failure
- [ ] Performance testing under load

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

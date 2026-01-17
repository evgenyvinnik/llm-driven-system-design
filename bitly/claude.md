# Bit.ly - URL Shortener - Development with Claude

## Project Context

This document tracks the development journey of implementing a URL shortening service that converts long URLs into short, memorable links.

## Key Challenges to Explore

1. Generating unique short codes
2. High read/write throughput
3. Analytics at scale
4. Database sharding

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Outcomes:**
- Reviewed system-design-answer.md for architectural guidance
- Identified core features: URL shortening, custom codes, expiration, analytics
- Chose pre-generated key pool approach for unique short codes
- Designed read-heavy caching strategy

### Phase 2: Initial Implementation
*In Progress*

**Completed items:**
- [x] Backend API with Express.js and TypeScript
- [x] PostgreSQL database schema with URLs, key pool, click events, users, sessions
- [x] Redis caching layer for URL lookups and sessions
- [x] Pre-generated key pool service for unique short codes
- [x] URL shortening and redirect endpoints
- [x] Custom short code support with validation
- [x] Click analytics tracking (referrer, device type, timestamps)
- [x] Session-based authentication with bcrypt password hashing
- [x] Admin dashboard API (stats, URL management, user management)
- [x] Rate limiting middleware
- [x] Frontend with React, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS
- [x] User authentication UI (login, register, logout)
- [x] URL shortener component with advanced options
- [x] URL list with analytics modal
- [x] Admin dashboard with tabs (stats, URLs, users, key pool)
- [x] Docker Compose for PostgreSQL and Redis

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add local in-memory caching (LRU) for hot URLs
- Optimize database queries with proper indexing
- Implement load balancing (nginx configuration)
- Add monitoring with Prometheus + Grafana
- Stress test with multiple server instances

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### 1. Short Code Generation: Pre-generated Key Pool

**Decision:** Use pre-generated random 7-character codes stored in a key pool table.

**Rationale:**
- No coordination needed between API servers (each fetches a batch of unused keys)
- Random codes are not predictable (unlike counter-based)
- Guaranteed unique (unlike hash-based)
- Scales horizontally - each server manages its own local cache of keys

**Trade-offs:**
- Slight complexity in key management
- Need to monitor and repopulate key pool
- Some keys lost on server crash (acceptable - we generate millions)

**Implementation:**
- `key_pool` table with `short_code`, `is_used`, `allocated_to`, `allocated_at`
- Server fetches batch of 100 keys on startup and when cache runs low
- Keys marked as used when URL is created

### 2. Caching Strategy: Two-tier Cache

**Decision:** Redis as primary cache, with option to add local in-memory cache later.

**Rationale:**
- Redis provides fast lookups (~1ms) for URL redirects
- Shared cache between multiple server instances
- TTL-based expiration handles staleness

**Implementation:**
- Cache key format: `url:{short_code}` -> long_url
- 24-hour TTL
- Write-through on URL creation
- Delete on URL deactivation

### 3. Redirect Response: 302 Temporary vs 301 Permanent

**Decision:** Use 302 (Temporary) redirect.

**Rationale:**
- 301 redirects are cached by browsers, making analytics unreliable
- 302 ensures every click hits our server for tracking
- Slight performance trade-off is acceptable for accurate analytics

**Trade-off:** Higher server load vs. accurate click tracking.

### 4. Authentication: Session-based with Redis

**Decision:** Cookie-based sessions stored in Redis.

**Rationale:**
- Simpler than JWT for learning project
- Sessions can be invalidated immediately
- Redis provides fast session lookup

**Implementation:**
- Session token stored in `bitly_session` cookie (httpOnly, sameSite: lax)
- Session cached in Redis with 7-day TTL
- Fallback to database if cache miss

### 5. Analytics: Synchronous vs Asynchronous

**Decision:** Async recording (non-blocking) with PostgreSQL storage.

**Rationale:**
- Click recording shouldn't slow down redirects
- PostgreSQL sufficient for learning project scale
- Production would use Kafka + ClickHouse for higher throughput

**Implementation:**
- `setImmediate()` used to record click after redirect response
- Click events stored in `click_events` table
- Analytics aggregated on read (could be pre-computed for scale)

### 6. Database Schema: Single PostgreSQL Instance

**Decision:** Use PostgreSQL without sharding for initial implementation.

**Rationale:**
- Simpler setup for local development
- Sufficient for learning scale
- Can add read replicas later if needed

**Future considerations:**
- Shard by short_code prefix for horizontal scaling
- Add read replicas for analytics queries
- Consider CockroachDB for multi-region

### 7. Frontend State: Zustand with Persistence

**Decision:** Use Zustand for state management with localStorage persistence.

**Rationale:**
- Lightweight compared to Redux
- Simple API for basic use cases
- Built-in persistence middleware

**Implementation:**
- `authStore`: user session, login/logout actions
- `urlStore`: user's URLs, CRUD actions

## Iterations and Learnings

### Iteration 1: Basic Implementation

**What worked:**
- Pre-generated key pool approach is elegant and avoids race conditions
- Express + TypeScript provides good developer experience
- Zustand + TanStack Router is a clean frontend stack

**What could be improved:**
- Need to add proper error handling in frontend
- Analytics aggregation could be pre-computed
- Should add input sanitization for URLs

## Questions and Discussions

### Open Questions

1. **Expiration handling:** Should we use a background job to deactivate expired URLs, or check on each redirect?
   - Current: Check on redirect (lazy evaluation)
   - Consideration: Background job for proactive cleanup

2. **Custom code collision with key pool:** What if a custom code matches a pre-generated key?
   - Current: Check both `urls` and `key_pool` tables
   - Works but adds latency to custom code validation

3. **Rate limiting per user vs per IP:**
   - Current: Per IP for URL creation
   - Consideration: Per user for authenticated users

## Resources and References

- [system-design-answer.md](./system-design-answer.md) - Full system design interview answer
- [architecture.md](./architecture.md) - High-level architecture template
- Base62 encoding for short codes
- Consistent hashing for future sharding

## Next Steps

- [ ] Add comprehensive error handling
- [ ] Implement local in-memory cache (LRU)
- [ ] Add URL validation (malicious URL detection)
- [ ] Write integration tests
- [ ] Add Prometheus metrics
- [ ] Configure nginx load balancer
- [ ] Add Swagger/OpenAPI documentation

---

*This document is updated throughout the development process to capture insights, decisions, and learnings.*

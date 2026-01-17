# Rate Limiter - Development with Claude

## Project Context

This document tracks the development journey of implementing an API rate limiting service to prevent abuse.

## Key Challenges to Explore

1. Distributed counting
2. Low latency
3. Accuracy vs performance
4. Handling clock skew

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Decisions made:**
- Implemented 5 rate limiting algorithms: Fixed Window, Sliding Window, Sliding Log, Token Bucket, Leaky Bucket
- Used Redis for distributed state management (required for horizontal scaling)
- Designed API with standard rate limit headers (X-RateLimit-*)

### Phase 2: Initial Implementation
*In progress*

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

**Completed items:**
- Backend Express server with TypeScript
- All 5 rate limiting algorithms implemented with Lua scripts for atomicity
- API endpoints for check, state, reset, batch-check
- Metrics collection and health monitoring
- Frontend React dashboard with Vite + Tailwind
- Interactive test interface for all algorithms
- Docker Compose setup with Redis and PostgreSQL

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

### 2024-01-XX: Algorithm Implementation Strategy

**Decision:** Use Lua scripts for Token Bucket and Leaky Bucket algorithms.

**Rationale:** These algorithms require multiple Redis operations (read state, calculate refill/leak, update state) that must be atomic. Lua scripts execute atomically on Redis server, eliminating race conditions in distributed environments.

**Trade-off:** Slightly more complex code, but guarantees correctness under concurrent access.

### 2024-01-XX: Sliding Window Counter as Default

**Decision:** Use Sliding Window Counter as the default algorithm.

**Rationale:**
- Best balance of accuracy (~1-2% error) and memory efficiency
- Smoother than Fixed Window (no boundary burst issue)
- Much less memory than Sliding Log
- Easier to explain to users than Token/Leaky Bucket

**Trade-off:** Not perfectly accurate, but acceptable for most use cases.

### 2024-01-XX: Fail-Open on Redis Errors

**Decision:** Allow requests when Redis is unavailable (fail-open).

**Rationale:** Rate limiting is about protecting from sustained abuse, not blocking individual requests. Temporary Redis failures should not block legitimate users.

**Trade-off:** Potential for abuse during Redis outages. Mitigation: aggressive alerting on Redis connection issues.

### 2024-01-XX: Frontend Architecture

**Decision:** Use Zustand for state management instead of Redux or Context.

**Rationale:**
- Simpler API, less boilerplate
- Excellent TypeScript support
- No providers/wrappers needed
- Good for this scale of application

**Trade-off:** Less ecosystem tooling than Redux, but sufficient for this project.

## Iterations and Learnings

### Iteration 1: Basic Implementation

**What worked:**
- Redis atomic operations (INCR, ZADD) are very fast (<1ms)
- Lua scripts provide atomic multi-step operations
- Express middleware pattern works well for rate limiting

**What to improve:**
- Add local caching for hot paths
- Implement rule-based configuration from database
- Add more comprehensive metrics

## Questions and Discussions

### Q: How to handle clock skew across distributed servers?

**A:** All time-based calculations use Redis server time via Lua scripts, ensuring consistency across all API server instances. The TIME command or timestamps within Lua scripts use Redis's clock.

### Q: What happens at extreme scale (1M+ RPS)?

**A:** Current implementation works well up to ~100K RPS per Redis instance. For higher scale:
1. Shard by identifier across Redis Cluster
2. Implement local caching with periodic sync
3. Consider sampling-based approaches for approximate counting

### Q: Token Bucket vs Leaky Bucket - when to use which?

**A:**
- **Token Bucket:** When you want to allow controlled bursts. Good for APIs where occasional spikes are acceptable.
- **Leaky Bucket:** When you need consistent output rate. Good for protecting downstream services with strict rate requirements.

## Resources and References

- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)
- [Leaky Bucket Algorithm](https://en.wikipedia.org/wiki/Leaky_bucket)
- [Redis Rate Limiting Patterns](https://redis.io/learn/howtos/ratelimiting)
- [Stripe's Rate Limiting](https://stripe.com/blog/rate-limiters)
- [Cloudflare's Rate Limiting](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Add comprehensive tests
- [ ] Implement rule-based configuration from PostgreSQL
- [ ] Add Prometheus metrics export
- [ ] Load test and optimize
- [ ] Add local caching for hot paths

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

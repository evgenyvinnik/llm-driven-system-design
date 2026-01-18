# Design Scalable API - Development with Claude

## Project Context

Building a scalable API system to understand horizontal scaling, traffic management, and high-availability patterns.

**Key Learning Goals:**
- Build horizontally scalable services
- Design effective caching strategies
- Implement rate limiting and circuit breakers
- Create comprehensive observability

---

## Key Challenges to Explore

### 1. Horizontal Scaling

**Challenge**: Add capacity by adding instances

**Approaches:**
- Stateless design
- Shared nothing architecture
- Load balancer distribution
- Connection pooling

### 2. Traffic Management

**Problem**: Protect from abuse and overload

**Solutions:**
- Rate limiting (token bucket, sliding window)
- Circuit breakers
- Request queuing
- Graceful degradation

### 3. Latency Optimization

**Challenge**: Maintain fast response times at scale

**Solutions:**
- Multi-level caching
- Connection reuse
- Async processing
- Query optimization

---

## Development Phases

### Phase 1: Foundation (Completed)
- [x] API server framework
- [x] Load balancer setup
- [x] Health checks
- [x] Request logging

### Phase 2: Performance (In Progress)
- [x] Caching layer (local + Redis two-level cache)
- [x] Connection pooling (PostgreSQL pool)
- [ ] Query optimization
- [x] Compression (gzip via Express)

### Phase 3: Protection (In Progress)
- [x] Rate limiting (sliding window with Redis)
- [x] Circuit breakers (per-dependency)
- [x] Authentication (session-based with Redis)
- [x] Input validation (basic)

### Phase 4: Observability (In Progress)
- [x] Metrics collection (Prometheus-compatible)
- [ ] Distributed tracing
- [ ] Alerting
- [x] Dashboards (React admin dashboard)

---

## Implementation Notes

### Architecture Decisions

1. **Two-Level Caching**: Local in-memory cache (5s TTL) + Redis (configurable TTL)
   - Reduces Redis round-trips for hot data
   - Local cache auto-populates from Redis hits

2. **Sliding Window Rate Limiting**: Using Redis sorted sets
   - More accurate than fixed window
   - Atomic operations for distributed correctness

3. **Circuit Breaker Pattern**: Per-dependency isolation
   - Prevents cascading failures
   - Half-open state for recovery testing

4. **Load Balancer**: Least connections with weights
   - Better distribution than round-robin
   - Dynamic weight adjustment based on health

### Files Created

**Backend:**
- `backend/api-server/src/index.js` - API server with caching, circuit breakers
- `backend/gateway/src/index.js` - API gateway with rate limiting
- `backend/load-balancer/src/index.js` - Load balancer with health checks
- `backend/shared/services/` - Cache, rate limiter, circuit breaker, metrics
- `backend/shared/middleware/` - Auth, logging, error handling

**Frontend:**
- `frontend/src/components/Dashboard.tsx` - Admin dashboard
- `frontend/src/stores/` - Zustand state management
- `frontend/src/services/api.ts` - API client

**Database:**
- `database/schema.sql` - Full schema with users, API keys, request logs
- `database/migrations/` - Partitioning migration

### Testing the Implementation

```bash
# Start infrastructure
docker-compose -f docker-compose.dev.yml up -d

# Start backend services (in separate terminals)
cd backend && npm install
npm run dev:gateway    # Port 8080
npm run dev:lb         # Port 3000
npm run dev:server1    # Port 3001
npm run dev:server2    # Port 3002
npm run dev:server3    # Port 3003

# Start frontend
cd frontend && npm install && npm run dev

# Test rate limiting
for i in {1..150}; do curl -s http://localhost:8080/api/v1/status | jq; done

# Test load balancing
for i in {1..10}; do curl -s http://localhost:3000/api/v1/status | jq '.instanceId'; done
```

---

## Next Steps

1. **Query Optimization**
   - Add database indexes
   - Implement query result caching
   - Add slow query logging

2. **Distributed Tracing**
   - Propagate trace IDs across services
   - Add Jaeger/Zipkin integration

3. **Alerting**
   - Define SLIs/SLOs
   - Configure alerting rules
   - Add PagerDuty/Slack integration

4. **Load Testing**
   - Create k6 or Artillery scripts
   - Identify bottlenecks
   - Tune configurations

---

## Resources

- [12-Factor App](https://12factor.net/)
- [Nginx Load Balancing](https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/)
- [Prometheus Metrics](https://prometheus.io/docs/concepts/metric_types/)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Rate Limiting Algorithms](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)

# Scalable API — Development with Claude

## Project Context

Most projects in this repo *use* an API; this one is about the API tier itself. The premise: a single Express process is easy — the interesting problems appear when you put a load balancer in front of three identical instances and have to answer "which instance?", "is this response cacheable?", "is this caller abusive?", and "is this dependency down?" without any instance knowing what the others are doing.

Everything here is deliberately a *shared-nothing* design: instances hold no session state, no sticky affinity, no local coordination. The state that must be shared (rate-limit counters, cache, sessions) lives in Redis, which is what makes "add another instance" a real scaling lever rather than a lie.

**Learning goals:** horizontal scaling behind a load balancer, multi-level caching and its invalidation cost, distributed rate limiting that stays correct across instances, circuit breakers for dependency isolation, and the observability needed to see any of it working.

## Architecture at a Glance (what actually runs)

Five backend processes, started together by `npm run dev` (→ `dev:all` via `concurrently`):

| Process | Port | Role |
|---------|------|------|
| **Gateway** (`gateway/src/index.ts`) | **8080** | Public entry point. Rate limiting, auth, request ID assignment, routing to the LB. This is the port the frontend talks to |
| **Load balancer** (`load-balancer/src/index.ts`) | 3000 | Least-connections distribution across the API instances, with health-check-driven ejection |
| **API server ×3** (`api-server/src/index.ts`) | 3001, 3002, 3003 | Identical stateless instances, distinguished only by `INSTANCE_ID` |

Shared modules in `backend/shared/services/` — `cache.ts`, `rate-limiter.ts`, `circuit-breaker.ts`, `metrics.ts`, `queue.ts`, `database.ts`, `logger.ts`, `retention.ts` — are imported by all three tiers so behavior is identical wherever it runs. Background workers (`audit-worker.ts`, `notification-worker.ts`, `task-worker.ts`) consume from RabbitMQ. Infrastructure: PostgreSQL + Redis (`docker-compose.dev.yml` for just the stores; `docker-compose.yml` additionally containerizes gateway and frontend). Frontend is a React admin dashboard showing live metrics, per-endpoint request stats, circuit-breaker states, and cache hit rates.

**Port note:** the gateway on **8080** is the backend port for this project, not the repo-default 3000 — 3000 is the load balancer, which sits *behind* the gateway. `scripts/screenshot-configs/scalable-api.json` sets `"backendPort": 8080` for exactly this reason.

## Key Design Decisions

### 1. Two-level cache: in-process (5s) in front of Redis
A read checks a local in-memory map first, then Redis, then Postgres — and a Redis hit back-fills the local map. The local tier exists because at high RPS even a 1ms Redis round-trip dominates the response time of an otherwise trivial handler, and it costs a network hop per request per instance. What we give up is coherence: for up to 5 seconds, three instances can serve three different versions of the same key, and an invalidation in Redis doesn't reach the local maps. That is only acceptable because the cached data here is dashboard/metric-shaped (staleness is invisible), and the TTL is deliberately short enough that no human notices. For anything user-mutable, the local tier would need pub/sub invalidation — the complexity we're explicitly avoiding at this scale.

### 2. Sliding-window rate limiting in Redis sorted sets, not per-instance counters
The naive approach — an in-memory counter per instance — is wrong the moment you scale out: with 3 instances and a 100 req/min limit, a caller effectively gets 300, and the limit changes every time you add capacity. So the limiter stores one sorted-set entry per request keyed by timestamp, trims entries outside the window, and counts what remains — atomically, in Redis, so all instances see one shared view. Sliding window over fixed window because a fixed window lets a caller send 2× the limit across a boundary (100 at 0:59, 100 at 1:00). The cost is real: one sorted set per caller, N entries per window, plus the trim — meaningfully more memory and CPU than an `INCR` counter. That's the price of a limit that means the same thing regardless of instance count.

### 3. Least-connections load balancing over round-robin
Round-robin assumes requests are interchangeable; they aren't. One slow endpoint pins an instance while round-robin keeps feeding it new work at the same rate as its idle peers. Least-connections routes to the instance with the fewest in-flight requests, which self-corrects — a struggling instance naturally receives less. The trade-off is that the balancer must now track per-instance in-flight state, so it is stateful in a way round-robin isn't; that state is per-balancer, which is fine with one balancer but becomes an approximation if you run several.

### 4. Circuit breakers per dependency, not per service
Each external dependency gets its own breaker, so a failing one degrades only what depends on it instead of taking down the process. Without this, a hung dependency consumes request-handling capacity until the whole instance is unresponsive — the classic cascade, where a non-critical dependency causes total outage. Trade-off: an open breaker fails fast, which means rejecting requests that *might* have succeeded; the half-open state exists to bound how long we stay pessimistic. Current breaker states are exported to the dashboard, because a breaker you can't observe is an unexplained outage.

### 5. Demo-grade auth, deliberately
Sessions live in Redis (not in-process), which is the part that actually matters for this project's thesis: any instance can serve any request because no instance owns the session. The credential check itself is minimal — this project is about the API tier, not about authentication.

## Current State

Runs end to end: gateway (8080) + load balancer (3000) + three API instances (3001–3003) started by one `npm run dev`, two-level caching, Redis sliding-window rate limiting, per-dependency circuit breakers, Prometheus-style metrics, structured logging with request IDs, RabbitMQ workers (audit, notification, task), PostgreSQL schema in `database/schema.sql` with a partitioning migration, and a React admin dashboard that renders live uptime/heap/cache-hit-rate/per-endpoint 2xx-4xx-5xx breakdowns and circuit-breaker state. Seeded login: `alice@example.com` / `password123` (admin).

Not implemented: distributed tracing (request IDs propagate, but there's no Jaeger/Zipkin collector), alerting rules, query optimization beyond the existing indexes, and load-test scripts (k6/Artillery) — the dashboard currently shows only the traffic you generate by hand.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md (Phase 2/3/4 "In Progress" boxes that didn't reflect what was built) with this architecture/decision/state structure. The old file also never explained the gateway-vs-LB port split, which is the single most confusing thing about running this project.
- **Backend port corrected in the screenshot config:** the harness assumed 3000 (the load balancer) and so probed a port the frontend never uses; set to **8080** (the gateway). Before the fix the harness proceeded before the gateway was listening.
- **Harness login detection (repo-wide fix, surfaced here):** this project's login page and dashboard are *both* at `/`, so the harness's "did the URL change after submit?" check could never pass and it reported a false login failure — while its own debug screenshot showed a fully logged-in dashboard. `scripts/screenshots.mjs` now decides success by whether the credential field disappeared, not by URL change. Verified: login=OK, 2/2 screens captured.
- **Backend port resolution (repo-wide):** `scripts/screenshots.mjs` now derives the backend port from config → `PORT=` in the `dev` script → the Vite proxy target → 3000, instead of hardcoding 3000.
- **2026-08-05 — the dashboard's own panels were permanently empty, and one of them was hiding a routing gap.** Cache hit rate read 0.0% and "No circuit breakers registered" on every run, because these are live counters produced by traffic and nothing had generated any. The screenshot config now drives the dashboard's own action buttons (`data-testid="action-{id}"`), which takes cache hit rate to 66.7% and registers the breaker.
  - Driving it surfaced a real bug: **"Test External Service" returned 404.** The frontend calls `/api/v1/external`, and that handler exists only on the **api-server** (3001–3003). The gateway serves `/status`, `/me`, `/resources` and `/resources/:id` itself and had no `/external`, so the button 404'd and the Circuit Breakers panel could never populate. Added the route to the gateway, wired to `circuitBreakerRegistry`.
- **⚠️ Open architectural gap found while fixing the above: the gateway never forwards to the load balancer.** There is no proxy, `fetch`, or LB URL anywhere in `gateway/src/index.ts` — it answers every route in-process. So the load balancer and the three API instances are health-checked and displayed on the dashboard but receive **no API traffic** (their "Requests: 0" is literal). This contradicts the Architecture table above, which describes the gateway as "routing to the LB", and it means decision 3 (least-connections) is currently unexercised. Closing it means giving the gateway a real proxy hop to `localhost:3000` for unmatched `/api/v1/*` paths — deliberately **not** done here, because it changes the request path for every endpoint and deserves its own pass rather than being bolted onto a screenshot fix.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. The 5s local cache tier has no invalidation path — at what read/write ratio does it stop being worth the staleness, and is pub/sub invalidation cheaper than just deleting the tier?
2. Sliding-window sorted sets cost one Redis entry per request. At what RPS does that memory pressure justify switching to a token bucket (approximate, far cheaper) instead?
3. Least-connections state is per-balancer. If we ran two balancers, would the resulting split-brain view of instance load be worse than plain round-robin?
4. Request IDs already propagate through gateway → LB → instance. Is adding a real tracing backend the highest-value next step, or is per-endpoint p99 in the dashboard already enough to find the slow path?

## Resources

- [12-Factor App](https://12factor.net/) — the stateless-process discipline this project is built on
- [Cloudflare: how we count things](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) — sliding-window rate limiting trade-offs
- [Martin Fowler: Circuit Breaker](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Nginx load balancing methods](https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/) — least-connections vs round-robin
- [Prometheus metric types](https://prometheus.io/docs/concepts/metric_types/)

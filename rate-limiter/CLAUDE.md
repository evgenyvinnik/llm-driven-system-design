# Rate Limiter — Development with Claude

## Project Context

A distributed API rate-limiting service: given an identifier (user, IP, API key), decide in sub-millisecond time whether a request is allowed, and stay correct when many gateway nodes ask about the same identifier at once. It implements **five** classic algorithms behind one interface so the trade-offs are visible side by side. The hard problem is *correctness under concurrency without adding latency* — a rate check sits in front of every API call, so it must be atomic yet nearly free.

**Learning goals:** the five rate-limiting algorithms and their accuracy/memory trade-offs, why atomicity requires Redis Lua scripts, fail-open vs. fail-closed degradation, and circuit-breaking a dependency that's on every request's critical path.

## Architecture at a Glance (what actually runs)

Redis is the star; the rest support config and analytics. From `docker-compose.yml`:

| Store | Role | Why this one |
|-------|------|--------------|
| **Valkey/Redis** (`ioredis`) | Live rate-limit counters/state for all 5 algorithms, executed via **Lua scripts** | In-memory + server-side Lua = atomic read-compute-write in <1ms; the only thing fast enough to gate every request |
| **PostgreSQL** (`pg`) | `rate_limit_rules` (config) + `rate_limit_metrics` (aggregated history) | Durable rule storage and historical analytics — data that outlives ephemeral counters |
| **RabbitMQ** (`amqplib`) | `rate-limit-events` → analytics worker; `metrics-aggregation` → metrics worker | Moves auditing/analytics off the hot path so the check response never waits on Postgres |
| **redis-commander** (`dev` profile) | Redis inspection UI (`:8081`) | Debugging only; not part of the runtime |

Backend (Express, port **3001**, no auth — it's a service): `algorithms/` (fixed-window, sliding-window, sliding-log, token-bucket, leaky-bucket over a common `base`), `middleware/rate-limit.ts`, `shared/circuit-breaker.ts` (Opossum), `metrics` (prom-client), `queue`, two `workers/`. Frontend: React 19 + Zustand + Tailwind — an interactive tester that exercises every algorithm.

## Key Design Decisions

### 1. Lua scripts for atomic read-compute-write
Token Bucket and Leaky Bucket must read current state, compute refill/leak since last access, and write back — three steps that, if interleaved between two gateway nodes, both read "1 token left" and both allow a request, spending a budget of 1 twice. Running the whole sequence as a Redis Lua script makes it atomic on the server, eliminating the race. Trade-off given up: logic in Lua is harder to write/debug than TypeScript, but correctness under concurrency is non-negotiable for a limiter.

### 2. Sliding Window Counter as the default
Of the five, sliding-window-counter is the default: ~1–2% error, far less memory than Sliding Log (which stores every timestamp), and no boundary-burst problem that Fixed Window has (where 2× the limit can pass across a window edge). Trade-off: it's approximate, not exact like Sliding Log — accepted because for abuse protection "roughly N per window, smoothly" beats "exactly N but with a memory cost per request."

### 3. Fail-open on Redis failure (configurable)
When Redis is unavailable, the default is to **allow** requests. Rate limiting protects against *sustained* abuse; blocking every legitimate user because the limiter's datastore blipped is worse than briefly under-enforcing. This is configurable per-endpoint via `DEGRADATION_MODE` — security-critical paths (auth, payment) should fail-*closed* because unauthorized access costs more than brief unavailability. Trade-off: a real abuse window exists during a Redis outage, mitigated by aggressive alerting on Redis health.

### 4. Circuit breaker on every Redis call
All Redis ops are wrapped in an Opossum breaker. Without it, a Redis outage makes every request wait out the connection timeout (3–30s), exhausting the thread pool and turning a limiter failure into a site-wide latency spike. The breaker opens after ~5 failures in 30s and immediately returns the degradation-mode answer instead of hanging. Trade-off: added moving part, but it's the difference between "limiter degrades gracefully" and "limiter takes down everything behind it."

### 5. Redis server time for all clocks
Every time-based calculation uses Redis's clock (via `TIME`/timestamps inside Lua), never the API node's local clock. Distributed gateway nodes can have skewed clocks; anchoring all windows to one clock keeps counts consistent across instances. Trade-off: one more reason the logic must live in Lua on Redis rather than in application code.

## Current State

Implemented end to end: all five algorithms behind a common `check`/`getState`/`reset` interface with Lua-backed atomicity; API endpoints for check, state, reset, and batch-check plus a `/api/demo` and health check; Opossum circuit breaker + fail-open/closed degradation; Prometheus metrics at `/metrics`; RabbitMQ event + metrics-aggregation queues with an analytics worker (auditing → Postgres) and a metrics worker (dashboard aggregation); pino logging; and a React tester UI that drives each algorithm and visualizes headers/state. Standard `X-RateLimit-*` response headers are emitted.

Intentionally omitted / simulated: authentication (the service itself is unauthenticated locally), a rule administration UI (rules live in `rate_limit_rules` but are configured directly), Redis Cluster sharding, local in-process caching for hot identifiers, and TLS to Redis. Postgres rule storage exists but rules are largely static in this build.

## Iteration & Repair Log

- **2026-07 (CLAUDE.md rewrite):** Replaced the template phase checklist (Phase 3 "Scaling" / Phase 4 "Polish" marked *Not started* while the features shipped; Design Decisions dated `2024-01-XX`) with an accurate Current State plus the Architecture table and this log. Added the RabbitMQ analytics/metrics-worker + Postgres roles the old file left out of its decisions. Kept the (correct) Lua / sliding-window-default / fail-open / Zustand reasoning.
- **2026-07 (answer file):** rewrote `system-design-answer-fullstack.md` — it was 261 lines (too shallow) and drew architecture with ASCII `+--+` boxes; replaced with Unicode box diagrams and expanded deep dives.
- **Repo-wide fixes that touched this project:** schema loads from `backend/src/db/init.sql` via the `docker-entrypoint-initdb.d` mount (no `migrate.ts`); DB/Redis/RabbitMQ connection-string fallbacks to docker-compose creds (`postgres:postgres`, RabbitMQ `guest:guest`); `pino`/pino-pretty logging; backend serves on port 3001.
- **2026-07-31 — the dashboard was correct but inert.** Every metric read 0, because this service has nothing to seed: the counters, allow/deny tallies and latencies are live Redis state produced by traffic, not rows in a table. The only honest way to show the limiter working is to *exercise* it, so the screenshot config now drives the built-in test runner (`data-testid="send-request"`) and captures the result — 19 requests, 10 allowed, 9 denied, with real sub-millisecond latencies, which makes the 10-per-window limit visible rather than merely described. Also added an algorithm-switch capture so the five algorithms' trade-off panels are documented.
- **Screenshots:** 1 → 4 (idle dashboard, requests being allowed, requests being rate-limited, and the Token Bucket algorithm view).
- **CI:** the repo-wide smoke-test workflow was removed (no Docker services in CI).

## Open Questions

1. At ~100K RPS per Redis instance the single-node model saturates — is the right next step sharding identifiers across Redis Cluster, or local token-bucket caches that sync periodically (trading accuracy for throughput)?
2. Fail-open is configurable per-endpoint, but who owns the policy per route, and how do we test that security-critical paths are actually set to fail-closed?
3. Sliding Window Counter's 1–2% error is fine for abuse control — is there a billing/quota use case here that needs Sliding Log's exactness, and is its per-request memory acceptable?
4. Rules live in Postgres but are effectively static — what does hot rule reloading (change a limit without redeploy) look like, and how is it cached without reintroducing a per-request DB read?

## Resources

- [Token Bucket](https://en.wikipedia.org/wiki/Token_bucket) / [Leaky Bucket](https://en.wikipedia.org/wiki/Leaky_bucket)
- [Redis rate-limiting patterns](https://redis.io/learn/howtos/ratelimiting) and [Stripe's rate limiters](https://stripe.com/blog/rate-limiters)
- [Cloudflare: counting things at scale](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)

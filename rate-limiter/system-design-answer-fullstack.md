# Rate Limiter - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a distributed rate limiting service with both a robust backend and an interactive dashboard. As a fullstack engineer, I'll focus on the end-to-end rate limit check flow, the API contract between frontend and backend, session-based configuration, and how the dashboard integrates with the rate limiting service. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Request Counting** - Track requests per client/API key across distributed servers
2. **Multiple Algorithms** - Support fixed window, sliding window, token bucket, leaky bucket
3. **Dashboard** - Configure rules, visualize metrics, test rate limits
4. **Response Headers** - Return X-RateLimit-* headers to clients
5. **Batch Testing** - Send multiple requests to observe rate limiting behavior

### Non-Functional Requirements

- **Low Latency** - Rate check must add <5ms to request processing
- **Real-time Dashboard** - Metrics update within 5 seconds
- **Consistency** - Limits respected within 1-5% tolerance
- **Usability** - Intuitive UI for algorithm selection and testing

### Fullstack Considerations

- API contract design between frontend and backend
- Error handling and loading states
- State synchronization between UI and server
- Response header propagation to dashboard

---

## 2. High-Level Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────┐
│                    Frontend Dashboard (React)                     │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────────┐   │
│  │ Algorithm      │  │    Metrics     │  │  Request Tester   │   │
│  │ Configuration  │  │    Charts      │  │  (Test + Headers) │   │
│  └───────┬────────┘  └───────┬────────┘  └─────────┬─────────┘   │
│          │                   │                     │             │
│          └───────────────────┼─────────────────────┘             │
│                              ▼                                   │
│                    ┌──────────────────┐                          │
│                    │  Zustand Store   │                          │
│                    └────────┬─────────┘                          │
└─────────────────────────────┼────────────────────────────────────┘
                              │ REST
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Backend API (Express)                          │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────────┐   │
│  │ Rate Limit     │  │    Metrics     │  │  Check Endpoint   │   │
│  │ Middleware     │  │    Endpoint    │  │  POST /check      │   │
│  └───────┬────────┘  └───────┬────────┘  └─────────┬─────────┘   │
│          │                   │                     │             │
│          └───────────────────┼─────────────────────┘             │
│                              ▼                                   │
│                    ┌──────────────────┐                          │
│                    │ Algorithm Factory│                          │
│                    └────────┬─────────┘                          │
│                             │                                    │
│                    ┌────────▼─────────┐                          │
│                    │ Circuit Breaker  │                          │
│                    └────────┬─────────┘                          │
└─────────────────────────────┼────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌──────────────────┐ ┌────────────────┐ ┌──────────────────┐
│   Redis / Valkey │ │   PostgreSQL   │ │    RabbitMQ      │
│  Lua-atomic      │ │  Rules +       │ │  Events →        │
│  counters (hot)  │ │  metric history│ │  analytics worker│
└──────────────────┘ └────────────────┘ └──────────────────┘
```

> "The shape worth noticing is that only one of those three stores is on the request's critical path. Redis answers the check; Postgres and RabbitMQ are both *downstream of the answer*. That's deliberate — a rate check runs in front of every API call in the system, so anything that isn't strictly required to say allow-or-deny has to be moved off the hot path or it becomes everyone's latency."

---

## 3. The Five Algorithms, and Why the Default Is What It Is

This is the decision the whole service exists to explore, so it's worth being concrete about what each one actually costs.

| Algorithm | Memory per identifier | Accuracy | Failure mode it has |
|-----------|----------------------|----------|---------------------|
| Fixed Window | One counter | Exact within a window | **Boundary burst** — 2× the limit can pass across a window edge |
| Sliding Window Counter | Two counters | ~1–2% error | Approximate by construction |
| Sliding Log | One timestamp *per request* | Exact | Memory grows with traffic; a hot identifier is unbounded |
| Token Bucket | Token count + last-refill time | Exact, burst-tolerant | Needs read-compute-write, so it *must* be atomic |
| Leaky Bucket | Queue depth + last-leak time | Exact, smooths output | Same atomicity requirement; no burst allowance |

**The boundary burst is the concrete reason Fixed Window isn't the default.** With a limit of 100/minute, a client can send 100 requests at 11:59:59 and another 100 at 12:00:01 — 200 requests in two seconds, every one of them "within the limit." The limiter did exactly what it was told and the service still fell over. Sliding Window Counter fixes this by weighting the previous window's count by how far into the current window you are, which smears the boundary out.

> "Sliding Window Counter is the default because its error is in the *safe* direction and its cost is constant. It's approximate — around 1–2% — but it's two integers per identifier regardless of traffic. Sliding Log is exact, and I'd reach for it if this were metering something billable, where being 2% wrong is a refund conversation. But it stores a timestamp per request, so the single identifier you most want to limit — the one hammering you — is the one that costs the most memory. An abuse-control mechanism whose cost scales with abuse is the wrong shape."

**Token Bucket is the one people reach for when bursts are legitimate.** It lets a client that's been quiet spend accumulated tokens all at once, which matches how real clients behave — idle, then a page-load's worth of parallel calls. The cost is that it's the algorithm most exposed to the concurrency problem in the next section.

---

## 4. Deep Dive: Why the Logic Lives in Lua

**The problem:** Token Bucket and Leaky Bucket are read-compute-write. Read the current token count and last-refill timestamp, compute how many tokens have accrued since, decide, write back. Three steps.

Two gateway nodes checking the same identifier at the same moment both read "1 token left", both compute "1 ≥ 1, allow", and both write "0". A budget of one was spent twice. Nothing errored; the limiter simply didn't limit.

| Approach | Correct under concurrency? | Cost |
|----------|---------------------------|------|
| ✅ Redis Lua script | Yes — Redis runs the script atomically, single-threaded | Logic in Lua: harder to write, test and debug than TypeScript |
| ❌ Read + compute in Node, write back | No — the interleaving above | None, and that's the trap: it works perfectly with one node |
| ❌ Distributed lock around the check | Yes | Two round trips plus lock contention, on a path that must be sub-millisecond |
| ❌ `WATCH`/`MULTI` optimistic retry | Yes | Retries under contention — worst exactly when the identifier is hottest |

> "The reason I'd accept writing this in Lua, which nobody enjoys, is that the failure is invisible in every environment where you'd notice it. One node is correct. Your integration tests are correct. It only breaks under real concurrency across instances, which is production — and it breaks *silently*, as slightly-too-permissive limiting that looks like the limit is just set too high."

**Clocks are the same argument.** Every time calculation uses Redis's clock, not the calling node's. Skewed gateway clocks would otherwise put the same identifier in different windows depending on which node it hit — and that's another reason the logic has to be server-side rather than in application code.

---

## 5. Deep Dive: API Contract Design (8 minutes)

### Endpoint Definitions

The API exposes the following endpoints:

| Method | Path | Description | Key Fields |
|--------|------|-------------|------------|
| POST | `/api/ratelimit/check` | Check and consume a rate limit token | Request: identifier, algorithm, limit, windowSeconds, burstCapacity, refillRate, leakRate. Response: allowed, remaining, limit, resetAt (Unix timestamp), algorithm, latencyMs |
| GET | `/api/ratelimit/state/:identifier` | Get current state without consuming | Response: identifier, algorithm, currentCount, limit, remaining, resetAt, tokens (token bucket), water (leaky bucket) |
| DELETE | `/api/ratelimit/reset/:identifier` | Reset rate limit for an identifier | Response: success, identifier |
| POST | `/api/ratelimit/batch-check` | Check multiple identifiers at once | Request: array of check objects. Response: array of results, totalLatencyMs |
| GET | `/api/metrics` | Get aggregated metrics | Response: metric data points with timestamps, plus summary (totalChecks, allowedPercent, deniedPercent, avgLatencyMs, p99LatencyMs) |

### Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1704067260
X-RateLimit-Algorithm: sliding_window
Retry-After: 45  (only when status 429)
```

---

## 6. Deep Dive: End-to-End Rate Check Flow (10 minutes)

### Complete Request Flow

```
Frontend                   Backend                    Redis
   |                          |                         |
   | 1. POST /check           |                         |
   | { identifier, algorithm, |                         |
   |   limit, windowSeconds } |                         |
   |------------------------->|                         |
   |                          |                         |
   |                          | 2. Check algorithm      |
   |                          | 3. Execute Lua script   |
   |                          |------------------------>|
   |                          |                         |
   |                          | 4. Atomic check+update  |
   |                          |<------------------------|
   |                          | { allowed, remaining }  |
   |                          |                         |
   |                          | 5. Record metrics       |
   |                          |------------------------>|
   |                          |                         |
   | 6. Response + headers    |                         |
   |<-------------------------|                         |
   | { allowed, remaining,    |                         |
   |   resetAt, latencyMs }   |                         |
   |                          |                         |
   | 7. Update UI state       |                         |
   v                          v                         v
```

### Backend: Check Endpoint Implementation

The POST `/check` endpoint follows this flow:

1. **Start a performance timer** to measure server-side latency
2. **Parse the request body** — extract identifier, algorithm, and optional configuration (limit defaults to 10, windowSeconds to 60, burstCapacity to 10, refillRate and leakRate to 1)
3. **Validate input** — return 400 if identifier or algorithm is missing
4. **Select and execute the algorithm** — dispatch to the appropriate algorithm handler (fixed, sliding, token, or leaky); return 400 for unknown algorithms
5. **Handle failures gracefully** — if the rate check throws (e.g., Redis down), log a warning and allow the request with remaining = -1 (fail-open)
6. **Record metrics asynchronously** — fire-and-forget the algorithm name, allowed/denied result, and latency
7. **Set response headers** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Algorithm`; add `Retry-After` if denied
8. **Return the response** — status 200 if allowed, 429 if denied, with a JSON body containing allowed, remaining, limit, resetAt, algorithm, and latencyMs

### Frontend: API Service Layer

The frontend API service layer provides five functions that wrap fetch calls to the backend:

- **checkRateLimit(params)** — POSTs to `/api/ratelimit/check` with the algorithm configuration. Measures round-trip client latency and extracts rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Algorithm`, `Retry-After`) from the response.
- **getState(identifier)** — GETs `/api/ratelimit/state/{identifier}` to read current state without consuming a token.
- **resetLimit(identifier)** — DELETEs `/api/ratelimit/reset/{identifier}` to clear the rate limit for testing.
- **batchCheck(checks)** — POSTs an array of check requests to `/api/ratelimit/batch-check` for multi-identifier testing.
- **fetchMetrics()** — GETs `/api/metrics` for dashboard visualization.

### Frontend: Store Integration

The Zustand store provides a `runTest` action that:

1. Reads the selected algorithm and config from the store
2. Calls `checkRateLimit` with the current configuration
3. On success, prepends the result (with a UUID, timestamp, allowed/denied status, remaining count, latency, and response headers) to the test results array, capping at 100 entries
4. On failure, prepends an error entry with the error message

A separate `fetchMetrics` action sets a loading flag, calls the metrics endpoint, and stores both the time-series data points and summary statistics (total checks, allowed/denied percentages, average and p99 latency).

---

## 7. Deep Dive: Error Handling (6 minutes)

### Backend: Centralized Error Handling

The Express error handler middleware logs every error with its stack trace, request path, and method. It then classifies the error by type:

- **ValidationError** returns 400 with code `VALIDATION_ERROR`
- **NotFoundError** returns 404 with code `NOT_FOUND`
- **RateLimitError** returns 429 with code `RATE_LIMITED`
- All other errors return 500 with code `INTERNAL_ERROR`

In development mode, the stack trace is included in the response body for debugging.

### Frontend: Error Boundary and Toast

The frontend uses a React error boundary that catches render errors and displays a fallback UI with the error message and a "Try Again" button that resets the error state.

For transient errors (API failures, network issues), a toast notification system displays messages for 5 seconds before auto-dismissing. The `useToast` hook provides `showToast(message, type)` and `showError(error)` functions, where type can be 'success', 'error', or 'info'.

---

## 8. Deep Dive: Metrics Synchronization (5 minutes)

### Backend: Metrics Collection

The metrics service aggregates rate limit check results into 1-minute time buckets. Each bucket tracks allowed count, denied count, and a list of latency values.

When the `/api/metrics` endpoint is called, the service:

1. Iterates over all buckets, computing p50 and p99 latencies from the sorted latency arrays
2. Sorts data points chronologically
3. Computes summary statistics: total checks, allowed/denied percentages, average latency, and maximum p99 latency across all buckets
4. Cleans up buckets older than 1 hour to bound memory usage

### Frontend: Polling with Auto-Refresh

The dashboard uses a `useMetricsPolling` hook that calls `fetchMetrics` immediately on mount and then at a configurable interval (default 5 seconds). The hook exposes an `isPolling` toggle so users can pause the auto-refresh. The interval is cleaned up on unmount or when polling is disabled.

---

## 9. Deep Dive: What Happens When Redis Is Down

A rate limiter is unusual: it's infrastructure that sits in front of *everything*, so its own failure mode is a product decision, not just an ops one.

| On Redis failure | Consequence | Right for |
|------------------|-------------|-----------|
| ✅ Fail **open** (allow) — the default | A real abuse window while Redis is down | Ordinary API traffic, where the limiter protects against sustained abuse |
| ✅ Fail **closed** (deny) — opt-in per endpoint | Legitimate users blocked during the outage | Auth, payment, anything where unauthorized access costs more than downtime |
| ❌ One global policy | Either you block everyone over a cache blip, or you leave your login endpoint unprotected | Nothing |

> "Defaulting to fail-open is the choice I'd defend hardest, because it sounds wrong. You've built a protection mechanism and you're saying that when it breaks, protection stops. But think about what each failure actually costs: rate limiting defends against *sustained* abuse, and a Redis outage is measured in minutes. Failing open means a few minutes of under-enforcement. Failing closed means every legitimate user is locked out of a working service because a cache they never heard of is unavailable — you've converted a dependency outage into a total outage, which is exactly the amplification the circuit breaker exists to prevent."

**The exception is where the asymmetry flips.** On a login endpoint, failing open means unlimited credential-stuffing attempts for the duration. That damage is permanent in a way downtime isn't — a compromised account doesn't recover when Redis comes back. So the policy is per-endpoint, and the honest admission is that this puts the burden on whoever configures a new route to think about it, which is exactly the kind of decision people get wrong by omission.

**The circuit breaker is what makes either policy survivable.** Without it, a Redis outage doesn't produce a fast fail-open — it produces every request waiting out a 3–30 second connection timeout, exhausting the connection pool and turning "the limiter is degraded" into "the whole site is slow." The breaker opens after repeated failures and returns the degradation-mode answer immediately.

**This surfaces in the UI too**, which is the fullstack half: the dashboard's health panel reports Redis connectivity and breaker state, because an operator looking at a sudden allow-rate of 100% needs to be able to tell "traffic dropped" from "we are failing open and not limiting anything at all." Those are indistinguishable from the request metrics alone.

---

## 10. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| API style | REST | Stateless, cacheable | GraphQL (flexible queries) |
| Metrics delivery | Polling (5s) | Simple, reliable | WebSocket (real-time) |
| Error handling | Centralized | Consistent format | Per-route (flexible) |
| State sync | Optimistic UI | Fast feedback | Wait for confirmation |
| Header passing | Response headers | Standard approach | Body only (simpler) |
| Default algorithm | Sliding Window Counter | ~1–2% error | Sliding Log (exact, unbounded memory per hot identifier) |
| Atomicity | Redis Lua scripts | Logic in Lua is harder to write and debug | Read-compute-write in Node (silently wrong across instances) |
| Clock source | Redis server time | Forces the logic server-side | Node local time (skew splits one identifier across windows) |
| Redis failure | Fail open by default, closed per endpoint | A real abuse window during an outage | One global policy (either blocks everyone or leaves auth unprotected) |
| Redis call wrapping | Circuit breaker | One more moving part | Raw calls (a Redis blip becomes site-wide latency) |

> "If I had to name the single decision that carries the most weight here, it's Lua — not because it's the most interesting, but because it's the only one whose absence is invisible until production. Every other choice on this list fails loudly or measurably. Read-compute-write in application code passes every test you'd think to write and then quietly under-limits the moment you run a second instance."

---

## 11. Testing Strategy

### Backend Integration Tests

The test suite verifies end-to-end behavior:

- **Under limit**: POST a check request with identifier "test-user", sliding algorithm, limit 10, window 60s. Assert status 200, `allowed = true`, `remaining = 9`, and `X-RateLimit-Limit` header equals "10".
- **Over limit**: Exhaust the limit by sending 10 requests for "test-user-2" with fixed algorithm and limit 10. The 11th request should return status 429, `allowed = false`, and include a `Retry-After` header.

### Frontend Component Tests

The RequestTester component test mocks the `checkRateLimit` API call to return an allowed response with 9 remaining. After clicking "Send Request", it waits for the UI to show "Allowed" and display the `X-RateLimit-Remaining: 9` header value.

### The Test That Actually Matters

Both of the above are sequential, and sequential tests cannot catch the bug this system is most likely to have. The Lua decision exists because read-compute-write races across instances; a test that sends request 11 after request 10 has already returned will pass against a completely non-atomic implementation.

So the test worth writing is: **fire N concurrent requests at a limit of N−k and assert exactly N−k were allowed.** Not "at most" — exactly. A limiter that lets through N−k+1 under concurrency is the failure mode, and an assertion of "at most" quietly tolerates it.

| Test shape | Catches the atomicity bug? |
|------------|---------------------------|
| ❌ Sequential: send 11 requests one at a time, expect the 11th to 429 | No — passes against a racy implementation |
| ❌ Concurrent, assert `allowed <= limit` | No — the bug produces *more* than the limit, but a flaky pass hides it |
| ✅ Concurrent, assert `allowed === limit` exactly, repeated | Yes |

> "I'd also want that test running against more than one process, because a single Node process serializes enough of the work to mask the race. The honest version spins up two instances against one Redis and hammers the same identifier from both — which is awkward enough to set up that it's usually the test nobody writes, and that's precisely why the bug survives to production."

**Boundary-burst is the other one worth asserting explicitly:** send the full limit just before a window boundary and the full limit just after, and confirm the sliding-window default does *not* allow 2× through the way Fixed Window would. That test documents the reason for the default choice, which a comment can't.

---

## 12. Future Enhancements

1. **WebSocket Metrics** - Real-time streaming instead of polling
2. **Rule Configuration UI** - Visual editor for rate limit rules
3. **Comparison Mode** - Test same request with multiple algorithms
4. **Export/Import** - Save and share configurations
5. **API Documentation** - Swagger/OpenAPI integration

---

## Summary

"To summarize, I've designed a fullstack rate limiting service with:

1. **Clean API contract** with typed request/response interfaces and standard rate limit headers
2. **End-to-end flow** from dashboard configuration through Redis-based limiting to UI feedback
3. **Comprehensive error handling** with centralized backend handler and frontend error boundaries
4. **Metrics synchronization** using polling with automatic refresh for near-real-time dashboard updates
5. **Algorithm selection UI** with visual animations and immediate test feedback
6. **Testing strategy** covering both backend integration and frontend components

The key insight is that a rate limiter is only useful if developers can understand and configure it correctly. The interactive dashboard with visual algorithm demos and live testing makes the abstract concepts of token buckets and sliding windows concrete and intuitive, while the clean API contract ensures reliable integration with client applications.

If I had to compress the whole design into one idea: **a rate limiter is a piece of infrastructure whose own failures must never be worse than the abuse it prevents.** That single constraint explains almost every decision here — why the check is one atomic Lua round trip rather than three network hops, why auditing and analytics are pushed onto a queue instead of blocking the answer, why Redis calls are wrapped in a breaker so a datastore blip can't become site-wide latency, and why the default on failure is to allow rather than deny. Each of those trades away something real. Together they mean the limiter degrades to 'slightly too permissive for a few minutes' instead of 'the site is down,' and for something sitting in front of every request in the system, that's the only acceptable shape of failure."

**What I'd flag as unfinished if asked:** the algorithms are configurable but the rules that drive them are effectively static — they live in Postgres but nothing reloads them without a redeploy, and adding hot reload means reintroducing a read on the hot path or a cache with its own invalidation problem. That's the next real design question, and it's not a small one.

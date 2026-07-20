# YouTube Top-K — Development with Claude

## Project Context

"What's trending right now" is a deceptively small question. The naive answer — `SELECT video_id, COUNT(*) FROM view_events WHERE viewed_at > NOW() - INTERVAL '1 hour' GROUP BY video_id ORDER BY COUNT(*) DESC LIMIT 10` — is exactly right and completely unusable at any interesting scale. It scans every view in the window on every request, and views are the highest-volume event in a video platform by orders of magnitude.

The reframing that makes it tractable: trending is a *streaming* problem, not a query problem. You never store the events and aggregate them later; you maintain the aggregate incrementally as events arrive, and you keep only enough state to answer the one question being asked. That leads directly to two decisions — how to represent a sliding time window without re-scanning it, and how to find the top K of a large keyspace without sorting all of it.

This project is unusual in the repo in that it implements *three* top-K approaches (exact min-heap, Count-Min Sketch, Space-Saving) and then routes production traffic through none of them — the live path uses Redis sorted sets. That's deliberate: the algorithms exist to make the trade-off concrete and measurable, and the sorted-set path exists because at this data volume Redis is already the right answer.

**Learning goals:** sliding-window counting via time buckets, exact vs. approximate heavy-hitter algorithms and when each is warranted, incremental aggregation over event streams, and SSE push for continuously-changing rankings.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** | Express. Also hosts the `TrendingService` background loop in-process — there is no separate worker |
| **PostgreSQL 16** | 5432 | Video metadata (`videos`), sampled event log (`view_events`), and `trending_snapshots`. Deliberately *not* the counting layer |
| **Valkey (Redis)** | 6379 | The actual counting layer: one sorted set per (category, minute) bucket, plus a `views:total` hash |

`TrendingService` (`services/trendingService.ts`) is a singleton that recomputes trending for seven categories every 5 seconds, caches the result in a plain in-process `Map`, and pushes it to every connected SSE client. `services/redis.ts` holds `WindowedViewCounter` — the bucketing, `ZINCRBY`, and `ZUNIONSTORE` logic. `utils/topk.ts` contains the three algorithm implementations (`MinHeap`/`TopK`, `CountMinSketch`, `SpaceSaving`), instrumented with Prometheus counters and latency histograms per heap operation. Config lives in one place, `shared/config.ts`: 60-minute window, 1-minute buckets, K=10, 5-second update interval, all env-overridable.

Routes are `/api/videos` (list, get, create, record view, batch view, idempotency stats), `/api/trending` (by category, all, categories, stats, manual refresh), and `/api/sse` (trending stream, heartbeat). No authentication — this system has no user accounts, which is why the screenshot config runs unauthenticated.

Frontend is React 19 + TanStack Router + Zustand + Tailwind: a trending list, category filter, and stats panel, driven by a `useSSE` hook. Vite proxies `/api` → `localhost:3001`.

## Key Design Decisions

### 1. The sliding window is a set of fixed buckets, not a true sliding window

`WindowedViewCounter` derives a bucket number from `floor(now / bucketMs)` and increments `views:bucket:{category}:{bucket}`. A read unions the last 60 buckets with `ZUNIONSTORE`. Each bucket gets a TTL of `window + 10` minutes, so expiry is Redis's problem, not ours.

A genuinely sliding window — one sorted set keyed by timestamp, trimmed on read — is more precise and much worse here. It stores one entry per *view* rather than one entry per (video, minute), which at view volume is an unbounded memory commitment for data whose only purpose is to be summed. It also requires an explicit `ZREMRANGEBYSCORE` trim on every read, so cleanup cost scales with traffic instead of being free.

Bucketing turns the window into an aggregation over ~60 small sets, and TTL-based expiry means old data deletes itself with zero application code. The precision cost is real but bounded: the window is accurate to ±1 bucket, so a video that went viral 40 seconds ago is counted in a bucket that may represent up to 60 seconds of activity. For "what's trending", one minute of edge fuzziness is invisible. For billing it would be unacceptable.

### 2. Counting lives in Redis; PostgreSQL never sees the full event stream

`recordView()` does the Redis pipeline, bumps `videos.total_views`, and then logs to `view_events` **only if sampling passes** — `RETENTION_CONFIG.viewEventSampleRate` gates the insert behind `Math.random()`.

Writing every view to Postgres would make the event table the system's bottleneck, and for no benefit: nothing in the trending path reads it. Its purpose is offline analysis and replay, and for that a sample is statistically sufficient while costing a fraction of the write volume and storage. This is the cleanest illustration in the repo of separating the operational path from the analytical one — and of the discipline that the analytical path must not be allowed to slow the operational one down.

What we give up: `view_events` cannot be used to reconstruct exact counts or to audit an individual video's history, and the sampled table plus the exact `total_views` counter will disagree by construction. Anyone querying `view_events` has to know the sample rate to interpret it, and nothing in the schema records what that rate was at insert time.

### 3. Three top-K algorithms are implemented; the live path uses none of them

`utils/topk.ts` has an exact min-heap `TopK` (O(log K) per update, O(K) space), a `CountMinSketch` (never underestimates, bounded overestimate, O(width × depth) space), and `SpaceSaving` (reports all items with frequency > n/k, with per-counter error bounds). `TrendingService.calculateTrending()` calls `viewCounter.getTopK()` — which is `ZUNIONSTORE` followed by `ZRANGE ... REV` with a `k-1` limit.

The reason is that Redis already *is* the right data structure for this cardinality. A sorted set maintains ordering incrementally on every `ZINCRBY`, so extracting the top K is a range read over an already-sorted structure — no separate pass, no separate state to keep coherent, and it works across processes, which an in-heap top-K does not. Approximate algorithms buy their savings by refusing to store a counter per distinct key; that only pays off when distinct keys outnumber what memory can hold. With a catalog of videos, they don't.

The honest framing is that the algorithms are pedagogical, and the instrumentation says so: the comment block above `TopK` explains that heap-operation metrics exist to detect "when to switch to SpaceSaving for high-cardinality streams." There's also a real wart worth knowing — `TopK.update()` on an existing item rebuilds the entire heap rather than sifting in place, which is O(K) instead of O(log K), and is flagged in a comment as needing an indexed heap. Since nothing serves traffic from it, it hasn't been fixed.

### 4. Trending is computed on a 5-second timer and read from an in-process cache

`TrendingService.start()` runs `updateTrending()` immediately, then on a `setInterval`. `getTrending(category)` only ever reads the `Map` — it never computes.

Computing per request would put the full `ZUNIONSTORE` over 60 buckets into the request path, and worse, it would scale with reader count: a thousand clients watching the same trending page would each independently union the same 60 sets to derive the same answer. Precomputing decouples compute cost from read volume entirely — the work is done seven times (once per category) every five seconds regardless of whether one person or ten thousand are watching.

The trade-off is bounded staleness of up to 5 seconds plus the calculation time, which for a trending list nobody perceives. The sharper cost is that the cache is per-process: run `dev:server1/2/3` and you get three independent timers computing three caches, each pushing to its own SSE clients. They'll agree because they read the same Redis, but each pays the full compute cost, so the "precompute once" property is lost as soon as you scale out.

### 5. SSE over WebSocket, with the server pushing after every recalculation

`notifyClients()` writes `data: {...}\n\n` to every registered client at the end of `updateTrending()`, and `registerSSEClient` cleans up on `res.on('close')`.

The data flow here is strictly one-directional: the server has new rankings, clients need to know. WebSocket would add a bidirectional channel with nothing to send in the client→server direction, plus its own reconnection logic — `EventSource` reconnects automatically, which for a dashboard left open on a second monitor for hours is exactly the behavior you want and would otherwise have to write. SSE is also plain HTTP, so it works through proxies without an upgrade negotiation.

The costs are inherited from the protocol: browsers cap concurrent connections per origin over HTTP/1.1 (~6), so several tabs will exhaust them, and there is no client-side backpressure — a slow consumer just accumulates. `notifyClients()` handles the write failure case by deleting the client and incrementing an error counter, which is the minimum viable version of that problem.

## Current State

Runs end to end with no login: API on 3001, Redis-backed windowed counting across seven categories, a 5-second trending recomputation loop, an in-process cache, SSE streaming to the frontend, view recording (single and batch) with idempotency keys, manual trending refresh, sampled event logging, Prometheus `/metrics` including per-category calculation latency, trending-video gauges, SSE client counts and Redis bucket-key counts, structured logging, and health/readiness endpoints that report `TrendingService` state (including a distinct `not_started` status).

Schema applies via `npm run db:migrate` (`backend/src/db/migrate.ts`), which tracks applied versions in `schema_migrations`; `npm run seed` populates videos. Frontend renders the trending list, category filter, and a live stats panel showing total views, unique videos, connected clients, and cache hit rate.

**Views are simulated.** There is no real player and no real traffic — views arrive via `POST /api/videos/:id/view` and the batch endpoint, which is how the trending list gets anything to rank. `trending_snapshots` exists in the schema but nothing writes to it, so there is no historical record of past rankings. Also not implemented: geographic trending, an admin interface, load testing, and any use of the Count-Min Sketch or Space-Saving implementations outside their own module.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. It marked Phase 3 "Scaling and Optimization" as **Not started** with focus areas "Add caching layer" and "Add monitoring" — while `TrendingService` maintained an in-process trending cache with hit-rate tracking exposed on `/api/trending/stats`, and `shared/metrics.ts` served a Prometheus endpoint with heap-operation histograms, per-category calculation latency, SSE gauges, and Redis bucket-key counts. Phase 2 was "In progress" with every item listed as implemented. The old file also never disclosed the most important fact about this codebase — that the three top-K algorithms it documents at length are not on the serving path.
- **Illegal partial index using `NOW()` (fixed):** `init.sql` created the cleanup index with a `WHERE viewed_at < NOW() - INTERVAL '7 days'` predicate. Postgres requires index predicates to be `IMMUTABLE`, and `NOW()` is `STABLE`, so the statement errored during `docker-entrypoint-initdb.d` execution and aborted schema load — leaving a database with no tables, which surfaces much later as unexplained empty responses rather than as a schema error. It is now a plain index on `viewed_at`; the cleanup query still uses it, just without the predicate.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 tsx --watch src/index.ts` to match the Vite proxy target.
- **View-event logging made samplable:** `enableViewEventLogging` and `viewEventSampleRate` were added to `shared/config.ts` so the Postgres write can be turned down or off entirely without touching the counting path.
- **Readiness reports `not_started` distinctly:** `/health` treats an unstarted `TrendingService` as a recognized state rather than an error, so the probe can distinguish "still booting" from "broken".
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. `getTopK` does an `EXISTS` check per bucket before unioning — 60 sequential Redis round trips per category per cycle, 420 per 5-second tick across seven categories. Should this be one pipelined batch, or should the union simply include missing keys (which `ZUNIONSTORE` tolerates) and skip the existence check entirely?
2. Trending is ranked by raw windowed view count, so a video with a huge subscriber base always outranks a genuinely accelerating small one. Is *velocity* — this window versus the previous — the honest trending signal, and does that require keeping a second window's aggregate?
3. The in-process cache and the 5-second timer are per-instance, so horizontal scaling multiplies compute rather than dividing it. Should the computed result be written to Redis so one instance computes and the rest read — and does that just relocate the "who computes" problem into a leader election?
4. At what distinct-video cardinality does the sorted-set approach actually lose to `SpaceSaving`? The instrumentation to answer this exists (heap size and operation latency are exported); nothing has measured it.

## Resources

- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — `ZINCRBY` and `ZUNIONSTORE`, the actual serving path
- [Count-Min Sketch (Cormode & Muthukrishnan)](https://www.cse.unsw.edu.au/~cs9314/07s1/lectures/Lin_CS9314_References/cm-latin.pdf) — the paper behind `CountMinSketch`
- [Efficient Computation of Frequent and Top-k Elements in Data Streams](https://www.cse.ust.hk/~raywong/comp5331/References/EsssentialCounting.pdf) — the Space-Saving algorithm and its error bounds
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — the `EventSource` reconnection semantics decision 5 relies on
- [PostgreSQL: index expressions and predicates](https://www.postgresql.org/docs/current/indexes-partial.html) — why the `NOW()` predicate was rejected

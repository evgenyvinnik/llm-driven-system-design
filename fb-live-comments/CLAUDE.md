# Facebook Live Comments — Development with Claude

## Project Context

A live comment stream inverts the usual read/write asymmetry. Most social systems are read-heavy — one post, a million views. Here a popular stream has a million *viewers who are all also writers*, and every comment must reach every one of them within a second or the conversation stops making sense. The fan-out is the entire problem: 1,000 comments per second delivered individually to 100,000 viewers is 100 million WebSocket sends per second, which is not a database problem or a network bandwidth problem but a *syscall* problem. You physically cannot make that many `send()` calls.

The escape is that humans can't read 1,000 comments per second either. Nobody notices whether a comment arrived 20ms or 120ms after it was posted, and nobody can distinguish 40 individual reactions from "40 reactions". That perceptual slack is what the whole design monetizes: buffer comments for 100ms and send one batched frame instead of N frames, aggregate reactions into counts instead of events, and the send count collapses by orders of magnitude while feeling identical to a viewer.

The second problem is ordering. Comments are generated concurrently on multiple gateway instances, and "the order they arrived at the database" is not stable when writes are batched and asynchronous. A comment ID that sorts chronologically without any coordination is worth a lot here — it means ordering survives being merged out of order across instances.

**Learning goals:** time-based batching as a throughput lever, aggregation as a semantic compression, Snowflake IDs for coordination-free time ordering, Redis Pub/Sub fan-out across gateway instances, and rate limiting that holds across processes.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **Express + `ws` gateway** (`backend/src/index.ts`) | **3001** | REST for streams/users/history plus the `/ws` comment channel. WebSocket rather than SSE because clients *post* as well as receive — SSE is server→client only, so it would need a second HTTP path for writes |
| **PostgreSQL 16** | 5432 | `comments.id` is a `BIGINT` Snowflake, not a UUID — the primary key *is* the sort order, so `ORDER BY id` needs no extra index or timestamp column |
| **Valkey (Redis)** | 6379 | Three roles: Pub/Sub channels `stream:<id>:comments` and `stream:<id>:reactions` for cross-instance fan-out, rate-limit counters, and a `recent:stream:<id>` list capped at 1,000 comments with a 1-hour TTL for instant backfill on join |

The gateway is decomposed under `backend/src/services/wsGateway/`: `connection-manager.ts` (socket lifecycle and message dispatch), `room-manager.ts` (join/leave, and the Redis subscribe/unsubscribe that follows the *first* and *last* viewer of a stream), `broadcast.ts` (`broadcastToStream`, plus the `CommentBatcher` and `ReactionAggregator` classes), and `moderation.ts` (ban checks). Domain logic sits in `services/{comment,reaction,stream,user}Service.ts`, with `utils/snowflake.ts` for ID generation. Frontend is React 19 + Zustand + Tailwind with no router — `App.tsx` switches between the stream list and the player, and `hooks/useWebSocket.ts` owns the connection.

## Key Design Decisions

### 1. Comments batch on a 100ms timer; reactions aggregate on a 500ms timer

`CommentBatcher` buffers incoming comments and flushes to Redis every `COMMENT_BATCH_INTERVAL_MS` (default 100). `ReactionAggregator` accumulates *counts by type* every `REACTION_BATCH_INTERVAL_MS` (default 500).

Sending each comment as it arrives is the obvious design and it fails on per-message overhead, not bandwidth. A comment is maybe 200 bytes, but every individual `ws.send()` costs a JSON serialization, a frame header, and a syscall. Batching amortizes all three: at 1,000 comments/second, per-comment sending is 1,000 serializations and 1,000 sends *per viewer*; at 100ms batching it's 10 sends per viewer carrying ~100 comments each — a 100× reduction in the operation that actually saturates. Note that `broadcast.ts` serializes once per batch and reuses the string across every socket in the room, which is the other half of the win.

The two intervals differ because the data has different semantics, and this is the more interesting half. Comments are *individually meaningful* — you cannot merge two comments, so batching can only delay them, and 100ms is chosen to stay under the threshold where a viewer perceives lag. Reactions are *only meaningful in aggregate* — nobody cares that user 8,412 sent a heart, they care that the count went up. So reactions get true aggregation, where 500 reactions in a window become one message carrying `{heart: 500}` regardless of volume. That message is O(number of reaction types), completely independent of reaction rate, which is why the interval can afford to be 5× longer.

What we give up: up to 100ms of added latency on every comment even when the stream is quiet and batching buys nothing, and a hard cap on reaction fidelity — the floating-reaction animation can't show true one-per-user timing because that information is discarded at the aggregator. On a crash, anything sitting in either buffer is lost, since the buffers are in process memory.

### 2. Snowflake IDs (41-bit time + 10-bit machine + 12-bit sequence), not UUIDs or a sequence

`SnowflakeGenerator` in `utils/snowflake.ts` produces 64-bit IDs from a custom 2024-01-01 epoch, with the machine ID defaulting to `process.pid % 1024`.

UUIDv4 is random, so `ORDER BY id` is meaningless and chronological ordering requires a separate `created_at` column plus an index on it — and worse, `created_at` from multiple instances with drifting clocks produces ties and inversions that the database can't break consistently. A Postgres `BIGSERIAL` gives perfect ordering but requires a round-trip to the database *before* you can broadcast, which is exactly what batching is trying to avoid: the gateway wants to assign an ID, publish to Redis immediately, and persist asynchronously. Snowflake lets it do that, because the ID is generated locally and is still globally sortable.

The 12-bit sequence is what makes it safe under load: 4,096 IDs per millisecond per machine, and the generator spins to the next millisecond on overflow rather than colliding. The trade-off is real and worth naming: ordering is only as good as the wall clocks. If one gateway's clock is 200ms ahead, its comments sort 200ms early on every client, and a clock stepping *backwards* (NTP correction) can generate IDs that collide with already-issued ones. The `process.pid % 1024` default machine ID is also a collision risk — two instances on the same host can draw the same PID modulo 1024, and then they can mint identical IDs.

### 3. Redis Pub/Sub for cross-instance fan-out, subscribed per stream on demand

`room-manager.ts` subscribes to `stream:<id>:comments` and `stream:<id>:reactions` when the *first* viewer of a stream joins an instance, and unsubscribes when the *last* one leaves. Batches published by any instance reach every instance holding viewers of that stream.

Without a shared bus, `dev:server1/2/3` (ports 3001–3003) would each be an island — a comment posted by a viewer on instance 1 would be invisible to viewers on instance 2, permanently. Kafka would give durability and replay, which genuinely matters for a system where a dropped batch is a lost conversation. It's the wrong weight here: Kafka adds a broker, partition management, and consumer-group coordination for messages whose value expires in seconds. A dropped comment batch during a live stream is not something you'd replay 30 seconds later — the moment has passed.

Subscribing per stream rather than globally is what keeps this from being pointless. A single `psubscribe stream:*` would deliver every comment on every stream to every instance, so each instance does full-volume deserialization work for streams it has no viewers for — the fan-out savings evaporate at exactly the scale where you added instances to get them. Per-stream subscription means an instance's work is proportional to what its own viewers care about.

The cost is Pub/Sub's fire-and-forget delivery: an instance that is briefly disconnected from Redis silently misses batches with no way to detect or recover them. Viewers just have a hole in their comment history.

### 4. Recent comments cached as a capped Redis list, not queried from Postgres on join

`cacheComment` does `LPUSH` then `LTRIM 0 999` on `recent:stream:<id>` with a 1-hour TTL, so joining a stream can hydrate from Redis.

Backfilling from Postgres means every viewer join runs `SELECT ... WHERE stream_id = $1 ORDER BY id DESC LIMIT 100`. That query is indexed and fast in isolation — but joins are bursty in exactly the way that's worst for a database. A stream getting linked somewhere brings thousands of viewers in a few seconds, all issuing the same query against the same rows, at the same moment the write path is also hammering that table with new comments. The `LTRIM` cap is what makes the Redis version bounded: memory per stream is fixed at 1,000 comments regardless of how long the stream runs or how fast people talk.

We give up history depth — a viewer joining hour three of a stream sees the last 1,000 comments, not the beginning — and we accept that the cache and Postgres can disagree if a write to one succeeds and the other fails.

### 5. Rate limits are per-user-global *and* per-user-per-stream, enforced in Redis

`commentService` checks two limits: `RATE_LIMIT_COMMENTS_PER_MINUTE` (default 30) across all streams, and `RATE_LIMIT_COMMENTS_PER_STREAM` (default 5) within one stream.

One global limit alone permits a spammer to dump their entire budget into a single stream, which is precisely the abuse pattern that matters — flooding one conversation, not spreading thinly across many. One per-stream limit alone permits a bot to hit 50 streams at the per-stream cap simultaneously. Both together bound both shapes of abuse. Counters live in Redis rather than process memory because with three gateway instances an in-memory limit is really 3× the stated limit, and it changes every time you scale — the limit stops meaning anything.

**An accuracy note:** `checkRateLimit` in `utils/redis.ts` is documented as a "sliding window counter" but is implemented as a **fixed window** — `INCR`, then `EXPIRE` only when the counter is new. That permits the classic boundary burst: 30 comments at 0:59 and 30 more at 1:01 is 60 comments in two seconds while never exceeding the per-minute limit. A real sliding window needs a sorted set of timestamps trimmed per request. The current behavior is defensible for spam control (the burst is bounded at 2× and self-corrects), but the docstring overstates what it does.

## Current State

Runs end to end on backend 3001 + Vite 5173 (Vite proxies `/api` and `/ws` to 3001). Working: stream list and live-stream filtering, a video player with an overlaid comment stream, posting comments over WebSocket with 100ms batched delivery, six reaction types with 500ms aggregation and a floating-reaction animation, Snowflake-ordered comments, Redis Pub/Sub fan-out with per-stream subscribe/unsubscribe, recent-comment backfill from the capped Redis list, dual-scope rate limiting, live viewer counts, comment pinning/highlighting, user bans enforced at stream join (`moderation.ts`, fail-open on error — a ban-check failure lets the user through rather than locking out the room), stream creation and ending, a per-stream metrics endpoint, Prometheus metrics, Pino structured logging, and Opossum circuit breakers.

Seeded users: **`streamer1`** (Live Streamer, verified), **`viewer1`**, **`viewer2`**, **`moderator1`** (moderator role), and **`admin`** (admin role), plus two live streams — "Live Coding Session" and "Gaming Stream" — with public sample video URLs. **There are no passwords and no `password_hash` column** in the `users` table; `UserSelector.tsx` picks an identity from the list. The seed file's header comment mentions a bcrypt hash for `password123`, which is leftover text — no INSERT uses it and no login path exists.

Intentionally simplified or absent: no authentication or sessions, no spam/toxicity classification (rate limiting and manual bans are the only moderation), no comment threading in the UI (`comments.parent_id` exists in the schema and nothing populates it), no load balancer in front of the gateway instances, and no Grafana dashboards despite metrics being exported.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md with this structure. The checklist was substantially wrong: Phase 3 "Scaling and Optimization" was marked *Not started* with "Add caching layer", "Optimize database queries", and "Add monitoring" listed as pending — while the capped `recent:stream:<id>` Redis cache, eight `CREATE INDEX` statements in `init.sql`, and a full `prom-client` metrics surface were all already built. The file also ended with a "Next Steps" list whose first four unchecked boxes were "Define detailed requirements", "Sketch initial architecture", "Choose technology stack", and "Implement MVP" — all long since done — and its "Iterations and Learnings", "Questions", and "Resources" sections were empty placeholder text.
- **Gateway split into modules:** a monolithic WebSocket file became `services/wsGateway/{connection-manager,room-manager,broadcast,moderation}.ts` with shared `types.ts`. The forcing function was the subscribe/unsubscribe lifecycle — Redis subscription is tied to the first and last viewer of a stream, and that ref-counting logic was impossible to review inside the same file as message dispatch.
- **Batch serialization hoisted out of the send loop:** `broadcastToStream` now does one `JSON.stringify` per batch and reuses the resulting string across every socket, rather than serializing per recipient. With 10,000 viewers on a stream that's 10,000 serializations of identical data per flush.
- **Rate limiter is fixed-window, not sliding (found 2026-07, not fixed):** `checkRateLimit`'s docstring claims a sliding window; the implementation is `INCR` + conditional `EXPIRE`. See decision 5. The docstring should be corrected or the implementation upgraded to a sorted-set window.
- **Ban checks fail open:** `checkUserBan` returns "not banned" when the lookup errors, so a Redis or Postgres hiccup degrades moderation rather than locking every viewer out of every stream. Deliberate, but it means a sustained outage effectively disables bans.
- **Backend port pinned to 3001:** the `dev` script hardcodes `PORT=3001` to match the Vite proxy targets for `/api` and `/ws`. Without the pin the stream list rendered and the comment channel silently never connected.
- **CI:** the repo-wide smoke-test workflow was removed — a CI runner can't provide the Postgres and Redis services these tests need, so it failed on every PR without signalling a real defect.

## Open Questions

1. Snowflake machine IDs default to `process.pid % 1024`, which can collide between two instances on the same host and would then mint duplicate IDs against a `BIGINT PRIMARY KEY`. Should instance ID come from an explicit env var (simple, but requires deployment discipline) or a Redis-allocated lease (self-managing, but adds a startup dependency and a renewal path)?
2. Batching buffers live in process memory, so a gateway crash loses up to 100ms of comments that were already acknowledged to their authors. Is that acceptable given the medium is ephemeral, or should the write to Postgres happen *before* the batch flush — accepting a database round-trip on the hot path we specifically designed to avoid?
3. The 100ms comment interval is fixed. On a stream with three viewers it adds pure latency for no benefit; on a stream with 100,000 it might be too short. Should the interval adapt to stream volume, and if so what stops it oscillating as viewer counts fluctuate?
4. Redis Pub/Sub drops silently on a disconnect, so an instance can miss batches without knowing. Is a per-stream sequence number in each batch (letting instances detect gaps and re-fetch from the `recent:` list) enough, or does gap-free delivery genuinely require moving to Kafka despite the operational cost argued against in decision 3?

## Resources

- [Twitter Snowflake](https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake) — the original 41/10/12 bit layout used in `utils/snowflake.ts`
- [Redis Pub/Sub](https://redis.io/docs/latest/develop/interact/pubsub/) — including its explicit at-most-once delivery semantics
- [Redis LTRIM](https://redis.io/docs/latest/commands/ltrim/) — the capped-list pattern behind the recent-comments cache
- [Facebook Engineering: scaling Live video](https://engineering.fb.com/2015/12/03/ios/under-the-hood-broadcasting-live-video-to-millions/) — the fan-out problem at real scale
- [WebSocket vs Server-Sent Events (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — why bidirectional posting rules out SSE

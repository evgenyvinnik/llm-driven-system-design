# Twitter — Development with Claude

## Project Context

The whole system turns on one question: when someone tweets, do you do the work at write time or at read time? Push (fan-out on write) means the timeline is precomputed and a read is one Redis `LRANGE` — but a tweet from someone with 50 million followers is 50 million writes, and at 10K writes/second that's 83 minutes for a message users expect to see instantly. Pull (fan-out on read) means posting is one row insert — but every timeline read becomes a join across everyone you follow, sorted, at p99 latency, on the most-hit endpoint in the product.

Neither answer works alone, which is why this codebase implements both and switches on a per-author basis. That switch is the interesting part: `is_celebrity` isn't a manual flag, it's derived by a database trigger the moment `follower_count` crosses the threshold, so an account that grows past 10K silently stops being fanned out and starts being pulled — mid-flight, with no deploy.

The second theme is that everything expensive is denormalized and everything denormalized can drift. Follower counts, tweet counts, like counts, retweet counts, reply counts, timeline caches, and trend scores are all derived data with their own consistency story. The design work is deciding which of them are allowed to be wrong and for how long.

**Learning goals:** hybrid push/pull fan-out and the celebrity problem, timeline caching in Redis lists, denormalized counters via Postgres triggers, circuit-broken fan-out with a durable retry queue, and time-bucketed trend scoring with exponential decay.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** | Express; `app.ts` is exported separately so `app.test.ts` can drive it under vitest without binding a port |
| **Fanout worker** (`workers/fanout-worker.ts`) | — | Kafka consumer (group `fanout-workers`) that calls `fanoutTweet` off the request path; `dev:worker1/2` run two groups |
| **Trending worker** (`workers/trending-worker.ts`) | — | Recomputes trend scores every 60s and rewrites the `trending:current` sorted set |
| **PostgreSQL 16** | 5432 | `users`, `tweets`, `follows`, `likes`, `retweets`, `hashtag_activity` — plus five trigger functions maintaining every denormalized counter |
| **Valkey (Redis)**, via ioredis | 6379 | Sessions (`connect-redis`), timeline lists, per-minute trend buckets, the `trending:current` zset, and the `fanout:retry_queue` list |
| **Kafka + Zookeeper** | 9092 | Durable tweet-created events for the fanout and trending workers |

Fan-out logic is entirely in `backend/src/services/fanout.ts`. Routes are `auth`, `users`, `tweets`, `timeline`, `trends`. Cross-cutting modules in `backend/src/shared/`: `circuitBreaker.ts` (Opossum, with `FANOUT_CIRCUIT_OPTIONS`), `retry.ts` (`withRetry`, `FANOUT_RETRY_CONFIG`), `kafka.ts` (kafkajs producer/consumer), `idempotency.ts`, `logger.ts`, `metrics.ts` (fanout duration bucketed by follower count, queue depth gauge), `retention.ts`. Schema and triggers are in `backend/src/db/init.sql`, applied by `backend/src/db/migrate.ts` (`npm run db:migrate`).

Frontend is React + TanStack Router + Zustand + Tailwind; `components/Timeline.tsx` virtualizes the tweet list. Vite proxies `/api` → `localhost:3001`.

## Key Design Decisions

### 1. Hybrid fan-out, with the celebrity boundary maintained by a database trigger

`fanoutTweet` reads `is_celebrity` first and returns `{ skipped: true, reason: 'celebrity' }` without touching Redis. At read time, `timeline.ts` does an `LRANGE` on the precomputed list *and* a separate pull query for tweets by followed celebrities, then merges, dedupes, and sorts by `created_at`.

Pure push is what breaks, and it breaks precisely where it hurts most. Each follower costs three Redis operations here (`LPUSH`, `LTRIM`, `EXPIRE`), so a 50M-follower account is 150M pipelined operations for a single tweet — an amount of work that doesn't fit in a request, a job, or a reasonable amount of Redis CPU, and which arrives in bursts because celebrities tweet in bursts. Pure pull fails differently: with the timeline being the most-requested endpoint, every load becomes a fan-in query over everyone you follow, and the p99 is set by whoever follows the most accounts.

The trigger placement is what makes it maintainable. `update_follow_counts()` recomputes `is_celebrity = (follower_count ± 1 >= celebrity_threshold)` in the same statement that changes the count, so there is no window where the count says 10,001 and the flag still says push. Doing this in application code would mean every follow path had to remember to re-evaluate the threshold.

What we give up is that a *newly promoted* celebrity's older tweets are still sitting in follower timeline caches while their new ones arrive via pull — the merge handles it (dedup by ID), but the read path now permanently pays for two queries plus an application-side sort, even for users who follow no celebrities.

### 2. Timelines store tweet IDs, capped at 800, not tweet bodies

`performRedisFanout` pushes `tweetId.toString()`, trims to `TIMELINE_CACHE_SIZE` (800), and sets a 7-day TTL. Reads hydrate with one `WHERE t.id = ANY($1)` query.

Storing rendered tweets would remove the hydration query, and it's the wrong trade for three reasons that compound. Memory: the same tweet body is duplicated into every follower's list, so a tweet with 5,000 followers is stored 5,000 times. Mutability: like and retweet counts change constantly, so cached bodies are stale the moment they're written, and the alternative is invalidating N copies per like. Deletion: `is_deleted` is checked at hydration time, so a deleted tweet disappears from every timeline immediately without touching any cache — with cached bodies you'd have to find and rewrite every copy. The ID-only design makes deletion lazy and free.

The cost is one Postgres round trip per timeline read, plus the 800-entry cap meaning deep pagination falls off the end of the cache with no fallback path — `rebuildTimelineCache()` exists to repopulate but nothing calls it automatically.

### 3. Fan-out failures go to a durable retry queue, not into the void

`redisFanoutCircuit` wraps `performRedisFanout`; its `.fallback()` pushes `{tweetId, authorId, followers, queuedAt}` onto `fanout:retry_queue` and updates the `fanoutQueueDepth` gauge. `processFanoutRetryQueue()` pops batches, retries, and re-queues failures with an incremented `retryCount` and the last error.

The alternative — letting the breaker just fail the fan-out — produces a uniquely bad outcome: the tweet exists in Postgres, the author sees it on their profile, and it is silently absent from every follower's timeline forever. There's no error surfaced to anyone and no way to detect it after the fact. Queuing converts a permanent silent inconsistency into a temporary one with an observable depth metric. What we accept: the retry queue has no maximum retry count, so a permanently poisoned item cycles forever, and re-queued items go to the tail — meaning a large backlog delivers tweets badly out of order relative to when they were posted.

### 4. Every count is a Postgres trigger, not an application update

Five trigger functions maintain `follower_count`, `following_count`, `tweet_count`, `like_count`, `retweet_count`, and `reply_count`.

The application-level alternative is a second statement after each insert, and it is wrong under concurrency in a way that's hard to see in testing: a read-modify-write (`SELECT count`, `count + 1`, `UPDATE`) loses increments when two likes land simultaneously, and even `UPDATE ... SET count = count + 1` issued separately isn't atomic with the insert — a crash between them leaves the count permanently off by one, with no reconciliation job to notice. Triggers execute inside the same transaction as the row change, so the counter and the fact it counts commit or roll back together. The trade-off is genuine: business logic now lives in the database, it's invisible to anyone reading the TypeScript, and it can't be unit-tested with the rest of the app. It also makes bulk operations expensive — deleting a user fires a trigger per follow row.

### 5. Trends are per-minute Redis counters scored with exponential decay by a separate worker

Posting a tweet does `INCR trend:{hashtag}:{minuteBucket}` with a 1-hour expiry — that's the entire write-side cost. Every 60 seconds, `trending-worker.ts` scans `trend:*:*`, computes `count × 0.95^age` over a 60-minute window, and rewrites `trending:current` as a sorted set with a 5-minute TTL. A separate pass drops buckets older than 120 minutes.

A raw `COUNT(*) GROUP BY hashtag` over `hashtag_activity` would give exact totals and the wrong answer, because trending is about *velocity*, not volume: a hashtag with 10,000 mentions accumulated over a week should rank below one with 500 mentions in the last ten minutes. Exponential decay expresses that directly — at 0.95 per minute, a bucket's contribution halves roughly every 14 minutes, so old activity fades without a hard cutoff that would make hashtags pop in and out at a window boundary.

Doing this in the request path is also not an option: the scan touches every trend key in Redis, which is exactly the kind of O(keyspace) work you never want inside a user request. Moving it to a worker means the trend list is up to 60 seconds stale, which nobody perceives, and it means `trending:current` is a single precomputed zset that the API reads with one `ZREVRANGE`. The give-up is `SCAN`-based key discovery, which is fine at this scale and would need a maintained hashtag registry at real scale.

## Current State

Runs end to end: API on 3001 with Redis-backed sessions, registration/login, tweeting with hashtag extraction, replies, likes, retweets, follow/unfollow, profile and hashtag pages, hybrid home timeline with celebrity merge and dedup, trending sidebar, Prometheus metrics, structured logging with request IDs, circuit breakers and retries around fan-out, and a vitest suite in `backend/src/app.test.ts`. Two background workers (`dev:fanout-worker`, `dev:trending-worker`) consume from Kafka and recompute trends. Schema and triggers apply via `npm run db:migrate`.

Seeded logins (all `password123`): `alice`, plus the other users in `backend/db-seed/seed.sql`.

**Fan-out currently runs on both paths at once.** `routes/tweets.ts` calls `publishTweet()` (Kafka → fanout worker) *and* `fanoutTweet()` directly, both fire-and-forget. With the worker running, a tweet ID gets `LPUSH`ed into follower timelines twice; the duplicate is invisible because `timeline.ts` dedupes by ID at read time, but it wastes a slot in the 800-entry cap. The synchronous call is the one that works with no Kafka running, which is why it's still there.

Not implemented: SSE or WebSocket timeline updates (the client polls), notifications, live engagement counts, protected accounts, and automatic invocation of `rebuildTimelineCache` / `processFanoutRetryQueue` — both exist and are exported but nothing schedules them.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. It had Phase 2 marked "IN PROGRESS" with all eight items checked, and its design log recorded "Decision 2: Synchronous Fanout — Future: Could add background workers with a job queue" while `workers/fanout-worker.ts` and `workers/trending-worker.ts` already existed, were wired to kafkajs, and had four npm scripts (`dev:fanout-worker`, `dev:trending-worker`, `dev:worker1`, `dev:worker2`). The old file also never mentioned the `fanout:retry_queue` or the decay constant.
- **Schema was never applied (fixed, 2026-07-12):** `src/db/init.sql` existed but nothing ran it — no `db:migrate` script and no `docker-entrypoint-initdb.d` mount, so a fresh database had zero tables. Seeding appeared to succeed only because psql exit codes weren't checked. Added `src/db/migrate.ts` + `npm run db:migrate`, and mounted `init.sql` into the Postgres container.
- **No DB connection fallback (fixed, 2026-07-12):** `src/db/pool.ts` read `process.env.DATABASE_URL` with no default and no `.env` ships with the repo, so every query failed on a fresh clone even though the server booted cleanly. Added the repo-conventional fallback to the docker-compose credentials, matching `redis.ts`.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 tsx watch src/index.ts` to match the Vite proxy target. `index.ts` otherwise defaults to 3000.
- **Kafka publishing is non-blocking:** `publishTweet` and `publishLike` are called without `await` and with `.catch()` handlers, so a Kafka outage logs an error and leaves tweeting fully functional via the synchronous fan-out path.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

- **2026-08-10 — every timestamp rendered as a negative number ("−25190s") and both sidebar panels were empty.** Four faults:
  1. **`TIMESTAMP` instead of `TIMESTAMPTZ` on all nine datetime columns.** Postgres `NOW()` writes the container's UTC wall clock into a naive column; node-pg then parses a `timestamp without time zone` as *local* time, so on a UTC−7 machine every row came back seven hours in the future and `formatRelativeTime` produced −25190s. Converted the schema to `TIMESTAMPTZ` — which is the correct type for an instant regardless of this bug — and clamped the formatter's sub-minute branch at zero, since clock skew alone can put a timestamp slightly ahead of the client.
  2. **Every seeded tweet took the `created_at` default**, so all fifteen shared one timestamp: nothing for the timeline to order by, every tweet the same age, and the 60-minute trend window containing either all of them or none. Gave each an explicit offset spread from 4 minutes to 2 days.
  3. **"Trends for you: No trends available"** — the feature this project is built around. Trend counters are incremented only by the tweet-creation route, so they exist solely for tweets posted through the API while the process was running; a SQL-seeded database has the hashtag rows in Postgres and nothing in Redis. The buckets also carry a 1-hour TTL, so even a live-populated instance goes blank after an idle hour and never recovers. Added `services/trendBackfill.ts`, which rebuilds the per-minute buckets from `hashtag_activity` at boot — the same self-healing pattern as tinder's Elasticsearch backfill: **Postgres is the record, Redis is a derived index that must always be rebuildable from it.** Uses `SET`, not `INCRBY`, so a restart cannot double-count buckets it already wrote.
  4. **"Who to follow: Suggestions will appear here"** was a literal placeholder in `Layout.tsx`, despite follow/unfollow being fully implemented. Added `GET /api/users/suggestions` (accounts you don't already follow, ranked by the trigger-maintained `follower_count`) and a `WhoToFollow` component. **The route has to be registered before `/:username`** or Express matches "suggestions" as a username — noted inline, because the failure is a confusing 404 for a user that doesn't exist rather than an obvious routing error.
- **Also fixed:** the trends sidebar requested 10 entries and grew taller than the timeline beside it (now 6, with the existing "Show more"), and "1 tweets" pluralization.
- **Answer docs verified, not rewritten:** 356/452/407 lines, all inside the 350–550 band, no code fences, and their claims match the implementation (including the hybrid fan-out and trigger-maintained counters). No changes needed.

## Open Questions

1. The dual fan-out path (synchronous *and* via Kafka) double-writes every tweet ID when the worker runs. Should the synchronous call be removed and Kafka made a hard dependency, or should `performRedisFanout` become idempotent — e.g. `LREM` before `LPUSH`, at the cost of an extra op per follower?
2. `fanout:retry_queue` has no max retry count and no dead-letter destination, so a permanently failing item recirculates forever. What's the right terminal state — drop, or park it somewhere an operator sees?
3. The 800-entry timeline cap with no automatic rebuild means deep scrolling silently runs out of timeline and returns only celebrity pulls. Should `rebuildTimelineCache()` fire on cache miss, or should the read path fall back to a live pull query past the cap?
4. Decay at 0.95/minute over a 60-minute window is a guess with no data behind it. What actually distinguishes "trending" from "consistently popular" here — and would velocity (this hour vs. last hour) be a more honest signal than a decayed sum?

## Resources

- [The infrastructure behind Twitter scale](https://blog.twitter.com/engineering/en_us/topics/infrastructure/2017/the-infrastructure-behind-twitter-scale) — the source of the hybrid fan-out design
- [Designing Data-Intensive Applications, Ch. 1](https://dataintensive.net/) — Kleppmann uses exactly this timeline problem to introduce write-vs-read load
- [Redis lists](https://redis.io/docs/latest/develop/data-types/lists/) — `LPUSH`/`LTRIM` semantics behind the capped timeline
- [kafkajs](https://kafka.js.org/docs/getting-started) — the producer/consumer API in `shared/kafka.ts`
- [PostgreSQL trigger procedures](https://www.postgresql.org/docs/current/plpgsql-trigger.html) — the counter-maintenance mechanism in `init.sql`

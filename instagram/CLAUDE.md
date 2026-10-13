# Instagram — Development with Claude

## Project Context

Instagram is the project in this repo with the most *different kinds* of hard problem in one product, and the interesting thing is that each one wants a different datastore. Posts and the social graph need referential integrity and transactions, so they're PostgreSQL. Direct messages are append-only, time-ordered, partitioned by conversation, and written far more than they're read — the exact shape Cassandra exists for, and a shape Postgres serves badly once a conversation has a million rows and you're always reading the newest fifty. Feeds are a ranked list that must be assembled in tens of milliseconds, which is a Redis sorted set. Images are large binary blobs, which is object storage. So this is a genuinely polyglot system, and the cost of that — four datastores to run, no cross-store transactions, denormalized copies that can drift — is itself the lesson.

The other defining problem is the feed. Reading a feed on demand means "select posts from everyone I follow, ordered by time," which is a join against the follow graph on every single page load — and a user following 500 accounts makes that expensive at exactly the moment the app opens. Pushing every post into every follower's timeline fixes reads but turns one post from a large account into millions of writes. So this implementation does **hybrid fan-out**: when a post finishes processing, the worker pushes its ID into the cached Redis timeline of each follower — unless the author has at least `FEED_CELEBRITY_THRESHOLD` followers, in which case followers pull those posts at read time and the feed merges both.

Third: image upload can't be synchronous. Resizing to multiple resolutions and applying a filter takes seconds, and holding an HTTP request open for that means a user staring at a spinner and a request-handling thread doing CPU work. Uploads accept the original, mark the post `processing`, and hand off to a RabbitMQ worker.

**Learning goals:** polyglot persistence with each store chosen for an access pattern, fan-out-on-write feeds and where they break, async media pipelines with status tracking, Cassandra data modeling with TimeUUID clustering, and list virtualization for a feed of variable-height items.

## Architecture at a Glance (what actually runs)

| Component | Where | Why this one |
|-----------|-------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`, port **3001**) | `npm run dev` (`PORT=3001 tsx watch`) | Express; also runs the outbox relay. The app is exported separately from the listener so `app.test.ts` can drive it with supertest |
| **Image worker** (`backend/src/workers/image-worker.ts`) | `npm run dev:worker` | Consumes RabbitMQ, resizes with sharp (`services/mediaPipeline.ts`), publishes, then performs the hybrid fan-out |
| **PostgreSQL 16** (5432) | `docker-compose.yml` | `users`, `posts`, `post_media`, `follows`, `likes`, `comments`, `comment_likes`, `saved_posts`, `stories`, `story_views`, `outbox_events`, `idempotency_keys` |
| **Cassandra 4.1** (9042) | `docker-compose.yml` + `cassandra-init` | DMs only, keyspace `instagram_dm` from `backend/db/cassandra-init.cql` |
| **Valkey/Redis 7** (6379) | `docker-compose.yml` | Timelines (`timeline:<userId>` sorted sets with a `~built` marker), post cache (`post:v2:<id>`), story trays, sessions, rate-limit counters |
| **RabbitMQ 3** (5672, mgmt 15672) | `docker-compose.yml` | `image-processing` (unchanged), `image-processing-retry` (5 s delay), `image-processing-dlq`; publisher confirms |
| **MinIO** (9000, console 9001) | `docker-compose.yml` + `minio-init` | Bucket `instagram-media`, public so rendition URLs are directly fetchable |

Services under `backend/src/services/`: `feedService.ts` + `timeline.ts` (hybrid fan-out, merge, rebuild), `outbox.ts`, `queue.ts`, `mediaPipeline.ts`, `idempotency.ts`, `visibility.ts`, `messageService.ts` + `cassandra.ts`, `storage.ts`, `redis.ts`, `db.ts`, `rateLimiter.ts`, `circuitBreaker.ts`, `metrics.ts`, `logger.ts`. Frontend is React 19 + TanStack Router + Zustand + Tailwind; `routes/index.tsx` is the virtualized feed and `hooks/useOptimisticToggle.ts` drives likes and saves. Vite proxies `/api` → `localhost:3001`.

## Key Design Decisions

The reasoning lives in [architecture.md → Key Design Decisions](./architecture.md#key-design-decisions); this is the short version, with what the code does today.

1. **Hybrid fan-out.** Below `FEED_CELEBRITY_THRESHOLD` (default 10,000) followers, the worker pages through followers by keyset and writes each page as one Redis pipeline of a Lua script that only touches timelines that exist; above it, nothing is pushed and `getFeedPage` merges those authors' recent posts at read time. Feed pages use a `(created_ms, id)` cursor.
2. **Timelines are a cache.** A missing `~built` marker triggers a rebuild from PostgreSQL (marker first, so a concurrent fan-out isn't lost); timelines are capped at 500 and expire after 7 idle days; readers past the cap continue from PostgreSQL.
3. **Uploads are retry-safe end to end.** `Idempotency-Key` on `POST /posts`, the post and an outbox event committed together, a relay with broker confirms, an idempotent worker with deterministic object keys, 3 attempts through a retry queue, then the dead-letter queue and status `failed`.
4. **Cassandra for DMs**, partitioned by conversation with TimeUUID clustering; every conversation route checks membership first.
5. **Likes are naturally idempotent.** `INSERT … ON CONFLICT DO NOTHING RETURNING` decides in one statement; `idempotent: true` tells the optimistic client to undo its +1.
6. **The feed virtualizes with measured rows**, because post heights vary; the profile grid doesn't need to.

## Current State

Runs end to end with `docker-compose up -d` (PostgreSQL, Valkey, RabbitMQ, Cassandra with `cassandra-init`, MinIO with `minio-init`), then `npm run dev` (API on 3001) and `npm run dev:worker`. Cassandra has a 60-second `start_period` and is the slow one. The schema in `backend/src/db/init.sql` is re-runnable.

Working: registration/login (session id regenerated on login); multi-image posts with filters, an `Idempotency-Key`, a transactional outbox and async processing with bounded retries; hybrid fan-out feed with keyset pagination, lazy timeline rebuild and a circuit breaker that returns a `degraded` page; Explore with a keyset cursor; profiles, follow/unfollow (timeline backfill and cleanup); likes, saves, threaded comments and comment likes; private accounts enforced on post detail, comments, replies, likes lists, interactions and stories (`404`); stories with a 60-second tray cache bounded by expiry; DMs on Cassandra (participants only); per-action Redis rate limiting; Prometheus metrics, Pino logs, liveness/readiness and graceful shutdown; 91 offline vitest tests in 7 files.

Seeded logins, all with password `password123`: `alice`, `bob`, `carol`, `david`, `emma` (and `@example.com` emails), and `admin@example.com` (admin). With only a handful of followers per seeded account, set `FEED_CELEBRITY_THRESHOLD=4` to see the pull path (`alice` becomes a "celebrity").

Simplified or omitted: uploads go through the API instead of signed URLs; the image worker does fan-out itself (no separate fan-out workers); no CDN, ranking, video, notifications or search beyond `ILIKE`; DMs are HTTP only. See [architecture.md → Known limitations](./architecture.md#known-limitations).

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. Its "Design Decisions Log" got the single most important fact about this system backwards — **"Decision 1: Pull vs Push for Feeds → Decision: Simple pull model for learning project"** — when `image-worker.ts` has fanned out to every follower's `timeline:<userId>` sorted set and `routes/feed.ts` has read from it as the primary path all along; the pull query is the *fallback*, not the design. The checklist separately marked the explore page as unbuilt (`- [ ] Explore page`) while `frontend/src/routes/explore.tsx` existed, and its "Backend Structure" diagram described a JavaScript layout (`src/api/index.js`, `src/worker/image.js`, `src/shared/db.js`) that matches nothing in the TypeScript tree.
- **Fan-out moved after `COMMIT`:** the worker previously pushed post IDs into follower timelines inside the transaction, so a rollback left post IDs in feeds pointing at media rows that were never committed — followers saw entries that resolved to nothing.
- **Backend `dev` pinned to `PORT=3001`** to match the Vite proxy target, replacing a fallback to the default port that surfaced as connection failures looking like auth bugs.
- **Circuit breaker with fallback on feed generation:** feed assembly touches Postgres several times per post (media, like state, save state), so a slow database turned every feed request into a pile-up. `feed.ts` now runs inside an opossum breaker with a fallback, so a struggling database yields a degraded feed instead of a stalled process.
- **Prometheus label cardinality:** metrics label on normalized route patterns rather than raw paths, so post and user IDs don't each create their own time series.
- **Timeline trimming:** `timelineAdd` follows every `ZADD` with `ZREMRANGEBYRANK(key, 0, -501)` — without the trim, a user's sorted set grows for the lifetime of the account and Redis memory becomes a function of total posts ever published by everyone they follow.
- **Tests decoupled from infrastructure:** `app.ts` exports the Express app separately from `index.ts`'s listener, and `app.test.ts` mocks `db`, `redis`, `storage`, `queue`, `cassandra`, and `bcryptjs` before import — so `npm test` runs without Docker, which matters given this project needs five services.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide Postgres, Redis, RabbitMQ, Cassandra, and MinIO). Verification is local: `npm test` and `npm run type-check`, then `npm run triage instagram`.
- **2026-10-10 (implementation + docs pass):** Confirmed the defects below before fixing them: the feed, privacy, session and Explore ones by reproducing them against PostgreSQL + Redis, the RabbitMQ and Cassandra ones by reading the code (neither runs in this environment). *Feed:* the pull fallback ignored the cursor, so every page repeated the newest posts forever; the offset cursor drifted as posts arrived; a 60-second `feed:<user>:<offset>` cache kept a liked post showing unliked; unfollowed accounts stayed in the timeline; processing posts leaked into feeds and grids; Explore's created_at cursor against an engagement ordering repeated two posts and never showed one. Replaced with the hybrid fan-out (`feedService.ts`, `timeline.ts`), keyset cursors, one-query hydration (was 3 queries per post) and no response cache. *Pipeline:* "commit, then publish" stranded posts in `processing` whenever RabbitMQ was down, and the consumer stopped for good after a reconnect; added the transactional outbox, `Idempotency-Key`, deterministic object keys, retry queue + DLQ, consumer re-registration and graceful shutdown. *Security:* any signed-in user could read or post into any DM conversation by id, and private accounts' posts and comments were readable by id; added membership and visibility checks (`404`), and session regeneration at login. Also: every DM wiped the inbox's username/avatar and pinned unread at 1; `init.sql` wasn't re-runnable; story rings counted as seen after one of several stories; `/api/health/detailed` reported storage "ok" with MinIO down. Rewrote architecture.md (1,124 → ~480 lines) and the three answers around one layered overview and generated sequence diagrams.

## Open Questions

1. The celebrity threshold is read from the current `follower_count` at publish and at read. An author who crosses it downward leaves posts made while "celebrity" out of followers' timelines until a rebuild. Is a periodic re-push on threshold changes worth it, or should timelines simply be rebuilt for that author's followers?
2. Cassandra's `conversations_by_user` still denormalizes the other participant's username and avatar, and nothing rewrites them on a profile change. Event-driven sync (500 writes for a user with 500 conversations) or re-resolve identity at read time?
3. A dead-lettered image job marks the post `failed` but leaves its originals in MinIO, and a job that crashes the worker process (rather than throwing) is redelivered forever by a classic queue. Quorum queues with a delivery limit, plus a cleanup job for failed posts' originals?
4. The frontend copies server data into component state. At what size does moving to a query cache (shared post state across feed, detail and profile) pay for itself here?

## Resources

- [Instagram Engineering Blog](https://instagram-engineering.com/) — including their own writing on sharding and feed delivery
- [Cassandra data modeling](https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/index.html) — partition and clustering key design behind `cassandra-init.cql`
- [Cassandra TimeUUID / timeuuid functions](https://cassandra.apache.org/doc/latest/cassandra/cql/functions.html) — why the clustering key is a TimeUUID and not a timestamp
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — the feed timeline structure and `ZREVRANGE`/`ZREMRANGEBYRANK`
- [sharp](https://sharp.pixelplumbing.com/) — the resize/filter pipeline in `services/storage.ts`
- [TanStack Virtual: dynamic element sizes](https://tanstack.com/virtual/latest/docs/api/virtualizer) — the `measureElement` approach in the feed

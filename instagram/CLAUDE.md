# Instagram — Development with Claude

## Project Context

Instagram is the project in this repo with the most *different kinds* of hard problem in one product, and the interesting thing is that each one wants a different datastore. Posts and the social graph need referential integrity and transactions, so they're PostgreSQL. Direct messages are append-only, time-ordered, partitioned by conversation, and written far more than they're read — the exact shape Cassandra exists for, and a shape Postgres serves badly once a conversation has a million rows and you're always reading the newest fifty. Feeds are a ranked list that must be assembled in tens of milliseconds, which is a Redis sorted set. Images are large binary blobs, which is object storage. So this is a genuinely polyglot system, and the cost of that — four datastores to run, no cross-store transactions, denormalized copies that can drift — is itself the lesson.

The other defining problem is the feed. Reading a feed on demand means "select posts from everyone I follow, ordered by time," which is a join against the follow graph on every single page load — and a user following 500 accounts makes that expensive at exactly the moment the app opens. So this implementation does **fan-out on write**: when a post finishes processing, the worker pushes its ID into a Redis sorted set for every follower, and reading the feed becomes a `ZREVRANGE` plus a batch fetch by ID.

Third: image upload can't be synchronous. Resizing to multiple resolutions and applying a filter takes seconds, and holding an HTTP request open for that means a user staring at a spinner and a request-handling thread doing CPU work. Uploads accept the original, mark the post `processing`, and hand off to a RabbitMQ worker.

**Learning goals:** polyglot persistence with each store chosen for an access pattern, fan-out-on-write feeds and where they break, async media pipelines with status tracking, Cassandra data modeling with TimeUUID clustering, and list virtualization for a feed of variable-height items.

## Architecture at a Glance (what actually runs)

| Component | Where | Why this one |
|-----------|-------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`, port **3001**) | `npm run dev` (`PORT=3001 tsx watch`) | Express; app is exported separately from the listener so `app.test.ts` can drive it with supertest |
| **Image worker** (`backend/src/workers/image-worker.ts`) | `npm run dev:worker` | Separate process consuming RabbitMQ — resizes with sharp, then performs the feed fan-out |
| **PostgreSQL 16** (5432) | `docker-compose.yml` | `users`, `posts`, `post_media`, `stories`, `story_views`, `follows`, `likes`, `comments`, `comment_likes`, `saved_posts` — the social graph and anything needing a transaction |
| **Cassandra 4.1** (9042) | `docker-compose.yml` + `cassandra-init` | DMs only, keyspace `instagram_dm` from `backend/db/cassandra-init.cql` |
| **Valkey/Redis 7** (6379) | `docker-compose.yml` | Feed timelines (`timeline:<userId>` sorted sets), session store, story-tray cache, and rate-limit counters |
| **RabbitMQ 3** (5672, mgmt 15672) | `docker-compose.yml` | Image-processing job queue between the API and the worker |
| **MinIO** (9000, console 9001) | `docker-compose.yml` + `minio-init` | Bucket `instagram-media`, set public so processed URLs are directly fetchable |

Services under `backend/src/services/`: `db.ts`, `redis.ts` (including `timelineAdd`/`timelineGet`), `cassandra.ts`, `messageService.ts`, `storage.ts` (sharp pipeline), `queue.ts` (amqplib), `rateLimiter.ts` (per-action Redis-backed limiters — post, follow, login, like, comment, story, feed), `circuitBreaker.ts` (opossum with `fallbackWithDefault`), `metrics.ts`, `logger.ts`. Routes are split by resource under `backend/src/routes/`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind. `frontend/src/routes/index.tsx` is the virtualized feed; `explore.tsx`, `profile.$username.tsx`, `post.$postId.tsx`, `create.tsx`, and `settings.tsx` round it out. Vite proxies `/api` → `localhost:3001`.

## Key Design Decisions

### 1. Fan-out on write into Redis sorted sets, with a read-time fallback
When the worker finishes processing a post it queries `follows` and calls `timelineAdd(followerId, postId, timestamp)` for each follower, plus the author's own timeline. Each timeline is a sorted set trimmed to 500 entries. `GET /api/v1/feed` does `timelineGet` and batch-fetches those post IDs.

Fan-out on read — join `posts` against `follows` at request time — is simpler and always fresh, and it fails on the shape of the work. That join runs on every feed load for every user, and its cost scales with how many accounts you follow, so the most engaged users get the slowest app. Precomputing moves the work to write time, where it happens once per post regardless of how many times the feed is read, and the read collapses to a sorted-set range scan.

The failure mode we're buying into is the celebrity problem, and it's severe: fan-out is O(followers) *per post*, so an account with a million followers generates a million Redis writes for one photo, serialized in a `for` loop in `image-worker.ts` with no batching. Real systems solve this with a hybrid — fan out for normal accounts, fan *in* at read time for high-follower accounts, merging the two at request time. We didn't build the hybrid. The mitigation that does exist is a genuine fallback: if `timelineGet` returns empty (new user, trimmed timeline, cold Redis), `feed.ts` falls back to the read-time join, so the feed degrades rather than appearing blank. The 500-entry cap is the other trade — scroll deep enough and you fall off the precomputed timeline entirely.

### 2. Cassandra for DMs, keyed by conversation with TimeUUID clustering
`messages_by_conversation` partitions on `conversation_id` and clusters on a `message_id` TimeUUID in `DESC` order, with a one-year TTL and `gc_grace_seconds` of one day.

Keeping DMs in Postgres would work until it doesn't, and the way it stops working is specific. A messages table grows without bound and is almost never read except for the newest page of one conversation, so the index is huge, mostly cold, and every read pays for a B-tree that exists to serve rows nobody wants. Cassandra's partition-plus-clustering model makes "newest 50 in this conversation" a contiguous sequential read of one partition with no index traversal, and writes are append-only into a commit log rather than random B-tree inserts. TimeUUID is what makes the clustering order both chronological *and* unique — a plain timestamp collides when two messages land in the same millisecond, and a collision in a clustering key means one message silently overwrites the other.

The costs are the ones that always come with Cassandra, and they're all visible here. No joins, so `conversations_by_user` **denormalizes** `other_username` and `other_profile_picture` — meaning a user changing their avatar leaves every conversation row showing the old one until something rewrites them, and no such sync job exists. No cross-store transactions, so a DM write and a Postgres update can't be atomic. And the inbox table is keyed `(user_id, last_message_at, conversation_id)`, which makes "sort my inbox by recency" free but makes updating a conversation's position a delete-and-reinsert, because the sort key is part of the primary key.

### 3. Image processing is async, and the post is visible as `processing` before it's ready
`POST /api/v1/posts` uploads the original to MinIO, inserts the post with `status: 'processing'`, publishes a RabbitMQ job, and returns immediately. The worker resizes to multiple sizes with sharp, updates `post_media` with the processed URLs, sets `status: 'published'`, deletes the original, and only then fans out.

Doing this inline means the HTTP request is held open for seconds of CPU-bound image work — a request handler that can't serve anything else, in a single-threaded runtime, in a product where uploads spike. It also couples the user's success to sharp not throwing. The async split makes upload latency a function of network transfer only.

What we give up is that a post exists in a state where it isn't viewable, so the client must handle `processing` explicitly, and the fan-out is delayed by however long processing takes — a post is genuinely absent from followers' feeds until the worker finishes. Failure is worse: the worker sets `status: 'failed'` and rolls back its transaction, but nothing retries and nothing notifies the user, so a failed post is a silent dead row. The deliberate ordering choice is that fan-out happens *after* `COMMIT`, not inside the transaction — publishing to followers' timelines before the media rows are durably committed would put unviewable posts in feeds.

### 4. Likes are idempotent by state check, not by idempotency key
`POST /:postId/like` checks whether the like row already exists and returns `{ idempotent: true }` rather than erroring or double-counting.

A like is naturally idempotent — it's a set membership, not an event — so the cheap correct thing is to make the endpoint reflect that. This matters because the frontend does optimistic updates: the UI increments the count immediately and reconciles later, so a double-tap or a retry after a timeout will absolutely send the request twice. Without the check, either the unique constraint throws (and the optimistic UI rolls back a like that actually succeeded, which looks like the app losing the tap) or the denormalized `like_count` drifts upward permanently. Reporting `idempotent` in the response lets the client distinguish "your like registered" from "you liked it again," which is exactly what the optimistic path needs to reconcile correctly.

The trade-off is a read before every write, which is why `likeRateLimiter` exists alongside it.

### 5. The feed virtualizes with dynamic measurement; the photo grid doesn't need to
`routes/index.tsx` uses `useVirtualizer` with `estimateSize: () => 600`, `overscan: 3`, and a `measureElement` callback reading `getBoundingClientRect().height`.

Rendering the whole feed is untenable: each post card holds an image, an action bar, a caption, and comments, so a few hundred posts is thousands of DOM nodes and hundreds of decoded images held in memory — on mobile, the tab gets killed. Virtualization keeps mounted nodes proportional to the viewport.

The `measureElement` part is what makes this different from the sibling `icloud` project's photo grid. Post heights genuinely vary — a one-line caption versus a paragraph, a square photo versus a portrait — so a fixed estimate would accumulate scroll-offset error and produce the classic symptom of the scrollbar jumping as items render at their real height. Measuring costs a layout read per item but keeps offsets honest. iCloud's grid can skip it because its thumbnails are uniform 200×200 by construction. The remaining cost here is that `estimateSize` is still a guess for unmeasured items, so fast scrolling into unrendered territory can still shift slightly.

## Current State

Runs end to end, and this is the heaviest stack in the batch — `docker-compose up -d` starts Postgres, Valkey, RabbitMQ, Cassandra (plus a `cassandra-init` container applying the CQL schema), and MinIO (plus `minio-init` creating the public bucket). Cassandra has a 60-second `start_period` and is the slow one. Then `npm run dev` (API on 3001) and `npm run dev:worker` (image worker) in separate terminals.

Working: registration/login with bcrypt and Redis-backed sessions; post creation with multi-image upload, filters, and async processing through RabbitMQ into sharp; feed via fan-out-on-write with read-time fallback and circuit-breaker protection; explore; profiles with post grids; follow/unfollow; likes and saves with optimistic updates and idempotent endpoints; threaded comments with likes; stories with 24-hour expiry (`expires_at DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours'`), a cached story tray, view tracking with per-user dedup, and a viewer list; direct messages on Cassandra with conversation lookup, inbox, read receipts, reactions, and 5-second-TTL typing indicators; per-action Redis rate limiting; opossum circuit breakers with fallbacks; prom-client metrics; Pino logging; and a vitest suite (`backend/src/app.test.ts`) that drives the app through supertest with all shared modules mocked.

Seeded logins, all with password `password123`: `alice@example.com`, `bob@example.com`, `carol@example.com`, `david@example.com`, `emma@example.com`, and `admin@example.com` (admin). Seeded posts, follows, comments, and likes mean the feed renders populated on first login rather than empty.

Simplified or omitted: no hybrid fan-out for high-follower accounts (decision 1). No sync job rewriting denormalized usernames and avatars into Cassandra conversation rows, so profile edits leave stale copies in the inbox view. No retry or user notification for failed image processing. No push notifications, no hashtag or user search, and no story-expiry sweeper — expired stories are filtered by query rather than deleted.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. Its "Design Decisions Log" got the single most important fact about this system backwards — **"Decision 1: Pull vs Push for Feeds → Decision: Simple pull model for learning project"** — when `image-worker.ts` has fanned out to every follower's `timeline:<userId>` sorted set and `routes/feed.ts` has read from it as the primary path all along; the pull query is the *fallback*, not the design. The checklist separately marked the explore page as unbuilt (`- [ ] Explore page`) while `frontend/src/routes/explore.tsx` existed, and its "Backend Structure" diagram described a JavaScript layout (`src/api/index.js`, `src/worker/image.js`, `src/shared/db.js`) that matches nothing in the TypeScript tree.
- **Fan-out moved after `COMMIT`:** the worker previously pushed post IDs into follower timelines inside the transaction, so a rollback left post IDs in feeds pointing at media rows that were never committed — followers saw entries that resolved to nothing.
- **Backend `dev` pinned to `PORT=3001`** to match the Vite proxy target, replacing a fallback to the default port that surfaced as connection failures looking like auth bugs.
- **Circuit breaker with fallback on feed generation:** feed assembly touches Postgres several times per post (media, like state, save state), so a slow database turned every feed request into a pile-up. `feed.ts` now runs inside an opossum breaker with a fallback, so a struggling database yields a degraded feed instead of a stalled process.
- **Prometheus label cardinality:** metrics label on normalized route patterns rather than raw paths, so post and user IDs don't each create their own time series.
- **Timeline trimming:** `timelineAdd` follows every `ZADD` with `ZREMRANGEBYRANK(key, 0, -501)` — without the trim, a user's sorted set grows for the lifetime of the account and Redis memory becomes a function of total posts ever published by everyone they follow.
- **Tests decoupled from infrastructure:** `app.ts` exports the Express app separately from `index.ts`'s listener, and `app.test.ts` mocks `db`, `redis`, `storage`, `queue`, `cassandra`, and `bcryptjs` before import — so `npm test` runs without Docker, which matters given this project needs five services.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide Postgres, Redis, RabbitMQ, Cassandra, and MinIO). Verification is local: `npm test` and `npm run type-check`, then `npm run triage instagram`.

## Open Questions

1. Fan-out is an unbatched loop over every follower, so one post from a large account is a long serial run of Redis writes inside a worker that isn't processing anything else meanwhile. Is the first fix batching (pipeline the `ZADD`s), or does it need the real hybrid — and at what follower count does read-time fan-in actually become cheaper?
2. Cassandra's `conversations_by_user` denormalizes username and avatar, and nothing rewrites them on profile change. Is an event-driven sync worth it when a user with 500 conversations generates 500 writes per avatar change, or should the inbox re-resolve identity from Postgres at read time and give up the whole point of denormalizing?
3. A failed image job sets `status: 'failed'` and stops — no retry, no notification, no cleanup of the orphaned original in MinIO. What's the right recovery: a dead-letter queue with manual replay, bounded automatic retries, or surfacing the failure to the user with a re-upload prompt?
4. Timelines are capped at 500 entries, so deep scrolling falls off the precomputed feed and into the fallback query — which returns a *chronological* list, not the ranked one. Should the fallback be paginated to continue seamlessly, or is the honest answer that the feed simply ends at 500?

## Resources

- [Instagram Engineering Blog](https://instagram-engineering.com/) — including their own writing on sharding and feed delivery
- [Cassandra data modeling](https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/index.html) — partition and clustering key design behind `cassandra-init.cql`
- [Cassandra TimeUUID / timeuuid functions](https://cassandra.apache.org/doc/latest/cassandra/cql/functions.html) — why the clustering key is a TimeUUID and not a timestamp
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — the feed timeline structure and `ZREVRANGE`/`ZREMRANGEBYRANK`
- [sharp](https://sharp.pixelplumbing.com/) — the resize/filter pipeline in `services/storage.ts`
- [TanStack Virtual: dynamic element sizes](https://tanstack.com/virtual/latest/docs/api/virtualizer) — the `measureElement` approach in the feed

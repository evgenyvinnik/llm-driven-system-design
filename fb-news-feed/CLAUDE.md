# Facebook News Feed — Development with Claude

## Project Context

The news feed problem is the canonical read/write asymmetry trap. You can precompute every user's feed on write (push / fan-out-on-write), giving O(1) reads — or you can assemble it on read (pull / fan-out-on-read), giving O(1) writes. Both are correct. Both fall over, just at opposite ends of the follower distribution.

Push dies on celebrities. A user with 10 million followers posting once means 10 million feed writes for a single action — write amplification of 10⁷ — and if they post ten times a day that's 100 million writes from one account. The post is "published" only when the last write lands, so the tail of that fan-out takes minutes, and followers see the post at wildly different times.

Pull dies on everyone else. Assembling a feed at read time means querying every followed user's recent posts and merge-sorting them. A user following 500 people needs 500 lookups per feed refresh, and feed refreshes are the single most common action in the product. Reads outnumber writes by orders of magnitude, so you've optimized the rare operation and taxed the common one.

The resolution is that these two failures don't overlap: almost every user is cheap to push to, and the tiny number of accounts that break push are exactly the accounts whose posts are cheap to pull, because everyone is already fetching them. So the system uses both, splitting at a follower-count threshold, and the interesting engineering is in the merge.

**Learning goals:** hybrid push/pull fan-out and where the threshold belongs, ranking with engagement × recency-decay × affinity, feed storage in both Postgres and Redis sorted sets, affinity accumulation from interactions, and list virtualization for an infinite feed.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **Express + `ws` server** (`backend/src/index.ts`) | **3000** | REST API plus a WebSocket for live feed updates. Each connection opens its own Redis subscriber on `feed_updates:<userId>`, so pushes work regardless of which instance holds the socket |
| **PostgreSQL 16** | 5432 | `feed_items` is the durable materialized feed — one row per (user, post). `affinity_scores` accumulates interaction weights. Redis can be flushed; these can't |
| **Valkey (Redis)** | 6379 | Sorted sets everywhere: `feed:<userId>` (score = timestamp, capped at 1,000, 24h TTL), `celebrity_posts:<authorId>` (last 100), `affinity:<userId>`, plus sessions and per-user pub/sub channels |

The fan-out logic is entirely in `backend/src/services/fanout.ts` — `fanoutPost`, `removeFanout`, `updateAffinity`, `calculatePostScore`. Feed assembly and merging is `backend/src/routes/feed.ts`; the rest of the API is `routes/{posts,users,auth}.ts` with cross-cutting modules in `backend/src/shared/` (`cache.ts`, `circuit-breaker.ts`, `metrics.ts`, `health.ts`, `idempotency.ts`, `logger.ts`). Frontend is React 19 + TanStack Router + Zustand + Tailwind, and the feed at `frontend/src/routes/index.tsx` uses `@tanstack/react-virtual` (`estimateSize: 400`, `overscan: 3`).

## Key Design Decisions

### 1. Hybrid fan-out with a 10,000-follower threshold

`fanoutPost` reads the author's `is_celebrity` flag and `follower_count`. Below `CELEBRITY_THRESHOLD` (10,000), it fans out: one batched multi-row `INSERT` into `feed_items` for all followers, plus a Redis pipeline doing `ZADD` / `ZREMRANGEBYRANK` / `EXPIRE` per follower feed. At or above the threshold, it writes nothing to any follower — just `ZADD celebrity_posts:<authorId>`, trimmed to the most recent 100.

The threshold placement is the actual decision, and it's an asymmetric bet. Set it too high and you keep celebrity write amplification — a 50,000-follower account still generates 50,000 writes per post, and the fan-out latency becomes user-visible. Set it too low and you push ordinary accounts onto the pull path, where every one of their followers pays a per-author lookup on every feed load; with a threshold of 100, a user following 500 people is doing hundreds of pull queries per refresh and you've rebuilt pure pull. 10,000 sits where the follower distribution is genuinely sparse — very few accounts live near it, so the exact number matters less than being in the right order of magnitude.

What we give up is a real consistency seam. A post crossing the threshold behaves differently before and after, and an account that grows past 10,000 has old posts in followers' `feed_items` and new posts only in `celebrity_posts` — the feed silently draws from two mechanisms with different freshness. Nothing backfills or migrates on threshold crossing.

### 2. Feed state written to Postgres *and* Redis, with Redis as the disposable copy

Every regular fan-out writes both: durable rows in `feed_items` (with `ON CONFLICT (user_id, post_id) DO NOTHING`) and a capped sorted set `feed:<userId>` with a 24-hour TTL. Reads try Redis first and fall back to the table, re-populating the cache.

Redis-only would be fastest and is what a pure cache design implies — but a Redis restart would mean every user's feed vanishes, and rebuilding tens of thousands of feeds simultaneously from scratch is a thundering herd against Postgres at exactly the moment the system is already degraded. Postgres-only means every feed read is an indexed scan plus join, which the `(user_id, score DESC)` index makes fast but not *free*, on the most frequent query in the product.

Writing both means the cache is genuinely disposable: expiry, eviction, or a full flush costs a slow first read, not data loss. The `ZREMRANGEBYRANK` cap at 1,000 items bounds memory per user regardless of how much their network posts, and the 24-hour TTL means dormant users don't hold cache for feeds they aren't reading. The cost is write amplification of a different kind — every fan-out now does two writes per follower — and a window where the two can disagree if one succeeds and the other fails, with no reconciliation.

### 3. Ranking is `engagement × recency_decay × affinity_boost`, multiplicative on purpose

`calculatePostScore`: engagement is `likes×1 + comments×3 + shares×5`; recency decay is `1 / (1 + ageHours × 0.08)`; affinity boost is `1 + min(affinity, 100)/100`, capped at 2×.

Multiplication rather than a weighted sum is the load-bearing choice. Under addition, a viral post with 50,000 likes stays near the top of your feed for days, because a large engagement term simply dominates the recency term no matter how old the post gets. Multiplication makes decay act as a *scaling* factor — that same post at 48 hours old is multiplied by roughly 0.2 regardless of how large its engagement was, so age suppresses everything proportionally and nothing can be old enough to matter but still win.

The engagement weights encode effort: a comment costs more than a like, a share more than a comment, so they're weighted 3× and 5×. The affinity cap at 2× is the deliberate limit on the filter bubble — without it, an accumulating interaction score would eventually mean you only ever see posts from the three people you interact with most, and a hard ceiling keeps a stranger's genuinely engaging post competitive with a close friend's mediocre one.

What we give up: no negative signals (a hidden or reported post scores the same as an ignored one), no content-type or diversity handling, and constants — `0.08`, the 1/3/5 weights, the 100-point affinity cap — that are guesses with no A/B mechanism to validate them.

### 4. Affinity accumulates monotonically from weighted interactions

`updateAffinity` upserts into `affinity_scores` with weights `view: 0.5, like: 2, comment: 5, share: 10`, and mirrors into a Redis sorted set via `ZINCRBY`.

Computing affinity on demand — counting recent interactions at feed-assembly time — would keep it perfectly fresh but puts an aggregate query per candidate author on the read path, which is the path we're spending everything else to protect. Incrementing on write means the score is a single indexed lookup at read time.

The weights are ordered by how much signal the action carries about genuine interest: a view is nearly free and nearly meaningless, a share is a public endorsement. The honest flaw is that the score only ever goes *up*. `last_interaction_at` is recorded but never used to decay anything, so a friendship that was intense two years ago and dormant since still outranks someone you talk to weekly today. Real affinity systems apply time decay; this one doesn't, which means the ranking's notion of "close" is really "cumulative historical interaction".

### 5. The feed merge is per-celebrity, and it's the design's weak point

Assembly in `routes/feed.ts` runs three steps: read the pushed feed (Redis, falling back to `feed_items`), then for *each* celebrity the user follows, read the last 10 posts from `celebrity_posts:<id>` (falling back to a Postgres query per celebrity), then merge, deduplicate, and rank.

This is the cost pull was always going to impose, and it scales with celebrities-followed rather than total-followed — which is the whole point, since users follow far fewer celebrities than regular accounts. But the loop is sequential and does one Redis round-trip per celebrity, so a user following 50 celebrities pays 50 sequential round-trips on every feed load, and on a cache miss each becomes a separate Postgres query. Pipelining the Redis reads would collapse the common case to one round-trip; it isn't done.

There's also a deliberate fallback worth naming: when a user's merged feed comes back empty (new account, follows nobody), the route returns globally popular public posts ordered by like count. Without it, a fresh account sees a blank screen — technically correct and a terrible first impression.

## Current State

Runs end to end on backend 3000 + Vite 5173 (Vite proxies `/api` to 3000). Working: register/login with bcrypt and Redis-backed sessions, post creation with optional image URLs and privacy settings, hybrid fan-out on publish, feed assembly merging pushed and pulled posts with ranking applied, likes and comments with counters, follow/unfollow, profile pages, user search, an `/explore` endpoint, affinity tracking on interactions, soft-deleted posts unwound from feeds via `removeFanout`, live feed updates over WebSocket (each connection subscribes to its own `feed_updates:<userId>` Redis channel), Prometheus metrics (fan-out operations by type, follower-count histogram, fan-out duration, cache hit/miss by key class), Pino structured logging, Opossum circuit breakers, health checks, and idempotency helpers. The frontend feed is virtualized with `@tanstack/react-virtual` and does infinite scroll.

Seeded logins, all with password **`password123`**: **`john@example.com`** (John Doe, 150 followers), **`jane@example.com`** (Jane Smith, 320), **`tech@example.com`** (Tech Guru — `is_celebrity = TRUE`, 1,000,000 followers, which is what makes the pull path actually exercisable), and **`admin@example.com`** (Admin User).

Intentionally simplified or absent: no image upload pipeline (posts carry image URLs; `multer` is a dependency but there's no upload route), no ML ranking (the score is the hand-tuned formula in decision 3), no notifications UI despite a `notifications` table and indexes existing in the schema, no admin dashboard, no load balancer across the `dev:server1/2/3` instances, and no tests.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md with this structure. The checklist was wrong on its face: Phase 3 "Scaling and Optimization" was marked *Not started* with "Add caching layer", "Optimize database queries", and "Add monitoring" listed as pending work — while Redis sorted-set feed caching, celebrity-post caching, 23 `CREATE INDEX` statements in `init.sql`, and a full `prom-client` metrics surface (including per-type fan-out counters and duration histograms) were all already implemented and in use. The old file's "Open Questions" also asked "What's the right TTL for cached feed items?" when the code has answered 24 hours since the fan-out was written.
- **Feed fan-out batched into one INSERT:** `fanoutPost` builds a single multi-row `INSERT ... VALUES ($1,$2,$3,$4), (...)` for all followers rather than looping per follower. Per-follower inserts meant one round-trip each, so a 5,000-follower author generated 5,000 sequential round-trips and the fan-out took minutes. The Redis writes are similarly issued through one pipeline.
- **`ON CONFLICT (user_id, post_id) DO NOTHING` on feed inserts:** a retried fan-out (or a follower who somehow appears twice in the friendship set) would otherwise violate the primary key and abort the whole batch, losing the fan-out for every follower — not just the duplicate.
- **Feed cache bounded:** `ZREMRANGEBYRANK` caps `feed:<userId>` at 1,000 entries and `celebrity_posts:<id>` at 100, with a 24-hour TTL on user feeds. Before the caps, a user in a high-volume network accumulated an unbounded sorted set that nothing ever trimmed.
- **Empty-feed fallback to popular posts:** a new user following nobody got a blank feed, which reads as a broken app rather than an empty one. `routes/feed.ts` now falls back to public posts ordered by like count.
- **Fan-out failures are logged, not thrown:** `fanoutPost` catches and returns `{success: false}` so a Redis or Postgres hiccup during fan-out doesn't fail the post creation the user already committed to. The trade-off is a post that exists but never reached anyone's feed, with only a log line recording it.
- **Port:** no `PORT=` pin was needed here — `index.ts` defaults to 3000 and the Vite proxy targets 3000, so they already agreed.
- **CI:** the repo-wide smoke-test workflow was removed — a CI runner can't provide the Postgres and Redis services these tests need, so it failed on every PR without signalling a real defect.

## Open Questions

1. Nothing happens when an account crosses the 10,000-follower threshold: old posts sit in followers' `feed_items` while new ones only land in `celebrity_posts`. Should crossing trigger a backfill, should the read path always check both regardless of current status (costing an extra lookup for every author), or is the inconsistency simply invisible enough to ignore?
2. The celebrity merge loop is sequential — one Redis round-trip per followed celebrity, and one Postgres query per cache miss. Pipelining fixes the round-trips, but what's the right answer for a user following 200 celebrities, where even a pipelined result set is mostly posts that will rank below the fold?
3. Affinity only accumulates and `last_interaction_at` is written but never read. Adding time decay means either a batch job rewriting every score periodically (expensive, and stale between runs) or computing decay at read time from `last_interaction_at` (cheap per row, but the stored score stops being meaningful on its own). Which?
4. Fan-out runs inline in the post-creation request. A user with 9,999 followers blocks their own POST on ~10,000 feed writes. Should fan-out move to a queue — and if so, how long is it acceptable for a post to be invisible to followers after the author has been told it published?

## Resources

- [Facebook: the new News Feed](https://engineering.fb.com/2010/05/13/web/the-new-facebook-news-feed/) — the original ranking framing
- [The infrastructure behind Twitter scale](https://blog.twitter.com/engineering/en_us/topics/infrastructure/2017/the-infrastructure-behind-twitter-scale) — the canonical hybrid fan-out write-up, including the celebrity carve-out
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — `ZADD`/`ZREVRANGE`/`ZREMRANGEBYRANK`, the backbone of both feed caches
- [Redis pipelining](https://redis.io/docs/latest/develop/use/pipelining/) — the fix for the sequential merge in decision 5
- [TanStack Virtual](https://tanstack.com/virtual/latest) — the feed virtualization in `routes/index.tsx`

# Tinder — Development with Claude

## Project Context

Swiping looks trivial and isn't. Every card the deck shows has to satisfy a conjunction of predicates that no single index serves well: within N kilometers of me, in my age range, of a gender I'm interested in, *and* interested in my gender, active recently, and not one of the possibly-thousands of people I've already swiped on. That last exclusion is the one that quietly breaks naive designs — it grows monotonically per user and has to be applied before ranking, not after, or the deck fills with people the user has already dismissed.

The second interesting problem is match detection. A match is a *mutual* like, which means every single like is also a read: "did this person already like me?" That read happens on the write path, synchronously, because the product moment is the modal that pops up the instant you swipe. Batch-computing matches would be architecturally cleaner and completely wrong — a match that arrives four minutes later is not the same feature.

Third, discovery and messaging have wildly different criticality. Elasticsearch powers the swipe deck; if it's down, discovery degrades. It has nothing to do with logging in, reading your matches, or sending a message. Treating all dependencies as equally required is what turns one slow container into a dead app.

**Learning goals:** geospatial candidate search and its index trade-offs, read-on-write mutual-match detection, idempotent swipe recording, WebSocket messaging with Redis pub/sub for cross-instance fan-out, and dependency criticality tiering at startup.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`) | **3000** | One Express process wrapped in an `http.Server` so `ws` can share the port; the gateway mounts at path `/ws` |
| **PostgreSQL** (`postgis/postgis:16-3.4`) | 5432 | Not plain Postgres — `init.sql` does `CREATE EXTENSION postgis` and indexes `users.location` with GIST; it is the system of record *and* the discovery fallback |
| **Valkey (Redis)**, via ioredis | 6379 | Swipe sets, received-likes sets, sliding-window swipe rate limiting, and pub/sub fan-out for WebSocket messages |
| **Elasticsearch 8.11** | 9200 | Primary discovery index — the `users` index carries a `geo_point` `location` alongside the filterable fields, so one query does geo + age + gender + exclusion + distance sort |

Services in `backend/src/services/`: `discoveryService.ts` (deck generation, geo search, ranking), `matchService.ts` (swipe processing and mutual detection), `messageService.ts`, `userService.ts`, `websocketGateway.ts`. Cross-cutting modules in `backend/src/shared/`: `config.ts` (all TTLs and thresholds in one place), `logger.ts` (Pino), `metrics.ts` (prom-client, including cache hit/miss counters and a DB pool gauge), `rateLimit.ts`, `retention.ts`. Schema is `backend/src/db/init.sql` — `users`, `user_preferences`, `photos`, `swipes`, `matches`, `messages`, `sessions`, plus a `calculate_age(birthdate)` SQL function used by the Postgres fallback query.

Frontend is React + TanStack Router + Zustand + Tailwind. Notable: `components/ReignsAvatar/` is a from-scratch SVG avatar generator (face, hair, clothing, accessories composed from `constants.ts`) so the app has profile art without shipping photos of real people. Vite proxies `/api` and `/uploads` → `localhost:3000` and `/ws` → `ws://localhost:3000`.

## Key Design Decisions

### 1. Elasticsearch is the primary discovery index; PostGIS is the fallback in the same function

`geoCandidateSearch()` issues one ES query — a `bool` with `terms` on gender, `range` on age, `term` on `show_me`, `range` on `last_active`, a `terms` clause enforcing that the candidate is interested in *my* gender, a `must_not` on the seen-user IDs, a `geo_distance` filter, and a `_geo_distance` sort. On any throw it calls `postgresFallbackSearch()`, which expresses the same intent with `ST_DWithin` / `ST_Distance` and `id != ALL($8)`.

Postgres alone can answer this, but not efficiently in one shape. The GIST index on `users.location` serves the radius predicate well; everything else becomes a filter applied to whatever the geo scan returned. In particular the seen-user exclusion is an array comparison evaluated per candidate row, and that array is every person the user has ever swiped on — for an active user that's thousands of UUIDs compared against every row inside their radius, on every deck refresh. Lucene handles the same exclusion as a bitset intersection over the doc-id space, which is where the asymmetry comes from. Keeping the fallback matters anyway: it's correct, it's what runs before the index is populated, and it's the thing that makes an ES outage a quality regression rather than an empty screen.

What we give up is a second copy of user data that can drift. Nothing here does incremental reindexing on profile update, so the ES `users` index is only as fresh as the last `initElasticsearchIndex()` run — the classic dual-write problem, unsolved.

### 2. Mutual-like detection happens on the swipe write path via Redis set membership

`processSwipe()` writes the swipe to Postgres, adds it to `swipes:{swiperId}:liked`, adds the swiper to `likes:received:{swipedId}`, and then — for likes only — checks `SISMEMBER swipes:{swipedId}:liked {swiperId}`. Hit means match, immediately.

The alternative most people reach for is a periodic reconciliation job that scans for symmetric like pairs. It fails on latency in a way that isn't recoverable by tuning: the entire emotional payload of the product is the modal that appears the instant both people have swiped. Run the job every 60 seconds and you've replaced "it's a match!" with a notification that arrives after the user has closed the app. The other alternative — a symmetric SQL lookup on every like — is correct but puts a second indexed read on Postgres for every swipe, and swipes are the highest-volume write in the system by an order of magnitude.

The give-up is a consistency seam. Redis swipe sets expire (`retentionConfig.swipeCacheTTL`), so a like from three days ago won't be in the set and the `SISMEMBER` returns false. That's why the DB fallback query immediately below it is not optional — it's the correctness backstop, and the `cacheHitsTotal` / `cacheMissesTotal` counters exist so you can see how often the fast path actually fires.

### 3. Matches are stored with canonically ordered UUIDs

`createMatch()` sorts the two IDs (`user1Id < user2Id ? [a,b] : [b,a]`) before insert, and `areMatched()` applies the same ordering before lookup. Without it, a match between A and B can exist as both (A,B) and (B,A). This isn't hypothetical when both users swipe within milliseconds of each other: both requests see the other's like, both call `createMatch`, and with unordered storage the existence check misses because it's looking for the opposite tuple. You get two match rows, two "it's a match" modals, and two conversation threads with messages split across them. Canonical ordering collapses the pair into one row so the existence check is a single equality on a composite key. The cost is that every read path has to remember to sort first — a rule enforced by convention, not by the schema, which is exactly the kind of thing that breaks later.

### 4. Swipes upsert on `(swiper_id, swiped_id)` and carry an optional idempotency key

`INSERT ... ON CONFLICT (swiper_id, swiped_id) DO UPDATE SET direction = $3` with `idempotency_key = COALESCE(swipes.idempotency_key, $4)`. A swipe is a gesture issued from a phone on a flaky network, and the client will retry. A plain `INSERT` would either error on the unique constraint (surfacing a failure for an action that already succeeded) or, without the constraint, record the same like twice — and a double like against a mutual liker means `createMatch` runs twice. The `COALESCE` preserves the *first* idempotency key rather than overwriting it, so the original request remains the one of record. The trade-off is that upsert makes swipes mutable: a user who passes and later likes the same person overwrites history, so there's no audit trail of how a decision changed.

### 5. Startup binds the port before Elasticsearch, and treats ES failure as non-fatal

`start()` retries `testConnections()` up to 10 times with 2s backoff, constructs the WebSocket gateway, calls `server.listen(PORT)`, and only *then* kicks off `initElasticsearchIndex()` as a background promise whose rejection logs "Elasticsearch init failed; discovery degraded". `/api/health` reflects the same tiering: Postgres or Redis disconnected → `unhealthy` (503); Elasticsearch disconnected → `degraded` (200).

This ordering is the whole point. Elasticsearch 8 with a 512MB heap takes appreciably longer to become useful than Postgres or Redis, and it is needed by exactly one feature. Initializing it before `listen()` meant the API was unreachable for the entire ES startup — so login, profile reads, and the match list, none of which touch ES, were all unavailable because a search index was still warming. Worse, an ES failure aborted `start()` entirely. What we accept is that deck requests made during that window fall through to `postgresFallbackSearch()` and are slower, which is a strictly better failure than not booting.

## Current State

Runs end to end: API + WebSocket on 3000, registration/login with bcrypt, profile and preference management, photo upload via Multer served from `/uploads`, ES-backed discovery deck with PostGIS fallback, ranking that boosts users who already liked you (+200) and scores profile completeness (×30), swipe processing with mutual-match detection, match list with last-message previews, unmatch (which also clears the Redis sets so the pair can resurface), real-time chat over `/ws` with heartbeat ping/pong and `psubscribe('user:*')` for cross-instance delivery, typing indicators, an admin dashboard with match/swipe stats and a like-rate calculation, per-route rate limiting including a Redis sorted-set sliding window on swipes, Prometheus `/metrics`, and `/api/health` with per-dependency latency.

Seeded logins (all `password123`): `alice@example.com` and the other seeded profiles in `backend/db-seed/seed.sql`.

Location privacy is deliberate: `formatDistance()` buckets distances — under a mile becomes "Less than a mile away", and anything over five miles rounds to the nearest five — so exact coordinates never leave the server in a discovery response.

**Sessions are in-memory.** `express-session` is configured with no `store`, so it uses the default `MemoryStore`; the `sessions` table in `init.sql` exists but nothing reads or writes it. This means sessions do not survive a restart and would not work across the `dev:server1/2/3` instances the scripts otherwise support. Also not implemented: incremental Elasticsearch reindexing on profile change, photo moderation, and any use of `retentionService` beyond exposing its config on `/api/health/retention`.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. It listed rate limiting and Prometheus monitoring as "Pending" and under "Next Steps" — while `shared/rateLimit.ts` was already applying `apiRateLimiter` to every `/api` route in `index.ts` and `shared/metrics.ts` was serving a full `/metrics` endpoint with cache and DB-pool gauges. It also had Phase 2 marked "In progress" with everything under it complete, and Phases 3 and 4 "Not started" despite Redis caching and the health endpoints being in place.
- **Startup crashed on cold dependencies (fixed):** `testConnections()` ran once and threw if Postgres or Redis weren't accepting connections yet — routine when the backend starts alongside its containers — and `process.exit(1)` followed. Now wrapped in a 10-attempt loop with 2s backoff.
- **Elasticsearch made non-blocking and non-fatal (fixed):** `initElasticsearchIndex()` used to run before `server.listen()` and abort startup on failure. It now runs after the port is bound, in the background, with `.catch()` logging a degradation warning. See decision 5.
- **Schema loads from `postgis/postgis:16-3.4`:** plain `postgres:16` cannot execute `CREATE EXTENSION postgis`, so `init.sql` fails at container init and the database comes up with no tables — which surfaces much later as "invalid credentials" at login rather than as a schema error.
- **Backend port is 3000, not 3001:** unlike most projects in this repo, `dev` is a bare `tsx watch` and `serverConfig.port` defaults to 3000, which is what all three Vite proxy entries (`/api`, `/uploads`, `/ws`) target. Don't "fix" this to 3001 without changing `vite.config.ts`.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

- **2026-08-10 — the swipe deck was empty on every launch.** The home screen, which is the entire product, showed "No more profiles". Four separate faults, stacked:
  1. **Nothing ever populated the Elasticsearch index.** `initElasticsearchIndex()` created the `users` index with correct mappings and stopped there. The only code that indexes users lives in `backend/src/db/seed.ts` — a TypeScript seeder that invents its own random users — but the screenshot harness (and any normal setup) seeds from `backend/db-seed/seed.sql`, which writes rows to Postgres and knows nothing about Elasticsearch. **The failure is silent in the worst way: a query against an empty index returns zero hits without throwing, so the `catch` that exists specifically to fall back to PostGIS never fires.** The fallback is only reachable when ES is *broken*, not when it is merely empty. Fixed with a boot-time backfill (`backfillElasticsearchIndex()`) that bulk-indexes every user from Postgres with `refresh: true`, preceded by a ping-retry loop because ES 8 needs far longer to warm than Postgres or Redis. Same class as fb-post-search's empty index, and the same reasoning applies for putting the backfill at boot rather than in the seeder: a seeder races ES's cold start, skips on failure, and the backend then creates a fresh empty index over the top.
  2. **Cards rendered with no bio, job, company, or school.** The ES branch of `geoCandidateSearch` hardcoded those four fields to `null` — the index doesn't carry them — while the PostGIS fallback returned them properly. So the two code paths that are supposed to be equivalent produced visibly different cards. Fixed by hydrating the surviving candidate IDs from Postgres in one keyed query. This answers open question 1 in the direction of "ES as an ID-returning candidate filter": the index stays authoritative for *eligibility*, Postgres stays authoritative for *display*, and profile edits can no longer produce stale card text.
  3. **Alice had swiped every eligible man in the seed.** Her four swipes covered all four males in her age range; the only one left was the 41-year-old admin, outside her 25–38 filter. Even with a populated index the deck was legitimately empty. Added seven profiles — five men inside her filters, two women so the male users' decks aren't starved — with two of the men having already liked her, which exercises the +200 reciprocity boost and makes a right-swipe produce a real match instead of a one-sided like.
  4. **The chat thread rendered out of order.** The first two messages of the Alice/Bob conversation were both seeded `NOW() - INTERVAL '5 days'`, so with identical `sent_at` the order was whatever Postgres returned — the reply appeared above the question. Same class as reddit's "every post at NOW()". Gave every message a distinct timestamp.
- **Also fixed: chat bubbles showed a bare clock time** (`05:06 PM`) regardless of age, so a five-day-old message read as if it had just arrived. `formatMessageTime` now adds a weekday within the last week and a date beyond that.
- **Screenshots 6 → 8**, and seven stale PNGs from two older config generations were removed. New coverage: the deck with a real card, the "It's a Match!" modal, and a populated chat thread — the three screens the design is actually about. Added `data-testid` to the like/pass buttons, which had no stable selector.
- **2026-08-10 (answer doc):** `system-design-answer-backend.md` was 582 lines and roughly a third of it was **code in disguise** — Redis command sequences, pseudo-SQL, and four schema definitions drawn inside Unicode boxes, none of which the repo standard allows. Two sections were also **wrong about the implementation**: a "Location Update with Fuzzing" flow describing random coordinate offsets that do not exist (the code stores exact coordinates and buckets only the displayed distance), and an ES mapping listing a `profile_score` field the index has never had. Rewrote to 359 lines: schemas and Redis keys as tables, the swipe/messaging flows as prose, and three trade-offs the file was missing — why batch match detection is not a slower version of the right answer but a different feature, why the seen-set TTL makes the SQL fallback mandatory rather than defensive, and the fairness problem inside the reciprocity boost (it systematically promotes the least selective users, since people who like everyone are by construction the most likely to be in your received-likes set).

## Open Questions

1. Nothing reindexes Elasticsearch when a profile changes, so ES and Postgres drift from the first profile edit. Is a CDC/outbox worth building here, or should discovery read identity fields from Postgres and use ES purely as an ID-returning candidate filter?
2. The seen-user exclusion is passed to ES as an explicit `must_not: { ids: { values: [...] } }`. That request body grows linearly with the user's swipe history and will eventually be megabytes. Is a per-user bloom filter the right answer, accepting that false positives silently hide profiles the user never saw?
3. Ranking is `+200 if they liked me` plus completeness — effectively "show me guaranteed matches first". That maximizes immediate match rate but front-loads the deck with people who like everyone. Should reciprocity be predicted rather than observed, and does that just reinvent desirability scoring with all its fairness problems?
4. Sessions in `MemoryStore` block horizontal scaling, and the `sessions` table already exists. Is Postgres-backed session storage the right move, or should this follow the rest of the repo and use Redis — given Redis here is already carrying swipe state that is explicitly allowed to expire?

## Resources

- [PostGIS reference](https://postgis.net/docs/) — `ST_DWithin` and `ST_Distance` as used in the fallback query
- [Elasticsearch geo queries](https://www.elastic.co/guide/en/elasticsearch/reference/current/geo-queries.html) — `geo_distance` filtering and `_geo_distance` sorting
- [Redis pub/sub](https://redis.io/docs/latest/develop/interact/pubsub/) — the `psubscribe('user:*')` fan-out behind cross-instance messaging
- [Tinder engineering: geosharded recommendations](https://medium.com/tinder/geosharded-recommendations-part-1-sharding-approach-d5d54e0ec77a) — how this problem looks when the candidate set doesn't fit on one machine
- [ws](https://github.com/websockets/ws) — the WebSocket server and its ping/pong heartbeat contract

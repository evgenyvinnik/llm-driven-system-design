# Facebook Post Search — Development with Claude

## Project Context

Full-text search over social posts is not the hard part — Elasticsearch does that out of the box. The hard part is that *every result must be permission-checked*, and permission depends on a social graph the search engine doesn't have. A naive implementation retrieves the top 20 matches, then asks Postgres "is this user allowed to see each of these?" — and discovers 18 are private, so it goes back for more. Relevance and authorization fight each other, pagination becomes incoherent, and a single search fans out into a dozen round trips.

The design here inverts that: authorization is pushed *into the index*. Each post is indexed with a set of **visibility fingerprints** (`PUBLIC`, `FRIENDS:<authorId>`, `PRIVATE:<authorId>`), and each searching user gets a precomputed **visibility set** — the fingerprints they're entitled to match. Search carries a single `terms` filter on `visibility_fingerprints`, so Elasticsearch never scores a document the user isn't allowed to see. Privacy becomes a filter clause instead of a post-processing pass, and the top 20 you get back is genuinely the top 20 *for you*.

The second theme is that relevance for social search isn't pure text relevance. A post from a close friend mentioning "coffee" beats a stranger's viral coffee thread, so BM25 is only the starting signal — friend proximity and engagement are layered on as boosts and tiebreakers.

**Learning goals:** privacy-aware search where authorization is an index-time concern, Elasticsearch relevance tuning with social signals, cache invalidation for derived permission sets, and circuit-breaker isolation of the one dependency the entire product rests on.

## Architecture at a Glance (what actually runs)

| Component | Where | Why this one |
|-----------|-------|--------------|
| **API server** (`backend/src/index.ts`, port **3000**) | `npm run dev` (`tsx watch`) | Single Express process; `dev:server1/2/3` pin 3001–3003 for multi-instance testing |
| **Elasticsearch 8.11** (9200) | `docker-compose.yml` | The `posts` index with the `visibility_fingerprints` keyword array — the whole privacy model rests on `terms`-filter performance over a keyword field |
| **PostgreSQL 16** (5432) | `docker-compose.yml` | Source of truth: `users`, `posts`, `friendships`, `search_history`, `sessions`. The social graph lives here; ES mirrors only what's searchable |
| **Valkey/Redis 7** (6379) | `docker-compose.yml` | Visibility-set cache, suggestion cache (60s TTL), and the `trendingSearches` sorted set |

The privacy pipeline is two files: `backend/src/services/indexingService.ts` writes fingerprints at index time (`generateVisibilityFingerprints`), and `backend/src/services/visibilityService.ts` computes the reader's matching set (`getUserVisibilitySet`). `searchService.ts` joins them in `buildSearchQuery`. Elasticsearch is wrapped by a **cockatiel** circuit breaker in `backend/src/shared/circuitBreaker.ts`, and `searchPosts` checks `isElasticsearchCircuitOpen()` *before* doing any work, so an ES outage fails fast instead of piling up timeouts. Config is Zod-validated at startup in `backend/src/config/index.ts` — a missing env var kills the process rather than surfacing as a runtime `undefined`.

Frontend is React 19 + TanStack Router (file-based, `frontend/src/routes/`) + Zustand + Tailwind, with `authStore`/`searchStore`, a typeahead `SearchBar`, and an admin dashboard (`frontend/src/components/admin/`) over users, posts, search history, and health. Vite proxies `/api` → `localhost:3000`.

## Key Design Decisions

### 1. Visibility is a filter clause inside Elasticsearch, not a post-retrieval check
Each post carries `visibility_fingerprints`; each reader carries a fingerprint set (`PUBLIC`, `PRIVATE:<self>`, `FRIENDS:<self>`, plus `FRIENDS:<friendId>` for every accepted friend). The search adds one `terms` filter and Elasticsearch does the rest.

Retrieve-then-filter fails in a specific, unfixable way: you cannot know how many documents to over-fetch. A user with 200 friends searching a mostly-public corpus might keep 90% of hits; the same user searching a niche term inside a private circle might keep 2%. To reliably fill a page of 20 you'd fetch 20, discard 18, fetch 100 more, discard 95 — and every one of those round trips scores documents that get thrown away. Worse, `total_estimate` becomes a lie and cursor pagination breaks, because "result 40" is a different document depending on how many were filtered out ahead of it.

What we give up: **fingerprints are denormalized into the index, so they go stale.** Changing a post's visibility requires re-indexing that post; the reader's cached set is invalidated only explicitly (`invalidateVisibilityCache`) or on TTL expiry. There is a window where a just-unfriended user still matches `FRIENDS:<theirId>`. That's the price of O(1) authorization at query time, and it's only the right trade because friendship changes are rare relative to searches.

### 2. The visibility set is cached in Redis, and its size scales with friend count
`getUserVisibilitySet` sits on the hot path of every authenticated search. Uncached, that's a `friendships` query per search *and* per typeahead keystroke — Postgres becomes the search tier's throughput ceiling, which is absurd for a system whose entire premise is that Elasticsearch does the heavy lifting. So the computed set is cached with `VISIBILITY_CACHE_TTL_SECONDS` from `shared/alertThresholds.ts`.

The uncomfortable part is that the cached object grows linearly with friend count: one fingerprint string per friend. A user with 5,000 friends carries a 5,000-element `terms` clause into every query. Survivable at Facebook's friend limit, but it's why the old notes floated Bloom filters — a compact probabilistic set trades a small false-positive rate for constant size, which for *privacy* filtering is exactly the wrong direction to be sloppy in. We kept the exact set and accepted the size.

### 3. Social boosting lives in the ES query, not in an application-side re-rank
`buildSearchQuery` puts `multi_match` (`content^3`, `author_name^2`, `hashtags^2`, `fuzziness: AUTO`) in `must`, adds `should` clauses boosting friends' posts ×2 and the user's own ×3, and sorts `_score` → `engagement_score` → `created_at`.

An application-side re-ranker can only reorder the page it was handed. If a friend's highly relevant post ranked #23, Node never sees it — no amount of boosting *after* retrieval promotes a document that wasn't retrieved. Putting the boost inside the query changes which documents make the top N in the first place.

The cost: relevance is now entangled with the social graph inside one query, so a ranking experiment can't be run independently of the privacy filter, and `_score` isn't comparable across users. Engagement is a plain weighted sum (`likes×1 + comments×2 + shares×3`) with no time decay — an old viral post permanently outranks a good post from this morning on the tiebreak. That's a real defect, tracked below.

### 4. Check the circuit breaker before doing any work, not around the ES call
`searchPosts` calls `isElasticsearchCircuitOpen()` at the very top and throws immediately, before building the query or fetching the visibility set. Without the pre-check, an ES outage still costs a Redis lookup or a Postgres friendship query per request plus a timeout wait — the API tier saturates doing work it will discard. The cockatiel `ConsecutiveBreaker` in `shared/circuitBreaker.ts` converts a slow failure into a fast one.

Trade-off: an open breaker rejects requests that might have succeeded, and unlike a feed that can serve cached posts, search here has no meaningful degraded mode. Half-open probing bounds how long we stay pessimistic. Suggestions degrade more gracefully on purpose — the ES hashtag aggregation is wrapped in a `try/catch` that logs and continues, so typeahead still returns trending queries and user matches while ES is down.

### 5. Anonymous searches are restricted by an explicit `term`, not an empty fingerprint set
With no `user_id`, the query filters `visibility: 'public'` outright rather than passing an empty `terms` array. This is deliberate belt-and-braces: an empty `terms` array is a footgun (depending on query shape it either matches nothing or is a no-op), and the failure mode of getting it wrong is leaking private posts to logged-out users. An explicit `term` on a keyword field cannot accidentally widen.

## Current State

Runs end to end. `docker-compose up -d` starts Postgres, Elasticsearch, and Valkey; `npm run db:migrate` applies `backend/src/db/init.sql`; the API creates the ES `posts` index on startup via `initializeElasticsearch()`. Working: registration/login with Redis-cached sessions, post creation with synchronous indexing, privacy-filtered search with friend/self boosting and highlighted snippets, filters (date range, post type, author, visibility), typeahead built from hashtag aggregations plus trending searches plus user names, per-user recent searches, a trending-search sorted set trimmed to the top 1000, and an admin dashboard. Operational surface: `/metrics` (prom-client), `/health`, `/livez`, `/readyz`, request-ID propagation, Pino structured logging, IP rate limiting (1000 req / 15 min), and search-history retention cleanup (`npm run db:cleanup`).

Seeded logins, all with password `password123`: `alice@example.com`, `bob@example.com`, `carol@example.com`, `david@example.com`, `emma@example.com`, and `admin@facebook.local` (admin). The seed includes a real friendship graph and posts at all four visibility levels, so the privacy filter is genuinely exercised — Alice's friends-only posts are invisible to David.

Simplified or omitted: indexing is synchronous in the request path rather than event-driven through a queue, so a slow ES write slows the post-create response. `friends_of_friends` is accepted by the schema but generates the same `FRIENDS:<author>` fingerprint as `friends`, so it behaves as friends-only. Language is hardcoded `'en'` rather than detected. The index is single-shard, single-node, zero replicas. There is no re-indexing job, so changing a post's visibility or a friendship does not retroactively correct already-indexed documents.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. The old file declared **"Phase 3: Scaling and Optimization — *Not started*"** with "Add caching layer / Add monitoring" listed as pending, while Redis visibility caching, cockatiel circuit breakers, a full prom-client registry, `/livez` + `/readyz` probes, and `dev:server1/2/3` multi-instance scripts were all already in the tree. It never mentioned the circuit breaker at all.
- **Docker Compose Elasticsearch healthcheck (fixed):** the healthcheck command contained an unterminated quote, so Compose failed to parse it and the ES service never reported healthy — dependent startup hung. Now `curl -sf http://localhost:9200/_cluster/health || exit 1`.
- **Seed password hash (fixed):** the seeded `password_hash` values didn't correspond to the documented `password123`, so every seeded login failed with "Invalid credentials" against a database that looked correctly populated.
- **Config validation moved to startup:** `config/index.ts` now parses the environment through a Zod schema and `process.exit(1)`s on failure, replacing scattered `process.env` reads that surfaced misconfiguration as an undefined connection string deep inside a request handler.
- **Metrics path cardinality:** request paths are normalized (UUIDs and numeric IDs → `:id`) before becoming a Prometheus label. Without it, every post ID becomes its own time series and the registry grows without bound.
- **2026-08-06 — login was impossible and search returned nothing. Three faults:**
  1. **The login form asks for a Username** (`id="username"`, `type="text"`, no `name`), but the screenshot config searched for `input[name='email'], input[type='email']` and passed an email. Nothing matched, so every authenticated screen died on a selector timeout. Config corrected to the username; the inputs were given `name`/`autoComplete` attributes so they're autofill-friendly as well as selectable.
  2. **Elasticsearch was never populated.** Indexing happens synchronously inside post-create and there is no re-indexing job, so a SQL fixture that inserts posts straight into Postgres leaves the index completely empty — the database looks correctly populated and every search returns "No results found". Added a **self-healing backfill at backend boot**: after `initializeElasticsearch()` succeeds, if the index has zero documents, walk `posts` and push each through the project's own `updatePostIndex`. Boot is the right place, not seed time: ES is slow to accept connections on a cold start, so a seeder racing it silently skips and the backend then creates a fresh empty index over the top — which is exactly what happened on the first attempt at this fix. Using `updatePostIndex` rather than hand-writing documents means fingerprints and engagement scores come from the same code path a real post takes.
  3. **The app's own placeholder suggests searching "coffee", and no seeded post contains that word** — so the obvious manual smoke test returns nothing even when everything works. Screenshots now search for terms the fixture actually has.
- **Harness gained `fill`/`pressEnter` (repo-wide):** this search page has no query param — results live in a store fed by the SearchBar — so there was no URL to navigate to and it could only ever be captured empty. `scripts/screenshots.mjs` now supports typing into inputs and pressing Enter before capture.
- **Screenshots:** 2 → 6, including real search results with highlighted terms and relevance scores, a hashtag search, and the admin dashboard.
- **Known, unfixed:** the *Recent searches* endpoint logs `for SELECT DISTINCT, ORDER BY expressions must appear in select list` on every load — a genuine SQL error in that query, unrelated to the search path and not touched here.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Elasticsearch/Postgres/Redis services these tests need). Verification is local: `npm run type-check`, then `npm run triage fb-post-search`.

## Open Questions

1. Fingerprint sets scale with friend count, so a heavy user ships thousands of terms per query. At what friend count does the `terms` filter cost more than the post-retrieval check it replaced — and is there a hybrid (exact set below a threshold, something coarser above) that doesn't compromise privacy?
2. Ranking has no recency decay, so an old viral post permanently wins the `engagement_score` tiebreak. Should decay live in the query as a `function_score` (correct, but couples ranking to retrieval even more tightly) or be baked into the indexed score (cheap, but needs periodic re-indexing to stay accurate)?
3. Fingerprints are written at index time, so unfriending doesn't hide already-indexed posts until something re-indexes them. Is the fix event-driven re-indexing on friendship change — which means one unfollow can touch every post that author ever wrote — or is the staleness window acceptable as documented semantics?
4. Indexing is synchronous in post-create. Moving it to a queue decouples write latency from ES health but creates a window where a user can't find the post they just made. Which surprise is worse here?

## Resources

- [Elasticsearch Query DSL](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl.html) — `bool` must/filter/should semantics, which decisions 1 and 3 both hinge on
- [Elasticsearch: query and filter context](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-filter-context.html) — why the privacy `terms` clause belongs in `filter` (cacheable, non-scoring)
- [Unicorn: A System for Searching the Social Graph](https://research.facebook.com/publications/unicorn-a-system-for-searching-the-social-graph/) — Facebook's own take on graph-aware retrieval
- [Under the Hood: Indexing and Ranking in Graph Search](https://engineering.fb.com/2013/02/20/core-data/under-the-hood-indexing-and-ranking-in-graph-search/)
- [cockatiel](https://github.com/connor4312/cockatiel) — the resilience library behind `shared/circuitBreaker.ts`

# Typeahead — Development with Claude

## Project Context

Autocomplete has a latency budget measured against human typing, not against a page load. A suggestion list that arrives 200ms after the keystroke is already describing a prefix the user has moved past. And because the request fires on *every* keystroke, the read volume is roughly "characters typed per second across all users" — a query pattern where the average request must be cheap, not just the p50.

That constraint rules out the obvious implementation. `SELECT phrase FROM phrases WHERE phrase LIKE 'ca%' ORDER BY count DESC LIMIT 10` is correct and unusable: even with a B-tree supporting the prefix scan, the database is ranking a candidate set whose size is inversely proportional to prefix length — the shortest, most common prefixes are the most expensive queries, and short prefixes are exactly what people type first.

So the shape of the system is: precompute the answer at every possible prefix, hold it in memory, and spend the rest of the effort on caching layers and on making the client not send requests it doesn't need. The interesting engineering isn't the trie — it's everything wrapped around it: what gets cached where, what can be cached at all (personalized ranking can't), and how write volume gets collapsed before it reaches Postgres.

**Learning goals:** trie construction with precomputed top-k, multi-layer caching from service worker to Redis, multi-factor ranking blending popularity/recency/personalization/trending, buffered write aggregation, and client-side debounce/abort/prefetch discipline.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts`) | **3000** | Express, single process; the trie lives in this process's heap, so the server *is* the index. `dev:server1/2/3` run 3001–3003 for multi-instance experiments |
| **PostgreSQL 16** | 5432 | Durable source of truth for `phrase_counts`, `query_logs`, `user_history`, `filtered_phrases`, `analytics_summary`, `trending_snapshots` — the trie is rebuilt *from* it at startup |
| **Valkey (Redis)**, via ioredis | 6379 | Suggestion cache (60s), 5-minute trending windows, the `trending_queries` zset, blocked-phrase set, and per-user history for personalization |

There is no separate index server and no message queue — the trie is constructed in `initialize()` when the process starts and mutated in place. `backend/src/data-structures/trie.ts` is the core; `services/suggestion-service.ts` (cache + trie lookup + fuzzy), `services/ranking-service.ts` (five-factor scoring), `services/aggregation-service.ts` (buffered writes, filtering, trending windows). Shared middleware in `backend/src/shared/`: `cache-headers.ts` (Cache-Control strategies + ETag), `rate-limiter.ts`, `circuit-breaker.ts`, `idempotency.ts`, `logger.ts`, `metrics.ts`. Routes are `/api/v1/suggestions`, `/api/v1/analytics`, `/api/v1/admin`.

Frontend is React + TanStack Router + Zustand + Tailwind. It ships four distinct typeahead widgets (`components/widgets/`: `CommandPalette`, `InlineFormTypeahead`, `MobileTypeahead`, `RichTypeahead`) over one `useTypeahead` hook, plus a client cache stack: `services/cache.ts` (in-memory LRU with TTL), `services/prefetch.ts` (idle-time speculative fetching), `services/performance.ts`, and `src/sw.ts` (a service worker with separate static and API caches). Vite proxies `/api` → `localhost:3000`.

## Key Design Decisions

### 1. Top-k is precomputed at every trie node, not computed at query time

`Trie.insert()` walks the phrase character by character and calls `_updateSuggestions()` on *every node along the path*, keeping a sorted top-10 at each one. `getSuggestions()` then walks the prefix and returns `node.suggestions` — no subtree traversal at all, O(prefix length) with a tiny constant.

The alternative is storing counts only at terminal nodes and collecting the subtree at query time. That fails at exactly the wrong end of the input distribution: for a one-character prefix like "a", the subtree under that node is a large fraction of the entire corpus, so you traverse it all and then sort it, on the request that arrives most often. Query cost would be inversely proportional to how much the user has typed, meaning latency is worst at the moment the user has the least patience.

What we pay is memory and write cost. Every node on the path stores up to 10 suggestion objects, so memory is roughly `nodeCount × k` rather than `phraseCount`, and it's dominated by short prefixes shared across many phrases. Insert is `O(L × k log k)` — for each of L characters we do a linear scan for an existing entry, a sort, and a truncate. That's fine because inserts are batched every 30 seconds (decision 3) and reads happen per keystroke; the asymmetry is the entire justification.

### 2. The cache stores *unranked* suggestions; ranking runs after every cache read

`getSuggestions()` checks Redis first, and on a hit it still calls `rankingService.rank(cached, context)` before returning. The cached value is the trie's raw top-k, not the response.

This is the design point that makes caching possible at all. Ranking blends popularity (0.30), recency (0.15), personalization (0.25), trending (0.20), and match quality (0.10) — and personalization reads `user_history` for *this* user. If the cache held the final ranked response, the key would have to include the user ID, which shatters the cache into one entry per user per prefix and destroys the hit rate that makes the cache worth having. By caching the prefix→candidates step (identical for everyone) and applying the user-dependent step after, one cached entry serves every user typing that prefix.

The trade-off is that the expensive part isn't cached: ranking does a Redis lookup per suggestion for the personal score and another for the trending boost, so a cache hit still costs `2k` Redis round trips. The 60-second TTL is also a deliberate staleness bound rather than an invalidation strategy — `clearCache()` exists and is called on admin trie rebuilds, but ordinary count updates just wait out the TTL.

### 3. Query counts are buffered in memory and flushed every 30 seconds

`AggregationService` keeps a `Map<query, {count, firstSeen}>`, increments it per query, and flushes to Postgres plus the trie on a 30-second timer.

Writing per query is not viable here for a structural reason: in a typeahead, a "query" is a keystroke. A user typing "coffee shops near me" generates ~20 requests, and if each one writes a row, database write volume tracks aggregate typing speed rather than aggregate intent. The buffer collapses repeated prefixes into one upsert per distinct phrase per window, which for a popular query turns thousands of writes into one.

There's a second reason the buffer has to exist: the trie is rebuilt incrementally from these counts, and `insert()` re-sorts the suggestion list at every node on the path. Applying that per keystroke would put a `O(L × k log k)` mutation in the request path of the latency-critical endpoint.

What we give up is real: up to 30 seconds of counts vanish if the process dies, and the buffer is per-process, so with multiple instances the same phrase accumulates separately in each and lands as several independent upserts. Counts are approximate by construction — acceptable, because they feed a *ranking*, not a billing system.

### 4. Trending is a separate signal from popularity, computed over 5-minute windows

`updateTrending()` does `ZINCRBY trending_window:{floor(now/300000)}` with a 1-hour expiry, and `aggregateTrendingWindows()` unions the last 12 windows into `trending_queries`, which the ranker reads as a 0.20-weight boost. A separate hourly timer decays it.

Folding trending into the popularity count would be simpler and wrong. Popularity is cumulative and slow — a phrase that has been searched a million times over two years dominates, permanently, and nothing new can ever surface. Trending is a *rate*, and rates need a window. Five minutes is short enough that a spike registers within one flush cycle; keeping twelve of them means the boost reflects the last hour while individual windows expire on their own without a cleanup job.

The cost is that this is a second counting system with its own keys, its own decay, and its own failure mode — and the two can disagree, which is exactly what the 0.30/0.20 weight split is arbitrating.

### 5. The client debounces at 150ms, aborts in-flight requests, and speculatively prefetches

`useTypeahead` clears and resets a 150ms timer on every query change, uses an `AbortController` per request, and swallows abort errors rather than surfacing them. `services/prefetch.ts` schedules fetches for likely next prefixes during browser idle time and tracks what it has already fetched.

Debounce alone isn't sufficient, and the reason is subtle: without abort, a slow request for "co" can resolve *after* a fast request for "coff", overwriting the correct suggestions with stale ones. The user sees the list flicker backwards. Aborting the previous request makes the response order irrelevant. Meanwhile the network is idle between keystrokes, and prefetching the most likely next characters turns the next keystroke into a memory-cache hit — with a hit, the perceived latency is zero rather than one round trip.

Prefetching costs requests the user may never make, which is why it's gated on idle time and deduplicated against `prefetchedPrefixes`. Behind it, the response carries `Cache-Control: public, max-age=60, stale-while-revalidate=300` plus an ETag, so the browser and any intermediary can serve the same prefix without reaching the server at all, and `stale-while-revalidate` means the refresh never blocks the user.

## Current State

Runs end to end with no login — `auth.enabled` is `false` in the screenshot config because this system has no user accounts; `userId` is just an optional query parameter used to look up personalization history.

Implemented: trie with precomputed top-10 built from `phrase_counts` at startup, prefix suggestions, **fuzzy matching with edit-distance variations** (`?fuzzy=true` on `GET /api/v1/suggestions`, backed by `getFuzzySuggestions` / `_getFuzzyMatches`), popular and trending endpoints, per-user history, query logging with low-quality filtering (too short, too long, keyboard-smash detection) and a Redis-backed blocked-phrase list, five-factor ranking, buffered aggregation with 30s flush and hourly trending decay, an admin surface (trie stats, rebuild, add/remove phrases, add/remove filters, cache clear, status) with idempotency keys on every mutating operation, per-route rate limiting, HTTP cache headers with ETags, Prometheus metrics including trie stats, and structured logging with an audit logger for trie rebuilds.

Frontend: four typeahead widget variants over one hook, a search page with settings, a trending list, an admin dashboard with overview/analytics/management tabs, in-memory LRU cache, idle-time prefetching, and a service worker.

**Single-node by design.** The trie is one in-process object, so the "sharding by first character" that the architecture doc describes is not implemented — `suggestion-service.ts` says as much in its header comment. Running `dev:server1/2/3` gives you three independent tries with three independent aggregation buffers, which diverge. Also not implemented: nginx load balancing, A/B testing of ranking weights, and WebSocket suggestion streaming.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its "Next Steps" listed `- [ ] Add fuzzy matching with edit distance` as unbuilt — while `SuggestionService.getFuzzySuggestions()` and `_getFuzzyMatches()` were implemented and reachable via `?fuzzy=true`, and the frontend `useTypeahead` hook already had a `fuzzy` option plumbed through. It also claimed "Sharding strategy (implemented static sharding by first character)" as complete under Phase 2, which is the opposite of true: there is one trie in one process, and the service's own header comment says so. The old Resources section additionally pointed the Prefixy link at an unrelated Facebook engineering URL.
- **Malformed Kafka/Zookeeper block removed from docker-compose:** the file had `kafka` and `zookeeper` service definitions nested under the top-level `volumes:` key, which is not valid compose structure. Nothing in the backend consumes Kafka — the aggregation pipeline is an in-process buffer — so the block was deleted rather than fixed. (`kafkajs` remains an unused dependency in `backend/package.json`.)
- **Backend port is 3000, not 3001:** unlike most projects here, `dev` is a bare `tsx watch src/index.ts` and `index.ts` defaults to `process.env.PORT || 3000`, which is what the Vite proxy targets. Don't pin this to 3001 without changing `frontend/vite.config.ts`.
- **Schema loads via `docker-entrypoint-initdb.d`:** `backend/src/db/init.sql` is mounted into the Postgres container, so there is no `db:migrate` script here. The trie is empty until `phrase_counts` is populated — seed before expecting suggestions.
- **Trie rebuild is audited and idempotent:** `POST /api/v1/admin/trie/rebuild` runs behind `idempotencyMiddleware('trie_rebuild')` and logs through `auditLogger.logTrieRebuild`, so a double-clicked rebuild doesn't run twice and every rebuild is traceable.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

- **2026-08-07 (screenshots):** only 2 existed (an empty search box and the admin overview), so nothing showed the product actually working. Rebuilt the config around typed queries — the whole system is what happens mid-keystroke. First attempt typed "new y" and got an empty dropdown, which looked like a bug but wasn't: the seeded corpus is tech/how-to phrases, so the prefix simply had no matches. Switched to in-corpus prefixes ("how to", "weat"), confirmed against the API directly. The capture now shows the ranked dropdown with bolded prefix match, per-phrase counts, and the response-time badge. Added the two admin tabs that were never captured. 2 → 6 screenshots.
- **2026-08-07 (answer doc):** `system-design-answer-fullstack.md` was 587 lines and — the structural problem — had **nine** subsections labeled "Deep Dive" where the convention is 2–3. That isn't a formatting nit: labeling everything a deep dive means nothing reads as the hard part. Kept three that are genuinely this system's core (multi-layer caching, the precomputed top-k trie, request reduction) and demoted the rest to "Supporting Decision". Compressed the two most generic — the API-contract section was two tool-choice tables, rewritten around the one argument specific to this system (REST because the URL *is* the cache key, and the design rests on caching before the request arrives), and the offline section around what it honestly can't do (trending is a rate, and an offline client can't know the last hour). → 550 lines.

## Open Questions

1. The trie is rebuilt from Postgres only at process start, and incremental inserts happen in one process's heap. With `dev:server1/2/3` running, three tries diverge within a minute. Is the fix a shared serialized trie in Redis that instances reload periodically, or does each instance need to consume a shared change log?
2. A cache hit still costs `2k` Redis round trips because personalization and trending are applied per suggestion after the cache read. Should the personal-history set and trending zset be fetched once per request instead of once per suggestion — and does that just move the cost rather than remove it?
3. The ranking weights (0.30/0.15/0.25/0.20/0.10) were chosen by hand and have never been evaluated against anything. Without click-through data there's no ground truth — what's the minimum instrumentation that would make these tunable rather than decorative?
4. `Trie.remove()` deliberately leaves orphaned nodes behind and only rebuilds on demand. For a long-running process where phrases are filtered over time, at what point does node bloat matter enough to justify periodic rebuild-from-Postgres?

## Resources

- [Trie (Wikipedia)](https://en.wikipedia.org/wiki/Trie) — the base structure, before the top-k augmentation
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — `ZINCRBY` over 5-minute windows for the trending signal
- [MDN: stale-while-revalidate](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#stale-while-revalidate) — the header strategy in `shared/cache-headers.ts`
- [MDN: AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) — how the hook prevents out-of-order suggestion rendering
- [Elasticsearch search-as-you-type](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-as-you-type.html) — the off-the-shelf alternative this project builds by hand, and its edge-ngram trade-offs


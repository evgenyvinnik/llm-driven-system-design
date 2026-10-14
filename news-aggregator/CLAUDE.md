# News Aggregator — Development with Claude

## Project Context

A news aggregator's real product is *not* a list of articles — it's a list of **stories**. When something happens, twenty outlets publish about it within an hour, and a feed that shows all twenty is worse than useless. So the central problem is clustering: given a new article, decide whether it belongs to an existing story or starts a new one, cheaply enough to do it on every crawl of every source.

That decision can't be exact string matching — no two outlets write the same headline — and full semantic embeddings would mean an ML dependency and a vector index for what is, in the common case, a near-verbatim wire-service rewrite. SimHash sits in between: it produces a 64-bit fingerprint where *similar text produces similar bits*, so "is this the same story" becomes an integer XOR and a popcount.

The second problem is that ranking a feed has no ground truth. Relevance, freshness, source diversity, and velocity all pull in different directions, and a feed optimizing purely for personal relevance turns into a filter bubble where a user who reads three tech stories never sees anything else again.

**Learning goals:** polite crawling (conditional GETs, durable per-source backoff, `SKIP LOCKED` leases with fencing tokens), SimHash fingerprinting with a banded index and Hamming-distance clustering, multi-signal ranking with an explicit diversity penalty and snapshot (cursor) pagination, and Elasticsearch as a derived index with a PostgreSQL full-text fallback.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API + in-process crawler** (`backend/src/index.ts`) | **3000** (`npm run dev` → `tsx watch`; `dev:server1/2/3` on 3001–3003) | Express plus a `node-cron` job every 15 minutes calling `crawlAllDueSources()`, which claims due sources under a lease, so every instance can run it; `CRAWLER_ENABLED=false` turns it off |
| **PostgreSQL 16** | 5432 (`newsagg`/`newsagg_dev`, db `news_aggregator`) | `users`, `sources`, `stories` (with generated SimHash band columns), `articles` (with a generated `tsvector`), `user_preferences`, `user_reading_history`, `user_topic_weights`, `crawl_schedule` (lease token, ETag/Last-Modified, failure count) |
| **Valkey 7** | 6379 | Sessions, cached ranking profiles, ranked feed snapshots behind the feed cursor, topic/breaking/trending caches |
| **Elasticsearch 8.11** | 9200 (single-node, security disabled) | Optional. `articles` index for search; when it is unreachable the API still starts and `/search` answers from PostgreSQL full-text search |

This is the one project in the batch whose backend port is **3000, not 3001** — `dev` is plain `tsx watch src/index.ts`, `shared/config.ts` defaults `PORT` to 3000, and `frontend/vite.config.ts` proxies `/api` there. Don't "fix" that to 3001 without changing all three.

The ideas live in `backend/src/utils/simhash.ts` (fingerprinting and bands), `backend/src/services/crawl-policy.ts` (conditional headers, `Retry-After`, backoff), `backend/src/services/crawler.ts` (leases, fetching, transactional ingestion and clustering), `backend/src/services/feed.ts` (ranking, diversity, snapshots), `backend/src/services/search.ts` (Elasticsearch with PostgreSQL fallback), `backend/src/shared/password.ts` (scrypt) and `backend/src/utils/topics.ts` (keyword classifier). Cross-cutting helpers sit in `backend/src/shared/` — `circuit-breaker.ts`, `retry.ts`, `cache.ts`, `metrics.ts`, `logger.ts`, `config.ts`. Frontend is React 19 + TanStack Router (file-based: feed, trending, search, `topics.$topic`, `story.$storyId`, settings, admin) + Zustand + Tailwind.

## Key Design Decisions

### 1. SimHash fingerprints, not exact hashing or embeddings

`computeSimHash` tokenizes text, builds features from **both unigrams and trigrams**, FNV-1a hashes each feature to 64 bits, sums them into a signed bit vector, and takes the sign of each position as the output bit. Two articles cluster if their Hamming distance is under 3.

A cryptographic hash is exactly wrong here: it's designed so a one-character change produces a completely different digest. Two outlets covering the same event share almost no exact strings, so exact hashing detects only literal reposts. Embeddings are the accurate answer — they'd catch "Fed raises rates" and "central bank hikes borrowing costs" as the same story, which SimHash will not — but they cost a model to run per article, a vector index to query, and a similarity threshold that is far harder to reason about than "fewer than 3 of 64 bits differ."

Including trigrams alongside unigrams is what makes the fingerprint sensitive to phrasing rather than just vocabulary: two unrelated tech articles share a lot of individual words but very few three-word sequences.

What we give up: paraphrase blindness (the failure mode above) and threshold brittleness. The distance-3 cutoff was tuned by eye for news-length text; it will be wrong for very short items, where a handful of words dominates the fingerprint and unrelated stubs collide.

### 2. Clustering uses a banded SimHash index, not a scan

Until 2026-10, `assignToStory` selected every story from the last 48 hours and compared fingerprints in JavaScript: O(N) per article, and most expensive on the busiest news days. Now `stories` carries four generated columns `fp_band0..3` (the fingerprint's 16-bit slices), each indexed. Two fingerprints within distance 3 must agree on at least one band (pigeonhole), so four equality probes return every possible match and the exact Hamming check runs only on those candidates. Generated columns mean PostgreSQL keeps the bands in sync, so no writer or seed can forget them.

Concurrency was the other half. Two crawlers could ingest near-duplicates at the same moment, both find no candidate, and create twin stories. Each ingest transaction now takes `pg_advisory_xact_lock(20817, band * 65536 + value)` on its four buckets in ascending order, so near-duplicates serialize and unrelated articles never wait.

The window is now "newest article within 48 hours" (`last_article_at`) instead of "created within 48 hours", so a developing story stays open while coverage arrives. What we give up: banding only guarantees recall up to distance 3 with 4 bands; raising the threshold means more, narrower bands.

### 3. Ranking is five weighted signals plus a multiplicative diversity penalty

`calculateStoryScore` combines relevance 35%, freshness 25% (exponential decay, 6-hour half-life), quality 20% (source count capped at 5), trending 10% (velocity), and a flat +0.30 for breaking. Then `applyDiversityPenalty` multiplies each story's score by `0.8^n`, where n is how many stories with that same primary topic already appear above it, and re-sorts.

Relevance alone produces the filter bubble: `user_topic_weights` is learned from reading history, so a user who reads tech gets more tech, reads more tech, and converges to a single-topic feed within days. The diversity penalty is what breaks the loop, and it's deliberately *multiplicative and positional* rather than a quota — a fifth tech story can still outrank a first sports story if it's dramatically better (0.8⁴ ≈ 0.41, so it needs roughly 2.4× the raw score), but it has to earn it. A hard cap of "max 3 per topic" would drop genuinely dominant coverage on a day when one topic legitimately *is* the news.

The freshness half-life of 6 hours is the load-bearing constant: after 12 hours a story retains 25% of its freshness component, so a day-old story needs strong relevance and multi-source quality to still surface. Source diversity as the "quality" proxy is a real assumption — that five outlets covering something is evidence it matters — which rewards wire-service pickup and structurally underrates good single-source reporting.

What we give up: every weight here is a guess with no feedback loop. Nothing measures whether the ranked feed produces more reading than a chronological one.

### 4. Per-source failure isolation: breakers, durable backoff, leases

`crawler.ts` keeps one Opossum breaker per source; `429`/`5xx` count against it, `304`/`4xx` don't. A single shared breaker lets one publisher's bad afternoon stop every feed. The breaker only matters within a process, though. The real politeness mechanism is `crawl_schedule`: a failure schedules the next attempt `interval × 2^failures` ahead (capped at 24 h, ±10% jitter, never sooner than `Retry-After`), and that state survives restarts and is shared by all instances. Conditional GETs (stored ETag/Last-Modified) turn unchanged feeds into `304`s. Claiming due rows with `FOR UPDATE SKIP LOCKED`, which pushes `next_crawl` ahead by the lease and stamps a fencing token, means several instances never crawl the same source, and a crashed crawl releases itself.

### 5. Postgres and Elasticsearch, each for what it's good at

Articles are written to Postgres and, after the commit, indexed into Elasticsearch (`indexArticle`, wrapped in `withRetry`). Feed assembly, clustering, and all the relational joins run against Postgres; only `GET /api/v1/search` uses Elasticsearch, and since 2026-10 it falls back to a GIN-indexed `tsvector` in Postgres when Elasticsearch fails.

Postgres full-text search would remove a service, and for simple keyword lookup it would be fine. It fails on the thing search is actually for: relevance ranking across title, summary, and body with different field weights, fuzzy matching for misspellings, and highlighted snippets. `tsvector` gives you `ts_rank`, which is coarse, and building multi-field weighted scoring on top of it means reimplementing a chunk of BM25 in SQL.

The cost is a genuine dual-write with no transaction across it. Postgres is the source of truth; Elasticsearch is a derived index that can drift if indexing fails after all retries — which is why the failure is logged and swallowed rather than rolling back the article. There is no reindex-from-Postgres job to repair that drift, which is the missing piece.

## Current State

Runs end to end with PostgreSQL and Redis; Elasticsearch is optional. RSS/Atom crawling via `fast-xml-parser` with lease-based claiming, conditional GETs, durable per-source backoff, per-source circuit breakers and per-domain pacing; transactional ingestion (`ON CONFLICT (url)`, article + story assignment + counters in one transaction) with banded SimHash clustering and advisory locks; automatic breaking detection (≥ 3 distinct sources in 30 min, shown for 6 h) plus manual admin flags; keyword topics and entity extraction; Elasticsearch indexing with a PostgreSQL full-text fallback; personalized ranking with blocked/preferred sources, decaying velocity and the diversity penalty, paged through ranked snapshots; registration/login with scrypt hashes; preferences and an idempotent reading-history signal that the story page sends; an admin dashboard for sources, crawl health, manual crawls and breaking flags. Health checks, Prometheus metrics, Pino logs, graceful shutdown.

**Tests:** `cd backend && npm test` runs 35 offline vitest tests.

Seeded by `npm run db:seed` (applies `db-seed/base.sql`, then six clustered stories): **`admin@newsagg.local`** / **`password123`** (role `admin`). Its hash is the legacy salted SHA-256 form and is replaced by scrypt at the first login.

Not built: Kafka and separate worker pools (crawling runs in the API process), a reindex-from-Postgres job for Elasticsearch drift, semantic or entity-based dedup, source credibility scoring, rate limiting, SSRF protection for admin-added feed URLs, cursor pagination on topic pages, and frontend server-state caching, virtualization or a settings UI for sources.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. It listed Phase 3 (Scaling and Optimization — "Add caching layer", "Add monitoring") and Phase 4 as *Not started*, while `shared/cache.ts` caches user ranking profiles in Redis, `shared/metrics.ts` exports Prometheus metrics, `shared/circuit-breaker.ts` provides per-source breakers, and `/health` already reports dependency latency and breaker state. Its "Next Steps" also left "Add monitoring and metrics" unchecked for the same reason.
- **Seed password hash corrected:** the seed stored a **plain SHA-256** digest while `services/user.ts` verifies against `sha256(password + 'salt')`. Every login attempt with the documented credentials failed with "invalid credentials" even though the account existed — the classic symptom of a seed and a verifier disagreeing about the hashing scheme. The hash now matches the salted form for `password123`, which is what `scripts/screenshot-configs/news-aggregator.json` uses.
- **Backend port is 3000 here (not the 3001 used elsewhere in the repo):** `dev` has no `PORT=` prefix, `config.ts` defaults to 3000, and the Vite proxy targets 3000. Consistent, but it's the exception in this repo — worth knowing before "standardizing" it.
- **Fingerprint storage was lossy — now fixed (2026-07-29).** SimHash returns an *unsigned* 64-bit `bigint` and it was written as `Number(fingerprint)` into a signed `BIGINT` column. Two independent defects: JS numbers are exact only to 2⁵³, so the low bits — precisely the bits Hamming distance is computed over — were silently corrupted; and any fingerprint at or above 2⁶³ **fails to insert at all** (`value "15352863991967872148" is out of range for type bigint`), which is how this surfaced. The columns are now `NUMERIC(20, 0)` and the writes pass `fingerprint.toString()` through, which node-postgres hands to Postgres unchanged. Open question 1 stands: clustering quality was previously being judged against corrupted fingerprints.
- **2026-07-29 — the feed said "No stories found" on every fresh start.** `stories` and `articles` only ever arrive from the crawler hitting live RSS feeds, so a newly started stack has an empty front page until a crawl happens to succeed — and offline, never. Added `npm run db:seed` (`src/db/seed.ts`), which applies `db-seed/base.sql` and then writes the *output* of a crawl: six clustered stories, each covered by 2–4 outlets, with fingerprints computed by the project's own `computeSimHash` so the seeded rows are consistent with what clustering would really produce. **Note the harness rule this works around:** `scripts/screenshots.mjs` only runs a project's TS seeder when `seed.sql` has no user rows, so the SQL fixture was renamed to `base.sql`.
- **Seeding also indexes into Elasticsearch, with a readiness retry.** Search reads only from ES, so Postgres-only seeding leaves the feed full and search empty. A single-node ES cluster takes tens of seconds to accept requests and seeding runs moments after the stack starts, so the seeder retries `initElasticsearch` up to 10 times — without that, indexing silently failed and search returned nothing.
- **Featured story card reserved space for an image that doesn't exist:** `StoryCard` applied `col-span-2 row-span-2` to the first story, but nothing in the frontend renders `image_url`, so the extra row was a tall empty void. Now `md:col-span-2` — wider, not taller.
- **Elasticsearch startup is slow:** the Compose health check uses a 30s interval and accepts yellow cluster status, because a single-node cluster never reaches green and the API otherwise raced ES to readiness.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).
- **2026-10-10 (implementation review + docs rewrite):**
  - *Polite crawling made real.* Before: no conditional GETs; a failing source was retried every cycle; and an open per-source breaker fell back to a shared "global" breaker with immediate retries, which sent *more* traffic to a failing publisher. Every instance's cron crawled every due source. Now `crawl_schedule` stores ETag/Last-Modified, failure count, last status/error and a lease token; `claimDueSources()` claims with `FOR UPDATE SKIP LOCKED` and a 10-minute lease; `completeCrawl()` is fenced by the token; backoff is `interval × 2^failures` (≤ 24 h, ±10% jitter, ≥ `Retry-After`); validators advance only when every item of a `200` was stored. Domain pacing reserves slots before sleeping, and crawls run ten at a time. Admin "crawl now" uses the same lease (`409` while busy).
  - *Ingestion races fixed.* Check-then-insert by URL became `INSERT … ON CONFLICT (url) DO NOTHING`. Insert, story assignment and counters share one transaction, where before a crash could leave an article without a story forever. Clustering uses the band index plus advisory locks (see decision 2). Velocity and breaking use `LEAST(published_at, created_at)` so a new source's backlog isn't a burst; non-http(s) article links are dropped at ingestion.
  - *Feed correctness.* The personalized feed paginated by offset into a list re-ranked on every request (duplicates and gaps). It is now served from a ranked snapshot (`feed:snap:{id}`, 15 min) behind an opaque base64url cursor, owner-checked, and hydrated in two queries instead of one per story. Blocked sources were loaded and ignored; they now drop stories covered only by them, and preferred sources add 0.2 relevance. Preference saves didn't invalidate anything (up to 5 minutes stale); they now drop the profile and current snapshot. Freshness used `e^(-age/6)` while every doc said "6-hour half-life"; it is now `0.5^(age/6)`. Stored velocity never decayed (a burst stayed "trending" forever); it now decays to zero 30 minutes after the newest article. The breaking list was `is_breaking OR velocity > 0.5` with no time bound; it is now flags from the last 6 hours. Reading history bumped topic weights on every retry; now only the first read counts and dwell is `GREATEST`. The UI never sent read signals; the story page now does (`keepalive`).
  - *Security and degradation.* `sha256(password + 'salt')` became scrypt with per-hash salts; legacy hashes verify once and are upgraded. The session cookie is `SameSite=Lax`, and the session middleware no longer hangs requests when Redis errors. The API exited at startup if Elasticsearch was down; ES init now retries in the background, and `/search` falls back to Postgres full-text search, reporting `engine`. Indexing sent the unsigned fingerprint into a signed `long` field, failing about half of all documents; the fingerprint is no longer indexed. `init.sql` is re-runnable. The `crawl` npm script pointed at a missing file and was removed.
  - *Tests and verification.* vitest added (35 tests). Verified against PostgreSQL 16 and Redis with a mock RSS origin and no Elasticsearch: schema loads twice, ETag then `304`, `503` + `Retry-After` backoff, concurrent near-duplicates → one story, concurrent manual crawls → `200`/`409`, disjoint pages while a story is inserted mid-scroll, PG search fallback, blocked sources hidden immediately, read signal counted once, legacy hash upgraded, clean `SIGTERM`.
  - *Docs.* `architecture.md` and the three interview answers rewritten around one layered overview (read path left, crawl pipeline right, stores in the middle) and generated sequence diagrams.

## Open Questions

1. Fingerprints are now exact (`NUMERIC(20,0)`, no `Number()`), but nobody has measured whether "fewer than 3 differing bits" is the right threshold for news-length text. Short items collide easily. Should very short texts skip clustering, or use a title-only fingerprint?
2. The diversity penalty is `0.8^n` on primary topic only, so two stories about the same *event* with different primary topics both survive. Should the penalty key on entity overlap rather than topic label?
3. Elasticsearch still has no repair path for documents whose indexing failed after retries; the Postgres fallback only helps when ES is *down*. Outbox + replayable indexer, or a periodic reindex-from-Postgres job?
4. Per-domain pacing is per process. With several instances crawling, one domain can get one request per second *per instance*. Is routing sources to instances by domain hash worth it at this scale, or a Redis token bucket per domain?
5. Breaking detection re-flags a story an admin cleared as soon as another source arrives. Should a manual "not breaking" be sticky for the story's lifetime?
6. Admin-added feed URLs are fetched server-side with no check against private or link-local addresses (SSRF). Fine for a local learning project; what's the minimal correct guard (resolve-then-check, or an egress proxy)?

## Resources

- [Detecting near-duplicates for web crawling (Manku et al.)](https://www2007.org/papers/paper215.pdf) — the SimHash paper, including the banding trick in question 2
- [RSS 2.0 specification](https://www.rssboard.org/rss-specification)
- [Atom syndication format (RFC 4287)](https://datatracker.ietf.org/doc/html/rfc4287)
- [Elasticsearch relevance scoring](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-modules-similarity.html) — the BM25 behavior Postgres FTS doesn't give you
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — the library behind the per-source breakers

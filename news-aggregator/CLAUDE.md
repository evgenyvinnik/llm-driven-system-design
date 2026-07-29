# News Aggregator — Development with Claude

## Project Context

A news aggregator's real product is *not* a list of articles — it's a list of **stories**. When something happens, twenty outlets publish about it within an hour, and a feed that shows all twenty is worse than useless. So the central problem is clustering: given a new article, decide whether it belongs to an existing story or starts a new one, cheaply enough to do it on every crawl of every source.

That decision can't be exact string matching — no two outlets write the same headline — and full semantic embeddings would mean an ML dependency and a vector index for what is, in the common case, a near-verbatim wire-service rewrite. SimHash sits in between: it produces a 64-bit fingerprint where *similar text produces similar bits*, so "is this the same story" becomes an integer XOR and a popcount.

The second problem is that ranking a feed has no ground truth. Relevance, freshness, source diversity, and velocity all pull in different directions, and a feed optimizing purely for personal relevance turns into a filter bubble where a user who reads three tech stories never sees anything else again.

**Learning goals:** SimHash fingerprinting and Hamming-distance clustering, multi-signal ranking with an explicit diversity penalty, per-source circuit breakers for crawling flaky third-party feeds, and using Elasticsearch alongside PostgreSQL for the query shapes SQL is bad at.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API + in-process crawler** (`backend/src/index.ts`) | **3000** (`npm run dev` → `tsx watch`; `dev:server1/2/3` on 3001–3003) | Express plus a `node-cron` job every 15 minutes calling `crawlAllDueSources()` |
| **PostgreSQL 16** | 5432 (`newsagg`/`newsagg_dev`, db `news_aggregator`) | `users`, `sources`, `stories`, `articles`, `user_preferences`, `user_reading_history`, `user_topic_weights`, `crawl_schedule` |
| **Valkey 7** | 6379 | Sessions and cached user ranking profiles (topic weights) |
| **Elasticsearch 8.11** | 9200 (single-node, security disabled) | Two indices, `articles` and `stories`, for full-text search with relevance scoring |

This is the one project in the batch whose backend port is **3000, not 3001** — `dev` is plain `tsx watch src/index.ts`, `shared/config.ts` defaults `PORT` to 3000, and `frontend/vite.config.ts` proxies `/api` there. Don't "fix" that to 3001 without changing all three.

The ideas live in `backend/src/utils/simhash.ts` (fingerprinting), `backend/src/utils/topics.ts` (keyword classifier), and `backend/src/services/feed.ts` (`calculateStoryScore` and `applyDiversityPenalty`). Crawling and clustering are `backend/src/services/crawler.ts`. Cross-cutting helpers sit in `backend/src/shared/` — `circuit-breaker.ts`, `retry.ts`, `cache.ts`, `metrics.ts`, `logger.ts`, `config.ts`. Frontend is React 19 + TanStack Router (file-based: feed, trending, search, `topics.$topic`, `story.$storyId`, settings, admin) + Zustand + Tailwind.

## Key Design Decisions

### 1. SimHash fingerprints, not exact hashing or embeddings

`computeSimHash` tokenizes text, builds features from **both unigrams and trigrams**, FNV-1a hashes each feature to 64 bits, sums them into a signed bit vector, and takes the sign of each position as the output bit. Two articles cluster if their Hamming distance is under 3.

A cryptographic hash is exactly wrong here: it's designed so a one-character change produces a completely different digest. Two outlets covering the same event share almost no exact strings, so exact hashing detects only literal reposts. Embeddings are the accurate answer — they'd catch "Fed raises rates" and "central bank hikes borrowing costs" as the same story, which SimHash will not — but they cost a model to run per article, a vector index to query, and a similarity threshold that is far harder to reason about than "fewer than 3 of 64 bits differ."

Including trigrams alongside unigrams is what makes the fingerprint sensitive to phrasing rather than just vocabulary: two unrelated tech articles share a lot of individual words but very few three-word sequences.

What we give up: paraphrase blindness (the failure mode above) and threshold brittleness. The distance-3 cutoff was tuned by eye for news-length text; it will be wrong for very short items, where a handful of words dominates the fingerprint and unrelated stubs collide.

### 2. Clustering is a linear scan over a 48-hour window

`assignToStory` selects every story from the last 48 hours with a non-null fingerprint and compares in JavaScript until it finds one under the threshold.

The obvious objection is that this is O(N) per article, and it is. The reason it's the right call *at this scale* is that the correct alternative is genuinely expensive: Hamming-distance search has no index in Postgres, so doing it properly means the SimHash banding trick — split the 64-bit fingerprint into 4 bands of 16 bits, index each band separately, and use the pigeonhole principle (two fingerprints within distance 3 must match exactly on at least one band) to turn the scan into an equality lookup. That's four extra indexed columns, four lookups, and a candidate-merge step, to avoid scanning a few hundred rows.

The 48-hour window is the actual scaling mechanism, and it's a domain bound rather than a technical one: news clusters form within hours, so an article matching a three-day-old story is more likely a coincidence than a continuation. It caps the scan regardless of how large `stories` grows.

What we give up: the window is a hard cut with no notion of a slowly developing story, and the scan cost grows linearly with *news volume* even though it's bounded in time — a busy news day with many sources is exactly when it's most expensive.

### 3. Ranking is five weighted signals plus a multiplicative diversity penalty

`calculateStoryScore` combines relevance 35%, freshness 25% (exponential decay, 6-hour half-life), quality 20% (source count capped at 5), trending 10% (velocity), and a flat +0.30 for breaking. Then `applyDiversityPenalty` multiplies each story's score by `0.8^n`, where n is how many stories with that same primary topic already appear above it, and re-sorts.

Relevance alone produces the filter bubble: `user_topic_weights` is learned from reading history, so a user who reads tech gets more tech, reads more tech, and converges to a single-topic feed within days. The diversity penalty is what breaks the loop, and it's deliberately *multiplicative and positional* rather than a quota — a fifth tech story can still outrank a first sports story if it's dramatically better (0.8⁴ ≈ 0.41, so it needs roughly 2.4× the raw score), but it has to earn it. A hard cap of "max 3 per topic" would drop genuinely dominant coverage on a day when one topic legitimately *is* the news.

The freshness half-life of 6 hours is the load-bearing constant: after 12 hours a story retains 25% of its freshness component, so a day-old story needs strong relevance and multi-source quality to still surface. Source diversity as the "quality" proxy is a real assumption — that five outlets covering something is evidence it matters — which rewards wire-service pickup and structurally underrates good single-source reporting.

What we give up: every weight here is a guess with no feedback loop. Nothing measures whether the ranked feed produces more reading than a chronological one.

### 4. Per-source circuit breakers, not one crawler breaker

`crawler.ts` keeps a `Map` of Opossum breakers keyed by source ID, so each RSS feed gets its own.

A single shared breaker is actively harmful for this workload. Third-party feeds fail constantly and independently — one outlet's CDN has a bad afternoon, another rotates a URL, a third times out under load. With one breaker, that one bad source drives up the aggregate error rate and trips the breaker for *every* source, so a single flaky publisher stops the entire crawl. Per-source breakers make failure isolation match the failure boundary: the broken feed is skipped and retried later, and the other nineteen crawl normally.

Combined with `crawl_schedule` (each source has its own `next_crawl` and interval) and a per-domain delay map, this is also what keeps the crawler polite — it won't hammer a domain that's already struggling.

### 5. Postgres and Elasticsearch, each for what it's good at

Articles are written to Postgres and then indexed into Elasticsearch (`indexArticle`, wrapped in `withRetry`). Feed assembly, clustering, and all the relational joins run against Postgres; only `GET /api/search` hits Elasticsearch.

Postgres full-text search would remove a service, and for simple keyword lookup it would be fine. It fails on the thing search is actually for: relevance ranking across title, summary, and body with different field weights, fuzzy matching for misspellings, and highlighted snippets. `tsvector` gives you `ts_rank`, which is coarse, and building multi-field weighted scoring on top of it means reimplementing a chunk of BM25 in SQL.

The cost is a genuine dual-write with no transaction across it. Postgres is the source of truth; Elasticsearch is a derived index that can drift if indexing fails after all retries — which is why the failure is logged and swallowed rather than rolling back the article. There is no reindex-from-Postgres job to repair that drift, which is the missing piece.

## Current State

Runs end to end: RSS/Atom crawling via `fast-xml-parser` with per-source circuit breakers, per-domain rate limiting, and a `crawl_schedule` table driving a 15-minute cron; article dedup by URL then SimHash clustering into stories with `article_count`, `source_count`, and 30-minute `velocity` maintained on each assignment; keyword topic classification across technology/politics/business/sports and more; entity extraction; Elasticsearch indexing with retry; personalized feed ranking with the diversity penalty; topic browsing, trending, breaking, story detail with its constituent articles, and full-text search; user registration/login, preferences, reading history, and learned `user_topic_weights`; and an admin dashboard for source CRUD, manual crawl triggering, stats, and manually flagging a story as breaking. Health checks report Postgres/Redis/Elasticsearch status plus circuit-breaker state; Prometheus metrics and Pino structured logging throughout.

Seeded from `backend/db-seed/seed.sql`: **`admin@newsagg.local`** / **`password123`** (role `admin`), plus sample sources. (The comment above the hash still says `admin123` and is wrong.)

Simplified or omitted: **auth hashing is demo-grade** — `services/user.ts` uses `sha256(password + 'salt')` with a hardcoded literal salt, and says so in its own comment; this is not acceptable outside a learning project. The crawler runs in-process rather than as a separate worker or a queue-distributed fleet. Breaking-news detection is manual (an admin endpoint) rather than derived from velocity. No source credibility scoring, no semantic dedup, no reindex-from-Postgres repair job, and no tests.

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

## Open Questions

1. `Number(fingerprint)` truncates exactly the bits clustering depends on. Once fixed, does the distance-3 threshold still hold — or has clustering quality been silently measured against corrupted fingerprints all along?
2. The 48-hour clustering scan is linear in news volume. Is SimHash banding (4×16-bit indexed columns + pigeonhole) worth its complexity, or is the honest answer that the window should shrink instead?
3. The diversity penalty is `0.8^n` on primary topic only, so two stories about the same *event* with different primary topics both survive. Should the penalty key on entity overlap rather than topic label?
4. Elasticsearch is a derived index with no repair path. Should indexing move behind a queue with a DLQ (making failures replayable), or should a periodic reindex-from-Postgres job be the safety net?

## Resources

- [Detecting near-duplicates for web crawling (Manku et al.)](https://www2007.org/papers/paper215.pdf) — the SimHash paper, including the banding trick in question 2
- [RSS 2.0 specification](https://www.rssboard.org/rss-specification)
- [Atom syndication format (RFC 4287)](https://datatracker.ietf.org/doc/html/rfc4287)
- [Elasticsearch relevance scoring](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-modules-similarity.html) — the BM25 behavior Postgres FTS doesn't give you
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — the library behind the per-source breakers

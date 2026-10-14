# News Aggregator — Architecture

## System Overview

A Google News–style aggregator. It polls tens of thousands of publisher RSS and Atom feeds, groups the incoming articles into **stories** (one story is all the coverage of one event), ranks stories for each reader, flags breaking news when coverage spikes, and offers full-text search. The product is the story list, not the article list: when twenty outlets cover the same event, the reader should see one entry that says "20 sources", not twenty near-identical headlines.

Three problems make this a real design exercise:

1. **Polite polling at scale.** Fifty thousand feeds every 15 minutes is ~56 fetches a second against servers we don't own. The crawler must avoid re-downloading unchanged feeds (conditional GETs), back off from feeds that are failing, space out requests to the same domain, and never fetch one feed twice when several crawler instances run at once.
2. **Near-duplicate clustering.** Each new article must find its story among about a million open stories in a few milliseconds. Exact hashes miss rewrites, and embeddings are expensive. SimHash fingerprints plus a banded index lookup make "is this the same story?" an indexed equality query and a popcount.
3. **Ranking a moving target.** Scores change every minute as stories age and new coverage arrives. The feed has to stay personal without becoming a filter bubble, and pagination has to stay consistent while the ranking underneath it moves.

**Learning goals:** conditional GETs, per-source backoff and lease-based scheduling with `FOR UPDATE SKIP LOCKED`; SimHash fingerprints, banding and the pigeonhole argument; transactional ingestion with advisory locks; multi-signal ranking with a diversity penalty; snapshot (cursor) pagination over a ranked list; Elasticsearch as a derived index with a PostgreSQL fallback.

## Requirements

### Functional requirements

1. **Crawl** RSS/Atom feeds on a per-source interval (5–60 minutes), using conditional GETs and backing off from failing sources.
2. **Deduplicate and cluster**: one row per article URL; near-duplicate articles join the same story, which keeps coverage counts and a velocity (articles per minute).
3. **Breaking news**: flag a story when at least three distinct sources cover it within 30 minutes, and show it in a banner for six hours.
4. **Personalized feed**: rank by topic interest (explicit and learned from reading), preferred and blocked sources, freshness, coverage and velocity, with a diversity penalty. Logged-out readers get a shared, non-personalized ranking.
5. **Browse**: topic pages, trending, story detail with all coverage, full-text search with topic and date filters.
6. **Accounts**: register, log in, preferences, reading history.
7. **Admin**: add, edit and remove sources, trigger crawls, see crawl health (failures, last status, whether conditional GETs work), flag or unflag breaking stories.

Out of scope: scraping full article pages (we use what feeds provide), paywall handling, push-notification delivery, comments and ads.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Freshness | New article in feeds within one polling interval + 1 min (p95 ≤ 16 min; ≤ 3 min for priority sources) | News loses value by the minute |
| Breaking detection | Flagged within 2 min of the third independent source | The banner is only useful early |
| Feed latency | p99 < 200 ms for a cold first page, < 60 ms for later pages | Feed opens are the main interaction |
| Search latency | p95 < 500 ms | Interactive, but less frequent |
| Availability | 99.9% for reading; crawling may lag without a user-visible outage | Reading must survive publisher and pipeline trouble |
| Politeness | ≤ 1 fetch per feed per interval, ≤ 1 request/s per domain, honor `Retry-After` | Publishers block crawlers that ignore this |
| Dedup recall | Every pair of fingerprints within 3 bits is compared | Missed duplicates show up as repeated stories |
| Consistency | One article per URL; one story per event per window; feeds may lag ingestion by ≤ 60 s | Duplicates are visible; small lag is not |

## Capacity Estimation

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Sources | 50K feeds, median interval 15 min | 50,000 / 900 s ≈ **56 fetches/s** |
| Unchanged feeds | ~75% of polls answered `304` | ~14 bodies/s to parse instead of 56, and most of the bandwidth saved |
| New articles | 2M/day ≈ 23/s average, ~70/s peak | One clustering transaction each |
| Open stories | ~600K new stories/day × 48 h window ≈ 1.2M | A linear scan would be 1.2M Hamming checks per article, ~28M/s |
| Band lookup | 1.2M / 65,536 ≈ 18 stories per band value × 4 bands | **~70 candidates per article**, about 17,000× less work |
| Feed traffic | 5M DAU × 10 opens ≈ 50M/day; ~10K requests/s at peak including later pages | Ranking must be cached and pages served from snapshots |
| Feed snapshots | ~3K new snapshots/s at peak × 900 s TTL × ~5 KB ≈ 13 GB | A Redis cluster; 8-byte ids would halve it |
| Storage | Articles ~5 KB → 10 GB/day; search index ~6 GB/day; 90-day retention | ~900 GB in PostgreSQL (partitioned by month), ~540 GB in Elasticsearch |
| Search | ~2K queries/s at peak | Elasticsearch sized for search; PostgreSQL only as a fallback |

### Local Development Scale

The local stack has 10 seeded sources pointing at real publisher feeds, 6 seeded stories with 15 articles, a handful of users and well under 10 requests per second. One Express process serves the API and runs the crawler. PostgreSQL and Redis are required; Elasticsearch is optional.

## High-Level Architecture

```
┌─────────────────────────┐                                             ┌─────────────────────────┐
│ Reader web / mobile app │                                             │ Publisher feeds         │
│ admin console, same API │                                             │ ~50K RSS / Atom URLs    │
└────────────┬────────────┘                                             └─────────────────────────┘
             │                                                                       ▲
             │ (2) GET /api/v1/feed?cursor                     (1) conditional GET   │
             │ (3) GET /api/v1/search?q                             200 | 304        │
             ▼                                                                       │
┌─────────────────────────┐                                             ┌────────────┴────────────┐
│ CDN + load balancer     │                          lease, reschedule  │ Fetch workers           │
│ anon feed cached 30 s   │                       ┌─────────────────────┤ lease · per-domain pace │
└────────────┬────────────┘                       │                     └────────────┬────────────┘
             │                                    │                        raw items │
             │                                    │                                  │
             ▼                                    ▼                                  ▼
┌─────────────────────────┐             ┌────────────────────┐          ┌─────────────────────────┐
│ Feed API (stateless)    │  page rows  │ PostgreSQL         │          │ Kafka articles.raw      │
│ rank · diversify        ├────────────▶│ sources · schedule │          └────────────┬────────────┘
│ snapshot cursor         │             │ articles · stories │                       ▼
│ story pages · search    │             │ users · prefs      │ articles ┌─────────────────────────┐
│                         │             │ band index 4 x 16  │◀─────────┤ Cluster workers         │
│                         │             └────────────────────┘          │ SimHash band lookup     │
│                         │                                             │ story + counters        │
│                         │  search     ┌────────────────────┐  index   │ breaking detection      │
│                         ├────────────▶│ Elasticsearch      │◀─────────┤                         │
│                         │             │ articles index     │          │                         │
│                         │             └────────────────────┘          │                         │
└────────────┬────────────┘                                             └─────────────────────────┘
             │ snapshot, profile, session
             ▼
┌─────────────────────────┐
│ Redis · sessions, feeds │
└─────────────────────────┘
```

1. **Crawl (1).** Fetch workers claim due feeds from `crawl_schedule` under a lease, wait for the domain's next request slot, and send a conditional GET. A `304` ends the visit. On a `200` the worker publishes each item to Kafka, then stores the new ETag and the next crawl time. Cluster workers store each article and its story assignment in one PostgreSQL transaction, then index the article into Elasticsearch.
2. **Feed (2).** The CDN serves the anonymous feed from cache; personalized requests reach the Feed API. It ranks about 200 recent stories once, freezes that order as a snapshot in Redis, and returns one page plus a cursor. Later pages read the snapshot.
3. **Search (3).** The Feed API queries Elasticsearch and hydrates the hits from PostgreSQL. If Elasticsearch is unavailable, it answers from PostgreSQL full-text search instead.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| CDN + load balancer | TLS, static assets, anonymous feed cache (30 s) | Readers | Personalized responses are `Cache-Control: private` |
| Feed API | Ranking, snapshots, story pages, search, accounts, admin | Feed requests | Stateless; profiles and snapshots live in Redis |
| Fetch workers | Lease due feeds, conditional GET, backoff, per-domain pacing | Feed count (~56 fetches/s) | Network-bound; hundreds of requests in flight per worker |
| Kafka `articles.raw` | Buffer between fetching and clustering, replay | Article rate | Keyed by source id |
| Cluster workers | Store article, band lookup, assign story, counters, breaking flag, indexing | Article rate (~70/s peak) | Database-bound; one transaction per article |
| PostgreSQL | Source of truth: sources, schedule, articles, stories, users | Articles (~10 GB/day) | Articles partitioned by month; band columns indexed |
| Redis | Sessions, ranking profiles, feed snapshots | Daily active readers | Losing it logs readers out and restarts scrolls; no data is lost |
| Elasticsearch | Derived article index for search | Articles, search QPS | Rebuildable from PostgreSQL at any time |

Fetching and clustering are separate pools because they fail differently. Fetchers wait on publishers' networks; cluster workers wait on PostgreSQL. With Kafka between them, fetchers keep polling through a database incident, and a clustering bug can be fixed and the last day of articles replayed.

## Core Components / Request Flows

### Crawling one feed

```
Fetch worker                         PostgreSQL   Publisher feed    Kafka
      │                                   │              │            │
      │ 1 claim due sources, SKIP LOCKED  │              │            │
      │──────────────────────────────────▶│              │            │
      │ 2 sources, ETags, lease token     │              │            │
      │◀──────────────────────────────────│              │            │
      │ 3 wait for the domain's slot      │              │            │
      │ 4 GET, If-None-Match: "a1"                       │            │
      │─────────────────────────────────────────────────▶│            │
      │ 5 304, or 200 + body + new ETag                  │            │
      │◀─────────────────────────────────────────────────│            │
      ··························· 200 only ····························
      │ 6 one message per item                                        │
      │──────────────────────────────────────────────────────────────▶│
      ···························· always ·····························
      │ 7 next_crawl, ETag WHERE token    │              │            │
      │──────────────────────────────────▶│              │            │
      │                                   │              │            │
```

- **Claiming is the lease.** One statement selects due rows with `FOR UPDATE SKIP LOCKED`, pushes their `next_crawl` ten minutes ahead and stamps a fresh `lease_token`. Concurrent workers skip rows another worker is claiming instead of queueing behind it. If a worker dies mid-fetch, nothing needs cleaning up: the source becomes due again when the ten minutes pass.
- **Completion is fenced.** Step 7 updates the row only `WHERE lease_token = $token`. A worker that outlived its lease (a long GC pause, a hung connection) finds its token replaced and its update matches nothing, so it cannot overwrite the newer crawler's validators or schedule.
- **Validators advance last.** The new ETag is stored only after every item is durable (acknowledged by Kafka; committed locally). Storing it first would turn the next poll into a `304` and silently skip the items we failed to store.
- **Backoff is durable and per source.** A failure schedules the next attempt `interval × 2^failures` ahead, capped at 24 hours, with ±10% jitter, and never sooner than `Retry-After`. For a 15-minute feed that is 30 minutes after one failure, 2 hours after three, and once a day after seven. The state lives in `crawl_schedule`, so it survives restarts and every worker sees it.
- **Breakers are per source.** Within a process, `429`, `5xx` and timeouts count against that source's circuit breaker only. One publisher's bad afternoon never opens a breaker shared with nineteen healthy feeds.

### Ingesting and clustering one article

```
Cluster worker                           PostgreSQL    Elasticsearch
       │                                      │              │
       │ 1 BEGIN; INSERT ON CONFLICT (url)    │              │
       │─────────────────────────────────────▶│              │
       │ 2 new id (none: duplicate, stop)     │              │
       │◀─────────────────────────────────────│              │
       │ 3 lock the 4 band buckets            │              │
       │─────────────────────────────────────▶│              │
       │ 4 stories sharing a band, 48 h       │              │
       │─────────────────────────────────────▶│              │
       │ 5 ~70 candidates                     │              │
       │◀─────────────────────────────────────│              │
       │ 6 Hamming < 3? closest wins          │              │
       │ 7 lock story, link, recount, COMMIT  │              │
       │─────────────────────────────────────▶│              │
       │ 8 index (after commit)                              │
       │────────────────────────────────────────────────────▶│
       │                                      │              │
```

- **Fingerprint.** SimHash tokenizes title and body, uses unigrams and word trigrams as features, hashes each to 64 bits (FNV-1a), adds +1/−1 per bit position and keeps the sign. Similar text gives fingerprints that differ in a few bits; two articles join when fewer than 3 of 64 bits differ.
- **Bands.** The fingerprint is split into four 16-bit bands, stored as generated columns with an index each. Three differing bits can touch at most three bands, so any fingerprint within distance 3 shares at least one band exactly (the pigeonhole principle). Step 4 is therefore four indexed equality probes, and the exact Hamming check runs on ~70 candidates instead of a million stories.
- **Locks.** Two workers can ingest near-duplicates at the same moment. Each first takes transaction-scoped advisory locks on its four `(band, value)` buckets, in ascending order. Near-duplicates share a bucket, so the second waits, then sees the first one's committed story and joins it instead of creating a twin. Ascending order rules out deadlocks.
- **Counters and breaking.** After locking the story row, the worker recounts articles, distinct sources and the 30-minute velocity from the story's articles, so concurrent joins are never lost. A story becomes breaking when three or more distinct sources covered it in the window. Article time is the earlier of publication and arrival, so a newly added source's backlog doesn't look like a burst.

### Serving a feed page

```
Reader                          Feed API                         Redis   PostgreSQL
   │                                │                              │          │
   │ 1 GET /api/v1/feed?limit=20    │                              │          │
   │───────────────────────────────▶│                              │          │
   │                                │ 2 200 candidate stories, 48 h           │
   │                                │────────────────────────────────────────▶│
   │                                │ 3 score, sort, diversity penalty        │
   │                                │ 4 SET feed:snap:{id} EX 900  │          │
   │                                │─────────────────────────────▶│          │
   │                                │ 5 hydrate ids 1-20                      │
   │                                │────────────────────────────────────────▶│
   │ 6 page + cursor {snap, 20}     │                              │          │
   │◀───────────────────────────────│                              │          │
   ····························· reader scrolls ·······························
   │ 7 GET /api/v1/feed?cursor=...  │                              │          │
   │───────────────────────────────▶│                              │          │
   │                                │ 8 GET feed:snap:{id}         │          │
   │                                │─────────────────────────────▶│          │
   │                                │ 9 hydrate ids 21-40                     │
   │                                │────────────────────────────────────────▶│
   │ 10 next page, same ordering    │                              │          │
   │◀───────────────────────────────│                              │          │
   │                                │                              │          │
```

Each candidate gets a score from five signals, then a diversity pass:

| Signal | Weight | Computation |
|--------|--------|-------------|
| Relevance | 0.35 | 0.3 base + learned topic weights (preferred topics count as at least 0.8) + 0.2 if a preferred source covers it; capped at 1 |
| Freshness | 0.25 | `0.5 ^ (age_hours / 6)`, so it halves every six hours |
| Quality | 0.20 | `min(source_count / 5, 1)`: independent coverage as a proxy for importance |
| Trending | 0.10 | Velocity (articles/min over 30 min), decaying linearly to zero 30 minutes after the newest article |
| Breaking | +0.30 | Flat bonus while flagged |

After sorting, each story is multiplied by `0.8^n`, where `n` is the number of stories with the same primary topic already ranked above it. Stories covered only by sources the reader blocked are dropped before scoring.

**Snapshots.** The ranked id list (≤ 200 ids with scores) is stored as `feed:snap:{id}` for 15 minutes. `feed:current:{user}` points page-1 requests at the viewer's newest snapshot for 60 seconds, which is the feed cache. The cursor is an opaque base64url encoding of `{snapshot id, offset}`. A snapshot is only served to the viewer who created it, since another reader's ranking would reveal their interests. When a snapshot expires mid-scroll, the API ranks again and continues at the same offset, and the client drops any story it already shows. Hydration fetches the page's story rows and their three newest articles in two queries, so counts on the cards are current even though the order is frozen.

### Search

Elasticsearch runs a `multi_match` over title (×3), summary (×2) and body with topic and date filters; hits are hydrated from PostgreSQL in rank order. If the Elasticsearch call fails, the same request runs against a generated `tsvector` column (title weight A, summary B, body C) with `websearch_to_tsquery` and `ts_rank_cd`. The response carries `engine: "elasticsearch" | "postgres"` so the UI can say results are basic matches.

## Database Schema

### Production schema

```sql
CREATE TABLE sources (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  feed_url      TEXT NOT NULL UNIQUE,
  domain        TEXT NOT NULL,                 -- politeness is per domain, not per feed
  category      TEXT,
  crawl_frequency_minutes INT NOT NULL DEFAULT 15,
  priority      INT NOT NULL DEFAULT 5,
  is_active     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE crawl_schedule (
  source_id     UUID PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  next_crawl    TIMESTAMPTZ NOT NULL,          -- claiming pushes it ahead: that is the lease
  lease_token   UUID,                          -- fencing token for completion
  etag          TEXT,                          -- validators from the last fully stored 200
  last_modified TEXT,
  consecutive_failures INT NOT NULL DEFAULT 0, -- drives interval x 2^failures
  last_status   INT,
  last_error    TEXT
);
CREATE INDEX ON crawl_schedule (next_crawl);

-- A unique index on a partitioned table must include the partition key, so URL
-- uniqueness lives in a small unpartitioned table keyed by a hash of the URL.
CREATE TABLE article_urls (
  url_hash   BYTEA PRIMARY KEY,
  article_id UUID NOT NULL
);

CREATE TABLE articles (
  id           UUID NOT NULL,
  source_id    UUID NOT NULL REFERENCES sources(id),
  story_id     UUID,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  body         TEXT,
  published_at TIMESTAMPTZ,
  crawled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  fingerprint  NUMERIC(20, 0) NOT NULL,        -- unsigned 64-bit SimHash
  topics       TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, crawled_at)
) PARTITION BY RANGE (crawled_at);             -- monthly partitions, dropped after 90 days
CREATE INDEX ON articles (story_id, published_at DESC);

CREATE TABLE stories (
  id                  UUID PRIMARY KEY,
  title               TEXT NOT NULL,
  summary             TEXT,
  primary_topic       TEXT,
  topics              TEXT[] NOT NULL DEFAULT '{}',
  fingerprint         NUMERIC(20, 0) NOT NULL, -- the first article's fingerprint
  fp_band0 INT GENERATED ALWAYS AS (mod(fingerprint, 65536)::int) STORED,
  fp_band1 INT GENERATED ALWAYS AS (mod(div(fingerprint, 65536), 65536)::int) STORED,
  fp_band2 INT GENERATED ALWAYS AS (mod(div(fingerprint, 4294967296), 65536)::int) STORED,
  fp_band3 INT GENERATED ALWAYS AS (div(fingerprint, 281474976710656)::int) STORED,
  article_count       INT NOT NULL DEFAULT 1,
  source_count        INT NOT NULL DEFAULT 1,
  velocity            NUMERIC(10, 4) NOT NULL DEFAULT 0,
  is_breaking         BOOLEAN NOT NULL DEFAULT false,
  breaking_started_at TIMESTAMPTZ,
  last_article_at     TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Band + window in one index, so the 48-hour filter is served by the index too.
CREATE INDEX ON stories (fp_band0, last_article_at);
CREATE INDEX ON stories (fp_band1, last_article_at);
CREATE INDEX ON stories (fp_band2, last_article_at);
CREATE INDEX ON stories (fp_band3, last_article_at);
CREATE INDEX ON stories (breaking_started_at DESC) WHERE is_breaking;

-- users, user_preferences (preferred_topics, preferred_sources, blocked_sources),
-- user_reading_history UNIQUE (user_id, article_id), user_topic_weights UNIQUE (user_id, topic)
```

Redis keys: `session:{id}` (24 h), `user:{id}:prefs` (ranking profile, 5 min), `feed:snap:{id}` (15 min), `feed:current:{user|anon}` (60 s), `feed:topic:{topic}:{cursor}:{limit}` (60 s), `feed:breaking` (30 s), `story:{id}` (2 min).

### Local schema

The schema that actually runs is [`backend/src/db/init.sql`](./backend/src/db/init.sql). Every statement is guarded (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so it can be loaded twice or over an older volume. Differences from the production design:

- `articles` is not partitioned and has `url VARCHAR(1000) UNIQUE` directly; there is no `article_urls` table.
- `sources.domain` is `UNIQUE`, so the local build allows one feed per domain (adding a second returns `409`).
- Timestamps are `TIMESTAMP` without time zone; band indexes are single-column.
- `articles.search_vector` is a generated `tsvector` with a GIN index, used only by the search fallback.

The banding columns are generated by PostgreSQL itself, so no application code or seed has to keep them in sync:

```sql
ALTER TABLE stories ADD COLUMN IF NOT EXISTS fp_band0 INTEGER
  GENERATED ALWAYS AS (mod(fingerprint, 65536)::integer) STORED;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS fp_band1 INTEGER
  GENERATED ALWAYS AS (mod(div(fingerprint, 65536), 65536)::integer) STORED;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS fp_band2 INTEGER
  GENERATED ALWAYS AS (mod(div(fingerprint, 4294967296), 65536)::integer) STORED;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS fp_band3 INTEGER
  GENERATED ALWAYS AS (div(fingerprint, 281474976710656)::integer) STORED;
```

Fingerprints are stored as `NUMERIC(20, 0)`: SimHash is an unsigned 64-bit value, and a signed `BIGINT` rejects every fingerprint at or above 2⁶³.

## API Design

### Production API

```
GET    /api/v1/feed?cursor&limit            ranked page + opaque next_cursor (snapshot-backed)
GET    /api/v1/feed/topic/{topic}?cursor    stories with that topic, newest coverage first
GET    /api/v1/breaking                     stories flagged in the last 6 h
GET    /api/v1/trending                     most-covered stories of the last 24 h
GET    /api/v1/stories/{id}                 story + up to 20 articles (all coverage)
GET    /api/v1/search?q&topics&date_from&date_to   → {articles, engine}
POST   /api/v1/user/login | /register | /logout
GET    /api/v1/user/preferences             PUT replaces topics / preferred / blocked sources
POST   /api/v1/user/reading-history         {article_id, dwell_time_seconds}; safe to retry
POST   /api/v1/admin/sources                400 non-http(s) URL | 409 duplicate
POST   /api/v1/admin/sources/{id}/crawl     crawl now under a lease → 200 | 409 already running
POST   /api/v1/admin/stories/{id}/breaking  {is_breaking}
```

- **Cursors are opaque.** Clients never compute offsets; a cursor names a snapshot and a position. Malformed or old numeric cursors restart from the top instead of erroring.
- **Errors**: `400` for invalid input (non-UUID ids, unparseable dates, non-http(s) feed URLs), `401`/`403` for auth, `404` for unknown resources, `409` for a crawl already in progress or a duplicate source. Production would return them as `application/problem+json`; the local API returns `{error}`.
- **The read signal is idempotent.** Only the first read of an article changes learned weights, and dwell time is a maximum, not a sum, so the client can retry freely.

### Local routes

| Route | Handler | Notes |
|-------|---------|-------|
| `GET /api/v1/feed`, `/feed/topic/:topic`, `/breaking`, `/trending`, `/stories/:id`, `/stories/:id/articles`, `/search`, `/topics` | [routes/feed.ts](./backend/src/routes/feed.ts) | Topic feed still paginates with numeric offsets |
| `/api/v1/user/*` | [routes/user.ts](./backend/src/routes/user.ts) | Session cookie `session_id` or `X-Session-Id` header |
| `/api/v1/admin/*` | [routes/admin.ts](./backend/src/routes/admin.ts) | `GET /sources` includes `consecutive_failures`, `last_status`, `last_error`, `conditional_get` |
| `/health`, `/health/live`, `/health/ready`, `/health/detailed`, `/metrics` | [index.ts](./backend/src/index.ts) | Readiness requires PostgreSQL and Redis; Elasticsearch only degrades |

## Key Design Decisions

### 1. Poll with conditional GETs and durable per-source backoff

RSS has no reliable push: WebSub exists but few publishers support it, so polling is the baseline and WebSub is an optimization to add later. What makes polling affordable is the conditional GET. With the ETag and Last-Modified from the last good response, an unchanged feed costs a `304` with no body, and about three polls in four are unchanged. A naive crawler that re-downloads everything spends four times the bandwidth and parse CPU, and publishers notice.

Backoff has to be durable and per source. The original design retried failed feeds on every 15-minute cycle, and when a feed's circuit breaker opened it fell back to a shared "global" breaker with immediate retries. That sent *more* requests to a failing publisher, and let one publisher's errors open a breaker other feeds depended on. Exponential backoff stored in `crawl_schedule` survives restarts, is shared by all workers, and honors `Retry-After`. The cost is staleness for flaky-but-important sources: after a bad hour, a feed may wait a few hours for its next attempt. A `priority` column and a lower cap for priority sources address that.

### 2. Leases with `SKIP LOCKED` and fencing tokens for scheduling

Three alternatives fail in specific ways. A cron per instance crawls every due feed once per instance. A single scheduler with a global lock is a bottleneck and a single point of failure. A Redis lock per feed needs expiry and fencing anyway, and lives apart from the schedule it protects. Claiming rows with `FOR UPDATE SKIP LOCKED` keeps the queue and the lease in one table: workers never block each other, a crash releases work by itself, and the fencing token stops a worker that outlived its lease from overwriting newer state. At about 56 claims per second PostgreSQL is far from its limit. Beyond a few million feeds I would partition the schedule by hash of source id.

### 3. SimHash with four 16-bit bands, not a scan, MinHash or embeddings

| Approach | Where it breaks |
|----------|-----------------|
| ❌ Exact hash of the text | Any change in wording, punctuation or a byline produces a different hash; catches only verbatim reposts |
| ❌ Linear scan of recent fingerprints | 1.2M comparisons per article at production scale; cost grows with exactly the busy news days that matter |
| ⚠️ MinHash + LSH | Better Jaccard estimates, but ~100 hashes per document and tunable band/row trade-offs to store and reason about |
| ⚠️ Sentence embeddings | Catch paraphrases SimHash misses, but need model inference per article, a vector index and a fuzzier threshold |
| ✅ SimHash + 4×16-bit bands | 8 bytes per document, four indexed equality probes, and guaranteed recall for distance ≤ 3 |

What we give up is paraphrase blindness. Two outlets that write the same news in different words get different fingerprints and become two stories. That is acceptable because the main win is collapsing wire-service copies, which SimHash catches. An embedding pass over *candidate pairs* (same entities, same hour) is the natural next step, and it is cheap because it only runs on pairs SimHash didn't merge.

### 4. A story is its first fingerprint plus a 48-hour activity window

A story keeps the fingerprint of its first article and accepts articles while its newest article is less than 48 hours old. That window slides, so a developing story stays open while coverage keeps arriving, and coincidental matches against old stories are ruled out. The alternative, a running centroid of all member fingerprints, drifts as the story evolves and makes the band index churn on every update. The cost is non-transitivity: B can match A, and C can match B but not A, so C starts its own story. Advisory locks on band buckets make concurrent ingestion produce the same result as serial ingestion. They don't make clustering transitive.

### 5. Snapshot pagination over a ranked list

Offset pagination over a live ranking produces duplicates and gaps. Between page 1 and page 2, freshness decays, new stories arrive and the breaking flag changes, so items shift across page boundaries. Keyset pagination doesn't apply either, because there is no stable sort key: the score itself moves. Freezing the ranked id list for the length of a scroll (15 minutes) makes pages disjoint and complete. Precomputing feeds per user (fan-out on write) would also be consistent, but at 5M readers and ~70 new articles per second it would rewrite millions of lists per minute for feeds that are mostly never opened. Snapshots are computed only for readers who show up. The cost is Redis memory (~13 GB at peak) and slightly stale ordering within one scroll. Card contents are hydrated live, so counts are current.

### 6. Breaking news from distinct-source velocity

Raw article velocity is easy to fake by accident: one prolific source, or a new source's backlog, produces a burst of articles about nothing. Counting *distinct* sources within 30 minutes, by publication time capped at arrival time, measures independent confirmation, which is what "breaking" means. The flag expires from the banner after six hours. The threshold (3 sources) is a global constant, which is wrong for niche topics where three outlets is a lot. Per-topic thresholds are an open refinement.

### 7. Elasticsearch as a derived index, PostgreSQL full-text as the fallback

PostgreSQL is the source of truth; Elasticsearch is rebuilt from it. Search needs BM25 relevance across weighted fields, fuzzy matching and highlighting, which `ts_rank` does only coarsely. So Elasticsearch serves search while it is healthy, and a GIN-indexed `tsvector` keeps search working, with worse ranking, when it isn't. Indexing happens after the article commits. Production feeds the indexer from an event stream with retries, and a reindex job repairs drift.

## Consistency and Idempotency

- **One article per URL.** `INSERT … ON CONFLICT (url) DO NOTHING RETURNING id`. Re-crawls, overlapping crawls and replayed Kafka messages are no-ops. (The previous check-then-insert raced between instances.)
- **One transaction per article.** Insert, band locks, story lookup, story link and counter refresh commit together. A crash can't leave an article without a story, which matters because the URL constraint would then stop it from ever being processed again.
- **One crawler per feed.** Leases plus fencing tokens, as above. Two admins pressing "crawl now" at once get one `200` and one `409`.
- **Validators after durability.** The ETag advances only when every item from that response is stored.
- **Read signals are idempotent.** `RETURNING (xmax = 0) AS inserted` tells a fresh history row from an upsert; weights change only for the fresh one, and dwell time is `GREATEST(old, new)`.
- **Feeds are consistent within a scroll** (snapshot) and eventually consistent across scrolls (60-second page-1 reuse).

| Write | Invalidates |
|-------|-------------|
| Crawl stored new articles | Anonymous `feed:current:anon`, topic pages, breaking, trending |
| Preferences saved | `user:{id}:prefs` and `feed:current:{id}`, so the next page 1 uses the new preferences |
| First read of an article | `user:{id}:prefs` only; the scroll in progress keeps its snapshot |
| Admin breaking toggle | `feed:breaking` and `story:{id}` |

## Security / Auth

- **Passwords** are hashed with scrypt (N=2¹⁴, r=8, p=1, 16-byte random salt per hash) and compared in constant time. The hash string records its parameters, so the cost can be raised later. Hashes from the old salted-SHA-256 scheme still verify once and are replaced at that login.
- **Sessions** are random ids in Redis (24 h) in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` in production. Logout deletes the session. Admin routes check the role stored in the session.
- **Third-party content.** Article links are accepted only as absolute `http:`/`https:` URLs at ingestion, so a hostile feed can't plant a `javascript:` link. React escapes all text, and links open with `rel="noopener noreferrer"`.
- **SSRF.** Feed URLs are fetched server-side. Production must resolve each host and refuse private, loopback and link-local addresses (or fetch through an egress proxy), or an admin-added "feed" can probe internal services.
- **Rate limits** (production): login 5/min per IP and account, search 20/min per IP, and a per-domain fetch budget enforced by the fetchers themselves.

## Observability

| Metric | Type | Why |
|--------|------|-----|
| `crawler_fetch_total{status}` (`success`, `not_modified`, `error`, `timeout`, `circuit_open`) | Counter | The `not_modified` share shows whether conditional GETs work; a drop means validators are being lost |
| `crawler_fetch_duration_seconds{source_id}` | Histogram | Slow publishers |
| `story_assignments_total{result}` (`joined`, `created`) | Counter | Clustering health: a shift in the joined share signals a tokenizer or threshold regression |
| `articles_stored_total`, `articles_fetched_total` | Counter | Ingestion rate vs. feed volume (duplicate rate) |
| `feed_generation_duration_seconds{type,cached}` | Histogram | Snapshot reuse vs. fresh ranking latency |
| `cache_hits_total`, `cache_misses_total{cache_type}` | Counter | Profile and snapshot hit ratios |
| `circuit_breaker_state{name}` | Gauge | Per-source breaker states |

Alerts I'd set: `not_modified` share below 50% for an hour; more than 5% of active sources with `consecutive_failures ≥ 3`; repeated "lease expired" warnings, meaning crawls are outliving their lease; p99 feed latency above 200 ms; Elasticsearch fallback in use for more than 5 minutes. Logs are structured JSON (Pino) with `sourceId`, outcome, status and next-crawl delay on every crawl.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| A feed is down or rate-limits us | Backoff `interval × 2^n` (≤ 24 h), at least `Retry-After`; other feeds unaffected |
| Fetcher crashes mid-crawl | Lease expires after 10 min, source becomes due again; inserts are idempotent |
| Fetcher outlives its lease | Its completion update matches nothing (fencing token); a warning is logged |
| Item fails to store | Validators are not advanced; the next poll refetches the full body |
| Elasticsearch down | Search answers from PostgreSQL full-text search (`engine: postgres`); the API starts and stays ready without it |
| Redis down | Readers are treated as logged out; feeds still compute, more slowly and without snapshot reuse (a later page may repeat a story, which the client drops) |
| PostgreSQL down | Reading fails (readiness turns `503`); fetchers keep polling into Kafka in production |
| Kafka down (production) | Fetchers stop claiming; feeds keep serving what is stored |

## Scalability Considerations

What breaks first as the system grows, in order:

1. **Ranking CPU and candidate queries.** Every fresh snapshot scores 200 candidates. Cache the candidate pool per region for 30 seconds and personalize only the scoring, and keep snapshots small (ids only).
2. **Hot story rows.** A huge story gets dozens of articles a minute, and each recount scans all its articles under the row lock. At scale I'd keep counters incrementally (a per-story source set in Redis or a `story_sources` table) instead of recounting.
3. **The schedule table.** Fine to a few million feeds; beyond that, partition by hash of source id and give each worker pool a partition range.
4. **Article storage and indexing.** Monthly partitions with 90-day retention; Elasticsearch rolling indices with lifecycle management.
5. **Per-domain politeness across workers.** In-process pacing stops working once one domain's feeds land on many workers. Route feeds to workers by hash of domain, or keep a token bucket per domain in Redis.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Feed freshness | Polling + conditional GET | Full re-download each poll | ~75% of polls become 304s; publishers stay friendly |
| Failure policy | Durable per-source exponential backoff | Retry every cycle / global breaker | Isolates failures; honors Retry-After; survives restarts |
| Scheduling | `SKIP LOCKED` lease + fencing token | Cron per instance, global lock | No double crawls, no coordinator, crash-safe |
| Near-duplicates | SimHash + 4×16 bands | Linear scan, MinHash, embeddings | Indexed lookup, guaranteed recall ≤ 3 bits, 8 bytes/doc |
| Story identity | First fingerprint + 48 h activity window | Running centroid | Stable index; window bounds false matches |
| Concurrent clustering | Advisory locks on band buckets | Unique constraint / serialize all ingestion | Serializes only near-duplicates |
| Pagination | Ranked snapshot + opaque cursor | Offset over live ranking, per-user fan-out | Disjoint pages; compute only for active readers |
| Breaking news | ≥ 3 distinct sources in 30 min | Raw article velocity, manual only | Measures independent confirmation |
| Search | Elasticsearch + PostgreSQL fallback | PostgreSQL only / Elasticsearch only | Good relevance, and search survives an ES outage |
| Passwords | scrypt with per-hash salt | SHA-256 with a fixed salt | Slow, salted hashes; legacy hashes upgraded at login |

## Implementation Notes

The local project runs the whole pipeline in one Node.js process: Express API, in-process crawler, PostgreSQL 16, Valkey/Redis 7, and optionally Elasticsearch 8 from [`docker-compose.yml`](./docker-compose.yml). The frontend is React 19 + TanStack Router + Zustand. This section maps the design above to the code as of the 2026-10-10 review.

### Production design → local implementation

| Production design | Local implementation | Where |
|-------------------|----------------------|-------|
| Fetch workers + Kafka + cluster workers | One process: `node-cron` every 15 min (plus a startup crawl) claims sources and ingests inline; `CRAWLER_ENABLED=false` turns the schedule off on extra instances | [index.ts](./backend/src/index.ts), [crawler.ts](./backend/src/services/crawler.ts) |
| Lease + fencing token | Implemented as designed (`CRAWLER_LEASE_SECONDS`, default 600) | [crawler.ts](./backend/src/services/crawler.ts) |
| Conditional GET + durable backoff | Implemented; policy is pure functions with tests | [crawl-policy.ts](./backend/src/services/crawl-policy.ts) |
| Per-domain politeness | In-process slots per domain (`CRAWLER_DOMAIN_DELAY_MS`, default 1 s); not shared across instances | [crawler.ts](./backend/src/services/crawler.ts) |
| SimHash + bands + advisory locks | Implemented; generated band columns, single-column indexes | [simhash.ts](./backend/src/utils/simhash.ts), [init.sql](./backend/src/db/init.sql) |
| Snapshot pagination | Implemented for the main feed; topic pages still use numeric offsets | [feed.ts](./backend/src/services/feed.ts) |
| Breaking detection | Automatic (≥ `BREAKING_MIN_SOURCES` in `VELOCITY_WINDOW_MINUTES`), shown for `BREAKING_TTL_HOURS`; admins can also toggle it | [crawler.ts](./backend/src/services/crawler.ts), [feed.ts](./backend/src/services/feed.ts) |
| Elasticsearch + fallback | ES optional at startup (retried in the background); PostgreSQL full-text fallback per request | [search.ts](./backend/src/services/search.ts), [elasticsearch.ts](./backend/src/db/elasticsearch.ts) |
| scrypt passwords | Implemented with legacy upgrade | [password.ts](./backend/src/shared/password.ts), [user.ts](./backend/src/services/user.ts) |

### Crawling

A pass claims up to 50 due sources in one statement and crawls ten at a time:

```typescript
// backend/src/services/crawler.ts — claimDueSources()
`WITH due AS (
   SELECT cs.source_id
   FROM crawl_schedule cs
   JOIN sources s ON s.id = cs.source_id
   WHERE s.is_active = true AND cs.next_crawl <= NOW()
   ORDER BY cs.priority DESC, cs.next_crawl ASC
   LIMIT $1
   FOR UPDATE OF cs SKIP LOCKED
 )
 UPDATE crawl_schedule cs
 SET next_crawl = NOW() + make_interval(secs => $2::int), lease_token = $3
 FROM due, sources s
 WHERE cs.source_id = due.source_id AND s.id = cs.source_id
 RETURNING ${CLAIMED_SOURCE_COLUMNS}`
```

`fetchFeed()` sends `If-None-Match`/`If-Modified-Since` through the source's Opossum breaker (10 s timeout). `429` and `5xx` throw inside the breaker so they count against it; `304` and `4xx` don't. It never throws: every outcome comes back as `fetched`, `not_modified` or `failed`, because the scheduler needs it. `crawlSource()` parses and ingests a `200` and computes the next delay with `nextCrawlDelaySeconds()`. `completeCrawl()` then writes validators, failure count, status and `next_crawl` only `WHERE lease_token = $token`. The admin "crawl now" button uses `claimSource()`, the same lease, so it returns `409` while a crawl is running. The old fallback that retried open-circuit sources through a shared global breaker is gone.

### Ingestion and clustering

`processArticle()` keeps only absolute http(s) links (`normalizeArticleUrl()`), truncates over-long fields, computes the fingerprint, topics and entities, and runs `INSERT … ON CONFLICT (url) DO NOTHING` and `assignToStory()` in one `withTransaction()`. `assignToStory()` skips matching for an all-zero fingerprint (text with no usable tokens). Otherwise it takes `pg_advisory_xact_lock(20817, band * 65536 + value)` for the four bands, selects candidates sharing a band whose `last_article_at` is within 48 hours, picks the closest under distance 3 (`closestStory()`), locks the story row, links the article and runs one aggregate `UPDATE` for counts, velocity and the breaking flag. Indexing into Elasticsearch happens after the commit, with two quick retries, and is logged and skipped on failure.

### Feed, personalization and reading signals

`getPersonalizedFeed()` decodes the cursor, loads the snapshot (or the viewer's current one for page 1), and otherwise ranks with `rankStories()` and stores a new snapshot. `hydrateStories()` loads the page's rows and up to three newest articles per story (minus blocked sources) in two queries; the old code issued one query per story. Freshness is now a true six-hour half-life (`0.5^(age/6)`; the code previously used `e^(-age/6)`, which keeps only 37% at six hours). Trending uses `effectiveVelocity()`, which decays stored velocity to zero 30 minutes after the newest article; before, a burst of coverage stayed "trending" forever. Saving preferences validates the payload (source ids must be UUIDs) and invalidates the profile and the current snapshot. `recordArticleRead()` runs in one transaction and learns only from the first read. The story page now sends that signal when a signed-in reader opens an article, using `fetch(…, {keepalive: true})`; before, nothing in the UI called it.

### Frontend

File-based TanStack Router routes (`/`, `/topics/$topic`, `/story/$storyId`, `/search`, `/trending`, `/settings`, `/admin`, `/login`) load data in route loaders. A Zustand store holds the persisted user and the feed list. `appendStories` drops ids already shown, which matters when an expired snapshot is re-ranked. The search page shows a notice when results came from the PostgreSQL fallback. There is no server-state cache library, no list virtualization, no SSE (the breaking banner is fetched by the home loader), and no UI for preferred or blocked sources (the API supports both).

### Operations

`/health/ready` requires PostgreSQL and Redis and reports Elasticsearch as `degraded` without failing. Elasticsearch initialization is retried in the background, so the API starts without it. Shutdown on `SIGTERM` stops the cron task, closes the HTTP server, waits up to 10 s for an in-flight crawl, then closes PostgreSQL and Redis, with a forced exit after 15 s. An unfinished crawl is safe because its lease simply expires. The session middleware treats a Redis error as "not logged in" instead of leaving the request hanging. `npm run db:seed` applies [`db-seed/base.sql`](./backend/db-seed/base.sql) and writes six clustered stories with real fingerprints.

### Verification (2026-10-10)

- `cd backend && npm test`: 35 offline vitest tests (crawl policy, `fetchFeed` and `crawlSource` against a stubbed `fetch` and mocked database, SimHash banding including a 2,000-case pigeonhole property test, ranking and snapshot pagination against an in-memory Redis, password hashing). Backend `tsc --noEmit` and lint clean; frontend `tsc`, lint and `vite build` clean.
- Against real PostgreSQL 16 and Redis with Elasticsearch absent and a local mock RSS origin: `init.sql` loads twice, and again over seeded data. The API starts and is ready without Elasticsearch. The legacy admin hash logs in and is rewritten as scrypt. Three feed pages stay disjoint while a new breaking story is inserted mid-scroll. A 200 stores the ETag and the re-crawl is a `304` with `If-None-Match`. A `503` with `Retry-After: 120` schedules the next attempt at least 120 s out. The same article from two sources crawled concurrently ends up as one story with two sources. Two simultaneous "crawl now" requests return `200` and `409`. Search falls back to PostgreSQL. Blocking a story's sources hides it immediately. Two identical read signals bump the topic weight once. `SIGTERM` exits cleanly.

### Simplified or omitted

- **Remaining limitations.** Topic pages paginate by offset over stored velocity, so pages can shift. Elasticsearch drift (an article whose indexing failed after retries) has no repair job; the fallback only covers Elasticsearch being *down*. Per-domain pacing is per process. `sources.domain` is unique (one feed per domain). Feed URLs are not checked against private addresses (SSRF). No rate limiting. The session caches the role at login. The breaking flag is sticky, and detection can re-flag a story an admin cleared. Story counters are recomputed with `COUNT(DISTINCT)` per new article.
- **Omitted:** Kafka and separate worker pools, CDN, multi-region, partitioned tables, WebSub push, embeddings or entity-based clustering, ML topic classification (topics are keyword lists in [topics.ts](./backend/src/utils/topics.ts)), source credibility scoring, notifications, and A/B testing of ranking weights.

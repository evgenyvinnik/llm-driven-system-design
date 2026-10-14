# 📰 News Aggregator — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "A news aggregator looks like 'fetch some RSS, show a list'. Two things make it hard. On the way in, we poll fifty thousand feeds we don't own, every fifteen minutes, without hammering anyone, and turn the stream into *stories*: twenty outlets covering one event must collapse into one entry, and that decision has to take milliseconds per article. On the way out, every reader gets a personal ranking that changes minute by minute, and paging through it still has to make sense."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the two numbers that drive the design |
| High-level architecture | 10 min | One overview and the three core flows |
| Data model & API | 7 min | Where each piece of state lives, and the contract |
| Deep dive 1: polite crawling | 7 min | Conditional GETs, backoff, leases |
| Deep dive 2: clustering | 8 min | SimHash, banding, concurrent ingestion |
| Deep dive 3: ranking & pagination | 5 min | Signals, diversity, snapshot cursors |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down what 'aggregator' means here, because Google News, Feedly and Flipboard are three different products."

### Functional requirements

1. **Crawl** publisher RSS/Atom feeds on per-source intervals (5–60 minutes).
2. **Deduplicate and cluster**: one row per article URL, and near-duplicate articles grouped into a **story** with coverage counts.
3. **Feeds**: a personalized ranked feed (topics, preferred and blocked sources, learned interests), an anonymous feed, topic pages, trending, and story detail with all coverage.
4. **Breaking news**: detect when coverage of a story spikes and show it in a banner.
5. **Search** across articles with topic and date filters.
6. **Admin**: manage sources, see which feeds are failing, flag or unflag breaking stories.

Out of scope: scraping full article pages (we use what the feed gives us), paywalls, delivering push notifications, comments.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Freshness | Article visible within one polling interval + 1 min (p95 ≤ 16 min; ≤ 3 min for priority feeds) | News decays by the minute |
| Breaking detection | Within 2 min of the third independent source | A late banner is useless |
| Feed latency | p99 < 200 ms for a cold page 1, < 60 ms for later pages | The main interaction |
| Search latency | p95 < 500 ms | Interactive |
| Availability | 99.9% for reading; crawling may lag silently | Readers shouldn't feel publisher outages |
| Politeness | ≤ 1 fetch per feed per interval, ≤ 1 req/s per domain, honor `Retry-After` | Publishers block abusive crawlers |
| Correctness | One article per URL, one story per event, pages that don't repeat or skip | Duplicates are the most visible bug in this product |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Feeds | 50K, median interval 15 min | 50,000 / 900 s ≈ 56 fetches/s |
| Unchanged polls | ~75% (conditional GET → `304`) | Only ~14 bodies/s to parse |
| New articles | 2M/day ≈ 23/s, ~70/s at peak | One clustering transaction each |
| Open stories | ~600K/day × 48 h ≈ 1.2M | A linear scan is 1.2M comparisons per article |
| Band candidates | 1.2M / 65,536 × 4 bands ≈ 70 | Banding makes clustering ~17,000× cheaper |
| Feed requests | 5M DAU × 10 opens; ~10K req/s at peak | Rank once per scroll, not once per page |
| Storage | ~10 GB/day of articles, ~6 GB/day of search index, 90-day retention | Monthly partitions, rolling indices |

"Two numbers drive the design. Fifty-six fetches a second means politeness is an engineering problem, not a courtesy. And 1.2 million open stories means 'find the matching story' needs an index, not a loop."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the system once, then walk the three journeys: crawling a feed, clustering an article, and reading a feed."

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

1. **Crawl (1).** Fetch workers claim due feeds from a schedule table under a lease, wait for the domain's next request slot, and send a conditional GET. A `304` ends it. On a `200`, each item goes to Kafka, and only then does the worker store the new ETag and next crawl time. Cluster workers consume the items, store each article with its story assignment in one PostgreSQL transaction, and index it into Elasticsearch.
2. **Feed (2).** The CDN answers anonymous feed requests from a 30-second cache. Personalized requests reach the Feed API, which ranks ~200 candidate stories once, freezes the order as a snapshot in Redis, and returns a page and a cursor. Later pages read the snapshot.
3. **Search (3).** The Feed API queries Elasticsearch and hydrates hits from PostgreSQL. If Elasticsearch is down, it falls back to PostgreSQL full-text search.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| CDN + load balancer | TLS, static assets, anonymous feed cache | Readers | Personalized responses are `private` |
| Feed API | Ranking, snapshots, story pages, search, accounts | Feed requests | Stateless |
| Fetch workers | Lease feeds, conditional GET, backoff, domain pacing | Feed count | Network-bound |
| Kafka `articles.raw` | Buffer between fetch and cluster; replay | Article rate | Keyed by source |
| Cluster workers | Store article, find story, update counters and breaking flag, index | Article rate | Database-bound |
| PostgreSQL | Sources, schedule, articles, stories, users | Articles | Source of truth; partitioned by month |
| Redis | Sessions, ranking profiles, feed snapshots | Active readers | Losing it costs logins and scroll positions, not data |
| Elasticsearch | Search index | Articles, search QPS | Derived; rebuildable from PostgreSQL |

"Why put Kafka between fetching and clustering? They fail differently. Fetchers wait on other people's servers; cluster workers wait on our database. With a log in between, a database incident doesn't stop polling, a slow publisher doesn't hold database connections, and if I ship a clustering bug I can fix it and replay yesterday's articles."

### Flow 1: crawling a feed

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

"Step 1 is the whole scheduler: one statement selects due rows `FOR UPDATE SKIP LOCKED`, pushes their `next_crawl` ten minutes ahead and stamps a lease token. Moving `next_crawl` forward *is* the lease: if this worker dies, the feed becomes due again by itself. Step 7 only applies while the token still matches, so a worker that stalled past its lease can't overwrite fresher state. And the ETag is saved last, after the items are safely in Kafka. If I saved it first and the publish failed, the next poll would get a `304` and those items would be gone for good."

### Flow 2: clustering an article

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

"The insert's `ON CONFLICT (url)` makes re-crawls and replays free. Steps 3–5 are the interesting part: the four band locks make two workers that ingest near-duplicates at the same moment take turns, so the second one finds the first one's story instead of creating a twin. Everything up to the commit is one transaction, so an article can never exist without its story."

### Flow 3: reading the feed

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

"Ranking happens once per scroll (steps 2–4), not once per page. Pages 2 and onward are a Redis read plus a two-query hydration, which is how later pages stay under 60 ms. Hydration reads live rows, so the source counts on the cards are current even though the order is frozen."

---

## 💾 Data Model (4 min)

"PostgreSQL owns everything that must be correct. Redis holds copies and per-session state. Elasticsearch holds a rebuildable index."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `sources` | `id`, `name`, `feed_url` (unique), `domain`, `crawl_frequency_minutes`, `priority`, `is_active` | Politeness is per domain, so `domain` is stored explicitly |
| PostgreSQL | `crawl_schedule` | `source_id` (PK), `next_crawl`, `lease_token`, `etag`, `last_modified`, `consecutive_failures`, `last_status` | Index on `next_crawl`; the claim query reads it with `SKIP LOCKED` |
| PostgreSQL | `articles` | `id`, `source_id`, `story_id`, `url`, `title`, `summary`, `published_at`, `fingerprint` (unsigned 64-bit, `NUMERIC(20,0)`), `topics` | Partitioned by month; `(story_id, published_at DESC)` for story pages |
| PostgreSQL | `article_urls` | `url_hash` (PK), `article_id` | URL uniqueness; a unique index on a partitioned table would have to include the partition key |
| PostgreSQL | `stories` | `id`, `fingerprint`, `fp_band0..3` (generated), `article_count`, `source_count`, `velocity`, `is_breaking`, `breaking_started_at`, `last_article_at` | `(fp_bandN, last_article_at)` × 4 for candidate lookup |
| PostgreSQL | `users`, `user_preferences`, `user_reading_history`, `user_topic_weights` | Unique `(user_id, article_id)` and `(user_id, topic)` | Learned interests live next to explicit ones |
| Redis | `feed:snap:{id}`, `feed:current:{user}` | Ranked ids + scores; pointer to the viewer's newest snapshot | 15 min and 60 s TTLs |
| Redis | `user:{id}:prefs`, `session:{id}` | Ranking profile; session | 5 min; 24 h |
| Elasticsearch | `articles` | title, summary, body, topics, published_at, story_id | Not the fingerprint: it's unsigned 64-bit and overflows `long` |

"Two details I'd call out. The fingerprint is stored as `NUMERIC(20,0)`, because SimHash is unsigned and a signed `BIGINT` rejects half of all fingerprints; an earlier version of this system lost exactly that half. And the four band columns are *generated* columns, so PostgreSQL keeps them in sync with the fingerprint and no writer can forget them."

---

## 🔌 API Design (3 min)

```
GET    /api/v1/feed?cursor&limit            ranked page + opaque next_cursor
GET    /api/v1/feed/topic/{topic}?cursor    stories with that topic
GET    /api/v1/breaking                     stories flagged in the last 6 h
GET    /api/v1/stories/{id}                 story + all coverage
GET    /api/v1/search?q&topics&date_from    → articles + engine
PUT    /api/v1/user/preferences             topics, preferred and blocked sources
POST   /api/v1/user/reading-history         {article_id, dwell}; safe to retry
POST   /api/v1/admin/sources                400 non-http(s) URL | 409 duplicate
POST   /api/v1/admin/sources/{id}/crawl     crawl now under a lease → 200 | 409
```

- **The cursor is opaque.** It encodes a snapshot id and an offset. Clients never do arithmetic on it, which lets me change the pagination scheme without breaking them.
- **The read signal is idempotent by design.** Only the first read of an article changes learned weights, and dwell time is a maximum, not a sum, so the client can fire it with `keepalive` and retry on failure.
- **"Crawl now" goes through the same lease** as the scheduler. A second click while a crawl is running gets `409`, not a second crawl.
- **Search tells you which engine answered** (`elasticsearch` or `postgres`) so the UI can be honest about degraded relevance.
- **Errors** are `application/problem+json`; invalid ids, dates and URLs are `400`, not a database error turned into a `500`.

---

## 🔧 Deep Dive 1: Polite Crawling at 56 Fetches a Second (7 min)

"The constraint is that we're guests on fifty thousand servers. Being a bad guest gets us rate-limited or blocked, and each publisher we lose is a hole in the product."

**Conditional GETs.** Every `200` gives us an `ETag` and/or `Last-Modified`. The next poll sends them back as `If-None-Match` and `If-Modified-Since`, and an unchanged feed answers `304` with no body. Most feeds publish a few items an hour, so about three polls in four come back unchanged. That removes ~75% of bandwidth and parse CPU, for us and for the publisher.

**Backoff that remembers.** When a feed fails, I schedule the next attempt `interval × 2^failures` ahead, cap it at 24 hours, add ±10% jitter, and never come back sooner than its `Retry-After`. For a 15-minute feed that is 30 minutes after one failure, 2 hours after three, and once a day after seven. The state lives in `crawl_schedule`, not in process memory, so a deploy doesn't reset a dead feed back to 15-minute retries, and every worker sees the same state.

**Leases instead of locks or cron.**

| Approach | What goes wrong |
|----------|-----------------|
| ❌ Cron on every instance | Each instance crawls every due feed: N× the load on publishers, duplicate work for us |
| ❌ One scheduler + global lock | A bottleneck and a single point of failure; failover needs its own coordination |
| ❌ Redis lock per feed | Needs expiry and fencing anyway, and lives apart from the schedule it guards |
| ✅ `SKIP LOCKED` claim + lease token | Workers never block each other; a crash releases work by itself; fencing blocks stale writers |

**Per-domain pacing.** Several feeds often share a host, like a publisher's section feeds. Each worker keeps a "next free slot" per domain and *reserves* the slot before sleeping, so ten concurrent crawls of one domain line up one second apart instead of waking together. Across workers I'd route feeds by hash of domain, so one worker owns each domain's pace.

**Circuit breakers per source, never shared.** A breaker on a single shared "fetch" function lets one publisher's 5xx storm open the circuit for everyone. I also wouldn't do what an early version of this system did: when a feed's breaker opened, it retried the feed immediately through a global breaker, which sent *more* traffic to a publisher that was already failing.

"What I give up: a flaky but important source can go quiet for hours after a bad stretch. I'd mitigate that with a `priority` column and a lower backoff cap for priority sources, and an alert when a priority source passes three consecutive failures."

---

## 🔧 Deep Dive 2: Clustering Near-Duplicates (8 min)

"The product decision is that the feed shows stories, not articles. So for every incoming article I must answer 'which open story is this?' in milliseconds, against about 1.2 million open stories."

**Why SimHash.** A cryptographic hash is the wrong tool: change one word and the digest is unrecognizable, so it only catches verbatim reposts. SimHash is built the other way round. I tokenize title and body, use single words *and* three-word phrases as features, hash each feature to 64 bits, add +1 or −1 per bit position, and keep the sign of each position. Similar texts share most features, so their fingerprints differ in only a few bits. Comparing two articles is an XOR and a popcount, and I treat fewer than 3 differing bits as "same story". The trigrams matter: two unrelated tech articles share plenty of single words but very few three-word phrases.

**Why banding.** Even a cheap comparison is too slow 1.2 million times per article. So I split the fingerprint into four 16-bit bands and index each one. If two fingerprints differ in at most three bits, those bits can land in at most three bands, so at least one band is identical. That's the pigeonhole principle, and it means four indexed equality lookups (`fp_band0 = $1 OR … fp_band3 = $4`, within the 48-hour window) are guaranteed to return every true match. Each band value is shared by ~18 random stories, so I verify ~70 candidates exactly instead of 1.2 million.

| Approach | Verdict |
|----------|---------|
| ❌ Linear scan over the window | Correct, but 28M comparisons/s at peak, worst on the busiest news days |
| ⚠️ MinHash + LSH | Tunable Jaccard similarity, but ~100 hash values per article and more knobs |
| ⚠️ Embeddings + vector index | Catches paraphrases, but inference per article and a fuzzy threshold |
| ✅ SimHash + 4×16 bands | 8 bytes per article, indexed lookups, guaranteed recall at distance ≤ 3 |

**Concurrency.** Two cluster workers can get the AP and Reuters versions of one wire story in the same millisecond. Both look for candidates, find none, and both create a story, and now the event appears twice. A unique constraint can't help, because "near-duplicate" isn't an equality. My fix: before looking up candidates, each transaction takes advisory locks on its four `(band, value)` buckets, in ascending order. Near-duplicates share at least one bucket, so they serialize, and the second one sees the first one's committed story. Unrelated articles share no bucket and never wait. Taking the locks in a fixed order rules out deadlocks.

**Story identity.** A story keeps its first article's fingerprint and stays open while its newest article is less than 48 hours old. A centroid that updates with every member would drift and churn the index. The window bounds false matches against old, unrelated stories.

**Counters and breaking news.** After locking the story row, I recount articles, distinct sources and 30-minute velocity from the story's articles. Recounting rather than incrementing means concurrent joins are never lost. A story becomes breaking when **three distinct sources** cover it within 30 minutes. I count sources, not articles, because one prolific outlet, or a newly added source's backlog, would otherwise look like a breaking event.

"What I give up: paraphrases. If two outlets write the same news in different words, SimHash keeps them apart. It's the right first stage because wire-service copies are most of the duplication. The next stage would be an embedding check on *pairs* SimHash didn't merge but that share entities and an hour. That's cheap because it only runs on those pairs."

---

## 🔧 Deep Dive 3: Ranking and Consistent Pagination (5 min)

"Two problems: what order to show, and how to page through an order that keeps moving."

**The score.** Each candidate gets `0.35 × relevance + 0.25 × freshness + 0.20 × quality + 0.10 × trending`, plus 0.3 while breaking. Relevance is learned topic weights plus explicit preferences plus a bonus for preferred sources. Freshness halves every six hours. Quality is source count over five, capped at 1: independent coverage as a proxy for importance. Trending is velocity, decaying to zero 30 minutes after the last article, so a story that stopped getting coverage stops looking hot. Stories covered *only* by sources the reader blocked are dropped.

**Diversity.** Pure relevance is a filter bubble: read three tech stories, get more tech, read more tech. After sorting, I multiply each story by `0.8^n`, where `n` is how many stories with the same primary topic rank above it. It's a penalty, not a quota: a fifth tech story can still outrank the first sports story if its raw score is about 2.4× higher. On a day when one topic really is the news, the feed shows that.

**Pagination.** Offset pagination over a live ranking duplicates and skips stories, because between page 1 and page 2 everything decays, new stories arrive and flags change. Keyset pagination needs a stable sort key, and the score isn't one. So page 1 freezes the ranked id list as a snapshot in Redis for 15 minutes, and the cursor names the snapshot and an offset.

| Approach | Verdict |
|----------|---------|
| ❌ Offset over the live ranking | Items shift across page boundaries: duplicates and gaps |
| ❌ Precomputed feed per user (fan-out on write) | 70 articles/s × 5M readers is millions of list rewrites a minute, mostly for feeds nobody opens |
| ✅ Snapshot per scroll + opaque cursor | Disjoint, complete pages; computed only for readers who show up |

"The cost is Redis memory, about 13 GB at peak, and an order that's up to 15 minutes old within one scroll. Card contents are live, though. A snapshot is only served to its owner, because someone else's ranking leaks their interests. When a snapshot expires mid-scroll, I re-rank and continue at the same offset, and the client drops stories it already shows."

---

## 📈 Scale, Failures & Observability (3 min)

**What breaks first, in order:** ranking CPU on cold page-1 loads (cache the regional candidate pool for 30 s and personalize only the scoring); hot story rows when a huge story gets dozens of articles a minute (switch from recounts to incremental counters); the schedule table beyond a few million feeds (partition by hash of source id); and article storage (monthly partitions, 90-day retention).

| Failure | What readers see | Mitigation |
|---------|------------------|------------|
| A publisher is down or rate-limits us | Nothing; that source's stories arrive later | Durable backoff, `Retry-After`, per-source breaker |
| Fetch worker crashes mid-crawl | Nothing | Lease expires in 10 min; inserts are idempotent |
| Elasticsearch down | Search still works, with a "basic results" note | PostgreSQL full-text fallback |
| Redis down | Logged out; later pages may repeat a story | Feeds compute without snapshots; client dedupes |
| PostgreSQL primary down | Feeds fail; no new stories | Replica promotion; fetchers keep buffering into Kafka |
| Kafka down | New articles pause | Fetchers stop claiming; reading is unaffected |

**What I'd watch:** the share of `304` responses (if it drops, validators are being lost); sources with three or more consecutive failures; the joined-vs-created ratio of story assignments (a jump means a tokenizer or threshold regression); lease-expired warnings (crawls outliving leases); p99 feed latency split by snapshot hit or miss; and how often search uses the fallback.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Freshness | Polling + conditional GET | Re-download every poll | ~75% of polls become 304s |
| Failure policy | Durable per-source backoff | Retry every cycle, global breaker | Isolates failures, honors `Retry-After` |
| Scheduling | `SKIP LOCKED` lease + fencing | Cron per instance, global lock | No double crawls, crash-safe |
| Near-duplicates | SimHash + 4×16 bands | Scan, MinHash, embeddings | Indexed, guaranteed recall, cheap |
| Concurrent clustering | Advisory locks on band buckets | Serialize all ingestion | Only near-duplicates wait |
| Breaking | ≥ 3 distinct sources in 30 min | Raw velocity, manual | Measures independent confirmation |
| Pagination | Ranked snapshot + cursor | Offset, per-user fan-out | Consistent pages, compute on demand |
| Search | Elasticsearch + PostgreSQL fallback | Either alone | Relevance when healthy, availability when not |

"With more time I'd add the embedding pass for paraphrases, WebSub push for the publishers that support it, per-topic breaking thresholds (three sources is a lot for chess news and nothing for an election), and an evaluation loop for the ranking weights. Right now they're educated guesses, and I'd want to know whether ranked beats chronological on read-through."

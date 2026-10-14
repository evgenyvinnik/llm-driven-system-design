# 📰 News Aggregator — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "I want to follow one news event end to end: a publisher posts it, our crawler finds it politely, it merges with nineteen other outlets' versions into one story, and it lands in a reader's feed, maybe with a breaking banner. The hard part is the contracts between the layers. The backend's ranking changes every minute, so the cursor the client holds has to mean something stable. The reader's clicks feed the ranking, so that signal has to survive retries. And freshness has to be honest on screen, not just in the database."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from publisher to screen, plus the flows that cross the seam |
| Data model & API contract | 7 min | Server tables, client cache, and the fields both sides rely on |
| Deep dive 1: an infinite feed over a moving ranking | 8 min | Snapshot cursor + client dedupe |
| Deep dive 2: the personalization loop | 7 min | Preferences, read signals, invalidation, diversity |
| Deep dive 3: from crawl to breaking banner | 7 min | Polite crawling, clustering, live and honest UI |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a reader |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** We crawl publisher RSS/Atom feeds and cluster articles into stories. Readers get a personalized ranked feed (or an anonymous one), topic pages, story pages with all coverage, a breaking-news banner, and full-text search. Signed-in readers set preferred topics and preferred or blocked sources, and their reading teaches the ranking. Admins manage sources and see crawl health. Out of scope: full-page scraping, paywalls, push notifications, comments.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Freshness | New article in feeds within one polling interval + 1 min (p95 ≤ 16 min) |
| Backend | Breaking detection | Within 2 min of the third independent source |
| Backend | Feed API latency | p99 < 200 ms cold page 1, < 60 ms later pages |
| Backend | Politeness | ≤ 1 fetch per feed per interval, ≤ 1 req/s per domain, honor `Retry-After` |
| Frontend | Front page | LCP < 2.5 s on mid-range mobile over 4G; CLS < 0.1 |
| Frontend | Scrolling | INP < 200 ms; no duplicate or missing stories while paging |
| Both | Correctness | One story per event; reading the same article twice teaches the ranking once |

**Scale.** 50K feeds at a 15-minute median interval is ~56 fetches/s, about three-quarters of them answered `304 Not Modified`. 2M articles/day (~70/s peak) cluster against ~1.2M open stories. 5M daily readers open the feed ~10 times a day, so ~10K requests/s at peak.

"For the full stack, the scale numbers translate into two contract decisions. Ranking is expensive and moves every minute, so the server ranks once per scroll and hands the client an opaque cursor. And 1.2M open stories means clustering needs an index, which I'll show is a banded SimHash."

---

## 🏗️ End-to-End Architecture (8 min)

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

1. **Crawl (1).** Fetch workers lease due feeds and send conditional GETs. New items go through Kafka to cluster workers, which store each article and its story in one transaction, update counters and the breaking flag, and index the article for search.
2. **Feed (2).** The SPA requests a page. The Feed API ranks ~200 candidates once, stores the ranked ids as a snapshot in Redis, and returns a page with an opaque cursor; next pages read the same snapshot. Anonymous feeds are cached at the CDN for 30 s.
3. **Search (3).** Elasticsearch answers when healthy; PostgreSQL full-text search answers when it isn't, and the response says which one did.

| Layer | Choice | Why |
|-------|--------|-----|
| Reader app | SPA with server-rendered anonymous pages; TanStack Query for server state; URL holds topic and query | Public pages need fast first paint and SEO; signed-in pages are dynamic |
| Feed API | Stateless; ranking, snapshots, story pages, search, accounts | Scales horizontally behind the CDN |
| Fetch / cluster workers | Separate pools, Kafka between them | Network-bound vs database-bound; replayable |
| PostgreSQL | Source of truth, SimHash band index | One transaction per article |
| Redis | Sessions, ranking profiles, snapshots | Losing it costs logins and scroll positions, not data |
| Elasticsearch | Search index | Derived; PostgreSQL full-text is the fallback |

### Flow: scrolling past an expired snapshot

```
 Feed page            Query cache               Feed API                  Redis
     │                     │                        │                       │
     │ 1 fetchNextPage()   │                        │                       │
     │────────────────────▶│                        │                       │
     │                     │ 2 GET /feed?cursor=c2  │                       │
     │                     │───────────────────────▶│                       │
     │                     │                        │ 3 GET feed:snap:{id}  │
     │                     │                        │──────────────────────▶│
     │                     │                        │ 4 miss: expired       │
     │                     │                        │◀──────────────────────│
     │                   5 re-rank, keep offset 40  │                       │
     │                     │ 6 page + new cursor    │                       │
     │                     │◀───────────────────────│                       │
     │                     │ 7 drop ids already shown                       │
     │ 8 append, announce  │                        │                       │
     │◀────────────────────│                        │                       │
     │                     │                        │                       │
```

"This is the seam working as designed. The server promises that a cursor's pages never overlap *while its snapshot lives*. When the snapshot is gone, it re-ranks and continues at the same offset. The client promises to drop ids it already shows. Neither side has to be perfect alone."

### Flow: a read teaches the ranking, once

```
Story page                     Feed API                      PostgreSQL    Redis
     │                             │                              │          │
     │ 1 POST /reading-history     │                              │          │
     │────────────────────────────▶│                              │          │
     │                             │ 2 upsert history, inserted?  │          │
     │                             │─────────────────────────────▶│          │
     │                             │ 3 first read only: +weights  │          │
     │                             │─────────────────────────────▶│          │
     │                             │ 4 DEL user:{id}:prefs                   │
     │                             │────────────────────────────────────────▶│
     │ 5 200 (a retry is a no-op)  │                              │          │
     │◀────────────────────────────│                              │          │
     ··························· next fresh feed ·····························
     │                             │ 6 profile miss: reload                  │
     │                             │────────────────────────────────────────▶│
     │                             │                              │          │
```

"The client fires the read with `keepalive`, so it survives the reader leaving the page, and may retry it. The server makes retries harmless: `RETURNING (xmax = 0)` tells a new history row from an upsert, and only a new row changes topic weights. The current scroll keeps its snapshot, so the feed doesn't reshuffle under the reader's thumb. The *next* fresh feed picks up the new weights."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `crawl_schedule` | `source_id`, `next_crawl`, `lease_token`, `etag`, `last_modified`, `consecutive_failures` | The schedule, the lease and the backoff state in one row |
| PostgreSQL | `articles` | `id`, `source_id`, `story_id`, `url` (unique), `title`, `fingerprint`, `published_at`, `topics` | Monthly partitions in production |
| PostgreSQL | `stories` | `id`, `fingerprint`, `fp_band0..3` (generated), `source_count`, `velocity`, `is_breaking`, `breaking_started_at`, `last_article_at` | Four band indexes for candidate lookup |
| PostgreSQL | `user_preferences`, `user_topic_weights`, `user_reading_history` | Unique `(user_id, article_id)` | Explicit and learned interests |
| Redis | `feed:snap:{id}` / `feed:current:{user}` | Ranked ids + scores + owner / newest snapshot id | 15 min / 60 s |
| Redis | `user:{id}:prefs` | Ranking profile | Dropped on preference save and on a first read |

### Client side

| Cache key / store | Holds | Invalidated by |
|-------------------|-------|----------------|
| `['feed', topic]` (infinite query) | Pages of stories + `next_cursor` | Pull-to-refresh, preference save, topic change (new key) |
| `['story', id]` | Story + all coverage | 2-minute stale time |
| `['search', q, filters]` | Results + `engine` | Query change (keyed by the URL) |
| `['prefs']` | Topics, preferred and blocked sources | Save, then invalidate `['feed']` |
| Zustand `session` | User and role | Login, logout, any `401` |

### The contract

```
GET  /api/v1/feed?cursor&limit          → {stories[], next_cursor, has_more}
GET  /api/v1/breaking                   → {stories[]}  flagged in the last 6 h
GET  /api/v1/stories/{id}               → story + articles[]
GET  /api/v1/search?q&topics&date_from  → {articles[], engine}
PUT  /api/v1/user/preferences           → 200 | 400 (source ids must be UUIDs)
POST /api/v1/user/reading-history       → 200 | 404 unknown article; retry-safe
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|-----------------------|----------------------------|
| Opaque `next_cursor` | Pages from one snapshot never overlap or skip; an expired snapshot continues at the same offset | Append pages blindly; only dedupe by id as a backstop |
| `has_more` | False only at the end of the snapshot | Stop the infinite scroll and show "You're all caught up" |
| Snapshot owner check | A cursor works only for the reader who created it | Share URLs freely; cursors stay out of URLs |
| Idempotent read signal | First read only changes weights; dwell is a maximum | Fire with `keepalive`, retry on failure, never track "already sent" |
| `engine` on search | Says whether results came from the fallback | Show "basic results" instead of pretending nothing is wrong |
| Breaking TTL | Stories leave `/breaking` 6 h after being flagged | Render the banner as-is, no client-side expiry logic |
| Validated input | `400` for bad ids, dates, URLs | Map field errors to form fields |

---

## 🔧 Deep Dive 1: An Infinite Feed over a Moving Ranking (8 min)

"The failure I'm designing against: a reader scrolls to page 3 and sees a story they saw on page 1. Or worse, the story that moved up while they were reading never appears at all."

**Why it happens.** The score includes freshness, which halves every six hours, plus velocity and a breaking bonus. All of these change between two page requests. A new breaking story enters at the top and pushes everything down one position. With offset pagination, the last story of page 1 shows up again as the first of page 2. Worse, a story that moved *up* past the page boundary is never shown at all. The client can hide duplicates, but it can't recover a gap.

**Server side.** Page 1 ranks ~200 candidates and stores the ranked ids under a snapshot id for 15 minutes. The cursor is base64url of `{snapshot, offset}`, so pages 2..n are slices of the same frozen list. Hydration reads live rows, so a card's "12 sources" is current even though its position is frozen. A snapshot is only served to its owner. When it expires mid-scroll, the server re-ranks and keeps the offset.

**Client side.** The feed is one infinite query keyed by topic. A sentinel near the bottom calls `fetchNextPage` with the last cursor, and the merge step drops ids already on screen, a backstop for the expired-snapshot case. The list is virtualized, so a reader 300 stories deep still has ~25 cards in the DOM. Scroll position and loaded pages survive navigating to a story and back, because the query cache keeps them.

| Approach | Verdict |
|----------|---------|
| ✅ Server snapshot + opaque cursor + client dedupe | Disjoint pages within a scroll; graceful past expiry |
| ❌ Offset over the live ranking | Duplicates *and* gaps; the client can only fix the duplicates |
| ❌ Client fetches 200 ranked items at once | ~400 KB of JSON before first paint on a phone |
| ❌ Per-user precomputed feed (fan-out) | Millions of rewrites a minute for feeds that are mostly never opened |

"What I give up: the order within one scroll is up to 15 minutes old. That's fine because pull-to-refresh starts a new snapshot, and the breaking banner, not the list, is where urgency lives."

---

## 🔧 Deep Dive 2: The Personalization Loop (7 min)

"Personalization has two inputs: what the reader tells us and what the reader does. Both must reach the ranking quickly and safely, without turning the feed into a monoculture."

**Explicit preferences.** The settings form saves topics and preferred or blocked sources with a `PUT`. The server validates the payload (source ids must be UUIDs), stores it, and invalidates the reader's ranking profile and current snapshot in the same request. The client then invalidates `['feed']`, so the next feed visit ranks with the new preferences right away instead of after a cache TTL. Blocking a source hides stories covered *only* by that source. Stories with other coverage stay, and the blocked outlet just disappears from their source list.

**Implicit signals.** When a signed-in reader opens an article from a story page, the client sends `POST /reading-history` with dwell time, using `keepalive` so a fast tab switch doesn't drop it. The first read of an article adds 0.05 to each of its topics (0.1 if they spent more than a minute), capped at 1. Re-reads and retries change nothing. Without that rule, a flaky network that retries three times would teach the ranking three times as much.

**Keeping it from becoming a filter bubble.** Relevance is only 35% of the score. Freshness (25%), coverage (20%) and velocity (10%) keep major news visible to everyone. After sorting, each story is multiplied by `0.8^n` for the `n` stories of its primary topic above it. It's a penalty, not a quota, so a dominant topic can still lead on a day it deserves to.

| Approach | Verdict |
|----------|---------|
| ✅ Weighted signals + diversity penalty + idempotent learning | Personal, but news still gets through; retries are harmless |
| ❌ Relevance-only ranking | Three tech reads in, the feed converges to one topic within days |
| ❌ Hard per-topic quota | Drops legitimately dominant coverage on a big news day |
| ❌ Counting every read event | Retries and re-opens inflate interests |

"What I give up: learned weights only grow, up to a cap of 1. A reader whose interests change keeps the old ones until I add decay. A nightly `weight × 0.95` is the obvious next step, and so is a 'show me less of this' control that writes a negative weight."

---

## 🔧 Deep Dive 3: From Crawl to Breaking Banner (7 min)

"Freshness is a pipeline. Every stage can add minutes, and the screen should tell the truth about what it knows."

**Crawl.** Fetch workers claim due feeds with `FOR UPDATE SKIP LOCKED`, which pushes `next_crawl` ahead by a lease and stamps a token. A crashed worker's feeds come back on their own, and a stalled worker's late write is fenced off. Conditional GETs make most polls cheap `304`s. Failing feeds back off exponentially, up to a day and never sooner than `Retry-After`, in state that every worker shares. That is how we stay welcome on 50K servers at 56 fetches a second.

**Cluster.** Each article's SimHash fingerprint is split into four 16-bit bands. Any fingerprint within 3 bits shares at least one band, so four indexed lookups find all candidates (~70 instead of 1.2M). Advisory locks on those band buckets make two workers that ingest the AP and Reuters versions at the same moment take turns, so they produce one story, not two.

**Detect.** A story is flagged breaking when three *distinct* sources cover it within 30 minutes, counting by publication time capped at arrival. One chatty outlet, or a new source's backlog, can't trigger it. The flag stays in the breaking feed for six hours.

**Show.** The banner is part of the app shell. Production pushes `story.breaking` events over SSE, which reconnects on its own and resumes with `Last-Event-ID`, so a reader who walks through a tunnel still gets the events they missed. If SSE isn't available, the shell polls `/breaking` every 60 s while the tab is visible. The banner announces new items through a polite live region, not an assertive one, and new stories never jump into the list being read. A "3 new stories" pill appears instead, so nothing shifts under the reader's thumb.

| Approach | Verdict |
|----------|---------|
| ✅ Distinct-source threshold + SSE banner + "new stories" pill | Early, honest, no layout shift |
| ❌ Raw article velocity | One prolific source or a backlog fakes a breaking event |
| ❌ Insert new stories into the visible list | Content jumps; readers lose their place; CLS spikes |
| ❌ WebSocket per reader | A bidirectional channel for a one-way, low-rate stream |

---

## 📈 Failures & Scale (2 min)

| Failure | What the reader sees | What happens |
|---------|----------------------|--------------|
| A publisher is down | Nothing; that outlet's coverage arrives later | Backoff with `Retry-After`; other feeds unaffected |
| Elasticsearch down | Search works with a "basic results" note | PostgreSQL full-text fallback (`engine: postgres`) |
| Redis down | Logged out; a page may repeat a story, which the client hides | Feeds compute without snapshots |
| Snapshot expired mid-scroll | Nothing | Server re-ranks and keeps the offset; client dedupes |
| Read signal lost or retried | Nothing | `keepalive`; the server counts first reads only |
| PostgreSQL down | Error state with retry; cached pages still visible | Replica promotion; crawling buffers in Kafka |

**What breaks first as we grow:** ranking CPU on cold page-1 loads (cache the candidate pool per region and personalize only the scoring), hot story rows during huge events (incremental counters instead of recounts), and snapshot memory in Redis (store 8-byte ids, shorten the TTL).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Feed pagination | Snapshot + opaque cursor + client dedupe | Offset over live ranking | No duplicates or gaps |
| Learning from reads | First read only, `keepalive`, retry-safe | Count every event | Retries can't inflate interests |
| Preference changes | Server and client invalidate together | Wait for TTLs | The next feed reflects the change |
| Diversity | Multiplicative topic penalty | Quotas or none | Variety without hiding big news |
| Crawling | Conditional GET, durable backoff, leases | Re-download, cron per instance | Polite and crash-safe |
| Clustering | SimHash + band index + advisory locks | Linear scan, embeddings | Indexed, cheap, race-free |
| Breaking UI | SSE banner + "new stories" pill | Polling only, inserting into the list | Early and stable |
| Search | Elasticsearch + labeled fallback | ES only | Search survives an outage, honestly |

"With more time I'd add weight decay and a 'less like this' control, embeddings for paraphrased duplicates, and offline reading: cache the last feed and the opened stories in IndexedDB, and queue read signals for when the reader is back online."

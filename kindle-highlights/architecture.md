# Kindle Community Highlights — Architecture

## System Overview

Readers highlight passages on a Kindle, a phone or the web. Each highlight must reach every other device the reader owns, including a Kindle that sat in a drawer for a month. Separately, the platform publishes "1,247 readers highlighted this passage" to everyone reading the same book. Underneath it is a CRUD app, but two problems make it a real design exercise:

1. **Offline-first sync across devices.** Edits happen without a network, on several devices, in any order. The system has to accept retried uploads without duplicates, merge concurrent edits predictably, and propagate deletes to devices that were offline when they happened. A device's cursor must never skip a change.
2. **A public statistic built from private acts.** Counting readers per passage across millions of readers must not put a contended write on every save. The published number must also never identify anyone: a passage highlighted by one reader of a small book is, in effect, that reader's name.

This document describes the production design first. [Implementation Notes](#implementation-notes) maps it onto the local Express + PostgreSQL + Valkey + React build.

**Learning goals**

- A gap-free change feed with a per-user sequence number, so devices sync from a cursor instead of a queue or a timestamp.
- Idempotent uploads with client-generated ids, and field-level last-writer-wins for concurrent edits.
- Tombstones, tombstone retention, and the "your cursor is too old, resync" path.
- Transactional outbox → stream aggregation of *distinct readers*, instead of incrementing a counter row on every save.
- Privacy engineering on an aggregate: consent at write time, a k-anonymity threshold on a passage's *presence*, and enforcement at both publish and serve time.

## Requirements

### Functional requirements

1. **Highlight**: create a highlight on a text range, with a color and an optional note; edit the note, color or visibility; delete it.
2. **Sync**: every change reaches all of the reader's devices, in under 2 seconds when they are online and on reconnect when they are not.
3. **Popular highlights**: per book, the passages most readers highlighted, with the reader count. Also a cross-book "trending" list.
4. **Social**: follow readers and see their highlights in a book. Each highlight's visibility is `private`, `friends` (people you follow who follow you back) or `public`.
5. **Privacy controls**: a default visibility for new highlights and an opt-out from community counts.
6. **Library and export**: per-book lists, keyword search, and export to Markdown, CSV and JSON.

Out of scope: the reading engine itself, shared annotations (book clubs), recommendations, purchases.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Cross-device sync | p95 < 2 s for connected devices | Highlight on the Kindle, pick up the phone, it's there |
| Write acknowledgement | Instant on the device; server ack p99 < 200 ms | Highlighting is a reading gesture; it can't wait on the network |
| Offline window | Incremental catch-up after up to 90 days offline; full resync after that | A Kindle can stay off for a month |
| Durability | An acknowledged highlight is never lost; an unsynced one survives on the device | A lost highlight is a lost thought |
| Popular freshness | Within 5 minutes | Nobody can tell 1,247 from 1,251; this slack pays for the read path |
| Privacy | No passage shown with fewer than k = 10 distinct readers; opt-out effective within minutes | In a small readership a count of 1 identifies a person |
| Availability | 99.9% for reads; writes queue on the device when the service is down | Reading never depends on the server |

## Capacity Estimation

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Readers | 50M monthly, 10M daily, ~2.5 devices each | ~25M devices hold a sync cursor |
| Highlight writes | 10M × 3 per day ≈ 30M/day ≈ 350/s average, ~3,500/s peak | Modest overall; sharded PostgreSQL handles it |
| Hot book | A launch or viral passage: ~1,000 highlights/s on one book | Any per-book counter row would serialize; aggregation must absorb skew |
| Stored highlights | ~10B × ~300 B ≈ 3 TB of rows, ~6 TB with indexes | Shard by `user_id`: every raw-highlight query is user-scoped |
| Connected devices | ~2.5M sockets at the evening peak (10% of devices) | ~50 sync gateways at 50K sockets each |
| Feed pulls | ~25M devices × 6 wakes a day ≈ 150M/day ≈ 1,700/s | Pulls must be one indexed range scan; a gateway restart sends 50K pulls at once |
| Popular reads | One request per book open: 10M × 4 ≈ 40M/day, ~5,000/s peak | 80% hit the top 1% of titles, so a CDN absorbs most of it |
| Aggregation input | ~25% of writes are public and consenting ≈ 90/s average, ~1,000/s peak | Small stream, but skewed onto one partition during a launch |
| Published aggregate | 5M books × ~10 passages ≈ 50M rows ≈ 10 GB | Fits on one replicated database next to the CDN |

The read/write asymmetry is the main fact here. Highlights are written once and read back mostly by their owner, but the published aggregate is read by every reader of the book. That is why the aggregate is computed out of band and served as a precomputed, cacheable document.

### Local Development Scale

Four Express services, one aggregation worker, PostgreSQL and Valkey, sized for a laptop: 12 seeded readers, 3 books, 34 highlights, a handful of sockets. The seed is built so the privacy threshold is visible: three passages clear the local threshold of 5 readers and two stay hidden. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │ Reading apps · Kindle, phone, web · local store, outbox, feed cursor per device      │
  └─────┬─────────────────────┬────────────────────────────▲───────────────────┬─────────┘
        │ (1) POST /sync/push │ (2) GET /sync/changes      │ WSS "changed N"   │ (3) GET popular
        ▼                     ▼                            │                   ▼
  ┌───────────────────────────────────────────┐            │         ┌─────────────────────┐
  │ API gateway · TLS · sessions · rate limit │            │         │ CDN · 60 s per book │
  └─────────────────────┬─────────────────────┘            │         └──────────┬──────────┘
                        ▼                                  │                    ▼ miss
  ┌───────────────────────────────────────────┐  ┌─────────┴────────┐  ┌─────────────────────┐
  │ Highlight API · stateless                 │  │ Sync gateway     │  │ Popular API         │
  │ push · pull · CRUD · library · export     │  │ WebSockets only  │  │ readers ≥ k only    │
  └─────┬────────────────────────┬────────────┘  └─────────▲────────┘  └──────────┬──────────┘
        │ one tx: row + seq      │ PUBLISH user:{id}       │ message              │ SELECT
        │ + outbox row           ▼                         │                      ▼
  ┌─────┴────────────────────┐ ┌───────────────────────────┴──┐        ┌─────────────────────┐
  │ PostgreSQL · by user_id  │ │ Redis · pub/sub              │        │ Popular DB          │
  │ highlights, seqs, outbox │ └──────────────────────────────┘        │ passages ≥ k        │
  └─────┬────────────────────┘                                         └──────────▲──────────┘
        │ outbox relay       ┌────────────────────────┐   ┌───────────────────┐   │ upsert
        └───────────────────▶│ Kafka · highlight      │──▶│ Aggregator        │───┘
                             │ changes, key = book    │   │ distinct readers  │
                             └────────────────────────┘   └───────────────────┘
```

1. **Write (1).** A device pushes its outbox (queued creates, edits and deletes) to the Highlight API. Each operation runs in one transaction: lock the reader's sequence row, write the highlight, stamp it with the next sequence number, and insert an outbox row if a public count can change. After the commit, the API publishes "user U's feed is at seq N" to Redis. The Sync gateway that holds U's other devices relays it as a `changed` poke.
2. **Catch-up (2).** A poked or reconnecting device asks for `changes since <cursor>`. That is one indexed range scan on the reader's shard. It returns the latest state of every changed highlight, tombstones included, plus the new cursor.
3. **Popular (3).** A relay ships outbox rows to Kafka, keyed by book. Aggregator workers keep the set of distinct readers per passage and publish passages with at least k readers to the Popular DB. A device opening a book fetches its passages through the CDN; the Popular API filters by k again.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, session check, routing, per-user rate limits | Requests | Routes `/sync/ws` upgrades to the Sync gateways |
| Highlight API | Push, pull, single-item CRUD, library, search, export jobs | Writes and pulls | Stateless; every write goes through one shared write path |
| Sync gateway | Holds device WebSockets; pokes devices when their feed advances | Connected devices | Connection-only: no business logic, so a crash costs reconnects, not data |
| Redis pub/sub | One channel per user; gateways subscribe for the users they hold | Connected users | A lost message only delays a device until its next pull |
| PostgreSQL (sharded by `user_id`) | Highlights, per-user sequence rows, outbox, follows, privacy settings | Readers | Source of truth for everything a reader owns |
| Kafka `highlight-changes` | Durable, replayable change stream keyed by book | Public changes | Per-book order; new consumers (search indexer) read the same stream |
| Aggregator | Distinct readers per passage, threshold, publish | Books with activity | Stateful (RocksDB-backed state), partitioned by book |
| Popular DB + Popular API + CDN | Serve published passages and trending | Book opens | 10 GB, replicated; the API enforces k again; CDN caches 60 s |

The Social Service (auth, follows, privacy settings, friends' highlights) sits beside the Highlight API and is left out of the diagram. It reads the same shards.

## Core Components / Request Flows

### Writing a highlight and telling the reader's other devices

```
Kindle             Highlight API                   PostgreSQL    Redis    Sync gateway        Phone
   │                     │                              │          │            │               │
   │ 1 POST /sync/push   │                              │          │            │               │
   │────────────────────▶│                              │          │            │               │
   │                     │ 2 lock feed row of U         │          │            │               │
   │                     │─────────────────────────────▶│          │            │               │
   │                     │ 3 insert h1, merge h2        │          │            │               │
   │                     │─────────────────────────────▶│          │            │               │
   │                     │ 4 seq 42-43, outbox, commit  │          │            │               │
   │                     │─────────────────────────────▶│          │            │               │
   │ 5 created, applied  │                              │          │            │               │
   │◀────────────────────│                              │          │            │               │
   │                     │ 6 PUBLISH user:U 43                     │            │               │
   │                     │────────────────────────────────────────▶│            │               │
   │                     │                              │          │ 7 message  │               │
   │                     │                              │          │───────────▶│               │
   │                     │                              │          │            │ 8 changed 43  │
   │                     │                              │          │            │──────────────▶│
   │                     │ 9 GET changes?since=41                                               │
   │                     │◀─────────────────────────────────────────────────────────────────────│
   │                     │ 10 h1, h2, cursor 43                                                 │
   │                     │─────────────────────────────────────────────────────────────────────▶│
   │                     │                              │          │            │               │
```

- **Idempotency.** Highlight ids are UUIDs minted on the device when the reader highlights, so the id *is* the idempotency key. A retried push hits the primary key (`ON CONFLICT (id) DO NOTHING`) and gets the stored row back as `replayed`. Reusing an id for different text is `422`; an id owned by another reader is `409`. Neither leaks the stored row.
- **Sequence numbers.** Step 2 locks the reader's `user_sync_state` row, and steps 3–4 take `last_seq + 1` under that lock. The lock is held until commit, so sequence numbers are handed out in commit order. A device that has seen 43 can never later miss a change that commits as 42. A timestamp cursor or a global sequence would give no such guarantee, because a transaction that started earlier can commit later. The cost is that one reader's writes are serialized, which is harmless at a few writes per minute per reader.
- **Edits** carry the device's clock time per field and merge by field-level last-writer-wins ([Key Design Decisions](#2-field-level-last-writer-wins-with-clamped-device-clocks)). A replay of the same edit is a no-op, so pushing a batch twice consumes no sequence numbers.
- **Fan-out.** Steps 6–8 happen after the commit and are best effort. The Kindle that made the change is not poked, and a poke lost anywhere costs latency, never data.

### Catching up after weeks offline

```
Kindle                            Highlight API                                PostgreSQL
   │                                    │                                           │
   ··················· back online after three weeks in a drawer ····················
   │ 1 POST /sync/push (14 queued ops)  │                                           │
   │───────────────────────────────────▶│                                           │
   │ 2 one result per op                │                                           │
   │◀───────────────────────────────────│                                           │
   │ 3 GET /sync/changes?since=40       │                                           │
   │───────────────────────────────────▶│                                           │
   │                                    │ 4 one snapshot: last_seq, purged_through  │
   │                                    │──────────────────────────────────────────▶│
   │                                    │ 5 rows WHERE seq > 40 LIMIT 200           │
   │                                    │──────────────────────────────────────────▶│
   │ 6 200 rows, cursor 251, hasMore    │                                           │
   │◀───────────────────────────────────│                                           │
   │ 7 apply rows and tombstones, save 251                                          │
   │ 8 GET /sync/changes?since=251      │                                           │
   │───────────────────────────────────▶│                                           │
   │ 9 17 rows, cursor 268, done        │                                           │
   │◀───────────────────────────────────│                                           │
   │                                    │                                           │
```

- The device pushes before it pulls, so its own offline edits are merged first and come back in the pull with their final state.
- The feed returns **state, not operations**: each row holds only its latest change. A highlight edited 30 times while the Kindle was away arrives once.
- The cursor and the rows are read in one `REPEATABLE READ` snapshot. A cursor of `last_seq` therefore never runs ahead of the rows the device actually received.
- **Tombstones and resync.** Deletes leave a tombstone row (content wiped, `deleted_at` set) that flows through the feed like any change. Tombstones are reaped after 90 days, and the reaper records `purged_through_seq`. A device whose cursor is below that mark could miss a delete and resurrect the highlight, so it gets `resync: true`, discards its local copies and pulls from zero. A cursor ahead of `last_seq` (a restored database) is treated the same way.

### Counting readers and serving popular passages

```
 Highlight API            PostgreSQL                Kafka            Aggregator           Popular DB
       │                       │                      │                   │                    │
       │ 1 row + outbox, 1 tx  │                      │                   │                    │
       │──────────────────────▶│                      │                   │                    │
       │                       │ 2 relay, key = book  │                   │                    │
       │                       │─────────────────────▶│                   │                    │
       │                       │                      │ 3 poll batch      │                    │
       │                       │                      │◀──────────────────│                    │
       │                       │        4 add/remove reader in set(B, P)  │                    │
       │                     5 every 60 s: keep passages with k+ readers  │                    │
       │                       │                      │                   │ 6 upsert passages  │
       │                       │                      │                   │───────────────────▶│
       │                       │                      │ 7 commit offsets  │                    │
       │                       │                      │◀──────────────────│                    │
       │                       │                      │                   │                    │
```

1. The outbox row is written in the same transaction as the highlight change and carries the highlight's current contribution: `(book, reader, highlight, sync_seq, counted range or NULL)`. NULL means "not counted", which covers private, friends-only, deleted, or a reader who opted out. The writer decides eligibility, so the aggregator never reads privacy settings.
2. Kafka partitions by book: all events of a book reach one aggregator, in order.
3. The aggregator keeps, per (book, reader), which passages that reader's highlights cover. Each passage has a set of reader ids. Because events are **state-based and carry `sync_seq`**, a replayed or reordered event is ignored when its sequence is not newer, so at-least-once delivery yields exact counts. A reader with two highlights on one passage is still one reader.
4. Every 60 seconds the aggregator republishes the books that changed, writing only passages with at least k = 10 readers. Sub-threshold counts never leave the aggregator's state.
5. Offsets are committed after the upsert. A crash replays events, which step 3 makes harmless.

**Reading** is one request per book open: `GET /books/{id}/popular` through the CDN (60 s TTL) to the Popular API, which re-checks the threshold and reads the Popular DB through an in-process cache. A bestseller's passages are one cache entry on every API instance, not one Redis key everyone hammers. **Trending** ranks passages by readers gained in the last 1, 7 or 30 days, from per-hour reader buckets the aggregator keeps alongside the sets. **Nightly**, a batch job recomputes every book from the source of truth and compares: drift above zero is an alert, because it means events were lost.

### Friends' highlights

"What did people I follow highlight in this book" is computed at read time. The query takes my followees (a few hundred), groups them by shard and asks each shard for `book_id = B AND deleted_at IS NULL`. A highlight is returned if it is `public`, or `friends` and the owner follows me back. Follows are sharded by follower, so the "do they follow me back" check sits on the owner's shard next to their highlights. It is not precomputed: one row of a "visible to user X" view serves exactly one reader, and every follow, unfollow or visibility change would invalidate slices of it. A stale privacy filter is a leak, not a lag.

## Database Schema

### Production schema

Every table a reader owns is sharded by `user_id`, so all of a reader's writes, their sequence row and their outbox rows commit on one shard in one transaction.

```sql
-- One row per reader: the change-feed counter. Every write of this reader locks it.
CREATE TABLE user_sync_state (
  user_id            UUID PRIMARY KEY,
  last_seq           BIGINT NOT NULL DEFAULT 0,
  purged_through_seq BIGINT NOT NULL DEFAULT 0      -- tombstones at or below were reaped
);

CREATE TABLE highlights (
  user_id          UUID        NOT NULL,             -- shard key
  id               UUID        NOT NULL,             -- minted on the device: the idempotency key
  book_id          UUID        NOT NULL,
  location_start   INTEGER     NOT NULL,
  location_end     INTEGER     NOT NULL CHECK (location_end >= location_start),
  highlighted_text TEXT        NOT NULL,             -- wiped on delete
  note             TEXT,
  color            TEXT        NOT NULL DEFAULT 'yellow',
  visibility       TEXT        NOT NULL DEFAULT 'private'
                   CHECK (visibility IN ('private', 'friends', 'public')),
  sync_seq         BIGINT      NOT NULL,             -- latest change's position in the feed
  field_clock      JSONB       NOT NULL,             -- {field: {ts, device}} for last-writer-wins
  deleted_at       TIMESTAMPTZ,                      -- tombstone
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX highlights_feed    ON highlights (user_id, sync_seq);                 -- pull
CREATE INDEX highlights_by_book ON highlights (user_id, book_id, location_start);  -- book view, friends

-- Transactional outbox, relayed to Kafka (key = book_id) and deleted after the relay.
CREATE TABLE outbox (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       UUID        NOT NULL,
  highlight_id  UUID        NOT NULL,
  book_id       UUID        NOT NULL,
  sync_seq      BIGINT      NOT NULL,                -- lets the aggregator drop stale events
  counted_range INT4RANGE,                           -- NULL = not counted
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE follows (                               -- sharded by follower_id
  follower_id UUID NOT NULL,
  followee_id UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE privacy_settings (
  user_id                UUID    PRIMARY KEY,
  default_visibility     TEXT    NOT NULL DEFAULT 'private',
  include_in_aggregation BOOLEAN NOT NULL DEFAULT true,
  allow_followers        BOOLEAN NOT NULL DEFAULT true
);
```

The published aggregate lives in its own small, replicated database. The threshold is part of the schema, so even a buggy writer cannot publish a small count:

```sql
CREATE TABLE popular_passages (
  book_id        UUID        NOT NULL,
  passage_id     INTEGER     NOT NULL,               -- first sentence index of the passage
  passage_text   TEXT        NOT NULL,
  reader_count   INTEGER     NOT NULL CHECK (reader_count >= 10),
  location_start INTEGER     NOT NULL,
  location_end   INTEGER     NOT NULL,
  last_reader_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (book_id, passage_id)
);
CREATE INDEX popular_by_book ON popular_passages (book_id, reader_count DESC);
```

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql), applied by `npm run db:migrate`. It is re-runnable, and its upgrade blocks migrate databases created by older versions of the file.

| Production | Local | Difference |
|------------|-------|------------|
| `highlights`, PK `(user_id, id)` | `highlights`, PK `id`, same sync columns | One unsharded database; `id` is globally unique |
| `user_sync_state` | Same | — |
| `outbox` relayed to Kafka | `aggregation_outbox (book_id, reason)` | Marks a book "needs a recount"; the worker recomputes the whole book |
| Aggregator state (reader sets) | None | Recomputed from `highlights` per recount |
| `popular_passages` (sentences, `CHECK >= 10`) | `popular_highlights` (100-location windows, `reader_count`, `last_contribution_at`) | Same database; threshold enforced by the worker and the API, default 5 |
| `follows`, `privacy_settings` | `follows`, `user_privacy_settings` | Same meaning |
| — | `highlight_shares`, `books`, `user_books`, `users`, `sessions` | `sessions` is unused (sessions live in Redis) |

## API Design

### Production API

```
POST   /api/v1/sync/push                    {ops[]} + X-Device-Id → one result per op
GET    /api/v1/sync/changes?since&limit     → {changes, cursor, hasMore, resync}
WSS    /api/v1/sync/ws                      hello {token, deviceId} → welcome {latestSeq}, changed {seq}
POST   /api/v1/highlights                   client id (or Idempotency-Key) → 201 | 200 replay | 409 | 422
PATCH  /api/v1/highlights/{id}              note | color | visibility, clientUpdatedAt → 200 | 410 gone
DELETE /api/v1/highlights/{id}              → 204, also when already deleted | 404
GET    /api/v1/highlights?bookId&q&cursor   my highlights, keyset-paginated
GET    /api/v1/books/{id}/popular?limit     passages with ≥ k readers, CDN-cacheable
GET    /api/v1/trending?days=1|7|30         passages that gained readers in the window
GET    /api/v1/books/{id}/friends-highlights  public + mutual-friend highlights of people I follow
PATCH  /api/v1/settings/privacy             default visibility, include_in_aggregation
POST   /api/v1/exports                      202 + job id; the file arrives as a link
```

- **Push results are final per operation**: `created`, `replayed`, `applied`, `superseded` (a newer edit won), `unchanged` (a replay), `deleted`, `gone` (already a tombstone), `not_found`, `rejected` (invalid). One invalid operation never blocks the batch, and the device drops it instead of retrying forever.
- **`minCount` can only raise the threshold.** The server takes `max(k, minCount)`.
- **The token travels in the WebSocket's first message**, not the URL, so it never lands in proxy logs.

### Local routes

| Service (port) | Routes |
|----------------|--------|
| Highlight (3000) | `POST/GET /api/highlights`, `GET/PATCH/DELETE /api/highlights/:id`, `GET /api/library`, `GET /api/export/highlights?format=` |
| Social (3001) | `/api/auth/register`, `/login`, `/logout`, `/me`; `POST/DELETE /api/users/:id/follow`; `GET /api/following`, `/api/followers`; `GET /api/books/:id/friends-highlights`; `POST /api/highlights/:id/share`; `GET/PATCH /api/settings/privacy`; `GET /api/users/:id`, `/api/users/:id/highlights` |
| Sync (3002) | `GET /api/sync/changes`, `POST /api/sync/push`, WebSocket `/api/sync/ws` |
| Aggregation (3003) | `GET /api/books/:id/popular`, `/heatmap`, `/count`; `GET /api/trending`; `GET /health` (outbox lag, worker heartbeat) |

The Vite dev server proxies each path to its owning service ([`frontend/vite.config.ts`](./frontend/vite.config.ts)).

## Key Design Decisions

### 1. A per-user sequence number as the sync cursor

Each device stores one number: the highest `sync_seq` it has applied. The alternatives each break in a specific way. **Timestamps** (`updated_at > lastSync`) skip late commits: a transaction stamped 10:00:00.100 that commits after one stamped 10:00:00.200 is invisible to a device that already advanced past .200, and device and server clocks disagree. **Per-device queues** in Redis are a second copy of the truth that must be written for every offline device, expire, and can be lost on failover; they were also dead weight here because the feed already holds the same changes. **A global sequence** has the same late-commit gap as timestamps. Taking `last_seq + 1` under the reader's row lock costs one row lock per write, and readers write a few times a minute, so the contention is nil. It makes the feed gap-free by construction. The cost is a hot row per *reader*, never per book, which is why it fits this workload and would not fit a shared document.

### 2. Field-level last-writer-wins with clamped device clocks

A highlight has exactly one owner, so the only conflict is the same reader editing it on two devices before they sync. Each mutable field (`note`, `color`, `visibility`) stores the stamp of the edit that set it, `{ts, device}`. An incoming edit wins a field only if its stamp is newer, and ties go to the higher device id, so every replica picks the same winner. Edits to different fields both survive. A device whose clock reads next year would win every conflict forever, so the server clamps device time to `now + 5 minutes`. **Deletes win**: a tombstoned highlight accepts no edits, so a note typed offline cannot resurrect a highlight deleted on another device.

**Rejected**: *CRDTs or OT* solve concurrent multi-writer editing, a problem single-owner data doesn't have, at the price of merge metadata on 10B rows and identical merge code on every client including e-ink firmware. *`If-Match`/`412` optimistic concurrency* works for online clients but not offline ones: a Kindle replaying a week of edits can't stop and ask the reader to resolve each `412`. **What we give up**: a concurrent edit to the same field is silently lost to the newer one. For a highlight note that's survivable, and the device can show "a newer edit from another device was kept". If the product added shared annotations, this decision would flip.

### 3. Outbox → stream aggregation of distinct readers, not a counter per save

Incrementing `popular.count = count + 1` on each save fails twice. First, the count is the indexed column the top-N query sorts by, so every increment is a non-HOT update: a new tuple version, an index entry, and vacuum debt, concentrated on a few rows per hot book. Second, the average rate hides the skew: a launch puts ~1,000 writes/s on one book's handful of rows, and they serialize on row locks exactly when the feature is most visible. Recomputing on read (`GROUP BY` over a book's highlights per request) is worse, since one bestseller would scan millions of rows per book open. The outbox makes the change event part of the write transaction, so it can't be lost between commit and publish. Kafka partitioned by book gives each book one ordered consumer. State-based events keyed by highlight make replays harmless and the count exact, and they count *readers*, not highlights. **What we give up**: popular counts lag by up to a minute or two, and the aggregator holds state (~10 GB of reader sets) that must be checkpointed and rebuilt by the nightly job.

### 4. Privacy is enforced where data enters and where it leaves

- **Consent at write time.** Only `public` highlights of readers who haven't opted out produce a counted contribution. An opted-out reader's highlights never enter the stream, so no later bug can leak them. Opting out emits "not counted" events for all of the reader's public highlights, which the next aggregation removes.
- **The threshold applies to presence, not just the number.** Showing a passage with its count hidden still says "somebody here highlighted this", and in a 40-reader book that is the leak. Below k the passage does not exist in any public response. The price: small books never get community highlights. That's the feature working, not a bug.
- **Twice.** The aggregator only publishes passages with at least k readers (and the Popular DB's `CHECK` rejects smaller counts); the API filters again, and `minCount` can only raise k.
- **Aggregates are never attributed.** The pipeline stores passage → readers, but publishes only counts. Friends' highlights, the attributed surface, is a separate query with its own rule: `friends` means a mutual follow, because following is one-sided and needs no approval.
- **No differential privacy.** Counts are displayed exactly and prominently, and noise hurts most in the low-count tail, which is exactly where the threshold already gives a hard guarantee. Sub-threshold state is still sensitive: no debug endpoint dumps a book's raw passage sets.

### 5. Passages anchored to sentences

Two readers never select the same characters. Exact `(start, end)` grouping splits one famous sentence into thousands of passages with a count of 1 each. Fixed location windows are cheap but systematically undercount sentences that straddle a window boundary. Retuning the window size only moves which sentences lose. We own the book text, so production anchors highlights to sentences: a highlight counts toward each sentence it covers at least half of, and adjacent sentences with similar reader sets are displayed as one passage. The aggregator loads each book's sentence offsets, a few KB per book. Locally there is no book text, so the worker uses 100-location windows and the seed shows the fragmentation (`"Victory Mansions"` lands in `200-300` while a longer selection ending at the same words lands in `100-300`).

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Create | At most one highlight per client id, even under concurrent retries | Client-generated id + `ON CONFLICT (id) DO NOTHING`; replay returns the stored row; `422` on reused id with different text |
| Edit | Deterministic convergence across devices | Field-level stamps, clamped clocks, device-id tie-break; replays are `unchanged` |
| Delete | Reaches every device; never resurrected | Tombstone row in the feed; edits to tombstones answer `gone`; replayed creates return the tombstone |
| Feed | Gap-free, per reader, in commit order | `last_seq + 1` under the reader's row lock; cursor and rows from one snapshot |
| Old cursor | No silent missed deletes | `purged_through_seq`; below it → `resync: true` |
| Popular count | Exactly the distinct consenting readers, eventually | Outbox in the write transaction; state-based events with `sync_seq`; offsets committed after publish; nightly recompute |
| Cache | At most one TTL stale | Popular entries are invalidated after each republish; CDN 60 s; a racing refill can cache an old list for one TTL, which the freshness target allows |

## Security / Auth

- **Authentication**: sessions in Redis behind an `HttpOnly`, `Secure`, `SameSite=Lax` cookie for the web app and a bearer token for devices; revocable instantly. Passwords hashed with a salted, memory-hard KDF (scrypt or Argon2id).
- **Authorization**: every highlight query is scoped by `user_id` from the session, never from the request. Ids from clients only ever select within the caller's rows, and a foreign id answers `409` without revealing the row.
- **Visibility**: one query helper implements private / friends (mutual follow) / public for every read of someone else's highlights. Public profile endpoints return explicit columns, so sync metadata such as device ids in `field_clock` is never exposed.
- **Rate limits** (Redis token buckets): highlight writes 100/min per reader (a human can't highlight faster), auth 5/min per IP, follows 60/hour, exports 10/hour. The write limit is also the first defense against inflating a passage's count.
- **Abuse**: counts come only from accounts with plausible reading progress in the book, and velocity anomalies on one passage are reviewed before they publish.

## Observability

- **Sync**: create-to-poke latency (the 2 s SLO), pull latency and page size, resync rate (should be near zero), pushed-op status mix (a rising `rejected` share means a client bug), socket count and reconnect rate per gateway.
- **Aggregation**: outbox relay lag and Kafka consumer lag (= popular-count staleness), events skipped as stale, publish cycle time against its 60 s budget, nightly recompute drift (must be zero), passages suppressed by the threshold.
- **Liveness vs progress**: a worker can be alive and idle. The aggregator writes a heartbeat after every cycle, and readiness fails if it is older than three cycles or the outbox's oldest row is older than five minutes.
- **Tracing**: one id per pushed operation follows it from the device through the write, the outbox, Kafka and the poke, so "my highlight didn't reach my phone" is answerable.

## Failure Handling

| Failure | Effect | Mitigation |
|---------|--------|------------|
| Device offline | Writes queue locally | Outbox + idempotent push on reconnect; nothing depends on the server to keep reading |
| Response lost after commit | Device retries | Client id makes the retry a replay |
| Sync gateway crash | 50K sockets drop | Clients reconnect with exponential backoff and jitter, then pull from their cursor; pulls are cheap range scans |
| Redis pub/sub down | No pokes | Devices still pull on reconnect, app foreground and periodically (every 5 min) |
| Shard primary down | Writes for its readers fail | Devices keep queueing; replica promotion; reads of other shards unaffected |
| Kafka or aggregator down | Popular counts freeze | Outbox rows accumulate in PostgreSQL, so nothing is lost; serving continues from the Popular DB |
| Poison operation in a push | One op can never succeed | Rejected individually with a reason; the device drops it; the rest of the batch applies |
| Hot book | One partition and one cache key run hot | One consumer handles ~1,000 events/s; reads are served by the CDN and in-process caches |

## Scalability Considerations

1. **Raw highlights shard by `user_id`.** Every raw-highlight query is user-scoped: my library, my book, my search, my feed. The one cross-user query, counting readers per passage, is precomputed by the aggregator, and that is what makes `user_id` a viable shard key.
2. **Sync gateways scale with sockets** (~50K each). A reader's devices may land on different gateways; per-user Redis channels route pokes, and each gateway subscribes only for the users it holds. Plan for the reconnect storm, not the steady state.
3. **The aggregator scales by Kafka partitions.** A single hot book stays on one partition. Its state is small (one book's reader sets), so one consumer is enough, and the 60 s publish cycle batches its writes.
4. **Popular reads** are a cacheable document per book: CDN, then an in-process cache on each Popular API instance, then a 10 GB replicated database.
5. **Search** moves to OpenSearch indexes per user cohort, fed from the same Kafka stream, and stays user-scoped.
6. **Storage tiering**, never deletion: old highlights are rarely read but never garbage. Only tombstones expire.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Sync cursor | Per-user sequence under a row lock | Timestamps, per-device queues | Gap-free in commit order; one source of truth |
| Feed content | Latest state per changed highlight | Operation log | A device offline for a month receives each highlight once |
| Upload idempotency | Client-generated highlight id | Server ids + dedupe by body | Retries replay; a reader may highlight the same words twice |
| Conflicts | Field-level LWW, clamped clocks, delete wins | CRDT/OT, `If-Match` + `412` | Single-owner data; offline devices can't resolve 412s |
| Deletes | Tombstones, 90-day retention, resync below | Hard delete | Prevents resurrection by long-offline devices |
| Live updates | WebSocket poke, then HTTP pull | Push payloads, polling | A lost poke costs latency only; polling 25M devices to say "nothing new" |
| Counting | Outbox → Kafka → distinct-reader sets | Counter per save, recompute on read | No hot rows or index churn; exact under replay |
| Passage grouping | Sentence-anchored | Exact ranges, fixed windows | We own the text; windows undercount boundary sentences |
| Privacy | Consent at write; k on presence; publish + serve | Read-time filter, hide only the number | Opted-out data never enters; presence is the disclosure |
| Friends' highlights | Read-time query, mutual follow | Materialized per-viewer view | One row would serve one reader; stale privacy is a leak |
| Shard key | `user_id` | `book_id` | All raw reads are user-scoped; cross-user counts are precomputed |

## Implementation Notes

### What runs locally

| Process | Port | Code |
|---------|------|------|
| Highlight service | 3000 | [`backend/src/highlight/app.ts`](./backend/src/highlight/app.ts) |
| Social service | 3001 (the `PORT` the screenshot harness waits on) | [`backend/src/social/app.ts`](./backend/src/social/app.ts) |
| Sync service: pull, push, WebSocket | 3002 | [`backend/src/sync/app.ts`](./backend/src/sync/app.ts) |
| Aggregation API | 3003 | [`backend/src/aggregation/app.ts`](./backend/src/aggregation/app.ts) |
| Aggregation worker | — | [`backend/src/aggregation/worker.ts`](./backend/src/aggregation/worker.ts) |
| PostgreSQL 16, Valkey 7 | 5432, 6379 | [`docker-compose.yml`](./docker-compose.yml) |
| React SPA (Vite proxy routes each path to its service) | 5173 | [`frontend/`](./frontend/) |

### Production patterns implemented

- **One write path with a gap-free feed** ([`shared/highlights.ts`](./backend/src/shared/highlights.ts)). REST writes and offline pushes both go through `createHighlight`, `updateHighlight` and `deleteHighlight`. Each locks the reader's `user_sync_state` row first and stamps the row with the next sequence number in the same transaction:

  ```ts
  await client.query('INSERT INTO user_sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId])
  const result = await client.query<{ last_seq: number }>(
    'SELECT last_seq FROM user_sync_state WHERE user_id = $1 FOR UPDATE',
    [userId]
  )
  ```

  Creates use the client's id with `ON CONFLICT (id) DO NOTHING`; a replay consumes no sequence number and enqueues no recount. `changesSince` reads the cursor and the rows in one `REPEATABLE READ READ ONLY` transaction and answers `resync` below `purged_through_seq`.
- **Field-level last-writer-wins** ([`shared/lww.ts`](./backend/src/shared/lww.ts)): per-field `{ts, device}` stamps, device clocks clamped to server time + 5 minutes, device-id tie-break, replays reported as `unchanged`, deletes final.
- **Batched push with per-operation results** ([`sync/app.ts`](./backend/src/sync/app.ts)): up to 100 operations, one transaction each; invalid operations and `409`/`422` outcomes are `rejected` individually; one Redis publish per batch.
- **WebSocket pokes across processes**: first-message authentication (`hello` within 5 s, else close `4001`), per-user Redis `SUBSCRIBE` on the first socket of a reader and `UNSUBSCRIBE` on the last, the origin device skipped, ping every 30 s with dead sockets terminated ([`shared/notify.ts`](./backend/src/shared/notify.ts)).
- **Transactional outbox + recount worker** ([`aggregation/worker.ts`](./backend/src/aggregation/worker.ts)). Any change that can move a public count inserts an `aggregation_outbox` row in its transaction. The worker drains one book per transaction:

  ```
  Worker                                    PostgreSQL    Redis
     │                                           │          │
     │ 1 oldest outbox row, SKIP LOCKED: book B  │          │
     │──────────────────────────────────────────▶│          │
     │ 2 advisory lock on B                      │          │
     │──────────────────────────────────────────▶│          │
     │ 3 DELETE B's outbox rows                  │          │
     │──────────────────────────────────────────▶│          │
     │ 4 public, consenting highlights of B      │          │
     │──────────────────────────────────────────▶│          │
     │ 5 count distinct readers per passage      │          │
     │ 6 replace rows with k+ readers; COMMIT    │          │
     │──────────────────────────────────────────▶│          │
     │ 7 DEL popular:B, heatmap:B                           │
     │─────────────────────────────────────────────────────▶│
     │                                           │          │
  ```

  The claim uses `FOR UPDATE SKIP LOCKED` so several workers share the outbox. The per-book advisory lock stops an older snapshot from overwriting a newer one. Deleting the outbox rows *before* reading highlights guarantees that every consumed row's change is visible to the read. [`shared/passage.ts`](./backend/src/shared/passage.ts) counts distinct readers and drops sub-threshold passages before anything is written. Every 6 hours the worker requeues all books (reconcile), and every hour it reaps tombstones older than 90 days.
- **Privacy threshold everywhere** ([`shared/privacy.ts`](./backend/src/shared/privacy.ts)): `POPULAR_MIN_READERS` (default 5, never below 2) applies to popular, trending, heatmap and count; `minCount` only raises it. Friends' highlights check each highlight's own visibility and a mutual follow. Consent changes enqueue a recount of the reader's books in the same transaction.
- **Operational basics**: salted scrypt password hashes with transparent upgrade of legacy SHA-256 hashes on login ([`shared/password.ts`](./backend/src/shared/password.ts)); server-side logout; boundary validation returning 4xx instead of 500 ([`shared/validation.ts`](./backend/src/shared/validation.ts), [`shared/errors.ts`](./backend/src/shared/errors.ts)); graceful shutdown that stops accepting, drains and closes pools ([`shared/lifecycle.ts`](./backend/src/shared/lifecycle.ts)); `GET /health` on the aggregation API reports outbox backlog and the worker's heartbeat age; cache-aside with TTL jitter for popular, trending and heatmap.
- **Web client as a device**: [`frontend/src/sync/outbox.ts`](./frontend/src/sync/outbox.ts) queues note edits and deletes in `localStorage`, shows them immediately and pushes them single-flight on the next flush. [`frontend/src/sync/useSyncChannel.ts`](./frontend/src/sync/useSyncChannel.ts) keeps one socket with exponential backoff and jitter, flushes the outbox on every `welcome` and `online` event, and pages refetch in the background when another device writes.
- **Tests**: `npm test` runs 46 vitest tests (merge rules, passage aggregation, validation, password hashing, and endpoint tests with mocked shared modules for the threshold, push batches and idempotent create).

### Simplified or substituted

- One unsharded PostgreSQL; the outbox marks books dirty and the worker **recomputes the whole book** from `highlights`. That is exact and idempotent, but its cost grows with a book's public highlights. Production replaces it with Kafka and incremental reader sets and keeps the recompute as the nightly check.
- 100-location windows instead of sentence anchoring (no book text is stored).
- The sync service serves pull and push next to its sockets; production keeps gateways connection-only.
- The web client refetches the visible lists after a poke instead of applying the feed to an IndexedDB store. It has no create-highlight UI, so highlights come from the seed or the API, and its outbox is cleared on logout.
- Trending ranks published passages that gained a reader in the window by total readers, rather than by readers gained.
- The Vite dev proxy plays the API gateway. Sessions live only in Redis, and the web app keeps the bearer token in `localStorage` rather than an `HttpOnly` cookie.

### Omitted

Kafka, the CDN, sharding, OpenSearch (search is `ILIKE` with `OFFSET` paging), rate limiting, Prometheus metrics, circuit breakers, async export jobs, multi-region deployment, and counter-fraud detection.

### Known limitations

- Device clocks are clamped but not hybrid logical clocks, so a slow clock loses same-field conflicts it should win.
- The schema upgrade that numbers pre-existing rows into the feed must run with the services stopped.
- Popular-list cache invalidation can race a concurrent refill and serve the previous list for one TTL (5 minutes).
- Login does not equalize timing for unknown emails, and there is no lockout.

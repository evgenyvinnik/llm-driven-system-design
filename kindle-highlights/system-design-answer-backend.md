# 📚 Kindle Community Highlights — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "This looks like CRUD with a counter bolted on, and both halves are harder than they look. Readers highlight on a Kindle, a phone and the web, often offline, so I need a sync protocol where retries never duplicate, concurrent edits converge, and a Kindle that wakes up after a month neither misses a delete nor resurrects one. And 'Popular Highlights' publishes a statistic built from millions of private acts: it has to count distinct readers through launch-day skew without a hot row, and it must never let a count identify a person."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and why reads and writes are different problems |
| High-level architecture | 10 min | One overview and the three core flows |
| Data model & API | 6 min | What lives where; the sync contract |
| Deep dive 1: sync | 9 min | Cursor, idempotency, conflicts, tombstones |
| Deep dive 2: counting readers | 8 min | Outbox → stream aggregation of distinct readers |
| Deep dive 3: privacy | 5 min | When a count becomes an identifier |
| Scale, failures, wrap-up | 2 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope first, because the offline story changes everything downstream."

### Functional requirements

1. **Highlight** a text range with a color and an optional note; edit note, color or visibility; delete.
2. **Sync** every change to all of the reader's devices: within 2 seconds when they're online, on reconnect when they're not, including after weeks offline.
3. **Popular highlights** per book ("1,247 readers highlighted this") and a cross-book trending list.
4. **Social**: follow readers and see their highlights in a book. Each highlight is `private`, `friends` or `public`.
5. **Privacy controls**: a default visibility and an opt-out from community counts.
6. **Library, search, export** (Markdown, CSV, JSON).

Out of scope: the reading engine, shared annotations (book clubs), recommendations.

Two questions I'd ask up front. *Is the aggregate opt-in or opt-out?* I'll assume public highlights count unless the reader opts out, and I'll treat consent as a gate on the data, not a filter on the display. *Do we own the book text?* Yes, and it matters for what counts as "the same passage".

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Cross-device sync | p95 < 2 s for connected devices | Highlight on the Kindle, pick up the phone, it's there |
| Write ack | Instant locally; server p99 < 200 ms | Highlighting is a reading gesture |
| Offline window | Incremental catch-up up to 90 days; full resync beyond | A Kindle can sit in a drawer for a month |
| Durability | Never lose an acknowledged highlight; never resurrect a deleted one | A lost highlight is a lost thought |
| Popular freshness | Within 5 minutes | Nobody can tell 1,247 from 1,251 |
| Privacy | No passage shown with fewer than k = 10 distinct readers | A count of 1 in a small book is a name |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Readers | 50M monthly, 10M daily, ~2.5 devices each | ~25M sync cursors |
| Highlight writes | ~30M/day ≈ 350/s average, ~3,500/s peak | Modest; sharded PostgreSQL is enough |
| Hot book | ~1,000 highlights/s on one title at a launch | No per-book row may be written per save |
| Stored highlights | ~10B × 300 B ≈ 3 TB of rows | Shard by `user_id` |
| Connected devices | ~2.5M sockets at the evening peak | ~50 gateways at 50K sockets each |
| Feed pulls | ~150M/day ≈ 1,700/s; 50K at once after a gateway restart | A pull must be one index range scan |
| Popular reads | ~40M book opens/day, ~5,000/s peak, heavily skewed | A cacheable document per book behind a CDN |

"Two facts drive the design. Writes are user-scoped and modest, so the write path is about *correctness*, not throughput. The aggregate is read by every reader of a book and skewed toward bestsellers, so it must be precomputed and cached, never computed on a read."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk the three journeys: a device pushes changes, a device catches up, and a public highlight becomes a published count."

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

1. **Write (1).** A device pushes its outbox: creates, edits and deletes it queued locally. The Highlight API runs each operation in one transaction (lock the reader's sequence row, write, stamp the next sequence number, add an outbox row if a public count can change), then publishes "user U is at seq N" to Redis. The gateway holding U's other devices pokes them.
2. **Catch-up (2).** A poked or reconnecting device asks for `changes since <cursor>`: one index range scan on the reader's shard, returning the latest state of every changed highlight, tombstones included.
3. **Popular (3).** A relay ships outbox rows to Kafka, keyed by book. Aggregators keep distinct readers per passage and publish passages with at least k readers. Devices fetch a book's passages through the CDN; the Popular API checks k again.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, sessions, routing, rate limits | Requests | Routes socket upgrades to gateways |
| Highlight API | Push, pull, single-item CRUD, library, export jobs | Writes and pulls | Stateless; one shared write path |
| Sync gateway | Holds WebSockets, pokes devices | Connected devices | No business logic; a crash costs reconnects, not data |
| Redis pub/sub | One channel per reader | Online readers | A lost message only delays a pull |
| PostgreSQL by `user_id` | Highlights, sequence rows, outbox, follows, settings | Readers | Source of truth |
| Kafka | Replayable change stream, keyed by book | Public changes | Per-book order |
| Aggregator | Distinct readers per passage; publish ≥ k | Active books | Stateful, partitioned by book |
| Popular DB, API, CDN | Serve published passages and trending | Book opens | ~10 GB, replicated |

"Why split the gateway from the API? Sockets are stateful and long-lived, requests are stateless and short. Keeping business logic out of the gateway means a gateway crash costs 50K reconnects and nothing else, and API deploys don't drop 2.5M sockets. Auth, follows and privacy settings live in a Social Service beside the API; I've left it off the diagram."

### Flow 1: a device pushes, the other devices hear about it

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

"Step 2 is the heart of the sync design. Every write first locks the reader's `user_sync_state` row and takes `last_seq + 1` under that lock, so sequence numbers are handed out in commit order. Step 3 is idempotent by construction: `h1`'s id was minted on the Kindle, so a retried push hits the primary key and gets the stored row back. The commit happens before the publish in step 6, and the poke is a hint: if it's lost, the phone still catches up on its next pull."

### Flow 2: catching up after three weeks in a drawer

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

"The device pushes before it pulls, so its own offline edits are merged first. The feed returns state, not operations: a highlight edited 30 times while the Kindle slept arrives once, in its latest form. The cursor and the rows come from one snapshot, so the cursor never runs ahead of what the device received."

### Flow 3: from a public highlight to a published count

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

"The outbox row commits with the highlight, so the event can't be lost between commit and publish, which is the classic dual-write bug. The aggregator commits Kafka offsets only after the upsert, so a crash replays events. Step 4 makes replays harmless, as I'll show in deep dive 2."

---

## 💾 Data Model (4 min)

"Everything a reader owns is sharded by `user_id`, so a write, its sequence row and its outbox row commit on one shard in one transaction."

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `user_sync_state` | `user_id` (PK), `last_seq`, `purged_through_seq` | Locked by every write of the reader |
| PostgreSQL | `highlights` | PK `(user_id, id)`; `book_id`, location range, text, note, color, visibility, `sync_seq`, `field_clock`, `deleted_at` | `id` is minted on the device. Index `(user_id, sync_seq)` serves pulls; `(user_id, book_id)` serves book views |
| PostgreSQL | `outbox` | `id`, `user_id`, `highlight_id`, `book_id`, `sync_seq`, `counted_range` (NULL = not counted) | Same transaction as the change; relayed to Kafka, then deleted |
| PostgreSQL | `follows` | PK `(follower_id, followee_id)` | Sharded by follower, so "do they follow me back" is local to the owner's shard |
| PostgreSQL | `privacy_settings` | `user_id`, `default_visibility`, `include_in_aggregation` | Read by the writer, never by the aggregator |
| Aggregator state | per `(book, reader)` | highlight → covered passages; per passage a reader set | RocksDB-backed, checkpointed; ~10 GB in total |
| Popular DB | `popular_passages` | PK `(book_id, passage_id)`; text, `reader_count`, `last_reader_at` | `CHECK (reader_count >= 10)` — the threshold is in the schema |
| Redis | `sync:user:{id}` channel | `{seq, origin device}` | Pub/sub only; nothing durable |

"`field_clock` holds, per mutable field, the stamp of the edit that set it: `{ts, device}`. `deleted_at` turns the row into a tombstone, and the text and note are wiped on delete, because 'delete' should mean the words are gone even while the row lingers for sync."

"Why PostgreSQL rather than Cassandra or DynamoDB? The sync guarantee needs a lock and a transaction spanning the highlight, the sequence row and the outbox row. That is one local transaction on a user-scoped shard and a distributed protocol anywhere else. The cross-user query that would make user-sharding painful, counting readers per passage, is exactly what the aggregator precomputes."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/sync/push                    {ops[]} + X-Device-Id → one result per op
GET    /api/v1/sync/changes?since&limit     → {changes, cursor, hasMore, resync}
WSS    /api/v1/sync/ws                      hello {token, deviceId} → welcome, then changed {seq}
POST   /api/v1/highlights                   client id → 201 | 200 replayed | 409 | 422
PATCH  /api/v1/highlights/{id}              fields + clientUpdatedAt → 200 | 410 gone
DELETE /api/v1/highlights/{id}              → 204, also when already deleted
GET    /api/v1/books/{id}/popular?limit     passages with ≥ k readers (CDN-cacheable)
GET    /api/v1/trending?days                passages that gained readers in the window
GET    /api/v1/books/{id}/friends-highlights  people I follow: public, or friends if mutual
PATCH  /api/v1/settings/privacy             default visibility, include_in_aggregation
```

- **Push answers once per operation, and every answer is final**: `created`, `replayed`, `applied`, `superseded`, `unchanged`, `deleted`, `gone`, `not_found` or `rejected`. A malformed operation is rejected on its own; it never blocks the batch and the device never retries it. That's how I avoid a poison message wedging a device's outbox forever.
- **The cursor is opaque to the client**: store it only after applying the page. `resync: true` means "drop local copies and pull from zero".
- **`minCount` can only raise the threshold**: the server uses `max(k, minCount)`.
- **The socket token goes in the first message**, not the URL, so it never shows up in load-balancer logs.

---

## 🔧 Deep Dive 1: A Sync Protocol That Never Loses or Resurrects a Highlight (9 min)

"Four decisions: what the cursor is, what makes an upload idempotent, how concurrent edits merge, and how deletes reach a device that was away."

**The cursor.** Each device stores one number, the highest `sync_seq` it has applied, and asks for everything above it.

| Option | Where it breaks |
|--------|-----------------|
| ❌ `updated_at > lastSync` | A transaction stamped .100 that commits after one stamped .200 is skipped forever; device and server clocks disagree |
| ❌ Per-device queue in Redis | A second copy of the truth, written for every offline device, expiring after N days, lost on failover |
| ❌ Global sequence | Same late-commit gap: seq 41 can commit after 42 |
| ✅ Per-user sequence under a row lock | Handed out in commit order, so gap-free by construction |

"The lock serializes one reader's writes. A human writes a few times a minute, so that contention is zero. It would be a disaster for a shared document, which is precisely why this design is scoped to single-owner data."

**Idempotent uploads.** The device mints the highlight's UUID at the moment the reader highlights, so the id is the idempotency key. Retrying the same create hits the primary key and returns the stored row as `replayed`, with no new sequence number and no second count. Reusing an id for different text is a `422`; an id that belongs to another reader is a `409` that reveals nothing. Edits are idempotent because of their stamps, and deletes because a tombstone is a state, not an action.

**Conflicts.** A highlight has one owner, so the only conflict is me editing it on two devices before they sync. Each mutable field keeps the stamp `{ts, device}` of the edit that set it; an incoming edit wins a field only if its stamp is newer, with the device id as a deterministic tie-break.

| Option | Verdict |
|--------|---------|
| ✅ Field-level last-writer-wins, clamped clocks, delete wins | Color from the Kindle and note from the phone both survive; same-field conflicts converge identically everywhere |
| ❌ Whole-row last-writer-wins | Loses the color when the note is edited elsewhere |
| ❌ `If-Match` + `412` | Fine online; an offline Kindle replaying a week of edits can't ask the reader to resolve each one |
| ❌ CRDT or OT | Built for concurrent multi-writer text; per-field merge metadata on 10B rows and identical merge code on e-ink firmware, for a conflict that barely happens |

"What LWW costs is trust in device clocks. A Kindle whose clock says next year would win every conflict forever, so the server clamps stamps to `now + 5 minutes`. Genuinely concurrent edits to the same note lose one version silently, and the device can at least say 'a newer edit from another device was kept'. With more time I'd use hybrid logical clocks, so a device that has seen a newer edit can never stamp an older one. If the product grew shared annotations, I'd revisit this whole decision, because multi-writer data is where LWW starts eating people's work."

**Deletes.** If I hard-deleted rows, a Kindle that was offline during the delete would reconnect, see a highlight the server doesn't have, and helpfully re-upload it. That's a zombie bug that's maddening to reproduce. So a delete is a tombstone: the row stays with `deleted_at` set and its text wiped, and it flows through the feed like any change. Delete beats concurrent edits (an edit to a tombstone answers `gone`), and a replayed create of a deleted id returns the tombstone instead of resurrecting it.

Tombstones can't live forever. A reaper hard-deletes those older than 90 days and records `purged_through_seq` per reader. A device whose cursor is below that mark could miss a delete, so the feed answers `resync: true` and the device rebuilds from zero. "Retention is the supported offline window. Tie them together explicitly, or you get a data-corruption bug that only shows up for people who left a device off for a while."

**Push, not poll.** 25M devices polling every 30 seconds is ~830K requests/s to deliver ~350 changes/s, and it still misses the 2-second target. A WebSocket poke costs a socket and a few KB per device. I'd accept SSE too, since the channel only carries pokes; I pick WebSockets because the device sends a hello and heartbeats on the same connection and e-ink firmware already speaks it. Either way, **the socket carries hints and the HTTP pull carries data**, so a dropped connection costs latency, never correctness.

---

## 🔧 Deep Dive 2: Counting Distinct Readers at Launch-Day Skew (8 min)

"The counting is the easy half. The hard half is deciding what 'the same passage' means."

**What to count.** Reader A selects characters 1000–1150, B catches 1005–1200, and C starts a word early at 990. They highlighted the same sentence in every sense a human cares about, and their ranges agree on nothing. Exact-range grouping turns the most famous sentence in the book into thousands of passages with a count of 1. Fixed 100-character windows group most of them, but they're a grid, and sentences don't respect grids: one that straddles a boundary gets reliably undercounted, and retuning the window only moves which sentences lose. **We own the text**, so I anchor to sentences. A highlight counts toward each sentence it covers at least half of, and adjacent sentences with similar readers display as one passage. The aggregator needs each book's sentence offsets, a few KB per book.

**Counting without hot rows.**

| Approach | Where it breaks |
|----------|-----------------|
| ❌ `UPDATE popular SET count = count + 1` per save | The count is the indexed sort column, so every increment is a non-HOT update with index churn and vacuum debt. A launch puts ~1,000 updates/s on one book's few rows, serialized on row locks exactly when the feature is most visible |
| ❌ `GROUP BY` on read | Scans a bestseller's millions of highlights on every book open, at 5,000 opens/s |
| ❌ Redis `HINCRBY` per save | No hot-row lock, but counts highlights not readers, can't undo a visibility change it never saw, and dual-writes outside the database transaction |
| ✅ Outbox → Kafka by book → distinct-reader sets | Event committed with the change; one ordered consumer per book; exact under replay |

**Making it exact.** The outbox event carries the highlight's *current* contribution, not a delta: `(book, reader, highlight, sync_seq, counted range or NULL)`, where NULL means private, deleted or opted out. The writer already knows that, so the aggregator never reads privacy settings. The aggregator keeps, per (book, reader), which passages each of that reader's highlights covers, and per passage the set of readers. An event whose `sync_seq` isn't newer than what it has for that highlight is dropped. So Kafka's at-least-once delivery and replays after a crash converge to the same state, and a reader with two highlights on one sentence is still one reader. Every 60 seconds it republishes changed books, writing only passages with at least k readers.

"The hot book is one partition and one consumer, and that's fine: 1,000 set updates a second is trivial for one process, and the 60-second publish turns them into one upsert per passage. What I give up is freshness, since counts lag a minute or two, plus stateful infrastructure: ~10 GB of reader sets that must be checkpointed. A nightly batch job recomputes every book from the source of truth and diffs it against the published table, and drift above zero pages someone. That's the aggregation pipeline's correctness test; without it, 'approximately right' quietly degrades into 'whatever survived'."

---

## 🔧 Deep Dive 3: Privacy — When a Count Becomes an Identifier (5 min)

"Reading is sensitive: addiction recovery, a diagnosis, leaving a marriage. A highlight is more revealing than a purchase, because it's the exact sentence that landed. So the question is when an aggregate stops protecting the people inside it."

Take a book with 40 readers and a passage showing a count of 1. Add the social graph, where I can see who reads what, and the candidate set collapses. **In a small readership, a count of 1 is a name.**

1. **Consent at write time.** Only `public` highlights of readers who haven't opted out produce a counted contribution. Opted-out data never enters the stream, so no later bug can leak it. A read-time filter would keep the sensitive data *in* the pipeline and trust a predicate to keep it out of every response.
2. **The threshold suppresses presence, not the number.** Showing the passage with the count hidden still says "someone here highlighted this", and that's the whole leak. Below k = 10 the passage doesn't exist in any public response. It's enforced twice: the aggregator never publishes it (and the table's `CHECK` would reject it), and the API filters again, with `minCount` only able to raise k. The cost is real: a 200-reader poetry book will never show community highlights. That's the feature working.
3. **Aggregates are never attributed.** Friends' highlights is the attributed surface, so it's a different query with a different rule: `friends` requires a *mutual* follow. Following is one-sided and needs no approval; if any follower counted as a friend, one click would unlock semi-private notes.

| Option | Verdict |
|--------|---------|
| ✅ Consent at write + k on presence, enforced at publish and serve | Hard guarantee in exactly the low-count region where risk lives |
| ❌ Hide the number below k | Presence is the disclosure |
| ❌ Differential privacy | Counts are shown exactly and prominently; noise drifts visible numbers and is weakest in the low tail, where the threshold already gives a hard guarantee |
| ❌ Filter consent at read time | Sensitive data stays in the pipeline, one bug away from a leak |

"What this leaves exposed: the aggregator's state holds sub-threshold sets, because you can't reach 10 without counting to 9. That state is sensitive infrastructure: no debug endpoint that dumps a book's passage sets, and access controlled like user data."

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first:** the reconnect storm when a gateway dies (50K pulls in seconds, which clients spread with jittered backoff and which stay cheap because a pull is a range scan); a launch-day partition (one consumer, fine); and shard growth (split by `user_id` range, nothing cross-shard on the hot path).

| Failure | Effect | Mitigation |
|---------|--------|------------|
| Device offline | Writes queue locally | Idempotent push on reconnect |
| Response lost after commit | Device retries | Replay by client id |
| Gateway crash | Sockets drop | Backoff with jitter, then cursor pull |
| Redis down | No pokes | Pull on reconnect, foreground and every 5 minutes |
| Kafka or aggregator down | Counts freeze | Outbox rows wait in PostgreSQL; serving continues |
| Shard primary down | Its readers' writes fail | Devices keep queueing; replica promotion |

**What I'd watch:** create-to-poke latency (the 2-second SLO), resync rate, pushed-op status mix (rising `rejected` means a client bug), outbox and consumer lag (popular staleness), nightly drift (must be zero), and a worker heartbeat, because an aggregator can be alive and stuck.

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Sync cursor | Per-user sequence under a row lock | Timestamps, device queues | Gap-free in commit order |
| Idempotency | Client-minted highlight ids | Server ids + body dedupe | Retries replay; same words twice is allowed |
| Conflicts | Field-level LWW, clamped clocks, delete wins | CRDT/OT, `If-Match` | Single owner; offline can't resolve 412s |
| Deletes | Tombstones + 90-day retention + resync | Hard delete | No zombies from long-offline devices |
| Counting | Outbox → Kafka → reader sets | Counter per save, `GROUP BY` on read | No hot rows; exact under replay |
| Passage | Sentence-anchored | Exact ranges, fixed windows | We own the text |
| Privacy | Consent at write; k on presence, twice | Read-time filter; hide the number | Presence is the disclosure |
| Shard key | `user_id` | `book_id` | Raw reads are user-scoped; the cross-user count is precomputed |

"With more time: counter-fraud detection (an author botting their own book's key passage is the obvious attack), hybrid logical clocks for edit stamps, and edition-independent passage anchors so hardcover, paperback and Kindle readers count together."

# 📚 Kindle Community Highlights — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one highlight through its whole life: selected on a Kindle in a tunnel, edited again on the phone, counted toward 'Popular Highlights' without exposing anyone, and shown on a friend's screen. I'd get the contracts between the layers right, so each layer can be offline, slow or retried without breaking the others. Three contracts carry most of the weight: a client-minted id that makes uploads safe to retry, a per-user sequence cursor that makes sync gap-free, and a privacy threshold the server enforces so the client never has to."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the reader's tap to the published count, plus two flows |
| Data model & API contract | 7 min | Server tables, client stores, the fields both sides rely on |
| Deep dive 1: one highlight per tap | 8 min | Idempotency from the device to the database |
| Deep dive 2: sync and conflicts | 9 min | Cursor, merge rules and what the UI says about them |
| Deep dive 3: popular highlights end to end | 5 min | Consent, threshold, freshness |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a reader |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Readers highlight text (color, optional note) on a Kindle, phone or web; edit and delete; see everything on every device. Per book, Popular Highlights shows passages many readers marked ("1,247 readers"), plus a trending list. Readers follow each other and see friends' highlights; each highlight is `private`, `friends` or `public`. Library search and export. Out of scope: the reading engine, book clubs, recommendations.

| Side | Requirement | Target |
|------|-------------|--------|
| Client | Highlight paint after tap | Same frame; never waits for the network |
| Client | Offline | Read, highlight, edit and delete with no network; nothing lost if the app closes |
| Client | Responsiveness | INP < 200 ms in the reader and in a 20,000-highlight library |
| Both | Cross-device sync | p95 < 2 s for connected devices; catch-up after 90 days offline |
| Server | Write ack | p99 < 200 ms |
| Server | Popular freshness | Within 5 minutes |
| Both | Privacy | No passage shown with fewer than 10 distinct readers; opt-out effective in minutes |

**Scale.** 10M daily readers with ~2.5 devices each write ~30M highlights a day (~350/s, ~3,500/s at peak), and a launch can put ~1,000 highlights/s on a single book. About 2.5M devices hold sockets at the evening peak, 40M book opens a day read popular passages, and 10B stored highlights (~3 TB) shard by reader.

"The ratio tells me the write path is about correctness under retries and offline merges, not throughput. Popular passages are read by everyone, so they have to be precomputed and cacheable. And 20,000 highlights per heavy reader means the client needs a real local database, not a JSON blob."

---

## 🏗️ End-to-End Architecture (8 min)

```
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │ Reader UI · React views · live queries on IndexedDB · TanStack Query for others      │
  └──────────────────────────────┬─────────────────────────────────────────────┬─────────┘
                                 │ (1) save highlight + queue op               │ (3) GET popular
                                 ▼                                             │
  ┌─────────────────────────────────────────────────────────────┐              │
  │ Client sync engine · IndexedDB: highlights, outbox,         │              │
  │ feed cursor · one WebSocket for all tabs                    │              │
  └─────┬─────────────────────┬────────────────────────────▲────┘              │
        │ POST /sync/push     │ (2) GET /sync/changes      │ WSS "changed N"   │
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

1. **Write (1).** The Reader UI saves the highlight and an outbox op into IndexedDB in one transaction, so it paints immediately. The client sync engine pushes the outbox to the Highlight API. There, each op runs in one transaction (lock the reader's sequence row, write, stamp the next sequence number, add an outbox row if a public count can change) and is then announced on Redis. The Sync gateway pokes the reader's other devices.
2. **Sync (2).** On a poke or a reconnect, a device pulls `changes since <cursor>` and writes the rows and the new cursor into IndexedDB in one transaction; live queries re-render.
3. **Popular (3).** The UI asks for a book's popular passages through the CDN. Behind it, a relay ships outbox rows to Kafka, aggregators count distinct readers per passage, and only passages with at least k readers reach the Popular DB.

| Layer | Choice | Why |
|-------|--------|-----|
| Reader UI | React SPA, service-worker shell; live queries on IndexedDB for my highlights; TanStack Query for other people's data | Works offline; my data and others' data have different freshness rules |
| Client sync engine | One per browser (SharedWorker): outbox push, cursor pull, socket | One socket and no racing pushes across tabs |
| Highlight API | Stateless push, pull and CRUD over one shared write path | Every write gets the same sequence, merge and outbox rules |
| Sync gateway | Sockets only | A crash costs reconnects, never data |
| PostgreSQL by `user_id` | Highlights, sequence rows, outbox | A write, its sequence and its event commit together |
| Kafka → Aggregator → Popular DB | Distinct readers per passage, threshold, publish | No hot rows; exact under replay |

### Flow: a highlight survives a lost response

```
Reader app                      Highlight API                                PostgreSQL
     │                                │                                           │
     │ 1 id = uuid(); save locally    │                                           │
     │ 2 POST /sync/push [create id]  │                                           │
     │───────────────────────────────▶│                                           │
     │                                │ 3 INSERT ... ON CONFLICT (id) DO NOTHING  │
     │                                │──────────────────────────────────────────▶│
     │                                │ 4 1 row, seq 58, outbox                   │
     │                                │◀──────────────────────────────────────────│
     │ 5 response lost (tunnel)       │                                           │
     │◀───────────────────────────────│                                           │
     │ 6 retry, same batch            │                                           │
     │───────────────────────────────▶│                                           │
     │                                │ 7 INSERT: 0 rows; SELECT id               │
     │                                │──────────────────────────────────────────▶│
     │ 8 replayed + stored row        │                                           │
     │◀───────────────────────────────│                                           │
     │                                │                                           │
```

"Steps 1 and 3 are two halves of one contract. The device promises to reuse the same id for the same highlight, even after a restart, because the id is stored with the highlight. The server promises that an existing id returns the stored row instead of inserting again. A sequence number and an outbox row are only produced when the insert actually happens, so the retry can't count the passage twice."

### Flow: two devices edit the same highlight

```
Kindle                           Highlight API                           PostgreSQL    Phone
   │                                   │                                      │          │
   ····························· Kindle offline since 10:00 ······························
   │                                   │ 1 note = "B" at 10:05                           │
   │                                   │◀────────────────────────────────────────────────│
   │                                   │ 2 note <- B, stamp 10:05             │          │
   │                                   │─────────────────────────────────────▶│          │
   │ 3 push: note "A", blue, at 10:02  │                                      │          │
   │──────────────────────────────────▶│                                      │          │
   │                                   │ 4 lock row; compare stamps           │          │
   │                                   │─────────────────────────────────────▶│          │
   │                                   │ 5 note 10:05 wins; color 10:02 wins  │          │
   │                                   │◀─────────────────────────────────────│          │
   │ 6 note superseded, color applied  │                                      │          │
   │◀──────────────────────────────────│                                      │          │
   │                                   │ 7 poke; Phone pulls blue                        │
   │                                   │────────────────────────────────────────────────▶│
   │                                   │                                      │          │
```

"The Kindle's note was typed at 10:02, before the phone's 10:05 edit, so it loses. Its color change has no rival, so it wins. Both devices end up with note 'B' and color blue, and the Kindle's UI says 'a newer edit from another device was kept' instead of silently showing B."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `highlights` | PK `(user_id, id)`; book, range, text, note, color, visibility, `sync_seq`, `field_clock`, `deleted_at` | `id` minted by the device; `(user_id, sync_seq)` index serves pulls |
| PostgreSQL | `user_sync_state` | `user_id`, `last_seq`, `purged_through_seq` | Locked by every write; issues sequence numbers in commit order |
| PostgreSQL | `outbox` | `book_id`, `user_id`, `highlight_id`, `sync_seq`, `counted_range` | Same transaction as the change; relayed to Kafka by book |
| PostgreSQL | `follows`, `privacy_settings` | follower/followee; default visibility, opt-out | Friends = mutual follow |
| Popular DB | `popular_passages` | `(book_id, passage_id)`, text, `reader_count` | `CHECK (reader_count >= 10)` |

### Client side

| Store / cache key | Holds | Updated by |
|-------------------|-------|------------|
| IndexedDB `highlights` | My highlights, including pending and tombstoned ones | Local edits; pulled rows (pending edits re-applied on top) |
| IndexedDB `outbox` | Ordered ops: create / update / delete with `clientUpdatedAt` | Each local action; removed when the server's result arrives |
| IndexedDB `meta` | Feed cursor, device id | Same transaction as the pulled rows |
| `['popular', bookId]` | Published passages | Fetch on book open; stale after 5 minutes |
| `['friends', bookId]`, `['trending', days]` | Other readers' data | Fetch on tab open |

### The contract

```
POST /api/sync/push            {ops[]} + X-Device-Id → one final result per op, in order
GET  /api/sync/changes?since=N → {changes, cursor, hasMore, resync}
WSS  /api/sync/ws              hello {token, deviceId} → welcome {latestSeq}, changed {seq}
GET  /api/books/{id}/popular   → passages with ≥ k readers
GET  /api/books/{id}/friends-highlights → public, or friends if the follow is mutual
PATCH /api/settings/privacy    {highlightVisibility?, includeInAggregation?}
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| Client-minted `id` | Same id → the stored row (`replayed`); different text → `422` | Retry any push after a timeout, crash or reload |
| `clientUpdatedAt` per edit | Fields merge by stamp, device clock clamped to now + 5 min | Stamp edits when the reader makes them, not when they're pushed |
| Push results | One final status per op: `applied`, `superseded`, `gone`, `rejected`, … | Clear `pending`, show "newer edit kept", or drop a bad op forever |
| `cursor` | Gap-free, in commit order; read in one snapshot with the rows | Store it in the same IndexedDB transaction as the rows |
| `resync` | Below the tombstone horizon (90 days) an incremental answer could miss a delete | Clear synced rows, keep pending ones, pull from zero |
| Threshold | Nothing below k readers ever leaves the server | Render whatever comes back; explain empty states |

---

## 🔧 Deep Dive 1: Exactly One Highlight per Tap (8 min)

"The scenario: a reader highlights a sentence in a tunnel, the push times out after the server committed, and the device retries. Without care, they now own the sentence twice, and the passage's public count went up twice."

**Device.** The highlight's UUID is generated when the reader taps, stored with the highlight in IndexedDB, and reused by every push of that highlight: the automatic retry, the retry after an app restart, the retry three days later on hotel Wi-Fi. The outbox op references the id, so there's nothing to "remember to reuse".

**API and database.** The insert is `ON CONFLICT (id) DO NOTHING`. If it inserted, the API takes the next sequence number, writes an outbox row when the highlight is public, and answers `created`. If it didn't, the existing row is a retry. The API returns it as `replayed` with no new sequence number, no new outbox row and no poke. If the stored row has different text, the id was reused by a bug, so `422`. If it belongs to another reader, `409`, with nothing revealed.

**Counting.** The outbox row is written only in the branch that inserted. "The count increment must live inside the same idempotency boundary as the insert. Otherwise retries silently inflate the one number we show to everyone, and nothing in the logs says why."

| Approach | Verdict |
|----------|---------|
| ✅ Client-minted id as the primary key | Idempotent forever, at no storage cost; works offline because the id exists before the network does |
| ❌ `Idempotency-Key` header with stored responses | Fine for online clients, but needs a response store and a TTL; an offline device's retry can arrive after the TTL |
| ❌ Server dedupe by (book, range, text) | Merges intentional duplicates: the same words highlighted in two colors |
| ❌ Disable the button | Stops double taps, not retries after a timeout or a crash |

"What I give up: clients must generate good UUIDs (v4 from a CSPRNG is fine), and a malicious client can probe whether an id exists. It learns nothing beyond `409`, because ids are random and the row is never returned to another reader."

---

## 🔧 Deep Dive 2: Sync and Conflicts Across the Seam (9 min)

"Sync is a contract with four clauses: what the cursor means, what order the client does things in, how edits merge, and what a delete means."

**The cursor.** Every write takes `last_seq + 1` under a lock on the reader's sequence row, so sequence numbers commit in order and the feed has no gaps. A timestamp cursor would skip a transaction that started earlier but committed later; a per-device queue would be a second copy of the truth. The client stores the cursor in the same IndexedDB transaction as the rows it covers, so a crash can't leave a cursor claiming data the device never saved.

**Order on reconnect: push, then pull.** The device pushes its outbox first, so its own offline edits are merged on the server and come back in the pull in their final state. Rows that arrive while ops are still pending get those ops re-applied locally until the server confirms, so nothing flickers back to an old value.

**Merging edits.** A highlight has one owner, so the only conflict is the same reader on two devices. Each field (`note`, `color`, `visibility`) keeps the stamp of the edit that set it; an incoming edit wins a field if its stamp is newer, with the device id breaking ties identically everywhere. That's why the client must send `clientUpdatedAt` from the moment of the edit. The server clamps it to `now + 5 minutes`, so a Kindle whose clock says next year can't win every conflict forever.

**Deletes win, and they're tombstones.** A delete leaves the row with `deleted_at` set and the text wiped. It syncs like any change, edits to it answer `gone`, and a replayed create of it returns the tombstone. Without tombstones, a Kindle that was offline during the delete would reconnect and re-upload the highlight, a zombie that comes back every time the Kindle syncs. Tombstones are reaped after 90 days, so a cursor older than that gets `resync: true`.

| Approach | Verdict |
|----------|---------|
| ✅ Per-user sequence + field-level LWW + tombstones | Gap-free, converges identically on every device, survives a month offline |
| ❌ `If-Match` + `412` | An offline device replaying a week of edits can't ask the reader to resolve each conflict |
| ❌ CRDTs | Built for many writers; merge metadata on billions of rows and on e-ink firmware, for a rare single-owner conflict |
| ❌ Polling every 30 s | 25M devices × 2/min ≈ 830K requests/s to say "nothing new", and still slower than a poke |

**What the UI says.** `superseded` becomes "A newer edit from another device was kept", `gone` becomes "Deleted on another device", and `rejected` drops the op with a visible error, never a silent retry loop. The live channel is a WebSocket carrying only "your feed is at seq N"; the data always travels over the HTTP pull. "The trade: per-field last-writer-wins can lose a genuinely concurrent edit to the same note, and the UI is honest about it. If the product grew shared annotations, that would flip the decision."

---

## 🔧 Deep Dive 3: Popular Highlights from Tap to Tab (5 min)

"Two rules: consent is decided where data is written, and privacy is enforced by the server, never by the client."

**On the device.** The visibility picker defaults to the reader's setting and explains it: "Public — counts toward Popular Highlights once 10 readers highlight the passage". The opt-out toggle says it takes a few minutes to leave existing counts.

**In the write.** The writer decides whether a highlight counts (public, not deleted, reader not opted out) and records that decision in the outbox event, along with the highlight's range and sequence number. Opting out emits "not counted" events for the reader's public highlights. The aggregator never sees anything it shouldn't count.

**In the aggregator.** Events are keyed by book, so one consumer sees a book's events in order. It keeps the set of distinct readers per passage, which makes replays harmless and stops one reader with two highlights from counting twice. Every 60 seconds it publishes passages with at least k = 10 readers. Below k, a passage doesn't exist in any response, because its presence alone says "somebody reading this book highlighted it", and in a small readership that's a name.

**On the screen.** The client renders what it gets: dotted underlines with "1,247 readers" in the reader view, and a Popular tab whose empty state explains the threshold. `minCount` can only raise k on the server, so a curious client can't lower it. Friends' highlights are a separate, attributed query: `friends` means a *mutual* follow, because following is one-click and unapproved.

| Approach | Verdict |
|----------|---------|
| ✅ Consent at write; k on presence; server-enforced | Opted-out data never enters; nothing identifying ever reaches a client |
| ❌ Client hides small counts | The data is already on the wire; anyone with dev tools sees it |
| ❌ Counter per save | Hot rows at launch; counts highlights, not readers; can't undo a visibility change |

"What I give up: counts lag by a minute or two, and small books never get community highlights. Both are visible in the UI as freshness and empty-state copy, rather than hidden."

---

## 📈 Failures & Scale (2 min)

| Failure | What the reader sees | What the system does |
|---------|----------------------|----------------------|
| No network | "Offline — 3 changes waiting"; everything still works | Outbox persists; push on reconnect |
| Push response lost | Nothing | Retry replays by id |
| Gateway restart | Header briefly says "connecting" | Backoff with jitter; pull from the cursor |
| Redis down | Updates arrive on the next pull, not instantly | Pull on reconnect, foreground and every 5 minutes |
| Aggregator down | Popular counts stop moving | Outbox rows wait; serving continues |
| Cursor older than 90 days | "Refreshing your highlights…" | `resync`: clear synced rows, keep pending, pull from zero |

**What breaks first:** the reconnect storm after a gateway dies (jittered backoff, cheap range-scan pulls), a launch-day Kafka partition (one consumer handles ~1,000 events/s), and shard growth (split by `user_id`; nothing on the hot path is cross-shard).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Upload safety | Client-minted id as primary key | Idempotency-Key store, body dedupe | Works offline and forever; duplicates still allowed on purpose |
| Sync cursor | Per-user sequence, stored with the rows | Timestamps, device queues | Gap-free; one source of truth |
| Conflicts | Field-level LWW, clamped clocks, delete wins | `If-Match`, CRDTs | Single owner; offline clients can't resolve 412s |
| Live updates | Socket poke, then HTTP pull | Polling, push payloads | Fast, and a missed poke loses nothing |
| Client store | IndexedDB + outbox; query cache for others' data | Everything in a query cache | Offline, survives reloads, no rollback code |
| Popular privacy | Consent at write, k on presence, server-enforced | Client-side hiding | The client is not a trust boundary |

"With more time: hybrid logical clocks for edit stamps, counter-fraud detection on popular passages, and an export that streams from a worker so a 20,000-highlight Markdown file never blocks a request."

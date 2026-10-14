# 📝 Notion — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Notion looks like a document editor, but it's really a tree of small records that many people change at once. Two things make it hard. First, every client must end up with exactly the same page even when messages get lost — broadcasting edits isn't enough, the system has to *converge*. Second, sharing flows down the page tree, so every single read and write has to answer 'what may this person do here?' by looking at the page's ancestors. I'll design the write path around a per-page operation log with sequence numbers, and the read path around a permission walk."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and why per-page contention is the number that matters |
| High-level architecture | 10 min | One overview diagram, the save path and the catch-up path |
| Data model & API | 7 min | Blocks as rows, the operation log, and the contract |
| Deep dive 1: ordering blocks | 7 min | Fractional keys, and what happens when they run out of room |
| Deep dive 2: concurrent edits | 8 min | Sequence numbers, versions, and why not a CRDT (yet) |
| Deep dive 3: permission inheritance | 5 min | Walking up the tree versus materializing access |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down what we're building, because 'Notion' covers docs, wikis, databases, AI and a lot more."

### Functional requirements

1. **Edit pages made of blocks**: paragraphs, headings, lists, toggles, code — create, edit, change type, move, nest, delete.
2. **Collaborate in real time**: other people's edits appear within a second; I can see who else is on the page.
3. **Organize** pages in a tree per workspace, with a sidebar and breadcrumbs.
4. **Share** a page at view, edit or full-access level. The grant covers everything beneath the page unless a deeper grant overrides it. Guests see only what was shared with them.
5. **Databases**: pages with a property schema whose rows show up as table, board or list views.
6. **Bad networks**: edits made while disconnected are kept and saved later.

Out of scope: comments, version history UI, templates, file uploads, public publishing, AI.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Local edit | Rendered in the same frame | Typing must never wait for the network |
| Save | p99 < 200 ms server-side | The "Saving…" indicator is visible |
| Propagation | p99 < 500 ms commit → other clients | Collaborators react to each other |
| Page open | p95 < 1 s for 500 blocks | The most frequent action |
| Availability | 99.99% | Teams run on it |
| Durability | No acknowledged edit lost | A `200` is a promise |
| Convergence | Every client reaches the server's state, even after lost or duplicated messages | Divergent copies are the worst bug a collaborative editor can have |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Users | 100M registered, 20M daily active | Partition everything by workspace |
| Open sockets | ~3M at peak | ~60 gateway servers at 50K connections each |
| Blocks | ~200 billion × ~1 KB ≈ 200 TB | Sharded PostgreSQL |
| Block writes | 1M concurrent editors × 0.3 saves/s ≈ 300K/s peak | Spread over hundreds of logical shards |
| Page opens | 600M/day → 7K/s average, 20K/s peak, ~100 KB each | Snapshot cache plus read replicas |
| Fan-out | 300K ops/s × 3 viewers ≈ 1M socket messages/s | Pub/sub per page |
| Operation log | 100K ops/s average × 500 B ≈ 4 TB/day | Daily partitions, 7 days hot |
| Hottest page | 50 editors × 1 save/s = 50 writes/s | Per-page serialization is affordable |

"The number I care about most isn't 300K writes per second — that's spread across millions of pages. It's the busiest *single* page: about 50 writes per second. That tells me I can afford to serialize writes per page, which is what makes ordering simple. If one transaction holds the page lock for about 2 ms, one page can take 500 writes a second."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk through three journeys: saving an edit, receiving everyone else's edits, and keeping search up to date."

```
  ┌────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Browser / desktop app · block editor · local copy of open pages                            │
  └─────────────┬──────────────────────────────────────────────────────────┬───────────────────┘
                │ (1) PATCH /api/blocks/{id}        (2) WSS /ws  subscribe │
                │     {content, expected_version}       {pageId, sinceSeq} │
                ▼                                                          ▼
  ┌────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Load balancer · TLS · session check · /api/* to Page API, /ws to Sync gateway              │
  └─────────────┬──────────────────────────────────────────────────────────┬───────────────────┘
                ▼                                                          ▼
  ┌──────────────────────────────┐                              ┌──────────────────────────────┐
  │ Page API (stateless)         │                              │ Sync gateway (WebSocket)     │
  │ permission walk · write txn  │                              │ replay · presence · push     │
  └───┬───────────────────┬──────┘                              └─────┬───────────────────┬────┘
      │                   │ PUBLISH op            SUBSCRIBE page:{id} │                   │
      │                   └────────▶┌──────────────────────┐◀─────────┘                   │
      │                             │ Redis                │                              │
      │                             │ pub/sub page:{id}    │                              │
      │                             │ presence · caches    │                              │
      │                             └──────────────────────┘                              │
      │ BEGIN · lock page · CAS block · INSERT op seq+1 · COMMIT                          │
      │                                           replay: SELECT ops WHERE seq > sinceSeq │
      └────────────────────────────▶┌──────────────────────┐◀─────────────────────────────┘
                                    │ PostgreSQL           │
                                    │ pages · blocks · ops │
                                    │ sharded by workspace │
                                    └──────────┬───────────┘
                                               │ (3) outbox relay (same txn)
                                               ▼
                                    ┌──────────────────────┐ consume  ┌────────────────────┐
                                    │ Kafka                │─────────▶│ Search indexer     │
                                    │ page-changes         │          │ consumer group     │
                                    └──────────────────────┘          └─────────┬──────────┘
                                                                                │ bulk index
                                                                                ▼
                                                                      ┌────────────────────┐
                                                                      │ Elasticsearch      │
                                                                      │ page text, by ws   │
                                                                      └────────────────────┘
```

1. **Save (1).** The editor sends `PATCH /api/blocks/{id}` with the new content and the version it last saw. The Page API checks permission, then in one transaction locks the page, updates the block if the version still matches, appends an operation with the page's next sequence number, and commits. After the commit it publishes the operation on Redis.
2. **Receive (2).** Each open page holds a WebSocket to some Sync gateway, subscribed with the last sequence number it applied. The gateway subscribes to the page's Redis channel, replays anything newer from the operation log, then pushes live operations as they're published.
3. **Index (3).** Operation rows reach Kafka through a transactional outbox, and a consumer keeps Elasticsearch current. Search never slows a save.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, session check, routing | Connections | No sticky sessions: any gateway can serve any page |
| Page API | Permissions, writes, page snapshots, sharing | Writes and page opens | Stateless; the only place operations are created |
| Sync gateway | Subscriptions, replay, presence | Open sockets | ~50K sockets per server, almost no CPU per message |
| PostgreSQL | Pages, blocks, operation log, grants | Data and write rate | Sharded by workspace so one page's data is together |
| Redis | Pub/sub per page, presence, caches | Fan-out | Losing a message costs a replay, never data |
| Kafka | Durable stream of committed operations | Write rate | Search, notifications, analytics |
| Search indexer + Elasticsearch | Full-text search | Corpus size | Results filtered by visible pages |

"Why split the API from the gateway? The gateway holds millions of idle connections and does almost nothing per message; the API does short, database-heavy requests. Different scaling curves, different failure modes. And neither holds state the other needs: everything is in PostgreSQL or Redis."

### Flow 1: saving a block edit

```
Editor                  Page API               PostgreSQL    Redis       Gateway          Viewer
   │                        │                       │          │            │                │
   │ 1 PATCH b7 {text, v4}  │                       │          │            │                │
   │───────────────────────▶│                       │          │            │                │
   │                        │ 2 BEGIN; lock page    │          │            │                │
   │                        │──────────────────────▶│          │            │                │
   │                        │ 3 UPDATE b7 if v = 4  │          │            │                │
   │                        │──────────────────────▶│          │            │                │
   │                        │ 4 INSERT op seq 128   │          │            │                │
   │                        │──────────────────────▶│          │            │                │
   │                        │ 5 COMMIT              │          │            │                │
   │                        │──────────────────────▶│          │            │                │
   │ 6 200 {b7 v5}          │                       │          │            │                │
   │◀───────────────────────│                       │          │            │                │
   ······································ after commit ·······································
   │                        │ 7 PUBLISH op 128                 │            │                │
   │                        │─────────────────────────────────▶│            │                │
   │                        │                       │          │ 8 message  │                │
   │                        │                       │          │───────────▶│                │
   │                        │                       │          │            │ 9 op 128 (b7)  │
   │                        │                       │          │            │───────────────▶│
   │                        │                       │          │     10 128 = last+1: apply  │
   │                        │                       │          │            │                │
```

"Steps 2 to 5 are one transaction, and the page lock in step 2 buys three things at once: a total order of the page's operations, positions computed from neighbors that can't change underneath me, and a sequence number with no holes. The counter lives in the page row, so if the transaction rolls back the number isn't used. I deliberately don't use a PostgreSQL sequence here — `nextval` isn't transactional, and a hole would look to every client like a lost message."

"Step 7 is after the commit and it's fire-and-forget. If Redis drops it, the viewer's next operation arrives with a gap and it asks for a replay. Pub/sub is a doorbell; the log is the truth."

### Flow 2: opening a page and catching up

```
 Browser                        Sync gateway               Redis   PostgreSQL
    │                                 │                      │          │
    │ 1 subscribe {p1, sinceSeq 120}  │                      │          │
    │────────────────────────────────▶│                      │          │
    │                                 │ 2 permission walk: view?        │
    │                                 │────────────────────────────────▶│
    │                                 │ 3 SUBSCRIBE page:p1  │          │
    │                                 │─────────────────────▶│          │
    │                                 │ 4 SELECT ops WHERE seq > 120    │
    │                                 │────────────────────────────────▶│
    │ 5 sync {ops 121..128}           │                      │          │
    │◀────────────────────────────────│                      │          │
    │ 6 apply in order, lastSeq 128   │                      │          │
    ··············· later: seq 130 arrives, 129 was lost ················
    │ 7 gap: drop 130                 │                      │          │
    │ 8 sync {sinceSeq 128}           │                      │          │
    │────────────────────────────────▶│                      │          │
    │ 9 sync {ops 129, 130}           │                      │          │
    │◀────────────────────────────────│                      │          │
    │                                 │                      │          │
```

"A page open is two steps: fetch a snapshot of the blocks together with the sequence number it reflects, then subscribe from that number. The ordering of steps 3 and 4 matters — subscribe to Redis *first*, then read the replay, so every operation is either in the replay or arrives live. Overlaps are harmless because the client drops anything at or below its last applied number."

"A nice side effect: because the snapshot carries its sequence number, I can serve it from a cache that's a few seconds stale. The replay fills the difference. Cache invalidation stops being a correctness problem and becomes a hit-rate optimization."

---

## 💾 Data Model (4 min)

"Everything is a row, and everything carries `workspace_id` so it lands on one shard."

| Table | Key columns | Indexes and notes |
|-------|-------------|-------------------|
| `pages` | `id`, `workspace_id`, `parent_id`, `title`, `position`, `last_op_seq`, `is_database`, `properties_schema` | `(workspace_id, parent_id, position)` for the tree; `last_op_seq` is the head of the page's log |
| `blocks` | `id` (chosen by the client), `page_id`, `parent_block_id`, `type`, `content` (JSONB rich text), `properties`, `position`, `version` | `(page_id, parent_block_id, position)` serves "load page in order" and sibling lookups |
| `operations` | `(page_id, seq)` primary key, `block_id`, `type` (insert, update, delete, move), `data` (block after the change), `author_id`, `hlc` | Partitioned by day, 7 days hot; doubles as the outbox |
| `page_permissions` | `(page_id, user_id)`, `permission` (view, edit, full_access) | Index on `user_id`; only explicit grants are stored |
| `workspace_members` | `(workspace_id, user_id)`, `role` (admin, member, guest) | The default when no grant applies |

"Three choices are worth saying out loud."

- **One row per block, with parent pointers.** Turning a paragraph into a heading is a one-column update; two people editing different blocks of a page touch different rows. A JSON document per page would make every keystroke rewrite the whole page and every concurrent edit a conflict on one value.
- **Positions are strings** compared byte-wise (I'd declare the column `COLLATE "C"`). Deep dive 1 is about them.
- **Database rows are pages.** A row is a page with a `properties` map, so it can contain blocks and be shared like any page — that's how Notion models it, and it means databases reuse the whole permission and sync machinery.

"Why PostgreSQL rather than a wide-column store? The write path needs a multi-statement transaction — lock, compare-and-swap, append to the log — and the permission walk is a recursive query. Both are natural in PostgreSQL and awkward in Cassandra. Sharding by workspace keeps both inside one database, and Notion has written publicly about sharding its block data by workspace in exactly this way."

---

## 🔌 API Design (3 min)

```
GET    /api/pages?workspace_id=…              visible page tree, each page with my permission
GET    /api/pages/{id}                        page + blocks snapshot + seq + permission
POST   /api/pages                             create page or database (edit on the parent)
PATCH  /api/pages/{id}                        rename, move (same workspace, no cycles)
PUT    /api/pages/{id}/permissions            {email, permission} → share (full_access)
DELETE /api/pages/{id}/permissions/{userId}   revoke a direct grant
POST   /api/blocks                            {id, page_id, after_block_id, type, content} → 201 | 200 replay
PATCH  /api/blocks/{id}                       {fields, expected_version} → 200 | 409 {current block}
POST   /api/blocks/{id}/move                  {after_block_id | parent_block_id}
DELETE /api/blocks/{id}                       block and its children
POST   /api/blocks/batch                      several operations on one page, one transaction
WS     /ws                                    subscribe {pageId, sinceSeq} · sync · presence
```

- **Writes go over REST, not the socket.** A REST call has a status code; a `409` or a `403` has somewhere to land, and the client knows when to retry. The socket only delivers committed operations.
- **Idempotency through client-chosen ids.** Block creation is the only non-idempotent write, and the client picks the block's UUID. A retried create finds the row and returns `200` without a second sequence number. I don't need an `Idempotency-Key` table for that.
- **`409` carries the current block**, so the client can rebase without another round trip. `If-Match` works too.
- **Every id is resolved inside the page that was authorized.** A batch for page A that names a block on page B in another workspace gets `404`, not a write.

---

## 🔧 Deep Dive 1: Ordering Blocks (7 min)

"Blocks are siblings in a list, and people insert into the middle of that list concurrently. How do I store the order?"

| Approach | How it works | Where it breaks |
|----------|--------------|-----------------|
| ❌ Integer positions | `position = 3`, shift everything after | Inserting at index 3 of 200 blocks rewrites 197 rows; each is a write that conflicts with concurrent edits and must be broadcast |
| ⚠️ Ordered child list on the parent | Parent stores `[id1, id2, …]` | Every insert into the same parent contends on one row; needs list operations applied server-side, not array overwrites |
| ✅ Fractional keys on the children | Each block has a key; insert takes a key between its neighbors | Keys grow under repeated inserts into the same gap |

**Why fractional keys work.** A key like `n` or `an` is a base-26 fraction over the letters `a`–`z`. To insert between `b` and `c` I generate `bn`; between `b` and `bn`, `bg`. The insert writes one row and touches nothing else, and loading a page in order is one index scan on `(page_id, parent_block_id, position)`.

**The parts people get wrong.**

1. **Never end a key with the zero digit.** `b` and `ba` are the same fraction but different strings, and nothing sorts between them — a gap that can never be split. The generator never produces a trailing `a`.
2. **Concurrent inserts into the same gap.** Two users both inserting after block X would compute the same key if they did it independently. In my design they can't: the position is computed inside the write transaction, under the page lock, so the second insert sees the first one's key as its neighbor.
3. **Running out of room.** Repeated inserts into one gap grow the key about one character per five inserts. When a key would exceed 48 characters — or when old data left two siblings with identical keys — the server rebalances that sibling list inside the same transaction: it rewrites every sibling's key with evenly spread values and logs each one as a `move`, so clients holding the old keys converge.

**Why the alternatives fail.** Integers turn one insert into a hundred writes and a hundred conflicts. The child list is a legitimate design — Notion itself is known for storing child ids on the parent — but it makes the parent row a hotspot for every insert under it, and moving a block between parents becomes a two-row update that must stay consistent.

**What I give up.** Unbounded key growth in pathological cases, paid for by an occasional rebalance that bumps every sibling's version. I'd watch the rebalance rate per page; if it's high, a client is doing something silly like dragging one block back and forth.

> "The repo implements this, including the rebalance; a test inserts 2,000 keys at random positions and checks they stay ordered and unique."

---

## 🔧 Deep Dive 2: Concurrent Edits (8 min)

"This is the heart of it. Ten people have a page open. What guarantees that everyone ends up with the same page?"

### The decision: a server-ordered log with per-block versions

1. Every change gets a **per-page sequence number** in the same transaction that applies it. Clients apply operations strictly in order; a gap means a lost message and triggers a replay.
2. Every block has a **version**. A write carries the version it was based on; if someone else saved first, the write fails with `409` and the current block.
3. Clients **rebase** on `409`: take the server's block, re-apply only the fields this user changed, retry.

```
 Ana                            Page API                   PostgreSQL    Ben
  │                                 │                           │         │
  │ 1 PATCH b7 {type: heading, v4}  │                           │         │
  │────────────────────────────────▶│                           │         │
  │                                 │ 2 version is 4: write v5  │         │
  │                                 │──────────────────────────▶│         │
  │ 3 200 {b7, v5}                  │                           │         │
  │◀────────────────────────────────│                           │         │
  │                                 │ 4 PATCH b7 {content, v4}            │
  │                                 │◀────────────────────────────────────│
  │                                 │ 5 version is 5, not 4     │         │
  │                                 │──────────────────────────▶│         │
  │                                 │ 6 409 {b7, v5}                      │
  │                                 │────────────────────────────────────▶│
  │                                 │       7 rebase own content onto v5  │
  │                                 │ 8 PATCH b7 {content, v5}            │
  │                                 │◀────────────────────────────────────│
  │                                 │ 9 200 {b7, v6}                      │
  │                                 │────────────────────────────────────▶│
  │                                 │                           │         │
```

"Ana made b7 a heading while Ben was typing in it. Ben's save is based on version 4, so it gets a `409`. His client keeps Ana's type, re-applies his text, and saves against version 5. Both changes survive. If they'd both changed the *text*, the later save wins — but knowingly, after a `409`, never by a stale client blindly overwriting."

### Why this works for Notion-style pages

Most edits are structural or land in different blocks: add a block, change a type, move something, type in your own paragraph. Per-block versions make those conflict-free. The case that loses data — two people typing in the *same paragraph* at the *same instant* — is rare, because the UI shows other people's cursors per block and people naturally avoid each other.

The sequence numbers give me convergence that's easy to reason about: every client replays the same log in the same order, duplicates are dropped by number, and a client that falls behind asks for exactly what it missed. It also keeps the server in charge: every change passes the permission check and validation before it exists.

### Why the alternatives fail here

| Approach | Verdict |
|----------|---------|
| ✅ Server-ordered log + per-block versions | Simple convergence, server-side permissions, conflicts detected |
| ❌ Broadcast edits, no ordering | Lost or reordered messages leave clients permanently different until reload |
| ❌ Last write wins by timestamp | Client clocks disagree by hundreds of milliseconds; the wrong edit wins |
| ⚠️ Operational transformation | Needs a central transformer per document and gets intricate with rich text and tree moves |
| ⚠️ Sequence CRDT everywhere (Yjs, Automerge) | Merges same-paragraph typing perfectly and works offline for days, but adds per-character metadata, tombstones that can't be collected while any replica might be offline, and a format the database can't query |

"What I give up is character-level merging inside one paragraph. If the product needed Google-Docs-style simultaneous typing in long paragraphs, I'd put a CRDT *inside text blocks only* and keep the server-ordered log for structure, permissions and history. That's an evolution of this design, not a rewrite."

### Where clocks still matter

"Within a page the sequence number is the order. I still stamp each operation with a hybrid logical clock — wall-clock milliseconds plus a logical counter — because history ('what did this page look like at 14:05') and offline edits from clients with skewed clocks need a time that never runs backwards. One practical trap: pack it into a 64-bit integer with bit shifts. Multiplying milliseconds by a million in a JavaScript number silently rounds the counter away — exactly the bug the repo had."

---

## 🔧 Deep Dive 3: Permission Inheritance (5 min)

"Sharing 'Engineering' with a contractor should share every page under it — unless a subpage has its own, narrower grant. Every request needs the effective permission."

**The decision: store only explicit grants, resolve by walking up.** Effective access is the nearest grant on the page or any ancestor; if there is none, the workspace role decides — admins get full access, members can edit, guests get nothing. One recursive query walks `parent_id` from the page to the root (bounded at 64 levels and cycle-safe) and picks the nearest grant.

**Why it works.** Shares, revokes and page moves are single-row writes and take effect on the next request. A page move automatically changes what's inherited, because inheritance is computed, not copied.

**Why materializing fails.** Precomputing an access list for every page makes reads a single lookup, but sharing a workspace root, or moving a big subtree under a differently shared parent, rewrites millions of rows. Until that rewrite finishes, part of the subtree has the old permissions — a window where a revoked contractor can still read.

**What I give up.** A tree walk on every request. Trees are shallow (under 10 levels typically), and in production I'd cache effective permission per (user, page) in Redis for a few seconds, invalidated on grant changes and moves. That puts "revocation within seconds" into the NFRs explicitly.

**Details that matter.**
- Sharing with someone outside the workspace adds them as a **guest**, so one shared page never opens the rest.
- A guest may see a page without seeing its parent; breadcrumbs and the sidebar must **omit ancestors** they can't see, or titles leak.
- Moving a page must check the **target** too: same workspace, edit permission there, and not inside the page's own subtree — a cycle would make every ancestor walk loop forever.
- Every id in a request is resolved **within** the authorized page. The repo's batch endpoint once checked access to page A and then updated any block id it was given, in any workspace. That's the classic insecure direct object reference, and it's why I scope every lookup by the page that passed the check.

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first:** one huge page (thousands of blocks makes the snapshot slow — paginate the block tree), one very hot page (the per-page lock, roughly 500 writes/s), and permission walks under heavy read load (cache them).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Pub/sub message lost | Nothing, or a sub-second delay | Gap detection → replay from the log |
| Gateway dies | Brief "reconnecting" | Reconnect anywhere with `sinceSeq` |
| Client offline | "Offline — changes will be saved" | Client save queue retries with backoff |
| API dies mid-write | One failed request | Transaction rolls back; creates are idempotent |
| Shard primary fails | Edits pause for that shard's workspaces | Synchronous replica promotion |
| Gap older than log retention | Page quietly reloads | `resync_required` → fresh snapshot |

**What I'd watch:** save p99 by route, the `409` rate (a spike means a hot block or a client bug), replay sizes and `resync_required` rate (publish loss), WebSocket connection churn, rebalance rate, and snapshot cache hit ratio.

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Storage | One row per block | One document per page | Edits touch one row |
| Order | Fractional keys + rebalance | Integers or a child list | One-row inserts, no parent hotspot |
| Collaboration | Server log + per-block versions | CRDT everywhere | Simple convergence, server-enforced permissions |
| Conflicts | Field-level LWW after `409` | Silent last write wins | No blind overwrites |
| Sequence | Counter in the page row | Postgres sequence or timestamps | Gap-free, so a hole means a lost message |
| Delivery | Redis pub/sub + log replay | Kafka or sticky routing | Fast; loss is detected and repaired |
| Permissions | Walk ancestors on read | Materialized ACLs | Shares and moves are one-row writes |

"With more time I'd put a CRDT inside text blocks for same-paragraph typing, add page-level operations to the log so sidebars update live, and build version history from daily snapshots plus the log."

# 📝 Notion — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one keystroke from the editor to every other open screen and back, and get the contracts between client and server right — because in a collaborative editor most bugs live exactly on that seam. Three contracts carry the design: a block **version** that makes saves safe to race, a per-page **sequence number** that lets a client prove it hasn't missed anything, and a **permission** the server computes from the page tree and the client renders honestly."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Targets on both sides of the wire |
| End-to-end architecture | 9 min | One diagram from the editor to PostgreSQL and back, plus the core flows |
| Data model & API contract | 7 min | Server tables, the client store, and the fields both sides rely on |
| Deep dive 1: saving every keystroke safely | 8 min | Save queue, versions, retries without duplicates |
| Deep dive 2: live updates that converge | 8 min | Sequence numbers, replay, reconnects |
| Deep dive 3: sharing end to end | 5 min | Permission walk on the server, honest UI on the client |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Pages made of blocks (paragraphs, headings, lists, toggles, code) that several people edit at once; presence (who's here, which block they're in); a page tree per workspace with a sidebar; sharing at view, edit or full-access level that applies to everything under the shared page; databases shown as table, board or list; edits that survive a flaky network. Out of scope: comments, history UI, templates, uploads, AI.

| Side | Requirement | Target |
|------|-------------|--------|
| Frontend | Typing | Rendered in the same frame; never waits on the network |
| Frontend | Page open | p95 < 1 s for 500 blocks; LCP < 2 s |
| Frontend | Responsiveness | INP < 200 ms while remote edits stream in |
| Backend | Save | p99 < 200 ms server-side |
| Backend | Propagation | p99 < 500 ms from commit to every open client |
| Both | Convergence | Every client ends with the server's page, even after lost or duplicated messages |
| Both | Offline | Edits made without a connection are kept and saved on reconnect |
| Both | Permissions | A viewer can't edit, a revoked user loses access within seconds |

**Scale.** 20M daily users, ~3M open sockets at peak, ~300K block saves per second across the fleet, ~1M socket messages per second of fan-out. But the busiest *single* page sees maybe 50 saves a second, and that's the number that shapes the design: I can afford to serialize writes per page.

"On the client, the equivalent number is the save rate per user. If I sent a request per keystroke, a fast typist would generate 8 writes a second for one block, they'd race each other over separate connections, and the slowest could land last and erase the newest text. So the client needs a save queue as much as the server needs a lock."

---

## 🏗️ End-to-End Architecture (9 min)

```
  ┌────────────────────────────────────────────────────────────────────────────────────────────┐
  │ SPA · editor store (blocks, lastSeq, per-block save queues) · IndexedDB outbox             │
  │ TanStack Query for page tree and database rows · URL holds page and view ids               │
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

1. **Save (1).** The editor store shows the change immediately and queues a save. The save carries the block's new fields and the version the edit was based on. The Page API checks permission, locks the page, compare-and-swaps the block, appends an operation with the page's next sequence number, commits, and publishes the operation on Redis.
2. **Receive (2).** The page holds a WebSocket subscribed with the last sequence number the store applied. The gateway replays anything newer from the log and then pushes live operations; the store applies them strictly in order.
3. **Index (3).** Committed operations flow through a transactional outbox to Kafka and into Elasticsearch, off the request path.

| Layer | Choice | Why |
|-------|--------|-----|
| Editor state | A local replica in a Zustand store: blocks, `lastSeq`, save queues | The document is edited locally and reconciled with a log — not a request/response cache |
| Other server state | TanStack Query (page tree, database rows) | Ordinary cached reads with refetch and invalidation |
| Offline | Save queue persisted to IndexedDB | Edits survive a closed tab |
| Page API | Stateless REST service | Writes need status codes; the only place operations are created |
| Sync gateway | Stateless WebSocket fleet | Scales by connection count; any server can serve any page |
| PostgreSQL | Sharded by workspace | Transactions for the write path, recursive queries for permissions |
| Redis | Pub/sub per page, presence | Low-latency doorbell; loss is repaired by replay |

"Notice the split on the client: the open page is a *replica* with its own sync protocol, everything else is a cache. Putting the document in TanStack Query would fight its refetch model; putting the page tree in a hand-written store would mean hand-writing invalidation."

### Flow: one edit, two browsers

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

"Two details cross the seam here. In step 6 the editor learns the new version — it needs it for its next save. And the editor *also* receives operation 128 over its own socket. It doesn't special-case its own echo: it applies operations by sequence number, and never replaces a block with an older version, so the echo is a no-op."

### Flow: sharing a page

```
Owner UI                        Page API                           PostgreSQL   Guest UI
    │                               │                                   │           │
    │ 1 PUT /pages/eng/permissions  │                                   │           │
    │──────────────────────────────▶│                                   │           │
    │                               │ 2 walk ancestors: full_access?    │           │
    │                               │──────────────────────────────────▶│           │
    │                               │ 3 add guest member; upsert grant  │           │
    │                               │──────────────────────────────────▶│           │
    │ 4 200 {grant}                 │                                   │           │
    │◀──────────────────────────────│                                   │           │
    │                               │ 5 GET /pages?workspace_id=w                   │
    │                               │◀──────────────────────────────────────────────│
    │                               │ 6 walk down, carry nearest grant  │           │
    │                               │──────────────────────────────────▶│           │
    │                               │ 7 Engineering + subpages (view)               │
    │                               │──────────────────────────────────────────────▶│
    │                               │                8 parent hidden: show as root  │
    │                               │                                   │           │
```

"The server computes, the client renders. Step 7 returns each page with the guest's effective permission, so the UI can make the editor read-only without knowing anything about inheritance rules."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Table | Key columns | Notes |
|-------|-------------|-------|
| `pages` | `id`, `workspace_id`, `parent_id`, `position`, `last_op_seq`, `title` | `last_op_seq` is the head of the page's log |
| `blocks` | `id` (client-chosen UUID), `page_id`, `parent_block_id`, `type`, `content`, `position`, `version` | `(page_id, parent_block_id, position)` loads a page in order |
| `operations` | `(page_id, seq)`, `type`, `block_id`, `data` (block after the change), `hlc` | Gap-free per page; 7 days hot |
| `page_permissions` | `(page_id, user_id)`, `permission` | Only explicit grants |
| `workspace_members` | `(workspace_id, user_id)`, `role` | Default when no grant applies |

### Client side

| State | Shape | Owner |
|-------|-------|-------|
| Open page | `blocks[]` sorted by `(position, id)`, `lastSeq`, `permission` | Editor store (Zustand) |
| Save queues | Per block: `pending` fields, `sending` fields, `baseVersion`, retry count | Editor store, persisted to IndexedDB |
| Page tree | `['pages', workspaceId]` with each page's `permission` | TanStack Query |
| Database rows | `['database', id, viewId]` | TanStack Query |
| Current page and view | `/page/$pageId?view=…` | URL |

### The contract

```
GET   /api/pages/{id}            → {page, blocks, seq, permission}
POST  /api/blocks                {id, page_id, after_block_id, type, content} → 201 | 200 replay
PATCH /api/blocks/{id}           {fields, expected_version} → 200 {block} | 409 {block}
PUT   /api/pages/{id}/permissions {email, permission} → 200 {grant}
WS    subscribe {pageId, sinceSeq} → sync {ops, headSeq} | resync_required, then op {seq, block}
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `expected_version` → `409 {block}` | A write applies only to the version the client saw; the reply carries the current block | Rebase its own fields and retry without a refetch |
| Client-chosen block `id` | A repeated create returns the existing block with `200` | Retry creates after timeouts without duplicates |
| `seq` on snapshot and ops | Contiguous per page; never reused, never skipped | Detect any lost message by arithmetic |
| `subscribe {sinceSeq}` | Replays everything after `sinceSeq`, or says `resync_required` | Resume after a reconnect without reloading |
| `permission` on pages | Effective access computed from the tree | Render read-only editors and hide share controls |
| Socket carries no writes | Every edit goes through REST with a status code | Know when a save failed and why |

---

## 🔧 Deep Dive 1: Saving Every Keystroke Safely (8 min)

"The scenario: I type a sentence into a block on a train. Requests time out, a colleague changes the same block's type, and I hit Enter to create a new block before the first save returns. Nothing I typed should be lost, nothing should be saved twice, and the server should never overwrite my colleague blindly."

```
User        BlockComponent                 Editor store                  Page API
  │                │                             │                           │
  │ 1 types "hel"  │                             │                           │
  │───────────────▶│                             │                           │
  │                │ 2 updateBlock(b7, content)  │                           │
  │                │────────────────────────────▶│                           │
  │               3 render now, debounce 300 ms  │                           │
  │                │                             │ 4 PATCH b7 {"hel", v4}    │
  │                │                             │──────────────────────────▶│
  │ 5 types "lo"   │                             │                           │
  │───────────────▶│                             │                           │
  │                │ 6 updateBlock(b7, content)  │                           │
  │                │────────────────────────────▶│                           │
  │                │                             │ 7 b7 in flight: coalesce  │
  │                │                             │ 8 200 {b7, v5}            │
  │                │                             │◀──────────────────────────│
  │                │                             │ 9 PATCH b7 {"hello", v5}  │
  │                │                             │──────────────────────────▶│
  │                │                             │ 10 200 {b7, v6}           │
  │                │                             │◀──────────────────────────│
  │                │                             │                           │
```

**Client half.** Each block has a save queue. Typing updates the store immediately and schedules a save after a 300 ms pause. Only one request per block is ever in flight; edits made meanwhile are coalesced into the next request (step 7). That removes the "slow request lands last" bug entirely, and cuts a typist's eight requests a second to two or three. Each request carries the version the edit is based on.

**Server half.** The Page API compare-and-swaps on that version inside the page transaction. If a colleague saved first, it answers `409` with the current block. The client then takes the server's block — keeping the colleague's type change — re-applies only the fields this user changed, and retries. Failures are classified: `409` rebases, `404` means the block was deleted by someone else, `403` means access changed (drop the edit and reload), and network errors keep the edit and retry with backoff while the header says "Offline — changes will be saved".

**New blocks.** The client generates the block's UUID and an optimistic position (the same fractional-key function the server uses), so it can render the block and even queue edits to it before the server answers. Updates to a block wait behind its create in the same queue. A create that times out is retried with the same id; the server returns the existing block with `200` instead of creating a twin.

| Approach | Verdict |
|----------|---------|
| ✅ Per-block queue + `expected_version` + client ids | No lost keystrokes, no duplicates, conflicts detected |
| ❌ A request per keystroke | Requests race; the slowest can land last and erase newer text |
| ❌ Last write wins without versions | A stale tab silently overwrites a colleague's change |
| ❌ Server-generated ids | A retried create after a timeout makes a duplicate block |

"What I give up: two people typing in the *same* field of the same block still resolve as last-writer-wins after the rebase. If that became common, I'd move text inside blocks to a CRDT — the save queue would then send CRDT updates instead of whole fields, and the rest of the design stays."

---

## 🔧 Deep Dive 2: Live Updates That Converge (8 min)

"Broadcasting edits is easy. Making ten clients end up identical when messages get lost, duplicated, reordered, or arrive while a laptop sleeps — that's the actual problem."

**The server half** gives every committed operation a per-page sequence number in the write transaction. The counter lives in the page row, so a rolled-back write never consumes a number: the sequence is gap-free, and a gap on the client *always* means a lost message. Delivery uses Redis pub/sub, which is fast but can drop messages — acceptable, because the operation log in PostgreSQL can replay anything.

**The client half** keeps `lastSeq` and applies an operation only when its number is `lastSeq + 1`.

```
 WebSocket                  Editor store                 Page editor
     │                            │                           │
     │ 1 op seq 41 (lastSeq 40)   │                           │
     │───────────────────────────▶│                           │
     │                            │ 2 apply b3 v9, re-render  │
     │                            │──────────────────────────▶│
     │ 3 op seq 43                │                           │
     │───────────────────────────▶│                           │
     │ 4 gap: sync {sinceSeq 41}  │                           │
     │◀───────────────────────────│                           │
     │ 5 sync {ops 42, 43}        │                           │
     │───────────────────────────▶│                           │
     │                            │ 6 apply both, lastSeq 43  │
     │                            │──────────────────────────▶│
     ··········· network drops, socket reconnects ·············
     │ 7 subscribe {p1, sinceSeq 43}                          │
     │ 8 sync {ops 44..47}        │                           │
     │───────────────────────────▶│                           │
     │                            │                           │
```

- **Lower or equal numbers are duplicates** and are dropped; a block is never replaced by an older version. Replays that overlap live messages are therefore harmless.
- **A higher number means a gap**: the store asks for `sync {sinceSeq}` and the server replays from the log.
- **Reconnect is a resubscribe** with the current `lastSeq`. The WebSocket client remembers the subscription and resends it on every open, so a sleeping laptop catches up with exactly what it missed — no page reload, no lost cursor position.
- **Too far behind** (gap beyond the replay limit or the log's retention): the server says `resync_required`, the client reloads the snapshot and re-applies its unsaved fields on top.
- **Remote edits never clobber local typing**: when an operation arrives for a block with unsaved local fields, the store shows the server's block with the local fields layered on top.
- **Dead connections are detected** both ways: the server pings every 30 seconds and drops sockets that don't answer; the server's heartbeat lets the client notice a silent server and reconnect with jittered backoff.

"This also makes caching easy. The snapshot endpoint returns blocks *plus* the sequence number they reflect, so the server can serve it from a slightly stale cache: the client subscribes from that number and the replay fills the difference."

| Approach | Verdict |
|----------|---------|
| ✅ Gap-free `seq` + replay from a log | Convergence by arithmetic; loss is always repaired |
| ❌ Broadcast only | One dropped message and a client is wrong until reload |
| ❌ Timestamps for order | Clock skew reorders edits; can't detect loss |
| ❌ Kafka straight to browsers | Durable but slow to fan out per page, and browsers can't consume it |
| ❌ Writes over the socket | No status code; a dropped connection silently loses an edit the user saw appear |

---

## 🔧 Deep Dive 3: Sharing End to End (5 min)

"Permissions live on the server, but the client has to present them honestly: a viewer shouldn't see a cursor in a paragraph they can't change, and a guest shouldn't see titles of pages above the one shared with them."

**Server.** Only explicit grants are stored. Effective access is the nearest grant on the page or any ancestor; without one, the workspace role decides (admins: full access, members: edit, guests: none). One recursive query walks up the tree for a single page; one walks down from the roots for the sidebar, carrying the nearest grant to each child. Shares and moves are one-row writes, so they take effect on the next request. Every block id in a request is resolved within the page that passed the check — a batch that names someone else's block gets `404`.

**Client.** The snapshot and the page tree carry `permission`. With `view`, the editor renders blocks without `contentEditable`, hides block handles and the slash menu, and shows a "View only" badge. A guest's shared page may have an invisible parent; the sidebar treats such a page as a root, and breadcrumbs simply omit hidden ancestors. Sharing UI is shown only with `full_access`.

**Revocation.** The next REST call is rejected immediately; open sockets are rechecked when they resubscribe, and in production a permission change publishes an event that makes affected gateways recheck their subscribers within seconds. A `403` on a save makes the client drop the edit and reload — the user sees the page become read-only rather than a silent failure.

| Approach | Verdict |
|----------|---------|
| ✅ Walk ancestors on read, `permission` in responses | One-row shares and moves; the UI just renders a field |
| ❌ Materialized ACL per page | Sharing a root rewrites millions of rows; partial rewrites leak |
| ❌ Client computes inheritance | Duplicates rules, needs the whole tree, and is never authoritative |

---

## 📈 Failures & Scale (2 min)

| Failure | What the editor sees | What collaborators see | Mitigation |
|---------|---------------------|------------------------|------------|
| Pub/sub message lost | Nothing | A sub-second delay | Gap → replay |
| Socket drops | "Reconnecting…", edits keep saving over REST | Presence disappears briefly | Resubscribe with `sinceSeq` |
| Offline | "Offline — changes will be saved" | Nothing new from this user | Save queue in IndexedDB, retry with backoff |
| Concurrent edit of the same block | Nothing (rebased automatically) | Both changes, if different fields | `409` → rebase |
| Access revoked | Editor turns read-only | — | `403` → reload with new permission |
| Shard primary fails | Saves pause, keep queuing | Same | Replica promotion |

**What breaks first as we grow:** very large pages (paginate the block tree and virtualize rendering), one very hot page (the per-page lock, ~500 writes/s), and permission walks under load (cache per user and page for a few seconds).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Save path | Per-block queue + `expected_version` | Request per keystroke | No races, conflicts detected |
| Creates | Client-chosen ids | Server ids + idempotency keys | Retry-safe and renderable before the server answers |
| Order and loss | Gap-free `seq` + log replay | Broadcast or timestamps | Convergence by arithmetic |
| Writes | REST | Socket messages | Status codes and retries |
| Client state | Replica store for the page, Query cache for the rest | One store for everything | Different sync models |
| Permissions | Server walks the tree; client renders `permission` | Materialized ACLs | One-row shares; honest UI |

"With more time: persist the save queue in IndexedDB so edits survive a closed tab, add page-level operations to the log so renames and moves show up in collaborators' sidebars live, and move text inside blocks to a CRDT."

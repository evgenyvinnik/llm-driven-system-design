# Notion (Block-Based Collaborative Workspace) — Architecture

## System Overview

Notion is a workspace of nested pages. A page is an ordered tree of blocks — paragraphs, headings, to-dos, toggles, code — and a database is a page whose children are structured rows shown as tables, boards or lists. Several people edit the same page at once, sharing is per page and flows down the page tree, and the app has to keep working through a flaky connection.

Three things make it a real design problem:

1. **Ordering without renumbering.** Blocks are independent rows that many people insert between concurrently. Integer positions would force a renumbering write on every insert; fractional keys make an insert a single-row write.
2. **Convergence, not just broadcast.** Every client must end up with the same page even when messages are lost, reordered or delivered twice. The design gives every change on a page a gap-free sequence number from the server, so a client can tell that it missed something and replay it from an operation log.
3. **Permissions that inherit.** Sharing a page shares everything beneath it, and a deeper page can override that. Every read and write has to answer "what may this user do here?" by walking up the tree.

This document describes the production-scale design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Valkey + RabbitMQ + React implementation actually does.

**Learning goals**

- The block-as-row data model with parent pointers, and fractional indexing for sibling order (including when keys run out of room).
- A server-ordered operation log: per-page sequence numbers, per-block versions with compare-and-swap, and replay-based catch-up.
- Real-time fan-out across many WebSocket servers with Redis pub/sub as a doorbell rather than a source of truth.
- Permission inheritance down a tree, resolved by walking ancestors.
- Where block-level last-writer-wins stops being enough, and what a CRDT would add.

## Requirements

### Functional requirements

1. **Edit** pages made of blocks: create, edit, change type, move, nest, delete.
2. **Collaborate** in real time: see other people's edits within a second, see who else is on the page and which block they are in.
3. **Organize** pages in a tree per workspace, with a sidebar and breadcrumbs.
4. **Share** a page with a person at view, edit or full-access level; the grant applies to every page beneath it unless a deeper grant overrides it. Guests see only what was shared with them.
5. **Databases**: pages with a property schema whose rows are shown as table, board or list views, each with its own filter, sort and grouping.
6. **Survive bad networks**: edits made while disconnected are kept and saved when the connection returns.

Out of scope: comments, page history UI, templates, file uploads, public web publishing, AI features.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Local edit latency | Keystroke rendered in the same frame (< 16 ms) | Editing must never wait on the network |
| Save latency | p99 < 200 ms server-side per block write | Users watch the "Saving…" indicator |
| Propagation | p99 < 500 ms from commit to every open client | Collaborators react to each other's edits |
| Page open | p95 < 1 s for a 500-block page | The most common action in the product |
| Availability | 99.99% for reads and edits | It is many teams' system of record |
| Durability | No acknowledged edit is ever lost | A `200` on save is a promise |
| Convergence | All clients reach the server's state, even after lost or duplicated messages | Divergent copies are worse than slow ones |
| Permission changes | Effective on the next request; open sockets within seconds | Revoking access is a security action |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Users | 100M registered, 20M daily active | Everything is partitioned by workspace |
| Concurrent connections | ~3M open WebSockets at peak | ~60 gateway servers at 50K sockets each |
| Blocks stored | ~200 billion rows × ~1 KB with indexes ≈ 200 TB | Sharded PostgreSQL, keyed by workspace |
| Block writes | ~1M concurrent editors × ~0.3 saves/s ≈ 300K writes/s peak | Writes spread over hundreds of logical shards |
| Page opens | 20M DAU × 30 opens/day ≈ 7K/s average, 20K/s peak, ~100 KB each | Snapshot cache; read replicas |
| Fan-out | 300K ops/s × ~3 viewers ≈ 1M socket messages/s | Pub/sub per page; gateways only deliver |
| Operation log | ~100K ops/s average × ~500 B ≈ 4 TB/day | Partition by day; keep 7 days hot, archive the rest |
| Hottest page | ~50 editors × 1 save/s = 50 writes/s | Per-page serialization is affordable (ceiling ~500/s) |

The per-page number matters most for the write path: every write to a page takes a short lock on that page's row to get the next sequence number. At ~2 ms per transaction a single page can absorb about 500 writes per second, ten times the busiest realistic page. Contention is per page, so 300K writes/s across millions of pages never meet.

### Local Development Scale

One Express process serving both REST and WebSocket, PostgreSQL, Valkey, RabbitMQ and the Vite dev server; `dev:server2`/`dev:server3` start more instances against the same PostgreSQL and Redis to exercise cross-instance fan-out. A handful of users and pages; ports and setup are in the [README](./README.md).

## High-Level Architecture

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

1. **Edit (1).** The editor saves a changed block with `PATCH /api/blocks/{id}` and the version it last saw. The Page API checks the caller's permission by walking up the page tree, then in one PostgreSQL transaction locks the page row, updates the block if its version still matches, appends the change to the operation log with the page's next sequence number, and commits. Only then does it publish the operation on the page's Redis channel.
2. **Subscribe and catch up (2).** Every open page holds a WebSocket to a Sync gateway, subscribed with the last sequence number the client applied. The gateway subscribes to `page:{id}` on Redis, replays anything after that number from the operation log, and from then on pushes each published operation. A client that sees a gap in the numbers asks for a replay.
3. **Index (3).** Operation rows are relayed to Kafka from the same transaction that wrote them (transactional outbox), and the search indexer updates Elasticsearch from that stream. Search never sits on the edit path.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, session check, routes `/api/*` and `/ws` | Connections | WebSockets need no stickiness: any gateway can serve any page |
| Page API | Permission checks, block and page writes, snapshots, sharing | Writes and page opens | Stateless; the write transaction is the only place an operation is created |
| Sync gateway | Socket subscriptions, replay from the log, presence | Open sockets (~50K per server) | Holds no state that is not in Redis or PostgreSQL |
| PostgreSQL | Pages, blocks, operation log, permissions | Data volume and write rate | Sharded by `workspace_id`, so a page, its blocks and its log live together |
| Redis | `page:{id}` pub/sub, presence, snapshot and permission caches | Fan-out rate | Losing a message costs a replay, never data |
| Kafka `page-changes` | Durable stream of committed operations | Write rate | Feeds search, notifications, analytics |
| Search indexer | Batches page text into the search index | Kafka lag | Idempotent by `(page_id, seq)` |
| Elasticsearch | Full-text search per workspace | Corpus size | Filtered by the user's visible pages at query time |

The Page API and the Sync gateway are split because their resources differ: the gateway holds millions of long-lived connections and almost no CPU per message, the API does short CPU- and database-bound requests. They share nothing in memory, which is what lets any gateway serve any page.

## Core Components / Request Flows

### Saving a block edit

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

- **Steps 2–5 are one transaction.** Locking the page row (`SELECT … FOR NO KEY UPDATE`) serializes writers to that page, which gives three properties at once: a total order of operations, positions computed from neighbors that cannot change underneath the insert, and a sequence number with no holes. The counter lives in the page row and is updated inside the transaction, so a rolled-back write does not consume a number. A PostgreSQL `SEQUENCE` would: `nextval()` is not transactional, and a hole would look to every client like a lost message.
- **Step 3 is compare-and-swap.** The client sends the version its edit was based on. If someone else saved first, the update matches zero rows and the API answers `409` with the current block (see [Handling a conflict](#handling-a-conflict)).
- **Steps 7–10 happen after commit.** Redis pub/sub is fire-and-forget; if the publish is lost, the next operation on the page arrives with a gap and the viewer replays the missing one. If the page then goes quiet, the client catches up on its next reconnect, or when the gateway's Redis subscriber reconnects and tells local clients to check.
- The editor does not wait for step 9: it already shows its own change and updates the block's version from the `200`.

### Opening a page and catching up

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

- A page open is a snapshot (`GET /api/pages/{id}`, which returns blocks plus the `seq` they reflect) followed by `subscribe {sinceSeq: seq}`. The gateway subscribes to Redis *before* reading the replay, so every operation is either in the replay or arrives live; duplicates are dropped by sequence number.
- Because the snapshot carries its sequence number, it can be served from a cache that is a few seconds stale: the replay fills the difference. That turns cache invalidation from a correctness problem into a performance optimization.
- If the gap is larger than the replay limit (1,000 operations) or older than the log's retention, the gateway answers `resync_required` and the client reloads the snapshot, keeping its own unsaved edits on top.

### Handling a conflict

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

- Ana and Ben both loaded version 4 of block b7. Ana's type change commits as version 5. Ben's text edit, still based on version 4, gets a `409` with the current block.
- Ben's client rebases: it takes version 5 (Ana's heading type) and re-applies only the fields Ben changed (the text), then retries against version 5. The final block has Ana's type and Ben's text.
- This is field-level last-writer-wins that is *detected*: no stale client overwrites a newer version blindly. When two people change the *same* field of the same block at the same moment, the later save still replaces the earlier one; merging characters inside a paragraph needs a sequence CRDT ([Key Design Decisions](#3-a-server-ordered-operation-log-with-per-block-versions-not-a-text-crdt)).

### Sharing a page

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

- Permissions are stored only where a grant was made (`page_permissions`), and resolved by walking up the tree: the nearest grant on the page or an ancestor wins; without one, the workspace role decides (admins: full access; members: edit; guests: nothing). Steps 2 and 6 are one recursive query each.
- Sharing with someone outside the workspace adds them as a guest, so one shared page never opens the rest of the workspace.
- A guest can see a subpage without seeing its parent; the sidebar shows such a page as a root, and breadcrumbs leave out ancestors the user cannot see.

### Background work

Search indexing, notifications, page exports and emails run from queues, never on the request path. Each job type has its own queue because their delivery needs differ by orders of magnitude: a live-presence event is worthless after 30 seconds and must never be retried, while an export is expensive, user-visible and still useful hours later.

| Queue | Prefetch | Retries | Message TTL | Purpose |
|-------|----------|---------|-------------|---------|
| `fanout` | 50 | 0, no DLQ | 30 s | Best-effort realtime side events |
| `notifications` | 10 | 3 + DLQ | 1 h | Mentions, share notices |
| `export` | 2 | 5 + DLQ | 24 h | PDF and Markdown exports (heavy; low prefetch keeps one worker from hoarding jobs) |
| `email` | 10 | 3 + DLQ | 24 h | Invites, share emails |
| `search` | 10 | 3 + DLQ | 1 h | Index updates (idempotent upserts) |

## Database Schema

### Production schema

The shard key is `workspace_id`: a page, its blocks, its operation log and its grants always live on the same shard, so the write transaction and the permission walk never cross shards.

```sql
CREATE TABLE workspace_members (
  workspace_id UUID NOT NULL,
  user_id      UUID NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE pages (
  id                UUID PRIMARY KEY,
  workspace_id      UUID NOT NULL,
  parent_id         UUID REFERENCES pages(id),          -- upward pointer: permission walk, breadcrumbs
  title             TEXT NOT NULL DEFAULT 'Untitled',
  is_database       BOOLEAN NOT NULL DEFAULT false,
  properties_schema JSONB NOT NULL DEFAULT '[]',        -- column definitions when is_database
  position          TEXT COLLATE "C" NOT NULL,          -- fractional key among siblings
  last_op_seq       BIGINT NOT NULL DEFAULT 0,          -- head of this page's operation log
  is_archived       BOOLEAN NOT NULL DEFAULT false,
  created_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pages_children ON pages (workspace_id, parent_id, position);

CREATE TABLE blocks (
  id              UUID PRIMARY KEY,                     -- chosen by the client: creates are retry-safe
  page_id         UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_block_id UUID REFERENCES blocks(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  properties      JSONB NOT NULL DEFAULT '{}',
  content         JSONB NOT NULL DEFAULT '[]',          -- rich text runs
  position        TEXT COLLATE "C" NOT NULL,
  version         INTEGER NOT NULL DEFAULT 0,           -- compare-and-swap on every write
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX blocks_siblings ON blocks (page_id, parent_block_id, position);

CREATE TABLE operations (
  page_id    UUID NOT NULL,
  seq        BIGINT NOT NULL,                           -- gap-free per page
  id         UUID NOT NULL,
  block_id   UUID NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('insert', 'update', 'delete', 'move')),
  data       JSONB NOT NULL,                            -- block row after the change
  author_id  UUID,
  hlc        BIGINT NOT NULL,                           -- hybrid logical clock, for history
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, seq, created_at)
) PARTITION BY RANGE (created_at);                      -- daily partitions, 7 days hot

CREATE TABLE page_permissions (
  page_id    UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit', 'full_access')),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX page_permissions_user ON page_permissions (user_id);
```

- `COLLATE "C"` makes `ORDER BY position` byte-wise, matching how keys are generated. Keys use only `a`–`z`, so locale collations agree too, but the explicit collation removes the question.
- The operation log doubles as the outbox: a change-data-capture connector tails inserts into `operations` and publishes them to Kafka, so search and notifications can never miss a committed edit or see one that rolled back.
- Database rows are pages with a `properties` map (as in Notion itself), so a row can hold blocks and be shared like any page.

### Local schema

The local schema lives in [`backend/src/db/init.sql`](./backend/src/db/init.sql) (re-runnable; loaded by Docker Compose on a fresh volume) with seed data in [`backend/db-seed/seed.sql`](./backend/db-seed/seed.sql).

| Production | Local | Difference |
|------------|-------|------------|
| `pages` | `pages` with `last_op_seq` | No `COLLATE "C"`; no sharding |
| `blocks` | `blocks` | Same shape; `idx_blocks_siblings (page_id, parent_block_id, position)` |
| `operations` (partitioned) | `operations` with `seq` and a unique `(page_id, seq)` index | Not partitioned, never pruned; `timestamp` holds the packed HLC; rows from before seqs existed have `seq` NULL |
| Database rows as pages | `database_rows` (`properties` JSONB) and `database_views` | Rows are not pages and are not in the operation log |
| `page_permissions`, `workspace_members` | Same | Seeded guest `guest@notion.local` with view on "Getting Started" |
| Sessions in Redis | `session:{token}` in Valkey; a `sessions` table exists but is unused | — |
| Outbox → Kafka | Best-effort publish to RabbitMQ `notion.search` after commit | Not transactional |

## API Design

### Production API

```
GET    /api/pages?workspace_id=…              visible page tree, each page with the caller's permission
POST   /api/pages                             create page or database (edit on the parent)
GET    /api/pages/{id}                        page + blocks snapshot + seq + permission
PATCH  /api/pages/{id}                        rename, move (cycle and workspace checks)
GET    /api/pages/{id}/permissions            grants that apply, marked inherited or direct
PUT    /api/pages/{id}/permissions            {email, permission} → share (full_access)
DELETE /api/pages/{id}/permissions/{userId}   revoke a direct grant
POST   /api/blocks                            {id, page_id, after_block_id, type, content} → 201 | 200 replay
PATCH  /api/blocks/{id}                       {fields, expected_version} → 200 | 409 {block}
POST   /api/blocks/{id}/move                  {after_block_id | parent_block_id}
DELETE /api/blocks/{id}                       delete block and children
POST   /api/blocks/batch                      several operations on one page, one transaction
WS     /ws                                    subscribe {pageId, sinceSeq} · sync {sinceSeq} · presence
```

- **Idempotency without a header.** Block creation is the only non-idempotent write, and the client chooses the block's UUID: a retried create finds the row and returns it with `200`. Updates are naturally idempotent given `expected_version` (a replayed update gets `409` with the block that already contains it).
- **`409` carries the current block**, so the client can rebase without another round trip. `If-Match: "4"` is accepted as an alternative to `expected_version`.
- **The socket never carries writes.** Edits go over REST, where they get a status code; the socket delivers committed operations `{seq, op_id, type, block_id, block}` plus `sync`, `resync_required`, `presence` and `heartbeat` messages.
- Errors are `{error, ...context}` today; production would use `application/problem+json` (RFC 9457).

### Local routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register`, `/login`, `/logout`; GET `/api/auth/me` | Session auth (cookie or bearer token) |
| GET, POST, PATCH, DELETE | `/api/workspaces`, `/api/workspaces/:id`, `/:id/members` | Workspaces (membership checks) |
| GET, POST | `/api/pages`; GET, PATCH, DELETE `/api/pages/:id`; GET `/api/pages/:id/tree` | Page tree, snapshot with `seq` and `permission`, breadcrumbs |
| GET, PUT, DELETE | `/api/pages/:id/permissions[/:userId]` | Sharing |
| GET, POST | `/api/blocks`; PATCH, DELETE `/api/blocks/:id`; POST `/api/blocks/:id/move`, `/api/blocks/batch` | Block reads and the sequenced write path |
| GET, POST, PATCH, DELETE | `/api/databases/:id`, `/rows[/:rowId]`, `/views[/:viewId]`, `/schema` | Databases (view to read, edit to change) |
| WS | `/ws?token=…` | `subscribe`, `unsubscribe`, `sync`, `presence` |
| GET | `/health`, `/ready`, `/metrics` | Operations |

## Key Design Decisions

### 1. Blocks are rows with parent pointers, not one document per page

Each block is its own row with `page_id`, `parent_block_id`, `type` and JSONB payloads. Turning a paragraph into a heading is a one-column update, moving a block is a pointer change, and two people editing different blocks of the same page touch different rows. Storing a page as one JSON document would make every keystroke rewrite the whole page and turn every concurrent edit into a conflict on one value. The cost is reads: opening a page is a query for hundreds of rows instead of one, which the snapshot cache and the `(page_id, parent_block_id, position)` index absorb, and very large pages need pagination of the block tree.

### 2. Fractional keys on the children, not an ordered child list on the parent

Each block carries a `position` string over `a`–`z` read as a base-26 fraction; inserting between two siblings generates a key strictly between theirs. The alternative Notion itself is known for is an ordered array of child ids on the parent block. A child list makes reordering a single update to the parent, but every concurrent insert into the same parent then contends on that one row and needs list operations ("insert after X") applied server-side rather than overwriting the array. Fractional keys make an insert touch only the new row, and "load this page in order" is one index scan. What we give up is bounded key length: repeated inserts into the same gap grow the key about one character per five inserts. Keys never end in `a` (the zero digit — `b` and `ba` are the same fraction, so nothing fits between them), and when a gap is exhausted (duplicate keys left by old data, or keys past 48 characters), the server rewrites that sibling list with evenly spread keys inside the same transaction and logs each change as a `move`, so clients converge on the new keys.

### 3. A server-ordered operation log with per-block versions, not a text CRDT

The server assigns every change a per-page sequence number in the transaction that applies it, and every block carries a version checked on write. Clients apply operations strictly in order and detect gaps. This makes convergence simple to reason about — all clients replay the same log — and lets the server enforce permissions and validation on every change. A sequence CRDT (Yjs, Automerge) merges concurrent typing inside one paragraph character by character and works peer-to-peer and offline for long periods; it is the right tool for a code editor or a long shared document where two people type in the same paragraph all day. For block-structured pages, most edits are structural or touch different blocks, where per-block versions already avoid conflicts; the remaining case — two people typing in the same paragraph at the same instant — resolves as last-writer-wins on that field, after a `409` that tells the client it happened. The CRDT's costs are per-character metadata, tombstones that cannot be collected while any replica might be offline, and a document format the database cannot query. The natural evolution is a CRDT *inside* text blocks only, with the server-ordered log for everything structural.

### 4. Hybrid logical clocks for history, sequence numbers for order

Each operation also carries a hybrid logical clock (wall-clock milliseconds plus a logical counter, packed into a 64-bit integer). Within one page the sequence number is the order; the clock gives operations a monotonic, roughly wall-clock time across pages and servers for history ("what did this page look like at 14:05") and for ordering offline edits from clients whose clocks disagree. Wall-clock timestamps alone would let a fast laptop's edit sort before the edit it replied to.

### 5. Redis pub/sub as a doorbell, the log as the source of truth

After commit, the Page API publishes each operation on `page:{id}`; every gateway with a subscriber for that page forwards it. Pub/sub is chosen for latency (sub-millisecond, no disk) and because a page channel exists only while someone has the page open. It loses messages during a disconnect, and that is acceptable precisely because nothing depends on it: the sequence number exposes the loss and the log repairs it. Making Kafka the delivery path would give durability the design does not need, add tens of milliseconds, and require a consumer per gateway reading every page's traffic. Sticky routing of all of a page's sockets to one server would remove the fan-out hop but turn one popular page into a hot server and complicate failover.

### 6. Permissions are resolved by walking up the tree on read

Only explicit grants are stored; effective access is computed by one recursive query that walks `parent_id` to the root and picks the nearest grant. Grants, revokes and page moves are single-row writes and take effect on the next request. Materializing an access list on every page would make reads a single lookup, but a move or a share on a workspace root would rewrite millions of rows, and a crash mid-rewrite leaves a subtree half-shared. The cost is the walk on every request (tree depth is typically under 10, bounded at 64), which production caches per `(user, page)` in Redis for a few seconds and invalidates on grant changes and moves.

## Consistency and Idempotency

- **Per-page total order.** Writes to a page serialize on its row lock; sequence numbers are contiguous because the counter is updated in the same transaction. Writes to different pages never wait for each other.
- **Compare-and-swap on blocks.** `expected_version` makes a stale write fail with `409` instead of overwriting; the client rebases its own fields onto the server's block and retries (bounded at five attempts).
- **Idempotent creates.** The client picks the block id; a retried `POST /api/blocks` returns the existing block with `200` and consumes no sequence number.
- **Idempotent apply.** Clients ignore operations at or below the last applied sequence number, and never replace a block with an older version, so replays, duplicates and late messages are harmless.
- **One write at a time per block, per client.** The client coalesces edits made while a save is in flight into one follow-up request, so a slow request can never land after a newer one and undo it.
- **Stale caches are safe.** A cached snapshot carries its `seq`; whatever happened after it is replayed.
- **Derived data from the log.** Search and notifications consume the operation stream and upsert by `(page_id, seq)`, so redelivery is a no-op.

## Security / Auth

- **Sessions**: opaque tokens in an `HttpOnly`, `SameSite=Lax` cookie (also accepted as a bearer token, which the WebSocket uses as a query parameter), stored in Redis with a 7-day TTL.
- **Authorization on every route** goes through the page's effective permission: view to read, edit to write, full access to share or permanently delete. Block and view ids are always resolved *within* the page that was authorized, so an id from another workspace cannot be smuggled into a batch or a database route.
- **Tree integrity**: a page can only be moved under a page in the same workspace on which the caller can edit, and never under its own subtree (that would create a cycle and make every ancestor walk loop). Block moves are checked the same way.
- **Breadcrumb privacy**: ancestors the caller cannot see are left out of breadcrumbs and the sidebar.
- **Rate limits** (production): per user on writes and per IP on login, in Redis; per-socket limits on presence messages.
- **Audit log**: shares, revokes and deletions are written to an append-only `audit_log` table.

## Observability

| Signal | Metric / source | Alert when |
|--------|-----------------|-----------|
| Save latency | `http_request_duration_seconds{route="/api/blocks/:id"}` | p99 > 200 ms for 5 min |
| Write outcomes | `block_operations_total{type,status}` | failure ratio > 1% |
| Conflicts | 409 rate on block writes | sudden rise (a client bug or a hot block) |
| Fan-out | `websocket_connections_total`, `websocket_messages_total{direction,type}` | connections drop > 20% in a minute |
| Catch-up health | `sync` and `resync_required` message counts | resyncs > 1% of subscriptions (publish loss or log gaps) |
| Snapshot cache | `cache_hits_total`, `cache_misses_total` | hit ratio < 80% |
| Queues | `queue_depth`, `queue_messages_processed_total{status}` | DLQ growing |
| Database | `db_pool_connections{state}` | waiting > 0 for 1 min |

Logs are structured JSON (Pino) with request ids. `/health` reports PostgreSQL, Redis and RabbitMQ separately; `/ready` requires PostgreSQL and Redis, since sessions and fan-out are unusable without Redis.

## Failure Handling

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Redis pub/sub message lost | Nothing, or a sub-second delay | Gap detection → replay from the log |
| Gateway server dies | A brief "reconnecting" state | Client reconnects anywhere with `sinceSeq`; the log fills the gap |
| Client offline | "Offline — changes will be saved" | Save queue keeps edits and retries with backoff; production persists it in IndexedDB |
| Page API instance dies mid-write | The request fails and is retried | Transaction rolls back; creates are idempotent by client id |
| PostgreSQL shard primary fails | Edits to that shard's workspaces pause | Synchronous replica promoted; clients keep queued edits |
| Redis down | No live updates; pages still load | Clients poll `sync` on reconnect; sessions fall back to the database in production |
| Replay gap too large | Page reloads quietly | `resync_required` → fresh snapshot, local edits kept on top |
| Hot page | Saves slow down on that page only | Per-page lock caps it near 500 writes/s; coalescing keeps clients well below |

## Scalability Considerations

- **Shard by workspace.** Pages, blocks, logs and grants of one workspace share a shard, so writes and permission walks stay local. Notion has written publicly about sharding its block data by workspace in exactly this way; logical shards (hundreds) map onto fewer physical databases and move between them as they grow.
- **Gateways scale by connection count**, independently of the API. Redis channels are per page, so a gateway receives only the traffic of pages its clients have open.
- **Operation log retention.** Daily partitions are dropped after 7 days; older history is compacted into page snapshots in object storage. A client gone longer than that gets `resync_required`.
- **Snapshot reads** come from a cache that may be slightly stale (safe, see above) and from read replicas; only writes need the primary.
- **What breaks first:** one very large page (thousands of blocks makes the snapshot slow — paginate the block tree), one very hot page (the per-page lock), and permission walks on deep trees under heavy read load (cache them).

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Storage model | One row per block, parent pointers | One JSON document per page | Edits touch one row; concurrent edits rarely collide |
| Sibling order | Fractional keys + rebalance | Ordered child array on the parent | Inserts touch only the new row; one index scan per page |
| Collaboration | Server-ordered log + per-block versions | Text CRDT everywhere | Simple convergence, server-side permissions; CRDT later for text only |
| Conflict policy | Field-level LWW after `409` | Silent last write wins | Stale clients cannot overwrite blindly |
| Ordering | Per-page `seq` in the write transaction | PostgreSQL `SEQUENCE` or timestamps | Gap-free, so a hole always means a lost message |
| Live delivery | Redis pub/sub, repaired by log replay | Kafka or sticky routing | Low latency; loss is detected and repaired |
| Permissions | Walk ancestors on read | Materialized ACL per page | Shares and moves are one-row writes |
| Writes | REST with status codes | Writes over the socket | Errors, retries and rollbacks have a contract |
| Search pipeline | Outbox → Kafka → indexer | Index inside the request | Edits never wait on search |

## Implementation Notes

The local project runs the edit, live-update and sharing paths end to end on a single-node stack: one Express process that serves both REST and the WebSocket, PostgreSQL 16, Valkey 7 and RabbitMQ 3.12 from [`docker-compose.yml`](./docker-compose.yml), and a React 19 + TanStack Router + Zustand frontend. This section maps the design above to the code as of the 2026-10-10 review.

### Production design → local implementation

| Production design | Local implementation | Where |
|-------------------|----------------------|-------|
| Page API and Sync gateway as separate fleets | One process: Express routes plus a `ws` server on the same HTTP server | [index.ts](./backend/src/index.ts) |
| Write transaction: page lock, CAS, log append with `seq` | Implemented as designed; publish after commit | [pageOperations.ts](./backend/src/services/pageOperations.ts) |
| Redis pub/sub fan-out across gateways | Implemented: a dedicated subscriber connection per process, channels `page:{id}` | [realtime.ts](./backend/src/services/realtime.ts) |
| Subscribe with `sinceSeq`, replay, gap repair | Implemented, replay limit 1,000, `resync_required` beyond it; 30-second ping/pong and app-level heartbeat | [websocket.ts](./backend/src/services/websocket.ts) |
| Permission walk with inheritance | Implemented with recursive CTEs, no cache | [permissions.ts](./backend/src/services/permissions.ts) |
| Fractional keys + rebalance | Implemented (`a`–`z`, max 48 chars) | [fractionalIndex.ts](./backend/src/utils/fractionalIndex.ts) |
| Hybrid logical clock | Server-side only, packed into `operations.timestamp` | [hlc.ts](./backend/src/utils/hlc.ts) |
| Client save queue, rebase on 409, gap detection | Implemented in memory (no IndexedDB) | [editor.ts](./frontend/src/stores/editor.ts), [websocket.ts](./frontend/src/services/websocket.ts) |
| Outbox → Kafka → search | Best-effort publish to RabbitMQ `notion.search` after commit | [queue.ts](./backend/src/shared/queue.ts) |
| Snapshot cache | Redis cache-aside of `{seq, blocks, children, views}` for 5 minutes, invalidated on writes | [pages.ts](./backend/src/routes/pages.ts), [cache.ts](./backend/src/shared/cache.ts) |

### The block write path

Every block route (`POST /api/blocks`, `PATCH`, `DELETE`, `/move`, `/batch`) calls `withPageTransaction`, which locks the page row, runs the operation, bumps `pages.last_op_seq` and commits before invalidating the snapshot cache and publishing:

```typescript
// backend/src/services/pageOperations.ts (abridged)
await client.query('BEGIN');
const locked = await client.query(
  'SELECT last_op_seq FROM pages WHERE id = $1 FOR NO KEY UPDATE', [pageId]);
const tx = new PageTransaction(client, pageId, authorId, Number(locked.rows[0].last_op_seq));
result = await fn(tx);                       // createBlock / updateBlock / moveBlock / deleteBlock
await client.query('UPDATE pages SET last_op_seq = $2 WHERE id = $1', [pageId, tx.currentSeq]);
await client.query('COMMIT');
// after commit: invalidatePageCache(pageId); publishPageEvent({ type: 'operation', ... })
```

- `updateBlock` checks `expected_version` (body) or `If-Match` and throws a `409` carrying the current block. Moving or re-parenting through `PATCH` is rejected; `/move` validates the parent, rejects moves into the block's own subtree and computes the position under the lock.
- `createBlock` accepts a client-chosen UUID; a retry returns `200` with the existing block. An insert "after X" always becomes X's next sibling.
- Positions come from `generateKeyBetween` over the sibling list. If it throws (duplicate or legacy keys) or the key would exceed 48 characters, `rebalanceSiblings` rewrites the list with `generateNKeysBetween` and logs one `move` per block.
- Batches resolve every block id within the authorized page; one bad operation rolls back the whole batch.

### Real-time delivery

- The WebSocket authenticates from `?token=`, queues messages that arrive before authentication finishes, and processes each connection's messages one at a time.
- `subscribe {pageId, sinceSeq}` checks view permission, subscribes the process to `page:{id}` on Redis, returns `subscribed {headSeq, permission, presence}` and then the replay. Clients that send `operation` get an error: the socket no longer carries writes.
- Presence (join, leave, cursor block) is stored in a Redis hash per page and published on the same channel, so it also works across instances.
- Heartbeat: the server pings every 30 seconds and terminates sockets that miss a pong; it also sends `heartbeat` messages, and the client reconnects when it hears nothing for 75 seconds. Reconnects back off up to 30 seconds with jitter and never give up.

### Client sync

`frontend/src/stores/editor.ts` holds the blocks, `lastSeq` and a save queue per block. Typing updates the block on screen at once and saves after 300 ms; only one request per block is in flight, later edits are coalesced into the next one, and each request carries `expected_version`. A `409` rebases the user's fields onto the returned block; a network error keeps the edit and retries with backoff ("Offline" in the page header); a `403` or other client error drops it and reloads the page. Operations from the socket are applied only when `seq === lastSeq + 1`; a gap sends `sync`, and `resync_required` reloads the snapshot while keeping unsaved fields. New blocks get a client UUID and an optimistic position from a copy of the fractional-index module ([fractionalIndex.ts](./frontend/src/utils/fractionalIndex.ts)). Users with view permission get a read-only editor.

### Permissions and sharing

`getPageAccess` returns the page, the caller's workspace role and the nearest grant in one query; `requirePageAccess` turns that into `404`/`403` for the routes. `listVisiblePages` walks down from the roots carrying the nearest grant, so the sidebar contains only visible pages (archived pages hide their subtree); `listVisibleAncestors` filters breadcrumbs. `PUT /api/pages/:id/permissions` adds unknown users as workspace guests in the same transaction as the grant, and both share and revoke are audit-logged. Page creation and moves validate the parent's workspace, the caller's edit permission on it and the absence of cycles.

### Other correctness fixes in the 2026-10 review

- Registration creates the user, workspace, membership and welcome page in one transaction; a duplicate email is a `409` decided by the unique index.
- Database row edits merge in SQL (`properties || $1::jsonb`), so concurrent edits to different cells both survive; row, view and schema routes check the database page's permission and scope ids to that database.
- The RabbitMQ client no longer keeps a rejected connection promise forever (so it never reconnected if the broker was down at startup), and messages that exhaust their retries are `nack`ed into their dead-letter queue instead of being acked away. The Redis client keeps reconnecting instead of giving up after three attempts.
- `init.sql` is re-runnable (`CREATE OR REPLACE TRIGGER`, `ADD COLUMN IF NOT EXISTS`).

### Verification (2026-10-10)

- `npm test` in `backend/` runs 23 vitest tests: fractional keys (2,000 random inserts stay ordered and unique, unlimited prepends, legacy keys, rebalance spread), HLC packing, and the permission resolution rules. Backend and frontend `tsc` are clean and the frontend builds; lint reports only pre-existing findings (7 in the backend workers, 10 in the frontend), none introduced by the change.
- Against real PostgreSQL 16 and Redis with two API instances (RabbitMQ absent): the schema loads twice; the seeded guest sees only the shared page, cannot edit (`403`) or read the unshared database or its breadcrumb; a batch that names another workspace's block fails with `404` and changes nothing; a foreign view cannot be deleted through one's own database; cross-workspace parents and cycles are rejected; sharing grants inherited edit access that revoking removes; a stale `expected_version` returns `409` with the current block; a retried create returns `200` without consuming a seq; 20 concurrent inserts into one gap get distinct positions and contiguous seqs; a subscriber on the *other* instance receives the replay and all 20 live operations in order; duplicate positions trigger a rebalance; two concurrent cell edits on one row both persist.

### Simplified, omitted, and known limitations

- **Not built:** IndexedDB persistence and a service worker (queued edits live only as long as the tab), character-level merging inside a block, a share dialog (the API exists; the UI shows a "View only" badge), per-block render subscriptions and virtualization (the store keeps one sorted array, so every change re-renders the block list), IME-composition handling, drag-and-drop reordering, version history, file uploads, sharding, read replicas, Kafka and Elasticsearch.
- **Page-level changes are not in the operation log**: renaming, creating, moving or archiving a page does not update collaborators' sidebars or headers live, and database rows and views are not broadcast or versioned (last write wins per property).
- **Revoked access** does not disconnect an already-subscribed socket until it resubscribes; permission checks are uncached, and the page snapshot filters child pages with one permission query per child for non-admins.
- **The operation log is never pruned**, and `resync_required` is only triggered by the 1,000-operation replay limit.
- **Workers are incomplete**: the search, export, email and notification workers write to tables (`search_index`, `exports`, `email_log`, `notifications`) that `init.sql` does not create, so their jobs fail and end in the dead-letter queues; the search publish is a best-effort dual write. The workers were not run (no RabbitMQ in the review environment).
- The Postgres `sessions` table is unused (sessions exist only in Redis), and the frontend has no automated tests.

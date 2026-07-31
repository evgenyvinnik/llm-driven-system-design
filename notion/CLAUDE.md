# Notion — Development with Claude

## Project Context

Notion's defining idea is that there is no document type. A page is a list of blocks, a block is a row, and a database is just a page with a `properties_schema` whose rows happen to be structured. Headings, toggles, code fences, Kanban cards, and table rows are all the same storage primitive with a different `type` string and a different `properties` JSONB payload. That uniformity is what makes "turn this paragraph into a heading" a one-column update rather than a migration between document models.

The consequence is that *ordering* becomes the hard problem. When every block is an independent row and two people are inserting into the same list at once, the position of a block can't be an integer — integers require renumbering siblings, and renumbering is a write that conflicts with every concurrent edit in the same list. So position is a lexicographically sortable string, and inserting between two blocks means finding a string between two strings.

The second hard problem is that collaboration needs an ordering across clients whose clocks disagree. A wall-clock timestamp will happily report that a reply happened before the message it replies to when one laptop is 400ms fast. That's what the Hybrid Logical Clock is for.

**Learning goals:** the block-as-row data model and what it buys, fractional indexing for conflict-free insertion, hybrid logical clocks for causal ordering under clock drift, and the difference between a system that *broadcasts* edits and one that genuinely *converges*.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`) | **3001** (`npm run dev` → `PORT=3001 tsx watch`) | Express REST plus a `ws` server on the same HTTP server; Vite proxies both `/api` and `/ws` |
| **Four workers** (`backend/src/workers/`) | `dev:worker:notification` / `:export` / `:email` / `:search` | Separate processes so a slow export can't block a notification |
| **PostgreSQL 16** | 5432 (`notion`/`notion_password`, db `notion_db`) | `users`, `workspaces`, `workspace_members`, `pages`, `blocks`, `database_views`, `database_rows`, `page_permissions`, `sessions`, `operations`, `audit_log` |
| **Valkey 7** | 6379 | Sessions and per-page presence (who is viewing, plus cursor position) |
| **RabbitMQ 3.12** | 5672 / management 15672 (`notion`/`notion_local`) | 5 queues with per-queue TTL, prefetch, retry counts, and DLQs |
| **Prometheus + Grafana** | 9090 / 3002 — `--profile observability` | Opt-in; the stack runs fine without them |

The two files that carry the ideas are `backend/src/utils/fractionalIndex.ts` and `backend/src/utils/hlc.ts`. Real-time handling is `backend/src/services/websocket.ts`; queue topology is declared once in `backend/src/shared/queue.ts` as `QUEUES`. Frontend is React 19 + TanStack Router (file-based) + Zustand + Tailwind, with block components under `frontend/src/components/blocks/` (text, heading, list, code, quote, callout, divider, toggle, plus `BlockTypeMenu` for slash commands), database views under `components/database/` (Table, Board, List), and the editor store in `stores/editor.ts`.

## Key Design Decisions

### 1. Block position is a lexicographic string, not an integer

`blocks.position VARCHAR(100)` holds strings over `a`–`z`, and `generatePosition(before, after)` returns a string that sorts strictly between its neighbors. Reading a page is `ORDER BY position` against `idx_blocks_position (page_id, position)`.

Integer positions fail here in a way that gets worse the more collaborative the document is. Inserting at index 3 of a 200-block page means `UPDATE blocks SET position = position + 1 WHERE position >= 3` — 197 row updates for one keystroke's worth of intent. Every one of those rows is now a write that conflicts with any concurrent edit to those blocks, and the update has to be broadcast to every connected client. Two users inserting into the same list simultaneously each renumber the other's target, and the results interleave incorrectly. Fractional indexing turns the same operation into a single-row insert that touches nothing else, so two concurrent inserts in the same place produce two distinct positions and both survive.

What we give up is bounded key length. Repeatedly inserting between the same two blocks makes the string grow one character at a time — pathologically, dragging one block back and forth in the same gap. `VARCHAR(100)` is the ceiling, which is generous but not infinite, and there is no rebalancing pass to compact positions when they get long. The implementation is also alphabet-only (26 symbols) rather than the wider base real libraries use, so keys grow somewhat faster than they need to.

### 2. Hybrid Logical Clocks, not wall-clock timestamps

Every operation gets an HLC — physical `Date.now()`, a logical `counter` that increments when two events land in the same millisecond, and a `nodeId` to break remaining ties. `generateHLC()` never goes backwards even if the system clock does.

Plain `Date.now()` breaks in two concrete ways. Client clocks routinely disagree by hundreds of milliseconds, so an operation that *causally* followed another can carry an earlier timestamp — the effect precedes its cause and last-write-wins picks the wrong winner. And within a single fast client, multiple edits in the same millisecond are exact ties with no defined order. A pure Lamport counter fixes causality but throws away wall time, which means you can no longer answer "what did this page look like an hour ago" or sort an operation log for a human. HLC keeps both: it stays within a bounded drift of real time while guaranteeing that if A happened before B, `hlc(A) < hlc(B)`.

The trade-off is that HLC gives *ordering*, not *merging*. It tells you which of two conflicting edits wins; it does not combine them. Two people typing into the same block still means one version replaces the other rather than the characters interleaving — that requires a sequence CRDT, which is decision 3.

### 3. Last-write-wins per block, deliberately, instead of a text CRDT

Concurrent edits to the same block resolve by HLC comparison: the later operation's content replaces the earlier one's. This is not a CRDT despite the `operations` table's comment calling it one.

A real character-level CRDT (Yjs, Automerge, RGA) assigns every character a unique identifier so concurrent insertions interleave deterministically and nobody's typing is lost. It is the correct answer for a shared text editor, and it is a large amount of machinery: per-character metadata, tombstones for deletions that can never be fully garbage-collected while any peer might still be offline, and a document representation that no longer maps to a `TEXT` column.

Block-level LWW is a real bet on the workload, not just laziness. Notion-style editing is mostly *structural* — add a block, change a block's type, move a block, edit a block nobody else is in. Those operations are naturally conflict-free at block granularity, and fractional indexing already handles the ordering half. LWW only loses data in the narrow case of two people editing the same paragraph in the same instant, which in practice is rare because the UI shows you their cursor first. What we give up is exactly that case, plus offline editing: an offline client's queued edits will clobber whatever happened while it was away, because there's nothing to merge with.

### 4. WebSocket is a notification channel; REST is the persistence path

The flow in `stores/editor.ts` is: apply the change optimistically to local state, `POST`/`PATCH` to `/api/blocks` to persist, then `wsService.sendOperation(...)` to tell everyone else. The server's `handleOperation` appends to the `operations` table and re-broadcasts to other subscribers of that page — it does **not** mutate `blocks`.

Making the socket the write path is the more elegant design, and it's what a mature version would do. Splitting it this way buys error handling: a REST call has a status code, so a failed block create rolls the optimistic update back (the store does exactly this, removing the temp block on error). A fire-and-forget socket message has no such contract, and a dropped connection would silently lose an edit that the user watched appear on screen.

The cost is that a block write and its broadcast are two independent operations with no transaction between them. If the REST call succeeds and the socket message doesn't, other clients simply never learn — and there is no reconciliation pass, so they stay wrong until reload. The `operations` log compounds the awkwardness: it is written faithfully on every socket operation but never replayed, so it is currently an audit trail wearing a sync log's name.

### 5. Five queues with per-queue TTL, prefetch, and retry policy — not one job queue

`QUEUES` declares `fanout`, `notifications`, `export`, `email`, and `search` with deliberately different settings: fanout is prefetch 50, TTL 30s, **zero retries and no DLQ**; export is prefetch 2, TTL 24h, 5 retries with a DLQ.

Those numbers encode what each job *means*. A fanout message describing a live edit is worthless 30 seconds later — retrying it would deliver a stale update to a client that has long since moved on, so best-effort with expiry is correct, and no DLQ because there is nothing a human would ever do with a dead one. An export is the opposite: expensive, user-visible, and still valuable hours later, so it gets patient retries, a dead-letter queue for inspection, and prefetch 2 so one worker can't pull ten heavy jobs and sit on nine of them.

A single queue with a priority field cannot express any of this — one TTL, one retry policy, one prefetch for jobs whose correct handling differs by three orders of magnitude. The cost is five queues plus four DLQs to declare and monitor, and four separate worker processes to keep running in development.

## Current State

Runs end to end: registration/login (bcrypt, session token in Postgres + Redis), workspaces with members, nested pages with a recursive tree endpoint (`GET /api/pages/:id/tree`) and sidebar navigation, the full block editor (text, headings, lists, code, quote, callout, divider, toggle with collapse/expand) with slash-command type conversion, block create/update/delete/move plus a `/batch` endpoint, fractional-index ordering, databases with a JSONB `properties_schema` and Table/Board/List views each carrying their own filter, sort, group-by and column visibility, and real-time page subscription over WebSocket with presence and **live cursor position broadcast**. Cross-cutting: Pino structured logging, Prometheus metrics including queue depth and processing duration, an `audit_log` table with a `shared/audit.ts` helper, and RabbitMQ with DLQs and four workers.

Seeded from `backend/db-seed/seed.sql`: **`admin@notion.local`** / **`password123`**. (The SQL comment above the hash says `admin123` and is wrong — the stored hash verifies against `password123`.)

Simplified or omitted: no character-level CRDT (see decision 3) and therefore no offline queue and no true convergence; the `operations` table is written but never replayed; the WebSocket broadcast map (`pageSubscriptions`) is **in-process only** with no Redis pub/sub, so running `dev:server2`/`dev:server3` gives you instances that cannot see each other's edits; `page_permissions` exists in the schema with view/edit/full_access but there is no UI and no enforcement middleware reading it; no calendar or gallery database views (the CHECK constraint allows them, nothing renders them); no drag-and-drop block reordering (the `/move` endpoint exists, the gesture doesn't); no file or image uploads; no version history or export UI despite the export worker.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its Phase 2 listed "Cursor position sync" as **unbuilt** while `handlePresenceUpdate` in `services/websocket.ts` already writes `cursor_position` to Redis presence and broadcasts it to every other subscriber of the page. It also labelled Phase 3 and Phase 4 "COMPLETED" while each contained unchecked boxes, and its stated learning goal "Implement CRDT-based real-time collaboration" described a system that is block-level last-write-wins, not a CRDT.
- **Verification config corrected to `admin@notion.local`:** `scripts/screenshot-configs/notion.json` now targets the seeded admin account with `password123`. The seed file's own comment (`-- Insert default admin user (password: admin123)`) still misstates the password; the bcrypt hash verifies against `password123`.
- **Backend port pinned:** `dev` is `PORT=3001 tsx watch src/index.ts` to match both Vite proxy targets — `/api` over HTTP and `/ws` over the WebSocket upgrade, which fail together if the port drifts.
- **Observability made opt-in:** Prometheus and Grafana sit behind a Compose `profiles: [observability]` block so the default `docker-compose up -d` starts three services instead of five. Grafana is mapped to host **3002** to stay clear of the backend port range.
- **Queue policies differentiated:** `fanout` was given `retries: 0` and no dead-letter queue after it became clear that retrying an expired realtime message delivers stale state; the other four queues kept retries and DLQs.
- **2026-07-30 — the app was unusable past the login screen.** `useAuthStore` initialises `token` from `localStorage` but hardcodes `isAuthenticated: false`, and the route guards on `/` and `/page/$pageId` are **synchronous `beforeLoad` hooks** that read that flag directly. `checkAuth` — which validates the token and flips the flag — only runs from the root component's effect, i.e. *after* the guard. So every authenticated navigation or reload redirected straight back to `/login`: you could log in, and the moment you went anywhere you were thrown out. Both guards are now `async` and await `checkAuth()` when `isLoading` is still true. This is the third instance of the same class in this repo — an effect or guard deciding "logged out" from state that hasn't loaded yet (see also microsoft-teams' channel deep links and notification-system's route guards).
- **Login page advertised the wrong demo password:** it read `admin123` while the seeded bcrypt hash verifies against **`password123`**. The stale `-- Insert default admin user (password: admin123)` comment in `db-seed/seed.sql` is presumably where it came from; the on-screen hint now matches reality.
- **Seeded code block rendered a literal `\n`.** The SQL literal used `\\n`, which reaches the JSON parser as an escaped backslash rather than a newline escape, so the code block showed `// Example code block\nconsole.log(...)` on one line. A single backslash in the SQL literal is what produces a real newline.
- **Screenshot coverage:** 2 screens (both of which were actually the login page) → 5: workspace home, the block editor with headings/lists/code and live presence, and the Tasks database in both Table and Kanban views. Added `data-testid="view-tab-{type}"` to the database view tabs so the board view can be captured.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. The `operations` table is append-only and never read. Should it become the actual source of truth — blocks materialized by replaying operations — or should it be dropped, given that REST already persists the authoritative state?
2. WebSocket subscriptions live in a per-process `Map`, so horizontal scaling silently breaks collaboration rather than failing loudly. Is Redis pub/sub the fix, or should the socket tier be a separate service that owns all connections?
3. Fractional index strings grow without bound under repeated insertion into the same gap, and `VARCHAR(100)` is a hard stop with no rebalancer. What's the right trigger for compaction — a length threshold per page, or a periodic sweep — and how do you rebalance without invalidating positions clients are holding?
4. `page_permissions` supports view/edit/full_access but nothing enforces it; access checks currently stop at workspace membership. Should permissions be resolved by walking the page ancestry (inheriting from the nearest ancestor with an explicit grant), or materialized per page on write?

## Resources

- [The data model behind Notion's flexibility](https://www.notion.so/blog/data-model-behind-notion) — the block-as-row idea this project is built on
- [Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/) — the fractional indexing algorithm in `utils/fractionalIndex.ts`
- [Logical Physical Clocks (HLC paper)](https://cse.buffalo.edu/tech-reports/2014-04.pdf) — cited directly in `utils/hlc.ts`
- [crdt.tech](https://crdt.tech/) — what would be required to move past block-level LWW
- [RabbitMQ dead letter exchanges](https://www.rabbitmq.com/docs/dlx) — the DLQ semantics behind the per-queue policies

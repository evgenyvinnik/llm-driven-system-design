# Figma (Collaborative Design Tool) — Development with Claude

## Project Context

A real-time collaborative design editor: multiple users edit the same vector document at once, seeing each other's cursors, selections, and shape edits with sub-100ms latency. The hard problem is **concurrent editing without a central lock** — two people dragging the same rectangle must converge to one consistent state — combined with **rendering thousands of vector objects at 60fps** in the browser.

**Learning goals:** real-time multiplayer sync over WebSockets, operation ordering and conflict resolution (Lamport clocks + Last-Writer-Wins), GPU-accelerated canvas rendering (PixiJS/WebGL), and optimistic-update UX where local edits feel instant while staying eventually consistent with peers.

## Architecture at a Glance (what actually runs)

Two datastores. This is a single-server-local design with a documented multi-server production path — not a sharded cluster.

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL** (`pg`) | Files + `canvas_data` JSONB, `file_versions`, append-only `operations` log, teams/projects/permissions/comments | ACID for the durable document + version history; JSONB keeps the whole canvas in one row for simple full-file loads |
| **Redis / Valkey** (`ioredis`) | Presence (cursors/selections, 30s TTL), a `redisPub`/`redisSub` pair for cross-server presence fan-out on `presence:<fileId>`, idempotency keys | Sub-ms ephemeral state that should never touch Postgres; TTL auto-expires stale cursors |

**Transport:** native `ws` (not Socket.io) at `/ws`. **Frontend:** React 19 + Zustand + **PixiJS (WebGL)** + Vite + Tailwind. There is no separate object store, queue, or search engine — the document *is* the JSONB blob.

Backend surface: one Express service exposing REST (`/api/files*`) + the WebSocket handler. Shared modules under `src/shared/` (circuit breaker, retry, idempotency, metrics, logger, retention).

## Key Design Decisions

### 1. PixiJS / WebGL renderer, not Canvas 2D
The canvas is rendered by `PixiRenderer` on a WebGL context, with a `Map<id, PIXI.Container>` scene graph that is diffed against `canvas_data.objects` on every change. WebGL was chosen over the Canvas 2D API because a design tool routinely holds hundreds-to-thousands of shapes and must stay at 60fps during pan/zoom/drag — Canvas 2D redraws the whole scene on the CPU and falls over at that object count. Trade-off given up: higher baseline memory and a steeper API than `ctx.fillRect`, plus async init (the app must wait for `app.init()` before first render).

### 2. Server-ordered operations + Last-Writer-Wins, not a full CRDT
Each edit is an `operation` (create/update/delete/move) carrying a Lamport timestamp. The server is the single ordering authority: it assigns the next timestamp, persists operations in receipt order, and broadcasts in that same order. Conflicts resolve by LWW on a property path. A full CRDT library (Yjs/Automerge) would give true offline-capable convergence, but LWW-over-a-server is dramatically simpler and correct for the online, low-concurrency-per-object case here. Trade-off: concurrent edits to the *same* property silently drop the loser, and offline editing isn't supported (queued-replay-on-reconnect is designed, not built).

### 3. Batch operation broadcasts (50ms), send presence immediately
Operations are queued per file and flushed to subscribers on a 50ms tick, coalescing a drag's dozens-per-second updates into a few network frames. Presence (cursor movement) bypasses the batch and broadcasts immediately — a lagging cursor is far more noticeable than a 50ms-late shape edit. Trade-off: up to 50ms of extra latency on shape sync in exchange for a large drop in message volume.

### 4. Idempotent operations keyed per (file, type, client key)
Every operation can carry an `idempotencyKey`; the server wraps processing in `withIdempotency(generateFileOperationKey(...))` and the `operations` table has a partial unique index on `idempotency_key`. This makes reconnect-replay safe — a client that re-sends operations after a dropped socket cannot double-apply them. Trade-off: clients must generate and track keys, and the dedup window depends on the key surviving in Redis / the unique index.

### 5. Soft delete + scheduled retention, not hard delete
Files carry `deleted_at` (soft delete); a `node-cron` retention job (`src/shared/retention.ts`) prunes auto-save versions past 90 days (keeping a per-file minimum), trims the operations log past 30 days, and hard-deletes soft-deleted files after 30 days. This makes "undo a delete" trivial and keeps the operations log from growing unbounded. Trade-off: extra rows linger for the retention window and a background job must run.

## Current State

**Implemented and working end-to-end:** file CRUD (REST) with soft delete; WebSocket subscribe/operation/presence/sync/unsubscribe; Lamport-ordered LWW operation processing with per-op idempotency; 50ms operation batching + immediate presence broadcast; version history (named + auto-save, restore); PixiJS canvas with pan/zoom, rectangle/ellipse/text shapes, selection overlay, remote cursors; layers + properties panels; Zustand store with local undo/redo history and optimistic local apply; retention/cleanup cron; circuit breaker around broadcast, retry around DB reads, Prometheus metrics, Pino logs, health/readiness/liveness probes.

**Intentionally omitted / not wired:** real authentication (see below), permission enforcement (RBAC schema exists, middleware does not), multi-server WebSocket fan-out (single server today; Redis pub/sub machinery for presence exists but operation broadcast is in-memory `fileClients`), offline editing, components/prototyping/export, and a cache-aside layer for file metadata.

**Auth is a known stub:** `express-session` is a declared dependency but is *never wired up*. REST routes act as a fixed demo user (`00000000-0000-0000-0000-000000000001`) and the WebSocket handler trusts the `userId`/`userName` sent in the `subscribe` payload. Any doc that says "session auth validated on every message" is describing the production ideal, not the running code.

## Iteration & Repair Log

- **Renderer is PixiJS/WebGL, not Canvas 2D.** An earlier version of this file recorded a decision to "use Canvas 2D API for simplicity (WebGL later)." The shipped frontend is PixiJS on a WebGL context (`frontend/src/renderer/PixiRenderer.ts`, `pixi.js` ^8 in `frontend/package.json`), and `architecture.md` already reflects this. Corrected here to match the code.
- **architecture.md auth drift (fixed 2026-07).** The Security section claimed "session-based authentication via express-session" and the cache-aside note claimed "session data is validated on every WebSocket message." Neither is true — `express-session` is unused and there is no session validation on the WS path. Reworded both to state the production ideal while flagging the demo-user stub as the actual local behavior.
- **Schema-apply path.** There is no `migrate.ts` / `db:migrate` script for this project. The schema in `backend/src/db/init.sql` is applied only via the `docker-entrypoint-initdb.d` mount, which runs once on a fresh Postgres volume. Re-seeding after a schema change requires `docker-compose down -v` (or applying `init.sql` by hand for native installs, as the README documents).
- **Password normalization.** Seed users across the repo use `password123`; figma's local build doesn't actually verify passwords (demo-user stub), so the hash scheme is moot here but noted for consistency.

## Open Questions

1. When does LWW stop being acceptable? At what per-object concurrency should this adopt a real CRDT (fractional-indexed ordering for layers, per-property registers) instead of last-writer-wins?
2. Operation broadcast is in-memory today; presence already has a Redis pub/sub path. What's the cleanest way to route *operations* through Redis (or a dedicated bus) so multiple WS servers can share a file with sticky-session load balancing?
3. `canvas_data` is one JSONB blob rewritten on every operation. At what document size does the whole-row rewrite become the bottleneck, forcing a move to per-object rows or an operation-log-only source of truth with periodic snapshots?
4. Offline editing: queue operations in IndexedDB and replay on reconnect — how do the existing idempotency keys and Lamport clock interact with a long-offline client whose timestamps are far behind?

## Resources

- [How Figma's Multiplayer Technology Works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- [Realtime Editing of Ordered Sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/) — fractional indexing for layer order
- [PixiJS](https://pixijs.com/) — the WebGL renderer this project builds on

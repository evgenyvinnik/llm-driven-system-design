# Excalidraw — Development with Claude

## Project Context

A collaborative whiteboard sits at an unusual point in the design space: it has the real-time multi-user problem of a document editor, but the *unit of conflict* is completely different. In text, two people typing in the same paragraph genuinely interleave — you need character-level merge semantics to get a sensible result. On a canvas, two people are almost always manipulating different shapes, and when they aren't, "one of the two edits wins" is not a data-loss bug — it's what a visual editor does. You dragged the rectangle left, I dragged it right, it ends up in one place.

That observation is what lets this project skip both OT and a real CRDT library and get away with about fifty lines of last-writer-wins merge keyed on element ID. The cost of being wrong here is bounded and visible: a shape lands in the wrong spot and someone drags it again.

The other half of the problem is entirely client-side and has nothing to do with distributed systems: an infinite canvas with pan and zoom means every mouse event lives in *screen* space while every shape lives in *world* space, and getting hit-testing, rendering, and cursor sharing right means being disciplined about which space you're in at every step. Freehand drawing adds its own pressure — a pen stroke at 60fps produces hundreds of points that must be simplified before they're worth storing or broadcasting.

**Learning goals:** shape-level LWW merge and when coarse conflict granularity is correct rather than lazy, Canvas 2D viewport transforms, path simplification (Ramer–Douglas–Peucker), WebSocket room management, debounced write coalescing, and cursor presence with TTL-based expiry.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **Express + `ws` server** (`backend/src/index.ts`) | **3001** | HTTP API and the collaboration WebSocket in one process. Rooms are held in process memory, so splitting them would immediately require a pub/sub layer |
| **PostgreSQL 16** | 5432 | `drawings.elements` is a single `JSONB` column. Elements have heterogeneous shapes (a freehand stroke has `points[]`, text has `fontSize`) — a normalized table would need either a sparse column set or an EAV model |
| **Valkey (Redis)** | 6379 | Session store (`connect-redis`), rate-limit counters (`rate-limit-redis`), and cursor presence with a **30-second TTL** so a client that vanishes doesn't leave a ghost cursor |

The collaboration path is `backend/src/websocket/handler.ts` (room map, message dispatch, debounced persistence) calling into `backend/src/services/crdtService.ts` (`mergeElements`, `applyOperation`, `getVisibleElements`). Access control and version snapshots live in `services/drawingService.ts`. Frontend is React 19 + TanStack Router + Zustand + Tailwind: `frontend/src/renderer/CanvasRenderer.ts` and `renderer/shapes.ts` do all drawing, `stores/canvasStore.ts` holds elements/tool/viewport/cursors, `utils/geometry.ts` handles hit testing, `utils/pathSimplification.ts` implements RDP, and `services/websocket.ts` is the reconnecting client. Backend has vitest coverage in `src/app.test.ts`.

## Key Design Decisions

### 1. Shape-level LWW keyed on `(version, updatedAt)`, not OT and not a CRDT library

Every element carries `id`, `version`, `updatedAt`, and `isDeleted`. `mergeElements` builds a map by `id` and keeps, per element, the higher `version`, breaking ties on later `updatedAt`. That's the entire conflict resolution story.

OT is the wrong tool because it's built for *positional* interleaving — its transform functions exist so that "insert at index 5" stays meaningful after someone else deleted index 2. Canvas elements have no shared index space: moving a rectangle doesn't shift the coordinates of an ellipse. All that machinery would buy nothing here, while requiring the same central authority we already have.

A real CRDT (Yjs, Automerge) would give genuinely conflict-free merge including *within* an element — you move a shape while I recolor it, and both survive. Under LWW, one of those edits vanishes entirely, because the loser's whole element object is discarded, not just the conflicting field. That's the honest cost. It's acceptable because the conflict window is one network round-trip on a canvas where users are looking at each other's cursors and naturally avoid the same object — and because the failure is immediately visible and trivially repairable by hand. The reason not to pay for a CRDT is the metadata: sequence CRDTs carry per-element causal structure and tombstones that must be retained indefinitely, which is a large library plus permanent growth for a problem we just argued barely exists.

The tie-break ordering matters more than it looks. Version-first, timestamp-second means a client whose clock is skewed forward can't hijack every merge — it can only win among edits at the *same* version. Timestamp-first would let one badly-clocked laptop overwrite everyone.

### 2. Deletion is a tombstone flag, not removal from the array

`applyOperation`'s `delete` case sets `isDeleted: true` and *bumps the version*, rather than removing the element. `getVisibleElements` filters them out at render time.

Actually removing the element breaks convergence in a specific, reproducible way: A deletes shape X while B moves it. B's move arrives carrying version 4. If A removed X outright, the merge sees an unknown ID and re-inserts it as a new element — the shape resurrects, and no amount of re-deleting fixes it as long as someone still has a pending edit. Keeping a tombstone at version 5 means B's version-4 move loses the comparison and the deletion stands. This is the same reason every CRDT keeps tombstones, arrived at from the same failure.

What we give up is unbounded growth: a drawing that has had 10,000 shapes created and deleted still carries 10,000 objects in its JSONB column forever, and every save rewrites all of them. There is no tombstone GC, which would need a safe cutoff — "no client can still hold an edit older than this" — that we have no mechanism to establish.

### 3. Persistence is a 2-second debounce writing the whole JSONB blob

`debouncedSave` in the WebSocket handler resets a timer on every mutation and only writes after 2 seconds of quiet, replacing `drawings.elements` entirely.

Write-per-operation is the alternative and it's disqualified by freehand drawing alone. A single pen stroke emits points at frame rate; one user drawing continuously is ~60 mutations/second, and 50 concurrent users is 3,000 writes/second against one row per drawing — where every write contends with every other write on the *same* row. Debouncing collapses an entire multi-second drawing burst into one write. The write is also cheaper than it sounds: Postgres TOASTs and compresses large JSONB values, so rewriting a 200KB elements array is a single out-of-line update, not 200KB of index churn.

The trade-off is a 2-second data-loss window on a server crash, and write amplification that scales with drawing size rather than edit size — a one-pixel nudge on a 5,000-element drawing rewrites all 5,000. `jsonb_set` for element-level updates would fix the amplification but requires tracking dirty element indices and building JSON paths, and it collides with the array-replacement semantics that make merge simple.

### 4. Rooms live in a process-local `Map`, and this genuinely caps us at one instance

`rooms: Map<string, Set<ClientInfo>>` in `handler.ts`; `broadcastToRoom` iterates that set directly. This is the simplest thing that works and it is a hard scaling ceiling, not a soft one — two backend instances means two disjoint room maps, and users on different instances editing the same drawing simply never see each other. Not "with some latency" — never.

It's the right call for a single-process learning implementation because it removes a whole class of failure (pub/sub reliability, message ordering, self-echo suppression) from the path you're actually studying. But it should be understood as *the* thing blocking horizontal scale, and adding Redis pub/sub with a channel per drawing is the specific fix. Cursor presence already goes through Redis, so the pattern is half-established.

### 5. Freehand strokes are simplified with RDP before they're stored or sent

`simplifyPath` (`utils/pathSimplification.ts`, default `epsilon: 2`) recursively drops points whose perpendicular distance from the chord between endpoints is under the threshold. A raw stroke captured at pointer-event rate can be several hundred points for a gesture that's visually indistinguishable from a dozen.

Skipping simplification hurts in three places at once, which is why it's worth the recursion: the JSONB column grows by roughly an order of magnitude per stroke (multiplied by every debounced save, which rewrites the whole array), every broadcast carries that payload to every peer, and Canvas 2D redraws walk every point on every frame — so a drawing with a few hundred unsimplified strokes drops below 60fps from point count alone. `epsilon: 2` is in world units, which is the subtle part: at high zoom the same stroke was simplified at capture time and the discarded detail is gone permanently. A zoom-aware epsilon would preserve it at the cost of not being able to simplify once and forget.

## Current State

Runs end to end on backend 3001 + Vite 5173 (Vite proxies both `/api` and `/ws` to 3001). Working: register/login with bcryptjs and Redis-backed sessions, drawing CRUD with owner/collaborator access control, a share dialog for managing collaborators, public drawings, the full canvas (rectangle, ellipse, diamond, arrow, line, freehand, text) with pan/zoom over a screen-space grid, hit testing and selection, a properties panel (stroke/fill color, stroke width, opacity, font size), Delete and Escape keyboard handling, real-time collaboration over `/ws` with `shape-add` / `shape-update` / `shape-delete` / `shape-move` / `elements-sync` / `cursor-move` messages, LWW merge on the server, debounced persistence, collaborator cursors rendered as a DOM overlay above the canvas (so cursor movement never triggers a canvas repaint), WebSocket auto-reconnect with exponential backoff, version snapshots in `drawing_versions` pruned to the most recent 50 per drawing, Redis-backed rate limiting, Prometheus metrics, Pino logging, Opossum circuit breakers, and vitest tests.

Seeded logins: **`alice@example.com`** (Alice Designer) and **`bob@example.com`** (Bob Artist), both with password **`password123`**, each with pre-populated drawings.

Not implemented: undo/redo (there is no history stack in `canvasStore.ts` at all), copy/paste, multi-select / group selection, and **export** — `backend/src/routes/export.ts` exists and registers `GET /:drawingId/png` and `/svg`, but both return **HTTP 501** with a message explaining that a real implementation would render server-side via node-canvas. They are honest stubs, not working endpoints.

**Schema note:** `init.sql` defines an `operations` table (with two indexes) intended for an operation log. Nothing ever inserts into it. It's aspirational schema left from the event-sourcing approach that decision 3 rejected.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md with this structure. The old file was better than most in this repo — its five design-decision entries were real — but the checklist still misled: Phase 5 marked "Version snapshots" complete without noting that the `operations` table it implies is dead schema, and the whole checkbox format buried the one fact a reader most needs (in-memory rooms make this single-instance) inside a "Would change" line. The checklist also gave no hint that `dev:server2`/`dev:server3` don't do what their names say — see below.
- **`dev:server2` and `dev:server3` are broken (found 2026-07, not yet fixed):** they're defined as `PORT=3002 npm run dev`, but `dev` is itself `PORT=3001 NODE_ENV=development tsx watch src/index.ts`. The inline assignment inside `dev` overrides the inherited environment variable, so **all three scripts bind port 3001** — the second one fails with `EADDRINUSE` and the third never starts. They should invoke `tsx watch src/index.ts` directly with their own `PORT`. Worth noting that fixing them still wouldn't give working multi-instance collaboration, because of decision 4.
- **Backend port pinned to 3001:** the `dev` script hardcodes `PORT=3001` to match the Vite proxy targets for `/api` and `/ws`. Without the pin the app loaded but had no collaboration channel — the most confusing possible failure, since the canvas works perfectly offline.
- **Tombstones instead of array removal:** deletion originally spliced the element out, which made deletes resurrect whenever a peer had a concurrent in-flight edit on the same shape. `applyOperation` now marks `isDeleted` and increments `version`, and rendering filters via `getVisibleElements`. See decision 2.
- **Version tie-break made deterministic:** merge compares `version` first and only falls back to `updatedAt`, so wall-clock skew on one client can't dominate every conflict.
- **Version history bounded:** `drawingService.ts` deletes snapshots older than the most recent 50 per drawing on each new snapshot, so a long-lived drawing doesn't accumulate full-elements copies without limit.
- **Cursor TTL:** presence keys carry a 30-second Redis TTL, so a client that disconnects without a clean close leaves a cursor that expires on its own rather than a permanently frozen ghost.
- **CI:** the repo-wide smoke-test workflow was removed — a CI runner can't provide the Postgres/Redis services these tests need, so it failed on every PR without signalling a real defect.

## Open Questions

1. Tombstones never get collected, so a heavily-edited drawing's JSONB grows monotonically and every debounced save rewrites all of it. What establishes a safe GC cutoff — a server-assigned epoch that no connected client can predate, or is "compact when the room is empty" sufficient given rooms are already process-local?
2. LWW discards the losing element *wholesale*, so a concurrent move and recolor loses one of them entirely. Would per-field versioning (an LWW-register per property, which is a real CRDT construction) be worth it, or does it just move the arbitrary choice down a level while multiplying metadata per element?
3. RDP runs at capture time with a fixed world-space epsilon, permanently discarding detail that a user zoomed in to 400% intended to draw. Should epsilon scale with the zoom level at capture, and if so, how do you keep strokes drawn at different zooms visually consistent when viewed at the same zoom?
4. Moving rooms to Redis pub/sub is the known fix for single-instance collaboration — but the debounced save is also per-process. With two instances holding the same drawing, both debounce timers fire and both write the full JSONB blob, and the later write wins with whatever elements *that* instance happened to have merged. Does the save need to move behind a lock, or does the room owner need to be a single elected instance?

## Resources

- [Excalidraw blog](https://blog.excalidraw.com/) — the product this models, including their own notes on collaboration
- [Canvas API: transformations (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Transformations) — the world/screen space handling described above
- [Ramer–Douglas–Peucker algorithm](https://en.wikipedia.org/wiki/Ramer%E2%80%93Douglas%E2%80%93Peucker_algorithm) — decision 5
- [crdt.tech](https://crdt.tech/) — LWW-register and tombstone semantics, the formal versions of decisions 1 and 2
- [PostgreSQL JSONB and TOAST](https://www.postgresql.org/docs/current/storage-toast.html) — why the full-column rewrite in decision 3 is affordable

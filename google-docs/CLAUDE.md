# Google Docs — Development with Claude

## Project Context

Collaborative editing is the rare problem where "last write wins" is not merely lossy but *incoherent*. Two people typing in the same paragraph don't produce a conflict you can resolve by picking a winner — they produce two documents that must converge to one, where both edits survive and both users' cursors stay where they expect. Every operation carries a position, and every position is invalidated by any concurrent operation that happened earlier in the document. Insert "X" at position 10 while someone else deletes five characters at position 3, and your position 10 is now position 5 — apply it naively and the character lands in the wrong word.

Operational Transformation is the answer this project implements: the server keeps a per-document version counter and an operation log, and when a client submits an edit stamped with a version older than the server's, the server transforms that edit against every operation the client hadn't seen yet before applying it. The interesting consequence is that the server, not the client, becomes the ordering authority — which is what makes convergence provable, and also what makes the server stateful in a way the rest of this repo's projects are not.

The second hard problem is that editing generates writes at typing speed. A naive design writes to Postgres on every keystroke; a fast typist alone would generate 5–8 writes per second, and a ten-person document turns the database into the bottleneck for a feature whose whole value is feeling instantaneous. So the authoritative in-flight state lives in memory, persistence is debounced, and the durability guarantee is deliberately weakened.

**Learning goals:** operational transformation and convergence, WebSocket-based real-time sync with presence and cursors, decoupling perceived latency from durability, and cross-server coordination through Redis pub/sub.

## Architecture at a Glance (what actually runs)

| Component | Where | Why this one |
|-----------|-------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`, port **3001**) | `npm run dev` (`PORT=3001 tsx watch`) | One process serves both REST and `ws` on the same HTTP server; `dev:server2/3` run 3002/3003 to exercise cross-server sync |
| **PostgreSQL 16** (5432) | `docker-compose.yml` | `users`, `sessions`, `documents`, `document_permissions`, `document_versions`, `operations`, `comments`, `suggestions`. Document content is stored as ProseMirror JSON |
| **Valkey/Redis 7** (6379) | `docker-compose.yml` | Session store *and* the pub/sub bus (`doc:operations`, `doc:presence`) that lets multiple server instances see each other's edits |
| **In-memory document state** | `services/collaboration/state.ts` | The `documents` Map holds the live version counter and operation log — the actual source of truth while anyone is editing |

The collaboration engine is deliberately split into small modules under `backend/src/services/collaboration/`: `ot.ts` (transform-and-broadcast on each operation), `sync.ts` (subscribe/initial SYNC), `presence.ts` and `cursors.ts` (who's here, where their caret is), `permissions.ts` (access checks on subscribe), `persist.ts` (debounced writes + circuit breakers), and `state.ts` (the shared Maps). The transform algebra itself lives one level up in `backend/src/services/ot.ts` — pure functions over insert/delete/format/retain, no I/O. Both Postgres persistence and Redis publishing are wrapped in **opossum** circuit breakers (`shared/circuitBreaker.ts`).

Frontend is React 18 + **TipTap/ProseMirror** + react-router-dom + Zustand + Tailwind. `frontend/src/services/websocket.ts` speaks the SYNC/OPERATION/ACK/PRESENCE protocol; `components/Editor.tsx` hosts the editor, with `CommentsPanel`, `VersionHistoryPanel`, and `ShareModal` alongside. Vite proxies both `/api` and `/ws` → `localhost:3001`.

## Key Design Decisions

### 1. OT with a server-side authority, not CRDTs
The server owns the version counter and the operation log; clients submit edits stamped with the version they last saw, and `handleOperation` transforms the incoming ops against `docState.operationLog.slice(clientVersion)` before applying.

CRDTs would remove the need for a central authority entirely — any two replicas merge deterministically without a server. The reason we didn't is memory shape: a sequence CRDT attaches a unique, globally-ordered identifier to *every character*, plus tombstones for every deletion that can never be fully collected while any replica might still reference them. For a long-lived document that's been edited for years, the metadata dwarfs the text — a document whose visible content is 50KB can carry many times that in identifiers and tombstones, and it all has to be loaded to open the file. OT keeps the wire format tiny (a position and a string) and keeps the persisted artifact equal to the document itself.

What we give up is real: **the server is now stateful per document**, which means edits for one document must reach one authority. Two servers each holding their own `documents` Map for the same doc would each increment their own version counter and converge to different states — Redis pub/sub distributes the *results* but does not make the counter shared. That's why sticky routing by document ID is a load-balancer requirement here rather than an optimization, and it's the single strongest architectural constraint in this project.

### 2. Persistence is debounced by 1 second, and that's a deliberate durability trade
`debouncedPersist` in `persist.ts` cancels and restarts a 1-second timer on every operation, so a burst of typing produces one database write instead of dozens.

Writing per keystroke doesn't just cost throughput — it makes latency unpredictable in exactly the moment users notice. Each operation would wait on a Postgres round trip before the ACK, so the editor's responsiveness becomes hostage to database load, and the `operations` table accumulates a row per character. Debouncing decouples them completely: the ACK is sent from memory, immediately, and durability catches up asynchronously.

The cost is a **one-second window in which a server crash loses edits that were already acknowledged and already shown to every collaborator**. That is a genuinely weak guarantee, and it's acceptable here only because the in-memory state is also broadcast to every connected client, so the document survives in N browsers even if the server forgets it. A production system would need an append-only op log written synchronously (cheap, sequential) with the document snapshot debounced (expensive, random) — separating "don't lose the edit" from "keep the materialized doc current."

### 3. Snapshots every 100 versions, not on every version
`persistOperationToDb` writes a `document_versions` row only when `version % 100 === 0`, otherwise it just appends to `operations` and bumps `documents.current_version`.

Snapshotting every version would store the full document body on every edit — an O(document size) write per keystroke-batch, so a 100KB document being actively edited writes hundreds of megabytes an hour, nearly all of it redundant. Storing only operations would be maximally compact but makes history reconstruction O(all edits ever): opening version history on a mature document means replaying tens of thousands of ops. Periodic snapshots cap replay at 99 operations from the nearest checkpoint. The trade-off is the interval is a guess — too wide and restore gets slow, too narrow and storage balloons — and it's currently uninformed by document size, which is where it's most wrong (100 versions of a 1MB doc is a very different cost than 100 versions of a memo).

### 4. Operations are idempotent by client-supplied `operationId`
Before applying an edit, `handleOperation` checks Redis for a cached ACK keyed by `(userId, documentId, operationId)` and replays it if present.

This exists because a WebSocket reconnect is indistinguishable from a lost message. A client that sends an operation, loses its connection before the ACK, and retries on reconnect would otherwise have its insert applied twice — and duplicate insertion isn't a cosmetic bug, it corrupts the position space for every subsequent transform, so the two clients permanently diverge. Idempotency turns retry-on-reconnect from a correctness hazard into a no-op. What we give up is that idempotency records are Redis-resident and TTL'd, so a retry arriving after expiry duplicates anyway; the window is just made much larger than any realistic reconnect.

### 5. The operation log is capped at 1000 entries, trimmed to 500
`docState.operationLog` is truncated when it exceeds 1000 operations. The log exists only to transform late-arriving client operations, so its useful depth is "how far behind can a client be" — a client that reconnects with a version older than the trimmed window cannot be transformed correctly and must re-SYNC from scratch. Keeping the full log for a long editing session would grow memory without bound for a document that might stay open all day. The trade-off is that a client on a bad network which falls more than 500 operations behind silently loses its local unsent edits at re-SYNC; a more careful implementation would detect the underflow and warn rather than discard.

## Current State

Runs end to end. `docker-compose up -d` starts Postgres (schema auto-loaded from `backend/src/db/init.sql`) and Valkey; `npm run dev` starts the API and WebSocket server on 3001. Working: registration/login with bcrypt and cookie sessions, document CRUD with owner/permission model, real-time collaborative editing through the full SYNC → OPERATION → ACK → BROADCAST loop with OT conflict resolution, live presence and remote cursor rendering, threaded comments, version history with restore, suggestions, share modal with permission levels, Redis pub/sub so instances on 3001/3002/3003 see each other's operations and presence, opossum circuit breakers around both DB persistence and Redis publish (persist retries after the breaker's reset window), prom-client metrics including sync latency, operation counts by type, conflicts resolved, and active document/collaborator gauges, plus Pino structured logging with per-request and per-operation child loggers.

Seeded logins, all with password `password123`: `alice@example.com`, `bob@example.com`, `carol@example.com`, `david@example.com`, and `admin@docs.local` (admin). Seeded documents contain real ProseMirror JSON with headings, lists, marks, and code blocks, so the editor renders meaningful content immediately rather than a blank page.

Simplified or omitted: `transform` handles insert/delete pairs properly but treats `format` operations as pass-through, so concurrent formatting of overlapping ranges can produce surprising results. Insert-vs-insert at the identical position breaks ties by always shifting op1 after op2 rather than by a stable user-ID comparison, which is order-dependent. Sticky routing is assumed, not enforced — there's no load balancer in the compose file. There is no offline editing queue, no export, and no operational transform for the comment anchors, so comments can drift if text around them is heavily edited.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. The old file listed **"Full OT integration between editor and WebSocket"** and **"Cursor position sync across clients"** under Phase 2 *In progress* — both were fully implemented in `services/collaboration/ot.ts` and `cursors.ts`, complete with idempotency checks and Redis fan-out. It also called Phase 3 "Not started / Add caching layer, Add monitoring" while Redis pub/sub, opossum breakers, and the full prom-client metrics set were in use.
- **Collaboration service decomposed:** what was one large WebSocket handler is now `state / sync / ot / presence / cursors / permissions / persist` under `services/collaboration/`, with the pure transform algebra isolated in `services/ot.ts`. The split matters because the transform functions are the only part that must be provably correct, and they're now testable without a socket.
- **Backend `dev` pinned to `PORT=3001`:** the Vite proxy targets 3001 for both `/api` and `/ws`, but the script previously let `index.ts` fall back to its default 3000 — so the frontend proxied to a port nothing was listening on and every request failed with a connection error that looked like an auth bug.
- **Circuit breakers on persistence and pub/sub:** a slow Postgres previously meant debounce timers stacking up on a hung write. Persist and publish are now separate opossum breakers; when the persist breaker is open the operation is re-queued after the reset window (`isCircuitOpen` branch in `persist.ts`) instead of being dropped, and an open publish breaker degrades to same-server-only broadcast with a warning rather than failing the edit.
- **Seed password hashes corrected:** seeded users' bcrypt hashes didn't match the documented `password123`, so every seeded login failed. (The comment at the top of `backend/db-seed/seed.sql` still shows the superseded hash — the `INSERT` values are the correct ones.)
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Postgres/Redis services these tests need). Verification is local: `npm run type-check` in both halves, then `npm run triage google-docs`.

## Open Questions

1. The version counter lives in each server's memory, so correctness depends on sticky routing that nothing currently enforces. Is the right fix a document-affinity load balancer (simple, but a server restart drops every document it owned), or moving the counter into Redis with atomic increments (survivable, but puts a network round trip in the middle of the transform loop)?
2. Debounced persistence means acknowledged edits can be lost for up to a second. Should the `operations` append become synchronous — cheap, sequential, and enough to replay — while only the snapshot stays debounced?
3. Format operations are currently pass-through in `transform`. What's the minimum correct handling for concurrent overlapping formatting, and is it worth the complexity given how rarely two people bold the same span?
4. Comment anchors are stored as plain positions with no transformation applied. As soon as text above a comment is edited, the anchor is wrong. Does this need its own OT path, or should comments anchor to ProseMirror node IDs instead of character offsets?

## Resources

- [Operational Transformation FAQ](https://www3.ntu.edu.sg/home/czsun/projects/otfaq/) — the canonical reference for the transform properties `services/ot.ts` implements
- [What's different about the new Google Docs: Making collaboration fast](https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs.html) — Google's own account of server-authoritative OT
- [ProseMirror Guide](https://prosemirror.net/docs/guide/) — the document model behind the stored JSON
- [TipTap Documentation](https://tiptap.dev/docs)
- [Redis Pub/Sub](https://redis.io/docs/latest/develop/interact/pubsub/) — the cross-instance transport in `collaboration/index.ts`

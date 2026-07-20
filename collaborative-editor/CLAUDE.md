# Collaborative Editor — Development with Claude

## Project Context

Real-time collaborative text editing is the canonical example of a problem where the obvious solution is wrong. "Send the new document text on every keystroke" converges, but it's O(document) per keystroke and last-write-wins destroys concurrent edits. "Send a diff" fails the moment two people type at once: your insert at index 10 and my delete at index 4 were both computed against a document that no longer exists by the time either arrives.

Operational Transformation is the answer this project implements: every edit is an *operation* (a sequence of retain/insert/delete components), and when an operation arrives that was based on a stale version, the server transforms it against every operation that landed in between, producing an equivalent operation valid against the current state. The correctness property the whole system rests on is `apply(apply(doc, a), b') == apply(apply(doc, b), a')` — convergence regardless of arrival order.

The second half of the problem is latency. If a keystroke waits for a server round-trip before appearing, the editor feels broken. So the client applies locally and immediately, then reconciles — which means the client also needs a transform implementation and a small state machine (one in-flight operation, a queue of pending ones) that mirrors the server's.

**Learning goals:** implementing OT transform/compose correctly, server-authoritative operation ordering, an optimistic client state machine that survives out-of-order arrivals, snapshot-plus-oplog persistence, and multi-server fanout of a stream that must stay ordered per document.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **Express + `ws` server** (`backend/src/index.ts`) | **3001** | One process serves both the REST API (`/api`) and the WebSocket endpoint (`/ws`); OT needs a single authority per document, and colocating avoids a hop between the HTTP tier and the sync tier |
| **PostgreSQL 16** | 5432 | `operations` has a `UNIQUE (document_id, version)` constraint — the oplog *is* the source of truth for ordering, so it needs a real transactional store, not a cache |
| **Valkey (Redis)** | 6379 | Presence only (cursors, selections, connected clients) with a 1-hour TTL. Presence is disposable and high-churn; writing cursor moves to Postgres would be absurd |
| **RabbitMQ** | 5672 / 15672 | Cross-server operation fanout via the `doc.operations` topic exchange, plus a `snapshot.worker` queue for offloading snapshot writes |
| **Prometheus + Grafana** | 9090 / 3000 | Optional, behind the `monitoring` compose profile |

The OT core is duplicated *on purpose*: `backend/src/services/TextOperation.ts` + `OTTransformer.ts` and `frontend/src/services/TextOperation.ts` + `OTTransformer.ts` are parallel implementations, because both sides must transform. `backend/src/services/DocumentState.ts` holds per-document in-memory state (content, version, connected clients) and owns `applyOperation`; `SyncServer.ts` is the connection/routing layer. Frontend is React 19 + Zustand + Tailwind with no router — `frontend/src/stores/editorStore.ts` is the client state machine, and Vite proxies both `/api` and `/ws` to 3001.

Note the shape of the auth story: there is none. Connections carry `?documentId=&userId=` query params and `frontend/src/components/UserSelector.tsx` just picks one of the seeded users. That is deliberate — see Current State.

## Key Design Decisions

### 1. OT over CRDT, because the payload is plain text and the server is already authoritative

A CRDT (Yjs, Automerge) would remove the need for a central transform authority, which is genuinely attractive. It fails here on metadata cost: sequence CRDTs assign every character a unique, globally-ordered identifier, so a 100KB document carries ~100K identifiers plus tombstones for every deleted character — a document that has been heavily edited never shrinks, and the "garbage collection" story is the hardest part of every CRDT implementation. OT operations are proportional to the *edit*, not the document: typing one character is a three-component op (`retain n, insert "x", retain m`), a few dozen bytes regardless of document size.

We can afford OT specifically because we already accepted a central server for other reasons (persistence, access control, presence). OT's famous weakness — the transform function is subtle and TP2 violations in multi-way peer-to-peer merges are notoriously hard to get right — doesn't bite when every operation passes through one ordering authority, which reduces the problem to pairwise transforms against a linear history.

What we give up: real offline editing. A client that goes offline for an hour comes back with operations based on a version the server may have snapshotted past, and our recovery path is a full `resync` (server pushes current version + content, client discards local state). A CRDT would merge that cleanly. We chose "collaborative while connected" over "collaborative always."

### 2. Server-authoritative version numbers, with transform-on-arrival against the oplog

Every operation carries the client's known `version`. `DocumentState.applyOperation` reads `getOperationsSince(documentId, clientVersion)` and folds the incoming op through `OTTransformer.transform` once per concurrent op, then increments `version` and appends to `operations`. The `UNIQUE (document_id, version)` constraint means a version can only ever be claimed once — the database is the tiebreaker if application logic ever races.

The alternative — letting clients compute the merge peer-to-peer — needs every client to see every other client's operations in a consistent order, which is a consensus problem you now own. With N clients you get N(N-1) transform paths instead of N, and any client that computes a transform differently (a version skew, a subtly different implementation) silently diverges with no authority to detect it. Here, divergence is detectable: if `transformedOp.apply(content)` throws because base lengths don't match, we log it and push a `resync`.

The cost is a Postgres read per operation. At one keystroke per client per ~200ms that read is on the hot path of every edit, and it is the first thing that will break under load. We take it because it makes the concurrent-op set unambiguous even if the in-memory state was rebuilt after a restart. The `transform_latency` histogram is bucketed by concurrent-op count (`0`, `1-5`, `6-10`, `10+`) precisely so this cost is visible.

### 3. The client keeps exactly one operation in flight, never two

`editorStore.ts` maintains `inflightOp` (sent, awaiting ack) and `pendingOps[]` (applied locally, not yet sent). Local edits always apply optimistically and land in `pendingOps`; only when `inflightOp` is null does the store compose pending ops into one and send it. On a remote operation, it transforms against `inflightOp` first, then through each pending op in order, before applying to local content.

Allowing two in-flight operations breaks the transform chain: the server acks in order, but the client would need to know which server-side operations the second one was transformed against *relative to* the first, and the pairwise transform no longer has a well-defined base. The single-in-flight invariant collapses that to one unambiguous chain. The bonus is batching — a fast typist's five keystrokes during one round-trip get composed into a single operation, so operation count scales with round-trip time rather than typing speed.

What we give up is throughput per client under high latency: on a 500ms link, a client can send at most 2 operations per second no matter how fast the user types. That's fine, since composition means those 2 operations still carry every keystroke.

### 4. Snapshot every 50 operations, replay the tail on load

Documents persist as `document_snapshots` (content at a version) plus the full `operations` log. Loading walks the latest snapshot and replays only operations after it. Without snapshots, opening a document with 50,000 edits means deserializing and applying 50,000 JSONB operations — seconds of CPU before the first render, growing forever. Storing only the current text and discarding operations would make loading O(1) but destroy the concurrent-op set that decision 2 depends on: a client arriving with a stale version would have nothing to transform against, so every late operation becomes a resync.

50 is the tuning knob between the two. The trade-off is storage: we keep every operation forever with no compaction, so a document's row count grows without bound even though only the last ~50 are ever read.

### 5. Cross-server fanout through a topic exchange with per-server queues, not Redis pub/sub

`dev:server1/2/3` (ports 3001–3003) exist to run multiple sync servers, and clients on different servers editing the same document must see each other. `shared/queue.ts` publishes each applied operation to the `doc.operations` topic exchange with routing key `doc.<documentId>`; each server binds its own durable queue `op.broadcast.<serverId>` to `doc.*`, skips messages it published itself, and dedupes on `messageId` (`<documentId>-<version>`) via a Redis `seen:` key with a 1-hour TTL.

Redis pub/sub would be simpler and lower-latency, but it is fire-and-forget: a server that is briefly disconnected loses the messages published during that window with no way to know. For a stream where every operation is a required link in a transform chain, a silently dropped message means permanent divergence. Durable queues plus dedupe give at-least-once with idempotent handling, which is the correct shape here.

The publish path is wrapped in an Opossum circuit breaker with a 1000-message in-memory fallback buffer that drains on `close`, so a broker outage degrades to single-server operation rather than failing edits — the local broadcast has already happened by the time we publish.

The honest caveat: this fans out the *transformed* operation as computed by the originating server. A receiving server passes it through to its local clients without re-transforming against its own view, which is correct only because every server reads the same authoritative oplog. It has not been stress-tested for interleavings.

## Current State

Runs end to end on a single backend process (3001) plus Vite (5173). Working: the full OT core on both sides (retain/insert/delete, `transform`, `compose`, `apply`, `transformCursor`), server-authoritative versioning with the oplog, optimistic local application with in-flight/pending reconciliation, ack and `resync` protocol, live presence with per-client colors assigned round-robin, cursor *and* selection sync (`handleCursor` / `handleSelection` in `SyncServer.ts`, both persisted to Redis presence), snapshot-plus-replay loading, document create/rename/list over `/api/documents`, Prometheus metrics (operation counter, operation/sync/transform latency histograms, WS connection and active-document gauges), Pino structured logging with explicit conflict logging, an Opossum-protected RabbitMQ publish path, and idempotency keys on operations (`operationId` → cached ack, so a client retry after a dropped ack doesn't double-apply).

Seeded users are `alice` (Alice Johnson), `bob` (Bob Smith), and `charlie` (Charlie Brown) with fixed UUIDs, plus one "Welcome Document" at version 0. **There are no passwords** — `UserSelector.tsx` picks an identity and the WebSocket carries `userId` as a query param. `document_access` exists in the schema with view/edit/admin permissions but nothing reads it. This is intentional: the project is about the transform algorithm, and adding sessions would only add noise to the sync path.

Intentionally simplified or absent: rich text (operations carry no attributes, so bold/italic have nowhere to live), offline editing (no local persistence — a refresh discards pending ops), a version-history UI (the data is all there in `operations`, nothing renders it), and comments.

**One real gap worth knowing:** `queueSnapshot` publishes to the `snapshot.worker` queue every 50 operations, but nothing consumes that queue. Snapshots are only actually written on the synchronous path — when the last client disconnects (`saveSnapshot` in `handleDisconnect`) or when the publish itself throws and falls back. In practice snapshots do happen, just not on the interval the code implies.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. The old checklist was wrong in both directions — it listed "Selection sync" as unbuilt under Phase 3 while `SyncServer.handleSelection` and `presence.updateSelection` were fully implemented and wired to the client, and it marked Phase 2 "IN PROGRESS" with every item under it checked. It also never mentioned RabbitMQ, idempotency keys, circuit breakers, or metrics, all of which are in the code.
- **Backend port pinned to 3001:** `src/index.ts` still defaults `PORT` to 3000, but the `dev` script now hardcodes `PORT=3001` to match the Vite proxy targets for both `/api` and `/ws`. Without the pin the WebSocket proxy silently pointed at nothing and the editor loaded with no sync.
- **Seed data separated from schema:** `init.sql` is mounted at `docker-entrypoint-initdb.d` and contains schema only (all `CREATE TABLE IF NOT EXISTS`); seed rows live in `backend/db-seed/seed.sql` with `ON CONFLICT DO NOTHING`, so re-seeding is idempotent and doesn't collide with the initial snapshot row.
- **RabbitMQ failures made non-fatal:** the publish path is behind an Opossum breaker with a bounded (1000-message) fallback buffer, and `setupRabbitSubscription` logs a warning instead of throwing. A broker that isn't up yet degrades the app to single-server sync rather than breaking edits.
- **Operation apply failures now resync instead of crashing:** a base-length mismatch in `transformedOp.apply()` used to propagate; it now logs the full version/length context and pushes a `resync` message so the client recovers to a known-good state.
- **CI:** the repo-wide smoke-test workflow was removed — a CI runner can't provide the Postgres/Redis/RabbitMQ stack these tests need, so it failed on every PR without signalling a real defect.

## Open Questions

1. Transforming against the oplog means a Postgres read per keystroke. Should `DocumentState` keep a bounded in-memory ring of recent operations and only fall back to the database when a client's version is older than the ring — and if so, what happens when the ring misses after a server restart?
2. The `snapshot.worker` queue has no consumer, so periodic snapshots don't happen. Is a background worker actually worth it, or should snapshotting just be a synchronous write on the 50th operation, given it's one row and already off the ack path?
3. Cross-server fanout forwards the originating server's transformed operation verbatim. Under what interleaving does a receiving server's local clients need that operation re-transformed against operations *its* clients submitted concurrently — and does the `UNIQUE (document_id, version)` constraint actually catch that case, or just push it into a resync?
4. The `document_access` table exists but is unenforced. Adding permission checks means the WebSocket handshake needs a real session, which pulls auth onto the sync path — is there a way to check access once at connect time without making every operation carry auth state?

## Resources

- [Operational Transformation (Wikipedia)](https://en.wikipedia.org/wiki/Operational_transformation) — the convergence property and TP1/TP2 conditions
- [Google Wave operational transform whitepaper](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/operational-transform/operational-transform.html) — the client/server state machine this implementation follows
- [ot.js](https://github.com/Operational-Transformation/ot.js) — the reference `TextOperation` design (retain/insert/delete, compose, transform)
- [Yjs documentation](https://docs.yjs.dev/) — the CRDT alternative rejected in decision 1
- [RabbitMQ topic exchanges](https://www.rabbitmq.com/tutorials/tutorial-five-python.html) — routing-key fanout used for the multi-server broadcast

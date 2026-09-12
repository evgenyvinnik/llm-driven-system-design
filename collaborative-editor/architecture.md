# Collaborative Editor Architecture

## System Overview

This project studies a shared plain-text editor: writers see their own input immediately while a server orders edits, reconciles concurrency, and persists a recoverable document history. Its central question is how a responsive local view relates to an authoritative, durable version when another writer edits the same text or a connection disappears.

The production sections describe a **proposed design**, not measured capabilities of this repository. The checked-in application is a React textarea, an Express/WebSocket server, PostgreSQL, Valkey, and RabbitMQ. Its OT implementation, browser input path, and server coordination have correctness defects. [Implementation Notes](#implementation-notes) distinguish wired patterns, incomplete features, and reproducible failures.

Learning goals are to reason about operation context, ordering, optimistic reconciliation, durability acknowledgements, and recovery. Rich-text document models, comments, media, and offline-first synchronization are separate extensions.

## Requirements

### Functional requirements — proposed production service

- Create, discover, open, and rename documents under explicit view/edit/manage permissions.
- Collaborate on plain text with deterministic handling of concurrent insertions and deletions.
- Show participants and approximate cursors without delaying durable edits.
- Distinguish local changes, pending persistence, acknowledged edits, and interrupted synchronization.
- Recover after reconnect by reconciling an operation receipt and replaying an ordered suffix; preserve unresolved local work for recovery.
- Reconstruct historical versions and restore one as a new authorized edit, without rewriting history.

Version history and permissions are design requirements, not implemented UI features. Extended offline editing and rich text are out of the initial production scope. A temporary outage can preserve a draft without promising automatic integration of arbitrary old branches.

### Non-functional requirements — design targets

| Dimension | Target and boundary |
|-----------|---------------------|
| Responsiveness | Local input visible within a 16 ms frame budget for a typical 100 KB document |
| Synchronization | p99 durable acknowledgement below 200 ms and peer delivery below 300 ms within a region under normal load |
| Availability | 99.95% regional editing availability; stop accepting writes when document authority or durability is uncertain |
| Convergence | Authorized clients applying the same committed sequence converge after pending operations are reconciled |
| Durability | Acknowledged operations survive the configured database failover model; regional disaster recovery has an explicit separate RPO |
| Scale | 100,000 concurrent sessions across 20,000 active documents; up to 50 active writers per document initially |
| Safety | Bounded input size, operation backlog, transform history, document length, and socket buffers |

Convergence does not mean every semantic intention can be preserved. If one user deletes a sentence while another rewrites it, the protocol must define a deterministic policy, with history and recovery helping users understand the result.

## Capacity Estimation

These are sizing assumptions, not repository benchmarks. Suppose 20% of 100,000 connected sessions are actively typing, producing two operation batches per second: **40,000 operations/s** at peak. At 600 bytes per stored operation before indexes and replication, that is 24 MB/s of raw log data. A sustained daily average of 10,000 operations/s produces about 518 GB/day, so history retention, compression, and archival cannot be postponed indefinitely.

If five editors share a document on average, a committed operation needs about four peer deliveries: 160,000 messages/s or roughly 96 MB/s of payload at that peak. A hot document with 50 writers each sending two batches/s produces 100 commands/s and up to 4,900 peer deliveries/s. Sharding documents spreads aggregate load; it does not remove the ordering or fanout cost of that single document.

Twenty thousand active documents averaging 100 KB need about 2 GB just for raw text. Runtime string representation, recent operations, participant state, serialization, and socket queues add substantial overhead. A full snapshot every 50 operations at 40,000 operations/s would write about 80 MB/s for 100 KB documents. Prefer snapshot thresholds based on replay work, bytes, and elapsed time rather than treating 50 as a universal optimum.

### Local Development Scale

Use a few documents and two or three browser windows on one backend, with PostgreSQL, Valkey, and RabbitMQ. Scripts can start three backend processes, but cross-server consistency is incomplete. No verified local concurrency or resource-capacity result is supplied. The five seeded documents are small illustrative fixtures, not load-test evidence.

## High-Level Architecture

Proposed production topology; ports and Docker mappings belong in the README.

```
┌──────────────────┐       ┌──────────────────────┐
│ Browser editor   │──────▶│ Gateway / sessions   │
└──────────────────┘       └──────────┬───────────┘
                                      │ document routing
                           ┌──────────▼───────────┐
                           │ Document owner       │
                           │ Serialized OT stream │
                           └──────────┬───────────┘
                                      │ atomic commit
                           ┌──────────▼───────────┐
                           │ PostgreSQL           │
                           │ Head / log / receipt │
                           │ Snapshot / outbox    │
                           └──────────┬───────────┘
                                      │ outbox relay
                           ┌──────────▼───────────┐
                           │ Fanout + workers     │
                           │ Delivery / snapshots │
                           └──────────────────────┘
```

The gateway authenticates connections and routes each document's edits to one logical owner. Gateways may distribute delivery, but do not independently transform edits. Redis holds disposable presence; object storage can hold verified archived history. Static assets can use a CDN. Neither cache nor broker is the authority for the current document head.

## Core Components / Request Flows

### Open a document

1. Authenticate the user and check current document permission before disclosing metadata or content.
2. Route to the document owner, which loads a verified snapshot and a contiguous committed operation suffix when its cache is cold.
3. Admit the subscription at a sequence boundary: send state at version V, then ordered events after V. A gateway buffers intervening events while assembling the baseline.
4. Initialize client synchronization state with document identity, protocol version, connection generation, committed version, and unresolved local operation identity.
5. Publish presence separately. A presence outage may hide collaborators while document edits remain available.

A snapshot followed by an uncoordinated subscription can miss the edit committed between them. Shared ownership of the baseline/subscription boundary, or buffering before obtaining the baseline, closes that gap.

### Accept an edit

The editor derives an operation from the **previous model**, applies it once locally, and queues it. It keeps at most one submitted operation awaiting acknowledgement; further edits remain local and may be composed before submission.

The server serializes commands for that document, validates the supplied base revision and operation structure, resolves any durable receipt, and transforms an unseen operation against the committed suffix since its base. It computes candidate content without publishing that content as committed. In one database transaction it validates authority, advances the document head, appends the operation and receipt, updates metadata, and records an outbox event. It then updates its memory to the committed state and acknowledges the exact operation ID and assigned version.

A commit whose result is unknown pauses the document command stream until the durable receipt/head resolves the outcome. It must not immediately retry a changed operation against possibly committed state. A failed transaction leaves the committed in-memory view unchanged.

### Reconcile remote edits

A client checks document identity and event sequence before applying a remote operation. It transforms that operation through its in-flight and pending operations, updating both the remote operation and the local operations' contexts. Its visible text remains the committed base plus pending local intent; acknowledgement retires the matching in-flight operation without applying it a second time.

The tie policy must agree across the full protocol. For this proposal, an already committed insertion precedes a newly admitted concurrent insertion at the same position. The client uses that same committed-versus-pending priority. Calling the same transform function with opposite operand priorities does not establish convergence.

### Reconnect and history

Before replacing local state, preserve the acknowledged base, in-flight identity, and unsent changes. Ask whether the in-flight operation committed, obtain the missing ordered suffix, and reconcile before resending. If the base is outside supported history or the protocol cannot safely rebase it, offer a recoverable local draft alongside current server content. An exact byte-for-byte retry must retain its operation ID and original request context.

A historical preview reconstructs the nearest snapshot at or before the requested version plus a bounded suffix. Restoring history submits a new operation against the current head after an explicit concurrency check; it does not reset version numbers or delete intervening edits.

## Database Schema

### Checked-in local schema

The following is the actual [backend/src/db/init.sql](./backend/src/db/init.sql). It is useful for inspecting the running demo, but it does not contain the additional authority and recovery fields required by the production proposal.

```sql
-- Create extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(200) NOT NULL,
  email VARCHAR(255),
  color VARCHAR(7) DEFAULT '#3B82F6',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL DEFAULT 'Untitled Document',
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Document snapshots (periodic checkpoints)
CREATE TABLE IF NOT EXISTS document_snapshots (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, version)
);

-- Operations log
CREATE TABLE IF NOT EXISTS operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  client_id VARCHAR(100),
  user_id UUID REFERENCES users(id),
  operation JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS idx_operations_doc_version ON operations(document_id, version);

-- Document access
CREATE TABLE IF NOT EXISTS document_access (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(20) NOT NULL DEFAULT 'edit', -- view, edit, admin
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);

-- Seed data is in db-seed/seed.sql
```

The schema has five tables. `document_access.permission` has no enum/check enforcement, and the application does not read this table. Operation `client_id` identifies a socket, not a stable edit. There is no operation request ID, document head row, fencing generation, outbox, session table, comment table, or audit table. Several foreign-key columns are nullable; uniqueness of `(document_id, version)` prevents two rows claiming one revision but does not make the surrounding workflow atomic.

The explicit operation index duplicates the column order of the unique constraint's index. Users have no password field. Seed data inserts three users and five documents with snapshots at version zero; it fabricates no edit history. The application creates new document metadata and its initial snapshot in separate statements.

### Proposed additions

| Record | Keys and responsibilities |
|--------|---------------------------|
| Document head | Document ID, committed version, protocol version, authority generation; locked/conditionally advanced with each append |
| Operation receipt | Unique document + authenticated actor + stable operation ID; original request fingerprint, accepted version, canonical result |
| Operation log | Unique document + sequence; validated transformed operation, actor, original receipt identity, committed timestamp |
| Snapshot manifest | Document + exact version, content/checksum, format version, verification status |
| Outbox | Event ID and document sequence, payload or durable log reference, delivery progress |
| Access grant | Document + principal, constrained role; changes coordinated with admission and active subscriptions |

Use database constraints for required fields, nonnegative versions, valid permissions, and receipt uniqueness. Bound JSON operations at runtime: each component has exactly one kind; counts are finite nonnegative integers; total consumption equals base length; insert lengths and produced length match; and the base belongs to the documented revision. String-length equality alone cannot prove that an operation is valid for that version.

For the initial production topology, the same PostgreSQL authority serializes permission changes and document admissions. Later document sharding keeps head, log, receipt, and outbox co-located. Archived segments retain manifests and restore verification; deletion of transform history is a product retention decision, not a side effect of taking a snapshot.

## API Design

### Current HTTP surface

| Method | Path | Request / response |
|--------|------|--------------------|
| GET | `/api/documents` | Returns every document's metadata, ordered by update time; no pagination |
| GET | `/api/documents/:id` | Metadata or 404; does not return content/history |
| POST | `/api/documents` | Required `ownerId`, optional `title`; returns newly created metadata with 201 |
| PATCH | `/api/documents/:id` | Required truthy `title`; returns success even if no row matched |
| GET | `/api/users` | All demo identities ordered by username |
| GET | `/api/users/:id` | Demo identity or 404 |
| GET | `/health` | Dependency status, server ID, uptime, and timing; degraded still returns 200 |
| GET | `/ready` | PostgreSQL query succeeds: 200; fails: 503 |
| GET | `/live` | Unconditional 200 |
| GET | `/metrics` | Prometheus exposition |

Example current creation request and response; IDs/timestamps are illustrative:

```json
{"ownerId":"11111111-1111-1111-1111-111111111111","title":"Planning notes"}
```

```json
{"id":"99999999-9999-4999-8999-999999999999","title":"Planning notes","ownerId":"11111111-1111-1111-1111-111111111111","createdAt":"2026-09-09T12:00:00.000Z","updatedAt":"2026-09-09T12:00:00.000Z"}
```

No login, logout, sharing, delete, history, or restore endpoints are implemented. Request checks are minimal and SQL errors often become generic 500 responses. TypeScript interfaces are not runtime validation.

### Current WebSocket surface

A connection uses `/ws?documentId=<uuid>&userId=<uuid>`. The server checks that both records exist, assigns a new socket client ID and rotating color, and sends `init` with content, version, and client-map entries. It trusts the supplied user identity.

A current operation request to append “d” to “abc” at version 0 is:

```json
{"type":"operation","version":0,"operation":{"ops":[{"retain":3},{"insert":"d"}],"baseLength":3,"targetLength":4}}
```

The normal acknowledgement is:

```json
{"type":"ack","version":1}
```

Remote `operation` messages include sender `clientId`, version, and transformed operation. `cursor` carries a position with `index` and optional `length`; `selection` carries a range or null. `client_join`/`client_leave` update the roster. On an operation error, `resync` supplies the server's current in-memory version/content; the client replaces its text and clears pending work. Generic `error` messages are only logged by the browser.

`operationId` is an optional server-side extension, absent from browser sends and acknowledgements. There is no heartbeat, receipt query, replay request, gap detection, retry protocol, or protocol-version negotiation.

### Proposed contract extensions

Keep document and operation identity explicit across every edit and acknowledgement. Add authenticated session establishment, runtime schema validation, a sequence-aware replay/baseline handshake, operation receipt lookup, and clear rejection reasons such as permission revoked, unsupported base, or operation too large. An accepted edit is durable; a broker notification merely announces that committed edit.

## Key Design Decisions

### Central ordering with OT

Choose OT for the proposed connected plain-text editor because the service already controls admission, permissions, and one document history. A short operation expresses a small edit without transferring an entire document. Central order bounds the contexts the client protocol must reconcile.

Whole-document last-write-wins replacement is simpler but can erase another writer's unrelated paragraph. OT retains both edits when their semantics permit, at the cost of a difficult transform algorithm and carefully specified client/server state machine. Shared implementation code reduces drift but cannot prove the algorithm or operand ordering correct.

A CRDT is a credible alternative when extended offline collaboration or multiple independent writers is fundamental. It changes the identity and merge model; it does not remove authentication, storage, history, or delivery responsibilities. Avoid blanket claims that every CRDT permanently stores every deleted character or has a fixed memory multiplier: [Yjs exposes garbage-collection controls](https://docs.yjs.dev/api/y.doc), and its [IndexedDB provider](https://docs.yjs.dev/getting-started/allowing-offline-editing) supports local persistence. Those capabilities are not dependencies or features of this demo.

### One document owner, many delivery connections

All admissions for a document pass through one serialized owner, even when readers connect to many gateways. A database-checked authority generation prevents a stale owner from committing after replacement. The owner queue must encompass asynchronous persistence: Node.js's single JavaScript thread does not serialize an entire async workflow across awaits.

Independent server-local copies plus broker fanout would improve write availability superficially but leave concurrent transforms operating on incompatible heads. A unique SQL version constraint rejects collisions after the fact; it cannot roll back speculative memory or repair clients. The chosen design trades a document's write availability during uncertain failover for a single accepted history. Consistent-hash routing helps placement, but membership changes still require fencing and recovery.

### Snapshot plus durable ordered log

Append a small operation and use verified snapshots to bound reconstruction work. Full snapshots on every edit repeat most of the content; keeping only the latest text sacrifices history and retry context. The chosen approach adds replay validation, retention management, and snapshot workers.

Build a snapshot from an exact committed version, verify its checksum and replay boundary, then publish it as usable. Retain the previous snapshot until the new one is verified. A snapshot is a recovery optimization; it is not acknowledgement of an uncommitted edit and does not independently justify deleting the log.

## Consistency and Idempotency

The production acceptance unit is the document head, operation, receipt, and outbox event in one transaction. Look up receipts scoped to the document and actor; reject reuse with different original content or base. Cache successful receipts only as an optimization. A Redis TTL is not a durable retry horizon.

Publish committed sequence numbers through an outbox relay, and make every delivery consumer deduplicate **within its own subscription**. A global “seen” flag can incorrectly suppress delivery to other gateways. Clients ignore duplicates, buffer bounded gaps, and replay missing committed operations before advancing their visible synchronization baseline.

Publisher confirmation and consumer acknowledgement are separate broker boundaries; neither proves that a peer rendered an edit. See [RabbitMQ's acknowledgement documentation](https://www.rabbitmq.com/docs/confirms). Use confirmed publication, retained outbox state, and consumer recovery; the current code's ordinary channel publication provides none of that end-to-end transactionality.

During reconnect, resolve the old in-flight request before sending a rebased successor. Preserve original retry identity even if the local representation was transformed while waiting. Never blindly resend a new operation ID for an ambiguous edit, nor overwrite a draft as the only recovery path.

## Security / Auth

Production uses an authenticated session, HttpOnly/Secure cookies, CSRF protection for HTTP mutations, and WebSocket origin checks. Authorize metadata, initial content, editing, presence, history, and permission changes; do not equate knowing a document or user UUID with access.

Revocation is ordered with new admissions and prevents subsequent content delivery to revoked connections. Already disclosed content cannot be recalled. Reconnect rechecks access, and unresolved local text remains private to its owner until a permitted recovery action exists.

Limit operation bytes, document length, nesting, edit rate, reconnect rate, and transform work per client/document. Use a consistent position unit—this JavaScript demo uses UTF-16 code units—and an editor adapter that respects user-visible character boundaries. Attribute fields alone do not implement rich text or sanitize HTML.

**Current local behavior:** all document/user HTTP routes are public; callers supply `ownerId` and WebSocket `userId`; `document_access` is unused. No sessions, passwords, rate limiter, origin validation for WebSockets, or semantic operation validator is wired. REST CORS is configured, but is not an authorization boundary.

## Observability

Production should measure input-to-local-render, admission-to-durable-ack, committed-sequence-to-peer-application, owner queue length, transform work, replay length, receipt ambiguity, reconnect/resync rates, and snapshot verification failures. Presence lag is a separate signal. Use low-cardinality labels and correlate individual failures through structured event IDs without logging document contents.

The local server exposes Pino events and prom-client metrics in [shared/logger.ts](./backend/src/shared/logger.ts) and [shared/metrics.ts](./backend/src/shared/metrics.ts). Connection/document/collaborator gauges refresh every five seconds; the RabbitMQ consumer queue-depth gauge refreshes every ten seconds. Transform duration is bucketed by the number of concurrent operations.

Metric names overstate some boundaries: `collab_operation_latency_ms` is observed after broker publication, although its help text says receive-to-ack. `collab_sync_latency_ms` covers local send/publication calls, not peer receipt or rendering. The connection-duration histogram is declared but never observed. Queue depth covers the operation consumer queue, not snapshot backlog or the fallback buffer.

`/health` checks PostgreSQL, Redis, and obtaining a Rabbit channel, but responds 200 for degraded dependencies. `/ready` checks only PostgreSQL. Neither establishes active Rabbit consumers, a safe document owner, or OT correctness. Shutdown closes the WebSocket server and dependencies without explicitly draining edits or closing each client first; asynchronous disconnect snapshots may race database shutdown.

## Failure Handling

| Failure | Proposed behavior | Current implementation limitation |
|---------|-------------------|-----------------------------------|
| Lost acknowledgement | Resolve a durable receipt, then retry the identical request if unseen | Browser sends no operation ID or automatic retry |
| Invalid operation | Reject before committed state changes; retain recoverable local work | Deserialization trusts lengths and component structure |
| Database append failure | Discard candidate state, pause on uncertain commit | Memory/content version changed before persistence; resync can expose that state |
| Broker outage | Keep committed outbox events, show delivery lag, recover consumers | Bounded process-memory buffer can drop; subscription recovery is missing |
| Missing sequence | Replay a bounded suffix or obtain a coordinated baseline | Remote versions are accepted without contiguous checks |
| Snapshot worker failure | Retain log, alert on replay cost/backlog | Snapshot queue has no consumer |
| Owner failure | Fence old generation, replay verified state, resume admissions | No owner election, fencing, or command queue |
| Presence outage | Continue durable editing with reduced awareness | Redis failures can fail connection setup or fail an operation after its SQL append |
| Local pending work during resync | Save draft and reconcile receipt/history | Client replaces content and clears pending/in-flight operations |

## Scalability Considerations

First establish correctness in one process: valid transforms, consistent insertion priority, serialized commands, and commit-before-publish memory. More processes amplify current race conditions.

Then partition by document ID, retain recent committed operations in a bounded owner cache, and fall back to PostgreSQL for older supported bases. The checked-in implementation reads the operation suffix from PostgreSQL on every edit; it has no recent-operation ring. Asynchronous queries do not block the JavaScript event loop while waiting, but consume latency and database capacity; synchronous transform, diff, and string copying do consume CPU on that thread.

Separate a hot document's ordered admission from its delivery fanout. Throttle cursor updates, coalesce each participant's newest cursor, and disconnect slow consumers with a resumable sequence rather than growing unbounded buffers. A 50-writer limit is an admission decision, not something RabbitMQ prefetch enforces.

Keep one home region per document initially. Replicated read history can tolerate bounded staleness; live editing must route to the authority. Multi-region independent writes require a deliberately different conflict/authority model and cannot be added merely by replicating the broker.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Connected text synchronization | OT with ordered document admission | Independent whole-document replacement | Preserve concurrent edits under a defined policy |
| Offline scope | Recoverable interrupted drafts | Extended offline collaborative branches | Keep the initial protocol and supported history bounded |
| Write authority | One fenced owner per document | Independent mutable server copies | Prevent conflicting accepted histories |
| Persistence | Operation log + verified snapshots | Full content write per keystroke | Bound storage amplification and reconstruction work |
| Delivery | Committed outbox + ordered replay | Best-effort fanout alone | Recover missed notifications without inventing commits |
| Presence | Expiring, coalesced transient state | Durable cursor event history | Awareness can tolerate loss; edits cannot |

## Implementation Notes

### Production patterns present, with their actual boundaries

**Optimistic operation state.** [editorStore.ts](./frontend/src/stores/editorStore.ts) tracks a visible string, committed version, one in-flight operation, and pending operations. Its core operation path is intended to apply a change and then queue it:

```typescript
const newContent = operation.apply(get().content);
const newPending = [...pendingOps, operation];
set({ content: newContent, pendingOps: newPending });
```

This pattern supports instant input without waiting for the network, but the current textarea violates the required old-state precondition described below. Pending operations are composed only when flushing, so a long unacknowledged interval can also grow the local array.

**Snapshot plus replay.** [DocumentState.ts](./backend/src/services/DocumentState.ts) loads the latest PostgreSQL snapshot and applies later logged operations in version order. Every 50 operations it publishes a snapshot request; queue failure falls back to a synchronous save. Last-client disconnect also attempts a snapshot. These are real call sites, but successful publication does not write a snapshot because no worker consumes `snapshot.worker`. Saves upsert content for an existing version, and failures are logged/swallowed. No checksum or contiguous-history validation protects reconstruction.

**Circuit breaker and bounded fallback.** [shared/queue.ts](./backend/src/shared/queue.ts) uses an Opossum breaker for operation publication, with a two-second timeout, 50% failure threshold, minimum volume five, and 15-second reset interval. Its fallback buffers up to 1,000 events in memory and returns success even when the buffer is full. It drains only on a breaker `close` event, removes all buffered entries before attempting delivery, and logs drain failures without restoring them. A few isolated failures need not open the breaker, so their buffered events need not be drained on a later successful publish. This bounds one memory structure; it does not ensure recovery or durable delivery.

DB/Redis/OT breaker option objects in [shared/circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) are unused. Snapshot publication does not use the operation publish breaker. The timeout cannot undo a publication that completes later.

**Broker acknowledgements and deduplication.** Per-server durable queues bind to `doc.*`, use prefetch 10, manually acknowledge messages, and requeue once before dead-lettering. Ordinary `createChannel`/`publish` calls do not await publisher confirms or honor the publish backpressure boolean. No dead-letter consumer is implemented. Consumer deduplication uses a shared Redis `seen:<document-version>` key, lacking recipient identity and an atomic claim; one server can suppress another's required delivery, or simultaneous consumers can both pass the check.

**Optional request cache.** [shared/idempotency.ts](./backend/src/shared/idempotency.ts) stores one-hour results under `idempotent:<operationId>`. The server extension checks this before applying an operation, but the browser never sends the field. Keys are not bound to document, actor, or content, and check/apply/store is not atomic. Cache writes can fail after SQL append. There is no durable receipt column or retry safety after expiration.

**Presence, logs, and probes.** [services/redis.ts](./backend/src/services/redis.ts) keeps a document-wide hash with one-hour expiry refreshed on joins only. Cursor writes do not refresh it, and individual users have no heartbeat expiry. Cached clients from other servers can prevent local document eviction after local sockets leave. Join/leave/cursor/selection broadcasts stay within one process; they are not sent through RabbitMQ. Structured logs and dependency probes are wired, subject to the boundaries in [Observability](#observability).

### Verified correctness gaps

The review ran isolated checks against the actual frontend/backend OT classes and Zustand store, without starting a database, broker, or browser application. These examples establish specific defects, not a complete correctness test suite.

| Area | Evidence and consequence |
|------|--------------------------|
| Basic input | [TextEditor.tsx](./frontend/src/components/TextEditor.tsx) calls `setContent(newValue)` before `applyLocalChange`. Starting with “abc”, setting “abcd” then applying retain-3/insert-d throws “expected 3, got 4”; content changes but no pending operation is queued. Ordinary insertions/deletions can remain unsent while the header shows Saved. |
| Partial transform consumption | Both [backend](./backend/src/services/OTTransformer.ts) and [frontend](./frontend/src/services/OTTransformer.ts) replace an array remainder but keep the old `o1`/`o2` variable. Transforming retain-3 against retain-1/insert-X/retain-2 throws “op2 ran out of operations”; composing the same sequential pair also throws. |
| Insertion priority | With empty text, A admitted first and concurrent B arriving later, server `transform(B,A)` produces BA. B's client processes the committed A using `transform(A,B)` and produces AB. Pairwise algorithm reuse does not repair opposite protocol priorities. |
| Cursor coordinates | Insert-X/retain-1/delete-2 on “abc” moves an original cursor inside the deleted span to position 1 in the helper; its correct output boundary is 2 in “Xa”. A preceding insertion's offset is lost when the cursor falls inside a later deletion. |
| Operation validation | Deserializing an operation with base/target length 3 but only retain-1 and applying it to “abc” returns “a”. The helper checks the declared base length, not full consumption or produced length. |

[SyncServer.ts](./backend/src/services/SyncServer.ts) has no serialized per-document command queue. Async message handlers can overlap at database/Redis awaits. [DocumentState.ts](./backend/src/services/DocumentState.ts) queries history, changes shared memory and increments its version before SQL persistence, then reads that mutable version again after later awaits. An interleaving can produce stale transform context or an acknowledgement version belonging to a later operation. `saveOperation` inserts the log and updates the document timestamp in separate statements; timestamp failure can leave a committed log row while the caller takes its error path. Failed appends do not roll back memory, and later snapshots/resyncs can expose that uncommitted state.

Concurrent first connections can each create/load their own DocumentState because the map entry is installed only after awaiting load. Initialization and subscription are not coordinated with an admission boundary. Loading caches its promise, including rejection, within an instance.

Remote RabbitMQ operations are forwarded to local sockets but **never applied to that server's DocumentState**. Its next edit, new-client initialization, or disconnect snapshot can therefore use stale content/version. Broker fanout supplies neither an exclusive owner nor a consistent replicated state machine.

Rabbit subscription setup runs once. A comment promises retry on the next operation, but no such call exists. A failed initial connection leaves the shared `isConnecting`/promise state unrecovered; a later connection close clears handles but does not restore the consumer. Even a reconnected publisher is not evidence that subscriptions resumed. The seeded incident postmortem is fictional and must not be treated as proof of lossless broker recovery.

### Browser behavior and local substitutions

The UI is a native textarea, not contenteditable or a rich-text framework. Diffing finds one common prefix/suffix around a changed region. The editor preserves selection by clamping old numeric offsets after replacing text; it does not transform the local caret through remote edits. IME events defer local submission until composition end, but remote updates can still replace textarea content during composition.

The collaborator sidebar displays colored identities and numeric cursor offsets. It has no remote caret/selection overlay, activity timeout, or accessible live-announcement system. The browser sends `cursor` positions, not separate selection messages, and does not transform roster positions on incoming edits.

The store accepts acknowledgements and remote versions without validating sequence continuity, identity, or an outstanding operation ID. Remote-transform/JSON failures are uncaught in the message callback. Old socket callbacks are not isolated by connection generation, so switching document/user can allow a prior socket's close/message to alter the new session. `onclose` only marks disconnected; it schedules no reconnect. Reopening a document gets a new baseline and discards pending work. A server resync likewise clears in-flight/pending operations without preserving a draft or resolving whether the previous edit committed.

App state chooses a document rather than a route. The title input receives a no-op callback. List/create/user-fetch failures are logged with little UI feedback; failed document fetches can resemble an empty list. The demo identity picker is intentionally simple but supplies no authentication or permission enforcement.

### What is omitted and how to verify progress

There is no offline store/service worker, undo manager, history service/UI, rich-text formatting, comments, shared OT package, Zod validator, snapshot worker, outbox relay, durable request receipt, load balancer, authority fencing, or multi-region deployment. Optional Compose monitoring starts generic Prometheus/Grafana containers; Grafana dashboards are not provisioned.

The [README](./README.md) supplies actual scripts, seed instructions, native infrastructure, and port mappings. The existing [smoke test](./tests/smoke.spec.ts) verifies a heading and absence of error-boundary text only. Future implementation work should first verify valid operation algebra and protocol tie ordering, then input transmission and two-client convergence, then crash/retry/reconnect and multi-process ownership. Build success or a screenshot cannot establish those properties.

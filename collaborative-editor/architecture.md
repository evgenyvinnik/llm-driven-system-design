# Design Collaborative Editor - Architecture

## System Overview

A real-time collaborative document editor enabling multiple users to edit documents simultaneously with instant synchronization and conflict resolution. Core challenges involve maintaining consistency across distributed clients, handling concurrent edits without data loss, and providing offline support with automatic merge on reconnect.

**Learning Goals:**
- Implement operational transformation (OT) algorithms for conflict resolution
- Design real-time synchronization protocols over WebSocket
- Handle presence and cursor tracking across distributed servers
- Build snapshot + operation log storage for version history
- Coordinate multi-server broadcast via message queues

---

## Requirements

### Functional Requirements

1. **Edit**: Multiple users edit the same document simultaneously with instant local feedback
2. **Sync**: Real-time updates across all connected clients with guaranteed convergence
3. **History**: Track and navigate document versions via periodic snapshots + operation log
4. **Share**: Control document access with view, edit, and admin permissions
5. **Offline**: Edit without connectivity, sync and merge on reconnect
6. **Presence**: See other users' cursors, selections, and online status in real time

### Non-Functional Requirements (Production Scale)

| Requirement | Target |
|-------------|--------|
| Local Latency | < 50ms for changes to appear locally |
| Sync Latency | < 100ms for operation to reach all connected clients |
| Consistency | All clients converge to the same document state |
| Availability | 99.9% uptime |
| Scale | 50+ simultaneous editors per document, 100K+ concurrent documents |
| Durability | Never lose user edits, even during server crashes or network partitions |

---

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Concurrent documents | 100,000+ |
| Editors per document (peak) | 50+ |
| Operations per second (global) | 500,000 |
| Average operation size | 50-200 bytes |
| Snapshot frequency | Every 50-100 operations per document |
| Storage per document (1 year) | ~10 MB (snapshots + op log) |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent documents | 5-10 |
| Editors per document | 2-5 |
| Operations per second | 10-50 |
| Single PostgreSQL instance | Handles all data |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Editor                                │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Text Editor  │  │  OT Engine    │  │   Sync        │       │
│  │               │  │               │  │   Engine      │       │
│  │ - ContentEdit │  │ - Transform   │  │ - WebSocket   │       │
│  │ - Selection   │  │ - Compose     │  │ - Reconnect   │       │
│  │ - Presence UI │  │ - Apply       │  │ - Op buffer   │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │ WebSocket (persistent)
                              ▼
                    ┌─────────────────────┐
                    │   Load Balancer     │
                    │  (sticky sessions)  │
                    └──────────┬──────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
    ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
    │ Sync Server  │   │ Sync Server  │   │ Sync Server  │
    │  (Node.js +  │   │  (Node.js +  │   │  (Node.js +  │
    │   WebSocket) │   │   WebSocket) │   │   WebSocket) │
    └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
           │                  │                  │
           └──────────────────┼──────────────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  PostgreSQL   │    │    Redis/     │    │   RabbitMQ    │
│               │    │    Valkey     │    │               │
│ - Documents   │    │ - Presence   │    │ - Op fanout   │
│ - Operations  │    │ - Cursors    │    │ - Snapshot    │
│ - Snapshots   │    │ - Idempotent │    │   jobs        │
│ - Access ctrl │    │   cache      │    │ - DLQ         │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Core Components

### 1. TextOperation

The core data structure for representing text changes. Each operation is a sequence of retain, insert, and delete components:

- **retain(n)**: Keep n characters unchanged (used for positioning)
- **insert(str)**: Insert text at the current position
- **delete(n)**: Delete n characters at the current position

Every operation has a `baseLength` (document length before applying) and `targetLength` (document length after applying). This enables validation: an operation can only be applied to a document of exactly `baseLength` characters.

### 2. OT Transform Function

The transform function takes two operations (op1, op2) that were both created against the same document state and returns transformed versions (op1', op2') such that:

```
apply(apply(doc, op1), op2') === apply(apply(doc, op2), op1')
```

This convergence property ensures that regardless of the order operations arrive, all clients reach the same final state. The transform handles all combinations of retain/insert/delete pairs, splitting operations at boundaries when needed.

### 3. Document State Manager (Server-Side)

Maintains the authoritative document state:

```
applyOperation(clientId, clientVersion, operation)
├── Fetch all operations since clientVersion from PostgreSQL
├── Transform incoming operation against each concurrent operation
├── Apply transformed operation to current document content
├── Increment version counter
├── Persist operation to operations table
├── If version % 100 === 0: queue snapshot save via RabbitMQ
└── Return { version, transformedOperation }
```

### 4. Sync Server (WebSocket)

Manages WebSocket connections and real-time communication:

**Client to Server messages:**
- `operation { version, operation, operationId }` - Submit an edit
- `cursor { position }` - Update cursor position
- `selection { start, end }` - Update text selection

**Server to Client messages:**
- `init { clientId, version, content, clients }` - Initial document state
- `ack { version, operationId }` - Operation acknowledged with new version
- `operation { clientId, version, operation }` - Remote operation to apply
- `cursor { clientId, position }` - Remote cursor update
- `client_join / client_leave` - Presence updates
- `resync { version, content }` - Full resync on error recovery

### 5. Client Sync Engine

Each client maintains a state machine for operation synchronization:

- **content**: Current local document content (always up-to-date)
- **serverVersion**: Last acknowledged server version
- **inflightOp**: Operation sent to server, awaiting ack
- **pendingOps**: Operations applied locally but not yet sent

When receiving a remote operation:
1. Transform it against the inflight operation (if any)
2. Transform it against all pending operations
3. Apply the transformed operation to local content

When receiving an ack:
1. Clear inflightOp
2. Update serverVersion
3. Flush next pending operation (compose all pending into one, send)

### 6. RabbitMQ Queue Topology

Three exchanges handle async processing:

```
┌──────────────────────────────────────────────────────────────┐
│  doc.operations (topic)    doc.presence (fanout)              │
│  ┌──────────────────┐     ┌──────────────────┐               │
│  │ Routing: doc.{id}│     │ Broadcast to all │               │
│  └────────┬─────────┘     └────────┬─────────┘               │
│           │                        │                          │
│  Per-server queues:         Single fanout queue:              │
│  op.broadcast.server1       presence.fanout                   │
│  op.broadcast.server2                                         │
│  op.broadcast.server3                                         │
│                                                               │
│  doc.snapshots (direct)    doc.dlx (dead letter)             │
│  ┌──────────────────┐     ┌──────────────────┐               │
│  │ Snapshot jobs     │     │ Failed messages  │               │
│  └────────┬─────────┘     └────────┬─────────┘               │
│           │                        │                          │
│  snapshot.worker              doc.failed                      │
│  (prefetch=1)                 (manual retry)                  │
└──────────────────────────────────────────────────────────────┘
```

**Operation Broadcast**: When server1 receives an operation, it publishes to `doc.operations` with routing key `doc.{documentId}`. Each server has its own queue bound to this exchange. Servers skip messages from themselves and deduplicate via Redis-cached message IDs.

**Snapshot Worker**: Snapshots are queued via `doc.snapshots` and processed by a single worker with `prefetch=1` to avoid database contention. Idempotent INSERT ensures duplicate snapshot messages are harmless.

**Dead Letter Queue**: Failed messages route to `doc.dlx` for manual inspection and retry.

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Document snapshots (periodic checkpoints)
CREATE TABLE document_snapshots (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (document_id, version)
);

-- Operations log (complete history)
CREATE TABLE operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  client_id VARCHAR(100),
  user_id UUID REFERENCES users(id),
  operation JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (document_id, version)
);

-- Document access control
CREATE TABLE document_access (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  permission VARCHAR(20) NOT NULL CHECK (permission IN ('view', 'edit', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);

-- Inline comments on document ranges
CREATE TABLE document_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  range_start INTEGER,
  range_end INTEGER,
  content TEXT NOT NULL,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_operations_doc_version ON operations(document_id, version);
CREATE INDEX idx_snapshots_doc_version ON document_snapshots(document_id, version DESC);
CREATE INDEX idx_comments_doc ON document_comments(document_id);
CREATE INDEX idx_access_user ON document_access(user_id);
```

### Storage Strategy: Snapshot + Operation Log

Documents are stored as periodic snapshots plus a complete operation log. This provides:

- **Fast loading**: Fetch latest snapshot + apply only recent operations (not full history)
- **Complete history**: All operations preserved for version navigation and audit
- **Storage efficiency**: Snapshots every 50-100 operations; older operations can be archived

**Document loading flow:**
1. Query latest snapshot for document (ORDER BY version DESC LIMIT 1)
2. Query all operations after snapshot version
3. Apply each operation to snapshot content to reconstruct current state

---

## Key Design Decisions

### 1. OT over CRDT

**Decision**: Use Operational Transformation for conflict resolution.

**Why OT works for this system**: OT operations (retain/insert/delete) are compact -- typically 50-200 bytes regardless of document size. The server maintains canonical ordering, so the transform function only needs to handle the case where two operations were created against the same version. Google Docs uses this approach successfully at massive scale.

**Why CRDTs fail here**: CRDTs (like Yjs or Automerge) assign unique IDs to every character in the document. A 10,000-character document requires 10,000 unique IDs in memory, each with causal metadata. For a plain text editor, this is a 10-50x memory overhead compared to OT. CRDTs excel in peer-to-peer scenarios without a central server, but our server-authoritative design does not need that property. The tombstone problem (deleted characters retained in metadata forever) further inflates memory over time.

**Trade-off**: OT requires a central server to establish operation ordering. This means the system cannot function in a true peer-to-peer mode. For a collaborative editor with a backend, this constraint is acceptable and simplifies the consistency model.

### 2. Server-Authoritative Ordering

**Decision**: All operations pass through the server, which assigns the canonical version number.

**Why it works**: The server is the single point of truth for operation ordering. When two clients submit concurrent edits, the server transforms one against the other and assigns sequential version numbers. This guarantees convergence without complex vector clocks or Lamport timestamps.

**Why peer-to-peer ordering fails**: Without a central authority, every client must maintain a full causal history and resolve conflicts independently. This requires O(n) state per client where n is the number of clients, and conflict resolution becomes an NP-hard problem for certain operation types. The operational complexity of peer-to-peer OT is why Google abandoned it in favor of server-authoritative OT.

**Trade-off**: Single point of failure. If the server is unreachable, no operations can be committed. We mitigate this with the operation buffer (clients continue editing locally) and RabbitMQ for multi-server fanout.

### 3. Snapshot + Operation Log Storage

**Decision**: Periodic snapshots with complete operation log, rather than storing full document snapshots on every change.

**Why it works**: A document edited 10,000 times stores 10,000 operations (each 50-200 bytes, totaling ~1 MB) plus ~100 snapshots (at every 100th operation). Storing a full snapshot on every keystroke for a 50 KB document would consume 500 MB.

**Why full-snapshot-only fails**: At 500,000 operations/second globally, storing a full document copy for each operation would overwhelm storage. More critically, version history requires diffing between adjacent snapshots, which is computationally expensive. With an operation log, the diff is the operation itself.

**Trade-off**: Loading a document requires replaying operations since the last snapshot. If the snapshot interval is too large (e.g., every 1000 ops), load time degrades. We snapshot every 50-100 operations to keep replay under 10ms.

---

## Consistency and Idempotency

### Operation Idempotency

Network issues cause clients to retry operations. Without idempotency, the same `insert("x", pos=5)` applied twice creates "xx" instead of "x", corrupting the document.

Each operation carries a client-generated `operationId` formatted as `{clientId}-{timestamp}-{contentHash}`. The server checks Redis for this ID before processing. On a cache hit, it returns the cached result (version + transformed operation) without re-applying. The cache TTL is 1 hour, long enough for all retries to complete.

### Message Deduplication for Multi-Server Broadcast

When operations are broadcast via RabbitMQ with at-least-once delivery, duplicate messages are possible. Each message carries a `messageId` of `{documentId}-{version}`. Consuming servers check Redis before processing and cache the messageId for 1 hour after successful processing.

### Delivery Semantics

| Queue | Delivery | Rationale |
|-------|----------|-----------|
| `op.broadcast.*` | At-least-once | Deduplicated by messageId in Redis; operations idempotent at same version |
| `snapshot.worker` | At-least-once | Idempotent INSERT with version check; duplicate writes harmless |
| `doc.failed` (DLQ) | At-most-once | Manual inspection; no automatic retry |

---

## Security and Auth

- **Session-based authentication** with Redis-backed store
- **Permission levels**: view (read-only), edit (can modify), admin (can share/delete)
- **WebSocket authentication**: Session validated on connection upgrade; unauthenticated connections rejected
- **Rate limiting**: Operations per second per client (prevents flood attacks)
- **Input validation**: Operation baseLength must match current document length; malformed operations trigger resync
- **Audit logging**: Document create, delete, share, permission change, and version restore events logged with user ID, IP, and timestamp

---

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `collab_ws_connections_total` | Gauge | Active WebSocket connections per server |
| `collab_active_documents` | Gauge | Documents with active editors |
| `collab_operations_total` | Counter | Operations processed (by status: success, error) |
| `collab_operation_latency_ms` | Histogram | Time from operation received to ack sent |
| `collab_transform_latency_ms` | Histogram | Time spent in OT transform |
| `collab_queue_depth` | Gauge | RabbitMQ queue depth per queue |
| `collab_circuit_breaker_state` | Gauge | 0=closed, 0.5=half-open, 1=open |
| `collab_duplicate_operations_total` | Counter | Idempotency cache hits |

### Structured Logging (Pino)

Key logged events:

| Event | When | Debug Value |
|-------|------|-------------|
| `operation_applied` | Every successful operation | Latency trends, throughput |
| `ot_conflict_resolved` | Concurrent operations transformed | client_version vs server_version gap, concurrent_ops count |
| `operation_apply_failed` | Transform produced invalid op | Bug detection in OT algorithm |
| `ws_connect` / `ws_disconnect` | Client presence changes | Connection stability |
| `document_loaded` | Server loads document state | Load time, content size |
| `snapshot_saved` | Periodic checkpoint | Backup frequency |

### Health Checks

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Comprehensive check (PostgreSQL + Redis + RabbitMQ latency) |
| `GET /metrics` | Prometheus metrics scrape endpoint |
| `GET /ready` | Readiness probe (all dependencies healthy) |
| `GET /live` | Liveness probe (process alive) |

### SLI Targets

| SLI | Target | Measurement |
|-----|--------|-------------|
| Operation Latency | p95 < 50ms | From operation received to ack sent |
| Availability | 99.9% | Successful operations / total attempts |
| Sync Lag | < 100ms | Time for operation to reach all clients |
| Recovery Time | < 30s | Time to reconnect and resync after disconnect |

---

## Failure Handling

### Circuit Breakers (Opossum)

Three circuit breakers protect against dependency failures:

| Dependency | Timeout | Error Threshold | Reset | Fallback |
|------------|---------|-----------------|-------|----------|
| PostgreSQL | 5s | 50% at 5+ requests | 30s | Fail operation, request client resync |
| Redis | 1s | 50% at 10+ requests | 10s | Presence updates fail silently |
| RabbitMQ | 2s | 50% at 5+ requests | 15s | Buffer publishes in-memory (up to 1000), local broadcast continues |

### Client-Side Retry Strategy

Operations use exponential backoff with jitter:
- Base delay: 100ms
- Max retries: 3
- Backoff: `baseDelay * 2^attempt * (0.5 + random())`
- After max retries: Request full resync from server

### Failure Handling Summary

| Failure Type | Detection | Response | Recovery |
|--------------|-----------|----------|----------|
| Client disconnect | WebSocket close event | Buffer operations locally | Reconnect with exponential backoff; resync on connect |
| Server crash | Health check failure | Load balancer removes server | Other servers handle clients; state in Redis/DB |
| Database unavailable | Circuit breaker opens | Fail operation, request resync | Drain queue when circuit closes |
| RabbitMQ unavailable | Circuit breaker opens | Buffer publishes locally | Replay buffered messages on recovery |
| Network partition | Timeout on cross-server RPC | Operate independently | Merge states on partition heal |
| Data corruption | baseLength mismatch on apply | Reject operation, send resync | Client receives fresh document state |

---

## Scalability Considerations

### Multi-Server Architecture

Each sync server handles a subset of documents. RabbitMQ enables cross-server operation fanout so clients connected to different servers editing the same document stay in sync. Servers are stateless except for in-memory document state (which can be reconstructed from PostgreSQL).

### Scaling Path

1. **Add sync servers**: Each server creates its own RabbitMQ queue. No configuration change needed.
2. **PostgreSQL read replicas**: Operations table is append-only, ideal for replication. Reads (document load, version history) go to replicas.
3. **Redis Cluster**: Presence and idempotency data sharded across nodes.
4. **RabbitMQ clustering**: Federation plugin for multi-region broadcast.

### What Breaks First

| Scale | Bottleneck | Mitigation |
|-------|-----------|------------|
| 1K concurrent docs | Single PostgreSQL write throughput | Batch INSERT for operations |
| 10K concurrent docs | Memory per sync server (document state in RAM) | Evict idle documents, reload on reconnect |
| 100K concurrent docs | RabbitMQ message throughput | Shard exchanges by document ID range |
| 50+ editors/doc | OT transform CPU (quadratic with concurrent ops) | Limit concurrent editors, batch transforms |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Sync algorithm | OT | CRDT | Compact operations, lower memory, server-authoritative |
| Transport | WebSocket | HTTP polling | Sub-100ms latency required for real-time editing |
| Storage | Snapshot + op log | Full snapshots only | 100x storage reduction, built-in version diffs |
| Authority | Server-authoritative | Peer-to-peer | Guaranteed convergence, simpler consistency model |
| Cross-server sync | RabbitMQ topic exchange | Redis Pub/Sub | Durable messages survive restarts, DLQ for failures |
| Session storage | Redis | In-memory | Multi-server session sharing, persistence |

---

## Frontend Architecture

### Component Hierarchy

```
App
├── Header                    (document title display)
├── UserSelector              (dropdown to pick demo user identity)
├── DocumentList              (list of documents with create button)
│                              shown when no document is selected
├── TextEditor                (textarea for collaborative editing)
│                              shown when a document is selected
└── UserList                  (sidebar showing connected collaborators
                               with colored cursor indicators)
```

The application uses a simple two-state layout managed in `App` rather than a router. If no document is selected, `App` renders the `DocumentList` view where users can browse, create, and select documents. Once a document is selected, `App` renders the editor view with the `TextEditor`, `Header`, `UserList`, and a "Back to Documents" button. This is intentional -- there is no TanStack Router because the editor experience is a single view with no URL-based navigation between pages.

### Zustand Store (`editorStore`)

A single Zustand store manages all collaborative editing state, implementing the OT client state machine:

| Slice | State | Purpose |
|-------|-------|---------|
| **Connection** | `connected`, `ws`, `clientId` | WebSocket connection state and unique client session ID assigned by server |
| **Document** | `documentId`, `content`, `serverVersion` | Current document being edited, its text content, and the last acknowledged server version |
| **OT State Machine** | `inflightOp`, `pendingOps` | The operation sent to server awaiting ack, and operations applied locally but not yet sent |
| **Presence** | `clients` (Map<string, ClientInfo>) | Map of connected collaborators with cursor position, selection, display name, and assigned color |
| **User** | `userId` | Current user's ID (set during demo user selection) |

**OT state machine flow within the store:**

1. **Local edit:** `applyLocalChange(op)` applies the operation to content optimistically and adds it to `pendingOps`. If no operation is in-flight, `flushPending()` composes all pending ops into one and sends it to the server, moving it to `inflightOp`.

2. **Server ack:** `handleAck()` clears `inflightOp`, updates `serverVersion`, and calls `flushPending()` to send the next batch of pending operations.

3. **Remote operation:** `handleRemoteOperation()` transforms the incoming operation against `inflightOp` (if present) and then against each operation in `pendingOps`, updating both the remote op and the local ops. The transformed remote operation is then applied to content. This ensures convergence: all clients reach the same document state regardless of operation arrival order.

4. **Resync:** If the OT algorithm produces an invalid operation (baseLength mismatch), the server sends a `resync` message with the full document content and version. The client replaces its entire state, discarding inflight and pending ops.

### Client-Side OT Engine

Two service files implement the OT algorithm on the client side:

**`TextOperation.ts`** -- The core data structure representing a document change as a sequence of retain, insert, and delete components. Provides `apply(doc)` to apply the operation to a string, `toJSON()` / `fromJSON()` for serialization over WebSocket, and `isNoop()` to check if the operation makes no changes.

**`OTTransformer.ts`** -- Contains the `transform(op1, op2)` function that takes two operations created against the same document state and returns transformed versions `[op1', op2']` such that applying op1 then op2' gives the same result as applying op2 then op1'. Also contains `compose(op1, op2)` which combines two sequential operations into a single operation, used by `flushPending()` to batch multiple local edits into one network message.

### Data Fetching

**REST API (`services/api.ts`):** Used for document management operations that happen before editing starts. Provides `getDocuments()` (list all), `getDocument(id)`, `createDocument(title, ownerId)`, `updateDocumentTitle(id, title)`, `getUsers()`, and `getUser(id)`. All calls use `fetch()` against the `/api` base URL. These are only used by `DocumentList` and `UserSelector`.

**WebSocket (managed in `editorStore`):** All real-time editing communication flows through a single WebSocket connection per editing session. The connection URL includes `documentId` and `userId` as query parameters. The store's `connect()` action opens the connection and registers an `onmessage` handler that routes messages by type to specialized handler functions.

### Real-Time Update Patterns

**Message handling in the store:** Incoming WebSocket messages are routed to handler functions that update the Zustand store:

| Server Message | Handler | Store Updates |
|----------------|---------|---------------|
| `init` | `handleInit()` | Sets `clientId`, `serverVersion`, `content`, `clients` map, clears pending ops |
| `ack` | `handleAck()` | Updates `serverVersion`, clears `inflightOp`, flushes more pending |
| `operation` | `handleRemoteOperation()` | Transforms against local ops, applies to `content`, updates `serverVersion` |
| `cursor` | `handleCursor()` | Updates cursor position in `clients` map for the sending client |
| `selection` | `handleSelection()` | Updates text selection in `clients` map |
| `client_join` | `handleClientJoin()` | Adds new client to `clients` map with color and display name |
| `client_leave` | `handleClientLeave()` | Removes client from `clients` map |
| `resync` | `handleResync()` | Replaces `content`, `serverVersion`, clears all pending/inflight ops |

**Operation deduplication:** When the store receives a remote operation, it checks `message.clientId === clientId`. If the operation is from the local client (echoed back by the server), it is skipped because the local content already includes that change. Only the `serverVersion` is updated.

**Textarea synchronization:** The `TextEditor` component uses a `ref` to the textarea element and tracks the last known content in a `lastContentRef`. When the store's `content` changes (due to a remote operation), the `useEffect` updates the textarea's `value` property directly and restores the cursor position and scroll position. This avoids re-rendering the entire component on every remote keystroke.

**Diff-based operation creation:** When the user types in the textarea, the `handleInput` callback computes a diff between the old and new text values. It finds the common prefix length, the common suffix length, and builds a TextOperation from the difference (retain prefix, delete removed characters, insert new characters, retain suffix). This approach handles all edit types (single character insert, paste, backspace, cut) uniformly.

### Key UI Patterns

- **IME composition handling:** The `TextEditor` tracks whether an IME (Input Method Editor) composition is in progress via `isComposingRef`. During composition (used for CJK language input), input events are suppressed to prevent partial characters from generating operations. The operation is created only when `compositionend` fires.

- **Presence indicators:** The `UserList` sidebar shows each connected collaborator with their assigned color, display name, and cursor position. Colors are assigned server-side to ensure uniqueness and consistency across clients.

- **Optimistic local edits:** All local changes are applied to the document immediately before being sent to the server. The user never waits for a server round-trip to see their own keystrokes. If the server rejects the operation or the OT transform produces an error, a resync replaces the local state.

- **Connection status feedback:** The textarea is disabled and shows "Connecting..." as placeholder text when the WebSocket is not connected. The background color changes from white (connected) to gray (disconnected) to provide visual feedback.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation describes what the pattern is, why it exists, and how it works -- assuming no prior knowledge.

### Circuit Breaker

**What it is:** A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing dependency. It works like an electrical circuit breaker: when failures exceed a threshold, the circuit "opens" and all subsequent calls fail immediately (fast-fail) without attempting the actual operation. After a cooldown period, the circuit enters a "half-open" state where it allows one probe request through. If the probe succeeds, the circuit closes and normal operation resumes.

**Why it matters:** The collaborative editor depends on three external services: PostgreSQL (operation persistence and document loading), Redis (presence and idempotency), and RabbitMQ (cross-server operation broadcast). If PostgreSQL becomes unresponsive, every operation submission would block for 5 seconds (the default timeout), stalling the event loop. With 50 concurrent editors, the server would have 50 blocked requests, exhausting the connection pool and causing all other operations -- including WebSocket pings, cursor updates, and Redis presence -- to queue up and timeout. The circuit breaker stops this cascade by failing database calls instantly when PostgreSQL is known to be unhealthy.

**How it works here:** Three separate circuit breakers protect each dependency with tuned configurations. PostgreSQL: 5-second timeout, 50% error threshold at 5+ requests, 30-second reset. Redis: 1-second timeout, 50% at 10+ requests, 10-second reset (shorter because Redis failures are usually transient). RabbitMQ: 2-second timeout, 50% at 5+ requests, 15-second reset. When the RabbitMQ circuit opens, the server buffers publishes in memory (up to 1000 messages) and continues broadcasting locally. When the PostgreSQL circuit opens, operations fail and the server requests the client to resync.

**File:** `backend/src/shared/circuitBreaker.ts`

### Idempotency

**What it is:** Idempotency means that performing the same operation multiple times produces the same result as performing it once. In a collaborative editor, this is critical because network issues cause clients to retry operations. If a retry is processed as a new operation, the same text is inserted twice, corrupting the document for all collaborators.

**Why it matters:** Consider a user typing "hello" -- the client sends an insert operation, the server processes it and increments the version, but the acknowledgment is lost due to a network blip. The client retries the same insert. Without idempotency, the document now contains "hellohello", and all other collaborators see the duplicate. Because OT relies on version numbers for transform correctness, a duplicate operation at the wrong version can cascade into further corruption.

**How it works here:** Each operation carries a client-generated `operationId` formatted as `{clientId}-{timestamp}-{contentHash}`. Before processing an operation, the server checks Redis for this ID (key: `idemp:{operationId}`, TTL: 1 hour). If the key exists, the server returns the cached result (version number and transformed operation) without re-applying the operation to the document. If the key does not exist, the server processes the operation normally and stores the result in Redis. The 1-hour TTL is long enough for all retries to complete but short enough to avoid unbounded cache growth.

**File:** `backend/src/shared/idempotency.ts`

### Structured Logging

**What it is:** Structured logging writes log entries as machine-parseable JSON objects rather than free-form text strings. Each log entry includes standardized fields (timestamp, level, message) plus context-specific metadata (document ID, client ID, operation version, latency).

**Why it matters:** Debugging OT issues requires correlating events across multiple clients editing the same document. When a conflict resolution produces an unexpected result, you need to find all operations for that document, see their versions, examine the transform inputs and outputs, and determine which client's operation arrived first. With free-form text logs, this is a manual process of grep and mental correlation. With structured JSON logs, it is a query: `documentId=abc AND event=ot_conflict_resolved | sort by timestamp`.

**How it works here:** Pino is configured with child loggers that include `server_id`, `document_id`, and `client_id` as context fields. Key logged events: `operation_applied` (every successful operation, with latency), `ot_conflict_resolved` (concurrent operations transformed, with version gap and concurrent op count), `operation_apply_failed` (transform produced an invalid operation -- a bug indicator), `ws_connect` / `ws_disconnect` (connection stability), `document_loaded` (load time and content size), `snapshot_saved` (backup frequency tracking). `pino-http` adds request-level logging with correlation IDs for REST API calls.

**File:** `backend/src/shared/logger.ts`

### Prometheus Metrics

**What it is:** Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose metrics on an HTTP endpoint (`/metrics`) in a text format. Prometheus scrapes this endpoint periodically and stores the time-series data for visualization in dashboards and alerting when thresholds are crossed.

**Why it matters:** The collaborative editor has specific SLIs (Service Level Indicators) that require continuous measurement: operation latency (p95 < 50ms), OT transform latency (must be negligible compared to total operation time), WebSocket connection count (for capacity planning), and queue depth (for detecting RabbitMQ backpressure). Logs can answer "what happened to this one operation" but cannot answer "what is the p95 operation latency over the last hour" without expensive aggregation.

**How it works here:** The `prom-client` library exposes 8 custom metrics. `collab_ws_connections_total` (Gauge) tracks active WebSocket connections per server instance. `collab_active_documents` (Gauge) counts documents with at least one active editor. `collab_operations_total` (Counter with status label) counts operations processed, split by success/error. `collab_operation_latency_ms` (Histogram) records time from operation received to ack sent. `collab_transform_latency_ms` (Histogram) isolates the OT transform step. `collab_queue_depth` (Gauge) monitors RabbitMQ queue depth per queue. `collab_circuit_breaker_state` (Gauge) reports circuit breaker state (0=closed, 0.5=half-open, 1=open). `collab_duplicate_operations_total` (Counter) counts idempotency cache hits, indicating retry frequency.

**File:** `backend/src/shared/metrics.ts`

### Health Checks

**What it is:** Health checks are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers (to route traffic away from unhealthy instances), orchestrators like Kubernetes (to restart crashed containers), and monitoring dashboards.

**Why it matters:** The collaborative editor depends on three external services, and each can fail independently. If PostgreSQL is down, documents cannot be loaded or operations persisted, but active editing sessions can continue briefly using in-memory state. If Redis is down, presence updates and idempotency checks fail, but editing still works. If RabbitMQ is down, cross-server broadcast fails, but single-server editing works normally. Health checks enable automated systems to detect exactly what is failing and respond appropriately rather than treating all failures identically.

**How it works here:** Four endpoints serve different consumers. `/health` performs a comprehensive check of all three dependencies (PostgreSQL query latency, Redis ping, RabbitMQ channel check) and returns a JSON object with the status and latency of each. `/ready` is the Kubernetes readiness probe -- if any dependency is unhealthy, the instance is removed from the load balancer but not restarted, allowing it to continue serving active editing sessions. `/live` is the Kubernetes liveness probe -- only fails if the Node.js process itself is unresponsive. `/metrics` is the Prometheus scrape endpoint.

### Rate Limiting

**What it is:** Rate limiting restricts how many actions a client can perform within a time window. It protects the system from abuse by ensuring no single client can consume disproportionate resources.

**Why it matters:** A collaborative editor is uniquely vulnerable to operation flooding. A malicious script could open a WebSocket connection and send thousands of insert operations per second, overwhelming the OT transform engine (which has quadratic complexity with concurrent operations), filling the operations table, and triggering rapid snapshot generation. Rate limiting caps the operation rate per client to prevent this.

**How it works here:** Operations are rate-limited per client via the WebSocket connection. The server tracks operations per second per client and rejects operations that exceed the threshold. On the REST API side, standard express-rate-limit middleware protects document CRUD endpoints. The rate limits are intentionally lenient for normal editing (a fast typist produces 5-10 operations per second) but restrictive enough to prevent automated flooding.

### RBAC (Role-Based Access Control)

**What it is:** RBAC is an authorization model where permissions are assigned to roles rather than to individual users. Each user is assigned a role, and the role determines what actions they can perform.

**Why it matters:** A collaborative editor needs fine-grained access control per document. Some users should only read a document (viewers), others should be able to edit (editors), and the document owner needs to manage sharing and delete the document (admin). Without RBAC, permission checks would require per-user, per-document configuration that does not scale.

**How it works here:** The `document_access` table stores `(document_id, user_id, permission)` where permission is one of `view`, `edit`, or `admin`. The document owner automatically gets `admin` permission. Permissions are hierarchical: `admin` implies `edit`, which implies `view`. The schema is implemented and populated, but the enforcement middleware is not yet wired into the WebSocket handler -- this is noted in the "What Was Omitted" section. The design is ready for activation without schema changes.

### Redis Cache-Aside

**What it is:** Cache-aside is a caching strategy where the application checks a fast in-memory cache before querying a slower persistent store. On a cache miss, the primary store is queried and the result is stored in the cache for future requests.

**Why it matters:** In the collaborative editor, two data types benefit from caching. First, presence data (cursor positions, online status) changes rapidly and is read by all connected clients. Storing it in Redis instead of PostgreSQL avoids per-keystroke database writes. Second, idempotency keys must be checked on every operation submission. Redis provides sub-millisecond lookups compared to PostgreSQL's multi-millisecond query time. At 500,000 operations per second globally, this difference is the difference between operational and overloaded.

**How it works here:** Presence data is stored directly in Redis (not a cache of database data, but Redis as the primary store) with automatic expiration. When a client disconnects, their presence keys expire after the TTL, automatically removing stale cursor indicators. Idempotency keys use Redis as a write-through cache: the key is written on first operation processing and read on subsequent retries. Both patterns use Redis's built-in TTL for automatic cleanup without requiring garbage collection.

**File:** `backend/src/services/redis.ts`

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + React.

### Local Architecture

```
┌──────────────────────────────────┐
│    Browser (localhost:5173)      │
│  React + Zustand + Tailwind     │
│  TextOperation + OT client      │
│  WebSocket sync engine          │
└───────────────┬──────────────────┘
                │ WebSocket
                ▼
┌──────────────────────────────────┐
│  Express + ws (localhost:3001)   │
│  REST API: documents, auth      │
│  WebSocket: sync, presence      │
│  + /metrics + /health           │
└──────┬──────┬──────┬─────────────┘
       │      │      │
       ▼      ▼      ▼
┌────────┐ ┌──────┐ ┌──────────┐
│Postgres│ │Valkey│ │ RabbitMQ │
│ :5432  │ │:6379 │ │ :5672    │
└────────┘ └──────┘ │ :15672   │
                     └──────────┘

Optional monitoring (--profile monitoring):
┌────────────┐  ┌──────────┐
│ Prometheus │  │ Grafana  │
│   :9090    │  │  :3000   │
└────────────┘  └──────────┘
```

### Production-Grade Patterns Implemented

| Pattern | Library | File Path | Purpose |
|---------|---------|-----------|---------|
| OT engine | custom | `backend/src/services/TextOperation.ts`, `OTTransformer.ts` | Transform, compose, and apply text operations with convergence guarantee |
| Document state | custom | `backend/src/services/DocumentState.ts` | Server-side document state with version tracking, snapshot + op log |
| WebSocket sync | ws | `backend/src/services/SyncServer.ts` | Real-time operation relay, presence, cursor tracking, resync on error |
| Circuit breakers | opossum | `backend/src/shared/circuitBreaker.ts` | Wraps PostgreSQL, Redis, and RabbitMQ calls with fail-fast behavior |
| Idempotency | custom | `backend/src/shared/idempotency.ts` | Operation deduplication via Redis-cached operationIds (1-hour TTL) |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | WebSocket connections, operations, transform latency, queue depth at `/metrics` |
| Structured logging | pino + pino-http | `backend/src/shared/logger.ts` | JSON logs with server_id, document_id, client_id context |
| Message queue | amqplib | `backend/src/shared/queue.ts` | RabbitMQ topic exchange for cross-server operation fanout, snapshot worker queue |
| REST API | express | `backend/src/routes/api.ts` | Document CRUD, sharing, health checks |
| Multi-server | npm scripts | `package.json` | `dev:server1/2/3` runs 3 instances on ports 3001-3003 for distributed testing |
| Redis presence | redis | `backend/src/services/redis.ts` | Cursor positions, online status with automatic expiration |
| Database service | pg | `backend/src/services/database.ts` | PostgreSQL connection pool, query helpers |

### What Was Simplified

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| Load balancer with sticky sessions | Direct WebSocket connection to single server | No automatic failover between servers |
| PostgreSQL with read replicas | Single PostgreSQL 16 instance | All reads/writes on one node |
| Redis Cluster | Single Valkey instance | No sharding needed at dev scale |
| RabbitMQ cluster with federation | Single RabbitMQ instance | No multi-region fanout |
| Rich text editor (Quill/ProseMirror) | Plain text editor | No formatting attributes in OT |
| OAuth/SSO | No authentication (open access) | Any user can edit any document |
| CDN for static assets | Vite dev server | No edge caching |

### What Was Omitted

- CDN and edge caching
- Multi-region deployment with RabbitMQ federation
- Kubernetes orchestration
- Rich text formatting (bold, italic, headings)
- Inline comments with range tracking
- Offline mode with local operation queue
- Document export (PDF, DOCX)
- Full version history UI with visual diffs
- Access control enforcement (schema ready, middleware not implemented)
- OpenTelemetry distributed tracing (Jaeger)
- Automated backup and restore procedures

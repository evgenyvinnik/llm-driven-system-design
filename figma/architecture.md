# Figma architecture

## System Overview

This project studies a collaborative visual editor: low-latency local manipulation of a scene, concurrent document changes, presence, and version recovery. The first layer below is a **proposed production architecture**, not a description of Figma's current proprietary system or a claim that this repository implements its guarantees. The final Implementation Notes trace the actual Express, PostgreSQL, Valkey, and PixiJS application.

The largest implementation gaps are fundamental: ordinary browser authors do not exist in the users table, operation persistence is not transactional, there is no LWW comparison or per-file sequencer, and reconnect/undo/restore do not reconcile a shared revision. [README.md](./README.md) explains the resulting demo behavior and setup constraints.

## Requirements

### Production scope

Support files containing pages, shapes, text, and a layer hierarchy; select, move, resize, style, reorder, and delete objects; collaborate online with cursor presence; reconnect after a short interruption; undo a personal gesture; save and restore named versions. Viewer/editor permissions apply to both historical and live content. Assets, comments, components, exports, and prototyping can be later extensions.

### Production targets and invariants

| Requirement | Proposed target or guarantee |
|---|---|
| Local interaction | Aim for 60 frames/s and p95 pointer-to-pixel below 50 ms on a specified desktop benchmark |
| Shared editing | p95 committed-edit delivery below 200 ms within one region at admitted load |
| Open document | p95 first editable page below 2 s for a defined 5 MB scene, excluding optional assets |
| Availability | 99.9% regional editing availability; brief read-only failover is acceptable |
| Durability | ACK only after the operation and its retry receipt commit to replicated storage |
| Convergence | Clients applying the same committed prefix produce the same scene |
| Authorization | Revalidate current access at join, mutation, historical read, and permission change |
| Recovery | Replay after a known revision; use an explicit snapshot reset if history expired |

These are design goals, not measurements. Already delivered content cannot be recalled after revocation; prevent subsequent reads/writes and clear the application view on a downgrade.

## Capacity Estimation

Illustrative assumptions: one million daily editors, 100,000 simultaneous connections, 20,000 actively manipulating at a time, and five durable property/gesture batches per second per active editor. A typical file has 10,000 objects and a few collaborators; unusually hot files require separate limits.

| Workload | Calculation | Implication |
|---|---|---|
| Durable batches at assumed peak | 20,000 × 5 = 100,000/s | Partition by file; do not send every pointer event to storage |
| Log ingress | 100,000 × 500 B = 50 MB/s | Excludes indexes, protocol overhead, replication, and assets |
| Constant-peak daily upper envelope | 50 MB/s × 86,400 = 4.32 TB/day | Size retention using measured duty cycle, not daily users alone |
| Three peer recipients per edit | 100,000 × 3 = 300,000 deliveries/s | Gateway egress and per-file fan-out can dominate |
| Presence at 10 Hz for active manipulators | 20,000 × 10 = 200,000 updates/s | Coalesce and drop intermediate positions |
| Rewriting a 5 MB scene per batch | 100,000 × 5 MB = 500 GB/s | Full-canvas persistence on every edit is unsuitable at this scale |

### Local Development Scale

One application process, one PostgreSQL pool capped at 20 connections, and three Redis clients are used locally. The seed has three small designs containing 23 objects altogether. Extra server scripts demonstrate separate listeners, not verified distributed coordination. There are no throughput, memory, frame-rate, or latency measurements supporting production claims.

## High-Level Architecture

The gateway authenticates HTTP/socket requests and routes each file to one logical owner. The owner commits to SQL before publishing accepted edits to subscribed gateways. Presence uses a separate ephemeral topic. Snapshot workers consume the durable log, then store immutable scene versions in object storage; a CDN serves the application and appropriately authorized assets.

```
┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
│      Browser editor     │ ──▶ │  Authenticated gateway  │ ──▶ │  File owner / sequencer │
└─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘

┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
│    SQL operation log    │ ──▶ │     Snapshot worker     │ ──▶ │   Object storage / CDN  │
└─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘
```

The two rows show the interactive path and asynchronous snapshot path. The file owner writes the SQL log shown on the second row. A message broker can notify gateways of new committed sequences, but missed notifications are recovered from the log. Redis is suitable for expiring presence and routing hints; it is not the sole durable source of accepted edits.

## Core Components / Request Flows

### Open and subscribe — proposed

1. Authenticate and check the file's current read/edit capability.
2. Join the file owner, establish a stream barrier at sequence N, and buffer subsequent committed events within a bound.
3. Load a verified snapshot at S ≤ N and replay S+1 through N before presenting the canonical scene.
4. Deliver events after N in order. Discard duplicates by sequence and request a gap before applying later events.
5. Enable the client's pending-edit overlay only for this file, account, schema version, and connection generation.

A separate HTTP read racing a socket snapshot has no such boundary. The implementation does both and can replace newer state with an older response.

### Edit and commit — proposed

The tool previews a drag immediately. It produces a bounded semantic patch with a stable operation ID, file, object IDs, base revision, and intended property changes. The owner validates finite coordinates, permitted properties, current permissions, object existence, and hierarchy invariants. It resolves the patch against current committed state, then atomically reserves the next sequence and records the effective change and retry receipt.

After commit, the owner updates its in-memory projection and sends an ACK containing the canonical sequence/effective patch. Other clients receive the same event. The origin also reconciles it; ignoring all events from the same user is unsafe when two tabs or canonical conflict resolution are involved.

### Presence — proposed

Cursor updates contain a connection/session ID, page, position, selection, and expiry. Coalesce to approximately 10 Hz, refresh a lightweight heartbeat while idle, and expire each connection independently. Drop presence when overloaded. A presence failure can hide cursors while the authorized durable edit path continues.

### Snapshot and restore — proposed

Snapshots record a complete committed prefix with file ID, sequence, schema version, checksum, and durable object-store reference. Publish the snapshot manifest only after its bytes are verified. Retain enough log after it to recover and honor the advertised reconnect window.

Named versions reference immutable snapshots. Restore is a new ordered document event, never an out-of-band database replacement. Check edit/restore permission and the expected current revision; after user confirmation, assign a new document generation so clients with pending old-generation edits pause for review. This avoids silently replaying a disconnected drag over a deliberately restored design.

## Database Schema

### Existing local schema

The following is the exact consolidated [init.sql](./backend/src/db/init.sql): nine tables, 17 explicit indexes, and no triggers. It runs once on a new database. Timestamp defaults do not automatically maintain `updated_at`; current write methods set it where needed. JSONB has no object-shape, hierarchy, page-membership, or property validation constraints.

```sql
-- Figma Database Schema
-- Consolidated schema including all migrations

-- ============================================================================
-- EXTENSION
-- ============================================================================

-- Enable UUID extension for generating unique identifiers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users table: stores user accounts and authentication info
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(500),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Teams table: groups of users working together
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Team members: junction table for users belonging to teams
CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'member',
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, user_id)
);

-- Projects: folders for organizing design files
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Files: design documents containing canvas data
-- [Migration 002] Added deleted_at for soft delete support
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  thumbnail_url VARCHAR(500),
  canvas_data JSONB DEFAULT '{"objects": [], "pages": []}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP DEFAULT NULL  -- Soft delete support (Migration 002)
);

-- File versions: snapshots for version history
CREATE TABLE file_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  name VARCHAR(255),
  canvas_data JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_auto_save BOOLEAN DEFAULT TRUE,
  UNIQUE(file_id, version_number)
);

-- Comments: feedback on designs with position anchoring
CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  object_id VARCHAR(100),
  position_x FLOAT,
  position_y FLOAT,
  content TEXT NOT NULL,
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- File permissions: access control for individual files
CREATE TABLE file_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(50) DEFAULT 'view',
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_id, user_id)
);

-- Operations: CRDT operation log for real-time sync and history
-- [Migration 003] Added idempotency_key for operation deduplication
CREATE TABLE operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  operation_type VARCHAR(100) NOT NULL,
  object_id VARCHAR(100),
  property_path VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  timestamp BIGINT NOT NULL,
  client_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  idempotency_key VARCHAR(255) DEFAULT NULL  -- Deduplication key (Migration 003)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Files indexes
CREATE INDEX idx_files_owner ON files(owner_id);
CREATE INDEX idx_files_project ON files(project_id);
CREATE INDEX idx_files_team ON files(team_id);
CREATE INDEX idx_files_updated ON files(updated_at DESC);

-- Soft delete indexes (Migration 002)
-- Partial index for filtering active (non-deleted) files
CREATE INDEX idx_files_deleted ON files(deleted_at) WHERE deleted_at IS NULL;
-- Partial index for cleanup job to find expired soft-deleted files
CREATE INDEX idx_files_deleted_at ON files(deleted_at) WHERE deleted_at IS NOT NULL;

-- File versions indexes
CREATE INDEX idx_file_versions_file ON file_versions(file_id);
CREATE INDEX idx_file_versions_file_number ON file_versions(file_id, version_number DESC);
CREATE INDEX idx_file_versions_created ON file_versions(created_at);
CREATE INDEX idx_file_versions_autosave ON file_versions(is_auto_save, created_at);

-- Comments indexes
CREATE INDEX idx_comments_file ON comments(file_id);

-- Operations indexes
CREATE INDEX idx_operations_file ON operations(file_id);
CREATE INDEX idx_operations_timestamp ON operations(timestamp);
CREATE INDEX idx_operations_file_timestamp ON operations(file_id, timestamp);
CREATE INDEX idx_operations_created ON operations(created_at);

-- Idempotency indexes (Migration 003)
-- Unique constraint to prevent duplicate operations
CREATE UNIQUE INDEX idx_operations_idempotency ON operations(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Partial index for faster idempotency lookups by file
CREATE INDEX idx_operations_idempotency_lookup ON operations(file_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Seed data is in db-seed/seed.sql
```

### Production additions required

| Record | Needed fields or constraints | Reason |
|---|---|---|
| File head | Committed sequence, document generation, owner fencing epoch | Detect gaps, restores, and obsolete owners |
| Operation/receipt | Unique (file, operation ID), payload digest, sequence, effective patch, durable result | Replay accepted effects and reject ID reuse with a different payload |
| Snapshot manifest | File, sequence, generation, schema version, checksum, object-store reference | Verify a complete recovery point |
| Object state | Stable identity, parent/order, allowed fields, property revision, deletion marker | Deterministic conflict handling and conditional undo |
| Access records | Validated roles and permission revision | Enforce current sharing rules across sockets and versions |

These changes are not in the SQL above. The local `operations.timestamp` is not a committed sequence, and its `idempotency_key` column is never populated by the operation writer. Most ordinary edits also omit `oldValue`, so the table is not an authoritative inverse-operation history.

## API Design

### Current local REST contract

Responses are raw file/version objects or arrays, with snake-case database fields and JSON date strings. There is no shared Zod package, runtime response validation, or common success envelope. The duplicated frontend/backend interfaces describe compile-time expectations only.

| Method | Endpoint | Current behavior |
|---|---|---|
| GET | `/api/files` | Unpaginated active-file list including whole canvas JSON |
| POST | `/api/files` | Truthy `name` required; fixed owner; optional project/team IDs |
| GET | `/api/files/:id` | File plus process-local `activeUsers`; includes deleted files |
| PATCH | `/api/files/:id` | Rename, then read; missing file can yield JSON null |
| DELETE | `/api/files/:id` | Set deleted timestamp; 204 without checking affected rows |
| GET | `/api/files/:id/versions` | Full snapshots, `parseInt(limit) || 50`, no maximum |
| POST | `/api/files/:id/versions` | Snapshot database canvas; optional name; always non-autosave |
| POST | `/api/files/:id/versions/:versionId/restore` | Validate version belongs to file, replace canvas, add restore version |

Example request and response shape:

```http
POST /api/files
Content-Type: application/json

{"name":"Checkout sketch"}
```

```json
{"id":"file-uuid","name":"Checkout sketch","owner_id":"00000000-0000-0000-0000-000000000001","canvas_data":{"objects":[],"pages":[{"id":"page-uuid","name":"Page 1","objects":[]}]},"created_at":"2026-09-10T00:00:00.000Z","updated_at":"2026-09-10T00:00:00.000Z"}
```

The IDs above are illustrative placeholders. Actual IDs are UUIDs. Optional `X-Idempotency-Key` applies to create, rename, save version, and restore; the browser API does not send it. Missing file/version errors in version operations become 500 rather than a typed not-found/conflict response.

### Current local WebSocket contract

| Direction/type | Payload | Semantics |
|---|---|---|
| Client `subscribe` | fileId, userId, userName | Trust identity; register in memory, read file/presence, return sync |
| Client `unsubscribe` | No required payload fields | Leave current room and remove presence |
| Client `operation` | operations array | Server overrides file/user/client/timestamp; persist each item |
| Client `presence` | cursor, selection, optional viewport | Store 30-second per-user presence, broadcast locally |
| Client `sync` | Optional sinceTimestamp | Return timestamp-filtered operations and a separately read current canvas |
| Server `sync` | file, optional presence/yourColor/operations | Browser replaces its canvas; ignores returned operation history |
| Server `operation` | operations array | Batch broadcast every 50 ms to the process's subscribers, including sender |
| Server `ack` | Successful operationIds | Browser ignores it; errors are separate console-only messages |
| Server `presence` | presence and/or removed user IDs | Merge/remove collaborators in browser memory |
| Server `error` | error string | No operation-level rejection contract or UI reconciliation |

A `sync` request does not return a snapshot/sequence pair from one consistent transaction. Timestamp pagination is neither bounded nor safe across multiple process clocks. The proposed protocol adds authenticated identity, schema validation, stable IDs/digests, canonical sequence, explicit per-item outcomes, connection generation, and bounded replay.

## Key Design Decisions

### One file owner and explicit conflict semantics

For primarily online editing, choose a file sequencer backed by durable fencing and transactions. Two edits to different properties can both survive. Position is one atomic x/y property group. Two concurrent absolute position edits resolve by the server's committed order; a conditional undo is stricter and succeeds only if its target property revision still matches. Reparent/reorder changes are validated atomically and rejected if they create a cycle or refer to missing anchors.

This gives an understandable order and bounds recovery. Client wall-clock timestamps cannot safely establish that order, and simply applying arbitrary JSON patches is not a CRDT. The cost is a brief pause during owner failover and a throughput ceiling for one hot file. A mature CRDT becomes attractive if disconnected multi-writer work or simultaneous character editing becomes essential; it still needs permission, tree, deletion, and undo semantics.

As historical context, Figma's 2019 multiplayer article describes server-ordered property values and separate treatment of tree constraints. This proposal adopts its useful property-level distinction without claiming to reproduce that implementation. [Figma engineering article](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/).

### Durable log plus verified snapshots

An operation log avoids rewriting every object for a small movement and establishes one source for replay, receipts, and ordered restore. Full snapshots bound replay time and make named versions understandable. The cost is maintaining a snapshotter, manifests, retention watermarks, and a deterministic operation interpreter.

For a small single-user document, a full JSONB save can be entirely reasonable. It becomes a correctness problem here because independent read/modify/write operations race, not because JSONB itself lacks transactions. The first local repair would be an atomic serialized edit path; larger-scale log/snapshot storage follows measured need.

### GPU scene with semantic React controls

Use a retained scene renderer for high-frequency transforms while React provides the shell, layers, forms, and keyboard interaction. Update only dirty graphics; cull using conservative transformed bounds and profile both CPU and GPU time. SVG/Canvas 2D remain credible alternatives for smaller scenes. GPU rendering does not automatically fix geometry rebuilding, hit testing, or memory allocation.

PixiJS explicitly notes that culling is disabled by default and may hurt CPU-bound scenes; its performance guide also recommends avoiding constant graphics reconstruction. These optimizations must be implemented and measured, not inferred from using PixiJS. [PixiJS performance guide](https://pixijs.com/8.x/guides/concepts/performance-tips).

## Consistency and Idempotency

### Proposed durable acceptance

In one transaction, verify the active owner epoch and permission revision, locate any prior operation receipt, reject a changed payload under the same ID, and append the accepted effective patch with the next sequence. The same operation ID always returns the same committed result. A cache may accelerate receipt lookups but cannot replace the unique durable record. Persist explicit rejection receipts where retrying later must not change an already reported outcome.

The owner publishes only after commit. A crash between commit and ACK is resolved by looking up the receipt; a crash between ACK and broadcast is repaired by durable replay. An owner lease alone is insufficient: every commit checks a monotonically increasing fencing epoch so an old process cannot keep accepting writes.

### Existing behavior and consequences

- [operationService](./backend/src/services/operationService.ts) reads a file, applies the operation, inserts a log row, then writes all canvas JSON in separate statements. Concurrent calls can lose even unrelated object edits. An insert followed by a failed update leaves log and canvas inconsistent.
- The server generates process-local Lamport-style timestamps before asynchronous work. Neither server nor client compares property timestamps or client-ID ties. Completion/broadcast order can differ from timestamp order, especially across messages or processes.
- Backend create appends duplicates; frontend create suppresses an already-present ID. Arbitrary nested-property updates shallow-copy ancestors and can mutate previous state. Paths and property names are not validated.
- Logging uses a truthiness check: values such as `0`, `false`, and empty text become SQL null. Moving an object to layer zero therefore cannot be faithfully reconstructed from the row.
- [withIdempotency](./backend/src/shared/idempotency.ts) caches results for 300 seconds, but a duplicate seeing `processing` executes again. Redis errors allow execution, and the SQL idempotency column is unused. A repeated operation ID can instead cause a primary-key error without replaying its ACK. Cached duplicate operations are added to the broadcast batch again.
- The frontend supplies operation IDs but no idempotency keys, never retains unacknowledged edits, and ignores canonical own-user events. These paths provide neither exactly-once effects nor convergence.

## Security / Auth

Production requires session-derived identity and read/edit/restore authorization, including on existing sockets when roles change. Validate operation envelopes, allowed properties, finite sizes, tree relationships, batch counts, and payload limits before applying changes. Bound per-user/per-file rates and restrict historical snapshots and asset access under current permissions.

Locally there is no authentication middleware, account creation, role enforcement, sharing API, WebSocket origin check, or rate limiter. `express-session` is unused. HTTP CORS allows one configured origin with credentials; it does not protect socket upgrades or authorize file access. Parameterized SQL protects query values, but the 10 MB Express body limit does not constrain WebSocket operation arrays.

REST uses the seeded demo UUID. The browser generates a new random UUID and supplies it to the socket; no code inserts that user. Since `operations.user_id` references `users`, ordinary browser operation inserts fail on the supplied schema. The client still shows the optimistic edit. Soft delete only filters the list endpoint: direct reads, editing, versions, and socket subscriptions can continue until physical cleanup.

## Observability

Production metrics should distinguish local preview time, accepted-edit latency, peer delivery, revision gaps, replay duration, pending queue size, snapshot age, and authorization failures. Use bounded labels and exclude design text and operation bodies from ordinary logs. Delivery SLOs require client measurements or acknowledgement telemetry; a call to `send` does not establish receipt.

Locally [metrics.ts](./backend/src/shared/metrics.ts) defines 12 custom metrics plus Node defaults. Database histograms record successful query duration only. Operation histograms record successful server processing. Sync histograms surround broadcast scheduling and omit the 50 ms batch wait and remote receipt. Connection totals count subscribed sockets and refresh on `/health`; per-file metrics retain labels after files go idle. Version gauges refresh hourly when cleanup scheduling is enabled, without clearing vanished file series.

[logger.ts](./backend/src/shared/logger.ts) supplies structured Pino logs. Some operation-error logs include the full operation payload. There is no end-to-end request tracing. Exact `NODE_ENV=development` selects the undeclared `pino-pretty` transport; other values use JSON output.

## Failure Handling

| Failure | Proposed response | Actual local boundary |
|---|---|---|
| Lost ACK | Replay durable receipt using the same ID | ACK ignored; no retry queue |
| Socket disconnect | Bounded pending queue, backoff/jitter, replay | Fixed three-second reconnect and full replacement sync |
| Owner crash | Fenced takeover, snapshot plus log, resume sequence | No owner/fencing; in-memory broadcast batches lost |
| Slow recipient | Coalesce presence, bound durable queue, force resync | No buffered-byte bound or application delivery acknowledgement |
| Database failure | Stop acknowledging edits; keep pending state visible | Errors go to browser console; canvas remains optimistic |
| Redis failure | Presence degrades independently; durable receipts remain | Presence can prevent subscribe/sync; dedup fails open |
| Restore races an edit | Ordered generation change and explicit stale-edit review | REST replacement races socket writes and sends no broadcast |

Only the **sync broadcast** Opossum circuit is instantiated: 3-second timeout, 60% error threshold, volume 10, reset 5 seconds. PostgreSQL/Redis circuit configurations are unused. The broadcast action calls `ws.send` without completion callbacks, so asynchronous transport errors and slow delivery are not measured as circuit failures. A batch is cleared even if its broadcast fails.

REST routes wrap service calls in [withRetry](./backend/src/shared/retry.ts). Database options request three attempts, 100 ms initial delay, exponential backoff capped at 3 s plus up to 50 ms jitter. The loop does not break on a non-retryable error: it still executes the remaining attempts immediately. Retrying multi-statement create/restore after partial success can create duplicate effects; the wrapper alone does not make writes safe. Socket operations do not use this retry helper.

`/health` and `/health/ready` query PostgreSQL and Redis sequentially and return 503 if either fails. They use no overall deadline. The reported WebSocket state is a constant, not a collaboration probe. Startup logs failed dependency checks but may still listen if those checks return. Shutdown calls HTTP close and pool end without explicitly draining sockets, clearing all intervals/cron tasks, or closing Redis clients; it is not a verified graceful collaboration drain.

## Scalability Considerations

Partition ordinary files by file ID and distribute their owners. Keep ordering within a file; shard large files by page only after defining how cross-page moves and file-wide restore commit. Cap collaborators and operation rates before allowing a single hot file to monopolize the owner. Read-only spectators can use a separate fan-out tier consuming committed sequences.

The local bottlenecks are earlier: full-file list responses, full JSONB writes per pointer movement, full history clones, renderer reconstruction, and Redis `KEYS` for presence discovery. Fix identity and atomicity before interpreting additional process count as capacity. Redis pub/sub helpers are not wired into socket delivery, and a load balancer cannot repair concurrent writes by itself.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Edit authority | Fenced file sequencer | Uncoordinated full-scene writes | Preserve a single committed order |
| Durable storage | Operation log plus snapshots | Whole scene per pointer movement | Bound write amplification and support replay |
| Offline scope | Short reconnect queue with explicit conflicts | Unrestricted disconnected merging | Keep initial semantics explainable |
| Rendering | Retained GPU scene plus DOM controls | All objects as React DOM/SVG | Separate visual hot path from semantic controls |
| Undo | Conditional inverse gesture | Replace earlier canvas snapshot | Preserve collaborators' unrelated work |
| Presence | Expiring connection records | Durable cursor log | Intermediate positions can be dropped |
| Restore | Ordered generation change | Direct snapshot overwrite | Reconcile active and reconnecting clients |

## Implementation Notes

### Actual local topology

```
┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
│  React + Zustand + Pixi │ ──▶ │       Express + ws      │ ──▶ │   PostgreSQL + Valkey   │
└─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘
```

Vite proxies `/api` and `/ws` to one backend. React state switches between FileBrowser and Editor; there is no router or shared types package. PostgreSQL stores full canvas/version JSONB plus operation rows. Valkey stores presence and temporary idempotency results. There is no object storage, CDN, message queue, or external snapshot worker in Compose.

### Production patterns present, with their limits

The [shared modules](./backend/src/shared/index.ts) provide logging, metrics, a broadcast circuit, retries, idempotency helpers, and retention cleanup. They illustrate operational techniques, but their wiring determines the guarantees. For example, the actual Redis claim is:

```typescript
const result = await redis.set(redisKey, 'processing', 'EX', opts.ttlSeconds, 'NX');
```

This is useful as a short-lived claim only if another request seeing `processing` waits or receives a pending result. The current wrapper re-executes instead. Likewise, the active broadcast circuit call is:

```typescript
syncCircuitBreaker.fire(fileId, message, exclude).catch((error: unknown) => {
  logger.warn({ fileId, error }, 'Broadcast failed (circuit breaker may be open)');
});
```

It isolates synchronous broadcast failures, not database writes or remote delivery. Parameterized SQL and a bounded connection pool are active in [postgres.ts](./backend/src/db/postgres.ts), but its transaction helper is unused by editing/version flows. Rate limiting is omitted.

### Frontend implementation

| Area | Source | Actual behavior |
|---|---|---|
| State and history | [editorStore.ts](./frontend/src/stores/editorStore.ts) | Whole canvas array, global identity, 50 pre-edit deep clones; drag updates clone/send per object per mousemove |
| Initial load | [Editor.tsx](./frontend/src/components/Editor.tsx) | HTTP read and socket sync race; failed loads log and render existing store state |
| Socket lifecycle | [useWebSocket.ts](./frontend/src/hooks/useWebSocket.ts) | No file/generation guard, pending queue, ACK reconciliation, or stale callback cancellation |
| Graphics | [PixiRenderer.ts](./frontend/src/renderer/PixiRenderer.ts) | Map of containers, whole-object traversal, grid/selection/cursor rebuild; no viewport culling |
| Shape updates | [ShapeFactory.ts](./frontend/src/renderer/ShapeFactory.ts) | Recreate graphic/text children even for unchanged objects; removed children are not explicitly destroyed |
| Interaction | [Canvas.tsx](./frontend/src/components/Canvas.tsx) | Mouse handlers, reverse linear axis-aligned hit test, no rotation-aware test, pointer capture, or arrow-key nudges |
| Properties | [PropertiesPanel.tsx](./frontend/src/components/PropertiesPanel.tsx) | Numeric blur/Enter parsing ignores supplied min/max; text/style changes emit immediately |
| Thumbnails | [DesignThumbnail.tsx](./frontend/src/components/DesignThumbnail.tsx) | SVG fallback interprets missing visibility as visible, unlike the editor |

The seed omits `visible`, `opacity`, and `locked` on all 23 objects, and page object-membership arrays are absent. The renderer skips any falsy visibility, while thumbnails show objects unless explicitly false. Existing container child indexes can also differ from full-array indexes when invisible objects were never added. Rendering contains no hierarchy/page filtering or spatial index. Image support loads a URL into a sprite but has no upload UI or stale-load cancellation. Rotation is drawn around the center, while hit tests and selection handles remain axis-aligned. Collaborator selection rendering exists as an unused helper; only cursors and badges are displayed.

Undo stores the canvas before each edit, then decrements its index before reading. The first undo does nothing; after two edits it skips to the state before the first. Redo cannot recover the newest state because that state was never pushed. Neither action emits an operation. File changes do not clear canvas, selection, history, viewport, or collaborators. Cleanup closes a socket whose `onclose` still schedules reconnect; stale sockets/HTTP responses can subsequently write into the global store.

### Versions, presence, and retention

[fileService.ts](./backend/src/services/fileService.ts) numbers versions using an unlocked `MAX + 1`; concurrent saves can hit the unique constraint. Every wired version producer uses `is_auto_save=false`. Restore validates file/version association, writes its canvas, then creates a new named snapshot in separate statements. The UI updates only the caller. A named save reads database state and has no barrier for pending socket edits.

[presenceService.ts](./backend/src/services/presenceService.ts) uses keys `presence:fileId:userId` with 30-second TTL and publishes notifications. `subscribeToFile` and `touchPresence` are unused by the socket handler. Therefore cross-process notifications are not delivered, idle expiry is not broadcast, and multiple sockets claiming one user share/removal-conflict on a presence key. The 30-second WebSocket ping/pong heartbeat does not refresh Redis presence. Presence scans use `KEYS` followed by `MGET`.

[retention.ts](./backend/src/shared/retention.ts) schedules daily 03:00 cleanup and hourly version gauges in each process unless `ENABLE_CLEANUP=false`. Defaults: autosaves 90 days with ten newest per file retained, operation rows 30 days, soft-deleted files 30 days; named snapshots remain until file purge. No autosave producer or archive store is wired. Cleanup is not coordinated across replicas, uses separate deletion statements, and does not preserve replay/snapshot watermarks. Its top-level runner catches errors, so the manual cleanup command can exit successfully after a failure.

### Simplifications and omissions

The demo substitutes one SQL database for partitioned durable state, full JSONB copies for snapshot manifests, and a flat scene for pages/hierarchy. Identity is client-supplied or fixed, not session authentication. It omits transactional operation acceptance, persistent receipts, owner fencing, replay barriers, authoritative undo, restore events, cross-server fan-out, runtime schema validation, access enforcement, exports, comments, prototyping, object storage, workers, virtualization, and production deployment infrastructure.

The 2026-09-10 review checked source/configuration and used isolated source execution with mocked dependencies to exercise lost writes, timestamp handling, log values, duplicate creates, history indexing, idempotency, retries, and seed visibility. It did not start services, benchmark the renderer, or claim a passing end-to-end edit session. The existing smoke test checks a file grid only.

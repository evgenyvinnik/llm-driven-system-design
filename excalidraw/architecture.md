# Excalidraw Whiteboard Architecture

## System Overview

This learning project combines an infinite vector canvas with multi-user shape editing, cursor presence, drawing storage, and sharing. Its useful engineering boundaries are screen versus world coordinates, local gesture feedback versus accepted edits, and transient collaboration state versus durable recovery.

This document separates a **proposed production design** from the **actual implementation**. Requirements, estimates, the main diagram, and design decisions describe the proposal; they are not facts about the real Excalidraw service or measured results. Database Schema reproduces the local SQL, API Design inventories actual routes/messages, and the final Implementation Notes map the code and its limits. The [README](./README.md) provides setup; the three interview answers present smaller, role-focused discussions.

The local app is a single Express/WebSocket process and a React client. Its WebSocket upgrade resolves the same Express session as HTTP, joins check view access, and every edit message checks edit access. Permission changes reach sockets that are already open. HTTP saves and socket edits merge through one last-writer-wins rule, and room saves are bounded and retried. It still does not establish the convergence or durability guarantees of a complete collaborative editor: there is no operation log, acknowledgment, or replay, and rooms are process-local.

## Requirements

### Functional requirements — proposed production scope

Users create private drawings, share view/edit access, publish viewable drawings, and collaborate on rectangles, ellipses, diamonds, lines, arrows, freehand paths, and text. A viewport can pan and zoom independently of other users. The same world-space object should render, hit-test, and align with remote cursors at every supported pixel density.

Local gestures appear immediately. Accepted edits have a durable acknowledgment and a recoverable sequence position. A reconnecting client retrieves committed changes and reconciles its pending commands instead of blindly replacing the scene. Permissions apply equally to HTTP and sockets and can be revoked during a live session.

Begin with connected, regional collaboration and bounded recovery of disconnected drafts. Freehand previews and cursor movements are ephemeral; a completed stroke or gesture is a durable command. Group operations, accessible object navigation, and export can follow the same scene model. Rich concurrent text editing, unrestricted offline branching, image import, and multi-region active writers are separate extensions.

### Non-functional requirements — proposed, unmeasured targets

| Concern | Initial target / invariant | Boundary |
|---------|----------------------------|----------|
| Local feedback | Fit gesture rendering within a 16.7 ms frame budget on a defined reference device | Profile actual scene/point complexity |
| Collaboration | p95 below 150 ms for regional peer preview delivery | Ephemeral previews may be coalesced or dropped |
| Durable acceptance | p95 below 250 ms for ordinary regional edit acknowledgment | Acknowledge only after configured durable commit |
| Availability | 99.9% monthly for regional drawing APIs | Local drafts may continue during server unavailability |
| Recovery | No acknowledged command lost on a room-process crash | Durable operation log and snapshot boundary |
| Consistency | All connected clients apply the same accepted command order | Single fenced authority per drawing |
| Access | Current drawing permission required for reads/edits; revoked sessions stop editing | Check at join and mutation; propagate revocation |
| Scale envelope | Initially evaluate 1,000 ordinary elements and up to 20 participants per drawing | Larger drawings require measured limits, not universal FPS claims |

A saved status describes a committed sequence, not whether another browser happened to receive a broadcast. Database replication, backup/restore, and regional disaster recovery need explicit deployment policies; “99.99% durability” without a failure model is not a useful specification.

## Capacity Estimation

Exercise assumptions, independent of the small local fixtures:

| Assumption | Consequence |
|------------|-------------|
| 5,000 active drawings, four connected participants each | 20,000 sockets; distribute rooms across servers |
| 10% of connected users commit two completed gestures/second | 4,000 durable commands/s across the fleet |
| 500 bytes per average command | About 2 MB/s or 172.8 GB/day if sustained, before indexes/replicas |
| 25% of users move cursors, throttled to 10 Hz | 50,000 inbound presence messages/s |
| Three peers receive each 200-byte presence message | About 30 MB/s payload egress, excluding protocol overhead |
| 1,000 elements × 500 bytes per active drawing | About 0.5 MB serialized per scene, 2.5 GB across 5,000 active scenes before runtime overhead |

A completed stroke is not sixty durable operations merely because pointer events arrive at sixty Hz. Sampled previews and the final persisted command have different cost models. Long strokes still require point/byte limits, chunked transport if needed, and a bounded finalization protocol.

A single hot room has fan-out proportional to its participants and edit/presence rates; spreading other rooms across more machines does not remove that bottleneck. Snapshot size, stroke complexity, and slow clients can dominate before socket count does.

### Local Development Scale

The fixture has two users, four drawings, 36 total elements, and two edit grants. Compose starts PostgreSQL 16 and Valkey 7 with append-only Redis persistence. There is no message broker, load balancer, object store, or replica topology. The API runs on port 3001 via the development script. The alternate instance scripts also resolve to 3001 because they invoke that same script.

## High-Level Architecture

Production proposal; these are responsibilities rather than a requirement to deploy one service per box.

```
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Browser collaborators  │       │ Access API / WS edge   │       │ Presence distribution  │
│ Saved command identity │◀─────▶│ Auth / route / join    │◀─────▶│ Expiring observations  │
└────────────────────────┘       │ Connection lifecycle   │       │ No durable edit status │
                                 └────────────────────────┘       └────────────────────────┘
                                              ▲
                                              │
                 command / durable outcome    │
                                              │
                                              ▼
                                 ┌────────────────────────┐       ┌────────────────────────┐
                                 │ Fenced drawing owner   │       │ PostgreSQL authority   │
                                 │ Serialize group edits  │◀─────▶│ Scene / accepted log   │
                                 │ Commit before ACK      │       │ Receipt, access, epoch │
                                 └────────────────────────┘       └────────────────────────┘
                                              ▲                                ▲
                                              │                                │
                         events / replay      │           snapshot + suffix    │
                                              │                                │
                                              ▼                                ▼
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Peer collaborators     │       │ Accepted event stream  │       │ Snapshot workers       │
│ Canonical scene events │◀─────▶│ Retained log / replay  │       │ Exact covered sequence │
│ Replay missing events  │       │ Bounded subscriber IO  │       │ Verified recovery base │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘

One accepted order per drawing; geometry, style and text have explicit conflict boundaries.
```

The proposed overview exposes the acceptance and recovery loop:

1. Browsers retain bounded commands with original identity, expected revisions, and account/drawing scope; accepted status still requires a server receipt.
2. The fenced owner commits the canonical effect, receipt, and sequence together. Both the author and peers can recover that accepted order.
3. Replay requests return through the owner to durable history; presence uses an independent disposable channel.
4. A replacement owner restores a verified snapshot and committed suffix under a new epoch before admitting commands.
5. Snapshot publication identifies the exact covered sequence. Log retirement, stale-draft handling, and tombstone compaction must preserve the stated recovery window.

One authority serializes accepted changes for each drawing. Durable storage checks the current owner epoch so a former owner cannot continue committing after failover. Metadata and access changes that affect editing pass through a compatible ordering/version protocol; a separate HTTP full-scene replacement must not race the room writer.

Fan-out carries committed changes to all participants, including the author, and carries separately labeled ephemeral previews. A delivery bus may lose a notification without losing a committed operation because clients can resume from the durable sequence. Client-IP affinity alone does not put all collaborators of a drawing on one owner or prevent competing writers.

## Core Components / Request Flows

### Rendering and local interaction — production proposal

Store shared shape coordinates in world space. Let each user own their viewport and selection. Convert pointer positions from client coordinates to canvas-relative CSS pixels and then through the inverse viewport transform. Multiply the final world-to-screen transform by device pixel ratio exactly once when rendering the backing bitmap.

Use a consistent transform for shapes, hit tests, selection bounds, and DOM cursor/text overlays. Normalize negative geometry or use sign-aware bounds. Hit testing starts with a reverse stacking-order scan; spatial indexing becomes useful when measured scene complexity makes the scan expensive.

A gesture owns a temporary draft layer. Pointer capture ensures release/cancel is handled outside the canvas; pointer events support mouse, touch, and pen. Draw draft strokes during the gesture, coalesce redraws with animation frames, and simplify the final stroke with a screen-space error budget converted to world units. Do not increment document revisions for every local pointer sample.

The proposed client keeps committed scene state, a bounded pending-command queue, and local gesture/viewport state separately. Remote accepted messages update committed state without inventing new local revisions. Pending overlays are reapplied or marked conflicted; an authoritative snapshot is not permission to discard unsent work.

### Command acceptance and conflicts — production proposal

1. Authenticate the socket and authorize drawing access before sending scene data. Bind actor/session identity on the server; the message cannot choose another user.
2. A mutation carries a stable operation ID, drawing identity/generation, target element, expected property-group revision, and a bounded payload. Geometry is one group; style and text have separate groups so a move and recolor need not conflict.
3. The room authority validates current permissions and lifecycle, serializes the command, and checks the expected group revision. A conflicting edit receives current canonical state rather than silently overwriting a newer change. The client can explicitly reapply its intent as a new command.
4. Commit the operation receipt, next drawing sequence, and state/log effect under the current owner epoch. An identical retry returns the existing receipt; conflicting reuse of an ID is rejected.
5. Return the canonical accepted change and sequence to the author and peers. Clients detect gaps, fetch missing changes, and render the same stacking order, represented explicitly rather than inferred from map insertion order.

This proposal uses a server-ordered command model rather than claiming that arbitrary client clocks form a convergent CRDT. A tested CRDT library becomes a reasonable alternative if unrestricted offline merging or concurrent text requires it. Neither approach removes authorization, persistence, or payload-validation work.

Deletion is a durable lifecycle transition. Delayed updates cannot recreate a deleted element, and an intentional restore is a separate authorized command. Reusing the same ID for a new object must not reinterpret an old pending update as an edit to that object.

### Join, resume, snapshots, and saving — production proposal

A join establishes a consistent snapshot at sequence N and a path to changes N+1 onward. Subscribe/buffer or use a durable cursor so operations committed during snapshot transfer are not lost. Replay reaches a declared high-water mark before the client is considered caught up. Every message is associated with its drawing and connection generation; old-room responses are discarded after navigation.

The client records pending durable commands locally before treating them as recoverable drafts. It removes them only after a durable receipt. On reconnect, it resends the same IDs, loads missing accepted state, and revalidates stale drafts. If the history cursor is older than retention, the server supplies a fresh snapshot and explicit rebase rules; it does not accept arbitrary old snapshots as replacements.

Snapshots store a complete scene and its covered log sequence. Publish a snapshot pointer only after the snapshot is durable and verified. Retain the necessary log tail until recovery is possible from the new boundary. Tombstone compaction requires rejecting commands from unsupported old history/generations; an elapsed 24-hour timer alone does not prove that no stale client exists.

The local implementation instead replaces scene arrays through HTTP and keeps independent process-local room arrays. A two-second inactivity timer writes the full room array, with no log, sequence, receipt, retry queue, or coordinated snapshot boundary.

## Database Schema

### Current local initialization SQL

The following exactly reproduces [backend/src/db/init.sql](./backend/src/db/init.sql). It is the implemented baseline, not the proposed command-log schema.

```sql
-- Excalidraw Collaborative Whiteboard Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    avatar_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drawings table
CREATE TABLE IF NOT EXISTS drawings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL DEFAULT 'Untitled',
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elements JSONB DEFAULT '[]'::jsonb,
    app_state JSONB DEFAULT '{}'::jsonb,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drawing collaborators
CREATE TABLE IF NOT EXISTS drawing_collaborators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(10) NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(drawing_id, user_id)
);

-- Drawing versions (snapshots for undo/history)
CREATE TABLE IF NOT EXISTS drawing_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    elements JSONB NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Operations log (for CRDT merge and conflict resolution)
CREATE TABLE IF NOT EXISTS operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_type VARCHAR(10) NOT NULL CHECK (operation_type IN ('add', 'update', 'delete', 'move')),
    element_id VARCHAR(255) NOT NULL,
    element_data JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_drawings_owner_id ON drawings(owner_id);
CREATE INDEX IF NOT EXISTS idx_drawings_is_public ON drawings(is_public);
CREATE INDEX IF NOT EXISTS idx_drawing_collaborators_drawing_id ON drawing_collaborators(drawing_id);
CREATE INDEX IF NOT EXISTS idx_drawing_collaborators_user_id ON drawing_collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_drawing_versions_drawing_id ON drawing_versions(drawing_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_operations_drawing_id ON operations(drawing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operations_element_id ON operations(drawing_id, element_id);
```

There are five tables. `operations` is not written by application code. `drawing_versions` is written only by the explicit HTTP update path when elements are supplied, not by WebSocket auto-save. It has no uniqueness constraint on drawing/version. `MAX(version_number) + 1` in concurrent transactions can allocate the same number, so pruning by version number does not guarantee exactly fifty retained rows.

Elements and app state are JSONB with no database shape/schema validation; they can contain malformed or non-array data. There is no drawing revision, command receipt, owner epoch, accepted sequence, or stable stacking-order field. Timestamp defaults are not automatic update triggers. Foreign keys cascade drawings, grants, history, and operations when their referenced parent is deleted.

### Production additions — proposed, not migrated

| Record | Main contents and invariant |
|--------|-----------------------------|
| Drawing authority | Drawing generation, current owner epoch, latest committed sequence; reject stale owners |
| Element state | ID, lifecycle, explicit stacking order, validated geometry/style/text and group revisions |
| Command / receipt | Unique drawing + actor + operation ID, payload digest, accepted sequence or rejection result |
| Snapshot | Drawing generation, covered sequence, format version, checksum/location, publication status |
| Access revision | Current grant/publication state and revocation revision, checked across transports |
| Presence session | Drawing + connection identity, cursor/selection and last-seen expiry; ephemeral |

Use PostgreSQL transactions for metadata and durable command acceptance initially. Snapshot blobs can remain in SQL at small scale and move to object storage if their size and retention justify it. A normalized element table can retrieve a scene with one range query; it does not require one join per shape. JSONB remains useful inside a row for heterogeneous shape payloads, but changing a JSON field does not remove PostgreSQL row-version/storage write costs.

## API Design

### Implemented HTTP routes

| Method | Path | Actual behavior / boundary |
|--------|------|---------------------------|
| POST | `/api/v1/auth/register` | Username/email/password, bcrypt cost 12, creates Redis-backed session |
| POST | `/api/v1/auth/login` | `username` field accepts username or email, plus password |
| POST / GET | `/api/v1/auth/logout`, `/api/v1/auth/me` | Destroy session / fetch current user |
| GET | `/api/v1/drawings` | All owned/shared drawings; no pagination; reads full scenes to derive counts |
| GET | `/api/v1/drawings/public` | Latest twenty public drawings; no cursor/offset contract |
| POST | `/api/v1/drawings` | Create with title, elements, appState, isPublic; no operation receipt |
| GET | `/api/v1/drawings/:drawingId` | Scene and collaborators; public or authorized HTTP read |
| PUT | `/api/v1/drawings/:drawingId` | Owner/edit collaborator can replace elements and change metadata/publicity |
| DELETE | `/api/v1/drawings/:drawingId` | Owner-only SQL delete; no room eviction protocol |
| POST | `/api/v1/drawings/:drawingId/collaborators` | Owner-only add/update by username; helper's first SQL statement is invalid |
| DELETE | `/api/v1/drawings/:drawingId/collaborators/:targetUserId` | Owner-only removal; no socket revocation |
| GET | `/api/v1/drawings/:drawingId/collaborators` | Requires login but does not check access to the drawing |
| GET | `/api/v1/export/:drawingId/png`, `/api/v1/export/:drawingId/svg` | Authenticated requests receive 501 placeholders |
| GET | `/api/health`, `/api/health/live` | Basic process responses after session/general-rate middleware |
| GET | `/api/health/detailed`, `/api/health/ready` | PostgreSQL/Redis probes; detailed includes process memory |
| GET | `/metrics` | Prometheus text after session middleware |

HTTP JSON bodies have a 10 MB parser limit. `PUT /drawings/:id` checks that `elements` is an array of well-formed elements (known type, string ID up to 64 characters, finite `version` and `updatedAt`, boolean `isDeleted`). Coordinates, style ranges and point counts are not validated. The elements are **merged** per element with the same last-writer-wins rule as the live room, never written over the stored array (see Implementation Notes). Collaborator permissions other than `view`/`edit` are a 400.

Adding a collaborator returns `{userId, username, displayName, permission}` and re-checks every open socket on that drawing. (The helper previously began with `INSERT … ON CONFLICT … RETURNING … FROM … JOIN`, which is not valid [PostgreSQL INSERT syntax](https://www.postgresql.org/docs/16/sql-insert.html). The error was caught and turned into `null`, so every share answered 201 with a null collaborator and the share dialog crashed on it.) Listing collaborators requires view access to the drawing.

### Implemented WebSocket messages

The `/ws` upgrade runs through the Express session middleware ([handler.ts](./backend/src/websocket/handler.ts)), so each connection's identity is the session user, or anonymous with none. Messages from one connection are processed strictly in order, so an edit sent right after `join-room` cannot overtake the join's access check. CORS and rate limits do not apply to the socket.

| Direction | Message | Actual contents / handling |
|-----------|---------|----------------------------|
| Client → server | `join-room` | Drawing ID only (any `userId`/`username` is ignored). Requires view access; anonymous sockets may join public drawings only |
| Client → server | `leave-room` | Leave the current room; the last one out triggers the final save |
| Client → server | `shape-add`, `shape-update`, `shape-move` | Full element payload, validated; requires edit access |
| Client → server | `shape-delete` | Element ID; requires edit access; server increments the version and timestamps deletion |
| Client → server | `elements-sync` | Whole element array (up to 10,000), validated and merged; requires edit access |
| Client → server | `cursor-move` | Finite world x/y; signed-in participants only; raw mouse-move frequency, no throttle |
| Server → client | `connected` | Per-connection `clientId`, palette color, `authenticated` flag |
| Server → client | `room-state` | Drawing ID, complete room array, this connection's `canEdit`, and the other participants |
| Server → peers | Shape messages / `elements-sync` | Sender's `clientId` plus the payload (merged array for bulk sync); never echoed to the sender |
| Server → peers | `cursor-move`, `user-joined`, `user-left` | Keyed by `clientId`, so two tabs of one account are two participants |
| Server → client | `permission-changed`, `access-revoked` | Pushed when sharing, visibility, or deletion changes this connection's rights |
| Server → client | `error` | `forbidden` (join refused), `read-only` (edit refused), malformed input |

There is no accepted-operation ID, durable acknowledgment, drawing sequence, heartbeat, or replay cursor. The socket's `maxPayload` is 2 MB; there is no per-room membership, message-rate, or slow-client buffer limit.

## Key Design Decisions

### One ordered drawing authority over ad hoc client-clock merges

The proposed command model assigns a durable order within each drawing and sends the canonical result to every participant. Geometry/style/text groups allow independent changes to coexist while an expected group revision makes an actual conflict explicit. It has a small enough model to test against concrete user intent: a recolor should not undo a simultaneous move.

Whole-element LWW is a legitimate possible design if all replicas share a deterministic total order and compatible merge semantics. It still discards concurrent edits at that granularity. The local implementation has neither a total tie-break for equal version/timestamps nor one shared operation rule. Calling it a CRDT does not prove convergence.

A tested CRDT library can support decentralized merging and richer offline/text semantics, but adds state/compaction and integration choices. It does not inherently require keeping every tombstone forever or solve every kind of user-intent conflict. The ordered proposal gives up unrestricted offline acceptance and depends on a regional authority; local feedback remains immediate through drafts.

### Durable completed commands plus snapshots over idle-only saves

Persist a completed gesture command, optionally group-committing short bounded batches, before acknowledging it as saved. Periodic snapshots shorten replay. Cursor and preview traffic stays ephemeral, so high pointer sample frequency does not become one durable write per sample.

An idle debounce reduces writes but cannot bound data loss while edits keep arriving. An in-memory broadcast also disappears on process failure. The cost of a durable log is receipt storage, replay, snapshot publication, and backpressure. The benefit is a precise saved boundary and a recoverable operation after a lost response.

Snapshots and log retention are coordinated. A replay log alone does not automatically supply user-friendly undo; undo requires conditional inverse commands that respect intervening edits. A full-scene REST save must use the same authoritative revision protocol instead of becoming an independent writer.

### Canvas 2D with explicit transforms over universal rendering thresholds

Canvas 2D provides a direct renderer for the small vocabulary of shapes. A draft layer and animation-frame invalidation can keep interaction responsive while React manages controls. Its cost is manual hit testing, selection, text editing, and accessible object navigation.

SVG offers per-object DOM semantics and useful event/accessibility integration; WebGL can improve throughput for suitable workloads. There is no universal “SVG fails at 1,000 shapes” boundary. Choose after measuring scene complexity, text, point counts, device resolution, and interaction patterns. Viewport culling and spatial indexing often help before changing the renderer.

## Consistency and Idempotency

The production receipt binds drawing generation, authenticated actor, stable operation ID, and payload digest. The same retry returns the same accepted sequence/result; changing the payload under the same ID is rejected. All durable mutation paths follow the same owner epoch and revision checks. A late owner, HTTP writer, or snapshot job cannot overwrite a newer committed state.

Clients maintain committed state at a known sequence and pending commands separately. Missing sequences trigger catch-up; reconnect does not infer successful delivery from a previous `send()` call. Ephemeral previews and cursor messages can be superseded without replay. A newly joined room receives a snapshot and contiguous tail, including edits committed during loading.

### Actual merge behavior

| Code path | Actual rule | Consequence |
|-----------|-------------|-------------|
| `mergeElements` | Higher version wins, then higher timestamp; exact ties keep existing | Equal clock/version conflicts depend on input order; array order also depends on insertion order |
| Add, Update | Same rule as merge: higher version, then later timestamp | A replayed add cannot resurrect a tombstone; an equal-version older edit loses |
| Delete | Mark current object deleted and increment version using server time | Replaying the same delete increments again |
| Move | Change x/y regardless of stale version; take max version and server time | Old positions can replace new positions without consistent ordering |
| Browser remote add/update | `applyRemoteElement`: same last-writer-wins rule, keeps the sender's version | Browsers and server hold the same version/time metadata for accepted edits |

These rules are in [crdtService.ts](./backend/src/services/crdtService.ts), [the room handler](./backend/src/websocket/handler.ts), [canvasStore.ts](./frontend/src/stores/canvasStore.ts), and [the drawing route](./frontend/src/routes/draw.$drawingId.tsx). Individual broadcasts send original payloads even if server merge rejected or transformed them; the sender gets no canonical correction. Messages are filtered by connection, not user, so two tabs of one account see each other's edits. There is no end-to-end exactly-once or convergence guarantee.

## Security / Auth

In production, authenticate upgrades with the same session authority used by HTTP, validate origins, authorize scene access before join, and bind a server identity to each connection. Check edit permission on mutations and propagate revocation. Bound operation types, payloads, point counts, message frequency, participants, and queued output bytes. A read-only public drawing must remain read-only through every transport.

Locally, HTTP auth uses bcryptjs (cost 12 for new accounts) and Redis-backed `express-session`. Cookies last seven days, are HttpOnly/SameSite Lax, and are Secure in production. Registration lowercases username/email and enforces username length and a six-character minimum password; it does not regenerate the session on login/register. `SESSION_SECRET` signs cookies; session data lives in Redis. The installed connect-redis adapter supports the supplied ioredis client.

[HTTP drawing routes](./backend/src/routes/drawings.ts) check ownership/edit access for changes and owner access for delete/grant management; listing collaborators requires view access. The WebSocket enforces the same rules per connection, and sharing, unsharing, visibility changes and deletion re-check open sockets immediately (`refreshRoomAccess` / `closeRoom` in [rooms.ts](./backend/src/websocket/rooms.ts)). Origins are not validated on upgrade. Drawing GET uses cached `is_public` to decide whether private access checks are necessary, so stale cache state can also affect read authorization. Edit collaborators can change publicity through the generic PUT. The UI has no public/private toggle despite holding `isPublic` state.

[WebSocket setup](./backend/src/index.ts) passes every connection to an anonymous client record, and [join-room](./backend/src/websocket/handler.ts) trusts message identity and drawing ID. There is no session parsing, drawing access check, edit check, origin gate, logout revocation, or deleted-room closure. A socket can read and mutate a known private drawing independently of HTTP credentials.

## Observability

The production system should report local frame time, command-to-ack latency, committed sequence lag, pending draft age, replay gaps, conflicting edits, unauthorized attempts, snapshot age, and slow-client disconnections. Count a command as durable only after storage commit. Correlate drawing/operation IDs through acceptance, snapshotting, and recovery without logging private scene contents or credentials.

Locally, [metrics.ts](./backend/src/services/metrics.ts) wires HTTP latency/counts, socket connection/message counts, drawing create/delete counters, auth attempts, rate-limit hits, and an active-session gauge. The gauge counts login/register/logout calls rather than actual live sessions and can drift or go negative. Socket message labels accept arbitrary supplied message types; unmatched HTTP path labels can also grow cardinality. There are no merge-conflict, replay, or durable-save metrics.

[Pino logging](./backend/src/services/logger.ts) records HTTP trace IDs, status/duration/user information, and selected room/save events. A caller-supplied `x-trace-id` is accepted or generated and returned, but it is not automatically propagated into all database or WebSocket work. Query timing/logging helpers and the database histogram exist without being used around normal queries.

Health and readiness check PostgreSQL/Redis, not valid collaboration, permission enforcement, or saved scene state. Basic health routes run behind sessions and the general API limiter. No dashboard stack or distributed tracing collector is configured.

## Failure Handling

| Failure | Proposed behavior | Current local behavior |
|---------|-------------------|------------------------|
| Response/ack lost | Resend stable operation ID and retrieve receipt | No operation acknowledgment or receipt |
| Disconnection | Preserve pending commands; catch up and reconcile | Sends while closed are dropped; room-state replaces local elements |
| Database unavailable | Stop durable acknowledgments, bound pending work | In-memory edits continue; a failed save keeps the room dirty and retries every 5 s |
| Redis unavailable | Explicit session/access failure; optional caches can fail open where safe | Cache helpers throw; sessions/rate limiting can fail HTTP requests |
| Room owner crashes | New fenced owner replays log after snapshot | First join reloads last SQL/cache state; unsaved room memory is lost |
| Last client leaves | Persist or retain retryable state before release | Room stays in memory until its final save commits; a join in that window reuses it |
| Planned shutdown | Stop admissions, drain/ack work, persist, close sockets and dependencies | Stops the HTTP server, saves every dirty room, then closes PostgreSQL/Redis (idempotent on repeated signals) |
| Join races editing | Snapshot and tail have a defined sequence boundary | Room loads run under the per-drawing write lock; the client keeps room-state over a later REST response |
| Permission revoked | Prevent future mutations and remove/restrict connections | Open sockets are downgraded or removed when sharing or visibility changes |

[The Opossum helper](./backend/src/services/circuitBreaker.ts) configures a 10-second timeout, 50% failure threshold after five requests, a 10-second statistics window, and 30-second reset. It is **unused by the running database path**. There is no database circuit breaker or Redis-to-memory limiter fallback; the only retry is the room save's. PostgreSQL uses a 20-connection pool, 30-second idle timeout, and two-second connection-acquisition timeout; ordinary queries have no explicit execution deadline.

## Scalability Considerations

Route a drawing's durable commands to one fenced owner and distribute different drawings across owners. A failover must invalidate the old owner's ability to write. Redis Pub/Sub can carry notifications, but adding it alone leaves competing full-scene writers and missed-message recovery unresolved. Avoid assuming that one user's sticky connection routes all peers to the same process.

Bound presence frequency and output queues, coalescing the latest cursor/preview state and disconnecting clients that cannot keep up with durable changes. Separate presence by connection identity so two tabs do not erase one another. Per-connection last-seen expiry is different from one TTL for an entire room hash.

Create snapshots based on size/operation thresholds and elapsed time, without relying on inactivity. Paginate drawing lists and retrieve summaries without loading whole scenes. For large scenes, maintain spatial indexes for viewport queries and hit testing, cache static layers, and move expensive bounded work to workers when measurements justify it. A renderer change does not repair an unbounded network payload or inconsistent merge protocol.

Global collaboration adds latency and authority placement choices. Start with a regional owner per drawing; move ownership through a fenced handoff. If fully decentralized offline editing becomes a requirement, revisit the data type and merge semantics rather than layering client clocks onto an ordered design without a proof.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Edit authority | Ordered, fenced room writer | Ad hoc client-clock whole-object merge | Canonical acceptance, explicit conflict handling and recoverable order |
| Mutation granularity | Geometry/style/text groups | Replace entire element for every edit | Preserve independent intents without splitting geometry invariants |
| Durability | Completed-command log plus snapshots | Idle-only full-state save | Bound acknowledged recovery independently of user inactivity |
| Presence | Throttled ephemeral per-connection state | Durable cursor log | Latest position matters; old movement is disposable |
| Rendering | Canvas 2D with draft layer and measured optimization | Immediate SVG/WebGL migration | Keep model simple while profiling actual complexity |
| Reconnect | Sequence catch-up and stable pending IDs | Replace local scene on every join | Preserve recoverable drafts and detect missing accepted changes |

## Implementation Notes

### Actual topology and persistence

[app.ts](./backend/src/app.ts) mounts HTTP routes and sessions; [index.ts](./backend/src/index.ts) attaches `/ws` to the same server. [handler.ts](./backend/src/websocket/handler.ts) authenticates upgrades and dispatches messages; [rooms.ts](./backend/src/websocket/rooms.ts) holds rooms, element arrays and timers in process-local maps and owns persistence. Redis is used for HTTP and WebSocket sessions, rate counters, a full-drawing cache, and cursor writes; it is not used for room fan-out or durable operations.

**Room saves.** Each edit restarts a two-second quiet-period timer, capped at ten seconds after the first unsaved edit, so continuous drawing no longer postpones the save indefinitely. Every write for a drawing (room flushes, HTTP saves, room loads) runs through one per-drawing promise chain (`withDrawingLock`). An older snapshot therefore cannot land after a newer one, and a load never reads a half-written row. The snapshot is the element array at the moment the save starts. Arrays are replaced, never mutated, so later edits mark the room dirty again rather than changing what is being written. A failed save keeps the room dirty and retries after five seconds. When the last client leaves, the room stays in memory until its final save commits; a join in that window reuses the newer in-memory state instead of reloading the row. Graceful shutdown stops the HTTP server and saves every dirty room before closing the pool.

**One merge authority.** HTTP Save no longer replaces the array. With the drawing open, the incoming elements are merged into the room (`mergeElements`, last-writer-wins per element), every participant (including the saver) receives the merged list as `elements-sync`, and the room saves it. With nobody connected, the stored array is merged under the drawing lock. The browser now sends tombstones too, so a save from a stale tab cannot overwrite newer socket edits or resurrect deleted shapes. Version snapshots record the merged scene. Title, visibility and app state are still plain column updates.

`saveVersion` is launched asynchronously only after an HTTP PUT containing elements succeeds, with the merged scene. Its separate transaction selects max version plus one, inserts the submitted scene, and deletes versions at least fifty numbers behind the new maximum. Concurrent numbers can collide and the saved snapshot need not correspond to a unique live-scene revision. No route reads/restores those versions; `operations` remains unused.

### Wired patterns and helper boundaries

**Caching.** `getDrawing` caches the entire drawing row, including elements, owner fields, and publicity, at `drawing:<id>` for 300 seconds. Lists and collaborator permissions are queried separately. Cache get/set/delete errors are not swallowed: a cache failure can fail a read, or return failure after an SQL update/delete already committed. Invalidation can also race an older read filling the cache. There is no stampede control or revision fence.

**Rate limiting.** [rateLimiter.ts](./backend/src/services/rateLimiter.ts) uses express-rate-limit with rate-limit-redis: general `/api/` traffic is 1,000/minute, login allows five failed attempts/minute with successful attempts removed, and drawing creation is thirty/hour. Other drawing writes only receive the general limit. Keys use session user ID or normalized IP. The installed Redis store uses expiring fixed-window counters, not a sliding event log; there is no WebSocket limiter.

**Presence.** [presenceService.ts](./backend/src/services/presenceService.ts) performs the following pattern for each cursor update:

```text
HSET presence:cursors:<drawingId> <clientId> <cursor JSON>
EXPIRE presence:cursors:<drawingId> 30
```

The expiry belongs to the whole hash, so one moving user keeps every field alive. It does not expire an idle user's cursor independently. `getCursors` is never called by the join path; Redis data does not initialize late joiners. Browser cursors have no timestamp expiry either and disappear only on explicit leave notifications. See [Redis EXPIRE semantics](https://redis.io/docs/latest/commands/expire/). Presence is keyed by connection, so two tabs of one account are two cursors and cannot remove each other's.

**Metrics/logs.** HTTP and WebSocket counters and Pino request logging are wired. Circuit-breaker, query-timing, and cache-log helpers are not automatically connected merely because they are exported. The Observability and Failure Handling sections distinguish actual wiring from the proposed instrumentation.

### Browser state, rendering, and interaction

The [canvas store](./frontend/src/stores/canvasStore.ts) is in memory; [auth state](./frontend/src/stores/authStore.ts) persists user/auth flags under `excalidraw-auth-storage` and [main.tsx](./frontend/src/main.tsx) validates the session on mount. The drawing route starts requests/sockets from the current user object before that check necessarily finishes. All canvas subscribers read the whole store, so cursor updates still rerender React subscribers even though the canvas drawing effect does not depend on cursors.

[Canvas.tsx](./frontend/src/components/Canvas.tsx) redraws through a React effect on elements, viewport, selection, and size. There is no animation-frame loop, viewport culling, dirty-rectangle rendering, offscreen layer, or error isolation per element. The backing bitmap is the CSS size times `devicePixelRatio`, and [CanvasRenderer.ts](./frontend/src/renderer/CanvasRenderer.ts) folds that ratio into the world transform:

```typescript
ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * scrollX, dpr * scrollY);
```

[`setTransform`](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/setTransform) *replaces* the current matrix. The earlier code first set a fixed 2× retina scale and then replaced it with the bare viewport transform, so every shape and selection box was drawn at half its CSS size and position. Hit tests and cursor overlays used full-size coordinates, so a click landed beside the shape it was aimed at. The grid is drawn in screen space and its spacing scales with zoom.

The renderer supports the seven shapes, smoothed freehand lines, multiline text, and decorative selection handles. Hit testing is a reverse linear scan. New boxes are stored with positive width and height whichever way they were dragged, and freehand strokes are re-anchored so the element's origin is their bounding-box corner. That removes the negative-size and missing-offset hit-test errors for shapes drawn in this client (elements from older data or other clients may still carry them). Path simplification uses a fixed two-world-unit tolerance and distance to an infinite line, so collinear backtracking excursions can disappear; no zoom-aware error guarantee is provided.

[Canvas input](./frontend/src/components/Canvas.tsx) draws the shape under construction live and commits/sends it on mouseup. Dragging updates locally on movement and, if the shape actually moved, sends its current state at mouseup. With view-only access, any drag pans, and the toolbar, properties panel and Save button are hidden. There is no pointer capture, pointer cancel, touch support, resize handling, Shift constraints, snapping, or existing-text editor. [PropertiesPanel.tsx](./frontend/src/components/PropertiesPanel.tsx) shows the selected element's style (or the defaults when nothing is selected) and sends each change as a `shape-update`.

[websocket.ts](./frontend/src/services/websocket.ts) drops sends unless open, reconnects after 1/2/4/8/16 seconds without jitter, and rejoins without replaying pending operations. `room-state` replaces local elements. `connect()` is a no-op while a socket is open or connecting, reconnect timers are tracked, and a replaced socket cannot schedule another. The route reopens the socket when the signed-in user changes, because identity is bound at upgrade. Leaving a drawing does not close the connection.

The route resets scene, selection, viewport, tool, cursors and edit rights when the drawing changes. Once `room-state` has arrived, a later REST response may update the title but not the elements, because the room is newer than Postgres by up to one debounce. A save error is shown inline and leaves the editor intact. The page reacts to `permission-changed`, `access-revoked` and `forbidden` by switching to view-only or showing the reason.

The share dialog replaces an existing collaborator entry when their permission changes instead of duplicating it. It has no link-copy/public-toggle workflow, focus trap, or dialog semantics. Drawing cards use clickable divs and hover-only actions; toolbar/property controls and form labels need additional keyboard/accessible naming work. Anonymous viewers of public drawings join the room read-only and receive live edits.

### Local substitutions and omitted production work

Compose provides PostgreSQL/Valkey with volumes, not a distributed room cluster. Configuration loads an optional backend `.env`; PostgreSQL uses individual `POSTGRES_*` fields and Redis uses `REDIS_HOST`/`REDIS_PORT`, leaving `REDIS_URL` unused. CORS is hardcoded to the two local frontend origins. The development script pins 3001, including when called by the other instance scripts. `npm start` uses production-mode `tsx` source, not the TypeScript build output.

The SQL fixture creates Alice/Bob (`password123`), four drawings, and two edit grants. It is neither transaction-wrapped nor rerunnable without conflicts. Registration hashes use cost 12, while seeded hashes have cost 10. The [README](./README.md) describes one-time seeding and the existing two-account collaboration demo.

Omitted mechanisms include canonical command receipts/sequences, a fenced room owner, durable pending-client recovery, safe snapshot/tombstone retention, cross-server fan-out/replay, autosave retries, room draining, actual exports, history restore, undo/redo, group selection, and fully accessible object navigation. Backend tests mock dependencies/session behavior; [rooms.test.ts](./backend/src/websocket/rooms.test.ts) covers the save debounce and max-wait, retry after failure, the leave/rejoin window, HTTP merges, access refresh, and the add/update merge rules. Smoke tests cover login and drawing-list rendering, while screenshot configuration additionally opens seeded canvases. A scripted run against the live stack checked the following with real sockets:
- anonymous/private/forbidden joins;
- read-only enforcement;
- same-account multi-tab fan-out;
- both save paths;
- stale-tab HTTP merges;
- live downgrade and revocation;
- the last-one-out rejoin window;
- a SIGTERM with an unsaved edit in an open room.

It is not a benchmark, and convergence under concurrent conflicting edits is still not established.

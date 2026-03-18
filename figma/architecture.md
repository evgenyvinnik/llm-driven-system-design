# Design Figma - Architecture

## System Overview

A collaborative design and prototyping platform with real-time multiplayer editing, featuring vector graphics creation, version history, presence tracking, and team-based file organization.

**Learning Goals:**
- Build real-time collaborative editing with CRDT-like conflict resolution
- Design vector graphics storage and rendering pipelines
- Implement WebSocket-based presence and operation synchronization
- Handle version control with snapshot and operation log approaches

---

## Requirements

### Functional Requirements

1. **Real-time Editing**: Multiplayer collaborative editing with live cursors and selections
2. **Vector Graphics**: Create and manipulate shapes (rectangles, ellipses, text, frames)
3. **Layers Panel**: Visibility and lock controls per object with reordering
4. **Properties Panel**: Real-time property editing (position, size, fill, stroke, opacity)
5. **Version Control**: Auto-save and named version snapshots with restore capability
6. **File Management**: Create, browse, soft-delete, and organize files in teams/projects
7. **Comments**: Position-anchored threaded comments for design review

### Non-Functional Requirements

- **Availability**: 99.9% uptime, graceful reconnection on server restart
- **Latency**: < 50ms for local operations, < 200ms for sync to collaborators
- **Scale**: 100K files, 10K concurrent editing sessions, 50 users per file
- **Consistency**: Last-Writer-Wins (LWW) with client timestamps and tiebreaker by client ID
- **Durability**: No operation loss -- all edits persisted before acknowledgment

---

## Capacity Estimation

### Production Scale

| Metric | Estimate |
|--------|----------|
| Total files | 100K |
| Concurrent editing sessions | 10K |
| Users per file (peak) | 50 |
| Operations per second (global) | 500K |
| Average file size (canvas_data) | 500KB |
| WebSocket connections | 50K |
| Version snapshots per file | 100+ |

### Local Development Scale

- Concurrent users: 2-5 per file
- Operations per second: 10-50 per active session
- Storage: PostgreSQL with JSONB for canvas data
- WebSocket connections: 1 per user per file

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                            │
│          Web (React + PixiJS) │ Mobile │ Desktop                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CDN / Load Balancer                        │
│         (Static assets, WebSocket sticky sessions)              │
└─────────────────────────────────────────────────────────────────┘
                    │                          │
                    ▼                          ▼
┌────────────────────────┐    ┌────────────────────────────┐
│     REST API Server    │    │   WebSocket Sync Server    │
│                        │    │                            │
│  - File CRUD           │    │  - Operation broadcast     │
│  - Version management  │    │  - Presence tracking       │
│  - Auth / Sessions     │    │  - Conflict resolution     │
│  - Comments            │    │  - Auto-save triggers      │
└────────┬───────────────┘    └────────────┬───────────────┘
         │                                 │
         ▼                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Data Layer                               │
├──────────────────────────┬──────────────────────────────────────┤
│       PostgreSQL         │              Redis                   │
│  - Files + canvas_data   │  - Presence (cursor, selection)      │
│  - File versions         │  - Pub/Sub (cross-server sync)       │
│  - Operations log        │  - Sessions                         │
│  - Users, Teams          │  - Idempotency deduplication         │
│  - Comments, Permissions │  - Circuit breaker state             │
└──────────────────────────┴──────────────────────────────────────┘
```

---

## Core Components

### 1. Real-time Collaboration Engine

The collaboration engine uses a simplified CRDT approach based on Last-Writer-Wins (LWW) registers for object properties.

**Conflict Resolution Rules:**
- Each property update includes a client-side timestamp (millisecond precision)
- When merging concurrent edits, the highest timestamp wins
- Ties are broken by client ID (lexicographic ordering)
- Object creation/deletion is idempotent -- duplicate creates are merged, duplicate deletes are no-ops

**Operation Flow:**
1. Client generates operation with idempotency key and timestamp
2. Client optimistically applies operation locally (immediate UI feedback)
3. Client sends operation to server via WebSocket
4. Server deduplicates using idempotency key in Redis (5-minute TTL)
5. Server persists operation to the operations table
6. Server applies operation to the file's `canvas_data` JSONB
7. Server broadcasts operation to all other subscribers
8. Server sends acknowledgment to originating client

### 2. WebSocket Protocol

The WebSocket server manages file subscriptions, presence updates, and operation broadcasting.

**Client-to-Server Messages:**
- `subscribe` -- join a file editing session (includes userId, userName)
- `operation` -- send design operations (create, update, delete, move)
- `presence` -- cursor position and selection state updates

**Server-to-Client Messages:**
- `sync` -- initial file state with current presence and assigned cursor color
- `operation` -- broadcast of operations from other clients
- `presence` -- updated presence state (cursors, selections, joins, leaves)
- `ack` -- confirmation that operations were persisted

### 3. Vector Graphics Rendering

The frontend uses PixiJS (WebGL) for high-performance rendering of design objects.

**Rendering Pipeline:**
- `PixiRenderer.ts` wraps the PixiJS application lifecycle
- `ShapeFactory.ts` creates PixiJS graphics objects for each shape type (rectangle, ellipse, text)
- `SelectionOverlay.ts` draws selection bounds and resize handles
- Viewport transforms (pan/zoom) are applied at the container level
- Only objects within the viewport are rendered (frustum culling)

### 4. Version History

Version control uses a dual approach:
- **Auto-save**: Periodic snapshots of the full `canvas_data` JSONB (marked `is_auto_save = TRUE`)
- **Named versions**: User-triggered snapshots with descriptive names
- **Operations log**: Fine-grained operation history for undo/redo and audit

Restoration copies a version's `canvas_data` into the active file and broadcasts the update to all subscribers.

---

## Database Schema

The schema is defined in `/backend/src/db/init.sql` with 9 core tables.

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
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

-- Teams
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Team Members
CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'member',
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, user_id)
);

-- Projects (folders for organizing files)
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Files (design documents)
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
  deleted_at TIMESTAMP DEFAULT NULL  -- Soft delete
);

CREATE INDEX idx_files_owner ON files(owner_id);
CREATE INDEX idx_files_project ON files(project_id);
CREATE INDEX idx_files_team ON files(team_id);
CREATE INDEX idx_files_updated ON files(updated_at DESC);
CREATE INDEX idx_files_deleted ON files(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_deleted_at ON files(deleted_at) WHERE deleted_at IS NOT NULL;

-- File Versions (snapshots)
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

CREATE INDEX idx_file_versions_file ON file_versions(file_id);
CREATE INDEX idx_file_versions_file_number ON file_versions(file_id, version_number DESC);
CREATE INDEX idx_file_versions_autosave ON file_versions(is_auto_save, created_at);

-- Comments (position-anchored)
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

CREATE INDEX idx_comments_file ON comments(file_id);

-- File Permissions
CREATE TABLE file_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(50) DEFAULT 'view',
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_id, user_id)
);

-- Operations (CRDT log)
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
  idempotency_key VARCHAR(255) DEFAULT NULL
);

CREATE INDEX idx_operations_file ON operations(file_id);
CREATE INDEX idx_operations_file_timestamp ON operations(file_id, timestamp);
CREATE UNIQUE INDEX idx_operations_idempotency ON operations(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

---

## API Design

### REST Endpoints

```
GET    /api/files                              List all files
POST   /api/files                              Create new file
GET    /api/files/:id                          Get file details
PATCH  /api/files/:id                          Update file name
DELETE /api/files/:id                          Soft-delete file
GET    /api/files/:id/versions                 List version history
POST   /api/files/:id/versions                 Create named version
POST   /api/files/:id/versions/:vid/restore    Restore version
```

### WebSocket Protocol

```
ws://host/ws

Client ──▶ Server:
  { type: "subscribe",  payload: { fileId, userId, userName } }
  { type: "operation",  payload: { operations: [...] } }
  { type: "presence",   payload: { cursor: {x, y}, selection: [...] } }

Server ──▶ Client:
  { type: "sync",       payload: { file, presence, yourColor } }
  { type: "operation",  payload: { operations: [...] } }
  { type: "presence",   payload: { presence: [...], removed: [...] } }
  { type: "ack",        payload: { operationIds: [...] } }
```

---

## Key Design Decisions

### 1. LWW Registers vs. Full CRDT Library

**Decision**: Use simplified Last-Writer-Wins (LWW) registers rather than a full CRDT library like Yjs or Automerge.

A full CRDT library provides automatic conflict resolution for text editing, list reordering, and nested structures. However, design tool operations are predominantly property updates on independent objects (move rectangle, change fill color). LWW handles these naturally: two users editing different objects never conflict, and two users editing the same property resolve by timestamp. The trade-off is that concurrent structural operations (e.g., two users reordering the same layer list) may produce surprising results. For a design tool where most edits target different objects, LWW's simplicity outweighs the edge-case handling a full CRDT provides.

### 2. Canvas Data as JSONB vs. Normalized Tables

**Decision**: Store canvas data as a single JSONB blob on the files table.

Design objects have highly variable schemas (rectangles have corner radius, text has font properties, groups have children). Normalizing into separate tables per object type would require complex joins to load a design and make version snapshots expensive (copy all rows vs. copy one JSONB value). JSONB allows atomic snapshots, avoids O(N) joins, and leverages PostgreSQL's JSONB indexing if needed. The trade-off is that partial updates require read-modify-write of the entire blob, which is acceptable at the file sizes we handle (sub-MB).

### 3. WebSocket over HTTP Polling for Real-time Sync

**Decision**: Use native WebSocket connections for real-time operation sync and presence.

Collaborative editing requires sub-100ms latency for cursor movements and operation broadcast. HTTP polling at any reasonable interval (100ms-1s) would create massive server load at 50 concurrent editors and still deliver perceptible lag. WebSocket maintains a single persistent connection per client, enabling instant push with minimal overhead. The trade-off is connection management complexity: heartbeat mechanisms for stale detection, reconnection logic with operation replay, and sticky sessions for multi-server deployment.

### 4. Dual Soft-Delete Indexes

**Decision**: Use two partial indexes on `deleted_at` rather than a single full index.

Active file queries (the common case) filter `WHERE deleted_at IS NULL`. A partial index on this condition keeps the index small and fast. The cleanup job queries `WHERE deleted_at IS NOT NULL` with its own partial index. A single full index would include all rows and be larger without benefiting either query pattern.

---

## Consistency and Idempotency

### Operation Deduplication

Every operation includes a client-generated `idempotency_key`. The server checks Redis (`SET NX` with 5-minute TTL) before processing. If the key exists, the operation is a duplicate and is skipped. The operations table also has a partial unique index on `idempotency_key` as a database-level safety net.

### Conflict Resolution

LWW semantics with client timestamps. The server is the authority for operation ordering -- it persists operations in receipt order and broadcasts in the same order. Clients optimistically apply their own operations immediately and reconcile when they receive operations from other clients.

### Retry Policy

Exponential backoff for failed operations: 100ms initial delay, 5s max, 3 attempts, with 0-100ms random jitter. Failed operations after all retries are dropped (client-side) with user notification.

---

## Security and Auth

- **Session-based authentication** via express-session
- **CORS** restricted to frontend origin
- **File permissions** table with view/edit/admin levels per user per file
- **Parameterized SQL** via the pg library
- **JSON body size limit** of 10MB to prevent abuse

---

## Observability

### Prometheus Metrics

The `/metrics` endpoint exposes application metrics:

- `figma_active_collaborators{file_id}` -- gauge of collaborators per file
- `figma_websocket_connections_total` -- total active WebSocket connections
- `figma_operations_total{operation_type, status}` -- operation throughput
- `figma_operation_latency_seconds{operation_type}` -- processing latency histogram
- `figma_sync_latency_seconds{message_type}` -- broadcast latency
- `figma_idempotency_checks_total{result}` -- deduplication rate (processed vs. deduplicated)
- `figma_circuit_breaker_transitions_total{circuit, state}` -- circuit breaker state changes
- `figma_circuit_breaker_state{circuit}` -- current state (0=closed, 1=open, 2=half_open)
- `figma_db_query_latency_seconds{query_type}` -- database query performance
- `figma_file_versions{file_id, type}` -- version count for retention monitoring
- `figma_cleanup_jobs_total{job_type, status}` -- cleanup job execution tracking
- `figma_retry_attempts_total{operation, attempt}` -- retry behavior

### Structured Logging

Pino JSON logger with service context (`figma-backend`). Environment-aware: pretty-print with colors in development, raw JSON in production. Child loggers add request-specific context.

### Health Checks

- `GET /health` -- comprehensive check: PostgreSQL, Redis, WebSocket connections, circuit breaker states, uptime
- `GET /health/live` -- liveness probe (server is running)
- `GET /health/ready` -- readiness probe (PostgreSQL and Redis reachable)

---

## Failure Handling

### Circuit Breaker Pattern

Circuit breakers (Opossum) protect against cascading failures for PostgreSQL, Redis, and WebSocket sync operations.

| Circuit | Timeout | Error Threshold | Reset Timeout | Volume Threshold |
|---------|---------|-----------------|---------------|-----------------|
| PostgreSQL | 10s | 50% | 15s | 3 requests |
| Redis | 2s | 50% | 5s | 5 requests |
| WebSocket Sync | 3s | 60% | 5s | 10 requests |

State transitions are logged and tracked via Prometheus metrics. The health endpoint reports circuit breaker states.

### WebSocket Reconnection

Clients implement automatic reconnection with exponential backoff. On reconnect, the client re-subscribes to the file and receives a fresh `sync` message with current state. Operations generated during disconnection are queued locally and replayed on reconnect (deduplicated by idempotency key).

### Data Retention

Scheduled cleanup tasks (node-cron) manage storage:
- Auto-save versions older than a configurable threshold are pruned
- Operations older than the retention window are archived or deleted
- Soft-deleted files past the grace period are permanently removed

---

## Scalability Considerations

| Bottleneck | Current | Scaling Strategy |
|------------|---------|-----------------|
| WebSocket connections | Single server | Sticky sessions by file_id, Redis pub/sub for cross-server broadcast |
| Database writes | Direct writes | Write batching, connection pooling, read replicas for file listing |
| Large files | Full JSONB read/write | Chunked canvas data, delta compression, lazy object loading |
| Operation history | Unbounded growth | Time-based retention, archival to cold storage |
| Version snapshots | Full copies | Delta-based versioning, compression |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Conflict resolution | LWW registers | Full CRDT (Yjs/Automerge) | Simpler for property-level edits on independent objects |
| Canvas storage | JSONB blob | Normalized object tables | Atomic snapshots, no joins, variable schemas |
| Real-time sync | WebSocket | HTTP polling / SSE | Sub-100ms latency for cursor and operation broadcast |
| Rendering | PixiJS (WebGL) | Canvas 2D API | Better performance for large object counts |
| Version storage | Full snapshots | Delta-based | Simpler restore, acceptable storage for MVP |
| Soft delete | Partial indexes | Boolean flag | Optimized for both active queries and cleanup |
| Idempotency | Redis NX + DB unique index | Application-level dedup | Double-layer protection against duplicates |

---

## Frontend Architecture

This section describes the actual frontend implementation: component hierarchy, state management, routing, data fetching, real-time collaboration, canvas rendering, and key UI patterns.

### Component Hierarchy

```
App.tsx (conditional routing)
├── FileBrowser                               (file list grid)
│   └── File cards                            (thumbnail, name, date)
└── Editor                                    (full design workspace)
    ├── Toolbar                               (shape tools: select, rectangle, ellipse, text, frame)
    ├── LayersPanel                           (object list with visibility/lock toggles)
    ├── Canvas                                (PixiJS WebGL canvas + mouse/keyboard handlers)
    │   └── PixiRenderer                      (WebGL rendering engine)
    │       ├── ShapeFactory                  (creates PixiJS graphics per shape type)
    │       └── SelectionOverlay              (selection bounds, resize handles)
    ├── PropertiesPanel                       (position, size, fill, stroke, opacity editors)
    └── VersionHistory (modal)                (save/restore version snapshots)
```

The application uses a simple two-state navigation pattern: `App.tsx` holds a `selectedFileId` state variable. When null, it renders `FileBrowser`; when set, it renders `Editor` with the file ID. There is no router library -- navigation is handled by React state, with the `Editor` providing an `onBack` callback that resets `selectedFileId` to null.

### Zustand Store

The frontend uses a single Zustand store (`stores/editorStore.ts`) that manages all editor state -- a deliberate design choice for a design tool where all state is deeply interconnected.

**`useEditorStore` -- Full Editor State**

The store manages six state domains:

1. **File state**: `fileId`, `fileName`, `canvasData` (the complete design document as a JSON structure containing `objects` and `pages` arrays).

2. **Selection and tool**: `selectedIds` (array of selected object UUIDs) and `activeTool` (current drawing tool: select, rectangle, ellipse, text, frame).

3. **Viewport**: `x`, `y`, `zoom` -- the pan and zoom transform applied to the canvas. All objects are rendered relative to these viewport coordinates.

4. **Presence**: `collaborators` (array of `PresenceState` objects with userId, userName, cursor position, selection, and color), plus the local user's `userId`, `userName`, and `userColor`.

5. **History**: `history` (array of up to 50 `CanvasData` snapshots) and `historyIndex` (current position in the history stack). Undo/redo navigate this stack.

6. **Object operations**: `addObject`, `updateObject`, `deleteObject`, `duplicateObject`, `moveObjectInLayer`. Each operation follows a three-step pattern:
   - Push the current state to the history stack (for undo)
   - Create an `Operation` object and send it via WebSocket (for multi-user sync)
   - Apply the change locally as an optimistic update

**WebSocket integration via function reference**: The store uses a module-level `operationSender` variable set by the WebSocket hook via `setOperationSender()`. This avoids circular dependency between the store and the WebSocket hook -- the store creates operations and calls `sendOperation()`, but does not import the WebSocket module directly.

### Rendering Pipeline (PixiJS / WebGL)

The rendering system is the most architecturally significant part of the frontend. It uses PixiJS for hardware-accelerated WebGL rendering, which provides dramatically better performance than Canvas 2D for design tools with many objects.

**`PixiRenderer.ts` (365 lines)** -- The main renderer class that manages the PixiJS application lifecycle:

1. **Initialization**: Creates a PixiJS `Application`, attaches it to a DOM container, and sets up the rendering hierarchy: viewport container (applies pan/zoom) > objects container (holds shape graphics) > grid graphics (background grid) > cursor container (remote user cursors).

2. **Viewport transforms**: Pan and zoom are applied at the `viewportContainer` level via `position` and `scale` properties. Individual objects do not need to know about the viewport -- they are rendered in world coordinates and the container transform handles the rest.

3. **Object rendering**: `renderObjects()` takes an array of `DesignObject` and synchronizes the PixiJS scene graph. It uses a `Map<string, PIXI.Container>` to track existing graphics objects. New objects are created via `ShapeFactory`; removed objects are destroyed; updated objects have their properties synced (position, size, fill, stroke, opacity).

4. **Frustum culling**: Only objects whose bounding boxes intersect the visible viewport are rendered, preventing performance degradation with large designs containing hundreds of off-screen objects.

**`ShapeFactory.ts` (199 lines)** -- Creates PixiJS `Graphics` objects for each shape type:
- **Rectangle**: `drawRoundedRect()` with configurable corner radius, fill color, and stroke
- **Ellipse**: `drawEllipse()` with fill and stroke
- **Text**: `PIXI.Text` with configurable font, size, color, and alignment
- **Frame**: Container rectangle with a label, used for grouping objects

**`SelectionOverlay.ts` (143 lines)** -- Draws selection indicators:
- Blue bounding box around selected objects
- Resize handles at corners and edge midpoints
- Multi-select bounding box when multiple objects are selected

### WebSocket Integration and Real-Time Collaboration

The `useWebSocket` hook (`hooks/useWebSocket.ts`) manages the full real-time collaboration lifecycle:

1. **Connection**: When `fileId` is provided, the hook opens a WebSocket to `ws://host/ws` and sends a `subscribe` message with `fileId`, `userId`, and `userName`.

2. **Initial sync**: The server responds with a `sync` message containing the file's `canvas_data`, current presence list, and the assigned cursor color for this user. The hook updates the store with `setCanvasData()`, `setCollaborators()`, and `setUserInfo()`.

3. **Operation handling**: When the store sends an operation (via the `operationSender` function reference), the hook sends it as an `operation` WebSocket message. Incoming operations from other users are filtered (`op.userId !== state.userId`) to skip self-operations (already applied optimistically). Remote operations are applied using the `operationApplier` service.

4. **Operation applier** (`services/operationApplier.ts`): A pure function that takes `CanvasData` and an `Operation` and returns new immutable `CanvasData`. Supports four operation types:
   - `create`: Appends a new `DesignObject` to the objects array (with deduplication check)
   - `update`: Merges property updates into an existing object, supporting both full-object merge and dot-notation path updates (e.g., `style.fill`)
   - `delete`: Removes an object from the array by ID
   - `move`: Changes an object's z-order position (layer reordering)

5. **Presence**: The `sendPresence(cursor, selection)` function sends cursor position (x, y in canvas coordinates) and current selection (array of object IDs) to other collaborators. Incoming presence updates are stored in the editor store and rendered as colored cursors on the canvas.

6. **Reconnection**: On WebSocket close, the hook schedules a reconnect after 3 seconds. On reconnect, it re-subscribes to the file and receives a fresh `sync` message with current state.

### Canvas Rendering

The `Canvas` component (`components/Canvas.tsx`, 296 lines) is the central interaction surface. It handles:

- **Mouse events**: Click to select, drag to move selected objects, click+drag with a shape tool to create new objects. Mouse move updates presence cursor position via `sendPresence()`.
- **Keyboard events**: Delete/Backspace to remove selected objects, Ctrl+Z/Ctrl+Y for undo/redo, Ctrl+D for duplicate, arrow keys for nudge movement.
- **Pan**: Middle mouse button or Space+drag for viewport panning.
- **Zoom**: Mouse wheel adjusts viewport zoom, centered on the cursor position.
- **Selection**: Click on empty canvas deselects. Click on an object selects it. The selection state drives both the `PropertiesPanel` content and the `SelectionOverlay` rendering.

The Canvas component initializes a `PixiRenderer` instance on mount, attaches it to a `div` ref, and calls `renderer.renderObjects()` whenever `canvasData.objects` changes. It also calls `renderer.renderPresence()` when collaborator cursor positions update.

### Key UI Patterns

- **Three-panel layout**: The editor uses a fixed three-panel layout similar to Figma: layers panel (left, ~240px), canvas (center, flexible), properties panel (right, ~280px). All panels share the same dark theme (`bg-figma-bg`).

- **Optimistic updates with operation sync**: Every local change (create shape, move object, change color) applies immediately to the store and simultaneously sends a WebSocket operation. Remote operations are received and applied to the store, which triggers a re-render of the PixiJS canvas. This ensures sub-50ms local response time while keeping all clients synchronized.

- **Undo/redo via history stack**: The store maintains a stack of up to 50 `CanvasData` snapshots. Every mutation pushes the current state onto the stack before applying the change. Undo/redo navigates this stack with full `CanvasData` copies (deep clone via `JSON.parse(JSON.stringify(...))`). Remote operations do not push to the history stack -- only local operations do.

- **Layer management**: The `LayersPanel` shows all objects in reverse z-order (top-most first). Each layer item has visibility and lock toggle buttons. The `moveObjectInLayer` store action changes an object's position in the `objects` array, which determines its z-order in the PixiJS rendering pipeline.

- **Property editing**: The `PropertiesPanel` shows editable fields for the selected object: x, y, width, height, rotation, fill color, stroke color, stroke width, opacity. Changes call `updateObject(id, updates)` on the store, which optimistically applies the update and broadcasts it via WebSocket.

- **Version history modal**: The `VersionHistory` component provides a modal for saving named versions (snapshots of the current `canvas_data`) and restoring previous versions. Auto-save versions are distinguished from named versions. Restoring a version replaces the current `canvas_data` and broadcasts the change to all collaborators.

- **File browser**: The `FileBrowser` component shows a card grid of design files with names and timestamps. Users can create new files, soft-delete files, and click to open the editor. There is no folder/project hierarchy in the current implementation -- files are listed flat.

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, written for readers encountering these patterns for the first time.

### Circuit Breaker

**What it is**: A circuit breaker monitors calls to an external dependency (database, cache, API) and tracks failure rates. When failures exceed a configurable threshold, the circuit "opens" -- subsequent calls fail immediately without attempting the operation. After a timeout, the circuit enters "half-open" state and allows one test request. If it succeeds, the circuit closes and normal operation resumes. If it fails, the circuit stays open for another timeout period.

**Why it matters**: In a collaborative design tool, every operation involves two external systems: PostgreSQL (persist the operation and update canvas data) and Redis (check idempotency key, update presence). If PostgreSQL becomes slow (e.g., under heavy query load from a large file), every WebSocket operation handler blocks waiting for the database. The server's event loop fills up, and even Redis-only operations (presence updates, cursor movements) stop working. The circuit breaker detects PostgreSQL's degradation and stops sending requests to it, allowing presence and cursor operations to continue normally while file save operations are queued.

**How it works in this project**: The implementation uses the Opossum library (`backend/src/shared/circuitBreaker.ts`) with three independent circuits:

| Circuit | Timeout | Error Threshold | Reset Timeout | Volume Threshold |
|---------|---------|-----------------|---------------|-----------------|
| PostgreSQL | 10s | 50% | 15s | 3 requests |
| Redis | 2s | 50% | 5s | 5 requests |
| WebSocket Sync | 3s | 60% | 5s | 10 requests |

"Error threshold 50% with volume threshold 3" means: after at least 3 requests, if 50% or more fail, the circuit opens. The volume threshold prevents the circuit from opening on a single transient failure. State transitions (closed to open, open to half-open, half-open to closed) are logged via Pino and tracked via Prometheus metrics (`figma_circuit_breaker_state{circuit}` gauge, `figma_circuit_breaker_transitions_total{circuit, state}` counter). The `/health` endpoint reports all circuit breaker states, so operators can see at a glance which dependencies are healthy.

### Prometheus Metrics

**What it is**: Prometheus is a monitoring system where applications expose numeric measurements at an `/metrics` HTTP endpoint. A Prometheus server periodically scrapes these endpoints and stores the data as time series. Applications define three types of metrics: **Counters** (monotonically increasing values, like total operations processed), **Histograms** (distributions of values in buckets, like operation latency), and **Gauges** (point-in-time values that go up and down, like active collaborators).

**Why it matters**: A design tool has unique monitoring needs. You need to know: "How many collaborators are on this file?" (capacity planning), "What is the operation broadcast latency?" (user experience), "How many operations are being deduplicated?" (network reliability indicator), "How many auto-save versions are accumulating?" (storage planning).

**How it works in this project**: The metrics module (`backend/src/shared/metrics.ts`) exposes 12+ custom metrics:

- `figma_active_collaborators{file_id}` (gauge) -- collaborators per file, for hot-spot detection
- `figma_websocket_connections_total` (gauge) -- total active connections, for capacity planning
- `figma_operations_total{operation_type, status}` (counter) -- throughput by type (create/update/delete/move) and status (success/failed)
- `figma_operation_latency_seconds{operation_type}` (histogram) -- processing time from receipt to persistence
- `figma_sync_latency_seconds{message_type}` (histogram) -- broadcast latency from persistence to delivery
- `figma_idempotency_checks_total{result}` (counter) -- ratio of new vs. deduplicated operations (high dedup rate suggests network issues)
- `figma_db_query_latency_seconds{query_type}` (histogram) -- database performance by query type
- `figma_retry_attempts_total{operation, attempt}` (counter) -- retry behavior visibility
- `figma_cleanup_jobs_total{job_type, status}` (counter) -- retention job tracking

### Structured Logging

**What it is**: Structured logging outputs log entries as JSON objects with consistent, queryable fields instead of free-form text. Each entry includes level, timestamp, message, and contextual metadata specific to the operation being logged.

**Why it matters**: When a user reports "I drew a rectangle but my collaborator did not see it," debugging requires tracing the operation through the entire system: client WebSocket send, server receive, idempotency check, database insert, Redis pub/sub broadcast, collaborator WebSocket delivery. With structured logs, you can filter by `operationId` across all log entries to reconstruct the full path. With text logs, this correlation is manual and error-prone.

**How it works in this project**: Pino (`backend/src/shared/logger.ts`) is configured with the service context `figma-backend`. In development, logs are pretty-printed with colors for readability. In production, they output raw JSON for ingestion by log aggregation systems. Child loggers are created for request-specific context, adding fields like `fileId`, `operationId`, `userId`, and `operationType`. WebSocket message handling logs include the message type and payload size. Circuit breaker state transitions are logged at `warn` level with the circuit name and new state.

### Idempotency

**What it is**: An idempotent operation produces the same result regardless of how many times it is executed. In a real-time collaborative system, idempotency is critical because network conditions guarantee that some operations will be delivered more than once.

**Why it matters**: Consider this scenario: User A draws a rectangle. The operation is sent via WebSocket. The server persists it and broadcasts it. But the ACK is lost due to a network blip. User A's client retries the operation. Without idempotency, the server creates a second rectangle at the same position -- the collaborator sees two overlapping rectangles. With idempotency, the server recognizes the retry by its unique key and returns the original ACK without processing the operation again.

**How it works in this project**: Idempotency is enforced at two layers. First, Redis: every operation includes a client-generated `idempotency_key`. The server executes `SET key NX EX 300` (set if not exists, 5-minute TTL). If the key already exists, the operation is a duplicate and is skipped. Second, PostgreSQL: the operations table has a partial unique index on `idempotency_key WHERE idempotency_key IS NOT NULL`. This provides a database-level safety net in case of Redis failure. The dual-layer approach (`backend/src/shared/idempotency.ts`) ensures that even if Redis is temporarily unavailable, duplicate operations are still caught at the database level.

### Health Checks

**What it is**: Health check endpoints are lightweight HTTP routes that report whether an application instance can serve traffic. They are consumed by load balancers (to route traffic), container orchestrators (to restart failed instances), and monitoring systems (to alert operators).

**Why it matters**: A Figma-like design tool server manages both HTTP REST endpoints and WebSocket connections. An instance might have a working REST API but a broken WebSocket subsystem (e.g., Redis pub/sub connection lost). Without granular health checks, the load balancer continues routing WebSocket connections to this instance, where they silently fail to receive collaboration updates.

**How it works in this project**: Three health endpoints exist, each serving a different consumer:

- `GET /health` -- comprehensive check: tests PostgreSQL connectivity (`SELECT 1`), Redis connectivity (`PING`), reports active WebSocket connection count, lists all circuit breaker states, and includes process uptime. Returns `200` with full status or `503` with per-dependency failure details.
- `GET /health/live` -- minimal liveness probe: returns `200` if the process is running. Used by orchestrators to detect crashed instances. Does not check dependencies (a live but degraded instance should not be killed and restarted in a loop).
- `GET /health/ready` -- readiness probe: checks PostgreSQL and Redis. Returns `200` only when both are reachable. Used by load balancers to determine when an instance can start receiving traffic after startup, and by orchestrators to remove instances from the pool during dependency outages.

### Rate Limiting

**What it is**: Rate limiting restricts the number of requests a client can make within a time window. It protects servers from overload and ensures fair resource sharing among users.

**Why it matters**: In a collaborative design tool, a single user moving an object generates a stream of `update` operations -- potentially dozens per second during a drag operation. A buggy client or automated script could generate thousands of operations per second, overwhelming the database and WebSocket broadcast system. Rate limiting caps the operation rate at a sustainable level while allowing normal interactive editing.

**How it works in this project**: Rate limiting is listed as omitted from the local build, but the architecture specifies the design. Operation rate would be limited per-user per-file using a sliding window counter in Redis. The limit would be set high enough for interactive editing (e.g., 100 operations per second) but low enough to catch runaway clients. REST API endpoints would have standard per-user rate limits. Login endpoints would have strict limits to prevent credential stuffing.

### Redis Cache-Aside

**What it is**: Cache-aside (lazy loading) is a caching strategy where the application checks the cache first. On a miss, it reads from the database, populates the cache, and returns the data. On a hit, the database is bypassed entirely.

**Why it matters**: Loading a design file involves reading the `files` row (including the `canvas_data` JSONB blob, which can be hundreds of KB for complex designs) and joining with permissions and team membership. This is a heavy query. When 50 users are collaborating on the same file, each WebSocket reconnection triggers a full file load. Caching the file data in Redis reduces this from a ~50ms database query to a ~2ms cache read.

**How it works in this project**: While the project does not implement a general-purpose cache-aside layer, it uses Redis for specific caching patterns: session data is stored in Redis for fast validation on every WebSocket message, presence data (cursor positions, selections) is stored exclusively in Redis (never hitting PostgreSQL), and idempotency keys are cached in Redis with 5-minute TTLs. The architecture notes indicate that a full cache-aside layer for file metadata and canvas data would be the next scaling step, with invalidation triggered by any write operation.

### RBAC (Role-Based Access Control)

**What it is**: RBAC assigns permissions to roles rather than individual users. Users are granted roles, and the role determines what actions they can perform on a resource. This creates a manageable permission system that scales with the number of users and resources.

**Why it matters**: A design tool has three natural permission levels: viewers (can see the design but not edit), editors (can modify objects and properties), and admins (can manage sharing and delete the file). Without RBAC, every permission check requires looking up the specific user-file-permission combination. With RBAC, roles are defined once and assigned per user per file.

**How it works in this project**: The `file_permissions` table maps users to files with a permission level (`view`, `edit`, `admin`). Team membership provides a baseline: team members get `view` access to all team files, with per-file overrides for `edit` or `admin`. The `team_members` table assigns team roles (`owner`, `admin`, `member`). While the permission enforcement middleware is listed as not yet implemented in the local build, the database schema and API design support the full RBAC model. File operations would check: (1) is the user a file permission holder? (2) if not, is the user a team member? (3) what is the effective permission level?

---

## Implementation Notes

This section documents the actual local setup and maps production concepts to the Docker + Node.js + React implementation.

### Local Architecture

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│   Frontend (React 19 + Vite) │ :5173  │   Backend (Express + WS)    │ :3000
│   PixiJS Canvas Renderer     │───────▶│   REST: /api/files          │
│   Zustand Editor Store       │  HTTP  │   WS:   /ws                 │
│   WebSocket Hook             │───────▶│   WebSocket Handler         │
│   Tailwind CSS               │   WS   │                             │
└──────────────────────────────┘        └──────────────┬──────────────┘
                                                       │
                                              ┌────────┼────────┐
                                              ▼                 ▼
                                        ┌──────────┐     ┌──────────┐
                                        │ Postgres │     │  Redis   │
                                        │  :5432   │     │  :6379   │
                                        └──────────┘     └──────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Circuit breakers | Opossum with per-service configs (Postgres, Redis, Sync) | `backend/src/shared/circuitBreaker.ts` |
| Prometheus metrics | 12+ custom metrics (gauges, counters, histograms) | `backend/src/shared/metrics.ts` |
| Structured logging | Pino JSON logger with child logger support | `backend/src/shared/logger.ts` |
| Idempotency | Redis NX deduplication + DB partial unique index | `backend/src/shared/idempotency.ts` |
| Retry with backoff | Configurable exponential backoff utility | `backend/src/shared/retry.ts` |
| Data retention | Scheduled cleanup for auto-saves, operations, soft-deleted files | `backend/src/shared/retention.ts` |
| Health checks | /health (PG + Redis + WS + circuit breakers), /health/live, /health/ready | `backend/src/index.ts` |
| WebSocket sync | Real-time operation broadcast with presence tracking | `backend/src/websocket/handler.ts` |
| Operation service | CRDT operation persistence and canvas_data updates | `backend/src/services/operationService.ts` |
| Presence service | Redis-backed cursor and selection tracking | `backend/src/services/presenceService.ts` |
| Graceful shutdown | SIGTERM/SIGINT handlers with connection draining | `backend/src/index.ts` |
| Soft delete | deleted_at column with dual partial indexes | `backend/src/db/init.sql` |

### What Was Simplified or Substituted

| Production Concept | Local Substitute |
|-------------------|-----------------|
| CDN + Load Balancer with sticky sessions | Single Express + WS server |
| Separate REST and WebSocket services | Combined in one Express server |
| Full CRDT (Yjs/Automerge) | Simplified LWW with timestamps |
| Redis Cluster for presence | Single Valkey 7 instance |
| Object storage (S3) for thumbnails | thumbnail_url column (not implemented) |
| Multi-server WebSocket with Redis pub/sub | Single-server WebSocket |
| OAuth/SSO | Session-based auth |
| Delta-based version compression | Full JSONB snapshot per version |

### What Was Omitted

- CDN for static assets and design file thumbnails
- Multi-server WebSocket deployment with Redis pub/sub cross-server broadcast
- Component libraries and design system management
- Prototyping and interaction design features
- Export to PNG/SVG/PDF
- Offline editing with IndexedDB queuing
- Undo/redo with operation log replay (schema supports it, UI not implemented)
- Comments UI (database schema exists, frontend not built)
- File permission enforcement in API (table exists, middleware not implemented)
- Rate limiting
- Kubernetes / container orchestration

### Frontend Architecture

The frontend uses React 19 + TypeScript + Vite + Zustand + Tailwind CSS with PixiJS for rendering.

Key components:
- `Canvas.tsx` -- main canvas with mouse/keyboard event handling (296 lines)
- `Editor.tsx` -- workspace layout composing all panels
- `LayersPanel.tsx` -- layer visibility and lock controls
- `PropertiesPanel.tsx` -- real-time property editing
- `Toolbar.tsx` -- shape tool selection
- `VersionHistory.tsx` -- version save/restore UI
- `FileBrowser.tsx` -- file listing and management

Key modules:
- `renderer/PixiRenderer.ts` -- WebGL rendering engine (365 lines)
- `renderer/ShapeFactory.ts` -- shape creation (199 lines)
- `renderer/SelectionOverlay.ts` -- selection UI (143 lines)
- `stores/editorStore.ts` -- Zustand store for all editor state (359 lines)
- `hooks/useWebSocket.ts` -- WebSocket connection and message handling (201 lines)

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

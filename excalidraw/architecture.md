# Excalidraw - Collaborative Whiteboard Architecture

## System Overview

A real-time collaborative whiteboard enabling multiple users to simultaneously create and edit vector shapes (rectangles, ellipses, diamonds, arrows, lines, freehand paths, text) on a shared infinite canvas. The system handles conflict resolution using shape-level Last-Writer-Wins (LWW) CRDT, cursor presence tracking, and persistent storage of drawing state.

**Learning Goals:**
- Design real-time collaboration with WebSocket rooms and CRDT conflict resolution
- Implement HTML5 Canvas rendering with viewport transforms (pan/zoom)
- Build cursor presence tracking with Redis-backed ephemeral state
- Understand trade-offs between OT, CRDT, and simpler LWW approaches

## Requirements

### Functional Requirements

1. Users can create, edit, and delete drawings
2. Multiple shape types: rectangle, ellipse, diamond, arrow, line, freehand, text
3. Real-time collaboration: multiple users editing the same drawing simultaneously
4. Live cursor presence: see other collaborators' cursor positions
5. Drawing sharing with view/edit permissions
6. Pan and zoom on infinite canvas
7. Shape properties: stroke color, fill color, stroke width, opacity
8. Persistent storage: drawings survive server restarts

### Non-Functional Requirements (Production Scale)

| Metric | Target |
|--------|--------|
| Collaboration latency | < 50ms peer-to-peer |
| Concurrent users per drawing | 50+ |
| Total concurrent drawings | 100K+ |
| Canvas elements per drawing | 10K+ |
| Availability | 99.9% |
| Data durability | 99.99% |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Client (Browser)                            │
│  ┌────────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │   Canvas   │  │   Toolbar    │  │  Zustand  │  │  WS Client    │  │
│  │  Renderer  │  │  Properties  │  │  Stores   │  │  REST Client  │  │
│  └────────────┘  └──────────────┘  └──────────┘  └───────────────┘  │
└──────────────────────────┬──────────────────┬────────────────────────┘
                           │ HTTP/REST        │ WebSocket
                           ▼                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Load Balancer                                │
│                    (Sticky Sessions / IP Hash)                       │
└──────────────────────────┬──────────────────┬────────────────────────┘
                           │                  │
              ┌────────────┴────┐    ┌────────┴────────┐
              │  Collab Server 1│    │  Collab Server 2│
              │  Express + WS   │    │  Express + WS   │
              │  ┌───────────┐  │    │  ┌───────────┐  │
              │  │ WS Rooms  │  │    │  │ WS Rooms  │  │
              │  │ CRDT Merge│  │    │  │ CRDT Merge│  │
              │  └───────────┘  │    │  └───────────┘  │
              └───────┬─────────┘    └───────┬─────────┘
                      │                      │
         ┌────────────┴──────────────────────┴────────────┐
         │                                                 │
    ┌────▼────────┐                                 ┌──────▼──────┐
    │  PostgreSQL │          Redis Pub/Sub           │ Redis/Valkey│
    │  (Primary   │◀────────(cross-server────────────│  Sessions   │
    │  + Replicas)│          fan-out)                │  Cursors    │
    │  Drawings   │                                  │  Presence   │
    │  Elements   │                                  │  Cache      │
    └─────────────┘                                  └─────────────┘
```

At production scale, multiple WebSocket servers sit behind a load balancer with sticky sessions (IP hash or session cookie affinity). Redis Pub/Sub provides cross-server fan-out so that collaborators connected to different servers still receive each other's edits. The load balancer routes WebSocket upgrades to a consistent server per client, minimizing unnecessary cross-server communication.

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    avatar_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drawings (the canvas container)
CREATE TABLE drawings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL DEFAULT 'Untitled',
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elements JSONB DEFAULT '[]'::jsonb,   -- Array of shape elements
    app_state JSONB DEFAULT '{}'::jsonb,   -- Viewport, grid settings
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drawing collaborators (access control)
CREATE TABLE drawing_collaborators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(10) NOT NULL DEFAULT 'view'
      CHECK (permission IN ('view', 'edit')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(drawing_id, user_id)
);

-- Drawing versions (periodic snapshots for history)
CREATE TABLE drawing_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    elements JSONB NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Operations log (audit trail for CRDT operations)
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_type VARCHAR(10) NOT NULL
      CHECK (operation_type IN ('add', 'update', 'delete', 'move')),
    element_id VARCHAR(255) NOT NULL,
    element_data JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_drawings_owner_id ON drawings(owner_id);
CREATE INDEX idx_drawings_is_public ON drawings(is_public);
CREATE INDEX idx_drawing_collaborators_drawing_id ON drawing_collaborators(drawing_id);
CREATE INDEX idx_drawing_collaborators_user_id ON drawing_collaborators(user_id);
CREATE INDEX idx_drawing_versions_drawing_id
  ON drawing_versions(drawing_id, version_number DESC);
CREATE INDEX idx_operations_drawing_id ON operations(drawing_id, created_at DESC);
CREATE INDEX idx_operations_element_id ON operations(drawing_id, element_id);
```

**Why JSONB for elements?** Drawing elements are semi-structured -- different shapes have different properties (`points` for freehand/arrows, `text` and `fontSize` for text elements, `width`/`height` for rectangles). JSONB allows flexible schema evolution without migrations and supports atomic updates via `jsonb_set()`. The trade-off is write amplification: updating a single element requires rewriting the entire JSONB column. PostgreSQL's TOAST compression mitigates this for large payloads, but at extreme scale (10K+ elements per drawing), element-level storage in a separate table would reduce write amplification.

Each element in the `elements` JSONB array carries: `id`, `type`, `x`, `y`, `width`, `height`, `points` (for freehand/arrows), `text`, `strokeColor`, `fillColor`, `strokeWidth`, `opacity`, `fontSize`, `version` (monotonic counter), `isDeleted` (soft delete flag), `createdBy`, and `updatedAt` (high-resolution timestamp for LWW tie-breaking).

## API Design

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Register new user |
| POST | `/api/v1/auth/login` | Login, create session |
| POST | `/api/v1/auth/logout` | Destroy session |
| GET | `/api/v1/auth/me` | Get current user |

### Drawings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/drawings` | List user's drawings |
| GET | `/api/v1/drawings/public` | List public drawings |
| POST | `/api/v1/drawings` | Create drawing |
| GET | `/api/v1/drawings/:id` | Get drawing with elements |
| PUT | `/api/v1/drawings/:id` | Update drawing (full save) |
| DELETE | `/api/v1/drawings/:id` | Delete drawing (owner only) |
| POST | `/api/v1/drawings/:id/collaborators` | Add collaborator |
| DELETE | `/api/v1/drawings/:id/collaborators/:userId` | Remove collaborator |
| GET | `/api/v1/drawings/:id/collaborators` | List collaborators |

### Health & Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Simple health check |
| GET | `/api/health/detailed` | Detailed health with component status |
| GET | `/metrics` | Prometheus metrics |

## WebSocket Protocol

All WebSocket communication uses JSON messages over a single `/ws` endpoint.

### Client-to-Server Messages

```
join-room     { type, drawingId, userId, username }
leave-room    { type }
shape-add     { type, elementData }
shape-update  { type, elementData }
shape-delete  { type, elementId }
shape-move    { type, elementData }
elements-sync { type, elements }
cursor-move   { type, x, y }
```

### Server-to-Client Messages

```
connected     { type, color }           -- Assigned cursor color
room-state    { type, drawingId, elements }  -- Full state on join
user-joined   { type, userId, username, color }
user-left     { type, userId, username }
shape-add     { type, userId, elementData }  -- Broadcast
shape-update  { type, userId, elementData }  -- Broadcast
shape-delete  { type, userId, elementId }    -- Broadcast
shape-move    { type, userId, elementData }  -- Broadcast
elements-sync { type, userId, elements }     -- Broadcast
cursor-move   { type, userId, username, x, y, color } -- Broadcast
error         { type, message }
```

## CRDT Approach: Shape-Level LWW

### Why LWW over OT or full CRDT?

| Approach | Pros | Cons |
|----------|------|------|
| **LWW (chosen)** | Simple, low overhead, ~50 lines of merge logic | Can lose concurrent edits to same element |
| OT (Operational Transform) | Precise character-level merges | Complex, requires central server, hard to implement correctly |
| Full CRDT (Automerge/Yjs) | True conflict-free, decentralized | Large overhead per element, complex data structures |

In a whiteboard, users typically work on different shapes. Two users simultaneously editing the exact same rectangle is rare. When it does happen, keeping the latest version is acceptable -- the "loser" sees their change replaced, which is a natural experience (someone else moved the box I was editing). For text elements where character-level merging matters, a full CRDT library would be appropriate, but for geometric shapes, LWW provides 90% of the value at 10% of the complexity.

The critical insight is that LWW's weakness (losing concurrent edits to the same element) is masked by the whiteboard's UX. Unlike text editing where two people typing in the same paragraph produces a visible mess, two people dragging the same rectangle simply results in one final position. The user who "lost" can see the rectangle moved and drag it again.

### Merge Algorithm

```
mergeElements(existing[], incoming[]):
  elementMap = Map<id, element>

  for each in existing:
    elementMap[el.id] = el

  for each in incoming:
    current = elementMap[el.id]
    if !current:
      elementMap[el.id] = el          // New element
    else if el.version > current.version:
      elementMap[el.id] = el          // Higher version wins
    else if el.version == current.version AND el.updatedAt > current.updatedAt:
      elementMap[el.id] = el          // Same version, newer timestamp wins
    // else keep existing

  return elementMap.values()
```

The merge function is commutative (order-independent), associative (pairwise or all-at-once yields the same result), and idempotent (applying the same update twice has no additional effect). These three properties guarantee that all clients converge to the same state regardless of message delivery order.

### Soft Deletes

Deleted elements are marked `isDeleted: true` with an incremented version rather than removed from the array. This is essential for CRDT convergence: if a delete physically removed an element, a concurrent update arriving after the delete would re-insert the element, violating the user's intent. By keeping deleted elements in the array with a version number, the delete participates in the same LWW comparison as any other update. The renderer filters out deleted elements; the full array (including deleted elements) is kept for merge correctness.

## Cursor Presence

Cursor positions are stored in Redis hashes with a 30-second TTL:

```
HSET presence:cursors:{drawingId} {userId} '{"userId":"...","username":"...","x":100,"y":200,"color":"#e03131"}'
EXPIRE presence:cursors:{drawingId} 30
```

Real-time cursor updates flow directly through WebSocket broadcast (not through Redis) for minimal latency. Redis serves as the persistence layer so that newly joining users can see existing cursor positions. Stale cursors auto-expire after 30 seconds of inactivity.

Cursor colors are assigned from a rotating palette of 12 distinct colors when a WebSocket client connects. This ensures collaborators are visually distinguishable. Cursors are rendered as CSS-positioned SVG elements in a DOM layer above the canvas, avoiding costly full canvas redraws on cursor movement.

## Key Design Decisions

### 1. WebSocket Rooms vs Redis Pub/Sub for Fan-out

**Decision:** In production, Redis Pub/Sub channels (one per drawing) broadcast shape operations across all WebSocket server instances. Each server subscribes to channels for its active rooms and forwards messages to local WebSocket connections.

**Why not in-memory only?** In-memory rooms (`Map<drawingId, Set<WebSocket>>`) work for a single server but cannot fan out messages to collaborators connected to different servers. With horizontal scaling, a user on Server A editing a shape must notify a collaborator on Server B.

**Trade-off:** Redis Pub/Sub adds one network hop per message (server-to-Redis-to-server) compared to in-memory broadcast. For cursor updates at 60Hz, this latency is noticeable. The mitigation is to throttle cursor updates to 10Hz through Redis while keeping shape operations at full speed (they are less frequent but more important).

### 2. JSONB vs Normalized Tables for Elements

**Decision:** Store all elements as a JSONB array in the `drawings` table.

**Why:** Elements are always loaded and saved as a complete set. The system never queries "find all rectangles across all drawings" -- it always operates on one drawing's element set. JSONB enables single read/write for the entire canvas state, no JOIN overhead, and flexible element schemas (freehand has `points`, text has `fontSize`).

**Trade-off:** Cannot efficiently query individual elements across drawings. JSONB updates require rewriting the entire column (PostgreSQL TOAST handles large payloads, but write amplification grows linearly with element count). For very large drawings (10K+ elements), the JSONB payload exceeds 1MB, increasing network and parsing overhead. At that scale, a normalized `elements` table with individual rows and `jsonb_set()` updates would be more efficient, but adds JOIN complexity for every drawing load.

### 3. Debounced Auto-Save vs Event-Sourced Persistence

**Decision:** Debounced save (2-second idle timer) writing the full element array to PostgreSQL.

**Why:** Event sourcing (persisting every individual operation) provides perfect auditability and undo but requires reconstructing state from the operation log on load. A whiteboard with freehand drawing generates ~60 points/second per user. With 50 concurrent users, that is 3,000 operations/second -- the operation log grows at ~260M operations/day per active drawing. Replaying this log on drawing load would take seconds.

**Trade-off:** Up to 2 seconds of work can be lost if the server crashes between the last save and the crash. This is acceptable because the drawing was live in WebSocket memory and each participant's local state survives reconnection. On reconnect, the client's local state is merged with the server's last-saved state via the CRDT merge, recovering any operations the server missed.

## Consistency and Idempotency

### Idempotent Drawing Operations

Every shape operation carries a client-generated element ID and a monotonically increasing version number. These serve as a natural idempotency key. If a WebSocket message is retried due to a transient network failure, the CRDT merge logic ensures processing the same operation twice produces the same result. An add for an existing element ID is treated as an update; an update with a version equal to or lower than the existing element is silently discarded. Duplicate deliveries never create phantom shapes.

For REST API mutations (creating a drawing, adding a collaborator), database constraints enforce idempotency. The `UNIQUE(drawing_id, user_id)` constraint on `drawing_collaborators` prevents duplicate collaborator entries on retry.

### CRDT Convergence Guarantees

The shape-level LWW register guarantees convergence across all participants. The merge function's three properties (commutativity, associativity, idempotency) ensure that even when network delays cause operations to arrive out of order or be delivered more than once, all clients converge to the same element state once all messages are processed.

Soft deletes are essential to convergence. If a delete physically removed an element, a concurrent update with a lower version arriving after the delete would re-insert it, violating the user's intent. By marking elements as `isDeleted: true` with an incremented version, the delete participates in LWW comparison. A concurrent update with a higher version intentionally "wins" the delete, which is the correct behavior when the updater has not yet seen the delete.

### Reconnection and State Reconciliation

WebSocket transport provides at-most-once delivery. The system achieves effective exactly-once semantics through idempotent CRDT merge on the receiving side. On reconnection, the client compares its local element versions against the server's authoritative state. Elements where the server has a higher version are updated locally; local elements with higher versions are re-sent to the server. This reconciliation closes gaps without requiring message acknowledgment tracking or sequence numbers.

## Security & Auth

- **Session-based authentication** using Redis-backed express-session
- **CORS** restricted to frontend origin
- **Rate limiting** using Redis sliding window (separate limits for auth and drawing operations)
- **Access control**: Drawings are private by default; only owner and explicit collaborators (view/edit permission) can access
- **WebSocket auth**: Relies on the session cookie set during HTTP login. In production, WebSocket connections should validate a short-lived token issued during the HTTP handshake.

## Observability

### Prometheus Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `excalidraw_http_request_duration_seconds` | Histogram | HTTP request latency by method/route/status |
| `excalidraw_http_requests_total` | Counter | Total HTTP requests by method/route/status |
| `excalidraw_ws_connections_active` | Gauge | Active WebSocket connections |
| `excalidraw_ws_messages_total` | Counter | WebSocket messages by type |
| `excalidraw_drawings_created_total` | Counter | Drawings created |
| `excalidraw_active_sessions` | Gauge | Active user sessions |
| `excalidraw_auth_attempts_total` | Counter | Auth attempts by result |
| `excalidraw_circuit_breaker_state` | Gauge | Circuit breaker states |

### Structured Logging

Pino JSON logger with request tracing (`x-trace-id` header), user context, and query timing.

## Failure Handling

- **Circuit breaker** (Opossum) wrapping database operations -- opens after 50% error rate, resets after 30s. Prevents cascade failures when PostgreSQL is slow or unreachable.
- **WebSocket reconnection** with exponential backoff (client-side, up to 5 attempts). On reconnection, the client receives the full room state and merges it with local state via CRDT.
- **Debounced persistence** ensures drawing state survives short server restarts. The last saved state is always in PostgreSQL; in-memory state is reconstructed from the database on room re-creation.
- **Graceful shutdown**: SIGTERM/SIGINT handlers flush all in-memory room state to PostgreSQL before exit. This minimizes data loss on planned deployments.
- **Empty room cleanup**: When the last user leaves a room, in-memory elements are flushed to PostgreSQL and the room is removed from memory to prevent memory leaks.

## Scalability Considerations

### Horizontal Scaling Path

1. **WebSocket Fan-out**: Add Redis Pub/Sub so shape operations broadcast across all WebSocket server instances. Each server subscribes to channels for its active drawings.
2. **Drawing Sharding**: Partition the `drawings` table by `drawing_id` hash across database shards. Since drawings are independent entities, no cross-shard queries are needed.
3. **Read Replicas**: Route read-only drawing loads (gallery, public drawings) to PostgreSQL replicas. WebSocket rooms always read from the primary to ensure consistency.
4. **CDN for Static Assets**: Serve the frontend bundle and any exported images via CDN.
5. **CRDT Library Upgrade**: Replace LWW with Yjs or Automerge for character-level text merging. Text elements currently lose concurrent edits; a full CRDT handles this correctly.

### Bottleneck Analysis

| Component | Bottleneck | Mitigation |
|-----------|-----------|------------|
| WebSocket server | Memory per connection (~50KB) | Horizontal scaling with Redis Pub/Sub fan-out |
| PostgreSQL JSONB writes | Write amplification on large drawings | Element-level `jsonb_set()` or normalized table |
| Redis cursor presence | High write rate (60 updates/sec/user) | Throttle to 10 updates/sec client-side |
| Canvas rendering | CPU-bound for 10K+ elements | Web Workers for off-screen rendering, WebGL for 50K+ |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Conflict resolution | Shape-level LWW | Full CRDT (Yjs) | Simpler, sufficient for shape editing |
| Element storage | JSONB column | Normalized elements table | Single read/write, flexible schema |
| Real-time transport | WebSocket | SSE / Long polling | Bidirectional, low latency |
| Persistence strategy | Debounced save (2s) | Event sourcing | Lower write amplification, simpler recovery |
| Cursor presence | Redis hash + WS broadcast | Redis Pub/Sub only | WS for real-time speed, Redis for join-time state |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Canvas rendering | Canvas 2D API | WebGL | Simpler API, sufficient for ~5K elements at 60fps |
| Cursor rendering | DOM overlay (SVG) | Canvas-drawn cursors | Avoids full canvas redraws on cursor movement |

## Implementation Notes

### Local Architecture

```
┌─────────────────────────────┐
│   React SPA (Vite :5173)    │
│   Canvas + Toolbar + Stores │
├────────────┬────────────────┤
│  REST API  │   WebSocket    │
└─────┬──────┴───────┬────────┘
      │              │
      ▼              ▼
┌─────────────────────────────┐
│   Express + WS Server       │
│   :3001 (dev)               │
│   ┌──────────┐ ┌──────────┐ │
│   │ REST API │ │ WS Rooms │ │
│   │ Routes   │ │ CRDT     │ │
│   │          │ │ Merge    │ │
│   └──────────┘ └──────────┘ │
└──────┬──────────────┬───────┘
       │              │
  ┌────▼────┐   ┌─────▼─────┐
  │Postgres │   │  Valkey   │
  │ :5432   │   │  :6379    │
  │Drawings │   │  Sessions │
  │Elements │   │  Cursors  │
  │Users    │   │  Rate     │
  └─────────┘   │  Limits   │
                └───────────┘
```

Both infrastructure services run via Docker Compose (`docker-compose.yml`). The Express + WebSocket server runs natively with `tsx watch` for hot reload. A single server process handles both HTTP REST and WebSocket upgrade on the same port.

### Production-Grade Patterns Implemented

1. **CRDT Merge Engine** (`src/services/crdtService.ts`): Shape-level Last-Writer-Wins merge with version counters and timestamp tie-breaking. Supports add, update, delete (soft), and move operations. ~125 lines of pure logic with no external dependencies.

2. **WebSocket Room Management** (`src/websocket/handler.ts`): In-memory `Map<drawingId, Set<ClientInfo>>` for room membership. Handles join/leave, operation broadcasting (excluding the sender), and room cleanup when the last user disconnects. Flushes in-memory state to PostgreSQL on room teardown.

3. **Debounced Auto-Save** (`src/websocket/handler.ts`): 2-second idle timer per drawing. Collapses rapid operations into a single PostgreSQL write. Timers are cleaned up on room close.

4. **Cursor Presence** (`src/services/presenceService.ts`): Redis HSET with 30-second TTL per drawing. Cursor updates flow via WebSocket for real-time speed; Redis provides persistence for join-time state.

5. **Prometheus Metrics** (`src/services/metrics.ts`): HTTP request duration histograms, WebSocket connection gauges, message counters by type, drawing creation counters, auth attempt counters, circuit breaker state gauges.

6. **Circuit Breaker** (`src/services/circuitBreaker.ts`): Opossum-based breaker for database operations with 50% error threshold, 30s reset timeout, and 10s call timeout.

7. **Structured Logging** (`src/services/logger.ts`): Pino JSON logger with request tracing and user context.

8. **Rate Limiting** (`src/services/rateLimiter.ts`): Redis-backed sliding window for authentication and drawing operations.

### Simplifications

| Production Feature | Local Substitute | Why |
|--------------------|-----------------|-----|
| Redis Pub/Sub cross-server fan-out | In-memory room broadcast | Single server, no cross-server messaging needed |
| Distributed room state (Redis Streams) | In-memory `Map<drawingId, CrdtElement[]>` | Single server, all collaborators on same process |
| OAuth / JWT for WebSocket auth | Session cookie from HTTP login | Simpler, sufficient for learning |
| Element-level `jsonb_set()` updates | Full JSONB column rewrite | Acceptable for < 1K elements per drawing |
| Multiple WebSocket server instances | Single Express + WS process | No horizontal scaling needed locally |
| CDN for frontend bundle | Vite dev server | No global distribution needed |
| WebGL rendering | Canvas 2D API | Sufficient for < 5K elements |

### Omitted

- CDN for frontend bundle and exported images
- Multi-region deployment with conflict resolution across regions
- Kubernetes orchestration with auto-scaling WebSocket pods
- Yjs/Automerge for character-level text CRDT
- Server-side canvas rendering for PNG/SVG export (node-canvas or Puppeteer)
- Undo/redo via operation stack
- Offline mode with local-first sync
- Copy/paste and group selection
- WebGL renderer for large drawings (50K+ elements)

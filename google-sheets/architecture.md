# Google Sheets - Architecture

## System Overview

A collaborative spreadsheet application with real-time multi-user editing, formula support, and Excel-like interactions. The system supports virtualized rendering of large grids, per-cell conflict resolution, cursor/selection sharing across collaborators, and undo/redo with operation history.

**Learning goals:** Real-time collaboration via WebSocket, sparse data storage for spreadsheets, grid virtualization with TanStack Virtual, last-write-wins conflict resolution, formula dependency tracking, and production-grade observability patterns.

## Requirements

### Functional Requirements
- Create, open, and edit spreadsheets with multiple sheets (tabs)
- Real-time collaboration: multiple users editing simultaneously with visible cursors
- Formula calculation with dependency tracking (SUM, AVG, IF, etc.)
- Cell formatting (bold, italic, colors, alignment, font size)
- Copy/paste with clipboard integration
- Undo/redo with per-sheet operation history
- Column/row resizing with custom dimensions
- Keyboard navigation (arrows, Tab, Enter, Escape)
- CSV export

### Non-Functional Requirements (Production Scale)
- Support 100M total spreadsheets with 10M DAU
- 10,000+ rows/columns per sheet via virtualization
- Sub-100ms latency for local cell edits (optimistic updates)
- p99 < 200ms for cell edit persistence and broadcast
- Support 50 concurrent collaborators per spreadsheet
- 99.99% uptime for the collaboration service
- Conflict resolution for concurrent edits to the same cell

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| Total spreadsheets | 100M | Accumulated across all users |
| DAU | 10M | Active editors/viewers |
| Concurrent editors (peak) | 2M | 20% of DAU editing simultaneously |
| Cell edits/sec (peak) | 500K | 2M editors x ~15 edits/min / 60 |
| WebSocket connections | 2M | One per active editor |
| Cells stored (total) | 50B | 100M sheets x avg 500 non-empty cells |
| Storage per cell | ~200 bytes | raw_value + computed_value + format JSON |
| Total cell storage | ~10 TB | 50B cells x 200 bytes |

### Storage Breakdown

| Data | Size | Notes |
|------|------|-------|
| Cell data | ~10 TB | Sparse storage, only non-empty cells |
| Edit history | ~5 TB | Forward + inverse operations, pruned after 30 days |
| Spreadsheet metadata | ~50 GB | Titles, sheet config, column/row dimensions |
| User data | ~10 GB | Names, colors, session info |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Clients                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                       │
│  │   Browser 1  │  │   Browser 2  │  │   Browser 3  │                       │
│  │ (User Alice) │  │  (User Bob)  │  │ (User Carol) │                       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                       │
│         │    WebSocket    │    WebSocket    │                                 │
│         └────────┬────────┴────────┬────────┘                                │
└──────────────────┼─────────────────┼─────────────────────────────────────────┘
                   │                 │
                   ▼                 ▼
          ┌──────────────────────────────────┐
          │         API Gateway / LB         │
          └──────────┬───────────────────────┘
                     │
     ┌───────────────┼───────────────────────────────┐
     │               │                               │
     ▼               ▼                               ▼
┌──────────┐  ┌──────────────┐              ┌──────────────┐
│ REST API │  │  WebSocket   │              │   Formula    │
│ Service  │  │  Gateway     │              │  Calculation │
│ (CRUD)   │  │  (Collab Hub)│              │  Service     │
└────┬─────┘  └──────┬───────┘              └──────┬───────┘
     │               │                             │
     │         ┌─────┴──────┐                      │
     │         │ Redis      │                      │
     │         │ Pub/Sub    │◀─────────────────────┘
     │         │ + Cache    │
     │         └────────────┘
     │               │
     ▼               ▼
┌────────────────────────┐
│      PostgreSQL        │
│  (Cells, Sheets,       │
│   History, Users)      │
└────────────────────────┘
```

## Core Components

### WebSocket Collaboration Hub

The WebSocket server is the heart of real-time collaboration. Each client connects with a `spreadsheetId` and receives a user identity (ID, name, color). The server manages:

1. **Room-based grouping** -- Clients editing the same spreadsheet join a room. Messages are broadcast only to room members.
2. **Message routing** -- Incoming messages are dispatched by type: `CELL_EDIT`, `CURSOR_MOVE`, `SELECTION_CHANGE`, `RESIZE_COLUMN`, `RESIZE_ROW`, `RENAME_SHEET`.
3. **Heartbeat detection** -- 30-second ping/pong cycle detects stale connections. If a client misses a pong, the connection is terminated and cleanup runs (user left broadcast, room removal, collaborator record deletion).
4. **Initial state sync** -- On connect, the server sends the full sheet state (all cells, column widths, row heights, active collaborators) so the new client starts with a consistent view.

At production scale, the WebSocket Gateway is a dedicated service tier that handles connection management and fan-out. Redis pub/sub connects multiple gateway instances so a cell edit on one server reaches collaborators connected to different servers. The gateway is stateless except for the WebSocket connections themselves, enabling horizontal scaling.

### Sparse Cell Storage

The core insight for spreadsheet storage is that most cells are empty. A sheet with 10,000 rows and 100 columns has 1M cell positions, but typically only a few thousand contain data. The database stores only non-empty cells with `(sheet_id, row_index, col_index)` as the unique key.

This sparse representation means:
- A 1M-position sheet with 1,000 non-empty cells stores 1,000 rows, not 1M
- UPSERT (`ON CONFLICT ... DO UPDATE`) handles both creation and modification with a single statement
- Deleting a cell's content removes the row entirely

### Last-Write-Wins Conflict Resolution

When two users edit the same cell simultaneously, the last write persists. This is a deliberate simplicity trade-off:

- **Why not OT (Operational Transformation)?** OT is the correct solution for text documents where character-level merging matters (Google Docs). For spreadsheets, each cell is an atomic unit -- there's no meaningful way to "merge" two different values for the same cell. Either Alice's value or Bob's value wins.
- **Why not CRDTs?** CRDTs add significant complexity (vector clocks, merge functions) and are overkill when the conflict unit is a single cell value. The probability of two users editing the exact same cell at the exact same moment is low in practice.
- **What users see:** Both users see the final value within one WebSocket round-trip (~50ms). If Alice types "100" and Bob types "200" at the same time, they both converge on whichever write arrived last. The visual feedback is near-instant, so users naturally coordinate by watching each other's cursors.

### Formula Calculation Engine

Formulas (cells starting with `=`) are parsed and evaluated with dependency tracking:

1. **Parsing** -- Extract cell references from the formula string (e.g., `=SUM(A1:A10)` references cells A1 through A10)
2. **Dependency graph** -- Build a DAG of cell dependencies. When cell A1 changes, all cells that reference A1 are recalculated.
3. **Topological evaluation** -- Process the dependency graph in topological order to ensure dependent cells are evaluated after their dependencies.
4. **Circular reference detection** -- Detect cycles in the dependency graph and display an error instead of infinite looping.

At production scale, the formula engine runs as a separate service to avoid blocking the WebSocket event loop. Heavy calculations (large range operations across thousands of cells) are offloaded to worker threads or a dedicated computation cluster.

### Virtualized Grid Rendering

The frontend uses `@tanstack/react-virtual` for both row and column virtualization:

- Only cells visible in the viewport (plus a small overscan buffer) are rendered as DOM nodes
- A grid of 10,000 rows x 100 columns renders ~50-100 DOM nodes instead of 1M
- Custom row heights and column widths are supported via sparse storage of non-default dimensions
- Scroll performance remains smooth because virtualization replaces DOM creation with offset calculation

### Undo/Redo System

The `edit_history` table stores forward and inverse operations for every cell edit:

- **Forward operation**: `{type: "SET_CELL", row: 5, col: 3, value: "new"}` -- what was done
- **Inverse operation**: `{type: "SET_CELL", row: 5, col: 3, value: "old"}` -- how to undo it

Undo applies the inverse operation; redo re-applies the forward operation. Operations are stored per-sheet and ordered by timestamp, giving each user a linear undo stack. At production scale, edit history is pruned after 30 days to control storage growth.

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT 'Anonymous',
    color VARCHAR(7) NOT NULL DEFAULT '#4ECDC4',
    created_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_id);

CREATE TABLE IF NOT EXISTS spreadsheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL DEFAULT 'Untitled Spreadsheet',
    owner_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spreadsheet_id UUID REFERENCES spreadsheets(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL DEFAULT 'Sheet1',
    sheet_index INTEGER NOT NULL DEFAULT 0,
    frozen_rows INTEGER DEFAULT 0,
    frozen_cols INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sheets_spreadsheet ON sheets(spreadsheet_id);

CREATE TABLE IF NOT EXISTS cells (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    col_index INTEGER NOT NULL,
    raw_value TEXT,
    computed_value TEXT,
    format JSONB DEFAULT '{}',
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    UNIQUE(sheet_id, row_index, col_index)
);

CREATE INDEX IF NOT EXISTS idx_cells_sheet ON cells(sheet_id);
CREATE INDEX IF NOT EXISTS idx_cells_position ON cells(sheet_id, row_index, col_index);

CREATE TABLE IF NOT EXISTS column_widths (
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    col_index INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 100,
    PRIMARY KEY (sheet_id, col_index)
);

CREATE TABLE IF NOT EXISTS row_heights (
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    height INTEGER NOT NULL DEFAULT 32,
    PRIMARY KEY (sheet_id, row_index)
);

CREATE TABLE IF NOT EXISTS collaborators (
    spreadsheet_id UUID REFERENCES spreadsheets(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    cursor_row INTEGER,
    cursor_col INTEGER,
    selection_start_row INTEGER,
    selection_start_col INTEGER,
    selection_end_row INTEGER,
    selection_end_col INTEGER,
    joined_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (spreadsheet_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_collaborators_spreadsheet ON collaborators(spreadsheet_id);

CREATE TABLE IF NOT EXISTS edit_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    operation_type VARCHAR(50) NOT NULL,
    operation_data JSONB NOT NULL,
    inverse_data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edit_history_sheet ON edit_history(sheet_id, created_at DESC);
```

Key schema design decisions:

- **Sparse cell storage** with `UNIQUE(sheet_id, row_index, col_index)` enables UPSERT operations -- a cell edit either inserts a new row or updates the existing one. Empty cells are never stored.
- **JSONB format column** on cells stores flexible styling without schema changes. Adding a new formatting option (e.g., strikethrough) requires no migration.
- **Separate dimension tables** (`column_widths`, `row_heights`) use the same sparse pattern -- only non-default dimensions are stored. Default is 100px width and 32px height.
- **Composite primary keys** on `column_widths`, `row_heights`, and `collaborators` naturally prevent duplicates without additional unique constraints.
- **CASCADE deletes** propagate through the hierarchy: deleting a spreadsheet removes all sheets, which removes all cells, dimensions, and history.
- **Soft user references** -- Spreadsheets and edit history use nullable user references so data persists when a user is deleted.
- **`idx_cells_position`** composite index supports viewport-scoped queries (loading only cells within the visible range).

## API Design

### Spreadsheets
```
GET    /api/spreadsheets              → List all spreadsheets (sorted by updated_at)
POST   /api/spreadsheets              → Create spreadsheet (auto-creates Sheet1)
GET    /api/spreadsheets/:id          → Get spreadsheet with sheets
PATCH  /api/spreadsheets/:id          → Update title
DELETE /api/spreadsheets/:id          → Delete spreadsheet (cascades)
GET    /api/spreadsheets/:id/export   → Export sheet to CSV
```

### Sheets
```
POST   /api/spreadsheets/:id/sheets   → Add sheet (auto-assigns next index)
```

### Cells
```
GET    /api/sheets/:sheetId/cells     → Get all cells (sparse map, "row-col" keys)
PATCH  /api/sheets/:sheetId/cells     → Batch update cells (transactional)
```

### WebSocket Protocol
```
ws://host/ws?spreadsheetId=xxx&sessionId=xxx&name=Alice

Client → Server:
  CELL_EDIT        → {sheetId, row, col, value}
  CURSOR_MOVE      → {sheetId, row, col}
  SELECTION_CHANGE → {sheetId, startRow, startCol, endRow, endCol}
  RESIZE_COLUMN    → {sheetId, colIndex, width}
  RESIZE_ROW       → {sheetId, rowIndex, height}
  RENAME_SHEET     → {sheetId, name}

Server → Client:
  INITIAL_STATE    → {cells, sheets, collaborators, dimensions}
  CELL_UPDATED     → {sheetId, row, col, value, userId}
  CURSOR_MOVED     → {userId, row, col, userName, userColor}
  SELECTION_CHANGED → {userId, range}
  USER_JOINED      → {userId, userName, userColor}
  USER_LEFT        → {userId}
  ERROR            → {message}
```

## Key Design Decisions

### WebSocket vs SSE for Real-Time Collaboration

We chose native WebSocket over SSE because spreadsheet collaboration is inherently bidirectional at high frequency. Users send cell edits, cursor moves, and selection changes continuously -- these are not REST-style request/response interactions. SSE would require a parallel REST channel for client-to-server messages, doubling the connection overhead and complicating message ordering. WebSocket gives us a single bidirectional channel with lower per-message overhead (2-byte frame header vs HTTP headers on every POST).

The trade-off is that WebSocket connections require sticky sessions or shared state at the load balancer level, and reconnection logic must be implemented manually (unlike SSE's built-in `EventSource` reconnection). We handle this with a 30-second heartbeat and full state sync on reconnect.

### Last-Write-Wins vs OT/CRDT

For cell-level edits, last-write-wins is the right choice. OT (Operational Transformation) is designed for character-level text editing where two users typing in the same paragraph need their keystrokes merged. In a spreadsheet, the atomic unit is a cell value, not a character. If Alice sets cell A1 to "100" and Bob sets A1 to "200", there's no meaningful merge -- one value must win. Last-write-wins provides this with zero coordination overhead.

The trade-off: if we later add rich text editing within cells (like Google Sheets' in-cell formatting), we would need OT or CRDTs for that specific feature. For pure value/formula editing, last-write-wins is sufficient and dramatically simpler.

### Sparse Storage vs Dense Grid

Storing only non-empty cells reduces storage by 99%+ for typical spreadsheets. A sheet with 10,000 rows and 100 columns (1M positions) typically has 1,000-5,000 non-empty cells. The trade-off is that queries like "get all cells in rows 100-200" require an index scan rather than a simple offset calculation. The composite index `(sheet_id, row_index, col_index)` makes this scan efficient enough for real-time use.

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time transport | WebSocket | SSE + REST | Bidirectional, lower overhead for high-frequency edits |
| Conflict resolution | Last-write-wins | OT/CRDT | Cell is atomic unit; merge has no semantic meaning |
| Cell storage | Sparse (only non-empty) | Dense (all positions) | 99%+ storage reduction |
| Grid rendering | TanStack Virtual | Full DOM rendering | 10K+ rows with smooth scroll |
| State management | Zustand | Redux / Context | Minimal boilerplate, selector optimization |
| Formula evaluation | Server-side | Client-side | Consistent results, dependency tracking at scale |

## Consistency and Idempotency

- **Cell edits** use `ON CONFLICT (sheet_id, row_index, col_index) DO UPDATE` -- the same edit applied twice produces the same result (idempotent UPSERT)
- **Idempotency keys** in Redis prevent duplicate processing of retried WebSocket messages. The client generates a unique request ID per operation; the server checks Redis before processing. Results are cached for 24 hours. See `src/shared/idempotency.ts`.
- **Edit history** entries use UUID primary keys -- replaying the same operation does not create duplicate history records
- **Collaborator presence** uses UPSERT on `(spreadsheet_id, user_id)` -- reconnecting updates the existing record rather than creating duplicates
- **Batch cell updates** use database transactions -- either all changes commit or none do, preventing partial updates

## Security and Auth

- Session-based authentication via cookie with session ID
- No password required (anonymous collaboration with display names)
- CORS restricted to frontend origin
- WebSocket connections validated on handshake (spreadsheetId required)
- At production scale: OAuth2 for user identity, per-spreadsheet ACLs (owner, editor, viewer, commenter), rate limiting on cell edits per user, input sanitization for formula injection

## Observability

- **Prometheus metrics** (prom-client): WebSocket connections gauge, messages received/sent counters with type labels, message processing latency histogram, cell edit counter, formula calculation duration, cache hit/miss counters, database query duration by operation, circuit breaker state gauge, idempotency hit/miss counters, error counter by type and component, database pool size. See `src/shared/metrics.ts`.
- **Structured logging** (Pino): JSON-formatted logs with service name, PID, request context. Child loggers for component-scoped context (WebSocket, API). Pretty-printed in development, machine-readable in production. See `src/shared/logger.ts`.
- **Health check**: `GET /health` checks PostgreSQL and Redis connectivity with latency measurements. Returns detailed status per dependency. See `src/index.ts`.
- **Readiness check**: `GET /ready` for Kubernetes readiness probes -- returns 200 only when both database and Redis are reachable.

## Failure Handling

- **Circuit breakers** (Opossum) wrap Redis pub/sub, database queries, and WebSocket broadcasts. When Redis pub/sub fails, the circuit opens and the system degrades to single-server mode -- cell edits still work locally but are not broadcast to other server instances. See `src/shared/circuitBreaker.ts`.
- **WebSocket heartbeat**: 30-second ping/pong cycle. Stale connections are terminated and cleaned up (collaborator record removed, user-left broadcast sent).
- **Graceful shutdown**: SIGTERM handler stops accepting new connections, closes all WebSocket clients with code 1001, drains the database pool, and disconnects Redis.
- **Cache resilience**: All cache operations fail open -- if Redis is unavailable, the system falls through to PostgreSQL. Cache errors are logged but never surface to the user.
- **Reconnection**: On WebSocket disconnect, the client reconnects and receives a full state sync, ensuring consistency even after extended disconnection.

## Scalability Considerations

**What breaks first at scale:**

1. **WebSocket connections per server** -- Each connection consumes memory for buffers, user state, and room membership. At 50K connections per server (~200MB), a fleet of 40 servers handles 2M concurrent editors. Horizontal scaling requires Redis pub/sub for cross-server broadcast.

2. **Cell edit fan-out** -- A spreadsheet with 50 collaborators requires broadcasting each edit to 49 other connections. For a popular template spreadsheet with 1000 viewers, this fan-out becomes expensive. Solution: dedicated broadcast workers that dequeue edits from Redis and fan out to connected clients, decoupling write latency from fan-out cost.

3. **Formula recalculation cascades** -- Changing a cell that is referenced by 10,000 other cells triggers a cascade of recalculations. Solution: batch formula evaluation with debouncing (aggregate changes over 100ms, then recalculate once), and offload heavy computation to worker threads.

4. **Edit history growth** -- Every cell edit creates a history entry. A heavily edited spreadsheet with 1M edits over its lifetime accumulates significant data. Solution: compact history after 30 days (merge adjacent edits to the same cell), archive old history to cold storage.

**Scaling path:**
- Horizontal WebSocket gateway behind load balancer with sticky sessions
- Redis Cluster for pub/sub fan-out across gateway instances
- Read replicas for spreadsheet list queries and cell loading
- Separate formula computation service with worker pool
- CDN for static assets
- Sharding spreadsheets across database instances by spreadsheet ID

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| WebSocket | Bidirectional, low overhead | SSE + REST | High-frequency cell edits need minimal framing |
| Last-write-wins | Simple, no coordination | OT/CRDT | Cell is atomic; no merge semantics |
| Sparse storage | 99% storage savings | Dense grid storage | Most cells are empty |
| Redis caching | Write-through, 15-30 min TTL | No cache | Reduce DB load for active spreadsheets by 80%+ |
| JSONB for format | Flexible, no migrations | Typed columns | New formatting options without schema changes |
| Edit history | Full forward + inverse ops | Snapshot-based undo | Supports collaborative undo without conflicts |

## Implementation Notes

### Local Setup Diagram

```
┌─────────────────┐         ┌──────────────────────────────────────┐
│   React SPA     │  HTTP   │        Express + WS Server           │
│  localhost:5173  │────────▶│        localhost:3000                │
│  (Vite + TS)    │◀── WS ──│                                      │
│                 │         │  REST: /api/spreadsheets, /api/sheets │
│  Components:    │         │  WS:   /ws (collaboration hub)       │
│  SpreadsheetGrid│         │                                      │
│  (TanStack      │         │  Shared modules:                     │
│   Virtual)      │         │    db, redis, cache, logger,         │
│  FormulaBar     │         │    metrics, circuitBreaker,          │
│  SheetTabs      │         │    idempotency                       │
│  CollabCursors  │         │                                      │
│                 │         │  Endpoints: /health, /ready, /metrics │
│  Store: Zustand │         └──────────┬──────────┬────────────────┘
└─────────────────┘                    │          │
                                ┌──────┴───┐ ┌────┴────┐
                                │PostgreSQL│ │ Valkey  │
                                │  :5432   │ │  :6379  │
                                │  sheets  │ │  cache, │
                                │          │ │ pub/sub,│
                                │          │ │idempot. │
                                └──────────┘ └─────────┘
```

### Production-Grade Patterns Implemented

1. **Redis caching with write-through** -- Spreadsheet metadata cached for 30 minutes, cell data cached for 15 minutes using Redis Hashes for granular per-cell updates. Cache is invalidated on writes and fails open on Redis errors. See `src/shared/cache.ts`.

2. **Idempotency keys** -- Client-generated request IDs are checked against Redis before processing cell edits. Results cached for 24 hours to handle delayed retries. Includes metrics for hit/miss tracking. See `src/shared/idempotency.ts`.

3. **Circuit breakers** (Opossum) -- Three breakers: Redis pub/sub (1s timeout, falls back to single-server mode), database queries (5s timeout), WebSocket broadcast (2s timeout, silent failure with client resync). All emit Prometheus metrics. See `src/shared/circuitBreaker.ts`.

4. **Prometheus metrics** (prom-client) -- 20+ metrics covering WebSocket connections, message latency, cell edits, formula calculations, cache hit rates, database query duration, circuit breaker state, idempotency tracking, and error counts. Exposed at `GET /metrics`. See `src/shared/metrics.ts`.

5. **Structured logging** (Pino) -- JSON logs with service name and component context. Child loggers for WebSocket and API scoping. Pretty-printed in development via pino-pretty. Request logging via pino-http with auto-filtering of health/metrics endpoints. See `src/shared/logger.ts`.

6. **Health and readiness checks** -- `GET /health` checks PostgreSQL and Redis with latency measurements and detailed status per dependency. `GET /ready` for Kubernetes-style readiness probes. Both update Prometheus gauges. See `src/index.ts`.

7. **Graceful shutdown** -- SIGTERM handler closes HTTP server, terminates WebSocket clients with code 1001, drains database pool, and disconnects Redis. See `src/index.ts`.

8. **WebSocket heartbeat** -- 30-second ping/pong cycle detects and terminates stale connections. Cleanup broadcasts user-left events and removes collaborator records. See `src/websocket/index.ts`.

### Simplifications vs Production

| Component | Local Implementation | Production Equivalent |
|-----------|---------------------|----------------------|
| Database | Single PostgreSQL instance | Sharded by spreadsheet_id with read replicas |
| WebSocket | Single server with in-memory rooms | WebSocket gateway fleet with Redis pub/sub fan-out |
| Auth | Session ID cookie, no password | OAuth2 with per-spreadsheet ACLs |
| Formulas | Basic formula handler | Dedicated formula computation service with worker pool |
| Caching | Redis write-through cache | Redis Cluster with tiered caching |
| Conflict resolution | Last-write-wins (per cell) | Same, but with OT for rich text within cells |
| Edit history | Full storage, no pruning | 30-day retention with compaction and archival |
| Export | CSV only | CSV, XLSX, PDF via worker service |

### Omitted from Local Implementation
- CDN for static assets
- Multi-region deployment
- Kubernetes orchestration
- OAuth2 and per-spreadsheet access control
- Rich text editing within cells (would need OT/CRDT)
- Copy/paste across sheets
- Range selection and bulk formatting
- Import from XLSX/CSV
- Version history UI (data stored but no UI)
- Rate limiting
- Distributed tracing (OpenTelemetry)
- Cross-server WebSocket broadcast (single server only)

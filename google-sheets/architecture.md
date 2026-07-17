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

**What is actually implemented (local):** `src/websocket/formula-handler.ts` evaluates a cell value server-side when it starts with `=`. It supports the aggregate functions `SUM`, `AVERAGE`, `COUNT`, `MIN`, `MAX` over **literal comma-separated numeric arguments** (e.g. `=SUM(1,2,3)` → `6`, `=AVERAGE(2,4,6)` → `4`) and simple arithmetic (`=5+3*2` → `11`, evaluated via a `Function()` expression). It returns Excel-style error strings (`#ERROR`, `#DIV/0!`, `#VALUE!`) on failure. This is a **stateless per-value evaluator**: it does **not** resolve cell references (`A1`, `A1:A10`), builds no dependency graph, and does no cascade recalculation — each formula is computed only from the literals inside it.

**Production-ideal (not built here):** a real spreadsheet engine parses cell references, builds a **DAG of cell dependencies**, evaluates in **topological order** so dependents compute after their inputs, and performs **circular-reference detection** to avoid infinite loops. At scale that engine runs as a separate service (off the WebSocket event loop), with heavy range operations offloaded to worker threads. Integrating a library such as HyperFormula would provide this cell-reference + dependency-tracking behavior; the current code is a deliberate demo stand-in.

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

## Frontend Architecture

### Component Hierarchy

```
App (direct rendering, no router)
├── Toolbar
│   ├── Title bar: logo, spreadsheet title (read-only), collaborator avatars, connection indicator
│   └── Formula bar: cell reference (e.g., "A1"), raw value display
│
├── SpreadsheetGrid
│   ├── Column headers (frozen, sticky top)
│   │   └── Letter labels (A, B, ..., Z) via getColumnLetter()
│   ├── Row headers (frozen, sticky left)
│   │   └── Numeric labels (1, 2, ..., 1000)
│   ├── Virtualized cell grid (TanStack Virtual)
│   │   └── Cell (memoized)
│   │       ├── View mode: displays computedValue with formatting
│   │       └── Edit mode: inline <input> with commit/cancel
│   └── CollaboratorCursors (overlay)
│       ├── Cursor outlines (colored borders per collaborator)
│       ├── Name labels (floating above cursor cell)
│       └── Selection overlays (semi-transparent colored regions)
│
└── WebSocket connection lifecycle (managed in useEffect)
```

### Zustand Store

The application uses a single large Zustand store (`useSpreadsheetStore`) that manages all state and WebSocket communication. This is a deliberate design choice for a real-time collaborative app -- splitting into multiple stores would require cross-store synchronization that adds complexity without benefit.

**Connection state**: `spreadsheetId`, `isConnected`, `ws` (the raw WebSocket instance). The `connect` action establishes a WebSocket connection and registers the `handleWebSocketMessage` handler for all incoming events.

**Document state**: `title`, `sheets` (array of sheet tabs), `activeSheetId`. These are populated from the `STATE_SYNC` message received on connect.

**Cell data (sparse map)**: `cells` is a `Map<string, CellData>` keyed by `"row-col"` strings (e.g., `"5-3"` for row 5, column 3). Only non-empty cells exist in the map. `CellData` holds `rawValue` (what the user typed, may be a formula), `computedValue` (evaluated result), and optional `format` (bold, italic, color, etc.). The `setCell` action performs an optimistic local update, then sends a `CELL_EDIT` message to the server.

**Selection state**: `activeCell` (single cell with blue outline), `selection` (CellRange for multi-cell highlight), `isSelecting` (true during mouse drag). Selection is tracked as start/end coordinates that can form rectangles in any direction -- the `isSelected` helper normalizes min/max to check containment.

**Collaborator presence**: `collaborators` is a `Map<string, Collaborator>` mapping user IDs to their name, assigned color, cursor position, and selection range. This is updated by `USER_JOINED`, `USER_LEFT`, `CURSOR_MOVED`, and `SELECTION_CHANGED` WebSocket messages.

**Dimension tracking**: `columnWidths` and `rowHeights` are `Map<number, number>` storing only non-default dimensions (default: 100px width, 32px height). This mirrors the sparse storage pattern from the database.

**Edit mode**: `editingCell` and `editValue` track inline editing. `startEditing` loads the cell's `rawValue` into the edit buffer. `commitEdit` writes it back via `setCell`. `cancelEdit` discards changes.

### Routing

No router is used. The `App` component reads the spreadsheet ID from URL query parameters (`?id=xxx`). If no ID is present, a new UUID is generated and pushed into the URL via `history.replaceState`. The user's name is stored in `localStorage` and prompted for on first visit. This single-page approach works because a spreadsheet application has only one view -- the grid.

### Data Fetching

All data flows through WebSocket, not REST. On mount, the `connect` action establishes a WebSocket connection to `ws://localhost:3001/ws?spreadsheetId=xxx&name=Alice`. The server responds with a `STATE_SYNC` message containing the complete spreadsheet state: all non-empty cells, sheet metadata, column/row dimensions, and active collaborators. From this point forward, all updates are bidirectional via WebSocket messages:

- **Client to server**: `CELL_EDIT`, `CURSOR_MOVE`, `SELECTION_CHANGE`, `RESIZE_COLUMN`, `RESIZE_ROW`, `RENAME_SHEET`
- **Server to client**: `STATE_SYNC`, `CELL_UPDATED`, `CURSOR_MOVED`, `SELECTION_CHANGED`, `USER_JOINED`, `USER_LEFT`, `COLUMN_RESIZED`, `ROW_RESIZED`

Cell edits use **optimistic updates**: the local `cells` map is updated immediately before the WebSocket message is sent. If the server confirms a different computed value (e.g., formula evaluation), the `CELL_UPDATED` message overwrites the local value. This provides instant visual feedback for the editing user while maintaining consistency.

### Key UI Patterns

**Virtualized grid (TanStack Virtual)**: The grid uses two virtualizers -- one for rows (vertical) and one for columns (horizontal). With `MAX_ROWS = 1000` and `MAX_COLS = 26`, only the cells visible in the viewport (plus an overscan buffer of 10 rows and 5 columns) are rendered as DOM nodes. A full grid would create 26,000 DOM elements; virtualization renders ~200. Each virtualized item provides `start` (pixel offset) and `size` (dimension), which are applied as absolute positioning styles on each `Cell` component.

**Frozen headers**: Column headers (A, B, C...) use `position: sticky; top: 0` to remain visible during vertical scrolling. Row headers (1, 2, 3...) use `position: sticky; left: 0` for horizontal scrolling. The top-left corner cell is doubly sticky (`z-index: 30`) to stay fixed in both directions.

**Cell memoization**: The `Cell` component is wrapped in `React.memo` with a custom comparator that checks only `rowIndex` and `colIndex`. Cell data is read from the Zustand store via selectors inside the component, so the memo prevents re-renders when unrelated cells change. This is critical for performance -- without memoization, editing one cell would trigger re-renders of all ~200 visible cells.

**Inline cell editing**: Double-clicking a cell enters edit mode, rendering an `<input>` element inside the cell. The input auto-focuses and selects all text. Enter commits the edit and moves down. Tab commits and moves right. Escape cancels. Typing any printable character on a non-editing active cell starts editing with that character as the initial value, matching Google Sheets behavior.

**Keyboard navigation**: Arrow keys move the active cell. Enter toggles between edit mode and navigation. Tab moves right (Shift+Tab moves left). These are handled by a global `keydown` listener that checks whether the user is currently typing in an input.

**Collaborator cursor overlays**: The `CollaboratorCursors` component renders absolutely-positioned elements over the grid showing each remote collaborator's cursor (colored border) and name label (colored badge above the cell). Selection ranges are shown as semi-transparent colored overlays. Position calculation sums row heights and column widths up to the target cell, accounting for any custom dimensions.

**Column letter conversion**: The `getColumnLetter` function converts 0-based indices to spreadsheet column letters (0 -> A, 25 -> Z, 26 -> AA, 27 -> AB). It uses a modular arithmetic approach that handles multi-letter columns naturally.

## Production-Grade Pattern Deep Dives

This section explains each production-grade pattern referenced in the architecture, written for readers encountering these concepts for the first time.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. If the data is in the cache (a "hit"), it is returned immediately. If not (a "miss"), the application queries the database, stores the result in the cache with a TTL (time-to-live), and returns it.

**How it works step by step**: (1) Application receives a request for data. (2) Check Redis: `GET cache:key`. (3) If found, return the cached value -- this is typically 10-50x faster than a database query. (4) If not found, query PostgreSQL. (5) Store the result in Redis: `SET cache:key value EX 300` (5-minute TTL). (6) Return the result.

**Cache invalidation**: When data changes (cell edited), the application deletes or updates the relevant cache keys. The TTL provides a safety net -- even if invalidation is missed, the cache self-corrects within the TTL window.

**Write-through variant in this project**: This project uses write-through caching for cells -- when a cell is edited, the cache is updated at the same time as the database write. This ensures all subsequent reads from any server instance see the latest value without waiting for cache expiry. The write-through pattern trades slightly higher write latency (one extra Redis call per write) for perfectly fresh reads. See `src/shared/cache.ts`.

**Why it matters for spreadsheets**: Active spreadsheets are read far more than they are written. A spreadsheet with 50 collaborators generates 50 reads per cell update (each collaborator's initial state sync). Without caching, every collaborator joining would query PostgreSQL for all cells. With caching, only the first join hits the database; subsequent joins read from Redis.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. In the context of API design, an idempotent endpoint can safely handle duplicate requests -- if a network timeout causes the client to retry, the server does not process the operation twice.

**How idempotency keys work**: The client generates a unique key (typically a UUID) for each operation and sends it with the request. The server checks Redis for this key before processing: (1) If found, return the cached result from the first execution. (2) If not found, process the request, store the result in Redis with a 24-hour TTL, and return it.

**How it works in this project**: Cell edits sent via WebSocket include a client-generated request ID. The server checks `idempotency:{key}` in Redis before processing. If the key exists, the cached result is returned without re-applying the edit. If not, the edit is processed, and the result is stored. This prevents duplicate cell updates from WebSocket reconnection retries. See `src/shared/idempotency.ts`.

**Why this matters for spreadsheets**: Consider a user editing cell A1 to "100". The WebSocket message is sent, but the connection drops before the acknowledgment arrives. The client reconnects and retries. Without idempotency, the edit history would record two entries for the same change, corrupting the undo stack. With idempotency, the retry returns the cached result and no duplicate history entry is created.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing downstream service. It works like an electrical circuit breaker: when failures exceed a threshold, the "circuit opens" and subsequent calls fail immediately without attempting the request. After a cooldown period, the circuit allows one test request through ("half-open"). If it succeeds, the circuit closes. If it fails, the circuit reopens.

**The three states**:
1. **Closed** (normal): Requests pass through. Failures are counted. If failures exceed the threshold (e.g., 50% of the last 5 requests), the circuit opens.
2. **Open** (failing): All requests are immediately rejected or routed to a fallback function. No calls are made to the downstream service. This prevents wasting time and resources on calls that will fail.
3. **Half-open** (testing): After the reset timeout (e.g., 30 seconds), one request is allowed through. If it succeeds, the circuit closes and normal operation resumes. If it fails, the circuit reopens for another timeout period.

**How it works in this project**: Three circuit breakers protect different dependencies: Redis pub/sub (1-second timeout, falls back to single-server mode), database queries (5-second timeout), and WebSocket broadcast (2-second timeout, silent failure with client resync). When Redis pub/sub fails, cell edits still work locally but are not broadcast to other server instances. State changes are tracked via Prometheus gauges and logged via Pino. See `src/shared/circuitBreaker.ts`.

**Why this matters for spreadsheets**: A spreadsheet collaboration server depends on Redis for pub/sub (broadcasting edits to all servers) and PostgreSQL for persistence. If Redis goes down, without a circuit breaker, every cell edit would wait for the Redis timeout before failing. With 50 concurrent editors making rapid edits, this creates a backlog of stalled requests that can crash the server. The circuit breaker detects the failure after a few requests and immediately starts using the fallback (local-only broadcast), keeping the application responsive.

### Structured Logging

Structured logging means emitting log entries as machine-readable JSON objects instead of free-form text strings. Instead of `"User Alice edited cell A1"`, the log entry is `{"level":"info","service":"sheets","userId":"abc-123","action":"cell_edit","row":0,"col":0,"value":"100","timestamp":"2026-03-18T10:00:00Z"}`.

**Why JSON instead of text**: Free-form text logs require complex regex patterns to search and analyze. JSON logs can be indexed by any field in a log aggregation system (Elasticsearch, Datadog, CloudWatch). Finding all slow database queries becomes a filter query instead of a grep command. This is the difference between spending 30 minutes investigating an issue and getting an answer in seconds.

**How Pino works**: Pino is a high-performance Node.js logging library that outputs JSON by default. It supports log levels (trace, debug, info, warn, error, fatal), child loggers (adding persistent context fields like `service: "sheets"` or `component: "websocket"`), and pretty-printing for local development via `pino-pretty`. Request logging is handled by `pino-http`, which automatically logs request method, URL, status code, and response time -- with auto-filtering of noisy health check and metrics endpoints. See `src/shared/logger.ts`.

**Why it matters at scale**: When multiple WebSocket gateway instances are running and a user reports "my cell edit disappeared," you need to trace that specific edit across all instances. Structured logs with a spreadsheet ID and user ID let you filter to the exact event flow. With text logs, this investigation requires reading thousands of lines; with structured logs, it is a 5-second query.

### Prometheus Metrics

Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose metrics at a `/metrics` HTTP endpoint in a specific text format. A Prometheus server scrapes this endpoint every 15-30 seconds and stores the time-series data for querying and alerting.

**Three metric types that matter**:
- **Counter**: A number that only goes up. Example: `sheets_cell_edits_total`. You query the *rate* of change to get "cell edits per second."
- **Gauge**: A number that goes up and down. Example: `sheets_websocket_connections`. Shows current state.
- **Histogram**: Tracks the distribution of values in configurable buckets. Example: `sheets_message_processing_seconds` with buckets at 0.001, 0.005, 0.01, 0.05, 0.1 seconds. Lets you compute percentiles (p50, p95, p99) to understand latency distribution.

**How it works in this project**: The backend defines 20+ metrics covering WebSocket connections, message latency, cell edit throughput, formula calculation duration, cache hit rates, database query latency, circuit breaker state, idempotency tracking, and error counts. These are registered with `prom-client` and exposed at `GET /metrics`. Express middleware automatically tracks HTTP request counts and duration. See `src/shared/metrics.ts`.

**Why it matters for spreadsheets**: The architecture targets p99 < 200ms for cell edit persistence and broadcast. Without metrics, you have no way to know whether you are meeting this target. A histogram on message processing time gives you exact p99 values, and you can set alerts when p99 exceeds 200ms for 5 consecutive minutes. The WebSocket connection gauge tells you how many users are currently connected, which directly correlates with memory usage and fan-out cost.

### Health Checks

A health check is an HTTP endpoint that reports whether the service is alive and capable of handling requests. Load balancers, container orchestrators (Kubernetes), and monitoring systems poll this endpoint at regular intervals. If the health check fails, the infrastructure stops routing traffic to that instance and may restart it.

**Two levels of health checks**:
- **Liveness** (`GET /health`): "Is the process running?" Returns HTTP 200 if the server can respond at all. Used to detect crashed or frozen processes.
- **Readiness** (`GET /ready`): "Can this instance handle requests?" Checks downstream dependencies (PostgreSQL connectivity, Redis connectivity) with latency measurements. Returns HTTP 200 only when both are reachable. Used by Kubernetes to determine when a newly started instance is ready to receive traffic, and to stop routing traffic to an instance whose database connection died.

**How it works in this project**: `GET /health` returns basic service status. `GET /ready` actively tests PostgreSQL and Redis connectivity with `SELECT 1` and `PING` commands, measures their latency, and returns a detailed JSON response with per-dependency status. Both endpoints update Prometheus gauges so health state is visible in dashboards. See `src/index.ts`.

**Why it matters for real-time collaboration**: A WebSocket server with a broken database connection would accept new collaborator connections but fail to load or persist any cell data. Without readiness checks, the load balancer would happily route users to this broken instance. With readiness checks, the instance is removed from rotation within one health check interval, and users are routed to healthy instances.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without it, a single misbehaving client (or an attacker) can overwhelm the server with requests, degrading performance for everyone.

**How it works**: The server tracks request counts per client (usually identified by user ID or IP address). When a request arrives, the server checks whether the client has exceeded their allowance. If they have, the server returns HTTP 429 (Too Many Requests) with a `Retry-After` header. If not, the request proceeds and the counter increments.

**Common implementations**: Fixed window (count requests in the current minute, reset at the boundary), sliding window (count requests in the last 60 seconds), and token bucket (accumulate tokens at a fixed rate, each request consumes one). Redis is typically used to store counters because it is fast and shared across all server instances.

**Why it matters for spreadsheets**: A malicious client could send thousands of `CELL_EDIT` WebSocket messages per second, triggering database writes, cache updates, formula recalculations, and broadcast fan-out for each one. Rate limiting cell edits to a reasonable rate (e.g., 60 per minute per user) prevents this abuse while being invisible to normal users who edit one cell at a time.

### RBAC (Role-Based Access Control)

RBAC is a method of restricting system access based on the roles assigned to users, rather than checking permissions for each user individually. Instead of maintaining a per-user permission list, you define roles ("owner", "editor", "viewer", "commenter") with associated permissions, and assign users to roles for each resource.

**How it works**: Each resource (e.g., a spreadsheet) has an access control list mapping users to roles. When a user requests an action (e.g., "edit cell in Spreadsheet X"), the system looks up their role for that resource and checks whether the role permits the action. An "owner" can do everything including sharing and deleting. An "editor" can modify cells but cannot delete the spreadsheet. A "viewer" can only read. A "commenter" can read and add comments but not modify cells.

**Why this matters for spreadsheets**: Google Sheets supports sharing documents with different permission levels. Without RBAC, each API endpoint would need custom permission-checking logic. RBAC centralizes this: a single middleware looks up the user's role for the requested spreadsheet and allows or denies based on a role-to-permissions mapping. This is mentioned in the architecture as a production-scale feature -- the local implementation uses simple session-based access where any authenticated user can edit any spreadsheet.

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

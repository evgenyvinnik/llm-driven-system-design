# Google Sheets - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
1. **Spreadsheet Management**: Create, open, edit, and delete spreadsheets with multiple sheets
2. **Real-time Collaboration**: Multiple users editing simultaneously with live cursor visibility
3. **Formula Support**: Excel-compatible formulas with dependency tracking (SUM, VLOOKUP, IF)
4. **Cell Formatting**: Bold, colors, alignment, number formats
5. **Grid Operations**: Resize columns/rows, undo/redo

### Non-Functional Requirements
- **Scale**: Support 10,000+ rows/columns per sheet via virtualization
- **Latency**: Sub-100ms for local edits, <200ms for broadcast to collaborators
- **Consistency**: Last-write-wins per cell with server as source of truth
- **Availability**: Graceful degradation (read-only mode if database unavailable)

### Out of Scope
- Charts and visualizations
- Import/export Excel files
- Mobile native apps
- Comments and suggestions

---

## 2. Full-Stack Architecture Overview (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     React + TypeScript + Vite                    │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │    │
│  │  │ TanStack    │  │   Zustand    │  │   WebSocket Client   │   │    │
│  │  │ Virtual     │  │   Store      │  │                      │   │    │
│  │  │ (Grid)      │  │              │  │                      │   │    │
│  │  └─────────────┘  └──────────────┘  └──────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                  │                                        │
│                    REST (CRUD)   │   WebSocket (real-time)               │
│                                  │                                        │
├──────────────────────────────────┼────────────────────────────────────────┤
│                              Backend                                      │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     Node.js + Express + ws                       │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │    │
│  │  │ REST API    │  │  WebSocket   │  │   HyperFormula       │   │    │
│  │  │ Routes      │  │  Server      │  │   (Formula Engine)   │   │    │
│  │  └─────────────┘  └──────────────┘  └──────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                  │                                        │
├──────────────────────────────────┼────────────────────────────────────────┤
│                           Data Layer                                      │
│  ┌──────────────────┐  ┌──────────────────────────────────────────┐    │
│  │   PostgreSQL     │  │              Redis/Valkey                 │    │
│  │  - Spreadsheets  │  │  - Session storage                       │    │
│  │  - Sheets        │  │  - Cell cache                            │    │
│  │  - Cells (sparse)│  │  - Pub/Sub (multi-server sync)           │    │
│  │  - Edit history  │  │  - Idempotency keys                      │    │
│  └──────────────────┘  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Layer | Component | Responsibility |
|-------|-----------|----------------|
| **Frontend** | TanStack Virtual | Render only visible cells (virtualization) |
| **Frontend** | Zustand Store | Sparse cell data, selection, collaborators |
| **Frontend** | WebSocket Client | Real-time sync, reconnection logic |
| **Backend** | REST API | CRUD operations, initial data load |
| **Backend** | WebSocket Server | Broadcast edits, presence management |
| **Backend** | HyperFormula | Server-side formula calculation |
| **Data** | PostgreSQL | Durable storage, edit history |
| **Data** | Redis | Cache, pub/sub, sessions |

---

## 3. Deep Dive: Data Model and TypeScript Interfaces (7 minutes)

### Shared TypeScript Types

"I'm defining shared types in a common directory that both frontend and backend import. This ensures type safety across the wire."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     CORE ENTITY TYPES                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  Spreadsheet: { id, title, ownerId, createdAt, updatedAt }              │
│                                                                          │
│  Sheet: { id, spreadsheetId, name, sheetIndex, frozenRows, frozenCols } │
│                                                                          │
│  CellData: { rawValue: string|null, computedValue: any,                 │
│              format?: CellFormat, error?: string }                       │
│                                                                          │
│  CellFormat: { bold?, italic?, color?, backgroundColor?,                │
│                textAlign?: 'left'|'center'|'right',                      │
│                fontSize?, numberFormat? }                                │
├─────────────────────────────────────────────────────────────────────────┤
│  Collaborator: { userId, name, color, cursorRow, cursorCol,             │
│                  selectionRange: CellRange|null }                        │
│                                                                          │
│  CellRange: { startRow, startCol, endRow, endCol }                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### WebSocket Message Types

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     CLIENT ──▶ SERVER MESSAGES                           │
├─────────────────────────────────────────────────────────────────────────┤
│  CELL_EDIT:        { sheetId, row, col, value, requestId? }             │
│  CURSOR_MOVE:      { sheetId, row, col }                                │
│  SELECTION_CHANGE: { sheetId, range: CellRange }                        │
│  UNDO:             { sheetId }                                           │
│  REDO:             { sheetId }                                           │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     SERVER ──▶ CLIENT MESSAGES                           │
├─────────────────────────────────────────────────────────────────────────┤
│  CELL_UPDATED:  { sheetId, row, col, value, computedValue, userId }     │
│  CURSOR_MOVED:  { userId, name, color, row, col }                       │
│  USER_JOINED:   { userId, name, color }                                 │
│  USER_LEFT:     { userId }                                               │
│  STATE_SYNC:    { cells: [{row, col, data}], collaborators: [] }        │
└─────────────────────────────────────────────────────────────────────────┘
```

### PostgreSQL Schema

"I use sparse cell storage - only non-empty cells are stored. This provides massive storage efficiency since most cells are empty."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     CELLS TABLE (Sparse Storage)                         │
├─────────────────────────────────────────────────────────────────────────┤
│  id:             UUID PRIMARY KEY                                        │
│  sheet_id:       UUID REFERENCES sheets(id) ON DELETE CASCADE           │
│  row_index:      INTEGER NOT NULL                                        │
│  col_index:      INTEGER NOT NULL                                        │
│  raw_value:      TEXT                                                    │
│  computed_value: TEXT                                                    │
│  format:         JSONB DEFAULT '{}'                                      │
│  updated_at:     TIMESTAMP DEFAULT NOW()                                 │
│  updated_by:     UUID REFERENCES users(id)                               │
│                                                                          │
│  UNIQUE(sheet_id, row_index, col_index)  ← Enables UPSERT               │
├─────────────────────────────────────────────────────────────────────────┤
│  INDEXES:                                                                │
│    - idx_cells_sheet (sheet_id)                                          │
│    - idx_cells_position (sheet_id, row_index, col_index)                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Database Service Layer

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     CELL SERVICE FUNCTIONS                               │
├─────────────────────────────────────────────────────────────────────────┤
│  getCellsBySheet(sheetId) ──▶ Map<string, CellData>                     │
│    1. SELECT row_index, col_index, raw_value, computed_value, format    │
│       FROM cells WHERE sheet_id = $1                                     │
│    2. Build Map with key = "{row}-{col}"                                 │
│    3. Return cells Map                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  upsertCell(sheetId, row, col, rawValue, computedValue, userId)         │
│    IF rawValue is null or empty:                                        │
│      ──▶ DELETE FROM cells WHERE sheet_id=$1 AND row=$2 AND col=$3      │
│    ELSE:                                                                 │
│      ──▶ INSERT INTO cells (...) VALUES (...)                            │
│          ON CONFLICT (sheet_id, row_index, col_index)                   │
│          DO UPDATE SET raw_value=$4, computed_value=$5, updated_at=NOW()│
├─────────────────────────────────────────────────────────────────────────┤
│  getCellsInViewport(sheetId, startRow, endRow, startCol, endCol)        │
│    ──▶ SELECT ... WHERE sheet_id=$1                                      │
│          AND row_index BETWEEN $2 AND $3                                 │
│          AND col_index BETWEEN $4 AND $5                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dive: WebSocket Real-time Sync (8 minutes)

### Server-Side WebSocket Handler

"I'm using the native ws library with Redis pub/sub for multi-server synchronization."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     WEBSOCKET SERVER SETUP                               │
├─────────────────────────────────────────────────────────────────────────┤
│  Data Structures:                                                        │
│    - rooms: Map<spreadsheetId, Set<ConnectedClient>>                    │
│    - ConnectedClient: { ws, userId, userName, userColor, spreadsheetId }│
│                                                                          │
│  Redis Subscriber:                                                       │
│    ──▶ Subscribe to 'spreadsheet:updates' channel                        │
│    ──▶ On message: broadcastToRoom(spreadsheetId, message, null)        │
│                                                                          │
│  On Connection:                                                          │
│    1. Parse spreadsheetId and token from query params                   │
│    2. Authenticate user (close with 4001 if unauthorized)               │
│    3. Create ConnectedClient, add to room                               │
│    4. Broadcast USER_JOINED to others                                   │
│    5. Send STATE_SYNC with current cells and collaborators              │
│    6. Set up message handler                                             │
│                                                                          │
│  On Close:                                                               │
│    ──▶ Remove from room, broadcast USER_LEFT                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Message Handler Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     CELL_EDIT MESSAGE HANDLING                           │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Check idempotency                                                    │
│     ──▶ IF requestId exists AND cached result found: return cached      │
│                                                                          │
│  2. Calculate formula if needed                                          │
│     ──▶ IF value.startsWith('='): computed = formulaEngine.calculate()  │
│     ──▶ ELSE: computed = value                                           │
│                                                                          │
│  3. Persist to database                                                  │
│     ──▶ upsertCell(sheetId, row, col, value, computed, userId)          │
│                                                                          │
│  4. Prepare broadcast message                                            │
│     ──▶ { type: 'CELL_UPDATED', sheetId, row, col, value,               │
│           computedValue, userId }                                        │
│                                                                          │
│  5. Store idempotency result                                             │
│     ──▶ IF requestId: setIdempotencyResult(requestId, response)         │
│                                                                          │
│  6. Broadcast to room                                                    │
│     ──▶ broadcastToRoom(spreadsheetId, response, null)                  │
│                                                                          │
│  7. Publish to Redis for other servers                                   │
│     ──▶ redis.publish('spreadsheet:updates', { spreadsheetId, message })│
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     CURSOR_MOVE MESSAGE HANDLING                         │
├─────────────────────────────────────────────────────────────────────────┤
│  ──▶ broadcastToRoom(spreadsheetId, {                                    │
│        type: 'CURSOR_MOVED', userId, name, color, row, col              │
│      }, excludeSender)                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Client-Side WebSocket Hook

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     useWebSocket HOOK                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  Props: spreadsheetId                                                    │
│  Refs:  wsRef, reconnectTimeoutRef                                       │
│                                                                          │
│  connect():                                                              │
│    1. Get token from sessionStorage                                      │
│    2. Create WebSocket with spreadsheetId and token in query            │
│    3. onopen: store ws in ref                                           │
│    4. onmessage: dispatch to store actions based on message.type        │
│       - CELL_UPDATED  ──▶ applyRemoteCellUpdate(row, col, value, computed)
│       - CURSOR_MOVED  ──▶ updateCollaborator(userId, name, color, pos)  │
│       - USER_JOINED   ──▶ updateCollaborator(userId, name, color)       │
│       - USER_LEFT     ──▶ removeCollaborator(userId)                    │
│       - STATE_SYNC    ──▶ syncState(cells, collaborators)               │
│    5. onclose: schedule reconnect with 2s delay                         │
│    6. onerror: log and close                                            │
│                                                                          │
│  useEffect: connect on mount, cleanup on unmount                        │
│                                                                          │
│  sendMessage(message): send if ws.readyState === OPEN                   │
│                                                                          │
│  Returns: { sendMessage }                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: Frontend Virtualization (6 minutes)

### Virtualized Grid Component

"I use TanStack Virtual for both row and column virtualization. This lets us handle 1 million rows without performance issues."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SPREADSHEET GRID COMPONENT                           │
├─────────────────────────────────────────────────────────────────────────┤
│  Constants:                                                              │
│    MAX_ROWS = 1,000,000                                                  │
│    MAX_COLS = 16,384                                                     │
│    DEFAULT_ROW_HEIGHT = 32                                               │
│    DEFAULT_COL_WIDTH = 100                                               │
│                                                                          │
│  Row Virtualizer:                                                        │
│    useVirtualizer({                                                      │
│      count: MAX_ROWS,                                                    │
│      getScrollElement: () => containerRef.current,                       │
│      estimateSize: (index) => rowHeights.get(index) ?? DEFAULT_HEIGHT,  │
│      overscan: 10                                                        │
│    })                                                                    │
│                                                                          │
│  Column Virtualizer:                                                     │
│    useVirtualizer({                                                      │
│      horizontal: true,                                                   │
│      count: MAX_COLS,                                                    │
│      getScrollElement: () => containerRef.current,                       │
│      estimateSize: (index) => columnWidths.get(index) ?? DEFAULT_WIDTH, │
│      overscan: 5                                                         │
│    })                                                                    │
│                                                                          │
│  Grid Content (memoized):                                                │
│    visibleRows.flatMap(virtualRow =>                                    │
│      visibleCols.map(virtualCol =>                                      │
│        <Cell row={virtualRow.index} col={virtualCol.index}              │
│              style={{ position: 'absolute',                              │
│                      top: virtualRow.start, left: virtualCol.start,     │
│                      height: virtualRow.size, width: virtualCol.size }} │
│        />                                                                │
│      )                                                                   │
│    )                                                                     │
│                                                                          │
│  Render:                                                                 │
│    <div ref={containerRef} overflow="auto">                             │
│      <div style={{ height: rowVirtualizer.getTotalSize(),              │
│                    width: colVirtualizer.getTotalSize() }}>             │
│        {gridContent}                                                     │
│        <CollaboratorCursors />                                          │
│      </div>                                                              │
│    </div>                                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Zustand Store Integration

"I'm using Zustand with a Map for sparse cell storage. Each cell subscribes only to its own data using selectors."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SPREADSHEET STORE                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  State:                                                                  │
│    - spreadsheetId: string                                               │
│    - activeSheetId: string                                               │
│    - cells: Map<string, CellData>         ← Key: "{row}-{col}"          │
│    - activeCell: { row, col } | null                                    │
│    - isEditing: boolean                                                  │
│    - editValue: string                                                   │
│    - columnWidths: Map<number, number>    ← Sparse (non-default only)   │
│    - rowHeights: Map<number, number>                                     │
│    - collaborators: Map<string, Collaborator>                           │
├─────────────────────────────────────────────────────────────────────────┤
│  Actions:                                                                │
│                                                                          │
│  setCell(row, col, value):                                               │
│    - Create new Map from cells                                           │
│    - IF value empty: delete key                                          │
│    - ELSE: set { rawValue, computedValue }                               │
│    - Return { cells: newCells }                                          │
│                                                                          │
│  applyRemoteCellUpdate(row, col, rawValue, computedValue):              │
│    - Same as setCell but with computed value from server                │
│                                                                          │
│  syncState(cellArray, collaboratorArray):                               │
│    - Build cells Map from array of { row, col, data }                   │
│    - Build collaborators Map from array                                 │
│    - Set both in state                                                   │
│                                                                          │
│  updateCollaborator(collaborator):                                       │
│    - Create new Map, set collaborator by userId                         │
│                                                                          │
│  removeCollaborator(userId):                                             │
│    - Create new Map, delete userId                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: REST API Endpoints (5 minutes)

### API Route Definitions

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     REST API ENDPOINTS                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  GET /spreadsheets                                                       │
│    ──▶ List user's spreadsheets (ordered by updated_at DESC)            │
│    ──▶ Returns: [{ id, title, created_at, updated_at }]                 │
├─────────────────────────────────────────────────────────────────────────┤
│  POST /spreadsheets                                                      │
│    Body: { title?: string }                                              │
│    ──▶ Create spreadsheet with one default sheet ("Sheet1")             │
│    ──▶ Uses CTE: WITH new_spreadsheet, new_sheet                        │
│    ──▶ Returns: { id, title, sheets: [{ id, name, sheetIndex }] }       │
├─────────────────────────────────────────────────────────────────────────┤
│  GET /spreadsheets/:id                                                   │
│    ──▶ Get spreadsheet with all sheets                                   │
│    ──▶ Uses json_agg to return sheets as array                          │
│    ──▶ Returns: { id, title, sheets: [...] }                            │
├─────────────────────────────────────────────────────────────────────────┤
│  GET /sheets/:sheetId/cells                                              │
│    Query: ?startRow=&endRow=&startCol=&endCol= (optional viewport)      │
│    ──▶ IF viewport params: getCellsInViewport(...)                      │
│    ──▶ ELSE: getCellsBySheet(...)                                        │
│    ──▶ Convert Map to array: [{ row, col, data }]                       │
│    ──▶ Returns: { cells: [...] }                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend API Service

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     API SERVICE                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  fetchWithAuth(url, options):                                            │
│    - Get token from sessionStorage                                       │
│    - Add Content-Type: application/json                                  │
│    - Add Authorization: Bearer {token}                                   │
│    - Throw on non-ok response                                            │
│    - Return response.json()                                              │
├─────────────────────────────────────────────────────────────────────────┤
│  api.spreadsheets:                                                       │
│    - list()    ──▶ GET /spreadsheets                                    │
│    - create(title?) ──▶ POST /spreadsheets                              │
│    - get(id)   ──▶ GET /spreadsheets/{id}                               │
├─────────────────────────────────────────────────────────────────────────┤
│  api.sheets:                                                             │
│    - getCells(sheetId, viewport?)                                        │
│        ──▶ GET /sheets/{sheetId}/cells                                  │
│        ──▶ IF viewport: append ?startRow=&endRow=&startCol=&endCol=     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Trade-offs Summary (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **Conflict Resolution** | Last-write-wins | OT/CRDT | Much simpler, good enough for cell-level edits |
| **Cell Storage** | Sparse (Map) | Dense 2D array | 1000x storage efficiency for large sheets |
| **Formula Engine** | HyperFormula (both ends) | Server-only | Client-side for responsiveness, server for authority |
| **Real-time Protocol** | WebSocket | SSE | Bidirectional needed for edits and cursors |
| **Multi-server Sync** | Redis Pub/Sub | Kafka | Lower latency, simpler for this use case |
| **Virtualization** | TanStack Virtual | react-window | Better variable-size support, modern API |
| **State Management** | Zustand | Redux | Less boilerplate, built-in selectors |

### Full-Stack Integration Points

1. **Shared Types**: TypeScript interfaces in `/shared/types.ts` ensure type safety across frontend and backend
2. **WebSocket Protocol**: Strongly-typed messages prevent serialization errors
3. **Sparse Storage Pattern**: Both frontend Map and backend PostgreSQL use sparse cell storage
4. **Formula Sync**: HyperFormula runs on both ends - client for immediate feedback, server for authoritative results

---

## 8. Caching and Performance (3 minutes)

### Redis Caching Layer

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     CELL CACHE FUNCTIONS                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  CACHE_TTL = 1800 (30 minutes)                                          │
│  Key pattern: "sheet:{sheetId}:cells" (Hash)                            │
├─────────────────────────────────────────────────────────────────────────┤
│  getCachedCells(sheetId) ──▶ Map<string, CellData> | null               │
│    ──▶ HGETALL sheet:{sheetId}:cells                                    │
│    ──▶ IF empty: return null                                            │
│    ──▶ Parse JSON values, build Map                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  setCachedCell(sheetId, row, col, data):                                │
│    ──▶ HSET sheet:{sheetId}:cells "{row}-{col}" {JSON.stringify(data)} │
│    ──▶ EXPIRE sheet:{sheetId}:cells CACHE_TTL                           │
├─────────────────────────────────────────────────────────────────────────┤
│  invalidateCellCache(sheetId, row, col):                                │
│    ──▶ HDEL sheet:{sheetId}:cells "{row}-{col}"                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend Optimizations

1. **Memoized Cells**: React.memo with custom comparator
2. **Fine-grained Selectors**: Each cell subscribes only to its data
3. **Debounced Network**: Batch edits before sending
4. **Web Workers**: Formula calculation off main thread

---

## 9. Future Enhancements

### Backend
1. **Undo/Redo API**: Edit history with forward/inverse operations
2. **Batch Operations**: Handle large pastes efficiently
3. **Cross-sheet References**: Support `=Sheet2!A1` formulas

### Frontend
1. **Range Selection**: Drag to select multiple cells
2. **Copy/Paste**: Clipboard API with Excel-compatible formats
3. **Conditional Formatting**: Style cells based on values

### Full-Stack
1. **Offline Support**: Service Worker + IndexedDB with sync on reconnect
2. **Conflict Visualization**: Show when edits are overwritten
3. **Version History**: Time travel to previous states

---

## 10. Closing Summary (1 minute)

"We designed a collaborative spreadsheet with:
- **Shared TypeScript types** ensuring type safety across the full stack
- **WebSocket real-time sync** with Redis pub/sub for multi-server support
- **Sparse storage pattern** on both frontend (Zustand Map) and backend (PostgreSQL UPSERT)
- **Virtualized grid** using TanStack Virtual for million-row performance
- **HyperFormula integration** on both client (immediate) and server (authoritative)

Key full-stack insight: The sparse data model flows seamlessly from database (only non-empty rows) through API (cell arrays) to frontend (Map), enabling consistent behavior and efficient memory usage at every layer."

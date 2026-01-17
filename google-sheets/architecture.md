# Google Sheets - Architecture

A collaborative spreadsheet application with real-time multi-user editing, formula support, and Excel-like interactions.

## System Overview

### Core Requirements

**Functional:**
- Create, open, and edit spreadsheets
- Real-time collaboration (multiple users editing simultaneously)
- Formula calculation with dependency tracking
- Cell formatting (bold, colors, alignment)
- Copy/paste with clipboard integration
- Undo/redo with history management
- Column/row resizing
- Keyboard navigation (arrows, Tab, Enter)

**Non-Functional:**
- Support 10,000+ rows/columns via virtualization
- Sub-100ms latency for local edits
- Conflict resolution for concurrent edits
- Offline support with sync on reconnect

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Clients                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Browser 1  │  │   Browser 2  │  │   Browser 3  │              │
│  │ (User Alice) │  │  (User Bob)  │  │ (User Carol) │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                 │                        │
│         │    WebSocket    │    WebSocket    │                        │
│         └────────┬────────┴────────┬────────┘                        │
│                  │                 │                                 │
│                  ▼                 ▼                                 │
│         ┌────────────────────────────────────┐                      │
│         │        WebSocket Server            │                      │
│         │   (Real-time Collaboration Hub)    │                      │
│         └────────────────┬───────────────────┘                      │
│                          │                                           │
│         ┌────────────────┴───────────────────┐                      │
│         ▼                                    ▼                      │
│  ┌──────────────┐                   ┌──────────────┐               │
│  │  REST API    │                   │    Redis     │               │
│  │  (CRUD ops)  │                   │  (Pub/Sub +  │               │
│  │              │                   │   Sessions)  │               │
│  └──────┬───────┘                   └──────────────┘               │
│         │                                                           │
│         ▼                                                           │
│  ┌──────────────┐                                                   │
│  │  PostgreSQL  │                                                   │
│  │ (Persistence)│                                                   │
│  └──────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Model

### PostgreSQL Schema

```sql
-- Spreadsheets (documents)
CREATE TABLE spreadsheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL DEFAULT 'Untitled Spreadsheet',
    owner_id UUID NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sheets within a spreadsheet
CREATE TABLE sheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spreadsheet_id UUID REFERENCES spreadsheets(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL DEFAULT 'Sheet1',
    index INTEGER NOT NULL DEFAULT 0,
    frozen_rows INTEGER DEFAULT 0,
    frozen_cols INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Cell data (sparse storage - only non-empty cells)
CREATE TABLE cells (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    col_index INTEGER NOT NULL,
    raw_value TEXT,           -- User input (formula or value)
    computed_value TEXT,      -- Calculated result
    format JSONB,             -- {bold, italic, color, bgColor, align, fontSize}
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(sheet_id, row_index, col_index)
);

-- Column/row dimensions
CREATE TABLE column_widths (
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    col_index INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 100,
    PRIMARY KEY (sheet_id, col_index)
);

CREATE TABLE row_heights (
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    height INTEGER NOT NULL DEFAULT 32,
    PRIMARY KEY (sheet_id, row_index)
);

-- Active collaborators
CREATE TABLE collaborators (
    spreadsheet_id UUID REFERENCES spreadsheets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    session_id VARCHAR(100) NOT NULL,
    cursor_row INTEGER,
    cursor_col INTEGER,
    color VARCHAR(7),         -- User color for presence
    joined_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (spreadsheet_id, session_id)
);

-- Edit history for undo/redo
CREATE TABLE edit_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    operation_type VARCHAR(50) NOT NULL, -- SET_CELL, DELETE_CELL, RESIZE, etc.
    operation_data JSONB NOT NULL,
    inverse_data JSONB NOT NULL,         -- For undo
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_cells_sheet ON cells(sheet_id);
CREATE INDEX idx_cells_position ON cells(sheet_id, row_index, col_index);
CREATE INDEX idx_collaborators_spreadsheet ON collaborators(spreadsheet_id);
CREATE INDEX idx_edit_history_sheet ON edit_history(sheet_id, created_at DESC);
```

### Cell Data Structure

```typescript
interface CellData {
  rawValue: string | null;      // User input
  computedValue: any;           // Calculated result
  formula?: string;             // If starts with '='
  format?: CellFormat;
  error?: string;               // Formula error
}

interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  backgroundColor?: string;
  textAlign?: 'left' | 'center' | 'right';
  fontSize?: number;
  numberFormat?: string;        // Currency, percentage, date
}
```

## Real-Time Collaboration

### WebSocket Protocol

#### Connection Flow

```
1. Client connects: ws://server/ws?spreadsheetId=xxx&token=yyy
2. Server authenticates token
3. Server adds client to spreadsheet room
4. Server broadcasts user presence to room
5. Server sends current state to new client
```

#### Message Types

**Client → Server:**
```typescript
// Cell edit
{ type: 'CELL_EDIT', sheetId, row, col, value }

// Selection change
{ type: 'SELECTION_CHANGE', sheetId, range: { startRow, startCol, endRow, endCol } }

// Cursor move
{ type: 'CURSOR_MOVE', sheetId, row, col }

// Resize column/row
{ type: 'RESIZE', sheetId, axis: 'row' | 'column', index, size }

// Request undo
{ type: 'UNDO', sheetId }

// Request redo
{ type: 'REDO', sheetId }
```

**Server → Client:**
```typescript
// Cell updated (broadcast)
{ type: 'CELL_UPDATED', sheetId, row, col, value, computedValue, userId }

// User joined
{ type: 'USER_JOINED', userId, name, color }

// User left
{ type: 'USER_LEFT', userId }

// Cursor moved (other user)
{ type: 'CURSOR_MOVED', userId, row, col }

// Selection changed (other user)
{ type: 'SELECTION_CHANGED', userId, range }

// Full state sync (on connect)
{ type: 'STATE_SYNC', cells: Map<string, CellData>, collaborators: User[] }

// Undo/redo result
{ type: 'HISTORY_APPLIED', operation, direction: 'undo' | 'redo' }
```

### Conflict Resolution

Using **Operational Transformation (OT)** simplified approach:

1. **Last-Write-Wins per Cell**: Each cell is an independent unit
2. **Server is Source of Truth**: All edits go through server
3. **Optimistic Updates**: Client applies locally, reverts if server rejects

```typescript
// Client-side optimistic update
function handleCellEdit(row, col, value) {
  // 1. Apply locally immediately
  localState.setCell(row, col, value);

  // 2. Send to server with version
  ws.send({ type: 'CELL_EDIT', row, col, value, version: localVersion });

  // 3. Server broadcasts confirmed change
  // 4. If version conflict, server sends authoritative value
}

// Server-side handling
function handleCellEdit(clientId, edit) {
  const cell = await db.getCell(edit.sheetId, edit.row, edit.col);

  // Simple last-write-wins
  await db.updateCell(edit.sheetId, edit.row, edit.col, edit.value);

  // Recalculate formulas that depend on this cell
  const affectedCells = formulaEngine.recalculate(edit.row, edit.col);

  // Broadcast to all clients in room
  broadcastToRoom(edit.sheetId, {
    type: 'CELL_UPDATED',
    row: edit.row,
    col: edit.col,
    value: edit.value,
    computedValue: cell.computedValue,
    affectedCells,
    userId: clientId
  });
}
```

### Presence Indicators

```typescript
interface Collaborator {
  userId: string;
  name: string;
  color: string;          // Unique color per user
  cursorPosition: { row: number; col: number } | null;
  selection: CellRange | null;
}

// Colors assigned in order
const COLLABORATOR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'
];
```

## Formula Engine

### HyperFormula Integration

```typescript
import { HyperFormula } from 'hyperformula';

class FormulaEngine {
  private hf: HyperFormula;
  private sheetId: number;

  constructor() {
    this.hf = HyperFormula.buildEmpty({
      licenseKey: 'gpl-v3',
      useArrayArithmetic: true,
    });
    this.sheetId = this.hf.addSheet('Sheet1');
  }

  setCellValue(row: number, col: number, value: string): CellResult {
    if (value.startsWith('=')) {
      // Formula
      this.hf.setCellContents({ sheet: this.sheetId, row, col }, value);
    } else {
      // Plain value
      const parsed = this.parseValue(value);
      this.hf.setCellContents({ sheet: this.sheetId, row, col }, [[parsed]]);
    }

    return {
      computedValue: this.hf.getCellValue({ sheet: this.sheetId, row, col }),
      dependents: this.getDependentCells(row, col),
    };
  }

  getDependentCells(row: number, col: number): Array<{row: number, col: number}> {
    // Get cells that depend on this cell and need recalculation
    return this.hf.getCellDependents({ sheet: this.sheetId, row, col })
      .map(addr => ({ row: addr.row, col: addr.col }));
  }

  private parseValue(value: string): any {
    const num = parseFloat(value);
    if (!isNaN(num)) return num;
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    return value;
  }
}
```

### Supported Functions

HyperFormula provides 380+ Excel-compatible functions:

- **Math**: SUM, AVERAGE, MAX, MIN, COUNT, ROUND, ABS, SQRT
- **Text**: CONCAT, LEFT, RIGHT, MID, LEN, TRIM, UPPER, LOWER
- **Logical**: IF, AND, OR, NOT, IFERROR
- **Lookup**: VLOOKUP, HLOOKUP, INDEX, MATCH
- **Date**: TODAY, NOW, DATE, YEAR, MONTH, DAY
- **Statistical**: MEDIAN, STDEV, VAR, CORREL

## Frontend Architecture

### Component Hierarchy

```
<SpreadsheetApp>
├── <Toolbar>
│   ├── <FormatButtons>
│   ├── <FormulaBar>
│   └── <ShareButton>
├── <SheetTabs>
├── <SpreadsheetGrid>
│   ├── <ColumnHeaders> (frozen)
│   ├── <RowHeaders> (frozen)
│   ├── <VirtualizedCells>
│   │   └── <Cell> (memoized)
│   ├── <SelectionOverlay>
│   └── <CollaboratorCursors>
└── <StatusBar>
```

### State Management (Zustand)

```typescript
interface SpreadsheetStore {
  // Document state
  spreadsheetId: string;
  sheets: Sheet[];
  activeSheetId: string;

  // Cell data (sparse map)
  cells: Map<string, CellData>;  // key: "sheetId-row-col"

  // Selection
  activeCell: { row: number; col: number } | null;
  selection: CellRange | null;

  // Collaborators
  collaborators: Map<string, Collaborator>;

  // Dimensions
  columnWidths: Map<number, number>;
  rowHeights: Map<number, number>;

  // History
  undoStack: Operation[];
  redoStack: Operation[];

  // Actions
  setCell: (row: number, col: number, value: string) => void;
  setSelection: (range: CellRange) => void;
  resizeColumn: (col: number, width: number) => void;
  resizeRow: (row: number, height: number) => void;
  undo: () => void;
  redo: () => void;
}
```

### Virtualization Strategy

Using TanStack Virtual for efficient rendering:

```typescript
const rowVirtualizer = useVirtualizer({
  count: MAX_ROWS,              // 1,000,000 rows
  getScrollElement: () => containerRef.current,
  estimateSize: (index) => rowHeights.get(index) ?? 32,
  overscan: 10,                 // Render 10 extra rows
});

const columnVirtualizer = useVirtualizer({
  horizontal: true,
  count: MAX_COLS,              // 16,384 columns (like Excel)
  getScrollElement: () => containerRef.current,
  estimateSize: (index) => columnWidths.get(index) ?? 100,
  overscan: 5,
});
```

## API Design

### REST Endpoints

```
# Spreadsheets
GET    /api/spreadsheets              # List user's spreadsheets
POST   /api/spreadsheets              # Create new spreadsheet
GET    /api/spreadsheets/:id          # Get spreadsheet with sheets
DELETE /api/spreadsheets/:id          # Delete spreadsheet

# Sheets
POST   /api/spreadsheets/:id/sheets   # Add sheet
PATCH  /api/sheets/:sheetId           # Update sheet (rename, reorder)
DELETE /api/sheets/:sheetId           # Delete sheet

# Cells (for initial load and batch operations)
GET    /api/sheets/:sheetId/cells     # Get all cells (with pagination)
PATCH  /api/sheets/:sheetId/cells     # Batch update cells

# Export
GET    /api/spreadsheets/:id/export?format=csv|xlsx
```

### WebSocket Events

See "Real-Time Collaboration" section above.

## Performance Optimizations

### 1. Sparse Cell Storage
Only store non-empty cells in database and state.

### 2. Lazy Loading
Load cell data in viewport chunks, not entire sheet.

### 3. Debounced Saves
Batch cell updates before persisting:

```typescript
const debouncedSave = useDebouncedCallback(
  (changes: CellChange[]) => {
    api.batchUpdateCells(sheetId, changes);
  },
  500 // Save after 500ms of inactivity
);
```

### 4. Web Workers for Formulas
Offload formula calculation to prevent UI blocking:

```typescript
// formula.worker.ts
const hf = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' });

self.onmessage = ({ data }) => {
  if (data.type === 'CALCULATE') {
    hf.setCellContents(data.address, data.value);
    const result = hf.getCellValue(data.address);
    self.postMessage({ type: 'RESULT', address: data.address, value: result });
  }
};
```

### 5. Memoized Cell Rendering

```typescript
const Cell = memo(function Cell({ row, col, data, isSelected, isActive }) {
  // ...
}, (prev, next) => {
  return prev.row === next.row &&
         prev.col === next.col &&
         prev.data === next.data &&
         prev.isSelected === next.isSelected &&
         prev.isActive === next.isActive;
});
```

## Scalability Considerations

### Horizontal Scaling

```
                    Load Balancer
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │ Server1 │    │ Server2 │    │ Server3 │
    └────┬────┘    └────┬────┘    └────┬────┘
         │              │              │
         └──────────────┼──────────────┘
                        ▼
                  ┌───────────┐
                  │   Redis   │  ← Pub/Sub for cross-server sync
                  │  Cluster  │
                  └───────────┘
```

### Redis Pub/Sub for Multi-Server

```typescript
// When edit comes in on Server1
redis.publish(`spreadsheet:${spreadsheetId}`, JSON.stringify({
  type: 'CELL_UPDATED',
  ...editData
}));

// All servers subscribe
redis.subscribe(`spreadsheet:${spreadsheetId}`, (message) => {
  // Broadcast to local WebSocket clients
  wsServer.broadcastToRoom(spreadsheetId, message);
});
```

## Security

### Authentication
- Session-based auth stored in Redis
- WebSocket connection requires valid session token

### Authorization
- Check spreadsheet permissions before allowing edits
- Rate limiting on edit operations

### Data Validation
- Sanitize formula inputs (prevent code injection)
- Validate cell coordinates
- Limit maximum spreadsheet/cell size

## Capacity and SLO Targets

### Local Development Scale

For this learning project running locally with 2-3 service instances:

| Metric | Target | Rationale |
|--------|--------|-----------|
| Concurrent users per spreadsheet | 5-10 | Reasonable for local testing |
| Spreadsheets per instance | 100 | Memory-bound by WebSocket connections |
| Cells per spreadsheet | 100,000 | Sparse storage keeps memory low |
| Max cell value size | 32 KB | Prevent abuse, sufficient for formulas |

### Latency SLOs

| Operation | p50 | p95 | p99 |
|-----------|-----|-----|-----|
| Cell edit (local) | 5ms | 15ms | 30ms |
| Cell edit (broadcast to peers) | 50ms | 100ms | 200ms |
| Formula recalculation (simple) | 10ms | 50ms | 100ms |
| Formula recalculation (complex, 1000 deps) | 100ms | 300ms | 500ms |
| Initial spreadsheet load (10K cells) | 200ms | 500ms | 1s |
| WebSocket reconnect + state sync | 500ms | 1s | 2s |

### Availability Target

- **Target**: 99% uptime for local development (allows for restarts, debugging)
- **Error budget**: ~7 hours/month of downtime acceptable
- **Graceful degradation**: Read-only mode if database unavailable

### Storage Growth Estimates

Assuming active local development usage:

```
Per spreadsheet (avg):
- Metadata: 1 KB
- 1,000 non-empty cells: 100 KB (100 bytes avg per cell with format)
- Edit history (1 week): 500 KB (500 edits x 1KB each)
- Total: ~600 KB per spreadsheet

Per user (avg):
- 20 spreadsheets: 12 MB
- Session data in Redis: 2 KB

Database growth rate:
- 10 active spreadsheets, 100 edits/day: 100 KB/day
- With 90-day history retention: ~9 MB steady state
```

### RPS Estimates (Local)

| Endpoint | Expected RPS | Burst |
|----------|--------------|-------|
| WebSocket messages (all types) | 10-50/s | 200/s |
| REST API (CRUD) | 1-5/s | 20/s |
| Cell batch saves | 1-2/s | 10/s |

## Caching Strategy

### Redis Cache Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     Cache Architecture                       │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Session Cache (Redis)                              │
│  - Key: session:{sessionId}                                  │
│  - TTL: 24 hours (sliding)                                   │
│  - Contains: userId, permissions, lastActive                 │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Active Spreadsheet Cache (Redis)                   │
│  - Key: spreadsheet:{id}:state                               │
│  - TTL: 30 minutes after last access                         │
│  - Contains: metadata, collaborator list, recent edits       │
│  - Write-through: updates go to cache + DB simultaneously    │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Cell Data Cache (In-Memory per Server)             │
│  - LRU cache with 1000 cell limit per spreadsheet            │
│  - TTL: 5 minutes                                            │
│  - Invalidated on any edit to that cell                      │
│  - Populated on viewport scroll                              │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Formula Dependency Graph (In-Memory)               │
│  - Built per sheet on first formula evaluation               │
│  - Invalidated when cells with formulas change               │
│  - No TTL (lives until server restart or sheet unload)       │
└─────────────────────────────────────────────────────────────┘
```

### Cache Operations

```typescript
// Session cache - cache-aside pattern
async function getSession(sessionId: string): Promise<Session | null> {
  const cached = await redis.get(`session:${sessionId}`);
  if (cached) {
    await redis.expire(`session:${sessionId}`, 86400); // Extend TTL
    return JSON.parse(cached);
  }
  return null;
}

// Spreadsheet state - write-through pattern
async function updateCell(spreadsheetId: string, cell: CellUpdate): Promise<void> {
  // Write to both cache and DB
  await Promise.all([
    redis.hset(`spreadsheet:${spreadsheetId}:cells`, `${cell.row}:${cell.col}`, JSON.stringify(cell)),
    db.query('INSERT INTO cells ... ON CONFLICT DO UPDATE ...', [cell])
  ]);

  // Invalidate in-memory caches on other servers via pub/sub
  await redis.publish(`invalidate:${spreadsheetId}`, JSON.stringify({ row: cell.row, col: cell.col }));
}
```

### Cache Invalidation Rules

| Event | Invalidation Action |
|-------|---------------------|
| Cell edit | Invalidate cell cache + dependent formula caches |
| User joins spreadsheet | Refresh collaborator list cache |
| User leaves/disconnects | Update collaborator cache after 30s grace period |
| Spreadsheet deleted | Delete all related Redis keys |
| Server restart | Cold start, caches rebuild on demand |

### Cache Hit Rate Targets

| Cache Layer | Target Hit Rate | Action if Below |
|-------------|-----------------|-----------------|
| Session cache | 99% | Check session TTL, verify login flow |
| Spreadsheet metadata | 95% | Increase cache TTL |
| Cell data (viewport) | 80% | Increase overscan in virtualizer |
| Formula results | 70% | Acceptable due to frequent edits |

## Observability

### Metrics (Prometheus)

```typescript
// Key metrics to expose on /metrics endpoint
const metrics = {
  // WebSocket
  ws_connections_active: Gauge,           // Current WebSocket connections
  ws_messages_received_total: Counter,    // Messages by type
  ws_messages_sent_total: Counter,
  ws_message_latency_ms: Histogram,       // Broadcast latency

  // Spreadsheet operations
  cell_edits_total: Counter,              // By spreadsheet (sampled)
  formula_calculations_total: Counter,
  formula_calculation_duration_ms: Histogram,

  // Cache
  cache_hits_total: Counter,              // By cache layer
  cache_misses_total: Counter,

  // Database
  db_query_duration_ms: Histogram,        // By query type
  db_pool_connections_active: Gauge,
  db_pool_connections_waiting: Gauge,

  // Error tracking
  errors_total: Counter,                  // By error type and endpoint
};
```

### Logging Strategy

```typescript
// Structured logging with pino
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// Log levels by operation type
// ERROR: Database failures, WebSocket errors, formula crashes
// WARN: Cache misses on hot paths, slow queries (>100ms), reconnection failures
// INFO: User join/leave, spreadsheet create/delete, export requests
// DEBUG: Individual cell edits (sampled 1%), cache operations
```

### Key Log Events

```typescript
// User actions (INFO)
logger.info({ userId, spreadsheetId, action: 'join' }, 'User joined spreadsheet');
logger.info({ userId, spreadsheetId, action: 'leave', duration: sessionMs }, 'User left spreadsheet');

// Performance warnings (WARN)
logger.warn({ spreadsheetId, cellCount, durationMs }, 'Slow initial load');
logger.warn({ query, durationMs }, 'Slow database query');

// Errors (ERROR)
logger.error({ err, spreadsheetId, userId }, 'WebSocket broadcast failed');
logger.error({ err, formula, cellRef }, 'Formula evaluation error');
```

### Health Checks

```typescript
// GET /health - for load balancer
app.get('/health', async (req, res) => {
  const checks = {
    database: await checkDatabase(),    // Simple SELECT 1
    redis: await checkRedis(),          // PING
    wsServer: wsServer.clients.size,    // WebSocket connections
  };

  const healthy = checks.database && checks.redis;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    checks,
    uptime: process.uptime(),
  });
});

// GET /ready - for traffic routing
app.get('/ready', async (req, res) => {
  // Ready only after initial DB connection and cache warmup
  res.status(isReady ? 200 : 503).json({ ready: isReady });
});
```

### Alerting Thresholds (Local Development)

| Metric | Warning | Critical |
|--------|---------|----------|
| WebSocket latency p95 | >200ms | >500ms |
| Database query p95 | >100ms | >500ms |
| Cache hit rate | <70% | <50% |
| Active connections | >50 | >100 |
| Error rate | >1% | >5% |
| Memory usage | >70% | >90% |

## Failure Handling

### Retry Policies

```typescript
// Database operations - exponential backoff
const dbRetryConfig = {
  retries: 3,
  minTimeout: 100,    // Start at 100ms
  maxTimeout: 2000,   // Cap at 2s
  factor: 2,          // Double each time
  retryOn: ['ECONNREFUSED', 'ETIMEDOUT', '40001'], // Serialization failure
};

// WebSocket reconnection - client-side
const wsReconnectConfig = {
  retries: 10,
  minDelay: 1000,     // Start at 1s
  maxDelay: 30000,    // Cap at 30s
  jitter: 0.3,        // Add 30% randomness to prevent thundering herd
};

// Redis operations - fail fast for cache, retry for pub/sub
const cacheRetryConfig = {
  retries: 1,         // Single retry for cache reads
  timeout: 50,        // Fail fast, DB is fallback
};

const pubsubRetryConfig = {
  retries: 5,
  minTimeout: 500,
};
```

### Idempotency

```typescript
// Cell edits are naturally idempotent (last-write-wins)
// For operations that are not:

interface IdempotentRequest {
  idempotencyKey: string;  // Client-generated UUID
  operation: string;
  payload: any;
}

// Store completed operations in Redis with 24h TTL
async function executeIdempotent(req: IdempotentRequest): Promise<any> {
  const cacheKey = `idempotent:${req.idempotencyKey}`;

  // Check if already processed
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Execute operation
  const result = await executeOperation(req);

  // Store result for replay
  await redis.setex(cacheKey, 86400, JSON.stringify(result));

  return result;
}
```

### Circuit Breaker Pattern

```typescript
import CircuitBreaker from 'opossum';

// Wrap database calls
const dbBreaker = new CircuitBreaker(executeDbQuery, {
  timeout: 5000,           // 5s timeout per request
  errorThresholdPercentage: 50,  // Open after 50% failures
  resetTimeout: 10000,     // Try again after 10s
  volumeThreshold: 5,      // Minimum 5 requests before calculating
});

dbBreaker.on('open', () => {
  logger.error('Database circuit breaker OPEN - failing fast');
});

dbBreaker.on('halfOpen', () => {
  logger.info('Database circuit breaker HALF-OPEN - testing');
});

dbBreaker.on('close', () => {
  logger.info('Database circuit breaker CLOSED - normal operation');
});

// Fallback behavior when circuit is open
dbBreaker.fallback(async () => {
  // Return cached data if available, otherwise error
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  throw new Error('Database unavailable and no cached data');
});
```

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| Redis down | Sessions fail (must login again), pub/sub disabled (single-server mode) |
| Database down | Read from cache only, writes queued in memory (limit 1000), return 503 for new spreadsheets |
| WebSocket disconnect | Queue edits locally (up to 100), sync on reconnect, show "reconnecting" indicator |
| Formula engine crash | Return `#ERROR!` in cell, log error, continue with other cells |
| High memory | Evict oldest spreadsheet caches, reduce overscan, reject new connections |

### Error Recovery

```typescript
// On WebSocket reconnect - full state sync
ws.on('open', async () => {
  // 1. Request current state from server
  ws.send({ type: 'SYNC_REQUEST', lastVersion: localVersion });

  // 2. Server responds with STATE_SYNC message
  // 3. Merge server state with local pending edits
  // 4. Replay local edits that weren't acknowledged
  pendingEdits.forEach(edit => ws.send(edit));
});

// On database recovery
dbBreaker.on('close', async () => {
  // Flush queued writes
  const queue = await getWriteQueue();
  for (const write of queue) {
    await executeDbQuery(write);
  }
  logger.info({ count: queue.length }, 'Flushed write queue after DB recovery');
});
```

## Data Lifecycle Policies

### Retention Periods

| Data Type | Retention | Rationale |
|-----------|-----------|-----------|
| Spreadsheet data | Indefinite | User content, never auto-delete |
| Edit history | 90 days | Support undo, audit, rollback |
| Collaborator sessions | 24 hours after disconnect | Clean up stale presence data |
| Redis cache entries | 30 minutes (sliding) | Memory management |
| Idempotency keys | 24 hours | Sufficient for retry scenarios |
| Server logs | 7 days | Local dev, keep storage manageable |

### Cleanup Jobs

```typescript
// Run daily cleanup job (node-cron or simple setInterval)
async function dailyCleanup(): Promise<void> {
  const stats = {
    editHistoryDeleted: 0,
    staleSessionsDeleted: 0,
    orphanedCellsDeleted: 0,
  };

  // 1. Purge old edit history
  const historyResult = await db.query(`
    DELETE FROM edit_history
    WHERE created_at < NOW() - INTERVAL '90 days'
    RETURNING id
  `);
  stats.editHistoryDeleted = historyResult.rowCount;

  // 2. Clean stale collaborator sessions
  const sessionResult = await db.query(`
    DELETE FROM collaborators
    WHERE last_seen < NOW() - INTERVAL '24 hours'
    RETURNING session_id
  `);
  stats.staleSessionsDeleted = sessionResult.rowCount;

  // 3. Optional: Find orphaned cells (sheets deleted but cells remain)
  const orphanResult = await db.query(`
    DELETE FROM cells c
    WHERE NOT EXISTS (SELECT 1 FROM sheets s WHERE s.id = c.sheet_id)
    RETURNING id
  `);
  stats.orphanedCellsDeleted = orphanResult.rowCount;

  logger.info(stats, 'Daily cleanup completed');
}

// Schedule: Run at 3 AM local time
cron.schedule('0 3 * * *', dailyCleanup);
```

### Soft Delete for Spreadsheets

```sql
-- Add deleted_at column for soft delete
ALTER TABLE spreadsheets ADD COLUMN deleted_at TIMESTAMP;

-- Soft delete instead of hard delete
UPDATE spreadsheets SET deleted_at = NOW() WHERE id = $1;

-- Exclude deleted in queries
SELECT * FROM spreadsheets WHERE owner_id = $1 AND deleted_at IS NULL;

-- Permanent deletion after 30 days
DELETE FROM spreadsheets WHERE deleted_at < NOW() - INTERVAL '30 days';
```

### Backup Strategy (Local Development)

```bash
# Simple pg_dump backup script (run manually or via cron)
#!/bin/bash
BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Create backup
pg_dump -U postgres google_sheets > "$BACKUP_DIR/backup_$TIMESTAMP.sql"

# Keep only last 5 backups
ls -t "$BACKUP_DIR"/*.sql | tail -n +6 | xargs -r rm

echo "Backup completed: backup_$TIMESTAMP.sql"
```

### Export on Demand

```typescript
// Allow users to export their data
app.get('/api/spreadsheets/:id/export', async (req, res) => {
  const format = req.query.format || 'json';
  const spreadsheet = await getSpreadsheetWithCells(req.params.id);

  switch (format) {
    case 'json':
      res.json(spreadsheet);
      break;
    case 'csv':
      res.setHeader('Content-Type', 'text/csv');
      res.send(convertToCsv(spreadsheet));
      break;
    case 'xlsx':
      const buffer = await convertToXlsx(spreadsheet);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buffer);
      break;
  }
});
```

## Technology Stack

| Component | Technology |
|-----------|------------|
| Frontend | React 19, TypeScript, Vite |
| Virtualization | TanStack Virtual |
| State Management | Zustand |
| Formulas | HyperFormula |
| Backend | Node.js, Express |
| WebSocket | ws library |
| Database | PostgreSQL |
| Cache/Pub-Sub | Redis |
| Containerization | Docker Compose |

## References

- [TanStack Virtual Documentation](https://tanstack.com/virtual/latest)
- [HyperFormula Guide](https://hyperformula.handsontable.com/)
- [Operational Transformation](https://en.wikipedia.org/wiki/Operational_transformation)
- [Google Sheets API Design](https://developers.google.com/sheets/api/reference/rest)
- [Excel Online Architecture](https://docs.microsoft.com/en-us/office/dev/add-ins/excel/)

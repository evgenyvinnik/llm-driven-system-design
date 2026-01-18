# Design Google Sheets - System Design Interview Answer

**Time allocation:** 45 minutes
**Difficulty:** Hard (real-time collaboration + formula engine)

---

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
1. **Spreadsheet Management**: Create, open, edit, and delete spreadsheets
2. **Real-time Collaboration**: Multiple users editing simultaneously with live cursor/selection visibility
3. **Formula Support**: Excel-compatible formulas with dependency tracking (SUM, VLOOKUP, IF, etc.)
4. **Cell Formatting**: Bold, colors, alignment, number formats
5. **Grid Operations**: Resize columns/rows, copy/paste, undo/redo

### Non-Functional Requirements
- **Scale**: Support 10,000+ rows/columns per sheet via virtualization
- **Latency**: Sub-100ms for local edits, <200ms for broadcast to collaborators
- **Consistency**: Last-write-wins per cell with server as source of truth
- **Availability**: Graceful degradation (read-only mode if database unavailable)

### Out of Scope
- Charts and visualizations
- Import/export Excel files (complex feature)
- Mobile native apps
- Comments and suggestions

---

## 2. Capacity Estimation (2 minutes)

### Traffic Estimates (Production Scale)
| Metric | Estimate |
|--------|----------|
| DAU | 10M users |
| Concurrent users per spreadsheet | 10-50 (avg 5) |
| Active spreadsheets | 1M |
| Cell edits per second (global) | 100K |
| WebSocket connections | 2M concurrent |

### Storage Estimates
- **Per spreadsheet** (sparse storage, only non-empty cells):
  - Metadata: 1 KB
  - 1,000 non-empty cells: 100 KB
  - Edit history (1 week): 500 KB
  - **Total: ~600 KB per active spreadsheet**

- **Total storage**: 1M spreadsheets × 600 KB = ~600 GB active data

### Bandwidth
- Cell edit message: ~200 bytes
- 100K edits/sec × 200 bytes × 5 broadcast copies = 100 MB/s

---

## 3. High-Level Design (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                           Clients                                │
│      Browser 1 (Alice)    Browser 2 (Bob)    Browser 3 (Carol)  │
│              │                  │                  │             │
│              └──────────────────┼──────────────────┘             │
│                        WebSocket │                               │
│                                  ▼                               │
│         ┌────────────────────────────────────────┐              │
│         │        WebSocket Server Cluster         │              │
│         │   (Real-time Collaboration Hub)        │              │
│         └────────────────┬───────────────────────┘              │
│                          │                                       │
│         ┌────────────────┴───────────────────┐                  │
│         ▼                                    ▼                  │
│  ┌──────────────┐                   ┌──────────────┐           │
│  │  REST API    │                   │    Redis     │           │
│  │  (CRUD ops)  │                   │  Pub/Sub +   │           │
│  │              │                   │  Sessions +  │           │
│  │              │                   │  Cache       │           │
│  └──────┬───────┘                   └──────────────┘           │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │  PostgreSQL  │                                               │
│  │ (Persistence)│                                               │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **WebSocket Server** | Real-time message routing, presence management, cell edit broadcasting |
| **REST API** | CRUD for spreadsheets/sheets, initial data load, export |
| **Redis** | Session storage, pub/sub for multi-server sync, cell cache |
| **PostgreSQL** | Durable storage for all data, edit history for undo/redo |
| **Formula Engine** | HyperFormula (in-memory per server) for dependency tracking and calculation |

---

## 4. Data Model (5 minutes)

### Core Tables

```sql
-- Users (session-based auth)
CREATE TABLE users (
    id UUID PRIMARY KEY,
    session_id VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT 'Anonymous',
    color VARCHAR(7) NOT NULL,  -- For cursor color
    created_at TIMESTAMP DEFAULT NOW()
);

-- Spreadsheets (documents)
CREATE TABLE spreadsheets (
    id UUID PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    owner_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sheets (tabs within a spreadsheet)
CREATE TABLE sheets (
    id UUID PRIMARY KEY,
    spreadsheet_id UUID REFERENCES spreadsheets(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    sheet_index INTEGER NOT NULL,
    frozen_rows INTEGER DEFAULT 0,
    frozen_cols INTEGER DEFAULT 0
);

-- Cells (SPARSE storage - only non-empty cells)
CREATE TABLE cells (
    id UUID PRIMARY KEY,
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    col_index INTEGER NOT NULL,
    raw_value TEXT,           -- User input (formulas start with '=')
    computed_value TEXT,      -- Calculated result
    format JSONB DEFAULT '{}', -- Styling (bold, color, etc.)
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    UNIQUE(sheet_id, row_index, col_index)  -- Enables UPSERT
);

-- Edit history (for undo/redo)
CREATE TABLE edit_history (
    id UUID PRIMARY KEY,
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    operation_type VARCHAR(50) NOT NULL,
    operation_data JSONB NOT NULL,   -- Forward operation
    inverse_data JSONB NOT NULL,     -- For undo
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Key Design Decisions

1. **Sparse Cell Storage**: Only store non-empty cells. A 1M cell grid with 1000 filled cells = 1000 rows, not 1M.

2. **UNIQUE constraint on (sheet_id, row_index, col_index)**: Enables efficient UPSERT pattern:
   ```sql
   INSERT INTO cells (sheet_id, row_index, col_index, raw_value)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (sheet_id, row_index, col_index)
   DO UPDATE SET raw_value = $4, updated_at = NOW();
   ```

3. **Separate raw_value and computed_value**: Store exactly what user typed, plus the calculated result for formulas.

4. **JSONB format column**: Flexible styling without schema migrations for new properties.

---

## 5. API Design (3 minutes)

### REST Endpoints (Initial Load, CRUD)

```
GET  /api/spreadsheets              # List user's spreadsheets
POST /api/spreadsheets              # Create new spreadsheet
GET  /api/spreadsheets/:id          # Get spreadsheet with all sheets
GET  /api/sheets/:sheetId/cells     # Load cells (paginated by viewport)
```

### WebSocket Protocol (Real-time)

**Client → Server:**
```typescript
{ type: 'CELL_EDIT', sheetId, row, col, value, requestId }
{ type: 'CURSOR_MOVE', sheetId, row, col }
{ type: 'SELECTION_CHANGE', sheetId, range: { startRow, startCol, endRow, endCol } }
{ type: 'UNDO', sheetId }
{ type: 'REDO', sheetId }
```

**Server → Client:**
```typescript
{ type: 'CELL_UPDATED', sheetId, row, col, value, computedValue, userId }
{ type: 'CURSOR_MOVED', userId, name, color, row, col }
{ type: 'USER_JOINED', userId, name, color }
{ type: 'USER_LEFT', userId }
{ type: 'STATE_SYNC', cells: [...], collaborators: [...] }  // On reconnect
```

---

## 6. Deep Dive: Real-time Collaboration (10 minutes)

### Conflict Resolution Strategy

**Approach: Last-Write-Wins per Cell with Server as Source of Truth**

```
Timeline:
  Alice edits A1 → sends to server → server broadcasts to all
  Bob edits A1 → sends to server → server broadcasts to all

Result: Bob's edit wins (arrived last at server)
```

**Why this works for spreadsheets:**
- Each cell is an independent unit
- Real conflicts (two users editing same cell) are rare in practice
- Server ordering provides deterministic resolution
- Much simpler than Operational Transformation (OT) or CRDTs

**Optimistic Updates with Rollback:**
```typescript
function handleCellEdit(row, col, value) {
  // 1. Apply locally immediately (optimistic)
  localState.setCell(row, col, value);

  // 2. Send to server
  ws.send({ type: 'CELL_EDIT', row, col, value, version: localVersion });

  // 3. If server rejects (version conflict), revert to server's value
}
```

### Multi-Server Synchronization

```
Server1 receives edit
    │
    ├─► Update PostgreSQL (durable)
    │
    ├─► Broadcast to local WebSocket clients
    │
    └─► Publish to Redis pub/sub channel
            │
            ├─► Server2 receives, broadcasts to its clients
            │
            └─► Server3 receives, broadcasts to its clients
```

**Redis Pub/Sub Pattern:**
```javascript
// Publisher (on edit)
redis.publish(`spreadsheet:${spreadsheetId}`, JSON.stringify({
  type: 'CELL_UPDATED', row, col, value, userId
}));

// All servers subscribe
redis.subscribe(`spreadsheet:${spreadsheetId}`, (message) => {
  wsServer.broadcastToRoom(spreadsheetId, message);
});
```

### Presence Management

Track active users in each spreadsheet:
- Store cursor position and selection range in `collaborators` table
- Broadcast cursor moves via WebSocket
- Clean up stale connections (last_seen > 30 seconds)

---

## 7. Deep Dive: Formula Engine (8 minutes)

### Architecture Decision: Client-side vs Server-side Calculation

| Approach | Pros | Cons |
|----------|------|------|
| **Client-side** | Zero server load, instant response | Inconsistent results between clients |
| **Server-side** | Single source of truth, consistent | Latency, server load |
| **Hybrid (chosen)** | Best of both | More complex implementation |

**Hybrid Approach:**
- Client calculates immediately for responsiveness
- Server recalculates and broadcasts authoritative result
- If mismatch, client updates to server value

### HyperFormula Integration

Using [HyperFormula](https://hyperformula.handsontable.com/) - open-source formula engine:

```typescript
import { HyperFormula } from 'hyperformula';

class FormulaEngine {
  private hf: HyperFormula;

  constructor() {
    this.hf = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' });
  }

  setCellValue(row: number, col: number, value: string) {
    this.hf.setCellContents({ sheet: 0, row, col }, value);

    return {
      computedValue: this.hf.getCellValue({ sheet: 0, row, col }),
      dependents: this.hf.getCellDependents({ sheet: 0, row, col })
    };
  }
}
```

### Dependency Tracking

When cell A1 changes and B1 = `=A1 * 2`:
1. Update A1 in formula engine
2. HyperFormula returns dependent cells: [B1]
3. Recalculate B1
4. Broadcast both A1 and B1 updates to clients

### Performance: Web Workers

Offload formula calculation to prevent UI blocking:
```typescript
// Main thread
const worker = new Worker('formula.worker.ts');
worker.postMessage({ type: 'CALCULATE', row, col, value });

// Worker thread
self.onmessage = ({ data }) => {
  hf.setCellContents(data.address, data.value);
  self.postMessage({ result: hf.getCellValue(data.address) });
};
```

---

## 8. Deep Dive: Virtualization (5 minutes)

### The Problem
- Excel supports 16,384 columns × 1,048,576 rows
- Rendering 17 billion cells would crash any browser
- Even 10,000 cells (100×100) causes performance issues

### Solution: TanStack Virtual

Only render cells visible in the viewport, plus a small buffer (overscan):

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

const rowVirtualizer = useVirtualizer({
  count: 1_000_000,  // Logical rows
  getScrollElement: () => containerRef.current,
  estimateSize: (index) => rowHeights.get(index) ?? 32,
  overscan: 10,  // Render 10 extra rows above/below
});

const visibleRows = rowVirtualizer.getVirtualItems();
// Returns ~30-50 items regardless of total count
```

### Variable Row/Column Sizes

- Store custom sizes sparsely: `column_widths` and `row_heights` tables
- Default width: 100px, Default height: 32px
- Only store rows/columns that differ from default

### Memory Efficiency

| Scenario | DOM Nodes | Without Virtualization |
|----------|-----------|------------------------|
| 100×100 visible viewport | ~1,200 | ~1,200 |
| 1M row × 1K col sheet | ~1,200 | 1,000,000,000 (impossible) |

---

## 9. Trade-offs Summary (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **Conflict Resolution** | Last-write-wins | OT/CRDT | Much simpler, good enough for cells |
| **Cell Storage** | Sparse (only non-empty) | Dense array | 1000x storage efficiency |
| **Formula Engine** | HyperFormula | Custom | 380+ Excel functions, battle-tested |
| **Real-time Protocol** | WebSocket | SSE | Bidirectional needed for edits |
| **Multi-server Sync** | Redis Pub/Sub | Kafka | Lower latency, simpler for this use case |
| **Database** | PostgreSQL | MongoDB | ACID for edit history, JSONB for flexibility |

### Limitations and Future Improvements

1. **No Offline Support**: Would require CRDTs for proper offline merge
2. **Large Formula Graphs**: Complex spreadsheets with 10K+ formula dependencies may have noticeable recalculation lag
3. **Cross-sheet References**: Not implemented (e.g., `=Sheet2!A1`)
4. **Concurrent Large Pastes**: May cause temporary inconsistency during propagation

---

## 10. Closing Summary (1 minute)

We designed a collaborative spreadsheet with:
- **Real-time collaboration** via WebSocket with last-write-wins conflict resolution
- **Formula engine** using HyperFormula for Excel-compatible calculations
- **Virtualized rendering** to handle millions of logical rows/columns
- **Sparse storage** to efficiently store only non-empty cells
- **Multi-server scalability** via Redis pub/sub

Key architectural insight: Treating each cell as an independent unit simplifies conflict resolution dramatically compared to document-level synchronization.

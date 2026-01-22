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

```typescript
// shared/types.ts - Used by both frontend and backend

export interface Spreadsheet {
  id: string;
  title: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Sheet {
  id: string;
  spreadsheetId: string;
  name: string;
  sheetIndex: number;
  frozenRows: number;
  frozenCols: number;
}

export interface CellData {
  rawValue: string | null;
  computedValue: any;
  format?: CellFormat;
  error?: string;
}

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  backgroundColor?: string;
  textAlign?: 'left' | 'center' | 'right';
  fontSize?: number;
  numberFormat?: string;
}

export interface Collaborator {
  userId: string;
  name: string;
  color: string;
  cursorRow: number | null;
  cursorCol: number | null;
  selectionRange: CellRange | null;
}

export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// WebSocket message types
export type ClientMessage =
  | { type: 'CELL_EDIT'; sheetId: string; row: number; col: number; value: string; requestId?: string }
  | { type: 'CURSOR_MOVE'; sheetId: string; row: number; col: number }
  | { type: 'SELECTION_CHANGE'; sheetId: string; range: CellRange }
  | { type: 'UNDO'; sheetId: string }
  | { type: 'REDO'; sheetId: string };

export type ServerMessage =
  | { type: 'CELL_UPDATED'; sheetId: string; row: number; col: number; value: string; computedValue: any; userId: string }
  | { type: 'CURSOR_MOVED'; userId: string; name: string; color: string; row: number; col: number }
  | { type: 'USER_JOINED'; userId: string; name: string; color: string }
  | { type: 'USER_LEFT'; userId: string }
  | { type: 'STATE_SYNC'; cells: Array<{ row: number; col: number; data: CellData }>; collaborators: Collaborator[] };
```

### PostgreSQL Schema

```sql
-- Sparse cell storage - only non-empty cells
CREATE TABLE cells (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    col_index INTEGER NOT NULL,
    raw_value TEXT,
    computed_value TEXT,
    format JSONB DEFAULT '{}',
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    UNIQUE(sheet_id, row_index, col_index)  -- Enables UPSERT
);

CREATE INDEX idx_cells_sheet ON cells(sheet_id);
CREATE INDEX idx_cells_position ON cells(sheet_id, row_index, col_index);
```

### Database Service Layer

```typescript
// backend/src/services/cellService.ts

import { pool } from '../shared/db.js';
import { CellData, CellFormat } from '../shared/types.js';

export async function getCellsBySheet(sheetId: string): Promise<Map<string, CellData>> {
  const result = await pool.query(
    `SELECT row_index, col_index, raw_value, computed_value, format
     FROM cells WHERE sheet_id = $1`,
    [sheetId]
  );

  const cells = new Map<string, CellData>();
  for (const row of result.rows) {
    const key = `${row.row_index}-${row.col_index}`;
    cells.set(key, {
      rawValue: row.raw_value,
      computedValue: row.computed_value,
      format: row.format,
    });
  }
  return cells;
}

export async function upsertCell(
  sheetId: string,
  row: number,
  col: number,
  rawValue: string | null,
  computedValue: any,
  userId: string
): Promise<void> {
  if (rawValue === null || rawValue === '') {
    // Delete empty cells from sparse storage
    await pool.query(
      `DELETE FROM cells WHERE sheet_id = $1 AND row_index = $2 AND col_index = $3`,
      [sheetId, row, col]
    );
  } else {
    // UPSERT pattern
    await pool.query(
      `INSERT INTO cells (sheet_id, row_index, col_index, raw_value, computed_value, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sheet_id, row_index, col_index)
       DO UPDATE SET raw_value = $4, computed_value = $5, updated_by = $6, updated_at = NOW()`,
      [sheetId, row, col, rawValue, computedValue, userId]
    );
  }
}

export async function getCellsInViewport(
  sheetId: string,
  startRow: number,
  endRow: number,
  startCol: number,
  endCol: number
): Promise<Map<string, CellData>> {
  const result = await pool.query(
    `SELECT row_index, col_index, raw_value, computed_value, format
     FROM cells
     WHERE sheet_id = $1
       AND row_index BETWEEN $2 AND $3
       AND col_index BETWEEN $4 AND $5`,
    [sheetId, startRow, endRow, startCol, endCol]
  );

  const cells = new Map<string, CellData>();
  for (const row of result.rows) {
    const key = `${row.row_index}-${row.col_index}`;
    cells.set(key, {
      rawValue: row.raw_value,
      computedValue: row.computed_value,
      format: row.format,
    });
  }
  return cells;
}
```

---

## 4. Deep Dive: WebSocket Real-time Sync (8 minutes)

### Server-Side WebSocket Handler

```typescript
// backend/src/websocket/server.ts

import { WebSocketServer, WebSocket } from 'ws';
import { redis } from '../shared/redis.js';
import { upsertCell } from '../services/cellService.js';
import { formulaEngine } from '../services/formulaEngine.js';
import { checkIdempotency, setIdempotencyResult } from '../shared/idempotency.js';
import { ClientMessage, ServerMessage } from '../shared/types.js';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  userName: string;
  userColor: string;
  spreadsheetId: string;
}

const rooms = new Map<string, Set<ConnectedClient>>();

export function setupWebSocket(server: any) {
  const wss = new WebSocketServer({ server });

  // Subscribe to Redis for multi-server sync
  const subscriber = redis.duplicate();
  subscriber.subscribe('spreadsheet:updates', (message) => {
    const data = JSON.parse(message);
    broadcastToRoom(data.spreadsheetId, data.message, null);
  });

  wss.on('connection', async (ws, req) => {
    const params = new URL(req.url!, `http://${req.headers.host}`).searchParams;
    const spreadsheetId = params.get('spreadsheetId');
    const token = params.get('token');

    // Authenticate and get user info
    const user = await authenticateToken(token);
    if (!user || !spreadsheetId) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const client: ConnectedClient = {
      ws,
      userId: user.id,
      userName: user.name,
      userColor: user.color,
      spreadsheetId,
    };

    // Join room
    if (!rooms.has(spreadsheetId)) {
      rooms.set(spreadsheetId, new Set());
    }
    rooms.get(spreadsheetId)!.add(client);

    // Notify others
    broadcastToRoom(spreadsheetId, {
      type: 'USER_JOINED',
      userId: user.id,
      name: user.name,
      color: user.color,
    }, client);

    // Send current state
    await sendStateSync(client);

    ws.on('message', async (data) => {
      const message: ClientMessage = JSON.parse(data.toString());
      await handleClientMessage(client, message);
    });

    ws.on('close', () => {
      rooms.get(spreadsheetId)?.delete(client);
      broadcastToRoom(spreadsheetId, { type: 'USER_LEFT', userId: user.id }, null);
    });
  });
}

async function handleClientMessage(client: ConnectedClient, message: ClientMessage) {
  switch (message.type) {
    case 'CELL_EDIT': {
      // Check idempotency
      if (message.requestId) {
        const cached = await checkIdempotency(message.requestId);
        if (cached) {
          client.ws.send(JSON.stringify(cached));
          return;
        }
      }

      // Calculate formula if needed
      const computed = message.value.startsWith('=')
        ? formulaEngine.calculate(message.sheetId, message.row, message.col, message.value)
        : message.value;

      // Persist to database
      await upsertCell(
        message.sheetId,
        message.row,
        message.col,
        message.value,
        computed,
        client.userId
      );

      // Prepare broadcast message
      const response: ServerMessage = {
        type: 'CELL_UPDATED',
        sheetId: message.sheetId,
        row: message.row,
        col: message.col,
        value: message.value,
        computedValue: computed,
        userId: client.userId,
      };

      // Store idempotency result
      if (message.requestId) {
        await setIdempotencyResult(message.requestId, response);
      }

      // Broadcast to room
      broadcastToRoom(client.spreadsheetId, response, null);

      // Publish to Redis for other servers
      await redis.publish('spreadsheet:updates', JSON.stringify({
        spreadsheetId: client.spreadsheetId,
        message: response,
      }));
      break;
    }

    case 'CURSOR_MOVE': {
      broadcastToRoom(client.spreadsheetId, {
        type: 'CURSOR_MOVED',
        userId: client.userId,
        name: client.userName,
        color: client.userColor,
        row: message.row,
        col: message.col,
      }, client);
      break;
    }
  }
}

function broadcastToRoom(
  spreadsheetId: string,
  message: ServerMessage,
  exclude: ConnectedClient | null
) {
  const room = rooms.get(spreadsheetId);
  if (!room) return;

  const data = JSON.stringify(message);
  for (const client of room) {
    if (client !== exclude && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}
```

### Client-Side WebSocket Hook

```typescript
// frontend/src/hooks/useWebSocket.ts

import { useEffect, useRef, useCallback } from 'react';
import { useSpreadsheetStore } from '../stores/spreadsheetStore';
import { ClientMessage, ServerMessage } from '../shared/types';

export function useWebSocket(spreadsheetId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const {
    applyRemoteCellUpdate,
    updateCollaborator,
    removeCollaborator,
    syncState,
  } = useSpreadsheetStore();

  const connect = useCallback(() => {
    const token = sessionStorage.getItem('token');
    const ws = new WebSocket(
      `ws://localhost:3001/ws?spreadsheetId=${spreadsheetId}&token=${token}`
    );

    ws.onopen = () => {
      console.log('WebSocket connected');
      wsRef.current = ws;
    };

    ws.onmessage = (event) => {
      const message: ServerMessage = JSON.parse(event.data);

      switch (message.type) {
        case 'CELL_UPDATED':
          applyRemoteCellUpdate(
            message.row,
            message.col,
            message.value,
            message.computedValue
          );
          break;

        case 'CURSOR_MOVED':
          updateCollaborator({
            userId: message.userId,
            name: message.name,
            color: message.color,
            cursorRow: message.row,
            cursorCol: message.col,
            selectionRange: null,
          });
          break;

        case 'USER_JOINED':
          updateCollaborator({
            userId: message.userId,
            name: message.name,
            color: message.color,
            cursorRow: null,
            cursorCol: null,
            selectionRange: null,
          });
          break;

        case 'USER_LEFT':
          removeCollaborator(message.userId);
          break;

        case 'STATE_SYNC':
          syncState(message.cells, message.collaborators);
          break;
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Reconnect with exponential backoff
      reconnectTimeoutRef.current = window.setTimeout(connect, 2000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      ws.close();
    };
  }, [spreadsheetId, applyRemoteCellUpdate, updateCollaborator, removeCollaborator, syncState]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  const sendMessage = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  return { sendMessage };
}
```

---

## 5. Deep Dive: Frontend Virtualization (6 minutes)

### Virtualized Grid Component

```typescript
// frontend/src/components/SpreadsheetGrid.tsx

import { useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSpreadsheetStore } from '../stores/spreadsheetStore';
import { Cell } from './Cell';
import { CollaboratorCursors } from './CollaboratorCursors';

const MAX_ROWS = 1_000_000;
const MAX_COLS = 16_384;
const DEFAULT_ROW_HEIGHT = 32;
const DEFAULT_COL_WIDTH = 100;

export function SpreadsheetGrid() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { columnWidths, rowHeights } = useSpreadsheetStore();

  // Row virtualizer
  const rowVirtualizer = useVirtualizer({
    count: MAX_ROWS,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => rowHeights.get(index) ?? DEFAULT_ROW_HEIGHT,
    overscan: 10,
  });

  // Column virtualizer
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: MAX_COLS,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => columnWidths.get(index) ?? DEFAULT_COL_WIDTH,
    overscan: 5,
  });

  const visibleRows = rowVirtualizer.getVirtualItems();
  const visibleCols = colVirtualizer.getVirtualItems();

  // Memoize the grid to prevent re-renders
  const gridContent = useMemo(() => (
    visibleRows.flatMap((virtualRow) =>
      visibleCols.map((virtualCol) => (
        <Cell
          key={`${virtualRow.index}-${virtualCol.index}`}
          row={virtualRow.index}
          col={virtualCol.index}
          style={{
            position: 'absolute',
            top: virtualRow.start,
            left: virtualCol.start,
            height: virtualRow.size,
            width: virtualCol.size,
          }}
        />
      ))
    )
  ), [visibleRows, visibleCols]);

  return (
    <div
      ref={containerRef}
      className="relative overflow-auto flex-1 bg-white"
    >
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          width: colVirtualizer.getTotalSize(),
          position: 'relative',
        }}
      >
        {gridContent}
        <CollaboratorCursors />
      </div>
    </div>
  );
}
```

### Zustand Store Integration

```typescript
// frontend/src/stores/spreadsheetStore.ts

import { create } from 'zustand';
import { CellData, Collaborator } from '../shared/types';

function cellKey(row: number, col: number): string {
  return `${row}-${col}`;
}

interface SpreadsheetStore {
  spreadsheetId: string;
  activeSheetId: string;

  // Sparse cell storage
  cells: Map<string, CellData>;

  // UI state
  activeCell: { row: number; col: number } | null;
  isEditing: boolean;
  editValue: string;

  // Dimensions (sparse - only non-default)
  columnWidths: Map<number, number>;
  rowHeights: Map<number, number>;

  // Collaborators
  collaborators: Map<string, Collaborator>;

  // Actions
  setCell: (row: number, col: number, value: string) => void;
  applyRemoteCellUpdate: (row: number, col: number, rawValue: string, computedValue: any) => void;
  setActiveCell: (row: number, col: number) => void;
  startEditing: (initialValue?: string) => void;
  commitEdit: () => void;

  // Collaboration
  updateCollaborator: (collaborator: Collaborator) => void;
  removeCollaborator: (userId: string) => void;
  syncState: (cells: Array<{ row: number; col: number; data: CellData }>, collaborators: Collaborator[]) => void;
}

export const useSpreadsheetStore = create<SpreadsheetStore>((set, get) => ({
  spreadsheetId: '',
  activeSheetId: '',
  cells: new Map(),
  activeCell: null,
  isEditing: false,
  editValue: '',
  columnWidths: new Map(),
  rowHeights: new Map(),
  collaborators: new Map(),

  setCell: (row, col, value) => {
    set((state) => {
      const newCells = new Map(state.cells);
      const key = cellKey(row, col);

      if (value === '' || value === null) {
        newCells.delete(key);
      } else {
        newCells.set(key, {
          rawValue: value,
          computedValue: value.startsWith('=') ? null : value,
        });
      }

      return { cells: newCells };
    });
  },

  applyRemoteCellUpdate: (row, col, rawValue, computedValue) => {
    set((state) => {
      const newCells = new Map(state.cells);
      const key = cellKey(row, col);

      if (rawValue === '' || rawValue === null) {
        newCells.delete(key);
      } else {
        newCells.set(key, { rawValue, computedValue });
      }

      return { cells: newCells };
    });
  },

  syncState: (cellArray, collaboratorArray) => {
    const cells = new Map<string, CellData>();
    for (const { row, col, data } of cellArray) {
      cells.set(cellKey(row, col), data);
    }

    const collaborators = new Map<string, Collaborator>();
    for (const collab of collaboratorArray) {
      collaborators.set(collab.userId, collab);
    }

    set({ cells, collaborators });
  },

  updateCollaborator: (collaborator) => {
    set((state) => {
      const newCollaborators = new Map(state.collaborators);
      newCollaborators.set(collaborator.userId, collaborator);
      return { collaborators: newCollaborators };
    });
  },

  removeCollaborator: (userId) => {
    set((state) => {
      const newCollaborators = new Map(state.collaborators);
      newCollaborators.delete(userId);
      return { collaborators: newCollaborators };
    });
  },

  // ... other actions
}));
```

---

## 6. Deep Dive: REST API Endpoints (5 minutes)

### API Route Definitions

```typescript
// backend/src/routes/api.ts

import { Router } from 'express';
import { pool } from '../shared/db.js';
import { getCellsBySheet, getCellsInViewport } from '../services/cellService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// List user's spreadsheets
router.get('/spreadsheets', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, title, created_at, updated_at
     FROM spreadsheets
     WHERE owner_id = $1
     ORDER BY updated_at DESC`,
    [req.user!.id]
  );
  res.json(result.rows);
});

// Create spreadsheet
router.post('/spreadsheets', requireAuth, async (req, res) => {
  const { title = 'Untitled Spreadsheet' } = req.body;

  const result = await pool.query(
    `WITH new_spreadsheet AS (
       INSERT INTO spreadsheets (title, owner_id)
       VALUES ($1, $2)
       RETURNING id, title, created_at, updated_at
     ),
     new_sheet AS (
       INSERT INTO sheets (spreadsheet_id, name, sheet_index)
       SELECT id, 'Sheet1', 0 FROM new_spreadsheet
       RETURNING id, spreadsheet_id, name, sheet_index
     )
     SELECT
       ns.id, ns.title, ns.created_at, ns.updated_at,
       json_agg(json_build_object(
         'id', sh.id, 'name', sh.name, 'sheetIndex', sh.sheet_index
       )) as sheets
     FROM new_spreadsheet ns
     JOIN new_sheet sh ON sh.spreadsheet_id = ns.id
     GROUP BY ns.id, ns.title, ns.created_at, ns.updated_at`,
    [title, req.user!.id]
  );

  res.status(201).json(result.rows[0]);
});

// Get spreadsheet with sheets
router.get('/spreadsheets/:id', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT
       s.id, s.title, s.created_at, s.updated_at,
       json_agg(json_build_object(
         'id', sh.id, 'name', sh.name, 'sheetIndex', sh.sheet_index,
         'frozenRows', sh.frozen_rows, 'frozenCols', sh.frozen_cols
       ) ORDER BY sh.sheet_index) as sheets
     FROM spreadsheets s
     LEFT JOIN sheets sh ON sh.spreadsheet_id = s.id
     WHERE s.id = $1
     GROUP BY s.id`,
    [req.params.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Spreadsheet not found' });
  }

  res.json(result.rows[0]);
});

// Get cells for a sheet (with optional viewport pagination)
router.get('/sheets/:sheetId/cells', requireAuth, async (req, res) => {
  const { sheetId } = req.params;
  const { startRow, endRow, startCol, endCol } = req.query;

  let cells: Map<string, any>;

  if (startRow !== undefined && endRow !== undefined) {
    // Viewport-based loading
    cells = await getCellsInViewport(
      sheetId,
      parseInt(startRow as string),
      parseInt(endRow as string),
      parseInt(startCol as string) || 0,
      parseInt(endCol as string) || 100
    );
  } else {
    // Load all cells
    cells = await getCellsBySheet(sheetId);
  }

  // Convert Map to array for JSON response
  const cellArray = Array.from(cells.entries()).map(([key, data]) => {
    const [row, col] = key.split('-').map(Number);
    return { row, col, data };
  });

  res.json({ cells: cellArray });
});

export default router;
```

### Frontend API Service

```typescript
// frontend/src/services/api.ts

const API_BASE = 'http://localhost:3001/api';

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = sessionStorage.getItem('token');
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

export const api = {
  spreadsheets: {
    list: () => fetchWithAuth(`${API_BASE}/spreadsheets`),

    create: (title?: string) =>
      fetchWithAuth(`${API_BASE}/spreadsheets`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      }),

    get: (id: string) => fetchWithAuth(`${API_BASE}/spreadsheets/${id}`),
  },

  sheets: {
    getCells: (sheetId: string, viewport?: { startRow: number; endRow: number; startCol: number; endCol: number }) => {
      const params = viewport
        ? `?startRow=${viewport.startRow}&endRow=${viewport.endRow}&startCol=${viewport.startCol}&endCol=${viewport.endCol}`
        : '';
      return fetchWithAuth(`${API_BASE}/sheets/${sheetId}/cells${params}`);
    },
  },
};
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

```typescript
// backend/src/shared/cache.ts

import { redis } from './redis.js';
import { CellData } from '../shared/types.js';

const CACHE_TTL = 1800; // 30 minutes

export async function getCachedCells(sheetId: string): Promise<Map<string, CellData> | null> {
  const cached = await redis.hgetall(`sheet:${sheetId}:cells`);
  if (Object.keys(cached).length === 0) return null;

  const cells = new Map<string, CellData>();
  for (const [key, value] of Object.entries(cached)) {
    cells.set(key, JSON.parse(value));
  }
  return cells;
}

export async function setCachedCell(
  sheetId: string,
  row: number,
  col: number,
  data: CellData
): Promise<void> {
  const key = `${row}-${col}`;
  await redis.hset(`sheet:${sheetId}:cells`, key, JSON.stringify(data));
  await redis.expire(`sheet:${sheetId}:cells`, CACHE_TTL);
}

export async function invalidateCellCache(sheetId: string, row: number, col: number): Promise<void> {
  await redis.hdel(`sheet:${sheetId}:cells`, `${row}-${col}`);
}
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

We designed a collaborative spreadsheet with:
- **Shared TypeScript types** ensuring type safety across the full stack
- **WebSocket real-time sync** with Redis pub/sub for multi-server support
- **Sparse storage pattern** on both frontend (Zustand Map) and backend (PostgreSQL UPSERT)
- **Virtualized grid** using TanStack Virtual for million-row performance
- **HyperFormula integration** on both client (immediate) and server (authoritative)

Key full-stack insight: The sparse data model flows seamlessly from database (only non-empty rows) through API (cell arrays) to frontend (Map), enabling consistent behavior and efficient memory usage at every layer.

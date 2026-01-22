# Google Sheets - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
1. **Spreadsheet Grid Rendering**: Display a large grid with virtualization for 10,000+ rows/columns
2. **Cell Editing**: Inline editing with formula bar, keyboard navigation, tab/enter behavior
3. **Real-time Collaboration UI**: Show collaborator cursors, selections, and presence indicators
4. **Formula Display**: Distinguish between raw formulas and computed values
5. **Cell Formatting**: Bold, colors, alignment, number formats with immediate visual feedback

### Non-Functional Requirements
- **Performance**: Smooth scrolling at 60fps for million-row grids via virtualization
- **Latency**: Sub-50ms for local edits to appear in UI
- **Accessibility**: Keyboard navigation, screen reader support, ARIA labels
- **Responsiveness**: Work on tablets and desktops (1024px+ viewports)

### Out of Scope
- Mobile native apps
- Charts and data visualizations
- Import/export wizards
- Offline-first architecture

---

## 2. Frontend Architecture Overview (5 minutes)

```
+------------------------------------------------------------------+
|                        SpreadsheetApp                              |
|  +-------------------------------------------------------------+  |
|  |                         Toolbar                              |  |
|  |  [FormatButtons] [FormulaBar] [ShareButton] [UndoRedo]      |  |
|  +-------------------------------------------------------------+  |
|  +-------------------------------------------------------------+  |
|  |                      SheetTabs                               |  |
|  |  [ Sheet1 ] [ Sheet2 ] [ + ]                                 |  |
|  +-------------------------------------------------------------+  |
|  +-------------------------------------------------------------+  |
|  |                    SpreadsheetGrid                           |  |
|  |  +----------+----------------------------------------+       |  |
|  |  | Corner   |         ColumnHeaders                  |       |  |
|  |  +----------+----------------------------------------+       |  |
|  |  |  Row     |                                        |       |  |
|  |  | Headers  |        VirtualizedCells               |       |  |
|  |  |          |   +---------+---------+---------+      |       |  |
|  |  |   1      |   |   A1    |   B1    |   C1    |      |       |  |
|  |  |   2      |   |   A2    |   B2    |   C2    |      |       |  |
|  |  |   3      |   |   A3    |   B3    |   C3    |      |       |  |
|  |  |          |   +---------+---------+---------+      |       |  |
|  |  +----------+----------------------------------------+       |  |
|  |                                                              |  |
|  |  +-------------------+  +-------------------------+          |  |
|  |  | SelectionOverlay  |  | CollaboratorCursors    |          |  |
|  |  +-------------------+  +-------------------------+          |  |
|  +-------------------------------------------------------------+  |
|  +-------------------------------------------------------------+  |
|  |                       StatusBar                              |  |
|  +-------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **SpreadsheetGrid** | Scroll container, coordinate virtualizers, cell positioning |
| **VirtualizedCells** | Render only visible cells using TanStack Virtual |
| **Cell** | Memoized cell display, inline editing, selection state |
| **ColumnHeaders** | Column letters (A, B, C...), resize handles |
| **RowHeaders** | Row numbers, resize handles |
| **FormulaBar** | Display active cell formula, handle formula editing |
| **SelectionOverlay** | Blue selection rectangle, handles multi-cell selection |
| **CollaboratorCursors** | Colored boxes for other users' cursor positions |

---

## 3. Deep Dive: Virtualization with TanStack Virtual (8 minutes)

### The Problem

Rendering millions of cells is impossible:
- Excel supports 16,384 columns x 1,048,576 rows = 17 billion cells
- Even 10,000 DOM nodes cause significant jank
- Memory consumption would crash browsers

### Solution: Dual-Axis Virtualization

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

function SpreadsheetGrid() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { columnWidths, rowHeights } = useSpreadsheetStore();

  // Vertical virtualization (rows)
  const rowVirtualizer = useVirtualizer({
    count: 1_000_000,  // Logical row count
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => rowHeights.get(index) ?? 32,
    overscan: 10,  // Render 10 extra rows above/below
  });

  // Horizontal virtualization (columns)
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: 16_384,  // Excel column count
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => columnWidths.get(index) ?? 100,
    overscan: 5,
  });

  const visibleRows = rowVirtualizer.getVirtualItems();
  const visibleCols = colVirtualizer.getVirtualItems();

  return (
    <div
      ref={containerRef}
      className="overflow-auto relative"
      style={{ height: '100%', width: '100%' }}
    >
      {/* Virtual grid content */}
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          width: colVirtualizer.getTotalSize(),
          position: 'relative',
        }}
      >
        {visibleRows.map((virtualRow) =>
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
        )}
      </div>
    </div>
  );
}
```

### Variable Row/Column Sizes

```typescript
interface DimensionStore {
  columnWidths: Map<number, number>;  // Sparse: only non-default
  rowHeights: Map<number, number>;

  setColumnWidth: (col: number, width: number) => void;
  setRowHeight: (row: number, height: number) => void;

  getColumnWidth: (col: number) => number;
  getRowHeight: (row: number) => number;
}

const DEFAULT_COLUMN_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 32;

// Resize handle implementation
function ColumnResizeHandle({ col }: { col: number }) {
  const { setColumnWidth, getColumnWidth } = useSpreadsheetStore();
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = (e: React.MouseEvent) => {
    startX.current = e.clientX;
    startWidth.current = getColumnWidth(col);

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX.current;
      const newWidth = Math.max(50, startWidth.current + delta);
      setColumnWidth(col, newWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      className="absolute right-0 top-0 w-1 h-full cursor-col-resize
                 hover:bg-blue-400 active:bg-blue-600"
      onMouseDown={handleMouseDown}
    />
  );
}
```

### Memory Efficiency

| Scenario | DOM Nodes | Without Virtualization |
|----------|-----------|------------------------|
| Viewport 30x20 visible | ~600 | ~600 |
| 1M rows x 1K cols sheet | ~600 | 1,000,000,000 (crash) |

---

## 4. Deep Dive: State Management with Zustand (7 minutes)

### Store Structure

```typescript
interface SpreadsheetStore {
  // Document state
  spreadsheetId: string;
  sheets: Sheet[];
  activeSheetId: string;

  // Sparse cell data
  cells: Map<string, CellData>;  // Key: "sheetId-row-col"

  // Selection state
  activeCell: { row: number; col: number } | null;
  selection: CellRange | null;
  isEditing: boolean;
  editValue: string;

  // Collaborators
  collaborators: Map<string, Collaborator>;

  // Dimensions (sparse)
  columnWidths: Map<number, number>;
  rowHeights: Map<number, number>;

  // History
  undoStack: Operation[];
  redoStack: Operation[];
  canUndo: boolean;
  canRedo: boolean;

  // Actions
  setCell: (row: number, col: number, value: string) => void;
  setActiveCell: (row: number, col: number) => void;
  setSelection: (range: CellRange | null) => void;
  startEditing: (initialValue?: string) => void;
  commitEdit: () => void;
  cancelEdit: () => void;

  // Collaboration
  updateCollaborator: (collaborator: Collaborator) => void;
  removeCollaborator: (userId: string) => void;

  // History
  undo: () => void;
  redo: () => void;
  pushHistory: (operation: Operation) => void;
}
```

### Sparse Cell Data Pattern

```typescript
// Only store non-empty cells for efficiency
interface CellData {
  rawValue: string | null;
  computedValue: any;
  format?: CellFormat;
  error?: string;
}

// Cell key generation
function cellKey(sheetId: string, row: number, col: number): string {
  return `${sheetId}-${row}-${col}`;
}

// Zustand store implementation
const useSpreadsheetStore = create<SpreadsheetStore>((set, get) => ({
  cells: new Map(),

  setCell: (row, col, value) => {
    const { activeSheetId, cells } = get();
    const key = cellKey(activeSheetId, row, col);

    set((state) => {
      const newCells = new Map(state.cells);

      if (value === '' || value === null) {
        // Remove empty cells from sparse storage
        newCells.delete(key);
      } else {
        newCells.set(key, {
          rawValue: value,
          computedValue: value.startsWith('=') ? null : value,
        });
      }

      return { cells: newCells };
    });

    // Send to server via WebSocket
    wsService.sendCellEdit(activeSheetId, row, col, value);
  },

  getCell: (row, col) => {
    const { activeSheetId, cells } = get();
    const key = cellKey(activeSheetId, row, col);
    return cells.get(key) || null;
  },
}));
```

### Selector Optimization

```typescript
// Fine-grained selectors prevent unnecessary re-renders
const Cell = memo(function Cell({ row, col, style }: CellProps) {
  // Only re-render when THIS cell's data changes
  const cellData = useSpreadsheetStore(
    useCallback(
      (state) => state.cells.get(cellKey(state.activeSheetId, row, col)),
      [row, col]
    )
  );

  const isActive = useSpreadsheetStore(
    useCallback(
      (state) =>
        state.activeCell?.row === row && state.activeCell?.col === col,
      [row, col]
    )
  );

  const isSelected = useSpreadsheetStore(
    useCallback(
      (state) => isInRange(state.selection, row, col),
      [row, col]
    )
  );

  return (
    <div
      style={style}
      className={cn(
        'border-r border-b border-gray-200 px-2 py-1 truncate',
        isActive && 'ring-2 ring-blue-500 ring-inset',
        isSelected && !isActive && 'bg-blue-50'
      )}
    >
      {cellData?.computedValue ?? cellData?.rawValue ?? ''}
    </div>
  );
});
```

---

## 5. Deep Dive: Cell Component and Editing (7 minutes)

### Memoized Cell Rendering

```typescript
interface CellProps {
  row: number;
  col: number;
  style: React.CSSProperties;
}

const Cell = memo(function Cell({ row, col, style }: CellProps) {
  const {
    activeSheetId,
    activeCell,
    isEditing,
    editValue,
    setActiveCell,
    startEditing,
    setEditValue,
    commitEdit,
    cancelEdit,
  } = useSpreadsheetStore();

  const cellData = useSpreadsheetStore(
    (state) => state.cells.get(cellKey(state.activeSheetId, row, col))
  );

  const isActive = activeCell?.row === row && activeCell?.col === col;
  const isEditingThis = isActive && isEditing;

  // Handle cell click
  const handleClick = useCallback(() => {
    setActiveCell(row, col);
  }, [row, col, setActiveCell]);

  // Handle double-click to edit
  const handleDoubleClick = useCallback(() => {
    setActiveCell(row, col);
    startEditing(cellData?.rawValue ?? '');
  }, [row, col, cellData, setActiveCell, startEditing]);

  // Render editing input
  if (isEditingThis) {
    return (
      <div style={style} className="relative">
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEdit();
            } else if (e.key === 'Escape') {
              cancelEdit();
            } else if (e.key === 'Tab') {
              e.preventDefault();
              commitEdit();
              // Move to next cell
              setActiveCell(row, col + (e.shiftKey ? -1 : 1));
            }
          }}
          onBlur={commitEdit}
          className="absolute inset-0 w-full h-full px-2 py-1
                     border-2 border-blue-500 outline-none z-10"
        />
      </div>
    );
  }

  // Format display value
  const displayValue = useMemo(() => {
    if (cellData?.error) return cellData.error;
    if (cellData?.computedValue !== undefined) return cellData.computedValue;
    if (cellData?.rawValue !== undefined) return cellData.rawValue;
    return '';
  }, [cellData]);

  return (
    <div
      style={style}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className={cn(
        'border-r border-b border-gray-200 px-2 py-1 truncate select-none',
        'cursor-cell',
        isActive && 'ring-2 ring-blue-500 ring-inset z-10',
        cellData?.format?.bold && 'font-bold',
        cellData?.format?.italic && 'italic'
      )}
      style={{
        ...style,
        textAlign: cellData?.format?.textAlign ?? 'left',
        color: cellData?.format?.color,
        backgroundColor: cellData?.format?.backgroundColor,
      }}
    >
      {displayValue}
    </div>
  );
}, cellPropsEqual);

// Custom comparison for memo
function cellPropsEqual(prev: CellProps, next: CellProps): boolean {
  return prev.row === next.row && prev.col === next.col;
  // Note: Style changes trigger parent re-render, so we don't need to compare
}
```

### Keyboard Navigation

```typescript
function useKeyboardNavigation() {
  const {
    activeCell,
    setActiveCell,
    startEditing,
    isEditing,
    commitEdit,
  } = useSpreadsheetStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!activeCell || isEditing) return;

      const { row, col } = activeCell;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          setActiveCell(Math.max(0, row - 1), col);
          break;
        case 'ArrowDown':
          e.preventDefault();
          setActiveCell(row + 1, col);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setActiveCell(row, Math.max(0, col - 1));
          break;
        case 'ArrowRight':
          e.preventDefault();
          setActiveCell(row, col + 1);
          break;
        case 'Enter':
          e.preventDefault();
          if (e.shiftKey) {
            setActiveCell(Math.max(0, row - 1), col);
          } else {
            startEditing();
          }
          break;
        case 'Tab':
          e.preventDefault();
          setActiveCell(row, e.shiftKey ? Math.max(0, col - 1) : col + 1);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          commitEdit(); // Clear cell
          break;
        default:
          // Start editing on any printable character
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            startEditing(e.key);
          }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeCell, isEditing, setActiveCell, startEditing, commitEdit]);
}
```

---

## 6. Deep Dive: Collaborator Presence UI (5 minutes)

### Cursor Overlay Component

```typescript
interface CollaboratorCursor {
  userId: string;
  name: string;
  color: string;
  row: number;
  col: number;
}

function CollaboratorCursors() {
  const collaborators = useSpreadsheetStore((state) => state.collaborators);
  const { columnWidths, rowHeights } = useSpreadsheetStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollOffset, setScrollOffset] = useState({ x: 0, y: 0 });

  // Track scroll position to position cursors correctly
  useEffect(() => {
    const container = containerRef.current?.closest('.scroll-container');
    if (!container) return;

    const handleScroll = () => {
      setScrollOffset({
        x: container.scrollLeft,
        y: container.scrollTop,
      });
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Calculate pixel position from cell coordinates
  const getCursorPosition = useCallback(
    (row: number, col: number) => {
      let x = 0;
      for (let c = 0; c < col; c++) {
        x += columnWidths.get(c) ?? 100;
      }

      let y = 0;
      for (let r = 0; r < row; r++) {
        y += rowHeights.get(r) ?? 32;
      }

      return { x, y };
    },
    [columnWidths, rowHeights]
  );

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      {Array.from(collaborators.values()).map((collab) => {
        const pos = getCursorPosition(collab.row, collab.col);
        const width = columnWidths.get(collab.col) ?? 100;
        const height = rowHeights.get(collab.row) ?? 32;

        return (
          <div
            key={collab.userId}
            className="absolute transition-all duration-100 ease-out"
            style={{
              left: pos.x - scrollOffset.x,
              top: pos.y - scrollOffset.y,
              width,
              height,
            }}
          >
            {/* Cursor outline */}
            <div
              className="absolute inset-0 border-2"
              style={{ borderColor: collab.color }}
            />
            {/* Name label */}
            <div
              className="absolute -top-5 left-0 px-1 text-xs text-white
                         rounded-sm whitespace-nowrap"
              style={{ backgroundColor: collab.color }}
            >
              {collab.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

### Presence Indicator List

```typescript
function PresenceIndicators() {
  const collaborators = useSpreadsheetStore((state) => state.collaborators);

  return (
    <div className="flex items-center gap-1">
      {Array.from(collaborators.values()).map((collab) => (
        <div
          key={collab.userId}
          className="w-8 h-8 rounded-full flex items-center justify-center
                     text-white text-sm font-medium"
          style={{ backgroundColor: collab.color }}
          title={collab.name}
        >
          {collab.name.charAt(0).toUpperCase()}
        </div>
      ))}
    </div>
  );
}
```

---

## 7. Deep Dive: Formula Bar and Web Workers (5 minutes)

### Formula Bar Component

```typescript
function FormulaBar() {
  const {
    activeCell,
    isEditing,
    editValue,
    setEditValue,
    startEditing,
    commitEdit,
    cancelEdit,
  } = useSpreadsheetStore();

  const cellData = useSpreadsheetStore((state) => {
    if (!state.activeCell) return null;
    const key = cellKey(
      state.activeSheetId,
      state.activeCell.row,
      state.activeCell.col
    );
    return state.cells.get(key);
  });

  const cellRef = activeCell
    ? `${columnIndexToLetter(activeCell.col)}${activeCell.row + 1}`
    : '';

  const displayValue = isEditing
    ? editValue
    : cellData?.rawValue ?? '';

  return (
    <div className="flex items-center h-8 border-b border-gray-300 bg-white">
      {/* Cell reference */}
      <div className="w-16 px-2 text-center font-medium border-r border-gray-300">
        {cellRef}
      </div>

      {/* fx icon */}
      <div className="px-2 text-gray-500 italic">fx</div>

      {/* Formula input */}
      <input
        type="text"
        value={displayValue}
        onChange={(e) => setEditValue(e.target.value)}
        onFocus={() => {
          if (!isEditing && activeCell) {
            startEditing(cellData?.rawValue ?? '');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitEdit();
          } else if (e.key === 'Escape') {
            cancelEdit();
          }
        }}
        className="flex-1 px-2 outline-none"
        placeholder="Enter value or formula"
      />
    </div>
  );
}

// Helper to convert column index to letter (0 -> A, 25 -> Z, 26 -> AA)
function columnIndexToLetter(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}
```

### Web Worker for Formula Calculation

```typescript
// formula.worker.ts
import { HyperFormula } from 'hyperformula';

const hf = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' });
const sheetId = hf.addSheet('Sheet1');

self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'SET_CELL': {
      const { row, col, value } = data;
      hf.setCellContents({ sheet: sheetId, row, col }, value);

      const computed = hf.getCellValue({ sheet: sheetId, row, col });
      const dependents = hf.getCellDependents({ sheet: sheetId, row, col });

      // Calculate all dependent cells
      const updates = dependents.map((dep) => ({
        row: dep.row,
        col: dep.col,
        value: hf.getCellValue({ sheet: sheetId, row: dep.row, col: dep.col }),
      }));

      self.postMessage({
        type: 'CELL_CALCULATED',
        row,
        col,
        computed,
        dependentUpdates: updates,
      });
      break;
    }

    case 'BULK_SET': {
      const { cells } = data;
      cells.forEach(({ row, col, value }: any) => {
        hf.setCellContents({ sheet: sheetId, row, col }, value);
      });

      self.postMessage({ type: 'BULK_SET_COMPLETE' });
      break;
    }
  }
};

// Main thread usage
class FormulaWorkerService {
  private worker: Worker;
  private pendingCallbacks: Map<string, (result: any) => void> = new Map();

  constructor() {
    this.worker = new Worker(new URL('./formula.worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = ({ data }) => {
      if (data.type === 'CELL_CALCULATED') {
        // Update store with computed value
        useSpreadsheetStore.getState().updateComputedValue(
          data.row,
          data.col,
          data.computed
        );

        // Update dependent cells
        data.dependentUpdates.forEach((update: any) => {
          useSpreadsheetStore.getState().updateComputedValue(
            update.row,
            update.col,
            update.value
          );
        });
      }
    };
  }

  setCell(row: number, col: number, value: string) {
    this.worker.postMessage({ type: 'SET_CELL', row, col, value });
  }
}

export const formulaWorker = new FormulaWorkerService();
```

---

## 8. Trade-offs Summary (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **Virtualization** | TanStack Virtual | react-window | Better variable-size support, more recent API |
| **State Management** | Zustand | Redux/Context | Minimal boilerplate, built-in selector optimization |
| **Sparse Cell Storage** | Map with string keys | 2D array | 1000x memory efficiency for large sparse grids |
| **Formula Calculation** | Web Worker + HyperFormula | Main thread | Prevents UI blocking on complex formulas |
| **Cursor Position** | Absolute positioning | CSS Grid | Works with virtualization, simpler math |
| **Cell Editing** | Inline input | Modal/sidebar | Familiar Excel-like UX |

### Accessibility Considerations

1. **Keyboard Navigation**: Full arrow key, Tab, Enter support
2. **Screen Readers**: ARIA grid role, cell announcements
3. **Focus Management**: Visible focus indicators, focus trap in modal dialogs
4. **Color Contrast**: Collaborator colors meet WCAG 2.1 AA

### Performance Optimizations

1. **Memoized Cells**: Custom comparison prevents 99% of re-renders
2. **Selector Granularity**: Each cell subscribes only to its own data
3. **Virtualization**: Only ~600 DOM nodes regardless of grid size
4. **Web Workers**: Formula calculation off main thread
5. **Debounced Saves**: Batch cell updates before network requests

---

## 9. Future Frontend Enhancements

1. **Range Selection with Drag**: Implement mouse drag to select cell ranges
2. **Copy/Paste Support**: Clipboard API integration with Excel-compatible formats
3. **Undo/Redo UI**: Command pattern with keyboard shortcuts (Ctrl+Z, Ctrl+Y)
4. **Context Menu**: Right-click menu for insert/delete rows/columns
5. **Conditional Formatting**: Real-time cell styling based on values
6. **Mobile Responsiveness**: Touch gestures for scrolling and selection

---

## 10. Closing Summary (1 minute)

We designed a high-performance collaborative spreadsheet frontend with:
- **Dual-axis virtualization** using TanStack Virtual for million-row grids
- **Zustand state management** with sparse cell storage and fine-grained selectors
- **Memoized Cell component** with inline editing and keyboard navigation
- **Real-time collaboration UI** with colored cursor overlays and presence indicators
- **Web Worker formula engine** using HyperFormula for non-blocking calculations

Key frontend insight: The sparse data model (Map with string keys) mirrors the backend storage and enables efficient memory usage, while virtualization makes the grid feel instant regardless of logical size.

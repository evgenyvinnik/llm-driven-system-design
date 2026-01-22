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
┌──────────────────────────────────────────────────────────────────────────────┐
│                              SpreadsheetApp                                   │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                              Toolbar                                    │  │
│  │   [FormatButtons]  [FormulaBar]  [ShareButton]  [UndoRedo]             │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                             SheetTabs                                   │  │
│  │   [ Sheet1 ]  [ Sheet2 ]  [ + ]                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                          SpreadsheetGrid                                │  │
│  │  ┌──────────┬───────────────────────────────────────────────────────┐  │  │
│  │  │  Corner  │                  ColumnHeaders                         │  │  │
│  │  ├──────────┼───────────────────────────────────────────────────────┤  │  │
│  │  │   Row    │                                                        │  │  │
│  │  │ Headers  │              VirtualizedCells                          │  │  │
│  │  │          │   ┌─────────┬─────────┬─────────┬─────────┐           │  │  │
│  │  │    1     │   │   A1    │   B1    │   C1    │   D1    │           │  │  │
│  │  │    2     │   ├─────────┼─────────┼─────────┼─────────┤           │  │  │
│  │  │    3     │   │   A2    │   B2    │   C2    │   D2    │           │  │  │
│  │  │    4     │   ├─────────┼─────────┼─────────┼─────────┤           │  │  │
│  │  │          │   │   A3    │   B3    │   C3    │   D3    │           │  │  │
│  │  └──────────┴───┴─────────┴─────────┴─────────┴─────────┘           │  │  │
│  │                                                                      │  │  │
│  │  ┌─────────────────────┐   ┌──────────────────────────────┐         │  │  │
│  │  │  SelectionOverlay   │   │    CollaboratorCursors       │         │  │  │
│  │  └─────────────────────┘   └──────────────────────────────┘         │  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                             StatusBar                                   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
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

"I chose dual-axis virtualization because spreadsheets require independent row and column virtualization. Unlike a simple list, both dimensions can be massive."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Virtualization Concept                             │
│                                                                              │
│   ┌───────────────────────────────────────────────────────────────────────┐ │
│   │                     Logical Grid (1M x 16K)                            │ │
│   │   ┌─────────────────────────────────────────────────────────────────┐ │ │
│   │   │                                                                  │ │ │
│   │   │                                                                  │ │ │
│   │   │       ┌────────────────────────────────┐                        │ │ │
│   │   │       │   Visible Viewport             │                        │ │ │
│   │   │       │   (only ~600 cells rendered)   │                        │ │ │
│   │   │       │                                │                        │ │ │
│   │   │       │   overscan: 10 rows above/below│                        │ │ │
│   │   │       │   overscan: 5 cols left/right  │                        │ │ │
│   │   │       └────────────────────────────────┘                        │ │ │
│   │   │                                                                  │ │ │
│   │   │                                                                  │ │ │
│   │   └─────────────────────────────────────────────────────────────────┘ │ │
│   └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Row Virtualizer Configuration:**
- count: 1,000,000 logical rows
- estimateSize: returns row height from Map or default (32px)
- overscan: 10 extra rows above/below viewport

**Column Virtualizer Configuration:**
- horizontal: true
- count: 16,384 columns
- estimateSize: returns column width from Map or default (100px)
- overscan: 5 extra columns left/right

### Variable Row/Column Sizes

Dimension data stored in sparse Maps:
- columnWidths: Map<number, number> - only stores non-default widths
- rowHeights: Map<number, number> - only stores non-default heights

**Resize Handle Pattern:**
- Mouse down captures start position and current width
- Mouse move calculates delta and updates store
- Mouse up removes listeners
- Minimum width enforced (50px)

### Memory Efficiency

| Scenario | DOM Nodes | Without Virtualization |
|----------|-----------|------------------------|
| Viewport 30x20 visible | ~600 | ~600 |
| 1M rows x 1K cols sheet | ~600 | 1,000,000,000 (crash) |

---

## 4. Deep Dive: State Management with Zustand (7 minutes)

### Store Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SpreadsheetStore                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Document State                                                              │
│  ├── spreadsheetId: string                                                   │
│  ├── sheets: Sheet[]                                                         │
│  └── activeSheetId: string                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Sparse Cell Data                                                            │
│  └── cells: Map<string, CellData>    Key format: "sheetId-row-col"          │
├─────────────────────────────────────────────────────────────────────────────┤
│  Selection State                                                             │
│  ├── activeCell: { row, col } | null                                         │
│  ├── selection: CellRange | null                                             │
│  ├── isEditing: boolean                                                      │
│  └── editValue: string                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  Collaborators                                                               │
│  └── collaborators: Map<string, Collaborator>                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Dimensions (sparse)                                                         │
│  ├── columnWidths: Map<number, number>                                       │
│  └── rowHeights: Map<number, number>                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  History                                                                     │
│  ├── undoStack: Operation[]                                                  │
│  ├── redoStack: Operation[]                                                  │
│  ├── canUndo: boolean                                                        │
│  └── canRedo: boolean                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Actions                                                                     │
│  ├── setCell(row, col, value)                                                │
│  ├── setActiveCell(row, col)                                                 │
│  ├── startEditing(initialValue?)                                             │
│  ├── commitEdit()                                                            │
│  ├── cancelEdit()                                                            │
│  ├── undo() / redo()                                                         │
│  └── updateCollaborator() / removeCollaborator()                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Sparse Cell Data Pattern

"I use sparse storage because most spreadsheet cells are empty. Storing only non-empty cells reduces memory from O(rows * cols) to O(filled cells)."

**CellData Structure:**
- rawValue: string | null (what user typed, e.g., "=SUM(A1:A10)")
- computedValue: any (calculated result, e.g., 42)
- format?: CellFormat (bold, color, alignment)
- error?: string (formula errors like "#REF!")

**Cell Key Generation:**
- Format: `${sheetId}-${row}-${col}`
- Enables O(1) lookup for any cell
- Empty cells return null (not stored)

**setCell Logic:**
1. Generate key from sheetId, row, col
2. If value is empty/null, delete from Map (sparse)
3. Otherwise, set value with rawValue and initial computedValue
4. Send to server via WebSocket for sync

### Selector Optimization

"Fine-grained selectors prevent unnecessary re-renders. Each cell subscribes only to its own data slice."

**Cell Component Subscriptions:**
- cellData: subscribes to cells.get(key) for this specific cell
- isActive: subscribes to activeCell comparison with row/col
- isSelected: subscribes to selection range check

Each selector uses useCallback with [row, col] dependencies to maintain referential stability.

---

## 5. Deep Dive: Cell Component and Editing (7 minutes)

### Memoized Cell Rendering

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Cell Component Lifecycle                            │
│                                                                              │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│   │   Render    │────▶│   Click     │────▶│   Active    │                   │
│   │  (display)  │     │  (select)   │     │  (focused)  │                   │
│   └─────────────┘     └─────────────┘     └──────┬──────┘                   │
│                                                   │                          │
│                              Double-click or type │                          │
│                                                   ▼                          │
│                                           ┌─────────────┐                   │
│                                           │   Editing   │                   │
│                                           │  (input)    │                   │
│                                           └──────┬──────┘                   │
│                                                   │                          │
│                              Enter, Tab, or blur │                          │
│                                                   ▼                          │
│                                           ┌─────────────┐                   │
│                                           │   Commit    │                   │
│                                           │  (save)     │                   │
│                                           └─────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Cell Props:**
- row: number
- col: number
- style: React.CSSProperties (position from virtualizer)

**Display Mode:**
- Shows computedValue or rawValue or empty string
- Applies format styling (bold, italic, color, alignment)
- Shows ring border when active
- Shows light blue background when selected

**Edit Mode (when isEditingThis):**
- Renders autoFocus input overlay
- Captures keydown for Enter (commit), Escape (cancel), Tab (commit + move)
- Commits on blur
- Value stored in editValue state

**Custom Memo Comparison:**
Only compares row and col - style changes trigger parent re-render anyway.

### Keyboard Navigation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Keyboard Navigation Map                              │
│                                                                              │
│   Arrow Keys (when not editing):                                             │
│   ├── ArrowUp    ──▶  Move to row - 1 (min 0)                               │
│   ├── ArrowDown  ──▶  Move to row + 1                                       │
│   ├── ArrowLeft  ──▶  Move to col - 1 (min 0)                               │
│   └── ArrowRight ──▶  Move to col + 1                                       │
│                                                                              │
│   Entry Keys:                                                                │
│   ├── Enter          ──▶  Start editing (or move down if editing)           │
│   ├── Shift+Enter    ──▶  Move up                                           │
│   ├── Tab            ──▶  Move right (commit if editing)                    │
│   ├── Shift+Tab      ──▶  Move left (commit if editing)                     │
│   └── Any printable  ──▶  Start editing with that character                 │
│                                                                              │
│   Destructive Keys:                                                          │
│   ├── Delete         ──▶  Clear cell content                                │
│   └── Backspace      ──▶  Clear cell content                                │
│                                                                              │
│   Edit Mode Only:                                                            │
│   └── Escape         ──▶  Cancel edit, restore original value               │
└─────────────────────────────────────────────────────────────────────────────┘
```

Navigation is handled by a custom hook that listens to document keydown events and only acts when not editing.

---

## 6. Deep Dive: Collaborator Presence UI (5 minutes)

### Cursor Overlay Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Collaborator Cursor Display                           │
│                                                                              │
│   ┌───────────────────────────────────────────────────────────────────────┐ │
│   │                           Grid View                                    │ │
│   │                                                                        │ │
│   │      ┌─────────┬─────────┬─────────┬─────────┐                        │ │
│   │      │   A1    │   B1    │   C1    │   D1    │                        │ │
│   │      ├─────────┼─────────┼─────────┼─────────┤                        │ │
│   │      │   A2    │ ┌─────┐ │   C2    │   D2    │                        │ │
│   │      │         │ │Alice│ │         │         │   ◀── Colored border   │ │
│   │      │         │ └─────┘ │         │         │       + name label     │ │
│   │      ├─────────┼─────────┼─────────┼─────────┤                        │ │
│   │      │   A3    │   B3    │ ┌─────┐ │   D3    │                        │ │
│   │      │         │         │ │ Bob │ │         │                        │ │
│   │      │         │         │ └─────┘ │         │                        │ │
│   │      └─────────┴─────────┴─────────┴─────────┘                        │ │
│   │                                                                        │ │
│   └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

**CollaboratorCursor Data Structure:**
- userId: string
- name: string (display name)
- color: string (unique per user, hex color)
- row: number (current cell row)
- col: number (current cell column)

**Position Calculation:**
- Sum column widths from 0 to col for X position
- Sum row heights from 0 to row for Y position
- Adjust for scroll offset from container

**Rendering:**
- Absolute positioned div with pointer-events: none
- Colored border matching collaborator's assigned color
- Name label positioned above the cell
- Smooth transition animation (100ms ease-out)

### Presence Indicator List

Displayed in header/toolbar area:
- Circular avatars with first letter of name
- Background color matches cursor color
- Tooltip shows full name on hover
- Max display count with "+N more" overflow

---

## 7. Deep Dive: Formula Bar and Web Workers (5 minutes)

### Formula Bar Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Formula Bar Layout                                │
│                                                                              │
│   ┌──────────┬────────┬─────────────────────────────────────────────────┐   │
│   │   A1     │   fx   │  =SUM(A1:A10)                                   │   │
│   │ (cell    │ (icon) │  (formula/value input)                          │   │
│   │  ref)    │        │                                                 │   │
│   └──────────┴────────┴─────────────────────────────────────────────────┘   │
│                                                                              │
│   Cell Reference: Shows current cell address (A1, B2, etc.)                  │
│   fx Icon: Indicates formula mode                                            │
│   Input: Shows rawValue when editing, syncs with cell edit                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**columnIndexToLetter Helper:**
- 0 -> A, 25 -> Z, 26 -> AA, etc.
- Uses modulo 26 and character code math
- Handles arbitrary column numbers

**FormulaBar Behavior:**
- Displays cell reference for active cell
- Shows rawValue (formula) not computedValue
- Focus starts editing mode
- Enter commits, Escape cancels
- Syncs with inline cell editing

### Web Worker for Formula Calculation

"I offload formula calculation to a Web Worker to prevent UI blocking. Complex formulas with many dependencies could take 100ms+ to calculate."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Formula Calculation Architecture                        │
│                                                                              │
│   ┌─────────────────────┐                    ┌─────────────────────────┐    │
│   │     Main Thread     │                    │      Web Worker         │    │
│   │                     │   postMessage      │                         │    │
│   │  User edits cell    │ ───────────────▶   │  HyperFormula engine   │    │
│   │  with formula       │                    │                         │    │
│   │                     │   SET_CELL         │  - Parse formula        │    │
│   │  Update store       │ ◀───────────────── │  - Calculate result     │    │
│   │  with computed      │   CELL_CALCULATED  │  - Find dependents      │    │
│   │  value              │                    │  - Cascade updates      │    │
│   │                     │                    │                         │    │
│   │  UI remains         │                    │  Runs in separate       │    │
│   │  responsive         │                    │  thread                 │    │
│   └─────────────────────┘                    └─────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Worker Messages:**
- SET_CELL: { row, col, value } -> triggers calculation
- CELL_CALCULATED: { row, col, computed, dependentUpdates } -> results
- BULK_SET: { cells } -> batch initialization

**HyperFormula Integration:**
- Open-source spreadsheet formula engine
- Handles 400+ Excel functions
- Dependency graph for cascade updates
- Runs entirely in worker

**FormulaWorkerService Pattern:**
- Singleton service instantiates worker
- setCell method posts message
- onmessage handler updates store with computed values
- Handles dependent cell cascades

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

"We designed a high-performance collaborative spreadsheet frontend with:
- **Dual-axis virtualization** using TanStack Virtual for million-row grids
- **Zustand state management** with sparse cell storage and fine-grained selectors
- **Memoized Cell component** with inline editing and keyboard navigation
- **Real-time collaboration UI** with colored cursor overlays and presence indicators
- **Web Worker formula engine** using HyperFormula for non-blocking calculations

Key frontend insight: The sparse data model (Map with string keys) mirrors the backend storage and enables efficient memory usage, while virtualization makes the grid feel instant regardless of logical size."

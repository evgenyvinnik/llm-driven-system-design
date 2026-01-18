# Google Sheets - Development with Claude

## Project Context

A collaborative spreadsheet application focusing on real-time multi-user editing, similar to Google Sheets.

## Key Design Decisions

### Virtualization with TanStack Virtual
**Decision:** Use @tanstack/react-virtual for row and column virtualization
**Rationale:**
- Modern, well-maintained library
- Supports both horizontal and vertical virtualization
- Efficient for large grids (1000+ rows/columns)
- Framework-agnostic core with React bindings

### WebSocket for Real-Time Sync
**Decision:** Native WebSocket with custom protocol instead of Socket.io
**Rationale:**
- Lower overhead than Socket.io
- More control over message format
- Simpler for this use case (no fallback needed)
- Built-in browser support

### Sparse Cell Storage
**Decision:** Store only non-empty cells in database and state
**Rationale:**
- Massive storage efficiency (most cells are empty)
- Faster queries and state updates
- Natural fit for spreadsheet data model

### Last-Write-Wins Conflict Resolution
**Decision:** Simple per-cell last-write-wins instead of OT/CRDT
**Rationale:**
- Much simpler to implement
- Good enough for learning purposes
- Each cell is independent unit
- Real conflicts are rare in practice

### State Management with Zustand
**Decision:** Zustand instead of Redux or Context
**Rationale:**
- Minimal boilerplate
- Excellent TypeScript support
- Built-in selector optimization
- No need for complex middleware

## Implementation Phases

### Phase 1: Core Grid (Completed)
- [x] Virtualized grid with TanStack Virtual
- [x] Cell component with editing
- [x] Selection (single cell)
- [x] Keyboard navigation
- [x] Column/row headers

### Phase 2: Collaboration (Completed)
- [x] WebSocket server setup
- [x] Connection management
- [x] Cell edit broadcasting
- [x] Cursor position sharing
- [x] User presence indicators
- [x] Collaborator cursor overlays

### Phase 3: Data Persistence (Completed)
- [x] PostgreSQL schema
- [x] Cell CRUD operations
- [x] Spreadsheet/sheet management
- [x] REST API

### Phase 4: Polish (Planned)
- [ ] HyperFormula for formulas
- [ ] Column/row resize handles
- [ ] Range selection
- [ ] Copy/paste
- [ ] Undo/redo
- [ ] Cell formatting

## Technical Challenges

### Cell Memoization
React re-renders can be expensive with thousands of cells. Solution:
- Memoized Cell component with custom comparison
- Selector-based state access to minimize re-renders
- Virtualization limits DOM nodes

### WebSocket Reconnection
Need to handle disconnects gracefully:
- Heartbeat (ping/pong) every 30 seconds
- Full state sync on reconnect
- Optimistic updates with server confirmation

### Cursor Position Calculation
Converting cell coordinates to pixel positions:
- Sum row heights/column widths up to target
- Cache calculations where possible
- Update on resize events

## Resources

- [TanStack Virtual Docs](https://tanstack.com/virtual/latest)
- [Building a Spreadsheet in React](https://medium.com/@nicholasszalkoski/building-a-spreadsheet-in-react-with-ag-grid-1d5c2a1e5ae2)
- [Operational Transformation](https://en.wikipedia.org/wiki/Operational_transformation)
- [HyperFormula Guide](https://hyperformula.handsontable.com/)

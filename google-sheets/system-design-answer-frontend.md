# Google Sheets Frontend — System Design Answer

## 45–50 minute interview walkthrough

## Opening — 2 minutes

“I’ll design a collaborative spreadsheet frontend. The unique challenge is a logically enormous two-dimensional grid where only a tiny viewport is visible, while edits, formulas, selection, presence, and collaboration all need to feel immediate. I’ll separate the sparse document model from viewport rendering and from the lossless operation stream.”

| RADIO stage | Focus | Time |
|---|---|---:|
| Requirements | Spreadsheet workflows, scale, collaboration, and correctness | 4 min |
| Architecture | Grid shell, sparse store, virtualization, worker, sync | 8 min |
| Data model | Cells, formulas, operations, viewport, presence | 6 min |
| Interfaces | REST, operation stream, worker, grid contracts | 8 min |
| Optimizations | Virtualization, formulas, editing, collaboration, a11y | 18–22 min |
| Wrap-up | Trade-offs and failure modes | 3 min |

## R — Requirements — 4 minutes

### Clarifying questions

- How large can a sheet be logically and how much data is normally populated?
- Do we need formulas, ranges, formatting, charts, and import/export in the core flow?
- Is collaboration simultaneous and character-level, or is row/document locking enough?
- What are the conflict and offline expectations?
- Do screen readers and keyboard-only workflows need first-class support?
- Is the app desktop-first, touch-first, or both?

I’ll assume desktop-first collaborative spreadsheets with million-cell logical dimensions, sparse populated cells, formulas, formatting, multi-user presence, keyboard navigation, and a 10-second reconnect tolerance. Mobile viewing is in scope; full mobile editing is a follow-up.

### Functional requirements

1. Open workbooks and switch between sheets.
2. Render only the visible grid while preserving arbitrary row and column sizes.
3. Select cells and ranges, navigate with keyboard, and edit values in place.
4. Support formulas and update dependent cells after an edit.
5. Collaborate with remote cursors and remote cell changes.
6. Undo, redo, copy, paste, and save edits.
7. Recover from reconnects and surface conflicts clearly.

### Non-functional requirements

- Scroll and selection should remain responsive at 60fps.
- Editing a cell should not rerender the entire grid.
- Formula recalculation should not block typing or scrolling.
- Durable operations must not be lost or silently duplicated.
- Presence may be approximate and lossy.
- Memory should scale with populated/visible data, not logical sheet dimensions.

### Out of scope

I will not design the full formula language, server-side conflict algorithm, spreadsheet file format, or external integration ecosystem. I will define the client model and protocols they require.

## A — Architecture — 8 minutes

### High-level diagram

``` 
┌────────────────────────────────────────────────────────────────────────────┐
│ Spreadsheet Shell                                                           │
│ routing · workbook tabs · toolbar · keyboard · selection · accessibility    │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ Viewport Controller           │ Grid Renderer                                │
│ scroll · measured sizes       │ visible rows/columns · cell layers           │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ Sparse Document Store                                                       │
│ cells · formatting · formulas · selections · undo/redo                     │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ Formula Worker                │ Sync Coordinator                             │
│ dependency graph · compute   │ operations · revisions · reconnect           │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ Typed API client ─────────── HTTPS / WebSocket ───────── Workbook API        │
└────────────────────────────────────────────────────────────────────────────┘
```

### Shell and viewport

The shell owns workbook navigation, toolbar actions, selection, active cell, formula bar, dialogs, keyboard shortcuts, and accessibility announcements. The viewport controller converts scroll position and measured row/column sizes into a visible coordinate window.

The grid renderer does not create a DOM element for every logical cell. It renders a bounded window with spacer regions and reuses cells as the viewport moves. The row and column headers share the same coordinate system so scrolling does not drift.

### Sparse store

The document store uses coordinate keys such as sheet, row, and column to store populated cells. A two-dimensional array wastes memory when a sheet has a million possible cells and only a few thousand values. Selectors are keyed by cell so editing A1 does not rerender the visible grid.

### Formula worker

Formula calculation belongs in a Web Worker when dependency graphs or recalculation batches become large. The worker receives cell operations and a serializable dependency graph, then returns computed values, errors, and dependent-cell updates. It never owns the authoritative document; it owns derived calculation state.

### Sync coordinator

Durable edits are represented as operations with IDs, base revisions, and cell patches. The sync coordinator queues operations, sends them in order, applies acknowledgements, handles conflicts, and resynchronizes after a connection gap. Presence travels through a separate lossy channel.

## D — Data Model — 6 minutes

| Entity | Owner | Important fields | Consistency |
|---|---|---|---|
| `Workbook` | workbook store | ID, sheet IDs, permissions, revision | server-authoritative |
| `Sheet` | workbook store | ID, name, dimensions, row/column metadata | server-authoritative |
| `CellValue` | sparse store | sheet, row, column, raw value, formatted value | operation-backed |
| `FormulaDependency` | formula worker | source cell, dependencies, result, error | derived |
| `EditOperation` | sync queue | operation ID, base revision, cell patch, author | durable and ordered |
| `SelectionState` | shell | active cell, ranges, editing mode | ephemeral client state |
| `ViewportState` | viewport controller | scroll offsets, visible bounds, measured sizes | ephemeral client state |
| `PresenceCursor` | presence store | user, sheet, range, color, last seen | best effort |
| `UndoEntry` | history manager | forward op, inverse op, revision context | local history |

The grid store should not contain raw WebSocket messages or query response metadata. It contains the canonical client document projection. The sync queue contains operations waiting for acknowledgement. The formula worker contains derived values that can be recomputed.

### Operation semantics

An edit operation identifies its author, command ID, base revision, affected cell keys, and new values. The server acknowledges a new revision or returns a conflict. The client can optimistically display a local edit, but it must retain the operation until acknowledged.

For a first version, cell-level last-write-wins with visible conflict indicators may be enough. For a mature collaborative product, operations may use OT or CRDT semantics. The frontend contract should not depend on the server algorithm; it depends on ordered IDs, revisions, acknowledgements, and resync.

### Formula semantics

Raw input, parsed formula, computed value, and error are separate fields. A formula cell can display its last computed value while a new calculation is pending, but it must expose that state when the result is stale or errored. Circular references are a typed error, not a blank cell.

## I — Interfaces — 8 minutes

### Server-facing API

``` 
GET  /api/workbooks/:id                       → workbook metadata and sheet list
GET  /api/sheets/:id/viewport?range=...      → sparse cells for visible range
POST /api/sheets/:id/operations              → ordered cell operations
GET  /api/sheets/:id/operations?after=...    → missed operations for resync
POST /api/sheets/:id/undo                    → server-aware undo command
WSS  /api/workbooks/:id/collaboration        → operations and presence
```

The viewport response contains sparse cells, row/column metadata, a document revision, and pagination or continuation information for large ranges. An operations response contains accepted IDs, canonical revision, rebased operations, and conflicts.

The WebSocket protocol separates durable operation messages from presence messages. Operations have sequence and acknowledgement semantics. Presence messages have expiry and may be coalesced because the latest cursor supersedes the previous cursor.

### Client interfaces

| Interface | Inputs | Output/event | Responsibility |
|---|---|---|---|
| `ViewportController` | scroll, dimensions, measured sizes | visible coordinates | bounded render window |
| `CellStore` | cell key, operation projection | cell snapshot | fine-grained subscriptions |
| `FormulaWorker` | edit batch, dependency graph | computed values/errors | non-blocking calculation |
| `SyncQueue` | operation, base revision | ack, conflict, resync | durable retry and ordering |
| `GridRenderer` | visible cells, selection, theme | DOM/canvas layers | presentation only |
| `PresenceChannel` | cursor, range, user color | remote cursor event | lossy collaboration UI |

### Cell and grid component APIs

The grid receives a viewport window, visible cell snapshots, row/column metrics, selection state, and callbacks for pointer and keyboard actions. A cell receives its coordinate, raw/formatted value, edit state, validation status, and narrow callbacks such as begin edit and commit edit.

The cell does not read the entire store. The formula bar reads the active cell and writes an edit command through the shell. The toolbar dispatches commands such as undo, redo, format, and paste through a command layer so keyboard and pointer actions share behavior.

## O — Optimizations and Deep Dives — 18–22 minutes

### Deep dive 1: Two-dimensional virtualization

A normal list virtualizer handles one axis. A spreadsheet needs row and column windows, variable row heights, variable column widths, frozen headers, and a stable coordinate transform. The viewport controller calculates visible row and column ranges, overscans a small buffer, and renders only their intersection.

The alternative is to render every populated cell. It works for a small demo but fails when a user pastes into thousands of cells or opens a wide sheet. Virtualization reduces DOM work, but it introduces measurement complexity and risks focus loss when cells are recycled. The active editing cell therefore receives a stable editor overlay tied to its coordinate rather than relying only on a recycled cell node.

### Deep dive 2: Sparse state versus a two-dimensional array

A two-dimensional array is simple to index but allocates or implies storage for empty space. A sparse map keyed by sheet, row, and column makes memory proportional to populated cells and supports server viewport responses naturally.

The trade-off is more key parsing and slower range iteration. I mitigate it with row/column indexes or a chunked map for the visible region. The invariant is that cell selectors remain stable and updates can be applied by coordinate without copying the entire sheet.

### Deep dive 3: Main thread versus formula worker

Formula evaluation on the main thread is easy to integrate and gives immediate access to the store. It becomes a problem when a paste triggers thousands of dependents or complex functions. A worker keeps typing and scrolling responsive, but messages require serialization and computed results arrive asynchronously.

The worker receives immutable snapshots or operation batches and returns deterministic computed updates. The store accepts a result only if it corresponds to the current document revision. That prevents a slow calculation for an old edit from overwriting a newer value.

### Deep dive 4: Operation sync and collaboration

The client applies local edits immediately, puts operations in a durable queue, and sends them in order. Acknowledgements remove operations from the queue. A reconnect asks for operations after the last confirmed revision. A conflict returns enough information to rebase or show the affected cells.

I would not use one generic event channel for presence and edits. Presence is lossy, expires, and should never block saving. Edits are durable, ordered, and must be retried. One transport may carry both, but the protocol and state machines stay separate.

### Deep dive 5: Undo and redo

Undo should create an inverse operation rather than mutate the store directly. That makes undo collaborative: the inverse is sent through the same revision and permission path as any other edit. The UI can maintain local undo history, but a failed inverse operation must remain visible as a conflict instead of pretending the cell changed.

### Accessibility and editing UX

The grid uses a table/grid semantic model with clear row and column headers. Keyboard navigation moves the active cell without forcing a DOM node for every logical cell. Enter begins editing, Escape cancels, Tab commits and advances, and the formula bar mirrors the active cell.

Screen readers need announcements for selection, edit mode, validation errors, and collaboration changes that affect the active cell. High-frequency remote cursor movement should not be announced. Color-coded collaborator cursors include names or labels.

### Failure matrix

| Failure | UI state | Recovery |
|---|---|---|
| Viewport request fails | visible range error | retry range without losing selection |
| Operation POST times out | pending edit indicator | retry same operation ID |
| Revision conflict | affected cells marked | rebase or user review |
| Formula worker fails | stale calculation badge | restart worker and recompute |
| Socket disconnects | offline/sync banner | reconnect and request missed ops |
| Browser refresh with queue | recovery prompt | restore queued operations or discard |

## Performance and scaling

The first bottleneck is DOM count when the user opens a wide or tall sheet. Two-dimensional virtualization and fixed overscan protect layout. The second is formula recalculation; worker boundaries and revision checks protect input. The third is operation history and undo memory; history should be bounded and compress repeated local edits where safe.

I would measure scroll frame rate, active-cell latency, visible cell count, formula worker duration, operation acknowledgement latency, queue depth, resync duration, and memory after a long editing session.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Grid rendering | two-dimensional virtualization | render populated cells | bounded DOM and memory |
| Cell model | sparse coordinate map | two-dimensional array | empty sheets do not allocate huge structures |
| Formula execution | worker with revision checks | main thread | protects typing and scrolling |
| Edit sync | ordered operations | full-document saves | smaller conflicts and safer reconnects |
| Presence | lossy separate channel | durable operation stream | cursor updates can be dropped |
| Undo | inverse operation | direct local mutation | collaboration and permissions stay consistent |
| Editing node | stable overlay | recycled cell only | preserves focus while virtualizing |
| Mobile | view-first support | full spreadsheet editing | touch editing is a separate interaction design |

## Closing — 3 minutes

“The spreadsheet frontend works because the logical document, the visible viewport, the formula engine, and the collaboration stream are separate. Sparse storage prevents memory growth, virtualization bounds rendering, workers protect interaction, and operation IDs make reconnects safe. Presence can be approximate; cell edits cannot.”

If time remains, I would discuss range selection, copy/paste, import/export, formula language compatibility, and whether a CRDT is justified by the required collaboration model.

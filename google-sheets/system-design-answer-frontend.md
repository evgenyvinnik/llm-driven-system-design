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
│                         React SPA (Vite + TypeScript)                       │
│ Routes: /workbooks list · /workbooks/$id/sheets/$sheetId grid              │
│         /workbooks/$id/share permissions and collaborators                 │
│                                                                            │
│ ┌──────────────┐ ┌────────────────┐ ┌────────────────┐ ┌───────────────┐ │
│ │ authStore    │ │ workbookStore  │ │ gridStore      │ │ formulaStore  │ │
│ │ session and  │ │ sheets, tabs,  │ │ viewport,      │ │ values, errors│ │
│ │ permissions  │ │ metadata       │ │ selection      │ │ dependencies  │ │
│ └──────────────┘ └───────▲────────┘ └──────▲─────────┘ └──────▲────────┘ │
│                          │ fetch            │ scroll/edit       │ worker   │
│ ┌────────────────────────┴──────────────────┐ ┌───────────────┴─────────┐ │
│ │ Viewport and grid renderers                │ │ Sync coordinator        │ │
│ │ 2D virtualization · cell layers            │ │ operations · revisions  │ │
│ └────────────────────────────────────────────┘ │ reconnect · presence    │ │
│                                                └─────────────────────────┘ │
│ Typed API client: snapshots · operations · resync · permissions             │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ HTTPS / WebSocket
                         ┌───────────▼───────────┐
                         │ Workbook API          │
                         │ sheets · cells ·      │
                         │ operations · presence │
                         └───────────────────────┘
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

### Route lifecycle and sheet loading

The workbook route loads workbook metadata and sheet tabs first, then requests a bounded viewport for the active sheet. This lets the shell show the workbook name, tabs, and permissions while grid data arrives. Switching tabs cancels the old viewport request but can preserve the active cell per sheet.

The URL identifies workbook and sheet, while zoom, scroll position, and selection remain local session state. A shared link opens the right document and sheet without serializing a huge viewport into the URL.

### Paste and bulk edit flow

Paste is normalized into a batch of cell operations before it reaches the sync queue. The client validates size, formulas, and supported types, then applies a local projection so the user sees the result immediately. The server can accept the batch atomically or return per-cell validation errors according to the contract.

Sending one request per cell simplifies individual retries but creates thousands of operations for a large paste. A bounded batch preserves ordering and gives the server a clear unit for authorization and revision checks.

### Formula and formatting boundaries

Raw cell value, formula text, computed value, and display format are separate fields. Formatting should not be inferred from the computed value because a user can intentionally display a number as currency, percentage, or date. The worker calculates derived values, while the document store remains authoritative for content and formatting.

When a formula references a cell outside the loaded viewport, the worker needs either a document snapshot or an explicit dependency fetch. It must not silently treat an unloaded cell as empty. The UI can show calculating or unavailable while the dependency resolves.

### Testing and observability

I would test coordinate transforms, frozen panes, recycled-cell focus, paste batching, formula revision guards, reconnect replay, and undo after a remote edit. Browser performance tests should measure scroll and edit latency with sparse and dense sheets separately.

Telemetry records active-cell latency, viewport render duration, worker queue depth, operation retry rate, resync count, and conflict frequency. It should never include cell contents in ordinary telemetry.

### Capacity assumptions and extension decisions

I would benchmark a workbook with a million logical coordinates, a few thousand populated cells, a dense pasted range, and several collaborators. The logical sheet can be enormous while the browser keeps only a bounded viewport, sparse records, and the dependencies needed for visible formulas.

If users open many sheets, tabs and metadata load independently from cell ranges. If a formula depends on a remote range, the formula service can provide a dependency snapshot without forcing the grid to render that range. This keeps the rendering contract focused on visible coordinates.

The grid, formula engine, and collaboration sync are strong module boundaries, but I would not place each in an iframe. They share selection, focus, keyboard shortcuts, revision state, and render timing. A worker is the right isolation for formula calculation; a module registry is enough for specialized cell renderers. An iframe would be justified only for an untrusted add-on or a separate document security domain.

### Extension and compatibility model

Cell renderers should receive a coordinate, formatted value, edit lifecycle, and accessibility metadata rather than the entire workbook store. This allows date, currency, and custom cell families to evolve without coupling them to synchronization.

The workbook protocol should version operation and snapshot formats. A newer client can reject an unsupported operation with a visible compatibility state instead of applying an incomplete edit. Resync returns a canonical snapshot and revision, so recovery does not depend on replaying an unbounded local history.

### Alternative architecture review

The simplest sheet renders a table of cells and saves the whole document on change. It is acceptable for a small grid but fails on sparse million-cell coordinates, large pastes, and collaboration.

A canvas renderer can reduce DOM count, but it makes editing semantics, selection, and accessibility harder. I would keep the grid coordinate model and use DOM layers or a hybrid renderer where semantics require it. The renderer is an adapter, not the owner of spreadsheet truth.

An iframe per sheet would isolate failures but would break shared workbook tabs, keyboard navigation, formula-bar focus, and operation ordering. A worker is the better boundary for calculation; a module contract is enough for specialized cell renderers. Stronger isolation is reserved for untrusted add-ons.

### API semantics worth making explicit

- Viewport reads identify workbook, sheet, coordinate range, and revision.
- Cell operations have stable IDs and a base revision.
- Batches define whether acceptance is atomic or per-cell.
- Acknowledgements include canonical values and the resulting revision.
- Resync returns a snapshot plus revision, not only missing UI events.
- Presence is best effort and never blocks durable edits.
- Formula results include the document revision that produced them.
- Permissions are checked again when an operation is accepted.

### Presentation checkpoints

I begin with the user journey: open a large sheet, scroll, edit a cell, paste a range, and see another collaborator’s change.

I trace that journey through route state, viewport calculation, sparse selectors, worker computation, operation queue, and acknowledgement.

I pause on why a two-dimensional viewport and sparse store solve different problems: one bounds rendering, the other bounds memory.

I close by explaining why a worker protects responsiveness while the sync coordinator protects correctness.

### Implementation sequence

1. Build workbook routes, tabs, permissions, and a bounded read-only grid.
2. Add coordinate-based selection and a stable editing overlay.
3. Add sparse cell state, viewport reads, and two-dimensional virtualization.
4. Add local operations, acknowledgements, retries, and revision-aware resync.
5. Add formula calculation in a worker with document-revision guards.
6. Add presence as a separate lossy channel.
7. Add bulk paste, inverse-operation undo, and dense-sheet performance tests.

### Design review questions

The first question is whether the grid can scroll through an empty million-cell sheet without allocating a million cells. If not, virtualization and sparse storage are not truly separated.

The second is whether a slow formula calculation can overwrite a newer edit. If not, worker results need revision metadata.

The third is whether a reconnect can recover from a missing operation without trusting a guessed local sequence. If not, the sync protocol needs a canonical snapshot path.

The fourth is whether a collaborator cursor can disappear without affecting a saved edit. If not, presence and durable operations are coupled incorrectly.

### What I would validate first

I would benchmark scroll and edit latency for a sparse sheet, a dense pasted range, and a formula-heavy region. I would then drop the socket during an edit and verify that the operation queue, worker result, and viewport remain coherent.

The success criteria are stable focus, bounded visible DOM, revision-safe formula results, and an explicit recovery path after a missing operation or expired cursor.

I would ask whether formula evaluation must match a desktop spreadsheet exactly, whether offline editing is required, and whether a single workbook can be edited by thousands of users. Those answers determine worker compatibility, queue semantics, and whether collaboration needs partitioning.

I would also ask whether the server returns viewport data or a full document snapshot. A viewport API favors bounded startup; a snapshot favors offline formulas but requires stronger memory and permission controls.

The final handoff is a route-oriented shell, sparse coordinate state, a bounded grid renderer, revision-aware formula workers, and a durable operation protocol. It keeps visible editing fast without pretending that rendering, calculation, collaboration, and persistence are one problem.

The strongest trade-off is treating a worker as a derived computation boundary rather than a second source of truth. That adds revision checks and message serialization, but prevents a slow formula result from corrupting a newer edit.

The other key trade-off is using a viewport API instead of always downloading a workbook. It complicates dependency fetching, but protects startup time, memory, and permissions for large sheets.

### Final interviewer prompts

- What is authoritative: cell or worker?
- How is a range pasted?
- What survives a reconnect?
- Can presence block edits?
- How is focus preserved?
- What is the resync boundary?

The answers should consistently point back to the sparse store, revision metadata, bounded rendering, and durable operation queue.

The architecture is complete when these answers are visible in the interfaces, not only stated in the interview narrative.

That is the standard I would use for the presentation.

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

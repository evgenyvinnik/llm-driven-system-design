# Google Sheets Full-Stack — System Design Answer

## 45–50 minute interview walkthrough

| Segment | Focus | Time |
|---|---|---:|
| Requirements | Editing and collaboration promises | 4 min |
| Architecture | Grid, sync service, formula workers, storage | 8 min |
| Data model | Cells, operations, revisions, client viewport | 6 min |
| Interfaces | REST, WebSocket, batch edits, resync | 8 min |
| Deep dives | Virtualization, conflicts, formulas, undo | 20 min |
| Trade-offs and close | Scale and rollout | 4 min |

## Opening — 2 minutes

I am designing a collaborative spreadsheet. Users open a workbook, scroll through a very large grid, edit cells, paste ranges, calculate formulas, and see collaborators’ selections and changes.

The browser must render a bounded viewport and remain responsive while the backend persists operations and coordinates revisions. Formula results are derived state. Durable cell edits and document revisions are authoritative.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether formulas must match a desktop spreadsheet, whether offline editing is required, and how many collaborators can edit one sheet. I will support common formulas, online collaboration, and saved local drafts before full offline mutation replay.

I would ask whether users can share a workbook with different permissions. I will assume viewer, commenter, and editor roles enforced by the server.

### Functional requirements

- Create workbooks and sheets.
- Load a bounded viewport from a large logical grid.
- Edit values, formulas, formatting, rows, and columns.
- Paste a bounded range as one logical operation batch.
- Recalculate dependent formulas.
- Collaborate through durable edits and best-effort presence.
- Undo and redo through the same revision protocol.
- Share workbooks with scoped permissions.

### Non-functional requirements

- Scroll and active-cell editing remain responsive.
- Empty logical space does not allocate a two-dimensional browser array.
- A reconnect cannot lose an acknowledged edit or apply an old calculation over a newer one.
- Presence may be stale or dropped without affecting document correctness.
- A large workbook opens through bounded reads.
- Permission checks apply to every durable operation.

### Out of scope

I will not design the full formula language, external integrations, spreadsheet import formats, or a complete CRDT implementation. I will define the operation and calculation boundaries.

## A — Architecture — 8 minutes

### Combined architecture diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│ React SPA                                                                   │
│ routes: /workbooks · /workbooks/$id/sheets/$sheetId                       │
│ authStore · workbookStore · sparseCellStore · gridStore · formulaStore     │
│ viewport controller · virtual grid · formula bar · accessibility layer     │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ HTTPS / WebSocket
┌──────────────────────────────▼─────────────────────────────────────────────┐
│ Workbook API and Collaboration Gateway                                      │
│ viewport reads · permissions · operation batches · acknowledgements        │
├───────────────────────┬───────────────────────┬────────────────────────────┤
│ Document service       │ Sync service           │ Formula service            │
│ snapshots · revisions │ ordering · replay      │ dependency graph · compute │
├───────────────────────┴───────────────────────┴────────────────────────────┤
│ Operation log · document store · snapshot store · presence broker           │
└────────────────────────────────────────────────────────────────────────────┘
```

### Frontend responsibilities

The shell owns workbook routing, tabs, toolbar, permissions, formula bar, keyboard commands, and announcements. The viewport controller computes visible rows and columns. The sparse store owns loaded cell records and local projections.

The grid renderer mounts only visible cells plus overscan. A stable editor overlay preserves focus while cells recycle. A formula worker computes derived values but does not own raw document truth.

### Backend responsibilities

The document service stores canonical sheet metadata, cell operations, formatting, and revisions. The sync service broadcasts accepted operations and supports reconnect replay. The formula service or worker fleet calculates dependent values against a revisioned snapshot.

### Edit flow

1. The user edits a cell in a stable overlay.
2. The client applies a local projection and creates an operation ID.
3. The sync client sends the operation with base revision and permission context.
4. The server validates and sequences it.
5. The acknowledgement includes canonical cell state and new revision.
6. Collaborators receive the operation through WebSocket.
7. Formula calculation produces revision-tagged derived updates.

## D — Data Model — 6 minutes

### Server entities

| Entity | Important fields | Authority |
|---|---|---|
| `Workbook` | ID, owner, permissions, revision | document service |
| `Sheet` | ID, workbook, dimensions, metadata | document service |
| `CellRecord` | sheet, row, column, raw value, formula, format | document service |
| `Operation` | ID, author, base revision, patch, sequence | operation log |
| `Snapshot` | workbook, revision, sparse chunks | snapshot store |
| `FormulaResult` | cell, computed value/error, source revision | formula service |
| `Presence` | user, cursor, selection, expiry | presence channel |

### Client entities

| Entity | Owner | Lifetime |
|---|---|---|
| `ViewportState` | grid controller | route/session |
| `CellStore` | sparse store | loaded range |
| `SelectionState` | UI store | current sheet |
| `PendingOperation` | sync queue | until ack/conflict |
| `FormulaProjection` | worker/store | revision-scoped |
| `UndoEntry` | history manager | bounded session/history |

The raw value and formula are separate from computed value and formatting. A blank unloaded cell is not the same as a loaded empty cell. Range reads carry revision and coordinate bounds.

### Operation semantics

Operations have stable IDs, a base revision, an author, a semantic type, and a bounded payload. Accepted operations receive a document sequence. A reconnect can request operations after the last acknowledged sequence or obtain a canonical snapshot when replay is unavailable.

### Formula semantics

Formula results are derived by source revision. A worker result for an old revision cannot overwrite a newer local or server revision. Formula errors are values in the derived model, not mutations to raw content.

## I — Interfaces — 8 minutes

### REST API

```
GET  /api/v1/workbooks                         → visible workbooks
GET  /api/v1/workbooks/:id                    → metadata, sheets, permissions
GET  /api/v1/workbooks/:id/sheets/:sheetId/range → bounded cell range
POST /api/v1/workbooks/:id/operations          → batch edit command
POST /api/v1/workbooks/:id/resync              → snapshot and revision
POST /api/v1/workbooks/:id/undo                → inverse operation command
PATCH /api/v1/workbooks/:id/permissions        → share policy
```

### WebSocket API

```
CONNECT /api/v1/workbooks/:id/stream
JOIN    sheet:<sheetId>
EVENT   operation { sequence, operation }
EVENT   acknowledgement { operationId, revision }
EVENT   presence { user, cursor, expiresAt }
EVENT   resync-required { revision, reason }
```

Presence is lossy and expires. Operations are durable, ordered, and replayable. They may share a connection but not a state machine.

### Frontend interfaces

| Boundary | Input | Output |
|---|---|---|
| Viewport controller | scroll, metrics | visible coordinate window |
| Grid renderer | cell snapshots, selection | semantic grid and layers |
| Formula worker | operations, graph, revision | derived values/errors |
| Sync client | operation batch | ack, remote op, conflict |
| Cell editor | coordinate, raw value | commit/cancel intent |
| History manager | operation result | inverse command |

### Error contract

The server distinguishes permission denied, invalid cell operation, stale revision, operation duplicate, resync required, formula unavailable, and transient storage failure. The client preserves local edits for conflicts and never marks a failed operation as acknowledged.

## O — Optimizations and Deep Dives — 20 minutes

### Deep dive 1: Two-dimensional virtualization

The browser calculates visible row and column ranges from scroll position and measured sizes. It renders their intersection plus bounded overscan. Frozen rows and columns use the same coordinate system to avoid scroll drift.

Rendering every populated cell still fails when a sheet has a dense million-cell region. A canvas-only grid reduces DOM count but complicates focus and screen readers. I choose a hybrid semantic grid with a bounded DOM and renderer adapters where profiling justifies them.

### Deep dive 2: Sparse storage and viewport reads

A sparse coordinate map stores only populated cells and loaded metadata. The server returns bounded ranges rather than a full workbook. Row and chunk indexes make visible range iteration efficient.

The trade-off is more complicated range lookup and dependency fetch. The alternative full snapshot is easier for offline formulas but creates memory, startup, and permission costs. A snapshot plus viewport chunks can be introduced when offline support requires it.

### Deep dive 3: Formula workers and revision guards

The worker receives an immutable operation batch or dependency snapshot and returns computed values tagged with the source revision. The client accepts results only when the revision is still current.

The alternative is calculate on the main thread. It has simpler access to state but freezes typing and scrolling when a paste causes a large dependency cascade. Worker serialization and cancellation are worth the complexity for formula-heavy sheets.

### Deep dive 4: Collaboration and conflicts

The server sequences operations per workbook or sheet partition. A client applies a local projection, then reconciles the acknowledgement. A conflict includes canonical state and the rejected base revision. The client can rebase disjoint edits or ask the user to review the affected cells.

Last-write-wins is acceptable for some independent formatting fields but dangerous for a formula or value where the user needs to know an edit was replaced. Operation semantics and visible conflict state are more important than pretending conflicts do not exist.

### Deep dive 5: Undo and redo

Undo sends an inverse operation through the normal permission and revision path. It does not directly mutate local state. A drag or paste can group many low-level changes into one user-facing history entry while still recording a bounded batch.

If the inverse is stale, the server rejects it and the client marks the history entry conflicted. Direct local mutation would feel fast but could overwrite another collaborator’s work without audit.

### Deep dive 6: Presence versus durable edits

Cursor and selection updates are best effort. They use throttling, expiry, and no durable replay. An edit operation carries sequence and must be persisted before the server confirms it.

Combining both as generic events makes a slow presence consumer block edits or makes the system retain too much cursor traffic. Separate channels or message classes preserve the distinct consistency requirements.

### Deep dive 7: Failure matrix

| Failure | Backend behavior | Frontend behavior |
|---|---|---|
| Range read fails | bounded retryable error | preserve selection |
| Operation timeout | command remains queryable | pending edit state |
| Revision conflict | reject with canonical state | review/rebase |
| Formula worker fails | recompute or mark unavailable | formula status badge |
| Socket gap | request resync | stale collaboration banner |
| Presence loss | expire cursor | durable edits continue |
| Permission revoked | reject future operations | read-only route |

## Capacity, rollout, and review checkpoints

### Capacity assumptions

I would test a sparse million-coordinate sheet, a dense pasted range, a formula-heavy region, several collaborators, and a reconnect during editing. The full-stack budget includes viewport latency, DOM work, operation sequencing, formula fan-out, snapshot recovery, and presence bandwidth.

### What I would measure

- Scroll frame rate and active-cell latency.
- Range-read latency and visible cell count.
- Operation acknowledgement and conflict rate.
- Formula worker queue and server recalculation duration.
- Socket lag, replay, and resync duration.
- Snapshot age and recovery time.
- Presence update rate and dropped messages.

### Rollout sequence

1. Ship workbook metadata and bounded read-only range reads.
2. Add sparse cell store, selection, and stable editing overlay.
3. Add ordered operations and acknowledgements.
4. Add formula worker with revision guards.
5. Add collaboration replay and separate presence.
6. Add paste batches, inverse undo, and offline drafts.

### Alternative architecture review

Rendering every cell is simple but fails on large sheets. A canvas-only renderer bounds DOM cost but makes focus and accessibility difficult. A hybrid virtual grid keeps semantics while allowing specialized render layers.

Full-document saves simplify the server but create large writes and coarse conflicts. Operation batches cost protocol and snapshot work but support collaboration, undo, and bounded recovery.

An iframe per sheet isolates crashes but breaks workbook-level keyboard and formula-bar coordination. A worker is the right boundary for formulas; a module contract is enough for cell renderers.

### Full-stack interview checkpoints

I trace a paste from the stable editor through batch validation, operation sequencing, formula recalculation, acknowledgement, and collaborator broadcast.

I explain why a worker result carries revision and why presence can be dropped without affecting the edit.

I close by returning to bounded rendering, exact revision semantics, and permission checks on every operation.

## Scalability and operations

Partition operation streams by workbook or hot sheet. Snapshot periodically so recovery does not replay unlimited history. Use chunked storage for sparse cells and analytical storage for version history or audit queries.

The first browser bottleneck is visible cell rendering. The first backend bottleneck is hot-sheet operation sequencing and formula fan-out. The first operational risk is snapshot and log divergence. Metrics must measure all three.

## Security and observability

Every range read and operation checks workbook permissions. Shared links are scoped and revocable. Formula functions are allowlisted; external fetches or scripts are not executed by the calculation worker.

Metrics include range latency, visible cell count, active-cell latency, operation acknowledgement, queue depth, formula duration, conflict rate, resync duration, and snapshot age. Logs carry workbook and operation IDs without cell contents.

## Testing and correctness review

I would test coordinate virtualization, stable editor focus, large paste batching, formula revision races, operation retry, reconnect replay, undo after a remote edit, and permission downgrade.

Backend tests verify operation ordering, snapshot recovery, formula result revision, and presence isolation. Browser tests verify scroll performance, keyboard navigation, stale calculation suppression, and visible conflict state.

The acceptance criteria are bounded DOM work, no lost acknowledged operations, no old formula result overwriting a new edit, and presence that never blocks saving.

## Implementation sequence

1. Build bounded workbook and viewport reads.
2. Add sparse client state, selection, and stable editing overlays.
3. Add operation IDs, revisions, acknowledgements, and retries.
4. Add formula worker results tagged by revision.
5. Add WebSocket replay and separate presence.
6. Add paste batches, inverse undo, and offline drafts.

The sequence protects the main thread and document correctness before introducing broader collaboration or formula compatibility.

## Interview walkthrough: one collaborative paste

The stable editor normalizes a range into one bounded operation batch. The client applies a local projection and sends operation ID plus base revision. The server authorizes, sequences, persists, and acknowledges it.

The formula worker receives the new revision and returns derived values tagged with that revision. Collaborators receive the durable operation; presence remains separate. A reconnect requests operations or a canonical snapshot.

This scenario demonstrates why viewport rendering, sparse storage, formulas, collaboration, and undo cannot share one undifferentiated state model.

## Further design decisions

The client keeps raw input, computed value, formatting, and remote revision separate. A formula error is a derived result, not a destructive cell mutation.

The server can return a viewport range with a revision and dependency hints. The client never treats an unloaded cell as an empty value when a formula depends on it.

The operation queue uses stable IDs through retries. An acknowledgement includes canonical state so local projections converge without rewriting unrelated visible cells.

The grid, formula worker, and sync client are separate module boundaries but share workbook context and keyboard focus. An iframe would damage those interactions without adding useful trust isolation.

The production review asks whether every old revision is rejected safely, whether snapshots can rebuild a sheet, and whether a presence outage leaves editing unaffected.

### Final questions

- What is raw versus derived?
- What survives a reconnect?
- Can formula results be stale?
- How is undo authorized?
- Can presence block edits?

The answers should point to revision-tagged formulas, durable operations, snapshots, and an ephemeral presence path.

### Launch gate

The launch gate is bounded viewport work, stable editor focus, revision-safe calculations, durable operation retry, and presence that never blocks edits.

I would not launch full offline collaboration until snapshot and operation replay are proven under reconnect tests.

### Final handoff

- Viewport state bounds browser work.
- Operations and revisions protect document truth.
- Formula results are derived and revision-tagged.
- Presence never blocks a durable edit.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Rendering | bounded hybrid grid | render every cell | protects DOM and memory |
| Storage | sparse records | two-dimensional array | empty space is cheap |
| Calculation | revisioned worker | main thread | protects interaction |
| Sync | ordered operations | full document saves | smaller conflicts |
| Presence | lossy channel | durable event stream | cursors can expire |
| Undo | inverse operation | local mutation | collaboration and audit |
| Reads | viewport ranges | full snapshot always | bounded startup |

## Closing — 3 minutes

The full-stack design keeps raw document state, derived formulas, visible rendering, durable operations, and presence separate. The browser provides immediate local interaction, while the server provides revision, permission, and replay guarantees.

I would ship bounded viewport reads, cell operations, revision-aware sync, and a small formula subset first. Then I would add large-sheet optimizations, richer formulas, offline replay, and stronger conflict resolution based on measured workloads.

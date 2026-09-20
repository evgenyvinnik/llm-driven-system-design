# Google Sheets — fullstack system design interview

> “I would follow one cell edit from the keyboard to durable storage and back to every
> collaborator. The UI needs immediate feedback, the server needs one accepted order, and
> formulas need to say which inputs their results came from.”

This is a proposed 45-minute interview design. I would draw the complete journey first and use
three deep dives to connect frontend decisions with backend guarantees. It does not describe
Google's internal implementation.

## 🎯 Requirements and scope — 5 minutes

I would establish the collaboration unit before discussing infrastructure. In this version, a
user edits a local cell draft, then commits a replacement value or a bounded rectangular
paste. We are not merging individual keystrokes inside the same cell.

A workbook contains multiple sheets and up to 200,000 populated cells, with 100 simultaneous
editors as an initial limit. Formulas may reference cells in the same workbook, including
another sheet. Paste is limited to 1,000 cells per atomic operation.

The user should navigate a large grid, edit values and formatting, see collaborators,
distinguish saved input from calculating results, and recover after a brief disconnect. Undo
is conditional so it cannot silently erase someone else's later edit.

I would defer row/column insertion, macros, external data functions, unrestricted offline
merging, and full Excel compatibility. Structural changes require a reference-identity or
transformation design beyond fixed-coordinate cell replacement.

| Concern | Proposed target / policy |
|---------|--------------------------|
| Interaction | Immediate draft and selection feedback within a 16 ms frame budget |
| Initial load | Useful first viewport within two seconds at p95 on the reference fixture |
| Save | Durable acknowledgement below 200 ms at p95 in the home region |
| Collaboration | Canonical peer update below 300 ms at p95 under normal load |
| Formulas | Ordinary recalculation below 500 ms at p95; expose lag and budget failures |
| Availability | Reject writes when authority is unavailable; retain user intent |

For sizing, one million daily editors making 100 committed edits each gives approximately
1,157 edits/second average and 11,600 at a tenfold peak. At 500 bytes per edit record, raw
history grows by roughly 50 GB/day before replication and indexes.

These are planning assumptions. Browser cost depends on the viewport and local state, while
backend risk often depends on the hottest single workbook rather than the fleet average.

## 🏗️ High-level architecture and edit journey — 7 minutes

I would draw the browser at the top, durable acceptance in the middle, and calculation/fanout
below it. Then I would trace an edit in both directions.

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                    │
│                                                                                            │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Grid + editor          │     │ Workbook model         │     │ Sync + local journal   │  │
│  │ Focus and local draft  │◀───▶│ Confirmed + pending    │◀───▶│ Ranges / saved op IDs  │  │
│  └────────────────────────┘     └────────────────────────┘     └────────────────────────┘  │
│                                                                     ▲       ▲              │
│            ┌────────────────────────────────────────────────────────┘       │              │
│            │    Pending appears now; saved requires a durable receipt.      │              │
│            │                                                                │              │
└────────────┼────────────────────────────────────────────────────────────────┼──────────────┘
             │                                                                │
             │                               HTTPS + WebSocket                │
             │                                                                │
             │                                                                ▼
             │                    ┌──────────────────────────────────────────────────────────┐
             │                    │ Workbook API + live gateway                              │
  canonical  │                    │ Authorize workbook and sheet; bound each operation       │
  events     │                    └──────────────────────────────────────────────────────────┘
             │                                                                ▲
  + calc rev │                                                                │
             │                      edit intent / canonical receipt           │
             │                                                                │
             │                                                                ▼
             │                    ┌──────────────────────────────────────────────────────────┐
             │                    │ Workbook owner + PostgreSQL partition                    │
             │                    │ Commit raw cells, revision, operation receipt and outbox │
             │                    │ Serve immutable snapshots plus retained ordered edits    │
             │                    └──────────────────────────────────────────────────────────┘
             │                                            ▲                                ▲
             │                                            │                                │
             │                     recalculate / publish  │          committed events      │
             │                                            │                                │
             │                                            ▼                                ▼
             │                    ┌────────────────────────┐        ┌────────────────────────┐
             │                    │ Formula workers        │        │ Outbox + scoped fanout │
             │                    │ Result batches by rev  │        │ Replay, then live      │
             │                    └────────────────────────┘        └────────────────────────┘
             │ events / resume                                                   ▲
             └───────────────────────────────────────────────────────────────────┘
```

The browser separates the active draft from confirmed cells and pending operations. The grid
reads that model, while the coordinator owns network requests, connection generations, and
recovery. Canonical events return through the coordinator before the model is rendered.

The API checks identity, workbook/sheet access, and operation bounds. It routes writes to the
workbook owner, which commits changes and recovery information in one PostgreSQL transaction.
The same boundary handles WebSocket and HTTP bulk-edit commands.

Formula workers consume committed revisions and publish complete result batches. An outbox
relay delivers raw-edit and calculation events to gateways. Live transport is a latency
optimization; durable receipts and history allow recovery after missed messages.

Range reads come from immutable checkpoints plus retained edits at an identified revision. The
browser fetches the visible portion instead of downloading a whole workbook. Presence is a
separate disposable stream through the gateway, omitted from the durable-storage boxes to keep
its role clear.

I would walk through B4 changing from 10 to 20: the editor holds the draft, commit adds a
pending operation, the server assigns a revision, and the receipt confirms that operation. A
dependent total may update later with a separate calculation revision.

I would then interrupt the connection:

1. Preserve the bounded account/workbook journal under its storage policy, reauthorize, and resolve the original edit ID before resending or removing its overlay.
2. Resume the ordered feed and matching range token, or explicitly reset to a new coherent snapshot when history has expired.
3. Formula workers recover identified inputs and publish only complete batches. Acknowledged background progress does not turn an older result into the newest calculation.
4. Reconcile raw edits and calculated results separately in the browser, keeping lag visible and unsubmitted text intact.

The owner and data partition are scoped to a workbook because dependencies may cross sheets.
We can initially co-locate the gateway, owner, and range reader; the diagram defines
responsibilities before deployment boundaries.

## 💾 Shared data and interface contracts — 4 minutes

| Concept | Browser responsibility | Server responsibility |
|---------|------------------------|-----------------------|
| Cell identity | Workbook, sheet, row, column | Validate membership and coordinate bounds |
| Draft | Text, selection, composition state | No durable work until commit |
| Pending edit | Operation ID, original payload, status | Deduplicate by actor, ID, and payload digest |
| Canonical cell | Confirmed value, format, cell revision | Persist within the workbook commit order |
| Range | Snapshot token and request generation | Return a coherent rectangle at its revision |
| Formula result | Display input/result revisions and errors | Safe parser, bounded evaluation, complete batches |
| Presence | Render names/cursors with expiry | Relay best-effort sheet-scoped updates |

The durable model needs a workbook authority row, sheet metadata, cells, memberships, ordered
operation history, receipts, outbox records, immutable snapshot chunks, and calculation
batches. Current cell rows optimize writes; checkpoints and history support coherent
historical reads.

| Interface | Required behavior |
|-----------|-------------------|
| Metadata and range reads | Authenticate, scope, return revision/token and expiry |
| Edit submission | Stable operation ID, bounded changes, explicit outcome |
| Operation lookup/retry | Recover original acceptance after a lost response |
| Resume subscription | Replay missing revisions, then follow live events |
| Formula result event | Identify input revision, engine version, complete batch |
| Undo | Verify the affected cells still match the original operation's versions |

Both ends validate message shape and scope. A late response from an old workbook must be
rejected by the client even if it is a valid response to an earlier request. Server
authorization remains mandatory regardless of those client checks.

## 🔧 Deep dive: a responsive grid that preserves intent — 8 minutes

> “I would optimize the amount of work per interaction, not just the number of DOM nodes.
> Virtualization is useful only if editing and state updates also stay bounded.”

### Separate viewport, data, and editor lifetimes

The grid computes visible row and column intervals and renders their Cartesian product with
modest overscan. For example, 35 visible rows and 15 columns mean about 525 cells before
overscan. A spreadsheet needs horizontal virtualization as well as vertical virtualization.

A geometry model owns row heights, column widths, and prefix offsets. Headers, cells,
selections, and collaborator cursors use the same coordinates. A resize invalidates the
relevant geometry while preserving the user's scroll anchor.

Data arrives in bounded range tiles. Evicting an offscreen canonical tile is safe if it can be
fetched again; evicting a pending edit is not. Unloaded data remains explicitly unknown, so a
blank loading tile cannot be mistaken for an empty saved range.

The editor uses a stable native input overlay, or pins its virtual cell while editing.
Scrolling must not unmount the input and lose an unfinished draft. Keyboard navigation and
text editing are separate modes, and composition Enter must not also commit the cell.

I would use cell-level selectors and keep typing in the draft state. Replacing a workbook-wide
Map on every keystroke would turn a local interaction into repeated whole-model work even with
a virtualized DOM.

### Account for another user editing the same cell

While I type 20 into B4, another user may save 30. The confirmed layer records 30, but my
draft remains intact. The UI indicates that the underlying cell changed. Saving my draft is a
new explicit replacement, resolved by server commit order.

If I submit 20 and then 40 quickly, the receipt for 20 must not clear the pending 40. The
browser removes only the operation identified by that receipt and reprojects the remaining
pending operations over canonical state.

When an operation is rejected, the UI retains enough information to recover the user's input
and explain the reason. It does not silently repaint the previous value and leave the user
guessing whether the edit was lost.

### Preserve keyboard and accessible behavior

I would provide grid/row/cell semantics, logical indices for virtualized rows and columns, and
a deliberate focus model. Navigation renders the target cell before moving focus; editing
hands caret keys to the native input. The [WAI-ARIA grid
pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/) provides the relevant interaction
guidance.

The formula bar identifies the active coordinate and raw input. Save failures are announced;
remote cursor movement is not announced on every message. Names supplement colors so
collaborator identity is not color-only.

| Approach | Strength | Cost |
|----------|----------|------|
| ✅ Virtualized DOM + stable editor | Native input and accessible structure, bounded viewport work | Geometry and selective subscriptions need care |
| ❌ Canvas as the initial default | Efficient custom drawing at high visible density | Additional text-input, hit-testing, and accessibility systems |

Canvas is a possible later response to measured rendering limits. It does not solve
pending-operation reconciliation or data memory. I would accept some DOM overhead to make the
initial editing contract reliable and accessible.

## 🔧 Deep dive: what “saved” means across a disconnect — 8 minutes

> “The acknowledgement is a statement about a database commit. A socket opening, a local
> optimistic update, or a successful Redis publish is not that statement.”

### One atomic acceptance boundary

The owner validates access and bounds, then checks the workbook's owner epoch under a short
database transaction. It finds or creates the actor-scoped operation receipt, applies the raw
cell changes, increments the workbook revision, and inserts history and outbox records
atomically.

An identical retry returns the original receipt. Reusing the ID with a different payload is
rejected. A paste is a bounded all-or-nothing operation, and HTTP and WebSocket commands share
this logic.

This matters when A sets B4 to 10, B sets it to 20, and A's delayed retry arrives. A blind
UPSERT would restore 10. A stored receipt answers A without applying it again, preserving B's
later accepted value.

The authority check also prevents split ownership. If an old owner wakes after failover, its
epoch is rejected inside the write transaction. Ownership transfer and edits coordinate on the
same authority row, so a Redis lease expiration alone cannot authorize conflicting database
writes.

### Keep the browser's states honest

| State | Meaning to the user |
|-------|---------------------|
| Draft | Input exists locally and has not been submitted |
| Pending | Submitted intent has no known durable outcome yet |
| Saved | A canonical event or receipt confirms this operation |
| Calculating | Raw input is saved; formula results are behind |
| Disconnected | New server acceptance cannot be assumed |
| Rejected | Access, validation, or a conditional operation failed |

A bounded local journal can preserve pending intent across a browser crash, scoped to account
and workbook. It is still not proof of server acceptance. If storage is unavailable, the UI
describes that intent as memory-only.

On reconnect, the client retries known operation IDs and resumes from its last applied
revision. A new connection generation invalidates callbacks from the old socket. New
collaborative commits wait until the session is synchronized and authorization is current.

### Reconcile snapshot and live state

The server issues a token for a checkpoint plus replay horizon R. The browser installs ranges
at R while buffering later events. It then applies those events in order, retaining any
unresolved local overlay.

If revision 84 arrives after 82, it asks for 83 instead of declaring the workbook current. If
the retained history or token has expired, it obtains a new snapshot and resolves pending IDs
separately. A full reload without that step could lose user intent or resubmit it as a new
operation.

The outbox survives a crash between database commit and notification. Delivery can repeat, so
clients and gateways deduplicate and fill gaps. Slow clients have bounded buffers; presence is
dropped first, then durable state falls back to replay or resynchronization.

| Approach | Strength | Cost |
|----------|----------|------|
| ✅ Durable receipt/history + pending overlay | Immediate UI and recoverable acceptance | More explicit protocol and recovery states |
| ❌ Broadcast after an ordinary write | Small implementation for a local demo | Lost responses and missed events leave ambiguous state |

The cost is a more involved coordinator and retention policy. I accept it because brief
network changes are normal. Making users manually reload until two windows happen to agree is
not a reliable save contract.

Conditional undo uses the same command boundary. If a collaborator changed a cell after the
original operation, the inverse is rejected rather than silently overwriting that later edit.

## 🔧 Deep dive: saved inputs and trustworthy formula results — 7 minutes

> “A calculated value needs an input revision. Otherwise a fast-looking total can be wrong
> even when every individual cell edit was saved correctly.”

### Bound the formula language

The server parses a supported spreadsheet grammar into an expression tree and dependency
model. It recognizes same-workbook references, including cross-sheet references, and detects
cycles. Arbitrary JavaScript, external requests, and macros are excluded.

Formula limits cover nesting, referenced ranges, dependency count, memory, and runtime. A
large range needs an efficient range-dependency representation or a clear size rejection;
expanding every coordinate into an object is not automatically scalable.

A worker evaluates a pinned input revision in dependency order. Expensive evaluation happens
outside the raw-edit transaction so it cannot hold the workbook lock or block the gateway's
event loop.

### Publish a coherent result

The worker stages a complete result batch tagged with input revision and engine version. The
database atomically publishes the completed batch pointer and its outbox event. A slow older
job cannot move the published calculation revision backward.

The workbook may have raw revision 81 and calculation revision 79. The UI can truthfully say
the input is saved while showing the prior result as calculating. It must not label that
result as derived from 81.

If results arrive in chunks, the client stages them and switches the relevant visible batch
when complete. Unknown or missing data is a loading/error state, not a reason to silently mix
result versions.

Continuous edits should not cancel every calculation forever. The scheduler coalesces obsolete
queued work, lets bounded work make progress, and follows with the latest required revision.
Workbooks that exceed budgets receive explicit errors or limits.

### Why the browser is not the authority

The browser only loads its viewport. A formula can depend on thousands of offscreen cells or
another sheet, so missing local data cannot be treated as zero. Fetching the entire dependency
closure might also overwhelm the browser.

A local worker could later preview a restricted formula whose dependencies are all present.
That preview uses a matching engine version and remains provisional. Worker execution alone
does not make arbitrary input a safe formula language.

| Approach | Strength | Cost |
|----------|----------|------|
| ✅ Server calculation with input revisions | Shared authoritative inputs despite partial browser loading | Network dependence and visible calculation lag |
| ❌ Each browser calculates independently | Fast for a small fully local workbook | Incomplete dependencies and version drift across collaborators |

Synchronous server calculation is another option for tiny bounded sheets. For this workload,
it would couple expensive dependency chains to edit latency. I prefer saved raw inputs plus
clearly identified asynchronous results.

This is the same contract across layers: the server publishes a revisioned result, the
coordinator accepts it monotonically, and the grid communicates its freshness instead of
hiding it.

## 📈 Scaling and verification — 4 minutes

Independent workbooks scale across owner/database partitions. Gateways scale by active
connections and delivery volume; workers scale by formula cost. A hot workbook and a long
dependency chain still have serial bottlenecks, so admission limits and dedicated capacity
come before splitting one workbook's consistency domain.

Frontend scaling requires bounded range caches, selective subscriptions, and controlled
geometry work. Presence has a separate budget and can be sampled. A shared rendering store
should not rerender every cell whenever one cursor moves.

I would verify the design through end-to-end failure scenarios:

1. Lose the receipt after a committed edit; reconnect returns its original revision.
2. Deliver an old receipt after a newer local edit; the pending overlay remains correct.
3. Pause an owner through failover; its stale epoch cannot write.
4. Deliver a live edit before initial range data; the range does not overwrite the edit.
5. Finish an old formula job last; published calculation freshness does not regress.
6. Undo after another user changed the cell; the system reports a conflict.

Measure input-to-paint, mounted cells, range bytes, pending age, commit latency, owner queue
depth, replay gaps, outbox age, and calculation lag. A page-load smoke test alone says little
about these guarantees.

For cross-region recovery, I would state the database replication and data-loss policy rather
than casually promise zero-loss failover. An asynchronous replica can be behind acknowledged
writes.

## 🧭 Close and implementation comparison — 2 minutes

> “The design connects responsiveness to correctness: the browser preserves intent, the
> database records one accepted order, and formula results identify the inputs they
> represent.”

The local project has a virtualized React grid, Zustand, SQL cell persistence, and one-process
WebSocket collaboration. It loads only the first sheet, ignores edit ACK/errors and incoming
sheet IDs, and has no reconnect, durable journal, workbook revisions, history replay, or owner
fencing.

Redis publication is not connected to a subscriber path. Formula handling supports literal
examples and unrestricted JavaScript fallback, not cell references or dependent recalculation.
REST edits bypass calculation and live publication. These limitations are documented rather
than silently represented as production guarantees.

The [architecture document](./architecture.md#implementation-notes) maps those findings to
source. The [README](./README.md) contains the actual setup and supported demo flows.

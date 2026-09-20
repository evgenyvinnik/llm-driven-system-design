# Google Sheets — frontend system design interview

> “I would design the spreadsheet around three promises: typing feels immediate, the user can
> tell whether an edit is saved, and the visible cells agree with an identified server
> revision. The grid, collaboration protocol, and formula display all need to support those
> promises.”

This is a proposed design for a 45-minute interview, not a description of Google's internals.
The local demo demonstrates only part of it; the final section identifies the gap. I would
draw the overview early and use the three deep dives to explain the difficult choices.

## 🎯 Requirements and scope — 5 minutes

I would clarify the size of a workbook, number of collaborators, formula expectations, and
offline behavior before choosing a renderer.

For this discussion, I will assume a workbook may contain multiple sheets, up to 200,000
populated cells, and 100 simultaneous editors. The visible viewport is much smaller than the
logical grid. A typical operation edits one cell; paste is limited to 1,000 cells per atomic
operation.

The core experience is navigating cells, editing values and formulas, selecting ranges, seeing
collaborators, and recovering after a brief network interruption. We support same-workbook
formula references, including other sheets, but no external data or arbitrary scripts.

I would leave structural row/column insertion, macros, charts, and full Excel compatibility
outside the first version. Fixed coordinates make the collaboration discussion tractable;
adding row insertion later changes reference and selection semantics.

| User action | Required behavior |
|-------------|-------------------|
| Type in a cell | Native text editing responds immediately |
| Commit an edit | Show pending, then saved or an actionable rejection |
| Scroll or change sheets | Render a bounded viewport and load the correct range |
| Receive another edit | Update canonical state without losing a local draft |
| Lose the connection | Preserve intent and distinguish disconnected from saved |
| View a formula | Distinguish raw input, confirmed result, and calculation lag |

Proposed targets are a 16 ms interaction frame budget, a useful first viewport within two
seconds at p95, and canonical peer updates within 300 ms at p95 in normal conditions. These
are test targets on an agreed device/network fixture, not universal promises.

I would support recovery of already-submitted edits and preservation of a local draft. I would
not promise unrestricted offline merging in the first version. A user can inspect cached data
while disconnected, but new collaborative commits wait until synchronization and permission
checks succeed.

## 🏗️ High-level architecture — 7 minutes

I would draw the browser boundary first, then three views, their state owners, and one
synchronization boundary. The server stays abstract in this frontend interview.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                  │
│                                                                                          │
│  ┌────────────────────────┐    ┌────────────────────────┐    ┌────────────────────────┐  │
│  │ Grid + headers         │    │ Editor + formula bar   │    │ Presence overlay       │  │
│  │ Visible cells only     │    │ Draft / save status    │    │ Remote cursors         │  │
│  └────────────────────────┘    └────────────────────────┘    └────────────────────────┘  │
│                         ▲                             ▲                             ▲    │
│   render / navigate     │       draft / commit        │       advisory updates      │    │
│                         │                             │                             │    │
│                         ▼                             ▼                             ▼    │
│  ┌────────────────────────┐    ┌────────────────────────┐    ┌────────────────────────┐  │
│  │ Viewport + focus       │    │ Workbook model         │    │ Presence state         │  │
│  │ Geometry, active cell  │◀──▶│ Canonical + pending    │◀──▶│ Sheet + user + expiry  │  │
│  │ Loaded range keys      │    │ Cell / calc revisions  │    │ Never cell authority   │  │
│  └────────────────────────┘    └────────────────────────┘    └────────────────────────┘  │
│                         ▲                             ▲                             ▲    │
│                         │                             │                             │    │
│   range demand          │       edits / ordered events│       cursor messages       │    │
│                         │                             │                             │    │
│                         ▼                             ▼                             ▼    │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Sync coordinator + scoped local journal                                            │  │
│  │ Snapshot token, operation IDs, sequence gaps, connection generation                │  │
│  │ Loading / syncing / ready / disconnected; bounded pending journal                  │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
│                                             ▲                                            │
└─────────────────────────────────────────────┼────────────────────────────────────────────┘
                                              │
                                              │  HTTPS ranges + WebSocket commands/events
                                              │
                                              ▼
   ┌────────────────────────────────────────────────────────────────────────────────────┐
   │ Workbook service (server boundary)                                                 │
   │ Authorization, durable ordered edits, revisioned ranges and formula results        │
   └────────────────────────────────────────────────────────────────────────────────────┘
```

The left path translates scrolling and keyboard movement into range demand, then renders the
available canonical data plus pending changes. Viewport state owns geometry and focus; it does
not own saved cell values.

The center path handles a draft separately from committed data. Committing produces an
operation with a stable ID. The coordinator sends it, receives an authoritative receipt, and
reconciles the workbook model. The editor must not lose text because a remote event changed
the cell underneath it.

The right path carries lightweight presence. A remote cursor has workbook and sheet identity,
position, user label, and expiry. It can be delayed or dropped without changing document
content.

The coordinator is the only owner of socket lifecycle, snapshot tokens, request identity, and
sequence recovery. Views issue intentions rather than opening their own subscriptions. This
makes a sheet switch or connection replacement a single transition instead of several
unrelated effects.

I would walk one concrete interaction through the arrows: select B4, type a new value, commit,
render it as pending, receive the server's revision, and remove only that operation's pending
overlay. A later formula result arrives with a calculation revision and updates dependent
displays.

For a reconnect, I would follow the same identities:

1. Recover the bounded account/workbook journal under its storage policy and reauthorize before resubmitting any saved operation.
2. Resolve original operation receipts separately from loading a replacement snapshot. Clear only confirmed pending effects; preserve unresolved editor text.
3. Restore ranges under a valid token and replay later revisions. Missing or expired range data is unknown, not an empty cell.
4. Display formula results with their input/calculation revision. A late result cannot overwrite a newer published batch or pretend it includes a more recent raw edit.

These responsibilities can live in one frontend package. Separate boxes describe ownership,
not a requirement for separate libraries or microfrontends.

## 💾 State model and server interface — 4 minutes

| State | Owner / identity | Lifetime |
|-------|------------------|----------|
| Workbook metadata | Workbook ID; sheet IDs and dimensions | Authorized document session |
| Canonical cells | Workbook + sheet + row + column; cell revision | Evictable range cache |
| Pending operations | Actor + workbook + operation ID; original payload | Until receipt or explicit resolution |
| Editor draft | Active cell, original revision, text, composition state | Until commit/cancel |
| Navigation | Active sheet, focus, selection, scroll anchor | Local interaction |
| Range request | Snapshot token, rectangle, connection generation | One fetch/recovery cycle |
| Formula result | Input revision, engine version, result/error | Until a newer complete result batch |
| Presence | Workbook + sheet + collaborator, expiry | Ephemeral |

I would use selectors that subscribe each visible cell to its relevant value, format, and
selected/editing status. A single global Map copied on every keypress would make a small edit
touch far more state than necessary. The draft should remain local to the editor until commit.

| Interface | Purpose / required metadata |
|-----------|-----------------------------|
| GET workbook metadata | Authorized sheets, dimensions, raw and calculation revisions |
| GET a rectangular range | Immutable snapshot token, coordinates, values at its revision |
| WebSocket edit command | Operation ID, scope, bounded changes, payload identity |
| Commit receipt | Operation ID, accepted revision, canonical values or rejection |
| Ordered edit feed | Workbook revision and changed cells; replay cursor |
| Calculation event | Complete result batch and its input revision |
| Presence message | Sheet, cursor/selection, expiry; no durable acknowledgement |

The server owns permissions, committed order, and authoritative formula results. TypeScript
types help the browser, but incoming messages still need runtime validation and scope checks.

## 🔧 Deep dive: a fast grid with reliable editing — 8 minutes

> “I would start with a virtualized DOM grid and one stable native editor. The important
> optimization is bounding visible work while keeping keyboard and text behavior correct.”

### Two dimensions of virtualization

A spreadsheet can be wide as well as tall. I would compute visible row and column intervals,
add a modest overscan margin, and render their Cartesian product. Rendering 35 rows and 15
columns means roughly 525 cell views before overscan, not 35 views.

Row heights and column widths belong in a geometry model shared by cells, headers, selections,
and collaborator overlays. Prefix offsets allow coordinate-to-pixel mapping without summing
every earlier row on each cursor update. Resizing invalidates the affected measurements and
preserves the scroll anchor.

Viewport rendering and range fetching are separate budgets. The browser should not download
every populated cell merely because it renders only a small fraction. It can fetch bounded
tiles around the viewport and evict old canonical tiles, while retaining pending edits
independently.

An unloaded cell is an unknown value, not an empty cell. During a rapid scroll, I would show a
lightweight loading state and avoid presenting blank-looking cells as confirmed data.

### Keep the editor alive

The input should live in a stable overlay positioned over the active cell, or the edited cell
must remain mounted. Otherwise scrolling can unmount a virtual cell and accidentally commit,
cancel, or lose its draft.

I would define navigation and editing as separate modes. Arrow keys move between cells in
navigation mode and move the text caret in editing mode. Enter commits and moves according to
the agreed convention; Escape cancels. Keyboard handlers should not capture unrelated controls
elsewhere on the page.

Composition events matter for input methods. An Enter used to finish composition must not also
save the cell and move focus. Clipboard paste similarly needs a bounded operation with a clear
preview/error policy for oversized ranges.

If a remote edit arrives during typing, the draft remains visible. The model records the newer
canonical value underneath it and indicates a concurrent change. Committing the draft is an
explicit new edit, not an accidental replay of the original value.

### Accessibility belongs in the grid contract

I would provide grid, row, and cell semantics, logical row/column counts and indices, and a
deliberate focus strategy. The active cell must be rendered before moving focus to it. Editing
mode must give the native input control of its caret keys, then restore grid navigation on
exit. These choices follow the [WAI-ARIA grid
pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/).

The formula bar should identify the active coordinate and expose both raw input and result.
Presence uses names as well as colors. Saving and errors should be announced without narrating
every remote cursor movement.

### The renderer trade-off

| Approach | Strength | Cost |
|----------|----------|------|
| ✅ Virtualized DOM | Native text controls and accessible structure | Must bound cell subscriptions and layout work |
| ❌ Canvas from the start | Small DOM and efficient custom drawing | Custom hit testing, editing, and accessibility representation |

Canvas becomes attractive if measurement shows the required visible density exceeds the DOM
budget. It does not remove state synchronization or formula costs. I would first profile
scroll frames, cell rerenders, and editor responsiveness with long text, variable dimensions,
and several collaborators.

What I give up is some rendering headroom and precise drawing control. That is acceptable for
the initial viewport because reliable input and access matter more than a speculative maximum
cell count.

## 🔧 Deep dive: optimistic edits without false “saved” states — 8 minutes

> “The visible value is a projection of confirmed state plus pending operations. I would never
> use ‘the socket is open’ as evidence that a particular edit is saved.”

### Track the operation, not just the value

Suppose I submit operation A setting B4 to 10, then operation B setting it to 20 before A's
receipt arrives. A's receipt should confirm A beneath the overlay; it must not replace the
visible 20 or clear B.

An ordered event can arrive before its matching receipt. Both identify the operation, so
receiving either canonical confirmation can reconcile it once. Repeated delivery is harmless.
A timeout does not prove failure: retrying the same operation ID lets the server return the
original durable outcome.

For ordinary same-cell replacements, the proposed server uses commit order. If another
editor's later operation wins, the client shows that canonical value after its own pending
work is resolved. I would not claim this preserves every user's intent; history and a visible
conflict indication explain what happened.

Undo is also an operation. It carries the version produced by the edit being undone. If
someone else has changed that cell since, the server refuses a blind inverse. The UI can
explain the conflict and offer an explicit new edit instead of silently erasing a
collaborator's work.

### Make connection state explicit

| State | UI and coordinator behavior |
|-------|-----------------------------|
| Loading | Fetch metadata and a coherent initial range |
| Syncing | Buffer later events; establish the snapshot boundary |
| Ready | Accept commits and show their individual pending status |
| Disconnected | Keep draft and pending intent; stop claiming saves |
| Recovering | Retry known IDs, replay missing revisions, reconcile |
| Access lost | Stop reads/writes and remove protected cached data |

Each connection and range request carries a generation. After changing workbooks, replies from
the old generation cannot write into the new model. Closing an old socket also must not clear
the replacement socket's state.

The pending journal can be bounded and persisted locally for crash recovery, scoped to account
and workbook. That persistence preserves intent, not server acceptance. If local storage is
unavailable, the UI must say unsaved intent is memory-only rather than implying crash
durability.

### Join a snapshot to a live feed

I would load a range at revision R while buffering events after R. Once the range is
installed, apply those later events in order. If an event's revision is missing, ask for
replay; if the history is unavailable, obtain a new snapshot.

A late range fetch must not overwrite newer changes. It either installs against its original
snapshot and replays the buffered suffix, or is discarded when its token/generation no longer
matches. The same rule applies to a quick sheet switch.

There is a memory cost to buffering updates for many unloaded ranges. I would keep a bounded
change summary and invalidate affected range tokens when detail is evicted. Returning to that
range then fetches a new coherent view instead of trusting incomplete local history.

### The optimism trade-off

| Approach | Strength | Cost |
|----------|----------|------|
| ✅ Confirmed state + pending overlay | Immediate feedback with explicit durable confirmation | Operation journal, reconciliation, and recovery states |
| ❌ One mutable cell Map | Easy first implementation | Old receipts, failed writes, and remote edits overwrite intent |

Pessimistic editing could wait for every round trip before updating the cell, but that would
make rapid data entry feel network-bound. I accept reconciliation complexity because users
expect immediate typing and deserve accurate save status.

## 🔧 Deep dive: formulas when most cells are not loaded — 7 minutes

> “I would let the server calculate the workbook. The browser knows the viewport, which is not
> enough information to calculate every dependency correctly.”

A visible total may depend on thousands of offscreen cells or another sheet. Treating absent
browser data as zero produces a plausible but incorrect result. Downloading the entire
dependency closure can also defeat viewport loading and exhaust memory.

The browser stores raw input separately from computed results. While editing, the formula bar
shows the raw expression. Once committed, the grid can display the last complete server result
with its calculation status.

### Two revisions answer two different questions

Raw revision 81 means the inputs through edit 81 are saved. Calculation revision 79 means the
displayed results were calculated from inputs through 79. Both facts can be true at once.

The server publishes complete result batches tagged with input revision and engine version. A
delayed batch for revision 78 cannot replace results already published for 79. When the
browser holds raw revision 81 and result revision 79, it marks results as calculating rather
than presenting them as current.

If calculated values arrive in chunks, the coordinator stages the chunks and switches the
visible batch only when the required range is complete. A missing chunk is a loading/error
state, not permission to mix old and new results without a label.

| Situation | User-visible response |
|-----------|-----------------------|
| Ordinary literal edit | Pending value, then confirmed value |
| Formula input saved, calculation pending | Saved input with calculating indicator |
| Invalid supported-language expression | Specific validation or formula error |
| Dependency cycle | Explicit cycle error on affected results |
| Calculation budget exceeded | Explain the limit; preserve saved raw input |
| Formula depends on unloaded cells | Wait for authoritative result; do not invent zeros |

A local worker could provide a preview for a deliberately bounded subset of formulas whose
dependencies are present. It would use the same grammar/version and remain labeled
provisional. I would postpone that optimization until ordinary server calculation latency is
measured.

The browser must never evaluate spreadsheet input with JavaScript execution APIs. Even a
preview needs a defined parser and resource limits; a worker alone is not a safe formula
language.

### The calculation trade-off

| Approach | Strength | Cost |
|----------|----------|------|
| ✅ Authoritative server results | Consistent inputs across collaborators and unloaded ranges | Network dependence and visible calculation lag |
| ❌ Browser as sole calculator | Potentially immediate local results | Incomplete dependencies, engine drift, duplicated work |

The alternative is viable for a small standalone spreadsheet whose entire workbook is local.
It breaks our shared, partially loaded model because different browsers can calculate from
different subsets. I accept lag and surface it, rather than hiding an inconsistent result
behind a responsive animation.

## 📈 Scaling and validation — 4 minutes

The first frontend bottlenecks are likely excessive cell subscriptions, geometry work, and an
unbounded cell or event cache. Fleet-wide backend throughput will not fix a browser that
rerenders its whole workbook on every selection change.

I would measure input-to-paint, dropped scroll frames, mounted cells, range bytes, cache
memory, pending age, and snapshot recovery time. Presence updates should be throttled and
rendered separately from durable cell updates.

Useful validation scenarios are concrete:

1. Edit twice rapidly and deliver the first receipt last; the newer pending value survives.
2. Change workbook while a range request is delayed; the old response is ignored.
3. Disconnect after server commit but before receipt; retry resolves the original operation.
4. Scroll during composition; the editor stays mounted and does not commit early.
5. Load a formula whose dependencies are offscreen; the browser never substitutes empty values.
6. Navigate with keyboard and assistive technology across virtual boundaries.

I would also simulate a slow client with a full event buffer. The correct recovery is a
bounded resync with preserved intent, not unbounded memory growth.

The overview follows the [RADIO
framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework):
establish requirements, draw responsibilities and flows, define data/interface contracts, then
spend the remaining time on the hardest optimizations and trade-offs.

## 🧭 Close and implementation comparison — 2 minutes

> “My design keeps the grid fast by bounding rendered work, keeps editing trustworthy by
> separating drafts from confirmed state, and keeps formulas honest by showing the revision
> behind each result.”

The repository already has React, Zustand, two-axis virtualization, PostgreSQL cell
persistence, and same-process WebSocket cursor/cell updates. It loads all first-sheet cells,
has no reconnect or operation journal, ignores ACK/error messages and incoming sheet IDs, and
uses a cell Map that loses formatting on updates.

Its formula evaluator handles literal examples and falls back to unrestricted JavaScript; it
does not resolve references or recalculate dependents. The UI lacks sheet switching and a
complete accessible keyboard/editing model. None of the revisioned protocol, safe calculation
engine, or durable recovery above should be presented as already implemented.

See [architecture.md](./architecture.md#implementation-notes) for the verified source mapping
and [README.md](./README.md) for local setup.

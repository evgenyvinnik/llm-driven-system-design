# Figma — frontend system design interview

This is a proposed design for a collaborative visual editor, paced for 45 minutes. It is
not a claim that the local demo already implements these guarantees.

## 🎯 Scope and requirements — 4 minutes

> “I’ll follow a designer opening a file, moving a shape while a colleague edits,
> losing the connection briefly, and then undoing that movement. The main frontend
> challenge is keeping interaction immediate without confusing a local preview
> with a saved, shared document.”

I would establish whether we need a general vector editor or the full design suite. I will
scope this answer to rectangles, ellipses, text objects, pages, layers, properties,
collaboration, and named versions. Components, plugins, exports, prototyping, and
simultaneous character editing are follow-up topics.

I assume a desktop-first editor with keyboard access. A typical active page has 10,000
objects, perhaps a few thousand visible, and several collaborators. A file may contain
more objects across inactive pages. Those numbers define a benchmark dataset; they are not
a promise that any browser can render it smoothly.

The important targets are p95 local feedback below 50 milliseconds and a 60 Hz rendering
goal on a specified device. I would aim for committed edits to reach regional
collaborators within 200 milliseconds at admitted load. Network latency must not delay the
local drag preview.

The product also needs clear states for loading, saving, offline, rejected edits, and
read-only access. A green connection icon is insufficient evidence that an edit was
persisted. A server acknowledgement with an accepted sequence is the boundary between
pending and saved.

I would support a short connection interruption with a bounded pending queue. I would not
promise unlimited offline merging in this first version. If that is required, it changes
the document model, storage policy, and conflict discussion.

| Journey | Frontend responsibility | Server dependency |
|---|---|---|
| Open a file | Load a consistent page and controls | Authorized snapshot and ordered stream |
| Manipulate a shape | Immediate preview and usable tools | Validate and commit semantic edits |
| Collaborate | Reconcile events and show cursors | Canonical order and ephemeral presence |
| Reconnect | Preserve pending intent and detect gaps | Durable receipts and replay |
| Undo/restore | Explain consequences and update all views | Ordered inverse/restore operation |

## 🏗️ Architecture and ownership — 6 minutes

I would draw a small client architecture and leave the backend as one collaboration
boundary. Each component has a distinct state owner, so renderer objects never become the
only copy of the document.

```
┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│ React controls / tools │ ──▶ │ Scene + pending state  │ ──▶ │   Retained renderer    │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘

┌────────────────────────┐     ┌────────────────────────┐
│    Sync coordinator    │ ──▶ │ File collaboration API │
└────────────────────────┘     └────────────────────────┘
```

React owns the file route, toolbar, dialogs, layer navigation, and properties forms. A
scene store owns normalized objects and their canonical revisions. A tool controller
translates input into temporary previews and semantic edit intents. The sync coordinator
owns pending operations, receipts, and the applied sequence.

The renderer receives derived scene changes, viewport transforms, and overlays. It can be
replaced without changing the edit protocol. A selected object is identified by its
document ID, never by a Pixi container or DOM element reference. The same ID connects the
layer row, property form, canvas, and history entry.

I would use narrowly selected store subscriptions. A remote cursor moving should update a
cursor overlay without rerendering every property form. A zoom change should update a
container transform, not rewrite the document's object coordinates. These separations are
more important than the particular state library.

The URL carries file, page, and mode. Selection, viewport, tool, and open panels remain
session state. Back navigation can restore a bounded view checkpoint after
reauthorization; it must not display an old private page before checking access.

Opening a file establishes a connection generation. All HTTP results, socket callbacks,
image loads, and worker results carry the file/generation they belong to. An old response
for file A cannot replace file B after the user navigates away. Aborting work saves
resources; checking generation protects correctness even when an abort arrives too late.

I would keep the file shell usable during a rendering failure. The layers and properties
panels can still describe the scene, offer retry, and preserve pending work. That is a
useful failure boundary, although a complete accessible fallback requires designed
controls rather than merely leaving a sidebar visible.

## 💾 State and document model — 4 minutes

| State | Contents | Lifetime |
|---|---|---|
| Canonical document | Object records, page/tree order, applied sequence | Current authorized file |
| Pending edits | Stable operation IDs, immutable payloads, receipt status | Until accepted, rejected, or explicitly resolved |
| Gesture preview | Pointer origin, selected objects, temporary transform | One drag or resize |
| Selection | Object IDs, focused layer, active handle | Current file/page |
| Viewport | Pan, zoom, device scale | Current view |
| Presence | Connection ID, page, cursor, expiry | Short-lived and replaceable |
| Render cache | Geometry, text layout, decoded resources | Bounded and disposable |
| Undo history | Gesture effects, inverse intent, property revisions | Bounded per file and user session |

Object IDs are stable. Each object has a type, parent, sibling order, transform, style,
and optional text content. The tree is separate from the renderer's scene containers. A
frame's position is relative to its parent; screen coordinates are derived from the
ancestor transforms and viewport.

Related fields can form one atomic property group. For example, x and y represent one
position update so two concurrent movements cannot produce an accidental mix of
coordinates. Fill and position can remain independent. Text is one property for this
scope; character-level collaboration would require a different model.

The displayed scene combines committed state, unresolved local edits, and the current
gesture preview. Keeping those layers separate lets a rejected edit be removed without
restoring a whole old document and erasing a colleague's work.

I would store inactive page metadata without loading every page's geometry. The active
page's object records may still be needed for layers, search, and hit testing even when
offscreen graphics are culled. Rendering fewer objects does not by itself make document
memory bounded.

## 🔌 Interfaces and one edit — 4 minutes

| Interface | Contract | Important outcome |
|---|---|---|
| GET `/api/v1/files/:id/bootstrap` | Authorized metadata, snapshot reference, stream boundary | Establish a consistent starting revision |
| WebSocket `/api/v1/files/:id/stream` | Join/replay, edits, receipts, presence | Distinguish durable and ephemeral messages |
| GET `/api/v1/files/:id/versions` | Bounded version metadata | Avoid transferring all snapshot bodies |
| POST `/api/v1/files/:id/restore` | Version, expected revision, stable request ID | Produce an ordered new document generation |

These are proposed interfaces. They are not the local repository's exact routes. Snapshot
bytes may arrive through an authorized URL, but their manifest must bind file, sequence,
schema version, and checksum. The stream coordinator buffers later events within a limit
while the client installs the snapshot and catches up.

During a drag, the tool previews changes locally on the next animation frame. It sends a
bounded semantic patch at a chosen cadence and a final patch on release. The same preview
can update the properties panel without waiting for the server. Cursor presence can move
more frequently because it is replaceable.

An ACK identifies the operation and its canonical sequence/effective patch. A rejection
identifies the operation and a reason such as deleted object or lost permission. Neither
is inferred from the WebSocket's open state. Once sent, an operation ID and payload remain
unchanged across retries.

For an initial implementation I would allow one durable batch in flight per file and
coalesce unsent previews. This simplifies local ordering and reconciliation. If latency
limits editing throughput, I would add a defined client sequence and pipeline batches
rather than assume concurrent sends are automatically ordered through asynchronous server
handlers.

## 🔧 Deep Dive 1: Rendering and input without losing semantics — 7 minutes

> “I would choose a retained GPU scene for the visual workspace and ordinary DOM
> controls for the editor shell. My reason is the transform-heavy workload, not a
> belief that every SVG scene is slow.”

With many visible objects, rendering preparation, text layout, and allocations can consume
the frame budget before the GPU draws anything. I would measure those stages separately. A
scene with 10,000 tiny rectangles is different from a scene with thousands of distinct
fonts, textures, masks, and transparency layers.

The renderer keeps object-ID-to-graphics mappings and a dirty set. A movement updates an
existing transform. A fill edit changes the corresponding style. Geometry is rebuilt only
when shape structure changes, and text is laid out again only when content or relevant
font constraints change.

I would avoid rebuilding all shape children when any cursor moves. Removed graphics and
textures need explicit ownership and disposal. Reusing containers while continually
allocating their children still causes memory churn during an hour-long session.

Culling uses conservative world-space bounds, including strokes and effects. A small
overscan region reduces pop-in near viewport edges. Rotated objects need transformed
bounds; checking only an unrotated rectangle can remove a visible corner. Objects crossing
the viewport remain candidates until precise testing.

For hit testing, I would start with a reverse layer-order scan on small pages. A spatial
index becomes useful when measured pointer work exceeds budget. It returns bounding-box
candidates, which are tested precisely in each object's local coordinate system. Ellipse
corners should not behave like filled rectangles.

The index has an update cost. During a drag I can update the moved candidates or check the
preview objects separately. Rebuilding the full index per pointer event would trade one
bottleneck for another. A zoom changes the viewport transform; it does not move every
object in world space.

Pointer capture keeps a drag consistent when the pointer leaves the canvas. Pointer
cancel, Escape, window blur, and navigation each have an explicit cleanup path. Cancelling
a preview does not silently undo a batch that already committed; that committed effect
requires an ordinary inverse operation.

I would sample pointer events and draw the latest position once per animation frame.
Expensive geometry work may move to a worker after profiling. Worker output must identify
the document and geometry revision; a late result cannot replace newer bounds after a
remote edit.

The accessibility cost of a canvas is substantial. The layer tree needs keyboard
navigation, meaningful names, selection state, and commands to move/reorder/delete.
Properties need actual labels, valid numeric ranges, and understandable errors. A
pointer-only resize handle is not a complete editing workflow.

Text fields suspend global shortcuts while focused, including IME composition. Screen
readers should receive concise save/conflict announcements, not a message for every mouse
coordinate or collaborator movement. A virtualized layer list must keep its focused row
represented or manage focus explicitly.

| Approach | Why it can work | Cost for this scope |
|---|---|---|
| ✅ Retained GPU scene plus DOM controls | Efficient transform updates and shared semantic panels | Imperative bridge, resource management, accessible alternatives |
| ❌ One React/SVG node for every large-scene object | Excellent inspection and native semantics for smaller scenes | More browser work as scene/detail grows; must benchmark |
| ❌ Move the entire editor into a worker | Frees some main-thread computation | Harder focus, input, serialization, and lifecycle boundaries |

I would keep a smaller Canvas 2D or SVG implementation viable if it meets the actual
benchmark. The renderer choice does not excuse missing culling, poor text caches, or
invalid pointer math.

## 🔧 Deep Dive 2: Optimism, canonical order, and reconnect — 7 minutes

> “A local rectangle can move immediately, but I would not label the file saved
> until the server accepts the operation. The client needs both a prediction and a
> committed base to handle those two truths.”

Suppose Alice moves a shape while Bob changes its fill. Both edits should survive because
they target different property groups. If both move the same shape, the server's committed
order determines its final position for this design. The frontend must eventually adopt
that outcome even if its optimistic prediction was different.

I would apply incoming committed events to canonical state in sequence order, then derive
the displayed state with pending local overlays. An older committed position should not
flicker over a newer unsent preview. However, preserving the preview forever would be just
as wrong: accepted or rejected operations eventually leave the pending layer and expose
the canonical result.

The origin reconciles its own operation by ID. Filtering all events by user ID would hide
another tab's changes and any server-adjusted result. A duplicate ACK or event can be
harmless because the receipt map and applied sequence tell us whether its effect is
already incorporated.

A sequence gap stops advancement of the canonical base. Later events can wait in a bounded
buffer while the missing range is requested. If recovery would exceed the bound or the
server has compacted the needed history, the client requests a new snapshot and resolves
pending operations against that state.

Reconnect is an explicit process:

1. Authenticate again and bind a new connection generation to the file.
2. Recover the last committed sequence through replay or a verified snapshot.
3. Look up receipts for edits whose previous outcome is unknown.
4. Resend unresolved operations with their original IDs and immutable payloads.
5. Remove accepted overlays, explain rejected edits, and resume new submissions.

A timeout means the outcome is unknown, not that the operation failed. Changing its ID and
retrying can create two effects. Reinterpreting the same ID against a new snapshot is also
unsafe if its payload changes; that is a new user-approved intent after the old outcome
has been resolved.

The pending queue needs count, byte, and age limits. When disconnected, the UI can
continue a small amount of work and show the pending state. Once the limit is reached,
pause new durable edits and offer a recoverable draft path appropriate to the file's
confidentiality policy. Do not silently discard the oldest edits.

For reload/crash recovery, a scoped IndexedDB journal can persist pending intents. That is
a product decision with account/logout cleanup and retention requirements. An in-memory
reconnect queue alone does not promise survival after a browser crash. The first release
can state that distinction clearly.

Presence follows a lighter path: connection ID, cursor, page, and expiry. Coalesce
intermediate cursor positions and expire them locally. It is acceptable for a cursor to
disappear during a broker outage while document edits continue. Using the durable
operation queue for presence would let replaceable traffic delay actual work.

| Approach | Benefit | What I give up |
|---|---|---|
| ✅ Canonical base plus pending overlay | Immediate editing with accountable reconciliation | More state and explicit rejection handling |
| ❌ Replace the whole scene on every update | Simple response handling | Loses local intent and can overwrite concurrent work |
| ❌ Full offline CRDT immediately | Potential multi-writer convergence | More merge, tombstone, permission, and undo semantics than this scope needs |

## 🔧 Deep Dive 3: Collaborative undo and file lifecycle — 7 minutes

> “Undo should reverse my gesture without returning everyone to an old screenshot
> of the document. I would represent it as a conditional inverse edit.”

A drag may produce many previews and several committed patches, but the user expects one
undo entry. The history entry records its initial position, final accepted effect, and the
property revision that effect produced. It does not contain 50 copies of the entire file.

Suppose Alice moves a rectangle from x=10 to x=80, then Bob makes it blue. Alice's undo
can restore the position while preserving Bob's fill. If Bob instead moves it to x=120,
Alice's inverse sees that the position revision changed and returns a conflict. The UI
explains that the object was moved by another edit; it does not secretly overwrite Bob's
work.

I would choose a conservative all-or-nothing inverse for a selected multi-object gesture
in the first version. If any guarded target changed, show the affected objects and let the
user review. Partial undo could be useful later, but it needs clear per-object outcomes
and a redo model that records what actually succeeded.

Deleting an object is harder. Undo needs its relevant content and placement, including
hierarchy context. A restore of a deleted object should be an explicit validated
operation, with a new identity or a carefully specified restoration rule. It must not make
an unrelated stale update resurrect an object accidentally.

Redo is derived from the successful undo result and its new revisions. It is not simply
replaying the original forward payload against whatever exists now. A refused undo does
not create a successful redo entry. Unknown outcomes remain pending until their receipts
are resolved.

The cost of conditional undo is that it sometimes cannot perform the familiar single-user
action. That is a deliberate product choice: preserving a colleague's subsequent work
matters more than making the button always succeed. The error must identify the
conflicting objects and offer a comprehensible next step.

Named versions solve a different problem. Before saving one, establish a barrier for this
client's pending edits and request a snapshot of a specified committed revision. Otherwise
“Save Version” may omit the changes visible on screen. The button should wait or explain
which work remains pending.

A file-wide restore affects everyone. Show the selected version and current revision,
confirm the action, then submit an ordered restore request. The server creates a new
generation and all clients replace their canonical scene together. Old-generation pending
edits pause for review instead of being replayed blindly.

History and selection are scoped by file and generation. After a restore, old history
entries cannot be treated as valid inverses of the new document. Keeping an optional old
draft for review is different from applying it automatically. Navigation to another file
also resets the active subscription and history scope.

The same lifecycle discipline covers asynchronous rendering. An image that finishes
loading after its object was deleted cannot attach to a destroyed container. A worker
calculating old text bounds cannot move selection handles on a new file. A socket closed
during unmount cannot schedule a new subscription without an active generation check.

| Approach | Benefit | Cost or failure |
|---|---|---|
| ✅ Conditional inverse per gesture | Preserves unrelated edits and uses ordinary authorization | Conflicts require explanation and review |
| ❌ Whole-document snapshot undo | Easy for a single-user prototype | Erases collaborators' work and consumes history memory |
| ❌ Restore through an isolated HTTP overwrite | Simple storage update | Connected clients keep old state and overwrite the restore |

## 📈 Performance, failure handling, and validation — 4 minutes

I would validate the user journey on a representative desktop with a dense page, rotated
objects, text, hidden layers, and several collaborators. Measure input sampling, scene
derivation, hit testing, drawing, and allocation separately. A frame-rate average hides
long stalls, so inspect tail latency and slow frames.

Memory checks matter over a long session. Bound undo entries, pending operations, page
caches, decoded assets, geometry caches, and collaborator records. Virtualize large layer
lists with stable object IDs and preserve keyboard focus. Culling GPU objects alone does
not control any of those other allocations.

| Failure exercise | Expected result |
|---|---|
| ACK lost after commit | Retry returns the original outcome without another effect |
| Two clients move the same shape | Both settle on one canonical position after pending edits resolve |
| File switch during load | Old HTTP/socket/worker results cannot alter the new file |
| Undo after a collaborator moves a target | Explicit conflict, no silent overwrite |
| Restore with a disconnected editor | Old-generation edits wait for review |
| Renderer initialization fails | Clear error, retry, preserved pending state, usable semantic controls |

I would also test keyboard-only drawing/property edits, IME text entry, zoomed hit tests,
pointer cancellation, permission revocation, and snapshot installation while new
operations arrive. These cases exercise the architecture's boundaries rather than only
checking that a canvas element exists.

Operational telemetry should report pending age, rejection reasons, replay time, and
rendering costs without logging private design text or asset URLs. A saved indicator is
tied to receipt state; a presence count is never used as a durability signal.

## ⚖️ Trade-offs and close — 2 minutes

| Decision | Chosen approach | Alternative |
|---|---|---|
| Visual editing | ✅ Retained scene with DOM controls | ❌ One universal UI/rendering state tree |
| Synchronization | ✅ Canonical revision plus pending overlay | ❌ Unqualified optimistic replacement |
| Undo | ✅ Conditional inverse gesture | ❌ Whole-file rewind |
| Offline scope | ✅ Bounded recovery with explicit conflicts | ❌ Unlimited merging without a defined protocol |

> “The key boundary is between what the user is previewing and what the shared
> document has committed. A renderer makes the preview fast; the operation protocol
> makes recovery and undo understandable. I would prove those two paths together
> before adding a larger tool catalog.”

The repository demonstrates React/Pixi integration and local optimistic editing. Its
missing user persistence, canonical reconciliation, reliable history, and cross-process
sync are implementation gaps described in [architecture.md](./architecture.md). This
interview design proposes those guarantees rather than attributing them to the current
demo.

# Excalidraw: Full-Stack System Design Interview

## 🎯 Scope and User Contract — 4 minutes

> “I’ll design a collaborative drawing board by following one gesture from the pointer to
> durable storage and back to the other browsers. The important distinction is between a
> responsive local draft and an edit the service has actually accepted.”

The product lets people create drawings, draw basic shapes and freehand strokes, add text,
and share boards with viewers or editors. An owner manages access. Public boards are
readable without granting everyone permission to modify them.

I would initially support connected collaboration, short disconnections, and local draft
recovery. I would ask whether days of independent offline editing must merge automatically.
For this answer, that is outside the first release; it would materially change the
synchronization model.

The first version has rectangles, ellipses, diamonds, lines, arrows, freehand strokes, and
plain text. I would defer rich text, image uploads, comments, and arbitrary plugin elements.
Selection, movement, styling, pan, zoom, and useful failure feedback already provide
substantial design depth.

| Concern | Initial target or behavior |
|---------|----------------------------|
| Local feedback | Draw the next frame without waiting for a server |
| Rendering | Aim for a 16.7 ms frame budget on the supported scene profile |
| Peer previews | Regional p95 below 150 ms under ordinary load |
| Saved state | A durable command receipt, with a proposed p95 below 250 ms |
| Collaboration | One accepted order per drawing; explicit property conflicts |
| Initial profile | About 1,000 elements and up to 20 collaborators per board |
| Availability | Proposed 99.9% regional availability |

These numbers are targets for a proposed design. They are not measurements of the local
implementation. A user must still be able to distinguish offline, pending, rejected, and
accepted work when those targets are missed.

I would use PostgreSQL for identities, permissions, accepted editing events, and receipts;
Redis for sessions and optional ephemeral distribution; and a Canvas 2D renderer inside a
React application. The architecture should make it possible to change rendering
optimizations without changing the collaboration contract.

## 🏗️ Architecture and State — 6 minutes

```
┌──────────────────────┐     ┌──────────────────────┐
│ React tools / routes │────▶│ Scene + pending edits│
└──────────────────────┘     └──────────┬───────────┘
                                        │
                                        ▼
┌──────────────────────┐     ┌──────────────────────┐
│ Canvas / DOM overlays│◀────│ Client coordinator   │
└──────────────────────┘     └──────────┬───────────┘
                                        │ HTTP / WebSocket
                                        ▼
                             ┌──────────────────────┐
                             │ Drawing authority    │
                             └──────────┬───────────┘
                                        │
                                        ▼
                             ┌──────────────────────┐
                             │ PostgreSQL log/state │
                             └──────────────────────┘
```

React owns navigation, tool controls, dialogs, and accessible object controls. The renderer
consumes scene state and a temporary gesture draft. A client coordinator owns joining,
pending commands, canonical events, reconnecting, and the visible save status.

The backend exposes ordinary HTTP endpoints for sessions, drawing discovery, and membership
management. A WebSocket connection carries editing commands, their outcomes, accepted
events, and disposable presence. Both transports use the same authorization rules; neither
is a shortcut around the drawing authority.

| Client state | Examples | Lifetime and ownership |
|--------------|----------|------------------------|
| Accepted scene | Elements, stacking order, accepted sequence | Canonical server state mirrored locally |
| Pending commands | Operation ID, target, expected revision, intended change | Durable local queue until outcome is known |
| Gesture draft | Current stroke points or drag preview | Local pointer interaction |
| View state | Pan, zoom, selection, active tool | Local to the drawing view |
| Presence | Connection identity, cursor, last seen | Ephemeral and independently expiring |
| Account state | Current session and permissions | Must scope all drawing and pending state |

I would avoid one undifferentiated object that mixes these lifetimes. A room snapshot may
replace the accepted scene, but it must not silently delete a local draft. A remote cursor
should not rewrite the scene. Logging out must not cause the next account to submit the
previous account’s pending commands.

The durable data model is similarly small at first:

| Record | Important contents |
|--------|--------------------|
| Drawing | Owner, title, visibility, lifecycle generation, accepted sequence |
| Membership | Drawing, user, view/edit role |
| Element state | Stable ID, lifecycle, geometry/style/text revisions, explicit order |
| Command receipt | Drawing, actor, operation ID, body digest, recorded outcome |
| Accepted event | Drawing sequence and canonical change |
| Snapshot | Scene content and the last sequence it includes |

Geometry is one property group, style another, and text content another. We can store a
scene as a snapshot while recording accepted changes separately. Choosing JSON storage does
not itself provide concurrency control, authorization, or retry safety.

Drawing lists return summaries and paginate. Downloading every full scene merely to display
its element count wastes bandwidth and makes a growing collection slow before a user opens a
board.

## 🎨 Deep Dive: From Pointer to a Visible Gesture — 8 minutes

> “I’ll keep pointer feedback local and compose one explicit transform between world
> coordinates and the display. Collaboration is easier to reason about when the geometry
> model does not depend on a particular browser’s pixels.”

Elements live in world coordinates. Pan and zoom map those coordinates to CSS pixels. The
device pixel ratio then maps CSS pixels to the canvas backing bitmap. Hit testing inverts
the world-to-CSS transform; it should not apply the device ratio a second time.

For example, a point at world x = 100, with zoom 2 and pan 20 CSS pixels, appears at CSS x =
220. On a display with a device ratio of 2, its backing-bitmap coordinate is 440. A DOM
cursor overlay still uses CSS x = 220 because the browser handles its physical pixels.

The canvas transform must combine the device ratio, zoom, and pan. Calling a transform
setter for the device ratio and then calling it again for zoom replaces the first transform.
That can make the grid, shapes, selection, and pointer disagree even when each calculation
looks plausible in isolation.

I would verify this with the same small scene at several zoom levels and display ratios,
including moving a window between displays. Text, selection bounds, cursors, and hit testing
should remain aligned. Resizing the canvas must reapply the complete transform because
changing the bitmap dimensions resets its drawing state.

Canvas 2D is a good initial fit for a drawing surface with freehand paths and frequent scene
updates. React can remain responsible for controls around it. I would not claim that SVG
fails at a universal number of objects, or that WebGL automatically makes every interaction
faster; those thresholds depend on the elements and workload.

| Rendering choice | Why consider it | Cost |
|------------------|-----------------|------|
| ✅ Canvas 2D initially | Direct control of drawing and frame scheduling | Manual hit testing, accessibility, and redraw policy |
| ❌ SVG for this initial implementation | Native DOM elements and useful interaction primitives | Many detailed paths can create substantial DOM work |
| ❌ WebGL immediately | Useful for demanding, measured rendering workloads | More complex text, shape, and resource handling |

The trade-off is that Canvas does not give us accessible objects for free. I would provide a
DOM object list, keyboard selection and movement, labeled controls, and visible focus. The
collaboration protocol should not care whether an edit originated from a mouse, keyboard, or
another accessible control.

Pointer input updates a temporary draft, and a requestAnimationFrame loop renders the latest
draft. We do not need a React state update or a durable network command for every sampled
point. Store selectors can keep a cursor update from rerendering all toolbar controls.

I would use pointer events and capture for an active gesture. Releasing outside the drawing
surface still finalizes or cancels it correctly. Pointer cancellation, Escape, navigation,
and a revoked edit permission each have an explicit cleanup path so an old gesture cannot
resume in a new drawing.

Freehand drawing collects points locally, renders a preview, and simplifies the completed
path before committing it. The simplification tolerance should correspond to screen-space
error: a fixed world-space tolerance becomes more visible as the user zooms in.

A segment-distance simplifier must measure distance to the bounded segment, not an infinite
line. A path that goes forward and then doubles back along the same line should not collapse
into a short segment merely because all points are collinear. Endpoint preservation and
point-count limits are useful checks; a fixed compression percentage is not a correctness
guarantee.

Rectangle and diamond gestures also need normalized bounds when the user drags left or
upward. Renderers, hit tests, and selection outlines must agree on that representation. It
is easy to draw a negative-width shape convincingly while leaving its selection math
incorrect.

At pointer release, the client freezes the intended result into one command, assigns an
operation ID, and places it in a recoverable pending queue. The draft remains visible as an
optimistic overlay until a canonical outcome arrives. A style change follows the same
command path; it cannot be a purely local mutation that only sometimes reaches the server
through a later Save action.

The cost of this layered approach is extra coordination between accepted state, pending
intent, and the active gesture. It prevents the more damaging failure where a fresh snapshot
clears a stroke the person can still see themselves drawing.

## 🔄 Deep Dive: What Does a Collaborative Edit Mean? — 10 minutes

> “I’ll use one accepted command order per drawing and conditional property-group revisions.
> That supports responsive connected collaboration without claiming that arbitrary object
> replacement will merge safely.”

Imagine Alice dragging a rectangle and Bob changing its fill. Alice’s command expects
geometry revision 7; Bob’s expects style revision 3. The authority can accept both because
they affect independent groups. Every client then receives the same canonical element
revisions and drawing sequences.

If both move that rectangle from geometry revision 7, the first accepted move advances the
group. The second receives a conflict. We keep its local intent available and let the person
reapply it after seeing the new position. That new decision gets a new operation ID and
expected revision.

This is a deliberate product choice. Independent field merging could combine coordinates and
dimensions that no one intended. Replacing the entire element could discard Bob’s color just
because Alice moved it. Property groups are an explicit compromise between those extremes.

| Conflict model | Benefit | What it gives up |
|----------------|---------|------------------|
| ✅ Ordered commands with group checks | Predictable acceptance and independent move/style edits | Same-group conflicts need user-visible recovery |
| ❌ Whole-element timestamp winner | Simple initial reducer | Independent edits can disappear; client clocks become contentious |
| ❌ Full offline CRDT at the outset | Can support richer independent replica editing | Requires a larger, carefully validated merge and lifecycle model |

If long offline editing becomes essential, I would evaluate a mature CRDT library rather
than extend a timestamp helper indefinitely. We would still need authorization, persistence,
transport recovery, ordering semantics, and an undo policy; the data structure does not
remove those responsibilities.

The command includes the operation ID, drawing generation, target, expected group revision,
and change. The server derives the actor from the authenticated connection. It validates
supported fields, finite coordinates, payload size, point count, and current edit permission
before attempting a state transition.

Within a transaction, the server checks its drawing ownership epoch, validates the expected
revision, allocates the next drawing sequence, changes canonical state, and records the
accepted event and retry receipt. These facts commit together.

Only then does it acknowledge the sender and distribute the canonical event. The sender must
receive that result too: optimistic rendering is not proof that the server accepted the same
state. Peers apply the supplied revisions directly rather than incrementing them again on
receipt.

The receipt key is scoped to the drawing and authenticated actor, with a body digest.
Retrying the same ID and body returns the recorded result. Reusing that ID for a different
change is rejected. This handles a lost acknowledgment without guessing whether the first
command committed.

```
┌──────────────────────┐     ┌──────────────────────┐
│ Local pending command│────▶│ Validate and commit  │
└──────────────────────┘     └──────────┬───────────┘
                                        │
                                        ▼
                             ┌──────────────────────┐
                             │ Canonical acceptance │
                             └──────────┬───────────┘
                                        │
                                        ▼
                             ┌──────────────────────┐
                             │ Sender and peers     │
                             └──────────────────────┘
```

Deletion has its own lifecycle semantics. A deleted element retains a generation boundary or
tombstone so delayed updates cannot revive it. Restore is an explicit authorized action.
Simply accepting an old “add” for an existing ID would bypass that protection.

Stacking order is explicit as well. For the first release, creation order can derive from
accepted server sequence. If two clients insert objects in different local array orders,
relying on those arrays alone can show different overlap even when they agree on every
object’s fields.

Undo is a conditional inverse of the user’s own operation. If the affected group has changed
since then, undo may conflict. Restoring an entire earlier scene would erase other
collaborators’ work, so a familiar single-user history stack is not sufficient.

There is also a boundary between previews and commands. During a drag, peers can see a
throttled temporary preview. It does not replace accepted geometry and can expire. On
release, the durable command either accepts or conflicts; losing previews does not lose the
final accepted edit.

The main cost is visible conflict handling and a persistence round trip before the saved
state advances. I consider that acceptable for this scope because the person still gets
immediate local rendering, while the service can explain exactly which shared change it
accepted.

## 💾 Deep Dive: Recovery and Permission Changes — 9 minutes

> “The hardest full-stack failures occur between otherwise reasonable components: a room
> loads while editing has begun, a save commits after the response is lost, or access
> changes while a socket remains open.”

I would make joining a sequence-based operation. The server authorizes the room, establishes
a delivery boundary, and sends a snapshot through sequence N followed by the durable tail
after N. It either buffers concurrent events during delivery or replays through a known
high-water mark before switching to live events.

A snapshot fetch followed by an unrelated subscription has a gap. A subscription followed by
an unguarded late HTTP response can overwrite newer events. The client coordinator therefore
owns one synchronization flow and applies only responses matching the current drawing and
subscription generation.

Accepted state and pending local intent remain separate while this happens. A snapshot
replaces the accepted base, after which pending commands are checked against that base. It
does not simply clear the entire application store and discard unfinished work.

On reconnect, the client reauthorizes, catches up from its last accepted cursor, and
resubmits unresolved operation IDs. A command committed before the disconnect returns its
existing receipt. A command whose expected revision is stale is rejected explicitly, with
the draft preserved for reapplication or recovery.

The pending queue is durable locally and scoped to the account, drawing, and lifecycle
generation. Signing out, switching accounts, or navigating away must prevent a late callback
from applying another drawing’s snapshot or sending another user’s pending work.

| Recovery design | Why it works | Cost |
|-----------------|--------------|------|
| ✅ Snapshot plus ordered tail and receipts | Closes join gaps and resolves uncertain submissions | Cursor, retention, and pending-state coordination |
| ❌ Replace the scene on every reconnect | Easy to implement | Can erase offline intent and race newer remote edits |
| ❌ Replay an old full scene as the latest truth | Appears to preserve the reconnecting client | Overwrites work accepted while that client was absent |

The server persists accepted commands before acknowledging them. Snapshots are asynchronous
accelerators: materialize through a known sequence, verify the result, then publish its
pointer. The log can be trimmed only when a valid snapshot and the supported recovery policy
make that history unnecessary.

A debounce timer is unsuitable as the only durability boundary. Two seconds after the last
edit is not the same as a maximum two seconds of unsaved work. Continuous activity can
postpone the write, and neither a final disconnect nor graceful shutdown is guaranteed to
occur before a crash.

Tombstone and receipt compaction must respect old clients. I would define a supported
history floor; clients older than that must resynchronize and rebase recoverable drafts.
Deleting all retry evidence while continuing to accept arbitrarily old commands invites
duplicate effects or resurrected objects.

The UI should show accepted progress separately from the socket’s connected status.
“Connected” means the transport is open. “Saved” means the relevant pending edits have
durable outcomes. If storage is down, local drawing may continue within bounded draft
storage, but the user sees that it is still pending.

Access follows the same boundary. Session validation and origin checks happen at upgrade;
room read permission is checked at join; current edit permission is checked for commands. An
authenticated person viewing a public board does not become an editor simply because they
opened a WebSocket.

When the owner revokes access, the server invalidates the active subscription or editing
permission and rejects later unauthorized commands. The browser cancels active editing and
preserves unaccepted work as a recoverable local draft where appropriate. Disabling a button
alone is not enforcement.

A private drawing’s authorization cannot depend solely on a cached copy of an old public
flag. Permission changes need an authoritative check or a clearly controlled invalidation
protocol. The same protection must cover HTTP saves, collaborator listings, and socket
messages.

The trade-off is complexity at component boundaries: permissions, synchronization cursors,
and local drafts must move together. That work is justified because the alternative failure
is not just a stale display; it is a person losing work or retaining access after it was
removed.

## 📈 Scaling and Verification — 6 minutes

Assume 5,000 active boards with four participants each: 20,000 sockets. If 10% of users
complete two gestures a second, the durable path handles 4,000 commands per second. At an
assumed 500 bytes each, that is 2 MB/s before indexes, replication, and protocol overhead.

Presence is a different workload. Five thousand moving users at 10 Hz generate 50,000
updates per second. Sending each to three peers at 200 bytes is about 30 MB/s of payload. We
should coalesce old cursors rather than put them into the durable command log.

I would partition ownership by drawing. Each active drawing has one fenced owner, and
storage rejects a superseded owner’s epoch. Adding Redis pub/sub without that ownership rule
does not prevent several servers from saving incompatible room copies.

Hot boards and many small boards need different tests. A popular board can distribute
delivery to viewers separately while retaining one edit order. Admission limits and bounded
scene sizes protect a process from an unexpectedly large room.

Presence uses connection IDs, not only user IDs, so two tabs do not erase or suppress each
other. Entries carry last-seen times and expire independently. A room-wide TTL refreshed by
any participant cannot reliably expire one disconnected participant.

Slow sockets also need limits. Drop or replace stale presence. Bound reliable event queues,
then disconnect a client that must resynchronize from a durable cursor. Keeping unlimited
messages in memory sacrifices healthy collaborators to a slow reader.

| Scenario | Full-stack check |
|----------|------------------|
| Different device ratios and zoom levels | Shape, cursor, selection, and hit test remain aligned |
| Pointer released outside the canvas | Gesture finalizes or cancels without becoming stuck |
| Snapshot arrives during a local stroke | Accepted base updates while local intent remains recoverable |
| Concurrent move and recolor | Both independent groups appear in the accepted scene |
| Two concurrent moves from one revision | One result accepts and one conflict is understandable |
| Crash after commit before acknowledgment | Reconnect removes pending state using the original receipt |
| Navigation or account switch during loading | Late events cannot overwrite the new context |
| Editor becomes a viewer while connected | Server rejects later edits and UI updates permissions |

I would combine reducer tests, real database and socket integration tests, and browser
tests. Two browser pages should verify the same accepted sequence and scene after
reconnecting, not merely verify that each canvas element is visible.

Operationally, I would measure frame time and input delay on the client, durable
acknowledgment latency and conflict rate on the server, and sequence gaps, snapshot lag,
pending age, and socket backlog across both. Arbitrary drawing IDs and client-supplied event
names should not become unbounded metric labels.

The order of improvement follows evidence. First establish access, canonical acceptance, and
recovery. Then profile rendering and large-room fanout. Adding spatial indexes, worker
rendering, or extra room processes before the contract is correct would make the same
failures harder to reproduce.

## 🏁 Repository Mapping and Closing — 2 minutes

The local project demonstrates a React and Canvas interface, seven shape types, HTTP drawing
storage, and WebSocket collaboration in one Node process. PostgreSQL stores full scenes;
Redis provides sessions, cached drawing rows, and cursor records. It is useful for tracing
the interaction path, but it does not implement the stronger protocol described here.

Current socket joins and edits lack authentication and permission enforcement. Room
initialization and later HTTP scene responses can overwrite newer state, remote versions are
rewritten by clients, and debounced writes have no durable acknowledgment or recovery log.
The operations table is unused.

On the frontend, there is no live gesture preview consumer, selected styling changes stay
local until an HTTP save, and the scene transform replaces the fixed backing-scale
transform. Resize handles do not implement resizing. Export endpoints are placeholders. The
[architecture document](architecture.md) records these and the remaining local limitations
alongside the actual schema.

> “My first end-to-end milestone would be one gesture that renders correctly, receives a
> canonical durable receipt, appears identically in a second browser, and survives
> reconnecting. I would then apply that contract consistently to every editing action and
> permission change.”

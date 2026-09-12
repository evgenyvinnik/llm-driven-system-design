# Excalidraw Whiteboard — Frontend System Design

> “I would separate three things: the gesture under the user's pointer, the drawing state
> accepted by the server, and the viewport used to display it. That keeps local drawing
> responsive without confusing a visible edit with a saved edit.”

This is a proposed 45-minute interview design. I would draw a small architecture, explain
the coordinate model, and follow one gesture through collaboration and recovery. The local
teaching app implements only part of this design.

| Discussion | Minutes |
|------------|---------|
| Requirements and scope | 4 |
| Frontend architecture | 5 |
| State ownership | 4 |
| Deep dive: coordinates and rendering | 8 |
| Deep dive: gestures and editing intent | 8 |
| Deep dive: collaboration and recovery | 10 |
| Performance, accessibility, and verification | 4 |
| Implementation boundary | 2 |

## 🎯 Requirements and Scope — 4 minutes

“I will support a shared canvas with rectangles, ellipses, diamonds, lines, arrows, freehand
strokes, and text. Users can pan and zoom independently, select and move objects, change
styles, and see collaborators' cursors.”

I would clarify whether the product needs rich text, image import, touch/stylus input, group
selection, export, and offline work. For this design I include mouse/touch/pen gestures,
simple text, and recoverable disconnected drafts. Unrestricted offline merging and
character-level concurrent text are separate extensions.

The drawing can contain objects outside the current viewport; “infinite” means an unbounded
logical coordinate plane within practical numeric and document-size limits. We do not
allocate a bitmap covering the entire plane. The visible canvas stays the size of the
screen.

Local feedback should fit within a 16.7 millisecond frame budget on a defined reference
device. Peer previews can target p95 below 150 milliseconds in one region, and durable edit
acknowledgment below 250 milliseconds for ordinary commands. These are proposed targets to
measure, not benchmark results.

The interface must distinguish view permission from edit permission and preserve local work
when access or connectivity changes. It must not show “saved” merely because a WebSocket
send returned without throwing.

For the interview, I would use a move-and-recolor example throughout. Alice moves a
rectangle while Bob changes its color. Those independent intentions should coexist. Two
people moving the same rectangle require a clear conflict rule; a fast renderer cannot solve
that by itself.

## 🏗️ Frontend Architecture — 5 minutes

I would use React for navigation, controls, dialogs, and accessible object information. A
scene engine manages drawing state and an imperative renderer consumes snapshots of that
state. React should not need to reconcile a component for every sampled point in a pen
stroke.

```
┌──────────────────────┐      ┌──────────────────────┐
│ Pointer / keyboard   │─────▶│ Gesture draft        │
│ Local viewport       │      │ Frame invalidation   │
└──────────────────────┘      └──────────┬───────────┘
                                         ▼
┌──────────────────────┐      ┌──────────────────────┐
│ HTTP / WebSocket     │◀────▶│ Scene state          │
│ Durable edit status  │      │ Committed + pending  │
└──────────────────────┘      └──────────┬───────────┘
                                         ▼
                              ┌──────────────────────┐
                              │ Canvas / DOM overlays│
                              │ World-to-screen map  │
                              └──────────────────────┘
```

The scene state and network adapter coordinate accepted commands and pending changes. The
renderer consumes the resulting scene, including the active gesture draft; React owns
controls, forms, and accessible object information around it.

Route boundaries cover the drawing list, login, drawing workspace, and sharing. A drawing
workspace owns its connection lifecycle and scene generation. Navigating away unsubscribes
old handlers and invalidates late HTTP/socket responses rather than letting them populate
the next drawing.

I would start with Canvas 2D because the shape vocabulary is small and its drawing API is
direct. DOM overlays handle text input, collaborator cursors, and accessible controls. SVG
and WebGL remain alternatives, but I would compare actual workloads rather than claim that
one fails at a universal element count.

The network adapter centralizes credentials, payload validation, retry classification, and
operation identity. It checks drawing identity and connection generation on incoming
messages. A shared TypeScript type helps development, but runtime validation still protects
the renderer from malformed geometry or huge point arrays.

## 🧭 State Ownership — 4 minutes

“I would avoid one undifferentiated elements array as the owner of every transient and
durable state. It becomes impossible to tell what can safely be replaced on reconnect.”

| State | Owner / lifetime | Why |
|-------|------------------|-----|
| Committed scene and accepted sequence | Drawing session | Canonical baseline for collaboration and recovery |
| Pending durable commands | Drawing/account-scoped queue, persisted locally | Survive a lost response or page reload |
| Current gesture draft | Local gesture controller | High-frequency feedback before final submission |
| Viewport, selection, active tool | Local editor session | One person's navigation should not move everyone else's view |
| Cursor and preview presence | Ephemeral connection state | Old positions are disposable |
| Auth and drawing permission | Server-validated session/access resource | Local flags do not grant edit authority |
| Unsaved title or dialog input | Form state | Preserve input without overwriting accepted document data |

A Zustand store can implement these boundaries, but use selectors so a cursor update does
not rerender every toolbar and canvas subscriber. The renderer can read a scene snapshot at
the start of an animation frame. Notifications mark work dirty instead of immediately
redrawing on every state change.

Authentication has loading, authenticated, and anonymous states. The workspace waits for
server permission before enabling durable edits. A public viewer can navigate and select for
inspection, but editing controls remain disabled or clearly local-only according to the
product contract.

Private data is keyed by account and drawing. Logout clears private request state and stops
authorized connections. Pending drafts need an explicit retention policy; they must not be
replayed as a different account after login.

## 🎨 Deep Dive: Coordinates and Rendering — 8 minutes

“I choose a shared world-coordinate model with a local viewport transform. Every visual and
interaction path must use the same mapping.”

### Three coordinate spaces

The document stores world coordinates. Pointer events arrive in browser client coordinates.
The canvas bitmap uses backing pixels, which may be denser than CSS pixels on a
high-resolution display.

First subtract the canvas's bounding rectangle from the pointer position to get
canvas-relative CSS coordinates. Then subtract pan and divide by zoom to obtain world
coordinates. Hit testing uses those world coordinates, so the same rectangle remains
selectable after panning or zooming.

For drawing, multiply world coordinates by zoom, add the pan offset in CSS pixels, and
finally multiply by device pixel ratio for the backing bitmap. A point at world x=100 with
zoom 2 and pan 20 appears at CSS x=220, or backing x=440 on a 2× display.

Device pixel ratio affects rasterization, not the document's geometry. It must be applied
exactly once. Replacing the context transform after setting a pixel-density scale can
accidentally erase that scale and leave shapes, hit tests, and cursor overlays misaligned.

On resize, resize the backing bitmap to CSS dimensions times the actual device ratio, reset
the transform deliberately, and preserve the viewport. Moving the window between monitors
can change the ratio without changing the drawing's world coordinates.

### Zoom around the pointer

Before zooming, identify the world point under the pointer. Choose a new bounded zoom and
adjust pan so that world point remains under the same CSS position. This keeps zooming
anchored to what the user is inspecting instead of pulling the drawing toward an arbitrary
origin.

The DOM cursor overlay uses the same world-to-CSS mapping without the backing-pixel factor.
An inline text editor does the same. Selection handles should remain usable in screen
pixels, so their world-space dimensions adapt to zoom.

The background grid has an explicit policy: world-aligned spacing for spatial reference,
with density adjusted when zoomed out. I would not describe a grid as both fixed in screen
space and fixed in world space; those are different behaviors.

### Rendering work and alternatives

The frame reads a stable scene snapshot, clears the affected surface, draws the background
and committed shapes, then pending/draft visuals and selection. If state changes during that
work, schedule another frame. Do not mutate the current rendering snapshot halfway through a
pass.

Start with a full redraw of the visible viewport and basic culling. When profiling shows a
bottleneck, add a spatial index and separate the active draft from mostly static content.
Dirty rectangles require redrawing all intersecting objects in stacking order, not just the
object that moved.

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Canvas 2D with consistent transforms | Direct shape rendering and explicit frame control | Manual hit testing, text overlays, and accessibility work |
| ❌ SVG as the default for this design | Native object events and DOM semantics | Per-object DOM/style work may dominate complex scenes |
| ❌ Immediate WebGL migration | Potential throughput for suitable workloads | More rendering/text integration work before the bottleneck is measured |

Canvas 2D gives up the convenience of native events on each shape. I accept that cost
because the scene engine needs geometry and selection logic anyway. If the product's
strongest requirement were accessible document-like editing rather than freehand drawing,
SVG could be the better starting point.

## ✏️ Deep Dive: Gestures and Editing Intent — 8 minutes

“I choose a draft-and-commit interaction model. Pointer samples make the local preview
smooth; a completed gesture becomes one meaningful durable command.”

### Gesture lifecycle

On pointer down, capture the pointer, select a tool, and create a draft. Pointer movement
updates only that draft or the current local drag overlay. On pointer up, validate and
finalize it, persist the pending command, and submit it. Pointer cancel or Escape abandons
the draft without leaving a half-created shared object.

Pointer capture matters because a user can release outside the canvas. Without it, the
editor may remain stuck in drawing mode or never send the final move. Pen pressure and touch
gestures can extend this controller without duplicating mouse-only handlers throughout
components.

For rectangle-like shapes, normalize bounds or consistently support signed dimensions. Hit
tests, renderers, and selection handles must agree when a person drags up and left. Lines
and freehand paths need segment-based hit testing with a tolerance defined in screen pixels.

The draft must actually be rendered during capture. Storing current points in a global store
does not create a live preview unless a rendering path consumes them. Likewise, drawing
selection handles does not implement resizing; each handle needs a geometry operation and
cancellation behavior.

### Freehand points and simplification

During a stroke, sample input with bounds on point count and work per frame. A preview can
transmit coalesced recent points to peers at a lower rate than local rendering. The durable
stroke contains the final validated path, not every ephemeral preview packet.

I would simplify the final stroke using an error tolerance chosen in screen pixels and
converted to world units by the capture zoom. A fixed two-world-unit tolerance looks very
different at 10% and 500% zoom. Keep the original draft until finalization succeeds so the
client can recover from an interrupted submission.

The simplifier must preserve meaningful corners and backtracking; distance to an infinite
line can erase an excursion beyond the segment endpoints. Measure the rendered error on
representative handwriting and diagrams rather than promising a fixed compression ratio.

### Text, style, and undo

Simple text editing uses an HTML input overlay positioned over the canvas. It supports
selection, composition, keyboard input, and a clear commit/cancel boundary. A browser prompt
is a useful prototype, but interrupts the editor and cannot provide that experience.

Style changes produce the same class of command as geometry changes. Keeping the properties
panel connected only to local state would make the editing experience look successful while
other users never receive the change. Controls should reflect the selected element's current
style, with mixed-value states if multi-select is added.

I would define geometry, style, and text as separate revision groups. A move and recolor can
both succeed. Two changes to the same group from the same base revision conflict; the
interface shows the current accepted state and lets the user deliberately reapply their
intention.

Undo is a new conditional command for the user's own operation, not replacement of the whole
scene with an old snapshot. If someone else changed the same group, blindly applying the
inverse could erase their work. The UI should explain that conflict or offer a scoped
reapplication rather than pretending history is private.

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Local drafts plus completed commands | Smooth input and meaningful undo/retry units | Separate preview, pending, and committed state |
| ❌ Persist every pointer sample | Simple direct event mapping | Excess writes and a history of samples rather than user actions |
| ❌ Replace the whole scene for every gesture | Easy serialization | Can overwrite unrelated work and expensive large-scene payloads |

The trade-off is more state management in the editor. In return, a long stroke remains
responsive, network previews can be dropped safely, and durable operations have
understandable boundaries.

## 🔄 Deep Dive: Collaboration and Recovery — 10 minutes

“I choose a server-ordered accepted scene with optimistic local overlays. I am not claiming
that incrementing timestamps independently in each browser produces a convergent editor.”

### From local gesture to accepted state

A command includes drawing identity, target element, stable operation ID, intended change,
and the relevant expected revision. The server supplies actor identity from authentication,
validates current access, and either commits the command or returns a conflict/rejection.

The accepted response contains canonical element/group state and a drawing sequence. It goes
to the author as well as peers. The author's preview can then become committed state, and
the corresponding pending entry can be removed.

A remote accepted update does not increment the recipient's local version. It applies the
server's revision exactly. Otherwise different browsers would attach different clocks and
versions to the same accepted edit, making later conflict checks meaningless.

For Alice's move and Bob's recolor, geometry and style revisions advance independently. For
two conflicting moves, one expected revision succeeds and the other receives the current
position. That conflict is a product behavior to explain, not a transport bug to conceal.

### Reconnect without losing drafts

```
┌──────────────────────┐      ┌──────────────────────┐
│ Local gesture draft  │─────▶│ Pending operation ID │
│ Immediate rendering  │      │ Recoverable locally  │
└──────────────────────┘      └──────────┬───────────┘
                                         ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Canonical scene      │◀─────│ Durable acceptance   │
│ Accepted sequence    │      │ Or explicit conflict │
└──────────────────────┘      └──────────────────────┘
```

If the connection drops after send, the pending command remains. Reconnect resends the same
operation ID and payload. The server returns its previous receipt if the command already
committed, preventing another application of the effect.

The client resumes from its last accepted sequence or loads a snapshot at a declared
sequence and then catches up its tail. Changes committed during snapshot transfer must be
included. An unexplained gap pauses canonical application and triggers recovery rather than
skipping silently ahead.

After catch-up, the client revalidates pending drafts against current revisions. An old move
may now conflict; a newly created independent shape may still be valid. Replacing local
elements with room state would lose both cases without giving the user a choice.

Pending drafts can live in IndexedDB scoped by account, drawing, and drawing generation. Use
bounded storage and show quota/write failures explicitly. If a user lacks permission on
reconnect, preserve a local recovery option while preventing automatic replay to the shared
drawing.

A client whose history is older than server retention receives a fresh snapshot and a clear
rebase boundary. It cannot resurrect deleted shapes by uploading a stale full-scene array. A
document deleted and recreated under a new generation is also a different target for pending
edits.

### Presence and connection lifecycle

Cursor position and in-progress previews are separate from durable edits. Send the latest
position at a bounded frequency, discard stale positions, and identify each connection
independently so two tabs of one account do not suppress one another.

A newly joined user receives current presence with per-connection timestamps. Cursor expiry
is per participant, not one timer for an entire active room. The UI can interpolate briefly
for smoothness, but must expire a frozen cursor instead of displaying a collaborator
forever.

On navigation, dispose the previous room session, cancel retry timers, and tag all callbacks
with the new drawing generation. A late HTTP scene response cannot overwrite a newer socket
scene. Logout stops the authenticated connection; the server independently enforces
revocation.

### Why this consistency model

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Ordered accepted state plus pending overlays | Predictable recovery, conflict feedback, and saved status | Depends on a regional authority and explicit replay state |
| ❌ Whole-element client-clock LWW alone | Small merge function | Can discard independent intent; equal clocks and inconsistent handlers break convergence |
| ❌ Replace local state on reconnect | Easy initial implementation | Discards unsent changes and hides delivery gaps |

A proven CRDT library is a reasonable alternative for richer offline/text requirements. It
still needs authorization, durable storage, and careful UI integration. For the connected
whiteboard scope, I choose a smaller ordered command contract and accept that stale
disconnected edits may require user resolution.

## ⚡ Performance, Accessibility, and Verification — 4 minutes

I would profile representative scenes with many simple shapes, long freehand paths, text,
heavy zoom, and multiple collaborators. Element count alone is not a rendering budget.
Record frame time, input-to-preview delay, command acknowledgment, and pending queue age.

Use selectors and frame invalidation so presence does not cause unnecessary full scene work.
Add culling and a spatial index when measurements justify them. A worker can handle bounded
expensive simplification or scene preparation, but introduces transfer/version coordination
that also needs profiling.

Canvas needs an accessible companion object list with names, selection, and keyboard
actions. Toolbar controls need accessible names and selected states. Text input should use
native editing behavior, and dialogs need focus management and restoration. Provide keyboard
selection/nudging and do not trap ordinary text shortcuts as drawing tools.

The most valuable checks cross component boundaries:

- A shape renders and hit-tests at the same CSS position after pan, zoom, resize, and monitor-density change.
- Pointer release outside the canvas finalizes or cancels exactly one gesture.
- Move and recolor coexist; two moves from the same revision produce a clear conflict.
- A response is lost after commit; retry removes the same pending operation without duplicating it.
- A late response from drawing A cannot populate drawing B.
- Two tabs of one account receive each other's edits and maintain separate presence.
- Access is revoked while a draft exists; shared editing stops while local recovery stays available.

## 🔭 Implementation Boundary — 2 minutes

“The design keeps the pointer fast, the accepted scene consistent, and unsaved work
recoverable. Those are separate promises, so the interface should expose separate states for
them.”

The local application uses Canvas 2D, React effects, Zustand, mouse handlers, process-local
WebSocket rooms, and idle SQL saves. It has no durable pending-command queue, accepted
sequence, shared canonical reducer, live gesture preview, resize behavior, undo, or working
export.

Its socket access checks are absent, reconnect replaces the scene, property changes are not
broadcast, and pixel-density transforms are inconsistent. These are implementation limits,
not features the interview proposal claims to have delivered. The [architecture
document](./architecture.md#implementation-notes) maps them to source.

If the interviewer expands the requirements, I would choose either rich concurrent text or
unrestricted offline work. Both could justify a different data type and merge model, and
should be settled before adding more synchronization machinery.

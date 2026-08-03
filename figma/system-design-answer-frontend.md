# Figma-Style Design Tool — Frontend System Design Answer

## 45–50 minute interview walkthrough

## Opening — 2 minutes

“I’ll design the frontend for a collaborative design tool. The central problem is a large, interactive scene: users pan, zoom, select, transform, and draw objects while other users edit the same file. React should orchestrate the application, but a high-performance renderer and an operation-based collaboration layer should own the hot paths.”

| RADIO stage | Focus | Time |
|---|---|---:|
| Requirements | Personas, editing, collaboration, and scale | 4 min |
| Architecture | Shell, scene store, renderer, tools, sync | 8 min |
| Data model | Objects, transforms, operations, presence | 6 min |
| Interfaces | File APIs, collaboration, renderer/tools | 8 min |
| Optimizations | Canvas, hit testing, undo, collaboration, a11y | 18–22 min |
| Wrap-up | Alternatives and scaling limits | 3 min |

## R — Requirements — 4 minutes

### Clarifying questions

- Are we designing a diagram editor, a general vector tool, or a full design system?
- How many objects can one file contain, and how many are visible at once?
- Is collaboration simultaneous and cursor-level, or is shared editing the later phase?
- Do users need comments, version history, offline editing, and export?
- What latency target applies to local pointer movement and remote operations?
- Must the canvas be accessible itself, or are layers/properties panels the primary accessible path?

I’ll assume a vector/design editor with 100,000 possible objects, 10,000–20,000 visible in a typical viewport, multiple collaborators, cursor presence, undo/redo, layers and properties panels, and desktop-first interaction with keyboard support. Export and comments are secondary features.

### Functional requirements

1. Open a file and render pages, layers, shapes, text, and images.
2. Pan and zoom smoothly; select, move, resize, rotate, duplicate, and delete objects.
3. Provide tools for pointer, frame, shape, text, and drawing.
4. Show layers and properties panels that edit the selected object.
5. Support undo/redo and keyboard shortcuts.
6. Show collaborator cursors, selections, and remote changes.
7. Recover local edits and resynchronize after a connection interruption.

### Non-functional requirements

- Local pointer and selection feedback should stay within a frame budget.
- Large scenes should not create one DOM node per object.
- The renderer should update only dirty or visible regions where possible.
- Durable operations must not be lost or duplicated.
- Remote presence can be coalesced and expired.
- Keyboard and screen-reader workflows must have accessible paths through layers and properties.

### Out of scope

I will treat server persistence, asset storage, permission enforcement, and conflict resolution as API boundaries. I will not design the full WebGL shader pipeline or a complete CRDT algorithm.

## A — Architecture — 8 minutes

### High-level diagram

``` 
┌────────────────────────────────────────────────────────────────────────────┐
│ Editor Shell                                                               │
│ routing · tools · keyboard · panels · selection · accessibility             │
├──────────────────────┬──────────────────────┬──────────────────────────────┤
│ Scene Store           │ Renderer Adapter     │ Tool Controller              │
│ normalized objects    │ Pixi/WebGL/canvas    │ pointer → operation intent  │
│ selectors/history     │ viewport/culling     │ keyboard → command           │
├──────────────────────┴──────────────────────┴──────────────────────────────┤
│ Collaboration Sync                                                         │
│ operation queue · revisions · resync · presence channel                    │
├────────────────────────────────────────────────────────────────────────────┤
│ Typed File API ───── HTTPS / WebSocket ───── File and Collaboration API     │
└────────────────────────────────────────────────────────────────────────────┘
```

### Shell and scene store

The shell owns document route, toolbar, active tool, selection, panels, zoom controls, keyboard commands, and dialogs. The scene store owns normalized design objects, pages, layers, and operation-derived history. It exposes narrow selectors for selected objects and visible objects.

### Renderer adapter

The renderer adapter receives a render snapshot containing visible objects, viewport transform, dirty regions, theme, and selection overlays. PixiJS or another GPU-backed renderer is an implementation choice. React owns its lifecycle and accessibility-adjacent panels; the renderer owns high-frequency drawing.

### Tool controller

Tools translate pointer and keyboard events into operation intents. A move gesture produces a preview transform locally, then a commit operation on pointer-up or according to the collaboration model. The controller should not write directly to the renderer or API; it writes through the scene store and sync coordinator.

### Collaboration

Durable operations and presence are separate logical channels. Operations need IDs, ordering, revisions, acknowledgements, and replay. Presence needs expiration and can drop intermediate cursor positions. One socket can carry both, but the state machines stay separate.

## D — Data Model — 6 minutes

| Entity | Owner | Important fields | Consistency |
|---|---|---|---|
| `DesignFile` | file store | file ID, pages, permissions, revision | server-authoritative |
| `Page` | scene store | page ID, object IDs, order | operation-backed |
| `DesignObject` | normalized scene store | ID, type, parent, transform, style, content | operation-backed |
| `SelectionState` | editor store | selected IDs, active handle, tool | client-only |
| `ViewportState` | renderer controller | pan, zoom, dimensions, dirty regions | client-only |
| `Operation` | sync queue | ID, author, base revision, payload | durable and replayable |
| `PresenceState` | presence store | user, cursor, selection, color, last seen | best effort |
| `RenderSnapshot` | renderer adapter | visible objects, transforms, overlays | derived/disposable |
| `UndoEntry` | history manager | forward operation, inverse operation, context | local but server-aware |

Design objects are normalized by ID so a selection, layer panel, and renderer can reference the same object without duplicating it. Parent-child relationships define the scene tree. Transforms are stored in a consistent coordinate system; the viewport transform is separate from object transforms.

### Operations and versions

An operation describes a semantic change such as create, update, delete, reorder, or group. It carries an operation ID, author, base revision, and payload. The server acknowledges it with a canonical revision or returns a conflict/rebase response.

The client may optimistically apply an operation to the scene store. It keeps the operation until acknowledged. A remote operation is applied to the same store and generates a render invalidation. A stale operation must not silently overwrite a newer object version.

### Rendering state

Render snapshots are disposable. They may include cached geometry, text layout, image handles, and visible-object lists, but they are rebuilt when the scene or viewport changes. The authoritative scene store never depends on Pixi objects or canvas nodes.

## I — Interfaces — 8 minutes

### Server-facing API

``` 
GET  /api/files/:fileId                       → file metadata and initial scene snapshot
GET  /api/files/:fileId/operations?after=... → operations missed since revision
POST /api/files/:fileId/operations           → submit operation batch
POST /api/files/:fileId/undo                 → server-aware inverse operation
POST /api/files/:fileId/comments             → create anchored comment
WSS  /api/files/:fileId/collaboration        → operations and presence
```

The file snapshot includes revision, pages, object records, permissions, and asset references. Operation responses include accepted IDs, canonical revision, rebased changes, and conflicts. Asset URLs are capability-scoped and never embedded as unrestricted credentials.

### Client interfaces

| Interface | Inputs | Output/event | Responsibility |
|---|---|---|---|
| `SceneStore` | operations and object patches | object selectors, invalidations | canonical client document |
| `RendererAdapter` | render snapshot, viewport, theme | draw/update/dispose | GPU or canvas rendering |
| `ToolController` | pointer/keyboard events | operation intents | interaction semantics |
| `SyncClient` | operation queue, revision | ack, conflict, resync | durable collaboration |
| `PresenceOverlay` | presence events, viewport | cursor/layer overlays | non-authoritative presence |
| `PropertiesPanel` | selected object, schema | validated property patch | accessible editing path |

### Renderer lifecycle

The renderer mounts when the file route is ready, receives dimensions and theme, loads visible assets, and draws a snapshot. A scene update marks objects or regions dirty. The adapter updates or redraws affected objects and disposes resources on unmount. It must not own selection or persist mutations.

## O — Optimizations and Deep Dives — 18–22 minutes

### Deep dive 1: PixiJS/canvas versus DOM/SVG

DOM or SVG is excellent for semantic UI and a modest number of objects. It becomes expensive when thousands of shapes, text nodes, handles, and images participate in layout and style recalculation. A GPU-backed renderer provides predictable drawing cost and a scene model suited to transforms.

The cost is accessibility, text measurement complexity, debugging, and an imperative bridge. I would keep layers and properties in normal React DOM, expose accessible object summaries there, and use the canvas for visual editing. A canvas-only product is fast but excludes users and makes browser tooling weaker.

### Deep dive 2: Viewport culling and hit testing

The client should not draw every object when only a viewport subset is visible. A spatial index finds candidates by bounding box. The renderer draws visible objects plus a small overscan region. Hit testing checks topmost candidates in reverse z-order and handles transformed shapes.

For small files, a linear scan is simpler and good enough. I would add spatial indexing when profiling shows hit testing or draw preparation exceeding the frame budget, not as a premature abstraction.

### Deep dive 3: Pointer interaction and operation batching

Pointer moves can arrive faster than the server needs updates. The tool controller maintains a local preview transform and commits a semantic operation at a controlled cadence or on pointer-up. The scene feels immediate while the sync layer receives bounded operations.

The alternative is sending every pointer coordinate as a durable operation. That creates network volume, collaboration noise, and undo history that is impossible to use. Presence may stream cursor movement; document operations should represent meaningful changes.

### Deep dive 4: Collaboration and conflicts

The client applies local operations optimistically and sends them with a base revision. Remote operations arrive through the socket and are applied to the normalized store. If a conflict affects a different property, the client can merge. If two users transform the same object, the server’s conflict policy or a CRDT/OT layer decides the result and the UI shows the changed object.

I would start with operation IDs, version checks, and visible conflict feedback. A full CRDT provides stronger offline and concurrent editing semantics but increases data structure, testing, and debugging complexity. The right choice depends on whether offline and character-level collaboration are core requirements.

### Deep dive 5: Undo/redo

Undo creates an inverse operation and sends it through the same permission and revision path. Directly mutating local state makes undo feel easy but breaks collaboration when another user has changed the object. The history manager should group a drag gesture into one user-facing entry even if the renderer sampled many intermediate positions.

### Deep dive 6: Worker boundaries

Geometry calculations, hit testing, image decoding, and export preparation are candidates for workers. Workers reduce main-thread pressure but require serialization and careful cancellation. The scene store remains the authority; a worker result is accepted only if it matches the scene revision that requested it.

### Accessibility and keyboard path

The layers panel provides a semantic list of objects with names, visibility, lock, and selection controls. The properties panel exposes labeled fields and announces changes. Keyboard shortcuts support select, move, duplicate, delete, group, zoom, and tool switching. Canvas pointer affordances always have a panel or command equivalent.

### Failure matrix

| Failure | UI behavior | Recovery |
|---|---|---|
| Render adapter fails | canvas fallback with layer access | retry adapter or continue in inspect mode |
| Asset load fails | placeholder with alt/status | retry or replace asset |
| Operation timeout | pending sync indicator | retry same operation ID |
| Revision conflict | affected object marked | rebase or review |
| Socket disconnects | offline/sync banner | reconnect and request missed ops |
| Worker fails | bounded main-thread fallback | restart worker and recompute |

## Performance and scaling

The first bottleneck is draw preparation and hit testing for large scenes. The second is text and image rendering. The third is collaboration operation volume and history memory. Viewport culling, spatial indexes, cached text/image resources, workers, and bounded history address each independently.

I would measure pointer-to-pixel latency, frame drops while transforming, visible-object count, hit-test duration, asset decode time, operation acknowledgement latency, resync duration, and memory over an eight-hour editing session.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Visual renderer | Pixi/WebGL adapter | DOM/SVG for all objects | scale and transform performance |
| Semantic UI | React DOM panels | canvas-only controls | accessibility and maintainability |
| Scene state | normalized objects | nested component tree | shared selection/layers/render access |
| Collaboration | operation IDs and revisions | full CRDT immediately | incremental correctness with less complexity |
| Pointer updates | local preview plus semantic commit | durable event per pointer move | bounded sync and useful undo |
| Hit testing | linear first, spatial index at scale | index everything upfront | profile-driven complexity |
| Undo | inverse operation | direct local mutation | collaboration and permissions remain valid |
| Workers | targeted geometry/export work | move whole app off thread | serialize only expensive computations |
| Presence | lossy separate channel | durable document stream | cursors are replaceable |

## Closing — 3 minutes

“The design separates the scene model, renderer, tools, and collaboration protocol. The renderer can evolve from Pixi to another adapter without changing object ownership. Operations preserve correctness and undo semantics, while presence is deliberately lightweight. React handles controls and accessibility; the canvas handles the high-frequency visual path.”

If time remains, I would discuss comments, multiplayer selections, asset caching, export, plugin tools, and how to test transform operations across reconnects.

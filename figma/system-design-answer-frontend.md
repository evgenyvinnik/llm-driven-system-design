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
│                         React SPA (Vite + TypeScript)                       │
│ Routes: /files list · /design/$fileId canvas · /design/$id/prototype       │
│         /design/$id/share permissions and collaborators                    │
│                                                                            │
│ ┌──────────────┐ ┌────────────────┐ ┌────────────────┐ ┌───────────────┐ │
│ │ authStore    │ │ fileStore      │ │ sceneStore     │ │ toolStore     │ │
│ │ session and  │ │ files, pages,  │ │ objects,       │ │ active tool,  │ │
│ │ permissions  │ │ metadata       │ │ selectors      │ │ selection     │ │
│ └──────────────┘ └───────▲────────┘ └──────▲─────────┘ └──────▲────────┘ │
│                          │ fetch            │ render             │ intent   │
│ ┌────────────────────────┴──────────────────┐ ┌───────────────┴─────────┐ │
│ │ Canvas renderer adapter                    │ │ Collaboration sync      │ │
│ │ Pixi/WebGL · culling · hit testing         │ │ operations · revisions  │ │
│ └────────────────────────────────────────────┘ │ presence · resync       │ │
│                                                └─────────────────────────┘ │
│ Typed API client: files · assets · operations · presence                    │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ HTTPS / WebSocket
                       ┌─────────────▼─────────────┐
                       │ File and collaboration API│
                       │ documents · assets · ops  │
                       └───────────────────────────┘
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

### Route lifecycle and document loading

The file route loads document metadata, page names, permissions, and the first scene snapshot separately. The shell can show the file name and page tabs before the canvas is ready. Prototype or inspect routes can request a read-only scene representation without loading editor-only tools.

The URL identifies the file, page, and mode. Selection, zoom, pan, active tool, and open panels remain session state. This makes links stable while preserving the fast local feel of editing.

### Scene snapshots and dirty regions

The scene store normalizes objects by ID and tracks parent order independently from object properties. A renderer snapshot contains only the visible subtree, resolved transforms, dirty regions, and selection overlays. Updating one rectangle should not serialize or clone the full file.

Dirty regions are useful when a small property changes, but they are not a substitute for culling. A large move can invalidate many regions, and a zoom change can invalidate the entire viewport. The adapter chooses a full redraw when that is cheaper than complex invalidation bookkeeping.

### Asset and font loading

Asset metadata is part of the document model, but decoded images and fonts are runtime resources. The renderer reserves dimensions before assets arrive and shows a labeled placeholder on failure. Font loading affects text measurement, so the scene can render a fallback measurement and schedule a bounded re-layout after the intended font is ready.

The client should not block the entire document on one remote asset. A missing asset is a local layer error. Export and publish flows can apply stricter completeness checks than interactive editing.

### Testing and observability

I would test transforms, nested groups, z-order hit testing, pointer capture, undo after remote operations, worker revision guards, and renderer recovery. Performance tests should include many small objects, a few huge objects, nested groups, text, and image-heavy scenes.

Telemetry records pointer-to-pixel latency, visible object count, hit-test duration, asset failure rate, operation acknowledgement latency, reconnects, and renderer errors. It should identify file and object types through controlled diagnostic IDs without sending document text or private asset URLs.

### Capacity assumptions and extension decisions

I would benchmark a file with thousands of objects, nested groups, large images, text layers, and several active collaborators. The browser should render only the visible scene and keep decoded resources bounded. The logical file can be much larger than the active render snapshot.

If a file contains many pages, page metadata loads first and inactive pages remain outside the scene store. Prototype playback can use a read-only render runtime that does not load editor tools. Export can run in a worker or server service because it has different latency and memory constraints from interactive editing.

The canvas renderer, tools, panels, and collaboration layer are separate feature boundaries, but they share selection, focus, theme, and revision context. I would keep first-party features in one shell with a renderer adapter. Module Federation can support independently owned tool families after the contract stabilizes; an iframe is reserved for untrusted plugins or separate security domains.

### Plugin capability model

A tool receives pointer events scoped to the canvas, selected object snapshots, viewport commands, and operation intents. It does not receive arbitrary credentials or direct access to the collaboration socket. A renderer receives a render snapshot and emits hit-test or accessibility results through a narrow adapter.

This contract lets the shell apply permissions and error boundaries consistently. If a plugin fails, the user can continue through layers and properties. Hard iframe isolation is stronger but makes pointer capture, keyboard focus, resize, and shared undo substantially more complex.

### Compatibility and migration

Scene objects and operations carry schema versions. A client migrates an older object into its in-memory representation and writes the canonical form only through an explicit save or server migration. Published prototypes pin a renderer-compatible version so a tool deployment cannot silently change an existing presentation.

### Failure matrix

| Failure | UI behavior | Recovery |
|---|---|---|
| Render adapter fails | canvas fallback with layer access | retry adapter or continue in inspect mode |
| Asset load fails | placeholder with alt/status | retry or replace asset |
| Operation timeout | pending sync indicator | retry same operation ID |
| Revision conflict | affected object marked | rebase or review |
| Socket disconnects | offline/sync banner | reconnect and request missed ops |
| Worker fails | bounded main-thread fallback | restart worker and recompute |

### Alternative architecture review

The simplest design uses DOM or SVG for every object. It offers accessibility and easy inspection, but layout and style work scale poorly for large scenes with transforms, images, and text.

A canvas or GPU renderer controls draw cost better, but it creates an imperative bridge and a separate accessibility path. I would keep panels and layer navigation in React and expose semantic object summaries alongside the visual canvas.

An iframe per tool or canvas would provide hard crash isolation, but it would make pointer capture, keyboard focus, shared undo, resize, and collaboration coordination expensive. A renderer adapter and worker boundaries provide most of the value for trusted first-party code. Module Federation is useful later for independently owned tool families.

### API semantics worth making explicit

- Scene snapshots identify file, page, and revision.
- Operations carry stable IDs, author, base revision, and semantic payload.
- Presence is ephemeral and can be dropped without changing the file.
- Asset descriptors are separate from decoded browser resources.
- Renderer snapshots contain visible objects and viewport state only.
- Undo sends an inverse operation through the normal permission path.
- Conflicts identify the affected object or property.
- Published prototypes pin a compatible renderer version.

### Presentation checkpoints

I begin with the user journey: open a file, select an object, transform it, collaborate, undo, and inspect it through the layers panel.

I trace that journey through route state, normalized scene selectors, tool intents, render snapshots, operation sync, and presence.

I pause on the split between durable operations and lossy presence because it demonstrates that not all realtime data has the same consistency requirement.

I close by explaining how the shell preserves accessibility and permissions even when the visual renderer changes.

### Implementation sequence

1. Build file routes, page navigation, layers, and property panels in React.
2. Add a normalized scene store with selection and operation history.
3. Add a renderer adapter for visible objects and viewport transforms.
4. Add tool intents, pointer capture, local previews, and semantic commits.
5. Add operation acknowledgements, resync, and separate presence updates.
6. Add culling, spatial hit testing, workers, and asset budgets after profiling.
7. Add independently deployed tool families only after the capability contract is stable.

### Design review questions

The first question is whether the visual renderer is the source of truth. It should not be; the scene store and operation protocol must remain testable without a canvas.

The second is whether a tool can mutate a document without passing through permissions and history. If it can, undo and collaboration will diverge.

The third is whether a missing asset or renderer prevents access to layers and properties. If it does, the failure boundary is too broad.

The fourth is whether presence traffic can be dropped independently of document operations. If it cannot, the realtime model is over-coupled.

### What I would validate first

I would benchmark a scene with nested transforms, large images, text, and multiple collaborators while measuring pointer-to-pixel latency. I would inject renderer, worker, asset, and socket failures independently.

The success criteria are usable layers and properties when the canvas fails, deterministic undo through the operation path, and collaboration that remains correct even when presence updates are dropped.

I would ask whether pixel-level fidelity, offline editing, and simultaneous character editing are launch requirements. Those answers determine whether the renderer is canvas-first, whether operations must queue offline, and whether a CRDT is justified.

I would also ask whether plugins can be untrusted. First-party tools can use module boundaries; untrusted tools require capability restriction and likely a separate runtime.

The final handoff is a route-oriented shell, normalized scene state, a renderer adapter, semantic tool intents, durable collaboration operations, and a separate presence channel. It protects both interaction performance and document correctness without forcing hard isolation everywhere.

The strongest trade-off is keeping visual rendering imperative while preserving semantic controls in React. That duplicates some state, but it avoids making canvas performance and accessibility mutually exclusive.

The other key trade-off is separating durable operations from presence. Presence can be lossy and fast; document edits need ordering, replay, and permission checks.

### Final interviewer prompts

- What is rendered versus semantic?
- Where does hit testing live?
- How is a drag committed?
- What does undo send?
- What survives a socket gap?
- How is an asset failure isolated?

The answers should consistently point back to scene state, renderer snapshots, semantic tool intents, and operation acknowledgements.

The architecture is complete when these answers are visible in the interfaces, not only stated in the interview narrative.

That is the standard I would use for the presentation.

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

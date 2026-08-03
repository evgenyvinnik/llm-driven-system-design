# Retool-Style Internal Tool Builder — Frontend System Design

## 45–50 minute interview walkthrough

## Opening — 2 minutes

“I’ll design a visual builder for internal applications. Users drag widgets onto a canvas, configure them in an inspector, bind them to query results, and preview the published app. The defining challenge is keeping editor state, bindings, query execution, and rendered widgets coherent while a user makes rapid layout changes.”

| RADIO stage | Focus | Time |
|---|---|---:|
| Requirements | Builder workflow, personas, correctness, and scale | 4 min |
| Architecture | Shell, canvas, registry, inspector, query layer | 8 min |
| Data model | App schema, widget config, bindings, results, drafts | 6 min |
| Interfaces | API contracts and widget/component contracts | 8 min |
| Optimizations | Dragging, rendering, query scheduling, resilience | 18–22 min |
| Wrap-up | Alternatives and scaling limits | 3 min |

## R — Requirements — 4 minutes

### Clarifying questions

- Is the builder for developers, operations users, or both?
- Are SQL queries allowed, and how are credentials and permissions represented?
- Is the app runtime expected to work offline or only while connected to business systems?
- Can multiple users edit one app concurrently?
- How many widgets, queries, and rows should one app support?
- Does published runtime need a different performance and security boundary from the editor?

I’ll assume technical internal users, SQL-backed queries through a server gateway, one editor at a time for the first version, up to 100 widgets and dozens of queries per app, and a separate preview/published mode. Arbitrary JavaScript execution and customer-supplied widget code are out of scope for the base product.

### Functional requirements

1. Create or open an app with a three-pane editor: palette, canvas, inspector.
2. Drag, resize, reorder, duplicate, and delete widgets on a grid.
3. Configure widget properties with typed controls.
4. Bind widget properties to static values, query results, or other widget state.
5. Define queries, run them, inspect results, and bind columns into widgets.
6. Preview the app with resolved bindings and loading/error states.
7. Save drafts, publish a version, and recover unsaved work after recoverable errors.

### Non-functional requirements

- Dragging remains responsive at 60fps for 100 widgets.
- Local edits appear immediately and autosave within a bounded debounce window.
- Query execution cannot freeze canvas interaction.
- A broken widget or query shows a local error state rather than a blank app.
- Published apps cannot execute undeclared queries or arbitrary client code.
- Keyboard users can navigate palette, canvas, inspector, and query results.

## A — Architecture — 8 minutes

### High-level diagram

``` 
┌────────────────────────────────────────────────────────────────────────────┐
│ Builder Shell                                                               │
│ routing · mode · keyboard · dirty state · permissions · publish controls    │
├───────────────┬──────────────────────────┬─────────────────────────────────┤
│ Widget Palette│ Canvas / Layout Engine   │ Property Inspector               │
│ registry      │ selection · drag · resize │ schema-driven controls          │
├───────────────┴──────────────────────────┴─────────────────────────────────┤
│ Binding and Query Layer                                                     │
│ expression parser · query coordinator · result cache · cancellation        │
├────────────────────────────────────────────────────────────────────────────┤
│ Normalized App Store                                                        │
│ app metadata · widget configs · queries · drafts · published version        │
├────────────────────────────────────────────────────────────────────────────┤
│ Typed API client ─────── HTTPS ─────── App/Query/Publish API               │
└────────────────────────────────────────────────────────────────────────────┘
```

### Shell responsibilities

The shell owns route state, editor versus preview mode, selected widget, dirty state, keyboard commands, permission context, and publish controls. It provides the runtime context that widgets consume but does not know how an individual table or chart renders.

### Registry and rendering

A widget registry maps a stable type and version to metadata, renderer, editor schema, default configuration, supported bindings, and minimum size. The canvas resolves widgets through the registry. This is preferable to a growing switch once teams add widget families, but I would keep the first local registry in one bundle and introduce remote widgets only after the contract stabilizes.

Preview and edit mode use the same renderer with different context. Edit mode supplies selection outlines, placeholder data, and configuration affordances. Preview mode supplies resolved values and hides editing chrome.

### State and data flow

The normalized store owns app structure and editor state. The query coordinator owns server state and execution status. A widget subscribes to its own config and the specific binding result it needs. It should not subscribe to the entire app document, because changing one widget would otherwise rerender the canvas.

## D — Data Model — 6 minutes

| Entity | Owner | Important fields | Lifecycle |
|---|---|---|---|
| `AppDefinition` | app store | app ID, name, widgets, queries, version | persisted server state |
| `WidgetConfig` | widget registry/store | ID, type, version, position, props, bindings | persisted server state |
| `QueryDefinition` | query layer | ID, SQL/template, parameters, trigger policy | persisted server state |
| `BindingExpression` | binding editor | source, path, transform, validation | draft then persisted |
| `QueryResult` | query coordinator | columns, rows, status, fetched time, error | cached server state |
| `EditorSession` | shell | selected ID, mode, dirty fields, active pane | ephemeral client state |
| `PublishVersion` | publish flow | version, validation result, created time | immutable server state |

The app definition is persisted as a versioned document. Widget position and configuration are separate enough that layout changes can be debounced without rewriting query results. Query results are never serialized into the app definition; they are runtime data with a freshness policy.

### Binding model

Bindings should be parsed into a constrained expression representation rather than evaluated as arbitrary JavaScript. A binding can refer to a query result, a widget’s public state, a user variable, or a safe transformation such as formatting. The parser returns an AST and validation diagnostics.

The security boundary is important. A text field may bind to a result path. It must not be able to call arbitrary browser APIs, read another app, or exfiltrate credentials. The server independently validates query permissions and published app capabilities.

### Draft and conflict state

The editor keeps a local draft over the last server version. Each autosave includes the base version. A conflict preserves local edits and offers a diff or reload choice. Silent last-write-wins is acceptable for a prototype but dangerous when two people edit the same operational app.

## I — Interfaces — 8 minutes

### Server-facing API

``` 
GET  /api/apps/:appId                         → app definition and version
PUT  /api/apps/:appId                         → save draft against base version
POST /api/apps/:appId/queries/execute        → execute an authorized query
GET  /api/apps/:appId/queries/:queryId        → query metadata and latest result
POST /api/apps/:appId/validate               → validate bindings and permissions
POST /api/apps/:appId/publish                → create immutable published version
GET  /api/apps/:appId/versions/:version      → published runtime definition
```

The save response returns canonical configuration, new version, and validation warnings. Query execution returns columns, rows, elapsed time, result version, and typed errors. A query request accepts cancellation and a request ID so a stale response cannot overwrite a newer run.

### Client interfaces

| Interface | Inputs | Output/event | Responsibility |
|---|---|---|---|
| `WidgetRegistry` | type, version | renderer, editor, schema | extension and compatibility boundary |
| `Canvas` | widget configs, pointer/keyboard events | layout patch, selection | immediate local interaction |
| `Inspector` | selected config and schema | validated property patch | schema-driven editing |
| `BindingEditor` | expression and available context | AST, diagnostics, binding patch | safe expression authoring |
| `QueryCoordinator` | query definition, trigger, signal | result, loading, error | dedupe, cancel, cache, retry |
| `PreviewRuntime` | published definition, context | rendered app and statuses | runtime isolation from editor state |

The canvas and inspector communicate through store actions rather than direct references. The widget renderer receives resolved props, dimensions, theme, loading status, and a limited action API. It cannot import the raw database client.

### Query lifecycle

1. A widget declares a binding dependency.
2. The coordinator canonicalizes the query and parameter set.
3. Equivalent active queries are deduplicated.
4. The coordinator cancels obsolete runs when parameters change.
5. Results are validated against expected columns and stored by query key.
6. Widgets receive loading, stale, empty, success, or error state.

## O — Optimizations and Deep Dives — 18–22 minutes

### Deep dive 1: Drag-and-drop without canvas jank

During a drag, the pointer position changes far more often than the persisted layout needs to change. The canvas keeps a local transform or preview position and renders a lightweight drag overlay. It commits a normalized grid position on drop, then debounces persistence.

The alternative is to write the full app document to the server on every pointer move. That creates network pressure and makes a slow request visible as drag lag. The chosen design separates interaction state, layout commit, and server persistence.

For 100 widgets, each widget subscribes to its own config. The canvas does not rerender every widget when one item moves. Collision detection uses a spatial index or bounded grid calculation rather than comparing every widget against every other widget on every pointer event.

### Deep dive 2: Bindings and query results

Bindings are a dependency graph. A widget depends on a query result, a query may depend on user variables, and a widget may expose controlled state to another widget. The coordinator should schedule dependencies in an explicit graph so it can avoid cycles and explain them to users.

I would allow declarative transformations such as formatting, filtering a bounded result, or selecting a field. I would not allow arbitrary JavaScript in the base runtime because it makes security review, caching, serialization, and preview consistency much harder.

The editor should show a binding preview with sample data and diagnostics. A missing path is a validation error. A temporarily failed query is a runtime error. These must be different states so a user knows whether to fix configuration or retry a dependency.

### Deep dive 3: Query result isolation

Query results can be large and sensitive. Results are scoped to an app, user capability, query version, and parameter set. The client cache should evict old results and avoid persisting sensitive rows to local storage.

Query execution uses a concurrency budget. A user can edit multiple queries, but the browser should not start an unbounded number of database requests. Visible widgets receive priority; preview-only or hidden widgets are deferred. Historical results may be reused longer than live query results, but freshness must be visible.

### Deep dive 4: Widget registry versus one bundle

A local registry in one bundle is the simplest starting point. It gives shared React dependencies, easy debugging, and low runtime risk. A remote registry or Module Federation becomes useful when widget teams need independent deployment, but it adds manifest compatibility, dependency duplication, rollback, and trust concerns.

I would extract widget families, not individual widgets, and require a stable renderer/editor/query contract. Third-party widgets would use a stronger sandbox boundary and capability API rather than receiving the full app store.

### Deep dive 5: Published runtime versus editor

The published app should load an immutable version and a smaller runtime. It should not contain drag controls, unsaved drafts, or editor-only query capabilities. This separation improves startup time and reduces the blast radius of a malformed draft.

The editor can show a preview using the published runtime with draft data overlaid. The trade-off is two runtime modes and a more explicit version model. The benefit is that publishing becomes testable and an app can remain stable while a new draft is being edited.

### Accessibility and resilience

The canvas needs keyboard equivalents for selecting, moving, resizing, duplicating, and deleting widgets. The inspector uses labeled controls and announces validation errors. Dragging should have an alternate command path for users who cannot use a pointer.

A widget error boundary isolates a broken renderer. A query error appears inside dependent widgets while unrelated widgets remain usable. If the app definition fails to load, the shell offers retry and preserves a local draft where safe.

### Failure matrix

| Failure | UI state | Recovery |
|---|---|---|
| Widget renderer throws | local widget fallback | retry or disable widget |
| Query times out | stale/error result | retry, cancel, or inspect query |
| Binding invalid | editor diagnostic | fix expression before publish |
| Autosave conflict | draft retained | diff, rebase, or reload |
| Publish validation fails | blocked publish report | fix listed capabilities/bindings |
| Browser refresh with draft | recovery prompt | restore or discard local draft |

## Performance and scaling

The first browser bottleneck is drag interaction across many widgets. The second is query result rendering, especially wide tables. The third is app-definition parsing and selector cost as documents grow.

I would virtualize large result tables, keep query results outside the widget configuration store, memoize widget selectors, and use workers for expensive binding transforms or formula-like calculations. Route-level splitting keeps the SQL editor and heavy table renderer out of the initial published runtime.

Metrics should include time to interactive editor, drag frame drops, autosave conflict rate, query cancellation rate, result-render duration, widget error rate, and published runtime startup.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| App state | normalized store plus query layer | one serialized document in React state | isolates widget updates and server data |
| Widget extension | versioned registry | permanent shell switch | supports growth without hiding contracts |
| Binding language | constrained declarative AST | arbitrary JavaScript | safer, serializable, explainable |
| Drag persistence | local preview plus debounced commit | write every pointer move | protects frame rate and API |
| Query transport | typed coordinator | widget-owned fetches | dedupe, cancel, prioritize, and observe |
| Conflict handling | version check with draft retention | last-write-wins | avoids silently deleting another editor’s work |
| Published runtime | immutable version | render current draft directly | predictable deployment and rollback |
| Untrusted extensions | sandbox/capability boundary | full app access | limits data and DOM blast radius |

## Closing — 3 minutes

“The builder is a document editor with a runtime, not just a grid of components. The normalized model separates widget configuration, query results, bindings, and drafts. The interfaces make query execution and widget capabilities explicit. The optimizations protect the two hot paths—dragging and rendering results—while versioning and publish isolation protect correctness.”

If time remains, I would discuss multi-user editing, schema-aware SQL autocomplete, custom widget review, and whether a worker-based runtime is justified for large published apps.

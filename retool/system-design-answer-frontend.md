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
│                         React SPA (Vite + TypeScript)                       │
│ Routes: /apps list · /apps/$appId builder · /apps/$id/preview              │
│         /queries library and permissions                                  │
│                                                                            │
│ ┌──────────────┐ ┌────────────────┐ ┌────────────────┐ ┌───────────────┐ │
│ │ authStore    │ │ appStore       │ │ editorStore    │ │ queryStore    │ │
│ │ identity and │ │ widgets,       │ │ selection,     │ │ definitions,  │ │
│ │ capabilities │ │ layout, version│ │ mode, dirty    │ │ results, run  │ │
│ └──────────────┘ └───────▲────────┘ └──────▲─────────┘ └──────▲────────┘ │
│                          │ load/save       │ edit                │ execute │
│ ┌────────────────────────┴──────────────────┐ ┌───────────────┴─────────┐ │
│ │ Builder shell and widget registry          │ │ Binding/query layer     │ │
│ │ palette · canvas · inspector · renderers   │ │ parser · cache · abort  │ │
│ └────────────────────────────────────────────┘ └─────────────────────────┘ │
│ Typed API client: versions · queries · permissions · publish              │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ HTTPS
                            ┌────────▼─────────┐
                            │ Retool API       │
                            │ apps · queries ·  │
                            │ permissions      │
                            └──────────────────┘
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

### Route lifecycle and editor state

The app route loads metadata and the latest editable version before requesting expensive query results. The shell can display the palette and inspector skeleton while the canvas resolves. Preview mode loads an immutable published version and does not reuse an unsaved editor query result unless the user explicitly asks for draft preview.

The URL identifies the app, mode, and optionally selected widget. Selection is not part of the persisted app definition. This keeps browser history useful without creating a server revision for every inspector click.

### Autosave and publish flow

Layout changes can be debounced and saved as a draft revision. Configuration changes should be validated locally before autosave, but a server response still determines whether the revision is accepted. The editor shows saving, saved, conflict, and offline states independently from query execution state.

Publish is a separate command. The client asks the server to validate the complete version, including widget types, bindings, permissions, and query references. On success it receives an immutable version ID. The runtime requests that version by ID, so a later draft cannot silently alter a published app.

### Widget capability boundary

The widget contract exposes resolved data, theme tokens, dimensions, and a small event API. It does not expose the auth token, raw API client, full app store, or arbitrary DOM outside its mount point. The shell can log widget usage and enforce permissions without knowing the implementation.

For a first-party widget, this is a module boundary. For a remote or third-party widget, the same logical contract can be implemented through Module Federation or an iframe. The capability list must remain narrower than the host application regardless of loading mechanism.

### Testing and observability

Registry tests verify that every widget type has compatible renderer metadata, editor schema, default props, and accessibility labels. Query coordinator tests cover deduplication, cancellation races, result validation, and dependency cycles. End-to-end tests publish an app, open it as a viewer, and verify that editor-only controls are absent.

Telemetry records canvas commit time, autosave failures, query latency, widget error rate, and publish validation failures. It should identify widget type and version, not include customer query rows or secrets. A widget error should be attributable without exposing its data payload.

### Capacity assumptions and extension decisions

I would design the first editor for hundreds of widgets per app, not unlimited widgets. The canvas can virtualize or defer widgets outside the viewport, while the app store keeps configuration normalized. Query execution receives a concurrency budget so one dashboard cannot create an unbounded fan-out.

As the builder grows, the expensive part is usually not React itself but editor metadata, wide query results, and repeated layout measurement. The shell should load the palette and inspectors by route, while the published runtime loads only the widget families used by the immutable version.

There are three possible extension boundaries. A local registry is best while the contract is changing. Module Federation is useful for independently deployed first-party widget families. An iframe is reserved for code that is untrusted or belongs to a separate security domain. The iframe boundary is stronger, but it imposes postMessage protocols, resize negotiation, duplicated dependencies, and separate accessibility testing.

The widget API should therefore be capability-oriented even when all widgets are local. A widget receives resolved props, theme tokens, dimensions, and named actions. It does not receive arbitrary network credentials or the whole store. This makes a later move to remote loading evolutionary rather than a security rewrite.

### Versioning and migration

Widget configuration includes a type version. When a renderer changes its schema, the registry can migrate a draft explicitly and record the migration result. Published versions remain readable with their original renderer or a compatibility adapter.

The alternative is to silently reinterpret old props. That makes rollback unpredictable and can change a production dashboard when a widget deploys. Explicit migration costs more metadata but gives authors a reviewable change and operators a safe rollback point.

### Alternative architecture review

The simplest builder is one React tree with a switch over widget types and widget-owned queries. It is fast to start, but the switch becomes a release bottleneck and a slow widget can take down the editor.

A plugin registry with shared contracts gives each widget family a clear owner. Local modules are best while the contract changes. Module Federation supports independent deployment after versioning, fallback, and dependency policy are mature. An iframe is stronger isolation, but it creates a separate runtime, resize protocol, focus boundary, and data bridge.

The published runtime is another important boundary. Reusing the editor bundle would reduce conceptual duplication but ships drag controls, draft state, and query-authoring code to viewers. A smaller immutable runtime costs a second mode, but it gives predictable startup and rollback.

### API semantics worth making explicit

- App versions are immutable once published.
- Draft saves include a base revision and return a canonical revision.
- Query execution receives an app version, parameter set, and capability scope.
- Query results identify the query key, parameter hash, and freshness state.
- Publish validates widgets, bindings, permissions, and referenced queries together.
- A conflict preserves the local draft rather than replacing it silently.
- Widget errors are scoped to the widget instance.
- Secrets never cross the widget renderer contract.

### Presentation checkpoints

I begin with one user journey: drag a widget, bind it to a query, preview it, and publish it.

I then trace the journey through route state, normalized app state, registry resolution, query coordination, and immutable publish output.

I pause on the difference between editor state and runtime state because it explains both performance and safety.

I close by showing how a local registry can evolve into independently deployed widget families without forcing every widget into an iframe.

### Implementation sequence

1. Build app routes, auth context, and a single persisted app version.
2. Add normalized widget layout, selection, inspector, and keyboard commands.
3. Add the local widget registry and per-widget error boundaries.
4. Add typed query definitions, binding validation, cancellation, and result caching.
5. Add autosave revisions, conflict recovery, and publish validation.
6. Add the smaller published runtime and viewer permissions.
7. Add remote widget loading only after the contract and fallback behavior are tested.

### Design review questions

The first review question is whether a widget can render without importing the host’s API client. If not, the capability boundary is too weak.

The second is whether a query result can be invalidated without rewriting the app definition. If not, durable configuration and runtime data are coupled.

The third is whether a published app can be reproduced from an immutable version ID. If not, rollback and incident debugging will be unreliable.

The fourth is whether a failed widget, query, or inspector can leave unrelated widgets usable. If not, the failure boundary is too broad.

### What I would validate first

I would build one chart, one table, and one form widget through the full path: configure, bind, autosave, preview, publish, and open as a viewer. That validates the registry and version contracts before adding more widget types.

I would then inject a query timeout, an invalid binding, a renderer exception, and an autosave conflict. The success criteria are local recovery, preserved drafts, and a published version that remains immutable while editing continues.

I would ask whether queries execute in the browser or through a server broker, whether customer-authored code is allowed, and whether third-party widgets are in scope. Browser-side credentials and untrusted extension code would move the design toward a hard sandbox.

I would also ask whether published apps need independent deployment from the builder. If yes, the immutable runtime and registry contracts become first-class platform surfaces rather than later optimizations.

The final handoff is a route-oriented shell, normalized app state, a versioned widget registry, a coordinated query layer, and an immutable published runtime. That combination keeps the first implementation understandable while preserving a credible path to independently owned widget families.

The strongest trade-off is choosing a capability contract before choosing a loading mechanism. Local modules, Module Federation, or an iframe can implement the contract later; the shell should not leak credentials or full-store access to any of them.

The other key trade-off is separating editor drafts from published runtime data. It costs explicit versioning, but it makes preview, rollback, and failure recovery explainable.

### Final interviewer prompts

- Who owns widget versions?
- What can a widget access?
- How is a query cancelled?
- What does publish validate?
- Can a viewer load editor code?
- What happens after a widget throws?

The architecture is complete when these answers are visible in the interfaces, not only stated in the interview narrative.

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

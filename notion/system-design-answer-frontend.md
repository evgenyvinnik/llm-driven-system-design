# Notion-Style Workspace — Frontend System Design Answer

## 45–50 minute interview walkthrough

## Opening — 2 minutes

“I’ll design the frontend for a document workspace with nested pages, block editing, database views, search, and collaboration. The key design choice is to separate the persisted block graph from the rendered tree, local editing state, and presence. That lets the editor stay responsive while pages grow and other users make changes.”

| RADIO stage | Focus | Time |
|---|---|---:|
| Requirements | Workspace workflows, editing, collaboration, and scale | 4 min |
| Architecture | Shell, block store, renderers, sync, search | 8 min |
| Data model | Pages, blocks, trees, drafts, views, presence | 6 min |
| Interfaces | Page APIs, block mutations, search, component APIs | 8 min |
| Optimizations | Block editing, virtualization, views, sync, a11y | 18–22 min |
| Wrap-up | Trade-offs and scaling limits | 3 min |

## R — Requirements — 4 minutes

### Clarifying questions

- Is the product primarily personal notes, team documentation, or a project workspace?
- How deeply nested can pages become and how many blocks can a large page contain?
- Do blocks include databases, embeds, files, and rich text, or only text?
- Is simultaneous editing required, and does offline editing matter?
- How should search work across pages, blocks, and database properties?
- Which actions must be keyboard accessible?

I’ll assume team workspaces, nested pages, block types for text, headings, lists, tasks, images, and database views, simultaneous presence, search, and desktop-first editing with responsive reading. Offline editing is a follow-up with a clear migration path.

### Functional requirements

1. Navigate workspaces, favorites, recent pages, and a nested page tree.
2. Open a page and render blocks in order.
3. Create, edit, reorder, duplicate, and delete blocks.
4. Support slash commands and rich text editing within a block.
5. Render table, board, list, and calendar-style database views.
6. Search pages and blocks with keyboard-friendly navigation.
7. Show collaborator presence and recover edits after reconnect.

### Non-functional requirements

- Typing and block insertion should feel local and not wait on the server.
- Large pages should render only visible or priority blocks where possible.
- A single malformed block should not blank the whole page.
- Page tree navigation should remain responsive with thousands of pages.
- Durable edits must be ordered, retryable, and visibly conflicted.
- The app should support keyboard navigation and readable status announcements.

### Out of scope

I will not design the search index, database query engine, or complete CRDT algorithm. I will define their frontend data contracts and the client state needed to integrate them.

## A — Architecture — 8 minutes

### High-level diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         React SPA (Vite + TypeScript)                       │
│ Routes: /workspace · /pages/$pageId editor · /pages/$id/share              │
│         /search query results · /databases/$id views                       │
│                                                                            │
│ ┌──────────────┐ ┌────────────────┐ ┌────────────────┐ ┌───────────────┐ │
│ │ authStore    │ │ pageTreeStore  │ │ blockStore     │ │ viewStore     │ │
│ │ session and  │ │ favorites,     │ │ blocks, order, │ │ filters, rows,│ │
│ │ capabilities │ │ nesting        │ │ selection      │ │ pagination    │ │
│ └──────────────┘ └───────▲────────┘ └──────▲─────────┘ └──────▲────────┘ │
│                          │ fetch            │ edit              │ query    │
│ ┌────────────────────────┴──────────────────┐ ┌───────────────┴─────────┐ │
│ │ Block registry and renderers               │ │ Sync and search layers  │ │
│ │ editor · read-only · error boundaries      │ │ mutations · retry ·     │ │
│ └────────────────────────────────────────────┘ │ cursor · highlights     │ │
│                                                └─────────────────────────┘ │
│ Typed API client: pages · blocks · search · presence                       │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ HTTPS / WebSocket
                          ┌──────────▼──────────┐
                          │ Workspace API       │
                          │ pages · blocks ·     │
                          │ search · presence   │
                          └─────────────────────┘
```

### Shell

The shell owns route state, workspace context, sidebar, global command palette, keyboard shortcuts, dialogs, theme, and session capabilities. It provides page context to features but does not own every block’s local editing state.

### Block registry and renderer

A block registry maps type and version to a renderer, editor, schema, default content, and accessibility metadata. A paragraph, database view, image, and embed can evolve independently while the page store remains normalized.

Each block is rendered inside a local error boundary. A missing or broken block gets a fallback with its type and ID, while sibling blocks remain usable. Published or shared pages can fall back to a read-only representation if an editor plugin is unavailable.

### Page tree and view runtime

The page tree is a separate route-aware feature. It loads names and hierarchy first, then details on expansion. Database views consume a block’s schema and rows through a view data layer. Table, board, and list renderers share query state but own layout-specific presentation.

### Sync and search

The sync coordinator owns mutations, version checks, retries, and resync. Search results are independent server state; they should not be merged into the block store because search snippets and page blocks have different lifetimes and pagination.

## D — Data Model — 6 minutes

| Entity | Owner | Important fields | Lifecycle |
|---|---|---|---|
| `Workspace` | shell/store | ID, name, members, capabilities | server state |
| `Page` | page store | ID, parent ID, title, icon, permissions | server state |
| `Block` | normalized block store | ID, type, parent, order key, content, version | operation-backed |
| `BlockTree` | selector layer | ordered visible IDs and descendants | derived client state |
| `BlockDraft` | block editor | active block, text, selection, composition, dirty | ephemeral |
| `DatabaseSchema` | view runtime | properties, types, filters, sorts | server state |
| `DatabaseRow` | view data layer | row ID, properties, cursor position | paginated server state |
| `Presence` | presence store | user, page, block/cursor, last seen | lossy realtime state |
| `SearchResultPage` | search layer | hits, snippets, cursor, total estimate | paginated server state |

Blocks are normalized by ID and ordered by parent plus an order key. The rendered page tree is derived from those relationships. This avoids copying a block into the page, sidebar, search preview, and database view.

The editor draft is separate from the persisted block. During composition, the browser may hold an unfinished IME sequence or selection that should not become a remote operation on every keystroke. A commit converts the draft into a semantic block operation.

Database views are projections over rows and properties. The page block stores the view configuration; the view data layer owns pagination, filtering, sorting, and loading state. A table view must not store an entire database inside the page document.

### Consistency model

Text editing may send debounced operations or use a collaboration protocol optimized for character changes. Block reorder, delete, and property updates need IDs, versions, and conflict semantics. Presence expires and may be dropped. The frontend keeps those classes separate even if they share a WebSocket.

## I — Interfaces — 8 minutes

### Server-facing API

``` 
GET  /api/workspaces/:workspaceId              → workspace and capabilities
GET  /api/pages/:pageId                       → page metadata and block snapshot
POST /api/pages/:pageId/blocks                → create block
PATCH /api/blocks/:blockId                    → update block content/properties
POST /api/pages/:pageId/reorder               → move blocks with version
GET  /api/pages/:pageId/database-view         → paginated view rows
GET  /api/search?q=...&cursor=...             → page/block search results
WSS  /api/pages/:pageId/presence              → collaborator presence
```

Mutations carry operation ID and base version. A response returns canonical block data, accepted revision, and any conflict or permission error. Reorder operations do not replace the whole page tree on conflict; they return the affected siblings so the client can reconcile.

Database-view requests carry filter, sort, selected properties, cursor, and view version. Search requests are abortable and return a cursor so old results cannot overwrite a newer query.

### Client interfaces

| Interface | Inputs | Output/event | Responsibility |
|---|---|---|---|
| `BlockRegistry` | block type/version | renderer, editor, schema | extensibility boundary |
| `BlockRenderer` | block data, children, mode | rendered block | presentation and local events |
| `BlockEditor` | draft, schema, selection | validated mutation | local editing |
| `PageStore` | block operations | normalized selectors | document projection |
| `SyncCoordinator` | mutations, versions | ack, conflict, resync | persistence and retry |
| `ViewDataLayer` | schema, filters, cursor | rows and status | database view data |
| `SearchController` | query, filters, abort signal | result pages | cancellation and URL state |

The page shell provides a capability-scoped action API. A block renderer can request “open page,” “update block,” or “set selection,” but it cannot import the raw network client or mutate another workspace.

## O — Optimizations and Deep Dives — 18–22 minutes

### Deep dive 1: Block editing and render isolation

The editor uses one active draft and commits semantic changes. A paragraph block can keep its controlled input local while the page store holds the last committed content. This prevents every keystroke from rerendering unrelated blocks and allows IME composition to work correctly.

The block registry gives each type an editor and renderer. A single growing switch is easy initially but becomes a coordination bottleneck and makes one malformed renderer a page-wide failure. The registry adds versioning and fallback complexity but pays off as the product grows beyond a few block types.

### Deep dive 2: Large pages and virtualization

Rendering thousands of blocks at once creates DOM, layout, and measurement pressure. I would virtualize long homogeneous page regions or defer below-the-fold blocks while keeping headings and focus targets available. Variable-height blocks make virtualization harder, so I would start with progressive rendering and measure before introducing aggressive recycling.

The page tree also needs lazy expansion. Loading every descendant page on workspace open creates a large payload and makes navigation slow. Names and parent relationships can load first; child details arrive when expanded.

### Deep dive 3: Database views

A database view is a block configuration plus a server-backed row projection. Filters and sorts belong in a normalized view query so table, board, and list presentations share the same result semantics. The client should paginate rows and virtualize the visible table.

The alternative is loading all rows and filtering in the browser. That gives instant local filtering for small tables but transfers sensitive and unbounded data, produces incorrect totals, and blocks the main thread. Server filtering with cursor pagination is the default; local filtering is a cache optimization for bounded pages.

### Deep dive 4: Collaboration and conflicts

Local edits feel immediate because the editor applies a local operation or draft. The sync coordinator keeps operation IDs and base versions. A reconnect requests changes after the last acknowledged revision. A conflict is scoped to the block or sibling order rather than resetting the whole document.

For a first release, version checks plus clear conflict UI can be sufficient. A CRDT or OT protocol is appropriate when offline and concurrent character-level editing are core promises. It adds complexity in memory, testing, garbage collection, and debugging, so I would not choose it solely because collaboration sounds impressive.

### Deep dive 5: Search and navigation

Search state belongs in the URL when a result should be shareable. The search controller debounces suggestions, cancels old requests, and ensures a late response cannot replace newer results. Search results hold snippets and cursors; opening a result loads canonical page data.

The quick-find command should preserve focus, support keyboard selection, and announce result counts. It should not silently navigate when a user is editing a block unless the user explicitly chooses a result.

### Deep dive 6: Offline and sync

Read-only offline mode is straightforward: show cached pages with a stale label. Offline editing requires an operation queue, conflict resolution, attachment handling, and auth renewal. The client can begin with drafts and local recovery, then add queued operations once conflict semantics are proven.

### Accessibility and responsive behavior

The editor provides keyboard navigation between blocks, a clear focus target, slash-command alternatives, and accessible labels for block type and status. The sidebar is a semantic tree with expand/collapse state. Database tables expose headers, row relationships, and non-color status.

On narrow screens, the sidebar becomes a drawer, the properties panel becomes a sheet, and block editing remains the primary flow. Presence cursors can be hidden or summarized on mobile without changing document correctness.

### Route lifecycle and page loading

The page route loads workspace capabilities, the page title and breadcrumb, and the visible block window as separate concerns. The shell can show navigation and page context while block content resolves. Expanding a page tree branch loads names and children lazily rather than requesting the entire workspace.

The URL identifies workspace, page, view, and search parameters. Selection, open panels, editor composition, and temporary block drafts remain local. A shared page link therefore restores the document location without leaking a private editing session.

### Block operation lifecycle

Typing updates a local block draft and schedules a mutation after a short idle window or explicit blur, depending on the block type. The mutation includes block ID, base version, operation ID, and the smallest meaningful patch. The sync coordinator acknowledges or rejects it without replacing unrelated local drafts.

Moving a block is a sibling-order operation, not a rewrite of the whole page tree. Converting a block is a versioned type change with a fallback representation if the new renderer is unavailable. These distinctions make conflict messages specific and keep undo history usable.

### Database view boundary

A database block owns view configuration, while the view runtime owns query results and row virtualization. Editing a property can invalidate several views, but the block store should receive only the canonical schema change; each view decides whether its cached page is still valid.

The client should not assume that a row visible in one view is complete in another. Row projections can differ by permissions and selected properties. The API response includes a view key and query version so a late response cannot populate a different filter or sort.

### Testing and observability

I would test block insertion, conversion, reorder conflicts, renderer fallbacks, virtualized focus, search cancellation, database cursor expiry, and reconnect replay. Tests should include a page with one broken block and verify that the rest remains editable.

Telemetry records time to first readable block, mutation acknowledgement latency, renderer failures by block version, view query latency, cursor restart rate, and sync conflicts. It should avoid sending page text, search terms, or database row values in standard analytics.

### Capacity assumptions and extension decisions

I would benchmark pages with thousands of blocks, a workspace with deep page nesting, and database views with many rows. The browser should load the page tree lazily, render the visible page progressively, and virtualize rows without requiring the entire workspace or database to be resident.

The block registry is an ownership boundary, not automatically a security boundary. First-party blocks can share the shell’s React runtime and normalized store through a narrow contract. Independently deployed block families can use Module Federation once versioning and fallback behavior are proven. An iframe is reserved for untrusted embeds or a separate security domain because it complicates selection, resize, focus, and cross-block commands.

### Block capability model

A block receives its typed content, block context, theme tokens, editing mode, and named actions. It does not receive the raw API client, the auth token, or every page’s data. Database blocks receive a view-data adapter that enforces the query and permission scope.

This lets the shell isolate a broken block with an error boundary and lets the sync coordinator reason about operations without importing renderer code. It also creates a path for read-only fallback: if an editor plugin is unavailable, the page can still display a safe summary.

### Versioning and migration

Block content carries a type version. A renderer can migrate old content in memory, but persistence requires an explicit migration result. Published or shared pages pin compatible representations so a newly deployed block cannot silently reinterpret old content.

I would prefer a visible migration warning over silently dropping unknown properties. The warning is a small product cost; losing a user’s block or changing a database view without review is a much larger trust failure.

### Failure matrix

| Failure | UI behavior | Recovery |
|---|---|---|
| Block renderer fails | local fallback | retry or read-only mode |
| Block mutation conflicts | retain draft | review/rebase/reload block |
| Page tree request fails | retry branch | keep current page open |
| Database view times out | view-local error | retry without losing page edits |
| Search response is stale | ignore by request ID | keep current result set |
| Socket disconnects | sync/presence banner | reconnect and resync operations |

### Alternative architecture review

The simplest editor renders every block in one React tree and saves a full page after each change. It is easy to build but makes long pages, embeds, and one broken block a page-wide concern.

A normalized block store and registry add contracts, but they let blocks render independently and let the shell isolate failures. Module Federation can support independently deployed first-party block families after the contract stabilizes. An iframe is reserved for untrusted embeds because a frame makes selection, resize, focus, and slash commands much harder.

The opposite alternative is a fully offline CRDT editor. It provides strong concurrent editing semantics, but it adds operation retention, garbage collection, conflict debugging, and attachment handling. I would begin with versioned operations and clear conflicts unless offline character-level collaboration is a core requirement.

### API semantics worth making explicit

- Page reads return capabilities, block versions, and a cursor or visible range.
- Block mutations carry block ID, base version, operation ID, and a narrow patch.
- Reorder operations identify the sibling list and intended position.
- Search responses carry query identity and opaque cursors.
- Database view responses carry view key, schema version, and freshness.
- Presence can expire and never blocks page mutations.
- Renderer failures are local to a block instance.
- Published or shared representations can fall back to read-only output.

### Presentation checkpoints

I begin with the user journey: open a page, edit a block, reorder it, search for another page, and view a database.

I trace that journey through route state, page tree, block registry, normalized store, sync coordinator, and view runtime.

I pause on why page content and database rows are separate server-state models even though both appear inside a page.

I close by explaining how block isolation improves ownership and failure recovery without turning every first-party block into an iframe.

### Implementation sequence

1. Build workspace routes, page tree, permissions, and a readable page shell.
2. Add normalized blocks, a renderer registry, and local error boundaries.
3. Add block editing, typed mutations, autosave, and version conflicts.
4. Add progressive page rendering and lazy page-tree expansion.
5. Add database view queries, cursor pagination, and row virtualization.
6. Add search cancellation, URL state, presence, and reconnect resync.
7. Add offline mutation replay or remote block loading only after conflict semantics are proven.

### Design review questions

The first question is whether one malformed embed can crash a whole page. If it can, the block boundary is not real.

The second is whether a database view can fetch only the rows and properties it needs. If it cannot, large or sensitive workspaces will overload the browser.

The third is whether a block mutation can be retried with a stable operation ID. If it cannot, a timeout may create duplicate edits.

The fourth is whether shared page rendering can fall back to read-only content when an editor plugin is unavailable. If it cannot, deployment compatibility is too fragile.

### What I would validate first

I would test a long page with one broken block, a large database view, a search race, and a reconnect during a reorder. The shell should preserve navigation and unrelated content in every case.

The success criteria are first readable content quickly, isolated block failures, cursor-safe view pagination, and mutations that can be retried without duplicating edits.

I would ask whether pages must work offline, whether database rows can contain sensitive fields, and whether embeds are trusted first-party components. Offline mutations and untrusted embeds materially change the sync and isolation choices.

I would also ask whether shared pages need editing or only reading. A read-only representation can be smaller, safer, and more resilient than shipping every editor and block plugin.

The final handoff is a route-oriented shell, a page and block registry, independent view data, versioned mutations, and local failure boundaries. It supports a fast readable page while keeping collaboration, search, and database projections from contaminating one another.

The strongest trade-off is using progressive rendering before aggressive virtualization. It preserves focus and block semantics while measurements are uncertain; virtualization can be introduced for proven long-page hotspots.

The other key trade-off is versioned operations before a full CRDT. It gives explicit conflict behavior now and avoids paying offline synchronization complexity before the product requires it.

### Final interviewer prompts

- What happens when one block fails?
- How are long pages loaded?
- Who owns database rows?
- How is a reorder retried?
- What does a shared page load?

The answers should consistently point back to block boundaries, independent view data, versioned mutations, and read-only fallbacks.

## Performance and scaling

The first bottleneck is a long page with expensive block renderers. The second is a large database view. The third is page-tree and search payload size. Progressive block rendering, row virtualization, cursor pagination, and lazy tree expansion address those independently.

I would measure time to first readable block, time to first editable block, block render duration by type, row render cost, search latency, operation queue depth, conflict rate, and memory after an all-day tab session.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Block model | normalized graph | nested rendered tree as source | one canonical block across features |
| Extensibility | versioned block registry | growing type switch | independent block families and fallback |
| Editing | local draft then semantic commit | network request per keystroke | IME support and responsive typing |
| Database rows | server filters and cursors | fetch all and filter locally | bounded transfer and correct totals |
| Collaboration | operation/version protocol first | CRDT immediately | staged complexity based on requirements |
| Search | URL state plus abortable server queries | global search store only | shareability and stale-response safety |
| Offline | cached read/draft recovery first | full offline sync | conflicts and attachments are costly |
| Rendering | progressive/virtualized regions | render all blocks eagerly | protects long-page performance |

## Closing — 3 minutes

“The workspace frontend is a normalized document system with multiple projections: page tree, block editor, database views, search, and presence. The block registry isolates rendering, the sync coordinator protects edits, and the data layer keeps view queries separate from page configuration. The result is a responsive editor that can scale its data and collaboration without turning every feature into one global store.”

If time remains, I would discuss comments, permissions, attachment caching, database formulas, mobile editing, and the point at which CRDT complexity becomes justified.

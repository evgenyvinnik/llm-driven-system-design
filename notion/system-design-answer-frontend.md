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
│ Workspace Shell                                                            │
│ routing · workspace switcher · sidebar · commands · accessibility          │
├──────────────────────┬──────────────────────┬──────────────────────────────┤
│ Page Tree             │ Block Editor         │ Database View Runtime         │
│ favorites · nesting  │ block registry       │ table · board · list · filter │
├──────────────────────┴──────────────────────┴──────────────────────────────┤
│ Normalized Page / Block Store                                               │
│ blocks · order · selection · drafts · derived render tree                   │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ Sync Coordinator             │ Search Data Layer                            │
│ mutations · versions · retry │ query · cursor pages · highlights            │
└──────────────────────────────┴─────────────────────────────────────────────┘
                               │ HTTPS / WSS
                    ┌──────────▼──────────┐
                    │ Workspace API       │
                    │ pages · blocks      │
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

### Failure matrix

| Failure | UI behavior | Recovery |
|---|---|---|
| Block renderer fails | local fallback | retry or read-only mode |
| Block mutation conflicts | retain draft | review/rebase/reload block |
| Page tree request fails | retry branch | keep current page open |
| Database view times out | view-local error | retry without losing page edits |
| Search response is stale | ignore by request ID | keep current result set |
| Socket disconnects | sync/presence banner | reconnect and resync operations |

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

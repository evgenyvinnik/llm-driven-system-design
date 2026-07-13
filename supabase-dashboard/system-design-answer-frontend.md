# Supabase Dashboard - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 📋 Problem Statement

Design the frontend for a Backend-as-a-Service management dashboard like Supabase Studio: developers browse and edit database schemas they've never seen before, run arbitrary SQL and inspect results, edit table rows like a spreadsheet, and administer authentication users.

The defining frontend challenge is that **the UI cannot know its own data model at build time**. Every table grid, every column form, every result set is shaped by a schema discovered at runtime through introspection. Everything we normally hardcode — columns, types, validation, which fields are editable — has to be derived from API responses on the fly.

## 🎯 Requirements Clarification

Questions I would ask up front:

- **Who is the user?** Developers, on desktop, usually side-by-side with their code editor. This is a professional tool — keyboard shortcuts and information density beat visual flourish.
- **How fresh must data be?** This is a database console: a developer runs DDL in the SQL editor and immediately expects the table list to reflect it. Staleness that would be invisible in a social feed is a bug here.
- **How large is "large"?** Target databases can have 100+ tables and millions of rows per table. The UI must never assume a table fits in memory.
- **Multi-user?** Yes — projects have members, and the schema can change underneath any user at any time (a teammate's migration, an application running DDL). The UI must tolerate external change.

### Functional Requirements

- **Project dashboard**: list projects, create/delete, live connection-status indicators per project
- **Schema browser**: tables with columns, types, defaults, PK/FK constraints, approximate row counts
- **Table data browser**: paginated, sortable grid with inline editing, row insert, and row delete
- **SQL editor**: multi-line editing, Ctrl+Enter execution, result table or rows-affected banner, error display, saved-query sidebar
- **Structured DDL forms**: create table, add/drop/rename columns without writing SQL
- **Auth user management**: CRUD over simulated auth users with roles and confirmation status
- **Settings**: connection configuration with a test-connection action

### Non-Functional Requirements

- Sub-200ms perceived navigation between dashboard sections
- Schema introspection round trip under 500ms for a 100-table database; UI stays responsive while it runs
- Bounded memory: never hold more than one page of row data or one result set at a time
- Desktop-first (1280px+), dark theme matching Supabase branding
- Keyboard-driven SQL workflow — power users should never need the mouse to run a query

### Explicitly Out of Scope (agreed with interviewer)

- Realtime subscriptions and live row updates (a separate WebSocket design)
- Row-level security policy editing
- Storage/bucket and edge-function management
- Mobile layouts — the personas and workflows are desktop-bound
- Offline support: a live database console with no connection has nothing truthful to show, so an offline mode would be theater

## 🏗️ UI Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Root layout (session check once on load)                       │
│                                                                │
│  ├── /login, /register        Auth pages                       │
│  ├── /                        Project dashboard (cards, status)│
│  └── /project/:id             Project layout ── persistent     │
│       ┌────────────┬─────────────────────────────────────────┐ │
│       │  Sidebar   │  Content outlet                         │ │
│       │            │                                         │ │
│       │  Tables    │  /tables          schema browser        │ │
│       │  SQL       │  /tables/:name    data grid             │ │
│       │  Auth      │  /sql             editor + results      │ │
│       │  Settings  │  /auth            auth user CRUD        │ │
│       │            │  /settings        connection config     │ │
│       └────────────┴─────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

The structural decision is **nested layouts with a persistent project shell**. The project route mounts the sidebar and breadcrumb once; section navigation swaps only the content outlet.

> "This matters more here than in a typical app because a database console is a high-frequency-navigation tool. A developer bounces between the SQL editor and the table list dozens of times in a session. If each bounce re-mounted the sidebar and re-fetched the project, we'd pay a network round trip and a layout flash on every hop. With nested routes, switching sections is a pure client-side render of the content area — the sub-200ms navigation target is met by simply not doing the work."

Authentication is checked once at app load via a session endpoint; the session cookie carries auth on every subsequent request. Per-route auth guards would re-verify on every navigation — wasted round trips for a session that rarely changes mid-use.

## 🧩 Component Architecture

Roughly sixteen components, grouped by feature and matched to the route structure:

| Group | Components | Responsibility |
|-------|-----------|----------------|
| Layout | ProjectSidebar, Breadcrumb | Persistent navigation shell, current-path display |
| Projects | ProjectCard, ConnectionStatus | Project tile with metadata; green/red connectivity dot |
| Schema | TableList, SchemaViewer, CreateTableModal, ColumnEditor | Table list with counts; column detail table; structured DDL form built from repeated ColumnEditor rows |
| Data | TableBrowser, DataRow | Pagination/sort state; per-row display and edit mode |
| SQL | SQLEditor, QueryResults, SavedQueryList | Input + keyboard shortcuts; result rendering; saved-query recall |
| Auth | AuthUserList, AuthUserForm | User table with role badges; create/edit form |
| Settings | ProjectSettings, ConnectionStatus | Connection form; test-connection feedback |

The split follows one rule: **containers own server state, leaves own interaction state**. TableBrowser owns page/sort and the fetched rows; DataRow owns only its edit-mode buffer. SQLEditor owns the text and shortcuts; QueryResults is a pure function of the last response.

> "That boundary is what makes the risky components replaceable. The SQL editor's contract is value, onChange, onRun — swapping the textarea for CodeMirror later touches one component. The results renderer never knows what editor produced the query. In a tool whose UI is generated from runtime schemas, keeping components pure functions of API responses is the discipline that keeps the whole thing testable."

## 🧠 State Management and Data Flow

Two stores: a small **auth store** (current user, login/logout/session-check actions) and a single **project store** holding all project-scoped state:

- Project list and the currently open project
- Introspected tables (the schema)
- Current page of row data plus pagination metadata
- SQL execution result, error, and the saved-query list
- Auth users and project settings
- Per-domain loading and error flags

**Why one project store rather than per-feature stores?**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Single project-scoped store | Atomic reset on project switch; one coordination point | One large store file |
| ❌ Per-feature stores (tables, sql, authUsers) | Smaller modules | Project switch must reset N stores in sync — timing bugs where stale tables from project A flash under project B's header |
| ❌ Server-cache library (React Query) | Dedup, retries, cache lifetimes for free | Its core value — caching — is the one thing this tool must not do implicitly |

> "The project switch is the dangerous moment. Every piece of data on screen — tables, rows, query results, auth users — is scoped to one project, and showing project A's rows under project B's name is a correctness failure a developer will screenshot and file. With a single store, switching projects is one atomic reset. With per-feature stores I'd need a coordination layer to reset them all in order, which is exactly the kind of cross-store choreography that breeds race conditions."

**Why not a server-cache library at all?** A cache library's default behavior — serve stale data instantly, revalidate in background — is the wrong default for a database console. If I run a column-drop statement and the schema browser serves a cached schema for even two seconds, the tool is lying about the state of the user's database.

My data-flow rule instead:

1. Reads always hit the network; the store holds the *latest confirmed server state*, not a cache with a lifetime
2. Every mutation triggers an explicit refetch of the affected domain on success
3. Nothing is ever rendered from a response older than the last mutation

I give up request deduplication and automatic retries — cheap to add by hand at this scale (dozens of components, not thousands), and I'll return to the freshness argument in a deep dive because it shapes everything.

## 🔌 API Layer

All fetching goes through one request helper (JSON handling, credentials inclusion, error extraction) organized into domain modules — auth, projects, tables, table data, SQL, auth users, settings.

```
GET    /api/projects                              project list
POST   /api/projects                              create project
GET    /api/projects/:pid/tables                  schema introspection
POST   /api/projects/:pid/tables                  create table (structured DDL)
PUT    /api/projects/:pid/tables/:name            alter table
GET    /api/projects/:pid/tables/:name/rows       page of rows (page, sortBy, sortOrder)
PUT    /api/projects/:pid/tables/:name/rows/:id   update row (changed fields only)
POST   /api/projects/:pid/sql/execute             run SQL → rows + fields, or rowCount
GET    /api/projects/:pid/sql/saved               saved queries
POST   /api/projects/:pid/test-connection         connectivity probe
```

Error handling is one pattern applied everywhere:

- The helper throws on non-2xx with the server's error message
- Store actions catch and write to per-domain error state
- Components render a red banner when error state is non-null — they never inspect HTTP status codes

This keeps error UX consistent across every screen without duplicating error UI logic per component.

## 🔄 Key Flow Walkthroughs

**Create a table (structured DDL):**

1. User opens the create-table modal, pre-seeded with an id and created_at column
2. User adds columns through ColumnEditor rows — name, type dropdown, nullable, PK, default
3. Frontend submits the structured column definitions (never SQL text) to the tables endpoint
4. Backend generates and executes the DDL, returning the generated SQL for transparency
5. Frontend shows the generated SQL in a confirmation toast — users learn the SQL their clicks produce
6. Frontend refetches the schema domain; the new table appears in the sidebar from live introspection, not from an assumed client-side insert

Step 6 is the freshness rule in action: I never fabricate the new table into the list optimistically, because the database may have transformed it (type coercions, added defaults) in ways only re-introspection reveals.

**Run a query:**

1. Ctrl+Enter fires the execute call with the editor text
2. Editor stays enabled; a running indicator with elapsed time appears in the results panel
3. On response, the store replaces the previous result wholesale — no merging
4. QueryResults renders one of the three outcome shapes (rows / rows-affected / error)
5. If the query was DDL, the user is one sidebar click from seeing it reflected — that click triggers fresh introspection, closing the loop without any cross-feature cache invalidation

**Switch projects:**

1. Navigation to a different project id triggers the store's single reset action
2. All six data domains clear synchronously before the new route renders
3. The new project's sections fetch lazily as the user visits them — no eager fan-out of six requests for sections that may never be opened

## 🖼️ Schema-Driven Rendering

Because the schema arrives at runtime, the grid and forms map PostgreSQL types to input affordances by rule rather than by hand:

| Introspected type | Rendered as | Notes |
|-------------------|-------------|-------|
| integer / numeric | Numeric input, right-aligned cell | Right alignment makes magnitude scannable |
| boolean | Checkbox in edit mode, true/false badge in display | Never free text |
| timestamptz | Text input accepting ISO strings | A date picker is a follow-up; ISO is the developer lingua franca |
| varchar / text | Text input, truncated display with title tooltip | Cap cell width so one long value can't destroy the row layout |
| jsonb | Monospace truncated preview; edit via SQL editor | Inline JSON editing is its own project — punt honestly |
| unknown / custom types | Read-only display | Never render an editable input for a type we can't validate |

> "The last row is the important judgment: when the introspection returns a type I don't recognize — a custom enum, a domain type — the honest move is read-only display, not a guessed text input. An editable field implies the tool can round-trip the value safely. Where it can't, the SQL editor is the escape hatch, and pretending otherwise generates support tickets shaped like data corruption."

## 🔧 Deep Dive 1: A Data Grid for Tables You've Never Seen

The table browser must feel like a spreadsheet while rendering rows of a schema the frontend discovers at runtime.

```
┌───────────────────────────────────────────────────────┐
│ products                        [Refresh] [Insert Row]│
├───────────────────────────────────────────────────────┤
│ id │ name ▲     │ price_cents │ stock │ actions       │
├────┼────────────┼─────────────┼───────┼───────────────┤
│ 1  │ Keyboard   │ 8999        │ 75    │ Edit  Delete  │
│ 2  │ Mouse      │ 2999        │ 150   │ Edit  Delete  │
│ 3  │ USB Hub    │ 4999        │ 200   │ Edit  Delete  │
├────┴────────────┴─────────────┴───────┴───────────────┤
│ 1,204 rows · Page 1 of 25            [Prev]  [Next]   │
└───────────────────────────────────────────────────────┘
```

**Decision: server-side pagination with a plain HTML table — not a virtualized infinite grid, not a spreadsheet library.**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Server-paginated HTML table | Bounded memory, visible totals, correct sort | Page clicks instead of fluid scroll |
| ❌ Virtualized infinite scroll | Fluid browsing feel | Obscures totals/position; windowed remote fetching + sort invalidation machinery |
| ❌ Spreadsheet library (AG Grid class) | Rich editing out of the box | 200KB+ dependency, theme fights, features aimed at a different product |

> "The instinct is to reach for a virtualized infinite-scroll grid — the right call for a social feed, the wrong call here — and the reason is what the user is trying to learn. A developer inspecting a table wants to know *how much data there is* and *where they are in it*: 'page 3 of 25, 1,204 rows' is information, not chrome. Infinite scroll deliberately obscures both. Mechanically, virtualization also fights this data: row heights vary with cell content, jump-to-offset over a remote dataset requires windowed fetching with cache eviction, and re-sorting invalidates the entire window. That's hundreds of lines of scroll-state machinery to deliver a worse mental model. Pagination maps one page to one bounded request — memory is capped at 50 rows whether the table has ten rows or ten million."

What I give up: fluid scroll-through-everything browsing. For scanning large ranges, the SQL editor with explicit LIMIT/OFFSET is the honest tool — and this audience knows it.

**Sorting is server-side only.** Clicking a header toggles sort parameters sent to the API, which the backend turns into an ORDER BY over the whole table. Client-side sorting would silently sort just the 50 loaded rows — output that *looks* correct and is wrong, the worst kind of bug in a data tool.

**Inline editing is row-scoped**, not cell-scoped:

1. Edit switches every cell in one row to inputs pre-filled with current values
2. The primary-key cell stays disabled — accidental PK edits break the row's identity for the update itself
3. Save diffs edited values against originals and sends only changed fields in the PUT
4. Cancel discards local state with no network call

> "Cell-level click-to-edit is the fancier pattern, and I rejected it. Every cell owning edit state, focus management, and its own save round trip multiplies the state machine by the column count — and partial-row saves can violate multi-column constraints the frontend can't see. Row-level gives one edit buffer, one diff, one atomic PUT. I trade a little spreadsheet fluidity for a state machine I can hold in my head."

**No optimistic updates on row edits.** The write goes to a live user-owned database that enforces constraints, triggers, and types the frontend cannot predict — write failures are structurally *common* here, not rare. Optimistically rendering a value the database then rejects, then rolling it back, actively misleads. The grid shows a saving state on the row, confirms on success, and refetches the page. Perceived cost is ~100ms on a row action; showing false data costs trust.

**NULL rendering**: null displays as italic, muted *null* — visually distinct from the empty string, a distinction developers genuinely care about. Setting a value *to* NULL from the grid is deferred to the SQL editor; a per-cell null toggle is the production follow-up.

**Insert form**: collapsible, one input per column, with auto-generated columns (serial PKs, defaulted timestamps) excluded via a has-default-and-is-PK heuristic. Rendering inputs the database will fill anyway invites conflicting values and confuses users about what's actually required.

## 🔧 Deep Dive 2: The SQL Editor — Where Power Users Live

```
┌────────────────┬──────────────────────────────────────┐
│ Saved queries  │  SELECT name, price_cents            │
│                │  FROM products                       │
│ top-products   │  WHERE stock > 50                    │
│ orders-by-day  │  ORDER BY price_cents DESC;          │
│ null-emails    │                        [Save] [Run]  │
│                ├──────────────────────────────────────┤
│                │  3 rows · 42ms                       │
│                │  name      │ price_cents             │
│                │  Keyboard  │ 8999                    │
│                │  USB Hub   │ 4999                    │
│                │  Stand     │ 3499                    │
└────────────────┴──────────────────────────────────────┘
```

**Decision: start with a styled plain textarea behind a stable editor interface, with CodeMirror as the planned upgrade — and explicitly not Monaco.**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Textarea now, CodeMirror next | Zero deps, instant load, swappable behind a stable contract | No highlighting or autocomplete initially |
| ❌ Monaco from day one | Full IDE feel, IntelliSense | 2MB+ of JavaScript for a tool used in thirty-second bursts |
| ❌ CodeMirror from day one | Highlighting at ~50KB | Front-loads theme/config work before the core flows exist |

> "The judgment call is about what the editor component *is*: its contract is just value, onChange, onRun. The keyboard behavior — Ctrl/Cmd+Enter to execute, Tab inserting spaces instead of stealing focus — lives at that boundary and survives any editor swap. Monaco specifically is the trap: a 2MB+ dependency serving an IDE use case, while a dashboard SQL box is opened for short bursts between other work. Paying multi-second first-load cost on every fresh session to get multi-cursor editing nobody asked for is a bad trade. CodeMirror at ~50KB with a SQL grammar is the right end state; the textarea proves the interaction design first."

**Results rendering distinguishes three outcomes**, because SQL has three:

- Row-returning queries render a scrollable, sticky-header table with row count and elapsed time
- Mutations render an "N rows affected" success banner — an empty grid after an UPDATE reads as failure
- Errors render PostgreSQL's message **verbatim**: line numbers and position offsets are exactly what a developer debugs with, and "something went wrong" sanitization would destroy the tool's core value

**Result sets are truncated, not streamed.** An unbounded SELECT over a million-row table would OOM the tab long before the network finished delivering it. The backend caps returned rows; the UI shows the cap plus a hint to add LIMIT. A console is for inspecting data, not exporting it — export is a separate server-side streaming feature.

**Saved queries** load into the editor on click as a replace operation. Replacing unsaved editor text is a real data-loss edge; the production fix is a dirty-state confirmation, which I'd prioritize *ahead of* syntax highlighting — losing a user's half-written query costs more trust than plain text ever will.

## 🔧 Deep Dive 3: Freshness — the Anti-Caching Architecture

Most frontend system design pushes toward more caching. This tool inverts that, and the inversion drives the whole data layer, so I want to defend it properly.

**Decision: no implicit client cache for schema or data; refetch-after-mutate everywhere; the only "cache" is the store's last confirmed server state, replaced wholesale on the next fetch.**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Always-fetch + refetch-after-mutate | Screen always reflects server truth; tolerates external DDL | Round trip on every section visit |
| ❌ Stale-while-revalidate cache | Instant repeat paints | Window where the UI contradicts the database; invalidation can't see external change |
| ❌ Long-TTL cache with manual invalidation | Fewest requests | Every missed invalidation edge is a lie on screen; edges are unenumerable here |

> "Consider the failure mode of a stale cache in each product. In a feed app, staleness costs a slightly old like count — invisible. Here, the user just executed a destructive statement in the SQL editor, clicks over to Tables, and a cached schema still shows the dropped table. They click it, get a 'relation does not exist' error, and now they distrust *every* screen — is the row count real? Is the data grid current? A database console's entire product is being a truthful window into the database; caching without airtight invalidation breaks the product, not a widget. And airtight invalidation is impossible here, because the schema can change from *outside* the dashboard entirely — a teammate's migration, an application running DDL. No client-side invalidation scheme can see those events."

The flow after any DDL action from the UI (create/alter/drop via the structured forms):

1. Perform the mutation
2. On success, refetch the schema domain
3. Render from the fresh response — the user watches their change appear because it *did* appear, server-confirmed

**What I give up, and how I soften each cost:**

- **Repeat-visit latency.** Every visit to the tables section pays the introspection round trip (~200–500ms). Mitigation is honest loading UX: keep the section's layout skeleton stable, show a lightweight loading row, never blank the sidebar. Perceived cost falls far below measured cost when the shell doesn't flash.
- **Duplicate in-flight requests.** Two rapid navigations can fire two introspections. A small in-flight de-dup map keyed by endpoint fixes this without introducing cache *lifetime* — de-duplicating concurrent identical requests is safe; serving *past* responses is what's not.
- **Server load.** Refetch-always costs more introspection queries. The right fix lives server-side (a short-TTL introspection cache invalidated on dashboard-issued DDL), not client-side where invalidation signals don't reach.

**Connection status** on project cards is the one place I poll rather than fetch on demand: a low-frequency probe (~30s) against the test-connection endpoint. Status is glanceable ambient information, and a dead-database surprise mid-workflow is worse than the trickle of probes.

## 🎨 Perceived Performance and UX Details

- **Dark theme as a functional choice**, not branding vanity: developers keep this open beside dark editors and terminals for long sessions; matching Supabase's palette also transfers user familiarity. Contrast ratios need explicit checking — muted-gray-on-dark falls below readability fast.
- **Schema viewer encodes constraints visually**: green PK badge, blue FK badge with a referenced-table tooltip, yellow highlight on nullable columns. Scanning fifty columns for "which of these can be null" becomes a color scan, not a read.
- **Create-table modal seeds two columns** — a serial primary key and a timestamptz created-at with a now() default — because virtually every new table starts with them; defaulting the common case is free UX.
- **Destructive actions** (drop table, delete row, delete project) require confirmation naming the target object. There is no undo against a live database; the confirm dialog is the only safety net, so it says exactly what it's about to destroy.
- **Loading discipline**: per-domain loading flags render inline placeholders scoped to the affected panel, never a full-page spinner — the sidebar and header are always stable ground.
- **Keyboard reach**: Ctrl/Cmd+Enter to run SQL, Escape to cancel row edits, Enter to commit the insert form. A developer tool earns its keep in saved mouse trips.
- **Accessibility isn't optional in a dark theme**: focus rings must be visible against #1C1C1C, the constraint badges carry text (PK/FK), not color alone, and the data grid is a real table element so screen readers get row/column semantics for free.
- **Numbers stay monospace and right-aligned** in both the grid and query results — column scanning of magnitudes is half of what a data console is for.

## 📉 Failure Handling in the UI

- **Target database down**: the backend's circuit breaker returns a fast, explicit "target database unavailable" error instead of a hung request. The UI renders it as a persistent banner in the content area with a retry action, while metadata screens (project list, saved queries, settings) keep working — the failure is scoped to the data-path sections, mirroring the backend's isolation.
- **Connection test failures** show the raw driver error (host unreachable, authentication failed) in the settings panel — verbatim beats sanitized for this audience, and the error text is the debugging clue.
- **Session expiry mid-use**: any 401 from the request helper clears auth state and redirects to login with a return-to path, so re-login lands the user back on the screen they lost.
- **Slow introspection**: the loading row persists with no timeout on the client; the server owns timeouts. The client's job is to stay interactive — the user can still navigate to settings and fix a bad connection while a doomed request drains.

## 📊 Frontend Observability

- **Real-user timing on the two SLO paths**: section-navigation time (target: sub-200ms perceived) and introspection-to-render time (target: under ~700ms including the 500ms server budget). These are measured as navigation-start-to-content-painted marks, reported with route labels.
- **Error reporting with domain context**: every surfaced error carries its store domain (tables, sql, authUsers) and project id, so "SQL errors spiked for one project" is distinguishable from "the API is down" without reading stack traces.
- **Query UX metrics**: distribution of result-set sizes and elapsed times as experienced client-side. If p90 result rendering exceeds the query's server time, the bottleneck has moved into my DOM — that's the signal to start the column-virtualization work rather than guessing.
- **Session-expiry redirects counted**: a spike means session TTLs are mis-tuned against real usage sessions, a config fix that's invisible without the metric.

## 📈 Scalability: What Breaks First in the Browser

1. **First: wide result sets in the SQL editor.** A SELECT returning 200 columns × 500 rows is 100K DOM cells — layout and paint die before memory does. Fixes in order: cap rendered rows with a "showing first N" notice (cheap, honest), then column virtualization for the results grid only. This is the one place in the app where virtualization earns its complexity, because result shape is truly unbounded and there's no pagination metaphor to lean on.
2. **Second: databases with hundreds of tables.** The sidebar table list and the introspection payload grow linearly. Fix: client-side filter-as-you-type over table names (scanning a few hundred strings is free) and collapsing the schema payload into lazy per-table detail fetches so the initial load carries names and counts only.
3. **Third: long-running queries blocking the workflow.** A 30-second query today occupies the editor. Fix: async execution UX — fire the query, show elapsed time with a cancel button wired to a backend cancel endpoint, keep the rest of the app navigable while it runs.
4. **Team scale: concurrent schema editing.** Multiple developers editing the same schema invites conflicting DDL. The refetch-on-mutate model already tolerates external change; the upgrade is a lightweight schema-version check that prompts "schema changed since you loaded — refresh" before destructive form submissions, turning a confusing server error into a clear workflow.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Data grid | ✅ Server-paginated table | ❌ Virtualized infinite scroll | Totals/position are information; bounded memory; sort correctness |
| Sorting | ✅ Server-side ORDER BY | ❌ Client-side sort | Client sort of one page looks right and is wrong |
| Freshness | ✅ Refetch-after-mutate, no implicit cache | ❌ Cache-library defaults | Staleness = lying about the user's database; external DDL defeats invalidation |
| Store shape | ✅ Single project-scoped store | ❌ Per-feature stores | Atomic reset on project switch kills a class of races |
| Row edits | ✅ Confirm-then-render | ❌ Optimistic updates | Unknown constraints make write failures common; false data worse than 100ms |
| Edit granularity | ✅ Row-level edit mode | ❌ Cell-level click-to-edit | One buffer, one diff, one atomic PUT |
| SQL editor | ✅ Textarea now, CodeMirror path | ❌ Monaco | 2MB IDE bundle vs short-burst usage pattern |
| Errors | ✅ Verbatim PostgreSQL messages | ❌ Sanitized copy | Line/position info is the debugging payload for this audience |
| Auth check | ✅ Once at app load | ❌ Per-route guards | Session cookie carries per-request auth; guards add round trips |

## 🚀 Closing: What I'd Build Next

With more time I'd discuss: CodeMirror integration with schema-aware autocomplete — table and column names fed from the introspection response, the highest-leverage editor feature and well beyond cosmetic highlighting; per-cell NULL controls and composite-primary-key support in the grid; async query execution with cancellation and a query-history panel; the dirty-state guard for the SQL editor; and column virtualization for wide result sets. Each extends the same skeleton — the runtime-schema data flow and the no-stale-data rule are the foundations everything else hangs on.

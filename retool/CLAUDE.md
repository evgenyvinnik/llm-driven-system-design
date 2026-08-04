# Retool — Development with Claude

## Project Context

This is the meta-problem: a tool whose users build tools. Every normal assumption inverts. There's no fixed schema, because the schema is whatever a user drags onto a canvas. There's no fixed query, because the user writes the SQL. There's no fixed data source, because the user points it at their own database. The application's job is to be a faithful *interpreter* of a document that describes an app, and everything hard follows from that.

Two decisions dominate. The first is what an "app" actually is on disk — here a row in `apps` with JSONB columns for `components`, `layout`, and `queries`, which means the product's core data model is a document, not a set of tables. The second is the binding engine: `{{ query1.data[0].name }}` is the glue between a query result and a widget prop, and how you evaluate it determines whether you've built a template resolver or an arbitrary code execution service.

The uncomfortable third is trust. This backend deliberately opens connections to databases users configure, and runs SQL users write, against them. That's not a bug in the design — it's the product — but it means the security boundary has to be somewhere explicit, and it's worth being clear about where it is and isn't.

**Learning goals:** document-shaped domain modeling with JSONB, safe expression evaluation without `eval`, dynamic connection-pool lifecycle for user-supplied databases, immutable version snapshots for publish/rollback, and a three-pane drag-and-drop editor over a grid coordinate system.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** | Single Express process; `dev:server2`/`dev:server3` on 3002/3003 |
| **PostgreSQL 16 — metadata** | 5432 | The platform's own store: `users`, `apps`, `app_versions`, `data_sources`, `saved_queries` |
| **PostgreSQL 16 — target** (`sample_db`) | **5433** | A *separate container* standing in for a customer's database. The whole point is that it's not the same instance |
| **Valkey (Redis)** | 6379 | `express-session` store via `connect-redis`, plus `rate-limit-redis` so limits hold across instances |
| **Frontend** (Vite) | 5173 | Proxies `/api` → `localhost:3001` |

Services in `backend/src/services/`: `queryExecutor.ts` (per-data-source `pg.Pool` cache, SELECT-only guard, OID→type-name mapping), `bindingEngine.ts` (`{{ }}` parsing and property-path resolution), `componentRegistry.ts` (widget catalog with per-prop schemas and `bindable` flags), `appService.ts` (CRUD plus publish/versioning), `db.ts`, `redis.ts`, `rateLimiter.ts`, `circuitBreaker.ts`, `metrics.ts`, `logger.ts`. Routes: `apps`, `components`, `datasources`, `queries`, `deployments`, `auth`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind. The editor is `components/editor/` — `ComponentPalette` (left), `CanvasArea` (center), `PropertyInspector` (right), plus `QueryPanel` and `BindingInput`. Nine widgets live in `components/widgets/` (table, textInput, button, text, numberInput, select, chart, form, container), dispatched by `WidgetRenderer`. State splits into `editorStore` (canvas/selection) and `dataStore` (query results); `routes/app.$appId.edit.tsx` and `app.$appId.preview.tsx` are the two modes.

## Key Design Decisions

### 1. An app is a JSONB document, not normalized tables

`apps.components`, `apps.layout`, and `apps.queries` are JSONB columns. There is no `components` table with a row per widget.

Normalizing looks obviously more correct until you consider what changes. A widget is `{ type, props, position, bindings }` where `props` differs *per widget type* — a table has `columns`, `pageSize`, `searchable`; a chart has `xKey`, `yKey`, `chartType`. Relational modeling gives you either a wide sparse table (a column per prop across all types, mostly NULL, and a migration every time a widget gains an option) or an EAV key-value table (which is JSON with extra steps and worse ergonomics). In a product whose *entire value* is that the component model evolves fast, either choice means a schema migration is the tax on shipping a widget feature.

JSONB also matches the access pattern exactly. The editor loads an entire app and saves an entire app; it never asks "find all buttons across all apps." One row in, one row out, no joins, and the document that arrives at the client is the document the client edits.

What we give up is real: no referential integrity inside the document (a binding can reference `query1` after `query1` is deleted, and nothing stops it), no efficient cross-app queries without GIN indexes that don't exist here, and no partial updates — saving one prop rewrites the whole `components` array, so two editors on the same app silently clobber each other. Last-write-wins is the current concurrency model, which is fine for one builder and wrong for a team.

### 2. Bindings resolve by property-path traversal, never `eval`

`resolveBindings` matches `{{ … }}`, splits the expression on dots and bracket indices, and walks the context object segment by segment. `{{ query1.data[0].name }}` becomes `["query1","data","0","name"]` and is looked up. Anything unresolvable returns empty string.

Using `eval` or `new Function` is what would make the feature *actually* powerful — real Retool supports arbitrary JavaScript in bindings — and it's the single most dangerous thing this codebase could do. These expressions are stored in a database, authored by one user, and evaluated in the server process where a published app renders. That's a stored server-side code-injection primitive: an expression like `{{ process.env }}` or a `require('child_process')` chain would run with the API's privileges, exfiltrating the metadata database credentials and every user's data-source password. A sandbox (`vm2`, isolated-vm, a QuickJS build) can contain that, but each is its own project with its own escape history.

Path traversal is trivially safe because it can only *read* properties of an object we constructed. What we give up is expressiveness, and it's a lot: no `{{ items.filter(x => x.active) }}`, no `{{ a + b }}`, no formatting, no conditionals. Users hit that ceiling almost immediately, which is why decision 3 exists as the workaround.

### 3. The query executor pools per data source and defaults to read-only

`getTargetPool` caches a `pg.Pool` per `data_source_id` (max 5 connections, 60s idle timeout), created lazily and dropped on pool error. `executeQuery` rejects anything that doesn't start with SELECT/WITH/EXPLAIN unless `allowWrite` is explicitly passed.

Creating a fresh connection per query — the obvious implementation — fails on arithmetic. A dashboard with six queries that auto-run on load, opened by twenty users, means 120 TCP connections plus TLS plus Postgres backend-process forks in a burst, against a customer database sized for its own workload. Postgres's `max_connections` is typically ~100; you'd exhaust *their* database, and the symptom would appear in their production system, not ours. Capping at 5 per data source bounds our blast radius on someone else's infrastructure — which is the right thing to be conservative about, because it isn't ours.

The read-only default is defense in depth. The `allowWrite` flag exists because internal tools genuinely need to write, but making the safe path the default means an accidental `DROP TABLE` in a query editor is rejected by the executor rather than by the user's backups.

Here is the honest weakness, and it's the same one real low-code tools live with: **bindings are interpolated into SQL as text before execution**. `resolveBindings` runs on the query string, so `WHERE name = '{{ searchInput.value }}'` substitutes raw user input into SQL — a classic injection vector, present by construction. Parameterizing would mean the binding engine emitting `$1` placeholders plus an ordered value array instead of a string, which is a real refactor. Right now the mitigations are the read-only default and the fact that the connection uses whatever credentials the data source was configured with. That's not sufficient, and it's the most important thing on this project's list.

### 4. Publishing writes an immutable snapshot, not a pointer

`appService.publish` copies the app's current `components`/`layout`/`queries` into a new `app_versions` row with an incrementing `version_number` (UNIQUE on `(app_id, version_number)`), and sets `apps.published_version`.

Serving the published app from the live `apps` row is simpler and it breaks the product's core promise. Non-technical staff use these internal tools to do their jobs; a builder mid-edit at 2pm would push a half-finished canvas straight into their hands. Worse, there'd be no rollback — the previous version wouldn't exist anywhere, so a bad publish is unrecoverable except by rebuilding from memory.

Snapshots give both: editing is free (drafts never affect anyone) and rollback is just changing which version number is published. This is also where JSONB pays for itself twice — a snapshot is a copy of three columns, not a recursive deep-clone across five normalized tables with FK rewrites.

The cost is storage growth (every publish duplicates the full document, and there's no pruning) and version drift on the *other* side: a snapshot freezes the app definition but not the schema of the target database, so a published app referencing a dropped column fails at run time with a SQL error the snapshot can't prevent.

### 5. Sessions in Redis, not JWTs

`express-session` + `connect-redis`, cookie-based.

The generic argument (immediate revocation, no refresh dance) applies, but there's a project-specific reason. This platform holds *data-source credentials* — connection strings and passwords for databases that aren't ours. If a session is compromised, "the token expires in 15 minutes" is not an acceptable answer; the operator needs the session dead now, and server-side sessions are the only design where deletion is instant. Rate limits use `rate-limit-redis` for the same reason: the counter has to be shared, or three API instances mean three times the intended limit.

What we give up is a Redis dependency on the auth path — Redis down means nobody can log in. Given that Redis is also required for rate limiting, that dependency already exists.

## Current State

Runs with `docker-compose up -d` (three containers: metadata Postgres on 5432, target Postgres on 5433, Valkey), then `npm run db:migrate` in `backend/`, then `npm run dev` (API on 3001). Implemented: session auth with bcrypt, app CRUD with JSONB documents, publish/versioning with history, data-source CRUD with a connection test, query execution against target databases with binding resolution and the SELECT-only guard, saved queries with manual/on_load/on_change triggers, the component registry with per-prop schemas, the three-pane editor with @dnd-kit drag-from-palette, a 12-column grid with `{x,y,w,h}` positioning, nine widgets, `BindingInput` with `{{ }}` highlighting, a query panel with SQL editor and results table, and a preview mode that renders the app with live data. Prometheus metrics, pino/pino-http structured logging, Redis-backed rate limiting, and `/api/health` are wired in `app.ts`. Vitest covers `app.test.ts`.

Seeded logins: `alice` / `password123` (admin, owns the sample app) and `bob` / `password123`. The seed also creates a `data_sources` row pointing at the `target-postgres` container (`localhost:5433`, `sample_db`, user `sample`), so the query editor has a real e-commerce schema to run against on first launch.

Simulated or omitted: `data_sources.type` permits `rest_api` in the CHECK constraint, but `queryExecutor` rejects anything that isn't `postgresql` — REST sources are schema-only. No JavaScript transforms (`saved_queries.transform_js` exists as a column and nothing executes it). No component events beyond an `onClick` prop that the registry declares. No undo/redo. No multi-user editing, presence, or conflict resolution. No `circuitBreaker.ts` usage on the query path despite the module existing. No admin UI.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** restructured the notes file. The old version wasn't a checkbox template, but it described the system as a build log — "Phase 2: Backend Implementation" listing what was written — without ever stating *what fails* if a decision goes the other way. It also asserted "Component registry defining 9 widget types" with no pointer to the file, and never mentioned that bindings are interpolated into SQL as text, which is the single most consequential property of the query path.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 NODE_ENV=development tsx watch src/index.ts`, matching the Vite proxy target. Note `scripts/screenshot-configs/retool.json` declares `"backendPort": 3000` — stale, since nothing binds 3000 here.
- **`dev:server2` / `dev:server3` don't do what they look like:** they're written as `PORT=3002 npm run dev`, and `dev` itself begins with `PORT=3001`, so the inner assignment wins and all three land on 3001. Multi-instance testing needs the port set inside the `dev` invocation, not around it.
- **Target-pool leak on error (fixed):** `getTargetPool` now registers a `pool.on('error')` handler that evicts the pool from the `Map`. Without it, a target database restart left a dead pool cached forever and every subsequent query for that data source failed until the API was restarted.
- **Two Postgres containers, one port collision to watch:** the target database is deliberately mapped to **5433**, not 5432. Running another project from this repo at the same time will collide on 5432 (and the seeded data source hardcodes `localhost:5433`, so changing the mapping breaks the seed).
- **2026-08-04 — the table rendered "No data" in both the editor and preview, while the query returned five rows.** Two independent faults on the binding path, and the API was innocent throughout (`POST /api/queries/execute` returned 200 with all five customers the whole time):
  1. **The seeded binding referenced the query's `id`, not its `name`.** Both `QueryPanel` and `PreviewRenderer` store results under `query.name` (`stores/dataStore.ts`), so `{{ query1.data }}` — where `query1` is the *id* and `getCustomers` is the name — resolved to nothing. The code is self-consistent on names; only the seed disagreed. Fixed the seed to bind `{{ getCustomers.data }}`.
  2. **Three widgets subscribed to a function instead of to data.** `TableWidget`, `ChartWidget` and `TextWidget` each did `const getBindingContext = useDataStore(s => s.getBindingContext)` and then called it during render. Zustand re-renders only when the *selected value* changes, and a store action's reference is stable forever — so those widgets were subscribed to nothing that ever changes. They computed the binding context once, on first render, while `queryResults` was still empty, and never recomputed. Added `useBindingContext()`, which selects the `queryResults`/`componentValues` slices (so the widget re-renders when they change) and memoizes the derived object (so it isn't rebuilt on every call — returning a fresh object straight from a selector is the classic Zustand infinite-loop).
  - Worth noting for the editor screenshot: "No data" **is** correct there. `on_load` queries run only in `PreviewRenderer`, deliberately — an editor shouldn't hit a customer's database every time an app is opened.
- **CI:** the repo-wide smoke-test workflow was removed — a runner can't provide two Postgres instances plus Valkey. Verification is local (`npm run triage retool`).

## Open Questions

1. Bindings interpolate into SQL as text. Making the engine emit `$1` placeholders plus an ordered params array is the correct fix — but bindings also appear in *non-SQL* contexts (widget props) where a string is what's wanted. Should the engine have two modes, or should query bindings be a separate syntax entirely?
2. The binding engine can't do arithmetic, filtering, or formatting, and users hit that immediately. Is a sandboxed evaluator (isolated-vm/QuickJS) worth its escape surface, or is a small hand-written expression grammar — comparisons, arithmetic, a handful of functions — the better trade for a tool like this?
3. Saving rewrites the entire `components` array, so concurrent editors clobber each other silently. Does this need CRDT/OT machinery, or would optimistic locking on a `version` column (reject the save, force a reload) be enough for a builder tool where simultaneous editing is rare but data loss is unacceptable?
4. Queries declared `on_load` all fire when an app opens, with no dependency graph — so a query that needs another's output can't express that. Is cascading execution worth building, or does it mean reinventing a dataflow scheduler?
5. `app_versions` grows without bound and each row duplicates the full document. At what point does that need pruning, and is "keep the last N plus every published version" the right policy?

## Resources

- [PostgreSQL JSONB](https://www.postgresql.org/docs/current/datatype-json.html) — the document-column model and the GIN indexes not yet used
- [node-postgres pooling](https://node-postgres.com/features/pooling) — `pg.Pool` lifecycle and the error handler behind the leak fix
- [OWASP SQL injection prevention cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html) — the parameterization decision 3 does *not* currently make
- [dnd-kit documentation](https://docs.dndkit.com/) — palette-to-canvas dragging and grid snapping
- [Retool: how our editor works](https://retool.com/blog/) — the product this models

# Supabase Dashboard — Development with Claude

## Project Context

Every other project in this repo owns its database. This one is a client *of* databases it doesn't own — and that inversion is the whole design problem. The dashboard has no idea what tables exist until it asks, no idea what columns they have until it introspects, and no compile-time knowledge of anything it renders. A table browser here can't be typed against a schema, because the schema is a runtime answer that changes while you're looking at it.

That forces a split that shows up everywhere in the code: the **metadata** database (`supabase_meta` on 5432) holds the platform's own state — users, projects, connection configs, saved queries — and the **target** database (`sample_db` on 5433, a separate container) is the user's, reached through dynamically created pools keyed by project ID. Every route handler has to know which of the two it's talking to, and getting that wrong is either a privacy leak or a crash.

The second theme is that this tool's job is to be dangerous on purpose. A SQL editor that refuses `DROP TABLE` isn't a SQL editor. So unlike the retool project — which shares this scaffold but guards its executor to SELECT-only — the safety story here can't be "restrict what runs." It has to be "make the destination unambiguous and the identifier handling correct," which is a much narrower guarantee and worth being honest about.

**Learning goals:** runtime schema introspection via `information_schema`, dynamic connection-pool lifecycle keyed by tenant, DDL generation from structured input with identifier quoting, building UI against a schema discovered at runtime, and the difference between parameterizing *values* and sanitizing *identifiers* — which are not the same problem and don't have the same solution.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** | Single Express process; `dev:server2`/`dev:server3` nominally on 3002/3003 |
| **PostgreSQL 16 — metadata** (`supabase_meta`) | 5432 | Platform state: `users`, `projects`, `project_members`, `saved_queries`, `auth_users` |
| **PostgreSQL 16 — target** (`sample_db`) | **5433** | A *separate container* standing in for a customer's database. Being a different instance, not a different schema, is the point |
| **Valkey (Redis)** | 6379 | `express-session` store via `connect-redis`, plus `rate-limit-redis` for shared limits |
| **Frontend** (Vite) | 5173 | Proxies `/api` → `localhost:3001` |

Services in `backend/src/services/`: `queryExecutor.ts` (the per-project `pg.Pool` cache, max 5 connections, 60s idle), `schemaIntrospector.ts` (`information_schema` queries plus `pg_class.reltuples` for row estimates and `pg_indexes` for index listing), `ddlGenerator.ts` (CREATE/ALTER/DROP from structured column definitions, with `sanitizeIdentifier` and a reserved-word set), `authUserService.ts`, `db.ts`, `redis.ts`, `rateLimiter.ts`, `circuitBreaker.ts`, `metrics.ts`, `logger.ts`. Routes: `auth`, `users`, `projects`, `tables`, `tableData`, `sql`, `authUsers`, `settings`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind, dark-themed. The route tree nests under `project.$projectId.*` — `tables`, `tables_.$tableName`, `sql`, `auth`, `settings` — with `TableList`/`TableBrowser`/`SchemaViewer`/`ColumnEditor`/`CreateTableModal` for the table editor, `SQLEditor` + `QueryResults` + `SavedQueryList` for the SQL pane, and `AuthUserList`/`AuthUserForm` for user management.

## Key Design Decisions

### 1. Two separate database instances, not two schemas in one

Compose runs two Postgres containers. The metadata DB is reached through the module-level `pool` in `services/db.ts`; the target DB only ever through `queryExecutor.getTargetPool(projectId, config)`.

Putting both in one instance under different schemas would be far easier to run and would destroy the property the project exists to demonstrate. If the user's tables live in the same server as `users` and `projects`, then the SQL editor — which by design runs arbitrary SQL — can read the platform's own tables. A curious user types `SELECT * FROM users` and gets every dashboard account's password hash; `SELECT * FROM projects` hands them every other tenant's database credentials in plaintext. Schema-level `GRANT`s could theoretically contain that, but they'd be one misconfigured role away from full exposure, and the SQL editor's whole job is to let people run things you didn't anticipate.

Separate instances make the isolation structural: the target pool physically cannot see `supabase_meta`, because it's a different server on a different port with different credentials. No permission mistake can bridge it. This also mirrors what real Supabase does — each project gets its own Postgres — and it's why `db_host` and `db_port` are per-project columns rather than global config.

The cost is operational: two containers, two sets of credentials, and every route handler must consciously pick a pool. That last part is where bugs would live, and it's the reason `sql.ts` and `tableData.ts` both start with a `getProjectConfig` helper — making "which database" an explicit first step rather than an implicit default.

### 2. Connection pools are cached per project, created lazily, evicted on error

`getTargetPool` keeps a `Map<projectId, pg.Pool>` with `max: 5`, `idleTimeoutMillis: 60000`, and a `pool.on('error')` handler that deletes the entry and decrements the `activeConnections` gauge.

Connecting per query is the naive version and it fails on someone else's infrastructure, which makes it worse than a normal performance bug. Each new `pg.Client` costs a TCP handshake, TLS, auth, and a forked backend process on the *target* server. A table browser paginating through rows, a schema viewer refreshing, and a SQL editor running a query would each open and discard connections in bursts; against a customer database with the default `max_connections` of ~100, a few simultaneous users exhaust it — and the outage appears in their production system, caused by our dashboard. Capping at 5 per project bounds our blast radius on a database we don't own.

Eviction on error is the half that's easy to omit and painful to debug without. A cached pool whose target restarted is permanently poisoned: every subsequent query for that project fails until the API process is bounced, and the error message ("Connection terminated") gives no hint that the fix is server-side. Dropping the pool on error means the next request transparently rebuilds it.

What we give up: pools are per-process and never proactively closed, so N projects × M API instances is the real connection ceiling, and there's no LRU — a dashboard with hundreds of projects would hold hundreds of idle pools until the 60s timeouts drain them.

### 3. Introspection reads `information_schema`, with `pg_catalog` only where it must

`introspectTables` queries `information_schema.tables` and `.columns`, joining `table_constraints` → `key_column_usage` (and `constraint_column_usage` for FK targets) to detect primary and foreign keys. It drops to `pg_class.reltuples` for row estimates and `pg_indexes` for index definitions.

`pg_catalog` would answer all of this in fewer joins, and it's what tools like psql actually use. The reason to prefer `information_schema` is that it's the SQL standard's own metadata view: the queries are portable, the column names are self-describing (`is_nullable`, `data_type`, `column_default`), and the output needs almost no translation before it reaches the UI. `pg_catalog` trades that for OID joins and `pg_attribute.attnum` arithmetic — faster and more capable, but Postgres-specific and much harder to read six months later.

The two exceptions prove the rule: `information_schema` has no row count and no index definitions, so those come from `pg_class` and `pg_indexes`. Using `reltuples` rather than `COUNT(*)` is itself the right call — an exact count on a large table is a full scan, and a dashboard showing "≈ 12,400 rows" instantly is more useful than one that hangs for thirty seconds to be precise.

The trade-off is that `reltuples` is an *estimate* maintained by autovacuum, so a freshly-loaded table can report `-1` or a badly stale figure until it's analyzed. The UI presents it as truth.

### 4. DDL is generated from structured input, and identifiers are quoted rather than parameterized

`ddlGenerator` builds `CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` from typed `ColumnDef` objects. Every identifier passes through `sanitizeIdentifier`, which strips anything outside `[a-zA-Z0-9_]` and wraps the result in double quotes if it was modified or matches a reserved-word list.

This is the decision people most often get wrong, so it's worth stating precisely why parameterization isn't available here. Prepared-statement placeholders bind *values*: `WHERE id = $1` works because the planner knows a literal goes there. You cannot write `CREATE TABLE $1 (...)` — an identifier is part of the statement's structure, so the parser needs it before planning. There is no `$N` for table names, in any driver, ever. That leaves quoting as the only correct mechanism, and it has to be right: an unquoted, unfiltered identifier is a direct injection vector, since `users; DROP TABLE accounts; --` as a "column name" is just more SQL.

Generating DDL from structured `ColumnDef` input rather than accepting a raw DDL string is the other half — it means the type, nullability, and default each arrive in a known slot and can be validated independently, instead of being parsed back out of a string the user wrote.

Two honest defects in the current implementation. First, `sanitizeIdentifier` **silently renames** instead of rejecting: `my table` becomes `"mytable"`, and the user gets a table with a name they didn't ask for and no warning. A name made entirely of invalid characters produces `""`, an empty quoted identifier that Postgres will reject with a confusing error. Second, the reserved-word list is hand-maintained and covers ~50 keywords against Postgres's several hundred — so an identifier like `window` or `offset` slips through unquoted. Both are argued for by "quote everything, always," which is what a mature implementation does.

### 5. Session auth in Redis, because this app holds other databases' credentials

`express-session` + `connect-redis`, with the metadata `projects` table storing per-project `db_host`/`db_port`/`db_name`/`db_user`/`db_password`.

The generic case for server-side sessions (instant revocation, no refresh dance) applies, but the specific reason is what a compromised session grants: not just access to this dashboard, but a SQL editor pointed at every database the user's projects are configured for. "The JWT expires in fifteen minutes" is not an acceptable containment story when the fifteen minutes include `DROP DATABASE`. Session deletion is immediate and unconditional.

The corresponding weakness is right next to it: `projects.db_password` is a plain `VARCHAR` storing the credential in cleartext. Anyone with metadata-database read access has every target credential. Encrypting at rest (with the key outside the database) is the obvious fix and isn't done — the two-instance split in decision 1 is what currently keeps the SQL editor from reading that column, which is defense by topology rather than by encryption.

## Current State

Runs with `docker-compose up -d` (three containers: metadata Postgres on 5432, target Postgres on 5433, Valkey), then `npm run db:migrate` in `backend/`, then `npm run dev` (API on 3001). Implemented: session auth with bcrypt, project CRUD with per-project connection config and a connection test, project members with owner/editor/viewer roles, schema introspection (tables, columns, types, nullability, defaults, PK/FK detection, row estimates, index listing), the DDL generator wired to create/alter/drop tables and columns, a table data browser with pagination, sorting, inline edit, insert and delete, an arbitrary-SQL editor with saved queries per project, simulated auth-user management (create/edit/delete with bcrypt-hashed passwords and `raw_user_metadata` JSONB), project settings, Prometheus metrics with an `activeConnections` gauge, pino/pino-http logging, Redis-backed rate limiting with a stricter `queryLimiter` on execution, and `/api/health`. Vitest is configured.

Seeded logins: `alice` / `password123` (admin) and `bob` / `password123`. Three projects are seeded — Storefront Production, Storefront Staging, Analytics Sandbox — all pointed at the same `sample_db` on 5433 (with differing member roles), plus saved queries written against that sample schema (`products`, `customers`, `orders`, `order_items`) so the SQL editor and table browser have real tables to work with on first launch.

Simulated or omitted: **`auth_users` lives in the metadata database, not the target database** — real Supabase puts `auth.users` inside each project's own Postgres, so this is a meaningful divergence and means the "auth users" screen manages rows the target database has never heard of. No storage, edge functions, realtime, or API-key generation. No RLS policy management. No migration history or diffing. No `EXPLAIN`/query-plan visualization. Only `postgresql` connections are supported.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** restructured this file. The old version's "Key Design Decisions" were descriptions rather than decisions — "Session Auth over JWT" said only that it was "simpler… and consistent with the retool project pattern," which is a cross-reference, not a reason, and never mentioned that this app stores other databases' credentials. It also listed **"Supabase Dark Theme"** (a colour choice) as a peer of the two-database architecture, and its Phase 2 notes claimed "7 route files" while listing eight. None of it named the two genuine weaknesses below.
- **Value handling is inconsistent within one file:** in `routes/tableData.ts`, the row **INSERT** path correctly builds `$N` placeholders and passes values separately — but the **UPDATE** and **DELETE** paths build SQL by hand with `String(value).replace(/'/g, "''")`. Manual quote-doubling is not equivalent to parameterization (it does nothing for numeric contexts, backslash handling, or non-string types), and having both approaches in one file means the safe pattern was known and not applied uniformly. This is the highest-value fix on the project.
- **`sanitizeIdentifier` renames instead of rejecting:** stripping invalid characters and proceeding means `my table` silently becomes `"mytable"`. It should return an error the UI can show. The same function is duplicated in `routes/tableData.ts` rather than imported from `ddlGenerator.ts`, so a fix in one place won't reach the other.
- **No read-only guard, deliberately:** unlike `retool/backend/src/services/queryExecutor.ts`, which shares this scaffold and blocks anything that isn't SELECT/WITH/EXPLAIN, this executor runs whatever it's given. That's correct for a SQL editor, and it's the reason decision 1's instance-level isolation is load-bearing rather than merely tidy.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 NODE_ENV=development tsx watch src/index.ts`, matching the Vite proxy target. `scripts/screenshot-configs/supabase-dashboard.json` still declares `"backendPort": 3000`, which nothing binds.
- **`dev:server2` / `dev:server3` are no-ops:** written as `PORT=3002 npm run dev`, but `dev` itself begins with `PORT=3001`, so the inner assignment wins and all three land on 3001. Shared defect with retool and salesforce, which use the same backend scaffold.
- **Port 5433 is load-bearing:** the seeded projects hardcode `localhost:5433`, so remapping the target container breaks all three seeded projects' connections.
- **CI:** the repo-wide smoke-test workflow was removed — a runner can't provide two Postgres instances plus Valkey. Verification is local (`npm run triage supabase-dashboard`).

- **2026-08-07 (screenshots + answer doc):** the project had only 2 screenshots — the login page and the project list — so nothing showed the features the design is actually about. Added the table editor (real `information_schema` introspection against the target database on 5433), the SQL editor, auth users, and project settings → 6 screenshots.
- **Correction to an earlier note in this file:** the entry claiming `scripts/screenshot-configs/supabase-dashboard.json` declares `"backendPort": 3000, which nothing binds` is **stale** — the config has no `backendPort` key at all, and the harness's `resolveBackendPort` parses `PORT=3001` out of the backend `dev` script. No fix was needed.
- **2026-08-07 (answer doc):** `system-design-answer-fullstack.md` was 251 lines, under the repo's 350–550 band. The content was dense and accurate rather than shallow, so rather than pad it, added the deep dive the file was actually missing: **executing arbitrary user SQL is the product**, which inverts the usual security posture. It covers why parameterization has nothing to bind here (the user supplies the code, not just the data), why the boundary is the *connection* rather than the statement, the four controls that carry the model, and what is deliberately accepted — including that the credential-storage weakness (decision 5's cleartext `db_password`) is a bigger risk than the SQL editor everyone worries about first, and that SSRF matters mainly because "add a project" and "run SQL" compose into an interactive client for internal hosts.

## Open Questions

1. UPDATE and DELETE on table rows build SQL by manual quote-escaping while INSERT parameterizes properly. Converting the other two is straightforward — but the `WHERE` clause needs the primary key *column* (an identifier, so it must be quoted) and its *value* (parameterizable). Is a helper that makes that split explicit worth building, given it's the exact confusion the bug came from?
2. `projects.db_password` is cleartext. Encrypting at rest requires a key that lives outside the metadata database — environment variable, KMS, or operator-supplied at boot. Which is honest for a local-first learning project, versus just moving the plaintext somewhere less obvious?
3. `auth_users` is stored in the metadata database, so it models Supabase's auth surface without its actual placement. Would moving it into the target database (creating an `auth` schema on connect) be a more faithful model, or would provisioning schemas inside a user's database overstep what a dashboard should do uninvited?
4. Schema introspection re-queries `information_schema` on every request with no caching, while DDL operations change the schema underneath. Is a per-project cache with explicit invalidation on DDL worth it, or does the staleness risk outweigh the query cost at this scale?
5. The SQL editor takes one statement per request. Supporting semicolon-separated batches raises a real question — should they run in a transaction (so a failure rolls back the lot) or sequentially (so partial success is visible)? Different tools answer this differently and neither is obviously right.

## Resources

- [PostgreSQL information_schema](https://www.postgresql.org/docs/current/information-schema.html) — the introspection queries in `schemaIntrospector.ts`
- [PostgreSQL SQL syntax: identifiers and key words](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) — quoting rules behind decision 4
- [node-postgres pooling](https://node-postgres.com/features/pooling) — `pg.Pool` lifecycle and the error-eviction pattern
- [Supabase: architecture](https://supabase.com/docs/guides/getting-started/architecture) — the per-project-Postgres model this mirrors
- [OWASP SQL injection prevention cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html) — specifically its section on why identifiers can't be parameterized

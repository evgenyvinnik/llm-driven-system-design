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
| **Valkey (Redis)** | 6379 | `express-session` store via `connect-redis`. Rate limits use the in-memory store (`rate-limit-redis` is a dependency but not wired), so they are per process |
| **Frontend** (Vite) | 5173 | Proxies `/api` → `localhost:3001` |

Services in `backend/src/services/`:
- `projectAccess.ts`: the owner/editor/viewer policy every project route calls.
- `projectService.ts`: validated project create and update; encrypts the password and evicts the pool.
- `queryExecutor.ts`: per-project `pg.Pool` cache (max 5, 60s idle, keyed by a settings fingerprint), the metadata-server guard, a per-project circuit breaker, and the user-SQL envelope.
- `schemaIntrospector.ts`: `information_schema` queries plus `pg_class.reltuples` and `pg_indexes`, run on a pooled client.
- `sqlIdentifiers.ts` (`quoteIdent`, `newIdentifier`, `qualifiedTable`) and `ddlGenerator.ts`.
- `credentials.ts`: AES-256-GCM for `db_password`.
- Also `errors.ts`, `authUserService.ts`, `db.ts`, `redis.ts`, `rateLimiter.ts`, `circuitBreaker.ts`, `metrics.ts`, `logger.ts`.

Routes: `auth`, `users`, `projects`, `tables`, `tableData`, `sql`, `authUsers`, `settings`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind, dark-themed. The route tree nests under `project.$projectId.*` — `index` (redirect), `tables`, `tables_.$tableName`, `sql`, `auth`, `settings` — the layout renders children only once the project and the caller's role are loaded (or "Project not found"), with `TableList`/`TableBrowser`/`SchemaViewer`/`ColumnEditor`/`CreateTableModal` for the table editor, `SQLEditor` + `QueryResults` + `SavedQueryList` for the SQL pane, `AuthUserList`/`AuthUserForm` for user management, and `ProjectMembers` on the settings page. `useProjectRole()` hides controls the caller's role can't use (cosmetic only; the server enforces).

## Key Design Decisions

### 1. Two separate database instances, not two schemas in one

Compose runs two Postgres containers. The metadata DB is reached through the module-level `pool` in `services/db.ts`; the target DB only ever through `queryExecutor.withTargetClient(projectId, config, fn)` (and the `executeQuery`/`executeUserSql` wrappers over it).

Putting both in one instance under different schemas would be far easier to run and would destroy the property the project exists to demonstrate. If the user's tables live in the same server as `users` and `projects`, then the SQL editor — which by design runs arbitrary SQL — can read the platform's own tables. A curious user types `SELECT * FROM users` and gets every dashboard account's password hash; `SELECT * FROM projects` hands them every other tenant's database credentials in plaintext. Schema-level `GRANT`s could theoretically contain that, but they'd be one misconfigured role away from full exposure, and the SQL editor's whole job is to let people run things you didn't anticipate.

Separate instances make the isolation structural: the target pool cannot see `supabase_meta`, because it's a different server on a different port with different credentials. This also mirrors what real Supabase does — each project gets its own Postgres — and it's why `db_host` and `db_port` are per-project columns rather than global config.

Topology alone turned out not to be enough, though, because *users choose the host*. Until 2026-11 any user could create a project at `localhost:5432` with the repo's default metadata credentials, and the SQL editor would read every password hash and every tenant's connection settings. The isolation is now enforced: the first connection of each new pool compares `pg_postmaster_start_time()` with the metadata server's and refuses a match. That catches aliases a host:port comparison can't (a LAN IP, another hostname, another database on the same server), and a save-time check rejects the obvious `localhost:5432` with a clear 400.

The cost is operational: two containers, two sets of credentials, and every route handler must consciously pick a database. Every project route now starts with `requireProject(req, need)`, which checks the caller's role and returns the decrypted connection config. "Who may" and "which database" are one explicit first step.

### 2. Connection pools are cached per project, created lazily, evicted on error

`getTargetPool` keeps a `Map<projectId, entry>` with `max: 5` and `idleTimeoutMillis: 60000`. An entry is reused only while a SHA-256 fingerprint of its connection settings still matches. A `pool.on('error')` handler retires the pool, but only if it is still the registered entry.

Connecting per query is the naive version and it fails on someone else's infrastructure, which makes it worse than a normal performance bug. Each new `pg.Client` costs a TCP handshake, TLS, auth, and a forked backend process on the *target* server. A table browser paginating through rows, a schema viewer refreshing, and a SQL editor running a query would each open and discard connections in bursts; against a customer database with the default `max_connections` of ~100, a few simultaneous users exhaust it — and the outage appears in their production system, caused by our dashboard. Capping at 5 per project bounds our blast radius on a database we don't own.

Keying by settings fingerprint matters as much as caching. With a bare project-ID key, `PUT /projects/:id` (which never evicted) left every later query on the old host with the old password, and a settings change on one API instance never reached the others. A fingerprint mismatch now rebuilds the pool wherever the next query lands.

Eviction on error is the half that's easy to omit and painful to debug without. A cached pool whose target restarted is permanently poisoned: every subsequent query for that project fails until the API process is bounced, and the error message ("Connection terminated") gives no hint that the fix is server-side. Dropping the pool on error means the next request transparently rebuilds it. The identity check matters: a pool emits one error per dead idle client, and the old handler's second error deleted the *replacement* pool (leaking it) and drove the gauge negative.

What we give up: pools are per-process and closed proactively only when a project's settings change or it is deleted, so N projects × M API instances is the real connection ceiling, and there's no LRU — a dashboard with hundreds of projects would hold hundreds of idle pools until the 60s timeouts drain them.

### 3. Introspection reads `information_schema`, with `pg_catalog` only where it must

`introspectTables` queries `information_schema.tables` and `.columns`, joining `table_constraints` → `key_column_usage` (and `constraint_column_usage` for FK targets) to detect primary and foreign keys. It drops to `pg_class.reltuples` for row estimates and `pg_indexes` for index definitions.

`pg_catalog` would answer all of this in fewer joins, and it's what tools like psql actually use. The reason to prefer `information_schema` is that it's the SQL standard's own metadata view: the queries are portable, the column names are self-describing (`is_nullable`, `data_type`, `column_default`), and the output needs almost no translation before it reaches the UI. `pg_catalog` trades that for OID joins and `pg_attribute.attnum` arithmetic — faster and more capable, but Postgres-specific and much harder to read six months later.

The two exceptions prove the rule: `information_schema` has no row count and no index definitions, so those come from `pg_class` and `pg_indexes`. Using `reltuples` rather than `COUNT(*)` is itself the right call — an exact count on a large table is a full scan, and a dashboard showing "≈ 12,400 rows" instantly is more useful than one that hangs for thirty seconds to be precise.

The trade-off is that `reltuples` is an *estimate* maintained by autovacuum, so a freshly-loaded table reports `-1` until it's analyzed. The seeded tables never reach autovacuum's threshold, so this was every table on first launch, shown as "~0 rows". The API now returns `null` for `-1`, and the UI says "row count not estimated yet (run ANALYZE)". A stale estimate is still shown as-is.

### 4. DDL is generated from structured input, and identifiers are quoted rather than parameterized

`ddlGenerator` builds `CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` from typed `ColumnDef` objects. Every identifier goes through `sqlIdentifiers.ts`, which always wraps it in double quotes (doubling embedded quotes) and schema-qualifies tables as `"public"."name"`.

This is the decision people most often get wrong, so it's worth stating precisely why parameterization isn't available here. Prepared-statement placeholders bind *values*: `WHERE id = $1` works because the planner knows a literal goes there. You cannot write `CREATE TABLE $1 (...)` — an identifier is part of the statement's structure, so the parser needs it before planning. There is no `$N` for table names, in any driver, ever. That leaves quoting as the only correct mechanism, and it has to be right: an unquoted, unfiltered identifier is a direct injection vector, since `users; DROP TABLE accounts; --` as a "column name" is just more SQL.

Generating DDL from structured `ColumnDef` input rather than accepting a raw DDL string is the other half — it means the type, nullability, and default each arrive in a known slot and can be validated independently, instead of being parsed back out of a string the user wrote.

Two policies, because there are two kinds of names. Names of objects the forms *create* must match `[A-Za-z_][A-Za-z0-9_]*`, and an invalid name is a 400, not a silent rename. Names of objects that *already exist* are quoted exactly as given, because a table created in the SQL editor may legitimately be called `Order Items`. The previous `sanitizeIdentifier` stripped characters, so it addressed a different object than the user named, and it quoted only names on a ~50-word keyword list.

The type and default slots are validated too. They used to be spliced in raw, so `INT); DROP TABLE customers; --` as a type ran as a second statement. Types must now look like a type name, and defaults must be a literal or a zero-argument call. Generated statements go out through the extended protocol, which refuses to split into several commands.

### 5. Session auth in Redis, because this app holds other databases' credentials

`express-session` + `connect-redis`, with the metadata `projects` table storing per-project `db_host`/`db_port`/`db_name`/`db_user`/`db_password`.

The generic case for server-side sessions (instant revocation, no refresh dance) applies, but the specific reason is what a compromised session grants: not just access to this dashboard, but a SQL editor pointed at every database the user's projects are configured for. "The JWT expires in fifteen minutes" is not an acceptable containment story when the fifteen minutes include `DROP DATABASE`. Session deletion is immediate and unconditional.

The corresponding weakness is right next to it: `projects.db_password` holds credentials for databases we don't own. It is now AES-256-GCM ciphertext (`enc:v1:...`), keyed from `TARGET_CREDENTIALS_KEY`, which lives in the environment, not the database. A dump, a backup or a SQL path into the metadata DB yields ciphertext. Plaintext rows (the seed) are encrypted at startup with a compare-and-set update. The API has never returned the password, and settings saves treat a blank password as "keep". The honest limit: the dev fallback key is in the source, so locally this demonstrates the mechanism rather than protecting anything.

### 6. Roles are enforced in one place, and viewers get read-only SQL, not no SQL

The schema and seed had owner/editor/viewer roles from the start, but nothing read them. Any signed-in user could introspect, edit rows, run DDL or arbitrary SQL, read and change saved queries and auth users, and add themselves as owner of any project. `projectAccess.ts` now answers every route's question: viewers read, editors write, owners administer. The creator is always an owner. Non-members get 404, so IDs can't be probed.

Viewers can still use the SQL editor: their statement runs inside `BEGIN READ ONLY` after a `SELECT 1`, and Postgres itself refuses writes and DDL. That is the right shape for a reporting sandbox, and it avoids parsing SQL. It is a guard, not a privilege boundary: with superuser credentials, server-side functions still work. Real isolation is a read-only database role per project.

### 7. User SQL runs in a fixed envelope

Each SQL-editor request runs exactly one statement (extended protocol), with a 30s `statement_timeout`, through a cursor that reads at most 1000 rows (`truncated: true` beyond). Before the connection returns to the pool, the executor runs `ROLLBACK` if needed and then `DISCARD ALL`.

The old executor used the simple protocol on a shared pool. A batch ran in full and then crashed while building the response, so the user saw an error after the side effects had happened. A lone `BEGIN`, a `SET statement_timeout = 0` or an advisory lock stayed on the pooled connection for whoever got it next. Multi-statement work now goes in a `DO` block, which is atomic, and transactions explicitly cannot span requests (a dangling `BEGIN` is rolled back with a 400).

## Current State

Runs with `docker-compose up -d` (three containers: metadata Postgres on 5432, target Postgres on 5433, Valkey), then `npm run db:migrate` in `backend/`, then `npm run dev` (API on 3001). Implemented: session auth with bcrypt (session regenerated on login), project CRUD with per-project connection config and a connection test, project members with enforced owner/editor/viewer roles and a members panel, schema introspection (tables, columns, types, nullability, defaults, PK/FK detection, row estimates, index listing), the DDL generator wired to create/alter/drop tables and columns, a table data browser with pagination, sorting, inline edit, insert and delete (bound values, real-PK addressing), a single-statement SQL editor with row cap, timeout, viewer read-only mode and saved queries per project, a per-project circuit breaker, the metadata-server guard, encrypted target credentials, simulated auth-user management (create/edit/delete with bcrypt-hashed passwords and `raw_user_metadata` JSONB), project settings, Prometheus metrics (HTTP by route template, query duration, `activeConnections` gauge), pino/pino-http logging, in-memory rate limiting with a per-user `queryLimiter` on execution, and `/api/health`. 65 vitest tests (policy matrix, executor, DDL, credentials, route-level authorization).

Seeded logins (all `password123`): `alice` owns both Storefront projects and is a viewer on Analytics Sandbox; `bob` owns Analytics Sandbox and is an editor on Storefront Production; `carol` belongs to no project. Three projects are seeded, all pointed at the same `sample_db` on 5433, plus saved queries written against that sample schema (`products`, `customers`, `orders`, `order_items`) so the SQL editor and table browser have real tables to work with on first launch.

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

- **2026-11-02 (security and correctness pass):** the project was not a trustworthy reference for its own architecture. What was broken, and the fix:
  - *Authorization was missing.* The tables, table-data, SQL, saved-query and auth-user routes looked a project up by ID with no membership check. Any signed-in user could introspect, edit rows, run DDL or SQL, and read or change saved queries and auth users on any project. `POST /members` had no check at all, so anyone could add themselves as owner. Settings checked only `created_by`, so the seeded roles were ignored. Fix: `projectAccess.ts` (decision 6), 404 for non-members, 403 for low roles.
  - *The metadata DB was reachable.* Project host/port were free-form, so `localhost:5432` with the default credentials exposed every hash and credential. Credentials were also interpolated into a URL, so a password with `@` or `/` could redirect the host. Fix: server-identity guard plus a save-time check, and discrete connection fields (decision 1).
  - *Row CRUD hand-escaped values.* The note above that "INSERT parameterizes properly" was wrong: INSERT, UPDATE and DELETE all used quote-doubling with stripped, unquoted identifiers. A JSON `null` was stored as the string `'null'`, and the client chose the key column, so a non-unique key mass-updated. Fix: bound values, quoted identifiers, the table's real single-column PK, and 404/400 for unknown tables and columns.
  - *The DDL type and default slots were spliced raw, and identifiers were silently renamed* (decision 4).
  - *The SQL editor had no timeout or row cap* and leaked session state across pooled requests. A batch ran fully and then reported an error (decision 7).
  - *Stale pools:* keyed by project ID only, `PUT /projects/:id` never evicted, and the error handler could evict the replacement pool (decision 2).
  - *The circuit breaker existed but was never called.* It is now per project and counts only connection-level failures.
  - *Credentials were plaintext* (decision 5).
  - *Smaller fixes:* login didn't regenerate the session; user search returned every account's email; HTTP metrics were defined but never recorded; the query-type label was unbounded user input; the query limiter was keyed by IP; `dev:server2/3` all bound 3001 (the `dev` script hard-coded `PORT=3001`; it now inherits `PORT`, default 3001); `reltuples` showed unanalyzed tables as "~0 rows"; backend lint skipped `src/*.ts` (unquoted glob).
  - *Frontend:* there was no ESLint config, so lint crashed. The members API was never called; there is now a `ProjectMembers` panel. Write errors were swallowed. Viewers saw write controls. There was no not-found state (an outsider saw an empty table list). Path segments weren't URL-encoded. JSON cells rendered as `[object Object]`. `tsc -b` wrote `vite.config.js` beside `vite.config.ts`, and Vite loads the `.js` first, so a stale compiled config would win.
  - *Seed:* added `carol` (in no project) and a write query on Analytics Sandbox for the viewer screenshot.
  - *Verification:* 65 unit tests, 107 live checks across alice/bob/carol run twice from a clean `down -v` reset, 9 screenshots (new: viewer read-only SQL, members panel, outsider not-found), 9 smoke tests. The live checks covered: 404 on 12 routes for an outsider; the metadata DB refused via `localhost:5432` and via a LAN-IP alias, including another database on that server; the circuit opening after 3 refusals and failing in under 500ms; typos never opening it; viewer UPDATE, DROP and `SET TRANSACTION READ WRITE` refused; a 5000-row SELECT capped at 1000; `SET` not leaking across six pooled runs; `pg_sleep(40)` cut off at 30s; quote-laden SQL text stored verbatim; tables named `order` with a `user` column working; a password change via `PUT /projects/:id` effective at once.

## Open Questions

1. *(Answered 2026-11.)* Row edits now quote the PK column with `quoteIdent` and bind its value. The server looks the PK up itself instead of taking it from the client, which removed the confusion entirely.
2. *(Answered 2026-11.)* The key comes from the environment (`TARGET_CREDENTIALS_KEY`). Locally the fallback key is in the source, which is honest about being a demonstration. The next step would be KMS envelope encryption.
3. `auth_users` is stored in the metadata database, so it models Supabase's auth surface without its actual placement. Would moving it into the target database (creating an `auth` schema on connect) be a more faithful model, or would provisioning schemas inside a user's database overstep what a dashboard should do uninvited?
4. Schema introspection re-queries `information_schema` on every request with no caching, while DDL operations change the schema underneath. Is a per-project cache with explicit invalidation on DDL worth it, or does the staleness risk outweigh the query cost at this scale?
5. *(Answered 2026-11.)* One statement per request is now enforced, not assumed. Batches get a 400 pointing at `DO` blocks, which are atomic. Supporting scripts properly would mean a session that outlives a request (a dedicated connection per editor tab), which conflicts with pooling.
6. Viewer read-only mode is a transaction guard on shared credentials. Should projects carry a second, read-only database role for viewers? That would make it a real boundary, at the cost of asking users for two sets of credentials.
7. SSRF beyond the metadata server is unaddressed: projects can point at any host this machine can reach. A private-range denylist would break the local setup (targets are on localhost). Egress segmentation is the production answer. Is there a local-friendly middle ground, such as an allowlist from the environment?
8. A full pool's wait timeout ("timeout exceeded when trying to connect") counts as a breaker failure, so five 30-second queries can open a busy project's circuit. Should pool exhaustion be classified separately from an unreachable target?

## Resources

- [PostgreSQL information_schema](https://www.postgresql.org/docs/current/information-schema.html) — the introspection queries in `schemaIntrospector.ts`
- [PostgreSQL SQL syntax: identifiers and key words](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) — quoting rules behind decision 4
- [node-postgres pooling](https://node-postgres.com/features/pooling) — `pg.Pool` lifecycle and the error-eviction pattern
- [Supabase: architecture](https://supabase.com/docs/guides/getting-started/architecture) — the per-project-Postgres model this mirrors
- [OWASP SQL injection prevention cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html) — specifically its section on why identifiers can't be parameterized

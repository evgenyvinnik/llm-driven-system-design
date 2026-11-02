# Supabase Dashboard - Architecture

## System Overview

A Backend-as-a-Service (BaaS) management dashboard inspired by Supabase Studio. The system enables developers to introspect database schemas, execute SQL queries, manage table structures through DDL generation, and administer authentication users -- all through a web-based dark-themed interface. The core architectural challenge is the **two-database model**: a metadata database stores dashboard state (users, projects, saved queries) while dynamic connections to target databases enable real-time schema introspection and query execution.

**Learning goals:** Multi-database connection management, dynamic schema introspection via `information_schema`, DDL generation from structured inputs, SQL execution sandboxing, simulated auth user management.

## Requirements

### Functional Requirements

1. **Project Management** - Create, configure, and manage database projects with per-project connection settings
2. **Schema Introspection** - Dynamically discover tables, columns, types, constraints, and indexes from target databases
3. **Table Data Browsing** - Paginated, sortable, spreadsheet-like viewing with inline editing and row insert/delete
4. **SQL Editor** - Execute arbitrary SQL against target databases with result display, save and reuse queries
5. **DDL Generation** - Create, alter, and drop tables through structured UI forms rather than raw SQL
6. **Auth User Management** - CRUD operations for simulated Supabase authentication users
7. **Connection Testing** - Verify target database connectivity with live status indicators

### Non-Functional Requirements

| Requirement | Target (Production) |
|-------------|-------------------|
| API latency (p99) | < 200ms for metadata, < 2s for SQL queries |
| Schema introspection | < 500ms for databases with 100 tables |
| Concurrent projects | 10,000+ per instance with connection pooling |
| Availability | 99.9% for metadata, best-effort for target connections |
| SQL query timeout | 30 seconds max execution time |
| Connection pool limit | 5 connections per project, 1000 total per instance |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Client Browser                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │  Table    │  │   SQL    │  │   Auth   │  │ Settings │             │
│  │  Editor   │  │  Editor  │  │  Users   │  │          │             │
│  └─────┬────┘  └─────┬────┘  └────┬─────┘  └────┬─────┘             │
│        └──────────────┴────────────┴──────────────┘                  │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ HTTPS
                     ┌──────┴──────┐
                     │   CDN /     │
                     │   CloudFront│
                     └──────┬──────┘
                            │
                     ┌──────┴──────┐
                     │  API Gateway│
                     │  / Nginx LB │
                     └──────┬──────┘
                            │
               ┌────────────┼────────────┐
               │            │            │
         ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
         │  API       │ │  API  │ │  API       │
         │  Server 1  │ │  S 2  │ │  Server 3  │
         └─────┬─────┘ └───┬───┘ └─────┬─────┘
               │            │            │
     ┌─────────┴────────────┴────────────┴──────────┐
     │                                               │
     │  ┌────────────┐  ┌────────────┐  ┌──────────┐│
     │  │  Schema    │  │   Query    │  │   DDL    ││
     │  │  Intro-    │  │   Executor │  │   Gene-  ││
     │  │  spector   │  │            │  │   rator  ││
     │  └─────┬──────┘  └─────┬──────┘  └────┬─────┘│
     │        │               │               │      │
     │  ┌─────┴───────────────┴───────────────┴────┐ │
     │  │      Dynamic Connection Pool Manager     │ │
     │  │   (per-project pools, LRU eviction)      │ │
     │  └─────┬────────────────────────────┬───────┘ │
     │        │                            │         │
     │  ┌─────┴────────┐   ┌──────────────┴───────┐ │
     │  │  PgBouncer   │   │     PgBouncer        │ │
     │  │  (Metadata)  │   │   (Target DBs)       │ │
     │  └─────┬────────┘   └──────────────┬───────┘ │
     │        │                            │         │
     │  ┌─────┴────────┐   ┌──────────────┴───────┐ │
     │  │  Metadata DB │   │   Target Databases   │ │
     │  │  (PG Primary │   │   (User-managed,     │ │
     │  │   + Replica) │   │    per-project)      │ │
     │  └──────────────┘   └──────────────────────┘ │
     │                                               │
     │  ┌──────────────┐   ┌──────────────────────┐ │
     │  │   Redis      │   │   Prometheus +       │ │
     │  │   Cluster    │   │   Grafana            │ │
     │  │   (Sessions, │   └──────────────────────┘ │
     │  │    Cache)    │                             │
     │  └──────────────┘                             │
     └───────────────────────────────────────────────┘
```

## Core Components

### Schema Introspector

Queries `information_schema` views on the target database to discover:
- **Tables**: `information_schema.tables` filtered to `public` schema, `BASE TABLE` type
- **Columns**: `information_schema.columns` for name, type, nullable, default, ordinal position
- **Primary Keys**: Join `table_constraints` (type = `PRIMARY KEY`) with `key_column_usage`
- **Foreign Keys**: Join `table_constraints` (type = `FOREIGN KEY`) with `key_column_usage` and `constraint_column_usage`
- **Row Estimates**: `pg_class.reltuples` for approximate row counts without `COUNT(*)`

Introspection runs on a connection checked out from the project's pool, so it shares the 5-connection cap, the circuit breaker and the metadata-server guard with every other target query. A pooled connection sees committed DDL immediately (catalog caches are invalidated on commit), so a dedicated connection per request bought nothing but an extra connection outside the cap. `reltuples` is `-1` until a table is first analyzed; the API reports that as `null` ("not estimated yet") rather than a false 0. At production scale, introspection results would be cached in Redis with a 60-second TTL and invalidated on DDL operations.

### Query Executor (Dynamic Pool Manager)

Every query against a target database goes through `withTargetClient(projectId, config, fn)`, which owns four guarantees:

1. **Pools keyed by project and settings.** The map key is the project ID, but an entry is reused only while a SHA-256 fingerprint of host/port/database/user/password matches. A settings change from any route, on any API instance, therefore builds a fresh pool instead of reusing one aimed at the old database. Pools connect with discrete fields, never a URL, so a password containing `@` or `/` cannot rewrite the host.
2. **The target is never the metadata server.** The first connection of every new pool compares `pg_postmaster_start_time()` (an identity of the running server, readable by any role) with the metadata server's. A match refuses the pool and drops it. A save-time check also rejects the obvious `localhost:5432`.
3. **A per-project circuit breaker** counts only "target unusable" failures (network errors, SQLSTATE classes 08/28, 3D000, 53300, 57P0x). Syntax errors and constraint violations are filtered out, so a user's typos never mark a healthy database as down.
4. **User SQL runs in a fixed envelope**: one statement per request, a 30s `statement_timeout`, at most 1000 rows read through a cursor, `BEGIN READ ONLY` for viewers, and `ROLLBACK` if needed followed by `DISCARD ALL` before the connection returns to the pool.

At production scale, this becomes a tiered system: hot projects (queried in last 5 minutes) get persistent pools, warm projects get on-demand connections through PgBouncer, and cold projects require a full connection setup. An LRU eviction strategy caps total pools at 200 per API server instance.

```typescript
// Pool lookup (from src/services/queryExecutor.ts)
function getPoolEntry(projectId: string, config: ConnectionConfig): PoolEntry {
  const fingerprint = fingerprintOf(config);
  const existing = targetPools.get(projectId);
  if (existing && existing.fingerprint === fingerprint) return existing;
  if (existing) retirePool(projectId, existing); // settings changed somewhere

  const pool = new pg.Pool({ ...connectionOptions(config), max: 5, statement_timeout: 30_000 });
  pool.on('error', () => retirePool(projectId, entry)); // no-op if already replaced
  const entry = { pool, fingerprint, verified: null };   // verified = metadata-server check
  targetPools.set(projectId, entry);
  return entry;
}
```

### Project Access Policy

`src/services/projectAccess.ts` is the one place that decides who may do what in a project. Every project route calls `requireProject(req, 'view' | 'edit' | 'own')` before it touches either database.

| Action | viewer | editor | owner |
|--------|--------|--------|-------|
| See project, schema, rows, saved queries, auth users, settings (no password) | yes | yes | yes |
| Run SQL | read-only | yes | yes |
| DDL, row writes, saved-query and auth-user changes | no | yes | yes |
| Change connection settings, delete project, manage members | no | no | yes |

The creator is always an owner. Callers with no role get 404, not 403, so project IDs cannot be probed. A global `users.role = 'admin'` grants nothing here, because membership is what puts a SQL editor in front of a tenant's database.

### DDL Generator

Produces SQL DDL statements from structured inputs, validating each slot for what it may contain:

- `generateCreateTable(name, columns[])` -- Builds `CREATE TABLE` with types, constraints, references
- `generateAddColumn(table, column)` -- `ALTER TABLE ADD COLUMN`
- `generateDropColumn(table, columnName)` -- `ALTER TABLE DROP COLUMN`
- `generateRenameColumn(table, old, new)` -- `ALTER TABLE RENAME COLUMN`
- `generateDropTable(name)` -- `DROP TABLE CASCADE`

Identifiers are always double-quoted (embedded quotes doubled) and schema-qualified as `"public"."name"`, so reserved words and mixed case need no keyword list (`src/services/sqlIdentifiers.ts`). Names for new objects must match `[A-Za-z_][A-Za-z0-9_]*` and are rejected rather than silently renamed. Existing names are quoted as given. Types must look like a type name (`VARCHAR(255)`, `DOUBLE PRECISION`, `TEXT[]`). Defaults must be a literal or a zero-argument call (`now()`). A composite primary key becomes one table-level constraint. Generated statements are sent with `queryMode: 'extended'`, which Postgres refuses to split into several commands.

### Auth User Service

Manages simulated Supabase auth users in the metadata database (not the target database). Maps to the `auth_users` table with:

- Email + encrypted password (bcrypt)
- Role (`authenticated`, `anon`, `service_role`)
- Email confirmation status
- JSONB metadata for arbitrary user attributes

In production Supabase, this would be the GoTrue authentication service with JWT issuance, OAuth providers, and row-level security policy enforcement.

## Database Schema

### Metadata Database (supabase_meta)

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  db_host VARCHAR(255) NOT NULL DEFAULT 'localhost',
  db_port INTEGER NOT NULL DEFAULT 5433,
  db_name VARCHAR(100) NOT NULL DEFAULT 'sample_db',
  db_user VARCHAR(100) NOT NULL DEFAULT 'sample',
  db_password TEXT NOT NULL,          -- AES-256-GCM ciphertext "enc:v1:<iv>:<tag>:<ct>"
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

CREATE TABLE saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(100) NOT NULL,
  query_text TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE auth_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  email VARCHAR(255) NOT NULL,
  encrypted_password VARCHAR(255),
  email_confirmed BOOLEAN DEFAULT false,
  role VARCHAR(50) DEFAULT 'authenticated',
  raw_user_metadata JSONB DEFAULT '{}',
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, email)
);

CREATE INDEX idx_project_members ON project_members(user_id);
CREATE INDEX idx_saved_queries_project ON saved_queries(project_id);
CREATE INDEX idx_auth_users_project ON auth_users(project_id);
CREATE INDEX idx_auth_users_email ON auth_users(project_id, email);
```

### Target Database (sample_db)

A sample e-commerce schema with seeded data for immediate introspection:

```sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  stock INTEGER DEFAULT 0,
  category VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE customers (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255) UNIQUE, created_at TIMESTAMPTZ);
CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), status VARCHAR(20), total_cents INTEGER, created_at TIMESTAMPTZ);
CREATE TABLE order_items (id SERIAL PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id), quantity INTEGER, price_cents INTEGER);
```

## API Design

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new dashboard user |
| POST | `/api/auth/login` | Login with username/password |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Get current user |

### Projects

The last column is the minimum project role (see Project Access Policy). No response ever includes `db_password`.

| Method | Endpoint | Description | Role |
|--------|----------|-------------|------|
| GET | `/api/projects` | List the caller's projects with `memberRole` | — |
| GET | `/api/projects/:id` | Get project details and the caller's `memberRole` | viewer |
| POST | `/api/projects` | Create project with DB config; creator becomes owner | — |
| PUT | `/api/projects/:id` | Update project (same path as settings: validated, encrypted, pool evicted) | owner |
| DELETE | `/api/projects/:id` | Delete project and close its pool | owner |
| POST | `/api/projects/:id/test-connection` | Test target DB connectivity (refuses the metadata server) | viewer |
| GET | `/api/projects/:id/members` | List project members | viewer |
| POST | `/api/projects/:id/members` | Add a member or change a role: `{ userId \| username, role }` | owner |
| DELETE | `/api/projects/:id/members/:userId` | Remove a member (any member may remove themselves; never the creator) | owner |

### Schema (Tables)

Reads need viewer; writes need editor.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:projectId/tables` | Introspect all tables |
| POST | `/api/projects/:projectId/tables` | Create table (DDL) |
| PUT | `/api/projects/:projectId/tables/:name` | Alter table (add/drop/rename column) |
| DELETE | `/api/projects/:projectId/tables/:name` | Drop table |

### Table Data

Reads need viewer; writes need editor. The table must be a base table in `public` (404 otherwise), columns must exist (400 otherwise), and `:id` is matched against the table's own single-column primary key. Tables with no primary key or a composite one are edited from the SQL editor (400).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:pid/tables/:name/rows` | Paginated row fetch (`page`, `limit` ≤ 200, `sortBy`, `sortOrder`) |
| POST | `/api/projects/:pid/tables/:name/rows` | Insert row (`{ data }`, empty data → `DEFAULT VALUES`) |
| PUT | `/api/projects/:pid/tables/:name/rows/:id` | Update row (`{ data }`) |
| DELETE | `/api/projects/:pid/tables/:name/rows/:id` | Delete row |

### SQL Editor

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/projects/:projectId/sql/execute` | Execute one statement → `{ rows, fields, rowCount, command, truncated, readOnly }` (viewers: read-only) |
| GET | `/api/projects/:projectId/sql/saved` | List saved queries |
| POST | `/api/projects/:projectId/sql/saved` | Save query |
| PUT | `/api/projects/:projectId/sql/saved/:id` | Update saved query |
| DELETE | `/api/projects/:projectId/sql/saved/:id` | Delete saved query |

### Auth Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:projectId/auth-users` | List auth users |
| POST | `/api/projects/:projectId/auth-users` | Create auth user |
| PUT | `/api/projects/:projectId/auth-users/:id` | Update auth user |
| DELETE | `/api/projects/:projectId/auth-users/:id` | Delete auth user |

### Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:projectId/settings` | Get project settings, password excluded (viewer) |
| PUT | `/api/projects/:projectId/settings` | Update settings; blank password keeps the current one (owner) |

## Key Design Decisions

### Two-Database Architecture

**Chosen:** Separate metadata and target databases on different PostgreSQL instances.

**Why:** The metadata database (users, projects, saved queries) has a fixed, known schema controlled by the dashboard. The target database has an unknown, user-controlled schema that changes through DDL operations. Combining them would mean dashboard migrations could conflict with user tables, and connection credentials would be shared. Separation enables per-project connection isolation, independent scaling, and credential rotation without affecting the dashboard itself.

**Alternative:** Single database with schema separation (`dashboard.*` vs `public.*`). Simpler operationally but breaks down when projects connect to external databases -- the core Supabase use case.

**What makes the separation hold:** separate pools and credentials are not enough on their own, because users choose the host and port of their projects. Nothing stopped a project from being configured as `localhost:5432` with the (public, default) metadata credentials, which turned the SQL editor into a reader for every password hash and tenant credential. The executor now compares the server each new pool reaches with the metadata server (`pg_postmaster_start_time()`) and refuses a match, whatever hostname, alias or database name was used to get there.

### Dynamic Connection Pools vs. Per-Request Connections

**Chosen:** Cached `pg.Pool` instances keyed by project ID, created on first use.

**Why:** Opening a new TCP connection per query adds 50-100ms of latency. With pools, subsequent queries reuse existing connections. The pool is capped at 5 connections per project to prevent a single project from exhausting server resources.

**Trade-off:** Memory usage grows with active projects. At 1000 active projects with 5 connections each, the server holds 5000 database connections. Mitigation: idle timeout (60s) auto-closes unused connections, and a pool is reused only while a fingerprint of its connection settings still matches, so changed settings replace it on every API instance without coordination. At production scale, PgBouncer would sit between API servers and target databases, multiplexing connections and reducing the per-server pool count.

### information_schema vs. pg_catalog

**Chosen:** `information_schema` for schema introspection.

**Why:** `information_schema` provides a SQL-standard interface that produces cleaner, typed results. Column types come as readable strings (`character varying`, `integer`) rather than OIDs. The join pattern for PK/FK detection is well-documented.

**Trade-off:** `pg_catalog` is faster (no view overhead) and exposes PostgreSQL-specific features like custom types, statistics, and storage parameters. For a dashboard that needs human-readable schema information, `information_schema` is the better fit.

### DDL Generation from Structured Inputs

**Chosen:** Server-side DDL generation with identifier sanitization.

**Why:** Letting users type raw `CREATE TABLE` SQL is error-prone and hard to validate. Structured column definitions (name, type, nullable, default, PK) can be validated before SQL generation. Identifiers cannot be bound as `$N` parameters, so they are always double-quoted with embedded quotes doubled; new names are validated and rejected (not rewritten) when invalid; the type and default slots are checked against patterns, so `INT); DROP TABLE x` is a 400, not a second statement.

**Trade-off:** The DDL generator only supports common column types and constraints. Complex PostgreSQL features (partial indexes, generated columns, CHECK constraints, custom types) require the SQL editor. This is an acceptable boundary -- the DDL generator handles 90% of table creation, and the SQL editor handles the rest.

## Consistency and Idempotency

### SQL Execution Safety

Each request runs **one statement** on a pooled connection, sent through the extended protocol, which Postgres refuses to split into several commands. A batch gets a 400 explaining the rule. Multi-statement work runs as a single `DO` block, which is atomic.

Transactions cannot span requests: the next request may get a different pooled connection. A `BEGIN` left open is rolled back and reported as a 400. Before a connection goes back to the pool, the executor runs `ROLLBACK` (if needed) and `DISCARD ALL`. Without that, one user's `SET statement_timeout = 0`, advisory lock, temp table or open transaction would carry over to whichever user got that connection next. The 30s `statement_timeout` is a session default, so it comes back after every reset.

Viewers' statements run inside `BEGIN READ ONLY`, preceded by a `SELECT 1` so the user's statement cannot switch the transaction back with `SET TRANSACTION READ WRITE`. Postgres then refuses writes and DDL. This is a guard, not a privilege boundary: if the project's credentials belong to a superuser, server-side functions (`COPY ... TO PROGRAM`, `dblink`) are still available. Real isolation needs a read-only database role per project.

Results are read through a cursor, 1001 rows at a time: getting the 1001st row means the result was cut off (`truncated: true`), and the rest of a large table is never buffered in the API process. User SQL is never retried, because re-running an INSERT after a timeout could write twice.

### Row edits

Row UPDATE and DELETE address rows by the table's own single-column primary key, looked up from `information_schema`, never by a key column named by the client. A non-unique "id" would otherwise turn a one-row edit into a mass update. Every value is a bound parameter, so a JSON `null` is stored as NULL rather than the string `'null'`.

### Connection Pool Consistency

A pool is reused only while a fingerprint of its connection settings matches the project's current row. A settings change, through either `PUT /projects/:id` or `PUT /projects/:id/settings` and on any API instance, is picked up by the next query without coordination. The route that saved it also closes the old pool and resets the breaker right away. In-flight queries on the old pool complete normally. The update itself locks the project row, so the metadata-server check runs on the settings that will actually be stored.

## Security

### Authentication
- Session-based auth with Valkey (Redis) backing store
- bcrypt password hashing with salt rounds = 10
- Session cookies: httpOnly, sameSite=lax, secure in production
- Rate limiting: 50 auth attempts per 15 minutes
- Login regenerates the session ID (no session fixation)

### Authorization
- One policy module (`src/services/projectAccess.ts`) with owner/editor/viewer roles; every project route calls it before touching either database
- Non-members get 404 (project IDs can't be probed); members whose role is too low get 403
- User search returns usernames and display names only; emails are matched exactly and never returned

### Target Credentials
- `projects.db_password` is AES-256-GCM encrypted at rest, keyed from `TARGET_CREDENTIALS_KEY` (environment, not the database); plaintext rows from the seed are encrypted at startup
- Never included in any API response; a blank password field on save keeps the current one
- Connections use discrete host/port/user/password fields, never an interpolated URL

### SQL Execution Sandboxing
- The project's credentials define what SQL can do. Real isolation needs a least-privilege role per project
- 30s `statement_timeout`, a 1000-row cap, one statement per request, and a session reset after each run
- Viewers run in a READ ONLY transaction
- A target may not be the metadata server; this is checked by server identity on every new pool and in the connection test
- Rate limiting: 100 executions per minute per user

### Identifier Handling
- Every identifier is double-quoted with embedded quotes doubled, and tables are schema-qualified as `"public"."name"`
- New names must match `[A-Za-z_][A-Za-z0-9_]*`; invalid ones are rejected, not rewritten
- Values are always bound parameters; identifiers never are (they can't be)

## Observability

### Metrics (Prometheus via prom-client)
- `http_request_duration_seconds` - Request latency histogram by method/route/status. `route` is the Express template (`/api/projects/:projectId/sql/execute`), so IDs and table names don't each create a series
- `http_requests_total` - Request counter by method/route/status
- `query_execution_duration_seconds` - SQL query latency by project and statement class. The first keyword is user input, so it is bucketed into a fixed set (SELECT, WITH, INSERT, ..., OTHER) to keep the label set bounded
- `active_target_connections` - Gauge of active connection pools

### Structured Logging (Pino)
- JSON log output in production, pretty-printed in development
- Request/response logging via pino-http
- Error context includes project ID, query type, connection details

### Health Check
- `GET /api/health` - Tests metadata database connectivity
- Returns `{ status: 'ok' }` or `503` with `{ status: 'unhealthy' }`

## Failure Handling

### Circuit Breaker (Opossum)
- One breaker per project around every target operation (introspection, row CRUD, DDL, SQL editor)
- Counts only "target unusable" errors: network errors, SQLSTATE classes 08 and 28, 3D000, 53300 and 57P01-03. Statement errors (syntax, constraints, permissions, statement timeout) are filtered out, so they can neither open the circuit nor count against it
- Opens above 50% failures once at least 3 calls are in the window, half-opens after 30 seconds, and has a 35s action timeout (just above the 30s statement timeout) for a target that stops answering
- When open, answers 503 "Target database is unavailable ... circuit breaker" in milliseconds. A successful connection test, or saving new settings, resets it right away

### Connection Failures
- Unreachable or misconfigured targets answer 503 with the driver's message; statement errors answer 400 with Postgres's message and SQLSTATE `code`
- Connection test endpoint (`POST /projects/:id/test-connection`) validates before use
- A pool error retires that pool only if it is still the registered one, so a late error from a replaced pool can't evict (and leak) its successor
- Connections that may still carry state (failed reset, open transaction, connection error) are destroyed rather than returned to the pool

### Graceful Shutdown
- SIGTERM/SIGINT handlers close all target pools before exit
- Active requests complete before shutdown
- Metadata pool and Redis connections closed last

## Scalability Considerations

### Connection Pool Limits
At scale, a single API server cannot maintain pools to thousands of target databases. Solutions:
1. **PgBouncer** - Connection pooler between API servers and target databases, multiplexing thousands of application connections into hundreds of database connections
2. **Pool eviction** - LRU eviction when pool count exceeds threshold (e.g., 200 per instance)
3. **Tiered pooling** - Hot projects get persistent pools, warm projects get on-demand connections, cold projects require full connection setup

### Horizontal Scaling
- API servers are stateless (sessions in Redis) -- add instances behind load balancer
- Each instance maintains its own pool map (no cross-instance coordination needed)
- Schema introspection results can be cached in Redis with 60-second TTL

### Query Execution at Scale
- Statement-level timeout prevents runaway queries
- Per-user rate limiting prevents abuse
- Query result pagination prevents memory exhaustion on large result sets
- At high scale, a dedicated query execution service could isolate SQL workloads from metadata API traffic

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Database architecture | Two separate PostgreSQL instances + server-identity guard | Single DB with schema separation | Isolation only holds if a project can't be pointed back at the metadata server |
| Connection management | Cached pool per project, keyed by settings fingerprint | Per-request connections | Amortized connection cost; config changes take effect on every instance |
| Authorization | One owner/editor/viewer policy module, 404 for non-members | Per-route ad-hoc checks | Every route asks the same question the same way |
| User SQL envelope | One statement, cursor row cap, session reset | Simple-protocol batches | Bounded memory/time; no state leaks between pooled sessions |
| Viewer SQL | READ ONLY transaction | Forbid SQL for viewers | Useful read access; Postgres, not a parser, refuses writes |
| Credential storage | AES-256-GCM, key in environment | Plaintext column | A metadata dump no longer yields every tenant's credentials |
| Schema introspection | information_schema views | pg_catalog system tables | SQL-standard, readable types, portable |
| Identifier handling | Always quote; validate new names, reject invalid | Strip characters / keyword list | No silent renames, no missed reserved words |
| DDL generation | Server-side from structured inputs | Client-side raw SQL only | Validation of every slot, safer for non-expert users |
| Session storage | Valkey + cookie | JWT tokens | Immediate revocation, simpler than token refresh |
| Auth users | Metadata DB table | Target DB auth schema | Simpler, no cross-database writes needed |
| Frontend theme | Dark (Supabase brand) | Light/system preference | Matches Supabase Studio, comfortable for SQL editing |

## Implementation Notes

### Local Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser                                    │
│   React + TanStack Router + Zustand + Tailwind                   │
│   http://localhost:5173 (Vite proxies /api → :3001)               │
└──────────────────────────┬───────────────────────────────────────┘
                           │ fetch (proxied)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Express API Server                                │
│                 http://localhost:3001                              │
│                                                                   │
│  Routes: auth, projects, tables, tableData, sql, authUsers,      │
│          settings, users                                          │
│                                                                   │
│  Services: projectAccess, projectService, queryExecutor,         │
│            schemaIntrospector, ddlGenerator, sqlIdentifiers,     │
│            credentials, authUserService, circuitBreaker,         │
│            metrics, logger, rateLimiter                           │
└──────┬───────────────────────┬─────────────────┬─────────────────┘
       │                       │                 │
       ▼                       ▼                 ▼
┌──────────────┐  ┌────────────────┐  ┌─────────────────┐
│  Metadata DB │  │   Target DB    │  │   Valkey        │
│  PostgreSQL  │  │   PostgreSQL   │  │   (Redis)       │
│  :5432       │  │   :5433        │  │   :6379         │
│              │  │                │  │                 │
│ supabase_meta│  │   sample_db    │  │  Sessions       │
│ (users,      │  │   (products,   │  │                 │
│  projects,   │  │    customers,  │  │                 │
│  saved_      │  │    orders)     │  │                 │
│  queries,    │  │                │  │                 │
│  auth_users) │  │                │  │                 │
└──────────────┘  └────────────────┘  └─────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | File | Why It Matters |
|---------|------|----------------|
| Project authorization | `src/services/projectAccess.ts` | One owner/editor/viewer policy for every project route; non-members get 404. Without it any signed-in user could run SQL on any project. |
| Circuit Breaker (Opossum) | `src/services/circuitBreaker.ts`, `queryExecutor.ts` | One breaker per project; counts only connection-level failures; opens above 50% once 3 calls are in the window, half-opens after 30s. A dead target fails in milliseconds and typos never trip it. |
| Metadata-server guard | `src/services/queryExecutor.ts` | Each new pool compares `pg_postmaster_start_time()` with the metadata server's and refuses a match, catching aliases a host:port check can't. |
| User SQL envelope | `src/services/queryExecutor.ts` | Extended protocol (one statement), 30s `statement_timeout`, 1000-row cursor read, READ ONLY for viewers, `DISCARD ALL` after each run. |
| Dynamic Pool Management | `src/services/queryExecutor.ts` | Pools created on demand, reused only while the settings fingerprint matches, retired on error (identity-checked) or idle timeout. |
| Identifier quoting + bound values | `src/services/sqlIdentifiers.ts`, `routes/tableData.ts` | Every identifier quoted, every value a `$N` parameter, row edits by the table's real primary key. |
| Credential encryption | `src/services/credentials.ts` | AES-256-GCM with the key in `TARGET_CREDENTIALS_KEY`; legacy plaintext rows encrypted at startup. |
| Prometheus Metrics (prom-client) | `src/services/metrics.ts`, `app.ts` | HTTP histogram/counter by route template, query duration by bounded statement class, pool gauge. |
| Structured Logging (Pino) | `src/services/logger.ts` | JSON logs with request context, error details, project IDs. Passwords are never logged. |
| Rate Limiting (express-rate-limit) | `src/services/rateLimiter.ts` | 1000 req/15min API-wide and 50 req/15min auth (per IP); 100 SQL executions/min per user. In-memory store, so limits are per instance. |
| Session Auth (express-session + connect-redis) | `src/routes/auth.ts`, `src/middleware/auth.ts` | Valkey-backed sessions with httpOnly cookies; session ID regenerated on login; immediate revocation on logout. |

### Simplifications

| Production Design | Local Substitute | Why Acceptable |
|-------------------|------------------|----------------|
| Per-project isolated databases | Single target DB on port 5433 | Demonstrates the two-DB pattern; pool manager is keyed by project ID regardless |
| PgBouncer connection pooling | Direct pg.Pool per project | Sufficient for < 10 concurrent projects in development |
| OAuth + GoTrue auth service | Session-based auth in metadata DB | Simulates Supabase auth user management without JWT/OAuth complexity |
| Redis Cluster for sessions | Single Valkey instance | No HA needed for local development |
| CDN for static assets | Vite dev server on :5173 | Hot module replacement is more useful during development |
| CodeMirror/Monaco SQL editor | Basic textarea | Functional for executing SQL; syntax highlighting is cosmetic |
| KMS envelope encryption | AES-256-GCM key from `TARGET_CREDENTIALS_KEY` (dev fallback in code) | Same mechanism; the dev key gives no real protection, which is acceptable locally |
| Scoped read-only DB role for viewers | READ ONLY transaction on the shared target credentials | Postgres refuses ordinary writes; not a boundary against a superuser role |
| Redis-backed shared rate limits | In-memory `express-rate-limit` store | One API process locally; limits would be per instance with several |
| Egress segmentation / private-range denylist | Server-identity guard for the metadata server only | Projects legitimately point at localhost; other internal hosts remain reachable (SSRF, accepted locally) |

### Omitted

- CDN and static asset optimization
- Multi-region deployment and database replication
- Kubernetes orchestration
- PgBouncer connection pooling layer
- Real Supabase GoTrue authentication service
- Row-level security (RLS) policy management
- Realtime subscriptions (Supabase Realtime)
- Edge Functions / serverless function management
- Storage bucket management (Supabase Storage)
- Database backup and restore
- Introspection caching and the batched (non-N+1) introspection queries
- Query cancellation from the UI
- Composite-primary-key and NULL editing in the table grid (routed to the SQL editor)

---

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (root layout)
├── login.tsx (Login page)
├── register.tsx (Register page)
├── index.tsx (Project list - landing page after login)
│   └── ProjectCard (project name, description, connection status)
└── project.$projectId.tsx (Project layout with sidebar; renders children only once the
    │                          project and the caller's role are loaded, or "Project not found")
    ├── project.$projectId.index.tsx (redirects to tables)
    ├── ProjectSidebar (navigation: Tables, SQL, Auth, Settings)
    ├── project.$projectId.tables.tsx (Table list)
    │   ├── TableList (all tables with row counts)
    │   ├── CreateTableModal (structured table creation form)
    │   │   └── ColumnEditor (column name, type, nullable, default, PK toggle)
    │   └── SchemaViewer (columns, types, PK/FK constraints display)
    ├── project.$projectId.tables_.$tableName.tsx (Table data browser)
    │   ├── TableBrowser (spreadsheet-like data grid)
    │   │   └── DataRow (inline editing, row insert/delete)
    │   └── Breadcrumb (project > tables > tableName navigation)
    ├── project.$projectId.sql.tsx (SQL editor)
    │   ├── SQLEditor (textarea with Ctrl+Enter execution)
    │   ├── QueryResults (tabular result display)
    │   └── SavedQueryList (sidebar with saved queries)
    ├── project.$projectId.auth.tsx (Auth user management)
    │   ├── AuthUserList (table of simulated auth users)
    │   └── AuthUserForm (create/edit user with role, email, metadata)
    ├── project.$projectId.settings.tsx (Project settings)
    │   ├── ProjectSettings (connection config form; read-only for non-owners; password never shown)
    │   ├── ConnectionStatus (live connectivity indicator with test button)
    │   └── ProjectMembers (member list; owners add by username, change roles, remove)
    └── (shared)
        └── Breadcrumb (hierarchical navigation)
```

### Zustand Stores

**`useAuthStore`** (`stores/authStore.ts`) -- Authentication state:

- **`user`**: Current logged-in dashboard user (username, email, role) or null
- **`loading`**: Whether an auth operation is in progress
- **Actions**: `login(username, password)`, `register(username, email, password)`, `logout()`, `checkAuth()` for session validation on page load

**`useProjectStore`** (`stores/projectStore.ts`) -- Central store managing all project-related state. This is the largest store in the project, covering six data domains:

- **Projects**: `projects[]`, `currentProject`, `projectsLoading` -- CRUD for database projects
- **Tables**: `tables[]`, `tablesLoading` -- Schema introspection results from the target database
- **Table Data**: `tableData` (rows + pagination metadata), `tableDataLoading` -- Paginated row browsing with sort support
- **SQL**: `queryResult`, `queryError`, `queryLoading`, `savedQueries[]` -- SQL execution state with saved query management
- **Auth Users**: `authUsers[]`, `authUsersLoading` -- Simulated Supabase auth users
- **Settings**: `settings`, `settingsLoading` -- Project connection configuration
- **Members**: `members` with `loadMembers`, `addMember`, `removeMember`
- **Errors**: `projectError`, `tablesError`, `tableDataError` -- a 404 or 503 is shown as such instead of an empty list

`useProjectRole()` derives `{ role, canEdit, isOwner }` from `currentProject.memberRole` so components can hide controls the caller can't use. It is cosmetic: the server authorizes every request again.

Each domain has its own set of actions (e.g., `loadTables(projectId)`, `createTable(...)`, `dropTable(...)`). Actions that modify data (insert, update, delete) automatically reload the affected domain to keep the UI in sync.

### Routing

TanStack Router with file-based routing using nested layouts:

| Route | File | Description |
|-------|------|-------------|
| `/login` | `routes/login.tsx` | Login form |
| `/register` | `routes/register.tsx` | Registration form |
| `/` | `routes/index.tsx` | Project list (requires auth) |
| `/project/:projectId` | `routes/project.$projectId.tsx` | Project layout with sidebar |
| `/project/:projectId/` | `routes/project.$projectId.index.tsx` | Redirects to the table editor |
| `/project/:projectId/tables` | `routes/project.$projectId.tables.tsx` | Table list + schema viewer |
| `/project/:projectId/tables/:tableName` | `routes/project.$projectId.tables_.$tableName.tsx` | Table data browser |
| `/project/:projectId/sql` | `routes/project.$projectId.sql.tsx` | SQL editor |
| `/project/:projectId/auth` | `routes/project.$projectId.auth.tsx` | Auth user management |
| `/project/:projectId/settings` | `routes/project.$projectId.settings.tsx` | Connection settings |

The `project.$projectId.tsx` route acts as a nested layout, rendering the `ProjectSidebar` alongside an `<Outlet>` for child routes. This ensures the sidebar is always visible within a project context.

### Data Fetching

All data fetching goes through a centralized API service (`services/api.ts`) organized by domain:

- **`authApi`**: login, register, logout, session check
- **`projectsApi`**: CRUD operations, connection testing, member management
- **`tablesApi`**: schema introspection (list tables), DDL operations (create, alter, drop)
- **`tableDataApi`**: row CRUD with pagination and sorting parameters
- **`sqlApi`**: query execution, saved query management
- **`authUsersApi`**: simulated auth user CRUD
- **`settingsApi`**: project settings read/write

Each API module uses `fetch()` with credentials included (for session cookies). Error responses are parsed from JSON and thrown as Error objects with the server's error message. There is no client-side caching -- every navigation or action triggers a fresh fetch, which is appropriate for a database management tool where data freshness is critical.

### Key UI Patterns

- **Dark theme**: Supabase-branded dark color scheme (#1C1C1C background, #3ECF8E primary green) applied globally via Tailwind, matching the real Supabase Studio aesthetic
- **Nested route layout**: The project sidebar persists across table/SQL/auth/settings views, avoiding re-renders of the navigation when switching tabs
- **Inline editing**: Table data rows support click-to-edit, with changes submitted as PUT requests and the row data refreshed after success
- **Role-aware controls**: viewers see no insert/edit/delete, create/drop table, save query or add-user controls, a "Read-only" badge in the SQL editor, and read-only settings; non-owners can't edit settings or members. Project cards show the caller's role; only owners get a delete control
- **Errors are shown, not swallowed**: write failures (403, 400 with Postgres's message, 503 from an open circuit) appear in a banner where the action happened
- **Connection status indicators**: Each project card shows a live connectivity status. The `ConnectionStatus` component on the settings page provides a "Test Connection" button that hits the backend's test-connection endpoint
- **SQL execution with keyboard shortcut**: The SQL editor supports Ctrl+Enter (Cmd+Enter on Mac) to execute the query, matching the convention established by database tools like pgAdmin and DataGrip

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation covers what the pattern is, why it exists, how it works mechanically, and when you would use it.

### Circuit Breaker (Opossum)

**What it is**: A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing service. It works like an electrical circuit breaker: when failures exceed a threshold, the circuit "opens" and all subsequent calls fail immediately without attempting the operation. After a timeout period, the circuit enters a "half-open" state where a limited number of test requests are allowed through to check if the downstream service has recovered.

**How it works**: In this project, each project gets its own circuit breaker around all operations against its target database (schema introspection, query execution, DDL operations, row edits). It counts only failures that mean the target can't be used (connection refused, authentication failed, database missing, server shutting down); a syntax error or constraint violation means the server answered, so it is filtered out and counts as a success. When more than 50% of at least 3 recent operations failed, the circuit opens. While open, any attempt to query the target database immediately returns a clear error message ("target database unavailable") instead of waiting for a connection timeout. After 30 seconds, the circuit transitions to half-open, allowing a few test queries through. If these succeed, the circuit closes and normal operation resumes. If they fail, the circuit re-opens.

**Why it matters**: Target databases are user-managed and can be unreachable for many reasons (wrong credentials, firewall changes, database restart, network issues). Without a circuit breaker, every request to a down target database would wait for the full connection timeout (typically 10-30 seconds) before failing. During this time, the Express server's thread is blocked, and with enough concurrent users hitting the same dead target database, all server threads get consumed, making the entire dashboard unresponsive for all users across all projects. The circuit breaker prevents this cascade: after detecting that a target database is down, it fails immediately (in milliseconds) for subsequent requests, keeping the server responsive for users working with other, healthy databases.

**When to use it**: Use circuit breakers around any call to an external service that could fail or become slow: database connections, HTTP calls to other services, message queue operations. In this project, the circuit breaker is especially important because target databases are external systems outside the dashboard's control. Do not use circuit breakers for in-process function calls or operations that are expected to fail frequently (like user input validation).

### Prometheus Metrics (prom-client)

**What it is**: Prometheus is a monitoring system that collects numerical time-series data from applications. The application exposes a `/metrics` HTTP endpoint that Prometheus periodically scrapes. The `prom-client` library provides four metric types: Counter (only goes up), Gauge (goes up and down), Histogram (distribution of values in configurable buckets), and Summary (similar to histogram with quantile calculation).

**How it works**: The application creates metric objects at startup. During request processing, the application records observations. In this project, four custom metrics are tracked: `http_request_duration_seconds` (histogram of request latency by method, route, and status code), `http_requests_total` (counter of total requests), `query_execution_duration_seconds` (histogram of SQL query latency by project and query type), and `active_target_connections` (gauge of currently open connection pools). Prometheus scrapes the `/metrics` endpoint and stores the time-series data. Grafana dashboards visualize trends, and alerting rules trigger notifications when metrics cross thresholds.

**Why it matters**: For a database management dashboard, query execution latency is the most critical metric. If `query_execution_duration_seconds` shows increasing latency for a specific project, it may indicate a slow target database, an expensive query pattern, or connection pool exhaustion. The `active_target_connections` gauge helps with capacity planning -- if the number of active pools approaches the server's maximum (200 in the production design), it is time to add more API server instances or implement more aggressive pool eviction. Without metrics, operators would not know the system was degrading until users reported slow query execution.

**When to use it**: In any production system. Metrics are especially important for multi-tenant systems like this dashboard, where one user's expensive query could degrade the experience for others.

### Structured Logging (Pino)

**What it is**: Structured logging produces log entries as machine-parseable JSON objects rather than human-readable text strings. Each log entry is a flat or nested JSON object with consistent field names, enabling automated parsing, filtering, indexing, and alerting by log aggregation systems.

**How it works**: Instead of writing `console.log('Query executed for project abc in 150ms')`, structured logging produces `{"level":"info","projectId":"abc","queryType":"SELECT","durationMs":150,"rowCount":42,"requestId":"req-789"}`. Every log entry includes a severity level, a timestamp, and contextual fields. In development mode, Pino's `pino-pretty` formatter produces human-readable colored output. In production mode, raw JSON is emitted for ingestion by log aggregation systems.

**Why it matters**: When a user reports that their SQL query is running slowly, operators need to find the relevant log entries quickly. With structured logs, they can filter by `projectId` and `queryType` to see exactly which queries are slow, what the execution times are, and how many rows were returned. Project IDs in every log entry enable per-tenant debugging in a multi-tenant system. Error logs include connection details (host, port, database name -- but not passwords) to help diagnose connectivity issues.

**When to use it**: Always in production environments. Structured logging is especially critical for multi-tenant systems where log entries must be attributable to specific users and projects.

### Rate Limiting

**What it is**: Rate limiting restricts the number of requests a client can make within a time window. It protects the service from abuse by rejecting excess requests with HTTP 429 (Too Many Requests) responses before they consume server resources.

**How it works**: This project implements three rate limiting tiers using `express-rate-limit`:
- **API-wide**: 1000 requests per 15 minutes per IP address. Covers all endpoints.
- **Auth endpoints**: 50 requests per 15 minutes per IP address. Stricter limit to prevent brute-force password guessing.
- **SQL execution**: 100 queries per minute per user (keyed by session user ID). Prevents a single user from overwhelming the target database connection pool.

When a request arrives, the middleware checks a counter associated with the client's IP address (or, for SQL execution, the signed-in user's ID). The store is in memory, so with several API instances each enforces its own limit. If the counter exceeds the configured limit, the request is immediately rejected with a 429 response and a `Retry-After` header.

**Why it matters**: SQL execution is an expensive operation -- each query consumes a connection from the target database pool, CPU time for query processing, and network bandwidth for result transfer. Without rate limiting, a user could execute hundreds of queries per second (e.g., from a script or a runaway loop), exhausting the connection pool and making the target database unavailable for other users. The auth rate limit is equally important: without it, an attacker could attempt thousands of login attempts per minute to brute-force passwords.

**When to use it**: On every externally-facing API. Apply stricter limits to expensive operations (SQL execution, authentication) and more generous limits to cheap operations (listing projects, health checks).

### Health Checks

**What it is**: Health checks are dedicated HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers, container orchestrators, and monitoring systems to make automated decisions about routing traffic and restarting failed instances.

**How it works**: This project implements a single health check endpoint at `GET /api/health`. It tests connectivity to the metadata database by executing a simple query. If the database responds, it returns `{ status: 'ok' }` with HTTP 200. If the database is unreachable, it returns `{ status: 'unhealthy' }` with HTTP 503. The health check does not test target database connectivity because target databases are user-managed -- a down target database is not a system-level health issue.

**Why it matters**: Without a health check, a load balancer has no way to distinguish between a healthy API server and one whose metadata database connection is broken. It would continue sending traffic to the broken server, resulting in every request failing with a 500 error. With health checks, the load balancer removes the unhealthy instance from rotation, directing all traffic to healthy instances until the broken one recovers.

**When to use it**: Every production service needs at least a basic health check. For this project, checking only the metadata database is the correct scope -- the dashboard cannot function at all without its own database, but can function with some target databases being unreachable.

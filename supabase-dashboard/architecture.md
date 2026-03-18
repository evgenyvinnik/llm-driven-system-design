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

Each introspection opens a short-lived client connection rather than reusing the pool, ensuring schema changes are always reflected. At production scale, introspection results would be cached in Redis with a 60-second TTL and invalidated on DDL operations.

### Query Executor (Dynamic Pool Manager)

Manages a `Map<projectId, pg.Pool>` of connection pools to target databases:

1. On first query for a project, creates a pool with `max: 5` connections
2. Caches the pool for subsequent queries
3. Evicts the pool when project connection settings change
4. Cleans up all pools on graceful shutdown

At production scale, this becomes a tiered system: hot projects (queried in last 5 minutes) get persistent pools, warm projects get on-demand connections through PgBouncer, and cold projects require a full connection setup. An LRU eviction strategy caps total pools at 200 per API server instance.

```typescript
// Pool lifecycle (from src/services/queryExecutor.ts)
const targetPools = new Map<string, pg.Pool>();

function getTargetPool(projectId: string, config: ConnectionConfig): pg.Pool {
  const existing = targetPools.get(projectId);
  if (existing) return existing;

  const pool = new pg.Pool({ connectionString: buildConnectionString(config), max: 5 });
  targetPools.set(projectId, pool);
  return pool;
}
```

### DDL Generator

Produces SQL DDL statements from structured inputs while sanitizing identifiers:

- `generateCreateTable(name, columns[])` -- Builds `CREATE TABLE` with types, constraints, references
- `generateAddColumn(table, column)` -- `ALTER TABLE ADD COLUMN`
- `generateDropColumn(table, columnName)` -- `ALTER TABLE DROP COLUMN`
- `generateRenameColumn(table, old, new)` -- `ALTER TABLE RENAME COLUMN`
- `generateDropTable(name)` -- `DROP TABLE CASCADE`

All identifiers pass through `sanitizeIdentifier()` which strips non-alphanumeric characters and quotes reserved words.

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
  db_password VARCHAR(255) NOT NULL DEFAULT 'sample123',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) DEFAULT 'editor',
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

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List user's projects |
| GET | `/api/projects/:id` | Get project details |
| POST | `/api/projects` | Create project with DB config |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project |
| POST | `/api/projects/:id/test-connection` | Test target DB connectivity |
| GET | `/api/projects/:id/members` | List project members |
| POST | `/api/projects/:id/members` | Add member |
| DELETE | `/api/projects/:id/members/:userId` | Remove member |

### Schema (Tables)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:projectId/tables` | Introspect all tables |
| POST | `/api/projects/:projectId/tables` | Create table (DDL) |
| PUT | `/api/projects/:projectId/tables/:name` | Alter table (add/drop/rename column) |
| DELETE | `/api/projects/:projectId/tables/:name` | Drop table |

### Table Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:pid/tables/:name/rows` | Paginated row fetch |
| POST | `/api/projects/:pid/tables/:name/rows` | Insert row |
| PUT | `/api/projects/:pid/tables/:name/rows/:id` | Update row |
| DELETE | `/api/projects/:pid/tables/:name/rows/:id` | Delete row |

### SQL Editor

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/projects/:projectId/sql/execute` | Execute arbitrary SQL |
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
| GET | `/api/projects/:projectId/settings` | Get project settings |
| PUT | `/api/projects/:projectId/settings` | Update settings |

## Key Design Decisions

### Two-Database Architecture

**Chosen:** Separate metadata and target databases on different PostgreSQL instances.

**Why:** The metadata database (users, projects, saved queries) has a fixed, known schema controlled by the dashboard. The target database has an unknown, user-controlled schema that changes through DDL operations. Combining them would mean dashboard migrations could conflict with user tables, and connection credentials would be shared. Separation enables per-project connection isolation, independent scaling, and credential rotation without affecting the dashboard itself.

**Alternative:** Single database with schema separation (`dashboard.*` vs `public.*`). Simpler operationally but breaks down when projects connect to external databases -- the core Supabase use case.

### Dynamic Connection Pools vs. Per-Request Connections

**Chosen:** Cached `pg.Pool` instances keyed by project ID, created on first use.

**Why:** Opening a new TCP connection per query adds 50-100ms of latency. With pools, subsequent queries reuse existing connections. The pool is capped at 5 connections per project to prevent a single project from exhausting server resources.

**Trade-off:** Memory usage grows with active projects. At 1000 active projects with 5 connections each, the server holds 5000 database connections. Mitigation: idle timeout (60s) auto-closes unused connections, and the pool map evicts entries when connection settings change. At production scale, PgBouncer would sit between API servers and target databases, multiplexing connections and reducing the per-server pool count.

### information_schema vs. pg_catalog

**Chosen:** `information_schema` for schema introspection.

**Why:** `information_schema` provides a SQL-standard interface that produces cleaner, typed results. Column types come as readable strings (`character varying`, `integer`) rather than OIDs. The join pattern for PK/FK detection is well-documented.

**Trade-off:** `pg_catalog` is faster (no view overhead) and exposes PostgreSQL-specific features like custom types, statistics, and storage parameters. For a dashboard that needs human-readable schema information, `information_schema` is the better fit.

### DDL Generation from Structured Inputs

**Chosen:** Server-side DDL generation with identifier sanitization.

**Why:** Letting users type raw `CREATE TABLE` SQL is error-prone and hard to validate. Structured column definitions (name, type, nullable, default, PK) can be validated before SQL generation. The sanitizer strips dangerous characters from identifiers and quotes reserved words, preventing SQL injection through table/column names.

**Trade-off:** The DDL generator only supports common column types and constraints. Complex PostgreSQL features (partial indexes, generated columns, CHECK constraints, custom types) require the SQL editor. This is an acceptable boundary -- the DDL generator handles 90% of table creation, and the SQL editor handles the rest.

## Consistency and Idempotency

### SQL Execution Safety

All SQL queries against target databases are executed within statement-level timeouts. The query executor does not wrap user SQL in transactions -- each statement runs independently. This prevents a long-running `SELECT` from holding locks that block other operations, but means multi-statement DDL changes are not atomic. Users who need transactional DDL can wrap their SQL in explicit `BEGIN`/`COMMIT` blocks in the SQL editor.

### Connection Pool Consistency

When a project's connection settings change, the cached pool is evicted and a new one created on next use. In-flight queries on the old pool complete normally; only subsequent queries use the new settings. This avoids abruptly terminating active queries while ensuring configuration changes take effect promptly.

## Security

### Authentication
- Session-based auth with Valkey (Redis) backing store
- bcrypt password hashing with salt rounds = 10
- Session cookies: httpOnly, sameSite=lax, secure in production
- Rate limiting: 50 auth attempts per 15 minutes

### SQL Execution Sandboxing
- Target database connections use limited-privilege credentials
- Query execution timeout configurable (default 10s via pool config)
- Rate limiting: 100 queries per minute per user
- No server-side eval() -- all SQL is passed directly to pg.Pool.query()

### Identifier Sanitization
- Table and column names stripped to `[a-zA-Z0-9_]`
- PostgreSQL reserved words automatically quoted
- Prevents SQL injection through DDL generation paths

## Observability

### Metrics (Prometheus via prom-client)
- `http_request_duration_seconds` - Request latency histogram by method/route/status
- `http_requests_total` - Request counter by method/route/status
- `query_execution_duration_seconds` - SQL query latency by project and query type
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
- Wraps target database operations
- Opens after 50% error rate, resets after 30 seconds
- Prevents cascading failures when target databases are unreachable
- When open, returns a clear "target database unavailable" error rather than timing out

### Connection Failures
- Pool creation failures return clear error messages to the UI
- Connection test endpoint (`POST /projects/:id/test-connection`) validates before use
- Pool error handlers remove failed pools from the cache

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
| Database architecture | Two separate PostgreSQL instances | Single DB with schema separation | Enables per-project isolation and external DB connections |
| Connection management | Cached pool per project | Per-request connections | 50-100ms latency saving, amortized connection cost |
| Schema introspection | information_schema views | pg_catalog system tables | SQL-standard, readable types, portable |
| DDL generation | Server-side from structured inputs | Client-side raw SQL only | Validation, sanitization, safer for non-expert users |
| Session storage | Valkey + cookie | JWT tokens | Immediate revocation, simpler than token refresh |
| Auth users | Metadata DB table | Target DB auth schema | Simpler, no cross-database writes needed |
| Frontend theme | Dark (Supabase brand) | Light/system preference | Matches Supabase Studio, comfortable for SQL editing |

## Implementation Notes

### Local Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser                                    │
│   React + TanStack Router + Zustand + Tailwind                   │
│   http://localhost:5173                                           │
└──────────────────────────┬───────────────────────────────────────┘
                           │ fetch (proxied)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Express API Server                                │
│                 http://localhost:3000                              │
│                                                                   │
│  Routes: auth, projects, tables, tableData, sql, authUsers,      │
│          settings, users                                          │
│                                                                   │
│  Services: schemaIntrospector, queryExecutor, ddlGenerator,      │
│            authUserService, circuitBreaker, metrics, logger,     │
│            rateLimiter                                            │
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
| Circuit Breaker (Opossum) | `src/services/circuitBreaker.ts` | Opens at 50% error rate, resets after 30s. Prevents the dashboard from hanging when a target DB goes down. |
| Prometheus Metrics (prom-client) | `src/services/metrics.ts` | Custom histograms for query execution duration, connection pool gauge, standard HTTP metrics. Enables alerting on slow queries. |
| Structured Logging (Pino) | `src/services/logger.ts` | JSON logs with request context, error details, project IDs. Enables log aggregation and search. |
| Rate Limiting (express-rate-limit) | `src/services/rateLimiter.ts` | 1000 req/15min API-wide, 50 req/15min auth, 100 req/min SQL. Prevents abuse without blocking normal usage. |
| Dynamic Pool Management | `src/services/queryExecutor.ts` | Pools created on demand, cached by project ID, evicted on config change or idle timeout. |
| Identifier Sanitization | `src/services/ddlGenerator.ts` | DDL generator strips special characters and quotes reserved words. Prevents SQL injection through DDL forms. |
| Session Auth (express-session + connect-redis) | `src/middleware/auth.ts` | Valkey-backed sessions with httpOnly cookies. Immediate revocation on logout. |

### Simplifications

| Production Design | Local Substitute | Why Acceptable |
|-------------------|------------------|----------------|
| Per-project isolated databases | Single target DB on port 5433 | Demonstrates the two-DB pattern; pool manager is keyed by project ID regardless |
| PgBouncer connection pooling | Direct pg.Pool per project | Sufficient for < 10 concurrent projects in development |
| OAuth + GoTrue auth service | Session-based auth in metadata DB | Simulates Supabase auth user management without JWT/OAuth complexity |
| Redis Cluster for sessions | Single Valkey instance | No HA needed for local development |
| CDN for static assets | Vite dev server on :5173 | Hot module replacement is more useful during development |
| CodeMirror/Monaco SQL editor | Basic textarea | Functional for executing SQL; syntax highlighting is cosmetic |

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

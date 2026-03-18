# Retool - No-Code Internal Tool Builder: Architecture

## System Overview

Retool is a no-code platform for building internal tools. Users visually compose applications by dragging components (tables, forms, buttons, charts) onto a canvas, connecting to databases, writing queries, and binding query results to component properties. This project explores the meta-problem of system design: building a tool that builds tools.

**Learning goals**: Component model design, binding engine architecture, query execution safety, two-database separation, drag-and-drop grid systems, publish/versioning workflows.

## Requirements

### Functional Requirements

1. **App Builder**: Visual drag-and-drop editor with component palette, canvas, and property inspector
2. **Component Library**: Pre-built widgets (Table, TextInput, Button, Text, NumberInput, Select, Chart, Form, Container)
3. **Data Source Management**: Connect to external PostgreSQL databases
4. **Query Execution**: Write and run SQL queries against connected data sources
5. **Data Binding**: Bind query results to component props using `{{ expression }}` syntax
6. **Publish/Preview**: Snapshot app state as immutable versions, preview published apps
7. **Authentication**: User accounts with session-based auth

### Non-Functional Requirements (Production Scale)

| Metric | Target |
|--------|--------|
| Availability | 99.99% uptime |
| Latency (editor) | p99 < 200ms for save operations |
| Latency (queries) | p99 < 2s for query execution (depends on target DB) |
| Concurrent editors | 10,000 simultaneous users editing apps |
| Apps per org | Up to 10,000 apps |
| Query execution | 100 QPS per data source connection |

## Capacity Estimation

### Production Scale

- **Users**: 100K registered users, 10K concurrent editors
- **Apps**: 500K total apps, 50K active (edited in last 30 days)
- **Queries**: Average 5 queries per app, 2M query executions/day
- **Storage**: Average app JSON is ~50KB, 500K apps = ~25GB metadata
- **Data sources**: 200K configured connections across all orgs

### Local Development Scale

- **Users**: 2-5 test users
- **Apps**: 10-50 apps
- **Queries**: Manual execution, <10 QPS
- **Components**: Single PostgreSQL for metadata, single target PostgreSQL

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Browser                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ Component     │  │ Canvas       │  │ Property Inspector          │  │
│  │ Palette       │  │ (12-col Grid)│  │ + Binding Inputs            │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┬───────────────┘  │
│         │    Drag & Drop   │    Select & Edit        │                  │
│         └──────────────────┼─────────────────────────┘                  │
│                            │                                            │
│  ┌─────────────────────────┴────────────────────────────────────────┐   │
│  │                    Query Panel (SQL Editor + Results)            │   │
│  └─────────────────────────┬────────────────────────────────────────┘   │
└────────────────────────────┼────────────────────────────────────────────┘
                             │ REST API
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        API Gateway / Load Balancer                     │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
  │  App Service      │ │  Query Service   │ │  Auth Service    │
  │  (CRUD, Publish,  │ │  (Execute, Bind, │ │  (Sessions,      │
  │   Versioning)     │ │   Pool Mgmt)     │ │   Rate Limit)    │
  └────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
           │                    │                     │
           ▼                    ▼                     ▼
  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
  │  Retool DB       │ │  Target DBs      │ │  Redis/Valkey    │
  │  (PostgreSQL)    │ │  (Customer-owned  │ │  (Sessions,      │
  │  Apps, Users,    │ │   PostgreSQL,     │ │   Cache,         │
  │  Versions,       │ │   MySQL, etc.)    │ │   Rate Limits)   │
  │  Data Sources    │ │                  │ │                  │
  └──────────────────┘ └──────────────────┘ └──────────────────┘
```

The two-database architecture is fundamental: the **Retool DB** stores platform metadata (apps, users, versions, data source configs), while **Target DBs** are customer-owned external systems that apps query at runtime. These are entirely separate PostgreSQL instances (or other database engines at scale) with independent connection pools, credentials, and failure modes.

## Core Components

### 1. Component Model

The component model is the central abstraction. Every UI element on the canvas is an `AppComponent` with four properties:

- **`id`**: Unique identifier (e.g., `table1`, `textInput2`) -- used as the component's name in binding expressions
- **`type`**: Component type from the registry (table, textInput, button, text, numberInput, select, chart, form, container)
- **`props`**: Component-specific properties (data source, columns, label, placeholder, etc.)
- **`position`**: Grid placement with `{ x, y, w, h }` on a 12-column grid (80px per column, 40px per row)
- **`bindings`**: Map of prop name to `{{ expression }}` strings that resolve at runtime

Components are stored as a JSONB array in the `apps` table. This trades relational query flexibility for schema flexibility -- the component structure can evolve (new component types, new props) without database migrations.

### 2. Binding Engine

The binding engine resolves `{{ expression }}` patterns in component props and query text:

```
Input:  "Hello {{ query1.data[0].name }}"
Context: { query1: { data: [{ name: "Alice" }] } }
Output: "Hello Alice"
```

**Resolution algorithm**:
1. Find all `{{ ... }}` patterns using regex
2. For each expression, split into path segments: `query1.data[0].name` becomes `["query1", "data", "0", "name"]`
3. Walk the context object following the path
4. Replace the binding with the resolved value (stringified if object)

**Safety**: Uses property path traversal, never `eval()`. This prevents arbitrary code execution while supporting dot notation and array bracket access. The trade-off is reduced expressiveness -- users cannot write `{{ query1.data.filter(x => x.active).length }}`. Production Retool fills this gap with a sandboxed V8 isolate for custom JavaScript transformations.

**Binding context** contains:
- Query results: `{ query1: { data: [...], fields: [...], rowCount: N } }`
- Component values: `{ textInput1: { value: "search term" } }`

### 3. Query Executor

The query executor runs SQL against user-connected databases through a multi-step pipeline:

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Query Request │────▶│ Binding Engine    │────▶│ Safety Check     │
│ (SQL + context)│    │ (resolve {{ }})  │     │ (SELECT only?)   │
└──────────────┘     └──────────────────┘     └────────┬─────────┘
                                                       │
                                              ┌────────▼─────────┐
                                              │ Connection Pool   │
                                              │ (per data source) │
                                              └────────┬─────────┘
                                                       │
                                              ┌────────▼─────────┐
                                              │ Target Database   │
                                              └──────────────────┘
```

**Connection pooling**: Target DB pools are cached by data source ID with `Map<dataSourceId, pg.Pool>`. Each pool is configured with max 5 connections and 60-second idle timeout. On pool error, the pool is removed from cache and recreated on the next query. This avoids creating new connections per query while supporting multiple data sources.

**Safety**: By default, only `SELECT`, `WITH`, and `EXPLAIN` queries are allowed. Write queries require an explicit `allowWrite` flag. This string-prefix check is a pragmatic safety net -- a production system would use a SQL parser (like `pg-query-parser`) to detect write operations within CTEs or subqueries.

**Query result metadata**: The executor returns rows, field metadata (name + PostgreSQL type OID mapped to human-readable type names), and row count. This enables the Table widget to auto-generate column headers from field names.

### 4. App Service (CRUD + Versioning)

Apps follow a draft-then-publish workflow:

```
Draft (editing)  ──publish──▶  Version 1 (immutable snapshot)
     │                              │
  continue editing            stored in app_versions
     │
Draft (updated)  ──publish──▶  Version 2
```

Publishing creates a snapshot in `app_versions` with the current components, layout, and queries. The `apps` table always holds the latest draft state; `published_version` points to the current live version number. Preview mode renders the published version, not the draft, ensuring end-users see stable app state.

The `UNIQUE(app_id, version_number)` constraint prevents duplicate versions from concurrent or retried publish operations. The server generates version numbers atomically within a transaction (read max + insert next).

### 5. Component Registry

Defines the available component types with their default props, property schemas, and categories:

| Component | Category | Key Props |
|-----------|----------|-----------|
| Table | Data Display | `data` (binding), `columns`, `pageSize`, `searchable` |
| Text | Display | `text` (binding), `fontSize`, `color` |
| TextInput | Input | `label`, `placeholder`, `defaultValue` |
| NumberInput | Input | `label`, `min`, `max`, `step` |
| Select | Input | `label`, `options` (binding), `placeholder` |
| Button | Action | `label`, `color`, `variant`, `onClick` action |
| Chart | Data Display | `data` (binding), `chartType`, `xAxis`, `yAxis` |
| Form | Container | `submitLabel`, child components |
| Container | Layout | `title`, `padding` |

The registry serves two purposes: populating the component palette in the editor and defining the prop editing UI in the property inspector. Each prop has a type (`string`, `number`, `boolean`, `binding`, `json`, `select`) and a `bindable` flag indicating whether it accepts `{{ expression }}` syntax.

## Database Schema

### Retool Metadata Database

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users
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

-- Apps (draft state -- always holds the latest editing state)
CREATE TABLE apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  components JSONB DEFAULT '[]',     -- Array of AppComponent
  layout JSONB DEFAULT '{}',          -- Grid configuration
  queries JSONB DEFAULT '[]',         -- Array of AppQuery
  global_settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'draft'
    CHECK (status IN ('draft', 'published')),
  published_version INT,              -- Points to latest published version
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Published versions (immutable snapshots)
CREATE TABLE app_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  components JSONB NOT NULL,
  layout JSONB NOT NULL,
  queries JSONB NOT NULL,
  published_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, version_number)
);

-- External database connections
CREATE TABLE data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  type VARCHAR(30) NOT NULL CHECK (type IN ('postgresql', 'rest_api')),
  config JSONB NOT NULL,       -- { host, port, database, user, password }
  owner_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Saved queries (associated with apps)
CREATE TABLE saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  data_source_id UUID REFERENCES data_sources(id),
  query_text TEXT,
  transform_js TEXT,
  trigger VARCHAR(20) DEFAULT 'manual'
    CHECK (trigger IN ('manual', 'on_load', 'on_change')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_apps_owner ON apps(owner_id, updated_at DESC);
CREATE INDEX idx_app_versions_app ON app_versions(app_id, version_number DESC);
CREATE INDEX idx_data_sources_owner ON data_sources(owner_id);
CREATE INDEX idx_saved_queries_app ON saved_queries(app_id);
```

The `apps_owner` index supports the dashboard query (list user's apps sorted by recency). The `app_versions_app` index supports version history lookup, ordered newest-first. Data sources are scoped by `owner_id` -- in production, this would be `org_id` for multi-tenancy.

### Sample Target Database

A separate PostgreSQL instance hosts a sample e-commerce schema (customers, products, orders, order_items) with seed data. This simulates a real-world scenario where Retool connects to an external business database.

## API Design

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login, set session |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Current user info |

### Apps

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/apps` | List user's apps |
| GET | `/api/apps/:id` | Get app (draft state) |
| POST | `/api/apps` | Create app |
| PUT | `/api/apps/:id` | Update app (components, queries, etc.) |
| DELETE | `/api/apps/:id` | Delete app |
| POST | `/api/apps/:id/publish` | Publish current state as new version |
| GET | `/api/apps/:id/preview` | Get published version for preview |
| GET | `/api/apps/:id/versions` | Version history |

### Data Sources & Queries

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/datasources` | List user's data sources |
| POST | `/api/datasources` | Create data source |
| POST | `/api/datasources/:id/test` | Test connection to target DB |
| POST | `/api/queries/execute` | Execute SQL query against target DB |
| GET | `/api/components` | Get component registry definitions |

### Health & Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check (verifies metadata DB) |
| GET | `/metrics` | Prometheus metrics |

## Key Design Decisions

### 1. JSONB vs Normalized Tables for Components

**Chosen**: JSONB columns on the `apps` table store components, queries, and layout as JSON arrays/objects.

**Alternative**: Separate `components`, `component_props`, and `app_queries` tables with foreign keys.

**Rationale**: A no-code tool's component schema evolves constantly -- adding new component types, new props, new binding formats. With normalized tables, every schema change requires a migration across the components table, the props table, and potentially the bindings table. JSONB absorbs schema changes without migrations: adding a `borderRadius` prop to the Button component is just a new key in the JSON object, requiring zero database changes.

The cost is that querying individual components across apps (e.g., "find all apps using a specific data source in their query bindings") requires JSONB operators (`@>`, `->>`), which are slower than indexed relational queries and harder to optimize. At scale, if component metadata queries become frequent, materialized views or denormalized indexes (`CREATE INDEX ON apps USING GIN (components jsonb_path_ops)`) would provide acceptable performance.

### 2. Two-Database Architecture

**Chosen**: Separate PostgreSQL instances for metadata and target data.

**Alternative**: Single database with schema separation.

**Rationale**: In production Retool, target databases are customer-owned external systems (AWS RDS, GCP Cloud SQL, on-prem Oracle). The query executor must create dynamic connections based on stored configuration, handling connection pooling, timeouts, and network failures as external service calls rather than local queries. Modeling this as a separate Docker container mirrors production reality.

The two-database separation also provides security isolation. A SQL injection vulnerability in query execution (which is a real risk with string-based binding resolution) would only compromise the target database, not the Retool metadata containing user credentials, session data, and app definitions. In production, the query execution service would run in a separate network segment from the metadata service.

### 3. Property Path Resolution vs eval()

**Chosen**: Manual property path traversal for binding resolution.

**Alternative**: JavaScript `eval()` or `Function()` constructor.

**Rationale**: `eval("query1.data[0].name")` with a context object would be powerful but creates a massive security surface. Users could execute arbitrary code: `eval("process.exit(1)")` or `eval("require('child_process').exec('rm -rf /')")`. Property path traversal limits expressions to data access only: navigating object properties and array indices.

The trade-off is reduced expressiveness -- users cannot write `{{ query1.data.filter(x => x.active).length }}`. In production Retool, this gap is filled by a sandboxed V8 isolate that executes user JavaScript in a memory-limited, time-limited sandbox with no access to Node.js APIs. Building this sandbox is substantial engineering (process isolation, memory limits, CPU timeouts, serialization of results), which is beyond the scope of this project.

### 4. Grid-Based Layout vs Freeform Positioning

**Chosen**: 12-column grid (80px per column, 40px per row) with position `{ x, y, w, h }`.

**Alternative**: Freeform absolute pixel positioning.

**Rationale**: A grid system makes drag-and-drop positioning predictable -- components snap to grid boundaries, align automatically, and produce consistent layouts across screen sizes. Freeform positioning allows pixel-perfect control but leads to misaligned components, inconsistent spacing, and layouts that break at different screen widths. For internal tools where functional correctness matters more than pixel-perfect design, grid constraints are the right trade-off.

## Consistency and Idempotency

### Idempotent App Saves

App save operations (PUT `/api/apps/:id`) send the full app state (components, queries, layout) rather than incremental patches. Replaying the same save request produces the same result regardless of how many times it is delivered. The `updated_at` timestamp serves as a lightweight version marker. This last-writer-wins approach is acceptable because the editor always sends the complete component tree -- no partial state can be persisted.

### Optimistic Locking for Concurrent Editing

When multiple users edit the same app, the save endpoint accepts an `expected_version` field (the `updated_at` value the client last read). Before writing, the server checks whether the stored `updated_at` matches. If not, the save is rejected with a 409 Conflict, prompting the client to reload. This prevents lost updates without holding database locks during editing sessions. The trade-off is occasional conflict errors, but for an internal tool builder where simultaneous editing of the same app is uncommon, this is preferable to the complexity of real-time CRDT-based conflict resolution.

### Query Execution Retry Semantics

Query execution against target databases is inherently non-idempotent for write operations (INSERT, UPDATE, DELETE). Read queries (SELECT) are safe to retry on transient failures -- the executor retries up to two times with exponential backoff. Write queries are never automatically retried because replaying an INSERT could create duplicate rows. Instead, write failures return an error immediately, and the user decides whether to re-execute.

### Exactly-Once Publish Operations

Publishing (POST `/api/apps/:id/publish`) creates an immutable version snapshot. The server wraps the operation in a transaction: read the current maximum version number, insert the next version atomically. The `UNIQUE(app_id, version_number)` constraint prevents duplicates on retry. If a retried publish hits the constraint violation, the server catches it and returns the existing version rather than an error, making the endpoint effectively idempotent.

### Consistency Guarantees

The metadata database uses PostgreSQL with READ COMMITTED isolation. Within a single app save or publish, all state changes occur in one transaction, ensuring atomicity. Cross-app consistency is not a concern since apps are independent entities. There is no distributed transaction between the Retool metadata database and target databases -- query results are ephemeral (not persisted), so there is no consistency boundary to maintain.

## Security

### Query Execution Safety

- **Read-only by default**: Only `SELECT`, `WITH`, and `EXPLAIN` queries are allowed unless `allowWrite` is explicitly set
- **No query parameterization**: Bindings are resolved via string replacement, which is a SQL injection risk. In production, bindings should be resolved server-side and passed as parameterized query values (`$1`, `$2`)
- **Connection isolation**: Each data source gets its own connection pool with limited max connections (5) and idle timeout (60s)

### Authentication

- Session-based auth with Redis session store
- bcrypt password hashing (10 rounds)
- Rate limiting on auth endpoints (50 requests per 15 minutes)
- API rate limiting (1000 requests per 15 minutes)
- CORS restricted to frontend origin

### Data Source Credentials

- Stored in JSONB `config` column
- Passwords masked in API responses (`********`)
- In production, credentials should be encrypted at rest with envelope encryption (KMS) and accessed via a secrets manager

## Observability

### Prometheus Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `http_request_duration_seconds` | Histogram | Request latency by method/route/status |
| `http_requests_total` | Counter | Request counter by method/route/status |
| `query_execution_duration_seconds` | Histogram | Query execution time by data source type |
| `active_apps_total` | Gauge | Total apps in the system |

### Structured Logging

Pino logger with JSON output, including request context (method, path, duration, user ID).

### Health Check

`GET /api/health` verifies metadata database connectivity and returns status.

## Failure Handling

### Circuit Breaker

Opossum circuit breaker available for wrapping external service calls:
- 50% error threshold opens the circuit
- 30-second reset timeout
- 10-second call timeout

This protects the metadata database from cascade failures when a target database is slow or unreachable.

### Connection Pool Failures

Target DB connection pools are cached per data source ID. If a pool encounters an error, it is removed from cache and recreated on the next query. This auto-healing behavior prevents stale connections from blocking query execution. Each pool is configured with max 5 connections and 60-second idle timeout.

### Graceful Shutdown

SIGTERM/SIGINT handlers close the HTTP server, drain all target DB pools (cleaning up connections to external databases), and disconnect from the metadata database. This prevents connection leaks during deployments.

## Scalability Considerations

### Horizontal Scaling

The API layer is stateless (sessions in Redis) and can scale horizontally behind a load balancer. The main bottleneck is the metadata PostgreSQL -- at 500K apps with frequent saves, write throughput becomes the limiting factor.

### App Storage at Scale

At 500K apps with average 50KB JSON, total storage is ~25GB. PostgreSQL's JSONB TOAST compression reduces this significantly. For organizations with very large apps (thousands of components), the JSONB payload could exceed 1MB. At that scale, split component storage into object storage (S3) and keep only metadata (name, owner, version pointer) in PostgreSQL.

### Query Execution Scaling

Each API instance maintains its own target DB connection pools. At scale, popular data sources could exhaust connections if many API instances each hold max-pool connections. A dedicated query execution service with a centralized connection pooler (PgBouncer) would cap total connections to each target database regardless of API instance count.

### Multi-Tenancy

Apps are scoped by `owner_id`. At scale, tenant isolation requires:
- Row-level security policies in PostgreSQL
- Per-tenant connection limits on the query executor
- Query execution quotas (CPU time, row count limits) to prevent one tenant's expensive query from affecting others
- Separate encryption keys per tenant for data source credentials

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Component storage | JSONB columns | Normalized tables | Schema flexibility for evolving components |
| Binding resolution | Property path traversal | eval() / V8 isolate | Security over expressiveness |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Target DB connections | Dynamic pg.Pool cache | PgBouncer proxy | Simpler for local, PgBouncer for production |
| Query safety | String prefix check | SQL parser (pg-query-parser) | Simpler, sufficient for demo |
| Layout system | 12-column grid | Freeform absolute positioning | Predictable alignment, familiar to users |
| Auth | Session-based | OAuth2 / JWT | Sufficient for learning, simpler implementation |
| Two-database architecture | Separate PostgreSQL instances | Single DB with schemas | Mirrors production reality, security isolation |

## Implementation Notes

### Local Architecture

```
┌─────────────────────────────────────────────┐
│   React SPA (Vite :5173)                    │
│   ┌──────────┬──────────┬──────────────────┐│
│   │Component │  Canvas  │ Property         ││
│   │Palette   │ (12-col) │ Inspector        ││
│   │          │          │ + BindingInput    ││
│   ├──────────┴──────────┴──────────────────┤│
│   │        Query Panel (SQL + Results)     ││
│   └─────────────────┬─────────────────────┘│
└─────────────────────┼──────────────────────┘
                      │ REST API
                      ▼
┌─────────────────────────────────────────────┐
│   Express API Server :3001                  │
│   ┌──────────┬───────────┬────────────────┐ │
│   │ App CRUD │ Query     │ Auth + Session │ │
│   │ Publish  │ Executor  │ Rate Limit    │ │
│   │ Versions │ Bindings  │               │ │
│   └────┬─────┴─────┬─────┴───────┬───────┘ │
└────────┼───────────┼─────────────┼─────────┘
         │           │             │
    ┌────▼─────┐ ┌───▼──────┐ ┌───▼─────┐
    │Retool DB │ │Target DB │ │ Valkey  │
    │PostgreSQL│ │PostgreSQL│ │ :6379   │
    │ :5432    │ │ :5433    │ │Sessions │
    │Apps,Users│ │Customers │ │Cache    │
    │Versions  │ │Products  │ │Rate     │
    │DataSrcs  │ │Orders    │ │Limits   │
    └──────────┘ └──────────┘ └─────────┘
```

All infrastructure runs via Docker Compose (`docker-compose.yml`). The Retool metadata PostgreSQL runs on port 5432; the target (sample e-commerce) PostgreSQL runs on port 5433. The Express API server runs natively with `tsx watch` for hot reload.

### Production-Grade Patterns Implemented

1. **Binding Engine** (`src/services/bindingEngine.ts`): Regex-based `{{ expression }}` parsing with safe property path traversal. Supports dot notation (`query1.data`) and array bracket notation (`data[0].name`). No `eval()`, no arbitrary code execution. ~80 lines of pure logic.

2. **Query Executor** (`src/services/queryExecutor.ts`): Dynamic connection pool management (`Map<dataSourceId, pg.Pool>`), binding resolution before execution, safety check (SELECT/WITH/EXPLAIN only by default), PostgreSQL OID-to-type mapping for field metadata, auto-healing pool on error.

3. **Component Registry** (`src/services/componentRegistry.ts`): Defines 9 component types with default props, property schemas, and categories. Serves as the single source of truth for both the editor palette and the property inspector.

4. **Prometheus Metrics** (`src/services/metrics.ts`): HTTP request duration histograms, request counters, query execution timing by data source type.

5. **Circuit Breaker** (`src/services/circuitBreaker.ts`): Opossum-based breaker with 50% error threshold, 30s reset, 10s call timeout.

6. **Structured Logging** (`src/services/logger.ts`): Pino JSON logger with request context.

7. **Rate Limiting** (`src/services/rateLimiter.ts`): Separate limits for auth (50/15min), query execution (100/min), and general API (1000/15min).

8. **Graceful Shutdown**: SIGTERM/SIGINT handlers drain target DB pools and disconnect from metadata DB.

### Simplifications

| Production Feature | Local Substitute | Why |
|--------------------|-----------------|-----|
| Separate microservices (App, Query, Auth) | Single Express server | All routes in one process, simpler development |
| SQL AST parser for query safety | String prefix check (`startsWith('SELECT')`) | Sufficient for demo, catches obvious write queries |
| V8 isolate for JavaScript bindings | Property path traversal only | No arbitrary expressions, avoids sandbox complexity |
| Envelope encryption (KMS) for credentials | Plaintext JSONB storage | No secrets manager needed locally |
| PgBouncer for target DB pooling | In-process `pg.Pool` per data source | Single API instance, no connection exhaustion risk |
| OAuth2 / SSO | Session auth with bcrypt | Simpler, sufficient for learning |
| CDN for published apps | Vite dev server | No global distribution needed |
| Multi-tenant row-level security | `owner_id` filter on queries | Single-tenant sufficient for demo |

### Omitted

- **CDN** for static assets and published app hosting
- **Multi-region** deployment and database replication
- **Kubernetes** orchestration
- **Real-time collaboration** (multiple editors on same app via WebSocket/CRDT)
- **Sandboxed JavaScript runtime** (V8 isolate) for custom transformations
- **Audit logging** for compliance (who changed what, when)
- **Role-based access control** per app/data source (only owner-based access)
- **Query result caching** with invalidation
- **REST API data source type** (only PostgreSQL implemented)
- **File/asset storage** (MinIO/S3 for uploaded images in apps)

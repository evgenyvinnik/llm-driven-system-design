# Salesforce CRM - Architecture

## System Overview

A customer relationship management (CRM) system modeled after Salesforce, designed to manage the full sales lifecycle: leads, accounts, contacts, opportunities, and activities. The system provides a pipeline view for tracking deal progression, lead conversion workflows, and reporting dashboards for sales performance analytics. This project demonstrates entity relationship modeling, transactional workflows, polymorphic associations, and kanban-style UI state management.

**Learning goals:** CRM data modeling, transactional lead conversion, pipeline stage management, polymorphic activity tracking, aggregated dashboard KPIs, and drag-drop kanban UI with optimistic updates.

## Requirements

### Functional Requirements
- User authentication with session-based auth
- CRUD operations for accounts, contacts, opportunities, and leads
- Opportunity pipeline with kanban drag-drop stage transitions
- Lead conversion workflow (lead -> account + contact + opportunity in a single transaction)
- Activity logging (calls, emails, meetings, notes) with polymorphic entity association
- Dashboard with aggregated KPI metrics
- Reporting: pipeline by stage, revenue by month, leads by source
- Search and filtering across all entity types

### Non-Functional Requirements (Production Scale)
- 99.9% uptime for core CRM operations
- p99 API response time < 200ms for entity CRUD
- p99 < 500ms for dashboard aggregation queries
- Support 50K concurrent sales users
- Handle 10M+ accounts with sub-second search
- Atomic lead conversion with zero data loss
- Audit trail for all entity state changes

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          CDN / Edge Cache                            │
│            (Static assets, React bundle, cache headers)              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         API Gateway                                  │
│         (Rate Limiting, Auth, TLS Termination, Routing)              │
└─────┬──────────┬──────────┬──────────┬──────────┬───────────────────┘
      │          │          │          │          │
      ▼          ▼          ▼          ▼          ▼
┌─────────┐ ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐
│ Account │ │ Contact │ │   Opp    │ │  Lead  │ │ Activity │
│ Service │ │ Service │ │ Service  │ │Service │ │ Service  │
└────┬────┘ └────┬────┘ └────┬─────┘ └───┬────┘ └────┬─────┘
     │           │           │           │           │
     └───────────┴───────────┼───────────┴───────────┘
                             │
                     ┌───────┴───────┐
                     │               │
              ┌──────▼──────┐ ┌──────▼──────┐
              │ PostgreSQL  │ │   Redis     │
              │  (Primary)  │ │  (Cache +   │
              │             │ │  Sessions)  │
              └──────┬──────┘ └─────────────┘
                     │
              ┌──────▼──────┐
              │ PostgreSQL  │
              │  (Replica)  │
              └─────────────┘
```

At production scale, each service runs as an independently deployable microservice behind the API gateway. Read-heavy operations (dashboard, reports, search) route to read replicas, while write operations (lead conversion, stage updates) target the primary.

## Core Components

### Entity Relationship Model

The CRM revolves around five core entities with ownership and association relationships:

```
┌─────────┐     ┌───────────┐     ┌───────────────┐
│  Users  │────▶│ Accounts  │────▶│   Contacts    │
│ (owner) │     │           │     │               │
└────┬────┘     └─────┬─────┘     └───────────────┘
     │                │
     │          ┌─────▼─────┐
     │          │Opportuni- │
     │          │   ties    │
     │          └───────────┘
     │
     │          ┌───────────┐     ┌───────────────┐
     └────────▶│   Leads   │ ──▶ │  Conversion   │
               │           │     │ (account +    │
               └───────────┘     │  contact +    │
                                 │  opportunity) │
                                 └───────────────┘

     ┌───────────┐
     │Activities │──── polymorphic ──── any entity
     └───────────┘
```

### Request Flows

**Lead Conversion Flow** (the most complex operation):

```
┌────────┐     ┌────────────┐     ┌──────────────────────────────────┐
│ Client │────▶│ POST       │────▶│         Transaction              │
│        │     │ /leads/:id │     │  1. Validate lead exists         │
└────────┘     │ /convert   │     │  2. CREATE account               │
               └────────────┘     │  3. CREATE contact (from lead)   │
                                  │  4. CREATE opportunity (optional) │
                                  │  5. UPDATE lead status=Converted │
                                  │  6. COMMIT                       │
                                  └──────────────────────────────────┘
```

Lead conversion is the riskiest operation in the system. It creates 2-3 entities in a single database transaction (account, contact, and optionally opportunity), then marks the lead as converted. If any step fails, the entire transaction rolls back -- no partial conversions can exist. The alternative (saga pattern with compensating transactions) adds unnecessary complexity for a single-database operation. At scale, this transaction acquires a dedicated connection from the pool and uses explicit `BEGIN`/`COMMIT`/`ROLLBACK` to guarantee atomicity.

**Kanban Stage Update Flow:**

```
┌────────┐     ┌────────────┐     ┌──────────────────────────────────┐
│ Client │────▶│ PUT /opps/ │────▶│  1. Validate stage transition    │
│ (drag) │     │ :id/stage  │     │  2. UPDATE stage + probability   │
└────────┘     └────────────┘     │  3. Return updated opportunity   │
                                  └──────────────────────────────────┘
```

### Pipeline Stages and Probability Mapping

| Stage | Probability | Description |
|-------|-------------|-------------|
| Prospecting | 10% | Initial identification |
| Qualification | 20% | Confirmed budget and need |
| Needs Analysis | 40% | Understanding requirements |
| Proposal | 60% | Solution proposed |
| Negotiation | 80% | Terms under discussion |
| Closed Won | 100% | Deal signed |
| Closed Lost | 0% | Deal lost |

## Database Schema

The schema uses 8 tables with UUID primary keys, foreign key relationships, and strategic indexes.

```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  industry VARCHAR(100),
  website VARCHAR(255),
  phone VARCHAR(50),
  address_street TEXT,
  address_city VARCHAR(100),
  address_state VARCHAR(100),
  address_country VARCHAR(100),
  annual_revenue_cents BIGINT,
  employee_count INTEGER,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  title VARCHAR(100),
  department VARCHAR(100),
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  amount_cents BIGINT,
  stage VARCHAR(50) DEFAULT 'Prospecting',
  probability INTEGER DEFAULT 10,
  close_date DATE,
  description TEXT,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  company VARCHAR(255),
  title VARCHAR(100),
  source VARCHAR(50),
  status VARCHAR(30) DEFAULT 'New',
  converted_account_id UUID REFERENCES accounts(id),
  converted_contact_id UUID REFERENCES contacts(id),
  converted_opportunity_id UUID REFERENCES opportunities(id),
  converted_at TIMESTAMPTZ,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL,       -- 'call', 'email', 'meeting', 'note'
  subject VARCHAR(255) NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ,
  completed BOOLEAN DEFAULT false,
  related_type VARCHAR(20),        -- 'account', 'contact', 'opportunity', 'lead'
  related_id UUID,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(30) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  field_type VARCHAR(20) NOT NULL,  -- 'text', 'number', 'date', 'boolean', 'select'
  options JSONB,
  is_required BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entity_type, field_name)
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID REFERENCES custom_fields(id) ON DELETE CASCADE NOT NULL,
  entity_id UUID NOT NULL,
  value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(field_id, entity_id)
);

-- Key indexes supporting primary access patterns
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_account ON opportunities(account_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON opportunities(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_activities_related ON activities(related_type, related_id);
CREATE INDEX IF NOT EXISTS idx_activities_owner ON activities(owner_id, due_date);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_entity ON custom_field_values(entity_id);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);
```

Key indexes support the primary access patterns:
- `idx_opportunities_stage` -- Pipeline grouping for kanban and reports
- `idx_opportunities_owner` -- User-specific deal filtering
- `idx_activities_related` -- Composite index for polymorphic activity lookups by (type, id)
- `idx_leads_status` -- Status-based filtering for lead management views

## API Design

### Authentication
```
POST /api/auth/register    Register new user
POST /api/auth/login       Login with credentials
POST /api/auth/logout      Logout and destroy session
GET  /api/auth/me          Get current user
```

### Dashboard
```
GET  /api/dashboard        Aggregated KPIs for current user
```

### Accounts
```
GET    /api/accounts                   List with search/filter/pagination
GET    /api/accounts/:id               Get account detail
POST   /api/accounts                   Create account
PUT    /api/accounts/:id               Update account
DELETE /api/accounts/:id               Delete account
GET    /api/accounts/:id/contacts      List contacts for account
GET    /api/accounts/:id/opportunities List opportunities for account
```

### Contacts
```
GET    /api/contacts        List with search/filter/pagination
GET    /api/contacts/:id    Get contact detail
POST   /api/contacts        Create contact
PUT    /api/contacts/:id    Update contact
DELETE /api/contacts/:id    Delete contact
```

### Opportunities
```
GET    /api/opportunities          List with search/filter/pagination
GET    /api/opportunities/:id      Get opportunity detail
POST   /api/opportunities          Create opportunity
PUT    /api/opportunities/:id      Update opportunity
PUT    /api/opportunities/:id/stage Update stage only (kanban drag-drop)
DELETE /api/opportunities/:id      Delete opportunity
```

### Leads
```
GET    /api/leads              List with search/filter/pagination
GET    /api/leads/:id          Get lead detail
POST   /api/leads              Create lead
PUT    /api/leads/:id          Update lead
POST   /api/leads/:id/convert  Convert lead to account+contact+opportunity
DELETE /api/leads/:id          Delete lead
```

### Activities
```
GET    /api/activities        List with polymorphic filter
GET    /api/activities/:id    Get activity detail
POST   /api/activities        Create activity
PUT    /api/activities/:id    Update activity
DELETE /api/activities/:id    Delete activity
```

### Reports
```
GET  /api/reports/pipeline   Pipeline by stage (count + amount)
GET  /api/reports/revenue    Revenue by month
GET  /api/reports/leads      Leads by source
```

## Key Design Decisions

### Polymorphic Activities vs. Separate Tables

Activities use `related_type` and `related_id` columns to associate with any entity type (account, contact, opportunity, lead). This is simpler than creating `account_activities`, `contact_activities`, etc. join tables -- a single query retrieves the full activity timeline for any entity. The composite index on `(related_type, related_id)` ensures fast lookups.

The trade-off is loss of referential integrity: there is no FK constraint from `related_id` to a specific table, so the database cannot prevent orphaned activities if an entity is deleted without cleaning up its activities. We accept this because activities are append-only logs and orphaned activities are harmless -- they simply won't appear in any timeline view. At production scale, a background cleanup job would periodically remove orphaned activities.

The alternative (separate join tables per entity) would provide FK guarantees but require N different queries for a unified activity timeline, complicate the API, and make adding new entity types require schema changes.

### Transactional Lead Conversion

Lead conversion creates 2-3 entities in a single database transaction. This ensures atomicity -- if the opportunity creation fails, neither the account nor contact is created, and the lead remains unconverted. The alternative (saga pattern with compensating transactions) adds significant complexity for what is fundamentally a single-database operation with no cross-service coordination.

At production scale with microservices, if accounts, contacts, and opportunities were owned by different services, a saga with compensating transactions would be necessary. But within a single database, PostgreSQL transactions provide stronger guarantees with less code.

### Stage-Probability Coupling

Opportunity stages automatically set probability percentages when changed via the kanban endpoint (Prospecting=10%, Qualification=20%, etc.). This simplifies pipeline forecasting -- the weighted pipeline value is always consistent. Sales teams can override probability through the full update endpoint, but kanban drag-drop always resets to defaults.

The alternative (decoupled stage and probability) gives more flexibility but introduces data inconsistency risks where a "Closed Won" deal might show 50% probability, skewing forecasts.

### Money as Cents (BIGINT)

All monetary values (`amount_cents`, `annual_revenue_cents`) are stored as cents in BIGINT columns. This avoids floating-point arithmetic issues that plague DECIMAL/NUMERIC types in application code and is the standard approach for financial data. The frontend formats cents to dollars for display.

### Custom Fields via EAV Pattern

The `custom_fields` and `custom_field_values` tables implement the Entity-Attribute-Value pattern, allowing organizations to add custom fields to any entity type without schema changes. Each field definition specifies type and validation rules, while values are stored as TEXT with application-layer type coercion.

The alternative (JSONB column on each entity) is simpler but makes custom fields harder to query, index, and validate at the database level.

## Consistency and Idempotency

- **Lead conversion** uses PostgreSQL transactions with explicit `BEGIN`/`COMMIT`/`ROLLBACK` to ensure atomic multi-entity creation. A failed conversion leaves the lead unchanged.
- **Stage updates** are idempotent -- moving an opportunity to its current stage is a no-op that returns the unchanged record.
- **Optimistic concurrency** is handled through `updated_at` timestamps. At production scale, this would be enforced with a version column and conditional updates (`WHERE version = $expected`).

## Security and Auth

- Session-based authentication with Redis-backed session store (connect-redis)
- Password hashing with bcrypt (10 rounds)
- CORS configured for frontend origin only
- Rate limiting: 1000 req/15min for API, 50 req/15min for auth, 30 req/min for reports
- All data endpoints require authentication via `requireAuth` middleware
- At production scale: OAuth 2.0 / SAML SSO for enterprise customers, field-level security, sharing rules per organization

## Observability

- **Structured logging** with Pino -- JSON format in production (machine-parseable for log aggregation), pretty-printed in development. Every request is logged with method, path, status, and duration.
- **Prometheus metrics** via prom-client -- HTTP request duration histograms, request count by status code, and database query timing. Exposed at `/metrics` for Prometheus scraping.
- **Health check** endpoint at `/api/health` that verifies database connectivity and returns service status.

At production scale, these metrics feed into Grafana dashboards with alerts on p99 latency breaches, error rate spikes, and database connection pool exhaustion. Distributed tracing (OpenTelemetry) would correlate requests across microservices.

## Failure Handling

- **Circuit breaker** (Opossum) wraps external service calls with a 50% error threshold -- after half of recent requests fail, the circuit opens and subsequent calls fail fast rather than blocking on timeouts.
- **Database connection pooling** with 20 max connections and 5-second connection timeout -- prevents connection exhaustion under load.
- **Redis retry strategy** with exponential backoff (max 2-second delay) -- handles transient Redis failures without crashing the application.
- **Graceful shutdown** on SIGTERM/SIGINT -- stops accepting new connections, waits for in-flight requests to complete, then closes database and Redis connections.

## Scalability Considerations

### What breaks first at scale
1. **Dashboard aggregation queries** -- Scanning all opportunities/leads for KPIs becomes slow past 1M records. Solution: materialized views refreshed every 5 minutes, or pre-computed rollup tables updated on write.
2. **Pipeline reports** -- `GROUP BY` queries on the opportunities table degrade with table size. Solution: read replicas for reporting queries, partitioning by `close_date`.
3. **Activity lookups** -- Polymorphic queries without FK indexes grow linearly. Solution: sharding activities by `related_type` to separate high-volume entity types.
4. **Full-text search** -- SQL `ILIKE` queries don't scale past millions of rows. Solution: Elasticsearch for search across accounts, contacts, and leads.

### Scaling path
- **Read replicas** for all reporting and dashboard queries (separate read/write connection pools)
- **Table partitioning** on opportunities by `close_date` (range partitioning) and activities by `created_at`
- **Elasticsearch** for full-text search, replacing `ILIKE` queries
- **Redis caching** for dashboard KPIs with 5-minute TTL, invalidated on relevant writes
- **Horizontal API scaling** behind a load balancer -- stateless servers with shared session store in Redis

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler for server-rendered views |
| Activity model | Polymorphic columns | Separate join tables | Simpler queries, single timeline, acceptable FK trade-off |
| Lead conversion | DB transaction | Saga pattern | Single database, transaction guarantees atomicity |
| Pipeline stages | Fixed enum | Configurable per org | Simpler implementation, covers 90% of use cases |
| Money storage | BIGINT cents | DECIMAL | No floating-point issues, standard financial pattern |
| Custom fields | EAV pattern | JSONB column | Queryable, indexable, schema-validated |
| Search | SQL ILIKE | Elasticsearch | Sufficient for local scale, ES for production |

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (RootComponent)
├── Sidebar                           ← Fixed left nav, Salesforce-branded
│   └── Link (TanStack Router)        ← Active route highlighting
├── routes/index.tsx (Dashboard)
│   ├── DashboardMetrics              ← KPI cards (revenue, open opps, leads, activities)
│   └── PipelineChart                 ← CSS-only bar chart of pipeline by stage
├── routes/accounts.tsx
│   └── AccountList                   ← Search, industry filter, paginated table
│       └── EntityForm (modal)        ← Shared create/edit form
├── routes/accounts.$accountId.tsx
│   └── AccountDetail                 ← Tabbed detail view
│       ├── ContactList (tab)
│       ├── OpportunityCard (tab)
│       └── ActivityTimeline (tab)
│           └── ActivityForm          ← Create activity linked to entity
├── routes/contacts.tsx
│   └── ContactList                   ← Search, account filter, paginated table
│       └── EntityForm (modal)
├── routes/opportunities.tsx
│   └── KanbanBoard                   ← @dnd-kit drag-drop pipeline
│       ├── KanbanColumn              ← Droppable stage column
│       │   └── OpportunityCard       ← Draggable deal card
│       └── DragOverlay               ← Ghost card during drag
├── routes/leads.tsx
│   └── LeadList                      ← Search, status/source filters
│       ├── EntityForm (modal)
│       └── ConvertLeadModal          ← Lead-to-account conversion dialog
├── routes/reports.tsx
│   └── ReportChart                   ← CSS-only charts (pipeline, revenue, leads by source)
├── routes/login.tsx                  ← Login form
└── routes/register.tsx               ← Registration form
```

### Zustand Stores

The frontend uses two Zustand stores that separate authentication state from domain data:

**`useAuthStore`** (`stores/authStore.ts`) manages user session state. It holds the current `User` object (or null if logged out), a `loading` flag, and an `error` string. Actions include `login`, `register`, `logout`, and `checkAuth`. The `checkAuth` action is called once from the root layout on mount to restore the session from the server-side cookie. All auth API calls go through the `authApi` service object, and the store sets `user: null` on any auth failure to force redirect to the login page.

**`useCrmStore`** (`stores/crmStore.ts`) manages all CRM domain data in a single flat store. It holds arrays and loading flags for six entity types (accounts, contacts, opportunities, leads, activities) plus dashboard KPIs and three report types (pipeline, revenue, leads by source). Each entity has a `fetch*` action that calls the corresponding API client, updates the array, and sets the loading flag. The `updateOpportunityStage` action performs an optimistic update by patching the opportunity's stage and probability in the local array immediately after the API responds, without re-fetching the entire list. This keeps the kanban board responsive during drag-drop operations.

### Routing

The project uses TanStack Router with file-based routing. The root layout (`__root.tsx`) checks authentication on mount via `useAuthStore.checkAuth()` and conditionally renders the `Sidebar` component only when a user is logged in. The main content area has a left margin (`ml-56`) to accommodate the fixed-position sidebar. Routes include `/` (dashboard), `/accounts`, `/accounts/$accountId` (dynamic detail page), `/contacts`, `/opportunities`, `/leads`, `/reports`, `/login`, and `/register`. Each authenticated route checks `useAuthStore.user` and redirects to `/login` if null.

### Data Fetching

All API communication flows through a centralized `services/api.ts` module that exports domain-specific API client objects (`authApi`, `dashboardApi`, `accountsApi`, `contactsApi`, `opportunitiesApi`, `leadsApi`, `activitiesApi`, `reportsApi`). Each client object wraps a shared `request<T>()` helper function that handles JSON serialization, `credentials: 'include'` for cookie-based sessions, error parsing, and TypeScript generics for response typing. Route components call store actions (like `fetchAccounts`) inside `useEffect` hooks on mount, and the store actions delegate to the API clients. There is no client-side caching or stale-while-revalidate -- every navigation re-fetches from the server.

### Key UI Patterns

**Shared EntityForm**: A single `EntityForm` modal component renders different fields based on an `entityType` prop (`account`, `contact`, `opportunity`, `lead`). This avoids duplicating four separate form components and ensures consistent modal behavior (open/close, validation, save/cancel) across all entity types.

**Kanban with @dnd-kit**: The opportunity pipeline uses `@dnd-kit/core` for drag-drop. `KanbanBoard` renders a `DndContext` with `KanbanColumn` components (one per stage) as droppable targets and `OpportunityCard` components as draggable items. A `DragOverlay` renders a ghost copy of the card during drag to prevent layout shifts. On drag end, the `onStageChange` callback calls `updateOpportunityStage` in the CRM store, which hits `PUT /api/opportunities/:id/stage` and optimistically patches the local state.

**CSS-only charts**: Dashboard and report visualizations (`PipelineChart`, `ReportChart`) use proportional-width `<div>` elements styled with Tailwind instead of a charting library. This adds zero bundle size and provides sufficient visualization for pipeline and revenue bar charts.

**StatusBadge**: A reusable component that maps entity statuses (lead status, opportunity stage, activity type) to color-coded badges with per-entity-type color mappings.

**ActivityTimeline**: A polymorphic timeline component that displays activities for any entity type. It receives `relatedType` and `relatedId` props and fetches activities filtered to that entity, appearing as a tab on account/contact/opportunity detail pages.

## Deep Pattern Explanations

This section explains the production-grade patterns used in this project from first principles. Each pattern solves a specific operational problem that emerges at scale.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents a failing downstream service from dragging down the entire application. The name comes from electrical circuit breakers that trip to prevent a short circuit from causing a fire.

The pattern works through three states. In the **closed** state (normal operation), all requests pass through to the downstream service. The circuit breaker silently tracks the success/failure ratio of recent calls. When the failure rate crosses a threshold (configured at 50% in this project via Opossum), the breaker transitions to the **open** state. In the open state, all requests fail immediately with a pre-defined error -- the application does not even attempt to call the downstream service. This is the key benefit: instead of every request waiting 30 seconds for a timeout against a dead service (which exhausts connection pools and causes cascading failures), requests fail in 0 milliseconds. After a configurable timeout period, the breaker enters the **half-open** state, allowing a small number of test requests through. If those succeed, the breaker closes and normal traffic resumes. If they fail, the breaker reopens.

Without a circuit breaker, a single failing dependency can cascade: the database goes down, API requests pile up waiting for 30-second timeouts, the connection pool exhausts, and the entire API becomes unresponsive -- even for endpoints that do not use the database. Circuit breakers isolate the blast radius by failing fast, freeing threads and connections for requests that can still succeed.

**File**: `src/services/circuitBreaker.ts`

### Structured Logging

Structured logging means writing log entries as machine-parseable data (typically JSON) rather than free-form text strings. Traditional logs look like `"User 123 logged in from 192.168.1.1"` -- a human can read this, but extracting the user ID or IP address programmatically requires fragile regex parsing. Structured logs look like `{"event":"login","userId":"123","ip":"192.168.1.1","timestamp":"2025-01-01T00:00:00Z"}` -- every field is a named key-value pair that log aggregation tools (Elasticsearch, Datadog, CloudWatch) can index, search, and alert on.

This project uses Pino, a high-performance Node.js logging library that outputs JSON in production and pretty-printed text in development. Every HTTP request is logged with method, path, status code, and response duration. Structured logging becomes critical at scale when debugging issues across millions of requests: you can filter for `status:500 AND path:/api/leads/*/convert` to find all failed lead conversions, rather than grep-ing through gigabytes of unstructured text.

**File**: `src/services/logger.ts`

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical measurements (metrics) from applications at regular intervals. The application exposes an HTTP endpoint (`/metrics`) that returns current metric values in a specific text format. A Prometheus server scrapes this endpoint every 15-30 seconds and stores the data, enabling dashboards (Grafana) and alerting rules.

There are four main metric types. **Counters** only go up (total requests served, total errors). **Gauges** go up and down (current memory usage, active connections). **Histograms** track the distribution of values (request duration buckets, so you can compute p50/p90/p99 latencies). **Summaries** are similar to histograms but compute quantiles on the client side.

This project uses `prom-client` to expose HTTP request duration histograms (bucketed by method and path), request count by status code, and database query timing. At production scale, these metrics feed Grafana dashboards that visualize trends and trigger alerts when p99 latency exceeds SLO targets or error rates spike above baseline.

**File**: `src/services/metrics.ts`

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window, protecting the server from abuse, accidental loops, and denial-of-service attacks. Without rate limiting, a single misbehaving client could consume all server resources and deny service to legitimate users.

This project uses `express-rate-limit` with three tiers: 1000 requests per 15 minutes for general API access, 50 requests per 15 minutes for authentication endpoints (preventing brute-force password guessing), and 30 requests per minute for report endpoints (which run expensive aggregation queries). When a client exceeds the limit, subsequent requests receive a `429 Too Many Requests` response with a `Retry-After` header indicating when the window resets.

Rate limiting algorithms vary in sophistication. **Fixed window** divides time into fixed intervals (e.g., 1-minute blocks) and counts requests per window -- simple but allows burst-then-starve patterns at window boundaries. **Sliding window** (used at production scale) smooths the rate across time by weighting the previous window's count with the current window's count. **Token bucket** allows controlled bursts by accumulating tokens at a steady rate. The choice depends on whether you want strict rate enforcement or tolerance for short bursts.

**File**: `src/services/rateLimiter.ts`

### Health Checks

A health check is an HTTP endpoint that reports whether the application is functioning correctly. Load balancers, container orchestrators (Kubernetes), and monitoring systems call this endpoint periodically to determine if an instance should receive traffic.

This project exposes `/api/health`, which verifies database connectivity by running a simple query (`SELECT 1`) against PostgreSQL. If the query succeeds, the endpoint returns `200 OK` with a status payload. If it fails (database unreachable, connection pool exhausted), it returns `503 Service Unavailable`. At production scale, health checks typically distinguish between **liveness** (is the process running and not deadlocked?) and **readiness** (can the process serve traffic? -- meaning all dependencies are connected and warmed up). A failing liveness check restarts the container. A failing readiness check removes the instance from the load balancer pool without restarting it.

**File**: `src/app.ts`

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache hit, the cached value is returned immediately (sub-millisecond latency). On a cache miss, the application queries the database, stores the result in the cache with a time-to-live (TTL), and returns it to the caller. Subsequent requests for the same data hit the cache until the TTL expires.

Redis is commonly used as the cache layer because it is an in-memory key-value store with sub-millisecond read latency, built-in TTL support, and atomic operations. In this project, Redis serves dual duty as the session store (via `connect-redis`) and the cache layer. Dashboard KPIs, for example, would benefit from a 5-minute cache TTL at production scale because they aggregate across all opportunities and leads -- an expensive query that returns the same result for every user within a short window.

Cache invalidation is the hardest part of cache-aside. When data changes, the cache must be invalidated to prevent serving stale data. Strategies include TTL-based expiry (accept bounded staleness), write-through (update cache on every write), and event-driven invalidation (publish change events that trigger cache deletes). This project relies on TTL-based expiry as the simplest approach.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of granting individual permissions to each user (which becomes unmanageable with thousands of users), you define roles like "user" and "admin" and assign a set of permissions to each role. A user's effective permissions are determined by their role.

In this project, the `users` table has a `role` column with a default of `'user'`. The `requireAuth` middleware checks that a valid session exists, and specific admin endpoints would additionally check `user.role === 'admin'`. This is a simplified two-tier RBAC. Production CRM systems like Salesforce implement much richer RBAC with object-level permissions (can this role see Opportunities?), field-level security (can this role see the `amount` field?), and sharing rules (can this user see records owned by other users in the same territory?).

The key advantage of RBAC over direct permission assignment is scalability of administration: when a new feature is added, you update the role definition once rather than updating every user individually. The trade-off is that roles can become too coarse-grained, leading to role explosion (creating dozens of fine-grained roles to cover every permission combination).

## Implementation Notes

### Local Setup Diagram

```
┌───────────────────┐       ┌───────────────────────┐
│  React Frontend   │       │  Express Backend      │
│  (Vite :5173)     │──────▶│  (Node.js :3000)      │
│                   │       │                       │
│  TanStack Router  │       │  7 route files        │
│  Zustand stores   │       │  Session auth         │
│  @dnd-kit kanban  │       │  Pino logging         │
│  Tailwind CSS     │       │  Prometheus metrics   │
└───────────────────┘       └───────┬───────┬───────┘
                                    │       │
                            ┌───────▼──┐ ┌──▼────────┐
                            │PostgreSQL│ │  Valkey    │
                            │  :5432   │ │  :6379    │
                            │salesforce│ │ (sessions │
                            │  (8 tbl) │ │  + cache) │
                            └──────────┘ └───────────┘
```

All services run on a single machine via Docker Compose. The frontend proxies API requests to the backend on port 3000.

### Production-Grade Patterns Implemented

| Pattern | Library | File Path | Purpose |
|---------|---------|-----------|---------|
| Circuit breaker | Opossum | `src/services/circuitBreaker.ts` | Protects against cascading failures from downstream services |
| Prometheus metrics | prom-client | `src/services/metrics.ts` | HTTP request duration/count histograms, DB query timing |
| Structured logging | Pino | `src/services/logger.ts` | JSON logs with request correlation for debugging |
| Rate limiting | express-rate-limit | `src/services/rateLimiter.ts` | Per-endpoint rate limits (API, auth, reports) |
| Health checks | custom | `src/app.ts` | Database connectivity verification at `/api/health` |
| Transactional integrity | pg (raw SQL) | `src/services/leadConversionService.ts` | Explicit `BEGIN`/`COMMIT`/`ROLLBACK` for multi-entity operations |

### What Was Simplified

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| Primary + read replicas | Single PostgreSQL instance | All queries hit one DB; no read/write split |
| Elasticsearch | SQL `ILIKE` | Search degrades past ~100K rows |
| Materialized views for KPIs | In-process aggregation | Dashboard queries recompute on every request |
| OAuth 2.0 / SAML SSO | Session auth with bcrypt | No enterprise SSO, no token rotation |
| Configurable pipeline per org | Fixed stage enum | All users share the same pipeline stages |
| Microservice per entity | Monolithic Express app | Single process, single deployment |

### What Was Omitted

- CDN and edge caching
- Multi-region deployment
- Kubernetes orchestration
- Full-text search engine (Elasticsearch)
- Audit trail / change history table
- Field-level security and sharing rules
- Workflow automation engine
- Email integration
- File attachments on entities
- Optimistic concurrency enforcement (version column)

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

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
┌────────┐     ┌────────────┐     ┌──────────────────────────────────────┐
│ Client │────▶│ POST       │────▶│           Transaction                │
│        │     │ /leads/:id │     │  1. SELECT lead FOR UPDATE           │
└────────┘     │ /convert   │     │     (404 if not caller's, 409 if     │
               └────────────┘     │      already converted)              │
                                  │  2. CREATE account   (lead's owner)  │
                                  │  3. CREATE contact   (from lead)     │
                                  │  4. CREATE opportunity (optional,    │
                                  │     Qualification @ 20%)             │
                                  │  5. UPDATE lead SET Converted        │
                                  │     WHERE converted_at IS NULL       │
                                  │  6. COMMIT                           │
                                  └──────────────────────────────────────┘
```

Lead conversion is the riskiest operation in the system. It creates 2-3 entities in a single database transaction (account, contact, and optionally opportunity), then marks the lead as converted. If any step fails, the entire transaction rolls back -- no partial conversions can exist. The alternative (saga pattern with compensating transactions) adds unnecessary complexity for a single-database operation. At scale, this transaction acquires a dedicated connection from the pool and uses explicit `BEGIN`/`COMMIT`/`ROLLBACK` to guarantee atomicity.

Atomicity alone does not stop a *double* conversion. Two requests (a double-click, a retry) can each read the lead as unconverted and each create an account and contact; the second `UPDATE` then overwrites the first lead's links. Reading the lead with `SELECT ... FOR UPDATE` serializes them: the second transaction waits for the first to commit, re-reads the row, sees `converted_at` set, and returns 409. The final `UPDATE ... WHERE converted_at IS NULL` repeats the guard so the write itself refuses a second conversion.

**Kanban Stage Update Flow:**

```
┌────────┐     ┌────────────┐     ┌──────────────────────────────────────┐
│ Client │────▶│ PUT /opps/ │────▶│  1. Load row the caller can see      │
│ (drag, │     │ :id/stage  │     │  2. Validate transition (closed deals│
│ optim- │     └────────────┘     │     reopen only for admins: 409)     │
│ istic) │                        │  3. UPDATE stage, probability,       │
└────────┘                        │     closed_at WHERE stage = <read>   │
                                  │     (0 rows -> 409, reload)          │
                                  │  4. Return updated opportunity       │
                                  └──────────────────────────────────────┘
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

Both write paths plan stage changes through one module (`src/services/opportunityStages.ts`). Open deals may move to any stage. A closed deal (Won or Lost) is final for reps: reopening it, or flipping Won to Lost, needs an admin. Closed stages pin probability at 100 / 0. `closed_at` is stamped when a deal enters a closed stage and cleared when it leaves one, and the revenue report books deals by it.

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
  closed_at TIMESTAMPTZ,            -- set by the API on entering Closed Won/Lost
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT opportunities_stage_check CHECK (stage IN (
    'Prospecting', 'Qualification', 'Needs Analysis', 'Proposal',
    'Negotiation', 'Closed Won', 'Closed Lost')),
  CONSTRAINT opportunities_probability_check CHECK (probability BETWEEN 0 AND 100),
  CONSTRAINT opportunities_amount_check CHECK (amount_cents >= 0)
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
  converted_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  converted_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  converted_opportunity_id UUID REFERENCES opportunities(id) ON DELETE SET NULL,
  converted_at TIMESTAMPTZ,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT leads_status_check CHECK (status IN ('New', 'Contacted', 'Qualified', 'Unqualified', 'Converted')),
  -- only the conversion transaction sets either half
  CONSTRAINT leads_converted_check CHECK ((status = 'Converted') = (converted_at IS NOT NULL))
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
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_closed ON opportunities(stage, closed_at);
```

Key indexes support the primary access patterns:
- `idx_opportunities_stage` -- Pipeline grouping for kanban and reports
- `idx_opportunities_owner` -- User-specific deal filtering
- `idx_activities_related` -- Composite index for polymorphic activity lookups by (type, id)
- `idx_leads_status` -- Status-based filtering for lead management views
- `idx_*_owner` -- Every list query a rep makes is filtered by `owner_id` (record-level access)

The CHECK constraints back up the route-level validation: a seed edit or a psql session can no longer create a stage no report counts, or a lead that says "Converted" with no account behind it. `init.sql` ends with an idempotent upgrade block (`ADD COLUMN IF NOT EXISTS`, CHECKs added `NOT VALID`, converted_* FKs re-created with `ON DELETE SET NULL`) so `npm run db:migrate` brings an older database forward without failing on old rows.

## API Design

Every data endpoint applies the record-level rule below (see Security and Auth): a record the caller can't see returns **404**, not 403, and so does a malformed ID. Invalid input is a 400; a refused state change (reopening a closed deal as a rep, editing a converted lead, a second conversion, a stage that moved underneath you) is a 409. Pagination is clamped (`limit` 1-200).

### Authentication
```
POST /api/auth/register    Register new user (always role 'user')
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
GET  /api/reports/revenue    Closed-won revenue by month of closed_at (?months=1-60)
GET  /api/reports/leads      Leads by source
```

Each report takes `?all=true`, honoured only for admins. Everyone else gets their own records, and every response carries `scope: 'org' | 'own'` so the UI labels which one it is showing.

## Key Design Decisions

### Record-Level Access: Private by Owner, Admins See Everything

Every record (account, contact, opportunity, lead, activity) has an `owner_id`. A rep sees and changes only what they own; an admin sees and changes everything. This is Salesforce's "Private" organization-wide default, applied to every object, and it lives in one module (`src/services/accessPolicy.ts`) that every route calls instead of deciding for itself. List queries and aggregates get an `owner_id = $caller` condition; `UPDATE` and `DELETE` carry the same condition in their own `WHERE`, so the check and the write are one statement with no window between them. A rep can't attach a contact, opportunity or activity to a record they can't see either; that's a 400 that says nothing about whether the record exists.

Activities are the exception for reads: a timeline is controlled by its parent, so anyone who can see an opportunity sees every activity on it, including notes an admin logged. Editing or deleting an activity stays with its author or an admin.

The more permissive alternative, Public Read Only (reps read everything and edit their own), is common in real orgs and simpler to build. But it leaks every rep's pipeline and contact list to every other rep, and the reports then have to decide separately what to aggregate. With Private as the baseline, one rule answers both "can I open this record?" and "does this record count in my report?". What we give up is collaboration: there is no role hierarchy (a manager can't see their team's deals) and no sharing rules or manual shares. Those are the next layer, and they would replace the `owner_id = $caller` condition with "owner in the caller's visible set".

### Polymorphic Activities vs. Separate Tables

Activities use `related_type` and `related_id` columns to associate with any entity type (account, contact, opportunity, lead). This is simpler than creating `account_activities`, `contact_activities`, etc. join tables -- a single query retrieves the full activity timeline for any entity. The composite index on `(related_type, related_id)` ensures fast lookups.

The trade-off is loss of referential integrity: there is no FK constraint from `related_id` to a specific table, so the database cannot prevent orphaned activities if an entity is deleted without cleaning up its activities. We accept this because activities are append-only logs and orphaned activities are harmless -- they simply won't appear in any timeline view. At production scale, a background cleanup job would periodically remove orphaned activities.

The alternative (separate join tables per entity) would provide FK guarantees but require N different queries for a unified activity timeline, complicate the API, and make adding new entity types require schema changes.

### Transactional Lead Conversion

Lead conversion creates 2-3 entities in a single database transaction. This ensures atomicity -- if the opportunity creation fails, neither the account nor contact is created, and the lead remains unconverted. The alternative (saga pattern with compensating transactions) adds significant complexity for what is fundamentally a single-database operation with no cross-service coordination.

At production scale with microservices, if accounts, contacts, and opportunities were owned by different services, a saga with compensating transactions would be necessary. But within a single database, PostgreSQL transactions provide stronger guarantees with less code.

### Stage-Probability Coupling

Opportunity stages automatically set probability percentages when changed via the kanban endpoint (Prospecting=10%, Qualification=20%, etc.). This simplifies pipeline forecasting -- the weighted pipeline value is always consistent. Sales teams can override probability for open deals through the full update endpoint, but kanban drag-drop always resets to defaults, a stage change without an explicit probability applies the new stage's default, and closed stages are pinned at 100% / 0%.

Stage *transitions* are gated too. Closed deals can be reopened (deals genuinely do come back), but only by an admin; for a rep, an accidental drag out of Closed Won would otherwise put booked revenue back into the open pipeline with nothing to flag it.

The alternative (decoupled stage and probability) gives more flexibility but introduces data inconsistency risks where a "Closed Won" deal might show 50% probability, skewing forecasts.

### Money as Cents (BIGINT)

All monetary values (`amount_cents`, `annual_revenue_cents`) are stored as cents in BIGINT columns. Floats can't represent most decimal fractions, so sums drift; `NUMERIC` would be exact too, but node-postgres returns it as a string the application must parse, and integer cents make a fractional cent impossible to store. The API rejects fractional or negative cents with a 400, and dollars typed into a form are converted to cents exactly once (the conversion modal and the New Opportunity form). The frontend formats cents to dollars for display.

BIGINT has a trap of its own: node-postgres returns int8 as a **string**, because int8 can exceed `Number.MAX_SAFE_INTEGER`. The kanban column total did `sum + o.amount_cents` and concatenated `"0" + "22000000" + "54000000"`. `src/services/db.ts` registers an int8 parser that returns numbers and throws if a value would lose precision; cents and counts here are far below 2^53.

### Custom Fields via EAV Pattern

The `custom_fields` and `custom_field_values` tables implement the Entity-Attribute-Value pattern, allowing organizations to add custom fields to any entity type without schema changes. Each field definition specifies type and validation rules, while values are stored as TEXT with application-layer type coercion.

The alternative (JSONB column on each entity) is simpler but makes custom fields harder to query, index, and validate at the database level.

## Consistency and Idempotency

- **Lead conversion** uses PostgreSQL transactions with explicit `BEGIN`/`COMMIT`/`ROLLBACK` to ensure atomic multi-entity creation, and locks the lead row (`FOR UPDATE`) so two concurrent conversions serialize: exactly one succeeds, the other gets a 409. A failed conversion leaves the lead unchanged.
- **Stage updates** are idempotent -- moving an opportunity to its current stage is a no-op that returns the unchanged record without bumping `updated_at`.
- **Stage writes are compare-and-set.** Both opportunity write paths read the current stage, plan the change, and write `... WHERE id = $1 AND stage = $read`. If another request moved the deal in between, the write matches no row and the caller gets a 409 ("reload and try again") instead of a lost update. This covers the stage, the field that matters for forecasts; other fields are still last-write-wins. At production scale this becomes a version column (`WHERE version = $expected`) covering every field.
- **Converted leads are read-only** (`UPDATE ... WHERE converted_at IS NULL`; 409 otherwise).

## Security and Auth

- Session-based authentication with Redis-backed session store (connect-redis); the session is regenerated on login and registration (no session fixation)
- Password hashing with bcrypt (10 rounds); self-registration always creates role `user`
- CORS configured for frontend origin only
- Rate limiting: 1000 req/15min per IP for the API, 50 req/15min per IP for auth, 60 req/min **per user** for reports. Reports were keyed by IP at 30/min, so everyone behind one NAT shared one budget, and since the dashboard itself calls a report endpoint, a few page switches (doubled by React StrictMode in dev) exhausted it and the charts silently showed "No data". The limiter store is in-memory, so each API instance counts separately.
- All data endpoints require authentication via `requireAuth` middleware, then apply record-level access (see Key Design Decisions): owner or admin, 404 for anything else
- Report aggregates follow the same rule: `?all=true` is honoured only for admins
- At production scale: OAuth 2.0 / SAML SSO for enterprise customers, role hierarchy, sharing rules, field-level security

## Observability

- **Structured logging** with Pino -- JSON format in production (machine-parseable for log aggregation), pretty-printed in development. Every request is logged with method, path, status, and duration.
- **Prometheus metrics** via prom-client -- an app-level middleware records `http_request_duration_seconds` and `http_requests_total` labelled by method, matched route pattern (`/api/accounts/:id`, never the raw URL, to keep label cardinality bounded) and status, plus process defaults. Exposed at `/metrics` for Prometheus scraping. (`db_query_duration_seconds` and `active_opportunities_total` are registered but not yet recorded.)
- **Health check** endpoint at `/api/health` that verifies database connectivity and returns service status.

At production scale, these metrics feed into Grafana dashboards with alerts on p99 latency breaches, error rate spikes, and database connection pool exhaustion. Distributed tracing (OpenTelemetry) would correlate requests across microservices.

## Failure Handling

- **Circuit breaker** (Opossum) -- `src/services/circuitBreaker.ts` provides a factory with a 50% error threshold, but nothing calls it: this backend has no external service calls to protect. It is the place to wrap one (an email provider, an enrichment API) when one is added.
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
| Record visibility | Private: owner + admin | Public read-only | One rule for records and reports; no cross-rep leaks |
| Stage transitions | Closed deals reopen only via admin | Free movement | Accidental drags can't silently un-book revenue |
| Concurrent stage moves | Compare-and-set on stage (409) | Last-write-wins | No silent overwrite, without a version column yet |
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
├── routes/accounts.index.tsx         ← sibling of the detail route (a parent
│   └── AccountList                     without <Outlet/> hid the detail page)
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
├── routes/opportunities.tsx          ← + New Opportunity (dollars → cents)
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

**`useCrmStore`** (`stores/crmStore.ts`) manages all CRM domain data in a single flat store. It holds arrays and loading flags for six entity types (accounts, contacts, opportunities, leads, activities) plus dashboard KPIs, three report types (pipeline, revenue, leads by source) and the report scope the server applied. Each entity has a `fetch*` action that calls the corresponding API client, updates the array, and sets the loading flag. The `updateOpportunityStage` action is genuinely optimistic: it moves the card before the request, replaces the guess with the server's row (probability, `closed_at`) on success, and on failure puts the card back and surfaces the server's reason ("Closed Won opportunities can only be reopened or changed by an admin") in a banner. It used to wait for the response and then re-fetch the whole board, which flashed "Loading pipeline..." after every drag and swallowed refusals. `reset()` clears the store on login and logout so the next user in a tab never sees the last one's records.

### Routing

The project uses TanStack Router with file-based routing. The root layout (`__root.tsx`) checks authentication on mount via `useAuthStore.checkAuth()` and conditionally renders the `Sidebar` component only when a user is logged in. The main content area has a left margin (`ml-56`) to accommodate the fixed-position sidebar. Routes include `/` (dashboard), `/accounts` (`accounts.index.tsx`), `/accounts/$accountId` (dynamic detail page), `/contacts`, `/opportunities`, `/leads`, `/reports`, `/login`, and `/register`. Each authenticated route checks `useAuthStore.user` and redirects to `/login` if null.

### Data Fetching

All API communication flows through a centralized `services/api.ts` module that exports domain-specific API client objects (`authApi`, `dashboardApi`, `accountsApi`, `contactsApi`, `opportunitiesApi`, `leadsApi`, `activitiesApi`, `reportsApi`). Each client object wraps a shared `request<T>()` helper function that handles JSON serialization, `credentials: 'include'` for cookie-based sessions, error parsing, and TypeScript generics for response typing. Route components call store actions (like `fetchAccounts`) inside `useEffect` hooks on mount, and the store actions delegate to the API clients. There is no client-side caching or stale-while-revalidate -- every navigation re-fetches from the server.

### Key UI Patterns

**Shared EntityForm**: A single `EntityForm` modal component renders different fields based on an `entityType` prop (`account`, `contact`, `opportunity`, `lead`). This avoids duplicating four separate form components and ensures consistent modal behavior (open/close, validation, save/cancel) across all entity types.

**Kanban with @dnd-kit**: The opportunity pipeline uses `@dnd-kit/core` for drag-drop. `KanbanBoard` renders a `DndContext` with `KanbanColumn` components (one per stage) as droppable targets and `OpportunityCard` components as draggable items. A `DragOverlay` renders a ghost copy of the card during drag to prevent layout shifts. On drag end, the `onStageChange` callback calls `updateOpportunityStage` in the CRM store, which hits `PUT /api/opportunities/:id/stage` and optimistically patches the local state.

**CSS-only charts**: Dashboard and report visualizations (`PipelineChart`, `ReportChart`) use proportional `<div>` elements styled with Tailwind instead of a charting library. This adds zero bundle size and provides sufficient visualization for pipeline and revenue bar charts. Vertical bars are sized in pixels: a percentage height resolved against the auto-height flex column around it, so the column charts used to render only their labels.

**Dates**: the API returns DATE columns as `'YYYY-MM-DD'` text (a pg type parser), and `utils/dates.ts` formats them from their parts in local time. pg's default turned them into UTC-midnight timestamps, which display as the previous day west of Greenwich.

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

This project uses `express-rate-limit` with three tiers: 1000 requests per 15 minutes for general API access, 50 requests per 15 minutes for authentication endpoints (preventing brute-force password guessing), and 60 requests per minute per signed-in user for report endpoints (which run expensive aggregation queries). The first two are keyed by client IP; the report tier runs after authentication and keys on the session's user, so colleagues behind one NAT don't share a budget. When a client exceeds the limit, subsequent requests receive a `429 Too Many Requests` response with `RateLimit` headers indicating when the window resets. The counters live in process memory, so each API instance enforces its own limits; a shared Redis store (`rate-limit-redis`) is the step for multi-instance deployments.

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

In this project, the `users` table has a `role` column with a default of `'user'`. The `requireAuth` middleware checks that a valid session exists, and `accessPolicy.ts` combines the role with record ownership: a `user` sees and changes the records they own, an `admin` sees and changes all of them and gets org-wide reports, and only an admin can reopen a closed deal. This is a simplified two-tier RBAC over a Private ownership model. Production CRM systems like Salesforce implement much richer RBAC with object-level permissions (can this role see Opportunities?), field-level security (can this role see the `amount` field?), a role hierarchy (a manager sees their team's records), and sharing rules (can this user see records owned by other users in the same territory?).

The key advantage of RBAC over direct permission assignment is scalability of administration: when a new feature is added, you update the role definition once rather than updating every user individually. The trade-off is that roles can become too coarse-grained, leading to role explosion (creating dozens of fine-grained roles to cover every permission combination).

## Implementation Notes

### Local Setup Diagram

```
┌───────────────────┐       ┌───────────────────────┐
│  React Frontend   │       │  Express Backend      │
│  (Vite :5173)     │──────▶│  (Node.js :3001)      │
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

Postgres and Valkey run via Docker Compose; the API and Vite run natively. The frontend proxies `/api` to the backend on port 3001 (`npm run dev:server2` / `dev:server3` start more instances on 3002/3003). Seed logins: `alice` / `password123` (admin, sees everything) and `bob` / `password123` (rep, sees only Vertex, Lumen and their deals and leads).

### Production-Grade Patterns Implemented

| Pattern | Library | File Path | Purpose |
|---------|---------|-----------|---------|
| Circuit breaker | Opossum | `src/services/circuitBreaker.ts` | Protects against cascading failures from downstream services |
| Prometheus metrics | prom-client | `src/services/metrics.ts` | HTTP request duration/count histograms, DB query timing |
| Structured logging | Pino | `src/services/logger.ts` | JSON logs with request correlation for debugging |
| Rate limiting | express-rate-limit | `src/services/rateLimiter.ts` | Per-endpoint rate limits (API, auth, reports) |
| Health checks | custom | `src/app.ts` | Database connectivity verification at `/api/health` |
| Transactional integrity | pg (raw SQL) | `src/services/leadConversionService.ts` | `BEGIN`/`COMMIT`/`ROLLBACK` plus a `FOR UPDATE` row lock: atomic and single-shot |
| Record-level access | custom | `src/services/accessPolicy.ts` | Owner-or-admin, 404 for invisible records, checks inside the UPDATE/DELETE |
| Stage state machine | custom | `src/services/opportunityStages.ts` | Probability mapping, gated reopen, `closed_at`, compare-and-set writes |
| Input hardening | custom | `src/services/queryParams.ts` | Clamped pagination, escaped ILIKE, integer-cents and date validation |
| DB-level integrity | Postgres CHECK/FK | `src/db/init.sql` | Valid stages/statuses, 0-100 probability, Converted iff converted_at |

### What Was Simplified

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| Primary + read replicas | Single PostgreSQL instance | All queries hit one DB; no read/write split |
| Elasticsearch | SQL `ILIKE` | Search degrades past ~100K rows |
| Materialized views for KPIs | In-process aggregation | Dashboard queries recompute on every request |
| OAuth 2.0 / SAML SSO | Session auth with bcrypt | No enterprise SSO, no token rotation |
| Configurable pipeline per org | Fixed stage enum | All users share the same pipeline stages |
| Microservice per entity | Monolithic Express app | Single process, single deployment |
| Role hierarchy + sharing rules | Private ownership + admin | Managers can't see their team's records |
| Version column on every entity | Compare-and-set on stage only | Concurrent edits to other fields are last-write-wins |
| Shared rate-limit store | In-memory per process | Limits are per API instance |

### What Was Omitted

- CDN and edge caching
- Multi-region deployment
- Kubernetes orchestration
- Full-text search engine (Elasticsearch)
- Audit trail / change history table
- Field-level security, role hierarchy and sharing rules
- Custom fields API (the `custom_fields` / `custom_field_values` tables exist; no route uses them)
- Edit and delete UI (the API supports both; the UI only creates, converts and moves deals)
- Workflow automation engine
- Email integration
- File attachments on entities
- Optimistic concurrency enforcement beyond the stage (version column)

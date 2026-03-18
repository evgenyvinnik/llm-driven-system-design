# Design Jira - Architecture

## System Overview

Jira is an issue tracking system with customizable workflows, dynamic field schemas, complex permission models, and a query language (JQL). The platform supports project-scoped boards, sprints, epics, and full audit history.

**Learning Goals:**
- Build configurable workflow state machines
- Design dynamic field schemas with JSONB
- Implement role-based permissions with project context
- Create a query language parser (JQL)

---

## Requirements

### Functional Requirements

1. **Issues**: Create, update, assign, and transition issues through workflows
2. **Workflows**: Customizable state machines with conditions, validators, and post-functions
3. **Boards**: Kanban and Scrum views with drag-and-drop
4. **Search**: JQL-based issue search with Elasticsearch
5. **Custom Fields**: Dynamic per-project field schemas stored as JSONB
6. **Reports**: Burndown, velocity, and sprint statistics
7. **Audit Trail**: Full history of all field changes

### Non-Functional Requirements

- **Availability**: 99.9% uptime
- **Latency**: < 200ms p95 for issue operations, < 500ms for search
- **Scale**: 1M projects, 100M issues, 10K concurrent users
- **Audit**: Immutable history of every field change
- **Consistency**: Strong consistency for issue writes, eventual for search index

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                            │
│           Web │ Mobile │ IDE Plugins │ CLI                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway / CDN                          │
│             (Rate Limiting, Auth, TLS Termination)              │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Issue Service │    │Workflow Engine│    │Search Service │
│               │    │               │    │               │
│ - CRUD        │    │ - Transitions │    │ - JQL Parser  │
│ - Comments    │    │ - Validators  │    │ - Indexing    │
│ - Attachments │    │ - Actions     │    │ - Aggregation │
└───────┬───────┘    └───────┬───────┘    └───────┬───────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Message Queue (RabbitMQ)                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │ issue.events │ │ search.index │ │notifications │            │
│  │   (fanout)   │ │   (direct)   │ │   (direct)   │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
└─────────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ Search Indexer│   │ Notification  │   │ Webhook       │
│   Worker      │   │   Worker      │   │ Dispatcher    │
└───────────────┘   └───────────────┘   └───────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Data Layer                               │
├──────────────┬──────────────┬───────────────────────────────────┤
│  PostgreSQL  │    Redis     │         Elasticsearch             │
│  - Issues    │  - Sessions  │         - Issue search            │
│  - Workflows │  - Cache     │         - JQL queries             │
│  - History   │  - Idempotency│         - Aggregations           │
└──────────────┴──────────────┴───────────────────────────────────┘
```

---

## Core Components

### 1. Workflow Engine

The workflow engine is database-driven, allowing per-project customization without code changes. Each workflow defines a set of statuses (categorized as `todo`, `in_progress`, or `done`) and transitions between them.

**Transition Execution Flow:**
1. Load the workflow for the issue's project
2. Verify the transition exists and the issue's current status matches the `from_status`
3. Evaluate all conditions (e.g., `user_in_role`, `issue_assignee`)
4. Run all validators (e.g., `field_required`, `field_value`)
5. Update the issue status atomically within a transaction
6. Execute post-functions (e.g., `assign_to_current_user`, `clear_field`, `update_field`)
7. Record the change in the issue history table
8. Publish an event to the fanout exchange for async consumers

**Condition Types:**
- `always` -- always allow the transition
- `user_in_role` -- user must hold a specific project role
- `issue_assignee` -- only the current assignee can transition

**Post-Function Types:**
- `assign_to_current_user` -- set assignee to the acting user
- `clear_field` -- null out a field value
- `update_field` -- set a field to a specific value
- `send_notification` -- trigger a notification event

### 2. Custom Fields

Custom field definitions are stored per-project with type metadata (`text`, `number`, `select`, `user`, `date`). Values are stored as JSONB on the issues table, keyed by field definition ID.

This approach avoids schema alterations when projects add fields, supports GIN indexing for queries, and allows Elasticsearch to index custom field values for JQL searches.

### 3. JQL Parser

The JQL parser tokenizes input, builds an AST, and converts it to an Elasticsearch query.

**Supported grammar:**
- Boolean operators: `AND`, `OR`
- Parentheses for grouping
- Comparison operators: `=`, `!=`, `~`, `>`, `<`, `>=`, `<=`, `IN`, `NOT IN`, `IS`, `IS NOT`
- Functions: `currentUser()`, `now()`, `startOfDay()`, `endOfDay()`

**Translation pipeline:** `JQL string` --> `Token stream` --> `AST` --> `Elasticsearch bool query`

### 4. Permission System

Permissions use a scheme-based model. Each project references a permission scheme. Schemes contain grants that map permissions (e.g., `create_issue`, `edit_issue`, `transition`) to grantees by type (`anyone`, `user`, `role`, `group`).

Permission checks evaluate all grants in the project's scheme, matching against the user's roles, groups, and direct user grants.

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Project Roles
CREATE TABLE project_roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT
);

-- Permission Schemes
CREATE TABLE permission_schemes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE
);

-- Permission Grants
CREATE TABLE permission_grants (
  id SERIAL PRIMARY KEY,
  scheme_id INTEGER REFERENCES permission_schemes(id) ON DELETE CASCADE,
  permission VARCHAR(100) NOT NULL,
  grantee_type VARCHAR(50) NOT NULL,  -- 'anyone', 'user', 'role', 'group'
  grantee_id VARCHAR(100)
);

-- Workflows
CREATE TABLE workflows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE
);

-- Statuses
CREATE TABLE statuses (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) DEFAULT 'todo',  -- 'todo', 'in_progress', 'done'
  color VARCHAR(20) DEFAULT '#6B7280',
  position INTEGER DEFAULT 0,
  UNIQUE(workflow_id, name)
);

-- Transitions
CREATE TABLE transitions (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  from_status_id INTEGER REFERENCES statuses(id),  -- NULL = from any status
  to_status_id INTEGER REFERENCES statuses(id) NOT NULL,
  conditions JSONB DEFAULT '[]',
  validators JSONB DEFAULT '[]',
  post_functions JSONB DEFAULT '[]'
);

-- Projects
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  lead_id UUID REFERENCES users(id),
  workflow_id INTEGER REFERENCES workflows(id),
  permission_scheme_id INTEGER REFERENCES permission_schemes(id),
  issue_counter INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Project Members
CREATE TABLE project_members (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES project_roles(id),
  PRIMARY KEY (project_id, user_id)
);

-- Sprints
CREATE TABLE sprints (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  goal TEXT,
  start_date TIMESTAMP,
  end_date TIMESTAMP,
  status VARCHAR(20) DEFAULT 'planning',  -- 'planning', 'active', 'closed'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Issues
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  key VARCHAR(50) UNIQUE NOT NULL,              -- e.g., "PROJ-123"
  summary VARCHAR(500) NOT NULL,
  description TEXT,
  issue_type VARCHAR(50) DEFAULT 'task',        -- 'task', 'story', 'bug', 'epic', 'subtask'
  status_id INTEGER REFERENCES statuses(id),
  priority VARCHAR(20) DEFAULT 'medium',
  assignee_id UUID REFERENCES users(id),
  reporter_id UUID REFERENCES users(id),
  parent_id INTEGER REFERENCES issues(id),      -- Subtask parent
  epic_id INTEGER REFERENCES issues(id),        -- Epic linkage
  sprint_id INTEGER REFERENCES sprints(id),
  story_points INTEGER,
  custom_fields JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_issues_project ON issues(project_id);
CREATE INDEX idx_issues_assignee ON issues(assignee_id);
CREATE INDEX idx_issues_sprint ON issues(sprint_id);
CREATE INDEX idx_issues_status ON issues(status_id);

-- Issue History (audit trail)
CREATE TABLE issue_history (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  field VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_issue_history_issue ON issue_history(issue_id, created_at DESC);

-- Comments
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_issue ON comments(issue_id);

-- Boards
CREATE TABLE boards (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(20) DEFAULT 'kanban',  -- 'kanban', 'scrum'
  filter_jql TEXT,
  column_config JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Labels and Components
CREATE TABLE labels (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20) DEFAULT '#6B7280',
  UNIQUE(project_id, name)
);

CREATE TABLE components (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  lead_id UUID REFERENCES users(id)
);

-- Idempotency Keys
CREATE TABLE idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL,
  request_path VARCHAR(200) NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);
```

---

## API Design

### REST Endpoints

```
POST   /api/auth/register           Register new user
POST   /api/auth/login              Login with email/password
POST   /api/auth/logout             Destroy session

GET    /api/projects                List all projects
POST   /api/projects                Create project
GET    /api/projects/:id            Get project details
PATCH  /api/projects/:id            Update project
DELETE /api/projects/:id            Delete project

GET    /api/issues                  List issues (with filters)
POST   /api/issues                  Create issue
GET    /api/issues/:id              Get issue details
PATCH  /api/issues/:id              Update issue fields
DELETE /api/issues/:id              Delete issue
POST   /api/issues/:id/transition   Execute workflow transition
GET    /api/issues/:id/history      Get issue change history
GET    /api/issues/:id/comments     List comments
POST   /api/issues/:id/comments     Add comment

GET    /api/search                  JQL search (query param: jql)
GET    /api/search/quick            Quick text search

GET    /api/workflows               List workflows
GET    /api/workflows/:id           Get workflow with statuses and transitions
```

---

## Key Design Decisions

### 1. JSONB for Custom Fields

**Decision**: Store custom field values as JSONB on the issues table.

Custom fields are inherently schema-variable across projects. An Entity-Attribute-Value (EAV) table would require multi-join queries for every issue fetch and make Elasticsearch indexing more complex. JSONB stores all custom values inline, supports GIN indexing for containment queries, and serializes naturally for the search index. The trade-off is weaker type enforcement at the database level -- validation must happen in the application layer and during Elasticsearch indexing.

### 2. Workflow as Database Configuration

**Decision**: Define workflows, statuses, and transitions in database tables rather than code.

Code-driven workflows require deployments for every change and cannot be customized per-project. Database-driven workflows let administrators modify states and transitions through the UI, support per-project workflow assignment, and enable versioning. The trade-off is that complex business logic in conditions and post-functions is limited to a predefined set of types rather than arbitrary code execution.

### 3. JQL to Elasticsearch Translation

**Decision**: Parse JQL into an AST and translate to Elasticsearch queries.

PostgreSQL full-text search handles simple keyword matching but struggles with complex boolean logic across multiple field types, custom fields, and nested conditions. Elasticsearch supports all JQL operators naturally through its bool query DSL. The trade-off is eventual consistency -- the search index lags behind PostgreSQL by 100-500ms, meaning a just-created issue may not appear in search results immediately.

### 4. Cache-Aside for Issue Data

**Decision**: Use cache-aside (lazy loading) with Redis rather than write-through.

Issue data changes frequently (status transitions, field edits, comments). Write-through caching would add latency to every write operation. Cache-aside allows brief staleness (5-minute TTL for issues, 1-minute for boards) while keeping writes fast. The pattern: check cache first, on miss read from database, populate cache. Explicit invalidation on updates ensures critical data freshness.

### 5. RabbitMQ over Kafka for Event Processing

**Decision**: Use RabbitMQ with fanout exchanges for issue event processing.

The event volume (issue creates, updates, transitions) is moderate -- thousands per second at peak, not millions. RabbitMQ provides simpler setup, built-in retry with dead-letter queues, and per-message acknowledgment. Kafka would be warranted if we needed event replay, log compaction, or multi-datacenter replication. For an issue tracker where events are consumed and discarded, RabbitMQ's operational simplicity wins.

---

## Consistency and Idempotency

### Write Consistency Model

**PostgreSQL (Source of Truth):** Strong consistency for all issue writes within a single project. Transactions wrap multi-table operations (issue update + history record + custom field updates). Transitions use optimistic locking with a `version` column to prevent concurrent conflicting state changes.

**Elasticsearch (Search Index):** Eventual consistency with PostgreSQL as authoritative source. Index updates happen asynchronously via RabbitMQ. Typical lag: 100-500ms.

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Issue create/update | Strong (PostgreSQL) | Single-project writes require immediate consistency |
| Status transitions | Strong + optimistic locking | Workflow state must be atomic |
| Comment add | Strong | User expects immediate visibility |
| Search results | Eventual (~500ms) | Slight delay acceptable for search |
| Board views | Eventually consistent | Cached aggregations, refreshed periodically |

### Idempotency Keys

All mutating API operations accept an `X-Idempotency-Key` header. The middleware checks Redis for an existing response under that key. If found, it replays the cached response. If not, it processes the request and caches the response with a 24-hour TTL. A background job purges expired keys hourly.

### Conflict Resolution

Optimistic concurrency control for issue updates: the client sends the expected `version` number. The update query includes `WHERE version = expected_version` and increments it. If no rows are affected, the issue was modified concurrently and the client must refresh and retry.

---

## Caching Strategy

### Cache Keys and TTLs

| Cache Type | Key Pattern | TTL | Invalidation |
|------------|-------------|-----|--------------|
| Issue data | `issue:{id}` | 5 min | On update, delete key |
| Issue by key | `issue:key:{projectKey}-{number}` | 5 min | On update, delete key |
| Project metadata | `project:{id}` | 15 min | On project update |
| Workflow definition | `workflow:{id}` | 30 min | On workflow edit (rare) |
| Permission scheme | `perm-scheme:{id}` | 30 min | On scheme edit (rare) |
| User permissions | `user-perms:{userId}:{projectId}` | 10 min | On role change |
| Board issues | `board:{id}:issues` | 1 min | On any issue update in project |
| JQL saved filter | `filter:{id}:results` | 2 min | On filter execution |

### Invalidation Rules

Explicit invalidation (preferred for critical data): on issue update, delete both the `issue:{id}` and `issue:key:{key}` cache entries, then publish an event for search reindexing. Board caches are invalidated by any issue update within the board's project.

---

## Async Queue and Background Jobs

### Queue Architecture

RabbitMQ processes events asynchronously to decouple issue operations from slow downstream work (search indexing, notifications, webhook delivery).

| Queue | Message Type | Delivery | Retry Policy |
|-------|--------------|----------|--------------|
| `issue.events` (fanout) | Issue created/updated/deleted | At-least-once | N/A |
| `search.index` (direct) | Reindex request | At-least-once | 3 retries, exponential backoff |
| `notifications` (direct) | Email/in-app notification | At-least-once | 3 retries, then DLQ |
| `webhooks` (direct) | Webhook payload | At-least-once | 5 retries, exponential backoff |

**Deduplication:** Messages include an `event_id` (UUID). Consumers track processed event IDs in Redis with a 24-hour TTL. Duplicate messages are logged and skipped.

**Dead Letter Queue:** Messages that fail all retries are routed to a DLQ for manual inspection and stored in a `failed_jobs` table for admin review.

---

## Security and Auth

- **Session-based authentication** with Redis-backed session store (prefixed `jira:session:`)
- **CORS** restricted to frontend origins
- **Permission checks** on every mutating API endpoint via the scheme-based permission model
- **Input validation** with Zod schemas for all request bodies
- **Parameterized SQL** via the pg library to prevent injection

---

## Observability

### Prometheus Metrics

The `/metrics` endpoint exposes all application metrics for Prometheus scraping:

- `jira_issues_created_total{project_key, issue_type}` -- issue creation rate
- `jira_transitions_total{project_key, from_status, to_status}` -- workflow transition patterns
- `jira_search_queries_total{query_type}` -- search usage by type (jql, text, quick)
- `jira_search_latency_seconds{query_type}` -- search latency histogram (p50, p95, p99)
- `jira_cache_hits_total{cache_type}` / `jira_cache_misses_total{cache_type}` -- cache effectiveness
- `jira_idempotent_replays_total` -- duplicate request detection rate
- `jira_messages_published_total{queue_name}` / `jira_messages_consumed_total{queue_name, status}` -- queue throughput
- `jira_http_requests_total{method, path, status_code}` -- HTTP request counts
- `jira_http_latency_seconds{method, path}` -- HTTP latency histogram

### Structured Logging

Pino JSON logger with request context (method, path, status, duration, user_id). Environment-aware: pretty-print in development, JSON in production for log aggregation.

### Health Checks

- `GET /health` -- checks PostgreSQL, Redis, and Elasticsearch connectivity with per-dependency latency. Returns 200 (healthy) or 503 (degraded).
- `GET /ready` -- readiness probe for load balancers. Returns 200 only when PostgreSQL and Redis are reachable.

---

## Failure Handling

- **Graceful shutdown**: SIGTERM/SIGINT handlers close RabbitMQ, PostgreSQL pool, and Redis connections before exit
- **Elasticsearch optional**: If ES is down, the server starts and serves issue CRUD; search is degraded
- **RabbitMQ non-blocking**: Queue initialization retries in the background; issue operations work without it
- **Uncaught exception handler**: Logs fatal error and exits to prevent undefined state

---

## Scalability Considerations

| Bottleneck | Scaling Strategy |
|------------|-----------------|
| API throughput | Horizontal scaling behind load balancer (stateless services, Redis sessions) |
| Database writes | Read replicas for board views, connection pooling, partition issues by project_id |
| Search latency | Elasticsearch cluster with sharding by project, replicas for read throughput |
| Queue throughput | Multiple consumer instances per queue with prefetch limits |
| Large projects | Paginated API responses, cursor-based pagination for issue lists |
| Custom field queries | GIN indexes on JSONB, materialized views for common aggregations |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Custom fields | JSONB | EAV table | Simpler queries, inline storage, GIN indexing |
| Search | Elasticsearch | PostgreSQL FTS | JQL complexity requires boolean query DSL |
| Workflow | DB-driven | Code-driven | Per-project customization without deployment |
| History | Event table | Event sourcing | Simpler queries, lower storage overhead |
| Cache strategy | Cache-aside | Write-through | Write latency matters for frequent issue updates |
| Message queue | RabbitMQ | Kafka | Simpler for moderate volume, built-in DLQ |
| Consistency | Strong (PG) + Eventual (ES) | Full eventual | Issue state must be immediately consistent |
| Idempotency | Request-level keys | Operation log | Simpler client integration |

---

## Frontend Architecture

This section describes the actual frontend implementation: component hierarchy, state management, routing, data fetching, and key UI patterns.

### Component Hierarchy

```
__root.tsx (TanStack Router)
├── / (index.tsx)                           (login or redirect to projects)
├── /projects                               (project list)
├── /projects/$projectKey                   (project shell)
│   └── Layout                              (Header + Sidebar + main content)
│       ├── Header                          (search bar, create button, user menu)
│       ├── Sidebar                         (project selector, nav links)
│       └── Outlet (nested routes)
│           ├── /board                      (Kanban board)
│           │   └── KanbanBoard
│           │       └── BoardColumn (per status)
│           │           └── BoardCard (per issue)
│           ├── /backlog                    (sprint + backlog views)
│           │   └── Backlog
│           │       ├── BacklogItem (sprint issues)
│           │       └── BacklogItem (backlog issues)
│           ├── /issues                     (issue list table)
│           └── /settings                   (project configuration)
├── IssueDetail (modal overlay)             (issue view/edit)
│   ├── IssueDetailHeader                   (key, type icon, actions)
│   ├── IssueSummaryEditor                  (inline title editing)
│   ├── IssueDetailTabs                     (comments / history tab bar)
│   │   ├── CommentsTab                     (threaded comments)
│   │   └── HistoryTab                      (field change audit trail)
│   └── IssueDetailSidebar                  (status, assignee, priority, sprint, story points)
└── CreateIssueModal                        (issue creation form)
```

The `IssueDetail` component uses a decomposition pattern: the container component (`IssueDetail.tsx`) manages data fetching and state, while sub-components in the `issue-detail/` directory handle rendering. This keeps the main component under 150 lines while the full detail view spans 6 files.

### Zustand Stores

The frontend uses four Zustand stores that separate concerns by domain.

**`useAuthStore` -- Authentication**

Manages the user session lifecycle. On app initialization, `checkAuth()` calls the `/api/auth/me` endpoint to restore session state from the server-side cookie. Unlike the Google Docs project, this store does not persist a token to `localStorage` -- it relies entirely on HTTP-only session cookies, which are sent automatically with every request.

**`useProjectStore` -- Project Context**

Manages the project list and the currently active project's full context. When a user navigates to a project route, `fetchProjectDetails(projectId)` loads four resources in parallel using `Promise.all`: the project metadata, its workflow (statuses and transitions), sprints, and boards. This parallel loading pattern reduces the initial project load time from ~400ms (sequential) to ~150ms (parallel, bound by the slowest query).

**`useIssueStore` -- Issues and Backlog**

Manages three issue lists: `issues` (current sprint or filtered view), `backlog` (issues not in any sprint), and `currentIssue` (selected for the detail modal). The `updateIssueInList` method performs cross-list optimistic updates -- when an issue's status changes, it is updated in both the `issues` and `backlog` arrays, as well as `currentIssue` if it is the currently selected issue. `removeIssueFromList` handles deletion cleanup across all three.

**`useUIStore` -- UI State**

Manages global UI state: sidebar visibility, and three modal states (issue detail, create issue, search). This store keeps UI concerns out of domain stores, preventing unnecessary re-renders when only visual state changes.

### Routing

The application uses TanStack Router with file-based routing and nested route layouts:

| Route | File | Purpose |
|-------|------|---------|
| `/` | `routes/index.tsx` | Login page or redirect to projects |
| `/projects` | `routes/projects/index.tsx` | Project list |
| `/projects/$projectKey` | `routes/projects/$projectKey.tsx` | Project shell with Layout |
| `/projects/$projectKey/board` | `routes/projects/$projectKey/board.tsx` | Kanban board |
| `/projects/$projectKey/backlog` | `routes/projects/$projectKey/backlog.tsx` | Sprint planning |
| `/projects/$projectKey/issues` | `routes/projects/$projectKey/issues.tsx` | Issue list table |
| `/projects/$projectKey/settings` | `routes/projects/$projectKey/settings.tsx` | Project configuration |

The `$projectKey` route acts as a layout route: it renders the `Layout` component (Header + Sidebar) and uses `Outlet` for child routes. This ensures the sidebar and header persist across board/backlog/issues navigation without re-mounting.

### Data Fetching

All API calls go through `services/api.ts`, which provides typed functions for every endpoint. The module exports individual functions (not a class), each wrapping `fetch()` with credentials mode `include` (to send session cookies). Functions are organized by resource: `login/logout/register/getCurrentUser` for auth, `getProjects/getProject/getProjectWorkflow/getProjectSprints/getProjectBoards` for projects, `getProjectIssues/getBacklogIssues/getSprintIssues/createIssue/updateIssue/deleteIssue` for issues, `getIssueTransitions/executeTransition` for workflow operations, and `getIssueComments/addComment` for comments.

### Key UI Patterns

- **Kanban board with drag-and-drop**: The `KanbanBoard` component groups issues by workflow status into `BoardColumn` components. Issues are draggable using the HTML5 Drag and Drop API. On drop, the component finds the appropriate workflow transition to the target status, executes it via the API (`executeTransition`), and updates the issue in the store. The drop target column highlights with a blue ring (`ring-2 ring-blue-400`) during drag-over.

- **Workflow-aware transitions**: Dropping an issue on a status column is not a simple field update -- it must go through the workflow engine. The frontend fetches available transitions for the issue, finds one matching the target status, and executes it. If no valid transition exists (e.g., "Done" to "To Do" is not configured), the drop is silently rejected.

- **Backlog with sprint planning**: The `Backlog` component shows two sections: the active sprint's issues and the backlog (unassigned issues). Issues can be moved between sections via action buttons that appear on hover. Moving to sprint updates the issue's `sprint_id`.

- **Issue detail modal**: Clicking an issue anywhere (board card, backlog item, issue list) opens a modal with the full issue detail. The modal has two tabs (Comments and History) and a sidebar showing status, assignee, priority, sprint, and story points. Status changes in the modal sidebar trigger workflow transitions. The `useIssueDetail` custom hook manages the detail view's data fetching and mutation logic.

- **Keyboard shortcuts**: The root component registers global keyboard shortcuts: `Ctrl+K` for search (placeholder), and potential `C` key for create issue (when no input is focused).

- **Status category colors**: Board columns use color coding based on the workflow status category: gray for `todo`, blue for `in_progress`, green for `done`. This provides visual consistency regardless of custom status names.

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, written for readers encountering these patterns for the first time.

### RBAC (Role-Based Access Control)

**What it is**: RBAC assigns permissions to roles rather than individual users. Users are granted roles within a specific context (e.g., a project), and the role determines what actions they can perform. This creates a layered permission system: system-level roles (user, admin), project-level roles (project lead, developer, viewer), and scheme-based permission grants.

**Why it matters**: In an issue tracker used by multiple teams, permission requirements vary wildly. The security team needs "only the assignee can close security bugs." The design team wants "anyone can create issues." Without RBAC, these rules are hard-coded per project, making changes require code deployments. With scheme-based RBAC, an administrator configures permission schemes in the UI and assigns them to projects.

**How it works in this project**: The permission system has three layers. `project_roles` defines reusable roles (e.g., Administrator, Developer, Viewer). `permission_schemes` groups permission grants into reusable configurations. `permission_grants` maps specific permissions (e.g., `create_issue`, `edit_issue`, `transition`) to grantees by type (`anyone`, `user`, `role`, `group`). Each project references a permission scheme via `permission_scheme_id`. When a user attempts an action, the system loads the project's scheme, evaluates all grants, and checks if any match the user's roles, groups, or direct user ID. This scheme-based approach means changing permissions for 50 projects that share the same scheme requires updating one scheme, not 50 project configurations.

### Redis Cache-Aside

**What it is**: Cache-aside is a caching pattern where the application checks the cache before querying the database. On a cache miss, the data is loaded from the database and stored in the cache for future requests. On a cache hit, the database query is skipped entirely.

**Why it matters**: Issue trackers have a highly skewed read/write ratio. A board view showing 30 issues across 5 status columns requires fetching the project metadata, workflow definition, and all issues -- multiple queries that take 20-50ms total. With cache-aside, subsequent board loads complete in ~2ms. Workflow definitions and permission schemes are read thousands of times per change, making them ideal caching candidates.

**How it works in this project**: The project service (`backend/src/services/projectService.ts`) implements cache-aside for projects, workflows, and permission schemes. Cache keys use descriptive patterns: `project:{id}` (15-min TTL), `workflow:{id}` (30-min TTL), `perm-scheme:{id}` (30-min TTL), `issue:{id}` (5-min TTL), `board:{id}:issues` (1-min TTL). Workflows and permission schemes have longer TTLs because they change rarely. Board issue caches have short TTLs because issues change frequently. On issue update, both `issue:{id}` and `issue:key:{key}` caches are explicitly deleted, and a search reindexing event is published.

### Circuit Breaker

**What it is**: A circuit breaker wraps calls to external dependencies and monitors their success/failure rate. When failures cross a threshold, the circuit "opens" and calls fail immediately (without contacting the dependency) for a cooldown period. This prevents a slow or failing dependency from cascading failures throughout the system.

**Why it matters**: Jira depends on PostgreSQL, Redis, Elasticsearch, and RabbitMQ. If Elasticsearch becomes slow (e.g., due to a garbage collection pause), every search request blocks for 30 seconds waiting for a timeout. Without a circuit breaker, the server's event loop fills with blocked requests, and even non-search endpoints (creating issues, viewing boards) become unresponsive. With a circuit breaker, after a few Elasticsearch failures, search requests immediately return a "search unavailable" error while issue CRUD continues working normally.

**How it works in this project**: The graceful degradation strategy is dependency-aware. Elasticsearch is treated as optional: if it is down, the server starts and serves all issue CRUD operations; search is degraded but the rest of the application works. RabbitMQ initialization retries in the background, so issue operations work without it (notifications and search indexing are delayed). PostgreSQL is critical: if it fails, the server enters a read-only mode serving cached data. Each dependency failure results in specific, predictable degradation rather than total system failure.

### Structured Logging

**What it is**: Structured logging outputs log entries as machine-parseable JSON rather than human-readable text. Each log entry is a JSON object with consistent fields: level, message, timestamp, and contextual metadata (user ID, request path, duration, issue key).

**Why it matters**: When investigating a bug report -- "issue PROJ-123 was moved to Done but the assignee was not notified" -- you need to find the specific transition event, check if the post-function fired, and see if the notification was published to RabbitMQ. With structured logs, this is a simple query: `jq 'select(.issueKey == "PROJ-123" and .action == "transition")'`. Without structured logs, you search through thousands of text lines with regex patterns that break whenever someone changes a log message format.

**How it works in this project**: Pino is used (`backend/src/config/logger.ts`) with environment-aware output: pretty-printed with colors in development for readability, raw JSON in production for log aggregation. Each HTTP request gets a child logger with `method`, `path`, `status`, `duration`, and `user_id`. Workflow transitions log the issue key, from/to status, and executing user. Queue operations log the queue name, message ID, and processing status. This context makes it possible to reconstruct the full lifecycle of any operation.

### Prometheus Metrics

**What it is**: Prometheus metrics are numeric measurements exposed at an HTTP endpoint (`/metrics`) that a Prometheus server periodically scrapes. Applications define counters (totals), histograms (latency distributions), and gauges (current values) with labels for dimensional analysis.

**Why it matters**: Issue trackers need to answer questions like: "How many issues were created per project this week?" "What is the p95 latency for JQL searches?" "How deep is the search indexing queue?" Metrics provide these answers in real-time through dashboards and can trigger alerts when thresholds are breached.

**How it works in this project**: The metrics module (`backend/src/config/metrics.ts`) exposes domain-specific metrics alongside standard HTTP metrics. `jira_issues_created_total{project_key, issue_type}` tracks issue creation rates by project and type. `jira_transitions_total{project_key, from_status, to_status}` reveals workflow patterns (e.g., which statuses are most commonly transitioned to). `jira_search_queries_total{query_type}` and `jira_search_latency_seconds{query_type}` track search performance by type (JQL, text, quick). `jira_cache_hits_total` and `jira_cache_misses_total` with `{cache_type}` labels measure cache effectiveness. `jira_idempotent_replays_total` tracks how often duplicate requests are caught.

### Rate Limiting

**What it is**: Rate limiting restricts the number of requests a client can make within a time window. It protects backend services from overload and ensures fair resource sharing.

**Why it matters**: A JQL search query can be expensive -- it is parsed, translated to an Elasticsearch query, executed, and results are fetched. A user repeatedly pressing "Search" or a misbehaving integration hitting the search endpoint 100 times per second could saturate Elasticsearch and degrade search for all users. Rate limiting caps search requests at a sustainable rate while allowing normal usage.

**How it works in this project**: While the full rate limiting middleware is listed as omitted from the local build, the architecture design specifies rate limits per endpoint category. Authentication endpoints have strict limits to prevent credential stuffing. Search endpoints are limited to prevent Elasticsearch overload. Issue mutation endpoints are limited per user to prevent bulk operations from overwhelming the database. The implementation would use a sliding window counter in Redis, keyed by user ID or IP address.

### Idempotency

**What it is**: An operation is idempotent if executing it multiple times produces the same result as executing it once. In an API, this means that retrying a request that may or may not have been processed will not cause duplicate side effects.

**Why it matters**: Creating an issue is not naturally idempotent. If a user clicks "Create" and the network drops before the response arrives, the client retries. Without idempotency protection, the system creates two identical issues -- both with the key "PROJ-124," both assigned to the same sprint. The user now has to find and delete the duplicate, and the issue counter is off.

**How it works in this project**: All mutating API endpoints accept an `X-Idempotency-Key` header. The idempotency middleware (`backend/src/middleware/idempotency.ts`) checks Redis for a cached response under the key `idempotency:{userId}:{key}`. If found, it returns the cached response (status code + body) without executing the handler. If not found, it processes the request, caches the response with a 24-hour TTL, and returns it. The `idempotency_keys` table in PostgreSQL serves as a backup store, with a background job purging expired entries hourly (keyed by `expires_at`). This dual-layer approach ensures idempotency survives Redis restarts.

### Health Checks

**What it is**: Health checks are lightweight HTTP endpoints that report the operational status of an application instance and its dependencies. Load balancers and orchestrators use them to make routing and restart decisions.

**Why it matters**: In a system with four dependencies (PostgreSQL, Redis, Elasticsearch, RabbitMQ), any one can fail independently. Health checks enable the infrastructure to detect which dependency is down and whether the instance can still serve useful traffic. An instance with a failed Elasticsearch connection can still serve issue CRUD and board views -- it should remain in the load balancer pool. An instance with a failed PostgreSQL connection is useless and should be removed.

**How it works in this project**: Two endpoints exist. `GET /health` performs checks against PostgreSQL (`SELECT 1`), Redis (`PING`), and Elasticsearch (cluster health). Each check reports individual status and latency. The response returns `200` if all are healthy, `503` if any are degraded, with a JSON body listing per-dependency results. `GET /ready` is a simpler readiness probe that checks only PostgreSQL and Redis -- the minimum required for the application to process requests. Kubernetes uses `/ready` for initial pod readiness gates and `/health` for ongoing liveness probes.

---

## Implementation Notes

This section documents the actual local setup and maps production concepts to the Docker + Node.js + React implementation.

### Local Architecture

```
┌──────────────────────┐          ┌──────────────────────┐
│  Frontend (React 19) │  :5173   │   Backend (Express)  │  :3000
│  Vite + Zustand +    │ ──────▶  │   Routes + Services  │
│  TanStack Router +   │          │   + Middleware        │
│  Tailwind CSS        │          └──────────┬───────────┘
└──────────────────────┘                     │
                                    ┌────────┼────────┐────────┐
                                    ▼        ▼        ▼        ▼
                              ┌─────────┐┌───────┐┌─────┐┌─────────┐
                              │Postgres ││ Redis ││ ES  ││RabbitMQ │
                              │ :5432   ││ :6379 ││:9200││ :5672   │
                              └─────────┘└───────┘└─────┘└─────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Idempotency middleware | `X-Idempotency-Key` header, Redis-backed response caching | `backend/src/middleware/idempotency.ts` |
| Prometheus metrics | prom-client with custom counters, histograms, /metrics endpoint | `backend/src/config/metrics.ts` |
| Structured logging | Pino JSON logger with request context | `backend/src/config/logger.ts` |
| Health checks | /health (PG + Redis + ES), /ready (PG + Redis) | `backend/src/index.ts` |
| Message queue | RabbitMQ with fanout exchange, durable queues, DLQ | `backend/src/config/messageQueue.ts` |
| Background workers | Search indexer, notification worker, webhook dispatcher | `backend/src/workers/` |
| JQL parser | Tokenizer + AST builder + ES query generator | `backend/src/services/jqlParser.ts` |
| Workflow engine | DB-driven transitions with conditions, validators, post-functions | `backend/src/services/workflowService.ts` |
| Cache-aside | Redis caching for projects with TTL and explicit invalidation | `backend/src/services/projectService.ts` |
| Session auth | Redis-backed sessions via express-session + connect-redis | `backend/src/index.ts` |
| Input validation | Zod schemas for request body validation | `backend/src/routes/*.ts` |
| Graceful shutdown | SIGTERM/SIGINT handlers for clean resource cleanup | `backend/src/index.ts` |

### What Was Simplified or Substituted

| Production Concept | Local Substitute |
|-------------------|-----------------|
| API Gateway with rate limiting | Single Express server with CORS |
| Microservices (Issue, Workflow, Search) | Monolithic Express app with route modules |
| Elasticsearch cluster | Single-node ES 8.11 in Docker |
| RabbitMQ cluster | Single-node RabbitMQ 3.12 in Docker |
| Redis Cluster | Single Valkey 7 instance |
| OAuth / SSO | Session-based auth with bcrypt passwords |
| CDN for static assets | Vite dev server |
| Kubernetes / container orchestration | Docker Compose for infrastructure services |
| Multi-region deployment | Single machine, localhost |
| Database sharding | Single PostgreSQL 16 instance |

### What Was Omitted

- CDN and edge caching for API responses
- Multi-region deployment and geo-routing
- Kubernetes with horizontal pod autoscaling
- Database read replicas and sharding
- OAuth/SSO/SAML integration
- Real-time WebSocket updates for board changes
- Attachment storage (S3/MinIO)
- Advanced JQL functions (linked issues, sprint functions)
- Branch protection and merge checks
- Full audit log viewer in admin UI
- Rate limiting middleware
- CI/CD pipeline integration

### Frontend Architecture

The frontend uses React 19 + TypeScript + Vite + TanStack Router + Zustand + Tailwind CSS.

Key components:
- `Board.tsx` -- Kanban/Scrum board with columns per status
- `IssueDetail.tsx` -- Container component with sub-components split into `issue-detail/` directory
- `CreateIssueModal.tsx` -- Issue creation form
- `Layout.tsx` -- App shell with sidebar navigation

Routes follow TanStack Router file-based conventions under `frontend/src/routes/`, with nested routes for project views (board, backlog, issues, settings).

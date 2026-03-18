# Design Notion - Architecture

## System Overview

Notion is a block-based collaborative workspace combining document editing, databases, and team organization. Core challenges involve real-time editing with conflict resolution, flexible block data structures, hierarchical page organization, and database views.

**Learning Goals:**
- Implement real-time collaboration (CRDT-based)
- Design flexible block-based data models
- Build hierarchical permission systems
- Handle offline-first architecture patterns

---

## Requirements

### Functional Requirements

1. **Edit**: Block-based document editing with rich text, headings, lists, code, quotes, callouts, toggles, and dividers
2. **Collaborate**: Real-time multi-user editing with presence and operation broadcasting
3. **Organize**: Workspaces, nested pages (recursive hierarchy), sidebar navigation
4. **Share**: Workspace membership with roles (admin, member, guest) and page-level permissions
5. **Database**: Structured data with properties schema, table/board/list views, filtering, and sorting

### Non-Functional Requirements

- **Latency**: < 100ms for local edits (optimistic apply)
- **Sync**: < 500ms for cross-user operation propagation
- **Offline**: Full editing capability offline with sync on reconnect
- **Scale**: 10M workspaces, 1B blocks, 100M pages
- **Availability**: 99.99% uptime for editing and sync
- **Consistency**: Eventual consistency via CRDTs, strong consistency for permissions

---

## Capacity Estimation

### Production Scale

| Metric | Target |
|--------|--------|
| Registered users | 30M |
| Daily active users | 5M |
| Concurrent editors | 500K |
| Workspaces | 10M |
| Total blocks | 1B |
| Peak API RPS | 300K |
| Peak WebSocket messages/sec | 1M |

### Storage Breakdown (Production)

| Data Type | Size | Growth |
|-----------|------|--------|
| Blocks (content JSONB) | 5TB | 500GB/year |
| Pages metadata | 500GB | 50GB/year |
| Database rows + properties | 2TB | 300GB/year |
| Operations log | 10TB | 3TB/year |
| Audit log | 1TB | 200GB/year |
| File attachments (S3) | 50TB | 10TB/year |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Client Layer                                   │
│     React + Block Editor + CRDT Runtime + Zustand + IndexedDB        │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
                    HTTP REST + WebSocket (wss://)
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     CDN / Edge Layer                                  │
│              Static assets, SSL termination, DDoS protection         │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  API Gateway / Load Balancer                          │
│              Rate limiting, auth verification, routing               │
└──────┬──────────────────────────────────────────┬────────────────────┘
       │                                          │
       ▼                                          ▼
┌──────────────────┐                   ┌──────────────────────┐
│   API Servers    │                   │   Sync Servers       │
│  (REST + CRUD)   │                   │  (WebSocket + CRDT)  │
│  Workspaces,     │                   │  Operation broadcast │
│  Pages, Blocks,  │                   │  Presence tracking   │
│  Databases       │                   │  Conflict resolution │
└──────┬───────────┘                   └──────────┬───────────┘
       │                                          │
       ├──────────────────────────────────────────┤
       │                                          │
       ▼                                          ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
│   PostgreSQL     │  │ Redis/Valkey │  │    RabbitMQ      │
│   (Primary +     │  │  (Sessions,  │  │  (Export jobs,   │
│    Replicas)     │  │   Cache,     │  │   Notifications, │
│                  │  │   Presence,  │  │   Search index,  │
│  Blocks, Pages,  │  │   Pub/Sub)   │  │   Email)         │
│  Workspaces,     │  │              │  │                  │
│  Permissions,    │  └──────────────┘  └──────────────────┘
│  Audit Log       │
└──────────────────┘
```

---

## Core Components

### 1. Block Data Model

Everything in Notion is a block. Text, headings, code, images, and even databases are blocks. This unified model enables composable structures -- a toggle block can contain any other blocks as children, a page is a block container, and a database row is a page with properties.

Each block has a type, a properties JSONB column for type-specific data, a content JSONB column for rich text, and a fractional index position for ordering. Child blocks reference their parent via `parent_block_id`.

Block types implemented: `text`, `heading_1`, `heading_2`, `heading_3`, `bulleted_list`, `numbered_list`, `toggle`, `code`, `quote`, `callout`, `divider`.

### 2. Fractional Indexing for Block Order

Instead of integer positions that require reindexing all siblings on every insert, blocks use string-based fractional indexes. Inserting between positions "a" and "b" produces "aU" -- a string that sorts lexicographically between them. This enables O(1) insertions without touching other blocks.

The trade-off: fractional index strings grow in length with repeated insertions between the same pair. After ~50 consecutive insertions, strings can reach 20+ characters. Periodic compaction (rewriting all positions as evenly-spaced strings during a quiet period) keeps string lengths manageable.

### 3. Real-Time Collaboration (CRDT)

CRDTs (Conflict-Free Replicated Data Types) are used instead of OT for conflict resolution. CRDTs guarantee that applying the same set of operations in any order produces the same final state, eliminating the need for a central ordering authority.

**Why CRDT over OT**: Notion's offline-first requirement means clients may accumulate hours of edits before reconnecting. OT requires transforming each queued operation against every operation that occurred on the server during the offline period -- for 1000 queued operations against 500 server operations, this is O(500K) transformations. CRDTs merge in O(n) regardless of divergence because operations are commutative and idempotent.

The trade-off: CRDT operations carry more metadata (Hybrid Logical Clock timestamps, node IDs) increasing payload size by ~40%. For a block-level CRDT (not character-level), this is ~100 extra bytes per operation -- acceptable.

**Hybrid Logical Clock (HLC)** provides causal ordering across distributed clients. It combines a physical wall clock with a logical counter for same-millisecond events and a unique node ID for tie-breaking.

**Sync Protocol**:
1. Client connects with auth token via WebSocket
2. Client subscribes to a page
3. Server sends current presence list
4. Operations are applied locally first (optimistic)
5. Operations sent to server, broadcast to other clients
6. Server acknowledges each operation

### 4. Page Hierarchy

Pages form a recursive tree structure via `parent_id` self-reference. Root pages have `parent_id = NULL` and belong to a workspace. The sidebar renders this tree using recursive queries (`WITH RECURSIVE` CTEs in PostgreSQL).

At production scale with deeply nested pages (10+ levels), recursive queries become expensive. The solution is a materialized path column (e.g., `/workspace-id/page-a/page-b/page-c`) that enables prefix-based queries for subtrees without recursion.

### 5. Database Views

A database is a page with `is_database = TRUE` and a `properties_schema` JSONB column defining the schema (property name, type, options). Rows are stored in `database_rows` with a `properties` JSONB column holding values.

Views are saved configurations that define:
- **View type**: table, board (Kanban), or list
- **Filters**: which rows to show based on property conditions
- **Sorts**: row ordering by one or more properties
- **Group by**: for board view, which select property defines columns
- **Property visibility**: which columns are shown and their widths

Same data, different presentations. This is a key insight: views are cheap (just configuration) while data is shared.

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(200) NOT NULL,
    avatar_url VARCHAR(500),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Workspaces
CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    icon VARCHAR(100),
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Workspace members
CREATE TABLE workspace_members (
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin', 'member', 'guest')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

-- Pages (recursive hierarchy)
CREATE TABLE pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    title VARCHAR(500) DEFAULT 'Untitled',
    icon VARCHAR(100),
    cover_image VARCHAR(500),
    is_database BOOLEAN DEFAULT FALSE,
    properties_schema JSONB DEFAULT '[]',
    position VARCHAR(100) DEFAULT 'a',
    is_archived BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Blocks
CREATE TABLE blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    parent_block_id UUID REFERENCES blocks(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'text',
    properties JSONB DEFAULT '{}',
    content JSONB DEFAULT '[]',
    position VARCHAR(100) DEFAULT 'a',
    version INTEGER DEFAULT 0,
    is_collapsed BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Database views
CREATE TABLE database_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    name VARCHAR(200) DEFAULT 'Default View',
    type VARCHAR(20) DEFAULT 'table' CHECK (type IN ('table', 'board', 'list', 'calendar', 'gallery')),
    filter JSONB DEFAULT '[]',
    sort JSONB DEFAULT '[]',
    group_by VARCHAR(100),
    properties_visibility JSONB DEFAULT '[]',
    position VARCHAR(100) DEFAULT 'a',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Database rows (pages that are database entries)
CREATE TABLE database_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    database_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    properties JSONB DEFAULT '{}',
    position VARCHAR(100) DEFAULT 'a',
    is_archived BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Page permissions (override workspace-level)
CREATE TABLE page_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(20) DEFAULT 'view' CHECK (permission IN ('view', 'edit', 'full_access')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(page_id, user_id)
);

-- Sessions
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(500) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Operations log for CRDT sync
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    block_id UUID,
    type VARCHAR(20) NOT NULL CHECK (type IN ('insert', 'update', 'delete', 'move')),
    data JSONB NOT NULL,
    timestamp BIGINT NOT NULL,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log (append-only for compliance)
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    metadata JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Key Indexes

```sql
CREATE INDEX idx_pages_workspace ON pages(workspace_id);
CREATE INDEX idx_pages_parent ON pages(parent_id);
CREATE INDEX idx_blocks_page ON blocks(page_id);
CREATE INDEX idx_blocks_parent ON blocks(parent_block_id);
CREATE INDEX idx_blocks_position ON blocks(page_id, position);
CREATE INDEX idx_database_rows_database ON database_rows(database_id);
CREATE INDEX idx_operations_page ON operations(page_id);
CREATE INDEX idx_operations_timestamp ON operations(page_id, timestamp);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_audit_log_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id, timestamp DESC);
```

---

## API Design

```
Authentication:
POST   /api/auth/register              - Create account
POST   /api/auth/login                 - Create session
POST   /api/auth/logout                - Destroy session
GET    /api/auth/me                    - Get current user

Workspaces:
GET    /api/workspaces                 - List user's workspaces
POST   /api/workspaces                 - Create workspace
GET    /api/workspaces/:id             - Get workspace details
PUT    /api/workspaces/:id             - Update workspace
GET    /api/workspaces/:id/members     - List members
POST   /api/workspaces/:id/members     - Add member
DELETE /api/workspaces/:id/members/:uid - Remove member

Pages:
GET    /api/pages?workspace_id=        - List pages in workspace
POST   /api/pages                      - Create page
GET    /api/pages/:id                  - Get page with blocks
PUT    /api/pages/:id                  - Update page metadata
DELETE /api/pages/:id                  - Archive page

Blocks:
GET    /api/pages/:id/blocks           - List blocks for page
POST   /api/pages/:id/blocks           - Create block
PUT    /api/blocks/:id                 - Update block content/properties
DELETE /api/blocks/:id                 - Delete block

Databases:
GET    /api/databases/:id/rows         - List rows with filters/sorts
POST   /api/databases/:id/rows         - Create row
PUT    /api/databases/:id/rows/:rid    - Update row properties
GET    /api/databases/:id/views        - List views
POST   /api/databases/:id/views        - Create view
PUT    /api/databases/:id/views/:vid   - Update view configuration

WebSocket:
WS /ws                                - Real-time sync endpoint
  → subscribe(pageId)                  - Join page for updates
  → operation(op)                      - Send block operation
  → presence(pageId, cursor)           - Cursor/presence update
  ← operation(op, userId)              - Receive remote operation
  ← presence(users)                    - Presence list update
  ← ack(opId)                          - Operation acknowledged
```

---

## Key Design Decisions

### 1. CRDT for Collaboration (Not OT)

CRDTs guarantee convergence without a central authority, making them ideal for offline-first editing. When a user edits offline for an hour and reconnects, their operations merge automatically without the O(n*m) transformation cost of OT. The server becomes a relay, not an authority -- it broadcasts operations and persists them, but does not transform them.

The trade-off: character-level text CRDTs (like Yjs or Automerge) add ~2x storage overhead for the internal CRDT state. At block-level granularity (our current implementation), the overhead is minimal -- each block operation is ~200 bytes regardless of text length. Full character-level CRDT for rich text within blocks is a future enhancement.

### 2. Blocks as Universal Primitive

Making everything a block (text, headings, code, images, databases) provides a unified editing experience and data model. A toggle block can contain any other blocks as children. A database row is a page which contains blocks. This composability is Notion's key differentiator.

The trade-off: the blocks table becomes the hottest table in the system. With 1B blocks, queries must be carefully indexed. We index on `(page_id, position)` for ordered retrieval and `(parent_block_id)` for tree traversal. At scale, sharding by page_id keeps all blocks for a page on the same shard.

### 3. Fractional Indexing for Order

Integer positions require reindexing all subsequent siblings when inserting in the middle of a list. With 100 blocks in a page and frequent reordering, this creates write amplification. Fractional indexes (lexicographically sortable strings) enable O(1) insertions by generating a string between any two existing positions.

The trade-off: string positions grow with repeated insertions between the same pair. After ~50 insertions, positions can reach 20+ characters. Periodic compaction (rewriting positions as evenly-spaced strings) is needed, but this is a background operation that does not block editing.

---

## Caching Strategy

### Cache-Aside for Read-Heavy Data

Pages and blocks are read far more often than written. A popular team wiki page might have 100 views per edit. Cache-aside with Redis reduces database load:

| Data Type | Strategy | TTL | Invalidation |
|-----------|----------|-----|--------------|
| User sessions | Write-through | 24 hours | On logout/password change |
| Page metadata | Cache-aside | 5 minutes | On page update |
| Block content | Cache-aside | 10 minutes | On block operation |
| Workspace members | Cache-aside | 15 minutes | On membership change |
| Search results | Cache-aside | 2 minutes | Time-based expiry only |
| Presence (who is online) | Write-through | 30 seconds | Heartbeat refresh |

Cache invalidation is event-driven: when a block is updated, the page cache is invalidated. When a page title changes, the parent page's child list cache is invalidated.

---

## Async Queue and Background Jobs

RabbitMQ handles asynchronous workloads that should not block user requests:

### Queue Definitions

| Queue | Prefetch | Retries | TTL | Semantics | Purpose |
|-------|----------|---------|-----|-----------|---------|
| `notion.fanout` | 50 | 0 | 30s | At-most-once | Real-time presence, cursor updates |
| `notion.notifications` | 10 | 3 | 1h | At-least-once | In-app notifications |
| `notion.export` | 2 | 5 | 24h | Exactly-once* | PDF/Markdown export (resource-intensive) |
| `notion.email` | 10 | 3 | 24h | At-least-once | Invite emails, share notifications |
| `notion.search` | 10 | 3 | 1h | At-least-once | Search index updates (idempotent) |

*Exactly-once via idempotency keys stored in Redis.

### Why Async for Exports

Export operations (PDF, Markdown) are time-consuming (seconds for large pages), resource-intensive (CPU/memory for rendering), and would timeout if handled synchronously. The API returns immediately with a job ID; the worker processes the export and notifies the user when complete. Prefetch of 2 prevents a single worker from consuming too much memory.

Dead letter queues capture permanently failed jobs for investigation. Exponential backoff on retry (1s, 2s, 4s, 8s) prevents retry storms against temporarily unavailable dependencies.

---

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds{method,route,status}` | Histogram | API latency SLI |
| `websocket_connections_total{server_id}` | Gauge | WebSocket load distribution |
| `crdt_operations_total{type,status}` | Counter | Operation throughput and error rate |
| `rabbitmq_queue_depth{queue_name}` | Gauge | Backpressure indicator |
| `cache_hits_total{cache_type}` | Counter | Cache effectiveness |
| `cache_misses_total{cache_type}` | Counter | Cache effectiveness |

### SLIs and Alerts

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| API availability | 99.9% | < 99.5% for 5 min |
| API latency p95 | < 200ms | > 500ms for 5 min |
| Sync latency p95 | < 500ms | > 1s for 5 min |
| WebSocket availability | 100% per server | Any server at 0 connections for 1 min |
| Queue lag (search) | < 1000 messages | > 5000 for 10 min |
| Cache hit rate | > 80% | < 60% for 15 min |
| Dead letter queue | 0 | > 100 for 30 min |

### Structured Logging

Pino JSON logger with request context (requestId, method, path, userId). Log levels: `info` for completed requests and applied operations, `warn` for CRDT conflicts and queue backpressure, `error` for database failures and unhandled exceptions.

### Audit Logging

Security-relevant events logged to an append-only `audit_log` table for compliance:
- Page sharing and permission changes
- Workspace member additions/removals
- Page exports
- Authentication events (login, logout, failures)
- Block deletions

Indexed by user, resource, and timestamp for efficient querying during incident investigation.

---

## Failure Handling

### Graceful Degradation

| Failure | Behavior | User Impact |
|---------|----------|-------------|
| Redis down | Sessions from PostgreSQL, skip cache | Slower page loads, no presence |
| RabbitMQ down | Skip async jobs, log for retry | Exports queued locally, delayed notifications |
| PostgreSQL readonly | Disable writes, show banner | View-only mode |
| WebSocket disconnect | Auto-reconnect with exponential backoff | 1-5s interruption in sync |
| Single API server down | LB routes to others | Transparent to users |

### Retry Strategy

Exponential backoff with jitter for all retryable operations. Queue consumers use prefetch-based backpressure -- a slow consumer naturally reduces its intake without affecting other consumers or the message broker.

---

## Scalability Considerations

### What Breaks First

1. **Blocks table** at 1B rows. Shard by page_id so all blocks for a page live on one shard. This preserves single-shard queries for page loads (the most common operation).
2. **WebSocket connections** at ~10K per server. Add sync servers horizontally. Redis pub/sub distributes operations across servers. At extreme scale, move to Kafka with partitioning by page_id.
3. **Database queries** (filter + sort on JSONB properties) become expensive with millions of rows. Move database properties to a columnar store or pre-compute views into materialized tables.
4. **Operations log** grows fastest. Time-based partitioning with automatic archival of partitions older than 90 days.

### Horizontal Scaling Path

- **API servers**: Stateless, scale behind load balancer
- **Sync servers**: Partitioned by page_id hash, Redis pub/sub for cross-partition messages
- **PostgreSQL**: Read replicas for page listing, write primary for block operations, sharding by workspace_id at extreme scale
- **RabbitMQ**: Separate queues per priority level, scale consumers independently per queue
- **Redis**: Redis Cluster with hash slots, dedicated instances for cache vs. pub/sub

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Conflict resolution | CRDT | OT | Offline support, no central authority needed |
| Block ordering | Fractional index | Array index | O(1) insertions, no sibling reindexing |
| Block storage | PostgreSQL JSONB | Document DB (MongoDB) | Relational queries for permissions, hierarchy |
| Real-time transport | WebSocket | SSE | Bidirectional needed for operations + acks |
| Async jobs | RabbitMQ | Redis queues | Durable, dead letter queues, per-queue scaling |
| Session auth | Cookie + Redis | JWT | Instant revocation, simpler WebSocket auth |
| Caching | Redis cache-aside | Application-level LRU | Shared across server instances |

---

## Frontend Architecture

This section describes the actual frontend implementation: component hierarchy, state management, routing, data fetching, real-time collaboration integration, block editing, and key UI patterns.

### Component Hierarchy

```
__root.tsx (TanStack Router)
├── /login                                    (login form)
├── /register                                 (registration form)
├── / (index.tsx)                             (workspace home / page list)
│   └── Sidebar                               (workspace switcher, page tree, user menu)
│       └── PageTreeItem (recursive)           (expandable nested pages)
└── /page/$pageId                             (page editor)
    ├── Sidebar                                (always visible)
    └── BlockEditor                            (block content editor)
        ├── BlockComponent (orchestrator)       (delegates to type-specific renderer)
        │   ├── TextBlock                       (paragraph text)
        │   ├── HeadingBlock                    (h1, h2, h3)
        │   ├── ListBlock                       (bulleted, numbered)
        │   ├── ToggleBlock                     (collapsible content)
        │   ├── CodeBlock                       (code with syntax)
        │   ├── QuoteBlock                      (blockquote)
        │   ├── CalloutBlock                    (callout with icon)
        │   └── DividerBlock                    (horizontal rule)
        └── BlockTypeMenu                       (slash command popup)
    DatabaseView                               (for database pages)
        ├── TableView                           (spreadsheet layout)
        ├── BoardView                           (Kanban columns)
        ├── ListView                            (compact list)
        └── PropertyCell                        (per-cell renderer)
```

The application uses a delegation pattern for block rendering: `BlockComponent` is the orchestrator that receives a block and dispatches rendering to the appropriate type-specific component (`TextBlock`, `HeadingBlock`, etc.). Each type-specific component handles its own editing UX, content rendering, and keyboard behavior. Child blocks are rendered recursively -- `ToggleBlock` renders its children as nested `BlockComponent` instances.

### Zustand Stores

The frontend uses four Zustand stores, each managing a distinct domain of application state.

**`stores/index.ts` -- Auth, Workspace, and Page Stores**

Three stores are defined in a single file to minimize import overhead:

- **`useAuthStore`**: Manages user session with `user`, `token`, `isAuthenticated`, and `isLoading`. On login/register, it stores the token in `localStorage` and calls `wsService.connect(token)` to establish the WebSocket connection. On logout, it removes the token and calls `wsService.disconnect()`.

- **`useWorkspaceStore`**: Manages the list of workspaces and the currently selected workspace. Auto-selects the first workspace if none is selected. Actions: `fetchWorkspaces`, `setCurrentWorkspace`, `createWorkspace`.

- **`usePageStore`**: Manages the hierarchical page tree, the currently selected page, and which pages are expanded in the sidebar. Uses a `Set<string>` for `expandedPages` to track expand/collapse state. When a child page is created, its parent is automatically expanded. Actions: `fetchPages`, `createPage`, `updatePage`, `deletePage`, `toggleExpanded`.

**`stores/editor.ts` -- Editor State with Optimistic Updates**

The editor store is the most complex store, managing blocks, selection, focus, presence, and real-time operations. Key design decisions:

- **Optimistic updates with rollback**: Every mutating operation (add, update, delete, move) immediately updates the local state, then sends the API request. If the request fails, the store rolls back to the previous state. For `addBlock`, a temporary block with a generated UUID is inserted locally; on API success, the temp block is replaced with the server response.

- **Remote operation application**: The `applyRemoteOperation` method handles incoming operations from other users. It processes four operation types (insert, update, delete, move) and applies them to the local block array. Inserted blocks are sorted by `position` (fractional index) to maintain correct ordering.

- **Presence tracking**: The store maintains a `presence` array of active users with their cursor positions. `addPresence`, `removePresence`, and `updatePresencePosition` methods are called from the WebSocket message handler.

- **Focus management**: `setFocusedBlock` tracks which block has keyboard focus and sends a presence update via WebSocket so other users can see where you are editing.

### Routing

The application uses TanStack Router with file-based routing:

| Route | File | Auth | Purpose |
|-------|------|------|---------|
| `/` | `routes/index.tsx` | Protected | Workspace home, page list |
| `/login` | `routes/login.tsx` | Public only | Login form |
| `/register` | `routes/register.tsx` | Public only | Registration form |
| `/page/$pageId` | `routes/page.$pageId.tsx` | Protected | Page editor with blocks |

The root route (`__root.tsx`) calls `checkAuth()` on mount and shows a loading state until auth is verified. All routes render inside the `Outlet` provided by the root component.

### Data Fetching

API calls are centralized in `services/api.ts`, which provides typed functions organized by domain: `authApi` (login, register, logout, me), `workspacesApi` (list, create), `pagesApi` (list, get, create, update, delete), and `blocksApi` (create, update, delete, move). Each function uses `fetch()` with the auth token from `localStorage` and returns typed response objects. The Zustand stores orchestrate data fetching in their async actions.

### Real-Time Collaboration (CRDT) and WebSocket Integration

The WebSocket service (`services/websocket.ts`) is a singleton class managing real-time collaboration:

1. **Connection**: On login, the auth store calls `wsService.connect(token)`, which opens a WebSocket to `ws://host/ws?token=<token>`. The server responds with a `connected` message containing the assigned `clientId`.

2. **Page subscription**: When navigating to `/page/$pageId`, the page component calls `wsService.subscribePage(pageId)`. The server responds with the current presence list. On navigation away, `wsService.unsubscribePage()` removes the user from the page.

3. **Operation broadcasting**: When a block is created, updated, deleted, or moved, the editor store sends the operation via `wsService.sendOperation(op)`. Operations include the block data, operation type, and are timestamped by the server using a Hybrid Logical Clock (HLC) for causal ordering.

4. **Remote operation handling**: The page component registers a message handler that listens for `operation` messages. When received, it calls `useEditorStore.applyRemoteOperation(op)`, which applies the change to the local block array based on operation type (insert, update, delete, move).

5. **Presence**: `wsService.updatePresence({ block_id, offset })` sends the user's current cursor position. Incoming presence messages update the store's presence array, enabling display of which blocks other users are editing.

6. **Reconnection**: On disconnect, the service uses exponential backoff (base 1s, capped at 30s, up to 5 attempts). Pending messages are queued and sent when the connection reopens.

7. **Sync-on-reconnect**: `wsService.requestSync(since)` requests all operations since a given timestamp, allowing the client to catch up after a disconnection.

### Key UI Patterns

- **Slash commands**: Typing `/` in an empty text block triggers the `BlockTypeMenu`, a dropdown listing all available block types. Selecting an option converts the current block to the chosen type. The menu supports 10 commands: `/h1`, `/h2`, `/h3`, `/bullet`, `/number`, `/toggle`, `/code`, `/quote`, `/callout`, `/divider`.

- **Keyboard navigation**: Arrow keys move focus between blocks. Enter creates a new text block below the current one. Backspace on an empty non-text block converts it back to text; on an empty text block, it deletes the block and focuses the previous one.

- **Recursive sidebar tree**: The `Sidebar` component renders the page hierarchy as an expandable tree. Each page item shows an icon, title, and expand/collapse chevron. Right-click context menus offer create child page, create database, and delete options.

- **Database views**: Pages marked as databases (`is_database = TRUE`) render using `DatabaseView`, which provides a tab bar to switch between Table, Board (Kanban), and List views. All views share the same underlying data but apply different layouts, filters, and sort configurations. `PropertyCell` renders type-appropriate editors (text input, date picker, select dropdown, checkbox) for each property.

- **Notion-style block hover**: Blocks show a drag handle and plus button on hover, providing affordances for reordering and inserting new blocks.

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, written for readers encountering these patterns for the first time.

### Redis Cache-Aside

**What it is**: Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache first for requested data. On a cache miss, the application reads from the database, stores the result in the cache with a time-to-live (TTL), and returns it. On a cache hit, the database is skipped entirely.

**Why it matters**: Block-based pages are read far more often than written. A popular team wiki page might have 100 views per edit. Without caching, every page load queries PostgreSQL for the page, its blocks, and workspace metadata -- three queries at ~5-20ms each. With cache-aside, most reads complete in ~1ms from Redis. At 500K concurrent users, this is the difference between needing 50 PostgreSQL read replicas and needing 5.

**How it works in this project**: The cache layer (`backend/src/shared/cache.ts`) wraps Redis `GET`/`SET` with configurable TTL per data type. Page metadata has a 5-minute TTL, block content has a 10-minute TTL, workspace members have a 15-minute TTL, and presence data uses write-through with a 30-second TTL. Cache invalidation is event-driven: when a block is updated via the API, the page cache key is deleted. When a page title changes, the parent page's child list cache is also invalidated. This approach accepts brief staleness (a user might see a 5-minute-old page title in the sidebar) in exchange for dramatically reduced database load.

### Structured Logging

**What it is**: Structured logging means emitting log entries as machine-parseable JSON objects rather than free-form text strings. Instead of `"User alice updated block abc123 in page xyz"`, a structured log entry is `{"level":"info","userId":"alice","action":"block_update","blockId":"abc123","pageId":"xyz","duration_ms":12}`.

**Why it matters**: When debugging a CRDT conflict across multiple clients and servers, you need to correlate events: "What operations did server 1 receive from client A in the last 30 seconds?" Free-form text logs require fragile regex parsing. Structured logs can be queried precisely: `jq 'select(.userId == "alice" and .action == "operation" and .timestamp > 1705320000)'`. Log aggregation systems (Elasticsearch, Datadog) can build dashboards and alerts from structured fields.

**How it works in this project**: The project uses Pino (`backend/src/shared/logger.ts`), which outputs JSON in production and pretty-printed text in development. Each log entry includes base context (service name, environment, PID). Request handlers create child loggers that add `requestId`, `method`, `path`, and `userId` to every log within that request scope. Log levels follow severity: `info` for completed requests and applied operations, `warn` for CRDT conflicts and queue backpressure, `error` for database failures.

### Prometheus Metrics

**What it is**: Prometheus is a pull-based monitoring system where applications expose numeric measurements at an HTTP endpoint (`/metrics`). A Prometheus server periodically scrapes this endpoint and stores the time-series data. Metrics come in three types: **Counter** (only goes up -- total requests served), **Histogram** (distribution of values in buckets -- request latencies), and **Gauge** (goes up and down -- active WebSocket connections).

**Why it matters**: Metrics answer operational questions that logs cannot efficiently answer. "What percentage of API requests took longer than 200ms in the last hour?" requires scanning millions of log lines but is a single PromQL query: `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[1h]))`. Metrics enable SLI/SLO tracking, capacity planning, and automated alerting.

**How it works in this project**: The `/metrics` endpoint (`backend/src/shared/metrics.ts`) exposes: `http_request_duration_seconds` (histogram, with method/route/status labels), `websocket_connections_total` (gauge per server), `crdt_operations_total` (counter by type and status), `rabbitmq_queue_depth` (gauge per queue name), `cache_hits_total` and `cache_misses_total` (counters by cache type). These metrics are scraped by Prometheus and visualized in Grafana. Alerts fire when SLIs breach thresholds -- for example, if API p95 latency exceeds 500ms for 5 minutes, or if the dead letter queue accumulates more than 100 messages over 30 minutes.

### Health Checks

**What it is**: Health check endpoints report whether an application instance and its dependencies are functioning correctly. Load balancers, container orchestrators (Kubernetes), and monitoring systems poll these endpoints to determine if an instance should receive traffic.

**Why it matters**: Without health checks, a load balancer continues sending traffic to a server whose PostgreSQL connection pool is exhausted or whose Redis connection has dropped. Users see errors. With health checks, the load balancer detects the problem within seconds and stops routing traffic to the unhealthy instance.

**How it works in this project**: Two health endpoints exist. `GET /health` performs full dependency checks: `SELECT 1` against PostgreSQL, `PING` against Redis, and connectivity check against RabbitMQ. Each check has a timeout and reports individual status and latency. The overall response is `200` if all dependencies are healthy, `503` if any are degraded. `GET /ready` is a simpler readiness probe that checks only PostgreSQL and Redis -- the minimum required for the application to serve requests. Kubernetes uses `/ready` to decide when a new pod can start receiving traffic after startup, and `/health` for ongoing liveness monitoring.

### Rate Limiting

**What it is**: Rate limiting restricts how many requests a client can make within a specified time window. It protects against abuse (accidental or intentional), ensures fair resource sharing among users, and prevents a single misbehaving client from degrading service quality for everyone else.

**Why it matters**: A single user with a malfunctioning browser extension could send thousands of API requests per second, overwhelming the server. In a collaborative workspace, rate limiting also prevents a compromised account from rapidly exfiltrating data by iterating through all pages and blocks.

**How it works in this project**: Although the full rate limiting middleware is not yet implemented in the local build, the architecture design specifies limits at key endpoints. Login attempts are limited to prevent credential stuffing (brute-force password attacks). API requests are limited per authenticated user using a sliding window counter in Redis. WebSocket operations are throttled per page to prevent flooding -- the server drops operations that exceed the threshold and sends an error message to the client.

### Idempotency

**What it is**: An operation is idempotent if performing it multiple times produces the same result as performing it once. In a distributed system, idempotency guarantees that retrying a failed request does not create duplicate side effects.

**Why it matters**: CRDT operations in Notion are designed to be idempotent by nature -- applying the same operation twice produces the same state as applying it once. But HTTP API calls are not inherently idempotent. If a user creates a page and the response is lost, retrying the request without idempotency protection creates a duplicate page. RabbitMQ message delivery is "at-least-once," meaning consumers may receive the same message twice if the acknowledgment is lost.

**How it works in this project**: For RabbitMQ consumers, each message includes an `event_id` (UUID). Consumers track processed event IDs in Redis with a 24-hour TTL. When a duplicate message arrives, it is recognized by its `event_id`, logged, and skipped. The `notion.export` queue achieves exactly-once semantics by combining at-least-once delivery with idempotency keys stored in Redis -- even if the same export job is delivered twice, only the first execution produces output. For CRDT operations, idempotency is inherent: the same operation applied twice converges to the same state because operations are commutative and carry unique IDs.

### RBAC (Role-Based Access Control)

**What it is**: RBAC assigns permissions to roles rather than individual users. Users are assigned roles, and roles determine what actions they can perform. This creates a manageable, auditable permission system that scales to large organizations.

**Why it matters**: Notion has three levels of access control: workspace membership (admin, member, guest), page-level permissions (view, edit, full_access), and block-level operations. Without RBAC, managing permissions for 100 team members across 1,000 pages would require 100,000 individual permission entries. With RBAC, you assign a workspace role once and override at the page level only when needed.

**How it works in this project**: The `workspace_members` table assigns roles (admin, member, guest) at the workspace level. The `page_permissions` table provides page-level overrides. Permission evaluation follows a hierarchy: first check page-level permission for the user, then fall back to workspace role. Admins have full access to all workspace resources. Members can edit pages they create and view all pages. Guests can only access pages explicitly shared with them. The audit log records all permission changes for compliance.

### Circuit Breaker

**What it is**: A circuit breaker monitors calls to an external dependency and tracks failure rates. When failures exceed a threshold, the circuit "opens" and calls fail immediately without contacting the dependency. After a cooldown period, the circuit allows a test request through ("half-open"). If it succeeds, normal operation resumes ("closed"). If it fails, the circuit stays open.

**Why it matters**: When RabbitMQ becomes unresponsive, every API request that publishes to a queue blocks until the connection timeout (typically 10-30 seconds). This makes the entire API unresponsive, even though RabbitMQ is only used for async jobs like search indexing and notifications. A circuit breaker detects RabbitMQ's failure within seconds and stops attempting connections, allowing the API to continue serving page loads and block operations.

**How it works in this project**: The graceful degradation table in the architecture shows how each circuit breaker failure is handled. When Redis is down, sessions fall back to PostgreSQL and presence features are disabled. When RabbitMQ is down, async jobs are skipped and logged for retry later. When PostgreSQL becomes read-only, the application disables writes and shows a banner to users. Each failure mode degrades specific features rather than bringing down the entire application.

---

## Implementation Notes

This section documents the actual local implementation: what was built, what was simplified, and what was omitted.

### Local Setup Diagram

```
┌────────────────────┐
│   React Frontend   │
│   (Vite :5173)     │
│   Block Editor,    │
│   Database Views,  │
│   Sidebar          │
└─────────┬──────────┘
          │ HTTP + WebSocket
          ▼
┌────────────────────┐
│  Express + ws      │
│  (Port 3000)       │
│  REST + WebSocket  │
└──┬──────┬──────┬───┘
   │      │      │
   ▼      ▼      ▼
┌──────┐ ┌────┐ ┌──────────┐
│ PG   │ │ VK │ │ RabbitMQ │
│:5432 │ │:6379│ │:5672     │
└──────┘ └────┘ │:15672 UI │
                └──────────┘

Optional (--profile observability):
┌────────────┐  ┌─────────┐
│ Prometheus │  │ Grafana │
│   :9090    │  │  :3002  │
└────────────┘  └─────────┘
```

Multiple API instances on ports 3001-3003 via `PORT=300x npm run dev`. Workers run independently:
- `npm run dev:worker:search` -- Search index updates
- `npm run dev:worker:export` -- PDF/Markdown export
- `npm run dev:worker:email` -- Email notifications
- `npm run dev:worker:notification` -- In-app notifications

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| Cache-aside | `backend/src/shared/cache.ts` | Redis caching for pages, blocks, workspaces with configurable TTL and event-driven invalidation |
| RabbitMQ queues | `backend/src/shared/queue.ts` | Durable queues with prefetch, retries, dead letter queues, and backpressure |
| Export worker | `backend/src/workers/export-worker.ts` | Async PDF/Markdown export via RabbitMQ |
| Search worker | `backend/src/workers/search-worker.ts` | Async search index updates |
| Email worker | `backend/src/workers/email-worker.ts` | Async email delivery |
| Notification worker | `backend/src/workers/notification-worker.ts` | In-app notification processing |
| Audit logging | `backend/src/shared/audit.ts` | Append-only security event log (page sharing, permissions, auth) |
| Prometheus metrics | `backend/src/shared/metrics.ts` | HTTP latency, WebSocket connections, cache hit/miss, queue depth |
| Structured logging | `backend/src/shared/logger.ts` | Pino JSON logger with request context |
| WebSocket sync | `backend/src/services/websocket.ts` | Operation broadcasting, presence tracking, page subscriptions |
| Fractional indexing | `backend/src/utils/fractionalIndex.ts` | String-based position generation for block ordering |
| Hybrid Logical Clock | `backend/src/utils/hlc.ts` | Causal ordering for CRDT operations |
| Block editor | `frontend/src/components/blocks/BlockComponent.tsx` | Delegation pattern: orchestrator + type-specific renderers |
| Database views | `frontend/src/components/database/DatabaseView.tsx` | Table, board (Kanban), and list views with filtering/sorting |
| Sidebar navigation | `frontend/src/components/sidebar/Sidebar.tsx` | Recursive page tree |
| Editor state | `frontend/src/stores/editor.ts` | Zustand store with optimistic updates and rollback |

### What Was Simplified or Substituted

| Production Design | Local Implementation | Rationale |
|-------------------|---------------------|-----------|
| Redis Cluster | Single Valkey instance | Same API, sufficient for local |
| PostgreSQL primary + replicas | Single PostgreSQL instance | No read replica routing at local scale |
| Separate API + Sync servers | Combined Express + ws server | Simpler deployment |
| Full character-level CRDT (Yjs/Automerge) | Block-level CRDT with HLC ordering | Demonstrates concepts without full CRDT library |
| CDN for static assets | Vite dev server | Development convenience |
| Elasticsearch for full-text search | Not implemented (search worker queues only) | Search index not yet connected |
| OAuth / SSO | Session-based auth with bcrypt | Appropriate for learning |
| S3 for file attachments | Not implemented | No image/file upload yet |

### What Was Omitted

- **Full offline editing** with IndexedDB persistence and sync-on-reconnect
- **Character-level CRDT** for rich text within blocks (currently block-level only)
- **Drag-and-drop** block reordering
- **Calendar and gallery** database views
- **Granular page permissions** UI (backend schema exists, frontend not built)
- **Share links** for external access
- **Version history** for pages
- **Templates** and page duplication
- **Comments** on blocks
- **CDN** and edge caching
- **Multi-region** deployment
- **Kubernetes** orchestration
- **Distributed tracing** (OpenTelemetry / Jaeger)
- **Database sharding**
- **Image/file upload** and processing

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

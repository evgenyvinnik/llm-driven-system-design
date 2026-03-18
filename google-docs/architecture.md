# Google Docs - Collaborative Editing - Architecture Design

## System Overview

A real-time collaborative document editing platform enabling multiple users to simultaneously edit rich-text documents with conflict resolution, presence awareness, comments, and version history.

---

## Requirements

### Functional Requirements

- **Document editing**: Rich text formatting (bold, italic, headings, lists, links)
- **Real-time collaboration**: Multiple users editing simultaneously with live cursor positions
- **Version history**: Automatic snapshots with named versions and restore capability
- **Commenting**: Threaded comments with text anchoring and resolution workflow
- **Suggestions**: Track changes mode with accept/reject workflow
- **Sharing**: Granular permissions (view, comment, edit) per user or email

### Non-Functional Requirements

- **Availability**: 99.99% uptime for document editing and collaboration
- **Latency**:
  - Document load: p95 < 300ms
  - Operation sync: p95 < 100ms (keystroke to other users' screens)
  - API responses: p95 < 200ms
- **Consistency**: Strong consistency for document state via Operational Transformation; eventual consistency acceptable for presence and read replicas
- **Scalability**: Support 10M+ documents, 500K+ concurrent editors, 50K+ concurrent documents

---

## Capacity Estimation

### Production Scale

| Metric | Target |
|--------|--------|
| Registered users | 50M |
| Daily active users | 5M |
| Concurrent editors | 500K |
| Active documents | 50K simultaneously |
| Peak API RPS | 200K |
| Peak WebSocket messages/sec | 2M |
| Average document size | 50KB |
| Operations per document/sec | 5-50 |

### Storage Growth (Production)

| Data Type | Size/Unit | Daily Growth | 1 Year Projection |
|-----------|-----------|--------------|-------------------|
| Documents (content) | 50KB avg | 500K new docs/day | 9TB |
| Document versions | 50KB each | 5M snapshots/day | 90TB |
| Operations log | 200 bytes/op | 500M ops/day | 36TB |
| Comments | 500 bytes avg | 2M/day | 365GB |

### Local Development Scale

| Metric | Target | Rationale |
|--------|--------|-----------|
| Concurrent users | 10-50 | Testing collaboration scenarios |
| Active documents | 5-20 | Documents being edited simultaneously |
| Peak RPS (API) | 50-100 | Document CRUD, comments, auth |
| Peak WebSocket messages/sec | 200-500 | Operations, presence, cursor updates |
| Total storage (1 year) | ~3GB | Well within single PostgreSQL instance |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Client Layer                                   │
│     React 19 + TipTap/ProseMirror + WebSocket + Zustand              │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
                    HTTP REST + WebSocket (wss://)
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        CDN / Edge Layer                               │
│              Static assets, SSL termination, DDoS protection         │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     API Gateway / Load Balancer                       │
│         Sticky sessions by document_id, rate limiting, routing       │
└──────┬───────┬───────┬───────┬───────┬───────────────────────────────┘
       │       │       │       │       │
       ▼       ▼       ▼       ▼       ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  API-1   │ │  API-2   │ │  API-3   │ │  API-4   │ │  API-N   │
│ REST +   │ │ REST +   │ │ REST +   │ │ REST +   │ │ REST +   │
│ WebSocket│ │ WebSocket│ │ WebSocket│ │ WebSocket│ │ WebSocket│
└────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
     │             │            │             │            │
     └─────────────┴────────────┴─────────────┴────────────┘
                    │                         │
     ┌──────────────▼──────────┐  ┌──────────▼────────────────┐
     │     Redis Cluster       │  │   PostgreSQL (Primary)     │
     │  ┌───────────────────┐  │  │   + Read Replicas          │
     │  │ Sessions, Pub/Sub │  │  │                            │
     │  │ Presence, OT Ops  │  │  │  Documents, Users,         │
     │  │ Version Counters  │  │  │  Permissions, Versions,    │
     │  └───────────────────┘  │  │  Operations, Comments      │
     └─────────────────────────┘  └────────────────────────────┘
```

### Core Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **Web Client** | Rich text editor, local OT, presence UI | React 19, TipTap/ProseMirror, WebSocket |
| **CDN** | Static asset delivery, edge caching | CloudFront / Cloudflare |
| **API Gateway** | Request routing, sticky sessions, SSL termination, rate limiting | nginx / AWS ALB |
| **API Server** | REST API + WebSocket server, OT processing | Node.js, Express, ws library |
| **Session Store** | User sessions, WebSocket connection tracking | Redis with 24h TTL |
| **Pub/Sub Bus** | Cross-server operation broadcast, presence sync | Redis pub/sub |
| **Primary Database** | Documents, users, permissions, versions, ops | PostgreSQL 16 |
| **Read Replicas** | Document listing, version history, search | PostgreSQL streaming replication |

---

## Request Flow

### 1. Document Load Flow

```
Browser                    API Server                 Redis              PostgreSQL
   │                           │                        │                     │
   │── GET /api/docs/:id ─────▶│                        │                     │
   │                           │── Check session ──────▶│                     │
   │                           │◀── Session valid ──────│                     │
   │                           │                        │                     │
   │                           │── Query document, permissions, comments ────▶│
   │                           │◀── Document data, user's permission ────────│
   │                           │                        │                     │
   │◀── 200 {doc, permission} ─│                        │                     │
   │                           │                        │                     │
   │══ WebSocket upgrade ═════▶│                        │                     │
   │                           │── SUBSCRIBE doc:{id} ─▶│                     │
   │                           │── SADD presence:{id} ─▶│                     │
   │◀═ WS: presence update ═══│                        │                     │
```

### 2. Operation Sync Flow (Real-time Editing)

```
Browser A       API Server 1        Redis Pub/Sub      API Server 2       Browser B
    │                │                    │                  │                │
    │══ WS: op A ═══▶│                    │                  │                │
    │                │── Transform op ────│                  │                │
    │                │── ACK + version ──▶│                  │                │
    │                │                    │                  │                │
    │                │── PUBLISH op ─────▶│                  │                │
    │                │                    │── op broadcast ─▶│                │
    │                │                    │                  │══ WS: op A ═══▶│
    │                │                    │                  │                │
    │                │── INSERT ops ──────│──────────────────│───────────────▶│
    │                │                    │                  │          PostgreSQL
```

### 3. Version Snapshot Flow

```
API Server                    PostgreSQL
     │                            │
     │── Every 50 ops OR 5 min ──▶│
     │                            │
     │── BEGIN TRANSACTION ──────▶│
     │── INSERT document_versions │
     │── UPDATE documents.version │
     │── COMMIT ─────────────────▶│
```

---

## Database Schema

```sql
-- Users: Authentication and profile
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,        -- bcrypt, cost=10
    avatar_color VARCHAR(7) DEFAULT '#3B82F6',  -- Hex color for presence
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Documents: Rich text content as ProseMirror JSON
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL DEFAULT 'Untitled Document',
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_version BIGINT DEFAULT 0,           -- OT version counter
    content JSONB NOT NULL,                     -- ProseMirror document JSON
    is_deleted BOOLEAN DEFAULT FALSE,           -- Soft delete
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Permissions: Sharing with granular access levels
CREATE TABLE document_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255),                         -- For invite-by-email before signup
    permission_level VARCHAR(20) NOT NULL
        CHECK (permission_level IN ('view', 'comment', 'edit')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, user_id),
    UNIQUE(document_id, email)
);

-- Operations: Append-only log for OT replay and debugging
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number BIGINT NOT NULL,
    operation JSONB NOT NULL,                   -- {type, position, text/length, attrs}
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, version_number)
);

-- Versions: Periodic snapshots for history and recovery
CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number BIGINT NOT NULL,
    content JSONB NOT NULL,                     -- Full document snapshot
    created_by UUID REFERENCES users(id),
    is_named BOOLEAN DEFAULT FALSE,             -- User-named versions
    name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, version_number)
);

-- Comments: Threaded comments anchored to text ranges
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    anchor_start INTEGER,                       -- Character offset
    anchor_end INTEGER,
    anchor_version BIGINT,                      -- Version when anchor was created
    content TEXT NOT NULL,
    author_id UUID NOT NULL REFERENCES users(id),
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Suggestions: Track changes for review workflow
CREATE TABLE suggestions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    suggestion_type VARCHAR(20) NOT NULL
        CHECK (suggestion_type IN ('insert', 'delete', 'replace')),
    anchor_start INTEGER NOT NULL,
    anchor_end INTEGER NOT NULL,
    anchor_version BIGINT NOT NULL,
    original_text TEXT,
    suggested_text TEXT,
    author_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions: Server-side session storage (backup to Redis)
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Key Indexes

```sql
CREATE INDEX idx_documents_owner ON documents(owner_id) WHERE NOT is_deleted;
CREATE INDEX idx_documents_updated ON documents(updated_at DESC);
CREATE INDEX idx_document_permissions_user ON document_permissions(user_id);
CREATE INDEX idx_operations_doc ON operations(document_id, version_number);
CREATE INDEX idx_document_versions_doc ON document_versions(document_id, version_number DESC);
CREATE INDEX idx_comments_doc ON comments(document_id);
CREATE INDEX idx_suggestions_doc ON suggestions(document_id);
CREATE INDEX idx_sessions_token ON sessions(token);
```

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `session:{token}` | String (JSON) | 24h | User session data |
| `doc:{id}:version` | String (int) | None | Current OT version for document |
| `doc:{id}:ops` | List | 1h | Recent ops buffer for late joiners |
| `presence:{docId}` | Set | None | User IDs currently in document |
| `user:{userId}:cursor:{docId}` | Hash | 30s | Cursor position {line, col, selection} |
| `channel:doc:{id}` | Pub/Sub | N/A | Operation broadcast channel |
| `channel:presence:{id}` | Pub/Sub | N/A | Presence update channel |

---

## Storage Strategy

### Write Path

1. Operation arrives via WebSocket
2. Transform against pending ops (OT algorithm)
3. Assign version number (Redis INCR)
4. Append to Redis ops buffer
5. Broadcast via Redis pub/sub
6. Async batch insert to PostgreSQL operations table
7. Periodic snapshot to document_versions + update documents.content

### Read Path

1. Load document.content from PostgreSQL (full snapshot)
2. Fetch ops from Redis buffer since last snapshot version
3. Apply ops to bring client up to current state
4. Subscribe to pub/sub for live updates

### Caching Strategy

| Data | Strategy | TTL | Invalidation |
|------|----------|-----|--------------|
| Document content | Cache-aside | 5 minutes | On any edit operation |
| User profile | Cache-aside | 1 hour | On profile update |
| Permission | Cache-aside | 10 minutes | On share/unshare |
| Session | Write-through | 24 hours | On logout or expiry |

---

## API Design

### REST Endpoints

```
Authentication:
POST   /api/auth/register     - Create account
POST   /api/auth/login        - Create session
POST   /api/auth/logout       - Destroy session
GET    /api/auth/me           - Get current user

Documents:
GET    /api/docs              - List user's documents (owned + shared)
POST   /api/docs              - Create document
GET    /api/docs/:id          - Get document with content
PUT    /api/docs/:id          - Update document metadata (title)
DELETE /api/docs/:id          - Soft delete document

Sharing:
GET    /api/docs/:id/permissions        - List permissions
POST   /api/docs/:id/permissions        - Add permission
DELETE /api/docs/:id/permissions/:pid   - Remove permission

Comments:
GET    /api/docs/:id/comments           - List comments
POST   /api/docs/:id/comments           - Create comment
PUT    /api/docs/:id/comments/:cid      - Update/resolve comment
DELETE /api/docs/:id/comments/:cid      - Delete comment

Versions:
GET    /api/docs/:id/versions           - List versions
GET    /api/docs/:id/versions/:vid      - Get version content
POST   /api/docs/:id/versions/:vid/restore - Restore to version

Admin (role=admin only):
GET    /api/admin/users                 - List users
GET    /api/admin/stats                 - System statistics
```

### WebSocket Protocol

```
Client -> Server:
{ type: 'join', docId, version }
{ type: 'leave', docId }
{ type: 'operation', docId, version, op }
{ type: 'cursor', docId, position }
{ type: 'ping' }

Server -> Client:
{ type: 'joined', docId, version, ops, users }
{ type: 'operation', docId, version, op, userId }
{ type: 'ack', docId, version }
{ type: 'cursor', docId, userId, position }
{ type: 'presence', docId, users }
{ type: 'error', code, message }
{ type: 'pong' }
```

---

## Key Design Decisions

### Operational Transformation (OT) vs CRDT

**Decision**: Use OT for collaborative editing.

OT requires a central authority (the server) to order operations, which fits our architecture where each document is routed to a specific server via sticky sessions. CRDTs would eliminate this central authority requirement, enabling true peer-to-peer and offline-first editing, but they carry per-character metadata that increases memory usage by 3-5x for text-heavy documents. For a 50KB document, CRDT metadata could add 150-250KB of overhead per client.

The trade-off is that OT makes offline editing harder -- queued operations must be carefully transformed against the server's accepted operations on reconnect. For a document editor where users are almost always online, this is acceptable. If we needed robust offline support (like a mobile-first editor), CRDTs would be the better choice despite the memory cost.

### Sticky Sessions by Document

**Decision**: Route all WebSocket connections for a document to the same server via consistent hashing on document_id.

This means a single server holds the authoritative OT state for each document, eliminating distributed coordination for operation ordering. Without sticky sessions, every operation would require a distributed lock or consensus protocol to determine ordering, adding 10-50ms of latency per keystroke -- users would perceive this as laggy.

The trade-off is hot-spot risk: a viral document with 200 concurrent editors concentrates all load on one server. We mitigate this with Redis pub/sub for cross-server presence updates, and at extreme scale, document sectioning (splitting a document into independently editable regions).

### Session-based Auth (not JWT)

**Decision**: Cookie-based sessions stored in Redis.

For a collaborative editor, immediate session revocation is critical -- if a user is removed from a shared document, their WebSocket connection should be terminated within seconds, not wait for a JWT to expire. Redis session lookup adds ~1ms per request, but enables instant revocation with a single `DEL` command. JWTs would require maintaining a blocklist, negating their stateless advantage. Cookies are also sent automatically with WebSocket upgrade requests, simplifying the auth flow.

---

## Consistency and Idempotency

### Idempotency for OT Operations

Network connections are unreliable. Clients must retry operations when they do not receive acknowledgments, but without idempotency, retries corrupt document state:
- User types "hello" at position 10; network drops before ACK; client retries; without idempotency, "hellohello" appears.
- OT version vectors depend on exact operation counts; duplicate operations corrupt ordering across all clients.

Each WebSocket message includes a unique `operationId`. The server checks Redis for an existing result before processing. If found, it returns the cached ACK without re-applying the operation. Key format: `op:{userId}:{documentId}:{operationId}` with 1-hour TTL.

For HTTP requests, clients include an `Idempotency-Key` header on POST/PUT/PATCH/DELETE. The server caches the response and returns it for duplicate requests.

---

## Security

### Authentication

- **Password hashing**: bcrypt with cost factor 10
- **Session tokens**: Cryptographically random 32-byte tokens
- **Session storage**: Redis primary, PostgreSQL backup
- **Session expiry**: 24 hours, sliding window on activity

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| **Owner** | Full control: edit, share, delete, transfer ownership |
| **Editor** | Edit content, add comments, view history |
| **Commenter** | Add comments and suggestions, view content |
| **Viewer** | Read-only access to content and comments |
| **Admin** | System-wide: user management, all documents access |

Enforcement occurs at three layers: REST middleware checks permission before handlers; WebSocket operations are validated against permission level stored in connection state; database queries include permission joins.

### Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /api/auth/login | 5 attempts | 15 minutes |
| POST /api/auth/register | 3 accounts | 1 hour (per IP) |
| WebSocket operations | 100 ops | 1 second (per user per doc) |
| API requests | 100 requests | 1 minute (per user) |

---

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `http_requests_total{method,path,status}` | Counter | Request volume by endpoint |
| `http_request_duration_seconds{method,path}` | Histogram | API latency SLI |
| `websocket_connections_active{server}` | Gauge | WebSocket load per server |
| `ot_operations_total{type}` | Counter | OT operations by type (insert/delete) |
| `ot_operation_latency_ms` | Histogram | Sync latency SLI |
| `documents_active_total` | Gauge | Documents with active editors |
| `cache_requests_total{cache,result}` | Counter | Cache hit/miss ratio |
| `circuit_breaker_state{name}` | Gauge | Circuit breaker health |

### Key SLIs and Alerts

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| API availability | 99.99% | < 99.9% over 5 min |
| API p95 latency | < 200ms | > 500ms over 5 min |
| WebSocket sync latency | < 100ms p95 | > 250ms over 5 min |
| OT conflict rate | < 5% | > 10% over 5 min |
| Error rate (5xx) | < 0.1% | > 1% |

### Structured Logging

JSON-formatted logs with correlation via trace IDs propagated through HTTP headers, WebSocket messages, and Redis pub/sub. Spans track: client keystroke, WebSocket receive, OT transform, Redis publish, PostgreSQL insert, and broadcast to clients.

---

## Failure Handling

### Circuit Breaker

| Dependency | Open After | Half-Open After | Fallback |
|------------|-----------|-----------------|----------|
| PostgreSQL | 5 consecutive failures | 30 seconds | Serve from Redis cache, queue writes |
| Redis | 10 consecutive failures | 10 seconds | Sessions from PostgreSQL, no presence |

### Graceful Degradation

| Failure | Degradation | User Impact |
|---------|-------------|-------------|
| Redis down | Sessions from PostgreSQL, no presence | Slower auth, no cursors |
| PostgreSQL readonly | Disable saves, show banner | View-only mode |
| Single API server down | LB routes to others | Brief reconnection |
| WebSocket disconnect | Auto-reconnect with backoff | 1-5s interruption |

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| PostgreSQL query | 3 | Exponential (100ms, 200ms, 400ms) | Read-only safe |
| PostgreSQL write | 3 | Exponential | Idempotency key in request |
| Redis operation | 3 | Exponential (50ms base) | Safe (atomic ops) |
| OT broadcast | 2 | Fixed 100ms | Message ID dedup |

---

## Scalability Considerations

### Horizontal Scaling

1. **API Servers**: Add instances behind load balancer. Sticky sessions by document_id ensure OT consistency. Redis pub/sub synchronizes across instances.
2. **Read Replicas**: PostgreSQL streaming replication. Route read queries (document list, version history) to replicas. Writes always to primary.
3. **Redis Cluster**: Partition presence data by document_id hash. Dedicated pub/sub nodes.

### Vertical Limits

| Component | Limit | Mitigation |
|-----------|-------|------------|
| Document size | 10MB content JSONB | Split into chapters/sections |
| Concurrent editors | ~50 per document | Shard by document section |
| Operations/second | 1000 per document | Batch operations client-side |
| WebSocket connections | ~10K per server | Add servers, connection pooling |

### What Breaks First

At 100K concurrent editors, Redis pub/sub becomes the bottleneck -- each operation is published once but delivered to all subscribers on the channel. Moving to Kafka with consumer groups and partitioning by document_id would provide ordered delivery at higher throughput. At 1M documents, PostgreSQL needs sharding by document_id hash or range. The operations table grows fastest and should be the first candidate for time-based partitioning with automatic old-partition archival.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Conflict resolution | OT | CRDT | Lower memory overhead, simpler with central server |
| Document storage | PostgreSQL JSONB | MongoDB/CouchDB | Fewer moving parts, JSONB handles it well |
| Cross-server sync | Redis pub/sub | RabbitMQ/Kafka | Simpler for ephemeral messages, no persistence needed |
| Editor framework | TipTap/ProseMirror | Slate.js, Quill | Best collaborative editing support |
| Session routing | Sticky sessions | Distributed OT | Avoids distributed consensus per keystroke |
| Auth mechanism | Session cookies | JWT | Instant revocation, simpler WebSocket auth |
| Real-time transport | WebSocket | SSE | Bidirectional needed for operations and acks |

---

## Implementation Notes

This section documents the actual local implementation: what was built, what was simplified, and what was omitted.

### Local Setup Diagram

```
┌───────────────────┐
│   React Frontend  │
│   (Vite :5173)    │
│   TipTap Editor   │
└────────┬──────────┘
         │ HTTP + WebSocket
         ▼
┌───────────────────┐
│  Express + ws     │
│  (Port 3000)      │
│  REST API + WS    │
└──┬─────────────┬──┘
   │             │
   ▼             ▼
┌────────┐  ┌────────────┐
│ Valkey │  │ PostgreSQL │
│ :6379  │  │   :5432    │
└────────┘  └────────────┘
```

Multiple API instances can be run on ports 3001-3003 via `PORT=300x npm run dev`.

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| Idempotency (HTTP) | `backend/src/middleware/idempotency.ts`, `backend/src/shared/idempotency.ts` | `Idempotency-Key` header support for POST/PUT/PATCH/DELETE; caches responses in Redis |
| Idempotency (WebSocket) | `backend/src/services/collaboration/sync.ts` | Unique `operationId` per OT operation; dedup via Redis before processing |
| Circuit breakers | `backend/src/shared/circuitBreaker.ts` | Opossum-based circuit breakers for DB and Redis with Prometheus state gauge |
| RBAC | `backend/src/shared/rbac.ts` | Capability-based permissions (owner/edit/comment/view) enforced at REST + WebSocket layers |
| Prometheus metrics | `backend/src/shared/metrics.ts` | Active documents, collaborators, sync latency histogram, HTTP duration, cache hit/miss, circuit breaker state |
| Structured logging | `backend/src/shared/logger.ts` | Pino JSON logger with request correlation, trace IDs |
| Health checks | `backend/src/index.ts` `/health` endpoint | PostgreSQL SELECT 1, Redis PING with per-dependency status and latency |
| OT engine | `backend/src/services/collaboration/ot.ts` | Transform functions for insert/delete with version ordering |
| Presence tracking | `backend/src/services/collaboration/presence.ts` | Redis sets for user presence per document, pub/sub for cross-server updates |

### What Was Simplified or Substituted

| Production Design | Local Implementation | Rationale |
|-------------------|---------------------|-----------|
| Redis Cluster | Single Valkey instance | Sufficient for local dev; same API |
| PostgreSQL primary + read replicas | Single PostgreSQL instance | No read replica routing needed at local scale |
| API Gateway (nginx) with sticky sessions | Direct connection to single server | No load balancing needed with 1-3 instances |
| CDN for static assets | Vite dev server | Development convenience |
| CouchDB for offline sync | Not implemented | OT via WebSocket only; no offline queue |
| OAuth / SSO | Session-based auth with bcrypt | Simpler, appropriate for learning |

### What Was Omitted

- **CDN** and edge caching for static assets
- **Multi-region** deployment and cross-region replication
- **Kubernetes** orchestration and auto-scaling
- **Full offline editing** with operation queuing and sync-on-reconnect
- **Operation batching** (combining rapid keystrokes into single ops)
- **Delta compression** for content transfers
- **Full-text search** across documents (Elasticsearch)
- **Export** to PDF/DOCX via worker queue
- **Distributed tracing** (OpenTelemetry / Jaeger)
- **Database sharding** for operations table

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

## Frontend Architecture

This section describes the actual frontend implementation: component hierarchy, state management, routing, data fetching, real-time collaboration integration, rich text editing, and key UI patterns.

### Component Hierarchy

```
App.tsx (BrowserRouter)
├── LoginPage / RegisterPage              (public routes)
├── HomePage                              (document list)
│   ├── Header                            (app bar, user info)
│   └── DocumentList                      (grid of document cards)
└── DocumentPage                          (collaborative editor)
    ├── DocumentHeader                    (title, presence dots, panel toggles)
    ├── Editor                            (TipTap rich text editor)
    │   ├── EditorToolbar                 (bold, italic, headings, lists, etc.)
    │   └── EditorContent (TipTap)        (ProseMirror-rendered document)
    ├── CommentsPanel                     (threaded comments sidebar)
    ├── VersionHistoryPanel               (version list, restore, create)
    └── ShareModal                        (permission management)
```

The top-level `App.tsx` uses React Router (`BrowserRouter`) with `ProtectedRoute` and `PublicRoute` wrappers that check `useAuthStore` for authentication state. Unauthenticated users are redirected to `/login`; authenticated users are redirected away from auth pages to `/`.

### Zustand Stores

The frontend uses two Zustand stores that separate concerns between authentication and document-level state.

**`authStore.ts` -- Authentication State**

Manages user session, token persistence, and WebSocket token synchronization. Uses Zustand's `persist` middleware to save the session token to `localStorage`, enabling session restoration across page reloads. On login or registration, the store calls `wsService.setToken(token)` to prepare the WebSocket service for authenticated connections. On logout, it calls `wsService.disconnect()` to tear down real-time connections.

Key state: `user`, `token`, `isLoading`, `error`. Actions: `login`, `register`, `logout`, `checkAuth`.

**`documentStore.ts` -- Document, Presence, Comments, and Versions**

A single store managing all document-related state: the document list, the currently open document, presence (active collaborators), comments with threading, and version history. All async actions handle loading and error states internally, and operations that modify lists (create, delete, update) perform optimistic in-memory updates.

Key state: `documents` (list view), `currentDocument` (editor view), `presence` (collaborator cursors), `comments`, `versions`. Actions include CRUD for documents, presence management (`setPresence`, `updatePresence`, `removePresence`), comment operations (create, reply, resolve, delete), and version operations (create, restore).

### Routing

The application uses React Router v6 with four routes:

| Route | Component | Auth | Purpose |
|-------|-----------|------|---------|
| `/login` | `LoginPage` | Public only | Email/password login form |
| `/register` | `RegisterPage` | Public only | Account creation form |
| `/` | `HomePage` | Protected | Document list with create button |
| `/document/:id` | `DocumentPage` | Protected | Collaborative editor |

### Data Fetching

All API calls go through a centralized `services/api.ts` module that provides typed functions for each endpoint (`authApi`, `documentsApi`, `commentsApi`, `versionsApi`). Each function wraps `fetch()` with the auth token header and returns a typed response object with `{ success, data, error }`. The Zustand stores call these functions in their async actions, updating store state on success and setting error messages on failure.

### Real-Time Collaboration and WebSocket Integration

The WebSocket service (`services/websocket.ts`) is a singleton class (`WebSocketService`) that manages the entire real-time lifecycle:

1. **Connection**: Connects to `ws://host/ws?token=<sessionToken>` when the user opens a document. The token is passed as a query parameter for authentication during the upgrade handshake.

2. **Document subscription**: `DocumentPage` calls `wsService.subscribe(docId)` on mount and `wsService.unsubscribe()` on unmount. The server responds with a `SYNC` message containing the current presence list.

3. **Operation sending**: When the TipTap editor detects a document change (`onUpdate`), the client would calculate OT operations from ProseMirror transaction steps and send them via `wsService.sendOperation(operations, version)`. Operations are queued in `pendingOperations` until the server sends an `ACK` with the confirmed version number.

4. **Cursor sync**: On `onSelectionUpdate`, the editor sends cursor position (`sendCursor`) or selection range (`sendSelection`) to other collaborators. These arrive as `CURSOR` messages and are stored in the document store's `presence` array.

5. **Reconnection**: On WebSocket close, the service automatically reconnects with exponential backoff (base 1s, up to 5 attempts). On reconnect, it re-subscribes to the current document.

6. **Message handling**: `DocumentPage` registers a message handler via `wsService.addMessageHandler()` that processes `SYNC`, `PRESENCE`, `CURSOR`, and `ERROR` messages, updating the document store accordingly.

### Rich Text Editing

The editor uses TipTap (a wrapper around ProseMirror) with the following extensions:

| Extension | Purpose |
|-----------|---------|
| `StarterKit` | Bold, italic, strike, headings (1-6), bullet/ordered lists, blockquotes, code blocks, horizontal rules, undo/redo (depth=100) |
| `Underline` | Underline formatting |
| `Highlight` | Multi-color text highlighting |
| `TextStyle` + `Color` | Text color changes |
| `Placeholder` | "Start typing..." placeholder in empty documents |

The `EditorToolbar` component provides formatting buttons that call TipTap commands (e.g., `editor.chain().focus().toggleBold().run()`). The toolbar renders above the editor and shows active formatting states.

Document content is stored as ProseMirror JSON in the database. When the document loads, `editor.commands.setContent(document.content)` hydrates the editor. Content changes are detected via the `onUpdate` callback, which checks `transaction.docChanged`.

### Key UI Patterns

- **Permission-based read-only mode**: The `Editor` component accepts a `readOnly` prop derived from `currentDocument.permission_level === 'view'`. When read-only, the toolbar is hidden and a "View only" banner appears at the bottom.
- **Presence indicators**: Active collaborators appear as colored dots with names in the top-right corner of the editor. Each user has a unique `avatar_color` stored in the database.
- **Side panels**: Comments and version history render as slide-in panels to the right of the editor, toggled by header buttons. Both panels fetch their data independently via the document store.
- **Google Docs-style document page**: The editor is rendered inside a fixed-width container (816px, matching US Letter width) with a white background and shadow, centered on a gray background, mimicking the appearance of a printed page.
- **Loading states**: Spinner components appear during async operations (auth check, document load). Error states show a message with a "Go back to home" link.

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, written for readers encountering these patterns for the first time.

### RBAC (Role-Based Access Control)

**What it is**: RBAC is a method of restricting system access based on the roles assigned to individual users, rather than granting permissions directly to each user. Instead of saying "Alice can edit document X," you say "Alice has the Editor role on document X, and Editors can edit."

**Why it matters**: Without RBAC, permission checks become a tangled web of per-user, per-resource rules that are impossible to audit or modify at scale. When a team lead leaves and a new person takes over, you change one role assignment instead of updating hundreds of individual permissions.

**How it works in this project**: The system defines five roles -- Owner, Editor, Commenter, Viewer, and Admin -- each with a specific set of capabilities. The `document_permissions` table maps a user to a document with a permission level (`view`, `comment`, `edit`). Ownership is tracked via `documents.owner_id`. The RBAC middleware (`backend/src/shared/rbac.ts`) intercepts every REST request and WebSocket operation, looks up the user's role for the target document, and rejects the request if the role lacks the required capability. For example, a Viewer can call `GET /api/docs/:id` but receives a 403 if they attempt `PUT /api/docs/:id`. WebSocket connections store the permission level in connection state, so operation messages are validated without a database query on every keystroke.

**The enforcement layers**: Permissions are checked at three points: (1) REST middleware before route handlers, (2) WebSocket operation handlers before processing, and (3) database queries that include permission joins as a safety net.

### Redis Cache-Aside

**What it is**: Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache first for requested data. On a cache miss, the application reads from the database, stores the result in the cache, and returns it. On a cache hit, the database is skipped entirely.

**Why it matters**: Database queries are expensive -- they require network round-trips, disk I/O, and query planning. For data that is read far more often than written (like user profiles, document metadata, and permissions), caching eliminates most database load. In a collaborative editor, the same document metadata might be requested hundreds of times per minute by different collaborators.

**How it works in this project**: When a request needs document content, the server first checks Redis for a cached copy under the key pattern (e.g., `doc:{id}:content`). If found, it returns the cached data immediately (~1ms). If not found, it queries PostgreSQL (~5-20ms), stores the result in Redis with a TTL (5 minutes for content, 1 hour for user profiles, 10 minutes for permissions), and returns the data. When a document is edited, the cache entry is explicitly deleted (invalidated) so the next read fetches fresh data from the database.

**Cache invalidation**: This is the hard part. The project uses explicit invalidation: when a write operation occurs, the corresponding cache key is deleted. Session data uses a different strategy -- write-through -- where both Redis and PostgreSQL are updated simultaneously, because session validity is critical and cannot tolerate staleness.

### Circuit Breaker

**What it is**: A circuit breaker is a stability pattern borrowed from electrical engineering. It wraps calls to external dependencies (databases, caches, APIs) and monitors their failure rate. When failures exceed a threshold, the circuit "opens" and subsequent calls fail immediately without attempting the operation, preventing cascading failures. After a timeout, the circuit enters "half-open" state and allows a test request through. If it succeeds, the circuit closes and normal operation resumes.

**Why it matters**: Without a circuit breaker, when PostgreSQL becomes slow or unresponsive, every API request blocks waiting for a database timeout (typically 10-30 seconds). This exhausts the server's connection pool and thread/event loop capacity, causing the entire application to become unresponsive -- even for operations that do not need the database. The circuit breaker detects the failure pattern and fails fast, allowing the server to serve degraded responses (e.g., cached data from Redis) rather than hanging.

**How it works in this project**: The implementation uses the Opossum library (`backend/src/shared/circuitBreaker.ts`). Two circuit breakers are configured: one for PostgreSQL (opens after 5 consecutive failures, tries again after 30 seconds) and one for Redis (opens after 10 failures, tries again after 10 seconds). When the PostgreSQL circuit opens, the server serves documents from Redis cache and queues writes for later. When the Redis circuit opens, session validation falls back to PostgreSQL. Circuit breaker state transitions are logged and tracked via a Prometheus gauge metric (`circuit_breaker_state`), enabling alerts when a dependency is unhealthy.

### Structured Logging

**What it is**: Structured logging means emitting log entries as machine-parseable data (typically JSON) rather than free-form text strings. Instead of `"User alice loaded document 123 in 45ms"`, a structured log entry is `{"level":"info","userId":"alice","action":"document_load","documentId":"123","duration_ms":45,"timestamp":"2024-01-15T10:30:00Z"}`.

**Why it matters**: Free-form text logs are easy to read in a terminal but impossible to query at scale. When you have 10 servers producing thousands of log lines per second, finding all requests from a specific user that took longer than 200ms requires parsing every log line with regex. Structured logs can be ingested into log aggregation systems (Elasticsearch, Datadog, CloudWatch Logs) and queried like a database: `SELECT * WHERE userId = 'alice' AND duration_ms > 200`.

**How it works in this project**: The project uses Pino (`backend/src/shared/logger.ts`), a high-performance JSON logger for Node.js. Every log entry includes a base context: service name, environment, and timestamp. Request-scoped context is added via child loggers that attach `requestId`, `userId`, `method`, and `path` to every log entry within that request. Trace IDs are propagated through HTTP headers, WebSocket messages, and Redis pub/sub messages, enabling end-to-end tracing of a single operation across all components. Log levels follow standard severity: `info` for normal operations, `warn` for degraded states (cache misses, circuit breaker transitions), `error` for failures, and `fatal` for unrecoverable errors that trigger shutdown.

### Prometheus Metrics

**What it is**: Prometheus is a time-series monitoring system where applications expose numeric metrics at an HTTP endpoint (`/metrics`), and a Prometheus server periodically scrapes (fetches) these metrics. Each metric has a name, a type, and optional labels. The three core metric types are: **Counter** (monotonically increasing value, like total requests), **Histogram** (distribution of values, like request latency buckets), and **Gauge** (point-in-time value that can go up or down, like active connections).

**Why it matters**: Without metrics, you cannot answer basic operational questions: "What is the p95 API latency?" "How many cache misses are we seeing?" "Is the WebSocket connection count growing?" Metrics enable dashboards (Grafana), alerting (PagerDuty), and capacity planning. They are the foundation of SLI/SLO-based reliability management.

**How it works in this project**: The implementation uses prom-client (`backend/src/shared/metrics.ts`). Key metrics include: `http_request_duration_seconds` (histogram, tracks API latency by method/path), `websocket_connections_active` (gauge, tracks concurrent connections per server), `ot_operations_total` (counter, tracks insert/delete operations), `ot_operation_latency_ms` (histogram, tracks time from operation receipt to broadcast), `cache_requests_total` (counter with `hit`/`miss` labels, tracks cache effectiveness), and `circuit_breaker_state` (gauge, 0=closed/1=open/2=half-open). These metrics are scraped by Prometheus and visualized in Grafana dashboards, with alerts configured for SLI violations (e.g., p95 latency > 500ms for 5 minutes).

### Rate Limiting

**What it is**: Rate limiting restricts how many requests a client can make within a time window. It protects the server from abuse (intentional or accidental), ensures fair resource sharing among users, and prevents a single misbehaving client from degrading service for everyone.

**Why it matters**: Without rate limiting, a single user running a script that polls the API every 10ms could generate 6,000 requests per minute -- enough to saturate a database connection pool and slow down the entire application. In a collaborative editor, a buggy client extension could flood the WebSocket with operations, overwhelming the OT engine.

**How it works in this project**: Rate limits are enforced per-user (identified by session) and per-IP (for unauthenticated endpoints). The limits vary by endpoint sensitivity: login attempts are limited to 5 per 15 minutes to prevent brute-force attacks, registration is limited to 3 accounts per hour per IP to prevent spam, WebSocket operations are limited to 100 per second per user per document (far above human typing speed but catches runaway scripts), and general API requests are limited to 100 per minute per user. Limits are tracked in Redis using a sliding window counter pattern: each request increments a counter key with a TTL matching the window duration.

### Idempotency

**What it is**: An operation is idempotent if performing it multiple times has the same effect as performing it once. In the context of an API, idempotency means that retrying a failed request (because the client did not receive a response) will not create duplicate side effects -- no double-creating a document, no double-applying an edit.

**Why it matters**: Network failures are common. A client sends a POST request to create a document, the server processes it successfully, but the response is lost due to a network hiccup. The client retries. Without idempotency, the server creates a second document. In a collaborative editor, this problem is amplified: if a user types "hello" and the ACK is lost, retrying without idempotency inserts "hellohello."

**How it works in this project**: The project implements idempotency at two levels. For HTTP requests (`backend/src/middleware/idempotency.ts`), clients include an `Idempotency-Key` header on POST/PUT/PATCH/DELETE requests. The server checks Redis for a cached response under that key. If found, it returns the cached response without re-processing. If not found, it processes the request, caches the response with a 1-hour TTL, and returns it. For WebSocket operations (`backend/src/services/collaboration/sync.ts`), each operation includes a unique `operationId`. The server checks Redis (`SET NX` with 1-hour TTL, key pattern `op:{userId}:{documentId}:{operationId}`) before applying the operation. If the key already exists, the operation is a duplicate and the server returns the cached ACK.

### Health Checks

**What it is**: Health checks are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are used by load balancers to route traffic away from unhealthy instances and by orchestration systems (Kubernetes) to restart failed containers.

**Why it matters**: Without health checks, a load balancer continues sending traffic to a server whose database connection pool is exhausted, causing errors for users. With health checks, the load balancer detects the unhealthy instance within seconds and stops routing traffic to it, while the remaining instances absorb the load.

**How it works in this project**: The `/health` endpoint (`backend/src/index.ts`) performs a lightweight check on each dependency: `SELECT 1` for PostgreSQL and `PING` for Redis. Each check has a timeout (e.g., 5 seconds) and reports per-dependency status and latency. The response includes an overall status (`healthy` or `degraded`), the uptime of the process, and the state of each circuit breaker. The load balancer polls this endpoint every 10 seconds and removes instances that return non-200 responses. A degraded response (one dependency down but others working) may keep the instance in rotation for read-only traffic while alerting operators.

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

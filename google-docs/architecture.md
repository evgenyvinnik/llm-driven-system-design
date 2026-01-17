# Google Docs - Collaborative Editing - Architecture Design

## System Overview

A real-time collaborative document editing platform enabling multiple users to simultaneously edit rich-text documents with conflict resolution, presence awareness, comments, and version history.

## Requirements

### Functional Requirements

- **Document editing**: Rich text formatting (bold, italic, headings, lists, links)
- **Real-time collaboration**: Multiple users editing simultaneously with live cursor positions
- **Version history**: Automatic snapshots with named versions and restore capability
- **Commenting**: Threaded comments with text anchoring and resolution workflow
- **Suggestions**: Track changes mode with accept/reject workflow
- **Sharing**: Granular permissions (view, comment, edit) per user or email

### Non-Functional Requirements

- **Scalability**: 2-5 server instances for local development; architecture supports horizontal scaling
- **Availability**: 99.5% uptime target (allows ~3.6 hours downtime/month for maintenance)
- **Latency**:
  - Document load: p95 < 500ms
  - Operation sync: p95 < 100ms (keystroke to other users' screens)
  - API responses: p95 < 200ms
- **Consistency**: Strong consistency for document state via Operational Transformation; eventual consistency acceptable for presence and read replicas

---

## Capacity Estimation

### Local Development Scale

For a learning project running locally with 2-5 server instances:

| Metric | Target | Rationale |
|--------|--------|-----------|
| Concurrent users | 10-50 | Testing collaboration scenarios |
| Active documents | 5-20 | Documents being edited simultaneously |
| Peak RPS (API) | 50-100 | Document CRUD, comments, auth |
| Peak WebSocket messages/sec | 200-500 | Operations, presence, cursor updates |
| Average document size | 50KB | ~10 pages of formatted text |
| Operations per document/sec | 5-20 | Typing speed varies by user |

### Storage Growth Estimates

| Data Type | Size/Unit | Growth Rate | 1 Year Projection |
|-----------|-----------|-------------|-------------------|
| Documents (content) | 50KB avg | 100 docs/month | 60MB |
| Document versions | 50KB each | 10 versions/doc | 600MB |
| Operations log | 200 bytes/op | 1M ops/month | 2.4GB |
| Comments | 500 bytes avg | 500/month | 3MB |
| Users | 1KB each | 50/month | 600KB |

**Total first year**: ~3GB (well within single PostgreSQL instance)

### Component Sizing for Local Dev

| Component | Sizing | Memory | Connections |
|-----------|--------|--------|-------------|
| PostgreSQL | 1 instance | 512MB-1GB | Pool: 20/instance x 5 = 100 max |
| Redis/Valkey | 1 instance | 256MB | Pub/Sub: 10 channels, Sessions: 100 |
| API Server | 2-5 instances | 256MB each | HTTP + WebSocket combined |

---

## High-Level Architecture

```
                                    +------------------+
                                    |   Web Browser    |
                                    |   (TipTap/PM)    |
                                    +--------+---------+
                                             |
                              HTTP REST + WebSocket (wss)
                                             |
                    +------------------------v------------------------+
                    |              Load Balancer (nginx)              |
                    |         Sticky sessions by document_id          |
                    +----+--------+--------+--------+--------+--------+
                         |        |        |        |        |
                    +----v---+ +--v----+ +-v-----+ +-v-----+ +-v-----+
                    | API-1  | | API-2 | | API-3 | | API-4 | | API-5 |
                    | :3001  | | :3002 | | :3003 | | :3004 | | :3005 |
                    +---+----+ +---+---+ +---+---+ +---+---+ +---+---+
                        |          |         |         |         |
                        +----------+---------+---------+---------+
                                   |                   |
                    +--------------v---+   +-----------v-----------+
                    |      Redis       |   |      PostgreSQL       |
                    |  (sessions,      |   |  (documents, users,   |
                    |   pub/sub,       |   |   versions, ops,      |
                    |   presence)      |   |   comments)           |
                    +------------------+   +-----------------------+
```

### Core Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **Web Client** | Rich text editor, local OT, presence UI | React 19, TipTap/ProseMirror, WebSocket |
| **Load Balancer** | Request routing, sticky sessions, SSL termination | nginx with ip_hash or consistent hashing |
| **API Server** | REST API + WebSocket server, OT processing | Node.js, Express, ws library |
| **Session Store** | User sessions, WebSocket connection tracking | Redis with 24h TTL |
| **Pub/Sub Bus** | Cross-server operation broadcast, presence sync | Redis pub/sub |
| **Primary Database** | Documents, users, permissions, versions, ops | PostgreSQL 16 |

---

## Request Flow

### 1. Document Load Flow

```
Browser                    API Server                 Redis              PostgreSQL
   |                           |                        |                     |
   |-- GET /api/docs/:id ----->|                        |                     |
   |                           |-- Check session ------>|                     |
   |                           |<-- Session valid ------|                     |
   |                           |                        |                     |
   |                           |-- Query document, permissions, comments ---->|
   |                           |<-- Document data, user's permission ---------|
   |                           |                        |                     |
   |<-- 200 {doc, permission} -|                        |                     |
   |                           |                        |                     |
   |== WebSocket upgrade =====>|                        |                     |
   |                           |-- SUBSCRIBE doc:{id} ->|                     |
   |                           |-- SADD presence:{id} ->|                     |
   |<== WS: presence update ===|                        |                     |
```

### 2. Operation Sync Flow (Real-time Editing)

```
Browser A       API Server 1        Redis Pub/Sub      API Server 2       Browser B
    |                |                    |                  |                |
    |== WS: op A ===>|                    |                  |                |
    |                |-- Transform op ----|                  |                |
    |                |-- ACK + version -->|                  |                |
    |                |                    |                  |                |
    |                |-- PUBLISH op ----->|                  |                |
    |                |                    |-- op broadcast ->|                |
    |                |                    |                  |== WS: op A ===>|
    |                |                    |                  |                |
    |                |-- INSERT ops ------|------------------|--------------->|
    |                |                    |                  |          PostgreSQL
```

### 3. Version Snapshot Flow

```
API Server                    PostgreSQL
     |                            |
     |-- Every 50 ops OR 5 min -->|
     |                            |
     |-- BEGIN TRANSACTION ------>|
     |-- INSERT document_versions |
     |-- UPDATE documents.version |
     |-- COMMIT ----------------->|
```

---

## Data Model

### Database Schema (PostgreSQL)

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
-- Query patterns: "my documents", "shared with me", sorted by recent
CREATE INDEX idx_documents_owner ON documents(owner_id) WHERE NOT is_deleted;
CREATE INDEX idx_documents_updated ON documents(updated_at DESC);
CREATE INDEX idx_document_permissions_user ON document_permissions(user_id);

-- OT replay: fetch ops >= version for a document
CREATE INDEX idx_operations_doc ON operations(document_id, version_number);

-- Version history: list versions for a document, newest first
CREATE INDEX idx_document_versions_doc ON document_versions(document_id, version_number DESC);

-- Comments/suggestions per document
CREATE INDEX idx_comments_doc ON comments(document_id);
CREATE INDEX idx_suggestions_doc ON suggestions(document_id);

-- Session lookup by token
CREATE INDEX idx_sessions_token ON sessions(token);
```

### CouchDB Schema (Document Content & Offline Sync)

While PostgreSQL handles users, permissions, and comments, CouchDB is used for document content storage with built-in offline sync capability. This hybrid approach leverages CouchDB's strengths for collaborative document editing.

**Why CouchDB for Document Content?**
- **Built-in sync protocol**: CouchDB replication enables offline-first applications
- **MVCC (Multi-Version Concurrency Control)**: Automatic conflict detection and resolution
- **Change feeds**: Real-time updates via `_changes` API (alternative to WebSocket)
- **Document-native storage**: JSON documents stored natively without ORM overhead
- **PouchDB integration**: Browser-based CouchDB for true offline-first experience

**Document Structure:**
```json
{
  "_id": "doc-uuid",
  "_rev": "3-abc123",              // CouchDB revision (MVCC)
  "type": "document",
  "title": "My Document",
  "owner_id": "user-uuid",
  "content": {                      // ProseMirror document JSON
    "type": "doc",
    "content": [
      {"type": "paragraph", "content": [{"type": "text", "text": "Hello"}]}
    ]
  },
  "current_version": 42,
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T14:20:00Z"
}
```

**Version History Structure:**
```json
{
  "_id": "version-doc-uuid-42",
  "type": "version",
  "document_id": "doc-uuid",
  "version_number": 42,
  "content": { /* full snapshot */ },
  "created_by": "user-uuid",
  "is_named": true,
  "name": "Before major edit",
  "created_at": "2024-01-15T14:20:00Z"
}
```

**Design Documents (Views):**
```javascript
// GET /documents/_design/docs/_view/by_owner?key="user-uuid"
{
  "views": {
    "by_owner": {
      "map": "function(doc) { if(doc.type === 'document') emit(doc.owner_id, doc._id); }"
    },
    "recent": {
      "map": "function(doc) { if(doc.type === 'document') emit(doc.updated_at, null); }"
    }
  }
}
```

**Offline Sync Flow:**
```
1. User loads document online:
   → Browser PouchDB syncs from CouchDB
   → Local replica stored in IndexedDB

2. User edits offline:
   → Changes saved to local PouchDB
   → OT operations queued locally

3. User reconnects:
   → PouchDB automatically syncs to CouchDB
   → Conflicts detected via _rev comparison
   → Conflict resolution merges changes

4. Real-time updates:
   → CouchDB _changes feed notifies connected clients
   → Or WebSocket for lower latency (current implementation)
```

**Conflict Resolution:**
```javascript
// When _rev conflicts occur, CouchDB keeps all versions
// Application logic merges using OT or picks winner
async function resolveConflict(docId) {
  const doc = await couch.get(docId, { conflicts: true });
  if (doc._conflicts) {
    // Fetch all conflicting revisions
    const revisions = await Promise.all(
      doc._conflicts.map(rev => couch.get(docId, { rev }))
    );
    // Merge content using OT transform
    const merged = mergeDocuments(doc, revisions);
    // Save merged version, delete conflicts
    await couch.put({ ...merged, _rev: doc._rev });
  }
}
```

**Databases:**
| Database | Purpose | Indexes |
|----------|---------|---------|
| `documents` | Current document content | by_owner, recent, by_shared |
| `document_versions` | Version history snapshots | by_document_version |

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

### PostgreSQL (Primary Store)

- **Documents table**: Current document state, updated on every snapshot (not every op)
- **Operations table**: Append-only log, enables OT replay and debugging
- **Snapshots**: Created every 50 operations OR every 5 minutes, whichever comes first

### Redis (Hot Data)

- **Session cache**: Primary session store, PostgreSQL as fallback
- **OT version counter**: Atomic INCR for version numbers
- **Recent ops buffer**: Last 100 ops per document for late-joining clients
- **Presence**: Set of active users per document, auto-expires on disconnect

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

---

## Caching Strategy

### Cache-Aside Pattern for Documents

```
GET document:
1. Check Redis: doc:{id}:content
2. Cache miss? Query PostgreSQL, cache result with 5min TTL
3. Return document

EDIT document:
1. Process operation (OT)
2. Invalidate cache: DEL doc:{id}:content
3. Broadcast update via pub/sub
```

### TTL Configuration

| Data | TTL | Invalidation |
|------|-----|--------------|
| Document content cache | 5 minutes | On any edit operation |
| User profile cache | 1 hour | On profile update |
| Permission cache | 10 minutes | On share/unshare |
| Session | 24 hours | On logout or expiry |

### Cache Warming

On server startup:
1. Load last 10 accessed documents into Redis cache
2. Pre-subscribe to active document channels

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

```typescript
// Client -> Server
{ type: 'join', docId: string, version: number }
{ type: 'leave', docId: string }
{ type: 'operation', docId: string, version: number, op: Operation }
{ type: 'cursor', docId: string, position: CursorPosition }
{ type: 'ping' }

// Server -> Client
{ type: 'joined', docId: string, version: number, ops: Operation[], users: User[] }
{ type: 'operation', docId: string, version: number, op: Operation, userId: string }
{ type: 'ack', docId: string, version: number }
{ type: 'cursor', docId: string, userId: string, position: CursorPosition }
{ type: 'presence', docId: string, users: User[] }
{ type: 'error', code: string, message: string }
{ type: 'pong' }
```

---

## Key Design Decisions

### Operational Transformation (OT) vs CRDT

**Decision**: Use OT for collaborative editing

**Rationale**:
- Lower memory overhead (no per-character metadata like CRDTs require)
- Simpler mental model for learning
- Google Docs uses OT, so it's battle-tested
- Better control over conflict resolution ordering

**Trade-offs**:
- OT requires central authority (the server) for ordering
- CRDTs would enable peer-to-peer and offline-first better
- OT transformation functions are complex for rich text

### Sticky Sessions by Document

**Decision**: Route all WebSocket connections for a document to the same server

**Implementation**: nginx hash on document_id in WebSocket upgrade path

**Rationale**:
- Single server holds authoritative OT state for a document
- Eliminates distributed coordination for operation ordering
- Redis pub/sub handles cross-server updates when needed

**Trade-offs**:
- Hot documents concentrate load on one server
- Server failure requires client reconnection to different server

### Session-based Auth (not JWT)

**Decision**: Cookie-based sessions stored in Redis

**Rationale**:
- Simpler than JWT rotation and refresh logic
- Immediate revocation (delete from Redis)
- Works well with WebSocket upgrade (cookies sent automatically)
- Appropriate complexity for learning project

---

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19, TypeScript, TipTap/ProseMirror | Modern React, excellent rich text support |
| **Routing** | TanStack Router | Type-safe routing, file-based organization |
| **State** | Zustand | Lightweight, no boilerplate |
| **Styling** | Tailwind CSS | Utility-first, fast prototyping |
| **Backend** | Node.js 20, Express, TypeScript | Async I/O for WebSockets, shared types |
| **WebSocket** | ws library | Low-level control, no Socket.io overhead |
| **Database** | PostgreSQL 16 | JSONB for documents, strong consistency |
| **Cache/Pub-Sub** | Redis 7 / Valkey | Sessions, pub/sub, hot data cache |
| **Load Balancer** | nginx | Sticky sessions, WebSocket proxy |

---

## Security Considerations

### Authentication

- **Password hashing**: bcrypt with cost factor 10 (adjustable)
- **Session tokens**: Cryptographically random 32-byte tokens (crypto.randomBytes)
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

**Enforcement points**:
- Middleware checks permission before REST API handlers
- WebSocket operations validated against permission level
- Document queries include permission joins

### Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /api/auth/login | 5 attempts | 15 minutes |
| POST /api/auth/register | 3 accounts | 1 hour (per IP) |
| WebSocket operations | 100 ops | 1 second (per user per doc) |
| API requests | 100 requests | 1 minute (per user) |

**Implementation**: Redis sliding window counter per user/IP

### Input Validation

- Document titles: Max 500 chars, sanitize HTML
- Document content: Validate ProseMirror JSON schema
- Comments: Max 10,000 chars, no HTML
- Operations: Validate against expected OT operation schema
- UUIDs: Validate format before database queries

---

## Observability

### Metrics (Prometheus format)

```
# Counter: Total HTTP requests by endpoint and status
http_requests_total{method="GET",path="/api/docs",status="200"} 1234

# Histogram: Request latency
http_request_duration_seconds{method="GET",path="/api/docs",quantile="0.95"} 0.15

# Gauge: Active WebSocket connections
websocket_connections_active{server="api-1"} 45

# Counter: OT operations processed
ot_operations_total{type="insert"} 5678
ot_operations_total{type="delete"} 2345

# Histogram: OT operation latency (time to broadcast)
ot_operation_latency_ms{quantile="0.95"} 45

# Gauge: Documents with active editors
documents_active_total 12

# Counter: Cache hits/misses
cache_requests_total{cache="document",result="hit"} 890
cache_requests_total{cache="document",result="miss"} 110
```

### Key SLIs and Alerts

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| API availability | 99.5% | < 99% over 5 min |
| API p95 latency | < 200ms | > 500ms over 5 min |
| WebSocket message latency | < 100ms | > 250ms over 5 min |
| OT conflict rate | < 5% | > 10% over 5 min |
| PostgreSQL query time | < 50ms p95 | > 200ms |
| Redis latency | < 5ms p95 | > 20ms |
| Error rate (5xx) | < 1% | > 5% |

### Logging

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "service": "api-1",
  "trace_id": "abc123",
  "user_id": "user-uuid",
  "doc_id": "doc-uuid",
  "action": "operation",
  "operation_type": "insert",
  "version": 42,
  "latency_ms": 12
}
```

### Distributed Tracing

Trace context propagated through:
- HTTP headers: `X-Trace-Id`, `X-Span-Id`
- WebSocket messages: embedded in payload
- Redis pub/sub: included in message envelope

**Trace spans**:
1. Client keystroke
2. WebSocket receive
3. OT transform
4. Redis publish
5. PostgreSQL insert
6. Broadcast to clients

---

## Failure Handling

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| PostgreSQL query | 3 | Exponential (100ms, 200ms, 400ms) | Read-only safe |
| PostgreSQL write | 3 | Exponential | Idempotency key in request |
| Redis operation | 3 | Exponential (50ms base) | Safe (atomic ops) |
| OT broadcast | 2 | Fixed 100ms | Message ID dedup |

### Circuit Breaker

**PostgreSQL circuit breaker**:
- Open after 5 consecutive failures
- Half-open after 30 seconds
- Close after 3 successful requests in half-open

**Redis circuit breaker**:
- Open after 10 consecutive failures
- Half-open after 10 seconds
- Fallback: serve from PostgreSQL, queue writes

### Graceful Degradation

| Failure | Degradation | User Impact |
|---------|-------------|-------------|
| Redis down | Sessions from PostgreSQL, no presence | Slower auth, no cursors |
| PostgreSQL readonly | Disable saves, show banner | View-only mode |
| Single API server down | LB routes to others | Brief reconnection |
| WebSocket disconnect | Auto-reconnect with backoff | 1-5s interruption |

### Data Recovery

**Backup strategy**:
- PostgreSQL: Daily pg_dump to local storage
- Redis: RDB snapshots every 5 minutes
- Operation log: Enables replay to any point

**Recovery procedures**:
1. **Lost operations**: Replay from operations table to rebuild document
2. **Corrupted document**: Restore from last valid version snapshot
3. **Server crash**: Clients reconnect, fetch ops since their version

---

## Cost Trade-offs (Local Development Context)

### Resource Usage Comparison

| Choice | Lower Resource | Higher Resource | Decision |
|--------|----------------|-----------------|----------|
| OT vs CRDT | OT (no metadata) | CRDT | OT for memory efficiency |
| Full doc vs ops | Full doc (simpler) | Ops (smaller transfers) | Ops for real-time |
| Redis vs memory | Redis (shared) | In-memory (faster) | Redis for multi-instance |
| Snapshots | Fewer (less storage) | More (faster recovery) | Balance: every 50 ops |

### Scaling Cost Estimates

| Component | 1 instance | 5 instances | Bottleneck |
|-----------|------------|-------------|------------|
| PostgreSQL | 512MB RAM | 512MB shared | Connection pool (100 max) |
| Redis | 256MB RAM | 256MB shared | Pub/sub channels |
| API Server | 256MB each | 1.2GB total | WebSocket connections |
| Total | ~1GB | ~2GB | Comfortable for M1 Mac |

### When to Scale Components

| Symptom | Action |
|---------|--------|
| PostgreSQL connection pool exhausted | Add read replica or increase pool |
| Redis memory > 256MB | Enable eviction policy or add instance |
| Single document > 100 concurrent editors | Shard document by sections |
| Operation lag > 200ms | Add API instances, check network |

---

## Scalability Considerations

### Horizontal Scaling

1. **API Servers**: Add instances behind load balancer
   - Sticky sessions by document_id ensure OT consistency
   - Redis pub/sub synchronizes across instances

2. **Read Replicas**: PostgreSQL streaming replication
   - Route read queries (document list, version history) to replicas
   - Writes always to primary

3. **Redis Cluster**: For beyond local dev scale
   - Partition presence data by document_id hash
   - Dedicated pub/sub nodes

### Vertical Limits

| Component | Limit | Mitigation |
|-----------|-------|------------|
| Document size | 10MB content JSONB | Split into chapters |
| Concurrent editors | ~50 per document | Shard by section |
| Operations/second | 1000 per document | Batch operations |
| WebSocket connections | ~10K per server | Add servers |

---

## Future Optimizations

1. **Offline editing**: Queue operations locally, sync on reconnect
2. **Operation batching**: Combine rapid keystrokes into single op
3. **Delta compression**: Send content diffs instead of full JSONB
4. **CDN for static assets**: Separate API from frontend delivery
5. **Full-text search**: Elasticsearch for document content search
6. **Export formats**: PDF, DOCX generation via worker queue
7. **Collaborative cursors**: Optimized presence with sampling (every 100ms)
8. **Conflict-free suggestions**: CRDTs for suggestion text only

---

## Trade-offs and Alternatives

| Decision | Alternative | Why Not |
|----------|-------------|---------|
| PostgreSQL JSONB | MongoDB/CouchDB | PostgreSQL handles JSONB well, fewer moving parts |
| Redis pub/sub | RabbitMQ | Simpler for ephemeral messages, no persistence needed |
| TipTap/ProseMirror | Slate.js, Quill | Better collaborative editing support, active development |
| Sticky sessions | Distributed OT | Complexity not justified for learning project |
| Session cookies | JWT | Simpler revocation, no refresh token dance |
| WebSocket | SSE | Bidirectional needed for operations and acks |

---

## Implementation Notes

This section documents the rationale for key implementation decisions in the backend codebase. Each pattern addresses specific challenges in building a reliable, observable, and secure collaborative editing system.

### Idempotency for Document Operations

**Implementation Location**: `src/shared/idempotency.ts`, `src/middleware/idempotency.ts`, `src/services/collaboration.ts`

**WHY Idempotency Enables Reliable OT Conflict Resolution:**

1. **Network Reliability Problem**: In real-time collaboration, network connections are inherently unreliable. Clients must retry operations when they don't receive acknowledgments, but without idempotency, retries can cause data corruption:
   - User types "hello" at position 10
   - Network drops before ACK received
   - Client retries the same operation
   - Without idempotency: "hellohello" appears at position 10

2. **OT Version Vector Integrity**: Operational Transformation relies on version vectors to order operations. Duplicate operations corrupt this ordering:
   - Client sends operation at version 5
   - Server transforms and increments to version 6
   - Duplicate arrives, server increments to version 7
   - Document state becomes inconsistent across clients

3. **Implementation Strategy**:
   - Clients include a unique `operationId` in each WebSocket message
   - Server checks Redis for existing result before processing
   - If found, returns cached ACK without re-applying operation
   - Key format: `op:{userId}:{documentId}:{operationId}`
   - TTL: 1 hour (long enough for retries, short enough to not waste memory)

4. **HTTP Request Idempotency**:
   - Clients can include `Idempotency-Key` header for POST/PUT/PATCH/DELETE
   - Server caches response and returns it for duplicate requests
   - Enables safe retries for document creation, sharing, etc.

### Role-Based Access Control (RBAC) for Documents

**Implementation Location**: `src/shared/rbac.ts`, integrated into route handlers

**WHY RBAC Enables Document Sharing Permissions:**

1. **Collaboration Requires Granular Access**: Unlike single-user applications, collaborative editing requires nuanced permission levels:
   - **Owner**: Full control (edit, share, delete, transfer ownership)
   - **Editor**: Edit content, add comments, view history
   - **Commenter**: Add comments and suggestions, view content
   - **Viewer**: Read-only access to content and comments

2. **Security at Multiple Layers**:
   - **REST API**: RBAC middleware (`requireEdit`, `requireShare`, `requireDelete`) validates permissions before handlers execute
   - **WebSocket**: Permission checked on subscription, stored in client connection state
   - **Database Queries**: Include permission joins to enforce access at data layer

3. **Capability-Based Design**:
   ```typescript
   const PERMISSION_CAPABILITIES = {
     owner: { canView: true, canComment: true, canEdit: true, canShare: true, canDelete: true },
     edit: { canView: true, canComment: true, canEdit: true, canShare: false, canDelete: false },
     comment: { canView: true, canComment: true, canEdit: false, canShare: false, canDelete: false },
     view: { canView: true, canComment: false, canEdit: false, canShare: false, canDelete: false },
   };
   ```
   - Decouples permission levels from capability checks
   - Easy to add new capabilities without modifying permission levels
   - Centralized permission logic reduces security bugs

4. **Pending Share Invitations**: Email-based permissions allow sharing with users who haven't signed up yet, enabling external collaboration workflows.

### Circuit Breakers for OT Sync Operations

**Implementation Location**: `src/shared/circuitBreaker.ts`, `src/services/collaboration.ts`

**WHY Circuit Breakers Protect Real-Time Collaboration:**

1. **Cascading Failure Prevention**: In collaborative editing, a slow database or Redis can create cascading failures:
   - Database query takes 10 seconds instead of 50ms
   - All WebSocket handlers block waiting for database
   - Connection backlog grows, clients disconnect
   - Reconnection storms overwhelm the server

2. **Fail-Fast for Real-Time UX**: Users expect sub-100ms latency for keystrokes. Circuit breakers provide predictable failure:
   - Instead of 10-second timeout, fail after 2 seconds
   - Client can show "temporarily unavailable" immediately
   - Server remains responsive for other documents

3. **Configuration Optimized for Collaboration**:
   ```typescript
   const OT_SYNC_OPTIONS = {
     timeout: 2000,          // 2 seconds - tight for real-time
     errorThresholdPercentage: 50,
     resetTimeout: 5000,     // Quick recovery attempt
     volumeThreshold: 3,     // Open after 3 failures in a row
   };
   ```

4. **Graceful Degradation Modes**:
   - **Database circuit open**: Operations still broadcast to connected clients, persist queued for retry
   - **Redis circuit open**: Fall back to PostgreSQL for sessions, skip cross-server broadcast
   - **Both open**: Document remains editable locally, sync resumes when services recover

5. **Observable Failure**:
   - Circuit state exposed via Prometheus gauge (`google_docs_circuit_breaker_state`)
   - Events tracked via counter (`google_docs_circuit_breaker_events_total`)
   - Enables alerting before user impact

### Sync Latency Metrics for UX Optimization

**Implementation Location**: `src/shared/metrics.ts`, `src/services/collaboration.ts`

**WHY Sync Latency Metrics Enable UX Optimization:**

1. **User Perception Thresholds**: Research shows users perceive latency differently at various thresholds:
   - < 50ms: Feels instantaneous
   - 50-100ms: Slight delay, still acceptable
   - 100-250ms: Noticeable lag, frustrating for rapid typing
   - > 250ms: Disrupts flow, causes confusion with cursor positions

2. **Metric Design**:
   ```
   # Histogram: OT operation sync latency in milliseconds
   google_docs_sync_latency_ms{operation_type="insert"} bucket_le_50ms=1234
   google_docs_sync_latency_ms{operation_type="insert"} bucket_le_100ms=1345
   ```
   - Buckets aligned with perception thresholds: 5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1000ms
   - Labeled by operation type (insert, delete, format) to identify problematic transforms
   - p95 latency used for SLI: target < 100ms

3. **Optimization Opportunities Exposed**:
   - **High insert latency**: OT transform function needs optimization
   - **High delete latency**: Large selection deletions need batching
   - **Latency spikes correlated with active users**: Need more server instances
   - **Latency increases over document size**: Need operation log compaction

4. **SLI/SLO Integration**:
   - SLI: p95 sync latency < 100ms
   - Alert threshold: > 250ms over 5 minutes
   - Dashboard shows latency distribution by operation type and document size

### Additional Implementation Details

**Structured Logging with Pino** (`src/shared/logger.ts`):
- JSON format for easy parsing by log aggregators (ELK, Loki)
- Request correlation via trace IDs
- Log levels: trace (cursor positions) -> fatal (application crash)
- Pretty printing in development, JSON in production

**Prometheus Metrics Endpoint** (`/metrics`):
- Active documents gauge: Helps size WebSocket connection pools
- Active collaborators gauge: Monitors real-time load
- HTTP request histograms: SLI for API latency
- Cache hit/miss counters: Tunes Redis TTLs
- Circuit breaker state: Indicates degraded operation

**Enhanced Health Check** (`/health`):
- Performs actual connectivity checks (PostgreSQL SELECT 1, Redis PING)
- Returns component-level status with latency
- Returns 503 when any dependency is unhealthy
- Includes collaboration stats for debugging

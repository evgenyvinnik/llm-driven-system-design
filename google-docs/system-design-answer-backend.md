# Google Docs - System Design Interview Answer (Backend Focus)

> **Role Focus**: Backend Engineer - Databases, APIs, OT Algorithm, Caching, Message Queues, Scalability

## Opening Statement

"Today I'll design Google Docs, a real-time collaborative document editing platform. As a backend engineer, I'll focus on the Operational Transformation algorithm for concurrent editing, the storage model for documents and version history, the WebSocket protocol for real-time sync, and the caching strategy that enables sub-100ms operation latency."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Document creation and editing** - Rich text with formatting (bold, italic, headings, lists)
2. **Real-time collaboration** - Multiple users editing simultaneously
3. **Cursor and selection sharing** - See where others are typing
4. **Version history** - View and restore previous versions
5. **Comments and suggestions** - Threaded comments, suggestion mode
6. **Sharing and permissions** - View, comment, edit access levels

### Non-Functional Requirements (Backend-Specific)

- **Latency**: < 100ms for operation sync to collaborators, < 500ms document load
- **Consistency**: Strong consistency for document state via OT
- **Throughput**: 5M operations/second at scale
- **Durability**: Zero data loss - operations persisted before acknowledgment
- **Availability**: 99.99% uptime

### Backend Challenges I'll Focus On

1. **OT Algorithm**: Transform concurrent operations for consistent state
2. **Storage Model**: Snapshots + operation logs for efficient versioning
3. **WebSocket Protocol**: Bidirectional real-time communication
4. **Caching Strategy**: Redis for sessions, presence, and operation buffering
5. **Horizontal Scaling**: Sticky sessions with Redis pub/sub coordination

---

## Step 2: Scale Estimation (2-3 minutes)

**Traffic patterns:**
- 100 million DAU, average 30 edits/minute when active
- Peak concurrent users: 10M
- Peak operations: 5M ops/second

**Storage calculations:**
- 1B documents * 50KB average = 50 TB base storage
- Version history (10x): 500 TB
- Operations log: 200 bytes/op * 10B ops/day = 2 TB/day

**Connection estimates:**
- 10M concurrent WebSocket connections
- ~10K connections per server = 1,000 servers
- Each document served by single server (sticky sessions)

---

## Step 3: High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Web Browser (TipTap/PM)                       │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │ HTTP REST + WebSocket
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Load Balancer (nginx)                                │
│              Sticky sessions by document_id hash                        │
└────┬─────────┬─────────┬─────────┬─────────┬────────────────────────────┘
     │         │         │         │         │
     ▼         ▼         ▼         ▼         ▼
┌─────────┐┌─────────┐┌─────────┐┌─────────┐┌─────────┐
│  API-1  ││  API-2  ││  API-3  ││  API-4  ││  API-5  │
│ OT Eng  ││ OT Eng  ││ OT Eng  ││ OT Eng  ││ OT Eng  │
└────┬────┘└────┬────┘└────┬────┘└────┬────┘└────┬────┘
     │          │         │         │         │
     └──────────┴────┬────┴─────────┴─────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌────────────────┐      ┌─────────────────────┐
│     Redis      │      │     PostgreSQL      │
│ sessions,      │      │ documents, users,   │
│ pub/sub,       │      │ versions, ops,      │
│ presence       │      │ comments            │
└────────────────┘      └─────────────────────┘
```

### Core Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **API Server** | REST + WebSocket, OT processing | Node.js, Express, ws library |
| **OT Engine** | Transform concurrent operations | Custom TypeScript implementation |
| **Session Store** | User sessions, connection tracking | Redis with 24h TTL |
| **Pub/Sub Bus** | Cross-server operation broadcast | Redis pub/sub |
| **Primary Database** | Documents, permissions, versions | PostgreSQL 16 with JSONB |

---

## Step 4: Deep Dive - Operational Transformation Engine (10 minutes)

### The Fundamental Problem

Two users typing simultaneously:

```
Initial state: "Hello"

User A: Insert "!" at position 5  ──▶  "Hello!"
User B: Insert " World" at position 5  ──▶  "Hello World"

If both apply naively:
┌────────────────────────────────────────────────────┐
│ A applies B's op: "Hello World!" ──▶ CORRECT      │
│ B applies A's op at pos 5: "Hello! World" ──▶ WRONG│
└────────────────────────────────────────────────────┘
```

The same operation produces different results depending on order.

### OT Operation Types

**InsertOp:**
- type: 'insert'
- position: number
- text: string
- clientId: string
- version: number

**DeleteOp:**
- type: 'delete'
- position: number
- length: number
- clientId: string
- version: number

### Transform Function Logic

**Transform Insert vs Insert (II):**
```
┌─────────────────────────────────────────────────────────┐
│ if op1.position < op2.position:                         │
│   shift op2 right by op1.text.length                    │
│ else if op1.position > op2.position:                    │
│   no change to op2                                      │
│ else (same position):                                   │
│   use clientId comparison for deterministic ordering    │
└─────────────────────────────────────────────────────────┘
```

**Transform Delete vs Insert (DI):**
```
┌─────────────────────────────────────────────────────────┐
│ if delete.position >= insert.position:                  │
│   shift delete right by insert.text.length              │
│ else if delete ends before insert:                      │
│   no change                                             │
│ else (delete spans insert point):                       │
│   split into two deletes around the insert              │
└─────────────────────────────────────────────────────────┘
```

**Transform Insert vs Delete (ID):**
```
┌─────────────────────────────────────────────────────────┐
│ if insert.position <= delete.position:                  │
│   no change                                             │
│ else if insert.position >= delete.end:                  │
│   shift insert left by delete.length                    │
│ else (insert inside deleted region):                    │
│   place insert at delete.position                       │
└─────────────────────────────────────────────────────────┘
```

**Transform Delete vs Delete (DD):**
```
┌─────────────────────────────────────────────────────────┐
│ if op2 entirely before op1:                             │
│   shift op1 left by op2.length                          │
│ else if op2 entirely after op1:                         │
│   no change                                             │
│ else (overlapping):                                     │
│   compute remaining range after removing overlap        │
│   if op1 completely covered: return null                │
└─────────────────────────────────────────────────────────┘
```

### Server-Side Operation Processing Flow

```
Client sends operation ──▶ Get server version
                                  │
                                  ▼
                          Get missed operations
                          (ops client hasn't seen)
                                  │
                                  ▼
                          Transform client op against
                          each missed op sequentially
                                  │
                                  ▼
                          Apply to document state
                                  │
                                  ▼
                          Increment version atomically
                          (Redis INCR)
                                  │
                                  ▼
                          Store operation for future
                          transforms
                                  │
                                  ▼
                          Broadcast via Redis pub/sub
                          to other clients
                                  │
                                  ▼
                          Return {transformed, serverVersion}
```

### Idempotency for Safe Retries

```
┌─────────────────────────────────────────────────────────────────┐
│                    Idempotency Flow                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Request arrives with operationId                              │
│           │                                                     │
│           ▼                                                     │
│   Check Redis: op:{userId}:{docId}:{operationId}                │
│           │                                                     │
│     ┌─────┴─────┐                                               │
│     │           │                                               │
│   Found       Not Found                                         │
│     │           │                                               │
│     ▼           ▼                                               │
│   Return     Process operation                                  │
│   cached     Cache result (1 hour TTL)                          │
│   result     Return result                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 5: Deep Dive - Database Schema (7 minutes)

### PostgreSQL Tables

**users:**
- id: UUID (PK)
- email: VARCHAR(255) UNIQUE
- name: VARCHAR(255)
- password_hash: VARCHAR(255) (bcrypt cost=10)
- avatar_color: VARCHAR(7) (hex for cursor color)
- role: VARCHAR(20) CHECK ('user', 'admin')
- created_at, updated_at: TIMESTAMPTZ

**documents:**
- id: UUID (PK)
- title: VARCHAR(500) DEFAULT 'Untitled Document'
- owner_id: UUID (FK users)
- current_version: BIGINT (OT version counter)
- content: JSONB (ProseMirror doc JSON)
- is_deleted: BOOLEAN (soft delete)
- created_at, updated_at: TIMESTAMPTZ

**document_permissions:**
- id: UUID (PK)
- document_id: UUID (FK documents)
- user_id: UUID (FK users, nullable)
- email: VARCHAR(255) (for pending invites)
- permission_level: CHECK ('view', 'comment', 'edit')
- UNIQUE(document_id, user_id)
- UNIQUE(document_id, email)

**operations (append-only log):**
- id: UUID (PK)
- document_id: UUID (FK documents)
- version_number: BIGINT
- operation: JSONB ({type, position, text/length})
- user_id: UUID (FK users)
- created_at: TIMESTAMPTZ
- UNIQUE(document_id, version_number)

**document_versions (snapshots):**
- id: UUID (PK)
- document_id: UUID (FK documents)
- version_number: BIGINT
- content: JSONB (full snapshot)
- created_by: UUID (FK users)
- is_named: BOOLEAN (user-created checkpoint)
- name: VARCHAR(255)
- UNIQUE(document_id, version_number)

**comments:**
- id: UUID (PK)
- document_id: UUID (FK documents)
- parent_id: UUID (FK comments, for replies)
- anchor_start, anchor_end: INTEGER (char offsets)
- anchor_version: BIGINT (version when created)
- content: TEXT
- author_id: UUID (FK users)
- resolved: BOOLEAN

### Critical Indexes

- idx_documents_owner ON documents(owner_id) WHERE NOT is_deleted
- idx_documents_updated ON documents(updated_at DESC)
- idx_permissions_user ON document_permissions(user_id)
- idx_operations_doc_version ON operations(document_id, version_number)
- idx_versions_doc ON document_versions(document_id, version_number DESC)
- idx_comments_doc ON comments(document_id)

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| session:{token} | String (JSON) | 24h | User session data |
| doc:{id}:version | String (int) | None | Current OT version |
| doc:{id}:ops | List | 1h | Recent ops buffer |
| presence:{docId} | Set | None | User IDs in document |
| cursor:{docId}:{userId} | Hash | 30s | Cursor position |
| channel:doc:{id} | Pub/Sub | N/A | Operation broadcast |
| channel:presence:{id} | Pub/Sub | N/A | Presence updates |

---

## Step 6: Deep Dive - Version History and Snapshots (5 minutes)

### Snapshot Strategy

**Thresholds:**
- OPS_THRESHOLD = 50 (snapshot every 50 ops)
- TIME_THRESHOLD = 5 minutes

```
Operation received ──▶ Check shouldSnapshot()
                              │
              ┌───────────────┴───────────────┐
              │                               │
      ops since snapshot       time since snapshot
         >= 50?                   >= 5 min?
              │                               │
              └───────────┬───────────────────┘
                          │ Either true
                          ▼
                   Create snapshot
                   (INSERT into document_versions)
                          │
                          ▼
                   Update documents.content
                   for fast loading
```

### Restore Version Algorithm

```
Target version: 75
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│ Find nearest snapshot <= target                          │
│ SELECT * FROM document_versions                          │
│ WHERE version_number <= 75                               │
│ ORDER BY version_number DESC LIMIT 1                     │
│                                                          │
│ Result: Snapshot at version 50                           │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│ Get operations 51-75                                     │
│ SELECT operation FROM operations                         │
│ WHERE version_number > 50 AND version_number <= 75       │
│ ORDER BY version_number ASC                              │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│ Replay operations on snapshot                            │
│ for each op: content = applyOperation(content, op)       │
│                                                          │
│ Return final content                                     │
└──────────────────────────────────────────────────────────┘
```

### Write Path with Async Persistence

```
┌─────────────────────────────────────────────────────────────────┐
│                     Operation Write Path                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ 1. Transform operation (synchronous, in-memory)                 │
│                    │                                            │
│                    ▼                                            │
│ 2. Send ACK immediately (before persistence)                    │
│                    │                                            │
│                    ▼                                            │
│ 3. Persist asynchronously via setImmediate()                    │
│         │                                                       │
│         ├──▶ Batch operations for efficiency                    │
│         │    (flush every 100ms or 10 ops)                      │
│         │                                                       │
│         └──▶ Check if snapshot needed                           │
│              If yes, create snapshot                            │
│                                                                 │
│ Note: If persistence fails, operation already broadcast -       │
│       will be recovered from other clients                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 7: Deep Dive - WebSocket Protocol (5 minutes)

### Message Types

**Client to Server:**
- join: {docId, version} - Join document collaboration
- operation: {docId, version, operationId, operation} - Send edit
- cursor: {docId, position, selection} - Cursor position update
- leave: {docId} - Leave document

**Server to Client:**
- joined: {docId, version, ops[], users[]} - Join confirmation
- ack: {docId, version} - Operation acknowledged
- operation: {docId, version, operation, userId} - Broadcast from others
- presence: {docId, users[]} - Presence update
- error: {code, message} - Error notification

### WebSocket Connection Handler Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                  WebSocket Message Handler                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ws.on('message') ──▶ Parse JSON                                │
│                           │                                     │
│           ┌───────────────┼───────────────┬───────────────┐     │
│           ▼               ▼               ▼               ▼     │
│        'join'        'operation'       'cursor'        'leave'  │
│           │               │               │               │     │
│           ▼               ▼               ▼               ▼     │
│     handleJoin()   handleOperation()  handleCursor()  handleLeave()
│                                                                 │
│  ws.on('close') ──▶ handleDisconnect()                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Join Flow

```
Join request ──▶ Verify permission
                      │
            ┌─────────┴─────────┐
            │                   │
        Forbidden             OK
            │                   │
            ▼                   ▼
     Send error          Add to document room
                               │
                               ▼
                         Get missed operations
                         (since client's version)
                               │
                               ▼
                         Add user to presence set
                         (Redis SADD)
                               │
                               ▼
                         Get active users
                               │
                               ▼
                         Send joined message
                         {version, ops, users}
                               │
                               ▼
                         Broadcast presence update
                         to other users
                               │
                               ▼
                         Subscribe to Redis pub/sub
```

### Cross-Server Coordination

```
┌─────────────────────────────────────────────────────────────────┐
│                 Redis Pub/Sub Coordination                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Server A                              Server B                 │
│  ┌─────────┐                          ┌─────────┐               │
│  │ Client1 │                          │ Client2 │               │
│  └────┬────┘                          └────┬────┘               │
│       │ operation                          │                    │
│       ▼                                    │                    │
│  ┌─────────┐                               │                    │
│  │ Process │                               │                    │
│  │   OT    │                               │                    │
│  └────┬────┘                               │                    │
│       │                                    │                    │
│       ▼                                    │                    │
│  Redis PUBLISH ──────────────────────────▶ │                    │
│  channel:doc:{id}                          │                    │
│                                            ▼                    │
│                                      ┌─────────┐                │
│                                      │Subscriber│               │
│                                      │ receives │               │
│                                      └────┬────┘                │
│                                           │                     │
│                                           ▼                     │
│                                      Forward to                 │
│                                      local clients              │
│                                      (skip sender)              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 8: Deep Dive - Comment Anchor Transformation (3 minutes)

Comments must stay attached to their text even as the document changes.

**CommentAnchor:**
- start: number (char offset)
- end: number (char offset)
- version: number (when created)

### Transform Anchor vs Insert

```
Insert at position P with text length L

┌────────────────────────────────────────────────────┐
│ P <= anchor.start:                                 │
│   Shift both start and end right by L             │
│                                                    │
│ P > anchor.start AND P < anchor.end:              │
│   Extend end by L (insert within comment range)   │
│                                                    │
│ P >= anchor.end:                                   │
│   No change (insert after anchor)                 │
└────────────────────────────────────────────────────┘
```

### Transform Anchor vs Delete

```
Delete from P with length L (delete end = P + L)

┌────────────────────────────────────────────────────┐
│ delete.end <= anchor.start:                        │
│   Shift both left by L                             │
│                                                    │
│ delete.start >= anchor.end:                        │
│   No change                                        │
│                                                    │
│ delete encompasses anchor:                         │
│   Collapse to {start: P, end: P}                  │
│                                                    │
│ delete overlaps start only:                        │
│   Move start to delete.start, shrink              │
│                                                    │
│ delete overlaps end only:                          │
│   Truncate end to delete.start                    │
│                                                    │
│ delete within anchor:                              │
│   Shrink end by L                                  │
└────────────────────────────────────────────────────┘
```

---

## Step 9: Caching Strategy (3 minutes)

### Multi-Tier Caching

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cache Lookup Flow                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Request for document content                                  │
│              │                                                  │
│              ▼                                                  │
│   ┌─────────────────────┐                                       │
│   │ L1: Memory Cache    │◀── In-process Map                     │
│   │ (per API server)    │    Fastest, ~10KB limit per doc       │
│   └─────────┬───────────┘                                       │
│             │ Miss                                              │
│             ▼                                                   │
│   ┌─────────────────────┐                                       │
│   │ L2: Redis Cache     │◀── Cross-server shared                │
│   │ doc:{id}:content    │    5 min TTL                          │
│   └─────────┬───────────┘                                       │
│             │ Miss                                              │
│             ▼                                                   │
│   ┌─────────────────────┐                                       │
│   │ L3: PostgreSQL      │◀── Source of truth                    │
│   │ documents.content   │    Populate both caches               │
│   └─────────────────────┘                                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### TTL Configuration

| Data | TTL | Invalidation |
|------|-----|--------------|
| Document content | 5 min | On any edit operation |
| User profile | 1 hour | On profile update |
| Permission cache | 10 min | On share/unshare |
| Session | 24 hours | On logout |
| Cursor positions | 30 sec | Auto-expire |

---

## Step 10: Circuit Breakers and Failure Handling (3 minutes)

### Circuit Breaker Configuration

- timeout: 2000ms (tight for real-time)
- errorThresholdPercentage: 50
- resetTimeout: 5000ms (quick recovery)
- volumeThreshold: 3

### Degradation Modes

```
┌────────────────────────────────────────────────────────────────┐
│                    Degradation Mode Decision                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  DB Circuit    Redis Circuit    Mode                           │
│  ──────────    ─────────────    ────                           │
│                                                                │
│   CLOSED         CLOSED      ──▶ NORMAL                        │
│                                  (Full functionality)          │
│                                                                │
│   OPEN           CLOSED      ──▶ READ_ONLY                     │
│                                  (No new edits persisted)      │
│                                                                │
│   CLOSED         OPEN        ──▶ LOCAL_ONLY                    │
│                                  (No cross-server sync)        │
│                                                                │
│   OPEN           OPEN        ──▶ OFFLINE                       │
│                                  (Queue locally, retry later)  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Resilient Operation Processing

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Try primary path (DB circuit)                                 │
│          │                                                     │
│    ┌─────┴─────┐                                               │
│    │           │                                               │
│  Success     Failure                                           │
│    │           │                                               │
│    ▼           ▼                                               │
│  Return    Is circuit open?                                    │
│  result         │                                              │
│           ┌─────┴─────┐                                        │
│           │           │                                        │
│          Yes         No                                        │
│           │           │                                        │
│           ▼           ▼                                        │
│       Fallback:    Throw                                       │
│       In-memory    error                                       │
│       processor                                                │
│           │                                                    │
│           ▼                                                    │
│       Queue for                                                │
│       persistence                                              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Step 11: Observability (2 minutes)

### Key Metrics (Prometheus)

**Counters:**
- google_docs_ot_operations_total (labels: type, status)

**Histograms:**
- google_docs_sync_latency_ms (labels: operation_type)
- Buckets: [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1000]

**Gauges:**
- google_docs_active_documents
- google_docs_active_collaborators
- google_docs_circuit_breaker_state (labels: circuit) [0=closed, 1=half-open, 2=open]

### SLIs and Alerts

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| OT sync latency p95 | < 100ms | > 250ms for 5 min |
| Operation success rate | > 99.9% | < 99% for 5 min |
| WebSocket availability | > 99.9% | < 99% for 5 min |
| Document load p95 | < 500ms | > 1s for 5 min |

---

## Step 12: Trade-offs (2 minutes)

| Decision | Alternative | Trade-off |
|----------|-------------|-----------|
| **OT over CRDT** | Yjs, Automerge | More complex transforms, but lower memory (no per-char metadata) |
| **Sticky sessions** | Distributed OT | Simpler coordination, but hot document = hot server |
| **Snapshots + ops** | Event sourcing only | More storage, but fast document loading |
| **PostgreSQL JSONB** | MongoDB | Single database, ACID for permissions/users |
| **Redis pub/sub** | RabbitMQ | Simpler for ephemeral messages, no persistence needed |
| **Batch persistence** | Sync writes | Lower durability window (100ms), but 10x throughput |

---

## Closing Summary

"I've designed a real-time collaborative document editor backend with:

1. **Operational Transformation engine** with insert/delete transforms and deterministic conflict resolution
2. **Hybrid storage** using PostgreSQL for metadata and periodic snapshots, Redis for hot data and pub/sub
3. **WebSocket protocol** with idempotent operations, cross-server coordination, and presence tracking
4. **Multi-tier caching** with in-memory L1 and Redis L2, aggressive invalidation on edits
5. **Resilience patterns** including circuit breakers, graceful degradation, and async persistence

The key insight is that OT provides the mathematical foundation for concurrent editing, while careful versioning with snapshots enables both real-time collaboration and efficient version history access."

---

## Potential Follow-up Questions

1. **How would you handle a document with 1000 concurrent editors?**
   - Partition document into sections, each with own OT stream
   - Regional servers with eventual sync between regions
   - Operational batching to reduce message volume

2. **How would you implement offline editing?**
   - Queue operations locally in IndexedDB
   - On reconnect, transform against server ops since last sync
   - Show conflicts as suggestions if auto-merge fails

3. **How would you scale the operations table?**
   - Partition by document_id and version_number ranges
   - Archive old operations to cold storage
   - Compact operation ranges into single aggregate ops

# Figma - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 1. Requirements Clarification (3 minutes)

**Functional Requirements:**
- Real-time collaborative editing with multiple concurrent users
- Store and retrieve vector graphics documents
- Version history with save/restore capability
- Presence tracking (cursors, selections)
- Comments anchored to design elements

**Non-Functional Requirements:**
- Latency: < 50ms for local operations, < 200ms for sync to collaborators
- Consistency: All users converge to the same document state
- Availability: 99.9% uptime with graceful degradation
- Scale: 50+ concurrent editors per file, 10M+ active files

**Backend Focus Areas:**
- CRDT implementation for conflict resolution
- WebSocket architecture for real-time sync
- PostgreSQL schema for files and operations
- Redis for presence and pub/sub
- Idempotency and failure handling

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Backend Architecture                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    Clients ──── WebSocket ────▶ Collaboration Server ◄──── Redis Pub/Sub    │
│                                        │                         │           │
│                                        ▼                         ▼           │
│                    ┌───────────────────────────────────┐    ┌─────────┐     │
│                    │          Operation Router          │    │ Presence│     │
│                    │   ┌───────────────────────────┐   │    │ Service │     │
│                    │   │     CRDT Engine (LWW)     │   │    └─────────┘     │
│                    │   └───────────────────────────┘   │                     │
│                    └───────────────┬───────────────────┘                     │
│                                    │                                         │
│              ┌─────────────────────┼─────────────────────┐                  │
│              │                     │                     │                  │
│              ▼                     ▼                     ▼                  │
│    ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐         │
│    │   PostgreSQL    │   │      Redis      │   │  Object Storage │         │
│    │  - files        │   │  - presence     │   │  - images       │         │
│    │  - versions     │   │  - sessions     │   │  - exports      │         │
│    │  - operations   │   │  - idempotency  │   │  - snapshots    │         │
│    └─────────────────┘   └─────────────────┘   └─────────────────┘         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Core Backend Components:**
1. **Collaboration Server**: Stateful WebSocket server managing file sessions
2. **CRDT Engine**: Last-Writer-Wins registers for property conflict resolution
3. **Operation Router**: Validates, persists, and broadcasts operations
4. **Presence Service**: Ephemeral cursor/selection tracking via Redis
5. **Version Service**: Snapshot management and history

---

## 3. Backend Deep-Dives

### Deep-Dive A: CRDT Implementation with Last-Writer-Wins (8 minutes)

**The Concurrency Problem:**

When User A and User B simultaneously edit:
- A moves Rectangle1 to (100, 100) at timestamp 1001
- B changes Rectangle1 fill to "blue" at timestamp 1000

Both operations should succeed (different properties). But if:
- A moves Rectangle1 to (100, 100) at timestamp 1001
- B moves Rectangle1 to (200, 200) at timestamp 1002

B's operation wins (higher timestamp).

**LWW Register Data Structure:**

```
┌─────────────────────────────────────────────────────────┐
│                    LWW Register                          │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐    │
│  │    value    │  │  timestamp  │  │   clientId   │    │
│  │   <T>       │  │   number    │  │   string     │    │
│  └─────────────┘  └─────────────┘  └──────────────┘    │
├─────────────────────────────────────────────────────────┤
│  Methods:                                                │
│  • get() ──▶ returns current value                      │
│  • set(value, timestamp, clientId) ──▶ bool             │
│  • merge(other LWWValue) ──▶ bool                       │
├─────────────────────────────────────────────────────────┤
│  Resolution Logic:                                       │
│  1. Higher timestamp wins                                │
│  2. If tie: lexicographically higher clientId wins      │
└─────────────────────────────────────────────────────────┘
```

**Design Object with LWW Properties:**

```
┌─────────────────────────────────────────────────────────────┐
│                    DesignObjectCRDT                          │
├─────────────────────────────────────────────────────────────┤
│  Fields:                                                     │
│  ├── id: string (readonly)                                  │
│  ├── type: 'rectangle' | 'ellipse' | 'text' | 'frame'       │
│  └── properties: Map<string, LWWRegister<unknown>>          │
├─────────────────────────────────────────────────────────────┤
│  Methods:                                                    │
│  ├── setProperty(key, value, timestamp, clientId) ──▶ bool  │
│  ├── getProperty(key) ──▶ unknown                           │
│  ├── merge(other DesignObjectCRDT) ──▶ void                 │
│  └── toJSON() ──▶ Record                                    │
├─────────────────────────────────────────────────────────────┤
│  Behavior:                                                   │
│  • New property: creates new LWWRegister                    │
│  • Existing property: calls register.set()                  │
│  • Delete: sets special '_deleted' property to true         │
└─────────────────────────────────────────────────────────────┘
```

**Operation Structure:**

```
┌─────────────────────────────────────────────────────────┐
│                      Operation                           │
├─────────────────────────────────────────────────────────┤
│  ├── id: string                                         │
│  ├── fileId: string                                     │
│  ├── userId: string                                     │
│  ├── clientId: string                                   │
│  ├── operationType: 'create' | 'update' | 'delete'      │
│  ├── objectId: string                                   │
│  ├── propertyPath?: string                              │
│  ├── oldValue?: unknown                                 │
│  ├── newValue?: unknown                                 │
│  ├── timestamp: number                                  │
│  └── idempotencyKey: string                             │
└─────────────────────────────────────────────────────────┘
```

**Operation Processing Flow:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Operation Processor                               │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│   Incoming Op ──▶ [1] Idempotency Check (Redis SET NX EX 300)            │
│                         │                                                 │
│                         ├── duplicate? ──▶ return {success:true}         │
│                         │                                                 │
│                         ▼                                                 │
│                   [2] Load Object State from session                      │
│                         │                                                 │
│                         ▼                                                 │
│                   [3] Apply CRDT Merge (LWW)                              │
│                         │                                                 │
│                         ├── superseded? ──▶ return {success:false}       │
│                         │                                                 │
│                         ▼                                                 │
│                   [4] Persist Operation to PostgreSQL                     │
│                         │                                                 │
│                         ▼                                                 │
│                   [5] Mark Idempotency Key Processed                      │
│                         │                                                 │
│                         ▼                                                 │
│                   [6] Broadcast to Other Clients ──▶ {success:true}      │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

### Deep-Dive B: WebSocket Collaboration Architecture (8 minutes)

**Session and Presence Data Structures:**

```
┌─────────────────────────────────────────────────────────────┐
│                      FileSession                             │
├─────────────────────────────────────────────────────────────┤
│  ├── fileId: string                                         │
│  ├── clients: Map<clientId, WebSocket>                      │
│  ├── canvasState: Map<objectId, DesignObjectCRDT>           │
│  ├── presence: Map<clientId, PresenceState>                 │
│  └── lastActivity: number                                   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     PresenceState                            │
├─────────────────────────────────────────────────────────────┤
│  ├── userId: string                                         │
│  ├── userName: string                                       │
│  ├── color: string (assigned on join)                       │
│  ├── cursor: {x, y} | null                                  │
│  ├── selection: string[] (object IDs)                       │
│  ├── viewport: {x, y, zoom}                                 │
│  └── lastUpdate: number                                     │
└─────────────────────────────────────────────────────────────┘
```

**WebSocket Message Flow:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Collaboration Server Flow                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Client Connects ──▶ Generate clientId (UUID)                       │
│                             │                                        │
│                             ▼                                        │
│  Message: 'subscribe' {fileId, userId, userName}                     │
│              │                                                       │
│              ├──▶ Load or create FileSession                        │
│              ├──▶ Register client in session                        │
│              ├──▶ Assign cursor color                               │
│              ├──▶ Initialize presence state                         │
│              ├──▶ Send 'sync' {file, presence[], yourColor}         │
│              ├──▶ Broadcast presence to other clients               │
│              └──▶ Publish to Redis (file:{id}:presence)             │
│                                                                      │
│  Message: 'operation' {operations[]}                                 │
│              │                                                       │
│              ├──▶ For each op: operationProcessor.processOperation  │
│              ├──▶ Apply to in-memory session state                  │
│              └──▶ Send 'ack' {operationIds[]}                       │
│                                                                      │
│  Message: 'presence' {cursor, selection, viewport}                   │
│              │                                                       │
│              ├──▶ Update session.presence.get(clientId)             │
│              ├──▶ Broadcast to other local clients                  │
│              └──▶ Publish to Redis (fire-and-forget)                │
│                                                                      │
│  Client Disconnects ──▶ Remove from session                         │
│                     ──▶ Broadcast presence update                   │
│                     ──▶ Publish 'leave' to Redis                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Redis Pub/Sub for Multi-Server Sync:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Multi-Server Architecture                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    Server A                    Redis                   Server B      │
│    ┌───────┐                 ┌───────┐                ┌───────┐     │
│    │Client1│                 │Pub/Sub│                │Client3│     │
│    │Client2│◄───subscribe───▶│       │◄───subscribe──▶│Client4│     │
│    └───────┘                 └───────┘                └───────┘     │
│        │                         │                         │         │
│        │    publish operation    │                         │         │
│        │──────────────────────▶  │  ──────────────────────▶│         │
│        │                         │                         │         │
│        │                    Channels:                      │         │
│        │           file:{fileId}:presence                  │         │
│        │           file:{fileId}:operation                 │         │
│                                                                      │
│    On 'pmessage' for operation:                                      │
│      ├── Apply operation to in-memory session                       │
│      └── Broadcast to local clients (exclude sourceClientId)        │
│                                                                      │
│    On 'pmessage' for presence:                                       │
│      ├── Update session.presence                                    │
│      └── Broadcast presence to local clients                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Deep-Dive C: PostgreSQL Schema and Queries (8 minutes)

**Core Tables:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                           files                                      │
├─────────────────────────────────────────────────────────────────────┤
│  id             UUID PRIMARY KEY                                    │
│  name           VARCHAR(255) NOT NULL                               │
│  owner_id       UUID FK → users                                     │
│  team_id        UUID FK → teams                                     │
│  thumbnail_url  VARCHAR(500)                                        │
│  canvas_data    JSONB DEFAULT '{"objects":[],"pages":[]}'           │
│  created_at     TIMESTAMP                                           │
│  updated_at     TIMESTAMP                                           │
│  deleted_at     TIMESTAMP (soft delete)                             │
├─────────────────────────────────────────────────────────────────────┤
│  Indexes:                                                            │
│  • idx_files_owner ON (owner_id)                                    │
│  • idx_files_team ON (team_id)                                      │
│  • idx_files_updated ON (updated_at DESC)                           │
│  • idx_files_active ON (id) WHERE deleted_at IS NULL                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        file_versions                                 │
├─────────────────────────────────────────────────────────────────────┤
│  id              UUID PRIMARY KEY                                   │
│  file_id         UUID FK → files ON DELETE CASCADE                  │
│  version_number  INTEGER NOT NULL                                   │
│  name            VARCHAR(255) (optional for named versions)         │
│  canvas_data     JSONB NOT NULL                                     │
│  created_by      UUID FK → users                                    │
│  created_at      TIMESTAMP                                          │
│  is_auto_save    BOOLEAN DEFAULT TRUE                               │
├─────────────────────────────────────────────────────────────────────┤
│  Constraints: UNIQUE(file_id, version_number)                       │
│  Indexes:                                                            │
│  • idx_versions_file ON (file_id)                                   │
│  • idx_versions_file_number ON (file_id, version_number DESC)       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                          operations                                  │
├─────────────────────────────────────────────────────────────────────┤
│  id               UUID PRIMARY KEY                                  │
│  file_id          UUID FK → files ON DELETE CASCADE                 │
│  user_id          UUID FK → users                                   │
│  client_id        VARCHAR(100)                                      │
│  operation_type   VARCHAR(100) NOT NULL                             │
│  object_id        VARCHAR(100)                                      │
│  property_path    VARCHAR(255)                                      │
│  old_value        JSONB                                             │
│  new_value        JSONB                                             │
│  timestamp        BIGINT NOT NULL                                   │
│  idempotency_key  VARCHAR(255)                                      │
│  created_at       TIMESTAMP                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Indexes:                                                            │
│  • idx_operations_file ON (file_id)                                 │
│  • idx_operations_file_timestamp ON (file_id, timestamp)            │
│  • UNIQUE idx_operations_idempotency ON (idempotency_key)           │
│    WHERE idempotency_key IS NOT NULL                                │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Query Patterns:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    FileRepository Methods                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  loadFileWithOperations(fileId, sinceTimestamp?)                    │
│    │                                                                 │
│    ├── Query 1: SELECT file by id WHERE deleted_at IS NULL          │
│    │                                                                 │
│    └── Query 2: SELECT operations                                   │
│                 WHERE file_id = $1 AND timestamp > $2                │
│                 ORDER BY timestamp ASC                               │
│                 LIMIT 1000                                           │
│                                                                      │
│  persistOperations(operations[])                                     │
│    │                                                                 │
│    └── Batch INSERT INTO operations                                 │
│        ON CONFLICT (idempotency_key) DO NOTHING                     │
│                                                                      │
│  updateCanvasData(fileId, canvasData)                                │
│    │                                                                 │
│    └── UPDATE files SET canvas_data = $2, updated_at = NOW()        │
│                                                                      │
│  createVersion(fileId, userId, canvasData, name?)                    │
│    │                                                                 │
│    └── INSERT file_versions with next version_number                │
│        (SELECT COALESCE(MAX(version_number), 0) + 1)                │
│                                                                      │
│  restoreVersion(fileId, versionId)                                   │
│    │                                                                 │
│    └── UPDATE files SET canvas_data = (SELECT from version)         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Deep-Dive D: Failure Handling and Resilience (7 minutes)

**Circuit Breaker Pattern:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Circuit Breaker for Database                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Configuration:                                                      │
│  ├── timeout: 5000ms                                                │
│  ├── errorThresholdPercentage: 50%                                  │
│  ├── resetTimeout: 10000ms (10s before half-open)                   │
│  └── volumeThreshold: 10 calls minimum                              │
│                                                                      │
│  State Machine:                                                      │
│                                                                      │
│    ┌────────┐    50% failures    ┌────────┐   10s timeout  ┌─────────┐
│    │ CLOSED │ ─────────────────▶ │  OPEN  │ ────────────▶ │HALF-OPEN│
│    └────────┘                    └────────┘               └─────────┘
│        ▲                                                       │
│        │                                                       │
│        └────── success ◄───────────────────────────────────────┘
│        └────── failure ──▶ back to OPEN
│                                                                      │
│  Events:                                                             │
│  • 'open'     ──▶ log warning, set metric to 1                      │
│  • 'halfOpen' ──▶ log info, set metric to 2                         │
│  • 'close'    ──▶ log info, set metric to 0                         │
│                                                                      │
│  On OpenCircuitError:                                                │
│    throw ServiceUnavailableError('Database temporarily unavailable') │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Retry with Exponential Backoff:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Retry Logic                                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Options:                                                            │
│  ├── maxAttempts: number                                            │
│  ├── baseDelayMs: number                                            │
│  ├── maxDelayMs: number                                             │
│  └── jitterMs: number                                               │
│                                                                      │
│  Flow:                                                               │
│                                                                      │
│    Attempt 1 ──▶ fn() ──▶ success? ──▶ return result                │
│        │                                                             │
│        └── error ──▶ isRetryable? ──▶ no ──▶ throw                  │
│                          │                                           │
│                          ▼ yes                                       │
│                                                                      │
│    Calculate delay:                                                  │
│      delay = min(baseDelayMs * 2^(attempt-1), maxDelayMs)           │
│      delay += random() * jitterMs                                   │
│                                                                      │
│    Attempt 2 ──▶ sleep(delay) ──▶ fn() ──▶ ...                      │
│                                                                      │
│  Retryable Errors:                                                   │
│  • ECONNREFUSED (network error)                                     │
│  • ETIMEDOUT (timeout)                                              │
│  • 40001 (serialization failure)                                    │
│  • 57P01 (admin shutdown)                                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Auto-Save with Persistence Lag Handling:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AutoSaveService                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  State:                                                              │
│  ├── pendingUpdates: Map<fileId, CanvasData>                        │
│  └── saveInProgress: Set<fileId>                                    │
│                                                                      │
│  queueUpdate(fileId, canvasData):                                    │
│    pendingUpdates.set(fileId, canvasData)                           │
│                                                                      │
│  flushPendingUpdates() [every 30 seconds]:                           │
│    │                                                                 │
│    │  for each (fileId, canvasData) in pendingUpdates:              │
│    │    │                                                            │
│    │    ├── saveInProgress.has(fileId)? ──▶ re-queue, skip          │
│    │    │                                                            │
│    │    └── try:                                                     │
│    │          saveInProgress.add(fileId)                            │
│    │          fileRepo.updateCanvasData(fileId, canvasData)         │
│    │          versionRepo.createAutoSave(fileId, canvasData)        │
│    │          metrics.autoSavesTotal.inc({status: 'success'})       │
│    │                                                                 │
│    │        catch error:                                             │
│    │          log error                                              │
│    │          pendingUpdates.set(fileId, canvasData) // re-queue    │
│    │          metrics.autoSavesTotal.inc({status: 'error'})         │
│    │                                                                 │
│    │        finally:                                                 │
│    │          saveInProgress.delete(fileId)                         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Flow Example

**Operation Flow:**

```
1. Client A draws rectangle
   └─▶ WS message: { type: "operation", payload: { operations: [...] } }

2. Server receives operation
   ├─▶ Check idempotency key in Redis
   ├─▶ Load current canvas state
   └─▶ Apply CRDT merge (LWW)

3. If operation accepted:
   ├─▶ Persist to operations table (batch)
   ├─▶ Update in-memory session state
   ├─▶ Broadcast to other clients on same server
   ├─▶ Publish to Redis for other servers
   └─▶ Queue canvas_data update for auto-save

4. Client B receives broadcast
   └─▶ WS message: { type: "operation", payload: { ... } }

5. Periodic auto-save (every 30s)
   ├─▶ Update files.canvas_data
   └─▶ Create file_versions entry
```

---

## 5. Trade-offs Analysis

| Decision | Pros | Cons |
|----------|------|------|
| LWW CRDT | Simple, predictable, easy to debug | Last write wins may not match user intent |
| Stateful WebSocket servers | Low latency, in-memory state | Requires sticky sessions, harder scaling |
| JSONB for canvas_data | Flexible schema, atomic snapshots | Large file updates are expensive |
| Operations log | Full audit trail, enables replay | Storage grows with activity |
| Redis pub/sub for presence | Fire-and-forget, low latency | Not durable, requires reconnect handling |
| Idempotency via Redis | Fast deduplication, automatic expiry | 5-minute window for retries |

---

## 6. Monitoring and Metrics

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Prometheus Metrics                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Gauges:                                                             │
│  ├── figma_ws_connections        (active WebSocket connections)     │
│  ├── figma_collaborators         (per file, label: file_id)         │
│  └── figma_circuit_breaker       (0=closed, 1=open, 2=half-open)    │
│                                                                      │
│  Counters:                                                           │
│  └── figma_operations_total      (labels: type, status)             │
│                                                                      │
│  Histograms:                                                         │
│  ├── figma_operation_latency_ms  (buckets: 5,10,25,50,100,250,500)  │
│  └── figma_sync_latency_ms       (buckets: 10,25,50,100,200,500)    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Future Enhancements

1. **Full CRDT Library**: Replace LWW with Yjs or Automerge for richer conflict resolution
2. **Sharding by File**: Consistent hashing to assign files to specific server instances
3. **Event Sourcing**: Store only operations, derive canvas_data on demand
4. **Offline Queue**: Server-side pending queue for disconnected clients
5. **Compression**: Delta compression for operations and versions
6. **Hot File Isolation**: Dedicated servers for files with 50+ concurrent editors

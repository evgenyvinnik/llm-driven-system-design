# Collaborative Editor - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

## Opening Statement (1 minute)

"I'll design a real-time collaborative document editor like Google Docs, where multiple users can simultaneously edit the same document and see each other's changes instantly. My backend focus will be on implementing Operational Transformation (OT) for conflict resolution, designing the WebSocket sync protocol, managing document state persistence, and ensuring consistency across distributed sync servers.

The core technical challenges are: implementing a correct OT algorithm that preserves user intent during concurrent edits, designing a scalable sync server architecture that can broadcast operations across multiple instances, and building a reliable persistence layer with snapshots and operation logs for fast document loading and complete history."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Edit**: Multiple users edit document simultaneously
- **Sync**: Real-time updates visible to all editors (< 50ms latency)
- **History**: Version history with restore capability
- **Presence**: Track who's editing and their cursor positions
- **Share**: Control document access and permissions

### Non-Functional Requirements
- **Latency**: < 50ms for local changes to appear, < 100ms for cross-client sync
- **Consistency**: All clients converge to same document state
- **Scale**: Support 50+ simultaneous editors per document
- **Durability**: Never lose user edits
- **Availability**: Graceful degradation when dependencies fail

### Scale Estimates
- 1M documents, 100K daily active users
- Most documents have 1-5 editors (typical)
- Some popular documents may have 50+ simultaneous editors
- Documents can be MB in size with years of history
- Peak: 10K concurrent editing sessions, 50K operations/second

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Editor                                │
│  ┌─────────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │  Rich Text      │  │  Operation   │  │  Sync               │ │
│  │  Editor         │  │  Transform   │  │  Engine             │ │
│  └─────────────────┘  └──────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                           │ WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Load Balancer                                │
│  (Sticky sessions by documentId for connection affinity)        │
└─────────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Sync Server 1   │  │  Sync Server 2   │  │  Sync Server 3   │
│  :3001           │  │  :3002           │  │  :3003           │
│                  │  │                  │  │                  │
│ - WebSocket mgr  │  │ - WebSocket mgr  │  │ - WebSocket mgr  │
│ - OT engine      │  │ - OT engine      │  │ - OT engine      │
│ - Presence       │  │ - Presence       │  │ - Presence       │
└──────────────────┘  └──────────────────┘  └──────────────────┘
          │                    │                    │
          └────────────────────┼────────────────────┘
                               │
                    RabbitMQ (fanout)
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   PostgreSQL     │  │     Redis        │  │   Object Store   │
│                  │  │                  │  │                  │
│ - Documents      │  │ - Active docs    │  │ - Attachments    │
│ - Operations     │  │ - Presence       │  │ - Media files    │
│ - Snapshots      │  │ - Cursors        │  │                  │
│ - Access control │  │ - Idempotency    │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### Core Components
1. **Sync Server** - WebSocket connections, OT engine, version management
2. **Document State Manager** - In-memory state with persistence
3. **RabbitMQ** - Cross-server operation broadcast
4. **PostgreSQL** - Snapshots and operation log
5. **Redis** - Presence, cursors, idempotency cache

## Deep Dive: Operational Transformation Engine (10 minutes)

### Operation Types

**TextOperation class**:
- `ops[]`: Array of operations
- `baseLength`: Document length before applying
- `targetLength`: Document length after applying

**Operation Methods**:
- `retain(n)`: Keep n characters unchanged, merge with previous retain
- `insert(str, attributes?)`: Add text, track in targetLength
- `delete(n)`: Remove n characters, merge with previous delete
- `apply(document)`: Execute operation on string

**Apply Logic**:
```
┌─────────────────────────────────────────────────────────────────┐
│                    apply(document)                               │
├─────────────────────────────────────────────────────────────────┤
│  For each op in ops:                                            │
│    retain(n) ──▶ result += document[index..index+n], index += n │
│    insert(s) ──▶ result += s                                    │
│    delete(n) ──▶ index += n (skip characters)                   │
│  Return result                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Transform Function

The heart of OT - transforms operations so they can be applied in any order.

**Transform Property**:
```
transform(op1, op2) => [op1', op2']

Such that: apply(apply(doc, op1), op2') === apply(apply(doc, op2), op1')
```

**Transform Cases**:

| op1 | op2 | Result |
|-----|-----|--------|
| insert | insert | op1 inserts first, op2 retains past it |
| retain | retain | Both retain minimum length |
| delete | delete | Both skip (cancel out) |
| delete | retain | op1 deletes, op2 skips |
| retain | delete | op2 deletes, op1 skips |

**Compose Function**:
```
compose(op1, op2) => combined

Such that: apply(apply(doc, op1), op2) === apply(doc, compose(op1, op2))
```

### Transform Example

```
Document: "Hello"

User A at position 1: retain(1), insert("X")  ──▶ "HXello"
User B at position 3: retain(3), insert("Y")  ──▶ "HelYlo"

Without transform: Conflicts and corruption.

With transform:
┌────────────────────────────────────────────────────────────────┐
│ Transform A against B: retain(1), insert("X")                  │
│   (unchanged, B's insert is after)                             │
│                                                                │
│ Transform B against A: retain(4), insert("Y")                  │
│   (skip past A's inserted X)                                   │
│                                                                │
│ Final result after both: "HXelYlo" (convergent)                │
└────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Document State Manager (8 minutes)

### Server-Side State

**DocumentState class**:
- `documentId`: Unique identifier
- `version`: Monotonic counter
- `content`: Current document string
- `clients`: Map of connected clients
- `operationBuffer`: Map of recent operations for transforms

**load() Method**:
1. Query latest snapshot from `document_snapshots`
2. Set initial version and content
3. Query operations after snapshot version
4. Apply each operation to content
5. Store in operation buffer

**applyOperation() Method**:

```
┌─────────────────────────────────────────────────────────────────┐
│          applyOperation(clientId, clientVersion, op, opId)      │
├─────────────────────────────────────────────────────────────────┤
│  1. Check idempotency cache ──▶ return cached if exists         │
│  2. Get concurrent ops (clientVersion..serverVersion)           │
│  3. Transform against each concurrent op                        │
│  4. Validate base length matches content length                 │
│  5. Apply to content: this.content = transformedOp.apply()      │
│  6. Increment version                                           │
│  7. Buffer for future transforms                                │
│  8. Persist to operations table                                 │
│  9. Snapshot if version % 50 === 0                              │
│ 10. Cache result for idempotency (1 hour TTL)                   │
└─────────────────────────────────────────────────────────────────┘
```

**getConcurrentOperations()**:
- Check in-memory buffer first (last 100 ops)
- Fall back to database query if needed

**Snapshot Strategy**:
- Save every 50 operations
- Enables fast document loading
- Complete history preserved in ops table

### WebSocket Sync Server

**SyncServer class**:
- `documents`: Map of active DocumentState
- `clients`: Map of WebSocket to ClientConnection

**handleConnection()**:
1. Generate clientId
2. Load or get document state
3. Register client with assigned color
4. Send `init` message with full state
5. Broadcast `client_join` to others
6. Store presence in Redis (5 min TTL)

**handleOperation()**:

```
┌─────────────────────────────────────────────────────────────────┐
│                   handleOperation Flow                          │
├─────────────────────────────────────────────────────────────────┤
│  1. Parse operation from JSON                                   │
│  2. Apply to document state (may transform)                     │
│  3. Log conflict resolution if transforms occurred              │
│  4. Send ACK to sender with new version                         │
│  5. Broadcast to local clients                                  │
│  6. Publish to RabbitMQ for cross-server sync                   │
│                                                                 │
│  On error:                                                      │
│    - Log failure                                                │
│    - Send resync with full content                              │
└─────────────────────────────────────────────────────────────────┘
```

**handleCursor()**:
- Update client cursor in document state
- Store in Redis (60s TTL)
- Broadcast to other clients

**handleDisconnect()**:
- Remove from document state
- Broadcast `client_leave`
- Remove from Redis presence/cursors
- Clean up empty documents after 30s delay

**Color Assignment**:
- Hash clientId to index into color array
- Consistent color per client

## Deep Dive: Cross-Server Synchronization (5 minutes)

### RabbitMQ Fanout Architecture

**Queue Setup**:
- Topic exchange: `doc.operations`
- Per-server queue: `op.broadcast.{SERVER_ID}`
- Bind pattern: `doc.*` (all documents)
- Prefetch: 50 messages for backpressure
- Dead letter exchange: `doc.dlx`

**Message Flow**:

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Sync Server 1│    │   RabbitMQ   │    │ Sync Server 2│
│ (publisher)  │──▶ │ doc.operations──▶ │ (consumer)   │
└──────────────┘    │   exchange   │    └──────────────┘
                    └──────────────┘           │
                           │                   ▼
                           │           ┌──────────────┐
                           │           │ Skip if self │
                           │           │ Deduplicate  │
                           │           │ Update state │
                           │           │ Broadcast    │
                           │           └──────────────┘
                           │
                    ┌──────────────┐
                    │ Dead Letter  │
                    │ doc.failed   │
                    └──────────────┘
```

**Consumer Logic**:
1. Skip messages from self (same SERVER_ID)
2. Check deduplication via Redis (`seen:{messageId}`)
3. Update local document state
4. Broadcast to local WebSocket clients
5. Mark as seen (1 hour TTL)
6. ACK message

**Error Handling**:
- On failure: NACK with requeue (once)
- On second failure: goes to DLQ
- Log failures for manual inspection

### Dead Letter Queue

**Setup**:
- Exchange: `doc.dlx`
- Queue: `doc.failed`
- Binding: `operation.failed`

**Consumer**:
- Log error with death reason
- Store in `failed_messages` table for inspection
- ACK to prevent infinite loop

## Database Schema (3 minutes)

### Tables Overview

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `documents` | Document metadata | id, title, owner_id, timestamps |
| `document_snapshots` | Periodic checkpoints | document_id, version, content |
| `operations` | Complete edit history | document_id, version, client_id, operation (JSONB) |
| `document_access` | Permissions | document_id, user_id, permission |
| `document_comments` | Threaded comments | document_id, range_start/end, content, resolved |
| `audit_log` | Security events | event_type, user_id, document_id, action, details |
| `failed_messages` | DLQ inspection | routing_key, content, headers |

### Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| documents | owner_id | User's documents |
| operations | (document_id, version) | UNIQUE, fast lookup |
| operations | created_at | Cleanup queries |
| document_access | user_id | Permission checks |
| document_comments | document_id | Load comments |
| audit_log | (user_id, created_at) | User activity |
| audit_log | (document_id, created_at) | Document history |

### Permission Levels

- `view`: Read-only access
- `comment`: Can add comments
- `edit`: Full editing rights
- `admin`: Can manage access

## Deep Dive: Version History (3 minutes)

### VersionHistoryService

**getVersions()**:
- Query snapshots ordered by version DESC
- Include: version, timestamp, size, author name
- Limit default: 50

**getVersion(targetVersion)**:

```
┌─────────────────────────────────────────────────────────────────┐
│               Reconstruct Version at Point-in-Time               │
├─────────────────────────────────────────────────────────────────┤
│  1. Find closest snapshot <= targetVersion                       │
│  2. Start with snapshot content and version                     │
│  3. Query operations between snapshot and target                │
│  4. Apply each operation in order                               │
│  5. Return { version, content }                                  │
└─────────────────────────────────────────────────────────────────┘
```

**restoreVersion()**:
1. Get historical version content
2. Get current (latest) version content
3. Create restore operation: delete all current, insert all historical
4. Apply as new operation (goes through OT)
5. Log to audit table
6. Return new version number

## Trade-offs and Alternatives (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Sync Algorithm | OT | CRDT | Simpler, more efficient for text, well-established |
| Transport | WebSocket | HTTP Polling | True bidirectional, lower latency |
| Storage | Snapshot + Op Log | Full Snapshots | Storage efficient, complete history |
| Authority | Server | Peer-to-Peer | Consistent ordering, simpler conflict resolution |
| Cross-server | RabbitMQ | Redis Pub/Sub | Persistence, dead letter queues, backpressure |
| Presence | Redis | In-memory | Multi-server coordination, automatic expiry |

### OT vs CRDT

**Chose OT because:**
- Simpler to understand and implement
- More efficient for text (smaller operations)
- Well-established in production (Google Docs uses OT)
- CRDTs have higher memory overhead for unique character IDs

**Trade-off:** Requires server for ordering (not peer-to-peer)

### Snapshot Frequency

- Every 50 operations
- Balance between load time and storage
- Configurable per document size

## Future Enhancements

1. **Rich Text Formatting** - Extend operations with attributes
2. **Offline Mode** - Local operation queue with sync on reconnect
3. **Presence Improvements** - Selection ranges, activity indicators
4. **Performance** - Binary operation format, delta compression
5. **Sharding** - Partition documents across servers by ID hash
6. **Global Scale** - Multi-region deployment with regional affinity

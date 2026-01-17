# Google Docs - System Design Interview Answer

## Opening Statement

"Today I'll design Google Docs, a real-time collaborative document editing platform. The key challenges are enabling seamless simultaneous editing by multiple users, maintaining consistency across all clients, and providing a rich text editing experience with version history and comments."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Document creation and editing** - Rich text with formatting (bold, italic, headings, lists)
2. **Real-time collaboration** - Multiple users editing simultaneously
3. **Cursor and selection sharing** - See where others are typing
4. **Version history** - View and restore previous versions
5. **Comments and suggestions** - Threaded comments, suggestion mode
6. **Sharing and permissions** - View, comment, edit access levels
7. **Offline editing** - Continue working without internet

### Non-Functional Requirements

- **Latency**: < 100ms for local edits to appear, < 500ms for sync to collaborators
- **Consistency**: All users must see the same final document
- **Availability**: 99.99% uptime
- **Scale**: 1B+ documents, 100M+ DAU, 50+ concurrent editors per document
- **Durability**: Zero data loss

### Out of Scope

- Spreadsheets and slides (separate systems)
- Add-ons/plugins
- Advanced formatting (tables, drawings - could extend)

---

## Step 2: Scale Estimation (2-3 minutes)

**User base:**
- 100 million daily active users
- 1 billion total documents
- Average document: 50KB (text + formatting metadata)

**Traffic patterns:**
- Average user: 30 edits per minute when active
- Peak concurrent users: 10M
- Peak operations: 10M * 30 ops/min = 300M ops/min = 5M ops/second

**Storage:**
- 1B documents * 50KB = 50 TB base storage
- Version history (10x): 500 TB
- Daily new documents: 10M * 50KB = 500 GB/day

**Key insight**: This is an operational transformation problem at massive scale. The challenge is not storage but consistent, real-time synchronization.

---

## Step 3: High-Level Architecture (10 minutes)

```
                              ┌────────────────────────────────────┐
                              │           Client Apps              │
                              │   (Web/iOS/Android/Desktop)        │
                              └─────────────────┬──────────────────┘
                                                │
                                    WebSocket + HTTPS
                                                │
                              ┌─────────────────▼──────────────────┐
                              │           Load Balancer            │
                              │    (Sticky sessions by doc_id)     │
                              └─────────────────┬──────────────────┘
                                                │
          ┌─────────────────────────────────────┼─────────────────────────────────────┐
          │                                     │                                     │
┌─────────▼──────────┐             ┌────────────▼───────────┐             ┌──────────▼─────────┐
│  Collaboration     │             │   Collaboration        │             │  Collaboration     │
│  Server            │             │   Server               │             │  Server            │
│  (Doc A, B, C)     │             │   (Doc D, E, F)        │             │  (Doc G, H, I)     │
│                    │             │                        │             │                    │
│  - OT Engine       │             │  - OT Engine           │             │  - OT Engine       │
│  - Document State  │             │  - Document State      │             │  - Document State  │
└─────────┬──────────┘             └────────────┬───────────┘             └──────────┬─────────┘
          │                                     │                                     │
          └─────────────────────────────────────┼─────────────────────────────────────┘
                                                │
        ┌───────────────────────────────────────┼───────────────────────────────────────┐
        │                                       │                                       │
┌───────▼───────┐                    ┌──────────▼──────────┐                  ┌─────────▼────────┐
│  PostgreSQL   │                    │       Redis         │                  │  Object Storage  │
│  (Metadata,   │                    │  (Sessions,         │                  │  (Document       │
│   Permissions)│                    │   Presence,         │                  │   Snapshots)     │
│               │                    │   Pub/Sub)          │                  │                  │
└───────────────┘                    └─────────────────────┘                  └──────────────────┘
                                                │
                          ┌─────────────────────┼─────────────────────┐
                          │                     │                     │
                 ┌────────▼────────┐  ┌─────────▼────────┐  ┌────────▼────────┐
                 │  Version History│  │   Comments       │  │   Export        │
                 │  Service        │  │   Service        │  │   Service       │
                 └─────────────────┘  └──────────────────┘  └─────────────────┘
```

### Core Components

1. **Client Application**
   - Rich text editor (ProseMirror or Quill.js based)
   - Local operation buffer for optimistic updates
   - WebSocket connection for real-time sync
   - Offline queue using IndexedDB

2. **Collaboration Server**
   - Stateful server holding document state in memory
   - Operational Transformation (OT) engine
   - Broadcasts transformed operations to all clients
   - Handles client operation acknowledgments

3. **Presence Service**
   - Real-time cursor positions and selections
   - User colors and names
   - Redis pub/sub for low-latency distribution

4. **Storage Layer**
   - PostgreSQL: Document metadata, permissions, user data
   - Object Storage: Document snapshots and operation logs
   - Redis: Sessions, presence, caching

5. **Supporting Services**
   - Version History: Snapshot storage and replay
   - Comments: Threaded discussions with anchors
   - Export: PDF, DOCX, HTML generation

---

## Step 4: Deep Dive - Operational Transformation (10 minutes)

This is the core of Google Docs. Let me explain why OT and how it works.

### The Fundamental Problem

Two users typing simultaneously:

```
Initial: "Hello"

User A: Insert "!" at position 5 → "Hello!"
User B: Insert " World" at position 5 → "Hello World"

If both apply naively:
A applies B's op: "Hello World!" - CORRECT
B applies A's op at pos 5: "Hello! World" - WRONG!
```

The same operation produces different results depending on order.

### Operational Transformation Solution

**Key Idea**: Transform operations against each other so they produce the same result regardless of application order.

```
         Server
            │
   ┌────────┴────────┐
   │                 │
   ▼                 ▼
 Op A              Op B
   │                 │
   │  Transform      │
   └────────┬────────┘
            │
   A' = transform(A, B)
   B' = transform(B, A)
            │
   Apply A then B' = Apply B then A'
```

### OT for Text: Insert/Delete Operations

```typescript
interface InsertOp {
  type: 'insert';
  position: number;
  text: string;
}

interface DeleteOp {
  type: 'delete';
  position: number;
  length: number;
}

// Transform Insert against Insert
function transformII(op1: InsertOp, op2: InsertOp): InsertOp {
  if (op1.position <= op2.position) {
    // op1 happens before op2, shift op2
    return { ...op2, position: op2.position + op1.text.length };
  } else {
    // op2 happens before op1, no change
    return op2;
  }
}

// Transform Delete against Insert
function transformDI(del: DeleteOp, ins: InsertOp): DeleteOp {
  if (del.position >= ins.position) {
    return { ...del, position: del.position + ins.text.length };
  } else if (del.position + del.length <= ins.position) {
    return del;
  } else {
    // Delete range spans insert point - split delete
    // Complex case: return two operations
  }
}
```

### Server-Client Protocol

```
      Client A                Server                Client B
         │                      │                      │
         │    Op A (v=1)        │                      │
         │─────────────────────▶│                      │
         │                      │    Op B (v=1)        │
         │                      │◀─────────────────────│
         │                      │                      │
         │                      │ Transform A and B    │
         │                      │                      │
         │    Ack A + Op B'     │    Ack B + Op A'     │
         │◀─────────────────────│─────────────────────▶│
         │                      │                      │
      Apply B'               Apply both             Apply A'
         │                      │                      │
      v=2                    v=2                    v=2
```

### Document Version Control

Each document maintains:
- **Server version**: Authoritative version number
- **Operation history**: All operations in order
- **Client version**: Each client's last acknowledged version

When client sends operation:
1. Include the version number the operation is based on
2. Server transforms against all operations since that version
3. Server broadcasts transformed operation with new version

### Handling Conflicting Operations

```typescript
interface DocumentState {
  version: number;
  content: string;
  operationLog: Operation[];
}

function processClientOperation(
  doc: DocumentState,
  clientOp: Operation,
  clientVersion: number
): Operation[] {
  // Get all operations client hasn't seen
  const missedOps = doc.operationLog.slice(clientVersion);

  // Transform client operation against missed ops
  let transformedOp = clientOp;
  for (const serverOp of missedOps) {
    transformedOp = transform(transformedOp, serverOp);
  }

  // Apply and store
  doc.content = applyOperation(doc.content, transformedOp);
  doc.operationLog.push(transformedOp);
  doc.version++;

  // Return operations client needs
  return [...missedOps, transformedOp];
}
```

### Why OT Over CRDT for Docs?

| Factor | OT | CRDT |
|--------|-----|------|
| Memory usage | Lower | Higher (metadata per character) |
| Transformation complexity | Complex | Simpler |
| Proven at scale | Google Docs uses OT | Newer technology |
| Intention preservation | Better | Can have surprises |

Google Docs chose OT because:
1. Lower memory overhead for large documents
2. Battle-tested algorithm
3. Better control over conflict resolution behavior

---

## Step 5: Deep Dive - Document Storage and Versioning (7 minutes)

### Storage Model

Documents are stored as:
1. **Latest snapshot**: Full document state (for fast loading)
2. **Operation log**: All operations since last snapshot
3. **Periodic checkpoints**: Snapshots every N operations

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Snapshot v0 │───▶│ Ops 1-100   │───▶│ Snapshot v1 │───▶│ Ops 101-150 │
│             │    │             │    │             │    │             │
│ Full doc    │    │ [op1, op2,  │    │ Full doc    │    │ [op101, ... │
│ state       │    │  ..., op100]│    │ state       │    │  op150]     │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### Snapshot Strategy

**When to snapshot:**
- Every 100 operations
- Every 5 minutes of activity
- When document is closed
- Before version history access

**Snapshot content:**

```json
{
  "version": 150,
  "content": {
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "Hello " },
          { "type": "text", "marks": ["bold"], "text": "World" }
        ]
      }
    ]
  },
  "created_at": "2024-01-15T10:30:00Z"
}
```

### Version History

Users see a timeline of changes:

1. **Auto-saved versions**: Periodic snapshots
2. **Named versions**: User-created checkpoints
3. **Suggestion history**: Accepted/rejected suggestions

**Restoring a version:**

```typescript
async function restoreVersion(docId: string, targetVersion: number) {
  // Find nearest snapshot before target
  const snapshot = await findSnapshot(docId, targetVersion);

  // Replay operations from snapshot to target
  const ops = await getOperations(docId, snapshot.version, targetVersion);
  let content = snapshot.content;
  for (const op of ops) {
    content = applyOperation(content, op);
  }

  // Create new operation that sets content
  return createSetContentOperation(content);
}
```

### Compaction

Old operation logs are compacted:
- Keep detailed ops for 30 days
- Compress to daily snapshots after 30 days
- Keep monthly snapshots indefinitely

---

## Step 6: Deep Dive - Comments and Suggestions (5 minutes)

### Comment Anchoring

Comments are anchored to text ranges:

```typescript
interface Comment {
  id: string;
  document_id: string;
  anchor: {
    start_offset: number;  // Position in document
    end_offset: number;
    version: number;       // Document version when created
  };
  content: string;
  author_id: string;
  created_at: Date;
  resolved: boolean;
  replies: Comment[];
}
```

**Challenge**: Document changes, but comment should stay attached to same text.

**Solution**: Transform comment anchors along with operations

```typescript
function transformAnchor(anchor: Anchor, op: Operation): Anchor {
  if (op.type === 'insert') {
    if (op.position <= anchor.start_offset) {
      // Insert before anchor, shift both
      return {
        ...anchor,
        start_offset: anchor.start_offset + op.text.length,
        end_offset: anchor.end_offset + op.text.length
      };
    } else if (op.position < anchor.end_offset) {
      // Insert within anchor, extend end
      return {
        ...anchor,
        end_offset: anchor.end_offset + op.text.length
      };
    }
  }
  // Handle delete similarly
  return anchor;
}
```

### Suggestion Mode

Suggestions are tracked changes:

```typescript
interface Suggestion {
  id: string;
  type: 'insert' | 'delete' | 'replace';
  anchor: Anchor;
  original_text: string;
  suggested_text: string;
  author_id: string;
  status: 'pending' | 'accepted' | 'rejected';
}
```

Rendered with strikethrough (deleted) and colored text (inserted).

---

## Step 7: Presence and Cursor Sharing (3 minutes)

### Presence State

```typescript
interface PresenceState {
  user_id: string;
  name: string;
  color: string;  // Assigned color for cursor
  cursor: {
    position: number;
  } | null;
  selection: {
    start: number;
    end: number;
  } | null;
}
```

### Update Flow

1. Client cursor changes → Send presence update via WebSocket
2. Server broadcasts to other clients in same document
3. Updates throttled to 20Hz to reduce traffic
4. Clients interpolate between updates for smooth cursors

### Scaling Presence

- Presence is ephemeral (not persisted)
- Redis pub/sub for cross-server distribution
- Document channels: `presence:doc:{doc_id}`

---

## Step 8: Data Model (3 minutes)

### PostgreSQL Schema

```sql
-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY,
  title VARCHAR(500),
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  current_version BIGINT DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE
);

-- Document permissions
CREATE TABLE document_permissions (
  document_id UUID REFERENCES documents(id),
  user_id UUID REFERENCES users(id),
  email VARCHAR(255),  -- For pending invites
  permission_level VARCHAR(20),  -- 'view', 'comment', 'edit'
  created_at TIMESTAMP,
  PRIMARY KEY (document_id, COALESCE(user_id, email))
);

-- Document versions (snapshots)
CREATE TABLE document_versions (
  id UUID PRIMARY KEY,
  document_id UUID REFERENCES documents(id),
  version_number BIGINT,
  content_url VARCHAR(500),  -- S3 URL
  created_at TIMESTAMP,
  created_by UUID REFERENCES users(id),
  is_named BOOLEAN DEFAULT FALSE,
  name VARCHAR(255)
);

-- Comments
CREATE TABLE comments (
  id UUID PRIMARY KEY,
  document_id UUID REFERENCES documents(id),
  parent_id UUID REFERENCES comments(id),  -- For replies
  anchor_start INTEGER,
  anchor_end INTEGER,
  anchor_version BIGINT,
  content TEXT,
  author_id UUID REFERENCES users(id),
  created_at TIMESTAMP,
  resolved BOOLEAN DEFAULT FALSE
);
```

### Object Storage Structure

```
/documents/{doc_id}/
  ├── snapshots/
  │   ├── v0.json
  │   ├── v100.json
  │   └── v200.json
  └── operations/
      ├── ops_0_99.json
      └── ops_100_199.json
```

---

## Step 9: API Design (2 minutes)

### WebSocket Protocol

```typescript
// Client → Server
{ type: "OPERATION", doc_id: "...", version: 5, operation: {...} }
{ type: "PRESENCE", doc_id: "...", cursor: { position: 42 } }
{ type: "SUBSCRIBE", doc_id: "..." }

// Server → Client
{ type: "OPERATION", version: 6, operation: {...}, author: "..." }
{ type: "ACK", version: 6 }
{ type: "PRESENCE", user_id: "...", cursor: {...} }
{ type: "ERROR", code: "VERSION_CONFLICT", message: "..." }
```

### REST API

```
POST   /api/documents              - Create document
GET    /api/documents/{id}         - Get document metadata
GET    /api/documents/{id}/content - Get document content
GET    /api/documents/{id}/history - List versions
POST   /api/documents/{id}/share   - Share document
POST   /api/documents/{id}/comments - Add comment
POST   /api/documents/{id}/export  - Export to PDF/DOCX
```

---

## Step 10: Offline Support (3 minutes)

### Client-Side Storage

```
IndexedDB
├── documents/           - Cached document content
├── pending_operations/  - Unsynced local changes
└── metadata/            - Document list, permissions
```

### Offline Editing Flow

1. User makes edit while offline
2. Operation stored in pending queue with local timestamp
3. UI shows "offline" indicator

### Sync on Reconnect

```typescript
async function syncPendingOperations() {
  const pending = await getPendingOperations();

  for (const op of pending) {
    // Transform against server's current version
    const serverVersion = await getServerVersion(op.docId);
    const serverOps = await getOperationsSince(op.docId, op.baseVersion);

    let transformedOp = op;
    for (const serverOp of serverOps) {
      transformedOp = transform(transformedOp, serverOp);
    }

    // Send transformed operation
    await sendOperation(transformedOp);
    await removePendingOperation(op.id);
  }
}
```

### Conflict Resolution

Most conflicts auto-resolve via OT. For irreconcilable conflicts:
- Show user their offline changes as suggestions
- Let them manually merge

---

## Step 11: Scalability (2 minutes)

### Scaling Collaboration Servers

- Shard by document_id (consistent hashing)
- Each document handled by single server (simplifies OT)
- Hot documents can be isolated to dedicated servers

### Auto-scaling

- Scale based on WebSocket connections
- Each server handles ~10K concurrent connections
- Document handoff on server shutdown

### Database Scaling

- PostgreSQL: Read replicas for metadata queries
- Document content in S3 (infinitely scalable)
- Redis cluster for presence and caching

---

## Step 12: Trade-offs (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| OT over CRDT | More complex server logic, but lower memory |
| Stateful servers | Requires sticky sessions, but faster sync |
| Periodic snapshots | Storage overhead, but fast version access |
| Single server per doc | Simpler OT, but single point of failure |

### Alternatives Considered

1. **CRDT (like Yjs)**
   - Would enable peer-to-peer sync
   - Higher memory per character
   - Chose OT for memory efficiency at scale

2. **Event sourcing only**
   - Would avoid snapshots
   - Too slow for document loading
   - Hybrid approach better

3. **Microservices per feature**
   - Would increase operational complexity
   - Monolithic collaboration server simpler

---

## Closing Summary

"I've designed a real-time collaborative document editor with:

1. **Operational Transformation** for consistent concurrent editing
2. **Hybrid storage** with snapshots and operation logs for efficient versioning
3. **Anchor-based comments** that follow text through edits
4. **Offline support** with operation queuing and sync

The core insight is that OT provides the mathematical foundation for concurrent editing, while careful versioning enables both real-time collaboration and historical access. Would be happy to explore any component further."

---

## Potential Follow-up Questions

1. **How would you handle a document with 1000 concurrent editors?**
   - Partition document into sections
   - Regional servers with eventual sync
   - Operational batching

2. **How would you implement find and replace?**
   - Compound operation that deletes and inserts
   - Transactional semantics

3. **How would you add real-time spell checking?**
   - Background service processing document
   - Marks stored as metadata
   - Updates via presence channel

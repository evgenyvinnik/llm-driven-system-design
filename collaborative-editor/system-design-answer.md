# Collaborative Editor - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design a real-time collaborative document editor like Google Docs, where multiple users can simultaneously edit the same document and see each other's changes instantly. The key challenges are handling concurrent edits without conflicts, achieving low-latency updates, and ensuring all clients converge to the same document state.

The core technical challenges are implementing Operational Transformation (OT) for conflict resolution, maintaining consistent document state across clients with different network latencies, and efficiently storing version history for undo and time travel."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Edit**: Multiple users edit document simultaneously
- **Sync**: Real-time updates visible to all editors
- **History**: Version history with restore capability
- **Presence**: See who's editing and their cursor positions
- **Share**: Control document access and permissions

### Non-Functional Requirements
- **Latency**: < 50ms for local changes to appear
- **Consistency**: All clients converge to same state
- **Scale**: Support 50+ simultaneous editors per document
- **Durability**: Never lose user edits

### Scale Estimates
- Millions of documents
- Most documents have 1-5 editors
- Some popular documents may have 50+ simultaneous editors
- Documents can be MB in size with years of history

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                     Client Editor                          |
|  +-----------------+  +--------------+  +---------------+ |
|  |  Rich Text      |  |  Operation   |  |  Sync         | |
|  |  Editor         |  |  Transform   |  |  Engine       | |
|  |                 |  |              |  |               | |
|  | - ContentEdit   |  | - Local OT   |  | - WebSocket   | |
|  | - Selection     |  | - Apply ops  |  | - Reconnect   | |
|  +-----------------+  +--------------+  +---------------+ |
+----------------------------------------------------------+
                           | WebSocket
                           v
+----------------------------------------------------------+
|                     Sync Server                            |
|  +-----------------+  +--------------+  +---------------+ |
|  |  Connection     |  |  Document    |  |  Persistence  | |
|  |  Manager        |  |  State       |  |  Layer        | |
|  |                 |  |              |  |               | |
|  | - Sessions      |  | - OT engine  |  | - Snapshots   | |
|  | - Presence      |  | - Operations |  | - Op log      | |
|  +-----------------+  +--------------+  +---------------+ |
+----------------------------------------------------------+
          |                    |                    |
          v                    v                    v
+------------------+  +------------------+  +------------------+
|   PostgreSQL     |  |     Redis        |  |   Object Store   |
|                  |  |                  |  |                  |
| - Documents      |  | - Active docs    |  | - Attachments    |
| - Operations     |  | - Presence       |  | - Media          |
| - Versions       |  | - Cursors        |  |                  |
+------------------+  +------------------+  +------------------+
```

### Core Components
1. **Client Editor** - Rich text editor with local OT
2. **Sync Engine** - WebSocket connection to server
3. **Document State** - Server-side OT and version management
4. **Persistence Layer** - Snapshots and operation log

## Deep Dive: Operational Transformation (8 minutes)

OT is the algorithm that allows concurrent edits to be applied in any order while preserving intent.

### Operation Types

```javascript
class TextOperation {
  constructor() {
    this.ops = []        // Array of operations
    this.baseLength = 0  // Document length before applying
    this.targetLength = 0 // Document length after applying
  }

  retain(n) {
    // Keep n characters unchanged
    if (n <= 0) return this
    this.baseLength += n
    this.targetLength += n

    // Merge with previous retain if possible
    if (this.ops.length > 0 && this.ops[this.ops.length - 1].retain) {
      this.ops[this.ops.length - 1].retain += n
    } else {
      this.ops.push({ retain: n })
    }
    return this
  }

  insert(str) {
    // Insert string at current position
    if (str.length === 0) return this
    this.targetLength += str.length
    this.ops.push({ insert: str })
    return this
  }

  delete(n) {
    // Delete n characters
    if (n <= 0) return this
    this.baseLength += n
    this.ops.push({ delete: n })
    return this
  }

  apply(document) {
    // Apply operation to document string
    if (document.length !== this.baseLength) {
      throw new Error('Document length mismatch')
    }

    let result = ''
    let index = 0

    for (const op of this.ops) {
      if (op.retain) {
        result += document.slice(index, index + op.retain)
        index += op.retain
      } else if (op.insert) {
        result += op.insert
      } else if (op.delete) {
        index += op.delete  // Skip deleted characters
      }
    }

    return result
  }
}
```

### Transform Function

This is the heart of OT - transforming operations so they can be applied in either order:

```javascript
class OTTransformer {
  // Transform op1 against op2
  // Returns [op1', op2'] where:
  // apply(apply(doc, op1), op2') === apply(apply(doc, op2), op1')
  static transform(op1, op2) {
    const op1Prime = new TextOperation()
    const op2Prime = new TextOperation()

    let i1 = 0, i2 = 0
    let ops1 = [...op1.ops]
    let ops2 = [...op2.ops]

    while (i1 < ops1.length || i2 < ops2.length) {
      const o1 = ops1[i1]
      const o2 = ops2[i2]

      // Insert in op1 goes first (arbitrary but consistent choice)
      if (o1 && o1.insert !== undefined) {
        op1Prime.insert(o1.insert)
        op2Prime.retain(o1.insert.length)  // op2 must skip past insert
        i1++
        continue
      }

      // Insert in op2 goes first
      if (o2 && o2.insert !== undefined) {
        op1Prime.retain(o2.insert.length)  // op1 must skip past insert
        op2Prime.insert(o2.insert)
        i2++
        continue
      }

      if (!o1 || !o2) break

      // Both retain
      if (o1.retain && o2.retain) {
        const minLen = Math.min(o1.retain, o2.retain)
        op1Prime.retain(minLen)
        op2Prime.retain(minLen)
        this.advanceOp(ops1, i1, ops2, i2, minLen, 'retain')
        if (o1.retain <= o2.retain) i1++
        if (o2.retain <= o1.retain) i2++
        continue
      }

      // Both delete (same text - no output needed)
      if (o1.delete && o2.delete) {
        const minLen = Math.min(o1.delete, o2.delete)
        if (o1.delete <= o2.delete) i1++
        if (o2.delete <= o1.delete) i2++
        continue
      }

      // op1 deletes, op2 retains
      if (o1.delete && o2.retain) {
        const minLen = Math.min(o1.delete, o2.retain)
        op1Prime.delete(minLen)
        // op2Prime skips deleted text
        if (o1.delete <= o2.retain) i1++
        if (o2.retain <= o1.delete) i2++
        continue
      }

      // op1 retains, op2 deletes
      if (o1.retain && o2.delete) {
        const minLen = Math.min(o1.retain, o2.delete)
        // op1Prime skips deleted text
        op2Prime.delete(minLen)
        if (o1.retain <= o2.delete) i1++
        if (o2.delete <= o1.retain) i2++
      }
    }

    return [op1Prime, op2Prime]
  }
}
```

### Example Transform

```
Document: "Hello"
User A types "X" at position 1: retain(1), insert("X") -> "HXello"
User B types "Y" at position 3: retain(3), insert("Y") -> "HelYlo"

Without transform, applying both gives wrong results.

With transform:
- Transform A against B: retain(1), insert("X")  (no change, B's insert is after)
- Transform B against A: retain(4), insert("Y")  (skip A's inserted X)

Result after both: "HXelYlo"
```

## Deep Dive: Client-Server Sync Protocol (7 minutes)

### Client State Machine

The client maintains three states:
1. **Synchronized** - No pending changes, in sync with server
2. **Awaiting ACK** - Sent operation, waiting for server confirmation
3. **Awaiting with Buffer** - Sent operation + have new local changes

```javascript
class CollaborativeEditor {
  constructor() {
    this.serverVersion = 0
    this.inflightOp = null   // Operation sent, awaiting ack
    this.pendingOps = []     // Local operations not yet sent
  }

  onLocalChange(operation) {
    // Immediately apply locally
    this.applyToEditor(operation)

    // Buffer the operation
    if (this.pendingOps.length > 0) {
      // Compose with existing pending
      const last = this.pendingOps.pop()
      this.pendingOps.push(OTTransformer.compose(last, operation))
    } else {
      this.pendingOps.push(operation)
    }

    // Try to send
    this.flushPending()
  }

  flushPending() {
    if (this.inflightOp !== null || this.pendingOps.length === 0) {
      return  // Wait for ack or nothing to send
    }

    // Compose all pending into one
    let op = this.pendingOps[0]
    for (let i = 1; i < this.pendingOps.length; i++) {
      op = OTTransformer.compose(op, this.pendingOps[i])
    }

    this.inflightOp = op
    this.pendingOps = []

    // Send to server
    this.ws.send(JSON.stringify({
      type: 'operation',
      version: this.serverVersion,
      operation: op.toJSON()
    }))
  }

  onServerAck(message) {
    // Server confirmed our operation
    this.serverVersion = message.version
    this.inflightOp = null

    // Send next pending if any
    this.flushPending()
  }

  onRemoteOperation(message) {
    let op = TextOperation.fromJSON(message.operation)
    this.serverVersion = message.version

    // Transform against inflight operation
    if (this.inflightOp) {
      const [opPrime, inflightPrime] = OTTransformer.transform(op, this.inflightOp)
      op = opPrime
      this.inflightOp = inflightPrime
    }

    // Transform against all pending operations
    for (let i = 0; i < this.pendingOps.length; i++) {
      const [opPrime, pendingPrime] = OTTransformer.transform(op, this.pendingOps[i])
      op = opPrime
      this.pendingOps[i] = pendingPrime
    }

    // Apply transformed operation to editor
    this.applyToEditor(op)
  }
}
```

### Server-Side Document State

```javascript
class DocumentState {
  constructor(documentId) {
    this.documentId = documentId
    this.version = 0
    this.content = ''
    this.clients = new Map()  // clientId -> { socket, cursor }
  }

  async applyOperation(clientId, clientVersion, operation) {
    // Get operations since client's version
    const concurrent = await this.getOperationsSince(clientVersion)

    // Transform against all concurrent operations
    let transformedOp = operation
    for (const serverOp of concurrent) {
      const [transformed] = OTTransformer.transform(transformedOp, serverOp)
      transformedOp = transformed
    }

    // Apply to document
    this.content = transformedOp.apply(this.content)
    this.version++

    // Persist operation
    await db.query(`
      INSERT INTO operations (document_id, version, client_id, operation)
      VALUES ($1, $2, $3, $4)
    `, [this.documentId, this.version, clientId, transformedOp.toJSON()])

    // Periodic snapshots for fast loading
    if (this.version % 100 === 0) {
      await this.saveSnapshot()
    }

    return { version: this.version, operation: transformedOp }
  }
}
```

## Deep Dive: Presence and Cursors (5 minutes)

### Cursor Tracking

```javascript
class PresenceService {
  async updateCursor(documentId, clientId, position) {
    // Store in Redis for quick access
    await redis.hset(
      `doc:${documentId}:cursors`,
      clientId,
      JSON.stringify({
        position,
        timestamp: Date.now()
      })
    )

    // Broadcast to other clients
    this.broadcast(documentId, {
      type: 'cursor_update',
      clientId,
      position
    }, clientId)  // Exclude sender
  }

  async getAllCursors(documentId) {
    const cursors = await redis.hgetall(`doc:${documentId}:cursors`)

    return Object.entries(cursors).map(([clientId, data]) => ({
      clientId,
      ...JSON.parse(data)
    }))
  }
}
```

### Transform Cursor Position

When a remote operation arrives, we need to adjust cursor positions:

```javascript
transformCursor(cursor, operation) {
  let newPosition = cursor.position
  let index = 0

  for (const op of operation.ops) {
    if (op.retain) {
      index += op.retain
    } else if (op.insert) {
      if (index < cursor.position) {
        // Insert before cursor - shift cursor right
        newPosition += op.insert.length
      }
      index += op.insert.length
    } else if (op.delete) {
      if (index < cursor.position) {
        // Delete before cursor - shift cursor left
        const deleteEnd = index + op.delete
        if (deleteEnd <= cursor.position) {
          newPosition -= op.delete
        } else {
          // Cursor was in deleted text
          newPosition = index
        }
      }
    }
  }

  return newPosition
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. Operational Transformation vs CRDT

**Chose: Operational Transformation**
- Pro: Simpler to understand and implement
- Pro: More efficient for text (smaller operations)
- Pro: Well-established (Google Docs uses OT)
- Con: Requires central server for ordering
- Alternative: CRDT (works peer-to-peer but higher memory overhead)

### 2. WebSocket vs HTTP Long Polling

**Chose: WebSocket**
- Pro: True bidirectional communication
- Pro: Lower latency
- Pro: More efficient for high-frequency updates
- Con: More complex connection management
- Alternative: Long polling (simpler but higher latency)

### 3. Snapshot + Op Log vs Full Snapshots

**Chose: Snapshot + operation log**
- Pro: Fast loading (snapshot + recent ops)
- Pro: Full history preserved
- Pro: Storage efficient
- Con: Need to manage snapshot frequency
- Alternative: Full snapshot every save (simpler but loses history)

### 4. Server Authority vs Peer-to-Peer

**Chose: Server as authority**
- Pro: Single source of truth for ordering
- Pro: Simpler conflict resolution
- Pro: Easier to implement correctly
- Con: Server is bottleneck
- Alternative: P2P with CRDTs (more complex but no server dependency)

### Database Schema

```sql
-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  owner_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Document snapshots (periodic checkpoints)
CREATE TABLE document_snapshots (
  document_id UUID REFERENCES documents(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, version)
);

-- Operations log
CREATE TABLE operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id),
  version INTEGER NOT NULL,
  client_id VARCHAR(100),
  user_id UUID,
  operation JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (document_id, version)
);

CREATE INDEX idx_ops_doc_version ON operations(document_id, version);

-- Document access
CREATE TABLE document_access (
  document_id UUID REFERENCES documents(id),
  user_id UUID NOT NULL,
  permission VARCHAR(20) NOT NULL,  -- view, edit, admin
  PRIMARY KEY (document_id, user_id)
);
```

## Closing Summary (1 minute)

"The collaborative editor is built around three key concepts:

1. **Operational Transformation** - The transform function ensures that concurrent operations can be applied in any order while preserving user intent. The key insight is transforming each operation against all concurrent operations before applying it.

2. **Client state machine** - Clients track inflight and pending operations separately, transforming incoming remote operations against their local state. This enables optimistic local updates while maintaining consistency.

3. **Snapshot + op log** - By saving periodic snapshots and logging all operations, we get fast document loading plus complete history for undo, version comparison, and time travel.

The main trade-off is choosing OT over CRDTs. OT requires a central server for ordering but is more efficient for text editing. For a document editor where server availability is expected, this is the right trade-off."

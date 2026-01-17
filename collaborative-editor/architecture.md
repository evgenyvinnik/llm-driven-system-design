# Design Collaborative Editor - Architecture

## System Overview

A real-time collaborative document editor enabling multiple users to edit documents simultaneously with instant synchronization and conflict resolution. Core challenges involve maintaining consistency, handling concurrent edits, and providing offline support.

**Learning Goals:**
- Implement operational transformation or CRDTs
- Design real-time synchronization protocols
- Handle presence and cursor tracking
- Build offline-first editing experience

---

## Requirements

### Functional Requirements

1. **Edit**: Multiple users edit document simultaneously
2. **Sync**: Real-time updates across all clients
3. **History**: Track and navigate document versions
4. **Share**: Control document access and permissions
5. **Offline**: Edit without connectivity

### Non-Functional Requirements

- **Latency**: < 50ms for local changes to appear
- **Consistency**: All clients converge to same state
- **Scale**: Support 50+ simultaneous editors
- **Durability**: Never lose user edits

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Editor                                │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Rich Text    │  │  Operation    │  │   Sync        │       │
│  │  Editor       │  │  Transform    │  │   Engine      │       │
│  │               │  │               │  │               │       │
│  │ - ContentEdit │  │ - Local OT    │  │ - WebSocket   │       │
│  │ - Selection   │  │ - Apply ops   │  │ - Reconnect   │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │ WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Sync Server                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Connection   │  │  Document     │  │  Persistence  │       │
│  │  Manager      │  │  State        │  │  Layer        │       │
│  │               │  │               │  │               │       │
│  │ - Sessions    │  │ - OT server   │  │ - Snapshots   │       │
│  │ - Presence    │  │ - Operations  │  │ - Op log      │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  PostgreSQL   │    │    Redis      │    │  Object Store │
│               │    │               │    │               │
│ - Documents   │    │ - Active docs │    │ - Media       │
│ - Operations  │    │ - Presence    │    │ - Attachments │
│ - Versions    │    │ - Cursors     │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Core Components

### 1. Operation Types

**Text Operations:**
```javascript
// Operation types for text editing
const OperationType = {
  INSERT: 'insert',    // Insert text at position
  DELETE: 'delete',    // Delete text at position
  RETAIN: 'retain',    // Keep text unchanged (for positioning)
  FORMAT: 'format'     // Apply formatting to range
}

class TextOperation {
  constructor() {
    this.ops = []
    this.baseLength = 0
    this.targetLength = 0
  }

  retain(n) {
    if (n <= 0) return this
    this.baseLength += n
    this.targetLength += n

    if (this.ops.length > 0 && typeof this.ops[this.ops.length - 1].retain === 'number') {
      this.ops[this.ops.length - 1].retain += n
    } else {
      this.ops.push({ retain: n })
    }
    return this
  }

  insert(str, attributes = {}) {
    if (str.length === 0) return this
    this.targetLength += str.length

    const op = { insert: str }
    if (Object.keys(attributes).length > 0) {
      op.attributes = attributes
    }

    this.ops.push(op)
    return this
  }

  delete(n) {
    if (n <= 0) return this
    this.baseLength += n

    if (this.ops.length > 0 && typeof this.ops[this.ops.length - 1].delete === 'number') {
      this.ops[this.ops.length - 1].delete += n
    } else {
      this.ops.push({ delete: n })
    }
    return this
  }

  apply(str) {
    if (str.length !== this.baseLength) {
      throw new Error('Base length mismatch')
    }

    let result = ''
    let strIndex = 0

    for (const op of this.ops) {
      if (op.retain) {
        result += str.slice(strIndex, strIndex + op.retain)
        strIndex += op.retain
      } else if (op.insert) {
        result += op.insert
      } else if (op.delete) {
        strIndex += op.delete
      }
    }

    return result
  }
}
```

### 2. Operational Transformation

**Transform Function:**
```javascript
class OTTransformer {
  // Transform op1 against op2
  // Returns [op1', op2'] where applying op1 then op2' = applying op2 then op1'
  static transform(op1, op2) {
    const op1Prime = new TextOperation()
    const op2Prime = new TextOperation()

    let i1 = 0, i2 = 0
    let ops1 = [...op1.ops], ops2 = [...op2.ops]

    while (i1 < ops1.length || i2 < ops2.length) {
      const o1 = ops1[i1]
      const o2 = ops2[i2]

      // Insert in op1 goes before anything in op2
      if (o1 && o1.insert !== undefined) {
        op1Prime.insert(o1.insert, o1.attributes)
        op2Prime.retain(o1.insert.length)
        i1++
        continue
      }

      // Insert in op2 goes before anything in op1
      if (o2 && o2.insert !== undefined) {
        op1Prime.retain(o2.insert.length)
        op2Prime.insert(o2.insert, o2.attributes)
        i2++
        continue
      }

      if (!o1 && !o2) break

      // Both are retain or delete
      if (o1.retain !== undefined && o2.retain !== undefined) {
        const minLen = Math.min(o1.retain, o2.retain)
        op1Prime.retain(minLen)
        op2Prime.retain(minLen)

        if (o1.retain > o2.retain) {
          ops1[i1] = { retain: o1.retain - o2.retain }
          i2++
        } else if (o1.retain < o2.retain) {
          ops2[i2] = { retain: o2.retain - o1.retain }
          i1++
        } else {
          i1++
          i2++
        }
      } else if (o1.delete !== undefined && o2.delete !== undefined) {
        const minLen = Math.min(o1.delete, o2.delete)
        // Both delete same text, no output needed

        if (o1.delete > o2.delete) {
          ops1[i1] = { delete: o1.delete - o2.delete }
          i2++
        } else if (o1.delete < o2.delete) {
          ops2[i2] = { delete: o2.delete - o1.delete }
          i1++
        } else {
          i1++
          i2++
        }
      } else if (o1.delete !== undefined && o2.retain !== undefined) {
        const minLen = Math.min(o1.delete, o2.retain)
        op1Prime.delete(minLen)
        // op2' skips the deleted text

        if (o1.delete > o2.retain) {
          ops1[i1] = { delete: o1.delete - o2.retain }
          i2++
        } else if (o1.delete < o2.retain) {
          ops2[i2] = { retain: o2.retain - o1.delete }
          i1++
        } else {
          i1++
          i2++
        }
      } else if (o1.retain !== undefined && o2.delete !== undefined) {
        const minLen = Math.min(o1.retain, o2.delete)
        // op1' skips the deleted text
        op2Prime.delete(minLen)

        if (o1.retain > o2.delete) {
          ops1[i1] = { retain: o1.retain - o2.delete }
          i2++
        } else if (o1.retain < o2.delete) {
          ops2[i2] = { delete: o2.delete - o1.retain }
          i1++
        } else {
          i1++
          i2++
        }
      }
    }

    return [op1Prime, op2Prime]
  }

  // Compose two operations into one
  static compose(op1, op2) {
    if (op1.targetLength !== op2.baseLength) {
      throw new Error('Compose length mismatch')
    }

    const composed = new TextOperation()
    let i1 = 0, i2 = 0
    let ops1 = [...op1.ops], ops2 = [...op2.ops]

    while (i1 < ops1.length || i2 < ops2.length) {
      const o1 = ops1[i1]
      const o2 = ops2[i2]

      // Delete from op1
      if (o1 && o1.delete !== undefined) {
        composed.delete(o1.delete)
        i1++
        continue
      }

      // Insert from op2
      if (o2 && o2.insert !== undefined) {
        composed.insert(o2.insert, o2.attributes)
        i2++
        continue
      }

      // Handle remaining cases...
      // (Similar logic for retain + retain, insert + retain, etc.)
    }

    return composed
  }
}
```

### 3. Document State Manager

**Server-Side State:**
```javascript
class DocumentState {
  constructor(documentId) {
    this.documentId = documentId
    this.version = 0
    this.content = ''
    this.pendingOps = new Map() // clientId -> pending operations
    this.clients = new Map()     // clientId -> { cursor, presence }
  }

  async load() {
    // Load latest snapshot
    const snapshot = await db.query(`
      SELECT version, content FROM document_snapshots
      WHERE document_id = $1
      ORDER BY version DESC
      LIMIT 1
    `, [this.documentId])

    if (snapshot.rows.length > 0) {
      this.version = snapshot.rows[0].version
      this.content = snapshot.rows[0].content
    }

    // Apply any operations after snapshot
    const ops = await db.query(`
      SELECT * FROM operations
      WHERE document_id = $1 AND version > $2
      ORDER BY version
    `, [this.documentId, this.version])

    for (const row of ops.rows) {
      const op = TextOperation.fromJSON(row.operation)
      this.content = op.apply(this.content)
      this.version = row.version
    }
  }

  async applyOperation(clientId, clientVersion, operation) {
    // Transform operation against any concurrent ops
    let transformedOp = operation

    // Get all operations since client's version
    const concurrentOps = await db.query(`
      SELECT operation FROM operations
      WHERE document_id = $1 AND version > $2
      ORDER BY version
    `, [this.documentId, clientVersion])

    for (const row of concurrentOps.rows) {
      const serverOp = TextOperation.fromJSON(row.operation)
      const [transformed] = OTTransformer.transform(transformedOp, serverOp)
      transformedOp = transformed
    }

    // Apply transformed operation
    this.content = transformedOp.apply(this.content)
    this.version++

    // Persist operation
    await db.query(`
      INSERT INTO operations
        (document_id, version, client_id, operation, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [this.documentId, this.version, clientId, transformedOp.toJSON()])

    // Periodically save snapshots
    if (this.version % 100 === 0) {
      await this.saveSnapshot()
    }

    return {
      version: this.version,
      operation: transformedOp
    }
  }

  async saveSnapshot() {
    await db.query(`
      INSERT INTO document_snapshots
        (document_id, version, content, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [this.documentId, this.version, this.content])
  }
}
```

### 4. WebSocket Sync Server

**Real-Time Communication:**
```javascript
class SyncServer {
  constructor() {
    this.documents = new Map() // documentId -> DocumentState
    this.clients = new Map()   // ws -> { documentId, clientId }
  }

  async handleConnection(ws, documentId, userId) {
    const clientId = uuid()

    // Load or get document state
    if (!this.documents.has(documentId)) {
      const docState = new DocumentState(documentId)
      await docState.load()
      this.documents.set(documentId, docState)
    }

    const docState = this.documents.get(documentId)

    // Register client
    this.clients.set(ws, { documentId, clientId, userId })
    docState.clients.set(clientId, {
      userId,
      cursor: null,
      color: this.getClientColor(clientId)
    })

    // Send initial state
    ws.send(JSON.stringify({
      type: 'init',
      clientId,
      version: docState.version,
      content: docState.content,
      clients: Array.from(docState.clients.entries())
    }))

    // Broadcast join to others
    this.broadcast(documentId, {
      type: 'client_join',
      clientId,
      userId,
      color: docState.clients.get(clientId).color
    }, ws)

    ws.on('message', (data) => this.handleMessage(ws, data))
    ws.on('close', () => this.handleDisconnect(ws))
  }

  async handleMessage(ws, data) {
    const message = JSON.parse(data)
    const { documentId, clientId } = this.clients.get(ws)
    const docState = this.documents.get(documentId)

    switch (message.type) {
      case 'operation':
        await this.handleOperation(ws, docState, clientId, message)
        break

      case 'cursor':
        await this.handleCursor(ws, docState, clientId, message)
        break

      case 'selection':
        await this.handleSelection(ws, docState, clientId, message)
        break
    }
  }

  async handleOperation(ws, docState, clientId, message) {
    const { version, operation } = message

    try {
      // Apply operation with OT
      const result = await docState.applyOperation(
        clientId,
        version,
        TextOperation.fromJSON(operation)
      )

      // Acknowledge to sender
      ws.send(JSON.stringify({
        type: 'ack',
        version: result.version
      }))

      // Broadcast transformed operation to others
      this.broadcast(docState.documentId, {
        type: 'operation',
        clientId,
        version: result.version,
        operation: result.operation.toJSON()
      }, ws)

    } catch (error) {
      // Request client resync
      ws.send(JSON.stringify({
        type: 'resync',
        version: docState.version,
        content: docState.content
      }))
    }
  }

  async handleCursor(ws, docState, clientId, message) {
    // Update cursor position
    docState.clients.get(clientId).cursor = message.position

    // Broadcast to others
    this.broadcast(docState.documentId, {
      type: 'cursor',
      clientId,
      position: message.position
    }, ws)
  }

  broadcast(documentId, message, excludeWs = null) {
    for (const [ws, client] of this.clients.entries()) {
      if (client.documentId === documentId && ws !== excludeWs) {
        ws.send(JSON.stringify(message))
      }
    }
  }

  handleDisconnect(ws) {
    const client = this.clients.get(ws)
    if (!client) return

    const docState = this.documents.get(client.documentId)
    if (docState) {
      docState.clients.delete(client.clientId)

      // Broadcast leave
      this.broadcast(client.documentId, {
        type: 'client_leave',
        clientId: client.clientId
      })

      // Clean up empty document states
      if (docState.clients.size === 0) {
        this.documents.delete(client.documentId)
      }
    }

    this.clients.delete(ws)
  }
}
```

### 5. Client Editor

**Browser-Side Sync:**
```javascript
class CollaborativeEditor {
  constructor(editorElement, documentId, userId) {
    this.editor = editorElement
    this.documentId = documentId
    this.clientId = null
    this.serverVersion = 0
    this.pendingOps = []
    this.inflightOp = null

    this.connect()
  }

  connect() {
    this.ws = new WebSocket(`wss://api.example.com/doc/${this.documentId}`)

    this.ws.onopen = () => this.onConnect()
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data))
    this.ws.onclose = () => this.onDisconnect()
  }

  onConnect() {
    // Connection established, wait for init message
  }

  onMessage(message) {
    switch (message.type) {
      case 'init':
        this.handleInit(message)
        break

      case 'ack':
        this.handleAck(message)
        break

      case 'operation':
        this.handleRemoteOperation(message)
        break

      case 'cursor':
        this.handleRemoteCursor(message)
        break

      case 'client_join':
      case 'client_leave':
        this.handlePresence(message)
        break

      case 'resync':
        this.handleResync(message)
        break
    }
  }

  handleInit(message) {
    this.clientId = message.clientId
    this.serverVersion = message.version
    this.editor.setContent(message.content)
    this.updatePresence(message.clients)
  }

  handleAck(message) {
    // Server acknowledged our operation
    this.serverVersion = message.version
    this.inflightOp = null

    // Send next pending operation if any
    this.flushPending()
  }

  handleRemoteOperation(message) {
    let op = TextOperation.fromJSON(message.operation)
    this.serverVersion = message.version

    // Transform against pending operations
    if (this.inflightOp) {
      const [opPrime, inflightPrime] = OTTransformer.transform(op, this.inflightOp)
      op = opPrime
      this.inflightOp = inflightPrime
    }

    for (let i = 0; i < this.pendingOps.length; i++) {
      const [opPrime, pendingPrime] = OTTransformer.transform(op, this.pendingOps[i])
      op = opPrime
      this.pendingOps[i] = pendingPrime
    }

    // Apply to editor
    this.applyOperation(op)
  }

  onLocalChange(operation) {
    // Compose with pending if any
    if (this.pendingOps.length > 0) {
      const last = this.pendingOps.pop()
      const composed = OTTransformer.compose(last, operation)
      this.pendingOps.push(composed)
    } else {
      this.pendingOps.push(operation)
    }

    // Try to send
    this.flushPending()
  }

  flushPending() {
    if (this.inflightOp || this.pendingOps.length === 0) {
      return // Wait for ack or nothing to send
    }

    // Compose all pending into one
    let op = this.pendingOps[0]
    for (let i = 1; i < this.pendingOps.length; i++) {
      op = OTTransformer.compose(op, this.pendingOps[i])
    }

    this.inflightOp = op
    this.pendingOps = []

    this.ws.send(JSON.stringify({
      type: 'operation',
      version: this.serverVersion,
      operation: op.toJSON()
    }))
  }

  applyOperation(op) {
    // Apply to editor without triggering onLocalChange
    this.editor.applyOperation(op)
  }

  handleRemoteCursor(message) {
    this.renderRemoteCursor(message.clientId, message.position)
  }

  updateCursor(position) {
    this.ws.send(JSON.stringify({
      type: 'cursor',
      position
    }))
  }
}
```

### 6. Version History

**Document Versioning:**
```javascript
class VersionHistory {
  async getVersions(documentId, limit = 50) {
    const versions = await db.query(`
      SELECT
        ds.version,
        ds.created_at,
        u.name as author,
        LENGTH(ds.content) as size
      FROM document_snapshots ds
      LEFT JOIN operations o ON o.document_id = ds.document_id
        AND o.version = ds.version
      LEFT JOIN users u ON u.id = o.user_id
      WHERE ds.document_id = $1
      ORDER BY ds.version DESC
      LIMIT $2
    `, [documentId, limit])

    return versions.rows
  }

  async getVersion(documentId, version) {
    // Find closest snapshot at or before version
    const snapshot = await db.query(`
      SELECT version, content FROM document_snapshots
      WHERE document_id = $1 AND version <= $2
      ORDER BY version DESC
      LIMIT 1
    `, [documentId, version])

    if (snapshot.rows.length === 0) {
      throw new Error('Version not found')
    }

    let content = snapshot.rows[0].content
    let currentVersion = snapshot.rows[0].version

    // Apply operations to reach target version
    if (currentVersion < version) {
      const ops = await db.query(`
        SELECT operation FROM operations
        WHERE document_id = $1
          AND version > $2
          AND version <= $3
        ORDER BY version
      `, [documentId, currentVersion, version])

      for (const row of ops.rows) {
        const op = TextOperation.fromJSON(row.operation)
        content = op.apply(content)
      }
    }

    return { version, content }
  }

  async restoreVersion(documentId, version, userId) {
    // Get the historical content
    const historical = await this.getVersion(documentId, version)

    // Create operation to transform current to historical
    const current = await this.getVersion(documentId, null) // latest
    const restoreOp = this.createRestoreOperation(
      current.content,
      historical.content
    )

    // Apply as a new operation
    const docState = await this.getDocumentState(documentId)
    await docState.applyOperation(userId, current.version, restoreOp)

    return { success: true, newVersion: docState.version }
  }

  createRestoreOperation(current, target) {
    // Simple diff: delete all, insert all
    // (In practice, use diff algorithm for efficiency)
    const op = new TextOperation()
    if (current.length > 0) {
      op.delete(current.length)
    }
    if (target.length > 0) {
      op.insert(target)
    }
    return op
  }
}
```

---

## Database Schema

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

CREATE INDEX idx_operations_doc_version ON operations(document_id, version);

-- Document access
CREATE TABLE document_access (
  document_id UUID REFERENCES documents(id),
  user_id UUID NOT NULL,
  permission VARCHAR(20) NOT NULL, -- view, edit, admin
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);

-- Comments
CREATE TABLE document_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id),
  user_id UUID NOT NULL,
  range_start INTEGER,
  range_end INTEGER,
  content TEXT NOT NULL,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_doc ON document_comments(document_id);
```

---

## Key Design Decisions

### 1. OT over CRDT

**Decision**: Use Operational Transformation

**Rationale**:
- Simpler to understand and implement
- More efficient for text editing
- Well-established in production systems
- CRDTs have higher memory overhead

### 2. Snapshot + Op Log

**Decision**: Periodic snapshots with operation log

**Rationale**:
- Fast document loading from snapshots
- Complete history from op log
- Storage efficient

### 3. Server Authority

**Decision**: Server is source of truth for ordering

**Rationale**:
- Simpler conflict resolution
- Guaranteed consistency
- Easier to reason about

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sync algorithm | OT | CRDT | Simplicity, efficiency |
| Transport | WebSocket | HTTP polling | Low latency |
| Storage | Snapshot + ops | Full snapshots | Storage efficiency |
| Authority | Server | Peer-to-peer | Consistency |

---

## Async Queue/Stream Architecture

For a local development learning project, RabbitMQ provides the right balance of simplicity and capability for async processing, fanout, and backpressure management.

### Queue Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                     RabbitMQ Exchanges                               │
│                                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  doc.operations  │  │  doc.presence    │  │  doc.snapshots   │  │
│  │  (topic)         │  │  (fanout)        │  │  (direct)        │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                     │             │
│  ┌────────▼─────────┐  ┌────────▼─────────┐  ┌────────▼─────────┐  │
│  │ op.broadcast.{id}│  │ presence.fanout  │  │ snapshot.worker  │  │
│  │ (per-doc queues) │  │ (all servers)    │  │ (single queue)   │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Use Cases

**1. Operation Broadcast (Multi-Server Fanout)**

When running multiple sync servers locally (ports 3001, 3002, 3003), operations applied on one server must reach clients on other servers.

```javascript
// Publisher: After applying operation on sync server
async function broadcastOperation(documentId, operation, version) {
  const channel = await rabbitConnection.createChannel()

  await channel.publish(
    'doc.operations',
    `doc.${documentId}`,
    Buffer.from(JSON.stringify({
      documentId,
      version,
      operation: operation.toJSON(),
      timestamp: Date.now(),
      serverId: process.env.SERVER_ID // e.g., 'server1'
    })),
    {
      persistent: true,        // Survive RabbitMQ restarts
      messageId: `${documentId}-${version}`,  // Idempotency key
      contentType: 'application/json'
    }
  )
}

// Consumer: Each sync server listens for operations from other servers
async function subscribeToOperations() {
  const channel = await rabbitConnection.createChannel()

  // Each server gets its own queue bound to the topic exchange
  const queueName = `op.broadcast.${process.env.SERVER_ID}`
  await channel.assertQueue(queueName, { durable: true })
  await channel.bindQueue(queueName, 'doc.operations', 'doc.*')

  // Prefetch limits concurrent processing (backpressure)
  await channel.prefetch(10)

  channel.consume(queueName, async (msg) => {
    const data = JSON.parse(msg.content.toString())

    // Skip operations from self
    if (data.serverId === process.env.SERVER_ID) {
      channel.ack(msg)
      return
    }

    // Deduplicate by messageId
    const seen = await redis.get(`seen:${msg.properties.messageId}`)
    if (seen) {
      channel.ack(msg)
      return
    }

    try {
      // Broadcast to local WebSocket clients
      const docState = documents.get(data.documentId)
      if (docState) {
        broadcastToLocalClients(data.documentId, {
          type: 'operation',
          version: data.version,
          operation: data.operation
        })
      }

      await redis.setex(`seen:${msg.properties.messageId}`, 3600, '1')
      channel.ack(msg)
    } catch (error) {
      // Requeue on failure (up to 3 times via dead letter)
      channel.nack(msg, false, msg.fields.redelivered ? false : true)
    }
  })
}
```

**2. Snapshot Worker (Background Jobs)**

Snapshots are computationally expensive and should not block the sync path.

```javascript
// Producer: Queue snapshot request after N operations
async function queueSnapshot(documentId, version, content) {
  const channel = await rabbitConnection.createChannel()

  await channel.sendToQueue(
    'snapshot.worker',
    Buffer.from(JSON.stringify({
      documentId,
      version,
      content,
      requestedAt: Date.now()
    })),
    {
      persistent: true,
      messageId: `snapshot-${documentId}-${version}`
    }
  )
}

// Consumer: Single worker processes snapshots sequentially
async function processSnapshots() {
  const channel = await rabbitConnection.createChannel()

  await channel.assertQueue('snapshot.worker', {
    durable: true,
    deadLetterExchange: 'doc.dlx',
    deadLetterRoutingKey: 'snapshot.failed'
  })

  // Process one at a time to avoid database contention
  await channel.prefetch(1)

  channel.consume('snapshot.worker', async (msg) => {
    const data = JSON.parse(msg.content.toString())

    try {
      // Check if snapshot already exists (idempotency)
      const existing = await db.query(
        'SELECT 1 FROM document_snapshots WHERE document_id = $1 AND version = $2',
        [data.documentId, data.version]
      )

      if (existing.rows.length === 0) {
        await db.query(
          'INSERT INTO document_snapshots (document_id, version, content, created_at) VALUES ($1, $2, $3, NOW())',
          [data.documentId, data.version, data.content]
        )
      }

      channel.ack(msg)
    } catch (error) {
      console.error('Snapshot failed:', error)
      channel.nack(msg, false, false) // Send to DLX
    }
  })
}
```

**3. Dead Letter Queue (Failed Message Handling)**

```javascript
// Setup dead letter exchange and queue
async function setupDeadLetters() {
  const channel = await rabbitConnection.createChannel()

  await channel.assertExchange('doc.dlx', 'direct', { durable: true })
  await channel.assertQueue('doc.failed', { durable: true })
  await channel.bindQueue('doc.failed', 'doc.dlx', 'snapshot.failed')
  await channel.bindQueue('doc.failed', 'doc.dlx', 'operation.failed')

  // Alert on DLQ growth
  channel.consume('doc.failed', async (msg) => {
    console.error('Dead letter received:', {
      routingKey: msg.fields.routingKey,
      content: msg.content.toString(),
      originalQueue: msg.properties.headers['x-first-death-queue']
    })

    // Store for manual inspection/retry
    await db.query(
      'INSERT INTO failed_messages (routing_key, content, headers, created_at) VALUES ($1, $2, $3, NOW())',
      [msg.fields.routingKey, msg.content.toString(), JSON.stringify(msg.properties.headers)]
    )

    channel.ack(msg)
  })
}
```

### Delivery Semantics

| Queue | Delivery | Rationale |
|-------|----------|-----------|
| `op.broadcast.*` | At-least-once | Deduplicated by messageId in Redis; operations are idempotent when applied at same version |
| `snapshot.worker` | At-least-once | Idempotent insert with version check; duplicate writes are harmless |
| `doc.failed` (DLQ) | At-most-once | Manual inspection; no automatic retry |

### Backpressure Configuration

```javascript
// Connection-level flow control
const connection = await amqp.connect('amqp://localhost', {
  heartbeat: 30,
  channelMax: 10  // Limit concurrent channels
})

// Per-channel prefetch (consumer-side backpressure)
channel.prefetch(10)  // Max 10 unacked messages per consumer

// Publisher confirms (producer-side backpressure)
await channel.confirmSelect()
channel.publish(exchange, routingKey, content, options, (err) => {
  if (err) {
    // Message not confirmed; retry or buffer
    pendingPublishes.push({ exchange, routingKey, content, options })
  }
})
```

### Local Development Setup

```bash
# docker-compose.yml addition
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"   # AMQP
      - "15672:15672" # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest

# Or via Homebrew
brew install rabbitmq
brew services start rabbitmq
# Management UI: http://localhost:15672 (guest/guest)
```

---

## Observability

### Metrics (Prometheus)

**Key Metrics to Track:**

```javascript
const promClient = require('prom-client')

// Connection metrics
const wsConnectionsGauge = new promClient.Gauge({
  name: 'collab_ws_connections_total',
  help: 'Number of active WebSocket connections',
  labelNames: ['server_id']
})

const wsConnectionDuration = new promClient.Histogram({
  name: 'collab_ws_connection_duration_seconds',
  help: 'Duration of WebSocket connections',
  labelNames: ['server_id'],
  buckets: [60, 300, 900, 1800, 3600] // 1min to 1hr
})

// Operation metrics
const operationCounter = new promClient.Counter({
  name: 'collab_operations_total',
  help: 'Total operations processed',
  labelNames: ['server_id', 'status'] // success, transform_error, apply_error
})

const operationLatency = new promClient.Histogram({
  name: 'collab_operation_latency_ms',
  help: 'Time from operation received to ack sent',
  labelNames: ['server_id'],
  buckets: [5, 10, 25, 50, 100, 250, 500]
})

const transformLatency = new promClient.Histogram({
  name: 'collab_transform_latency_ms',
  help: 'Time spent in OT transform',
  labelNames: ['server_id', 'concurrent_ops'],
  buckets: [1, 2, 5, 10, 25, 50]
})

// Document metrics
const activeDocumentsGauge = new promClient.Gauge({
  name: 'collab_active_documents',
  help: 'Number of documents with active editors',
  labelNames: ['server_id']
})

const documentVersionGauge = new promClient.Gauge({
  name: 'collab_document_version',
  help: 'Current version of active documents',
  labelNames: ['document_id']
})

// Queue metrics
const queueDepthGauge = new promClient.Gauge({
  name: 'collab_queue_depth',
  help: 'Number of messages in RabbitMQ queues',
  labelNames: ['queue_name']
})

const queuePublishLatency = new promClient.Histogram({
  name: 'collab_queue_publish_latency_ms',
  help: 'Time to publish message to RabbitMQ',
  buckets: [1, 5, 10, 25, 50, 100]
})

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType)
  res.end(await promClient.register.metrics())
})
```

### Structured Logging

```javascript
const pino = require('pino')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'collab-editor',
    server_id: process.env.SERVER_ID,
    version: process.env.APP_VERSION
  }
})

// Request logging
function logOperation(documentId, clientId, operation, result) {
  logger.info({
    event: 'operation_applied',
    document_id: documentId,
    client_id: clientId,
    operation_type: operation.ops[0]?.insert ? 'insert' : 'delete',
    operation_size: JSON.stringify(operation).length,
    base_version: operation.baseVersion,
    result_version: result.version,
    transform_count: result.transformCount,
    latency_ms: result.latencyMs
  })
}

// Error logging
function logError(context, error) {
  logger.error({
    event: 'error',
    context,
    error_type: error.constructor.name,
    error_message: error.message,
    stack: error.stack
  })
}

// Connection logging
function logConnection(event, clientId, documentId, userId) {
  logger.info({
    event: `ws_${event}`, // ws_connect, ws_disconnect
    client_id: clientId,
    document_id: documentId,
    user_id: userId
  })
}
```

### Distributed Tracing (OpenTelemetry)

```javascript
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')

// Initialize tracer
const provider = new NodeTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(
  new JaegerExporter({ endpoint: 'http://localhost:14268/api/traces' })
))
provider.register()

const tracer = provider.getTracer('collab-editor')

// Trace operation flow
async function handleOperationWithTracing(ws, docState, clientId, message) {
  const span = tracer.startSpan('handle_operation', {
    attributes: {
      'document.id': docState.documentId,
      'client.id': clientId,
      'operation.version': message.version
    }
  })

  try {
    const transformSpan = tracer.startSpan('transform_operation', { parent: span })
    const transformed = await transformOperation(message.operation, docState)
    transformSpan.setAttribute('transform.count', transformed.transformCount)
    transformSpan.end()

    const applySpan = tracer.startSpan('apply_operation', { parent: span })
    const result = await docState.applyOperation(clientId, message.version, transformed.op)
    applySpan.end()

    const broadcastSpan = tracer.startSpan('broadcast_operation', { parent: span })
    await broadcastOperation(docState.documentId, result.operation, result.version)
    broadcastSpan.end()

    span.setStatus({ code: 0 }) // OK
  } catch (error) {
    span.setStatus({ code: 2, message: error.message }) // ERROR
    span.recordException(error)
    throw error
  } finally {
    span.end()
  }
}
```

### SLI Dashboard (Grafana)

**Dashboard Panels:**

| Panel | Query (PromQL) | Purpose |
|-------|----------------|---------|
| Operation Latency p95 | `histogram_quantile(0.95, rate(collab_operation_latency_ms_bucket[5m]))` | Track user-perceived latency |
| Operations/sec | `rate(collab_operations_total[1m])` | System throughput |
| Error Rate | `rate(collab_operations_total{status!="success"}[5m]) / rate(collab_operations_total[5m])` | Reliability |
| Active Connections | `sum(collab_ws_connections_total)` | Load indicator |
| Queue Depth | `collab_queue_depth{queue_name="op.broadcast.*"}` | Backlog detection |
| Transform Time | `histogram_quantile(0.99, rate(collab_transform_latency_ms_bucket[5m]))` | OT performance |

**SLI Targets (for learning/reference):**

| SLI | Target | Measurement |
|-----|--------|-------------|
| Operation Latency | p95 < 50ms | From operation received to ack sent |
| Availability | 99.9% | Successful operations / total attempts |
| Sync Lag | < 100ms | Time for operation to reach all clients |
| Recovery Time | < 30s | Time to reconnect and resync after disconnect |

### Alert Thresholds

```yaml
# alerts.yml (Prometheus Alertmanager format)
groups:
  - name: collab-editor
    rules:
      - alert: HighOperationLatency
        expr: histogram_quantile(0.95, rate(collab_operation_latency_ms_bucket[5m])) > 100
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Operation latency exceeds 100ms at p95"

      - alert: HighErrorRate
        expr: rate(collab_operations_total{status!="success"}[5m]) / rate(collab_operations_total[5m]) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error rate exceeds 1%"

      - alert: QueueBacklog
        expr: collab_queue_depth > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "RabbitMQ queue depth exceeds 1000 messages"

      - alert: NoConnections
        expr: sum(collab_ws_connections_total) == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "No WebSocket connections - service may be down"

      - alert: TransformSlowdown
        expr: histogram_quantile(0.99, rate(collab_transform_latency_ms_bucket[5m])) > 25
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "OT transform taking >25ms at p99"
```

### Audit Logging

```javascript
// Audit log for security and compliance events
async function auditLog(event) {
  await db.query(`
    INSERT INTO audit_log (
      event_type, user_id, document_id, action, details, ip_address, user_agent, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
  `, [
    event.type,
    event.userId,
    event.documentId,
    event.action,
    JSON.stringify(event.details),
    event.ipAddress,
    event.userAgent
  ])
}

// Audit events to log
const AuditEvents = {
  DOCUMENT_CREATE: 'document.create',
  DOCUMENT_DELETE: 'document.delete',
  DOCUMENT_SHARE: 'document.share',
  DOCUMENT_UNSHARE: 'document.unshare',
  PERMISSION_CHANGE: 'permission.change',
  VERSION_RESTORE: 'version.restore',
  EXPORT: 'document.export',
  ACCESS_DENIED: 'access.denied'
}

// Example usage
async function shareDocument(documentId, targetUserId, permission, requestingUser, req) {
  await db.query(
    'INSERT INTO document_access (document_id, user_id, permission) VALUES ($1, $2, $3)',
    [documentId, targetUserId, permission]
  )

  await auditLog({
    type: AuditEvents.DOCUMENT_SHARE,
    userId: requestingUser.id,
    documentId,
    action: 'share',
    details: { targetUserId, permission },
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  })
}

// Audit log schema
// CREATE TABLE audit_log (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   event_type VARCHAR(50) NOT NULL,
//   user_id UUID,
//   document_id UUID,
//   action VARCHAR(50) NOT NULL,
//   details JSONB,
//   ip_address INET,
//   user_agent TEXT,
//   created_at TIMESTAMP DEFAULT NOW()
// );
// CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
// CREATE INDEX idx_audit_document ON audit_log(document_id, created_at);
// CREATE INDEX idx_audit_type ON audit_log(event_type, created_at);
```

### Local Development Setup

```bash
# docker-compose.yml additions
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686" # UI
      - "14268:14268" # Collector

# prometheus.yml
scrape_configs:
  - job_name: 'collab-editor'
    static_configs:
      - targets: ['host.docker.internal:3001', 'host.docker.internal:3002', 'host.docker.internal:3003']
```

---

## Failure Handling

### Retry Strategy with Idempotency Keys

**Client-Side Retries:**

```javascript
class ResilientSyncClient {
  constructor() {
    this.pendingOperations = new Map() // operationId -> { op, attempts, lastAttempt }
    this.maxRetries = 3
    this.baseDelayMs = 100
  }

  async sendOperation(operation) {
    // Generate idempotency key from content hash + timestamp
    const operationId = this.generateOperationId(operation)

    // Check if already pending
    if (this.pendingOperations.has(operationId)) {
      return // Already being sent
    }

    this.pendingOperations.set(operationId, {
      op: operation,
      attempts: 0,
      lastAttempt: null
    })

    await this.attemptSend(operationId)
  }

  async attemptSend(operationId) {
    const pending = this.pendingOperations.get(operationId)
    if (!pending) return

    pending.attempts++
    pending.lastAttempt = Date.now()

    try {
      this.ws.send(JSON.stringify({
        type: 'operation',
        operationId, // Server uses this for deduplication
        version: this.serverVersion,
        operation: pending.op.toJSON()
      }))

      // Set timeout for ack
      setTimeout(() => {
        if (this.pendingOperations.has(operationId)) {
          this.handleNoAck(operationId)
        }
      }, 5000)

    } catch (error) {
      this.handleSendError(operationId, error)
    }
  }

  handleAck(message) {
    this.pendingOperations.delete(message.operationId)
    this.serverVersion = message.version
  }

  handleNoAck(operationId) {
    const pending = this.pendingOperations.get(operationId)
    if (!pending) return

    if (pending.attempts < this.maxRetries) {
      // Exponential backoff with jitter
      const delay = this.baseDelayMs * Math.pow(2, pending.attempts) * (0.5 + Math.random())
      setTimeout(() => this.attemptSend(operationId), delay)
    } else {
      // Max retries exceeded; request resync
      this.requestResync()
      this.pendingOperations.delete(operationId)
    }
  }

  generateOperationId(operation) {
    // Hash of operation content + client ID + local timestamp
    const content = JSON.stringify(operation.toJSON())
    return `${this.clientId}-${Date.now()}-${this.hashCode(content)}`
  }

  hashCode(str) {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i)
      hash = hash & hash
    }
    return Math.abs(hash).toString(36)
  }
}
```

**Server-Side Idempotency:**

```javascript
class IdempotentOperationHandler {
  constructor(redis) {
    this.redis = redis
    this.ttlSeconds = 3600 // 1 hour
  }

  async processOperation(clientId, operationId, version, operation) {
    const cacheKey = `op:${operationId}`

    // Check if already processed
    const existing = await this.redis.get(cacheKey)
    if (existing) {
      const cached = JSON.parse(existing)
      return {
        status: 'duplicate',
        version: cached.version,
        operation: cached.operation
      }
    }

    // Process operation
    const result = await this.applyOperation(clientId, version, operation)

    // Cache result for deduplication
    await this.redis.setex(cacheKey, this.ttlSeconds, JSON.stringify({
      version: result.version,
      operation: result.operation.toJSON()
    }))

    return {
      status: 'processed',
      version: result.version,
      operation: result.operation
    }
  }
}
```

### Circuit Breaker Pattern

```javascript
const CircuitBreaker = require('opossum')

// Database circuit breaker
const dbCircuit = new CircuitBreaker(async (query, params) => {
  return await db.query(query, params)
}, {
  timeout: 3000,        // 3s timeout per query
  errorThresholdPercentage: 50,  // Open after 50% failures
  resetTimeout: 30000,  // Try again after 30s
  volumeThreshold: 5    // Minimum 5 requests before tripping
})

dbCircuit.on('open', () => {
  logger.warn({ event: 'circuit_open', service: 'database' })
  // Switch to degraded mode: queue operations, serve from cache
})

dbCircuit.on('halfOpen', () => {
  logger.info({ event: 'circuit_half_open', service: 'database' })
})

dbCircuit.on('close', () => {
  logger.info({ event: 'circuit_close', service: 'database' })
  // Resume normal operation, drain queued operations
})

// Redis circuit breaker
const redisCircuit = new CircuitBreaker(async (command, ...args) => {
  return await redis[command](...args)
}, {
  timeout: 1000,
  errorThresholdPercentage: 50,
  resetTimeout: 10000,
  volumeThreshold: 10
})

// RabbitMQ circuit breaker
const rabbitCircuit = new CircuitBreaker(async (exchange, routingKey, content, options) => {
  return await channel.publish(exchange, routingKey, content, options)
}, {
  timeout: 2000,
  errorThresholdPercentage: 50,
  resetTimeout: 15000,
  volumeThreshold: 5
})

// Fallback behavior when circuit is open
rabbitCircuit.fallback((exchange, routingKey, content, options) => {
  // Buffer to local file or in-memory queue
  pendingPublishes.push({ exchange, routingKey, content, options })
  logger.warn({ event: 'rabbit_fallback', queue_size: pendingPublishes.length })
  return { fallback: true }
})

// Usage in operation handler
async function handleOperation(ws, docState, clientId, message) {
  try {
    // Use circuit breaker for database operations
    const result = await dbCircuit.fire(
      'SELECT operation FROM operations WHERE document_id = $1 AND version > $2',
      [docState.documentId, message.version]
    )

    // ... apply operation ...

    // Use circuit breaker for broadcast
    await rabbitCircuit.fire(
      'doc.operations',
      `doc.${docState.documentId}`,
      Buffer.from(JSON.stringify(result)),
      { persistent: true }
    )

  } catch (error) {
    if (error.message === 'Breaker is open') {
      // Degraded mode response
      ws.send(JSON.stringify({
        type: 'degraded',
        message: 'Service temporarily unavailable, your changes are buffered'
      }))
    } else {
      throw error
    }
  }
}
```

### Multi-Region DR (Conceptual for Learning)

For a local development project, we simulate multi-region by running services on different ports. The concepts translate directly to cloud deployment.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Local Simulation of Multi-Region                                    │
│                                                                      │
│  "Region A" (Primary)          "Region B" (Secondary)               │
│  ┌─────────────────────┐       ┌─────────────────────┐             │
│  │ Sync Server :3001   │       │ Sync Server :3002   │             │
│  │ PostgreSQL :5432    │◄─────►│ PostgreSQL :5433    │             │
│  │ Redis :6379         │       │ Redis :6380         │             │
│  │ RabbitMQ :5672      │◄─────►│ RabbitMQ :5673      │             │
│  └─────────────────────┘       └─────────────────────┘             │
│           │                            │                            │
│           └────────────┬───────────────┘                            │
│                        ▼                                            │
│              Async Replication via                                  │
│              RabbitMQ Federation                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Replication Strategy:**

```javascript
// PostgreSQL logical replication (for learning/reference)
// In production: use managed replication (RDS Multi-AZ, etc.)

// Write to primary, read from local replica
class MultiRegionDB {
  constructor(primaryPool, replicaPool) {
    this.primary = primaryPool
    this.replica = replicaPool
  }

  async write(query, params) {
    // Always write to primary
    return await this.primary.query(query, params)
  }

  async read(query, params) {
    // Read from local replica for lower latency
    // Accept eventual consistency (typically < 100ms lag)
    try {
      return await this.replica.query(query, params)
    } catch (error) {
      // Fallback to primary if replica unavailable
      return await this.primary.query(query, params)
    }
  }
}

// Failover detection and handling
class FailoverManager {
  constructor() {
    this.primaryHealthy = true
    this.failoverInProgress = false
  }

  async healthCheck() {
    try {
      await db.primary.query('SELECT 1')
      this.primaryHealthy = true
    } catch (error) {
      this.primaryHealthy = false
      if (!this.failoverInProgress) {
        await this.initiateFailover()
      }
    }
  }

  async initiateFailover() {
    this.failoverInProgress = true
    logger.warn({ event: 'failover_initiated' })

    // 1. Promote replica to primary
    // 2. Update connection strings
    // 3. Notify clients to reconnect

    // In local dev, this is manual; in production, use managed failover
    this.failoverInProgress = false
  }
}

// Run health check every 5 seconds
setInterval(() => failoverManager.healthCheck(), 5000)
```

**RPC for Cross-Region Coordination:**

```javascript
// When a client connects to Region B but document state is in Region A
async function getDocumentState(documentId) {
  const localState = documents.get(documentId)
  if (localState) return localState

  // Check if document is active in another region via RabbitMQ RPC
  const response = await rpcClient.call('doc.locate', { documentId })

  if (response.found) {
    // Fetch state from owning region
    const state = await rpcClient.call(`region.${response.region}.doc.state`, { documentId })
    return state
  }

  // Document not active anywhere; load from database
  return await loadDocumentFromDB(documentId)
}
```

### Backup and Restore Testing

**Backup Strategy:**

```javascript
// Automated backup script (run as cron job or background worker)
async function performBackup() {
  const backupId = `backup-${Date.now()}`
  const backupPath = `/backups/${backupId}`

  logger.info({ event: 'backup_started', backup_id: backupId })

  try {
    // 1. PostgreSQL backup
    await exec(`pg_dump -h localhost -U postgres collab_editor | gzip > ${backupPath}/postgres.sql.gz`)

    // 2. Redis snapshot
    await redis.bgsave()
    await exec(`cp /var/lib/redis/dump.rdb ${backupPath}/redis.rdb`)

    // 3. Verify backup integrity
    await verifyBackup(backupPath)

    // 4. Upload to object storage (MinIO in local dev)
    await minio.fPutObject('backups', backupId, `${backupPath}.tar.gz`)

    // 5. Record backup metadata
    await db.query(
      'INSERT INTO backup_log (id, path, size_bytes, verified, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [backupId, backupPath, await getBackupSize(backupPath), true]
    )

    logger.info({ event: 'backup_completed', backup_id: backupId })

  } catch (error) {
    logger.error({ event: 'backup_failed', backup_id: backupId, error: error.message })
    throw error
  }
}

async function verifyBackup(backupPath) {
  // Test PostgreSQL restore to temp database
  await exec(`createdb collab_editor_verify`)
  await exec(`gunzip -c ${backupPath}/postgres.sql.gz | psql collab_editor_verify`)

  // Verify row counts match
  const originalCount = await db.query('SELECT COUNT(*) FROM documents')
  const verifyCount = await verifyDb.query('SELECT COUNT(*) FROM documents')

  if (originalCount.rows[0].count !== verifyCount.rows[0].count) {
    throw new Error('Backup verification failed: row count mismatch')
  }

  await exec(`dropdb collab_editor_verify`)
}
```

**Restore Procedure:**

```javascript
// Restore script (manual execution with safeguards)
async function performRestore(backupId) {
  const backupPath = `/backups/${backupId}`

  logger.warn({ event: 'restore_started', backup_id: backupId })

  // 1. Safety checks
  const confirmation = await prompt(`This will overwrite current data. Type '${backupId}' to confirm: `)
  if (confirmation !== backupId) {
    throw new Error('Restore cancelled: confirmation mismatch')
  }

  // 2. Stop sync servers (drain connections gracefully)
  await stopSyncServers()

  // 3. Download backup from object storage
  await minio.fGetObject('backups', backupId, `${backupPath}.tar.gz`)
  await exec(`tar -xzf ${backupPath}.tar.gz -C ${backupPath}`)

  // 4. Restore PostgreSQL
  await exec(`dropdb collab_editor && createdb collab_editor`)
  await exec(`gunzip -c ${backupPath}/postgres.sql.gz | psql collab_editor`)

  // 5. Restore Redis
  await redis.shutdown('NOSAVE')
  await exec(`cp ${backupPath}/redis.rdb /var/lib/redis/dump.rdb`)
  await exec(`redis-server --daemonize yes`)

  // 6. Restart sync servers
  await startSyncServers()

  // 7. Verify service health
  await healthCheck()

  logger.info({ event: 'restore_completed', backup_id: backupId })
}
```

**Backup Testing Schedule:**

```javascript
// Monthly restore drill (automated in CI/CD or scheduled task)
async function runRestoreDrill() {
  const testEnv = 'collab_editor_drill'

  // 1. Get latest backup
  const latestBackup = await db.query(
    'SELECT id FROM backup_log WHERE verified = true ORDER BY created_at DESC LIMIT 1'
  )

  // 2. Restore to isolated test database
  await exec(`createdb ${testEnv}`)
  await restoreToDatabase(latestBackup.rows[0].id, testEnv)

  // 3. Run integration tests against restored data
  const testResults = await runIntegrationTests(testEnv)

  // 4. Measure RTO (Recovery Time Objective)
  const rto = Date.now() - drillStartTime

  // 5. Report results
  await db.query(
    'INSERT INTO restore_drills (backup_id, rto_ms, tests_passed, created_at) VALUES ($1, $2, $3, NOW())',
    [latestBackup.rows[0].id, rto, testResults.passed]
  )

  // 6. Cleanup
  await exec(`dropdb ${testEnv}`)

  if (!testResults.passed) {
    logger.error({ event: 'restore_drill_failed', backup_id: latestBackup.rows[0].id })
    // Alert on-call
  }
}

// Backup log schema
// CREATE TABLE backup_log (
//   id VARCHAR(100) PRIMARY KEY,
//   path TEXT NOT NULL,
//   size_bytes BIGINT,
//   verified BOOLEAN DEFAULT false,
//   created_at TIMESTAMP DEFAULT NOW()
// );

// CREATE TABLE restore_drills (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   backup_id VARCHAR(100) REFERENCES backup_log(id),
//   rto_ms INTEGER,
//   tests_passed BOOLEAN,
//   created_at TIMESTAMP DEFAULT NOW()
// );
```

### Failure Handling Summary

| Failure Type | Detection | Response | Recovery |
|--------------|-----------|----------|----------|
| Client disconnect | WebSocket close event | Buffer operations locally | Reconnect with exponential backoff; resync on connect |
| Server crash | Health check failure | Load balancer removes server | Other servers handle clients; state in Redis/DB |
| Database unavailable | Circuit breaker opens | Serve from cache; queue writes | Drain queue when circuit closes |
| RabbitMQ unavailable | Circuit breaker opens | Buffer publishes locally | Replay buffered messages on recovery |
| Network partition | Timeout on cross-server RPC | Operate independently | Merge states on partition heal |
| Data corruption | Checksum mismatch on load | Reject corrupted data; restore from backup | Point-in-time recovery from op log |

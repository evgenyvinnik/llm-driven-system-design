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

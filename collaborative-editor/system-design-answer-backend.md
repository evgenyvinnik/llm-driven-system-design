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
+----------------------------------------------------------+
|                     Client Editor                          |
|  +-----------------+  +--------------+  +---------------+ |
|  |  Rich Text      |  |  Operation   |  |  Sync         | |
|  |  Editor         |  |  Transform   |  |  Engine       | |
|  +-----------------+  +--------------+  +---------------+ |
+----------------------------------------------------------+
                           | WebSocket
                           v
+----------------------------------------------------------+
|                     Load Balancer                          |
|  (Sticky sessions by documentId for connection affinity)   |
+----------------------------------------------------------+
          |                    |                    |
          v                    v                    v
+------------------+  +------------------+  +------------------+
|  Sync Server 1   |  |  Sync Server 2   |  |  Sync Server 3   |
|  :3001           |  |  :3002           |  |  :3003           |
|                  |  |                  |  |                  |
| - WebSocket mgr  |  | - WebSocket mgr  |  | - WebSocket mgr  |
| - OT engine      |  | - OT engine      |  | - OT engine      |
| - Presence       |  | - Presence       |  | - Presence       |
+------------------+  +------------------+  +------------------+
          |                    |                    |
          +--------------------+--------------------+
                               |
                    RabbitMQ (fanout)
                               |
          +--------------------+--------------------+
          |                    |                    |
          v                    v                    v
+------------------+  +------------------+  +------------------+
|   PostgreSQL     |  |     Redis        |  |   Object Store   |
|                  |  |                  |  |                  |
| - Documents      |  | - Active docs    |  | - Attachments    |
| - Operations     |  | - Presence       |  | - Media files    |
| - Snapshots      |  | - Cursors        |  |                  |
| - Access control |  | - Idempotency    |  |                  |
+------------------+  +------------------+  +------------------+
```

### Core Components
1. **Sync Server** - WebSocket connections, OT engine, version management
2. **Document State Manager** - In-memory state with persistence
3. **RabbitMQ** - Cross-server operation broadcast
4. **PostgreSQL** - Snapshots and operation log
5. **Redis** - Presence, cursors, idempotency cache

## Deep Dive: Operational Transformation Engine (10 minutes)

### Operation Types

```typescript
interface Op {
  retain?: number;
  insert?: string;
  delete?: number;
  attributes?: Record<string, any>;
}

class TextOperation {
  ops: Op[] = [];
  baseLength: number = 0;
  targetLength: number = 0;

  retain(n: number): this {
    if (n <= 0) return this;
    this.baseLength += n;
    this.targetLength += n;

    // Merge with previous retain
    const last = this.ops[this.ops.length - 1];
    if (last && typeof last.retain === 'number') {
      last.retain += n;
    } else {
      this.ops.push({ retain: n });
    }
    return this;
  }

  insert(str: string, attributes?: Record<string, any>): this {
    if (str.length === 0) return this;
    this.targetLength += str.length;

    const op: Op = { insert: str };
    if (attributes && Object.keys(attributes).length > 0) {
      op.attributes = attributes;
    }
    this.ops.push(op);
    return this;
  }

  delete(n: number): this {
    if (n <= 0) return this;
    this.baseLength += n;

    // Merge with previous delete
    const last = this.ops[this.ops.length - 1];
    if (last && typeof last.delete === 'number') {
      last.delete += n;
    } else {
      this.ops.push({ delete: n });
    }
    return this;
  }

  apply(document: string): string {
    if (document.length !== this.baseLength) {
      throw new Error(`Base length mismatch: expected ${this.baseLength}, got ${document.length}`);
    }

    let result = '';
    let index = 0;

    for (const op of this.ops) {
      if (op.retain) {
        result += document.slice(index, index + op.retain);
        index += op.retain;
      } else if (op.insert) {
        result += op.insert;
      } else if (op.delete) {
        index += op.delete; // Skip deleted characters
      }
    }

    return result;
  }

  toJSON(): any {
    return {
      ops: this.ops,
      baseLength: this.baseLength,
      targetLength: this.targetLength
    };
  }

  static fromJSON(data: any): TextOperation {
    const op = new TextOperation();
    op.ops = data.ops;
    op.baseLength = data.baseLength;
    op.targetLength = data.targetLength;
    return op;
  }
}
```

### Transform Function

The heart of OT - transforms operations so they can be applied in any order:

```typescript
class OTTransformer {
  /**
   * Transform op1 against op2.
   * Returns [op1', op2'] where:
   * apply(apply(doc, op1), op2') === apply(apply(doc, op2), op1')
   */
  static transform(op1: TextOperation, op2: TextOperation): [TextOperation, TextOperation] {
    if (op1.baseLength !== op2.baseLength) {
      throw new Error('Base length mismatch for transform');
    }

    const op1Prime = new TextOperation();
    const op2Prime = new TextOperation();

    const ops1 = [...op1.ops];
    const ops2 = [...op2.ops];
    let i1 = 0, i2 = 0;

    while (i1 < ops1.length || i2 < ops2.length) {
      const o1 = ops1[i1];
      const o2 = ops2[i2];

      // Insert in op1 goes first (arbitrary but consistent)
      if (o1 && o1.insert !== undefined) {
        op1Prime.insert(o1.insert, o1.attributes);
        op2Prime.retain(o1.insert.length);
        i1++;
        continue;
      }

      // Insert in op2 goes first
      if (o2 && o2.insert !== undefined) {
        op1Prime.retain(o2.insert.length);
        op2Prime.insert(o2.insert, o2.attributes);
        i2++;
        continue;
      }

      if (!o1 && !o2) break;

      // Both retain
      if (o1?.retain !== undefined && o2?.retain !== undefined) {
        const minLen = Math.min(o1.retain, o2.retain);
        op1Prime.retain(minLen);
        op2Prime.retain(minLen);
        this.consumeOp(ops1, i1, ops2, i2, minLen, 'retain');
        if (o1.retain <= minLen) i1++;
        if (o2.retain <= minLen) i2++;
        continue;
      }

      // Both delete (same text - no output)
      if (o1?.delete !== undefined && o2?.delete !== undefined) {
        const minLen = Math.min(o1.delete, o2.delete);
        this.consumeOp(ops1, i1, ops2, i2, minLen, 'delete');
        if (o1.delete <= minLen) i1++;
        if (o2.delete <= minLen) i2++;
        continue;
      }

      // op1 deletes, op2 retains
      if (o1?.delete !== undefined && o2?.retain !== undefined) {
        const minLen = Math.min(o1.delete, o2.retain);
        op1Prime.delete(minLen);
        // op2Prime skips deleted text
        this.consumeOp(ops1, i1, ops2, i2, minLen, 'mixed');
        if (o1.delete <= minLen) i1++;
        if (o2.retain <= minLen) i2++;
        continue;
      }

      // op1 retains, op2 deletes
      if (o1?.retain !== undefined && o2?.delete !== undefined) {
        const minLen = Math.min(o1.retain, o2.delete);
        // op1Prime skips deleted text
        op2Prime.delete(minLen);
        this.consumeOp(ops1, i1, ops2, i2, minLen, 'mixed');
        if (o1.retain <= minLen) i1++;
        if (o2.delete <= minLen) i2++;
      }
    }

    return [op1Prime, op2Prime];
  }

  /**
   * Compose two operations into one.
   * apply(apply(doc, op1), op2) === apply(doc, compose(op1, op2))
   */
  static compose(op1: TextOperation, op2: TextOperation): TextOperation {
    if (op1.targetLength !== op2.baseLength) {
      throw new Error(`Compose length mismatch: ${op1.targetLength} !== ${op2.baseLength}`);
    }

    const composed = new TextOperation();
    const ops1 = [...op1.ops];
    const ops2 = [...op2.ops];
    let i1 = 0, i2 = 0;

    while (i1 < ops1.length || i2 < ops2.length) {
      const o1 = ops1[i1];
      const o2 = ops2[i2];

      // Delete from op1 is preserved
      if (o1 && o1.delete !== undefined) {
        composed.delete(o1.delete);
        i1++;
        continue;
      }

      // Insert from op2 is preserved
      if (o2 && o2.insert !== undefined) {
        composed.insert(o2.insert, o2.attributes);
        i2++;
        continue;
      }

      if (!o1 && !o2) break;

      // Insert from op1 + retain from op2
      if (o1?.insert !== undefined && o2?.retain !== undefined) {
        const len = Math.min(o1.insert.length, o2.retain);
        composed.insert(o1.insert.slice(0, len), o1.attributes);
        if (o1.insert.length > len) {
          ops1[i1] = { insert: o1.insert.slice(len), attributes: o1.attributes };
        } else {
          i1++;
        }
        if (o2.retain > len) {
          ops2[i2] = { retain: o2.retain - len };
        } else {
          i2++;
        }
        continue;
      }

      // Insert from op1 + delete from op2
      if (o1?.insert !== undefined && o2?.delete !== undefined) {
        const len = Math.min(o1.insert.length, o2.delete);
        // Characters inserted then deleted - cancel out
        if (o1.insert.length > len) {
          ops1[i1] = { insert: o1.insert.slice(len), attributes: o1.attributes };
        } else {
          i1++;
        }
        if (o2.delete > len) {
          ops2[i2] = { delete: o2.delete - len };
        } else {
          i2++;
        }
        continue;
      }

      // Retain from op1 + retain from op2
      if (o1?.retain !== undefined && o2?.retain !== undefined) {
        const len = Math.min(o1.retain, o2.retain);
        composed.retain(len);
        if (o1.retain > len) ops1[i1] = { retain: o1.retain - len };
        else i1++;
        if (o2.retain > len) ops2[i2] = { retain: o2.retain - len };
        else i2++;
        continue;
      }

      // Retain from op1 + delete from op2
      if (o1?.retain !== undefined && o2?.delete !== undefined) {
        const len = Math.min(o1.retain, o2.delete);
        composed.delete(len);
        if (o1.retain > len) ops1[i1] = { retain: o1.retain - len };
        else i1++;
        if (o2.delete > len) ops2[i2] = { delete: o2.delete - len };
        else i2++;
      }
    }

    return composed;
  }

  private static consumeOp(ops1: Op[], i1: number, ops2: Op[], i2: number, amount: number, type: string): void {
    const o1 = ops1[i1];
    const o2 = ops2[i2];

    if (o1) {
      if (o1.retain !== undefined && o1.retain > amount) o1.retain -= amount;
      if (o1.delete !== undefined && o1.delete > amount) o1.delete -= amount;
    }
    if (o2) {
      if (o2.retain !== undefined && o2.retain > amount) o2.retain -= amount;
      if (o2.delete !== undefined && o2.delete > amount) o2.delete -= amount;
    }
  }
}
```

### Transform Example

```
Document: "Hello"
User A at position 1: retain(1), insert("X") -> "HXello"
User B at position 3: retain(3), insert("Y") -> "HelYlo"

Without transform: Conflicts and corruption.

With transform:
- Transform A against B: retain(1), insert("X") (unchanged, B's insert is after)
- Transform B against A: retain(4), insert("Y") (skip past A's inserted X)

Final result after both: "HXelYlo" (convergent)
```

## Deep Dive: Document State Manager (8 minutes)

### Server-Side State

```typescript
class DocumentState {
  documentId: string;
  version: number = 0;
  content: string = '';
  clients: Map<string, ClientInfo> = new Map();
  private operationBuffer: Map<number, TextOperation> = new Map();

  async load(): Promise<void> {
    // Load latest snapshot
    const snapshot = await db.query(`
      SELECT version, content FROM document_snapshots
      WHERE document_id = $1
      ORDER BY version DESC
      LIMIT 1
    `, [this.documentId]);

    if (snapshot.rows.length > 0) {
      this.version = snapshot.rows[0].version;
      this.content = snapshot.rows[0].content;
    }

    // Apply operations after snapshot
    const ops = await db.query(`
      SELECT version, operation FROM operations
      WHERE document_id = $1 AND version > $2
      ORDER BY version
    `, [this.documentId, this.version]);

    for (const row of ops.rows) {
      const op = TextOperation.fromJSON(row.operation);
      this.content = op.apply(this.content);
      this.version = row.version;
      this.operationBuffer.set(row.version, op);
    }
  }

  async applyOperation(
    clientId: string,
    clientVersion: number,
    operation: TextOperation,
    operationId: string
  ): Promise<ApplyResult> {
    // Check idempotency cache first
    const cached = await redis.get(`idempotent:${operationId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Get concurrent operations (operations client hasn't seen)
    const concurrentOps = await this.getConcurrentOperations(clientVersion);

    // Transform against all concurrent operations
    let transformedOp = operation;
    for (const serverOp of concurrentOps) {
      const [transformed] = OTTransformer.transform(transformedOp, serverOp);
      transformedOp = transformed;
    }

    // Validate transformed operation
    if (transformedOp.baseLength !== this.content.length) {
      throw new Error('Transformed operation base length mismatch');
    }

    // Apply to document
    this.content = transformedOp.apply(this.content);
    this.version++;

    // Buffer for future transforms
    this.operationBuffer.set(this.version, transformedOp);
    this.pruneBuffer();

    // Persist operation
    await db.query(`
      INSERT INTO operations (document_id, version, client_id, operation, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [this.documentId, this.version, clientId, transformedOp.toJSON()]);

    // Periodic snapshots
    if (this.version % 50 === 0) {
      await this.saveSnapshot();
    }

    const result: ApplyResult = {
      version: this.version,
      operation: transformedOp,
      transformCount: concurrentOps.length
    };

    // Cache for idempotency (1 hour TTL)
    await redis.setex(`idempotent:${operationId}`, 3600, JSON.stringify(result));

    return result;
  }

  private async getConcurrentOperations(clientVersion: number): Promise<TextOperation[]> {
    // First check in-memory buffer
    const buffered: TextOperation[] = [];
    for (let v = clientVersion + 1; v <= this.version; v++) {
      const op = this.operationBuffer.get(v);
      if (op) {
        buffered.push(op);
      } else {
        // Fall back to database
        const result = await db.query(`
          SELECT operation FROM operations
          WHERE document_id = $1 AND version > $2 AND version <= $3
          ORDER BY version
        `, [this.documentId, clientVersion, this.version]);
        return result.rows.map(r => TextOperation.fromJSON(r.operation));
      }
    }
    return buffered;
  }

  private pruneBuffer(): void {
    // Keep last 100 operations in memory
    const minVersion = this.version - 100;
    for (const [version] of this.operationBuffer) {
      if (version < minVersion) {
        this.operationBuffer.delete(version);
      }
    }
  }

  private async saveSnapshot(): Promise<void> {
    await db.query(`
      INSERT INTO document_snapshots (document_id, version, content, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (document_id, version) DO NOTHING
    `, [this.documentId, this.version, this.content]);
  }
}

interface ApplyResult {
  version: number;
  operation: TextOperation;
  transformCount: number;
}
```

### WebSocket Sync Server

```typescript
class SyncServer {
  documents: Map<string, DocumentState> = new Map();
  clients: Map<WebSocket, ClientConnection> = new Map();

  async handleConnection(ws: WebSocket, documentId: string, userId: string): Promise<void> {
    const clientId = uuidv4();

    // Load or get document state
    if (!this.documents.has(documentId)) {
      const docState = new DocumentState(documentId);
      await docState.load();
      this.documents.set(documentId, docState);
    }

    const docState = this.documents.get(documentId)!;

    // Register client
    this.clients.set(ws, { documentId, clientId, userId });
    docState.clients.set(clientId, {
      userId,
      cursor: null,
      color: this.assignColor(clientId),
      lastSeen: Date.now()
    });

    // Send initial state
    ws.send(JSON.stringify({
      type: 'init',
      clientId,
      version: docState.version,
      content: docState.content,
      clients: Array.from(docState.clients.entries()).map(([id, info]) => ({
        clientId: id,
        ...info
      }))
    }));

    // Broadcast join
    await this.broadcast(documentId, {
      type: 'client_join',
      clientId,
      userId,
      color: docState.clients.get(clientId)!.color
    }, ws);

    // Store presence in Redis
    await redis.hset(`doc:${documentId}:presence`, clientId, JSON.stringify({
      userId,
      color: docState.clients.get(clientId)!.color,
      serverId: process.env.SERVER_ID,
      connectedAt: Date.now()
    }));
    await redis.expire(`doc:${documentId}:presence`, 300);

    ws.on('message', (data) => this.handleMessage(ws, data));
    ws.on('close', () => this.handleDisconnect(ws));
  }

  async handleMessage(ws: WebSocket, data: Buffer | string): Promise<void> {
    const message = JSON.parse(data.toString());
    const client = this.clients.get(ws);
    if (!client) return;

    const docState = this.documents.get(client.documentId);
    if (!docState) return;

    switch (message.type) {
      case 'operation':
        await this.handleOperation(ws, docState, client, message);
        break;

      case 'cursor':
        await this.handleCursor(ws, docState, client, message);
        break;
    }
  }

  async handleOperation(
    ws: WebSocket,
    docState: DocumentState,
    client: ClientConnection,
    message: OperationMessage
  ): Promise<void> {
    const { version, operation, operationId } = message;

    try {
      const op = TextOperation.fromJSON(operation);
      const result = await docState.applyOperation(
        client.clientId,
        version,
        op,
        operationId
      );

      // Log conflict resolution
      if (result.transformCount > 0) {
        logger.info({
          event: 'ot_conflict_resolved',
          documentId: client.documentId,
          clientId: client.clientId,
          clientVersion: version,
          serverVersion: result.version,
          concurrentOps: result.transformCount
        });
      }

      // Acknowledge to sender
      ws.send(JSON.stringify({
        type: 'ack',
        operationId,
        version: result.version
      }));

      // Broadcast to local clients
      await this.broadcast(client.documentId, {
        type: 'operation',
        clientId: client.clientId,
        version: result.version,
        operation: result.operation.toJSON()
      }, ws);

      // Publish to RabbitMQ for cross-server sync
      await this.publishOperation(client.documentId, result);

    } catch (error) {
      logger.error({
        event: 'operation_apply_failed',
        documentId: client.documentId,
        clientId: client.clientId,
        error: (error as Error).message
      });

      // Request client resync
      ws.send(JSON.stringify({
        type: 'resync',
        version: docState.version,
        content: docState.content
      }));
    }
  }

  async handleCursor(
    ws: WebSocket,
    docState: DocumentState,
    client: ClientConnection,
    message: CursorMessage
  ): Promise<void> {
    const clientInfo = docState.clients.get(client.clientId);
    if (clientInfo) {
      clientInfo.cursor = message.position;
      clientInfo.lastSeen = Date.now();
    }

    // Store in Redis for cross-server access
    await redis.hset(
      `doc:${client.documentId}:cursors`,
      client.clientId,
      JSON.stringify({ position: message.position, timestamp: Date.now() })
    );
    await redis.expire(`doc:${client.documentId}:cursors`, 60);

    // Broadcast to other clients
    await this.broadcast(client.documentId, {
      type: 'cursor',
      clientId: client.clientId,
      position: message.position
    }, ws);
  }

  async broadcast(documentId: string, message: any, excludeWs?: WebSocket): Promise<void> {
    for (const [ws, client] of this.clients) {
      if (client.documentId === documentId && ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    }
  }

  async publishOperation(documentId: string, result: ApplyResult): Promise<void> {
    await rabbitChannel.publish(
      'doc.operations',
      `doc.${documentId}`,
      Buffer.from(JSON.stringify({
        documentId,
        version: result.version,
        operation: result.operation.toJSON(),
        serverId: process.env.SERVER_ID,
        timestamp: Date.now()
      })),
      { persistent: true, messageId: `${documentId}-${result.version}` }
    );
  }

  handleDisconnect(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client) return;

    const docState = this.documents.get(client.documentId);
    if (docState) {
      docState.clients.delete(client.clientId);

      // Broadcast leave
      this.broadcast(client.documentId, {
        type: 'client_leave',
        clientId: client.clientId
      });

      // Remove from Redis
      redis.hdel(`doc:${client.documentId}:presence`, client.clientId);
      redis.hdel(`doc:${client.documentId}:cursors`, client.clientId);

      // Clean up empty documents after delay
      if (docState.clients.size === 0) {
        setTimeout(() => {
          if (docState.clients.size === 0) {
            this.documents.delete(client.documentId);
          }
        }, 30000);
      }
    }

    this.clients.delete(ws);
  }

  private assignColor(clientId: string): string {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD'];
    const hash = clientId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return colors[hash % colors.length];
  }
}
```

## Deep Dive: Cross-Server Synchronization (5 minutes)

### RabbitMQ Fanout Architecture

```typescript
// Queue setup
async function setupQueues(): Promise<void> {
  const channel = await connection.createChannel();

  // Topic exchange for operations
  await channel.assertExchange('doc.operations', 'topic', { durable: true });

  // Per-server queue
  const queueName = `op.broadcast.${process.env.SERVER_ID}`;
  await channel.assertQueue(queueName, {
    durable: true,
    deadLetterExchange: 'doc.dlx',
    deadLetterRoutingKey: 'operation.failed'
  });

  // Bind to all document operations
  await channel.bindQueue(queueName, 'doc.operations', 'doc.*');

  // Prefetch for backpressure
  await channel.prefetch(50);

  // Consume operations from other servers
  channel.consume(queueName, async (msg) => {
    if (!msg) return;

    const data = JSON.parse(msg.content.toString());

    // Skip operations from self
    if (data.serverId === process.env.SERVER_ID) {
      channel.ack(msg);
      return;
    }

    // Deduplicate
    const seen = await redis.get(`seen:${msg.properties.messageId}`);
    if (seen) {
      channel.ack(msg);
      return;
    }

    try {
      // Broadcast to local WebSocket clients
      const docState = syncServer.documents.get(data.documentId);
      if (docState) {
        // Update local state
        const op = TextOperation.fromJSON(data.operation);
        docState.content = op.apply(docState.content);
        docState.version = data.version;

        // Broadcast to local clients
        await syncServer.broadcast(data.documentId, {
          type: 'operation',
          clientId: 'remote',
          version: data.version,
          operation: data.operation
        });
      }

      await redis.setex(`seen:${msg.properties.messageId}`, 3600, '1');
      channel.ack(msg);

    } catch (error) {
      logger.error({ event: 'cross_server_sync_failed', error: (error as Error).message });
      channel.nack(msg, false, msg.fields.redelivered ? false : true);
    }
  });
}
```

### Dead Letter Queue

```typescript
async function setupDeadLetterQueue(): Promise<void> {
  const channel = await connection.createChannel();

  await channel.assertExchange('doc.dlx', 'direct', { durable: true });
  await channel.assertQueue('doc.failed', { durable: true });
  await channel.bindQueue('doc.failed', 'doc.dlx', 'operation.failed');

  channel.consume('doc.failed', async (msg) => {
    if (!msg) return;

    logger.error({
      event: 'dead_letter_received',
      routingKey: msg.fields.routingKey,
      content: msg.content.toString(),
      deathReason: msg.properties.headers?.['x-first-death-reason']
    });

    // Store for manual inspection
    await db.query(`
      INSERT INTO failed_messages (routing_key, content, headers, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [msg.fields.routingKey, msg.content.toString(), JSON.stringify(msg.properties.headers)]);

    channel.ack(msg);
  });
}
```

## Database Schema (3 minutes)

```sql
-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_documents_owner ON documents(owner_id);

-- Document snapshots (periodic checkpoints)
CREATE TABLE document_snapshots (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, version)
);

-- Operations log
CREATE TABLE operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  client_id VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES users(id),
  operation JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (document_id, version)
);

CREATE INDEX idx_operations_doc_version ON operations(document_id, version);
CREATE INDEX idx_operations_created ON operations(created_at);

-- Document access control
CREATE TABLE document_access (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(20) NOT NULL CHECK (permission IN ('view', 'comment', 'edit', 'admin')),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);

CREATE INDEX idx_document_access_user ON document_access(user_id);

-- Comments
CREATE TABLE document_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  range_start INTEGER,
  range_end INTEGER,
  content TEXT NOT NULL,
  resolved BOOLEAN DEFAULT false,
  parent_id UUID REFERENCES document_comments(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_doc ON document_comments(document_id);

-- Audit log
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,
  user_id UUID,
  document_id UUID,
  action VARCHAR(50) NOT NULL,
  details JSONB,
  ip_address INET,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
CREATE INDEX idx_audit_document ON audit_log(document_id, created_at);

-- Failed messages (for DLQ inspection)
CREATE TABLE failed_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_key VARCHAR(100),
  content TEXT,
  headers JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Deep Dive: Version History (3 minutes)

```typescript
class VersionHistoryService {
  async getVersions(documentId: string, limit: number = 50): Promise<Version[]> {
    const result = await db.query(`
      SELECT
        ds.version,
        ds.created_at,
        LENGTH(ds.content) as size_bytes,
        (
          SELECT u.name FROM users u
          JOIN operations o ON o.user_id = u.id
          WHERE o.document_id = ds.document_id AND o.version = ds.version
        ) as author
      FROM document_snapshots ds
      WHERE ds.document_id = $1
      ORDER BY ds.version DESC
      LIMIT $2
    `, [documentId, limit]);

    return result.rows;
  }

  async getVersion(documentId: string, targetVersion: number): Promise<DocumentVersion> {
    // Find closest snapshot at or before target
    const snapshot = await db.query(`
      SELECT version, content FROM document_snapshots
      WHERE document_id = $1 AND version <= $2
      ORDER BY version DESC
      LIMIT 1
    `, [documentId, targetVersion]);

    if (snapshot.rows.length === 0) {
      throw new Error('Version not found');
    }

    let content = snapshot.rows[0].content;
    let currentVersion = snapshot.rows[0].version;

    // Apply operations to reach target
    if (currentVersion < targetVersion) {
      const ops = await db.query(`
        SELECT operation FROM operations
        WHERE document_id = $1 AND version > $2 AND version <= $3
        ORDER BY version
      `, [documentId, currentVersion, targetVersion]);

      for (const row of ops.rows) {
        const op = TextOperation.fromJSON(row.operation);
        content = op.apply(content);
      }
    }

    return { version: targetVersion, content };
  }

  async restoreVersion(documentId: string, targetVersion: number, userId: string): Promise<number> {
    const historical = await this.getVersion(documentId, targetVersion);
    const current = await this.getVersion(documentId, Infinity); // Latest

    // Create restore operation
    const restoreOp = new TextOperation();
    if (current.content.length > 0) {
      restoreOp.delete(current.content.length);
    }
    if (historical.content.length > 0) {
      restoreOp.insert(historical.content);
    }

    // Apply as new operation
    const docState = await this.getDocumentState(documentId);
    const result = await docState.applyOperation(
      `restore-${userId}`,
      current.version,
      restoreOp,
      `restore-${documentId}-${targetVersion}-${Date.now()}`
    );

    // Audit log
    await db.query(`
      INSERT INTO audit_log (event_type, user_id, document_id, action, details, created_at)
      VALUES ('version.restore', $1, $2, 'restore', $3, NOW())
    `, [userId, documentId, JSON.stringify({ restoredFrom: targetVersion, newVersion: result.version })]);

    return result.version;
  }
}
```

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

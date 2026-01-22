# Design Notion (Backend Focus)

## 45-Minute Backend Interview Answer

### 1. Requirements Clarification (3 minutes)

**Interviewer:** Design a block-based collaboration tool like Notion.

**Candidate:** I'll focus on the backend architecture. Let me clarify the requirements:

**Functional Requirements:**
- Block-based document model with rich content types
- Real-time collaborative editing with conflict resolution
- Hierarchical page organization within workspaces
- Database views with filtering and sorting
- Offline-first editing with sync

**Non-Functional Requirements:**
- Sub-100ms latency for local operations
- Eventual consistency within 500ms across clients
- Support for documents with 10,000+ blocks
- Handle concurrent edits from multiple users

**Scale Estimation:**
- 10M active users, 100M documents
- Average 500 blocks per document
- 50 billion total blocks
- 10K concurrent collaborative sessions

---

### 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Clients                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Load Balancer                                  │
│                    (Sticky sessions for WebSocket)                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │  API Server  │ │  API Server  │ │  API Server  │
            │  + WebSocket │ │  + WebSocket │ │  + WebSocket │
            └──────────────┘ └──────────────┘ └──────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌──────────────┐          ┌──────────────────┐          ┌──────────────┐
│    Redis     │          │   PostgreSQL     │          │   RabbitMQ   │
│   (Cache +   │          │   (Persistence)  │          │   (Async)    │
│   Pub/Sub)   │          │                  │          │              │
└──────────────┘          └──────────────────┘          └──────────────┘
```

---

### 3. Block Data Model Deep Dive (8 minutes)

#### Block Schema

```typescript
interface Block {
  id: string;              // UUID
  type: BlockType;         // 'text' | 'heading1' | 'code' | 'image' | etc.
  parentId: string | null; // Parent block or null for root
  pageId: string;          // Page this block belongs to
  position: string;        // Fractional index for ordering
  properties: BlockProperties;
  content: RichText[];
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  version: number;         // Optimistic locking
}

interface RichText {
  text: string;
  annotations: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    color?: string;
  };
  href?: string;
}

type BlockType =
  | 'text' | 'heading1' | 'heading2' | 'heading3'
  | 'bulleted_list' | 'numbered_list' | 'toggle' | 'quote'
  | 'code' | 'callout' | 'divider' | 'image' | 'table'
  | 'database';
```

#### PostgreSQL Schema

```sql
-- Workspaces
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id),
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pages with recursive hierarchy
CREATE TABLE pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES pages(id) ON DELETE CASCADE,
  title VARCHAR(1000) NOT NULL DEFAULT 'Untitled',
  icon VARCHAR(100),
  cover_url TEXT,
  position VARCHAR(100) NOT NULL,  -- Fractional index
  is_database BOOLEAN DEFAULT FALSE,
  database_schema JSONB,           -- For database pages
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ           -- Soft delete
);

-- Blocks
CREATE TABLE blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES blocks(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  position VARCHAR(100) NOT NULL,  -- Fractional index
  properties JSONB DEFAULT '{}',
  content JSONB DEFAULT '[]',      -- RichText array
  version INTEGER DEFAULT 1,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX idx_blocks_page_id ON blocks(page_id);
CREATE INDEX idx_blocks_parent_id ON blocks(parent_id);
CREATE INDEX idx_blocks_page_position ON blocks(page_id, position);
CREATE INDEX idx_pages_workspace ON pages(workspace_id, parent_id);
CREATE INDEX idx_pages_position ON pages(workspace_id, parent_id, position);

-- Database rows (pages that are database entries)
CREATE TABLE database_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  properties JSONB NOT NULL DEFAULT '{}',
  position VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Database views
CREATE TABLE database_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,  -- 'table' | 'board' | 'list' | 'calendar' | 'gallery'
  config JSONB NOT NULL,      -- filters, sorts, groupBy, visibleProperties
  position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Operations log for CRDT sync
CREATE TABLE operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id UUID,
  type VARCHAR(50) NOT NULL,  -- 'insert' | 'update' | 'delete' | 'move'
  payload JSONB NOT NULL,
  hlc_timestamp BIGINT NOT NULL,
  hlc_counter INTEGER NOT NULL,
  node_id VARCHAR(50) NOT NULL,
  author_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_operations_page_hlc ON operations(page_id, hlc_timestamp, hlc_counter);
```

---

### 4. Fractional Indexing for Block Ordering (6 minutes)

```typescript
// Fractional indexing allows O(1) insertions without reindexing siblings

class FractionalIndex {
  private static readonly CHARS =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  private static readonly BASE = this.CHARS.length;

  // Generate position between two existing positions
  static between(before: string | null, after: string | null): string {
    if (!before && !after) {
      return 'U'; // Middle of range
    }

    if (!before) {
      return this.decrementPosition(after!);
    }

    if (!after) {
      return this.incrementPosition(before);
    }

    return this.midpoint(before, after);
  }

  private static midpoint(a: string, b: string): string {
    // Ensure a < b
    if (a >= b) {
      throw new Error('Invalid ordering: before must be less than after');
    }

    let result = '';
    let i = 0;

    while (i < a.length || i < b.length) {
      const charA = i < a.length ? this.CHARS.indexOf(a[i]) : 0;
      const charB = i < b.length ? this.CHARS.indexOf(b[i]) : this.BASE - 1;

      if (charA === charB) {
        result += this.CHARS[charA];
        i++;
        continue;
      }

      const mid = Math.floor((charA + charB) / 2);

      if (mid > charA) {
        result += this.CHARS[mid];
        return result;
      }

      // Need to go deeper
      result += this.CHARS[charA];
      i++;
    }

    // Append middle character
    result += 'U';
    return result;
  }

  private static incrementPosition(pos: string): string {
    const chars = pos.split('');
    let i = chars.length - 1;

    while (i >= 0) {
      const idx = this.CHARS.indexOf(chars[i]);
      if (idx < this.BASE - 1) {
        chars[i] = this.CHARS[idx + 1];
        return chars.join('');
      }
      chars[i] = '0';
      i--;
    }

    return 'z' + chars.join('');
  }

  private static decrementPosition(pos: string): string {
    const chars = pos.split('');
    let i = chars.length - 1;

    while (i >= 0) {
      const idx = this.CHARS.indexOf(chars[i]);
      if (idx > 0) {
        chars[i] = this.CHARS[idx - 1];
        return chars.join('');
      }
      chars[i] = 'z';
      i--;
    }

    return '0' + chars.join('');
  }

  // Bulk generate positions for initial document
  static generateBulk(count: number): string[] {
    const positions: string[] = [];
    let current = 'A';

    for (let i = 0; i < count; i++) {
      positions.push(current);
      current = this.incrementPosition(current);
    }

    return positions;
  }
}
```

---

### 5. CRDT Operations and Sync Protocol (8 minutes)

#### Hybrid Logical Clock

```typescript
interface HLC {
  timestamp: number;  // Physical wall clock (milliseconds)
  counter: number;    // Logical counter for same-ms events
  nodeId: string;     // Unique node identifier
}

class HybridLogicalClock {
  private timestamp: number = 0;
  private counter: number = 0;
  private nodeId: string;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  // Generate new timestamp for local event
  now(): HLC {
    const physicalTime = Date.now();

    if (physicalTime > this.timestamp) {
      this.timestamp = physicalTime;
      this.counter = 0;
    } else {
      this.counter++;
    }

    return {
      timestamp: this.timestamp,
      counter: this.counter,
      nodeId: this.nodeId
    };
  }

  // Update clock on receiving remote event
  receive(remote: HLC): HLC {
    const physicalTime = Date.now();

    if (physicalTime > this.timestamp && physicalTime > remote.timestamp) {
      this.timestamp = physicalTime;
      this.counter = 0;
    } else if (remote.timestamp > this.timestamp) {
      this.timestamp = remote.timestamp;
      this.counter = remote.counter + 1;
    } else if (this.timestamp === remote.timestamp) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else {
      this.counter++;
    }

    return {
      timestamp: this.timestamp,
      counter: this.counter,
      nodeId: this.nodeId
    };
  }

  // Compare two HLCs for ordering
  static compare(a: HLC, b: HLC): number {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    if (a.counter !== b.counter) {
      return a.counter - b.counter;
    }
    return a.nodeId.localeCompare(b.nodeId);
  }
}
```

#### Operation Types

```typescript
type OperationType = 'insert' | 'update' | 'delete' | 'move';

interface Operation {
  id: string;
  type: OperationType;
  blockId: string;
  pageId: string;
  payload: OperationPayload;
  hlc: HLC;
  authorId: string;
}

type OperationPayload =
  | { type: 'insert'; parentId: string | null; position: string; blockType: string; content: RichText[] }
  | { type: 'update'; properties?: Partial<BlockProperties>; content?: RichText[] }
  | { type: 'delete' }
  | { type: 'move'; newParentId: string | null; newPosition: string };
```

#### Sync Service

```typescript
class SyncService {
  private clock: HybridLogicalClock;
  private pendingOps: Map<string, Operation> = new Map();

  constructor(
    private db: Pool,
    private redis: Redis,
    private nodeId: string
  ) {
    this.clock = new HybridLogicalClock(nodeId);
  }

  async applyOperation(op: Operation): Promise<void> {
    // Update our clock with remote timestamp
    this.clock.receive(op.hlc);

    // Apply operation based on type
    switch (op.payload.type) {
      case 'insert':
        await this.handleInsert(op);
        break;
      case 'update':
        await this.handleUpdate(op);
        break;
      case 'delete':
        await this.handleDelete(op);
        break;
      case 'move':
        await this.handleMove(op);
        break;
    }

    // Persist operation for history
    await this.persistOperation(op);

    // Broadcast to other subscribers
    await this.broadcastOperation(op);
  }

  private async handleInsert(op: Operation): Promise<void> {
    const payload = op.payload as { type: 'insert'; parentId: string | null; position: string; blockType: string; content: RichText[] };

    await this.db.query(`
      INSERT INTO blocks (id, page_id, parent_id, type, position, content, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
    `, [op.blockId, op.pageId, payload.parentId, payload.blockType, payload.position, JSON.stringify(payload.content), op.authorId]);
  }

  private async handleUpdate(op: Operation): Promise<void> {
    const payload = op.payload as { type: 'update'; properties?: Partial<BlockProperties>; content?: RichText[] };

    // Last-write-wins based on HLC
    const result = await this.db.query(`
      UPDATE blocks
      SET
        properties = COALESCE($1::jsonb, properties),
        content = COALESCE($2::jsonb, content),
        updated_at = NOW(),
        version = version + 1
      WHERE id = $3
        AND (
          NOT EXISTS (
            SELECT 1 FROM operations
            WHERE block_id = $3
              AND type = 'update'
              AND (hlc_timestamp > $4 OR (hlc_timestamp = $4 AND hlc_counter > $5))
          )
        )
      RETURNING id
    `, [
      payload.properties ? JSON.stringify(payload.properties) : null,
      payload.content ? JSON.stringify(payload.content) : null,
      op.blockId,
      op.hlc.timestamp,
      op.hlc.counter
    ]);

    if (result.rowCount === 0) {
      console.log(`Operation ${op.id} superseded by later update`);
    }
  }

  private async handleDelete(op: Operation): Promise<void> {
    // Soft delete - mark as deleted
    await this.db.query(`
      UPDATE blocks SET deleted_at = NOW() WHERE id = $1
    `, [op.blockId]);
  }

  private async handleMove(op: Operation): Promise<void> {
    const payload = op.payload as { type: 'move'; newParentId: string | null; newPosition: string };

    await this.db.query(`
      UPDATE blocks
      SET parent_id = $1, position = $2, updated_at = NOW()
      WHERE id = $3
    `, [payload.newParentId, payload.newPosition, op.blockId]);
  }

  private async persistOperation(op: Operation): Promise<void> {
    await this.db.query(`
      INSERT INTO operations (id, page_id, block_id, type, payload, hlc_timestamp, hlc_counter, node_id, author_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [op.id, op.pageId, op.blockId, op.type, JSON.stringify(op.payload), op.hlc.timestamp, op.hlc.counter, op.hlc.nodeId, op.authorId]);
  }

  private async broadcastOperation(op: Operation): Promise<void> {
    await this.redis.publish(`page:${op.pageId}:ops`, JSON.stringify(op));
  }

  // Get operations since a given HLC for sync
  async getOperationsSince(pageId: string, since: HLC): Promise<Operation[]> {
    const result = await this.db.query(`
      SELECT * FROM operations
      WHERE page_id = $1
        AND (hlc_timestamp > $2 OR (hlc_timestamp = $2 AND hlc_counter > $3))
      ORDER BY hlc_timestamp, hlc_counter, node_id
      LIMIT 1000
    `, [pageId, since.timestamp, since.counter]);

    return result.rows.map(row => ({
      id: row.id,
      type: row.type,
      blockId: row.block_id,
      pageId: row.page_id,
      payload: row.payload,
      hlc: {
        timestamp: row.hlc_timestamp,
        counter: row.hlc_counter,
        nodeId: row.node_id
      },
      authorId: row.author_id
    }));
  }
}
```

---

### 6. WebSocket Real-Time Layer (5 minutes)

```typescript
import { WebSocket, WebSocketServer } from 'ws';
import { Redis } from 'ioredis';

interface Client {
  ws: WebSocket;
  userId: string;
  pageId: string | null;
  cursor?: { blockId: string; offset: number };
}

class RealtimeServer {
  private clients: Map<string, Client> = new Map();
  private pageSubscribers: Map<string, Set<string>> = new Map();
  private redisSub: Redis;
  private redisPub: Redis;

  constructor(
    private wss: WebSocketServer,
    private syncService: SyncService,
    redisUrl: string
  ) {
    this.redisSub = new Redis(redisUrl);
    this.redisPub = new Redis(redisUrl);
    this.setupRedisSubscription();
  }

  private setupRedisSubscription(): void {
    this.redisSub.psubscribe('page:*:ops', 'page:*:presence');

    this.redisSub.on('pmessage', (pattern, channel, message) => {
      const [, pageId, type] = channel.split(':');
      const data = JSON.parse(message);

      // Broadcast to all local clients subscribed to this page
      const subscribers = this.pageSubscribers.get(pageId);
      if (subscribers) {
        for (const clientId of subscribers) {
          const client = this.clients.get(clientId);
          if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type, data }));
          }
        }
      }
    });
  }

  handleConnection(ws: WebSocket, userId: string): void {
    const clientId = crypto.randomUUID();
    this.clients.set(clientId, { ws, userId, pageId: null });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(clientId, message);
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid message' }));
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(clientId);
    });
  }

  private async handleMessage(clientId: string, message: any): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'subscribe':
        await this.handleSubscribe(clientId, message.pageId);
        break;

      case 'unsubscribe':
        await this.handleUnsubscribe(clientId);
        break;

      case 'operation':
        await this.handleOperation(clientId, message.operation);
        break;

      case 'cursor':
        await this.handleCursor(clientId, message.cursor);
        break;

      case 'sync':
        await this.handleSync(clientId, message.since);
        break;
    }
  }

  private async handleSubscribe(clientId: string, pageId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from previous page
    if (client.pageId) {
      await this.handleUnsubscribe(clientId);
    }

    // Add to new page
    client.pageId = pageId;

    if (!this.pageSubscribers.has(pageId)) {
      this.pageSubscribers.set(pageId, new Set());
    }
    this.pageSubscribers.get(pageId)!.add(clientId);

    // Send current presence
    const presence = await this.getPagePresence(pageId);
    client.ws.send(JSON.stringify({ type: 'presence', data: presence }));

    // Announce join
    await this.redisPub.publish(`page:${pageId}:presence`, JSON.stringify({
      action: 'join',
      userId: client.userId
    }));
  }

  private async handleUnsubscribe(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || !client.pageId) return;

    const pageId = client.pageId;
    this.pageSubscribers.get(pageId)?.delete(clientId);

    // Announce leave
    await this.redisPub.publish(`page:${pageId}:presence`, JSON.stringify({
      action: 'leave',
      userId: client.userId
    }));

    client.pageId = null;
  }

  private async handleOperation(clientId: string, operation: Operation): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || !client.pageId) return;

    // Apply operation through sync service
    await this.syncService.applyOperation(operation);

    // Acknowledge to sender
    client.ws.send(JSON.stringify({
      type: 'ack',
      operationId: operation.id
    }));
  }

  private async handleCursor(clientId: string, cursor: { blockId: string; offset: number }): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || !client.pageId) return;

    client.cursor = cursor;

    // Broadcast cursor position
    await this.redisPub.publish(`page:${client.pageId}:presence`, JSON.stringify({
      action: 'cursor',
      userId: client.userId,
      cursor
    }));
  }

  private async handleSync(clientId: string, since: HLC): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || !client.pageId) return;

    const operations = await this.syncService.getOperationsSince(client.pageId, since);
    client.ws.send(JSON.stringify({ type: 'sync', operations }));
  }

  private async getPagePresence(pageId: string): Promise<Array<{ userId: string; cursor?: any }>> {
    const subscribers = this.pageSubscribers.get(pageId);
    if (!subscribers) return [];

    const presence: Array<{ userId: string; cursor?: any }> = [];
    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client) {
        presence.push({
          userId: client.userId,
          cursor: client.cursor
        });
      }
    }
    return presence;
  }

  private handleDisconnect(clientId: string): void {
    this.handleUnsubscribe(clientId);
    this.clients.delete(clientId);
  }
}
```

---

### 7. Cache-Aside Pattern (4 minutes)

```typescript
class PageCache {
  private readonly PAGE_TTL = 600;   // 10 minutes
  private readonly BLOCK_TTL = 300;  // 5 minutes

  constructor(private redis: Redis, private db: Pool) {}

  async getPage(pageId: string): Promise<Page | null> {
    const cacheKey = `page:${pageId}`;

    // Try cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Load from database
    const result = await this.db.query(`
      SELECT p.*, u.name as author_name
      FROM pages p
      JOIN users u ON p.created_by = u.id
      WHERE p.id = $1 AND p.deleted_at IS NULL
    `, [pageId]);

    if (result.rows.length === 0) return null;

    const page = result.rows[0];

    // Cache with TTL
    await this.redis.setex(cacheKey, this.PAGE_TTL, JSON.stringify(page));

    return page;
  }

  async getPageBlocks(pageId: string): Promise<Block[]> {
    const cacheKey = `page:${pageId}:blocks`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await this.db.query(`
      SELECT * FROM blocks
      WHERE page_id = $1 AND deleted_at IS NULL
      ORDER BY position
    `, [pageId]);

    const blocks = result.rows;

    await this.redis.setex(cacheKey, this.BLOCK_TTL, JSON.stringify(blocks));

    return blocks;
  }

  async invalidatePage(pageId: string): Promise<void> {
    const keys = [
      `page:${pageId}`,
      `page:${pageId}:blocks`
    ];
    await this.redis.del(...keys);
  }

  async invalidateBlock(pageId: string, blockId: string): Promise<void> {
    // Invalidate page blocks cache
    await this.redis.del(`page:${pageId}:blocks`);
  }

  // Batch load with multi-get
  async getPagesBatch(pageIds: string[]): Promise<Map<string, Page>> {
    const cacheKeys = pageIds.map(id => `page:${id}`);
    const cached = await this.redis.mget(...cacheKeys);

    const result = new Map<string, Page>();
    const missing: string[] = [];

    cached.forEach((value, index) => {
      if (value) {
        result.set(pageIds[index], JSON.parse(value));
      } else {
        missing.push(pageIds[index]);
      }
    });

    if (missing.length > 0) {
      const dbResult = await this.db.query(`
        SELECT * FROM pages WHERE id = ANY($1) AND deleted_at IS NULL
      `, [missing]);

      const pipeline = this.redis.pipeline();
      for (const page of dbResult.rows) {
        result.set(page.id, page);
        pipeline.setex(`page:${page.id}`, this.PAGE_TTL, JSON.stringify(page));
      }
      await pipeline.exec();
    }

    return result;
  }
}
```

---

### 8. Async Queue Processing (3 minutes)

```typescript
// RabbitMQ queue configuration for async operations
const QUEUES = {
  SEARCH_INDEX: 'notion.search.index',
  EXPORT: 'notion.export',
  WEBHOOK: 'notion.webhook',
  CLEANUP: 'notion.cleanup',
  EMAIL: 'notion.email.notification'
};

class QueueService {
  constructor(private channel: Channel) {}

  async publishSearchIndex(pageId: string, content: string): Promise<void> {
    await this.channel.sendToQueue(
      QUEUES.SEARCH_INDEX,
      Buffer.from(JSON.stringify({ pageId, content, timestamp: Date.now() })),
      { persistent: true }
    );
  }

  async publishExport(userId: string, pageId: string, format: 'markdown' | 'pdf' | 'html'): Promise<void> {
    await this.channel.sendToQueue(
      QUEUES.EXPORT,
      Buffer.from(JSON.stringify({ userId, pageId, format })),
      { persistent: true }
    );
  }

  async publishWebhook(workspaceId: string, event: string, payload: any): Promise<void> {
    await this.channel.sendToQueue(
      QUEUES.WEBHOOK,
      Buffer.from(JSON.stringify({ workspaceId, event, payload })),
      { persistent: true }
    );
  }
}

// Search indexing worker
class SearchIndexWorker {
  constructor(
    private channel: Channel,
    private elasticsearch: Client
  ) {}

  async start(): Promise<void> {
    await this.channel.consume(QUEUES.SEARCH_INDEX, async (msg) => {
      if (!msg) return;

      try {
        const { pageId, content } = JSON.parse(msg.content.toString());

        await this.elasticsearch.index({
          index: 'pages',
          id: pageId,
          body: {
            content,
            updatedAt: new Date().toISOString()
          }
        });

        this.channel.ack(msg);
      } catch (error) {
        // Requeue on failure
        this.channel.nack(msg, false, true);
      }
    });
  }
}
```

---

### 9. Trade-offs and Decisions

| Decision | Chosen Approach | Alternative | Rationale |
|----------|----------------|-------------|-----------|
| Ordering | Fractional indexing | Integer positions | O(1) insertions without reindexing siblings |
| Conflict resolution | HLC + LWW | Full CRDT | Simpler implementation, sufficient for block-level ops |
| Real-time transport | WebSocket + Redis Pub/Sub | Server-Sent Events | Bidirectional communication needed |
| Block storage | PostgreSQL JSONB | MongoDB | ACID transactions, familiar tooling |
| Cache strategy | Cache-aside with TTL | Write-through | Simpler invalidation, acceptable staleness |
| Operation log | Append-only | Event sourcing | Enables sync without full replay |

---

### 10. Future Backend Enhancements

1. **Full CRDT for text content** - Character-level conflict resolution using RGA or Yjs
2. **Sharding strategy** - Shard by workspace for horizontal scaling
3. **Version history** - Point-in-time recovery using operation log
4. **Rate limiting** - Per-user operation rate limits for abuse prevention
5. **Audit logging** - Compliance-grade logging for enterprise
6. **Multi-region** - CockroachDB or Spanner for global deployment

# Design Notion (Full-Stack Focus)

## 45-Minute Full-Stack Interview Answer

### 1. Requirements Clarification (3 minutes)

**Interviewer:** Design a block-based collaboration tool like Notion.

**Candidate:** I'll focus on the full-stack integration. Let me clarify:

**Core Requirements:**
- Block-based document editor with real-time collaboration
- Hierarchical page organization in workspaces
- Database views with filtering, sorting, and grouping
- Offline-first editing with sync

**Technical Focus Areas:**
- WebSocket sync protocol between frontend and backend
- Optimistic updates with conflict resolution
- Shared type definitions across the stack
- End-to-end data flow for collaborative editing

---

### 2. Shared Type Definitions (5 minutes)

```typescript
// shared/types.ts - Used by both frontend and backend

// === Block Types ===
export type BlockType =
  | 'text' | 'heading1' | 'heading2' | 'heading3'
  | 'bulleted_list' | 'numbered_list' | 'toggle' | 'quote'
  | 'code' | 'callout' | 'divider' | 'image' | 'table'
  | 'database';

export interface RichText {
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

export interface Block {
  id: string;
  type: BlockType;
  parentId: string | null;
  pageId: string;
  position: string;           // Fractional index
  properties: Record<string, unknown>;
  content: RichText[];
  children?: Block[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  version: number;
}

// === Hybrid Logical Clock ===
export interface HLC {
  timestamp: number;
  counter: number;
  nodeId: string;
}

// === Operations for CRDT ===
export type OperationType = 'insert' | 'update' | 'delete' | 'move';

export interface Operation {
  id: string;
  type: OperationType;
  blockId: string;
  pageId: string;
  payload: OperationPayload;
  hlc: HLC;
  authorId: string;
}

export type OperationPayload =
  | { type: 'insert'; parentId: string | null; position: string; blockType: BlockType; content: RichText[] }
  | { type: 'update'; properties?: Record<string, unknown>; content?: RichText[] }
  | { type: 'delete' }
  | { type: 'move'; newParentId: string | null; newPosition: string };

// === Page Types ===
export interface Page {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverUrl: string | null;
  position: string;
  isDatabase: boolean;
  databaseSchema?: DatabaseSchema;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// === Database Types ===
export interface DatabaseSchema {
  properties: Record<string, PropertyDefinition>;
}

export interface PropertyDefinition {
  id: string;
  name: string;
  type: PropertyType;
  options?: SelectOption[];     // For select/multi-select
  dateFormat?: string;          // For date
  numberFormat?: string;        // For number
}

export type PropertyType =
  | 'title' | 'text' | 'number' | 'select' | 'multi_select'
  | 'date' | 'checkbox' | 'url' | 'email' | 'phone'
  | 'person' | 'relation' | 'rollup' | 'formula';

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface DatabaseRow {
  id: string;
  databaseId: string;
  properties: Record<string, PropertyValue>;
  position: string;
  createdAt: string;
  updatedAt: string;
}

export type PropertyValue =
  | { type: 'title'; value: string }
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'select'; id: string; name: string; color: string }
  | { type: 'multi_select'; values: Array<{ id: string; name: string; color: string }> }
  | { type: 'date'; start: string; end?: string }
  | { type: 'checkbox'; value: boolean }
  | { type: 'url'; value: string }
  | { type: 'person'; userId: string; name: string };

// === View Types ===
export interface DatabaseView {
  id: string;
  databaseId: string;
  name: string;
  type: 'table' | 'board' | 'list' | 'calendar' | 'gallery';
  config: ViewConfig;
  position: number;
}

export interface ViewConfig {
  filters: Filter[];
  sorts: Sort[];
  groupBy?: string;                        // Property ID for board view
  visibleProperties?: string[];
  propertyWidths?: Record<string, number>;
}

export interface Filter {
  propertyId: string;
  operator: FilterOperator;
  value: unknown;
}

export type FilterOperator =
  | 'equals' | 'not_equals' | 'contains' | 'not_contains'
  | 'greater_than' | 'less_than' | 'is_empty' | 'is_not_empty';

export interface Sort {
  propertyId: string;
  direction: 'asc' | 'desc';
}

// === WebSocket Messages ===
export type WSClientMessage =
  | { type: 'subscribe'; pageId: string }
  | { type: 'unsubscribe' }
  | { type: 'operation'; operation: Operation }
  | { type: 'cursor'; cursor: CursorPosition }
  | { type: 'sync'; since: HLC };

export type WSServerMessage =
  | { type: 'subscribed'; pageId: string; presence: PresenceInfo[] }
  | { type: 'operation'; operation: Operation }
  | { type: 'ack'; operationId: string }
  | { type: 'presence'; data: PresenceEvent }
  | { type: 'sync'; operations: Operation[] }
  | { type: 'error'; message: string };

export interface CursorPosition {
  blockId: string;
  offset: number;
}

export interface PresenceInfo {
  userId: string;
  name: string;
  color: string;
  cursor?: CursorPosition;
}

export type PresenceEvent =
  | { action: 'join'; userId: string; name: string; color: string }
  | { action: 'leave'; userId: string }
  | { action: 'cursor'; userId: string; cursor: CursorPosition };

// === API Response Types ===
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  cursor?: string;
  hasMore: boolean;
}
```

---

### 3. High-Level Architecture (4 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend (React)                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ BlockEditor │  │  PageTree   │  │DatabaseView │  │  Presence   │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐        │
│  │                         Zustand Stores                          │        │
│  │  (blockStore, pageStore, presenceStore, syncStore)             │        │
│  └────────────────────────────┬───────────────────────────────────┘        │
│                               │                                            │
│  ┌────────────────────────────┴───────────────────────────────────┐        │
│  │                     Sync Engine (useSync hook)                  │        │
│  │  - Operation queue    - HLC management    - Optimistic updates │        │
│  └───────────────┬─────────────────────────┬──────────────────────┘        │
│                  │                         │                               │
│          ┌───────┴───────┐         ┌───────┴───────┐                       │
│          │  REST Client  │         │ WebSocket     │                       │
│          │  (api.ts)     │         │ Client        │                       │
│          └───────────────┘         └───────────────┘                       │
└──────────────────┼─────────────────────────┼───────────────────────────────┘
                   │                         │
                   ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Backend (Node.js)                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         Express + WebSocket Server                     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                      │                                       │
│  ┌───────────────┬───────────────────┼───────────────────┬───────────────┐  │
│  │               │                   │                   │               │  │
│  ▼               ▼                   ▼                   ▼               ▼  │
│ PageService  BlockService      SyncService        CacheService    QueueService│
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                              Data Layer                                │  │
│  │  PostgreSQL (primary)  │  Redis (cache + pub/sub)  │  RabbitMQ (async)│  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

### 4. Sync Engine - Frontend (8 minutes)

```typescript
// frontend/src/sync/SyncEngine.ts
import { HLC, Operation, WSClientMessage, WSServerMessage } from '../../../shared/types';

class HybridLogicalClock {
  private timestamp = 0;
  private counter = 0;
  private nodeId: string;

  constructor() {
    this.nodeId = crypto.randomUUID();
  }

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

  receive(remote: HLC): void {
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
  }

  get current(): HLC {
    return {
      timestamp: this.timestamp,
      counter: this.counter,
      nodeId: this.nodeId
    };
  }
}

export class SyncEngine {
  private ws: WebSocket | null = null;
  private clock = new HybridLogicalClock();
  private pendingOperations: Map<string, Operation> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private currentPageId: string | null = null;

  constructor(
    private wsUrl: string,
    private handlers: {
      onOperation: (op: Operation) => void;
      onPresence: (event: PresenceEvent) => void;
      onSync: (operations: Operation[]) => void;
      onConnected: () => void;
      onDisconnected: () => void;
    }
  ) {}

  connect(): void {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.handlers.onConnected();

      // Resubscribe if we were on a page
      if (this.currentPageId) {
        this.subscribe(this.currentPageId);
      }

      // Resend pending operations
      for (const op of this.pendingOperations.values()) {
        this.sendOperation(op);
      }
    };

    this.ws.onmessage = (event) => {
      const message: WSServerMessage = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = () => {
      this.handlers.onDisconnected();
      this.attemptReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private handleMessage(message: WSServerMessage): void {
    switch (message.type) {
      case 'operation':
        this.clock.receive(message.operation.hlc);
        this.handlers.onOperation(message.operation);
        break;

      case 'ack':
        this.pendingOperations.delete(message.operationId);
        break;

      case 'presence':
        this.handlers.onPresence(message.data);
        break;

      case 'sync':
        message.operations.forEach(op => this.clock.receive(op.hlc));
        this.handlers.onSync(message.operations);
        break;

      case 'subscribed':
        // Initial presence is handled by the component
        break;

      case 'error':
        console.error('WebSocket error:', message.message);
        break;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    setTimeout(() => this.connect(), delay);
  }

  subscribe(pageId: string): void {
    this.currentPageId = pageId;
    this.send({ type: 'subscribe', pageId });
  }

  unsubscribe(): void {
    this.currentPageId = null;
    this.send({ type: 'unsubscribe' });
  }

  // Create and send operation with optimistic update
  createOperation(
    type: Operation['type'],
    blockId: string,
    pageId: string,
    payload: Operation['payload'],
    authorId: string
  ): Operation {
    const operation: Operation = {
      id: crypto.randomUUID(),
      type,
      blockId,
      pageId,
      payload,
      hlc: this.clock.now(),
      authorId
    };

    // Track as pending
    this.pendingOperations.set(operation.id, operation);

    // Send to server
    this.sendOperation(operation);

    return operation;
  }

  private sendOperation(operation: Operation): void {
    this.send({ type: 'operation', operation });
  }

  updateCursor(cursor: CursorPosition): void {
    this.send({ type: 'cursor', cursor });
  }

  requestSync(since: HLC): void {
    this.send({ type: 'sync', since });
  }

  private send(message: WSClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  disconnect(): void {
    this.ws?.close();
  }

  get hasPendingOperations(): boolean {
    return this.pendingOperations.size > 0;
  }
}
```

#### React Hook for Sync

```typescript
// frontend/src/hooks/useSync.ts
import { useEffect, useRef, useCallback } from 'react';
import { SyncEngine } from '../sync/SyncEngine';
import { useBlockStore } from '../stores/blockStore';
import { usePresenceStore } from '../stores/presenceStore';
import { Operation, OperationPayload, Block, RichText } from '../../../shared/types';

export function useSync(pageId: string | null, userId: string) {
  const syncRef = useRef<SyncEngine | null>(null);
  const { applyOperation, getBlock, updateBlockOptimistic, addBlockOptimistic, deleteBlockOptimistic } = useBlockStore();
  const { addUser, removeUser, updateCursor } = usePresenceStore();

  useEffect(() => {
    const sync = new SyncEngine(
      `${import.meta.env.VITE_WS_URL}/sync`,
      {
        onOperation: (op) => {
          // Skip our own operations (already applied optimistically)
          if (op.authorId === userId) return;
          applyOperation(op);
        },
        onPresence: (event) => {
          switch (event.action) {
            case 'join':
              addUser(event.userId, event.name, event.color);
              break;
            case 'leave':
              removeUser(event.userId);
              break;
            case 'cursor':
              updateCursor(event.userId, event.cursor);
              break;
          }
        },
        onSync: (operations) => {
          // Apply all missed operations
          operations.forEach(applyOperation);
        },
        onConnected: () => console.log('Connected to sync server'),
        onDisconnected: () => console.log('Disconnected from sync server')
      }
    );

    sync.connect();
    syncRef.current = sync;

    return () => sync.disconnect();
  }, [userId]);

  // Subscribe to page when it changes
  useEffect(() => {
    if (pageId && syncRef.current) {
      syncRef.current.subscribe(pageId);
    }

    return () => {
      syncRef.current?.unsubscribe();
    };
  }, [pageId]);

  // Operation creators with optimistic updates
  const insertBlock = useCallback((
    parentId: string | null,
    position: string,
    blockType: string,
    content: RichText[] = []
  ) => {
    if (!pageId || !syncRef.current) return null;

    const blockId = crypto.randomUUID();
    const payload: OperationPayload = {
      type: 'insert',
      parentId,
      position,
      blockType: blockType as any,
      content
    };

    // Optimistic update
    const newBlock: Block = {
      id: blockId,
      type: blockType as any,
      parentId,
      pageId,
      position,
      properties: {},
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: userId,
      version: 1
    };
    addBlockOptimistic(newBlock);

    // Send operation
    syncRef.current.createOperation('insert', blockId, pageId, payload, userId);

    return blockId;
  }, [pageId, userId, addBlockOptimistic]);

  const updateBlock = useCallback((
    blockId: string,
    updates: { properties?: Record<string, unknown>; content?: RichText[] }
  ) => {
    if (!pageId || !syncRef.current) return;

    const payload: OperationPayload = {
      type: 'update',
      ...updates
    };

    // Optimistic update
    updateBlockOptimistic(blockId, updates);

    // Send operation
    syncRef.current.createOperation('update', blockId, pageId, payload, userId);
  }, [pageId, userId, updateBlockOptimistic]);

  const deleteBlock = useCallback((blockId: string) => {
    if (!pageId || !syncRef.current) return;

    const payload: OperationPayload = { type: 'delete' };

    // Optimistic delete
    deleteBlockOptimistic(blockId);

    // Send operation
    syncRef.current.createOperation('delete', blockId, pageId, payload, userId);
  }, [pageId, userId, deleteBlockOptimistic]);

  const moveBlock = useCallback((
    blockId: string,
    newParentId: string | null,
    newPosition: string
  ) => {
    if (!pageId || !syncRef.current) return;

    const payload: OperationPayload = {
      type: 'move',
      newParentId,
      newPosition
    };

    // Optimistic update
    updateBlockOptimistic(blockId, { parentId: newParentId, position: newPosition });

    // Send operation
    syncRef.current.createOperation('move', blockId, pageId, payload, userId);
  }, [pageId, userId, updateBlockOptimistic]);

  const sendCursor = useCallback((blockId: string, offset: number) => {
    syncRef.current?.updateCursor({ blockId, offset });
  }, []);

  return {
    insertBlock,
    updateBlock,
    deleteBlock,
    moveBlock,
    sendCursor,
    hasPendingChanges: syncRef.current?.hasPendingOperations ?? false
  };
}
```

---

### 5. Sync Engine - Backend (8 minutes)

```typescript
// backend/src/sync/SyncService.ts
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Operation, HLC, Block } from '../../../shared/types';

export class SyncService {
  constructor(
    private db: Pool,
    private redis: Redis,
    private nodeId: string
  ) {}

  async applyOperation(op: Operation): Promise<void> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // Apply based on operation type
      switch (op.payload.type) {
        case 'insert':
          await this.handleInsert(client, op);
          break;
        case 'update':
          await this.handleUpdate(client, op);
          break;
        case 'delete':
          await this.handleDelete(client, op);
          break;
        case 'move':
          await this.handleMove(client, op);
          break;
      }

      // Persist operation for history/sync
      await this.persistOperation(client, op);

      await client.query('COMMIT');

      // Invalidate cache
      await this.invalidateCache(op.pageId, op.blockId);

      // Broadcast to other servers via Redis pub/sub
      await this.broadcastOperation(op);

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async handleInsert(client: any, op: Operation): Promise<void> {
    const { parentId, position, blockType, content } = op.payload as {
      type: 'insert';
      parentId: string | null;
      position: string;
      blockType: string;
      content: any[];
    };

    await client.query(`
      INSERT INTO blocks (id, page_id, parent_id, type, position, content, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
    `, [op.blockId, op.pageId, parentId, blockType, position, JSON.stringify(content), op.authorId]);
  }

  private async handleUpdate(client: any, op: Operation): Promise<void> {
    const { properties, content } = op.payload as {
      type: 'update';
      properties?: Record<string, unknown>;
      content?: any[];
    };

    // Last-write-wins: only apply if this operation is newer
    const result = await client.query(`
      UPDATE blocks
      SET
        properties = CASE WHEN $1::jsonb IS NOT NULL THEN $1::jsonb ELSE properties END,
        content = CASE WHEN $2::jsonb IS NOT NULL THEN $2::jsonb ELSE content END,
        updated_at = NOW(),
        version = version + 1
      WHERE id = $3
        AND NOT EXISTS (
          SELECT 1 FROM operations
          WHERE block_id = $3
            AND type = 'update'
            AND (hlc_timestamp > $4 OR (hlc_timestamp = $4 AND hlc_counter > $5))
        )
      RETURNING id
    `, [
      properties ? JSON.stringify(properties) : null,
      content ? JSON.stringify(content) : null,
      op.blockId,
      op.hlc.timestamp,
      op.hlc.counter
    ]);

    if (result.rowCount === 0) {
      console.log(`Update for block ${op.blockId} was superseded`);
    }
  }

  private async handleDelete(client: any, op: Operation): Promise<void> {
    // Soft delete with cascading to children
    await client.query(`
      WITH RECURSIVE block_tree AS (
        SELECT id FROM blocks WHERE id = $1
        UNION ALL
        SELECT b.id FROM blocks b
        JOIN block_tree bt ON b.parent_id = bt.id
      )
      UPDATE blocks
      SET deleted_at = NOW()
      WHERE id IN (SELECT id FROM block_tree)
    `, [op.blockId]);
  }

  private async handleMove(client: any, op: Operation): Promise<void> {
    const { newParentId, newPosition } = op.payload as {
      type: 'move';
      newParentId: string | null;
      newPosition: string;
    };

    await client.query(`
      UPDATE blocks
      SET parent_id = $1, position = $2, updated_at = NOW()
      WHERE id = $3
    `, [newParentId, newPosition, op.blockId]);
  }

  private async persistOperation(client: any, op: Operation): Promise<void> {
    await client.query(`
      INSERT INTO operations (id, page_id, block_id, type, payload, hlc_timestamp, hlc_counter, node_id, author_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      op.id,
      op.pageId,
      op.blockId,
      op.type,
      JSON.stringify(op.payload),
      op.hlc.timestamp,
      op.hlc.counter,
      op.hlc.nodeId,
      op.authorId
    ]);
  }

  private async invalidateCache(pageId: string, blockId: string): Promise<void> {
    await this.redis.del(
      `page:${pageId}:blocks`,
      `block:${blockId}`
    );
  }

  private async broadcastOperation(op: Operation): Promise<void> {
    await this.redis.publish(
      `page:${op.pageId}:ops`,
      JSON.stringify(op)
    );
  }

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
        timestamp: Number(row.hlc_timestamp),
        counter: row.hlc_counter,
        nodeId: row.node_id
      },
      authorId: row.author_id
    }));
  }
}
```

#### WebSocket Handler

```typescript
// backend/src/sync/WebSocketHandler.ts
import { WebSocket, WebSocketServer } from 'ws';
import { Redis } from 'ioredis';
import { SyncService } from './SyncService';
import { WSClientMessage, WSServerMessage, PresenceInfo } from '../../../shared/types';

interface Client {
  ws: WebSocket;
  userId: string;
  userName: string;
  userColor: string;
  pageId: string | null;
  cursor?: { blockId: string; offset: number };
}

export class WebSocketHandler {
  private clients = new Map<string, Client>();
  private pageSubscribers = new Map<string, Set<string>>();
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
    this.setupWebSocket();
  }

  private setupRedisSubscription(): void {
    this.redisSub.psubscribe('page:*:ops', 'page:*:presence');

    this.redisSub.on('pmessage', (_pattern, channel, message) => {
      const [, pageId, type] = channel.split(':');
      const data = JSON.parse(message);

      const subscribers = this.pageSubscribers.get(pageId);
      if (!subscribers) return;

      const serverMessage: WSServerMessage = type === 'ops'
        ? { type: 'operation', operation: data }
        : { type: 'presence', data };

      for (const clientId of subscribers) {
        const client = this.clients.get(clientId);
        if (client?.ws.readyState === WebSocket.OPEN) {
          // Don't send operation back to originator
          if (type === 'ops' && data.authorId === client.userId) continue;
          client.ws.send(JSON.stringify(serverMessage));
        }
      }
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws, req) => {
      // Extract user info from auth (simplified)
      const userId = req.headers['x-user-id'] as string;
      const userName = req.headers['x-user-name'] as string || 'Anonymous';
      const userColor = this.generateColor(userId);

      const clientId = crypto.randomUUID();
      this.clients.set(clientId, {
        ws,
        userId,
        userName,
        userColor,
        pageId: null
      });

      ws.on('message', async (data) => {
        try {
          const message: WSClientMessage = JSON.parse(data.toString());
          await this.handleMessage(clientId, message);
        } catch (error) {
          this.sendError(ws, 'Invalid message format');
        }
      });

      ws.on('close', () => this.handleDisconnect(clientId));
    });
  }

  private async handleMessage(clientId: string, message: WSClientMessage): Promise<void> {
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

    // Unsubscribe from previous page
    if (client.pageId) {
      await this.handleUnsubscribe(clientId);
    }

    // Subscribe to new page
    client.pageId = pageId;

    if (!this.pageSubscribers.has(pageId)) {
      this.pageSubscribers.set(pageId, new Set());
    }
    this.pageSubscribers.get(pageId)!.add(clientId);

    // Get current presence
    const presence = this.getPagePresence(pageId);

    // Send subscription confirmation with presence
    client.ws.send(JSON.stringify({
      type: 'subscribed',
      pageId,
      presence
    } as WSServerMessage));

    // Announce join to others
    await this.redisPub.publish(`page:${pageId}:presence`, JSON.stringify({
      action: 'join',
      userId: client.userId,
      name: client.userName,
      color: client.userColor
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
    client.cursor = undefined;
  }

  private async handleOperation(clientId: string, operation: any): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || !client.pageId) return;

    try {
      // Apply operation through sync service
      await this.syncService.applyOperation(operation);

      // Acknowledge to sender
      client.ws.send(JSON.stringify({
        type: 'ack',
        operationId: operation.id
      } as WSServerMessage));

    } catch (error) {
      this.sendError(client.ws, 'Failed to apply operation');
    }
  }

  private async handleCursor(clientId: string, cursor: { blockId: string; offset: number }): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || !client.pageId) return;

    client.cursor = cursor;

    // Broadcast cursor to page subscribers
    await this.redisPub.publish(`page:${client.pageId}:presence`, JSON.stringify({
      action: 'cursor',
      userId: client.userId,
      cursor
    }));
  }

  private async handleSync(clientId: string, since: any): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || !client.pageId) return;

    const operations = await this.syncService.getOperationsSince(client.pageId, since);

    client.ws.send(JSON.stringify({
      type: 'sync',
      operations
    } as WSServerMessage));
  }

  private getPagePresence(pageId: string): PresenceInfo[] {
    const subscribers = this.pageSubscribers.get(pageId);
    if (!subscribers) return [];

    const presence: PresenceInfo[] = [];
    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client) {
        presence.push({
          userId: client.userId,
          name: client.userName,
          color: client.userColor,
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

  private sendError(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ type: 'error', message } as WSServerMessage));
  }

  private generateColor(userId: string): string {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];
    const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  }
}
```

---

### 6. Page API - Full Stack Flow (5 minutes)

#### Backend API

```typescript
// backend/src/routes/pages.ts
import { Router } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Page, Block, ApiResponse, PaginatedResponse } from '../../../shared/types';
import { authMiddleware } from '../middleware/auth';

export function createPageRoutes(db: Pool, redis: Redis) {
  const router = Router();

  // Get page with blocks
  router.get('/:pageId', authMiddleware, async (req, res) => {
    const { pageId } = req.params;
    const userId = req.user!.id;

    try {
      // Check cache first
      const cached = await redis.get(`page:${pageId}:full`);
      if (cached) {
        return res.json({ success: true, data: JSON.parse(cached) });
      }

      // Load page
      const pageResult = await db.query(`
        SELECT p.*, w.name as workspace_name
        FROM pages p
        JOIN workspaces w ON p.workspace_id = w.id
        JOIN workspace_members wm ON w.id = wm.workspace_id
        WHERE p.id = $1 AND wm.user_id = $2 AND p.deleted_at IS NULL
      `, [pageId, userId]);

      if (pageResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Page not found' });
      }

      const page = pageResult.rows[0];

      // Load blocks
      const blocksResult = await db.query(`
        SELECT * FROM blocks
        WHERE page_id = $1 AND deleted_at IS NULL
        ORDER BY position
      `, [pageId]);

      const data = {
        page: mapPage(page),
        blocks: blocksResult.rows.map(mapBlock)
      };

      // Cache for 5 minutes
      await redis.setex(`page:${pageId}:full`, 300, JSON.stringify(data));

      res.json({ success: true, data } as ApiResponse<typeof data>);

    } catch (error) {
      console.error('Failed to get page:', error);
      res.status(500).json({ success: false, error: 'Failed to get page' });
    }
  });

  // Create page
  router.post('/', authMiddleware, async (req, res) => {
    const { workspaceId, parentId, title, icon } = req.body;
    const userId = req.user!.id;

    try {
      // Get position for new page
      const positionResult = await db.query(`
        SELECT MAX(position) as max_pos FROM pages
        WHERE workspace_id = $1 AND parent_id ${parentId ? '= $2' : 'IS NULL'}
      `, parentId ? [workspaceId, parentId] : [workspaceId]);

      const maxPos = positionResult.rows[0].max_pos || 'a';
      const position = incrementPosition(maxPos);

      const result = await db.query(`
        INSERT INTO pages (workspace_id, parent_id, title, icon, position, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [workspaceId, parentId, title || 'Untitled', icon, position, userId]);

      const page = mapPage(result.rows[0]);

      // Create initial empty text block
      await db.query(`
        INSERT INTO blocks (page_id, type, position, content, created_by)
        VALUES ($1, 'text', 'a', '[]', $2)
      `, [page.id, userId]);

      // Invalidate workspace pages cache
      await redis.del(`workspace:${workspaceId}:pages`);

      res.status(201).json({ success: true, data: page } as ApiResponse<Page>);

    } catch (error) {
      console.error('Failed to create page:', error);
      res.status(500).json({ success: false, error: 'Failed to create page' });
    }
  });

  // Update page
  router.patch('/:pageId', authMiddleware, async (req, res) => {
    const { pageId } = req.params;
    const { title, icon, coverUrl } = req.body;
    const userId = req.user!.id;

    try {
      const result = await db.query(`
        UPDATE pages
        SET
          title = COALESCE($1, title),
          icon = COALESCE($2, icon),
          cover_url = COALESCE($3, cover_url),
          updated_at = NOW()
        WHERE id = $4
          AND EXISTS (
            SELECT 1 FROM workspace_members wm
            JOIN pages p ON p.workspace_id = wm.workspace_id
            WHERE p.id = $4 AND wm.user_id = $5
          )
        RETURNING *
      `, [title, icon, coverUrl, pageId, userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Page not found' });
      }

      const page = mapPage(result.rows[0]);

      // Invalidate caches
      await redis.del(`page:${pageId}:full`, `workspace:${page.workspaceId}:pages`);

      res.json({ success: true, data: page } as ApiResponse<Page>);

    } catch (error) {
      console.error('Failed to update page:', error);
      res.status(500).json({ success: false, error: 'Failed to update page' });
    }
  });

  return router;
}

function mapPage(row: any): Page {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    title: row.title,
    icon: row.icon,
    coverUrl: row.cover_url,
    position: row.position,
    isDatabase: row.is_database,
    databaseSchema: row.database_schema,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapBlock(row: any): Block {
  return {
    id: row.id,
    type: row.type,
    parentId: row.parent_id,
    pageId: row.page_id,
    position: row.position,
    properties: row.properties,
    content: row.content,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    version: row.version
  };
}
```

#### Frontend API Client

```typescript
// frontend/src/api/pages.ts
import { Page, Block, ApiResponse, PaginatedResponse } from '../../../shared/types';

const API_URL = import.meta.env.VITE_API_URL;

async function fetchWithAuth<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${url}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export async function getPage(pageId: string): Promise<{ page: Page; blocks: Block[] }> {
  const response = await fetchWithAuth<ApiResponse<{ page: Page; blocks: Block[] }>>(
    `/pages/${pageId}`
  );

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to get page');
  }

  return response.data;
}

export async function createPage(params: {
  workspaceId: string;
  parentId?: string;
  title?: string;
  icon?: string;
}): Promise<Page> {
  const response = await fetchWithAuth<ApiResponse<Page>>('/pages', {
    method: 'POST',
    body: JSON.stringify(params)
  });

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to create page');
  }

  return response.data;
}

export async function updatePage(
  pageId: string,
  updates: { title?: string; icon?: string; coverUrl?: string }
): Promise<Page> {
  const response = await fetchWithAuth<ApiResponse<Page>>(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates)
  });

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to update page');
  }

  return response.data;
}

export async function getWorkspacePages(workspaceId: string): Promise<Page[]> {
  const response = await fetchWithAuth<ApiResponse<Page[]>>(
    `/workspaces/${workspaceId}/pages`
  );

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to get pages');
  }

  return response.data;
}
```

---

### 7. Offline Support (4 minutes)

```typescript
// frontend/src/sync/OfflineQueue.ts
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { Operation, Block, Page } from '../../../shared/types';

interface NotionDB extends DBSchema {
  operations: {
    key: string;
    value: Operation & { synced: boolean };
    indexes: { 'by-page': string; 'by-synced': number };
  };
  blocks: {
    key: string;
    value: Block;
    indexes: { 'by-page': string };
  };
  pages: {
    key: string;
    value: Page;
    indexes: { 'by-workspace': string };
  };
}

class OfflineStore {
  private db: IDBPDatabase<NotionDB> | null = null;

  async init(): Promise<void> {
    this.db = await openDB<NotionDB>('notion-offline', 1, {
      upgrade(db) {
        // Operations store
        const opStore = db.createObjectStore('operations', { keyPath: 'id' });
        opStore.createIndex('by-page', 'pageId');
        opStore.createIndex('by-synced', 'synced');

        // Blocks store
        const blockStore = db.createObjectStore('blocks', { keyPath: 'id' });
        blockStore.createIndex('by-page', 'pageId');

        // Pages store
        const pageStore = db.createObjectStore('pages', { keyPath: 'id' });
        pageStore.createIndex('by-workspace', 'workspaceId');
      }
    });
  }

  // Queue operation for offline sync
  async queueOperation(operation: Operation): Promise<void> {
    await this.db!.put('operations', { ...operation, synced: false });
  }

  // Get unsynced operations
  async getUnsyncedOperations(): Promise<Operation[]> {
    return this.db!.getAllFromIndex('operations', 'by-synced', 0);
  }

  // Mark operation as synced
  async markSynced(operationId: string): Promise<void> {
    const op = await this.db!.get('operations', operationId);
    if (op) {
      op.synced = true;
      await this.db!.put('operations', op);
    }
  }

  // Cache blocks for offline access
  async cacheBlocks(pageId: string, blocks: Block[]): Promise<void> {
    const tx = this.db!.transaction('blocks', 'readwrite');
    for (const block of blocks) {
      await tx.store.put(block);
    }
    await tx.done;
  }

  // Get cached blocks
  async getCachedBlocks(pageId: string): Promise<Block[]> {
    return this.db!.getAllFromIndex('blocks', 'by-page', pageId);
  }

  // Update cached block
  async updateCachedBlock(block: Block): Promise<void> {
    await this.db!.put('blocks', block);
  }

  // Cache page
  async cachePage(page: Page): Promise<void> {
    await this.db!.put('pages', page);
  }

  // Get cached page
  async getCachedPage(pageId: string): Promise<Page | undefined> {
    return this.db!.get('pages', pageId);
  }
}

export const offlineStore = new OfflineStore();

// Hook for offline-aware data loading
export function useOfflineData(pageId: string) {
  const [data, setData] = useState<{ page: Page; blocks: Block[] } | null>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    async function loadData() {
      setIsLoading(true);

      try {
        if (navigator.onLine) {
          // Load from server
          const serverData = await getPage(pageId);
          setData(serverData);

          // Cache for offline
          await offlineStore.cachePage(serverData.page);
          await offlineStore.cacheBlocks(pageId, serverData.blocks);
        } else {
          // Load from cache
          const [page, blocks] = await Promise.all([
            offlineStore.getCachedPage(pageId),
            offlineStore.getCachedBlocks(pageId)
          ]);

          if (page) {
            setData({ page, blocks });
          }
        }
      } catch (error) {
        // Fallback to cache on error
        const [page, blocks] = await Promise.all([
          offlineStore.getCachedPage(pageId),
          offlineStore.getCachedBlocks(pageId)
        ]);

        if (page) {
          setData({ page, blocks });
        }
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, [pageId]);

  return { data, isOffline, isLoading };
}
```

---

### 8. Trade-offs and Decisions

| Decision | Chosen Approach | Alternative | Rationale |
|----------|----------------|-------------|-----------|
| Sync protocol | WebSocket + Redis Pub/Sub | Server-Sent Events | Bidirectional needed for operations |
| Conflict resolution | HLC + Last-Write-Wins | Full CRDT (Yjs) | Simpler, sufficient for block-level ops |
| Type sharing | Shared types package | GraphQL codegen | Explicit, no build step dependency |
| Offline storage | IndexedDB via idb | localStorage | Structured data, larger capacity |
| State updates | Optimistic with rollback | Wait for server ack | Better perceived performance |
| Cache invalidation | Event-driven (pub/sub) | TTL-only | Immediate consistency when online |

---

### 9. Future Full-Stack Enhancements

1. **Yjs integration** - Replace custom CRDT with production-grade library
2. **Collaborative cursors** - Real-time cursor position visualization
3. **Conflict UI** - Show conflicts and allow user resolution
4. **Background sync** - Service worker for true offline-first
5. **Operational transforms** - For character-level text editing
6. **Multi-device sync** - Sync state across user devices seamlessly

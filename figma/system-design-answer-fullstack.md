# Figma - System Design Answer (Full-Stack Focus)

## 45-minute system design interview format - Full-Stack Engineer Position

## Opening Statement

"Today I'll design Figma, a real-time collaborative design platform, from a full-stack perspective. I'll focus on the integration points between frontend and backend: the WebSocket protocol for real-time sync, shared TypeScript types for type safety across the stack, the API contract for file management, and how frontend state changes flow through to PostgreSQL persistence with CRDT conflict resolution."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Real-time Collaborative Editing** - Multiple users editing the same canvas simultaneously
2. **Vector Graphics Canvas** - Create and manipulate rectangles, ellipses, text
3. **Presence System** - See collaborators' cursors and selections
4. **Version History** - Save snapshots, restore previous versions
5. **File Management** - Create, list, update, delete design files

### Non-Functional Requirements

- **Latency**: < 50ms for local operations, < 200ms for sync to collaborators
- **Consistency**: All clients converge to same state via CRDT
- **Reliability**: No data loss even with network interruptions
- **Type Safety**: Shared types prevent API contract drift

### Out of Scope

- Component library
- Prototyping/interactions
- Export functionality
- Plugin system

---

## Step 2: Full-Stack Architecture Overview (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend (React + PixiJS)                       │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌──────────────┐  │
│  │ editorStore   │  │ Canvas.tsx    │  │ useWebSocket  │  │ api.ts       │  │
│  │ (Zustand)     │  │ (PixiJS)      │  │ (Real-time)   │  │ (REST)       │  │
│  └───────┬───────┘  └───────────────┘  └───────┬───────┘  └──────┬───────┘  │
│          │                                     │                  │          │
└──────────┼─────────────────────────────────────┼──────────────────┼──────────┘
           │                                     │                  │
           │  @figma/shared-types                │ WebSocket        │ HTTP
           │  (Shared TypeScript)                │                  │
           │                                     │                  │
┌──────────┼─────────────────────────────────────┼──────────────────┼──────────┐
│          │                                     │                  │          │
│  ┌───────▼───────┐                     ┌───────▼───────┐  ┌──────▼───────┐  │
│  │ Type Imports  │                     │ wsHandler.ts  │  │ routes/      │  │
│  │ (Validation)  │                     │ (WS Server)   │  │ files.ts     │  │
│  └───────────────┘                     └───────┬───────┘  └──────┬───────┘  │
│                                                │                  │          │
│                         ┌──────────────────────┴──────────────────┤          │
│                         │                                         │          │
│                  ┌──────▼──────┐                          ┌───────▼───────┐  │
│                  │ CRDTEngine  │                          │ FileService   │  │
│                  │ (LWW Merge) │                          │               │  │
│                  └──────┬──────┘                          └───────┬───────┘  │
│                         │                                         │          │
│                         └─────────────────────┬───────────────────┘          │
│                                               │                              │
│                                       ┌───────▼───────┐                      │
│                                       │ PostgreSQL    │                      │
│                                       │ (files,       │                      │
│                                       │  operations)  │                      │
│                                       └───────────────┘                      │
│                              Backend (Express + ws)                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Deep Dive - Shared Types Package (8 minutes)

### Package Structure

```
packages/
├── shared-types/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── canvas.ts
│       ├── operations.ts
│       ├── presence.ts
│       ├── websocket.ts
│       └── api.ts
```

### Canvas Data Types

```typescript
// packages/shared-types/src/canvas.ts
import { z } from 'zod';

export const DesignObjectTypeSchema = z.enum([
  'rectangle',
  'ellipse',
  'text',
  'frame',
  'group',
  'image',
]);
export type DesignObjectType = z.infer<typeof DesignObjectTypeSchema>;

export const DesignObjectSchema = z.object({
  id: z.string().uuid(),
  type: DesignObjectTypeSchema,
  name: z.string().min(1).max(255),
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  rotation: z.number().min(-360).max(360),
  fill: z.string(),
  stroke: z.string(),
  strokeWidth: z.number().nonnegative(),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
  // Text-specific
  text: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().optional(),
});
export type DesignObject = z.infer<typeof DesignObjectSchema>;

export const CanvasDataSchema = z.object({
  objects: z.array(DesignObjectSchema),
  pages: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
  })),
});
export type CanvasData = z.infer<typeof CanvasDataSchema>;

// Partial updates for property changes
export const DesignObjectUpdateSchema = DesignObjectSchema.partial().omit({ id: true, type: true });
export type DesignObjectUpdate = z.infer<typeof DesignObjectUpdateSchema>;
```

### Operation Types

```typescript
// packages/shared-types/src/operations.ts
import { z } from 'zod';
import { DesignObjectSchema, DesignObjectUpdateSchema } from './canvas';

export const OperationTypeSchema = z.enum(['create', 'update', 'delete', 'move']);
export type OperationType = z.infer<typeof OperationTypeSchema>;

export const BaseOperationSchema = z.object({
  id: z.string().uuid(),
  fileId: z.string().uuid(),
  objectId: z.string().uuid(),
  timestamp: z.number().int().positive(),
  clientId: z.string(),
  idempotencyKey: z.string().uuid().optional(),
});

export const CreateOperationSchema = BaseOperationSchema.extend({
  operationType: z.literal('create'),
  payload: DesignObjectSchema,
});

export const UpdateOperationSchema = BaseOperationSchema.extend({
  operationType: z.literal('update'),
  payload: DesignObjectUpdateSchema,
});

export const DeleteOperationSchema = BaseOperationSchema.extend({
  operationType: z.literal('delete'),
  payload: z.object({}),
});

export const MoveOperationSchema = BaseOperationSchema.extend({
  operationType: z.literal('move'),
  payload: z.object({
    parentId: z.string().uuid().nullable(),
    index: z.number().int().nonnegative(),
  }),
});

export const OperationSchema = z.discriminatedUnion('operationType', [
  CreateOperationSchema,
  UpdateOperationSchema,
  DeleteOperationSchema,
  MoveOperationSchema,
]);
export type Operation = z.infer<typeof OperationSchema>;
```

### WebSocket Protocol Types

```typescript
// packages/shared-types/src/websocket.ts
import { z } from 'zod';
import { OperationSchema } from './operations';
import { CanvasDataSchema } from './canvas';

// Client -> Server Messages
export const SubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  payload: z.object({
    fileId: z.string().uuid(),
    userId: z.string().uuid(),
    userName: z.string(),
  }),
});

export const OperationMessageSchema = z.object({
  type: z.literal('operation'),
  payload: z.object({
    operations: z.array(OperationSchema),
  }),
});

export const PresenceMessageSchema = z.object({
  type: z.literal('presence'),
  payload: z.object({
    cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
    selection: z.array(z.string().uuid()),
  }),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  SubscribeMessageSchema,
  OperationMessageSchema,
  PresenceMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Server -> Client Messages
export const SyncMessageSchema = z.object({
  type: z.literal('sync'),
  payload: z.object({
    file: z.object({
      id: z.string().uuid(),
      name: z.string(),
      canvasData: CanvasDataSchema,
    }),
    presence: z.array(z.object({
      userId: z.string().uuid(),
      userName: z.string(),
      color: z.string(),
      cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
      selection: z.array(z.string().uuid()),
    })),
    yourColor: z.string(),
  }),
});

export const ServerOperationMessageSchema = z.object({
  type: z.literal('operation'),
  payload: z.object({
    operations: z.array(OperationSchema),
    fromUserId: z.string().uuid(),
  }),
});

export const PresenceUpdateMessageSchema = z.object({
  type: z.literal('presence'),
  payload: z.object({
    presence: z.array(z.object({
      userId: z.string().uuid(),
      userName: z.string(),
      color: z.string(),
      cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
      selection: z.array(z.string().uuid()),
    })),
    removed: z.array(z.string().uuid()),
  }),
});

export const AckMessageSchema = z.object({
  type: z.literal('ack'),
  payload: z.object({
    operationIds: z.array(z.string().uuid()),
  }),
});

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  payload: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  SyncMessageSchema,
  ServerOperationMessageSchema,
  PresenceUpdateMessageSchema,
  AckMessageSchema,
  ErrorMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
```

### API Types

```typescript
// packages/shared-types/src/api.ts
import { z } from 'zod';
import { CanvasDataSchema } from './canvas';

// File endpoints
export const FileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ownerId: z.string().uuid(),
  thumbnailUrl: z.string().nullable(),
  canvasData: CanvasDataSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type File = z.infer<typeof FileSchema>;

export const CreateFileRequestSchema = z.object({
  name: z.string().min(1).max(255),
});
export type CreateFileRequest = z.infer<typeof CreateFileRequestSchema>;

export const UpdateFileRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});
export type UpdateFileRequest = z.infer<typeof UpdateFileRequestSchema>;

// Version endpoints
export const FileVersionSchema = z.object({
  id: z.string().uuid(),
  fileId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  name: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  isAutoSave: z.boolean(),
});
export type FileVersion = z.infer<typeof FileVersionSchema>;

export const CreateVersionRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});
export type CreateVersionRequest = z.infer<typeof CreateVersionRequestSchema>;

// API Response wrapper
export const ApiResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

export const ApiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
```

---

## Step 4: Deep Dive - WebSocket Handler Integration (10 minutes)

### Backend WebSocket Handler with Type Safety

```typescript
// backend/src/websocket/wsHandler.ts
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import {
  ClientMessage,
  ClientMessageSchema,
  ServerMessage,
  CanvasData,
  Operation,
} from '@figma/shared-types';
import { pool } from '../shared/db';
import { redis, pubsub } from '../shared/redis';
import { CRDTEngine } from '../services/crdtEngine';

interface Client {
  ws: WebSocket;
  userId: string;
  userName: string;
  fileId: string | null;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
}

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD'];

export class CollaborationServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, Client>();
  private fileClients = new Map<string, Set<WebSocket>>();
  private crdtEngine: CRDTEngine;

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.crdtEngine = new CRDTEngine();

    this.wss.on('connection', this.handleConnection.bind(this));
    this.setupRedisPubSub();
  }

  private handleConnection(ws: WebSocket): void {
    const client: Client = {
      ws,
      userId: '',
      userName: '',
      fileId: null,
      color: COLORS[this.clients.size % COLORS.length],
      cursor: null,
      selection: [],
    };

    this.clients.set(ws, client);

    ws.on('message', async (data) => {
      try {
        const raw = JSON.parse(data.toString());
        const result = ClientMessageSchema.safeParse(raw);

        if (!result.success) {
          this.sendError(ws, 'INVALID_MESSAGE', 'Message validation failed');
          return;
        }

        await this.handleMessage(ws, result.data);
      } catch (err) {
        this.sendError(ws, 'PARSE_ERROR', 'Failed to parse message');
      }
    });

    ws.on('close', () => this.handleDisconnect(ws));
  }

  private async handleMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const client = this.clients.get(ws)!;

    switch (message.type) {
      case 'subscribe':
        await this.handleSubscribe(ws, client, message.payload);
        break;
      case 'operation':
        await this.handleOperation(ws, client, message.payload.operations);
        break;
      case 'presence':
        this.handlePresence(ws, client, message.payload);
        break;
    }
  }

  private async handleSubscribe(
    ws: WebSocket,
    client: Client,
    payload: { fileId: string; userId: string; userName: string }
  ): Promise<void> {
    // Leave previous file if any
    if (client.fileId) {
      this.removeFromFile(ws, client.fileId);
    }

    client.userId = payload.userId;
    client.userName = payload.userName;
    client.fileId = payload.fileId;

    // Add to file room
    if (!this.fileClients.has(payload.fileId)) {
      this.fileClients.set(payload.fileId, new Set());
    }
    this.fileClients.get(payload.fileId)!.add(ws);

    // Load file from database
    const fileResult = await pool.query(
      'SELECT id, name, canvas_data FROM files WHERE id = $1 AND deleted_at IS NULL',
      [payload.fileId]
    );

    if (fileResult.rows.length === 0) {
      this.sendError(ws, 'FILE_NOT_FOUND', 'File does not exist');
      return;
    }

    const file = fileResult.rows[0];

    // Store presence in Redis
    await redis.hset(
      `presence:${payload.fileId}`,
      client.userId,
      JSON.stringify({
        userName: client.userName,
        color: client.color,
        cursor: null,
        selection: [],
      })
    );
    await redis.expire(`presence:${payload.fileId}`, 3600);

    // Get current presence
    const presenceData = await this.getFilePresence(payload.fileId);

    // Send sync message
    const syncMessage: ServerMessage = {
      type: 'sync',
      payload: {
        file: {
          id: file.id,
          name: file.name,
          canvasData: file.canvas_data,
        },
        presence: presenceData,
        yourColor: client.color,
      },
    };

    ws.send(JSON.stringify(syncMessage));

    // Notify others of new user
    this.broadcastPresence(payload.fileId, ws);
  }

  private async handleOperation(
    ws: WebSocket,
    client: Client,
    operations: Operation[]
  ): Promise<void> {
    if (!client.fileId) {
      this.sendError(ws, 'NOT_SUBSCRIBED', 'Not subscribed to a file');
      return;
    }

    const processedOps: Operation[] = [];

    for (const op of operations) {
      // Check idempotency
      if (op.idempotencyKey) {
        const exists = await redis.set(
          `idempotency:${op.idempotencyKey}`,
          '1',
          'NX',
          'EX',
          300
        );
        if (!exists) {
          continue; // Already processed
        }
      }

      // Persist operation
      await pool.query(
        `INSERT INTO operations
         (id, file_id, user_id, operation_type, object_id, new_value, timestamp, client_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          op.id,
          client.fileId,
          client.userId,
          op.operationType,
          op.objectId,
          JSON.stringify(op.payload),
          op.timestamp,
          op.clientId,
          op.idempotencyKey,
        ]
      );

      // Apply to current canvas state
      const file = await pool.query(
        'SELECT canvas_data FROM files WHERE id = $1',
        [client.fileId]
      );

      const newCanvasData = this.crdtEngine.applyOperation(
        file.rows[0].canvas_data,
        op
      );

      await pool.query(
        'UPDATE files SET canvas_data = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(newCanvasData), client.fileId]
      );

      processedOps.push(op);
    }

    // Acknowledge to sender
    const ackMessage: ServerMessage = {
      type: 'ack',
      payload: { operationIds: processedOps.map(o => o.id) },
    };
    ws.send(JSON.stringify(ackMessage));

    // Broadcast to other clients
    const broadcastMessage: ServerMessage = {
      type: 'operation',
      payload: {
        operations: processedOps,
        fromUserId: client.userId,
      },
    };

    this.broadcastToFile(client.fileId, broadcastMessage, ws);

    // Publish to Redis for cross-server sync
    await pubsub.publish(
      `file:${client.fileId}:operations`,
      JSON.stringify({
        operations: processedOps,
        fromUserId: client.userId,
        excludeServer: process.env.SERVER_ID,
      })
    );
  }

  private handlePresence(
    ws: WebSocket,
    client: Client,
    payload: { cursor: { x: number; y: number } | null; selection: string[] }
  ): void {
    if (!client.fileId) return;

    client.cursor = payload.cursor;
    client.selection = payload.selection;

    // Update Redis
    redis.hset(
      `presence:${client.fileId}`,
      client.userId,
      JSON.stringify({
        userName: client.userName,
        color: client.color,
        cursor: payload.cursor,
        selection: payload.selection,
      })
    );

    // Broadcast to others
    this.broadcastPresence(client.fileId, ws);
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) return;

    if (client.fileId) {
      // Remove from Redis presence
      await redis.hdel(`presence:${client.fileId}`, client.userId);

      // Notify others
      const presenceMessage: ServerMessage = {
        type: 'presence',
        payload: {
          presence: await this.getFilePresence(client.fileId),
          removed: [client.userId],
        },
      };
      this.broadcastToFile(client.fileId, presenceMessage, ws);

      this.removeFromFile(ws, client.fileId);
    }

    this.clients.delete(ws);
  }

  private removeFromFile(ws: WebSocket, fileId: string): void {
    const clients = this.fileClients.get(fileId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        this.fileClients.delete(fileId);
      }
    }
  }

  private async getFilePresence(fileId: string) {
    const presenceHash = await redis.hgetall(`presence:${fileId}`);
    return Object.entries(presenceHash).map(([userId, data]) => ({
      userId,
      ...JSON.parse(data),
    }));
  }

  private broadcastPresence(fileId: string, exclude?: WebSocket): void {
    this.getFilePresence(fileId).then((presence) => {
      const message: ServerMessage = {
        type: 'presence',
        payload: { presence, removed: [] },
      };
      this.broadcastToFile(fileId, message, exclude);
    });
  }

  private broadcastToFile(fileId: string, message: ServerMessage, exclude?: WebSocket): void {
    const clients = this.fileClients.get(fileId);
    if (!clients) return;

    const data = JSON.stringify(message);
    for (const ws of clients) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    const errorMessage: ServerMessage = {
      type: 'error',
      payload: { code, message },
    };
    ws.send(JSON.stringify(errorMessage));
  }

  private setupRedisPubSub(): void {
    // Subscribe to operation broadcasts from other servers
    pubsub.psubscribe('file:*:operations');

    pubsub.on('pmessage', (pattern, channel, message) => {
      const [, fileId] = channel.split(':');
      const data = JSON.parse(message);

      if (data.excludeServer === process.env.SERVER_ID) return;

      const broadcastMessage: ServerMessage = {
        type: 'operation',
        payload: {
          operations: data.operations,
          fromUserId: data.fromUserId,
        },
      };

      this.broadcastToFile(fileId, broadcastMessage);
    });
  }
}
```

---

## Step 5: Deep Dive - REST API with Validation (8 minutes)

### File Routes

```typescript
// backend/src/routes/files.ts
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  CreateFileRequestSchema,
  UpdateFileRequestSchema,
  FileSchema,
  CanvasDataSchema,
} from '@figma/shared-types';
import { pool } from '../shared/db';

const router = Router();

// List files
router.get('/', async (req: Request, res: Response) => {
  const result = await pool.query(`
    SELECT id, name, owner_id, thumbnail_url, canvas_data, created_at, updated_at
    FROM files
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
  `);

  const files = result.rows.map(row => ({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    thumbnailUrl: row.thumbnail_url,
    canvasData: row.canvas_data,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));

  // Validate response
  const validated = z.array(FileSchema).parse(files);

  res.json({ success: true, data: validated });
});

// Get single file
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const result = await pool.query(
    `SELECT id, name, owner_id, thumbnail_url, canvas_data, created_at, updated_at
     FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'File not found' },
    });
  }

  const row = result.rows[0];
  const file = FileSchema.parse({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    thumbnailUrl: row.thumbnail_url,
    canvasData: row.canvas_data,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });

  res.json({ success: true, data: file });
});

// Create file
router.post('/', async (req: Request, res: Response) => {
  const parseResult = CreateFileRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parseResult.error.message },
    });
  }

  const { name } = parseResult.data;
  const id = randomUUID();
  const ownerId = req.user?.id ?? randomUUID(); // From auth middleware

  const initialCanvas = CanvasDataSchema.parse({ objects: [], pages: [] });

  const result = await pool.query(
    `INSERT INTO files (id, name, owner_id, canvas_data)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, owner_id, thumbnail_url, canvas_data, created_at, updated_at`,
    [id, name, ownerId, JSON.stringify(initialCanvas)]
  );

  const row = result.rows[0];
  const file = FileSchema.parse({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    thumbnailUrl: row.thumbnail_url,
    canvasData: row.canvas_data,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });

  res.status(201).json({ success: true, data: file });
});

// Update file
router.patch('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const parseResult = UpdateFileRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parseResult.error.message },
    });
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (parseResult.data.name) {
    updates.push(`name = $${idx++}`);
    values.push(parseResult.data.name);
  }

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_UPDATES', message: 'No fields to update' },
    });
  }

  updates.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE files SET ${updates.join(', ')}
     WHERE id = $${idx} AND deleted_at IS NULL
     RETURNING id, name, owner_id, thumbnail_url, canvas_data, created_at, updated_at`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'File not found' },
    });
  }

  const row = result.rows[0];
  const file = FileSchema.parse({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    thumbnailUrl: row.thumbnail_url,
    canvasData: row.canvas_data,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });

  res.json({ success: true, data: file });
});

// Delete file (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const result = await pool.query(
    `UPDATE files SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'File not found' },
    });
  }

  res.status(204).send();
});

export default router;
```

### Version Routes

```typescript
// backend/src/routes/versions.ts
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { CreateVersionRequestSchema, FileVersionSchema } from '@figma/shared-types';
import { pool } from '../shared/db';

const router = Router({ mergeParams: true });

// List versions
router.get('/', async (req: Request, res: Response) => {
  const { fileId } = req.params;

  const result = await pool.query(
    `SELECT id, file_id, version_number, name, created_by, created_at, is_auto_save
     FROM file_versions
     WHERE file_id = $1
     ORDER BY version_number DESC`,
    [fileId]
  );

  const versions = result.rows.map(row =>
    FileVersionSchema.parse({
      id: row.id,
      fileId: row.file_id,
      versionNumber: row.version_number,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      isAutoSave: row.is_auto_save,
    })
  );

  res.json({ success: true, data: versions });
});

// Create version (snapshot)
router.post('/', async (req: Request, res: Response) => {
  const { fileId } = req.params;

  const parseResult = CreateVersionRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parseResult.error.message },
    });
  }

  // Get current file state
  const fileResult = await pool.query(
    'SELECT canvas_data FROM files WHERE id = $1 AND deleted_at IS NULL',
    [fileId]
  );

  if (fileResult.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'File not found' },
    });
  }

  // Get next version number
  const versionResult = await pool.query(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM file_versions WHERE file_id = $1',
    [fileId]
  );
  const nextVersion = versionResult.rows[0].next;

  // Insert version
  const id = randomUUID();
  const userId = req.user?.id ?? null;

  const insertResult = await pool.query(
    `INSERT INTO file_versions (id, file_id, version_number, name, canvas_data, created_by, is_auto_save)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, file_id, version_number, name, created_by, created_at, is_auto_save`,
    [id, fileId, nextVersion, parseResult.data.name ?? null, fileResult.rows[0].canvas_data, userId, false]
  );

  const row = insertResult.rows[0];
  const version = FileVersionSchema.parse({
    id: row.id,
    fileId: row.file_id,
    versionNumber: row.version_number,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    isAutoSave: row.is_auto_save,
  });

  res.status(201).json({ success: true, data: version });
});

// Restore version
router.post('/:versionId/restore', async (req: Request, res: Response) => {
  const { fileId, versionId } = req.params;

  // Get version canvas data
  const versionResult = await pool.query(
    'SELECT canvas_data FROM file_versions WHERE id = $1 AND file_id = $2',
    [versionId, fileId]
  );

  if (versionResult.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Version not found' },
    });
  }

  // Update file with version's canvas data
  await pool.query(
    'UPDATE files SET canvas_data = $1, updated_at = NOW() WHERE id = $2',
    [versionResult.rows[0].canvas_data, fileId]
  );

  res.json({ success: true, data: { restored: true } });
});

export default router;
```

---

## Step 6: Deep Dive - Frontend API Client (5 minutes)

### Type-Safe API Client

```typescript
// frontend/src/services/api.ts
import {
  File,
  FileVersion,
  CreateFileRequest,
  UpdateFileRequest,
  CreateVersionRequest,
  FileSchema,
  FileVersionSchema,
} from '@figma/shared-types';
import { z } from 'zod';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  schema?: z.ZodType<T>
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new ApiError(
      data.error?.code || 'UNKNOWN',
      data.error?.message || 'Request failed',
      response.status
    );
  }

  // Validate response with schema if provided
  if (schema) {
    return schema.parse(data.data);
  }

  return data.data;
}

export const filesApi = {
  list: () => request<File[]>('/files', {}, z.array(FileSchema)),

  get: (id: string) => request<File>(`/files/${id}`, {}, FileSchema),

  create: (data: CreateFileRequest) =>
    request<File>('/files', {
      method: 'POST',
      body: JSON.stringify(data),
    }, FileSchema),

  update: (id: string, data: UpdateFileRequest) =>
    request<File>(`/files/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, FileSchema),

  delete: (id: string) =>
    request<void>(`/files/${id}`, { method: 'DELETE' }),
};

export const versionsApi = {
  list: (fileId: string) =>
    request<FileVersion[]>(
      `/files/${fileId}/versions`,
      {},
      z.array(FileVersionSchema)
    ),

  create: (fileId: string, data?: CreateVersionRequest) =>
    request<FileVersion>(
      `/files/${fileId}/versions`,
      {
        method: 'POST',
        body: JSON.stringify(data || {}),
      },
      FileVersionSchema
    ),

  restore: (fileId: string, versionId: string) =>
    request<{ restored: boolean }>(
      `/files/${fileId}/versions/${versionId}/restore`,
      { method: 'POST' },
      z.object({ restored: z.boolean() })
    ),
};
```

### Using the API in Components

```typescript
// frontend/src/components/FileBrowser.tsx
import { useState, useEffect } from 'react';
import { File } from '@figma/shared-types';
import { filesApi } from '../services/api';

export function FileBrowser({ onOpenFile }: { onOpenFile: (id: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadFiles();
  }, []);

  async function loadFiles() {
    try {
      setLoading(true);
      const data = await filesApi.list();
      setFiles(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    const name = prompt('Enter file name:');
    if (!name) return;

    try {
      const file = await filesApi.create({ name });
      setFiles(prev => [file, ...prev]);
      onOpenFile(file.id);
    } catch (err) {
      alert('Failed to create file');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this file?')) return;

    try {
      await filesApi.delete(id);
      setFiles(prev => prev.filter(f => f.id !== id));
    } catch (err) {
      alert('Failed to delete file');
    }
  }

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">My Files</h1>
        <button
          onClick={handleCreate}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          New File
        </button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {files.map(file => (
          <div
            key={file.id}
            className="border rounded-lg overflow-hidden cursor-pointer hover:shadow-lg"
            onClick={() => onOpenFile(file.id)}
          >
            <div className="aspect-video bg-gray-100">
              {file.thumbnailUrl && (
                <img src={file.thumbnailUrl} alt="" className="w-full h-full object-cover" />
              )}
            </div>
            <div className="p-3 flex justify-between items-center">
              <span className="font-medium truncate">{file.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(file.id); }}
                className="text-gray-400 hover:text-red-500"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Step 7: CRDT Engine Implementation (5 minutes)

### Last-Writer-Wins CRDT Engine

```typescript
// backend/src/services/crdtEngine.ts
import { CanvasData, Operation, DesignObject } from '@figma/shared-types';

export class CRDTEngine {
  applyOperation(canvasData: CanvasData, operation: Operation): CanvasData {
    const result: CanvasData = JSON.parse(JSON.stringify(canvasData));

    switch (operation.operationType) {
      case 'create':
        result.objects.push(operation.payload as DesignObject);
        break;

      case 'update':
        const updateIdx = result.objects.findIndex(o => o.id === operation.objectId);
        if (updateIdx !== -1) {
          Object.assign(result.objects[updateIdx], operation.payload);
        }
        break;

      case 'delete':
        result.objects = result.objects.filter(o => o.id !== operation.objectId);
        break;

      case 'move':
        // Handle move operations (reordering in layer stack)
        const moveIdx = result.objects.findIndex(o => o.id === operation.objectId);
        if (moveIdx !== -1) {
          const [obj] = result.objects.splice(moveIdx, 1);
          result.objects.splice(operation.payload.index, 0, obj);
        }
        break;
    }

    return result;
  }

  mergeStates(local: CanvasData, remote: CanvasData, operations: Operation[]): CanvasData {
    // Sort operations by timestamp for LWW
    const sortedOps = [...operations].sort((a, b) => a.timestamp - b.timestamp);

    let result = local;
    for (const op of sortedOps) {
      result = this.applyOperation(result, op);
    }

    return result;
  }

  resolveConflict(
    localValue: unknown,
    remoteValue: unknown,
    localTimestamp: number,
    remoteTimestamp: number,
    localClientId: string,
    remoteClientId: string
  ): unknown {
    // Last-Writer-Wins: higher timestamp wins
    if (remoteTimestamp > localTimestamp) {
      return remoteValue;
    }
    if (localTimestamp > remoteTimestamp) {
      return localValue;
    }
    // Tie-breaker: lexicographically higher client ID wins
    return remoteClientId > localClientId ? remoteValue : localValue;
  }
}
```

---

## Step 8: Trade-offs and Decisions (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Shared types package | Build complexity vs. type safety across stack |
| Zod validation on both ends | Runtime overhead vs. contract enforcement |
| WebSocket for all real-time | More complex than polling, but lower latency |
| LWW CRDT | Simple but can lose concurrent edits |
| JSONB for canvas data | Flexible but no referential integrity |

### Alternatives Considered

1. **GraphQL instead of REST + WebSocket**
   - Single protocol, subscriptions built-in
   - More complex setup, overkill for this use case

2. **tRPC for type sharing**
   - Automatic type inference
   - Less flexible for non-TypeScript clients

3. **Yjs/Automerge for CRDT**
   - More robust conflict resolution
   - Larger dependency, more complex

---

## Closing Summary

"I've designed the full-stack architecture for a Figma-like design tool with:

1. **Shared Types Package** - Zod schemas used for validation on frontend, backend, and WebSocket messages
2. **WebSocket Handler** - Type-safe message handling with Redis pub/sub for multi-server support
3. **REST API** - CRUD operations with request/response validation
4. **Type-Safe API Client** - Frontend client with runtime type checking
5. **CRDT Engine** - Last-Writer-Wins conflict resolution for concurrent edits

The key insight is using a shared types package with Zod to ensure type safety at runtime across the entire stack, preventing API contract drift. Happy to dive deeper into any integration point."

---

## Future Enhancements

1. **tRPC Migration** - Replace REST with tRPC for automatic type inference
2. **WebSocket Reconnection Queue** - Queue operations during disconnect
3. **Optimistic UI** - Apply operations locally before server confirmation
4. **Conflict Visualization** - Show users when their changes conflict
5. **E2E Type Testing** - Automated tests verifying API contracts

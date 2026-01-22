# Collaborative Editor - System Design Answer (Fullstack Focus)

## 45-minute system design interview format - Fullstack Engineer Position

## Opening Statement (1 minute)

"I'll design a real-time collaborative document editor like Google Docs, where multiple users can simultaneously edit the same document and see each other's changes instantly. As a fullstack engineer, I'll focus on the end-to-end implementation: shared type definitions, the WebSocket sync protocol connecting frontend and backend, and the Operational Transformation algorithm that runs on both sides. The key challenges are ensuring type safety across the stack, maintaining consistent document state with concurrent edits, and providing instant feedback while handling network unreliability."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Edit**: Multiple users edit document simultaneously
- **Sync**: Real-time updates visible to all editors with < 50ms local latency
- **History**: Version history with restore capability
- **Presence**: See who's editing and their cursor positions
- **Share**: Control document access and permissions

### Non-Functional Requirements
- **Latency**: < 50ms for local changes to appear
- **Consistency**: All clients converge to same state
- **Scale**: Support 50+ simultaneous editors per document
- **Durability**: Never lose user edits

### Integration Points (Fullstack Focus)
- WebSocket protocol with typed messages
- Shared OT types running on both client and server
- API contracts with runtime validation
- Optimistic updates with server reconciliation

## High-Level Architecture (5 minutes)

```
+------------------------------------------------------------------+
|                     Shared Types Layer                             |
|  +------------------+  +------------------+  +-----------------+  |
|  |  types/          |  |  validation/     |  |  ot/            |  |
|  |  operations.ts   |  |  schemas.ts      |  |  transform.ts   |  |
|  |  messages.ts     |  |  (Zod schemas)   |  |  compose.ts     |  |
|  |  document.ts     |  |                  |  |  apply.ts       |  |
|  +------------------+  +------------------+  +-----------------+  |
+------------------------------------------------------------------+
           |                     |                      |
           v                     v                      v
+---------------------------+         +---------------------------+
|       Frontend            |         |        Backend            |
|  +-------------------+    |         |    +------------------+   |
|  |  CollaborativeEditor  |    |  WS  |    |  SyncServer      |   |
|  |  - ContentEditable    |<---------->|  - DocumentState   |   |
|  |  - useSyncEngine      |    |         |  - OTTransformer  |   |
|  +-------------------+    |         |    +------------------+   |
|                           |         |            |              |
|  +-------------------+    |         |    +------------------+   |
|  |  editorStore      |    |         |    |  PostgreSQL      |   |
|  |  (Zustand + OT)   |    |         |    |  + Redis         |   |
|  +-------------------+    |         |    +------------------+   |
+---------------------------+         +---------------------------+
```

## Deep Dive: Shared Type Definitions (6 minutes)

### Operation Types

```typescript
// shared/types/operations.ts
export type Op =
  | { retain: number }
  | { insert: string; attributes?: Record<string, unknown> }
  | { delete: number };

export interface TextOperation {
  ops: Op[];
  baseLength: number;
  targetLength: number;
}

export interface OperationMetadata {
  operationId: string;
  clientId: string;
  userId: string;
  timestamp: number;
}

export interface VersionedOperation {
  version: number;
  operation: TextOperation;
  metadata: OperationMetadata;
}
```

### WebSocket Message Protocol

```typescript
// shared/types/messages.ts
// Client -> Server messages
export type ClientMessage =
  | { type: 'operation'; version: number; operationId: string; operation: TextOperation }
  | { type: 'cursor'; position: number }
  | { type: 'selection'; start: number; end: number }
  | { type: 'ping' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'init'; clientId: string; version: number; content: string; clients: ClientInfo[] }
  | { type: 'ack'; operationId: string; version: number }
  | { type: 'operation'; clientId: string; version: number; operation: TextOperation }
  | { type: 'cursor'; clientId: string; position: number }
  | { type: 'selection'; clientId: string; start: number; end: number }
  | { type: 'client_join'; clientId: string; userId: string; color: string }
  | { type: 'client_leave'; clientId: string }
  | { type: 'resync'; version: number; content: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

export interface ClientInfo {
  clientId: string;
  userId: string;
  displayName: string;
  color: string;
  cursor: number | null;
  selection: { start: number; end: number } | null;
}
```

### Document Types

```typescript
// shared/types/document.ts
export interface Document {
  id: string;
  title: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentAccess {
  documentId: string;
  userId: string;
  permission: 'view' | 'edit' | 'admin';
}

export interface DocumentVersion {
  version: number;
  content: string;
  createdAt: string;
  author: {
    id: string;
    displayName: string;
  } | null;
}
```

## Deep Dive: Zod Validation Schemas (5 minutes)

```typescript
// shared/validation/schemas.ts
import { z } from 'zod';

// Operation validation
const opSchema = z.union([
  z.object({ retain: z.number().int().positive() }),
  z.object({
    insert: z.string().min(1),
    attributes: z.record(z.unknown()).optional(),
  }),
  z.object({ delete: z.number().int().positive() }),
]);

export const textOperationSchema = z.object({
  ops: z.array(opSchema).min(1),
  baseLength: z.number().int().nonnegative(),
  targetLength: z.number().int().nonnegative(),
});

// Message validation
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('operation'),
    version: z.number().int().nonnegative(),
    operationId: z.string().min(1),
    operation: textOperationSchema,
  }),
  z.object({
    type: z.literal('cursor'),
    position: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('selection'),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('ping') }),
]);

// API request validation
export const createDocumentSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().default(''),
});

export const shareDocumentSchema = z.object({
  userId: z.string().uuid(),
  permission: z.enum(['view', 'edit', 'admin']),
});

export const restoreVersionSchema = z.object({
  version: z.number().int().positive(),
});

// Type inference from schemas
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type ShareDocumentInput = z.infer<typeof shareDocumentSchema>;
export type RestoreVersionInput = z.infer<typeof restoreVersionSchema>;
```

## Deep Dive: Shared OT Implementation (7 minutes)

### TextOperation Class

```typescript
// shared/ot/TextOperation.ts
import type { Op, TextOperation as ITextOperation } from '../types/operations';

export class TextOperation implements ITextOperation {
  ops: Op[] = [];
  baseLength = 0;
  targetLength = 0;

  retain(n: number): this {
    if (n <= 0) return this;
    this.baseLength += n;
    this.targetLength += n;

    const lastOp = this.ops[this.ops.length - 1];
    if (lastOp && 'retain' in lastOp) {
      lastOp.retain += n;
    } else {
      this.ops.push({ retain: n });
    }
    return this;
  }

  insert(str: string, attributes?: Record<string, unknown>): this {
    if (str.length === 0) return this;
    this.targetLength += str.length;

    const op: Op = { insert: str };
    if (attributes && Object.keys(attributes).length > 0) {
      (op as { insert: string; attributes: Record<string, unknown> }).attributes = attributes;
    }
    this.ops.push(op);
    return this;
  }

  delete(n: number): this {
    if (n <= 0) return this;
    this.baseLength += n;

    const lastOp = this.ops[this.ops.length - 1];
    if (lastOp && 'delete' in lastOp) {
      lastOp.delete += n;
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
      if ('retain' in op) {
        result += document.slice(index, index + op.retain);
        index += op.retain;
      } else if ('insert' in op) {
        result += op.insert;
      } else if ('delete' in op) {
        index += op.delete;
      }
    }

    return result;
  }

  toJSON(): ITextOperation {
    return {
      ops: this.ops,
      baseLength: this.baseLength,
      targetLength: this.targetLength,
    };
  }

  static fromJSON(json: ITextOperation): TextOperation {
    const op = new TextOperation();
    op.ops = json.ops;
    op.baseLength = json.baseLength;
    op.targetLength = json.targetLength;
    return op;
  }
}
```

### OT Transform Function

```typescript
// shared/ot/transform.ts
import { TextOperation } from './TextOperation';
import type { Op } from '../types/operations';

export function transform(
  op1: TextOperation,
  op2: TextOperation
): [TextOperation, TextOperation] {
  if (op1.baseLength !== op2.baseLength) {
    throw new Error('Both operations must have the same base length');
  }

  const op1Prime = new TextOperation();
  const op2Prime = new TextOperation();

  const ops1 = [...op1.ops];
  const ops2 = [...op2.ops];
  let i1 = 0, i2 = 0;

  while (i1 < ops1.length || i2 < ops2.length) {
    const o1 = ops1[i1];
    const o2 = ops2[i2];

    // Insert in op1 goes first (consistent ordering)
    if (o1 && 'insert' in o1) {
      op1Prime.insert(o1.insert, (o1 as { attributes?: Record<string, unknown> }).attributes);
      op2Prime.retain(o1.insert.length);
      i1++;
      continue;
    }

    // Insert in op2 goes next
    if (o2 && 'insert' in o2) {
      op1Prime.retain(o2.insert.length);
      op2Prime.insert(o2.insert, (o2 as { attributes?: Record<string, unknown> }).attributes);
      i2++;
      continue;
    }

    if (!o1 && !o2) break;

    // Both retain
    if (o1 && 'retain' in o1 && o2 && 'retain' in o2) {
      const minLen = Math.min(o1.retain, o2.retain);
      op1Prime.retain(minLen);
      op2Prime.retain(minLen);

      if (o1.retain > o2.retain) {
        ops1[i1] = { retain: o1.retain - o2.retain };
        i2++;
      } else if (o1.retain < o2.retain) {
        ops2[i2] = { retain: o2.retain - o1.retain };
        i1++;
      } else {
        i1++;
        i2++;
      }
      continue;
    }

    // Both delete same text
    if (o1 && 'delete' in o1 && o2 && 'delete' in o2) {
      const minLen = Math.min(o1.delete, o2.delete);

      if (o1.delete > o2.delete) {
        ops1[i1] = { delete: o1.delete - o2.delete };
        i2++;
      } else if (o1.delete < o2.delete) {
        ops2[i2] = { delete: o2.delete - o1.delete };
        i1++;
      } else {
        i1++;
        i2++;
      }
      continue;
    }

    // op1 deletes, op2 retains
    if (o1 && 'delete' in o1 && o2 && 'retain' in o2) {
      const minLen = Math.min(o1.delete, o2.retain);
      op1Prime.delete(minLen);

      if (o1.delete > o2.retain) {
        ops1[i1] = { delete: o1.delete - o2.retain };
        i2++;
      } else if (o1.delete < o2.retain) {
        ops2[i2] = { retain: o2.retain - o1.delete };
        i1++;
      } else {
        i1++;
        i2++;
      }
      continue;
    }

    // op1 retains, op2 deletes
    if (o1 && 'retain' in o1 && o2 && 'delete' in o2) {
      const minLen = Math.min(o1.retain, o2.delete);
      op2Prime.delete(minLen);

      if (o1.retain > o2.delete) {
        ops1[i1] = { retain: o1.retain - o2.delete };
        i2++;
      } else if (o1.retain < o2.delete) {
        ops2[i2] = { delete: o2.delete - o1.retain };
        i1++;
      } else {
        i1++;
        i2++;
      }
    }
  }

  return [op1Prime, op2Prime];
}
```

### OT Compose Function

```typescript
// shared/ot/compose.ts
import { TextOperation } from './TextOperation';

export function compose(op1: TextOperation, op2: TextOperation): TextOperation {
  if (op1.targetLength !== op2.baseLength) {
    throw new Error('Compose length mismatch: op1.target must equal op2.base');
  }

  const composed = new TextOperation();
  const ops1 = [...op1.ops];
  const ops2 = [...op2.ops];
  let i1 = 0, i2 = 0;

  while (i1 < ops1.length || i2 < ops2.length) {
    const o1 = ops1[i1];
    const o2 = ops2[i2];

    // Delete from op1 comes first
    if (o1 && 'delete' in o1) {
      composed.delete(o1.delete);
      i1++;
      continue;
    }

    // Insert from op2 comes first
    if (o2 && 'insert' in o2) {
      composed.insert(o2.insert, (o2 as { attributes?: Record<string, unknown> }).attributes);
      i2++;
      continue;
    }

    if (!o1 && !o2) break;

    // Insert from op1 + retain from op2
    if (o1 && 'insert' in o1 && o2 && 'retain' in o2) {
      const minLen = Math.min(o1.insert.length, o2.retain);
      composed.insert(o1.insert.slice(0, minLen));

      if (o1.insert.length > o2.retain) {
        ops1[i1] = { insert: o1.insert.slice(o2.retain) };
        i2++;
      } else if (o1.insert.length < o2.retain) {
        ops2[i2] = { retain: o2.retain - o1.insert.length };
        i1++;
      } else {
        i1++;
        i2++;
      }
      continue;
    }

    // Insert from op1 + delete from op2
    if (o1 && 'insert' in o1 && o2 && 'delete' in o2) {
      const minLen = Math.min(o1.insert.length, o2.delete);

      if (o1.insert.length > o2.delete) {
        ops1[i1] = { insert: o1.insert.slice(o2.delete) };
        i2++;
      } else if (o1.insert.length < o2.delete) {
        ops2[i2] = { delete: o2.delete - o1.insert.length };
        i1++;
      } else {
        i1++;
        i2++;
      }
      continue;
    }

    // Retain from op1 + retain from op2
    if (o1 && 'retain' in o1 && o2 && 'retain' in o2) {
      const minLen = Math.min(o1.retain, o2.retain);
      composed.retain(minLen);

      if (o1.retain > o2.retain) {
        ops1[i1] = { retain: o1.retain - o2.retain };
        i2++;
      } else if (o1.retain < o2.retain) {
        ops2[i2] = { retain: o2.retain - o1.retain };
        i1++;
      } else {
        i1++;
        i2++;
      }
      continue;
    }

    // Retain from op1 + delete from op2
    if (o1 && 'retain' in o1 && o2 && 'delete' in o2) {
      const minLen = Math.min(o1.retain, o2.delete);
      composed.delete(minLen);

      if (o1.retain > o2.delete) {
        ops1[i1] = { retain: o1.retain - o2.delete };
        i2++;
      } else if (o1.retain < o2.delete) {
        ops2[i2] = { delete: o2.delete - o1.retain };
        i1++;
      } else {
        i1++;
        i2++;
      }
    }
  }

  return composed;
}
```

## Deep Dive: API Client Layer (5 minutes)

```typescript
// frontend/src/api/client.ts
import type {
  Document,
  DocumentVersion,
  CreateDocumentInput,
  ShareDocumentInput,
} from '@collab-editor/shared';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new ApiError(response.status, error.code || 'UNKNOWN', error.message);
  }

  return response.json();
}

export const api = {
  documents: {
    list: () => request<Document[]>('/documents'),

    get: (id: string) => request<Document>(`/documents/${id}`),

    create: (data: CreateDocumentInput) =>
      request<Document>('/documents', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    update: (id: string, data: Partial<CreateDocumentInput>) =>
      request<Document>(`/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    delete: (id: string) =>
      request<void>(`/documents/${id}`, { method: 'DELETE' }),

    share: (id: string, data: ShareDocumentInput) =>
      request<void>(`/documents/${id}/share`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    getVersions: (id: string, limit = 50) =>
      request<DocumentVersion[]>(`/documents/${id}/versions?limit=${limit}`),

    getVersion: (id: string, version: number) =>
      request<DocumentVersion>(`/documents/${id}/versions/${version}`),

    restoreVersion: (id: string, version: number) =>
      request<{ newVersion: number }>(`/documents/${id}/restore`, {
        method: 'POST',
        body: JSON.stringify({ version }),
      }),
  },

  auth: {
    me: () => request<{ id: string; displayName: string; email: string }>('/auth/me'),

    logout: () => request<void>('/auth/logout', { method: 'POST' }),
  },
};
```

## Deep Dive: End-to-End Sync Flow (6 minutes)

### Client Sync Engine

```typescript
// frontend/src/hooks/useSyncEngine.ts
import { useEffect, useRef, useCallback } from 'react';
import { useEditorStore } from '../stores/editorStore';
import { TextOperation, transform, compose } from '@collab-editor/shared';
import type { ClientMessage, ServerMessage } from '@collab-editor/shared';

export function useSyncEngine(documentId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();

  const {
    setContent,
    setVersion,
    setClientId,
    setClients,
    applyRemoteOperation,
    getInflightOp,
    setInflightOp,
    getPendingOps,
    clearPendingOps,
    addPendingOp,
  } = useEditorStore();

  const connect = useCallback(() => {
    const ws = new WebSocket(
      `${import.meta.env.VITE_WS_URL}/doc/${documentId}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      const message: ServerMessage = JSON.parse(event.data);
      handleMessage(message);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      reconnectTimeoutRef.current = window.setTimeout(connect, 1000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [documentId]);

  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'init':
        setClientId(message.clientId);
        setVersion(message.version);
        setContent(message.content);
        setClients(message.clients);
        break;

      case 'ack': {
        setVersion(message.version);
        setInflightOp(null);
        flushPending();
        break;
      }

      case 'operation': {
        let remoteOp = TextOperation.fromJSON(message.operation);
        setVersion(message.version);

        // Transform against inflight operation
        const inflightOp = getInflightOp();
        if (inflightOp) {
          const [remotePrime, inflightPrime] = transform(remoteOp, inflightOp);
          remoteOp = remotePrime;
          setInflightOp(inflightPrime);
        }

        // Transform against all pending operations
        const pendingOps = getPendingOps();
        const newPending: TextOperation[] = [];
        for (const pending of pendingOps) {
          const [remotePrime, pendingPrime] = transform(remoteOp, pending);
          remoteOp = remotePrime;
          newPending.push(pendingPrime);
        }
        clearPendingOps();
        newPending.forEach(addPendingOp);

        // Apply to editor
        applyRemoteOperation(remoteOp);
        break;
      }

      case 'cursor':
        useEditorStore.getState().updateRemoteCursor(
          message.clientId,
          message.position
        );
        break;

      case 'client_join':
        useEditorStore.getState().addClient({
          clientId: message.clientId,
          userId: message.userId,
          color: message.color,
          displayName: message.userId,
          cursor: null,
          selection: null,
        });
        break;

      case 'client_leave':
        useEditorStore.getState().removeClient(message.clientId);
        break;

      case 'resync':
        setVersion(message.version);
        setContent(message.content);
        setInflightOp(null);
        clearPendingOps();
        break;

      case 'error':
        console.error('Server error:', message.code, message.message);
        break;
    }
  }, []);

  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const sendOperation = useCallback((operation: TextOperation) => {
    const version = useEditorStore.getState().version;
    const operationId = generateOperationId();

    // Compose with existing pending if any
    const pending = getPendingOps();
    if (pending.length > 0) {
      const last = pending.pop()!;
      addPendingOp(compose(last, operation));
    } else {
      addPendingOp(operation);
    }

    flushPending();
  }, []);

  const flushPending = useCallback(() => {
    const inflightOp = getInflightOp();
    const pending = getPendingOps();

    if (inflightOp !== null || pending.length === 0) {
      return;
    }

    // Compose all pending into one
    let op = pending[0];
    for (let i = 1; i < pending.length; i++) {
      op = compose(op, pending[i]);
    }

    setInflightOp(op);
    clearPendingOps();

    const version = useEditorStore.getState().version;
    send({
      type: 'operation',
      version,
      operationId: generateOperationId(),
      operation: op.toJSON(),
    });
  }, [send]);

  const sendCursor = useCallback((position: number) => {
    send({ type: 'cursor', position });
  }, [send]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { sendOperation, sendCursor };
}

function generateOperationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
```

### Server WebSocket Handler

```typescript
// backend/src/sync/websocketHandler.ts
import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { TextOperation, transform, compose } from '@collab-editor/shared';
import { clientMessageSchema } from '@collab-editor/shared';
import type { ClientMessage, ServerMessage } from '@collab-editor/shared';
import { DocumentState } from './DocumentState';
import { redis } from '../shared/redis';
import { logger } from '../shared/logger';
import { publishOperation } from '../shared/queue';

const documents = new Map<string, DocumentState>();
const clients = new Map<WebSocket, { documentId: string; clientId: string; userId: string }>();

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const documentId = extractDocumentId(req.url);
    const userId = await authenticateRequest(req);

    if (!documentId || !userId) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const clientId = generateClientId();
    const color = generateColor(clientId);

    // Load or get document state
    let docState = documents.get(documentId);
    if (!docState) {
      docState = new DocumentState(documentId);
      await docState.load();
      documents.set(documentId, docState);
    }

    // Register client
    clients.set(ws, { documentId, clientId, userId });
    docState.addClient(clientId, { userId, color, cursor: null });

    // Send initial state
    sendMessage(ws, {
      type: 'init',
      clientId,
      version: docState.version,
      content: docState.content,
      clients: Array.from(docState.clients.entries()).map(([id, info]) => ({
        clientId: id,
        userId: info.userId,
        displayName: info.userId,
        color: info.color,
        cursor: info.cursor,
        selection: info.selection,
      })),
    });

    // Broadcast join
    broadcastToDocument(documentId, {
      type: 'client_join',
      clientId,
      userId,
      color,
    }, ws);

    logger.info({
      event: 'ws_connect',
      documentId,
      clientId,
      userId,
    });

    // Handle messages
    ws.on('message', async (data) => {
      try {
        const raw = JSON.parse(data.toString());
        const result = clientMessageSchema.safeParse(raw);

        if (!result.success) {
          sendMessage(ws, {
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: 'Invalid message format',
          });
          return;
        }

        await handleMessage(ws, docState!, clientId, result.data);
      } catch (error) {
        logger.error({ event: 'message_error', error });
        sendMessage(ws, {
          type: 'error',
          code: 'INTERNAL_ERROR',
          message: 'Internal error',
        });
      }
    });

    ws.on('close', () => {
      handleDisconnect(ws);
    });
  });
}

async function handleMessage(
  ws: WebSocket,
  docState: DocumentState,
  clientId: string,
  message: ClientMessage
) {
  switch (message.type) {
    case 'operation': {
      const operation = TextOperation.fromJSON(message.operation);
      const result = await docState.applyOperation(
        clientId,
        message.version,
        message.operationId,
        operation
      );

      if (result.duplicate) {
        // Idempotent response
        sendMessage(ws, {
          type: 'ack',
          operationId: message.operationId,
          version: result.version,
        });
        return;
      }

      // Acknowledge to sender
      sendMessage(ws, {
        type: 'ack',
        operationId: message.operationId,
        version: result.version,
      });

      // Broadcast to local clients
      broadcastToDocument(docState.documentId, {
        type: 'operation',
        clientId,
        version: result.version,
        operation: result.operation.toJSON(),
      }, ws);

      // Publish to RabbitMQ for cross-server broadcast
      await publishOperation(docState.documentId, result.operation, result.version);
      break;
    }

    case 'cursor': {
      docState.updateCursor(clientId, message.position);
      await redis.hset(
        `doc:${docState.documentId}:cursors`,
        clientId,
        JSON.stringify({ position: message.position, timestamp: Date.now() })
      );
      broadcastToDocument(docState.documentId, {
        type: 'cursor',
        clientId,
        position: message.position,
      }, ws);
      break;
    }

    case 'selection': {
      docState.updateSelection(clientId, message.start, message.end);
      broadcastToDocument(docState.documentId, {
        type: 'selection',
        clientId,
        start: message.start,
        end: message.end,
      }, ws);
      break;
    }

    case 'ping':
      sendMessage(ws, { type: 'pong' });
      break;
  }
}

function handleDisconnect(ws: WebSocket) {
  const client = clients.get(ws);
  if (!client) return;

  const docState = documents.get(client.documentId);
  if (docState) {
    docState.removeClient(client.clientId);

    broadcastToDocument(client.documentId, {
      type: 'client_leave',
      clientId: client.clientId,
    });

    if (docState.clients.size === 0) {
      documents.delete(client.documentId);
    }
  }

  clients.delete(ws);

  logger.info({
    event: 'ws_disconnect',
    documentId: client.documentId,
    clientId: client.clientId,
  });
}

function sendMessage(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastToDocument(
  documentId: string,
  message: ServerMessage,
  excludeWs?: WebSocket
) {
  for (const [ws, client] of clients.entries()) {
    if (client.documentId === documentId && ws !== excludeWs) {
      sendMessage(ws, message);
    }
  }
}
```

## Deep Dive: Database Schema (4 minutes)

```sql
-- PostgreSQL schema
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  owner_id UUID REFERENCES users(id) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE document_snapshots (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, version)
);

CREATE TABLE operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  client_id VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES users(id),
  operation_id VARCHAR(100) NOT NULL,
  operation JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (document_id, version),
  UNIQUE (document_id, operation_id)
);

CREATE INDEX idx_operations_doc_version ON operations(document_id, version);
CREATE INDEX idx_operations_operation_id ON operations(document_id, operation_id);

CREATE TABLE document_access (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(20) NOT NULL CHECK (permission IN ('view', 'edit', 'admin')),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);

CREATE TABLE sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  data JSONB DEFAULT '{}',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

## Trade-offs and Alternatives (3 minutes)

### 1. Shared Code vs. Separate Implementations

**Chose: Shared TypeScript package**
- Pro: Single source of truth for types and OT logic
- Pro: Compile-time guarantees across stack
- Pro: Easier refactoring
- Con: Need monorepo tooling (Turborepo, Nx)
- Alternative: Generate types from OpenAPI spec

### 2. Zod vs. io-ts vs. TypeBox

**Chose: Zod**
- Pro: Excellent TypeScript inference
- Pro: Easy to compose schemas
- Pro: Good error messages
- Con: Runtime overhead for parsing
- Alternative: TypeBox for faster validation

### 3. WebSocket vs. Server-Sent Events + HTTP POST

**Chose: WebSocket**
- Pro: True bidirectional communication
- Pro: Lower latency for operations
- Pro: Better for high-frequency updates
- Con: More complex connection management
- Alternative: SSE for simpler read-only sync

### 4. Monorepo with Shared Package vs. API-First

**Chose: Monorepo with shared package**
- Pro: Type safety across stack
- Pro: OT algorithm runs identically on client and server
- Pro: Easier testing
- Con: Build complexity
- Alternative: Duplicate OT code on both sides

## Closing Summary (1 minute)

"The collaborative editor is built around three key fullstack integration points:

1. **Shared Type Definitions** - TypeScript types and Zod schemas ensure the WebSocket protocol is type-safe. The same operation types flow from user keystrokes to database storage.

2. **Shared OT Implementation** - The transform and compose functions run identically on client and server. This eliminates bugs from divergent implementations and makes testing straightforward.

3. **End-to-End Sync Protocol** - The client state machine (synchronized, awaiting ack, awaiting with buffer) combined with server-side transformation ensures all clients converge. Idempotency keys and operation IDs enable safe retries.

The main trade-off is choosing a monorepo with shared packages over an API-first approach. The shared code eliminates type drift and ensures the OT algorithm behaves identically on both sides, which is critical for convergence."

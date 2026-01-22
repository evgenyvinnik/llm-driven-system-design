# Figma - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

### 1. Requirements Clarification (3 minutes)

**Functional Requirements:**
- Real-time collaborative editing with multiple concurrent users
- Store and retrieve vector graphics documents
- Version history with save/restore capability
- Presence tracking (cursors, selections)
- Comments anchored to design elements

**Non-Functional Requirements:**
- Latency: < 50ms for local operations, < 200ms for sync to collaborators
- Consistency: All users converge to the same document state
- Availability: 99.9% uptime with graceful degradation
- Scale: 50+ concurrent editors per file, 10M+ active files

**Backend Focus Areas:**
- CRDT implementation for conflict resolution
- WebSocket architecture for real-time sync
- PostgreSQL schema for files and operations
- Redis for presence and pub/sub
- Idempotency and failure handling

---

### 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Backend Architecture                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    Clients ──── WebSocket ────► Collaboration Server ◄──── Redis Pub/Sub    │
│                                        │                         │           │
│                                        ▼                         ▼           │
│                    ┌───────────────────────────────────┐    ┌─────────┐     │
│                    │          Operation Router          │    │ Presence│     │
│                    │   ┌───────────────────────────┐   │    │ Service │     │
│                    │   │     CRDT Engine (LWW)     │   │    └─────────┘     │
│                    │   └───────────────────────────┘   │                     │
│                    └───────────────┬───────────────────┘                     │
│                                    │                                         │
│              ┌─────────────────────┼─────────────────────┐                  │
│              │                     │                     │                  │
│              ▼                     ▼                     ▼                  │
│    ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐         │
│    │   PostgreSQL    │   │      Redis      │   │  Object Storage │         │
│    │  - files        │   │  - presence     │   │  - images       │         │
│    │  - versions     │   │  - sessions     │   │  - exports      │         │
│    │  - operations   │   │  - idempotency  │   │  - snapshots    │         │
│    └─────────────────┘   └─────────────────┘   └─────────────────┘         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Core Backend Components:**
1. **Collaboration Server**: Stateful WebSocket server managing file sessions
2. **CRDT Engine**: Last-Writer-Wins registers for property conflict resolution
3. **Operation Router**: Validates, persists, and broadcasts operations
4. **Presence Service**: Ephemeral cursor/selection tracking via Redis
5. **Version Service**: Snapshot management and history

---

### 3. Backend Deep-Dives

#### Deep-Dive A: CRDT Implementation with Last-Writer-Wins (8 minutes)

**The Concurrency Problem:**

When User A and User B simultaneously edit:
- A moves Rectangle1 to (100, 100) at timestamp 1001
- B changes Rectangle1 fill to "blue" at timestamp 1000

Both operations should succeed. But if:
- A moves Rectangle1 to (100, 100) at timestamp 1001
- B moves Rectangle1 to (200, 200) at timestamp 1002

B's operation wins (higher timestamp).

**LWW Register Implementation:**

```typescript
interface LWWValue<T> {
  value: T;
  timestamp: number;
  clientId: string;
}

class LWWRegister<T> {
  private state: LWWValue<T>;

  constructor(initialValue: T, timestamp: number, clientId: string) {
    this.state = { value: initialValue, timestamp, clientId };
  }

  get(): T {
    return this.state.value;
  }

  set(value: T, timestamp: number, clientId: string): boolean {
    if (this.shouldUpdate(timestamp, clientId)) {
      this.state = { value, timestamp, clientId };
      return true;
    }
    return false;
  }

  merge(other: LWWValue<T>): boolean {
    return this.set(other.value, other.timestamp, other.clientId);
  }

  private shouldUpdate(timestamp: number, clientId: string): boolean {
    // Higher timestamp wins
    if (timestamp > this.state.timestamp) return true;
    if (timestamp < this.state.timestamp) return false;
    // Tie-breaker: lexicographically higher clientId wins
    return clientId > this.state.clientId;
  }
}
```

**Design Object with LWW Properties:**

```typescript
interface DesignObject {
  id: string;
  type: 'rectangle' | 'ellipse' | 'text' | 'frame' | 'group';
  properties: Map<string, LWWRegister<unknown>>;
}

class DesignObjectCRDT {
  private properties: Map<string, LWWRegister<unknown>> = new Map();

  constructor(
    public readonly id: string,
    public readonly type: string
  ) {}

  setProperty(
    key: string,
    value: unknown,
    timestamp: number,
    clientId: string
  ): boolean {
    const register = this.properties.get(key);

    if (register) {
      return register.set(value, timestamp, clientId);
    }

    // New property
    this.properties.set(key, new LWWRegister(value, timestamp, clientId));
    return true;
  }

  getProperty(key: string): unknown {
    return this.properties.get(key)?.get();
  }

  merge(other: DesignObjectCRDT): void {
    for (const [key, otherRegister] of other.properties) {
      const ourRegister = this.properties.get(key);

      if (ourRegister) {
        ourRegister.merge(otherRegister['state']);
      } else {
        this.properties.set(key, otherRegister);
      }
    }
  }

  toJSON(): Record<string, unknown> {
    const obj: Record<string, unknown> = { id: this.id, type: this.type };
    for (const [key, register] of this.properties) {
      obj[key] = register.get();
    }
    return obj;
  }
}
```

**Operation Processing:**

```typescript
interface Operation {
  id: string;
  fileId: string;
  userId: string;
  clientId: string;
  operationType: 'create' | 'update' | 'delete' | 'move';
  objectId: string;
  propertyPath?: string;
  oldValue?: unknown;
  newValue?: unknown;
  timestamp: number;
  idempotencyKey: string;
}

class OperationProcessor {
  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly broadcaster: Broadcaster
  ) {}

  async processOperation(op: Operation): Promise<ProcessResult> {
    // Step 1: Idempotency check
    const isDuplicate = await this.checkIdempotency(op);
    if (isDuplicate) {
      return { success: true, duplicate: true };
    }

    // Step 2: Load current object state
    const object = await this.loadObject(op.fileId, op.objectId);

    // Step 3: Apply operation using CRDT merge
    const applied = this.applyOperation(object, op);

    if (!applied) {
      return { success: false, reason: 'operation_superseded' };
    }

    // Step 4: Persist operation and updated state
    await this.persistOperation(op, object);

    // Step 5: Mark idempotency key as processed
    await this.markProcessed(op.idempotencyKey);

    // Step 6: Broadcast to other clients
    await this.broadcaster.broadcast(op.fileId, op, op.clientId);

    return { success: true };
  }

  private applyOperation(object: DesignObjectCRDT, op: Operation): boolean {
    switch (op.operationType) {
      case 'update':
        return object.setProperty(
          op.propertyPath!,
          op.newValue,
          op.timestamp,
          op.clientId
        );
      case 'delete':
        return object.setProperty('_deleted', true, op.timestamp, op.clientId);
      default:
        return true;
    }
  }

  private async checkIdempotency(op: Operation): Promise<boolean> {
    const key = `idempotency:${op.idempotencyKey}`;
    const result = await this.redis.set(key, '1', 'NX', 'EX', 300);
    return result === null; // Already exists
  }

  private async markProcessed(idempotencyKey: string): Promise<void> {
    // Key already set in checkIdempotency, just update TTL
    await this.redis.expire(`idempotency:${idempotencyKey}`, 300);
  }
}
```

---

#### Deep-Dive B: WebSocket Collaboration Architecture (8 minutes)

**Connection Management:**

```typescript
interface FileSession {
  fileId: string;
  clients: Map<string, WebSocket>;
  canvasState: Map<string, DesignObjectCRDT>;
  presence: Map<string, PresenceState>;
  lastActivity: number;
}

interface PresenceState {
  userId: string;
  userName: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  viewport: { x: number; y: number; zoom: number };
  lastUpdate: number;
}

class CollaborationServer {
  private sessions: Map<string, FileSession> = new Map();
  private clientToFile: Map<string, string> = new Map();

  constructor(
    private readonly wss: WebSocketServer,
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly operationProcessor: OperationProcessor
  ) {
    this.wss.on('connection', this.handleConnection.bind(this));
    this.subscribeToRedis();
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = crypto.randomUUID();

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(clientId, ws, message);
      } catch (error) {
        this.sendError(ws, 'invalid_message', error.message);
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(clientId);
    });
  }

  private async handleMessage(
    clientId: string,
    ws: WebSocket,
    message: WSMessage
  ): Promise<void> {
    switch (message.type) {
      case 'subscribe':
        await this.handleSubscribe(clientId, ws, message.payload);
        break;
      case 'operation':
        await this.handleOperation(clientId, message.payload);
        break;
      case 'presence':
        await this.handlePresence(clientId, message.payload);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(clientId);
        break;
    }
  }

  private async handleSubscribe(
    clientId: string,
    ws: WebSocket,
    payload: SubscribePayload
  ): Promise<void> {
    const { fileId, userId, userName } = payload;

    // Load or create session
    let session = this.sessions.get(fileId);
    if (!session) {
      session = await this.loadSession(fileId);
      this.sessions.set(fileId, session);
    }

    // Register client
    session.clients.set(clientId, ws);
    this.clientToFile.set(clientId, fileId);

    // Assign cursor color
    const color = this.assignColor(session.presence.size);

    // Initialize presence
    session.presence.set(clientId, {
      userId,
      userName,
      color,
      cursor: null,
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      lastUpdate: Date.now()
    });

    // Send initial sync
    this.send(ws, {
      type: 'sync',
      payload: {
        file: this.serializeCanvasState(session.canvasState),
        presence: Array.from(session.presence.values()),
        yourColor: color
      }
    });

    // Broadcast presence update
    this.broadcastPresence(session, clientId);

    // Publish to Redis for multi-server
    await this.redis.publish(`file:${fileId}:presence`, JSON.stringify({
      action: 'join',
      clientId,
      presence: session.presence.get(clientId)
    }));
  }

  private async handleOperation(
    clientId: string,
    payload: OperationPayload
  ): Promise<void> {
    const fileId = this.clientToFile.get(clientId);
    if (!fileId) return;

    const session = this.sessions.get(fileId);
    if (!session) return;

    for (const op of payload.operations) {
      const result = await this.operationProcessor.processOperation({
        ...op,
        fileId,
        clientId
      });

      if (result.success && !result.duplicate) {
        // Apply to in-memory state
        this.applyToSession(session, op);
      }
    }

    // Send acknowledgment
    const ws = session.clients.get(clientId);
    if (ws) {
      this.send(ws, {
        type: 'ack',
        payload: { operationIds: payload.operations.map(op => op.id) }
      });
    }
  }

  private async handlePresence(
    clientId: string,
    payload: PresencePayload
  ): Promise<void> {
    const fileId = this.clientToFile.get(clientId);
    if (!fileId) return;

    const session = this.sessions.get(fileId);
    if (!session) return;

    const presence = session.presence.get(clientId);
    if (!presence) return;

    // Update presence state
    Object.assign(presence, {
      cursor: payload.cursor,
      selection: payload.selection,
      viewport: payload.viewport,
      lastUpdate: Date.now()
    });

    // Broadcast to other clients (throttled on client side)
    this.broadcastPresence(session, clientId);

    // Publish to Redis (fire-and-forget)
    this.redis.publish(`file:${fileId}:presence`, JSON.stringify({
      action: 'update',
      clientId,
      presence
    })).catch(() => {});
  }

  private broadcastPresence(session: FileSession, excludeClient?: string): void {
    const presenceList = Array.from(session.presence.entries())
      .filter(([id]) => id !== excludeClient)
      .map(([_, p]) => p);

    for (const [clientId, ws] of session.clients) {
      if (clientId !== excludeClient) {
        this.send(ws, {
          type: 'presence',
          payload: { presence: presenceList }
        });
      }
    }
  }
}
```

**Redis Pub/Sub for Multi-Server:**

```typescript
private async subscribeToRedis(): Promise<void> {
  const subscriber = this.redis.duplicate();
  await subscriber.psubscribe('file:*:presence', 'file:*:operation');

  subscriber.on('pmessage', (pattern, channel, message) => {
    const [_, fileId, type] = channel.split(':');
    const data = JSON.parse(message);

    const session = this.sessions.get(fileId);
    if (!session) return;

    if (type === 'operation') {
      // Apply operation from another server
      this.applyToSession(session, data.operation);
      this.broadcastToClients(session, data.operation, data.sourceClientId);
    } else if (type === 'presence') {
      // Update presence from another server
      if (data.action === 'join' || data.action === 'update') {
        session.presence.set(data.clientId, data.presence);
      } else if (data.action === 'leave') {
        session.presence.delete(data.clientId);
      }
      this.broadcastPresence(session);
    }
  });
}
```

---

#### Deep-Dive C: PostgreSQL Schema and Queries (8 minutes)

**Core Tables:**

```sql
-- Files with JSONB canvas data
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  thumbnail_url VARCHAR(500),
  canvas_data JSONB DEFAULT '{"objects": [], "pages": []}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP DEFAULT NULL
);

-- Indexes for common queries
CREATE INDEX idx_files_owner ON files(owner_id);
CREATE INDEX idx_files_team ON files(team_id);
CREATE INDEX idx_files_updated ON files(updated_at DESC);
CREATE INDEX idx_files_active ON files(id) WHERE deleted_at IS NULL;

-- Version snapshots
CREATE TABLE file_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  name VARCHAR(255),
  canvas_data JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_auto_save BOOLEAN DEFAULT TRUE,
  UNIQUE(file_id, version_number)
);

CREATE INDEX idx_versions_file ON file_versions(file_id);
CREATE INDEX idx_versions_file_number ON file_versions(file_id, version_number DESC);

-- Operations log for CRDT and audit
CREATE TABLE operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id VARCHAR(100),
  operation_type VARCHAR(100) NOT NULL,
  object_id VARCHAR(100),
  property_path VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  timestamp BIGINT NOT NULL,
  idempotency_key VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_operations_file ON operations(file_id);
CREATE INDEX idx_operations_file_timestamp ON operations(file_id, timestamp);
CREATE UNIQUE INDEX idx_operations_idempotency
  ON operations(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

**Efficient Queries:**

```typescript
class FileRepository {
  constructor(private readonly db: Pool) {}

  // Load file with recent operations for sync
  async loadFileWithOperations(
    fileId: string,
    sinceTimestamp?: number
  ): Promise<FileWithOperations> {
    const fileQuery = `
      SELECT id, name, canvas_data, updated_at
      FROM files
      WHERE id = $1 AND deleted_at IS NULL
    `;

    const opsQuery = `
      SELECT id, operation_type, object_id, property_path,
             old_value, new_value, timestamp, client_id
      FROM operations
      WHERE file_id = $1 AND ($2::bigint IS NULL OR timestamp > $2)
      ORDER BY timestamp ASC
      LIMIT 1000
    `;

    const [fileResult, opsResult] = await Promise.all([
      this.db.query(fileQuery, [fileId]),
      this.db.query(opsQuery, [fileId, sinceTimestamp ?? null])
    ]);

    if (fileResult.rows.length === 0) {
      throw new NotFoundError('File not found');
    }

    return {
      file: fileResult.rows[0],
      operations: opsResult.rows
    };
  }

  // Batch persist operations
  async persistOperations(operations: Operation[]): Promise<void> {
    if (operations.length === 0) return;

    const values = operations.map(op => [
      op.id,
      op.fileId,
      op.userId,
      op.clientId,
      op.operationType,
      op.objectId,
      op.propertyPath,
      JSON.stringify(op.oldValue),
      JSON.stringify(op.newValue),
      op.timestamp,
      op.idempotencyKey
    ]);

    const placeholders = values.map((_, i) => {
      const offset = i * 11;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4},
              $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::jsonb,
              $${offset + 9}::jsonb, $${offset + 10}, $${offset + 11})`;
    }).join(', ');

    await this.db.query(`
      INSERT INTO operations
        (id, file_id, user_id, client_id, operation_type, object_id,
         property_path, old_value, new_value, timestamp, idempotency_key)
      VALUES ${placeholders}
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
    `, values.flat());
  }

  // Update canvas data (periodic snapshot)
  async updateCanvasData(fileId: string, canvasData: CanvasData): Promise<void> {
    await this.db.query(`
      UPDATE files
      SET canvas_data = $2, updated_at = NOW()
      WHERE id = $1
    `, [fileId, JSON.stringify(canvasData)]);
  }

  // Create version snapshot
  async createVersion(
    fileId: string,
    userId: string,
    canvasData: CanvasData,
    name?: string
  ): Promise<FileVersion> {
    const result = await this.db.query(`
      INSERT INTO file_versions (file_id, version_number, name, canvas_data, created_by, is_auto_save)
      SELECT $1,
             COALESCE(MAX(version_number), 0) + 1,
             $2,
             $3,
             $4,
             $5
      FROM file_versions WHERE file_id = $1
      RETURNING id, version_number, created_at
    `, [fileId, name ?? null, JSON.stringify(canvasData), userId, !name]);

    return result.rows[0];
  }

  // Restore version
  async restoreVersion(fileId: string, versionId: string): Promise<void> {
    await this.db.query(`
      UPDATE files f
      SET canvas_data = fv.canvas_data, updated_at = NOW()
      FROM file_versions fv
      WHERE f.id = $1 AND fv.id = $2 AND fv.file_id = f.id
    `, [fileId, versionId]);
  }
}
```

---

#### Deep-Dive D: Failure Handling and Resilience (7 minutes)

**Circuit Breaker Pattern:**

```typescript
import CircuitBreaker from 'opossum';

const dbCircuitBreaker = new CircuitBreaker(
  async (query: string, params: unknown[]) => {
    return pool.query(query, params);
  },
  {
    timeout: 5000,           // 5s timeout
    errorThresholdPercentage: 50,
    resetTimeout: 10000,     // 10s before half-open
    volumeThreshold: 10
  }
);

dbCircuitBreaker.on('open', () => {
  logger.warn('Database circuit breaker opened');
  metrics.circuitBreakerState.set({ service: 'postgres' }, 1);
});

dbCircuitBreaker.on('halfOpen', () => {
  logger.info('Database circuit breaker half-open, testing...');
  metrics.circuitBreakerState.set({ service: 'postgres' }, 2);
});

dbCircuitBreaker.on('close', () => {
  logger.info('Database circuit breaker closed');
  metrics.circuitBreakerState.set({ service: 'postgres' }, 0);
});

// Usage
async function queryWithBreaker(query: string, params: unknown[]) {
  try {
    return await dbCircuitBreaker.fire(query, params);
  } catch (error) {
    if (error.name === 'OpenCircuitError') {
      throw new ServiceUnavailableError('Database temporarily unavailable');
    }
    throw error;
  }
}
```

**Retry with Exponential Backoff:**

```typescript
interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === options.maxAttempts) {
        throw error;
      }

      const delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt - 1),
        options.maxDelayMs
      ) + Math.random() * options.jitterMs;

      await sleep(delay);

      logger.warn(`Retry attempt ${attempt}/${options.maxAttempts}`, {
        error: error.message,
        delay
      });
    }
  }

  throw lastError;
}

function isRetryable(error: Error): boolean {
  // Network errors, timeouts, transient DB errors
  return (
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === '40001' || // Serialization failure
    error.code === '57P01'    // Admin shutdown
  );
}
```

**Auto-Save with Persistence Lag Handling:**

```typescript
class AutoSaveService {
  private pendingUpdates: Map<string, CanvasData> = new Map();
  private saveInProgress: Set<string> = new Set();

  constructor(
    private readonly fileRepo: FileRepository,
    private readonly versionRepo: VersionRepository
  ) {
    // Run auto-save every 30 seconds
    setInterval(() => this.flushPendingUpdates(), 30000);
  }

  queueUpdate(fileId: string, canvasData: CanvasData): void {
    this.pendingUpdates.set(fileId, canvasData);
  }

  private async flushPendingUpdates(): Promise<void> {
    const updates = Array.from(this.pendingUpdates.entries());
    this.pendingUpdates.clear();

    for (const [fileId, canvasData] of updates) {
      if (this.saveInProgress.has(fileId)) {
        // Re-queue if save already in progress
        this.pendingUpdates.set(fileId, canvasData);
        continue;
      }

      this.saveInProgress.add(fileId);

      try {
        await this.fileRepo.updateCanvasData(fileId, canvasData);
        await this.versionRepo.createAutoSave(fileId, canvasData);

        metrics.autoSavesTotal.inc({ status: 'success' });
      } catch (error) {
        logger.error('Auto-save failed', { fileId, error: error.message });
        metrics.autoSavesTotal.inc({ status: 'error' });

        // Re-queue for next cycle
        this.pendingUpdates.set(fileId, canvasData);
      } finally {
        this.saveInProgress.delete(fileId);
      }
    }
  }
}
```

---

### 4. Data Flow Example

**Operation Flow:**

```
1. Client A draws rectangle
   └─→ WS message: { type: "operation", payload: { operations: [...] } }

2. Server receives operation
   ├─→ Check idempotency key in Redis
   ├─→ Load current canvas state
   └─→ Apply CRDT merge (LWW)

3. If operation accepted:
   ├─→ Persist to operations table (batch)
   ├─→ Update in-memory session state
   ├─→ Broadcast to other clients on same server
   ├─→ Publish to Redis for other servers
   └─→ Queue canvas_data update for auto-save

4. Client B receives broadcast
   └─→ WS message: { type: "operation", payload: { ... } }

5. Periodic auto-save (every 30s)
   ├─→ Update files.canvas_data
   └─→ Create file_versions entry
```

---

### 5. Trade-offs Analysis

| Decision | Pros | Cons |
|----------|------|------|
| LWW CRDT | Simple, predictable, easy to debug | Last write wins may not match user intent |
| Stateful WebSocket servers | Low latency, in-memory state | Requires sticky sessions, harder scaling |
| JSONB for canvas_data | Flexible schema, atomic snapshots | Large file updates are expensive |
| Operations log | Full audit trail, enables replay | Storage grows with activity |
| Redis pub/sub for presence | Fire-and-forget, low latency | Not durable, requires reconnect handling |
| Idempotency via Redis | Fast deduplication, automatic expiry | 5-minute window for retries |

---

### 6. Monitoring and Metrics

```typescript
const metrics = {
  // Connection metrics
  activeConnections: new Gauge({
    name: 'figma_ws_connections',
    help: 'Active WebSocket connections'
  }),

  activeCollaborators: new Gauge({
    name: 'figma_collaborators',
    help: 'Active collaborators per file',
    labelNames: ['file_id']
  }),

  // Operation metrics
  operationsTotal: new Counter({
    name: 'figma_operations_total',
    help: 'Operations processed',
    labelNames: ['type', 'status']
  }),

  operationLatency: new Histogram({
    name: 'figma_operation_latency_ms',
    help: 'Operation processing latency',
    buckets: [5, 10, 25, 50, 100, 250, 500]
  }),

  // Sync metrics
  syncLatency: new Histogram({
    name: 'figma_sync_latency_ms',
    help: 'Time to sync operation to all clients',
    buckets: [10, 25, 50, 100, 200, 500]
  }),

  // Circuit breaker state
  circuitBreakerState: new Gauge({
    name: 'figma_circuit_breaker',
    help: '0=closed, 1=open, 2=half-open',
    labelNames: ['service']
  })
};
```

---

### 7. Future Enhancements

1. **Full CRDT Library**: Replace LWW with Yjs or Automerge for richer conflict resolution
2. **Sharding by File**: Consistent hashing to assign files to specific server instances
3. **Event Sourcing**: Store only operations, derive canvas_data on demand
4. **Offline Queue**: Server-side pending queue for disconnected clients
5. **Compression**: Delta compression for operations and versions
6. **Hot File Isolation**: Dedicated servers for files with 50+ concurrent editors

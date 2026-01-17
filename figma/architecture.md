# Figma - Collaborative Design and Prototyping Platform - Architecture Design

## System Overview

A collaborative design and prototyping platform with real-time multiplayer editing, featuring vector graphics creation, version history, and presence tracking.

## Requirements

### Functional Requirements

- Real-time collaborative editing with multiplayer cursors
- Vector graphics editing (rectangles, ellipses, text)
- Layers panel with visibility and lock controls
- Properties panel for object manipulation
- Version control and history
- File management (create, browse, delete)

### Non-Functional Requirements

- **Scalability**: Designed for local development with 2-5 concurrent users per file
- **Availability**: Handles server reconnection gracefully
- **Latency**: < 100ms for local operations, < 200ms for sync to collaborators
- **Consistency**: Last-Writer-Wins (LWW) for conflict resolution

## Capacity Estimation

For local development:

- Concurrent users: 2-5 per file
- Operations per second: ~10-50 per active session
- Storage: PostgreSQL with JSONB for canvas data
- WebSocket connections: 1 per user per file

## High-Level Architecture

```
                           ┌─────────────────────────────────┐
                           │       Frontend (React 19)       │
                           │   Canvas Editor + Zustand Store │
                           └──────────────┬──────────────────┘
                                          │
                                          │ HTTP + WebSocket
                                          ▼
                           ┌─────────────────────────────────┐
                           │    Backend (Express + WS)       │
                           │                                 │
                           │  ┌───────────┐ ┌─────────────┐ │
                           │  │ REST API  │ │  WebSocket  │ │
                           │  │ (Files,   │ │  (Real-time │ │
                           │  │ Versions) │ │  sync)      │ │
                           │  └───────────┘ └─────────────┘ │
                           └──────────────┬──────────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
           ┌────────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
           │   PostgreSQL    │   │      Redis      │   │     Redis       │
           │   (Files,       │   │    (Presence,   │   │   (Pub/Sub)     │
           │    Versions)    │   │     Sessions)   │   │                 │
           └─────────────────┘   └─────────────────┘   └─────────────────┘
```

### Core Components

1. **Frontend (React 19 + Vite + Zustand + Tailwind CSS)**
   - Canvas-based editor with 2D rendering
   - Zustand for state management
   - WebSocket hook for real-time sync
   - File browser and version history UI

2. **Backend (Node.js + Express + WebSocket)**
   - REST API for file and version management
   - WebSocket server for real-time collaboration
   - Operation processing and broadcasting

3. **PostgreSQL**
   - Files with JSONB canvas data
   - Version history with snapshots
   - Operations log for CRDT

4. **Redis**
   - Presence tracking (cursor positions, selections)
   - Pub/Sub for cross-server coordination

## Data Model

### Database Schema

```sql
-- Files
CREATE TABLE files (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  owner_id UUID,
  project_id UUID,
  team_id UUID,
  thumbnail_url VARCHAR(500),
  canvas_data JSONB,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- File versions
CREATE TABLE file_versions (
  id UUID PRIMARY KEY,
  file_id UUID REFERENCES files(id),
  version_number INTEGER,
  name VARCHAR(255),
  canvas_data JSONB,
  created_by UUID,
  created_at TIMESTAMP,
  is_auto_save BOOLEAN
);

-- Operations log
CREATE TABLE operations (
  id UUID PRIMARY KEY,
  file_id UUID REFERENCES files(id),
  user_id UUID,
  operation_type VARCHAR(100),
  object_id VARCHAR(100),
  property_path VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  timestamp BIGINT,
  client_id VARCHAR(100),
  created_at TIMESTAMP
);
```

### Canvas Data Structure

```typescript
interface CanvasData {
  objects: DesignObject[];
  pages: Page[];
}

interface DesignObject {
  id: string;
  type: 'rectangle' | 'ellipse' | 'text' | 'frame' | 'group' | 'image';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  // Text-specific
  text?: string;
  fontSize?: number;
  fontFamily?: string;
}
```

## API Design

### REST Endpoints

```
GET    /api/files                    - List all files
POST   /api/files                    - Create new file
GET    /api/files/:id                - Get file details
PATCH  /api/files/:id                - Update file name
DELETE /api/files/:id                - Delete file
GET    /api/files/:id/versions       - List version history
POST   /api/files/:id/versions       - Create named version
POST   /api/files/:id/versions/:versionId/restore - Restore version
```

### WebSocket Protocol

```typescript
// Client -> Server
{ type: "subscribe", payload: { fileId, userId, userName } }
{ type: "operation", payload: { operations: [...] } }
{ type: "presence", payload: { cursor: {x, y}, selection: [...] } }

// Server -> Client
{ type: "sync", payload: { file, presence, yourColor } }
{ type: "operation", payload: { operations: [...] } }
{ type: "presence", payload: { presence: [...], removed: [...] } }
{ type: "ack", payload: { operationIds: [...] } }
```

## Key Design Decisions

### Real-time Collaboration (Simplified CRDT)

Using Last-Writer-Wins (LWW) registers for object properties:
- Each property update includes a timestamp
- When merging, highest timestamp wins
- Ties broken by client ID

### Vector Graphics Storage

Canvas data stored as JSONB in PostgreSQL:
- Allows for flexible schema evolution
- Supports indexing for specific queries
- Simple to serialize/deserialize

### Version Control and History

- Periodic snapshots stored as full JSONB documents
- Operations logged for fine-grained history
- Named versions for user bookmarks

### Conflict Resolution

- LWW for property updates
- Server as authority for operation ordering
- Clients optimistically apply changes, reconcile on sync

## Technology Stack

- **Frontend**: React 19, Vite, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, ws (WebSocket)
- **Data Layer**: PostgreSQL 16
- **Caching/Presence**: Redis 7
- **Real-time**: Native WebSocket

## Scalability Considerations

### Single Server (Current)

- All WebSocket connections to one server
- Direct database access
- In-memory operation batching

### Multi-Server (Future)

- Sticky sessions by file_id
- Redis pub/sub for presence synchronization
- Consistent hashing for file assignment

## Monitoring and Observability

- Health check endpoint at `/health`
- Console logging for connections and operations
- Redis key TTL for presence expiration

## Security Considerations

- CORS configured for frontend origin
- Input validation on API endpoints
- Parameterized SQL queries (pg library)

## Failure Handling

### Retry Strategy with Idempotency Keys

All mutating operations use idempotency keys to ensure safe retries:

```typescript
// Client generates idempotency key per operation
interface Operation {
  idempotencyKey: string;  // UUIDv4 generated client-side
  fileId: string;
  operationType: 'create' | 'update' | 'delete';
  objectId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// Server deduplication in Redis (5-minute TTL)
async function processOperation(op: Operation): Promise<boolean> {
  const key = `idempotency:${op.idempotencyKey}`;
  const exists = await redis.set(key, '1', 'NX', 'EX', 300);
  if (!exists) {
    return false; // Already processed, skip
  }
  // Process operation...
  return true;
}
```

**Retry policy** (exponential backoff):
- Initial delay: 100ms
- Max delay: 5s
- Max attempts: 3
- Jitter: 0-100ms random addition

### Circuit Breaker Pattern

For database and Redis connections:

```typescript
// Circuit breaker states
enum CircuitState { CLOSED, OPEN, HALF_OPEN }

// Configuration for local development
const circuitConfig = {
  failureThreshold: 5,      // Open after 5 failures
  successThreshold: 2,      // Close after 2 successes in half-open
  timeout: 10000,           // 10s before trying half-open
};

// Health check endpoint reports circuit states
GET /health -> {
  postgres: { state: 'CLOSED', failures: 0 },
  redis: { state: 'CLOSED', failures: 0 },
  websocket: { connections: 3, state: 'healthy' }
}
```

### WebSocket Reconnection

Client-side reconnection with backoff:
1. Connection lost: Wait 1s, attempt reconnect
2. Still disconnected: Wait 2s, 4s, 8s (max 30s)
3. On reconnect: Re-subscribe to file, request full sync
4. Pending operations: Replay from local queue after sync

### Backup and Restore Testing

**Database backup (local development):**

```bash
# Manual backup before schema changes
pg_dump -h localhost -U postgres figma_db > backup_$(date +%Y%m%d_%H%M%S).sql

# Restore from backup
psql -h localhost -U postgres figma_db < backup_20240116_120000.sql
```

**Automated backup script (add to package.json):**

```json
{
  "scripts": {
    "db:backup": "pg_dump -h localhost -U postgres figma_db > ./backups/backup_$(date +%Y%m%d_%H%M%S).sql",
    "db:restore": "psql -h localhost -U postgres figma_db < $1"
  }
}
```

**Testing backup/restore:**
1. Create test file with several objects
2. Run `npm run db:backup`
3. Delete the file via API
4. Run `npm run db:restore` with backup file
5. Verify file and objects restored correctly

### Disaster Recovery (Local Dev)

For local development, "disaster recovery" means recovering from:
- Corrupted database: Restore from most recent backup
- Lost Redis data: Presence rebuilds on reconnect; no persistent data lost
- Crashed server: Restart with `npm run dev`; clients auto-reconnect

**Recovery checklist:**
1. Check PostgreSQL: `docker-compose ps` or `pg_isready`
2. Check Redis: `redis-cli ping`
3. Restart backend: `npm run dev`
4. Clients refresh browser to reconnect

## Data Lifecycle Policies

### Retention and TTL

| Data Type | Retention | Storage | Cleanup Method |
|-----------|-----------|---------|----------------|
| Active files | Indefinite | PostgreSQL | Manual delete |
| File versions | 90 days (auto-save) / Indefinite (named) | PostgreSQL | Scheduled job |
| Operations log | 30 days | PostgreSQL | Scheduled job |
| Presence data | 60 seconds | Redis | TTL auto-expire |
| Idempotency keys | 5 minutes | Redis | TTL auto-expire |

### Auto-save Version Cleanup

```sql
-- Delete auto-save versions older than 90 days, keeping at least 10 per file
DELETE FROM file_versions
WHERE is_auto_save = true
  AND created_at < NOW() - INTERVAL '90 days'
  AND id NOT IN (
    SELECT id FROM file_versions fv2
    WHERE fv2.file_id = file_versions.file_id
    ORDER BY created_at DESC
    LIMIT 10
  );
```

**Scheduled job (add to backend):**

```typescript
// Run daily at 3 AM via node-cron
import cron from 'node-cron';

cron.schedule('0 3 * * *', async () => {
  await cleanupOldAutoSaves();
  await cleanupOldOperations();
  console.log('Daily cleanup completed');
});
```

### Operations Log Archival

For learning purposes, operations older than 30 days are deleted rather than archived:

```sql
-- Weekly cleanup of old operations
DELETE FROM operations
WHERE created_at < NOW() - INTERVAL '30 days';
```

**Production consideration:** In production, archive to cold storage (S3 Glacier) before deletion for audit trails.

### Backfill and Replay Procedures

**Rebuilding canvas from operations (backfill):**

```typescript
async function rebuildCanvasFromOperations(fileId: string, upToTimestamp?: number): Promise<CanvasData> {
  const operations = await db.query(`
    SELECT * FROM operations
    WHERE file_id = $1
      AND ($2::bigint IS NULL OR timestamp <= $2)
    ORDER BY timestamp ASC
  `, [fileId, upToTimestamp]);

  let canvas: CanvasData = { objects: [], pages: [] };
  for (const op of operations.rows) {
    canvas = applyOperation(canvas, op);
  }
  return canvas;
}
```

**Replay procedure for debugging:**

```bash
# Export operations for a file to JSON
psql -h localhost -U postgres -d figma_db -c \
  "SELECT row_to_json(operations) FROM operations WHERE file_id='<UUID>' ORDER BY timestamp" \
  > operations_export.json

# Replay in development environment
npm run replay -- --file=operations_export.json
```

### Soft Delete Implementation

Files use soft delete to allow recovery:

```sql
ALTER TABLE files ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL;

-- Soft delete a file
UPDATE files SET deleted_at = NOW() WHERE id = $1;

-- Query only active files
SELECT * FROM files WHERE deleted_at IS NULL;

-- Hard delete after 30 days (cleanup job)
DELETE FROM files WHERE deleted_at < NOW() - INTERVAL '30 days';
```

## Deployment and Operations

### Local Development Rollout Strategy

**Starting services (development):**

```bash
# Option 1: Docker Compose (recommended)
docker-compose up -d          # Start PostgreSQL + Redis
npm run dev                   # Start backend

# Option 2: Native services
brew services start postgresql@16
brew services start redis
npm run dev
```

**Hot reload workflow:**
- Backend: `nodemon` watches `src/` for changes
- Frontend: Vite HMR for instant updates
- No manual restart needed for code changes

### Schema Migration Procedures

**Migration file naming convention:**

```
backend/src/db/migrations/
├── 001_initial_schema.sql
├── 002_add_deleted_at.sql
├── 003_add_operation_indexes.sql
└── ...
```

**Migration script (backend/src/db/migrate.ts):**

```typescript
const migrations = [
  { version: 1, file: '001_initial_schema.sql' },
  { version: 2, file: '002_add_deleted_at.sql' },
  // Add new migrations here
];

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const applied = await db.query('SELECT version FROM schema_migrations');
  const appliedVersions = new Set(applied.rows.map(r => r.version));

  for (const m of migrations) {
    if (!appliedVersions.has(m.version)) {
      console.log(`Applying migration ${m.file}...`);
      const sql = fs.readFileSync(`./migrations/${m.file}`, 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    }
  }
}
```

**Running migrations:**

```bash
npm run db:migrate           # Apply pending migrations
npm run db:migrate:status    # Show applied migrations
```

**Pre-migration checklist:**
1. Create database backup: `npm run db:backup`
2. Review migration SQL for destructive operations
3. Test migration on local copy first
4. Apply migration: `npm run db:migrate`
5. Verify application still works

### Rollback Runbook

**Scenario 1: Bad migration (schema change broke the app)**

```bash
# 1. Stop the backend
Ctrl+C

# 2. Restore from backup taken before migration
npm run db:restore -- backups/backup_pre_migration.sql

# 3. Remove the bad migration from migrations list
# Edit backend/src/db/migrate.ts to comment out the migration

# 4. Restart backend
npm run dev

# 5. Fix the migration SQL, then re-apply
```

**Scenario 2: Bad deployment (code change broke the app)**

```bash
# 1. Git revert to previous commit
git log --oneline -5          # Find the good commit
git checkout <good-commit>

# 2. Reinstall dependencies if package.json changed
npm install

# 3. Restart services
npm run dev
```

**Scenario 3: Data corruption (file canvas_data is invalid)**

```bash
# 1. Identify the affected file
psql -c "SELECT id, name FROM files WHERE canvas_data IS NULL OR canvas_data = '{}'"

# 2. Restore from most recent version
psql -c "
  UPDATE files f
  SET canvas_data = (
    SELECT canvas_data FROM file_versions fv
    WHERE fv.file_id = f.id
    ORDER BY created_at DESC
    LIMIT 1
  )
  WHERE f.id = '<file_id>'
"

# 3. If no versions exist, rebuild from operations
npm run rebuild-canvas -- --file=<file_id>
```

### Health Checks and Monitoring

**Health check endpoint (`/health`):**

```json
{
  "status": "healthy",
  "uptime": 3600,
  "postgres": { "connected": true, "latency_ms": 2 },
  "redis": { "connected": true, "latency_ms": 1 },
  "websocket": { "connections": 3, "files_subscribed": 2 }
}
```

**Manual health checks:**

```bash
# Check PostgreSQL
pg_isready -h localhost -p 5432

# Check Redis
redis-cli ping

# Check backend
curl http://localhost:3000/health

# Check WebSocket (via wscat)
npx wscat -c ws://localhost:3000
```

**Logging levels (configurable via LOG_LEVEL env var):**
- `error`: Unhandled exceptions, database failures
- `warn`: Circuit breaker state changes, retry attempts
- `info`: Connection events, file subscriptions
- `debug`: Individual operations, SQL queries

## Future Optimizations

1. **WebGL Rendering**: For performance with thousands of objects
2. **CRDT Library**: Yjs or Automerge for robust conflict resolution
3. **Viewport Culling**: Only sync objects in view
4. **Delta Compression**: Send only changed properties
5. **Offline Support**: IndexedDB for local persistence

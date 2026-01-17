# Baby Discord - Architecture Design

## System Overview

Baby Discord is a simplified chat server supporting **dual protocols** (TCP and HTTP) to demonstrate core distributed system concepts: connection management, stateful services, message routing, and data persistence.

**Learning Goals:**
- Understand protocol-agnostic service design
- Handle concurrent connections and shared state
- Implement message history with bounded buffers
- Design for local horizontal scaling

---

## Requirements

### Functional Requirements

1. **Dual Protocol Support**
   - Accept raw TCP connections (netcat clients)
   - Accept HTTP connections (browser clients)
   - Both protocols share the same rooms and state

2. **Slash Commands**
   - `/help` - Display available commands
   - `/nick <name>` - Change user's nickname
   - `/list` - Show all connected users
   - `/quit` - Disconnect from server

3. **Room Management**
   - `/create <room>` - Create a new chat room
   - `/join <room>` - Join an existing room
   - `/rooms` - List all available rooms
   - `/leave` - Leave current room

4. **Message History**
   - Store last 10 messages per room
   - Show history when users join
   - Persist messages across restarts

5. **Data Persistence**
   - Persist users, rooms, and messages to PostgreSQL
   - Survive server restarts

### Non-Functional Requirements

- **Scalability**: Support 100+ concurrent connections per instance (local testing with 10-20)
- **Availability**: Single instance acceptable (multi-instance for learning)
- **Latency**: < 100ms message delivery within same instance
- **Consistency**: Strong consistency for room state (users, membership)

---

## Capacity Estimation

For **educational/local testing** scale:

- **Concurrent Users**: 10-20 active connections per instance
- **Messages/Second**: ~10 messages/sec across all rooms
- **Rooms**: ~5-10 active rooms
- **Storage**:
  - Messages: 10 messages × 10 rooms × ~200 bytes = ~20 KB (negligible)
  - Users: 100 users × 1 KB = 100 KB
  - Total: < 1 MB for testing dataset

**Memory per instance**: ~50-100 MB (Node.js baseline + in-memory state)

---

## High-Level Architecture

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                            │
├──────────────────────┬──────────────────────────────────────────┤
│  netcat (TCP)        │  Browser (HTTP)                          │
│  nc localhost 9001   │  http://localhost:3001                   │
└──────────────────────┴──────────────────────────────────────────┘
           │                           │
           │ Raw TCP                   │ HTTP POST/GET
           │                           │
           ▼                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Protocol Adapters                            │
├──────────────────────┬──────────────────────────────────────────┤
│  TCP Server          │  HTTP Server (Express)                   │
│  (net module)        │  - POST /message                         │
│  - Socket per client │  - GET /rooms                            │
│  - Line-based input  │  - Server-Sent Events for messages       │
└──────────────────────┴──────────────────────────────────────────┘
           │                           │
           └───────────┬───────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Chat Core (Shared)                          │
├─────────────────────────────────────────────────────────────────┤
│  - CommandParser: Parse slash commands                          │
│  - ConnectionManager: Track active users & connections          │
│  - RoomManager: Handle room creation, join, leave               │
│  - MessageRouter: Route messages to room members                │
│  - HistoryBuffer: In-memory ring buffer (10 msgs per room)      │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Persistence Layer (PostgreSQL)                 │
├─────────────────────────────────────────────────────────────────┤
│  Tables:                                                        │
│  - users: id, nickname, created_at                              │
│  - rooms: id, name, created_at, created_by                      │
│  - room_members: room_id, user_id, joined_at                    │
│  - messages: id, room_id, user_id, content, timestamp           │
│     (cleanup: keep only last 10 per room)                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Protocol Adapters

**Why dual protocols?**

This design teaches:
- **Protocol abstraction**: Business logic shouldn't care about transport
- **Adapter pattern**: TCP and HTTP adapt to common interface
- **Polyglot clients**: Some users prefer CLI (netcat), others GUI (browser)

#### TCP Server (`src/adapters/tcp-server.ts`)

- Uses Node.js `net` module
- Maintains persistent socket connections
- Line-based protocol (commands and messages separated by `\n`)
- Stateful: socket represents a user session

**Pseudocode:**
```javascript
tcpServer.on('connection', (socket) => {
  const sessionId = generateSessionId()

  socket.on('data', (data) => {
    const lines = parseLines(data)
    for (const line of lines) {
      const command = commandParser.parse(line)
      const result = chatCore.handle(sessionId, command)
      socket.write(result + '\n')
    }
  })

  socket.on('close', () => {
    chatCore.disconnect(sessionId)
  })
})
```

#### HTTP Server (`src/adapters/http-server.ts`)

- Uses Express.js
- RESTful endpoints + Server-Sent Events (SSE) for real-time messages
- Stateless HTTP requests, stateful SSE connections

**API Endpoints:**
```
POST /connect          - Establish session, return session_id
POST /command          - Execute command (body: {session_id, command})
GET  /messages/:room   - SSE stream of messages for a room
GET  /rooms            - List all rooms
POST /disconnect       - End session
```

**Why SSE over WebSocket for HTTP?**
- **Simpler**: SSE is one-directional (server → client), perfect for message broadcasts
- **No special protocol**: Works over HTTP/1.1, easier to debug
- **Browser native**: EventSource API built-in
- **Trade-off**: No client→server push (but we use POST for commands anyway)

**Alternative considered: WebSocket**
- More complex (bidirectional handshake)
- Overkill for this use case
- Would be needed for lower latency or binary data

### 2. Chat Core (Protocol-Agnostic)

The core logic is **completely independent** of TCP or HTTP. Adapters call into the core with normalized commands.

#### ConnectionManager (`src/core/connection-manager.ts`)

**Responsibilities:**
- Track active sessions (TCP socket or HTTP session_id → User)
- Map user to their connection for message delivery
- Handle disconnections and cleanup

**Data Structure:**
```typescript
class ConnectionManager {
  private sessions: Map<string, Session> = new Map()

  interface Session {
    sessionId: string
    userId: string
    nickname: string
    currentRoom: string | null
    transport: 'tcp' | 'http'
    sendMessage: (msg: string) => void  // Transport-specific callback
  }

  connect(sessionId: string, transport: 'tcp' | 'http', sendFn: Function): void
  disconnect(sessionId: string): void
  getSession(sessionId: string): Session | undefined
  getSessions(): Session[]
}
```

#### RoomManager (`src/core/room-manager.ts`)

**Responsibilities:**
- Create/delete rooms
- Track room membership
- Validate room operations (can't join non-existent room)

**Data Structure:**
```typescript
class RoomManager {
  private rooms: Map<string, Room> = new Map()

  interface Room {
    name: string
    createdBy: string
    members: Set<string>  // Set of user IDs
    createdAt: Date
  }

  createRoom(name: string, createdBy: string): Room
  joinRoom(roomName: string, userId: string): void
  leaveRoom(roomName: string, userId: string): void
  getRoomMembers(roomName: string): string[]
  listRooms(): Room[]
}
```

#### MessageRouter (`src/core/message-router.ts`)

**Responsibilities:**
- Route messages to all members of a room
- Use ConnectionManager to deliver via correct transport

**Flow:**
```typescript
class MessageRouter {
  sendToRoom(roomName: string, message: Message): void {
    const room = roomManager.getRoom(roomName)
    const members = room.members

    for (const userId of members) {
      const sessions = connectionManager.getSessionsByUserId(userId)
      for (const session of sessions) {
        session.sendMessage(formatMessage(message))
      }
    }
  }
}
```

#### HistoryBuffer (`src/core/history-buffer.ts`)

**Responsibilities:**
- Maintain last 10 messages per room in memory (ring buffer)
- Load history from DB on startup
- Persist messages asynchronously

**Why in-memory buffer?**
- **Performance**: Reading from memory is ~1000x faster than DB query
- **Simplicity**: Ring buffer is easy to implement
- **Bounded**: Fixed size (10 messages) prevents unbounded memory growth

**Trade-offs:**
- **Risk**: If server crashes before async persist, messages lost
- **Mitigation**: Write-ahead log (WAL) could solve this, but adds complexity
- **Acceptable**: For educational project, losing <10 messages on crash is OK

**Data Structure:**
```typescript
class HistoryBuffer {
  private buffers: Map<string, Message[]> = new Map()
  private readonly MAX_MESSAGES = 10

  addMessage(roomName: string, message: Message): void {
    let buffer = this.buffers.get(roomName) || []
    buffer.push(message)

    if (buffer.length > this.MAX_MESSAGES) {
      buffer.shift()  // Remove oldest message (ring buffer)
    }

    this.buffers.set(roomName, buffer)

    // Async persist to DB (fire-and-forget)
    this.persistMessage(message).catch(err => logger.error(err))
  }

  getHistory(roomName: string): Message[] {
    return this.buffers.get(roomName) || []
  }

  async loadFromDB(): Promise<void> {
    // On startup, load last 10 messages per room from DB
    const rooms = await db.getRooms()
    for (const room of rooms) {
      const messages = await db.getRecentMessages(room.name, 10)
      this.buffers.set(room.name, messages)
    }
  }
}
```

**Alternative considered: No in-memory buffer, always read from DB**
- Simpler code (no cache invalidation)
- Slower: Every room join requires DB query
- More DB load
- **Rejected**: Education goal is to learn caching patterns

---

## Data Model

### Database Schema (PostgreSQL)

**Why PostgreSQL?**
- Relational model fits naturally (users, rooms, memberships)
- ACID transactions for consistency
- JSON support for future extensibility (message metadata)
- Lightweight for local development

**Alternatives considered:**
- **CouchDB**: Document model doesn't fit relational data (room memberships)
- **Cassandra**: Overkill for <1MB dataset, complex operations (join room)
- **Redis**: Not durable by default, would need RDB snapshots

```sql
-- Users table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  nickname VARCHAR(50) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Rooms table
CREATE TABLE rooms (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Room membership (many-to-many)
CREATE TABLE room_members (
  room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

-- Messages (partitioned by room for efficiency)
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_messages_room_time ON messages(room_id, created_at DESC);

-- Cleanup old messages (keep only last 10 per room)
-- Runs periodically via background job
CREATE OR REPLACE FUNCTION cleanup_old_messages() RETURNS void AS $$
BEGIN
  DELETE FROM messages m
  WHERE m.id NOT IN (
    SELECT id FROM messages
    WHERE room_id = m.room_id
    ORDER BY created_at DESC
    LIMIT 10
  );
END;
$$ LANGUAGE plpgsql;
```

### In-Memory State

**Why hybrid (DB + memory)?**
- **DB**: Source of truth, survives restarts
- **Memory**: Fast reads, real-time state (who's online, current connections)

**What's in memory:**
- Active sessions (ConnectionManager)
- Current room memberships (loaded from DB on join, invalidated on leave)
- Message history buffer (last 10 per room)

**What's only in DB:**
- Historical messages (beyond last 10)
- User accounts
- Room metadata

---

## API Design

### TCP Protocol

**Line-based text protocol:**
```
Client → Server:
  /command [args]      (e.g., "/join general")
  regular message      (e.g., "Hello world")

Server → Client:
  [room] nickname: message
  [system] info message
```

### HTTP API

**REST + SSE:**

```
POST /api/connect
Request:  { nickname: string }
Response: { session_id: string, user_id: number }

POST /api/command
Request:  { session_id: string, command: string }
Response: { success: boolean, message: string }

POST /api/message
Request:  { session_id: string, room: string, content: string }
Response: { success: boolean, message_id: number }

GET /api/messages/:room (SSE)
Response: Stream of Server-Sent Events
  event: message
  data: {"room": "general", "user": "alice", "content": "hello"}

GET /api/rooms
Response: { rooms: [{ name: string, members: number }] }

POST /api/disconnect
Request:  { session_id: string }
Response: { success: boolean }
```

---

## Key Design Decisions

### 1. Why Both TCP and HTTP?

**Educational reasons:**
- **TCP**: Teaches low-level socket programming, connection lifecycle
- **HTTP**: Teaches REST API design, SSE for real-time updates
- **Contrast**: Shows how different protocols solve same problem

**Real-world analogy:**
- Slack has desktop app (WebSocket-like) and web app (HTTP/WebSocket)
- IRC servers support raw TCP and web gateways

**Trade-off:**
- More code complexity (two adapters)
- **Benefit**: Learn protocol abstraction, adapter pattern

### 2. Message History: Ring Buffer vs Always-DB

**Approach 1: Ring Buffer (Chosen)**
- In-memory array, fixed size 10
- Fast reads (O(1))
- Async write to DB
- **Risk**: Messages lost on crash before persist

**Approach 2: Always Read from DB**
- No cache, query DB every time
- Slower (DB roundtrip ~10ms vs memory ~0.01ms)
- No risk of data loss
- **Rejected**: Misses opportunity to learn caching

**Approach 3: Write-Ahead Log (WAL)**
- Write to local file immediately, then DB async
- Guaranteed durability
- **Rejected**: Too complex for educational project

**Chosen: Ring Buffer** because:
- Teaches caching patterns
- Shows trade-off (speed vs durability)
- Acceptable data loss for learning project

### 3. SSE vs WebSocket for HTTP

| Feature              | SSE (Chosen)           | WebSocket               |
|----------------------|------------------------|-------------------------|
| Directionality       | Server → Client only   | Bidirectional           |
| Protocol             | HTTP                   | WS (upgrade from HTTP)  |
| Browser API          | EventSource (native)   | WebSocket (native)      |
| Reconnection         | Automatic              | Manual                  |
| Complexity           | Low                    | Medium                  |
| Use case fit         | ✅ Perfect (broadcast)  | ⚠️ Overkill             |

**Decision: SSE** because:
- We only need server→client (messages)
- Client→server uses REST (POST /message)
- Simpler to implement and debug
- Auto-reconnect is bonus

**When WebSocket is better:**
- Real-time gaming (bidirectional, low latency)
- Video/audio streams
- Binary data

### 4. Single Instance vs Distributed

**Phase 1: Single Instance (Start Here)**
- All state in one process
- No network coordination needed
- Simple to debug

**Phase 2: Multi-Instance (Learning Goal)**
- Run 3 instances (different ports)
- Problem: Users on different instances can't chat
- **Solution options:**

**Option A: Shared Database (Polling)**
- Poll DB for new messages every 100ms
- Simple, but high DB load and latency

**Option B: Message Queue (Pub/Sub)**
- Use Valkey/Redis pub/sub
- Instances subscribe to room channels
- Message published to channel → all instances receive
- **Better**: Low latency, efficient

**Option C: Gossip Protocol**
- Instances directly communicate (HTTP/TCP)
- Complex, but educational
- **Rejected**: Too advanced for "Baby" Discord

**Recommendation: Start with Option A, migrate to Option B**

### 5. PostgreSQL vs NoSQL

**Why PostgreSQL?**
- Relational data (users ↔ rooms many-to-many)
- Transactional consistency (join room = write to room_members atomically)
- Good query support (find all members of a room)
- Familiar for most developers

**When would NoSQL (CouchDB/Cassandra) be better?**
- **CouchDB**: If messages were documents with rich metadata, schema-less
- **Cassandra**: If scaling to billions of messages, write-heavy workload
- **Valkey/Redis**: If everything was ephemeral (no persistence requirement)

**Our use case**: Small dataset, relational, ACID → PostgreSQL is correct choice

---

## Scalability Considerations

### Current Limits (Single Instance)

- **Connections**: Node.js can handle ~10K concurrent sockets (OS limit: ulimit)
- **Bottleneck**: PostgreSQL connection pool (default: 10 connections)
- **Messages/sec**: ~1K messages (limited by DB writes)

### Scaling Horizontally (Multi-Instance)

**Stateless vs Stateful:**
- HTTP API: Can be stateless (session in DB/Redis)
- TCP: Inherently stateful (socket connection tied to instance)

**Challenge**: How to route messages across instances?

**Solution: Pub/Sub with Valkey/Redis**

```
┌─────────┐    ┌─────────┐    ┌─────────┐
│Instance1│    │Instance2│    │Instance3│
│TCP+HTTP │    │TCP+HTTP │    │TCP+HTTP │
└────┬────┘    └────┬────┘    └────┬────┘
     │              │              │
     └──────────┬───┴──────────────┘
                │
         ┌──────▼──────┐
         │   Valkey    │
         │  (Pub/Sub)  │
         └─────────────┘
```

**Flow:**
1. User on Instance1 sends message to "general" room
2. Instance1 publishes to Valkey channel: `room:general`
3. All instances subscribed to `room:general` receive message
4. Each instance delivers to its local TCP/HTTP clients in that room

**Code:**
```javascript
// On startup
redis.subscribe('room:general')

// On message received from client
function handleMessage(sessionId, roomName, content) {
  const message = { room: roomName, user: session.nickname, content }

  // Publish to all instances
  redis.publish(`room:${roomName}`, JSON.stringify(message))
}

// On Redis pub/sub message
redis.on('message', (channel, data) => {
  const message = JSON.parse(data)
  const room = channel.replace('room:', '')

  // Deliver to local clients in this room
  messageRouter.sendToRoom(room, message)
})
```

### Vertical Scaling

- Increase PostgreSQL connection pool
- Add read replicas (for message history queries)
- Use connection pooler (PgBouncer)

---

## Technology Stack Justification

### Application Layer: Node.js + Express

**Why Node.js?**
- **Event loop**: Perfect for I/O-bound chat (many concurrent connections)
- **Single language**: JavaScript/TypeScript for both TCP and HTTP
- **Ecosystem**: Rich libraries (pg, express, socket management)

**Trade-off vs alternatives:**

| Language | Pros                              | Cons                              |
|----------|-----------------------------------|-----------------------------------|
| Node.js  | ✅ Event-driven, easy async       | ⚠️ Single-threaded (CPU-bound)    |
| Go       | ✅ High concurrency, fast         | ⚠️ Different syntax, less familiar|
| Python   | ✅ Easy syntax                    | ⚠️ GIL limits concurrency         |
| Rust     | ✅ Ultra-fast, memory-safe        | ⚠️ Steep learning curve           |

**Decision: Node.js** because:
- Chat is I/O-bound (network, DB), not CPU-bound
- Educational focus (familiar to most developers)
- Fast iteration speed

**When to reconsider:**
- If profiling shows CPU bottleneck (message parsing)
- If need <1ms latency (Go/Rust better)

### Database: PostgreSQL

**Why PostgreSQL?**
- Relational model fits (users, rooms, memberships)
- ACID guarantees consistency
- JSON support for extensibility
- Widely known

**Trade-offs:** (see "PostgreSQL vs NoSQL" section above)

### Caching: Valkey (for multi-instance pub/sub)

**Why Valkey over Redis?**
- Fully open-source (no licensing concerns)
- API-compatible with Redis
- Community-driven

**When Redis is fine:**
- If licensing not a concern
- Existing Redis expertise

### No Message Queue (Initially)

**Why not RabbitMQ/Kafka?**
- Overkill for simple pub/sub
- Valkey pub/sub is sufficient
- Adds operational complexity

**When to add:**
- If need guaranteed delivery (Kafka)
- If need complex routing (RabbitMQ exchanges)
- If messages need persistence beyond 10 (Kafka)

---

## Monitoring and Observability

### Metrics to Track

- **Connections**: Active TCP connections, active HTTP sessions
- **Rooms**: Number of rooms, messages per room
- **Latency**: Message delivery time (published → received)
- **Errors**: Connection failures, DB query failures

### Implementation

**Simple logging (start here):**
```javascript
logger.info('User connected', { sessionId, nickname, transport })
logger.info('Message sent', { room, user, latency_ms })
logger.error('DB error', { error, query })
```

**Advanced (optional):**
- Prometheus metrics (counter for messages, gauge for connections)
- Grafana dashboards
- Distributed tracing (if multi-instance)

---

## Data Lifecycle Policies

### Message Retention and TTL

**In-Memory Ring Buffer (HistoryBuffer)**
- **Retention**: Last 10 messages per room, evicted on overflow (oldest first)
- **TTL**: None (messages persist until evicted or server restart)
- **Eviction**: Automatic via ring buffer shift operation when buffer exceeds 10

**PostgreSQL Messages Table**
- **Retention Strategy**: Keep last 10 messages per room in hot storage
- **Cleanup Job**: Run `cleanup_old_messages()` function every 5 minutes via pg_cron or application-level scheduler

```sql
-- Schedule cleanup (if using pg_cron)
SELECT cron.schedule('cleanup-messages', '*/5 * * * *', 'SELECT cleanup_old_messages()');

-- Or run from Node.js
setInterval(async () => {
  await db.query('SELECT cleanup_old_messages()');
  logger.info('Message cleanup completed');
}, 5 * 60 * 1000);  // Every 5 minutes
```

**Local Development**: For learning purposes, the 10-message limit keeps the dataset small and demonstrates bounded buffer patterns.

### Archival to Cold Storage

**When to Archive (Production Pattern)**
- Messages older than 30 days move from PostgreSQL to MinIO (S3-compatible)
- Store as JSON files: `archive/rooms/{room_id}/{year}/{month}.json`

**Local Development Implementation**
Since this is an educational project, archival is optional but can be demonstrated:

```bash
# Export messages older than 1 hour to JSON file
npm run archive:messages

# This runs:
# 1. SELECT messages WHERE created_at < NOW() - INTERVAL '1 hour'
# 2. Write to discord/archive/{room_name}_{timestamp}.json
# 3. DELETE archived messages from PostgreSQL
```

**Archive Schema**:
```json
{
  "room": "general",
  "archived_at": "2024-01-15T10:30:00Z",
  "messages": [
    {"id": 42, "user": "alice", "content": "Hello", "created_at": "2024-01-14T09:15:00Z"}
  ]
}
```

### Backfill and Replay Procedures

**Scenario 1: Restore HistoryBuffer After Restart**
On server startup, the HistoryBuffer loads recent messages from PostgreSQL:

```typescript
// In HistoryBuffer.loadFromDB()
async loadFromDB(): Promise<void> {
  const rooms = await db.getRooms();
  for (const room of rooms) {
    const messages = await db.getRecentMessages(room.name, 10);
    this.buffers.set(room.name, messages);
    logger.info(`Loaded ${messages.length} messages for room: ${room.name}`);
  }
}
```

**Scenario 2: Replay Messages from Archive**
To restore archived messages to PostgreSQL:

```bash
# Replay archived messages for a specific room
npm run replay:messages -- --room general --file archive/general_2024-01.json

# This inserts messages back into PostgreSQL and updates HistoryBuffer
```

**Scenario 3: Rebuild Valkey Pub/Sub State**
Valkey pub/sub is ephemeral (no message persistence). If Valkey restarts:
1. Active subscriptions are lost
2. Clients reconnect automatically (SSE has auto-reconnect)
3. No message replay needed (chat is real-time, not guaranteed delivery)

**Scenario 4: PostgreSQL Recovery**
```bash
# Backup (run weekly in production, on-demand locally)
pg_dump babydiscord > backup_$(date +%Y%m%d).sql

# Restore
psql babydiscord < backup_20240115.sql

# After restore, restart server to reload HistoryBuffer
npm run dev
```

---

## Deployment and Operations

### Rollout Strategy

**Local Development (3 Instances)**

For testing horizontal scaling locally:

```bash
# Step 1: Start infrastructure
docker-compose up -d  # PostgreSQL, Valkey

# Step 2: Run database migrations
npm run db:migrate

# Step 3: Start instances one at a time (rolling deployment simulation)
npm run dev:instance1 &  # Wait for "Server listening" log
sleep 5
npm run dev:instance2 &  # Wait for "Server listening" log
sleep 5
npm run dev:instance3 &

# Step 4: Verify all instances are healthy
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

**Rolling Deployment Pattern**

When updating code:

1. **Deploy to Instance 1**:
   ```bash
   # Stop instance 1
   kill $(lsof -t -i:3001)
   # Pull new code, restart
   npm run dev:instance1
   # Verify health
   curl http://localhost:3001/health
   ```

2. **Wait for stability** (30 seconds): Monitor logs for errors

3. **Deploy to Instance 2**: Repeat process

4. **Deploy to Instance 3**: Repeat process

**Canary Deployment (Advanced)**

Route 10% of traffic to new instance, monitor for errors:
```nginx
# nginx.conf for local testing
upstream chat_backend {
    server localhost:3001 weight=9;
    server localhost:3002 weight=1;  # Canary
}
```

### Schema Migrations

**Migration File Structure**
```
backend/src/db/migrations/
├── 001_initial_schema.sql      # users, rooms, room_members, messages
├── 002_add_message_index.sql   # idx_messages_room_time
├── 003_add_user_status.sql     # Example: add online_status column
└── 004_add_room_description.sql
```

**Migration Runner**
```bash
# Run all pending migrations
npm run db:migrate

# Check migration status
npm run db:migrate:status

# Rollback last migration (if supported)
npm run db:migrate:rollback
```

**Migration Script Implementation** (`backend/src/db/migrate.ts`):
```typescript
async function migrate() {
  const applied = await db.query('SELECT name FROM schema_migrations');
  const appliedNames = new Set(applied.rows.map(r => r.name));

  const files = fs.readdirSync('./migrations').sort();
  for (const file of files) {
    if (!appliedNames.has(file)) {
      console.log(`Applying: ${file}`);
      const sql = fs.readFileSync(`./migrations/${file}`, 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
  }
  console.log('Migrations complete');
}
```

**Safe Migration Practices**
- Always add columns as nullable first, then backfill, then add NOT NULL
- Create indexes with `CONCURRENTLY` to avoid locking tables
- Test migrations on a copy of production data before deploying

### Rollback Runbooks

**Runbook 1: Bad Code Deployment**

*Symptoms*: 500 errors, connection failures, increased latency

*Steps*:
1. **Identify bad instance**: Check logs for errors
   ```bash
   tail -f logs/instance1.log | grep ERROR
   ```

2. **Rollback code**: Revert to previous git commit
   ```bash
   git checkout HEAD~1
   npm run build
   ```

3. **Restart affected instance**:
   ```bash
   kill $(lsof -t -i:3001)
   npm run dev:instance1
   ```

4. **Verify health**:
   ```bash
   curl http://localhost:3001/health
   # Expected: {"status": "healthy", "db": "connected", "valkey": "connected"}
   ```

**Runbook 2: Database Migration Failure**

*Symptoms*: Server won't start, "relation does not exist" errors

*Steps*:
1. **Check migration status**:
   ```bash
   psql babydiscord -c "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5"
   ```

2. **Identify failed migration**: Check logs for SQL errors

3. **Manual rollback** (if migration was partially applied):
   ```sql
   -- Example: remove partially created index
   DROP INDEX IF EXISTS idx_new_feature;
   -- Remove migration record
   DELETE FROM schema_migrations WHERE name = '005_add_new_feature.sql';
   ```

4. **Fix migration file** and re-run:
   ```bash
   npm run db:migrate
   ```

**Runbook 3: Valkey Connection Failure**

*Symptoms*: Messages not delivered across instances, pub/sub errors in logs

*Steps*:
1. **Check Valkey status**:
   ```bash
   docker-compose ps valkey
   redis-cli -p 6379 PING  # Should return PONG
   ```

2. **Restart Valkey**:
   ```bash
   docker-compose restart valkey
   ```

3. **Restart chat instances** (to re-establish subscriptions):
   ```bash
   # Instances auto-reconnect, but restart if subscriptions seem stale
   npm run restart:all
   ```

4. **Verify pub/sub**:
   ```bash
   # Terminal 1: Subscribe
   redis-cli SUBSCRIBE room:general

   # Terminal 2: Publish
   redis-cli PUBLISH room:general '{"test": true}'

   # Terminal 1 should show the message
   ```

**Runbook 4: PostgreSQL Connection Pool Exhaustion**

*Symptoms*: "too many connections" errors, slow queries

*Steps*:
1. **Check active connections**:
   ```sql
   SELECT count(*) FROM pg_stat_activity WHERE datname = 'babydiscord';
   ```

2. **Identify long-running queries**:
   ```sql
   SELECT pid, now() - pg_stat_activity.query_start AS duration, query
   FROM pg_stat_activity
   WHERE state != 'idle'
   ORDER BY duration DESC;
   ```

3. **Kill stuck queries**:
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE duration > interval '5 minutes' AND state != 'idle';
   ```

4. **Increase pool size** (if legitimate load):
   ```javascript
   // In db.ts
   const pool = new Pool({
     max: 20,  // Increase from default 10
   });
   ```

---

## Capacity and Cost Guardrails

### Alert Thresholds

**Queue Lag Alerts (Valkey Pub/Sub)**

Monitor message delivery delay:

```typescript
// In MessageRouter, measure pub/sub latency
const startTime = Date.now();
await redis.publish(`room:${room}`, JSON.stringify(message));
const latency = Date.now() - startTime;

if (latency > 100) {
  logger.warn('Pub/sub latency exceeded threshold', { latency, room });
}
if (latency > 500) {
  logger.error('Pub/sub latency critical', { latency, room });
  // Alert: Valkey may be overloaded
}
```

**Thresholds for Local Development**:
| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Pub/sub latency | > 100ms | > 500ms | Check Valkey memory, restart if needed |
| Message queue depth | > 100 | > 500 | Scale instances or increase Valkey memory |
| DB connection wait | > 50ms | > 200ms | Increase pool size |

**Storage Growth Alerts**

Monitor PostgreSQL table sizes:

```sql
-- Check messages table size
SELECT pg_size_pretty(pg_total_relation_size('messages')) AS messages_size;

-- Should stay under 10MB for local testing (10 messages/room * ~100 rooms * 200 bytes)
```

**Local Thresholds**:
| Table | Expected Size | Warning | Action |
|-------|---------------|---------|--------|
| messages | < 1 MB | > 5 MB | Run cleanup_old_messages() manually |
| users | < 100 KB | > 500 KB | Check for duplicate user creation |
| rooms | < 50 KB | > 200 KB | Normal growth, no action needed |

**Monitoring Script** (`scripts/check-storage.sh`):
```bash
#!/bin/bash
psql babydiscord -c "
SELECT
  relname AS table,
  pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
"
```

### Cache Hit Rate Targets

**HistoryBuffer Cache Hit Rate**

Track how often we serve from memory vs DB:

```typescript
class HistoryBuffer {
  private hits = 0;
  private misses = 0;

  getHistory(roomName: string): Message[] {
    const buffer = this.buffers.get(roomName);
    if (buffer) {
      this.hits++;
      return buffer;
    }
    this.misses++;
    // Fallback to DB query (should rarely happen)
    return this.loadRoomFromDB(roomName);
  }

  getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? (this.hits / total) * 100 : 100;
  }
}
```

**Targets**:
| Cache | Target Hit Rate | Warning Threshold | Action if Below |
|-------|-----------------|-------------------|-----------------|
| HistoryBuffer | > 95% | < 90% | Check if rooms are being evicted unexpectedly |
| Session cache (Valkey) | > 99% | < 95% | Increase Valkey memory or check TTL settings |

**Expose metrics endpoint**:
```typescript
app.get('/metrics', (req, res) => {
  res.json({
    history_buffer_hit_rate: historyBuffer.getHitRate(),
    active_connections: connectionManager.getSessionCount(),
    rooms_in_memory: roomManager.getRoomCount(),
    db_pool_available: pool.idleCount,
    db_pool_waiting: pool.waitingCount,
  });
});
```

### Cost Guardrails (Local Development)

**Resource Limits** (Docker Compose):
```yaml
services:
  postgres:
    mem_limit: 512m
    cpus: 0.5

  valkey:
    mem_limit: 128m
    cpus: 0.25
```

**Connection Limits**:
```typescript
// PostgreSQL pool
const pool = new Pool({
  max: 10,  // Max connections per instance
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Valkey connection
const redis = new Redis({
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
```

**Automatic Circuit Breakers**:
```typescript
// If DB connections are exhausted, reject new connections gracefully
app.use((req, res, next) => {
  if (pool.waitingCount > 5) {
    logger.warn('DB pool exhausted, rejecting request');
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }
  next();
});
```

### Monitoring Dashboard (Optional)

For local development, a simple terminal dashboard:

```bash
# scripts/monitor.sh
watch -n 2 '
echo "=== Baby Discord Health ==="
echo ""
echo "Instances:"
curl -s localhost:3001/health 2>/dev/null || echo "Instance 1: DOWN"
curl -s localhost:3002/health 2>/dev/null || echo "Instance 2: DOWN"
curl -s localhost:3003/health 2>/dev/null || echo "Instance 3: DOWN"
echo ""
echo "Metrics (Instance 1):"
curl -s localhost:3001/metrics 2>/dev/null | jq .
echo ""
echo "PostgreSQL Connections:"
psql babydiscord -t -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '\''babydiscord'\''"
echo ""
echo "Valkey Memory:"
redis-cli INFO memory | grep used_memory_human
'
```

---

## Security Considerations

### Current Scope (Educational)

- **No authentication**: Users pick any nickname
- **No authorization**: Anyone can create/join rooms
- **No encryption**: Plain text over TCP, HTTP (not HTTPS)
- **No rate limiting**: Users can spam messages

### Production Requirements (Out of Scope)

- User accounts with password hashing (bcrypt)
- TLS for TCP, HTTPS for HTTP
- Rate limiting (10 messages/min per user)
- Input validation (prevent SQL injection, XSS)
- Room access control (private rooms)

---

## Testing Strategy

### Unit Tests

- `ConnectionManager`: Add/remove sessions, lookup
- `RoomManager`: Create/join/leave rooms
- `CommandParser`: Parse slash commands
- `HistoryBuffer`: Add messages, maintain size=10

### Integration Tests

**TCP Flow:**
```javascript
test('TCP client can join room and send message', async () => {
  const client = await connectTCP(9001)
  await client.send('/create general\n')
  await client.send('Hello\n')
  const msg = await client.receive()
  expect(msg).toContain('[general] alice: Hello')
})
```

**HTTP Flow:**
```javascript
test('HTTP client receives messages via SSE', async () => {
  const session = await fetch('/api/connect', { body: { nickname: 'bob' }})
  const sse = new EventSource(`/api/messages/general`)

  await fetch('/api/message', { body: { session_id: session.id, content: 'Hi' }})

  const msg = await waitForSSE(sse)
  expect(msg.content).toBe('Hi')
})
```

### Load Testing

**Scenario: 50 concurrent users, 10 messages/sec**
```bash
# Spawn 50 netcat clients
for i in {1..50}; do
  nc localhost 9001 < test_script.txt &
done

# Monitor metrics
watch -n 1 'lsof -i :9001 | wc -l'  # Connection count
```

---

## Trade-offs and Alternatives

### Summary Table

| Decision                  | Chosen                | Alternative          | Reason                              |
|---------------------------|-----------------------|----------------------|-------------------------------------|
| Transport                 | TCP + HTTP            | HTTP only            | Learn protocol abstraction          |
| HTTP Real-time            | SSE                   | WebSocket            | Simpler, unidirectional sufficient  |
| Message History           | In-memory ring buffer | Always DB query      | Teach caching, accept data loss     |
| Database                  | PostgreSQL            | CouchDB/Cassandra    | Relational model, ACID              |
| Multi-instance messaging  | Valkey pub/sub        | DB polling           | Low latency, efficient              |
| Language                  | Node.js               | Go/Rust              | Familiarity, I/O-bound workload     |

---

## Future Optimizations

### Phase 1 → Phase 2 Migration Path

1. **Single instance working** (TCP + HTTP + PostgreSQL)
2. **Add Valkey pub/sub** (enable multi-instance)
3. **Load balancer** (HAProxy/nginx for HTTP, round-robin for TCP)
4. **Connection pooler** (PgBouncer for DB)
5. **Read replicas** (PostgreSQL streaming replication)

### Advanced Features (Beyond Baby Discord)

- **Voice/Video**: WebRTC peer-to-peer, signaling server
- **File sharing**: Object storage (MinIO), CDN
- **Search**: Elasticsearch for message search
- **Analytics**: Kafka → stream processing → metrics

---

## Local Multi-Instance Setup

**Goal**: Run 3 instances locally to simulate distribution

### Configuration

**`config/instance1.json`:**
```json
{
  "tcp_port": 9001,
  "http_port": 3001,
  "instance_id": "instance-1",
  "db_url": "postgresql://localhost:5432/babydiscord",
  "redis_url": "redis://localhost:6379"
}
```

**`config/instance2.json`, `instance3.json`**: Similar, different ports

### Running

```bash
# Terminal 1
npm run dev:instance1

# Terminal 2
npm run dev:instance2

# Terminal 3
npm run dev:instance3
```

### Testing Cross-Instance

```bash
# Terminal 4: Connect to instance 1
nc localhost 9001
> /create general
> Hello from instance 1

# Terminal 5: Connect to instance 2
nc localhost 9002
> /join general
# Should see "Hello from instance 1" (via pub/sub)
```

---

## Conclusion

Baby Discord is designed to teach:
1. **Protocol abstraction** (TCP + HTTP → same core)
2. **Stateful services** (connection management)
3. **Caching patterns** (ring buffer for message history)
4. **Horizontal scaling** (pub/sub for multi-instance)
5. **Trade-off analysis** (SSE vs WebSocket, memory vs DB, etc.)

The architecture prioritizes **learning** over production readiness, with clear migration paths to more advanced patterns.

**Next Steps**: See [README.md](./README.md) for implementation phases and [claude.md](./claude.md) for development discussion.

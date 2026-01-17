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

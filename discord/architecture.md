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

---

### Complete Database Schema

The schema is defined in `/backend/src/db/init.sql` and consists of four core tables plus supporting indexes and functions.

#### Table: `users`

Stores registered chat users with unique nicknames.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `SERIAL` | `PRIMARY KEY` | Auto-incrementing unique identifier |
| `nickname` | `VARCHAR(50)` | `UNIQUE NOT NULL` | Display name, must be unique across system |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | `DEFAULT NOW()` | Account creation timestamp |

**Design Rationale:**
- `SERIAL` provides simple auto-incrementing IDs (sufficient for educational scale)
- `VARCHAR(50)` limits nickname length to prevent abuse and ensure UI compatibility
- `UNIQUE` constraint on nickname enforces global uniqueness for mentions/lookups
- Timezone-aware timestamp (`WITH TIME ZONE`) ensures consistent time handling across distributed instances

```sql
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    nickname VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

#### Table: `rooms`

Stores chat rooms (channels) with creator attribution.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `SERIAL` | `PRIMARY KEY` | Auto-incrementing unique identifier |
| `name` | `VARCHAR(100)` | `UNIQUE NOT NULL` | Room name, must be unique |
| `created_by` | `INTEGER` | `REFERENCES users(id) ON DELETE SET NULL` | User who created the room |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | `DEFAULT NOW()` | Room creation timestamp |

**Design Rationale:**
- `VARCHAR(100)` allows descriptive room names while preventing excessive length
- `UNIQUE` on name ensures users can reference rooms unambiguously
- `ON DELETE SET NULL` for `created_by`: Rooms persist even if creator account is deleted (rooms have independent lifecycle from creators)

```sql
CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

#### Table: `room_members`

Junction table implementing many-to-many relationship between users and rooms.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `room_id` | `INTEGER` | `REFERENCES rooms(id) ON DELETE CASCADE` | Room being joined |
| `user_id` | `INTEGER` | `REFERENCES users(id) ON DELETE CASCADE` | User joining the room |
| `joined_at` | `TIMESTAMP WITH TIME ZONE` | `DEFAULT NOW()` | When user joined this room |

**Composite Primary Key:** `(room_id, user_id)`

**Design Rationale:**
- Composite primary key prevents duplicate memberships (same user joining same room twice)
- `ON DELETE CASCADE` for both FKs: When a room is deleted, all memberships are automatically removed; when a user is deleted, their memberships are cleaned up
- `joined_at` enables features like "member since" display and ordered member lists

```sql
CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);
```

---

#### Table: `messages`

Stores chat messages with room and author attribution.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `SERIAL` | `PRIMARY KEY` | Auto-incrementing unique identifier |
| `room_id` | `INTEGER` | `REFERENCES rooms(id) ON DELETE CASCADE` | Room where message was sent |
| `user_id` | `INTEGER` | `REFERENCES users(id) ON DELETE SET NULL` | Author of the message |
| `content` | `TEXT` | `NOT NULL` | Message text content |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | `DEFAULT NOW()` | When message was sent |

**Design Rationale:**
- `TEXT` type for content allows messages of any reasonable length (no arbitrary truncation)
- `ON DELETE CASCADE` for `room_id`: When a room is deleted, all its messages are deleted (messages have no meaning outside their room context)
- `ON DELETE SET NULL` for `user_id`: Messages persist even if author account is deleted (historical record preserved, shows as "[deleted user]")
- `NOT NULL` on content prevents empty messages

```sql
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

### Indexes

#### `idx_messages_room_time`

**Purpose:** Efficient retrieval of recent messages per room (the most common query pattern).

```sql
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at DESC);
```

**Query Pattern Optimized:**
```sql
SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 10;
```

**Rationale:**
- Composite index on `(room_id, created_at DESC)` enables index-only scans for room history queries
- Descending order on `created_at` matches the typical "most recent first" access pattern
- Critical for performance as message volume grows

---

#### `idx_users_nickname`

**Purpose:** Fast user lookup by nickname.

```sql
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);
```

**Query Patterns Optimized:**
- User authentication/lookup: `SELECT * FROM users WHERE nickname = ?`
- Nickname availability check: `SELECT EXISTS(SELECT 1 FROM users WHERE nickname = ?)`

**Rationale:**
- Although `nickname` has a UNIQUE constraint (which creates an implicit index), explicit indexing documents the intent and ensures optimal lookup performance
- Essential for login/session establishment which happens on every connection

---

#### `idx_rooms_name`

**Purpose:** Fast room lookup by name.

```sql
CREATE INDEX IF NOT EXISTS idx_rooms_name ON rooms(name);
```

**Query Patterns Optimized:**
- Join room by name: `SELECT * FROM rooms WHERE name = ?`
- Room existence check: `SELECT EXISTS(SELECT 1 FROM rooms WHERE name = ?)`

**Rationale:**
- Similar to `idx_users_nickname`, the UNIQUE constraint creates an implicit index
- Explicit index documents intent for `/join <room>` command performance

---

### Functions

#### `cleanup_old_messages()`

**Purpose:** Enforce 10-message history limit per room to prevent unbounded storage growth.

```sql
CREATE OR REPLACE FUNCTION cleanup_old_messages() RETURNS void AS $$
BEGIN
    DELETE FROM messages m
    WHERE m.id NOT IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC) as rn
            FROM messages
        ) ranked
        WHERE rn <= 10
    );
END;
$$ LANGUAGE plpgsql;
```

**Algorithm:**
1. Window function (`ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC)`) assigns rank 1-N to messages in each room, ordered newest-first
2. Keep messages with rank <= 10 (the 10 most recent per room)
3. Delete all other messages

**Invocation:**
- Manual: `SELECT cleanup_old_messages();`
- Scheduled: Via `pg_cron` or application-level scheduler (every 5 minutes recommended)
- Triggered: Could be enhanced to run after message inserts (not implemented to avoid write latency)

**Rationale:**
- Keeps storage bounded regardless of message volume
- Aligns with in-memory ring buffer (10 messages per room)
- Educational: Demonstrates server-side data lifecycle management

---

### Seed Data

The init script creates a default "general" room for first-time users:

```sql
INSERT INTO users (nickname) VALUES ('system') ON CONFLICT (nickname) DO NOTHING;
INSERT INTO rooms (name, created_by)
SELECT 'general', id FROM users WHERE nickname = 'system'
ON CONFLICT (name) DO NOTHING;
```

**Rationale:**
- `system` user serves as a placeholder for system-created resources
- `general` room provides an immediate landing spot (like Discord's default channel)
- `ON CONFLICT DO NOTHING` ensures idempotent initialization (safe to run multiple times)

---

### Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ENTITY-RELATIONSHIP DIAGRAM                        │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌───────────────────┐
                              │       users       │
                              ├───────────────────┤
                              │ PK id             │
                              │    nickname       │
                              │    created_at     │
                              └─────────┬─────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    │ 1                 │ 1                 │ 0..1
                    │                   │                   │
                    ▼                   ▼                   ▼
           ┌────────────────┐  ┌────────────────┐  ┌───────────────────┐
           │  room_members  │  │   messages     │  │      rooms        │
           ├────────────────┤  ├────────────────┤  ├───────────────────┤
           │ PK,FK room_id  │  │ PK id          │  │ PK id             │
           │ PK,FK user_id  │  │ FK room_id     │  │    name           │
           │    joined_at   │  │ FK user_id     │  │ FK created_by ────┘
           └───────┬────────┘  │    content     │  │    created_at     │
                   │           │    created_at  │  └─────────┬─────────┘
                   │           └───────┬────────┘            │
                   │                   │                     │
                   │ N                 │ N                   │ 1
                   │                   │                     │
                   └───────────────────┴─────────────────────┘
                                       │
                                       ▼
                              ┌───────────────────┐
                              │       rooms       │
                              │  (same as above)  │
                              └───────────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│                           RELATIONSHIP SUMMARY                               │
└─────────────────────────────────────────────────────────────────────────────┘

  users (1) ────────< (N) room_members (N) >──────── (1) rooms
       │                      │
       │  "User can be        │  "Many-to-many: users can join
       │   member of many     │   multiple rooms, rooms can have
       │   rooms"             │   multiple members"
       │
       │
  users (1) ────────< (N) messages
       │                  │
       │  "User can       │
       │   author many    │
       │   messages"      │
       │
       │
  users (0..1) ──────────> (1) rooms
       │                        │
       │  "User optionally      │  "Room has optional creator
       │   creates rooms"       │   (SET NULL if deleted)"
       │
       │
  rooms (1) ────────< (N) messages
       │                  │
       │  "Room contains  │
       │   many messages" │
       │
       │
  rooms (1) ────────< (N) room_members
                          │
       "Room has many     │
        member records"
```

---

### Foreign Key Relationships and Cascade Behaviors

| Source Table | Source Column | Target Table | Target Column | On Delete | Rationale |
|--------------|---------------|--------------|---------------|-----------|-----------|
| `rooms` | `created_by` | `users` | `id` | `SET NULL` | Rooms should persist independently of their creator. If a user deletes their account, rooms they created remain usable but show no creator. |
| `room_members` | `room_id` | `rooms` | `id` | `CASCADE` | Memberships are meaningless without the room. Deleting a room automatically removes all membership records. |
| `room_members` | `user_id` | `users` | `id` | `CASCADE` | Memberships are tied to user existence. Deleting a user removes them from all rooms automatically. |
| `messages` | `room_id` | `rooms` | `id` | `CASCADE` | Messages belong to rooms. Deleting a room deletes all its messages (no orphaned messages). |
| `messages` | `user_id` | `users` | `id` | `SET NULL` | Messages are historical records. If a user is deleted, their messages remain but author shows as null (UI displays "[deleted user]"). |

---

### Why Tables Are Structured This Way

#### Normalization Level: Third Normal Form (3NF)

The schema follows 3NF principles:
1. **1NF**: All columns contain atomic values (no arrays or nested structures)
2. **2NF**: All non-key columns depend on the entire primary key (no partial dependencies)
3. **3NF**: No transitive dependencies (non-key columns don't depend on other non-key columns)

**Why not denormalize?**
- Educational: Demonstrates proper relational design
- Scale: At Baby Discord's scale (<1MB data), normalization overhead is negligible
- Flexibility: Easier to add features (e.g., user profiles, room settings) without restructuring

---

#### Why Separate `room_members` Junction Table?

**Alternative considered:** Store member list as JSON array in `rooms` table

```sql
-- NOT USED: Denormalized approach
rooms.members = '["alice", "bob", "charlie"]'
```

**Problems with denormalized approach:**
1. No referential integrity (users could be deleted but remain in array)
2. Inefficient queries ("find all rooms user X is in" requires scanning all rooms)
3. Concurrent updates cause conflicts (two users join simultaneously)
4. No metadata per membership (can't store `joined_at`)

**Junction table benefits:**
- Referential integrity via foreign keys
- Efficient queries in both directions (rooms→users and users→rooms)
- Atomic updates (no read-modify-write race conditions)
- Extensible (can add `role`, `muted_until`, etc.)

---

#### Why `SET NULL` vs `CASCADE` for Different Relationships?

**Principle:** Choose based on entity lifecycle semantics.

| Relationship | On Delete | Reasoning |
|--------------|-----------|-----------|
| `messages.user_id` | `SET NULL` | Messages are historical artifacts. Deleting a user shouldn't erase chat history. Shows as "[deleted user]" in UI. |
| `rooms.created_by` | `SET NULL` | Rooms have independent value from their creator. A busy room shouldn't disappear because one person left. |
| `room_members.*` | `CASCADE` | Memberships are pure relationships. They exist only to link users and rooms. No independent value. |
| `messages.room_id` | `CASCADE` | Messages exist within room context. Orphaned messages (no room) have no meaning. Delete room = delete its messages. |

---

### Data Flow for Key Operations

#### Operation: User Connects and Sends First Message

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ FLOW: New User Connection and First Message                                  │
└──────────────────────────────────────────────────────────────────────────────┘

1. USER CONNECTS (TCP or HTTP)
   ┌─────────────┐
   │   Client    │ ──────────────────────────────────────────────────────────►
   └─────────────┘     /nick alice

2. CHECK IF USER EXISTS
   ┌─────────────┐     SELECT * FROM users WHERE nickname = 'alice'
   │   users     │ ◄─────────────────────────────────────────────────────────
   └─────────────┘
        │
        ▼ (not found)

3. CREATE USER
   ┌─────────────┐     INSERT INTO users (nickname) VALUES ('alice') RETURNING *
   │   users     │ ◄─────────────────────────────────────────────────────────
   └─────────────┘
        │
        └──► Returns: {id: 42, nickname: 'alice', created_at: ...}

4. JOIN DEFAULT ROOM
   ┌─────────────┐     SELECT * FROM rooms WHERE name = 'general'
   │   rooms     │ ◄─────────────────────────────────────────────────────────
   └─────────────┘
        │
        └──► Returns: {id: 1, name: 'general', ...}

5. CREATE MEMBERSHIP
   ┌─────────────┐     INSERT INTO room_members (room_id, user_id)
   │room_members │ ◄───VALUES (1, 42)
   └─────────────┘     ON CONFLICT (room_id, user_id) DO NOTHING

6. LOAD MESSAGE HISTORY
   ┌─────────────┐     SELECT m.*, u.nickname FROM messages m
   │  messages   │ ◄───LEFT JOIN users u ON m.user_id = u.id
   └─────────────┘     WHERE m.room_id = 1
                       ORDER BY m.created_at DESC LIMIT 10
        │
        └──► Returns: Last 10 messages (populates HistoryBuffer)

7. USER SENDS MESSAGE
   ┌─────────────┐     /say Hello everyone!
   │   Client    │ ──────────────────────────────────────────────────────────►
   └─────────────┘

8. PERSIST MESSAGE
   ┌─────────────┐     INSERT INTO messages (room_id, user_id, content)
   │  messages   │ ◄───VALUES (1, 42, 'Hello everyone!') RETURNING *
   └─────────────┘
        │
        └──► Also: Publish to Valkey room:general channel for other instances
```

---

#### Operation: Room Deletion (Cascade Effect)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ FLOW: Room Deletion and Cascade                                              │
└──────────────────────────────────────────────────────────────────────────────┘

Admin runs: DELETE FROM rooms WHERE name = 'old-room'

BEFORE:
┌──────────┐     ┌────────────────┐     ┌────────────┐
│  rooms   │     │  room_members  │     │  messages  │
├──────────┤     ├────────────────┤     ├────────────┤
│ id: 5    │◄────│ room_id: 5     │     │ room_id: 5 │
│ old-room │     │ user_id: 10    │     │ id: 100    │
└──────────┘     │ user_id: 20    │     │ id: 101    │
                 │ user_id: 30    │     │ id: 102    │
                 └────────────────┘     └────────────┘

CASCADE SEQUENCE:
1. PostgreSQL detects FK room_id in room_members references rooms(id)
2. room_members rows with room_id=5 are AUTOMATICALLY DELETED
3. PostgreSQL detects FK room_id in messages references rooms(id)
4. messages rows with room_id=5 are AUTOMATICALLY DELETED
5. rooms row with id=5 is deleted

AFTER:
┌──────────┐     ┌────────────────┐     ┌────────────┐
│  rooms   │     │  room_members  │     │  messages  │
├──────────┤     ├────────────────┤     ├────────────┤
│ (empty)  │     │ (3 rows gone)  │     │ (3 rows    │
└──────────┘     └────────────────┘     │  gone)     │
                                        └────────────┘

WHY THIS DESIGN:
- Single DELETE statement cleans up all related data
- No orphaned memberships or messages
- Application code doesn't need to manage cleanup
- Transactional: All deletes succeed or none do
```

---

#### Operation: User Deletion (Mixed Cascade/SET NULL)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ FLOW: User Deletion - Preserving History                                     │
└──────────────────────────────────────────────────────────────────────────────┘

User runs: DELETE FROM users WHERE nickname = 'alice' (user_id = 42)

BEFORE:
┌──────────┐     ┌────────────────┐     ┌────────────┐     ┌──────────┐
│  users   │     │  room_members  │     │  messages  │     │  rooms   │
├──────────┤     ├────────────────┤     ├────────────┤     ├──────────┤
│ id: 42   │◄────│ user_id: 42    │     │ user_id:42 │     │created_by│
│ alice    │     │ room_id: 1     │     │ id: 200    │     │   : 42   │
└──────────┘     │ room_id: 2     │     │ id: 201    │     │ fun-room │
                 └────────────────┘     └────────────┘     └──────────┘

ACTION SEQUENCE:
1. room_members.user_id → CASCADE
   → Rows with user_id=42 are DELETED (alice leaves all rooms)

2. messages.user_id → SET NULL
   → Rows with user_id=42 get user_id=NULL (messages preserved, author unknown)

3. rooms.created_by → SET NULL
   → Rows with created_by=42 get created_by=NULL (room exists, creator unknown)

4. users row with id=42 is deleted

AFTER:
┌──────────┐     ┌────────────────┐     ┌────────────┐     ┌──────────┐
│  users   │     │  room_members  │     │  messages  │     │  rooms   │
├──────────┤     ├────────────────┤     ├────────────┤     ├──────────┤
│ (alice   │     │ (2 rows gone)  │     │ user_id:   │     │created_by│
│  gone)   │     │                │     │   NULL     │     │ : NULL   │
└──────────┘     └────────────────┘     │ id: 200    │     │ fun-room │
                                        │ id: 201    │     └──────────┘
                                        └────────────┘

UI IMPACT:
- Messages from alice now display as "[deleted user]"
- fun-room still exists but shows "Created by: Unknown"
- alice is no longer in any room member lists
```

---

#### Operation: Message Cleanup (Retention Enforcement)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ FLOW: cleanup_old_messages() Execution                                       │
└──────────────────────────────────────────────────────────────────────────────┘

Scheduler runs: SELECT cleanup_old_messages()

BEFORE (room_id = 1 has 15 messages):
┌────────────────────────────────────────────────────────────────┐
│  messages (room_id = 1)                                        │
├────────────────────────────────────────────────────────────────┤
│  id  │ created_at           │ content         │ rank (window) │
├──────┼──────────────────────┼─────────────────┼───────────────┤
│  115 │ 2024-01-15 10:15:00  │ "newest msg"    │ 1  ◄ KEEP     │
│  114 │ 2024-01-15 10:14:00  │ "..."           │ 2  ◄ KEEP     │
│  113 │ 2024-01-15 10:13:00  │ "..."           │ 3  ◄ KEEP     │
│  112 │ 2024-01-15 10:12:00  │ "..."           │ 4  ◄ KEEP     │
│  111 │ 2024-01-15 10:11:00  │ "..."           │ 5  ◄ KEEP     │
│  110 │ 2024-01-15 10:10:00  │ "..."           │ 6  ◄ KEEP     │
│  109 │ 2024-01-15 10:09:00  │ "..."           │ 7  ◄ KEEP     │
│  108 │ 2024-01-15 10:08:00  │ "..."           │ 8  ◄ KEEP     │
│  107 │ 2024-01-15 10:07:00  │ "..."           │ 9  ◄ KEEP     │
│  106 │ 2024-01-15 10:06:00  │ "..."           │ 10 ◄ KEEP     │
│  105 │ 2024-01-15 10:05:00  │ "..."           │ 11 ◄ DELETE   │
│  104 │ 2024-01-15 10:04:00  │ "..."           │ 12 ◄ DELETE   │
│  103 │ 2024-01-15 10:03:00  │ "..."           │ 13 ◄ DELETE   │
│  102 │ 2024-01-15 10:02:00  │ "..."           │ 14 ◄ DELETE   │
│  101 │ 2024-01-15 10:01:00  │ "oldest msg"    │ 15 ◄ DELETE   │
└──────┴──────────────────────┴─────────────────┴───────────────┘

ALGORITHM:
1. ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC)
   → Assigns rank 1 (newest) to N (oldest) per room

2. Keep rows where rank <= 10
   → IDs 106-115 are preserved

3. Delete rows where rank > 10
   → IDs 101-105 are deleted

AFTER:
┌────────────────────────────────────────────────────────────────┐
│  messages (room_id = 1) - Only 10 messages remain              │
├────────────────────────────────────────────────────────────────┤
│  id  │ created_at           │ content                          │
├──────┼──────────────────────┼──────────────────────────────────┤
│  115 │ 2024-01-15 10:15:00  │ "newest msg"                     │
│  ...                        │ (8 more rows)                    │
│  106 │ 2024-01-15 10:06:00  │ "now the oldest"                 │
└──────┴──────────────────────┴──────────────────────────────────┘

SYNCHRONIZATION:
- After cleanup, HistoryBuffer remains valid (buffer always has <= 10)
- No notification needed (buffer was already bounded)
- Metrics: babydiscord_messages_deleted_total incremented by 5
```

---

### Complete SQL Schema (Consolidated)

For reference, here is the complete schema from `/backend/src/db/init.sql`:

```sql
-- Baby Discord Database Schema
-- This file is executed on database initialization

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    nickname VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rooms table
CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Room membership (many-to-many)
CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient message retrieval by room and time
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at DESC);

-- Index for user nickname lookup
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);

-- Index for room name lookup
CREATE INDEX IF NOT EXISTS idx_rooms_name ON rooms(name);

-- Create a default "general" room
INSERT INTO users (nickname) VALUES ('system') ON CONFLICT (nickname) DO NOTHING;
INSERT INTO rooms (name, created_by)
SELECT 'general', id FROM users WHERE nickname = 'system'
ON CONFLICT (name) DO NOTHING;

-- Function to cleanup old messages (keep only last 10 per room)
CREATE OR REPLACE FUNCTION cleanup_old_messages() RETURNS void AS $$
BEGIN
    DELETE FROM messages m
    WHERE m.id NOT IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC) as rn
            FROM messages
        ) ranked
        WHERE rn <= 10
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

## Frontend Architecture

### Technology Stack

- **React 19** - Component-based UI library
- **TypeScript** - Type-safe development
- **TanStack Router** - File-based routing with type safety
- **Zustand** - Lightweight state management with persistence
- **Tailwind CSS** - Utility-first styling matching Discord's aesthetic
- **Vite** - Fast development server and build tool

### Routing Architecture

The frontend uses TanStack Router with file-based routing for clear URL structure:

```
URL Structure:
/                    → Redirect to /login or /channels/@me
/login               → Login form (unauthenticated users)
/channels/@me        → Home view (authenticated, no room selected)
/channels/:roomId    → Chat room view (e.g., /channels/general)
```

**Route Files:**
```
src/routes/
├── __root.tsx           # Root layout with devtools
├── index.tsx            # Auth redirect logic
├── login.tsx            # Login form route
├── channels.tsx         # Channels layout (sidebar + outlet)
└── channels/
    ├── @me.tsx          # Home/welcome view
    └── $roomId.tsx      # Dynamic room view
```

**Route Protection:**
- Routes use `beforeLoad` guards to check authentication
- Unauthenticated users are redirected to `/login`
- Authenticated users accessing `/login` are redirected to `/channels/@me`

### State Management

**Zustand Store Structure:**
```typescript
interface ChatState {
  // Session (persisted to localStorage)
  session: Session | null;

  // Room state (ephemeral)
  rooms: Room[];
  currentRoom: string | null;
  messages: Message[];

  // Real-time connection
  eventSource: EventSource | null;

  // Actions
  connect(nickname: string): Promise<void>;
  disconnect(): Promise<void>;
  joinRoom(name: string): Promise<void>;
  leaveRoom(): Promise<void>;
  sendMessage(content: string): Promise<void>;
}
```

**Persistence Strategy:**
- Only `session` is persisted to localStorage
- Rooms and messages are fetched fresh on page load
- Enables session survival across browser refreshes

### Real-Time Updates

**Server-Sent Events (SSE):**
- Browser establishes SSE connection when joining a room
- Messages pushed from server in real-time
- Auto-reconnect handled by native EventSource API

```typescript
// SSE connection per room
const eventSource = new EventSource(`/api/messages/${roomId}?sessionId=${sessionId}`);

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data);
  addMessage(message);
};
```

### Navigation Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    User Flow                                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  New User:                                                   │
│  / → (no session) → /login → enter nickname → /channels/@me │
│                                                              │
│  Returning User:                                             │
│  / → (has session) → /channels/@me → click room → /channels/general │
│                                                              │
│  Disconnect:                                                 │
│  /channels/* → click disconnect → /login                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Component Hierarchy

```
RouterProvider
└── __root (TanStack Router)
    ├── /login
    │   └── LoginPage (form with nickname input)
    │
    └── /channels (ChannelsLayout)
        ├── ServerList (room icons sidebar)
        ├── ChannelSidebar (room details, user panel)
        └── Outlet
            ├── /@me → HomeView (welcome message)
            └── /$roomId → RoomView
                ├── ChannelHeader
                ├── MessageList
                └── MessageInput
```

### Why TanStack Router?

**Benefits over React Router:**
- Full TypeScript type safety for routes and params
- File-based routing reduces boilerplate
- Built-in data loading with loaders (future use)
- Developer tools for debugging

**Trade-offs:**
- Newer library, smaller community
- Learning curve for file-based conventions
- Generated route tree file (must be committed)

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

---

## Implementation Notes

This section documents key implementation decisions with rationale for operational excellence.

### WHY Message Retention Policies Prevent Unbounded Storage Costs

**Problem**: Without retention policies, the `messages` table grows indefinitely:
- Storage costs increase linearly with message volume
- Database queries slow down as table size increases
- Backup/restore operations become slower and more expensive
- Index maintenance overhead grows with table size

**Solution**: Configurable retention policies in `shared/config.ts`:

```typescript
export const messageRetention = {
  maxMessagesPerRoom: 10,      // Keep only N messages per room
  maxMessageAgeHours: 0,       // Optional age-based cleanup
  cleanupIntervalMinutes: 5,   // Periodic cleanup job
};
```

**Implementation** (`utils/cleanup.ts`):
- Periodic cleanup job runs every `cleanupIntervalMinutes`
- Count-based cleanup: Deletes messages beyond `maxMessagesPerRoom` per room
- Age-based cleanup: Deletes messages older than `maxMessageAgeHours` (if > 0)
- Metrics track cleanup job runs and messages deleted

**Trade-offs**:
- **Accepted**: Older messages are permanently deleted
- **Mitigated**: Archive-before-delete option for compliance requirements
- **Benefit**: Bounded storage, predictable database performance

### WHY Metrics with Alert Thresholds Enable Proactive Monitoring

**Problem**: Without metrics, issues are discovered when users complain:
- Capacity problems go unnoticed until outage
- Performance regressions are detected late
- Incident diagnosis is slow without data
- Capacity planning is guesswork

**Solution**: Prometheus metrics in `shared/metrics.ts` with thresholds in `shared/config.ts`:

```typescript
// Metrics exposed at GET /metrics
export const messagesSent = new client.Counter({...});
export const activeConnections = new client.Gauge({...});
export const pubsubPublishLatency = new client.Histogram({...});

// Alert thresholds
export const alertThresholds = {
  pubsubLatency: { warning: 100, critical: 500 },
  queueDepth: { warning: 100, critical: 500 },
  dbConnectionWait: { warning: 50, critical: 200 },
};
```

**Key Metrics**:
| Category | Metric | Purpose |
|----------|--------|---------|
| Connections | `babydiscord_active_connections` | Capacity monitoring |
| Throughput | `babydiscord_messages_sent_total` | Load tracking |
| Latency | `babydiscord_pubsub_publish_latency_seconds` | Performance monitoring |
| Cache | `babydiscord_history_buffer_hits_total` | Cache effectiveness |
| Cleanup | `babydiscord_messages_deleted_total` | Retention enforcement |

**Endpoints**:
- `GET /metrics` - Prometheus-format metrics
- `GET /health` - Comprehensive health check with status of all dependencies

**Trade-offs**:
- **Cost**: Small performance overhead for metric collection (~1-2%)
- **Benefit**: Early warning of issues, data-driven capacity planning
- **Integration**: Compatible with Prometheus/Grafana, Datadog, etc.

### WHY Graceful Shutdown Prevents Message Loss

**Problem**: Abrupt shutdown causes:
- In-flight messages are lost
- Database writes may be incomplete
- Connected clients experience errors without warning
- Load balancers continue routing to dead instance

**Solution**: Multi-phase graceful shutdown in `index.ts`:

```typescript
async function shutdown(signal: string) {
  // Phase 1: Stop accepting new connections (drain mode)
  await tcpServer.stop(gracePeriodMs);
  await httpServer.stop(gracePeriodMs);

  // Phase 2: Stop background jobs
  stopCleanupJob();

  // Phase 3: Close external connections
  await pubsubManager.disconnect();
  await db.close();

  // Phase 4: Flush logs and exit
  await flushLogs();
}
```

**Shutdown Sequence**:
1. **Enter drain mode**: Stop accepting new connections
2. **Notify clients**: Send shutdown warning to connected SSE/TCP clients
3. **Grace period**: Wait for in-flight requests to complete (configurable, default 10s)
4. **Stop jobs**: Halt cleanup job to prevent partial operations
5. **Disconnect dependencies**: Close Redis and database connections cleanly
6. **Flush logs**: Ensure all log entries are written before exit

**Client Behavior**:
- SSE clients receive `event: shutdown` and can reconnect to another instance
- TCP clients receive `[SYSTEM] Server is shutting down` message
- New connections during drain are rejected with appropriate error

**Configuration** (`.env`):
```bash
SHUTDOWN_GRACE_PERIOD_MS=10000    # 10 second grace period
SHUTDOWN_WARNING_INTERVAL_MS=2000  # Log remaining connections every 2s
DRAIN_CONNECTIONS=true             # Enable connection draining
```

**Trade-offs**:
- **Cost**: Slower shutdown (up to 10s vs immediate)
- **Benefit**: Zero message loss, clean client experience, safe rolling deploys

### WHY Migration Scripts Enable Safe Schema Changes

**Problem**: Manual schema changes are error-prone:
- No record of what changes were applied
- Risk of applying same change twice
- No way to rollback failed changes
- Different environments can drift out of sync

**Solution**: Versioned migrations in `db/migrate.ts`:

```typescript
// Migration files: 001_initial_schema.sql, 002_add_index.sql, etc.
class MigrationRunner {
  async migrate(): Promise<{ applied: string[]; skipped: string[] }>;
  async status(): Promise<void>;
  async rollback(): Promise<string | null>;
}
```

**Migration Features**:
- **Version tracking**: `schema_migrations` table tracks applied migrations
- **Checksum validation**: Detects if applied migrations were modified
- **Transactional**: Each migration runs in a transaction (rollback on failure)
- **Rollback support**: Down migrations via `NNN_description.down.sql` files
- **Backwards compatible**: Runs legacy `init.sql` on first migration

**Usage**:
```bash
npm run db:migrate          # Apply pending migrations
npm run db:migrate:status   # Show migration status
npm run db:migrate:rollback # Rollback last migration
```

**Best Practices**:
1. Always add columns as nullable first, then backfill, then add NOT NULL
2. Create indexes with `CONCURRENTLY` when possible
3. Test migrations on copy of production data before deploying
4. Keep migrations small and focused (one logical change per file)

**Trade-offs**:
- **Cost**: Additional infrastructure (migrations table, tooling)
- **Benefit**: Safe, auditable, reversible schema changes

---

### Implementation File Summary

| File | Purpose |
|------|---------|
| `shared/config.ts` | Centralized configuration with retention policies and alert thresholds |
| `shared/metrics.ts` | Prometheus metrics for monitoring |
| `utils/logger.ts` | Structured JSON logging with Pino |
| `utils/cleanup.ts` | Message retention cleanup job |
| `db/migrate.ts` | Versioned database migration runner |
| `adapters/http-server.ts` | HTTP server with `/metrics` and `/health` endpoints |
| `adapters/tcp-server.ts` | TCP server with graceful shutdown |
| `index.ts` | Application entry point with full graceful shutdown |

# WhatsApp - Messaging Platform - Architecture Design

## System Overview

A real-time messaging platform with end-to-end encryption supporting one-on-one messaging, group chats, media sharing, and presence indicators. This architecture document describes the local development implementation while noting production-scale considerations.

## Requirements

### Functional Requirements

1. **One-on-One Messaging**
   - Send text messages between two users
   - Message delivery with read receipts (sent, delivered, read)
   - Show online/offline and typing indicators

2. **Group Chats**
   - Create groups with up to 256 members
   - Send messages visible to all group members
   - Manage group membership (add/remove)

3. **Media Sharing**
   - Send images, videos, documents
   - Thumbnail generation for previews
   - Efficient upload and download

4. **Offline Message Delivery**
   - Queue messages when recipient is offline
   - Deliver all pending messages on reconnect
   - Maintain message ordering within conversations

5. **End-to-End Encryption** (future phase)
   - Messages encrypted on sender device
   - Only recipient can decrypt
   - Server never sees plaintext

### Non-Functional Requirements

| Requirement | Local Dev Target | Production Target | Notes |
|-------------|------------------|-------------------|-------|
| **Latency** | < 200ms message delivery | < 100ms | Measured from send to delivery ACK |
| **Availability** | 99% (single node) | 99.99% | Local allows restart tolerance |
| **Throughput** | 100 messages/sec | 1M+ messages/sec | Local: 2-5 server instances |
| **Concurrent Users** | 100-500 | 500M+ | Local limited by dev machine |
| **Message Ordering** | Per-conversation order | Per-conversation order | Timestamp-based with sequence fallback |
| **Durability** | At-least-once delivery | At-least-once delivery | PostgreSQL + WebSocket ACK |

---

## Capacity Estimation

### Local Development Scale

Designed to run on a single developer machine (8GB RAM, 4 cores).

| Metric | Local Target | Calculation |
|--------|--------------|-------------|
| **Daily Active Users** | 50-100 | Simulated test users |
| **Concurrent WebSocket Connections** | 100-500 | Per server instance, 2-5 instances |
| **Messages per Second** | 50-100 | Peak during testing |
| **Message Size** | ~500 bytes avg | JSON with metadata |
| **Storage Growth** | ~50 MB/day | 100K messages x 500 bytes |
| **Database Size** | < 1 GB total | 30-day retention |
| **Redis Memory** | < 100 MB | Sessions, presence, routing |

### Component Sizing (Local)

| Component | Instances | Resources | Purpose |
|-----------|-----------|-----------|---------|
| API/WebSocket Server | 2-5 | 256MB RAM each | Handle connections, route messages |
| PostgreSQL | 1 | 512MB RAM | Users, conversations metadata |
| Cassandra | 1 | 512MB RAM | Messages, delivery status (write-heavy) |
| Redis/Valkey | 1 | 128MB RAM | Sessions, presence, pub/sub |
| MinIO (optional) | 1 | 256MB RAM | Media storage |

### Scaling Triggers

Move to production architecture when:
- Concurrent connections > 1,000 per server
- Message throughput > 500/sec sustained
- Database size > 10 GB
- Message latency p95 > 500ms

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Client Layer                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                         │
│  │ React Web   │  │ Mobile App  │  │ Test Client │                         │
│  │ (localhost  │  │ (future)    │  │ (curl/wscat)│                         │
│  │  :5173)     │  │             │  │             │                         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                         │
└─────────┼────────────────┼────────────────┼─────────────────────────────────┘
          │ HTTP/WS        │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Load Balancer (nginx)                                │
│                           localhost:3000                                     │
│                    (sticky sessions for WebSocket)                          │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   API Server 1  │    │   API Server 2  │    │   API Server 3  │
│   :3001         │    │   :3002         │    │   :3003         │
│                 │    │                 │    │                 │
│ ┌─────────────┐ │    │ ┌─────────────┐ │    │ ┌─────────────┐ │
│ │ Express     │ │    │ │ Express     │ │    │ │ Express     │ │
│ │ REST API    │ │    │ │ REST API    │ │    │ │ REST API    │ │
│ └─────────────┘ │    │ └─────────────┘ │    │ └─────────────┘ │
│ ┌─────────────┐ │    │ ┌─────────────┐ │    │ ┌─────────────┐ │
│ │ WebSocket   │◄┼────┼─┤ Redis       ├─┼────┼─► WebSocket   │ │
│ │ Handler     │ │    │ │ Pub/Sub     │ │    │ │ Handler     │ │
│ └─────────────┘ │    │ └─────────────┘ │    │ └─────────────┘ │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
     ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
     │   PostgreSQL    │ │   Redis/Valkey  │ │   MinIO         │
     │   :5432         │ │   :6379         │ │   :9000         │
     │                 │ │                 │ │                 │
     │ - Users         │ │ - Sessions      │ │ - Images        │
     │ - Conversations │ │ - Presence      │ │ - Videos        │
     │ - Messages      │ │ - User→Server   │ │ - Documents     │
     │ - Message Status│ │ - Typing flags  │ │                 │
     │ - Participants  │ │ - Pub/Sub       │ │                 │
     └─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## Request Flow

### 1. Message Send Flow (Online-to-Online)

```
┌────────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐    ┌────────────┐
│ Sender │    │ Server A │    │  Redis  │    │ Server B │    │ Recipient  │
└───┬────┘    └────┬─────┘    └────┬────┘    └────┬─────┘    └─────┬──────┘
    │              │               │              │                │
    │─1. WS: send_message─────────►│               │                │
    │              │               │              │                │
    │              │─2. INSERT message─────►      │                │
    │              │   (PostgreSQL)│              │                │
    │              │               │              │                │
    │              │─3. GET session:recipient────►│                │
    │              │               │              │                │
    │              │◄──────server_b_id────────────│                │
    │              │               │              │                │
    │              │─4. PUBLISH server:B, msg────►│                │
    │              │               │              │                │
    │              │               │─5. Subscribe receives────────►│
    │              │               │              │                │
    │              │               │              │─6. WS: new_message──────►│
    │              │               │              │                │
    │              │               │              │◄─7. WS: ack────│
    │              │               │              │                │
    │              │               │◄─8. UPDATE status=delivered───│
    │              │               │              │                │
    │◄─9. WS: message_delivered───│               │                │
    │              │               │              │                │
```

### 2. Message Send Flow (Recipient Offline)

```
┌────────┐    ┌──────────┐    ┌─────────┐    ┌──────────────────────────┐
│ Sender │    │ Server   │    │  Redis  │    │       PostgreSQL          │
└───┬────┘    └────┬─────┘    └────┬────┘    └────────────┬─────────────┘
    │              │               │                      │
    │─1. WS: send_message─────────►│                       │
    │              │               │                      │
    │              │─2. INSERT message, status='sent'────►│
    │              │               │                      │
    │              │─3. GET session:recipient────────────►│
    │              │               │                      │
    │              │◄──────────null (not connected)───────│
    │              │               │                      │
    │◄─4. WS: message_sent────────│                       │
    │              │               │                      │
    │              │ (message waits in DB until recipient connects)
```

### 3. User Connect and Pending Message Delivery

```
┌────────────┐    ┌──────────┐    ┌─────────┐    ┌──────────────────────────┐
│ Recipient  │    │ Server   │    │  Redis  │    │       PostgreSQL          │
└─────┬──────┘    └────┬─────┘    └────┬────┘    └────────────┬─────────────┘
      │                │               │                      │
      │─1. WS: connect───────────────►│                       │
      │                │               │                      │
      │                │─2. SET session:user, server_id──────►│
      │                │               │                      │
      │                │─3. SET presence:user, online────────►│
      │                │               │                      │
      │                │─4. SELECT pending messages──────────────────────────►│
      │                │               │                      │
      │                │◄─────────────────pending messages────│
      │                │               │                      │
      │◄─5. WS: messages[] ───────────│                       │
      │                │               │                      │
      │─6. WS: ack (per message)─────►│                       │
      │                │               │                      │
      │                │─7. UPDATE status='delivered'────────────────────────►│
      │                │               │                      │
```

---

## Data Model

### PostgreSQL Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Conversations (1:1 or group)
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
    name VARCHAR(100),  -- NULL for direct, set for groups
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Conversation participants
CREATE TABLE conversation_participants (
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(10) DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_read_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (conversation_id, user_id)
);

-- Messages
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
    content TEXT,  -- Encrypted in production
    content_type VARCHAR(20) DEFAULT 'text' CHECK (content_type IN ('text', 'image', 'video', 'file')),
    media_url TEXT,
    reply_to_id UUID REFERENCES messages(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Index for fetching conversation history (descending for latest first)
    CONSTRAINT messages_conversation_idx UNIQUE (conversation_id, created_at, id)
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_sender ON messages(sender_id, created_at DESC);

-- Message delivery status per recipient
CREATE TABLE message_status (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (message_id, recipient_id)
);

CREATE INDEX idx_message_status_recipient ON message_status(recipient_id, status);
```

### Cassandra Schema (Messages)

While PostgreSQL handles users and conversation metadata, Cassandra is used for the high-write message storage. This hybrid approach leverages each database's strengths.

**Why Cassandra for Messages?**
- **High-write throughput**: WhatsApp handles billions of messages daily with 100:1 write:read ratio
- **Time-ordered retrieval**: TimeUUID clustering keys provide natural ordering within conversations
- **TTL for message lifecycle**: Automatic cleanup of old messages
- **Partition by conversation**: All messages for a conversation are co-located for efficient retrieval

```cql
-- Keyspace configuration
CREATE KEYSPACE whatsapp_messages WITH REPLICATION = {
  'class': 'SimpleStrategy',
  'replication_factor': 1
};

-- Messages by conversation
-- Partition key: conversation_id (all messages together)
-- Clustering key: message_id (TimeUUID for time ordering)
CREATE TABLE messages_by_conversation (
    conversation_id UUID,
    message_id TIMEUUID,
    sender_id UUID,
    content TEXT,
    content_type TEXT,          -- 'text', 'image', 'video', 'audio'
    media_url TEXT,
    reply_to_message_id TIMEUUID,
    created_at TIMESTAMP,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND default_time_to_live = 31536000;  -- 1 year TTL

-- User inbox (conversation list)
CREATE TABLE user_inbox (
    user_id UUID,
    last_message_at TIMESTAMP,
    conversation_id UUID,
    other_username TEXT,        -- Denormalized for display
    last_message_preview TEXT,  -- First 100 chars
    unread_count INT,
    PRIMARY KEY (user_id, last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (last_message_at DESC);

-- Message delivery status
CREATE TABLE message_status (
    conversation_id UUID,
    message_id TIMEUUID,
    recipient_id UUID,
    status TEXT,                -- 'sent', 'delivered', 'read'
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    PRIMARY KEY ((conversation_id, message_id), recipient_id)
);
```

**Data Flow:**
```
1. User sends message:
   → INSERT into messages_by_conversation (Cassandra)
   → UPDATE user_inbox for all participants (Cassandra)
   → Redis pub/sub for real-time delivery

2. User opens conversation:
   → SELECT * FROM messages_by_conversation
     WHERE conversation_id = ? LIMIT 50

3. Message delivered/read:
   → UPDATE message_status in Cassandra
   → WebSocket notification to sender
```

**Why denormalize in user_inbox?**
- Avoids joins across partitions (not supported in Cassandra)
- Single query to render inbox list
- Trade-off: Must update all inboxes when a message is sent

### Redis Data Structures

```
# Session: Maps user to their connected server
# TTL: Session expiry (24 hours)
SET session:{user_id} server_id EX 86400

# Presence: User online status
# TTL: None (deleted on disconnect)
HSET presence:{user_id}
    status "online|offline"
    server_id "server_1"
    last_seen 1704067200000

# Typing indicators
# TTL: 3 seconds (auto-expire)
SETEX typing:{conversation_id}:{user_id} 3 "1"

# Pub/Sub channels for cross-server messaging
SUBSCRIBE server:{server_id}
PUBLISH server:{server_id} '{"type":"message","payload":...}'

# WebSocket connection count per server (for load monitoring)
INCR connections:{server_id}
DECR connections:{server_id}
```

### Sample Data Sizes

| Entity | Record Size | Count (Local) | Total Size |
|--------|-------------|---------------|------------|
| User | ~500 bytes | 100 | 50 KB |
| Conversation | ~200 bytes | 500 | 100 KB |
| Participant | ~100 bytes | 1,000 | 100 KB |
| Message | ~500 bytes | 100,000 | 50 MB |
| Message Status | ~50 bytes | 100,000 | 5 MB |

---

## Storage Strategy

### PostgreSQL (Primary Data Store)

**Purpose**: Persistent storage for all structured data.

| Data | Access Pattern | Optimization |
|------|----------------|--------------|
| Users | Read by ID, username | B-tree index on username |
| Conversations | Read by participant | Join through participants table |
| Messages | Paginated by conversation, time-descending | Composite index (conversation_id, created_at DESC) |
| Message Status | Filter by recipient + status | Index on (recipient_id, status) |

**Query Examples**:
```sql
-- Get conversation messages (paginated)
SELECT m.*, ms.status
FROM messages m
LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.recipient_id = $user_id
WHERE m.conversation_id = $conv_id
ORDER BY m.created_at DESC
LIMIT 50 OFFSET 0;

-- Get pending messages for user on connect
SELECT m.*
FROM messages m
JOIN message_status ms ON m.id = ms.message_id
WHERE ms.recipient_id = $user_id AND ms.status = 'sent'
ORDER BY m.created_at ASC;

-- Get conversations with unread count
SELECT c.*, COUNT(ms.message_id) as unread_count
FROM conversations c
JOIN conversation_participants cp ON c.id = cp.conversation_id
LEFT JOIN messages m ON c.id = m.conversation_id AND m.created_at > cp.last_read_at
LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.recipient_id = $user_id AND ms.status != 'read'
WHERE cp.user_id = $user_id
GROUP BY c.id
ORDER BY c.updated_at DESC;
```

### Redis/Valkey (Session & Real-time State)

**Purpose**: Fast lookups for routing, presence, and cross-server communication.

| Data | TTL | Eviction | Notes |
|------|-----|----------|-------|
| Sessions | 24 hours | Expire | Refreshed on activity |
| Presence | None | Manual delete | Cleaned on disconnect |
| Typing | 3 seconds | Expire | Auto-cleanup |
| Pub/Sub | N/A | N/A | In-memory only |

### MinIO (Media Storage)

**Purpose**: Store uploaded images, videos, and documents.

| Media Type | Max Size | Path Pattern |
|------------|----------|--------------|
| Images | 10 MB | `/media/{conversation_id}/{message_id}/image.{ext}` |
| Videos | 100 MB | `/media/{conversation_id}/{message_id}/video.{ext}` |
| Documents | 50 MB | `/media/{conversation_id}/{message_id}/doc.{ext}` |
| Thumbnails | Generated | `/media/{conversation_id}/{message_id}/thumb.jpg` |

---

## Caching Strategy

### Cache Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                        Request Path                              │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ L1: In-Memory (Node.js process)                                 │
│ - User session data (after auth)                                │
│ - Recent conversation metadata                                   │
│ - TTL: 60 seconds                                               │
│ - Size: 10 MB max per process                                   │
└─────────────────────────────────────────────────────────────────┘
                               │ miss
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2: Redis (shared)                                               │
│ - Session → server mapping                                       │
│ - Presence state                                                │
│ - Hot conversation metadata                                      │
│ - TTL: varies (5 min - 24 hours)                                │
└─────────────────────────────────────────────────────────────────┘
                               │ miss
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ L3: PostgreSQL                                                   │
│ - Source of truth                                               │
│ - All persistent data                                           │
└─────────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern (Read)

```javascript
async function getUserProfile(userId) {
  // L1: Check process memory
  const cached = memoryCache.get(`user:${userId}`);
  if (cached) return cached;

  // L2: Check Redis
  const redisData = await redis.get(`user:profile:${userId}`);
  if (redisData) {
    const user = JSON.parse(redisData);
    memoryCache.set(`user:${userId}`, user, 60); // 60s TTL
    return user;
  }

  // L3: Query PostgreSQL
  const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);

  // Populate caches
  await redis.setex(`user:profile:${userId}`, 300, JSON.stringify(user)); // 5 min
  memoryCache.set(`user:${userId}`, user, 60);

  return user;
}
```

### Write-Through Pattern (Write)

```javascript
async function updateUserProfile(userId, updates) {
  // 1. Write to PostgreSQL
  await db.query('UPDATE users SET display_name = $2 WHERE id = $1', [userId, updates.displayName]);

  // 2. Invalidate caches
  await redis.del(`user:profile:${userId}`);
  memoryCache.del(`user:${userId}`);

  // 3. Optionally: Write-through to cache
  const updatedUser = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  await redis.setex(`user:profile:${userId}`, 300, JSON.stringify(updatedUser));
}
```

### Cache TTLs

| Data Type | L1 (Memory) | L2 (Redis) | Invalidation |
|-----------|-------------|------------|--------------|
| User profile | 60s | 5 min | On update |
| Conversation metadata | 60s | 5 min | On update |
| Message history | None | None | Not cached (too dynamic) |
| Presence | None | Real-time | On connect/disconnect |
| Session | Request duration | 24 hours | On logout |

---

## Message Queue / Async Processing

### Redis Pub/Sub for Real-time Routing

**Purpose**: Route messages between servers without polling.

```javascript
// On server startup
const serverId = process.env.SERVER_ID; // e.g., "server_1"
const subscriber = redis.duplicate();

await subscriber.subscribe(`server:${serverId}`, (message) => {
  const { type, payload } = JSON.parse(message);

  switch (type) {
    case 'message':
      deliverToLocalSocket(payload.recipientId, payload);
      break;
    case 'typing':
      broadcastTypingToConversation(payload);
      break;
    case 'presence':
      notifyPresenceChange(payload);
      break;
  }
});

// To send to another server
async function routeToServer(targetServerId, message) {
  await redis.publish(`server:${targetServerId}`, JSON.stringify(message));
}
```

### Message Delivery Semantics

| Scenario | Guarantee | Implementation |
|----------|-----------|----------------|
| Online delivery | At-most-once via WebSocket | ACK from client confirms receipt |
| Offline delivery | At-least-once from DB | Query pending on connect, update status on ACK |
| Duplicate prevention | Client deduplication | Client tracks message IDs, ignores duplicates |

### Future: RabbitMQ for Background Jobs

When scaling beyond local dev, add RabbitMQ for:

```javascript
// Job queues (future implementation)
const queues = {
  'media.process': {
    jobs: ['generate_thumbnail', 'transcode_video', 'scan_for_malware'],
    workers: 2,
    retry: 3
  },
  'notification.push': {
    jobs: ['send_push_notification', 'send_email_digest'],
    workers: 1,
    retry: 5
  },
  'analytics.events': {
    jobs: ['track_message_sent', 'track_login'],
    workers: 1,
    retry: 0  // Fire and forget
  }
};
```

---

## API Design

### REST Endpoints

```
Authentication
POST   /api/v1/auth/register     Create new user account
POST   /api/v1/auth/login        Login, create session
POST   /api/v1/auth/logout       Destroy session
GET    /api/v1/auth/me           Get current user profile

Users
GET    /api/v1/users             Search users by username
GET    /api/v1/users/:id         Get user profile
PUT    /api/v1/users/:id         Update own profile

Conversations
GET    /api/v1/conversations                    List user's conversations
POST   /api/v1/conversations                    Create new conversation (1:1 or group)
GET    /api/v1/conversations/:id                Get conversation details
PUT    /api/v1/conversations/:id                Update conversation (name, etc.)
DELETE /api/v1/conversations/:id                Leave/delete conversation
GET    /api/v1/conversations/:id/messages       Get messages (paginated)
POST   /api/v1/conversations/:id/messages       Send message (REST fallback)
PUT    /api/v1/conversations/:id/read           Mark conversation as read
POST   /api/v1/conversations/:id/participants   Add participant (groups)
DELETE /api/v1/conversations/:id/participants/:userId  Remove participant

Media
POST   /api/v1/media/upload      Upload file, returns media_url
GET    /api/v1/media/:id         Download file (via MinIO presigned URL)
```

### WebSocket Messages

```javascript
// Client → Server
{
  type: 'message',
  payload: {
    conversationId: 'uuid',
    content: 'Hello!',
    contentType: 'text',
    clientMessageId: 'uuid'  // For deduplication
  }
}

{
  type: 'typing',
  payload: { conversationId: 'uuid' }
}

{
  type: 'ack',
  payload: { messageId: 'uuid' }
}

{
  type: 'read',
  payload: { conversationId: 'uuid', upToMessageId: 'uuid' }
}

// Server → Client
{
  type: 'message',
  payload: {
    id: 'uuid',
    conversationId: 'uuid',
    senderId: 'uuid',
    content: 'Hello!',
    createdAt: '2024-01-01T00:00:00Z'
  }
}

{
  type: 'message_status',
  payload: {
    messageId: 'uuid',
    status: 'delivered' | 'read',
    userId: 'uuid'  // Who delivered/read
  }
}

{
  type: 'typing',
  payload: {
    conversationId: 'uuid',
    userId: 'uuid',
    isTyping: true
  }
}

{
  type: 'presence',
  payload: {
    userId: 'uuid',
    status: 'online' | 'offline',
    lastSeen: '2024-01-01T00:00:00Z'
  }
}

{
  type: 'error',
  payload: {
    code: 'UNAUTHORIZED' | 'RATE_LIMITED' | 'INVALID_MESSAGE',
    message: 'Human-readable error'
  }
}
```

---

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19 + Vite + TypeScript | Modern tooling, fast dev experience |
| **UI State** | Zustand | Simple, lightweight state management |
| **Routing** | TanStack Router | Type-safe, modern routing |
| **Styling** | Tailwind CSS | Rapid UI development |
| **Backend** | Node.js + Express | Familiar, good WebSocket ecosystem |
| **WebSocket** | ws library | Lightweight, performant |
| **Database** | PostgreSQL | ACID compliance, rich querying |
| **Cache/Sessions** | Redis/Valkey | Fast, pub/sub support |
| **Object Storage** | MinIO | S3-compatible, local development |
| **Containerization** | Docker Compose | Consistent local environment |

### Production Alternatives (When Scaling)

| Local Choice | Production Alternative | When to Switch |
|--------------|----------------------|----------------|
| PostgreSQL for messages | Cassandra | > 10M messages, write throughput |
| Redis Pub/Sub | Kafka | > 10K messages/sec, durability needs |
| Single MinIO | S3 + CloudFront CDN | Global distribution, reliability |
| Express | Fastify or Go | CPU-bound performance |

---

## Frontend Brand Identity

### Why Authentic Brand Styling Matters

For a system design learning project, matching the original WhatsApp visual identity serves several important purposes:

1. **Recognition and Context**: Users (and interviewers) immediately understand what system is being replicated, making it easier to discuss design decisions in the context of a familiar product.

2. **Attention to Detail**: Demonstrating ability to replicate a production UI shows frontend competency and attention to detail - skills that translate directly to professional work.

3. **Complete System Understanding**: System design is not just backend architecture. The frontend is part of the system, and understanding how UI decisions (like color-coded read receipts) map to backend features (delivery status tracking) shows full-stack thinking.

4. **Realistic Testing**: A visually authentic interface makes it easier to mentally simulate real user flows during testing and demos, helping identify UX issues that might affect architecture decisions.

### WhatsApp Brand Colors

| Purpose | Color | Hex Code | Usage |
|---------|-------|----------|-------|
| **Primary Green** | WhatsApp Green | `#25D366` | Logo, primary actions, accents |
| **Header Teal** | Dark Teal | `#008069` | Header background |
| **Header Teal (Lighter)** | Teal | `#00A884` | Header text, active states |
| **Outgoing Message** | Light Green | `#DCF8C6` | Sent message bubbles |
| **Incoming Message** | White | `#FFFFFF` | Received message bubbles |
| **Chat Background** | Beige/Cream | `#ECE5DD` | Chat area background |
| **Primary Text** | Dark Gray | `#111B21` | Main text content |
| **Secondary Text** | Gray | `#667781` | Timestamps, metadata, single tick |
| **Read Receipts** | Blue | `#53BDEB` | Double-check marks (read) |
| **Unread Badge** | Green | `#25D366` | Conversation unread count |

### Typography

WhatsApp uses a system font stack for cross-platform consistency:

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

| Element | Size | Weight | Notes |
|---------|------|--------|-------|
| Message text | 14.2px | 400 | Optimized for readability |
| Contact names | 16-17px | 500-600 | Slightly larger for hierarchy |
| Timestamps | 11px | 400 | Subdued, secondary information |
| Input placeholder | 14px | 400 | Matches message text |

### Key UI Components

#### Header Bar
- **Background**: Teal gradient (`#008069` to `#00A884`)
- **Elements**: Back button, avatar, contact name, status
- **Height**: ~60px on mobile, ~52px on desktop

#### Message Bubbles
- **Outgoing**: Light green (`#DCF8C6`) with tail pointing right
- **Incoming**: White (`#FFFFFF`) with tail pointing left
- **Border radius**: 7.5px
- **Max width**: 65% of chat area
- **Padding**: 6px 7px 8px 9px (asymmetric for tail)

#### Message Bubble Tails
Distinctive triangular tails that point to the sender:
- Outgoing messages: tail on right side
- Incoming messages: tail on left side
- Implemented via CSS borders or SVG

#### Delivery Status Indicators
| Status | Icon | Color | Meaning |
|--------|------|-------|---------|
| Sent | Single check | `#667781` | Message reached server |
| Delivered | Double check | `#667781` | Message reached recipient device |
| Read | Double check | `#53BDEB` | Recipient opened conversation |

#### Chat Background
- Base color: `#ECE5DD` (beige/cream)
- Optional: Subtle doodle pattern overlay
- Provides visual separation from message bubbles

### Implementation Notes

The frontend applies these styles in `/frontend/src/`:

```
├── index.css              # Global styles, CSS variables for brand colors
├── components/
│   ├── ChatHeader.tsx     # Teal header with contact info
│   ├── MessageBubble.tsx  # Green/white bubbles with tails
│   ├── MessageStatus.tsx  # Tick marks with appropriate colors
│   └── ConversationList.tsx # Sidebar with unread badges
```

CSS variables for easy theming:
```css
:root {
  --whatsapp-primary: #25D366;
  --whatsapp-teal-dark: #008069;
  --whatsapp-teal-light: #00A884;
  --whatsapp-outgoing: #DCF8C6;
  --whatsapp-incoming: #FFFFFF;
  --whatsapp-chat-bg: #ECE5DD;
  --whatsapp-text-primary: #111B21;
  --whatsapp-text-secondary: #667781;
  --whatsapp-read-receipt: #53BDEB;
}
```

---

## Security

### Authentication

```javascript
// Session-based authentication with Redis store
const sessionConfig = {
  store: new RedisStore({ client: redis }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000  // 24 hours
  }
};

// WebSocket authentication
wss.on('connection', async (ws, req) => {
  // Parse session from cookie
  const session = await getSessionFromCookie(req.headers.cookie);

  if (!session || !session.userId) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.userId = session.userId;
  registerConnection(ws);
});
```

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| **User** | Send messages, create 1:1 chats, join groups, update own profile |
| **Group Member** | All User + send to group, view group messages |
| **Group Admin** | All Member + add/remove members, update group settings, delete group |
| **System Admin** | All + view all users, moderate content, view metrics |

```javascript
// Middleware example
function requireGroupAdmin(req, res, next) {
  const { conversationId } = req.params;
  const { userId } = req.session;

  const participant = await db.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );

  if (!participant || participant.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}
```

### Rate Limiting

```javascript
const rateLimits = {
  // REST API
  'auth/login': { window: '15m', max: 5 },       // Prevent brute force
  'auth/register': { window: '1h', max: 3 },     // Prevent spam
  'messages/send': { window: '1m', max: 60 },    // 1 msg/sec average
  'media/upload': { window: '1h', max: 100 },    // Prevent abuse

  // WebSocket
  'ws/message': { window: '1s', max: 5 },        // Burst limit
  'ws/typing': { window: '1s', max: 2 },         // Typing spam
};

// Implementation with express-rate-limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many login attempts' });
  }
});
```

### Input Validation

```javascript
// Message validation
const messageSchema = {
  content: { type: 'string', maxLength: 10000 },
  contentType: { enum: ['text', 'image', 'video', 'file'] },
  conversationId: { type: 'uuid' },
  replyToId: { type: 'uuid', optional: true }
};

// Sanitization
function sanitizeMessage(content) {
  // Remove potential XSS
  return DOMPurify.sanitize(content, { ALLOWED_TAGS: [] });
}
```

---

## Observability

### Metrics (Prometheus)

```javascript
// Key metrics to collect
const metrics = {
  // Request metrics
  http_request_duration_seconds: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
  }),

  // WebSocket metrics
  websocket_connections_total: new Gauge({
    name: 'websocket_connections_total',
    help: 'Current WebSocket connections',
    labelNames: ['server_id']
  }),

  // Message metrics
  messages_sent_total: new Counter({
    name: 'messages_sent_total',
    help: 'Total messages sent',
    labelNames: ['type']  // text, image, etc.
  }),

  message_delivery_duration_seconds: new Histogram({
    name: 'message_delivery_duration_seconds',
    help: 'Time from send to delivery ACK',
    buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5]
  }),

  // Database metrics
  db_query_duration_seconds: new Histogram({
    name: 'db_query_duration_seconds',
    help: 'Database query duration',
    labelNames: ['query_type'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5]
  })
};
```

### SLI Dashboard (Grafana)

| SLI | Target | Query |
|-----|--------|-------|
| Message delivery latency p95 | < 200ms | `histogram_quantile(0.95, message_delivery_duration_seconds)` |
| API latency p99 | < 500ms | `histogram_quantile(0.99, http_request_duration_seconds)` |
| WebSocket connection success | > 99% | `websocket_connections_success / websocket_connections_attempts` |
| Message delivery success | > 99.9% | `messages_delivered / messages_sent` |
| Error rate | < 1% | `sum(rate(http_requests{status=~"5.."})) / sum(rate(http_requests))` |

### Alert Thresholds

```yaml
groups:
  - name: whatsapp-alerts
    rules:
      - alert: HighMessageLatency
        expr: histogram_quantile(0.95, message_delivery_duration_seconds) > 0.5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Message delivery latency above 500ms"

      - alert: WebSocketConnectionDrop
        expr: rate(websocket_disconnections_total[1m]) > 10
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "High WebSocket disconnection rate"

      - alert: DatabaseConnectionPoolExhausted
        expr: pg_stat_activity_count / pg_settings_max_connections > 0.8
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL connection pool near capacity"

      - alert: RedisMemoryHigh
        expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis memory usage above 80%"
```

### Logging

```javascript
// Structured logging with pino
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'whatsapp-api',
    server_id: process.env.SERVER_ID
  }
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      user_id: req.session?.userId
    });
  });

  next();
});

// Message event logging
function logMessageEvent(event, message, userId) {
  logger.info({
    event,
    message_id: message.id,
    conversation_id: message.conversationId,
    user_id: userId,
    content_type: message.contentType
  });
}
```

### Distributed Tracing

```javascript
// Trace context propagation
const traceMiddleware = (req, res, next) => {
  const traceId = req.headers['x-trace-id'] || crypto.randomUUID();
  const spanId = crypto.randomUUID().slice(0, 16);

  req.traceContext = { traceId, spanId };
  res.setHeader('x-trace-id', traceId);

  next();
};

// Include in all logs and downstream calls
async function sendMessage(message, traceContext) {
  logger.info({ ...traceContext, event: 'message_send_start' });

  await db.query('INSERT INTO messages...', [], { traceContext });
  await redis.publish('...', JSON.stringify({ ...message, traceContext }));

  logger.info({ ...traceContext, event: 'message_send_complete' });
}
```

---

## Failure Handling

### Retry Strategy

```javascript
// Exponential backoff with jitter
async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 100, maxDelay = 5000 } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      // Don't retry non-transient errors
      if (error.code === 'UNIQUE_VIOLATION') throw error;

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * 0.2 * Math.random();

      await sleep(delay + jitter);
    }
  }
}

// Usage
await withRetry(() => db.query('INSERT INTO messages...'), { maxRetries: 3 });
```

### Idempotency Keys

```javascript
// Client generates unique ID for each message
const sendMessage = async (content, conversationId) => {
  const clientMessageId = crypto.randomUUID();

  await ws.send(JSON.stringify({
    type: 'message',
    payload: { content, conversationId, clientMessageId }
  }));

  // Store in pending queue
  pendingMessages.set(clientMessageId, { content, conversationId, sentAt: Date.now() });
};

// Server deduplication
const processMessage = async (message) => {
  const dedupKey = `dedup:${message.clientMessageId}`;

  // SETNX returns 1 if key didn't exist (first attempt)
  const isNew = await redis.setnx(dedupKey, '1');
  if (!isNew) {
    // Already processed - return existing message
    return await getMessageByClientId(message.clientMessageId);
  }

  await redis.expire(dedupKey, 86400); // 24 hour TTL
  return await createMessage(message);
};
```

### Circuit Breaker

```javascript
const CircuitBreaker = require('opossum');

// Wrap external calls
const dbCircuit = new CircuitBreaker(async (query, params) => {
  return await db.query(query, params);
}, {
  timeout: 5000,              // 5s timeout
  errorThresholdPercentage: 50,
  resetTimeout: 30000         // Try again after 30s
});

dbCircuit.on('open', () => {
  logger.error('Database circuit breaker OPEN - failing fast');
  metrics.circuit_breaker_state.set({ name: 'database' }, 1);
});

dbCircuit.on('close', () => {
  logger.info('Database circuit breaker CLOSED - normal operation');
  metrics.circuit_breaker_state.set({ name: 'database' }, 0);
});

// Fallback for reads
dbCircuit.fallback(async (query) => {
  if (query.includes('SELECT')) {
    // Try cache
    return await redis.get(cacheKeyFromQuery(query));
  }
  throw new Error('Database unavailable');
});
```

### Graceful Degradation

| Component Failure | Degraded Behavior |
|-------------------|-------------------|
| Redis down | Sessions from memory (single server), no cross-server routing, typing/presence disabled |
| PostgreSQL slow | Cache reads, queue writes, show stale data with warning |
| MinIO down | Text messages work, media upload/download fails gracefully |
| One API server down | Load balancer routes to healthy servers |

```javascript
// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    checks: {}
  };

  // Check PostgreSQL
  try {
    await db.query('SELECT 1');
    health.checks.database = 'healthy';
  } catch (e) {
    health.checks.database = 'unhealthy';
    health.status = 'degraded';
  }

  // Check Redis
  try {
    await redis.ping();
    health.checks.redis = 'healthy';
  } catch (e) {
    health.checks.redis = 'unhealthy';
    health.status = 'degraded';
  }

  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});
```

### Disaster Recovery (Local Dev)

| Data | Backup Strategy | Recovery |
|------|-----------------|----------|
| PostgreSQL | `pg_dump` on demand | `pg_restore` |
| Redis | AOF persistence | Restart loads from AOF |
| MinIO | Volume mount | Persists across restarts |

```bash
# Backup PostgreSQL
docker exec whatsapp-postgres pg_dump -U postgres whatsapp > backup.sql

# Restore PostgreSQL
docker exec -i whatsapp-postgres psql -U postgres whatsapp < backup.sql

# Redis AOF (configured in docker-compose.yml)
redis:
  command: redis-server --appendonly yes
  volumes:
    - redis-data:/data
```

---

## Cost Tradeoffs

### Local Development Costs

| Resource | Sizing | Monthly Cost |
|----------|--------|--------------|
| Developer machine | Already owned | $0 |
| Docker images | Local storage | $0 |
| PostgreSQL | 512 MB container | $0 |
| Redis | 128 MB container | $0 |
| MinIO | 256 MB container | $0 |

### Production Cost Considerations

| Decision | Lower Cost Option | Higher Performance Option |
|----------|-------------------|---------------------------|
| Database | PostgreSQL (single instance) | Cassandra cluster (write throughput) |
| Caching | Redis standalone | Redis Cluster (HA) |
| Media | MinIO self-hosted | S3 + CloudFront (managed) |
| Compute | Fewer larger servers | More smaller servers (HA) |
| Messages | Delete after 30 days | Retain forever (compliance) |

### Optimization Opportunities

1. **Message Compression**: Compress message content before storage (30-50% savings)
2. **Connection Multiplexing**: Multiple logical connections per WebSocket (reduce connection overhead)
3. **Batch Database Writes**: Buffer message inserts, flush every 100ms or 10 messages
4. **Media Deduplication**: Hash-based deduplication for identical files
5. **Cold Storage Tiering**: Move messages older than 90 days to cheaper storage

---

## Scalability Considerations

### Horizontal Scaling Path

```
Phase 1: Single Server (Current)
├── 1 API server (handles 100-500 connections)
├── 1 PostgreSQL
└── 1 Redis

Phase 2: Multi-Server (Local Dev Target)
├── Load Balancer (nginx)
├── 3-5 API servers (500-2500 connections)
├── 1 PostgreSQL
└── 1 Redis

Phase 3: Production-Ready
├── Load Balancer (HAProxy/ALB)
├── N API servers (auto-scaling)
├── PostgreSQL primary + replica
├── Redis Cluster (3 nodes)
└── RabbitMQ for async jobs

Phase 4: Global Scale
├── Regional deployments
├── Cassandra cluster (multi-DC)
├── Kafka for event streaming
├── CDN for media
└── DNS-based routing
```

### Sharding Strategy (Future)

| Data | Shard Key | Rationale |
|------|-----------|-----------|
| Messages | conversation_id | Co-locate conversation data |
| Users | user_id | Distribute evenly |
| Sessions | user_id % N | Consistent hashing |

---

## Trade-offs and Alternatives

### Current Design Decisions

| Decision | Trade-off | Alternative |
|----------|-----------|-------------|
| PostgreSQL for messages | Simpler ops, limited write scale | Cassandra (better writes, more complex) |
| Redis Pub/Sub | Simple, no persistence | Kafka (durable, ordered, more infra) |
| Session auth | Simple, stateful | JWT (stateless, harder to revoke) |
| WebSocket only | Lower latency, stateful | HTTP + long-polling (stateless, higher latency) |
| Synchronous message writes | Simple, consistent | Async with queue (higher throughput, eventual) |

### When to Reconsider

- **Switch to Cassandra**: When message table exceeds 100M rows or write throughput exceeds 1K/sec
- **Add Kafka**: When message durability is critical or need replay capability
- **Add CDN**: When serving media to geographically distributed users
- **Switch to JWT**: When deploying across multiple domains or need token-based mobile auth

---

## Future Optimizations

### Phase 3 (Scaling)

1. **Database Read Replicas**: Route read queries to replicas
2. **Connection Pooling**: PgBouncer for PostgreSQL connection management
3. **Message Batching**: Batch database inserts for throughput
4. **Presence Optimization**: Lazy presence loading, subscription-based updates

### Phase 4 (Production Features)

1. **End-to-End Encryption**: Signal Protocol implementation
2. **Push Notifications**: FCM/APNs integration for mobile
3. **Message Search**: Elasticsearch for full-text search
4. **Reactions and Replies**: Threaded conversations
5. **Voice/Video Calls**: WebRTC integration

### Performance Tuning Targets

| Metric | Current | Target |
|--------|---------|--------|
| Message delivery p95 | ~200ms | < 100ms |
| API response p99 | ~300ms | < 200ms |
| WebSocket connections per server | 500 | 10,000 |
| Messages per second | 100 | 1,000 |

---

## Implementation Notes

This section documents key implementation decisions and explains the rationale behind each pattern used in the codebase.

### Why Delivery Receipts Require Idempotent Status Updates

**Problem**: Message status transitions (sent -> delivered -> read) can be triggered multiple times due to:
- Network retries when acknowledgments are lost
- Cross-server routing via Redis pub/sub creating race conditions
- Client reconnections triggering re-delivery of pending messages
- Distributed systems lacking global ordering guarantees

**Solution**: Implement idempotent status updates using conditional database writes.

```sql
-- Only update if the new status is more progressed than current
UPDATE message_status
SET status = $new_status
WHERE message_id = $1 AND recipient_id = $2
  AND CASE status WHEN 'sent' THEN 0 WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 END
  < CASE $new_status WHEN 'sent' THEN 0 WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 END
```

**Benefits**:
- Status can only progress forward, never backwards
- Duplicate delivery confirmations are safely ignored
- Race conditions resolve deterministically
- No distributed locks required

**Implementation**: See `/backend/src/shared/deliveryTracker.ts` - `idempotentStatusUpdate()`

---

### Why Rate Limiting Prevents Spam

**Problem**: Without rate limiting, malicious or malfunctioning clients can:
- Flood the messaging pipeline with thousands of messages per second
- Exhaust server resources (memory, CPU, database connections)
- Degrade service quality for legitimate users
- Enable denial-of-service attacks

**Solution**: Implement sliding window rate limiting at multiple levels.

```
Rate Limits Applied:
├── REST API
│   ├── Login: 5 attempts / 15 minutes (per IP)
│   ├── Register: 3 accounts / hour (per IP)
│   └── Message send: 60 messages / minute (per user)
│
└── WebSocket
    ├── Messages: 30 / 10 seconds (burst), 60 / minute (sustained)
    └── Typing: 10 / minute (prevents indicator spam)
```

**Benefits**:
- Protects infrastructure from abuse
- Ensures fair resource allocation among users
- Reduces cost by rejecting excess traffic early
- Provides natural backpressure to misbehaving clients

**Implementation**: See `/backend/src/shared/rateLimiter.ts`

---

### Why Circuit Breakers Protect the Messaging Pipeline

**Problem**: When Redis or PostgreSQL becomes slow or unavailable:
- Threads/connections pile up waiting for timeouts
- Memory exhaustion from queued operations
- Cascading failures across dependent services
- Extended recovery time due to thundering herd on restoration

**Solution**: Implement the circuit breaker pattern for external dependencies.

```
Circuit States:
┌──────────┐     failures > threshold     ┌──────────┐
│  CLOSED  │ ───────────────────────────> │   OPEN   │
│ (normal) │                              │(fail-fast)│
└──────────┘                              └──────────┘
     ^                                          │
     │                                          │ timeout
     │                                          v
     │     success                        ┌──────────┐
     └─────────────────────────────────── │HALF-OPEN │
                                          │(testing) │
                                          └──────────┘
```

**Configuration** (tuned for messaging):
- **Timeout**: 3 seconds (messages should be fast)
- **Error threshold**: 50% (catch genuine failures, not transient blips)
- **Reset timeout**: 30 seconds (give services time to recover)

**Benefits**:
- Fails fast instead of hanging, improving UX
- Prevents resource exhaustion during outages
- Allows the failing service time to recover
- Enables graceful degradation (local-only mode when Redis fails)

**Implementation**: See `/backend/src/shared/circuitBreaker.ts`

---

### Why Metrics Enable Delivery Optimization

**Problem**: Without visibility into message delivery:
- Performance issues go undetected until users complain
- Cannot identify bottlenecks (database, Redis, network)
- No data to support capacity planning decisions
- Unable to verify SLO compliance

**Solution**: Comprehensive Prometheus metrics at every stage of delivery.

```
Key Metrics Collected:
├── Message Lifecycle
│   ├── whatsapp_messages_total{status=sent|delivered|read|failed}
│   └── whatsapp_message_delivery_duration_seconds{delivery_type=local|cross_server|pending}
│
├── Connection Health
│   ├── whatsapp_websocket_connections_total
│   └── whatsapp_websocket_events_total{event=connect|disconnect|error|timeout}
│
├── Protection Mechanisms
│   ├── whatsapp_rate_limit_hits_total{endpoint}
│   └── whatsapp_circuit_breaker_state{name} (0=closed, 0.5=half-open, 1=open)
│
└── Infrastructure
    ├── whatsapp_http_request_duration_seconds{method,route,status_code}
    └── whatsapp_db_query_duration_seconds{operation}
```

**SLO Monitoring Examples**:
```
# Alert when message delivery p95 exceeds 200ms
histogram_quantile(0.95, whatsapp_message_delivery_duration_seconds) > 0.2

# Alert when delivery rate drops below 99%
sum(rate(whatsapp_messages_total{status="delivered"}[5m]))
/ sum(rate(whatsapp_messages_total{status="sent"}[5m])) < 0.99
```

**Benefits**:
- Real-time visibility into delivery performance
- Proactive identification of bottlenecks
- Data-driven capacity planning
- Verifiable SLO compliance
- Foundation for A/B testing optimizations

**Implementation**: See `/backend/src/shared/metrics.ts` and `/metrics` endpoint

---

### Retry Logic with Exponential Backoff

**Problem**: Transient failures (network blips, momentary overloads) are common in distributed systems. Immediate retries can amplify load during issues.

**Solution**: Exponential backoff with jitter spreads retry load over time.

```
Retry Progression:
Attempt 1: 100ms + jitter (0-20ms)
Attempt 2: 200ms + jitter
Attempt 3: 400ms + jitter
Attempt 4: 800ms + jitter
Attempt 5: 1600ms + jitter (capped at maxDelay)
```

**Key Decisions**:
- **Jitter**: Randomized delay prevents thundering herd when many retries fire together
- **Non-retryable errors**: Unique constraint violations, auth failures, validation errors
- **Operation-specific configs**: DB operations use shorter delays than message delivery

**Implementation**: See `/backend/src/shared/retry.ts`

---

### Structured Logging with Pino

**Problem**: Console.log statements are:
- Difficult to parse and aggregate
- Lack consistent structure for monitoring tools
- Missing correlation IDs for distributed tracing
- Expensive to search in production

**Solution**: Structured JSON logging with consistent event types.

```json
{
  "level": "info",
  "time": 1704067200000,
  "service": "whatsapp-api",
  "server_id": "server-3001",
  "event": "message_sent",
  "message_id": "uuid",
  "conversation_id": "uuid",
  "sender_id": "uuid",
  "content_type": "text"
}
```

**Benefits**:
- Efficient log aggregation (ELK, Datadog, CloudWatch)
- Distributed tracing via correlation IDs
- Consistent format for alerting rules
- Low overhead (pino is the fastest Node.js logger)

**Implementation**: See `/backend/src/shared/logger.ts`

---

### Health Check Design

**Problem**: Simple "OK" health checks don't provide enough information for:
- Kubernetes readiness probes (should we route traffic here?)
- Load balancer decisions (is this instance healthy?)
- Debugging degraded performance

**Solution**: Tiered health checks with component status.

```
GET /health
{
  "status": "healthy|degraded|unhealthy",
  "server": "server-3001",
  "connections": 45,
  "checks": {
    "database": { "status": "healthy", "latency": 5 },
    "redis": { "status": "healthy", "latency": 2 },
    "circuits": { "status": "healthy" }
  },
  "circuits": {
    "redis": { "state": "closed" },
    "database": { "state": "closed" }
  }
}

GET /live   - Process is running (liveness probe)
GET /ready  - Can accept traffic (readiness probe)
```

**Status Logic**:
- **healthy**: All components operational
- **degraded**: Some components impaired but functional (e.g., Redis down but DB works)
- **unhealthy**: Critical components failing (e.g., database unavailable)

**Implementation**: See `/backend/src/index.ts` health endpoints


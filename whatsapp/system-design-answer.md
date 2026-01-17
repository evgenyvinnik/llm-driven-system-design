# WhatsApp System Design Interview Answer

## Opening Statement

"I'll be designing a real-time messaging platform like WhatsApp that supports one-on-one messaging, group chats, and media sharing. The key challenges are ensuring message delivery with minimal latency, handling offline users, and scaling to billions of messages per day. Let me start by clarifying requirements."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **One-on-One Messaging**
   - Send text messages between two users
   - Message delivery with read receipts
   - Show online/offline and typing indicators

2. **Group Chats**
   - Create groups with up to 256 members
   - Send messages visible to all group members
   - Manage group membership (add/remove)

3. **Media Sharing**
   - Send images, videos, documents
   - Efficient media upload and download
   - Thumbnail generation for previews

4. **Offline Message Delivery**
   - Queue messages when recipient is offline
   - Deliver all pending messages on reconnect
   - Maintain message ordering

5. **End-to-End Encryption**
   - Messages encrypted on sender device
   - Only recipient can decrypt
   - Server never sees plaintext

### Non-Functional Requirements

- **Latency**: Message delivery < 100ms when both users online
- **Availability**: 99.99% uptime
- **Scale**: 2 billion users, 100 billion messages/day
- **Ordering**: Messages within a chat maintain order
- **Durability**: No message loss (at-least-once delivery)

---

## 2. Scale Estimation (2-3 minutes)

**Users and Messages**
- 2 billion registered users
- 500 million DAU
- 100 billion messages/day = 1.16 million messages/second
- Peak: 3-5x average = 5 million messages/second

**Connections**
- 500 million concurrent WebSocket connections
- If each server handles 100K connections: 5,000 servers

**Storage**
- Average message: 100 bytes (encrypted text)
- 100B messages/day x 100 bytes = 10 TB/day for messages
- Media: assuming 10% messages have media, average 500KB = 5 PB/day
- Retention: 30 days for undelivered, forever for delivered (client stores)

**Bandwidth**
- 5M messages/sec x 100 bytes = 500 MB/sec for text
- Media adds significantly more

---

## 3. High-Level Architecture (8-10 minutes)

```
    ┌──────────────────┐                              ┌──────────────────┐
    │    Mobile App    │                              │    Mobile App    │
    │     (Sender)     │                              │   (Recipient)    │
    └────────┬─────────┘                              └────────┬─────────┘
             │                                                  │
             │ WebSocket                              WebSocket │
             │                                                  │
             ▼                                                  ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │                         Load Balancer                                │
    │                    (Layer 4 for WebSockets)                         │
    └───────────────────────────────┬─────────────────────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │                          │                          │
         ▼                          ▼                          ▼
    ┌──────────┐              ┌──────────┐              ┌──────────┐
    │  Chat    │              │  Chat    │              │  Chat    │
    │ Server 1 │              │ Server 2 │              │ Server N │
    │          │              │          │              │          │
    │ Handles  │◄────────────►│ Handles  │◄────────────►│ Handles  │
    │ 100K     │              │ 100K     │              │ 100K     │
    │ sockets  │              │ sockets  │              │ sockets  │
    └────┬─────┘              └────┬─────┘              └────┬─────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
           ┌───────────────┐             ┌───────────────┐
           │    Redis      │             │    Kafka      │
           │   Cluster     │             │   Cluster     │
           │               │             │               │
           │ - User→Server │             │ - Message     │
           │   mapping     │             │   persistence │
           │ - Presence    │             │ - Offline     │
           │ - Pub/Sub     │             │   queue       │
           └───────────────┘             └───────────────┘
                    │                             │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
           ┌───────────────┐             ┌───────────────┐
           │  Cassandra    │             │     S3        │
           │               │             │   (Media)     │
           │ - Messages    │             │               │
           │ - Chat history│             │ - Images      │
           │ - User data   │             │ - Videos      │
           └───────────────┘             └───────────────┘
```

### Core Components

**1. Chat Servers (WebSocket Handlers)**
- Maintain persistent WebSocket connections with clients
- Handle 100K-500K connections per server
- Route messages between users
- Stateless except for connection state

**2. Session Registry (Redis)**
- Maps user_id to chat_server_id
- Enables routing: "which server is user X connected to?"
- Also stores presence (online/offline/last seen)

**3. Message Queue (Kafka)**
- Persists all messages for durability
- Enables offline message delivery
- Decouples message ingestion from delivery

**4. Message Storage (Cassandra)**
- Stores message history per conversation
- Optimized for write-heavy workload
- Partitioned by conversation_id

**5. Media Storage (S3/CDN)**
- Stores images, videos, documents
- CDN for fast global delivery
- Separate upload/download paths

---

## 4. Deep Dive: Message Flow (7-8 minutes)

### Online-to-Online Message Delivery

```
Sender App                Chat Server A              Chat Server B           Recipient App
    │                          │                          │                       │
    │──1. Send Message────────►│                          │                       │
    │                          │                          │                       │
    │                          │──2. Lookup recipient────►│ Redis                 │
    │                          │     server               │                       │
    │                          │◄─────────────────────────│                       │
    │                          │                          │                       │
    │                          │──3. Forward to Server B─►│                       │
    │                          │     (or Redis Pub/Sub)   │                       │
    │                          │                          │                       │
    │                          │                          │──4. Push to socket───►│
    │                          │                          │                       │
    │                          │                          │◄─5. Delivery ACK──────│
    │                          │                          │                       │
    │◄─6. Delivery receipt─────│◄─────────────────────────│                       │
    │                          │                          │                       │
```

### Message Delivery States

```javascript
const MessageStatus = {
  SENT: 'sent',           // Server received from sender
  DELIVERED: 'delivered', // Recipient device received
  READ: 'read'            // Recipient opened chat
};
```

### Server-to-Server Communication

**Option 1: Direct TCP**
```javascript
// Chat servers maintain connections to each other
class ChatServer {
  async routeMessage(message) {
    const recipientServer = await redis.get(`session:${message.to}`);

    if (recipientServer === this.serverId) {
      // Local delivery
      this.pushToSocket(message.to, message);
    } else if (recipientServer) {
      // Forward to other server
      await this.serverConnections[recipientServer].send(message);
    } else {
      // User offline - queue message
      await this.queueForOffline(message);
    }
  }
}
```

**Option 2: Redis Pub/Sub**
```javascript
// Each server subscribes to its own channel
redis.subscribe(`server:${serverId}`);

// To send to another server:
redis.publish(`server:${recipientServer}`, JSON.stringify(message));
```

### Offline Message Handling

```javascript
async function queueForOffline(message) {
  // 1. Persist to Cassandra
  await cassandra.execute(
    'INSERT INTO messages (conversation_id, message_id, ...) VALUES (...)',
    [message.conversationId, message.id, ...]
  );

  // 2. Track pending count
  await redis.incr(`pending:${message.to}`);

  // 3. When user comes online, check pending count
  // and fetch from Cassandra
}

async function onUserConnect(userId) {
  const pendingCount = await redis.get(`pending:${userId}`);

  if (pendingCount > 0) {
    const messages = await cassandra.execute(
      'SELECT * FROM messages WHERE user_id = ? AND delivered = false',
      [userId]
    );

    for (const msg of messages) {
      await pushToSocket(userId, msg);
    }
  }
}
```

---

## 5. Deep Dive: Group Messaging (6-7 minutes)

### The Challenge

Group of 256 users: when one sends a message, 255 others need to receive it.

**Naive approach**: Send 255 individual messages
**Problem**: Expensive, duplicates storage

### Fan-out on Delivery

```javascript
async function handleGroupMessage(message, groupId) {
  // 1. Persist message once
  const messageId = await persistGroupMessage(message, groupId);

  // 2. Get group members
  const members = await redis.smembers(`group:${groupId}:members`);

  // 3. Fan out to online members
  const onlineMembers = [];
  const offlineMembers = [];

  for (const memberId of members) {
    if (memberId === message.from) continue; // Skip sender

    const server = await redis.get(`session:${memberId}`);
    if (server) {
      onlineMembers.push({ memberId, server });
    } else {
      offlineMembers.push(memberId);
    }
  }

  // 4. Deliver to online users
  const serverGroups = groupBy(onlineMembers, 'server');
  for (const [server, users] of Object.entries(serverGroups)) {
    // Batch delivery per server
    await sendToServer(server, {
      type: 'group_message',
      messageId,
      groupId,
      recipients: users.map(u => u.memberId)
    });
  }

  // 5. Track offline delivery needed
  for (const memberId of offlineMembers) {
    await redis.sadd(`pending_groups:${memberId}`, `${groupId}:${messageId}`);
  }
}
```

### Group Storage Schema

```sql
-- Cassandra
CREATE TABLE groups (
    group_id UUID,
    name TEXT,
    created_by UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (group_id)
);

CREATE TABLE group_members (
    group_id UUID,
    user_id UUID,
    joined_at TIMESTAMP,
    role TEXT, -- 'admin' or 'member'
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE group_messages (
    group_id UUID,
    message_id TIMEUUID,
    sender_id UUID,
    content BLOB,  -- encrypted
    PRIMARY KEY (group_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

---

## 6. Deep Dive: Presence and Typing Indicators (4-5 minutes)

### Online/Offline Status

```javascript
// On connect
async function onConnect(userId, serverId) {
  await redis.hset(`presence:${userId}`, {
    status: 'online',
    server: serverId,
    lastSeen: Date.now()
  });

  // Notify interested parties (recent chat partners)
  await broadcastPresence(userId, 'online');
}

// On disconnect
async function onDisconnect(userId) {
  await redis.hset(`presence:${userId}`, {
    status: 'offline',
    lastSeen: Date.now()
  });

  await broadcastPresence(userId, 'offline');
}

// Heartbeat to detect silent disconnects
setInterval(async () => {
  await redis.hset(`presence:${userId}`, 'lastSeen', Date.now());
}, 30000);
```

### Typing Indicators

```javascript
// Client sends typing event
async function handleTyping(userId, conversationId) {
  // Short-lived flag in Redis
  await redis.setex(`typing:${conversationId}:${userId}`, 3, '1');

  // Forward to other participant(s)
  const otherUser = getOtherParticipant(conversationId, userId);
  const server = await redis.get(`session:${otherUser}`);

  if (server) {
    await sendToServer(server, {
      type: 'typing',
      conversationId,
      userId
    });
  }
}
```

### Optimizing Presence Updates

**Problem**: User with 1000 contacts means 1000 presence notifications

**Solution**: Lazy presence
```javascript
// Only send presence to users who have chat open with you
async function getPresenceForContact(viewerId, contactId) {
  const presence = await redis.hgetall(`presence:${contactId}`);

  // Register interest for real-time updates
  await redis.sadd(`presence_watchers:${contactId}`, viewerId);
  await redis.expire(`presence_watchers:${contactId}`, 300); // 5 min

  return presence;
}
```

---

## 7. Deep Dive: End-to-End Encryption (4-5 minutes)

### Key Exchange (Signal Protocol Overview)

```
1. Each user generates:
   - Identity Key Pair (long-term)
   - Signed Pre-Key (medium-term, rotated periodically)
   - One-Time Pre-Keys (single use)

2. Keys uploaded to server (public parts only)

3. To start conversation:
   - Sender fetches recipient's public keys from server
   - Sender generates ephemeral key pair
   - Sender computes shared secret using X3DH
   - All messages encrypted with derived keys

4. Server never sees plaintext
```

### Message Encryption Flow

```javascript
// Simplified - actual implementation uses Signal Protocol
async function encryptMessage(recipientId, plaintext) {
  // Get or create session with recipient
  const session = await getSession(recipientId);

  if (!session) {
    // Fetch recipient's pre-keys from server
    const preKeys = await api.getPreKeys(recipientId);
    session = await createSession(preKeys);
  }

  // Encrypt message
  const ciphertext = session.encrypt(plaintext);

  return ciphertext;
}

// On server - just relay encrypted blob
async function relayMessage(message) {
  // Message content is opaque to server
  await deliverToRecipient(message.to, {
    from: message.from,
    encryptedContent: message.encryptedContent,
    timestamp: Date.now()
  });
}
```

### Server's Role

The server:
- Stores encrypted messages for offline delivery
- Facilitates key exchange (stores public keys)
- Routes messages between users
- CANNOT decrypt message content

---

## 8. Data Model (3-4 minutes)

### User Data (PostgreSQL)

```sql
CREATE TABLE users (
    user_id UUID PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE,
    display_name VARCHAR(100),
    profile_picture_url TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Messages (Cassandra)

```sql
-- Optimized for "get recent messages in conversation"
CREATE TABLE messages (
    conversation_id UUID,
    message_id TIMEUUID,
    sender_id UUID,
    content BLOB,           -- encrypted
    content_type VARCHAR(20), -- 'text', 'image', 'video'
    media_url TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- For delivery status tracking
CREATE TABLE message_status (
    message_id UUID,
    recipient_id UUID,
    status VARCHAR(20),     -- 'delivered', 'read'
    updated_at TIMESTAMP,
    PRIMARY KEY (message_id, recipient_id)
);
```

### Session Registry (Redis)

```
# User to server mapping
session:{user_id} -> server_id

# Presence
presence:{user_id} -> { status, lastSeen, server }

# Pending messages count
pending:{user_id} -> count

# Group members (for fast lookup)
group:{group_id}:members -> SET of user_ids
```

---

## 9. Trade-offs and Alternatives (4-5 minutes)

### Message Queue Technology

| Option | Pros | Cons |
|--------|------|------|
| Kafka | Durable, high throughput | Higher latency, complex |
| RabbitMQ | Lower latency, simpler | Lower throughput |
| Redis Streams | Fast, built-in | Less durable |

**Decision**: Kafka for persistence, Redis pub/sub for real-time routing

### Database Choice

| Option | Pros | Cons |
|--------|------|------|
| Cassandra | Write-heavy optimized, scalable | Eventually consistent |
| MongoDB | Flexible schema | Harder to scale writes |
| PostgreSQL | ACID, familiar | Harder to scale horizontally |

**Decision**: Cassandra for messages (write-heavy), PostgreSQL for user data (consistency needed)

### Connection Model

| Option | Pros | Cons |
|--------|------|------|
| WebSocket | Full duplex, efficient | Stateful, harder to scale |
| Long Polling | Simpler, stateless | Higher latency, more bandwidth |
| Server-Sent Events | Simpler than WS | One-way only |

**Decision**: WebSocket for mobile apps, with long-polling fallback

---

## 10. Handling Edge Cases (3-4 minutes)

### Message Ordering

```javascript
// Messages have server-assigned sequential IDs per conversation
const messageId = await redis.incr(`seq:${conversationId}`);

// Client reorders on receipt if needed
client.on('message', (msg) => {
  insertInOrder(conversation, msg);
});
```

### Exactly-Once Delivery

```javascript
// Client generates unique message ID
const clientMessageId = uuid();

// Server deduplicates
async function handleMessage(message) {
  const dedupKey = `dedup:${message.clientMessageId}`;
  const exists = await redis.setnx(dedupKey, '1');

  if (!exists) {
    return; // Already processed
  }

  await redis.expire(dedupKey, 86400); // 24 hour TTL
  await processMessage(message);
}
```

### Connection Dropped Mid-Send

- Client retries with same clientMessageId
- Server deduplicates
- Client waits for ACK before clearing from local queue

---

## 11. Monitoring (2 minutes)

Key metrics:
- **Message latency**: Time from send to delivery ACK
- **Connection count**: Per server and total
- **Queue depth**: Pending offline messages
- **Delivery success rate**: Messages delivered within SLA

Alerts:
- Message latency > 5 seconds
- Server connection count approaching limit
- Offline queue growing faster than drain rate

---

## Summary

The key insights for WhatsApp's design are:

1. **WebSocket for real-time**: Persistent connections enable instant message delivery

2. **Redis for session routing**: Quick lookup of "which server is this user connected to"

3. **Kafka for durability**: Messages persisted before acknowledging to sender

4. **Cassandra for message storage**: Write-optimized, partitioned by conversation

5. **End-to-end encryption**: Server is just a relay, never sees plaintext

6. **Group fan-out on delivery**: Store message once, fan out to online members

The system handles 100 billion messages/day through careful separation of real-time routing (Redis), durable storage (Cassandra), and horizontal scaling of stateless chat servers.

# WhatsApp - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thank you for having me. Today I'll design a real-time messaging platform like WhatsApp. This is a fascinating backend challenge because it requires:

1. **WebSocket connection management** for millions of concurrent connections
2. **Cross-server message routing** using Redis pub/sub for distributed delivery
3. **Offline message handling** with reliable delivery guarantees
4. **Group message fan-out** efficiently delivering to 256 members

The core backend challenge is achieving sub-100ms message delivery while guaranteeing at-least-once semantics. Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our messaging platform:

1. **One-on-One Messaging**: Send text messages with delivery receipts
2. **Group Chats**: Up to 256 members with efficient fan-out
3. **Presence & Typing**: Online status and typing indicators
4. **Offline Delivery**: Queue messages and deliver on reconnect
5. **Media Sharing**: Images, videos, and documents

I'll focus on real-time message routing, cross-server coordination, and offline delivery since those are the most challenging backend problems."

### Non-Functional Requirements

"Key constraints:

- **Latency**: < 100ms message delivery when both users online
- **Scale**: 500 million concurrent connections, 1 million messages/second
- **Durability**: At-least-once delivery, no message loss
- **Ordering**: Messages within a conversation maintain order

The durability requirement is critical - users expect every message to arrive."

---

## High-Level Design (8 minutes)

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client Devices                                  │
│                    Mobile Apps / Web Clients                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │ WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Load Balancer (L4)                               │
│                     (Sticky sessions for WebSocket)                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
      ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
      │  Chat Server  │     │  Chat Server  │     │  Chat Server  │
      │     :3001     │     │     :3002     │     │     :3003     │
      │               │     │               │     │               │
      │ ┌───────────┐ │     │ ┌───────────┐ │     │ ┌───────────┐ │
      │ │ Express   │ │     │ │ Express   │ │     │ │ Express   │ │
      │ │ WebSocket │ │     │ │ WebSocket │ │     │ │ WebSocket │ │
      │ └───────────┘ │     │ └───────────┘ │     │ └───────────┘ │
      └───────┬───────┘     └───────┬───────┘     └───────┬───────┘
              │                     │                     │
              └─────────────────────┼─────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │   Redis   │   │ PostgreSQL│   │   MinIO   │
            │           │   │           │   │           │
            │ - Session │   │ - Users   │   │ - Media   │
            │ - Presence│   │ - Messages│   │ - Files   │
            │ - Pub/Sub │   │ - Status  │   │           │
            └───────────┘   └───────────┘   └───────────┘
```

### Key Backend Components

**Chat Servers**: Stateless WebSocket handlers managing 100K+ connections each. Route messages based on Redis session mapping.

**Redis**: Session registry (user -> server mapping), presence state, pub/sub for cross-server routing, typing indicators with TTL.

**PostgreSQL/Cassandra**: Message persistence, conversation metadata, delivery status tracking.

---

## Deep Dive: WebSocket Connection Management (8 minutes)

### Connection Registration

```typescript
// backend/src/websocket/connectionManager.ts
interface Connection {
  userId: string;
  socket: WebSocket;
  serverId: string;
}

const localConnections = new Map<string, WebSocket>();

async function registerConnection(userId: string, ws: WebSocket): Promise<void> {
  const serverId = process.env.SERVER_ID!;

  // Store locally for direct delivery
  localConnections.set(userId, ws);

  // Register in Redis for cross-server discovery
  await redis.hset(`session:${userId}`, {
    serverId,
    connectedAt: Date.now().toString(),
    lastSeen: Date.now().toString()
  });

  // Subscribe to personal channel for cross-server messages
  await redis.sadd('connected_users', userId);

  // Update presence
  await updatePresence(userId, 'online');

  // Deliver pending messages
  await deliverPendingMessages(userId, ws);
}

async function unregisterConnection(userId: string): Promise<void> {
  localConnections.delete(userId);

  await redis.del(`session:${userId}`);
  await redis.srem('connected_users', userId);

  // Update presence with last seen
  await updatePresence(userId, 'offline');
}
```

### Cross-Server Message Routing

```typescript
// backend/src/websocket/messageRouter.ts
interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  content: string;
  contentType: 'text' | 'image' | 'video';
  clientMessageId: string;
  createdAt: Date;
}

async function routeMessage(message: Message): Promise<void> {
  const recipientId = message.recipientId;

  // Look up recipient's server
  const session = await redis.hgetall(`session:${recipientId}`);

  if (!session || !session.serverId) {
    // Recipient offline - message already persisted
    await incrementPendingCount(recipientId);
    return;
  }

  const recipientServerId = session.serverId;
  const myServerId = process.env.SERVER_ID!;

  if (recipientServerId === myServerId) {
    // Local delivery
    const ws = localConnections.get(recipientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'message', payload: message }));
    }
  } else {
    // Cross-server delivery via Redis pub/sub
    await redis.publish(`server:${recipientServerId}`, JSON.stringify({
      type: 'message',
      payload: message
    }));
  }
}

// Subscribe to server channel on startup
async function setupServerSubscription(): Promise<void> {
  const serverId = process.env.SERVER_ID!;
  const subscriber = redis.duplicate();

  await subscriber.subscribe(`server:${serverId}`);

  subscriber.on('message', (channel, data) => {
    const { type, payload } = JSON.parse(data);

    if (type === 'message') {
      deliverToLocalSocket(payload.recipientId, payload);
    } else if (type === 'typing') {
      broadcastTypingIndicator(payload);
    } else if (type === 'presence') {
      broadcastPresenceUpdate(payload);
    }
  });
}
```

---

## Deep Dive: Message Persistence and Delivery Status (8 minutes)

### Database Schema

```sql
-- Conversations (1:1 or group)
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
    name VARCHAR(100),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Participants with read position
CREATE TABLE conversation_participants (
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(10) DEFAULT 'member',
    last_read_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (conversation_id, user_id)
);

-- Messages with efficient indexing
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id),
    content TEXT,
    content_type VARCHAR(20) DEFAULT 'text',
    media_url TEXT,
    client_message_id UUID UNIQUE,  -- For deduplication
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);

-- Delivery status per recipient
CREATE TABLE message_status (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (message_id, recipient_id)
);

CREATE INDEX idx_status_recipient_pending ON message_status(recipient_id)
    WHERE status = 'sent';
```

### Idempotent Message Handling

```typescript
// Prevent duplicate message processing
async function processIncomingMessage(
  senderId: string,
  payload: MessagePayload
): Promise<Message> {
  const { clientMessageId, conversationId, content, contentType } = payload;

  // Check for duplicate using client-generated ID
  const dedupKey = `dedup:${clientMessageId}`;
  const isNew = await redis.setnx(dedupKey, '1');

  if (!isNew) {
    // Already processed - return existing message
    const existing = await pool.query(
      'SELECT * FROM messages WHERE client_message_id = $1',
      [clientMessageId]
    );
    return existing.rows[0];
  }

  // Set TTL on dedup key (24 hours)
  await redis.expire(dedupKey, 86400);

  // Persist message
  const result = await pool.query(`
    INSERT INTO messages (conversation_id, sender_id, content, content_type, client_message_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [conversationId, senderId, content, contentType, clientMessageId]);

  const message = result.rows[0];

  // Create status entries for all recipients
  const recipients = await getConversationParticipants(conversationId);

  for (const recipientId of recipients) {
    if (recipientId !== senderId) {
      await pool.query(`
        INSERT INTO message_status (message_id, recipient_id, status)
        VALUES ($1, $2, 'sent')
      `, [message.id, recipientId]);
    }
  }

  return message;
}
```

### Idempotent Status Updates

```typescript
// Status can only progress forward: sent -> delivered -> read
async function updateMessageStatus(
  messageId: string,
  recipientId: string,
  newStatus: 'delivered' | 'read'
): Promise<boolean> {
  // Use status ordering to prevent backward transitions
  const result = await pool.query(`
    UPDATE message_status
    SET status = $3, updated_at = NOW()
    WHERE message_id = $1 AND recipient_id = $2
      AND CASE status
        WHEN 'sent' THEN 0
        WHEN 'delivered' THEN 1
        WHEN 'read' THEN 2
      END < CASE $3
        WHEN 'sent' THEN 0
        WHEN 'delivered' THEN 1
        WHEN 'read' THEN 2
      END
    RETURNING *
  `, [messageId, recipientId, newStatus]);

  if (result.rowCount > 0) {
    // Notify sender of status change
    await notifySenderOfStatusChange(messageId, recipientId, newStatus);
    return true;
  }

  return false; // Already at this status or higher
}
```

---

## Deep Dive: Offline Message Delivery (6 minutes)

### Pending Message Queue

```typescript
// Deliver pending messages on reconnect
async function deliverPendingMessages(userId: string, ws: WebSocket): Promise<void> {
  // Get all undelivered messages for this user
  const result = await pool.query(`
    SELECT m.*, ms.status
    FROM messages m
    JOIN message_status ms ON m.id = ms.message_id
    WHERE ms.recipient_id = $1 AND ms.status = 'sent'
    ORDER BY m.created_at ASC
  `, [userId]);

  const pendingMessages = result.rows;

  if (pendingMessages.length === 0) return;

  // Send messages in batches to avoid overwhelming the client
  const batchSize = 50;
  for (let i = 0; i < pendingMessages.length; i += batchSize) {
    const batch = pendingMessages.slice(i, i + batchSize);

    ws.send(JSON.stringify({
      type: 'pending_messages',
      payload: { messages: batch }
    }));

    // Wait for batch acknowledgment before sending next
    await waitForBatchAck(ws, batch[batch.length - 1].id);
  }
}

// Client sends ACK for each message
async function handleMessageAck(userId: string, messageId: string): Promise<void> {
  await updateMessageStatus(messageId, userId, 'delivered');
}

// Batch ACK for efficiency
async function handleBatchAck(userId: string, messageIds: string[]): Promise<void> {
  await pool.query(`
    UPDATE message_status
    SET status = 'delivered', updated_at = NOW()
    WHERE message_id = ANY($1) AND recipient_id = $2 AND status = 'sent'
  `, [messageIds, userId]);

  // Notify senders
  for (const messageId of messageIds) {
    await notifySenderOfStatusChange(messageId, userId, 'delivered');
  }
}
```

---

## Deep Dive: Group Message Fan-Out (6 minutes)

### Efficient Group Delivery

```typescript
interface GroupMessage extends Message {
  groupId: string;
  memberCount: number;
}

async function handleGroupMessage(
  senderId: string,
  groupId: string,
  content: string
): Promise<void> {
  // 1. Persist message once
  const message = await persistMessage(groupId, senderId, content);

  // 2. Get group members
  const members = await getGroupMembers(groupId);

  // 3. Partition members by connection status
  const onlineMembers: Array<{ userId: string; serverId: string }> = [];
  const offlineMembers: string[] = [];

  for (const memberId of members) {
    if (memberId === senderId) continue; // Skip sender

    const session = await redis.hgetall(`session:${memberId}`);
    if (session && session.serverId) {
      onlineMembers.push({ userId: memberId, serverId: session.serverId });
    } else {
      offlineMembers.push(memberId);
    }
  }

  // 4. Create status entries for all recipients
  await createStatusEntries(message.id, members.filter(m => m !== senderId));

  // 5. Group online members by server for batched delivery
  const serverGroups = groupBy(onlineMembers, 'serverId');

  for (const [serverId, users] of Object.entries(serverGroups)) {
    if (serverId === process.env.SERVER_ID) {
      // Local delivery
      for (const { userId } of users) {
        deliverToLocalSocket(userId, message);
      }
    } else {
      // Cross-server batch delivery
      await redis.publish(`server:${serverId}`, JSON.stringify({
        type: 'group_message',
        payload: {
          message,
          recipients: users.map(u => u.userId)
        }
      }));
    }
  }

  // 6. Offline members get message on reconnect (already in DB)
}

// Optimized member lookup with caching
async function getGroupMembers(groupId: string): Promise<string[]> {
  const cacheKey = `group:${groupId}:members`;

  // Check Redis cache
  const cached = await redis.smembers(cacheKey);
  if (cached.length > 0) {
    return cached;
  }

  // Query database
  const result = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [groupId]
  );

  const members = result.rows.map(r => r.user_id);

  // Cache for 5 minutes
  await redis.sadd(cacheKey, ...members);
  await redis.expire(cacheKey, 300);

  return members;
}
```

---

## Deep Dive: Presence and Typing Indicators (4 minutes)

### Presence Management

```typescript
async function updatePresence(userId: string, status: 'online' | 'offline'): Promise<void> {
  await redis.hset(`presence:${userId}`, {
    status,
    lastSeen: Date.now().toString()
  });

  // Notify interested parties (users who have this user in recent chats)
  await broadcastPresenceToWatchers(userId, status);
}

// Lazy presence subscription - only track when viewing chat
async function subscribeToPresence(watcherId: string, targetUserId: string): Promise<void> {
  const key = `presence_watchers:${targetUserId}`;

  await redis.sadd(key, watcherId);
  await redis.expire(key, 300); // 5 minute interest window

  // Send current presence
  const presence = await redis.hgetall(`presence:${targetUserId}`);
  return presence;
}

// Heartbeat to detect silent disconnects
async function handleHeartbeat(userId: string): Promise<void> {
  await redis.hset(`presence:${userId}`, 'lastSeen', Date.now().toString());
}
```

### Typing Indicators

```typescript
async function handleTypingStart(userId: string, conversationId: string): Promise<void> {
  // Set typing flag with 3-second TTL
  const key = `typing:${conversationId}:${userId}`;
  await redis.setex(key, 3, '1');

  // Broadcast to other participants
  const participants = await getConversationParticipants(conversationId);

  for (const participantId of participants) {
    if (participantId === userId) continue;

    const session = await redis.hgetall(`session:${participantId}`);
    if (session && session.serverId) {
      await redis.publish(`server:${session.serverId}`, JSON.stringify({
        type: 'typing',
        payload: { conversationId, userId, isTyping: true }
      }));
    }
  }
}
```

---

## Rate Limiting and Protection (3 minutes)

```typescript
// Sliding window rate limiter
async function checkRateLimit(userId: string, action: string): Promise<boolean> {
  const limits: Record<string, { window: number; max: number }> = {
    'message': { window: 60, max: 60 },      // 60 msgs/minute
    'typing': { window: 10, max: 10 },       // 10 typing events/10s
    'connect': { window: 60, max: 5 }        // 5 connects/minute
  };

  const { window, max } = limits[action] || { window: 60, max: 100 };
  const key = `ratelimit:${userId}:${action}`;
  const now = Date.now();

  // Use Redis sorted set for sliding window
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, now - window * 1000);
  pipeline.zadd(key, now.toString(), now.toString());
  pipeline.zcard(key);
  pipeline.expire(key, window);

  const results = await pipeline.exec();
  const count = results?.[2]?.[1] as number;

  return count <= max;
}

// Circuit breaker for external dependencies
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private threshold = 5;
  private resetTimeout = 30000;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      throw new Error('Circuit breaker is open');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      setTimeout(() => {
        this.state = 'half-open';
      }, this.resetTimeout);
    }
  }
}
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Message Storage | PostgreSQL | Cassandra | Simpler ops; Cassandra at billion-message scale |
| Cross-Server Routing | Redis Pub/Sub | Kafka | Lower latency; Kafka for durability needs |
| Session Storage | Redis hashes | Redis cluster | Simple; cluster for HA at scale |
| Connection Model | WebSocket | Long polling | Full duplex, lower latency |
| Delivery Guarantee | At-least-once | Exactly-once | Simpler; client deduplicates |

---

## Future Enhancements

With more time, I would add:

1. **Cassandra for messages** at production scale for write throughput
2. **Kafka** for durable message queue and replay capability
3. **End-to-end encryption** with Signal Protocol
4. **Read replicas** for PostgreSQL scaling
5. **Connection multiplexing** for efficiency

---

## Summary

"I've designed a real-time messaging backend with:

1. **WebSocket connection management** with Redis session registry
2. **Cross-server message routing** via Redis pub/sub
3. **Idempotent message handling** with client-generated IDs
4. **Efficient group fan-out** batched by server
5. **Offline delivery** with pending message queue
6. **Rate limiting and circuit breakers** for protection

The architecture achieves sub-100ms delivery for online users while guaranteeing at-least-once semantics for all messages."

# WhatsApp - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement

"I'll design a real-time messaging platform like WhatsApp, covering both the frontend and backend with emphasis on how they integrate. The key full-stack challenges are establishing a robust WebSocket communication protocol, implementing end-to-end message delivery with status tracking across the stack, handling offline scenarios with both client-side caching and server-side queuing, and ensuring type safety across the API boundary. Let me start by clarifying requirements."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Real-Time Messaging**
   - Send/receive messages with < 100ms latency when both users online
   - Cross-server message routing when users connect to different servers
   - Delivery receipts (sent, delivered, read) synchronized across clients

2. **Offline Support**
   - Server queues messages for offline recipients
   - Client caches conversations and messages in IndexedDB
   - Client queues outgoing messages when disconnected
   - Full synchronization on reconnect

3. **Presence System**
   - Real-time online/offline status
   - Typing indicators with debouncing
   - Last seen timestamps

4. **Group Messaging**
   - Fan-out message delivery to multiple recipients
   - Group membership management
   - Efficient batch notifications

### Non-Functional Requirements

| Requirement | Target | Stack Responsibility |
|-------------|--------|----------------------|
| **Message Latency** | < 100ms (online-to-online) | Backend: Redis routing, Frontend: WebSocket |
| **Offline Capability** | Full read, queued writes | Backend: PostgreSQL queue, Frontend: IndexedDB |
| **Consistency** | At-least-once delivery | Backend: ACKs + DB, Frontend: Deduplication |
| **Scale** | 500 concurrent connections/server | Backend: Multiple instances, Frontend: Virtualization |

---

## 2. Full-Stack Architecture Overview (5-6 minutes)

### System Integration Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Frontend (React)                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ WebSocket   │  │   Zustand   │  │  IndexedDB  │  │   Service   │          │
│  │  Provider   │◄─┤    Store    │◄─┤   (Dexie)   │  │   Worker    │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         │                │                │                │                  │
└─────────┼────────────────┼────────────────┼────────────────┼──────────────────┘
          │ WebSocket      │ HTTP/REST      │                │
          │                │                │                │
          ▼                ▼                │                │
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Load Balancer (nginx)                               │
│                        Sticky Sessions for WebSocket                          │
└────────────────────────────────┬──────────────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   API Server 1  │    │   API Server 2  │    │   API Server 3  │
│   (Express+WS)  │◄───┤  Redis Pub/Sub  ├───►│   (Express+WS)  │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
     ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
     │   PostgreSQL    │ │   Redis/Valkey  │ │     MinIO       │
     │                 │ │                 │ │                 │
     │ - Users         │ │ - Sessions      │ │ - Images        │
     │ - Conversations │ │ - Presence      │ │ - Videos        │
     │ - Messages      │ │ - User→Server   │ │ - Documents     │
     │ - Status        │ │ - Pub/Sub       │ │                 │
     └─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Shared TypeScript Types (API Contract)

```typescript
// shared/types.ts - Used by both frontend and backend

// Message types
interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  contentType: 'text' | 'image' | 'video' | 'file';
  mediaUrl?: string;
  replyToId?: string;
  createdAt: string;
  // Client-side only
  clientMessageId?: string;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
}

interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  participants: Participant[];
  lastMessage?: Message;
  unreadCount: number;
  updatedAt: string;
}

interface Participant {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  role: 'admin' | 'member';
}

// WebSocket message types
type WSClientMessage =
  | { type: 'message'; payload: SendMessagePayload }
  | { type: 'typing'; payload: { conversationId: string } }
  | { type: 'ack'; payload: { messageId: string } }
  | { type: 'read'; payload: { conversationId: string; upToMessageId: string } };

type WSServerMessage =
  | { type: 'message'; payload: Message }
  | { type: 'message_status'; payload: MessageStatusUpdate }
  | { type: 'typing'; payload: TypingIndicator }
  | { type: 'presence'; payload: PresenceUpdate }
  | { type: 'error'; payload: WSError };

interface SendMessagePayload {
  conversationId: string;
  content: string;
  contentType: 'text' | 'image' | 'video' | 'file';
  clientMessageId: string;
  mediaUrl?: string;
  replyToId?: string;
}

interface MessageStatusUpdate {
  messageId: string;
  status: 'sent' | 'delivered' | 'read';
  userId: string;
}

interface TypingIndicator {
  conversationId: string;
  userId: string;
  username: string;
  isTyping: boolean;
}

interface PresenceUpdate {
  userId: string;
  status: 'online' | 'offline';
  lastSeen: string;
}
```

---

## 3. Deep Dive: Message Flow (8-10 minutes)

### End-to-End Message Delivery (Online-to-Online)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Complete Message Flow                                  │
└──────────────────────────────────────────────────────────────────────────────┘

     Frontend (Sender)              Backend                 Frontend (Recipient)
           │                          │                            │
     ┌─────┴─────┐                    │                            │
     │ 1. User   │                    │                            │
     │    types  │                    │                            │
     │    message│                    │                            │
     └─────┬─────┘                    │                            │
           │                          │                            │
     ┌─────┴─────┐                    │                            │
     │ 2. Create │                    │                            │
     │ clientId  │                    │                            │
     │ optimistic│                    │                            │
     │ add to UI │                    │                            │
     └─────┬─────┘                    │                            │
           │                          │                            │
           │─────WS: message─────────►│                            │
           │                          │                            │
           │                    ┌─────┴─────┐                      │
           │                    │ 3. Persist│                      │
           │                    │ to DB with│                      │
           │                    │ status=   │                      │
           │                    │ 'sent'    │                      │
           │                    └─────┬─────┘                      │
           │                          │                            │
           │                    ┌─────┴─────┐                      │
           │                    │ 4. Lookup │                      │
           │                    │ recipient │                      │
           │                    │ server in │                      │
           │                    │ Redis     │                      │
           │                    └─────┬─────┘                      │
           │                          │                            │
           │                          │ (Redis Pub/Sub if          │
           │                          │  different server)         │
           │                          │                            │
           │                          │─────WS: message───────────►│
           │                          │                            │
           │                          │                      ┌─────┴─────┐
           │                          │                      │ 5. Display│
           │                          │                      │ message,  │
           │                          │                      │ dedupe by │
           │                          │                      │ messageId │
           │                          │                      └─────┬─────┘
           │                          │                            │
           │                          │◄────WS: ack────────────────│
           │                          │                            │
           │                    ┌─────┴─────┐                      │
           │                    │ 6. Update │                      │
           │                    │ status=   │                      │
           │                    │ 'delivered│                      │
           │                    └─────┬─────┘                      │
           │                          │                            │
           │◄───WS: message_status────│                            │
           │     (delivered)          │                            │
     ┌─────┴─────┐                    │                            │
     │ 7. Update │                    │                            │
     │ UI: ✓✓    │                    │                            │
     └───────────┘                    │                            │
```

### Frontend: Sending a Message

```typescript
// frontend/src/hooks/useSendMessage.ts
export function useSendMessage(conversationId: string) {
  const socket = useWebSocket();
  const addMessage = useChatStore(s => s.addMessage);
  const updateStatus = useChatStore(s => s.updateMessageStatus);

  const sendMessage = useCallback(async (content: string) => {
    const clientMessageId = crypto.randomUUID();

    // 1. Optimistic UI update
    const optimisticMessage: Message = {
      id: clientMessageId, // Temporary ID
      conversationId,
      senderId: currentUser.id,
      content,
      contentType: 'text',
      createdAt: new Date().toISOString(),
      clientMessageId,
      status: 'sending',
    };
    addMessage(optimisticMessage);

    // 2. Check connection status
    if (!socket.isConnected) {
      // Queue for offline sync
      await offlineDb.queueMessage({
        clientMessageId,
        conversationId,
        content,
        status: 'pending',
        createdAt: Date.now(),
        retryCount: 0,
      });
      return;
    }

    // 3. Send via WebSocket
    socket.send({
      type: 'message',
      payload: {
        conversationId,
        content,
        contentType: 'text',
        clientMessageId,
      }
    });
  }, [conversationId, socket, addMessage]);

  return { sendMessage };
}
```

### Backend: Processing the Message

```typescript
// backend/src/websocket/handlers.ts
import { pool } from '../shared/db.js';
import { redis, pubsub } from '../shared/cache.js';

const SERVER_ID = process.env.SERVER_ID || 'server-3001';

export async function handleMessage(
  ws: WebSocket,
  userId: string,
  payload: SendMessagePayload
): Promise<void> {
  const { conversationId, content, contentType, clientMessageId, replyToId } = payload;

  // 1. Validate user is participant
  const participant = await pool.query(
    `SELECT 1 FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );

  if (participant.rowCount === 0) {
    ws.send(JSON.stringify({
      type: 'error',
      payload: { code: 'FORBIDDEN', message: 'Not a participant' }
    }));
    return;
  }

  // 2. Check idempotency (prevent duplicate sends)
  const dedupKey = `dedup:${clientMessageId}`;
  const isNew = await redis.setnx(dedupKey, '1');
  if (!isNew) {
    // Already processed - send existing message
    const existing = await getMessageByClientId(clientMessageId);
    if (existing) {
      ws.send(JSON.stringify({ type: 'message', payload: existing }));
    }
    return;
  }
  await redis.expire(dedupKey, 86400); // 24 hour TTL

  // 3. Persist to database
  const result = await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, content, content_type, reply_to_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [conversationId, userId, content, contentType, replyToId]
  );
  const message = result.rows[0];

  // 4. Get recipients
  const participants = await pool.query(
    `SELECT user_id FROM conversation_participants
     WHERE conversation_id = $1 AND user_id != $2`,
    [conversationId, userId]
  );

  // 5. Create delivery status records
  for (const p of participants.rows) {
    await pool.query(
      `INSERT INTO message_status (message_id, recipient_id, status)
       VALUES ($1, $2, 'sent')`,
      [message.id, p.user_id]
    );
  }

  // 6. Route to recipients
  for (const p of participants.rows) {
    await routeToRecipient(p.user_id, {
      type: 'message',
      payload: { ...message, clientMessageId }
    });
  }

  // 7. Send confirmation to sender
  ws.send(JSON.stringify({
    type: 'message',
    payload: { ...message, clientMessageId, status: 'sent' }
  }));
}

async function routeToRecipient(
  recipientId: string,
  message: WSServerMessage
): Promise<void> {
  // Lookup which server the recipient is connected to
  const recipientServerId = await redis.get(`session:${recipientId}`);

  if (!recipientServerId) {
    // User offline - message stays in DB with 'sent' status
    return;
  }

  if (recipientServerId === SERVER_ID) {
    // Local delivery
    const recipientWs = connections.get(recipientId);
    if (recipientWs) {
      recipientWs.send(JSON.stringify(message));
    }
  } else {
    // Cross-server routing via Redis Pub/Sub
    await pubsub.publish(`server:${recipientServerId}`, JSON.stringify({
      targetUserId: recipientId,
      message
    }));
  }
}
```

### Frontend: Receiving and Acknowledging

```typescript
// frontend/src/providers/WebSocketProvider.tsx
function handleIncomingMessage(msg: WSServerMessage) {
  switch (msg.type) {
    case 'message':
      // Add to store (handles deduplication)
      chatStore.addMessage(msg.payload);

      // Send delivery acknowledgment
      socketRef.current?.send(JSON.stringify({
        type: 'ack',
        payload: { messageId: msg.payload.id }
      }));

      // Cache for offline
      offlineSync.cacheMessage(msg.payload);
      break;

    case 'message_status':
      // Update delivery status (single tick -> double tick -> blue tick)
      chatStore.updateMessageStatus(
        msg.payload.messageId,
        msg.payload.status
      );
      break;

    // ... other handlers
  }
}
```

### Backend: Processing Delivery ACK

```typescript
// backend/src/websocket/handlers.ts
export async function handleAck(
  ws: WebSocket,
  userId: string,
  payload: { messageId: string }
): Promise<void> {
  const { messageId } = payload;

  // Idempotent status update - only progress forward
  const result = await pool.query(
    `UPDATE message_status
     SET status = 'delivered', updated_at = NOW()
     WHERE message_id = $1 AND recipient_id = $2
       AND status = 'sent'
     RETURNING *`,
    [messageId, userId]
  );

  if (result.rowCount === 0) return; // Already delivered or read

  // Notify sender
  const message = await pool.query(
    `SELECT sender_id FROM messages WHERE id = $1`,
    [messageId]
  );

  await routeToRecipient(message.rows[0].sender_id, {
    type: 'message_status',
    payload: {
      messageId,
      status: 'delivered',
      userId
    }
  });
}
```

---

## 4. Deep Dive: Offline Sync (6-7 minutes)

### Offline Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Offline Sync Architecture                            │
└─────────────────────────────────────────────────────────────────────────────┘

    User Goes Offline                              User Comes Online
          │                                              │
          ▼                                              ▼
    ┌───────────┐                                  ┌───────────┐
    │ WebSocket │                                  │ WebSocket │
    │  Closes   │                                  │ Reconnects│
    └─────┬─────┘                                  └─────┬─────┘
          │                                              │
          ▼                                              ▼
    ┌───────────┐                                  ┌───────────┐
    │ Queue new │                                  │ Sync from │
    │ messages  │                                  │ IndexedDB │
    │ to        │                                  │ pending   │
    │ IndexedDB │                                  │ queue     │
    └─────┬─────┘                                  └─────┬─────┘
          │                                              │
          ▼                                              │
    ┌───────────┐                                        │
    │ Show from │                                        │
    │ cached    │                                        │
    │ messages  │                                        │
    └───────────┘                                        │
                                                         ▼
                                               ┌───────────────────┐
                                               │ Backend: Fetch    │
                                               │ messages since    │
                                               │ last sync         │
                                               └─────────┬─────────┘
                                                         │
                                                         ▼
                                               ┌───────────────────┐
                                               │ Merge server      │
                                               │ messages with     │
                                               │ local cache       │
                                               └───────────────────┘
```

### Frontend: Offline Queue and Sync

```typescript
// frontend/src/services/offlineSync.ts
import { db } from '../db/database';

class OfflineSyncService {
  private syncInProgress = false;

  // Queue message when offline
  async queueMessage(message: PendingMessage): Promise<void> {
    await db.pendingMessages.add(message);
  }

  // Sync pending messages when back online
  async syncPendingMessages(socket: WebSocket): Promise<void> {
    if (this.syncInProgress) return;
    this.syncInProgress = true;

    try {
      const pending = await db.pendingMessages
        .where('status')
        .equals('pending')
        .toArray();

      for (const msg of pending) {
        await this.sendPendingMessage(socket, msg);
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  private async sendPendingMessage(
    socket: WebSocket,
    msg: PendingMessage
  ): Promise<void> {
    try {
      // Mark as sending
      await db.pendingMessages.update(msg.clientMessageId, {
        status: 'sending'
      });

      // Send via WebSocket
      socket.send(JSON.stringify({
        type: 'message',
        payload: {
          conversationId: msg.conversationId,
          content: msg.content,
          contentType: 'text',
          clientMessageId: msg.clientMessageId,
        }
      }));

      // Remove from queue on success
      await db.pendingMessages.delete(msg.clientMessageId);

    } catch (error) {
      // Retry logic
      const newRetryCount = msg.retryCount + 1;
      if (newRetryCount >= 3) {
        await db.pendingMessages.update(msg.clientMessageId, {
          status: 'failed',
          retryCount: newRetryCount,
        });
      } else {
        await db.pendingMessages.update(msg.clientMessageId, {
          status: 'pending',
          retryCount: newRetryCount,
        });
      }
    }
  }

  // Fetch messages missed while offline
  async fetchMissedMessages(conversationId: string): Promise<Message[]> {
    const lastSync = await db.syncMetadata.get(conversationId);
    const lastSyncTime = lastSync?.lastSyncAt || 0;

    const response = await fetch(
      `/api/v1/conversations/${conversationId}/messages?since=${lastSyncTime}`
    );
    const { messages } = await response.json();

    // Cache new messages
    await this.cacheMessages(messages);

    // Update sync timestamp
    await db.syncMetadata.put({
      conversationId,
      lastSyncAt: Date.now(),
    });

    return messages;
  }

  async cacheMessages(messages: Message[]): Promise<void> {
    const cached = messages.map(msg => ({
      ...msg,
      cachedAt: Date.now(),
    }));
    await db.messages.bulkPut(cached);
  }

  async getCachedMessages(conversationId: string): Promise<Message[]> {
    return db.messages
      .where('conversationId')
      .equals(conversationId)
      .reverse()
      .sortBy('createdAt');
  }
}

export const offlineSync = new OfflineSyncService();
```

### Backend: Pending Message Delivery on Connect

```typescript
// backend/src/websocket/connection.ts
export async function handleUserConnect(
  ws: WebSocket,
  userId: string
): Promise<void> {
  // 1. Register session
  await redis.set(`session:${userId}`, SERVER_ID);

  // 2. Update presence
  await redis.hset(`presence:${userId}`, {
    status: 'online',
    server: SERVER_ID,
    lastSeen: Date.now().toString()
  });

  // 3. Subscribe to cross-server messages
  connections.set(userId, ws);

  // 4. Deliver pending messages
  const pendingMessages = await pool.query(
    `SELECT m.* FROM messages m
     JOIN message_status ms ON m.id = ms.message_id
     WHERE ms.recipient_id = $1 AND ms.status = 'sent'
     ORDER BY m.created_at ASC`,
    [userId]
  );

  for (const message of pendingMessages.rows) {
    ws.send(JSON.stringify({
      type: 'message',
      payload: message
    }));
  }

  // 5. Broadcast presence to interested users
  await broadcastPresence(userId, 'online');
}

export async function handleUserDisconnect(userId: string): Promise<void> {
  // 1. Remove session
  await redis.del(`session:${userId}`);

  // 2. Update presence
  await redis.hset(`presence:${userId}`, {
    status: 'offline',
    lastSeen: Date.now().toString()
  });

  // 3. Cleanup connection
  connections.delete(userId);

  // 4. Broadcast presence change
  await broadcastPresence(userId, 'offline');
}
```

### Backend: Messages Since Timestamp API

```typescript
// backend/src/routes/messages.ts
router.get('/conversations/:id/messages', async (req, res) => {
  const { id: conversationId } = req.params;
  const { limit = 50, before, since } = req.query;
  const userId = req.session.userId;

  // Verify participant
  const participant = await pool.query(
    `SELECT 1 FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );

  if (participant.rowCount === 0) {
    return res.status(403).json({ error: 'Not a participant' });
  }

  let query: string;
  let params: any[];

  if (since) {
    // Fetch messages since timestamp (for offline sync)
    query = `
      SELECT m.*, ms.status as delivery_status
      FROM messages m
      LEFT JOIN message_status ms
        ON m.id = ms.message_id AND ms.recipient_id = $3
      WHERE m.conversation_id = $1
        AND m.created_at > to_timestamp($2::bigint / 1000.0)
      ORDER BY m.created_at ASC
      LIMIT $4
    `;
    params = [conversationId, since, userId, limit];
  } else if (before) {
    // Pagination for infinite scroll
    query = `
      SELECT m.*, ms.status as delivery_status
      FROM messages m
      LEFT JOIN message_status ms
        ON m.id = ms.message_id AND ms.recipient_id = $3
      WHERE m.conversation_id = $1
        AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
      ORDER BY m.created_at DESC
      LIMIT $4
    `;
    params = [conversationId, before, userId, limit];
  } else {
    // Latest messages
    query = `
      SELECT m.*, ms.status as delivery_status
      FROM messages m
      LEFT JOIN message_status ms
        ON m.id = ms.message_id AND ms.recipient_id = $3
      WHERE m.conversation_id = $1
      ORDER BY m.created_at DESC
      LIMIT $4
    `;
    params = [conversationId, null, userId, limit];
  }

  const result = await pool.query(query, params);

  res.json({
    messages: result.rows,
    hasMore: result.rows.length === parseInt(limit as string)
  });
});
```

---

## 5. Deep Dive: Typing Indicators (4-5 minutes)

### End-to-End Typing Flow

```
Frontend (Typer)              Backend                 Frontend (Viewer)
      │                          │                          │
      │──user types──            │                          │
      │              │           │                          │
      │──debounce 2s─┤           │                          │
      │              │           │                          │
      │◄─────────────┘           │                          │
      │                          │                          │
      │───WS: typing────────────►│                          │
      │                          │                          │
      │                    ┌─────┴─────┐                    │
      │                    │ SETEX     │                    │
      │                    │ typing:   │                    │
      │                    │ conv:user │                    │
      │                    │ TTL=3s    │                    │
      │                    └─────┬─────┘                    │
      │                          │                          │
      │                          │───WS: typing────────────►│
      │                          │                          │
      │                          │                    ┌─────┴─────┐
      │                          │                    │ Show      │
      │                          │                    │ "typing"  │
      │                          │                    │ indicator │
      │                          │                    └─────┬─────┘
      │                          │                          │
      │──stops typing──          │                          │
      │                          │                          │
      │                    ┌─────┴─────┐                    │
      │                    │ TTL       │                    │
      │                    │ expires   │                    │
      │                    │ (3s)      │                    │
      │                    └─────┬─────┘                    │
      │                          │                          │
      │                          │───WS: typing=false──────►│
      │                          │                          │
      │                          │                    ┌─────┴─────┐
      │                          │                    │ Hide      │
      │                          │                    │ indicator │
      │                          │                    └───────────┘
```

### Frontend: Debounced Typing Events

```typescript
// frontend/src/hooks/useTypingIndicator.ts
export function useTypingIndicator(conversationId: string) {
  const socket = useWebSocket();
  const lastTypingSent = useRef(0);
  const TYPING_INTERVAL = 2000; // Send at most every 2 seconds

  const handleInputChange = useCallback(() => {
    const now = Date.now();

    // Debounce: don't spam typing events
    if (now - lastTypingSent.current >= TYPING_INTERVAL) {
      socket.send({
        type: 'typing',
        payload: { conversationId }
      });
      lastTypingSent.current = now;
    }
  }, [conversationId, socket]);

  return { handleInputChange };
}

// Usage in MessageInput
function MessageInput({ conversationId }: { conversationId: string }) {
  const [content, setContent] = useState('');
  const { handleInputChange } = useTypingIndicator(conversationId);

  return (
    <textarea
      value={content}
      onChange={(e) => {
        setContent(e.target.value);
        handleInputChange();
      }}
    />
  );
}
```

### Backend: Typing Handler with Redis TTL

```typescript
// backend/src/websocket/handlers.ts
export async function handleTyping(
  ws: WebSocket,
  userId: string,
  payload: { conversationId: string }
): Promise<void> {
  const { conversationId } = payload;

  // Store typing flag with 3-second TTL
  const typingKey = `typing:${conversationId}:${userId}`;
  const wasTyping = await redis.exists(typingKey);
  await redis.setex(typingKey, 3, '1');

  // Get user info for display
  const user = await pool.query(
    `SELECT username FROM users WHERE id = $1`,
    [userId]
  );

  // Broadcast to other participants
  const participants = await pool.query(
    `SELECT user_id FROM conversation_participants
     WHERE conversation_id = $1 AND user_id != $2`,
    [conversationId, userId]
  );

  for (const p of participants.rows) {
    await routeToRecipient(p.user_id, {
      type: 'typing',
      payload: {
        conversationId,
        userId,
        username: user.rows[0].username,
        isTyping: true
      }
    });
  }

  // Schedule stop-typing notification (if not refreshed)
  if (!wasTyping) {
    setTimeout(async () => {
      const stillTyping = await redis.exists(typingKey);
      if (!stillTyping) {
        for (const p of participants.rows) {
          await routeToRecipient(p.user_id, {
            type: 'typing',
            payload: {
              conversationId,
              userId,
              username: user.rows[0].username,
              isTyping: false
            }
          });
        }
      }
    }, 3500); // Slightly after TTL
  }
}
```

### Frontend: Displaying Typing Indicators

```typescript
// frontend/src/stores/chatStore.ts
interface ChatState {
  typingUsers: Record<string, Map<string, { username: string; timestamp: number }>>;

  setTypingUser: (
    conversationId: string,
    userId: string,
    username: string,
    isTyping: boolean
  ) => void;
}

// In store implementation
setTypingUser: (conversationId, userId, username, isTyping) => set((state) => {
  const convTyping = new Map(state.typingUsers[conversationId] || new Map());

  if (isTyping) {
    convTyping.set(userId, { username, timestamp: Date.now() });
  } else {
    convTyping.delete(userId);
  }

  return {
    typingUsers: {
      ...state.typingUsers,
      [conversationId]: convTyping
    }
  };
}),

// Component to display
function TypingIndicator({ conversationId }: { conversationId: string }) {
  const typingMap = useChatStore(s => s.typingUsers[conversationId]);

  if (!typingMap || typingMap.size === 0) return null;

  const usernames = Array.from(typingMap.values()).map(t => t.username);
  const text = usernames.length === 1
    ? `${usernames[0]} is typing...`
    : `${usernames.join(', ')} are typing...`;

  return (
    <div className="text-sm text-teal-600 italic px-4 py-2">
      {text}
      <BouncingDots />
    </div>
  );
}
```

---

## 6. Deep Dive: Read Receipts (4-5 minutes)

### Read Receipt Flow

```
Recipient opens chat
        │
        ▼
┌───────────────┐
│ Frontend:     │
│ Mark messages │
│ as read up to │
│ last visible  │
└───────┬───────┘
        │
        │───WS: read (conversationId, upToMessageId)──►
        │                                              │
        │                                        ┌─────┴─────┐
        │                                        │ Backend:  │
        │                                        │ UPDATE    │
        │                                        │ all status│
        │                                        │ <= msgId  │
        │                                        │ to 'read' │
        │                                        └─────┬─────┘
        │                                              │
        │                                              │───WS: message_status──►
        │                                              │       (to sender)
        │                                              │
        │                                        ┌─────┴─────┐
        │                                        │ Sender UI:│
        │                                        │ Blue ticks│
        │                                        │ ✓✓        │
        │                                        └───────────┘
```

### Frontend: Sending Read Receipts

```typescript
// frontend/src/hooks/useReadReceipts.ts
export function useReadReceipts(conversationId: string) {
  const socket = useWebSocket();
  const messages = useChatStore(s => s.messagesByConversation[conversationId] || []);
  const lastSentReadReceipt = useRef<string | null>(null);

  // Intersection Observer to track visible messages
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    // Debounced read receipt sender
    let timeoutId: NodeJS.Timeout;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const visibleMessages = entries
          .filter(e => e.isIntersecting)
          .map(e => e.target.getAttribute('data-message-id'))
          .filter(Boolean) as string[];

        if (visibleMessages.length === 0) return;

        // Find the latest visible message
        const latestVisible = visibleMessages[visibleMessages.length - 1];

        // Don't re-send if already sent
        if (latestVisible === lastSentReadReceipt.current) return;

        // Debounce to avoid spamming
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          socket.send({
            type: 'read',
            payload: {
              conversationId,
              upToMessageId: latestVisible
            }
          });
          lastSentReadReceipt.current = latestVisible;
        }, 500);
      },
      { threshold: 0.5 }
    );

    return () => {
      clearTimeout(timeoutId);
      observerRef.current?.disconnect();
    };
  }, [conversationId, socket]);

  return { observerRef };
}
```

### Backend: Batch Read Status Update

```typescript
// backend/src/websocket/handlers.ts
export async function handleRead(
  ws: WebSocket,
  userId: string,
  payload: { conversationId: string; upToMessageId: string }
): Promise<void> {
  const { conversationId, upToMessageId } = payload;

  // Get the timestamp of the "up to" message
  const upToMessage = await pool.query(
    `SELECT created_at FROM messages WHERE id = $1`,
    [upToMessageId]
  );

  if (upToMessage.rowCount === 0) return;

  const upToTimestamp = upToMessage.rows[0].created_at;

  // Batch update all messages up to this point
  // Using idempotent update (only if status is less than 'read')
  const updated = await pool.query(
    `UPDATE message_status ms
     SET status = 'read', updated_at = NOW()
     FROM messages m
     WHERE ms.message_id = m.id
       AND m.conversation_id = $1
       AND ms.recipient_id = $2
       AND m.created_at <= $3
       AND ms.status != 'read'
     RETURNING ms.message_id, m.sender_id`,
    [conversationId, userId, upToTimestamp]
  );

  // Update participant's last_read_at
  await pool.query(
    `UPDATE conversation_participants
     SET last_read_at = $3
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId, upToTimestamp]
  );

  // Notify senders of read status
  const senderNotifications = new Map<string, string[]>();

  for (const row of updated.rows) {
    if (!senderNotifications.has(row.sender_id)) {
      senderNotifications.set(row.sender_id, []);
    }
    senderNotifications.get(row.sender_id)!.push(row.message_id);
  }

  for (const [senderId, messageIds] of senderNotifications) {
    for (const messageId of messageIds) {
      await routeToRecipient(senderId, {
        type: 'message_status',
        payload: {
          messageId,
          status: 'read',
          userId
        }
      });
    }
  }
}
```

---

## 7. API Design and Validation (4-5 minutes)

### Zod Schemas for Validation

```typescript
// shared/schemas.ts
import { z } from 'zod';

// Message schemas
export const SendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().min(1).max(10000),
  contentType: z.enum(['text', 'image', 'video', 'file']),
  clientMessageId: z.string().uuid(),
  mediaUrl: z.string().url().optional(),
  replyToId: z.string().uuid().optional(),
});

export const TypingPayloadSchema = z.object({
  conversationId: z.string().uuid(),
});

export const ReadPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  upToMessageId: z.string().uuid(),
});

export const AckPayloadSchema = z.object({
  messageId: z.string().uuid(),
});

// WebSocket message schema
export const WSClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), payload: SendMessageSchema }),
  z.object({ type: z.literal('typing'), payload: TypingPayloadSchema }),
  z.object({ type: z.literal('read'), payload: ReadPayloadSchema }),
  z.object({ type: z.literal('ack'), payload: AckPayloadSchema }),
]);

// Type inference
export type SendMessagePayload = z.infer<typeof SendMessageSchema>;
export type WSClientMessage = z.infer<typeof WSClientMessageSchema>;
```

### Backend WebSocket Message Router

```typescript
// backend/src/websocket/router.ts
import { WSClientMessageSchema } from '../../shared/schemas.js';

export function createMessageRouter(ws: WebSocket, userId: string) {
  return async (data: string) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(data);
    } catch {
      ws.send(JSON.stringify({
        type: 'error',
        payload: { code: 'INVALID_JSON', message: 'Invalid JSON' }
      }));
      return;
    }

    // Validate against schema
    const result = WSClientMessageSchema.safeParse(parsed);

    if (!result.success) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: {
          code: 'VALIDATION_ERROR',
          message: result.error.issues[0].message
        }
      }));
      return;
    }

    const message = result.data;

    // Route to handler
    switch (message.type) {
      case 'message':
        await handleMessage(ws, userId, message.payload);
        break;
      case 'typing':
        await handleTyping(ws, userId, message.payload);
        break;
      case 'read':
        await handleRead(ws, userId, message.payload);
        break;
      case 'ack':
        await handleAck(ws, userId, message.payload);
        break;
    }
  };
}
```

### Frontend API Client with Type Safety

```typescript
// frontend/src/services/api.ts
import type { Conversation, Message, SendMessagePayload } from '../../shared/types';

const BASE_URL = '/api/v1';

class ApiClient {
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new ApiError(response.status, error.message);
    }

    return response.json();
  }

  // Conversations
  async getConversations(): Promise<Conversation[]> {
    return this.fetch('/conversations');
  }

  async createConversation(
    participantIds: string[],
    type: 'direct' | 'group',
    name?: string
  ): Promise<Conversation> {
    return this.fetch('/conversations', {
      method: 'POST',
      body: JSON.stringify({ participantIds, type, name }),
    });
  }

  // Messages
  async getMessages(
    conversationId: string,
    options?: { before?: string; since?: number; limit?: number }
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (options?.before) params.set('before', options.before);
    if (options?.since) params.set('since', options.since.toString());
    if (options?.limit) params.set('limit', options.limit.toString());

    return this.fetch(
      `/conversations/${conversationId}/messages?${params.toString()}`
    );
  }

  // Reactions
  async addReaction(
    conversationId: string,
    messageId: string,
    emoji: string
  ): Promise<void> {
    await this.fetch(
      `/conversations/${conversationId}/messages/${messageId}/reactions`,
      {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      }
    );
  }
}

export const api = new ApiClient();
```

---

## 8. Trade-offs and Alternatives (3-4 minutes)

### Architecture Decisions

| Decision | Trade-off | Alternative |
|----------|-----------|-------------|
| **WebSocket for all real-time** | Stateful connections, need sticky LB | Socket.IO (auto-fallback but larger) |
| **Redis Pub/Sub for cross-server** | No persistence, fire-and-forget | Kafka (durable but more complex) |
| **PostgreSQL for messages** | Simpler, limited write scale | Cassandra (better writes, more ops) |
| **IndexedDB for offline** | Browser-specific, 50MB limit | LocalStorage (simpler but 5MB) |
| **Zod for validation** | Runtime cost, bundle size | io-ts (FP style), ajv (faster) |

### Scaling Considerations

| Component | Current | Scaling Path |
|-----------|---------|--------------|
| WebSocket servers | 3 instances | Auto-scale based on connection count |
| PostgreSQL | Single node | Read replicas, then shard by conversation |
| Redis | Single node | Redis Cluster for HA |
| Offline storage | IndexedDB | Consider reducing TTL as DB grows |

### When to Reconsider

- **Add Kafka**: When message durability is critical or need replay
- **Add Cassandra**: When write throughput exceeds 1K messages/sec
- **Add CDN**: When serving media to distributed users
- **Add push notifications**: When mobile app requires background delivery

---

## 9. Testing Strategy (2-3 minutes)

### Integration Test Example

```typescript
// backend/src/__tests__/messaging.integration.test.ts
import { WebSocket } from 'ws';
import { setupTestDb, teardownTestDb, createTestUser } from './helpers';

describe('Message Flow Integration', () => {
  let sender: WebSocket;
  let recipient: WebSocket;
  let senderUserId: string;
  let recipientUserId: string;
  let conversationId: string;

  beforeAll(async () => {
    await setupTestDb();

    // Create test users and conversation
    senderUserId = await createTestUser('sender');
    recipientUserId = await createTestUser('recipient');
    conversationId = await createConversation([senderUserId, recipientUserId]);

    // Connect WebSockets
    sender = await connectAsUser(senderUserId);
    recipient = await connectAsUser(recipientUserId);
  });

  afterAll(async () => {
    sender.close();
    recipient.close();
    await teardownTestDb();
  });

  it('delivers message from sender to recipient', async () => {
    const clientMessageId = crypto.randomUUID();
    const messageContent = 'Hello, World!';

    // Send message
    sender.send(JSON.stringify({
      type: 'message',
      payload: {
        conversationId,
        content: messageContent,
        contentType: 'text',
        clientMessageId,
      }
    }));

    // Wait for recipient to receive
    const received = await waitForMessage(recipient, 'message');
    expect(received.payload.content).toBe(messageContent);
    expect(received.payload.conversationId).toBe(conversationId);

    // Recipient sends ACK
    recipient.send(JSON.stringify({
      type: 'ack',
      payload: { messageId: received.payload.id }
    }));

    // Wait for sender to receive delivery status
    const status = await waitForMessage(sender, 'message_status');
    expect(status.payload.status).toBe('delivered');
  });
});
```

---

## Summary

The full-stack WhatsApp design integrates:

1. **Shared Type System**: TypeScript types and Zod schemas ensure consistency between frontend and backend

2. **WebSocket Protocol**: Bidirectional real-time communication with message, typing, presence, and ACK events

3. **Message Delivery Pipeline**: Optimistic UI updates, server persistence, cross-server routing, delivery receipts

4. **Offline Architecture**: Frontend IndexedDB queue + cache, backend pending message delivery on reconnect

5. **Status Synchronization**: Idempotent status transitions (sent -> delivered -> read) with batched updates

The architecture supports reliable message delivery with seamless offline capability while maintaining type safety across the stack.

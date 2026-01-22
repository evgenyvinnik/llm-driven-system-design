# iMessage - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement (1 minute)

"I'll design iMessage, Apple's end-to-end encrypted messaging platform. As a full-stack engineer, I'll focus on the complete message flow from client-side encryption through server routing to recipient decryption, the shared type contracts between frontend and backend, and building reliable real-time delivery with offline support on both ends.

The core full-stack challenges are: coordinating encryption workflows across client and server, implementing WebSocket-based real-time delivery, and ensuring consistent message state across multiple devices."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **E2E Encrypted Messaging**: Client encrypts, server routes, recipient decrypts
- **Multi-Device Sync**: Messages appear on all user's devices
- **Group Chats**: Efficient encryption for group messaging
- **Offline Support**: Queue and sync when connectivity returns
- **Delivery Status**: Pending, sent, delivered, read indicators

### Non-Functional Requirements
- **Security**: Server cannot decrypt message content
- **Latency**: < 500ms for online message delivery
- **Reliability**: Zero message loss, exactly-once delivery semantics
- **Consistency**: Eventual consistency with causal ordering per conversation

### Scale Estimates
- **Users**: 1.5 billion+ active users
- **Messages/day**: 10+ billion
- **Devices per user**: 3-5 average

### Full-Stack Questions
1. How do we share encryption types between client and server?
2. What's the WebSocket protocol for real-time delivery?
3. How do we handle sync cursor management across devices?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                    React Frontend                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Zustand Stores │ Crypto Service │ WebSocket │ IndexedDB    │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                   Shared Types (TypeScript)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Express Backend                               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Key Directory │ Message Service │ WebSocket Hub │ Sync     │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   PostgreSQL    │  │     Valkey      │  │     MinIO       │
│   (messages,    │  │   (sessions,    │  │  (encrypted     │
│    keys, sync)  │  │    presence)    │  │   attachments)  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### Integration Points

| Component | Frontend | Backend | Shared |
|-----------|----------|---------|--------|
| Encryption | Web Crypto API | Key storage | Key format types |
| Messages | Send/receive UI | Store/route | Message envelope types |
| Real-time | WebSocket client | WebSocket hub | Protocol types |
| Sync | IndexedDB + cursors | Delta queries | Sync response types |

## Deep Dive: Shared Type Contracts (5 minutes)

### Shared Types Package

```typescript
// shared/types/message.ts
export interface MessageEnvelope {
  id: string;
  conversationId: string;
  senderId: string;
  contentType: 'text' | 'image' | 'video' | 'file';
  encryptedContent: string;  // Base64 encoded
  iv: string;                 // AES-GCM initialization vector
  encryptedKeys: DeviceEncryptedKey[];
  replyToId?: string;
  timestamp: string;          // ISO 8601
}

export interface DeviceEncryptedKey {
  deviceId: string;
  encryptedKey: string;       // Message key wrapped with device key
  ephemeralPublicKey: string; // For X3DH key derivation
}

export interface DevicePublicKeys {
  deviceId: string;
  identityPublicKey: string;  // ECDSA P-256
  signingPublicKey: string;   // ECDSA P-256
  preKey?: string;            // One-time ECDH key
}

// shared/types/sync.ts
export interface SyncRequest {
  conversationId: string;
  cursor?: string;            // Last synced message ID
  limit?: number;
}

export interface SyncResponse {
  messages: MessageEnvelope[];
  readReceipts: ReadReceipt[];
  cursor: string;
  hasMore: boolean;
}

export interface ReadReceipt {
  userId: string;
  lastReadMessageId: string;
  lastReadAt: string;
}

// shared/types/websocket.ts
export type WebSocketMessage =
  | { type: 'new_message'; payload: { messageId: string; conversationId: string } }
  | { type: 'delivery_receipt'; payload: { messageId: string; deviceId: string } }
  | { type: 'read_receipt'; payload: { conversationId: string; userId: string; lastReadMessageId: string } }
  | { type: 'typing'; payload: { conversationId: string; userId: string; isTyping: boolean } }
  | { type: 'ping' }
  | { type: 'pong' };

// shared/types/api.ts
export interface SendMessageRequest {
  conversationId: string;
  clientMessageId: string;    // For idempotency
  contentType: MessageEnvelope['contentType'];
  encryptedContent: string;
  iv: string;
  encryptedKeys: DeviceEncryptedKey[];
}

export interface SendMessageResponse {
  messageId: string;
  status: 'created' | 'duplicate';
  timestamp: string;
}

export interface GetDeviceKeysRequest {
  userIds: string[];
}

export interface GetDeviceKeysResponse {
  devices: Record<string, DevicePublicKeys[]>;  // userId -> devices
}
```

## Deep Dive: End-to-End Message Flow (10 minutes)

### Step 1: Frontend - Compose and Encrypt

```typescript
// frontend/services/messageService.ts
import type { SendMessageRequest, DeviceEncryptedKey } from '@imessage/shared';

class MessageService {
  private encryptionService: EncryptionService;
  private api: ApiClient;
  private wsManager: WebSocketManager;

  async sendMessage(conversationId: string, plaintext: string): Promise<void> {
    const clientMessageId = crypto.randomUUID();

    // 1. Get recipient device keys
    const participants = await this.api.getConversationParticipants(conversationId);
    const deviceKeys = await this.api.getDeviceKeys({ userIds: participants.map(p => p.userId) });

    // 2. Flatten to all devices (including sender's other devices)
    const allDevices = Object.values(deviceKeys.devices).flat();

    // 3. Encrypt message
    const encrypted = await this.encryptionService.encryptMessage(plaintext, allDevices);

    // 4. Create optimistic local message
    const optimisticMessage = {
      id: clientMessageId,
      conversationId,
      senderId: this.authService.userId,
      encryptedContent: encrypted.encryptedContent,
      iv: encrypted.iv,
      status: 'pending' as const,
      timestamp: new Date().toISOString(),
    };

    // 5. Store locally immediately
    await offlineStorage.saveMessage(optimisticMessage);
    useMessageStore.getState().addMessage(conversationId, optimisticMessage);

    // 6. Send to server
    const request: SendMessageRequest = {
      conversationId,
      clientMessageId,
      contentType: 'text',
      encryptedContent: encrypted.encryptedContent,
      iv: encrypted.iv,
      encryptedKeys: encrypted.encryptedKeys,
    };

    try {
      const response = await this.api.sendMessage(request);
      useMessageStore.getState().updateMessageStatus(clientMessageId, 'sent');
    } catch (error) {
      // Queue for retry
      await offlineStorage.queuePendingOperation({
        type: 'send_message',
        data: request,
      });
    }
  }
}
```

### Step 2: Backend - Receive and Route

```typescript
// backend/src/messages/messageController.ts
import type { SendMessageRequest, SendMessageResponse, WebSocketMessage } from '@imessage/shared';

class MessageController {
  async sendMessage(req: AuthenticatedRequest, res: Response) {
    const request = req.body as SendMessageRequest;
    const senderId = req.session.userId;

    // 1. Check idempotency
    const idempotencyKey = `${senderId}:${request.conversationId}:${request.clientMessageId}`;
    const existing = await this.idempotencyService.check(idempotencyKey);

    if (existing) {
      const response: SendMessageResponse = {
        messageId: existing.resultId,
        status: 'duplicate',
        timestamp: existing.timestamp,
      };
      return res.json(response);
    }

    // 2. Verify sender is participant
    const isParticipant = await this.conversationService.isParticipant(
      request.conversationId,
      senderId
    );
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not a conversation participant' });
    }

    // 3. Store message and keys in transaction
    const message = await this.db.transaction(async (tx) => {
      // Insert message
      const msg = await tx.query(`
        INSERT INTO messages (id, conversation_id, sender_id, content_type, encrypted_content, iv)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, created_at
      `, [
        uuidv4(),
        request.conversationId,
        senderId,
        request.contentType,
        request.encryptedContent,
        request.iv,
      ]);

      // Insert per-device encrypted keys
      for (const deviceKey of request.encryptedKeys) {
        await tx.query(`
          INSERT INTO message_keys (message_id, device_id, encrypted_key, ephemeral_public_key)
          VALUES ($1, $2, $3, $4)
        `, [msg.rows[0].id, deviceKey.deviceId, deviceKey.encryptedKey, deviceKey.ephemeralPublicKey]);
      }

      // Record idempotency
      await tx.query(`
        INSERT INTO idempotency_keys (key, user_id, result_id, status)
        VALUES ($1, $2, $3, 'completed')
      `, [idempotencyKey, senderId, msg.rows[0].id]);

      return msg.rows[0];
    });

    // 4. Notify recipients via WebSocket
    await this.notifyRecipients(request.conversationId, message.id, senderId);

    // 5. Return response
    const response: SendMessageResponse = {
      messageId: message.id,
      status: 'created',
      timestamp: message.created_at.toISOString(),
    };

    res.json(response);
  }

  private async notifyRecipients(conversationId: string, messageId: string, senderId: string) {
    const participants = await this.conversationService.getParticipants(conversationId);

    for (const participant of participants) {
      // Get all active devices for this user
      const devices = await this.deviceService.getActiveDevices(participant.userId);

      for (const device of devices) {
        // Skip sender's current device
        if (device.id === this.currentDeviceId) continue;

        const wsMessage: WebSocketMessage = {
          type: 'new_message',
          payload: { messageId, conversationId },
        };

        // Try WebSocket first
        const delivered = await this.wsHub.send(device.id, wsMessage);

        if (!delivered && device.pushToken) {
          // Fall back to push notification
          await this.pushService.send(device.pushToken, {
            type: 'message',
            messageId,
            conversationId,
          });
        }
      }
    }
  }
}
```

### Step 3: Frontend - Receive and Decrypt

```typescript
// frontend/services/websocket.ts
import type { WebSocketMessage, MessageEnvelope } from '@imessage/shared';

class WebSocketManager {
  private handleMessage(data: WebSocketMessage) {
    switch (data.type) {
      case 'new_message':
        this.handleNewMessage(data.payload);
        break;
      case 'delivery_receipt':
        this.handleDeliveryReceipt(data.payload);
        break;
      case 'read_receipt':
        this.handleReadReceipt(data.payload);
        break;
      case 'typing':
        this.handleTyping(data.payload);
        break;
    }
  }

  private async handleNewMessage(payload: { messageId: string; conversationId: string }) {
    // 1. Fetch message envelope from API
    const envelope: MessageEnvelope = await api.getMessage(payload.messageId);

    // 2. Find our device's encrypted key
    const ourKey = envelope.encryptedKeys.find(k => k.deviceId === this.deviceId);
    if (!ourKey) {
      console.warn('No key for this device');
      return;
    }

    // 3. Save encrypted message to local storage
    await offlineStorage.saveMessage({
      id: envelope.id,
      conversationId: envelope.conversationId,
      senderId: envelope.senderId,
      encryptedContent: envelope.encryptedContent,
      iv: envelope.iv,
      status: 'delivered',
      timestamp: envelope.timestamp,
    });

    // 4. Update UI (decryption happens on render)
    useMessageStore.getState().addMessage(envelope.conversationId, envelope);

    // 5. Send delivery receipt
    this.send({
      type: 'delivery_receipt',
      payload: { messageId: envelope.id, deviceId: this.deviceId },
    });
  }
}
```

## Deep Dive: WebSocket Protocol (8 minutes)

### Backend WebSocket Hub

```typescript
// backend/src/websocket/wsHub.ts
import type { WebSocketMessage } from '@imessage/shared';
import WebSocket from 'ws';

class WebSocketHub {
  private connections: Map<string, WebSocket> = new Map(); // deviceId -> ws
  private redis: Redis;

  constructor(server: http.Server, redis: Redis) {
    this.redis = redis;
    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage) {
    // Authenticate from query string
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const sessionToken = url.searchParams.get('token');

    if (!sessionToken) {
      ws.close(4001, 'Missing token');
      return;
    }

    const session = await this.authService.validateSession(sessionToken);
    if (!session) {
      ws.close(4002, 'Invalid session');
      return;
    }

    const { deviceId } = session;

    // Register connection
    this.connections.set(deviceId, ws);

    // Update presence
    await this.redis.hset(`presence:${session.userId}`, deviceId, Date.now().toString());
    await this.redis.expire(`presence:${session.userId}`, 30);

    // Handle messages
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as WebSocketMessage;
      this.handleClientMessage(deviceId, session.userId, message);
    });

    // Handle disconnect
    ws.on('close', () => {
      this.connections.delete(deviceId);
      this.redis.hdel(`presence:${session.userId}`, deviceId);
    });

    // Heartbeat
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('close', () => clearInterval(heartbeatInterval));
  }

  private async handleClientMessage(
    deviceId: string,
    userId: string,
    message: WebSocketMessage
  ) {
    switch (message.type) {
      case 'delivery_receipt':
        await this.handleDeliveryReceipt(message.payload);
        break;

      case 'read_receipt':
        await this.handleReadReceipt(userId, deviceId, message.payload);
        break;

      case 'typing':
        await this.handleTyping(userId, message.payload);
        break;

      case 'ping':
        this.send(deviceId, { type: 'pong' });
        break;
    }
  }

  private async handleDeliveryReceipt(payload: { messageId: string; deviceId: string }) {
    // Record delivery
    await this.db.query(`
      INSERT INTO delivery_receipts (message_id, device_id, delivered_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (message_id, device_id) DO NOTHING
    `, [payload.messageId, payload.deviceId]);

    // Notify sender
    const message = await this.db.query(`
      SELECT sender_id FROM messages WHERE id = $1
    `, [payload.messageId]);

    if (message.rows[0]) {
      const senderDevices = await this.deviceService.getActiveDevices(message.rows[0].sender_id);
      for (const device of senderDevices) {
        this.send(device.id, {
          type: 'delivery_receipt',
          payload,
        });
      }
    }
  }

  private async handleTyping(userId: string, payload: { conversationId: string; isTyping: boolean }) {
    // Get all conversation participants except sender
    const participants = await this.conversationService.getParticipants(payload.conversationId);

    const typingMessage: WebSocketMessage = {
      type: 'typing',
      payload: { ...payload, userId },
    };

    for (const participant of participants) {
      if (participant.userId === userId) continue;

      const devices = await this.deviceService.getActiveDevices(participant.userId);
      for (const device of devices) {
        this.send(device.id, typingMessage);
      }
    }

    // Store in Redis with TTL for clients that reconnect
    if (payload.isTyping) {
      await this.redis.setex(`typing:${payload.conversationId}:${userId}`, 5, '1');
    } else {
      await this.redis.del(`typing:${payload.conversationId}:${userId}`);
    }
  }

  async send(deviceId: string, message: WebSocketMessage): Promise<boolean> {
    const ws = this.connections.get(deviceId);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }

    return false;
  }
}
```

### Frontend WebSocket Client

```typescript
// frontend/services/websocket.ts
import type { WebSocketMessage } from '@imessage/shared';

class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;

  connect(sessionToken: string) {
    const wsUrl = `${import.meta.env.VITE_WS_URL}?token=${sessionToken}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;

      // Sync any missed messages while disconnected
      this.syncMissedMessages();
    };

    this.ws.onmessage = (event) => {
      const message: WebSocketMessage = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = () => {
      this.scheduleReconnect(sessionToken);
    };
  }

  private async syncMissedMessages() {
    const conversations = await offlineStorage.getAllConversations();

    for (const conv of conversations) {
      const cursor = await offlineStorage.getSyncCursor(conv.id);
      const response = await api.sync({ conversationId: conv.id, cursor });

      for (const message of response.messages) {
        await offlineStorage.saveMessage(message);
      }

      if (response.messages.length > 0) {
        await offlineStorage.saveSyncCursor({
          conversationId: conv.id,
          cursor: response.cursor,
        });
      }
    }
  }

  send(message: WebSocketMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendTyping(conversationId: string, isTyping: boolean) {
    this.send({
      type: 'typing',
      payload: { conversationId, userId: this.userId, isTyping },
    });
  }

  private scheduleReconnect(sessionToken: string) {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect(sessionToken);
    }, delay);
  }
}
```

## Deep Dive: Sync Cursor Integration (7 minutes)

### Backend Sync Endpoint

```typescript
// backend/src/sync/syncController.ts
import type { SyncRequest, SyncResponse, MessageEnvelope } from '@imessage/shared';

class SyncController {
  async sync(req: AuthenticatedRequest, res: Response) {
    const { conversationId, cursor, limit = 100 } = req.body as SyncRequest;
    const deviceId = req.session.deviceId;

    // 1. Verify participant
    const isParticipant = await this.conversationService.isParticipant(
      conversationId,
      req.session.userId
    );
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // 2. Fetch messages since cursor
    const messages = await this.db.query(`
      SELECT
        m.id,
        m.conversation_id,
        m.sender_id,
        m.content_type,
        m.encrypted_content,
        m.iv,
        m.created_at,
        m.deleted_at
      FROM messages m
      WHERE m.conversation_id = $1
        AND m.created_at > COALESCE(
          (SELECT created_at FROM messages WHERE id = $2),
          '1970-01-01'::timestamp
        )
      ORDER BY m.created_at ASC
      LIMIT $3
    `, [conversationId, cursor, limit + 1]);

    const hasMore = messages.rows.length > limit;
    const messageList = messages.rows.slice(0, limit);

    // 3. Fetch encrypted keys for this device
    const messageIds = messageList.map(m => m.id);
    const keys = await this.db.query(`
      SELECT message_id, encrypted_key, ephemeral_public_key
      FROM message_keys
      WHERE message_id = ANY($1) AND device_id = $2
    `, [messageIds, deviceId]);

    const keyMap = new Map(keys.rows.map(k => [k.message_id, k]));

    // 4. Build response with envelope format
    const envelopes: MessageEnvelope[] = messageList.map(m => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      contentType: m.content_type,
      encryptedContent: m.encrypted_content,
      iv: m.iv,
      encryptedKeys: keyMap.has(m.id) ? [{
        deviceId,
        encryptedKey: keyMap.get(m.id)!.encrypted_key,
        ephemeralPublicKey: keyMap.get(m.id)!.ephemeral_public_key,
      }] : [],
      timestamp: m.created_at.toISOString(),
    }));

    // 5. Fetch read receipts
    const readReceipts = await this.db.query(`
      SELECT user_id, last_read_message_id, last_read_at
      FROM read_receipts
      WHERE conversation_id = $1 AND device_id != $2
    `, [conversationId, deviceId]);

    // 6. Update sync cursor for this device
    if (messageList.length > 0) {
      await this.db.query(`
        INSERT INTO sync_cursors (device_id, conversation_id, last_synced_message_id, last_synced_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (device_id, conversation_id) DO UPDATE
        SET last_synced_message_id = EXCLUDED.last_synced_message_id,
            last_synced_at = EXCLUDED.last_synced_at
      `, [deviceId, conversationId, messageList[messageList.length - 1].id]);
    }

    const response: SyncResponse = {
      messages: envelopes,
      readReceipts: readReceipts.rows.map(r => ({
        userId: r.user_id,
        lastReadMessageId: r.last_read_message_id,
        lastReadAt: r.last_read_at.toISOString(),
      })),
      cursor: messageList.length > 0 ? messageList[messageList.length - 1].id : cursor || '',
      hasMore,
    };

    res.json(response);
  }
}
```

### Frontend Sync Integration

```typescript
// frontend/stores/syncStore.ts
import type { SyncResponse } from '@imessage/shared';

interface SyncState {
  syncConversation: (conversationId: string) => Promise<void>;
  syncAll: () => Promise<void>;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  syncConversation: async (conversationId: string) => {
    const cursor = await offlineStorage.getSyncCursor(conversationId);

    let hasMore = true;
    while (hasMore) {
      const response: SyncResponse = await api.sync({
        conversationId,
        cursor: cursor || undefined,
      });

      // Process messages
      for (const envelope of response.messages) {
        // Check if we already have this (sent from this device)
        const existing = await offlineStorage.getMessage(envelope.id);

        if (existing) {
          // Just update status
          await offlineStorage.updateMessageStatus(envelope.id, 'delivered');
        } else {
          // New message from server
          await offlineStorage.saveMessage({
            id: envelope.id,
            conversationId: envelope.conversationId,
            senderId: envelope.senderId,
            encryptedContent: envelope.encryptedContent,
            iv: envelope.iv,
            status: 'delivered',
            timestamp: envelope.timestamp,
          });
        }
      }

      // Update read receipts
      for (const receipt of response.readReceipts) {
        await offlineStorage.saveReadReceipt(conversationId, receipt);
      }

      // Update cursor
      if (response.messages.length > 0) {
        await offlineStorage.saveSyncCursor({
          conversationId,
          cursor: response.cursor,
          syncedAt: Date.now(),
        });
      }

      hasMore = response.hasMore;
    }

    // Refresh UI from storage
    const messages = await offlineStorage.getConversationMessages(conversationId);
    useMessageStore.getState().setMessages(conversationId, messages);
  },

  syncAll: async () => {
    const conversations = await offlineStorage.getAllConversations();
    await Promise.all(conversations.map(c => get().syncConversation(c.id)));
  },
}));
```

## Trade-offs and Alternatives (5 minutes)

### 1. Shared Types Strategy

| Approach | Pros | Cons |
|----------|------|------|
| **Monorepo with shared package (chosen)** | Type safety, single source of truth | Build complexity |
| OpenAPI/Swagger generation | Language agnostic | Runtime validation overhead |
| Copy-paste types | Simple | Drift risk |

**Decision**: Shared TypeScript package in monorepo for compile-time safety.

### 2. WebSocket vs Server-Sent Events

| Approach | Pros | Cons |
|----------|------|------|
| **WebSocket (chosen)** | Bidirectional, typing indicators | Connection management |
| SSE | Simpler, auto-reconnect | One-way only |
| Long polling | Universal support | Higher latency |

**Decision**: WebSocket for bidirectional real-time (typing, receipts).

### 3. Sync Strategy

| Approach | Pros | Cons |
|----------|------|------|
| **Cursor-based delta (chosen)** | Efficient, resumable | Cursor tracking complexity |
| Timestamp-based | Simple | Clock skew issues |
| Full sync | Simple | Bandwidth inefficient |

**Decision**: Cursor-based with device-conversation granularity.

### 4. Encryption Key Distribution

| Approach | Pros | Cons |
|----------|------|------|
| **Per-message key (chosen)** | Forward secrecy | O(devices) wrapping |
| Session keys | Less overhead | Compromise affects session |
| Group key | Simple | No forward secrecy |

**Decision**: Per-message keys wrapped for each device for maximum security.

## API Endpoints Summary (2 minutes)

### Message API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/messages | Send encrypted message |
| GET | /api/v1/messages/:id | Fetch message envelope |
| POST | /api/v1/messages/sync | Sync conversation messages |
| POST | /api/v1/messages/:id/read | Mark message as read |

### Key API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/v1/devices/:userId | Get user's device keys |
| POST | /api/v1/devices/register | Register device with keys |
| POST | /api/v1/devices/:id/prekeys | Upload new prekeys |

### WebSocket Protocol

| Message Type | Direction | Description |
|--------------|-----------|-------------|
| new_message | Server -> Client | New message notification |
| delivery_receipt | Bidirectional | Message delivered to device |
| read_receipt | Bidirectional | Message read by user |
| typing | Bidirectional | Typing indicator |

## Closing Summary (1 minute)

"The iMessage full-stack system is built on three integration pillars:

1. **Shared Type Contracts** ensuring compile-time safety for encryption envelopes, WebSocket protocols, and sync responses between frontend and backend.

2. **End-to-End Message Flow** with client-side encryption using Web Crypto API, server-side routing without decryption capability, and recipient decryption with delivery receipts.

3. **Real-Time Sync Architecture** combining WebSocket for instant delivery, cursor-based delta sync for reliability, and IndexedDB for offline persistence.

The main trade-off is complexity vs. security. We accept the overhead of per-device encryption and idempotent delivery because messaging security is non-negotiable. Future improvements would include MLS for large groups and sealed sender for metadata protection."

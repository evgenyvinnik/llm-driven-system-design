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

> "We use a monorepo with a shared TypeScript package to ensure compile-time type safety between frontend and backend. This prevents drift and catches breaking changes at build time."

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     @imessage/shared Types                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  MessageEnvelope:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ id: string                     (message UUID)                           ││
│  │ conversationId: string         (chat thread)                            ││
│  │ senderId: string               (author)                                 ││
│  │ contentType: 'text' | 'image' | 'video' | 'file'                       ││
│  │ encryptedContent: string       (Base64 encoded ciphertext)              ││
│  │ iv: string                     (AES-GCM initialization vector)          ││
│  │ encryptedKeys: DeviceEncryptedKey[]  (per-device wrapped keys)         ││
│  │ replyToId?: string             (for replies)                            ││
│  │ timestamp: string              (ISO 8601)                               ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  DeviceEncryptedKey:                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ deviceId: string               (target device)                          ││
│  │ encryptedKey: string           (message key wrapped with device key)    ││
│  │ ephemeralPublicKey: string     (for X3DH key derivation)                ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  DevicePublicKeys:                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ deviceId: string                                                        ││
│  │ identityPublicKey: string      (ECDSA P-256)                            ││
│  │ signingPublicKey: string       (ECDSA P-256)                            ││
│  │ preKey?: string                (one-time ECDH key)                      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Sync Types

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Sync Request/Response Types                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  SyncRequest:                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ conversationId: string         (which chat to sync)                     ││
│  │ cursor?: string                (last synced message ID)                 ││
│  │ limit?: number                 (pagination size)                        ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  SyncResponse:                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ messages: MessageEnvelope[]    (new messages since cursor)              ││
│  │ readReceipts: ReadReceipt[]    (who read what)                          ││
│  │ cursor: string                 (new cursor for next sync)               ││
│  │ hasMore: boolean               (pagination continues?)                  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ReadReceipt:                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ userId: string                                                          ││
│  │ lastReadMessageId: string                                               ││
│  │ lastReadAt: string             (ISO 8601)                               ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### WebSocket Protocol Types

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     WebSocketMessage Union Type                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  type: 'new_message'                                                         │
│    payload: { messageId, conversationId }                                    │
│    direction: Server ──▶ Client                                              │
│                                                                              │
│  type: 'delivery_receipt'                                                    │
│    payload: { messageId, deviceId }                                          │
│    direction: Bidirectional                                                  │
│                                                                              │
│  type: 'read_receipt'                                                        │
│    payload: { conversationId, userId, lastReadMessageId }                    │
│    direction: Bidirectional                                                  │
│                                                                              │
│  type: 'typing'                                                              │
│    payload: { conversationId, userId, isTyping }                             │
│    direction: Bidirectional                                                  │
│                                                                              │
│  type: 'ping' | 'pong'                                                       │
│    direction: Bidirectional (heartbeat)                                      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### API Request/Response Types

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     API Types                                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  SendMessageRequest:                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ conversationId: string                                                  ││
│  │ clientMessageId: string        (for idempotency)                        ││
│  │ contentType: MessageEnvelope['contentType']                             ││
│  │ encryptedContent: string                                                ││
│  │ iv: string                                                              ││
│  │ encryptedKeys: DeviceEncryptedKey[]                                     ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  SendMessageResponse:                                                        │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ messageId: string              (server-assigned ID)                     ││
│  │ status: 'created' | 'duplicate'                                         ││
│  │ timestamp: string              (server timestamp)                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  GetDeviceKeysRequest/Response:                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Request:  { userIds: string[] }                                         ││
│  │ Response: { devices: Record<userId, DevicePublicKeys[]> }               ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: End-to-End Message Flow (10 minutes)

### Step 1: Frontend - Compose and Encrypt

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Send Message Flow (Frontend)                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Get Recipient Device Keys                                                │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ participants = await api.getConversationParticipants(conversationId)│ │
│     │ deviceKeys = await api.getDeviceKeys({ userIds })                   │ │
│     │ allDevices = Object.values(deviceKeys.devices).flat()               │ │
│     │            └──▶ Includes sender's OTHER devices for sync            │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  2. Encrypt Message                                                          │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ encrypted = await encryptionService.encryptMessage(plaintext,       │ │
│     │                                                    allDevices)      │ │
│     │                                                                     │ │
│     │ Returns:                                                            │ │
│     │   encryptedContent: AES-GCM ciphertext                              │ │
│     │   iv: initialization vector                                         │ │
│     │   encryptedKeys: [...] per-device wrapped keys                      │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  3. Optimistic UI Update                                                     │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ optimisticMessage = {                                               │ │
│     │   id: clientMessageId,                                              │ │
│     │   status: 'pending',                                                │ │
│     │   ...encrypted                                                      │ │
│     │ }                                                                   │ │
│     │                                                                     │ │
│     │ await offlineStorage.saveMessage(optimisticMessage)                 │ │
│     │ useMessageStore.getState().addMessage(conversationId, ...)          │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  4. Send to Server                                                           │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ try {                                                               │ │
│     │   response = await api.sendMessage(request)                         │ │
│     │   updateMessageStatus(clientMessageId, 'sent')                      │ │
│     │ } catch {                                                           │ │
│     │   offlineStorage.queuePendingOperation({                            │ │
│     │     type: 'send_message', data: request                             │ │
│     │   })                                                                │ │
│     │ }                                                                   │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Step 2: Backend - Receive and Route

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Message Controller (Backend)                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Check Idempotency                                                        │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ idempotencyKey = `${senderId}:${conversationId}:${clientMessageId}` │ │
│     │                                                                     │ │
│     │ existing = await idempotencyService.check(idempotencyKey)           │ │
│     │   └──▶ if exists: return { messageId, status: 'duplicate' }         │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  2. Verify Participant                                                       │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ if (!conversationService.isParticipant(conversationId, senderId))   │ │
│     │   return 403 'Not a conversation participant'                       │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  3. Store in Transaction                                                     │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ await db.transaction(async (tx) => {                                │ │
│     │   // Insert message                                                 │ │
│     │   INSERT INTO messages (...) VALUES (...)                           │ │
│     │                                                                     │ │
│     │   // Insert per-device encrypted keys                               │ │
│     │   for (deviceKey of encryptedKeys)                                  │ │
│     │     INSERT INTO message_keys (message_id, device_id,                │ │
│     │                               encrypted_key, ephemeral_public_key)  │ │
│     │                                                                     │ │
│     │   // Record idempotency                                             │ │
│     │   INSERT INTO idempotency_keys (key, result_id, status)             │ │
│     │ })                                                                  │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  4. Notify Recipients                                                        │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ for (participant of participants)                                   │ │
│     │   for (device of participant.devices)                               │ │
│     │     if (device.id !== currentDeviceId)                              │ │
│     │       delivered = await wsHub.send(device.id, {                     │ │
│     │         type: 'new_message',                                        │ │
│     │         payload: { messageId, conversationId }                      │ │
│     │       })                                                            │ │
│     │       if (!delivered && device.pushToken)                           │ │
│     │         await pushService.send(device.pushToken, ...)               │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Step 3: Frontend - Receive and Decrypt

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     WebSocket Message Handler (Frontend)                      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  on('new_message'):                                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 1. Fetch message envelope from API                                      ││
│  │    envelope = await api.getMessage(payload.messageId)                   ││
│  │                                                                         ││
│  │ 2. Find our device's encrypted key                                      ││
│  │    ourKey = envelope.encryptedKeys.find(k => k.deviceId === deviceId)   ││
│  │    if (!ourKey) return // Not intended for this device                  ││
│  │                                                                         ││
│  │ 3. Save to local storage (still encrypted)                              ││
│  │    await offlineStorage.saveMessage({                                   ││
│  │      id, conversationId, senderId,                                      ││
│  │      encryptedContent, iv,                                              ││
│  │      status: 'delivered',                                               ││
│  │      timestamp                                                          ││
│  │    })                                                                   ││
│  │                                                                         ││
│  │ 4. Update UI (decryption happens lazily on render)                      ││
│  │    useMessageStore.getState().addMessage(conversationId, envelope)      ││
│  │                                                                         ││
│  │ 5. Send delivery receipt                                                ││
│  │    ws.send({                                                            ││
│  │      type: 'delivery_receipt',                                          ││
│  │      payload: { messageId, deviceId }                                   ││
│  │    })                                                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: WebSocket Protocol (8 minutes)

### Backend WebSocket Hub

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     WebSocketHub Class (Backend)                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  State:                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ connections: Map<deviceId, WebSocket>                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Connection Flow:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 1. Authenticate from query string token                                 ││
│  │    url = new URL(req.url)                                               ││
│  │    sessionToken = url.searchParams.get('token')                         ││
│  │    session = await authService.validateSession(sessionToken)            ││
│  │    if (!session) ws.close(4002, 'Invalid session')                      ││
│  │                                                                         ││
│  │ 2. Register connection                                                  ││
│  │    connections.set(session.deviceId, ws)                                ││
│  │                                                                         ││
│  │ 3. Update presence in Redis                                             ││
│  │    await redis.hset(`presence:${userId}`, deviceId, Date.now())         ││
│  │    await redis.expire(`presence:${userId}`, 30)                         ││
│  │                                                                         ││
│  │ 4. Set up heartbeat (30s interval)                                      ││
│  │    setInterval(() => ws.ping(), 30000)                                  ││
│  │                                                                         ││
│  │ 5. Handle disconnect                                                    ││
│  │    ws.on('close', () => {                                               ││
│  │      connections.delete(deviceId)                                       ││
│  │      redis.hdel(`presence:${userId}`, deviceId)                         ││
│  │    })                                                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Message Handlers:                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 'delivery_receipt' ──▶ Record in DB, notify sender's devices            ││
│  │ 'read_receipt' ──▶ Broadcast to conversation participants               ││
│  │ 'typing' ──▶ Broadcast to other participants (+ Redis TTL backup)       ││
│  │ 'ping' ──▶ Reply with 'pong'                                            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Delivery Receipt Flow

```
┌────────┐  delivery_receipt   ┌─────────────┐  INSERT   ┌────────────┐
│Receiver│ ──────────────────▶ │  WebSocket  │ ────────▶ │ PostgreSQL │
│ Device │                      │     Hub     │           │ delivery_  │
└────────┘                      └──────┬──────┘           │ receipts   │
                                       │                  └────────────┘
                                       │ notify sender
                                       ▼
                                ┌─────────────┐
                                │   Sender    │
                                │   Devices   │
                                └─────────────┘
```

### Typing Indicator Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Typing Indicator                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  User starts typing:                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 1. Send { type: 'typing', payload: { conversationId, isTyping: true } } ││
│  │ 2. Server broadcasts to all other participants                          ││
│  │ 3. Store in Redis with 5s TTL: typing:{convId}:{userId}                 ││
│  │    └──▶ For clients that reconnect and need current state              ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  User stops typing:                                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 1. Send { type: 'typing', payload: { conversationId, isTyping: false }} ││
│  │ 2. Server broadcasts and deletes Redis key                              ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Frontend WebSocket Client

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     WebSocketManager (Frontend)                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  connect(sessionToken):                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ ws = new WebSocket(`${WS_URL}?token=${sessionToken}`)                   ││
│  │                                                                         ││
│  │ ws.onopen = () => {                                                     ││
│  │   reconnectAttempts = 0                                                 ││
│  │   syncMissedMessages()  // Catch up on anything missed                  ││
│  │ }                                                                       ││
│  │                                                                         ││
│  │ ws.onclose = () => scheduleReconnect(sessionToken)                      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  syncMissedMessages():                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ for (conv of await offlineStorage.getAllConversations())                ││
│  │   cursor = await offlineStorage.getSyncCursor(conv.id)                  ││
│  │   response = await api.sync({ conversationId: conv.id, cursor })        ││
│  │   for (message of response.messages)                                    ││
│  │     await offlineStorage.saveMessage(message)                           ││
│  │   await offlineStorage.saveSyncCursor(conv.id, response.cursor)         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Exponential Backoff Reconnect:                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)          ││
│  │ setTimeout(() => {                                                      ││
│  │   reconnectAttempts++                                                   ││
│  │   connect(sessionToken)                                                 ││
│  │ }, delay)                                                               ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Sync Cursor Integration (7 minutes)

### Backend Sync Endpoint

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     POST /api/v1/messages/sync                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Verify Participant                                                       │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ if (!isParticipant(conversationId, userId))                         │ │
│     │   return 403 'Not a participant'                                    │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  2. Fetch Messages Since Cursor                                              │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ SELECT m.* FROM messages m                                          │ │
│     │ WHERE m.conversation_id = $conversationId                           │ │
│     │   AND m.created_at > COALESCE(                                      │ │
│     │     (SELECT created_at FROM messages WHERE id = $cursor),           │ │
│     │     '1970-01-01'::timestamp                                         │ │
│     │   )                                                                 │ │
│     │ ORDER BY m.created_at ASC                                           │ │
│     │ LIMIT $limit + 1  (extra to check hasMore)                          │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  3. Fetch Device-Specific Encrypted Keys                                     │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ SELECT message_id, encrypted_key, ephemeral_public_key              │ │
│     │ FROM message_keys                                                   │ │
│     │ WHERE message_id = ANY($messageIds) AND device_id = $deviceId       │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  4. Build MessageEnvelope[] Response                                         │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ envelopes = messages.map(m => ({                                    │ │
│     │   id, conversationId, senderId, contentType,                        │ │
│     │   encryptedContent, iv,                                             │ │
│     │   encryptedKeys: keyMap.has(m.id) ? [keyMap.get(m.id)] : [],       │ │
│     │   timestamp                                                         │ │
│     │ }))                                                                 │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  5. Fetch Read Receipts                                                      │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ SELECT user_id, last_read_message_id, last_read_at                  │ │
│     │ FROM read_receipts                                                  │ │
│     │ WHERE conversation_id = $conversationId AND device_id != $deviceId  │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  6. Update Sync Cursor for Device                                            │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ INSERT INTO sync_cursors (device_id, conversation_id,               │ │
│     │                           last_synced_message_id, last_synced_at)   │ │
│     │ ON CONFLICT DO UPDATE SET last_synced_message_id = $lastId          │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Return: { messages, readReceipts, cursor, hasMore }                         │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Frontend Sync Store

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     useSyncStore (Zustand)                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  syncConversation(conversationId):                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ cursor = await offlineStorage.getSyncCursor(conversationId)             ││
│  │                                                                         ││
│  │ while (hasMore) {                                                       ││
│  │   response = await api.sync({ conversationId, cursor })                 ││
│  │                                                                         ││
│  │   for (envelope of response.messages) {                                 ││
│  │     existing = await offlineStorage.getMessage(envelope.id)             ││
│  │     if (existing) {                                                     ││
│  │       // Our own message came back - update status                      ││
│  │       await offlineStorage.updateMessageStatus(envelope.id, 'delivered')││
│  │     } else {                                                            ││
│  │       // New message from server                                        ││
│  │       await offlineStorage.saveMessage(envelope)                        ││
│  │     }                                                                   ││
│  │   }                                                                     ││
│  │                                                                         ││
│  │   for (receipt of response.readReceipts) {                              ││
│  │     await offlineStorage.saveReadReceipt(conversationId, receipt)       ││
│  │   }                                                                     ││
│  │                                                                         ││
│  │   await offlineStorage.saveSyncCursor({                                 ││
│  │     conversationId,                                                     ││
│  │     cursor: response.cursor,                                            ││
│  │     syncedAt: Date.now()                                                ││
│  │   })                                                                    ││
│  │                                                                         ││
│  │   hasMore = response.hasMore                                            ││
│  │ }                                                                       ││
│  │                                                                         ││
│  │ // Refresh UI from storage                                              ││
│  │ messages = await offlineStorage.getConversationMessages(conversationId) ││
│  │ useMessageStore.getState().setMessages(conversationId, messages)        ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  syncAll():                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ conversations = await offlineStorage.getAllConversations()              ││
│  │ await Promise.all(conversations.map(c => syncConversation(c.id)))       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Trade-offs and Alternatives (5 minutes)

### 1. Shared Types Strategy

| Approach | Pros | Cons |
|----------|------|------|
| **Monorepo with shared package (chosen)** | Type safety, single source of truth | Build complexity |
| OpenAPI/Swagger generation | Language agnostic | Runtime validation overhead |
| Copy-paste types | Simple | Drift risk |

> "We chose a shared TypeScript package in a monorepo for compile-time safety. Breaking changes are caught at build time rather than runtime."

### 2. WebSocket vs Server-Sent Events

| Approach | Pros | Cons |
|----------|------|------|
| **WebSocket (chosen)** | Bidirectional, typing indicators | Connection management |
| SSE | Simpler, auto-reconnect | One-way only |
| Long polling | Universal support | Higher latency |

> "WebSocket is essential for bidirectional real-time features like typing indicators and receipts."

### 3. Sync Strategy

| Approach | Pros | Cons |
|----------|------|------|
| **Cursor-based delta (chosen)** | Efficient, resumable | Cursor tracking complexity |
| Timestamp-based | Simple | Clock skew issues |
| Full sync | Simple | Bandwidth inefficient |

> "Cursor-based sync with device-conversation granularity ensures efficient incremental updates."

### 4. Encryption Key Distribution

| Approach | Pros | Cons |
|----------|------|------|
| **Per-message key (chosen)** | Forward secrecy | O(devices) wrapping |
| Session keys | Less overhead | Compromise affects session |
| Group key | Simple | No forward secrecy |

> "Per-message keys wrapped for each device provides maximum security. The overhead is acceptable for the security guarantee."

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

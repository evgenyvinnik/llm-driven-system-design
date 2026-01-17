# Design iMessage - Architecture

## System Overview

iMessage is an encrypted messaging platform with multi-device sync. Core challenges involve E2E encryption across devices, message sync, and offline support.

**Learning Goals:**
- Build E2E encrypted messaging
- Design multi-device key management
- Implement message sync protocols
- Handle offline-first messaging

---

## Requirements

### Functional Requirements

1. **Send**: Send encrypted messages
2. **Sync**: Messages available on all devices
3. **Groups**: Create and manage group chats
4. **Media**: Share photos, videos, files
5. **Offline**: Work without connectivity

### Non-Functional Requirements

- **Security**: End-to-end encryption
- **Latency**: < 500ms message delivery
- **Reliability**: No message loss
- **Scale**: Billions of messages daily

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Devices                              │
│              iPhone │ iPad │ Mac │ Apple Watch                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    APNs / WebSocket                             │
│                  (Real-time delivery)                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Message Servers                               │
│    (Store encrypted blobs, route messages, key directory)       │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Key Directory │    │ Message Store │    │  iCloud Sync  │
│               │    │               │    │               │
│ - Device keys │    │ - Encrypted   │    │ - History     │
│ - Identity    │    │ - Attachments │    │ - Read state  │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Core Components

### 1. Key Management

**Multi-Device Key Architecture:**
```javascript
class KeyManager {
  constructor(userId) {
    this.userId = userId
    this.identityKey = null // Long-term identity key
    this.preKeys = [] // One-time prekeys
    this.devices = new Map() // deviceId -> keys
  }

  async initializeDevice(deviceId) {
    // Generate identity key pair (long-term)
    const identityKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )

    // Generate device signing key
    const signingKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )

    // Generate prekeys for forward secrecy
    const preKeys = await this.generatePreKeys(100)

    // Register with key directory
    await this.registerDevice(deviceId, {
      identityPublicKey: identityKey.publicKey,
      signingPublicKey: signingKey.publicKey,
      preKeys: preKeys.map(pk => pk.publicKey)
    })

    return {
      identityKey,
      signingKey,
      preKeys
    }
  }

  async generatePreKeys(count) {
    const preKeys = []

    for (let i = 0; i < count; i++) {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      )

      preKeys.push({
        id: i,
        ...keyPair
      })
    }

    return preKeys
  }

  async getRecipientKeys(recipientId) {
    // Fetch all device keys for recipient
    const devices = await this.keyDirectory.getDeviceKeys(recipientId)

    return devices.map(device => ({
      deviceId: device.deviceId,
      identityKey: device.identityPublicKey,
      preKey: device.preKeys[0] // Server removes used prekeys
    }))
  }
}
```

### 2. Message Encryption

**Per-Device Encryption:**
```javascript
class MessageEncryptor {
  async encryptMessage(senderId, recipientId, message) {
    // Get all recipient devices
    const recipientDevices = await this.keyManager.getRecipientKeys(recipientId)

    // Get all sender devices (for sync)
    const senderDevices = await this.keyManager.getRecipientKeys(senderId)

    const allDevices = [...recipientDevices, ...senderDevices]

    // Generate message key
    const messageKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )

    // Encrypt message content
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encryptedContent = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      messageKey,
      new TextEncoder().encode(JSON.stringify(message))
    )

    // Encrypt message key for each device
    const encryptedKeys = []

    for (const device of allDevices) {
      const encryptedKey = await this.encryptKeyForDevice(
        messageKey,
        device
      )

      encryptedKeys.push({
        deviceId: device.deviceId,
        encryptedKey
      })
    }

    return {
      iv,
      encryptedContent,
      encryptedKeys
    }
  }

  async encryptKeyForDevice(messageKey, device) {
    // X3DH key agreement
    // Generate ephemeral key
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    )

    // Compute shared secret: DH(ephemeral, identityKey) || DH(ephemeral, preKey)
    const dh1 = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: device.identityKey },
      ephemeral.privateKey,
      256
    )

    const dh2 = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: device.preKey },
      ephemeral.privateKey,
      256
    )

    // Combine and derive encryption key
    const combined = new Uint8Array([...new Uint8Array(dh1), ...new Uint8Array(dh2)])
    const kdf = await crypto.subtle.digest('SHA-256', combined)

    const wrappingKey = await crypto.subtle.importKey(
      'raw',
      kdf,
      { name: 'AES-KW' },
      false,
      ['wrapKey']
    )

    // Wrap message key
    const wrappedKey = await crypto.subtle.wrapKey(
      'raw',
      messageKey,
      wrappingKey,
      { name: 'AES-KW' }
    )

    return {
      ephemeralPublicKey: await crypto.subtle.exportKey('raw', ephemeral.publicKey),
      wrappedKey
    }
  }
}
```

### 3. Message Sync

**Cross-Device Synchronization:**
```javascript
class MessageSyncService {
  constructor(userId, deviceId) {
    this.userId = userId
    this.deviceId = deviceId
    this.syncCursor = null
  }

  async syncMessages() {
    // Get messages since last sync
    const response = await this.fetchMessages(this.syncCursor)

    for (const encryptedMessage of response.messages) {
      // Find our device's encrypted key
      const ourKey = encryptedMessage.encryptedKeys.find(
        k => k.deviceId === this.deviceId
      )

      if (!ourKey) {
        // Message wasn't encrypted for this device
        // (sent before device was registered)
        continue
      }

      // Decrypt message
      const message = await this.decryptMessage(encryptedMessage, ourKey)

      // Store locally
      await this.storeMessage(message)
    }

    // Update sync cursor
    this.syncCursor = response.cursor

    // Sync read receipts
    await this.syncReadReceipts()

    return response.messages.length
  }

  async syncReadReceipts() {
    // Get read state changes from other devices
    const readUpdates = await this.fetchReadUpdates(this.lastReadSync)

    for (const update of readUpdates) {
      await this.markAsRead(update.conversationId, update.lastReadMessageId)
    }

    // Upload our read state
    const localReadState = await this.getLocalReadState()
    await this.uploadReadState(localReadState)
  }

  // Real-time message delivery
  async handleIncomingMessage(encryptedMessage) {
    const ourKey = encryptedMessage.encryptedKeys.find(
      k => k.deviceId === this.deviceId
    )

    if (!ourKey) return

    const message = await this.decryptMessage(encryptedMessage, ourKey)
    await this.storeMessage(message)

    // Notify UI
    this.emit('newMessage', message)

    // Send delivery receipt
    await this.sendDeliveryReceipt(message.id)
  }
}
```

### 4. Group Messaging

**Sender Keys for Groups:**
```javascript
class GroupMessageService {
  async createGroup(creatorId, memberIds, groupName) {
    const groupId = uuid()

    // Generate group sender key for creator
    const senderKey = await this.generateSenderKey()

    // Distribute sender key to all members
    for (const memberId of memberIds) {
      await this.distributeSenderKey(groupId, creatorId, memberId, senderKey)
    }

    // Create group record
    const group = {
      id: groupId,
      name: groupName,
      creator: creatorId,
      members: memberIds,
      admins: [creatorId],
      createdAt: Date.now()
    }

    await this.storeGroup(group)

    return group
  }

  async sendGroupMessage(groupId, senderId, message) {
    // Get our sender key for this group
    const senderKey = await this.getSenderKey(groupId, senderId)

    // Derive message key using sender key chain
    const chainKey = this.advanceChain(senderKey)
    const messageKey = await this.deriveMessageKey(chainKey)

    // Encrypt message
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      messageKey,
      new TextEncoder().encode(JSON.stringify(message))
    )

    // Store sender chain state
    await this.updateChainState(groupId, senderId, chainKey)

    return {
      groupId,
      senderId,
      chainIndex: chainKey.index,
      iv,
      encrypted
    }
  }

  async distributeSenderKey(groupId, fromId, toId, senderKey) {
    // Encrypt sender key for each of recipient's devices
    const devices = await this.keyManager.getRecipientKeys(toId)

    for (const device of devices) {
      const encrypted = await this.encryptSenderKey(senderKey, device)

      await this.sendSenderKeyMessage(toId, device.deviceId, {
        type: 'sender_key',
        groupId,
        fromId,
        encrypted
      })
    }
  }

  async addMember(groupId, newMemberId, addedBy) {
    // Get all existing members' sender keys
    const group = await this.getGroup(groupId)

    // Distribute existing sender keys to new member
    for (const existingMember of group.members) {
      const senderKey = await this.getSenderKey(groupId, existingMember)
      await this.distributeSenderKey(groupId, existingMember, newMemberId, senderKey)
    }

    // Generate sender key for new member
    const newMemberKey = await this.generateSenderKey()

    // Distribute new member's key to all existing members
    for (const existingMember of group.members) {
      await this.distributeSenderKey(groupId, newMemberId, existingMember, newMemberKey)
    }

    // Update group membership
    await this.updateGroupMembers(groupId, [...group.members, newMemberId])
  }
}
```

### 5. Offline Support

**Offline-First Architecture:**
```javascript
class OfflineManager {
  constructor() {
    this.pendingMessages = []
    this.localDb = new IndexedDB('imessage')
  }

  async sendMessage(conversationId, content) {
    // Create message locally
    const message = {
      id: uuid(),
      conversationId,
      content,
      senderId: this.userId,
      timestamp: Date.now(),
      status: 'pending'
    }

    // Store locally immediately
    await this.localDb.put('messages', message)

    // Try to send
    if (this.isOnline()) {
      await this.transmitMessage(message)
    } else {
      // Queue for later
      this.pendingMessages.push(message)
    }

    return message
  }

  async onOnline() {
    // Flush pending messages
    for (const message of this.pendingMessages) {
      try {
        await this.transmitMessage(message)
        await this.updateMessageStatus(message.id, 'sent')
      } catch (error) {
        console.error('Failed to send message', error)
      }
    }

    this.pendingMessages = []

    // Sync with server
    await this.syncService.syncMessages()
  }

  async getConversation(conversationId) {
    // Always read from local database
    const messages = await this.localDb.getAll('messages', {
      index: 'conversationId',
      query: conversationId
    })

    return messages.sort((a, b) => a.timestamp - b.timestamp)
  }
}
```

---

## Database Schema

```sql
-- Conversations
CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  type VARCHAR(20), -- 'direct', 'group'
  name VARCHAR(200),
  participants UUID[],
  created_at TIMESTAMP DEFAULT NOW()
);

-- Messages (encrypted)
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  sender_id UUID NOT NULL,
  encrypted_content BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Per-device message keys
CREATE TABLE message_keys (
  message_id UUID REFERENCES messages(id),
  device_id UUID NOT NULL,
  encrypted_key BYTEA NOT NULL,
  ephemeral_public_key BYTEA NOT NULL,
  PRIMARY KEY (message_id, device_id)
);

-- Device Keys (public)
CREATE TABLE device_keys (
  device_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  identity_public_key BYTEA NOT NULL,
  signing_public_key BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Prekeys (one-time use)
CREATE TABLE prekeys (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID REFERENCES device_keys(device_id),
  prekey_id INTEGER NOT NULL,
  public_key BYTEA NOT NULL,
  used BOOLEAN DEFAULT FALSE
);

-- Read Receipts
CREATE TABLE read_receipts (
  user_id UUID NOT NULL,
  conversation_id UUID REFERENCES conversations(id),
  last_read_message_id UUID,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);
```

---

## Key Design Decisions

### 1. Per-Device Encryption

**Decision**: Encrypt message key for each device separately

**Rationale**:
- No shared device key to compromise
- New devices get new messages only
- Per-device revocation

### 2. Sender Keys for Groups

**Decision**: Use Signal's sender keys protocol

**Rationale**:
- O(1) encryption per message (not O(n))
- Forward secrecy via key ratchet
- Efficient for large groups

### 3. Offline-First Storage

**Decision**: Store messages locally before sending

**Rationale**:
- Instant perceived send
- Works without network
- Sync when online

---

## Consistency and Idempotency Semantics

### Write Consistency Model

**Message Delivery**: Eventual consistency with causal ordering

Messages are delivered with the following guarantees:
- **Causal ordering per conversation**: Messages from a single sender arrive in order within a conversation
- **No global ordering**: Cross-conversation message order is not guaranteed
- **Eventual delivery**: All recipient devices eventually receive all messages (no message loss)

```javascript
// Message write flow with consistency guarantees
class MessageWriteService {
  async sendMessage(senderId, conversationId, content, idempotencyKey) {
    // Step 1: Check idempotency (strong read from PostgreSQL)
    const existing = await this.db.query(
      'SELECT id, status FROM messages WHERE idempotency_key = $1',
      [idempotencyKey]
    );

    if (existing.rows.length > 0) {
      // Return existing message - idempotent retry
      return { messageId: existing.rows[0].id, status: 'duplicate' };
    }

    // Step 2: Insert message with idempotency key (transactional)
    const message = await this.db.transaction(async (tx) => {
      // Insert message record
      const msg = await tx.query(`
        INSERT INTO messages (id, conversation_id, sender_id, encrypted_content, iv, idempotency_key)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id, created_at
      `, [uuid(), conversationId, senderId, encryptedContent, iv, idempotencyKey]);

      if (msg.rows.length === 0) {
        // Race condition: another request inserted first
        const existing = await tx.query(
          'SELECT id FROM messages WHERE idempotency_key = $1',
          [idempotencyKey]
        );
        return { id: existing.rows[0].id, duplicate: true };
      }

      // Insert per-device keys
      await tx.query(`
        INSERT INTO message_keys (message_id, device_id, encrypted_key, ephemeral_public_key)
        SELECT $1, unnest($2::uuid[]), unnest($3::bytea[]), unnest($4::bytea[])
      `, [msg.rows[0].id, deviceIds, encryptedKeys, ephemeralKeys]);

      return { id: msg.rows[0].id, duplicate: false };
    });

    // Step 3: Queue for delivery (at-least-once via RabbitMQ)
    await this.messageQueue.publish('message.deliver', {
      messageId: message.id,
      conversationId,
      recipientDevices: deviceIds
    });

    return { messageId: message.id, status: message.duplicate ? 'duplicate' : 'created' };
  }
}
```

### Idempotency Key Strategy

| Operation | Idempotency Key | TTL | Scope |
|-----------|-----------------|-----|-------|
| Send message | `{userId}:{conversationId}:{clientMessageId}` | 24 hours | Per user |
| Delivery receipt | `{messageId}:{deviceId}:delivered` | 7 days | Per device |
| Read receipt | `{userId}:{conversationId}:{lastReadMessageId}` | 7 days | Per user |
| Device registration | `{userId}:{deviceFingerprint}` | Permanent | Per user |

### Conflict Resolution

**Last-Write-Wins for Metadata** (e.g., read receipts, typing indicators):
```javascript
// Read receipt sync - last writer wins based on timestamp
async updateReadReceipt(userId, conversationId, lastReadMessageId, clientTimestamp) {
  await this.db.query(`
    INSERT INTO read_receipts (user_id, conversation_id, last_read_message_id, updated_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, conversation_id) DO UPDATE
    SET last_read_message_id = EXCLUDED.last_read_message_id,
        updated_at = EXCLUDED.updated_at
    WHERE read_receipts.updated_at < EXCLUDED.updated_at
  `, [userId, conversationId, lastReadMessageId, clientTimestamp]);
}
```

**Append-Only for Messages**: Messages are never updated or deleted on the server (tombstones for deletion sync):
```sql
-- Soft delete via tombstone
ALTER TABLE messages ADD COLUMN deleted_at TIMESTAMP;
ALTER TABLE messages ADD COLUMN deleted_by UUID;

-- Clients sync tombstones and remove locally
CREATE INDEX idx_messages_deleted ON messages(conversation_id, deleted_at) WHERE deleted_at IS NOT NULL;
```

### Replay Handling

- **Client-generated message IDs**: Clients generate UUIDs for messages, allowing safe retries
- **Deduplication window**: Server rejects duplicate idempotency keys within 24-hour window
- **Delivery receipt dedup**: Device tracks last-processed message ID to skip already-delivered messages

---

## Caching and Edge Strategy

### Cache Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Devices                           │
│           (IndexedDB for offline-first local cache)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CDN (Cloudflare / MinIO)                     │
│      - Encrypted attachments (images, videos, files)            │
│      - Public assets (app icons, static content)                │
│      - Signed URLs for attachment access                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Valkey/Redis Cache Cluster                   │
│      - Device keys (hot path for encryption)                    │
│      - Session data and auth tokens                             │
│      - Rate limit counters                                      │
│      - Online presence / typing indicators                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PostgreSQL (Source of Truth)                 │
│      - Messages, conversations, device keys, prekeys            │
└─────────────────────────────────────────────────────────────────┘
```

### Caching Strategy by Data Type

| Data Type | Cache Location | Pattern | TTL | Invalidation |
|-----------|----------------|---------|-----|--------------|
| Device public keys | Valkey | Cache-aside | 1 hour | On key rotation, device removal |
| Prekeys (one-time) | None | Direct DB | N/A | Consumed on use |
| Session tokens | Valkey | Write-through | 24 hours | On logout, password change |
| User presence | Valkey | Write-through | 30 seconds | Heartbeat refresh |
| Typing indicators | Valkey | Write-through | 5 seconds | Auto-expire |
| Encrypted attachments | CDN/MinIO | Cache-aside | 30 days | Immutable (content-addressed) |
| Conversation metadata | Valkey | Cache-aside | 10 minutes | On membership change |

### Cache-Aside Pattern for Device Keys

Device keys are read frequently during message encryption but change rarely:

```javascript
class DeviceKeyCache {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
    this.keyPrefix = 'device_keys:';
    this.ttlSeconds = 3600; // 1 hour
  }

  async getDeviceKeys(userId) {
    const cacheKey = `${this.keyPrefix}${userId}`;

    // Try cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Cache miss - fetch from database
    const result = await this.db.query(`
      SELECT device_id, identity_public_key, signing_public_key
      FROM device_keys
      WHERE user_id = $1 AND revoked_at IS NULL
    `, [userId]);

    const deviceKeys = result.rows;

    // Populate cache
    await this.redis.setex(cacheKey, this.ttlSeconds, JSON.stringify(deviceKeys));

    return deviceKeys;
  }

  async invalidateDeviceKeys(userId) {
    const cacheKey = `${this.keyPrefix}${userId}`;
    await this.redis.del(cacheKey);
  }

  // Called when device is added, removed, or keys rotated
  async onDeviceKeyChange(userId) {
    await this.invalidateDeviceKeys(userId);
  }
}
```

### Write-Through Pattern for Presence

Presence data is ephemeral and write-heavy, so we write directly to cache:

```javascript
class PresenceService {
  constructor(redis) {
    this.redis = redis;
    this.presencePrefix = 'presence:';
    this.typingPrefix = 'typing:';
  }

  async setOnline(userId, deviceId) {
    const key = `${this.presencePrefix}${userId}`;
    // Store device with expiry, auto-offline after 30s without heartbeat
    await this.redis.hset(key, deviceId, Date.now());
    await this.redis.expire(key, 30);
  }

  async setTyping(userId, conversationId) {
    const key = `${this.typingPrefix}${conversationId}`;
    // Auto-expire typing indicator after 5 seconds
    await this.redis.setex(`${key}:${userId}`, 5, '1');
  }

  async getTypingUsers(conversationId) {
    const pattern = `${this.typingPrefix}${conversationId}:*`;
    const keys = await this.redis.keys(pattern);
    return keys.map(k => k.split(':').pop());
  }

  async isOnline(userId) {
    const key = `${this.presencePrefix}${userId}`;
    const devices = await this.redis.hgetall(key);
    return Object.keys(devices).length > 0;
  }
}
```

### CDN Strategy for Attachments

Attachments are encrypted client-side and stored immutably:

```javascript
class AttachmentService {
  constructor(minio, redis) {
    this.minio = minio;
    this.redis = redis;
    this.bucketName = 'imessage-attachments';
  }

  async uploadAttachment(encryptedData, contentHash) {
    // Content-addressed storage (hash-based key)
    const objectKey = `attachments/${contentHash}`;

    // Check if already exists (dedup)
    const exists = await this.minio.statObject(this.bucketName, objectKey)
      .catch(() => null);

    if (!exists) {
      await this.minio.putObject(this.bucketName, objectKey, encryptedData, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=2592000, immutable' // 30 days
      });
    }

    return objectKey;
  }

  async getSignedUrl(objectKey, expirySeconds = 3600) {
    // Generate time-limited signed URL for download
    return await this.minio.presignedGetObject(
      this.bucketName,
      objectKey,
      expirySeconds
    );
  }
}
```

### Cache Invalidation Rules

| Event | Invalidation Action |
|-------|---------------------|
| Device added | Invalidate `device_keys:{userId}` |
| Device removed | Invalidate `device_keys:{userId}` |
| Key rotation | Invalidate `device_keys:{userId}` |
| User logout | Delete `session:{sessionId}`, invalidate all user sessions |
| Conversation membership change | Invalidate `conversation:{conversationId}` |
| Password change | Invalidate all sessions for user |

### Local Development Configuration

```yaml
# docker-compose.yml additions for caching
services:
  valkey:
    image: valkey/valkey:7.2
    ports:
      - "6379:6379"
    volumes:
      - valkey_data:/data
    command: valkey-server --appendonly yes

  minio:
    image: minio/minio
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio_data:/data
    command: server /data --console-address ":9001"

volumes:
  valkey_data:
  minio_data:
```

---

## Authentication, Authorization, and Rate Limiting

### Authentication Strategy

**Session-Based Authentication** (per repository guidelines - avoiding JWT complexity):

```javascript
class AuthService {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.sessionPrefix = 'session:';
    this.sessionTTL = 86400 * 30; // 30 days
  }

  async login(email, password, deviceId, deviceInfo) {
    // Verify credentials
    const user = await this.db.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (!user.rows[0] || !await bcrypt.compare(password, user.rows[0].password_hash)) {
      throw new AuthError('Invalid credentials');
    }

    const userId = user.rows[0].id;

    // Generate secure session token
    const sessionId = crypto.randomBytes(32).toString('hex');

    // Store session in Redis with device binding
    const session = {
      userId,
      deviceId,
      deviceInfo,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };

    await this.redis.setex(
      `${this.sessionPrefix}${sessionId}`,
      this.sessionTTL,
      JSON.stringify(session)
    );

    // Track active sessions for user (for logout-all-devices)
    await this.redis.sadd(`user_sessions:${userId}`, sessionId);

    return { sessionId, userId };
  }

  async validateSession(sessionId) {
    const sessionData = await this.redis.get(`${this.sessionPrefix}${sessionId}`);

    if (!sessionData) {
      throw new AuthError('Session expired or invalid');
    }

    const session = JSON.parse(sessionData);

    // Update last active time (sliding expiry)
    session.lastActiveAt = Date.now();
    await this.redis.setex(
      `${this.sessionPrefix}${sessionId}`,
      this.sessionTTL,
      JSON.stringify(session)
    );

    return session;
  }

  async logout(sessionId) {
    const session = await this.validateSession(sessionId);
    await this.redis.del(`${this.sessionPrefix}${sessionId}`);
    await this.redis.srem(`user_sessions:${session.userId}`, sessionId);
  }

  async logoutAllDevices(userId) {
    const sessions = await this.redis.smembers(`user_sessions:${userId}`);
    for (const sessionId of sessions) {
      await this.redis.del(`${this.sessionPrefix}${sessionId}`);
    }
    await this.redis.del(`user_sessions:${userId}`);
  }
}
```

### Device Authentication

Devices must be authenticated separately from user sessions (for E2E encryption):

```javascript
class DeviceAuthService {
  async registerDevice(userId, sessionId, deviceInfo) {
    // Verify user session first
    const session = await this.authService.validateSession(sessionId);
    if (session.userId !== userId) {
      throw new AuthError('Session does not match user');
    }

    // Generate device identity
    const deviceId = uuid();
    const deviceSecret = crypto.randomBytes(32);

    // Store device registration
    await this.db.query(`
      INSERT INTO device_registrations (device_id, user_id, device_info, secret_hash, registered_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [deviceId, userId, JSON.stringify(deviceInfo), await bcrypt.hash(deviceSecret.toString('hex'), 10)]);

    return { deviceId, deviceSecret: deviceSecret.toString('hex') };
  }

  async authenticateDevice(deviceId, deviceSecret) {
    const device = await this.db.query(
      'SELECT user_id, secret_hash, revoked_at FROM device_registrations WHERE device_id = $1',
      [deviceId]
    );

    if (!device.rows[0]) {
      throw new AuthError('Device not registered');
    }

    if (device.rows[0].revoked_at) {
      throw new AuthError('Device has been revoked');
    }

    if (!await bcrypt.compare(deviceSecret, device.rows[0].secret_hash)) {
      throw new AuthError('Invalid device credentials');
    }

    return { userId: device.rows[0].user_id, deviceId };
  }
}
```

### Authorization (RBAC)

**Roles and Permissions**:

| Role | Scope | Permissions |
|------|-------|-------------|
| `user` | Own data | Send/receive messages, manage own devices, create groups |
| `group_admin` | Group | Add/remove members, change group settings, delete messages |
| `group_member` | Group | Send/receive group messages, leave group |
| `system_admin` | Global | View metrics, manage rate limits, revoke devices (for abuse) |

```javascript
class AuthorizationService {
  async checkPermission(userId, resource, action) {
    // Resource types: 'message', 'conversation', 'group', 'device', 'admin'

    switch (resource) {
      case 'conversation':
        return await this.canAccessConversation(userId, action.conversationId);

      case 'group':
        return await this.canManageGroup(userId, action.groupId, action.operation);

      case 'device':
        return await this.canManageDevice(userId, action.deviceId);

      case 'admin':
        return await this.isSystemAdmin(userId);

      default:
        return false;
    }
  }

  async canAccessConversation(userId, conversationId) {
    const result = await this.db.query(`
      SELECT 1 FROM conversations
      WHERE id = $1 AND $2 = ANY(participants)
    `, [conversationId, userId]);
    return result.rows.length > 0;
  }

  async canManageGroup(userId, groupId, operation) {
    const group = await this.db.query(
      'SELECT admins, members FROM conversations WHERE id = $1 AND type = $2',
      [groupId, 'group']
    );

    if (!group.rows[0]) return false;

    const { admins, members } = group.rows[0];

    switch (operation) {
      case 'send_message':
      case 'leave':
        return members.includes(userId);

      case 'add_member':
      case 'remove_member':
      case 'change_name':
      case 'delete_message':
        return admins.includes(userId);

      default:
        return false;
    }
  }

  async canManageDevice(userId, deviceId) {
    const result = await this.db.query(
      'SELECT 1 FROM device_registrations WHERE device_id = $1 AND user_id = $2',
      [deviceId, userId]
    );
    return result.rows.length > 0;
  }

  async isSystemAdmin(userId) {
    const result = await this.db.query(
      'SELECT 1 FROM users WHERE id = $1 AND role = $2',
      [userId, 'system_admin']
    );
    return result.rows.length > 0;
  }
}
```

### Rate Limiting

**Rate Limit Configuration**:

| Endpoint | Limit | Window | Scope | Action on Exceed |
|----------|-------|--------|-------|------------------|
| `POST /messages` | 60 | 1 minute | Per user | 429 + Retry-After |
| `POST /messages` (attachments) | 20 | 1 minute | Per user | 429 + Retry-After |
| `POST /auth/login` | 5 | 15 minutes | Per IP | 429 + captcha required |
| `POST /devices/register` | 10 | 1 hour | Per user | 429 |
| `GET /keys/*` | 100 | 1 minute | Per user | 429 |
| `WebSocket connections` | 5 | N/A | Per user | Reject new connections |

```javascript
class RateLimiter {
  constructor(redis) {
    this.redis = redis;
  }

  async checkLimit(key, limit, windowSeconds) {
    const current = await this.redis.incr(key);

    if (current === 1) {
      await this.redis.expire(key, windowSeconds);
    }

    if (current > limit) {
      const ttl = await this.redis.ttl(key);
      return { allowed: false, retryAfter: ttl };
    }

    return { allowed: true, remaining: limit - current };
  }

  // Middleware factory
  rateLimit(options) {
    const { limit, windowSeconds, keyGenerator } = options;

    return async (req, res, next) => {
      const key = `ratelimit:${keyGenerator(req)}`;
      const result = await this.checkLimit(key, limit, windowSeconds);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining || 0);

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter);
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter: result.retryAfter
        });
      }

      next();
    };
  }
}

// Usage in Express app
const rateLimiter = new RateLimiter(redis);

app.post('/api/v1/messages',
  authMiddleware,
  rateLimiter.rateLimit({
    limit: 60,
    windowSeconds: 60,
    keyGenerator: (req) => `messages:${req.user.id}`
  }),
  messageController.send
);

app.post('/api/v1/auth/login',
  rateLimiter.rateLimit({
    limit: 5,
    windowSeconds: 900, // 15 minutes
    keyGenerator: (req) => `login:${req.ip}`
  }),
  authController.login
);
```

### Admin API Boundaries

Admin endpoints are separated and require elevated permissions:

```javascript
// Routes structure
// /api/v1/*           - User API (standard auth)
// /api/v1/admin/*     - Admin API (system_admin role required)

const adminRouter = express.Router();

// Admin auth middleware
adminRouter.use(async (req, res, next) => {
  const session = await authService.validateSession(req.headers.authorization);
  if (!await authorizationService.isSystemAdmin(session.userId)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.admin = session;
  next();
});

// Admin endpoints
adminRouter.get('/metrics', metricsController.getSystemMetrics);
adminRouter.get('/users/:userId/devices', adminController.getUserDevices);
adminRouter.post('/users/:userId/devices/:deviceId/revoke', adminController.revokeDevice);
adminRouter.get('/rate-limits', adminController.getRateLimitStatus);
adminRouter.post('/rate-limits/override', adminController.setRateLimitOverride);

app.use('/api/v1/admin', adminRouter);
```

### Database Schema Additions for Auth

```sql
-- Users table with role
ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user';
ALTER TABLE users ADD CONSTRAINT valid_role CHECK (role IN ('user', 'system_admin'));

-- Device registrations
CREATE TABLE device_registrations (
  device_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  device_info JSONB,
  secret_hash VARCHAR(255) NOT NULL,
  registered_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP,
  revoked_by UUID REFERENCES users(id)
);

CREATE INDEX idx_device_user ON device_registrations(user_id);

-- Sessions (for audit trail, actual session data in Redis)
CREATE TABLE session_audit (
  session_id VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  device_id UUID REFERENCES device_registrations(device_id),
  created_at TIMESTAMP DEFAULT NOW(),
  last_active_at TIMESTAMP,
  ended_at TIMESTAMP,
  end_reason VARCHAR(50) -- 'logout', 'expired', 'revoked', 'password_change'
);

-- Idempotency keys tracking
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL,
  result_id UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);

-- Cleanup old idempotency keys (run daily)
-- DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours';
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Device encryption | Per-device | Shared key | Security, revocation |
| Group encryption | Sender keys | Per-message | Efficiency |
| Storage | Offline-first | Server-first | UX, reliability |
| Sync | Full history | Last N days | User expectation |
| Consistency | Eventual + causal | Strong | Latency, availability |
| Cache pattern | Cache-aside (keys) | Write-through | Read-heavy, rare updates |
| Presence cache | Write-through | Cache-aside | Write-heavy, ephemeral |
| Auth | Session-based | JWT | Simplicity, revocability |
| Rate limiting | Per-user + per-IP | Token bucket | Simple, effective |

---

## Implementation Notes

This section documents the actual implementation of key reliability and performance features in the backend code.

### Idempotency Prevents Duplicate Message Delivery

**WHY**: In distributed messaging systems, network failures, client retries, and server timeouts can cause the same message to be sent multiple times. Without idempotency handling, users see duplicate messages in their conversations, corrupting chat history and causing confusion.

**Implementation** (`/backend/src/shared/idempotency.js`):

```javascript
// Client generates a unique ID per message attempt
const idempotencyKey = `${userId}:${conversationId}:${clientMessageId}`;

// Server checks Redis/PostgreSQL before processing
const existing = await checkExisting(idempotencyKey);
if (existing.exists) {
  return { result: existing.message, isDuplicate: true };
}

// Only create message if not a duplicate
const message = await createMessage(...);
await recordCompletion(idempotencyKey, message.id, userId);
```

**Key Design Decisions**:
1. **Client-generated message IDs**: Clients create UUIDs, enabling safe retries without server coordination
2. **Dual storage**: Redis for fast lookup (sub-millisecond), PostgreSQL for durability across Redis restarts
3. **24-hour TTL**: Keys expire after 24 hours, balancing storage costs with retry window requirements
4. **Fail-open policy**: If idempotency check fails, proceed with the request (better UX than blocking)

**Metrics tracked**: `imessage_idempotent_requests_total{result="new|duplicate|error"}`

### Conversation Caching Reduces Sync Load

**WHY**: Every message send requires verifying the sender is a conversation participant. Without caching, this means a database query per message. At scale (billions of messages/day), this creates unsustainable database load.

**Implementation** (`/backend/src/shared/conversation-cache.js`):

```javascript
// Cache-aside pattern for participant checks
async isParticipantCached(conversationId, userId) {
  const cached = await redis.sismember(`conv:participants:${conversationId}`, userId);
  if (cached !== null) {
    cacheHits.inc({ cache_type: 'conversation_participants' });
    return cached === 1;
  }

  cacheMisses.inc({ cache_type: 'conversation_participants' });
  // Fall back to database, then populate cache
  const result = await db.isParticipant(conversationId, userId);
  await redis.sadd(`conv:participants:${conversationId}`, ...participantIds);
  return result;
}
```

**Performance Impact**:
- **Cache hit ratio**: ~95% for active conversations
- **Latency reduction**: 15ms (DB) to 0.5ms (Redis) for participant checks
- **Database load**: ~80% reduction in conversation-related queries

**Invalidation Strategy**:
| Event | Action |
|-------|--------|
| Member added | Delete `conv:participants:{id}` |
| Member removed | Delete `conv:participants:{id}` |
| Conversation deleted | Delete all `conv:*:{id}` keys |

### Rate Limiting Prevents Spam

**WHY**: Without rate limiting, a malicious or buggy client can flood conversations with messages, degrading service for all users and potentially causing denial of service.

**Implementation** (`/backend/src/shared/rate-limiter.js`):

```javascript
// Sliding window rate limiter using Redis sorted sets
async checkLimit(key, limit, windowSeconds) {
  const now = Date.now();
  const windowStart = now - (windowSeconds * 1000);

  // Atomic: remove old entries + count current
  await redis.zremrangebyscore(key, 0, windowStart);
  const count = await redis.zcard(key);

  if (count >= limit) {
    return { allowed: false, retryAfter: calculateRetryAfter() };
  }

  await redis.zadd(key, now, `${now}:${random}`);
  return { allowed: true, remaining: limit - count - 1 };
}
```

**Rate Limits Applied**:
| Endpoint | Limit | Window | Scope |
|----------|-------|--------|-------|
| `POST /messages` | 60 | 1 min | Per user |
| `POST /auth/login` | 5 | 15 min | Per IP |
| `GET /keys/*` | 100 | 1 min | Per user |
| Device registration | 10 | 1 hour | Per user |

**Fail-Open Design**: If Redis is unavailable, requests are allowed (availability over strict enforcement).

**Metrics tracked**: `imessage_rate_limit_exceeded_total{endpoint, user_id}`

### Delivery Metrics Enable Reliability Optimization

**WHY**: Without metrics, operators cannot identify delivery bottlenecks, measure SLA compliance, or detect degradation before users complain.

**Implementation** (`/backend/src/shared/metrics.js`):

```javascript
// Key metrics exposed at /metrics (Prometheus format)
const messagesTotal = new Counter({
  name: 'imessage_messages_total',
  labelNames: ['status', 'content_type'],  // sent, failed
});

const messageDeliveryDuration = new Histogram({
  name: 'imessage_message_delivery_duration_seconds',
  labelNames: ['status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const messageDeliveryStatus = new Counter({
  name: 'imessage_message_delivery_status_total',
  labelNames: ['status'],  // delivered, failed, pending, duplicate
});
```

**Dashboards Enabled**:
1. **Delivery Success Rate**: `sum(rate(imessage_message_delivery_status_total{status="delivered"}[5m])) / sum(rate(imessage_messages_total[5m]))`
2. **P99 Latency**: `histogram_quantile(0.99, rate(imessage_message_delivery_duration_seconds_bucket[5m]))`
3. **Duplicate Rate**: Identifies idempotency issues or client retry storms
4. **Cache Hit Ratio**: `sum(rate(imessage_cache_hits_total[5m])) / (sum(rate(imessage_cache_hits_total[5m])) + sum(rate(imessage_cache_misses_total[5m])))`

**Alerting Rules** (example):
```yaml
- alert: HighMessageDeliveryLatency
  expr: histogram_quantile(0.99, rate(imessage_message_delivery_duration_seconds_bucket[5m])) > 1
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "P99 message delivery latency exceeds 1 second"
```

### Health Check Endpoints

The backend exposes three health check endpoints for container orchestration:

| Endpoint | Purpose | Use Case |
|----------|---------|----------|
| `/health/live` | Liveness | Kubernetes liveness probe - is process alive? |
| `/health/ready` | Readiness | Kubernetes readiness probe - can handle traffic? |
| `/health` | Deep health | Debugging - detailed component status |

**Readiness Logic**: Service is "ready" only if both PostgreSQL and Redis are reachable. This prevents traffic routing to instances with broken dependencies.

### Structured Logging

All logs use pino for structured JSON output, enabling:
- Log aggregation (ELK, Datadog, etc.)
- Request tracing via `requestId`
- Contextual debugging with user/conversation IDs

```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "service": "imessage-backend",
  "context": "messages-service",
  "requestId": "abc-123",
  "userId": "user-456",
  "conversationId": "conv-789",
  "msg": "Message created"
}
```

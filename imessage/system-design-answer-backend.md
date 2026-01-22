# iMessage - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design iMessage, Apple's end-to-end encrypted messaging platform. As a backend engineer, I'll focus on the cryptographic key management infrastructure, per-device message encryption, efficient group messaging with sender keys, and building a reliable message delivery pipeline with idempotency guarantees.

The core backend challenges are: implementing X3DH key agreement for multi-device encryption, designing sender keys for O(1) group encryption, and building offline-first sync with strong delivery guarantees."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Send Messages**: Encrypted text, photos, videos, and files
- **Multi-Device Sync**: Messages appear on all user's devices
- **Group Chats**: Support for groups with admin controls
- **Offline Support**: Queue messages when offline, deliver when connected
- **Read Receipts**: Delivery and read status tracking

### Non-Functional Requirements
- **Security**: End-to-end encryption where server cannot decrypt messages
- **Latency**: < 500ms message delivery for online recipients
- **Reliability**: Zero message loss guarantee with exactly-once delivery semantics
- **Scale**: Billions of messages daily

### Scale Estimates
- **Users**: 1.5 billion+ active iMessage users
- **Messages/day**: 10+ billion
- **Devices per user**: 3-5 average
- **Group size**: Average 5, max 100+ participants

### Backend-Specific Questions
1. How do we handle prekey exhaustion when all one-time keys are consumed?
2. What's the consistency model for cross-device read receipt sync?
3. How do we handle key rotation for group membership changes?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Devices                              │
│              iPhone │ iPad │ Mac │ Apple Watch                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  API Gateway / Load Balancer                    │
│            (Rate limiting, session validation)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Key Directory  │  │ Message Service │  │   Sync Service  │
│    Service      │  │                 │  │                 │
│ - Device keys   │  │ - Store/route   │  │ - Sync cursors  │
│ - Prekey mgmt   │  │ - Delivery      │  │ - Read state    │
│ - Key rotation  │  │ - Idempotency   │  │ - Device delta  │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
│  PostgreSQL (source of truth) │ Valkey (cache/sessions)         │
│  MinIO (encrypted attachments) │ RabbitMQ (delivery queue)       │
└─────────────────────────────────────────────────────────────────┘
```

### Core Backend Services

1. **Key Directory Service**: Stores and serves public keys for each device
2. **Message Service**: Handles encrypted blob storage and routing
3. **Sync Service**: Manages cross-device synchronization with cursors
4. **Push Service**: WebSocket and APNs for real-time delivery

## Deep Dive: Key Management Service (8 minutes)

The key directory is the foundation of E2E encryption - it stores public keys that clients use to encrypt messages.

### Database Schema for Keys

```sql
-- Device registration and key storage
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100) NOT NULL,
  device_type VARCHAR(50),
  push_token TEXT,
  is_active BOOLEAN DEFAULT true,
  last_active TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user_id ON devices(user_id);

-- Per-device encryption keys (X3DH protocol)
CREATE TABLE device_keys (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  identity_public_key TEXT NOT NULL,  -- ECDSA P-256 identity key
  signing_public_key TEXT NOT NULL,   -- ECDSA P-256 signing key
  created_at TIMESTAMP DEFAULT NOW()
);

-- One-time prekeys for forward secrecy
CREATE TABLE prekeys (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  prekey_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,           -- ECDH P-256 public key
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(device_id, prekey_id)
);

CREATE INDEX idx_prekeys_device_id ON prekeys(device_id);
CREATE INDEX idx_prekeys_unused ON prekeys(device_id) WHERE used = FALSE;
```

### Prekey Management

Each device uploads 100 prekeys. When a sender establishes a session, one prekey is consumed:

```javascript
class PreKeyService {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.lowWatermark = 20;
  }

  async consumePreKey(deviceId) {
    // Atomic fetch-and-mark using FOR UPDATE SKIP LOCKED
    const result = await this.db.query(`
      UPDATE prekeys
      SET used = TRUE
      WHERE id = (
        SELECT id FROM prekeys
        WHERE device_id = $1 AND used = FALSE
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING prekey_id, public_key
    `, [deviceId]);

    if (result.rows.length === 0) {
      // Fallback to identity key (no forward secrecy)
      return { fallback: true };
    }

    // Check if device needs more prekeys
    await this.checkPreKeyCount(deviceId);

    return result.rows[0];
  }

  async checkPreKeyCount(deviceId) {
    const count = await this.db.query(`
      SELECT COUNT(*) FROM prekeys
      WHERE device_id = $1 AND used = FALSE
    `, [deviceId]);

    if (parseInt(count.rows[0].count) < this.lowWatermark) {
      // Notify device to upload more prekeys
      await this.notifyPreKeyRefresh(deviceId);
    }
  }

  async notifyPreKeyRefresh(deviceId) {
    // Push notification to device
    await this.pushService.sendSilent(deviceId, {
      type: 'prekey_refresh',
      count: 100
    });

    // Track for monitoring
    await this.metrics.preKeyRefreshRequested.inc({ device_id: deviceId });
  }
}
```

### Key Caching Strategy

Device keys are read-heavy (every message send) but change rarely:

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
      this.metrics.cacheHits.inc({ cache_type: 'device_keys' });
      return JSON.parse(cached);
    }

    this.metrics.cacheMisses.inc({ cache_type: 'device_keys' });

    // Fetch from database with prekey
    const result = await this.db.query(`
      SELECT
        d.id as device_id,
        dk.identity_public_key,
        dk.signing_public_key,
        (
          SELECT public_key FROM prekeys p
          WHERE p.device_id = d.id AND p.used = FALSE
          ORDER BY p.id LIMIT 1
        ) as prekey
      FROM devices d
      JOIN device_keys dk ON d.id = dk.device_id
      WHERE d.user_id = $1 AND d.is_active = TRUE
    `, [userId]);

    // Cache with TTL
    await this.redis.setex(cacheKey, this.ttlSeconds, JSON.stringify(result.rows));

    return result.rows;
  }

  async invalidate(userId) {
    await this.redis.del(`${this.keyPrefix}${userId}`);
  }
}
```

## Deep Dive: Message Delivery Pipeline (8 minutes)

### Message Storage Schema

```sql
-- Core message storage (encrypted client-side)
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content_type VARCHAR(50) DEFAULT 'text',
  encrypted_content TEXT,             -- E2E encrypted body
  iv TEXT,                            -- AES-GCM initialization vector
  reply_to_id UUID REFERENCES messages(id),
  edited_at TIMESTAMP,
  deleted_at TIMESTAMP,               -- Tombstone for sync
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation_created
  ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_deleted
  ON messages(conversation_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- Per-device encrypted message keys
CREATE TABLE message_keys (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,         -- AES key wrapped with device key
  ephemeral_public_key TEXT NOT NULL,  -- Sender's ephemeral ECDH key
  PRIMARY KEY (message_id, device_id)
);
```

### Idempotent Message Creation

Network failures cause retries. We use client-generated IDs for deduplication:

```javascript
class MessageService {
  async createMessage(senderId, conversationId, content, clientMessageId) {
    const idempotencyKey = `${senderId}:${conversationId}:${clientMessageId}`;

    // Check Redis first (fast path)
    const cached = await this.redis.get(`idempotency:${idempotencyKey}`);
    if (cached) {
      return { messageId: cached, status: 'duplicate' };
    }

    // Check PostgreSQL (durable)
    const existing = await this.db.query(`
      SELECT result_id FROM idempotency_keys WHERE key = $1
    `, [idempotencyKey]);

    if (existing.rows[0]) {
      // Cache for future requests
      await this.redis.setex(
        `idempotency:${idempotencyKey}`,
        86400,
        existing.rows[0].result_id
      );
      return { messageId: existing.rows[0].result_id, status: 'duplicate' };
    }

    // Create message in transaction
    const message = await this.db.transaction(async (tx) => {
      // Insert message
      const msg = await tx.query(`
        INSERT INTO messages (id, conversation_id, sender_id, encrypted_content, iv, content_type)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, created_at
      `, [uuid(), conversationId, senderId, content.encrypted, content.iv, content.type]);

      // Insert per-device keys
      for (const deviceKey of content.deviceKeys) {
        await tx.query(`
          INSERT INTO message_keys (message_id, device_id, encrypted_key, ephemeral_public_key)
          VALUES ($1, $2, $3, $4)
        `, [msg.rows[0].id, deviceKey.deviceId, deviceKey.encryptedKey, deviceKey.ephemeralKey]);
      }

      // Record idempotency key
      await tx.query(`
        INSERT INTO idempotency_keys (key, user_id, result_id, status)
        VALUES ($1, $2, $3, 'completed')
      `, [idempotencyKey, senderId, msg.rows[0].id]);

      return msg.rows[0];
    });

    // Cache idempotency key
    await this.redis.setex(`idempotency:${idempotencyKey}`, 86400, message.id);

    // Queue for delivery
    await this.messageQueue.publish('message.deliver', {
      messageId: message.id,
      conversationId,
      senderId
    });

    return { messageId: message.id, status: 'created' };
  }
}
```

### Delivery Worker

```javascript
class DeliveryWorker {
  async processMessage(job) {
    const { messageId, conversationId, senderId } = job.data;

    // Get recipient devices
    const participants = await this.db.query(`
      SELECT user_id FROM conversation_participants
      WHERE conversation_id = $1 AND left_at IS NULL
    `, [conversationId]);

    for (const participant of participants.rows) {
      // Get all active devices for this user
      const devices = await this.db.query(`
        SELECT id, push_token FROM devices
        WHERE user_id = $1 AND is_active = TRUE
      `, [participant.user_id]);

      for (const device of devices.rows) {
        // Check if message has key for this device
        const hasKey = await this.db.query(`
          SELECT 1 FROM message_keys WHERE message_id = $1 AND device_id = $2
        `, [messageId, device.id]);

        if (!hasKey.rows[0]) {
          continue; // Device registered after message was sent
        }

        // Try WebSocket first
        const delivered = await this.wsManager.deliver(device.id, {
          type: 'message',
          messageId,
          conversationId
        });

        if (!delivered && device.push_token) {
          // Fall back to push notification
          await this.pushService.send(device.push_token, {
            type: 'message',
            messageId,
            conversationId
          });
        }
      }
    }

    // Record delivery attempt
    await this.metrics.messagesDelivered.inc({ status: 'success' });
  }
}
```

## Deep Dive: Sender Keys for Groups (7 minutes)

For groups, encrypting separately for each member is O(N). Sender keys reduce this to O(1):

### Group Schema

```sql
CREATE TABLE group_sender_keys (
  group_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_key BYTEA NOT NULL,           -- Current chain key (ratchets forward)
  chain_index INTEGER DEFAULT 0,      -- Current position in chain
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (group_id, sender_id)
);

-- Per-device distribution of sender keys
CREATE TABLE sender_key_distributions (
  id BIGSERIAL PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  encrypted_sender_key TEXT NOT NULL, -- Encrypted with device's public key
  chain_index INTEGER DEFAULT 0,
  distributed_at TIMESTAMP DEFAULT NOW()
);
```

### Sender Key Distribution

```javascript
class SenderKeyService {
  async distributeOnMemberJoin(groupId, newMemberId) {
    // Get new member's devices
    const newDevices = await this.deviceService.getActiveDevices(newMemberId);

    // Get all existing members' sender keys
    const existingMembers = await this.db.query(`
      SELECT sender_id, chain_key, chain_index
      FROM group_sender_keys
      WHERE group_id = $1
    `, [groupId]);

    // Distribute each existing sender key to new member's devices
    for (const member of existingMembers.rows) {
      for (const device of newDevices) {
        const encryptedKey = await this.encryptForDevice(
          member.chain_key,
          device
        );

        await this.db.query(`
          INSERT INTO sender_key_distributions
          (group_id, from_user_id, to_device_id, encrypted_sender_key, chain_index)
          VALUES ($1, $2, $3, $4, $5)
        `, [groupId, member.sender_id, device.id, encryptedKey, member.chain_index]);
      }
    }

    // Generate sender key for new member
    const newSenderKey = await this.generateSenderKey();
    await this.db.query(`
      INSERT INTO group_sender_keys (group_id, sender_id, chain_key, chain_index)
      VALUES ($1, $2, $3, 0)
    `, [groupId, newMemberId, newSenderKey]);

    // Distribute new member's key to all existing members
    const existingParticipants = await this.getParticipants(groupId);
    for (const participant of existingParticipants) {
      if (participant.user_id === newMemberId) continue;

      const devices = await this.deviceService.getActiveDevices(participant.user_id);
      for (const device of devices) {
        const encryptedKey = await this.encryptForDevice(newSenderKey, device);
        await this.db.query(`
          INSERT INTO sender_key_distributions
          (group_id, from_user_id, to_device_id, encrypted_sender_key, chain_index)
          VALUES ($1, $2, $3, $4, 0)
        `, [groupId, newMemberId, device.id, encryptedKey]);
      }
    }
  }

  async regenerateKeysOnMemberRemove(groupId, removedMemberId) {
    // All remaining members must generate new sender keys
    const remaining = await this.getParticipants(groupId);

    for (const member of remaining) {
      if (member.user_id === removedMemberId) continue;

      // Generate new sender key
      const newKey = await this.generateSenderKey();

      // Update in database
      await this.db.query(`
        UPDATE group_sender_keys
        SET chain_key = $1, chain_index = 0, updated_at = NOW()
        WHERE group_id = $2 AND sender_id = $3
      `, [newKey, groupId, member.user_id]);

      // Redistribute to remaining members (excluding removed)
      for (const otherMember of remaining) {
        if (otherMember.user_id === removedMemberId) continue;
        if (otherMember.user_id === member.user_id) continue;

        const devices = await this.deviceService.getActiveDevices(otherMember.user_id);
        for (const device of devices) {
          await this.distributeSenderKey(groupId, member.user_id, device, newKey);
        }
      }
    }

    // Delete removed member's sender key
    await this.db.query(`
      DELETE FROM group_sender_keys WHERE group_id = $1 AND sender_id = $2
    `, [groupId, removedMemberId]);
  }
}
```

## Deep Dive: Sync Cursors (5 minutes)

### Sync State Schema

```sql
-- Per-device sync progress
CREATE TABLE sync_cursors (
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_synced_message_id UUID REFERENCES messages(id),
  last_synced_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (device_id, conversation_id)
);

-- Read receipt sync (per-user-device-conversation)
CREATE TABLE read_receipts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_message_id UUID REFERENCES messages(id),
  last_read_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id, conversation_id)
);
```

### Delta Sync Endpoint

```javascript
class SyncService {
  async syncConversation(deviceId, conversationId, cursor) {
    // Fetch messages since cursor
    const messages = await this.db.query(`
      SELECT m.id, m.sender_id, m.encrypted_content, m.iv, m.content_type,
             m.created_at, m.deleted_at,
             mk.encrypted_key, mk.ephemeral_public_key
      FROM messages m
      LEFT JOIN message_keys mk ON m.id = mk.message_id AND mk.device_id = $1
      WHERE m.conversation_id = $2
        AND m.created_at > COALESCE(
          (SELECT m2.created_at FROM messages m2 WHERE m2.id = $3),
          '1970-01-01'::timestamp
        )
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [deviceId, conversationId, cursor]);

    // Update sync cursor
    if (messages.rows.length > 0) {
      const lastMessage = messages.rows[messages.rows.length - 1];
      await this.db.query(`
        INSERT INTO sync_cursors (device_id, conversation_id, last_synced_message_id, last_synced_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (device_id, conversation_id) DO UPDATE
        SET last_synced_message_id = EXCLUDED.last_synced_message_id,
            last_synced_at = EXCLUDED.last_synced_at
      `, [deviceId, conversationId, lastMessage.id]);
    }

    // Fetch read receipts from other devices
    const readReceipts = await this.db.query(`
      SELECT user_id, last_read_message_id, last_read_at
      FROM read_receipts
      WHERE conversation_id = $1 AND device_id != $2
    `, [conversationId, deviceId]);

    return {
      messages: messages.rows,
      readReceipts: readReceipts.rows,
      hasMore: messages.rows.length === 100
    };
  }
}
```

## Authentication and Rate Limiting (3 minutes)

### Session-Based Auth

```javascript
class AuthService {
  async validateSession(sessionId) {
    const session = await this.redis.get(`session:${sessionId}`);
    if (!session) {
      throw new AuthError('Session expired');
    }

    const parsed = JSON.parse(session);

    // Sliding expiry
    await this.redis.expire(`session:${sessionId}`, 86400 * 30);

    return parsed;
  }
}
```

### Rate Limiting

```javascript
const rateLimits = {
  'POST /messages': { limit: 60, window: 60, key: (req) => `msg:${req.user.id}` },
  'POST /auth/login': { limit: 5, window: 900, key: (req) => `login:${req.ip}` },
  'GET /keys/*': { limit: 100, window: 60, key: (req) => `keys:${req.user.id}` },
  'POST /devices': { limit: 10, window: 3600, key: (req) => `dev:${req.user.id}` }
};
```

## Trade-offs and Alternatives (5 minutes)

### 1. Per-Device vs. Shared Device Key

| Approach | Pros | Cons |
|----------|------|------|
| **Per-device (chosen)** | Compromise isolated, individual revocation | O(devices) encryption |
| Shared key | Simple, O(1) encryption | One compromise = all compromised |

**Decision**: Per-device. Security is paramount for messaging.

### 2. Sender Keys vs. Per-Message Encryption for Groups

| Approach | Pros | Cons |
|----------|------|------|
| **Sender keys (chosen)** | O(1) per message | Complex key redistribution on member change |
| Per-message | Simple | O(N) per message, doesn't scale |
| MLS | Better large group scaling | More complex protocol |

**Decision**: Sender keys for groups up to 100. Consider MLS for larger.

### 3. Sync Consistency Model

| Approach | Pros | Cons |
|----------|------|------|
| **Eventual + causal (chosen)** | Low latency, high availability | May see temporary inconsistency |
| Strong consistency | Always consistent | Higher latency, lower availability |

**Decision**: Eventual consistency with causal ordering per-conversation.

### 4. Read Receipt Sync

| Approach | Pros | Cons |
|----------|------|------|
| **LWW per device (chosen)** | Simple, no conflicts | May lose rapid updates |
| CRDT | Mergeable | Complex implementation |

**Decision**: Last-write-wins with client timestamps, sufficient for read state.

## Closing Summary (1 minute)

"The iMessage backend is built on three cryptographic and reliability pillars:

1. **Key Directory Service** with per-device encryption using X3DH key agreement, enabling secure multi-device messaging where device compromise is isolated.

2. **Sender Keys for Groups** reducing O(N) encryption to O(1) per message, with automatic key regeneration when members leave.

3. **Idempotent Delivery Pipeline** with client-generated message IDs, dual Redis/PostgreSQL storage, and sync cursors for reliable delta synchronization.

The main trade-off is complexity vs. security. We accept per-device encryption complexity because messaging security cannot be compromised. Future improvements would include MLS for large groups and sealed sender for metadata protection."

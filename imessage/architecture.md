# Design iMessage - Architecture

## System Overview

An encrypted messaging platform with multi-device sync. Core challenges involve E2E encryption across devices, message sync, and offline support. The system must deliver messages reliably at billions-per-day scale while maintaining end-to-end encryption guarantees.

**Learning Goals:**
- Build E2E encrypted messaging
- Design multi-device key management
- Implement message sync protocols
- Handle offline-first messaging

---

## Requirements

### Functional Requirements

1. **Send**: Send encrypted messages to individuals and groups
2. **Sync**: Messages available on all user devices
3. **Groups**: Create and manage group chats with admin controls
4. **Media**: Share photos, videos, files as encrypted attachments
5. **Offline**: Queue messages without connectivity, deliver when online

### Non-Functional Requirements

- **Security**: End-to-end encryption (server cannot read messages)
- **Latency**: < 500ms message delivery for online recipients
- **Reliability**: No message loss, at-least-once delivery with idempotent processing
- **Scale**: Billions of messages daily across hundreds of millions of devices
- **Consistency**: Causal ordering per conversation, eventual delivery across devices

---

## Capacity Estimation

### Production Scale

| Metric | Target |
|--------|--------|
| Daily Active Users | 200M |
| Messages per day | 5 billion |
| Peak messages per second | 100,000 |
| Average devices per user | 2.3 |
| Active conversations per user | 15 |
| Attachment storage | 50PB total |

### Storage Estimates

| Data Type | Size per Record | Volume | Growth |
|-----------|-----------------|--------|--------|
| Message metadata | 500 bytes | 5B/day | Retained 30 days on server |
| Encrypted message body | 1KB avg | 5B/day | Retained until all devices sync |
| Per-device message keys | 256 bytes | 11.5B/day (5B x 2.3 devices) | Same as messages |
| Prekeys | 64 bytes | Replenished as consumed | ~100 per device |
| Attachments | 2MB avg | 500M/day | Indefinite (content-addressed) |

---

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          Client Devices                                    │
│                  iPhone │ iPad │ Mac │ Apple Watch │ Web                   │
│              (Local DB, Key Management, Encryption/Decryption)            │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
          ┌──────────────────┐   ┌──────────────────┐
          │    APNs / FCM    │   │   WebSocket GW   │
          │  (Push Notify)   │   │  (Real-time)     │
          └──────────────────┘   └────────┬─────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                        API Gateway / Load Balancer                         │
└──────┬───────────────┬───────────────┬────────────────────────────────────┘
       │               │               │
       ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Message    │ │     Key      │ │    Sync      │
│   Server     │ │  Directory   │ │   Server     │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │               │               │
       └───────────────┼───────────────┘
                       │
       ┌───────────────┼───────────────┬────────────────┐
       │               │               │                │
       ▼               ▼               ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PostgreSQL  │ │    Redis     │ │  S3 / MinIO  │ │  RabbitMQ    │
│  (Messages,  │ │  (Sessions,  │ │ (Encrypted   │ │  (Delivery   │
│  Keys, Sync) │ │  Presence,   │ │ Attachments) │ │   Queue)     │
│              │ │  Typing)     │ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

### Core Components

1. **Message Server** - Receives encrypted message blobs, persists them, triggers delivery
2. **Key Directory** - Stores per-device public keys and one-time prekeys (X3DH protocol)
3. **Sync Server** - Manages per-device sync cursors, delivers missed messages on reconnect
4. **WebSocket Gateway** - Maintains persistent connections for real-time delivery and typing indicators
5. **Attachment Storage** - Content-addressed storage for encrypted media (immutable, CDN-cacheable)

---

## Core Components

### 1. Key Management (E2E Encryption)

**Multi-Device Key Architecture**: Each device generates its own identity key pair (ECDSA P-256) and a batch of one-time prekeys (ECDH P-256). When sending a message, the sender fetches all recipient device public keys from the Key Directory, generates an ephemeral key pair, performs X3DH key agreement with each device, and encrypts the message key separately for each device. This means a message to a user with 3 devices produces 3 encrypted key copies but only 1 encrypted message body.

**Forward Secrecy**: One-time prekeys are consumed on first use. The server marks them as used and the client generates replacements. If a device's prekey supply drops below 10, the server alerts the client to upload more.

**Key Rotation**: When a device is removed or compromised, all its keys are revoked and group sender keys are rotated to exclude it from future messages.

### 2. Message Encryption

**Per-Device Encryption Flow**:
1. Sender generates a random AES-256-GCM message key
2. Encrypt the message content with the message key
3. For each recipient device: perform X3DH to derive a shared secret, wrap the message key with the derived key
4. Send: encrypted content (1 copy) + encrypted message keys (N copies, one per device)

This O(devices) cost per message is acceptable for direct messages (typically 2-6 devices). For groups, sender keys reduce this to O(1) per message after initial key distribution.

### 3. Group Messaging (Sender Keys)

**Problem**: For a group of 50 members with 2 devices each, encrypting per-device means 100 key copies per message.

**Solution**: Sender Keys (Signal Protocol). Each group member generates a sender key and distributes it (encrypted per-device) to all other members. After initial distribution, group messages are encrypted once with the sender's chain key. Members use the sender's public key to decrypt.

**Member changes**: When a member is added, existing members distribute their sender keys to the new member. When a member is removed, all members rotate their sender keys (the removed member's cached keys become useless).

### 4. Message Sync (Offline-First)

**Sync Cursors**: Each device maintains a per-conversation cursor tracking the last synced message ID. On reconnect, the device requests all messages after its cursor. The server streams missed messages in causal order.

**Conflict Resolution**:
- **Messages**: Append-only. No conflicts possible (each message has a unique ID).
- **Read receipts**: Last-write-wins with timestamp comparison. Multiple devices marking the same conversation as "read" is harmless.
- **Deletion**: Tombstone-based. Deleted messages get a `deleted_at` timestamp that syncs to all devices, which then remove the message locally.

### 5. Offline Support

**Client-side architecture**: Messages are stored in a local database (IndexedDB on web, Core Data on iOS/Mac). Sending a message first writes to local storage with status "pending", then attempts network delivery. If offline, the message is queued and delivered when connectivity returns.

All reads come from the local database, making the UI responsive regardless of network state. Sync happens in the background.

---

## Database Schema

### Complete Schema Overview

The schema is designed around three principles:
1. **Per-device encryption**: Each device has independent keys for security isolation
2. **Forward secrecy**: One-time prekeys prevent retroactive message decryption
3. **Offline-first sync**: Cursors and receipts enable efficient delta synchronization

Full schema: `backend/src/db/init.sql`

### Entity-Relationship Diagram

```
                                    ┌──────────────────┐
                                    │      users       │
                                    ├──────────────────┤
                                    │ id (PK)          │
                                    │ username         │
                                    │ email            │
                                    │ password_hash    │
                                    │ display_name     │
                                    │ avatar_url       │
                                    │ status           │
                                    │ role             │
                                    │ last_seen        │
                                    └────────┬─────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │ 1:N                    │ 1:N                    │ M:N
                    ▼                        ▼                        ▼
         ┌──────────────────┐    ┌──────────────────┐    ┌───────────────────────────┐
         │     devices      │    │    sessions      │    │ conversation_participants │
         ├──────────────────┤    ├──────────────────┤    ├───────────────────────────┤
         │ id (PK)          │    │ id (PK)          │    │ conversation_id (PK,FK)   │
         │ user_id (FK)     │    │ user_id (FK)     │    │ user_id (PK,FK)           │
         │ device_name      │    │ device_id (FK)   │    │ role                      │
         │ device_type      │    │ token            │    │ joined_at / left_at       │
         │ push_token       │    │ expires_at       │    │ muted                     │
         │ is_active        │    └──────────────────┘    └─────────────┬─────────────┘
         │ last_active      │                                          │
         └────────┬─────────┘                                          │
                  │                                                    │
    ┌─────────────┼─────────────┐                                      │
    │ 1:1         │ 1:N         │                                      ▼
    ▼             ▼             │                           ┌──────────────────┐
┌─────────────┐ ┌─────────────┐ │                           │  conversations   │
│ device_keys │ │   prekeys   │ │                           ├──────────────────┤
├─────────────┤ ├─────────────┤ │                           │ id (PK)          │
│ device_id   │ │ id (PK)     │ │                           │ type (direct/    │
│ (PK,FK)     │ │ device_id   │ │                           │        group)    │
│ identity_   │ │ (FK)        │ │                           │ name             │
│ public_key  │ │ prekey_id   │ │                           │ created_by (FK)  │
│ signing_    │ │ public_key  │ │                           └────────┬─────────┘
│ public_key  │ │ used        │ │                                    │ 1:N
└─────────────┘ └─────────────┘ │                                    ▼
                                │              ┌──────────────────────────────────┐
                                │              │           messages               │
                                │              ├──────────────────────────────────┤
                                │              │ id (PK)                          │
                                │              │ conversation_id (FK)             │
                                │              │ sender_id (FK)                   │
                                │              │ content / encrypted_content      │
                                │              │ content_type                     │
                                │              │ iv                               │
                                │              │ reply_to_id (FK, self)           │
                                │              │ edited_at / deleted_at           │
                                │              └────────┬────────────────────────┘
                                │                       │
                                │      ┌────────────────┼────────────────┐
                                │      │ 1:N            │ 1:N            │ 1:N
                                │      ▼                ▼                ▼
                                │ ┌────────────┐ ┌──────────────┐ ┌───────────┐
                                │ │attachments │ │ message_keys │ │ reactions │
                                │ ├────────────┤ ├──────────────┤ ├───────────┤
                                │ │ id (PK)    │ │ message_id   │ │ id (PK)   │
                                │ │ message_id │ │ (PK,FK)      │ │message_id │
                                │ │ file_name  │ │ device_id    │ │ user_id   │
                                │ │ file_type  │ │ (PK,FK)      │ │ reaction  │
                                │ │ file_url   │ │encrypted_key │ │ UNIQUE    │
                                │ │ thumbnail  │ │ephemeral_    │ │(msg,usr,  │
                                │ │ width/     │ │public_key    │ │ reaction) │
                                │ │ height     │ └──────────────┘ └───────────┘
                                │ └────────────┘
                                │
                                ▼
                 ┌──────────────────────────────────────────────┐
                 │            SYNC & DELIVERY TABLES            │
                 └──────────────────────────────────────────────┘

┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│    read_receipts     │  │  delivery_receipts   │  │    sync_cursors      │
├──────────────────────┤  ├──────────────────────┤  ├──────────────────────┤
│ user_id (PK,FK)      │  │ message_id (PK,FK)   │  │ device_id (PK,FK)    │
│ device_id (PK,FK)    │  │ device_id (PK,FK)    │  │ conversation_id      │
│ conversation_id      │  │ delivered_at         │  │ (PK,FK)              │
│ (PK,FK)              │  └──────────────────────┘  │ last_synced_         │
│ last_read_message_id │                            │ message_id (FK)      │
│ last_read_at         │                            │ last_synced_at       │
└──────────────────────┘                            └──────────────────────┘

┌──────────────────────┐
│   idempotency_keys   │
├──────────────────────┤
│ key (PK)             │
│ user_id (FK)         │
│ result_id            │
│ status               │
│ created_at           │
└──────────────────────┘
```

### Key Tables and Indexes

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  status VARCHAR(20) DEFAULT 'offline',
  role VARCHAR(20) DEFAULT 'user',
  last_seen TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_role CHECK (role IN ('user', 'system_admin'))
);

-- Devices (multi-device support)
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

-- Device Keys (E2E encryption keys per device)
CREATE TABLE device_keys (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  identity_public_key TEXT NOT NULL,
  signing_public_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Prekeys (one-time keys for forward secrecy)
CREATE TABLE prekeys (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  prekey_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_prekeys_unused ON prekeys(device_id, used) WHERE NOT used;

-- Conversations
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL CHECK (type IN ('direct', 'group')),
  name VARCHAR(200),
  avatar_url TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Conversation Participants
CREATE TABLE conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at TIMESTAMP DEFAULT NOW(),
  left_at TIMESTAMP,
  muted BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_participants_active ON conversation_participants(conversation_id)
  WHERE left_at IS NULL;

-- Messages
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content TEXT,
  content_type VARCHAR(50) DEFAULT 'text'
    CHECK (content_type IN ('text', 'image', 'video', 'file', 'system')),
  encrypted_content TEXT,
  iv TEXT,
  reply_to_id UUID REFERENCES messages(id),
  edited_at TIMESTAMP,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_deleted ON messages(conversation_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- Per-device encrypted message keys
CREATE TABLE message_keys (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,
  ephemeral_public_key TEXT NOT NULL,
  PRIMARY KEY (message_id, device_id)
);

-- Attachments, reactions, read/delivery receipts, sync cursors
-- (See backend/src/db/init.sql for complete schema)

-- Idempotency keys for duplicate message prevention
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result_id UUID,
  status VARCHAR(50) DEFAULT 'completed'
    CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMP DEFAULT NOW()
);
```

## API Design

### Authentication
```
POST /api/auth/register         # Create account
POST /api/auth/login            # Login, returns session token
POST /api/auth/logout           # Invalidate session
GET  /api/auth/me               # Get current user
```

### Conversations
```
GET    /api/conversations                  # List conversations
POST   /api/conversations                  # Create conversation (direct or group)
GET    /api/conversations/:id              # Get conversation details
PUT    /api/conversations/:id              # Update group name/avatar
POST   /api/conversations/:id/participants # Add members
DELETE /api/conversations/:id/participants/:userId  # Remove member
```

### Messages
```
GET  /api/messages/:conversationId         # Get messages (paginated)
POST /api/messages/:conversationId         # Send message
PUT  /api/messages/:id                     # Edit message
DELETE /api/messages/:id                   # Soft-delete message
POST /api/messages/:id/reactions           # Add reaction
```

### Users
```
GET  /api/users/search?q=username          # Search users
GET  /api/users/:id                        # Get user profile
PUT  /api/users/profile                    # Update own profile
```

### WebSocket Events
```
auth                # Authenticate WS connection
message:new         # New message (server -> client)
message:delivered   # Delivery receipt
message:read        # Read receipt
typing:start        # Typing indicator start
typing:stop         # Typing indicator stop
presence:update     # Online/offline status change
```

## Key Design Decisions

### Per-Device Encryption vs Shared Key

**Problem**: A user with an iPhone and a Mac needs both devices to decrypt messages.

**Chose per-device encryption**: Each device has its own key pair. The sender encrypts the message key separately for each recipient device. If a device is compromised or lost, only that device's keys are revoked -- other devices continue working without re-keying.

**Why not a shared key?** A shared key across devices means compromising any one device compromises all messages. It also makes device revocation impossible without invalidating all devices and re-distributing keys. Per-device encryption costs O(devices) encryption operations per message, but typical users have 2-3 devices, making this trivially affordable.

**Trade-off**: The server stores N encrypted key copies per message (one per recipient device). For a direct message to a user with 3 devices, that is 3x256 bytes = 768 bytes overhead. At 5B messages/day, this adds ~4TB/day of key storage -- significant but manageable with retention policies.

### Sender Keys for Groups vs Per-Device Group Encryption

**Problem**: A group of 50 members with 2 devices each would require 100 encrypted key copies per message with per-device encryption.

**Chose sender keys** (Signal Protocol approach): Each member distributes a sender key to all other members (one-time, per-device encrypted). After distribution, group messages are encrypted once with the sender's chain key. This reduces per-message cost from O(members x devices) to O(1).

**Trade-off**: When a member is removed, all remaining members must rotate their sender keys and redistribute them. For a 50-person group, removal triggers 49 key rotations x ~100 device-encrypted distributions = ~4,900 encrypted key messages. This is a burst of work but happens infrequently compared to the message volume savings.

### Eventual Consistency with Causal Ordering

**Problem**: Messages must appear in order per conversation, but global ordering across all conversations is unnecessary and expensive.

**Chose causal ordering per conversation**: Messages from a single sender arrive in order within a conversation (enforced by sequential IDs). Cross-conversation ordering is not guaranteed.

**Why not strong consistency?** Strong consistency (e.g., linearizable writes with Raft) would require all message writes to go through a single leader per conversation, adding latency and reducing availability during leader elections. For messaging, users tolerate messages arriving 1-2 seconds apart across devices. They do not tolerate messages appearing out of order within a conversation.

**Trade-off**: Two devices viewing the same conversation may briefly show different message sets (one device synced, the other hasn't yet). This resolves within seconds and is indistinguishable from network delay.

### Offline-First with Local Database

**Chose offline-first architecture**: All reads come from the local database. Writes go to local storage first, then sync to the server. This makes the app responsive regardless of network state and eliminates "loading" spinners for conversation history.

**Trade-off**: Requires a robust sync protocol with cursor tracking, conflict resolution (last-write-wins for metadata), and tombstone-based deletion. The implementation complexity is higher than server-first, but the UX improvement is substantial -- messaging apps are expected to "just work" without connectivity.

## Consistency and Idempotency

### Idempotency Key Strategy

| Operation | Idempotency Key | TTL | Scope |
|-----------|-----------------|-----|-------|
| Send message | `{userId}:{conversationId}:{clientMessageId}` | 24 hours | Per user |
| Delivery receipt | `{messageId}:{deviceId}:delivered` | 7 days | Per device |
| Read receipt | `{userId}:{conversationId}:{lastReadMessageId}` | 7 days | Per user |
| Device registration | `{userId}:{deviceFingerprint}` | Permanent | Per user |

Client-generated message IDs enable safe retries: if a message send times out, the client retries with the same idempotency key. The server returns the existing message rather than creating a duplicate.

### Conflict Resolution

- **Messages**: Append-only. Each message has a unique UUID. No update conflicts.
- **Read receipts**: Last-write-wins based on client timestamp. Race condition where two devices mark the same conversation as "read" simultaneously is harmless (both advance the cursor).
- **Deletion**: Tombstone-based. `deleted_at` timestamp syncs to all devices. No un-delete.

## Caching Strategy

### Cache by Data Type

| Data Type | Cache Location | Pattern | TTL | Invalidation |
|-----------|----------------|---------|-----|--------------|
| Device public keys | Redis | Cache-aside | 1 hour | On key rotation, device removal |
| Prekeys (one-time) | None | Direct DB | N/A | Consumed on use |
| Session tokens | Redis | Write-through | 24 hours | On logout, password change |
| User presence | Redis | Write-through | 30 seconds | Heartbeat refresh |
| Typing indicators | Redis | Write-through | 5 seconds | Auto-expire |
| Conversation participants | Redis | Cache-aside | 10 minutes | On membership change |
| Encrypted attachments | CDN/MinIO | Immutable | 30 days | Content-addressed, never invalidated |

### Participant Cache Rationale

Every message send requires verifying the sender is a conversation participant. Without caching, this is a database query per message. At 100K messages/second, caching participant sets in Redis reduces database load by ~80% and cuts participant-check latency from 15ms to 0.5ms.

## Security

### Authentication

**Session-based with Redis**: User submits credentials, server validates bcrypt hash, generates a random 256-bit session token, stores it in Redis with 30-day TTL. Sliding expiry refreshes TTL on each request.

**Device authentication** (for E2E encryption): Devices register separately with a device-specific secret. This binds encryption keys to authenticated devices and enables per-device session revocation.

### Authorization (RBAC)

| Role | Scope | Permissions |
|------|-------|-------------|
| `user` | Own data | Send/receive messages, manage own devices, create groups |
| `group_admin` | Group | Add/remove members, change group settings, delete messages |
| `group_member` | Group | Send/receive messages, leave group |
| `system_admin` | Global | View metrics, manage rate limits, revoke devices |

### Rate Limiting

| Endpoint | Limit | Window | Scope |
|----------|-------|--------|-------|
| `POST /messages` | 60 | 1 minute | Per user |
| `POST /messages` (attachments) | 20 | 1 minute | Per user |
| `POST /auth/login` | 5 | 15 minutes | Per IP |
| `POST /devices/register` | 10 | 1 hour | Per user |
| WebSocket connections | 5 | N/A | Per user |

Sliding window counters in Redis. Fail-open design: if Redis is unavailable, requests are allowed (availability over strict enforcement).

## Observability

### Metrics (Prometheus)

```
# Message delivery
imessage_messages_total{status, content_type}
imessage_message_delivery_duration_seconds{status}
imessage_message_delivery_status_total{status}

# Idempotency
imessage_idempotent_requests_total{result="new|duplicate|error"}

# Cache
imessage_cache_hits_total{cache_type}
imessage_cache_misses_total{cache_type}

# WebSocket
imessage_websocket_connections_active
imessage_websocket_messages_total{direction="inbound|outbound"}

# Rate limiting
imessage_rate_limit_exceeded_total{endpoint}
```

### Health Checks

| Endpoint | Purpose | Use Case |
|----------|---------|----------|
| `/health/live` | Liveness | Is process alive? |
| `/health/ready` | Readiness | Can handle traffic? (checks PG + Redis) |
| `/health` | Deep health | Detailed component status for debugging |

### Structured Logging

Pino JSON output with request IDs, user/conversation context, and latency tracking. Sensitive data (message content, tokens) is never logged.

## Failure Handling

- **Redis down**: Sessions fall back to PostgreSQL lookup. Presence and typing indicators unavailable. Rate limiting fails-open.
- **PostgreSQL down**: Service returns 503. Messages queued on client for retry.
- **WebSocket disconnect**: Client auto-reconnects with exponential backoff. Missed messages fetched via REST sync endpoint on reconnect.
- **Prekey exhaustion**: If a device has no unused prekeys, the server falls back to the signed prekey (less forward secrecy but still secure). Server alerts client to generate more prekeys.

## Scalability Considerations

### Horizontal Scaling Path

| Component | Strategy | Trigger |
|-----------|----------|---------|
| Message servers | Stateless behind LB | CPU > 70%, RPS > threshold |
| PostgreSQL | Shard by conversation_id | Writes > 50K/s |
| Redis | Cluster mode (16K slots) | Memory > 80% |
| WebSocket GW | Per-user sticky sessions, Redis Pub/Sub bridges | Connections > 10K/server |
| Attachment storage | S3 with CDN | Storage > 1PB |

### Database Sharding

Shard PostgreSQL by `conversation_id`. All messages, participants, and receipts for a conversation live on the same shard, keeping most queries single-shard. Cross-shard queries (e.g., "list all conversations for user X") use a lightweight conversation-membership index.

### Message Fanout

For groups with many members across many devices, message delivery uses a two-phase approach:
1. **Write phase**: Persist encrypted message to the conversation shard
2. **Fanout phase**: RabbitMQ distributes delivery tasks to per-device workers. Each worker pushes via WebSocket (if connected) or queues for sync (if offline).

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Device encryption | Per-device | Shared key | Security isolation, device revocation |
| Group encryption | Sender keys | Per-message per-device | O(1) vs O(n*d) per message |
| Storage pattern | Offline-first | Server-first | UX, reliability, works without network |
| Sync strategy | Full history | Last N days | User expectation for messaging apps |
| Consistency | Eventual + causal | Strong (linearizable) | Latency, availability, sufficient for chat |
| Cache (keys) | Cache-aside | Write-through | Read-heavy, rare updates |
| Cache (presence) | Write-through | Cache-aside | Write-heavy, ephemeral data |
| Auth | Session-based | JWT | Simplicity, immediate revocability |

---

## Implementation Notes

This section documents the actual local setup, what production patterns are implemented, what was simplified, and what was omitted.

### Implementation Status

**Implemented (Phase 1 - Basic Messaging):**
- Real-time direct messaging via WebSocket
- Message persistence in PostgreSQL
- Delivery receipts and read receipts
- Typing indicators
- User presence (online/offline)
- Basic conversation management (direct and group)

**Not yet implemented:**
- E2E encryption (X3DH + Double Ratchet)
- Multi-device sync with cursors
- Sender keys for group encryption
- Offline-first client with IndexedDB
- Attachment upload/download

### Local Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    React Frontend                         │
│           (Vite dev server, localhost:5173)               │
│  ConversationList, ChatView, MessageBubble, AuthForm     │
└─────────────────────────┬────────────────────────────────┘
                          │ HTTP + WebSocket (ws://localhost:3000/ws)
                          ▼
┌──────────────────────────────────────────────────────────┐
│       Express API + WebSocket Server (localhost:3000)      │
│              (or 3001/3002/3003 for multi-instance)       │
└────┬──────────┬──────────────────────────────────────────┘
     │          │
     ▼          ▼
┌─────────┐ ┌────────┐
│PostgreSQL│ │ Valkey │
│  :5432  │ │ :6379  │
└─────────┘ └────────┘
```

All infrastructure runs via `docker-compose up -d` (PostgreSQL 16 + Valkey 7).

### Production Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Idempotency keys | Redis + PostgreSQL dual-store deduplication | `backend/src/shared/idempotency.ts` |
| Conversation caching | Redis Sets for participant membership checks | `backend/src/shared/conversation-cache.ts` |
| Rate limiting | Sliding window counters (Redis sorted sets) | `backend/src/shared/rate-limiter.ts` |
| Structured logging | Pino JSON output with request context | `backend/src/shared/logger.ts` |
| Prometheus metrics | prom-client: message counts, delivery latency, cache hits | `backend/src/shared/metrics.ts` |
| Health checks | Liveness, readiness (PG + Redis), deep health | `backend/src/shared/health.ts` |
| WebSocket messaging | ws library with Redis Pub/Sub for cross-server | `backend/src/services/websocket.ts` |
| Session auth | Token-based sessions with Redis + PostgreSQL | `backend/src/middleware/auth.ts` |
| Conversation management | Direct and group conversations with RBAC | `backend/src/services/conversations.ts` |
| Delivery/read receipts | WebSocket events with PostgreSQL persistence | `backend/src/services/messages.ts` |
| Typing indicators | WebSocket broadcast with auto-expiry | `backend/src/services/websocket.ts` |
| Graceful shutdown | SIGTERM handler closes HTTP, WS, and Redis | `backend/src/index.ts` |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Why |
|-------------------|-----------------|-----|
| E2E encryption (Signal Protocol) | Plaintext messages stored in PostgreSQL | Encryption not yet implemented (Phase 3) |
| Multi-device sync with cursors | Single-device per user | Sync protocol not yet implemented (Phase 2) |
| APNs / FCM push | WebSocket-only delivery | No mobile app, no push infrastructure |
| S3 + CDN for attachments | No attachment support yet | Phase 3+ feature |
| RabbitMQ for delivery fanout | Direct WebSocket delivery | Single-server sufficient |
| PostgreSQL sharding | Single PostgreSQL instance | Dev-scale data volume |
| Redis Cluster | Single Valkey instance | < 100MB data |
| OAuth / Apple ID login | Cookie-based token auth | Simpler for development |
| IndexedDB offline storage | Server-first (no local DB) | Offline-first not yet implemented |
| Grafana dashboards | Prometheus `/metrics` endpoint only | Metrics exposed, no visualization |

### What Was Omitted

- End-to-end encryption (X3DH key agreement, Double Ratchet)
- Per-device key management and prekey rotation
- Sender keys for efficient group encryption
- Multi-device message sync with cursors and conflict resolution
- Offline-first client with IndexedDB/Core Data
- Attachment upload/download (encrypted media)
- Push notifications (APNs, FCM)
- CDN for attachment delivery
- Database sharding by conversation_id
- Message queue (RabbitMQ) for delivery fanout
- Kubernetes / container orchestration
- Distributed tracing (OpenTelemetry)
- Circuit breakers around database/cache calls
- Photo/video preview generation
- Message search (full-text)
- Link previews

---

*Architecture document for a local development learning project. The encryption and multi-device sync components described in the production architecture represent the target design; the current implementation focuses on the real-time messaging foundation.*

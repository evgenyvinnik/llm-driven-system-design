# WhatsApp - Messaging Platform - Architecture Design

## System Overview

A real-time messaging platform supporting one-on-one messaging, group chats, media sharing, presence indicators, and end-to-end encryption. This document describes two layers: the **production-ready architecture** for 2B+ users and the **pocket-size local implementation** built with Docker, Node.js, and React.

## Requirements

### Functional Requirements

1. **One-on-One Messaging** — Send text messages between two users with delivery receipts (sent, delivered, read) and typing indicators
2. **Group Chats** — Create groups with up to 1,024 members, admin controls, group metadata management
3. **Media Sharing** — Send images, videos, and documents with thumbnail generation and progressive download
4. **Offline Message Delivery** — Queue messages when recipient is offline, deliver on reconnect with ordering guarantees
5. **End-to-End Encryption** — Signal Protocol for 1:1 chats, Sender Key for groups; server never sees plaintext
6. **Voice/Video Calls** — WebRTC-based calling with TURN/STUN servers and call signaling
7. **Status/Stories** — Ephemeral content with 24-hour TTL and view tracking
8. **Presence** — Online/offline status, last seen timestamps, privacy controls
9. **Backup** — Encrypted backup to cloud storage, chat export

### Non-Functional Requirements

| Requirement | Production Target | Notes |
|-------------|-------------------|-------|
| **Latency** | < 100ms message delivery (p99) | Measured from send to delivery ACK |
| **Availability** | 99.99% | Multi-region active-active |
| **Throughput** | 100B+ messages/day | ~1.2M messages/sec sustained |
| **Concurrent Users** | 500M+ simultaneous connections | Across global data centers |
| **Message Ordering** | Per-conversation causal order | Vector clocks + sequence numbers |
| **Durability** | At-least-once delivery, exactly-once processing | Idempotent writes + deduplication |
| **Encryption** | End-to-end by default | Server stores only ciphertext |

---

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| **Daily Active Users** | 2B | Monthly: 2.5B |
| **Messages per Day** | 100B | ~50 msgs/user/day average |
| **Peak Messages/sec** | ~3M | 2.5x average sustained rate |
| **Concurrent Connections** | 500M | ~25% of DAU simultaneously online |
| **Message Size** | ~500 bytes avg | Text; media stored separately |
| **Storage Growth** | ~50 TB/day (messages) | 100B × 500 bytes |
| **Media Storage Growth** | ~500 TB/day | Images, videos, documents |
| **Connection Servers** | ~10,000 | 50K connections per server |

### Connection Server Sizing

Each connection server handles ~50,000 persistent WebSocket connections. With 500M concurrent users:
- 500M / 50K = 10,000 connection servers globally
- Distributed across 5+ regions with geographic routing
- Each server: 64GB RAM, 16 cores, 10Gbps NIC

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    Client Layer                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ iOS App      │  │ Android App  │  │ Web Client   │  │ Desktop App  │                 │
│  │ (E2E enc.)   │  │ (E2E enc.)   │  │ (E2E enc.)   │  │ (E2E enc.)   │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                 │
└─────────┼──────────────────┼──────────────────┼──────────────────┼───────────────────────┘
          │                  │                  │                  │
          ▼                  ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              Edge / DNS Layer                                            │
│  ┌────────────────────────┐     ┌────────────────────────┐                               │
│  │ Anycast DNS + GeoDNS   │────▶│ CDN (media download)   │                               │
│  └────────────┬───────────┘     └────────────────────────┘                               │
└───────────────┼─────────────────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                            Connection Gateway Layer                                      │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐                  │
│  │ Connection Server 1│  │ Connection Server 2│  │ Connection Server N│                  │
│  │ (50K WebSockets)   │  │ (50K WebSockets)   │  │ (50K WebSockets)   │                  │
│  │                    │  │                    │  │                    │                  │
│  │ ┌──────────────┐   │  │ ┌──────────────┐   │  │ ┌──────────────┐   │                  │
│  │ │ Session Mgr  │   │  │ │ Session Mgr  │   │  │ │ Session Mgr  │   │                  │
│  │ │ Heartbeat    │   │  │ │ Heartbeat    │   │  │ │ Heartbeat    │   │                  │
│  │ │ Rate Limiter │   │  │ │ Rate Limiter │   │  │ │ Rate Limiter │   │                  │
│  │ └──────────────┘   │  │ └──────────────┘   │  │ └──────────────┘   │                  │
│  └─────────┬──────────┘  └─────────┬──────────┘  └─────────┬──────────┘                  │
└────────────┼───────────────────────┼───────────────────────┼────────────────────────────┘
             │                       │                       │
             └───────────────────────┼───────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                             Message Routing Layer                                        │
│                                                                                          │
│  ┌────────────────────────────┐     ┌────────────────────────────┐                       │
│  │ Message Router Service     │     │ User Session Registry      │                       │
│  │ (routes msgs to correct   │────▶│ (Redis Cluster: user_id    │                       │
│  │  connection server)        │     │  → connection_server_id)   │                       │
│  └────────────┬───────────────┘     └────────────────────────────┘                       │
│               │                                                                          │
│  ┌────────────▼───────────────┐     ┌────────────────────────────┐                       │
│  │ Kafka / Message Queue      │     │ Offline Message Store      │                       │
│  │ (durable message routing)  │     │ (queue for offline users)  │                       │
│  └────────────────────────────┘     └────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              Storage Layer                                               │
│                                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐    │
│  │ Cassandra        │  │ PostgreSQL      │  │ Redis Cluster   │  │ S3 / Blob Store │    │
│  │ (messages,       │  │ (accounts,      │  │ (sessions,      │  │ (encrypted      │    │
│  │  partitioned     │  │  contacts,      │  │  presence,      │  │  media, thumbs, │    │
│  │  by user_id)     │  │  groups,        │  │  pub/sub,       │  │  backups)       │    │
│  │                  │  │  encryption     │  │  typing,        │  │                 │    │
│  │                  │  │  keys)          │  │  rate limits)   │  │                 │    │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### Connection Servers

Connection servers maintain millions of persistent WebSocket connections and act as the gateway between clients and backend services. Each server:

- Manages up to 50K concurrent WebSocket connections with epoll/kqueue
- Performs session authentication on connection upgrade (validates session cookie against Redis)
- Runs heartbeat pings every 30 seconds to detect stale connections
- Registers each user's connection in the User Session Registry (Redis: `user_id → server_id`)
- On disconnect, updates presence to offline and broadcasts to relevant users
- Applies per-user rate limiting (sliding window via Redis sorted sets) to prevent spam

At production scale, connection servers are stateless except for in-memory connection maps. They can be replaced without data loss — clients reconnect with exponential backoff and re-authenticate.

### Message Routing

When a user sends a message:

1. **Connection server** receives the WebSocket message
2. **Authorization check** — verify sender is a conversation participant (database query)
3. **Persist to Cassandra** — write message to the sender's and all recipients' message partitions
4. **Lookup recipients** — for each recipient, query the User Session Registry for their connection server
5. **Route to online recipients** — publish message to the recipient's connection server (Kafka or Redis pub/sub)
6. **Queue for offline recipients** — store in the offline message queue; deliver on next connect
7. **ACK to sender** — send `message_ack` with server-assigned message ID and timestamp

For **group messages**, the fan-out happens at the routing layer: the message is written once, then individually routed to each participant's connection server. Groups with 1,024 members fan out to up to 1,024 connection servers.

### Message Delivery Flow (Online-to-Online)

```
┌────────┐    ┌────────────┐    ┌───────────┐    ┌────────────┐    ┌────────────┐
│ Sender │    │ Conn Srv A │    │ Msg Router│    │ Conn Srv B │    │ Recipient  │
└───┬────┘    └─────┬──────┘    └─────┬─────┘    └─────┬──────┘    └─────┬──────┘
    │               │                 │                │                  │
    │─ WS: message ▶│                 │                │                  │
    │               │─ persist ──────▶│                │                  │
    │               │  (Cassandra)    │                │                  │
    │               │◀── ack ─────────│                │                  │
    │◀─ message_ack─│                 │                │                  │
    │               │                 │─ route msg ───▶│                  │
    │               │                 │                │─ WS: message ───▶│
    │               │                 │                │◀── delivery_ack ─│
    │◀─ delivered ──│◀── receipt ─────│◀───────────────│                  │
```

### Message Delivery Flow (Recipient Offline)

```
┌────────┐    ┌────────────┐    ┌───────────┐    ┌──────────────┐
│ Sender │    │ Conn Srv   │    │ Msg Router│    │ Offline Store│
└───┬────┘    └─────┬──────┘    └─────┬─────┘    └──────┬───────┘
    │               │                 │                  │
    │─ WS: message ▶│                 │                  │
    │               │─ persist ──────▶│                  │
    │               │◀── ack ─────────│                  │
    │◀─ message_ack─│                 │                  │
    │  (status:sent)│                 │─ queue message ─▶│
    │               │                 │  (user offline)  │
    │               │                 │                  │
    │ ... later, recipient connects ...                  │
    │               │                 │◀── drain queue ──│
    │               │                 │─── deliver all ─▶│ ──▶ Recipient
    │◀── delivered ─│◀── receipts ────│                  │
```

### End-to-End Encryption

WhatsApp uses the Signal Protocol for end-to-end encryption. The server never has access to plaintext message content.

**Key Exchange (1:1 chats):**
1. Each device generates a long-term identity key pair and a set of pre-keys (ephemeral public keys) at registration
2. Pre-keys are uploaded to the server's key distribution service (PostgreSQL)
3. When Alice wants to message Bob for the first time, she fetches Bob's pre-key bundle from the server
4. Alice performs an X3DH (Extended Triple Diffie-Hellman) key agreement to establish a shared secret
5. All subsequent messages use the Double Ratchet algorithm — each message uses a unique message key derived from the ratchet, providing forward secrecy
6. If Alice's device is compromised, past messages cannot be decrypted (forward secrecy); future messages are protected after the next ratchet step (break-in recovery)

**Group Encryption (Sender Key):**
1. Each group member generates a Sender Key — a symmetric key distributed to all other group members via pairwise encrypted channels
2. When sending a group message, the sender encrypts once with their Sender Key
3. All recipients decrypt with the sender's Sender Key (O(1) encryption instead of O(N))
4. When a member leaves, all remaining members rotate their Sender Keys
5. Trade-off: Sender Key is more efficient than pairwise encryption for groups but requires re-keying on membership changes. For groups of 1,024, pairwise would require 1,024 separate encryptions per message, which is prohibitively expensive

**Key Storage:**
- The server stores only public pre-keys and signed pre-keys — never private keys
- Private keys live exclusively on user devices in a secure enclave (iOS Keychain / Android Keystore)
- Message ciphertext is stored in Cassandra alongside metadata (timestamp, sender, status)

### Media Handling

Media follows a separate path from text messages to avoid congestion in the messaging pipeline:

1. **Client encrypts media** locally using a random AES-256 key
2. **Upload** encrypted blob to object storage (S3) via a resumable upload API
3. Server generates a **thumbnail** from the encrypted media (for images/videos) and stores it alongside the original
4. Client sends a **text message** containing the media URL + AES key + SHA-256 hash (all encrypted end-to-end)
5. Recipient downloads the encrypted media from S3/CDN, decrypts locally
6. **Progressive download** for large videos — client requests byte ranges for streaming playback

Trade-off: Separating media from the message pipeline keeps the messaging path fast (sub-100ms for text) while media uploads/downloads happen asynchronously. The cost is added complexity in correlating media with messages and ensuring the AES key is delivered reliably.

### Voice/Video Calls

Call signaling happens through the messaging infrastructure; media streams use WebRTC:

1. **Caller** sends a call signaling message (SDP offer) via the existing WebSocket connection
2. **Connection server** routes the signal to the callee's connection server
3. **Callee** responds with SDP answer via the same path
4. **ICE negotiation** — clients exchange ICE candidates to find the best network path
5. **Media flows peer-to-peer** via STUN (direct path) or through **TURN servers** when NAT traversal fails
6. TURN servers are deployed at edge locations globally for low-latency relay
7. End-to-end encryption via SRTP with keys negotiated through DTLS

Group calls use an SFU (Selective Forwarding Unit) — each participant sends one stream to the SFU, which selectively forwards streams to other participants based on their layout and bandwidth.

### Status/Stories

Ephemeral content shared with contacts, automatically deleted after 24 hours:

1. User uploads a status (image, video, or text) — encrypted and stored in S3 with a 24-hour TTL
2. Server creates a status metadata record in Cassandra with `TTL 86400`
3. Contacts are notified via a lightweight push through the WebSocket connection
4. When a contact views the status, a view record is created (stored until the status expires)
5. A background job periodically sweeps expired statuses and deletes media from S3
6. Privacy controls: "My contacts", "My contacts except...", "Only share with..." — implemented as contact list filters on the server

### Presence System

Online/offline status with privacy controls:

1. When a user connects, the connection server writes `presence:{user_id} → online, server_id` to Redis with a 60-second TTL
2. Heartbeat pings refresh the TTL every 30 seconds
3. When presence changes, the server broadcasts to all contacts who have the user in their contact list and whose privacy settings allow visibility
4. **Last seen** — stored as a timestamp in Redis, updated on disconnect
5. Privacy settings (nobody / my contacts / everyone) are checked before broadcasting

Trade-off: Broadcasting presence to all contacts on every status change creates O(contacts) fanout. At scale, a user with 500 contacts going online generates 500 push notifications. Mitigation: batch presence updates and only push to contacts who have the user's chat open or have recently interacted.

### Backup and Chat Export

1. Client-side encrypted backup: the app compresses and encrypts chat history with a user-chosen password (AES-256-GCM)
2. Encrypted backup blob is uploaded to the user's cloud storage (Google Drive / iCloud) — server acts as a proxy
3. Backup metadata (size, date, hash) is stored in PostgreSQL for the user's account
4. Chat export: generates a ZIP file with messages (as text) and media, encrypted with the user's key
5. Restore: downloads the backup from cloud storage, decrypts locally, and imports into the app

---

## Database Schema

### Cassandra — Message Storage (Production)

Messages are partitioned by `user_id` so each user's message history is stored on a small number of nodes. This supports the primary access pattern: "fetch messages for user X in conversation Y, ordered by time."

```sql
CREATE TABLE messages_by_user (
    user_id       UUID,
    conversation_id UUID,
    message_id    TIMEUUID,
    sender_id     UUID,
    content       BLOB,           -- encrypted ciphertext
    content_type  TEXT,            -- 'text', 'image', 'video', 'file'
    media_url     TEXT,
    media_key     BLOB,           -- encrypted AES key for media
    status        TEXT,            -- 'sent', 'delivered', 'read'
    created_at    TIMESTAMP,
    PRIMARY KEY ((user_id, conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND default_time_to_live = 0
  AND gc_grace_seconds = 864000;
```

Partition key `(user_id, conversation_id)` ensures all messages for a user in a conversation are co-located. `TIMEUUID` as clustering key provides unique, time-ordered message IDs.

### PostgreSQL — Accounts and Group Metadata (Production)

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number    VARCHAR(20) UNIQUE NOT NULL,
    display_name    VARCHAR(100) NOT NULL,
    profile_picture_url TEXT,
    status_text     TEXT,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100),
    is_group    BOOLEAN DEFAULT FALSE,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE conversation_participants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(20) DEFAULT 'member',  -- 'admin', 'member'
    joined_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, user_id)
);

CREATE TABLE encryption_keys (
    user_id         UUID NOT NULL REFERENCES users(id),
    device_id       TEXT NOT NULL,
    identity_key    BYTEA NOT NULL,
    signed_pre_key  BYTEA NOT NULL,
    pre_keys        BYTEA[],       -- array of one-time pre-keys
    uploaded_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id)
);

CREATE INDEX idx_participants_user ON conversation_participants(user_id);
CREATE INDEX idx_participants_conv ON conversation_participants(conversation_id);
```

### Redis Cluster — Session, Presence, Routing

| Key Pattern | Value | TTL | Purpose |
|-------------|-------|-----|---------|
| `session:{user_id}` | `server_id` | 24h | Route messages to correct connection server |
| `presence:{user_id}` | `{status, server_id, last_seen}` | 60s | Online status with heartbeat refresh |
| `typing:{conv_id}:{user_id}` | `1` | 5s | Ephemeral typing indicator |
| `server:{server_id}` | pub/sub channel | — | Cross-server message routing |
| `delivery:{message_id}` | `{sent_at, delivered_at}` | 1h | Delivery latency tracking |
| `rl:{action}:{user_id}` | sorted set | varies | Sliding window rate limiting |
| `group:{group_id}:members` | set of user_ids | — | Fast group membership lookup |

---

## API Design

### REST API — Account and Conversation Management

```
POST   /api/v1/auth/register          → Create account (phone + verification)
POST   /api/v1/auth/login             → Authenticate (returns session cookie)
POST   /api/v1/auth/logout            → Destroy session
GET    /api/v1/auth/me                → Current user profile

GET    /api/v1/conversations          → List user's conversations (with last msg, unread count)
POST   /api/v1/conversations          → Create 1:1 or group conversation
GET    /api/v1/conversations/:id      → Conversation details with participants

GET    /api/v1/messages/:convId       → Paginated message history (cursor-based)
POST   /api/v1/messages/:convId/read  → Mark conversation as read
POST   /api/v1/messages/:id/react     → Add/toggle emoji reaction
DELETE /api/v1/messages/:id/react     → Remove emoji reaction

POST   /api/v1/media/upload           → Upload encrypted media (resumable)
GET    /api/v1/media/:id              → Download media (supports byte-range)

GET    /api/v1/keys/:userId           → Fetch pre-key bundle for E2E key exchange
POST   /api/v1/keys/upload            → Upload new pre-keys

GET    /health                        → Component health check
GET    /metrics                       → Prometheus metrics
GET    /live                          → Liveness probe
GET    /ready                         → Readiness probe
```

### WebSocket Protocol — Real-Time Messaging

All real-time communication uses a JSON WebSocket protocol at `/ws`:

| Client → Server | Payload | Purpose |
|-----------------|---------|---------|
| `message` | `{conversationId, content, contentType, clientMessageId}` | Send a message |
| `typing` | `{conversationId}` | Start typing indicator |
| `stop_typing` | `{conversationId}` | Stop typing indicator |
| `read_receipt` | `{conversationId, messageIds}` | Mark messages as read |

| Server → Client | Payload | Purpose |
|-----------------|---------|---------|
| `message` | `{id, conversation_id, sender, content, created_at}` | Incoming message |
| `message_ack` | `{clientMessageId, messageId, status, createdAt}` | Send confirmation |
| `delivery_receipt` | `{messageId, recipientId, status}` | Delivery confirmation |
| `read_receipt` | `{messageId, messageIds, recipientId}` | Read confirmation |
| `typing` / `stop_typing` | `{conversationId, userId}` | Typing indicator |
| `presence` | `{userId, status, timestamp}` | Online/offline status |
| `reaction_update` | `{conversationId, messageId, reactions}` | Emoji reaction change |
| `error` | `{code, message}` | Error notification |

---

## Frontend Architecture

The frontend is a React 19 + TypeScript single-page application built with Vite, using TanStack Router for routing and Zustand for global state management. The application implements a full messaging client with real-time WebSocket communication, optimistic message sending, offline support via IndexedDB (Dexie), message virtualization, typing indicators, presence tracking, and message reactions.

### Component Hierarchy

```
__root.tsx (Auth check + Outlet + OfflineIndicator)
└── index.tsx → ChatLayout (authenticated) or LoginForm/RegisterForm (guest)
    └── ChatLayout
        ├── ConversationList        → Sidebar with conversation list, unread counts
        │   └── NewChatDialog       → User search + group creation
        └── ChatView                → Active conversation
            ├── MessageList         → Virtualized message rendering
            │   ├── MessageBubble   → Individual message with status indicators
            │   │   └── MessageReactions → Emoji reaction display
            │   └── DateSeparator   → Day boundaries between messages
            ├── ReactionPicker      → Emoji selection overlay
            └── Input bar           → Message input with typing indicator
```

The `ChatLayout` component splits the screen into a sidebar (`ConversationList`) and a main content area (`ChatView`). On mobile-width screens, the conversation list and chat view switch via state toggle (showing one at a time), mimicking WhatsApp's mobile navigation.

### Routing with TanStack Router

The routing is minimal -- the entire app lives on a single route (`/`). The `__root.tsx` layout renders the `OfflineIndicator` banner (for connectivity status) and an `Outlet`. The index route checks `useAuthStore().user`: if authenticated, it renders `ChatLayout`; if not, it shows login/register forms with a toggle between them.

This single-route architecture is appropriate for a messaging app where navigation happens within the UI (selecting conversations) rather than between pages. The URL does not encode the current conversation -- that state lives in the Zustand chat store.

### State Management (Zustand Stores)

Two Zustand stores manage global state:

**`authStore`** -- Manages user authentication (login, register, logout, session validation). The `checkAuth` method is called on mount to verify the session cookie with the backend. Unlike the Uber project, this store does not use persistence middleware -- the session cookie handles persistence, and the auth state is revalidated from the server on each page load.

**`chatStore`** -- The central messaging store managing all conversation and message state. This is the most complex store in any of the four projects, with the following responsibilities:

- **Conversation list** (`conversations`): Array of all user conversations, sorted by `updated_at` (most recent first). Loaded on mount via `loadConversations()`.
- **Current conversation** (`currentConversationId`): Which conversation the user is viewing. Set when clicking a conversation, cleared when navigating back.
- **Message history** (`messages`): A `Record<string, Message[]>` mapping conversation IDs to their message arrays. Messages are loaded on demand when a conversation is opened, not eagerly for all conversations.
- **Pagination** (`hasMoreMessages`, `oldestMessageId`): Tracks whether more historical messages exist and the cursor for loading them. `loadMoreMessages()` fetches older messages and prepends them to the array.
- **Typing indicators** (`typingUsers`): A `Record<string, string[]>` mapping conversation IDs to arrays of user IDs currently typing. Updated by WebSocket `typing`/`stop_typing` events.
- **User presence** (`userPresence`): A `Record<string, PresenceInfo>` tracking online/offline status and last-seen timestamps for other users. Updated by WebSocket `presence` events.
- **Pending messages** (`pendingMessages`): A `Map<string, Message>` tracking messages sent but not yet acknowledged by the server. Used for optimistic update reconciliation.
- **Message reactions** (`messageReactions`): A `Record<string, ReactionSummary[]>` tracking emoji reactions per message. Updated both by API calls (when the user reacts) and WebSocket events (when others react).

**Duplicate message prevention**: The `addMessage` method checks for duplicates by both `id` and `clientMessageId` before adding a message. This prevents the same message from appearing twice when the server broadcasts a message that the sender already added optimistically.

### WebSocket Integration

The `useWebSocket` hook (`hooks/useWebSocket.ts`) manages the WebSocket connection with several notable design choices:

**Singleton connection**: A module-level `wsInstance` variable ensures only one WebSocket connection exists regardless of how many components mount the hook. This prevents connection proliferation and the associated server resource waste.

**Automatic connection/disconnection**: The hook connects when `user` is non-null and disconnects when `user` becomes null (logout). The connection persists across component unmounts -- the cleanup function intentionally does NOT disconnect if the user is still authenticated, allowing the connection to survive route changes.

**Exponential backoff reconnection**: On disconnect, the hook retries with exponential backoff: delay = 1000ms * 2^attempt, up to 10 attempts. This means the delays are 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s. This prevents thundering herd when the server restarts -- thousands of clients do not all reconnect simultaneously.

**Message routing**: The hook routes incoming WebSocket messages to the appropriate chat store methods based on message type:
- `message` -> `addMessage()` + `updateConversationLastMessage()` + auto-send read receipt if viewing that conversation
- `message_ack` -> `updateMessageId()` (replaces client-generated ID with server ID)
- `delivery_receipt` -> `updateMessageStatus()` to 'delivered'
- `read_receipt` -> `updateMessageStatus()` to 'read' for all specified message IDs
- `typing`/`stop_typing` -> `setTyping()` to add/remove user from typing list
- `presence` -> `updatePresence()` to update online/offline status
- `reaction_update` -> `updateMessageReactions()` to sync reaction changes

**Exported send functions**: `sendMessage`, `sendTyping`, and `sendReadReceipt` are exported as standalone functions (not hook return values) so they can be called from the chat store or any component without needing the hook instance.

### Optimistic Updates and Reconciliation

When the user sends a message, the flow is:

1. Generate a `clientMessageId` via `crypto.randomUUID()`
2. Create an optimistic `Message` object with `status: 'sending'` and add it to the store immediately
3. Send the message via WebSocket with the `clientMessageId`
4. When the server acknowledges with `message_ack`, update the message's `id` (replacing the client UUID with the server-generated UUID), `created_at` (server timestamp), and `status` (to 'sent')
5. When the recipient's server delivers the message, a `delivery_receipt` updates status to 'delivered'
6. When the recipient reads the message, a `read_receipt` updates status to 'read'

This four-stage status progression (sending -> sent -> delivered -> read) is displayed to the user with checkmark icons in the `MessageBubble` component, matching WhatsApp's familiar UI pattern.

**Why optimistic updates matter**: Without them, the user would see a blank space or spinner for 100-500ms while the message round-trips to the server. In a messaging app where users expect instant feedback, this latency is unacceptable. The optimistic approach shows the message immediately and updates the status indicators asynchronously.

### Message Virtualization

The `MessageList` component (`components/MessageList.tsx`) uses `@tanstack/react-virtual` to render only the messages visible in the viewport plus a small overscan buffer.

**Why virtualization is necessary**: A group chat can accumulate thousands of messages. Rendering all of them as DOM elements would consume hundreds of megabytes of memory and cause severe jank during scrolling. Virtualization renders only ~15-20 visible messages plus 5 overscan items above and below the viewport, keeping DOM node count constant regardless of message history size.

**Implementation details**: The virtualizer receives a list of `ListItem` objects that are either messages or a loading indicator. Each item has an estimated height (100px for messages with date separators, 60px for regular messages, 40px for the loading indicator). The `measureElement` ref callback measures actual rendered heights for accurate positioning. The virtualizer handles both initial scroll-to-bottom (newest messages visible on open) and auto-scroll when new messages arrive (only if the user was already at the bottom -- if they scrolled up to read history, new messages do not force-scroll).

**Infinite scroll for older messages**: When the user scrolls near the top (scrollTop < 100px), `onLoadMore()` is called, which fetches 50 older messages via the API and prepends them to the message array. The `hasMore` flag prevents unnecessary API calls when all messages have been loaded.

### Offline Support (IndexedDB via Dexie)

The frontend implements offline-first capabilities using IndexedDB through the Dexie library (`db/database.ts`, `services/offlineSync.ts`).

**Offline message queue**: When the WebSocket is disconnected, messages are queued in the `pendingMessages` IndexedDB table with status 'pending'. Each pending message includes a retry count. When connectivity is restored, the `resetFailedMessages()` function moves failed messages (retry count < 3) back to 'pending' for re-sending. Messages that fail 3 times remain as 'failed' for the user to review.

**Conversation and message caching**: Conversations and messages are cached in IndexedDB tables for offline reading. `cacheConversations()` stores the conversation list with unread counts. `cacheMessages()` stores messages with a compound index on `[conversationId+createdAt]` for efficient range queries. `pruneOldCaches()` deletes cached messages older than 7 days to manage storage.

**Connectivity detection**: The `useOnlineStatus` hook tracks browser connectivity using `navigator.onLine` and `online`/`offline` events. It also provides a `checkConnectivity()` method that actively probes the server (`HEAD /api/health`) for cases where `navigator.onLine` is unreliable (connected to WiFi but no internet). The `OfflineIndicator` component renders a red banner when offline ("You're offline. Messages will be sent when you reconnect.") and a green "Back online!" banner that auto-dismisses after 3 seconds.

### Key UI Patterns

**Typing indicators**: When the user types in the message input, the `handleTyping` callback sends a `typing` event via WebSocket. A 2-second debounce timeout sends `stop_typing` if the user pauses. On the receiving end, other users' typing events are stored in `chatStore.typingUsers` and displayed below the chat header as "[Name] is typing...".

**Presence indicators**: The chat header shows the other participant's online status ("Online" or "Last seen [timestamp]"). For group chats, presence is not shown in the header. Presence updates arrive via WebSocket `presence` events and are stored in `chatStore.userPresence`.

**Message reactions**: Users can react to messages with emoji. Clicking a message opens the `ReactionPicker` overlay. Selecting an emoji calls `chatStore.toggleReaction()`, which hits the API to add or remove the reaction (toggling). Reaction updates from other users arrive via WebSocket `reaction_update` events and are stored in `chatStore.messageReactions`. The `MessageReactions` component displays reaction summaries (emoji + count) below each message bubble.

**Read receipts**: When the user opens a conversation, `messagesApi.markRead(conversationId)` is called via the API, and `sendReadReceipt(conversationId, [])` is sent via WebSocket. When individual messages arrive while the conversation is open, their IDs are immediately sent as read receipts. This two-pronged approach handles both "opening a conversation with unread messages" and "receiving new messages while the conversation is open."

---

## Deep Pattern Explanations

This section explains each production-grade pattern used in the architecture, what problem it solves, and how it works in this system.

### Redis Pub/Sub for Cross-Server Message Routing

**The problem**: When running multiple server instances behind a load balancer, WebSocket connections are distributed across servers. If User A is connected to Server 1 and User B is connected to Server 2, Server 1 cannot directly deliver User A's message to User B because B's WebSocket connection lives on a different process.

**How it works**: Each server subscribes to a Redis Pub/Sub channel (e.g., `server:{serverId}`). When a server receives a message for a user, it looks up which server holds that user's WebSocket connection (stored in Redis as `user:connections:{userId} -> serverId`). If the target is the same server, it delivers directly. If different, it publishes the message to the target server's channel. The target server receives the publish event and delivers the message through the local WebSocket connection.

**Why Redis Pub/Sub over Kafka**: Pub/Sub is fire-and-forget with no persistence, which is perfect for real-time message delivery where latency matters more than durability. Messages are already persisted in PostgreSQL before routing. Kafka's persistence and consumer groups add overhead without benefit for this use case. If a server misses a Pub/Sub message (because it was down), the recipient will receive the message from the offline queue when they reconnect.

### Rate Limiting (Sliding Window Algorithm)

**The problem**: A malicious or buggy client could flood the messaging system with thousands of messages per second, overwhelming the database, WebSocket connections, and other users' clients. Without rate limiting, a single user could degrade the service for everyone.

**How it works** (`backend/src/shared/rateLimiter.ts`): The implementation uses a Redis sorted set-based sliding window algorithm:

1. Each request adds an entry to a sorted set with the current timestamp as the score: `ZADD rl:message_send:{userId} {timestamp} {unique_id}`
2. Entries older than the window are removed: `ZREMRANGEBYSCORE ... 0 {windowStart}`
3. The count of remaining entries gives the number of requests in the current window: `ZCARD`
4. If the count exceeds the limit, the request is rejected with HTTP 429

**Why sliding window over fixed window**: A fixed window (e.g., 60 requests per minute) has a burst problem at window boundaries. A user could send 60 requests at minute 0:59 and another 60 at minute 1:00, effectively sending 120 requests in 2 seconds. The sliding window counts requests over a continuously moving time range, ensuring the rate limit is always enforced.

**Per-endpoint limits in this project**: Message sending: 60/minute, Login attempts: 5/15 minutes per IP (prevents brute force), Registration: 3/hour per IP (prevents account spam), WebSocket messages: 30/10 seconds burst. Rate limit hits are tracked as Prometheus metrics for monitoring.

### Delivery Receipt State Machine

**The problem**: Both sender and recipient need to know the status of each message. The sender needs confirmation that their message was delivered and read. The recipient needs the server to know they received the message (so offline queue can be cleared).

**How it works** (`backend/src/shared/deliveryTracker.ts`): Each message progresses through four states:
1. **sending** (client-only): Message is being transmitted to the server
2. **sent**: Server received and persisted the message. Server sends `message_ack` back to sender.
3. **delivered**: Recipient's server received the message and pushed it to the recipient's WebSocket. Server sends `delivery_receipt` to sender.
4. **read**: Recipient opened the conversation containing the message. Recipient's client sends `read_receipt`, server forwards to sender.

Status transitions are one-directional and monotonic (sent -> delivered -> read, never backward). If a `read_receipt` arrives before a `delivery_receipt` (possible due to network reordering), the message status jumps directly to 'read'.

### Circuit Breaker Pattern

**The problem**: If Redis becomes unresponsive (used for sessions, presence tracking, Pub/Sub routing), every incoming message and API request that touches Redis will wait for the timeout period. At high message throughput, this quickly exhausts server resources and makes the entire application unresponsive.

**How it works** (`backend/src/shared/circuitBreaker.ts`): The circuit breaker wraps calls to Redis and external services:

- **CLOSED**: Requests pass through normally. The breaker tracks success/failure rates.
- **OPEN**: When failures exceed the threshold, all requests fail immediately with a fallback. For presence tracking, the fallback returns "unknown" status. For message routing, the fallback queues messages for database-backed delivery.
- **HALF-OPEN**: After a timeout, one probe request is allowed. Success restores normal operation; failure reopens the circuit.

This ensures that a Redis outage degrades features (no typing indicators, delayed presence updates) rather than taking down the entire messaging system.

### Structured Logging (Pino)

**The problem**: When debugging why a message was not delivered to a user, you need to trace the message through multiple systems: was it received by the server? was it persisted? was the recipient online? which server had their connection? Plain text logs like `console.log("message sent")` cannot answer these questions.

**How it works** (`backend/src/shared/logger.ts`): Pino outputs JSON-formatted log lines with structured fields: `{"level":"info","event":"MESSAGE_DELIVERED","messageId":"abc","conversationId":"xyz","recipientId":"user123","msg":"Message delivered via WebSocket"}`. Each field is searchable in log aggregation systems. Event constants (`LogEvents.MESSAGE_DELIVERED`, `LogEvents.MESSAGE_STORED`, `LogEvents.RATE_LIMITED`) ensure consistent event naming across the codebase.

### Prometheus Metrics

**The problem**: You need real-time answers to operational questions: How many messages per second? What is the WebSocket connection count? How many messages are in the offline queue? How many rate limit violations occurred today?

**How it works** (`backend/src/shared/metrics.ts`): The backend exposes metrics on `/metrics` in Prometheus format:
- **Counter**: `whatsapp_messages_total{type}` -- total messages by type (text, image, etc.)
- **Histogram**: `whatsapp_message_delivery_duration_seconds` -- time from send to delivery
- **Gauge**: `whatsapp_websocket_connections` -- current active connections
- **Counter**: `whatsapp_rate_limit_hits{endpoint}` -- rate limit violations by endpoint

These metrics feed into Grafana dashboards for real-time monitoring and into alerting rules that page on-call engineers when thresholds are exceeded.

### Health Checks (Liveness vs Readiness)

**The problem**: When running behind a load balancer, the balancer needs to know which instances can handle WebSocket connections and message delivery. An instance might be running but unable to connect to Redis (which means it cannot route messages across servers).

**How it works**: Two health check types:
- **Liveness** (`/health/live`): "Is the process alive?" Returns 200 if the Node.js process is running. If this fails, the orchestrator restarts the container. Does not check Redis or PostgreSQL -- a database outage should not trigger mass restarts.
- **Readiness** (`/health/ready`): "Can this instance handle traffic?" Checks PostgreSQL connectivity (for message persistence) and Redis connectivity (for sessions and message routing). If this fails, the load balancer stops routing new WebSocket connections to this instance but does not kill it.

### Session-Based Authentication with Redis

**The problem**: The server needs to identify which user owns each WebSocket connection and HTTP request. For a messaging app, immediate session revocation is critical -- if a user's phone is stolen, their sessions must be invalidated instantly.

**How it works**: On login, the server creates a session record in Redis with a random token and sets an HTTP-only cookie. Subsequent HTTP requests include the cookie automatically. For WebSocket connections, the session is validated during the initial HTTP upgrade handshake.

**Why sessions over JWTs for messaging**: JWTs are self-contained tokens valid until expiration. If a user reports their phone stolen, you cannot invalidate their JWT without maintaining a revocation list (which defeats the statelessness benefit). With Redis sessions, deleting the session key immediately blocks all access -- the stolen phone's next request fails authentication. For a messaging app with sensitive conversations, this instant revocation capability is a hard requirement.

### Retry with Exponential Backoff

**The problem**: When a transient failure occurs (network blip, database momentarily overloaded), immediately retrying often fails again because the underlying issue has not resolved. Retrying in a tight loop also amplifies the load on an already-struggling system.

**How it works** (`backend/src/shared/retry.ts`): The retry function wraps async operations with configurable retry logic:
1. Execute the function
2. If it fails, wait for `baseDelay * 2^attempt` milliseconds (exponential increase)
3. Add random jitter (randomize the delay by +/- 25%) to prevent thundering herd -- without jitter, all retries from different clients would fire at exactly the same time
4. Retry up to `maxRetries` times, then propagate the error

This is used for database connections, Redis connections, and message persistence. For user-facing operations, retry attempts are limited (2-3) to avoid keeping the user waiting.

---

## Key Design Decisions

### Message Storage: Cassandra vs PostgreSQL

**Chosen: Cassandra** for message storage at production scale.

WhatsApp's access pattern is write-heavy (100B messages/day) with reads primarily by user+conversation+time. Cassandra's partition-based storage with `(user_id, conversation_id)` as partition key ensures all messages for a given chat are on the same node, making timeline reads a single-partition scan — the most efficient Cassandra operation.

PostgreSQL could handle this with partitioning, but at 100B writes/day, a single PostgreSQL cluster would require aggressive sharding (thousands of shards), complex cross-shard queries for user migration, and write-ahead log bottlenecks. Cassandra's masterless architecture with tunable consistency (QUORUM writes, LOCAL_ONE reads) provides the write throughput and availability guarantees messaging demands.

Trade-off: Cassandra cannot do ad-hoc queries (JOIN, GROUP BY), so analytics and search require separate systems. PostgreSQL remains the right choice for accounts, groups, and encryption keys where ACID transactions and complex queries are needed.

### Connection Management: Dedicated Connection Servers vs API Servers

**Chosen: Dedicated connection gateway servers.**

Separating WebSocket connection management from business logic servers enables independent scaling. Connection servers are memory-bound (each connection consumes ~20KB), while message processing is CPU-bound. Mixing both on the same servers would force scaling both dimensions together.

At 500M concurrent connections, the connection layer needs ~10,000 servers. The message processing layer might need only ~2,000 servers. Decoupling them saves ~80% of hardware costs.

Trade-off: Adds a routing hop (connection server → message router → connection server), increasing latency by ~5ms. This is acceptable because sub-100ms delivery is still achievable, and the operational flexibility is worth it.

### Group Message Fan-out: Write-time vs Read-time

**Chosen: Write-time fan-out** (fan-out on write).

When a message is sent to a group, it is immediately written to each member's message partition in Cassandra. This means each read is a simple partition scan — no JOINs, no fan-out at read time.

For a group of 256 members, each message generates 256 writes. At WhatsApp's scale this is manageable because Cassandra's write path is designed for high throughput (each write is an append to the commit log + memtable).

Trade-off: Fan-out on write increases storage (256x for a 256-member group) and write amplification. The alternative — fan-out on read — would store one copy but require 256 scatter-gather queries to build each user's timeline, which is too slow for real-time messaging. For messaging, fast reads matter more than storage efficiency.

### Encryption: Signal Protocol vs Custom

**Chosen: Signal Protocol (X3DH + Double Ratchet).**

Signal Protocol is the gold standard for messaging encryption, providing forward secrecy and break-in recovery. It is publicly audited, formally verified, and used by Signal, WhatsApp, and other major messaging apps.

A custom encryption scheme would need to solve the same problems (key agreement, ratcheting, group keys) with years of cryptographic review to reach the same confidence level. The risk of subtle implementation bugs in custom crypto is unacceptably high for a service handling 100B messages/day.

Trade-off: Signal Protocol adds complexity to the client (key management, ratchet state) and server (pre-key distribution, key rotation). It also prevents server-side features like message search, spam detection, and backup (without additional protocol extensions). WhatsApp addresses this with client-side search and optional encrypted backups.

---

## Consistency and Idempotency

### Message Delivery Guarantees

The system provides **at-least-once delivery** with **idempotent processing**:

1. **Client-generated message IDs** (`clientMessageId`) — each message gets a UUID on the client. If the server receives a duplicate (same `clientMessageId` from the same sender), it returns the existing message's ACK without re-persisting
2. **Idempotent status updates** — message status can only progress forward (`sent` → `delivered` → `read`). The status update query uses a conditional write: `WHERE status < new_status`. Duplicate delivery receipts are no-ops
3. **Server-side deduplication** — Redis stores recent message IDs (1-hour TTL) to detect retries from client reconnections

### Message Ordering

Per-conversation causal ordering is maintained through:
- **TIMEUUID** message IDs in Cassandra provide globally unique, time-ordered identifiers
- **Sequence numbers** per conversation for strict ordering when clock skew occurs
- Clients sort messages by `(sequence_number, created_at)` as a tiebreaker

### Delivery Tracking

Every message transitions through a tracked lifecycle:

```
SENT ──▶ DELIVERED ──▶ READ
  │                      │
  │   (status can only   │
  │    move forward)     │
  └──────────────────────┘
       never backwards
```

- Delivery tracking data is stored in Redis with a 1-hour TTL for latency metrics
- Database updates use conditional writes to enforce forward-only progression
- Batch status updates support marking entire conversations as read atomically

---

## Security and Authentication

### Authentication Flow

1. **Registration** — phone number verification via SMS OTP
2. **Session creation** — server creates a Redis-backed session on successful auth; session ID sent as `HttpOnly`, `Secure`, `SameSite=Lax` cookie
3. **WebSocket auth** — client includes `connect.sid` cookie in the WebSocket upgrade request; server validates against Redis session store
4. **Session expiry** — 24-hour max age; automatic cleanup via Redis TTL

### Rate Limiting

Rate limiting is implemented at multiple layers to prevent abuse:

| Layer | Limit | Window | Purpose |
|-------|-------|--------|---------|
| Message sending (WS) | 30 messages | 10 seconds | Anti-spam burst protection |
| Typing events (WS) | 10 events | 60 seconds | Prevent typing indicator flooding |
| Login attempts (HTTP) | 5 attempts | 15 minutes | Brute force protection |
| Registration (HTTP) | 3 attempts | 1 hour | Account spam prevention |
| Message sending (HTTP) | 60 messages | 1 minute | REST fallback protection |

All rate limiters use Redis sorted sets for distributed sliding window counting, ensuring limits are enforced consistently across multiple server instances.

### Authorization

- Every message send verifies the sender is a participant in the conversation
- Group admin operations (add/remove members, change group name) check the `role` field
- Media access is controlled by conversation membership — only participants can download media
- Encryption keys are per-user and cannot be accessed by other users

---

## Observability

### Prometheus Metrics

The system exposes the following metrics at `/metrics`:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `whatsapp_messages_total` | Counter | `status`, `content_type` | Message flow tracking |
| `whatsapp_message_delivery_duration_seconds` | Histogram | `delivery_type` | Delivery latency (local/cross-server/pending) |
| `whatsapp_websocket_connections_total` | Gauge | — | Connection count per server |
| `whatsapp_websocket_events_total` | Counter | `event` | Connection lifecycle events |
| `whatsapp_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | API latency |
| `whatsapp_rate_limit_hits_total` | Counter | `endpoint` | Rate limit trigger frequency |
| `whatsapp_circuit_breaker_state` | Gauge | `name` | Circuit breaker status (0=closed, 0.5=half-open, 1=open) |
| `whatsapp_retry_attempts_total` | Counter | `operation`, `success` | Retry frequency |
| `whatsapp_db_operations_total` | Counter | `operation`, `success` | Database health |
| `whatsapp_db_query_duration_seconds` | Histogram | `operation` | Database latency |

### Structured Logging

JSON-structured logs via Pino with:
- Request correlation via `x-trace-id` headers (or auto-generated UUIDs)
- Service-specific child loggers (`websocket`, `websocket-chat`, `websocket-presence`, `server`)
- Standardized event types (`message_sent`, `message_delivered`, `ws_connected`, `rate_limited`, `circuit_open`)
- Automatic HTTP request/response logging with latency tracking
- Sensitive header redaction (cookies, authorization)
- Pretty-printed in development, raw JSON in production for log aggregation (ELK, Datadog)

### Health Checks

Three health endpoints for different purposes:

- `/health` — detailed component status (database, Redis, circuit breakers, memory, uptime, connection count). Returns `healthy`, `degraded`, or `unhealthy`
- `/live` — simple liveness probe for Kubernetes (process is running)
- `/ready` — readiness probe checking database and Redis connectivity

---

## Failure Handling

### Circuit Breakers

Circuit breakers (implemented with Opossum) protect the messaging pipeline from cascade failures:

| Circuit | Timeout | Error Threshold | Reset Timeout | Purpose |
|---------|---------|-----------------|---------------|---------|
| `redis_pubsub` | 2s | 60% | 15s | Cross-server message routing |
| `database` | 5s | 50% | 30s | Message persistence |

Circuit states: **Closed** (normal) → **Open** (failing, requests rejected immediately) → **Half-Open** (testing recovery with limited requests).

When Redis circuit opens, message delivery falls back to local-only delivery — messages to users on other servers are persisted but not pushed in real-time. They are delivered when the circuit recovers or the recipient reconnects.

### Retry Strategy

Exponential backoff with jitter for transient failures:

| Operation | Max Retries | Base Delay | Max Delay | Notes |
|-----------|-------------|------------|-----------|-------|
| Message delivery | 5 | 200ms | 10s | Covers brief database blips |
| Status updates | 3 | 100ms | 5s | Idempotent, safe to retry |
| Database queries | 3 | 50ms | 2s | Only connection/timeout errors |
| Redis operations | 3 | 25ms | 500ms | Fast recovery expected |

Non-retryable errors (unique violations, auth failures, validation errors) are immediately returned without retry.

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new connections
2. Wait for in-flight messages to complete (10-second timeout)
3. Close database connection pool
4. Close Redis connections
5. Force exit after 10 seconds if graceful shutdown stalls

### Client Reconnection

Clients implement exponential backoff reconnection:
- Base delay: 1 second, doubling each attempt
- Maximum 10 reconnection attempts
- On successful reconnect: pending messages are delivered, presence is re-broadcast
- Singleton WebSocket instance prevents duplicate connections

---

## Scalability Considerations

### Horizontal Scaling Path

| Component | Scaling Strategy | Bottleneck Signal |
|-----------|-----------------|-------------------|
| Connection servers | Add more servers; update DNS/LB | Connections per server > 50K |
| Message routing | Kafka partition increase | Consumer lag > 10s |
| Cassandra | Add nodes to cluster | Disk usage > 70% or latency p99 > 50ms |
| PostgreSQL | Read replicas, then vertical scaling | Connection pool exhaustion |
| Redis Cluster | Add shards | Memory usage > 70% |
| Media storage | S3 scales automatically | Upload latency > 5s |

### Sharding Strategy

**Messages (Cassandra):** Partitioned by `(user_id, conversation_id)`. Cassandra's consistent hashing distributes partitions across nodes automatically. No manual sharding needed — adding nodes triggers automatic rebalancing.

**Accounts (PostgreSQL):** At extreme scale (>1B users), shard by `user_id % N` across PostgreSQL clusters. User lookups by phone number use a secondary index or a phone→user_id mapping table.

**Session Registry (Redis):** Redis Cluster with automatic sharding by key hash. Each shard handles ~500K keys.

### Multi-Region

- **Active-active** across 5+ regions (US, EU, Asia, South America, Africa)
- Users connect to the nearest region via GeoDNS
- Cross-region message routing through Kafka with geo-replication
- Each region has its own Cassandra cluster with `NetworkTopologyStrategy` (replication factor 3 per data center)
- Eventual consistency across regions (typically <500ms)

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Message storage | Cassandra (partitioned by user) | PostgreSQL (sharded) | Write-optimized, partition-friendly for timeline reads |
| Session/presence | Redis Cluster | Cassandra | Sub-ms latency for real-time presence; data is ephemeral |
| Group fan-out | Fan-out on write | Fan-out on read | Fast reads critical for messaging UX; storage is cheap |
| Cross-server routing | Kafka (prod) / Redis pub/sub (local) | gRPC direct | Durable routing, handles server restarts; simpler at scale |
| Encryption | Signal Protocol | Custom / TLS-only | Audited, proven, forward secrecy; industry standard |
| Connection management | Dedicated gateway servers | Combined API+WS servers | Independent scaling of connections vs compute |
| Media pipeline | Separate from messaging | Inline with messages | Keeps messaging path fast; async media handling |
| Presence broadcasts | Push on change with batching | Polling | Real-time UX; batching controls fanout cost |
| Authentication | Session + Redis | JWT | Immediate revocation, simpler distributed session sharing |
| Rate limiting | Redis sorted set (sliding window) | Token bucket | Accurate sliding window; distributed across servers |

---

## Implementation Notes — Pocket-Size Architecture

This section documents what was actually built for local development: a working real-time messaging system that demonstrates the production concepts at a small scale.

### Local Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Client Layer                                    │
│  ┌──────────────────────────────────────────────────────────────┐        │
│  │ React 19 + TypeScript (localhost:5173)                       │        │
│  │                                                              │        │
│  │ ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │        │
│  │ │ Zustand      │  │ TanStack     │  │ Dexie/IndexedDB     │ │        │
│  │ │ (state mgmt) │  │ Router       │  │ (offline cache)     │ │        │
│  │ └─────────────┘  └──────────────┘  └──────────────────────┘ │        │
│  └──────────────────────────┬───────────────────────────────────┘        │
└─────────────────────────────┼────────────────────────────────────────────┘
                              │ HTTP + WebSocket
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Backend (Node.js + Express + ws)                      │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐             │
│  │ Server :3001   │  │ Server :3002   │  │ Server :3003   │             │
│  │                │  │                │  │                │             │
│  │ ┌────────────┐ │  │ ┌────────────┐ │  │ ┌────────────┐ │             │
│  │ │ Express    │ │  │ │ Express    │ │  │ │ Express    │ │             │
│  │ │ REST API   │ │  │ │ REST API   │ │  │ │ REST API   │ │             │
│  │ └────────────┘ │  │ └────────────┘ │  │ └────────────┘ │             │
│  │ ┌────────────┐ │  │ ┌────────────┐ │  │ ┌────────────┐ │             │
│  │ │ WebSocket  │◄┼──┼─┤ Redis      ├─┼──┼─▶ WebSocket  │ │             │
│  │ │ Handler    │ │  │ │ Pub/Sub    │ │  │ │ Handler    │ │             │
│  │ └────────────┘ │  │ └────────────┘ │  │ └────────────┘ │             │
│  │ ┌────────────┐ │  │ ┌────────────┐ │  │ ┌────────────┐ │             │
│  │ │ Metrics    │ │  │ │ Circuit    │ │  │ │ Rate       │ │             │
│  │ │ (Prom)     │ │  │ │ Breakers   │ │  │ │ Limiter    │ │             │
│  │ └────────────┘ │  │ └────────────┘ │  │ └────────────┘ │             │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘             │
└──────────┼───────────────────┼───────────────────┼──────────────────────┘
           │                   │                   │
           └───────────────────┼───────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
     ┌────────────────┐ ┌────────────────┐
     │ PostgreSQL     │ │ Redis/Valkey   │
     │ :5432          │ │ :6379          │
     │                │ │                │
     │ - users        │ │ - sessions     │
     │ - conversations│ │ - presence     │
     │ - messages     │ │ - typing       │
     │ - msg_status   │ │ - pub/sub      │
     │ - reactions    │ │ - rate limits  │
     └────────────────┘ └────────────────┘
```

### Production-Grade Patterns Actually Implemented

**1. Cross-Server Message Routing via Redis Pub/Sub**

Each server instance subscribes to its own Redis channel (`server:{server_id}`). When a message needs to reach a user on a different server, it is published to the recipient's server channel. This demonstrates the production pattern of distributed message routing, scaled down from Kafka to Redis pub/sub.

File: `backend/src/websocket/redis-handler.ts`, `backend/src/websocket/chat-handler.ts`

**2. Circuit Breakers (Opossum)**

Redis and database operations are wrapped with circuit breakers that open after 50-60% error rates, preventing cascade failures. The Redis circuit has a 2-second timeout and 15-second reset; the database circuit has 5-second timeout and 30-second reset. Circuit state is exposed as a Prometheus gauge metric.

File: `backend/src/shared/circuitBreaker.ts`

**3. Idempotent Message Status Updates**

Status transitions are enforced with a conditional SQL UPDATE that only progresses forward (`sent` < `delivered` < `read`). Duplicate delivery receipts from network retries or cross-server routing race conditions are safely ignored.

File: `backend/src/shared/deliveryTracker.ts`

**4. Exponential Backoff Retry with Jitter**

All database and Redis operations use configurable retry logic with exponential backoff (base delay doubles per attempt) plus 20% jitter to prevent thundering herd. Non-retryable errors (constraint violations, auth failures) are detected and returned immediately.

File: `backend/src/shared/retry.ts`

**5. Prometheus Metrics (prom-client)**

Comprehensive metrics including message counters by status, delivery latency histograms, WebSocket connection gauges, HTTP request duration, rate limit hits, circuit breaker state, retry attempts, and database operation tracking. Default Node.js metrics (CPU, memory, event loop) are also collected.

File: `backend/src/shared/metrics.ts`

**6. Structured Logging (Pino)**

JSON-structured logging with service context, request correlation IDs, standardized event types, sensitive header redaction, and separate log levels for health/metrics endpoints. Pretty-printed in development mode.

File: `backend/src/shared/logger.ts`

**7. Distributed Rate Limiting (Redis Sliding Window)**

Both HTTP endpoints and WebSocket events are rate-limited using Redis sorted sets for accurate sliding window counting. Limits are enforced consistently across server instances. Different limits for different actions (messages, typing, login, registration).

File: `backend/src/shared/rateLimiter.ts`

**8. Offline-First Frontend (Dexie/IndexedDB)**

The frontend caches conversations and messages in IndexedDB via Dexie for offline access. Pending messages are queued locally and synced when the connection is restored, with retry count tracking and automatic retry of failed sends.

File: `frontend/src/db/database.ts`, `frontend/src/services/offlineSync.ts`

**9. Client-Side WebSocket Reconnection**

Singleton WebSocket connection with exponential backoff reconnection (1s base, doubling up to 10 attempts). On reconnect, pending messages are delivered and presence is re-broadcast. Connection persists across route changes.

File: `frontend/src/hooks/useWebSocket.ts`

**10. Health Checks with Component Status**

Detailed health endpoint reporting status of each component (database, Redis, circuit breakers) with latency measurements, memory usage, and connection counts. Separate liveness and readiness probes for container orchestration.

File: `backend/src/index.ts`

### What Was Simplified or Substituted

| Production Component | Local Substitute | Reason |
|---------------------|------------------|--------|
| Cassandra (messages) | PostgreSQL | Single database simplifies setup; PostgreSQL handles local-scale message storage well |
| Kafka (message routing) | Redis Pub/Sub | Redis pub/sub is sufficient for 2-5 server instances |
| S3 (media storage) | Not implemented | Media columns exist in schema but no upload/download flow |
| Signal Protocol (E2E encryption) | Plaintext | Encryption requires complex client-side key management; marked as future phase |
| Phone number auth + SMS OTP | Username/password + bcrypt | No SMS provider needed for local development |
| CDN (media delivery) | Not implemented | No media to deliver |
| Load balancer (nginx) | Direct connection to server | Manual port selection; scripts support multi-instance |
| TURN/STUN servers | Not implemented | No voice/video calling |
| Multi-region replication | Single machine | One PostgreSQL, one Redis |

### What Was Omitted

- **End-to-end encryption** — Signal Protocol, key exchange, device management, encrypted backups
- **Voice/video calls** — WebRTC, TURN/STUN servers, SFU for group calls
- **Status/Stories** — Ephemeral content, 24h TTL, view tracking
- **Media pipeline** — Upload, thumbnail generation, progressive download, CDN distribution
- **Multi-region** — GeoDNS, cross-region replication, active-active
- **Kubernetes** — Container orchestration, auto-scaling, rolling deployments
- **Cassandra** — Message-specific storage layer (PostgreSQL used instead)
- **Message search** — Full-text search (client-side only at WhatsApp)
- **Contact sync** — Phone book upload, contact discovery
- **Push notifications** — APNs/FCM for background delivery
- **Admin dashboard** — User management, system monitoring UI

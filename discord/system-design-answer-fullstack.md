# Discord (Real-Time Chat System) - System Design Answer (Fullstack Focus)

45-minute system design interview format - Fullstack Engineer Position

---

## Introduction

"Today I'll design a real-time chat system similar to Discord. As a fullstack engineer, I'll focus on how the frontend and backend integrate seamlessly - the WebSocket protocol between client and server, shared type definitions, state synchronization patterns, and how user actions flow through the entire system. Let me walk through my approach."

---

## 📋 Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the scope:

1. **Servers & Channels**: Users create servers with text/voice channels
2. **Real-Time Messaging**: Messages appear instantly for all channel members
3. **Message History**: Scrollable history with search
4. **Presence System**: Online/offline/idle status
5. **Direct Messages**: Private 1-on-1 and group DMs
6. **Reactions & Threads**: Emoji reactions, threaded replies

I'll focus on how these features work across the stack."

### Non-Functional Requirements

"Key targets that affect both frontend and backend:

- **Scale**: 100 million users, 10 million concurrent
- **Latency**: <100ms message delivery for real-time feel
- **Consistency**: Messages must appear in order
- **Offline Resilience**: Queue messages when disconnected"

---

## 🔍 Step 2: Shared Type Definitions

"I'm choosing TypeScript types shared between frontend and backend. This ensures type safety across the API boundary with Zod for runtime validation."

### Core Domain Types

| Type | Key Fields |
|------|------------|
| User | id, username, discriminator, avatarUrl, status, customStatus |
| Guild | id, name, iconUrl, ownerId, channels[], memberCount |
| Channel | id, guildId, name, type (text/voice/category), position, parentId |
| Message | id, channelId, author, content, timestamp, editedAt, attachments[], reactions[], replyTo |
| Attachment | id, filename, url, contentType, size |
| Reaction | emoji, count, users[], me |

### WebSocket Protocol Types

**Client to Server:**
- IDENTIFY (token)
- HEARTBEAT
- SUBSCRIBE_CHANNEL / UNSUBSCRIBE_CHANNEL (channelId)
- SEND_MESSAGE (channelId, content, nonce)
- UPDATE_PRESENCE (status)
- START_TYPING / STOP_TYPING (channelId)

**Server to Client:**
- READY (user, guilds, sessionId)
- HEARTBEAT_ACK
- MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE
- MESSAGE_ACK (nonce, messageId)
- TYPING_START (channelId, userId)
- PRESENCE_UPDATE (userId, status)
- CHANNEL_UPDATE, GUILD_MEMBER_ADD, GUILD_MEMBER_REMOVE
- RESYNC (guilds)
- ERROR (code, message)

### Validation with Zod

Shared schemas for:
- sendMessageSchema: channelId (uuid), content (1-2000 chars), nonce (uuid), replyTo (optional uuid)
- updatePresenceSchema: status enum, customStatus (max 128 chars)
- createGuildSchema: name (2-100 chars), icon (optional url)
- createChannelSchema: guildId, name (lowercase alphanumeric), type, parentId

---

## 🏗️ Step 3: System Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           React Frontend                                       │
├───────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ Auth Store  │  │Message Store│  │Presence Store│ │ Guild Store │          │
│  │  (Zustand)  │  │  (Zustand)  │  │  (Zustand)  │  │  (Zustand)  │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         └────────────────┴────────────────┴────────────────┘                  │
│                                   │                                            │
│                          ┌────────▼────────┐                                  │
│                          │ WebSocket Hook  │                                  │
│                          │ (Reconnection)  │                                  │
│                          └────────┬────────┘                                  │
└───────────────────────────────────┼───────────────────────────────────────────┘
                                    │ WebSocket + REST
                                    ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           Gateway Layer                                        │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                      WebSocket Servers                                   │  │
│  │  Session Management  │  Message Routing  │  Channel Subscriptions       │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Chat Service   │       │Presence Service │       │    REST API     │
│ (Kafka Consumer)│       │     (Redis)     │       │    (Express)    │
└────────┬────────┘       └────────┬────────┘       └────────┬────────┘
         │                         │                         │
         ▼                         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│   Cassandra     │       │      Redis      │       │   PostgreSQL    │
│   (Messages)    │       │   (Presence)    │       │   (Metadata)    │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

---

## 🔧 Step 4: Backend Implementation

### WebSocket Gateway

Key responsibilities:
- **Session Management**: Maps sessionId to userId, socket, subscribedChannels, lastHeartbeat, guilds
- **Pub/Sub**: Subscribes to Redis channel:* and presence:* patterns
- **Message Routing**: Broadcasts to channel subscribers via local map

Key handlers:
- **IDENTIFY**: Validates token, loads user guilds, creates session, updates Redis presence, broadcasts PRESENCE_UPDATE to all guilds
- **SEND_MESSAGE**: Validates with Zod, checks rate limit, creates message, sends to Kafka, immediately ACKs to sender
- **Heartbeat monitoring**: Interval checks lastHeartbeat, disconnects stale sessions

### Message Service with Kafka

Write path:
1. Create message object with TIMEUUID
2. Produce to Kafka (key = channelId for ordering)
3. Consumer writes to Cassandra (time-bucketed partition: channel_id + date)
4. Publish to Redis channel:{channelId} for gateway distribution

Read path:
- Query recent buckets (last 7 days)
- Use before cursor for pagination
- Return up to limit messages

### REST API Routes

| Endpoint | Purpose |
|----------|---------|
| GET /channels/:channelId/messages | Message history with before/limit |
| GET /guilds/:guildId/search | Search messages (rate limited) |
| POST /channels/:channelId/attachments | File upload |
| POST /guilds | Create guild |
| POST /guilds/:guildId/channels | Create channel (permission check) |

---

## 🎨 Step 5: Frontend Implementation

### Zustand Message Store

Key patterns:
- **addMessage**: Deduplicates by ID, inserts in sorted order
- **addPendingMessage**: Tracks by nonce with status: pending/sent/failed
- **confirmMessage**: Removes pending message on ACK
- **failMessage**: Updates status to failed
- **setTyping**: Manages typing users Set per channel
- **loadHistory**: Merges with existing, deduplicates, sorts by timestamp

### WebSocket Client Hook

Configuration:
- HEARTBEAT_INTERVAL: 30000ms
- RECONNECT_DELAYS: [1000, 2000, 5000, 10000, 30000]
- Message queue for offline buffering

Key behaviors:
- On open: Reset reconnect attempts, send IDENTIFY, flush queue, start heartbeat
- On message: Route to handleMessage switch
- On close: Stop heartbeat, schedule reconnect with backoff
- sendMessage: Generate nonce, add pending, send WS message, set 30s timeout for failure

### Chat Component Integration

Message display:
- Combines real messages with pending messages
- Pending messages show author from current user
- Groups messages by author (5-minute window)
- Virtualized with @tanstack/react-virtual

Scroll behavior:
- Subscribe to channel on mount
- Fetch initial history via REST
- Auto-scroll to bottom on new messages
- Load more on scroll to top

### Message Input

Features:
- Debounced typing indicator (2s leading edge)
- Auto-resize textarea (max 200px)
- Enter to send, Shift+Enter for newline

---

## 🔄 Step 6: End-to-End Data Flow

### Message Send Flow

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         MESSAGE SEND DATA FLOW                                 │
├───────────────────────────────────────────────────────────────────────────────┤
│ 1. USER TYPES MESSAGE                                                          │
│    MessageInput captures input, debounces typing indicator                     │
│                                   │                                            │
│ 2. USER HITS ENTER                ▼                                            │
│    Generate nonce, add pending message (optimistic), send SEND_MESSAGE        │
│    Set 30s timeout for failure                                                 │
│                                   │                                            │
│ 3. GATEWAY RECEIVES               ▼                                            │
│    Validates with Zod, checks rate limit, creates message                     │
│    Sends to Kafka (key = channelId), immediately sends MESSAGE_ACK            │
│                                   │                                            │
│ 4. PARALLEL PROCESSING            ▼                                            │
│    ┌──────────────────┬───────────────────┬────────────────────┐              │
│    │ Kafka Consumer   │ Redis Pub/Sub     │ Client Receives    │              │
│    │ Writes to        │ Publishes to      │ MESSAGE_ACK        │              │
│    │ Cassandra        │ channel:X         │ Confirms pending   │              │
│    └──────────────────┴───────────────────┴────────────────────┘              │
│                                   │                                            │
│ 5. BROADCAST TO SUBSCRIBERS       ▼                                            │
│    All gateways with channel:X subscribers broadcast MESSAGE_CREATE           │
│    Each client's MessageStore.addMessage() called                             │
└───────────────────────────────────────────────────────────────────────────────┘

LATENCY BREAKDOWN:
├── User to Gateway: ~20ms
├── Gateway validation: ~5ms
├── Kafka produce: ~10ms
├── MESSAGE_ACK to sender: ~5ms (parallel)
├── Kafka to Consumer: ~10ms
├── Cassandra write: ~10ms
├── Redis publish: ~5ms
├── Redis to Gateways: ~5ms
├── Gateway to Subscribers: ~20ms
└── TOTAL: ~75ms (sender sees ACK in ~40ms)
```

### Presence Update Flow

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        PRESENCE UPDATE DATA FLOW                               │
├───────────────────────────────────────────────────────────────────────────────┤
│ 1. User clicks "Set to DND"                                                    │
│    Sends UPDATE_PRESENCE { status: 'dnd' }                                    │
│                                   │                                            │
│ 2. Gateway processes              ▼                                            │
│    Updates Redis: SETEX presence:userId 60 '{"status":"dnd"}'                 │
│    For each guild: publishes to presence:guildId                              │
│                                   │                                            │
│ 3. Lazy subscription model        ▼                                            │
│    Only gateways with active viewers subscribe to presence:guildId            │
│    Prevents N*M fanout                                                         │
│                                   │                                            │
│ 4. Client receives                ▼                                            │
│    usePresenceStore.updatePresence() -> MemberList re-renders                 │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Step 7: Error Handling Across Stack

### Backend Error Handling

Error types:
- **ZodError**: 400 with validation details (path + message)
- **AppError**: Custom status code and error code
- **Unexpected**: 500 with logged details

### Frontend Error Handling

API interceptors:
- 401: Logout and redirect to /login
- 429: Show rate limit toast with retry-after

WebSocket error handling:
- INVALID_SESSION: Force logout
- RATE_LIMITED: Show toast
- CHANNEL_NOT_FOUND: Navigate to @me, show toast
- PERMISSION_DENIED: Show toast

### Recovery Mechanism

RESYNC event:
- Server sends after reconnect or error recovery
- Client clears stale data, reloads guilds
- Refetches current channel messages

---

## 🧪 Step 8: Testing Strategy

### Shared Type Testing

Validation tests:
- Valid message passes validation
- Empty content rejected
- Content over 2000 chars rejected
- Invalid UUID formats rejected

### Integration Testing

Message flow test:
1. Create test server with two users
2. Connect both via WebSocket
3. Identify both users
4. Subscribe both to test channel
5. User 1 sends message
6. User 1 receives MESSAGE_ACK with nonce
7. User 2 receives MESSAGE_CREATE with content

---

## 📦 Step 9: Deployment Considerations

### Monorepo Structure

| Package | Purpose | Key Contents |
|---------|---------|-------------|
| packages/shared (@discord-clone/shared) | Shared types and validation | types/domain, types/websocket, validation/schemas |
| backend (depends on @discord-clone/shared) | API and WebSocket gateway | gateway, services, routes |
| frontend (depends on @discord-clone/shared) | React client application | components, stores, hooks |
| Root workspace | Build orchestration | package.json (workspace config), turbo.json (build pipelines) |

---

## ⚖️ Trade-offs and Alternatives

| Decision | ✅ Chosen | ❌ Alternative | Reasoning |
|----------|-----------|----------------|-----------|
| Type Sharing | TypeScript + Zod | Protobuf | Simpler tooling, familiar syntax |
| Message Queue | Kafka | RabbitMQ | Better ordering guarantees |
| Message Store | Cassandra | PostgreSQL | Write-heavy, time-series pattern |
| Presence Store | Redis | In-memory | Distributed, persistent |
| Metadata Store | PostgreSQL | MongoDB | Relational queries for guilds |

---

## Summary

"To summarize my fullstack Discord design:

1. **Shared Types**: TypeScript interfaces and Zod schemas ensure type safety across the API boundary between frontend and backend

2. **WebSocket Protocol**: Defined message types for client-server communication with proper handling for identification, heartbeat, messaging, and presence

3. **State Management**: Zustand stores on the frontend handle messages, presence, and guilds with optimistic updates and pending message tracking

4. **Real-Time Sync**: WebSocket hook manages connection lifecycle, automatic reconnection with backoff, and message queuing during disconnection

5. **Data Flow**: Messages flow through WebSocket -> Gateway -> Kafka -> Cassandra for persistence, and Redis Pub/Sub for cross-gateway distribution

6. **Error Handling**: Consistent error handling across the stack with proper error codes, validation errors, and recovery mechanisms

7. **Testing**: Integration tests verify the complete message flow from sender to receiver

The key fullstack insights are:
- Shared types prevent API contract drift
- Optimistic updates provide instant feedback
- WebSocket reconnection is critical for reliability
- Validation at both ends catches errors early
- Message nonces enable reliable delivery confirmation

What aspects of the frontend-backend integration would you like me to elaborate on?"

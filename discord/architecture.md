# Discord - Architecture Design

## System Overview

Discord is a real-time communication platform built for communities, supporting text chat, voice/video calls, and rich media sharing across servers (guilds) with millions of concurrent users. This document presents a dual-layer architecture: the production-scale system that would serve 150M+ monthly active users, and the local "Baby Discord" implementation that demonstrates core distributed system concepts with TCP + HTTP dual-protocol support, room-based messaging, and cross-instance pub/sub.

**Learning Goals:**
- Understand WebSocket gateway architecture and connection management at scale
- Design real-time messaging with delivery guarantees
- Implement voice/video using WebRTC SFU architecture
- Handle distributed presence tracking across gateway nodes
- Practice protocol-agnostic service design (TCP + HTTP adapters)
- Demonstrate horizontal scaling with Redis pub/sub

---

## Requirements

### Functional Requirements

1. **Real-Time Text Messaging** - Send and receive messages in channels with sub-100ms delivery
2. **Server/Guild Management** - Create, join, and manage servers with channels, roles, and permissions
3. **Voice and Video** - Real-time voice/video communication within voice channels
4. **Presence** - Show online/offline/idle/DND status for all guild members
5. **Direct Messages** - Private messaging between users and group DMs
6. **Bot Platform** - Programmable bots with slash commands and event subscriptions
7. **Media and Attachments** - Upload and share images, files, and embedded content
8. **Message History** - Searchable, persistent message history with infinite scroll

### Non-Functional Requirements

| Metric | Target |
|--------|--------|
| Message delivery latency (p99) | < 100ms within a region |
| Voice latency (p99) | < 50ms |
| Availability | 99.99% (52 min downtime/year) |
| Concurrent connections | 10M+ per gateway cluster |
| Messages per second | 1M+ across all guilds |
| Voice concurrent users | 5M+ simultaneously |
| Message storage | Petabytes, retained indefinitely |
| API rate limiting | Per-user and per-bot with token bucket |

---

## Capacity Estimation

### Production Scale

| Metric | Estimate |
|--------|----------|
| Monthly active users | 150M |
| Peak concurrent connections | 15M |
| Messages per day | 4B |
| Messages per second (peak) | 100K |
| Average message size | 200 bytes |
| Daily message storage | ~800 GB |
| Guilds (servers) | 20M |
| Average guild size | 50 members |
| Voice minutes per day | 500M |

### Storage Estimates

| Data | Annual Growth | Storage Strategy |
|------|---------------|------------------|
| Messages | ~300 TB/year | Cassandra, partitioned by channel + time bucket |
| User metadata | ~50 GB | PostgreSQL with read replicas |
| Media/attachments | ~5 PB/year | Object storage (S3) behind CDN |
| Voice (not stored) | N/A | Ephemeral, SFU relay only |

### Local Development Scale

- 10-20 concurrent users across 1-3 server instances
- PostgreSQL for all data (messages + metadata)
- 10 messages per room in-memory ring buffer
- Valkey/Redis pub/sub for cross-instance messaging

---

## High-Level Architecture

### Production Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Client Applications                                │
│                    (Desktop, Mobile, Web, Bot Libraries)                         │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │
                        ┌───────▼───────┐
                        │   CDN / Edge  │  Avatars, emoji, attachments,
                        │   (CloudFront)│  static assets
                        └───────┬───────┘
                                │
                ┌───────────────▼───────────────┐
                │      Global Load Balancer      │
                │   (DNS-based, geo-routing)      │
                └──┬────────────┬────────────┬───┘
                   │            │            │
          ┌────────▼──┐  ┌─────▼─────┐  ┌───▼────────┐
          │ US-East   │  │ EU-West   │  │ AP-South   │
          │ Region    │  │ Region    │  │ Region     │
          └────┬──────┘  └────┬──────┘  └────┬───────┘
               │              │              │
    ┌──────────▼──────────────▼──────────────▼──────────┐
    │                   Per-Region Stack                  │
    │                                                    │
    │  ┌─────────────┐    ┌─────────────┐               │
    │  │  API Gateway │    │  WebSocket  │               │
    │  │  (REST)      │    │  Gateway    │               │
    │  │              │    │  Cluster    │               │
    │  └──────┬───────┘    └──────┬──────┘               │
    │         │                   │                      │
    │  ┌──────▼───────────────────▼──────┐               │
    │  │       Service Mesh               │               │
    │  │                                  │               │
    │  │  ┌──────────┐  ┌──────────┐     │               │
    │  │  │ Guild    │  │ Message  │     │               │
    │  │  │ Service  │  │ Service  │     │               │
    │  │  └──────────┘  └──────────┘     │               │
    │  │  ┌──────────┐  ┌──────────┐     │               │
    │  │  │ Presence │  │ Voice    │     │               │
    │  │  │ Service  │  │ Server   │     │               │
    │  │  └──────────┘  └──────────┘     │               │
    │  │  ┌──────────┐  ┌──────────┐     │               │
    │  │  │ Auth     │  │ Bot      │     │               │
    │  │  │ Service  │  │ Gateway  │     │               │
    │  │  └──────────┘  └──────────┘     │               │
    │  └──────────────────────────────────┘               │
    │                                                    │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
    │  │Cassandra │  │PostgreSQL│  │  Redis    │         │
    │  │(messages)│  │(metadata)│  │  Cluster  │         │
    │  └──────────┘  └──────────┘  └──────────┘         │
    └────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. WebSocket Gateway Cluster

The gateway is the backbone of Discord's real-time system. Every connected client maintains a persistent WebSocket connection to a gateway node.

**Connection Management:**
- Each gateway node handles 100K-500K concurrent WebSocket connections
- Clients connect via `wss://gateway.discord.gg/?v=10&encoding=json`
- Connections are assigned to a gateway node based on consistent hashing of the user ID
- Heartbeat mechanism: gateway sends heartbeat every 41.25s; client must respond within 10s or connection is considered dead
- Session resumption: clients receive a `session_id` and `seq` number, enabling reconnection without missing events

**Event Dispatch:**
- Gateway nodes subscribe to relevant guild channels in the message broker
- When a message is sent to a guild channel, the message service publishes to the broker
- All gateway nodes with members in that guild receive the event and fan out to local connections
- Events are ordered per-guild using sequence numbers

**Scaling:**
- Gateway nodes are stateless (connection state is in-memory per node, but recoverable via session resume)
- Horizontal scaling: add more gateway nodes behind the load balancer
- A guild's members may span many gateway nodes; the pub/sub layer handles fan-out

### 2. Message Service

**Message Flow:**

```
┌────────┐    ┌──────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐
│ Client │───▶│ Gateway  │───▶│ Message  │───▶│ Cassandra │    │ Gateway  │
│        │    │ Node A   │    │ Service  │    │           │    │ Node B   │
└────────┘    └──────────┘    └────┬─────┘    └───────────┘    └────┬─────┘
                                   │                                │
                                   │    ┌──────────────┐            │
                                   └───▶│ Message      │───────────▶│
                                        │ Broker       │            │
                                        │ (Kafka)      │           ...
                                        └──────────────┘
```

1. Client sends message over WebSocket to its gateway node
2. Gateway forwards to the message service via internal RPC
3. Message service validates permissions, applies rate limits, and generates a snowflake ID
4. Message is written to Cassandra (partitioned by channel_id + time bucket)
5. Message is published to Kafka topic for the guild
6. All gateway nodes with subscribers in that channel receive the event
7. Each gateway fans out to its local WebSocket connections

**Message ID Generation (Snowflake):**
- 64-bit IDs: 42 bits timestamp + 10 bits worker ID + 12 bits sequence
- Time-ordered, globally unique without coordination
- Enables efficient Cassandra range scans by time

**Delivery Guarantees:**
- At-least-once delivery to connected clients via gateway fan-out
- Client-side deduplication using message IDs
- Offline users receive messages when they reconnect (gateway replays from last acknowledged sequence)

### 3. Voice and Video (WebRTC SFU)

Discord uses a Selective Forwarding Unit (SFU) architecture rather than peer-to-peer or MCU:

```
┌────────┐                    ┌────────┐
│User A  │───media stream────▶│        │───forward────▶│User B  │
└────────┘                    │  SFU   │               └────────┘
┌────────┐                    │ Voice  │
│User C  │───media stream────▶│ Server │───forward────▶│User A  │
└────────┘                    │        │               │User B  │
                              └────────┘               └────────┘
```

**Why SFU over P2P:**
- P2P requires N*(N-1)/2 connections in a group call; 10 users = 45 connections per user
- SFU: each user sends 1 stream to server, receives N-1 streams. Server handles routing
- Trade-off: server bears forwarding cost, but clients have manageable bandwidth requirements

**Why SFU over MCU:**
- MCU decodes, mixes, and re-encodes all streams into one composite. Extremely CPU-intensive
- SFU just forwards packets without transcoding. 10x cheaper per voice channel
- Trade-off: clients receive N-1 separate streams (more client bandwidth), but modern clients handle this well

**Voice Server Selection:**
- Voice servers are deployed per region (us-east, eu-west, ap-south, etc.)
- When a user joins a voice channel, the voice service selects the nearest voice server based on client region
- If users in a voice channel span regions, the voice server is placed in the region of the guild owner or plurality of users
- Latency-based routing: client sends UDP pings to candidate servers, lowest latency wins

**Protocol:**
- Signaling: WebSocket (exchange of session descriptions, ICE candidates)
- Media: UDP with Opus codec (voice) and VP8/H.264 (video)
- DTLS-SRTP for encryption

### 4. Server/Guild Architecture

**Hierarchy:**

```
Guild (Server)
├── Categories
│   ├── Text Channels
│   │   ├── Messages
│   │   └── Threads
│   └── Voice Channels
├── Roles (hierarchical, bitfield permissions)
├── Members (user + roles + per-channel overrides)
└── Emojis, Stickers, Webhooks
```

**Permission System (Bitfield):**
- Each permission is a bit in a 53-bit integer (fits in JavaScript's safe integer range)
- Role permissions are OR'd together: `finalPerms = basePerms | role1Perms | role2Perms`
- Channel overrides: per-role allow/deny bitfields that override server-level permissions
- Computed permission for a user in a channel: `(serverPerms & ~channelDeny) | channelAllow`
- This bitfield approach enables O(1) permission checks with a single bitwise AND

**Why bitfields over RBAC tables:**
- RBAC join queries: checking "can user X send messages in channel Y" requires joining users, roles, role_permissions, and channel_overrides. At 150M users this is too slow for every message
- Bitfields: compute once on guild load, cache in memory, check with `perms & SEND_MESSAGES !== 0`
- Trade-off: limited to 53 permissions (JavaScript) or 64 (native). Discord currently uses ~40, so this is sufficient. Adding a new permission requires a migration

### 5. Message Storage

**Why Cassandra for Messages:**
- Write-heavy workload: 100K messages/sec, append-only
- Time-ordered access pattern: users scroll up to load older messages
- Partition by channel_id + time bucket (e.g., 10-day buckets): ensures bounded partition sizes
- No cross-partition queries needed for typical access
- Linear horizontal scaling: add nodes to handle more channels

**Partition Key Design:**

| Partition Key | Clustering Key | Why |
|---------------|---------------|-----|
| (channel_id, bucket) | message_id DESC | Messages in a channel are always queried together. Time-bucketing prevents unbounded partitions. Snowflake IDs give time ordering for free |

**Bucket Calculation:**
- bucket = epoch_ms / (10 days in ms)
- Active channels get a new bucket every 10 days
- Dead channels have tiny partitions that are cheap to store

**Trade-off: Cassandra vs PostgreSQL for messages:**
- PostgreSQL handles 1K writes/sec per node well, but 100K/sec requires extensive sharding, which loses PostgreSQL's relational advantages (JOINs, transactions)
- Cassandra is designed for this: 100K+ writes/sec per node, tunable consistency, no single point of failure
- Trade-off: no ad-hoc queries, no JOINs. Full-text search requires a separate Elasticsearch cluster
- Cassandra's eventual consistency means a message might be visible on one replica before another. For chat, this is acceptable because messages have snowflake IDs that enforce ordering regardless of write timing

**PostgreSQL for Metadata:**
- Users, guilds, roles, channels, permissions, bot configurations
- Strong consistency needed: permission changes must be immediately visible
- Complex relational queries: "get all guilds for user X with their roles"
- Read replicas for scaling reads; single writer for consistency

### 6. Presence System

**Distributed Presence Tracking:**

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ Gateway  │────▶│   Presence   │────▶│    Redis     │
│ Node     │     │   Service    │     │   Cluster    │
└──────────┘     └──────┬───────┘     └──────────────┘
                        │
                        ▼
                 ┌──────────────┐
                 │ Pub/Sub      │  Status updates to
                 │ Fan-out      │  all relevant guilds
                 └──────────────┘
```

- Each gateway node reports its connected users to the presence service
- Presence is stored in Redis as a hash: `presence:{user_id}` -> `{status, activities, client_type}`
- When a user's status changes, the presence service publishes to all guilds the user belongs to
- Lazy presence: for large guilds (1000+ members), presence is only fetched for visible members in the sidebar
- Heartbeat-based: if a gateway node dies, its users' presence entries expire via Redis TTL (60s)

**Scaling Challenge:**
- A user in 100 guilds means a status change generates 100 pub/sub messages
- Large guilds (100K+ members) cannot push every member's status to every client
- Solution: guild member list is paginated; presence updates are only sent for members the client has "subscribed" to (visible in sidebar)

### 7. Bot Platform

**Bot Gateway:**
- Bots connect via the same WebSocket gateway as users
- Bot tokens authenticate via OAuth2 with specific scopes (e.g., `bot`, `applications.commands`)
- Slash commands are registered globally or per-guild, dispatched to the bot's gateway connection

**Rate Limiting:**
- Token bucket per bot: 50 requests per second globally, 5 per second per channel
- Bots exceeding limits receive 429 with `Retry-After` header
- Message content rate limits: 5 messages per 5 seconds per channel

**Interaction Model:**
- Slash commands: user types `/command`, Discord sends HTTP POST to bot's interaction endpoint
- Bot responds within 3 seconds with a message, or defers and follows up
- Components (buttons, select menus): user interacts, Discord sends component interaction to bot

### 8. CDN and Media

- All user-uploaded content (avatars, emoji, attachments) is stored in S3
- Served via CDN (CloudFront) with edge caching
- Image processing pipeline: resize avatars to multiple sizes (128px, 256px, 1024px), convert to WebP
- Attachment limits: 8MB for free users, 50MB for Nitro
- Content hash deduplication: identical files are stored once

### 9. Caching Strategy (Cache-Aside Pattern)

Discord's caching follows the cache-aside (lazy-loading) pattern: check cache first, on miss query the database, store the result in cache, return. This pattern reduces database load by orders of magnitude for read-heavy workloads.

**Why caching is essential for Discord**: A PostgreSQL query takes ~5ms. A Redis lookup takes ~0.1ms (50x faster). When a user opens a guild, the client needs the member list, channel list, role definitions, and permission computations. Without caching, every guild open would trigger 5+ database queries. With 15M concurrent users switching between guilds constantly, this would require millions of database queries per second for data that rarely changes.

**Cache invalidation strategy**: When data changes (guild role updated, member added), the server deletes the cache key rather than updating it. Deletion avoids race conditions: if two admin actions update the same role simultaneously, the last delete wins (both clear the cache), and the next read repopulates from the authoritative database. Updating the cache could result in one update overwriting the other, leaving stale data.

**TTL (Time-To-Live)**: Each cached value has an automatic expiration. Even without explicit invalidation, stale data expires. Presence data uses a 60-second TTL -- if a gateway node crashes, its users appear online for at most 60 seconds before the TTL expires and they show as offline.

| Cache | Storage | TTL | Purpose |
|-------|---------|-----|---------|
| Guild member list | Redis | 5 min | Avoid querying PostgreSQL for every permission check |
| Channel permissions | Gateway memory | Until invalidated | O(1) permission checks per message |
| User profile | Redis | 10 min | Avatar URLs, display names |
| Message cache | Redis | 15 min | Recent messages for active channels |
| Rate limit counters | Redis | Sliding window | Per-user and per-bot rate limiting |
| Presence | Redis | 60s TTL | Online/offline status with auto-expiry |

---

## Database Schema

### PostgreSQL (Metadata)

```sql
-- Users table
CREATE TABLE users (
    id BIGINT PRIMARY KEY,               -- Snowflake ID
    username VARCHAR(32) NOT NULL,
    discriminator CHAR(4) NOT NULL,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    avatar_hash VARCHAR(64),
    status VARCHAR(20) DEFAULT 'offline',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(username, discriminator)
);

-- Guilds (Servers)
CREATE TABLE guilds (
    id BIGINT PRIMARY KEY,               -- Snowflake ID
    name VARCHAR(100) NOT NULL,
    owner_id BIGINT REFERENCES users(id),
    icon_hash VARCHAR(64),
    region VARCHAR(20) DEFAULT 'us-east',
    member_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Channels
CREATE TABLE channels (
    id BIGINT PRIMARY KEY,               -- Snowflake ID
    guild_id BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    type SMALLINT NOT NULL,              -- 0=text, 2=voice, 4=category, 5=announcement
    parent_id BIGINT REFERENCES channels(id),
    position INT DEFAULT 0,
    topic TEXT,
    rate_limit_per_user INT DEFAULT 0,   -- Slowmode seconds
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_channels_guild ON channels(guild_id);

-- Roles
CREATE TABLE roles (
    id BIGINT PRIMARY KEY,               -- Snowflake ID
    guild_id BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    permissions BIGINT NOT NULL DEFAULT 0, -- Bitfield
    color INT DEFAULT 0,
    position INT DEFAULT 0,
    hoist BOOLEAN DEFAULT false,
    mentionable BOOLEAN DEFAULT false
);
CREATE INDEX idx_roles_guild ON roles(guild_id, position);

-- Guild Members (user + guild junction)
CREATE TABLE guild_members (
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    guild_id BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
    nickname VARCHAR(32),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX idx_guild_members_user ON guild_members(user_id);

-- Member Roles (member + role junction)
CREATE TABLE member_roles (
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role_id BIGINT REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
);

-- Channel Permission Overrides
CREATE TABLE channel_overrides (
    channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL,           -- Role ID or user ID
    target_type SMALLINT NOT NULL,       -- 0=role, 1=member
    allow BIGINT NOT NULL DEFAULT 0,     -- Bitfield of allowed permissions
    deny BIGINT NOT NULL DEFAULT 0,      -- Bitfield of denied permissions
    PRIMARY KEY (channel_id, target_id, target_type)
);
```

### Cassandra (Messages)

```sql
CREATE TABLE messages (
    channel_id BIGINT,
    bucket INT,                          -- epoch_ms / bucket_size
    message_id BIGINT,                   -- Snowflake ID (time-ordered)
    author_id BIGINT,
    content TEXT,
    edited_timestamp TIMESTAMP,
    attachments LIST<FROZEN<attachment>>,
    embeds LIST<FROZEN<embed>>,
    mentions SET<BIGINT>,
    pinned BOOLEAN,
    type SMALLINT,                       -- 0=default, 6=pin, 7=guild_member_join, etc.
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'DAYS', 'compaction_window_size': 10};
```

---

## API Design

### REST API (v10)

```
Authentication: Bearer token (Bot or User OAuth2)

-- Guilds
POST   /api/v10/guilds                          Create guild
GET    /api/v10/guilds/:guildId                  Get guild details
PATCH  /api/v10/guilds/:guildId                  Modify guild
DELETE /api/v10/guilds/:guildId                  Delete guild
GET    /api/v10/guilds/:guildId/channels         List guild channels
POST   /api/v10/guilds/:guildId/channels         Create channel
GET    /api/v10/guilds/:guildId/members          List members (paginated)

-- Channels
GET    /api/v10/channels/:channelId/messages     Get messages (paginated, before/after/around)
POST   /api/v10/channels/:channelId/messages     Send message
PATCH  /api/v10/channels/:channelId/messages/:id Edit message
DELETE /api/v10/channels/:channelId/messages/:id Delete message

-- Voice
GET    /api/v10/voice/regions                    List available voice regions
POST   /api/v10/channels/:channelId/call         Join voice channel (returns voice server info)

-- Users
GET    /api/v10/users/@me                        Get current user
GET    /api/v10/users/@me/guilds                 List user's guilds
POST   /api/v10/users/@me/channels               Create DM channel

-- Interactions (Bots)
POST   /api/v10/interactions/:id/:token/callback Respond to interaction
PATCH  /api/v10/webhooks/:appId/:token/messages/@original Edit interaction response
```

### Gateway WebSocket Events

```
Client → Server:
  IDENTIFY          Authenticate with token
  RESUME            Resume missed events after reconnect
  HEARTBEAT         Keep connection alive
  VOICE_STATE_UPDATE  Join/leave/mute in voice channel
  REQUEST_GUILD_MEMBERS  Request offline members for large guild

Server → Client:
  READY             Initial state (user, guilds, DM channels)
  MESSAGE_CREATE    New message in subscribed channel
  MESSAGE_UPDATE    Edited message
  MESSAGE_DELETE    Deleted message
  PRESENCE_UPDATE   User status change
  VOICE_STATE_UPDATE  User joined/left voice
  GUILD_MEMBER_ADD  New member joined guild
  TYPING_START      User started typing
```

---

## Frontend Architecture

### Component Hierarchy

The frontend is a React 19 + TypeScript SPA built with Vite, styled with Tailwind CSS using Discord's dark color palette. The UI mimics Discord's three-panel layout:

```
__root.tsx (<Outlet />)
├── /login                    → Login form (nickname-based, no password)
├── / (index)                 → Redirect to /login or /channels/@me
└── /channels                 → ChannelsLayout (auth guard)
    ├── ServerList (left, 64px) → Room icons in vertical strip
    ├── ChannelSidebar (240px)  → Room details, room list, user panel
    └── Main content            → <Outlet />
        ├── /channels/@me       → Welcome screen ("Select a room")
        └── /channels/$roomId   → RoomView
            ├── ChannelHeader   → Room name, member count, actions
            ├── MessageList     → Messages with room welcome banner
            └── MessageInput    → Text input with Enter-to-send
```

The `ChannelsLayout` at `/channels` uses a `beforeLoad` hook that checks the Zustand store for an active session. If no session exists, it throws `redirect({ to: '/login' })`. This prevents the layout from rendering without authentication.

### State Management (Zustand)

A single `useChatStore` manages all application state with the `persist` middleware:

**Session state**: `session` (sessionId, userId, nickname), `isConnecting`, `connectionError`. The session is persisted to localStorage under `baby-discord-session` so the user remains logged in across page refreshes. Only the session object is persisted via `partialize` -- rooms and messages are ephemeral and refetched from the server.

**Room state**: `rooms` (list of available rooms with member counts), `currentRoom` (name of the active room), `isLoadingRooms`.

**Message state**: `messages` (array of messages in the current room), `isLoadingMessages`.

**SSE connection**: `eventSource` (the active EventSource instance for real-time messages). This is stored in the Zustand store (not a ref) so that `joinRoom()` and `leaveRoom()` can clean up the connection during room switches.

**Action flow for joining a room:**
1. `joinRoom(name)` is called
2. Close existing SSE connection if any (`eventSource.close()`)
3. Execute `/join` command via HTTP POST
4. Load room history via `api.getRoomHistory(name)`
5. Create new SSE connection via `api.createSSEConnection()`
6. Update store: `{ currentRoom: name, messages: history, eventSource: newSSE }`

**Why a single store**: The Baby Discord frontend is simpler than Slack or Twitter -- no workspaces, no threads, no reactions. A single store with ~15 state fields and ~10 actions is manageable and avoids the overhead of coordinating between multiple stores. The `persist` middleware's `partialize` option keeps the persisted data minimal (session only).

### Routing (TanStack Router)

File-based routing with a channel layout pattern:

```
routes/
├── __root.tsx            → Root (<Outlet />)
├── index.tsx             → / (redirect based on session state)
├── login.tsx             → /login (LoginForm component)
├── channels.tsx          → /channels (layout with ServerList + ChannelSidebar)
│   ├── channels/@me.tsx  → /channels/@me (welcome/home screen)
│   └── channels/$roomId.tsx → /channels/:roomId (room view)
```

**Auth guard**: The `/channels` layout route checks `useChatStore.getState().session` in `beforeLoad`. This is a synchronous check against the persisted Zustand state -- no API call needed because the session was restored from localStorage on app load.

**Room navigation**: Clicking a room in the `ServerList` navigates to `/channels/$roomId`. The `RoomView` component calls `joinRoom(roomId)` in a `useEffect` when the route parameter changes. If the room does not exist, it attempts to join anyway (it might have been created by another user) and falls back to `/channels/@me` on failure.

### Data Fetching Pattern

The Baby Discord API is command-based, not RESTful. Most operations go through a generic `/api/command` endpoint:

```
Component (e.g., ServerList)
  → useChatStore().createRoom(name)
    → api.executeCommand(sessionId, "/create room-name")
      → fetch('/api/command', { body: { sessionId, command } })
        → Backend ChatHandler.handleInput()
```

**`services/api.ts`** exports individual functions (not API objects) for each operation: `connect()`, `disconnect()`, `executeCommand()`, `sendMessage()`, `getRooms()`, `getRoomHistory()`, `getSession()`, `createSSEConnection()`. Each function handles its own fetch call and response parsing.

**Session-based auth**: Unlike Slack and Twitter (which use httpOnly cookies), Baby Discord uses explicit session tokens. The `connect()` function returns a `Session` object with a `sessionId`, which is included in every subsequent request as a JSON body field. This is simpler but less secure -- the session token is accessible to JavaScript.

### Real-Time Updates (SSE)

Baby Discord uses Server-Sent Events (SSE) instead of WebSocket for real-time message delivery. SSE is a simpler protocol: the server sends data to the client over a persistent HTTP connection using the `text/event-stream` content type. The browser's native `EventSource` API handles connection management, automatic reconnection, and event parsing.

**Connection lifecycle:**
1. When `joinRoom()` is called, it creates an `EventSource` pointing to `/api/messages/:room?sessionId=...`
2. The server keeps the connection open and pushes new messages as SSE events
3. `EventSource.onmessage` parses each event and calls `addMessage()` to update the Zustand store
4. When the user leaves the room or switches rooms, `eventSource.close()` terminates the connection
5. If the connection drops, `EventSource` automatically reconnects (built into the browser API)

**Why SSE over WebSocket**: SSE is unidirectional (server-to-client only), which matches Baby Discord's architecture: messages flow from server to client via SSE, and commands flow from client to server via HTTP POST. WebSocket's bidirectional capability is unnecessary and adds handshake complexity. SSE also provides automatic reconnection built into the browser's `EventSource` API, whereas WebSocket requires manual reconnection logic.

**SSE error handling**: The `createSSEConnection()` function accepts an `onError` callback. Connection errors are logged to the console. Since `EventSource` auto-reconnects, most transient errors (server restart, network blip) resolve without user intervention.

### Key UI Patterns

**Discord-like server icons**: The `ServerList` renders room icons as circular avatars with the room's first letter, arranged vertically in a 64px-wide strip. Active rooms get a `rounded-2xl` shape and indigo background. Hovering transitions from circle to rounded-rectangle (`hover:rounded-2xl`). An active indicator (white pill on the left edge) marks the current room.

**Room auto-refresh**: The `ServerList` polls `refreshRooms()` every 30 seconds to pick up rooms created by other users. This is necessary because SSE only delivers messages for the current room, not room list changes.

**User panel**: The bottom of the `ChannelSidebar` shows the current user's nickname with a disconnect button, styled identically to Discord's user area (dark background, avatar with status indicator).

**Auto-scroll**: The `MessageList` auto-scrolls to the bottom when new messages arrive via `messagesEndRef.scrollIntoView({ behavior: 'smooth' })`. This ensures the user always sees the latest message without manual scrolling.

**System messages**: Messages from the "system" user (join/leave notifications) render in a muted, italicized style without an avatar, distinguishing them from user messages.

---

## Key Design Decisions

### 1. WebSocket Gateway vs HTTP Polling for Real-Time

**Chosen:** Persistent WebSocket connections

Discord requires sub-100ms message delivery. HTTP polling at 1-second intervals means 500ms average latency and 60 requests/minute per user. At 15M concurrent users, that is 15 billion requests/minute, which is absurd. Long polling reduces request volume but still requires connection setup overhead for each event. WebSocket maintains a single TCP connection per client, enabling instant server-to-client push. The trade-off is connection management complexity: heartbeats to detect dead connections, session resumption for network switches, and connection draining during deployments. For a platform where real-time responsiveness is the core product, this complexity is justified.

### 2. Cassandra vs PostgreSQL for Message Storage

**Chosen:** Cassandra for messages, PostgreSQL for metadata

Messages are append-only with a time-ordered access pattern (scroll up to load older messages). At 100K writes/sec, PostgreSQL would require extensive sharding, losing its relational advantages. Cassandra handles this natively: partition by (channel_id, bucket) gives bounded partition sizes, and its log-structured merge tree is optimized for sequential writes. The trade-off is the loss of ad-hoc queries and JOINs. Searching messages by content requires a separate Elasticsearch cluster. For metadata (users, guilds, roles, permissions), PostgreSQL's strong consistency and relational queries are essential. Permission changes must be immediately visible, and "get all guilds for user X with their roles" is a natural relational query.

### 3. SFU vs MCU vs P2P for Voice/Video

**Chosen:** SFU (Selective Forwarding Unit)

P2P works for 1:1 calls but breaks in group calls. A 10-person call requires 45 peer connections per user, consuming 9 upload streams. MCU solves this by mixing all streams server-side into one composite, but transcoding 10 HD streams requires enormous CPU. SFU forwards packets without decoding: each user sends 1 stream and receives N-1. Server cost is proportional to bandwidth, not compute. The trade-off is higher client-side bandwidth (receiving N-1 streams instead of 1 composite), but modern clients handle 10+ simultaneous audio streams without issue. For Discord's use case (typically 2-25 users in voice), SFU is the clear winner on cost-per-voice-channel.

### 4. Snowflake IDs vs UUIDs

**Chosen:** Snowflake IDs (64-bit)

UUIDs (128-bit) are randomly distributed, which kills Cassandra's write performance (random insertions into SSTables instead of sequential appends). Snowflake IDs embed a timestamp, making them naturally time-ordered. This means Cassandra's clustering order by message_id is also chronological order, eliminating the need for a separate timestamp column in queries. The trade-off is coordination: each worker needs a unique 10-bit worker ID. Discord pre-assigns worker IDs at deployment time, avoiding runtime coordination.

### 5. Bitfield Permissions vs RBAC Table Lookups

**Chosen:** Bitfield permissions (53-bit integer)

RBAC with join tables requires 3-4 table joins to answer "can this user do X in this channel." At 100K messages/sec, each requiring a permission check, this is too many database round-trips. Bitfield permissions are computed once per guild load and cached in gateway memory. Checking a permission is a single bitwise AND operation: `perms & SEND_MESSAGES !== 0`. The trade-off is a hard limit on the number of distinct permissions (53 in JavaScript, 64 in native). Discord currently uses approximately 40 permissions, and adding a new one requires a coordinated migration across all services. For the foreseeable future, this limit is not a constraint.

---

## Consistency and Idempotency

**Message Ordering:**
- Snowflake IDs guarantee global ordering within a channel
- Gateway dispatches events with a per-guild sequence number
- Clients detect gaps in sequence numbers and request missed events via RESUME

**Idempotent Message Sends:**

Idempotency prevents a specific class of bugs caused by network unreliability. The scenario: a user sends a message in a busy channel. The server receives the message, writes it to Cassandra, publishes it to Kafka for delivery to other gateway nodes, and starts building the HTTP response. But the user's network drops before the response arrives. The client shows "sending..." and retries. Without idempotency, the message is written to Cassandra again and published to Kafka again -- the channel now shows the same message twice.

The solution: the client generates a UUID and includes it as the `Idempotency-Key` header. The server checks Redis for this key before processing. If found, it returns the cached response from the first processing. If not found, it processes the message, stores the response in Redis with a 5-minute TTL, and returns it. The short TTL (5 minutes vs 24 hours in other projects) reflects Discord's real-time nature -- retries for a 5-minute-old message are unlikely.

- Clients include an `Idempotency-Key` header (UUID) with message creation
- Server stores key in Redis with a 5-minute TTL
- Duplicate sends return the original message without re-persisting

**Eventual Consistency for Presence:**
- Presence updates are best-effort; a user may appear online for up to 60s after disconnecting (Redis TTL)
- This is acceptable: showing a user as online when they just disconnected is harmless. Showing them offline when they are online is worse, and the heartbeat mechanism prevents this

**Guild Membership:**
- Strong consistency via PostgreSQL transactions
- Adding/removing members and updating roles use serializable isolation
- Permission cache invalidation is propagated via pub/sub to all gateway nodes

---

## Security and Auth

**Authentication:**
- User tokens: JWT-like opaque tokens with user_id, issued on login
- Bot tokens: fixed-format tokens with bot user_id, never expire (revocable by owner)
- OAuth2 for third-party integrations with granular scopes

**Authorization (Bitfield Permissions):**

Discord uses bitfield-based permissions rather than traditional RBAC (Role-Based Access Control) join tables. In a traditional RBAC system, checking "can user X send messages in channel Y" requires joining users -> member_roles -> roles -> role_permissions -> channel_overrides -- 3-4 database queries. At 100K messages per second, each requiring a permission check, this is too many database round-trips.

Bitfield permissions solve this: each permission is a bit in a 53-bit integer. A user's effective permissions are computed once (when they load a guild) by OR-ing all their role permission bitfields together. Checking a permission is a single bitwise AND: `perms & SEND_MESSAGES !== 0` -- an O(1) operation that executes in nanoseconds, not milliseconds. The computed permission is cached in gateway memory, so message permission checks never hit the database.

**Rate limiting** prevents abuse and ensures fair usage. Two algorithms are commonly used:

- **Token Bucket** (used for bots): Each bot has a bucket that holds N tokens (e.g., 50). Each request consumes one token. Tokens refill at a fixed rate (e.g., 50/second). When the bucket is empty, requests are rejected with HTTP 429 and a `Retry-After` header. This algorithm allows short bursts (a bot can consume all 50 tokens instantly) while enforcing a long-term average rate.
- **Sliding Window** (used for users): Counts requests in a rolling time window stored in Redis. More accurate than fixed-window counters at the cost of slightly more Redis operations.

- Rate limiting: token bucket per user (50 req/s global) and per bot (varies by endpoint)
- IP rate limiting for unauthenticated endpoints (login, register)

**Data Protection:**
- TLS 1.3 for all WebSocket and HTTP connections
- DTLS-SRTP for voice/video streams
- Messages encrypted at rest in Cassandra (volume-level encryption)
- No end-to-end encryption for text (Discord can read messages for moderation/legal compliance)

---

## Observability

### What Observability Solves

In a system with gateway nodes, message services, voice servers, and multiple databases, a user reporting "my messages aren't appearing" could be caused by any component. Without observability, debugging requires SSH-ing into each server and reading log files. With observability, you query a centralized dashboard: "what's the Cassandra write latency?" (metrics), "show me all message publishes from user X" (logs), "is gateway node 7 healthy?" (health checks). The three pillars -- metrics, logs, health checks -- transform production incidents from guesswork into systematic diagnosis.

### Prometheus Metrics

Prometheus scrapes a `/metrics` endpoint on each service at regular intervals. The application registers metrics using a client library, and Prometheus stores them as time-series data for querying and alerting.

**Three metric types:**
- **Counter** -- Monotonically increasing value. Total messages sent, total errors. To get "messages per second," compute `rate(messages_total[5m])`. Never decreases except on process restart.
- **Histogram** -- Distribution of values (latencies, sizes). Pre-buckets values for percentile queries: `histogram_quantile(0.99, write_latency)` gives the p99 -- the latency below which 99% of writes complete. Critical because averages mask outliers.
- **Gauge** -- Current value that goes up and down: active connections, queue depth. Represents point-in-time state.

**The RED method** applied to Discord's services:
- **Rate**: messages/sec, connections/sec -- detect traffic surges or drops indicating outages
- **Errors**: 4xx and 5xx rates per endpoint -- detect permission issues (4xx) vs service failures (5xx)
- **Duration**: write latency p50/p99 -- detect Cassandra degradation before users notice

**Metrics by service:**
- Gateway: connections per node, events dispatched/sec, heartbeat failures, WebSocket errors
- Message service: messages/sec, write latency (p50/p99), Cassandra query latency
- Voice: active voice connections, packet loss rate, jitter
- Presence: updates/sec, Redis latency
- API: request rate, error rate (4xx, 5xx), latency by endpoint

### Structured Logging

`console.log("message sent to channel")` is useless when you have 50 gateway nodes and 20 message service instances. Structured logging means every log entry is a JSON object with consistent, searchable fields. These JSON logs flow through a centralized pipeline (Fluentd -> Elasticsearch -> Kibana) where you can query: "show me all ERROR logs from gateway node 7 in the last hour" or "show all messages from user X that took >500ms."

**Log levels** control what gets recorded without code changes:
- **DEBUG**: Detailed information for development -- cache hits, query results, state transitions. Disabled in production (too verbose).
- **INFO**: Normal operations -- message delivered, user connected, request completed. The baseline for production.
- **WARN**: Degraded state -- heartbeat timeout approaching, connection pool near capacity, rate limit nearing threshold.
- **ERROR**: Failures -- Cassandra write failed, WebSocket connection dropped unexpectedly, message delivery failed.

**Request correlation**: Every log entry includes a `request_id` field. When a message send traverses gateway -> message service -> Cassandra -> Kafka -> gateway (for delivery), all log entries share the same `request_id`, enabling end-to-end trace reconstruction.

**Logging pipeline:**
- Structured JSON logging (Pino/Bunyan) with request_id for correlation
- Centralized logging via Fluentd -> Elasticsearch -> Kibana

### Alerting

Alerting converts metric thresholds into actionable notifications. Each alert has a condition (when to fire), a severity (who to notify), and a runbook (what to do).

- Gateway connection count > 80% capacity -> scale up (add gateway nodes)
- Message delivery latency p99 > 200ms -> investigate Cassandra/Kafka (check compaction, consumer lag)
- Voice packet loss > 2% -> check network/voice server capacity (potential bandwidth saturation)
- Presence Redis latency > 50ms -> scale Redis cluster (add nodes or increase instance size)

### Health Checks

Health checks answer two questions that infrastructure systems need:

- **Liveness** -- "Is the process running?" A simple HTTP 200 response. If this fails, the container is hung or crashed. The orchestrator (Kubernetes) kills and restarts it. This check must never depend on external services -- a gateway with a dead Redis connection is alive, just not ready.
- **Readiness** -- "Can this instance serve traffic?" Checks DB connectivity, Redis connectivity, and upstream dependencies. If any check fails, the load balancer routes traffic away from this instance without killing it. This distinction matters: a gateway reconnecting to Redis should not receive new WebSocket connections, but killing it would disconnect all existing users.

**Health check configuration:**
- `/health` on every service: DB connectivity, Redis connectivity, upstream dependencies
- Load balancer routes traffic away from unhealthy nodes within 10s

---

## Failure Handling

**Gateway Node Failure:**
- Load balancer detects unhealthy node via health checks (5s interval)
- Clients reconnect to a different gateway node using RESUME with their session_id and last sequence number
- Gateway replays missed events from Kafka (retained for 7 days)
- Presence entries for the failed node expire via Redis TTL (60s)

**Cassandra Node Failure:**
- Replication factor 3: data is available on 2 other nodes
- Write with consistency level QUORUM (2 of 3 nodes): one node failure does not impact writes
- Hinted handoff: writes destined for the failed node are stored on other nodes and replayed on recovery

**Kafka Broker Failure:**
- Replication factor 3 for all topics
- Leader election promotes an in-sync replica within seconds
- Gateway consumers resume from last committed offset

**Voice Server Failure:**
- Voice connections are UDP-based; clients detect failure within 2-3s (no packets received)
- Client requests a new voice server from the voice service
- New voice server is assigned, all users in the channel reconnect
- Voice state is ephemeral (no data loss), but there is a 2-5s interruption

**Database (PostgreSQL) Failure:**
- Primary failure: automatic failover to synchronous standby (< 30s)
- Read replica failure: load balancer routes reads to remaining replicas
- All writes go through a single primary to maintain consistency

---

## Scalability Considerations

**What Breaks First and How to Scale It:**

| Bottleneck | Symptom | Solution |
|-----------|---------|----------|
| Gateway connections | Memory exhaustion per node | Add more gateway nodes; each handles 100K-500K connections |
| Message writes | Cassandra write latency increases | Add Cassandra nodes (linear scaling) |
| Presence fan-out | Redis CPU saturation | Redis Cluster with hash-based routing per guild |
| Voice servers | Network bandwidth exhaustion | Deploy more voice servers per region; smart routing |
| Permission checks | Gateway CPU on large guilds | Pre-compute and cache permissions; lazy evaluation for large guilds |
| Message reads (search) | Elasticsearch query latency | Add Elasticsearch nodes, optimize index sharding |

**Horizontal Scaling Strategy:**
- Gateway: stateless, scale with connections. Use consistent hashing to route users
- Message service: stateless, scale with message throughput
- Cassandra: add nodes, data automatically rebalances via vnodes
- PostgreSQL: read replicas for reads, single primary for writes. Shard by guild_id at extreme scale
- Redis: Redis Cluster with 6+ nodes, shard presence data by user_id

**Multi-Region:**
- Each region has a full stack (gateway, services, databases)
- Messages are written to the guild's home region
- Cross-region reads use async replication with Cassandra's multi-datacenter strategy
- Voice servers are always region-local (latency sensitive)

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time transport | WebSocket | HTTP polling | Sub-100ms delivery; polling is 500ms avg latency |
| Message storage | Cassandra | PostgreSQL | 100K writes/sec, time-ordered partitions, linear scaling |
| Voice architecture | SFU | MCU / P2P | Balance of server cost and client simplicity |
| ID generation | Snowflake | UUID | Time-ordered, 64-bit (Cassandra-friendly), no coordination |
| Permissions | Bitfield (53-bit) | RBAC join tables | O(1) checks vs O(N) joins; cached in gateway memory |
| Presence storage | Redis with TTL | Database polling | Low-latency reads, automatic expiry on node failure |
| Message broker | Kafka | RabbitMQ | Ordered delivery, replay capability, high throughput |
| Metadata storage | PostgreSQL | MongoDB | ACID for permissions, relational queries for guild membership |
| Session management | Gateway memory + resume | Stateless JWT | Resume prevents missed events; JWT cannot track sequence |
| Search | Elasticsearch | PostgreSQL full-text | Better relevance scoring, horizontal scaling, dedicated indexes |

---

## Implementation Notes

This section documents the local "Baby Discord" implementation: what was built, what production patterns were included, and what was simplified.

### Local Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Browser Client                            │
│  React 19 + Zustand + TanStack Router + Tailwind CSS         │
│  LoginForm, ServerList, ChannelSidebar, MessageList           │
│  SSE (EventSource) for real-time ← ── ── REST for commands   │
└───────────────────────┬──────────────────────────────────────┘
                        │  HTTP (port 5173 via Vite proxy)
                        ▼
┌──────────────────────────────────────────────────────────────┐
│                    Baby Discord Server                        │
│              (Node.js + Express + TypeScript)                 │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              HTTP Adapter (port 3001)                 │    │
│  │  POST /api/connect     POST /api/command              │    │
│  │  POST /api/message     GET  /api/rooms                │    │
│  │  GET  /api/messages/:room  (SSE stream)               │    │
│  │  GET  /health          GET  /metrics (Prometheus)     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              TCP Adapter (port 9001)                   │    │
│  │  Line-based protocol via netcat/telnet                │    │
│  │  Nickname auth → slash commands → chat messages       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Core (transport-agnostic)                │    │
│  │  ChatHandler  → CommandParser  → RoomManager          │    │
│  │  ConnectionManager  → MessageRouter  → HistoryBuffer  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────┐                   ┌─────────────────────┐   │
│  │  PostgreSQL  │                   │  Valkey/Redis       │   │
│  │  (port 5432) │                   │  (port 6379)        │   │
│  │  Users,      │                   │  Pub/sub for        │   │
│  │  Rooms,      │                   │  cross-instance     │   │
│  │  Messages    │                   │  messaging          │   │
│  └─────────────┘                   └─────────────────────┘   │
└──────────────────────────────────────────────────────────────┘

Additional instances (for horizontal scaling testing):
  Instance 2: TCP 9002, HTTP 3002
  Instance 3: TCP 9003, HTTP 3003
```

### Production-Grade Patterns Actually Implemented

**1. Protocol Adapter Pattern** (`backend/src/adapters/`)
The core chat logic is completely transport-agnostic. The `ChatHandler` receives a sessionId and input string, and returns a `CommandResult`. TCP and HTTP adapters convert protocol-specific I/O into this uniform interface. This mirrors how production Discord handles WebSocket, REST API, and mobile push through different gateways backed by the same message service.

**2. Cross-Instance Messaging via Pub/Sub** (`backend/src/utils/pubsub.ts`)
Valkey/Redis pub/sub enables multi-instance deployments. Each room maps to a `room:{roomName}` channel. Messages include an `instanceId` to prevent self-delivery loops. Two Redis connections are used per instance (required by Redis pub/sub protocol: a connection in subscriber mode cannot publish). This directly mirrors Discord's use of Kafka for cross-gateway event fan-out.

**3. Prometheus Metrics** (`backend/src/shared/metrics.ts`)
Full observability with prom-client: active connections (gauge by transport), messages sent/received (counter by room), pub/sub publish latency (histogram), database query latency (histogram by operation), connection pool utilization, history buffer hit/miss rates, cleanup job runs, and command execution counts. Metrics are exposed at `/metrics` for Prometheus scraping.

**4. Structured Logging** (`backend/src/utils/logger.ts`)
Pino-based structured JSON logging with child loggers per subsystem (tcp, http, db). Log levels configurable via environment variable. Context fields (sessionId, roomName, instanceId) are attached to every log entry for correlation.

**5. Graceful Shutdown** (`backend/src/index.ts`)
Full drain-mode shutdown sequence: stop accepting new connections, notify connected clients, wait for in-flight messages to complete, flush database writes, disconnect from Redis, close database pool, flush logs, exit. Prevents message loss during deployments.

**6. Message Retention and Cleanup** (`backend/src/utils/cleanup.ts`)
Periodic cleanup job enforces configurable retention policies (count-based and age-based). Uses PostgreSQL window functions to identify messages beyond the per-room limit. Metrics track cleanup job health (runs, duration, messages deleted). This mirrors Discord's message lifecycle management, though Discord retains messages indefinitely and manages storage through Cassandra's compaction strategy.

**7. Health Checks** (`backend/src/adapters/http/observability-routes.ts`)
Comprehensive health endpoint reports database connectivity, Redis pub/sub status, active connection counts, and history buffer state. Used by monitoring systems and load balancers to detect unhealthy instances.

**8. Alert Threshold Configuration** (`backend/src/shared/config.ts`)
Configurable warning/critical thresholds for pub/sub latency, queue depth, database connection wait time, table sizes, and cache hit rates. The `checkThreshold()` helper enables programmatic threshold evaluation.

### What Was Simplified

| Production Feature | Local Substitute | Why |
|-------------------|------------------|-----|
| WebSocket gateway | SSE (EventSource) + REST POST | SSE is unidirectional but sufficient for server-to-client push; commands use POST. Avoids WebSocket handshake complexity |
| Cassandra for messages | PostgreSQL for everything | Single database simplifies local setup. Messages use the same relational DB with a cleanup function to bound storage |
| Snowflake IDs | PostgreSQL SERIAL | No need for distributed ID generation at local scale |
| Guild/server hierarchy | Flat rooms | No categories, roles, or permission bitfields. Rooms are created/joined directly |
| Bitfield permissions | No permission system | No roles or access control; any user can join any room |
| Voice/video (WebRTC SFU) | Not implemented | Voice requires UDP media servers, DTLS-SRTP, and SFU forwarding logic |
| Kafka for event fan-out | Redis pub/sub | Redis pub/sub has fire-and-forget semantics (no replay). Sufficient for 3 instances |
| OAuth2 / JWT auth | Nickname-based sessions | Users authenticate by providing a nickname; session tracked in-memory by UUID |
| CDN for media | No media support | No file uploads, avatars, or emoji |
| Elasticsearch for search | No search capability | Messages can only be viewed sequentially |
| Redis for caching | In-memory Maps | Room cache and history buffer are in-process Maps; lost on restart (reloaded from DB) |
| Multi-region deployment | Single machine, multiple ports | 3 instances on ports 3001/3002/3003 simulate distribution |

### What Was Omitted

- **Voice and video channels** (WebRTC SFU, Opus/VP8 codecs, DTLS-SRTP)
- **Guild permission system** (bitfield roles, channel overrides, hierarchy)
- **Message reactions, threads, embeds, and rich content**
- **User presence** (online/idle/DND tracking with Redis TTL)
- **Bot platform** (slash commands, webhooks, interaction endpoints)
- **Rate limiting** (token bucket per user/bot)
- **Multi-region deployment and geo-routing**
- **CDN and media pipeline** (avatar processing, attachment storage)
- **End-to-end message search** (Elasticsearch integration)
- **Kubernetes orchestration** (service discovery, auto-scaling, rolling deployments)

### Database Schema (Local)

The local implementation uses a simplified PostgreSQL schema stored in `backend/src/db/init.sql`:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (SERIAL PK), nickname (unique) | nickname | Simple nickname-based identity, no email/password |
| rooms | id (SERIAL PK), name (unique), created_by (FK) | name | Flat rooms, no categories or hierarchy |
| room_members | room_id + user_id (composite PK) | (inherits from PK) | Many-to-many junction, ON CONFLICT for re-joins |
| messages | id (SERIAL PK), room_id (FK), user_id (FK), content | (room_id, created_at DESC) | Cleanup function keeps last 10 per room |

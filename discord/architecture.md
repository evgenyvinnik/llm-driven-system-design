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

### 9. Caching Strategy

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

**Authorization:**
- Permission checks at the gateway level before forwarding to services
- Rate limiting: token bucket per user (50 req/s global) and per bot (varies by endpoint)
- IP rate limiting for unauthenticated endpoints (login, register)

**Data Protection:**
- TLS 1.3 for all WebSocket and HTTP connections
- DTLS-SRTP for voice/video streams
- Messages encrypted at rest in Cassandra (volume-level encryption)
- No end-to-end encryption for text (Discord can read messages for moderation/legal compliance)

---

## Observability

**Metrics (Prometheus):**
- Gateway: connections per node, events dispatched/sec, heartbeat failures, WebSocket errors
- Message service: messages/sec, write latency (p50/p99), Cassandra query latency
- Voice: active voice connections, packet loss rate, jitter
- Presence: updates/sec, Redis latency
- API: request rate, error rate (4xx, 5xx), latency by endpoint

**Logging:**
- Structured JSON logging (Pino/Bunyan) with request_id for correlation
- Log levels: DEBUG for development, INFO/WARN/ERROR in production
- Centralized logging via Fluentd -> Elasticsearch -> Kibana

**Alerting:**
- Gateway connection count > 80% capacity -> scale up
- Message delivery latency p99 > 200ms -> investigate Cassandra/Kafka
- Voice packet loss > 2% -> check network/voice server capacity
- Presence Redis latency > 50ms -> scale Redis cluster

**Health Checks:**
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

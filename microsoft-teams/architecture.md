# Microsoft Teams - Architecture

## System Overview

Microsoft Teams is an enterprise communication and collaboration platform that enables team-based messaging within organizational hierarchies. This project explores the design of a real-time chat system organized around organizations, teams, and channels, with support for threaded conversations, file sharing, emoji reactions, and user presence tracking.

**Learning goals:** Real-time messaging architecture, hierarchical resource modeling (org > team > channel), Server-Sent Events for push updates, presence tracking with TTL-based keys, and file storage with object storage integration.

## Requirements

### Functional Requirements
- Users create and join organizations, which contain teams and channels
- Channel-based messaging with threaded replies
- File uploads attached to channels/messages
- Emoji reactions on messages
- Real-time message delivery via SSE
- User presence (online/offline) indicators
- User search for adding members

### Non-Functional Requirements (Production Scale)
- 99.99% uptime for messaging delivery
- p99 message delivery latency < 200ms
- Support 10M concurrent users across 500K organizations
- Message storage: 1B+ messages retained for compliance
- File uploads up to 250MB per file
- Presence updates within 60 seconds of state change

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| Concurrent users | 10M | Peak-hour active sessions |
| Organizations | 500K | Enterprise tenants |
| Messages/day | 5B | ~500 msgs/user/day |
| Message size (avg) | 500 bytes | Text + metadata |
| Daily message storage | 2.5 TB | 5B x 500B |
| File uploads/day | 50M | ~5 files/user/day |
| SSE connections | 10M | One per active user |
| Presence heartbeats/sec | 333K | 10M users / 30s interval |

### Storage Growth (Annual)

| Data | Growth/Year | 5-Year Total |
|------|-------------|--------------|
| Messages | ~900 TB | 4.5 PB |
| Files | ~500 TB (avg 10KB compressed metadata, objects in S3) | 2.5 PB |
| User/org metadata | ~50 GB | 250 GB |

## High-Level Architecture

```
┌──────────────┐      ┌──────────────┐
│              │      │              │
│   React SPA  │─────▶│     CDN      │  (static assets, file downloads)
│  (Vite/TS)   │      │              │
│              │      └──────────────┘
└──────┬───────┘
       │  HTTPS
       ▼
┌──────────────┐      ┌──────────────────────────────────────────────────────┐
│              │      │                  Backend Services                     │
│  API Gateway │─────▶│                                                      │
│  (nginx/ALB) │      │  ┌────────────┐  ┌────────────┐  ┌────────────┐    │
│              │      │  │   Auth      │  │  Message   │  │  Presence  │    │
└──────────────┘      │  │  Service    │  │  Service   │  │  Service   │    │
       ▲              │  └────────────┘  └─────┬──────┘  └─────┬──────┘    │
       │              │                        │               │            │
       │  SSE         │  ┌────────────┐  ┌────┴───────┐  ┌────┴───────┐   │
       │  Stream      │  │   File     │  │  Message   │  │  Redis     │   │
       └──────────────│  │  Service   │  │  Queue     │  │  TTL Keys  │   │
                      │  └─────┬──────┘  │  (Kafka)   │  └────────────┘   │
                      │        │         └────────────┘                     │
                      └────────┼───────────────────────────────────────────┘
                               │
            ┌─────────────┐  ┌─┴───────────┐  ┌─────────────┐  ┌──────────────┐
            │ PostgreSQL   │  │    S3       │  │   Redis     │  │ Elasticsearch │
            │ (Messages,   │  │  (File      │  │ (Sessions,  │  │  (Message     │
            │  Orgs, Users)│  │  Storage)   │  │  Presence,  │  │   Search)     │
            └─────────────┘  └─────────────┘  │  Pub/Sub)   │  └──────────────┘
                                               └─────────────┘
```

## Core Components

### Organization Hierarchy

The resource hierarchy follows: **Organization > Team > Channel > Message/Thread**. This mirrors enterprise structures where a company (org) contains cross-functional teams, each with topic-specific channels.

- **Organizations** are top-level containers with unique slugs. At production scale, each org maps to a tenant with isolated data access policies.
- **Teams** belong to one organization and can be public or private. Team membership gates access to all contained channels.
- **Channels** belong to one team; creating a team auto-creates a "General" channel. Channels are the primary unit of real-time subscription.
- **Messages** belong to channels; thread replies reference a `parent_message_id`. This self-referencing design supports flat threading (one level deep) without a separate threads table.

### Real-Time Messaging

Messages flow through a pub/sub pipeline:

1. Client sends POST to `/api/messages`
2. Server validates, persists to PostgreSQL, and returns acknowledgement
3. Server publishes to Redis pub/sub channel `teams:channel:{channelId}`
4. All server instances subscribed to that channel receive the event
5. Each server pushes the message to connected SSE clients for that channel

At production scale, a message queue (Kafka) sits between the write path and the fan-out layer. Kafka provides durability for messages during server restarts, enables replay for missed events, and decouples write throughput from SSE delivery speed. Redis pub/sub handles the last-mile delivery from each server instance to its connected SSE clients.

### Presence System

Presence uses Redis keys with a 60-second TTL:

- Client sends heartbeat every 30 seconds to `/api/presence/heartbeat`
- Server sets `presence:{userId}` with 60-second TTL
- If heartbeat stops (tab closed, network loss), key expires automatically
- Querying presence uses Redis pipeline to check multiple keys in one round trip

At 10M concurrent users generating heartbeats every 30 seconds, the presence system handles ~333K writes/sec. This is within a single Redis cluster's capacity, but at larger scale, presence would be sharded by user ID hash across multiple Redis instances.

### File Storage

Files are uploaded through the API, then streamed to object storage:

- Upload: `POST /api/files` with multipart form data
- Storage path: `channels/{channelId}/{fileId}.{ext}`
- Download: presigned URLs (1-hour expiry) via `GET /api/files/:fileId/download`
- At production scale, a CDN sits in front of S3 to cache frequently accessed files and offload bandwidth from the origin

## Database Schema

The schema contains 10 tables modeling the organizational hierarchy, messaging, and file storage.

```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  parent_message_id UUID REFERENCES messages(id),
  content TEXT NOT NULL,
  is_edited BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  emoji VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100),
  size_bytes BIGINT,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_parent ON messages(parent_message_id);
CREATE INDEX idx_reactions_message ON message_reactions(message_id);
CREATE INDEX idx_files_channel ON files(channel_id);
CREATE INDEX idx_files_message ON files(message_id);
CREATE INDEX idx_org_members ON org_members(user_id);
CREATE INDEX idx_team_members ON team_members(user_id);
CREATE INDEX idx_channel_members ON channel_members(user_id);
```

Key schema design decisions:

- **UUID primary keys** across all tables for distributed ID generation without coordination
- **Cascading deletes** from parent to child (org > team > channel > message) for referential integrity
- **Composite unique constraints** prevent duplicate memberships (org_members, team_members, channel_members)
- **`parent_message_id`** self-reference on messages enables threaded replies without a separate table
- **`last_read_at`** on channel_members tracks read position per user per channel for unread badges
- **Reaction uniqueness** enforced by `(message_id, user_id, emoji)` constraint -- one reaction per emoji per user
- **`idx_messages_channel`** on `(channel_id, created_at DESC)` enables efficient paginated message loading with cursor-based pagination

## API Design

### Authentication
```
POST /api/auth/register    → Create account
POST /api/auth/login       → Login, create session
POST /api/auth/logout      → Destroy session
GET  /api/auth/me          → Current user info
```

### Organizations
```
GET  /api/organizations              → List user's organizations
POST /api/organizations              → Create organization
GET  /api/organizations/:orgId       → Get organization details
GET  /api/organizations/:orgId/members → List org members
POST /api/organizations/:orgId/members → Add member to org
```

### Teams
```
GET  /api/teams?orgId=xxx           → List teams in org
POST /api/teams                     → Create team (auto-creates General channel)
GET  /api/teams/:teamId             → Get team details
GET  /api/teams/:teamId/members     → List team members
POST /api/teams/:teamId/members     → Add member to team
```

### Channels
```
GET  /api/channels?teamId=xxx        → List channels in team
POST /api/channels                   → Create channel
GET  /api/channels/:channelId        → Get channel details
GET  /api/channels/:channelId/members → List channel members
POST /api/channels/:channelId/members → Add member to channel
POST /api/channels/:channelId/read   → Mark channel as read
```

### Messages
```
GET    /api/messages?channelId=xxx&before=xxx&limit=50 → Paginated messages
GET    /api/messages/:messageId/thread                 → Thread messages
POST   /api/messages                                   → Send message
PUT    /api/messages/:messageId                        → Edit message
DELETE /api/messages/:messageId                        → Delete message
```

### Reactions, Files, Presence, SSE
```
POST   /api/reactions                → Add reaction
DELETE /api/reactions                → Remove reaction
POST   /api/files                   → Upload file (multipart)
GET    /api/files/:fileId/download  → Get presigned download URL
GET    /api/files?channelId=xxx     → List channel files
POST   /api/presence/heartbeat      → Send presence heartbeat
GET    /api/presence/channel/:id    → Get channel member presence
GET    /api/sse/:channelId          → SSE stream for real-time updates
```

## Key Design Decisions

### SSE vs WebSocket for Real-Time Transport

We chose SSE over WebSocket because the message flow is asymmetric: clients send messages via REST POST (which gives us proper request/response semantics with status codes and error handling) and receive updates via server push. SSE is HTTP-native, works through all proxies and load balancers without special configuration, and the browser's `EventSource` API provides automatic reconnection with last-event-ID tracking for free. The trade-off is that SSE is unidirectional -- if we later needed bidirectional streaming (e.g., typing indicators at high frequency), WebSocket would be more efficient. For a chat system where the "write" path (sending messages) naturally fits REST semantics, SSE's simplicity wins.

### Redis Pub/Sub vs Kafka for Cross-Instance Messaging

Redis pub/sub delivers messages to all subscribed server instances with sub-millisecond latency, which is critical for chat's perceived responsiveness. Kafka would add 5-10ms of latency per message due to disk writes and consumer group coordination. However, Redis pub/sub has no durability -- if a server instance is restarting when a message is published, that message is lost for its clients. For a chat application, this is acceptable because clients can fetch missed messages via the REST API on reconnect. At larger scale (>1M concurrent users), we would add Kafka as a durable write-ahead log between the message service and the pub/sub layer, using Redis only for last-mile fan-out.

### Self-Referencing Thread Model

Threads use a `parent_message_id` foreign key back to the messages table rather than a separate threads table. This works because Teams uses flat threads (one level deep) -- a reply always points to a top-level message. The trade-off is that deeply nested threading (like Reddit-style comment trees) is not supported. For enterprise chat, flat threading is the correct UX choice: it keeps conversations focused and prevents the "reply to a reply to a reply" confusion. The query pattern is simple: fetch top-level messages with `WHERE parent_message_id IS NULL`, then fetch thread replies with `WHERE parent_message_id = :id`.

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time transport | SSE | WebSocket | Simpler server-side, sufficient for unidirectional push; messages sent via REST |
| Cross-instance messaging | Redis pub/sub | Kafka | Lower latency for real-time chat; no durability needed for push |
| Presence tracking | Redis TTL keys | Database polling | Sub-second state change detection, automatic cleanup on disconnect |
| Thread model | Self-referencing FK | Separate threads table | Simpler schema, thread is just a message with `parent_message_id` |
| File storage | S3/MinIO | Database BLOBs | Scalable object storage, presigned URLs offload download bandwidth |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler invalidation |
| Org hierarchy | Org > Team > Channel | Flat channel list | Mirrors enterprise structure, enables per-level access control |

## Consistency and Idempotency

- **Message creation** uses client-generated UUIDs as idempotency keys. If a client retries a failed POST, the server detects the duplicate UUID via unique constraint and returns the existing message rather than creating a duplicate.
- **Reaction toggle** uses `ON CONFLICT DO NOTHING` for adds and explicit deletes for removes -- both operations are naturally idempotent.
- **Membership operations** use `ON CONFLICT DO NOTHING` to handle duplicate join requests gracefully.
- **Read position** updates use `UPDATE ... SET last_read_at = NOW()` which is naturally idempotent -- reapplying the same operation produces the same result.
- **File uploads** use a two-phase approach: first reserve a file ID, then upload to S3 with that ID as the key. Retrying the upload overwrites the same key.

## Security and Auth

- Session-based authentication with Redis-backed store (immediate revocation on logout)
- Password hashing with bcryptjs (cost factor 10)
- Rate limiting: 1000 req/15min for API, 50 req/15min for auth, 120 msg/min for messages
- HTTP-only, SameSite cookies prevent CSRF and XSS-based session theft
- File upload size limited to 50MB per request
- At production scale: OAuth2/SAML integration for enterprise SSO, mTLS between services, encryption at rest for messages and files

## Observability

- **Prometheus metrics**: HTTP request duration/count by endpoint, SSE active connections gauge, messages sent counter, presence heartbeat rate, Redis pub/sub message count
- **Structured logging**: Pino with JSON output, request correlation via pino-http for tracing message flow across services
- **Health check**: `GET /api/health` verifies database connectivity and Redis reachability for load balancer health probes
- **At production scale**: Distributed tracing (Jaeger/OpenTelemetry), Grafana dashboards for SLO tracking, PagerDuty alerting on p99 latency spikes and error rate thresholds

## Failure Handling

- **Circuit breakers** (Opossum) wrap external service calls (Redis, MinIO) with 10s timeout and 50% error threshold. When Redis pub/sub fails, the circuit opens and messages are still delivered to clients connected to the same server instance via in-process EventEmitter -- degraded but not broken.
- **Redis reconnection**: Exponential backoff with max 2s delay and lazy connect to avoid thundering herd on recovery.
- **SSE heartbeat**: 30-second keepalive prevents proxy timeouts and detects stale connections. If a client misses heartbeats, the server closes the connection and frees resources.
- **Graceful shutdown**: SIGTERM/SIGINT handlers close the server, drain SSE connections, flush pub/sub, and close database pool in order.
- **Database connection pool**: Max 20 connections, 5s connect timeout, 30s idle timeout. Pool exhaustion triggers queuing with backpressure rather than connection storms.

## Scalability Considerations

**What breaks first at scale:**

1. **SSE connections** -- Each server holds connections in memory. At 100K users per server, memory becomes the bottleneck (~500MB just for connection buffers). Solution: dedicated SSE gateway servers with sticky sessions, or migrate to WebSocket with connection pooling at the gateway layer.

2. **Message table** -- A single PostgreSQL table with billions of rows. Full-table scans for old messages become untenable. Solution: partition by `(channel_id, created_at)` using range partitioning, archive partitions older than 1 year to cold storage, or migrate hot channels to Cassandra for write-optimized time-series access.

3. **Redis pub/sub** -- Fan-out to many subscribers on popular channels with 10K+ members creates O(N) work per message. Solution: channel-based sharding across Redis clusters, with a routing layer that maps channel IDs to specific Redis nodes.

**Scaling path:**
- Horizontal API scaling behind a load balancer (SSE requires sticky sessions or shared pub/sub)
- Read replicas for message history queries (eventual consistency acceptable for historical data)
- Separate write and read paths for messages (CQRS) with async replication
- CDN for static assets and file downloads
- Message search via Elasticsearch with async indexing from the write path
- Multi-region deployment with per-region message routing and cross-region replication for org metadata

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| SSE over WebSocket | Simpler, HTTP-native | WebSocket for bidirectional | Messages sent via REST, only push needed |
| Single PostgreSQL | Simpler operations | Sharded cluster | Partition by channel_id when table exceeds 1B rows |
| Redis pub/sub | Low latency (<1ms) | Kafka | Chat needs speed over durability; fetch missed msgs on reconnect |
| Self-referencing threads | Simple schema, fast queries | Separate table | One table handles both top-level and replies |
| Presigned URLs for files | Offloads bandwidth | Proxy through API | CDN-compatible, scales independently |
| Session auth | Immediate revocation | JWT | Enterprise apps need instant session kill |

## Frontend Architecture

This section documents the React frontend implementation, covering component hierarchy, state management, routing, data fetching, and key UI patterns.

### Component Hierarchy

```
__root.tsx (RootComponent)
├── Loading spinner (shown while checkAuth runs)
├── Redirect to /login (if not authenticated)
├── index.tsx (Landing / Redirect to first org)
├── login.tsx / register.tsx (Auth Pages)
├── org.tsx (Org Layout)
│   └── org.$orgId.tsx (Org Selected)
│       ├── Sidebar (components/Sidebar.tsx)
│       │   ├── OrgSelector (components/OrgSelector.tsx)
│       │   │   └── Org name dropdown with switch
│       │   ├── ChannelList (components/ChannelList.tsx)
│       │   │   └── Channel names with create button
│       │   ├── CreateChannelModal (components/CreateChannelModal.tsx)
│       │   └── SearchUsers (components/SearchUsers.tsx)
│       └── org.$orgId.team.$teamId.tsx (Team Selected)
│           └── org.$orgId.team.$teamId.channel.$channelId.tsx (Channel View)
│               ├── ChatArea (components/ChatArea.tsx)
│               │   ├── MessageList (components/MessageList.tsx)
│               │   │   └── MessageItem (components/MessageItem.tsx) [repeated]
│               │   │       ├── User avatar + display name
│               │   │       ├── Message content
│               │   │       ├── FileAttachment (components/FileAttachment.tsx)
│               │   │       ├── ReactionPicker (components/ReactionPicker.tsx)
│               │   │       ├── Reaction badges (emoji + count)
│               │   │       ├── Thread reply count link
│               │   │       └── TypingIndicator (components/TypingIndicator.tsx)
│               │   └── MessageInput (components/MessageInput.tsx)
│               │       └── Text input + file attachment button + send
│               ├── ThreadPanel (components/ThreadPanel.tsx) [conditional]
│               │   ├── Parent message display
│               │   ├── Thread reply list
│               │   └── Thread reply input
│               └── MemberList (components/MemberList.tsx) [conditional]
│                   └── Member names with PresenceIndicator (components/PresenceIndicator.tsx)
```

### Zustand Stores

The frontend uses two Zustand stores:

**`useAuthStore`** (`stores/authStore.ts`) -- Manages authentication state: current user, loading flag, and error message. Provides login, register, logout, and `checkAuth` actions. Unlike other projects in this repository, this store does not use `persist` middleware -- session state is maintained server-side via cookies, and `checkAuth` calls `GET /api/auth/me` on every page load to restore the session. The root component redirects to `/login` when `checkAuth` completes without finding a valid session.

**`useChatStore`** (`stores/chatStore.ts`) -- The primary application store, managing the full org/team/channel/message hierarchy plus real-time features. It holds:
- **Data arrays**: organizations, teams, channels, messages, threadMessages, channelMembers
- **Selection state**: currentOrgId, currentTeamId, currentChannelId, threadParentId
- **UI state**: loading, sseConnection (EventSource reference), showMemberList toggle
- **Actions**: loadOrganizations, loadTeams, loadChannels, loadMessages, loadMoreMessages, loadThread, loadChannelMembers, sendMessage, sendThreadReply, setCurrentOrg/Team/Channel, openThread, closeThread, toggleMemberList, connectSSE, disconnectSSE, addMessageFromSSE, startPresenceHeartbeat

The store follows a cascading selection pattern: setting a new org clears teams/channels/messages and triggers `loadTeams`. Setting a new team clears channels/messages and triggers `loadChannels`. Setting a new channel clears messages, disconnects the old SSE connection, triggers `loadMessages`, `loadChannelMembers`, and `connectSSE` for the new channel. This cascade ensures UI state stays consistent with the hierarchical navigation.

### Routing

The frontend uses TanStack Router with deeply nested file-based routes that mirror the org > team > channel hierarchy:

- `/login`, `/register` -- Authentication pages
- `/` -- Landing page (redirects to first org after login)
- `/org` -- Org layout wrapper
- `/org/$orgId` -- Organization selected (shows sidebar with teams/channels)
- `/org/$orgId/team/$teamId` -- Team selected (shows team's channels in sidebar)
- `/org/$orgId/team/$teamId/channel/$channelId` -- Channel selected (shows ChatArea + optional ThreadPanel and MemberList)

This nested route structure means the URL fully encodes the navigation state. Sharing a URL like `/org/abc/team/def/channel/ghi` lets another user navigate directly to that channel. Each route segment triggers data loading at its level: the org route loads teams, the team route loads channels, and the channel route loads messages and connects SSE.

### Data Fetching

API communication is organized into domain-specific client objects (`services/api.ts`):

- **`authApi`** -- login, register, logout, session check (`me`)
- **`orgApi`** -- list orgs, create org, get org details, manage org members
- **`teamApi`** -- list teams by org, create team (auto-creates General channel), manage team members
- **`channelApi`** -- list channels by team, create channel, manage channel members, mark as read
- **`messageApi`** -- list messages (with `before` cursor for pagination), get thread, send message (with optional parent for threads), edit, delete
- **`reactionApi`** -- add and remove emoji reactions
- **`fileApi`** -- upload (multipart FormData, not JSON), download (returns presigned URL), list by channel
- **`presenceApi`** -- heartbeat (POST every 30s), get channel member presence
- **`userApi`** -- search users, get user profile

All clients except `fileApi.upload` use a shared `request` wrapper with `credentials: 'include'` for session cookie authentication and JSON content type. The file upload method uses `FormData` instead of JSON, requiring a separate fetch call without the JSON content type header.

### Key UI Patterns

- **SSE-driven real-time updates**: When a channel is selected, the chat store opens an `EventSource` connection to `/api/sse/{channelId}`. The SSE stream delivers four event types: `new_message`, `message_edited`, `reaction_added`, and `reaction_removed`. Each event triggers a targeted state update -- new messages are appended, edits replace the existing message, and reactions are incremented/decremented in place. The SSE connection is closed and reopened when switching channels.
- **Optimistic thread updates**: When sending a thread reply, the store appends the reply to `threadMessages` immediately from the API response, without waiting for the SSE event. The SSE listener also handles thread replies (checking `parent_message_id`) and deduplicates by message ID.
- **Presence heartbeat lifecycle**: The `startPresenceHeartbeat` action returns a cleanup function that clears the 30-second interval. This is designed to be called from a `useEffect` return value, tying the heartbeat lifecycle to the component lifecycle. The heartbeat fires every 30 seconds; if it stops (tab closed, network loss), the Redis TTL key expires after 60 seconds, and the user shows as offline.
- **Cascading navigation resets**: Changing the org resets teams, channels, and messages. Changing the team resets channels and messages. Changing the channel resets messages and disconnects/reconnects SSE. This prevents stale data from a previous selection from appearing during navigation transitions.
- **Conditional side panels**: The ThreadPanel and MemberList render conditionally based on `threadParentId` (non-null when a thread is open) and `showMemberList` (toggled by user action). Both panels slide in alongside the ChatArea without replacing it, maintaining the chat context while providing additional information.
- **Cursor-based message pagination**: Messages are loaded with a `before` cursor pointing to the oldest loaded message's `created_at`. The `loadMoreMessages` action prepends older messages to the beginning of the array, maintaining chronological order for the chat view.
- **URL-driven state**: Because the full org/team/channel path is encoded in the URL, browser back/forward navigation and direct URL sharing work correctly. Route parameters drive data loading via `useEffect` hooks in each route component.

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, written for readers who may be encountering these concepts for the first time.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles rather than individual users, and users are assigned one or more roles. Instead of checking "can user X create a channel?" the system checks "does user X have a role that includes the create-channel permission?"

In this project, RBAC operates at multiple levels of the hierarchy. At the system level, users have a `role` field (user/admin). At the organization level, `org_members` have a `role` field (member/admin). At the team level, `team_members` have a `role` field (member/admin). This hierarchical RBAC mirrors enterprise permission structures where a company admin has different powers than a team lead.

The key advantage is scalability of permission management. With 500K organizations and millions of users, you cannot manage individual permissions. Instead, promoting a user to "team admin" grants them all team-admin permissions (create channels, manage members) without touching a permission table. The trade-off is granularity -- you cannot give a user "create channels but not manage members" without introducing a new role.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application code is responsible for managing the cache. On every read, the application first checks the cache. If the data is there (a "cache hit"), it returns immediately. If not (a "cache miss"), the application fetches from the database, stores the result in the cache with a TTL (time-to-live), and then returns it.

In this project, Redis serves multiple caching roles: session storage (24-hour TTL via connect-redis), and presence state (60-second TTL keys). The session cache is write-through rather than cache-aside: sessions are written to Redis on login and read from Redis on every request, with the database not involved. Presence uses a TTL-based pattern that is a variant of cache-aside: the client "writes" presence by setting a key with a 60-second TTL, and readers check for the key's existence. If the key exists, the user is online; if it has expired, the user is offline.

The presence caching pattern is elegant because it requires no cleanup logic. Traditional presence systems need a background job to detect disconnected users and mark them offline. With TTL-based keys, the absence of a heartbeat causes the key to automatically expire -- Redis does the cleanup. The trade-off is a staleness window: a user who closes their browser will appear online for up to 60 seconds until the TTL expires.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents a failing service from being called repeatedly, giving it time to recover. It works like an electrical circuit breaker: when failures exceed a threshold, the breaker "opens" and immediately rejects all requests for a cooldown period, rather than letting them pile up and make the problem worse.

The circuit breaker has three states. In the **closed** state (normal operation), requests flow through to the downstream service. If failures exceed a configured threshold (50% error rate in this project), the breaker transitions to the **open** state. In the open state, all requests are immediately rejected without contacting the downstream service. After a configured timeout (10 seconds), the breaker enters the **half-open** state, where it allows a small number of test requests through. If those succeed, the breaker closes again; if they fail, it reopens.

In this project, circuit breakers (via the Opossum library) wrap calls to Redis and MinIO with a 10-second timeout and 50% error threshold. When Redis pub/sub fails, the circuit opens and the system falls back to in-process EventEmitter for message delivery. This means messages are still delivered to SSE clients connected to the same server instance -- degraded (no cross-instance delivery) but not broken. Without the circuit breaker, Redis connection timeouts would cause every message send to hang for 10 seconds, creating a cascading failure where the chat appears completely frozen.

### Structured Logging

Structured logging means emitting log entries as machine-parseable data (typically JSON objects) rather than free-form text strings. Instead of `console.log('User 123 sent message to channel abc')`, structured logging produces `{"level":"info","userId":"123","channelId":"abc","action":"sendMessage","messageLength":145,"timestamp":"..."}`.

This project uses Pino with pino-http for automatic request logging. Every HTTP request generates a log entry with method, path, status code, response time, and the authenticated user's ID (via request correlation). For debugging real-time message flows, the structured logs let you trace a message from the REST POST through Redis pub/sub to SSE delivery across server instances, by filtering on the message ID or channel ID.

The primary advantage over `console.log` is post-hoc analysis. When investigating why a user did not receive a message, you can query logs for that user's channel and timeframe to see whether the message was published to Redis pub/sub, whether the SSE connection was active, and whether the delivery event fired. With unstructured logs, this investigation would require reading through pages of text output manually.

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical metrics from applications by periodically "scraping" an HTTP endpoint (typically `/metrics`). The application exposes counters, histograms, and gauges in a text format that Prometheus understands, and Prometheus stores and queries this data over time.

The three main metric types used in this project are:
- **Counters**: Values that only go up (e.g., messages sent counter, Redis pub/sub message count). Useful for computing rates (messages per second).
- **Histograms**: Track the distribution of values (e.g., HTTP request duration by endpoint). Enable percentile monitoring -- "are 99% of message sends completing within 200ms?"
- **Gauges**: Values that go up or down (e.g., SSE active connections, presence heartbeat rate). The SSE connections gauge is particularly important for capacity planning: each server can hold a limited number of concurrent SSE connections in memory (~100K before memory becomes the bottleneck).

The SSE connections gauge is a key operational metric for this project. If it approaches the server's capacity, the operations team needs to add more server instances behind the load balancer. Unlike stateless HTTP requests that can be distributed freely, SSE connections are sticky -- a client's connection lives on one server for its entire lifetime. The gauge shows the actual distribution of connections across instances.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. It protects the system from abuse, prevents any single client from monopolizing resources, and ensures fair access for all users.

This project implements tiered rate limiting with three different windows tailored to different threat models:
- **Auth endpoints** (50 requests/15 minutes): Prevents brute force password attacks while allowing legitimate login retries
- **General API** (1000 requests/15 minutes): Standard abuse prevention for all endpoints
- **Message sending** (120 messages/minute): Prevents chat spam while allowing rapid conversation (2 messages/second)

The implementation uses express-rate-limit with a Redis-backed store for cross-instance rate counting. This is critical for horizontal scaling: if rate limits were tracked in-memory on each server, a user could send 120 messages/minute to each of 5 servers, effectively getting a 600/minute limit. Redis-backed counting ensures the limit is global across all instances.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. In a chat application, this prevents duplicate messages when a client retries a failed send.

This project achieves idempotency through client-generated UUIDs as message IDs. The messages table has a UUID primary key, and if a client retries a message send with the same ID (because it did not receive the response), the database's unique constraint prevents duplication. The server returns the existing message rather than creating a duplicate.

Reactions use `ON CONFLICT DO NOTHING` for adds -- toggling a reaction on twice has no effect. Membership operations (join team, join channel) use the same pattern via composite unique constraints like `UNIQUE(team_id, user_id)`. Read position updates (`SET last_read_at = NOW()`) are naturally idempotent because reapplying the same timestamp produces the same result.

These constraint-based approaches are simpler than explicit idempotency key management (as used in payment systems) because chat operations have no external side effects. A duplicate message insert is caught by the database; a duplicate reaction is silently ignored. The trade-off is that this only works for operations where the database is the sole side effect.

### Health Checks

Health checks are HTTP endpoints that report whether a service is alive and ready to handle traffic. They are consumed by load balancers, container orchestrators (Kubernetes), and monitoring systems to make automated decisions about routing and restarts.

This project implements a single health check endpoint at `GET /api/health` that verifies database connectivity and Redis reachability. If the database is unreachable, the endpoint returns a non-200 status, signaling the load balancer to stop routing traffic to this instance.

For a chat application, the health check is particularly important because of SSE connections. When a server instance is unhealthy and removed from the load balancer, existing SSE connections on that instance break. Clients detect the break via EventSource's built-in error handling and automatically reconnect, which the load balancer routes to a healthy instance. This reconnection is transparent to the user -- they see a brief "reconnecting" state and then resume receiving messages. The health check enables this graceful failover by detecting unhealthy instances before they accumulate stale SSE connections.

---

## Implementation Notes

### Local Setup Diagram

```
┌─────────────────┐         ┌──────────────────────────────────────┐
│   React SPA     │         │        Express Server                │
│  localhost:5173  │────────▶│        localhost:3000                │
│  (Vite + TS)    │◀── SSE ─│                                      │
└─────────────────┘         │  Routes: auth, orgs, teams,          │
                            │  channels, messages, reactions,      │
                            │  files, presence, sse, users         │
                            │                                      │
                            │  Services: pubsub, presence,         │
                            │  storage, metrics, circuitBreaker,   │
                            │  rateLimiter, logger                 │
                            └──────┬──────────┬──────────┬─────────┘
                                   │          │          │
                            ┌──────┴───┐ ┌────┴────┐ ┌──┴──────┐
                            │PostgreSQL│ │ Valkey  │ │  MinIO  │
                            │  :5432   │ │  :6379  │ │ :9000   │
                            │  teams   │ │sessions,│ │  files  │
                            │          │ │presence,│ │         │
                            │          │ │ pub/sub │ │         │
                            └──────────┘ └─────────┘ └─────────┘
```

### Production-Grade Patterns Implemented

1. **Redis pub/sub for cross-instance messaging** -- Enables horizontal scaling by broadcasting messages through Redis rather than relying on in-process EventEmitter alone. Each server subscribes to channels its connected clients are viewing. See `src/services/pubsub.ts`.

2. **Prometheus metrics** (prom-client) -- Tracks HTTP request latency histograms, SSE connection gauge, message throughput counter, and presence heartbeat rate. Exposed at `/metrics` for Prometheus scraping. See `src/services/metrics.ts`.

3. **Structured logging** (Pino) -- JSON-formatted logs with request correlation via pino-http. Every log entry includes service name, timestamp, and request context for debugging distributed message flows. See `src/services/logger.ts`.

4. **Circuit breakers** (Opossum) -- Protect against cascading failures when Redis or MinIO become unavailable. Configured with 10s timeout, 50% error threshold, and 10s reset window. See `src/services/circuitBreaker.ts`.

5. **Rate limiting** -- Tiered limits: auth (50/15min), general API (1000/15min), and messaging (120/min). Uses express-rate-limit with Redis-backed store for cross-instance rate counting. See `src/services/rateLimiter.ts`.

6. **Health check endpoint** -- `GET /api/health` verifies database connectivity for load balancer integration.

### Simplifications vs Production

| Component | Local Implementation | Production Equivalent |
|-----------|---------------------|----------------------|
| Database | Single PostgreSQL instance | Sharded cluster with read replicas |
| File storage | MinIO on localhost:9000 | AWS S3 + CloudFront CDN |
| Session store | Valkey on localhost:6379 | Redis Cluster with replication |
| Auth | Session cookies + bcrypt | OAuth2/SAML enterprise SSO |
| Real-time transport | SSE (sufficient for unidirectional) | SSE or WebSocket behind API Gateway |
| Message bus | In-process EventEmitter + Redis pub/sub | Kafka for durability + Redis for last-mile |
| Search | Not implemented | Elasticsearch with async indexing |
| Load balancer | Single server instance | nginx/ALB with sticky sessions |

### Omitted from Local Implementation
- CDN for file delivery and static assets
- Multi-region deployment and geo-routing
- Kubernetes orchestration and auto-scaling
- Message search (Elasticsearch)
- Video/audio calling (WebRTC)
- End-to-end encryption
- SAML/OAuth2 enterprise SSO
- Message retention policies and compliance archival
- Distributed tracing (OpenTelemetry/Jaeger)

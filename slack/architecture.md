# Design Slack - Architecture

## System Overview

Slack is a team communication platform built around real-time messaging within isolated workspaces. Core challenges include low-latency message delivery across millions of concurrent connections, workspace tenant isolation, threading and conversation models, full-text search across message history, and an extensible integration platform.

**Learning Goals:**
- Build real-time messaging with WebSocket + Redis pub/sub fan-out
- Design threading/reply models with atomic counters
- Implement multi-tenant workspace isolation with RBAC
- Handle search at scale with Elasticsearch and PostgreSQL FTS fallback
- Apply production-grade patterns: idempotency, rate limiting, caching, structured logging, Prometheus metrics

---

## Requirements

### Functional Requirements

1. **Workspaces**: Isolated team environments with role-based membership (owner, admin, member, guest)
2. **Channels**: Public and private organized conversations within a workspace
3. **Direct Messages**: One-on-one and group private conversations
4. **Messages**: Send, edit, delete with real-time delivery to all channel members
5. **Threads**: Reply to specific messages with reply count tracking
6. **Reactions**: Add/remove emoji reactions on messages
7. **Search**: Full-text search across messages with filters (channel, user, date range)
8. **Presence**: Online/away/offline status with real-time updates
9. **Typing Indicators**: Real-time typing notifications within channels
10. **File Sharing**: Upload and attach files to messages
11. **Notifications**: Push notifications, email digests, @mention tracking
12. **Integrations**: Incoming webhooks, slash commands, bot users

### Non-Functional Requirements

- **Latency**: < 200ms message delivery end-to-end (p99)
- **Availability**: 99.99% for messaging pipeline
- **Scale**: 10M workspaces, 500M daily active users, 1B messages/day
- **Ordering**: Messages appear in consistent order across all clients
- **Durability**: Zero message loss once acknowledged by server
- **Consistency**: Strong consistency for message ordering within a channel; eventual consistency acceptable for search indexing, presence, and read receipts

---

# Layer 1: Production-Ready Architecture

This section describes how Slack would work at production scale with millions of concurrent users, billions of messages, and multi-region deployments.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                       │
│          Desktop App │ Web (React) │ Mobile (React Native)                   │
└─────────────────────────────────────────────────────────────────────────────┘
                    │ HTTPS / WSS                │ HTTPS
                    ▼                            ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│         CDN (CloudFront)     │    │     Global Load Balancer     │
│   Static assets, emoji,     │    │   (Route 53 / GeoDNS)        │
│   avatars, file thumbnails  │    │                              │
└──────────────────────────────┘    └──────────────┬───────────────┘
                                                   │
                              ┌────────────────────┼────────────────────┐
                              ▼                    ▼                    ▼
                  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
                  │  WebSocket GW   │  │  WebSocket GW   │  │  WebSocket GW   │
                  │  (Region A)     │  │  (Region B)     │  │  (Region C)     │
                  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘
                           │                    │                    │
                           └────────────────────┼────────────────────┘
                                                │
                              ┌─────────────────┼─────────────────┐
                              ▼                 ▼                 ▼
                  ┌─────────────────┐  ┌────────────────┐  ┌──────────────┐
                  │  API Gateway    │  │  API Gateway   │  │  API Gateway │
                  │  (Auth, Rate    │  │                │  │              │
                  │   Limit, Route) │  │                │  │              │
                  └────────┬────────┘  └────────┬───────┘  └──────┬───────┘
                           │                    │                 │
          ┌────────────────┼──────────┬─────────┼─────────────────┤
          ▼                ▼          ▼         ▼                 ▼
┌──────────────┐ ┌──────────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────┐
│  Message     │ │  Channel     │ │ Presence│ │  Search  │ │  File        │
│  Service     │ │  Service     │ │ Service │ │  Service │ │  Service     │
│              │ │              │ │         │ │          │ │              │
│ - Send/Recv  │ │ - CRUD       │ │ - Track │ │ - Index  │ │ - Upload     │
│ - Thread     │ │ - Membership │ │ - Heart │ │ - Query  │ │ - Virus Scan │
│ - React      │ │ - DMs        │ │ - Broad │ │ - Filter │ │ - Thumbnail  │
│ - Edit/Del   │ │ - Unread     │ │   cast  │ │          │ │ - CDN link   │
└──────┬───────┘ └──────┬───────┘ └────┬────┘ └────┬─────┘ └──────┬───────┘
       │                │              │           │               │
       ▼                ▼              ▼           ▼               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Kafka Event Bus                                     │
│                                                                             │
│  Topics: messages.created │ messages.updated │ messages.deleted              │
│          presence.changed │ reactions.changed │ files.uploaded               │
│          notifications │ audit.log │ webhooks.deliver                        │
└──────────┬───────────────┬──────────────────┬──────────────┬────────────────┘
           ▼               ▼                  ▼              ▼
┌──────────────┐ ┌──────────────┐  ┌──────────────┐ ┌──────────────────┐
│  Notification│ │  Webhook     │  │  Audit Log   │ │  Analytics       │
│  Worker      │ │  Delivery    │  │  Writer      │ │  Pipeline        │
│              │ │  Worker      │  │              │ │                  │
│ Push/Email   │ │ Retry + DLQ  │  │ Compliance   │ │ Usage metrics    │
└──────────────┘ └──────────────┘  └──────────────┘ └──────────────────┘
           │               │                  │              │
           ▼               ▼                  ▼              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Data Layer                                          │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  PostgreSQL   │  │   Redis      │  │Elasticsearch │  │     S3       │     │
│  │  (Sharded)   │  │  Cluster     │  │  Cluster     │  │              │     │
│  │              │  │              │  │              │  │  Files,      │     │
│  │  Messages    │  │  Sessions    │  │  Message     │  │  Avatars,    │     │
│  │  Channels    │  │  Presence    │  │  Full-text   │  │  Thumbnails  │     │
│  │  Users       │  │  Pub/Sub     │  │  Search      │  │              │     │
│  │  Workspaces  │  │  Cache       │  │              │  │              │     │
│  │              │  │  Rate Limits │  │              │  │              │     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. WebSocket Gateway

The WebSocket Gateway manages millions of persistent client connections and is the primary path for real-time message delivery.

**Connection Lifecycle:**
1. Client opens WSS connection with authentication token
2. Gateway validates token against session store (Redis)
3. Gateway verifies workspace membership
4. Gateway subscribes to the user's personal Redis pub/sub channel (`user:{userId}:messages`)
5. All messages for that user are pushed through this channel
6. Heartbeat pings every 30 seconds detect stale connections
7. On disconnect, presence is removed and workspace members are notified

**Multi-Instance Fan-Out:**
When a user sends a message, the Message Service publishes it to each channel member's personal Redis pub/sub channel. Regardless of which Gateway instance a member is connected to, that instance's subscriber receives the message and forwards it over the WebSocket. This decouples message storage from delivery, allowing Gateway instances to scale independently.

**Multiple Connections Per User:**
Users may have multiple browser tabs or devices. The Gateway maintains a `Map<userId, Set<WebSocket>>` and delivers to all active connections. Presence is only removed when the last connection closes.

### 2. Message Service

Handles message CRUD with transactional guarantees.

**Send Flow:**
1. Validate channel membership (cached in Redis for performance)
2. Begin PostgreSQL transaction
3. Insert message with server-assigned `created_at` timestamp
4. If thread reply: atomically increment parent's `reply_count` and append user to `reply_users`
5. Commit transaction
6. Publish to each channel member's Redis pub/sub channel (using cached member list)
7. Index message in Elasticsearch asynchronously (non-blocking)
8. Record Prometheus metrics (message count by workspace and channel type)

**Idempotency Protection:**
Clients include an `X-Idempotency-Key` header. The middleware checks Redis for prior processing of this key. A distributed lock (Redis `SET NX EX`) prevents race conditions from parallel retries. Responses are cached for 24 hours, ensuring that network retries never create duplicate messages.

**Message Ordering:**
Server-assigned timestamps (`TIMESTAMPTZ DEFAULT NOW()`) provide total ordering within a channel. The `BIGSERIAL` primary key provides a monotonically increasing sequence for efficient cursor-based pagination. Clients fetch messages with `WHERE id < :cursor ORDER BY created_at DESC LIMIT 50`, then reverse for chronological display.

### 3. Channel Architecture

Three channel types share the same underlying table with boolean flags:

- **Public channels** (`is_private=false, is_dm=false`): Any workspace member can join
- **Private channels** (`is_private=true, is_dm=false`): Invitation-only, hidden from non-members
- **Direct messages** (`is_private=true, is_dm=true`): 1:1 or group DMs with exact-member matching

DMs are implemented as channels with `is_dm=true`. Creating a DM checks for an existing channel with the exact same member set (using `array_agg` with sorted user IDs) to prevent duplicates.

Each workspace auto-creates `#general` and `#random` channels. New workspace members are automatically added to both.

### 4. Real-Time Messaging: Presence and Typing

**Presence System:**
- Each online user has a Redis key `presence:{workspaceId}:{userId}` with 60-second TTL
- The WebSocket heartbeat refreshes this TTL every 30 seconds
- When the key expires (no heartbeat), the user is implicitly offline
- On explicit disconnect, the key is deleted immediately
- Presence changes are broadcast to all workspace members via Redis pub/sub

**Typing Indicators:**
- When a user starts typing, a Redis key `typing:{channelId}:{userId}` is set with 5-second TTL
- The typing event is published to all other channel members
- No explicit "stopped typing" -- the TTL handles cleanup

### 5. Message Storage at Scale

**Sharding Strategy:**
At production scale, messages are sharded by `workspace_id`. This ensures all messages for a workspace live on the same shard, enabling efficient channel queries without cross-shard joins. The schema includes `workspace_id` on every message for this purpose.

**Key Indexes:**
- `(channel_id, created_at DESC)` -- primary query path for channel message history
- `(thread_ts) WHERE thread_ts IS NOT NULL` -- partial index for thread reply lookups
- `(workspace_id)` -- shard-key queries
- `(user_id)` -- user message history
- GIN index on `to_tsvector('english', content)` -- PostgreSQL full-text search fallback

**Thread Model:**
Threads are replies referencing a parent message's `id` via `thread_ts`. The parent message maintains:
- `reply_count` (atomically incremented in the same transaction as the reply insert)
- `latest_reply` timestamp
- `reply_users` array (deduplicated list of users who replied)

This denormalization avoids aggregation queries when displaying thread metadata in the channel view.

### 6. Search

**Primary: Elasticsearch**
- Custom `message_analyzer` with standard tokenizer + lowercase + Porter stemming
- Messages indexed asynchronously after storage (1-5 second lag acceptable)
- Query filters: workspace_id (mandatory), channel_id, user_id, date range
- Results include highlighted snippets for matching terms
- Workspace isolation enforced at query time via `term` filter

**Fallback: PostgreSQL Full-Text Search**
When Elasticsearch is unavailable, search falls back to PostgreSQL `tsvector` with `plainto_tsquery`. The GIN index on `to_tsvector('english', content)` enables this. `ts_headline` provides keyword highlighting. Less feature-rich than Elasticsearch (no stemming variants, no relevance tuning) but ensures search never goes fully offline.

### 7. File Sharing (Production Design)

At production scale, file sharing involves:
1. Client requests a pre-signed S3 upload URL from the File Service
2. Client uploads directly to S3 (avoiding API server bandwidth)
3. S3 triggers a Lambda for virus scanning (ClamAV)
4. After scanning, a thumbnail generator creates previews for images/documents
5. File metadata is stored in PostgreSQL with references to S3 keys
6. CDN serves thumbnails and file downloads with signed URLs
7. Message `attachments` JSONB field references file metadata

### 8. Notifications (Production Design)

- **Kafka topic** `notifications` receives events: mentions, DM messages, thread replies
- **Notification Worker** fans out to delivery channels:
  - Push notifications via APNs/FCM for mobile
  - Desktop notifications via WebSocket for web/desktop clients
  - Email digest batching (configurable: immediate, hourly, daily)
- **@mention tracking**: Message content is parsed for `@username` and `@channel` patterns
- Users configure notification preferences per channel (all, mentions, nothing)

### 9. Workspace Management and RBAC

**Role Hierarchy:** `owner (3) > admin (2) > member (1) > guest (0)`

| Permission | Guest | Member | Admin | Owner |
|------------|-------|--------|-------|-------|
| Read public channels | Yes | Yes | Yes | Yes |
| Send messages | Yes | Yes | Yes | Yes |
| Create channels | No | Yes | Yes | Yes |
| Delete own messages | Yes | Yes | Yes | Yes |
| Delete any message | No | No | Yes | Yes |
| Manage channel settings | No | No | Yes | Yes |
| Invite/remove members | No | No | Yes | Yes |
| Manage workspace settings | No | No | No | Yes |
| Delete workspace | No | No | No | Yes |
| Manage integrations | No | No | Yes | Yes |

**SSO/SAML Integration (Production):**
At scale, workspaces integrate with identity providers (Okta, Azure AD) via SAML 2.0. The API Gateway handles SAML assertion validation and maps external identities to workspace members. This is simplified to session-based auth in the local implementation.

---

## Database Schema

**Schema file:** `backend/src/db/init.sql`

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email       VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    username    VARCHAR(50)  NOT NULL,
    display_name VARCHAR(100),
    avatar_url  TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email    ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(100) NOT NULL,
    domain     VARCHAR(100) NOT NULL UNIQUE,
    settings   JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_domain ON workspaces (domain);

-- Workspace Members (role-based access)
CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         VARCHAR(20) NOT NULL DEFAULT 'member',
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members (user_id);

-- Channels (public, private, DMs share the same table)
CREATE TABLE IF NOT EXISTS channels (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         VARCHAR(100) NOT NULL,
    topic        TEXT,
    description  TEXT,
    is_private   BOOLEAN      NOT NULL DEFAULT false,
    is_archived  BOOLEAN      NOT NULL DEFAULT false,
    is_dm        BOOLEAN      NOT NULL DEFAULT false,
    created_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_channels_workspace    ON channels (workspace_id);
CREATE INDEX IF NOT EXISTS idx_channels_workspace_dm ON channels (workspace_id, is_dm);

-- Channel Members
CREATE TABLE IF NOT EXISTS channel_members (
    channel_id   UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_read_at TIMESTAMPTZ,
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members (user_id);

-- Messages (threads are self-referencing via thread_ts)
CREATE TABLE IF NOT EXISTS messages (
    id           BIGSERIAL   PRIMARY KEY,
    workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id   UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    thread_ts    BIGINT      REFERENCES messages(id) ON DELETE CASCADE,
    content      TEXT        NOT NULL,
    attachments  JSONB,
    reply_count  INT         NOT NULL DEFAULT 0,
    latest_reply TIMESTAMPTZ,
    reply_users  UUID[],
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_channel       ON messages (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread        ON messages (thread_ts) WHERE thread_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_workspace     ON messages (workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_user          ON messages (user_id);
CREATE INDEX IF NOT EXISTS idx_messages_content_fts   ON messages USING gin(to_tsvector('english', content));

-- Reactions
CREATE TABLE IF NOT EXISTS reactions (
    id         BIGSERIAL   PRIMARY KEY,
    message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (message_id);
```

---

## API Design

### User API (`/api/*`)

```
POST   /api/auth/register           → Create account
POST   /api/auth/login              → Login (creates session)
POST   /api/auth/logout             → Logout (destroys session)
GET    /api/auth/me                 → Get current user profile

GET    /api/workspaces              → List user's workspaces
POST   /api/workspaces              → Create workspace
POST   /api/workspaces/:id/join     → Join workspace
POST   /api/workspaces/:id/select   → Set active workspace in session
GET    /api/workspaces/:id/members  → List workspace members
GET    /api/workspaces/domain/:d    → Find workspace by domain

GET    /api/channels                → List channels in current workspace
POST   /api/channels                → Create channel
GET    /api/channels/:id            → Get channel details
PUT    /api/channels/:id            → Update channel topic/description
POST   /api/channels/:id/join       → Join public channel
POST   /api/channels/:id/leave      → Leave channel
GET    /api/channels/:id/members    → List channel members
POST   /api/channels/:id/members    → Invite user to channel
POST   /api/channels/:id/read       → Mark channel as read

GET    /api/dms                     → List DM conversations
POST   /api/dms                     → Create or get DM channel
GET    /api/dms/:id                 → Get DM conversation details

GET    /api/messages/channel/:id    → Get messages (paginated)
POST   /api/messages/channel/:id    → Send message (rate limited, idempotent)
PUT    /api/messages/:id            → Edit message (author only)
DELETE /api/messages/:id            → Delete message (author or admin)
GET    /api/messages/:id/thread     → Get thread with replies
POST   /api/messages/:id/reactions  → Add reaction
DELETE /api/messages/:id/reactions/:emoji → Remove reaction

GET    /api/search?q=...            → Search messages (ES with PG fallback)
```

### Admin API (`/api/workspaces/:id/*`)

```
PUT    /api/workspaces/:id                    → Update workspace settings (owner)
PUT    /api/workspaces/:id/members/:userId    → Change member role (owner)
DELETE /api/workspaces/:id/members/:userId    → Remove member (admin+)
DELETE /api/channels/:id                      → Archive channel (owner)
DELETE /api/channels/:id/members/:userId      → Remove from channel (admin+)
```

### WebSocket Protocol (`/ws`)

```
Connection: ws://host/ws?userId=...&workspaceId=...

Server → Client Events:
  { type: "connected",       payload: { userId, workspaceId } }
  { type: "message",         payload: { id, channel_id, content, user_id, ... } }
  { type: "message_update",  payload: { id, channel_id, content, edited_at, ... } }
  { type: "message_delete",  payload: { id, channel_id } }
  { type: "reaction_add",    payload: { message_id, user_id, emoji } }
  { type: "reaction_remove", payload: { message_id, user_id, emoji } }
  { type: "typing",          payload: { channelId, userId } }
  { type: "presence",        payload: { userId, status, user } }
  { type: "pong" }

Client → Server Events:
  { type: "ping" }
  { type: "typing",   payload: { channelId } }
  { type: "presence",  payload: { status: "online" | "away" } }
```

---

## Frontend Architecture

### Component Hierarchy

The frontend is a React 19 + TypeScript SPA built with Vite, using Slack's characteristic workspace-centric layout:

```
__root.tsx (<Outlet />)
├── /login                         → LoginForm (email/password)
├── /workspace-select              → WorkspaceSelect (list/create/join workspaces)
├── / (index)                      → Redirect to /login or /workspace-select
└── /workspace/$workspaceId        → WorkspaceLayout (auth guard + data loading)
    ├── Sidebar (left)             → Workspace name, search, channels, DMs, user profile
    ├── Main content (center)      → <Outlet />
    │   └── /channel/$channelId    → MessageList + message input
    │       ├── Messages           → Rendered with date dividers, reactions, threads
    │       └── Typing indicator   → "Alice is typing..."
    ├── ThreadPanel (right, conditional) → Thread view with parent + replies
    └── SearchModal (overlay)      → Full-text search with debounced input
```

The `WorkspaceLayout` route (`/workspace/$workspaceId.tsx`) is the primary authenticated layout. Its `beforeLoad` hook verifies auth, loads workspaces, selects the current workspace, and fetches channels and DMs -- all before rendering. This avoids loading spinners for the core chrome.

### State Management (Zustand)

Six Zustand stores separate concerns by domain:

**`useAuthStore`** -- Current user and loading state. Simple setter-based store with `setUser()` and `setLoading()`.

**`useWorkspaceStore`** -- Workspace list, current workspace, and cached member lists keyed by workspace ID. The `members` record avoids re-fetching workspace members on every channel switch.

**`useChannelStore`** -- Channel list, DM list, and currently selected channel. The `updateUnreadCount()` action updates a specific channel's badge without replacing the entire array, which would cause all channel items to re-render.

**`useMessageStore`** -- Messages keyed by channel ID (`Record<string, Message[]>`), active thread, typing users keyed by channel ID, and reaction management. This is the most complex store:
- `addMessage()` checks for duplicates (WebSocket may deliver a message the REST response already returned) before appending.
- `addReaction()` and `removeReaction()` operate on nested arrays within specific messages, using immutable update patterns (map over messages, map over reactions).
- `setTypingUsers()` manages per-channel typing indicator lists, with automatic 5-second cleanup timers.

**`usePresenceStore`** -- Online/offline status by user ID (`Record<string, boolean>`). Updated by WebSocket presence events. The `updatePresence()` action normalizes the status string into a boolean.

**`useUIStore`** -- UI-only state: sidebar visibility, thread panel visibility, search modal open/closed, search query. These are separated from data stores because they have no API interactions and should not trigger data re-fetches.

**Why six stores instead of one**: Zustand subscriptions are per-store. If all state lived in one store, a typing indicator update would trigger re-renders in every component subscribing to any piece of state. With separate stores, the typing indicator only re-renders components subscribed to `useMessageStore`, and specifically only those that read `typingUsers`. The sidebar (subscribed to `useChannelStore`) does not re-render.

### Routing (TanStack Router)

File-based routing with nested layouts:

```
routes/
├── __root.tsx                                     → Root (<Outlet />)
├── index.tsx                                      → / (redirect)
├── login.tsx                                      → /login
├── workspace-select.tsx                           → /workspace-select
├── workspace/$workspaceId.tsx                     → Layout route (beforeLoad auth guard)
├── workspace/$workspaceId.index.tsx               → /workspace/:id (default view)
└── workspace/$workspaceId/channel/$channelId.tsx  → /workspace/:id/channel/:channelId
```

**Auth guard in `beforeLoad`**: The workspace layout route uses TanStack Router's `beforeLoad` hook for server-side data fetching before the component renders. It calls `authApi.me()`, loads workspaces, selects the current workspace via `workspaceApi.select()`, and fetches channels and DMs. If any of these fail with an authentication error, it throws `redirect({ to: '/login' })`. This is a route-level guard, not a component-level check -- the component never renders without valid data.

**Deep linking**: The URL `/workspace/abc/channel/xyz` fully encodes the application state. A user can share this URL, and the recipient (if authenticated) will load directly into that channel. The `beforeLoad` hook ensures all necessary data is fetched before rendering.

### Data Fetching Pattern

```
Component (e.g., MessageList)
  → messageApi.list(channelId, before?, limit?)
    → request<Message[]>('/messages/channel/' + channelId)
      → fetch('/api/messages/channel/' + channelId, { credentials: 'include' })
        → Backend Express API
```

The API layer (`services/api.ts`) uses a shared `request<T>()` helper that adds `credentials: 'include'` and `Content-Type: application/json` to every request. Six API objects (`authApi`, `workspaceApi`, `channelApi`, `dmApi`, `messageApi`, `searchApi`) provide typed methods for each endpoint.

**Search with debouncing**: The `SearchModal` component uses a 300ms debounce timer (`setTimeout` with cleanup in `useEffect`) to avoid firing a search request on every keystroke. The search API supports filters (channel, user, date range) passed as query parameters.

### Real-Time Updates (WebSocket)

The `useWebSocket` custom hook manages the WebSocket connection lifecycle:

**Connection**: When the workspace layout mounts, it calls `useWebSocket(userId, workspaceId)`. The hook constructs a WebSocket URL (`ws://host/ws?userId=...&workspaceId=...`) and opens a connection.

**Reconnection**: On `onclose`, the hook schedules a reconnection attempt after 3 seconds via `setTimeout`. This handles both intentional disconnects (server restart, deployment) and network blips (Wi-Fi switch, mobile sleep).

**Heartbeat**: A `setInterval` sends a `ping` message every 25 seconds to keep the connection alive. Without heartbeats, intermediate proxies and load balancers may close idle WebSocket connections after 60-120 seconds.

**Message dispatching**: The `handleMessage()` callback routes incoming WebSocket messages to the appropriate Zustand store based on message type:
- `message` -> `addMessage()` to the message store
- `message_update` -> `updateMessage()` for edited messages
- `message_delete` -> `deleteMessage()` to remove from the list
- `reaction_add` / `reaction_remove` -> update reactions on the specific message
- `typing` -> add to typing users list with 5-second auto-cleanup timer
- `presence` -> update presence store with online/offline status
- `pong` -> heartbeat response (no-op)

**Typing indicators**: The hook exposes a `sendTyping(channelId)` function that sends a `{ type: "typing", payload: { channelId } }` message over the WebSocket. The receiving side adds the user to the channel's typing list and auto-removes them after 5 seconds. The message input calls `sendTyping` on every keypress.

### Key UI Patterns

**Thread panel**: Clicking a message's reply count opens the `ThreadPanel` as a side panel. The panel loads the thread (parent + replies) via `messageApi.getThread()`, stores it in `activeThread`, and renders alongside the message list. Replies sent in the thread panel go through the same `messageApi.send()` with a `thread_ts` parameter. The thread panel closes when the user clicks the X or the `isThreadPanelOpen` flag is toggled in the UI store.

**Channel creation**: The sidebar renders an inline form (toggled by a + button) for creating new channels. The form submits via `channelApi.create()`, appends the new channel to the store, and navigates to it.

**Date dividers**: The message list inserts visual date separators ("Today", "Yesterday", "March 15") between messages from different days, using `shouldShowDateDivider()` utility to compare adjacent message timestamps.

**Hover actions**: Message action buttons (react, reply, edit, delete) are hidden by default and shown on hover via `opacity-0 group-hover:opacity-100`. Edit and delete buttons only appear for the user's own messages (`message.user_id === user?.id`).

**Reaction grouping**: The `groupReactions()` utility aggregates reactions by emoji, counting occurrences and tracking which users reacted. Each reaction badge shows the emoji and count, with visual highlighting for reactions the current user has added.

---

## Key Design Decisions

### 1. Thread as Message Attribute vs. Separate Table

**Decision:** Threads are replies stored in the `messages` table with a `thread_ts` foreign key to the parent message.

**Why this works:** A single table simplifies queries -- fetching a thread is `WHERE thread_ts = :parentId ORDER BY created_at ASC`. The parent message carries denormalized metadata (`reply_count`, `latest_reply`, `reply_users`) so the channel view can show thread previews without aggregation queries. The `reply_count` increment happens atomically in the same transaction as the reply insert, preventing count drift.

**Why a separate `threads` table fails:** It would require JOIN queries for every channel view to get thread metadata, and two-table transactions for every reply. The thread is not a separate entity -- it is a property of messages. Separating them adds complexity without improving query patterns.

**What we give up:** Thread-specific metadata (title, pinned status) would require schema changes. For Slack's model where threads are lightweight reply chains, this is acceptable.

### 2. Redis Pub/Sub for Message Delivery vs. Kafka

**Decision:** Use Redis pub/sub for real-time WebSocket delivery; Kafka for async event processing.

**Why Redis pub/sub works for delivery:** Message delivery must be sub-200ms. Redis pub/sub adds ~1ms latency. Each user subscribes to their personal channel (`user:{userId}:messages`). When a message is sent, it is published to each channel member's personal channel. Regardless of which Gateway instance the member connects to, the subscriber picks it up. Redis pub/sub is fire-and-forget, which is acceptable because the message is already persisted in PostgreSQL -- the pub/sub is for real-time notification only.

**Why Kafka fails for real-time delivery:** Kafka's consumer group model requires polling with configurable intervals. Even with low poll intervals (50ms), the batching and partition assignment overhead adds 100-500ms of latency. Kafka is designed for durable event streaming, not low-latency push. It excels at event processing (indexing, notifications, webhooks, audit logs) where 1-5 second lag is acceptable.

**What we give up:** Redis pub/sub is at-most-once -- if no subscriber is listening when a message is published, it is lost. This is mitigated by the reconnection sync mechanism: when a client reconnects, it fetches missed messages from PostgreSQL using the last-seen timestamp.

### 3. Workspace-Scoped Data Model for Tenant Isolation

**Decision:** Every table includes `workspace_id` as a foreign key, and all queries filter by workspace.

**Why this works:** It provides clear data isolation at the application level. Queries within a workspace are efficient because indexes include `workspace_id`. At scale, the workspace_id becomes the natural sharding key -- all data for a workspace lives on the same shard, avoiding cross-shard joins.

**Why per-workspace databases fail:** They multiply operational complexity (migrations across thousands of databases), prevent cross-workspace features (enterprise search), and make user accounts that span workspaces (same email in multiple workspaces) awkward to manage.

**What we give up:** Global queries (admin dashboards, cross-workspace analytics) require scatter-gather across shards. Mitigated by streaming events to a separate analytics pipeline.

---

## Consistency and Idempotency

### Write Consistency Model

**Messages:** Strong consistency within a channel via PostgreSQL transactions. The `BIGSERIAL` primary key provides total ordering. Server-assigned `created_at` timestamps ensure consistent ordering regardless of client clock skew.

**Thread Reply Counts:** Atomically incremented in the same transaction as the reply insert:

```sql
BEGIN;
INSERT INTO messages (workspace_id, channel_id, user_id, content, thread_ts) VALUES (...);
UPDATE messages SET reply_count = reply_count + 1, latest_reply = NOW(),
       reply_users = array_append(array_remove(COALESCE(reply_users, ARRAY[]::uuid[]), $1), $1)
WHERE id = $2;
COMMIT;
```

### Idempotency

Idempotency solves a fundamental problem in distributed systems: the client cannot distinguish "request failed" from "request succeeded but the response was lost." Consider: a user sends a message, the server persists it and publishes to WebSocket, but the HTTP response times out. The user sees "sending..." and taps retry. Without idempotency, the message appears twice in the channel.

The solution: the client includes a unique `Idempotency-Key` header (UUID) with each request. The server checks Redis for this key before processing. If found, the server returns the cached response from the first processing. If not found, the server processes the request, caches the response in Redis with a 24-hour TTL, and returns it. The TTL ensures keys auto-expire without manual cleanup.

The idempotency middleware prevents duplicate messages from network retries:

1. Client includes `X-Idempotency-Key` header (e.g., `msg:{channelId}:{contentHash}:{timestamp}`)
2. Middleware checks Redis for this key (scoped to user: `idem:{userId}:{key}`)
3. If found, return cached response (no database write)
4. If not found, acquire distributed lock (`SET NX EX 30`), process request, cache response for 24 hours
5. Lock prevents race conditions from parallel retries

### Consistency Semantics by Operation

| Operation | Consistency | Idempotency | Conflict Resolution |
|-----------|-------------|-------------|---------------------|
| Send message | Strong (PostgreSQL tx) | Client idempotency key | Server-assigned ID wins |
| Edit message | Strong | Last-write-wins | `edited_at` timestamp |
| Delete message | Strong | Idempotent (no error on re-delete) | Cascade deletes reactions/replies |
| Add reaction | Strong | Natural (`UNIQUE` constraint + `ON CONFLICT DO NOTHING`) | No conflict possible |
| Remove reaction | Strong | Idempotent (no-op if not exists) | No conflict possible |
| Join channel | Strong | Natural (PK constraint + `ON CONFLICT DO NOTHING`) | No conflict possible |

### Reconnection Sync

When a client reconnects after a network interruption, it fetches missed messages from PostgreSQL:

```sql
SELECT * FROM messages
WHERE channel_id = $1 AND created_at > $2
ORDER BY created_at ASC
LIMIT 1000;
```

This bridges the gap between Redis pub/sub (at-most-once) and the durable message store.

---

## Caching

### What Caching Solves (Cache-Aside Pattern)

A PostgreSQL query takes ~5ms. A Redis lookup takes ~0.1ms. When loading a channel, the server queries user profiles, channel metadata, and workspace settings -- data that changes rarely but is read on every request. Without caching, each channel view triggers 5+ database queries. At 10K concurrent users switching channels, that is 50K database queries per second for data that was identical 1 second ago.

The **cache-aside** (lazy-loading) pattern used throughout this project works as follows:
1. Check Redis for the cached value (`GET channel:{id}`)
2. **Cache hit**: Return the cached value (0.1ms)
3. **Cache miss**: Query PostgreSQL (5ms), store the result in Redis with a TTL, return the value

**Cache invalidation**: When data changes (channel topic updated, user profile changed), the server deletes the cache key (`DEL channel:{id}`) rather than updating it. Deletion is safer than update because it avoids race conditions: if two requests update the same key simultaneously, the last write wins. With deletion, the next read simply repopulates from the database.

**TTL (Time-To-Live)**: Every cached value has an expiration time. Even without explicit invalidation, stale data automatically expires. Short TTLs (5 seconds for typing indicators) ensure near-real-time freshness. Longer TTLs (10 minutes for workspace settings) are acceptable for rarely-changing data.

**Why Redis over in-memory Maps**: An in-memory Map is lost when the process restarts. Worse, with 3 API server instances behind a load balancer, each has its own Map with potentially different cached values. Redis is shared across all instances, ensuring cache consistency. Redis also provides atomic operations (`INCR`, `EXPIRE`), eviction policies (LRU), and persistence options.

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      CDN (Static Assets)                        │
│              JS bundles, images, emoji sprites                   │
│                    TTL: 1 year (versioned)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API / Gateway Layer                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Redis Cache Layer                             │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ User Cache  │  │Channel Cache│  │ Workspace   │             │
│  │ TTL: 5min   │  │ TTL: 2min   │  │ TTL: 10min  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  Presence   │  │  Sessions   │  │ Rate Limits │             │
│  │  TTL: 60s   │  │ TTL: 7 days │  │  TTL: 1min  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PostgreSQL                               │
└─────────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern

The application uses cache-aside (lazy loading) for all cached data:

1. **Read path:** Check Redis first. On cache hit, return immediately. On miss, query PostgreSQL, populate cache with TTL, return result.
2. **Write path:** Update PostgreSQL first. Then invalidate (delete) the cache key. Do not update the cache -- let the next read repopulate it.
3. **Failure handling:** If Redis is unavailable, fall back directly to PostgreSQL. Cache errors never break the application.

### Cache Invalidation Rules

| Cache Key Pattern | TTL | Invalidation Trigger |
|-------------------|-----|----------------------|
| `cache:user:{id}` | 5 min | Profile update, avatar change |
| `cache:channel:{id}` | 2 min | Channel settings update, membership change |
| `cache:channel:{id}:members` | 2 min | Member join/leave/invite |
| `cache:workspace:{id}` | 10 min | Workspace settings update |
| `presence:{workspace}:{user}` | 60 sec | Heartbeat timeout (auto-expire) |
| `session:{token}` | 7 days | Logout |
| `idem:{user}:{key}` | 24 hr | No invalidation (auto-expire) |
| `ratelimit:{user}:{op}` | 1 min | No invalidation (auto-expire) |
| `typing:{channel}:{user}` | 5 sec | No invalidation (auto-expire) |

---

## Observability

### What Observability Solves

In a messaging system, a user reports "my messages aren't being delivered." Without observability, debugging involves SSH-ing into servers, grepping log files, and guessing. With observability, you query: "show me the WebSocket connection count for user X" (metrics), "show me all messages sent by user X in the last hour" (logs), and "what's the Redis pub/sub latency?" (metrics). The three pillars -- metrics, logs, health checks -- turn production incidents from hours of investigation into minutes of dashboard queries.

### Prometheus Metrics

Prometheus is a time-series database that pulls metric data from application endpoints. The `prom-client` library registers metrics in the application, and Prometheus scrapes the `/metrics` endpoint at regular intervals (typically every 15s). These metrics power Grafana dashboards and alerting rules.

**Metric types explained:**

- **Counter** -- Monotonically increasing number. Use for things that only go up: total messages sent, total errors, total requests. To get "messages per second," query `rate(slack_messages_sent_total[5m])`. The rate function computes the per-second increase over the window.
- **Histogram** -- Distribution of measured values. Use for latency and duration measurements. Prometheus pre-buckets values and supports percentile queries: `histogram_quantile(0.99, slack_http_request_duration_seconds)` gives the p99 latency. This is critical because averages hide outliers -- an average of 20ms could mean 99% at 5ms and 1% at 1.5 seconds.
- **Gauge** -- Value that goes up and down. Use for current state: active WebSocket connections, queue depth. Unlike counters, gauges represent a point-in-time snapshot.

**Alerting examples:**
- `rate(slack_http_requests_total{status_code=~"5.."}[5m]) > 0.001` -- error rate exceeds 0.1% for 5 minutes, page the on-call engineer
- `slack_websocket_connections_active > 50000` -- approaching connection limit per instance, scale horizontally
- `histogram_quantile(0.99, slack_http_request_duration_seconds[5m]) > 0.5` -- p99 latency exceeds 500ms, investigate database or cache

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `slack_messages_sent_total` | Counter | workspace_id, channel_type | Message throughput |
| `slack_messages_delivered_total` | Counter | - | WebSocket delivery confirmation |
| `slack_websocket_connections_active` | Gauge | - | Connection pool size |
| `slack_websocket_users_active` | Gauge | - | Unique connected users |
| `slack_http_request_duration_seconds` | Histogram | method, route, status_code | API latency (p50, p95, p99) |
| `slack_http_requests_total` | Counter | method, route, status_code | Request volume |
| `slack_cache_operations_total` | Counter | cache_name, result | Cache hit/miss ratio |
| `slack_rate_limit_hits_total` | Counter | endpoint | Abuse detection |
| `slack_idempotency_hits_total` | Counter | - | Duplicate request detection |
| `slack_db_query_duration_seconds` | Histogram | query_type | Database latency |

### Health Checks

Health checks serve two audiences: automated infrastructure (Kubernetes, load balancers) and human operators. They answer distinct questions:

- **Liveness** (`/live`) -- "Is the process running?" A simple HTTP 200 response. If this fails, the process is hung or crashed. Kubernetes kills and restarts the container. This check must be cheap and must not depend on external services -- a process with a dead Redis connection is alive but not ready.
- **Readiness** (`/ready`) -- "Can this instance handle requests?" Checks Redis and PostgreSQL connectivity. If either is unavailable, this returns 503. The load balancer stops sending traffic to this instance, but does not kill it. This matters: a server reconnecting to Redis should not receive requests, but restarting it would not fix the Redis outage.
- **Detailed health** (`/health/detailed`) -- Diagnostic endpoint for operators during incidents. Reports Redis latency, PostgreSQL latency, Elasticsearch availability, WebSocket connection count. Too expensive for automated health checking (querying multiple services per check), but invaluable when debugging production issues.

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /health` | Basic liveness | Server is running |
| `GET /health/detailed` | Service status | Redis latency, PostgreSQL latency, Elasticsearch status, WebSocket connections |
| `GET /ready` | Readiness probe | Redis + PostgreSQL both responding |
| `GET /live` | Liveness probe | Process is running |
| `GET /metrics` | Prometheus scrape | All registered metrics |

### Structured Logging (Pino)

`console.log("message sent")` works during development but is useless in production. With multiple server instances producing thousands of log lines per second, you need to search ("show me all errors for workspace X"), filter by level ("show only errors"), and correlate across requests ("this message send triggered a pub/sub publish -- trace the full flow").

Structured logging means every log entry is a JSON object with consistent fields, not a free-form string. These JSON objects are fed to a log aggregation system (ELK stack: Elasticsearch + Logstash + Kibana, or Datadog) where you can query across millions of log entries in seconds.

**Why Pino**: Pino is the fastest Node.js JSON logger (~5x faster than Winston). It uses a worker thread for string serialization, adding negligible overhead at high throughput. In development, `pino-pretty` formats JSON into readable colored output.

**Log levels** (from most to least verbose): `trace` (function entry/exit), `debug` (cache hits/misses, query details), `info` (request completed, message sent -- the production baseline), `warn` (rate limit hit, degraded state), `error` (5xx, unhandled exceptions), `fatal` (process cannot continue). The level is configurable via environment variable without code changes.

Pino-based structured JSON logging with request-scoped context:
- **Fields:** `requestId`, `userId`, `workspaceId`, `method`, `path`, `statusCode`, `duration`
- **Development:** Pretty-printed with `pino-pretty`
- **Production:** Raw JSON for log aggregation (ELK stack, Datadog)

---

## Failure Handling

### Graceful Degradation

| Component | Failure Mode | Degradation Behavior |
|-----------|-------------|----------------------|
| Elasticsearch | Down/unreachable | Search falls back to PostgreSQL `tsvector` FTS |
| Redis cache | Down/unreachable | Cache reads fall back to PostgreSQL directly |
| Redis pub/sub | Down/unreachable | Real-time delivery stops; clients use reconnection sync |
| PostgreSQL | Down | Server returns 503; readiness probe fails; traffic rerouted |
| WebSocket | Connection dropped | Client auto-reconnects; fetches missed messages via REST |

### Rate Limiting

Rate limiting protects the system from three threats: abuse (a bot flooding channels with spam), overload (a legitimate integration sending messages faster than the database can handle), and unfair usage (one user consuming a disproportionate share of resources, degrading service for others).

**Sliding Window algorithm** (used here): This implementation uses Redis sorted sets where each request adds a timestamped entry. To check the limit, the server counts entries within the current window (e.g., last 60 seconds). This is more accurate than fixed-window counters, which allow double the rate at window boundaries (e.g., 60 requests at :59 and 60 more at :01 = 120 in 2 seconds). The sliding window smooths this by always looking back exactly N seconds from now.

**Per-user vs per-workspace**: Authenticated users get per-user limits tied to their user ID. This prevents a single user from degrading a workspace's experience. Per-workspace limits (10x individual) protect against coordinated abuse or misconfigured integrations that create multiple users.

**Fails open**: If Redis is down, the rate limiter allows requests through rather than blocking them. This is a deliberate trade-off: it is worse to reject all legitimate traffic (because the rate limiter is broken) than to temporarily allow a few extra requests (because rate limiting is disabled). The Redis outage itself is handled by the circuit breaker and health check systems.

Sliding window rate limiter using Redis sorted sets:
- Per-user limits by operation type (60 messages/min, 10 channel creates/min, 20 searches/min)
- Admin role gets 2x multiplier on all limits
- Per-workspace limits at 10x individual limits (prevents workspace-wide abuse)
- Fails open -- if Redis is down, requests are allowed (prevents rate limiter from becoming a single point of failure)
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

### Graceful Shutdown

On `SIGTERM`:
1. Stop accepting new HTTP connections
2. Close WebSocket connections (clients will reconnect)
3. Drain the PostgreSQL connection pool
4. Close Redis connections
5. Exit process

---

## Scalability Considerations

### What Breaks First

1. **WebSocket connections** -- Each Gateway instance is limited by file descriptors (~65K connections). Scale horizontally behind a load balancer with sticky sessions (or use the Redis pub/sub pattern that makes stickiness unnecessary).

2. **Message fan-out** -- A channel with 10K members means 10K Redis publishes per message. Mitigate with batched publishing and by capping channel membership (or switching to a broadcast topic for large channels).

3. **PostgreSQL writes** -- At 1B messages/day (~12K writes/sec), a single PostgreSQL instance becomes the bottleneck. Shard by `workspace_id` to distribute writes across multiple instances.

4. **Search indexing lag** -- Elasticsearch indexing is async. Under high load, the indexing backlog grows. Add more Elasticsearch nodes and increase indexing workers.

### Horizontal Scaling Path

| Component | Scaling Strategy |
|-----------|-----------------|
| WebSocket Gateway | Stateless; add instances behind LB |
| API Servers | Stateless; add instances behind LB |
| PostgreSQL | Shard by workspace_id; read replicas for search/analytics |
| Redis | Redis Cluster for cache; dedicated instances for pub/sub |
| Elasticsearch | Add data nodes; shard by workspace_id |
| Kafka | Add partitions per topic |

### Multi-Region

- **Active-active** in 3+ regions with GeoDNS routing
- PostgreSQL uses cross-region replication with conflict-free CRDT-inspired merge for messages
- Redis Cluster per region with independent pub/sub (messages replicated via Kafka)
- Eventual consistency between regions (users in different regions may see 1-2 second ordering differences)

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Threading | Parent reference in messages table | Separate threads table | Simplicity; avoids JOINs for channel view thread previews |
| Real-time delivery | Redis pub/sub | Kafka consumer groups | Sub-200ms latency; Kafka adds 100-500ms from polling |
| Message storage | PostgreSQL (sharded by workspace) | Cassandra | ACID transactions for thread reply counts; familiar tooling |
| Presence | Redis keys with TTL | Database polling | Automatic cleanup; sub-millisecond reads; no periodic queries |
| Search | Elasticsearch + PG FTS fallback | PostgreSQL FTS only | Stemming, relevance tuning, highlighting; fallback ensures availability |
| Session auth | Redis-backed express-session | JWT | Immediate revocation on logout; no token expiry management |
| Caching | Cache-aside (lazy) | Write-through | Only caches accessed data; handles cache failure gracefully |
| Rate limiting | Sliding window (sorted sets) | Fixed window (counter) | No burst at window boundaries; smooth enforcement |
| Channel types | Single table with boolean flags | Separate tables per type | Shared message delivery pipeline; simpler queries |

---

# Layer 2: Pocket-Size Architecture (What We Actually Built)

This section documents the local implementation -- a fully functional Slack clone running on Docker Compose with a single Node.js process.

---

## Local Architecture Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                    Browser (React)                             │
│                  http://localhost:5173                         │
│                                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Sidebar  │ │ Message  │ │ Thread   │ │ Search Modal     │ │
│  │ Channels │ │ List     │ │ Panel    │ │                  │ │
│  │ DMs      │ │          │ │          │ │                  │ │
│  │ Presence │ │ Compose  │ │ Replies  │ │ ES + PG fallback │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘ │
└──────────────────────────┬──────────────────┬────────────────┘
                           │ REST             │ WebSocket
                           ▼                  ▼
              ┌────────────────────────────────────────┐
              │     Node.js + Express (Port 3001)      │
              │                                        │
              │  ┌──────────────────────────────────┐  │
              │  │         Middleware Stack          │  │
              │  │ Session │ RBAC │ Rate Limit │     │  │
              │  │ Idempotency │ Request Logging    │  │
              │  └──────────────────────────────────┘  │
              │                                        │
              │  ┌──────────────┐ ┌──────────────┐     │
              │  │ REST Routes  │ │ WebSocket    │     │
              │  │ /api/auth    │ │ Server /ws   │     │
              │  │ /api/channels│ │              │     │
              │  │ /api/messages│ │ Presence     │     │
              │  │ /api/dms     │ │ Typing       │     │
              │  │ /api/search  │ │ Message push │     │
              │  │ /api/works.. │ │              │     │
              │  └──────────────┘ └──────────────┘     │
              │                                        │
              │  ┌──────────────────────────────────┐  │
              │  │         Services Layer           │  │
              │  │ Cache │ Redis │ Elasticsearch    │  │
              │  │ Metrics │ Logger                 │  │
              │  └──────────────────────────────────┘  │
              │                                        │
              │  GET /metrics  GET /health/detailed     │
              │  GET /ready    GET /live                │
              └──────┬──────────┬──────────┬───────────┘
                     │          │          │
                     ▼          ▼          ▼
          ┌──────────────┐ ┌────────┐ ┌───────────────┐
          │  PostgreSQL  │ │ Valkey │ │ Elasticsearch │
          │  Port 5432   │ │  6379  │ │    9200       │
          │              │ │        │ │               │
          │  slack DB    │ │Sessions│ │ slack_messages │
          │  7 tables    │ │Cache   │ │ index          │
          │  9 indexes   │ │Pub/Sub │ │               │
          │              │ │Presence│ │ Custom         │
          │              │ │Typing  │ │ analyzer       │
          │              │ │Rate    │ │ (stemming)     │
          │              │ │Limits  │ │               │
          └──────────────┘ └────────┘ └───────────────┘
```

---

## Infrastructure (Docker Compose)

Three services in `docker-compose.yml`:

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| PostgreSQL 16 | `postgres:16-alpine` | 5432 | Relational data (users, workspaces, channels, messages, reactions) |
| Valkey 7 | `valkey/valkey:7-alpine` | 6379 | Sessions, cache, pub/sub, presence, typing indicators, rate limiting |
| Elasticsearch 8.11 | `elasticsearch:8.11.0` | 9200 | Full-text message search with custom analyzer |

All services have health checks configured. Elasticsearch runs in single-node mode with security disabled and 512MB heap.

---

## What Is Actually Implemented

### Production-Grade Patterns (Fully Implemented)

**Idempotency Middleware** (`backend/src/middleware/idempotency.ts`):
Message sending is protected by client-provided `X-Idempotency-Key` headers. Redis caches the response for 24 hours with a distributed lock (`SET NX EX 30`) to prevent race conditions from parallel retries. This ensures network failures never create duplicate messages.

**Cache-Aside Pattern** (`backend/src/services/cache.ts`):
Cached lookups for users (5min TTL), channels (2min), channel members (2min), and workspaces (10min). Every cached read falls back to PostgreSQL on cache miss or Redis failure. Cache invalidation on writes uses explicit key deletion. Prometheus counters track hit/miss ratios per cache name.

**RBAC Middleware** (`backend/src/middleware/rbac.ts`):
Full role hierarchy (owner > admin > member > guest) with numeric comparison. Explicit permission matrix covering 13 operations. Both `requireRole()` (minimum role check) and `requirePermission()` (specific permission check) middleware. Membership data attached to `req.membership` for route handlers.

**Rate Limiting** (`backend/src/middleware/rateLimit.ts`):
Sliding window algorithm using Redis sorted sets. Per-user limits by operation type (60 messages/min, 10 channel creates/min, 20 searches/min). Admin 2x multiplier. Workspace-scoped rate limiter available. Response headers for client awareness. Fails open on Redis errors.

**Prometheus Metrics** (`backend/src/services/metrics.ts`):
11 custom metrics covering messages sent, WebSocket connections, HTTP duration/count, cache operations, rate limit hits, idempotency hits, and database query duration. All exposed via `GET /metrics` in Prometheus text format. Default Node.js metrics (CPU, memory, event loop) also collected.

**Structured Logging** (`backend/src/services/logger.ts`):
Pino-based with request-scoped child loggers carrying `requestId`, `userId`, `workspaceId`. Pretty-printed in development, JSON in production. Every route handler uses the logger for structured error reporting.

**Health Checks** (`backend/src/index.ts`):
Four endpoints: `/health` (basic), `/health/detailed` (Redis/PG/ES latency), `/ready` (K8s readiness), `/live` (K8s liveness). The detailed check reports per-service status with millisecond latency measurements.

**Graceful Shutdown** (`backend/src/index.ts`):
SIGTERM handler closes HTTP server, drains PostgreSQL pool, and disconnects Redis before exiting.

### Features Implemented

| Feature | Status | Notes |
|---------|--------|-------|
| User registration/login | Done | bcrypt password hashing, session-based auth |
| Workspace CRUD | Done | Create, join, select, member management, role changes |
| Public/private channels | Done | CRUD, join/leave, invite, archive |
| Direct messages | Done | 1:1 and group DMs, exact-member duplicate detection |
| Send/receive messages | Done | WebSocket real-time delivery via Redis pub/sub |
| Message editing | Done | Author-only, real-time update broadcast |
| Message deletion | Done | Author or admin, cascades to reactions/thread replies |
| Threading | Done | Self-referencing FK, atomic reply_count, reply_users array |
| Reactions | Done | Add/remove emoji, idempotent via UNIQUE constraint |
| Presence | Done | Redis TTL-based, broadcast to workspace members |
| Typing indicators | Done | Redis TTL-based, broadcast to channel members |
| Full-text search | Done | Elasticsearch primary with PostgreSQL tsvector fallback |
| Unread tracking | Done | `last_read_at` per channel member, unread count in channel list |
| Cursor-based pagination | Done | `WHERE id < :cursor` for message history |
| Multiple server instances | Done | `dev:server1/2/3` scripts on ports 3001-3003 |

### Frontend (React + TypeScript + Vite)

The frontend uses TanStack Router for file-based routing and Zustand for state management across six stores:
- **AuthStore**: Current user, loading state
- **WorkspaceStore**: Workspace list, current workspace, member cache
- **ChannelStore**: Channels, DMs, current channel, unread counts
- **MessageStore**: Messages by channel, active thread, typing users, reactions
- **PresenceStore**: Online/offline status by user ID
- **UIStore**: Sidebar, thread panel, search modal visibility

Key components: `Sidebar` (channels + DMs + presence), `MessageList` (message display + compose), `ThreadPanel` (thread view + reply), `SearchModal` (full-text search with filters), `WorkspaceSelect` (workspace picker), `LoginForm` (auth).

WebSocket hook (`useWebSocket.ts`) manages the connection lifecycle, handles incoming events (message, update, delete, reaction, typing, presence), and dispatches to the appropriate Zustand store.

---

## What Was Simplified or Substituted

| Production Component | Local Substitute | Why |
|---------------------|------------------|-----|
| CDN (CloudFront) | Vite dev server | No static asset distribution needed locally |
| API Gateway (rate limit, auth, routing) | Express middleware | Single process handles everything |
| Kafka event bus | Direct Redis pub/sub | No async event processing pipeline needed |
| Multiple microservices | Single Express app | All routes in one process |
| S3 file storage | Not implemented | `attachments` JSONB column exists but no upload flow |
| Virus scanning + thumbnail generation | Not implemented | No file processing pipeline |
| Push notifications (APNs/FCM) | WebSocket only | No mobile clients |
| Email digest batching | Not implemented | No email delivery |
| @mention parsing + notification | Not implemented | Content stored as plain text |
| SSO/SAML integration | Session + bcrypt | Simple username/password auth |
| PostgreSQL sharding | Single instance | One database handles all workspaces |
| Redis Cluster | Single Valkey instance | All cache/pub-sub/sessions in one instance |
| Elasticsearch cluster | Single node (512MB) | Development-scale search |

---

## What Was Omitted

- **CDN** for static assets and file delivery
- **Multi-region deployment** and cross-region replication
- **Kubernetes** orchestration and auto-scaling
- **Database sharding** by workspace_id
- **File upload/download** pipeline (S3, virus scanning, thumbnails)
- **Push notifications** (APNs, FCM)
- **Email notifications** and digest batching
- **@mention parsing** and notification routing
- **Webhooks and integrations** platform (incoming/outgoing webhooks, slash commands, bot users)
- **Audit logging** to a compliance store
- **Analytics pipeline** for usage metrics
- **Circuit breakers** (Opossum) around external service calls
- **Message retention policies** and data export
- **Enterprise features**: SSO/SAML, data loss prevention, e-discovery

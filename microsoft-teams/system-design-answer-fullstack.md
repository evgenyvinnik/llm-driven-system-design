# Microsoft Teams - Full-Stack System Design Answer

## 🏗️ Architecture Overview

> "I'm designing a full-stack enterprise chat platform like Microsoft Teams. The system needs to handle real-time messaging within an organizational hierarchy -- organizations contain teams, teams contain channels, and channels contain threaded conversations with file attachments and emoji reactions. The key challenges span both sides: a responsive chat UI with real-time updates on the frontend, and a scalable messaging pipeline with presence tracking and file storage on the backend."

```
┌──────────────────────┐     ┌──────────────┐     ┌─────────────────────────────────┐
│     React SPA        │     │              │     │        Backend Services          │
│                      │     │  API Gateway │     │                                 │
│  ┌────────────────┐  │     │   / Proxy    │     │  ┌─────────┐  ┌──────────────┐ │
│  │ Sidebar        │  │     │              │     │  │  Auth   │  │   Message    │ │
│  │ ChannelList    │  │────▶│  Vite Dev    │────▶│  │ Routes  │  │   Service    │ │
│  │ ChatArea       │  │     │  Proxy       │     │  └─────────┘  └──────┬───────┘ │
│  │ ThreadPanel    │  │     │              │     │                      │         │
│  │ MemberList     │  │     └──────────────┘     │  ┌─────────┐  ┌─────┴───────┐ │
│  └────────────────┘  │                          │  │  File   │  │  Redis      │ │
│                      │  SSE                     │  │ Upload  │  │  Pub/Sub    │ │
│  ┌────────────────┐  │◀────────────────────────│  └────┬────┘  └─────────────┘ │
│  │ Zustand Stores │  │                          │       │                       │
│  │ AuthStore      │  │                          └───────┼───────────────────────┘
│  │ ChatStore      │  │                                  │
│  └────────────────┘  │         ┌──────────┐  ┌─────────┴──┐  ┌──────────┐
└──────────────────────┘         │PostgreSQL│  │   MinIO    │  │  Valkey  │
                                 │(Messages)│  │  (Files)   │  │ (Cache)  │
                                 └──────────┘  └────────────┘  └──────────┘
```

## 💾 Data Model

> "The data model is the foundation. I need a four-level hierarchy: Organization > Team > Channel > Message, with membership tables at each level for access control, and a self-referencing foreign key for threaded replies."

### Schema Overview

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| users | id (UUID), username (unique), email (unique), password_hash, display_name, avatar_url | User accounts |
| organizations | id, name, slug (unique), created_by (FK) | Top-level containers |
| org_members | org_id (FK), user_id (FK), role | Org membership with roles (owner/admin/member) |
| teams | id, org_id (FK), name, is_private, created_by | Groups within organizations |
| team_members | team_id (FK), user_id (FK), role | Team membership |
| channels | id, team_id (FK), name, is_private, created_by | Conversation spaces within teams |
| channel_members | channel_id (FK), user_id (FK), last_read_at | Channel membership + read tracking |
| messages | id, channel_id (FK), user_id (FK), parent_message_id (self FK), content, is_edited | Messages with threading |
| message_reactions | message_id (FK), user_id (FK), emoji | Emoji reactions (unique per user per emoji) |
| files | id, message_id (FK), channel_id (FK), user_id (FK), filename, storage_path, size_bytes | File attachments |

### Key Indexes

- `(channel_id, created_at DESC)` on messages -- primary query pattern for paginated message loading
- `(parent_message_id)` on messages -- thread reply lookups
- `(user_id)` on all membership tables -- "my orgs/teams/channels" queries
- `(message_id)` on reactions -- aggregate reactions per message

### Threading Decision

> "I model threads as self-referencing messages rather than a separate threads table. A thread is a message with `parent_message_id = NULL` (the root) and replies with `parent_message_id` pointing to the root. This works because Teams uses flat threads (one level deep -- replies don't have sub-replies). If I needed nested threading like Reddit, I'd use a closure table or materialized path, but flat threads keep the schema simple and queries fast."

## 🔄 API Design

### Core Endpoints

```
Authentication:
POST /api/auth/register          → Create account, start session
POST /api/auth/login             → Authenticate user
POST /api/auth/logout            → Destroy session
GET  /api/auth/me                → Current session info

Organization Hierarchy:
GET  /api/organizations          → User's organizations
POST /api/organizations          → Create org (auto-adds as owner)
GET  /api/teams?orgId=xxx        → Teams in org
POST /api/teams                  → Create team (auto-creates General channel)
GET  /api/channels?teamId=xxx    → Channels in team
POST /api/channels               → Create channel

Messaging:
GET  /api/messages?channelId=xxx&before=ts&limit=50  → Paginated messages
POST /api/messages               → Send message (or thread reply via parentMessageId)
PUT  /api/messages/:id           → Edit message (owner only)
DELETE /api/messages/:id         → Delete message (owner only)
GET  /api/messages/:id/thread    → Thread replies

Real-Time & Presence:
GET  /api/sse/:channelId         → SSE event stream
POST /api/presence/heartbeat     → Presence heartbeat
GET  /api/presence/channel/:id   → Channel member presence

Files & Reactions:
POST /api/files                  → Upload file (multipart/form-data)
GET  /api/files/:id/download     → Presigned download URL
POST /api/reactions              → Add reaction
DELETE /api/reactions            → Remove reaction
```

## 🖥️ Frontend Architecture

### Routing (TanStack Router, File-Based)

```
/login                                          → LoginPage
/register                                       → RegisterPage
/                                               → IndexPage (redirect to first org)
/org                                            → OrgLayout (sidebar + heartbeat)
  /org/$orgId                                   → OrgPage (teams + channel list)
    /org/$orgId/team/$teamId                    → TeamPage (load channels)
      /org/$orgId/team/$teamId/channel/$channelId → ChannelPage (chat view)
```

> "The nested route structure mirrors the data hierarchy. Each route level loads its corresponding data -- OrgLayout loads organizations and starts the presence heartbeat, OrgPage loads teams, TeamPage loads channels, and ChannelPage connects SSE and loads messages. This means navigation between channels only re-renders the innermost component, not the entire page."

### State Management (Zustand)

Two stores separate concerns:

**AuthStore**: user object, loading state, login/register/logout/checkAuth actions

**ChatStore**: The main state container holding:
- Data: organizations, teams, channels, messages, threadMessages, channelMembers
- Selection: currentOrgId, currentTeamId, currentChannelId, threadParentId
- Connection: SSE EventSource reference
- Actions: ~15 actions for loading data, sending messages, managing SSE, presence heartbeat

### Component Layout

```
┌──────┐ ┌──────────┐ ┌───────────────────────────┐ ┌──────────┐
│      │ │          │ │                           │ │          │
│ Org  │ │ Channel  │ │       Chat Area           │ │  Thread  │
│ +    │ │   List   │ │  ┌─────────────────────┐  │ │  Panel   │
│ Team │ │          │ │  │   Message List       │  │ │          │
│ Side │ │  #gen    │ │  │   ┌─MessageItem──┐   │  │ │  Parent  │
│ bar  │ │  #dev    │ │  │   │ Avatar Name  │   │  │ │  msg     │
│      │ │  #random │ │  │   │ Content      │   │  │ │          │
│  64  │ │          │ │  │   │ Reactions    │   │  │ │  Replies │
│  px  │ │  240px   │ │  │   └──────────────┘   │  │ │          │
│      │ │          │ │  └─────────────────────┘  │ │  320px   │
│      │ │          │ │  ┌─────────────────────┐  │ │          │
│      │ │          │ │  │   Message Input      │  │ │          │
│      │ │          │ │  └─────────────────────┘  │ │          │
└──────┘ └──────────┘ └───────────────────────────┘ └──────────┘
```

## 🔧 Deep Dive 1: Message Delivery Pipeline (Full-Stack)

> "This is the end-to-end flow from the moment a user presses Enter to when every channel member sees the message."

### Write Path

1. **Client**: User types message, presses Enter. ChatStore calls `messageApi.send(channelId, content)`
2. **API Server**: Express route validates auth and membership, enforces rate limit (120 msgs/min)
3. **Database**: Insert into messages table with channelId, userId, content. Return full message with UUID
4. **Pub/Sub**: Server publishes to Redis channel `teams:channel:{channelId}` with event type and message payload
5. **Response**: Return 201 with created message to sender

### Read Path (Real-Time)

1. **Redis Pub/Sub**: All API server instances subscribed to the channel receive the published event
2. **SSE Service**: Each server iterates its local SSE client map for that channelId
3. **SSE Push**: Server writes `event: new_message\ndata: {...}\n\n` to each client's response stream
4. **Client Processing**: EventSource `new_message` handler fires, ChatStore's `addMessageFromSSE` runs
5. **Deduplication**: Check if message ID already exists in state (prevents sender seeing duplicates)
6. **Render**: React re-renders MessageList with the new message, auto-scrolls to bottom if near bottom

### Why This Architecture

| Approach | Pros | Cons |
|----------|------|------|
| ✅ REST POST + SSE Push | Separation of concerns, rate limiting on writes | Two communication channels |
| ❌ WebSocket for both | Single connection | Must implement rate limiting in WS handler |
| ❌ Polling | Simplest | Latency proportional to poll interval, wasted requests |

> "Separating the write path (REST) from the read path (SSE) gives us the best of both worlds. REST POST gives us request/response semantics for error handling, rate limiting middleware, and standard HTTP tooling. SSE gives us efficient push without polling overhead. The trade-off is maintaining two communication channels, but they serve fundamentally different purposes and the separation makes each simpler to implement and debug."

### Cross-Instance Consistency

> "Without Redis pub/sub, a message sent to Server A would only reach SSE clients connected to Server A. Users connected to Server B would never see it until they reload. Redis pub/sub solves this by acting as a broadcast bus -- every server publishes to Redis, and every server subscribes, so all SSE clients across all instances receive every message."

## 🔧 Deep Dive 2: Channel and Thread Data Model

> "The data model design has cascading implications for query performance, real-time updates, and UI rendering."

### Channel Message Loading

The primary query pattern loads top-level messages (not thread replies) for a channel:

- Filter: `WHERE channel_id = $1 AND parent_message_id IS NULL`
- Sort: `ORDER BY created_at DESC`
- Pagination: `AND created_at < $2 LIMIT 50` (cursor-based)
- Join: Users table for username, display_name, avatar_url
- Subquery: `SELECT COUNT(*)` for reply_count per message

The client reverses the results for display (oldest first) and prepends older messages when scrolling up.

### Thread Loading

Thread view fetches all messages in a thread (parent + replies):

- Filter: `WHERE id = $1 OR parent_message_id = $1`
- Sort: `ORDER BY created_at ASC`
- No pagination (threads typically have <100 replies)

### Read Tracking

Each channel_member row has a `last_read_at` timestamp. The client calls `POST /api/channels/:id/read` when the user views a channel. Unread counts can be computed by counting messages with `created_at > last_read_at`, though this query needs optimization at scale (denormalize into a counter).

### Membership Cascade

Creating a team auto-creates a "General" channel and adds the creator to both. This is done in a database transaction:

1. `BEGIN`
2. `INSERT INTO teams`
3. `INSERT INTO team_members` (creator as owner)
4. `INSERT INTO channels` (General channel)
5. `INSERT INTO channel_members` (creator)
6. `COMMIT`

> "Transactions ensure the team, its default channel, and memberships are created atomically. Without transactions, a crash between steps 2 and 3 would leave a team with no channels -- a confusing state for the user."

### Real-Time Thread Updates

When a thread reply arrives via SSE, the client must handle two state updates:
1. In the channel feed: increment `reply_count` on the parent message
2. In the thread panel (if open): append the reply to `threadMessages`

> "This is where the self-referencing model pays off. The `parent_message_id` in the SSE event tells the client exactly how to route the update -- if it's null, append to channel feed; if it's set, update the parent's reply count and optionally append to the open thread."

## 🔧 Deep Dive 3: File Sharing Architecture

> "File sharing in a chat app seems straightforward but involves several tricky decisions around storage, upload flow, delivery, and security."

### Upload Flow

```
Client                    API Server                  MinIO
  │                           │                          │
  │  POST /api/files          │                          │
  │  (multipart/form-data)    │                          │
  │──────────────────────────▶│                          │
  │                           │  putObject()             │
  │                           │─────────────────────────▶│
  │                           │                          │
  │                           │  OK                      │
  │                           │◀─────────────────────────│
  │                           │                          │
  │                           │  INSERT INTO files       │
  │                           │  (metadata only)         │
  │                           │                          │
  │  201 { file metadata }    │                          │
  │◀──────────────────────────│                          │
  │                           │                          │
  │  Send message with        │                          │
  │  "[File: report.pdf]"     │                          │
  │──────────────────────────▶│                          │
```

### Download Flow

The client requests a presigned URL from the API, then downloads directly from MinIO:

1. `GET /api/files/:id/download` -- server generates a presigned URL (1-hour expiry)
2. Server returns the URL and file metadata
3. Client opens the presigned URL in a new tab
4. Browser downloads directly from MinIO, bypassing the API server

### Why Presigned URLs

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Presigned URL | Offloads bandwidth from API server | Time-limited, extra API call |
| ❌ Stream through API | Simple, auth built-in | API server becomes bandwidth bottleneck |
| ❌ Direct MinIO access | Lowest latency | Exposes storage credentials |

> "Presigned URLs are the standard pattern for object storage. The API server handles authentication and authorization (verifying the user has access to the file's channel), then generates a time-limited URL that the client uses to download directly from MinIO. This offloads file transfer bandwidth from the API server entirely. The trade-off is an extra API round trip to get the URL, but this is negligible compared to the file transfer time."

### File Size and Type Handling

- Upload limit: 50MB per file (enforced by multer)
- Storage path: `channels/{channelId}/{uuid}.{ext}` -- organized by channel for future access control
- Content type preserved in metadata for inline preview vs. download behavior
- Image detection via content_type for thumbnail rendering in chat

### Frontend File Display

The `FileAttachment` component renders a card with filename, size (formatted as KB/MB), and a download button. Image files show a preview icon; document files show a document icon.

## 📊 Presence System

### How It Works

- **Heartbeat**: Client sends `POST /api/presence/heartbeat` every 30 seconds
- **Storage**: Redis SETEX with 60-second TTL (`presence:{userId}`)
- **Query**: Redis pipeline EXIST for batch presence checks
- **Expiry**: If heartbeat stops (tab closed, offline), key auto-expires in 60 seconds

### Frontend Integration

The `OrgLayout` component starts the heartbeat when mounted and stops it on unmount. The `MemberList` component fetches channel presence and separates members into online/offline sections. The `PresenceIndicator` component renders a green (online) or gray (offline) dot overlaid on the user's avatar.

## ⚡ Scalability Discussion

### Current Bottlenecks and Solutions

1. **SSE connections**: Each server holds N connections in memory. At ~50K connections per server, file descriptors and memory become limits. Scale with dedicated SSE gateway servers behind sticky-session load balancing.

2. **Messages table growth**: With billions of messages, the `(channel_id, created_at)` index scan slows. Partition by date range (monthly) or by channel_id hash. For read-heavy channels, add a hot cache in Redis.

3. **Presence writes**: 333K heartbeats/sec at 10M users. A single Redis instance handles this, but shard by userId hash for redundancy.

### CQRS Path

At extreme scale, split write and read models:
- **Write**: PostgreSQL for message persistence (ACID guarantees)
- **Read**: Cassandra or DynamoDB for high-throughput message reads (partition by channel_id)
- **Search**: Elasticsearch for message search across channels
- **Analytics**: ClickHouse for message volume metrics

## 🔐 Authorization Across the Stack

The hierarchy — organization → team → channel → message — is the product's defining structure, and it's also where the worst possible bug lives. Every level has its own membership table, so "can Alice read this" is a question about which memberships she holds, not one check.

**Server side**, the check belongs inside the query rather than in handler code after the fetch. A handler that loads a message and then decides whether the user may see it has already pulled the row across a trust boundary, and every new endpoint is another chance to forget. As a join, the unauthorized row is simply never selected — the default for a newly written query becomes "returns nothing" instead of "returns everything."

The tempting optimization is to materialize effective permissions per user per channel so reads are one lookup. I'd resist it, because the two failure modes aren't comparable:

| Approach | Read cost | Failure mode |
|----------|-----------|--------------|
| ✅ Walk the membership chain per request | Three indexed lookups, joinable into one query | Slow reads — visible on a latency graph, fixable |
| ❌ Cache effective permissions | One lookup | A missed invalidation is a silent cross-tenant leak that persists until a customer finds it |

**Client side**, the same hierarchy shows up as navigation, and the important discipline is that the UI's checks are for *affordances*, not enforcement. Hiding a channel the user can't access is good UX; it is not security, because the API is reachable without the UI. Every check the client makes must be duplicated on the server, and the client's copy exists only so people aren't shown doors that won't open.

> "The line I'd draw is that the frontend decides what to *render* and the backend decides what to *return*. When those disagree the backend wins, and the visible result is an empty state rather than a leak. Designing so the failure mode is a blank panel instead of someone else's data is the whole point."

**Private channels are the case that justifies the extra table.** `is_private` means team membership stops being sufficient — someone can be on the team and still not belong in the channel. A model deriving channel access from team access can't express that at all, so adding private channels later would mean auditing every query in the system. Carrying channel membership from the start costs a join; retrofitting it costs a rewrite.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| ✅ SSE for real-time | HTTP-native, auto-reconnect | ❌ WebSocket | Simpler, writes via REST |
| ✅ Redis pub/sub | Low-latency broadcast | ❌ Kafka | Speed over durability for chat |
| ✅ Self-referencing threads | Simple schema, one table | ❌ Separate threads table | Flat threads only, simpler queries |
| ✅ Zustand | Lightweight, selector-based | ❌ Redux | Less boilerplate for chat state |
| ✅ TanStack Router | File-based, nested layouts | ❌ React Router | Type-safe params, matches hierarchy |
| ✅ Cursor pagination | Stable under concurrent writes | ❌ Offset pagination | No duplicates from new messages |
| ✅ MinIO + presigned URLs | Offloads bandwidth | ❌ Stream through API | API server stays lightweight |
| ✅ Redis TTL presence | Auto-cleanup, no jobs | ❌ Database polling | Sub-minute accuracy |
| ✅ Session auth | Server-managed, revocable | ❌ JWT | Simpler for SSE, no refresh tokens |

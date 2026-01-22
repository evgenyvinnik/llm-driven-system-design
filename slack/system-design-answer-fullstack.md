# Slack - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Problem Statement

Design a team messaging platform that allows users to:
- Send and receive messages in real-time
- Organize conversations into channels and threads
- Search across message history
- Manage multiple workspaces

---

## Requirements Clarification

### Functional Requirements
1. **Workspaces**: Isolated team environments with role-based access
2. **Channels**: Public/private channels with membership management
3. **Real-Time Messaging**: Instant message delivery with optimistic UI
4. **Threading**: Reply to specific messages with context preservation
5. **Search**: Full-text search with filters

### Non-Functional Requirements
1. **Low Latency**: Message delivery < 200ms, UI response < 100ms
2. **Consistency**: Messages appear in order across all clients
3. **Availability**: 99.99% uptime for messaging
4. **Scalability**: Support millions of concurrent users

### Scale Estimates
- 10M workspaces, avg 100 users/workspace
- 1B messages/day = ~12K messages/sec
- Read-heavy: 100:1 read:write ratio

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Browser (React Application)                          │
│  Components: ChannelSidebar | MessageList | Composer | ThreadPanel       │
│  Zustand Store: workspaces, channels, messages, presence, typing         │
│  WebSocket Client + REST API Service                                     │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ WebSocket + REST API
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Gateway Cluster (WebSocket)                       │
│  Connection Manager | Message Router | Presence Tracker                  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Message Service (REST)                            │
│  auth.ts (login/logout/register)                                         │
│  channels.ts (list/create/join/leave)                                    │
│  messages.ts (send + fan-out/edit/delete)                                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Data Layer                                      │
│  PostgreSQL (messages, channels) | Valkey (pub/sub, presence)            │
│  Elasticsearch (search index)                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Database Schema

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Database Schema                                │
├─────────────────────────────────────────────────────────────────────────┤
│  users                      workspaces                                   │
│  ┌─────────────────┐        ┌──────────────────┐                        │
│  │ id (UUID PK)    │        │ id (UUID PK)     │                        │
│  │ email (UNIQUE)  │        │ name             │                        │
│  │ password_hash   │        │ domain (UNIQUE)  │                        │
│  │ username        │        │ settings (JSONB) │                        │
│  │ display_name    │        └────────┬─────────┘                        │
│  │ avatar_url      │                 │                                  │
│  └────────┬────────┘                 ▼                                  │
│           │          ┌──────────────────────────┐                       │
│           └─────────▶│   workspace_members      │                       │
│                      │ workspace_id, user_id(PK)│                       │
│                      │ role (owner/admin/member)│                       │
│                      └──────────────────────────┘                       │
│                                                                          │
│  channels                           messages                             │
│  ┌─────────────────────┐            ┌──────────────────────────────────┐│
│  │ id (UUID PK)        │◀───────────│ channel_id (FK)                  ││
│  │ workspace_id (FK)   │            │ id (BIGSERIAL PK)                ││
│  │ name (UNIQUE/ws)    │            │ workspace_id, user_id (FK)       ││
│  │ topic, is_private   │            │ thread_ts (FK to messages.id)    ││
│  └─────────────────────┘            │ content, reply_count, created_at ││
│                                     │ edited_at                         ││
│                                     └──────────────────────────────────┘│
│  KEY INDEXES:                                                            │
│  • messages: (channel_id, created_at DESC), (thread_ts WHERE NOT NULL)  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Shared TypeScript Interfaces

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  shared/types.ts - Frontend + Backend                    │
├─────────────────────────────────────────────────────────────────────────┤
│  User: id, email, username, display_name, avatar_url?                   │
│  Workspace: id, name, domain?                                           │
│  Channel: id, workspace_id, name, topic?, is_private                    │
│  Message: id, channel_id, user_id, content, thread_ts?, reply_count     │
│           created_at, edited_at?, pending? (FE), failed? (FE)           │
│  WebSocketMessage: type ('message' | 'presence' | 'typing' | 'reaction')│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Real-Time Message Flow

### End-to-End Message Delivery

```
User A types message ──▶ MessageComposer (React)
                              │ Optimistic UI + POST /api/messages
                              ▼
                        Message Service (Express)
                              │ Validate → Store to DB → Fan-out
                              ▼
                        PUBLISH user:{id}:messages
                              │
                        Valkey Pub/Sub ──▶ Gateway Server ──▶ WebSocket
                                                              │
                        User B Browser (Zustand store updates, MessageList re-renders)
```

### Backend: Message Send Handler

```
┌─────────────────────────────────────────────────────────────────────────┐
│                POST /channels/:channelId/messages                        │
├─────────────────────────────────────────────────────────────────────────┤
│  INPUT: { content, idempotency_key } + session.userId                   │
│                                                                          │
│  1. IDEMPOTENCY CHECK                                                    │
│     Check Redis: idem:{key} → if exists, return cached response          │
│                                                                          │
│  2. AUTHORIZATION                                                        │
│     Query channel_members → 403 if not member                            │
│                                                                          │
│  3. INSERT MESSAGE                                                       │
│     INSERT INTO messages (channel_id, user_id, content) RETURNING *      │
│                                                                          │
│  4. FAN-OUT TO CHANNEL MEMBERS                                           │
│     For each member: redis.publish(user:{memberId}:messages, {message})  │
│                                                                          │
│  5. QUEUE FOR SEARCH INDEXING                                            │
│     searchQueue.add({ type: 'index_message', message })                  │
│                                                                          │
│  6. CACHE IDEMPOTENCY KEY (TTL: 24h)                                     │
│                                                                          │
│  OUTPUT: 201 Created + message object                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Optimistic Message Send

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     MessageComposer Component                            │
├─────────────────────────────────────────────────────────────────────────┤
│  User submits message                                                    │
│         │                                                                │
│         ▼                                                                │
│  1. Generate idempotency key: msg:{channelId}:{timestamp}                │
│  2. Create optimistic message: { id: temp-{ts}, pending: true, ... }     │
│  3. Add to Zustand store immediately (UI shows "sending...")             │
│  4. Call API                                                             │
│         │                                                                │
│    ┌────┴────┐                                                           │
│    ▼         ▼                                                           │
│ SUCCESS   FAILURE                                                        │
│    │         │                                                           │
│ Replace   Update: { failed: true, pending: false }                       │
│ temp msg  UI shows retry button                                          │
│ with real                                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### WebSocket Integration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       useWebSocket Hook                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  On Mount: Connect to wss://api.slack.local/ws                          │
│                                                                          │
│  ws.onmessage: parse JSON, switch on data.type:                          │
│    • 'message': Skip if own message (optimistic), else addMessage()      │
│    • 'presence': setPresence(user_id, status)                            │
│    • 'typing': setTyping(channel_id, user_id)                            │
│                                                                          │
│  On Unmount: ws.close()                                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Thread Implementation

### Backend: Thread Reply Handler

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  POST /messages/:messageId/replies                       │
├─────────────────────────────────────────────────────────────────────────┤
│  INPUT: { content } + messageId + session.userId                         │
│                                                                          │
│  1. FETCH PARENT: SELECT * FROM messages WHERE id = messageId            │
│     → 404 if not found                                                   │
│                                                                          │
│  2. TRANSACTION:                                                         │
│     BEGIN                                                                │
│       INSERT INTO messages (..., thread_ts: messageId) RETURNING *       │
│       UPDATE messages SET reply_count = reply_count + 1 WHERE id = msgId │
│     COMMIT                                                               │
│                                                                          │
│  3. FAN-OUT: Notify thread participants + channel members                │
│                                                                          │
│  OUTPUT: 201 Created + reply object                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Thread Panel

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ThreadPanel Component                             │
├─────────────────────────────────────────────────────────────────────────┤
│  STATE: activeThreadId (from Zustand), replies (local)                   │
│                                                                          │
│  useEffect [activeThreadId]:                                             │
│    api.getThreadReplies(activeThreadId).then(setReplies)                 │
│                                                                          │
│  useEffect [WebSocket listener]:                                         │
│    If data.message.thread_ts === activeThreadId: append to replies       │
│                                                                          │
│  RENDER: Header + scrollable reply list + ThreadComposer                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Presence System

### Backend: Presence Tracking

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Presence Service                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  updatePresence(userId, workspaceId):                                    │
│    Called by WebSocket gateway on heartbeat                              │
│    SETEX presence:{workspaceId}:{userId} 60 {status: 'online', lastSeen} │
│    Broadcast presence change to visible users                            │
│                                                                          │
│  getOnlineUsers(workspaceId) -> string[]:                                │
│    Use SCAN (not KEYS - production safe):                                │
│    SCAN cursor MATCH presence:{workspaceId}:* COUNT 100                  │
│    Extract user IDs from keys                                            │
│                                                                          │
│  "60-second TTL provides automatic cleanup when users disconnect"        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Presence Display

```
PresenceIndicator({ userId }):
  isOnline = onlineUsers.has(userId)
  Render: green dot (online) or gray dot (offline)

ChannelItem({ channel }):
  If DM: show PresenceIndicator for other user
  Else: show HashIcon
```

---

## Deep Dive: Search

### Backend: Search API

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           GET /search                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  INPUT: { q, channel_id?, user_id?, from?, to? } + session.workspaceId   │
│                                                                          │
│  TRY: ELASTICSEARCH                                                      │
│    bool: must [term: workspace_id, match: content = q]                   │
│    filter: channel_id, user_id, date range                               │
│    highlight: { fields: { content: {} } }                                │
│                                                                          │
│  CATCH: FALLBACK TO POSTGRESQL FTS                                       │
│    SELECT * FROM messages                                                │
│    WHERE to_tsvector('english', content) @@ plainto_tsquery('english', q)│
│                                                                          │
│  "PostgreSQL FTS as graceful degradation when ES unavailable"            │
│                                                                          │
│  OUTPUT: { messages: [...], total: number }                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Search UI

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SearchModal Component                             │
├─────────────────────────────────────────────────────────────────────────┤
│  STATE: query, results, isLoading                                        │
│                                                                          │
│  DEBOUNCED SEARCH (300ms):                                               │
│    if (!query.trim()) return                                             │
│    response = await api.search({ q })                                    │
│    setResults(response.messages)                                         │
│                                                                          │
│  RENDER:                                                                 │
│    Modal with search input (autofocus)                                   │
│    Scrollable results (max-h-96)                                         │
│                                                                          │
│  SearchResultItem:                                                       │
│    onClick: navigate to channel with message                             │
│    Display: #{channel_name} · date + highlight from ES                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Session Management

### Backend Configuration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Express Session Setup                               │
├─────────────────────────────────────────────────────────────────────────┤
│  Session: store: RedisStore, resave: false, saveUninitialized: false     │
│  Cookie: maxAge: 24h, httpOnly: true, secure: prod, sameSite: 'lax'      │
│                                                                          │
│  "Redis store enables session sharing across multiple API instances"     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend Auth State (Zustand)

```
State: user, isAuthenticated, isLoading
Actions:
  checkAuth: api.getCurrentUser() → set user or clear
  login(email, password): api.login() → set user
  logout: api.logout() → clear user
```

---

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| User-level pub/sub | Simple gateway logic | More pub/sub channels |
| Optimistic updates | Instant UI feedback | Rollback complexity |
| Zustand over Redux | Less boilerplate | Smaller ecosystem |
| PostgreSQL + Elasticsearch | Best of both | Operational complexity |
| Session in Redis | Fast, supports WebSocket auth | Additional infra |

---

## Scalability Path

### Current: Single Server
```
Browser → Gateway (WebSocket) → Express (REST) → PostgreSQL
                            ↓
                          Valkey (pub/sub, sessions)
```

### Future: Scaled
```
Browser → CDN (static) → Load Balancer → Gateway Cluster (3 nodes)
                                     ↓
                              Valkey Cluster (pub/sub)
                                     ↓
                              API Servers (3 nodes)
                                     ↓
                         PostgreSQL (sharded by workspace)
```

1. **Shard by workspace**: Each workspace's data on specific shards
2. **Gateway cluster**: Multiple WebSocket servers behind load balancer
3. **Read replicas**: Scale read-heavy message queries
4. **CDN for assets**: Static files and user avatars

---

## Future Enhancements

1. **Rich Text Editor**: WYSIWYG with markdown support
2. **File Uploads**: Drag & drop with previews
3. **Webhooks & Integrations**: External system notifications
4. **Voice/Video Calls**: WebRTC integration
5. **Message Retention**: Configurable retention policies
6. **Audit Logging**: Enterprise compliance features

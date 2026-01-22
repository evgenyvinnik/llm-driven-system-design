# Slack - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Problem Statement

Design a team messaging platform that allows users to:
- Send and receive messages in real-time
- Organize conversations into channels and threads
- Search across message history
- Manage multiple workspaces

This answer covers the end-to-end architecture, emphasizing the integration between frontend and backend components.

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

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Browser (React Application)                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Components: ChannelSidebar | MessageList | Composer | ThreadPanel│  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │  Zustand Store: workspaces, channels, messages, presence, typing  │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │  WebSocket Client + REST API Service                              │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
└──────────────────────────────┼───────────────────────────────────────────┘
                               │ WebSocket + REST API
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Gateway Cluster (WebSocket)                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Connection Manager | Message Router | Presence Tracker           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬───────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Message Service (REST)                            │
│  ┌────────────────┐  ┌──────────────────┐  ┌───────────────────────┐   │
│  │  auth.ts       │  │  channels.ts      │  │  messages.ts          │   │
│  │  - login       │  │  - list           │  │  - send (+ fan-out)   │   │
│  │  - logout      │  │  - create         │  │  - edit               │   │
│  │  - register    │  │  - join/leave     │  │  - delete             │   │
│  └────────────────┘  └──────────────────┘  └───────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Data Layer                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  PostgreSQL  │  │    Valkey    │  │Elasticsearch │                  │
│  │  (messages,  │  │  (pub/sub,   │  │  (search     │                  │
│  │  channels)   │  │  presence)   │  │  index)      │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Model

### Database Schema

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Database Schema                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐      ┌──────────────────┐                          │
│  │     users       │      │   workspaces     │                          │
│  ├─────────────────┤      ├──────────────────┤                          │
│  │ id (UUID PK)    │      │ id (UUID PK)     │                          │
│  │ email (UNIQUE)  │      │ name             │                          │
│  │ password_hash   │      │ domain (UNIQUE)  │                          │
│  │ username        │      │ settings (JSONB) │                          │
│  │ display_name    │      │ created_at       │                          │
│  │ avatar_url      │      └────────┬─────────┘                          │
│  │ created_at      │               │                                    │
│  └────────┬────────┘               │                                    │
│           │                        ▼                                    │
│           │          ┌──────────────────────────┐                       │
│           └─────────▶│   workspace_members      │                       │
│                      ├──────────────────────────┤                       │
│                      │ workspace_id (PK, FK)    │                       │
│                      │ user_id (PK, FK)         │                       │
│                      │ role (owner/admin/member)│                       │
│                      │ joined_at                │                       │
│                      └──────────────────────────┘                       │
│                                                                          │
│  ┌─────────────────────┐      ┌──────────────────────────────────────┐  │
│  │     channels        │      │              messages                 │  │
│  ├─────────────────────┤      ├──────────────────────────────────────┤  │
│  │ id (UUID PK)        │◀─────│ channel_id (FK)                      │  │
│  │ workspace_id (FK)   │      │ id (BIGSERIAL PK)                    │  │
│  │ name (UNIQUE/ws)    │      │ workspace_id (FK)                    │  │
│  │ topic               │      │ user_id (FK)                         │  │
│  │ is_private          │      │ thread_ts (FK to messages.id)        │  │
│  │ created_at          │      │ content (TEXT)                       │  │
│  └─────────────────────┘      │ reply_count (DEFAULT 0)              │  │
│                               │ created_at                            │  │
│                               │ edited_at                             │  │
│                               └──────────────────────────────────────┘  │
│                                                                          │
│  KEY INDEXES:                                                            │
│  • messages: (channel_id, created_at DESC) - chronological fetching     │
│  • messages: (thread_ts) WHERE thread_ts IS NOT NULL - thread replies   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Shared TypeScript Interfaces

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  shared/types.ts - Frontend + Backend                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User                          │  Workspace                              │
│  ┌───────────────────────────┐ │  ┌───────────────────────────────────┐ │
│  │ id: string                │ │  │ id: string                        │ │
│  │ email: string             │ │  │ name: string                      │ │
│  │ username: string          │ │  │ domain?: string                   │ │
│  │ display_name: string      │ │  └───────────────────────────────────┘ │
│  │ avatar_url?: string       │ │                                        │
│  └───────────────────────────┘ │  Channel                               │
│                                │  ┌───────────────────────────────────┐ │
│  Message                       │  │ id: string                        │ │
│  ┌───────────────────────────┐ │  │ workspace_id: string              │ │
│  │ id: string                │ │  │ name: string                      │ │
│  │ channel_id: string        │ │  │ topic?: string                    │ │
│  │ user_id: string           │ │  │ is_private: boolean               │ │
│  │ content: string           │ │  └───────────────────────────────────┘ │
│  │ thread_ts?: string        │ │                                        │
│  │ reply_count: number       │ │  WebSocketMessage                      │
│  │ created_at: string        │ │  ┌───────────────────────────────────┐ │
│  │ edited_at?: string        │ │  │ type: 'message' | 'presence'      │ │
│  │ pending?: boolean (FE)    │ │  │      | 'typing' | 'reaction'      │ │
│  │ failed?: boolean (FE)     │ │  │ [key: string]: any                │ │
│  └───────────────────────────┘ │  └───────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Real-Time Message Flow

### End-to-End Message Delivery

```
User A types message
        │
        ▼
┌─────────────────┐
│  MessageComposer │  (React Component)
│  - Optimistic UI │
│  - Send to API   │
└────────┬────────┘
         │ POST /api/messages
         ▼
┌─────────────────┐
│  Message Service │  (Express Route)
│  - Validate      │
│  - Store to DB   │
│  - Fan-out       │
└────────┬────────┘
         │ PUBLISH user:{id}:messages
         ▼
┌─────────────────┐
│  Valkey Pub/Sub  │
│  - Route to      │
│    subscribers   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Gateway Server  │
│  - WebSocket     │
│    connection    │
└────────┬────────┘
         │ ws.send(message)
         ▼
┌─────────────────┐
│  User B Browser  │
│  - Zustand store │
│  - MessageList   │
│    re-renders    │
└─────────────────┘
```

### Backend: Message Send Handler

```
┌─────────────────────────────────────────────────────────────────────────┐
│                POST /channels/:channelId/messages                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  INPUT: { content, idempotency_key } + session.userId                   │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 1. IDEMPOTENCY CHECK                                              │  │
│  │    If idempotency_key provided:                                   │  │
│  │      Check Redis: idem:{key}                                      │  │
│  │      If exists: return cached response immediately                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 2. AUTHORIZATION                                                  │  │
│  │    Query channel_members WHERE channel_id AND user_id             │  │
│  │    If not member: return 403 "Not a channel member"               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 3. INSERT MESSAGE                                                 │  │
│  │    INSERT INTO messages (channel_id, user_id, content, ws_id)     │  │
│  │    RETURNING *                                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 4. FAN-OUT TO CHANNEL MEMBERS                                     │  │
│  │    Query all user_ids in channel_members                          │  │
│  │    For each member:                                               │  │
│  │      redis.publish(user:{memberId}:messages, {type, message})     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 5. QUEUE FOR SEARCH INDEXING                                      │  │
│  │    searchQueue.add({ type: 'index_message', message })            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 6. CACHE IDEMPOTENCY KEY                                          │  │
│  │    redis.setex(idem:{key}, 86400, JSON.stringify(message))        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  OUTPUT: 201 Created + message object                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Optimistic Message Send

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     MessageComposer Component                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User submits message                                                    │
│           │                                                              │
│           ▼                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 1. GENERATE IDEMPOTENCY KEY                                       │  │
│  │    key = msg:{channelId}:{Date.now()}                             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│           │                                                              │
│           ▼                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 2. CREATE OPTIMISTIC MESSAGE                                      │  │
│  │    {                                                              │  │
│  │      id: temp-{timestamp},                                        │  │
│  │      channel_id, user_id, content,                                │  │
│  │      created_at: new Date().toISOString(),                        │  │
│  │      reply_count: 0,                                              │  │
│  │      pending: true   ◀── UI shows "sending..." indicator          │  │
│  │    }                                                              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│           │                                                              │
│           ▼                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 3. ADD TO ZUSTAND STORE IMMEDIATELY                               │  │
│  │    addMessage(channelId, optimisticMessage)                       │  │
│  │    Clear input field                                              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────────────────┐                                        │
│  │ 4. CALL API                 │                                        │
│  │    api.sendMessage(...)     │                                        │
│  └─────────────┬───────────────┘                                        │
│                │                                                         │
│      ┌─────────┴─────────┐                                              │
│      ▼                   ▼                                              │
│  ┌────────┐         ┌────────────────────────────────────────────────┐  │
│  │SUCCESS │         │ FAILURE                                        │  │
│  │        │         │                                                │  │
│  │Replace │         │ Update message in store:                       │  │
│  │temp msg│         │ { ...msg, failed: true, pending: false }       │  │
│  │with    │         │                                                │  │
│  │real msg│         │ UI shows retry button                          │  │
│  └────────┘         └────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: WebSocket Integration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       useWebSocket Hook                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  On Mount: Connect to wss://api.slack.local/ws                          │
│                                                                          │
│  ws.onmessage = (event) => {                                            │
│           │                                                              │
│           ▼                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Parse JSON: data = JSON.parse(event.data)                        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│           │                                                              │
│           ▼                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  SWITCH on data.type:                                             │  │
│  │                                                                   │  │
│  │  case 'message':                                                  │  │
│  │    • Skip if message.user_id === currentUserId                    │  │
│  │      (already added optimistically)                               │  │
│  │    • Otherwise: addMessage(channel_id, message)                   │  │
│  │                                                                   │  │
│  │  case 'presence':                                                 │  │
│  │    • setPresence(data.user_id, data.status)                       │  │
│  │                                                                   │  │
│  │  case 'typing':                                                   │  │
│  │    • setTyping(data.channel_id, data.user_id)                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  On Unmount: ws.close()                                                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Thread Implementation

### Backend: Thread Reply Handler

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  POST /messages/:messageId/replies                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  INPUT: { content } + messageId from URL + session.userId               │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 1. FETCH PARENT MESSAGE                                           │  │
│  │    SELECT * FROM messages WHERE id = messageId                    │  │
│  │    If not found: return 404                                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 2. TRANSACTION                                                    │  │
│  │    BEGIN                                                          │  │
│  │      INSERT INTO messages (                                       │  │
│  │        channel_id: parent.channel_id,                             │  │
│  │        workspace_id: parent.workspace_id,                         │  │
│  │        user_id: session.userId,                                   │  │
│  │        thread_ts: messageId,   ◀── Link to parent                 │  │
│  │        content                                                    │  │
│  │      ) RETURNING *                                                │  │
│  │                                                                   │  │
│  │      UPDATE messages SET reply_count = reply_count + 1            │  │
│  │        WHERE id = messageId                                       │  │
│  │    COMMIT                                                         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 3. FAN-OUT                                                        │  │
│  │    Notify: thread participants + channel members                  │  │
│  │    fanOutThreadReply(parent, reply)                               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  OUTPUT: 201 Created + reply object                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Thread Panel

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ThreadPanel Component                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ STATE                                                             │  │
│  │ • activeThreadId from Zustand store                               │  │
│  │ • replies: Message[] (local state)                                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ useEffect [activeThreadId]                                        │  │
│  │   If activeThreadId:                                              │  │
│  │     api.getThreadReplies(activeThreadId).then(setReplies)         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ useEffect [WebSocket listener]                                    │  │
│  │   wsEvents.on('message', (data) => {                              │  │
│  │     If data.message.thread_ts === activeThreadId:                 │  │
│  │       setReplies(prev => [...prev, data.message])                 │  │
│  │   })                                                              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  RENDER (if activeThreadId):                                            │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ ┌────────────────────────────────────────────────────────────┐ │     │
│  │ │ Header: "Thread" + Close button                            │ │     │
│  │ └────────────────────────────────────────────────────────────┘ │     │
│  │ ┌────────────────────────────────────────────────────────────┐ │     │
│  │ │ Scrollable reply list                                      │ │     │
│  │ │   {replies.map(r => <MessageItem message={r} />)}          │ │     │
│  │ └────────────────────────────────────────────────────────────┘ │     │
│  │ ┌────────────────────────────────────────────────────────────┐ │     │
│  │ │ ThreadComposer (parentId={activeThreadId})                 │ │     │
│  │ └────────────────────────────────────────────────────────────┘ │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Presence System

### Backend: Presence Tracking

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Presence Service                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  updatePresence(userId, workspaceId)                                    │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Called by WebSocket gateway on heartbeat                         │  │
│  │                                                                   │  │
│  │  1. Set presence with TTL:                                        │  │
│  │     SETEX presence:{workspaceId}:{userId} 60                      │  │
│  │           {status: 'online', lastSeen: Date.now()}                │  │
│  │                                                                   │  │
│  │  2. Broadcast to visible users:                                   │  │
│  │     broadcastPresenceChange(workspaceId, userId, 'online')        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  getOnlineUsers(workspaceId) -> string[]                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Use SCAN to iterate (not KEYS - production safe):                │  │
│  │                                                                   │  │
│  │  cursor = '0'                                                     │  │
│  │  keys = []                                                        │  │
│  │  do {                                                             │  │
│  │    [cursor, matchedKeys] = SCAN cursor                            │  │
│  │                            MATCH presence:{workspaceId}:*         │  │
│  │                            COUNT 100                              │  │
│  │    keys.push(...matchedKeys)                                      │  │
│  │  } while (cursor !== '0')                                         │  │
│  │                                                                   │  │
│  │  return keys.map(k => k.split(':')[2])  // Extract user IDs       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  "60-second TTL provides automatic cleanup when users disconnect"       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Presence Display

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Presence Components                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PresenceIndicator({ userId })                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Read from Zustand: isOnline = onlineUsers.has(userId)            │  │
│  │                                                                   │  │
│  │  Render:                                                          │  │
│  │    <span className={isOnline ? 'bg-green-500' : 'bg-gray-400'}    │  │
│  │          aria-label={isOnline ? 'Online' : 'Offline'} />          │  │
│  │                                                                   │  │
│  │  Visual: ● (green) = online, ● (gray) = offline                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ChannelItem({ channel })                                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  <button className="flex items-center gap-2">                     │  │
│  │    {channel.is_dm                                                 │  │
│  │      ? <PresenceIndicator userId={channel.other_user_id} />       │  │
│  │      : <HashIcon />}                                              │  │
│  │    <span>{channel.name}</span>                                    │  │
│  │  </button>                                                        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Search

### Backend: Search API

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           GET /search                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  INPUT: query params { q, channel_id?, user_id?, from?, to? }           │
│         + session.workspaceId                                           │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ TRY: ELASTICSEARCH QUERY                                          │  │
│  │                                                                   │  │
│  │   bool:                                                           │  │
│  │     must:                                                         │  │
│  │       - term: workspace_id                                        │  │
│  │       - match: content = q                                        │  │
│  │     filter (if provided):                                         │  │
│  │       - term: channel_id                                          │  │
│  │       - term: user_id                                             │  │
│  │       - range: created_at { gte: from, lte: to }                  │  │
│  │                                                                   │  │
│  │   highlight: { fields: { content: {} } }                          │  │
│  │                                                                   │  │
│  │   Response: messages with highlight.content[0] for matched text   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ CATCH: FALLBACK TO POSTGRESQL FTS                                 │  │
│  │                                                                   │  │
│  │   SELECT * FROM messages                                          │  │
│  │   WHERE workspace_id = ?                                          │  │
│  │     AND to_tsvector('english', content)                           │  │
│  │         @@ plainto_tsquery('english', ?)                          │  │
│  │   LIMIT 50                                                        │  │
│  │                                                                   │  │
│  │   "PostgreSQL FTS as graceful degradation when ES unavailable"   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  OUTPUT: { messages: [...], total: number }                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Search UI

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SearchModal Component                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  STATE: query (string), results (SearchResult[]), isLoading (boolean)  │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ DEBOUNCED SEARCH (300ms)                                          │  │
│  │                                                                   │  │
│  │ useMemo(() => debounce(async (q) => {                             │  │
│  │   if (!q.trim()) { setResults([]); return; }                      │  │
│  │   setIsLoading(true);                                             │  │
│  │   try {                                                           │  │
│  │     const response = await api.search({ q });                     │  │
│  │     setResults(response.messages);                                │  │
│  │   } finally {                                                     │  │
│  │     setIsLoading(false);                                          │  │
│  │   }                                                               │  │
│  │ }, 300), [])                                                      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  RENDER:                                                                │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ Modal overlay (bg-black/50)                                    │     │
│  │ ┌────────────────────────────────────────────────────────────┐ │     │
│  │ │ Search input (autofocus)                                   │ │     │
│  │ └────────────────────────────────────────────────────────────┘ │     │
│  │ ┌────────────────────────────────────────────────────────────┐ │     │
│  │ │ Results (scrollable, max-h-96):                            │ │     │
│  │ │   isLoading ? "Searching..."                               │ │     │
│  │ │   : results.length === 0 ? "No results"                    │ │     │
│  │ │   : results.map(r => <SearchResultItem />)                 │ │     │
│  │ └────────────────────────────────────────────────────────────┘ │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  SearchResultItem:                                                      │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ onClick: navigate(`/channel/${channel_id}?message=${id}`)         │  │
│  │                                                                   │  │
│  │ Render:                                                           │  │
│  │   <div>#{channel_name} · {formatDate(created_at)}</div>           │  │
│  │   <div dangerouslySetInnerHTML={{ __html: highlight || content }} │  │
│  │        />  ◀── Shows <em> tags from ES highlight                  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Session Management

### Backend Configuration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Express Session Setup                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Session Configuration:                                                  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  store: new RedisStore({ client: redis })                         │  │
│  │  secret: process.env.SESSION_SECRET                               │  │
│  │  resave: false                                                    │  │
│  │  saveUninitialized: false                                         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Cookie Options:                                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  maxAge: 24 * 60 * 60 * 1000 (24 hours)                           │  │
│  │  httpOnly: true                                                   │  │
│  │  secure: NODE_ENV === 'production'                                │  │
│  │  sameSite: 'lax'                                                  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  "Redis store enables session sharing across multiple API instances"    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend Auth State

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     useAuthStore (Zustand)                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  State:                                                                 │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  user: User | null                                                │  │
│  │  isAuthenticated: boolean                                         │  │
│  │  isLoading: boolean                                               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Actions:                                                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  checkAuth:                                                       │  │
│  │    try: user = await api.getCurrentUser()                         │  │
│  │         set({ user, isAuthenticated: true })                      │  │
│  │    catch: set({ user: null, isAuthenticated: false })             │  │
│  │    finally: set({ isLoading: false })                             │  │
│  │                                                                   │  │
│  │  login(email, password):                                          │  │
│  │    user = await api.login(email, password)                        │  │
│  │    set({ user, isAuthenticated: true })                           │  │
│  │                                                                   │  │
│  │  logout:                                                          │  │
│  │    await api.logout()                                             │  │
│  │    set({ user: null, isAuthenticated: false })                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| User-level pub/sub | Simple gateway logic | More pub/sub channels |
| Optimistic updates | Instant UI feedback | Rollback complexity |
| Zustand over Redux | Less boilerplate | Smaller ecosystem |
| PostgreSQL + Elasticsearch | Best of both | Operational complexity |
| Session in Redis | Fast, supports WebSocket auth | Additional infra |

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

## Future Enhancements

1. **Rich Text Editor**: WYSIWYG with markdown support
2. **File Uploads**: Drag & drop with previews
3. **Webhooks & Integrations**: External system notifications
4. **Voice/Video Calls**: WebRTC integration
5. **Message Retention**: Configurable retention policies
6. **Audit Logging**: Enterprise compliance features

# Instagram - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement

"I'll design Instagram focusing on the end-to-end photo upload flow, feed generation connecting backend caching with frontend virtualization, story view tracking with real-time updates, and WebSocket-based direct messaging."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Photo Upload** - Client-side preview, upload with progress, backend processing
2. **Feed** - Personalized feed with backend caching and frontend virtualization
3. **Stories** - Upload, view tracking, 24-hour expiration with real-time tray updates
4. **Direct Messaging** - Real-time messaging with WebSocket delivery
5. **Social Graph** - Follow/unfollow with immediate UI feedback

### Non-Functional Requirements

- **Scale**: 500M+ DAU, 100M+ posts/day
- **Latency**: Feed < 200ms, uploads < 500ms acknowledgment
- **Consistency**: Strong for social graph, eventual for feeds
- **Real-time**: Sub-second message delivery, story view updates

### Full-Stack Clarifications

- "Processing status to client?" - WebSocket push with polling fallback
- "Feed freshness across tabs?" - Visibility API triggers refresh on focus
- "Consistency model for likes?" - Optimistic UI with eventual sync

---

## Step 2: System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Feed View    │  │ Story Viewer │  │ Post Creator │  │ DM Interface │    │
│  │ (Virtualized)│  │ (Auto-adv)   │  │ (Upload)     │  │ (WebSocket)  │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                 │                 │             │
│  ┌──────┴─────────────────┴─────────────────┴─────────────────┴──────┐     │
│  │                      Zustand Stores                                │     │
│  │   feedStore    storyStore    uploadStore    messageStore           │     │
│  └──────────────────────────────────────────────────────────────────┘      │
│         │                 │                 │                 │             │
│  ┌──────┴─────────────────┴─────────────────┴─────────────────┴──────┐     │
│  │                      API Client / WebSocket                        │     │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVER LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   Express    │  │  WebSocket   │  │   Image      │  │   Story      │    │
│  │   API        │  │  Gateway     │  │   Worker     │  │   Cleanup    │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                 │                 │             │
│  ┌──────┴─────────────────┴─────────────────┴─────────────────┴──────┐     │
│  │                      Shared Services                               │     │
│  │   PostgreSQL    Cassandra    Valkey    MinIO    RabbitMQ           │     │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Shared Type Contracts

### Core Domain Types

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           User Interface                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  id: string              │  username: string         │  displayName: string │
│  avatarUrl: string       │  bio: string              │  isPrivate: boolean  │
│  followerCount: number   │  followingCount: number   │  postCount: number   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           Post Interface                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  id: string              │  userId: string           │  author: UserPreview │
│  caption: string         │  location?: string        │                      │
│  status: 'processing' | 'published' | 'failed'       │                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Image URLs: thumbnailUrl, smallUrl, mediumUrl, largeUrl                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  likeCount: number       │  commentCount: number     │  isLiked: boolean    │
│  isSaved: boolean        │  createdAt: string        │                      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           Story Interface                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  id: string              │  userId: string           │  mediaUrl: string    │
│  mediaType: 'image' | 'video'                        │  viewCount: number   │
│  expiresAt: string       │  createdAt: string        │                      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           Message Interface                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  id: string              │  conversationId: string   │  senderId: string    │
│  content: string         │  contentType: 'text' | 'image' | 'video' | 'heart'
│  mediaUrl?: string       │  createdAt: string        │                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### WebSocket Message Types

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WebSocket Message Types                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  new_message   │  payload: Message                                          │
│  typing        │  payload: { conversationId, userId }                       │
│  read_receipt  │  payload: { conversationId, messageId }                    │
│  story_view    │  payload: { storyId, viewerId }                            │
│  post_ready    │  payload: { postId, urls: PostUrls }                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 4: End-to-End Photo Upload Flow

### Frontend: CreatePost Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CreatePost Component                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  State:                                                                      │
│  ├── file: File | null                                                       │
│  ├── preview: string | null (local DataURL)                                  │
│  ├── caption: string                                                         │
│  ├── uploadProgress: number (0-100)                                          │
│  └── status: 'idle' | 'uploading' | 'processing'                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  File Selection:                                                             │
│  ├── User selects file via <input type="file">                               │
│  ├── FileReader reads as DataURL for local preview                           │
│  └── Preview displayed immediately (no upload yet)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  Upload Flow:                                                                │
│  ├── 1. Create FormData with image + caption                                 │
│  ├── 2. api.createPost(formData, progressCallback)                           │
│  ├── 3. Set status = 'processing'                                            │
│  ├── 4. Add optimistic post with local preview URL                           │
│  ├── 5. Subscribe to WebSocket 'post_ready' event                            │
│  └── 6. Start polling fallback (1s intervals, 30 max)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  When post_ready received:                                                   │
│  ├── Update post status to 'published'                                       │
│  ├── Replace local preview URLs with processed URLs                          │
│  └── Unsubscribe from WebSocket event                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Upload Controller

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         POST /api/v1/posts                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Middleware: requireAuth, multer (10MB limit, images only)                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Request Processing:                                                         │
│  ├── 1. Generate postId (UUID)                                               │
│  ├── 2. Store original in MinIO: originals/{date}/{postId}.{ext}             │
│  ├── 3. Insert post record with status='processing'                          │
│  ├── 4. Publish to RabbitMQ 'image-processing' queue                         │
│  └── 5. Return 202 Accepted: { postId, status: 'processing' }                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Queue Job Payload:                                                          │
│  ├── postId: string                                                          │
│  ├── userId: string                                                          │
│  ├── originalKey: string (MinIO path)                                        │
│  └── traceId: string (for debugging)                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Image Processing Worker

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Image Worker                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  Consumes from: 'image-processing' queue                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Resolutions Generated:                                                      │
│  ├── thumbnail: 150×150  (quality: 80)  → story rings, notifications         │
│  ├── small:     320×320  (quality: 85)  → grid view                          │
│  ├── medium:    640×640  (quality: 85)  → feed on mobile                     │
│  └── large:     1080×1080 (quality: 90) → full-screen view                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Processing Steps:                                                           │
│  ├── 1. Fetch original from MinIO                                            │
│  ├── 2. Normalize with Sharp: auto-orient (EXIF), strip metadata             │
│  ├── 3. For each resolution:                                                 │
│  │      ├── Resize with cover + center                                       │
│  │      ├── Convert to WebP                                                  │
│  │      └── Upload to MinIO: processed/{size}/{postId}.webp                  │
│  ├── 4. Update post: status='published', set all URL columns                 │
│  └── 5. Notify client via WebSocket 'post_ready'                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  Error Handling:                                                             │
│  ├── Mark post status='failed' on error                                      │
│  └── Re-throw for queue retry/DLQ handling                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 5: Feed Generation - Backend Cache to Frontend Virtualization

### Backend: Feed Service

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GET /api/v1/feed                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Query Parameters:                                                           │
│  ├── cursor: string (optional) - timestamp for pagination                    │
│  └── limit: number (default 20, max 50)                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Cache Strategy:                                                             │
│  ├── Key: feed:{userId}:{cursor|'initial'}:{limit}                           │
│  ├── TTL: 60 seconds                                                         │
│  └── Check cache first, return with fromCache: true if hit                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Circuit Breaker: feedBreaker                                                │
│  ├── Name: 'feed_generation'                                                 │
│  ├── Timeout: 5000ms                                                         │
│  └── Fallback: { posts: [], fromFallback: true }                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  Feed Query (Pull Model):                                                    │
│  ├── SELECT from posts p                                                     │
│  ├── JOIN follows f ON f.following_id = p.user_id                            │
│  ├── JOIN users u ON u.id = p.user_id                                        │
│  ├── WHERE f.follower_id = userId AND p.status = 'published'                 │
│  ├── Subqueries for: has_active_story, is_liked, is_saved                    │
│  └── ORDER BY p.created_at DESC LIMIT limit                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  Response:                                                                   │
│  ├── posts: Post[] (mapped with author info)                                 │
│  ├── nextCursor: timestamp of last post (or null)                            │
│  └── hasMore: posts.length === limit                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: feedStore (Zustand)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         feedStore State                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  posts: Post[]           │  cursor: string | null    │  hasMore: boolean    │
│  isLoading: boolean      │  error: string | null     │                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Actions:                                                                    │
│  ├── loadFeed() - Initial load, replaces posts                               │
│  ├── loadMore() - Append with cursor, guards against concurrent calls        │
│  ├── addPost(post) - Prepend new post (optimistic)                           │
│  ├── updatePost(id, updates) - Patch existing post                           │
│  ├── toggleLike(postId) - Optimistic with rollback                           │
│  └── refreshFeed() - Clear and reload                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Optimistic Like Flow:                                                       │
│  ├── 1. Toggle isLiked, adjust likeCount                                     │
│  ├── 2. Call api.likePost or api.unlikePost                                  │
│  └── 3. On error: reverse the toggle                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Virtualized Feed Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HomePage (routes/index.tsx)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  useVirtualizer Configuration:                                               │
│  ├── count: posts.length                                                     │
│  ├── getScrollElement: containerRef                                          │
│  ├── estimateSize: 600px                                                     │
│  ├── overscan: 3 items above/below viewport                                  │
│  └── measureElement: dynamic height via getBoundingClientRect               │
├─────────────────────────────────────────────────────────────────────────────┤
│  Effects:                                                                    │
│  ├── Initial load: useEffect → loadFeed()                                    │
│  └── Visibility refresh: document.visibilitychange → loadFeed on visible     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Infinite Scroll:                                                            │
│  ├── handleScroll monitors scrollHeight - scrollTop - clientHeight           │
│  └── Trigger loadMore when < 1000px from bottom                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Render Structure:                                                           │
│  ├── <StoryTray /> (not virtualized, always visible)                         │
│  ├── <div style={{ height: virtualizer.getTotalSize() }}>                    │
│  │      {virtualItems.map → <PostCard /> with absolute positioning}          │
│  └── </div>                                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 6: Story View Tracking - Real-Time Updates

### Backend: Story Routes

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GET /api/v1/stories/feed                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  Query: SELECT DISTINCT ON (u.id) from follows + users + stories             │
│  ├── Join stories WHERE expires_at > NOW()                                   │
│  ├── Subquery: has_viewed = EXISTS(story_views for current user)             │
│  └── Group by user, collect all stories                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Response Ordering:                                                          │
│  ├── Unseen stories first (hasSeen = false)                                  │
│  └── Then by latestStoryTime DESC                                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         POST /api/v1/stories/:id/view                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Deduplication (Redis):                                                      │
│  ├── SISMEMBER story_views:{storyId} → viewerId                              │
│  ├── If already viewed: return { recorded: false }                           │
│  └── Otherwise: SADD + INCR story_view_count:{storyId}                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  Persistence (PostgreSQL):                                                   │
│  └── INSERT INTO story_views ON CONFLICT DO NOTHING                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  Real-Time Notification:                                                     │
│  ├── Get story owner ID                                                      │
│  ├── Get viewer info (username, avatar)                                      │
│  └── wsHub.sendToUser(ownerId, { type: 'story_view', payload })              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: storyStore (Zustand)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         storyStore State                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  storyUsers: StoryUser[] │  isOpen: boolean          │                      │
│  currentUserIndex: number│  currentStoryIndex: number│                      │
│  newViewers: Map<storyId, ViewerInfo[]>              │                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Actions:                                                                    │
│  ├── loadStories() - Fetch from /stories/feed                                │
│  ├── openViewer(userIndex) - Set isOpen, reset storyIndex, mark seen         │
│  ├── closeViewer() - Set isOpen = false                                      │
│  ├── nextStory() / prevStory() - Navigate within user                        │
│  ├── nextUser() / prevUser() - Navigate between users                        │
│  ├── markAsSeen(storyId) - Optimistic update + api.viewStory                 │
│  └── subscribeToViews() - WebSocket 'story_view' → update newViewers         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 7: WebSocket Architecture

### Backend: WebSocket Hub

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WebSocketHub Class                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Data Structures:                                                            │
│  ├── connections: Map<userId, Connection[]>                                  │
│  └── Connection: { ws, userId, lastPing }                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  initialize(server):                                                         │
│  ├── Create WebSocketServer with path: '/ws'                                 │
│  ├── On 'connection':                                                        │
│  │      ├── Extract userId from session cookie                               │
│  │      ├── Reject if not authenticated                                      │
│  │      ├── Add to connections map                                           │
│  │      ├── Handle 'message', 'close', 'pong' events                         │
│  ├── Heartbeat interval (15s):                                               │
│  │      ├── Terminate connections with lastPing > 30s                        │
│  │      └── Send ping to all connections                                     │
│  └── Subscribe to Redis pub/sub for cross-server messaging                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  sendToUser(userId, message):                                                │
│  └── Publish to Redis channel: user:{userId}:ws                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Redis Subscriber:                                                           │
│  ├── PSUBSCRIBE user:*:ws                                                    │
│  └── On pmessage: extract userId, send to local connections                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  handleTyping(userId, message):                                              │
│  ├── Get conversation participants                                           │
│  └── Notify other participants via sendToUser                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: WebSocket Client

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WebSocketClient Class                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  State:                                                                      │
│  ├── ws: WebSocket | null                                                    │
│  ├── handlers: Map<messageType, Set<handler>>                                │
│  ├── reconnectAttempts: number (max 5)                                       │
│  └── reconnectDelay: number (base 1000ms)                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  connect():                                                                  │
│  ├── Build URL: wss://host/ws or ws://host/ws                                │
│  ├── onopen: reset reconnectAttempts                                         │
│  ├── onmessage: parse JSON, dispatch to handlers                             │
│  ├── onclose: trigger reconnect                                              │
│  └── onerror: log error                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  reconnect():                                                                │
│  ├── Check max attempts                                                      │
│  ├── Exponential backoff: delay * 2^(attempts-1)                             │
│  └── setTimeout → connect()                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  subscribe(type, handler) → unsubscribe function                             │
│  send(message) → ws.send if OPEN                                             │
│  disconnect() → close and nullify                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

The `useWebSocket` hook wraps the client: connects on mount, tracks subscriptions for cleanup, and exposes `subscribe(type, handler)` and `send(message)`.

---

## Step 8: Direct Messaging - Full Stack

### Backend: DM Routes with Cassandra

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GET /api/v1/messages/conversations                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Cassandra Query: SELECT * FROM conversations_by_user WHERE user_id = ?      │
│  Response: conversations[] with otherUser info, lastMessage, unreadCount    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         GET /api/v1/messages/conversations/:id/messages      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Cassandra Query: SELECT * FROM messages_by_conversation                     │
│  ├── WHERE conversation_id = ? AND message_id < cursor (if provided)         │
│  └── LIMIT 50                                                                │
│  Response: { messages[], nextCursor }                                        │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         POST /api/v1/messages/conversations/:id/messages     │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Generate TimeUUID for natural ordering                                   │
│  2. Insert into messages_by_conversation                                     │
│  3. Get participants and sender info                                         │
│  4. Update conversations_by_user for all participants:                       │
│     ├── Set last_message_at, last_message_preview                            │
│     └── Set unread_count = 1 for recipients, 0 for sender                    │
│  5. Notify recipients via WebSocket 'new_message'                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why Cassandra for Messages?

Messages are write-heavy (100:1 write:read ratio). Cassandra's partition-per-conversation model provides natural horizontal scaling, TimeUUID clustering keys give free time ordering, and built-in TTL handles ephemeral content. PostgreSQL would require ACID overhead per write and manual cleanup jobs.

### Frontend: messageStore (Zustand)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         messageStore State                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  conversations: Conversation[]                                               │
│  currentConversation: string | null                                          │
│  messages: Map<conversationId, Message[]>                                    │
│  isTyping: Map<conversationId, boolean>                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Actions:                                                                    │
│  ├── loadConversations()                                                     │
│  ├── loadMessages(conversationId)                                            │
│  ├── sendMessage(conversationId, content):                                   │
│  │      ├── Create optimistic message with temp-{timestamp} id               │
│  │      ├── Append to messages map                                           │
│  │      ├── Call API, replace temp with real message on success              │
│  │      └── Remove temp message on failure                                   │
│  ├── setTyping(conversationId, isTyping) → send via WebSocket                │
│  └── subscribeToMessages():                                                  │
│         ├── 'new_message' → append to messages, update conversation          │
│         └── 'typing' → set isTyping true, clear after 3 seconds              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 9: Cache Invalidation & Optimistic Updates

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Cache Invalidation Events                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  onFollowChange(followerId):                                                 │
│  └── Delete all keys matching feed:{followerId}:*                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  onPostCreated(authorId):                                                    │
│  ├── Get all follower IDs                                                    │
│  └── Pipeline delete feed:{followerId}:initial:20 for each                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  onPostLiked(postId, newLikeCount):                                          │
│  ├── Get cached post                                                         │
│  ├── Update likeCount in cached object                                       │
│  └── Re-set with same TTL                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Optimistic Update Pattern

All interactive actions (likes, follows, message sends) use the same pattern: apply the UI change immediately, fire the API call, and rollback on error. This is already shown in `feedStore.toggleLike` and `messageStore.sendMessage` above.

---

## Closing Summary

"I've designed Instagram as a full-stack system covering end-to-end photo upload (async processing via RabbitMQ, WebSocket notification), feed generation (cached pull model with frontend virtualization), real-time story views (Redis deduplication, WebSocket push), and DM architecture (Cassandra for messages, Redis pub/sub for cross-server delivery).

The key full-stack insight: consistency between optimistic frontend updates and eventual backend state requires shared type contracts, proper error rollback, and real-time WebSocket synchronization."

---

## Potential Follow-up Questions

- **Slow connection uploads?** - Chunked upload with resume, client-side compression, progressive JPEG
- **Type safety across stack?** - Shared types package (npm workspace), OpenAPI spec generation, Zod validation
- **Dual database migrations?** - Standard tools for PostgreSQL; Cassandra requires additive-only schema changes with feature flags

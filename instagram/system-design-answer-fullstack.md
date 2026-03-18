# Instagram - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement

"Today I'll design Instagram, a photo and video sharing social platform. As a full-stack engineer, I'll focus on the end-to-end photo upload flow from client to storage, the integrated feed generation system connecting backend caching with frontend virtualization, story view tracking with real-time updates, and the WebSocket-based direct messaging architecture spanning both client and server."

---

## 📋 Step 1: Requirements Clarification (3-5 minutes)

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

- "How do we communicate processing status to the client?" - Polling with status endpoint, optionally WebSocket for instant updates
- "How do we keep feed fresh across tabs?" - Visibility API to trigger refresh on tab focus
- "What consistency model for likes?" - Optimistic UI with eventual sync

---

## 🏗️ Step 2: System Architecture Overview

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

## 📐 Step 3: Shared Type Contracts

"Shared types between frontend and backend are critical for a full-stack system. The four core domain types are **User**, **Post**, **Story**, and **Message**."

| Type | Key Fields | Notes |
|------|-----------|-------|
| **User** | id, username, displayName, avatarUrl, follower/following/postCount, isPrivate | UserPreview subset used in feeds |
| **Post** | id, userId, author, caption, status (processing/published/failed), image URLs (4 sizes), likeCount, isLiked | Status tracks async processing |
| **Story** | id, userId, mediaUrl, mediaType (image/video), viewCount, expiresAt | 24-hour TTL |
| **Message** | id, conversationId, senderId, content, contentType (text/image/video/heart) | TimeUUID ordering in Cassandra |

All list endpoints return cursor-based pagination: `{ items[], nextCursor, hasMore }`.

**WebSocket message types** provide real-time updates across features: `new_message`, `typing`, `read_receipt`, `story_view`, and `post_ready` — each carrying a typed payload that both client and server validate.

---

## 📸 Step 4: End-to-End Photo Upload Flow

### End-to-End Upload Flow

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Client     │─────▶│  API Server  │─────▶│  RabbitMQ    │─────▶│ Image Worker │
│  CreatePost  │      │ POST /posts  │      │  Queue       │      │  (Sharp)     │
└──────┬───────┘      └──────┬───────┘      └──────────────┘      └──────┬───────┘
       │                     │                                           │
  Local preview         Store original                            Generate 4 sizes
  + progress bar        in MinIO, insert                          (150/320/640/1080)
  + optimistic post     with status=                              Convert to WebP
                        'processing'                              Store in MinIO
       │                     │                                           │
       │◀────────── Return 202 Accepted ──────────────────────────────────
       │                                                                 │
       │◀──────────── WebSocket 'post_ready' ────────────────────────────┘
       │              (polling fallback: 1s × 30)
  Replace preview
  with real URLs
```

**Frontend (CreatePost)**: User selects file, FileReader creates local DataURL preview immediately. On submit, FormData uploads with progress callback. An optimistic post appears in the feed instantly. The component subscribes to WebSocket `post_ready` and polls as fallback.

**Backend (POST /api/v1/posts)**: Behind requireAuth + multer (10MB limit). Generates UUID, stores original in MinIO, inserts post with `status='processing'`, publishes job to RabbitMQ, returns 202 Accepted.

**Image Worker**: Consumes from queue, fetches original, normalizes with Sharp (auto-orient, strip EXIF), generates 4 resolutions as WebP, uploads to MinIO, updates post to `status='published'`, notifies via WebSocket. On error: marks `status='failed'`, re-throws for DLQ.

---

## 📰 Step 5: Feed Generation - Backend Cache to Frontend Virtualization

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

### Frontend: Feed Store + Virtualized Rendering

**feedStore (Zustand)** manages posts, cursor, hasMore, and loading state. Key actions: `loadFeed()` (initial), `loadMore()` (cursor-based append with concurrency guard), `toggleLike()` (optimistic with rollback on API error), and `addPost()` (prepend optimistic uploads).

**Virtualized feed (HomePage)** uses `@tanstack/react-virtual` with `estimateSize: 600px`, `overscan: 3`, and dynamic measurement via `getBoundingClientRect`. Infinite scroll triggers `loadMore` when within 1000px of bottom. Visibility API refreshes feed on tab focus. Render structure: fixed `<StoryTray />` above a virtualized container where each `<PostCard />` is absolutely positioned.

---

## 📖 Step 6: Story View Tracking - Real-Time Updates

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

**Frontend storyStore (Zustand)** tracks storyUsers, viewer open/close state, current user/story indexes, and a newViewers map. Navigation actions (next/prev story and user) drive the viewer. `markAsSeen()` fires an optimistic update with `api.viewStory`. `subscribeToViews()` listens for WebSocket `story_view` events to show real-time viewer notifications to story owners.

---

## 🔌 Step 7: WebSocket Architecture

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

### Frontend: WebSocket Client + Hook

**WebSocketClient** manages connection state, a handler map (`Map<messageType, Set<handler>>`), and reconnection with exponential backoff (max 5 attempts, base 1000ms). On message receipt, it parses JSON and dispatches to registered handlers. The `subscribe(type, handler)` method returns an unsubscribe function.

**useWebSocket hook** wraps the client lifecycle: connects on mount, tracks subscriptions, and unsubscribes all on cleanup. Returns `subscribe()` and `send()` for use in components and stores.

---

## 💬 Step 8: Direct Messaging - Full Stack

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

| Aspect | PostgreSQL | Cassandra |
|--------|------------|-----------|
| Write Pattern | ACID overhead | Optimized for high writes |
| Read Pattern | Complex joins | Partition-per-conversation |
| Ordering | ORDER BY + index | TimeUUID clustering key |
| Scaling | Vertical | Horizontal (partition by conversation) |
| TTL | Manual cleanup | Built-in for ephemeral content |

**Frontend messageStore (Zustand)** holds conversations list, per-conversation message maps, and typing indicators. `sendMessage` creates an optimistic message with `temp-{timestamp}` ID, appends it, calls the API, then replaces with the real message on success (or removes on failure). `subscribeToMessages` listens for WebSocket `new_message` (append + update conversation) and `typing` (set flag, auto-clear after 3s).

---

## 🔄 Step 9: Cache Invalidation & Optimistic Updates

**Backend cache invalidation** is event-driven: `onFollowChange` deletes all `feed:{followerId}:*` keys, `onPostCreated` pipeline-deletes initial feed caches for all followers, and `onPostLiked` does a targeted update of the likeCount within the cached post object (preserving TTL).

**Frontend optimistic updates** follow a consistent pattern: apply the UI change immediately via `optimisticFn`, fire the API call, and call `rollbackFn` on error. This is used for likes (toggle + count adjust, reverse on failure), follows (immediate UI toggle), and message sends (temp ID replaced with real ID on success).

---

## 🔧 Deep Dive 1: Pull vs Push Feed Generation

"The feed strategy is the highest-impact architectural decision for Instagram. I chose a pull model, and here's the full reasoning."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Pull (fan-out on read) | Simple implementation, no write amplification, always fresh | Higher read latency, heavier DB load per request |
| ❌ Push (fan-out on write) | O(1) reads, pre-materialized feed | Celebrity problem: 100M followers = 100M writes per post |
| ❌ Hybrid | Best latency for all users | Significant complexity, two code paths to maintain |

> "We chose pull because it avoids the celebrity write amplification problem entirely. When a user with 50M followers posts, a push model must write 50M feed entries — that's a multi-second fanout job that delays the post appearing even to the poster. With pull, every user's feed query costs the same: one JOIN across follows and posts, cached for 60 seconds. The trade-off is read latency — a cache miss requires a multi-table JOIN. We mitigate this with a composite index on `(user_id, created_at DESC)` and a circuit breaker that returns an empty feed within 5 seconds rather than letting slow queries cascade. At true Instagram scale (500M DAU), we'd evolve to a hybrid model: pull for users following celebrities (>10K followers), push for normal users. But for the initial design, pull gives us 80% of the value with 20% of the complexity."

---

## 🔧 Deep Dive 2: Synchronous Upload vs Async Processing Pipeline

"The photo upload flow demonstrates a key full-stack trade-off: should the API return after processing is complete, or immediately?"

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Async (202 + queue + worker) | Fast acknowledgment (<500ms), scalable workers, retry/DLQ | Client must poll or use WebSocket for completion |
| ❌ Synchronous (process inline) | Simpler client logic, single request | 3-8 second response time, blocks API thread, no retry |
| ❌ Client-side resize | Reduces upload size | Inconsistent quality, no server control, battery drain on mobile |

> "We return 202 Accepted immediately and process asynchronously because user-perceived upload speed directly impacts posting frequency — Instagram's core engagement metric. If users wait 5 seconds watching a spinner, they post less. With async processing, the client shows the local preview immediately as an optimistic post in the feed. The backend stores the original and queues a job. The image worker generates 4 resolutions (150px to 1080px) as WebP, which typically takes 2-3 seconds per image. The client learns about completion via WebSocket `post_ready`, with a polling fallback for reliability. The trade-off is complexity: we now have two notification channels, a queue to monitor, and a DLQ for failed processing. We also need status tracking in the database (`processing` → `published` → `failed`). But this complexity lives in well-understood infrastructure (RabbitMQ, Sharp), and the alternative — a 5-second blocking API call that can't be retried if Sharp crashes mid-resize — is worse for both UX and reliability."

---

## 🔧 Deep Dive 3: Story View Deduplication — Redis + PostgreSQL

"Story views need exact-once counting per user, but also need to be fast enough that viewing a story doesn't feel laggy."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Redis SET + PostgreSQL write-behind | O(1) dedup check, durable persistence | Two storage systems to keep in sync |
| ❌ PostgreSQL only (UNIQUE constraint) | Single source of truth | INSERT ON CONFLICT adds ~5ms per view, hot rows under load |
| ❌ Redis only | Fastest | Data loss on restart, no queryable history for analytics |

> "We use Redis SISMEMBER for the hot path — checking if a viewer has already seen a story is O(1) with a SET per story. If not seen, we SADD the viewer and INCR the view count atomically. Then we persist to PostgreSQL with INSERT ON CONFLICT DO NOTHING as a write-behind. This dual-write means the view endpoint responds in <2ms for duplicates (Redis hit) and <10ms for new views. The PostgreSQL write is for durability and analytics queries — 'who viewed my story' needs a scannable table, not a Redis SET. The trade-off: if Redis crashes between SADD and the PostgreSQL write, we could lose a view record. For story views, this is acceptable — losing 0.01% of view records during a Redis failover doesn't impact the product. We wouldn't make this trade-off for financial data, but for ephemeral content that expires in 24 hours, optimizing for speed over perfect durability is the right call."

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Feed strategy | Pull model | Push / Hybrid | Avoids celebrity write amplification |
| Upload flow | Async (202 + queue) | Synchronous processing | Fast acknowledgment, scalable workers |
| Message storage | Cassandra | PostgreSQL | Write-optimized, partition-per-conversation |
| Story view dedup | Redis + PostgreSQL | PostgreSQL only | O(1) check on hot path, durable persistence |
| Real-time delivery | WebSocket | SSE / Long polling | Bidirectional, supports typing indicators |
| Frontend rendering | Virtualized list | Standard DOM | 60fps with thousands of posts |
| State management | Zustand stores | React Context | Optimistic updates with rollback |
| Auth | Session + Valkey | JWT | Immediate revocation, simpler for web |

---

## Closing Summary

"I've designed Instagram as a full-stack system with focus on:

1. **End-to-End Photo Upload** - Multipart upload with progress, async processing via RabbitMQ worker, WebSocket notification when ready, polling fallback
2. **Integrated Feed System** - Backend caching with 60s TTL, circuit breaker protection, frontend virtualization for 60fps scrolling with infinite scroll
3. **Real-Time Story Views** - Redis-backed deduplication, PostgreSQL persistence, WebSocket notification to story owner
4. **WebSocket Architecture** - Cross-server delivery via Redis pub/sub, reconnection with exponential backoff, typed message contracts

The key insight for full-stack development is maintaining consistency between optimistic frontend updates and eventual backend state - shared type contracts, proper error rollback, and real-time synchronization via WebSocket create a cohesive experience."

---

## Potential Follow-up Questions

1. **Slow connection uploads?** — Chunked upload with resume, client-side compression, progressive JPEG
2. **Type safety across stack?** — Shared types package (npm workspace), OpenAPI spec generation, Zod validation
3. **Dual-database migrations?** — Standard tools for PostgreSQL; Cassandra requires additive-only schema changes with feature flags for rollout

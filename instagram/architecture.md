# Instagram - Photo Sharing - Architecture Design

## System Overview

A photo and video sharing social platform supporting photo uploads with filters, personalized feeds, ephemeral stories, direct messaging, and social graph interactions. This document describes two layers: a production-ready architecture for hundreds of millions of users, and the pocket-size implementation that actually runs locally.

---

# Layer 1: Production-Ready Architecture

This section describes how Instagram would work at production scale -- hundreds of millions of daily active users, petabytes of media, and millions of requests per second.

## Requirements

### Functional Requirements

- **Photo/video upload**: Users upload media with captions, tags, location, and filters; media is processed into multiple resolutions and formats
- **Personalized feed**: Timeline of posts from followed users, ranked by relevance signals (recency, engagement, relationship closeness)
- **Stories**: Ephemeral 24-hour photo/video content with view tracking and auto-expiration
- **Direct messaging**: Private text and media messages between users with read receipts and typing indicators
- **Social graph**: Follow/unfollow, followers/following lists, mutual connections
- **Engagement**: Likes, comments (with threading), saves/bookmarks
- **Search**: Full-text search for users, hashtags, and locations
- **Explore**: Discovery feed based on engagement signals and content similarity
- **Notifications**: Push and in-app notifications for likes, comments, follows, DMs

### Non-Functional Requirements

- **Availability**: 99.99% uptime (52 minutes downtime/year)
- **Latency**: Feed load p99 < 200ms, photo upload acknowledgment p99 < 500ms, image serving p99 < 50ms via CDN, DM delivery p99 < 100ms
- **Scalability**: 500M+ DAU, 100M+ photo uploads/day, 1B+ feed requests/day
- **Consistency**: Eventual consistency for feeds (2-5s delay acceptable), strong consistency for follows and message delivery order
- **Durability**: Zero data loss for user-generated content, 99.999999999% (11 nines) object storage durability

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| Daily Active Users (DAU) | 500M | Global user base |
| Posts per day | 100M | ~20% of DAU post daily |
| Stories per day | 500M | Stories are more frequent than posts |
| Average post size (original) | 3 MB | High-resolution photos |
| Average post size (processed, all sizes) | 1.5 MB | Thumbnail + 4 resolutions + WebP |
| Feed requests/day | 5B | ~10 feed loads per user |
| Peak QPS (feed) | 150K | 5B/day with 3x peak factor, 86400s |
| Peak QPS (upload) | 5K | 100M/day concentrated in active hours |
| DM messages/day | 10B | Average 20 messages per active user |
| Peak QPS (DM) | 300K | 10B/day with 2.5x peak factor |

### Storage Growth

| Component | Daily Growth | Annual Growth |
|-----------|-------------|---------------|
| Original media | 300 TB | 110 PB |
| Processed media | 150 TB | 55 PB |
| Database (metadata) | 5 TB | 1.8 PB |
| Message storage (Cassandra) | 10 TB | 3.6 PB |
| CDN cache | 50 TB (hot set) | N/A (eviction-based) |

### Bandwidth

| Direction | Peak | Calculation |
|-----------|------|-------------|
| Ingress (uploads) | 15 Gbps | 5K uploads/s x 3 MB |
| Egress (feed + images) | 2 Tbps | 150K feed req/s x ~2 MB media per load |
| CDN offload | ~90% | CDN serves cached media, origin handles 10% |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                    Clients                                           │
│                    (iOS / Android / Web / Progressive Web App)                        │
└─────────────────────────────────┬────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │          CDN              │
                    │  (CloudFront / Cloudflare) │
                    │  Static assets + media     │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │       API Gateway          │
                    │   (Rate limiting, auth,     │
                    │    routing, SSL termination)│
                    └─────────────┬─────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
┌─────────▼─────────┐  ┌─────────▼─────────┐  ┌─────────▼─────────┐
│   Load Balancer   │  │   Load Balancer   │  │   Load Balancer   │
│   (Feed + Social) │  │   (Media + Story) │  │   (DM + Notif)    │
└─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
          │                       │                       │
┌─────────▼─────────┐  ┌─────────▼─────────┐  ┌─────────▼─────────┐
│                   │  │                   │  │                   │
│   Feed Service    │  │   Media Service   │  │    DM Service     │
│   Social Service  │  │   Story Service   │  │  Notification Svc │
│   Search Service  │  │   Processing Svc  │  │  Presence Service │
│                   │  │                   │  │                   │
└────────┬──────────┘  └────────┬──────────┘  └────────┬──────────┘
         │                      │                       │
         │         ┌────────────┼────────────┐          │
         │         │            │            │          │
┌────────▼────┐ ┌──▼──────┐ ┌──▼──────┐ ┌───▼────┐ ┌──▼─────────┐
│ PostgreSQL  │ │  Redis  │ │  S3 /   │ │ Kafka  │ │ Cassandra  │
│  Cluster    │ │ Cluster │ │ Object  │ │Cluster │ │  Cluster   │
│ (sharded)   │ │ (feed,  │ │ Storage │ │(events)│ │  (DMs)     │
│             │ │ session,│ │         │ │        │ │            │
│             │ │ cache)  │ │         │ │        │ │            │
└─────────────┘ └─────────┘ └─────────┘ └────────┘ └────────────┘
```

## Service Decomposition

### Feed Service

Responsible for generating and serving personalized feeds. Uses a hybrid push/pull model:

- **Fan-out on write** for users with < 10K followers: When a user posts, the post ID is pushed to each follower's precomputed timeline in Redis. This gives instant feed reads for the majority of users.
- **Fan-out on read** for celebrities (> 10K followers): Celebrity posts are not fanned out. Instead, when a follower loads their feed, the system merges their precomputed timeline with recent posts from celebrities they follow. This avoids writing to millions of timelines on a single post.

Feed ranking applies lightweight ML scoring: `score = w1 * recency + w2 * engagement_prediction + w3 * relationship_closeness`. The ranker runs at read time on the merged candidate set.

### Media Service

Handles upload, processing, and serving of photos and videos:

1. **Upload flow**: Client uploads to a pre-signed S3 URL (bypassing the API for large files). The API server receives the metadata and enqueues a processing job.
2. **Processing pipeline**: A fleet of GPU/CPU workers consumes from the processing queue:
   - Validate format (JPEG, PNG, WebP, HEIC, AVIF)
   - Strip EXIF data for privacy
   - Auto-orient based on EXIF rotation
   - Generate 5 sizes: thumbnail (150x150), small (320x320), medium (640x640), large (1080x1080), original-aspect (2048 max dimension)
   - Convert to WebP and AVIF for 30-50% size savings with JPEG fallback
   - Apply server-side filter effects when requested
3. **Serving**: All processed media is served through CDN with cache headers (`Cache-Control: public, max-age=31536000, immutable`). Content-addressed keys ensure cache correctness.

### Story Service

Manages ephemeral 24-hour content:

- Stories have `expires_at = created_at + 24h` and are filtered at query time
- Story tray (the ring of user avatars at the top) is cached per user with unseen stories sorted first
- View tracking uses `INSERT ... ON CONFLICT DO NOTHING` for deduplication
- A background cron job runs every 15 minutes to hard-delete expired stories and their media from S3
- Story media uses the same processing pipeline as posts but with fewer sizes (medium + thumbnail only)

### DM Service

Real-time messaging service using WebSocket connections:

- Persistent WebSocket connections (via Socket.io or custom WS layer) for message delivery, typing indicators, and read receipts
- Messages stored in Cassandra, partitioned by `conversation_id` with `TimeUUID` clustering keys for natural time ordering
- Cassandra's high write throughput handles the 300K+ QPS for DM writes
- Typing indicators use Cassandra TTL (5 seconds) -- no explicit cleanup needed
- Read receipts update a per-user-per-conversation counter
- Fallback to HTTP polling when WebSocket connections drop

### Notification Service

Delivers push and in-app notifications:

- Consumes events from Kafka (new_like, new_comment, new_follow, new_dm)
- Deduplicates notifications (e.g., "alice and 5 others liked your post" instead of 6 separate notifications)
- Routes to APNs (iOS), FCM (Android), and WebSocket (web) based on user device registration
- Supports notification preferences (mute, DND schedules)
- In-app notification feed stored in Redis sorted sets with 30-day retention

### Search Service

Full-text search powered by Elasticsearch:

- User search by username, display name (fuzzy matching, prefix completion)
- Hashtag search with trending aggregation
- Location search with geo-queries
- Index updates propagated via Kafka CDC (Change Data Capture) from PostgreSQL
- Autocomplete uses edge-ngram tokenizers for sub-100ms response times

## Database Design at Scale

### PostgreSQL (Relational Metadata)

PostgreSQL handles ACID-critical data: users, posts, follows, likes, comments, stories.

**Sharding strategy**: Hash-based sharding by `user_id` across 256 logical shards mapped to physical database clusters. This ensures all data for a single user is co-located (posts, likes, follows where the user is the actor).

**Read replicas**: Each shard has 2-3 read replicas. Feed generation queries hit replicas; writes go to the primary. Replication lag is monitored and queries requiring strong consistency are routed to the primary.

**Key tables**:

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    bio TEXT,
    profile_picture_url VARCHAR(500),
    is_private BOOLEAN DEFAULT FALSE,
    follower_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    post_count INTEGER DEFAULT 0,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Posts table
CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    caption TEXT,
    location VARCHAR(255),
    status VARCHAR(20) DEFAULT 'processing'
        CHECK (status IN ('processing', 'published', 'failed')),
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_posts_user_created ON posts(user_id, created_at DESC);

-- Post media (carousel support)
CREATE TABLE post_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
    media_url VARCHAR(500),
    thumbnail_url VARCHAR(500),
    original_key VARCHAR(500),
    filter_applied VARCHAR(50),
    width INTEGER,
    height INTEGER,
    order_index INTEGER DEFAULT 0,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Social graph
CREATE TABLE follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(follower_id, following_id),
    CHECK (follower_id != following_id)
);
CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_following ON follows(following_id);

-- Likes with idempotency via UNIQUE constraint
CREATE TABLE likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, post_id)
);

-- Comments with threading
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_comments_post ON comments(post_id, created_at);

-- Stories (ephemeral, 24-hour)
CREATE TABLE stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_url VARCHAR(500) NOT NULL,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
    thumbnail_url VARCHAR(500),
    view_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);
CREATE INDEX idx_stories_user_expires ON stories(user_id, expires_at DESC);

-- Story views (deduplicated)
CREATE TABLE story_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(story_id, viewer_id)
);

-- Saved posts (bookmarks)
CREATE TABLE saved_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, post_id)
);
```

**Database triggers** maintain denormalized counts (follower_count, like_count, comment_count, post_count, story view_count) for efficient reads without expensive COUNT queries.

### Cassandra (Direct Messages)

Cassandra handles the write-heavy DM workload. Messages are partitioned by `conversation_id` with `TimeUUID` clustering keys for natural time ordering.

**Keyspace**: `instagram_dm` with `NetworkTopologyStrategy`, replication factor 3 across data centers.

```cql
-- Messages by conversation
CREATE TABLE messages_by_conversation (
    conversation_id UUID,
    message_id TIMEUUID,
    sender_id UUID,
    content TEXT,
    content_type TEXT,       -- 'text', 'image', 'video', 'heart', 'story_reply'
    media_url TEXT,
    reply_to_message_id TIMEUUID,
    created_at TIMESTAMP,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND default_time_to_live = 31536000;  -- 1 year TTL

-- Conversations by user (inbox)
CREATE TABLE conversations_by_user (
    user_id UUID,
    last_message_at TIMESTAMP,
    conversation_id UUID,
    other_user_id UUID,
    other_username TEXT,           -- Denormalized for fast display
    other_profile_picture TEXT,
    last_message_preview TEXT,
    last_message_sender_id UUID,
    unread_count INT,
    is_muted BOOLEAN,
    PRIMARY KEY (user_id, last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (last_message_at DESC);

-- Typing indicators (5-second TTL, no cleanup needed)
CREATE TABLE typing_indicators (
    conversation_id UUID,
    user_id UUID,
    started_at TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
) WITH default_time_to_live = 5;

-- Message reactions
CREATE TABLE message_reactions (
    conversation_id UUID,
    message_id TIMEUUID,
    user_id UUID,
    reaction TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY ((conversation_id, message_id), user_id)
);

-- Read receipts
CREATE TABLE message_read_receipts (
    conversation_id UUID,
    user_id UUID,
    last_read_message_id TIMEUUID,
    last_read_at TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);
```

**Why Cassandra for DMs?**
- Write-heavy workload (100:1 write-to-read ratio) maps perfectly to Cassandra's log-structured merge trees
- TimeUUID clustering provides natural chronological ordering without secondary indexes
- Partition-per-conversation enables linear horizontal scaling -- each conversation is independent
- Built-in TTL for typing indicators (5s) and message retention (1 year) with zero application logic
- Denormalized `conversations_by_user` renders the inbox in a single partition read, avoiding cross-partition joins

**Trade-off**: User info (username, profile_picture) is denormalized into `conversations_by_user`. On profile update, a background job propagates changes to all active conversations. This costs write amplification but avoids the latency of joining across databases at read time. The 2-5 second propagation lag is acceptable for display names.

### Elasticsearch (Search)

Indexes user profiles, hashtags, and locations for fast search and autocomplete. Updated via Kafka CDC from PostgreSQL with sub-second lag.

## Caching Layers

### CDN (Media Delivery)

All processed media is served through CDN (CloudFront/Cloudflare):

- Content-addressed object keys (`images/{hash}/{size}.webp`) make cache invalidation unnecessary
- `Cache-Control: public, max-age=31536000, immutable` for infinite caching
- CDN offloads ~90% of media bandwidth from origin
- Geographic edge nodes reduce latency to < 50ms globally
- WebP/AVIF content negotiation based on `Accept` header

### Redis Cluster (Application Cache)

| Key Pattern | Value | TTL | Purpose |
|-------------|-------|-----|---------|
| `session:{session_id}` | User session JSON | 7d | Authentication |
| `timeline:{user_id}` | Sorted set of post IDs | None (managed) | Precomputed feed |
| `feed:{user_id}:{cursor}` | Assembled feed JSON | 60s | Feed response cache |
| `user:{user_id}` | User profile JSON | 5m | Profile lookups |
| `story_tray:{user_id}` | Story ring data | 5m | Story feed |
| `ratelimit:{prefix}:{id}` | Counter | Varies | Rate limiting |
| `notifications:{user_id}` | Sorted set of notification IDs | 30d | In-app notifications |

**Cache invalidation**: Write-through for critical data (follows trigger `feed:{user_id}` deletion). Time-based expiry for non-critical caches. Redis Pub/Sub propagates invalidation across cache nodes.

**Timeline cache**: Redis sorted sets store the last 500 post IDs per user. On post creation, the image processing worker fans out the post ID to all followers' timelines. Feed reads merge the cached timeline with celebrity posts fetched on demand.

## Media Pipeline

```
┌──────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────────┐    ┌─────┐
│  Client  │───▶│ Pre-signed   │───▶│  S3 / Object  │───▶│  Processing  │───▶│ CDN │
│ (upload) │    │ Upload URL   │    │   Storage     │    │   Workers    │    │     │
└──────────┘    └──────────────┘    └───────────────┘    └──────────────┘    └─────┘
                                           │                    │
                                    ┌──────▼──────┐     ┌──────▼──────┐
                                    │  Original   │     │  Processed  │
                                    │  (archive)  │     │  (5 sizes)  │
                                    └─────────────┘     └─────────────┘
```

1. Client requests a pre-signed S3 URL from the API
2. Client uploads directly to S3 (bypasses API servers for large files)
3. API server creates a post record with `status: 'processing'` and enqueues a processing job
4. Processing worker fetches the original from S3, generates 5 sizes in WebP + JPEG, uploads processed versions
5. Worker updates the post to `status: 'published'` and fans out to follower timelines
6. CDN serves processed images on first access, caches at edge for subsequent requests

**Resolutions generated**:

| Size | Dimensions | Use Case |
|------|-----------|----------|
| Thumbnail | 150x150 | Story rings, notifications, grid |
| Small | 320x320 | Mobile grid view |
| Medium | 640x640 | Mobile feed |
| Large | 1080x1080 | Full-screen mobile, desktop feed |
| XLarge | 2048 (max dim) | Desktop full-screen, zoom |

## Feed Generation: Hybrid Push/Pull

```
┌──────────────────────────────────────────────────────────────┐
│                   Post Published Event                       │
└─────────────────────────┬────────────────────────────────────┘
                          │
              ┌───────────▼───────────┐
              │ Follower count > 10K? │
              └───────┬───────┬───────┘
                      │       │
                No    │       │  Yes
                      │       │
         ┌────────────▼──┐  ┌─▼──────────────┐
         │ Fan-out Write │  │ Celebrity table │
         │ Push post ID  │  │ (fetched at     │
         │ to each       │  │  read time)     │
         │ follower's    │  │                 │
         │ Redis timeline│  │                 │
         └───────────────┘  └─────────────────┘

                    Feed Read Request
                          │
              ┌───────────▼───────────┐
              │  1. Get timeline from │
              │     Redis sorted set  │
              │  2. Fetch celebrity   │
              │     posts on demand   │
              │  3. Merge + rank      │
              │  4. Hydrate with      │
              │     post metadata     │
              └───────────────────────┘
```

**Why hybrid?** Pure push would mean a celebrity with 100M followers triggers 100M Redis writes per post, taking minutes and wasting storage for inactive users. Pure pull means every feed load queries all followed users' posts, creating hot partitions. The hybrid approach handles 99% of users with O(1) feed reads (push) while bounding the worst case for celebrities to O(celebrity_count) per read.

## Real-Time Communication

- **WebSocket** connections for DMs: persistent bidirectional channel for message delivery, typing indicators, read receipts, presence
- **Server-Sent Events (SSE)** for notifications: unidirectional push for likes, comments, follows, story views
- **Connection management**: WebSocket connections are load-balanced using sticky sessions (hashed by user ID). Each WS server maintains a local connection registry. Cross-server message delivery uses Redis Pub/Sub -- when user A sends a message to user B who is connected to a different WS server, the message is published to a Redis channel that the target server subscribes to.

## Frontend Architecture

### Component Hierarchy

The frontend is a React 19 + TypeScript SPA built with Vite, using a component tree designed around Instagram's content-centric UI:

```
__root.tsx (Navbar + <Outlet />)
├── /login, /register         → Auth forms (unprotected)
├── /create                   → Post creation with file upload + preview
├── /settings                 → Profile settings
├── / (index)                 → HomePage
│   ├── StoryTray             → Horizontal scrollable story rings
│   │   └── StoryViewer       → Full-screen modal with progress bars, auto-advance
│   └── Virtualized Feed      → @tanstack/react-virtual
│       └── PostCard          → Media carousel + like/comment/save/share actions
│           └── Avatar        → Reusable avatar with story ring indicator
├── /profile/$username        → Profile page
│   └── PostGrid              → Grid layout of post thumbnails
├── /post/$postId             → Single post detail with comments
└── /explore                  → Discovery grid
```

The root layout (`__root.tsx`) renders `Navbar` at the top and an `<Outlet />` for the active route. The Navbar contains the Instagram logo, navigation links (home, explore, create, profile), and search. This layout is applied to every page.

### State Management (Zustand)

The project uses a single Zustand store with the `persist` middleware:

**`useAuthStore`** -- Manages authentication state (user object, isLoading, isAuthenticated). Uses Zustand's `persist` middleware to save `user` and `isAuthenticated` to localStorage under `auth-storage`, so the user remains logged in across page refreshes. The `partialize` option ensures only serializable state is persisted (not functions or loading flags).

**Why Zustand over Redux**: Zustand requires no providers, no reducers, no action types. A store is a single `create()` call with state and actions in one object. Components subscribe to exactly the slices they need via selector hooks (`useAuthStore(state => state.user)`), minimizing unnecessary re-renders. For a project with one global store (auth), Redux's boilerplate (createSlice, configureStore, Provider wrapper) is overhead without benefit.

**Why Zustand over React Context**: Context triggers re-renders for every consumer when any part of the context value changes. With auth state, a change to `isLoading` would re-render every component consuming the context, including those that only need `user`. Zustand's selector-based subscriptions avoid this entirely.

**Local component state**: Feed posts, story data, and form inputs use React `useState` because they are page-scoped and do not need to survive navigation. The feed is loaded in `HomePage` and passed to child components via props. This avoids putting ephemeral data into global state.

### Routing (TanStack Router)

File-based routing with TanStack Router and the `@tanstack/router-vite-plugin` for automatic route generation:

```
routes/
├── __root.tsx                → Root layout (Navbar + Outlet)
├── index.tsx                 → / (home feed)
├── login.tsx                 → /login
├── register.tsx              → /register
├── create.tsx                → /create (new post)
├── settings.tsx              → /settings
├── explore.tsx               → /explore
├── post.$postId.tsx          → /post/:postId (single post view)
└── profile.$username.tsx     → /profile/:username
```

**Route guards**: The home page checks `isAuthenticated` from the auth store and renders `<Navigate to="/login" />` if the user is not logged in. This is a component-level guard rather than a `beforeLoad` hook, allowing the page to show a loading spinner while the auth check completes.

**Dynamic segments**: `$postId` and `$username` are dynamic route parameters accessed via `Route.useParams()`. TanStack Router provides type-safe params -- accessing `params.postId` in the wrong route is a compile-time error.

### Data Fetching Pattern

The API layer follows a service-object pattern with a shared `request()` helper:

```
Component (e.g., HomePage)
  → calls feedApi.getFeed(cursor)
    → request<T>('/feed', options)
      → fetch('/api/v1/feed', { credentials: 'include', ... })
        → Backend Express API
```

**`services/api.ts`** exports domain-specific API objects (`authApi`, `postsApi`, `feedApi`, `storiesApi`, `usersApi`, `commentsApi`). Each method calls the shared `request<T>()` function, which handles JSON serialization, error extraction, and credentials. A separate `requestFormData<T>()` handles multipart uploads (post creation, avatar updates) without the `Content-Type: application/json` header, letting the browser set the multipart boundary.

**Session-based auth**: All requests include `credentials: 'include'` to send the session cookie. No auth tokens are managed client-side -- the session cookie is httpOnly and managed by the browser.

**Cursor-based pagination**: Feed, comments, followers, and post grids all use cursor pagination. The API returns `{ data: [...], nextCursor: string | null }`. The component stores `nextCursor` in local state and passes it on the next request. When `nextCursor` is null, no more data is available.

### Virtualization

The home feed uses `@tanstack/react-virtual` to efficiently render a potentially unbounded list of posts. Without virtualization, rendering 500 PostCard components (each containing an image, action buttons, and caption) would create 500+ DOM nodes, consuming ~50MB of memory and causing visible jank on scroll.

**How it works**: The virtualizer maintains a window of visible items based on the scroll position of the parent container. Only items within the viewport (plus an `overscan` buffer of 3 items above and below) are rendered to the DOM. As the user scrolls, items entering the viewport are mounted and items leaving are unmounted.

**Dynamic height measurement**: Instagram posts have variable heights (different image aspect ratios, caption lengths, comment counts). The virtualizer uses `estimateSize: () => 600` as an initial guess (header 60px + image 400px + actions 60px + caption 80px), then measures the actual rendered height via `measureElement` using `getBoundingClientRect().height`. This measurement is cached so subsequent scroll passes use the real height.

**Infinite scroll**: A scroll event listener checks if the user is within 500px of the bottom (`scrollHeight - scrollTop - clientHeight < 500`). When triggered, it calls `loadFeed(nextCursor)` to fetch the next page and appends results to the existing array.

### Optimistic Updates

Likes and saves use an optimistic update pattern. When the user taps the heart icon:

1. The UI immediately updates: `setIsLiked(true)` and `setLikeCount(prev => prev + 1)`
2. The API call fires in the background: `postsApi.like(postId)`
3. If the API call fails, the UI reverts: `setIsLiked(false)` and `setLikeCount(prev => prev - 1)`

This makes interactions feel instant (0ms perceived latency) instead of waiting 100-300ms for the server round trip. The user sees the heart fill immediately. If the server rejects the request (e.g., rate limit), the heart un-fills. In practice, failures are rare, so the optimistic path is correct 99%+ of the time.

The double-tap-to-like gesture on the image also triggers this flow, with an additional heart animation overlay that fades after 800ms.

### Key UI Patterns

**Story viewer**: The `StoryTray` component renders a horizontal scrollable row of story rings. Clicking a user opens a full-screen modal (`StoryViewer`) that auto-advances through stories on a 5-second timer (100ms intervals incrementing a progress bar by 2%). Tapping the left/right halves of the screen navigates backward/forward. When all stories for a user are viewed, it automatically advances to the next user. Story view tracking fires `storiesApi.view()` when each story becomes visible.

**Media carousel**: `PostCard` supports multi-image posts with left/right navigation arrows and a dot indicator. State tracks `currentMediaIndex`, and each media item checks `mediaType` to render either `<img>` or `<video>`.

**Loading skeletons**: The feed shows 3 placeholder cards with `skeleton` CSS class (pulsing gray blocks) while the initial feed loads, matching the shape of real PostCards.

**Responsive layout**: The feed uses `max-w-lg mx-auto` for a centered single-column layout (Instagram mobile web style). The profile page uses a 3-column post grid. Tailwind utility classes handle responsive breakpoints without custom media queries.

## Observability

### What Observability Solves

In a distributed system with multiple services (API, image worker, feed generator), a slow request could be caused by any component. Without observability, debugging is guesswork: "Is the database slow? Is the cache down? Is the image worker backed up?" Observability provides three pillars -- metrics (what is happening), logs (why it happened), and traces (where in the call chain it happened) -- that together turn production debugging from hours of manual investigation into minutes of dashboard inspection.

### Distributed Tracing

Every request receives a `trace_id` (propagated via `x-trace-id` header) that follows the request across services, message queues, and background workers. This enables end-to-end latency analysis: "This feed load took 450ms -- 200ms in PostgreSQL, 150ms in Redis, 100ms in service logic."

### Prometheus Metrics

Prometheus is a time-series database that scrapes a `/metrics` HTTP endpoint on each service at regular intervals (typically every 15 seconds). It stores numeric measurements over time, enabling queries like "what was the p99 latency over the last hour?" Prometheus itself does not push data -- the application exposes metrics, and Prometheus pulls them. This pull model means a crashed service simply stops being scraped, rather than flooding a metrics pipeline with failure data.

**Three metric types and when to use each:**

- **Counter** -- A monotonically increasing number. Counts things that only go up: total requests, total errors, total posts created. You never reset a counter. To get "requests per second," Prometheus computes the rate of change: `rate(http_requests_total[5m])`.
- **Histogram** -- Records the distribution of values (e.g., request durations). Prometheus pre-buckets the values, so you can query percentiles: "p99 latency was 450ms." This is critical because averages hide outliers -- an average of 50ms could mean 99% at 10ms and 1% at 4 seconds.
- **Gauge** -- A value that goes up and down: current connection count, queue depth, circuit breaker state. Unlike counters, gauges represent a point-in-time snapshot.

**The RED method** (Rate, Errors, Duration) is applied across all services:
- **Rate**: `rate(http_requests_total[5m])` -- requests per second. Sudden drops indicate failures; spikes indicate traffic surges.
- **Errors**: `rate(http_requests_total{status_code=~"5.."}[5m])` -- error rate. If this exceeds 0.1% for 5 minutes, page the on-call engineer.
- **Duration**: `histogram_quantile(0.99, http_request_duration_seconds)` -- p99 latency. If this exceeds 500ms for 5 minutes, investigate.

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_requests_total` | Counter | method, route, status_code | Request volume |
| `http_request_duration_seconds` | Histogram | method, route | Latency percentiles |
| `feed_generation_seconds` | Histogram | cache_status | Feed performance |
| `image_processing_seconds` | Histogram | size | Worker throughput |
| `image_processing_errors_total` | Counter | error_type | Processing failures |
| `posts_created_total` | Counter | - | Content velocity |
| `likes_total` | Counter | action | Engagement rate |
| `follows_total` | Counter | action | Growth metrics |
| `circuit_breaker_state` | Gauge | name | Service health |
| `circuit_breaker_events_total` | Counter | name, event | Failure patterns |
| `db_query_duration_seconds` | Histogram | operation | Database performance |
| `db_connection_pool_size` | Gauge | state | Pool saturation |
| `rate_limit_hits_total` | Counter | action | Abuse detection |
| `active_sessions` | Gauge | - | Concurrent users |

### Structured Logging (Pino)

`console.log("user liked post")` is useless in production. When you have 100 servers each producing thousands of log lines per second, you need to search, filter, and correlate logs programmatically. Structured logging means every log entry is a JSON object with consistent fields, not a free-form string. These JSON logs are fed to a log aggregation system (ELK stack: Elasticsearch + Logstash + Kibana, or Datadog) where you can query: "show me all ERROR logs for user_id=abc123 in the last hour."

**Why Pino over Winston/console.log**: Pino is the fastest Node.js JSON logger (~5x faster than Winston). It achieves this by deferring string serialization to a worker thread. In a high-throughput service processing 10K requests/second, logger overhead matters -- Pino adds ~1ms per 1000 log calls, while Winston adds ~5ms.

**Log levels** control verbosity without code changes:
- **debug** -- Cache hits/misses, query details. Only enabled in development or when investigating a specific issue.
- **info** -- Request completed, business events (post created, user followed). The baseline for production.
- **warn** -- Rate limit hit, circuit breaker half-open, degraded but functional state. Signals that something needs attention but is not broken.
- **error** -- 5xx responses, unhandled exceptions, service failures. Always triggers alerting.

All services emit structured JSON logs via Pino with:
- `trace_id` for request correlation across services -- when a feed load calls the image service, both log entries share the same trace_id
- `user_id` for user-scoped debugging -- "show me everything this user did in the last hour"
- `duration_ms` for performance tracking -- identify slow requests without Prometheus

### Alert Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | 5xx rate > 0.1% for 5 minutes | Critical |
| Feed latency | p99 > 500ms for 5 minutes | Warning |
| Image processing backlog | Queue depth > 10K for 10 minutes | Warning |
| Circuit breaker open | Any breaker in OPEN state | Critical |
| Storage capacity | S3 bucket > 90% quota | Critical |
| Replication lag | PostgreSQL replica > 30s behind primary | Warning |

## Failure Handling

### Circuit Breakers

A circuit breaker prevents cascading failures in distributed systems. The problem: if the image processing service goes down, the API server keeps sending requests to it. Each request waits for a timeout (e.g., 30 seconds), consuming a thread/connection. With 1000 concurrent requests, all 1000 threads are blocked waiting for a dead service, and the API server itself becomes unresponsive. One failing service takes down the entire system.

The circuit breaker sits between the caller and the dependency, monitoring failure rates. It has three states:

- **CLOSED** (normal operation): Requests flow through to the downstream service. The breaker counts successes and failures.
- **OPEN** (service is down, fail fast): When failures exceed a threshold (e.g., >50% error rate), the breaker "trips open." All subsequent requests immediately fail with a fallback response (e.g., return cached data or a 503) without ever calling the downstream service. This is the key insight: failing fast (1ms) is better than failing slow (30s timeout).
- **HALF-OPEN** (testing recovery): After a cooldown period (e.g., 30 seconds), the breaker allows one test request through. If it succeeds, the breaker transitions back to CLOSED. If it fails, back to OPEN for another cooldown period. This automatic recovery detection means services self-heal without operator intervention.

The local implementation uses the Opossum library, which provides configurable thresholds, timeout values, and fallback functions. Opossum also exposes Prometheus metrics for each breaker (state gauge, trip counter), enabling alerts like "circuit breaker for Cassandra has been OPEN for 5 minutes."

| Service | Timeout | Fallback |
|---------|---------|----------|
| Image processing | 30s | Return 503 "temporarily unavailable" |
| Feed generation | 10s | Return empty feed `{ posts: [] }` |
| Cassandra (DMs) | 5s | Return 503, DMs degraded |
| Elasticsearch (search) | 3s | Return empty results |

### Retry Strategy

| Operation | Max Retries | Backoff | Idempotency |
|-----------|-------------|---------|-------------|
| Image processing | 3 | Exponential (1s, 2s, 4s) | Safe (deterministic output) |
| S3 upload | 3 | Exponential | Safe (overwrite by key) |
| Database write | 0 | N/A | ACID transactions |
| Kafka publish | 5 | Exponential | Idempotent producer |

### Dead Letter Queues

Failed image processing jobs (after 3 retries) are routed to a dead letter queue for manual inspection. The DLQ is monitored and alerts fire when depth > 0. Failed posts are marked `status: 'failed'` in PostgreSQL so users see "Upload failed, tap to retry."

### Graceful Degradation

| Failure | Degradation Strategy |
|---------|---------------------|
| Redis cluster down | Bypass cache, serve from PostgreSQL replicas (higher latency) |
| Kafka down | Buffer events in-memory, flush when recovered |
| Cassandra down | DMs unavailable, core features (feed, posts) unaffected |
| S3 down | New uploads queued, existing media served from CDN cache |
| Elasticsearch down | Search unavailable, autocomplete falls back to PostgreSQL LIKE |
| PostgreSQL replica down | Route reads to remaining replicas or primary |

## Security

### Authentication and Authorization

- **OAuth 2.0 + OIDC** for third-party login (Google, Facebook, Apple)
- **JWT access tokens** (15-minute expiry) + **refresh tokens** (90-day, stored in Redis for revocation)
- **Session revocation**: Revoking a refresh token immediately invalidates all access tokens derived from it
- **Device management**: Users can see and revoke sessions from specific devices

### Role-Based Access Control (RBAC)

RBAC is an authorization model where permissions are assigned to roles, and users are assigned to roles -- not directly to permissions. Without RBAC, you would check `if (user.canDeletePosts && user.canBanUsers && user.canViewStats)` for every admin action, and adding a new permission means updating every user record. With RBAC, you check `if (user.role === 'admin')`, and the role defines what permissions it includes. Adding a new permission only requires updating the role definition, not every user.

In this project, the `users` table has a `role` column (`user`, `admin`, etc.). The auth middleware reads the role from the session, and route-level middleware checks `requireRole('admin')` before allowing access to admin endpoints. The middleware chain works as: authenticate (verify session) -> authorize (check role) -> route handler.

| Role | Permissions |
|------|-------------|
| anonymous | View public profiles and posts |
| user | Create content, follow, like, comment, DM |
| verified | All user + verification badge, priority support |
| admin | All + delete any content, ban users, view system stats |

### Rate Limiting

Rate limiting prevents abuse, protects the database from overload, and ensures fair usage across all users. Without it, a single bot could create 10,000 posts per minute, overwhelming the database and degrading service for legitimate users.

**Token Bucket algorithm**: Imagine each user has a bucket that holds N tokens. Each request consumes one token. Tokens are refilled at a fixed rate (e.g., 10 per minute). When the bucket is empty, requests are rejected with HTTP 429 (Too Many Requests). This allows bursts (a user can consume all tokens at once) while enforcing a long-term average rate.

**Sliding Window algorithm** (used here): Counts requests in a rolling time window. More accurate than fixed windows (which allow double the rate at window boundaries). Implemented with Redis sorted sets: each request adds a timestamp, and the count is the number of entries within the window.

**Per-user vs per-IP**: Authenticated users get per-user limits (tied to their user ID). Anonymous requests get per-IP limits (to prevent unauthenticated abuse). Per-user limits are stricter for expensive operations (post creation, follows) and more lenient for reads (feed requests).

Distributed rate limiting via Redis sliding window:

| Action | Limit | Window | Rationale |
|--------|-------|--------|-----------|
| Login | 5 | 1 minute | Brute force prevention |
| Post creation | 10 | 1 hour | Content spam prevention |
| Follow | 30 | 1 hour | Follow-bot prevention |
| Like | 100 | 1 hour | Engagement spam prevention |
| Comment | 50 | 1 hour | Comment spam prevention |
| Story creation | 20 | 1 hour | Story spam prevention |
| Feed requests | 60 | 1 minute | Scraping prevention |
| General API | 1000 | 1 minute | DDoS mitigation |

### Content Moderation

- Pre-upload: Client-side NSFW detection (on-device ML)
- Post-upload: Automated content scanning pipeline (image classification, text toxicity scoring)
- Flagged content enters human review queue
- Repeat offenders trigger progressive enforcement (warning, shadow ban, account suspension)

### Input Validation

- File uploads: Max 10 MB images, 100 MB videos; allowed types: image/jpeg, image/png, image/webp, image/heic, video/mp4
- Captions: Max 2200 characters, HTML sanitized
- Usernames: 3-30 chars, alphanumeric + underscore, case-insensitive
- All UUID parameters validated before database queries

## Consistency and Idempotency

### Idempotency for Uploads

Idempotency solves the "double-submit" problem. Consider this scenario: a user uploads a photo, the server processes it and creates the post, but the HTTP response is lost due to a network timeout. The client shows an error and the user taps "retry." Without idempotency, the server creates a second identical post. The user now has two copies of the same photo in their feed.

The solution: the client generates a unique ID (UUID) and sends it as the `X-Idempotency-Key` header with the upload request. The server's flow is: (1) check Redis for this key, (2) if found, return the cached response from the first request, (3) if not found, process the request, store the response in Redis with a 24-hour TTL, and return it. The 24-hour TTL means the key auto-expires after the reasonable retry window, keeping Redis memory bounded.

Post creation uses an idempotency key (`X-Idempotency-Key` header). If the client retries a failed upload, the server returns the existing post instead of creating a duplicate. Keys are stored in Redis with 24-hour TTL.

### Idempotent Likes

The `likes` table has a `UNIQUE(user_id, post_id)` constraint. `INSERT ... ON CONFLICT DO NOTHING` ensures duplicate like requests are silently absorbed. The `like_count` trigger only fires on actual inserts, preventing double-counting.

### Exactly-Once DM Delivery

Messages use `TimeUUID` as the message ID (generated server-side). The combination of `(conversation_id, message_id)` primary key in Cassandra ensures idempotent writes. Client retries with the same message ID result in an upsert, not a duplicate.

### Feed Consistency

Feeds are eventually consistent by design. A new post may take 2-5 seconds to appear in all followers' feeds due to:
1. Async image processing (2-5s)
2. Timeline fanout latency (< 1s for users with < 10K followers)
3. Feed cache TTL (60s worst case)

This is acceptable for a social media feed. Users see their own posts immediately (optimistic UI + self-timeline injection).

## Scalability Considerations

### Horizontal Scaling Path

| Scale | Architecture Changes |
|-------|---------------------|
| 1M DAU | Single PostgreSQL with read replicas, Redis cluster, S3 + CDN |
| 10M DAU | Shard PostgreSQL by user_id, separate feed/media/DM services |
| 100M DAU | Multi-region deployment, geo-routing, Cassandra multi-DC |
| 500M+ DAU | Cell-based architecture, dedicated celebrity feed path, edge compute |

### What Breaks First

1. **Feed generation** -- the JOIN across follows and posts becomes slow as the social graph grows. Solution: precomputed timelines in Redis (push model).
2. **PostgreSQL follows table** -- the social graph is the hottest table. Solution: shard by follower_id, cache in Redis.
3. **Image serving bandwidth** -- egress costs and latency. Solution: CDN with long cache TTLs.
4. **DM write throughput** -- PostgreSQL cannot handle 300K writes/sec. Solution: Cassandra (already chosen).
5. **Hot partitions** -- celebrity followers all query the same data. Solution: fan-out on read for celebrities, Redis caching.

## Key Design Decisions

### Decision 1: Pull vs Push vs Hybrid Feed

| Strategy | Pros | Cons |
|----------|------|------|
| Push (fanout on write) | O(1) reads, instant feed | Expensive for celebrities, wasted writes for inactive users |
| Pull (fanout on read) | Simple, no wasted work | O(following_count) per read, slow for users following many accounts |
| Hybrid (chosen) | Best of both, bounded worst case | Implementation complexity, two code paths |

The hybrid approach handles 99% of cases with the push model's speed while bounding celebrity post fanout. The read-time merge adds ~20ms latency for users who follow celebrities -- negligible compared to network round-trip.

### Decision 2: PostgreSQL + Cassandra Dual Database

| Database | Use Case | Why |
|----------|----------|-----|
| PostgreSQL | Users, posts, follows, stories | ACID for social graph mutations, complex JOINs for feed assembly |
| Cassandra | Direct messages, typing, reactions | 300K writes/sec, TimeUUID ordering, partition-per-conversation scaling |

The alternative (PostgreSQL for everything) would require sharding DMs across PostgreSQL instances, losing the natural partition isolation Cassandra provides. Cassandra's TimeUUID clustering gives free chronological ordering without maintaining a separate index.

### Decision 3: Async Image Processing

Synchronous processing would block the API server for 2-5 seconds per upload, consuming a thread/connection and degrading throughput. The async model (return 202 immediately, process in background) allows the API to handle 100x more concurrent uploads. The trade-off is UI complexity: the client must poll or receive a push notification when processing completes.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Feed model | Hybrid push/pull | Pure push or pull | Bounded fanout for celebrities, instant reads for normal users |
| Auth | OAuth 2.0 + JWT | Session cookies | Mobile-friendly, stateless validation, token refresh |
| DM storage | Cassandra | PostgreSQL | 300K writes/sec, TimeUUID ordering, partition isolation |
| Message queue | Kafka | RabbitMQ | Event sourcing, replay capability, higher throughput |
| Image storage | S3 + CDN | Self-hosted | 11 nines durability, global CDN, pay-per-use |
| Search | Elasticsearch | PostgreSQL full-text | Fuzzy matching, autocomplete, relevance scoring |
| Notifications | SSE + push | WebSocket | Unidirectional suffices, simpler connection management |
| DM real-time | WebSocket | Polling | Sub-100ms delivery, bidirectional for typing/presence |

---

# Layer 2: Pocket-Size Architecture (What We Actually Built)

This section documents the actual local implementation -- what runs on a single developer machine with Docker Compose. The goal is to learn production patterns at a human-debuggable scale.

## Actual Local Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (Vite + React)                      │
│                      http://localhost:5173                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (REST API)
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                   Express API Server                             │
│                    http://localhost:3000                          │
│                                                                  │
│  Routes: auth, posts, feed, stories, users, comments, messages   │
│  Middleware: session (Redis), rate limiting, metrics, logging     │
└───┬──────────┬──────────┬───────────┬───────────┬───────────────┘
    │          │          │           │           │
    │          │          │           │           │
┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌─────▼────┐ ┌───▼──────┐
│ Pg    │ │Valkey │ │ MinIO │ │ RabbitMQ │ │Cassandra │
│:5432  │ │:6379  │ │:9000  │ │  :5672   │ │  :9042   │
│       │ │       │ │       │ │          │ │          │
│users  │ │session│ │images │ │image jobs│ │DM msgs   │
│posts  │ │feed   │ │stories│ │          │ │typing    │
│follows│ │cache  │ │avatars│ │          │ │reactions │
│stories│ │rate   │ │       │ │          │ │receipts  │
│likes  │ │limits │ │       │ │          │ │          │
│etc.   │ │       │ │       │ │          │ │          │
└───────┘ └───────┘ └───────┘ └─────┬────┘ └──────────┘
                                    │
                              ┌─────▼─────┐
                              │  Image    │
                              │  Worker   │
                              │ (separate │
                              │  process) │
                              └───────────┘
```

## What Actually Runs

### Single Express Server (Not Microservices)

The production architecture splits into Feed, Media, Story, DM, and Notification services. Locally, everything runs as a single Express server (`backend/src/index.ts`) with route modules:

- `routes/auth.ts` -- register, login, logout, current user
- `routes/posts.ts` -- CRUD + like/unlike with idempotency
- `routes/feed.ts` -- pull-model feed with Redis caching
- `routes/stories.ts` -- create, view, story tray with cache
- `routes/users.ts` -- profile, follow/unfollow, followers/following
- `routes/comments.ts` -- threaded comments with like support
- `routes/messages.ts` -- DM conversations and messages via Cassandra

The server can run as multiple instances on ports 3001-3003 (`npm run dev:server1`, `dev:server2`, `dev:server3`) for testing distributed behavior, though no load balancer is wired up by default.

### Separate Image Worker

The one piece that does run as a separate process: `backend/src/workers/image-worker.ts`. It consumes from a RabbitMQ queue, processes images with Sharp (resize to 4 sizes: 150x150, 320x320, 640x640, 1080x1080), and updates the database. This demonstrates the async processing pattern from the production architecture.

After processing, the worker fans out the post to followers' Redis timelines (`ZADD timeline:{userId} {timestamp} {postId}`), implementing a simplified version of the push model.

### Infrastructure (Docker Compose)

The `docker-compose.yml` starts 5 services:

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| PostgreSQL 16 | `postgres:16-alpine` | 5432 | All relational data |
| Valkey 7 | `valkey/valkey:7-alpine` | 6379 | Sessions, feed cache, rate limiting, timelines |
| RabbitMQ 3 | `rabbitmq:3-management-alpine` | 5672 / 15672 | Image processing queue + management UI |
| Cassandra 4.1 | `cassandra:4.1` | 9042 | Direct messages |
| MinIO | `minio/minio:latest` | 9000 / 9001 | Object storage + console |

Initialization containers handle Cassandra schema (`cassandra-init.cql`) and MinIO bucket creation.

### Frontend

React + TypeScript + Vite with TanStack Router. Key routes:

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | `index.tsx` | Home feed with virtualized list (@tanstack/react-virtual) |
| `/login`, `/register` | auth routes | Session-based authentication |
| `/create` | `create.tsx` | Post creation with filter preview |
| `/profile/:username` | `profile.$username.tsx` | User profile with post grid |
| `/post/:postId` | `post.$postId.tsx` | Single post detail view |
| `/explore` | `explore.tsx` | Discover content |
| `/settings` | `settings.tsx` | User settings |

State management: Zustand (`authStore.ts`). API client: centralized in `services/api.ts`.

## What's Simplified

| Production | Local Implementation |
|------------|---------------------|
| S3 + CDN | MinIO (S3-compatible, no CDN) |
| OAuth 2.0 + JWT | Session cookies in Valkey (simpler, web-only) |
| Hybrid push/pull feed | Pull model with Redis cache (60s TTL) |
| Sharded PostgreSQL | Single instance, no replicas |
| Kafka event bus | RabbitMQ (simpler, sufficient for single-machine) |
| WebSocket for DMs | HTTP polling (no real-time push) |
| Elasticsearch search | PostgreSQL LIKE queries |
| Push notifications | Not implemented |
| Content moderation | Not implemented |
| Pre-signed upload URLs | Multipart upload through API server |
| 5 image sizes + WebP/AVIF | 4 JPEG sizes (thumbnail, small, medium, large) |
| Multi-region deployment | Single machine |
| Auto-scaling | Fixed process count |

## Production Patterns Actually Implemented

The following production-grade patterns are wired into the running code, not just listed as dependencies.

### Circuit Breakers (Opossum)

**File**: `backend/src/services/circuitBreaker.ts`

The `createCircuitBreaker` factory wraps async functions with three-state protection (CLOSED / OPEN / HALF-OPEN). Configuration: 10s timeout, 50% error threshold, 30s reset timeout, minimum 5 requests before tripping.

Circuit breakers are used in feed generation and image processing routes. When a downstream service fails repeatedly, the breaker opens and returns a fallback immediately (503 for processing, empty feed for feeds), preventing cascade failures.

All state transitions emit Prometheus metrics (`instagram_circuit_breaker_state`, `instagram_circuit_breaker_events_total`) and structured log entries.

### Prometheus Metrics (prom-client)

**File**: `backend/src/services/metrics.ts`

30+ metrics are defined and actively collected:

- HTTP request duration and count (histogram + counter with method/route/status labels)
- Business metrics: posts created, likes (with duplicate detection), follows, stories, story views
- Feed performance: generation duration by cache hit/miss, cache hit/miss counters
- Image processing: duration histogram, error counter by type
- Circuit breaker: state gauge, event counter
- Database: query duration, connection pool size
- Auth: login/register attempts by result
- Rate limiting: hits by action

Metrics are exposed at `GET /metrics` in Prometheus text format and collected via the `metricsMiddleware` on every request.

### Structured Logging (Pino)

**File**: `backend/src/services/logger.ts`

JSON-structured logging with:
- Service context (name, env, port) on every log line
- Request correlation via `traceId` (UUID assigned per request, propagated via `x-trace-id` header)
- Child loggers with user context (`createRequestLogger`)
- Specialized log functions: `logRequest` (with timing), `logError` (with stack), `logQuery` (with slow query warnings > 1s), `logCache` (hit/miss tracking)
- Log level routing: 5xx = error, 4xx = warn, 2xx = info

### Rate Limiting (express-rate-limit + Redis)

**File**: `backend/src/services/rateLimiter.ts`

Distributed rate limiting backed by Redis (works across multiple API server instances). Seven endpoint-specific limiters are configured:
- Post creation: 10/hour
- Follow: 30/hour
- Login: 5/minute (skips successful requests)
- Like: 100/hour
- Comment: 50/hour
- Story: 20/hour
- Feed: 60/minute
- General: 1000/minute (catch-all)

Each limiter logs warnings on hits, increments Prometheus counters, and returns `429` with informative error messages. Key generation uses user ID when authenticated, IP when anonymous.

### Health Checks

**File**: `backend/src/app.ts`

Four health endpoints are implemented:
- `GET /api/health` -- simple liveness (200 if process is running)
- `GET /api/health/live` -- Kubernetes-style liveness probe
- `GET /api/health/ready` -- readiness probe (checks PostgreSQL + Redis connectivity)
- `GET /api/health/detailed` -- comprehensive check of all 5 dependencies (PostgreSQL, Redis, MinIO, Cassandra, RabbitMQ) with latency measurements, memory usage, and uptime

### Request Tracing

Every request gets a `traceId` (from `x-trace-id` header or auto-generated UUID). This ID is returned in the response header, logged with every request, and passed to background jobs via RabbitMQ message payloads. This enables end-to-end request tracking across the API server and image worker.

### Graceful Shutdown

**File**: `backend/src/index.ts`

On SIGTERM/SIGINT, the server closes connections in order: PostgreSQL pool, Redis, Cassandra, RabbitMQ. This prevents in-flight requests from failing and ensures clean resource cleanup.

### Idempotent Likes

Likes use `INSERT ... ON CONFLICT DO NOTHING RETURNING id` with a `UNIQUE(user_id, post_id)` constraint. Duplicate like attempts are silently absorbed, and the `like_count` trigger only fires on actual inserts. A Prometheus counter (`instagram_likes_duplicate_total`) tracks idempotent hits.

### Dead Letter Queue

**File**: `backend/src/services/queue.ts`

Failed image processing jobs (after worker failure) are nacked without requeue, routing them to the `image-processing-dlq` dead letter queue via the `instagram-dlx` exchange. This prevents poison messages from blocking the queue.

### Database Triggers

**File**: `backend/src/db/init.sql`

PostgreSQL triggers maintain denormalized counts:
- `follow_count` / `following_count` on users (on follows INSERT/DELETE)
- `post_count` on users (on posts INSERT/DELETE)
- `like_count` on posts (on likes INSERT/DELETE)
- `comment_count` on posts (on comments INSERT/DELETE)
- `view_count` on stories (on story_views INSERT)

This avoids expensive COUNT queries on every profile/post load.

## What's Omitted

These production features are not implemented:

- CDN and edge caching
- Multi-region deployment and geo-routing
- Kubernetes orchestration
- Database sharding and read replicas
- ML-based feed ranking
- Real-time WebSocket for DMs (uses HTTP polling)
- Push notifications (APNs, FCM)
- Content moderation pipeline
- Video transcoding
- Explore/discovery algorithm
- Full-text search (Elasticsearch)
- Pre-signed upload URLs (uploads go through the API server)
- OAuth 2.0 / JWT (uses session cookies)

## How to Run

```bash
# Terminal 1: Start infrastructure
cd instagram
docker-compose up -d

# Terminal 2: Start backend API
cd instagram/backend
npm run dev          # Starts on port 3000

# Terminal 3: Start image worker
cd instagram/backend
npm run dev:worker   # Consumes from RabbitMQ

# Terminal 4: Start frontend
cd instagram/frontend
npm run dev          # Starts on port 5173
```

**Default credentials**:

| Service | User | Password | Database |
|---------|------|----------|----------|
| PostgreSQL | instagram | instagram123 | instagram |
| RabbitMQ | instagram | instagram123 | - |
| MinIO | minioadmin | minioadmin123 | bucket: instagram-media |
| Cassandra | - | - | keyspace: instagram_dm |

**Useful URLs**:
- Frontend: http://localhost:5173
- API: http://localhost:3000/api/v1/
- Metrics: http://localhost:3000/metrics
- Health: http://localhost:3000/api/health/detailed
- RabbitMQ UI: http://localhost:15672
- MinIO Console: http://localhost:9001

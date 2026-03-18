# Design Twitch - Architecture

## System Overview

Twitch is a live streaming platform with real-time chat, subscription-based monetization, and VOD (video on demand) recording. The core technical challenges center on three areas: low-latency live video delivery from broadcaster to thousands of concurrent viewers, real-time chat messaging at massive scale (100K+ users in a single channel), and a stream processing pipeline that simultaneously transcodes, delivers, and archives live content.

## Requirements

### Functional Requirements

1. **Stream**: Broadcast live video to viewers via RTMP ingest, transcoded to HLS for delivery
2. **Watch**: View live streams with < 5 second glass-to-glass latency, with quality selection
3. **Chat**: Real-time messaging during streams with emotes, badges, and moderation tools
4. **Subscribe**: Tiered paid subscriptions (Tier 1/2/3) with gift subscriptions
5. **VOD**: Watch past broadcasts, create clips from live streams
6. **Discover**: Browse by category, follow channels, see who's live

### Non-Functional Requirements

- **Latency**: < 5 seconds glass-to-glass (broadcaster capture to viewer display); < 2 seconds for LL-HLS
- **Scale**: 10M concurrent viewers, 100K concurrent streams, 1M chat messages/minute at peak
- **Availability**: 99.99% for video delivery; 99.9% for chat; 99.9% for API
- **Chat reliability**: Messages delivered in order within a channel; at-most-once for delivery (dropped > duplicated)
- **Consistency**: Strong consistency for subscriptions/payments; eventual consistency for viewer counts and follower counts

## Capacity Estimation

### Production Scale

| Metric | Value | Sizing Implication |
|--------|-------|-------------------|
| Concurrent viewers | 10M peak | ~500K WebSocket connections per chat pod |
| Concurrent streams | 100K | ~100K RTMP ingest connections |
| Chat messages | 1M/min peak | ~17K messages/second |
| Video bandwidth | ~20 Tbps | CDN required; origin serves < 1% |
| HLS segment size | 2-4 seconds | Balance latency vs. CDN cache efficiency |
| VOD storage growth | ~5TB/day | Archive to cold storage after 60 days |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent users | 1-5 |
| Active streams | 1-3 (simulated) |
| Chat messages | < 10/second |
| Storage | < 1GB |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Broadcaster Layer                                  │
│               OBS / Streamlabs (RTMP output)                            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ RTMP
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Ingest Layer                                       │
│   Globally distributed RTMP ingest servers                              │
│   - Authenticate stream key against database                            │
│   - Forward raw stream to transcoding pipeline                          │
│   - One ingest per stream (nearest POP)                                 │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
          ┌─────────────┐ ┌──────────┐ ┌──────────────┐
          │ Transcoder  │ │   VOD    │ │   Thumbnail  │
          │ (GPU)       │ │ Archiver │ │  Generator   │
          │ 1080p/720p/ │ │ segment  │ │  periodic    │
          │ 480p/360p   │ │ storage  │ │  keyframe    │
          └──────┬──────┘ └─────┬────┘ └──────────────┘
                 │              │
                 ▼              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CDN Layer                                       │
│   Edge servers deliver HLS segments with < 2 second edge propagation    │
│   Push model: origin pushes segments to edges on creation               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Client Layer                                      │
│              Web (HLS.js) / Mobile / Desktop                            │
│         Video player + Chat panel + Channel UI                          │
└─────────────────────┬──────────────────────────┬───────────────────────┘
                      │ WebSocket                 │ HTTPS
                      ▼                           ▼
┌─────────────────────────────┐    ┌──────────────────────────────────────┐
│       Chat Service          │    │            API Service               │
│                             │    │                                      │
│ - WebSocket connections     │    │ - Auth (sessions)                    │
│ - Message fan-out via       │    │ - Channels / Categories              │
│   Redis Pub/Sub             │    │ - Follows / Subscriptions            │
│ - Rate limiting per user    │    │ - Stream management                  │
│ - Emote rendering           │    │ - Moderation (bans, timeouts)        │
│ - Moderation enforcement    │    │ - VOD / Clips                        │
│ - Message persistence       │    │ - Emotes / Badges                    │
└──────────┬──────────────────┘    └──────────┬───────────────────────────┘
           │                                   │
           ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Data Layer                                     │
├────────────────┬────────────────┬──────────────────┬────────────────────┤
│   PostgreSQL   │   Redis/Valkey │   S3 / Blob      │   Kafka            │
│                │                │   Storage         │   (Optional)       │
│ - Users        │ - Sessions     │                   │                    │
│ - Channels     │ - Chat Pub/Sub │ - VOD segments    │ - Chat replay      │
│ - Streams      │ - Viewer count │ - Thumbnails      │ - Analytics        │
│ - Follows      │ - Rate limits  │ - Emote images    │ - Audit trail      │
│ - Subscriptions│ - Stream state │                   │                    │
│ - Chat history │                │                   │                    │
│ - Bans/Mods    │                │                   │                    │
└────────────────┴────────────────┴──────────────────┴────────────────────┘
```

## Core Components

### 1. Live Video Pipeline

The live video pipeline is the most latency-sensitive component. Every millisecond of added latency degrades the interactive experience between streamer and chat.

**Glass-to-glass latency breakdown:**

| Stage | Typical Latency | Optimization |
|-------|----------------|--------------|
| Capture + encode (OBS) | ~500ms | Hardware encoding (NVENC) |
| Upload (RTMP) | ~500ms | Nearest ingest POP |
| Transcoding | ~1s | GPU acceleration, 2s segments |
| CDN propagation | ~1s | Edge push (not pull) |
| Player buffer | ~2s | Reduced buffer for LL-HLS |
| **Total** | **~5 seconds** | **< 2s with LL-HLS** |

**RTMP Ingest flow:**
1. Broadcaster configures OBS with stream key from Twitch dashboard
2. OBS connects to nearest ingest server via RTMP
3. Ingest server validates stream key against the database
4. If valid, raw stream is forwarded to the transcoding cluster
5. If invalid, connection is rejected immediately

**Transcoding output:**
- 4 quality variants (1080p60, 720p30, 480p30, 360p30)
- HLS segments (2-4 seconds each, balancing latency vs. cacheability)
- Master manifest listing all available qualities
- Segments pushed to CDN origin immediately on creation

**Low-Latency HLS (LL-HLS):**
Standard HLS uses 6-second segments with 3-segment buffer = 18 seconds minimum latency. LL-HLS uses partial segments (200ms chunks within a 2-second segment) and server push, reducing latency to < 2 seconds. The trade-off is higher CDN request volume and reduced cache efficiency.

### 2. Chat System

Chat is the second hardest problem. A single popular stream can have 100K+ concurrent chatters sending thousands of messages per second.

**Architecture: WebSocket + Redis Pub/Sub fan-out**

```
┌─────────┐    ┌─────────┐    ┌─────────┐
│ Client  │    │ Client  │    │ Client  │
│  (WS)   │    │  (WS)   │    │  (WS)   │
└────┬────┘    └────┬────┘    └────┬────┘
     │              │              │
     ▼              ▼              ▼
┌─────────┐    ┌─────────┐    ┌─────────┐
│ Chat    │    │ Chat    │    │ Chat    │
│ Pod A   │    │ Pod B   │    │ Pod C   │
└────┬────┘    └────┬────┘    └────┬────┘
     │              │              │
     └──────────────┼──────────────┘
                    │
                    ▼
           ┌───────────────┐
           │ Redis Pub/Sub │
           │ chat:{chId}   │
           └───────────────┘
```

1. Client connects via WebSocket and joins a channel room
2. When a user sends a message, their chat pod publishes to Redis channel `chat:{channelId}`
3. All chat pods subscribed to that channel receive the message
4. Each pod broadcasts to all locally connected WebSocket clients for that channel
5. Messages are also persisted to PostgreSQL for moderation history

**Rate limiting**: Normal users: 1 message/second. Slow mode: configurable (5s, 30s, etc.). Subscribers get higher rate limits.

**Why Redis Pub/Sub over Kafka**: For chat, delivery latency matters more than durability. Redis Pub/Sub delivers messages in < 1ms within a datacenter. Kafka adds 5-50ms of latency due to batching and partition management. If a chat message is lost during a Redis restart, the impact is minimal (one message in a flood of thousands). Kafka would be the right choice for chat replay/VOD chat, where durability matters.

### 3. Stream Key Management

Stream keys authenticate broadcasters. The flow:

1. Streamer generates a unique stream key from their dashboard
2. Key is stored as a unique value in the `channels` table
3. When OBS connects, the ingest server validates the key against the database
4. If valid, the channel is marked `is_live = true` and a stream record is created
5. Streamers can regenerate their key at any time (invalidating the old one)

Stream keys should be treated like passwords -- transmitted only over RTMP (encrypted in transit) and never exposed in API responses.

### 4. Subscription and Monetization

**Tier structure:**
- Tier 1: Base subscription (e.g., $4.99/month)
- Tier 2: Enhanced subscription (e.g., $9.99/month)
- Tier 3: Premium subscription (e.g., $24.99/month)

Each tier unlocks progressively more emotes and grants corresponding subscriber badges in chat.

**Gift subscriptions**: A user can purchase a subscription for another user. Tracked via `is_gift` and `gifted_by` columns. Gift subs follow the same tier structure.

**Idempotency for payments**: Subscription creation uses idempotency keys to prevent double-charging. If a network retry resends a subscription request, the server checks the idempotency key and returns the cached result.

### 5. Moderation System

Chat moderation is critical for maintaining community health on a live platform.

**Roles and permissions:**

| Action | Viewer | Subscriber | Moderator | Broadcaster | Admin |
|--------|--------|------------|-----------|-------------|-------|
| Send messages | Yes | Yes | Yes | Yes | Yes |
| Use sub emotes | No | Yes | Yes | Yes | Yes |
| Timeout users | No | No | Yes | Yes | Yes |
| Ban users | No | No | Yes | Yes | Yes |
| Delete messages | No | No | Yes | Yes | Yes |
| Manage moderators | No | No | No | Yes | Yes |
| Manage stream key | No | No | No | Yes | Yes |

**Ban enforcement**: When a user is banned from a channel, their WebSocket connection is terminated and new connections are rejected by checking the `channel_bans` table. Bans can be permanent or timed (with `expires_at`).

**Audit logging**: All moderation actions (bans, timeouts, message deletions, moderator assignments) are logged with actor, target, reason, and timestamp for accountability and appeal handling.

## Database Schema

```sql
-- =============================================================================
-- USERS
-- =============================================================================
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url VARCHAR(500),
  bio TEXT,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'moderator')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- CATEGORIES (games, IRL, etc.)
-- =============================================================================
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  image_url VARCHAR(500),
  viewer_count INTEGER DEFAULT 0,   -- Denormalized, updated periodically
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- CHANNELS
-- =============================================================================
CREATE TABLE channels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) UNIQUE NOT NULL,
  stream_key VARCHAR(100) UNIQUE NOT NULL,
  title VARCHAR(200) DEFAULT 'Untitled Stream',
  description TEXT,
  category_id INTEGER REFERENCES categories(id),
  follower_count INTEGER DEFAULT 0,
  subscriber_count INTEGER DEFAULT 0,
  is_live BOOLEAN DEFAULT FALSE,
  current_viewers INTEGER DEFAULT 0,
  thumbnail_url VARCHAR(500),
  offline_banner_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- STREAMS (each broadcast session)
-- =============================================================================
CREATE TABLE streams (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  title VARCHAR(200),
  category_id INTEGER REFERENCES categories(id),
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  peak_viewers INTEGER DEFAULT 0,
  total_views INTEGER DEFAULT 0,
  vod_url VARCHAR(500),
  thumbnail_url VARCHAR(500)
);

-- =============================================================================
-- SOCIAL (follows + subscriptions)
-- =============================================================================
CREATE TABLE followers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  followed_at TIMESTAMP DEFAULT NOW(),
  notifications_enabled BOOLEAN DEFAULT TRUE,
  UNIQUE(user_id, channel_id)
);

CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  tier INTEGER DEFAULT 1 CHECK (tier IN (1, 2, 3)),
  started_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  is_gift BOOLEAN DEFAULT FALSE,
  gifted_by INTEGER REFERENCES users(id),
  UNIQUE(user_id, channel_id)
);

-- =============================================================================
-- EMOTES
-- =============================================================================
CREATE TABLE emotes (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  image_url VARCHAR(500) NOT NULL,
  tier INTEGER DEFAULT 0,        -- 0 = free, 1/2/3 = subscriber tier
  is_global BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- CHAT
-- =============================================================================
CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  badges JSONB DEFAULT '[]',
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- MODERATION
-- =============================================================================
CREATE TABLE channel_bans (
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  banned_by INTEGER REFERENCES users(id),
  reason TEXT,
  expires_at TIMESTAMP,           -- NULL = permanent
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE channel_moderators (
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  added_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

-- =============================================================================
-- SESSIONS
-- =============================================================================
CREATE TABLE sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================
CREATE INDEX idx_channels_is_live ON channels(is_live);
CREATE INDEX idx_channels_category ON channels(category_id);
CREATE INDEX idx_channels_viewers ON channels(current_viewers DESC);
CREATE INDEX idx_streams_channel ON streams(channel_id);
CREATE INDEX idx_streams_started_at ON streams(started_at DESC);
CREATE INDEX idx_followers_user ON followers(user_id);
CREATE INDEX idx_followers_channel ON followers(channel_id);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_channel ON subscriptions(channel_id);
CREATE INDEX idx_chat_messages_channel ON chat_messages(channel_id);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at DESC);
CREATE INDEX idx_emotes_channel ON emotes(channel_id);
CREATE INDEX idx_emotes_global ON emotes(is_global) WHERE is_global = TRUE;
```

## API Design

### Auth API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account + channel |
| POST | `/api/auth/login` | Login (sets session cookie) |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Get current user + channel |

### Channel API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/channels` | List live channels (filterable by category) |
| GET | `/api/channels/:id` | Get channel details |
| PUT | `/api/channels/:id` | Update channel info (owner only) |
| POST | `/api/channels/:id/follow` | Follow a channel |
| DELETE | `/api/channels/:id/follow` | Unfollow |
| POST | `/api/channels/:id/subscribe` | Subscribe (tier 1/2/3) |
| POST | `/api/channels/:id/stream-key/regenerate` | Regenerate stream key |

### Stream API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/streams/start` | Go live (creates stream record) |
| POST | `/api/streams/end` | End stream |
| GET | `/api/streams/live` | List all live streams |
| GET | `/api/streams/:id/vod` | Get VOD for past stream |

### Category API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/categories` | List all categories |
| GET | `/api/categories/:slug` | Get category with live channels |

### Moderation API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/moderation/:channelId/ban` | Ban user from channel |
| DELETE | `/api/moderation/:channelId/ban/:userId` | Unban user |
| POST | `/api/moderation/:channelId/timeout` | Timeout user (timed ban) |
| POST | `/api/moderation/:channelId/moderators` | Add moderator |
| DELETE | `/api/moderation/:channelId/moderators/:userId` | Remove moderator |
| GET | `/api/moderation/:channelId/logs` | Get moderation audit log |

### Chat (WebSocket)

| Message Type | Direction | Description |
|-------------|-----------|-------------|
| `join` | Client -> Server | Join a channel's chat room |
| `leave` | Client -> Server | Leave a channel's chat room |
| `message` | Client -> Server | Send a chat message |
| `message` | Server -> Client | Receive a chat message (with badges, emotes) |
| `system` | Server -> Client | System messages (ban, timeout, slow mode) |
| `viewer_count` | Server -> Client | Periodic viewer count update |

### Emote API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/emotes/global` | Get global emotes |
| GET | `/api/emotes/channel/:id` | Get channel-specific emotes |

## Key Design Decisions

### 1. Redis Pub/Sub for Chat Over Kafka

**Decision**: Use Redis Pub/Sub for real-time chat message fan-out across chat pods.

**Why it works**: Chat messages must reach viewers within 50-100ms. Redis Pub/Sub delivers messages in < 1ms within a datacenter. Messages are published to a channel-specific topic (`chat:{channelId}`), and all chat pods subscribed to that channel receive the message instantly. The fire-and-forget nature of Pub/Sub is acceptable because dropping a single chat message in a stream of thousands per second is invisible to users.

**Why not Kafka**: Kafka adds 5-50ms of latency due to write batching and partition commit cycles. For a real-time chat system where latency is the primary concern and messages are ephemeral, this latency penalty is unacceptable. Kafka's durability guarantees (which require disk writes) are unnecessary for live chat -- if a message is lost during a Redis restart, the conversation continues unaffected.

**What we give up**: Redis Pub/Sub has no message persistence. If a chat pod disconnects and reconnects, it misses messages sent during the disconnection. In production, this is mitigated by rapid reconnection and the fact that users don't notice a few missing messages in a fast-moving chat. For chat replay (VOD chat), messages are written to PostgreSQL synchronously, providing the durable copy.

### 2. WebSocket per Channel (Not per User)

**Decision**: Each WebSocket connection subscribes to one or more channel chat rooms, rather than having a single multiplexed connection per user.

**Why it works**: Users typically watch one stream at a time. A single WebSocket connection per active viewer, subscribed to one channel, is simple to implement and reason about. When the user navigates to a different channel, they close the old connection and open a new one.

**Trade-off**: For users watching multiple streams simultaneously (multiview), this means multiple WebSocket connections. At scale, this could increase connection count. But since multi-stream viewers are < 5% of users, the simplicity benefit outweighs the edge case cost.

### 3. Simulated Streams vs. Real RTMP Ingest

**Decision**: In the local implementation, streams are simulated (start/stop via API, viewer counts fluctuate automatically) rather than implementing real RTMP ingest with FFmpeg.

**Why**: Real RTMP ingest requires nginx-rtmp module, FFmpeg for transcoding, and significant CPU resources. These are infrastructure concerns, not system design concerns. The simulated approach lets us focus on the hard problems (chat at scale, subscription management, moderation) while the video pipeline is documented as a design artifact.

## Consistency and Idempotency

**Chat message deduplication**: Each chat message is assigned a unique ID. Redis-based deduplication (TTL 5 minutes) prevents duplicate messages from network retries.

**Subscription idempotency**: Subscription creation uses idempotency keys (TTL 24 hours) to prevent double-charging from payment retries.

**Stream state**: Stream start/end operations use Redis locks (TTL 10 seconds) to prevent race conditions when multiple RTMP reconnects arrive simultaneously.

**Follow/unfollow idempotency**: The `UNIQUE(user_id, channel_id)` constraint on the `followers` table prevents duplicate follows at the database level.

## Security and Auth

**Session-based authentication**: Cookie-based sessions stored in PostgreSQL (`sessions` table) with Redis caching. Sessions expire based on the `expires_at` column.

**Stream key security**: Stream keys are unique per channel, stored as plain values (not hashed, since they need to be displayed to the streamer). Keys can be regenerated at any time, immediately invalidating the old key.

**Chat rate limiting**: Redis-backed rate limiting per user per channel. Default: 1 message/second. Configurable slow mode by moderators (5s, 30s, etc.).

**Moderation audit trail**: All moderation actions (bans, timeouts, message deletions, moderator changes) are logged with actor, target, reason, and timestamp via a dedicated audit logger.

## Observability

**Prometheus metrics** (via `prom-client`):
- WebSocket connection gauge (active connections by channel)
- Chat messages sent/received counter
- Chat rate limit hits counter
- Chat deduplication counter
- Stream start/end events
- Subscription creation counter (by tier, gift vs. paid)
- Moderation action counter (ban, timeout, delete)
- HTTP request duration and count by route
- Circuit breaker state gauge

**Structured logging** (via `pino`):
- JSON format for machine parsing
- Request ID propagation via middleware
- Chat-specific event logging (join, leave, message, ban)
- Audit logging for moderation actions (separate log stream)
- HTTP request logging via `pino-http`

**Health checks**:
- `/health` -- comprehensive check with database and Redis status
- `/health/live` -- liveness probe (process is running)
- `/health/ready` -- readiness probe (database and Redis reachable)

## Failure Handling

### Circuit Breakers

Circuit breakers (Opossum) protect critical paths:

- **Redis chat publish**: If Redis becomes unresponsive, the circuit opens and chat falls back to local broadcast (messages only delivered to clients connected to the same pod). This is degraded but functional.
- **Database queries**: If PostgreSQL is slow, the circuit opens and endpoints return cached data or 503.

### Retry Strategy

- Database connection failures: retry with exponential backoff (1s, 2s, 4s, max 3 retries)
- Redis reconnection: automatic via the redis client library with configurable retry strategy
- Non-retryable: authentication failures, validation errors, permission denials

### Graceful Degradation

| Component Failure | Degradation Behavior |
|-------------------|---------------------|
| Redis down | Chat falls back to local-pod-only broadcast; sessions read from PostgreSQL |
| PostgreSQL slow | Cached channel/category data served; writes queued |
| CDN edge failure | Viewers fall back to next-nearest edge or origin |
| Chat pod crash | Clients reconnect to another pod; miss a few messages |
| Transcoder failure | Stream continues at last available quality |

### Graceful Shutdown

On SIGTERM:
1. Stop accepting new WebSocket connections
2. Send "server_shutdown" message to all connected chat clients
3. Close all WebSocket connections gracefully
4. Stop accepting new HTTP requests
5. Wait for in-flight requests to complete (10-second timeout)
6. Close database and Redis connections
7. Exit

## Scalability Considerations

### Horizontal Scaling Path

1. **Chat pods**: Scale horizontally. Each pod subscribes to Redis Pub/Sub for its active channels. Connection count balanced by load balancer (sticky sessions per channel).
2. **API servers**: Stateless with session state in Redis/PostgreSQL. Scale behind load balancer.
3. **RTMP ingest**: Scale by region. Each ingest server handles ~1000 concurrent streams. New POPs added as geographic demand grows.
4. **Transcoders**: Scale independently per stream. GPU instances auto-scale based on active stream count.
5. **PostgreSQL**: Read replicas for channel/category browsing. Write sharding by `channel_id` for chat messages.
6. **Redis**: Cluster mode. Separate instances for sessions, chat Pub/Sub, and rate limiting.

### What Breaks First

1. **Chat message volume** in popular streams -- solved by sharding chat across multiple Redis channels and using client-side message batching
2. **WebSocket connection count** -- solved by adding chat pods (each handles ~50K connections)
3. **Viewer count accuracy** -- solved by sampling and periodic aggregation rather than real-time counting
4. **Chat message persistence** -- solved by partitioning `chat_messages` by `created_at` with TTL-based cleanup
5. **Transcoder capacity** -- solved by GPU auto-scaling, with priority queue for partner/affiliate streamers

### Chat Message Retention

| Age | Storage | Access Pattern |
|-----|---------|---------------|
| < 24 hours | PostgreSQL (hot) | Moderation, recent history |
| 1-30 days | PostgreSQL (partitioned) | User appeals, content reports |
| > 30 days | Archived / deleted | Compliance retention only |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Chat delivery | Redis Pub/Sub | Kafka | < 1ms latency; durability unnecessary for ephemeral chat |
| Chat protocol | WebSocket | SSE / Long polling | Bidirectional needed; lower overhead per message |
| HLS segments | 2-4 second | 6 second (standard) | Lower latency at cost of higher CDN request volume |
| Session storage | PostgreSQL + Redis cache | JWT | Revocable sessions; Redis for speed, PG for durability |
| Stream simulation | API-based start/stop | Real RTMP ingest | Focuses on system design over infrastructure setup |
| Chat persistence | PostgreSQL | Cassandra | Simpler operations; partition by time at scale |
| Viewer counts | Redis INCR + periodic flush | Real-time DB writes | Reduces write pressure; eventual consistency acceptable |

---

## Implementation Notes

This section maps the production architecture above to what is actually running locally.

### Local Architecture

```
┌───────────────────────┐         ┌───────────────────────┐
│   React Frontend      │────────▶│   Express API Server  │
│   :5173 (Vite)        │  HTTP   │   :3000                │
│                       │         │                       │
│ - Browse/home page    │         │ - Channel/category API│
│ - Channel pages       │    WS   │ - Auth (cookie-based) │
│ - Chat panel      ────│────────▶│ - WebSocket chat      │
│ - Dashboard (creator) │         │   (/ws/chat)          │
│ - Category browse     │         │ - Stream simulator    │
│ - Following feed      │         │ - Moderation API      │
│ - HLS.js player       │         │ - Emotes API          │
│ - Zustand + TanStack  │         │ - Prometheus metrics  │
│   Router              │         │ - Audit logging       │
└───────────────────────┘         └────┬──────────┬───────┘
                                       │          │
                          ┌────────────┘          │
                          ▼                       ▼
                 ┌─────────────────┐    ┌─────────────────┐
                 │   PostgreSQL    │    │   Valkey/Redis   │
                 │   :5432         │    │   :6379          │
                 │   (twitch_db)   │    │   (chat pub/sub, │
                 │                 │    │    rate limits,   │
                 │   Full schema:  │    │    viewer counts, │
                 │   users,channels│    │    idempotency)   │
                 │   streams,chat  │    │                   │
                 │   bans,mods,    │    │                   │
                 │   emotes,subs   │    │                   │
                 └─────────────────┘    └─────────────────┘
```

Run with:
```
docker-compose up -d          # Infrastructure (PostgreSQL, Valkey)
cd backend && npm run dev     # API + WebSocket server on :3000
cd frontend && npm run dev    # Frontend on :5173
```

### Production Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Structured logging | Pino JSON logger with request ID | `backend/src/utils/logger.ts` |
| Prometheus metrics | WS connections, chat messages, subs, moderation | `backend/src/utils/metrics.ts` |
| Circuit breakers | Opossum wrapping Redis chat publish | `backend/src/utils/circuitBreaker.ts` |
| Retry with backoff | Exponential backoff for transient failures | `backend/src/utils/retry.ts` |
| Health checks | Liveness, readiness, comprehensive probes | `backend/src/utils/health.ts` |
| Idempotency | Chat message dedup, subscription dedup, stream locks | `backend/src/utils/idempotency.ts` |
| Audit logging | Tamper-evident moderation action log | `backend/src/utils/audit.ts` |
| WebSocket chat | Real-time chat with Redis Pub/Sub fan-out | `backend/src/services/chat.ts` |
| Chat rate limiting | Redis-backed per-user per-channel limits | `backend/src/services/redis.ts` |
| Stream simulation | Automatic viewer count fluctuation | `backend/src/services/streamSimulator.ts` |
| Session auth | Cookie-based sessions stored in PostgreSQL | `backend/src/routes/auth.ts` |
| Moderation system | Bans, timeouts, moderator management, filters | `backend/src/routes/moderation/` |
| Emote system | Global + channel emotes with tier gating | `backend/src/routes/emotes.ts` |
| Graceful shutdown | SIGTERM handler with connection cleanup | `backend/src/index.ts` |

### What Was Simplified or Substituted

| Production Component | Local Substitute | Reason |
|---------------------|-----------------|--------|
| RTMP ingest servers | API-based start/stop simulation | No nginx-rtmp module needed |
| GPU transcoding (FFmpeg) | No transcoding; simulated stream state | Focuses on chat/moderation design |
| CDN (CloudFront/Akamai) | No CDN; video player shows placeholder | No real video segments to deliver |
| HLS segment delivery | Simulated; HLS.js included but no real segments | Video pipeline is a design artifact |
| Kafka (chat replay, analytics) | Redis Pub/Sub only | Sufficient for local fan-out |
| Payment processor (Stripe) | Subscription creation without payment | No real billing integration |
| Multi-pod chat deployment | Single process; Redis Pub/Sub still used | Use `npm run dev:server{1,2,3}` to test fan-out |
| OAuth / SSO | Cookie sessions with bcrypt passwords | Simpler for learning |

### What Was Omitted

- **Real RTMP ingest**: No nginx-rtmp module; streams are simulated via API calls
- **Video transcoding pipeline**: No FFmpeg; no actual video segments generated
- **CDN layer**: No edge caching; video player shows channel info placeholder
- **VOD recording**: Schema supports it (`vod_url` column) but no segment archival implemented
- **Clip creation**: No clip extraction from live or VOD content
- **Push notifications**: No notification system for go-live events
- **Chat replay**: No synchronization of chat messages with VOD timeline
- **Multi-region deployment**: Single Docker Compose on localhost
- **Kubernetes orchestration**: No container scheduling or auto-scaling
- **Spam/ML moderation**: Rule-based only; no ML content filtering
- **Bits/donations**: No micropayment or tipping system
- **Raid/host system**: No stream-to-stream viewer redirection

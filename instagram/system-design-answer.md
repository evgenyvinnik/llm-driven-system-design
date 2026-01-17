# Instagram - System Design Interview Answer

## Opening Statement

"Today I'll design Instagram, a photo and video sharing social platform. The key challenges are handling massive media storage and delivery, generating personalized feeds at scale, implementing ephemeral Stories, and building a real-time direct messaging system - all while maintaining sub-second latency for billions of users."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Photo/Video Upload** - Upload, filter, and post photos and videos
2. **Feed** - Personalized home feed showing posts from followed accounts
3. **Stories** - Ephemeral 24-hour content with viewer tracking
4. **Direct Messaging** - Real-time messaging with media sharing
5. **Social Features** - Follow, like, comment, save, share
6. **Explore** - Discover new content and accounts
7. **Notifications** - Real-time activity notifications

### Non-Functional Requirements

- **Scale**: 2B+ users, 500M+ DAU, 100M+ posts/day
- **Latency**: Feed load < 200ms, upload < 5s
- **Availability**: 99.99% uptime
- **Consistency**: Eventual consistency for feed, strong for DMs

### Out of Scope

- Reels (similar to TikTok - could discuss as extension)
- Shopping features
- Ads delivery system

---

## Step 2: Scale Estimation (2-3 minutes)

**User base:**
- 2 billion total users, 500 million DAU
- Average user follows 200 accounts
- Average user posts 1 photo/week, views 100 posts/day

**Traffic:**
- Feed reads: 500M DAU * 10 sessions * 20 posts = 100B post reads/day
- Feed QPS: 100B / 86400 = 1.1M QPS (peak 3M QPS)
- Uploads: 100M posts/day = 1,200 uploads/second

**Storage:**
- Average photo: 2MB (multiple resolutions)
- Average video: 50MB
- Daily new media: 100M * 2MB = 200TB/day
- 5 years storage: 365 * 5 * 200TB = 365 PB

**Key insight**: This is extremely read-heavy (100:1 ratio). Feed generation is the bottleneck, not uploads.

---

## Step 3: High-Level Architecture (10 minutes)

```
                                ┌─────────────────────────────────┐
                                │       Mobile/Web Clients        │
                                └───────────────┬─────────────────┘
                                                │
                                                ▼
                                ┌─────────────────────────────────┐
                                │           CDN (Images)          │
                                └───────────────┬─────────────────┘
                                                │
                                                ▼
                                ┌─────────────────────────────────┐
                                │         Load Balancer           │
                                └───────────────┬─────────────────┘
                                                │
          ┌──────────────────────────┬──────────┴──────────┬──────────────────────────┐
          │                          │                     │                          │
┌─────────▼─────────┐    ┌───────────▼──────────┐   ┌──────▼──────────┐    ┌──────────▼─────────┐
│   Feed Service    │    │   Post Service       │   │ Stories Service │    │     DM Service     │
│                   │    │                      │   │                 │    │                    │
│ - Feed generation │    │ - Upload handling    │   │ - 24hr TTL      │    │ - Real-time msgs   │
│ - Timeline cache  │    │ - Media processing   │   │ - View tracking │    │ - Read receipts    │
└─────────┬─────────┘    └───────────┬──────────┘   └────────┬────────┘    └──────────┬─────────┘
          │                          │                       │                        │
          │                          │                       │                        │
    ┌─────▼─────┐              ┌─────▼─────┐           ┌─────▼─────┐           ┌──────▼─────┐
    │   Redis   │              │   Kafka   │           │   Redis   │           │  Cassandra │
    │ Timeline  │              │           │           │ + Memcache│           │            │
    │   Cache   │              │           │           │           │           │            │
    └───────────┘              └─────┬─────┘           └───────────┘           └────────────┘
                                     │
             ┌───────────────────────┼───────────────────────┐
             │                       │                       │
    ┌────────▼────────┐    ┌────────▼────────┐    ┌─────────▼────────┐
    │  Media Pipeline │    │  Feed Pipeline  │    │  Search Indexer  │
    │                 │    │                 │    │                  │
    │ - Resize        │    │ - Fan-out       │    │ - User search    │
    │ - Compress      │    │ - ML ranking    │    │ - Hashtag search │
    │ - CDN push      │    │                 │    │                  │
    └────────┬────────┘    └────────┬────────┘    └──────────────────┘
             │                      │
    ┌────────▼────────┐    ┌────────▼────────┐
    │  Object Storage │    │   PostgreSQL    │
    │  (S3)           │    │  (User, Posts)  │
    └─────────────────┘    └─────────────────┘
```

### Core Components

1. **Feed Service**
   - Generates personalized home feed
   - Manages timeline cache in Redis
   - Handles feed pagination

2. **Post Service**
   - Upload handling and validation
   - Media processing orchestration
   - Post metadata management

3. **Stories Service**
   - Ephemeral content with 24-hour TTL
   - View tracking and analytics
   - Tray generation (story circles)

4. **DM Service**
   - Real-time messaging via WebSocket
   - Message persistence
   - Media in messages

5. **Media Pipeline**
   - Asynchronous image/video processing
   - Multiple resolution generation
   - CDN distribution

6. **Feed Pipeline**
   - Fan-out on write/read hybrid
   - ML-based ranking
   - Real-time updates

---

## Step 4: Deep Dive - Image/Video Processing (7 minutes)

### Upload Flow

```
┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
│ Client │───▶│  API   │───▶│ Upload │───▶│ Kafka  │───▶│ Media  │
│        │    │ Server │    │ Service│    │ Queue  │    │Pipeline│
└────────┘    └────────┘    └────────┘    └────────┘    └────────┘
                                                              │
                              ┌────────────────────────────────┘
                              │
                              ▼
               ┌──────────────────────────────┐
               │        Media Pipeline        │
               │                              │
               │  1. Virus scan               │
               │  2. Content moderation       │
               │  3. Extract metadata (EXIF)  │
               │  4. Generate thumbnails      │
               │  5. Resize (multiple sizes)  │
               │  6. Compress                 │
               │  7. Upload to S3             │
               │  8. Push to CDN              │
               │  9. Update post status       │
               └──────────────────────────────┘
```

### Image Resolutions

```
Original → Stored but rarely served
Large    → 1080px (feed display)
Medium   → 640px (grid view)
Small    → 320px (thumbnails)
Tiny     → 150px (notifications, mentions)
```

### Video Processing

```typescript
interface VideoProcessingJob {
  originalUrl: string;
  outputs: [
    { resolution: '1080p', codec: 'h264', bitrate: '5000k' },
    { resolution: '720p', codec: 'h264', bitrate: '2500k' },
    { resolution: '480p', codec: 'h264', bitrate: '1000k' },
  ];
  thumbnail: { atSecond: 1, size: '640x640' };
}
```

- Transcode to multiple resolutions
- Adaptive bitrate streaming (HLS)
- Generate preview thumbnails
- Extract first frame as fallback

### CDN Strategy

```
┌──────────────────────────────────────────────────────────────┐
│                         CDN Layer                            │
│                                                              │
│   ┌────────────┐   ┌────────────┐   ┌────────────┐          │
│   │ Edge PoP 1 │   │ Edge PoP 2 │   │ Edge PoP N │          │
│   │ (NYC)      │   │ (London)   │   │ (Tokyo)    │          │
│   └─────┬──────┘   └─────┬──────┘   └─────┬──────┘          │
│         │                │                │                  │
│         └────────────────┼────────────────┘                  │
│                          │                                   │
│                   ┌──────▼──────┐                            │
│                   │   Origin    │                            │
│                   │   (S3)      │                            │
│                   └─────────────┘                            │
└──────────────────────────────────────────────────────────────┘
```

- Signed URLs with expiration for private accounts
- Regional origin shields reduce S3 load
- Cache popular content at edge (hit rate > 95%)

---

## Step 5: Deep Dive - Feed Generation (10 minutes)

This is the core challenge at Instagram's scale.

### The Problem

User A follows 500 accounts. When A opens the app:
- Fetch recent posts from all 500 accounts
- Apply ML ranking
- Return top posts
- Do this in < 200ms for millions of concurrent users

### Approaches

**Option 1: Pull-based (Fan-out on Read)**
```
User opens app:
  → Query posts from all followed users
  → Sort by ranking
  → Return top N

Pros: No wasted storage, always fresh
Cons: Slow for users following many accounts
```

**Option 2: Push-based (Fan-out on Write)**
```
User posts:
  → Push to all followers' timelines
  → Each user has precomputed feed

Pros: Fast reads
Cons: Expensive for celebrities (100M+ followers)
```

**Option 3: Hybrid (Instagram's Approach)**

```
┌─────────────────────────────────────────────────────────────┐
│                     Hybrid Fan-out                          │
│                                                             │
│   Small accounts (< 10K followers):                         │
│     → Fan-out on write (push to followers' feeds)           │
│                                                             │
│   Large accounts (celebrities):                             │
│     → Fan-out on read (pull when user loads feed)           │
│     → Results merged with pushed content                    │
└─────────────────────────────────────────────────────────────┘
```

### Feed Data Model

```
Redis Timeline Cache:
Key: timeline:{user_id}
Value: Sorted Set of (post_id, timestamp)
TTL: 7 days
Max entries: 500

Post Metadata Cache:
Key: post:{post_id}
Value: {author_id, media_urls, caption, like_count, created_at}
```

### Feed Generation Flow

```typescript
async function getFeed(userId: string, cursor: string) {
  // 1. Get precomputed timeline from Redis
  const timelinePostIds = await redis.zrevrange(
    `timeline:${userId}`,
    cursor,
    cursor + 20
  );

  // 2. Get celebrity posts (fan-out on read)
  const celebrityFollows = await getCelebrityFollows(userId);
  const celebrityPosts = await getRecentPosts(celebrityFollows);

  // 3. Merge and rank
  const allPosts = [...timelinePostIds, ...celebrityPosts];
  const rankedPosts = await mlRanker.rank(userId, allPosts);

  // 4. Fetch full post data
  const posts = await postCache.getMulti(rankedPosts.slice(0, 20));

  return posts;
}
```

### Fan-out on Write Pipeline

```
┌──────────┐    ┌─────────┐    ┌─────────────────┐    ┌──────────┐
│ New Post │───▶│  Kafka  │───▶│ Fan-out Workers │───▶│  Redis   │
│          │    │         │    │ (100s of them)  │    │ Timeline │
└──────────┘    └─────────┘    └─────────────────┘    └──────────┘

For each follower:
  ZADD timeline:{follower_id} {timestamp} {post_id}
  ZREMRANGEBYRANK timeline:{follower_id} 500 -1  // Keep last 500
```

### ML Ranking

Ranking signals:
1. **Interest score**: User's engagement history with author
2. **Recency**: Exponential time decay
3. **Engagement velocity**: Early likes/comments rate
4. **Relationship**: Close friends, frequent interactions
5. **Content type**: User's preference for photos vs videos

```python
def rank_posts(user_id, posts):
    features = extract_features(user_id, posts)
    scores = ml_model.predict(features)
    return sorted(posts, key=lambda p: scores[p.id], reverse=True)
```

---

## Step 6: Deep Dive - Stories (7 minutes)

### Stories Characteristics

- Ephemeral: 24-hour lifetime
- View-once semantics: Track who viewed
- Tray: Horizontal list of story "bubbles"
- No likes/comments (reactions only)

### Data Model

```sql
-- Stories table (TTL-based cleanup)
CREATE TABLE stories (
  id UUID PRIMARY KEY,
  user_id UUID,
  media_url VARCHAR(500),
  created_at TIMESTAMP,
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '24 hours'),
  view_count INTEGER DEFAULT 0
);

-- Story views
CREATE TABLE story_views (
  story_id UUID,
  viewer_id UUID,
  viewed_at TIMESTAMP,
  PRIMARY KEY (story_id, viewer_id)
);
```

### View Tracking

```typescript
async function viewStory(storyId: string, viewerId: string) {
  // Deduplicate views (user can only view once)
  const viewed = await redis.sadd(`story_views:${storyId}`, viewerId);

  if (viewed) {
    // Increment counter
    await redis.incr(`story_view_count:${storyId}`);

    // Async persist to DB for author's viewer list
    await kafka.send('story_view', { storyId, viewerId });
  }
}
```

### Story Tray Generation

```
User's tray shows stories from followed accounts:
  → Ordered by: unseen first, then recency
  → Precomputed in Redis for fast access

Key: story_tray:{user_id}
Value: List of {user_id, has_unseen, latest_story_time}
```

### Cleanup

- TTL on Redis keys (auto-expire at 24h)
- Background job to delete from S3 (run hourly)
- Archive to cold storage for legal/safety (7 days)

---

## Step 7: Deep Dive - Direct Messaging (5 minutes)

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                      DM Architecture                           │
│                                                                │
│  ┌──────────┐        ┌──────────────────┐       ┌──────────┐  │
│  │  Client  │◄──────▶│   WebSocket      │◄─────▶│  Redis   │  │
│  │          │        │   Gateway        │       │  Pub/Sub │  │
│  └──────────┘        └──────────────────┘       └──────────┘  │
│                               │                               │
│                               ▼                               │
│                      ┌────────────────┐                       │
│                      │   DM Service   │                       │
│                      └────────┬───────┘                       │
│                               │                               │
│                               ▼                               │
│                      ┌────────────────┐                       │
│                      │   Cassandra    │                       │
│                      │ (Messages DB)  │                       │
│                      └────────────────┘                       │
└────────────────────────────────────────────────────────────────┘
```

### Message Schema (Cassandra)

```sql
CREATE TABLE messages (
  conversation_id UUID,
  message_id TIMEUUID,  -- Sortable by time
  sender_id UUID,
  content TEXT,
  media_url TEXT,
  message_type TEXT,  -- 'text', 'image', 'video', 'story_reply'
  PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

CREATE TABLE user_conversations (
  user_id UUID,
  conversation_id UUID,
  last_message_time TIMESTAMP,
  unread_count INT,
  PRIMARY KEY (user_id, last_message_time)
) WITH CLUSTERING ORDER BY (last_message_time DESC);
```

### Real-time Delivery

```typescript
async function sendMessage(senderId, conversationId, content) {
  // 1. Persist message
  const message = await cassandra.insert('messages', {
    conversation_id: conversationId,
    message_id: TimeUUID.now(),
    sender_id: senderId,
    content: content
  });

  // 2. Get conversation participants
  const participants = await getParticipants(conversationId);

  // 3. Publish to Redis for real-time delivery
  for (const userId of participants) {
    await redis.publish(`user:${userId}:messages`, message);
  }

  // 4. Update conversation metadata
  await updateConversation(conversationId, message);

  return message;
}
```

### Read Receipts

- Stored in Redis with TTL
- Published via same pub/sub channel
- Batch updates to reduce traffic

---

## Step 8: Data Model (3 minutes)

### PostgreSQL (Primary Data)

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR(30) UNIQUE,
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255),
  bio TEXT,
  profile_picture_url VARCHAR(500),
  is_private BOOLEAN DEFAULT FALSE,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  post_count INTEGER DEFAULT 0,
  created_at TIMESTAMP
);

-- Posts
CREATE TABLE posts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  caption TEXT,
  location VARCHAR(255),
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  created_at TIMESTAMP
);

-- Post media (supports carousel)
CREATE TABLE post_media (
  id UUID PRIMARY KEY,
  post_id UUID REFERENCES posts(id),
  media_type VARCHAR(10),  -- 'image', 'video'
  media_url VARCHAR(500),
  order_index INTEGER
);

-- Follows
CREATE TABLE follows (
  follower_id UUID REFERENCES users(id),
  following_id UUID REFERENCES users(id),
  created_at TIMESTAMP,
  PRIMARY KEY (follower_id, following_id)
);

-- Likes
CREATE TABLE likes (
  user_id UUID,
  post_id UUID,
  created_at TIMESTAMP,
  PRIMARY KEY (user_id, post_id)
);
```

### Redis (Caching & Real-time)

```
timeline:{user_id}     → Sorted Set of post_ids
post:{post_id}         → Post metadata hash
user:{user_id}         → User metadata hash
followers:{user_id}    → Set of follower user_ids
story_tray:{user_id}   → List of story users
```

---

## Step 9: API Design (2 minutes)

### REST API

```
# Feed
GET /api/v1/feed?cursor={cursor}
Response: { posts: [...], next_cursor: "..." }

# Posts
POST /api/v1/posts
Body: multipart (images/video, caption)

GET /api/v1/posts/{post_id}
POST /api/v1/posts/{post_id}/like
DELETE /api/v1/posts/{post_id}/like

# Stories
POST /api/v1/stories
GET /api/v1/stories/tray
GET /api/v1/users/{user_id}/stories
POST /api/v1/stories/{story_id}/view

# Users
GET /api/v1/users/{user_id}
POST /api/v1/users/{user_id}/follow
DELETE /api/v1/users/{user_id}/follow

# DM (WebSocket)
ws://api/v1/messages
Events: message, typing, read_receipt
```

---

## Step 10: Scalability (3 minutes)

### Database Scaling

- **PostgreSQL**: Sharded by user_id for users/posts
- **Cassandra**: Distributed for messages (AP system)
- **Redis Cluster**: Sharded timelines

### Geographic Distribution

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  US-West    │     │  EU-West    │     │  Asia-Pac   │
│  Region     │     │  Region     │     │  Region     │
│             │     │             │     │             │
│ - App Svrs  │     │ - App Svrs  │     │ - App Svrs  │
│ - Redis     │     │ - Redis     │     │ - Redis     │
│ - Read DB   │     │ - Read DB   │     │ - Read DB   │
└─────────────┘     └─────────────┘     └─────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                    ┌───────▼───────┐
                    │ Primary DB    │
                    │ (US-East)     │
                    └───────────────┘
```

### Handling Celebrity Posts

- Dedicated fan-out workers
- Priority queues for normal users
- Rate limiting on fan-out

---

## Step 11: Trade-offs (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Hybrid fan-out | Complexity vs. performance at scale |
| Redis timelines | Memory cost vs. fast reads |
| Cassandra for DMs | Eventual consistency, but scales well |
| Multiple image sizes | Storage cost vs. bandwidth savings |

### Alternatives Considered

1. **Full push model**
   - Simpler implementation
   - Doesn't scale for celebrities

2. **Full pull model**
   - No storage overhead
   - Too slow for high-follow users

3. **SQL for messages**
   - Simpler ops
   - Doesn't scale for billions of messages

---

## Closing Summary

"I've designed Instagram with:

1. **Asynchronous media pipeline** for processing uploads with multiple resolutions
2. **Hybrid fan-out feed** combining push for regular users and pull for celebrities
3. **Ephemeral Stories** with 24-hour TTL and view tracking
4. **Real-time DM** using WebSockets with Cassandra persistence

The key architectural insight is the hybrid feed approach - it's the only way to achieve both fast reads and reasonable write amplification at Instagram's scale. Happy to discuss any component in more detail."

---

## Potential Follow-up Questions

1. **How would you implement Explore/Discover?**
   - Content-based recommendation
   - Collaborative filtering
   - Trending topics engine

2. **How would you detect and remove inappropriate content?**
   - ML classifiers in media pipeline
   - User reports + manual review
   - Automated hash matching for known bad content

3. **How would you implement Instagram Live?**
   - RTMP ingestion
   - HLS/DASH distribution
   - WebRTC for low-latency interaction

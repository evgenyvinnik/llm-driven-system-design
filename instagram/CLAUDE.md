# Instagram - Photo Sharing - Development with Claude

## Project Context

Building a photo sharing social platform to understand image processing pipelines, feed generation, ephemeral content (stories), and real-time messaging at scale.

**Key Learning Goals:**
- Design image processing pipeline with multiple resolutions
- Implement personalized feed generation (pull model)
- Build ephemeral stories with 24-hour expiration
- Understand dual-database architecture (PostgreSQL + Cassandra)
- Handle real-time direct messaging

---

## Key Challenges Explored

### 1. Image Processing Pipeline

**Problem**: Users upload high-resolution images (2-10 MB), but we need multiple sizes for different UI contexts.

**Solution: Async Processing with RabbitMQ**
```
Upload → Store Original → Queue Job → Worker → Generate Resolutions → Update Status
```

**Resolutions generated:**
- Thumbnail: 150×150 (story rings, notifications)
- Small: 320×320 (grid view)
- Medium: 640×640 (feed on mobile)
- Large: 1080×1080 (full-screen view)

**Implementation:**
- `POST /api/v1/posts` returns immediately with `status: 'processing'`
- Image worker consumes from RabbitMQ queue
- Sharp library for high-performance image resizing
- MinIO stores originals and processed versions separately

### 2. Feed Generation Strategy

**Challenge**: How to efficiently load a personalized feed?

**Options Evaluated:**

| Strategy | Pros | Cons |
|----------|------|------|
| Push (fanout on write) | Fast reads | Expensive for popular users |
| Pull (fetch on read) | Simple | Slower reads, more DB load |
| Hybrid | Best of both | Complex |

**Decision: Pull Model**

For learning purposes, implemented simple pull model:
```sql
SELECT p.*, u.username, u.avatar_url
FROM posts p
JOIN follows f ON f.following_id = p.user_id
JOIN users u ON u.id = p.user_id
WHERE f.follower_id = $user_id AND p.status = 'published'
ORDER BY p.created_at DESC
LIMIT 20;
```

**Optimizations applied:**
- Feed cache in Valkey (60s TTL)
- Composite index on `(user_id, created_at DESC)`
- Cache invalidation on follow/unfollow

### 3. Dual Database Architecture

**Decision**: PostgreSQL for relational data + Cassandra for messages

| Database | Use Case | Rationale |
|----------|----------|-----------|
| **PostgreSQL** | Users, posts, follows, stories | ACID transactions, complex joins |
| **Cassandra** | Direct messages, typing indicators | High-write throughput, time-ordering |

**Why Cassandra for DMs:**
- Messages are write-heavy (100:1 write:read ratio)
- TimeUUID clustering keys provide natural time ordering
- Partition per conversation enables horizontal scaling
- Built-in TTL for ephemeral content

### 4. Story Expiration

**Challenge**: Stories expire after 24 hours. How to handle?

**Solution: Database-level filtering + Background cleanup**

```sql
-- Query active stories
SELECT * FROM stories
WHERE user_id = $1 AND expires_at > NOW()
ORDER BY created_at DESC;

-- Background job (runs hourly)
DELETE FROM stories WHERE expires_at < NOW() - INTERVAL '1 hour';
```

---

## Development Phases

### Phase 1: Core Infrastructure (Complete)
- [x] PostgreSQL schema for users, posts, follows
- [x] MinIO object storage setup
- [x] RabbitMQ for async processing
- [x] Session-based auth with Valkey

### Phase 2: Photo Upload & Processing (Complete)
- [x] Multipart upload endpoint
- [x] Image worker with Sharp
- [x] Multiple resolution generation
- [x] Status tracking (processing → published)

### Phase 3: Social Graph & Feed (Complete)
- [x] Follow/unfollow functionality
- [x] Feed generation (pull model)
- [x] Feed caching with 60s TTL
- [x] Infinite scroll with cursor pagination

### Phase 4: Stories (Complete)
- [x] Story upload and processing
- [x] Story tray (list of users with active stories)
- [x] Story viewer with view tracking
- [x] 24-hour automatic expiration
- [x] View deduplication per user

### Phase 5: Direct Messages (Complete)
- [x] Cassandra schema for messages
- [x] Conversation creation and listing
- [x] Message send/receive
- [x] Typing indicators (5s TTL)
- [x] Read receipts

### Phase 6: Frontend (Complete)
- [x] React + TypeScript + Vite setup
- [x] TanStack Router for navigation
- [x] Virtualized feed with @tanstack/react-virtual
- [x] Story viewer with auto-advance
- [x] Post creation with preview
- [x] Profile page with post grid

### Phase 7: Polish (Partial)
- [x] Like/unlike with optimistic updates
- [x] Comment system with threading
- [ ] Push notifications
- [ ] Search (users and hashtags)
- [ ] Explore page (discover content)

---

## Design Decisions Log

### Decision 1: Pull vs Push for Feeds
**Context**: Celebrity accounts can have millions of followers
**Decision**: Simple pull model for learning project
**Trade-off**: Higher read latency, but much simpler implementation
**Future**: Could add hybrid approach for accounts with >10K followers

### Decision 2: PostgreSQL + Cassandra
**Context**: Need strong consistency for follows, high throughput for messages
**Decision**: Dual database architecture
**Trade-off**: Operational complexity, data sync challenges
**Mitigation**: Background job syncs user profile changes to Cassandra conversations

### Decision 3: 60-Second Feed Cache TTL
**Context**: Balance between freshness and performance
**Decision**: 60s TTL with invalidation on follow/unfollow
**Trade-off**: New posts from followed users may not appear for up to 60s
**Rationale**: Acceptable for learning project; production would use shorter TTL or invalidation triggers

### Decision 4: Denormalized User Info in Cassandra
**Context**: Cassandra doesn't support cross-partition joins
**Decision**: Copy username/avatar to conversations_by_user table
**Trade-off**: Must sync on profile updates
**Implementation**: Background job triggered on profile change

### Decision 5: Session-based Auth
**Context**: Need simple authentication for learning project
**Decision**: Express sessions stored in Valkey
**Trade-off**: Not suitable for mobile apps (would need JWT)
**Rationale**: Simpler than JWT for web-only learning project

---

## Implementation Notes

### Backend Structure
```
backend/
├── src/
│   ├── api/
│   │   └── index.js       # Express server
│   ├── worker/
│   │   └── image.js       # Image processing worker
│   └── shared/
│       ├── db.js          # PostgreSQL pool
│       ├── cassandra.js   # Cassandra client
│       ├── cache.js       # Valkey client
│       ├── storage.js     # MinIO client
│       └── queue.js       # RabbitMQ client
├── db/
│   ├── init.sql           # PostgreSQL schema
│   ├── cassandra-init.cql # Cassandra schema
│   └── seed.sql           # Demo data
```

### Frontend Structure
```
frontend/
├── src/
│   ├── components/
│   │   ├── PostCard.tsx       # Single post display
│   │   ├── StoryTray.tsx      # Story ring list
│   │   ├── StoryViewer.tsx    # Full-screen story viewer
│   │   └── CreatePost.tsx     # Post creation modal
│   ├── routes/
│   │   ├── index.tsx          # Home feed (virtualized)
│   │   ├── profile.$username.tsx
│   │   └── messages/
│   ├── stores/
│   │   ├── authStore.ts       # Auth state
│   │   └── feedStore.ts       # Feed state
│   └── services/
│       └── api.ts             # API client
```

### Key Implementation Patterns

**Optimistic Updates for Likes:**
```typescript
function handleLike(postId) {
  // Immediately update UI
  setPosts(posts => posts.map(p =>
    p.id === postId ? { ...p, liked: true, likeCount: p.likeCount + 1 } : p
  ));

  // Send to server
  api.likePost(postId).catch(() => {
    // Revert on failure
    setPosts(posts => posts.map(p =>
      p.id === postId ? { ...p, liked: false, likeCount: p.likeCount - 1 } : p
    ));
  });
}
```

**Feed Virtualization:**
```typescript
const virtualizer = useVirtualizer({
  count: posts.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 600,  // Estimate: header + image + actions
  overscan: 3,
  measureElement: (el) => el.getBoundingClientRect().height,
});
```

---

## Questions Explored

1. **How does Instagram handle image uploads for slow connections?**
   - Chunked uploads with resume support
   - Progressive JPEG for faster perceived loading

2. **How do they handle story ordering?**
   - Unseen stories first
   - Within unseen, sort by recency or engagement signals

3. **How do they sync Cassandra with PostgreSQL?**
   - Event-driven: profile update → message to sync queue → worker updates Cassandra
   - Eventual consistency is acceptable (2-5 second lag)

---

## Reliability Patterns Implemented

| Pattern | Purpose | Location |
|---------|---------|----------|
| Idempotency | Prevent duplicate posts on retry | `POST /api/v1/posts` |
| Circuit Breaker | Protect against Cassandra failures | `shared/cassandra.js` |
| Rate Limiting | Prevent abuse | Valkey-based per-endpoint limits |
| Retry with Backoff | Handle transient RabbitMQ failures | `worker/image.js` |

---

## Resources

- [Instagram Engineering Blog](https://instagram-engineering.com/)
- [Cassandra Data Modeling](https://cassandra.apache.org/doc/latest/data_modeling/)
- [Sharp Image Processing](https://sharp.pixelplumbing.com/)
- [TanStack Virtual Documentation](https://tanstack.com/virtual/latest)

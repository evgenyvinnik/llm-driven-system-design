# Design Twitter - Development with Claude

## Project Context

Building a Twitter-like microblogging platform to understand timeline fanout, social graphs, and real-time trend detection.

**Key Learning Goals:**
- Master fanout strategies (push vs pull vs hybrid)
- Understand the "celebrity problem" and solutions
- Build real-time trend detection
- Design efficient social graph queries

---

## Key Challenges to Explore

### 1. The Fanout Problem

**Challenge**: When a user tweets, how do we notify millions of followers?

**The Math**:
- User with 50M followers tweets
- If we write to each follower's timeline: 50M writes
- At 10K writes/second: 83 minutes to complete
- User expects instant delivery

**Solution: Don't fanout for celebrities**
- Normal users (< 10K followers): Push to timeline caches
- Celebrities: Skip fanout, pull at read time
- Timeline read merges: cached tweets + celebrity tweets

### 2. Timeline Merge at Read

**Challenge**: How to efficiently merge cached timeline with celebrity pulls?

```javascript
async function getHomeTimeline(userId) {
  // 1. Get cached timeline (pushed tweets)
  const cachedIds = await redis.lrange(`timeline:${userId}`, 0, 100)
  const cachedTweets = await getTweetsByIds(cachedIds)

  // 2. Get followed celebrities
  const following = await getFollowing(userId)
  const celebrities = following.filter(u => u.is_celebrity)

  // 3. Pull recent tweets from celebrities
  const celebrityTweets = await getTweetsByAuthors(celebrities, { limit: 50 })

  // 4. Merge and sort
  const allTweets = [...cachedTweets, ...celebrityTweets]
  return allTweets.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
}
```

### 3. Real-Time Trend Detection

**Challenge**: Identify trending topics as they emerge

**Approach**: Sliding window with exponential decay

```javascript
// Simplified trend scorer
class TrendTracker {
  private counts: Map<string, number[]> = new Map()
  private readonly BUCKETS = 60 // 60 minutes of history

  record(hashtag: string) {
    const bucket = this.getCurrentBucket()
    // Increment current bucket count
  }

  getScore(hashtag: string): number {
    // Sum buckets with decay: recent = more weight
    // score = sum(count[i] * 0.95^i)
  }

  getVelocity(hashtag: string): number {
    // Compare last hour vs previous hour
    // Rising = velocity > 1
  }
}
```

---

## Development Phases

### Phase 1: Core Tweet System - COMPLETED
- [x] User registration and profiles
- [x] Tweet creation with hashtag extraction
- [x] Basic tweet retrieval
- [x] PostgreSQL schema

### Phase 2: Social Graph & Timeline - IN PROGRESS
- [x] Follow/unfollow functionality
- [x] Follower/following lists
- [x] Redis caching for timelines
- [x] Count denormalization via triggers
- [x] Push fanout for normal users
- [x] Timeline cache in Redis
- [x] Pull for celebrity tweets
- [x] Merge algorithm

### Phase 3: Engagement & Trends - COMPLETED
- [x] Like/unlike functionality
- [x] Retweet/unretweet functionality
- [x] Hashtag extraction from tweets
- [x] Time-bucketed counting in Redis
- [x] Trend scoring algorithm with exponential decay
- [x] Trend API endpoint

### Phase 4: Frontend - COMPLETED
- [x] React + TypeScript + Vite setup
- [x] Tanstack Router for navigation
- [x] Zustand for state management
- [x] Tailwind CSS for styling
- [x] Home timeline view
- [x] Profile page
- [x] Compose tweet
- [x] Trending sidebar

### Phase 5: Real-Time (Future)
- [ ] SSE for timeline updates
- [ ] Notification system
- [ ] Live engagement counts

---

## Design Decisions Log

### Decision 1: Hybrid Fanout
**Context**: Pure push doesn't scale for celebrities
**Decision**: Push for < 10K followers, pull for celebrities
**Trade-off**: More complex read path, but necessary for scale
**Implementation**: `is_celebrity` flag auto-set via database trigger when follower_count >= 10000

### Decision 2: Synchronous Fanout (Simplified)
**Context**: Original design called for Kafka event streaming
**Decision**: For learning purposes, using synchronous fanout with Redis pipeline
**Trade-off**: Simpler architecture, but won't scale as well as async
**Future**: Could add background workers with a job queue

### Decision 3: Redis Lists for Timelines
**Context**: Need fast timeline reads
**Decision**: Store tweet IDs in Redis lists (not full tweets)
**Trade-off**: Extra lookup for tweet content, but less memory
**Implementation**: `timeline:{userId}` with LPUSH + LTRIM to cap at 800 tweets

### Decision 4: Database Triggers for Counts
**Context**: Need to keep follower/following/tweet counts accurate
**Decision**: Use PostgreSQL triggers instead of application-level updates
**Trade-off**: Business logic in database, but atomic and consistent

### Decision 5: Session-based Auth with Redis Store
**Context**: Need simple authentication for learning project
**Decision**: Express sessions backed by Redis
**Trade-off**: Simpler than JWT, works well for single-region deployment

---

## Implementation Notes

### Backend Structure
```
backend/
├── src/
│   ├── db/
│   │   ├── pool.js       # PostgreSQL connection
│   │   ├── redis.js      # Redis connection
│   │   ├── migrate.js    # Schema + triggers
│   │   └── seed.js       # Demo data
│   ├── routes/
│   │   ├── auth.js       # Login, register, logout
│   │   ├── users.js      # Profile, follow/unfollow
│   │   ├── tweets.js     # CRUD + like/retweet
│   │   ├── timeline.js   # Home, explore, user, hashtag
│   │   └── trends.js     # Trending hashtags
│   ├── services/
│   │   └── fanout.js     # Timeline fanout logic
│   ├── middleware/
│   │   └── auth.js       # requireAuth, requireAdmin
│   └── index.js          # Express server
```

### Frontend Structure
```
frontend/
├── src/
│   ├── components/       # Tweet, Timeline, ComposeTweet, Sidebar
│   ├── routes/           # Tanstack Router file-based routing
│   ├── stores/           # Zustand stores (auth, timeline)
│   ├── services/         # API client
│   ├── types/            # TypeScript interfaces
│   └── utils/            # Formatting helpers
```

---

## Questions to Explore

1. **How does Twitter handle tweet deletions in cached timelines?**
   - Lazy deletion: Skip deleted tweets at read time (implemented via is_deleted flag)
   - Background cleanup: Periodic scan of timeline caches

2. **How do they handle out-of-order delivery?**
   - Timestamp-based sorting at read time
   - Client-side deduplication

3. **What about protected accounts?**
   - Skip fanout entirely
   - Check permissions on every read

---

## Resources

- [Twitter's Timeline Architecture](https://blog.twitter.com/engineering/en_us/topics/infrastructure/2017/the-infrastructure-behind-twitter-scale)
- [Scaling Twitter's Ad Platform](https://blog.twitter.com/engineering)
- [Designing Data-Intensive Applications - Chapter 11](https://dataintensive.net/)

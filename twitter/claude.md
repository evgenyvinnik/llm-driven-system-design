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

### Phase 1: Core Tweet System
- [ ] User registration and profiles
- [ ] Tweet creation with hashtag extraction
- [ ] Basic tweet retrieval
- [ ] PostgreSQL schema

### Phase 2: Social Graph
- [ ] Follow/unfollow functionality
- [ ] Follower/following lists
- [ ] Valkey caching for graph
- [ ] Count denormalization

### Phase 3: Timeline Fanout
- [ ] Push fanout for normal users
- [ ] Timeline cache in Valkey
- [ ] Pull for celebrity tweets
- [ ] Merge algorithm

### Phase 4: Trends
- [ ] Hashtag extraction from tweets
- [ ] Time-bucketed counting
- [ ] Trend scoring algorithm
- [ ] Trend API endpoint

### Phase 5: Real-Time
- [ ] SSE for timeline updates
- [ ] Notification system
- [ ] Live engagement counts

---

## Design Decisions Log

### Decision 1: Hybrid Fanout
**Context**: Pure push doesn't scale for celebrities
**Decision**: Push for < 10K followers, pull for celebrities
**Trade-off**: More complex read path, but necessary for scale

### Decision 2: Kafka for Events
**Context**: Need to decouple tweet creation from fanout
**Decision**: Publish tweet.created events, fanout workers consume
**Trade-off**: Added infrastructure, but better separation

### Decision 3: Valkey Lists for Timelines
**Context**: Need fast timeline reads
**Decision**: Store tweet IDs in Valkey lists (not full tweets)
**Trade-off**: Extra lookup for tweet content, but less memory

---

## Questions to Explore

1. **How does Twitter handle tweet deletions in cached timelines?**
   - Lazy deletion: Skip deleted tweets at read time
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

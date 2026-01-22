# Facebook News Feed - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## Introduction

"Today I'll design a personalized news feed system similar to Facebook's, focusing on the backend architecture. The core challenge is generating a personalized, ranked feed for billions of users while handling the write amplification problem when popular users post. I'll dive deep into fan-out strategies, database design, caching layers, and the ranking algorithm implementation."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the backend-specific requirements:

1. **Feed Generation API**: Serve personalized content from friends and followed pages
2. **Post Ingestion**: Handle high-throughput post creation with validation
3. **Fan-out Service**: Distribute posts to followers' feeds efficiently
4. **Ranking Engine**: Order posts by relevance using engagement and affinity scores
5. **Engagement Aggregation**: Track likes, comments, shares with real-time counters
6. **Social Graph Integration**: Query relationships for feed construction"

### Non-Functional Requirements

"For a news feed backend at Facebook scale:

- **Throughput**: 115,000 posts/second, 230,000 feed reads/second
- **Latency**: Feed generation < 200ms p95, post creation < 100ms p95
- **Availability**: 99.99% uptime for feed reads
- **Consistency**: Eventual consistency for feeds (5-10 second propagation)
- **Durability**: Zero data loss for posts and engagement data"

---

## Step 2: Scale Estimation

"Let me work through the backend capacity requirements:

**Write Load:**
- 2B DAU x 5 posts/day = 10B posts/day
- ~115,000 posts/second peak
- Average post size: 1KB = 115 MB/s write throughput

**Read Load:**
- 2B DAU x 10 feed loads/day = 20B feed requests/day
- ~230,000 feed requests/second
- Each request fetches ~50 posts with metadata

**The Fan-out Challenge:**
- Celebrity with 10M followers posts
- Naive push: 10M cache writes per post
- 100 celebrities posting hourly = 1B writes/hour
- This is unsustainable with pure push model

**Storage Requirements:**
- Posts: 10B/day x 1KB = 10TB/day raw
- With replication (3x) and indexes: ~50TB/day
- Feed cache per user: 1000 post IDs x 16 bytes = 16KB
- 2B users x 16KB = 32TB feed cache"

---

## Step 3: High-Level Backend Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API Gateway / Load Balancer                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
         ▼                            ▼                            ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│  Post Service   │        │  Feed Service   │        │ Ranking Service │
│  (Write Path)   │        │  (Read Path)    │        │   (ML Model)    │
└────────┬────────┘        └────────┬────────┘        └────────┬────────┘
         │                          │                          │
         ▼                          │                          │
┌─────────────────┐                 │                          │
│  Kafka Queue    │                 │                          │
│(Post Events)    │                 │                          │
└────────┬────────┘                 │                          │
         │                          │                          │
         ▼                          ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Fan-out Service (Workers)                          │
│                    Push to regular users, Index celebrities                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
         ▼                            ▼                            ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│  Feed Cache     │        │   Post Store    │        │  Social Graph   │
│  (Redis Cluster)│        │  (Cassandra)    │        │   (Neo4j/TAO)   │
└─────────────────┘        └─────────────────┘        └─────────────────┘
```

---

## Step 4: Database Schema Design

### Posts Table (Cassandra)

"Cassandra is ideal for high-write throughput with time-ordered data:

```cql
-- Posts by author for profile views
CREATE TABLE posts_by_user (
    user_id UUID,
    post_id TIMEUUID,
    content TEXT,
    media_ids LIST<UUID>,
    post_type TEXT,          -- 'text', 'image', 'video', 'link'
    privacy TEXT,            -- 'public', 'friends', 'custom'
    like_count COUNTER,
    comment_count COUNTER,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);

-- Posts by ID for direct lookup
CREATE TABLE posts (
    post_id TIMEUUID PRIMARY KEY,
    user_id UUID,
    content TEXT,
    media_ids LIST<UUID>,
    post_type TEXT,
    privacy TEXT,
    engagement_score DOUBLE,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- Fan-out targets (for push model)
CREATE TABLE feed_items (
    user_id UUID,
    post_id TIMEUUID,
    author_id UUID,
    score DOUBLE,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, score, post_id)
) WITH CLUSTERING ORDER BY (score DESC, post_id DESC);
```

### Engagement Tables

```cql
-- Likes with efficient lookup
CREATE TABLE likes (
    post_id TIMEUUID,
    user_id UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (post_id, user_id)
);

-- User's liked posts for unlike detection
CREATE TABLE user_likes (
    user_id UUID,
    post_id TIMEUUID,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);

-- Comments ordered by time
CREATE TABLE comments (
    post_id TIMEUUID,
    comment_id TIMEUUID,
    user_id UUID,
    content TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (post_id, comment_id)
) WITH CLUSTERING ORDER BY (comment_id ASC);
```

### Affinity Scores Table

```cql
-- User-to-user affinity for ranking
CREATE TABLE affinity_scores (
    user_id UUID,
    target_user_id UUID,
    score DOUBLE,
    interaction_count INT,
    last_interaction_at TIMESTAMP,
    PRIMARY KEY (user_id, target_user_id)
);
```

---

## Step 5: Hybrid Fan-out Implementation

### Fan-out Service Design

"This is the core architectural decision - handling celebrities differently from regular users:

```python
class FanoutService:
    CELEBRITY_THRESHOLD = 10000  # 10K followers
    BATCH_SIZE = 1000

    async def process_post(self, post_event: dict):
        author_id = post_event['author_id']
        post_id = post_event['post_id']
        created_at = post_event['created_at']

        follower_count = await self.social_graph.get_follower_count(author_id)

        if follower_count >= self.CELEBRITY_THRESHOLD:
            # Celebrity: Store for pull-based retrieval
            await self.handle_celebrity_post(author_id, post_id, created_at)
        else:
            # Regular user: Push to all followers
            await self.handle_regular_post(author_id, post_id, created_at)

    async def handle_celebrity_post(self, author_id, post_id, created_at):
        """Celebrity posts are stored separately and pulled at read time"""
        # Add to celebrity posts index
        await self.redis.zadd(
            f'celebrity_posts:{author_id}',
            {post_id: created_at.timestamp()}
        )
        # Trim to keep only recent 100 posts
        await self.redis.zremrangebyrank(
            f'celebrity_posts:{author_id}', 0, -101
        )

        # Publish for real-time updates to online users
        await self.redis.publish(
            f'celebrity_updates:{author_id}',
            json.dumps({'post_id': post_id, 'created_at': str(created_at)})
        )

    async def handle_regular_post(self, author_id, post_id, created_at):
        """Regular users get pushed to followers"""
        followers = await self.social_graph.get_followers(author_id)

        # Process in batches for efficiency
        for batch in chunks(followers, self.BATCH_SIZE):
            await self.push_to_feeds(batch, post_id, created_at)

    async def push_to_feeds(self, user_ids: list, post_id: str, created_at: datetime):
        """Batch insert into feed caches"""
        pipeline = self.redis.pipeline()

        for user_id in user_ids:
            pipeline.zadd(
                f'feed:{user_id}',
                {post_id: created_at.timestamp()}
            )
            # Keep only most recent 1000 posts
            pipeline.zremrangebyrank(f'feed:{user_id}', 0, -1001)

        await pipeline.execute()

        # Also persist to Cassandra for durability
        await self.cassandra.execute_concurrent([
            self.insert_feed_item(user_id, post_id, created_at)
            for user_id in user_ids
        ])
```

### Kafka Topic Design

```python
# Post events topic configuration
POST_EVENTS_TOPIC = {
    'name': 'post-events',
    'partitions': 256,  # High parallelism
    'replication_factor': 3,
    'config': {
        'retention.ms': 604800000,  # 7 days
        'cleanup.policy': 'delete',
        'compression.type': 'lz4'
    }
}

# Partition by author_id for ordered processing per user
def get_partition(author_id: str) -> int:
    return hash(author_id) % 256
```

---

## Step 6: Feed Retrieval Service

### Feed Aggregation Logic

```python
class FeedService:
    async def get_feed(self, user_id: str, limit: int = 20, cursor: str = None) -> dict:
        # Step 1: Get pre-computed feed from cache
        cached_posts = await self.get_cached_feed(user_id, limit * 3)

        # Step 2: Get celebrities user follows
        followed_celebrities = await self.social_graph.get_followed_celebrities(user_id)

        # Step 3: Fetch recent posts from celebrities (pull model)
        celebrity_posts = await self.get_celebrity_posts(followed_celebrities)

        # Step 4: Merge feeds by timestamp
        all_post_ids = self.merge_feeds(cached_posts, celebrity_posts)

        # Step 5: Fetch full post data
        posts = await self.post_store.batch_get(all_post_ids)

        # Step 6: Filter by privacy
        visible_posts = await self.filter_by_privacy(posts, user_id)

        # Step 7: Apply ranking
        ranked_posts = await self.ranking_service.rank(user_id, visible_posts)

        # Step 8: Apply pagination
        return self.paginate(ranked_posts, limit, cursor)

    async def get_cached_feed(self, user_id: str, limit: int) -> list:
        """Fetch from Redis sorted set"""
        # Try cache first
        cached = await self.redis.zrevrange(f'feed:{user_id}', 0, limit - 1)

        if cached:
            return cached

        # Cache miss: rebuild from Cassandra
        feed_items = await self.cassandra.execute(
            "SELECT post_id FROM feed_items WHERE user_id = ? ORDER BY score DESC LIMIT ?",
            [user_id, limit]
        )

        # Warm cache
        if feed_items:
            pipeline = self.redis.pipeline()
            for item in feed_items:
                pipeline.zadd(f'feed:{user_id}', {item.post_id: item.score})
            pipeline.expire(f'feed:{user_id}', 86400)  # 24 hour TTL
            await pipeline.execute()

        return [item.post_id for item in feed_items]

    async def get_celebrity_posts(self, celebrity_ids: list) -> list:
        """Pull recent posts from celebrities"""
        pipeline = self.redis.pipeline()

        for celeb_id in celebrity_ids:
            pipeline.zrevrange(f'celebrity_posts:{celeb_id}', 0, 10)

        results = await pipeline.execute()

        # Flatten and deduplicate
        all_posts = []
        for posts in results:
            all_posts.extend(posts)

        return list(set(all_posts))
```

### Privacy Filtering

```python
async def filter_by_privacy(self, posts: list, viewer_id: str) -> list:
    """Filter posts based on privacy settings"""
    visible = []

    # Batch check friendships for efficiency
    author_ids = [p.author_id for p in posts]
    friendships = await self.social_graph.batch_check_friends(viewer_id, author_ids)

    for post in posts:
        if post.privacy == 'public':
            visible.append(post)
        elif post.privacy == 'friends':
            if friendships.get(post.author_id, False):
                visible.append(post)
        elif post.privacy == 'custom':
            # Check custom privacy list
            if await self.check_custom_privacy(post.id, viewer_id):
                visible.append(post)

    return visible
```

---

## Step 7: Ranking Algorithm Implementation

### Multi-Stage Ranking Pipeline

```python
class RankingService:
    async def rank(self, user_id: str, posts: list) -> list:
        # Stage 1: Feature extraction
        features = await self.extract_features(user_id, posts)

        # Stage 2: First-pass scoring (lightweight)
        scored_posts = self.first_pass_rank(posts, features)

        # Stage 3: Second-pass ranking (ML model) on top candidates
        top_candidates = scored_posts[:200]
        final_ranked = await self.ml_rank(user_id, top_candidates, features)

        # Stage 4: Diversity injection
        diversified = self.inject_diversity(final_ranked)

        return diversified

    def first_pass_rank(self, posts: list, features: dict) -> list:
        """Lightweight scoring for initial filtering"""
        scored = []

        for post in posts:
            score = self.calculate_base_score(post, features)
            scored.append((post, score))

        return sorted(scored, key=lambda x: x[1], reverse=True)

    def calculate_base_score(self, post, features: dict) -> float:
        """
        Score formula: engagement * recencyDecay * affinityBoost
        """
        # Engagement score
        engagement = (
            post.like_count * 1.0 +
            post.comment_count * 3.0 +
            post.share_count * 5.0
        )

        # Recency decay (12-hour half-life)
        hours_old = (datetime.utcnow() - post.created_at).total_seconds() / 3600
        recency_decay = 1.0 / (1 + hours_old * 0.08)

        # Affinity boost (from user interactions with author)
        affinity = features.get(f'affinity:{post.author_id}', 0)
        affinity_boost = 1 + min(affinity, 100) / 100

        # Content type preference
        type_multiplier = features.get(f'type_pref:{post.post_type}', 1.0)

        return engagement * recency_decay * affinity_boost * type_multiplier

    async def ml_rank(self, user_id: str, candidates: list, features: dict) -> list:
        """Second-pass ML model for fine-grained ranking"""
        # Prepare feature vectors
        feature_vectors = []
        for post, base_score in candidates:
            vector = {
                'base_score': base_score,
                'post_age_hours': (datetime.utcnow() - post.created_at).total_seconds() / 3600,
                'author_affinity': features.get(f'affinity:{post.author_id}', 0),
                'engagement_rate': post.engagement_rate,
                'post_type': post.post_type,
                'user_session_depth': features.get('session_depth', 0),
                'time_of_day': datetime.utcnow().hour,
                'is_close_friend': features.get(f'close_friend:{post.author_id}', False)
            }
            feature_vectors.append((post, vector))

        # Call ML model service
        predictions = await self.ml_model.predict_batch([v for _, v in feature_vectors])

        # Combine predictions into final score
        final_scores = []
        for i, (post, _) in enumerate(feature_vectors):
            pred = predictions[i]
            # Weighted combination of predicted actions
            final_score = (
                pred['p_like'] * 1.0 +
                pred['p_comment'] * 2.0 +
                pred['p_share'] * 3.0 -
                pred['p_hide'] * 5.0
            )
            final_scores.append((post, final_score))

        return sorted(final_scores, key=lambda x: x[1], reverse=True)

    def inject_diversity(self, posts: list) -> list:
        """Prevent too many posts from same author"""
        result = []
        author_counts = {}
        MAX_PER_AUTHOR = 2

        for post, score in posts:
            author_id = post.author_id
            if author_counts.get(author_id, 0) < MAX_PER_AUTHOR:
                result.append(post)
                author_counts[author_id] = author_counts.get(author_id, 0) + 1

        return result
```

---

## Step 8: Engagement Aggregation Service

### Real-time Counter Management

```python
class EngagementService:
    async def like_post(self, user_id: str, post_id: str) -> bool:
        # Check for duplicate like (idempotency)
        already_liked = await self.redis.sismember(f'likes:{post_id}', user_id)
        if already_liked:
            return False

        # Atomic operations
        pipeline = self.redis.pipeline()

        # Add to likes set
        pipeline.sadd(f'likes:{post_id}', user_id)

        # Increment counter
        pipeline.incr(f'like_count:{post_id}')

        # Add to user's liked posts (for unlike)
        pipeline.zadd(f'user_likes:{user_id}', {post_id: time.time()})

        await pipeline.execute()

        # Queue for persistence and analytics
        await self.kafka.send('engagement-events', {
            'type': 'like',
            'user_id': user_id,
            'post_id': post_id,
            'timestamp': datetime.utcnow().isoformat()
        })

        # Update affinity score
        post = await self.post_store.get(post_id)
        await self.affinity_service.record_interaction(
            user_id, post.author_id, 'like', weight=2.0
        )

        return True

    async def get_engagement_counts(self, post_ids: list) -> dict:
        """Batch fetch engagement counts"""
        pipeline = self.redis.pipeline()

        for post_id in post_ids:
            pipeline.get(f'like_count:{post_id}')
            pipeline.get(f'comment_count:{post_id}')
            pipeline.get(f'share_count:{post_id}')

        results = await pipeline.execute()

        counts = {}
        for i, post_id in enumerate(post_ids):
            counts[post_id] = {
                'likes': int(results[i*3] or 0),
                'comments': int(results[i*3+1] or 0),
                'shares': int(results[i*3+2] or 0)
            }

        return counts
```

### Counter Persistence Worker

```python
class CounterSyncWorker:
    """Syncs Redis counters to Cassandra periodically"""

    async def run(self):
        while True:
            await self.sync_batch()
            await asyncio.sleep(60)  # Every minute

    async def sync_batch(self):
        # Get dirty counters
        dirty_posts = await self.redis.smembers('dirty_counters')

        for post_id in dirty_posts:
            counts = await self.get_current_counts(post_id)

            # Update Cassandra
            await self.cassandra.execute(
                """
                UPDATE posts SET
                    like_count = ?,
                    comment_count = ?,
                    share_count = ?
                WHERE post_id = ?
                """,
                [counts['likes'], counts['comments'], counts['shares'], post_id]
            )

        # Clear dirty set
        await self.redis.delete('dirty_counters')
```

---

## Step 9: Affinity Scoring System

```python
class AffinityService:
    DECAY_FACTOR = 0.1  # Per day decay

    async def record_interaction(self, user_id: str, target_id: str,
                                  interaction_type: str, weight: float):
        """Update affinity score based on interaction"""
        key = f'affinity:{user_id}:{target_id}'

        # Get current score
        current = await self.redis.hgetall(key)

        # Calculate new score with time decay
        old_score = float(current.get('score', 0))
        last_update = current.get('last_update')

        if last_update:
            days_since = (datetime.utcnow() - datetime.fromisoformat(last_update)).days
            old_score *= (1 - self.DECAY_FACTOR) ** days_since

        # Add new interaction weight
        new_score = old_score + self.get_weight(interaction_type) * weight
        new_score = min(new_score, 100)  # Cap at 100

        # Store
        await self.redis.hset(key, mapping={
            'score': new_score,
            'last_update': datetime.utcnow().isoformat(),
            'interaction_count': int(current.get('interaction_count', 0)) + 1
        })

        # Also update sorted set for quick lookup
        await self.redis.zadd(
            f'affinities:{user_id}',
            {target_id: new_score}
        )

    def get_weight(self, interaction_type: str) -> float:
        weights = {
            'message': 10.0,
            'comment': 5.0,
            'like': 2.0,
            'view_profile': 1.0,
            'share': 8.0
        }
        return weights.get(interaction_type, 1.0)

    async def get_top_affinities(self, user_id: str, limit: int = 100) -> dict:
        """Get users with highest affinity scores"""
        return await self.redis.zrevrange(
            f'affinities:{user_id}',
            0, limit - 1,
            withscores=True
        )
```

---

## Step 10: Caching Strategy

### Multi-Level Cache Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  L1: Application Cache (Local Memory) - Per Instance                        │
│  - Hot posts data (LRU, 1000 entries, 5 min TTL)                           │
│  - Session tokens (256 entries, 1 hour TTL)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  L2: Distributed Cache (Redis Cluster)                                       │
│  - Pre-computed feeds (sorted sets, 24h TTL)                                │
│  - Celebrity posts (sorted sets, no TTL, pruned by count)                   │
│  - Engagement counters (strings, no TTL)                                    │
│  - Affinity scores (sorted sets, 7d TTL)                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  L3: Database (Cassandra)                                                    │
│  - Posts, Users, Relationships (source of truth)                            │
│  - Feed items (backup for cache misses)                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Redis Cluster Configuration

```python
# Redis cluster sharding by user_id
REDIS_CLUSTER = {
    'startup_nodes': [
        {'host': 'redis-1', 'port': 6379},
        {'host': 'redis-2', 'port': 6379},
        {'host': 'redis-3', 'port': 6379},
    ],
    'skip_full_coverage_check': True,
    'max_connections': 1000,
    'retry_on_timeout': True
}

# Key patterns and their TTLs
CACHE_CONFIG = {
    'feed:*': {'ttl': 86400, 'type': 'sorted_set'},
    'celebrity_posts:*': {'ttl': None, 'max_size': 100},
    'session:*': {'ttl': 86400, 'type': 'hash'},
    'affinity:*': {'ttl': 604800, 'type': 'hash'},
    'like_count:*': {'ttl': None, 'type': 'string'},
    'likes:*': {'ttl': None, 'type': 'set'}
}
```

---

## Step 11: Database Sharding Strategy

### User-Based Sharding

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Sharding Strategy                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Posts: Shard by author_id                                                  │
│  └─ All posts by a user on same shard                                      │
│  └─ Profile timeline reads hit single shard                                │
│  └─ Hash: murmur3(author_id) % num_shards                                  │
│                                                                              │
│  Feed Items: Shard by user_id                                               │
│  └─ User's entire feed on same shard                                       │
│  └─ Feed reads are single-shard queries                                    │
│                                                                              │
│  Relationships: Shard by user_id                                            │
│  └─ User's social graph co-located                                         │
│  └─ Follower list lookup is single-shard                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Shard Allocation

```python
class ShardRouter:
    NUM_SHARDS = 256

    def get_shard(self, entity_type: str, entity_id: str) -> int:
        """Determine which shard holds this entity"""
        if entity_type == 'post':
            # Posts sharded by author
            author_id = self.get_author_id(entity_id)
            return self.hash(author_id) % self.NUM_SHARDS
        elif entity_type == 'feed':
            return self.hash(entity_id) % self.NUM_SHARDS
        elif entity_type == 'relationship':
            return self.hash(entity_id) % self.NUM_SHARDS
        else:
            raise ValueError(f"Unknown entity type: {entity_type}")

    def hash(self, key: str) -> int:
        """Consistent hashing using murmur3"""
        return mmh3.hash(key, seed=42) & 0xFFFFFFFF
```

---

## Step 12: Real-time Updates Architecture

### Pub/Sub for Online Users

```python
class RealtimeService:
    async def subscribe_to_feed_updates(self, user_id: str, websocket):
        """Subscribe user to their feed updates"""
        # Subscribe to personal feed channel
        await self.pubsub.subscribe(f'feed_updates:{user_id}')

        # Subscribe to celebrity channels user follows
        celebrities = await self.social_graph.get_followed_celebrities(user_id)
        for celeb_id in celebrities:
            await self.pubsub.subscribe(f'celebrity_updates:{celeb_id}')

        # Listen and forward to WebSocket
        async for message in self.pubsub.listen():
            if message['type'] == 'message':
                await websocket.send(message['data'])

    async def publish_new_post(self, author_id: str, post_id: str):
        """Notify online followers of new post"""
        follower_count = await self.social_graph.get_follower_count(author_id)

        if follower_count >= 10000:
            # Celebrity: Single channel
            await self.redis.publish(
                f'celebrity_updates:{author_id}',
                json.dumps({'type': 'new_post', 'post_id': post_id})
            )
        else:
            # Regular user: Fan out to online followers only
            online_followers = await self.get_online_followers(author_id)
            for follower_id in online_followers:
                await self.redis.publish(
                    f'feed_updates:{follower_id}',
                    json.dumps({'type': 'new_post', 'post_id': post_id})
                )
```

---

## Step 13: Failure Handling and Resilience

### Circuit Breaker Implementation

```python
from circuitbreaker import circuit

class FeedCircuitBreaker:
    def __init__(self):
        self.failure_count = 0
        self.state = 'CLOSED'
        self.last_failure_time = None
        self.threshold = 5
        self.reset_timeout = 30  # seconds

    @circuit(failure_threshold=5, recovery_timeout=30)
    async def generate_feed(self, user_id: str, limit: int):
        """Feed generation with circuit breaker"""
        try:
            return await self._do_generate_feed(user_id, limit)
        except Exception as e:
            self.record_failure()
            raise

    async def fallback_feed(self, user_id: str, limit: int):
        """Fallback when circuit is open"""
        # Return popular posts as degraded experience
        return await self.get_popular_posts(limit)
```

### Idempotency for Post Creation

```python
class PostCreationService:
    async def create_post(self, user_id: str, content: str,
                          idempotency_key: str) -> dict:
        """Idempotent post creation"""
        # Check if already processed
        cache_key = f'idempotency:{user_id}:{idempotency_key}'
        cached = await self.redis.get(cache_key)

        if cached:
            return json.loads(cached)

        # Create post
        post = await self._do_create_post(user_id, content)

        # Cache response
        await self.redis.setex(
            cache_key,
            86400,  # 24 hour TTL
            json.dumps(post)
        )

        return post
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| **Fan-out** | Hybrid (push/pull) | Pure push or pull | Handles celebrities without write amplification |
| **Post Storage** | Cassandra | PostgreSQL | Better write throughput at scale |
| **Feed Cache** | Redis Cluster | Memcached | Sorted sets perfect for ranked feeds |
| **Queue** | Kafka | RabbitMQ | Higher throughput, replay capability |
| **Ranking** | Multi-stage ML | Simple formula | Balances latency and quality |
| **Sharding** | User-based | Post-based | Co-locates related data for reads |
| **Counters** | Redis + async persist | Direct DB | Handles high-frequency updates |

---

## Future Enhancements

1. **ML Ranking Service**: Deploy dedicated TensorFlow Serving for second-pass ranking
2. **Feature Store**: Centralized feature computation for ranking consistency
3. **A/B Testing Framework**: Support multiple ranking algorithms simultaneously
4. **Read Replicas**: Geographic distribution for lower latency
5. **Edge Caching**: Push popular celebrity posts to CDN edge nodes
6. **Bloom Filters**: Reduce database lookups for "already seen" posts
7. **Write-Behind Cache**: Improve write latency with async persistence

---

## Summary

"For the Facebook News Feed backend:

1. **Hybrid Fan-out**: Push for regular users (< 10K followers), pull for celebrities to avoid write amplification
2. **Cassandra for Posts**: High write throughput with time-ordered clustering
3. **Redis for Feed Cache**: Sorted sets enable efficient ranked retrieval with O(log N) insertions
4. **Multi-stage Ranking**: Lightweight first pass filters 1000 to 200, ML model for final ranking
5. **Affinity Scoring**: Track user interactions to personalize feed ordering
6. **Circuit Breakers**: Graceful degradation when dependencies fail
7. **Kafka for Events**: Decouples post creation from fan-out for scalability

The key backend insight is that the celebrity problem requires fundamentally different handling - you cannot push to 10 million feeds for every celebrity post. The hybrid approach lets us optimize both paths independently."

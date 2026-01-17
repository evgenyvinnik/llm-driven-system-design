# Facebook Post Search - System Design Interview Answer

## Opening Statement

"Today I'll design a search engine for Facebook posts. This is an interesting challenge because we need to handle massive scale, real-time indexing, privacy-aware search results, and personalized ranking - all while maintaining sub-second latency for billions of users."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

Let me confirm what we're building:

1. **Full-text search** - Users can search for posts by keywords, phrases, hashtags
2. **Filtering** - Filter by date range, author, post type (text, photo, video, link)
3. **Privacy-aware results** - Only show posts the searcher has permission to see
4. **Personalized ranking** - Prioritize results from friends, popular posts, recent content
5. **Real-time indexing** - New posts should be searchable within seconds
6. **Typeahead suggestions** - Autocomplete as users type

### Non-Functional Requirements

- **Scale**: 2+ billion users, 500M+ posts per day, 10B+ searches per day
- **Latency**: < 200ms p99 for search results
- **Availability**: 99.99% uptime - search is core functionality
- **Freshness**: Posts searchable within 5 seconds of creation
- **Consistency**: Eventual consistency acceptable; privacy must be strongly consistent

### Out of Scope

- Comment search (could discuss as extension)
- Marketplace search (separate system)
- Ad targeting based on search

---

## Step 2: Scale Estimation (2-3 minutes)

Let's size this system:

**Traffic:**
- 2 billion DAU
- Average 5 searches per user per day = 10 billion searches/day
- Peak QPS: 10B / 86,400 * 3 (peak multiplier) = ~350K searches/second

**Indexing:**
- 500 million new posts per day
- Average post size: 500 bytes text + metadata = 1KB indexed
- Daily index growth: 500GB/day
- Need to index ~6K posts/second

**Storage:**
- Keep searchable index for 5 years = 900TB+ of index data
- Need sharding strategy from day one

**Key insight**: This is a read-heavy system (searches >> writes), but writes need to be indexed in near-real-time.

---

## Step 3: High-Level Architecture (10 minutes)

Let me draw out the main components:

```
                                   ┌─────────────────┐
                                   │   Load Balancer │
                                   └────────┬────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
           ┌────────▼────────┐    ┌────────▼────────┐    ┌────────▼────────┐
           │  Search Service │    │  Search Service │    │  Search Service │
           └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
                    │                       │                       │
                    └───────────────────────┼───────────────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              │                             │                             │
     ┌────────▼────────┐          ┌────────▼────────┐          ┌────────▼────────┐
     │  Query Parser   │          │  Privacy Filter │          │  Ranking Service│
     └────────┬────────┘          └────────┬────────┘          └────────┬────────┘
              │                             │                             │
              └─────────────────────────────┼─────────────────────────────┘
                                            │
                                   ┌────────▼────────┐
                                   │   Index Router  │
                                   └────────┬────────┘
                                            │
           ┌────────────────────────────────┼────────────────────────────────┐
           │                                │                                │
  ┌────────▼────────┐              ┌────────▼────────┐              ┌────────▼────────┐
  │  Index Shard 1  │              │  Index Shard 2  │              │  Index Shard N  │
  │  (Elasticsearch)│              │  (Elasticsearch)│              │  (Elasticsearch)│
  └─────────────────┘              └─────────────────┘              └─────────────────┘

                                   ┌─────────────────┐
                                   │  Indexing Pipeline │
                                   └────────┬────────┘
                                            │
  ┌─────────────────┐              ┌────────▼────────┐              ┌─────────────────┐
  │   Post Service  │──────────────│     Kafka       │──────────────│  Index Workers  │
  │   (writes)      │              │                 │              │                 │
  └─────────────────┘              └─────────────────┘              └─────────────────┘
```

### Core Components

1. **Search Service (Stateless)**
   - Receives search queries from clients
   - Orchestrates the search flow
   - Horizontally scalable

2. **Query Parser**
   - Tokenizes and normalizes search queries
   - Handles special syntax (hashtags, mentions, phrases)
   - Spell correction and query expansion

3. **Privacy Filter Service**
   - Critical component - ensures users only see posts they're allowed to
   - Integrates with Facebook's social graph
   - Must be extremely fast (cached heavily)

4. **Ranking Service**
   - Applies personalized ranking based on user's social graph
   - Considers recency, engagement, relevance signals
   - ML-based ranking model

5. **Index Router**
   - Routes queries to appropriate shards
   - Aggregates results from multiple shards
   - Handles shard failures gracefully

6. **Search Index (Elasticsearch Cluster)**
   - Inverted index for full-text search
   - Sharded by post_id hash for even distribution
   - Replicated 3x for availability

7. **Indexing Pipeline**
   - Kafka-based ingestion from post creation events
   - Index workers that transform and index posts
   - Near-real-time (< 5 second lag)

---

## Step 4: Deep Dive - Privacy-Aware Search (8 minutes)

This is the most critical and unique aspect of Facebook search. Let me explain the challenge and solution.

### The Problem

Unlike Google where content is public, Facebook posts have complex visibility rules:
- Public posts (anyone can see)
- Friends-only posts
- Friends-of-friends posts
- Custom lists (specific people)
- Group posts (group members only)

A user searching for "birthday party" should only see:
- Their own posts
- Friends' posts that are visible to them
- Public posts from anyone
- Posts in groups they belong to

### Naive Approach (Why It Fails)

```
1. Search index for "birthday party" → 10 million results
2. For each result, check if user can see it → TOO SLOW
```

Checking permissions for millions of posts per query is impossibly slow.

### Solution: Precomputed Visibility Sets

**Key insight**: Invert the problem. Instead of checking "can user X see post Y?", precompute "which posts can user X see?"

**Implementation:**

1. **Visibility Index**
   - For each post, store a visibility fingerprint
   - Public posts: fingerprint = "PUBLIC"
   - Friends-only: fingerprint = hash(author_id + "FRIENDS")
   - Custom: fingerprint = hash(allowed_user_ids)

2. **User's Visibility Filter**
   - At query time, compute user's visibility set:
     - "PUBLIC"
     - All friend hashes
     - All group membership hashes
   - This is cached in Redis (updates when friendships change)

3. **Query with Visibility Filter**
   ```
   POST /search
   {
     "query": "birthday party",
     "filter": {
       "visibility_fingerprint": ["PUBLIC", "hash1", "hash2", ...]
     }
   }
   ```

**Optimization: Bloom Filters**

For users with thousands of friends, the visibility set is large. We use Bloom filters:
- Compact representation of the visibility set
- Small false positive rate acceptable (we can filter in application layer)
- Reduces query size from thousands of IDs to ~1KB

### Trade-offs

**Pros:**
- Query-time filtering is fast
- Scales to billions of posts

**Cons:**
- Visibility changes require re-indexing (friendship changes)
- Some false positives require secondary filtering

---

## Step 5: Deep Dive - Real-Time Indexing (7 minutes)

Posts need to be searchable within seconds. Here's how we achieve this.

### Indexing Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Post Created │────▶│    Kafka     │────▶│ Index Worker │────▶│ Elasticsearch│
│   Event      │     │   Topic      │     │   Pool       │     │   Index      │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                           │
                           │ Partitioned by
                           │ post_id % N
                           ▼
                     Ordered within partition
```

### Two-Tier Indexing Strategy

1. **Real-Time Index (Hot)**
   - Recent posts (last 24 hours)
   - Stored in memory-optimized Elasticsearch nodes
   - Refresh interval: 1 second
   - Higher cost, lower latency

2. **Historical Index (Warm/Cold)**
   - Older posts
   - Stored on cost-optimized nodes
   - Batched indexing (every 5 minutes)
   - Lower cost, slightly higher latency

### Query Fan-Out

When a user searches, we query both tiers:
- Real-time index: always queried
- Historical index: queried if needed (pagination, low real-time results)

Results are merged with recency weighting.

### Handling Index Lag

If a user creates a post and immediately searches for it:
- We check a "recently created posts" cache
- If post exists in cache but not in search results, inject it
- Ensures users always see their own recent posts

---

## Step 6: Deep Dive - Ranking and Personalization (7 minutes)

### Ranking Signals

We use a two-phase ranking approach:

**Phase 1: Retrieval (in Elasticsearch)**
- BM25 text relevance score
- Recency boost (exponential decay)
- Basic engagement signals (like count, comment count)
- Returns top 1000 candidates

**Phase 2: Re-ranking (ML model)**
- Social proximity (friend, friend-of-friend, following)
- User's historical engagement patterns
- Post quality score
- Diversity signals (avoid duplicate content)
- Returns top 20 for display

### Social Graph Integration

We precompute social features:
```
user_social_features = {
  "close_friends": [user_ids...],      // High weight
  "friends": [user_ids...],            // Medium weight
  "following": [user_ids...],          // Lower weight
  "groups": [group_ids...]
}
```

These are cached and used to boost posts from closer connections.

### Ranking Model

- **Training data**: Historical search clicks, engagement
- **Model**: Gradient boosted trees (XGBoost) for speed
- **Features**: ~200 signals including:
  - Query-post text similarity
  - Author relationship to searcher
  - Post engagement rate
  - Post freshness
  - User's topic preferences

### Cold Start Handling

For new users with no history:
- Fall back to popularity-based ranking
- Geographic relevance (local news, events)
- Gradually incorporate personalization as data accumulates

---

## Step 7: Data Model and Storage (3 minutes)

### Elasticsearch Document Schema

```json
{
  "post_id": "uuid",
  "author_id": "user_uuid",
  "content": "Happy birthday party!",
  "content_normalized": "happy birthday party",
  "hashtags": ["#birthday", "#party"],
  "mentions": ["@friend1"],
  "created_at": "2024-01-15T10:30:00Z",
  "visibility_fingerprint": ["PUBLIC", "hash123"],
  "post_type": "text",
  "engagement_score": 1250,
  "language": "en",
  "location_id": "city_123"
}
```

### Sharding Strategy

- **Primary sharding**: Hash of post_id across 1000 shards
- **Time-based routing**: Recent posts on hot shards
- **Replication**: 3 replicas per shard

### Supporting Databases

- **PostgreSQL**: User data, social graph (source of truth)
- **Redis**: Visibility caches, typeahead suggestions, rate limiting
- **Kafka**: Event streaming for indexing pipeline

---

## Step 8: API Design (2 minutes)

### Search Endpoint

```
POST /api/v1/search
{
  "query": "birthday party",
  "filters": {
    "date_range": {"start": "2024-01-01", "end": "2024-01-31"},
    "post_type": ["text", "photo"],
    "author_ids": ["user123"]
  },
  "pagination": {
    "cursor": "base64_cursor",
    "limit": 20
  }
}

Response:
{
  "results": [
    {
      "post_id": "...",
      "snippet": "Happy <em>birthday</em> <em>party</em>!",
      "author": {...},
      "created_at": "...",
      "relevance_score": 0.95
    }
  ],
  "next_cursor": "...",
  "total_estimate": 1500
}
```

### Typeahead Endpoint

```
GET /api/v1/search/suggestions?q=birth&limit=5

Response:
{
  "suggestions": [
    {"text": "birthday party", "type": "query"},
    {"text": "#birthday", "type": "hashtag"},
    {"text": "Birthday Bash Group", "type": "group"}
  ]
}
```

---

## Step 9: Scalability and Fault Tolerance (3 minutes)

### Scaling Strategy

1. **Search Services**: Stateless, scale horizontally with load
2. **Index Shards**: Add shards as data grows
3. **Index Workers**: Scale with ingestion rate

### Failure Handling

- **Index shard failure**: Replicas serve requests; rebuild failed shard
- **Search service failure**: Load balancer routes to healthy instances
- **Kafka failure**: Buffered writes; replay from offset on recovery
- **Privacy cache miss**: Compute on-demand (slower but correct)

### Circuit Breakers

- Limit concurrent queries per user (rate limiting)
- Timeout slow queries (500ms cutoff)
- Degrade gracefully (return cached/partial results)

---

## Step 10: Trade-offs and Alternatives (2 minutes)

### Key Trade-offs Made

| Decision | Trade-off |
|----------|-----------|
| Precomputed visibility | Faster queries vs. staleness on friendship changes |
| Two-tier indexing | Cost efficiency vs. slight latency increase for old posts |
| Bloom filters | Space efficiency vs. false positive handling |
| Eventual consistency | Performance vs. slight search lag for new posts |

### Alternatives Considered

1. **Solr instead of Elasticsearch**
   - Elasticsearch: Better for real-time, easier scaling
   - Chose ES for operational simplicity

2. **Custom search engine (like Facebook's Unicorn)**
   - Would build if at true Facebook scale
   - Elasticsearch sufficient for interview scope

3. **GraphQL API**
   - Could offer more flexible querying
   - REST simpler for this use case

---

## Closing Summary

"I've designed a Facebook post search system with these key features:

1. **Privacy-aware search** using precomputed visibility fingerprints
2. **Real-time indexing** through Kafka-based pipeline with sub-5-second latency
3. **Personalized ranking** using two-phase retrieval and ML re-ranking
4. **Scalable architecture** handling 350K QPS with Elasticsearch sharding

The main challenges were balancing search speed with privacy correctness, and achieving real-time indexing at massive scale. I'd be happy to dive deeper into any component."

---

## Potential Follow-up Questions

1. **How would you handle search for posts in different languages?**
   - Language detection, language-specific analyzers, query translation

2. **How would you implement trending searches?**
   - Sliding window counters in Redis, anomaly detection for viral topics

3. **How would you handle abuse (searching for spam content)?**
   - Content moderation flags in index, separate spam index, rate limiting

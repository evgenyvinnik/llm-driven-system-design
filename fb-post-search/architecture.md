# Facebook Post Search - Architecture Design

## System Overview

A privacy-aware search engine for social media posts with real-time indexing, personalized ranking, and sub-second latency.

## Requirements

### Functional Requirements

- **Full-text search** - Search posts by keywords, phrases, and hashtags
- **Filtering** - Filter by date range, post type, visibility, and author
- **Privacy-aware results** - Only show posts the searcher has permission to see
- **Personalized ranking** - Prioritize results from friends and engaged content
- **Real-time indexing** - New posts should be searchable immediately
- **Typeahead suggestions** - Autocomplete as users type

### Non-Functional Requirements

- **Scalability**: Designed for 2+ billion users, 500M+ posts per day
- **Availability**: 99.99% uptime target
- **Latency**: < 200ms p99 for search results
- **Consistency**: Eventual consistency for search; strong consistency for privacy

## Capacity Estimation

**Traffic:**
- 2 billion DAU
- Average 5 searches per user per day = 10 billion searches/day
- Peak QPS: ~350K searches/second

**Indexing:**
- 500 million new posts per day
- Average post size: ~1KB indexed
- Daily index growth: ~500GB/day

**Storage:**
- 5-year retention = 900TB+ of index data
- Sharding strategy required from day one

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Load Balancer                              │
└─────────────────────────────────────────────────────────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
   ┌───────▼───────┐       ┌───────▼───────┐       ┌───────▼───────┐
   │Search Service │       │Search Service │       │Search Service │
   │   (Node.js)   │       │   (Node.js)   │       │   (Node.js)   │
   └───────┬───────┘       └───────┬───────┘       └───────┬───────┘
           │                        │                        │
           └────────────────────────┼────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼───────┐          ┌───────▼───────┐          ┌───────▼───────┐
│   PostgreSQL  │          │ Elasticsearch │          │     Redis     │
│  (Users/Posts)│          │   (Search)    │          │   (Cache)     │
└───────────────┘          └───────────────┘          └───────────────┘
```

### Core Components

1. **Search Service (Stateless)**
   - Receives search queries from clients
   - Orchestrates the search flow
   - Applies privacy filtering and ranking
   - Horizontally scalable

2. **PostgreSQL**
   - Source of truth for users, posts, friendships
   - ACID transactions for data integrity
   - Used for auth and user management

3. **Elasticsearch**
   - Full-text search index
   - Stores post documents with visibility fingerprints
   - Handles scoring and highlighting

4. **Redis**
   - Caches user visibility sets
   - Stores session data
   - Tracks trending searches
   - Caches search suggestions

## Data Model

### PostgreSQL Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Posts
CREATE TABLE posts (
  id UUID PRIMARY KEY,
  author_id UUID REFERENCES users(id),
  content TEXT NOT NULL,
  visibility VARCHAR(20) DEFAULT 'friends',
  post_type VARCHAR(20) DEFAULT 'text',
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Friendships
CREATE TABLE friendships (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  friend_id UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Search History
CREATE TABLE search_history (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  query VARCHAR(500) NOT NULL,
  results_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Elasticsearch Document Schema

```json
{
  "post_id": "uuid",
  "author_id": "user_uuid",
  "author_name": "Alice Johnson",
  "content": "Happy birthday party!",
  "hashtags": ["#birthday", "#party"],
  "mentions": ["@friend1"],
  "created_at": "2024-01-15T10:30:00Z",
  "visibility": "friends",
  "visibility_fingerprints": ["PUBLIC", "FRIENDS:user123"],
  "post_type": "text",
  "engagement_score": 125.0,
  "like_count": 50,
  "comment_count": 25,
  "language": "en"
}
```

## API Design

### Core Endpoints

#### Search
```
POST /api/v1/search
{
  "query": "birthday party",
  "filters": {
    "date_range": {"start": "2024-01-01", "end": "2024-12-31"},
    "post_type": ["text", "photo"],
    "visibility": ["public", "friends"]
  },
  "pagination": {"cursor": null, "limit": 20}
}

Response:
{
  "results": [...],
  "next_cursor": "abc123",
  "total_estimate": 1500,
  "took_ms": 45
}
```

#### Suggestions
```
GET /api/v1/search/suggestions?q=birth&limit=5

Response:
{
  "suggestions": [
    {"text": "birthday party", "type": "query"},
    {"text": "#birthday", "type": "hashtag"}
  ]
}
```

## Key Design Decisions

### 1. Privacy-Aware Search with Visibility Fingerprints

The key challenge is filtering search results based on who can see each post.

**Naive Approach (Too Slow):**
1. Search for "birthday party" -> 10 million results
2. For each result, check if user can see it -> O(n) permission checks

**Solution: Precomputed Visibility Fingerprints**

Each post stores visibility fingerprints:
- Public posts: `["PUBLIC"]`
- Friends-only: `["FRIENDS:author_id"]`
- Private: `["PRIVATE:author_id"]`

At query time, we compute the user's visibility set:
- Always includes: `"PUBLIC"`
- Includes: `"PRIVATE:user_id"` (own posts)
- Includes: `"FRIENDS:friend_id"` for each friend

The search query includes a terms filter on visibility_fingerprints, which Elasticsearch handles efficiently.

### 2. Personalized Ranking

**Two-Phase Ranking:**

1. **Elasticsearch (Retrieval):**
   - BM25 text relevance
   - Recency boost (exponential decay)
   - Engagement score boost

2. **Application Layer (Re-ranking):**
   - Friend relationship boosting
   - Social proximity signals
   - User's historical preferences

### 3. Real-Time Indexing

Posts are indexed immediately upon creation:
1. POST /api/v1/posts creates post in PostgreSQL
2. Immediately indexes to Elasticsearch with refresh=true
3. Post is searchable within milliseconds

For production scale, we'd use an event-driven pipeline with Kafka.

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application** | Node.js + Express | Fast development, async I/O, TypeScript support |
| **Database** | PostgreSQL 16 | ACID, relational data, JSON support |
| **Search** | Elasticsearch 8.11 | Full-text search, relevance scoring, horizontal scaling |
| **Cache** | Redis 7 | Fast key-value, TTL support, sorted sets for trending |
| **Frontend** | React 19 + Vite | Modern React features, fast development |
| **State** | Zustand | Simple, minimal boilerplate |
| **Routing** | TanStack Router | Type-safe routing |
| **Styling** | Tailwind CSS | Utility-first, fast iteration |

## Scalability Considerations

### Horizontal Scaling

1. **Search Services**: Stateless, add more instances behind load balancer
2. **Elasticsearch**: Add shards and replicas as data grows
3. **PostgreSQL**: Read replicas for query scaling
4. **Redis**: Cluster mode for cache distribution

### Data Partitioning

- **Posts**: Hash by post_id across Elasticsearch shards
- **Time-based**: Hot/cold tiers (recent posts on faster nodes)
- **Geographic**: Regional clusters for lower latency

## Trade-offs and Alternatives

| Decision | Trade-off |
|----------|-----------|
| Visibility fingerprints | Faster queries vs. re-indexing on relationship changes |
| Immediate indexing | Real-time search vs. potential consistency lag |
| Redis for suggestions | Fast typeahead vs. additional infrastructure |
| Session-based auth | Simplicity vs. JWT scalability |

### Alternatives Considered

1. **Solr vs Elasticsearch**: Chose ES for better real-time indexing and operational simplicity
2. **MongoDB vs PostgreSQL**: Chose PG for relational data (friendships) and ACID guarantees
3. **Memcached vs Redis**: Chose Redis for data structures (sorted sets, pub/sub)

## Monitoring and Observability

**Key Metrics to Track:**
- Search latency (p50, p95, p99)
- Indexing lag (time from post creation to searchable)
- Cache hit rates (visibility sets, suggestions)
- Elasticsearch cluster health
- Query throughput by endpoint

**Alerting:**
- Search latency > 500ms
- Elasticsearch cluster yellow/red
- Redis connection failures
- Error rate > 1%

## Security Considerations

1. **Authentication**: Session-based with Redis, secure cookie storage
2. **Authorization**: Role-based (user vs admin), post ownership checks
3. **Input Validation**: Zod schemas for request validation
4. **Rate Limiting**: IP-based limiting on search endpoints
5. **SQL Injection**: Parameterized queries throughout

## Future Optimizations

1. **Bloom Filters**: Compact visibility set representation
2. **Two-Tier Indexing**: Hot (memory) / Cold (disk) separation
3. **ML Ranking**: Gradient boosted trees for personalization
4. **Query Caching**: Cache popular search results
5. **Federated Search**: Merge results from multiple data centers
6. **Content Moderation**: Flag and filter inappropriate content in search

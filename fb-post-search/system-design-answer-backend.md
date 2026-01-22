# Facebook Post Search - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

### 1. Requirements Clarification (3 minutes)

**Functional Requirements:**
- Full-text search across billions of posts
- Privacy-aware filtering (only show posts user is authorized to see)
- Personalized ranking based on social graph and engagement
- Real-time indexing of new posts
- Search suggestions and typeahead
- Filters: date range, post type, author

**Non-Functional Requirements:**
- Search latency: P99 < 200ms
- Indexing latency: < 30 seconds from post creation
- Privacy: Zero unauthorized content leakage
- Scale: 3 billion users, 500 billion posts, 10M searches/second

**Backend Focus Areas:**
- Elasticsearch cluster design and indexing pipeline
- Privacy-aware visibility fingerprints
- Two-phase ranking architecture
- Caching strategies for visibility sets
- Real-time indexing via Kafka

---

### 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Search Flow                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Client ──▶ API Gateway ──▶ Search Service ──▶ Query Parser ──▶ Elasticsearch│
│                                    │                              │          │
│                            Visibility Filter ◀──── Redis (Visibility Cache) │
│                                    │                                         │
│                            Ranking Service ──▶ ML Re-ranker ──▶ Response    │
├─────────────────────────────────────────────────────────────────────────────┤
│                            Indexing Flow                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Post Service ──▶ Kafka ──▶ Indexing Workers ──▶ Visibility Compute ──▶ ES  │
│                                    │                                         │
│                      PostgreSQL (Social Graph) ──▶ Fingerprint Generator    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Core Components:**
1. **Search Service**: Query parsing, coordination, response assembly
2. **Elasticsearch Cluster**: Full-text search with BM25 scoring
3. **Visibility Service**: Computes and caches what users can see
4. **Indexing Pipeline**: Kafka-based real-time document processing
5. **Ranking Service**: Two-phase ranking with ML re-ranking
6. **PostgreSQL**: Social graph, user data, search history

---

### 3. Backend Deep-Dives

#### Deep-Dive A: Elasticsearch Index Design (8 minutes)

**Document Schema:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        PostDocument Structure                            │
├─────────────────────────────────────────────────────────────────────────┤
│  Core Fields:                                                            │
│  ├── post_id, author_id (identifiers)                                   │
│  ├── content, content_ngrams (text + typeahead)                         │
│  ├── hashtags[], mentions[] (extracted entities)                        │
│  ├── post_type: 'text' | 'photo' | 'video' | 'link'                    │
│  ├── visibility: 'public' | 'friends' | 'friends_of_friends' | 'custom'│
│  └── created_at, updated_at (timestamps)                                │
├─────────────────────────────────────────────────────────────────────────┤
│  Privacy Fields:                                                         │
│  └── visibility_fingerprints[] ◀── Precomputed visibility tokens        │
├─────────────────────────────────────────────────────────────────────────┤
│  Ranking Signals:                                                        │
│  ├── engagement_score (computed)                                        │
│  ├── like_count, comment_count, share_count                             │
│  └── author_name, author_verified (denormalized)                        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Index Settings:**
- number_of_shards: 1000 (for horizontal scaling)
- number_of_replicas: 2 (for availability)
- content_analyzer: standard tokenizer + lowercase + stop + snowball filters
- ngram_analyzer: edge_ngram tokenizer (2-15 chars) for typeahead

**Sharding Strategy:**

1. **Route by post_id hash** for even distribution across 1000 shards
2. **Time-based index naming** for Index Lifecycle Management:
   - Posts <= 60 days: `posts-hot`
   - Posts <= 2 years: `posts-warm`
   - Posts > 2 years: `posts-cold`

**Index Lifecycle Management (ILM) Phases:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ILM Policy Phases                                │
├─────────────────────────────────────────────────────────────────────────┤
│  HOT (0-60 days):                                                        │
│  ├── rollover at 60 days or 50GB                                        │
│  └── priority: 100                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  WARM (60 days - 2 years):                                              │
│  ├── shrink to 100 shards                                               │
│  ├── forcemerge to 1 segment                                            │
│  └── priority: 50                                                        │
├─────────────────────────────────────────────────────────────────────────┤
│  COLD (2-5 years):                                                       │
│  ├── searchable snapshot                                                 │
│  └── priority: 0                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  DELETE (> 5 years):                                                     │
│  └── remove from index                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

#### Deep-Dive B: Privacy-Aware Visibility System (8 minutes)

**Visibility Fingerprint Types:**
- `PUBLIC` - visible to everyone
- `AUTHOR:{userId}` - author always sees own posts
- `FRIENDS:{authorId}` - friends of author can see
- `FOF:{authorId}` - friends-of-friends can see
- `CUSTOM:{postId}:{userId}` - specific users in custom list

**Computing Post Fingerprints (during indexing):**

1. Always add `AUTHOR:{author_id}`
2. For public posts: add `PUBLIC`
3. For friends-only: add `FRIENDS:{author_id}`
4. For friends-of-friends: add `FOF:{author_id}`
5. For custom lists: add `CUSTOM:{post_id}:{user_id}` for each allowed user

**Computing User Visibility Set (during search):**

1. Check Redis cache first (`visibility:{userId}`)
2. If cache miss, build set:
   - Add `PUBLIC` and `AUTHOR:{userId}`
   - Query friendships table for direct friends, add `FRIENDS:{friendId}` for each
   - Query for friends-of-friends, add `FOF:{fofId}` for each
3. Cache result for 5 minutes with SADD + EXPIRE

**Cache Invalidation on Friendship Change:**

1. Delete user's visibility cache
2. Delete visibility cache for all user's friends (affects FOF calculations)
3. Publish re-index event for user's posts

**Friends-of-Friends Query:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      FOF Query Logic                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Get direct friends from friendships table                           │
│  2. For each friend, get their friends                                  │
│  3. Exclude: the user themselves, direct friends                        │
│  4. Return distinct set of FOF user IDs                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

**Bloom Filter Optimization:**

For users with very large visibility sets:
- BITS_PER_USER: 10,000
- HASH_FUNCTIONS: 7
- False positives possible (require verification)
- Compact representation for network transfer

---

#### Deep-Dive C: Real-Time Indexing Pipeline (8 minutes)

**Kafka Topics:**

| Topic | Purpose |
|-------|---------|
| posts.created | New post events |
| posts.updated | Post content edits |
| posts.deleted | Post deletion events |
| visibility.changed | Privacy setting changes |
| friendships.changed | Friend add/remove events |
| posts.reindex | Manual re-indexing requests |

**Indexing Worker Flow:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Indexing Worker Process                               │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Subscribe to all relevant Kafka topics                              │
│  2. For each message:                                                    │
│     ├── posts.created → handlePostCreated()                             │
│     ├── posts.updated → handlePostUpdated()                             │
│     ├── posts.deleted → handlePostDeleted()                             │
│     ├── visibility.changed → handleVisibilityChanged()                  │
│     └── posts.reindex → handleReindexRequest()                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**handlePostCreated Details:**

1. Fetch full post data from database
2. Compute visibility fingerprints via VisibilityService
3. Extract hashtags and mentions from content
4. Build PostDocument with all fields
5. Determine target index (hot/warm/cold based on age)
6. Index to Elasticsearch with `refresh: 'wait_for'` (searchable within 1 second)
7. Increment indexedPostsCounter metric

**handleVisibilityChanged Details:**

1. Fetch post with updated visibility setting
2. Recompute visibility fingerprints
3. Update document in Elasticsearch with new fingerprints and updated_at

**handleReindexRequest Details:**

1. Query all posts by affected user where visibility is 'friends' or 'friends_of_friends'
2. For each post, trigger handlePostUpdated to refresh fingerprints

**Engagement Score Updater:**

Runs every 60 seconds to update engagement signals:
1. Query posts with recent engagement changes (last hour)
2. Compute engagement_score = (likes * 1) + (comments * 3) + (shares * 5)
3. Bulk update to Elasticsearch

---

#### Deep-Dive D: Two-Phase Ranking System (7 minutes)

**Phase 1: Elasticsearch Retrieval**

Retrieve top 500 candidates, return top 20 final results.

**Query Building:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   Elasticsearch Query Structure                          │
├─────────────────────────────────────────────────────────────────────────┤
│  must:                                                                   │
│  └── multi_match on content, hashtags, author_name                      │
│      ├── type: best_fields                                              │
│      ├── fuzziness: AUTO                                                │
│      └── field boosts: content^2, hashtags^1.5                          │
├─────────────────────────────────────────────────────────────────────────┤
│  filter:                                                                 │
│  ├── terms: visibility_fingerprints (CRITICAL - privacy)               │
│  ├── range: created_at (if date range specified)                        │
│  └── term: post_type (if type filter specified)                         │
├─────────────────────────────────────────────────────────────────────────┤
│  should (boosting):                                                      │
│  ├── range: created_at > now-7d (boost: 2.0 for recent)                 │
│  └── range: engagement_score > 100 (boost: 1.5)                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Phase 2: ML Re-Ranking**

**Ranking Features:**

| Feature | Description |
|---------|-------------|
| textRelevance | BM25 score from Elasticsearch |
| engagementScore | likes + 3*comments + 5*shares |
| recencyScore | exp(-ageHours / 168) - half-life of 1 week |
| authorAffinityScore | Past interaction history with author |
| socialProximity | 1.0=friend, 0.5=FOF, 0.1=stranger |
| queryMatchType | exact, partial, or semantic match |

**Score Combination:**

Final score = (esScore * 0.3) + (mlScore * 0.4) + (socialProximity * 0.2) + (recencyScore * 0.1)

---

### 4. Data Flow Example

**Search Request Flow:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│              Search: "vacation photos" by user 123                       │
├─────────────────────────────────────────────────────────────────────────┤
│  1. GET /api/search?q=vacation+photos&user_id=123                       │
│                                                                          │
│  2. Search Service:                                                      │
│     ├── Query Parser: normalize, spell-check, extract entities         │
│     ├── Visibility Service: get user's visibility set from Redis       │
│     │   └── Cache miss: compute from PostgreSQL, cache for 5 min       │
│     └── Build ES query with privacy filter                              │
│                                                                          │
│  3. Elasticsearch (Phase 1):                                            │
│     ├── Query hot/warm/cold indices                                     │
│     ├── BM25 scoring on content fields                                  │
│     ├── Filter by visibility_fingerprints                               │
│     └── Return top 500 candidates                                       │
│                                                                          │
│  4. Ranking Service (Phase 2):                                          │
│     ├── Compute features (affinity, recency, engagement)                │
│     ├── ML model predicts relevance scores                              │
│     └── Re-rank and return top 20                                       │
│                                                                          │
│  5. Response Assembly:                                                   │
│     ├── Highlight matching text                                         │
│     ├── Add author profiles                                             │
│     └── Return to client                                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 5. Trade-offs Analysis

| Decision | Pros | Cons |
|----------|------|------|
| Precomputed visibility fingerprints | Fast query-time filtering, single ES query | Visibility changes require re-indexing |
| Two-tier indexing (hot/warm/cold) | Cost-efficient storage, fast recent queries | Cross-tier queries slower |
| Kafka indexing pipeline | Reliable, scalable, decoupled | Adds 5-30s latency to searchability |
| Redis visibility cache | Sub-ms lookup, reduces DB load | Cache invalidation complexity |
| Two-phase ranking | Combines speed of ES with ML quality | Extra latency (~50ms for ML) |
| Bloom filters for large visibility sets | Compact representation, fast checks | False positives require verification |

---

### 6. Failure Modes and Mitigation

**Circuit Breaker Configuration:**
- failureThreshold: 5 consecutive failures
- recoveryTimeout: 30000ms

**Degraded Search Mode:**

When circuit opens or timeout occurs:
1. Skip ML re-ranking, use ES scores only
2. Query only hot index (recent posts)
3. Return cached results if available
4. Fall back to simpleElasticsearchSearch without personalization

---

### 7. Monitoring and Observability

**Key Metrics:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Metrics Dashboard                                │
├─────────────────────────────────────────────────────────────────────────┤
│  Latency:                                                                │
│  ├── search_latency_p50, search_latency_p99                             │
│  └── indexing_latency_seconds                                           │
├─────────────────────────────────────────────────────────────────────────┤
│  Throughput:                                                             │
│  ├── searches_total (per second)                                        │
│  └── indexed_posts_total (per second)                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  Cache:                                                                  │
│  └── visibility_cache_hit_rate                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  Errors:                                                                 │
│  ├── privacy_violations_total (SHOULD ALWAYS BE 0)                      │
│  └── search_errors_total                                                │
├─────────────────────────────────────────────────────────────────────────┤
│  Quality:                                                                │
│  ├── zero_result_rate                                                   │
│  └── click_through_rate                                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 8. Future Enhancements

1. **Semantic Search**: Add vector embeddings for semantic similarity (dense retrieval)
2. **Personalized Typeahead**: User-specific query suggestions based on history
3. **Federated Search**: Search across multiple content types (posts, photos, events)
4. **Real-time Trending**: Detect and boost currently trending topics
5. **Query Understanding**: Intent classification, entity extraction, query rewriting
6. **A/B Testing Infrastructure**: Compare ranking algorithms at scale

---

### Summary

> "The Facebook Post Search backend is built around three key innovations:
>
> 1. **Visibility fingerprints** - Precomputed tokens that enable privacy filtering at query time without per-post permission checks
>
> 2. **Two-phase ranking** - Elasticsearch retrieves 500 candidates with BM25, then ML re-ranks with social signals for top 20
>
> 3. **Kafka indexing pipeline** - Decouples post creation from search indexing with < 30s latency
>
> The main trade-off is between indexing latency and query performance. By precomputing fingerprints, we shift work to index time but achieve sub-200ms P99 search latency with zero privacy leakage."

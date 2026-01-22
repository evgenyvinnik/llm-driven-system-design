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
│  Client → API Gateway → Search Service → Query Parser → Elasticsearch       │
│                              ↓                              ↓                │
│                      Visibility Filter ←──── Redis (Visibility Cache)       │
│                              ↓                                               │
│                      Ranking Service → ML Re-ranker → Response              │
├─────────────────────────────────────────────────────────────────────────────┤
│                            Indexing Flow                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Post Service → Kafka → Indexing Workers → Visibility Compute → ES Index   │
│                              ↓                                               │
│                      PostgreSQL (Social Graph) → Fingerprint Generator      │
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

```typescript
interface PostDocument {
  post_id: string;
  author_id: string;
  content: string;
  content_ngrams: string;        // For typeahead
  hashtags: string[];
  mentions: string[];
  post_type: 'text' | 'photo' | 'video' | 'link';
  visibility: 'public' | 'friends' | 'friends_of_friends' | 'custom';
  visibility_fingerprints: string[];  // Precomputed visibility tokens
  created_at: string;
  updated_at: string;

  // Engagement signals for ranking
  engagement_score: number;
  like_count: number;
  comment_count: number;
  share_count: number;

  // Author metadata (denormalized)
  author_name: string;
  author_verified: boolean;
}
```

**Index Mapping:**

```json
{
  "mappings": {
    "properties": {
      "content": {
        "type": "text",
        "analyzer": "content_analyzer",
        "fields": {
          "exact": { "type": "keyword" }
        }
      },
      "content_ngrams": {
        "type": "text",
        "analyzer": "ngram_analyzer"
      },
      "visibility_fingerprints": {
        "type": "keyword"
      },
      "hashtags": {
        "type": "keyword",
        "normalizer": "lowercase"
      },
      "created_at": {
        "type": "date"
      },
      "engagement_score": {
        "type": "float"
      }
    }
  },
  "settings": {
    "number_of_shards": 1000,
    "number_of_replicas": 2,
    "analysis": {
      "analyzer": {
        "content_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "stop", "snowball"]
        },
        "ngram_analyzer": {
          "type": "custom",
          "tokenizer": "ngram_tokenizer",
          "filter": ["lowercase"]
        }
      },
      "tokenizer": {
        "ngram_tokenizer": {
          "type": "ngram",
          "min_gram": 2,
          "max_gram": 15
        }
      }
    }
  }
}
```

**Sharding Strategy:**

```typescript
class ShardRouter {
  private readonly SHARD_COUNT = 1000;

  // Route by post_id for even distribution
  getShardForPost(postId: string): number {
    return this.consistentHash(postId) % this.SHARD_COUNT;
  }

  // Time-based index naming for ILM
  getIndexName(createdAt: Date): string {
    const age = Date.now() - createdAt.getTime();
    const daysSinceCreation = age / (1000 * 60 * 60 * 24);

    if (daysSinceCreation <= 60) return 'posts-hot';
    if (daysSinceCreation <= 730) return 'posts-warm';
    return 'posts-cold';
  }

  private consistentHash(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}
```

**Index Lifecycle Management (ILM):**

```json
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0d",
        "actions": {
          "rollover": {
            "max_age": "60d",
            "max_size": "50gb"
          },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "60d",
        "actions": {
          "shrink": { "number_of_shards": 100 },
          "forcemerge": { "max_num_segments": 1 },
          "set_priority": { "priority": 50 }
        }
      },
      "cold": {
        "min_age": "730d",
        "actions": {
          "searchable_snapshot": {
            "snapshot_repository": "posts-snapshots"
          },
          "set_priority": { "priority": 0 }
        }
      },
      "delete": {
        "min_age": "1825d",
        "actions": { "delete": {} }
      }
    }
  }
}
```

---

#### Deep-Dive B: Privacy-Aware Visibility System (8 minutes)

**Visibility Fingerprint Computation:**

```typescript
interface VisibilityFingerprint {
  type: 'PUBLIC' | 'FRIENDS' | 'FOF' | 'CUSTOM' | 'AUTHOR';
  identifier: string;
}

class VisibilityService {
  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly bloomFilter: BloomFilterService
  ) {}

  // Compute fingerprints for a post (called during indexing)
  async computePostFingerprints(post: Post): Promise<string[]> {
    const fingerprints: string[] = [];

    // Author always sees their own posts
    fingerprints.push(`AUTHOR:${post.author_id}`);

    switch (post.visibility) {
      case 'public':
        fingerprints.push('PUBLIC');
        break;

      case 'friends':
        fingerprints.push(`FRIENDS:${post.author_id}`);
        break;

      case 'friends_of_friends':
        fingerprints.push(`FOF:${post.author_id}`);
        break;

      case 'custom':
        // Add specific user/list fingerprints
        const allowedUsers = await this.getCustomAllowList(post.id);
        for (const userId of allowedUsers) {
          fingerprints.push(`CUSTOM:${post.id}:${userId}`);
        }
        break;
    }

    return fingerprints;
  }

  // Compute user's visibility set (called during search)
  async getUserVisibilitySet(userId: string): Promise<string[]> {
    const cacheKey = `visibility:${userId}`;

    // Check cache first
    const cached = await this.redis.smembers(cacheKey);
    if (cached.length > 0) {
      return cached;
    }

    const visibilitySet: string[] = ['PUBLIC', `AUTHOR:${userId}`];

    // Friends' posts
    const friends = await this.getFriendIds(userId);
    for (const friendId of friends) {
      visibilitySet.push(`FRIENDS:${friendId}`);
    }

    // Friends-of-friends posts
    const fofSet = await this.getFriendsOfFriends(userId);
    for (const fofId of fofSet) {
      visibilitySet.push(`FOF:${fofId}`);
    }

    // Cache for 5 minutes (friendship changes are infrequent)
    await this.redis.sadd(cacheKey, ...visibilitySet);
    await this.redis.expire(cacheKey, 300);

    return visibilitySet;
  }

  // Invalidate cache on friendship change
  async onFriendshipChange(userId: string): Promise<void> {
    // Invalidate user's cache
    await this.redis.del(`visibility:${userId}`);

    // Also invalidate FOF caches for affected users
    const friends = await this.getFriendIds(userId);
    for (const friendId of friends) {
      await this.redis.del(`visibility:${friendId}`);
    }

    // Publish event for re-indexing affected posts
    await this.publishReindexEvent(userId);
  }

  private async getFriendIds(userId: string): Promise<string[]> {
    const result = await this.db.query(`
      SELECT CASE
        WHEN user_id = $1 THEN friend_id
        ELSE user_id
      END as friend_id
      FROM friendships
      WHERE (user_id = $1 OR friend_id = $1)
        AND status = 'accepted'
    `, [userId]);

    return result.rows.map(r => r.friend_id);
  }

  private async getFriendsOfFriends(userId: string): Promise<Set<string>> {
    const result = await this.db.query(`
      WITH direct_friends AS (
        SELECT CASE
          WHEN user_id = $1 THEN friend_id
          ELSE user_id
        END as friend_id
        FROM friendships
        WHERE (user_id = $1 OR friend_id = $1)
          AND status = 'accepted'
      ),
      fof AS (
        SELECT DISTINCT CASE
          WHEN f.user_id = df.friend_id THEN f.friend_id
          ELSE f.user_id
        END as fof_id
        FROM friendships f
        JOIN direct_friends df ON (f.user_id = df.friend_id OR f.friend_id = df.friend_id)
        WHERE f.status = 'accepted'
      )
      SELECT fof_id FROM fof
      WHERE fof_id != $1
        AND fof_id NOT IN (SELECT friend_id FROM direct_friends)
    `, [userId]);

    return new Set(result.rows.map(r => r.fof_id));
  }
}
```

**Bloom Filter Optimization:**

```typescript
class BloomFilterService {
  private readonly BITS_PER_USER = 10000;
  private readonly HASH_FUNCTIONS = 7;

  // Create compact bloom filter for user's visibility
  async createVisibilityBloomFilter(userId: string): Promise<Buffer> {
    const visibilitySet = await this.visibilityService.getUserVisibilitySet(userId);
    const filter = new BloomFilter(this.BITS_PER_USER, this.HASH_FUNCTIONS);

    for (const fingerprint of visibilitySet) {
      filter.add(fingerprint);
    }

    return filter.toBuffer();
  }

  // Check if post might be visible (false positives possible)
  mightBeVisible(filter: BloomFilter, postFingerprints: string[]): boolean {
    return postFingerprints.some(fp => filter.mightContain(fp));
  }
}
```

---

#### Deep-Dive C: Real-Time Indexing Pipeline (8 minutes)

**Kafka Topic Design:**

```typescript
// Topics
const TOPICS = {
  POST_CREATED: 'posts.created',
  POST_UPDATED: 'posts.updated',
  POST_DELETED: 'posts.deleted',
  VISIBILITY_CHANGED: 'visibility.changed',
  FRIENDSHIP_CHANGED: 'friendships.changed',
  REINDEX_REQUESTED: 'posts.reindex'
};

interface PostCreatedEvent {
  event_type: 'post_created';
  post_id: string;
  author_id: string;
  content: string;
  visibility: string;
  created_at: string;
  metadata: {
    post_type: string;
    hashtags: string[];
    mentions: string[];
  };
}

interface VisibilityChangedEvent {
  event_type: 'visibility_changed';
  post_id: string;
  old_visibility: string;
  new_visibility: string;
}
```

**Indexing Worker:**

```typescript
class IndexingWorker {
  constructor(
    private readonly kafka: Kafka,
    private readonly elasticsearch: Client,
    private readonly visibilityService: VisibilityService,
    private readonly db: Pool
  ) {}

  async start(): Promise<void> {
    const consumer = this.kafka.consumer({ groupId: 'indexing-workers' });
    await consumer.connect();

    await consumer.subscribe({
      topics: [
        TOPICS.POST_CREATED,
        TOPICS.POST_UPDATED,
        TOPICS.POST_DELETED,
        TOPICS.VISIBILITY_CHANGED,
        TOPICS.REINDEX_REQUESTED
      ]
    });

    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        const event = JSON.parse(message.value!.toString());

        switch (topic) {
          case TOPICS.POST_CREATED:
            await this.handlePostCreated(event);
            break;
          case TOPICS.POST_UPDATED:
            await this.handlePostUpdated(event);
            break;
          case TOPICS.POST_DELETED:
            await this.handlePostDeleted(event);
            break;
          case TOPICS.VISIBILITY_CHANGED:
            await this.handleVisibilityChanged(event);
            break;
          case TOPICS.REINDEX_REQUESTED:
            await this.handleReindexRequest(event);
            break;
        }
      }
    });
  }

  private async handlePostCreated(event: PostCreatedEvent): Promise<void> {
    // Fetch full post data
    const post = await this.fetchPostWithAuthor(event.post_id);

    // Compute visibility fingerprints
    const fingerprints = await this.visibilityService.computePostFingerprints(post);

    // Build document
    const document: PostDocument = {
      post_id: post.id,
      author_id: post.author_id,
      content: post.content,
      content_ngrams: post.content,
      hashtags: this.extractHashtags(post.content),
      mentions: this.extractMentions(post.content),
      post_type: post.type,
      visibility: post.visibility,
      visibility_fingerprints: fingerprints,
      created_at: post.created_at,
      updated_at: post.updated_at,
      engagement_score: 0,
      like_count: 0,
      comment_count: 0,
      share_count: 0,
      author_name: post.author.display_name,
      author_verified: post.author.is_verified
    };

    // Index to Elasticsearch
    const indexName = this.shardRouter.getIndexName(new Date(post.created_at));
    await this.elasticsearch.index({
      index: indexName,
      id: post.id,
      document,
      refresh: 'wait_for'  // Ensure searchable within 1 second
    });

    this.metrics.indexedPostsCounter.inc();
  }

  private async handleVisibilityChanged(event: VisibilityChangedEvent): Promise<void> {
    const post = await this.fetchPostWithAuthor(event.post_id);
    const newFingerprints = await this.visibilityService.computePostFingerprints(post);

    await this.elasticsearch.update({
      index: 'posts-*',
      id: event.post_id,
      doc: {
        visibility: event.new_visibility,
        visibility_fingerprints: newFingerprints,
        updated_at: new Date().toISOString()
      }
    });
  }

  private async handleReindexRequest(event: { user_id: string }): Promise<void> {
    // Re-index all posts affected by friendship change
    const posts = await this.db.query(`
      SELECT id FROM posts
      WHERE author_id = $1
        AND visibility IN ('friends', 'friends_of_friends')
    `, [event.user_id]);

    for (const post of posts.rows) {
      await this.handlePostUpdated({ post_id: post.id });
    }
  }
}
```

**Engagement Score Updater:**

```typescript
class EngagementUpdater {
  private readonly BATCH_SIZE = 1000;
  private readonly UPDATE_INTERVAL = 60000; // 1 minute

  async start(): Promise<void> {
    setInterval(() => this.updateEngagementScores(), this.UPDATE_INTERVAL);
  }

  private async updateEngagementScores(): Promise<void> {
    // Fetch posts with recent engagement changes
    const posts = await this.db.query(`
      SELECT
        p.id,
        COUNT(DISTINCT l.id) as like_count,
        COUNT(DISTINCT c.id) as comment_count,
        COUNT(DISTINCT s.id) as share_count
      FROM posts p
      LEFT JOIN likes l ON l.post_id = p.id AND l.created_at > NOW() - INTERVAL '1 hour'
      LEFT JOIN comments c ON c.post_id = p.id AND c.created_at > NOW() - INTERVAL '1 hour'
      LEFT JOIN shares s ON s.post_id = p.id AND s.created_at > NOW() - INTERVAL '1 hour'
      WHERE p.updated_at > NOW() - INTERVAL '1 hour'
      GROUP BY p.id
      LIMIT $1
    `, [this.BATCH_SIZE]);

    const bulkOps = posts.rows.flatMap(post => [
      { update: { _index: 'posts-*', _id: post.id } },
      {
        doc: {
          like_count: post.like_count,
          comment_count: post.comment_count,
          share_count: post.share_count,
          engagement_score: this.calculateEngagementScore(post)
        }
      }
    ]);

    if (bulkOps.length > 0) {
      await this.elasticsearch.bulk({ operations: bulkOps });
    }
  }

  private calculateEngagementScore(post: any): number {
    // Weighted engagement score
    return (post.like_count * 1) +
           (post.comment_count * 3) +
           (post.share_count * 5);
  }
}
```

---

#### Deep-Dive D: Two-Phase Ranking System (7 minutes)

**Phase 1: Elasticsearch Retrieval:**

```typescript
class SearchService {
  private readonly RETRIEVAL_SIZE = 500;
  private readonly RESULT_SIZE = 20;

  async search(query: SearchQuery, userId: string): Promise<SearchResult> {
    const startTime = Date.now();

    // Get user's visibility set
    const visibilitySet = await this.visibilityService.getUserVisibilitySet(userId);

    // Parse and expand query
    const parsedQuery = await this.queryParser.parse(query.text);

    // Build Elasticsearch query
    const esQuery = this.buildElasticsearchQuery(parsedQuery, visibilitySet, query.filters);

    // Execute retrieval (Phase 1)
    const retrievalResults = await this.elasticsearch.search({
      index: 'posts-*',
      size: this.RETRIEVAL_SIZE,
      query: esQuery,
      _source: ['post_id', 'author_id', 'content', 'created_at', 'engagement_score', 'author_name']
    });

    // Re-rank with ML model (Phase 2)
    const rankedResults = await this.rankingService.rerank(
      retrievalResults.hits.hits,
      userId,
      query.text
    );

    // Return top results
    const finalResults = rankedResults.slice(0, this.RESULT_SIZE);

    this.metrics.searchLatencyHistogram.observe(Date.now() - startTime);

    return {
      results: finalResults,
      total: retrievalResults.hits.total,
      took: Date.now() - startTime
    };
  }

  private buildElasticsearchQuery(
    parsed: ParsedQuery,
    visibilitySet: string[],
    filters: SearchFilters
  ): object {
    return {
      bool: {
        must: [
          {
            multi_match: {
              query: parsed.normalized,
              fields: ['content^2', 'hashtags^1.5', 'author_name'],
              type: 'best_fields',
              fuzziness: 'AUTO'
            }
          }
        ],
        filter: [
          // Privacy filter - CRITICAL
          {
            terms: {
              visibility_fingerprints: visibilitySet
            }
          },
          // Date range filter
          ...(filters.dateRange ? [{
            range: {
              created_at: {
                gte: filters.dateRange.start,
                lte: filters.dateRange.end
              }
            }
          }] : []),
          // Post type filter
          ...(filters.postType ? [{
            term: { post_type: filters.postType }
          }] : [])
        ],
        should: [
          // Boost recent posts
          {
            range: {
              created_at: {
                gte: 'now-7d',
                boost: 2.0
              }
            }
          },
          // Boost high engagement
          {
            range: {
              engagement_score: {
                gte: 100,
                boost: 1.5
              }
            }
          }
        ]
      }
    };
  }
}
```

**Phase 2: ML Re-Ranking:**

```typescript
interface RankingFeatures {
  textRelevance: number;      // BM25 score from ES
  engagementScore: number;
  recencyScore: number;
  authorAffinityScore: number;
  socialProximity: number;    // 1=friend, 0.5=FOF, 0.1=stranger
  queryMatchType: string;     // exact, partial, semantic
}

class RankingService {
  constructor(
    private readonly affinityService: AffinityService,
    private readonly mlRanker: MLRankerClient
  ) {}

  async rerank(
    candidates: SearchHit[],
    userId: string,
    queryText: string
  ): Promise<RankedResult[]> {
    // Compute features for each candidate
    const features = await Promise.all(
      candidates.map(hit => this.computeFeatures(hit, userId, queryText))
    );

    // Apply ML model for final scores
    const scores = await this.mlRanker.predict(features);

    // Combine with original scores and sort
    const results = candidates.map((hit, i) => ({
      ...hit._source,
      score: this.combineScores(hit._score, scores[i], features[i])
    }));

    return results.sort((a, b) => b.score - a.score);
  }

  private async computeFeatures(
    hit: SearchHit,
    userId: string,
    queryText: string
  ): Promise<RankingFeatures> {
    const post = hit._source;

    // Get social proximity
    const socialProximity = await this.affinityService.getSocialProximity(
      userId,
      post.author_id
    );

    // Compute recency score (exponential decay)
    const ageHours = (Date.now() - new Date(post.created_at).getTime()) / 3600000;
    const recencyScore = Math.exp(-ageHours / 168); // Half-life of 1 week

    // Author affinity from past interactions
    const authorAffinity = await this.affinityService.getAuthorAffinity(
      userId,
      post.author_id
    );

    return {
      textRelevance: hit._score,
      engagementScore: post.engagement_score,
      recencyScore,
      authorAffinityScore: authorAffinity,
      socialProximity,
      queryMatchType: this.classifyMatchType(queryText, post.content)
    };
  }

  private combineScores(
    esScore: number,
    mlScore: number,
    features: RankingFeatures
  ): number {
    // Weighted combination
    return (
      esScore * 0.3 +
      mlScore * 0.4 +
      features.socialProximity * 0.2 +
      features.recencyScore * 0.1
    );
  }
}
```

---

### 4. Data Flow Example

**Search Request Flow:**

```
1. User types "vacation photos"
   └─→ GET /api/search?q=vacation+photos&user_id=123

2. Search Service
   ├─→ Query Parser: normalize, spell-check, extract entities
   ├─→ Visibility Service: get user's visibility set from Redis
   │   └─→ Cache miss: compute from PostgreSQL, cache for 5 min
   └─→ Build ES query with privacy filter

3. Elasticsearch (Phase 1)
   ├─→ Query hot/warm/cold indices
   ├─→ BM25 scoring on content fields
   ├─→ Filter by visibility_fingerprints
   └─→ Return top 500 candidates

4. Ranking Service (Phase 2)
   ├─→ Compute features (affinity, recency, engagement)
   ├─→ ML model predicts relevance scores
   └─→ Re-rank and return top 20

5. Response Assembly
   ├─→ Highlight matching text
   ├─→ Add author profiles
   └─→ Return to client
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

```typescript
class SearchServiceWithResilience {
  private readonly circuitBreaker: CircuitBreaker;

  constructor() {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeout: 30000
    });
  }

  async search(query: SearchQuery, userId: string): Promise<SearchResult> {
    return this.circuitBreaker.execute(async () => {
      try {
        return await this.doSearch(query, userId);
      } catch (error) {
        if (error.name === 'TimeoutError') {
          // Fall back to simpler query
          return this.degradedSearch(query, userId);
        }
        throw error;
      }
    });
  }

  private async degradedSearch(query: SearchQuery, userId: string): Promise<SearchResult> {
    // Skip ML re-ranking, use ES scores only
    // Query only hot index
    // Return cached results if available
    const cacheKey = `search:${userId}:${query.text}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Simplified ES query without ML
    return this.simpleElasticsearchSearch(query, userId);
  }
}
```

---

### 7. Monitoring and Observability

```typescript
// Key metrics to track
const metrics = {
  // Latency
  searchLatencyP50: new Histogram({ name: 'search_latency_p50' }),
  searchLatencyP99: new Histogram({ name: 'search_latency_p99' }),
  indexingLatency: new Histogram({ name: 'indexing_latency_seconds' }),

  // Throughput
  searchesPerSecond: new Counter({ name: 'searches_total' }),
  indexedPostsPerSecond: new Counter({ name: 'indexed_posts_total' }),

  // Cache
  visibilityCacheHitRate: new Gauge({ name: 'visibility_cache_hit_rate' }),

  // Errors
  privacyViolations: new Counter({ name: 'privacy_violations_total' }), // Should always be 0
  searchErrors: new Counter({ name: 'search_errors_total' }),

  // Quality
  zeroResultRate: new Gauge({ name: 'zero_result_rate' }),
  clickThroughRate: new Gauge({ name: 'ctr' })
};
```

---

### 8. Future Enhancements

1. **Semantic Search**: Add vector embeddings for semantic similarity (dense retrieval)
2. **Personalized Typeahead**: User-specific query suggestions based on history
3. **Federated Search**: Search across multiple content types (posts, photos, events)
4. **Real-time Trending**: Detect and boost currently trending topics
5. **Query Understanding**: Intent classification, entity extraction, query rewriting
6. **A/B Testing Infrastructure**: Compare ranking algorithms at scale

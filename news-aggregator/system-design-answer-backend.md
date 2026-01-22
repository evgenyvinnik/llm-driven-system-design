# News Aggregator - Backend System Design Interview Answer

*A 45-minute system design interview answer focused on backend architecture, databases, crawling, and deduplication algorithms.*

---

## Opening Statement

"Today I'll design the backend for a news aggregator like Google News or Flipboard, focusing on the content ingestion pipeline and data layer. The core backend challenges are: efficiently crawling thousands of RSS feeds with rate limiting, deduplicating articles using SimHash fingerprinting, clustering related stories, building a multi-signal ranking algorithm, and serving personalized feeds with low latency. I'll walk through the database schema, caching strategy, and scalability considerations."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements (Backend Focus)

1. **Content Ingestion Pipeline** - Crawl RSS/Atom feeds from thousands of sources on configurable schedules
2. **Article Deduplication** - Identify near-duplicate articles using SimHash with O(1) comparison
3. **Story Clustering** - Group articles about the same event using fingerprint matching
4. **Topic Extraction** - Classify articles using keyword matching (extensible to ML)
5. **Feed Generation API** - Return personalized feeds with sub-200ms latency
6. **Search API** - Full-text search with Elasticsearch
7. **Breaking News Detection** - Velocity-based detection using sliding window counters

### Non-Functional Requirements

| Requirement | Target | Backend Implication |
|-------------|--------|---------------------|
| Freshness | Breaking news < 5 min | Priority queue for high-velocity sources |
| Latency | Feed API p95 < 200ms | Redis caching with 60s TTL |
| Scale | 100K sources, 10M articles/day | Horizontal crawler scaling, partitioned processing |
| Availability | 99.9% | Graceful degradation, circuit breakers |

### Scale Estimation

```
Content Volume:
- 100,000 news sources
- 100 articles/source/day = 10M articles/day
- Article size: 5KB text + metadata
- Daily ingestion: ~50 GB

Crawling Load:
- 100K sources / 15-min interval = 111 crawls/second
- Distributed across 10 crawlers = 11 crawls/crawler/second

API Load:
- 50M DAU * 5 feed loads = 250M requests/day
- Peak: ~8,700 QPS
```

---

## Step 2: High-Level Backend Architecture (5 minutes)

```
                              ┌─────────────────────────────────────┐
                              │           API Gateway               │
                              │    (Rate Limiting, Auth, Routing)   │
                              └─────────────────┬───────────────────┘
                                                │
              ┌─────────────────────────────────┼─────────────────────────────────┐
              │                                 │                                 │
    ┌─────────▼─────────┐           ┌──────────▼──────────┐           ┌──────────▼──────────┐
    │   Feed Service    │           │   Search Service    │           │   User Service      │
    │                   │           │                     │           │                     │
    │ - Personalization │           │ - Elasticsearch     │           │ - Preferences       │
    │ - Ranking         │           │ - Filters           │           │ - Reading History   │
    └─────────┬─────────┘           └──────────┬──────────┘           └──────────┬──────────┘
              │                                 │                                 │
              └─────────────────────────────────┼─────────────────────────────────┘
                                                │
                              ┌─────────────────▼───────────────────┐
                              │              Redis                  │
                              │  (Cache, Sessions, Index Queue)     │
                              └─────────────────┬───────────────────┘
                                                │
              ┌─────────────────────────────────┼─────────────────────────────────┐
              │                                 │                                 │
    ┌─────────▼─────────┐           ┌──────────▼──────────┐           ┌──────────▼──────────┐
    │   PostgreSQL      │           │   Elasticsearch     │           │   Crawler Service   │
    │                   │           │                     │           │                     │
    │ - Articles        │           │ - Full-text Index   │           │ - RSS Fetching      │
    │ - Story Clusters  │           │ - Aggregations      │           │ - Rate Limiting     │
    │ - Users           │           │                     │           │ - SimHash Dedup     │
    └───────────────────┘           └─────────────────────┘           └──────────┬──────────┘
                                                                                  │
                                                                       ┌──────────▼──────────┐
                                                                       │    Content Parser   │
                                                                       │                     │
                                                                       │ - HTML Extraction   │
                                                                       │ - Topic Extraction  │
                                                                       │ - Fingerprinting    │
                                                                       └─────────────────────┘
```

---

## Step 3: Deep Dive - Content Crawling Pipeline (10 minutes)

### Crawl Scheduler Design

```typescript
interface CrawlSchedule {
  source_id: string;
  url: string;
  crawl_interval: number;      // minutes (5-60)
  last_crawled_at: Date;
  next_crawl_at: Date;
  priority: number;            // 1-10, higher = more important
  consecutive_failures: number;
  circuit_state: 'closed' | 'open' | 'half-open';
}

class CrawlScheduler {
  async getNextBatch(limit: number = 100): Promise<CrawlSchedule[]> {
    // Priority queue ordered by next_crawl_at and priority
    return await db.query(`
      SELECT * FROM crawl_schedule
      WHERE next_crawl_at <= NOW()
        AND circuit_state != 'open'
      ORDER BY
        priority DESC,
        next_crawl_at ASC
      LIMIT $1
    `, [limit]);
  }

  async updateAfterCrawl(
    sourceId: string,
    success: boolean,
    articlesFound: number
  ): Promise<void> {
    if (success) {
      await db.query(`
        UPDATE crawl_schedule
        SET
          last_crawled_at = NOW(),
          next_crawl_at = NOW() + INTERVAL '1 minute' * crawl_interval,
          consecutive_failures = 0,
          circuit_state = 'closed',
          last_article_count = $2
        WHERE source_id = $1
      `, [sourceId, articlesFound]);
    } else {
      // Exponential backoff for failures
      await db.query(`
        UPDATE crawl_schedule
        SET
          consecutive_failures = consecutive_failures + 1,
          next_crawl_at = NOW() + INTERVAL '1 minute' *
            POWER(2, LEAST(consecutive_failures, 6)),
          circuit_state = CASE
            WHEN consecutive_failures >= 5 THEN 'open'
            ELSE 'closed'
          END
        WHERE source_id = $1
      `, [sourceId]);
    }
  }
}
```

### Rate Limiting per Domain

```typescript
class DomainRateLimiter {
  private limits: Map<string, TokenBucket> = new Map();

  constructor(
    private defaultRps: number = 1,
    private crawlDelay: number = 1000
  ) {}

  async acquireToken(domain: string): Promise<void> {
    let bucket = this.limits.get(domain);

    if (!bucket) {
      // Check robots.txt for crawl-delay
      const robotsDelay = await this.getCrawlDelay(domain);
      const effectiveDelay = Math.max(this.crawlDelay, robotsDelay * 1000);

      bucket = new TokenBucket({
        capacity: 1,
        refillRate: 1000 / effectiveDelay,  // tokens per ms
      });
      this.limits.set(domain, bucket);
    }

    // Wait for available token
    while (!bucket.tryConsume(1)) {
      await sleep(100);
    }
  }

  private async getCrawlDelay(domain: string): Promise<number> {
    try {
      const robotsUrl = `https://${domain}/robots.txt`;
      const response = await fetch(robotsUrl, { timeout: 5000 });
      const text = await response.text();

      // Parse Crawl-delay directive
      const match = text.match(/Crawl-delay:\s*(\d+)/i);
      return match ? parseInt(match[1]) : 0;
    } catch {
      return 0;  // Default: no delay
    }
  }
}
```

### RSS Feed Parser

```typescript
interface ParsedArticle {
  external_id: string;
  url: string;
  title: string;
  summary: string;
  author: string | null;
  published_at: Date;
  raw_content: string;
}

async function parseRSSFeed(feedUrl: string): Promise<ParsedArticle[]> {
  const response = await fetchWithRetry(feedUrl, {
    timeout: 10000,
    maxRetries: 3,
    backoff: [1000, 5000, 30000],
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  const feed = parser.parse(response);

  // Handle both RSS 2.0 and Atom formats
  const items = feed.rss?.channel?.item
    || feed.feed?.entry
    || [];

  return items.map((item: any) => ({
    external_id: item.guid || item.id || item.link,
    url: item.link?.['@_href'] || item.link,
    title: item.title,
    summary: stripHtml(item.description || item.summary || ''),
    author: item.author || item['dc:creator'] || null,
    published_at: new Date(item.pubDate || item.published || item.updated),
    raw_content: item['content:encoded'] || item.content || item.description,
  }));
}

async function fetchWithRetry(
  url: string,
  options: RetryOptions
): Promise<string> {
  for (let attempt = 0; attempt < options.maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        timeout: options.timeout,
        headers: { 'User-Agent': 'NewsAggregator/1.0 (bot)' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      if (attempt === options.maxRetries - 1) throw error;

      // Exponential backoff with jitter
      const delay = options.backoff[attempt];
      const jitter = Math.random() * delay * 0.25;
      await sleep(delay + jitter);
    }
  }
  throw new Error('Unreachable');
}
```

---

## Step 4: Deep Dive - SimHash Deduplication (10 minutes)

### SimHash Algorithm Implementation

SimHash creates a 64-bit fingerprint where similar documents produce similar fingerprints (small Hamming distance).

```typescript
class SimHasher {
  private readonly HASH_BITS = 64;

  computeFingerprint(text: string): bigint {
    // Step 1: Tokenize into words and n-grams
    const tokens = this.tokenize(text);

    // Step 2: Initialize weighted bit vector
    const vector = new Array(this.HASH_BITS).fill(0);

    // Step 3: For each token, hash and update vector
    for (const token of tokens) {
      const hash = this.hash64(token);

      for (let i = 0; i < this.HASH_BITS; i++) {
        if ((hash >> BigInt(i)) & 1n) {
          vector[i]++;   // Bit is 1: increment
        } else {
          vector[i]--;   // Bit is 0: decrement
        }
      }
    }

    // Step 4: Convert to fingerprint (positive = 1, negative = 0)
    let fingerprint = 0n;
    for (let i = 0; i < this.HASH_BITS; i++) {
      if (vector[i] > 0) {
        fingerprint |= (1n << BigInt(i));
      }
    }

    return fingerprint;
  }

  private tokenize(text: string): string[] {
    // Normalize: lowercase, remove punctuation
    const normalized = text.toLowerCase().replace(/[^\w\s]/g, '');

    // Extract words
    const words = normalized.split(/\s+/).filter(w => w.length > 2);

    // Generate 3-grams for better fingerprinting
    const ngrams: string[] = [];
    for (let i = 0; i < words.length - 2; i++) {
      ngrams.push(`${words[i]} ${words[i+1]} ${words[i+2]}`);
    }

    return [...words, ...ngrams];
  }

  private hash64(str: string): bigint {
    // MurmurHash3 128-bit, take lower 64 bits
    const hash = murmurhash3_128(str);
    return BigInt(hash.slice(0, 16));
  }

  hammingDistance(a: bigint, b: bigint): number {
    let xor = a ^ b;
    let count = 0;

    while (xor > 0n) {
      count += Number(xor & 1n);
      xor >>= 1n;
    }

    return count;
  }

  areSimilar(fp1: bigint, fp2: bigint, threshold: number = 3): boolean {
    return this.hammingDistance(fp1, fp2) <= threshold;
  }
}
```

### Story Clustering with Fingerprints

```typescript
interface StoryCluster {
  id: string;
  title: string;
  fingerprint: bigint;
  article_count: number;
  source_count: number;
  first_seen_at: Date;
  last_updated_at: Date;
  velocity: number;
  is_breaking: boolean;
}

class StoryClusterService {
  private simhasher = new SimHasher();

  async assignArticleToCluster(article: ParsedArticle): Promise<StoryCluster> {
    // Compute fingerprint from title + summary
    const content = `${article.title} ${article.summary}`;
    const fingerprint = this.simhasher.computeFingerprint(content);

    // Find matching cluster using PostgreSQL bit operations
    const candidateClusters = await db.query<StoryCluster>(`
      SELECT *,
        bit_count(fingerprint::bit(64) # $1::bit(64)) as hamming_distance
      FROM story_clusters
      WHERE last_updated_at > NOW() - INTERVAL '48 hours'
        AND bit_count(fingerprint::bit(64) # $1::bit(64)) <= 3
      ORDER BY hamming_distance ASC, last_updated_at DESC
      LIMIT 5
    `, [fingerprint.toString()]);

    if (candidateClusters.length > 0) {
      // Add to existing cluster
      const cluster = candidateClusters[0];
      await this.addArticleToCluster(cluster.id, article, fingerprint);
      return cluster;
    } else {
      // Create new cluster
      return await this.createCluster(article, fingerprint);
    }
  }

  private async addArticleToCluster(
    clusterId: string,
    article: ParsedArticle,
    fingerprint: bigint
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Insert article
      await tx.query(`
        INSERT INTO articles (
          source_id, story_cluster_id, external_id, url,
          title, summary, published_at, fingerprint
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (source_id, external_id) DO NOTHING
      `, [
        article.source_id, clusterId, article.external_id,
        article.url, article.title, article.summary,
        article.published_at, fingerprint.toString()
      ]);

      // Update cluster aggregates
      await tx.query(`
        UPDATE story_clusters
        SET
          article_count = article_count + 1,
          source_count = (
            SELECT COUNT(DISTINCT source_id)
            FROM articles WHERE story_cluster_id = $1
          ),
          last_updated_at = NOW()
        WHERE id = $1
      `, [clusterId]);
    });
  }

  private async createCluster(
    article: ParsedArticle,
    fingerprint: bigint
  ): Promise<StoryCluster> {
    const result = await db.query<StoryCluster>(`
      INSERT INTO story_clusters (
        title, fingerprint, article_count, source_count
      ) VALUES ($1, $2, 1, 1)
      RETURNING *
    `, [article.title, fingerprint.toString()]);

    const cluster = result.rows[0];

    // Insert the article
    await db.query(`
      INSERT INTO articles (
        source_id, story_cluster_id, external_id, url,
        title, summary, published_at, fingerprint
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      article.source_id, cluster.id, article.external_id,
      article.url, article.title, article.summary,
      article.published_at, fingerprint.toString()
    ]);

    return cluster;
  }
}
```

### MinHash + LSH for Scale (10M+ articles)

For production scale, use Locality Sensitive Hashing (LSH) to avoid O(n) comparisons:

```typescript
class MinHashLSH {
  private readonly numHashes = 100;
  private readonly bands = 20;
  private readonly rowsPerBand = 5;
  private readonly buckets = new Map<string, Set<string>>();

  generateSignature(text: string): number[] {
    const shingles = this.getShingles(text, 3);
    const signature: number[] = [];

    for (let i = 0; i < this.numHashes; i++) {
      let minHash = Infinity;
      for (const shingle of shingles) {
        const hash = this.hashWithSeed(shingle, i);
        minHash = Math.min(minHash, hash);
      }
      signature.push(minHash);
    }

    return signature;
  }

  index(articleId: string, signature: number[]): void {
    // Divide signature into bands
    for (let band = 0; band < this.bands; band++) {
      const start = band * this.rowsPerBand;
      const bandSig = signature.slice(start, start + this.rowsPerBand);
      const bucketKey = `${band}:${bandSig.join(',')}`;

      if (!this.buckets.has(bucketKey)) {
        this.buckets.set(bucketKey, new Set());
      }
      this.buckets.get(bucketKey)!.add(articleId);
    }
  }

  findCandidates(signature: number[]): Set<string> {
    const candidates = new Set<string>();

    for (let band = 0; band < this.bands; band++) {
      const start = band * this.rowsPerBand;
      const bandSig = signature.slice(start, start + this.rowsPerBand);
      const bucketKey = `${band}:${bandSig.join(',')}`;

      const bucket = this.buckets.get(bucketKey);
      if (bucket) {
        bucket.forEach(id => candidates.add(id));
      }
    }

    return candidates;  // Only compare these candidates with full fingerprint
  }

  private getShingles(text: string, k: number): Set<string> {
    const normalized = text.toLowerCase();
    const shingles = new Set<string>();

    for (let i = 0; i <= normalized.length - k; i++) {
      shingles.add(normalized.slice(i, i + k));
    }

    return shingles;
  }

  private hashWithSeed(str: string, seed: number): number {
    return murmurhash3_32(str, seed);
  }
}
```

---

## Step 5: Deep Dive - Ranking Algorithm (8 minutes)

### Multi-Signal Feed Ranking

```typescript
interface RankingWeights {
  relevance: number;    // 0.35 - topic match
  freshness: number;    // 0.25 - time decay
  quality: number;      // 0.20 - source diversity
  diversity: number;    // 0.10 - feed variety
  trending: number;     // 0.10 - velocity
}

const DEFAULT_WEIGHTS: RankingWeights = {
  relevance: 0.35,
  freshness: 0.25,
  quality: 0.20,
  diversity: 0.10,
  trending: 0.10,
};

class FeedRanker {
  constructor(private weights: RankingWeights = DEFAULT_WEIGHTS) {}

  rankStories(
    stories: StoryCluster[],
    userPreferences: UserPreferences,
    feedContext: FeedContext
  ): RankedStory[] {
    const ranked: RankedStory[] = [];

    for (const story of stories) {
      const signals = this.computeSignals(story, userPreferences, feedContext);

      const score =
        signals.relevance * this.weights.relevance +
        signals.freshness * this.weights.freshness +
        signals.quality * this.weights.quality +
        signals.diversity * this.weights.diversity +
        signals.trending * this.weights.trending;

      // Breaking news boost
      const finalScore = story.is_breaking ? score * 1.3 : score;

      ranked.push({ story, score: finalScore, signals });

      // Update context for diversity calculation
      feedContext.topicsSeen.add(story.primary_topic);
      feedContext.sourcesSeen.add(story.primary_source_id);
    }

    return ranked.sort((a, b) => b.score - a.score);
  }

  private computeSignals(
    story: StoryCluster,
    prefs: UserPreferences,
    context: FeedContext
  ): RankingSignals {
    return {
      relevance: this.computeRelevance(story, prefs),
      freshness: this.computeFreshness(story),
      quality: this.computeQuality(story),
      diversity: this.computeDiversity(story, context),
      trending: Math.min(story.velocity / 10, 1),  // Normalize velocity
    };
  }

  private computeRelevance(story: StoryCluster, prefs: UserPreferences): number {
    let score = 0;

    // Topic match (weighted by user preference)
    for (const topic of story.topics) {
      score += prefs.topic_weights.get(topic) || 0;
    }

    // Source preference
    if (prefs.preferred_sources.has(story.primary_source_id)) {
      score += 0.2;
    }

    // Penalty for excluded sources
    if (prefs.excluded_sources.has(story.primary_source_id)) {
      score -= 0.5;
    }

    // Already read penalty
    if (prefs.reading_history.has(story.id)) {
      score *= 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  private computeFreshness(story: StoryCluster): number {
    const ageHours = (Date.now() - story.first_seen_at.getTime()) / 3600000;

    // Exponential decay with 6-hour half-life
    return Math.exp(-ageHours * Math.LN2 / 6);
  }

  private computeQuality(story: StoryCluster): number {
    // Multi-source coverage indicates important story
    const sourceScore = Math.min(story.source_count / 5, 1);

    // Credibility of primary source
    const credibilityScore = story.primary_source_credibility || 0.5;

    return sourceScore * 0.6 + credibilityScore * 0.4;
  }

  private computeDiversity(story: StoryCluster, context: FeedContext): number {
    // Penalize if topic already heavily represented
    const topicOccurrences = context.topicCounts.get(story.primary_topic) || 0;
    const topicPenalty = Math.max(0, 1 - topicOccurrences * 0.2);

    // Penalize if source already in feed
    const sourcePenalty = context.sourcesSeen.has(story.primary_source_id) ? 0.5 : 1;

    return topicPenalty * sourcePenalty;
  }
}
```

### Breaking News Detection

```typescript
class BreakingNewsDetector {
  private readonly VELOCITY_THRESHOLD = 2;      // articles/minute
  private readonly SOURCE_THRESHOLD = 5;        // unique sources
  private readonly WINDOW_MINUTES = 30;

  async checkVelocity(clusterId: string): Promise<void> {
    const windowStart = new Date(Date.now() - this.WINDOW_MINUTES * 60000);

    // Count recent articles and sources
    const stats = await db.query(`
      SELECT
        COUNT(*) as article_count,
        COUNT(DISTINCT source_id) as source_count
      FROM articles
      WHERE story_cluster_id = $1
        AND created_at > $2
    `, [clusterId, windowStart]);

    const { article_count, source_count } = stats.rows[0];
    const velocity = article_count / this.WINDOW_MINUTES;

    // Update velocity
    await db.query(`
      UPDATE story_clusters
      SET velocity = $2
      WHERE id = $1
    `, [clusterId, velocity]);

    // Mark as breaking if thresholds met
    if (velocity > this.VELOCITY_THRESHOLD && source_count >= this.SOURCE_THRESHOLD) {
      await this.markAsBreaking(clusterId);
    }
  }

  private async markAsBreaking(clusterId: string): Promise<void> {
    const result = await db.query(`
      UPDATE story_clusters
      SET
        is_breaking = true,
        breaking_started_at = COALESCE(breaking_started_at, NOW())
      WHERE id = $1
        AND is_breaking = false
      RETURNING *
    `, [clusterId]);

    if (result.rowCount > 0) {
      // Trigger notifications for interested users
      await this.notifyInterestedUsers(result.rows[0]);
    }
  }

  private async notifyInterestedUsers(cluster: StoryCluster): Promise<void> {
    // Find users interested in these topics
    const users = await db.query(`
      SELECT DISTINCT u.id, u.push_token
      FROM users u
      JOIN user_preferences up ON u.id = up.user_id
      WHERE up.topics ?| $1
        AND u.push_enabled = true
    `, [cluster.topics]);

    // Queue push notifications
    for (const user of users.rows) {
      await redis.rpush('push:queue', JSON.stringify({
        user_id: user.id,
        token: user.push_token,
        title: 'Breaking News',
        body: cluster.title,
        data: { story_id: cluster.id },
      }));
    }
  }
}
```

---

## Step 6: Database Schema (5 minutes)

### PostgreSQL Schema

```sql
-- News sources
CREATE TABLE sources (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    url             VARCHAR(2048) NOT NULL,
    homepage        VARCHAR(2048),
    category        VARCHAR(50),
    credibility_score DECIMAL(3, 2) DEFAULT 0.50,
    crawl_interval  INTEGER DEFAULT 300,          -- seconds
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Crawl schedule (separate for performance)
CREATE TABLE crawl_schedule (
    source_id           UUID PRIMARY KEY REFERENCES sources(id),
    last_crawled_at     TIMESTAMPTZ,
    next_crawl_at       TIMESTAMPTZ DEFAULT NOW(),
    priority            INTEGER DEFAULT 5,
    consecutive_failures INTEGER DEFAULT 0,
    circuit_state       VARCHAR(20) DEFAULT 'closed',
    last_article_count  INTEGER DEFAULT 0
);

CREATE INDEX idx_crawl_due ON crawl_schedule(next_crawl_at)
    WHERE circuit_state != 'open';

-- Story clusters
CREATE TABLE story_clusters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           VARCHAR(500) NOT NULL,
    fingerprint     BIGINT NOT NULL,
    primary_topic   VARCHAR(50),
    topics          TEXT[] DEFAULT '{}',
    article_count   INTEGER DEFAULT 1,
    source_count    INTEGER DEFAULT 1,
    velocity        DECIMAL(10, 4) DEFAULT 0,
    is_breaking     BOOLEAN DEFAULT false,
    breaking_started_at TIMESTAMPTZ,
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fingerprint index for similarity search
CREATE INDEX idx_story_fingerprint ON story_clusters(fingerprint);
CREATE INDEX idx_story_recent ON story_clusters(last_updated_at DESC);
CREATE INDEX idx_story_breaking ON story_clusters(is_breaking, velocity DESC)
    WHERE is_breaking = true;

-- Articles
CREATE TABLE articles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID REFERENCES sources(id) ON DELETE CASCADE,
    story_cluster_id UUID REFERENCES story_clusters(id) ON DELETE SET NULL,
    external_id     VARCHAR(255),
    url             VARCHAR(2048) NOT NULL,
    title           VARCHAR(500) NOT NULL,
    summary         TEXT,
    author          VARCHAR(255),
    published_at    TIMESTAMPTZ,
    crawled_at      TIMESTAMPTZ DEFAULT NOW(),
    fingerprint     BIGINT NOT NULL,
    topics          TEXT[] DEFAULT '{}',
    is_indexed      BOOLEAN DEFAULT false
);

CREATE UNIQUE INDEX idx_article_unique ON articles(source_id, external_id);
CREATE INDEX idx_article_cluster ON articles(story_cluster_id);
CREATE INDEX idx_article_published ON articles(published_at DESC);
CREATE INDEX idx_article_unindexed ON articles(id) WHERE is_indexed = false;

-- Users and preferences
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(100),
    role            VARCHAR(20) DEFAULT 'user',
    push_enabled    BOOLEAN DEFAULT false,
    push_token      VARCHAR(500),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_preferences (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    topics          JSONB DEFAULT '[]',
    sources         JSONB DEFAULT '[]',
    excluded_sources JSONB DEFAULT '[]',
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_reading_history (
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    story_cluster_id UUID REFERENCES story_clusters(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ DEFAULT NOW(),
    dwell_time_seconds INTEGER,
    PRIMARY KEY (user_id, story_cluster_id)
);

-- Topics with keyword matching
CREATE TABLE topics (
    id              VARCHAR(50) PRIMARY KEY,
    display_name    VARCHAR(100) NOT NULL,
    keywords        JSONB NOT NULL,
    parent_topic    VARCHAR(50) REFERENCES topics(id)
);

-- PostgreSQL function for Hamming distance
CREATE OR REPLACE FUNCTION hamming_distance(a BIGINT, b BIGINT)
RETURNS INTEGER AS $$
BEGIN
    RETURN bit_count((a # b)::bit(64));
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### Elasticsearch Mapping

```json
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "refresh_interval": "5s",
    "analysis": {
      "analyzer": {
        "news_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "stop", "snowball"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "article_id": { "type": "keyword" },
      "story_cluster_id": { "type": "keyword" },
      "title": {
        "type": "text",
        "analyzer": "news_analyzer",
        "fields": { "exact": { "type": "keyword" } }
      },
      "summary": { "type": "text", "analyzer": "news_analyzer" },
      "topics": { "type": "keyword" },
      "source_id": { "type": "keyword" },
      "source_name": { "type": "keyword" },
      "published_at": { "type": "date" },
      "velocity": { "type": "float" },
      "is_breaking": { "type": "boolean" }
    }
  }
}
```

---

## Step 7: Caching Strategy (3 minutes)

### Redis Cache Patterns

```typescript
class FeedCache {
  private readonly FEED_TTL = 60;         // seconds
  private readonly PREFS_TTL = 300;       // seconds
  private readonly GLOBAL_TTL = 30;       // seconds

  async getPersonalizedFeed(
    userId: string,
    cursor: number,
    limit: number
  ): Promise<StoryCluster[] | null> {
    const key = `feed:user:${userId}:${cursor}:${limit}`;
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  async setPersonalizedFeed(
    userId: string,
    cursor: number,
    limit: number,
    stories: StoryCluster[]
  ): Promise<void> {
    const key = `feed:user:${userId}:${cursor}:${limit}`;
    await redis.setex(key, this.FEED_TTL, JSON.stringify(stories));
  }

  async getUserPreferences(userId: string): Promise<UserPreferences | null> {
    const key = `prefs:user:${userId}`;
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  async setUserPreferences(
    userId: string,
    prefs: UserPreferences
  ): Promise<void> {
    const key = `prefs:user:${userId}`;
    await redis.setex(key, this.PREFS_TTL, JSON.stringify(prefs));
  }

  async invalidateUserFeed(userId: string): Promise<void> {
    // Pattern-based deletion for all feed pages
    const keys = await redis.keys(`feed:user:${userId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  async getGlobalTrending(): Promise<StoryCluster[] | null> {
    const cached = await redis.get('feed:global:trending');
    return cached ? JSON.parse(cached) : null;
  }

  async setGlobalTrending(stories: StoryCluster[]): Promise<void> {
    await redis.setex('feed:global:trending', this.GLOBAL_TTL, JSON.stringify(stories));
  }
}
```

### Redis Key Patterns

| Pattern | Type | TTL | Purpose |
|---------|------|-----|---------|
| `session:{sessionId}` | Hash | 24h | User session data |
| `feed:user:{userId}:{cursor}:{limit}` | String | 60s | Cached personalized feed |
| `feed:global:trending` | String | 30s | Global trending stories |
| `prefs:user:{userId}` | String | 5m | User preferences |
| `index:queue` | List | - | Articles pending ES indexing |
| `crawl:lock:{sourceId}` | String | 5m | Distributed crawl lock |
| `rate:{ip}` | String | 60s | Rate limiting counter |

---

## Step 8: Circuit Breaker Pattern (3 minutes)

```typescript
import CircuitBreaker from 'opossum';

class ResilientCrawler {
  private breakers = new Map<string, CircuitBreaker>();

  private getBreaker(sourceId: string): CircuitBreaker {
    if (!this.breakers.has(sourceId)) {
      const breaker = new CircuitBreaker(this.fetchFeed.bind(this), {
        timeout: 10000,                     // 10s timeout
        errorThresholdPercentage: 50,       // Open after 50% failures
        resetTimeout: 30000,                // Try again after 30s
        volumeThreshold: 5,                 // Need 5 samples
      });

      breaker.fallback(() => ({
        status: 'circuit_open',
        articles: [],
      }));

      breaker.on('open', () => {
        logger.warn({ sourceId }, 'Circuit breaker opened');
        metrics.circuitBreakerState.set({ source_id: sourceId }, 1);
      });

      breaker.on('close', () => {
        logger.info({ sourceId }, 'Circuit breaker closed');
        metrics.circuitBreakerState.set({ source_id: sourceId }, 0);
      });

      this.breakers.set(sourceId, breaker);
    }

    return this.breakers.get(sourceId)!;
  }

  async crawlSource(source: Source): Promise<CrawlResult> {
    const breaker = this.getBreaker(source.id);
    return await breaker.fire(source.url);
  }

  private async fetchFeed(url: string): Promise<CrawlResult> {
    const response = await fetch(url, { timeout: 10000 });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const articles = await parseRSSFeed(await response.text());
    return { status: 'success', articles };
  }
}
```

---

## Step 9: API Endpoints (2 minutes)

```typescript
// Feed API
router.get('/api/v1/feed', requireAuth, async (req, res) => {
  const { cursor = '0', limit = '20' } = req.query;

  // Try cache first
  const cached = await feedCache.getPersonalizedFeed(
    req.session.userId,
    parseInt(cursor),
    parseInt(limit)
  );

  if (cached) {
    metrics.cacheHits.inc({ type: 'feed' });
    return res.json({ stories: cached, source: 'cache' });
  }

  metrics.cacheMisses.inc({ type: 'feed' });

  // Generate fresh feed
  const prefs = await getUserPreferences(req.session.userId);
  const candidates = await getCandidateStories({ maxAgeHours: 48 });
  const ranked = feedRanker.rankStories(candidates, prefs, new FeedContext());
  const page = ranked.slice(parseInt(cursor), parseInt(cursor) + parseInt(limit));

  // Cache result
  await feedCache.setPersonalizedFeed(
    req.session.userId,
    parseInt(cursor),
    parseInt(limit),
    page.map(r => r.story)
  );

  res.json({
    stories: page.map(r => r.story),
    next_cursor: String(parseInt(cursor) + page.length),
    has_more: ranked.length > parseInt(cursor) + page.length,
  });
});

// Search API
router.get('/api/v1/search', searchLimiter, async (req, res) => {
  const { q, topic, source, from, to, limit = '20' } = req.query;

  const results = await esClient.search({
    index: 'articles',
    body: {
      query: {
        bool: {
          must: [
            { multi_match: { query: q, fields: ['title^2', 'summary'] } },
          ],
          filter: [
            topic && { term: { topics: topic } },
            source && { term: { source_id: source } },
            (from || to) && {
              range: {
                published_at: {
                  ...(from && { gte: from }),
                  ...(to && { lte: to }),
                },
              },
            },
          ].filter(Boolean),
        },
      },
      sort: [
        { _score: 'desc' },
        { published_at: 'desc' },
      ],
      size: parseInt(limit),
      highlight: {
        fields: { title: {}, summary: {} },
      },
    },
  });

  res.json({
    hits: results.hits.hits.map(hit => ({
      ...hit._source,
      highlights: hit.highlight,
    })),
    total: results.hits.total.value,
  });
});

// Breaking news API
router.get('/api/v1/breaking', async (req, res) => {
  const stories = await db.query(`
    SELECT * FROM story_clusters
    WHERE is_breaking = true
      AND breaking_started_at > NOW() - INTERVAL '6 hours'
    ORDER BY velocity DESC
    LIMIT 10
  `);

  res.json({ stories: stories.rows });
});
```

---

## Trade-offs Summary

| Decision | Chosen Approach | Alternative | Trade-off |
|----------|-----------------|-------------|-----------|
| Deduplication | SimHash (64-bit) | Semantic embeddings | Fast O(1) compare vs better paraphrase detection |
| Similarity search | PostgreSQL Hamming | MinHash + LSH in Redis | Simpler ops vs O(1) candidate lookup at scale |
| Message queue | Redis Lists | RabbitMQ/Kafka | Lower ops overhead vs better delivery guarantees |
| Feed caching | 60s TTL | Real-time generation | Faster response vs always-fresh content |
| Topic extraction | Keyword matching | ML classifier | Predictable behavior vs better accuracy |
| Breaking detection | Velocity threshold | Anomaly detection ML | Simple tuning vs adaptive thresholds |

---

## Future Enhancements

1. **Semantic Embeddings** - Add vector similarity for paraphrase detection
2. **ML Topic Classifier** - Replace keyword matching with trained model
3. **User Embeddings** - Collaborative filtering for cold-start users
4. **Real-time Feeds** - WebSocket push for breaking news
5. **Source Credibility ML** - Automated credibility scoring
6. **Multi-language Support** - Language detection and translation pipeline

---

## Closing Summary

"I've designed a backend system for news aggregation with:

1. **Distributed Crawling** - Rate-limited per domain with circuit breakers and exponential backoff
2. **SimHash Deduplication** - O(1) fingerprint comparison with 64-bit hashes
3. **Story Clustering** - Grouping articles within Hamming distance threshold
4. **Multi-signal Ranking** - Balancing relevance, freshness, quality, diversity, and trending
5. **Velocity-based Breaking News** - Real-time detection with sliding window counters

The architecture separates the ingestion pipeline (crawling, dedup, clustering) from the serving path (feed generation), allowing each to scale independently. PostgreSQL handles transactional data and fingerprint matching, Redis provides caching and queuing, and Elasticsearch powers full-text search. Happy to dive deeper into any component."

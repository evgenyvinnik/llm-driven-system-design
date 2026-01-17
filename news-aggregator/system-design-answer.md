# News Aggregator - System Design Interview Answer

## Opening Statement

"Today I'll design a news aggregator like Google News, Flipboard, or Apple News. The core challenges are crawling thousands of sources efficiently, deduplicating articles about the same story, categorizing and ranking content, and personalizing the news feed for millions of users while maintaining freshness."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Source crawling** - Fetch articles from thousands of news sources
2. **Deduplication** - Identify and group articles about the same story
3. **Categorization** - Classify articles by topic (politics, sports, tech, etc.)
4. **Personalization** - Customize feed based on user interests and reading history
5. **Search** - Full-text search across all articles
6. **Breaking news** - Surface urgent/trending stories quickly
7. **Source diversity** - Show multiple perspectives on same story

### Non-Functional Requirements

- **Freshness**: Breaking news indexed within 5 minutes
- **Scale**: 100K sources, 10M articles/day, 50M users
- **Latency**: Feed generation < 200ms
- **Availability**: 99.9% uptime

### Out of Scope

- Publisher partnerships/paywalls
- Video content
- User-generated content

---

## Step 2: Scale Estimation (2-3 minutes)

**Content volume:**
- 100,000 news sources
- Average 100 articles per source per day = 10 million articles/day
- Average article size: 5KB text + 50KB images = 55KB
- Daily ingestion: 10M * 55KB = 550 GB/day

**Crawling:**
- Crawl each source every 15 minutes = 100K * 96/day = 9.6M crawls/day
- 111 crawls/second

**User traffic:**
- 50 million daily active users
- Average 5 feed loads per user = 250M feed requests/day
- Peak: 250M / 86400 * 3 = 8,700 QPS

**Deduplication:**
- 10M articles clustered into ~1M unique stories/day
- 90% of articles are duplicates/similar coverage

**Key insight**: This is a content processing pipeline. Crawling, deduplication, and categorization happen offline; feed generation is the hot path.

---

## Step 3: High-Level Architecture (10 minutes)

```
                                        ┌─────────────────────────────────┐
                                        │          Client Apps            │
                                        │      (Web, Mobile, API)         │
                                        └───────────────┬─────────────────┘
                                                        │
                                                        ▼
                                        ┌─────────────────────────────────┐
                                        │          API Gateway            │
                                        └───────────────┬─────────────────┘
                                                        │
                    ┌───────────────────────────────────┼───────────────────────────────────┐
                    │                                   │                                   │
          ┌─────────▼─────────┐              ┌─────────▼─────────┐              ┌─────────▼─────────┐
          │   Feed Service    │              │  Search Service   │              │   User Service    │
          │                   │              │                   │              │                   │
          │ - Personalization │              │ - Full-text       │              │ - Preferences     │
          │ - Ranking         │              │ - Filters         │              │ - History         │
          └─────────┬─────────┘              └─────────┬─────────┘              └───────────────────┘
                    │                                   │
                    │                                   │
          ┌─────────▼─────────────────────────────────▼─────────┐
          │                     Elasticsearch                     │
          │              (Articles, Stories, Topics)              │
          └───────────────────────────────────────────────────────┘
                                        │
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          │                             │                             │
┌─────────▼─────────┐        ┌─────────▼─────────┐        ┌─────────▼─────────┐
│   Story Service   │        │ Category Service  │        │  Trending Service │
│                   │        │                   │        │                   │
│ - Deduplication   │        │ - Classification  │        │ - Breaking news   │
│ - Clustering      │        │ - Topic tagging   │        │ - Viral detection │
└─────────┬─────────┘        └─────────┬─────────┘        └─────────┬─────────┘
          │                             │                             │
          └─────────────────────────────┼─────────────────────────────┘
                                        │
                                        ▼
                              ┌─────────────────────┐
                              │       Kafka         │
                              │  (Article Stream)   │
                              └─────────┬───────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          │                             │                             │
┌─────────▼─────────┐        ┌─────────▼─────────┐        ┌─────────▼─────────┐
│  Content Parser   │        │ Image Processor   │        │   NLP Pipeline    │
│                   │        │                   │        │                   │
│ - HTML parsing    │        │ - Thumbnails      │        │ - NER             │
│ - Text extraction │        │ - CDN upload      │        │ - Summarization   │
└─────────┬─────────┘        └───────────────────┘        └───────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Crawler Service                                 │
│                                                                             │
│   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐            │
│   │ Crawler 1 │   │ Crawler 2 │   │ Crawler 3 │   │ Crawler N │            │
│   └───────────┘   └───────────┘   └───────────┘   └───────────┘            │
│                                                                             │
│   - RSS/Atom feeds                                                          │
│   - Web scraping                                                            │
│   - Rate limiting per domain                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Crawler Service**
   - Fetches content from news sources
   - Respects robots.txt and rate limits
   - Supports RSS feeds and web scraping

2. **Content Parser**
   - Extracts article text from HTML
   - Handles diverse page layouts
   - Cleans and normalizes content

3. **NLP Pipeline**
   - Named Entity Recognition (people, places, organizations)
   - Topic classification
   - Summarization for snippets

4. **Story Service**
   - Groups articles about the same event
   - Creates story clusters
   - Selects representative article per source

5. **Feed Service**
   - Generates personalized feeds
   - Applies ranking algorithms
   - Ensures diversity

6. **Trending Service**
   - Detects breaking news
   - Identifies viral stories
   - Real-time velocity tracking

---

## Step 4: Deep Dive - Content Crawling (7 minutes)

### Crawl Architecture

```
                        ┌─────────────────┐
                        │  Crawl Schedule │
                        │    Database     │
                        └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   Scheduler     │
                        │   Service       │
                        └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │    Kafka        │
                        │  (Crawl Queue)  │
                        └────────┬────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
┌───────▼───────┐       ┌───────▼───────┐       ┌───────▼───────┐
│   Crawler 1   │       │   Crawler 2   │       │   Crawler N   │
│   (Domain A)  │       │   (Domain B)  │       │   (Domain X)  │
└───────────────┘       └───────────────┘       └───────────────┘
```

### Crawl Scheduling

```typescript
interface CrawlSchedule {
  source_id: string;
  url: string;
  crawl_frequency: number;  // minutes
  last_crawl: Date;
  next_crawl: Date;
  priority: number;  // Higher for major sources
}

async function scheduleCrawls() {
  // Get sources due for crawling
  const dueSources = await db.query(`
    SELECT * FROM crawl_schedule
    WHERE next_crawl <= NOW()
    ORDER BY priority DESC, next_crawl ASC
    LIMIT 1000
  `);

  for (const source of dueSources) {
    await kafka.send('crawl_queue', {
      source_id: source.source_id,
      url: source.url,
      priority: source.priority
    });

    // Update next crawl time
    await db.update('crawl_schedule', source.source_id, {
      next_crawl: new Date(Date.now() + source.crawl_frequency * 60000)
    });
  }
}
```

### Politeness and Rate Limiting

```typescript
class PoliteCrawler {
  private domainLimits: Map<string, RateLimiter> = new Map();
  private robotsCache: Map<string, RobotsParser> = new Map();

  async crawl(url: string): Promise<CrawlResult> {
    const domain = new URL(url).hostname;

    // Check robots.txt
    const robots = await this.getRobots(domain);
    if (!robots.isAllowed(url, 'NewsAggregator')) {
      return { status: 'blocked_by_robots' };
    }

    // Rate limit per domain
    const limiter = this.getLimiter(domain);
    await limiter.waitForToken();

    // Fetch with timeout
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NewsAggregator/1.0' },
      timeout: 30000
    });

    // Respect Crawl-Delay
    const delay = robots.getCrawlDelay() || 1;
    await sleep(delay * 1000);

    return {
      status: 'success',
      content: await response.text(),
      headers: response.headers
    };
  }

  private getLimiter(domain: string): RateLimiter {
    if (!this.domainLimits.has(domain)) {
      // Default: 1 request per second per domain
      this.domainLimits.set(domain, new RateLimiter(1, 1000));
    }
    return this.domainLimits.get(domain)!;
  }
}
```

### RSS vs Web Scraping

```typescript
async function fetchSource(source: Source): Promise<Article[]> {
  if (source.feed_url) {
    // Prefer RSS/Atom feeds - structured data
    return fetchRSSFeed(source.feed_url);
  } else {
    // Fall back to web scraping
    return scrapeWebPage(source.homepage_url, source.scrape_config);
  }
}

async function fetchRSSFeed(url: string): Promise<Article[]> {
  const response = await fetch(url);
  const feed = await parseRSS(response.text());

  return feed.items.map(item => ({
    title: item.title,
    url: item.link,
    published_at: item.pubDate,
    summary: item.description,
    source_id: extractSourceId(url)
  }));
}
```

---

## Step 5: Deep Dive - Content Deduplication (10 minutes)

This is the most technically interesting part. Multiple outlets cover the same story.

### The Challenge

When a major event happens:
- CNN publishes "President Signs Climate Bill"
- NYT publishes "Climate Legislation Passes, President Signs"
- Reuters publishes "US President Signs Climate Change Bill"

These are all about the same event but have different text. We need to:
1. Detect they're about the same story
2. Group them into a cluster
3. Show one entry with multiple source options

### Deduplication Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Articles   │────▶│  Fingerprint │────▶│   Clustering │────▶│    Story     │
│   Stream     │     │  Generation  │     │              │     │   Creation   │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

### Approach 1: SimHash (Chosen)

SimHash creates a fingerprint that's similar for similar documents:

```typescript
function computeSimHash(text: string): bigint {
  // 1. Tokenize and hash each word
  const tokens = tokenize(text);
  const hashes = tokens.map(t => hash64(t));

  // 2. Create weighted bit vector
  const vector = new Array(64).fill(0);

  for (const h of hashes) {
    for (let i = 0; i < 64; i++) {
      if ((h >> BigInt(i)) & 1n) {
        vector[i]++;
      } else {
        vector[i]--;
      }
    }
  }

  // 3. Convert to fingerprint
  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (vector[i] > 0) {
      fingerprint |= (1n << BigInt(i));
    }
  }

  return fingerprint;
}

function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

// Two articles are similar if Hamming distance < 3
function areSimilar(fp1: bigint, fp2: bigint): boolean {
  return hammingDistance(fp1, fp2) < 3;
}
```

### Approach 2: MinHash + LSH (For efficiency at scale)

```typescript
class MinHashLSH {
  private numHashFunctions = 100;
  private bands = 20;
  private rowsPerBand = 5;
  private buckets: Map<string, Set<string>> = new Map();

  // Generate MinHash signature
  getSignature(text: string): number[] {
    const shingles = this.getShingles(text, 3);
    const signature: number[] = [];

    for (let i = 0; i < this.numHashFunctions; i++) {
      let minHash = Infinity;
      for (const shingle of shingles) {
        const hash = this.hashWithSeed(shingle, i);
        minHash = Math.min(minHash, hash);
      }
      signature.push(minHash);
    }

    return signature;
  }

  // Add to LSH index
  index(articleId: string, signature: number[]): void {
    for (let band = 0; band < this.bands; band++) {
      const start = band * this.rowsPerBand;
      const bandSignature = signature.slice(start, start + this.rowsPerBand);
      const bucketKey = `${band}:${bandSignature.join(',')}`;

      if (!this.buckets.has(bucketKey)) {
        this.buckets.set(bucketKey, new Set());
      }
      this.buckets.get(bucketKey)!.add(articleId);
    }
  }

  // Find candidates for similarity
  findCandidates(signature: number[]): Set<string> {
    const candidates = new Set<string>();

    for (let band = 0; band < this.bands; band++) {
      const start = band * this.rowsPerBand;
      const bandSignature = signature.slice(start, start + this.rowsPerBand);
      const bucketKey = `${band}:${bandSignature.join(',')}`;

      const bucket = this.buckets.get(bucketKey);
      if (bucket) {
        bucket.forEach(id => candidates.add(id));
      }
    }

    return candidates;
  }
}
```

### Story Clustering

```typescript
interface Story {
  id: string;
  title: string;  // Generated representative title
  summary: string;
  articles: ArticleRef[];  // All articles about this story
  created_at: Date;
  updated_at: Date;
  velocity: number;  // How fast it's getting coverage
}

async function assignToStory(article: Article): Promise<Story> {
  const fingerprint = computeSimHash(article.title + ' ' + article.body);

  // Find recent stories with similar fingerprints
  const candidates = await findSimilarStories(fingerprint, {
    max_age_hours: 48,
    max_hamming_distance: 3
  });

  if (candidates.length > 0) {
    // Add to existing story
    const bestMatch = candidates[0];
    await addArticleToStory(bestMatch.id, article);
    return bestMatch;
  } else {
    // Create new story
    return createStory(article);
  }
}

async function findSimilarStories(
  fingerprint: bigint,
  options: { max_age_hours: number; max_hamming_distance: number }
): Promise<Story[]> {
  // Use LSH buckets for fast candidate retrieval
  const candidateIds = await lshIndex.findCandidates(fingerprint);

  // Verify with actual fingerprint comparison
  const candidates = await getStoriesByIds(candidateIds);

  return candidates.filter(story =>
    hammingDistance(story.fingerprint, fingerprint) < options.max_hamming_distance
  );
}
```

---

## Step 6: Deep Dive - Personalization and Ranking (8 minutes)

### User Interest Model

```typescript
interface UserProfile {
  user_id: string;
  topic_weights: Map<string, number>;  // e.g., "technology": 0.8
  source_preferences: Map<string, number>;  // e.g., "nytimes": 0.9
  reading_history: ArticleRef[];
  click_history: ClickEvent[];
  dwell_times: Map<string, number>;  // Article ID → seconds spent
}

async function buildUserProfile(userId: string): Promise<UserProfile> {
  const history = await getReadingHistory(userId, { days: 30 });

  // Calculate topic weights from reading history
  const topicCounts = new Map<string, number>();
  for (const article of history) {
    for (const topic of article.topics) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }

  // Normalize weights
  const total = Array.from(topicCounts.values()).reduce((a, b) => a + b, 0);
  const topicWeights = new Map<string, number>();
  topicCounts.forEach((count, topic) => {
    topicWeights.set(topic, count / total);
  });

  // Factor in dwell time (longer = more interested)
  const dwellData = await getDwellTimes(userId, { days: 30 });
  for (const [articleId, dwellTime] of dwellData) {
    const article = await getArticle(articleId);
    if (dwellTime > 60) {  // Spent > 1 minute
      for (const topic of article.topics) {
        const current = topicWeights.get(topic) || 0;
        topicWeights.set(topic, current * 1.2);  // Boost
      }
    }
  }

  return {
    user_id: userId,
    topic_weights: topicWeights,
    source_preferences: await getSourcePreferences(userId),
    reading_history: history,
    click_history: await getClickHistory(userId),
    dwell_times: dwellData
  };
}
```

### Ranking Algorithm

```typescript
interface RankingSignals {
  relevance: number;      // Topic match with user interests
  freshness: number;      // How recent
  quality: number;        // Source reputation, engagement
  diversity: number;      // Avoid repetition
  trending: number;       // Current velocity
}

function calculateStoryScore(
  story: Story,
  userProfile: UserProfile,
  feedContext: FeedContext
): number {
  const signals: RankingSignals = {
    relevance: calculateRelevance(story, userProfile),
    freshness: calculateFreshness(story),
    quality: calculateQuality(story),
    diversity: calculateDiversity(story, feedContext),
    trending: story.velocity
  };

  // Weighted combination
  return (
    signals.relevance * 0.35 +
    signals.freshness * 0.25 +
    signals.quality * 0.20 +
    signals.diversity * 0.10 +
    signals.trending * 0.10
  );
}

function calculateRelevance(story: Story, profile: UserProfile): number {
  let score = 0;

  // Topic match
  for (const topic of story.topics) {
    score += profile.topic_weights.get(topic) || 0;
  }

  // Entity match (people, companies user follows)
  const userEntities = profile.followed_entities || [];
  for (const entity of story.entities) {
    if (userEntities.includes(entity)) {
      score += 0.3;
    }
  }

  // Negative signal: already read
  if (profile.reading_history.some(a => a.story_id === story.id)) {
    score *= 0.1;  // Heavy penalty
  }

  return Math.min(score, 1);
}

function calculateFreshness(story: Story): number {
  const ageHours = (Date.now() - story.created_at.getTime()) / 3600000;

  // Exponential decay
  // Half-life of 6 hours
  return Math.exp(-ageHours / 6);
}

function calculateDiversity(story: Story, context: FeedContext): number {
  // Penalize if similar stories already in feed
  for (const existing of context.stories_so_far) {
    if (storiesAreSimilar(story, existing)) {
      return 0.3;  // Heavy penalty
    }
    if (hasSamePrimaryTopic(story, existing)) {
      return 0.7;  // Moderate penalty
    }
  }
  return 1.0;
}
```

### Feed Generation

```typescript
async function generateFeed(
  userId: string,
  cursor: string | null,
  limit: number = 20
): Promise<FeedResponse> {
  const userProfile = await getUserProfile(userId);

  // Get candidate stories
  const candidates = await getCandidateStories({
    max_age_hours: 48,
    topics: userProfile.top_topics,
    limit: 200
  });

  // Score and rank
  const feedContext: FeedContext = { stories_so_far: [] };
  const scored: ScoredStory[] = [];

  for (const story of candidates) {
    const score = calculateStoryScore(story, userProfile, feedContext);
    scored.push({ story, score });

    // Update context for diversity
    if (score > 0.5) {
      feedContext.stories_so_far.push(story);
    }
  }

  // Sort by score
  scored.sort((a, b) => b.score - a.score);

  // Apply pagination
  const startIndex = cursor ? parseInt(cursor) : 0;
  const results = scored.slice(startIndex, startIndex + limit);

  return {
    stories: results.map(s => enrichStory(s.story)),
    next_cursor: String(startIndex + limit),
    has_more: startIndex + limit < scored.length
  };
}
```

---

## Step 7: Deep Dive - Breaking News Detection (5 minutes)

### Velocity Tracking

```typescript
interface StoryVelocity {
  story_id: string;
  article_count: number;
  source_count: number;
  time_window_minutes: number;
  velocity: number;  // Articles per minute
}

async function trackVelocity(story: Story): Promise<void> {
  const now = Date.now();
  const windowMinutes = 30;

  // Count articles in sliding window
  const recentArticles = story.articles.filter(
    a => now - a.published_at.getTime() < windowMinutes * 60000
  );

  const velocity = recentArticles.length / windowMinutes;

  // Update story velocity
  await updateStoryVelocity(story.id, velocity);

  // Check for breaking news threshold
  if (velocity > 2 && recentArticles.length > 10) {
    // 10+ articles in 30 minutes from different sources
    const uniqueSources = new Set(recentArticles.map(a => a.source_id)).size;
    if (uniqueSources > 5) {
      await markAsBreakingNews(story);
    }
  }
}
```

### Breaking News Alert

```typescript
async function markAsBreakingNews(story: Story): Promise<void> {
  // Update story status
  await db.update('stories', story.id, {
    is_breaking: true,
    breaking_started_at: new Date()
  });

  // Notify users interested in this topic
  const interestedUsers = await getUsersInterestedIn(story.topics);

  for (const userId of interestedUsers) {
    if (await shouldNotify(userId, story)) {
      await sendPushNotification(userId, {
        title: 'Breaking News',
        body: story.title,
        data: { story_id: story.id }
      });
    }
  }
}
```

---

## Step 8: Data Model (3 minutes)

### PostgreSQL Schema

```sql
-- Sources
CREATE TABLE sources (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  domain VARCHAR(255) UNIQUE,
  feed_url VARCHAR(500),
  category VARCHAR(50),
  credibility_score DECIMAL(3, 2),
  crawl_frequency_minutes INTEGER DEFAULT 15,
  created_at TIMESTAMP
);

-- Articles
CREATE TABLE articles (
  id UUID PRIMARY KEY,
  source_id UUID REFERENCES sources(id),
  story_id UUID REFERENCES stories(id),
  url VARCHAR(1000) UNIQUE,
  title VARCHAR(500),
  summary TEXT,
  body TEXT,
  image_url VARCHAR(500),
  published_at TIMESTAMP,
  crawled_at TIMESTAMP,
  fingerprint BIGINT,  -- SimHash
  topics TEXT[],
  entities JSONB,  -- Named entities
  created_at TIMESTAMP
);

-- Stories (clustered articles)
CREATE TABLE stories (
  id UUID PRIMARY KEY,
  title VARCHAR(500),
  summary TEXT,
  primary_topic VARCHAR(50),
  topics TEXT[],
  entities JSONB,
  fingerprint BIGINT,
  article_count INTEGER DEFAULT 1,
  source_count INTEGER DEFAULT 1,
  velocity DECIMAL(10, 4) DEFAULT 0,
  is_breaking BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- User reading history
CREATE TABLE user_reading_history (
  user_id UUID REFERENCES users(id),
  article_id UUID REFERENCES articles(id),
  story_id UUID REFERENCES stories(id),
  read_at TIMESTAMP,
  dwell_time_seconds INTEGER,
  PRIMARY KEY (user_id, article_id)
);

-- Indexes
CREATE INDEX idx_articles_story ON articles(story_id);
CREATE INDEX idx_articles_published ON articles(published_at DESC);
CREATE INDEX idx_stories_topics ON stories USING GIN(topics);
CREATE INDEX idx_stories_velocity ON stories(velocity DESC) WHERE velocity > 0;
```

### Elasticsearch Mapping

```json
{
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "english" },
      "body": { "type": "text", "analyzer": "english" },
      "topics": { "type": "keyword" },
      "entities": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" },
          "type": { "type": "keyword" }
        }
      },
      "published_at": { "type": "date" },
      "source_id": { "type": "keyword" },
      "story_id": { "type": "keyword" },
      "velocity": { "type": "float" }
    }
  }
}
```

---

## Step 9: API Design (2 minutes)

### REST API

```
# Feed
GET /api/v1/feed?cursor=...&limit=20
Response: { stories: [...], next_cursor: "..." }

GET /api/v1/feed/topic/{topic}
GET /api/v1/feed/for-you

# Stories
GET /api/v1/stories/{id}
GET /api/v1/stories/{id}/articles  # All articles about story

# Search
GET /api/v1/search?q=climate+change&topic=politics&date_from=...

# Trending
GET /api/v1/trending
GET /api/v1/breaking

# User preferences
GET /api/v1/user/preferences
PUT /api/v1/user/preferences
Body: { topics: [...], sources: [...] }

POST /api/v1/user/reading-history
Body: { article_id, dwell_time_seconds }
```

---

## Step 10: Scalability (3 minutes)

### Crawling at Scale

- Distribute crawlers by domain
- Use consistent hashing for domain assignment
- Queue-based work distribution

### Deduplication at Scale

- Real-time: Check last 48 hours with LSH
- Batch: Nightly full re-clustering for older content
- Partition by topic for parallel processing

### Feed Generation

- Pre-compute feeds for active users
- Cache personalized feeds for 5 minutes
- Fall back to topic-based cache for cold users

### Geographic Distribution

- Edge caching for feed responses
- Regional crawler deployments
- Replicated Elasticsearch clusters

---

## Step 11: Trade-offs (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| SimHash for dedup | Fast, but may miss semantic similarity |
| 48-hour clustering window | Fresh clusters, but may split ongoing stories |
| Pre-computed feeds | Fast response, but slightly stale |
| Topic-based diversity | Broad coverage, but may miss depth |

### Alternatives Considered

1. **Semantic embeddings for dedup**
   - Better for paraphrased content
   - More compute intensive
   - Could use as secondary signal

2. **Real-time feed generation**
   - Always fresh
   - Higher latency, more compute
   - Use for active users

3. **Collaborative filtering for personalization**
   - "Users like you read..."
   - Cold start problem
   - Hybrid approach possible

---

## Closing Summary

"I've designed a news aggregator with:

1. **Distributed crawling** with rate limiting and RSS/scraping support
2. **SimHash + LSH deduplication** for grouping articles into stories
3. **Multi-signal ranking** balancing relevance, freshness, and diversity
4. **Velocity-based breaking news** detection for real-time alerts

The key insight is that this is a content processing pipeline. Most work (crawling, dedup, classification) happens asynchronously, enabling fast feed generation at query time. Happy to dive deeper into any component."

---

## Potential Follow-up Questions

1. **How would you handle fake news detection?**
   - Cross-reference claims across sources
   - Source credibility scoring
   - Fact-checking partnerships

2. **How would you handle a source that changes its layout?**
   - Monitor extraction success rates
   - Automatic layout learning
   - Fallback to RSS if available

3. **How would you personalize for new users?**
   - Onboarding topic selection
   - Location-based defaults
   - Popular/trending until profile builds

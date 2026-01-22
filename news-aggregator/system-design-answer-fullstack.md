# News Aggregator - Full-Stack System Design Interview Answer

*A 45-minute system design interview answer with balanced coverage of frontend, backend, and their integration points.*

---

## Opening Statement

"Today I'll design a news aggregator like Google News or Flipboard, covering both the backend content pipeline and frontend user experience. The core challenges span both layers: on the backend, crawling RSS feeds with rate limiting, deduplicating articles using SimHash, and ranking content with multiple signals; on the frontend, displaying clustered stories with source diversity indicators, implementing breaking news alerts, and tracking reading progress for personalization. I'll focus on how these systems integrate through shared types, real-time updates, and optimistic UI patterns."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

| Feature | Backend Responsibility | Frontend Responsibility |
|---------|------------------------|------------------------|
| Content Crawling | Fetch RSS feeds, parse articles | Display crawl status in admin |
| Deduplication | SimHash fingerprinting, clustering | Show "X sources" indicator |
| Personalization | Ranking algorithm, user preferences | Topic selector, preference UI |
| Feed Display | API with pagination, caching | Virtualized infinite scroll |
| Search | Elasticsearch query, filtering | Search bar, filters, results |
| Breaking News | Velocity detection, notifications | Alert banner, real-time updates |
| Reading Progress | Store dwell time, history | Track reads, sync periodically |

### Non-Functional Requirements

| Requirement | Target | Implementation |
|-------------|--------|----------------|
| Freshness | Breaking news < 5 min | Priority crawling + push updates |
| Feed Latency | p95 < 200ms | Redis cache + optimistic UI |
| Initial Load | < 2s | Code splitting, skeleton states |
| Offline Support | Read cached articles | Service worker, IndexedDB |

---

## Step 2: High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
│  │ Feed View │  │ Story     │  │ Search    │  │ Prefs     │  │ Admin     │ │
│  │           │  │ Detail    │  │ View      │  │ Panel     │  │ Dashboard │ │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘ │
│        │              │              │              │              │        │
│  ┌─────▼──────────────▼──────────────▼──────────────▼──────────────▼─────┐  │
│  │                        Zustand Stores                                  │  │
│  │   feedStore  │  preferencesStore  │  readingProgressStore  │  authStore│  │
│  └─────────────────────────────────────┬─────────────────────────────────┘  │
│                                        │                                     │
│  ┌─────────────────────────────────────▼─────────────────────────────────┐  │
│  │                         API Client Layer                               │  │
│  │   Axios instance │ Request interceptors │ Response transformers        │  │
│  └─────────────────────────────────────┬─────────────────────────────────┘  │
└────────────────────────────────────────┼─────────────────────────────────────┘
                                         │ HTTP/WebSocket
                                         │
┌────────────────────────────────────────┼─────────────────────────────────────┐
│                              BACKEND   │                                      │
│  ┌─────────────────────────────────────▼─────────────────────────────────┐  │
│  │                           API Gateway                                  │  │
│  │     Rate Limiting │ Authentication │ Request Validation                │  │
│  └───────────┬───────────────┬───────────────┬───────────────┬───────────┘  │
│              │               │               │               │               │
│  ┌───────────▼───┐  ┌───────▼───────┐  ┌───▼───────────┐  ┌▼───────────┐   │
│  │ Feed Service  │  │ Search Service│  │ User Service  │  │ Admin API  │   │
│  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘  └──────┬─────┘   │
│          │                  │                  │                 │          │
│  ┌───────▼──────────────────▼──────────────────▼─────────────────▼───────┐  │
│  │                         Data Layer                                     │  │
│  │   PostgreSQL │ Redis │ Elasticsearch                                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Background Services                               │    │
│  │   Crawler │ Deduplicator │ Indexer │ Breaking News Detector         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Shared Type Definitions (5 minutes)

Shared types ensure frontend and backend stay in sync:

```typescript
// shared/types.ts

// ===== Core Domain Types =====

export interface Source {
  id: string;
  name: string;
  homepage: string;
  favicon: string;
  category: 'mainstream' | 'tech' | 'local' | 'opinion';
  credibilityScore: number;  // 0.0 to 1.0
}

export interface Article {
  id: string;
  sourceId: string;
  storyClusterId: string;
  url: string;
  title: string;
  summary: string;
  author: string | null;
  imageUrl: string | null;
  publishedAt: string;  // ISO 8601
  topics: string[];
}

export interface StoryCluster {
  id: string;
  title: string;
  summary: string;
  primaryImageUrl: string | null;
  primaryTopic: string;
  topics: string[];
  articleCount: number;
  sourceCount: number;
  sources: Source[];
  velocity: number;
  isBreaking: boolean;
  firstSeenAt: string;
  lastUpdatedAt: string;
}

export interface Topic {
  id: string;
  displayName: string;
  keywords: string[];
  articleCount: number;
}

// ===== User Types =====

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  createdAt: string;
}

export interface UserPreferences {
  topics: string[];
  preferredSources: string[];
  excludedSources: string[];
}

export interface ReadingHistoryEntry {
  storyClusterId: string;
  readAt: string;
  dwellTimeSeconds: number;
}

// ===== API Request/Response Types =====

export interface FeedRequest {
  cursor?: string;
  limit?: number;
  topic?: string;
}

export interface FeedResponse {
  stories: StoryCluster[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SearchRequest {
  query: string;
  topic?: string;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  total: number;
}

export interface SearchHit {
  article: Article;
  highlights: {
    title?: string[];
    summary?: string[];
  };
  score: number;
}

export interface BreakingNewsResponse {
  stories: StoryCluster[];
}

// ===== WebSocket Event Types =====

export interface WSBreakingNewsEvent {
  type: 'breaking_news';
  story: StoryCluster;
}

export interface WSFeedUpdateEvent {
  type: 'feed_update';
  newStories: number;
}

export type WSEvent = WSBreakingNewsEvent | WSFeedUpdateEvent;
```

---

## Step 4: Deep Dive - Content Pipeline (8 minutes)

### Backend: Crawl and Deduplication Flow

```typescript
// backend/src/crawler/crawlService.ts

class CrawlPipeline {
  private simhasher = new SimHasher();
  private rateLimiter = new DomainRateLimiter();

  async processFeed(source: Source): Promise<ProcessResult> {
    // Rate limit per domain
    await this.rateLimiter.acquire(new URL(source.url).hostname);

    // Fetch and parse RSS
    const articles = await this.fetchRSS(source.url);

    const results = {
      new: 0,
      duplicate: 0,
      clustered: 0,
    };

    for (const article of articles) {
      // Check if already exists by external ID
      const exists = await db.query(
        'SELECT id FROM articles WHERE source_id = $1 AND external_id = $2',
        [source.id, article.externalId]
      );

      if (exists.rows.length > 0) {
        results.duplicate++;
        continue;
      }

      // Compute SimHash fingerprint
      const fingerprint = this.simhasher.computeFingerprint(
        `${article.title} ${article.summary}`
      );

      // Find matching story cluster
      const cluster = await this.findOrCreateCluster(article, fingerprint);

      // Insert article
      await db.query(`
        INSERT INTO articles (
          source_id, story_cluster_id, external_id, url,
          title, summary, published_at, fingerprint, topics
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        source.id, cluster.id, article.externalId, article.url,
        article.title, article.summary, article.publishedAt,
        fingerprint.toString(), article.topics
      ]);

      // Queue for Elasticsearch indexing
      await redis.rpush('index:queue', JSON.stringify({
        articleId: article.id,
        clusterId: cluster.id,
      }));

      results.new++;
      if (cluster.isNew) results.clustered++;
    }

    // Check for breaking news
    await this.checkBreakingNews(articles.map(a => a.storyClusterId));

    return results;
  }

  private async findOrCreateCluster(
    article: ParsedArticle,
    fingerprint: bigint
  ): Promise<{ id: string; isNew: boolean }> {
    // Find clusters with similar fingerprints (Hamming distance <= 3)
    const candidates = await db.query(`
      SELECT id, fingerprint
      FROM story_clusters
      WHERE last_updated_at > NOW() - INTERVAL '48 hours'
        AND hamming_distance(fingerprint, $1) <= 3
      ORDER BY last_updated_at DESC
      LIMIT 1
    `, [fingerprint.toString()]);

    if (candidates.rows.length > 0) {
      const cluster = candidates.rows[0];

      // Update cluster stats
      await db.query(`
        UPDATE story_clusters
        SET
          article_count = article_count + 1,
          source_count = (
            SELECT COUNT(DISTINCT source_id) FROM articles
            WHERE story_cluster_id = $1
          ) + 1,
          last_updated_at = NOW()
        WHERE id = $1
      `, [cluster.id]);

      return { id: cluster.id, isNew: false };
    }

    // Create new cluster
    const result = await db.query(`
      INSERT INTO story_clusters (title, fingerprint, primary_topic, topics)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [article.title, fingerprint.toString(), article.topics[0], article.topics]);

    return { id: result.rows[0].id, isNew: true };
  }
}
```

### Frontend: Displaying Source Diversity

```tsx
// frontend/src/components/StoryCard.tsx

interface StoryCardProps {
  story: StoryCluster;
  onSourceClick: (sourceId: string) => void;
}

export function StoryCard({ story, onSourceClick }: StoryCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <article className="rounded-lg border bg-white p-4 shadow-sm">
      {/* Breaking indicator */}
      {story.isBreaking && <BreakingBadge />}

      {/* Main content */}
      <div className="flex gap-4">
        {story.primaryImageUrl && (
          <ProgressiveImage
            src={story.primaryImageUrl}
            alt=""
            className="h-24 w-32 rounded"
          />
        )}

        <div className="flex-1">
          <TopicBadges topics={story.topics.slice(0, 2)} />

          <h3 className="mt-1 text-lg font-semibold">
            <Link to={`/story/${story.id}`}>{story.title}</Link>
          </h3>

          <p className="mt-1 line-clamp-2 text-sm text-gray-600">
            {story.summary}
          </p>
        </div>
      </div>

      {/* Source diversity indicator */}
      <div className="mt-3 border-t pt-3">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex w-full items-center justify-between text-sm"
          aria-expanded={isExpanded}
        >
          <SourceStack sources={story.sources} maxShow={4} />

          <span className="text-gray-500">
            {story.sourceCount} source{story.sourceCount !== 1 && 's'}
            <ChevronIcon
              className={cn(
                'ml-1 inline h-4 w-4 transition-transform',
                isExpanded && 'rotate-180'
              )}
            />
          </span>
        </button>

        {/* Expanded source list */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              className="mt-2 overflow-hidden"
            >
              <ul className="space-y-2">
                {story.sources.map((source) => (
                  <li key={source.id}>
                    <button
                      onClick={() => onSourceClick(source.id)}
                      className="flex items-center gap-2 text-sm hover:text-blue-600"
                    >
                      <img
                        src={source.favicon}
                        alt=""
                        className="h-4 w-4 rounded"
                      />
                      <span>{source.name}</span>
                      <CredibilityBadge score={source.credibilityScore} />
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </article>
  );
}

function SourceStack({ sources, maxShow }: { sources: Source[]; maxShow: number }) {
  const visible = sources.slice(0, maxShow);
  const remaining = sources.length - maxShow;

  return (
    <div className="flex -space-x-1">
      {visible.map((source, i) => (
        <img
          key={source.id}
          src={source.favicon}
          alt={source.name}
          title={source.name}
          className="h-5 w-5 rounded-full border-2 border-white"
          style={{ zIndex: maxShow - i }}
        />
      ))}
      {remaining > 0 && (
        <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-gray-200 text-xs">
          +{remaining}
        </span>
      )}
    </div>
  );
}
```

---

## Step 5: Deep Dive - Feed Ranking and Display (8 minutes)

### Backend: Multi-Signal Ranking

```typescript
// backend/src/feed/rankingService.ts

interface RankingContext {
  userPrefs: UserPreferences;
  readHistory: Set<string>;
  topicsInFeed: Map<string, number>;
  sourcesInFeed: Set<string>;
}

class FeedRanker {
  private weights = {
    relevance: 0.35,
    freshness: 0.25,
    quality: 0.20,
    diversity: 0.10,
    trending: 0.10,
  };

  async generateFeed(
    userId: string,
    cursor: number,
    limit: number
  ): Promise<FeedResponse> {
    // Try cache first
    const cacheKey = `feed:user:${userId}:${cursor}:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Load user context
    const [userPrefs, readHistory] = await Promise.all([
      this.getUserPreferences(userId),
      this.getReadHistory(userId),
    ]);

    // Get candidate stories
    const candidates = await db.query<StoryCluster>(`
      SELECT * FROM story_clusters
      WHERE last_updated_at > NOW() - INTERVAL '48 hours'
      ORDER BY last_updated_at DESC
      LIMIT 500
    `);

    // Score and rank
    const context: RankingContext = {
      userPrefs,
      readHistory,
      topicsInFeed: new Map(),
      sourcesInFeed: new Set(),
    };

    const scored = candidates.rows.map((story) => ({
      story,
      score: this.scoreStory(story, context),
    }));

    // Sort by score
    scored.sort((a, b) => b.score - a.score);

    // Apply pagination
    const page = scored.slice(cursor, cursor + limit);

    const response: FeedResponse = {
      stories: page.map((s) => this.enrichStory(s.story)),
      nextCursor: cursor + limit < scored.length ? String(cursor + limit) : null,
      hasMore: cursor + limit < scored.length,
    };

    // Cache for 60 seconds
    await redis.setex(cacheKey, 60, JSON.stringify(response));

    return response;
  }

  private scoreStory(story: StoryCluster, ctx: RankingContext): number {
    const signals = {
      relevance: this.computeRelevance(story, ctx.userPrefs, ctx.readHistory),
      freshness: this.computeFreshness(story),
      quality: this.computeQuality(story),
      diversity: this.computeDiversity(story, ctx),
      trending: Math.min(story.velocity / 10, 1),
    };

    let score =
      signals.relevance * this.weights.relevance +
      signals.freshness * this.weights.freshness +
      signals.quality * this.weights.quality +
      signals.diversity * this.weights.diversity +
      signals.trending * this.weights.trending;

    // Breaking news boost
    if (story.isBreaking) {
      score *= 1.3;
    }

    // Update context for diversity
    ctx.topicsInFeed.set(
      story.primaryTopic,
      (ctx.topicsInFeed.get(story.primaryTopic) || 0) + 1
    );

    return score;
  }

  private computeRelevance(
    story: StoryCluster,
    prefs: UserPreferences,
    readHistory: Set<string>
  ): number {
    let score = 0;

    // Topic match
    for (const topic of story.topics) {
      if (prefs.topics.includes(topic)) {
        score += 0.3;
      }
    }

    // Preferred source bonus
    const hasPreferredSource = story.sources.some((s) =>
      prefs.preferredSources.includes(s.id)
    );
    if (hasPreferredSource) score += 0.2;

    // Already read penalty
    if (readHistory.has(story.id)) {
      score *= 0.1;
    }

    return Math.min(score, 1);
  }

  private computeFreshness(story: StoryCluster): number {
    const ageHours =
      (Date.now() - new Date(story.firstSeenAt).getTime()) / 3600000;

    // Exponential decay with 6-hour half-life
    return Math.exp(-ageHours * Math.LN2 / 6);
  }

  private computeQuality(story: StoryCluster): number {
    // Multi-source coverage indicates important story
    const sourceScore = Math.min(story.sourceCount / 5, 1);

    // Average source credibility
    const avgCredibility =
      story.sources.reduce((sum, s) => sum + s.credibilityScore, 0) /
      story.sources.length;

    return sourceScore * 0.6 + avgCredibility * 0.4;
  }

  private computeDiversity(story: StoryCluster, ctx: RankingContext): number {
    const topicCount = ctx.topicsInFeed.get(story.primaryTopic) || 0;
    return Math.max(0, 1 - topicCount * 0.2);
  }
}
```

### Frontend: Virtualized Feed with Skeleton States

```tsx
// frontend/src/routes/index.tsx

export function FeedPage() {
  const { stories, isLoading, hasMore, loadMore, refresh } = useFeedStore();
  const { breakingStory, dismiss } = useBreakingNews();

  return (
    <div className="mx-auto max-w-3xl">
      {/* Breaking news banner */}
      {breakingStory && (
        <BreakingNewsBanner
          story={breakingStory}
          onDismiss={() => dismiss(breakingStory.id)}
        />
      )}

      {/* Topic navigation */}
      <TopicNav />

      {/* Pull to refresh (mobile) */}
      <PullToRefresh onRefresh={refresh}>
        {/* Feed content */}
        {stories.length === 0 && isLoading ? (
          <FeedSkeleton count={5} />
        ) : (
          <VirtualizedStoryList
            stories={stories}
            hasMore={hasMore}
            isLoading={isLoading}
            onLoadMore={loadMore}
          />
        )}
      </PullToRefresh>
    </div>
  );
}

// Zustand store with API integration
export const useFeedStore = create<FeedState>((set, get) => ({
  stories: [],
  cursor: null,
  hasMore: true,
  isLoading: false,

  loadFeed: async (reset = false) => {
    if (get().isLoading) return;
    set({ isLoading: true });

    try {
      const cursor = reset ? undefined : get().cursor ?? undefined;
      const response = await api.get<FeedResponse>('/api/v1/feed', {
        params: { cursor, limit: 20 },
      });

      set({
        stories: reset
          ? response.data.stories
          : [...get().stories, ...response.data.stories],
        cursor: response.data.nextCursor,
        hasMore: response.data.hasMore,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  loadMore: () => get().loadFeed(false),
  refresh: () => get().loadFeed(true),
}));
```

---

## Step 6: Deep Dive - Breaking News System (8 minutes)

### Backend: Velocity Detection and Notifications

```typescript
// backend/src/breaking/breakingNewsService.ts

class BreakingNewsDetector {
  private readonly VELOCITY_THRESHOLD = 2;  // articles/minute
  private readonly SOURCE_THRESHOLD = 5;   // unique sources
  private readonly WINDOW_MINUTES = 30;

  async checkCluster(clusterId: string): Promise<void> {
    const windowStart = new Date(Date.now() - this.WINDOW_MINUTES * 60000);

    // Get recent article stats
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
      UPDATE story_clusters SET velocity = $2 WHERE id = $1
    `, [clusterId, velocity]);

    // Check breaking threshold
    if (
      velocity > this.VELOCITY_THRESHOLD &&
      source_count >= this.SOURCE_THRESHOLD
    ) {
      await this.markAsBreaking(clusterId);
    }
  }

  private async markAsBreaking(clusterId: string): Promise<void> {
    // Only mark if not already breaking
    const result = await db.query(`
      UPDATE story_clusters
      SET is_breaking = true, breaking_started_at = NOW()
      WHERE id = $1 AND is_breaking = false
      RETURNING *
    `, [clusterId]);

    if (result.rows.length > 0) {
      const story = result.rows[0];

      // Broadcast to WebSocket clients
      await this.broadcastBreakingNews(story);

      // Queue push notifications for interested users
      await this.notifyUsers(story);
    }
  }

  private async broadcastBreakingNews(story: StoryCluster): Promise<void> {
    const event: WSBreakingNewsEvent = {
      type: 'breaking_news',
      story: this.enrichStory(story),
    };

    // Publish to Redis pub/sub for all API servers
    await redis.publish('breaking-news', JSON.stringify(event));
  }

  private async notifyUsers(story: StoryCluster): Promise<void> {
    // Find users interested in these topics with push enabled
    const users = await db.query(`
      SELECT u.id, u.push_token
      FROM users u
      JOIN user_preferences up ON u.id = up.user_id
      WHERE u.push_enabled = true
        AND up.topics ?| $1
    `, [story.topics]);

    for (const user of users.rows) {
      await redis.rpush('push:queue', JSON.stringify({
        userId: user.id,
        token: user.push_token,
        title: 'Breaking News',
        body: story.title,
        data: { storyId: story.id },
      }));
    }
  }
}
```

### Frontend: Real-time Breaking News UI

```tsx
// frontend/src/hooks/useBreakingNews.ts

export function useBreakingNews() {
  const [breakingStory, setBreakingStory] = useState<StoryCluster | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Establish WebSocket connection
    const ws = new WebSocket(WS_URL);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as WSEvent;

      if (data.type === 'breaking_news') {
        const story = data.story;

        // Only show if not dismissed
        if (!dismissedIds.has(story.id)) {
          setBreakingStory(story);

          // Play notification sound
          playNotificationSound();

          // Show browser notification if permitted
          if (Notification.permission === 'granted') {
            new Notification('Breaking News', {
              body: story.title,
              icon: '/breaking-icon.png',
              tag: story.id,  // Prevents duplicates
            });
          }
        }
      }
    };

    // Fallback polling for when WebSocket disconnects
    const pollInterval = setInterval(async () => {
      if (ws.readyState !== WebSocket.OPEN) {
        try {
          const response = await api.get<BreakingNewsResponse>('/api/v1/breaking');
          const story = response.data.stories.find(s => !dismissedIds.has(s.id));
          if (story && story.id !== breakingStory?.id) {
            setBreakingStory(story);
          }
        } catch {
          // Ignore polling errors
        }
      }
    }, 30000);

    return () => {
      ws.close();
      clearInterval(pollInterval);
    };
  }, [dismissedIds, breakingStory?.id]);

  const dismiss = useCallback((storyId: string) => {
    setDismissedIds(prev => new Set([...prev, storyId]));
    setBreakingStory(null);
  }, []);

  return { breakingStory, dismiss };
}

// frontend/src/components/BreakingNewsBanner.tsx

export function BreakingNewsBanner({
  story,
  onDismiss,
}: {
  story: StoryCluster;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-0 top-0 z-50 bg-red-600 text-white shadow-lg"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2">
        <div className="flex items-center gap-3">
          <PulsingDot />
          <span className="font-bold uppercase">Breaking</span>

          <button
            onClick={() => navigate(`/story/${story.id}`)}
            className="truncate hover:underline"
          >
            {story.title}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <SourceStack sources={story.sources} maxShow={3} />

          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="rounded p-1 hover:bg-red-700"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## Step 7: Deep Dive - Reading Progress Sync (5 minutes)

### Backend: Reading History API

```typescript
// backend/src/user/readingHistoryService.ts

class ReadingHistoryService {
  async recordReads(
    userId: string,
    entries: ReadingHistoryEntry[]
  ): Promise<void> {
    // Batch upsert
    const values = entries.map((e, i) => {
      const offset = i * 4;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    }).join(', ');

    const params = entries.flatMap((e) => [
      userId,
      e.storyClusterId,
      e.readAt,
      e.dwellTimeSeconds,
    ]);

    await db.query(`
      INSERT INTO user_reading_history (
        user_id, story_cluster_id, read_at, dwell_time_seconds
      ) VALUES ${values}
      ON CONFLICT (user_id, story_cluster_id)
      DO UPDATE SET
        dwell_time_seconds = user_reading_history.dwell_time_seconds + EXCLUDED.dwell_time_seconds,
        read_at = GREATEST(user_reading_history.read_at, EXCLUDED.read_at)
    `, params);

    // Invalidate feed cache
    const keys = await redis.keys(`feed:user:${userId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  async getReadHistory(userId: string, limit = 100): Promise<string[]> {
    const result = await db.query(`
      SELECT story_cluster_id FROM user_reading_history
      WHERE user_id = $1
      ORDER BY read_at DESC
      LIMIT $2
    `, [userId, limit]);

    return result.rows.map((r) => r.story_cluster_id);
  }
}

// Route handler
router.post('/api/v1/reading-history', requireAuth, async (req, res) => {
  const { entries } = req.body as { entries: ReadingHistoryEntry[] };

  await readingHistoryService.recordReads(req.session.userId, entries);

  res.json({ success: true });
});
```

### Frontend: Dwell Time Tracking and Sync

```tsx
// frontend/src/stores/readingProgressStore.ts

interface ReadingProgressState {
  readStories: Set<string>;
  pendingEntries: ReadingHistoryEntry[];

  markAsRead: (storyId: string) => void;
  trackDwellTime: (storyId: string, seconds: number) => void;
  syncToServer: () => Promise<void>;
}

export const useReadingProgressStore = create<ReadingProgressState>()(
  persist(
    (set, get) => ({
      readStories: new Set(),
      pendingEntries: [],

      markAsRead: (storyId: string) => {
        set((state) => ({
          readStories: new Set([...state.readStories, storyId]),
          pendingEntries: [
            ...state.pendingEntries,
            {
              storyClusterId: storyId,
              readAt: new Date().toISOString(),
              dwellTimeSeconds: 0,
            },
          ],
        }));
      },

      trackDwellTime: (storyId: string, seconds: number) => {
        set((state) => {
          const existing = state.pendingEntries.find(
            (e) => e.storyClusterId === storyId
          );

          if (existing) {
            return {
              pendingEntries: state.pendingEntries.map((e) =>
                e.storyClusterId === storyId
                  ? { ...e, dwellTimeSeconds: e.dwellTimeSeconds + seconds }
                  : e
              ),
            };
          }

          return {
            pendingEntries: [
              ...state.pendingEntries,
              {
                storyClusterId: storyId,
                readAt: new Date().toISOString(),
                dwellTimeSeconds: seconds,
              },
            ],
          };
        });
      },

      syncToServer: async () => {
        const entries = get().pendingEntries;
        if (entries.length === 0) return;

        try {
          await api.post('/api/v1/reading-history', { entries });

          // Clear synced entries
          set({ pendingEntries: [] });
        } catch (error) {
          // Keep entries for retry
          console.error('Failed to sync reading history:', error);
        }
      },
    }),
    {
      name: 'reading-progress',
      storage: createJSONStorage(() => localStorage),
    }
  )
);

// Periodic sync hook
export function useReadingHistorySync() {
  const syncToServer = useReadingProgressStore((s) => s.syncToServer);

  useEffect(() => {
    // Sync every 30 seconds
    const interval = setInterval(syncToServer, 30000);

    // Sync on page unload
    window.addEventListener('beforeunload', syncToServer);

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', syncToServer);
    };
  }, [syncToServer]);
}

// Dwell time tracker hook
export function useDwellTimeTracker(storyId: string) {
  const trackDwellTime = useReadingProgressStore((s) => s.trackDwellTime);
  const startTime = useRef(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime.current) / 1000);
      if (elapsed > 0) {
        trackDwellTime(storyId, elapsed);
        startTime.current = Date.now();
      }
    }, 10000);

    return () => {
      clearInterval(interval);
      // Track remaining time on unmount
      const remaining = Math.floor((Date.now() - startTime.current) / 1000);
      if (remaining > 0) {
        trackDwellTime(storyId, remaining);
      }
    };
  }, [storyId, trackDwellTime]);
}
```

---

## Step 8: Error Handling Strategy (3 minutes)

### Backend: Centralized Error Handling

```typescript
// backend/src/shared/errors.ts

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

// Error middleware
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  // Unknown error
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
```

### Frontend: Error Boundary and Toast

```tsx
// frontend/src/components/ErrorBoundary.tsx

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Error boundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900">
              Something went wrong
            </h1>
            <p className="mt-2 text-gray-600">
              {this.state.error?.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded bg-blue-600 px-4 py-2 text-white"
            >
              Refresh page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// API error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = error.response?.data?.error?.message || 'Network error';

    toast.error(message);

    // Handle auth errors
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }

    return Promise.reject(error);
  }
);
```

---

## Trade-offs Summary

| Decision | Chosen Approach | Alternative | Trade-off |
|----------|-----------------|-------------|-----------|
| Breaking news delivery | WebSocket + polling fallback | Server-Sent Events | Bi-directional capability vs simpler protocol |
| Feed caching | 60s Redis TTL | Real-time generation | Fast response vs always-fresh |
| Reading history sync | Periodic batch (30s) | Real-time per-read | Lower API calls vs immediate personalization |
| Deduplication | SimHash 64-bit | Semantic embeddings | Fast O(1) compare vs better paraphrase detection |
| State management | Zustand | React Query | Simpler model vs built-in caching |
| Source diversity UI | Expandable list | Always visible grid | Cleaner initial view vs immediate visibility |

---

## Future Enhancements

1. **Collaborative Filtering** - "Users like you read..." recommendations
2. **ML Topic Extraction** - Replace keyword matching with trained classifier
3. **Semantic Search** - Vector similarity for concept-based queries
4. **Offline Mode PWA** - Service worker for cached article reading
5. **Source Credibility ML** - Automated scoring based on accuracy history
6. **A/B Testing Framework** - Compare ranking algorithm variants

---

## Closing Summary

"I've designed a full-stack news aggregator with:

1. **Content Pipeline** - RSS crawling with rate limiting, SimHash deduplication, and story clustering
2. **Multi-signal Ranking** - Combining relevance, freshness, quality, diversity, and trending signals
3. **Breaking News System** - Velocity detection on backend, WebSocket push to frontend
4. **Source Diversity UI** - Showing multiple perspectives with credibility indicators
5. **Reading Progress Sync** - Frontend dwell time tracking with periodic backend sync

The key integration points are: shared TypeScript types for API contracts, WebSocket for real-time breaking news, and periodic sync for reading history. The backend focuses on data processing and caching, while the frontend handles virtualized rendering and optimistic updates. Happy to dive deeper into any layer."

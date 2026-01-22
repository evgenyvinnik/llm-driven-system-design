# App Store - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design the backend infrastructure for the App Store, Apple's digital marketplace serving 2M+ apps and billions of downloads. Key backend challenges include:
- Multi-signal ranking algorithms resistant to manipulation
- ML-based fake review detection at scale
- Secure purchase flows with receipt validation
- High-throughput search with Elasticsearch
- Async processing with message queues

## Requirements Clarification

### Functional Requirements
1. **Catalog Management**: Store and serve app metadata, binaries, and media
2. **Search & Discovery**: Full-text search with filters and quality re-ranking
3. **Ranking System**: Multi-signal algorithm for charts (Top Free, Paid, Grossing)
4. **Review Processing**: Submit, validate, and score reviews for integrity
5. **Purchase Flow**: Secure payment processing and receipt generation

### Non-Functional Requirements
1. **Throughput**: Support 10M+ daily downloads
2. **Latency**: < 100ms for search, < 10ms for cached app lookups
3. **Consistency**: Strong consistency for purchases, eventual for rankings
4. **Availability**: 99.99% for purchase endpoints

### Scale Estimates
- 2 million apps in catalog
- 500 million weekly visitors
- 10 billion downloads/year (~300 downloads/second average)
- Thousands of new app submissions daily

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          CDN Layer                               │
│              (App binaries, screenshots, videos)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway                               │
│              (Rate limiting, authentication)                     │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Catalog Service│    │Purchase Service│    │Review Service │
│               │    │               │    │               │
│ - Search      │    │ - Checkout    │    │ - Submission  │
│ - Rankings    │    │ - Receipts    │    │ - Integrity   │
│ - Recs        │    │ - Subs        │    │ - Moderation  │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Data Layer                                │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Elasticsearch   │         Redis             │
│   - Apps        │   - Search index  │   - Sessions              │
│   - Purchases   │   - Suggestions   │   - Rate limits           │
│   - Reviews     │   - Similar apps  │   - Idempotency cache     │
└─────────────────┴───────────────────┴───────────────────────────┘
```

## Deep Dive: Database Schema Design

### Core Tables

```sql
-- Developers
CREATE TABLE developers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  company_name VARCHAR(200) NOT NULL,
  website VARCHAR(500),
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Apps with ranking metadata
CREATE TABLE apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id VARCHAR(200) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  developer_id UUID REFERENCES developers(id),
  category VARCHAR(100),
  subcategory VARCHAR(100),
  description TEXT,
  version VARCHAR(50),
  size_bytes BIGINT,
  age_rating VARCHAR(20),
  is_free BOOLEAN DEFAULT TRUE,

  -- Aggregated metrics for ranking
  download_count BIGINT DEFAULT 0,
  rating_sum DECIMAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  average_rating DECIMAL GENERATED ALWAYS AS (
    CASE WHEN rating_count > 0 THEN rating_sum / rating_count ELSE 0 END
  ) STORED,

  -- Engagement metrics from analytics
  dau INTEGER DEFAULT 0,
  mau INTEGER DEFAULT 0,
  day7_retention DECIMAL DEFAULT 0,
  avg_session_minutes DECIMAL DEFAULT 0,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_apps_category ON apps(category);
CREATE INDEX idx_apps_developer ON apps(developer_id);
CREATE INDEX idx_apps_ranking ON apps(category, download_count DESC);

-- Reviews with integrity scoring
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  app_id UUID REFERENCES apps(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  body TEXT,

  -- Integrity analysis
  integrity_score DECIMAL,
  integrity_signals JSONB,
  status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected

  -- Developer response
  developer_response TEXT,
  developer_response_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, app_id) -- One review per user per app
);

CREATE INDEX idx_reviews_app ON reviews(app_id, created_at DESC);
CREATE INDEX idx_reviews_status ON reviews(status) WHERE status = 'pending';

-- Precomputed daily rankings
CREATE TABLE rankings (
  date DATE,
  country VARCHAR(2),
  category VARCHAR(100),
  rank_type VARCHAR(20), -- 'free', 'paid', 'grossing'
  app_id UUID REFERENCES apps(id),
  rank INTEGER,
  score DECIMAL,
  PRIMARY KEY (date, country, category, rank_type, app_id)
);

-- Purchase with receipt data
CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  app_id UUID REFERENCES apps(id),
  price_id UUID REFERENCES app_prices(id),
  amount DECIMAL NOT NULL,
  currency VARCHAR(3) NOT NULL,
  payment_provider_id VARCHAR(100),
  receipt_data TEXT,
  purchased_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP -- For subscriptions
);

CREATE INDEX idx_purchases_user ON purchases(user_id);
CREATE INDEX idx_purchases_app_user ON purchases(app_id, user_id);
```

## Deep Dive: Multi-Signal Ranking Algorithm

### Ranking Service Implementation

```typescript
interface RankingSignals {
  downloadVelocity: number;
  ratingScore: number;
  engagementScore: number;
  revenueScore: number;
  freshnessScore: number;
}

class RankingService {
  private readonly WEIGHTS = {
    downloadVelocity: 0.30,
    ratingScore: 0.25,
    engagementScore: 0.20,
    revenueScore: 0.15,
    freshnessScore: 0.10,
  };

  async computeRankings(category: string, country: string): Promise<void> {
    const apps = await this.getAppsInCategory(category, country);
    const categoryMedian = await this.getCategoryDownloadMedian(category);

    const rankedApps = apps.map(app => {
      const signals = this.computeSignals(app, categoryMedian);
      const score = this.computeFinalScore(signals);
      return { appId: app.id, score, signals };
    });

    // Sort and persist rankings
    rankedApps.sort((a, b) => b.score - a.score);

    await db.query(`
      INSERT INTO rankings (date, country, category, rank_type, app_id, rank, score)
      SELECT
        CURRENT_DATE, $1, $2, 'free',
        unnest($3::uuid[]),
        generate_series(1, array_length($3, 1)),
        unnest($4::decimal[])
      ON CONFLICT (date, country, category, rank_type, app_id)
      DO UPDATE SET rank = EXCLUDED.rank, score = EXCLUDED.score
    `, [country, category, rankedApps.map(r => r.appId), rankedApps.map(r => r.score)]);
  }

  private computeSignals(app: App, categoryMedian: number): RankingSignals {
    return {
      downloadVelocity: this.computeDownloadVelocity(app, categoryMedian),
      ratingScore: this.computeBayesianRating(app),
      engagementScore: this.computeEngagement(app),
      revenueScore: this.computeRevenue(app),
      freshnessScore: this.computeFreshness(app),
    };
  }

  /**
   * Download velocity with exponential decay
   * Recent downloads weighted more heavily to catch trends
   */
  private computeDownloadVelocity(app: App, categoryMedian: number): number {
    const now = Date.now();
    let weightedDownloads = 0;

    for (const day of app.dailyDownloads) {
      const daysAgo = (now - day.date.getTime()) / (24 * 60 * 60 * 1000);
      // Half-life of 1 week
      const weight = Math.exp(-daysAgo / 7);
      weightedDownloads += day.count * weight;
    }

    // Normalize by category median to compare fairly
    return Math.log1p(weightedDownloads / Math.max(categoryMedian, 1));
  }

  /**
   * Bayesian average rating
   * Prevents gaming with early fake reviews
   */
  private computeBayesianRating(app: App): number {
    const C = 100;  // Confidence parameter (prior weight)
    const m = 3.5;  // Global average rating

    const bayesianRating = (C * m + app.ratingSum) / (C + app.ratingCount);

    // Penalize apps with very few ratings
    const countMultiplier = Math.min(1, app.ratingCount / 50);

    return (bayesianRating / 5.0) * countMultiplier;
  }

  /**
   * Engagement metrics are harder to fake
   * Requires real user behavior
   */
  private computeEngagement(app: App): number {
    const dauMauRatio = app.dau / Math.max(app.mau, 1);
    const sessionScore = Math.min(app.avgSessionMinutes / 10, 1);
    const retentionScore = app.day7Retention;

    return dauMauRatio * 0.4 + sessionScore * 0.3 + retentionScore * 0.3;
  }

  private computeFinalScore(signals: RankingSignals): number {
    return Object.entries(this.WEIGHTS).reduce((sum, [signal, weight]) => {
      return sum + signals[signal as keyof RankingSignals] * weight;
    }, 0);
  }
}
```

## Deep Dive: Review Integrity System

### Multi-Signal Fake Review Detection

```typescript
interface IntegritySignal {
  name: string;
  score: number;  // 0.0 = suspicious, 1.0 = legitimate
  weight: number;
  reason?: string;
}

class ReviewIntegrityService {
  async analyzeReview(
    review: ReviewSubmission,
    userId: string,
    appId: string
  ): Promise<IntegrityResult> {
    const signals: IntegritySignal[] = [];

    // 1. Review velocity - suspicious if many reviews in short time
    const userReviews = await this.getUserRecentReviews(userId, 24);
    signals.push({
      name: 'review_velocity',
      score: this.checkVelocity(userReviews),
      weight: 0.15,
    });

    // 2. Content quality - check for generic/templated content
    signals.push({
      name: 'content_quality',
      score: await this.analyzeContent(review.body),
      weight: 0.25,
    });

    // 3. Account age - new accounts are more suspicious
    const accountAge = await this.getAccountAge(userId);
    signals.push({
      name: 'account_age',
      score: Math.min(accountAge / 30, 1), // Full trust after 30 days
      weight: 0.10,
    });

    // 4. Verified purchase - did user actually download the app?
    const hasPurchased = await this.verifyPurchase(userId, appId);
    signals.push({
      name: 'verified_purchase',
      score: hasPurchased ? 1.0 : 0.3,
      weight: 0.20,
    });

    // 5. Coordination detection - review bombing patterns
    signals.push({
      name: 'coordination',
      score: await this.checkCoordination(appId, review),
      weight: 0.20,
    });

    // 6. Text originality - similarity to other reviews
    signals.push({
      name: 'originality',
      score: await this.checkOriginality(review.body, appId),
      weight: 0.10,
    });

    const integrityScore = signals.reduce(
      (sum, s) => sum + s.score * s.weight, 0
    );

    return {
      integrityScore,
      signals,
      action: this.determineAction(integrityScore),
    };
  }

  private checkVelocity(recentReviews: Review[]): number {
    if (recentReviews.length > 5) return 0.2;  // Very suspicious
    if (recentReviews.length > 2) return 0.6;  // Somewhat suspicious
    return 1.0;
  }

  private async analyzeContent(text: string): Promise<number> {
    const genericPhrases = [
      'great app', 'love it', 'best app ever',
      'must download', 'amazing', 'awesome', '5 stars'
    ];

    const hasGeneric = genericPhrases.some(
      p => text.toLowerCase().includes(p)
    );

    const lengthScore = Math.min(text.length / 100, 1);
    const hasSpecifics = /\b(feature|update|version|bug|problem|solved|crash)\b/i.test(text);

    return (
      (hasGeneric ? 0.5 : 1.0) * 0.3 +
      lengthScore * 0.3 +
      (hasSpecifics ? 1.0 : 0.5) * 0.4
    );
  }

  private async checkCoordination(appId: string, review: ReviewSubmission): Promise<number> {
    const recentReviews = await this.getAppReviews(appId, 24);
    const avgDailyReviews = await this.getAvgDailyReviews(appId);

    // Spike detection: 5x normal volume is suspicious
    if (recentReviews.length > avgDailyReviews * 5) {
      return 0.3;
    }

    // Time clustering detection
    const timestamps = recentReviews.map(r => r.createdAt.getTime());
    const clustering = this.detectTimeClustering(timestamps);
    if (clustering > 0.8) {
      return 0.4;  // Coordinated timing
    }

    return 1.0;
  }

  private determineAction(score: number): 'approve' | 'manual_review' | 'reject' {
    if (score < 0.3) return 'reject';
    if (score < 0.6) return 'manual_review';
    return 'approve';
  }
}
```

## Deep Dive: Elasticsearch Search Integration

### Search Index Configuration

```typescript
// Elasticsearch index mapping
const appIndexMapping = {
  settings: {
    analysis: {
      analyzer: {
        app_analyzer: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding', 'app_synonyms']
        }
      },
      filter: {
        app_synonyms: {
          type: 'synonym',
          synonyms: [
            'photo,picture,image',
            'video,movie,film',
            'game,gaming',
          ]
        }
      }
    }
  },
  mappings: {
    properties: {
      id: { type: 'keyword' },
      name: { type: 'text', analyzer: 'app_analyzer', boost: 3 },
      developer: { type: 'text', analyzer: 'app_analyzer', boost: 2 },
      description: { type: 'text', analyzer: 'app_analyzer' },
      keywords: { type: 'text', analyzer: 'app_analyzer' },
      category: { type: 'keyword' },
      isFree: { type: 'boolean' },
      averageRating: { type: 'float' },
      ratingCount: { type: 'integer' },
      downloads: { type: 'long' },
      engagementScore: { type: 'float' },
    }
  }
};
```

### Search with Quality Re-ranking

```typescript
class SearchService {
  async search(query: string, options: SearchOptions = {}): Promise<App[]> {
    const { category, price, rating, limit = 20 } = options;

    const esQuery = {
      bool: {
        must: [{
          multi_match: {
            query,
            fields: ['name^3', 'developer^2', 'description', 'keywords'],
            type: 'best_fields',
            fuzziness: 'AUTO',  // Typo tolerance
          }
        }],
        filter: this.buildFilters(options),
      }
    };

    const results = await this.elasticsearch.search({
      index: 'apps',
      body: {
        query: esQuery,
        size: limit * 2,  // Fetch extra for re-ranking
      }
    });

    // Re-rank combining text relevance with quality signals
    return this.rerank(results.hits.hits, query).slice(0, limit);
  }

  private buildFilters(options: SearchOptions): object[] {
    const filters: object[] = [];

    if (options.category) {
      filters.push({ term: { category: options.category } });
    }
    if (options.price === 'free') {
      filters.push({ term: { isFree: true } });
    }
    if (options.rating) {
      filters.push({ range: { averageRating: { gte: options.rating } } });
    }

    return filters;
  }

  private rerank(hits: EsHit[], query: string): App[] {
    return hits
      .map(hit => {
        const app = hit._source;
        const textScore = hit._score;

        // Quality signals (harder to game)
        const qualityScore =
          app.averageRating * 0.3 +
          Math.log1p(app.ratingCount) * 0.2 +
          Math.log1p(app.downloads) * 0.3 +
          app.engagementScore * 0.2;

        // Combine: 60% text relevance, 40% quality
        const finalScore = textScore * 0.6 + qualityScore * 0.4;

        return { ...app, score: finalScore };
      })
      .sort((a, b) => b.score - a.score);
  }
}
```

## Deep Dive: Purchase Idempotency

### Redis-Backed Idempotency

```typescript
class PurchaseService {
  async purchaseApp(
    userId: string,
    appId: string,
    priceId: string,
    idempotencyKey: string
  ): Promise<PurchaseResult> {
    // Layer 1: Check for cached result
    const cachedResult = await redis.get(`idem:purchase:${userId}:${idempotencyKey}`);
    if (cachedResult) {
      logger.info('Returning cached purchase result', { idempotencyKey });
      return JSON.parse(cachedResult);
    }

    // Layer 2: Acquire lock to prevent concurrent duplicates
    const lockKey = `lock:purchase:${userId}:${idempotencyKey}`;
    const lockAcquired = await redis.set(lockKey, '1', 'NX', 'EX', 30);
    if (!lockAcquired) {
      throw new ConflictError('Purchase already in progress');
    }

    try {
      // Layer 3: Database-level duplicate check
      const existingPurchase = await db.query(`
        SELECT id FROM purchases
        WHERE user_id = $1 AND app_id = $2 AND purchased_at > NOW() - INTERVAL '1 hour'
      `, [userId, appId]);

      if (existingPurchase.rows.length > 0) {
        throw new AlreadyPurchasedError('App already purchased');
      }

      // Process payment
      const payment = await this.paymentService.charge(userId, priceId);

      // Create purchase in transaction
      const purchase = await db.transaction(async (tx) => {
        const [purchase] = await tx.query(`
          INSERT INTO purchases (user_id, app_id, price_id, amount, currency, payment_provider_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `, [userId, appId, priceId, payment.amount, payment.currency, payment.id]);

        await tx.query(`
          INSERT INTO user_apps (user_id, app_id, purchased_at)
          VALUES ($1, $2, NOW())
        `, [userId, appId]);

        await tx.query(`
          UPDATE apps SET download_count = download_count + 1 WHERE id = $1
        `, [appId]);

        return purchase;
      });

      const result = {
        purchase,
        receipt: await this.generateReceipt(purchase),
      };

      // Cache result for idempotency (24 hour window)
      await redis.setex(
        `idem:purchase:${userId}:${idempotencyKey}`,
        86400,
        JSON.stringify(result)
      );

      // Publish event for async processing
      await this.messageQueue.publish('purchase.completed', {
        purchaseId: purchase.id,
        userId,
        appId,
        amount: payment.amount,
      });

      return result;
    } finally {
      await redis.del(lockKey);
    }
  }
}
```

## Deep Dive: Async Processing with RabbitMQ

### Queue Architecture

```typescript
// Queue configuration
const queues = {
  'review.created': {
    durable: true,
    deadLetterExchange: 'app-store.dlx',
    messageTtl: 86400000,  // 24 hours
  },
  'purchase.completed': {
    durable: true,
    deadLetterExchange: 'app-store.dlx',
    messageTtl: 604800000,  // 7 days (critical for payouts)
  },
  'ranking.compute': {
    durable: true,
    maxPriority: 10,
  },
  'search.reindex': {
    durable: true,
    prefetch: 5,  // Batch ES updates
  },
};

// Worker: Review integrity analysis
async function startReviewWorker() {
  const channel = await connection.createChannel();
  await channel.prefetch(1);  // ML inference is slow

  await channel.consume('review.created', async (msg) => {
    const event = JSON.parse(msg.content.toString());

    try {
      // Deduplication check
      const processed = await redis.get(`processed:review:${event.eventId}`);
      if (processed) {
        channel.ack(msg);
        return;
      }

      // Run integrity analysis
      const result = await reviewIntegrityService.analyzeReview(
        event.data.review,
        event.data.userId,
        event.data.appId
      );

      // Update review status
      await db.query(`
        UPDATE reviews
        SET integrity_score = $1, integrity_signals = $2, status = $3
        WHERE id = $4
      `, [result.integrityScore, result.signals, result.action, event.data.reviewId]);

      // Mark as processed
      await redis.setex(`processed:review:${event.eventId}`, 86400, '1');

      channel.ack(msg);
    } catch (error) {
      const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1;
      if (retryCount <= 3) {
        // Exponential backoff retry
        setTimeout(() => {
          channel.publish('', 'review.created', msg.content, {
            headers: { 'x-retry-count': retryCount }
          });
          channel.ack(msg);
        }, Math.pow(2, retryCount) * 1000);
      } else {
        channel.nack(msg, false, false);  // Send to DLQ
      }
    }
  });
}
```

## Deep Dive: Circuit Breaker Pattern

```typescript
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failures = 0;
  private lastFailure: number | null = null;

  constructor(
    private name: string,
    private failureThreshold = 5,
    private resetTimeout = 30000
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - (this.lastFailure || 0) > this.resetTimeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitOpenError(`Circuit ${this.name} is OPEN`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      metrics.circuitBreakerState.labels(this.name, 'OPEN').set(1);
      logger.warn(`Circuit breaker ${this.name} opened`);
    }
  }
}

// Pre-configured breakers
const esBreaker = new CircuitBreaker('elasticsearch', 3, 30000);
const paymentBreaker = new CircuitBreaker('payment', 2, 60000);
```

## Deep Dive: Observability

### Prometheus Metrics

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

// Request metrics
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

// Business metrics
const purchasesTotal = new Counter({
  name: 'purchases_total',
  help: 'Total purchases processed',
  labelNames: ['status', 'country'],
});

const reviewsAnalyzed = new Counter({
  name: 'reviews_analyzed_total',
  help: 'Total reviews analyzed for integrity',
  labelNames: ['action'],  // approve, reject, manual_review
});

const searchLatency = new Histogram({
  name: 'search_latency_seconds',
  help: 'Search query latency',
  labelNames: ['has_filters'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
});

// Infrastructure metrics
const esCircuitState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 0.5=half_open)',
  labelNames: ['name'],
});

const queueDepth = new Gauge({
  name: 'rabbitmq_queue_depth',
  help: 'Number of messages in queue',
  labelNames: ['queue'],
});
```

### Structured Logging

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// Request logging middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.log = logger.child({ requestId, userId: req.session?.userId });

  const start = Date.now();
  res.on('finish', () => {
    req.log.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
    }, 'request completed');
  });

  next();
});
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Ranking algorithm | Multi-signal ML | Download count only | Manipulation resistance |
| Review moderation | ML + human escalation | Manual only | Scales to millions |
| Search engine | Elasticsearch | PostgreSQL FTS | Better relevance, fuzzy matching |
| Message queue | RabbitMQ | Kafka | Simpler for moderate scale |
| Idempotency | Redis + DB | DB only | Faster, handles concurrent retries |
| Consistency | Strong for purchases | Eventual everywhere | Financial correctness |

## Future Backend Enhancements

1. **Kafka Integration**: Higher throughput event streaming for rankings pipeline
2. **ML Model Serving**: TensorFlow Serving for real-time fraud detection
3. **Sharded Elasticsearch**: Geographic sharding for global search
4. **Read Replicas**: PostgreSQL replicas for analytics queries
5. **GraphQL API**: Efficient mobile data fetching with batched queries
6. **Real-time Rankings**: Stream processing with Flink for live chart updates

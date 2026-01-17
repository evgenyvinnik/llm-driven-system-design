# Design App Store - Architecture

## System Overview

App Store is a digital marketplace for applications with discovery and purchases. Core challenges involve ranking, review integrity, and scalable delivery.

**Learning Goals:**
- Build ranking and recommendation systems
- Design review integrity systems
- Implement secure purchase flows
- Handle large-scale content delivery

---

## Requirements

### Functional Requirements

1. **Discover**: Search and browse apps
2. **Purchase**: Buy apps and subscriptions
3. **Review**: Rate and review apps
4. **Update**: Download updates
5. **Develop**: Submit and manage apps

### Non-Functional Requirements

- **Scale**: 2M+ apps, billions of downloads
- **Availability**: 99.99% for purchases
- **Latency**: < 100ms search results
- **Integrity**: Manipulation-resistant rankings

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│              iPhone │ iPad │ Mac │ Apple TV                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CDN                                     │
│                (App binaries, screenshots)                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Catalog Service│    │Purchase Service│    │Review Service │
│               │    │               │    │               │
│ - Search      │    │ - Checkout    │    │ - Ratings     │
│ - Rankings    │    │ - Subs        │    │ - Moderation  │
│ - Recs        │    │ - Receipts    │    │ - Integrity   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Elasticsearch   │      ML Platform          │
│   - Apps        │   - Search        │      - Rankings           │
│   - Purchases   │   - Filters       │      - Recommendations    │
│   - Reviews     │   - Suggestions   │      - Fraud detection    │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. App Ranking

**Multi-Factor Ranking Algorithm:**
```javascript
class RankingService {
  async calculateRankings(category, country) {
    const apps = await this.getAppsInCategory(category, country)

    const rankedApps = apps.map(app => {
      // Download velocity (recent downloads weighted more)
      const downloadScore = this.calculateDownloadVelocity(app)

      // Rating quality
      const ratingScore = this.calculateRatingScore(app)

      // Engagement metrics
      const engagementScore = this.calculateEngagement(app)

      // Revenue (for Top Grossing)
      const revenueScore = this.calculateRevenue(app)

      // Freshness (bonus for new/updated apps)
      const freshnessScore = this.calculateFreshness(app)

      // Combine with learned weights
      const finalScore =
        downloadScore * 0.3 +
        ratingScore * 0.25 +
        engagementScore * 0.2 +
        revenueScore * 0.15 +
        freshnessScore * 0.1

      return { ...app, score: finalScore }
    })

    return rankedApps.sort((a, b) => b.score - a.score)
  }

  calculateDownloadVelocity(app) {
    // Weight recent downloads more heavily
    const now = Date.now()
    let weightedDownloads = 0

    for (const day of app.dailyDownloads) {
      const daysAgo = (now - day.date) / (24 * 60 * 60 * 1000)
      const weight = Math.exp(-daysAgo / 7) // Half-life of 1 week
      weightedDownloads += day.count * weight
    }

    // Normalize by category median
    const categoryMedian = this.getCategoryMedian(app.category)
    return Math.log1p(weightedDownloads / categoryMedian)
  }

  calculateRatingScore(app) {
    // Bayesian average to handle low review counts
    const C = 100 // Confidence parameter
    const m = 3.5 // Global average rating

    const bayesianRating = (
      (C * m + app.ratingSum) /
      (C + app.ratingCount)
    )

    // Penalize low rating counts
    const countMultiplier = Math.min(1, app.ratingCount / 50)

    return bayesianRating * countMultiplier / 5.0
  }

  calculateEngagement(app) {
    // DAU/MAU ratio, session length, retention
    const dauMau = app.dau / Math.max(app.mau, 1)
    const sessionScore = Math.min(app.avgSessionMinutes / 10, 1)
    const retentionScore = app.day7Retention

    return (dauMau * 0.4 + sessionScore * 0.3 + retentionScore * 0.3)
  }
}
```

### 2. Search Service

**App Search with Relevance:**
```javascript
class SearchService {
  async search(query, options = {}) {
    const { category, price, rating, country } = options

    // Build Elasticsearch query
    const esQuery = {
      bool: {
        must: [
          {
            multi_match: {
              query,
              fields: [
                'name^3',        // App name is most important
                'developer^2',  // Developer name
                'description',
                'keywords'
              ],
              type: 'best_fields',
              fuzziness: 'AUTO'
            }
          }
        ],
        filter: []
      }
    }

    // Apply filters
    if (category) {
      esQuery.bool.filter.push({ term: { category } })
    }

    if (price === 'free') {
      esQuery.bool.filter.push({ term: { isFree: true } })
    }

    if (rating) {
      esQuery.bool.filter.push({
        range: { averageRating: { gte: rating } }
      })
    }

    // Execute search
    const results = await elasticsearch.search({
      index: 'apps',
      body: {
        query: esQuery,
        size: 50
      }
    })

    // Re-rank with relevance + quality signals
    const reranked = this.rerank(results.hits.hits, query)

    return reranked.slice(0, 20)
  }

  rerank(hits, query) {
    return hits
      .map(hit => {
        const app = hit._source
        const textScore = hit._score

        // Quality signals
        const qualityScore =
          app.averageRating * 0.3 +
          Math.log1p(app.ratingCount) * 0.2 +
          Math.log1p(app.downloads) * 0.3 +
          app.engagementScore * 0.2

        // Combine text relevance and quality
        const finalScore = textScore * 0.6 + qualityScore * 0.4

        return { ...app, score: finalScore }
      })
      .sort((a, b) => b.score - a.score)
  }
}
```

### 3. Purchase Service

**Secure Purchase Flow:**
```javascript
class PurchaseService {
  async purchaseApp(userId, appId, priceId) {
    const user = await this.getUser(userId)
    const app = await this.getApp(appId)
    const price = app.prices.find(p => p.id === priceId)

    // Validate purchase
    if (!price) throw new Error('Invalid price')
    if (await this.alreadyPurchased(userId, appId)) {
      throw new Error('Already purchased')
    }

    // Process payment
    const payment = await this.processPayment(user, price)

    // Create purchase record
    const purchase = await db.transaction(async (tx) => {
      // Record purchase
      const purchase = await tx.query(`
        INSERT INTO purchases
          (id, user_id, app_id, price_id, amount, currency, payment_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [uuid(), userId, appId, priceId, price.amount, price.currency, payment.id])

      // Grant app access
      await tx.query(`
        INSERT INTO user_apps (user_id, app_id, purchased_at)
        VALUES ($1, $2, NOW())
      `, [userId, appId])

      // Increment download count
      await tx.query(`
        UPDATE apps SET download_count = download_count + 1
        WHERE id = $1
      `, [appId])

      return purchase.rows[0]
    })

    // Generate receipt
    const receipt = await this.generateReceipt(purchase)

    // Record for developer payout (70/30 split)
    await this.recordDeveloperRevenue(app.developerId, price.amount * 0.7)

    return { purchase, receipt }
  }

  async verifyReceipt(receiptData) {
    // Decode receipt
    const receipt = await this.decodeReceipt(receiptData)

    // Verify signature
    const isValid = await this.verifySignature(receipt)
    if (!isValid) {
      return { valid: false, error: 'Invalid signature' }
    }

    // Check receipt in database
    const purchase = await db.query(`
      SELECT * FROM purchases WHERE id = $1
    `, [receipt.purchaseId])

    if (!purchase.rows.length) {
      return { valid: false, error: 'Purchase not found' }
    }

    // Return purchase info
    return {
      valid: true,
      productId: purchase.rows[0].app_id,
      purchaseDate: purchase.rows[0].purchased_at,
      expirationDate: purchase.rows[0].expires_at // For subscriptions
    }
  }
}
```

### 4. Review Integrity

**Fake Review Detection:**
```javascript
class ReviewIntegrityService {
  async analyzeReview(review, userId, appId) {
    const signals = []

    // User history analysis
    const userReviews = await this.getUserReviews(userId)
    signals.push({
      name: 'review_velocity',
      score: this.checkVelocity(userReviews),
      weight: 0.15
    })

    // Content analysis
    signals.push({
      name: 'content_quality',
      score: await this.analyzeContent(review.text),
      weight: 0.25
    })

    // Device/account signals
    signals.push({
      name: 'account_age',
      score: this.checkAccountAge(userId),
      weight: 0.1
    })

    // Purchase verification
    const hasPurchased = await this.verifyPurchase(userId, appId)
    signals.push({
      name: 'verified_purchase',
      score: hasPurchased ? 1.0 : 0.3,
      weight: 0.2
    })

    // Coordination detection (review bombing)
    signals.push({
      name: 'coordination',
      score: await this.checkCoordination(appId, review),
      weight: 0.2
    })

    // Text similarity to other reviews
    signals.push({
      name: 'originality',
      score: await this.checkOriginality(review.text, appId),
      weight: 0.1
    })

    // Calculate final score
    const integrityScore = signals.reduce(
      (sum, s) => sum + s.score * s.weight, 0
    )

    return {
      integrityScore,
      signals,
      action: this.determineAction(integrityScore)
    }
  }

  checkVelocity(userReviews) {
    // Suspicious if many reviews in short time
    const recentReviews = userReviews.filter(
      r => Date.now() - r.createdAt < 24 * 60 * 60 * 1000
    )

    if (recentReviews.length > 5) return 0.2
    if (recentReviews.length > 2) return 0.6
    return 1.0
  }

  async analyzeContent(text) {
    // Check for generic/templated content
    const genericPhrases = ['great app', 'love it', 'best app ever', 'must download']
    const hasGeneric = genericPhrases.some(p => text.toLowerCase().includes(p))

    // Check content length
    const lengthScore = Math.min(text.length / 100, 1)

    // Check for specific details
    const hasSpecifics = /\b(feature|update|version|bug|problem|solved)\b/i.test(text)

    return (
      (hasGeneric ? 0.5 : 1.0) * 0.3 +
      lengthScore * 0.3 +
      (hasSpecifics ? 1.0 : 0.5) * 0.4
    )
  }

  async checkCoordination(appId, review) {
    // Check for sudden spike in reviews
    const recentReviews = await this.getRecentReviews(appId, 24)

    // Get historical average
    const avgDailyReviews = await this.getAvgDailyReviews(appId)

    // Flag if significantly above average
    if (recentReviews.length > avgDailyReviews * 5) {
      return 0.3 // Suspicious
    }

    return 1.0
  }

  determineAction(score) {
    if (score < 0.3) return 'reject'
    if (score < 0.6) return 'manual_review'
    return 'approve'
  }
}
```

### 5. Recommendations

**Personalized App Suggestions:**
```javascript
class RecommendationService {
  async getRecommendations(userId) {
    // Get user's download history
    const history = await this.getUserApps(userId)
    const userEmbedding = await this.getUserEmbedding(userId)

    const recommendations = []

    // "Because you downloaded X"
    const recentApps = history.slice(0, 3)
    for (const app of recentApps) {
      const similar = await this.getSimilarApps(app.id, {
        exclude: history.map(h => h.id)
      })

      recommendations.push({
        type: 'similar',
        reason: `Because you downloaded ${app.name}`,
        apps: similar.slice(0, 5)
      })
    }

    // Collaborative filtering
    const cfApps = await this.getCollaborativeRecs(userEmbedding, {
      exclude: history.map(h => h.id)
    })

    recommendations.push({
      type: 'cf',
      reason: 'Apps You Might Like',
      apps: cfApps.slice(0, 10)
    })

    // Category exploration
    const topCategories = this.getTopCategories(history)
    for (const category of topCategories.slice(0, 2)) {
      const categoryApps = await this.getTrendingInCategory(category, {
        exclude: history.map(h => h.id)
      })

      recommendations.push({
        type: 'category',
        reason: `Popular in ${category}`,
        apps: categoryApps.slice(0, 5)
      })
    }

    return recommendations
  }

  async getSimilarApps(appId, options = {}) {
    const app = await this.getApp(appId)
    const appEmbedding = await this.getAppEmbedding(appId)

    // Vector similarity search
    const candidates = await this.vectorDb.search({
      vector: appEmbedding,
      topK: 50,
      filter: {
        id: { $nin: options.exclude || [] },
        category: app.category
      }
    })

    // Re-rank by quality
    return candidates
      .map(c => ({
        ...c,
        score: c.similarity * 0.6 + c.qualityScore * 0.4
      }))
      .sort((a, b) => b.score - a.score)
  }
}
```

---

## Database Schema

```sql
-- Apps
CREATE TABLE apps (
  id UUID PRIMARY KEY,
  bundle_id VARCHAR(200) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  developer_id UUID REFERENCES developers(id),
  category VARCHAR(100),
  subcategory VARCHAR(100),
  description TEXT,
  release_notes TEXT,
  version VARCHAR(50),
  size_bytes BIGINT,
  age_rating VARCHAR(20),
  is_free BOOLEAN DEFAULT TRUE,
  download_count BIGINT DEFAULT 0,
  average_rating DECIMAL,
  rating_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_apps_category ON apps(category);
CREATE INDEX idx_apps_developer ON apps(developer_id);

-- App Prices (per country)
CREATE TABLE app_prices (
  id UUID PRIMARY KEY,
  app_id UUID REFERENCES apps(id),
  country VARCHAR(2),
  price_tier INTEGER,
  amount DECIMAL,
  currency VARCHAR(3),
  type VARCHAR(20), -- 'one_time', 'subscription'
  period VARCHAR(20) -- 'monthly', 'yearly'
);

-- Purchases
CREATE TABLE purchases (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  app_id UUID REFERENCES apps(id),
  price_id UUID REFERENCES app_prices(id),
  amount DECIMAL,
  currency VARCHAR(3),
  payment_id VARCHAR(100),
  receipt_data TEXT,
  purchased_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP -- For subscriptions
);

CREATE INDEX idx_purchases_user ON purchases(user_id);

-- Reviews
CREATE TABLE reviews (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  app_id UUID REFERENCES apps(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  body TEXT,
  helpful_count INTEGER DEFAULT 0,
  integrity_score DECIMAL,
  status VARCHAR(20) DEFAULT 'pending',
  developer_response TEXT,
  developer_response_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_reviews_app ON reviews(app_id, created_at DESC);

-- Daily Rankings (precomputed)
CREATE TABLE rankings (
  date DATE,
  country VARCHAR(2),
  category VARCHAR(100),
  rank_type VARCHAR(20), -- 'free', 'paid', 'grossing'
  app_id UUID REFERENCES apps(id),
  rank INTEGER,
  PRIMARY KEY (date, country, category, rank_type, app_id)
);
```

---

## Key Design Decisions

### 1. Bayesian Rating Average

**Decision**: Use Bayesian average for ratings

**Rationale**:
- Handles apps with few reviews fairly
- Prevents gaming with early 5-star reviews
- Converges to true rating with more data

### 2. Multi-Signal Ranking

**Decision**: Combine multiple signals for ranking

**Rationale**:
- Download count alone is gameable
- Quality signals improve user experience
- Harder to manipulate multiple signals

### 3. Review Integrity Scoring

**Decision**: ML-based fake review detection

**Rationale**:
- Rules alone are easy to bypass
- Learns from human moderator decisions
- Adapts to new manipulation techniques

---

## Consistency and Idempotency

### Consistency Model by Operation

| Operation | Consistency Level | Rationale |
|-----------|-------------------|-----------|
| Purchase creation | **Strong (serializable)** | Financial correctness requires no double-charges |
| Review submission | **Strong (read-your-writes)** | User sees their review immediately |
| Download count increment | **Eventual** | Slight delays acceptable for analytics |
| Ranking updates | **Eventual (batch)** | Rankings recomputed hourly, lag is acceptable |
| Search index updates | **Eventual (~5s)** | New apps appear shortly after publish |

### Idempotency Keys

All mutating operations that interact with payment or critical state require client-provided idempotency keys:

```javascript
// Purchase endpoint with idempotency
app.post('/api/v1/purchases', async (req, res) => {
  const { appId, priceId, idempotencyKey } = req.body
  const userId = req.session.userId

  // Check for existing operation with this key
  const existing = await redis.get(`idempotency:purchase:${userId}:${idempotencyKey}`)
  if (existing) {
    // Return cached result (replay handling)
    return res.json(JSON.parse(existing))
  }

  // Acquire lock to prevent concurrent duplicates
  const lockKey = `lock:purchase:${userId}:${idempotencyKey}`
  const locked = await redis.set(lockKey, '1', 'NX', 'EX', 30)
  if (!locked) {
    return res.status(409).json({ error: 'Request in progress' })
  }

  try {
    const result = await purchaseService.purchaseApp(userId, appId, priceId)

    // Cache result for 24 hours (idempotency window)
    await redis.setex(
      `idempotency:purchase:${userId}:${idempotencyKey}`,
      86400,
      JSON.stringify(result)
    )

    return res.json(result)
  } finally {
    await redis.del(lockKey)
  }
})
```

**Key idempotency patterns:**
- **Purchases**: Key = `{userId}:{appId}:{timestamp_bucket}` - prevents double-purchase within 1-minute window
- **Reviews**: Key = `{userId}:{appId}` - one review per user per app, upsert semantics
- **Developer payouts**: Key = `{developerId}:{period}` - one payout per billing period

### Conflict Resolution

For concurrent modifications to the same resource:

| Resource | Strategy | Implementation |
|----------|----------|----------------|
| App metadata | Last-write-wins with version | `UPDATE apps SET ... WHERE id = $1 AND version = $2` |
| Reviews | User can only have one per app | `ON CONFLICT (user_id, app_id) DO UPDATE` |
| Developer response | Last-write-wins | Single developer per app simplifies this |
| Rankings | Batch recompute | No conflicts - read-only table rebuilt hourly |

---

## Async Processing with RabbitMQ

### Queue Architecture

For a local development setup, RabbitMQ provides durable, ordered message processing with explicit acknowledgments.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         RabbitMQ Exchanges                              │
├─────────────────────┬───────────────────────┬───────────────────────────┤
│  app-store.events   │  app-store.tasks      │  app-store.dlx            │
│  (topic exchange)   │  (direct exchange)    │  (dead letter exchange)   │
└─────────────────────┴───────────────────────┴───────────────────────────┘
         │                       │                        │
         ▼                       ▼                        ▼
┌─────────────────┐   ┌─────────────────┐      ┌─────────────────┐
│ review.created  │   │ ranking.compute │      │ failed-messages │
│ purchase.done   │   │ search.reindex  │      │ (for inspection)│
│ app.updated     │   │ email.send      │      └─────────────────┘
└─────────────────┘   └─────────────────┘
```

### Queue Definitions

```javascript
// queue-config.js
const queues = {
  // Event-driven fanout
  'review.created': {
    durable: true,
    deadLetterExchange: 'app-store.dlx',
    messageTtl: 86400000, // 24h
    maxLength: 10000,     // Backpressure: reject when full
  },
  'purchase.completed': {
    durable: true,
    deadLetterExchange: 'app-store.dlx',
    messageTtl: 604800000, // 7 days (critical for payouts)
  },

  // Background tasks
  'ranking.compute': {
    durable: true,
    maxPriority: 10,      // Priority queue for urgent recalcs
  },
  'search.reindex': {
    durable: true,
    prefetch: 5,          // Batch ES updates
  },
  'integrity.analyze': {
    durable: true,
    prefetch: 1,          // ML inference is slow
  }
}
```

### Delivery Semantics

| Queue | Semantics | Retry Policy | Notes |
|-------|-----------|--------------|-------|
| `purchase.completed` | **At-least-once** | 3 retries, exponential backoff | Downstream must be idempotent |
| `review.created` | **At-least-once** | 3 retries, then DLQ | Integrity analysis can reprocess |
| `ranking.compute` | **At-most-once** | No retry (scheduled job retries) | Stale rankings okay briefly |
| `search.reindex` | **At-least-once** | 5 retries | ES upsert is idempotent |

### Producer Example

```javascript
// After purchase completes
async function publishPurchaseEvent(purchase) {
  const message = {
    eventId: uuid(),        // For deduplication
    eventType: 'purchase.completed',
    timestamp: new Date().toISOString(),
    data: {
      purchaseId: purchase.id,
      userId: purchase.user_id,
      appId: purchase.app_id,
      amount: purchase.amount,
      developerId: purchase.developer_id,
    }
  }

  await channel.publish(
    'app-store.events',
    'purchase.completed',
    Buffer.from(JSON.stringify(message)),
    {
      persistent: true,           // Survive broker restart
      messageId: message.eventId, // For deduplication
      contentType: 'application/json',
    }
  )
}
```

### Consumer Example with Backpressure

```javascript
// Worker: process review integrity checks
async function startIntegrityWorker() {
  const channel = await connection.createChannel()

  // Prefetch 1: process one at a time (ML is slow)
  await channel.prefetch(1)

  await channel.consume('integrity.analyze', async (msg) => {
    const event = JSON.parse(msg.content.toString())

    try {
      // Check for duplicate processing
      const processed = await redis.get(`processed:review:${event.eventId}`)
      if (processed) {
        channel.ack(msg) // Already done, just ack
        return
      }

      // Run integrity analysis
      const result = await reviewIntegrityService.analyzeReview(
        event.data.review,
        event.data.userId,
        event.data.appId
      )

      // Update review status
      await db.query(
        'UPDATE reviews SET integrity_score = $1, status = $2 WHERE id = $3',
        [result.integrityScore, result.action, event.data.reviewId]
      )

      // Mark as processed
      await redis.setex(`processed:review:${event.eventId}`, 86400, '1')

      channel.ack(msg)
    } catch (error) {
      console.error('Integrity check failed:', error)

      // Requeue with limit
      const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1
      if (retryCount <= 3) {
        // Requeue with backoff
        setTimeout(() => {
          channel.publish(
            '',
            'integrity.analyze',
            msg.content,
            { headers: { 'x-retry-count': retryCount } }
          )
          channel.ack(msg)
        }, Math.pow(2, retryCount) * 1000)
      } else {
        // Send to DLQ
        channel.nack(msg, false, false)
      }
    }
  })
}
```

### Background Jobs Summary

| Job | Trigger | Queue | Frequency |
|-----|---------|-------|-----------|
| Ranking computation | Cron | `ranking.compute` | Hourly |
| Search index sync | App update event | `search.reindex` | Real-time |
| Review integrity | Review created event | `integrity.analyze` | Real-time |
| Developer payout calc | Purchase event | `payout.calculate` | On each purchase |
| Receipt email | Purchase event | `email.send` | On each purchase |

---

## Failure Handling and Resilience

### Retry Strategy with Idempotency

All external calls follow this pattern:

```javascript
class RetryableOperation {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3
    this.baseDelay = options.baseDelay || 1000
    this.maxDelay = options.maxDelay || 30000
  }

  async execute(operation, idempotencyKey) {
    let lastError

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error) {
        lastError = error

        // Don't retry non-retryable errors
        if (this.isNonRetryable(error)) {
          throw error
        }

        if (attempt < this.maxRetries) {
          const delay = Math.min(
            this.baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
            this.maxDelay
          )
          await this.sleep(delay)
        }
      }
    }

    // Log for investigation
    console.error(`Operation failed after ${this.maxRetries} retries`, {
      idempotencyKey,
      error: lastError.message
    })

    throw lastError
  }

  isNonRetryable(error) {
    // 4xx errors (except 429) are not retryable
    if (error.status >= 400 && error.status < 500 && error.status !== 429) {
      return true
    }
    // Business logic errors
    if (error.code === 'ALREADY_PURCHASED' || error.code === 'INVALID_PRICE') {
      return true
    }
    return false
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
```

### Circuit Breaker for External Dependencies

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeout = options.resetTimeout || 30000
    this.state = 'CLOSED' // CLOSED, OPEN, HALF_OPEN
    this.failures = 0
    this.lastFailure = null
    this.name = options.name || 'unnamed'
  }

  async call(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'HALF_OPEN'
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`)
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failures = 0
    this.state = 'CLOSED'
  }

  onFailure() {
    this.failures++
    this.lastFailure = Date.now()

    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      console.warn(`Circuit breaker ${this.name} opened after ${this.failures} failures`)
    }
  }
}

// Usage
const esCircuitBreaker = new CircuitBreaker({ name: 'elasticsearch', failureThreshold: 3 })
const paymentCircuitBreaker = new CircuitBreaker({ name: 'payment-provider', failureThreshold: 2 })

// In search service
async function search(query) {
  return esCircuitBreaker.call(async () => {
    return elasticsearch.search({ index: 'apps', body: { query } })
  })
}
```

### Graceful Degradation

When dependencies fail, the system degrades gracefully:

| Dependency | Failure Mode | Degradation Strategy |
|------------|--------------|---------------------|
| Elasticsearch | Circuit open | Fall back to PostgreSQL full-text search (slower) |
| Redis (cache) | Connection lost | Bypass cache, hit database directly |
| Redis (sessions) | Connection lost | Reject new logins, existing sessions continue if stateless fallback |
| RabbitMQ | Broker down | Write events to PostgreSQL `outbox` table, replay on recovery |
| Payment provider | Timeout | Show "try again later", preserve cart state |

### Outbox Pattern for Guaranteed Delivery

When RabbitMQ is unavailable, events are stored in PostgreSQL and replayed:

```sql
-- Outbox table for events that failed to publish
CREATE TABLE event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  published_at TIMESTAMP,
  retry_count INTEGER DEFAULT 0,
  last_error TEXT
);

CREATE INDEX idx_outbox_pending ON event_outbox(created_at)
  WHERE published_at IS NULL;
```

```javascript
// Outbox publisher (runs every 10 seconds)
async function processOutbox() {
  const events = await db.query(`
    SELECT * FROM event_outbox
    WHERE published_at IS NULL AND retry_count < 5
    ORDER BY created_at
    LIMIT 100
  `)

  for (const event of events.rows) {
    try {
      await channel.publish(
        'app-store.events',
        event.event_type,
        Buffer.from(JSON.stringify(event.payload)),
        { persistent: true, messageId: event.id }
      )

      await db.query(
        'UPDATE event_outbox SET published_at = NOW() WHERE id = $1',
        [event.id]
      )
    } catch (error) {
      await db.query(
        'UPDATE event_outbox SET retry_count = retry_count + 1, last_error = $1 WHERE id = $2',
        [error.message, event.id]
      )
    }
  }
}

// Schedule every 10 seconds
setInterval(processOutbox, 10000)
```

### Local Development DR Simulation

For learning purposes, simulate multi-region disaster recovery locally:

```yaml
# docker-compose.yml - Multi-instance setup
services:
  postgres-primary:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: appstore
      POSTGRES_USER: appstore
      POSTGRES_PASSWORD: devpassword

  postgres-replica:
    image: postgres:16
    ports:
      - "5433:5432"
    environment:
      POSTGRES_DB: appstore
      POSTGRES_USER: appstore
      POSTGRES_PASSWORD: devpassword
    # In production: configure streaming replication

  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: appstore
      RABBITMQ_DEFAULT_PASS: devpassword
```

**Failover testing script:**

```bash
#!/bin/bash
# scripts/simulate-failover.sh

echo "=== Simulating primary database failure ==="

# Stop primary
docker-compose stop postgres-primary

# Application should fail over to replica
# (requires app config to support read replica)

echo "Primary stopped. Check app behavior..."
sleep 10

# Restore
docker-compose start postgres-primary
echo "Primary restored."
```

### Backup and Restore Procedures

**Automated backup script (for local testing):**

```bash
#!/bin/bash
# scripts/backup.sh

BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# PostgreSQL backup
docker exec appstore-postgres pg_dump -U appstore appstore > "$BACKUP_DIR/postgres.sql"

# Redis backup (if persistence enabled)
docker exec appstore-redis redis-cli BGSAVE
docker cp appstore-redis:/data/dump.rdb "$BACKUP_DIR/redis.rdb"

# MinIO backup (app packages and screenshots)
docker run --rm -v "$BACKUP_DIR:/backup" \
  --network appstore_default \
  minio/mc mirror appstore-minio/app-packages /backup/minio/

echo "Backup completed: $BACKUP_DIR"
```

**Restore script:**

```bash
#!/bin/bash
# scripts/restore.sh

BACKUP_DIR=$1

if [ -z "$BACKUP_DIR" ]; then
  echo "Usage: ./restore.sh <backup-dir>"
  exit 1
fi

# Restore PostgreSQL
docker exec -i appstore-postgres psql -U appstore appstore < "$BACKUP_DIR/postgres.sql"

# Restore Redis
docker cp "$BACKUP_DIR/redis.rdb" appstore-redis:/data/dump.rdb
docker exec appstore-redis redis-cli DEBUG RELOAD

# Restore MinIO
docker run --rm -v "$BACKUP_DIR:/backup" \
  --network appstore_default \
  minio/mc mirror /backup/minio/ appstore-minio/app-packages/

echo "Restore completed from: $BACKUP_DIR"
```

**Testing backup/restore:**

```bash
# 1. Create some test data
npm run db:seed

# 2. Backup
./scripts/backup.sh

# 3. Destroy data
docker-compose down -v
docker-compose up -d
npm run db:migrate

# 4. Restore
./scripts/restore.sh ./backups/20240115_120000

# 5. Verify data integrity
npm run test:integration
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Ranking | Multi-signal ML | Download count | Manipulation resistance |
| Reviews | ML moderation | Manual only | Scale |
| Search | Elasticsearch | PostgreSQL FTS | Performance, features |
| Recommendations | Hybrid CF + content | Pure CF | Cold start |
| Message queue | RabbitMQ | Kafka | Simpler for local dev, sufficient for learning |
| Consistency | Strong for payments, eventual for analytics | All strong | Performance vs correctness tradeoff |
| Idempotency | Client-provided keys with Redis locks | Database constraints only | Handles network retries gracefully |

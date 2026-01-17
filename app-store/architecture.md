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

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Ranking | Multi-signal ML | Download count | Manipulation resistance |
| Reviews | ML moderation | Manual only | Scale |
| Search | Elasticsearch | PostgreSQL FTS | Performance, features |
| Recommendations | Hybrid CF + content | Pure CF | Cold start |

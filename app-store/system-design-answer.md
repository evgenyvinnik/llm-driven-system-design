# App Store - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design the App Store, Apple's digital marketplace with over 2 million apps serving billions of downloads. The key challenges are building manipulation-resistant ranking algorithms, ensuring review integrity against fake reviews, and delivering apps at massive scale.

The core technical challenges are multi-signal ranking that's hard to game, ML-based fake review detection, secure purchase flows with receipt validation, and a search system that balances relevance with quality."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Discover**: Search and browse apps with filters
- **Purchase**: Buy apps and manage subscriptions
- **Review**: Rate and review apps
- **Update**: Download app updates
- **Develop**: Submit and manage apps (developer portal)

### Non-Functional Requirements
- **Scale**: 2M+ apps, billions of downloads
- **Availability**: 99.99% for purchases
- **Latency**: < 100ms for search results
- **Integrity**: Manipulation-resistant rankings and reviews

### Scale Estimates
- 2 million apps in catalog
- 500 million weekly store visitors
- 10 billion app downloads per year
- Thousands of new app submissions daily

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                     Client Layer                           |
|            iPhone | iPad | Mac | Apple TV                  |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                          CDN                               |
|           (App binaries, screenshots, videos)              |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                     API Gateway                            |
+----------------------------------------------------------+
          |                    |                    |
          v                    v                    v
+------------------+  +------------------+  +------------------+
|  Catalog Service |  | Purchase Service |  |  Review Service  |
|                  |  |                  |  |                  |
| - Search         |  | - Checkout       |  | - Ratings        |
| - Rankings       |  | - Subscriptions  |  | - Moderation     |
| - Recommendations|  | - Receipts       |  | - Integrity      |
+------------------+  +------------------+  +------------------+
          |                    |                    |
          v                    v                    v
+----------------------------------------------------------+
|                      Data Layer                            |
|  PostgreSQL (apps, purchases) | Elasticsearch (search)     |
|  ML Platform (rankings, fraud detection)                   |
+----------------------------------------------------------+
```

### Core Components
1. **Catalog Service** - App metadata, search, rankings, recommendations
2. **Purchase Service** - Payment processing, subscriptions, receipt validation
3. **Review Service** - Ratings, reviews, integrity scoring, moderation
4. **Developer Portal** - App submission, analytics, financial reports
5. **CDN** - App binary delivery, screenshots, preview videos

## Deep Dive: Ranking Algorithm (8 minutes)

The ranking system must surface quality apps while being resistant to manipulation. We use multiple signals that are hard to game together.

### Multi-Signal Ranking

```javascript
class RankingService {
  async calculateRankings(category, country) {
    const apps = await this.getAppsInCategory(category, country)

    const rankedApps = apps.map(app => {
      // 1. Download Velocity (30% weight)
      const downloadScore = this.calculateDownloadVelocity(app)

      // 2. Rating Quality (25% weight)
      const ratingScore = this.calculateRatingScore(app)

      // 3. Engagement Metrics (20% weight)
      const engagementScore = this.calculateEngagement(app)

      // 4. Revenue - for Top Grossing (15% weight)
      const revenueScore = this.calculateRevenue(app)

      // 5. Freshness (10% weight)
      const freshnessScore = this.calculateFreshness(app)

      const finalScore =
        downloadScore * 0.30 +
        ratingScore * 0.25 +
        engagementScore * 0.20 +
        revenueScore * 0.15 +
        freshnessScore * 0.10

      return { ...app, score: finalScore }
    })

    return rankedApps.sort((a, b) => b.score - a.score)
  }
}
```

### Download Velocity

Raw download count is easily gamed. Instead, we use velocity (recent downloads weighted more):

```javascript
calculateDownloadVelocity(app) {
  const now = Date.now()
  let weightedDownloads = 0

  for (const day of app.dailyDownloads) {
    const daysAgo = (now - day.date) / (24 * 60 * 60 * 1000)
    // Exponential decay with 1-week half-life
    const weight = Math.exp(-daysAgo / 7)
    weightedDownloads += day.count * weight
  }

  // Normalize by category median to compare fairly
  const categoryMedian = this.getCategoryMedian(app.category)
  return Math.log1p(weightedDownloads / categoryMedian)
}
```

### Bayesian Rating Average

Simple average ratings are unfair to apps with few reviews. A new app with 3 five-star reviews would rank above an established app with thousands of 4.8-star reviews:

```javascript
calculateRatingScore(app) {
  // Bayesian average prevents gaming with few early reviews
  const C = 100  // Confidence parameter (prior weight)
  const m = 3.5  // Global average rating

  const bayesianRating = (C * m + app.ratingSum) / (C + app.ratingCount)

  // Penalize apps with very few ratings
  const countMultiplier = Math.min(1, app.ratingCount / 50)

  return (bayesianRating / 5.0) * countMultiplier
}
```

**Example:**
- New app: 3 reviews at 5.0 stars
  - Bayesian: (100 * 3.5 + 15) / (100 + 3) = 3.56
- Established app: 1000 reviews at 4.5 stars
  - Bayesian: (100 * 3.5 + 4500) / (100 + 1000) = 4.41

### Engagement Signals

These signals are harder to fake because they require real user behavior:

```javascript
calculateEngagement(app) {
  // DAU/MAU ratio - stickiness
  const dauMau = app.dau / Math.max(app.mau, 1)

  // Session length (capped at reasonable max)
  const sessionScore = Math.min(app.avgSessionMinutes / 10, 1)

  // Day 7 retention - are users coming back?
  const retentionScore = app.day7Retention

  return dauMau * 0.4 + sessionScore * 0.3 + retentionScore * 0.3
}
```

## Deep Dive: Review Integrity System (7 minutes)

Fake reviews are a major problem. We use ML-based detection with multiple signals.

### Integrity Scoring

```javascript
class ReviewIntegrityService {
  async analyzeReview(review, userId, appId) {
    const signals = []

    // 1. User behavior signals
    signals.push({
      name: 'review_velocity',
      score: this.checkVelocity(await this.getUserReviews(userId)),
      weight: 0.15
    })

    // 2. Content quality
    signals.push({
      name: 'content_quality',
      score: await this.analyzeContent(review.text),
      weight: 0.25
    })

    // 3. Account signals
    signals.push({
      name: 'account_age',
      score: this.checkAccountAge(userId),
      weight: 0.10
    })

    // 4. Purchase verification
    signals.push({
      name: 'verified_purchase',
      score: (await this.verifyPurchase(userId, appId)) ? 1.0 : 0.3,
      weight: 0.20
    })

    // 5. Coordination detection
    signals.push({
      name: 'coordination',
      score: await this.checkCoordination(appId, review),
      weight: 0.20
    })

    // 6. Text similarity to other reviews
    signals.push({
      name: 'originality',
      score: await this.checkOriginality(review.text, appId),
      weight: 0.10
    })

    const integrityScore = signals.reduce((sum, s) => sum + s.score * s.weight, 0)

    return {
      integrityScore,
      signals,
      action: this.determineAction(integrityScore)
    }
  }

  determineAction(score) {
    if (score < 0.3) return 'reject'
    if (score < 0.6) return 'manual_review'
    return 'approve'
  }
}
```

### Review Velocity Detection

```javascript
checkVelocity(userReviews) {
  // Suspicious if many reviews in short time
  const last24Hours = userReviews.filter(
    r => Date.now() - r.createdAt < 24 * 60 * 60 * 1000
  )

  if (last24Hours.length > 5) return 0.2   // Very suspicious
  if (last24Hours.length > 2) return 0.6   // Somewhat suspicious
  return 1.0  // Normal
}
```

### Content Quality Analysis

```javascript
async analyzeContent(text) {
  // Flag generic/templated content
  const genericPhrases = [
    'great app', 'love it', 'best app ever',
    'must download', 'amazing', 'awesome'
  ]
  const hasGeneric = genericPhrases.some(p =>
    text.toLowerCase().includes(p)
  )

  // Check content length (too short = low effort)
  const lengthScore = Math.min(text.length / 100, 1)

  // Check for specific details (features, bugs, versions)
  const hasSpecifics = /\b(feature|update|version|bug|problem|solved)\b/i.test(text)

  return (
    (hasGeneric ? 0.5 : 1.0) * 0.3 +
    lengthScore * 0.3 +
    (hasSpecifics ? 1.0 : 0.5) * 0.4
  )
}
```

### Coordination Detection (Review Bombing)

```javascript
async checkCoordination(appId, review) {
  // Detect sudden spikes in reviews
  const last24Hours = await this.getRecentReviews(appId, 24)
  const avgDailyReviews = await this.getAvgDailyReviews(appId)

  // If 5x normal volume, something's off
  if (last24Hours.length > avgDailyReviews * 5) {
    return 0.3  // Suspicious
  }

  // Check for similar submission times (coordinated)
  const timestamps = last24Hours.map(r => r.createdAt)
  const clustering = this.detectTimeClustering(timestamps)
  if (clustering > 0.8) {
    return 0.4  // Coordinated timing
  }

  return 1.0  // Normal
}
```

## Deep Dive: Search Service (5 minutes)

Search must balance text relevance with app quality.

### Elasticsearch Query

```javascript
class SearchService {
  async search(query, options = {}) {
    const { category, price, rating } = options

    const esQuery = {
      bool: {
        must: [{
          multi_match: {
            query,
            fields: [
              'name^3',       // App name weighted highest
              'developer^2', // Developer name
              'description',
              'keywords'
            ],
            type: 'best_fields',
            fuzziness: 'AUTO'  // Typo tolerance
          }
        }],
        filter: []
      }
    }

    // Apply filters
    if (category) esQuery.bool.filter.push({ term: { category } })
    if (price === 'free') esQuery.bool.filter.push({ term: { isFree: true } })
    if (rating) esQuery.bool.filter.push({ range: { averageRating: { gte: rating } } })

    const results = await elasticsearch.search({ index: 'apps', body: { query: esQuery } })

    // Re-rank with quality signals
    return this.rerank(results.hits.hits, query)
  }

  rerank(hits, query) {
    return hits.map(hit => {
      const app = hit._source
      const textScore = hit._score

      // Quality signals
      const qualityScore =
        app.averageRating * 0.3 +
        Math.log1p(app.ratingCount) * 0.2 +
        Math.log1p(app.downloads) * 0.3 +
        app.engagementScore * 0.2

      // Combine text relevance (60%) and quality (40%)
      const finalScore = textScore * 0.6 + qualityScore * 0.4

      return { ...app, score: finalScore }
    }).sort((a, b) => b.score - a.score)
  }
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. Multi-Signal Ranking vs Download Count Only

**Chose: Multi-signal ranking**
- Pro: Hard to manipulate multiple signals simultaneously
- Pro: Surfaces quality apps, not just popular ones
- Con: More complex, harder to explain to developers
- Alternative: Pure download count (simple but easily gamed)

### 2. ML-Based Review Moderation vs Manual Only

**Chose: ML with human escalation**
- Pro: Scales to millions of reviews
- Pro: Learns from moderator decisions
- Con: Risk of false positives
- Alternative: Manual moderation (accurate but doesn't scale)

### 3. Elasticsearch vs PostgreSQL Full-Text Search

**Chose: Elasticsearch**
- Pro: Better ranking algorithms (BM25)
- Pro: Fuzzy matching, suggestions, faceted search
- Pro: Horizontal scaling
- Con: Additional infrastructure to maintain
- Alternative: PostgreSQL FTS (simpler but less powerful)

### 4. Hybrid Recommendations vs Pure Collaborative Filtering

**Chose: Hybrid (CF + content-based)**
- Pro: Handles cold start for new apps
- Pro: Content similarity for niche categories
- Con: More complex to tune
- Alternative: Pure CF (simpler but cold start problem)

### Database Schema

```sql
-- Apps
CREATE TABLE apps (
  id UUID PRIMARY KEY,
  bundle_id VARCHAR(200) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  developer_id UUID REFERENCES developers(id),
  category VARCHAR(100),
  description TEXT,
  version VARCHAR(50),
  is_free BOOLEAN DEFAULT TRUE,
  download_count BIGINT DEFAULT 0,
  average_rating DECIMAL,
  rating_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews with integrity scoring
CREATE TABLE reviews (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  app_id UUID REFERENCES apps(id),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  body TEXT,
  integrity_score DECIMAL,
  status VARCHAR(20) DEFAULT 'pending',  -- pending, approved, rejected
  created_at TIMESTAMP DEFAULT NOW()
);

-- Daily Rankings (precomputed)
CREATE TABLE rankings (
  date DATE,
  country VARCHAR(2),
  category VARCHAR(100),
  rank_type VARCHAR(20),  -- free, paid, grossing
  app_id UUID REFERENCES apps(id),
  rank INTEGER,
  PRIMARY KEY (date, country, category, rank_type, app_id)
);
```

## Closing Summary (1 minute)

"The App Store architecture is built around three key principles:

1. **Multi-signal ranking** - By combining download velocity, Bayesian ratings, engagement metrics, and freshness, we create rankings that are hard to game. An attacker would need to fake real user behavior across multiple dimensions.

2. **Review integrity scoring** - ML-based analysis of review velocity, content quality, verified purchases, and coordination patterns catches fake reviews before they impact rankings.

3. **Quality-aware search** - Search results combine text relevance with quality signals, ensuring users find good apps, not just the ones with keyword-stuffed descriptions.

The main trade-off is complexity vs. gaming resistance. Our multi-signal approach requires more infrastructure and is harder to explain to developers, but it creates a fairer marketplace where quality apps can succeed."

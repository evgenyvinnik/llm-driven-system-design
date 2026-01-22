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

---

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

---

## Deep Dive: Database Schema Design

### Core Tables Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                         DEVELOPERS                               │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK)  │ user_id (FK) │ company_name │ verified │ ...    │
└───────────────┬─────────────────────────────────────────────────┘
                │ 1:N
                ▼
┌─────────────────────────────────────────────────────────────────┐
│                            APPS                                  │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK)      │ bundle_id (UNIQUE)    │ name               │
│ developer_id (FK) │ category              │ subcategory        │
│ description       │ version               │ size_bytes         │
│ is_free           │ age_rating            │                    │
├─────────────────────────────────────────────────────────────────┤
│           AGGREGATED METRICS (for ranking)                      │
├─────────────────────────────────────────────────────────────────┤
│ download_count    │ rating_sum            │ rating_count       │
│ average_rating    │ (computed column)     │                    │
├─────────────────────────────────────────────────────────────────┤
│           ENGAGEMENT METRICS (from analytics)                   │
├─────────────────────────────────────────────────────────────────┤
│ dau               │ mau                   │ day7_retention     │
│ avg_session_min   │                       │                    │
└───────────────────┬─────────────────────────────────────────────┘
                    │ 1:N
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                          REVIEWS                                 │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK)      │ user_id (FK)          │ app_id (FK)        │
│ rating (1-5)      │ title                 │ body               │
├─────────────────────────────────────────────────────────────────┤
│           INTEGRITY ANALYSIS                                    │
├─────────────────────────────────────────────────────────────────┤
│ integrity_score   │ integrity_signals     │ status             │
│ (DECIMAL)         │ (JSONB)               │ (pending/approved) │
├─────────────────────────────────────────────────────────────────┤
│           DEVELOPER RESPONSE                                    │
├─────────────────────────────────────────────────────────────────┤
│ developer_response │ developer_response_at │                   │
└───────────────────┬─────────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────┐       ┌───────────────────────────────────────┐
│   RANKINGS    │       │              PURCHASES                │
├───────────────┤       ├───────────────────────────────────────┤
│ date          │       │ id (UUID PK)    │ user_id (FK)        │
│ country       │       │ app_id (FK)     │ price_id (FK)       │
│ category      │       │ amount          │ currency            │
│ rank_type     │       │ payment_id      │ receipt_data        │
│ app_id (FK)   │       │ purchased_at    │ expires_at          │
│ rank          │       └───────────────────────────────────────┘
│ score         │
└───────────────┘

INDEXES:
├── idx_apps_category ON apps(category)
├── idx_apps_developer ON apps(developer_id)
├── idx_apps_ranking ON apps(category, download_count DESC)
├── idx_reviews_app ON reviews(app_id, created_at DESC)
├── idx_reviews_status ON reviews(status) WHERE status = 'pending'
├── idx_purchases_user ON purchases(user_id)
└── idx_purchases_app_user ON purchases(app_id, user_id)
```

---

## Deep Dive: Multi-Signal Ranking Algorithm

### Ranking Signal Weights

```
┌─────────────────────────────────────────────────────────────────┐
│                    RANKING SCORE COMPUTATION                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   FINAL_SCORE = Σ (signal_value × weight)                       │
│                                                                 │
│   ┌───────────────────────────┬────────┬───────────────────┐   │
│   │ Signal                    │ Weight │ Purpose            │   │
│   ├───────────────────────────┼────────┼───────────────────┤   │
│   │ Download Velocity         │  0.30  │ Trending apps      │   │
│   │ Rating Score (Bayesian)   │  0.25  │ User satisfaction  │   │
│   │ Engagement Score          │  0.20  │ Real usage metrics │   │
│   │ Revenue Score             │  0.15  │ Commercial success │   │
│   │ Freshness Score           │  0.10  │ Recent updates     │   │
│   └───────────────────────────┴────────┴───────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Download Velocity Computation

```
┌─────────────────────────────────────────────────────────────────┐
│              DOWNLOAD VELOCITY (Exponential Decay)               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   FOR each day in app.dailyDownloads:                           │
│       daysAgo = (now - day.date) / (24 × 60 × 60 × 1000)        │
│       weight = exp(-daysAgo / 7)    ◀── Half-life of 1 week    │
│       weightedDownloads += day.count × weight                   │
│                                                                 │
│   RETURN log1p(weightedDownloads / max(categoryMedian, 1))      │
│                    ▲                                            │
│                    └── Normalize by category for fair comparison│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Bayesian Average Rating

"We use Bayesian averaging to prevent gaming with early fake reviews. Apps with few ratings get pulled toward the global average until they accumulate enough legitimate reviews."

```
┌─────────────────────────────────────────────────────────────────┐
│                    BAYESIAN RATING FORMULA                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   C = 100          ◀── Confidence parameter (prior weight)     │
│   m = 3.5          ◀── Global average rating                   │
│                                                                 │
│   bayesianRating = (C × m + ratingSum) / (C + ratingCount)      │
│                                                                 │
│   countMultiplier = min(1, ratingCount / 50)                    │
│                            ▲                                    │
│                            └── Penalize apps with few ratings   │
│                                                                 │
│   FINAL = (bayesianRating / 5.0) × countMultiplier              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Engagement Score (Hard to Fake)

```
┌─────────────────────────────────────────────────────────────────┐
│                    ENGAGEMENT COMPUTATION                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   "Engagement metrics are harder to fake - they require         │
│    real user behavior, not just downloads or reviews."          │
│                                                                 │
│   ┌────────────────────────────────────────────────────────┐   │
│   │ Component              │ Weight │ Calculation          │   │
│   ├────────────────────────┼────────┼──────────────────────┤   │
│   │ DAU/MAU Ratio          │  0.40  │ dau / max(mau, 1)    │   │
│   │ Session Duration       │  0.30  │ min(avgMin / 10, 1)  │   │
│   │ Day-7 Retention        │  0.30  │ day7Retention        │   │
│   └────────────────────────┴────────┴──────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Review Integrity System

### Multi-Signal Fake Review Detection

```
┌─────────────────────────────────────────────────────────────────┐
│                  INTEGRITY ANALYSIS FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Review Submitted ──▶ Analyze 6 Signals ──▶ Compute Score      │
│                                │                                │
│                                ▼                                │
│   ┌────────────────────────────────────────────────────────┐   │
│   │ Signal              │ Weight │ Description             │   │
│   ├─────────────────────┼────────┼─────────────────────────┤   │
│   │ Review Velocity     │  0.15  │ Many reviews = spam     │   │
│   │ Content Quality     │  0.25  │ Generic phrase detect   │   │
│   │ Account Age         │  0.10  │ New accounts suspicious │   │
│   │ Verified Purchase   │  0.20  │ Actually downloaded?    │   │
│   │ Coordination        │  0.20  │ Review bombing detect   │   │
│   │ Originality         │  0.10  │ Similarity to others    │   │
│   └─────────────────────┴────────┴─────────────────────────┘   │
│                                │                                │
│                                ▼                                │
│   ┌────────────────────────────────────────────────────────┐   │
│   │ Score Range         │ Action                           │   │
│   ├─────────────────────┼──────────────────────────────────┤   │
│   │ < 0.3               │ REJECT automatically             │   │
│   │ 0.3 - 0.6           │ MANUAL_REVIEW required           │   │
│   │ > 0.6               │ APPROVE automatically            │   │
│   └─────────────────────┴──────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Velocity Check Logic

```
┌─────────────────────────────────────────────────────────────────┐
│                    VELOCITY SCORING                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   recentReviews = getUserRecentReviews(userId, 24 hours)        │
│                                                                 │
│   IF recentReviews.length > 5  ──▶ RETURN 0.2  (Very suspicious)│
│   IF recentReviews.length > 2  ──▶ RETURN 0.6  (Somewhat sus)   │
│   ELSE                         ──▶ RETURN 1.0  (Normal)         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Content Quality Analysis

```
┌─────────────────────────────────────────────────────────────────┐
│                 CONTENT ANALYSIS SCORING                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   GENERIC PHRASES (red flags):                                  │
│   ┌────────────────────────────────────────────────────────┐   │
│   │ "great app" │ "love it" │ "best app ever" │ "5 stars" │   │
│   │ "must download" │ "amazing" │ "awesome"                │   │
│   └────────────────────────────────────────────────────────┘   │
│                                                                 │
│   SCORE COMPUTATION:                                            │
│   ├── hasGeneric: contains generic phrase?  × 0.3              │
│   │     IF yes → 0.5, IF no → 1.0                              │
│   ├── lengthScore: min(text.length / 100, 1) × 0.3             │
│   └── hasSpecifics: mentions feature/bug/crash? × 0.4          │
│         IF yes → 1.0, IF no → 0.5                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Coordination Detection (Review Bombing)

```
┌─────────────────────────────────────────────────────────────────┐
│                  COORDINATION DETECTION                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   recentReviews = getAppReviews(appId, 24 hours)                │
│   avgDaily = getAvgDailyReviews(appId)                          │
│                                                                 │
│   SPIKE DETECTION:                                              │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ IF recentReviews.length > avgDaily × 5                  │  │
│   │     ──▶ RETURN 0.3 (Suspicious spike)                   │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   TIME CLUSTERING:                                              │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ clustering = detectTimeClustering(timestamps)            │  │
│   │ IF clustering > 0.8                                      │  │
│   │     ──▶ RETURN 0.4 (Coordinated timing)                 │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   ELSE ──▶ RETURN 1.0 (Normal pattern)                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Elasticsearch Search Integration

### Index Configuration

```
┌─────────────────────────────────────────────────────────────────┐
│                 ELASTICSEARCH INDEX: apps                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   SETTINGS:                                                     │
│   ├── analyzer: app_analyzer (custom)                           │
│   │   ├── tokenizer: standard                                   │
│   │   └── filters: lowercase, asciifolding, app_synonyms        │
│   │                                                             │
│   └── synonyms:                                                 │
│       ├── photo, picture, image                                 │
│       ├── video, movie, film                                    │
│       └── game, gaming                                          │
│                                                                 │
│   FIELD MAPPINGS:                                               │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ Field           │ Type    │ Boost │ Analyzer            │  │
│   ├─────────────────┼─────────┼───────┼─────────────────────┤  │
│   │ id              │ keyword │   -   │ -                   │  │
│   │ name            │ text    │   3   │ app_analyzer        │  │
│   │ developer       │ text    │   2   │ app_analyzer        │  │
│   │ description     │ text    │   1   │ app_analyzer        │  │
│   │ keywords        │ text    │   1   │ app_analyzer        │  │
│   │ category        │ keyword │   -   │ -                   │  │
│   │ isFree          │ boolean │   -   │ -                   │  │
│   │ averageRating   │ float   │   -   │ -                   │  │
│   │ downloads       │ long    │   -   │ -                   │  │
│   │ engagementScore │ float   │   -   │ -                   │  │
│   └─────────────────┴─────────┴───────┴─────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Search with Quality Re-ranking

"We fetch more results than needed, then re-rank combining text relevance with quality signals. This prevents low-quality apps from ranking high just because of keyword stuffing."

```
┌─────────────────────────────────────────────────────────────────┐
│                    SEARCH FLOW                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Query: "photo editor"                                         │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ ELASTICSEARCH QUERY                                      │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ multi_match:                                             │  │
│   │   query: "photo editor"                                  │  │
│   │   fields: [name^3, developer^2, description, keywords]   │  │
│   │   type: best_fields                                      │  │
│   │   fuzziness: AUTO  ◀── Typo tolerance                   │  │
│   │                                                          │  │
│   │ filters:                                                 │  │
│   │   category: "Photo & Video" (if specified)               │  │
│   │   isFree: true (if specified)                           │  │
│   │   averageRating: >= 4.0 (if specified)                  │  │
│   │                                                          │  │
│   │ size: limit × 2  ◀── Fetch extra for re-ranking         │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ RE-RANKING                                               │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │                                                          │  │
│   │ qualityScore =                                           │  │
│   │   averageRating      × 0.3                               │  │
│   │ + log1p(ratingCount) × 0.2                               │  │
│   │ + log1p(downloads)   × 0.3                               │  │
│   │ + engagementScore    × 0.2                               │  │
│   │                                                          │  │
│   │ finalScore = textScore × 0.6 + qualityScore × 0.4        │  │
│   │              ▲                                           │  │
│   │              └── 60% relevance, 40% quality              │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼                                            │
│   Return top N results sorted by finalScore                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Purchase Idempotency

### Three-Layer Protection

"Purchase operations require idempotency to handle network failures and retries safely. We use three layers: Redis cache, distributed lock, and database constraint."

```
┌─────────────────────────────────────────────────────────────────┐
│                 PURCHASE FLOW (3-Layer Idempotency)              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Request: purchaseApp(userId, appId, priceId, idempotencyKey)  │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ LAYER 1: Redis Cache Check                               │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ GET idem:purchase:{userId}:{idempotencyKey}              │  │
│   │                                                          │  │
│   │ IF cached ──▶ RETURN cached result (no reprocessing)     │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼ (not cached)                               │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ LAYER 2: Distributed Lock                                │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ SET lock:purchase:{userId}:{idempotencyKey} "1" NX EX 30 │  │
│   │                                                          │  │
│   │ IF not acquired ──▶ THROW ConflictError                  │  │
│   │    "Purchase already in progress"                        │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼ (lock acquired)                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ LAYER 3: Database Duplicate Check                        │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ SELECT id FROM purchases                                 │  │
│   │ WHERE user_id = $1 AND app_id = $2                       │  │
│   │   AND purchased_at > NOW() - INTERVAL '1 hour'           │  │
│   │                                                          │  │
│   │ IF exists ──▶ THROW AlreadyPurchasedError                │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼ (no duplicate)                             │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ PROCESS PURCHASE                                         │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ 1. Charge payment via paymentService                     │  │
│   │ 2. BEGIN TRANSACTION                                     │  │
│   │    ├── INSERT INTO purchases                             │  │
│   │    ├── INSERT INTO user_apps                             │  │
│   │    └── UPDATE apps SET download_count += 1               │  │
│   │ 3. COMMIT TRANSACTION                                    │  │
│   │ 4. Generate receipt                                      │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ POST-PROCESSING                                          │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ • SETEX result in Redis (24h TTL) for idempotency        │  │
│   │ • PUBLISH "purchase.completed" to RabbitMQ               │  │
│   │ • DELETE lock key                                        │  │
│   │ • RETURN { purchase, receipt }                           │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Async Processing with RabbitMQ

### Queue Configuration

```
┌─────────────────────────────────────────────────────────────────┐
│                      MESSAGE QUEUES                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ Queue             │ TTL      │ Notes                    │  │
│   ├───────────────────┼──────────┼──────────────────────────┤  │
│   │ review.created    │ 24 hours │ Integrity analysis       │  │
│   │ purchase.completed│ 7 days   │ Critical for payouts     │  │
│   │ ranking.compute   │ -        │ Priority queue (0-10)    │  │
│   │ search.reindex    │ -        │ Prefetch: 5 (batch ES)   │  │
│   └───────────────────┴──────────┴──────────────────────────┘  │
│                                                                 │
│   All queues: durable = true, deadLetterExchange = app-store.dlx│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Review Worker Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                   REVIEW WORKER FLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   consume("review.created", prefetch: 1)  ◀── ML inference slow │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ DEDUPLICATION CHECK                                      │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ GET processed:review:{eventId}                           │  │
│   │ IF exists ──▶ ACK message (already processed)            │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼ (not processed)                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ RUN INTEGRITY ANALYSIS                                   │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ result = reviewIntegrityService.analyzeReview(           │  │
│   │   review, userId, appId                                  │  │
│   │ )                                                        │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ UPDATE REVIEW STATUS                                     │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ UPDATE reviews SET                                       │  │
│   │   integrity_score = result.score,                        │  │
│   │   integrity_signals = result.signals,                    │  │
│   │   status = result.action                                 │  │
│   │ WHERE id = reviewId                                      │  │
│   │                                                          │  │
│   │ SETEX processed:review:{eventId} 86400 "1"               │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ ERROR HANDLING                                           │  │
│   ├─────────────────────────────────────────────────────────┤  │
│   │ ON SUCCESS: ACK message                                  │  │
│   │                                                          │  │
│   │ ON ERROR:                                                │  │
│   │   retryCount = headers['x-retry-count'] + 1              │  │
│   │   IF retryCount <= 3                                     │  │
│   │       setTimeout(exponentialBackoff) ──▶ Re-publish      │  │
│   │   ELSE                                                   │  │
│   │       NACK(requeue: false) ──▶ Send to DLQ               │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Circuit Breaker Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                   CIRCUIT BREAKER STATES                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│            ┌──────────┐         ┌──────────┐                   │
│            │  CLOSED  │◀───────▶│   OPEN   │                   │
│            └────┬─────┘         └────┬─────┘                   │
│                 │                    │                          │
│                 │   ┌───────────┐    │                          │
│                 └──▶│ HALF_OPEN │◀───┘                          │
│                     └───────────┘                               │
│                                                                 │
│   CLOSED → OPEN:                                                │
│     failures >= failureThreshold                                │
│                                                                 │
│   OPEN → HALF_OPEN:                                             │
│     now - lastFailure > resetTimeout                            │
│                                                                 │
│   HALF_OPEN → CLOSED:                                           │
│     next request succeeds                                       │
│                                                                 │
│   HALF_OPEN → OPEN:                                             │
│     next request fails                                          │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│   PRE-CONFIGURED BREAKERS                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌───────────────┬──────────────────┬───────────────┐         │
│   │ Service       │ Failure Threshold │ Reset Timeout │         │
│   ├───────────────┼──────────────────┼───────────────┤         │
│   │ Elasticsearch │ 3 failures        │ 30 seconds    │         │
│   │ Payment       │ 2 failures        │ 60 seconds    │         │
│   └───────────────┴──────────────────┴───────────────┘         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Observability

### Prometheus Metrics

```
┌─────────────────────────────────────────────────────────────────┐
│                    METRICS COLLECTION                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   REQUEST METRICS (Histogram):                                  │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ http_request_duration_seconds                            │  │
│   │   labels: [method, route, status]                        │  │
│   │   buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5]          │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   BUSINESS METRICS (Counter):                                   │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ purchases_total                                          │  │
│   │   labels: [status, country]                              │  │
│   │                                                          │  │
│   │ reviews_analyzed_total                                   │  │
│   │   labels: [action]  ── approve, reject, manual_review    │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   LATENCY METRICS (Histogram):                                  │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ search_latency_seconds                                   │  │
│   │   labels: [has_filters]                                  │  │
│   │   buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5]           │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   INFRASTRUCTURE METRICS (Gauge):                               │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ circuit_breaker_state                                    │  │
│   │   labels: [name]                                         │  │
│   │   values: 0=closed, 0.5=half_open, 1=open                │  │
│   │                                                          │  │
│   │ rabbitmq_queue_depth                                     │  │
│   │   labels: [queue]                                        │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Structured Logging

```
┌─────────────────────────────────────────────────────────────────┐
│                    REQUEST LOGGING                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Logger: pino (JSON format)                                    │
│                                                                 │
│   Each request:                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ {                                                        │  │
│   │   "level": "info",                                       │  │
│   │   "requestId": "uuid-from-x-request-id-or-generated",    │  │
│   │   "userId": "session-user-id",                           │  │
│   │   "method": "POST",                                      │  │
│   │   "path": "/api/v1/reviews",                             │  │
│   │   "status": 201,                                         │  │
│   │   "duration": 45,                                        │  │
│   │   "msg": "request completed"                             │  │
│   │ }                                                        │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Ranking algorithm | Multi-signal ML | Download count only | Manipulation resistance |
| Review moderation | ML + human escalation | Manual only | Scales to millions |
| Search engine | Elasticsearch | PostgreSQL FTS | Better relevance, fuzzy matching |
| Message queue | RabbitMQ | Kafka | Simpler for moderate scale |
| Idempotency | Redis + DB | DB only | Faster, handles concurrent retries |
| Consistency | Strong for purchases | Eventual everywhere | Financial correctness |

---

## Future Backend Enhancements

1. **Kafka Integration**: Higher throughput event streaming for rankings pipeline
2. **ML Model Serving**: TensorFlow Serving for real-time fraud detection
3. **Sharded Elasticsearch**: Geographic sharding for global search
4. **Read Replicas**: PostgreSQL replicas for analytics queries
5. **GraphQL API**: Efficient mobile data fetching with batched queries
6. **Real-time Rankings**: Stream processing with Flink for live chart updates

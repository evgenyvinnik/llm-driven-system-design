# Yelp System Design Interview Answer

## Opening Statement

"I'll be designing a local business review and discovery platform like Yelp. The core challenges involve efficient geo-spatial search, review aggregation, and search relevance. Let me start by clarifying what we need to build."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Business Search**
   - Search businesses by keyword, category, and location
   - Filter by rating, price, distance, open hours
   - Sort by relevance, rating, distance, or reviews count

2. **Business Profiles**
   - Display business information (name, address, hours, photos)
   - Show aggregate rating and review count
   - Display individual reviews with ratings

3. **Reviews and Ratings**
   - Users can write reviews with 1-5 star ratings
   - Reviews can include photos
   - Helpful/funny/cool voting on reviews

4. **Geo-Search**
   - "Restaurants near me" queries
   - Map-based browsing
   - Distance-based results

5. **Business Owner Features**
   - Claim and manage business listing
   - Respond to reviews
   - Update business information

### Non-Functional Requirements

- **Latency**: Search results < 200ms
- **Availability**: 99.9% uptime
- **Scale**: 200 million businesses, 200 million reviews
- **Freshness**: New reviews appear within minutes

---

## 2. Scale Estimation (2-3 minutes)

**Data Volume**
- 200 million businesses
- 200 million reviews (average 1 review per business, varying widely)
- 100 million monthly active users

**Request Patterns**
- Search queries: 10,000/second at peak
- Business page views: 50,000/second
- New reviews: 100/second

**Storage**
- Business data: 200M x 2KB = 400 GB
- Reviews: 200M x 1KB = 200 GB
- Photos: 1 billion photos x 200KB avg = 200 TB
- Search index: ~50-100 GB

**Read-heavy workload**: 1000:1 read-to-write ratio for businesses

---

## 3. High-Level Architecture (8-10 minutes)

```
                              ┌─────────────────────────────┐
                              │         CDN                  │
                              │    (Photos, Static Assets)   │
                              └──────────────┬──────────────┘
                                             │
    ┌──────────────┐                        │              ┌──────────────┐
    │   Web App    │                        │              │  Mobile App  │
    └──────┬───────┘                        │              └──────┬───────┘
           │                                │                     │
           └────────────────────────────────┼─────────────────────┘
                                            │
                              ┌─────────────┴─────────────┐
                              │       API Gateway          │
                              │     + Load Balancer        │
                              └─────────────┬─────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              │                             │                             │
              ▼                             ▼                             ▼
    ┌─────────────────┐           ┌─────────────────┐           ┌─────────────────┐
    │  Search Service │           │Business Service │           │ Review Service  │
    │                 │           │                 │           │                 │
    │ - Keyword search│           │ - CRUD business │           │ - Create review │
    │ - Geo queries   │           │ - Business page │           │ - Aggregate     │
    │ - Filters       │           │ - Claim/verify  │           │   ratings       │
    └────────┬────────┘           └────────┬────────┘           └────────┬────────┘
             │                             │                             │
             ▼                             │                             │
    ┌─────────────────┐                    │                             │
    │  Elasticsearch  │                    │                             │
    │                 │                    │                             │
    │ - Business docs │                    │                             │
    │ - Geo indexing  │                    │                             │
    └─────────────────┘                    │                             │
                                           │                             │
                              ┌────────────┴─────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐           ┌─────────────────┐
                    │   PostgreSQL    │           │      Redis      │
                    │                 │           │                 │
                    │ - Businesses    │           │ - Search cache  │
                    │ - Reviews       │           │ - Business cache│
                    │ - Users         │           │ - Rate limiting │
                    └─────────────────┘           └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │    S3 + CDN     │
                    │                 │
                    │ - Business photos│
                    │ - Review photos │
                    └─────────────────┘
```

### Core Components

**1. Search Service**
- Handles keyword and geo-spatial searches
- Integrates with Elasticsearch for full-text and geo queries
- Applies filters and ranking

**2. Business Service**
- Manages business data and profiles
- Handles business claiming and verification
- Aggregates ratings from reviews

**3. Review Service**
- Handles review creation and moderation
- Manages review voting (helpful/funny/cool)
- Triggers rating recalculation

**4. Elasticsearch**
- Full-text search with relevance ranking
- Geo-spatial queries (geo_distance, geo_bounding_box)
- Faceted search for filters

**5. PostgreSQL**
- Source of truth for all structured data
- Transactional consistency for reviews
- Complex queries for analytics

---

## 4. Deep Dive: Geo-Spatial Search (7-8 minutes)

This is the most critical component. Users search by location constantly.

### Elasticsearch Geo Queries

```json
// Business document in Elasticsearch
{
  "id": "biz_123",
  "name": "Joe's Pizza",
  "categories": ["pizza", "italian", "restaurants"],
  "location": {
    "lat": 40.7128,
    "lon": -74.0060
  },
  "rating": 4.5,
  "review_count": 234,
  "price_level": 2,
  "hours": {...},
  "city": "New York",
  "state": "NY"
}
```

**Index Mapping:**
```json
{
  "mappings": {
    "properties": {
      "location": { "type": "geo_point" },
      "name": { "type": "text", "analyzer": "standard" },
      "categories": { "type": "keyword" },
      "rating": { "type": "float" },
      "review_count": { "type": "integer" },
      "price_level": { "type": "integer" }
    }
  }
}
```

### Search Query Example

"Pizza near me, 4+ stars, $$ or less"

```json
{
  "query": {
    "bool": {
      "must": [
        { "match": { "categories": "pizza" } }
      ],
      "filter": [
        {
          "geo_distance": {
            "distance": "10km",
            "location": { "lat": 40.7128, "lon": -74.0060 }
          }
        },
        { "range": { "rating": { "gte": 4.0 } } },
        { "range": { "price_level": { "lte": 2 } } }
      ]
    }
  },
  "sort": [
    { "_score": "desc" },
    {
      "_geo_distance": {
        "location": { "lat": 40.7128, "lon": -74.0060 },
        "order": "asc"
      }
    }
  ]
}
```

### Relevance Scoring

```javascript
function calculateRelevance(business, query, userLocation) {
  let score = 0;

  // Text match relevance (from Elasticsearch)
  score += esTextScore * 100;

  // Distance (closer = better)
  const distance = haversine(userLocation, business.location);
  score += Math.max(0, 100 - distance * 2); // Max 10km bonus

  // Rating boost
  score += business.rating * 10;

  // Review count (logarithmic - diminishing returns)
  score += Math.log10(business.reviewCount + 1) * 5;

  // Recency of reviews (fresh reviews = active business)
  const daysSinceLastReview = daysBetween(now, business.lastReviewDate);
  if (daysSinceLastReview < 30) score += 10;

  return score;
}
```

### Alternative: QuadTree for Map View

For map-based browsing (show businesses in viewport):

```javascript
class QuadTree {
  constructor(bounds, maxItems = 10) {
    this.bounds = bounds; // {minLat, maxLat, minLng, maxLng}
    this.items = [];
    this.children = null;
  }

  insert(business) {
    if (!this.contains(business.location)) return false;

    if (this.items.length < this.maxItems) {
      this.items.push(business);
    } else {
      if (!this.children) this.subdivide();
      for (const child of this.children) {
        child.insert(business);
      }
    }
  }

  queryRange(bounds) {
    const results = [];
    if (!this.intersects(bounds)) return results;

    for (const item of this.items) {
      if (this.isInBounds(item.location, bounds)) {
        results.push(item);
      }
    }

    if (this.children) {
      for (const child of this.children) {
        results.push(...child.queryRange(bounds));
      }
    }

    return results;
  }
}
```

---

## 5. Deep Dive: Review System and Rating Aggregation (6-7 minutes)

### Review Creation Flow

```javascript
async function createReview(userId, businessId, reviewData) {
  // 1. Validate user hasn't reviewed this business
  const existing = await db.query(
    'SELECT id FROM reviews WHERE user_id = $1 AND business_id = $2',
    [userId, businessId]
  );
  if (existing.rows.length > 0) {
    throw new Error('Already reviewed this business');
  }

  // 2. Create review
  const review = await db.query(
    `INSERT INTO reviews (user_id, business_id, rating, text, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id`,
    [userId, businessId, reviewData.rating, reviewData.text]
  );

  // 3. Queue rating recalculation
  await messageQueue.publish('review.created', {
    businessId,
    reviewId: review.rows[0].id
  });

  // 4. Update search index asynchronously
  await elasticsearch.update({
    index: 'businesses',
    id: businessId,
    body: {
      script: {
        source: 'ctx._source.review_count += 1'
      }
    }
  });

  return review.rows[0];
}
```

### Rating Aggregation

**Approach 1: Recalculate on Every Review (Simple)**
```javascript
async function recalculateRating(businessId) {
  const result = await db.query(
    `SELECT AVG(rating) as avg_rating, COUNT(*) as review_count
     FROM reviews WHERE business_id = $1`,
    [businessId]
  );

  await db.query(
    `UPDATE businesses
     SET rating = $1, review_count = $2
     WHERE id = $3`,
    [result.rows[0].avg_rating, result.rows[0].review_count, businessId]
  );
}
```

**Approach 2: Incremental Update (Efficient)**
```javascript
async function updateRatingIncremental(businessId, newRating) {
  // Uses denormalized sum and count
  await db.query(
    `UPDATE businesses
     SET rating_sum = rating_sum + $1,
         review_count = review_count + 1,
         rating = (rating_sum + $1) / (review_count + 1)
     WHERE id = $2`,
    [newRating, businessId]
  );
}
```

### Weighted Rating (Bayesian Average)

Prevents businesses with few reviews from having extreme ratings:

```javascript
function bayesianRating(businessRating, businessReviewCount) {
  const C = 3.5;  // Prior mean (average across all businesses)
  const m = 10;   // Minimum reviews for full weight

  return (businessReviewCount * businessRating + m * C) / (businessReviewCount + m);
}

// Business with 1 review of 5 stars: (1 * 5 + 10 * 3.5) / 11 = 3.64
// Business with 100 reviews of 5 stars: (100 * 5 + 10 * 3.5) / 110 = 4.86
```

---

## 6. Deep Dive: Search Relevance and Ranking (5-6 minutes)

### Multi-Factor Ranking

```javascript
async function searchBusinesses(query, userLocation, filters) {
  // 1. Get candidates from Elasticsearch
  const esResults = await elasticsearch.search({
    index: 'businesses',
    body: buildEsQuery(query, userLocation, filters)
  });

  // 2. Enhance with business context
  const businessIds = esResults.hits.hits.map(h => h._id);
  const enrichedData = await getBusinessEnrichment(businessIds);

  // 3. Re-rank with custom scoring
  const ranked = esResults.hits.hits.map(hit => {
    const business = enrichedData[hit._id];
    return {
      ...hit._source,
      finalScore: calculateFinalScore(
        hit._score,
        business,
        userLocation,
        query
      )
    };
  });

  ranked.sort((a, b) => b.finalScore - a.finalScore);

  return ranked;
}

function calculateFinalScore(esScore, business, userLocation, query) {
  let score = esScore * 100; // Base relevance

  // Distance decay
  const distance = calculateDistance(userLocation, business.location);
  score *= Math.exp(-distance / 5); // 5km decay constant

  // Quality signals
  score += business.bayesianRating * 10;
  score += Math.log10(business.reviewCount + 1) * 5;

  // Freshness
  if (business.lastReviewWithin30Days) score += 5;

  // Category match bonus
  if (business.categories.includes(query.category)) score += 20;

  // Open now bonus
  if (filters.openNow && business.isOpenNow) score += 15;

  return score;
}
```

### Search Autocomplete

```javascript
// Use Elasticsearch completion suggester
const mapping = {
  "suggest": {
    "type": "completion",
    "analyzer": "simple",
    "preserve_separators": true,
    "preserve_position_increments": true,
    "max_input_length": 50
  }
};

// Query
async function autocomplete(prefix, location) {
  const result = await elasticsearch.search({
    index: 'businesses',
    body: {
      suggest: {
        business_suggest: {
          prefix: prefix,
          completion: {
            field: 'suggest',
            size: 10,
            contexts: {
              location: {
                lat: location.lat,
                lon: location.lon,
                precision: 4 // ~20km radius
              }
            }
          }
        }
      }
    }
  });

  return result.suggest.business_suggest[0].options;
}
```

---

## 7. Data Model (3-4 minutes)

### PostgreSQL Schema

```sql
CREATE TABLE businesses (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(50),
    zip_code VARCHAR(20),
    latitude DECIMAL(10, 7),
    longitude DECIMAL(10, 7),
    phone VARCHAR(20),
    website VARCHAR(255),
    categories TEXT[], -- Array of category slugs
    price_level INTEGER, -- 1-4
    rating DECIMAL(2, 1),
    review_count INTEGER DEFAULT 0,
    rating_sum DECIMAL(10, 1) DEFAULT 0, -- For incremental updates
    is_claimed BOOLEAN DEFAULT FALSE,
    owner_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_businesses_location ON businesses
    USING gist (ll_to_earth(latitude, longitude));
CREATE INDEX idx_businesses_rating ON businesses(rating DESC);
CREATE INDEX idx_businesses_categories ON businesses USING GIN(categories);

CREATE TABLE reviews (
    id UUID PRIMARY KEY,
    business_id UUID REFERENCES businesses(id),
    user_id UUID REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    text TEXT,
    helpful_count INTEGER DEFAULT 0,
    funny_count INTEGER DEFAULT 0,
    cool_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(business_id, user_id)
);

CREATE INDEX idx_reviews_business ON reviews(business_id, created_at DESC);
CREATE INDEX idx_reviews_user ON reviews(user_id);

CREATE TABLE review_photos (
    id UUID PRIMARY KEY,
    review_id UUID REFERENCES reviews(id),
    photo_url TEXT NOT NULL,
    caption TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE business_hours (
    business_id UUID REFERENCES businesses(id),
    day_of_week INTEGER, -- 0=Sunday, 6=Saturday
    open_time TIME,
    close_time TIME,
    PRIMARY KEY (business_id, day_of_week)
);
```

### Redis Cache Structure

```
# Business detail cache
business:{id} -> JSON { name, rating, ... }
TTL: 1 hour

# Search result cache (by query hash)
search:{query_hash} -> JSON [business_ids]
TTL: 5 minutes

# Popular searches per location
popular:{geohash} -> ZSET { query: count }
TTL: 1 hour
```

---

## 8. Trade-offs and Alternatives (4-5 minutes)

### Search Technology

| Option | Pros | Cons |
|--------|------|------|
| Elasticsearch | Full-text + geo, battle-tested | Complex to operate |
| PostgreSQL + PostGIS | Single DB, ACID | Slower full-text search |
| Solr | Similar to ES, good geo | Less popular, fewer integrations |
| Algolia | Managed, fast | Expensive at scale |

**Decision**: Elasticsearch for search, PostgreSQL as source of truth

### Geo-Indexing Approach

| Option | Pros | Cons |
|--------|------|------|
| Geohashing | Simple, cacheable | Edge cases at boundaries |
| R-Tree (PostGIS) | Accurate | Query complexity |
| ES geo_point | Integrated with search | Tied to ES |
| QuadTree | Good for map view | Custom implementation |

**Decision**: ES geo_point for search, QuadTree for map clustering

### Rating Calculation

| Option | Pros | Cons |
|--------|------|------|
| Simple average | Easy to understand | Unfair to new businesses |
| Bayesian average | Fairer | Harder to explain |
| Time-weighted | Reflects recent quality | Complex, needs tuning |

**Decision**: Bayesian average with simple average shown to users

---

## 9. Spam and Fraud Detection (3-4 minutes)

### Review Spam Indicators

```javascript
function calculateSpamScore(review, user, business) {
  let spamScore = 0;

  // User signals
  if (user.reviewCount < 3) spamScore += 10; // New user
  if (user.allReviewsSameRating) spamScore += 20;
  if (user.reviewedCompetitors) spamScore += 30; // Reviewed competitors

  // Review signals
  if (review.text.length < 20) spamScore += 10;
  if (containsSpamKeywords(review.text)) spamScore += 25;
  if (review.postedWithinMinutesOfAccountCreation) spamScore += 20;

  // Pattern signals
  if (suddenReviewSpike(business)) spamScore += 15;
  if (multipleReviewsFromSameIP) spamScore += 40;

  return spamScore;
}

async function handleNewReview(review) {
  const spamScore = calculateSpamScore(review, review.user, review.business);

  if (spamScore > 70) {
    await flagForModeration(review);
    return; // Don't publish
  }

  if (spamScore > 40) {
    await flagForModeration(review);
    // Publish but monitor
  }

  await publishReview(review);
}
```

### Fake Business Detection

- Multiple businesses at same address
- Businesses with only 5-star reviews from new accounts
- Business info copied from other listings

---

## 10. Monitoring and Analytics (2 minutes)

Key metrics:
- **Search latency**: P50, P95, P99
- **Search relevance**: Click-through rate, dwell time
- **Review spam rate**: Flagged reviews percentage
- **Cache hit rate**: Redis cache effectiveness

Business analytics:
- Views per business
- Search impressions
- Click-through from search
- Review conversion rate

---

## Summary

The key insights for Yelp's design are:

1. **Elasticsearch for geo + text search**: Combines location-based filtering with full-text relevance

2. **Multi-factor ranking**: Distance, rating, review count, and freshness all contribute to relevance

3. **Bayesian rating**: Prevents gaming by new businesses with few fake reviews

4. **Denormalized aggregates**: Store rating sum and count for efficient updates

5. **Aggressive caching**: Search results and business data cached to handle read-heavy load

6. **Spam detection**: Multiple signals combined to identify fake reviews

The system handles 200 million businesses and searches at scale through careful indexing, caching, and a read-optimized architecture.

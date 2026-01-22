# App Store - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design the App Store, Apple's digital marketplace serving 2M+ apps to billions of users. As a fullstack engineer, the key challenges span:
- End-to-end search flow from UI to Elasticsearch and back
- Review submission pipeline with frontend validation through backend integrity analysis
- Purchase flow with secure checkout and real-time receipt delivery
- Developer dashboard connecting analytics data to visualization
- Real-time ranking updates displayed in charts

## Requirements Clarification

### Functional Requirements
1. **Search & Discovery**: Full-text search with filters, category browsing, rankings
2. **App Details**: View metadata, screenshots, reviews with ratings
3. **Review System**: Submit reviews, view responses, integrity indicators
4. **Purchases**: Secure checkout, receipt validation, subscription management
5. **Developer Portal**: App management, analytics, review responses

### Non-Functional Requirements
1. **Latency**: < 100ms for search, < 200ms for app details
2. **Consistency**: Strong for purchases, eventual for rankings
3. **Availability**: 99.99% for purchase endpoints
4. **Security**: Secure payment flows, receipt validation

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    React Frontend                                │
├─────────────────────────────────────────────────────────────────┤
│  Consumer Views          │         Developer Views              │
│  - Home (Charts)         │         - Dashboard                  │
│  - Search                │         - App Management             │
│  - App Details           │         - Analytics                  │
│  - Checkout              │         - Review Responses           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Express Backend                               │
├─────────────────────────────────────────────────────────────────┤
│  /api/v1/search          │  /api/v1/developer/*                 │
│  /api/v1/apps            │  /api/v1/purchases                   │
│  /api/v1/reviews         │  /api/v1/admin/*                     │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  PostgreSQL   │    │ Elasticsearch │    │    Redis      │
│  - Apps       │    │ - Search      │    │ - Sessions    │
│  - Purchases  │    │ - Suggestions │    │ - Cache       │
│  - Reviews    │    │               │    │ - Idempotency │
└───────────────┘    └───────────────┘    └───────────────┘
```

## Deep Dive: End-to-End Search Flow

### Sequence Diagram

```
User Types "photo editor"
         │
         ▼
┌─────────────────┐
│   SearchBar     │ ← Debounce 150ms
│   Component     │
└────────┬────────┘
         │ GET /api/v1/search?q=photo+editor
         ▼
┌─────────────────┐
│   API Gateway   │ ← Rate limit check
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Search Service  │ ← Build ES query
└────────┬────────┘
         │ multi_match query
         ▼
┌─────────────────┐
│ Elasticsearch   │ ← Fuzzy match, scoring
└────────┬────────┘
         │ hits with _score
         ▼
┌─────────────────┐
│ Rerank Service  │ ← Quality signals
└────────┬────────┘
         │ Final sorted results
         ▼
┌─────────────────┐
│   SearchBar     │ ← Display results
│   Component     │
└─────────────────┘
```

### Frontend: Debounced Search Input

```tsx
/**
 * @fileoverview Search bar with debounced API calls
 * Coordinates with backend search service
 */

import { useState, useCallback } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';

interface SearchSuggestion {
  type: 'app' | 'developer' | 'category';
  id: string;
  text: string;
  icon?: string;
}

export function SearchBar() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce to reduce API calls
  const debouncedSetQuery = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value);
  }, 150);

  // React Query handles caching and deduplication
  const { data: suggestions, isLoading } = useQuery({
    queryKey: ['suggestions', debouncedQuery],
    queryFn: async () => {
      if (debouncedQuery.length < 2) return [];
      const response = await api.get('/search/suggestions', {
        params: { q: debouncedQuery },
      });
      return response.data as SearchSuggestion[];
    },
    enabled: debouncedQuery.length >= 2,
    staleTime: 60000, // Cache for 1 minute
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    debouncedSetQuery(value);
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={handleChange}
        placeholder="Search apps and games"
        className="w-full px-4 py-2 rounded-full border"
      />

      {suggestions && suggestions.length > 0 && (
        <SuggestionList suggestions={suggestions} />
      )}
    </div>
  );
}
```

### Backend: Search with Quality Re-ranking

```typescript
// backend/src/routes/search.ts

import { Router } from 'express';
import { elasticsearch } from '../shared/elasticsearch';
import { redis } from '../shared/cache';

const router = Router();

/**
 * GET /api/v1/search
 * Full-text search with Elasticsearch and quality re-ranking
 */
router.get('/', async (req, res) => {
  const { q, category, price, rating, limit = 20, offset = 0 } = req.query;

  // Check cache first
  const cacheKey = `search:${JSON.stringify({ q, category, price, rating })}`;
  const cached = await redis.get(cacheKey);
  if (cached && offset === 0) {
    return res.json(JSON.parse(cached));
  }

  // Build Elasticsearch query
  const esQuery = {
    bool: {
      must: [{
        multi_match: {
          query: q,
          fields: ['name^3', 'developer^2', 'description', 'keywords'],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      }],
      filter: buildFilters({ category, price, rating }),
    },
  };

  // Execute search
  const esResults = await elasticsearch.search({
    index: 'apps',
    body: {
      query: esQuery,
      size: Number(limit) * 2, // Fetch extra for re-ranking
      from: Number(offset),
    },
  });

  // Re-rank with quality signals
  const rerankedApps = rerank(esResults.hits.hits);
  const apps = rerankedApps.slice(0, Number(limit));

  const response = {
    apps,
    total: esResults.hits.total.value,
    hasMore: offset + apps.length < esResults.hits.total.value,
  };

  // Cache first page for 5 minutes
  if (offset === 0) {
    await redis.setex(cacheKey, 300, JSON.stringify(response));
  }

  res.json(response);
});

function rerank(hits: EsHit[]): App[] {
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

      // 60% text relevance, 40% quality
      const finalScore = textScore * 0.6 + qualityScore * 0.4;

      return { ...app, score: finalScore };
    })
    .sort((a, b) => b.score - a.score);
}

function buildFilters(options: FilterOptions): object[] {
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

export default router;
```

## Deep Dive: Review Submission Pipeline

### Sequence Diagram

```
User Submits Review
         │
         ▼
┌─────────────────┐
│  ReviewForm     │ ← Client validation
│  Component      │   (min length, rating required)
└────────┬────────┘
         │ POST /api/v1/reviews
         ▼
┌─────────────────┐
│  Review API     │ ← Server validation
│                 │   (verified purchase check)
└────────┬────────┘
         │ Insert with status='pending'
         ▼
┌─────────────────┐
│  PostgreSQL     │
└────────┬────────┘
         │ Publish review.created event
         ▼
┌─────────────────┐
│  RabbitMQ       │
└────────┬────────┘
         │ Async processing
         ▼
┌─────────────────┐
│ Integrity       │ ← Multi-signal analysis
│ Worker          │   (velocity, content, coordination)
└────────┬────────┘
         │ UPDATE status based on score
         ▼
┌─────────────────┐
│  PostgreSQL     │ ← status: approved/rejected/manual_review
└─────────────────┘
```

### Frontend: Review Form with Validation

```tsx
/**
 * @fileoverview Review form with client-side validation
 * Submits to backend for integrity analysis
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api } from '../services/api';
import { StarRatingInput } from './StarRatingInput';

const reviewSchema = z.object({
  rating: z.number().min(1).max(5),
  title: z.string().min(5, 'Title must be at least 5 characters').max(100),
  body: z.string().min(20, 'Review must be at least 20 characters').max(2000),
});

type ReviewFormData = z.infer<typeof reviewSchema>;

interface ReviewFormProps {
  appId: string;
  onSuccess: () => void;
}

export function ReviewForm({ appId, onSuccess }: ReviewFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ReviewFormData>({
    resolver: zodResolver(reviewSchema),
  });

  const rating = watch('rating');

  const onSubmit = async (data: ReviewFormData) => {
    setIsSubmitting(true);
    setError(null);

    try {
      await api.post(`/reviews`, {
        appId,
        ...data,
      });

      onSuccess();
    } catch (err: any) {
      if (err.response?.status === 409) {
        setError('You have already reviewed this app');
      } else if (err.response?.status === 403) {
        setError('You must download the app before reviewing');
      } else {
        setError('Failed to submit review. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Rating */}
      <div>
        <label className="block text-sm font-medium mb-2">Rating</label>
        <StarRatingInput
          value={rating}
          onChange={(value) => setValue('rating', value)}
        />
        {errors.rating && (
          <p className="text-red-500 text-sm mt-1">Please select a rating</p>
        )}
      </div>

      {/* Title */}
      <div>
        <label htmlFor="title" className="block text-sm font-medium mb-2">
          Title
        </label>
        <input
          {...register('title')}
          id="title"
          className="w-full px-4 py-2 border rounded-lg"
          placeholder="Summarize your experience"
        />
        {errors.title && (
          <p className="text-red-500 text-sm mt-1">{errors.title.message}</p>
        )}
      </div>

      {/* Body */}
      <div>
        <label htmlFor="body" className="block text-sm font-medium mb-2">
          Review
        </label>
        <textarea
          {...register('body')}
          id="body"
          rows={5}
          className="w-full px-4 py-2 border rounded-lg resize-none"
          placeholder="What did you like or dislike?"
        />
        {errors.body && (
          <p className="text-red-500 text-sm mt-1">{errors.body.message}</p>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full py-3 bg-blue-500 text-white rounded-lg
                   hover:bg-blue-600 disabled:opacity-50"
      >
        {isSubmitting ? 'Submitting...' : 'Submit Review'}
      </button>
    </form>
  );
}
```

### Backend: Review Submission with Async Integrity Check

```typescript
// backend/src/routes/reviews.ts

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../shared/db';
import { publishMessage } from '../shared/queue';
import { requireAuth } from '../shared/auth';

const router = Router();

const reviewSchema = z.object({
  appId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  title: z.string().min(5).max(100),
  body: z.string().min(20).max(2000),
});

/**
 * POST /api/v1/reviews
 * Submit a new review (requires authentication)
 */
router.post('/', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const parsed = reviewSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  const { appId, rating, title, body } = parsed.data;

  // Check if user has downloaded the app
  const hasDownloaded = await db.query(`
    SELECT 1 FROM user_apps WHERE user_id = $1 AND app_id = $2
  `, [userId, appId]);

  if (hasDownloaded.rows.length === 0) {
    return res.status(403).json({
      error: 'You must download the app before reviewing',
    });
  }

  // Check for existing review (one per user per app)
  const existingReview = await db.query(`
    SELECT id FROM reviews WHERE user_id = $1 AND app_id = $2
  `, [userId, appId]);

  if (existingReview.rows.length > 0) {
    return res.status(409).json({
      error: 'You have already reviewed this app',
    });
  }

  // Insert review with pending status
  const review = await db.query(`
    INSERT INTO reviews (user_id, app_id, rating, title, body, status)
    VALUES ($1, $2, $3, $4, $5, 'pending')
    RETURNING id, created_at
  `, [userId, appId, rating, title, body]);

  const reviewId = review.rows[0].id;

  // Publish event for async integrity analysis
  await publishMessage('review.created', {
    eventId: crypto.randomUUID(),
    reviewId,
    userId,
    appId,
    review: { rating, title, body },
  });

  // Update app rating aggregates
  await db.query(`
    UPDATE apps
    SET rating_sum = rating_sum + $1,
        rating_count = rating_count + 1
    WHERE id = $2
  `, [rating, appId]);

  res.status(201).json({
    id: reviewId,
    status: 'pending',
    message: 'Review submitted and pending approval',
  });
});

export default router;
```

### Backend: Integrity Worker

```typescript
// backend/src/workers/reviewWorker.ts

import { consumeQueue } from '../shared/queue';
import { db } from '../shared/db';
import { redis } from '../shared/cache';
import { logger } from '../shared/logger';

interface ReviewEvent {
  eventId: string;
  reviewId: string;
  userId: string;
  appId: string;
  review: {
    rating: number;
    title: string;
    body: string;
  };
}

async function processReview(event: ReviewEvent): Promise<void> {
  const { reviewId, userId, appId, review } = event;

  // Deduplication check
  const processed = await redis.get(`processed:review:${event.eventId}`);
  if (processed) {
    logger.info('Review already processed', { reviewId });
    return;
  }

  // Multi-signal integrity analysis
  const signals = await analyzeIntegrity(userId, appId, review);
  const integrityScore = calculateScore(signals);
  const action = determineAction(integrityScore);

  // Update review status
  await db.query(`
    UPDATE reviews
    SET integrity_score = $1, integrity_signals = $2, status = $3
    WHERE id = $4
  `, [integrityScore, JSON.stringify(signals), action, reviewId]);

  // Mark as processed
  await redis.setex(`processed:review:${event.eventId}`, 86400, '1');

  logger.info('Review integrity analyzed', {
    reviewId,
    integrityScore,
    action,
  });
}

async function analyzeIntegrity(
  userId: string,
  appId: string,
  review: { body: string }
): Promise<IntegritySignal[]> {
  const signals: IntegritySignal[] = [];

  // 1. Review velocity
  const recentReviews = await db.query(`
    SELECT COUNT(*) as count FROM reviews
    WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
  `, [userId]);

  const reviewCount = recentReviews.rows[0].count;
  signals.push({
    name: 'review_velocity',
    score: reviewCount > 5 ? 0.2 : reviewCount > 2 ? 0.6 : 1.0,
    weight: 0.15,
  });

  // 2. Content quality
  const genericPhrases = ['great app', 'love it', 'best app ever', '5 stars'];
  const hasGeneric = genericPhrases.some(p =>
    review.body.toLowerCase().includes(p)
  );
  const lengthScore = Math.min(review.body.length / 100, 1);
  const hasSpecifics = /\b(feature|update|version|bug|crash)\b/i.test(review.body);

  signals.push({
    name: 'content_quality',
    score: (hasGeneric ? 0.5 : 1.0) * 0.3 + lengthScore * 0.3 + (hasSpecifics ? 1.0 : 0.5) * 0.4,
    weight: 0.25,
  });

  // 3. Account age
  const user = await db.query(`
    SELECT EXTRACT(DAY FROM NOW() - created_at) as age_days
    FROM users WHERE id = $1
  `, [userId]);
  const ageDays = user.rows[0]?.age_days || 0;

  signals.push({
    name: 'account_age',
    score: Math.min(ageDays / 30, 1),
    weight: 0.10,
  });

  // 4. Coordination detection
  const appReviews = await db.query(`
    SELECT COUNT(*) as count FROM reviews
    WHERE app_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
  `, [appId]);

  const avgDaily = await db.query(`
    SELECT AVG(daily_count) as avg FROM (
      SELECT DATE(created_at), COUNT(*) as daily_count
      FROM reviews WHERE app_id = $1 AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
    ) t
  `, [appId]);

  const recentCount = appReviews.rows[0].count;
  const avgDailyCount = avgDaily.rows[0]?.avg || 10;

  signals.push({
    name: 'coordination',
    score: recentCount > avgDailyCount * 5 ? 0.3 : 1.0,
    weight: 0.20,
  });

  return signals;
}

function calculateScore(signals: IntegritySignal[]): number {
  return signals.reduce((sum, s) => sum + s.score * s.weight, 0);
}

function determineAction(score: number): string {
  if (score < 0.3) return 'rejected';
  if (score < 0.6) return 'manual_review';
  return 'approved';
}

// Start consumer
consumeQueue('review.created', async (msg) => {
  const event = JSON.parse(msg.content.toString()) as ReviewEvent;
  await processReview(event);
});
```

## Deep Dive: Purchase Flow

### Sequence Diagram

```
User Clicks "Buy"
         │
         ▼
┌─────────────────┐
│  Checkout Modal │ ← Confirm payment method
└────────┬────────┘
         │ POST /api/v1/purchases (idempotency-key)
         ▼
┌─────────────────┐
│  Purchase API   │ ← Check idempotency key
└────────┬────────┘
         │ Lock acquisition
         ▼
┌─────────────────┐
│  Payment        │ ← Process payment
│  Provider       │
└────────┬────────┘
         │ Transaction
         ▼
┌─────────────────┐
│  PostgreSQL     │ ← Insert purchase, grant access
└────────┬────────┘
         │ Generate receipt
         ▼
┌─────────────────┐
│  Checkout Modal │ ← Show success, download button
└─────────────────┘
```

### Frontend: Checkout Modal

```tsx
/**
 * @fileoverview Checkout modal with idempotent purchase
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../services/api';
import { v4 as uuidv4 } from 'uuid';

interface CheckoutModalProps {
  app: App;
  priceId: string;
  onSuccess: (receipt: Receipt) => void;
  onClose: () => void;
}

export function CheckoutModal({
  app,
  priceId,
  onSuccess,
  onClose,
}: CheckoutModalProps) {
  // Generate idempotency key once per checkout attempt
  const [idempotencyKey] = useState(() => uuidv4());

  const purchaseMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post(
        '/purchases',
        { appId: app.id, priceId },
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
          },
        }
      );
      return response.data;
    },
    onSuccess: (data) => {
      onSuccess(data.receipt);
    },
    retry: 3, // Safe to retry with idempotency key
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full mx-4">
        <div className="flex items-center gap-4 mb-6">
          <img
            src={app.iconUrl}
            alt=""
            className="w-16 h-16 rounded-xl"
          />
          <div>
            <h2 className="font-semibold text-lg">{app.name}</h2>
            <p className="text-gray-500">{app.developer}</p>
          </div>
        </div>

        <div className="border-t border-b py-4 my-4">
          <div className="flex justify-between">
            <span>Price</span>
            <span className="font-semibold">{formatPrice(app.price)}</span>
          </div>
        </div>

        {purchaseMutation.error && (
          <div className="p-4 bg-red-50 text-red-700 rounded-lg mb-4">
            {purchaseMutation.error instanceof Error
              ? purchaseMutation.error.message
              : 'Purchase failed. Please try again.'}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 border rounded-xl hover:bg-gray-50"
            disabled={purchaseMutation.isPending}
          >
            Cancel
          </button>
          <button
            onClick={() => purchaseMutation.mutate()}
            disabled={purchaseMutation.isPending}
            className="flex-1 py-3 bg-blue-500 text-white rounded-xl
                       hover:bg-blue-600 disabled:opacity-50"
          >
            {purchaseMutation.isPending ? 'Processing...' : 'Confirm Purchase'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Backend: Idempotent Purchase API

```typescript
// backend/src/routes/purchases.ts

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../shared/db';
import { redis } from '../shared/cache';
import { publishMessage } from '../shared/queue';
import { requireAuth } from '../shared/auth';
import { paymentService } from '../services/payment';

const router = Router();

const purchaseSchema = z.object({
  appId: z.string().uuid(),
  priceId: z.string().uuid(),
});

/**
 * POST /api/v1/purchases
 * Idempotent purchase with receipt generation
 */
router.post('/', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header required' });
  }

  // Layer 1: Check for cached result
  const cacheKey = `idem:purchase:${userId}:${idempotencyKey}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  // Layer 2: Acquire lock
  const lockKey = `lock:purchase:${userId}:${idempotencyKey}`;
  const locked = await redis.set(lockKey, '1', 'NX', 'EX', 30);
  if (!locked) {
    return res.status(409).json({ error: 'Purchase in progress' });
  }

  try {
    const parsed = purchaseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }

    const { appId, priceId } = parsed.data;

    // Get app and price
    const app = await db.query(`
      SELECT a.*, p.amount, p.currency
      FROM apps a
      JOIN app_prices p ON p.id = $1 AND p.app_id = a.id
      WHERE a.id = $2
    `, [priceId, appId]);

    if (app.rows.length === 0) {
      return res.status(404).json({ error: 'App or price not found' });
    }

    // Check if already purchased
    const existing = await db.query(`
      SELECT id FROM purchases
      WHERE user_id = $1 AND app_id = $2
    `, [userId, appId]);

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Already purchased' });
    }

    // Process payment
    const payment = await paymentService.charge({
      userId,
      amount: app.rows[0].amount,
      currency: app.rows[0].currency,
    });

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

    // Generate receipt
    const receipt = {
      id: purchase.id,
      appId,
      amount: payment.amount,
      currency: payment.currency,
      purchasedAt: purchase.purchased_at,
    };

    const result = { purchase, receipt };

    // Cache result
    await redis.setex(cacheKey, 86400, JSON.stringify(result));

    // Publish for async processing
    await publishMessage('purchase.completed', {
      purchaseId: purchase.id,
      userId,
      appId,
      developerId: app.rows[0].developer_id,
      amount: payment.amount,
    });

    res.status(201).json(result);
  } finally {
    await redis.del(lockKey);
  }
});

export default router;
```

## Deep Dive: Developer Analytics Dashboard

### Frontend: Analytics Component

```tsx
/**
 * @fileoverview Developer analytics dashboard
 * Fetches and visualizes app performance metrics
 */

import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../services/api';

interface AnalyticsData {
  downloads: { date: string; count: number }[];
  revenue: { date: string; amount: number }[];
  summary: {
    totalDownloads: number;
    totalRevenue: number;
    averageRating: number;
  };
}

export function AppAnalytics({ appId }: { appId: string }) {
  const { data, isLoading, error } = useQuery<AnalyticsData>({
    queryKey: ['analytics', appId],
    queryFn: async () => {
      const response = await api.get(`/developer/apps/${appId}/analytics`);
      return response.data;
    },
    staleTime: 60000, // Cache for 1 minute
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message="Failed to load analytics" />;
  if (!data) return null;

  return (
    <div className="space-y-8">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <MetricCard
          label="Total Downloads"
          value={data.summary.totalDownloads.toLocaleString()}
          icon={<DownloadIcon />}
        />
        <MetricCard
          label="Total Revenue"
          value={`$${data.summary.totalRevenue.toLocaleString()}`}
          icon={<DollarIcon />}
        />
        <MetricCard
          label="Average Rating"
          value={data.summary.averageRating.toFixed(1)}
          icon={<StarIcon />}
        />
      </div>

      {/* Downloads chart */}
      <div className="bg-white rounded-xl border p-6">
        <h3 className="text-lg font-semibold mb-4">Downloads Over Time</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.downloads}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={d => new Date(d).toLocaleDateString()}
              />
              <YAxis />
              <Tooltip
                formatter={(value: number) => [value.toLocaleString(), 'Downloads']}
                labelFormatter={d => new Date(d).toLocaleDateString()}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
```

### Backend: Analytics API

```typescript
// backend/src/routes/developer/analytics.ts

import { Router } from 'express';
import { db } from '../../shared/db';
import { redis } from '../../shared/cache';
import { requireDeveloper } from '../../shared/auth';

const router = Router();

/**
 * GET /api/v1/developer/apps/:id/analytics
 * Get analytics for a developer's app
 */
router.get('/:id/analytics', requireDeveloper, async (req, res) => {
  const { id } = req.params;
  const developerId = req.session.developerId;

  // Verify ownership
  const app = await db.query(`
    SELECT id FROM apps WHERE id = $1 AND developer_id = $2
  `, [id, developerId]);

  if (app.rows.length === 0) {
    return res.status(404).json({ error: 'App not found' });
  }

  // Check cache
  const cacheKey = `analytics:${id}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  // Get download trend (last 30 days)
  const downloads = await db.query(`
    SELECT
      DATE(purchased_at) as date,
      COUNT(*) as count
    FROM user_apps
    WHERE app_id = $1 AND purchased_at > NOW() - INTERVAL '30 days'
    GROUP BY DATE(purchased_at)
    ORDER BY date
  `, [id]);

  // Get revenue trend (last 30 days)
  const revenue = await db.query(`
    SELECT
      DATE(purchased_at) as date,
      SUM(amount) as amount
    FROM purchases
    WHERE app_id = $1 AND purchased_at > NOW() - INTERVAL '30 days'
    GROUP BY DATE(purchased_at)
    ORDER BY date
  `, [id]);

  // Get summary
  const summary = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM user_apps WHERE app_id = $1) as total_downloads,
      (SELECT COALESCE(SUM(amount), 0) FROM purchases WHERE app_id = $1) as total_revenue,
      (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE app_id = $1 AND status = 'approved') as average_rating
  `, [id]);

  const result = {
    downloads: downloads.rows.map(r => ({
      date: r.date.toISOString(),
      count: Number(r.count),
    })),
    revenue: revenue.rows.map(r => ({
      date: r.date.toISOString(),
      amount: Number(r.amount),
    })),
    summary: {
      totalDownloads: Number(summary.rows[0].total_downloads),
      totalRevenue: Number(summary.rows[0].total_revenue),
      averageRating: Number(summary.rows[0].average_rating),
    },
  };

  // Cache for 5 minutes
  await redis.setex(cacheKey, 300, JSON.stringify(result));

  res.json(result);
});

export default router;
```

## Deep Dive: Developer Review Response

### Frontend: Response Form

```tsx
/**
 * @fileoverview Developer response form for reviews
 * Integrated into the reviews tab of app management
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

interface ResponseFormProps {
  reviewId: string;
  existingResponse?: string;
  appId: string;
}

export function ResponseForm({
  reviewId,
  existingResponse,
  appId,
}: ResponseFormProps) {
  const [response, setResponse] = useState(existingResponse || '');
  const [isExpanded, setIsExpanded] = useState(!!existingResponse);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (text: string) => {
      await api.post(`/developer/reviews/${reviewId}/respond`, { response: text });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['app-reviews', appId] });
      setIsExpanded(false);
    },
  });

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="text-blue-600 text-sm hover:underline"
      >
        {existingResponse ? 'Edit Response' : 'Respond to Review'}
      </button>
    );
  }

  return (
    <div className="mt-4 p-4 bg-gray-50 rounded-lg">
      <textarea
        value={response}
        onChange={e => setResponse(e.target.value)}
        placeholder="Write your response..."
        rows={4}
        className="w-full px-3 py-2 border rounded-lg resize-none"
      />

      <div className="flex justify-end gap-2 mt-3">
        <button
          onClick={() => setIsExpanded(false)}
          className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
          disabled={mutation.isPending}
        >
          Cancel
        </button>
        <button
          onClick={() => mutation.mutate(response)}
          disabled={!response.trim() || mutation.isPending}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg
                     hover:bg-blue-600 disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving...' : 'Post Response'}
        </button>
      </div>
    </div>
  );
}
```

### Backend: Response API

```typescript
// backend/src/routes/developer/reviews.ts

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db';
import { requireDeveloper } from '../../shared/auth';

const router = Router();

const responseSchema = z.object({
  response: z.string().min(10).max(1000),
});

/**
 * POST /api/v1/developer/reviews/:id/respond
 * Add or update developer response to a review
 */
router.post('/:id/respond', requireDeveloper, async (req, res) => {
  const { id } = req.params;
  const developerId = req.session.developerId;

  const parsed = responseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  // Verify review is for developer's app
  const review = await db.query(`
    SELECT r.id, r.app_id
    FROM reviews r
    JOIN apps a ON a.id = r.app_id
    WHERE r.id = $1 AND a.developer_id = $2
  `, [id, developerId]);

  if (review.rows.length === 0) {
    return res.status(404).json({ error: 'Review not found' });
  }

  // Update response
  await db.query(`
    UPDATE reviews
    SET developer_response = $1, developer_response_at = NOW()
    WHERE id = $2
  `, [parsed.data.response, id]);

  res.json({ success: true });
});

export default router;
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Search debouncing | 150ms client-side | Server throttle | Better UX, reduces latency |
| Review processing | Async with queue | Sync in request | Non-blocking, scales integrity analysis |
| Purchase idempotency | Redis + header key | DB constraint only | Handles concurrent retries |
| Analytics caching | 5 min Redis TTL | Real-time queries | Balance freshness with DB load |
| Review validation | Zod on both ends | Backend only | Fast feedback, security defense |
| Chart rendering | Recharts | Custom Canvas | Development speed, accessibility |

## Future Fullstack Enhancements

1. **Real-time Updates**: WebSocket for live ranking changes
2. **Optimistic UI**: Show review immediately, reconcile after processing
3. **GraphQL**: Efficient data fetching for mobile clients
4. **Server Components**: Next.js RSC for faster initial load
5. **Edge Caching**: CDN-cached API responses for popular apps
6. **A/B Testing**: Feature flags for search algorithm experiments

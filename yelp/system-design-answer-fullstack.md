# Yelp - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement

"I'll be designing a local business review and discovery platform like Yelp. As a full-stack engineer, I'll focus on how the frontend and backend integrate for geo-spatial search, the end-to-end review submission flow with optimistic updates, and the search experience from autocomplete to results rendering. Let me start by clarifying what we need to build."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Search Experience (End-to-End)**
   - Autocomplete suggestions from backend
   - Geo-spatial search with filters
   - Paginated results with faceted navigation
   - URL state synchronization

2. **Business Detail Pages**
   - Business info fetched from API
   - Reviews with infinite scroll
   - Rating display and aggregation

3. **Review System**
   - Star rating and text submission
   - Photo upload to object storage
   - Optimistic UI updates with rollback
   - Idempotent submission handling

4. **User Flows**
   - Session-based authentication
   - Role-based access (user, business_owner, admin)
   - Business owner management dashboard

### Non-Functional Requirements

- **Latency**: API p95 < 300ms, FCP < 2s
- **Consistency**: Strong for reviews, eventual for search index
- **Reliability**: Idempotent mutations, retry-safe
- **Type Safety**: Shared types between frontend and backend

---

## 2. Full-Stack Architecture Overview (5-6 minutes)

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ SearchBar   │  │ FilterPanel │  │ MapView     │  │ ReviewForm  │         │
│  │ (debounce)  │  │ (URL sync)  │  │ (Mapbox)    │  │ (optimistic)│         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                │                 │
│         └────────────────┴────────────────┴────────────────┘                 │
│                                   │                                          │
│                          ┌────────▼────────┐                                 │
│                          │   API Service   │  (Axios + types)                │
│                          └────────┬────────┘                                 │
└───────────────────────────────────┼─────────────────────────────────────────┘
                                    │ HTTP/REST
┌───────────────────────────────────┼─────────────────────────────────────────┐
│                              BACKEND                                         │
│                          ┌────────▼────────┐                                 │
│                          │   API Routes    │  (Express + Zod validation)     │
│                          └────────┬────────┘                                 │
│                                   │                                          │
│         ┌─────────────────────────┼─────────────────────────┐               │
│         │                         │                         │               │
│  ┌──────▼──────┐          ┌───────▼───────┐         ┌───────▼───────┐       │
│  │   Search    │          │   Business    │         │    Review     │       │
│  │   Service   │          │    Service    │         │   Service     │       │
│  └──────┬──────┘          └───────┬───────┘         └───────┬───────┘       │
│         │                         │                         │               │
│         ▼                         ▼                         ▼               │
│  ┌─────────────┐          ┌─────────────┐           ┌─────────────┐         │
│  │Elasticsearch│          │ PostgreSQL  │           │  RabbitMQ   │         │
│  └─────────────┘          │  + PostGIS  │           └──────┬──────┘         │
│                           └─────────────┘                  │                │
│                                   │                        ▼                │
│                           ┌───────▼───────┐         ┌─────────────┐         │
│                           │    Redis      │         │Index Worker │         │
│                           │   (Cache)     │         └─────────────┘         │
│                           └───────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Frontend | Backend |
|-------|----------|---------|
| Language | TypeScript | TypeScript |
| Framework | React 19 + TanStack Router | Express.js |
| Styling | Tailwind CSS | - |
| State | Zustand | - |
| Validation | Zod | Zod |
| HTTP | Axios | - |
| Database | - | PostgreSQL + PostGIS |
| Search | - | Elasticsearch |
| Cache | - | Redis |
| Queue | - | RabbitMQ |

---

## 3. Deep Dive: Shared Type System (4-5 minutes)

### Shared Types Package

```typescript
// shared/types/index.ts
// Used by both frontend and backend

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface Business {
  id: string;
  name: string;
  description: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string | null;
  website: string | null;
  location: Coordinates;
  categories: string[];
  hours: BusinessHours;
  amenities: string[];
  averageRating: number;
  reviewCount: number;
  priceLevel: number | null;
  photoUrls: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessHours {
  [day: string]: { open: string; close: string } | null;
}

export interface Review {
  id: string;
  userId: string;
  businessId: string;
  rating: number;
  title: string;
  content: string;
  photoUrls: string[];
  helpfulCount: number;
  isVerified: boolean;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  };
}

// API Request/Response types
export interface SearchRequest {
  q?: string;
  lat: number;
  lng: number;
  radius?: number; // km
  category?: string;
  minRating?: number;
  priceLevel?: number;
  openNow?: boolean;
  sort?: 'relevance' | 'rating' | 'distance' | 'reviews';
  page?: number;
  limit?: number;
}

export interface SearchResponse {
  businesses: BusinessSummary[];
  facets: {
    categories: { key: string; count: number }[];
    priceLevels: { key: number; count: number }[];
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  meta: {
    tookMs: number;
    cacheHit: boolean;
  };
}

export interface BusinessSummary {
  id: string;
  name: string;
  address: string;
  city: string;
  location: Coordinates;
  distanceKm: number;
  categories: string[];
  averageRating: number;
  reviewCount: number;
  priceLevel: number | null;
  photoUrl: string | null;
}

export interface CreateReviewRequest {
  rating: number;
  title: string;
  content: string;
  photoUrls?: string[];
}

export interface CreateReviewResponse {
  review: Review;
  updatedBusiness: {
    averageRating: number;
    reviewCount: number;
  };
}
```

### Zod Validation Schemas (Shared)

```typescript
// shared/validation/index.ts
import { z } from 'zod';

export const coordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180)
});

export const searchRequestSchema = z.object({
  q: z.string().max(100).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius: z.number().min(0.1).max(50).default(10),
  category: z.string().max(50).optional(),
  minRating: z.number().min(1).max(5).optional(),
  priceLevel: z.number().min(1).max(4).optional(),
  openNow: z.boolean().optional(),
  sort: z.enum(['relevance', 'rating', 'distance', 'reviews']).default('relevance'),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(50).default(20)
});

export const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().min(3).max(200),
  content: z.string().min(50).max(5000),
  photoUrls: z.array(z.string().url()).max(5).optional()
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type CreateReviewRequest = z.infer<typeof createReviewSchema>;
```

---

## 4. Deep Dive: Search Flow End-to-End (8-10 minutes)

### Frontend: Search Bar with Autocomplete

```tsx
// frontend/src/components/search/SearchBar.tsx
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useDebounce } from '../../hooks/useDebounce';
import api from '../../services/api';
import type { AutocompleteResponse } from 'shared/types';

export function SearchBar() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<AutocompleteResponse['suggestions']>([]);
  const [isLoading, setIsLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 200);
  const navigate = useNavigate();

  // Fetch autocomplete suggestions
  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);

    api.get<AutocompleteResponse>('/search/autocomplete', {
      params: { q: debouncedQuery },
      signal: controller.signal
    })
      .then((res) => setSuggestions(res.data.suggestions))
      .catch((err) => {
        if (err.name !== 'CanceledError') {
          console.error('Autocomplete error:', err);
        }
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, [debouncedQuery]);

  const handleSearch = useCallback((searchQuery: string) => {
    navigate({
      to: '/search',
      search: { q: searchQuery }
    });
  }, [navigate]);

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSearch(query)}
        placeholder="Restaurants, bars, coffee..."
        className="w-full px-4 py-3 border rounded-lg"
        aria-autocomplete="list"
      />

      {suggestions.length > 0 && (
        <ul className="absolute top-full left-0 right-0 bg-white border rounded-lg shadow-lg z-50">
          {suggestions.map((suggestion) => (
            <li
              key={`${suggestion.type}-${suggestion.id}`}
              onClick={() => handleSearch(suggestion.name)}
              className="px-4 py-2 hover:bg-gray-50 cursor-pointer"
            >
              <span className="font-medium">{suggestion.name}</span>
              {suggestion.category && (
                <span className="text-gray-500 ml-2">{suggestion.category}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Backend: Autocomplete Endpoint

```typescript
// backend/src/routes/search.ts
import { Router } from 'express';
import { z } from 'zod';
import { esClient } from '../shared/elasticsearch';
import { redis } from '../shared/cache';

const router = Router();

const autocompleteSchema = z.object({
  q: z.string().min(2).max(50)
});

router.get('/autocomplete', async (req, res) => {
  const parsed = autocompleteSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  const { q } = parsed.data;

  // Check cache first
  const cacheKey = `autocomplete:${q.toLowerCase()}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json({ suggestions: JSON.parse(cached), cacheHit: true });
  }

  // Query Elasticsearch with edge-ngram analyzer
  const result = await esClient.search({
    index: 'businesses',
    body: {
      size: 10,
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query: q,
                fields: ['name.autocomplete^3', 'categories^2', 'description'],
                type: 'bool_prefix'
              }
            }
          ],
          filter: [{ term: { is_active: true } }]
        }
      },
      _source: ['id', 'name', 'categories', 'average_rating']
    }
  });

  const suggestions = result.hits.hits.map((hit: any) => ({
    type: 'business',
    id: hit._source.id,
    name: hit._source.name,
    category: hit._source.categories?.[0] || null,
    rating: hit._source.average_rating
  }));

  // Cache for 5 minutes
  await redis.setex(cacheKey, 300, JSON.stringify(suggestions));

  res.json({ suggestions, cacheHit: false });
});

export default router;
```

### Backend: Search Endpoint with Geo-Distance

```typescript
// backend/src/routes/search.ts
import { searchRequestSchema } from 'shared/validation';

router.get('/', async (req, res) => {
  const parsed = searchRequestSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  const { q, lat, lng, radius, category, minRating, priceLevel, openNow, sort, page, limit } = parsed.data;
  const startTime = Date.now();

  // Build cache key from normalized query
  const cacheKey = `search:${JSON.stringify({ q, lat: lat.toFixed(3), lng: lng.toFixed(3), radius, category, minRating, priceLevel, sort, page, limit })}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json({ ...JSON.parse(cached), meta: { tookMs: Date.now() - startTime, cacheHit: true } });
  }

  // Build Elasticsearch query
  const esQuery: any = {
    bool: {
      must: [],
      filter: [
        {
          geo_distance: {
            distance: `${radius}km`,
            location: { lat, lon: lng }
          }
        },
        { term: { is_active: true } }
      ]
    }
  };

  // Add text query if provided
  if (q) {
    esQuery.bool.must.push({
      multi_match: {
        query: q,
        fields: ['name^3', 'categories^2', 'description'],
        fuzziness: 'AUTO'
      }
    });
  } else {
    esQuery.bool.must.push({ match_all: {} });
  }

  // Add filters
  if (category) {
    esQuery.bool.filter.push({ term: { categories: category } });
  }
  if (minRating) {
    esQuery.bool.filter.push({ range: { average_rating: { gte: minRating } } });
  }
  if (priceLevel) {
    esQuery.bool.filter.push({ term: { price_level: priceLevel } });
  }

  // Build sort
  const sortClauses: any[] = [];
  switch (sort) {
    case 'distance':
      sortClauses.push({ _geo_distance: { location: { lat, lon: lng }, order: 'asc', unit: 'km' } });
      break;
    case 'rating':
      sortClauses.push({ average_rating: 'desc' });
      break;
    case 'reviews':
      sortClauses.push({ review_count: 'desc' });
      break;
    default:
      sortClauses.push({ _score: 'desc' });
      sortClauses.push({ _geo_distance: { location: { lat, lon: lng }, order: 'asc', unit: 'km' } });
  }

  // Execute search
  const result = await esClient.search({
    index: 'businesses',
    body: {
      query: esQuery,
      sort: sortClauses,
      from: (page - 1) * limit,
      size: limit,
      aggs: {
        categories: { terms: { field: 'categories', size: 20 } },
        price_levels: { terms: { field: 'price_level', size: 4 } }
      }
    }
  });

  // Transform results
  const businesses = result.hits.hits.map((hit: any) => ({
    ...hit._source,
    distanceKm: hit.sort?.[sort === 'distance' ? 0 : 1] || null
  }));

  const response = {
    businesses,
    facets: {
      categories: result.aggregations?.categories?.buckets || [],
      priceLevels: result.aggregations?.price_levels?.buckets || []
    },
    pagination: {
      page,
      limit,
      total: result.hits.total.value,
      totalPages: Math.ceil(result.hits.total.value / limit)
    }
  };

  // Cache results for 2 minutes
  await redis.setex(cacheKey, 120, JSON.stringify(response));

  res.json({
    ...response,
    meta: { tookMs: Date.now() - startTime, cacheHit: false }
  });
});
```

### Frontend: Search Results Page

```tsx
// frontend/src/routes/search.tsx
import { useState, useEffect } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { SearchBar } from '../components/search/SearchBar';
import { FilterPanel } from '../components/search/FilterPanel';
import { BusinessCard } from '../components/BusinessCard';
import { MapView } from '../components/search/MapView';
import api from '../services/api';
import type { SearchResponse } from 'shared/types';

export function SearchPage() {
  const search = useSearch({ from: '/search' });
  const navigate = useNavigate();
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');

  // Fetch search results when URL params change
  useEffect(() => {
    const fetchResults = async () => {
      setIsLoading(true);

      // Get user location if not provided
      let { lat, lng } = search;
      if (!lat || !lng) {
        const pos = await getCurrentPosition();
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
      }

      try {
        const response = await api.get<SearchResponse>('/search', {
          params: { ...search, lat, lng }
        });
        setResults(response.data);
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchResults();
  }, [search]);

  const handleFilterChange = (key: string, value: any) => {
    navigate({
      to: '/search',
      search: (prev) => ({ ...prev, [key]: value, page: 1 }),
      replace: true
    });
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <SearchBar initialQuery={search.q} />

      <div className="flex gap-8 mt-8">
        {/* Filters sidebar */}
        <aside className="w-64 flex-shrink-0">
          <FilterPanel
            filters={search}
            facets={results?.facets}
            onChange={handleFilterChange}
          />
        </aside>

        {/* Results */}
        <main className="flex-1">
          {/* View toggle and sort */}
          <div className="flex justify-between items-center mb-4">
            <p className="text-gray-600">
              {results?.pagination.total || 0} results
              {results?.meta.cacheHit && (
                <span className="text-xs ml-2">(cached)</span>
              )}
            </p>

            <div className="flex gap-4">
              <select
                value={search.sort || 'relevance'}
                onChange={(e) => handleFilterChange('sort', e.target.value)}
                className="border rounded px-3 py-1"
              >
                <option value="relevance">Relevance</option>
                <option value="rating">Highest Rated</option>
                <option value="distance">Nearest</option>
                <option value="reviews">Most Reviews</option>
              </select>

              <div className="flex border rounded">
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-3 py-1 ${viewMode === 'list' ? 'bg-gray-100' : ''}`}
                >
                  List
                </button>
                <button
                  onClick={() => setViewMode('map')}
                  className={`px-3 py-1 ${viewMode === 'map' ? 'bg-gray-100' : ''}`}
                >
                  Map
                </button>
              </div>
            </div>
          </div>

          {/* Results display */}
          {isLoading ? (
            <LoadingSkeleton />
          ) : viewMode === 'list' ? (
            <div className="space-y-4">
              {results?.businesses.map((business) => (
                <BusinessCard key={business.id} business={business} />
              ))}
            </div>
          ) : (
            <MapView
              businesses={results?.businesses || []}
              center={{ lat: search.lat, lng: search.lng }}
            />
          )}

          {/* Pagination */}
          {results && results.pagination.totalPages > 1 && (
            <Pagination
              current={results.pagination.page}
              total={results.pagination.totalPages}
              onChange={(page) => handleFilterChange('page', page)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
```

---

## 5. Deep Dive: Review Submission Flow (8-10 minutes)

### Frontend: Review Form with Optimistic Updates

```tsx
// frontend/src/components/business/ReviewForm.tsx
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { v4 as uuidv4 } from 'uuid';
import { createReviewSchema, type CreateReviewRequest } from 'shared/validation';
import api from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

interface ReviewFormProps {
  businessId: string;
  onReviewCreated: (review: Review, updatedRating: number) => void;
  onOptimisticAdd: (tempReview: Review) => void;
  onOptimisticRemove: (tempId: string) => void;
}

export function ReviewForm({
  businessId,
  onReviewCreated,
  onOptimisticAdd,
  onOptimisticRemove
}: ReviewFormProps) {
  const { user } = useAuthStore();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { register, handleSubmit, setValue, watch, reset, formState: { errors } } = useForm<CreateReviewRequest>({
    resolver: zodResolver(createReviewSchema),
    defaultValues: { rating: 0, title: '', content: '' }
  });

  const currentRating = watch('rating');

  const onSubmit = async (data: CreateReviewRequest) => {
    if (!user) return;

    setIsSubmitting(true);
    const idempotencyKey = uuidv4();
    const tempId = `temp-${idempotencyKey}`;

    // Create optimistic review
    const optimisticReview: Review = {
      id: tempId,
      userId: user.id,
      businessId,
      rating: data.rating,
      title: data.title,
      content: data.content,
      photoUrls: [],
      helpfulCount: 0,
      isVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      user: {
        id: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl
      }
    };

    // Add optimistic review immediately
    onOptimisticAdd(optimisticReview);

    try {
      const response = await api.post<CreateReviewResponse>(
        `/businesses/${businessId}/reviews`,
        data,
        { headers: { 'Idempotency-Key': idempotencyKey } }
      );

      // Remove temp review and add real one
      onOptimisticRemove(tempId);
      onReviewCreated(response.data.review, response.data.updatedBusiness.averageRating);
      reset();
    } catch (error: any) {
      // Remove optimistic review on failure
      onOptimisticRemove(tempId);

      if (error.response?.status === 409) {
        alert('You have already reviewed this business');
      } else if (error.response?.status === 429) {
        alert('Too many reviews. Please try again later.');
      } else {
        alert('Failed to submit review. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 bg-white p-6 rounded-lg shadow">
      <h3 className="text-xl font-semibold">Write a Review</h3>

      {/* Star rating */}
      <div>
        <label className="block font-medium mb-2">Your Rating</label>
        <StarRating
          rating={currentRating}
          interactive
          size="lg"
          onChange={(rating) => setValue('rating', rating)}
        />
        {errors.rating && (
          <p className="text-red-500 text-sm mt-1">{errors.rating.message}</p>
        )}
      </div>

      {/* Title */}
      <div>
        <label htmlFor="title" className="block font-medium mb-2">Title</label>
        <input
          id="title"
          type="text"
          {...register('title')}
          placeholder="Summarize your experience"
          className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-yelp-red"
        />
        {errors.title && (
          <p className="text-red-500 text-sm mt-1">{errors.title.message}</p>
        )}
      </div>

      {/* Content */}
      <div>
        <label htmlFor="content" className="block font-medium mb-2">Your Review</label>
        <textarea
          id="content"
          {...register('content')}
          rows={5}
          placeholder="Tell others about your experience..."
          className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-yelp-red resize-y"
        />
        {errors.content && (
          <p className="text-red-500 text-sm mt-1">{errors.content.message}</p>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full py-3 bg-yelp-red text-white font-semibold rounded-lg
                   hover:bg-red-700 disabled:bg-gray-400 transition-colors"
      >
        {isSubmitting ? 'Submitting...' : 'Post Review'}
      </button>
    </form>
  );
}
```

### Backend: Review Creation with Idempotency

```typescript
// backend/src/routes/reviews.ts
import { Router } from 'express';
import { createReviewSchema } from 'shared/validation';
import { pool } from '../shared/db';
import { redis } from '../shared/cache';
import { rabbitMQ } from '../shared/queue';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/:businessId/reviews', requireAuth, async (req, res) => {
  const { businessId } = req.params;
  const userId = req.session.userId;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  // Check idempotency key
  if (idempotencyKey) {
    const cached = await redis.get(`idempotency:${idempotencyKey}`);
    if (cached) {
      return res.status(JSON.parse(cached).status).json(JSON.parse(cached).body);
    }
  }

  // Validate request body
  const parsed = createReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  const { rating, title, content, photoUrls } = parsed.data;

  try {
    // Start transaction
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check for existing review (unique constraint will also catch this)
      const existing = await client.query(
        'SELECT id FROM reviews WHERE user_id = $1 AND business_id = $2',
        [userId, businessId]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        const response = { error: 'You have already reviewed this business' };
        if (idempotencyKey) {
          await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify({ status: 409, body: response }));
        }
        return res.status(409).json(response);
      }

      // Insert review (trigger will update business rating)
      const reviewResult = await client.query(
        `INSERT INTO reviews (user_id, business_id, rating, title, content, photo_urls)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userId, businessId, rating, title, content, photoUrls || []]
      );

      const review = reviewResult.rows[0];

      // Get updated business rating
      const businessResult = await client.query(
        `SELECT rating_sum::float / NULLIF(review_count, 0) as average_rating, review_count
         FROM businesses WHERE id = $1`,
        [businessId]
      );

      const updatedBusiness = businessResult.rows[0];

      await client.query('COMMIT');

      // Publish event for async indexing
      await rabbitMQ.publish('index.update', {
        type: 'business',
        action: 'update',
        businessId,
        timestamp: new Date().toISOString()
      });

      // Invalidate caches
      await redis.del(`business:${businessId}`);
      const searchKeys = await redis.keys('search:*');
      if (searchKeys.length > 0) {
        await redis.del(...searchKeys);
      }

      // Get user info for response
      const userResult = await pool.query(
        'SELECT id, display_name, avatar_url FROM users WHERE id = $1',
        [userId]
      );

      const responseBody = {
        review: {
          ...review,
          user: {
            id: userResult.rows[0].id,
            displayName: userResult.rows[0].display_name,
            avatarUrl: userResult.rows[0].avatar_url
          }
        },
        updatedBusiness: {
          averageRating: updatedBusiness.average_rating,
          reviewCount: updatedBusiness.review_count
        }
      };

      // Cache idempotency response
      if (idempotencyKey) {
        await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify({ status: 201, body: responseBody }));
      }

      res.status(201).json(responseBody);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    // Handle unique constraint violation
    if (error.code === '23505') {
      return res.status(409).json({ error: 'You have already reviewed this business' });
    }
    throw error;
  }
});

export default router;
```

### Frontend: Business Page with Optimistic Reviews

```tsx
// frontend/src/routes/business.$slug.tsx
import { useState, useEffect, useCallback } from 'react';
import { useParams } from '@tanstack/react-router';
import { BusinessHeader } from '../components/business/BusinessHeader';
import { ReviewForm } from '../components/business/ReviewForm';
import { ReviewsList } from '../components/business/ReviewsList';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import type { Business, Review } from 'shared/types';

export function BusinessDetailPage() {
  const { slug } = useParams({ from: '/business/$slug' });
  const { isAuthenticated } = useAuthStore();
  const [business, setBusiness] = useState<Business | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch business and reviews
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [businessRes, reviewsRes] = await Promise.all([
          api.get<{ business: Business }>(`/businesses/${slug}`),
          api.get<{ reviews: Review[] }>(`/businesses/${slug}/reviews`)
        ]);
        setBusiness(businessRes.data.business);
        setReviews(reviewsRes.data.reviews);
      } catch (error) {
        console.error('Failed to load business:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [slug]);

  // Optimistic add
  const handleOptimisticAdd = useCallback((tempReview: Review) => {
    setReviews((prev) => [tempReview, ...prev]);

    // Optimistically update rating
    if (business) {
      const newCount = business.reviewCount + 1;
      const newRating = (business.averageRating * business.reviewCount + tempReview.rating) / newCount;
      setBusiness({
        ...business,
        averageRating: newRating,
        reviewCount: newCount
      });
    }
  }, [business]);

  // Optimistic remove (on failure)
  const handleOptimisticRemove = useCallback((tempId: string) => {
    setReviews((prev) => prev.filter((r) => r.id !== tempId));

    // Revert rating (refetch business data)
    api.get<{ business: Business }>(`/businesses/${slug}`)
      .then((res) => setBusiness(res.data.business));
  }, [slug]);

  // Real review added
  const handleReviewCreated = useCallback((review: Review, updatedRating: number) => {
    setReviews((prev) => {
      // Remove temp and add real
      const withoutTemp = prev.filter((r) => !r.id.startsWith('temp-'));
      return [review, ...withoutTemp];
    });

    if (business) {
      setBusiness({
        ...business,
        averageRating: updatedRating,
        reviewCount: business.reviewCount + 1
      });
    }
  }, [business]);

  if (isLoading || !business) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <BusinessHeader business={business} />

      <div className="grid grid-cols-3 gap-8 mt-8">
        {/* Main content */}
        <div className="col-span-2">
          {/* Review form (if authenticated) */}
          {isAuthenticated && (
            <ReviewForm
              businessId={business.id}
              onReviewCreated={handleReviewCreated}
              onOptimisticAdd={handleOptimisticAdd}
              onOptimisticRemove={handleOptimisticRemove}
            />
          )}

          {/* Reviews list */}
          <ReviewsList
            reviews={reviews}
            businessId={business.id}
          />
        </div>

        {/* Sidebar */}
        <aside>
          <BusinessSidebar business={business} />
        </aside>
      </div>
    </div>
  );
}
```

---

## 6. Deep Dive: API Client with Type Safety (4-5 minutes)

### Typed API Client

```typescript
// frontend/src/services/api.ts
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import type {
  SearchRequest,
  SearchResponse,
  CreateReviewRequest,
  CreateReviewResponse,
  Business,
  Review
} from 'shared/types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  withCredentials: true, // Include session cookies
  headers: {
    'Content-Type': 'application/json'
  }
});

// Request interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      // Redirect to login on auth failure
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Type-safe API methods
export const searchApi = {
  search: (params: SearchRequest) =>
    api.get<SearchResponse>('/search', { params }),

  autocomplete: (q: string, signal?: AbortSignal) =>
    api.get<{ suggestions: AutocompleteSuggestion[] }>('/search/autocomplete', {
      params: { q },
      signal
    })
};

export const businessApi = {
  getById: (id: string) =>
    api.get<{ business: Business }>(`/businesses/${id}`),

  getReviews: (id: string, page = 1, limit = 10) =>
    api.get<{ reviews: Review[]; hasMore: boolean }>(
      `/businesses/${id}/reviews`,
      { params: { page, limit } }
    ),

  createReview: (
    businessId: string,
    data: CreateReviewRequest,
    idempotencyKey: string
  ) =>
    api.post<CreateReviewResponse>(
      `/businesses/${businessId}/reviews`,
      data,
      { headers: { 'Idempotency-Key': idempotencyKey } }
    )
};

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ user: User }>('/auth/login', { email, password }),

  register: (data: RegisterRequest) =>
    api.post<{ user: User }>('/auth/register', data),

  logout: () =>
    api.post('/auth/logout'),

  me: () =>
    api.get<{ user: User }>('/auth/me')
};

export default api;
```

### Backend: Type-Safe Route Handlers

```typescript
// backend/src/routes/businesses.ts
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { Business, BusinessSummary } from 'shared/types';

const router = Router();

// Param validation schema
const businessIdSchema = z.object({
  id: z.string().uuid()
});

// Type-safe handler wrapper
function asyncHandler<T extends z.ZodTypeAny>(
  schema: T,
  handler: (
    req: Request,
    res: Response,
    params: z.infer<T>
  ) => Promise<void>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.safeParse({ ...req.params, ...req.query, ...req.body });
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      await handler(req, res, parsed.data);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/:id', asyncHandler(businessIdSchema, async (req, res, { id }) => {
  // Check cache
  const cached = await redis.get(`business:${id}`);
  if (cached) {
    return res.json({ business: JSON.parse(cached), cacheHit: true });
  }

  // Query database
  const result = await pool.query(
    `SELECT
      b.*,
      rating_sum::float / NULLIF(review_count, 0) as average_rating,
      ST_X(location::geometry) as lng,
      ST_Y(location::geometry) as lat
     FROM businesses b
     WHERE id = $1 AND is_active = true`,
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const business: Business = transformBusinessRow(result.rows[0]);

  // Cache for 5 minutes
  await redis.setex(`business:${id}`, 300, JSON.stringify(business));

  res.json({ business, cacheHit: false });
}));

export default router;
```

---

## 7. Deep Dive: Rate Limiting Integration (3-4 minutes)

### Backend: Rate Limit Middleware

```typescript
// backend/src/middleware/rateLimit.ts
import { Request, Response, NextFunction } from 'express';
import { redis } from '../shared/cache';

interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
  keyPrefix: string;
  keyExtractor: (req: Request) => string;
}

export function rateLimit(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `${config.keyPrefix}:${config.keyExtractor(req)}`;

    const script = `
      local key = KEYS[1]
      local limit = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      local current = redis.call('GET', key)

      if current and tonumber(current) >= limit then
        return {0, tonumber(current), redis.call('TTL', key)}
      else
        local count = redis.call('INCR', key)
        if count == 1 then
          redis.call('EXPIRE', key, window)
        end
        return {1, count, redis.call('TTL', key)}
      end
    `;

    const [allowed, count, ttl] = await redis.eval(
      script, 1, key, config.limit, config.windowSeconds
    ) as [number, number, number];

    res.set({
      'X-RateLimit-Limit': config.limit.toString(),
      'X-RateLimit-Remaining': Math.max(0, config.limit - count).toString(),
      'X-RateLimit-Reset': (Math.floor(Date.now() / 1000) + ttl).toString()
    });

    if (allowed === 0) {
      res.set('Retry-After', ttl.toString());
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: ttl
      });
    }

    next();
  };
}

// Usage
const reviewRateLimit = rateLimit({
  limit: 10,
  windowSeconds: 3600,
  keyPrefix: 'ratelimit:reviews',
  keyExtractor: (req) => req.session?.userId || req.ip
});

router.post('/:businessId/reviews', requireAuth, reviewRateLimit, createReviewHandler);
```

### Frontend: Handling Rate Limit Errors

```typescript
// frontend/src/services/api.ts
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error: string; retryAfter?: number }>) => {
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.retryAfter || 60;
      const minutes = Math.ceil(retryAfter / 60);

      // Show user-friendly message
      toast.error(`Too many requests. Please try again in ${minutes} minute(s).`);
    }
    return Promise.reject(error);
  }
);
```

---

## 8. Deep Dive: Error Handling (3-4 minutes)

### Backend: Error Middleware

```typescript
// backend/src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../shared/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  // Log error
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.session?.userId
  });

  // Zod validation errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
  }

  // Application errors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code
    });
  }

  // Database constraint violations
  if ((err as any).code === '23505') {
    return res.status(409).json({
      error: 'Resource already exists'
    });
  }

  // Default server error
  res.status(500).json({
    error: 'Internal server error'
  });
}
```

### Frontend: Error Boundary

```tsx
// frontend/src/components/ErrorBoundary.tsx
import { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);

    // Report to error tracking service
    if (import.meta.env.PROD) {
      // reportError(error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="flex flex-col items-center justify-center min-h-[400px]">
          <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
          <p className="text-gray-600 mb-4">We're sorry for the inconvenience.</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-yelp-red text-white rounded-lg"
          >
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

---

## 9. Trade-offs and Alternatives (3-4 minutes)

### API Design

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| REST | Simple, cacheable, familiar | Over/under-fetching | **Chosen** - fits CRUD well |
| GraphQL | Flexible queries | Complexity, caching harder | Consider for mobile |
| tRPC | Full type safety | Coupling, learning curve | Good for monorepo |

### State Management

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Zustand | Lightweight, simple | Less structure | **Chosen** - right-sized |
| TanStack Query | Great for server state | Overkill for simple cases | Add for complex caching |
| Redux | Predictable, DevTools | Boilerplate | Too heavy for this app |

### Validation

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Zod (shared) | Type inference, runtime + compile | Bundle size | **Chosen** - single source of truth |
| Yup | Mature, expressive | No type inference | Legacy choice |
| io-ts | Functional style | Steep learning curve | For FP shops |

---

## 10. Monitoring and Observability (2-3 minutes)

### Frontend Performance Metrics

```typescript
// frontend/src/utils/performance.ts
export function reportWebVitals() {
  if (typeof window === 'undefined') return;

  import('web-vitals').then(({ getCLS, getFID, getFCP, getLCP, getTTFB }) => {
    getCLS((metric) => sendToAnalytics('CLS', metric.value));
    getFID((metric) => sendToAnalytics('FID', metric.value));
    getFCP((metric) => sendToAnalytics('FCP', metric.value));
    getLCP((metric) => sendToAnalytics('LCP', metric.value));
    getTTFB((metric) => sendToAnalytics('TTFB', metric.value));
  });
}

function sendToAnalytics(name: string, value: number) {
  // Send to backend metrics endpoint
  navigator.sendBeacon('/api/v1/metrics', JSON.stringify({
    name,
    value,
    page: window.location.pathname,
    timestamp: Date.now()
  }));
}
```

### Backend Request Tracing

```typescript
// backend/src/middleware/tracing.ts
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = req.headers['x-request-id'] as string || uuidv4();
  const startTime = Date.now();

  // Add to request context
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  // Log on response finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    logger.info({
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      userId: req.session?.userId
    });

    // Record metrics
    metrics.httpRequestDuration.observe(
      { method: req.method, path: req.route?.path || req.path, status: res.statusCode },
      duration / 1000
    );
  });

  next();
}
```

---

## Summary

The key full-stack insights for Yelp's design are:

1. **Shared Type System**: TypeScript types and Zod schemas shared between frontend and backend ensure contract consistency and catch mismatches at compile time

2. **End-to-End Search Flow**: Debounced autocomplete with abort controllers, geo-aware search with Elasticsearch, and URL-synchronized filters provide seamless UX

3. **Optimistic Updates with Rollback**: Review form adds temp review immediately, updates on success or rolls back on failure - keeps UI responsive while maintaining consistency

4. **Idempotency for Mutations**: UUID-based idempotency keys prevent duplicate reviews on network retries, with Redis-cached responses for repeat requests

5. **Rate Limiting Integration**: Backend enforces limits with clear headers; frontend handles 429 errors gracefully with user-friendly retry messages

6. **Type-Safe API Client**: Axios wrapper with typed methods ensures request/response types match backend contracts

7. **Error Handling at All Layers**: Zod validation errors, database constraints, and application errors are handled with appropriate status codes and user-friendly messages

This architecture delivers a cohesive experience where frontend and backend work together to provide fast, reliable, and user-friendly business search and review functionality.

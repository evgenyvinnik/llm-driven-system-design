# Facebook Post Search - System Design Answer (Full-Stack Focus)

## 45-minute system design interview format - Full-Stack Engineer Position

### 1. Requirements Clarification (3 minutes)

**Functional Requirements:**
- Full-text search across posts with privacy enforcement
- Real-time typeahead suggestions
- Personalized ranking based on social graph
- Filters for date range, post type, author
- Search history and saved searches

**Non-Functional Requirements:**
- End-to-end latency: P99 < 300ms
- Typeahead: < 100ms perceived latency
- Zero privacy violations (unauthorized content never shown)
- Graceful degradation on backend failures

**Full-Stack Focus Areas:**
- API contract design and type sharing
- Optimistic UI updates with error handling
- Real-time suggestion streaming
- Caching strategy across layers
- End-to-end testing approach

---

### 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Full-Stack View                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                            Frontend                                     │ │
│  │  SearchBar → useSearchStore (Zustand) → SearchAPI → SearchResults     │ │
│  │      ↓              ↓                       ↓              ↓          │ │
│  │  Debounce    Local Cache              HTTP/fetch     Virtualization   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│                           HTTP/REST API                                      │
│                                    ↓                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                            Backend                                      │ │
│  │  Express Router → SearchService → Elasticsearch → Response Builder    │ │
│  │       ↓               ↓                ↓                ↓             │ │
│  │  Auth Middleware  Visibility     Query Builder    Highlighting       │ │
│  │       ↓               ↓                                               │ │
│  │  Rate Limiter    Redis Cache ←────── PostgreSQL (Social Graph)       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Shared Package                                  │ │
│  │  @fb-search/shared-types: API types, validation schemas, constants   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Integration Points:**
1. **Search API**: Query → Results with highlighting
2. **Suggestions API**: Partial query → Typeahead options
3. **Visibility System**: User ID → Authorized fingerprints
4. **Caching**: Multi-layer (browser, CDN, Redis, ES query cache)

---

### 3. Full-Stack Deep-Dives

#### Deep-Dive A: Shared Types Package (6 minutes)

**Package Structure:**

```typescript
// packages/shared-types/src/index.ts

// ============================================
// Search Request/Response Types
// ============================================

export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  cursor?: string;
  limit?: number;
}

export interface SearchFilters {
  dateRange?: {
    start: string; // ISO 8601
    end: string;
  };
  postType?: 'text' | 'photo' | 'video' | 'link';
  authorId?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  has_more: boolean;
  next_cursor: string | null;
  took_ms: number;
  query_id: string; // For analytics
}

export interface SearchResult {
  id: string;
  author: {
    id: string;
    display_name: string;
    avatar_url: string;
    is_verified: boolean;
  };
  content: string;
  highlights: Highlight[];
  post_type: 'text' | 'photo' | 'video' | 'link';
  created_at: string;
  engagement: {
    like_count: number;
    comment_count: number;
    share_count: number;
  };
  media?: MediaItem[];
  relevance_score: number;
}

export interface Highlight {
  start: number;
  end: number;
  field: 'content' | 'hashtag' | 'author';
}

// ============================================
// Suggestions Types
// ============================================

export interface SuggestionRequest {
  query: string;
  limit?: number;
}

export interface SuggestionResponse {
  suggestions: Suggestion[];
}

export interface Suggestion {
  type: 'query' | 'hashtag' | 'person' | 'history';
  text: string;
  metadata?: {
    personId?: string;
    avatarUrl?: string;
    postCount?: number;
  };
}

// ============================================
// Error Types
// ============================================

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export const ErrorCodes = {
  INVALID_QUERY: 'INVALID_QUERY',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  TIMEOUT: 'TIMEOUT'
} as const;

// ============================================
// Validation Schemas (Zod)
// ============================================

import { z } from 'zod';

export const searchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  filters: z.object({
    dateRange: z.object({
      start: z.string().datetime(),
      end: z.string().datetime()
    }).optional(),
    postType: z.enum(['text', 'photo', 'video', 'link']).optional(),
    authorId: z.string().uuid().optional()
  }).optional(),
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(20)
});

export const suggestionRequestSchema = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().min(1).max(10).default(5)
});

// Type inference from schemas
export type ValidatedSearchRequest = z.infer<typeof searchRequestSchema>;
export type ValidatedSuggestionRequest = z.infer<typeof suggestionRequestSchema>;
```

**Using Shared Types:**

```typescript
// Backend: routes/search.ts
import {
  SearchRequest,
  SearchResponse,
  searchRequestSchema,
  ApiError,
  ErrorCodes
} from '@fb-search/shared-types';

router.get('/search', async (req, res) => {
  const parseResult = searchRequestSchema.safeParse(req.query);

  if (!parseResult.success) {
    const error: ApiError = {
      code: ErrorCodes.INVALID_QUERY,
      message: 'Invalid search parameters',
      details: parseResult.error.flatten()
    };
    return res.status(400).json(error);
  }

  const request: SearchRequest = parseResult.data;
  const response: SearchResponse = await searchService.search(request, req.userId);
  res.json(response);
});

// Frontend: services/searchApi.ts
import {
  SearchRequest,
  SearchResponse,
  SuggestionRequest,
  SuggestionResponse,
  ApiError
} from '@fb-search/shared-types';

export async function search(request: SearchRequest): Promise<SearchResponse> {
  const params = new URLSearchParams();
  params.set('query', request.query);

  if (request.filters?.postType) {
    params.set('postType', request.filters.postType);
  }

  const response = await fetch(`/api/v1/search?${params}`);

  if (!response.ok) {
    const error: ApiError = await response.json();
    throw new SearchError(error);
  }

  return response.json();
}
```

---

#### Deep-Dive B: API Design and Implementation (8 minutes)

**Express Router:**

```typescript
// backend/src/routes/search.ts
import { Router } from 'express';
import { searchRequestSchema, suggestionRequestSchema } from '@fb-search/shared-types';
import { SearchService } from '../services/searchService.js';
import { SuggestionService } from '../services/suggestionService.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validate.js';

const router = Router();
const searchService = new SearchService();
const suggestionService = new SuggestionService();

// Search endpoint
router.get(
  '/search',
  authenticate,
  rateLimit({ windowMs: 60000, max: 100 }),
  validateRequest(searchRequestSchema, 'query'),
  async (req, res, next) => {
    try {
      const startTime = Date.now();

      const response = await searchService.search(
        req.validated,
        req.userId
      );

      // Add timing header
      res.set('X-Response-Time', `${Date.now() - startTime}ms`);

      // Cache control for CDN
      res.set('Cache-Control', 'private, max-age=60');
      res.set('Vary', 'Authorization');

      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

// Suggestions endpoint (low-latency)
router.get(
  '/suggestions',
  authenticate,
  rateLimit({ windowMs: 60000, max: 300 }),
  validateRequest(suggestionRequestSchema, 'query'),
  async (req, res, next) => {
    try {
      const response = await suggestionService.getSuggestions(
        req.validated,
        req.userId
      );

      // Short cache for suggestions
      res.set('Cache-Control', 'private, max-age=10');

      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

// Search history
router.get(
  '/search/history',
  authenticate,
  async (req, res, next) => {
    try {
      const history = await searchService.getHistory(req.userId, 20);
      res.json({ history });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/search/history',
  authenticate,
  async (req, res, next) => {
    try {
      await searchService.clearHistory(req.userId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

**Validation Middleware:**

```typescript
// backend/src/middleware/validate.ts
import { z, ZodSchema } from 'zod';
import { ApiError, ErrorCodes } from '@fb-search/shared-types';

type RequestPart = 'body' | 'query' | 'params';

export function validateRequest<T extends ZodSchema>(
  schema: T,
  part: RequestPart = 'body'
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);

    if (!result.success) {
      const error: ApiError = {
        code: ErrorCodes.INVALID_QUERY,
        message: 'Validation failed',
        details: result.error.flatten()
      };
      return res.status(400).json(error);
    }

    req.validated = result.data;
    next();
  };
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      validated?: unknown;
      userId?: string;
    }
  }
}
```

**Frontend API Client:**

```typescript
// frontend/src/services/searchApi.ts
import type {
  SearchRequest,
  SearchResponse,
  SuggestionRequest,
  SuggestionResponse,
  ApiError
} from '@fb-search/shared-types';

const API_BASE = '/api/v1';

class SearchApiClient {
  private abortController: AbortController | null = null;

  async search(request: SearchRequest): Promise<SearchResponse> {
    // Cancel any in-flight request
    this.abortController?.abort();
    this.abortController = new AbortController();

    const params = this.buildSearchParams(request);
    const url = `${API_BASE}/search?${params}`;

    try {
      const response = await fetch(url, {
        signal: this.abortController.signal,
        credentials: 'include'
      });

      if (!response.ok) {
        const error: ApiError = await response.json();
        throw new SearchApiError(error, response.status);
      }

      return response.json();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new SearchAbortedError();
      }
      throw error;
    }
  }

  async getSuggestions(request: SuggestionRequest): Promise<SuggestionResponse> {
    const params = new URLSearchParams({
      query: request.query,
      limit: String(request.limit ?? 5)
    });

    const response = await fetch(`${API_BASE}/suggestions?${params}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      // Fail silently for suggestions
      return { suggestions: [] };
    }

    return response.json();
  }

  async getHistory(): Promise<{ history: HistoryItem[] }> {
    const response = await fetch(`${API_BASE}/search/history`, {
      credentials: 'include'
    });

    if (!response.ok) {
      return { history: [] };
    }

    return response.json();
  }

  async clearHistory(): Promise<void> {
    await fetch(`${API_BASE}/search/history`, {
      method: 'DELETE',
      credentials: 'include'
    });
  }

  private buildSearchParams(request: SearchRequest): URLSearchParams {
    const params = new URLSearchParams();
    params.set('query', request.query);

    if (request.limit) {
      params.set('limit', String(request.limit));
    }

    if (request.cursor) {
      params.set('cursor', request.cursor);
    }

    if (request.filters) {
      const { dateRange, postType, authorId } = request.filters;

      if (dateRange) {
        params.set('dateFrom', dateRange.start);
        params.set('dateTo', dateRange.end);
      }

      if (postType) {
        params.set('postType', postType);
      }

      if (authorId) {
        params.set('authorId', authorId);
      }
    }

    return params;
  }
}

export const searchApi = new SearchApiClient();

// Custom error classes
export class SearchApiError extends Error {
  constructor(
    public apiError: ApiError,
    public status: number
  ) {
    super(apiError.message);
    this.name = 'SearchApiError';
  }
}

export class SearchAbortedError extends Error {
  constructor() {
    super('Search was cancelled');
    this.name = 'SearchAbortedError';
  }
}
```

---

#### Deep-Dive C: Multi-Layer Caching Strategy (8 minutes)

**Caching Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Caching Layers                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Layer 1: Browser Cache (SessionStorage)                                    │
│  ├─ Recent search results (per query hash)                                  │
│  ├─ TTL: Session duration                                                   │
│  └─ Size: 50 most recent queries                                            │
│                                                                              │
│  Layer 2: Service Worker Cache                                              │
│  ├─ API responses for offline support                                       │
│  ├─ TTL: 1 hour (stale-while-revalidate)                                   │
│  └─ Size: 10MB limit                                                        │
│                                                                              │
│  Layer 3: Redis (Server-side)                                               │
│  ├─ Visibility sets per user                                                │
│  │   └─ Key: visibility:{userId}, TTL: 5 min                               │
│  ├─ Popular queries                                                         │
│  │   └─ Key: search:{queryHash}:{visibilityHash}, TTL: 1 min              │
│  └─ Suggestion results                                                      │
│      └─ Key: suggest:{prefix}, TTL: 10 min                                 │
│                                                                              │
│  Layer 4: Elasticsearch Query Cache                                         │
│  ├─ Built-in query result caching                                          │
│  ├─ Invalidated on index refresh                                           │
│  └─ Size: 10% of heap                                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Frontend Cache Implementation:**

```typescript
// frontend/src/services/searchCache.ts
import type { SearchRequest, SearchResponse } from '@fb-search/shared-types';

interface CacheEntry {
  response: SearchResponse;
  timestamp: number;
}

class SearchCache {
  private readonly MAX_ENTRIES = 50;
  private readonly TTL_MS = 60000; // 1 minute
  private readonly STORAGE_KEY = 'search_cache';

  private cache: Map<string, CacheEntry>;

  constructor() {
    this.cache = this.loadFromStorage();
  }

  get(request: SearchRequest): SearchResponse | null {
    const key = this.getCacheKey(request);
    const entry = this.cache.get(key);

    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > this.TTL_MS) {
      this.cache.delete(key);
      this.saveToStorage();
      return null;
    }

    return entry.response;
  }

  set(request: SearchRequest, response: SearchResponse): void {
    const key = this.getCacheKey(request);

    // Evict oldest entries if at capacity
    if (this.cache.size >= this.MAX_ENTRIES) {
      const oldest = this.findOldestEntry();
      if (oldest) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, {
      response,
      timestamp: Date.now()
    });

    this.saveToStorage();
  }

  invalidate(pattern?: string): void {
    if (!pattern) {
      this.cache.clear();
    } else {
      for (const key of this.cache.keys()) {
        if (key.includes(pattern)) {
          this.cache.delete(key);
        }
      }
    }
    this.saveToStorage();
  }

  private getCacheKey(request: SearchRequest): string {
    const parts = [
      request.query,
      request.filters?.postType ?? 'all',
      request.filters?.dateRange?.start ?? '',
      request.filters?.dateRange?.end ?? '',
      request.filters?.authorId ?? '',
      request.cursor ?? ''
    ];
    return parts.join('|');
  }

  private findOldestEntry(): string | null {
    let oldest: { key: string; timestamp: number } | null = null;

    for (const [key, entry] of this.cache.entries()) {
      if (!oldest || entry.timestamp < oldest.timestamp) {
        oldest = { key, timestamp: entry.timestamp };
      }
    }

    return oldest?.key ?? null;
  }

  private loadFromStorage(): Map<string, CacheEntry> {
    try {
      const stored = sessionStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        return new Map(JSON.parse(stored));
      }
    } catch {
      // Storage unavailable or corrupted
    }
    return new Map();
  }

  private saveToStorage(): void {
    try {
      const entries = Array.from(this.cache.entries());
      sessionStorage.setItem(this.STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Storage full or unavailable
    }
  }
}

export const searchCache = new SearchCache();
```

**Backend Cache Service:**

```typescript
// backend/src/services/cacheService.ts
import { Redis } from 'ioredis';
import { createHash } from 'crypto';
import type { SearchRequest, SearchResponse } from '@fb-search/shared-types';

export class CacheService {
  constructor(private readonly redis: Redis) {}

  // ============================================
  // Visibility Cache
  // ============================================

  async getVisibilitySet(userId: string): Promise<string[] | null> {
    const key = `visibility:${userId}`;
    const cached = await this.redis.smembers(key);
    return cached.length > 0 ? cached : null;
  }

  async setVisibilitySet(userId: string, fingerprints: string[]): Promise<void> {
    const key = `visibility:${userId}`;
    const pipeline = this.redis.pipeline();

    pipeline.del(key);
    if (fingerprints.length > 0) {
      pipeline.sadd(key, ...fingerprints);
    }
    pipeline.expire(key, 300); // 5 minutes

    await pipeline.exec();
  }

  async invalidateVisibility(userId: string): Promise<void> {
    await this.redis.del(`visibility:${userId}`);
  }

  // ============================================
  // Search Results Cache
  // ============================================

  async getSearchResults(
    request: SearchRequest,
    visibilityHash: string
  ): Promise<SearchResponse | null> {
    const key = this.getSearchCacheKey(request, visibilityHash);
    const cached = await this.redis.get(key);

    if (cached) {
      return JSON.parse(cached);
    }

    return null;
  }

  async setSearchResults(
    request: SearchRequest,
    visibilityHash: string,
    response: SearchResponse
  ): Promise<void> {
    const key = this.getSearchCacheKey(request, visibilityHash);

    // Only cache for popular queries (determined by request count)
    const requestCountKey = `search_count:${this.hashQuery(request.query)}`;
    const count = await this.redis.incr(requestCountKey);
    await this.redis.expire(requestCountKey, 3600);

    if (count >= 5) {
      // Cache if query is "popular" (5+ requests in an hour)
      await this.redis.setex(
        key,
        60, // 1 minute TTL
        JSON.stringify(response)
      );
    }
  }

  // ============================================
  // Suggestions Cache
  // ============================================

  async getSuggestions(prefix: string): Promise<string[] | null> {
    const key = `suggest:${prefix.toLowerCase()}`;
    const cached = await this.redis.lrange(key, 0, 9);
    return cached.length > 0 ? cached : null;
  }

  async setSuggestions(prefix: string, suggestions: string[]): Promise<void> {
    const key = `suggest:${prefix.toLowerCase()}`;
    const pipeline = this.redis.pipeline();

    pipeline.del(key);
    if (suggestions.length > 0) {
      pipeline.rpush(key, ...suggestions);
    }
    pipeline.expire(key, 600); // 10 minutes

    await pipeline.exec();
  }

  // ============================================
  // Helpers
  // ============================================

  private getSearchCacheKey(request: SearchRequest, visibilityHash: string): string {
    const requestHash = this.hashRequest(request);
    return `search:${requestHash}:${visibilityHash}`;
  }

  private hashRequest(request: SearchRequest): string {
    const normalized = {
      q: request.query.toLowerCase().trim(),
      t: request.filters?.postType,
      ds: request.filters?.dateRange?.start,
      de: request.filters?.dateRange?.end,
      a: request.filters?.authorId,
      c: request.cursor
    };

    return createHash('md5')
      .update(JSON.stringify(normalized))
      .digest('hex')
      .slice(0, 12);
  }

  private hashQuery(query: string): string {
    return createHash('md5')
      .update(query.toLowerCase().trim())
      .digest('hex')
      .slice(0, 8);
  }

  hashVisibilitySet(fingerprints: string[]): string {
    return createHash('md5')
      .update(fingerprints.sort().join(','))
      .digest('hex')
      .slice(0, 12);
  }
}
```

---

#### Deep-Dive D: End-to-End Search Flow (8 minutes)

**Complete Flow Diagram:**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Search Request Flow                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  1. User types "vacation photos" in SearchBar                                │
│     │                                                                         │
│  2. Frontend: Debounce (150ms) → Check session cache                         │
│     │                                                                         │
│  3. Cache MISS → Send GET /api/v1/search?query=vacation+photos               │
│     │                                                                         │
│  4. Backend: Auth middleware validates session cookie                         │
│     │                                                                         │
│  5. Backend: Validate request with Zod schema                                │
│     │                                                                         │
│  6. Backend: Check visibility cache (Redis)                                  │
│     │                                                                         │
│  7. Visibility cache MISS → Compute from PostgreSQL                          │
│     │                                                                         │
│  8. Backend: Build Elasticsearch query with privacy filter                   │
│     │                                                                         │
│  9. Elasticsearch: Execute query, return 500 candidates                      │
│     │                                                                         │
│ 10. Backend: Re-rank with social proximity                                   │
│     │                                                                         │
│ 11. Backend: Extract highlights, build response                              │
│     │                                                                         │
│ 12. Backend: Cache visibility set for 5 min                                  │
│     │                                                                         │
│ 13. Response → Frontend                                                       │
│     │                                                                         │
│ 14. Frontend: Update Zustand store, cache results                            │
│     │                                                                         │
│ 15. Frontend: Render virtualized results with highlights                     │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Search Service Implementation:**

```typescript
// backend/src/services/searchService.ts
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import type { SearchRequest, SearchResponse, SearchResult } from '@fb-search/shared-types';
import { VisibilityService } from './visibilityService.js';
import { RankingService } from './rankingService.js';
import { HighlightService } from './highlightService.js';
import { CacheService } from './cacheService.js';
import { SearchHistoryRepository } from '../repositories/searchHistoryRepository.js';
import { metrics } from '../shared/metrics.js';

export class SearchService {
  constructor(
    private readonly es: ElasticsearchClient,
    private readonly visibilityService: VisibilityService,
    private readonly rankingService: RankingService,
    private readonly highlightService: HighlightService,
    private readonly cacheService: CacheService,
    private readonly historyRepo: SearchHistoryRepository
  ) {}

  async search(request: SearchRequest, userId: string): Promise<SearchResponse> {
    const startTime = Date.now();
    const queryId = crypto.randomUUID();

    try {
      // Step 1: Get user's visibility fingerprints
      const visibilitySet = await this.getVisibilitySet(userId);
      const visibilityHash = this.cacheService.hashVisibilitySet(visibilitySet);

      // Step 2: Check cache for identical query
      const cached = await this.cacheService.getSearchResults(request, visibilityHash);
      if (cached) {
        metrics.cacheHits.inc({ type: 'search' });
        return { ...cached, query_id: queryId };
      }
      metrics.cacheMisses.inc({ type: 'search' });

      // Step 3: Build and execute Elasticsearch query
      const esQuery = this.buildQuery(request, visibilitySet);
      const esResponse = await this.es.search({
        index: 'posts-*',
        ...esQuery
      });

      // Step 4: Re-rank with social signals
      const reranked = await this.rankingService.rerank(
        esResponse.hits.hits,
        userId,
        request.query
      );

      // Step 5: Build response with highlights
      const results = await this.buildResults(reranked, request.query);

      const response: SearchResponse = {
        results: results.slice(0, request.limit ?? 20),
        total: typeof esResponse.hits.total === 'number'
          ? esResponse.hits.total
          : esResponse.hits.total?.value ?? 0,
        has_more: results.length > (request.limit ?? 20),
        next_cursor: this.buildCursor(results, request.limit ?? 20),
        took_ms: Date.now() - startTime,
        query_id: queryId
      };

      // Step 6: Cache and record history (async, don't wait)
      this.cacheService.setSearchResults(request, visibilityHash, response).catch(() => {});
      this.historyRepo.record(userId, request.query, response.total).catch(() => {});

      metrics.searchLatency.observe(Date.now() - startTime);
      return response;

    } catch (error) {
      metrics.searchErrors.inc();
      throw error;
    }
  }

  private async getVisibilitySet(userId: string): Promise<string[]> {
    // Check cache first
    const cached = await this.cacheService.getVisibilitySet(userId);
    if (cached) {
      return cached;
    }

    // Compute from scratch
    const fingerprints = await this.visibilityService.computeUserVisibility(userId);

    // Cache for future requests
    await this.cacheService.setVisibilitySet(userId, fingerprints);

    return fingerprints;
  }

  private buildQuery(request: SearchRequest, visibilitySet: string[]): object {
    const { query, filters, cursor } = request;

    const esQuery: any = {
      size: 500, // Over-fetch for re-ranking
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query,
                fields: ['content^2', 'hashtags^1.5', 'author_name'],
                type: 'best_fields',
                fuzziness: 'AUTO'
              }
            }
          ],
          filter: [
            // Privacy filter
            { terms: { visibility_fingerprints: visibilitySet } }
          ]
        }
      },
      highlight: {
        fields: {
          content: {
            number_of_fragments: 3,
            fragment_size: 150
          }
        },
        pre_tags: ['<mark>'],
        post_tags: ['</mark>']
      },
      sort: [
        { _score: 'desc' },
        { created_at: 'desc' }
      ]
    };

    // Apply filters
    if (filters?.dateRange) {
      esQuery.query.bool.filter.push({
        range: {
          created_at: {
            gte: filters.dateRange.start,
            lte: filters.dateRange.end
          }
        }
      });
    }

    if (filters?.postType) {
      esQuery.query.bool.filter.push({
        term: { post_type: filters.postType }
      });
    }

    if (filters?.authorId) {
      esQuery.query.bool.filter.push({
        term: { author_id: filters.authorId }
      });
    }

    // Cursor-based pagination
    if (cursor) {
      const { score, created_at, id } = this.decodeCursor(cursor);
      esQuery.search_after = [score, created_at, id];
    }

    return esQuery;
  }

  private async buildResults(hits: any[], query: string): Promise<SearchResult[]> {
    return hits.map(hit => ({
      id: hit._source.post_id,
      author: {
        id: hit._source.author_id,
        display_name: hit._source.author_name,
        avatar_url: hit._source.author_avatar,
        is_verified: hit._source.author_verified
      },
      content: hit._source.content,
      highlights: this.highlightService.parseHighlights(
        hit.highlight?.content ?? [],
        hit._source.content,
        query
      ),
      post_type: hit._source.post_type,
      created_at: hit._source.created_at,
      engagement: {
        like_count: hit._source.like_count,
        comment_count: hit._source.comment_count,
        share_count: hit._source.share_count
      },
      relevance_score: hit._score
    }));
  }

  private buildCursor(results: SearchResult[], limit: number): string | null {
    if (results.length <= limit) return null;

    const lastResult = results[limit - 1];
    return Buffer.from(JSON.stringify({
      score: lastResult.relevance_score,
      created_at: lastResult.created_at,
      id: lastResult.id
    })).toString('base64');
  }

  private decodeCursor(cursor: string): { score: number; created_at: string; id: string } {
    return JSON.parse(Buffer.from(cursor, 'base64').toString());
  }

  async getHistory(userId: string, limit: number): Promise<HistoryItem[]> {
    return this.historyRepo.getRecent(userId, limit);
  }

  async clearHistory(userId: string): Promise<void> {
    await this.historyRepo.clear(userId);
  }
}
```

**Frontend Integration:**

```typescript
// frontend/src/stores/searchStore.ts - executeSearch action
executeSearch: async (searchQuery) => {
  const { query, filters } = get();
  const effectiveQuery = searchQuery ?? query;

  if (!effectiveQuery.trim()) return;

  set({
    query: effectiveQuery,
    isLoading: true,
    error: null
  });

  try {
    // Check local cache first
    const request: SearchRequest = {
      query: effectiveQuery,
      filters,
      limit: 20
    };

    const cached = searchCache.get(request);
    if (cached) {
      set((state) => {
        state.results = cached.results;
        state.hasMore = cached.has_more;
        state.nextCursor = cached.next_cursor;
        state.isLoading = false;
      });
      return;
    }

    // Fetch from API
    const response = await searchApi.search(request);

    // Cache the response
    searchCache.set(request, response);

    set((state) => {
      state.results = response.results;
      state.hasMore = response.has_more;
      state.nextCursor = response.next_cursor;
      state.isLoading = false;

      // Update history
      state.searchHistory.unshift({
        query: effectiveQuery,
        timestamp: Date.now(),
        resultCount: response.total
      });

      if (state.searchHistory.length > 50) {
        state.searchHistory = state.searchHistory.slice(0, 50);
      }
    });

  } catch (error) {
    if (error instanceof SearchAbortedError) {
      // Ignore aborted requests
      return;
    }

    set({
      error: error instanceof SearchApiError
        ? error.apiError.message
        : 'Search failed. Please try again.',
      isLoading: false
    });
  }
}
```

---

### 4. Integration Testing Strategy

```typescript
// backend/src/__tests__/search.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { setupTestDb, teardownTestDb, seedTestData } from './testUtils.js';

describe('Search API Integration', () => {
  let sessionCookie: string;

  beforeAll(async () => {
    await setupTestDb();
    await seedTestData();

    // Login and get session
    const loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'testuser', password: 'password' });

    sessionCookie = loginResponse.headers['set-cookie'][0];
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  describe('GET /api/v1/search', () => {
    it('returns matching posts with highlights', async () => {
      const response = await request(app)
        .get('/api/v1/search')
        .query({ query: 'vacation' })
        .set('Cookie', sessionCookie)
        .expect(200);

      expect(response.body.results).toBeDefined();
      expect(response.body.results.length).toBeGreaterThan(0);
      expect(response.body.results[0].highlights).toBeDefined();
      expect(response.body.took_ms).toBeLessThan(500);
    });

    it('respects privacy - only shows authorized posts', async () => {
      const response = await request(app)
        .get('/api/v1/search')
        .query({ query: 'private' })
        .set('Cookie', sessionCookie)
        .expect(200);

      // Should not include posts from non-friends with friends-only visibility
      const results = response.body.results;
      for (const result of results) {
        expect(result.visibility).not.toBe('friends');
        // Or if friends-only, author should be a friend
      }
    });

    it('filters by post type', async () => {
      const response = await request(app)
        .get('/api/v1/search')
        .query({ query: 'test', postType: 'photo' })
        .set('Cookie', sessionCookie)
        .expect(200);

      for (const result of response.body.results) {
        expect(result.post_type).toBe('photo');
      }
    });

    it('validates query parameters', async () => {
      const response = await request(app)
        .get('/api/v1/search')
        .query({ query: '' }) // Empty query
        .set('Cookie', sessionCookie)
        .expect(400);

      expect(response.body.code).toBe('INVALID_QUERY');
    });

    it('requires authentication', async () => {
      await request(app)
        .get('/api/v1/search')
        .query({ query: 'test' })
        .expect(401);
    });
  });

  describe('GET /api/v1/suggestions', () => {
    it('returns typeahead suggestions', async () => {
      const response = await request(app)
        .get('/api/v1/suggestions')
        .query({ query: 'vac' })
        .set('Cookie', sessionCookie)
        .expect(200);

      expect(response.body.suggestions).toBeDefined();
      expect(Array.isArray(response.body.suggestions)).toBe(true);
    });
  });
});

// E2E test with Playwright
// frontend/e2e/search.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Search Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="username"]', 'alice');
    await page.fill('input[name="password"]', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForURL('/');
  });

  test('full search flow', async ({ page }) => {
    // Type in search bar
    const searchBar = page.getByRole('combobox', { name: /search/i });
    await searchBar.fill('vacation');

    // Wait for suggestions
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('option').first()).toBeVisible();

    // Press Enter to search
    await searchBar.press('Enter');

    // Wait for results
    await expect(page.getByRole('feed')).toBeVisible();
    await expect(page.getByRole('article').first()).toBeVisible();

    // Verify highlights are present
    const highlight = page.locator('mark.search-highlight').first();
    await expect(highlight).toBeVisible();
    await expect(highlight).toContainText(/vacation/i);
  });

  test('filters work correctly', async ({ page }) => {
    await page.getByRole('combobox', { name: /search/i }).fill('test');
    await page.keyboard.press('Enter');

    // Open filters
    await page.getByRole('button', { name: /filter/i }).click();

    // Select photo filter
    await page.getByRole('radio', { name: /photos/i }).click();

    // Apply
    await page.getByRole('button', { name: /apply/i }).click();

    // Verify URL updated
    await expect(page).toHaveURL(/postType=photo/);

    // Verify results are photos
    const results = page.getByRole('article');
    await expect(results.first()).toBeVisible();
  });
});
```

---

### 5. Trade-offs Analysis

| Decision | Pros | Cons |
|----------|------|------|
| Shared types package | Type safety across stack, single source of truth | Build complexity, version sync |
| Session-based caching | Per-user cache isolation, privacy safe | No cross-user cache sharing |
| Cursor pagination | Stable results, handles concurrent updates | Can't jump to specific page |
| Over-fetch for re-ranking (500 candidates) | Better relevance with social signals | Higher latency, more ES load |
| Client-side highlighting fallback | Works if server omits highlights | Less accurate than ES highlighting |
| Multi-layer cache invalidation | Fresh data when relationships change | Complex invalidation logic |

---

### 6. Observability

**Metrics Dashboard:**

```typescript
// Shared metrics between frontend and backend

// Backend metrics (Prometheus)
const metrics = {
  searchLatency: new Histogram({
    name: 'search_latency_ms',
    help: 'Search request latency in milliseconds',
    labelNames: ['cache_hit'],
    buckets: [10, 50, 100, 200, 500, 1000]
  }),

  cacheHits: new Counter({
    name: 'cache_hits_total',
    help: 'Cache hits by type',
    labelNames: ['type', 'layer']
  }),

  searchErrors: new Counter({
    name: 'search_errors_total',
    help: 'Search errors by type',
    labelNames: ['error_code']
  })
};

// Frontend metrics (sent to analytics)
function trackSearchMetrics(response: SearchResponse) {
  analytics.track('search_completed', {
    query_id: response.query_id,
    result_count: response.results.length,
    latency_ms: response.took_ms,
    has_filters: Boolean(filters.postType || filters.dateRange),
    is_cached: response.from_cache ?? false
  });
}

function trackSearchInteraction(event: string, data: Record<string, unknown>) {
  analytics.track(event, {
    ...data,
    timestamp: Date.now(),
    session_id: getSessionId()
  });
}

// Usage
trackSearchInteraction('result_clicked', {
  query: currentQuery,
  result_position: index,
  result_id: post.id
});
```

---

### 7. Future Enhancements

1. **Real-time Updates**: WebSocket for new matching posts while viewing results
2. **Federated Search**: Extend to photos, events, groups with unified ranking
3. **Query Rewriting**: ML-based query expansion and correction
4. **Personalized Suggestions**: User-specific typeahead based on history and graph
5. **Offline Search**: Service worker caching for recent queries
6. **A/B Testing Framework**: Compare ranking algorithms with holdout groups
7. **Search Analytics Dashboard**: Query trends, zero-result analysis, CTR by position

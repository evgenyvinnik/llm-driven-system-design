# Design Netflix - Fullstack System Design Answer

## 45-Minute Interview Format - Fullstack Engineering Focus

---

## Introduction (2 minutes)

"Thanks for having me. I'll design Netflix as a fullstack system, focusing on how the frontend and backend integrate to deliver seamless video streaming, personalized browsing, and cross-device continuity.

Key integration challenges include:
1. **Streaming manifest flow** from CDN to player with quality selection
2. **Progress synchronization** for Continue Watching across devices
3. **Personalization pipeline** from viewing history to homepage rows
4. **A/B testing** that spans both frontend and backend

Let me walk through the end-to-end architecture."

---

## Requirements Clarification (3 minutes)

### Functional Requirements

"Fullstack scope:

1. **Streaming Pipeline**: Manifest generation, CDN URL signing, player integration
2. **Progress Tracking**: Real-time position updates, cross-device resume
3. **Personalized Homepage**: Backend row generation, frontend rendering
4. **A/B Testing**: Consistent allocation, feature flags, experiment tracking
5. **Profile System**: Multi-profile accounts with maturity filtering"

### Non-Functional Requirements

"Cross-cutting concerns:

- **Playback Start**: < 2 seconds end-to-end
- **Progress Sync**: < 5 second latency for cross-device updates
- **Homepage Load**: < 1 second for personalized content
- **Consistency**: Same user always sees same experiment variant"

---

## End-to-End Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Frontend (React)                                    │
├─────────────────┬─────────────────┬─────────────────────────────────────────┤
│   VideoPlayer   │   BrowsePage    │              ProfilePage                │
│   + ABR Logic   │   + VideoRows   │              + Settings                 │
└────────┬────────┴────────┬────────┴─────────────────┬───────────────────────┘
         │                 │                          │
         └─────────────────┼──────────────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         │          Zustand Stores            │
         │  authStore │ browseStore │ player  │
         └─────────────────┬─────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         │         API Service Layer          │
         │  streaming.ts │ browse.ts │ etc.   │
         └─────────────────┬─────────────────┘
                           │ HTTP/REST
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Backend (Express)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                           API Gateway                                        │
│              Authentication │ Rate Limiting │ Routing                        │
├───────────────────┬───────────────────┬─────────────────────────────────────┤
│  Playback Service │  Personalization  │          Experiment Service          │
│  - Manifest       │  - Homepage       │          - Allocation                │
│  - Progress       │  - Ranking        │          - Metrics                   │
│  - CDN URLs       │  - My List        │          - Analysis                  │
└─────────┬─────────┴─────────┬─────────┴──────────────────┬──────────────────┘
          │                   │                            │
          └───────────────────┼────────────────────────────┘
                              │
         ┌────────────────────┴────────────────────┐
         │              Data Layer                  │
         ├──────────────────────────────────────────┤
         │  PostgreSQL (catalog, profiles, exps)   │
         │  Cassandra (progress, watch history)    │
         │  Redis (sessions, cache, rate limits)   │
         │  MinIO (video segments, manifests)      │
         └─────────────────────────────────────────┘
```

---

## Deep Dive: Streaming Pipeline (12 minutes)

### Manifest Generation and Delivery

"The streaming flow connects backend manifest generation with frontend ABR:"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    GET /stream/:videoId/manifest                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Authenticate request (session check)                                    │
│                                                                              │
│  2. Fetch video metadata from PostgreSQL                                    │
│     └── Return 404 if not found                                             │
│                                                                              │
│  3. Check maturity level against profile                                    │
│     ├── Map rating: G=1, PG=2, PG-13=3, R=4, TV-MA=5                        │
│     └── Return 403 if video rating > profile maturity                       │
│                                                                              │
│  4. Generate manifest with signed CDN URLs                                  │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │  Quality Levels:                                                   │   │
│     │  ├── 4K:    15 Mbps, 3840x2160                                    │   │
│     │  ├── 1080p: 5.8 Mbps, 1920x1080                                   │   │
│     │  ├── 720p:  3 Mbps, 1280x720                                      │   │
│     │  ├── 480p:  1 Mbps, 854x480                                       │   │
│     │  └── 360p:  560 Kbps, 640x360                                     │   │
│     │                                                                    │   │
│     │  Each source gets signed URL with 1-hour expiry (JWT)             │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  5. Fetch resume position from Cassandra                                    │
│                                                                              │
│  6. Track streaming start for analytics                                     │
│                                                                              │
│  7. Return: { manifest, resumePosition, video: { title, duration } }        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend ABR Controller

"The frontend consumes the manifest and handles quality switching:"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      useAdaptiveBitrate Hook                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  State:                                                                      │
│  ├── currentQuality: string ('auto' or specific quality)                    │
│  └── bandwidthEstimate: number (initial 5 Mbps)                             │
│                                                                              │
│  measureBandwidth(downloadTime, bytes):                                     │
│  ├── Calculate instant bandwidth: (bytes * 8) / downloadTime                │
│  └── Apply exponential moving average: prev * 0.7 + instant * 0.3           │
│                                                                              │
│  selectQuality():                                                           │
│  ├── If currentQuality !== 'auto' ──▶ return current                        │
│  ├── Calculate buffer level from video element                              │
│  ├── Filter sources by bandwidth * 0.8 (headroom)                           │
│  ├── Sort by bitrate descending                                             │
│  ├── If buffer < 5s ──▶ use conservative 0.5x threshold                     │
│  └── Return highest sustainable quality                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Progress Synchronization

"Progress updates flow from player to backend with debouncing:"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Frontend: playerStore.saveProgress()                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Check if moved >= 10 seconds since last save                            │
│     └── Skip if delta < 10 seconds                                          │
│                                                                              │
│  2. Debounce: Clear existing timeout, set new 2-second timer                │
│                                                                              │
│  3. POST /api/stream/progress { videoId, position, duration }               │
│                                                                              │
│  4. Update lastSavedPosition on success                                     │
│     └── Retry on next update if failed                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                    Backend: POST /stream/progress                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Determine completion: position / duration > 0.95                        │
│                                                                              │
│  2. Upsert to Cassandra viewing_progress table:                             │
│     ├── profile_id, content_id, position_seconds, duration_seconds          │
│     ├── progress_percent, completed (boolean), last_watched_at              │
│     └── High-write workload - Cassandra handles scale                       │
│                                                                              │
│  3. If completed:                                                           │
│     ├── Add to watch_history table                                          │
│     └── Increment genre_preferences counter for each genre                  │
│                                                                              │
│  4. Invalidate homepage cache: redis.del(`homepage:${profileId}`)           │
│                                                                              │
│  5. Return { saved: true, completed }                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Personalization Pipeline (10 minutes)

### Homepage Row Generation

"Backend generates personalized rows, frontend renders them:"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    GET /browse/homepage                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Check Redis cache: `homepage:${profileId}`                              │
│     └── Return cached JSON if found                                         │
│                                                                              │
│  2. Fetch profile for maturity filtering                                    │
│                                                                              │
│  3. Generate rows in parallel (Promise.all):                                │
│     ├── getContinueWatching(profileId)                                      │
│     ├── getTrending(language)                                               │
│     ├── getTopGenres(profileId)                                             │
│     ├── getRecentlyWatched(profileId)                                       │
│     └── getMyList(profileId)                                                │
│                                                                              │
│  4. Assemble rows array:                                                    │
│     ┌───────────────────────────────────────────────────────────────────┐   │
│     │  Row Order (if non-empty):                                         │   │
│     │  1. Continue Watching (always first)                               │   │
│     │  2. My List                                                        │   │
│     │  3. Trending Now                                                   │   │
│     │  4. Top 3 Genre Rows (based on viewing history)                    │   │
│     │  5. "Because You Watched X" (2 most recent completed videos)       │   │
│     └───────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  5. Apply A/B test treatments (row order, artwork selection)                │
│                                                                              │
│  6. Cache for 5 minutes: redis.setex(..., 300, ...)                         │
│                                                                              │
│  7. Return { rows: ContentRow[] }                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Continue Watching Query

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    getContinueWatching(profileId)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Query Cassandra viewing_progress:                                       │
│     ├── WHERE profile_id = ? AND completed = false                          │
│     ├── ORDER BY last_watched_at DESC                                       │
│     └── LIMIT 20                                                            │
│                                                                              │
│  2. Filter to items with progress > 5%                                      │
│                                                                              │
│  3. Enrich with PostgreSQL video metadata:                                  │
│     └── title, thumbnail_url, duration_minutes, rating, type                │
│                                                                              │
│  4. Merge progress data with video metadata:                                │
│     └── { ...video, resumePosition, progressPercent, lastWatchedAt }        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend Homepage Rendering

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BrowsePage Component                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  browseStore State:                                                         │
│  ├── rows: ContentRow[]                                                     │
│  ├── isLoading: boolean                                                     │
│  ├── error: string | null                                                   │
│  └── fetchHomepage(): Promise<void>                                         │
│                                                                              │
│  useEffect:                                                                 │
│  └── Fetch homepage when activeProfile changes                              │
│                                                                              │
│  Render Structure:                                                          │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  <Navbar />                                                            │  │
│  │                                                                        │  │
│  │  <HeroBanner video={featuredVideo} />                                  │  │
│  │                                                                        │  │
│  │  <div className="relative -mt-32 z-10">                               │  │
│  │    {rows.map((row) =>                                                  │  │
│  │      row.type === 'continue_watching'                                  │  │
│  │        ? <ContinueWatchingRow key={row.id} ... />                      │  │
│  │        : <VideoRow key={row.id} ... />                                 │  │
│  │    )}                                                                  │  │
│  │  </div>                                                                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ContinueWatchingRow:                                                       │
│  └── Renders VideoCards with progress bar overlay                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: A/B Testing Integration (8 minutes)

### Consistent Experiment Allocation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    getExperimentVariant(profileId, experimentId)             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Check cache: `exp:${profileId}:${experimentId}`                         │
│     └── Return cached variant if found                                      │
│                                                                              │
│  2. Fetch experiment from PostgreSQL                                        │
│     └── Return null if not found or status !== 'running'                    │
│                                                                              │
│  3. Calculate consistent hash:                                              │
│     ├── hash = murmurhash.v3(`${profileId}:${experimentId}`)                │
│     └── bucket = hash % 100                                                 │
│                                                                              │
│  4. Check allocation:                                                       │
│     └── If bucket >= allocation_percent ──▶ return null (control)           │
│                                                                              │
│  5. Determine variant by weights:                                           │
│     ├── Accumulate weights across variants                                  │
│     ├── Find variant where bucket < threshold                               │
│     └── Threshold = (allocation_percent * accumulated_weight) / 100         │
│                                                                              │
│  6. Cache for 24 hours                                                      │
│                                                                              │
│  7. Return variant with config                                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Apply Experiments to Homepage

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    applyExperiments(profileId, rows)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Experiment: Row Ordering                                                   │
│  ├── Get variant for 'row_order_test'                                       │
│  └── If config.prioritizeGenres ──▶ sort genre rows higher                  │
│                                                                              │
│  Experiment: Artwork Style                                                  │
│  ├── Get variant for 'artwork_style_test'                                   │
│  └── If config.usePersonalizedArtwork ──▶ fetch personalized thumbnails    │
│                                                                              │
│  Return modified rows                                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend Experiment Integration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    useExperiments Hook                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  State: allocations: { [experimentName]: variantName | null }               │
│                                                                              │
│  useEffect:                                                                 │
│  └── Fetch allocations from /api/experiments/allocations when authenticated│
│                                                                              │
│  Methods:                                                                   │
│  ├── isInVariant(experimentName, variantName): boolean                      │
│  └── getVariant(experimentName): string | null                              │
│                                                                              │
│  Usage Example - VideoCard:                                                 │
│  ├── const showMatchScore = isInVariant('match_score_test', 'show_score')  │
│  └── Conditionally render match percentage                                  │
│                                                                              │
│  Usage Example - HeroBanner:                                                │
│  ├── Track impression: POST /api/analytics/impression                       │
│  └── Render CTA based on variant ('Play Now' vs 'Watch')                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Shared Type Definitions (5 minutes)

"Shared types ensure frontend and backend stay in sync:"

### Video Types
- **Video**: id, title, type (movie/series), releaseYear, durationMinutes, rating, genres[], description, thumbnailUrl, backdropUrl, previewUrl?
- **Episode**: id, seasonId, episodeNumber, title, durationMinutes, description

### Profile Types
- **Profile**: id, accountId, name, avatarUrl, isKids, maturityLevel, language

### Streaming Types
- **StreamingManifest**: videoId, sources: QualityLevel[], segmentDuration, generatedAt
- **QualityLevel**: quality, bitrate, width, height, url

### Browse Types
- **ContentRow**: id, title, type (continue_watching/my_list/trending/genre/because_you_watched), items
- **ContinueWatchingItem**: extends Video with resumePosition, progressPercent, lastWatchedAt

### Experiment Types
- **Experiment**: id, name, description, allocationPercent, variants[], status, startDate, endDate?
- **Variant**: id, name, weight, config: Record<string, unknown>

### API Response Types
- **ApiResponse<T>**: data, error?
- **PaginatedResponse<T>**: items, total, page, pageSize, hasMore

---

## Error Handling Strategy (3 minutes)

### Backend Error Middleware

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Error Handler Middleware                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Known Error Types:                                                         │
│  ├── ValidationError ──▶ 400 { error, fields }                              │
│  ├── AuthenticationError ──▶ 401 { error: 'Authentication required' }       │
│  ├── AuthorizationError ──▶ 403 { error: 'Access denied' }                  │
│  └── NotFoundError ──▶ 404 { error: message }                               │
│                                                                              │
│  Circuit Breaker:                                                           │
│  └── 'Circuit breaker is OPEN' ──▶ 503 { error, retryAfter: 30 }            │
│                                                                              │
│  Default:                                                                   │
│  └── 500 { error: 'Internal server error' }                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend Error Handling

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ErrorBoundary Component                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  State: { hasError, error }                                                 │
│                                                                              │
│  getDerivedStateFromError:                                                  │
│  └── Set hasError: true, capture error                                      │
│                                                                              │
│  componentDidCatch:                                                         │
│  └── Log to monitoring service                                              │
│                                                                              │
│  Render:                                                                    │
│  └── If hasError ──▶ Show "Something went wrong" + Try Again button        │
│                                                                              │
│  API Interceptor:                                                           │
│  ├── 401 ──▶ Logout and redirect to /login                                  │
│  └── 503 ──▶ Throw ServiceUnavailableError for retry UI                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Progress Storage | Cassandra | PostgreSQL | High-write throughput for position updates |
| Session Storage | Redis | JWT | Immediate revocation, debugging visibility |
| Homepage Caching | Redis (5 min TTL) | No cache | Balance freshness vs. personalization latency |
| Shared Types | Duplicated files | Monorepo package | Simpler project structure for learning |
| Experiment Allocation | Server-side | Client-side | Consistent allocation, no flickering |
| CDN URLs | Signed JWT | Pre-signed S3 | Flexibility, custom expiration |

---

## Summary

"I've designed Netflix's fullstack architecture with:

1. **Streaming pipeline** with backend manifest generation and frontend ABR controller
2. **Progress synchronization** using Cassandra for high-write workloads with debounced frontend updates
3. **Personalization pipeline** generating rows server-side with Redis caching and frontend rendering
4. **A/B testing** with consistent MurmurHash allocation and frontend experiment hooks
5. **Shared type definitions** ensuring type safety across the stack
6. **Error handling** with backend middleware, circuit breakers, and frontend error boundaries

The architecture prioritizes cross-device consistency, low-latency personalization, and reliable playback across varying network conditions.

What aspect would you like me to elaborate on?"

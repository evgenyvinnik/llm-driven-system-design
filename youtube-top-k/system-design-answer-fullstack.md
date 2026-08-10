# YouTube Top K Videos - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement (1 minute)

"I'll design a real-time trending videos system that tracks view counts and computes Top K rankings with live updates. As a full-stack solution, I'll focus on three integration points: the view recording flow from frontend click to Redis counter with idempotency guarantees, the SSE-based real-time update pipeline that keeps clients in sync, and the shared type system that ensures consistency between TypeScript frontend and backend. I'll show how both layers work together to deliver a responsive, reliable trending experience."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **View Recording**: Track views with < 50ms latency
- **Trending Computation**: Top K videos per category, configurable time windows
- **Real-time Updates**: Push trending changes to all clients via SSE
- **Category Filtering**: Multiple categories with instant switching

### Non-Functional Requirements
- **Throughput**: 10,000+ views/second at peak
- **Latency**: < 50ms view recording, < 100ms trending queries
- **Consistency**: Eventual consistency (5-second refresh)
- **Reliability**: Graceful degradation when services fail

### Full-Stack Considerations
- Type-safe API contracts between frontend and backend
- Optimistic updates for view recording
- Reconnection handling for SSE streams
- Shared validation logic

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Frontend                                  │
│                  React + TypeScript + Zustand                        │
│                                                                      │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│   │  VideoCard   │    │ CategoryTabs │    │  SSEClient   │          │
│   │  + Simulate  │    │  + Filter    │    │  + Reconnect │          │
│   └──────┬───────┘    └──────────────┘    └──────┬───────┘          │
│          │                                        │                  │
└──────────┼────────────────────────────────────────┼──────────────────┘
           │ POST /api/videos/:id/view              │ SSE /api/sse
           ▼                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          API Layer                                   │
│                     Express + TypeScript                             │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│   │ ViewHandler  │    │   Trending   │    │  SSEHandler  │          │
│   │ + Idempotency│    │   Service    │    │  + Broadcast │          │
│   └──────┬───────┘    └──────┬───────┘    └──────┬───────┘          │
│          │                   │                   │                   │
└──────────┼───────────────────┼───────────────────┼───────────────────┘
           │                   │                   │
           ▼                   ▼                   │
     ┌───────────┐      ┌───────────┐              │
     │   Redis   │◄─────│PostgreSQL │              │
     │ Counters  │      │ Metadata  │◄─────────────┘
     └───────────┘      └───────────┘
```

---

## Deep Dive: Shared Types Package (5 minutes)

### Type Definitions

The shared package defines API types for type-safe frontend-backend communication:

**Core Types:**
- `Video` - id, title, thumbnailUrl, channelName, category, totalViews
- `Category` - 'all' | 'music' | 'gaming' | 'sports' | 'news' | 'education'
- `TrendingVideo` - videoId, title, viewCount, rank, thumbnailUrl, channelName
- `CategoryTrending` - category, videos[], computedAt

**Request/Response Types:**
- `RecordViewRequest` - sessionId?, idempotencyKey?
- `RecordViewResponse` - success, duplicate, videoId, newViewCount?
- `TrendingQueryParams` - category?, limit?, window?

**SSE Event Types:**
- `SSEEvent<T>` - type ('trending' | 'heartbeat' | 'error'), data, timestamp
- `TrendingUpdateEvent` - type: 'trending', data: TrendingData

**Error Types:**
- `ApiError` - code, message, details?
- `TrendingError` - extends Error with code, statusCode

### Shared Validation with Zod

Validation schemas run on both frontend and backend:

- `recordViewSchema` - validates sessionId (UUID), idempotencyKey (max 255 chars)
- `trendingQuerySchema` - validates category, limit (1-100), window
- `videoIdSchema` - validates UUID format

> "Shared validation catches errors early on both sides, reducing round-trips."

---

## Deep Dive: End-to-End View Recording Flow (10 minutes)

### Data Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Frontend   │────▶│  API Layer   │────▶│ Idempotency  │────▶│    Redis     │
│  VideoCard   │     │  ViewHandler │     │   Service    │     │   Counter    │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
       │                    │                    │                    │
       │ 1. Optimistic      │ 2. Validate        │ 3. Check           │ 4. Increment
       │    update          │    + verify        │    duplicate       │    ZINCRBY
       │                    │                    │                    │
       ▼                    ▼                    ▼                    ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Local state  │     │  PostgreSQL  │     │  Redis TTL   │     │ Sorted Set   │
│   +1 view    │     │ Video exists?│     │  1 hour key  │     │ category:ts  │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

### Frontend: API Client with Optimistic Updates

The API client generates idempotency keys automatically and handles:
- POST /videos/:id/view with idempotencyKey in body
- Bulk view recording for testing
- Fallback trending fetch when SSE disconnects

### Frontend: View Recording with Optimistic UI

VideoCard component implements optimistic updates:
1. Immediately increment local view count
2. Call `incrementOptimistic` on Zustand store
3. POST to API with generated idempotency key
4. On duplicate response: rollback local count
5. On error: rollback and log

### Backend: View Handler with Validation

The view handler flow:
1. Validate video ID with Zod schema
2. Validate request body (sessionId, idempotencyKey)
3. Check idempotency service for duplicate
4. If duplicate: return cached result with `duplicate: true`
5. Verify video exists in PostgreSQL
6. Record view via viewCounter service
7. Store idempotency result with 1-hour TTL
8. Return success response

### Backend: Idempotency Service

Redis-based idempotency with:
- Key format: `idem:{key}`
- TTL: 3600 seconds (1 hour)
- Stores: videoId, viewCount, processedAt
- Methods: check(), store(), delete()

---

## Deep Dive: SSE Real-Time Updates Pipeline (10 minutes)

### SSE Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Backend SSE Handler                             │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │                    Client Registry                          │    │
│   │   Map<clientId, {id, res, category, connectedAt}>          │    │
│   └────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│              ┌───────────────┼───────────────┐                      │
│              ▼               ▼               ▼                      │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐               │
│   │  Client A    │ │  Client B    │ │  Client C    │               │
│   │  category:   │ │  category:   │ │  category:   │               │
│   │    music     │ │   gaming     │ │     all      │               │
│   └──────────────┘ └──────────────┘ └──────────────┘               │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ broadcastTrending()
                              │
┌─────────────────────────────────────────────────────────────────────┐
│                     TrendingService                                  │
│   ┌────────────────┐    ┌────────────────┐    ┌────────────────┐   │
│   │ computeTopK()  │───▶│ enrichMetadata │───▶│   broadcast    │   │
│   │  every 5 sec   │    │   from PG      │    │   to clients   │   │
│   └────────────────┘    └────────────────┘    └────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Backend: SSE Handler with Client Management

SSE endpoint `/sse/trending` handles:
- Set SSE headers (text/event-stream, no-cache, keep-alive)
- Register client with unique ID and optional category filter
- Send initial trending data immediately
- Heartbeat every 30 seconds to keep connection alive
- Clean disconnect handling with client removal

**Broadcast function** iterates all clients and sends:
- Event type: 'trending'
- Data: TrendingData JSON
- Event ID: timestamp for resumption

**Stats endpoint** `/sse/stats` returns:
- connectedClients count
- totalConnections (lifetime)
- totalMessages sent
- Client details array

### Frontend: Robust SSE Hook with Reconnection

The `useSSE` hook provides:
- EventSource connection management
- Reconnection with exponential backoff (max 10 attempts, up to 30s delay)
- Last event ID tracking for resumption
- Connection status updates to Zustand store
- Separate handlers for 'trending' and 'heartbeat' events
- Cleanup on unmount

### Backend: TrendingService with Broadcast

TrendingService lifecycle:
1. **start()** - Initial computation + setInterval every 5 seconds
2. **computeAndBroadcast()** - For each category in parallel:
   - Get Top K from viewCounter (10 items, 1 hour window)
   - Enrich with video metadata from PostgreSQL
   - Build TrendingData object
3. **Cache** result in memory
4. **Broadcast** to all connected SSE clients

---

## Deep Dive: Error Handling Across Layers (5 minutes)

### Error Types and HTTP Status Mapping

```
┌────────────────────┬─────────────────┬────────────────────────────────┐
│     Error Type     │  HTTP Status    │         Response               │
├────────────────────┼─────────────────┼────────────────────────────────┤
│ ZodError           │      400        │ VALIDATION_ERROR + details[]   │
│ TrendingError      │ err.statusCode  │ err.code + err.message         │
│ Generic Error      │      500        │ INTERNAL_ERROR + message       │
└────────────────────┴─────────────────┴────────────────────────────────┘
```

### Backend: Error Middleware

Centralized error handler:
- ZodError: 400 with path-specific error details
- TrendingError: Custom status code with code/message
- Generic: 500 with sanitized message in production
- Stack trace included in development only

### Frontend: Error Boundary with Recovery

React ErrorBoundary component:
- Catches render errors via getDerivedStateFromError
- Logs to console (future: error tracking service)
- Displays friendly error UI with retry button
- Shows stack trace in development mode

### Frontend: API Error Handling Hook

`useApiError` hook provides:
- error state (ApiError | null)
- handleError() - parses error, sets state
- clearError() - resets state
- Attempts to parse JSON error from message, falls back to generic

---

## Deep Dive: Why Three Algorithms Ship and None Serve Traffic (6 minutes)

This codebase contains an exact min-heap top-K, a Count-Min Sketch, and Space-Saving — and the live path uses none of them. It uses a Redis sorted set. That is worth defending, because "we implemented the textbook algorithm and then didn't use it" sounds like waste and isn't.

**A sorted set is already the right data structure at this cardinality.** `ZINCRBY` maintains ordering incrementally on every increment, so extracting the top K is a range read over a structure that is *already sorted* — no separate pass, no second piece of state to keep coherent with the counts, and it works across processes. An in-process heap gives none of that: two API instances would each maintain their own heap over their own slice of traffic and disagree.

**Approximate algorithms buy memory savings that this workload doesn't need.** Count-Min Sketch and Space-Saving both trade accuracy for refusing to store one counter per distinct key. That is the correct trade when distinct keys exceed what memory can hold — IP addresses, URLs, search terms. A video catalog does not. Paying an accuracy cost to solve a memory problem you don't have is a strictly worse deal.

| Approach | Space | Accuracy | Cross-process | Right when |
|----------|-------|----------|---------------|-----------|
| ✅ Redis sorted set | O(distinct keys) | Exact | Yes | Cardinality fits in memory — the case here |
| ❌ In-process min-heap | O(K) | Exact for the top K | No | Single process, and you only ever need the top K |
| ❌ Count-Min Sketch | O(width × depth) | Overestimates, never under | Needs shared state anyway | Cardinality is unbounded and overcounting is safe |
| ❌ Space-Saving | O(k) counters | Guarantees items above n/k | Needs shared state anyway | Same, and you need per-item error bounds |

So why keep the implementations? Because the threshold at which the answer flips is a real engineering question, and the code makes it measurable — the heap operations are instrumented with Prometheus histograms specifically so someone can observe when cardinality has grown enough to justify switching. The honest state is that nobody has measured it yet, which is exactly the kind of thing worth saying out loud rather than implying the choice was validated.

There is also a wart in the unused code worth knowing about, because it illustrates why unused code decays: `TopK.update()` on an existing item rebuilds the whole heap instead of sifting in place — O(K) where it should be O(log K). It's flagged in a comment and unfixed, because nothing depends on it. Code that serves no traffic gets no pressure to be correct.

---

## Trade-offs and Alternatives (3 minutes)

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Type sharing | Monorepo package | Build complexity | OpenAPI codegen |
| Real-time | SSE | Simple, unidirectional | WebSocket for bidirectional |
| Validation | Zod (shared) | Bundle size | Separate validation |
| Error format | Structured JSON | Verbose | Simple message strings |
| Optimistic updates | Client-side | Rollback complexity | Wait for server |

### Full-Stack Type Safety Spectrum

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Type Safety Spectrum                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Loose         Zod Schemas        OpenAPI        GraphQL            │
│  ◄─────────────────────────────────────────────────────────────────►│
│                                                                      │
│  - Fastest dev      (CHOSEN)      - API docs      - Schema          │
│  - More bugs        - Balance     - Codegen       - Tooling         │
│  - No codegen       - Manual sync - More setup    - Complex         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Monitoring and Observability (2 minutes)

### Full-Stack Metrics

**Backend (Prometheus):**
- `youtube_topk_views_total` - Counter with labels: category, duplicate
- `youtube_topk_sse_clients` - Gauge of connected clients
- `youtube_topk_api_latency_seconds` - Histogram with labels: endpoint, method, status

**Frontend (Web Vitals):**
- CLS (Cumulative Layout Shift)
- FID (First Input Delay)
- LCP (Largest Contentful Paint)
- Sent to `/api/metrics` via sendBeacon

### Request Tracing

Shared trace ID flow:
1. Frontend generates `X-Trace-ID` header (crypto.randomUUID)
2. Backend extracts or generates if missing
3. Backend sets response header for correlation
4. Logs include trace ID for debugging

---

## Closing Summary (1 minute)

"The YouTube Top K system demonstrates full-stack integration through three key patterns:

1. **Shared type system** - A monorepo package with TypeScript types and Zod schemas ensures frontend and backend stay in sync. Validation logic runs on both sides, catching errors early.

2. **End-to-end view flow** - When a user clicks play, the frontend makes an optimistic update while sending an idempotent request to the backend. The backend validates, deduplicates, and records the view in Redis, with the result propagating back via SSE.

3. **Robust real-time pipeline** - SSE provides simple server-to-client push with automatic reconnection. The backend's TrendingService computes Top K every 5 seconds and broadcasts to all connected clients.

The main trade-off is development velocity vs. type safety. The shared package adds build complexity but catches integration bugs at compile time. For future improvements, I'd add GraphQL for more flexible queries, implement request deduplication at the edge, and add distributed tracing for debugging production issues."

# Apple Music - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement (1 minute)

"I'll design Apple Music as a fullstack system, focusing on the end-to-end flows that connect the React frontend to the backend services. The key technical challenges span both layers: adaptive streaming with quality negotiation between client and server, library synchronization that handles offline changes with conflict resolution, and personalized recommendations that update dynamically as users listen.

For a music streaming platform, I'll demonstrate how frontend state management coordinates with backend APIs to deliver gapless playback, instant library updates through optimistic UI, and real-time sync across devices."

---

## Requirements Clarification (3 minutes)

### Functional Requirements (End-to-End)
- **Streaming**: Quality negotiation, gapless transitions, network adaptation
- **Library Sync**: Add/remove with optimistic UI, cross-device synchronization
- **Search**: Instant autocomplete with backend catalog queries
- **Recommendations**: Personalized sections updated by listening behavior
- **Playlists**: CRUD with collaborative editing support

### Non-Functional Requirements
- **E2E Latency**: < 200ms for stream start (URL fetch + buffer)
- **Sync Consistency**: Library changes visible across devices in < 5 seconds
- **Offline Resilience**: Queue changes locally, sync on reconnect
- **Error Recovery**: Graceful degradation with retry mechanisms

### Integration Points
- Frontend audio player with backend stream URL generation
- Library store with delta sync API
- Search UI with catalog search endpoint
- Recommendation cards with personalization API

---

## System Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Frontend (React)                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │    Player    │  │    Library   │  │    Search    │  │   Discovery  │     │
│  │    Store     │  │    Store     │  │      UI      │  │    Cards     │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                 │                 │              │
│         └─────────────────┴─────────────────┴─────────────────┘              │
│                                    │                                         │
│                            TanStack Query                                    │
│                                    │                                         │
└────────────────────────────────────┼─────────────────────────────────────────┘
                                     │ HTTP/REST
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Backend (Express)                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Streaming  │  │    Library   │  │    Catalog   │  │   Discovery  │     │
│  │    Routes    │  │    Routes    │  │    Routes    │  │    Routes    │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                 │                 │              │
│  ┌──────┴─────────────────┴─────────────────┴─────────────────┴──────┐      │
│  │                        Shared Services                             │      │
│  │      Auth  │  Rate Limit  │  Cache  │  Metrics  │  Logger         │      │
│  └────────────────────────────────────────────────────────────────────┘      │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     │
                  ┌──────────────────┼──────────────────┐
                  │                  │                  │
           ┌──────┴──────┐    ┌──────┴──────┐    ┌──────┴──────┐
           │ PostgreSQL  │    │    Redis    │    │    MinIO    │
           │  (catalog,  │    │  (sessions, │    │   (audio,   │
           │   library)  │    │    cache)   │    │   artwork)  │
           └─────────────┘    └─────────────┘    └─────────────┘
```

---

## Deep Dive: Streaming Flow (8 minutes)

### End-to-End Sequence

```
┌──────────┐      ┌──────────┐      ┌───────────┐      ┌──────────┐      ┌──────────┐
│ Frontend │      │   API    │      │ Streaming │      │  MinIO   │      │   CDN    │
│  Player  │      │ Gateway  │      │  Service  │      │          │      │          │
└────┬─────┘      └────┬─────┘      └─────┬─────┘      └────┬─────┘      └────┬─────┘
     │                 │                  │                 │                 │
     │ GET /stream/    │                  │                 │                 │
     │   {trackId}     │                  │                 │                 │
     ├────────────────▶│                  │                 │                 │
     │                 │ Forward +        │                 │                 │
     │                 │ auth context     │                 │                 │
     │                 ├─────────────────▶│                 │                 │
     │                 │                  │ Check sub,      │                 │
     │                 │                  │ select quality  │                 │
     │                 │                  ├─────────────────┤                 │
     │                 │                  │                 │                 │
     │                 │                  │ Generate        │                 │
     │                 │                  │ signed URL      │                 │
     │                 │                  ├────────────────▶│                 │
     │                 │                  │                 │ presignedUrl    │
     │                 │                  │◀────────────────┤                 │
     │ {url, quality}  │                  │                 │                 │
     │◀────────────────┼──────────────────┤                 │                 │
     │                 │                  │                 │                 │
     │ Fetch audio     │                  │                 │                 │
     ├─────────────────┼──────────────────┼─────────────────┼────────────────▶│
     │                 │                  │                 │                 │
     │ Audio stream    │                  │                 │                 │
     │◀────────────────┼──────────────────┼─────────────────┼─────────────────┤
     │                 │                  │                 │                 │
```

### Frontend: Audio Player with Quality Selection

The streaming player hook manages audio playback with quality-aware URL fetching:

```
┌─────────────────────────────────────────────────────────────────────┐
│                       useStreamPlayer Hook                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────┐           ┌──────────────────┐                │
│  │   audioRef       │           │   nextAudioRef   │                │
│  │   (current)      │           │   (preloaded)    │                │
│  └────────┬─────────┘           └────────┬─────────┘                │
│           │                              │                           │
│           └────────────┬─────────────────┘                          │
│                        │                                             │
│  ┌─────────────────────┴──────────────────────────────────────┐     │
│  │                    Player Store                             │     │
│  │  currentTrack │ isPlaying │ queue │ queueIndex             │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  Workflow:                                                           │
│  1. useQuery fetches /stream/{trackId} with network headers          │
│  2. Load audio when stream URL received                              │
│  3. Prefetch next track for gapless playback                        │
│  4. On track end, swap refs for seamless transition                 │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Behaviors:**
- Sends X-Network-Type header (wifi, 4g, 3g) for quality negotiation
- Sends X-Preferred-Quality header from localStorage
- 30-minute staleTime prevents re-fetching recently played tracks
- Prefetches next track in queue via queryClient.prefetchQuery

### Backend: Streaming Service

The streaming endpoint selects quality based on subscription and network:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     GET /stream/:trackId                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Extract user context:                                           │
│     ┌────────────────────────────────────────────────────────┐      │
│     │ userId from session                                     │      │
│     │ networkType from X-Network-Type header                  │      │
│     │ preferredQuality from X-Preferred-Quality header        │      │
│     └────────────────────────────────────────────────────────┘      │
│                                                                      │
│  2. Get subscription tier ──▶ determines maxQuality                 │
│                                                                      │
│  3. Select quality = min(preferred, maxForTier, maxForNetwork)      │
│                                                                      │
│     ┌──────────────────────────────────────────────────────┐        │
│     │  Quality Ladder:                                      │        │
│     │  256_aac ──▶ lossless ──▶ hi_res_lossless            │        │
│     │                                                       │        │
│     │  Network Max:                                         │        │
│     │  wifi: hi_res_lossless │ 5g: lossless                │        │
│     │  4g: 256_aac           │ 3g: 256_aac                 │        │
│     └──────────────────────────────────────────────────────┘        │
│                                                                      │
│  4. Query audio_files for track + quality                           │
│                                                                      │
│  5. Generate presigned URL (1 hour expiry) from MinIO               │
│                                                                      │
│  6. Record metrics and return:                                      │
│     { url, quality, format, bitrate, expiresAt }                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Library Sync Flow (8 minutes)

### End-to-End Sync Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Device A                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                          Library Store                                 │  │
│  │   syncToken: 42  │  tracks: [...]  │  pendingChanges: []              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                        │
│                           User adds track                                    │
│                                     │                                        │
│                            ┌────────┴────────┐                              │
│                            │ Optimistic      │                              │
│                            │ Update UI       │                              │
│                            └────────┬────────┘                              │
│                                     │                                        │
└─────────────────────────────────────┼────────────────────────────────────────┘
                                      │ POST /library
                                      ▼
                         ┌─────────────────────────┐
                         │      Backend API        │
                         │                         │
                         │  Transaction:           │
                         │  1. Insert library_item │
                         │  2. Insert sync_change  │
                         │  3. Notify devices      │
                         └────────────┬────────────┘
                                      │
               ┌──────────────────────┼──────────────────────┐
               │                      │                      │
               ▼                      ▼                      ▼
        ┌────────────┐         ┌────────────┐         ┌────────────┐
        │ PostgreSQL │         │   Redis    │         │    Push    │
        │            │         │   (cache   │         │  Service   │
        │ library_   │         │  invalidate)│        │            │
        │ changes    │         │            │         │            │
        └────────────┘         └────────────┘         └─────┬──────┘
                                                            │
                                      ┌─────────────────────┘
                                      │ Push notification
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Device B                                       │
│                                     │                                        │
│                            ┌────────┴────────┐                              │
│                            │ Receive push    │                              │
│                            │ "library_changed"│                             │
│                            └────────┬────────┘                              │
│                                     │                                        │
│                            ┌────────┴────────┐                              │
│                            │ GET /library/   │                              │
│                            │ sync?token=35   │                              │
│                            └────────┬────────┘                              │
│                                     │                                        │
│                            ┌────────┴────────┐                              │
│                            │ Apply delta     │                              │
│                            │ changes to UI   │                              │
│                            └─────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Library Store with Optimistic Updates

The library store uses Zustand with persistence for offline resilience:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LibraryState                                  │
├─────────────────────────────────────────────────────────────────────┤
│  tracks: Track[]                                                     │
│  albums: Album[]                                                     │
│  syncToken: number | null                                           │
│  isSyncing: boolean                                                 │
│  pendingChanges: LibraryChange[]                                    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     addToLibrary Flow                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Generate optimisticId                                           │
│  2. Optimistic update: add item with _optimistic: true              │
│  3. Add to pendingChanges                                           │
│  4. POST to backend                                                 │
│       │                                                              │
│       ├──▶ Success: remove _optimistic flag, update syncToken       │
│       │                                                              │
│       └──▶ Failure: rollback item, remove from pendingChanges       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     syncLibrary Flow                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Guard: Skip if pendingChanges.length > 0                           │
│                                                                      │
│  1. GET /library/sync?syncToken={current}                           │
│  2. For each change:                                                │
│     ├──▶ add + track: push to tracks (if not duplicate)            │
│     ├──▶ add + album: push to albums (if not duplicate)            │
│     ├──▶ remove + track: filter out from tracks                    │
│     └──▶ remove + album: filter out from albums                    │
│  3. Update syncToken from response                                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Visibility Change Sync**: useLibrarySync hook triggers sync when tab becomes visible.

### Backend: Library Sync Endpoint

**POST /library** - Add to library:
1. Transaction: INSERT library_item (idempotent via ON CONFLICT)
2. Transaction: INSERT library_change with nextval sync_token
3. Invalidate Redis cache
4. Push notification to other devices
5. Return new syncToken

**GET /library/sync?syncToken=N** - Delta sync:
1. Query library_changes WHERE sync_token > N
2. JOIN with tracks/albums to get full item data
3. Return changes array + current max syncToken + hasMore flag

---

## Deep Dive: Recommendation Flow (5 minutes)

### Frontend: For You Page

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ForYouPage                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  useQuery(['forYou'], staleTime: 5 min)                             │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────┐      │
│  │                    Section Layout                          │      │
│  ├───────────────────────────────────────────────────────────┤      │
│  │  type: 'albums'   ──▶  Grid of AlbumCard components       │      │
│  │  type: 'playlist' ──▶  PlaylistRow horizontal scroll      │      │
│  │  type: 'songs'    ──▶  TrackList vertical list            │      │
│  └───────────────────────────────────────────────────────────┘      │
│                                                                      │
│  Loading state: ForYouSkeleton                                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Backend: Recommendation Engine

**GET /discover/for-you** generates personalized sections:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Recommendation Sections                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Heavy Rotation                                                  │
│     ├──▶ Query listening_history last 14 days                      │
│     ├──▶ Group by album, count plays                                │
│     └──▶ Return top 10 most played albums                          │
│                                                                      │
│  2. Genre Mixes (for top 3 genres)                                  │
│     ├──▶ Query track_genres from listening_history (30 days)       │
│     ├──▶ For each genre:                                            │
│     │    └──▶ Find tracks not played in 7 days                     │
│     │    └──▶ Sort by global play_count                            │
│     └──▶ Return 25 tracks per genre                                │
│                                                                      │
│  3. New Releases                                                    │
│     ├──▶ Find artists from user's library                          │
│     ├──▶ Query albums released in last 30 days                     │
│     └──▶ Return up to 10 new releases                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Error Handling and Recovery (3 minutes)

### Frontend: Retry with Exponential Backoff

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Axios Retry Interceptor                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  On response error:                                                 │
│                                                                      │
│  1. Check retry count < 3                                           │
│  2. Only retry if:                                                  │
│     ├──▶ No response (network error)                                │
│     └──▶ Status >= 500 (server error)                               │
│  3. Wait with exponential backoff: 1s, 2s, 4s                       │
│  4. Retry request                                                   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Backend: Circuit Breaker for External Services

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MinIO Circuit Breaker                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Configuration:                                                      │
│  ├──▶ timeout: 5000ms                                               │
│  ├──▶ errorThresholdPercentage: 50                                  │
│  └──▶ resetTimeout: 30000ms                                         │
│                                                                      │
│  States:                                                            │
│  ├──▶ CLOSED: normal operation                                      │
│  ├──▶ OPEN: all requests fail fast, fallback to cache              │
│  └──▶ HALF-OPEN: test request, close if success                    │
│                                                                      │
│  Fallback: Return cached presigned URL if available                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen Approach | Alternative | Rationale |
|----------|-----------------|-------------|-----------|
| Data Fetching | TanStack Query | Redux Toolkit Query | Better cache control, simpler setup |
| Optimistic Updates | Zustand + rollback | Server-first | Instant feedback, better UX |
| Sync Strategy | Delta with tokens | Full refresh | Bandwidth efficient |
| Audio Delivery | Presigned URLs | Proxy streaming | CDN offload, simpler backend |
| Quality Selection | Server decides | Client decides | Subscription enforcement |
| Session Storage | Redis | JWT | Instant revocation |

### Why Optimistic Updates with Rollback

1. **Instant Feedback**: User sees change immediately (< 50ms)
2. **Network Resilient**: Works on slow connections
3. **Rollback Safety**: Revert on failure with user notification
4. **Trade-off**: Complexity in handling conflicts

### Why Server-Side Quality Selection

"The server determines streaming quality because:
- **Subscription Enforcement**: Only premium users get lossless
- **Fraud Prevention**: Client can't lie about network type
- **Trade-off**: Extra round-trip for quality info"

---

## Observability (3 minutes)

### End-to-End Request Tracing

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Tracing Middleware                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Get or generate X-Request-Id                                    │
│  2. Attach to request for logging                                   │
│  3. Add to response headers                                         │
│  4. Create child logger with { requestId, userId }                  │
│  5. Log request start with method, path, query                      │
│  6. On finish: log statusCode, durationMs                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Frontend Error Boundary with Reporting

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ErrorBoundary Component                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  getDerivedStateFromError: Set hasError = true                      │
│                                                                      │
│  componentDidCatch:                                                 │
│  ├──▶ POST /errors with:                                            │
│  │    message, stack, componentStack, url, userAgent                │
│  └──▶ Fire and forget (don't fail on reporting failure)            │
│                                                                      │
│  Render fallback: "Something went wrong" + Reload button            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Closing Summary (1 minute)

"Apple Music as a fullstack system is built around three key end-to-end flows:

1. **Streaming Flow** - The frontend requests a stream URL with network context, the backend selects quality based on subscription and network, generates a presigned CDN URL, and the frontend prefetches the next track for gapless transitions.

2. **Library Sync Flow** - Optimistic updates give instant feedback, the backend records changes with monotonically increasing sync tokens, and other devices receive push notifications to trigger delta sync.

3. **Recommendation Flow** - The backend aggregates listening history into personalized sections, the frontend caches results with TanStack Query, and stale-while-revalidate keeps recommendations fresh without blocking.

The main fullstack trade-off is between consistency and responsiveness. We choose optimistic updates with rollback for library operations to maximize perceived speed, while sync tokens ensure eventual consistency across all devices."

---

## Future Enhancements

1. **Real-time Sync** - WebSocket connections for instant library updates without push
2. **Collaborative Playlists** - Operational transformation for concurrent edits
3. **Offline Downloads** - Service worker with IndexedDB for cached audio files
4. **Audio Fingerprinting** - Upload matching to catalog tracks
5. **Social Features** - Friend activity feed with listening history

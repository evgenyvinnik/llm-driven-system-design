# YouTube - Video Platform - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement

"I'll be designing a fullstack video hosting and streaming platform like YouTube. This is a comprehensive challenge that requires tight integration between frontend and backend: chunked uploads with real-time progress, HLS streaming with adaptive bitrate, transcoding status notifications, and synchronized engagement features. I'll focus on the end-to-end data flow, shared type contracts, and how frontend and backend coordinate for each major feature. Let me start by scoping the problem."

---

## 📋 1. Requirements Clarification (3-4 minutes)

### End-to-End User Flows

1. **Video Upload and Processing**
   - Chunked upload with progress tracking
   - Backend transcoding pipeline
   - Real-time status updates to frontend
   - Metadata form with validation

2. **Video Playback**
   - HLS manifest delivery
   - Adaptive bitrate streaming
   - Watch progress sync (resume playback)
   - View count recording

3. **Engagement Features**
   - Like/dislike with counter sync
   - Comments with threading
   - Subscribe with notification preferences

4. **Discovery and Recommendations**
   - Personalized home feed
   - Search with filtering
   - Trending algorithm

### Integration Requirements

- **Type Safety**: Shared types between frontend and backend
- **Real-time Updates**: SSE/WebSocket for transcoding status
- **Optimistic UI**: Immediate feedback with rollback on error
- **Validation**: Zod schemas shared across stack

---

## 🏗️ 2. System Architecture Overview (5-6 minutes)

### Fullstack Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            FRONTEND (React)                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │
│  │   Routes    │    │ Components  │    │   Hooks     │    │   Store     │   │
│  ├─────────────┤    ├─────────────┤    ├─────────────┤    ├─────────────┤   │
│  │ / (Home)    │    │ VideoPlayer │    │ useChunked  │    │ playerStore │   │
│  │ /watch/:id  │    │   (HLS.js)  │    │   Upload    │    │             │   │
│  │ /upload     │    │ UploadForm  │    │ useTranscode│    │ uploadStore │   │
│  │ /channel    │    │ Comments    │    │   Status    │    │             │   │
│  │ /search     │    │ LikeDislike │    │             │    │ authStore   │   │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘   │
│         │                  │                  │                  │          │
│         └──────────────────┴──────────────────┴──────────────────┘          │
│                                    │                                         │
│                            ┌───────▼───────┐                                 │
│                            │  API Service  │                                 │
│                            │  (fetch/SSE)  │                                 │
│                            └───────┬───────┘                                 │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │ HTTP + SSE
                     ┌───────────────┴───────────────┐
                     │                               │
┌────────────────────▼───────────────────────────────▼────────────────────────┐
│                            BACKEND (Node.js)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐      │
│  │   API Gateway   │      │    Services     │      │    Workers      │      │
│  │    (Express)    │      │                 │      │                 │      │
│  ├─────────────────┤      ├─────────────────┤      ├─────────────────┤      │
│  │ /api/v1/uploads │─────►│ UploadService   │      │ TranscodeWorker │      │
│  │ /api/v1/videos  │─────►│ VideoService    │◄────►│   (RabbitMQ)    │      │
│  │ /api/v1/comments│─────►│ CommentService  │      └────────┬────────┘      │
│  │ /api/v1/channels│─────►│ ChannelService  │               │               │
│  │ /api/v1/auth    │─────►│ AuthService     │               │               │
│  │ /api/v1/sse     │─────►│ SSEService      │◄──────────────┘               │
│  └────────┬────────┘      └────────┬────────┘                               │
│           │                        │                                         │
│           └────────────────────────┘                                         │
│                      │                                                       │
│      ┌───────────────┼───────────────┬───────────────┐                      │
│      │               │               │               │                      │
│  ┌───▼───┐       ┌───▼───┐       ┌───▼───┐       ┌───▼───┐                  │
│  │Postgre│       │ Redis │       │ MinIO │       │Rabbit │                  │
│  │  SQL  │       │(cache)│       │(video)│       │  MQ   │                  │
│  └───────┘       └───────┘       └───────┘       └───────┘                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                       SHARED (packages/shared)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│  types/           schemas/           constants/         utils/               │
│  ├─ video.ts      ├─ upload.ts       ├─ limits.ts       ├─ formatters.ts    │
│  ├─ user.ts       ├─ video.ts        ├─ mimeTypes.ts    └─ validators.ts    │
│  ├─ comment.ts    └─ comment.ts      └─ resolutions.ts                       │
│  └─ api.ts                                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔍 3. Shared Types and Validation (3-4 minutes)

"The key fullstack insight is sharing types, validation schemas, and constants across frontend and backend. We use a monorepo with a shared package."

### Core Shared Types

| Type | Key Fields | Purpose |
|------|-----------|---------|
| Video | id, channelId, title, status, visibility, viewCount, likeCount, thumbnailUrl | Core entity, status drives UI states |
| VideoWithChannel | ...Video + channel { name, handle, avatarUrl, subscriberCount } | Denormalized for display |
| VideoResolutionInfo | videoId, resolution, manifestUrl, bitrate, width, height | HLS quality selection |
| UploadSession | id, filename, fileSize, totalChunks, uploadedChunks, status, expiresAt | Tracks chunked upload state |
| ApiResponse\<T\> | data, error (code + message), meta (pagination) | Uniform API envelope |

**Status enums:** VideoStatus flows through `uploading → processing → ready | failed | blocked`. Visibility is `public | unlisted | private`. Resolutions: `1080p | 720p | 480p | 360p`.

### Shared Validation (Zod)

Zod schemas are defined once and used for both frontend form validation and backend API validation:

- **uploadInitSchema**: filename (1-255 chars), fileSize (max 5GB), mimeType (mp4, webm, quicktime, avi, mkv)
- **uploadCompleteSchema**: title (1-100 chars), description (max 5000), tags (max 30), categories (max 5), visibility
- **commentCreateSchema**: text (1-10000 chars), optional parentId (UUID for threading)

**Key constants**: MAX_FILE_SIZE = 5GB, CHUNK_SIZE = 5MB, MAX_CONCURRENT_CHUNKS = 3, UPLOAD_EXPIRY = 24h. Resolution ladder: 1080p (5 Mbps) → 720p (2.5) → 480p (1) → 360p (0.5).

**SSE event types** for transcoding: `transcode.started`, `transcode.progress` (per-resolution 0-100%), `transcode.completed`, `transcode.failed`.

---

## 🚀 4. Deep Dive: Chunked Upload Flow (10-12 minutes)

### Upload Flow Sequence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CHUNKED UPLOAD FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  FRONTEND                    BACKEND                    STORAGE              │
│     │                           │                          │                 │
│     │  1. POST /init            │                          │                 │
│     │  { filename, size, type } │                          │                 │
│     │──────────────────────────►│                          │                 │
│     │                           │  CreateMultipartUpload   │                 │
│     │                           │─────────────────────────►│ MinIO           │
│     │                           │                          │ raw-videos      │
│     │                           │◄─────────────────────────│ bucket          │
│     │  { uploadId, totalChunks }│                          │                 │
│     │◄──────────────────────────│                          │                 │
│     │                           │                          │                 │
│     │  2. PUT /chunks/:n        │                          │                 │
│     │  [binary data]            │  UploadPart              │                 │
│     │──────────────────────────►│─────────────────────────►│                 │
│     │  { etag }                 │◄─────────────────────────│                 │
│     │◄──────────────────────────│                          │                 │
│     │     (repeat for all chunks, 3 concurrent)            │                 │
│     │                           │                          │                 │
│     │  3. POST /complete        │                          │                 │
│     │  { title, description }   │  CompleteMultipartUpload │                 │
│     │──────────────────────────►│─────────────────────────►│                 │
│     │                           │                          │                 │
│     │                           │  Create video record     │                 │
│     │                           │  Queue transcode job     │                 │
│     │  { videoId, status }      │                          │                 │
│     │◄──────────────────────────│                          │                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend Upload Service

The backend exposes three operations:

- **initializeUpload(userId, input)**: Validates via uploadInitSchema, generates uploadId, calculates totalChunks (fileSize / CHUNK_SIZE), creates S3 multipart upload in raw-videos bucket, persists session in PostgreSQL, and caches S3 keys + chunk tracking in Redis (HSET). Returns UploadSession.

- **uploadChunk(uploadId, chunkNumber, data)**: Validates session is active, retrieves S3 info from Redis (HGETALL), uploads part to S3, and atomically updates Redis (MULTI: HSET etag, HINCRBY completedChunks). Returns { etag }.

- **completeUpload(userId, uploadId, input)**: Validates with uploadCompleteSchema, verifies completedChunks == totalChunks, assembles ETags sorted by part number, completes S3 multipart upload, then in a PostgreSQL transaction: INSERTs video record and UPDATEs session status. Queues transcode job to RabbitMQ. Cleans up Redis. Returns { videoId, status: 'processing' }.

"The key design choice is using Redis for chunk tracking rather than PostgreSQL. Each chunk upload would otherwise require a PostgreSQL write, and with 3 concurrent chunks for potentially thousands of simultaneous uploaders, that's significant write pressure. Redis handles these ephemeral counters much more efficiently."

### Frontend Upload Hook (useChunkedUpload)

The hook manages a state machine: `idle → initializing → uploading → completing → done | error`. It slices the file into 5MB chunks and uploads them in parallel with a concurrency pool of 3. Each chunk is PUT to `/chunks/:n` with binary data. An AbortController enables cancellation. On completion, it POSTs metadata (title, description, tags) and returns the videoId. The hook exposes `{ progress, uploadFile, cancel }`.

### Upload API

```
POST /api/v1/uploads/init             → Creates session, returns totalChunks (rate: 5/min)
PUT  /api/v1/uploads/:id/chunks/:n    → Uploads binary chunk, returns etag (rate: 100/min)
POST /api/v1/uploads/:id/complete     → Finalizes upload with metadata, returns videoId
```

---

## 📊 5. Deep Dive: Video Playback Integration (8-10 minutes)

### Backend Streaming Service

**getVideoForPlayback(videoId, userId?)** checks Redis cache first (5-min TTL), falls back to a JOIN query on videos + users. Resolution info is cached for 1 hour. If the user is authenticated, we also fetch their resume position from watch_history.

**recordView** uses Redis INCR for fast view counting (flushed to PostgreSQL periodically). **updateWatchProgress** UPSERTs watch_history every 30 seconds and on page unload, tracking last position, total watch duration, and percentage.

### Watch Page Layout

```
┌───────────────────────────────────────────────────────────────────┐
│                         WatchPage                                  │
│  ┌────────────────────────────┐  ┌─────────────────────────────┐  │
│  │       Main Content         │  │   Recommendations Sidebar   │  │
│  │  ┌──────────────────────┐  │  │                             │  │
│  │  │    VideoPlayer       │  │  │   Based on currentVideoId   │  │
│  │  │    (HLS.js)          │  │  │   and categories            │  │
│  │  └──────────────────────┘  │  │                             │  │
│  │  ┌──────────────────────┐  │  │                             │  │
│  │  │ VideoInfo + Comments │  │  │                             │  │
│  │  └──────────────────────┘  │  │                             │  │
│  └────────────────────────────┘  └─────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

Data fetching: useQuery for video + resolutions + resumePosition, useMutation for recordView (on mount) and updateProgress (every 30s + unmount).

### HLS Player Integration

The VideoPlayer component detects Safari (native HLS support) vs other browsers (HLS.js polyfill). HLS.js is initialized with `enableWorker: true`, `startLevel: -1` (auto quality), and `capLevelToPlayerSize: true`. On MANIFEST_PARSED, we extract quality levels for a selector UI. Fatal errors trigger recovery: NETWORK_ERROR restarts loading, MEDIA_ERROR calls recoverMediaError, and unrecoverable errors destroy the instance. Quality changes set `hls.currentLevel` (-1 = auto). Progress is tracked via the `timeupdate` event and forwarded to the parent for watch history sync.

---

## 🔍 6. Deep Dive: SSE for Transcoding Status (6-8 minutes)

### Backend SSE Service

The SSE service maintains a `Map<clientId, SSEClient>` where each client holds a userId, Express response, and a `Set<videoId>` for subscriptions. On connection, it sets SSE headers (text/event-stream, no-cache, keep-alive), flushes headers, sends a `connected` event, and starts a 30-second keep-alive ping. Clients subscribe to specific videos via POST, and `sendToVideo(videoId, event)` iterates all clients with that videoId in their set. Cleanup happens on connection close.

### Transcode Worker Flow

```
┌───────────────────────────────────────────────────────────────────┐
│                    TRANSCODE WORKER                                │
│                                                                    │
│  1. SSE → transcode.started { videoId, resolutions }               │
│                                                                    │
│  2. For each resolution (1080p → 720p → 480p → 360p):             │
│     - Transcode with progress callback                             │
│     - SSE → transcode.progress { videoId, resolution, 0-100% }     │
│     - Save resolution info to DB                                   │
│     - On error: SSE → transcode.failed, abort                      │
│                                                                    │
│  3. Generate thumbnails → thumbnailUrl                             │
│  4. Update video status to 'ready'                                 │
│  5. SSE → transcode.completed { resolutions, thumbnailUrl }        │
└───────────────────────────────────────────────────────────────────┘
```

### Frontend SSE Hook (useTranscodeStatus)

The hook opens an EventSource to `/api/v1/sse/events` with credentials. On `connected`, it stores the clientId and POSTs to subscribe to the target videoId. It tracks status (`pending → transcoding → completed | failed`) and per-resolution progress (e.g., `{ '1080p': 45, '720p': 100, '480p': 100, '360p': 100 }`). On error, it reconnects after 5 seconds. The EventSource is closed on unmount or completion. Returns `{ status, progress }`.

---

## 📝 7. Error Handling Across Stack (3-4 minutes)

"Error codes are shared between frontend and backend to ensure consistent handling. The key categories are: validation (VALIDATION_ERROR, INVALID_INPUT), auth (UNAUTHORIZED, FORBIDDEN, SESSION_EXPIRED), resources (NOT_FOUND, VIDEO_NOT_FOUND), upload-specific (UPLOAD_EXPIRED, FILE_TOO_LARGE, UNSUPPORTED_FORMAT), RATE_LIMITED, and INTERNAL_ERROR."

**Backend**: An ApiError base class carries code, message, statusCode, and details. The error middleware catches ZodErrors (→ 400 with field-level issues), ApiErrors (→ appropriate status), and unknown errors (→ 500 with generic message). This ensures the frontend always receives the uniform `{ data, error, meta }` envelope.

**Frontend**: A `fetchApi<T>` wrapper parses every response as ApiResponse\<T\>. SESSION_EXPIRED triggers a redirect to /login; other errors throw for component-level handling. A React ErrorBoundary catches render errors and shows a fallback UI with a refresh button.

---

## ⚖️ 8. Trade-offs and Alternatives (3-4 minutes)

### Chunked Upload vs Direct Upload

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Chunked multipart upload | Resumable, progress tracking, handles large files | More complex frontend/backend coordination |
| ❌ Single PUT upload | Simple implementation | No resume on failure, browser memory issues for large files, no progress granularity |

"I'm choosing chunked uploads because a 2GB video file on a flaky mobile connection would fail frequently with a single PUT. With 5MB chunks, a network interruption only loses the current chunk — the frontend can resume from where it left off. The concurrency pool of 3 maximizes throughput without overwhelming the browser's connection limit. The trade-off is coordination complexity: we need Redis to track chunk ETags and an expiry mechanism for abandoned uploads. But for a video platform where upload reliability directly impacts creator retention, this complexity is justified."

### SSE vs WebSocket for Transcoding Status

| Approach | Pros | Cons |
|----------|------|------|
| ✅ SSE | Simple, auto-reconnect, HTTP/2 multiplexing | Unidirectional only |
| ❌ WebSocket | Bidirectional, lower latency | Connection management complexity, no auto-reconnect |
| ❌ Polling | Simplest to implement | Wasteful at scale, 500ms average latency |

"Transcoding status is a purely server-to-client flow — the worker emits progress, the frontend displays it. SSE is purpose-built for this: the EventSource API handles reconnection automatically, and SSE connections multiplex over HTTP/2 without the separate TCP connection WebSocket requires. The limitation is that SSE is unidirectional, but we don't need the client to send real-time data during transcoding. If we later add live chat or collaborative editing, WebSocket would be the right choice for those features."

### Shared Type Package Strategy

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Monorepo with shared package | Single source of truth, compile-time safety | Build pipeline complexity |
| ❌ Duplicate types | No build dependency | Drift between frontend and backend |
| ❌ OpenAPI codegen | Auto-generated from spec | Extra tooling, spec maintenance burden |

"The shared package approach catches integration bugs at compile time rather than runtime. When a backend developer adds a field to the Video type, the frontend immediately sees it. Duplicate types drift silently — we shipped a bug at a previous company where the backend renamed a field but the frontend kept using the old name, and it wasn't caught for two weeks. The build complexity is real but manageable with turborepo's caching."

### Validation Strategy

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Zod (shared schemas) | Runtime validation + TypeScript inference from one definition | ~13KB bundle size |
| ❌ Manual validation | Zero dependencies | Error-prone, no type inference, rules diverge |

"Zod schemas serve double duty: frontend form validation (showing inline errors before submission) and backend API validation (rejecting malformed requests). A single schema like uploadCompleteSchema enforces title length limits identically in both places. The bundle cost is acceptable — Zod tree-shakes well and the alternative is duplicated validation logic that inevitably drifts."

### View Counting Strategy

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Redis INCR + periodic flush | Fast writes, handles spikes | Slightly stale counts |
| ❌ Direct PostgreSQL UPDATE | Always accurate | Row-level lock contention on viral videos |

"A viral video might get 10,000 views per second. Direct PostgreSQL UPDATEs would serialize on the row lock, creating a bottleneck that slows down the entire watch experience. Redis INCR is O(1) and atomic — we buffer counts and flush to PostgreSQL every 30 seconds. The trade-off is that view counts lag by up to 30 seconds, but users don't notice a difference between '1,234,567' and '1,234,600' views."

---

## 📈 9. Scaling Considerations (2-3 minutes)

**What breaks first at scale:**

1. **Upload throughput**: Each upload session holds an S3 multipart in progress. At 10K concurrent uploads, the API servers need enough memory for chunk buffering. Solution: stream chunks directly to S3 without buffering the full chunk in memory, and use a load balancer to distribute across upload service instances.

2. **Transcoding bottleneck**: Transcoding is CPU-intensive. A single worker processes one video at a time across 4 resolutions. Solution: horizontal scaling of transcode workers consuming from RabbitMQ, with prefetch=1 so each worker pulls one job at a time. At YouTube scale, this becomes a distributed job scheduling problem with priority queues (paid creators get faster processing).

3. **SSE connection limits**: Each connected browser holds an open HTTP connection. At 100K concurrent users watching transcoding progress, that's 100K persistent connections on the SSE service. Solution: separate SSE into its own service behind a load balancer with sticky sessions, or switch to Redis Pub/Sub to fan out events across SSE instances.

4. **View count hotspots**: Viral videos concentrate writes on a single Redis key. Solution: sharded counters (INCR on views:{videoId}:{shard}, sum on read) to distribute write load across Redis nodes.

---

## 📋 10. Summary

The YouTube fullstack architecture focuses on:

1. **Shared Type Package**: Single source of truth for TypeScript types, Zod schemas, and constants used across frontend and backend

2. **Chunked Upload Pipeline**: Frontend hook with concurrent chunk uploads, backend S3 multipart handling, and real-time progress tracking

3. **HLS Video Integration**: Backend manifest delivery coordinated with frontend HLS.js player, including resume position sync via watch history

4. **SSE for Transcoding Status**: Server-Sent Events push transcoding progress from workers to frontend with automatic reconnection

5. **Unified Error Handling**: Shared error codes with backend middleware and frontend error boundaries for consistent user experience

6. **Optimistic UI Patterns**: Frontend immediately updates UI for engagement actions (like, subscribe) with rollback on API failure

The integration ensures type safety across the stack, real-time feedback for long-running operations, and graceful error handling that maintains a responsive user experience.

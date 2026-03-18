# YouTube - Video Platform - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement

"I'll design a fullstack video platform like YouTube, focusing on the tight frontend-backend integration: chunked uploads with progress, HLS adaptive streaming, real-time transcoding status via SSE, and engagement features with optimistic UI. I'll emphasize shared type contracts and end-to-end data flows."

---

## 📋 1. Requirements Clarification (3-4 minutes)

### End-to-End User Flows

1. **Video Upload and Processing** -- Chunked upload, backend transcoding pipeline, real-time status updates, metadata validation
2. **Video Playback** -- HLS manifest delivery, adaptive bitrate, watch progress sync (resume), view counting
3. **Engagement** -- Like/dislike with counter sync, threaded comments, subscriptions
4. **Discovery** -- Personalized home feed, search with filtering, trending algorithm

### Integration Requirements

- **Type Safety**: Shared types between frontend and backend via monorepo package
- **Real-time Updates**: SSE for transcoding status
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

## 🔍 3. Shared Types and Validation (5-6 minutes)

### Core Type Definitions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           VIDEO TYPES                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Video                          VideoWithChannel                             │
│  ┌─────────────────────────┐    ┌─────────────────────────┐                 │
│  │ id: string (11-char)    │    │ ...Video fields         │                 │
│  │ channelId: string       │    │ channel: {              │                 │
│  │ title: string           │    │   id, name, handle,     │                 │
│  │ description: string?    │    │   avatarUrl,            │                 │
│  │ durationSeconds: number?│    │   subscriberCount       │                 │
│  │ status: VideoStatus     │    │ }                       │                 │
│  │ visibility: Visibility  │    └─────────────────────────┘                 │
│  │ viewCount: number       │                                                │
│  │ likeCount: number       │    VideoResolutionInfo                         │
│  │ dislikeCount: number    │    ┌─────────────────────────┐                 │
│  │ commentCount: number    │    │ videoId: string         │                 │
│  │ categories: string[]    │    │ resolution: Resolution  │                 │
│  │ tags: string[]          │    │ manifestUrl: string     │                 │
│  │ thumbnailUrl: string?   │    │ bitrate: number         │                 │
│  │ publishedAt: string?    │    │ width: number           │                 │
│  │ createdAt: string       │    │ height: number          │                 │
│  └─────────────────────────┘    └─────────────────────────┘                 │
│                                                                              │
│  VideoStatus: 'uploading' | 'processing' | 'ready' | 'failed' | 'blocked'   │
│  Visibility: 'public' | 'unlisted' | 'private'                              │
│  Resolution: '1080p' | '720p' | '480p' | '360p'                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Upload Types

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UPLOAD TYPES                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  UploadSession                  UploadInitRequest                            │
│  ┌─────────────────────────┐    ┌─────────────────────────┐                 │
│  │ id: string              │    │ filename: string        │                 │
│  │ filename: string        │    │ fileSize: number        │                 │
│  │ fileSize: number        │    │ mimeType: string        │                 │
│  │ totalChunks: number     │    └─────────────────────────┘                 │
│  │ uploadedChunks: number  │                                                │
│  │ status: SessionStatus   │    UploadCompleteRequest                       │
│  │ chunkSize: number       │    ┌─────────────────────────┐                 │
│  │ expiresAt: string       │    │ title: string           │                 │
│  └─────────────────────────┘    │ description?: string    │                 │
│                                 │ tags?: string[]         │                 │
│  SessionStatus:                 │ categories?: string[]   │                 │
│  'active' | 'completed'         │ visibility?: Visibility │                 │
│  | 'expired' | 'cancelled'      └─────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### API Response Types

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API TYPES                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ApiResponse<T>                 SSE Events                                   │
│  ┌─────────────────────────┐    ┌─────────────────────────┐                 │
│  │ data: T | null          │    │ transcode.started       │                 │
│  │ error: ApiError | null  │    │ transcode.progress      │                 │
│  │ meta: ApiMeta | null    │    │   └─ videoId, resolution│                 │
│  └─────────────────────────┘    │      progress (0-100)   │                 │
│                                 │ transcode.completed     │                 │
│  ApiError                       │   └─ resolutions[],     │                 │
│  ┌─────────────────────────┐    │      thumbnailUrl,      │                 │
│  │ code: string            │    │      durationSeconds    │                 │
│  │ message: string         │    │ transcode.failed        │                 │
│  │ details?: object        │    └─────────────────────────┘                 │
│  └─────────────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

Key shared constants: MAX_FILE_SIZE 5GB, CHUNK_SIZE 5MB, MAX_CONCURRENT 3 chunks, UPLOAD_EXPIRY 24h. Transcode targets: 1080p (5 Mbps), 720p (2.5 Mbps), 480p (1 Mbps), 360p (500 Kbps). Zod schemas validate uploads (filename, fileSize, mimeType) and metadata (title 1-100 chars, description <=5000, tags max 30) on both frontend and backend.

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

Backend upload service tracks session state in both PostgreSQL (durable) and Redis (fast lookup for chunk progress and ETags). On `completeUpload`, it verifies all chunks are present, calls S3 `CompleteMultipartUpload`, inserts the video record in a transaction, and queues a transcode job to RabbitMQ.

### Frontend Upload Hook

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    useChunkedUpload HOOK                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  State: UploadProgress                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ status: 'idle' | 'initializing' | 'uploading' | 'completing' |      │    │
│  │         'done' | 'error'                                            │    │
│  │ uploadedChunks, totalChunks                                         │    │
│  │ uploadedBytes, totalBytes, percentComplete                          │    │
│  │ videoId?, error?                                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  uploadFile(file, metadata) Flow:                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 1. Create AbortController for cancellation                          │    │
│  │ 2. POST /init → get session with totalChunks                        │    │
│  │ 3. Slice file into chunks (5MB each)                                │    │
│  │ 4. Parallel upload with concurrency pool (max 3)                    │    │
│  │    ┌────────────────────────────────────────────────────────┐       │    │
│  │    │ for each chunk:                                        │       │    │
│  │    │   - Check abort signal                                 │       │    │
│  │    │   - PUT /chunks/:n with binary data                    │       │    │
│  │    │   - Update progress state                              │       │    │
│  │    │   - If pool.length >= 3, await Promise.race(pool)      │       │    │
│  │    └────────────────────────────────────────────────────────┘       │    │
│  │ 5. await Promise.all(pool) for remaining                            │    │
│  │ 6. POST /complete with metadata → get videoId                       │    │
│  │ 7. Return videoId                                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Returns: { progress, uploadFile, cancel }                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

Upload API: `POST /uploads/init` (rate-limited 5/min), `PUT /uploads/:id/chunks/:n` (rate-limited 100/min), `POST /uploads/:id/complete`. All require auth; responses use standard `ApiResponse<T>` wrapper.

---

## 📊 5. Deep Dive: Video Playback Integration (8-10 minutes)

### Streaming Service

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    STREAMING SERVICE OPERATIONS                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  getVideoForPlayback(videoId, userId?)                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 1. Check Redis cache for video:{videoId}                            │    │
│  │ 2. If miss: JOIN videos + users, cache 5 min                        │    │
│  │ 3. Get resolutions from cache or DB (cache 1 hour)                  │    │
│  │ 4. If userId: get resume position from watch_history                │    │
│  │ 5. Return { video, resolutions, resumePosition? }                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  recordView(videoId, userId?)                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 1. Redis INCR views:pending:{videoId}                               │    │
│  │ 2. If userId: INSERT INTO watch_history                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  updateWatchProgress(userId, videoId, position, duration)                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 1. Calculate watch percentage                                       │    │
│  │ 2. UPSERT watch_history with:                                       │    │
│  │    - last_position_seconds = position                               │    │
│  │    - watch_duration = GREATEST(current, position)                   │    │
│  │    - watch_percentage = GREATEST(current, calculated)               │    │
│  │    - watched_at = NOW()                                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

The WatchPage fetches video data with `useQuery(['video', videoId])` returning video metadata, available resolutions, and resume position. It records a view on mount via `useMutation` and syncs watch progress every 30s plus on unmount. Layout is a flex row: main content (VideoPlayer + VideoInfo + CommentSection) with a recommendations sidebar.

### HLS Player Integration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    VIDEO PLAYER (HLS.js)                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Props: videoId, manifestUrl, thumbnailUrl, duration, startPosition,        │
│         onProgress                                                           │
│                                                                              │
│  Initialization:                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Safari (native HLS):                                                │    │
│  │   video.src = manifestUrl                                           │    │
│  │   video.currentTime = startPosition                                 │    │
│  │                                                                     │    │
│  │ Other browsers (HLS.js):                                            │    │
│  │   const hls = new Hls({                                             │    │
│  │     enableWorker: true,                                             │    │
│  │     startLevel: -1,         // Auto quality selection               │    │
│  │     capLevelToPlayerSize: true,                                     │    │
│  │     startPosition           // Resume position                      │    │
│  │   })                                                                │    │
│  │   hls.attachMedia(video)                                            │    │
│  │   hls.loadSource(manifestUrl)                                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  HLS.js Events:                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ MANIFEST_PARSED → Extract quality levels, build selector            │    │
│  │ ERROR (fatal) → NETWORK_ERROR: startLoad(), MEDIA_ERROR:            │    │
│  │                  recoverMediaError(), default: destroy()             │    │
│  │ Quality: hls.currentLevel = index (-1 = auto)                       │    │
│  │ Progress: timeupdate event → onProgress(currentTime)                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔍 6. Deep Dive: SSE for Transcoding Status (6-8 minutes)

### Backend SSE Service

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SSE SERVICE                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Client Management:                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ clients: Map<clientId, SSEClient>                                   │    │
│  │                                                                     │    │
│  │ SSEClient {                                                         │    │
│  │   id: string                                                        │    │
│  │   userId: string                                                    │    │
│  │   res: Express.Response                                             │    │
│  │   videoIds: Set<string>                                             │    │
│  │ }                                                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  addClient(clientId, userId, res)                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 1. Set SSE headers:                                                 │    │
│  │    Content-Type: text/event-stream                                  │    │
│  │    Cache-Control: no-cache                                          │    │
│  │    Connection: keep-alive                                           │    │
│  │ 2. res.flushHeaders()                                               │    │
│  │ 3. Send initial: data: { type: 'connected', clientId }              │    │
│  │ 4. Store client in Map                                              │    │
│  │ 5. res.on('close') → delete from Map                                │    │
│  │ 6. Keep-alive ping every 30s: ": ping\n\n"                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  subscribeToVideo(clientId, videoId)                                         │
│  └─ client.videoIds.add(videoId)                                             │
│                                                                              │
│  sendToVideo(videoId, event)                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ for client of clients.values():                                     │    │
│  │   if client.videoIds.has(videoId):                                  │    │
│  │     res.write(`event: ${event.type}\n`)                             │    │
│  │     res.write(`data: ${JSON.stringify(event)}\n\n`)                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Transcode Worker Integration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TRANSCODE WORKER FLOW                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  processTranscodeJob(job: { videoId, sourceKey, resolutions })               │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  1. SSE → transcode.started { videoId, resolutions }                │    │
│  │                                                                     │    │
│  │  2. For each resolution (1080p, 720p, 480p, 360p):                  │    │
│  │     ┌─────────────────────────────────────────────────────────┐     │    │
│  │     │ a. transcodeResolution(sourceKey, resolution, progress => {│     │    │
│  │     │      SSE → transcode.progress { videoId, resolution,    │     │    │
│  │     │                                 progress: 0-100 }       │     │    │
│  │     │    })                                                   │     │    │
│  │     │ b. saveResolution(videoId, resolution) → resInfo        │     │    │
│  │     │ c. On error: SSE → transcode.failed, throw              │     │    │
│  │     └─────────────────────────────────────────────────────────┘     │    │
│  │                                                                     │    │
│  │  3. generateThumbnails(sourceKey, videoId) → thumbnailUrl           │    │
│  │                                                                     │    │
│  │  4. updateVideoComplete(videoId, resolutions, thumbnailUrl)         │    │
│  │                                                                     │    │
│  │  5. SSE → transcode.completed { videoId, resolutions,               │    │
│  │                                 thumbnailUrl, durationSeconds }     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend SSE Hook

The `useTranscodeStatus` hook takes a `videoId` and manages an `EventSource` connection. On `connected` event, it subscribes to the video's transcode updates via `POST /subscribe/{videoId}`. It tracks per-resolution progress (e.g., `{ '1080p': 45, '720p': 100 }`) and transitions through `pending` → `transcoding` → `completed/failed` states. Auto-reconnects on error after 5 seconds; closes EventSource on unmount or completion.

---

## 📝 7. Error Handling Across Stack (3-4 minutes)

Shared error codes ensure consistent handling across frontend and backend: VALIDATION_ERROR, UNAUTHORIZED, SESSION_EXPIRED, NOT_FOUND, VIDEO_NOT_FOUND, UPLOAD_EXPIRED, FILE_TOO_LARGE, RATE_LIMITED, INTERNAL_ERROR.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ERROR HANDLING FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Backend Middleware:                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ ZodError      → 400 { code: VALIDATION_ERROR, details: issues }    │    │
│  │ ApiError      → err.statusCode { code, message, details }          │    │
│  │ Unknown       → 500 { code: INTERNAL_ERROR }                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Frontend fetchApi<T>:                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 1. fetch with credentials: 'include'                               │    │
│  │ 2. SESSION_EXPIRED → redirect to /login                            │    │
│  │ 3. Other errors → throw ApiError for component handling             │    │
│  │ 4. React ErrorBoundary catches render errors with fallback UI       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚖️ 8. Trade-offs and Alternatives (3-4 minutes)

### Shared Package Strategy

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| ✅ Monorepo with shared package | Single source of truth | Build complexity | **Chosen** |
| ❌ Duplicate types | Simple setup | Drift risk | Never |
| ❌ OpenAPI codegen | Auto-sync | Extra tooling | Good for larger teams |

Monorepo ensures type safety across the stack -- both sides import from the same source, eliminating drift. Build complexity is manageable with turborepo.

### Real-time Updates

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| ✅ SSE | Simple, auto-reconnect | Unidirectional | **Chosen for transcoding** |
| ❌ WebSocket | Bidirectional | More complex | Overkill for server→client only |
| ❌ Polling | Simplest | Wasteful, laggy | Fallback only |

### Validation Strategy

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| ✅ Zod (shared) | Runtime + types from one schema | Bundle size | **Chosen** |
| ❌ io-ts | Functional style | Steeper learning | Good alternative |
| ❌ Manual validation | No dependencies | Error-prone, no type inference | Never |

---

## 📋 9. Summary

This fullstack YouTube architecture centers on four pillars: (1) a **shared type package** ensuring type safety across the stack with Zod schemas, (2) a **chunked upload pipeline** with concurrent frontend uploads coordinated with S3 multipart backend handling, (3) **HLS streaming** with adaptive bitrate and watch progress sync, and (4) **SSE-based transcoding status** pushing real-time progress from workers to the UI. Unified error codes and optimistic UI patterns tie it together for a responsive user experience.

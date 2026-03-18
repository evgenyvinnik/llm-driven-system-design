# Loom — Video Recording & Sharing Platform Architecture

## System Overview

Loom is an asynchronous video communication platform that enables users to record their screen, camera, or both, and share recordings instantly via link. The platform combines browser-based recording with a video management library, time-anchored commenting, link-based sharing with access controls, and engagement analytics. At production scale, it serves millions of daily recordings with sub-second share link generation and real-time view tracking.

**Learning goals:** Browser-based media capture (MediaRecorder API), presigned URL upload patterns, video storage and delivery at scale, time-anchored commenting, share token security, and view analytics aggregation.

## Requirements

### Functional Requirements
- **Recording:** Browser-based screen, camera, or screen+camera capture with pause/resume
- **Upload:** Direct-to-storage upload via presigned URLs with progress tracking
- **Library:** Video management with folders, search, and grid/list views
- **Playback:** HTML5 video player with custom controls
- **Comments:** Time-anchored and general comments with single-level threading
- **Sharing:** Token-based share links with optional password protection and expiration
- **Analytics:** View tracking with completion rates, unique viewers, and daily view charts

### Non-Functional Requirements

| Metric | Target |
|--------|--------|
| Presigned URL generation | < 100ms (p99) |
| Share link resolution | < 50ms (p99) for token validation |
| Availability | 99.95% uptime for playback and sharing |
| Max video size | Up to 2GB per recording |
| Concurrent viewers | 10K+ simultaneous viewers per popular video |
| Analytics freshness | View counts updated within 5 seconds |
| Upload throughput | Support 100K concurrent uploads globally |

## Capacity Estimation

### Production Scale
- **Daily recordings**: 1 million
- **Average recording size**: 50MB
- **Daily new storage**: 50TB
- **Total storage (1 year)**: ~18PB
- **Daily view events**: 50 million
- **Peak concurrent uploads**: 100,000
- **Peak concurrent viewers**: 500,000
- **Presigned URL generation rate**: ~10K/second at peak

### Local Development Scale
- 1-10 recordings
- 1-3 concurrent viewers
- Single MinIO bucket
- All services on localhost

## High-Level Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│   Browser    │────▶│   CDN/Edge   │────▶│   API Gateway    │
│  (React +    │     │  (CloudFront │     │  (Rate Limiting, │
│  MediaRecorder)    │   video      │     │   Auth, Routing) │
└──────┬───────┘     │   delivery)  │     └────────┬─────────┘
       │             └──────────────┘              │
       │                                  ┌────────┴─────────┐
       │  Presigned PUT                   │                  │
       │                          ┌───────┴──────┐  ┌───────┴──────┐
       ▼                          │  Video API   │  │  Analytics   │
┌──────────────┐                  │  Service     │  │  Service     │
│  Object      │◀─── presigned ───│              │  │              │
│  Storage     │     URLs         │  - Upload    │  │  - View      │
│  (S3)        │                  │  - Videos    │  │    tracking  │
│              │────── CDN ──────▶│  - Comments  │  │  - Aggregate │
│              │     origin       │  - Shares    │  │    queries   │
└──────────────┘                  │  - Folders   │  └───────┬──────┘
                                  └──────┬───────┘          │
                                         │          ┌───────┴──────┐
                                  ┌──────┴───────┐  │  ClickHouse  │
                                  │  PostgreSQL  │  │  (analytics  │
                                  │  (metadata,  │  │   OLAP)      │
                                  │   users,     │  └──────────────┘
                                  │   shares)    │
                                  └──────┬───────┘
                                         │
                                  ┌──────┴───────┐
                                  │  Redis/Valkey│
                                  │  (sessions,  │
                                  │   cache,     │
                                  │   rate limit) │
                                  └──────────────┘
```

### Upload Pipeline (Presigned URL Pattern)

```
Browser                    API Server               Object Storage (S3/MinIO)
   │                           │                           │
   │─── POST /api/videos ─────▶│                           │
   │◀── { videoId } ───────────│                           │
   │                           │                           │
   │─── POST /api/upload/ ────▶│                           │
   │    presigned              │── generatePresignedPut ──▶│
   │◀── { uploadUrl } ────────│◀── presigned URL ─────────│
   │                           │                           │
   │═══ PUT (video blob) ═══════════════════════════════▶│
   │    (direct upload,        │                           │
   │     bypasses API)         │                           │
   │◀══ 200 OK ═══════════════════════════════════════════│
   │                           │                           │
   │─── POST /api/upload/ ────▶│── statObject ────────────▶│
   │    complete               │◀── { size } ──────────────│
   │◀── { video: ready } ─────│                           │
```

The presigned URL pattern keeps large video files off the API server entirely. The API server generates a time-limited PUT URL (< 100ms), but never touches the video bytes. This eliminates the API server as a bottleneck for large uploads. At production scale, uploads go directly to S3 across edge locations.

## Core Components

### Recording Flow

1. User selects recording mode (screen, camera, or both)
2. Browser calls `getDisplayMedia()` / `getUserMedia()` to acquire media streams
3. `MediaRecorder` captures the combined stream as WebM chunks (1-second timeslice to prevent memory accumulation)
4. On stop, chunks are assembled into a single Blob
5. Client creates video metadata via POST `/api/videos`
6. Client requests a presigned PUT URL via POST `/api/upload/presigned`
7. Client uploads the Blob directly to object storage using XMLHttpRequest (for upload progress events)
8. Client marks upload complete via POST `/api/upload/complete`

### Share Token System

Share links use cryptographically random 64-character hex tokens (`crypto.randomBytes(32).toString('hex')` — 256 bits of entropy):

1. Owner creates a share via POST `/api/share/:videoId/share` with optional password, expiry, and download permission
2. Server generates token and stores it with bcrypt-hashed password (if protected)
3. Viewers access `/share/:token` — token lookup, expiry check, optional password authentication
4. On valid access, server generates a presigned GET URL for the video file
5. Owner can revoke access by deleting the share row — immediate effect, no key rotation needed

**Why tokens over signed URLs**: Signed URLs (HMAC) would avoid the database lookup but make revocation impossible without rotating the signing key, which invalidates all outstanding links. Token-based shares support individual revocation — deleting one share row does not affect any other shares.

### Analytics Pipeline

View events are recorded with viewer identity (authenticated or session-based), watch duration, and completion status:

1. Client sends view events via POST `/api/analytics/view` with session ID and watch duration
2. Events are inserted into the `view_events` table with IP, user agent, and timestamp
3. Video `view_count` is incremented atomically
4. Analytics queries aggregate by day: unique viewers (COUNT DISTINCT on viewer/session), average watch time, completion rates

At production scale, this pipeline would be restructured:
- **Ingestion**: View events published to Kafka for decoupled, high-throughput ingestion
- **Storage**: ClickHouse for sub-second OLAP queries across billions of events
- **Approximation**: Redis HyperLogLog for real-time approximate unique viewer counts (< 1% error)
- **Aggregation**: Materialized views in ClickHouse for pre-computed daily/weekly/monthly rollups

### Comment System

Comments support two modes via a single schema:
- **General comments**: `timestamp_seconds` is NULL — appears in the comment list
- **Time-anchored comments**: `timestamp_seconds` is set — appears at that point in the video timeline

Single-level threading via `parent_id` self-reference. Comments are fetched with a single query ordered by `created_at`, then threaded client-side by grouping on `parent_id`.

## Database Schema

```sql
-- Users: standard auth table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Videos: core content table
CREATE TABLE videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  duration_seconds INTEGER,
  status VARCHAR(20) DEFAULT 'processing',  -- processing → ready | failed
  storage_path TEXT,
  thumbnail_path TEXT,
  file_size_bytes BIGINT,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comments: time-anchored and general
CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  content TEXT NOT NULL,
  timestamp_seconds FLOAT,    -- NULL = general, non-NULL = anchored
  parent_id UUID REFERENCES comments(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Shares: token-based access control
CREATE TABLE shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
  token VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255),  -- optional bcrypt hash
  expires_at TIMESTAMPTZ,      -- NULL = never expires
  allow_download BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- View events: analytics data
CREATE TABLE view_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
  viewer_id UUID REFERENCES users(id),  -- NULL for anonymous viewers
  session_id VARCHAR(64),
  watch_duration_seconds INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Folders: hierarchical organization
CREATE TABLE folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  name VARCHAR(255) NOT NULL,
  parent_id UUID REFERENCES folders(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Video-folder many-to-many
CREATE TABLE video_folders (
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, folder_id)
);

-- Performance indexes
CREATE INDEX idx_videos_user ON videos(user_id, created_at DESC);
CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_comments_video ON comments(video_id, created_at);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_shares_token ON shares(token);
CREATE INDEX idx_shares_video ON shares(video_id);
CREATE INDEX idx_view_events_video ON view_events(video_id, created_at DESC);
CREATE INDEX idx_view_events_viewer ON view_events(viewer_id);
CREATE INDEX idx_folders_user ON folders(user_id);
CREATE INDEX idx_folders_parent ON folders(parent_id);
```

### Key Indexes

- `idx_shares_token` — O(1) share link resolution, the most latency-sensitive query
- `idx_videos_user` with `created_at DESC` — User's video library sorted by recency
- `idx_comments_video` with `created_at` — Chronological comment listing per video
- `idx_view_events_video` with `created_at DESC` — Analytics aggregation range scans

## API Design

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Session login |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Current user info |

### Videos

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/videos` | List user's videos (paginated, filterable) |
| GET | `/api/videos/:id` | Get video with author info |
| POST | `/api/videos` | Create video metadata |
| PUT | `/api/videos/:id` | Update title/description |
| DELETE | `/api/videos/:id` | Delete video and storage objects |

### Upload

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload/presigned` | Generate presigned PUT URL |
| POST | `/api/upload/complete` | Mark video ready after upload |
| GET | `/api/upload/download/:videoId` | Generate presigned GET URL for playback |

### Comments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/videos/:videoId/comments` | List comments for a video |
| POST | `/api/videos/:videoId/comments` | Create comment (optional timestamp_seconds) |
| DELETE | `/api/videos/:videoId/comments/:id` | Delete comment |

### Shares

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/share/:videoId/share` | Create share link with options |
| GET | `/api/share/:token` | Validate share and get video |
| GET | `/api/share/:videoId/shares` | List shares for a video |
| DELETE | `/api/share/:videoId/shares/:id` | Revoke share link |

### Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/analytics/view` | Record view event |
| GET | `/api/analytics/:videoId/analytics` | Get aggregated analytics |

### Folders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/folders` | List user's folders |
| POST | `/api/folders` | Create folder |
| PUT | `/api/folders/:id` | Rename folder |
| DELETE | `/api/folders/:id` | Delete folder |
| POST | `/api/folders/:id/videos` | Add video to folder |
| DELETE | `/api/folders/:id/videos/:videoId` | Remove video from folder |

## Key Design Decisions

### Presigned URLs vs Proxy Upload

**Chosen: Presigned URLs.** Video files range from megabytes to gigabytes. Proxying through the API server would consume massive bandwidth and memory — a 500MB upload through a proxy holds 500MB in server memory (or requires streaming with backpressure management), consumes 500MB of server egress bandwidth, and blocks one connection for the entire upload duration. At 100K concurrent uploads averaging 50MB each, the proxy approach would require 5TB of aggregate server bandwidth, roughly 50 large EC2 instances dedicated solely to shuttling bytes.

Presigned URLs let the client upload directly to S3. The API server only handles metadata (kilobytes) and URL generation (< 100ms). This keeps the API server stateless and horizontally scalable — adding API capacity does not require adding upload bandwidth.

**Trade-off:** The client needs more upload logic (XHR with progress events, retry on failure, 4-step orchestration). We accept this complexity because the alternative — making the API server a bandwidth bottleneck — fundamentally limits scalability.

### Time-Anchored Comments as Nullable Float

**Chosen: Single `timestamp_seconds FLOAT` column (nullable).** A null value means a general comment; a non-null value anchors it to a video timestamp. This keeps the schema simple — one table, one query to fetch all comments for a video, client-side filtering by timestamp for the timeline view.

**Alternative: Polymorphic comment types** with a `comment_type` enum and separate metadata tables. This would add a join and split the query path for what amounts to a single optional field. The nullable column approach is simpler, faster, and equally expressive.

### Share Tokens vs Signed URLs for Public Access

**Chosen: Random 64-character tokens** (`crypto.randomBytes(32)` — 256 bits of entropy). Even if someone knows a video exists, they cannot access it without the exact token. Tokens support:
- **Individual revocation**: Delete the share row, instantly revoked
- **Password protection**: bcrypt hash stored alongside the token
- **Expiration**: Server-side check on every access
- **Download control**: Per-share download permission flag

**Alternative: Signed URLs with HMAC.** This would eliminate the database lookup on every share access but makes revocation impossible without maintaining a blocklist (which is effectively a database lookup anyway) or rotating the signing key (which revokes all outstanding links). For a product where users frequently create, modify, and revoke share links, token-based shares provide the right operational model.

### WebM vs MP4 (Transcoding Decision)

**Chosen: WebM (browser native).** MediaRecorder outputs WebM natively. Serving it as-is eliminates server-side transcoding entirely — no FFmpeg pipeline, no compute costs, no processing delay between recording and availability.

**Trade-off:** WebM playback is limited to browsers with VP8/VP9 codec support (Chrome, Firefox, Edge — but not Safari before version 14.1). Production Loom would transcode to HLS/DASH for adaptive bitrate streaming, generating multiple quality levels (360p, 720p, 1080p) with segment-based delivery. This requires an asynchronous transcoding pipeline (AWS MediaConvert or dedicated FFmpeg workers) that adds 30-120 seconds of processing time before a video becomes available.

## Consistency and Idempotency

- **Upload completion** is idempotent: calling `/api/upload/complete` multiple times sets status to 'ready' and updates file size from object storage — no duplicate side effects
- **View events** use insert-only semantics: duplicate view inserts create separate rows, but analytics aggregation handles this correctly via COUNT DISTINCT on viewer/session combination
- **Share token generation** always creates a new token — no deduplication needed since each share is intentionally distinct
- **Video deletion** removes both database records (CASCADE) and storage objects; if storage deletion fails, it is logged as a warning and cleaned up eventually (orphan cleanup job in production)

## Security

- **Session auth** via Redis-backed `express-session` with `httpOnly`, `sameSite: lax` cookies
- **Password-protected shares** use bcrypt with 10 salt rounds
- **Share expiration** checked server-side on every access — expired tokens return 404
- **Rate limiting** on auth endpoints (50/15min), upload endpoints (10/min), and API generally (1000/15min)
- **Presigned URL expiry** set to 1 hour — unused URLs become invalid automatically
- **Ownership validation** on all mutating endpoints — users can only modify their own videos/folders/comments

In production:
- **OAuth 2.0** for SSO integration (Google Workspace, Okta)
- **Content-Disposition headers** to control download vs inline display
- **Virus scanning** on uploaded content before marking as ready
- **Content moderation** for public/shared videos

## Observability

### Metrics (Prometheus via prom-client)

| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds` | Histogram | API latency by method/route/status |
| `http_requests_total` | Counter | Request rate for capacity planning |
| `video_upload_duration_seconds` | Histogram | Upload pipeline performance by status |
| `active_viewers_total` | Gauge | Current viewer count for load monitoring |

Default Node.js metrics (CPU, memory, event loop lag, GC) collected automatically.

### Structured Logging (Pino)

- JSON output in production, human-readable in development
- Request-level correlation via pino-http middleware
- Upload lifecycle events (presigned URL generated, upload complete, status transitions)
- Share access events (token validated, password checked, expired token rejected)

### Health Check

- `GET /api/health` — Tests database connectivity, returns status and timestamp
- `GET /metrics` — Prometheus exposition format for scraping

## Failure Handling

- **Circuit breaker** (Opossum) wraps MinIO operations with 50% error threshold, 30-second reset timeout. If object storage becomes unavailable, the circuit opens and upload/download requests fail fast rather than hanging on timeouts. Video metadata operations (PostgreSQL) continue working independently.
- **Database pool** configured with 20 max connections, 5-second connection timeout, automatic reconnection
- **Redis retry** with exponential backoff (50ms * attempts, max 2 seconds)
- **Upload failure recovery:** Video remains in 'processing' status; client can retry upload and call complete again. Presigned URLs are regenerated on retry (old URL may have expired).
- **Storage deletion failures** logged as warnings but do not block video metadata deletion — eventual cleanup via orphan detection job in production

## Scalability Considerations

### What breaks first: Video storage bandwidth

At 1M daily recordings averaging 50MB each, that is 50TB/day of new storage. S3 handles this natively with virtually unlimited capacity. CDN caching of popular videos reduces origin bandwidth by 80-90% — a viral video with 1M views serves most requests from edge cache rather than hitting S3 origin.

### Horizontal scaling path

1. **API servers**: Stateless (sessions in Redis, storage in S3), scale horizontally behind a load balancer. No affinity required.
2. **Database**: Read replicas for video listing and analytics queries; write primary for uploads and comments. At extreme scale, shard by `user_id` hash to keep each user's library on one shard.
3. **Analytics**: Migrate from PostgreSQL aggregation to ClickHouse for sub-second OLAP queries across billions of view events. Materialized views for pre-computed daily rollups.
4. **Search**: Elasticsearch for full-text video title/description search with relevance scoring.
5. **Caching**: Redis for hot video metadata (frequently accessed videos), share token validation (avoid DB lookup for every shared view), and session storage.
6. **Upload**: S3 multipart upload for files > 100MB — split into 10MB parts with individual presigned URLs, parallel upload, and server-side completion.

### Sharding strategy

- **Videos** sharded by `user_id` hash — keeps a user's library on one shard for single-query listing
- **View events** partitioned by `created_at` month — time-series access pattern, old partitions archived to cold storage
- **Comments** co-located with their video via `video_id` sharding — comments are always accessed in the context of a video

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Upload pattern | Presigned URLs | Proxy upload | API stays stateless, no bandwidth bottleneck |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler session management |
| Comment anchoring | Nullable float column | Polymorphic types | Simpler schema, single query for all comments |
| Share access | Random tokens (256-bit) | Signed URLs (HMAC) | Supports revocation, password protection, expiry |
| Analytics storage | PostgreSQL (local) | ClickHouse (production) | Sufficient for local scale, clear migration path |
| Video format | WebM (browser native) | MP4 (transcoded) | No server-side transcoding needed, instant availability |
| Object storage | MinIO (local S3) | Filesystem | S3-compatible API, mirrors production deployment |
| Comment threading | Single-level (parent_id) | Nested threading | Simpler queries, sufficient for video comments |

## Frontend Architecture

### Component Hierarchy

```
RootComponent (__root.tsx)
├── Header (logo, nav links, user menu with logout)
└── Outlet (TanStack Router)
    ├── / (LibraryPage)
    │   ├── FolderTree (hierarchical folder navigation sidebar)
    │   ├── VideoFilters (search input)
    │   ├── VideoGrid
    │   │   └── VideoCard (thumbnail, title, duration, view count, delete)
    │   └── EmptyState (shown when no videos exist or no search results)
    ├── /login (LoginPage)
    ├── /register (RegisterPage)
    ├── /record (RecordPage)
    │   ├── RecordingInterface (screen/camera mode, start/stop/pause)
    │   ├── RecordingPreview (playback of recorded blob before upload)
    │   └── UploadProgress (5-stage progress indicator)
    ├── /videos/$videoId (VideoPlayerPage)
    │   ├── VideoPlayer (HTML5 video with onTimeUpdate for comment anchoring)
    │   ├── CommentSection
    │   │   └── CommentItem (content, author, time anchor badge, reply button)
    │   ├── ShareModal (token creation with password, expiry, download toggle)
    │   └── AnalyticsPanel
    │       ├── Stat cards (total views, unique viewers, avg duration, completion)
    │       └── ViewsChart (bar chart of daily view counts)
    └── /share/$token (ShareViewPage)
        └── VideoPlayer (public view with password prompt if protected)
```

### Zustand Stores

Two domain-separated stores manage global state:

**`authStore`** -- Manages authentication lifecycle. Holds `user` (current user or null), `loading` (boolean), and `error` (string or null). Actions: `login` (username + password), `register` (username + email + password), `logout`, `checkAuth` (restores session from cookie on page load), `clearError`. The store is intentionally minimal -- it only tracks identity, not permissions or preferences.

**`videoStore`** -- Manages the video library and recording workflow. State includes:
- `videos` (paginated array), `currentVideo` (for player page), `total` (for pagination display), `page`
- `loading` (for fetch operations), `uploading` (for upload-in-progress), `uploadProgress` (0-100 percentage)
- `recording` (boolean), `recordedBlob` (Blob or null -- the just-recorded video before upload)
- `error` (string or null)

Key action: `createAndUpload(title, blob, durationSeconds, description)` orchestrates the 4-step upload pipeline: (1) create video metadata via POST, (2) get presigned URL, (3) upload blob directly to MinIO via XHR with progress tracking, (4) mark upload complete. The progress mapping is: step 1 = 10%, step 2 = 20%, XHR upload maps to 20-85%, step 4 = 85-100%. On success, the completed video is prepended to the `videos` array.

### Routing

Uses TanStack Router with file-based routing. Route files live in `frontend/src/routes/`:

| File | Path | Guard | Purpose |
|------|------|-------|---------|
| `__root.tsx` | - | None | Root layout with Header and Outlet; runs `checkAuth` on mount |
| `index.tsx` | `/` | Manual redirect | Video library; redirects to `/login` if not authenticated |
| `login.tsx` | `/login` | None | Login form |
| `register.tsx` | `/register` | None | Registration form |
| `record.tsx` | `/record` | Manual redirect | Recording interface; redirects to `/login` if not authenticated |
| `videos.$videoId.tsx` | `/videos/:videoId` | Manual redirect | Video player with comments, sharing, analytics |
| `share.$token.tsx` | `/share/:token` | None | Public share view (no auth required) |

Route guards are implemented manually within each route component using `useEffect` -- when `loading` finishes and `user` is null, the component calls `navigate({ to: '/login' })`. This is a simpler alternative to TanStack Router's `beforeLoad` guards.

The `routeTree.gen.ts` file is auto-generated by the TanStack Router Vite plugin from the file structure.

### Data Fetching

API communication is centralized in `services/api.ts`, which exports domain-specific API objects:
- `authApi`: login, register, logout, me
- `videosApi`: list, get, create, update, delete
- `uploadApi`: getPresignedUrl, complete
- `commentsApi`: list, create, delete
- `sharesApi`: create, validate, list, revoke
- `analyticsApi`: recordView, getAnalytics
- `foldersApi`: list, create, update, delete, addVideo, removeVideo

All API calls use `fetch` with `credentials: 'include'` for cookie-based session auth. Error handling parses the response body for error messages and throws typed errors.

The upload pipeline is notable: `uploadApi.getPresignedUrl` returns a time-limited PUT URL pointing directly at MinIO. The `videoStore.createAndUpload` action then uses `XMLHttpRequest` (not `fetch`) to upload the video blob, because XHR's `upload.onprogress` event provides byte-level progress tracking that the Fetch API does not support.

### Key UI Patterns

**MediaRecorder-based recording**: The `RecordingInterface` component uses the browser's `MediaRecorder` API to capture screen, camera, or both. It calls `getDisplayMedia()` for screen capture and `getUserMedia()` for camera. The MediaRecorder is configured with a 1-second `timeslice` parameter, which causes it to emit data chunks every second rather than accumulating the entire recording in memory. This prevents memory exhaustion during long recordings. An `ended` event listener on the video track detects when the user stops sharing via the browser's native UI (the "Stop sharing" button), which fires independently of application controls.

**5-stage upload progress**: The `UploadProgress` component visualizes the 4-step upload pipeline as a progress bar with labeled stages. The progress percentage is mapped non-linearly: metadata creation (0-10%), presigned URL generation (10-20%), actual upload via XHR (20-85%), and completion marking (85-100%). The XHR `upload.onprogress` event provides smooth, byte-level progress within the upload stage. This gives the user continuous feedback even for large files.

**Time-anchored comment highlighting**: The `VideoPlayer` component uses the HTML5 video element's `onTimeUpdate` event (fires approximately every 250ms during playback) to check which comments have a `timestamp_seconds` within 2 seconds of the current playback position. Matching comments are visually emphasized in the `CommentSection`. Users can click a time-anchored comment to seek the video to that timestamp.

**Folder tree navigation**: The `FolderTree` component renders a hierarchical sidebar for organizing videos into folders. Selecting a folder filters the video grid to show only videos in that folder. The tree supports nested folders via the `parent_id` self-reference in the `folders` table.

**Share modal with access controls**: The `ShareModal` component creates share links with three optional protections: password (hashed with bcrypt on the server), expiration date (checked server-side on every access), and download permission toggle. Generated links use the `/share/:token` route, which works without authentication.

---

## Deep Pattern Explanations

This section explains each production-grade backend pattern implemented in this project. Each explanation covers what the pattern is, why it exists, how it works mechanically, and why it matters for a system operating at scale.

### RBAC (Role-Based Access Control)

RBAC is a method for restricting system access based on the roles assigned to individual users, rather than assigning permissions directly to each user. In this project, users have a `role` column in the `users` table (default `'user'`). The role is stored in the session data after login and checked by middleware on protected routes.

The purpose of RBAC is to separate "who can do what" from "who is who." In Loom, regular users can manage their own videos, comments, shares, and folders. The role column provides a foundation for future admin capabilities (content moderation, user management, system analytics) without schema changes.

Beyond role-based checks, this project implements ownership validation on all mutating endpoints. Before a user can update, delete, or share a video, the middleware verifies that `video.user_id === session.userId`. This is a form of resource-level authorization that complements RBAC -- the role determines which operations are available, and ownership determines which resources those operations can target.

At production scale, RBAC prevents unauthorized access to sensitive operations without requiring complex per-resource permission lookups on every request. Adding new roles (e.g., `team_admin` for workspace management) requires only adding new role values and corresponding middleware checks, not restructuring the authorization system.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database, and populates the cache on a miss. The cache does not communicate with the database directly -- the application code sits between them and manages both.

In this project, Redis/Valkey is primarily used for session storage (via `connect-redis`) rather than general-purpose caching. Sessions are cached in Redis with a 24-hour TTL. On every authenticated request, the session middleware reads the session from Redis (sub-millisecond) rather than querying the database. This is effectively a cache-aside pattern for session data.

At production scale, cache-aside would be extended to cover:
- **Hot video metadata**: Frequently accessed videos (viral content) would have their metadata cached in Redis, avoiding repeated PostgreSQL lookups for the same video's title, duration, and status on every view.
- **Share token validation**: The most latency-sensitive operation in the system. Caching validated tokens in Redis would eliminate the database lookup on every shared video access, reducing p99 from approximately 5ms to approximately 0.1ms.
- **Analytics counts**: Real-time approximate view counts using Redis INCR rather than querying the `view_events` table.

The trade-off is eventual consistency: cached data may be stale for up to the TTL duration. For session data, staleness means a recently logged-out user could continue accessing the system for a brief window. For video metadata, staleness means a recently updated title might show the old value for a few seconds.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing external service. This project uses an Opossum-based circuit breaker wrapping MinIO operations (presigned URL generation, file stat, file deletion).

The circuit breaker has three states:

1. **Closed** (normal operation): Requests flow through to MinIO. The breaker monitors the error rate. If 50% of recent requests fail, the breaker transitions to Open.
2. **Open** (failing fast): All MinIO operations are immediately rejected with an error, without attempting to contact MinIO. This prevents the application from wasting time and resources on a service that is down. After a 30-second reset timeout, the breaker transitions to Half-Open.
3. **Half-Open** (probing): A limited number of requests are allowed through to test whether MinIO has recovered. If they succeed, the breaker closes. If they fail, it reopens.

The circuit breaker is particularly important for the presigned URL upload pattern. Without it, when MinIO becomes unavailable:
- Users trying to record and upload would wait 30+ seconds for a timeout, then see an error.
- The upload completion endpoint (which calls `statObject` on MinIO) would block, holding database connections and server threads.
- The download endpoint (which generates presigned GET URLs) would fail slowly.

With the circuit breaker, all MinIO-dependent operations fail in microseconds once the breaker opens. Video listing, commenting, and share management continue working because they only depend on PostgreSQL. The user sees an immediate "storage temporarily unavailable" message rather than a mysterious timeout.

### Structured Logging

Structured logging means emitting log entries as machine-parseable JSON objects rather than free-form text strings. This project uses Pino with JSON output in production and `pino-pretty` for human-readable output in development.

Key logging features:
- **Request correlation via pino-http**: The `pino-http` middleware assigns a unique request ID to every HTTP request and automatically logs the request method, URL, status code, and response time. All log entries generated during that request share the same ID, enabling end-to-end tracing.
- **Upload lifecycle logging**: The upload flow generates log entries at each stage (presigned URL generated, upload initiated, upload complete, status transition). This allows debugging upload failures by filtering for a specific video ID and seeing exactly where the pipeline stalled.
- **Share access logging**: Every share token validation is logged with the token (truncated for security), validation result (valid, expired, wrong password), and client IP. This enables security auditing of share access patterns.

At production scale, structured logging is essential for debugging asynchronous workflows like the upload pipeline. When a user reports "my video is stuck on processing," the engineer filters logs by `videoId`, sees that the presigned URL was generated and the upload completed, but the completion endpoint was never called. The root cause: the user closed the browser tab before step 4 of the upload pipeline.

### Prometheus Metrics

This project exposes 4 custom Prometheus metrics:

- **`http_request_duration_seconds`** (Histogram): API latency by method, route, and status code. Enables alerting on latency regressions (e.g., "p99 of POST /api/upload/presigned exceeds 200ms").
- **`http_requests_total`** (Counter): Total request count for capacity planning. The rate (requests/second) combined with duration histograms reveals throughput limits.
- **`video_upload_duration_seconds`** (Histogram): End-to-end upload pipeline duration by status (success/failure). This captures the full time from presigned URL generation to completion marking -- the metric that most directly correlates with user-perceived upload experience.
- **`active_viewers_total`** (Gauge): Current number of active video viewers. This is a real-time load indicator for the video delivery tier.

Default Node.js metrics (CPU, memory, event loop lag, garbage collection pauses) are collected automatically, enabling correlation between application-level metrics and system resource consumption. For example, if `http_request_duration_seconds` spikes simultaneously with event loop lag, the root cause is likely CPU contention rather than a database issue.

At production scale, these metrics would be extended with storage-tier metrics (MinIO operation latency, presigned URL generation rate), analytics pipeline metrics (view event ingestion rate, aggregation query duration), and CDN metrics (cache hit rate, origin bandwidth).

### Rate Limiting

Rate limiting restricts how many requests a client can make to the API within a time window. This project implements three tiers of rate limiting:

| Tier | Limit | Window | Endpoints | Purpose |
|------|-------|--------|-----------|---------|
| General API | 1000 | 15 minutes | All routes | Prevent excessive usage |
| Authentication | 50 | 15 minutes | Login, register | Prevent brute-force attacks |
| Uploads | 10 | 1 minute | Presigned URL generation | Prevent storage abuse |

The upload rate limit is particularly important because each presigned URL generation creates a time-limited authorization to write directly to object storage. Without rate limiting, a malicious user could generate thousands of presigned URLs and use them to fill storage with junk data, consuming storage capacity and incurring costs.

The current implementation uses `express-rate-limit` with an in-memory store, which resets on server restart and is not shared across instances. At production scale, this would be replaced with a Redis-backed store (e.g., `rate-limit-redis`) to ensure limits are enforced consistently across all API server instances. A user hitting instance A 500 times and instance B 500 times should still be rate-limited at 1000 total, not allowed 2000 requests.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once.

This project implements idempotency in two operations:

**Upload completion**: Calling `POST /api/upload/complete` multiple times for the same video sets the status to `'ready'` and updates the file size from object storage. There are no duplicate side effects because the operation is a database UPDATE (not INSERT) and the file size query to MinIO returns the same result each time. This handles the case where a client sends the completion request, the server processes it, but the response is lost. The client retries, and the server simply re-confirms the video is ready.

**View event recording**: View events use insert-only semantics -- every call creates a new row. Duplicate view inserts are acceptable because analytics aggregation uses COUNT DISTINCT on the viewer/session combination. If a viewer's event is recorded twice due to a network retry, it still counts as one unique viewer. This is a pragmatic trade-off: enforcing strict deduplication on a high-volume write path would require checking for existing events before each insert, adding latency to every view.

Share token generation intentionally does not use idempotency because each share creation is meant to produce a distinct token. If a user clicks "Create Share Link" twice, they should get two different links (which they can revoke independently), not the same link twice.

### Health Checks

This project implements a single health check endpoint:

**`GET /api/health`**: Tests database connectivity by executing a lightweight query (`SELECT 1` or equivalent). Returns a JSON response with status and timestamp. The endpoint does not check Redis or MinIO connectivity, which means it can report "healthy" even if those services are down.

At production scale, this would be expanded to a three-tier system:
1. **Liveness** (`/health/live`): Process is running and can handle HTTP requests
2. **Readiness** (`/health/ready`): All critical dependencies are reachable (PostgreSQL, Redis, MinIO)
3. **Full** (`/health`): Detailed status with dependency latencies, circuit breaker states, memory usage, and disk space

The readiness probe is particularly important for this project because MinIO availability directly determines whether users can upload or watch videos. A server that passes the liveness check but cannot reach MinIO should not receive new upload requests -- the readiness probe enables the load balancer to make this routing decision automatically.

---

## Implementation Notes

### Local Architecture

```
┌───────────────┐        ┌──────────────────────────────────────┐
│   Browser     │        │         Docker Compose               │
│   (React)     │        │                                      │
│               │        │  ┌────────────┐  ┌────────────┐     │
│  :5173        │───────▶│  │ PostgreSQL │  │   Valkey   │     │
│  Vite Dev     │        │  │   :5432    │  │   :6379    │     │
│  TanStack     │        │  └────────────┘  └────────────┘     │
│  Router       │        │                                      │
└───────┬───────┘        │  ┌────────────┐                     │
        │                │  │   MinIO    │                     │
        │  HTTP          │  │  :9000 API │                     │
        ▼                │  │  :9001 UI  │                     │
┌───────────────┐        │  └─────▲──────┘                     │
│  Express      │────────│        │                             │
│  :3000        │        └────────│─────────────────────────────┘
│               │                 │
│  API Server   │    presigned    │
│  (metadata    │◀────────────────┘
│   only)       │
└───────────────┘
        ▲
        │  Browser uploads directly
        │  to MinIO via presigned URL
        │  (bypasses API server)
┌───────┴───────┐
│   Browser     │═══════════ PUT (video blob) ═══════▶ MinIO :9000
└───────────────┘
```

### Production-Grade Patterns Implemented

**Presigned URL upload** (`backend/src/services/storageService.ts`): MinIO client generates time-limited PUT/GET URLs. The browser uploads directly to MinIO via XHR (for progress tracking), and the API server never touches video bytes. On upload completion, the API queries MinIO for the file size and marks the video as ready. This pattern is the foundation of scalable video upload — it eliminates the API server as a bandwidth bottleneck.

**Circuit breaker** (`backend/src/services/circuitBreaker.ts`): Opossum wraps MinIO operations (presigned URL generation, file stat, file deletion) with a 50% failure threshold and 30-second reset. If MinIO becomes unavailable, uploads fail fast rather than timing out. Database operations continue independently, so video listing and metadata queries still work.

**Prometheus metrics** (`backend/src/services/metrics.ts`): Four custom metrics — HTTP request duration histogram (by method/route/status), HTTP request counter, video upload duration histogram (by status), and active viewers gauge. Default Node.js metrics (CPU, memory, event loop) collected automatically.

**Structured logging** (`backend/src/services/logger.ts`): Pino with JSON output in production, human-readable in development. Request-level correlation via pino-http middleware for tracing requests across log lines.

**Rate limiting** (`backend/src/services/rateLimiter.ts`): Three tiers — general API (1000/15min), auth (50/15min), uploads (10/min). Uses express-rate-limit with in-memory store locally.

**Session auth** (`backend/src/middleware/auth.ts`): Redis-backed sessions via connect-redis with ioredis client. Session data includes userId, username, and role. Middleware guards protect authenticated routes.

**Share service** (`backend/src/services/shareService.ts`): Crypto-random token generation, bcrypt password hashing for protected shares, expiry validation, and individual revocation via row deletion.

**Analytics service** (`backend/src/services/analyticsService.ts`): PostgreSQL aggregation queries for total views, unique viewers (COUNT DISTINCT), average watch duration, and completion rate. Daily view counts aggregated with date_trunc for the ViewsChart component.

**Frontend recording** (`frontend/src/components/RecordingInterface.tsx`): MediaRecorder API with screen/camera mode selection, pause/resume, 1-second timeslice for memory management. XHR-based upload with `upload.onprogress` mapped to a 5-stage progress indicator (20-85% range).

**Video player** (`frontend/src/components/VideoPlayer.tsx`): Native HTML5 video element with `onTimeUpdate` for time-anchored comment highlighting. Comments with `timestamp_seconds` within 2 seconds of current playback position are visually emphasized.

### What Was Simplified or Substituted

| Production Component | Local Substitute | Impact |
|---------------------|-----------------|--------|
| Amazon S3 | MinIO (S3-compatible) | Same API, runs in Docker |
| ClickHouse (analytics OLAP) | PostgreSQL aggregation | Sufficient for local data volume |
| HLS/DASH adaptive streaming | Raw WebM files | No adaptive bitrate, browser-dependent codec support |
| FFmpeg transcoding pipeline | No transcoding | Instant availability, but limited playback compatibility |
| CDN (CloudFront) | Direct MinIO URLs | No edge caching, no geo-distribution |
| OAuth 2.0 / SSO | Session auth with bcrypt | Functional but not enterprise-grade |
| Redis-backed rate limiting | In-memory rate limiting | Resets on server restart, not shared across instances |
| S3 multipart upload | Single presigned PUT | Files > 1GB may fail on slow connections |
| Thumbnail extraction | No thumbnails | Videos show generic placeholder |

### What Was Omitted

- **CDN** for video delivery (CloudFront, Cloudflare)
- **Adaptive bitrate streaming** (HLS/DASH) with quality selection
- **Server-side video transcoding** pipeline (FFmpeg, AWS MediaConvert)
- **Real-time notifications** (WebSocket for new comments, processing completion)
- **Multi-region replication** for storage and database
- **Kubernetes orchestration** and auto-scaling
- **Content moderation** and abuse detection
- **Team workspaces** and permission model (RBAC beyond simple ownership)
- **Video thumbnail extraction** from keyframes
- **Multipart upload** for large files (> 1GB)
- **Virus scanning** on uploaded content
- **Full-text search** for video titles and descriptions

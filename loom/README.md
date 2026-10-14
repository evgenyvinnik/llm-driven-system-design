# Loom - Video Recording & Sharing Platform

A video recording and sharing platform inspired by Loom. Record your screen or camera directly in the browser, share via link, and track engagement with analytics.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,280 |
| Source Files | 75 |
| .ts | 2,308 |
| .tsx | 1,824 |
| .md | 1,576 |
| .sql | 213 |
| .json | 164 |


## Features

- **Browser Recording** -- Screen, camera, or both via MediaRecorder API with pause/resume
- **Upload While Recording** -- 5 MiB multipart parts go straight to MinIO/S3 with presigned URLs during the recording, so the video is playable about a second after Stop
- **Processing Worker** -- FFmpeg remux (adds the seek index MediaRecorder omits), duration probe, and poster frame
- **Video Library** -- Grid view with folders, search, and video management
- **Time-Anchored Comments** -- Click a timestamp badge to jump to that moment
- **Share Links** -- Token-based sharing with optional password (checked once, then remembered in a signed cookie), expiration, and revocation
- **Analytics** -- View sessions with heartbeats: view count, unique viewers, average watch time, completion rate, daily chart

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, TanStack Router, Zustand, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 16 |
| Cache | Valkey (Redis-compatible) |
| Storage | MinIO (S3-compatible) |
| Monitoring | Prometheus (prom-client), Pino |

## Quick Start

### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure
docker-compose up -d

# Install backend dependencies and run migrations
cd backend
npm install
npm run db:migrate

# Start backend (and, in another terminal, the processing worker; needs ffmpeg on PATH)
npm run dev
npm run dev:worker

# In another terminal, install frontend dependencies and start
cd frontend
npm install
npm run dev
```

### Option B: Native Installation (No Docker)

#### PostgreSQL
```bash
brew install postgresql@16
brew services start postgresql@16
createdb loom
psql loom -c "CREATE USER loom WITH PASSWORD 'loom123';"
psql loom -c "GRANT ALL PRIVILEGES ON DATABASE loom TO loom;"
psql loom -c "GRANT ALL ON SCHEMA public TO loom;"
```

#### Valkey (Redis)
```bash
brew install valkey
brew services start valkey
```

#### MinIO
```bash
brew install minio
minio server ~/minio-data --console-address ":9001"
```

Then install and run the backend and frontend as shown above.

## Environment Variables

```bash
# Backend (defaults work with docker-compose)
DATABASE_URL=postgresql://loom:loom123@localhost:5432/loom
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=loom-videos
MINIO_REGION=us-east-1          # fixed region keeps presigning local (no network call)
SESSION_SECRET=loom-dev-secret-change-in-production
SHARE_GRANT_SECRET=             # signs share-grant cookies; defaults to SESSION_SECRET
PORT=3001

# Upload pipeline
UPLOAD_PART_SIZE_BYTES=5242880  # recommended part size (S3 minimum is 5 MiB)
UPLOAD_STALE_MINUTES=30         # an upload with no part URL requested for this long is failed
UPLOAD_SWEEP_INTERVAL_MS=300000 # how often each API process sweeps abandoned uploads (0 = off)

# Processing worker
WORKER_POLL_INTERVAL_MS=2000
WORKER_LEASE_SECONDS=600
WORKER_MAX_ATTEMPTS=5
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

## Available Scripts

### Backend
```bash
npm run dev           # Start with hot reload (port 3001)
npm run dev:server1   # Start on port 3001
npm run dev:server2   # Start on port 3002
npm run dev:server3   # Start on port 3003
npm run dev:worker    # Processing worker (remux, duration, poster); add -- --once to drain and exit
npm run build         # Compile TypeScript
npm run test          # Run tests (vitest, no services needed)
npm run test:watch    # Run tests in watch mode
npm run lint          # Run ESLint
npm run format        # Run Prettier
npm run db:migrate    # Run database migrations
```

### Frontend
```bash
npm run dev           # Start dev server (port 5173)
npm run build         # Build for production
npm run lint          # Run ESLint
npm run format        # Run Prettier
npm run type-check    # TypeScript type checking
npm run test          # Run tests (vitest: the chunked uploader)
```

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Sign in |
| POST | /api/auth/logout | Sign out |
| GET | /api/auth/me | Current user |
| GET | /api/videos | List user's videos |
| GET | /api/videos/:id | Get video (owner, or a viewer holding a share grant) |
| POST | /api/videos | Create video metadata (optional client-generated `id`; retry-safe) |
| PUT | /api/videos/:id | Update video |
| DELETE | /api/videos/:id | Delete video (aborts an open upload) |
| POST | /api/upload/multipart/start | Open the multipart upload |
| POST | /api/upload/multipart/part-url | Presigned PUT URL for one part |
| GET | /api/upload/multipart/:videoId/parts | Parts already in storage |
| POST | /api/upload/complete | Verify parts, stitch, mark playable (`partCount`) |
| GET | /api/upload/download/:id | Presigned playback URL |
| GET | /api/videos/:id/comments | List comments |
| POST | /api/videos/:id/comments | Add comment |
| POST | /api/share/:id/share | Create share link |
| GET | /api/share/:token | Open a share link (401 if a password is needed) |
| POST | /api/share/:token/unlock | Check the share password once (JSON body) |
| POST | /api/analytics/view | Record a view or heartbeat (`viewId`) |
| GET | /api/analytics/:id/analytics | Get analytics (owner) |
| GET | /api/folders | List folders |
| POST | /api/folders | Create folder |
| POST | /api/folders/:id/videos | Add video to folder |
| GET | /api/health/live, /api/health/ready | Liveness and readiness |

## Project Structure

```
loom/
├── docker-compose.yml
├── architecture.md
├── system-design-answer-backend.md
├── system-design-answer-frontend.md
├── system-design-answer-fullstack.md
├── CLAUDE.md
├── backend/
│   ├── src/
│   │   ├── config/index.ts          # Configuration
│   │   ├── db/
│   │   │   ├── init.sql             # Database schema
│   │   │   └── migrate.ts           # Migration runner
│   │   ├── middleware/auth.ts       # Auth middleware
│   │   ├── worker/                  # Processing worker (FFmpeg remux, probe, poster)
│   │   ├── routes/
│   │   │   ├── auth.ts              # Authentication
│   │   │   ├── videos.ts            # Video CRUD
│   │   │   ├── upload.ts            # Upload flow
│   │   │   ├── comments.ts          # Comments
│   │   │   ├── shares.ts            # Share links
│   │   │   ├── analytics.ts         # View analytics
│   │   │   └── folders.ts           # Folder management
│   │   ├── services/
│   │   │   ├── db.ts                # PostgreSQL pool
│   │   │   ├── redis.ts             # Redis/Valkey client
│   │   │   ├── logger.ts            # Pino logger
│   │   │   ├── metrics.ts           # Prometheus metrics
│   │   │   ├── circuitBreaker.ts    # Opossum circuit breaker
│   │   │   ├── rateLimiter.ts       # Express rate limiter
│   │   │   ├── storageService.ts    # MinIO client, multipart helpers
│   │   │   ├── uploadService.ts     # Upload state machine, completion, sweeper
│   │   │   ├── jobQueue.ts          # Leased jobs (SKIP LOCKED, fencing)
│   │   │   ├── videoAccess.ts       # Owner-or-share-grant access rule
│   │   │   ├── shareGrants.ts       # Signed share-grant cookie
│   │   │   ├── analyticsService.ts  # View upsert + aggregation
│   │   │   └── shareService.ts      # Share token management
│   │   ├── app.ts                   # Express app
│   │   └── index.ts                 # Server entry point
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Header.tsx
│   │   │   ├── VideoGrid.tsx
│   │   │   ├── VideoCard.tsx
│   │   │   ├── VideoPlayer.tsx
│   │   │   ├── RecordingInterface.tsx
│   │   │   ├── RecordingPreview.tsx
│   │   │   ├── CommentSection.tsx
│   │   │   ├── CommentItem.tsx
│   │   │   ├── ShareModal.tsx
│   │   │   ├── AnalyticsPanel.tsx
│   │   │   ├── ViewsChart.tsx
│   │   │   ├── FolderTree.tsx
│   │   │   ├── UploadProgress.tsx
│   │   │   ├── VideoFilters.tsx
│   │   │   └── EmptyState.tsx
│   │   ├── routes/
│   │   │   ├── __root.tsx
│   │   │   ├── index.tsx            # Video library
│   │   │   ├── login.tsx
│   │   │   ├── register.tsx
│   │   │   ├── record.tsx           # Recording interface
│   │   │   ├── videos.$videoId.tsx  # Video player
│   │   │   └── share.$token.tsx     # Public share page
│   │   ├── stores/
│   │   │   ├── authStore.ts
│   │   │   └── videoStore.ts
│   │   ├── services/api.ts          # API client
│   │   ├── services/chunkedUploader.ts  # Streams recording parts to storage
│   │   ├── hooks/useViewTracker.ts  # View heartbeats
│   │   ├── types.ts                 # TypeScript types
│   │   ├── index.css
│   │   └── main.tsx
│   ├── package.json
│   ├── vite.config.ts
│   └── tailwind.config.js
└── README.md
```

## Default Credentials

| Service | Username | Password | Database/Bucket |
|---------|----------|----------|-----------------|
| PostgreSQL | loom | loom123 | loom |
| Redis/Valkey | - | - | (no auth) |
| MinIO | minioadmin | minioadmin | loom-videos (auto-created) |

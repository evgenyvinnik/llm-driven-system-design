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
- **Direct Upload** -- Presigned URL upload to MinIO/S3 with real-time progress tracking
- **Video Library** -- Grid view with folders, search, and video management
- **Time-Anchored Comments** -- Click a timestamp badge to jump to that moment
- **Share Links** -- Token-based sharing with optional password, expiration, and download control
- **Analytics** -- View count, unique viewers, average watch time, completion rate, daily chart

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

# Start backend
npm run dev

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
SESSION_SECRET=loom-dev-secret-change-in-production
PORT=3001
```

## Available Scripts

### Backend
```bash
npm run dev           # Start with hot reload (port 3001)
npm run dev:server1   # Start on port 3001
npm run dev:server2   # Start on port 3002
npm run dev:server3   # Start on port 3003
npm run build         # Compile TypeScript
npm run test          # Run tests
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
```

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Sign in |
| POST | /api/auth/logout | Sign out |
| GET | /api/auth/me | Current user |
| GET | /api/videos | List user's videos |
| GET | /api/videos/:id | Get video details |
| POST | /api/videos | Create video metadata |
| PUT | /api/videos/:id | Update video |
| DELETE | /api/videos/:id | Delete video |
| POST | /api/upload/presigned | Get presigned upload URL |
| POST | /api/upload/complete | Mark upload complete |
| GET | /api/upload/download/:id | Get download URL |
| GET | /api/videos/:id/comments | List comments |
| POST | /api/videos/:id/comments | Add comment |
| POST | /api/share/:id/share | Create share link |
| GET | /api/share/:token | Access shared video |
| POST | /api/analytics/view | Record view |
| GET | /api/analytics/:id/analytics | Get analytics |
| GET | /api/folders | List folders |
| POST | /api/folders | Create folder |
| POST | /api/folders/:id/videos | Add video to folder |

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
│   │   │   ├── storageService.ts    # MinIO client
│   │   │   ├── analyticsService.ts  # Analytics aggregation
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

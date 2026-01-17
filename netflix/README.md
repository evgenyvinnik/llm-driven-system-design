# Design Netflix - Video Streaming Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,160 |
| Source Files | 55 |
| .ts | 2,892 |
| .tsx | 1,701 |
| .md | 996 |
| .sql | 260 |
| .json | 140 |

## Overview

A simplified Netflix-like platform demonstrating video streaming, adaptive bitrate delivery, content personalization, and A/B testing infrastructure. This educational project focuses on building a video streaming service with sophisticated recommendation and experimentation systems.

## Key Features

### 1. Video Catalog
- Movies and TV series with seasons/episodes
- Genre-based organization
- Metadata management (ratings, descriptions, release years)
- Popularity scoring

### 2. Video Streaming
- Adaptive bitrate streaming (ABR) with quality selection
- Multiple quality levels (240p to 4K)
- Progress tracking and resume playback
- Cross-device continuation

### 3. Personalization
- Personalized homepage with dynamic rows
- "Continue Watching" for in-progress content
- "Because you watched..." recommendations
- Genre-based suggestions
- My List for saving content

### 4. A/B Testing
- Experiment framework with variants
- Consistent user allocation via hashing
- Multiple concurrent experiments support
- Variant configuration system

### 5. Profiles
- Multiple user profiles per account
- Kids profile with content restrictions
- Per-profile viewing history
- Maturity level filtering

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL (metadata, accounts, profiles)
- **Cache/Sessions:** Redis
- **Object Storage:** MinIO (S3-compatible for videos)

## Project Structure

```
netflix/
├── backend/
│   ├── src/
│   │   ├── db/           # Database connection and init SQL
│   │   ├── middleware/   # Auth middleware
│   │   ├── routes/       # API endpoints
│   │   ├── services/     # Redis, storage services
│   │   ├── types/        # TypeScript types
│   │   ├── config.ts     # Configuration
│   │   └── index.ts      # Express server
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── routes/       # Page components
│   │   ├── services/     # API clients
│   │   ├── stores/       # Zustand stores
│   │   ├── types/        # TypeScript types
│   │   ├── App.tsx       # Router setup
│   │   └── main.tsx      # Entry point
│   ├── package.json
│   └── vite.config.ts
├── docker-compose.yml    # PostgreSQL, Redis, MinIO
├── architecture.md       # System design docs
├── claude.md            # Dev notes
└── README.md            # This file
```

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
cd netflix
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432 (user: netflix, password: netflix_secret)
- Redis on port 6379
- MinIO on port 9000 (console on 9001)

### 2. Install Dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 3. Start Development Servers

```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173

### 4. Access the Application

1. Open http://localhost:5173
2. Login with demo credentials:
   - Email: `demo@netflix.local`
   - Password: `demo123`
3. Select a profile
4. Browse the catalog!

## Running Multiple Backend Instances

For testing load balancing or distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login
- `POST /api/auth/register` - Register
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current session

### Profiles
- `GET /api/profiles` - List profiles
- `POST /api/profiles` - Create profile
- `PUT /api/profiles/:id` - Update profile
- `DELETE /api/profiles/:id` - Delete profile
- `POST /api/profiles/:id/select` - Select profile

### Videos
- `GET /api/videos` - List videos (with filters)
- `GET /api/videos/:id` - Get video details
- `GET /api/videos/:id/similar` - Get similar videos
- `GET /api/videos/trending` - Get trending videos
- `GET /api/videos/genres` - Get all genres

### Browse / Homepage
- `GET /api/browse/homepage` - Get personalized homepage
- `GET /api/browse/continue-watching` - Get continue watching
- `GET /api/browse/my-list` - Get My List
- `POST /api/browse/my-list/:videoId` - Add to My List
- `DELETE /api/browse/my-list/:videoId` - Remove from My List
- `GET /api/browse/search?q=...` - Search videos

### Streaming
- `GET /api/stream/:videoId/manifest` - Get stream manifest
- `GET /api/stream/:videoId/play` - Get video stream
- `POST /api/stream/:videoId/progress` - Update watch progress
- `GET /api/stream/:videoId/progress` - Get watch progress

### Experiments
- `GET /api/experiments` - List experiments
- `POST /api/experiments` - Create experiment
- `GET /api/experiments/:id` - Get experiment
- `PUT /api/experiments/:id/status` - Update status
- `GET /api/experiments/:id/allocation` - Get user allocation

## Adding Sample Videos

For actual video playback, upload videos to MinIO:

1. Access MinIO console: http://localhost:9001 (minioadmin / minioadmin123)
2. Navigate to the `videos` bucket
3. Create folder structure: `videos/{videoId}/{quality}/video.mp4`
4. Upload video files

For testing, the player defaults to a sample video (Big Buck Bunny).

## Environment Variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Server port |
| DB_HOST | localhost | PostgreSQL host |
| DB_PORT | 5432 | PostgreSQL port |
| DB_NAME | netflix | Database name |
| DB_USER | netflix | Database user |
| DB_PASSWORD | netflix_secret | Database password |
| REDIS_HOST | localhost | Redis host |
| REDIS_PORT | 6379 | Redis port |
| MINIO_ENDPOINT | http://localhost:9000 | MinIO endpoint |
| MINIO_ACCESS_KEY | minioadmin | MinIO access key |
| MINIO_SECRET_KEY | minioadmin123 | MinIO secret key |
| CORS_ORIGIN | http://localhost:5173 | Frontend origin |

## Implementation Status

- [x] Database schema and sample data
- [x] Authentication (session-based)
- [x] Profile management
- [x] Video catalog API
- [x] Personalized homepage
- [x] Continue watching
- [x] My List
- [x] Search
- [x] Video player with controls
- [x] Quality selection
- [x] Progress tracking
- [x] A/B testing framework
- [ ] Actual video transcoding
- [ ] Real-time playback analytics
- [ ] Admin dashboard

## Key Technical Challenges

1. **ABR Streaming**: Quality adaptation based on bandwidth (simulated)
2. **Personalization**: Dynamic homepage generation per profile
3. **Content Filtering**: Maturity-level based content restrictions
4. **A/B Testing**: Consistent user allocation with experiment framework
5. **Session Management**: Redis-backed sessions with profile switching

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [Netflix Tech Blog](https://netflixtechblog.com/) - Official engineering blog with deep dives on all Netflix systems
- [Netflix Recommendations: Beyond the 5 Stars](https://netflixtechblog.com/netflix-recommendations-beyond-the-5-stars-part-1-55838468f429) - How Netflix's recommendation engine works
- [It's All A/Bout Testing: The Netflix Experimentation Platform](https://netflixtechblog.com/its-all-a-bout-testing-the-netflix-experimentation-platform-4e1ca458c15) - A/B testing infrastructure at Netflix scale
- [Open Connect: Netflix's Content Delivery Network](https://openconnect.netflix.com/en/) - How Netflix delivers video content globally
- [Adaptive Bitrate Streaming - DASH Industry Forum](https://dashif.org/docs/) - Dynamic Adaptive Streaming over HTTP specification
- [HLS Authoring Specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices) - Apple's HTTP Live Streaming documentation
- [The Netflix Cosmos Platform](https://netflixtechblog.com/the-netflix-cosmos-platform-35c14d9351ad) - Media encoding and workflow orchestration
- [Full Cycle Developers at Netflix](https://netflixtechblog.com/full-cycle-developers-at-netflix-a08c31f83249) - Netflix's microservices philosophy
- [Zuul: Netflix's Cloud Gateway](https://netflixtechblog.com/open-sourcing-zuul-2-82ea476cb2b3) - API gateway and edge service architecture
- [Designing Data-Intensive Applications by Martin Kleppmann](https://dataintensive.net/) - Foundational book covering distributed systems concepts used in streaming platforms

# YouTube - Video Platform

## Overview

A video hosting and streaming platform featuring video upload with chunked uploads, simulated transcoding pipeline, HLS manifest generation, channels, subscriptions, likes, comments, and a recommendation system.

## Key Features

- **Video Upload**: Chunked uploads with progress tracking for large files
- **Transcoding Pipeline**: Simulated multi-resolution transcoding (1080p, 720p, 480p, 360p)
- **Video Streaming**: HLS manifest generation with adaptive bitrate support
- **Channels**: User channels with subscriber counts and video management
- **Subscriptions**: Follow channels to get personalized feed
- **Engagement**: Like/dislike videos, comment system with replies
- **Recommendations**: Personalized feed based on watch history and subscriptions
- **Search**: Full-text search across video titles and descriptions
- **Watch History**: Track watch progress and resume playback

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer
- [x] API endpoints
- [ ] Testing
- [ ] Performance optimization
- [ ] Documentation

## Tech Stack

- **Frontend**: TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend**: Node.js + Express
- **Database**: PostgreSQL for metadata
- **Cache**: Redis for sessions and view count buffering
- **Storage**: MinIO (S3-compatible) for video files and thumbnails

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Installation

1. **Clone the repository and navigate to the youtube directory**

```bash
cd youtube
```

2. **Start infrastructure services**

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432 (user: youtube, password: youtube_secret)
- Redis on port 6379
- MinIO on port 9000 (console on 9001, user: minioadmin, password: minioadmin123)

3. **Install and start the backend**

```bash
cd backend
npm install
npm run dev
```

The backend will be available at http://localhost:3001

4. **Install and start the frontend** (in a new terminal)

```bash
cd frontend
npm install
npm run dev
```

The frontend will be available at http://localhost:5173

### Running Multiple Backend Instances

For testing load balancing and distributed scenarios:

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Register new user |
| POST | `/api/v1/auth/login` | Login |
| POST | `/api/v1/auth/logout` | Logout |
| GET | `/api/v1/auth/me` | Get current user |

### Videos

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/videos` | List videos with filters |
| GET | `/api/v1/videos/:id` | Get video details |
| GET | `/api/v1/videos/:id/stream` | Get streaming info |
| PATCH | `/api/v1/videos/:id` | Update video |
| DELETE | `/api/v1/videos/:id` | Delete video |
| POST | `/api/v1/videos/:id/view` | Record view |
| POST | `/api/v1/videos/:id/react` | Like/dislike video |
| GET | `/api/v1/videos/:id/comments` | Get comments |
| POST | `/api/v1/videos/:id/comments` | Add comment |

### Uploads

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/uploads/init` | Initialize chunked upload |
| PUT | `/api/v1/uploads/:id/chunks/:num` | Upload chunk |
| POST | `/api/v1/uploads/:id/complete` | Complete upload |
| DELETE | `/api/v1/uploads/:id` | Cancel upload |
| POST | `/api/v1/uploads/simple` | Simple single-file upload |

### Channels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/channels/:id` | Get channel info |
| GET | `/api/v1/channels/:id/videos` | Get channel videos |
| POST | `/api/v1/channels/:id/subscribe` | Subscribe |
| DELETE | `/api/v1/channels/:id/subscribe` | Unsubscribe |

### Feed

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/feed/recommendations` | Get personalized recommendations |
| GET | `/api/v1/feed/trending` | Get trending videos |
| GET | `/api/v1/feed/search?q=` | Search videos |
| GET | `/api/v1/feed/subscriptions` | Get subscription feed |
| GET | `/api/v1/feed/history` | Get watch history |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Frontend (React)                            │
│                     http://localhost:5173                            │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Backend (Express)                               │
│                   http://localhost:3001                              │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   Upload    │  │  Streaming  │  │  Metadata   │  │  Recommend  │ │
│  │   Service   │  │   Service   │  │   Service   │  │   Service   │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
└─────────┼────────────────┼────────────────┼────────────────┼────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
┌─────────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│      MinIO      │  │    MinIO    │  │  PostgreSQL │  │    Redis    │
│  (raw-videos)   │  │ (processed) │  │  (metadata) │  │   (cache)   │
└─────────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
```

## Development

### Environment Variables

Backend environment variables (can be set in `.env` or environment):

```bash
PORT=3001
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=youtube
POSTGRES_USER=youtube
POSTGRES_PASSWORD=youtube_secret
REDIS_HOST=localhost
REDIS_PORT=6379
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
CORS_ORIGIN=http://localhost:5173
```

### Database Schema

The database automatically initializes with the schema from `backend/migrations/init.sql` when the PostgreSQL container starts.

### MinIO Buckets

Three buckets are automatically created:
- `raw-videos`: For uploaded raw video files
- `processed-videos`: For transcoded video files and HLS manifests
- `thumbnails`: For video thumbnails

Access MinIO console at http://localhost:9001 (minioadmin/minioadmin123)

## Simulated Transcoding

Since real transcoding requires FFmpeg and significant processing, this implementation simulates the transcoding pipeline:

1. When a video upload completes, a transcoding job is queued
2. The job simulates processing for each resolution (configurable delay)
3. Placeholder video files and HLS manifests are generated
4. Video status transitions from "processing" to "ready"

For a production system, you would:
- Use FFmpeg for actual transcoding
- Use a message queue (Kafka/RabbitMQ) for job distribution
- Deploy transcoding workers as separate services
- Store actual transcoded video segments

## Testing

```bash
# Backend tests (to be implemented)
cd backend
npm test

# Frontend tests (to be implemented)
cd frontend
npm test
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Future Enhancements

- Real FFmpeg-based transcoding
- WebSocket for real-time notifications
- Live streaming support
- Playlist management
- Video analytics dashboard
- Content moderation tools
- OAuth integration
- CDN integration for production

# Design TikTok - Short Video Platform

## Overview

A simplified TikTok-like platform demonstrating short video recommendations, content discovery algorithms, and creator monetization. This educational project focuses on building a recommendation-driven video platform with infinite scroll experiences.

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
# Start PostgreSQL, Redis, and MinIO
docker-compose up -d

# Wait for services to be healthy (about 30 seconds)
docker-compose ps
```

### 2. Start Backend

```bash
cd backend

# Copy environment file
cp .env.example .env

# Install dependencies
npm install

# Start the server
npm run dev
```

The API will be available at http://localhost:3001

### 3. Start Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start the development server
npm run dev
```

The application will be available at http://localhost:5173

## Services

| Service | Port | Description |
|---------|------|-------------|
| Frontend | 5173 | React app with Vite |
| Backend API | 3001 | Express.js REST API |
| PostgreSQL | 5432 | Main database |
| Redis | 6379 | Session store & caching |
| MinIO | 9000 | S3-compatible object storage |
| MinIO Console | 9001 | MinIO web interface |

### MinIO Console

Access the MinIO console at http://localhost:9001

- Username: `minioadmin`
- Password: `minioadmin`

## Key Features

### 1. Short Video Content
- Video upload (15-60 seconds)
- Video processing and transcoding
- Effects, filters, and sounds
- Duets and stitches

### 2. For You Page (FYP)
- Personalized video recommendations
- Cold start for new users
- Exploration vs exploitation balance
- Watch time optimization

### 3. Content Discovery
- Hashtag-based discovery
- Sound/music-based discovery
- Trending content surfacing
- Search functionality

### 4. Engagement Features
- Like, comment, share
- Follow creators
- Save to favorites
- Video view counting

### 5. Creator Tools
- Analytics dashboard
- Monetization (creator fund)
- Live streaming
- Audience insights

## Implementation Status

- [x] Initial architecture design
- [x] Video upload and storage
- [x] Basic transcoding (MinIO storage)
- [x] Recommendation engine (two-phase approach)
- [x] Feed generation (FYP, Following, Trending)
- [x] Engagement tracking (views, likes, comments)
- [ ] Creator analytics
- [ ] Local multi-instance testing
- [x] Documentation

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Users
- `GET /api/users/:username` - Get user profile
- `PATCH /api/users/me` - Update profile
- `POST /api/users/:username/follow` - Follow user
- `DELETE /api/users/:username/follow` - Unfollow user

### Videos
- `POST /api/videos` - Upload video (multipart form)
- `GET /api/videos/:id` - Get video details
- `DELETE /api/videos/:id` - Delete video
- `POST /api/videos/:id/view` - Record view
- `POST /api/videos/:id/like` - Like video
- `DELETE /api/videos/:id/like` - Unlike video

### Feed
- `GET /api/feed/fyp` - For You Page feed
- `GET /api/feed/following` - Following feed
- `GET /api/feed/trending` - Trending videos
- `GET /api/feed/hashtag/:tag` - Videos by hashtag
- `GET /api/feed/search?q=query` - Search videos

### Comments
- `GET /api/comments/video/:videoId` - Get comments
- `POST /api/comments/video/:videoId` - Create comment
- `DELETE /api/comments/:id` - Delete comment

## Technology Stack

### Frontend
- React 19
- TypeScript
- Vite
- TanStack Router
- Zustand (state management)
- Tailwind CSS

### Backend
- Node.js
- Express.js
- PostgreSQL
- Redis (sessions, caching)
- MinIO (S3-compatible storage)

## Key Technical Challenges

1. **Recommendation Algorithm**: Optimizing for watch time with limited user history
2. **Cold Start Problem**: Recommending content to new users with no data
3. **Video Processing**: Transcoding to multiple formats efficiently
4. **Infinite Scroll**: Prefetching next videos seamlessly
5. **Real-Time Analytics**: Tracking view counts at massive scale

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## Recommendation Approach

The recommendation engine uses a two-phase approach:

### Phase 1: Candidate Generation
Quickly narrow from millions of videos to ~1000 candidates from multiple sources:
- Videos from followed creators (40%)
- Videos with engaged hashtags (30%)
- Trending videos for exploration (30%)

### Phase 2: Ranking
Score each candidate based on:
- User-video embedding similarity
- Engagement metrics (likes, comments, shares)
- Creator quality score
- Freshness (recency boost)
- Exploration factor (multi-armed bandit)

### Engagement Prediction

```javascript
function predictEngagement(userId, video) {
  const userVector = getUserEmbedding(userId)
  const videoVector = getVideoEmbedding(video.id)

  let score = cosineSimilarity(userVector, videoVector)
  score *= videoQualityScore(video)
  score *= creatorScore(video.creatorId)
  score *= freshnessScore(video.createdAt)

  return score
}
```

## Running Multiple Instances

For distributed testing:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Troubleshooting

### MinIO buckets not created
```bash
# Restart the minio-init container
docker-compose up minio-init
```

### Database connection failed
```bash
# Check if PostgreSQL is running
docker-compose ps postgres

# View logs
docker-compose logs postgres
```

### Redis connection failed
```bash
# Check if Redis is running
docker-compose ps redis

# Test connection
docker-compose exec redis redis-cli ping
```

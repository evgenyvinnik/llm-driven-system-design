# Instagram - Photo Sharing

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,818 |
| Source Files | 49 |
| .tsx | 2,281 |
| .js | 1,793 |
| .md | 881 |
| .ts | 359 |
| .sql | 228 |

## Overview

A photo and video sharing social platform with photo/video uploads, filters, feeds, stories, likes, comments, and follows.

## Key Features

- Photo/video upload with 12 Instagram-style CSS filters
- Personalized feed from followed users
- Stories (24-hour ephemeral content with view tracking)
- Likes, comments, and saves
- Follow/unfollow system
- User profiles with post grid
- Explore page for discovering new content
- Session-based authentication

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Cache:** Redis
- **Object Storage:** MinIO (S3-compatible)
- **Image Processing:** Sharp

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer
- [x] API endpoints
- [ ] Testing
- [ ] Performance optimization
- [x] Documentation

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose

### Option 1: Using Docker Compose (Recommended)

1. **Start infrastructure services:**

```bash
cd instagram
docker-compose up -d
```

This starts PostgreSQL, Redis, and MinIO with automatic bucket creation.

2. **Install backend dependencies:**

```bash
cd backend
cp .env.example .env
npm install
```

3. **Install frontend dependencies:**

```bash
cd frontend
npm install
```

4. **Start the backend server:**

```bash
cd backend
npm run dev
```

The API will be available at http://localhost:3001

5. **Start the frontend development server:**

```bash
cd frontend
npm run dev
```

The app will be available at http://localhost:5173

### Option 2: Native Services

If you prefer running services natively:

#### PostgreSQL

```bash
# Install PostgreSQL (macOS)
brew install postgresql@16
brew services start postgresql@16

# Create database
createdb instagram
psql instagram < backend/db/init.sql
```

#### Redis

```bash
# Install Redis (macOS)
brew install redis
brew services start redis
```

#### MinIO

```bash
# Install MinIO (macOS)
brew install minio/stable/minio
minio server ~/minio-data --console-address ":9001"

# Create bucket (in another terminal)
brew install minio/stable/mc
mc alias set local http://localhost:9000 minioadmin minioadmin
mc mb local/instagram-media
mc anonymous set public local/instagram-media
```

Update `backend/.env` with your native service configurations.

### Environment Variables

Backend `.env` configuration:

```env
# Database
DATABASE_URL=postgresql://instagram:instagram123@localhost:5432/instagram
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=instagram
POSTGRES_USER=instagram
POSTGRES_PASSWORD=instagram123

# Redis
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379

# MinIO
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
MINIO_BUCKET=instagram-media
MINIO_USE_SSL=false

# Session
SESSION_SECRET=your-super-secret-session-key-change-in-production

# Server
PORT=3001
NODE_ENV=development
```

### Running Multiple Backend Instances

For testing load balancing:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Service URLs

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:3001/api/v1 |
| MinIO Console | http://localhost:9001 |
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Posts
- `POST /api/v1/posts` - Create post (multipart form)
- `GET /api/v1/posts/:postId` - Get post
- `DELETE /api/v1/posts/:postId` - Delete post
- `POST /api/v1/posts/:postId/like` - Like post
- `DELETE /api/v1/posts/:postId/like` - Unlike post
- `POST /api/v1/posts/:postId/save` - Save post
- `DELETE /api/v1/posts/:postId/save` - Unsave post
- `GET /api/v1/posts/:postId/likes` - Get post likes

### Comments
- `GET /api/v1/posts/:postId/comments` - Get comments
- `POST /api/v1/posts/:postId/comments` - Add comment
- `DELETE /api/v1/comments/:commentId` - Delete comment
- `POST /api/v1/comments/:commentId/like` - Like comment
- `DELETE /api/v1/comments/:commentId/like` - Unlike comment

### Users
- `GET /api/v1/users/:username` - Get user profile
- `PUT /api/v1/users/me` - Update profile
- `GET /api/v1/users/:username/posts` - Get user posts
- `GET /api/v1/users/me/saved` - Get saved posts
- `POST /api/v1/users/:userId/follow` - Follow user
- `DELETE /api/v1/users/:userId/follow` - Unfollow user
- `GET /api/v1/users/:username/followers` - Get followers
- `GET /api/v1/users/:username/following` - Get following
- `GET /api/v1/users/search/users` - Search users

### Feed
- `GET /api/v1/feed` - Get home feed
- `GET /api/v1/feed/explore` - Get explore page

### Stories
- `POST /api/v1/stories` - Create story
- `GET /api/v1/stories/tray` - Get story tray
- `GET /api/v1/stories/user/:userId` - Get user stories
- `GET /api/v1/stories/me` - Get my stories
- `POST /api/v1/stories/:storyId/view` - Mark story viewed
- `GET /api/v1/stories/:storyId/viewers` - Get story viewers
- `DELETE /api/v1/stories/:storyId` - Delete story

## Available Filters

The app includes 12 CSS-based Instagram-style filters:

1. `none` - No filter
2. `clarendon` - Increased contrast and saturation
3. `gingham` - Slight brightness and sepia
4. `moon` - Grayscale with brightness
5. `lark` - Brightness with reduced saturation
6. `reyes` - Sepia with reduced contrast
7. `juno` - High saturation and contrast
8. `slumber` - Reduced saturation
9. `crema` - Sepia with reduced saturation
10. `ludwig` - Slight brightness
11. `aden` - Warm tones with saturation
12. `perpetua` - Increased contrast and brightness

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Testing

```bash
# Backend tests (when implemented)
cd backend
npm test

# Frontend tests (when implemented)
cd frontend
npm test
```

## Stopping Services

```bash
# Stop Docker services
docker-compose down

# Stop and remove volumes (full cleanup)
docker-compose down -v
```

## Future Enhancements

- Direct messaging with WebSocket
- Video transcoding
- Push notifications
- Content moderation
- Hashtags and mentions
- Admin dashboard

## References & Inspiration

- [Sharding & IDs at Instagram](https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c) - How Instagram generates unique IDs and shards data across PostgreSQL clusters
- [Storing Hundreds of Millions of Simple Key-Value Pairs in Redis](https://instagram-engineering.com/storing-hundreds-of-millions-of-simple-key-value-pairs-in-redis-1091ae80f74c) - Instagram's approach to efficient Redis memory usage
- [What Powers Instagram: Hundreds of Instances, Dozens of Technologies](https://instagram-engineering.com/what-powers-instagram-hundreds-of-instances-dozens-of-technologies-adf2e22da2ad) - Original architecture overview from Instagram engineering
- [Building Feed at Facebook Scale](https://www.facebook.com/notes/facebook-engineering/building-a-modern-news-feed/10151040681463920/) - Feed generation patterns applicable to Instagram-style timelines
- [Serving 100 Million Users with MinIO](https://blog.min.io/serving-100-million-users-with-minio/) - Object storage patterns for media-heavy applications
- [Image Processing with Sharp](https://sharp.pixelplumbing.com/) - High-performance Node.js image processing library documentation
- [Designing Instagram - System Design Primer](https://github.com/donnemartin/system-design-primer/blob/master/solutions/system_design/scaling_aws/README.md) - Scaling patterns for photo sharing platforms
- [CDN Architecture for Media Delivery](https://www.cloudflare.com/learning/cdn/what-is-a-cdn/) - Content delivery network fundamentals for image/video distribution

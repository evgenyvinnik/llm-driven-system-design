# Design Apple TV+ - Video Streaming Service

## Overview

A premium video streaming service delivering high-quality original content with adaptive bitrate streaming, multi-device sync, and offline downloads. This educational project focuses on building a video-on-demand platform with focus on content delivery, recommendation, and cross-device experience.

## Key Features

### 1. Video Streaming
- Adaptive bitrate streaming (HLS)
- Multiple quality tiers (4K HDR, 1080p, 720p, 480p)
- HLS manifest generation
- Playback continuity

### 2. Content Delivery
- MinIO for video/thumbnail storage
- HLS segment delivery
- Content catalog management

### 3. Personalization
- Watch history tracking
- Continue watching
- Personalized recommendations by genre
- Watchlist (My List)

### 4. Multi-Profile
- Multiple profiles per account
- Kids profile support
- Profile-specific watch history
- Family sharing

### 5. Subscription Management
- Free, Monthly, and Yearly tiers
- Subscription status tracking
- Content access control

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Cache:** Redis
- **Object Storage:** MinIO

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
cd apple-tv
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- MinIO on ports 9000 (API) and 9001 (Console)

### 2. Install Backend Dependencies

```bash
cd backend
npm install
```

### 3. Seed the Database

```bash
npm run seed
```

This creates sample users, profiles, series, episodes, and movies.

**Demo Credentials:**
- User: `user@appletv.local` / `user123`
- Admin: `admin@appletv.local` / `admin123`

### 4. Start the Backend

```bash
npm run dev
```

Backend runs on http://localhost:3001

### 5. Install Frontend Dependencies

```bash
cd ../frontend
npm install
```

### 6. Start the Frontend

```bash
npm run dev
```

Frontend runs on http://localhost:5173

## Running Multiple Backend Instances

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
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `POST /api/auth/profile/:id/select` - Select profile

### Content
- `GET /api/content` - Browse content
- `GET /api/content/featured` - Get featured content
- `GET /api/content/:id` - Get content details
- `GET /api/content/:id/seasons` - Get series seasons

### Streaming
- `GET /api/stream/:id/playback` - Get playback info
- `GET /api/stream/:id/master.m3u8` - HLS master playlist
- `GET /api/stream/:id/variant/:variantId.m3u8` - Quality variant playlist

### Watch Progress
- `GET /api/watch/continue` - Continue watching list
- `POST /api/watch/progress/:id` - Update progress
- `GET /api/watch/history` - Watch history

### Watchlist
- `GET /api/watchlist` - Get watchlist
- `POST /api/watchlist/:id` - Add to watchlist
- `DELETE /api/watchlist/:id` - Remove from watchlist

### Recommendations
- `GET /api/recommendations` - Personalized recommendations
- `GET /api/recommendations/trending` - Trending content
- `GET /api/recommendations/genre/:genre` - Genre recommendations

### Subscription
- `GET /api/subscription/status` - Get subscription status
- `GET /api/subscription/plans` - Get available plans
- `POST /api/subscription/subscribe` - Subscribe to plan

### Admin
- `GET /api/admin/stats` - Dashboard statistics
- `GET /api/admin/users` - List users
- `GET /api/admin/content` - List content
- `POST /api/admin/content/:id/feature` - Toggle featured

## Project Structure

```
apple-tv/
├── docker-compose.yml        # PostgreSQL, Redis, MinIO
├── backend/
│   ├── package.json
│   └── src/
│       ├── index.js          # Express server
│       ├── config/           # Configuration
│       ├── db/               # Database, Redis, MinIO clients
│       ├── middleware/       # Auth middleware
│       ├── routes/           # API routes
│       └── services/         # Business logic
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx          # Entry point
│       ├── router.ts         # Tanstack Router
│       ├── components/       # UI components
│       ├── routes/           # Page components
│       ├── stores/           # Zustand stores
│       ├── services/         # API client
│       ├── types/            # TypeScript types
│       └── utils/            # Helpers
└── README.md
```

## Implementation Status

- [x] Initial architecture design
- [x] Database schema
- [x] User authentication with sessions
- [x] Profile management
- [x] Content catalog API
- [x] HLS manifest generation
- [x] Watch progress tracking
- [x] Continue watching
- [x] Watchlist (My List)
- [x] Recommendation engine
- [x] Subscription management
- [x] Admin dashboard
- [x] Frontend browse interface
- [x] Video player UI
- [x] Profile selection
- [ ] Actual video transcoding/encoding
- [ ] Real HLS segment delivery
- [ ] Offline downloads
- [ ] DRM protection

## Key Technical Challenges

1. **Video Encoding**: Multi-codec, multi-resolution transcoding at scale
2. **Streaming Quality**: Adaptive bitrate with minimal buffering
3. **Global Delivery**: Low-latency content delivery worldwide
4. **DRM Protection**: Secure content with FairPlay
5. **Recommendations**: Personalized content discovery

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## MinIO Console

Access the MinIO console at http://localhost:9001

- Username: `minioadmin`
- Password: `minioadmin`

Buckets:
- `videos` - Video content storage
- `thumbnails` - Thumbnail images

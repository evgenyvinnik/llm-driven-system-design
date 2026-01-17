# Design Apple Music - Music Streaming Service

## Overview

A simplified Apple Music-like platform demonstrating music streaming, library management, and personalized recommendations. This educational project focuses on building an audio streaming service integrated with user libraries and social features.

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Using Docker (Recommended)

```bash
# Start all infrastructure services
docker-compose up -d

# Wait for services to be healthy (about 30 seconds)
docker-compose ps

# Install and start backend
cd backend
npm install
npm run dev

# In a new terminal, install and start frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

### Using Native Services (macOS)

If you prefer to run PostgreSQL, Redis, and MinIO natively:

```bash
# Install services
brew install postgresql@16 redis minio/stable/minio

# Start PostgreSQL
brew services start postgresql@16
createdb apple_music
psql apple_music -f backend/src/db/init.sql

# Start Redis
brew services start redis

# Start MinIO
mkdir -p ~/.minio/data
minio server ~/.minio/data --console-address ":9001"
# Create buckets via MinIO console at http://localhost:9001

# Update backend/.env with your local connection strings
# Then start services as above
```

### Demo Accounts

After setup, use these accounts to log in:

- **Admin**: admin@applemusic.local / admin123
- **User**: demo@applemusic.local / demo123

## Architecture

```
apple-music/
├── backend/                # Express.js API server
│   ├── src/
│   │   ├── routes/         # API endpoints
│   │   ├── services/       # Business logic
│   │   ├── middleware/     # Auth, etc.
│   │   └── db/             # Database setup & schema
│   └── package.json
├── frontend/               # React + Vite SPA
│   ├── src/
│   │   ├── routes/         # Tanstack Router pages
│   │   ├── components/     # Reusable UI components
│   │   ├── stores/         # Zustand state management
│   │   ├── services/       # API client
│   │   └── types/          # TypeScript types
│   └── package.json
├── docker-compose.yml      # Infrastructure services
├── architecture.md         # System design docs
└── claude.md               # Development notes
```

## Features Implemented

### Music Catalog
- Browse artists, albums, and tracks
- Full-text search across catalog
- Genre-based browsing
- Album and artist detail pages

### Audio Streaming
- Quality-aware streaming (256 AAC to Hi-Res Lossless)
- Subscription tier enforcement
- Play queue management
- Progress tracking

### Library Management
- Add/remove tracks, albums, artists
- Create and manage playlists
- Listening history
- Library sync (delta updates)

### Radio Stations
- Curated genre-based stations
- Personal radio from seed artists/tracks
- Shuffle and continuous play

### Personalized Recommendations
- "For You" personalized sections
- Heavy rotation (frequently played)
- New releases from followed artists
- Genre-based mixes
- Discovery (unplayed tracks)

### Admin Dashboard
- User, track, album, artist counts
- Active user metrics
- Plays per day chart
- Top tracks today
- Cache management

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Sign in
- `POST /api/auth/logout` - Sign out
- `GET /api/auth/me` - Current user

### Catalog
- `GET /api/catalog/search?q=...` - Search
- `GET /api/catalog/tracks` - List tracks
- `GET /api/catalog/albums/:id` - Album with tracks
- `GET /api/catalog/artists/:id` - Artist with albums

### Library
- `GET /api/library` - Get user library
- `POST /api/library` - Add item
- `DELETE /api/library/:type/:id` - Remove item
- `GET /api/library/recently-played` - Recent plays

### Playlists
- `GET /api/playlists` - User playlists
- `POST /api/playlists` - Create playlist
- `POST /api/playlists/:id/tracks` - Add track

### Streaming
- `GET /api/stream/:trackId` - Get stream URL
- `POST /api/stream/progress` - Report playback

### Radio
- `GET /api/radio` - All stations
- `GET /api/radio/:id` - Station with tracks
- `POST /api/radio/personal` - Create personal station

### Recommendations
- `GET /api/recommendations/for-you` - Personalized
- `GET /api/recommendations/browse` - Browse sections

## Tech Stack

- **Frontend**: TypeScript, React 19, Vite, Tanstack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express
- **Database**: PostgreSQL 16
- **Cache**: Redis 7
- **Object Storage**: MinIO (S3-compatible)
- **Auth**: Session-based with Redis

## Key Technical Challenges

1. **Audio Quality**: Adaptive streaming with subscription tier enforcement
2. **Library Matching**: Audio fingerprinting for upload matching (conceptual)
3. **Recommendations**: Hybrid collaborative + content-based filtering
4. **Sync Complexity**: Sync tokens for cross-device library sync
5. **Gapless Playback**: Track prefetching and queue management

## Development

### Running Multiple Backend Instances

```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

### Environment Variables

Create `backend/.env`:
```env
PORT=3001
POSTGRES_HOST=localhost
POSTGRES_DB=apple_music
POSTGRES_USER=apple_music
POSTGRES_PASSWORD=apple_music_pass
REDIS_HOST=localhost
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minio_admin
MINIO_SECRET_KEY=minio_secret
```

## Documentation

- [architecture.md](./architecture.md) - System design documentation
- [claude.md](./claude.md) - Development notes and decisions

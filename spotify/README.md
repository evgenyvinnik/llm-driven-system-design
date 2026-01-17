# Design Spotify - Music Streaming Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,584 |
| Source Files | 55 |
| .js | 2,570 |
| .tsx | 2,180 |
| .md | 874 |
| .ts | 689 |
| .css | 98 |

## Overview

A simplified Spotify-like platform demonstrating music streaming, playlist management, recommendation systems, and playback analytics. This educational project focuses on building a music streaming service with personalized discovery features.

## Key Features

### 1. Music Library
- Artists, albums, and tracks catalog
- Metadata management with cover art
- Search across all content types
- Browse by category

### 2. Streaming
- Audio streaming with HTML5 Audio
- Playback controls (play, pause, next, previous)
- Queue management with shuffle and repeat modes
- Volume control and mute

### 3. Playlists
- Create and manage playlists
- Add/remove tracks from playlists
- Liked Songs collection
- Playlist cover images

### 4. Recommendations
- Personalized "For You" recommendations
- Discover Weekly playlist
- Popular/trending tracks
- Similar tracks and artist radio

### 5. Library Management
- Liked songs, saved albums, followed artists
- Personal playlist collection
- Recently played tracks
- Listening history

## Tech Stack

- **Frontend**: TypeScript, Vite, React 19, TanStack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express
- **Database**: PostgreSQL (metadata, users, playlists)
- **Cache**: Redis (sessions, caching)
- **Object Storage**: MinIO (audio files, cover art)

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose

### 1. Start Infrastructure

```bash
cd spotify
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- MinIO on ports 9000 (API) and 9001 (Console)

### 2. Setup Backend

```bash
cd backend
npm install
npm run seed    # Creates tables and seed data
npm run dev     # Starts server on port 3001
```

### 3. Setup Frontend

```bash
cd frontend
npm install
npm run dev     # Starts on port 5173
```

### 4. Access the Application

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001/health
- **MinIO Console**: http://localhost:9001 (minioadmin/minioadmin)

### Demo Credentials

```
Email: demo@spotify.local
Password: password123
```

## Project Structure

```
spotify/
├── backend/
│   ├── src/
│   │   ├── routes/          # API route handlers
│   │   ├── services/        # Business logic
│   │   ├── models/          # Database migrations
│   │   ├── middleware/      # Auth middleware
│   │   ├── db.js            # Database connections
│   │   ├── storage.js       # MinIO client
│   │   ├── index.js         # Express server
│   │   └── seed.js          # Sample data seeding
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/      # UI components (Player, Sidebar, etc.)
│   │   ├── routes/          # TanStack Router pages
│   │   ├── stores/          # Zustand state stores
│   │   ├── services/        # API client
│   │   ├── types/           # TypeScript types
│   │   └── utils/           # Helper functions
│   └── package.json
├── docker-compose.yml       # Infrastructure
├── architecture.md          # System design documentation
├── claude.md                # Development notes
└── README.md                # This file
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Catalog
- `GET /api/catalog/artists` - List artists
- `GET /api/catalog/artists/:id` - Get artist with albums
- `GET /api/catalog/albums` - List albums
- `GET /api/catalog/albums/:id` - Get album with tracks
- `GET /api/catalog/tracks/:id` - Get track
- `GET /api/catalog/search?q=` - Search all content
- `GET /api/catalog/new-releases` - New releases
- `GET /api/catalog/featured` - Featured tracks

### Library
- `GET /api/library/tracks` - Liked songs
- `PUT /api/library/tracks/:id` - Like track
- `DELETE /api/library/tracks/:id` - Unlike track
- `GET /api/library/albums` - Saved albums
- `GET /api/library/artists` - Followed artists

### Playlists
- `GET /api/playlists/me` - User's playlists
- `POST /api/playlists` - Create playlist
- `GET /api/playlists/:id` - Get playlist with tracks
- `PATCH /api/playlists/:id` - Update playlist
- `DELETE /api/playlists/:id` - Delete playlist
- `POST /api/playlists/:id/tracks` - Add track
- `DELETE /api/playlists/:id/tracks/:trackId` - Remove track

### Playback
- `GET /api/playback/stream/:trackId` - Get stream URL
- `POST /api/playback/event` - Record playback event
- `GET /api/playback/recently-played` - Recent tracks

### Recommendations
- `GET /api/recommendations/for-you` - Personalized recommendations
- `GET /api/recommendations/discover-weekly` - Discover Weekly
- `GET /api/recommendations/popular` - Popular tracks
- `GET /api/recommendations/similar/:trackId` - Similar tracks
- `GET /api/recommendations/radio/artist/:artistId` - Artist radio

## Environment Variables

### Backend

```bash
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=spotify
DB_USER=spotify
DB_PASSWORD=spotify_secret

# Redis
REDIS_URL=redis://localhost:6379

# MinIO
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin

# Server
PORT=3001
SESSION_SECRET=your-secret-here
CORS_ORIGIN=http://localhost:5173
```

## Key Technical Challenges

1. **Audio Streaming**: HTML5 Audio with signed URLs for access control
2. **Recommendations**: Simplified collaborative filtering based on listening history
3. **Real-time Updates**: Playback state sync with Redis
4. **Session Management**: Redis-backed sessions with Express
5. **Object Storage**: MinIO for audio files and album artwork

## Implementation Status

- [x] Music catalog (artists, albums, tracks)
- [x] Audio streaming with playback controls
- [x] User authentication (session-based)
- [x] Playlists CRUD
- [x] Liked songs library
- [x] Search functionality
- [x] Basic recommendations
- [x] Playback analytics
- [ ] Offline download (architecture only)
- [ ] Real-time collaborative playlists
- [ ] Social features

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [Spotify Engineering Blog](https://engineering.atspotify.com/) - Official engineering insights and best practices
- [Personalized Recommendations at Spotify](https://engineering.atspotify.com/2022/06/personalized-recommendations-at-spotify/) - How Discover Weekly and recommendations work
- [How Spotify's Backstage Was Born](https://engineering.atspotify.com/2020/03/what-the-heck-is-backstage-anyway/) - Developer platform and microservices management
- [Scaling Agile at Spotify](https://blog.crisp.se/wp-content/uploads/2012/11/SpotifyScaling.pdf) - The famous squad/tribe organizational model
- [The Story of Spotify Wrapped](https://engineering.atspotify.com/2022/11/the-story-of-spotify-wrapped-2022/) - Large-scale data processing and personalization
- [Audio Features API](https://developer.spotify.com/documentation/web-api/reference/get-audio-features) - Understanding audio analysis for recommendations
- [Ogg Vorbis and Spotify's Audio Codec](https://support.spotify.com/us/article/audio-quality/) - Audio streaming quality and codecs
- [Music Information Retrieval](https://musicinformationretrieval.com/) - Fundamentals of audio analysis and fingerprinting
- [Collaborative Filtering at Scale](https://dl.acm.org/doi/10.1145/2959100.2959120) - Matrix factorization techniques for recommendations
- [Approximate Nearest Neighbors (Annoy)](https://github.com/spotify/annoy) - Spotify's open-source library for similarity search

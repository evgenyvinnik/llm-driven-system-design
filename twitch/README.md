# Design Twitch - Live Streaming Platform

## Overview

A simplified Twitch-like platform demonstrating live video streaming, real-time chat at scale, subscription systems, and VOD storage. This educational project focuses on building a live broadcasting system with interactive viewer experiences.

## Key Features

### 1. Live Streaming
- Stream simulation (in production: RTMP ingest)
- Video player with playback controls
- Multi-quality streaming support (HLS)
- Low-latency delivery architecture

### 2. Chat System
- Real-time WebSocket chat
- Redis pub/sub for cross-instance message delivery
- Emote support with emote picker
- User badges (subscriber, mod, admin)
- Rate limiting and moderation

### 3. Channel Management
- Streamer profiles and dashboards
- Stream titles and categories
- Follower and subscriber systems
- Stream key management

### 4. Browse & Discovery
- Browse live channels
- Category-based filtering
- Following feed
- Channel search

### 5. Authentication
- Session-based authentication
- User registration and login
- Role-based access (user, admin, moderator)

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + WebSocket (ws)
- **Database:** PostgreSQL
- **Cache/Pub-Sub:** Redis
- **Video:** HLS.js (for production HLS playback)

## Project Structure

```
twitch/
├── backend/
│   ├── src/
│   │   ├── routes/         # API endpoints
│   │   ├── services/       # Business logic
│   │   ├── middleware/     # Auth middleware
│   │   └── index.js        # Server entry point
│   ├── db/
│   │   └── init.sql        # Database schema
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── routes/         # Route definitions
│   │   ├── stores/         # Zustand stores
│   │   ├── services/       # API client
│   │   └── types/          # TypeScript types
│   └── package.json
├── docker-compose.yml      # PostgreSQL + Redis
├── architecture.md         # System design documentation
└── README.md
```

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
cd twitch
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

### 2. Setup Backend

```bash
cd backend

# Copy environment file
cp .env.example .env

# Install dependencies
npm install

# Start development server
npm run dev
```

The backend runs on http://localhost:3001

### 3. Setup Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

The frontend runs on http://localhost:5173

### 4. Access the Application

Open http://localhost:5173 in your browser.

**Demo accounts (after DB initialization):**
- shroud / (any password - auth bypassed in demo)
- pokimane
- xqc
- ninja

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Channels
- `GET /api/channels` - List all channels
- `GET /api/channels/live` - List live channels
- `GET /api/channels/:name` - Get channel details
- `POST /api/channels/:name/follow` - Follow channel
- `DELETE /api/channels/:name/follow` - Unfollow channel
- `POST /api/channels/:name/subscribe` - Subscribe to channel

### Categories
- `GET /api/categories` - List all categories
- `GET /api/categories/:slug` - Get category details
- `GET /api/categories/:slug/channels` - Get channels in category

### Streams
- `GET /api/streams/:channelId` - Get stream info
- `GET /api/streams/:channelId/vods` - Get past broadcasts
- `POST /api/streams/start` - Start simulated stream
- `POST /api/streams/stop` - Stop stream

### Emotes
- `GET /api/emotes/global` - Get global emotes
- `GET /api/emotes/channel/:channelId` - Get channel emotes

## WebSocket Chat Protocol

Connect to `ws://localhost:3001/ws/chat`

### Messages

**Authenticate:**
```json
{ "type": "auth", "userId": 1, "username": "shroud" }
```

**Join channel:**
```json
{ "type": "join", "channelId": 1 }
```

**Send message:**
```json
{ "type": "chat", "channelId": 1, "text": "Hello chat!" }
```

**Leave channel:**
```json
{ "type": "leave", "channelId": 1 }
```

### Server Messages

**Chat message:**
```json
{
  "type": "chat",
  "id": "uuid",
  "channelId": 1,
  "userId": 1,
  "username": "shroud",
  "message": "Hello chat!",
  "badges": [{ "type": "subscriber", "tier": 1 }],
  "timestamp": 1234567890
}
```

**Viewer update:**
```json
{ "type": "viewer_update", "channelId": 1, "viewerCount": 42000 }
```

## Running Multiple Backend Instances

For testing distributed chat:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

Chat messages are synchronized across instances via Redis pub/sub.

## Native Services (Without Docker)

If you prefer to run PostgreSQL and Redis natively:

### PostgreSQL (macOS)
```bash
brew install postgresql@16
brew services start postgresql@16
createdb twitch_db
psql twitch_db < backend/db/init.sql
```

### Redis (macOS)
```bash
brew install redis
brew services start redis
```

### Configuration
Update `backend/.env`:
```
DATABASE_URL=postgresql://localhost:5432/twitch_db
REDIS_URL=redis://localhost:6379
```

## Architecture Highlights

### Chat System
- WebSocket connections per instance
- Redis pub/sub for message fan-out
- Rate limiting per user/channel
- Message persistence for moderation

### Stream Simulation
- Simulated HLS manifest generation
- Viewer count fluctuation
- Start/stop stream via API
- In production: RTMP ingest + FFmpeg transcoding

### Database Design
- Channels linked to users
- Streams track each broadcast session
- Subscriptions with tiers and expiry
- Chat messages partitioned by time

## Implementation Status

- [x] Initial architecture design
- [x] Database schema
- [x] User authentication
- [x] Channel management
- [x] Category browsing
- [x] Real-time chat (WebSocket + Redis)
- [x] Follow/Subscribe system
- [x] Video player UI
- [x] Stream simulation
- [x] Creator dashboard
- [ ] Actual RTMP ingest (would need nginx-rtmp or similar)
- [ ] VOD recording and playback
- [ ] Clip creation
- [ ] Admin moderation tools

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

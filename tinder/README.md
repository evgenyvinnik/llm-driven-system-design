# Tinder - Matching Platform

## Overview

A location-based matching and recommendation system that allows users to discover potential matches, swipe to like or pass, chat with matches, and manage their profiles.

## Key Features

- User registration and authentication
- Profile management with photos and bio
- Location-based discovery with customizable preferences
- Swipe mechanics (like/pass) with match detection
- Real-time chat between matches
- Admin dashboard for system monitoring

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer (PostgreSQL, Redis, Elasticsearch)
- [x] API endpoints
- [x] Real-time WebSocket support
- [x] Frontend implementation
- [ ] Testing
- [ ] Performance optimization
- [ ] Production deployment

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL with PostGIS (geospatial), Redis (caching/sessions), Elasticsearch (geo search)
- **Real-time:** WebSocket with Redis Pub/Sub

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose
- Git

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/evgenyvinnik/llm-driven-system-design.git
   cd llm-driven-system-design/tinder
   ```

2. **Start infrastructure services:**
   ```bash
   docker-compose up -d
   ```
   This starts:
   - PostgreSQL with PostGIS on port 5432
   - Redis on port 6379
   - Elasticsearch on port 9200

3. **Install backend dependencies:**
   ```bash
   cd backend
   npm install
   ```

4. **Install frontend dependencies:**
   ```bash
   cd ../frontend
   npm install
   ```

### Running the Service

1. **Start the backend server:**
   ```bash
   cd backend
   npm run dev
   ```
   The API will be available at http://localhost:3000

2. **Seed the database (first time only):**
   ```bash
   npm run seed
   ```

3. **Start the frontend (in a new terminal):**
   ```bash
   cd frontend
   npm run dev
   ```
   The frontend will be available at http://localhost:5173

### Running Multiple Backend Instances

For testing distributed systems:
```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

## Test Accounts

After running the seed script, you can use these accounts:

| Role  | Email               | Password    |
|-------|---------------------|-------------|
| Admin | admin@example.com   | admin123    |
| User  | alice@example.com   | password123 |
| User  | bob@example.com     | password123 |

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### User Management
- `GET /api/users/profile` - Get user profile
- `PUT /api/users/profile` - Update profile
- `PUT /api/users/location` - Update location
- `GET /api/users/preferences` - Get discovery preferences
- `PUT /api/users/preferences` - Update preferences
- `GET /api/users/photos` - Get user photos
- `POST /api/users/photos` - Upload photo
- `DELETE /api/users/photos/:id` - Delete photo

### Discovery
- `GET /api/discovery/deck` - Get discovery deck
- `GET /api/discovery/profile/:userId` - Get profile card
- `POST /api/discovery/swipe` - Swipe on user
- `GET /api/discovery/likes` - Get users who liked you

### Matches & Messaging
- `GET /api/matches` - Get all matches
- `GET /api/matches/:matchId/messages` - Get messages
- `POST /api/matches/:matchId/messages` - Send message
- `POST /api/matches/:matchId/read` - Mark as read
- `DELETE /api/matches/:matchId` - Unmatch

### Admin
- `GET /api/admin/stats` - Get dashboard stats
- `GET /api/admin/users` - List users
- `GET /api/admin/users/:id` - Get user details
- `POST /api/admin/users/:id/ban` - Ban user
- `POST /api/admin/users/:id/unban` - Unban user
- `DELETE /api/admin/users/:id` - Delete user
- `GET /api/admin/activity` - Get recent activity

## Project Structure

```
tinder/
├── backend/
│   ├── src/
│   │   ├── db/           # Database connections and schema
│   │   ├── middleware/   # Express middleware
│   │   ├── routes/       # API route handlers
│   │   ├── services/     # Business logic
│   │   ├── types/        # TypeScript types
│   │   └── index.ts      # Application entry point
│   ├── uploads/          # Uploaded photos
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── routes/       # Tanstack Router routes
│   │   ├── stores/       # Zustand stores
│   │   ├── services/     # API clients
│   │   ├── types/        # TypeScript types
│   │   └── main.tsx      # Application entry point
│   └── package.json
├── docker-compose.yml    # Infrastructure services
├── architecture.md       # System design documentation
├── CLAUDE.md             # Development notes
└── README.md             # This file
```

## Docker Services

Stop all services:
```bash
docker-compose down
```

View logs:
```bash
docker-compose logs -f postgres
docker-compose logs -f redis
docker-compose logs -f elasticsearch
```

Reset data (delete volumes):
```bash
docker-compose down -v
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

Key components:
- **Profile Service** - User profiles, photos, preferences
- **Discovery Service** - Geo-based candidate search with Elasticsearch
- **Matching Service** - Swipe processing and match detection
- **Message Service** - Real-time chat with Redis Pub/Sub
- **WebSocket Gateway** - Real-time notifications

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.

## Future Enhancements

- [ ] Photo verification
- [ ] Super Likes / Boosts
- [ ] Video chat
- [ ] User reporting and moderation
- [ ] Push notifications
- [ ] Rate limiting
- [ ] Load balancing
- [ ] Horizontal scaling

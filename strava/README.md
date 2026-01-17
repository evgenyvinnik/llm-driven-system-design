# Strava - Fitness Tracking Platform

A fitness tracking and social platform for athletes, inspired by Strava. This implementation includes activity recording, GPS visualization, segment-based leaderboards, and social features.

## Features

- **Activity Tracking**: Upload GPX files or simulate activities
- **Map Visualization**: Interactive maps with Leaflet showing routes
- **Segments**: User-created route segments with leaderboards
- **Social Features**: Follow athletes, give kudos, comment on activities
- **Activity Feed**: Personalized feed from followed athletes
- **Statistics**: Personal stats, achievements, and records
- **Leaderboards**: Segment rankings with personal records

## Tech Stack

### Backend
- Node.js + Express
- PostgreSQL with PostGIS extension (for geospatial queries)
- Redis (session storage, leaderboards, activity feeds)

### Frontend
- React 19 with TypeScript
- Vite
- TanStack Router
- Zustand (state management)
- Tailwind CSS
- Leaflet (map visualization)

## Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

## Getting Started

### 1. Clone and navigate to the project

```bash
cd strava
```

### 2. Start infrastructure with Docker

```bash
docker-compose up -d
```

This starts:
- PostgreSQL with PostGIS on port 5432
- Redis on port 6379

### 3. Set up the backend

```bash
cd backend

# Copy environment file
cp .env.example .env

# Install dependencies
npm install

# Run database migrations
npm run migrate

# Seed sample data (optional but recommended)
npm run seed

# Start the development server
npm run dev
```

The backend will start on http://localhost:3001

### 4. Set up the frontend

Open a new terminal:

```bash
cd frontend

# Install dependencies
npm install

# Start the development server
npm run dev
```

The frontend will start on http://localhost:5173

### 5. Access the application

Open http://localhost:5173 in your browser.

**Demo accounts** (after running seed):
- `alice@example.com` / `password123` (regular user)
- `bob@example.com` / `password123` (regular user)
- `charlie@example.com` / `password123` (regular user)
- `admin@example.com` / `password123` (admin)

## Project Structure

```
strava/
├── docker-compose.yml          # PostgreSQL + Redis
├── backend/
│   ├── src/
│   │   ├── index.js           # Express server entry
│   │   ├── migrate.js         # Database migrations
│   │   ├── seed.js            # Sample data seeder
│   │   ├── routes/            # API route handlers
│   │   │   ├── auth.js        # Authentication
│   │   │   ├── users.js       # User profiles, following
│   │   │   ├── activities.js  # Activity CRUD, kudos, comments
│   │   │   ├── segments.js    # Segment CRUD, leaderboards
│   │   │   ├── feed.js        # Activity feed
│   │   │   └── stats.js       # User statistics
│   │   ├── services/          # Business logic
│   │   │   ├── segmentMatcher.js  # GPS segment matching
│   │   │   └── achievements.js    # Achievement system
│   │   ├── middleware/        # Express middleware
│   │   └── utils/             # Utilities
│   │       ├── db.js          # PostgreSQL connection
│   │       ├── redis.js       # Redis client + helpers
│   │       └── gps.js         # GPX parsing, metrics
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── main.tsx           # App entry
│   │   ├── routes/            # TanStack Router pages
│   │   ├── components/        # Reusable components
│   │   │   ├── ActivityCard.tsx
│   │   │   ├── ActivityMap.tsx
│   │   │   ├── LeaderboardTable.tsx
│   │   │   └── ...
│   │   ├── stores/            # Zustand stores
│   │   ├── services/          # API client
│   │   ├── types/             # TypeScript definitions
│   │   └── utils/             # Formatting helpers
│   └── package.json
├── architecture.md             # System design documentation
└── README.md                   # This file
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Activities
- `GET /api/activities` - List activities
- `GET /api/activities/:id` - Get activity details
- `GET /api/activities/:id/gps` - Get GPS points
- `POST /api/activities/upload` - Upload GPX file
- `POST /api/activities/simulate` - Create simulated activity
- `DELETE /api/activities/:id` - Delete activity
- `POST /api/activities/:id/kudos` - Give kudos
- `DELETE /api/activities/:id/kudos` - Remove kudos
- `GET /api/activities/:id/comments` - Get comments
- `POST /api/activities/:id/comments` - Add comment

### Segments
- `GET /api/segments` - List segments
- `GET /api/segments/:id` - Get segment with leaderboard
- `GET /api/segments/:id/leaderboard` - Get leaderboard
- `POST /api/segments` - Create segment from activity
- `DELETE /api/segments/:id` - Delete segment

### Users
- `GET /api/users/:id` - Get user profile
- `GET /api/users` - Search users
- `POST /api/users/:id/follow` - Follow user
- `DELETE /api/users/:id/follow` - Unfollow user
- `GET /api/users/:id/followers` - Get followers
- `GET /api/users/:id/following` - Get following

### Feed
- `GET /api/feed` - Get personalized feed
- `GET /api/feed/explore` - Get public activities

### Stats
- `GET /api/stats/me` - Get user stats and achievements
- `GET /api/stats/me/records` - Get personal records

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Key Features Explained

### Activity Upload
- Upload GPX files to record activities
- Automatic metric calculation (distance, elevation, pace)
- Privacy zone support (configurable)
- Polyline encoding for efficient map display

### Segment Matching
- Two-phase matching algorithm:
  1. Bounding box intersection (fast filter)
  2. GPS point comparison (precise matching)
- Automatic leaderboard updates
- Personal record tracking

### Leaderboards
- Redis sorted sets for fast ranking queries
- Per-user personal records
- Friends-only filtering option

### Activity Feed
- Fan-out on write model
- Redis-cached feeds for fast retrieval
- Automatic pruning to 1000 items

## Native Services Setup (Without Docker)

If you prefer running services natively:

### PostgreSQL with PostGIS

```bash
# macOS with Homebrew
brew install postgresql@16 postgis
brew services start postgresql@16

# Create database
createdb strava
psql -d strava -c "CREATE EXTENSION postgis;"

# Create user
psql -d strava -c "CREATE USER strava WITH PASSWORD 'strava_dev';"
psql -d strava -c "GRANT ALL PRIVILEGES ON DATABASE strava TO strava;"
```

### Redis

```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

Then update `.env` in the backend:

```
DATABASE_URL=postgresql://strava:strava_dev@localhost:5432/strava
REDIS_URL=redis://localhost:6379
```

## Troubleshooting

### Port already in use
```bash
# Check what's using the port
lsof -i :3001
lsof -i :5432
lsof -i :6379
```

### Database connection issues
```bash
# Check if PostgreSQL is running
docker-compose ps

# View PostgreSQL logs
docker-compose logs postgres
```

### Reset database
```bash
docker-compose down -v
docker-compose up -d
npm run migrate
npm run seed
```

## Development Notes

See [architecture.md](./architecture.md) for system design documentation.
See [claude.md](./claude.md) for development iteration history.

## License

MIT

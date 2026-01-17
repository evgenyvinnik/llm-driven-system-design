# YouTube Top K Videos - Trending Analytics System

A real-time analytics system that tracks video views and computes trending videos using windowed counting and Top K algorithms.

## Features

- **View Counting**: Track views using Redis-based windowed counting with time buckets
- **Trending Calculation**: Compute Top K trending videos using min-heap algorithm
- **Category-based Trends**: Filter trending videos by category (music, gaming, sports, etc.)
- **Real-time Updates**: Server-Sent Events (SSE) push trending updates to connected clients
- **Live Statistics**: Dashboard showing total views, unique videos, and connected clients

## Architecture

### Backend Components

- **Express Server**: REST API for video management and trending retrieval
- **Redis**: Windowed view counting using sorted sets with time-bucketed keys
- **PostgreSQL**: Persistent storage for video metadata and historical data
- **TrendingService**: Background service that periodically computes Top K videos

### Frontend Components

- **React 19 + TypeScript**: Modern UI with type safety
- **Tanstack Router**: File-based routing
- **Zustand**: Lightweight state management
- **Tailwind CSS**: Utility-first styling with YouTube-inspired dark theme

### Key Algorithms

#### Windowed View Counting
Views are stored in Redis sorted sets with 1-minute bucket keys. To get trending videos for the last hour, we aggregate counts from the last 60 buckets using `ZUNIONSTORE`.

```
views:bucket:all:1234567 -> { videoId1: 5, videoId2: 3, ... }
views:bucket:music:1234567 -> { videoId1: 2, videoId3: 1, ... }
```

#### Top K Algorithm
Uses a min-heap to efficiently maintain the top K elements:
- Time complexity: O(n log k) where n is total videos
- Space complexity: O(k)

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for Redis and PostgreSQL)
- npm or yarn

### Quick Start with Docker

1. **Clone and navigate to the project**
   ```bash
   cd youtube-top-k
   ```

2. **Start infrastructure services**
   ```bash
   docker-compose up -d
   ```

3. **Install backend dependencies**
   ```bash
   cd backend
   cp .env.example .env
   npm install
   ```

4. **Seed the database**
   ```bash
   npm run seed
   ```

5. **Start the backend server**
   ```bash
   npm run dev
   ```

6. **Install frontend dependencies (new terminal)**
   ```bash
   cd frontend
   npm install
   ```

7. **Start the frontend dev server**
   ```bash
   npm run dev
   ```

8. **Open the application**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001
   - Health check: http://localhost:3001/health

### Native Services (without Docker)

If you prefer to run Redis and PostgreSQL natively:

#### macOS (with Homebrew)

```bash
# Install and start Redis
brew install redis
brew services start redis

# Install and start PostgreSQL
brew install postgresql@16
brew services start postgresql@16

# Create the database
createdb youtube_topk
```

#### Ubuntu/Debian

```bash
# Install Redis
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server

# Install PostgreSQL
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql

# Create database
sudo -u postgres createdb youtube_topk
```

Update `.env` if your credentials differ from defaults.

## API Endpoints

### Videos

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/videos` | List videos with pagination |
| GET | `/api/videos/:id` | Get video by ID |
| POST | `/api/videos` | Create a new video |
| POST | `/api/videos/:id/view` | Record a view |
| POST | `/api/videos/batch-view` | Record multiple views |

### Trending

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trending` | Get trending videos (optional `?category=`) |
| GET | `/api/trending/all` | Get trending for all categories |
| GET | `/api/trending/categories` | List available categories |
| GET | `/api/trending/stats` | Get system statistics |
| POST | `/api/trending/refresh` | Force refresh trending |

### Real-time

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sse/trending` | SSE stream for trending updates |
| GET | `/api/sse/heartbeat` | SSE heartbeat for connection testing |

## Configuration

Environment variables (`.env`):

```env
PORT=3001
NODE_ENV=development

# PostgreSQL
DATABASE_URL=postgres://postgres:postgres@localhost:5432/youtube_topk

# Redis
REDIS_URL=redis://localhost:6379

# Trending Configuration
TOP_K_SIZE=10              # Number of top videos to track
WINDOW_SIZE_MINUTES=60     # Time window for trending calculation
UPDATE_INTERVAL_SECONDS=5  # How often to recalculate trending
```

## Running Multiple Server Instances

For testing load balancing:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Testing the System

1. Open the frontend at http://localhost:5173
2. Click "Simulate Views" to generate random view activity
3. Watch the trending list update in real-time
4. Filter by category to see category-specific trends
5. Check the stats panel for live metrics

## Project Structure

```
youtube-top-k/
├── backend/
│   ├── src/
│   │   ├── index.js              # Express server entry point
│   │   ├── seed.js               # Database seeding script
│   │   ├── models/
│   │   │   └── database.js       # PostgreSQL connection and schema
│   │   ├── routes/
│   │   │   ├── videos.js         # Video CRUD endpoints
│   │   │   ├── trending.js       # Trending endpoints
│   │   │   └── sse.js            # Server-Sent Events
│   │   ├── services/
│   │   │   ├── redis.js          # Redis client and windowed counter
│   │   │   └── trendingService.js # Trending calculation service
│   │   └── utils/
│   │       └── topk.js           # TopK, MinHeap, CountMinSketch
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── routes/               # Tanstack Router routes
│   │   ├── components/           # React components
│   │   ├── stores/               # Zustand stores
│   │   ├── services/             # API clients
│   │   ├── hooks/                # Custom hooks
│   │   └── types/                # TypeScript types
│   ├── package.json
│   └── vite.config.ts
├── docker-compose.yml
├── architecture.md
├── CLAUDE.md
└── README.md
```

## Algorithm Details

### Included Implementations

1. **MinHeap**: Classic min-heap data structure for TopK
2. **TopK**: Maintains top K elements using min-heap
3. **CountMinSketch**: Approximate frequency counting (for future use at scale)
4. **SpaceSaving**: Heavy hitters algorithm (for future use at scale)

### When to Use Approximate Algorithms

For learning purposes, this implementation uses exact counting with Redis sorted sets. In production at scale:

- **CountMinSketch**: When memory is constrained and slight overestimation is acceptable
- **SpaceSaving**: When you need guaranteed accuracy for top items with bounded error

## Future Enhancements

- [ ] Add admin interface for content moderation
- [ ] Implement geographic-based trending
- [ ] Add user authentication for personalized trends
- [ ] Implement rate limiting
- [ ] Add Prometheus metrics and Grafana dashboards
- [ ] Horizontal scaling with Redis Cluster

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.

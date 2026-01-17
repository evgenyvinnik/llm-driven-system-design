# Facebook News Feed

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,081 |
| Source Files | 43 |
| .ts | 2,322 |
| .tsx | 1,427 |
| .md | 936 |
| .sql | 156 |
| .json | 133 |

## Overview

A personalized content feed system for social media with hybrid fan-out architecture, ranking algorithms, and real-time updates.

## Key Features

- **Post Creation**: Create posts with text and images
- **Personalized Feed**: Fan-out on write for regular users, pull for celebrities
- **Social Graph**: Follow/unfollow users, friend connections
- **Engagement**: Likes and comments with real-time counts
- **Ranking**: Affinity-based post scoring with recency decay
- **Real-time Updates**: WebSocket connections for live feed updates

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer (PostgreSQL + Redis)
- [x] API endpoints
- [x] Frontend UI
- [ ] Testing
- [ ] Performance optimization

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite + Tanstack Router + Zustand + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL (primary) + Redis (caching, sessions, real-time)
- **Real-time**: WebSocket for live feed updates

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Option 1: Using Docker (Recommended)

1. **Start the infrastructure services**:
   ```bash
   docker-compose up -d
   ```
   This starts PostgreSQL and Redis.

2. **Install backend dependencies and start the server**:
   ```bash
   cd backend
   npm install
   npm run dev
   ```
   The backend will run on http://localhost:3000

3. **Install frontend dependencies and start the dev server**:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   The frontend will run on http://localhost:5173

### Option 2: Native Services

If you prefer to run PostgreSQL and Redis natively:

1. **PostgreSQL Setup**:
   ```bash
   # macOS with Homebrew
   brew install postgresql@16
   brew services start postgresql@16

   # Create database
   createdb newsfeed

   # Initialize schema
   psql newsfeed < backend/src/db/init.sql
   ```

2. **Redis Setup**:
   ```bash
   # macOS with Homebrew
   brew install redis
   brew services start redis
   ```

3. **Environment Variables** (optional, defaults shown):
   ```bash
   export POSTGRES_HOST=localhost
   export POSTGRES_PORT=5432
   export POSTGRES_DB=newsfeed
   export POSTGRES_USER=postgres
   export POSTGRES_PASSWORD=postgres
   export REDIS_HOST=localhost
   export REDIS_PORT=6379
   ```

4. **Start the services** (same as Docker option, steps 2-3)

### Running Multiple Backend Instances (Load Testing)

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Demo Accounts

The database is seeded with test users (password for all: `password123`):

| Email | Username | Role | Notes |
|-------|----------|------|-------|
| john@example.com | john_doe | User | Regular user |
| jane@example.com | jane_smith | User | Regular user |
| tech@example.com | tech_guru | User | Celebrity (1M followers) |
| admin@example.com | admin | Admin | System administrator |

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Create new account
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Feed
- `GET /api/v1/feed` - Get personalized feed
- `GET /api/v1/feed/explore` - Get trending posts

### Posts
- `POST /api/v1/posts` - Create post
- `GET /api/v1/posts/:id` - Get single post
- `DELETE /api/v1/posts/:id` - Delete post
- `POST /api/v1/posts/:id/like` - Like post
- `DELETE /api/v1/posts/:id/like` - Unlike post
- `GET /api/v1/posts/:id/comments` - Get comments
- `POST /api/v1/posts/:id/comments` - Add comment

### Users
- `GET /api/v1/users?q=query` - Search users
- `GET /api/v1/users/:username` - Get user profile
- `PUT /api/v1/users/me` - Update profile
- `GET /api/v1/users/:username/posts` - Get user's posts
- `GET /api/v1/users/:username/followers` - Get followers
- `GET /api/v1/users/:username/following` - Get following
- `POST /api/v1/users/:username/follow` - Follow user
- `DELETE /api/v1/users/:username/follow` - Unfollow user

## Architecture Highlights

### Hybrid Fan-out Strategy

- **Regular users** (< 10K followers): Push model - posts are written to all followers' feeds immediately
- **Celebrities** (>= 10K followers): Pull model - posts are fetched at read time to avoid write amplification

### Feed Ranking

Posts are ranked using a scoring function that considers:
- **Engagement score**: likes + comments * 3 + shares * 5
- **Recency decay**: Half-life of ~12 hours
- **Affinity boost**: Based on user interaction history

### Caching Strategy

- **Session cache**: Redis stores active sessions
- **Feed cache**: Pre-computed feed items in Redis sorted sets
- **Celebrity posts**: Cached separately for efficient pull-based retrieval

## Development

### Backend
```bash
cd backend
npm run dev      # Development with hot reload
npm run build    # Build for production
npm run lint     # Run ESLint
```

### Frontend
```bash
cd frontend
npm run dev         # Development server
npm run build       # Production build
npm run type-check  # TypeScript checking
npm run lint        # ESLint
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Future Enhancements

- [ ] Image upload to cloud storage (S3/Cloudinary)
- [ ] Video posts support
- [ ] Post sharing functionality
- [ ] Notifications system
- [ ] Message/chat feature
- [ ] ML-based ranking improvements
- [ ] Admin dashboard
- [ ] Rate limiting and spam protection
- [ ] Search functionality for posts

## References & Inspiration

- [The Facebook News Feed](https://engineering.fb.com/2010/05/13/web/the-new-facebook-news-feed/) - Original Facebook engineering post on News Feed architecture
- [Scaling the Facebook News Feed](https://research.facebook.com/publications/serving-facebook-multifeed-efficiency-performance-gains-through-redesign/) - Research on feed serving optimization
- [EdgeRank Algorithm](https://www.brandwatch.com/blog/react-how-does-the-facebook-edgerank-algorithm-work/) - Explanation of Facebook's original ranking algorithm
- [Twitter Fan-out Architecture](https://blog.twitter.com/engineering/en_us/topics/infrastructure/2017/the-infrastructure-behind-twitter-scale) - Twitter's approach to fan-out for timeline delivery
- [Facebook's Memcached](https://engineering.fb.com/2013/06/25/core-infra/scaling-memcache-at-facebook/) - Scaling caching infrastructure for News Feed
- [TAO: Facebook's Distributed Data Store](https://engineering.fb.com/2013/06/25/core-infra/tao-the-power-of-the-graph/) - Graph-aware caching layer used by News Feed
- [Redis Sorted Sets for Ranking](https://redis.io/docs/data-types/sorted-sets/) - Data structure for efficient feed storage and retrieval

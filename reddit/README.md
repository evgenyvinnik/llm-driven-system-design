# Design Reddit - Community-Driven Content Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 4,833 |
| Source Files | 55 |
| .js | 1,748 |
| .tsx | 1,524 |
| .md | 968 |
| .ts | 409 |
| .json | 104 |

## Overview

A simplified Reddit-like platform demonstrating voting systems, nested comments, subreddit isolation, and content ranking algorithms. This educational project focuses on building a community-driven content aggregation system with real-time voting and discussion features.

## Key Features

### 1. Subreddit Management
- Create and manage communities (subreddits)
- Subscribe/unsubscribe to communities
- Community-specific content feeds
- Subscriber counts and community info

### 2. Post & Voting System
- Submit text posts and links
- Upvote/downvote with immediate score updates
- Karma calculation per user (post karma + comment karma)
- Vote state persistence across sessions

### 3. Nested Comments
- Threaded comment trees with arbitrary depth
- Comment voting and sorting (best, top, new, controversial)
- Collapsible comment threads
- Reply to any comment in the tree

### 4. Content Ranking Algorithms
- **Hot**: Time-decay weighted by votes (Reddit's algorithm)
- **Top**: Highest score within time range
- **New**: Chronological ordering
- **Controversial**: High engagement, balanced votes
- **Best** (for comments): Wilson score confidence interval

## Tech Stack

- **Frontend**: TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend**: Node.js + Express
- **Database**: PostgreSQL (primary data store)
- **Cache**: Redis (sessions, vote caching, hot scores)

## Prerequisites

- Node.js 18+
- Docker and Docker Compose
- Modern web browser

## Getting Started

### Option 1: Using Docker (Recommended)

1. **Start the infrastructure services**:
   ```bash
   cd reddit
   docker-compose up -d
   ```

2. **Install backend dependencies and set up database**:
   ```bash
   cd backend
   cp .env.example .env
   npm install
   npm run db:migrate
   npm run db:seed
   ```

3. **Start the backend server**:
   ```bash
   npm run dev
   ```

4. **Install frontend dependencies and start dev server** (in a new terminal):
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

5. **Access the application**:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001
   - Health check: http://localhost:3001/health

### Option 2: Native Services

If you prefer to run PostgreSQL and Redis natively:

1. **Install and start PostgreSQL**:
   ```bash
   # macOS with Homebrew
   brew install postgresql@16
   brew services start postgresql@16

   # Create database and user
   createdb reddit
   psql -d reddit -c "CREATE USER reddit WITH PASSWORD 'reddit_password';"
   psql -d reddit -c "GRANT ALL PRIVILEGES ON DATABASE reddit TO reddit;"
   psql -d reddit -c "GRANT ALL PRIVILEGES ON SCHEMA public TO reddit;"
   ```

2. **Install and start Redis**:
   ```bash
   # macOS with Homebrew
   brew install redis
   brew services start redis
   ```

3. **Continue with backend setup** (same as Docker option, steps 2-5)

### Demo Accounts

After seeding, these accounts are available:

| Username | Password     | Role  |
|----------|--------------|-------|
| admin    | password123  | admin |
| alice    | password123  | user  |
| bob      | password123  | user  |
| charlie  | password123  | user  |
| diana    | password123  | user  |

## Running Multiple Instances

For testing distributed scenarios:

```bash
# Terminal 1: API Server on port 3001
npm run dev:server1

# Terminal 2: API Server on port 3002
npm run dev:server2

# Terminal 3: API Server on port 3003
npm run dev:server3

# Terminal 4: Vote Aggregation Worker
npm run dev:worker

# Terminal 5: Hot Score Calculator
npm run dev:ranking
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create new account
- `POST /api/auth/login` - Log in
- `POST /api/auth/logout` - Log out
- `GET /api/auth/me` - Get current user

### Subreddits
- `GET /api/subreddits` - List all subreddits
- `POST /api/subreddits` - Create subreddit
- `GET /api/subreddits/:name` - Get subreddit info
- `POST /api/subreddits/:name/subscribe` - Subscribe
- `POST /api/subreddits/:name/unsubscribe` - Unsubscribe

### Posts
- `GET /api/posts` - List all posts (home feed)
- `GET /api/r/:subreddit/:sort` - List posts by subreddit
- `POST /api/posts/r/:subreddit` - Create post
- `GET /api/posts/:id` - Get single post
- `GET /api/posts/:id/comments` - Get post with comments

### Comments
- `POST /api/posts/:postId/comments` - Create comment
- `GET /api/comments/:id` - Get comment subtree

### Voting
- `POST /api/vote` - Cast vote
  ```json
  { "type": "post|comment", "id": 123, "direction": 1|-1|0 }
  ```

## Project Structure

```
reddit/
├── docker-compose.yml        # PostgreSQL + Redis
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server entry
│   │   ├── db/               # Database connection & migrations
│   │   ├── models/           # Data access layer
│   │   ├── routes/           # API route handlers
│   │   ├── middleware/       # Auth middleware
│   │   ├── utils/            # Ranking algorithms
│   │   └── workers/          # Background jobs
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── main.tsx          # React entry
│   │   ├── routes/           # TanStack Router pages
│   │   ├── components/       # Reusable UI components
│   │   ├── stores/           # Zustand state management
│   │   ├── services/         # API client
│   │   ├── types/            # TypeScript types
│   │   └── utils/            # Helper functions
│   └── package.json
├── architecture.md           # System design documentation
├── CLAUDE.md                 # Development notes
└── README.md                 # This file
```

## Key Technical Implementations

### 1. Voting System
- Votes stored in dedicated table with unique constraints
- Immediate score aggregation for responsive UI
- Background worker for bulk aggregation
- Redis caching for user vote lookups

### 2. Nested Comments (Materialized Path)
- Path column stores ancestry: "1.5.23.102"
- Single query fetches entire subtree: `WHERE path LIKE '1.5.%'`
- Efficient depth-based sorting

### 3. Hot Score Algorithm
```javascript
function hotScore(ups, downs, createdAt) {
  const score = ups - downs;
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  const seconds = (createdAt - epoch) / 1000;
  return sign * order + seconds / 45000;
}
```

### 4. Wilson Score (for "Best" comment sorting)
Provides confidence-adjusted ranking that accounts for sample size, preventing "1 upvote, 0 downvotes = 100%" from ranking highest.

## Development Notes

See [architecture.md](./architecture.md) for detailed system design documentation.
See [CLAUDE.md](./CLAUDE.md) for development insights and design decisions.

## Future Enhancements

- [ ] User profiles and post history
- [ ] Real-time notifications
- [ ] Search within subreddits
- [ ] Cross-posting between communities
- [ ] Flair system for posts and users
- [ ] Basic moderation tools
- [ ] Awards and premium features

## References & Inspiration

- [How Reddit Ranking Algorithms Work](https://medium.com/hacking-and-gonzo/how-reddit-ranking-algorithms-work-ef111e33d0d9) - Deep dive into hot, controversial, and best ranking algorithms
- [How Not To Sort By Average Rating](https://www.evanmiller.org/how-not-to-sort-by-average-rating.html) - Wilson score confidence interval for comment ranking
- [Reddit's Architecture](https://www.redditinc.com/blog/how-we-built-rplace/) - Insights from building r/place at scale
- [Scaling Reddit's Community Points with Arbitrum](https://www.reddit.com/r/ethereum/comments/l6c3kx/scaling_reddits_community_points_with_arbitrum/) - Reddit's approach to scaling community features
- [The Evolution of Reddit.com's Architecture](https://www.infoq.com/presentations/reddit-architecture-evolution/) - Talk on Reddit's infrastructure evolution
- [PostgreSQL ltree Extension](https://www.postgresql.org/docs/current/ltree.html) - Hierarchical data type used for materialized path trees
- [Reddit's Voting System Design](https://redditblog.com/2009/10/15/reddits-new-comment-sorting-system/) - Original blog post on confidence-based comment sorting

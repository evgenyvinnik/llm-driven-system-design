# Design Twitter/X - Real-Time Social Platform

## Overview

A simplified Twitter-like platform demonstrating timeline fanout, real-time updates, trend detection, and social graph management. This educational project focuses on building a high-throughput microblogging system with real-time content delivery.

## Key Features

### 1. Tweet Publishing
- Post short-form content (280 characters)
- Mention users with @username
- Hashtag support for topic discovery
- Retweets and quote tweets

### 2. Timeline Generation
- Home timeline (posts from followed users)
- User profile timeline (user's own posts)
- Explore timeline (public tweets)
- Hashtag timeline
- Hybrid fanout strategy (push for normal users, pull for celebrities)

### 3. Social Graph
- Follow/unfollow users
- Follower/following counts (denormalized)
- Celebrity detection (auto-flagged at 10K followers)

### 4. Engagement
- Like/unlike tweets
- Retweet/unretweet
- Reply threads

### 5. Trending Topics
- Hashtag frequency tracking
- Time-windowed analysis (1-hour sliding window)
- Trend velocity calculation with exponential decay
- Rising trends detection

## Implementation Status

- [x] Initial architecture design
- [x] Database schema (users, tweets, follows, likes, retweets)
- [x] Tweet creation and storage
- [x] Timeline fanout implementation (hybrid push/pull)
- [x] Follow graph management
- [x] Trend detection system
- [x] Frontend with React + TypeScript
- [ ] Real-time notifications (SSE/WebSocket)
- [ ] Local multi-instance testing

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for PostgreSQL and Redis)
- Modern web browser

### Quick Start with Docker

```bash
cd twitter

# Start infrastructure (PostgreSQL + Redis)
docker-compose up -d

# Setup backend
cd backend
npm install
cp .env.example .env  # Already configured for Docker defaults
npm run db:migrate
npm run db:seed  # Optional: adds demo data

# Start backend server
npm run dev  # Runs on port 3001

# In a new terminal, setup frontend
cd ../frontend
npm install
npm run dev  # Runs on port 5173
```

Open http://localhost:5173 in your browser.

### Native Services Setup (without Docker)

If you prefer to run PostgreSQL and Redis natively:

#### PostgreSQL
```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16
createdb twitter_db
psql twitter_db -c "CREATE USER twitter WITH PASSWORD 'twitter_secret';"
psql twitter_db -c "GRANT ALL PRIVILEGES ON DATABASE twitter_db TO twitter;"
```

#### Redis
```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

Then update `backend/.env` with your connection strings if different from defaults.

### Running Multiple Instances

```bash
# Run multiple API server instances (for load testing)
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

### Demo Accounts

After running `npm run db:seed`, you can log in with:
- **Usernames**: alice, bob, charlie, diana, eve, frank, grace, admin
- **Password**: password123

## API Endpoints

### Authentication
```
POST   /api/auth/register     - Register new user
POST   /api/auth/login        - Log in
POST   /api/auth/logout       - Log out
GET    /api/auth/me           - Get current user
```

### Tweets
```
POST   /api/tweets            - Create tweet
GET    /api/tweets/:id        - Get single tweet
DELETE /api/tweets/:id        - Delete tweet
POST   /api/tweets/:id/like   - Like tweet
DELETE /api/tweets/:id/like   - Unlike tweet
POST   /api/tweets/:id/retweet  - Retweet
DELETE /api/tweets/:id/retweet  - Undo retweet
GET    /api/tweets/:id/replies  - Get replies
```

### Timeline
```
GET    /api/timeline/home           - Home timeline (authenticated)
GET    /api/timeline/user/:username - User's tweets
GET    /api/timeline/explore        - Public timeline
GET    /api/timeline/hashtag/:tag   - Tweets with hashtag
```

### Users
```
GET    /api/users/:username         - Get user profile
POST   /api/users/:id/follow        - Follow user
DELETE /api/users/:id/follow        - Unfollow user
GET    /api/users/:id/followers     - List followers
GET    /api/users/:id/following     - List following
GET    /api/users?q=query           - Search users
```

### Trends
```
GET    /api/trends            - Get trending hashtags
GET    /api/trends/all-time   - All-time popular hashtags
```

## Key Technical Challenges

1. **Fanout at Scale**: Hybrid push/pull strategy - push for users with < 10K followers, pull for celebrities
2. **Celebrity Problem**: Celebrities are auto-detected and their tweets are pulled at read time
3. **Timeline Consistency**: Merge cached timeline with celebrity tweets, sort by timestamp
4. **Trend Detection**: Sliding window with exponential decay for real-time trend scoring
5. **Graph Queries**: Denormalized counts with Redis cache for fast lookups

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## Fanout Strategies

**Hybrid (Implemented):**
```javascript
// On tweet creation (push for non-celebrities)
async function fanoutTweet(tweetId, authorId) {
  const author = await getUser(authorId);
  if (author.is_celebrity) return; // Skip push for celebrities

  const followers = await getFollowers(authorId);
  const pipeline = redis.pipeline();
  for (const followerId of followers) {
    pipeline.lpush(`timeline:${followerId}`, tweetId);
    pipeline.ltrim(`timeline:${followerId}`, 0, 799);
  }
  await pipeline.exec();
}

// On timeline read (merge push + pull)
async function getHomeTimeline(userId) {
  const cachedIds = await redis.lrange(`timeline:${userId}`, 0, 100);
  const cachedTweets = await getTweetsByIds(cachedIds);

  const celebrities = await getFollowedCelebrities(userId);
  const celebrityTweets = await getRecentTweetsByAuthors(celebrities);

  return merge(cachedTweets, celebrityTweets);
}
```

## Tech Stack

- **Frontend**: TypeScript, Vite, React 19, Tanstack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express
- **Database**: PostgreSQL (primary), Redis (cache + timelines)
- **Session**: Redis-backed sessions

## Future Enhancements

- [ ] Media upload support
- [ ] Direct messages
- [ ] Lists and bookmarks
- [ ] Advanced search
- [ ] Algorithmic timeline ranking
- [ ] Real-time updates via SSE/WebSocket
- [ ] Multi-instance load balancing

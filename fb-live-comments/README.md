# Facebook Live Comments

A real-time commenting system for live video streams, demonstrating high-throughput comment delivery, batching, and reaction aggregation.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 3,440 |
| Source Files | 44 |
| .ts | 1,658 |
| .md | 893 |
| .tsx | 566 |
| .json | 116 |
| .sql | 83 |

## Features

- Real-time comments via WebSocket
- Comment batching for high-volume streams (configurable interval)
- Reaction aggregation with floating animation
- Rate limiting (per-user, per-stream)
- Simple profanity filtering
- Redis Pub/Sub for multi-instance support
- Snowflake ID generation for time-ordered comments
- PostgreSQL for persistent storage
- Redis for caching and real-time messaging

## Architecture Highlights

- **WebSocket Gateway**: Handles real-time bidirectional communication
- **Comment Batching**: Instead of sending each comment individually, comments are batched every 100ms for efficiency
- **Reaction Aggregation**: Reactions are aggregated every 500ms to reduce message volume
- **Redis Pub/Sub**: Enables horizontal scaling across multiple server instances
- **Snowflake IDs**: Time-ordered unique identifiers without coordination

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS + Zustand
- **Backend**: Node.js + Express + WebSocket (ws)
- **Database**: PostgreSQL 16
- **Cache/Pub-Sub**: Redis 7

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

## Getting Started

### Option 1: Using Docker (Recommended)

1. **Start infrastructure services**:
   ```bash
   docker-compose up -d
   ```

2. **Install backend dependencies and start server**:
   ```bash
   cd backend
   npm install
   cp .env.example .env
   npm run dev
   ```

3. **Install frontend dependencies and start dev server**:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

4. **Open the application**:
   Open [http://localhost:5173](http://localhost:5173) in your browser.

### Option 2: Native Services

If you have PostgreSQL and Redis installed natively:

1. **Configure PostgreSQL**:
   - Create a database named `live_comments`
   - Run the schema: `psql -d live_comments -f backend/src/db/init.sql`

2. **Configure Redis**:
   - Ensure Redis is running on `localhost:6379`

3. **Update environment variables**:
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env if your database/redis URLs differ
   ```

4. **Start backend**:
   ```bash
   cd backend
   npm install
   npm run dev
   ```

5. **Start frontend**:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

## Running Multiple Backend Instances

To test horizontal scaling with Redis Pub/Sub:

```bash
# Terminal 1
cd backend && npm run dev:server1  # Port 3001

# Terminal 2
cd backend && npm run dev:server2  # Port 3002

# Terminal 3
cd backend && npm run dev:server3  # Port 3003
```

## Project Structure

```
fb-live-comments/
├── backend/
│   ├── src/
│   │   ├── db/           # Database connection and migrations
│   │   ├── routes/       # Express API routes
│   │   ├── services/     # Business logic
│   │   │   ├── commentService.ts   # Comment CRUD + rate limiting
│   │   │   ├── reactionService.ts  # Reactions handling
│   │   │   ├── streamService.ts    # Stream management
│   │   │   ├── userService.ts      # User management
│   │   │   └── wsGateway.ts        # WebSocket + batching
│   │   ├── types/        # TypeScript types
│   │   ├── utils/        # Utilities (Redis, Snowflake)
│   │   └── index.ts      # Entry point
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── hooks/        # Custom hooks (WebSocket)
│   │   ├── services/     # API client
│   │   ├── stores/       # Zustand stores
│   │   ├── types/        # TypeScript types
│   │   └── App.tsx       # Main app
│   └── package.json
├── docker-compose.yml
└── README.md
```

## API Endpoints

### Streams

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/streams | List all streams |
| GET | /api/streams/live | List live streams |
| GET | /api/streams/:id | Get stream details |
| POST | /api/streams | Create new stream |
| POST | /api/streams/:id/end | End a stream |
| GET | /api/streams/:id/comments | Get recent comments |
| POST | /api/streams/:id/comments | Post comment (HTTP fallback) |
| GET | /api/streams/:id/reactions | Get reaction counts |
| GET | /api/streams/:id/viewers | Get viewer count |

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/users | List all users |
| GET | /api/users/:id | Get user details |
| POST | /api/users | Create user |
| POST | /api/users/:id/ban | Ban user |
| DELETE | /api/users/:id/ban | Unban user |

## WebSocket Messages

### Client to Server

```json
{ "type": "join_stream", "payload": { "stream_id": "...", "user_id": "..." } }
{ "type": "leave_stream" }
{ "type": "post_comment", "payload": { "stream_id": "...", "user_id": "...", "content": "..." } }
{ "type": "react", "payload": { "stream_id": "...", "user_id": "...", "reaction_type": "like" } }
{ "type": "ping" }
```

### Server to Client

```json
{ "type": "comments_batch", "payload": { "stream_id": "...", "comments": [...] } }
{ "type": "reactions_batch", "payload": { "stream_id": "...", "counts": { "like": 5, "love": 3 } } }
{ "type": "viewer_count", "payload": { "stream_id": "...", "count": 42 } }
{ "type": "error", "payload": { "code": "...", "message": "..." } }
{ "type": "pong" }
```

## Configuration

Environment variables (backend/.env):

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Server port |
| DATABASE_URL | postgres://... | PostgreSQL connection |
| REDIS_URL | redis://localhost:6379 | Redis connection |
| COMMENT_BATCH_INTERVAL_MS | 100 | Comment batching interval |
| REACTION_BATCH_INTERVAL_MS | 500 | Reaction aggregation interval |
| RATE_LIMIT_COMMENTS_PER_MINUTE | 30 | Global rate limit |
| RATE_LIMIT_COMMENTS_PER_STREAM | 5 | Per-stream rate limit (per 30s) |

## Testing the System

1. Open multiple browser tabs
2. Select different users in the sidebar
3. Join the same stream
4. Send comments and reactions
5. Observe real-time updates across all tabs

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.

## References & Inspiration

- [Facebook Live: Under the Hood](https://engineering.fb.com/2015/12/03/ios/under-the-hood-broadcasting-live-video-to-millions/) - Facebook's engineering approach to live video broadcasting
- [Scaling Live Video Comments at Facebook](https://engineering.fb.com/2016/04/06/android/building-live-video-broadcast-in-facebook-live/) - Real-time comment delivery for live streams
- [WebSocket at Scale](https://blog.pusher.com/websocket-at-scale-one-million-connections/) - Scaling WebSocket connections for real-time features
- [Twitter Snowflake ID Generation](https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake) - Time-ordered unique ID generation without coordination
- [Redis Pub/Sub for Real-time Messaging](https://redis.io/docs/interact/pubsub/) - Horizontal scaling of real-time comment delivery
- [Rate Limiting Strategies](https://stripe.com/blog/rate-limiters) - Stripe's approach to rate limiting at scale
- [Facebook Live Reactions](https://engineering.fb.com/2016/04/06/android/building-live-video-broadcast-in-facebook-live/) - Aggregating and displaying real-time reactions

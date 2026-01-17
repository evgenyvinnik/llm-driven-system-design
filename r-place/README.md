# r/place - Collaborative Real-time Pixel Canvas

A collaborative real-time pixel art canvas where users can place colored pixels with rate limiting. Inspired by Reddit's r/place.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 2,960 |
| Source Files | 38 |
| .ts | 1,454 |
| .md | 777 |
| .tsx | 482 |
| .json | 118 |
| .sql | 40 |

## Features

- 500x500 pixel shared canvas
- Real-time updates via WebSocket
- 16-color palette
- 30-second cooldown between pixel placements
- User authentication (or anonymous guest access)
- Canvas history and snapshots for timelapse generation
- Zoom and pan navigation

## Tech Stack

- **Frontend:** TypeScript, React 19, Vite, Zustand, Tailwind CSS
- **Backend:** Node.js, Express, WebSocket (ws)
- **Database:** PostgreSQL (pixel history, users, sessions)
- **Cache/State:** Redis (canvas state, rate limiting, pub/sub)

## Prerequisites

- Node.js 20+
- Docker and Docker Compose (for Redis and PostgreSQL)
- npm or yarn

## Getting Started

### Option 1: Using Docker (Recommended)

1. **Clone and navigate to the project:**
   ```bash
   cd r-place
   ```

2. **Start infrastructure services:**
   ```bash
   docker-compose up -d
   ```

3. **Install backend dependencies and start:**
   ```bash
   cd backend
   npm install
   npm run dev
   ```

4. **In a new terminal, install frontend dependencies and start:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

5. **Open your browser:**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3000/api

### Option 2: Native Services

If you have Redis and PostgreSQL installed locally:

1. **Configure environment (optional):**
   ```bash
   # Backend environment variables
   export REDIS_HOST=localhost
   export REDIS_PORT=6379
   export POSTGRES_HOST=localhost
   export POSTGRES_PORT=5432
   export POSTGRES_USER=your_user
   export POSTGRES_PASSWORD=your_password
   export POSTGRES_DB=rplace
   ```

2. **Initialize the database:**
   ```bash
   psql -U your_user -d rplace -f backend/init.sql
   ```

3. **Follow steps 3-5 from Option 1.**

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

Each instance shares state through Redis pub/sub.

## Project Structure

```
r-place/
├── docker-compose.yml     # Redis and PostgreSQL configuration
├── backend/
│   ├── init.sql           # Database schema
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts       # Express server entry point
│       ├── config.ts      # Canvas and rate limit configuration
│       ├── websocket.ts   # WebSocket server
│       ├── middleware/
│       │   └── auth.ts    # Authentication middleware
│       ├── routes/
│       │   ├── auth.ts    # Auth endpoints
│       │   └── canvas.ts  # Canvas endpoints
│       ├── services/
│       │   ├── auth.ts    # User authentication
│       │   ├── canvas.ts  # Canvas operations
│       │   ├── database.ts # PostgreSQL client
│       │   └── redis.ts   # Redis clients
│       └── types/
│           └── index.ts
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── components/
        │   ├── AuthPanel.tsx
        │   ├── Canvas.tsx
        │   ├── ColorPalette.tsx
        │   ├── CooldownTimer.tsx
        │   └── Toolbar.tsx
        ├── services/
        │   ├── api.ts
        │   └── websocket.ts
        ├── stores/
        │   └── appStore.ts
        └── types/
            └── index.ts
```

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Log in
- `POST /api/auth/logout` - Log out
- `GET /api/auth/me` - Get current user
- `POST /api/auth/anonymous` - Create anonymous session

### Canvas

- `GET /api/canvas/config` - Get canvas configuration
- `GET /api/canvas` - Get current canvas state (base64)
- `POST /api/canvas/pixel` - Place a pixel
- `GET /api/canvas/cooldown` - Get cooldown status
- `GET /api/canvas/pixel/:x/:y/history` - Get pixel history
- `GET /api/canvas/events` - Get recent events
- `GET /api/canvas/timelapse` - Get timelapse frames

### WebSocket

Connect to `ws://localhost:3000/ws` for real-time updates:

- **Receive:** `canvas`, `pixel`, `cooldown`, `connected`
- **Send:** `ping` (for keepalive)

## Configuration

Edit `backend/src/config.ts` to change:

- `CANVAS_WIDTH` / `CANVAS_HEIGHT` - Canvas dimensions (default: 500x500)
- `COOLDOWN_SECONDS` - Time between pixel placements (default: 30s)
- `COLOR_PALETTE` - Available colors
- `SNAPSHOT_INTERVAL_MS` - How often to save snapshots (default: 60s)

## How It Works

1. **Canvas State:** Stored as a byte array in Redis where each byte represents a pixel's color index.

2. **Pixel Placement:**
   - Validate coordinates and color
   - Check Redis for cooldown
   - Update canvas in Redis
   - Log to PostgreSQL for history
   - Publish via Redis pub/sub

3. **Real-time Updates:** WebSocket servers subscribe to Redis pub/sub and broadcast pixel changes to all connected clients.

4. **Rate Limiting:** Redis keys with TTL track per-user cooldowns.

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Testing

Open multiple browser tabs to simulate multiple users. Each anonymous session gets a unique user ID.

## Future Enhancements

- [ ] Admin interface for moderation
- [ ] Timelapse video generation
- [ ] Pixel attribution display
- [ ] Mobile-optimized interface
- [ ] WebSocket message batching
- [ ] CDN for canvas snapshots

## References & Inspiration

- [Reddit r/place Technical Retrospective](https://www.reddit.com/r/redditeng/comments/u6o8ua/rplace_technical_recap/) - Reddit engineering post-mortem
- [How We Built r/place (Reddit Blog)](https://www.reddit.com/r/announcements/comments/62mesr/place/) - Original 2017 r/place announcement
- [r/place 2022 Technical Post](https://www.redditinc.com/blog/how-we-built-rplace/) - Scaling to millions of concurrent users
- [WebSocket Scaling with Redis Pub/Sub](https://redis.io/docs/manual/pubsub/) - Real-time message broadcasting patterns
- [Rate Limiting at Scale (Figma)](https://www.figma.com/blog/an-alternative-approach-to-rate-limiting/) - Token bucket and sliding window algorithms
- [Cloudflare Rate Limiting](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) - Distributed rate limiting strategies
- [Canvas Rendering Performance (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas) - HTML5 Canvas optimization techniques
- [Redis BITFIELD for Efficient Storage](https://redis.io/commands/bitfield/) - Compact storage for pixel data
- [Building Collaborative Applications](https://www.youtube.com/watch?v=S2Hp_1jqpY8) - Real-time sync patterns
- [WebSocket at Scale (NGINX)](https://www.nginx.com/blog/websocket-nginx/) - Load balancing WebSocket connections

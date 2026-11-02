# Zoom (Video Conferencing)

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 8,910 |
| Source Files | 83 |
| .ts | 4,773 |
| .tsx | 1,881 |
| .md | 1,815 |
| .json | 146 |
| .sql | 133 |


## Overview

A video conferencing system inspired by Zoom, featuring SFU (Selective Forwarding Unit) architecture for multi-party video, screen sharing, breakout rooms, and in-call chat.

## Quick Start

### Prerequisites
- Node.js >= 20.0.0
- Docker & Docker Compose

### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure (PostgreSQL + Redis)
docker-compose up -d

# Install backend dependencies
cd backend && npm install

# Run database migration
npm run db:migrate

# Seed sample data
PGPASSWORD=zoom123 psql -h localhost -U zoom -d zoom -f db-seed/seed.sql

# Start backend (Terminal 1)
npm run dev

# Install frontend dependencies (Terminal 2)
cd ../frontend && npm install

# Start frontend
npm run dev
```

### Option B: Native Installation (No Docker)

**PostgreSQL:**
```bash
brew install postgresql@16
brew services start postgresql@16
createuser -s zoom
createdb -O zoom zoom
psql -U zoom -d zoom -c "ALTER USER zoom PASSWORD 'zoom123';"
```

**Redis/Valkey:**
```bash
brew install valkey
brew services start valkey
```

Then follow the backend/frontend steps from Option A.

### Default Credentials

| Service | Username | Password | Database |
|---------|----------|----------|----------|
| PostgreSQL | zoom | zoom123 | zoom |
| Redis/Valkey | - | - | (no auth) |

### Environment Variables (backend, all optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Browser origins allowed for CORS and the `/ws` upgrade. Add yours if the frontend runs on another port (e.g. `npm run dev -- --port 5199` needs `ALLOWED_ORIGINS=http://localhost:5199`) |
| `RECONNECT_GRACE_MS` | `10000` | How long a dropped participant keeps their seat |
| `EMPTY_MEETING_GRACE_MS` | `30000` | How long an empty meeting stays open before it ends |
| `API_RATE_LIMIT` / `AUTH_RATE_LIMIT` | `100` / `20` | Requests / failed logins per IP per 15 minutes |
| `DB_*`, `REDIS_*`, `SESSION_SECRET` | see `src/config/index.ts` | Connections |

### Test Users (after seeding)

| Username | Password | Display Name |
|----------|----------|--------------|
| alice | password123 | Alice Johnson |
| bob | password123 | Bob Smith |
| charlie | password123 | Charlie Davis |

Seeded meetings: `abc-defg-hij` (alice hosts, mute on entry), `bob-wait-rom` (bob hosts, waiting room on: sign in as alice or charlie to wait, as bob to admit), and an ended `xyz-abcd-efg` with chat history.

## Architecture

```
Frontend (React + TS)           Backend (Node.js + Express)
┌─────────────────┐            ┌──────────────────────────────┐
│  Video Grid     │            │  REST API (Express)          │
│  Control Bar    │◄──HTTP────▶│  ├── /api/auth               │
│  Chat Panel     │            │  ├── /api/meetings            │
│  Lobby          │            │  ├── /api/rooms               │
│  Breakout UI    │            │  └── /api/chat                │
│                 │            │                              │
│  WebSocket      │◄──WS─────▶│  WebSocket Handler            │
│  Client         │            │  ├── Signaling Protocol       │
│                 │            │  └── SFU Service (Simulated)  │
└─────────────────┘            └──────────┬───────────────────┘
                                          │
                               ┌──────────┴───────────────┐
                               │    PostgreSQL    Redis    │
                               └──────────────────────────┘
```

## Key Features

- **SFU Architecture**: Simulated mediasoup-style SFU with Workers, Routers, Transports, Producers, and Consumers
- **Meeting Management**: Create, schedule, join by code (abc-defg-hij format)
- **Video Grid**: Dynamic layout adapting to participant count (1x1 to 5x5)
- **Screen Sharing**: Full-screen share with strip layout for other participants
- **In-call Chat**: Real-time messages with DM support
- **Breakout Rooms**: Host can create, assign, and manage breakout rooms
- **Participant Controls**: Mute, camera, hand raise, screen share
- **Meeting Lobby**: Camera/mic preview with device selection before joining

## Available Scripts

### Backend
```bash
npm run dev              # Start development server (port 3001)
npm run dev:server1      # Start on port 3001
npm run dev:server2      # Start on port 3002
npm run dev:server3      # Start on port 3003
npm run build            # TypeScript compilation
npm run test             # Run tests
npm run test:watch       # Watch mode
npm run lint             # ESLint
npm run format           # Prettier
npm run db:migrate       # Run database migration
```

### Frontend
```bash
npm run dev              # Start Vite dev server (port 5173)
npm run build            # Production build
npm run lint             # ESLint
npm run format           # Prettier
npm run type-check       # TypeScript type checking
```

## Project Structure

```
zoom/
├── docker-compose.yml           # PostgreSQL + Redis
├── architecture.md              # System design documentation
├── CLAUDE.md                    # Development notes
├── backend/
│   ├── src/
│   │   ├── config/index.ts      # Environment configuration
│   │   ├── services/            # DB, Redis, Logger, Metrics, SFU
│   │   ├── middleware/auth.ts   # Session authentication
│   │   ├── routes/              # REST API routes
│   │   ├── websocket/handler.ts # WebSocket signaling
│   │   ├── app.ts               # Express app setup
│   │   ├── app.test.ts          # API tests
│   │   └── db/                  # Schema + migrations
│   └── db-seed/seed.sql         # Sample data
└── frontend/
    └── src/
        ├── routes/              # TanStack Router pages
        ├── components/          # React components
        ├── stores/              # Zustand state management
        ├── services/            # API + WebSocket clients
        ├── hooks/               # Custom hooks (media devices)
        └── utils/               # Formatting utilities
```

## Implementation Notes

- **SFU is simulated** — The sfuService models mediasoup concepts (Worker, Router, Transport, Producer, Consumer) without requiring native C++ compilation. The signaling protocol is fully implemented.
- **WebRTC media not exchanged** — Audio/video streams are captured locally for the lobby preview, but actual media routing between peers is simulated. The architecture is correct for production use.
- **Session auth** — Uses express-session with Redis store, for REST and for the `/ws` upgrade (the socket's identity is the session user). No OAuth/JWT complexity.
- **Host controls** — Waiting room, lock, mute/mute all, remove, co-host, transfer host and End for all are enforced server-side in `backend/src/websocket/meetingRooms.ts`.

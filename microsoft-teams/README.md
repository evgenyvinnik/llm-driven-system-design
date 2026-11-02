# Microsoft Teams - Enterprise Chat Platform

A system design study implementing an enterprise chat platform with organizations, teams, channels, threaded messaging, file sharing, emoji reactions, and presence indicators.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 8,578 |
| Source Files | 90 |
| .ts | 4,597 |
| .tsx | 1,803 |
| .md | 1,555 |
| .sql | 261 |
| .json | 164 |


## Architecture

See [architecture.md](./architecture.md) for the full system design documentation.

## Quick Start

### Prerequisites
- Node.js >= 20.0.0
- Docker Desktop (for PostgreSQL, Valkey, MinIO)

### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure
docker-compose up -d

# Backend setup
cd backend
npm install
npm run db:migrate
# Seed users, orgs, teams, channels and messages (password123 for everyone)
cat db-seed/seed.sql | docker exec -i teams-postgres psql -U teams -d teams
npm run dev

# Frontend setup (new terminal)
cd frontend
npm install
npm run dev
```

### Option B: Native Installation (No Docker)

```bash
# PostgreSQL
brew install postgresql@16
brew services start postgresql@16
createdb teams
psql teams -c "CREATE USER teams WITH PASSWORD 'teams123';"
psql teams -c "GRANT ALL PRIVILEGES ON DATABASE teams TO teams;"

# Valkey (Redis-compatible)
brew install valkey
brew services start valkey

# MinIO
brew install minio
minio server ~/minio-data --console-address ":9001"
```

Then follow the backend/frontend setup steps above.

### Access the Application

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:3001 |
| MinIO Console | http://localhost:9001 |
| Health Check | http://localhost:3001/api/health |
| Metrics | http://localhost:3001/metrics |

### Default Credentials

| Service | Username | Password |
|---------|----------|----------|
| PostgreSQL | teams | teams123 |
| MinIO | minioadmin | minioadmin |
| Valkey | - | (no auth) |

## Getting Started

Sign in as one of the seeded users (password `password123` for all of them). Each one shows a different part of the access model:

| User | What they show |
|------|----------------|
| `alice` | Owner of Acme, Engineering and the private Leadership team. Member of the private `#incident-response` channel. Has 2 unread messages in `#deployments`. She can't leave Engineering until someone else is an owner. |
| `bob` | On Engineering but not in `#incident-response`: it isn't in his channel list, and its URL says he has no access. |
| `carol` | Owns Design and is the only member of a second org, Globex. She isn't on Engineering, so opening it shows a "Join team" panel. |
| `dave` | In `#incident-response`. Remove him from it and his open stream closes. |

Or start fresh: register at http://localhost:5173/register, create an organization, create a team with the **+** next to the team picker (a "General" channel is created with it), and start chatting. Open a second browser window as another user to watch messages, edits, deletions and reactions arrive live.

Access rules in short: you see an organization only if you're in it, and a channel only if you're on its team (and, for a private channel, in the channel). Anything else is a 404. See [architecture.md](./architecture.md#organization-hierarchy).

## Environment Variables

```bash
# Backend
DATABASE_URL=postgresql://teams:teams123@localhost:5432/teams
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=teams-files
SESSION_SECRET=teams-dev-secret-change-in-production
CORS_ORIGIN=http://localhost:5173
PORT=3001
```

## Available Scripts

### Backend
```bash
npm run dev          # Start dev server with hot reload
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002 (a second instance: SSE fan-out goes through Redis pub/sub)
npm run dev:server3  # Port 3003
npm run build        # Compile TypeScript
npm run test         # Run unit + route tests (vitest, no Docker needed)
npm run lint         # Run ESLint
npm run format       # Run Prettier
npm run db:migrate   # Run database migrations
```

### Frontend
```bash
npm run dev          # Start Vite dev server (port 5173)
npm run build        # Production build
npm run lint         # Run ESLint
npm run format       # Run Prettier
npm run type-check   # TypeScript type checking
```

## Features

- **Organizations**: Create and manage organizations with owner/admin/member roles
- **Teams**: Create, join (public), leave teams; private teams are invisible to non-members; every team keeps an owner
- **Channels**: Public channels open to the whole team, private channels by invitation, unread badges
- **Messaging**: Real-time chat with editing, soft deletion, idempotent sends, and "load older" pagination
- **Threading**: Reply to messages in side-panel threads
- **Reactions**: Emoji reactions on messages
- **File Sharing**: Attach files to messages (MinIO); downloads only for channel members
- **Presence**: Online/offline indicators with heartbeat tracking
- **User Search**: Find and add users to teams/channels

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, TanStack Router, Zustand, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 16 |
| Cache/Pub-Sub | Valkey (Redis-compatible) |
| File Storage | MinIO (S3-compatible) |
| Real-Time | Server-Sent Events (SSE) |
| Auth | express-session + connect-redis |
| Metrics | prom-client (Prometheus) |
| Logging | Pino |

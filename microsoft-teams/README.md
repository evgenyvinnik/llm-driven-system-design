# Microsoft Teams - Enterprise Chat Platform

A system design study implementing an enterprise chat platform with organizations, teams, channels, threaded messaging, file sharing, emoji reactions, and presence indicators.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,878 |
| Source Files | 81 |
| .ts | 2,521 |
| .md | 1,445 |
| .tsx | 1,331 |
| .sql | 220 |
| .json | 163 |


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

1. Register a new account at http://localhost:5173/register
2. Create an organization
3. Create a team (a "General" channel is auto-created)
4. Start chatting!

To test multi-user chat, open a second browser window and register another account.

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
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
npm run build        # Compile TypeScript
npm run test         # Run tests
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

- **Organizations**: Create and manage organizations with member roles
- **Teams**: Create teams within organizations (public/private)
- **Channels**: Topic-based channels within teams
- **Messaging**: Real-time chat with message editing and deletion
- **Threading**: Reply to messages in side-panel threads
- **Reactions**: Emoji reactions on messages
- **File Sharing**: Upload and download files via MinIO
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

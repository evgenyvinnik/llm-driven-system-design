# Gmail (Email Client)

An email client system design project featuring thread-based messaging, per-user state management, full-text search with Elasticsearch, and draft conflict detection via optimistic locking.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 8,121 |
| Source Files | 73 |
| .ts | 4,202 |
| .tsx | 1,687 |
| .md | 1,592 |
| .sql | 308 |
| .json | 152 |


## Features

- **Thread-based email**: Messages grouped into conversation threads
- **Per-user state**: Each user has independent read/starred/archived/trashed state per thread
- **Label system**: System labels (INBOX, SENT, TRASH, etc.) + custom user labels
- **Full-text search**: Elasticsearch-powered search with privacy (per-user visibility)
- **Advanced search operators**: `from:`, `to:`, `has:attachment`, `before:`, `after:`
- **Draft management**: Auto-save with optimistic locking to detect conflicts
- **Contact autocomplete**: Frequency-based contact suggestions
- **Compose with CC/BCC**: Full email composition support

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 16 |
| Cache | Valkey (Redis-compatible) |
| Search | Elasticsearch 8.11 |
| Monitoring | Prometheus (prom-client) |

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- Docker Desktop (for infrastructure)

### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure (PostgreSQL, Valkey, Elasticsearch)
docker-compose up -d

# Wait for Elasticsearch to be ready (~30 seconds)
curl -s http://localhost:9200/_cluster/health | grep -q '"status":"green\|yellow"'

# Install backend dependencies and run migrations
cd backend
npm install
npm run db:migrate

# Seed demo data
PGPASSWORD=gmail123 psql -h localhost -U gmail -d gmail -f db-seed/seed.sql

# Start backend API server
npm run dev:server1

# In another terminal, start the search indexer worker
npm run dev:worker

# In another terminal, install and start frontend
cd frontend
npm install
npm run dev
```

### Option B: Native Installation (No Docker)

**PostgreSQL:**
```bash
brew install postgresql@16
brew services start postgresql@16
createdb gmail
psql -d gmail -c "CREATE USER gmail WITH PASSWORD 'gmail123';"
psql -d gmail -c "GRANT ALL PRIVILEGES ON DATABASE gmail TO gmail;"
```

**Valkey (Redis-compatible):**
```bash
brew install valkey
brew services start valkey
```

**Elasticsearch:**
```bash
brew install elastic/tap/elasticsearch-full
brew services start elasticsearch-full
```

Then follow the same backend/frontend setup steps as Option A.

### Demo Accounts

| Username | Password | Email |
|----------|----------|-------|
| alice | password123 | alice@gmail.local |
| bob | password123 | bob@gmail.local |
| charlie | password123 | charlie@gmail.local |

### Environment Variables

```bash
# Backend (defaults work with Docker Compose)
DATABASE_URL=postgresql://gmail:gmail123@localhost:5432/gmail
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_URL=http://localhost:9200
SESSION_SECRET=gmail-dev-session-secret
PORT=3001
```

## Port Conventions

| Port | Service |
|------|---------|
| 5173 | Frontend (Vite dev server) |
| 3001 | Backend API |
| 5432 | PostgreSQL |
| 6379 | Valkey/Redis |
| 9200 | Elasticsearch |

## Available Scripts

### Backend

```bash
npm run dev           # Start API server with hot reload
npm run dev:server1   # Start on port 3001
npm run dev:server2   # Start on port 3002
npm run dev:worker    # Start search indexer worker
npm run db:migrate    # Run database migrations
npm run test          # Run tests
npm run lint          # Run ESLint
npm run format        # Run Prettier
```

### Frontend

```bash
npm run dev           # Start Vite dev server
npm run build         # Build for production
npm run lint          # Run ESLint
npm run format        # Run Prettier
```

## Architecture Highlights

- **Thread model**: Per-user state via `thread_user_state` table enables independent read/starred/archived state
- **Search privacy**: Elasticsearch `visible_to` field ensures users only see their own emails
- **Draft conflicts**: Optimistic locking with version column prevents silent data loss from multi-tab editing
- **Contact autocomplete**: Frequency-based ranking surfaces most-contacted people first

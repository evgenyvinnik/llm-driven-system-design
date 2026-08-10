# Excalidraw - Collaborative Whiteboard

A collaborative whiteboard application inspired by [Excalidraw](https://excalidraw.com/), built to explore real-time collaboration, canvas rendering, and shape-level CRDT conflict resolution.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,963 |
| Source Files | 65 |
| .ts | 3,667 |
| .tsx | 1,475 |
| .md | 1,340 |
| .json | 155 |
| .sql | 148 |


## Key Learning Goals

- **Canvas rendering**: HTML5 Canvas API with pan/zoom transforms
- **Shape-level CRDT**: Last-Writer-Wins merge for concurrent element edits
- **Real-time collaboration**: WebSocket rooms for multi-user editing
- **Cursor presence**: Live cursor tracking across collaborators

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 16 (schemas, JSONB elements) |
| Cache | Valkey 7 (sessions, cursor presence) |
| Real-time | WebSocket (ws library) |
| Monitoring | Prometheus (prom-client), Pino structured logging |

## Setup

### Option A: Docker Compose (Recommended)

```bash
# Start PostgreSQL and Valkey
docker-compose up -d

# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Run database migration
cd ../backend && npm run db:migrate

# (Optional) Seed demo data
PGPASSWORD=excalidraw123 psql -h localhost -U excalidraw -d excalidraw -f db-seed/seed.sql
```

### Option B: Native Installation

```bash
# PostgreSQL
brew install postgresql@16
brew services start postgresql@16
createuser -s excalidraw
createdb -O excalidraw excalidraw
psql -d excalidraw -c "ALTER USER excalidraw PASSWORD 'excalidraw123';"

# Valkey/Redis
brew install valkey
brew services start valkey

# Install and migrate
cd backend && npm install && npm run db:migrate
cd ../frontend && npm install
```

## Running

```bash
# Terminal 1: Start backend (port 3001)
cd backend
npm run dev:server1

# Terminal 2: Start frontend (port 5173)
cd frontend
npm run dev
```

Open http://localhost:5173 in your browser.

### Demo Accounts

| Username | Password |
|----------|----------|
| alice | password123 |
| bob | password123 |

### Running Tests

```bash
cd backend
npm test
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Backend server port |
| POSTGRES_HOST | localhost | PostgreSQL host |
| POSTGRES_PORT | 5432 | PostgreSQL port |
| POSTGRES_DB | excalidraw | Database name |
| POSTGRES_USER | excalidraw | Database user |
| POSTGRES_PASSWORD | excalidraw123 | Database password |
| REDIS_HOST | localhost | Valkey/Redis host |
| REDIS_PORT | 6379 | Valkey/Redis port |
| SESSION_SECRET | excalidraw-dev-session-secret | Session encryption key |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| V | Select tool |
| R | Rectangle |
| O | Ellipse |
| D | Diamond |
| A | Arrow |
| L | Line |
| P | Freehand draw |
| T | Text |
| Delete/Backspace | Delete selected |
| Escape | Deselect / Select tool |
| Ctrl/Cmd+S | Save drawing |
| Space+Drag | Pan canvas |
| Scroll wheel | Zoom in/out |
| Middle mouse | Pan canvas |

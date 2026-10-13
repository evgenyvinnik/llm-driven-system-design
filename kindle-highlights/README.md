# Design Kindle Community Highlights - Social Reading Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,591 |
| Source Files | 50 |
| .ts | 2,320 |
| .md | 1,685 |
| .tsx | 1,140 |
| .json | 155 |
| .sql | 130 |


## Overview

A social reading platform similar to Kindle's Popular Highlights feature, where users can highlight passages while reading books, see what others have highlighted, and discover popular quotes and insights from the community. This educational project focuses on real-time sync, aggregation at scale, and privacy-preserving social features.

## Implementation Status

| Component | Status |
|-----------|--------|
| Backend - Highlight Service | ✅ Complete |
| Backend - Sync Service (WebSocket) | ✅ Complete |
| Backend - Aggregation Service | ✅ Complete |
| Backend - Social Service | ✅ Complete |
| Frontend - React SPA | ✅ Complete |
| Database Migrations | ✅ Complete |
| Docker Compose | ✅ Complete |

## Quick Start

### Prerequisites

- Node.js 22+
- Docker and Docker Compose (for PostgreSQL and Redis)

### 1. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

### 2. Backend Setup

```bash
cd backend
npm install
npm run db:migrate
npm run db:seed  # Optional: adds demo data
npm run dev
```

This starts four services and the aggregation worker:
- **Highlight Service**: Port 3000 - CRUD, library, search, export
- **Social Service**: Port 3001 - Auth, following, sharing, privacy settings
- **Sync Service**: Port 3002 - change feed, offline push, WebSocket pokes
- **Aggregation Service**: Port 3003 - Popular, trending, heatmap (privacy-thresholded)
- **Aggregation worker** - drains the outbox and republishes popular passages

`npm run db:seed` is re-runnable. Popular passages appear after the worker's first cycle (a few seconds).

### 3. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Opens at http://localhost:5173

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

### Services Overview

The Vite dev server routes each `/api/*` path to the service that owns it (see `frontend/vite.config.ts`).

```
┌──────────────────────────────────────────────────────────────────────┐
│ React SPA · http://localhost:5173 · Vite proxy routes /api/*         │
└───────┬─────────────────┬─────────────────┬─────────────────┬────────┘
        ▼                 ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Highlight     │ │ Social        │ │ Sync          │ │ Aggregation   │
│ :3000 · CRUD  │ │ :3001 · auth, │ │ :3002 · pull, │ │ :3003 ·       │
│ search export │ │ follows       │ │ push, WS      │ │ popular       │
└───────┬───────┘ └───────┬───────┘ └───────┬───────┘ └───────┬───────┘
        ▼                 ▼                 ▼                 ▼
┌──────────────────────────────────────┐ ┌─────────────────────────────┐
│ PostgreSQL :5432 · highlights, feed  │ │ Valkey :6379 · sessions,    │
│ sequence, outbox, popular_highlights │ │ pub/sub pokes, read cache   │
└──────────────────▲───────────────────┘ └─────────────────────────────┘
                   │ recount books from aggregation_outbox
          ┌────────┴────────────────┐
          │ Aggregation worker      │
          └─────────────────────────┘
```

## API Endpoints

### Highlight Service (Port 3000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| POST | /api/highlights | Create; send a client-generated `id` (or `Idempotency-Key`); a retry answers 200 `Idempotent-Replayed` |
| GET | /api/highlights | List my highlights (`bookId`, `search`, `limit`, `offset`) |
| GET | /api/highlights/:id | Get highlight (410 if deleted) |
| PATCH | /api/highlights/:id | Update note/color/visibility; per-field last-writer-wins on `clientUpdatedAt` |
| DELETE | /api/highlights/:id | Delete (tombstone, idempotent) |
| GET | /api/export/highlights | Export (`format` = markdown, csv or json) |
| GET | /api/library | My books with highlight counts |

### Sync Service (Port 3002)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/sync/changes | Changes after a cursor: `{changes, cursor, hasMore, resync}` |
| POST | /api/sync/push | Apply a device's offline ops (`create`/`update`/`delete`), one result per op |
| WS | /api/sync/ws | First message `{type:"hello", token, deviceId}`; receives `{type:"changed", seq}` |
| GET | /health | Connection count and fan-out status |

### Aggregation Service (Port 3003)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Outbox backlog and worker heartbeat age |
| GET | /api/books/:bookId/popular | Popular passages (only with at least `POPULAR_MIN_READERS` readers) |
| GET | /api/trending | Published passages with a recent reader (`days`, `limit`) |
| GET | /api/books/:bookId/heatmap | Reader counts of published passages |
| GET | /api/books/:bookId/count | Readers for a location range (`null` below the threshold) |

### Social Service (Port 3001)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Register user |
| POST | /api/auth/login | Login |
| POST | /api/auth/logout | Revoke the session |
| GET | /api/auth/me | Current user |
| POST | /api/users/:userId/follow | Follow user |
| DELETE | /api/users/:userId/follow | Unfollow user |
| GET | /api/following | Users I follow |
| GET | /api/followers | My followers |
| GET | /api/books/:bookId/friends-highlights | Public highlights of people I follow, plus friends-only ones if the follow is mutual |
| POST | /api/highlights/:id/share | Share highlight |
| GET | /api/settings/privacy | Privacy settings |
| PATCH | /api/settings/privacy | Update privacy (opting out triggers a recount) |

## Demo Credentials

After running `npm run db:seed`:

| Email | Password |
|-------|----------|
| alice@example.com | password123 |
| bob@example.com | password123 |
| charlie@example.com | password123 |
| reader01@example.com … reader09@example.com | password123 |

## Key Features

### 1. Highlighting & Annotation
- Create highlights with text selection
- Add personal notes
- Choose highlight colors (yellow, orange, blue, green, pink)
- Edit and delete highlights

### 2. Community Highlights
- View popular highlights in books
- "X readers highlighted this" indicator
- Trending highlights across all books
- Filter by time period

### 3. Personal Library
- All highlights across all books
- Search by keyword
- Export (Markdown, CSV, JSON)

### 4. Social Features
- Follow other readers
- See friends' highlights
- Share highlights externally
- Privacy controls

### 5. Real-time Sync
- Per-user change feed: devices pull `changes since <cursor>`; gap-free sequence numbers
- Offline outbox pushed in batches; every operation is idempotent
- WebSocket pokes ("your feed moved") across service instances via Redis pub/sub

## Development

### Running Individual Services

```bash
# Run specific service
npm run dev:highlight    # Port 3000
npm run dev:social       # Port 3001
npm run dev:sync         # Port 3002
npm run dev:aggregation  # Port 3003
npm run dev:worker       # Aggregation background job
npm test                 # vitest unit and endpoint tests (no database needed)
```

### Environment Variables

```bash
# Backend
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/highlights
REDIS_URL=redis://localhost:6379
HIGHLIGHT_PORT=3000
SOCIAL_PORT=3001
SYNC_PORT=3002
AGGREGATION_PORT=3003
POPULAR_MIN_READERS=5          # privacy threshold (never below 2)
AGGREGATION_INTERVAL=10000     # worker cycle, ms
RECONCILE_INTERVAL=21600000    # requeue every book, ms
TOMBSTONE_RETENTION_DAYS=90    # older cursors must resync
SYNC_HEARTBEAT_MS=30000        # WebSocket ping interval

# Frontend dev proxy targets (optional)
HIGHLIGHT_URL=http://localhost:3000
SOCIAL_URL=http://localhost:3001
SYNC_URL=http://localhost:3002
AGGREGATION_URL=http://localhost:3003
```

## Key Technical Challenges

1. **Real-time Sync**: Propagate highlights across devices within 2 seconds
2. **Aggregation Scale**: Count highlights across millions of readers
3. **Privacy**: Community highlights without revealing individual identities
4. **Offline Support**: Queue highlights and sync when online
5. **Conflict Resolution**: Handle simultaneous highlights on multiple devices

## Resources

- [Offline-First Web Development](https://developers.google.com/codelabs/pwa-offline-quickstart)
- [CRDTs: Conflict-free Replicated Data Types](https://crdt.tech/)
- [Local-First Software](https://www.inkandswitch.com/local-first/)
- [Figma's Multiplayer Technology](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and design decisions.

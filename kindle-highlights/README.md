# Design Kindle Community Highlights - Social Reading Platform

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

This starts four services:
- **Highlight Service**: Port 3001 - CRUD operations for highlights
- **Sync Service**: Port 3002 - WebSocket real-time sync
- **Aggregation Service**: Port 3003 - Popular highlights API
- **Social Service**: Port 3004 - Auth, following, sharing

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

```
┌────────────────────────────────────────────────────────────────┐
│                      Frontend (React SPA)                       │
│                     http://localhost:5173                        │
└────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Highlight       │  │ Sync Service    │  │ Aggregation     │
│ Service :3001   │  │ :3002           │  │ Service :3003   │
│                 │  │                 │  │                 │
│ • CRUD          │  │ • WebSocket     │  │ • Popular       │
│ • Search        │  │ • Real-time     │  │   highlights    │
│ • Export        │  │ • Offline queue │  │ • Trending      │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
         ┌────────────────────┴────────────────────┐
         ▼                                         ▼
┌─────────────────────┐              ┌─────────────────────┐
│    PostgreSQL       │              │       Redis         │
│    :5432            │              │       :6379         │
│                     │              │                     │
│ • Users             │              │ • Sessions          │
│ • Highlights        │              │ • Aggregation       │
│ • Books             │              │   counters          │
│ • Popular           │              │ • Sync queues       │
│   highlights        │              │ • Cache             │
└─────────────────────┘              └─────────────────────┘
```

## API Endpoints

### Highlight Service (Port 3001)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| POST | /api/highlights | Create highlight |
| GET | /api/highlights | List user highlights |
| GET | /api/highlights/:id | Get highlight |
| PATCH | /api/highlights/:id | Update highlight |
| DELETE | /api/highlights/:id | Delete highlight |
| GET | /api/export/highlights | Export highlights |
| GET | /api/library | Get user's books with counts |

### Sync Service (Port 3002)

| Endpoint | Type | Description |
|----------|------|-------------|
| /sync | WebSocket | Real-time sync connection |
| /health | GET | Health check with connection count |

### Aggregation Service (Port 3003)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /api/books/:bookId/popular | Popular highlights for book |
| GET | /api/trending | Trending highlights |
| GET | /api/books/:bookId/heatmap | Highlight density map |

### Social Service (Port 3004)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Register user |
| POST | /api/auth/login | Login |
| GET | /api/auth/me | Current user |
| POST | /api/users/:userId/follow | Follow user |
| DELETE | /api/users/:userId/follow | Unfollow user |
| GET | /api/following | Users I follow |
| GET | /api/followers | My followers |
| GET | /api/books/:bookId/friends-highlights | Friends' highlights |
| POST | /api/highlights/:id/share | Share highlight |
| GET | /api/settings/privacy | Privacy settings |
| PATCH | /api/settings/privacy | Update privacy |

## Demo Credentials

After running `npm run db:seed`:

| Email | Password |
|-------|----------|
| alice@example.com | password123 |
| bob@example.com | password123 |
| charlie@example.com | password123 |

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
- WebSocket-based sync
- Offline queue for disconnected devices
- Cross-device synchronization

## Development

### Running Individual Services

```bash
# Run specific service
npm run dev:highlight    # Port 3001
npm run dev:sync         # Port 3002
npm run dev:aggregation  # Port 3003
npm run dev:social       # Port 3004
npm run dev:worker       # Aggregation background job
```

### Environment Variables

```bash
# Backend
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/highlights
REDIS_URL=redis://localhost:6379
HIGHLIGHT_PORT=3001
SYNC_PORT=3002
AGGREGATION_PORT=3003
SOCIAL_PORT=3004
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

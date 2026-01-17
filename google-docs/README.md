# Google Docs Clone - Collaborative Document Editing

A real-time collaborative document editing platform built with React, Node.js, WebSocket, and PostgreSQL. This project implements core Google Docs features including rich text editing, real-time collaboration using Operational Transformation (OT), comments, and version history.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,066 |
| Source Files | 47 |
| .ts | 3,094 |
| .tsx | 1,549 |
| .md | 935 |
| .css | 163 |
| .json | 130 |

## Key Features

- **Rich Text Editing** - Full formatting support with TipTap/ProseMirror
- **Real-time Collaboration** - Multiple users editing simultaneously via WebSocket
- **Comments & Replies** - Threaded comment discussions
- **Version History** - Track and restore document versions
- **Sharing & Permissions** - View, comment, and edit access levels
- **User Authentication** - Session-based auth with Redis

## Technology Stack

- **Frontend**: TypeScript, Vite, React 18, TipTap, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, WebSocket (ws)
- **Database**: PostgreSQL 16
- **Cache/Sessions**: Redis 7
- **Real-time Sync**: Operational Transformation (OT)

## Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose (for PostgreSQL and Redis)

## Quick Start

### 1. Start Infrastructure (Docker)

```bash
cd google-docs
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

The database is automatically initialized with schema and seed data.

### 2. Start Backend

```bash
cd backend
npm install
npm run dev
```

Backend runs on http://localhost:3001

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173

### 4. Access the Application

Open http://localhost:5173 in your browser.

**Demo Accounts** (password: `password` for all):
- alice@example.com
- bob@example.com
- admin@example.com

## Running Multiple Backend Instances

To test distributed behavior:

```bash
# Terminal 1
cd backend && npm run dev:server1  # Port 3001

# Terminal 2
cd backend && npm run dev:server2  # Port 3002

# Terminal 3
cd backend && npm run dev:server3  # Port 3003
```

## Native Services (Without Docker)

If you prefer running PostgreSQL and Redis natively:

### PostgreSQL

```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16

# Create database
createdb googledocs
psql googledocs -c "CREATE USER googledocs WITH PASSWORD 'googledocs_secret';"
psql googledocs -c "GRANT ALL PRIVILEGES ON DATABASE googledocs TO googledocs;"
psql googledocs < backend/db/init.sql
```

### Redis

```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

### Environment Variables

Create `backend/.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=googledocs
DB_PASSWORD=googledocs_secret
DB_NAME=googledocs
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

## Project Structure

```
google-docs/
├── backend/
│   ├── src/
│   │   ├── index.ts          # Server entry point
│   │   ├── routes/           # REST API routes
│   │   │   ├── auth.ts       # Authentication
│   │   │   ├── documents.ts  # Document CRUD
│   │   │   ├── comments.ts   # Comments
│   │   │   ├── suggestions.ts# Suggestions
│   │   │   └── versions.ts   # Version history
│   │   ├── services/
│   │   │   ├── collaboration.ts # WebSocket handling
│   │   │   └── ot.ts         # Operational Transformation
│   │   ├── middleware/
│   │   │   └── auth.ts       # Auth middleware
│   │   ├── utils/
│   │   │   ├── db.ts         # PostgreSQL connection
│   │   │   └── redis.ts      # Redis connection
│   │   └── types/
│   │       └── index.ts      # TypeScript types
│   └── db/
│       └── init.sql          # Database schema
├── frontend/
│   ├── src/
│   │   ├── App.tsx           # Main app with routing
│   │   ├── routes/           # Page components
│   │   ├── components/       # UI components
│   │   ├── stores/           # Zustand stores
│   │   ├── services/         # API & WebSocket
│   │   └── types/            # TypeScript types
│   └── index.html
├── docker-compose.yml
└── README.md
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Documents
- `GET /api/documents` - List user's documents
- `POST /api/documents` - Create document
- `GET /api/documents/:id` - Get document
- `PATCH /api/documents/:id` - Update document
- `DELETE /api/documents/:id` - Delete document
- `POST /api/documents/:id/share` - Share document

### Comments
- `GET /api/documents/:id/comments` - List comments
- `POST /api/documents/:id/comments` - Add comment
- `PATCH /api/documents/:id/comments/:commentId` - Update/resolve
- `DELETE /api/documents/:id/comments/:commentId` - Delete

### Version History
- `GET /api/documents/:id/versions` - List versions
- `POST /api/documents/:id/versions` - Create named version
- `POST /api/documents/:id/versions/:num/restore` - Restore version

### WebSocket Protocol

Connect to `ws://localhost:3001/ws?token=<session_token>`

Messages:
```typescript
// Subscribe to document
{ type: "SUBSCRIBE", doc_id: "..." }

// Send operation
{ type: "OPERATION", doc_id: "...", version: 5, operation: [...] }

// Cursor update
{ type: "CURSOR", doc_id: "...", cursor: { position: 42 } }
```

## Implementation Status

- [x] Database schema and seed data
- [x] User authentication (register, login, logout)
- [x] Document CRUD operations
- [x] Rich text editor with TipTap
- [x] WebSocket collaboration infrastructure
- [x] Operational Transformation engine
- [x] Presence awareness (cursors)
- [x] Comments and replies
- [x] Version history
- [x] Document sharing
- [ ] Full OT integration with editor
- [ ] Offline support
- [ ] Suggestions/track changes
- [ ] Export (PDF, DOCX)

## Architecture

See [architecture.md](./architecture.md) for detailed system design.

Key design decisions:
- **Operational Transformation** for concurrent editing (vs CRDT for lower memory)
- **Sticky sessions** by document ID for efficient WebSocket handling
- **Redis pub/sub** for cross-server operation broadcasting
- **Periodic snapshots** with operation logs for version history

## Development Notes

See [claude.md](./claude.md) for development history and design decisions.

## Future Enhancements

- Offline editing with IndexedDB queue
- Peer-to-peer sync fallback
- Document templates
- Rich embeds (images, tables, drawings)
- Export to multiple formats
- Mobile-optimized editor

## References & Inspiration

- [Operational Transformation FAQ](https://www3.ntu.edu.sg/home/czsun/projects/otfaq/) - Comprehensive overview of OT algorithms and implementations
- [High-Latency, Low-Bandwidth Windowing in the Jupiter Collaboration System](https://dl.acm.org/doi/10.1145/215585.215706) - Original Jupiter OT paper from Xerox PARC
- [Google Wave Operational Transformation](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/operational-transform/operational-transform.html) - Google's OT implementation for Wave
- [CRDTs: Consistency without Consensus](https://crdt.tech/) - Alternative approach to collaborative editing
- [Convergent and Commutative Replicated Data Types](https://hal.inria.fr/inria-00555588/document) - Shapiro et al. paper on CRDT foundations
- [ProseMirror Collaborative Editing](https://prosemirror.net/docs/guide/#collab) - Guide on building collaborative editors
- [Yjs: Shared Editing with CRDTs](https://yjs.dev/) - CRDT library for real-time collaboration
- [Real Differences between OT and CRDT for Co-Editors](https://arxiv.org/abs/1810.02137) - Academic comparison of approaches
- [Designing Data-Intensive Applications](https://dataintensive.net/) - Martin Kleppmann's book covering replication and consistency

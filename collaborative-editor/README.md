# Design Collaborative Editor - Real-Time Document Editing

## Overview

A collaborative document editing system enabling multiple users to edit documents simultaneously with real-time synchronization, conflict resolution, and presence indicators. This educational project focuses on building a Google Docs-like experience with Operational Transformation (OT) based synchronization.

## Key Features

### 1. Real-Time Collaboration
- Multiple concurrent editors
- Live cursor positions
- Real-time text updates
- Presence indicators

### 2. Conflict Resolution
- Operational Transformation (OT) algorithm
- Server-authoritative ordering
- Intent preservation
- Automatic conflict resolution

### 3. Document Management
- Create and list documents
- Document persistence
- Version tracking
- Snapshots for efficient loading

### 4. User Experience
- Clean, minimal interface
- Connection status indicators
- Sync status display
- User color coding

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + WebSocket (ws)
- **Database:** PostgreSQL (documents, operations, snapshots)
- **Cache:** Redis (presence, real-time state)

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for databases)
- npm or pnpm

### 1. Start Infrastructure

```bash
# From the collaborative-editor directory
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

### 2. Start Backend Server

```bash
cd backend
npm install
npm run dev
```

The backend runs on http://localhost:3001

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend runs on http://localhost:5173

### 4. Open Multiple Browser Tabs

1. Open http://localhost:5173 in multiple browser tabs
2. Select different users in each tab
3. Open the same document
4. Start typing to see real-time collaboration

## Running Without Docker

If you prefer to run PostgreSQL and Redis natively:

### PostgreSQL Setup

```bash
# Install PostgreSQL (macOS)
brew install postgresql@16
brew services start postgresql@16

# Create database and user
createuser -s collab
createdb collaborative_editor -O collab

# Run the init script
psql -U collab -d collaborative_editor -f backend/init.sql
```

### Redis Setup

```bash
# Install Redis (macOS)
brew install redis
brew services start redis
```

### Environment Variables

Create `backend/.env`:

```env
PORT=3001
DB_USER=collab
DB_PASSWORD=collab123
DB_HOST=localhost
DB_PORT=5432
DB_NAME=collaborative_editor
REDIS_URL=redis://localhost:6379
CORS_ORIGIN=http://localhost:5173
```

## Project Structure

```
collaborative-editor/
├── architecture.md           # System design documentation
├── claude.md                 # Development notes
├── docker-compose.yml        # Infrastructure setup
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── init.sql              # Database schema
│   └── src/
│       ├── index.ts          # Entry point
│       ├── routes/
│       │   └── api.ts        # REST endpoints
│       ├── services/
│       │   ├── TextOperation.ts    # OT operation class
│       │   ├── OTTransformer.ts    # Transform & compose
│       │   ├── DocumentState.ts    # Document state manager
│       │   ├── SyncServer.ts       # WebSocket server
│       │   ├── database.ts         # PostgreSQL client
│       │   └── redis.ts            # Redis client
│       └── types/
│           └── index.ts      # TypeScript types
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx          # Entry point
        ├── App.tsx           # Main app component
        ├── index.css         # Global styles
        ├── components/
        │   ├── TextEditor.tsx      # Main editor
        │   ├── UserList.tsx        # Collaborator list
        │   ├── Header.tsx          # Top bar
        │   ├── DocumentList.tsx    # Document picker
        │   └── UserSelector.tsx    # User switcher
        ├── services/
        │   ├── TextOperation.ts    # Client OT
        │   ├── OTTransformer.ts    # Client transform
        │   └── api.ts              # REST client
        ├── stores/
        │   └── editorStore.ts      # Zustand state
        └── types/
            └── index.ts      # TypeScript types
```

## How It Works

### Operational Transformation (OT)

OT is an algorithm for handling concurrent document edits. When two users make edits at the same time:

1. Each client applies their change locally for instant feedback
2. Changes are sent to the server with a version number
3. The server transforms incoming operations against any concurrent ops
4. Transformed operations are broadcast to all clients
5. Clients transform remote operations against their pending local ops
6. All clients converge to the same document state

### Operation Types

- **Retain(n)**: Skip n characters (used for positioning)
- **Insert(str)**: Insert string at current position
- **Delete(n)**: Delete n characters at current position

### Example

If Alice types "Hello" at position 0, and Bob types "World" at position 0 simultaneously:

1. Alice's operation: `Insert("Hello")`
2. Bob's operation: `Insert("World")`
3. Server receives Alice's first, applies it
4. Server transforms Bob's against Alice's: `Retain(5), Insert("World")`
5. Result: "HelloWorld" (deterministic ordering)

## API Endpoints

### REST API

- `GET /api/documents` - List all documents
- `GET /api/documents/:id` - Get document metadata
- `POST /api/documents` - Create new document
- `PATCH /api/documents/:id` - Update document title
- `GET /api/users` - List all users
- `GET /api/users/:id` - Get user info

### WebSocket Protocol

Connect to: `ws://localhost:3001/ws?documentId=<id>&userId=<id>`

Messages:
- `init` - Initial document state and client list
- `operation` - Send/receive operations
- `ack` - Server acknowledged operation
- `cursor` - Cursor position updates
- `client_join` / `client_leave` - Presence updates
- `resync` - Full resync on error

## Testing Collaboration

1. Open the app in two browser windows side by side
2. Select different users (Alice, Bob, Charlie)
3. Open the same document in both windows
4. Type in one window and watch changes appear in the other
5. Try typing simultaneously to see conflict resolution

## Implementation Status

- [x] Core OT algorithm (insert, delete, retain)
- [x] Transform and compose functions
- [x] WebSocket sync server
- [x] Client sync engine with pending operations
- [x] PostgreSQL persistence (operations, snapshots)
- [x] Redis presence tracking
- [x] Text editor with real-time updates
- [x] User presence indicators
- [x] Cursor position tracking
- [x] Document creation and listing
- [ ] Rich text formatting
- [ ] Comments and suggestions
- [ ] Version history UI
- [ ] Offline support

## Key Technical Challenges

1. **Consistency**: OT ensures all clients converge to identical state
2. **Latency**: Optimistic local updates with server reconciliation
3. **Conflicts**: Transform function handles concurrent edits
4. **Scale**: Designed to support 50+ simultaneous editors
5. **Durability**: Operations logged for complete history

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

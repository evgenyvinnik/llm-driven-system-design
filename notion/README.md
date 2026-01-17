# Design Notion - Block-Based Collaboration

## Overview

A simplified Notion-like platform demonstrating block-based editing, real-time collaboration, and workspace hierarchy. This educational project focuses on building a flexible document system with collaborative editing features.

## Key Features

### 1. Block-Based Editor
- Multiple block types (text, headings, lists, code, etc.)
- Nested blocks and indentation
- Slash commands for quick block creation
- Block transformations

### 2. Real-Time Collaboration
- WebSocket-based live updates
- Presence indicators showing active users
- Operation broadcasting to all connected clients
- Hybrid Logical Clock for ordering

### 3. Workspace Hierarchy
- Workspaces with members
- Nested pages and databases
- Sidebar navigation with expandable tree

### 4. Databases
- Table, board, list views
- Properties (text, select, date, checkbox, etc.)
- Filtering and sorting per view

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + WebSocket (ws)
- **Database:** PostgreSQL
- **Cache/Sessions:** Redis
- **Real-time:** WebSocket with CRDT-inspired operations

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Option 1: Using Docker (Recommended)

```bash
# Start PostgreSQL and Redis
docker-compose up -d

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install

# Start backend (in one terminal)
cd backend
npm run dev

# Start frontend (in another terminal)
cd frontend
npm run dev
```

### Option 2: Native Services

If you have PostgreSQL and Redis installed locally:

```bash
# Configure environment (optional - defaults work for local development)
export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=notion
export DB_PASSWORD=notion_password
export DB_NAME=notion_db
export REDIS_HOST=localhost
export REDIS_PORT=6379

# Create database and run init.sql
psql -U postgres -c "CREATE USER notion WITH PASSWORD 'notion_password';"
psql -U postgres -c "CREATE DATABASE notion_db OWNER notion;"
psql -U notion -d notion_db -f backend/init.sql

# Install and run
cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

### Access the Application

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3001
- **WebSocket:** ws://localhost:3001/ws

### Default Credentials

- **Email:** admin@notion.local
- **Password:** admin123

## Project Structure

```
notion/
├── docker-compose.yml       # PostgreSQL + Redis containers
├── backend/
│   ├── init.sql             # Database schema and seed data
│   ├── src/
│   │   ├── index.ts         # Express + WebSocket server
│   │   ├── routes/          # API endpoints
│   │   │   ├── auth.ts      # Authentication
│   │   │   ├── workspaces.ts
│   │   │   ├── pages.ts
│   │   │   ├── blocks.ts
│   │   │   └── databases.ts
│   │   ├── services/
│   │   │   └── websocket.ts # Real-time sync
│   │   ├── middleware/
│   │   │   └── auth.ts
│   │   ├── models/
│   │   │   ├── db.ts        # PostgreSQL pool
│   │   │   └── redis.ts     # Redis client
│   │   ├── utils/
│   │   │   ├── fractionalIndex.ts  # Block ordering
│   │   │   └── hlc.ts       # Hybrid Logical Clock
│   │   └── types/
│   │       └── index.ts
│   └── package.json
└── frontend/
    ├── src/
    │   ├── main.tsx
    │   ├── routes/          # Tanstack Router pages
    │   │   ├── __root.tsx
    │   │   ├── index.tsx
    │   │   ├── login.tsx
    │   │   ├── register.tsx
    │   │   └── page.$pageId.tsx
    │   ├── components/
    │   │   ├── sidebar/
    │   │   │   └── Sidebar.tsx
    │   │   ├── editor/
    │   │   │   └── BlockEditor.tsx
    │   │   ├── blocks/
    │   │   │   └── BlockComponent.tsx
    │   │   └── database/
    │   │       ├── DatabaseView.tsx
    │   │       ├── TableView.tsx
    │   │       ├── BoardView.tsx
    │   │       ├── ListView.tsx
    │   │       └── PropertyCell.tsx
    │   ├── stores/
    │   │   ├── index.ts     # Auth, Workspace, Page stores
    │   │   └── editor.ts    # Block editor state
    │   ├── services/
    │   │   ├── api.ts       # REST API client
    │   │   └── websocket.ts # WebSocket client
    │   └── types/
    │       └── index.ts
    └── package.json
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Workspaces
- `GET /api/workspaces` - List user's workspaces
- `POST /api/workspaces` - Create workspace
- `GET /api/workspaces/:id` - Get workspace
- `PATCH /api/workspaces/:id` - Update workspace
- `DELETE /api/workspaces/:id` - Delete workspace

### Pages
- `GET /api/pages?workspace_id=...` - List pages
- `POST /api/pages` - Create page
- `GET /api/pages/:id` - Get page with blocks
- `PATCH /api/pages/:id` - Update page
- `DELETE /api/pages/:id` - Archive/delete page

### Blocks
- `GET /api/blocks?page_id=...` - List blocks
- `POST /api/blocks` - Create block
- `PATCH /api/blocks/:id` - Update block
- `DELETE /api/blocks/:id` - Delete block
- `POST /api/blocks/:id/move` - Move block
- `POST /api/blocks/batch` - Batch operations

### Databases
- `GET /api/databases/:id` - Get database with rows
- `POST /api/databases/:id/rows` - Add row
- `PATCH /api/databases/:id/rows/:rowId` - Update row
- `DELETE /api/databases/:id/rows/:rowId` - Delete row
- `POST /api/databases/:id/views` - Create view
- `PATCH /api/databases/:id/views/:viewId` - Update view

## Block Types

- `text` - Plain text paragraph
- `heading_1`, `heading_2`, `heading_3` - Headings
- `bulleted_list` - Bulleted list item
- `numbered_list` - Numbered list item
- `toggle` - Collapsible toggle
- `code` - Code block
- `quote` - Block quote
- `callout` - Callout box
- `divider` - Horizontal divider

## Database Property Types

- `title` - Title property (required)
- `text` - Text field
- `number` - Numeric value
- `select` - Single select dropdown
- `date` - Date picker
- `checkbox` - Boolean checkbox
- `url`, `email`, `phone` - Specialized text fields

## WebSocket Events

### Client to Server
- `subscribe` - Subscribe to page updates
- `unsubscribe` - Unsubscribe from page
- `operation` - Send block operation
- `presence` - Update cursor position
- `sync` - Request sync from timestamp

### Server to Client
- `connected` - Connection established
- `subscribed` - Subscribed to page with presence
- `operation` - Broadcast block operation
- `presence` - User presence update
- `ack` - Operation acknowledged

## Development

### Running Multiple Backend Instances

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

### Environment Variables

Backend:
- `PORT` - Server port (default: 3001)
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` - PostgreSQL config
- `REDIS_HOST`, `REDIS_PORT` - Redis config
- `FRONTEND_URL` - CORS origin (default: http://localhost:5173)

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

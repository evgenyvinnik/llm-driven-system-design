# Design Slack - Team Communication Platform

A simplified Slack-like platform demonstrating workspace isolation, message threading, real-time messaging, and search functionality. This educational project focuses on building a team communication system with channels, DMs, and real-time updates.

## Key Features

### 1. Workspace Management
- Team workspace creation and joining
- Member management
- Role-based permissions (owner, admin, member)

### 2. Channels
- Public and private channels
- Channel membership
- Topic and description
- Unread message counts

### 3. Messaging
- Real-time message delivery via WebSocket
- Message threading (replies)
- Reactions (emoji)
- Message editing and deletion

### 4. Direct Messages
- One-on-one and group DMs
- Real-time updates

### 5. Search
- Full-text message search
- Filter by channel, user, date
- Elasticsearch integration with PostgreSQL fallback

### 6. Presence
- Online/offline status
- Typing indicators

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + WebSocket (ws)
- **Database:** PostgreSQL
- **Cache/Pub-Sub:** Redis
- **Search:** Elasticsearch (with PostgreSQL full-text search fallback)

## Project Structure

```
slack/
├── backend/
│   ├── src/
│   │   ├── db/              # Database connection and migrations
│   │   ├── middleware/      # Express middleware
│   │   ├── routes/          # API routes
│   │   ├── services/        # Redis, Elasticsearch, WebSocket
│   │   ├── types/           # TypeScript types
│   │   └── index.ts         # Server entry point
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── hooks/           # Custom hooks (WebSocket)
│   │   ├── routes/          # TanStack Router routes
│   │   ├── services/        # API client
│   │   ├── stores/          # Zustand stores
│   │   ├── types/           # TypeScript types
│   │   └── utils/           # Helper functions
│   └── package.json
├── docker-compose.yml       # Infrastructure services
├── architecture.md          # System design documentation
└── README.md               # This file
```

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure Services

```bash
cd slack
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- Elasticsearch on port 9200

### 2. Setup Backend

```bash
cd backend
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
```

### 3. Setup Frontend

```bash
cd frontend
npm install
```

### 4. Start Development Servers

In one terminal:
```bash
cd backend
npm run dev
```

In another terminal:
```bash
cd frontend
npm run dev
```

### 5. Access the Application

Open http://localhost:5173 in your browser.

**Demo Credentials:**
- Email: alice@example.com
- Password: password123
- Workspace: acme

Other test users: bob@example.com, charlie@example.com, diana@example.com (all with password: password123)

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/me` - Update profile

### Workspaces
- `GET /api/workspaces` - List user's workspaces
- `POST /api/workspaces` - Create workspace
- `GET /api/workspaces/:id` - Get workspace details
- `POST /api/workspaces/:id/join` - Join workspace
- `POST /api/workspaces/:id/select` - Set active workspace
- `GET /api/workspaces/:id/members` - List workspace members

### Channels
- `GET /api/channels` - List channels in workspace
- `POST /api/channels` - Create channel
- `GET /api/channels/:id` - Get channel details
- `PUT /api/channels/:id` - Update channel
- `POST /api/channels/:id/join` - Join channel
- `POST /api/channels/:id/leave` - Leave channel
- `GET /api/channels/:id/members` - List channel members
- `POST /api/channels/:id/read` - Mark channel as read

### Direct Messages
- `GET /api/dms` - List DM conversations
- `POST /api/dms` - Create DM (or get existing)
- `GET /api/dms/:id` - Get DM details

### Messages
- `GET /api/messages/channel/:channelId` - Get channel messages
- `POST /api/messages/channel/:channelId` - Send message
- `PUT /api/messages/:id` - Edit message
- `DELETE /api/messages/:id` - Delete message
- `GET /api/messages/:id/thread` - Get thread with replies
- `POST /api/messages/:id/reactions` - Add reaction
- `DELETE /api/messages/:id/reactions/:emoji` - Remove reaction

### Search
- `GET /api/search?q=query` - Search messages

## WebSocket API

Connect to `ws://localhost:3001/ws?userId=<userId>&workspaceId=<workspaceId>`

### Client -> Server Messages
- `{ type: 'ping' }` - Keepalive ping
- `{ type: 'typing', payload: { channelId } }` - Typing indicator
- `{ type: 'presence', payload: { status: 'online' | 'away' } }` - Update presence

### Server -> Client Messages
- `{ type: 'message', payload: Message }` - New message
- `{ type: 'message_update', payload: Message }` - Updated message
- `{ type: 'message_delete', payload: { id, channel_id } }` - Deleted message
- `{ type: 'reaction_add', payload: { message_id, user_id, emoji } }` - Reaction added
- `{ type: 'reaction_remove', payload: { message_id, user_id, emoji } }` - Reaction removed
- `{ type: 'typing', payload: { channelId, userId } }` - User typing
- `{ type: 'presence', payload: { userId, status } }` - User presence change
- `{ type: 'connected', payload: { userId, workspaceId } }` - Connection confirmed

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
cd backend && npm run dev:server1  # Port 3001

# Terminal 2
cd backend && npm run dev:server2  # Port 3002

# Terminal 3
cd backend && npm run dev:server3  # Port 3003
```

All instances share the same PostgreSQL and Redis, enabling real-time message delivery across instances.

## Native Services Setup (Without Docker)

### PostgreSQL
```bash
# macOS
brew install postgresql@16
brew services start postgresql@16
createdb slack
psql slack -c "CREATE USER slack WITH PASSWORD 'slack_password';"
psql slack -c "GRANT ALL PRIVILEGES ON DATABASE slack TO slack;"
```

### Redis
```bash
# macOS
brew install redis
brew services start redis
```

### Elasticsearch
```bash
# macOS
brew install elasticsearch
brew services start elasticsearch
```

## Environment Variables

Backend (`.env`):
```
PORT=3001
NODE_ENV=development
DATABASE_URL=postgresql://slack:slack_password@localhost:5432/slack
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_URL=http://localhost:9200
SESSION_SECRET=your-session-secret-change-in-production
```

## Architecture Highlights

### Real-Time Messaging
Messages are delivered in real-time using:
1. User sends message via HTTP POST
2. Message is persisted to PostgreSQL
3. Redis pub/sub broadcasts to all connected gateways
4. WebSocket connections forward to connected clients

### Threading
Threads are implemented as messages with a `thread_ts` reference to the parent message. The parent message maintains `reply_count` for efficient display.

### Search
- Primary: Elasticsearch for full-text search with relevance ranking
- Fallback: PostgreSQL `tsvector` full-text search when Elasticsearch is unavailable

### Presence
- Redis keys with TTL for automatic cleanup
- Heartbeat-based presence tracking
- Broadcast presence changes to workspace members

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
See [architecture.md](./architecture.md) for detailed system design documentation.

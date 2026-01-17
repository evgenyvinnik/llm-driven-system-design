# Design iMessage - Cross-Device Messaging

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 4,860 |
| Source Files | 43 |
| .js | 1,666 |
| .md | 1,095 |
| .tsx | 897 |
| .ts | 846 |
| .sql | 158 |

## Overview

A simplified iMessage-like platform demonstrating real-time messaging, cross-device sync, and offline support. This educational project focuses on building a scalable messaging system with seamless multi-device experience.

## Key Features

### 1. Real-Time Messaging
- WebSocket-based instant message delivery
- Typing indicators
- Read receipts
- Message reactions

### 2. Cross-Device Sync
- Messages sync across all devices
- Offline message queue
- Delivery confirmation
- Read state sync

### 3. Group Messaging
- Group creation
- Admin controls
- Participant management

### 4. User Experience
- Conversation list with unread counts
- Mobile-responsive design
- Optimistic UI updates

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + WebSocket (ws)
- **Database:** PostgreSQL
- **Cache/Pub-Sub:** Redis

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
cd imessage
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

### 2. Start Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

The API server starts on http://localhost:3000

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend starts on http://localhost:5173

### 4. Test the Application

1. Open http://localhost:5173 in two different browsers (or incognito windows)
2. Register two different accounts
3. Search for the other user and start a conversation
4. Send messages in real-time!

## Running Multiple Backend Instances

To test distributed messaging with load balancing:

```bash
# Terminal 1
cd backend
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Project Structure

```
imessage/
├── docker-compose.yml      # PostgreSQL + Redis
├── backend/
│   ├── package.json
│   ├── .env.example
│   ├── migrations/
│   │   └── init.sql        # Database schema
│   └── src/
│       ├── index.js        # Express + WebSocket server
│       ├── db.js           # PostgreSQL connection
│       ├── redis.js        # Redis connection + helpers
│       ├── middleware/
│       │   └── auth.js     # Authentication middleware
│       ├── routes/
│       │   ├── auth.js     # Login, register, logout
│       │   ├── conversations.js
│       │   ├── messages.js
│       │   └── users.js
│       └── services/
│           ├── auth.js
│           ├── conversations.js
│           ├── messages.js
│           ├── users.js
│           └── websocket.js # Real-time messaging
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── index.css
        ├── types/
        │   └── index.ts
        ├── services/
        │   ├── api.ts      # REST API client
        │   └── websocket.ts # WebSocket client
        ├── stores/
        │   ├── authStore.ts
        │   └── chatStore.ts
        ├── hooks/
        │   └── useWebSocket.ts
        ├── components/
        │   ├── AuthForm.tsx
        │   ├── ConversationList.tsx
        │   ├── ConversationItem.tsx
        │   ├── ChatView.tsx
        │   ├── MessageBubble.tsx
        │   └── TypingIndicator.tsx
        └── routes/
            ├── __root.tsx
            └── index.tsx
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `GET /api/auth/devices` - Get user devices

### Conversations
- `GET /api/conversations` - List conversations
- `GET /api/conversations/:id` - Get conversation
- `POST /api/conversations/direct` - Create direct conversation
- `POST /api/conversations/group` - Create group conversation
- `POST /api/conversations/:id/participants` - Add participant
- `DELETE /api/conversations/:id/participants/:userId` - Remove participant

### Messages
- `GET /api/messages/conversation/:id` - Get messages
- `POST /api/messages/conversation/:id` - Send message (REST fallback)
- `PATCH /api/messages/:id` - Edit message
- `DELETE /api/messages/:id` - Delete message
- `POST /api/messages/:id/reactions` - Add reaction
- `DELETE /api/messages/:id/reactions/:reaction` - Remove reaction
- `POST /api/messages/conversation/:id/read` - Mark as read

### Users
- `GET /api/users/search?q=query` - Search users
- `GET /api/users/:id` - Get user profile
- `PATCH /api/users/me` - Update profile

## WebSocket Protocol

Connect to `ws://localhost:3000/ws?token=YOUR_TOKEN`

### Client -> Server Messages

```javascript
// Send message
{ type: 'send_message', conversationId, content, clientMessageId }

// Typing indicator
{ type: 'typing', conversationId, isTyping: true/false }

// Mark as read
{ type: 'read', conversationId, messageId }

// Add/remove reaction
{ type: 'reaction', messageId, reaction, remove: true/false }
```

### Server -> Client Messages

```javascript
// New message
{ type: 'new_message', message: {...} }

// Message sent confirmation
{ type: 'message_sent', clientMessageId, message: {...} }

// Typing indicator
{ type: 'typing', conversationId, userId, username, isTyping }

// Read receipt
{ type: 'read_receipt', conversationId, userId, messageId }

// Reaction update
{ type: 'reaction_update', conversationId, messageId, userId, reaction, remove }

// Offline messages (on reconnect)
{ type: 'offline_messages', messages: [...] }
```

## Native Development (without Docker)

### PostgreSQL

```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16
createuser -s imessage
createdb -O imessage imessage
psql -d imessage -f backend/migrations/init.sql
```

### Redis

```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

## Environment Variables

### Backend (.env)

```bash
PORT=3000
NODE_ENV=development

# PostgreSQL
DATABASE_URL=postgresql://imessage:imessage_secret@localhost:5432/imessage

# Redis
REDIS_URL=redis://localhost:6379

# Session
SESSION_SECRET=your-session-secret-change-in-production
SESSION_EXPIRY_HOURS=720

# CORS
CORS_ORIGIN=http://localhost:5173

# WebSocket
WS_HEARTBEAT_INTERVAL=30000
```

## Key Technical Decisions

### 1. WebSocket for Real-Time

We use WebSocket instead of polling for instant message delivery. Redis Pub/Sub enables cross-server message broadcasting for horizontal scaling.

### 2. Optimistic Updates

Messages appear instantly in the UI before server confirmation, providing a smooth user experience. Failed messages are marked accordingly.

### 3. Offline Queue

Messages sent while offline are queued locally and delivered to the server when connection is restored.

### 4. Per-Device Sync

Each device maintains its own sync cursor, allowing independent message history retrieval.

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [iMessage Security Overview](https://support.apple.com/guide/security/imessage-security-overview-secd0c9a5c93/web) - Apple's documentation on iMessage encryption
- [Apple Platform Security Guide](https://support.apple.com/guide/security/welcome/web) - Comprehensive security documentation for Apple services
- [Signal Protocol Documentation](https://signal.org/docs/) - End-to-end encryption protocol used by many messaging apps
- [Double Ratchet Algorithm](https://signal.org/docs/specifications/doubleratchet/) - Forward secrecy in messaging systems
- [X3DH Key Agreement Protocol](https://signal.org/docs/specifications/x3dh/) - Extended Triple Diffie-Hellman for establishing sessions
- [WhatsApp Encryption Overview](https://www.whatsapp.com/security/) - Another implementation of secure messaging
- [Building Real-Time Chat with WebSockets](https://socket.io/docs/v4/) - WebSocket patterns for real-time messaging

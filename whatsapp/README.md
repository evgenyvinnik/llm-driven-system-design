# WhatsApp - Real-Time Messaging Platform

A WhatsApp-inspired messaging application with real-time WebSocket communication, message delivery receipts, user presence, and group chat support.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 4,497 |
| Source Files | 44 |
| .ts | 2,199 |
| .tsx | 1,110 |
| .md | 877 |
| .json | 137 |
| .sql | 74 |

## Features

- **Real-time 1:1 Messaging**: Send and receive messages instantly via WebSocket
- **Group Chats**: Create groups with multiple participants
- **Message Delivery Receipts**: Track message status (sent, delivered, read)
- **User Presence**: See when contacts are online/offline
- **Typing Indicators**: Real-time typing status updates
- **Session-based Authentication**: Secure login with Redis-backed sessions
- **Responsive Design**: Works on desktop and mobile browsers

## Tech Stack

### Backend
- **Node.js + Express**: REST API and WebSocket server
- **WebSocket (ws)**: Real-time bidirectional communication
- **PostgreSQL**: User and message persistence
- **Redis**: Session storage, presence tracking, pub/sub for cross-server messaging

### Frontend
- **React 19**: UI components
- **TypeScript**: Type-safe development
- **Vite**: Fast build tooling
- **TanStack Router**: File-based routing
- **Zustand**: State management
- **Tailwind CSS**: Styling

## Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

## Getting Started

### 1. Start Infrastructure

Start PostgreSQL and Redis with Docker:

```bash
cd /path/to/whatsapp
docker-compose up -d
```

This will:
- Start PostgreSQL on port 5432
- Start Redis on port 6379
- Initialize the database with the schema and demo users

### 2. Install Backend Dependencies

```bash
cd backend
npm install
```

### 3. Start Backend Server

```bash
# Development mode with hot reload
npm run dev

# Or run on a specific port
PORT=3001 npm run dev
```

The backend will be available at:
- REST API: http://localhost:3001/api
- WebSocket: ws://localhost:3001/ws
- Health check: http://localhost:3001/health

### 4. Install Frontend Dependencies

```bash
cd ../frontend
npm install
```

### 5. Start Frontend Development Server

```bash
npm run dev
```

The frontend will be available at http://localhost:5173

## Demo Users

The database is seeded with three demo users:

| Username | Password | Display Name |
|----------|----------|--------------|
| alice | password123 | Alice Smith |
| bob | password123 | Bob Johnson |
| charlie | password123 | Charlie Brown |

## Testing Real-Time Features

To test real-time messaging:

1. Open two browser windows (or use incognito mode for the second)
2. Log in as different users in each window
3. Start a conversation between the two users
4. Send messages and observe:
   - Instant message delivery
   - Delivery receipts (double checkmarks)
   - Read receipts (blue checkmarks when the chat is open)
   - Typing indicators
   - Online/offline presence

## Running Multiple Backend Servers

To test distributed messaging with Redis pub/sub:

```bash
# Terminal 1
PORT=3001 npm run dev:server1

# Terminal 2
PORT=3002 npm run dev:server2

# Terminal 3
PORT=3003 npm run dev:server3
```

Then update the frontend proxy configuration or use a load balancer.

## Project Structure

```
whatsapp/
├── docker-compose.yml      # PostgreSQL and Redis
├── backend/
│   ├── src/
│   │   ├── index.ts        # Express server entry point
│   │   ├── config.ts       # Environment configuration
│   │   ├── db.ts           # PostgreSQL connection
│   │   ├── redis.ts        # Redis connections
│   │   ├── websocket.ts    # WebSocket handler
│   │   ├── routes/         # REST API routes
│   │   ├── services/       # Business logic
│   │   ├── middleware/     # Express middleware
│   │   └── types/          # TypeScript types
│   ├── init.sql            # Database schema
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── main.tsx        # React entry point
│   │   ├── routes/         # TanStack Router routes
│   │   ├── components/     # React components
│   │   ├── stores/         # Zustand stores
│   │   ├── services/       # API client
│   │   ├── hooks/          # Custom hooks (WebSocket)
│   │   └── types/          # TypeScript types
│   └── package.json
├── architecture.md         # System design documentation
├── CLAUDE.md              # Development notes
└── README.md              # This file
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with username/password
- `POST /api/auth/register` - Create new account
- `POST /api/auth/logout` - End session
- `GET /api/auth/me` - Get current user
- `GET /api/auth/search` - Search users

### Conversations
- `GET /api/conversations` - List user's conversations
- `GET /api/conversations/:id` - Get conversation details
- `POST /api/conversations/direct` - Create 1:1 conversation
- `POST /api/conversations/group` - Create group conversation
- `POST /api/conversations/:id/members` - Add group member
- `DELETE /api/conversations/:id/members/:userId` - Remove group member

### Messages
- `GET /api/messages/:conversationId` - Get messages for conversation
- `POST /api/messages/:conversationId/read` - Mark messages as read

### WebSocket Events

#### Client to Server
- `message` - Send a chat message
- `typing` / `stop_typing` - Typing indicator
- `read_receipt` - Mark messages as read

#### Server to Client
- `message` - New incoming message
- `message_ack` - Sent message acknowledged
- `delivery_receipt` - Message delivered to recipient
- `read_receipt` - Message read by recipient
- `typing` / `stop_typing` - Typing indicator from other user
- `presence` - Online/offline status change

## Environment Variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Server port |
| POSTGRES_HOST | localhost | PostgreSQL host |
| POSTGRES_PORT | 5432 | PostgreSQL port |
| POSTGRES_DB | whatsapp | Database name |
| POSTGRES_USER | whatsapp | Database user |
| POSTGRES_PASSWORD | whatsapp_secret | Database password |
| REDIS_HOST | localhost | Redis host |
| REDIS_PORT | 6379 | Redis port |
| SESSION_SECRET | (default) | Session signing secret |
| CORS_ORIGIN | http://localhost:5173 | Allowed CORS origin |

## Troubleshooting

### Database connection failed
Ensure Docker containers are running:
```bash
docker-compose ps
docker-compose logs postgres
```

### WebSocket connection refused
Check that:
1. Backend is running
2. Frontend proxy is configured correctly in `vite.config.ts`
3. No firewall blocking WebSocket connections

### Session not persisting
Ensure:
1. Redis is running and accessible
2. Cookies are enabled in the browser
3. CORS credentials are configured correctly

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation including:
- High-level architecture diagram
- Message flow for online/offline delivery
- Group messaging fan-out strategy
- Presence and typing indicators
- Database schema

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.

## References & Inspiration

- [How WhatsApp Scaled to 1 Billion Users with Only 50 Engineers](http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html) - Classic High Scalability article on WhatsApp's Erlang-based architecture
- [The WhatsApp Architecture Facebook Bought for $19 Billion](https://www.wired.com/2014/02/whatsapp-facebook/) - Background on WhatsApp's lean engineering approach
- [XMPP Protocol Specification](https://xmpp.org/rfcs/rfc6120.html) - The messaging protocol that inspired WhatsApp's original design
- [Redis Pub/Sub Documentation](https://redis.io/docs/interact/pubsub/) - Real-time message routing across distributed servers
- [WebSocket API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) - Client-side WebSocket implementation reference
- [ws - Node.js WebSocket Library](https://github.com/websockets/ws) - The WebSocket library used in this implementation
- [Signal Protocol Technical Documentation](https://signal.org/docs/) - End-to-end encryption protocol used by WhatsApp
- [Designing a Chat System - System Design Interview](https://bytebytego.com/courses/system-design-interview/design-a-chat-system) - ByteByteGo's comprehensive chat system design guide
- [Building Real-Time Applications with WebSockets](https://ably.com/topic/websockets) - Patterns for scaling WebSocket connections
- [Message Queuing with RabbitMQ](https://www.rabbitmq.com/tutorials/tutorial-one-javascript.html) - Alternative to Redis Pub/Sub for message delivery

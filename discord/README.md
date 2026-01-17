# Baby Discord - Simple Multi-Protocol Chat Server

A simplified real-time chat server that demonstrates core distributed system concepts by supporting **dual protocols**: raw TCP (for netcat clients) and HTTP/SSE (for browser clients). This educational project focuses on fundamentals: connection management, room-based chat, message history, and horizontal scaling with Redis pub/sub.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,301 |
| Source Files | 45 |
| .ts | 2,449 |
| .md | 2,012 |
| .tsx | 529 |
| .json | 133 |
| .sql | 54 |

## Features

### Core Functionality

- **Dual Protocol Support**
  - Raw TCP: Connect via `netcat` for a terminal-based chat experience
  - HTTP/SSE: Connect via browser for a Discord-like web interface
  - Both protocols interact with the same chat rooms and users

- **Slash Commands**
  - `/help` - Display available commands
  - `/nick <name>` - Change your nickname
  - `/list` - List users in current room
  - `/quit` - Disconnect from server
  - `/create <room>` - Create a new room
  - `/join <room>` - Join an existing room
  - `/rooms` - List all available rooms
  - `/leave` - Leave current room
  - `/dm <user> <message>` - Send a direct message

- **Real-time Messaging**
  - Instant message delivery via WebSocket-like connections
  - Message history (last 10 per room)
  - System notifications for joins/leaves

- **Multi-Instance Support**
  - Run multiple server instances on different ports
  - Redis pub/sub for cross-instance message routing
  - Horizontal scaling demonstration

## Tech Stack

- **Backend**: Node.js + Express + TypeScript
- **Frontend**: React 19 + Vite + Zustand + Tailwind CSS
- **Database**: PostgreSQL
- **Pub/Sub**: Redis (Valkey)
- **Protocols**: TCP (raw sockets), HTTP REST, Server-Sent Events (SSE)

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- netcat (for TCP client testing)

### 1. Start Infrastructure

```bash
cd discord

# Start PostgreSQL and Redis
docker-compose up -d

# Verify containers are running
docker-compose ps
```

### 2. Start Backend

```bash
cd backend

# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Run database migrations (auto-runs on first Docker start)
npm run db:migrate

# Start the server
npm run dev
```

The backend will start with:
- TCP Server: `localhost:9001`
- HTTP Server: `localhost:3001`

### 3. Start Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start dev server
npm run dev
```

Open `http://localhost:5173` in your browser.

### 4. Connect via netcat (TCP)

```bash
nc localhost 9001

# Follow the prompts to enter a nickname
# Then use slash commands or chat
```

## Running Multiple Instances

To test horizontal scaling with Redis pub/sub:

```bash
# Terminal 1 - Instance 1
cd backend
npm run dev:server1

# Terminal 2 - Instance 2
npm run dev:server2

# Terminal 3 - Instance 3
npm run dev:server3
```

This runs three independent server instances:
- Instance 1: TCP 9001, HTTP 3001
- Instance 2: TCP 9002, HTTP 3002
- Instance 3: TCP 9003, HTTP 3003

Users on different instances can chat in the same rooms via Redis pub/sub.

## API Documentation

### Authentication

#### POST /api/connect
Establish a session with a nickname.

**Request:**
```json
{
  "nickname": "alice"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid-string",
    "userId": 1,
    "nickname": "alice"
  }
}
```

#### POST /api/disconnect
End the current session.

**Request:**
```json
{
  "sessionId": "uuid-string"
}
```

### Commands

#### POST /api/command
Execute a slash command.

**Request:**
```json
{
  "sessionId": "uuid-string",
  "command": "/join general"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Joined room: general\n--- Recent Messages ---\n..."
}
```

### Messaging

#### POST /api/message
Send a message to the current room.

**Request:**
```json
{
  "sessionId": "uuid-string",
  "content": "Hello world!"
}
```

#### GET /api/messages/:room?sessionId=xxx
Subscribe to real-time messages via Server-Sent Events.

**Response (SSE Stream):**
```
event: connected
data: {"room": "general"}

event: message
data: {"room": "general", "user": "alice", "content": "Hello!", "timestamp": "..."}
```

### Rooms

#### GET /api/rooms
List all available rooms.

**Response:**
```json
{
  "success": true,
  "data": {
    "rooms": [
      {"name": "general", "memberCount": 3, "createdAt": "..."}
    ]
  }
}
```

#### GET /api/rooms/:room/history
Get message history for a room.

**Response:**
```json
{
  "success": true,
  "data": {
    "messages": [
      {"id": 1, "roomId": 1, "userId": 1, "content": "Hello", "createdAt": "...", "nickname": "alice"}
    ]
  }
}
```

### Health Check

#### GET /api/health

**Response:**
```json
{
  "status": "healthy",
  "db": true,
  "connections": 5,
  "uptime": 1234.56
}
```

## TCP Protocol

The TCP interface uses a simple line-based protocol:

```
# Client connects
Welcome to Baby Discord!
Enter your nickname: alice

Welcome, alice!
Type /help for available commands.

# Create and join a room
> /create general
Created and joined room: general
--- Recent Messages ---
No recent messages
---

# Send messages
> Hello world!
[general] alice: Hello world!

# View commands
> /help
Available commands:
  /help         - Show this message
  /nick <name>  - Change your nickname
  /list         - List users in current room
  /quit         - Disconnect from server
  /create <room>- Create a new room
  /join <room>  - Join an existing room
  /rooms        - List all available rooms
  /leave        - Leave current room
  /dm <user> <message> - Send direct message
```

## Project Structure

```
discord/
├── docker-compose.yml       # PostgreSQL + Redis
├── backend/
│   ├── src/
│   │   ├── adapters/        # TCP and HTTP servers
│   │   │   ├── tcp-server.ts
│   │   │   └── http-server.ts
│   │   ├── core/            # Business logic
│   │   │   ├── chat-handler.ts
│   │   │   ├── command-parser.ts
│   │   │   ├── connection-manager.ts
│   │   │   ├── history-buffer.ts
│   │   │   ├── message-router.ts
│   │   │   └── room-manager.ts
│   │   ├── db/              # Database layer
│   │   │   ├── connection.ts
│   │   │   ├── index.ts
│   │   │   ├── init.sql
│   │   │   └── migrate.ts
│   │   ├── types/           # TypeScript types
│   │   ├── utils/           # Logger, pub/sub
│   │   └── index.ts         # Entry point
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── services/        # API client
│   │   ├── stores/          # Zustand stores
│   │   └── types/           # TypeScript types
│   ├── package.json
│   └── vite.config.ts
├── architecture.md          # System design documentation
├── claude.md               # Development notes
└── README.md               # This file
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                             │
├──────────────────────┬──────────────────────────────────────────┤
│  netcat (TCP)        │  Browser (HTTP/SSE)                      │
│  nc localhost 9001   │  http://localhost:5173                   │
└──────────────────────┴──────────────────────────────────────────┘
           │                           │
           ▼                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Protocol Adapters                             │
├──────────────────────┬──────────────────────────────────────────┤
│  TCP Server          │  HTTP Server (Express)                   │
│  (net module)        │  - REST API                              │
│  - Socket per client │  - Server-Sent Events                    │
└──────────────────────┴──────────────────────────────────────────┘
           │                           │
           └───────────┬───────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Chat Core (Shared)                           │
├─────────────────────────────────────────────────────────────────┤
│  - CommandParser: Parse slash commands                          │
│  - ConnectionManager: Track active users & connections          │
│  - RoomManager: Handle room creation, join, leave               │
│  - MessageRouter: Route messages to room members                │
│  - HistoryBuffer: In-memory ring buffer (10 msgs per room)      │
└─────────────────────────────────────────────────────────────────┘
           │                           │
           ▼                           ▼
┌─────────────────────┐    ┌─────────────────────────────────────┐
│     PostgreSQL      │    │            Redis Pub/Sub             │
│  (Persistence)      │    │    (Cross-instance messaging)        │
└─────────────────────┘    └─────────────────────────────────────┘
```

## Testing

### Manual Testing

1. **TCP Testing**
   ```bash
   # Open multiple terminals with netcat
   nc localhost 9001
   ```

2. **HTTP Testing**
   ```bash
   # Connect
   curl -X POST http://localhost:3001/api/connect \
     -H "Content-Type: application/json" \
     -d '{"nickname": "test"}'

   # Join room
   curl -X POST http://localhost:3001/api/command \
     -H "Content-Type: application/json" \
     -d '{"sessionId": "YOUR_SESSION_ID", "command": "/join general"}'
   ```

3. **Cross-protocol Testing**
   - Connect via netcat on one terminal
   - Connect via browser on another
   - Verify both see each other's messages

### Load Testing

```bash
# Spawn multiple netcat clients
for i in {1..10}; do
  (echo "user$i"; sleep 1; echo "/join general"; sleep 1; echo "Hello from user$i") | nc localhost 9001 &
done
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INSTANCE_ID` | `1` | Instance identifier for logging |
| `TCP_PORT` | `9001` | TCP server port |
| `HTTP_PORT` | `3001` | HTTP server port |
| `DATABASE_URL` | `postgresql://discord:discord@localhost:5432/babydiscord` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |

## Design Decisions

1. **Dual Protocols (TCP + HTTP)**: Teaches protocol abstraction and adapter pattern
2. **SSE over WebSocket**: Simpler for one-directional message broadcast
3. **Ring Buffer for History**: Teaches caching patterns with bounded memory
4. **PostgreSQL**: Relational model for users/rooms/messages
5. **Redis Pub/Sub**: Enables horizontal scaling with low-latency cross-instance messaging

See [architecture.md](./architecture.md) for detailed design documentation and trade-off analysis.

## Learning Outcomes

This project demonstrates:
- Protocol abstraction (TCP + HTTP to same core logic)
- Stateful service design (connection management)
- Caching patterns (in-memory ring buffer)
- Horizontal scaling (pub/sub for distribution)
- Real-time web technologies (Server-Sent Events)

## Future Enhancements

- [ ] User authentication with sessions
- [ ] Private rooms with access control
- [ ] Message editing and deletion
- [ ] Rate limiting
- [ ] WebSocket support for lower latency
- [ ] Voice channels (WebRTC)
- [ ] File uploads

## License

MIT

## References & Inspiration

- [Discord Engineering Blog](https://discord.com/blog/category/engineering) - Official engineering insights and architecture posts
- [How Discord Stores Billions of Messages](https://discord.com/blog/how-discord-stores-billions-of-messages) - Cassandra to ScyllaDB migration story
- [How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages) - Updated architecture with ScyllaDB
- [How Discord Handles Two and a Half Million Concurrent Voice Users](https://discord.com/blog/how-discord-handles-two-and-a-half-million-concurrent-voice-users-using-webrtc) - WebRTC at scale
- [How Discord Supercharges Network Disks](https://discord.com/blog/how-discord-supercharges-network-disks-for-extreme-low-latency) - Storage infrastructure optimization
- [Why Discord is Switching from Go to Rust](https://discord.com/blog/why-discord-is-switching-from-go-to-rust) - Read States service performance
- [Discord's Snowflake ID Generation](https://discord.com/developers/docs/reference#snowflakes) - Distributed ID generation like Twitter
- [Real-Time Communication with WebRTC](https://webrtc.org/) - Foundation for Discord's voice/video
- [ScyllaDB Documentation](https://docs.scylladb.com/) - Discord's message storage database
- [Elixir and Discord](https://elixir-lang.org/blog/2020/10/08/real-time-communication-at-scale-with-elixir-at-discord/) - How Discord uses Elixir for real-time features

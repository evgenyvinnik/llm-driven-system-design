# Baby Discord - Simple Multi-Protocol Chat Server

## Overview

A simplified real-time chat server that demonstrates core distributed system concepts by supporting **dual protocols**: raw TCP (for netcat clients) and HTTP (for browser clients). This educational project focuses on fundamentals: connection management, room-based chat, message history, and data persistence.

## Key Features

### 1. Dual Protocol Support
- **Raw TCP**: Connect via `netcat` for a terminal-based chat experience
- **HTTP**: Connect via browser for a web-based interface
- Both protocols interact with the same chat rooms and users

### 2. Slash Commands
- `/help` - Display available commands
- `/nick <new_name>` - Change your nickname
- `/list` - List all users currently on the server
- `/quit` - Disconnect from the server

### 3. Room Management
- `/create <room_name>` - Create a new chat room
- `/join <room_name>` - Join an existing room
- `/rooms` - List all available rooms
- `/leave` - Leave the current room

### 4. Message History
- Each room stores the last 10 messages
- New users joining a room see recent history
- Messages persist across server restarts

### 5. Data Persistence
- User nicknames and metadata stored in database
- Room configurations and membership persisted
- Message history retained (last 10 per room)

## Implementation Status

- [ ] Initial architecture design
- [ ] TCP server implementation
- [ ] HTTP server implementation
- [ ] Command parser and handler
- [ ] Room management system
- [ ] PostgreSQL persistence layer
- [ ] Message history buffering
- [ ] Local multi-instance testing
- [ ] Documentation

## Getting Started

*Instructions will be added as the implementation progresses*

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for PostgreSQL)
- netcat (for TCP client testing)
- Modern web browser (for HTTP client)

### Installation

```bash
cd discord
npm install
docker-compose up -d  # Start PostgreSQL
npm run db:migrate    # Initialize database schema
```

### Running the Service

```bash
# Run single instance (development)
npm run dev

# Run multiple instances (simulates distribution)
npm run dev:server1  # TCP: 9001, HTTP: 3001
npm run dev:server2  # TCP: 9002, HTTP: 3002
npm run dev:server3  # TCP: 9003, HTTP: 3003
```

### Connecting as a Client

**TCP (netcat):**
```bash
nc localhost 9001
# You'll be prompted for a nickname
# Then you can use slash commands
```

**HTTP (browser):**
```bash
# Open in browser
http://localhost:3001
```

## Testing

```bash
# Run unit tests
npm test

# Run integration tests (TCP + HTTP)
npm run test:integration

# Test with multiple netcat connections
nc localhost 9001 &
nc localhost 9001 &
# Both clients can interact in the same rooms
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation covering:
- Why TCP and HTTP together?
- How do both protocols share state?
- Message routing and history implementation
- Database schema design
- Scalability considerations

## Development Notes

See [claude.md](./claude.md) for development insights including:
- Design decision rationale
- Alternative approaches considered
- Trade-offs and compromises
- Learning reflections

## Example Session

```
$ nc localhost 9001
Welcome to Baby Discord!
Enter your nickname: alice

[alice] Connected to server
[alice] Type /help for available commands

> /create general
[alice] Created and joined room: general

> Hello world!
[general] alice: Hello world!

> /list
[general] Users online: alice

# Another user (bob) joins from browser...

[general] bob joined the room

> /nick alice_admin
[general] alice_admin: Nickname changed from alice

> /help
Available commands:
  /help - Show this message
  /nick <name> - Change nickname
  /list - List users
  /quit - Disconnect
  /create <room> - Create room
  /join <room> - Join room
  /rooms - List all rooms
  /leave - Leave current room
```

## Future Enhancements

- [ ] Room persistence across server restarts
- [ ] User authentication and accounts
- [ ] Private direct messages
- [ ] Message editing and deletion
- [ ] Rate limiting per user
- [ ] WebSocket support for HTTP clients (lower latency)
- [ ] Horizontal scaling with shared state (Valkey/Redis pub/sub)

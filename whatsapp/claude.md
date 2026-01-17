# WhatsApp - Messaging Platform - Development with Claude

## Project Context

This document tracks the development journey of implementing a real-time messaging platform with end-to-end encryption.

## Key Challenges to Explore

1. Real-time message delivery
2. End-to-end encryption
3. Offline message storage
4. Group chat at scale

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Completed:**
- Defined core functional requirements (1:1 messaging, groups, presence, delivery receipts)
- Established tech stack (Node.js/Express, PostgreSQL, Redis, React 19)
- Designed database schema for users, conversations, messages, and message status
- Planned WebSocket-based real-time communication with Redis pub/sub for cross-server messaging

### Phase 2: Initial Implementation
*In progress*

**Completed:**
- Docker Compose setup with PostgreSQL and Redis
- Backend server with Express + WebSocket (ws library)
- Session-based authentication with Redis store
- Database schema with users, conversations, messages, message_status tables
- REST API endpoints for auth, conversations, and messages
- WebSocket handler for real-time messaging:
  - Message sending/receiving
  - Delivery receipts (sent, delivered, read)
  - Typing indicators
  - User presence (online/offline)
  - Cross-server message routing via Redis pub/sub
- Frontend React application:
  - Login/Register forms
  - Conversation list with unread counts
  - Chat view with message history
  - Real-time message updates
  - Typing indicators
  - Message status indicators (sent, delivered, read)
  - New chat/group creation dialog

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer
- Optimize database queries
- Implement load balancing
- Add monitoring

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### WebSocket vs Long Polling
**Decision:** WebSocket with ws library
**Rationale:** Lower latency, full-duplex communication, efficient for real-time messaging. Native browser support is widespread.

### Session Storage
**Decision:** Redis-backed sessions with connect-redis
**Rationale:** Enables distributed session storage across multiple server instances, supports session sharing for WebSocket authentication.

### Message Persistence
**Decision:** PostgreSQL for messages
**Rationale:** For learning project scale, PostgreSQL handles message storage well. In production at WhatsApp scale, Cassandra would be preferred for its write-optimized, partition-friendly design.

### Cross-Server Messaging
**Decision:** Redis Pub/Sub
**Rationale:** Simple to implement, low latency for real-time routing. Each server subscribes to its own channel and publishes to target server's channel when routing messages.

### Message Delivery Flow
1. Sender sends message via WebSocket
2. Server persists to PostgreSQL
3. Server looks up recipient's connected server in Redis
4. If same server: deliver directly
5. If different server: publish to Redis, target server delivers
6. If offline: message stays in DB, delivered on next connect

## Iterations and Learnings

### Iteration 1: Basic Setup
- Set up Docker Compose with PostgreSQL and Redis
- Created Express backend with session authentication
- Implemented basic REST API for users and conversations

### Iteration 2: WebSocket Integration
- Added WebSocket server alongside Express
- Implemented session sharing between HTTP and WebSocket
- Created presence tracking with Redis

### Iteration 3: Message Flow
- Implemented message sending via WebSocket
- Added optimistic updates on frontend
- Integrated delivery receipts (sent, delivered, read)

### Iteration 4: Real-time Features
- Added typing indicators with Redis expiry
- Implemented presence broadcasting
- Created cross-server message routing via Redis pub/sub

## Questions and Discussions

### How to handle message ordering?
Current approach: Use database timestamp for ordering, client sorts messages by created_at. For strict ordering, we'd need sequence numbers per conversation.

### How to scale WebSocket connections?
Current design supports multiple server instances with Redis pub/sub for message routing. Load balancer should use sticky sessions for WebSocket connections.

### How to handle offline message delivery?
Messages are persisted to DB with 'sent' status. On user connect, we query for pending messages and deliver them, updating status to 'delivered'.

## Resources and References

- [WhatsApp System Design - system-design-answer.md](./system-design-answer.md)
- [WebSocket API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [Redis Pub/Sub](https://redis.io/topics/pubsub)
- [ws - Node.js WebSocket library](https://github.com/websockets/ws)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add media sharing support
- [ ] Implement end-to-end encryption
- [ ] Add group admin features
- [ ] Performance testing

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*

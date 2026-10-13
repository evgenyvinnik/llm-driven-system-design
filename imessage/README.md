# Design iMessage - Cross-Device Messaging

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 8,721 |
| Source Files | 59 |
| .ts | 4,478 |
| .md | 2,236 |
| .tsx | 1,098 |
| .sql | 564 |
| .json | 146 |

## Overview

A simplified iMessage-style messaging platform focused on **delivery semantics across devices**: one order per conversation that every device agrees on, durable per-device delivery with acknowledgements, receipts that sync across a user's own devices, and sends that are safe to retry. See [architecture.md](./architecture.md) for the design and [CLAUDE.md](./CLAUDE.md) for iteration history.

## Key Features

- **Ordered conversations**: every message gets a per-conversation sequence number (`seq`) inside the send transaction; the client renders by `seq`, pages history by `seq`, and detects gaps with it.
- **Idempotent sends**: each send carries a client-generated `clientMessageId` (or an `Idempotency-Key` header on REST); retries return the original message.
- **Per-device delivery**: every recipient device — including the sender's other devices — gets a row in `device_inbox`; a device receives its backlog when it connects and acknowledges what it applied.
- **Receipts**: "Delivered" when a recipient device acks, "Read" from a monotonic read watermark; reading on one device clears the badge on the others.
- **Multi-device**: one device per browser installation; device revocation closes its sockets and invalidates its sessions.
- Typing indicators, reactions, group conversations with admin controls, presence, rate limiting.

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + WebSocket (`ws`)
- **Database:** PostgreSQL 16
- **Pub/sub, sessions, presence, rate limits:** Valkey/Redis 7

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (or a native PostgreSQL + Redis, below)

### 1. Start Infrastructure

```bash
cd imessage
docker-compose up -d
```

This starts PostgreSQL on 5432 (schema loaded from `backend/src/db/init.sql`) and Valkey on 6379. Load the sample data:

```bash
PGPASSWORD=imessage_secret psql -h localhost -U imessage -d imessage -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
```

Seeded logins (password `password123`): `alice@example.com`, `bob@example.com`, `charlie@example.com`, `admin@example.com`.

### 2. Start Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev          # API + WebSocket on http://localhost:3000
```

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

### 4. Try It

Open http://localhost:5173 in two different browsers (or a normal and a private window) and log in as Alice and Bob. Each browser is its own device. Close one, send it messages from the other, reopen it: the backlog arrives on connect. Log in as Alice in a third browser to see a message you send appear on your other device too.

## Tests and Checks

```bash
cd backend && npm test && npm run type-check && npm run lint
cd frontend && npm test && npm run build && npm run lint
```

Backend tests cover the send transaction (seq, duplicate handling, membership, rollback), inbox acks, the read watermark, receipt grouping, the connection registry and the rate limiter; frontend tests cover the message-list merge rules.

## Running Multiple Backend Instances

```bash
cd backend
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

All instances share PostgreSQL and Redis; Redis pub/sub carries live events between them, and the device inbox makes delivery independent of which instance a device is connected to.

## Project Structure

```
imessage/
├── docker-compose.yml          # PostgreSQL + Valkey
├── backend/
│   ├── db-seed/seed.sql        # Sample users, devices, conversations, messages
│   └── src/
│       ├── index.ts            # Express + WebSocket server, inbox sweep, graceful shutdown
│       ├── db.ts, redis.ts     # PostgreSQL pool; Redis clients, sessions, presence
│       ├── db/init.sql         # Schema (re-runnable)
│       ├── middleware/auth.ts  # Bearer-token sessions
│       ├── routes/             # auth, conversations, messages, users
│       ├── services/
│       │   ├── messages.ts     # Send transaction, inbox drain/ack, read watermark
│       │   ├── websocket.ts    # Socket lifecycle, frames, pub/sub delivery
│       │   ├── realtime.ts     # Pub/sub channels and event shapes
│       │   └── auth.ts, conversations.ts, users.ts
│       └── shared/             # logger, metrics, health, rate limiter, connection registry
└── frontend/src/
    ├── lib/messageList.ts      # Merge rules: dedupe, order by seq, statuses, gaps
    ├── stores/                 # chatStore (all incoming frames), authStore
    ├── services/               # REST client, WebSocket client with outbox and reconnect
    ├── components/             # ConversationList, ChatView, MessageBubble, ConnectionBanner, ...
    └── routes/                 # TanStack Router
```

## API Endpoints

### Authentication
- `POST /api/auth/register`, `POST /api/auth/login` — body may include `installId` (this browser's installation ID; same ID → same device)
- `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/auth/devices`, `DELETE /api/auth/devices/:deviceId` — revoke a device (sessions, inbox, open sockets)

### Conversations
- `GET /api/conversations` — with last message (including `seq`) and unread count
- `GET /api/conversations/:id`
- `POST /api/conversations/direct`, `POST /api/conversations/group`
- `POST /api/conversations/:id/participants`, `DELETE /api/conversations/:id/participants/:userId`, `DELETE /api/conversations/:id/leave`

### Messages
- `GET /api/messages/conversation/:id?limit=&before_seq=&after_seq=` — oldest-first page; own messages carry `status`
- `POST /api/messages/conversation/:id` — REST send; `clientMessageId` in the body or an `Idempotency-Key` header (201 new, 200 duplicate, 403, 422 reused key with different content, 429)
- `GET /api/messages/inbox`, `POST /api/messages/inbox/ack` — REST fallback for the device inbox
- `POST /api/messages/conversation/:id/read` — advance the read watermark
- `GET /api/messages/conversation/:id/read-receipts`
- `GET`, `PATCH`, `DELETE /api/messages/:id`
- `POST /api/messages/:id/reactions`, `DELETE /api/messages/:id/reactions/:reaction`

### Users
- `GET /api/users/search?q=query`, `GET /api/users/:id`, `PATCH /api/users/me`

### Operations
- `GET /health/live`, `GET /health/ready`, `GET /health`, `GET /metrics`

## WebSocket Protocol

Connect to `ws://localhost:3000/ws?token=YOUR_TOKEN`. Frames from one socket are processed in order.

### Client → Server

```javascript
{ type: 'send_message', conversationId, content, clientMessageId }  // reuse clientMessageId on retry
{ type: 'ack', messageIds: [...] }          // after applying new_message / sync_batch
{ type: 'sync' }                            // next inbox batch
{ type: 'read', conversationId, messageId } // advance the read watermark
{ type: 'typing', conversationId, isTyping }
{ type: 'reaction', messageId, reaction, remove }
```

### Server → Client

```javascript
{ type: 'connected', userId, deviceId }
{ type: 'sync_batch', messages: [...], hasMore }       // on connect and on 'sync'
{ type: 'message_sent', clientMessageId, message, isDuplicate }
{ type: 'new_message', message }                       // message.seq orders it
{ type: 'delivery_receipt', conversationId, messageIds, userId, deviceId }
{ type: 'read_receipt', conversationId, userId, deviceId, seq, messageId }
{ type: 'typing', conversationId, userId, username, displayName, isTyping }
{ type: 'reaction_update', conversationId, messageId, userId, reaction, remove }
{ type: 'presence', userId, status }
{ type: 'error', code, error, clientMessageId }       // code: invalid | forbidden | rate_limited | idempotency_conflict
```

Close codes: `4001` invalid token, `4003` device revoked, `1001` server shutting down (reconnect elsewhere).

## Native Development (without Docker)

### PostgreSQL

```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16
psql postgres -c "CREATE ROLE imessage LOGIN PASSWORD 'imessage_secret'"
createdb -O imessage imessage
PGPASSWORD=imessage_secret psql -h localhost -U imessage -d imessage -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=imessage_secret psql -h localhost -U imessage -d imessage -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
```

### Redis

```bash
brew install redis
brew services start redis
redis-cli ping
```

## Environment Variables

### Backend (.env)

```bash
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://imessage:imessage_secret@localhost:5432/imessage
REDIS_URL=redis://localhost:6379
SESSION_EXPIRY_HOURS=720
CORS_ORIGIN=http://localhost:5173
WS_HEARTBEAT_INTERVAL=30000      # ping interval; unanswered sockets are terminated
INBOX_RETENTION_DAYS=30          # undelivered inbox rows older than this are swept hourly
LOG_LEVEL=debug
```

## Known Limitations

- No end-to-end encryption: messages are stored as plaintext; the key tables are seeded placeholders.
- Edits and deletes are not pushed to other devices; membership changes are not sequenced.
- The web client keeps messages and unsent messages in memory only; a reload loses messages typed offline.
- Seeded phone/tablet devices never connect, so their inbox rows accumulate until the retention sweep.

## References & Inspiration

- [iMessage Security Overview](https://support.apple.com/guide/security/imessage-security-overview-secd0c9a5c93/web) - Apple's documentation on iMessage encryption
- [Apple Platform Security Guide](https://support.apple.com/guide/security/welcome/web) - Comprehensive security documentation for Apple services
- [Signal Protocol Documentation](https://signal.org/docs/) - End-to-end encryption protocol used by many messaging apps
- [Double Ratchet Algorithm](https://signal.org/docs/specifications/doubleratchet/) - Forward secrecy in messaging systems
- [X3DH Key Agreement Protocol](https://signal.org/docs/specifications/x3dh/) - Extended Triple Diffie-Hellman for establishing sessions
- [WhatsApp Encryption Overview](https://www.whatsapp.com/security/) - Another implementation of secure messaging

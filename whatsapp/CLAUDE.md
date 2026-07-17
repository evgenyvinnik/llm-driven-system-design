# WhatsApp — Messaging Platform — Development with Claude

## Project Context

A real-time messaging platform: 1:1 and group chats with presence, typing indicators, delivery/read receipts, emoji reactions, and an offline-first client that keeps working with no network. The core hard problem is **delivering a message in real time to a recipient who may be connected to a different server instance — or not connected at all** — while the receipts and presence that make chat feel alive stay consistent across those instances.

**Learning goals:** WebSocket fan-out across horizontally-scaled servers (Redis pub/sub), per-recipient delivery-state tracking, presence/typing ephemera, and offline-first sync from an IndexedDB client cache.

## Architecture at a Glance (what actually runs)

Matches `docker-compose.yml` (two services) and `backend/package.json`:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** | `pg` | Durable: users, conversations, participants, messages, `message_status` (per-recipient), reactions | ACID; a message and its per-recipient receipts must not diverge |
| **Redis / Valkey** | `ioredis` | Session store, **cross-server pub/sub** for message/presence routing, presence + typing keys (TTL), rate-limit buckets | Fan-out between instances + sub-ms ephemeral state that should auto-expire |

**WebSocket-first backend:** a `ws` server (`backend/src/websocket/`) split into `connection-manager`, `message-handler`, `presence`, `typing-handler`, `chat-handler`, and `redis-handler` (the cross-instance bridge). REST (`routes/auth`, `conversations`, `messages`) handles login and history; live traffic is all WebSocket. Resilience via `opossum` (`shared/circuitBreaker`), `shared/deliveryTracker`, `rate-limit-redis`, `prom-client`, `pino`. **Frontend:** React 19 + TanStack Router + Zustand, **offline-first** — `dexie` (IndexedDB) caches messages locally, `vite-plugin-pwa` makes it installable/offline, `@tanstack/react-virtual` virtualizes long message lists, sends are optimistic.

## Key Design Decisions

### 1. WebSocket + Redis pub/sub, not sticky-only or Kafka
Each server owns the WebSocket connections of the users attached to it. To deliver a message the sender's server persists to Postgres, looks up the recipient's server, and — if it's a *different* instance — publishes to that server's Redis channel, which pushes it down the recipient's socket. Trade-off: Redis pub/sub is fire-and-forget with no persistence, which is exactly right here because the message is *already durable in Postgres* before routing — if a server misses the pub/sub event (it was down), the recipient pulls the message from the DB on reconnect. Kafka's durability/consumer-groups would add overhead for a delivery hop that doesn't need replay.

### 2. Per-recipient `message_status`, not a single flag on the message
Delivery state lives in its own row per (message, recipient) with `sent → delivered → read` and timestamps. This is what makes group receipts correct: in a 10-person group, "delivered" means different things to different members at different times. Trade-off: a fan-out of status rows per message (N rows for an N-person group) and more writes, but it's the only model where the double-check-marks are actually truthful per person.

### 3. Presence and typing are ephemeral Redis keys with TTL, never Postgres
Online status and "Alice is typing…" are written to Redis with short TTLs and broadcast over pub/sub; they never touch the durable store. Trade-off: presence can be briefly stale (a crashed client shows online until its key expires), which is the correct trade — persisting presence would generate enormous write churn for data that's worthless a second later.

### 4. Offline-first client with IndexedDB (Dexie)
The client is the source of truth for *display*: messages land in IndexedDB, the UI renders from there, and sends are optimistic (shown immediately, reconciled when the server acks). On reconnect the client syncs missed messages. Trade-off: two copies of message state (client cache + server) that must reconcile, and optimistic sends can momentarily show before they're durable — accepted because a chat app that freezes without signal is unusable.

### 5. PostgreSQL now, Cassandra later — deliberately
Messages are a growing, write-heavy, time-ordered, partition-by-conversation workload — the textbook Cassandra shape at 2B users. At local scale a single Postgres is simpler and the access patterns are identical, so the migration path (partition by conversation, cluster by time) is preserved without paying Cassandra's operational cost now.

## Current State

Implemented end to end: session auth (Redis-backed, shared between HTTP and WebSocket), 1:1 and group conversations, real-time send/receive over WebSocket, per-recipient delivery receipts (sent/delivered/read), typing indicators, online/offline presence, emoji reactions, cross-server routing via Redis pub/sub, offline message delivery on reconnect, an offline-first PWA client (Dexie/IndexedDB, optimistic sends, virtualized lists), circuit breakers, Redis rate limiting, Prometheus metrics, and pino logging.

**Not implemented (production layer only):** end-to-end encryption — **messages are stored plaintext** (`messages.content`); the Signal Protocol is described in `architecture.md` as the production ideal and listed as a future phase, not a shipped feature. Also omitted: media upload/download (columns exist, no S3/CDN flow), voice/video calling (no TURN/STUN), and Cassandra/Kafka/S3 (their production roles are stood in by Postgres + Redis).

## Iteration & Repair Log

- **WebSocket built out in layers** (per the design log): basic setup → session sharing between HTTP and WS → presence → message flow with optimistic updates → typing/presence broadcast → cross-server pub/sub routing. The pub/sub step is what let a message reach a recipient on another instance.
- **Offline-first added on the client:** Dexie/IndexedDB + `vite-plugin-pwa` so the app renders and queues sends with no network; missed messages sync on reconnect.
- **Seed password normalization (repo-wide):** demo users `alice / bob / charlie` all log in with **`password123`** (bcrypt); README table matches. Docker Postgres uses `whatsapp_secret` (infra credential, unchanged).
- **Doc drift fixes (this pass):** the old CLAUDE.md's Project Context claimed the platform has "end-to-end encryption" and used banned Phase-1/2/3/4 checklists. Corrected: E2E is production-ideal only (plaintext locally, per `architecture.md` Implementation Notes), and the file now covers the offline-first frontend it never mentioned. `architecture.md` already frames Cassandra/Kafka/S3/Signal correctly as production with a "What Was Simplified" table — left as-is.
- **CI note (repo-wide):** the GitHub Actions smoke-test workflow was removed; don't treat it as active.

## Open Questions

1. Message ordering currently relies on `created_at`; under clock skew across instances, does a per-conversation sequence number become necessary, and where does it get assigned?
2. Redis pub/sub is best-effort — the DB backstop covers a downed server, but is there a window where a message is "delivered" to a socket that silently dropped? Does the receipt need an app-level ack, not just a socket write?
3. Presence via TTL keys is eventually consistent — is the "ghost online" window (crashed client) short enough, or do we need heartbeats?
4. Offline sync pulls missed messages on reconnect — how does that scale for a user offline for days in busy groups, and does it need cursor-based backfill?

## Resources

- [The Signal Protocol](https://signal.org/docs/) — the production E2E design (not built here)
- [Redis Pub/Sub](https://redis.io/docs/latest/develop/interact/pubsub/) · [ws](https://github.com/websockets/ws) · [Dexie.js](https://dexie.org/)

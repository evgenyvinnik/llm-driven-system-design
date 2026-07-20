# iMessage — Development with Claude

## Project Context

The unit of identity in most systems is the user. In a messaging system it has to be the **device**, and almost every hard problem here follows from that. A message isn't delivered to Alice — it's delivered to Alice's phone, her laptop, and her tablet, each of which may be online, offline, or newly registered. Read state is per-device (reading on the phone should clear the badge on the laptop). Delivery receipts are per-device. In a real E2E design even the encryption key is per-device, because a device that didn't exist when a message was sent must not be able to read it.

That fan-out shape is what makes "did this message arrive?" a genuinely hard question. The sender's phone is online, the recipient has three devices, one of which is in airplane mode — the message has to be durably queued for that one, delivered instantly to the other two, and none of it can block the sender's UI. So delivery is split: a Redis pub/sub bus routes to whichever server instance holds a given device's WebSocket, and anything with no live connection lands in a per-device offline queue with a 7-day TTL.

The second theme is that a phone on a flaky network retries, and a retried "send" must not produce two messages. Every send carries a client-generated `clientMessageId`, and the server keys idempotency off `(userId, conversationId, clientMessageId)` — so the retry returns the original message rather than duplicating it into the conversation.

**Learning goals:** device-centric data modeling, WebSocket presence and delivery across multiple server instances via Redis pub/sub, per-device offline queuing, idempotent sends over an unreliable client, and a schema that anticipates E2E encryption without the server ever holding plaintext.

## Architecture at a Glance (what actually runs)

| Component | Where | Why this one |
|-----------|-------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`, port **3000**) | `npm run dev` (`tsx watch`) | Express plus a `ws` server mounted at `/ws` on the same HTTP server; `dev:server1/2/3` pin 3001–3003 to exercise cross-instance routing |
| **PostgreSQL 16** (5432) | `docker-compose.yml` | `users`, `devices`, `device_keys`, `prekeys`, `conversations`, `conversation_participants`, `messages`, `message_keys`, `attachments`, `reactions`, `read_receipts`, `delivery_receipts`, `sync_cursors`, `sessions`, `idempotency_keys` |
| **Valkey/Redis 7** (6379) | `docker-compose.yml` | Four distinct jobs: pub/sub fan-out (`messages`, `typing`, `presence`, `read_receipts`, `reactions`), presence keys, the connection registry (`device → serverId`), and per-device offline queues |

`backend/src/services/websocket.ts` is the core: it authenticates the socket from a `?token=` query param, registers `userId → Map<deviceId, ws>` locally *and* `addConnection(userId, deviceId, SERVER_ID)` in Redis, subscribes to five pub/sub channels, and drains `getOfflineMessages` on connect. Message logic is in `services/messages.ts` (send, edit, soft delete, reactions, read receipts) with idempotency via `shared/idempotency.ts`. `shared/conversation-cache.ts` caches conversation metadata and participant lists with a 10-minute TTL — participant checks happen on every single send, so this is the difference between one Postgres round trip per message and none. `shared/rate-limiter.ts` implements a Redis sorted-set sliding window.

Frontend is React 19 + TanStack Router + Zustand + Tailwind: `ConversationList`, `ChatView`, `MessageBubble`, `TypingIndicator`, with `hooks/useWebSocket.ts` owning the socket lifecycle and `stores/chatStore.ts` doing optimistic sends that reconcile against the server response. Vite proxies `/api` and `/ws` → `localhost:3000`.

## Key Design Decisions

### 1. Device is the primary entity; user is a grouping over devices
`devices` is a first-class table, `sessions` carry a `device_id`, WebSocket connections are keyed `userId → Map<deviceId, ws>`, and `read_receipts` and `delivery_receipts` are both primary-keyed on the device.

Modeling per-user instead is simpler and produces immediately visible bugs. Read state is the clearest: with one read pointer per user, reading a conversation on your laptop marks it read everywhere — which is arguably what you want — but *delivery* per-user is incoherent, because "delivered" would be true the moment any one device received it, and the phone in your pocket that never got it would never be retried. Per-device delivery means the offline queue has an exact addressee. The other reason is forward-looking: in a real E2E design each device holds its own keypair, so a message key must be wrapped once per recipient device (`message_keys` is keyed `(message_id, device_id)` for exactly this). A user-level model has nowhere to put that.

What we give up is fan-out cost that scales with total device count, not user count. A 10-person group where everyone has 3 devices means 30 encrypted key blobs per message and 30 delivery rows. That's the real reason group messaging at scale moves to sender-keys — one key per conversation, distributed pairwise once — rather than the per-device wrapping this schema does.

### 2. Routing is Redis pub/sub plus a connection registry, not sticky sessions
On send, the server publishes to a Redis channel; every instance receives it and delivers to whichever of the target devices it happens to hold. `addConnection` also records `device → SERVER_ID` in Redis.

Sticky sessions — pinning a user to one instance at the load balancer — would let a server deliver locally with no broker. It breaks on the fundamental asymmetry of chat: the *sender* and the *recipient* are different users, so even perfect stickiness puts them on different instances most of the time. Stickiness only helps if you pin by *conversation*, which fails as soon as a user is in many conversations and would need many affinities at once. Pub/sub sidesteps the question entirely: any instance can accept any connection, and delivery is a broadcast that all but one instance ignores.

The cost is that every message is delivered to every instance regardless of relevance — at N instances that's N× the fan-out traffic for one recipient's benefit. Fine at 3 instances, wasteful at 300, which is where the connection registry earns its keep: it's the data needed to switch from broadcast to targeted routing later, and it's being maintained now even though nothing reads it for routing yet.

### 3. Offline messages queue per device in Redis with a 7-day TTL, drained on connect
`queueOfflineMessage` does `RPUSH offline:<userId>:<deviceId>` with a 7-day expiry; `getOfflineMessages` does `LRANGE` then `DEL` and the socket handler replays them on connect.

Reconstructing what a device missed from Postgres on every reconnect is the alternative, and it's a heavier query than it looks: "all messages in all conversations this device participates in since its last sync cursor," across a table that grows forever. A phone reconnecting every time it changes cell towers would run that repeatedly. A Redis list is O(1) to append and one round trip to drain.

The trade-off is a real durability gap, and it's worth being precise about it. `LRANGE` followed by `DEL` is **not atomic with delivery** — if the socket drops between the `DEL` and the client actually processing the batch, those messages are gone from the queue. They still exist in Postgres, so the data isn't lost, but nothing automatically re-delivers them; the `sync_cursors` table exists to close exactly this hole and isn't wired into the reconnect path yet. Seven days is also a hard ceiling: a device offline longer than that must fall back to a full sync that isn't implemented.

### 4. Idempotency keys on `(userId, conversationId, clientMessageId)`, supplied by the client
`sendMessage` checks the idempotency key before inserting and returns the original message on a duplicate.

The server cannot deduplicate this on its own. Content hashing is wrong — sending "ok" twice on purpose is completely normal and must produce two messages. Only the client knows whether this is a *new* send or a *retry of the same send*, so the client generates the ID at compose time and reuses it across retries. Without it, the failure mode is nasty and common: a phone sends, the network drops before the ack, the phone retries on reconnect, and the conversation shows the message twice — with the duplicate visible to everyone, permanently.

What we give up: correctness depends on client discipline. A client that regenerates the ID per attempt gets no protection at all. And `idempotency_keys` grows monotonically — the schema documents a daily cleanup (`DELETE ... WHERE created_at < NOW() - INTERVAL '24 hours'`) as a commented-out maintenance query, but nothing runs it.

### 5. The schema is E2E-ready; the implementation is not, and that's explicit
`messages` has both `content` (plaintext) and `encrypted_content` + `iv`; `device_keys` holds identity and signing public keys; `prekeys` models X3DH one-time keys with a `used` flag. **No client-side cryptography exists** — messages are sent and stored as plaintext in `content`.

This is a deliberate split rather than an oversight. The interesting *systems* problems — per-device fan-out, key distribution shape, prekey exhaustion, the fact that the server must be able to route and queue data it cannot read — are all visible in the schema and the delivery paths. Implementing X3DH and Double Ratchet correctly in the browser is a large, self-contained cryptography project that would teach key management rather than distributed messaging, and getting it subtly wrong produces something that *looks* encrypted while being insecure. Half-built encryption is worse than none, because it invites trust it hasn't earned. The columns document the intended design; the plaintext path makes it clear nothing is actually protected.

## Current State

Runs end to end. `docker-compose up -d` starts Postgres (schema auto-loaded from `backend/src/db/init.sql`) and Valkey; `npm run dev` starts the API and WebSocket server on 3000. Working: registration and login with bcrypt, which creates a device row and a device-scoped session; conversation creation (direct and group) with participant management; real-time messaging over WebSocket with optimistic client-side sends reconciled against the server response; typing indicators; read and delivery receipts; message reactions; message edit and soft delete; per-device offline queuing drained on reconnect; presence tracking; Redis pub/sub so instances on 3001–3003 route to each other's connections; conversation and participant caching with a 10-minute TTL and invalidation on membership change; a Redis sliding-window rate limiter; heartbeat/`isAlive` ping-pong to reap dead sockets; prom-client metrics including cache hits and misses; Pino structured logging with request IDs; and health checks.

Seeded logins, all with password `password123`: `alice@example.com`, `bob@example.com`, `charlie@example.com`, and `admin@example.com` (`system_admin` role). The seed includes both direct and group conversations with message history, so the multi-participant fan-out path is exercised on first load.

Simplified or omitted: **no encryption** (decision 5) — `encrypted_content`, `iv`, `message_keys`, and `prekeys` are modeled but unused. `sync_cursors` exists but nothing reads or writes it, so reconnect relies solely on the offline queue. No attachment upload (the `attachments` table has no route behind it). No push notifications — a device with no WebSocket gets the queue, not an APNs/FCM wake. No group sender-keys, no message search, and no idempotency-key cleanup job.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. The old checklist was wrong in both directions: **"Phase 3: Multi-Device"** listed device registration, per-device encryption, message sync, and read-state sync as four unchecked boxes, when device registration happens on every login in `services/auth.ts`, connections are keyed by device, and `read_receipts` is primary-keyed `(user_id, device_id, conversation_id)` — device-centricity is the *foundation* of the implementation, not future work. Meanwhile Phase 2 was marked "In Progress" with all its boxes checked. The old file was 30 lines long and explained nothing about how delivery actually works.
- **Illegal partial-index predicate (fixed):** the sessions cleanup index was declared with a `WHERE expires_at < NOW()` predicate. Index predicates must be `IMMUTABLE`, and `NOW()` is `STABLE`, so Postgres rejected the statement — which aborted the whole `init.sql` load from `docker-entrypoint-initdb.d`, leaving a database with **no tables at all**. Because the container still accepted connections, this surfaced downstream as seeding "succeeding" against an empty schema and then every login failing. Now a plain `CREATE INDEX idx_sessions_expired ON sessions(expires_at)`; the time comparison belongs in the cleanup query, not the index. The genuinely-immutable partial indexes (`WHERE NOT used` on prekeys, `WHERE left_at IS NULL` on participants, `WHERE deleted_at IS NOT NULL` on messages) were kept.
- **Idempotency added to send:** retried sends over flaky mobile connections were duplicating messages into conversations (decision 4).
- **Conversation and participant caching:** every send did a participant-membership check against Postgres. `shared/conversation-cache.ts` now serves it from Redis with a 10-minute TTL and explicit invalidation on membership change, taking the database off the per-message hot path.
- **Broadcast excludes the sending device**, so the composing device isn't told about its own message and doesn't clobber the optimistic bubble it already rendered.
- **Heartbeat added:** sockets are ping-ponged with an `isAlive` flag, because a WebSocket to a device that dropped off the network stays "open" indefinitely on the server side, silently accumulating dead connections and making presence permanently wrong.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Postgres/Redis services these tests need). Verification is local: `npm run type-check`, then `npm run triage imessage`.

## Open Questions

1. `sync_cursors` is modeled but unused, so the offline queue's non-atomic `LRANGE`+`DEL` is the only recovery path — a socket dropping mid-drain loses the batch. Should the drain become "read, deliver, ack, then trim," or should reconnect ignore the queue entirely and replay from the cursor against Postgres?
2. Pub/sub broadcasts every message to every instance while the `device → serverId` registry sits unread. At what instance count is it worth switching to targeted routing, given that targeting adds a Redis lookup per recipient device on the send path and goes stale the instant a device reconnects elsewhere?
3. Per-device message keys mean a 10-person group with 3 devices each needs 30 wrapped keys per message. Sender-keys collapse that to one, at the cost of a re-key on every membership change. Where's the crossover, and does it change if most groups are small?
4. The 7-day offline TTL is arbitrary. A device offline longer needs a full resync that doesn't exist — is the right answer to build that path, or to make the TTL effectively unbounded and treat the Redis queue as the durable store, which it isn't designed to be?

## Resources

- [Signal Protocol documentation](https://signal.org/docs/) — the design the `device_keys` / `prekeys` / `message_keys` schema is shaped after
- [X3DH key agreement](https://signal.org/docs/specifications/x3dh/) — why one-time prekeys exist and what "used" means
- [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) — the forward-secrecy mechanism decision 5 defers
- [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html) — including the `IMMUTABLE` predicate requirement behind the schema-load bug
- [Redis Pub/Sub](https://redis.io/docs/latest/develop/interact/pubsub/) — the cross-instance transport in `services/websocket.ts`

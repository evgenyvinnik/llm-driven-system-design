# Baby Discord — Development with Claude

## Project Context

"Baby Discord" is an educational chat server that serves the **same core logic over two transports** — raw TCP (netcat/telnet) and HTTP+SSE (browser) — while running as multiple horizontally-scaled instances that stay in sync. The interesting problem is not the chat itself but the seams: how to keep business logic transport-agnostic, how to fan a message out to clients connected to *other* instances, and where to trade durability for speed. It deliberately omits auth and rich features to keep those distributed-systems lessons in focus.

**Learning goals:** the adapter/hexagonal pattern (transport vs domain), Redis pub/sub fan-out across instances, bounded in-memory buffers with async persistence, and SSE as the "simpler than WebSocket" real-time transport.

## Architecture at a Glance (what actually runs)

Two datastores, one process type running the two transports. Matches `docker-compose.yml` (`postgres:16-alpine`, `valkey:7.2-alpine`) and `backend/package.json`:

| Store | Client lib | Role | Why this one |
|-------|-----------|------|--------------|
| **PostgreSQL 16** | `pg` | Durable record: `users` (nickname), `rooms`, `room_members`, `messages`; a `cleanup_old_messages()` plpgsql function trims to the last 10 per room | Relational membership (users ↔ rooms), ACID writes, familiar connection-pool patterns |
| **Valkey (Redis)** | `ioredis` | Cross-instance pub/sub *only* — one publisher connection + one subscriber connection per instance | Low-latency fan-out (~1-5ms) so a message sent on instance A reaches SSE/TCP clients on instances B and C |

Notably absent: **no WebSocket, no session store, no bcrypt.** Sessions live in the in-process `ConnectionManager` (keyed by UUID); the history buffer is an in-memory ring, not Redis. The backend is organized hexagonally: `core/` (transport-agnostic: `chat-handler`, `command-parser`, `connection-manager`, `room-manager`, `message-router`, `history-buffer`) with thin `adapters/` — a **TCP server** (`net` module, default port **9001**) and an **HTTP adapter** (default port **3001**) exposing REST POST for commands and **SSE** (`text/event-stream`) for server→client push. Frontend: React 19 + TanStack Router + Zustand + Tailwind, consuming SSE via the native `EventSource`.

## Key Design Decisions

### 1. Transport-agnostic core behind TCP and HTTP/SSE adapters
`ChatHandler` takes a `sessionId` + input string and returns a `CommandResult`; it never touches a socket or an HTTP response. The TCP and HTTP adapters translate protocol I/O into that uniform interface. Trade-off: two adapters is more code than a single HTTP server, but it forces the domain/transport separation that lets the same logic serve netcat and a browser — the whole pedagogical point.

### 2. SSE over WebSocket for browser real-time
Messages flow server→client over a persistent `text/event-stream`; commands flow client→server over HTTP POST. `EventSource` gives automatic reconnection for free and is inspectable with plain curl. Trade-off given up: bidirectional push. That's acceptable because the client never needs a server-initiated request channel — it POSTs commands — so WebSocket's upgrade handshake and manual reconnection logic would be pure overhead. WebSocket earns its place only when you need sub-10ms bidirectional or binary frames (voice/video), which is out of scope.

### 3. In-memory ring buffer (last 10/room) + async DB persist
Joining a room returns history from an in-memory ring buffer (~0.01ms) instead of a DB query (~10-50ms); the message is persisted to Postgres asynchronously after being buffered and routed. Trade-off: a crash between buffer-append and DB-write loses at most a handful of un-persisted messages. Accepted deliberately to teach the speed-vs-durability trade-off; a production system would front this with a WAL (Redis AOF / Postgres WAL) to close the gap.

### 4. Redis pub/sub for cross-instance fan-out, not DB polling or gossip
Each instance subscribes to room channels; sending publishes to the channel and every instance delivers to its *local* sessions (`message-router` does local delivery first, then publish). Trade-off: adds a Redis dependency, but the alternatives are worse — DB polling adds 100ms latency and constant query load, and an instance-to-instance gossip mesh is O(N²) with its own failure/discovery handling. Pub/sub is the standard fan-out primitive and scales to many instances. Known gap: no dedup safeguard against duplicate delivery (see Open Questions).

### 5. Nickname-only sessions (no authentication)
`POST /api/connect` (or a TCP connect line) calls `getOrCreateUser(nickname)` and mints a UUID session held in memory. Trade-off: anyone can claim any free nickname — but adding real auth (bcrypt, tokens) would obscure the distributed-systems lessons this project exists to teach, and it slots in later without touching the core.

## Current State

Working end to end: TCP adapter (line-based commands via netcat) and HTTP adapter (REST POST + SSE) both driving the same core; slash commands (`/join`, `/leave`, `/rooms`, etc. via `command-parser`); rooms with in-memory + DB membership; 10-message in-memory history with async Postgres persistence and a DB-side `cleanup_old_messages()` trim function; Redis pub/sub so users on different instances share rooms; three-instance local setup (`dev:server1/2/3` → HTTP 3001/3002/3003, TCP 9001/9002/9003). Observability is implemented, not aspirational: prom-client metrics at `/metrics` (connection gauge by transport, messages counter by room, pub/sub and DB latency histograms, history buffer hit/miss, cleanup runs), Pino structured logging, and `/health` + `/api/health` checks.

Intentionally omitted (documented as production extensions): authentication, WebSocket/voice/video (WebRTC), message history beyond 10, sharding/Cassandra for messages, and a WAL for zero-loss durability.

## Iteration & Repair Log

- **Doc rewrite (2026-07):** the previous CLAUDE.md was ~600 lines of phase checklists ("Phase 4: Not started"), unfilled "Reflection Questions (To be answered)", and a "Next Steps" list that still marked already-built work as to-do. It also contradicted the code: it credited logging to **Winston** (the code uses **Pino** — `utils/logger.ts`) and listed Prometheus as "optional/incomplete" (prom-client is fully wired at `/metrics`). Replaced with real decision/state history; the trade-off analyses (SSE, ring buffer, pub/sub) were salvaged and condensed.
- **README migration step was broken (fixed in README):** it instructed `npm run db:migrate`, but no such script exists — the schema in `backend/src/db/init.sql` is applied by Postgres's `docker-entrypoint-initdb.d` mount on first container start. Replaced with a note to that effect (and `docker-compose down -v` to re-init).
- **Pub/sub shipped directly (no polling phase):** the original plan was DB-polling → then migrate to Redis pub/sub to show the evolution. Implementation went straight to pub/sub; the "before/after" comparison was traded for less code. `message-router` reflects the final design.

## Open Questions

1. **Duplicate delivery:** pub/sub has no dedup — if delivery paths ever overlap, a client could see a message twice. Should messages carry a monotonic id so adapters can drop duplicates client-side?
2. **Ring-buffer durability:** messages can be lost on crash before async persist. Is a lightweight WAL worth the complexity for a learning project, or is documenting the gap enough?
3. **Bootstrap/auth:** nickname claim is unauthenticated. What's the minimal auth that adds identity without pulling a session store and password hashing into the core lessons?
4. **Backpressure:** what actually breaks first under, say, 50 concurrent netcat clients spamming a room — the DB connection pool, SSE write buffers, or the pub/sub subscriber loop? Needs a load test to answer.

## Resources

- [Node.js `net` module](https://nodejs.org/api/net.html) — the TCP adapter
- [MDN: Server-Sent Events / EventSource](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) — the browser real-time path
- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/) — cross-instance fan-out (Valkey is API-compatible)
- [Circular buffer](https://en.wikipedia.org/wiki/Circular_buffer) — the history buffer structure

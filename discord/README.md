# Baby Discord: TCP and browser chat

Baby Discord is a learning project that puts one room-based chat core behind two adapters: a raw TCP connection for terminal clients and HTTP commands plus Server-Sent Events (SSE) for browsers. It demonstrates session tracking, room membership, recent-message buffering, PostgreSQL persistence, and an attempted cross-instance fan-out path through Valkey/Redis Pub/Sub.

This is a small text-chat implementation with flat rooms. It does not implement the real Discord service's guild hierarchy, authentication, voice/video, bots, attachments, or search. Read [architecture.md](./architecture.md) for the proposed production design and an evidence-based map of the local code. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [full-stack](./system-design-answer-fullstack.md) interview answers are separate discussions.

## Current capabilities and limitations

| Area | What exists |
|------|-------------|
| Browser | Nickname entry, room navigation/creation, recent history, message composer |
| Terminal | Line-based TCP chat and slash commands through the same core |
| Identity | Anyone can claim an existing nickname; UUID sessions live in one API process |
| Persistence | Message insert is awaited before local buffer append and broadcast |
| History | Ten messages per room in an in-process array, loaded at startup and updated by local sends |
| Membership | PostgreSQL user/room records plus local connection state; counts are not reliable live presence |
| Direct messages | Delivery to currently connected sessions on the same instance; no persisted DM history |
| Operations | Pino logs, selected Prometheus instrumentation, health/storage endpoints, periodic cleanup |

Several important paths are incomplete:

- **Cross-instance chat currently fails during remote message formatting.** JSON turns the timestamp into a string; the receiving router calls a `Date` method on it, and the Pub/Sub callback catches and drops the failure. New rooms also do not trigger subscriptions after startup. Remote events never update the receiver's history buffer.
- **Live browser messages use plain text**, such as `[random] alice: hello`. The browser falls back to rendering these as system messages with a receipt-time timestamp and no message ID. The JSON formatter is defined but unused by this route. History normalizes author/time fields, so history and live presentation differ.
- SSE reconnects do not replay missed messages. The join flow fetches history before opening the stream, leaving a delivery gap. Concurrent joins and overlapping stream replacement have no generation guard. Sessions cannot move transparently between instances or survive an API restart.
- Sending clears the composer before the request succeeds. The browser ignores message/command result bodies, so validation errors and unknown outcomes may be invisible. Slash commands typed into the composer can change server state without updating the route or browser session state.
- All rooms/history are public. There are no passwords, room permissions, rate limits, stable send-retry identities, or delivery receipts. HTTP session IDs are accessible to JavaScript; this is a nickname-based demo, not an authenticated community service.

The documentation review confirmed selected paths using actual modules with mocked dependencies. It did not start the application stack or reproduce the browser/network flows end to end. Full findings are in [Implementation Notes](./architecture.md#implementation-notes).

## Stack and addresses

Use **Node.js 20 or later**, npm, and optionally netcat. The frontend uses React 19, TanStack Router, Zustand 5, Vite 6, and Tailwind CSS. The backend uses Express, `pg`, `ioredis`, Pino, and `prom-client`; there is no WebSocket library or message broker beyond Pub/Sub.

| Process | Default address | Development credentials |
|---------|-----------------|-------------------------|
| Browser | http://localhost:5173 | Claimed nickname, no password |
| HTTP/SSE API | http://localhost:3001 | In-memory session ID where required |
| TCP adapter | localhost:9001 | Enter a nickname after connecting |
| PostgreSQL 16 | localhost:5432, database `babydiscord` | `discord` / `discord` |
| Valkey 7.2 in Compose | localhost:6379 | No password |

Vite proxies `/api` to port 3001. The API, frontend, and infrastructure run as separate processes; Compose provides only PostgreSQL and Valkey.

## Option A: Docker Compose (recommended)

From the `discord` directory:

```bash
docker compose up -d
docker compose ps
```

A fresh PostgreSQL volume runs [backend/src/db/init.sql](./backend/src/db/init.sql). It creates four tables and a cleanup function, but no users or rooms. There is no `db:migrate` or `db:seed` package script.

To apply the consolidated schema to an existing database without deleting its stored data:

```bash
docker compose exec -T postgres psql -U discord -d babydiscord -v ON_ERROR_STOP=1 < backend/src/db/init.sql
```

This is a guarded schema script, not a versioned migration system. Once PostgreSQL is healthy, you can run the app and create rooms interactively, or load the optional sample data first.

### Optional sample data

For a fresh demo, before starting the backend:

```bash
docker compose exec -T postgres psql -U discord -d babydiscord -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

The seed creates eight nickname users and four usable rooms: **random**, **tech-talk**, **gaming**, and **music**, each with ten sample messages. It also creates sixteen membership rows; these represent seeded associations, not connected users.

The seed's comments assume a `system` user and `general` room that the schema does not create. Consequently, `help` and `announcements` are not created on a fresh database, and thirteen sample messages are inserted with a null room ID. They do not appear in room history. The startup count cleanup normally removes the three oldest of these null-room messages. The seed is not fully idempotent: users/rooms/memberships skip conflicts, but rerunning it appends messages.

The backend loads history once at startup. Seed before starting it, or restart after changing stored sample data. Cleanup retains ten database messages per room by default; the browser's live list can still grow beyond ten during a long session.

### Start the backend and frontend

From the project directory, in one terminal:

```bash
cd backend
npm install
npm run dev
```

In another terminal, starting from `discord`:

```bash
cd frontend
npm install
npm run dev
```

Open [Baby Discord](http://localhost:5173), enter a nickname, and select a seeded room or use the **Create Room** button. No password is required, including for existing seeded nicknames.

### Check dependencies and stop

```bash
curl http://localhost:3001/api/health
curl http://localhost:3001/health
curl http://localhost:3001/metrics
```

`/api/health` always returns HTTP 200 and reports database status in its body. `/health` intends to combine database and Pub/Sub status, but its Redis check only tests whether client objects exist, and an unhandled room-list query failure can prevent its response. Neither endpoint establishes end-to-end delivery or replay correctness.

```bash
docker compose down
```

Named volumes remain. To intentionally delete this project's database/cache volumes for a fresh demo:

```bash
docker compose down -v
```

## Option B: Native installation (macOS, no Docker)

Use the official Homebrew formulae for [PostgreSQL 16](https://formulae.brew.sh/formula/postgresql@16) and [Valkey](https://formulae.brew.sh/formula/valkey). The unversioned Valkey formula may install a newer release than Compose's 7.2 image. These native commands were inspected but not executed during the documentation review.

For a fresh Homebrew setup with ports 5432 and 6379 available:

```bash
brew install postgresql@16 valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
brew services start postgresql@16
brew services start valkey
```

Create the role and database as the local PostgreSQL administrator:

```bash
psql postgres -c "CREATE ROLE discord LOGIN PASSWORD 'discord';"
createdb -O discord babydiscord
```

From the `discord` directory, apply the schema and optional seed:

```bash
PGPASSWORD=discord psql -h localhost -U discord -d babydiscord -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=discord psql -h localhost -U discord -d babydiscord -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
PGPASSWORD=discord psql -h localhost -U discord -d babydiscord -c 'SELECT name FROM rooms ORDER BY name;'
valkey-cli ping
```

Start the backend/frontend with the same npm steps as Option A. Stop native services with `brew services stop postgresql@16` and `brew services stop valkey`.

## Configuration and multiple instances

Defaults match Compose, so no `.env` is required for the ordinary demo. **Export overrides before starting Node.** The entry point calls `dotenv.config()` after static imports have initialized configuration and singleton objects. Merely copying `.env.example` to `.env` does not reliably change ports, database settings, retention, logger settings, or instance identity. The Redis URL is read later during connection setup, making the current behavior inconsistent. [Dotenv's ESM initialization guidance](https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import)

For example, from `backend`, create and edit a local environment file, then load its simple shell-compatible assignments before launching:

```bash
cp -n .env.example .env
set -a
source .env
set +a
npm run dev
```

| Variable | Default / effect when exported before startup |
|----------|----------------------------------------------|
| `INSTANCE_ID` | `1`; must differ between instances to avoid self-origin filtering |
| `HTTP_PORT`, `TCP_PORT` | `3001`, `9001`; `PORT` is not the listener setting |
| `DATABASE_URL` | `postgresql://discord:discord@localhost:5432/babydiscord` |
| `DB_POOL_MAX` | `20` |
| `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS` | `30000`, `2000` |
| `REDIS_URL` | `redis://localhost:6379` |
| `LOG_LEVEL`, `NODE_ENV` | `info`, `development` |
| `MAX_MESSAGES_PER_ROOM` | `10` for database cleanup; memory buffer remains fixed at ten |
| `MAX_MESSAGE_AGE_HOURS` | `0`; positive values enable age cleanup after count cleanup |
| `CLEANUP_INTERVAL_MINUTES` | `5`; cleanup also starts immediately |
| `SHUTDOWN_GRACE_PERIOD_MS` | `10000`; TCP grace timer, HTTP SSE wait capped at five seconds |
| `SHUTDOWN_WARNING_INTERVAL_MS` | `2000` for TCP drain logs |

`REDIS_MAX_RETRIES`, archive settings, `DRAIN_CONNECTIONS`, and the alert-threshold settings in `.env.example` do not control implemented retry/archive/drain/alert behavior. They are defined configuration fields without the corresponding active paths. There is no circuit breaker or alerting service.

For the multi-instance experiment, use separate terminals in `backend`:

```bash
npm run dev:server1
```

```bash
npm run dev:server2
```

```bash
npm run dev:server3
```

These scripts set distinct IDs and HTTP/TCP port pairs: 3001/9001, 3002/9002, and 3003/9003. Vite still targets only 3001; there is no load balancer. A session created on one process is invalid on another. The remote timestamp bug described above prevents the advertised cross-instance chat path from currently working; starting more instances does not repair it.

## Try TCP and HTTP commands

Connect to the same instance as the browser for the local cross-protocol path:

```bash
nc localhost 9001
```

Enter a nickname at the prompt. Join `random` if seeded, or create a room first. TCP preserves textual command results; the browser composer currently ignores many of those responses.

| Input | Behavior |
|-------|----------|
| `/help` | List commands |
| `/create demo` | Create a lowercase room and join it |
| `/join random` | Join an existing room and return recent local history |
| `/rooms` | List stored rooms and membership counts |
| `/list` | List sessions in the current room on this instance only |
| `/nick new-name` | Rename the database user and this session; other sessions may keep an old nickname |
| `/dm bob hello` | Send an ephemeral direct message to Bob's local sessions |
| `/leave` | Leave the current room |
| `/quit` | TCP disconnect; the browser composer does not complete the equivalent disconnect flow |
| Ordinary text | Persist and broadcast a room message |

Unknown slash commands are treated as ordinary message text. `/nick` checks length but does not enforce the character rules used by initial nickname entry. There is no application-level message-length limit shared across the two transports.

An HTTP session can also be created directly:

```bash
curl http://localhost:3001/api/connect -H 'Content-Type: application/json' -d '{"nickname":"demo-user"}'
```

Use its returned session ID for commands and the SSE stream on **the same API port**. Current paths include `/api/command`, `/api/message`, `/api/rooms`, `/api/rooms/:room/history`, `/api/messages/:room?sessionId=...`, `/api/session/:sessionId`, `/api/disconnect`, and `/api/storage`. See [API Design](./architecture.md#api-design) for response and lifecycle details.

## Verification and source map

| Command | What it covers |
|---------|----------------|
| `npm run build` in `backend` | TypeScript compilation to `dist`; `npm start` runs `dist/index.js` |
| `npm test` in `backend` | 28 mocked HTTP route tests; core/DB/Pub/Sub are mocked |
| `npm run build` in `frontend` | TypeScript check followed by Vite build |
| `npm run lint` in either package | Existing lint commands |
| `npm run test:e2e` in `discord` | Existing six Playwright smoke tests; known fixture/selector mismatches |

The smoke helper looks for a password field that this UI does not have. Other stale assumptions include a `general` room and a `main` element. These tests do not currently establish successful chat delivery. The screenshot configuration has newer nickname-only login and four-room paths, but broad page selectors are still not delivery assertions.

Start with [chat handling](./backend/src/core/chat-handler.ts), [history storage](./backend/src/core/history-buffer.ts), [message routing](./backend/src/core/message-router.ts), [SSE adaptation](./backend/src/adapters/http/sse-handler.ts), [browser state](./frontend/src/stores/chatStore.ts), and [schema](./backend/src/db/init.sql). [CLAUDE.md](./CLAUDE.md) contains historical notes; its asynchronous-persistence and complete-fan-out claims differ from current source.

The review read the application/configuration and ran isolated checks with mocked dependencies. Builds, the existing test suites, real database/Redis startup, browser flows, and load tests were not run. Application code was not changed.

## Recorded codebase statistics

Previously recorded repository figures, not recalculated for this revision:

| Metric | Value |
|--------|-------|
| Total SLOC | 9,570 |
| Source files | 70 |
| TypeScript | 6,078 |
| Markdown | 2,088 |
| TSX | 793 |
| SQL | 267 |
| JSON | 163 |

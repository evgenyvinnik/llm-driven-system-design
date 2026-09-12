# Facebook Live Comments

A local learning project for the comments beside a live video: viewers choose a demo identity, join a stream, post text, and send six kinds of emoji reactions. It demonstrates WebSocket rooms, comment batching, reaction aggregation, and a small recent-history cache. The video player loops sample MP4 files; this project does not implement video ingest, transcoding, or live video distribution.

[Architecture](./architecture.md) separates the proposed production system from the code here. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [full-stack](./system-design-answer-fullstack.md) answers are spoken interview designs, not feature inventories.

## What you can try

- Open two browser windows, choose different identities, and select **Live Coding Session**.
- Post a short comment and see the WebSocket echo in both windows. Comments are saved before entering a 100 ms batcher.
- Tap Like, Love, Haha, Wow, Sad, or Angry. The gateway aggregates reaction **deltas** every 500 ms; the UI draws representative floating emoji.
- Switch to **Gaming Stream**. Joining fetches up to 50 recent comments; the client keeps at most 200 comment entries.
- Inspect the seeded pinned/highlighted styling. These are ordinary rows with badges/backgrounds, not a separate pinned panel.

The identity buttons are a demo selector, **not authentication**. Moderator/admin roles are seed data; there is no admin screen or working comment moderation UI. Reaction counts accumulate in the store but are not displayed as numeric totals.

## Stack and boundaries

| Layer | Implementation |
|-------|----------------|
| Browser | React 19, TypeScript, Vite, Zustand, Tailwind CSS |
| Server | Node.js 20+, Express, `ws`; HTTP and sockets share a process |
| Durable records | PostgreSQL 16: users, streams, comments, reactions, bans |
| Shared transient state | Valkey 7 through ioredis: recent comments, rate counters, reaction counts, Pub/Sub |
| Instrumentation | Pino, prom-client, Opossum around the shared query wrapper |

There is no Kafka, Cassandra, load balancer, virtualized list, cursor replay, adaptive sampling, ML moderation, or production session layer in the running app.

## Start locally

Run commands from `fb-live-comments/` unless a block changes directory. Use Node.js 20 or newer. Only one project should occupy the default infrastructure and frontend ports.

### Option A: Docker Compose (recommended)

```bash
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U postgres -d live_comments
docker compose exec -T redis redis-cli ping
```

On a fresh PostgreSQL volume, Compose runs the schema automatically. It does **not** load sample data. After PostgreSQL is ready, apply the schema explicitly if using an existing volume, then seed:

```bash
docker compose exec -T postgres psql -U postgres -d live_comments -v ON_ERROR_STOP=1 < backend/src/db/init.sql
docker compose exec -T postgres psql -U postgres -d live_comments -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

The initialization file creates missing objects; it is not a migration system for changing existing columns.

```bash
docker compose down
# Destructive reset: also removes this project's PostgreSQL and Valkey volumes.
docker compose down -v
```

### Option B: Native installation (no Docker)

For a fresh Homebrew installation on macOS:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE postgres WITH LOGIN PASSWORD 'postgres';"
createdb -O postgres live_comments
PGPASSWORD=postgres psql -h localhost -U postgres -d live_comments -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=postgres psql -h localhost -U postgres -d live_comments -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
pg_isready -h localhost -U postgres -d live_comments
valkey-cli ping
```

If the role/database already exists, inspect it and skip the corresponding creation command; use matching credentials in `DATABASE_URL`. Do not start native and Docker services on the same ports.

### Start the backend

```bash
cd backend
npm install
cp .env.example .env
set -a
. ./.env
set +a
npm run dev
```

Export the environment **before** starting the process. Although `index.ts` calls dotenv, imported database/Redis clients, loggers, and rate-limit singletons are constructed earlier and may otherwise use their defaults. Inspect an existing `.env` before replacing it.

### Start the frontend in another terminal

```bash
cd fb-live-comments/frontend
npm install
npm run dev
```

Open [the demo](http://localhost:5173). This block assumes the new terminal starts at the repository root.

### Check the running server

```bash
curl -f http://localhost:3001/health/ready
curl -f http://localhost:3001/api/streams
curl -f http://localhost:3001/api/users
curl -f http://localhost:3001/api/status
curl -f http://localhost:3001/metrics
```

The seed creates five identities: Live Streamer, Happy Viewer, Excited Viewer, Mod Team, and Admin User; two live streams; and ten comments in Live Coding Session. No password is required or checked. Users are skipped on username conflict, so an existing username with a different UUID can prevent the fixed-ID stream seed from resolving its creator.

Seed comment IDs are much larger than IDs generated at today's dates. SQL history sorts by ID, so those fixtures can appear newer than newly posted comments on a cache miss. The cache is initially empty; its first new entry can also replace the ten SQL-seeded rows in subsequent join results because a short cache hit is not filled from SQL.

## Configuration

| Setting | Default/effect |
|---------|----------------|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/live_comments` |
| `REDIS_URL` | `redis://localhost:6379` |
| `PORT` | Entry point defaults to 3000; `npm run dev` explicitly sets 3001 |
| `COMMENT_BATCH_INTERVAL_MS` | 100; fixed timer, no maximum batch size |
| `REACTION_BATCH_INTERVAL_MS` | 500; fixed timer for interval deltas |
| `RATE_LIMIT_COMMENTS_PER_MINUTE` | 30 per user across streams, 60-second fixed window |
| `RATE_LIMIT_COMMENTS_PER_STREAM` | 5 per stream/user, 30-second fixed window |
| Reaction limit | Hardcoded 100 per stream/user per minute |
| `LOG_LEVEL` / `NODE_ENV` | `info`; pretty logging unless production |
| `SHUTDOWN_TIMEOUT_MS` | 30000; forced-exit deadline |
| `WS_PATH` | Present in the example but unused by the server |

Vite serves port 5173 and proxies `/api` and `/ws` to 3001. The browser hook actually connects directly to `ws://<page-hostname>:3001`, bypassing that proxy. The server accepts upgrades without restricting the path. HTTPS deployment and alternate backend hosts/ports require changes to that connection URL.

## Multiple server instances

From separate terminals in `backend/`, with the same exported PostgreSQL/Valkey configuration, run `npm run dev:server1`, `npm run dev:server2`, and `npm run dev:server3` on ports 3001, 3002, and 3003. Use socket clients against each port to examine cross-instance Pub/Sub; the browser remains hardcoded to 3001.

This demonstrates fan-out, not a complete distributed deployment. Viewer counts are local socket counts written over a shared Redis field, worker IDs use `process.pid % 1024`, and there is no stream ownership coordinator or load balancer. Several gateways can publish their own batches during the same 100 ms interval.

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/streams`, `/api/streams/live` | List all/live streams |
| GET | `/api/streams/:streamId` | Stream details |
| POST | `/api/streams` | Create from title/creator and optional description/video URL |
| POST | `/api/streams/:streamId/end` | Set stream status to ended |
| GET / POST | `/api/streams/:streamId/comments` | Recent history / persist a comment |
| GET | `/api/streams/:streamId/reactions` | Cumulative stored reaction counts |
| GET | `/api/streams/:streamId/metrics`, `/api/streams/:streamId/viewers` | Shared cached metrics / this process's room count |
| GET / POST | `/api/users` | List / create a user |
| GET | `/api/users/:userId` | User details |
| POST / DELETE | `/api/users/:userId/ban` | Add / remove bans |

These routes have no authentication middleware. HTTP comment creation persists/caches but does **not** broadcast to the room. Ending a stream does not notify viewers or prevent later comments. Bans are checked at socket join only and fail open if that query fails; HTTP posting does not check them.

## Implementation limitations to investigate

- **Posting:** SQL insertion, comment count, cache, and duplicate-suppression result are separate writes. A failure can be reported after a comment was saved. There is no explicit posting acknowledgment or client-provided idempotency key on either transport.
- **Recovery:** join subscribes before loading history, but live and history batches can interleave. The client appends both without deduplication, sorting, or a resume cursor; a short backfill cannot recover a long outage.
- **Rendering:** the list renders all retained rows. Auto-scroll runs on length changes, ignores reading intent, and stops reacting to new batches once the 200-entry cap keeps length constant. Floating-reaction cleanup restarts for every update, so sustained activity can retain invisible elements indefinitely.
- **Account/stream changes:** reconnect cleanup can schedule old callbacks. Incoming messages are not checked against the current stream; reactions and viewer state are not fully reset on selection changes.
- **Moderation/access:** user IDs are claimed by callers. The reaction handler does not enforce the joined user/stream match. SQL helpers for hide/pin/highlight exist but are not routed, and they do not invalidate cached comments or broadcast changes.
- **Delivery:** Pub/Sub has no replay. Batches clear their buffers before unawaited publication; slow sockets have no queue budget. Concurrent first joins can create duplicate timers, and the final viewer leaving does not reset the shared viewer count to zero.

## Verification and development commands

```bash
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix backend run lint
npm --prefix frontend run lint
```

There are no backend unit-test, `type-check`, or migration scripts. The project-level `npm run test:e2e` uses Playwright; the repository also provides `npm run test:smoke fb-live-comments`. Install the relevant root/project test dependencies and Playwright browsers first, and start the backend/infrastructure. The existing test only checks a broad `.flex` locator and absence of generic error text; the locator can match multiple elements and does not validate posting, replay, reactions, or load behavior.

This documentation review checked source/configuration and ran isolated checks with mocked dependencies. It did not run the complete application, build, or benchmark. The limits above are documented behavior, not fixes made to the app.

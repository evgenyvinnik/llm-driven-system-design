# Excalidraw — collaborative whiteboard

A local learning project for drawing shapes on an infinite canvas and exchanging edits over WebSocket. It includes rectangle, ellipse, diamond, line, arrow, freehand, and text tools; pan/zoom; a properties panel; drawing lists; session login; and PostgreSQL persistence. The main lessons are coordinate transforms, concurrent editing, ephemeral presence, and the difference between an edit being visible and durably saved.

**Current implementation boundary:** the WebSocket upgrade uses the same session as the HTTP API. Joining requires view access (anonymous visitors may watch public drawings read-only), edits require edit access, and sharing or visibility changes apply to open sockets immediately. HTTP saves and socket edits merge with one last-writer-wins rule, and room saves are bounded, retried, and flushed on shutdown. There is still no operation log, acknowledgment, or replay, and rooms are process-local, so convergence under conflicting edits and recovery after a crash are not guaranteed. Treat this as an implementation to study, with the specific limitations below.

The [architecture document](./architecture.md) separates a proposed production design from source-linked local behavior. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers describe bounded designs that can be discussed at a whiteboard; their proposed correctness mechanisms are not all present in the app.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,805 |
| Source Files | 68 |
| .ts | 4,197 |
| .md | 1,564 |
| .tsx | 1,563 |
| .json | 155 |
| .sql | 148 |


## What the demo includes

| Area | Current behavior |
|------|------------------|
| Drawing dashboard | Owned/shared drawings, a public tab, create/delete actions; cards show element counts rather than image thumbnails |
| Canvas | Single-element selection and dragging, seven shape types, keyboard tools, zoom, and pan |
| Styling | Stroke/fill, width, opacity, and text size; changes are local until an explicit save and are not broadcast by the properties panel |
| Collaboration | Process-local WebSocket rooms, completed shape/move messages, and cursor broadcasts |
| Persistence | Whole-scene SQL replacement after two seconds without socket scene edits or on last room departure; explicit Save also uses HTTP |
| Sharing | Existing seeded collaborators and removal; adding a collaborator is currently broken by invalid SQL |
| Export/history | PNG/SVG endpoints return 501; snapshots have no browsing/restore UI or API |

Selection handles are drawn but do not resize shapes. There is no eraser tool, undo/redo, group selection, copy/paste, inline text editing, or live drawing preview. Shapes/freehand strokes appear when the mouse is released; text uses a prompt. Input handlers are mouse-based, without a pointer/touch gesture implementation.

## Stack and ports

Use Node.js 20+ and npm. Frontend dependencies specify React 19, Vite 6, TypeScript, TanStack Router, Zustand 5, and Tailwind CSS 3. The backend uses Express 4, `ws`, PostgreSQL, ioredis, connect-redis, bcryptjs, Pino, and Prometheus metrics. Opossum is installed and a helper exists, but database queries do not use it.

| Service | Local address | Defaults |
|---------|---------------|----------|
| Frontend | http://localhost:5173 | Proxies `/api` and `/ws` to backend 3001 |
| API + WebSocket | http://localhost:3001 | `npm run dev` pins this port |
| PostgreSQL 16 | localhost:5432 | User/database `excalidraw`, password `excalidraw123` |
| Valkey 7 | localhost:6379 | No development password; Compose enables append-only persistence |

The configuration fallback is port 3000, but the development script overrides it to 3001. `dev:server2` and `dev:server3` start instances on 3002 and 3003. Separate processes have isolated rooms, per-process save locks and per-process permission invalidation, so they compete on full-scene saves; there is no cross-process collaboration protocol.

## Infrastructure

Choose one option, then use the common application setup. Run only one project using these default database/cache ports at a time.

### Option A: Docker Compose (recommended)

From `excalidraw`:

```bash
docker compose up -d
docker compose ps
docker compose exec postgres pg_isready -U excalidraw -d excalidraw
docker compose exec redis redis-cli ping
```

Compose starts PostgreSQL and Valkey with volumes; it does not start the application processes. PostgreSQL runs the mounted initialization schema only when its data directory is first created.

```bash
# Stop infrastructure, preserve the database and cache volumes.
docker compose down
# Delete this project's database/cache volumes for a fresh demo.
docker compose down -v
```

Legacy `docker-compose` is equivalent if installed. The repository screenshot runner uses that executable spelling.

### Option B: Native installation (macOS, no Docker)

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"

# Create the development role and database once.
psql postgres -c "CREATE ROLE excalidraw LOGIN PASSWORD 'excalidraw123';"
createdb -O excalidraw excalidraw

PGPASSWORD=excalidraw123 psql -h localhost -U excalidraw -d excalidraw -c 'SELECT 1;'
valkey-cli ping
```

The schema creates the `uuid-ossp` extension in this database. The development role owns the database; it does not need to be a PostgreSQL superuser. To stop native services while preserving data, use `brew services stop postgresql@16` and `brew services stop valkey`.

## Application setup

From `excalidraw/backend`:

```bash
npm install
npm run db:migrate
npm run dev
```

In a second terminal, from `excalidraw/frontend`:

```bash
npm install
npm run dev
```

Open [the dashboard](http://localhost:5173). Register an account or load the optional fixture below. Migration uses `CREATE TABLE IF NOT EXISTS` and does not destroy existing tables; it also does not evolve an existing table definition. There is no `db:seed` npm script.

### Optional seed data

Run once against a fresh migrated database, from `excalidraw/backend`. This requires a local `psql` client even when the database is in Docker:

```bash
PGPASSWORD=excalidraw123 psql -v ON_ERROR_STOP=1 \
  -h localhost -U excalidraw -d excalidraw -f db-seed/seed.sql
```

Alternatively, from `excalidraw`, use the client inside the PostgreSQL container:

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U excalidraw -d excalidraw < backend/db-seed/seed.sql
```

Choose one seed command. The seed has fixed IDs, no conflict handling, and no enclosing transaction. Rerunning it produces duplicate-key errors; an interrupted run can leave a partial fixture.

| Username or email entered in the login field | Password | Display name |
|-----------------------------------------------------------|----------|--------------|
| `alice` or `alice@example.com` | `password123` | Alice Designer |
| `bob` or `bob@example.com` | `password123` | Bob Artist |

The API login field is named `username` and accepts either username or email. New registrations use bcrypt cost 12; the supplied seed hashes use cost 10 despite their comment.

| Drawing | Owner | Visibility | Seeded elements |
|---------|-------|------------|-----------------|
| System Architecture | Alice | Public; Bob has edit permission | 13 |
| Wireframe Sketch | Alice | Private | 7 |
| Network Diagram | Bob | Public; Alice has edit permission | 11 |
| Brainstorm Notes | Bob | Private | 5 |

For a collaboration demonstration, open the same seeded drawing in two separate browser profiles, one logged in as Alice and one as Bob. Two tabs with the same account ignore each other's shape messages because the frontend filters by user ID. The seeded collaborator entries bypass the broken collaborator-creation helper.

### Environment variables

`dotenv` reads a `.env` file from the backend working directory if you create one. No environment example is supplied; the defaults below allow the development setup without a file.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` in config | `npm run dev` overrides it to `3001` |
| `NODE_ENV` | `development` | Development script pins this; start script sets production |
| `POSTGRES_HOST` | `localhost` | Individual PG fields are used, not `DATABASE_URL` |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `excalidraw` | Database |
| `POSTGRES_USER` | `excalidraw` | Database role |
| `POSTGRES_PASSWORD` | `excalidraw123` | Development password |
| `REDIS_HOST` | `localhost` | Actual ioredis connection host |
| `REDIS_PORT` | `6379` | Actual ioredis connection port |
| `REDIS_URL` | `redis://localhost:6379` | Configured but unused by the Redis client |
| `SESSION_SECRET` | `excalidraw-dev-session-secret` | Signs session cookies; does not encrypt session contents |

HTTP sessions use a seven-day HttpOnly, SameSite Lax cookie, Secure in production. `npm start` runs source with `tsx` in production mode; it needs a deployment consistent with Secure cookies, CORS, and the chosen port. It does not run the compiled build. CORS permits only `localhost:5173` and `127.0.0.1:5173` in source; it is not environment-configurable. WebSocket upgrades do not inherit those CORS or session checks.

## Controls

| Key / gesture | Actual action |
|---------------|---------------|
| V / R / O / D | Select / rectangle / ellipse / diamond |
| A / L / P / T | Arrow / line / freehand / text |
| Delete or Backspace | Tombstone the selected element and send deletion |
| Escape | Deselect and switch to selection |
| Ctrl/Cmd+S | Explicit HTTP Save |
| Space + drag or middle mouse drag | Pan |
| Mouse wheel | Zoom around pointer, limited to 10%–500% |

The properties panel applies its controls to the selected element and defaults for future elements. Title edits also need explicit Save. The renderer currently replaces its 2× pixel-density transform with the viewport transform, so displayed shape positions/sizes can disagree with hit testing and the cursor overlay. These are current rendering limits, not a verified HiDPI implementation.

## Verification and troubleshooting

| Directory | Command | Scope |
|-----------|---------|-------|
| `backend` | `npm test` | Existing mocked API tests |
| `backend` | `npm run build` / `npm run type-check` | Backend TypeScript |
| `frontend` | `npm run build` | TypeScript project check and Vite bundle |
| Either application directory | `npm run lint` | Existing ESLint configuration |
| `excalidraw` | `npm install` then `npm run test:e2e` | Login and drawing-list smoke tests |
| Repository root | `npm run test:smoke excalidraw` | Smoke runner with a running backend/infrastructure |
| Repository root | `node scripts/screenshots.mjs --start excalidraw` | Start/seed/capture workflow; includes two canvas screenshots |

Project Playwright configuration can start Vite, but does not start PostgreSQL, Redis, or the backend. The smoke tests do not draw, add collaborators, reconnect, or prove persistence. Backend tests mock sessions, database, rate limiting, and other services; they do not validate the live WebSocket authorization or save protocol.

`/api/health` and `/api/health/live` report liveness. `/api/health/ready` and `/api/health/detailed` query PostgreSQL and ping Redis. These routes run after session middleware and the general API limiter, so they can be affected by those dependencies too. `/metrics` exposes Prometheus text; no Prometheus/Grafana stack is bundled.

`npm test` in `backend/` runs the mocked route suite plus `src/websocket/rooms.test.ts` (save debounce and max-wait, retry, the leave/rejoin window, HTTP merges, access refresh, merge rules). The collaboration and permission paths were also exercised against a running stack with real sockets; see the architecture's Implementation Notes.

## Important implementation limits

- **Permissions:** socket identity comes from the session cookie; origins are not checked. Permission changes are invalidated in-process only, so a second instance would not hear about a revocation. HTTP edit collaborators can change `isPublic`.
- **Merge:** add, update and bulk sync use one last-writer-wins rule (higher version, then later timestamp); exact ties keep the existing element. Move takes the higher version, delete increments it, and a repeated delete increments again. Broadcasts do not return canonical accepted state to the sender.
- **Saving and recovery:** room saves fire after two quiet seconds and at most ten seconds after the first unsaved edit, so a crash (not a graceful stop) can lose up to ten seconds of edits. Failed saves retry every five seconds. Reconnect replaces local elements and does not replay sends dropped while disconnected.
- **Competing writers:** within one process, room saves, HTTP saves and room loads for a drawing are serialized and HTTP saves merge rather than replace. There is no revision check, operation receipt, durable replay cursor, or cross-server writer coordination.
- **Presence and scope:** cursors are sent on every mouse move. Redis expiration is for the entire room hash, and its read helper is unused; there is no per-cursor expiry in the browser, heartbeat, or late-join cursor snapshot. Full drawing data is cached for five minutes. Undo, offline recovery, exports, safe tombstone cleanup, and room-aware horizontal scaling are absent.

See [Implementation Notes](./architecture.md#implementation-notes) for details and the proposed mechanisms that would address these limits.

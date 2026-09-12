# Excalidraw — collaborative whiteboard

A local learning project for drawing shapes on an infinite canvas and exchanging edits over WebSocket. It includes rectangle, ellipse, diamond, line, arrow, freehand, and text tools; pan/zoom; a properties panel; drawing lists; session login; and PostgreSQL persistence. The main lessons are coordinate transforms, concurrent editing, ephemeral presence, and the difference between an edit being visible and durably saved.

**Current implementation boundary:** the HTTP API has drawing access checks, but the WebSocket handler does not authenticate users or check drawing permissions. Anyone who knows a drawing ID can join its socket room and submit edits, including for private drawings. The current merge and save paths also do not guarantee convergence or recovery of unsaved work. Treat this as an implementation to study, with the specific limitations below.

The [architecture document](./architecture.md) separates a proposed production design from source-linked local behavior. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers describe bounded designs that can be discussed at a whiteboard; their proposed correctness mechanisms are not all present in the app.

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

The configuration fallback is port 3000, but the development script overrides it to 3001. The `dev:server2` and `dev:server3` scripts call `dev`, which overrides their requested ports back to 3001. They cannot be used to start three instances as written. Even with distinct ports, separate processes would have isolated rooms and competing full-scene saves; there is no cross-process collaboration protocol.

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

This documentation review inspected source and exercised isolated handlers, merge functions, stores, and the renderer with mocked services. It did not run a full application stack, build, or browser test suite.

## Important implementation limits

- **Permissions:** sockets accept supplied identities and drawing IDs without session, ownership, view/edit, or origin checks. Collaborator-list HTTP reads require login but do not check drawing access. HTTP edit collaborators can also change `isPublic`. Removing a collaborator or logging out does not revoke an existing socket's ability to edit.
- **Sharing:** the collaborator helper executes an invalid `INSERT … RETURNING … FROM` statement before its valid alternative. It catches the SQL error and returns null; the route responds 201 and the dialog appends the null value, which can break rendering.
- **Merge:** equal version/timestamp conflicts retain whichever element arrived first. Add, update, move, and delete use different rules; stale adds can resurrect tombstones, repeated deletes increment again, and clients apply remote operations with new local versions. Broadcasts do not return canonical accepted state to the sender.
- **Saving and recovery:** a two-second debounce means two seconds of inactivity, not a maximum data-loss window. Failed saves are logged without a retry queue. Last-room flush is asynchronous and drops memory immediately; shutdown does not flush rooms. Reconnect replaces local elements and does not replay dropped sends.
- **Competing writers:** explicit Save replaces SQL elements with visible elements only, removing tombstones. It does not update active room memory, which can later overwrite it. Initial HTTP loads, room loads, and incoming edits can race. There is no revision check, operation receipt, durable replay cursor, or cross-server writer coordination.
- **Presence and scope:** cursors are sent on every mouse move. Redis expiration is for the entire room hash, and its read helper is unused; there is no per-cursor expiry in the browser, heartbeat, or late-join cursor snapshot. Full drawing data is cached for five minutes. Undo, offline recovery, exports, safe tombstone cleanup, and room-aware horizontal scaling are absent.

See [Implementation Notes](./architecture.md#implementation-notes) for details and the proposed mechanisms that would address these limits.

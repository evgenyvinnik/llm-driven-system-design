# Figma — collaborative design editor learning project

A browser design editor for studying interactive canvas rendering, optimistic edits, WebSocket collaboration, and document snapshots. The local application combines a file browser, a PixiJS canvas, and React layers/properties panels. It is a teaching implementation with significant persistence and synchronization gaps, rather than a complete Figma clone.

**Current demo limitations:** the browser generates a random user ID, but the operations table requires an existing user. With the supplied schema and seed, normal browser edits therefore fail database insertion while still appearing locally. Seeded objects also omit `visible`, which makes them appear in SVG file thumbnails but disappear from the editor canvas. These conclusions follow from the checked-in source; successful collaboration or persistence is not implied by a rendered page.

## What you can explore

| Flow | What exists | Practical boundary |
|---|---|---|
| Browse, create, delete files | REST-backed grid, name input, soft delete | Seed the fixed demo owner first; deleted files remain accessible by ID |
| Draw and inspect | Rectangle, ellipse, text, selection, drag, pan/zoom | Local optimistic changes; persistence has the identity defect above |
| Layers and properties | Visibility, lock, order, numeric/style/text controls | Flat object array; locks are UI hints and numeric limits are not enforced |
| Presence | Cursor positions and collaborator badges | Same-process broadcasts; expiration is not propagated to existing clients |
| History | Save/restore database canvas snapshots | Does not save unsent browser state or broadcast restores |
| Undo/redo | Browser snapshot history and buttons | Incorrect history indexing, local-only changes, history survives file switches |

Share is a placeholder button. Frame/group/image types exist in the model or renderer, but there are no corresponding creation tools, nested scene management, asset upload, prototype playback, comments UI, exports, authentication flow, or admin interface. Resize handles are visual; dimensions are edited in the properties panel. File navigation uses React state, so browser refresh returns to the file browser.

## Stack and reading guide

- React 19, TypeScript, Vite 6, Zustand 5, Tailwind CSS 3, and PixiJS 8.
- Node.js, Express 4, `ws`, PostgreSQL 16, and Redis-compatible Valkey 7.
- Pino logging, Prometheus metrics, one Opossum broadcast circuit, and scheduled retention cleanup.

Read [architecture.md](./architecture.md) for the production proposal and the source-backed local implementation. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) answers are proposed interview designs, each paced for 45 minutes. [CLAUDE.md](./CLAUDE.md) contains historical development notes; feature claims there are not a substitute for the current source.

## Prerequisites

Use Node.js 22 or 24, npm, and either Docker Compose or native PostgreSQL/Valkey. The repository minimum is Node 20; the installed Opossum 9 engine range supports Node 20, 22, and 24. Commands below start in this project's directory, `figma/`, unless a different directory is shown. Leave ports 3000, 5173, 5432, and 6379 available.

## Option A: Docker Compose (recommended)

```bash
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U figma -d figma_db
docker compose exec -T redis redis-cli ping
```

Compose starts infrastructure only. It mounts [init.sql](./backend/src/db/init.sql) into PostgreSQL's initialization directory, which runs only for a fresh database volume. The schema uses unguarded `CREATE TABLE` statements; it is not a rerunnable migration. There is no `db:migrate` script.

**Seed once after a fresh initialization:**

```bash
docker compose exec -T postgres psql -U figma -d figma_db -v ON_ERROR_STOP=1 --single-transaction < backend/db-seed/seed.sql
```

The [seed](./backend/db-seed/seed.sql) creates the fixed demo user, one team/project, and three files: Mobile App — Login Screen, Dashboard Wireframe, and Brand Color Palette. There is no login screen or usable login credential to enter. The user row is required for REST file/version creation. The seed has no conflict guards, so repeating it fails; do not use it as an update script for an existing database.

```bash
# Stop containers and retain data.
docker compose down
# Optional complete reset: deletes this project's PostgreSQL and Valkey volumes.
docker compose down -v
```

After a deliberate reset, start Compose and run the seed again.

## Option B: Native installation (macOS, no Docker)

Do not run these services alongside Compose on the same ports.

```bash
brew install postgresql@16 valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
brew services start postgresql@16
brew services start valkey
pg_isready -h localhost -p 5432
valkey-cli ping
```

For a fresh local installation, create a regular database owner using your local PostgreSQL administrator connection. Enter `figma_password` at the password prompt:

```bash
createuser --pwprompt figma
createdb --owner=figma figma_db
PGPASSWORD=figma_password psql -h localhost -U figma -d figma_db -v ON_ERROR_STOP=1 --single-transaction -f backend/src/db/init.sql -f backend/db-seed/seed.sql
PGPASSWORD=figma_password psql -h localhost -U figma -d figma_db -c 'SELECT count(*) FROM files;'
```

The final count is three on the untouched seed. These initialization commands assume the role/database do not already exist. Use the existing configured role for an existing installation instead of recreating its schema.

## Start the application

In one terminal, from `figma/`:

```bash
cd backend
npm install
NODE_ENV=production ENABLE_CLEANUP=false npm run dev
```

`NODE_ENV=production` selects JSON logging while `tsx watch` still reloads the server. Setting `NODE_ENV=development` selects `pino-pretty`, which is referenced but missing from this backend's declared dependencies. `ENABLE_CLEANUP=false` disables scheduled deletion while exploring the demo; its default is enabled.

In another terminal, from `figma/`:

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

Open [the file browser](http://localhost:5173). Vite proxies `/api` and `/ws` to port 3000. Inspect [backend health](http://localhost:3000/health) and [metrics](http://localhost:3000/metrics) directly; those paths are not Vite proxies. Dependency health does not test editing, authorization, or convergence.

## Configuration

The backend reads exported environment variables directly. It has no dotenv loader or `.env.example`; creating a `.env` file alone changes nothing. Neither `DATABASE_URL` nor `REDIS_URL` is consumed.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP and WebSocket listener |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed HTTP CORS origin |
| `DB_HOST`, `DB_PORT` | `localhost`, `5432` | PostgreSQL address |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `figma`, `figma_password`, `figma_db` | PostgreSQL credentials/database |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` | Valkey/Redis address |
| `LOG_LEVEL` | `info` | Pino level |
| `NODE_ENV` | unset | Only exact `development` enables the missing pretty transport |
| `ENABLE_CLEANUP` | enabled unless exactly `false` | Schedule retention tasks |

For example, `DB_PORT=5433 REDIS_PORT=6380 NODE_ENV=production npm run dev` overrides backend connections. It does not change infrastructure ports. Frontend API/socket addresses are same-origin; there are no configured `VITE_API_URL` overrides.

## API and controls

All current routes are unauthenticated. REST creation uses the fixed demo user; sockets trust the identity in `subscribe`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/files` | All non-deleted files, including complete canvas data |
| POST | `/api/files` | Create with `name`; optional `projectId`, `teamId` |
| GET | `/api/files/:id` | File and same-process subscriber count, including soft-deleted files |
| PATCH | `/api/files/:id` | Rename; missing ID can return `null` |
| DELETE | `/api/files/:id` | Soft delete; missing ID still returns 204 |
| GET | `/api/files/:id/versions` | Full snapshots, default limit 50 |
| POST | `/api/files/:id/versions` | Snapshot current database state, optional `name` |
| POST | `/api/files/:id/versions/:versionId/restore` | Replace database canvas and add a restore version |

`/ws` accepts `subscribe`, `unsubscribe`, `operation`, `presence`, and `sync`. The browser sends single-operation arrays, ignores ACKs, and retries socket connections after a fixed three seconds. It has no operation queue or revision replay and drops outgoing edits while disconnected. See the architecture's [local implementation](./architecture.md#implementation-notes) before interpreting socket traffic as reliable collaboration.

| Control | Action |
|---|---|
| V / R / O / T / H | Select / rectangle / ellipse / text / hand tool |
| Shift-click | Add/remove selection |
| Hand drag or plain wheel | Pan |
| Ctrl/Cmd + wheel | Cursor-centered zoom, 10–500% |
| Delete / Backspace | Delete selected unlocked objects through canvas shortcut |
| Ctrl/Cmd + D | Duplicate selection |
| Ctrl/Cmd + Z / Shift+Z | Local undo / redo, subject to the history defect |

Canvas shortcuts do not exclude focused text inputs. Layer-panel deletion and properties can also modify locked objects. Use small disposable designs when inspecting these interactions.

## Verification and troubleshooting

From each of `figma/backend/` and `figma/frontend/`, the available checks are `npm run type-check`, `npm run build`, and `npm run lint`. These are suggested development checks, not a claim that they passed during this documentation review. Application dependencies were not upgraded and the stack was not started.

The project-level Playwright script is `npm run test:e2e` after `npm install` in `figma/` and browser installation with `npx playwright install chromium`. It starts/reuses the frontend but requires the backend/database to be ready. The single smoke test checks that a file grid is visible; it does not test saving, reconnects, or two-client convergence.

| Symptom | Source-backed explanation |
|---|---|
| File creation fails on fresh Compose | Seed is separate; the fixed owner row is absent until seeded |
| Thumbnail visible, editor blank | All 23 seed shapes omit `visible`; the editor tests its truthiness |
| Shape appears then disappears on reload | Browser author ID fails the operations foreign key; socket errors are console-only |
| Two clients disagree after concurrent edits | Whole-canvas writes race; own operations are never canonically reconciled |
| Undo or another file shows unexpected content | Incorrect local history indexing; store/history is not reset between files |
| Restore affects only one browser | HTTP restore changes storage and caller state, with no WebSocket restore event |
| Startup fails only with development logging | `pino-pretty` is not a declared dependency |

`dev:server1`, `dev:server2`, and `dev:server3` bind ports 3001–3003. They share storage, but there is no supplied load balancer or cross-process operation delivery; the Vite proxy still targets 3000. Starting more instances does not establish distributed collaboration.

Cleanup defaults to 03:00 in the server's timezone: autosaves older than 90 days are pruned while keeping ten per file; operation rows and soft-deleted files expire after 30 days. No autosave producer is wired, and named versions remain unless their file is purged. `npm run cleanup` invokes the same destructive retention logic and catches errors internally, so its exit status alone does not prove success.

The `db:backup` script assumes a `backups/` directory and authentication setup; `db:restore` is an incomplete redirection command. Use explicit `pg_dump`/`psql` commands with a chosen path for backup work. Source size can be calculated from the repository root with `npm run sloc figma`; no stale generated size table is maintained here.

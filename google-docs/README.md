# Google Docs: rich-text editor and collaboration study

A Google Docs-style learning project with a React/TipTap editor, document management,
sharing, threaded comments, snapshot endpoints, and an experimental WebSocket/OT backend.
It is useful for studying where a collaborative editor needs stronger integration and
consistency guarantees.

**The current browser does not save or synchronize typed document content.** Its editor
update callback is a placeholder, and its document page does not apply incoming edit
messages. Formatting and typing affect the local editor only. Presence indicators and
several REST workflows are wired, but this is not a complete collaborative editor.

## What you can explore

| Area | Current implementation |
|------|------------------------|
| Accounts | Register/login/logout; PostgreSQL session records cached in Valkey |
| Documents | List owned/shared documents, create, open, rename, and soft-delete |
| Editor | Render stored ProseMirror JSON; local typing, formatting, and undo/redo |
| Sharing | Owner grants view/comment/edit access to an existing account; email-only grants are stored but not claimed on signup |
| Comments | Document-level comments/replies and author/owner resolve/delete actions; no inline anchor creation or tracking in the UI |
| Presence | WebSocket join/leave and selection messages; colored names/avatars, without remote caret overlays |
| History | List/name stored snapshots and request restore; see the version and consistency limits below |
| Suggestions | REST records with accept/reject status; acceptance does not change document text, and no suggestion UI is wired |

The application has no admin screen or admin API. The seeded admin account has a role
field, but that does not give it access to every document.

## Stack and local topology

React 18, TypeScript, Vite, React Router v6, Zustand, Tailwind, and TipTap 2 form the
frontend. Express and `ws` share one Node.js server. PostgreSQL 16 stores application
data; the Compose service named `redis` runs Valkey 7 for sessions, optional response
receipts, and pub/sub. Use Node.js **20 or newer** for this repository.

Vite serves port **5173** and proxies `/api` and `/ws` to **3001**. The backend dev
script explicitly selects 3001; the entry point and `npm start` otherwise default to
3000. Infrastructure exposes PostgreSQL on **5432** and Valkey on **6379**.

## Option A: Docker Compose (recommended)

From the repository root:

```bash
cd google-docs
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U googledocs -d googledocs
docker compose exec -T redis redis-cli ping
```

Compose mounts [the schema](./backend/src/db/init.sql) into PostgreSQL's initialization
directory. It runs only when the database volume is first created. **Seed data is a
separate step**, not part of that schema:

```bash
docker compose exec -T postgres psql -U googledocs -d googledocs -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

The seed is intended for a fresh schema. Its fixed user IDs assume those email
addresses have not already been registered with different IDs.

To stop infrastructure, run `docker compose down`. To discard the local database and
Valkey volumes as well, use `docker compose down -v`; the next startup initializes a
new empty schema and needs the seed step again.

## Option B: native services (no Docker)

On macOS with Homebrew, start these services instead of the Compose stack. From the
`google-docs` directory, create the role and database once on a fresh installation:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE googledocs LOGIN PASSWORD 'googledocs_secret';"
createdb --owner=googledocs googledocs
PGPASSWORD=googledocs_secret psql -h localhost -U googledocs -d googledocs -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=googledocs_secret psql -h localhost -U googledocs -d googledocs -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
pg_isready -h localhost -U googledocs -d googledocs
valkey-cli ping
```

The schema is not a repeatable migration: its table/index creation statements assume
an empty database. There is no `db:migrate` npm script in this project.

## Start the application

In one terminal, from the repository root:

```bash
cd google-docs/backend
npm install
npm run dev
```

In a second terminal, also from the repository root:

```bash
cd google-docs/frontend
npm install
npm run dev
```

Open [the app](http://localhost:5173). After seeding, `alice@example.com`,
`bob@example.com`, `carol@example.com`, `david@example.com`, and `admin@docs.local`
all use **`password123`**. The seed includes five documents with different owners
and permissions; Alice can see her two documents plus the technical-design and
sprint-planning documents shared with her.

[Backend health](http://localhost:3001/health) checks PostgreSQL and Valkey;
[metrics](http://localhost:3001/metrics) exposes the prom-client registry. A healthy
response confirms dependency connectivity, not end-to-end edit synchronization.

## Configuration and commands

Defaults come from the source; no dotenv loader reads a `backend/.env` file. Export
custom values in the shell before launching the backend.

| Variable | Default | Use |
|----------|---------|-----|
| `DB_HOST`, `DB_PORT` | `localhost`, `5432` | PostgreSQL address |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `googledocs`, `googledocs_secret`, `googledocs` | PostgreSQL credentials/database |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` | Valkey/Redis address |
| `PORT` | `3000` in source; `3001` in dev script | HTTP and WebSocket server |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed REST browser origin |
| `NODE_ENV` | Unset/development behavior | Secure-cookie flag and logging format |
| `LOG_LEVEL`, `SERVICE_NAME` | `info`, `google-docs-backend` | Pino logging |

Both halves expose `build`, `type-check`, `lint`, and `format` scripts. Use
`npm run type-check` in each directory for TypeScript validation. The frontend lint
script currently fails before linting because it passes unsupported `--ext` options
alongside a flat ESLint config. Backend production
startup after building is `PORT=3001 npm start` to retain the Vite proxy target.

`dev:server1`, `dev:server2`, and `dev:server3` start backend ports 3001–3003. Vite
continues to use 3001. There is no load balancer, document owner election, or fencing;
starting more processes does not make the OT state consistent across them.

The project-level `test:e2e` script runs three Playwright page smoke tests. It can
start Vite, but infrastructure, seeded data, and the backend must already be running.
Those tests cover login/register/home rendering, not collaboration or durable editing.

## Important implementation limits

- The server's live document state holds a version and operation arrays, not updated
  rich-text content. Its debounce persists only the last operation in a burst and
  advances the database version without applying edits to `documents.content`.
- Operation ACKs precede persistence. The history buffer uses absolute versions as
  array offsets, loses its origin after restart/trimming, and has no durable replay
  or safe retry protocol. Redis pub/sub forwards messages without updating peer
  servers' in-memory version/log state.
- WebSocket subscription checks read access; edit messages do not recheck edit
  permission. Revocation, deletion, and session logout do not close an already
  authorized document connection. Several auxiliary REST routes also omit the
  soft-delete check.
- Restore copies a stored snapshot through separate SQL writes. It does not update
  live collaboration state, and the default PostgreSQL BIGINT string representation
  makes `current_version + 1` concatenate values (for example, `5` becomes `51`).
- The browser has no durable offline queue, replay of its pending operations, or
  account/document generation guard for late responses. Comments can clear input
  after a failed request. A green connection dot is not a saved-content indicator.

These are source-review findings, not fixes delivered by this documentation change.
See [architecture.md](./architecture.md#implementation-notes) for the evidence and
production-to-local mapping. The [frontend](./system-design-answer-frontend.md),
[backend](./system-design-answer-backend.md), and
[fullstack](./system-design-answer-fullstack.md) interview answers explain a proposed
complete design with whiteboard diagrams. [CLAUDE.md](./CLAUDE.md) records development
history; some older completion claims conflict with the current source.

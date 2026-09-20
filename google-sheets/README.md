# Google Sheets learning project

A local collaborative spreadsheet demo: edit cells in a virtualized React grid, see updates and other users' cursors, and persist cell values in PostgreSQL. It explores the boundary between a responsive browser and shared document state. It is not a complete spreadsheet engine or a production collaboration service.

Read [architecture.md](./architecture.md) for the proposed production design and the implementation audit. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers each start with a high-level diagram and a 45-minute discussion outline.

## What you can try

- Open a new workbook URL and edit the first sheet's cells.
- Select a cell, double-click or type to edit, and commit with Enter, Tab, or blur. Escape cancels the draft. Enter and Tab inside the editor currently commit without moving to another cell.
- Open the same URL in another browser window to observe cell updates and cursor presence through one backend process.
- Scroll a grid with 1,000 rows and 26 columns. Rows and columns are virtualized independently; data loading still retrieves the first sheet's entire stored cell set.
- Try literal formulas such as `=SUM(1,2,3)` or `=5+3*2`.
- Inspect workbook metadata, update cells, and export CSV through the REST API.

The UI has no workbook list, sheet-tab switching, editable workbook title, formatting controls, resize handles, undo/redo, clipboard workflow, or export button. Backend routes and some store actions cover parts of these features, but they are not complete user flows.

**Use this only as a trusted local demo.** There is no authentication or workbook authorization. Formula fallback executes unrestricted JavaScript on the server; do not expose the service to untrusted users or submit untrusted formulas. Cell references, ranges, dependent recalculation, and cycle detection are not implemented. A seeded formula's stored result does not demonstrate working reference evaluation.

## Stack

| Layer | Actual implementation |
|-------|-----------------------|
| Browser | React 19, TypeScript, Zustand, TanStack Virtual, plain CSS |
| Development server | Vite, port 5173 |
| API and collaboration | Express, `ws`, one Node.js process; development port 3001 |
| Durable storage | PostgreSQL 16 |
| Cache and publication | Valkey, through the ioredis client |
| Diagnostics | Pino, prom-client, health/readiness routes, an Opossum breaker around Redis publication |

There is no TanStack Router, Tailwind, dedicated calculation worker, or external formula library in this project. Redis publication is present, but subscriber wiring is absent: multiple API processes will not relay edits to one another.

## Prerequisites

Use Node.js 20 or newer and npm. Run the following commands from this project's directory. Use either Docker Compose or native services, so only one PostgreSQL and one Valkey instance occupy ports 5432 and 6379.

### Option A: Docker Compose (recommended)

```bash
docker compose up -d
docker compose ps
docker compose exec postgres pg_isready -U sheets -d sheets
docker compose exec redis redis-cli ping
```

[Compose](./docker-compose.yml) starts PostgreSQL with user `sheets`, password `sheets123`, database `sheets`, and Valkey without a password. It does **not** mount the schema as an initialization script; run the migration below.

```bash
docker compose down
# Destructive reset: removes this project's database and cache volumes.
docker compose down -v
```

### Option B: Native installation on macOS

Install [PostgreSQL 16](https://formulae.brew.sh/formula/postgresql@16) and [Valkey](https://formulae.brew.sh/formula/valkey) with Homebrew:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"

# Once, for a fresh local PostgreSQL cluster:
psql postgres -c "CREATE ROLE sheets LOGIN PASSWORD 'sheets123';"
createdb --owner=sheets sheets

PGPASSWORD=sheets123 psql -h localhost -U sheets -d sheets -c 'SELECT 1;'
valkey-cli ping
```

Skip role/database creation if they already exist. If a local service uses different credentials or ports, export the corresponding settings before starting the backend and migration scripts.

## Initialize and run

In the backend terminal:

```bash
cd backend
npm install
export DATABASE_URL='postgresql://sheets:sheets123@localhost:5432/sheets'
npm run db:migrate
# Optional sample workbooks; every run creates additional sample records.
npm run db:seed
npm run dev
```

In another terminal, from the project directory:

```bash
cd frontend
npm install
npm run dev
```

Open [the local app](http://localhost:5173). The app prompts for a display name, saves it as `sheetsUserName` in localStorage, and adds a new UUID to the URL's `id` query parameter. Opening that exact URL elsewhere joins the same workbook. A private browser window provides separate localStorage for another name. These names are presentation data, not authenticated identities.

To open seeded data, call the listing endpoint and copy a returned workbook ID into `http://localhost:5173/?id=WORKBOOK_UUID`:

```bash
curl --fail http://localhost:3001/api/spreadsheets
curl --fail http://localhost:3001/health
curl --fail http://localhost:3001/ready
curl --fail http://localhost:3001/metrics
```

The seed creates **Q1 Budget 2024**, **Project Timeline**, and **Team Directory**, with five sheets and 44 cells overall. Only each workbook's first sheet is shown in the browser. The session IDs printed by the seed are not used by the browser or validated by WebSocket connections.

### Environment variables

Neither entry point loads a `.env` file. Export variables in the shell that starts the relevant process.

| Variable | Default / purpose |
|----------|-------------------|
| `DATABASE_URL` | Migration and seed only; their default is `postgresql://postgres:postgres@localhost:5432/sheets`, which does not match Compose |
| `PGHOST` / `PGPORT` | Runtime database host `localhost` / port `5432` |
| `PGDATABASE` | Runtime database `sheets` |
| `PGUSER` / `PGPASSWORD` | Runtime credentials `sheets` / `sheets123` |
| `REDIS_URL` | `redis://localhost:6379` |
| `PORT` | Entry point defaults to `3000`; `npm run dev` explicitly sets `3001` |
| `CORS_ORIGIN` | `http://localhost:5173` |
| `LOG_LEVEL` | `info` |
| `NODE_ENV` | Controls development log formatting |

Changing `DATABASE_URL` does not change the server's database connection. For a customized database, configure both the URL for scripts and the `PG*` variables for runtime.

The browser store hardcodes `ws://localhost:3001/ws`. Vite also defines `/api` and `/ws` proxies, but the WebSocket URL bypasses that proxy. Changing the backend port, serving over HTTPS, or opening the frontend from another computer requires changing this client URL; environment variables alone do not configure it.

## Commands and checks

| Directory | Command | Purpose |
|-----------|---------|---------|
| `backend` | `npm run dev` | Watch server on port 3001 |
| `backend` | `npm run build` | Compile TypeScript to `dist` |
| `backend` | `PORT=3001 npm start` | Run previously compiled server |
| `backend` | `npm run db:migrate` | Execute `src/db/init.sql` |
| `backend` | `npm run db:seed` | Insert additional sample records |
| `backend` | `npm test` | Run Vitest; no backend test files are currently present |
| `frontend` | `npm run build` | TypeScript check and Vite build |
| `frontend` | `npm run type-check` | TypeScript check only |
| Project root | `npm run test:e2e` | Existing Playwright page-visibility check; requires the app stack |

Both packages also define lint and formatting scripts. The existing end-to-end test does not verify persisted edits, formula correctness, or agreement between two clients.

For a meaningful manual check, edit a plain value in one window, observe it in another, then reload both and compare with the stored value. Disconnect one window while editing to expose the current missing retry/reconnect behavior. These scenarios were not run as part of the documentation review.

## Known implementation boundaries

- A socket opening is treated as connected before initial state arrives. There is no automatic reconnect, pending-operation journal, retry queue, or saved/error status. The client ignores edit acknowledgements and server errors.
- Concurrent saves can commit and broadcast in different orders. Redis receipt caching is optional, non-atomic, and unused by the browser; it does not make edits exactly once.
- Live updates are keyed by row and column in the browser, without checking the incoming sheet ID. REST changes do not notify live clients.
- Formula support accepts literal comma-separated numbers and a JavaScript fallback. `=SUM(A1:A10)` returns `0`; it does not read those cells. Formula results do not propagate to dependents.
- Drag selection stays local. Server selection/resize/rename handlers do not establish complete browser support for those features.
- Cached cell snapshots can become stale or partial. Formatting can disappear from the browser/cache after an edit even though the SQL row retains it.
- CSV export builds a dense rectangle in memory, does not validate that an explicitly requested sheet belongs to the workbook, and does not neutralize spreadsheet formula prefixes.

See [Implementation Notes](./architecture.md#implementation-notes) for source evidence and the production-to-local mapping.

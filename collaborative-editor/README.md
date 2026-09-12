# Collaborative Editor

A learning project for collaborative **plain-text** editing with React, WebSockets, and operational transformation (OT). The code explores optimistic edits, a versioned operation log, snapshots, presence, and RabbitMQ fanout between Node.js processes.

**Current status:** document browsing, creation, seeded content, and collaborator lists are implemented. Editing and convergence have known correctness defects: ordinary insertions can fail before transmission, concurrent transforms can fail or disagree, and multiple servers do not maintain a consistent document state. Use this project to study the protocol and its failure boundaries; successful page rendering does not establish reliable collaboration. See [implementation findings](./architecture.md#implementation-notes) for source evidence.

## What you can explore

- Select Alice, Bob, or Charlie from a demo identity picker; list all documents and create an empty document.
- Open a document in separate windows to inspect connection status, document version, collaborator colors, and numeric cursor positions.
- Follow retain/insert/delete operations through the browser store, synchronization server, and PostgreSQL operation log.
- Inspect RabbitMQ exchanges, queues, structured logs, health endpoints, and optional Prometheus metrics.

There is no authentication, enforced sharing permission, admin interface, rich-text formatting, rendered remote caret overlay, version-history UI, or offline recovery. The editable-looking title field has a no-op handler; the title update REST endpoint exists separately. “Saved” reflects an empty client operation queue and is not a verified durability guarantee.

## Stack

| Layer | Implementation |
|-------|----------------|
| Browser | React 19, TypeScript, Vite 6, Zustand 5, Tailwind CSS 3; native textarea |
| API and synchronization | Express 4 and ws on the same HTTP server |
| Durable data | PostgreSQL 16: users, documents, snapshots, operations, access records |
| Transient state | Valkey 7 through the Redis client: presence and optional deduplication caches |
| Messaging | RabbitMQ 3 in Compose; operation fanout and an unconsumed snapshot queue |
| Operations | Pino, prom-client, Opossum around operation publication; optional Prometheus/Grafana |

The frontend uses component state to switch views, with no client router. Browser and server OT implementations are separate files, not a shared package.

## Setup

Use Node.js 20 or newer and npm. Run the following infrastructure commands from the `collaborative-editor` directory. Choose one infrastructure option; both use the same backend defaults.

### Option A: Docker Compose (recommended)

```bash
docker compose up -d postgres redis rabbitmq
docker compose ps
```

Wait for the three health checks. PostgreSQL applies [init.sql](./backend/src/db/init.sql) only when its data volume is first initialized. Import the separate sample data after it is ready:

```bash
docker compose exec -T postgres psql -U collab -d collaborative_editor -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

For an existing project volume missing the tables, apply the schema explicitly before the seed:

```bash
docker compose exec -T postgres psql -U collab -d collaborative_editor -v ON_ERROR_STOP=1 < backend/src/db/init.sql
```

The schema uses `IF NOT EXISTS`; it creates missing objects but does not migrate incompatible existing tables. There is no `db:migrate` script.

```bash
docker compose down
# Destructive reset: removes this Compose project's database and other named volumes.
docker compose down -v
```

### Option B: Native installation (macOS, no Docker)

Install and start PostgreSQL, Valkey, and RabbitMQ:

```bash
brew install postgresql@16 valkey rabbitmq
brew services start postgresql@16
brew services start valkey
brew services start rabbitmq
export PATH="$(brew --prefix postgresql@16)/bin:$(brew --prefix rabbitmq)/sbin:$PATH"
pg_isready -h localhost -p 5432
valkey-cli ping
rabbitmq-diagnostics -q ping
```

On a fresh local PostgreSQL installation, create the role and database once. Enter `collab123` at the password prompt:

```bash
createuser --pwprompt collab
createdb -O collab collaborative_editor
PGPASSWORD=collab123 psql -h localhost -U collab -d collaborative_editor -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=collab123 psql -h localhost -U collab -d collaborative_editor -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
PGPASSWORD=collab123 psql -h localhost -U collab -d collaborative_editor -c 'SELECT COUNT(*) FROM documents'
```

A fresh RabbitMQ node provides the local `guest`/`guest` account on the default `/` virtual host. The application declares its own exchanges and queues. Enable the management interface if needed:

```bash
rabbitmq-plugins enable rabbitmq_management
rabbitmqctl list_users
```

Homebrew may install a newer RabbitMQ major version than Compose. Its service and CLI locations follow the [RabbitMQ Homebrew guide](https://www.rabbitmq.com/docs/install-homebrew). These are alternative local setups, not a claim of a tested version matrix.

### Start the application

In one terminal:

```bash
cd backend
npm install
npm run dev
```

In another terminal, from the project directory:

```bash
cd frontend
npm install
npm run dev
```

Open [the editor](http://localhost:5173). Vite proxies `/api` and `/ws` to port **3001**. Both checked-in Vite config variants use that target. The backend's `dev` script selects 3001; its code defaults to 3000 when run without an explicit port. For a compiled backend that matches the proxy, use `npm run build` followed by `PORT=3001 npm start` inside `backend`.

### Configuration and ports

Backend settings come from the process environment. There is no dotenv loader, so placing values in `.env` alone does not configure the running server; export them in its terminal.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | Code: `3000`; dev script: `3001` | HTTP and WebSocket listener |
| `SERVER_ID` | `server-<PORT>` | Metrics labels and per-server RabbitMQ queue |
| `DB_HOST`, `DB_PORT` | `localhost`, `5432` | PostgreSQL address |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `collab`, `collab123`, `collaborative_editor` | PostgreSQL credentials/database |
| `REDIS_URL` | `redis://localhost:6379` | Presence and deduplication |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | Broker connection |
| `CORS_ORIGIN` | `http://localhost:5173` | REST CORS origin |
| `LOG_LEVEL`, `APP_VERSION` | `info`, `1.0.0` | Structured logging |
| `NODE_ENV` | Unset | Logger transport selection |

`DATABASE_URL` is not read by the database client. The frontend uses relative API and WebSocket addresses rather than a `VITE_API_URL` variable. The optional interfaces are [RabbitMQ management](http://localhost:15672), [Prometheus](http://localhost:9090), and [Grafana](http://localhost:3000).

## Sample data and walkthrough

[seed.sql](./backend/db-seed/seed.sql) creates three users and five documents with version-zero snapshots: Welcome Document, Q3 Engineering Roadmap, Design Review — Sync Protocol, Incident Postmortem 2026-07-14, and Meeting Notes — Weekly Sync. These are **fictional sample documents**, including the incident narrative and its reliability claims.

The seed skips existing fixed IDs and snapshot versions, so rerunning it does not overwrite their content. It adds no operation history or access records. There are no passwords to enter; the user selector automatically picks the first returned user.

1. Open the document list and inspect a seeded document.
2. Open the same document in another window and choose another user to observe presence.
3. Inspect `/health`, `/ready`, and `/metrics` directly on port 3001.
4. When investigating editing, watch the browser console and server logs. Insertion/deletion can leave visible local text unsent, and concurrent edits can require a destructive resync. Reloading or returning to the list discards pending client work.

![Seeded document list](./screenshots/01-document-list.png)

The committed screenshots illustrate the interface; they do not verify the editing protocol.

## Multiple processes and monitoring

The following scripts run independent backend processes on ports 3001–3003 with distinct server IDs. Run each in its own backend terminal:

```bash
npm run dev:server1
npm run dev:server2
npm run dev:server3
```

The normal Vite proxy still sends every browser to server 1. There is no included load balancer. Direct WebSocket clients can target the other ports to investigate fanout, but the implementation lacks exclusive document ownership, remote state application, reliable catch-up, and correct per-recipient deduplication. Multiple processes are an experiment, not a supported convergence guarantee.

```bash
docker compose --profile monitoring up -d
```

The checked-in Prometheus configuration scrapes `host.docker.internal:3001`, `3002`, and `3003`; unopened processes appear down. Grafana uses port 3000 and initial `admin`/`admin` credentials. It has no provisioned project dashboards or data source. Keep the backend on 3001 when running this profile.

## API and protocol

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/documents` | List every document, newest update first |
| GET | `/api/documents/:id` | Read metadata; content arrives through WebSocket initialization |
| POST | `/api/documents` | Create metadata and an empty snapshot from supplied `ownerId` and optional title |
| PATCH | `/api/documents/:id` | Update title; no ownership check |
| GET | `/api/users` | List selectable identities |
| GET | `/api/users/:id` | Read a public demo identity |

Connect to `/ws?documentId=<id>&userId=<id>`. Client messages include `operation`, `cursor`, and `selection`; server messages include `init`, `ack`, `operation`, presence changes, `resync`, and `error`. The browser sends cursor messages but no separate selection message or operation ID. See [API Design](./architecture.md#api-design) for exact examples and missing guarantees.

## Verification and reading

Inside `backend`, available checks include `npm run build` and `npm run lint`. Inside `frontend`, use `npm run type-check`, `npm run build`, and `npm run lint`. From the repository root, `npm run test:smoke collaborative-editor` exercises the existing Playwright smoke test with the stack already running. That test checks a page heading and absence of error-boundary text; it does **not** type or test convergence.

The documentation review traced source and ran isolated OT/store checks without starting infrastructure. It did not run the full application, benchmark targets, or repair the identified implementation defects.

Read [architecture.md](./architecture.md) for the proposed production design and actual implementation mapping; use the [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) answers for interview practice. [CLAUDE.md](./CLAUDE.md) contains earlier development notes; the source audit in architecture.md records discrepancies with those notes.

## Codebase Stats

Recorded repository counts; regenerate them with the root SLOC tooling when needed.

| Metric | Value |
|--------|-------|
| Total SLOC | 7,586 |
| Source Files | 54 |
| .ts | 4,769 |
| .md | 1,727 |
| .tsx | 554 |
| .json | 157 |
| .sql | 150 |

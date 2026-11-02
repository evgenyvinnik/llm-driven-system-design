# Confluence: a wiki and knowledge-base learning project

This project explores spaces, hierarchical pages, rich-text editing, revision history, comments, review requests, and asynchronous search indexing. It pairs a React interface with an Express API, PostgreSQL, Valkey, Elasticsearch, and a RabbitMQ indexing worker. It is a teaching implementation, not a reproduction of Confluence's production system.

Read [architecture.md](./architecture.md) for the proposed production design and a source-based account of the local implementation. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers explain the design in a 45-minute discussion.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 8,614 |
| Source Files | 87 |
| .ts | 4,169 |
| .tsx | 1,995 |
| .md | 1,670 |
| .sql | 300 |
| .json | 167 |


## What is available

| Area | Current behavior |
|------|------------------|
| Accounts | Registration, login, logout, and Redis-backed sessions (regenerated on login); three seeded accounts |
| Access | Space roles enforced on every route: viewers read, members edit and see drafts, admins manage the space and review; private spaces are invisible (404) to non-members |
| Spaces | Dashboard, space overview, page tree (drafts only for members); space settings and membership through the API |
| Pages | View and edit in the browser; create, update with a stale-version check (409), delete, labels, moves with cycle refusal; unique slugs; HTML sanitized on save |
| History | Full revision snapshots, line-based HTML diffs, and restore-as-new-version APIs |
| Discussion | Top-level comments and direct replies; author-only comment editing/deletion in the API |
| Review | Requests bound to the reviewed version; a space admin other than the requester approves or rejects; approval publishes the page |
| Search | Elasticsearch over the spaces you can see, results linking by slug; an indexer with retries, a dead-letter queue, versioned writes, and periodic reconciliation; SQL substring fallback if Elasticsearch fails |

Material limitations:

- Permissions are space-level only: no page-level restrictions or groups. Publication flips a page's status, so after first approval, further edits to a published page are live without review.
- Saves carry no durable request identity: retrying an uncertain save can create another revision. The stale-version check applies when the client sends the version it edited (the bundled editor does).
- Search indexing is eventually consistent. Messages buffer in memory while RabbitMQ is down, and a reconciliation pass every 10 minutes repairs anything lost, such as a crash with messages buffered. There is no transactional outbox.
- Slugs change on rename, with no redirect from the old one.
- Templates have APIs and an unused picker component. The table-of-contents macro is a placeholder. There is no autosave, local draft recovery, live co-editing, drag-and-drop move, or admin screen.

Details and the reasoning behind each choice are in [Implementation Notes](./architecture.md#implementation-notes).

## Stack and ports

Use Node.js 20 or later and npm. Docker Compose supplies infrastructure; run the API, worker, and Vite server separately.

| Service | Local address | Development credentials |
|---------|---------------|-------------------------|
| Vite / React 19 | http://localhost:5173 | Wiki account below |
| Express API | http://localhost:3001 | Session cookie |
| PostgreSQL 16 | localhost:5432, database `confluence` | `confluence` / `confluence123` |
| Valkey 7 | localhost:6379 | No password |
| Elasticsearch 8.11.0 | http://localhost:9200 | Security disabled in Compose |
| RabbitMQ | localhost:5672; management http://localhost:15672 | `confluence` / `confluence123` |

The frontend uses TypeScript, TanStack Router, Zustand, and Tailwind CSS. The backend uses `pg`, `ioredis`, `amqplib`, Pino, and `prom-client`. There are no Prometheus or Grafana containers in this project's Compose file.

## Option A: Docker Compose (recommended)

From this project's directory:

```bash
docker compose up -d
docker compose ps
cd backend
npm install
npm run db:migrate
```

Wait for the infrastructure health checks before migrating. PostgreSQL also runs `src/db/init.sql` when creating a fresh data volume. The migration command reapplies that consolidated schema; it does not maintain a numbered migration history. It is written to permit this second application.

In a terminal at the project directory, seed a fresh database once:

```bash
docker compose exec -T postgres psql -U confluence -d confluence -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

The seed creates three accounts, all with password **`password123`**:

| Account | Roles | What it shows |
|---------|-------|---------------|
| `alice` | Global admin; admin of `ENG` and the private `SEC` space | Everything, including the pending review |
| `bob` | Member of `ENG`, admin of `PROD` | Drafts in Engineering; no access to `SEC` |
| `carol` | Viewer of `ENG` | Read-only Engineering, no drafts |

It also creates eleven pages (one a draft with a pending approval), historical snapshots, labels, comments, and three global templates. Seed content is fictional sample material.

The seed is not generally rerunnable: some inserts skip conflicts, while others fail or append duplicate records. Use it once on a fresh schema rather than as a migration or repair command.

Start each application process in its own terminal:

```bash
# From confluence/backend: API on 3001 plus the search indexer
npm run dev
```

```bash
# From confluence/frontend
npm install
npm run dev
```

Open [the wiki](http://localhost:5173) and sign in as `alice`, `bob`, or `carol` to compare what each role sees. The API's `/api/health` returns a process-level status, not a dependency readiness result.

### Search for the seeded pages

No manual step is needed. When the indexer starts, it waits for Elasticsearch and RabbitMQ and then reconciles the index with PostgreSQL, so seeded pages become searchable as soon as `npm run dev` has been running for a few seconds. It repeats that pass every 10 minutes. Messages that fail every retry are kept on the `page-index.dlq` queue (visible in the RabbitMQ management UI).

### Stop or reset infrastructure

```bash
docker compose down
```

This keeps named volumes. To intentionally delete this project's stored database, cache, search, and broker data for a fresh start:

```bash
docker compose down -v
```

## Option B: Native installation (macOS, no Docker)

Install PostgreSQL, Valkey, and RabbitMQ with Homebrew, then start them:

```bash
brew install postgresql@16 valkey rabbitmq
brew services start postgresql@16
brew services start valkey
brew services start rabbitmq
export PATH="$(brew --prefix postgresql@16)/bin:$(brew --prefix rabbitmq)/sbin:$PATH"
```

For a fresh local PostgreSQL installation, create the application role and database:

```bash
psql postgres -c "CREATE ROLE confluence LOGIN PASSWORD 'confluence123';"
createdb -O confluence confluence
PGPASSWORD=confluence123 psql -h localhost -U confluence -d confluence -c 'SELECT current_database();'
valkey-cli ping
```

Create the RabbitMQ account expected by the application. Native Homebrew uses its own defaults; it does not read Compose environment variables. See [RabbitMQ's Homebrew instructions](https://www.rabbitmq.com/docs/install-homebrew).

```bash
rabbitmqctl add_user confluence confluence123
rabbitmqctl set_permissions -p / confluence '.*' '.*' '.*'
rabbitmqctl set_user_tags confluence administrator
rabbitmq-plugins enable rabbitmq_management
rabbitmq-diagnostics -q ping
```

Download the appropriate macOS archive from the [Elasticsearch 8.11.0 release page](https://www.elastic.co/downloads/past-releases/elasticsearch-8-11-0): `aarch64` for Apple silicon or `x86_64` for Intel. Extract it and run the following from its directory in a separate terminal. These flags match the local Compose application's unauthenticated HTTP connection and bind the native server to loopback. The archive includes a JDK; see [Elastic's archive installation instructions](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/targz.html).

```bash
ES_JAVA_OPTS='-Xms256m -Xmx256m' ./bin/elasticsearch -Ediscovery.type=single-node -Enetwork.host=127.0.0.1 -Expack.security.enabled=false
```

Verify it from another terminal:

```bash
curl http://localhost:9200/_cluster/health
```

Then, from `confluence/backend`, run `npm install`, `npm run db:migrate`, and seed once:

```bash
PGPASSWORD=confluence123 psql -h localhost -U confluence -d confluence -v ON_ERROR_STOP=1 -f db-seed/seed.sql
```

Use the same API, worker, frontend, and one-time search population steps from Option A. Stop Homebrew services with `brew services stop <service>` and stop the foreground Elasticsearch process with Ctrl-C.

## Configuration

The backend loads `.env` from its working directory through `dotenv`. Create `confluence/backend/.env` only if overriding the defaults below. `DATABASE_URL` and `REDIS_URL` are not consumed by this configuration.

```dotenv
PORT=3001
NODE_ENV=development
DB_HOST=localhost
DB_PORT=5432
DB_USER=confluence
DB_PASSWORD=confluence123
DB_NAME=confluence
REDIS_HOST=localhost
REDIS_PORT=6379
ES_NODE=http://localhost:9200
RABBITMQ_URL=amqp://confluence:confluence123@localhost:5672
SESSION_SECRET=confluence-dev-secret-change-in-production
```

The Elasticsearch index is fixed to `wiki_pages`, the queue to `page-index`, and the session duration to 24 hours. CORS is hardcoded to `http://localhost:5173`. Vite proxies `/api` to port 3001.

For multiple API processes, `npm run dev:server2` and `dev:server3` start API instances on 3002 and 3003 (without a second indexer). This does not configure a load balancer; Vite still targets 3001.

## Verification and source map

| Command | Scope |
|---------|-------|
| `npm run build` in `backend` | TypeScript compilation; current layout emits `dist/src/index.js` |
| `npm test` in `backend` | Mocked route tests, the role matrix, HTML sanitization, and queue buffering |
| `npm run build` in `frontend` | TypeScript check followed by Vite build |
| `npm run lint` in either package | Existing package lint command |
| `npm run test:e2e` in `confluence` | Existing Playwright smoke suite; requires the stack |

There is no backend `start` script or package-level `type-check` script. The backend `main` field points to `dist/index.js`, which differs from the compiler's output path. The smoke tests check that the screenshot pages render. Authorization, search, and indexing recovery were verified against a running stack; see the architecture's Implementation Notes.

Start with [API composition](./backend/src/app.ts), [page operations](./backend/src/services/pageService.ts), [versions](./backend/src/services/versionService.ts), [search indexing](./backend/src/workers/search-indexer.ts), [database schema](./backend/src/db/init.sql), [access control](./backend/src/services/accessService.ts), and [browser state](./frontend/src/stores/wikiStore.ts).

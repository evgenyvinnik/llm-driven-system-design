# Confluence: a wiki and knowledge-base learning project

This project explores spaces, hierarchical pages, rich-text editing, revision history, comments, review requests, and asynchronous search indexing. It pairs a React interface with an Express API, PostgreSQL, Valkey, Elasticsearch, and a RabbitMQ indexing worker. It is a teaching implementation with several unfinished paths, not a reproduction of Confluence's production system.

Read [architecture.md](./architecture.md) for the proposed production design and a source-based account of the local implementation. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers explain the design in a 45-minute discussion.

## What is available

| Area | Current behavior |
|------|------------------|
| Accounts | Registration, login, logout, and Redis-backed sessions; two seeded accounts |
| Spaces | Dashboard, space overview, recursive page tree; space/member management through the API |
| Pages | APIs for create, read, update, hard delete, labels, and moves; editor/viewer components exist |
| History | Full revision snapshots, line-based HTML diffs, and restore-as-new-version APIs |
| Discussion | Top-level comments and direct replies; author-only comment editing/deletion in the API |
| Review | Request/review records; approval publishes the current page, without binding to a reviewed revision |
| Search | Elasticsearch title/body/label matching, a separate indexing worker, and SQL substring fallback on search errors |

**Page navigation is currently incomplete.** The generated route tree nests page viewing inside the space route and editing inside the page route. Both parent components omit the child outlet, so those URLs render the space overview instead of the intended page/editor. The source contains the downstream components, but they are not a verified working browser flow. Search links also pass a page UUID where the destination expects a slug.

Other material limitations:

- Authentication does not enforce space membership. Private spaces, drafts, page history, and comments are readable through direct APIs; most writes require only a login. The member list exposes email addresses. This is not an access-controlled team wiki.
- Client-supplied HTML reaches page rendering without sanitization; search snippets also use raw HTML insertion.
- Saves have no expected-version check or durable request identity. Stale editors can overwrite newer content, concurrent updates can return a database error, and retrying an uncertain save can create another revision.
- Root-level moves have a SQL parameter-count defect. Other moves lack cycle and same-space checks. There is no drag-and-drop move interface.
- Restores, approval changes, labels, and space deletion do not consistently update caches or search. Worker helpers swallow indexing errors, allowing failed work to be acknowledged.
- Templates have APIs and an unused picker component. The table-of-contents macro is a placeholder. There is no autosave, local draft recovery, live co-editing, or admin screen.

These findings come from source inspection; the documentation review did not start the stack or repair application code. Detailed paths and consequences are in [Implementation Notes](./architecture.md#implementation-notes).

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

The seed creates Alice and Bob, two spaces (`ENG` and `PROD`), nine published pages, ten historical snapshots, labels, two top-level comments, and three global template records. Both accounts use **`password123`**. Alice has the global `admin` role, but this does not activate an admin interface or enforce space permissions. Seed content is fictional sample material.

The seed is not generally rerunnable: some inserts skip conflicts, while others fail or append duplicate records. Use it once on a fresh schema rather than as a migration or repair command.

Start each application process in its own terminal:

```bash
# From confluence/backend
npm run dev
```

```bash
# From confluence/backend
npm run dev:worker
```

```bash
# From confluence/frontend
npm install
npm run dev
```

Open [the wiki](http://localhost:5173), sign in as `alice` or `bob`, and inspect the dashboard and space overview. Page/editor navigation remains subject to the routing issue above. The API's `/api/health` returns a process-level status, not a dependency readiness result.

### Populate search for the seeded pages

Seeding PostgreSQL does not publish indexing messages. A healthy empty Elasticsearch index returns zero results and does not trigger SQL fallback. There is no supplied backfill command.

For this fresh local seed, the following one-time command indexes the current pages directly. Run it from `confluence/backend` after installing dependencies and starting Elasticsearch. It deliberately calls Elasticsearch directly so a failed write surfaces instead of being swallowed by the worker helper. It is a small setup procedure, not a concurrent production rebuild or deletion reconciliation tool.

```bash
node --import tsx --input-type=module <<'JS'
import { pool } from './src/services/db.ts';
import { esClient, ensureIndex } from './src/services/elasticsearch.ts';
import { config } from './src/config/index.ts';
try {
  await ensureIndex();
  if (!(await esClient.indices.exists({ index: config.elasticsearch.index }))) {
    throw new Error('wiki_pages index was not created');
  }
  const { rows } = await pool.query(`
    SELECT p.*, s.key AS space_key,
      ARRAY(SELECT label FROM page_labels WHERE page_id = p.id) AS labels
    FROM pages p JOIN spaces s ON s.id = p.space_id
  `);
  for (const p of rows) {
    await esClient.index({
      index: config.elasticsearch.index,
      id: p.id,
      document: {
        page_id: p.id, space_id: p.space_id, space_key: p.space_key,
        title: p.title, content_text: p.content_text, labels: p.labels,
        created_by: p.created_by, updated_at: p.updated_at, status: p.status,
      },
    });
  }
  await esClient.indices.refresh({ index: config.elasticsearch.index });
  console.log(`Indexed ${rows.length} pages`);
} finally {
  await Promise.all([pool.end(), esClient.close()]);
}
JS
```

Try a seeded title such as “Getting Started” in search. Subsequent page create/update/delete requests attempt queue publication, but the delivery and invalidation gaps described above remain. This setup command has been checked against module exports and fields, not executed against a live database during the documentation review.

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

For multiple API processes, bypass the existing `dev:server2`/`dev:server3` wrappers: they call `npm run dev`, which resets `PORT` to 3001. From `backend`, use a separate terminal for each explicit command:

```bash
PORT=3002 NODE_ENV=development ./node_modules/.bin/tsx watch src/index.ts
```

Repeat with port 3003 if desired. This does not configure a load balancer; Vite still targets 3001.

## Verification and source map

| Command | Scope |
|---------|-------|
| `npm run build` in `backend` | TypeScript compilation; current layout emits `dist/src/index.js` |
| `npm test` in `backend` | Mocked health/auth/space/recent-page route tests |
| `npm run build` in `frontend` | TypeScript check followed by Vite build |
| `npm run lint` in either package | Existing package lint command |
| `npm run test:e2e` in `confluence` | Existing Playwright smoke suite; requires the stack |

There is no backend `start` script or package-level `type-check` script. The backend `main` field points to `dist/index.js`, which differs from the compiler's output path. Existing browser smoke tests look for `main` elements that the current layouts do not render; they do not establish page editing, authorization, or worker recovery correctness. No builds or full-stack tests were run for this documentation review.

Start with [API composition](./backend/src/app.ts), [page operations](./backend/src/services/pageService.ts), [versions](./backend/src/services/versionService.ts), [search indexing](./backend/src/workers/search-indexer.ts), [database schema](./backend/src/db/init.sql), [browser state](./frontend/src/stores/wikiStore.ts), and [generated route nesting](./frontend/src/routeTree.gen.ts).

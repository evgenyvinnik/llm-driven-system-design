# Gmail: an internal email client

This learning project models conversation threads, independent mailbox state, and searchable messages using React, Express, PostgreSQL, Valkey, and Elasticsearch. Mail stays between registered accounts in this application. It does not connect to Google Gmail or deliver through SMTP, IMAP, or POP3.

Read [architecture.md](./architecture.md) for the implemented flows, limitations, and a separate production proposal. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [full-stack](./system-design-answer-fullstack.md) answers present proposed designs for a 45-minute interview. [CLAUDE.md](./CLAUDE.md) contains development history; some older completion claims exceed the current wiring.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 8,688 |
| Source Files | 79 |
| .ts | 4,665 |
| .tsx | 1,727 |
| .md | 1,589 |
| .sql | 369 |
| .json | 158 |


## What you can explore

- Register and sign in with a username, then browse Inbox, Sent, Starred, Spam, Trash, All Mail, and custom-label views. Thread lists request 25 records per page and use TanStack Virtual.
- Open conversations, expand individual messages, compose plain-text messages with To/CC/BCC chips, and reply. Contact suggestions use past correspondence and a 200 ms debounce.
- Star or trash a conversation with an immediate local update. Opening a thread marks it read on the server.
- Run the separate indexer to populate message search. Submit free text or `from:`, `to:`, `has:attachment`, `before:`, and `after:` operators; the dropdown displays the first 20 message hits, which can include several from one thread.
- Exercise draft CRUD and version conflicts through the API. Custom-label create/update/delete and assignment are also available through the API.

### Current boundaries

Compose has **no draft save or restore integration**: closing it discards its text. The Drafts navigation item queries thread labels, so it does not display rows from the drafts API. The label-management component is not mounted. Attachment storage/upload, admin tools, live delivery notifications, undo, and mail keyboard shortcuts are absent.

- **Privacy.** You see only the messages you sent or received, even inside a shared thread: a reply that leaves you off, or a message you were BCC'd on, stays private in the thread view, the inbox list and search. Replying requires being on the thread.
- **Sending.** Messages to addresses with no account are refused (400) rather than half-delivered, and duplicate addresses are collapsed.
- **Rendering.** Message HTML is sanitized on send and again when rendered, and search snippets are escaped.
- **Mailbox state.** Archive removes a thread from the inbox until new mail arrives. List and unread-count caches are invalidated immediately on every change.
- **Search.** If Elasticsearch is down, search falls back to SQL and says so.

Detail and list state are not reconciled consistently; a direct thread visit can have a nonfunctional star button. Send has no idempotency receipt, so retrying an uncertain send can send twice. Remote images load (no tracking-pixel protection). Use only the demo accounts below when exploring delivery; this is a teaching system, not a place for real mail.

## Stack and processes

| Component | Actual implementation |
|-----------|-----------------------|
| Browser | React 19, TypeScript, Vite 6, TanStack Router, Zustand 5, TanStack Virtual, Tailwind 3 |
| API | Express 4, TypeScript through tsx, bcryptjs, express-session with connect-redis |
| Database | PostgreSQL 16; ten tables and seven explicit secondary indexes |
| Sessions/cache/limits | Valkey 7 through ioredis; Redis-backed request counters |
| Search | Elasticsearch 8.11.0; one `emails` index, one shard, no replica |
| Indexer | Node process (started by `npm run dev`) indexing messages whose `indexed_at` marker is unset |
| Diagnostics | Pino logs and an API Prometheus endpoint; circuit-breaker helper is unused |

Use Node.js 22 and npm; the repository baseline is Node 20 or later, but individual dependency versions can require a newer minor release. Install PostgreSQL client tools for migration verification and seeding. Run commands from the indicated directory, using separate terminals for long-lived processes.

## Infrastructure

### Option A: Docker Compose (recommended)

From `gmail/`:

```bash
docker compose up -d
docker compose ps
docker compose exec postgres pg_isready -U gmail -d gmail
docker compose exec redis redis-cli ping
curl --fail 'http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=30s'
```

Compose starts PostgreSQL, Valkey with append-only persistence, and unsecured single-node Elasticsearch with a 256 MB heap. It does **not** start the API, frontend, or indexer. The SQL initialization mount runs only when PostgreSQL's volume is first created.

`docker compose down` stops containers while retaining data. `docker compose down -v` also deletes all three named data volumes, including accounts, messages, sessions, and the search index.

### Option B: Native installation (no Docker)

On macOS, install and start PostgreSQL and Valkey. For a fresh local installation, create a database owned by the application's role:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql -d postgres -c "CREATE ROLE gmail LOGIN PASSWORD 'gmail123';"
createdb -O gmail gmail
PGPASSWORD=gmail123 psql -h localhost -U gmail -d gmail -c 'SELECT current_user;'
valkey-cli ping
```

If the role/database already exists, reuse it rather than repeating creation. Ownership matters for creating tables in PostgreSQL 16; database-level privileges alone are not the same as schema ownership.

Download the matching macOS archive and checksum from [Elasticsearch 8.11.0 releases](https://www.elastic.co/downloads/past-releases/elasticsearch-8-11-0), selecting aarch64 for Apple Silicon or x86_64 for Intel. Follow the [archive installation instructions](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/targz.html). From the extracted directory, run this local-only equivalent of Compose in its own terminal:

```bash
ES_JAVA_OPTS='-Xms256m -Xmx256m' ./bin/elasticsearch \
  -Ediscovery.type=single-node \
  -Expack.security.enabled=false \
  -Enetwork.host=127.0.0.1
```

Verify it with the same cluster-health request used above. No object-store bucket or message broker is required.

## Install, initialize, and run

In `gmail/backend/`, install dependencies, apply the schema, and seed **once into a fresh database**:

```bash
npm install
export DATABASE_URL='postgresql://gmail:gmail123@localhost:5432/gmail'
npm run db:migrate
PGPASSWORD=gmail123 psql -v ON_ERROR_STOP=1 -h localhost -U gmail -d gmail -f db-seed/seed.sql
npm run dev
```

The migration script applies `src/db/init.sql`; its `IF NOT EXISTS` statements create missing objects but do not upgrade existing table definitions. The migration also adds the indexing-marker columns and a unique recipient index to an existing database. The seed is safe to rerun (it skips existing rows) but does not reset modified mailbox state.

`npm run dev` starts the API and the search indexer together. If the Elasticsearch index is ever reset, rebuild it with `npm run search:reindex`.

In a third terminal at `gmail/frontend/`:

```bash
npm install
npm run dev
```

Open [the local client](http://localhost:5173). Vite proxies `/api` to port 3001. Check [API health](http://localhost:3001/api/health/detailed) and [API metrics](http://localhost:3001/metrics) directly; Vite does not proxy `/metrics`. Detailed health checks PostgreSQL and Redis, not search freshness.

### Demo data

| Username | Password | Email |
|----------|----------|-------|
| alice | password123 | alice@gmail.local |
| bob | password123 | bob@gmail.local |
| charlie | password123 | charlie@gmail.local |

The fixture has seven threads and twelve messages, eight system labels per user, Alice's Work/Personal labels, six contacts, and one Alice draft accessible through the API. Two threads demonstrate visibility. In *Q4 offsite planning*, Bob replies to Alice only, so Charlie never sees that reply. In *Interview loop feedback*, Charlie BCCs Alice: Bob doesn't see her, and she sees herself under bcc. There is no attachment example. Registration hashes passwords with cost 12; the supplied fixture uses cost 10. Some seeded snippets/counts are illustrative rather than recomputed from the latest message.

## Configuration and multiple instances

API and worker load `.env` from their working directory through dotenv. The migration script does **not** load dotenv; export `DATABASE_URL` in its shell.

| Setting | Default | Where used |
|---------|---------|------------|
| `POSTGRES_HOST`, `POSTGRES_PORT` | `localhost`, `5432` | API and worker database pool |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | `gmail`, `gmail`, `gmail123` | API and worker database pool |
| `DATABASE_URL` | Migration fallback shown above | Migration only; parsed but ignored by the application pool |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` | API and worker Redis client |
| `REDIS_URL` | `redis://localhost:6379` | Parsed but ignored by the Redis constructor |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | Search client and indexer |
| `SESSION_SECRET` | `gmail-dev-session-secret` | Cookie signing; share across local API instances |
| `PORT` | Config fallback `3000`; `npm run dev` forces `3001` | API listener and log labels |
| `NODE_ENV` | `development` | Production enables Secure cookies and info-level logging |

`dev:server2` and `dev:server3` start extra API instances on 3002 and 3003 (without another indexer). There is no load balancer configuration; the browser still targets 3001. Keep one indexer: indexers do not lease work, so two would index the same messages twice (harmless but wasteful). PostgreSQL, Valkey, and Elasticsearch bind host ports 5432, 6379, and 9200, so avoid conflicting local stacks.

## Verification commands and limits

Backend scripts include `npm run build`, `npm test`, `npm run test:watch`, `npm run lint`, and `npm run format`. Frontend scripts include `npm run build`, `npm run lint`, `npm run format`, and `npm run preview`. The backend compiler emits under `dist/src`; there is no `start` script, and SQL assets are not copied by TypeScript.

The backend tests mock persistence and sessions. They cover routes, recipient deduplication, HTML sanitization, the visibility rule, and cache invalidation. Visibility, sending, search, and indexing recovery were verified against a running stack (see the architecture's Implementation Notes). From the repository root, `npm run test:smoke gmail` exercises broad login/page-render checks. From `gmail/`, `npm run test:e2e` can start Vite but requires the backend and datastores already running. The [screenshots](./screenshots/03-inbox.png) include the same thread as seen by a full and a partial participant, and the BCC recipient's view. Draft editing in the browser is not wired, and there are no performance benchmarks.

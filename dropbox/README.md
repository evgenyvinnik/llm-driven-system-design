# Dropbox: cloud file storage learning project

A React file browser backed by PostgreSQL metadata and content-addressed chunks in MinIO. It explores folder trees, uploads, version history, sharing, session authentication, and storage administration. This is a teaching implementation with incomplete transfer and permission guarantees; the production proposal is described separately in [architecture.md](./architecture.md).

## What the current application provides

| Area | Implemented behavior and limits |
|------|---------------------------------|
| File browser | Root and nested folders, breadcrumbs, list/grid views, selection, create, rename, move, and soft delete. Listings are unpaginated and not virtualized. |
| Upload | Browser sends each entire file in one multipart request. Express splits it into 4 MiB chunks. The default multipart limit is **8 MiB per file**, including requests to the separate chunk API. |
| Upload failure | With the default PostgreSQL parser, a storage metric receives a string and throws **after metadata commits**. The UI can show failure for a saved file. Refresh before retrying: completion has no idempotency guard. |
| Download | Owner download reassembles all chunks into memory. No streaming or Range support. A file with no chunk rows returns an empty payload, including seeded sample files. |
| Versions | Overwriting a name saves the previous manifest; history can be listed and restored as another version. Concurrent writes have no base-version conflict protocol. |
| Public links | API creates links with optional passwords, expiry, and download limits. The copied link opens a JSON metadata endpoint; there is no public download-page UI. |
| Folder sharing | Grant records and UI exist, but `/shared` fails because the token route shadows `shared-with-me`. Normal file operations also require ownership, so grants do not enable recipient browsing. |
| Administration | Statistics, users, storage breakdown, deletion of another account, and manual cleanup. Counts are not reliable storage accounting; cleanup is not a complete garbage collector. |
| Notifications | Server-side WebSocket endpoint and Redis Pub/Sub exist. The browser does not connect to them; no durable replay or offline sync is implemented. |

Settings displays account and quota information. Its change-password and delete-account buttons have no actions. There is no desktop sync agent, trash recovery interface, file preview, resumable browser queue, or folder upload workflow.

The source audit in [Implementation Notes](./architecture.md#implementation-notes) explains these limitations and the relevant files. No application fixes are implied by this documentation review.

## Stack and source map

| Layer | Technology | Start reading |
|-------|------------|---------------|
| Frontend | React 19, TypeScript, Vite 6, TanStack Router, Zustand, Tailwind, react-dropzone | [Routes](./frontend/src/routes/index.tsx), [file store](./frontend/src/stores/fileStore.ts), [API](./frontend/src/services/api.ts) |
| Backend | Node.js, Express 4, TypeScript/tsx, ws | [Entry point](./backend/src/index.ts), [file routes](./backend/src/routes/files.ts) |
| Metadata | PostgreSQL 16 | [Schema](./backend/src/db/init.sql), [file services](./backend/src/services/file/index.ts) |
| Sessions and notification fanout | Valkey 7 through ioredis | [Redis adapter](./backend/src/utils/redis.ts) |
| Chunk objects | MinIO through the AWS S3 SDK | [Storage adapter](./backend/src/utils/storage.ts) |
| Diagnostics | Pino, prom-client, Cockatiel | [Shared modules](./backend/src/shared/metrics.ts) |

There is one API process, with optional instances on different ports. There is no RabbitMQ service, sync worker, load balancer, Prometheus server, or Grafana configuration in this project.

## Prerequisites

Use Node.js **20 or newer**, npm, and either Docker Compose or native infrastructure. Commands below start in the repository root unless a directory change is shown. Stop other learning projects that occupy these ports.

| Port | Service |
|------|---------|
| 5173 | Vite frontend |
| 3000 | Express HTTP and WebSocket server |
| 3001–3003 | Optional alternative API instances |
| 5432 | PostgreSQL |
| 6379 | Valkey |
| 9000 | MinIO S3 API |
| 9001 | MinIO console |

## Option A: Docker Compose (recommended)

```bash
cd dropbox
docker compose up -d
docker compose ps
docker compose logs minio-init
docker compose exec postgres pg_isready -U dropbox -d dropbox
docker compose exec redis redis-cli ping
curl -f http://localhost:9000/minio/health/live
```

Compose initializes the schema only when the PostgreSQL volume is empty. It does not seed accounts or launch Node/Vite. The MinIO initializer creates `dropbox-chunks` and enables **anonymous download access to the bucket**. Known object keys can bypass application sharing checks; use local sample data. Its final `exit 0` can hide an earlier initialization failure, so inspect the logs.

Seed once on a freshly initialized database:

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U dropbox -d dropbox < backend/db-seed/seed.sql
```

The account inserts are not rerunnable: they fail on existing emails. Do not treat re-running the seed as a migration or reset.

To stop infrastructure while keeping data:

```bash
docker compose down
```

For an intentional reset, `docker compose down -v` removes this project's database, Valkey, and MinIO volumes. Start again and seed the new database afterward.

## Option B: native installation (no Docker)

Install PostgreSQL, Valkey, and MinIO using Homebrew. MinIO provides its own [official tap](https://github.com/minio/homebrew-stable).

```bash
brew install postgresql@16 valkey
brew install minio/stable/minio minio/stable/mc
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
pg_isready
valkey-cli ping
```

Create the development role and database once, using your local PostgreSQL administrator account. In a fresh Homebrew installation this is normally your macOS account:

```bash
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE dropbox LOGIN PASSWORD 'dropbox_password';"
createdb -O dropbox dropbox
cd dropbox
PGPASSWORD=dropbox_password psql -h localhost -U dropbox -d dropbox -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=dropbox_password psql -h localhost -U dropbox -d dropbox -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
```

Start MinIO in a separate terminal and keep it running:

```bash
mkdir -p "$HOME/.local/share/dropbox-minio"
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin123 minio server "$HOME/.local/share/dropbox-minio" --console-address ':9001'
```

Create and verify the bucket in another terminal:

```bash
mc alias set dropbox-local http://localhost:9000 minioadmin minioadmin123
mc mb --ignore-existing dropbox-local/dropbox-chunks
mc anonymous set none dropbox-local/dropbox-chunks
mc ls dropbox-local
curl -f http://localhost:9000/minio/health/live
```

This native setup keeps the bucket private. Application SDK requests and presigned download URLs work with a private bucket; anonymous access is not required. The checked-in Compose initializer uses the different policy described above. Stop native infrastructure with `brew services stop postgresql@16`, `brew services stop valkey`, and Ctrl-C in the MinIO terminal.

## Start the application

Backend terminal, from the repository root:

```bash
cd dropbox/backend
npm install
npm run dev
```

Frontend terminal, from the repository root:

```bash
cd dropbox/frontend
npm install
npm run dev
```

Open [the file browser](http://localhost:5173). Vite proxies `/api` and `/ws` to port 3000; health and metrics are accessed directly on the backend.

| Account | Password | Initial state |
|---------|----------|---------------|
| `admin@dropbox.local` | `password123` | Admin, 10 GiB quota, three folders and eleven sample file records |
| `demo@dropbox.local` | `password123` | Regular user, 2 GiB quota, empty file browser |

The login page and SQL comments show different passwords, but the seeded bcrypt hashes match **password123** for both accounts. Sample file records have fake content hashes and no stored chunks, history, or shares. They demonstrate navigation and do not contain downloadable sample documents.

For a transfer experiment, use a small disposable file in the demo account. An upload may commit and then show an error because of the metric bug; refresh the folder to inspect the outcome. Do not use repeated upload attempts as a reliable retry or quota test.

## Environment variables

The backend reads the process environment directly. It **does not load `.env` automatically**. Defaults match Compose; no environment file is necessary for that setup. To use the supplied example, copy it to `.env`, review it, then explicitly export it in the backend terminal:

```bash
cp .env.example .env
set -a
source .env
set +a
npm run dev
```

| Variable | Default / meaning |
|----------|-------------------|
| `PORT` | `3000` |
| `NODE_ENV` | Development behavior unless set to `production`; affects logs and secure cookie |
| `FRONTEND_URL` | `http://localhost:5173`, allowed credentialed CORS origin |
| `DATABASE_URL` | `postgres://dropbox:dropbox_password@localhost:5432/dropbox` |
| `REDIS_URL` | `redis://localhost:6379` |
| `MINIO_ENDPOINT` / `MINIO_PORT` | `localhost` / `9000`; hostname and port are separate |
| `MINIO_USE_SSL` | `false`; enabled only by the literal `true` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | `minioadmin` / `minioadmin123` |
| `MINIO_BUCKET` | `dropbox-chunks` |
| `SESSION_EXPIRY_HOURS` | `24` for Redis and SQL records; browser cookie remains fixed at 24 hours |
| `CHUNK_SIZE` | `4194304` bytes; also sets multipart limit to twice this value; requires a positive integer |
| `LOG_LEVEL` | `debug` outside production, `info` in production |

`SESSION_SECRET` and `MAX_FILE_SIZE` appear in `.env.example` but are **unused**. Setting `MAX_FILE_SIZE` does not change the 8 MiB default limit. Storage quota arithmetic is unreliable because PostgreSQL BIGINT values are returned as strings and upload comparisons do not normalize them.

## Verification and troubleshooting

```bash
curl -f http://localhost:3000/health/live
curl -f http://localhost:3000/health/ready
curl -f http://localhost:3000/health/deep
curl -f http://localhost:3000/metrics
```

Liveness only checks the process. Readiness checks PostgreSQL and Redis; deep health also checks the MinIO bucket. These endpoints do not demonstrate successful uploads, sharing, restore, or correct accounting.

Both application packages expose `npm run type-check`, `npm run build`, and `npm run lint`. There is no backend migration script: apply `init.sql` only to a fresh database. Backend `dev:server1`, `dev:server2`, and `dev:server3` bind 3001–3003; Vite still targets 3000 unless its proxy is changed. No balancing configuration is supplied.

From the repository root, `node scripts/screenshots.mjs --start dropbox` uses the seeded admin account. `npm run test:smoke dropbox` expects the stack to be available, but the checked-in smoke helper uses unseeded `alice@example.com`. Its page-shell assertions do not verify file bytes or sharing. Project `npm run test:e2e` can start Vite; PostgreSQL, Valkey, MinIO, and the API must already be running.

This documentation review checked source, configuration, links, and isolated behavior with mocked dependencies. It did not start infrastructure, run a full build, or validate a browser session. See [the repository review record](../DOCUMENTATION_REVIEW.md#dropbox).

## Design reading

- [Architecture and exact local schema](./architecture.md)
- [Frontend interview answer](./system-design-answer-frontend.md)
- [Backend interview answer](./system-design-answer-backend.md)
- [Fullstack interview answer](./system-design-answer-fullstack.md)

The interview answers propose a production system. They emphasize resumable transfers, explicit conflict handling, and authorized synchronization within a 45-minute discussion; they do not claim those guarantees exist in this demo.

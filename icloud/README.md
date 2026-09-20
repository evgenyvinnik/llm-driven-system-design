# iCloud Sync — files, photos, and sync experiments

An educational iCloud-like application with an online Drive, a photo library, and an
administrator dashboard. The useful design questions are how to recognize concurrent
edits, keep metadata consistent with stored bytes, and recover after a device disconnects.
This repository is an independent teaching project; it does not describe Apple's internals.

The browser currently uploads whole files. The API divides Drive uploads into 4 MiB,
SHA-256-addressed chunks and can compare chunk manifests for download experiments.
Version-vector and conflict endpoints exist, but the browser does not run a durable
bidirectional sync engine. Offline journaling, resumable uploads, and safe conflict
preservation are proposed extensions, not completed features.

## What you can explore

| Area | Implemented behavior | Important boundary |
|------|----------------------|--------------------|
| Drive | Browse folders, upload, download, rename, soft-delete, drag and drop | Whole uploads buffered in memory; 100 MiB per file |
| Chunk storage | Server-side chunk deduplication and per-chunk download verification during assembly | Metadata, references, and object writes are not atomic |
| Sync API | Vector comparison, changes query, conflicts, device state, delta manifest | No reliable replay log, transactional conflict admission, or restorable history |
| Photos | Upload, 200-pixel square thumbnails, previews up to 1024 pixels, favorites, delete | 50 MiB uploads; EXIF capture data is not parsed |
| Photo UI | Four-column row virtualization, lazy thumbnails, preview viewer, album creation | No album browser, offline originals, or storage eviction manager |
| Notifications | WebSocket events within one API process | Session restoration and cross-instance delivery are incomplete |
| Administration | Statistics, user search, operation/conflict lists, manual cleanup/purge | Counts are diagnostic; maintenance is not concurrency-safe |

Double-click a Drive folder to open it or a file to download it; right-click for rename
and delete. In Photos, click to select and double-click to open the preview. Conflict
warnings are shown, but the current UI has no conflict-resolution dialog. Device and
version APIs likewise have no dedicated management screens.

## Stack and source map

React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind, and TanStack Virtual run
in the frontend. One Express process serves REST and WebSocket traffic. PostgreSQL 16
stores metadata; Valkey provides Redis-compatible session caching and optional request
receipts; MinIO stores chunks and photo objects. Sharp produces photo derivatives.

| Source | Responsibility |
|--------|----------------|
| [Server entry](./backend/src/index.ts) | Middleware, routes, health, metrics, WebSocket setup |
| [Schema](./backend/src/db/init.sql) | Thirteen metadata, account, and sync tables |
| [File routes](./backend/src/routes/files.ts) | Whole-file upload and Drive operations |
| [Sync service](./backend/src/services/sync.ts) | Vector comparison and conflict experiments |
| [Chunk service](./backend/src/services/chunks.ts) | Chunk manifests, storage, assembly, cleanup |
| [Photo routes](./backend/src/routes/photos.ts) | Derivatives, photos, and albums |
| [File state](./frontend/src/stores/fileStore.ts) / [photo state](./frontend/src/stores/photoStore.ts) | In-memory browser state |
| [Photo grid](./frontend/src/components/photos/PhotoGrid.tsx) | Virtualized rows |

## Prerequisites

Use Node.js 20 or newer and npm. Run one project at a time on the default ports. Choose
one infrastructure option below; application processes run on the host in both cases.
Commands begin in this repository's root unless a different directory is stated.

### Option A: Docker Compose

```bash
cd icloud
docker compose up -d
docker compose ps
docker compose logs minio-init
docker compose exec postgres pg_isready -U icloud -d icloud_sync
docker compose exec redis redis-cli ping
curl --fail http://localhost:9000/minio/health/live
```

Compose initializes the SQL schema only when PostgreSQL's data volume is first created.
There is no `db:migrate` script. The MinIO initializer creates `icloud-chunks`,
`icloud-photos`, and `icloud-thumbnails`; inspect its logs because its final success exit
can mask a failed bucket command.

The checked-in Compose file uses unpinned `minio/minio:latest` and `minio/mc:latest`
images. Their availability was not verified by pulling them in this review. MinIO's
upstream community repository is archived and documents source-only distribution;
if these image pulls fail, use the native option or an explicitly selected local image.
See the [upstream status and build instructions](https://github.com/minio/minio).

Stop services while retaining data with `docker compose down`. For an intentional,
destructive reset of this demo's database and objects, `docker compose down -v` removes
its named volumes; the next start initializes a fresh schema.

### Option B: Native installation on macOS

Install and start PostgreSQL and Valkey:

```bash
brew install postgresql@16 valkey minio minio-mc
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
createuser --login --pwprompt icloud
createdb --owner=icloud icloud_sync
PGPASSWORD=icloud_secret psql -h localhost -U icloud -d icloud_sync \
  -v ON_ERROR_STOP=1 -f icloud/backend/src/db/init.sql
pg_isready -h localhost -U icloud -d icloud_sync
valkey-cli ping
```

Enter `icloud_secret` at the role password prompt. These role, database, and schema
commands are for a fresh installation, not a repeatable migration. Existing installations
should verify their state before rerunning them.

Homebrew currently lists [minio](https://formulae.brew.sh/formula/minio) as deprecated,
with a scheduled disable date of February 17, 2027; [minio-mc](https://formulae.brew.sh/formula/minio-mc)
provides the `mc` command. Package availability can change.

In a separate terminal, keep the MinIO server running:

```bash
mkdir -p "$HOME/.local/share/icloud-minio"
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin123 \
  minio server "$HOME/.local/share/icloud-minio" --console-address ':9001'
```

Then create and verify the three buckets:

```bash
mc alias set icloud-local http://localhost:9000 minioadmin minioadmin123
mc mb --ignore-existing icloud-local/icloud-chunks
mc mb --ignore-existing icloud-local/icloud-photos
mc mb --ignore-existing icloud-local/icloud-thumbnails
mc ls icloud-local
curl --fail http://localhost:9000/minio/health/live
```

## Start the application and seed data

In one terminal, from the repository root:

```bash
cd icloud/backend
npm install
npm run db:seed
npm run dev
```

`db:seed` and `db:seed:photos` execute the same script. It applies
[base.sql](./backend/db-seed/base.sql), then fetches up to twelve Unsplash images and
writes their originals and derivatives into MinIO. Network failures can leave a partial
photo set; any existing photo for the demo user makes a later run skip that photo batch.
The seed does not reconcile storage counters.

Seeded Drive files contain illustrative metadata only: they have no chunk manifests or
object bytes. Upload your own small file to exercise an actual download. Seeded photo
dates, camera fields, locations, and hashes are illustrative fixture values.

In another terminal, from the repository root:

```bash
cd icloud/frontend
npm install
npm run dev
```

Open [the application](http://localhost:5173). The frontend proxies `/api` and `/ws` to
port 3001. The MinIO console is at [localhost:9001](http://localhost:9001).

| Account after seeding | Password |
|-----------------------|----------|
| `user@icloud.local` | `password123` |
| `admin@icloud.local` | `password123` |

The login page and SQL comments advertise different passwords; the fixture hash matches
`password123` for both accounts. Registration also creates an ordinary user, but does not
add sample photos or administrator privileges.

## Configuration

These defaults are read directly from the process environment in
[db.ts](./backend/src/db.ts). The application does not load a `.env` file itself. Export
changed values in the terminal before starting it; `DATABASE_URL` and `REDIS_URL` are
not consumed by this project.

| Variable | Default / meaning |
|----------|-------------------|
| `POSTGRES_HOST`, `POSTGRES_PORT` | `localhost`, `5432` |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | `icloud_sync`, `icloud`, `icloud_secret` |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` |
| `MINIO_ENDPOINT`, `MINIO_PORT` | `localhost`, `9000`; endpoint is a hostname |
| `MINIO_USE_SSL` | Enabled only when exactly `true` |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | `minioadmin`, `minioadmin123` |
| `FRONTEND_URL` | `http://localhost:5173`, credentialed CORS origin |
| `PORT` | Source fallback 3000; development scripts explicitly choose 3001–3003 |
| `NODE_ENV` | Development scripts set `development`; `start` sets `production` |
| `LOG_LEVEL`, `APP_VERSION` | Optional logging and health metadata overrides |

`npm start` runs TypeScript through `tsx` and enables secure cookies; configure HTTPS and
an appropriate proxy for that mode. A frontend production build also needs `/api` and
`/ws` routing; Vite's development proxy is not included in static assets.

## Verification and known limitations

From each of `icloud/backend` and `icloud/frontend`, `npm run type-check` and
`npm run build` are available. Both packages also expose lint and format scripts.
Health endpoints are `/health`, `/health/live`, and `/health/ready`; Prometheus text is
at `/metrics`. Readiness checks PostgreSQL and Redis, not object-storage readiness.

The project-root `npm run test:e2e` runs Playwright and can start only the frontend.
Its smoke tests use `alice@example.com / password123`, which the seed does not create,
and reuse that identity for an admin test. They are not a valid fresh-seed acceptance
suite without reconciling those assumptions. The repository screenshot configuration
uses the seeded accounts instead.

This documentation review inspected source, schema, scripts, and fixtures; it did not
start the full stack or establish throughput, multi-device correctness, or accessibility.

Current limitations worth investigating:

- Upload publication, version updates, reference counts, and quota accounting lack a
  shared transaction. Overwrites and concurrent requests can leave inconsistent state.
- Conflict copies have metadata but no copied chunk manifest; history does not preserve
  immutable file bytes. The changes endpoint scans mutable timestamps, not a replay log.
- Browser state disappears on reload. Request races and reconnect gaps can leave stale
  lists; WebSocket delivery is process-local and restored sessions do not reconnect it.
- Private photo routes currently send public cache directives. Album membership checks,
  cached authorization, and optional idempotency-key scoping need further hardening.
- Cleanup and purge are experimental maintenance paths. They do not implement safe
  concurrent reference reclamation or offline-device tombstone acknowledgement.

You can start `dev:server2` and `dev:server3` in additional backend terminals, but there
is no load balancer or shared WebSocket fanout. This demonstrates the scaling gap rather
than a completed distributed deployment.

Read [architecture.md](./architecture.md) for precise implementation boundaries and
[frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md),
or [fullstack](./system-design-answer-fullstack.md) for whiteboard interview proposals.
[CLAUDE.md](./CLAUDE.md) records development history and may describe earlier intentions.

# Design a File System

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,230 |
| Source Files | 111 |
| .ts | 3,314 |
| .md | 1,457 |
| .tsx | 1,068 |
| .json | 173 |
| .js | 85 |

## Overview

Practice for a **four-level online coding assessment** whose reported variants include an in-memory file system, plus the system design question that model grows into. [ROADMAP.md entry 16](../ROADMAP.md#16-file-system) explains the source and where it fits.

There are two layers:

- **The practice problem.** [levels.md](./levels.md) is a four-level spec written for this repository: files, then queries, then users with quotas, then either backup and restore or time-to-live with history. A practice runner hands it to you one level at a time, with tests, a clock, and the next level locked until the current one passes. `backend/src/fs/file-store.ts` is the worked answer. A second spec in the same format, [levels-db.md](./levels-db.md), practices the in-memory database variant that most reports describe: fields within records, then scans, then timestamps with expiry, then either point-in-time reads or backup and restore. Its worked answer is `backend/src/kv/kv-store.ts`.
- **The service.** The same rules served from PostgreSQL to a React file browser, kept correct under concurrent writes from any number of API instances:
  - a path is a file or a directory, never both, enforced by one primary key;
  - quotas are exact, through a conditional counter and a CHECK constraint;
  - one lock order makes deadlocks impossible on the hot path;
  - a restore skips, and reports, paths that someone else now holds.

The interesting parts are not the CRUD. They are what has to stay true when many writers race: the race tests check every derived number against the files after each run, and a benchmark shows why directory totals can't stay synchronous at scale.

See [architecture.md](./architecture.md) for the design and its trade-offs, and [CLAUDE.md](./CLAUDE.md) for how it was built.

## Screenshots

| | |
|---|---|
| ![Root](./screenshots/01-root.png) | ![alice's home folder](./screenshots/02-home-alice.png) |
| The root, with directory totals and the largest files | alice's home folder; the owner defaults to her |
| ![Quota refused](./screenshots/03-quota-refused.png) | ![Users](./screenshots/04-users.png) |
| A create refused over quota, with both amounts | Users and quotas: meters, backups, merge |
| ![Restore with a skipped path](./screenshots/05-restore-skipped.png) | ![Shared folder](./screenshots/06-shared.png) |
| alice's restore skips `/shared/roadmap.md`, which bob now owns | The shared folder after the restore |

## Practice Mode

The runner reproduces the format: one level visible at a time, tests you run yourself, and the next level unlocked only when the current one passes. Your attempt lives in `backend/practice-attempt/`, which git ignores.

There are two problems. Each has two alternative level-4 tracks, and `backup` is the default for both:

| `--problem` | Spec | You implement | `--track` |
|-------------|------|---------------|-----------|
| `fs` (default) | [levels.md](./levels.md): a file store | `FileStore` in `file-store.ts` | `backup` or `time` |
| `db` | [levels-db.md](./levels-db.md): a key-value database | `KvStore` in `kv-store.ts` | `backup` or `history` |

```bash
cd backend
npm install
npm run practice -- start            # file store, 90 minutes, level 4 = backup track
npm run practice -- start --track time --minutes 70
npm run practice -- start --problem db                   # key-value database
npm run practice -- start --problem db --track history
```

One attempt runs at a time. The commands below read the problem from the attempt, so only `start` takes `--problem`. To keep two attempts side by side, give the second one its own folder with `--dir` on every command.

Then loop:

| Command | What it does |
|---------|--------------|
| `npm run practice -- check` | Runs the tests for every unlocked level against your class in `practice-attempt/` |
| `npm run practice -- next` | Unlocks the next level: appends it to `SPEC.md`, adds its tests, prints the new method signatures |
| `npm run practice -- status` | Split times per level and time left |
| `npm run practice -- dedup` | File store only. Adds the onsite bonus: find duplicate files in a large tree without reading files whole |
| `npm run practice -- reset --yes` | Deletes the attempt |

Rules of thumb that the levels are designed to reward (read them after a first attempt):
1. **Pick a data model for level 4 on day one.** Keep one record per file or field, and change every derived structure (directory counts, quota usage, history) inside the same two or three methods.
2. **Validate, then mutate.** A failed call must change nothing.
3. **Read the ordering rules twice.** Tie-breaks and output formats are where hidden tests fail.
4. **Make old methods call new ones.** When a level adds a variant of every method, such as the database's timestamped twins, turn each earlier method into a one-line call to its new twin, so each rule is written once.
5. **Pass, then refactor**, before unlocking the next level.

Afterwards, compare with the worked answer (`backend/src/fs/file-store.ts` or `backend/src/kv/kv-store.ts`), and record your splits in [CLAUDE.md](./CLAUDE.md#practice-log).

## Tech Stack

- **Backend:** Node.js, Express, TypeScript, PostgreSQL 16 (`pg`), zod, pino, prom-client, vitest
- **Frontend:** React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS
- **Tests:** vitest (level suites, API, PostgreSQL races), Playwright (smoke tests)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (Option 1), or PostgreSQL 16 installed locally (Option 2). Neither is needed for practice mode or for `npm run dev:memory`

### Option 1: Docker Compose (recommended)

```bash
cd file-system
docker-compose up -d                 # PostgreSQL 16 on 5432

cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # 5 users, 25 files, 2 backups
npm run dev                          # API on http://localhost:3000

cd ../frontend
npm install
npm run dev                          # http://localhost:5173 (proxies /api to 3000)
```

Stop with `docker-compose down`; add `-v` to delete the data.

### Option 2: Native PostgreSQL (no Docker)

```bash
brew install postgresql@16
brew services start postgresql@16
createuser -s user
psql -d postgres -c "ALTER USER \"user\" WITH PASSWORD 'password'"
createdb -O user file_system
psql -U user -d file_system -c "SELECT 1"   # verify
```

Then run the same `backend` and `frontend` steps as Option 1.

### Option 3: No database at all

```bash
cd backend && npm install && npm run dev:memory
```

The API runs over the in-memory worked answer and loads the demo data on start. The header shows which store is in use.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | API port |
| `FS_STORE` | `postgres` | `postgres` or `memory` |
| `DATABASE_URL` | `postgresql://user:password@localhost:5432/file_system` | Development database |
| `TEST_DATABASE_URL` | `postgresql://user:password@localhost:5432/file_system_test` | Created on first use by `npm run test:pg` and `npm run bench`, and wiped by them |
| `LOG_LEVEL` | `info` | pino level |

### Running more instances

```bash
npm run dev:server1   # :3001
npm run dev:server2   # :3002
npm run dev:server3   # :3003
```

With PostgreSQL, every instance sees the same tree, and the placement and quota rules hold across instances because they are enforced in the database.

## Things to Try

1. **Hit a quota.** Open `/home/dmitri` and create a 2 MB file. The refusal names both amounts.
2. **Break the placement rules.** In `/home/dmitri`, create `readme.txt/inside`: "readme.txt is a file".
3. **Restore with a conflict.** On Users, restore alice. `/shared/roadmap.md` was hers at backup time but is bob's now, so it's skipped and listed. Her `thesis-final.pdf`, written after the backup, is gone, and `ideas.md` is back to its old size.
4. **Merge.** Merge `carol-archive` into `carol`, then check carol's capacity and `/archive`.
5. **Make a folder vanish.** Create `/home/bob/tmp/x`, open `/home/bob/tmp`, and delete `x`. Directories are implicit, so the folder disappears and the browser moves up to `/home/bob`.
6. **Reset** with "Reset demo data" on the Users page.

## API

```
GET    /api/v1/fs/list?path=/home/alice
GET    /api/v1/fs/largest?prefix=/home/&n=10
POST   /api/v1/fs/files                  { path, size, owner? }
PATCH  /api/v1/fs/files?path=…           { size }
DELETE /api/v1/fs/files?path=…
GET    /api/v1/users
POST   /api/v1/users                     { id, capacity }
POST   /api/v1/users/:id/merge           { sourceId }
POST   /api/v1/users/:id/backup
POST   /api/v1/users/:id/restore
POST   /api/v1/admin/reset
GET    /api/v1/info · /health · /ready · /metrics
```

Refusals are `409` with a code (`PATH_EXISTS`, `PATH_IS_DIRECTORY`, `PARENT_IS_FILE`, `OVER_CAPACITY`, `USER_EXISTS`), missing things are `404`, and malformed input is `422`. Details are in [architecture.md](./architecture.md#api-design).

## Development

```bash
cd backend
npm test             # level suites vs the worked answer, dedup, API (no database needed)
npm run test:pg      # level suites vs PostgreSQL + concurrency tests (needs PostgreSQL)
npm run bench        # write throughput with and without a shared directory
npm run dedup -- ~/Downloads   # the onsite variant against a real folder
npm run type-check && npm run lint

cd ../frontend
npm run build && npm run lint

cd ..                # smoke tests against a running stack
npx playwright test
```

Screenshots: `node scripts/screenshots.mjs --start file-system` from the repository root. Smoke tests are generated from the same config with `npm run generate-tests file-system`.

## Architecture Documentation

- [levels.md](./levels.md): the four-level practice spec (file store)
- [levels-db.md](./levels-db.md): the second four-level practice spec (key-value database)
- [architecture.md](./architecture.md): production design, schema, trade-offs, and the local implementation notes
- [system-design-answer-backend.md](./system-design-answer-backend.md), [frontend](./system-design-answer-frontend.md), [full-stack](./system-design-answer-fullstack.md): 45-minute interview answers
- [CLAUDE.md](./CLAUDE.md): how it was built, and the practice log

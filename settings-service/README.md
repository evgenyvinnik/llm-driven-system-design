# Design a Settings Service

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,528 |
| Source Files | 125 |
| .ts | 4,031 |
| .tsx | 1,539 |
| .md | 1,471 |
| .json | 174 |
| .js | 104 |

## Overview

An application already has a preferences screen. This project is everything behind it: persistence, APIs, validation and sync. It answers a candidate-reported OpenAI interview prompt (a supplied preferences UI, with the task of designing its APIs and server side; not verified, see [CLAUDE.md](./CLAUDE.md)). The system is deliberately small. Its value is a precise contract.

The interesting parts:

- **Effective values with a source.** Every read returns `{ value, source, locked }` per key: enforced org value > your value > org default > global default. An enforced value shadows your own choice without deleting it, and the response says so (`userValue`). When the admin lifts the policy, your value is back.
- **Per-key PATCH.** A JSON merge patch with `If-Match: "<revision>"`. Your phone and your laptop can change *different* settings from the same stale revision, and both succeed. A stale write to the *same* setting gets `409` with the value that won, who changed it, and the current document. It is never a silent last-write-wins.
- **Safe retries.** A PATCH sets values; writing a value that's already stored is a no-op `200`, even with an old revision. A retry after a lost response can't double-apply or falsely conflict.
- **Validation and catalog evolution.** Type, enum, range, length, time and time-zone formats. Unknown keys get `422` per field. Deprecated keys are accepted and ignored with a warning during a grace window, then rejected as `RETIRED`. New definitions appear for every existing user at once, with no backfill.
- **Sync.** BroadcastChannel between tabs, plus SSE events keyed by revision, fanned out across **two API instances** through Valkey pub/sub. A client applies a delta at revision N+1, ignores stale events, and refetches on a gap.
- **Lost responses on demand.** A dev chaos switch drops the next PATCH response after commit. The UI shows "outcome unknown → refetch → reconciled".

![Preferences](./screenshots/02-preferences.png)

| | |
|---|---|
| ![Two devices](./screenshots/04-two-devices.png) | ![Same-key conflict](./screenshots/05-same-key-conflict.png) |
| ![Lost response](./screenshots/06-lost-response.png) | ![Globex member, dark theme](./screenshots/03-preferences-globex-dark.png) |
| ![Org policy](./screenshots/07-org-policy.png) | ![Catalog](./screenshots/08-catalog.png) |

## Architecture

```
browser tabs ◀── BroadcastChannel ──▶ browser tabs        phone / laptop
      │ REST + SSE                         │                    │
      ▼                                    ▼                    ▼
   API instance A  ◀── Valkey pub/sub "ss:events" ──▶  API instance B
      │   resolve · validate · plan PATCH · SSE fan-out    │
      └──────────────────────┬─────────────────────────────┘
                             ▼
     PostgreSQL: setting_definitions · org_settings · user_settings
                 users.settings_revision · setting_changes
```

| Process | Default port | Command |
|---------|--------------|---------|
| API instance A | 3000 | `npm run dev:a` (both: `npm run dev`) |
| API instance B | 3001 | `npm run dev:b` |
| Frontend | 5173 | `cd frontend && npm run dev` (`/api` → A, `/api-b` → B) |

Details: [architecture.md](./architecture.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, ioredis, zod, pino, prom-client, bcryptjs; vitest + supertest
- **Frontend:** React 19, Vite, TanStack Router, Zustand, Tailwind CSS; vitest for the sync rules
- **Infrastructure:** PostgreSQL 16, Valkey 7 (sessions, chaos counter, pub/sub)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option 1) or Homebrew (Option 2)

### Option 1: Docker Compose (recommended)

```bash
cd settings-service
docker-compose up -d                 # PostgreSQL :5432 (settings/settings_password), Valkey :6379
                                     # other host ports: SETTINGS_PG_PORT=5442 SETTINGS_VALKEY_PORT=6389 docker-compose up -d
cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # 21 definitions, 2 orgs with policy, 7 users
npm run dev                          # API instances A (:3000) and B (:3001)

cd ../frontend                       # in another terminal
npm install
npm run dev                          # http://localhost:5173
```

`docker-compose down` stops the services; `docker-compose down -v` also deletes the data. Reseeding while the API runs is fine (the catalog cache refreshes within 30 s).

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey     # or: brew install redis
brew services start postgresql@16
brew services start valkey            # or: brew services start redis

# Create the role and database
psql postgres -c "CREATE ROLE settings LOGIN PASSWORD 'settings_password';"
psql postgres -c "CREATE DATABASE settings_service OWNER settings;"

# Verify
pg_isready -h localhost -p 5432
valkey-cli ping                       # or: redis-cli ping → PONG
```

Then run the backend and frontend steps from Option 1.

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://settings:settings_password@localhost:5432/settings_service` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `KEY_PREFIX` | `ss:` | Prefix for every Valkey key and channel |
| `PORT` / `INSTANCE_ID` | `3000` / `api-<port>` | API port and the name shown in responses and SSE |
| `PORT_A`, `PORT_B` | `3000`, `3001` | Ports used by `npm run dev` |
| `CHAOS_ENABLED` | `true` (unless `NODE_ENV=production`) | Mounts `/api/v1/dev/chaos` |
| `CATALOG_TTL_MS` | `30000` | How long an instance trusts its cached catalog |
| `DEFAULT_GRACE_DAYS` | `30` | Grace window when none is given |
| `PATCHES_PER_MINUTE` | `120` | Per-user write limit |
| `SETTINGS_PG_PORT`, `SETTINGS_VALKEY_PORT` (compose) | `5432`, `6379` | Host ports |
| `VITE_PORT`, `API_TARGET`, `API_TARGET_B` (frontend) | `5173`, `http://localhost:3000`, `http://localhost:3001` | Dev server port and the two proxy targets |

## Demo accounts

All passwords are `password123`.

| User | Org | Role | Shows |
|------|-----|------|-------|
| `alice` | Acme Corp | Member | Every source: own choices, Acme defaults, two enforced keys (one shadowing her own choice), org-only settings, a deprecated key |
| `bob`, `carol` | Acme Corp | Member | More override counts on the policy screen |
| `admin` | Acme Corp | Platform admin | Acme policy and the global catalog |
| `dave` | Globex | Member | German and Berlin org defaults, enforced online status, dark theme |
| `erin` | Globex | Member | |
| `grace` | Globex | Org admin | Globex policy only; can read the catalog but not change it |

## Things to try

| Where | Do | See |
|-------|----|-----|
| Two devices | Change Theme on the phone, Language on the laptop | Both survive; each log says "via SSE on api-b, written on api-a" |
| Two devices | Freeze the laptop, change Email digest on the phone, then on the laptop | 409: "Changed on Phone to Daily (r7) after this screen loaded r6", with Keep / Use mine |
| Two devices | Drop next response, then change any setting | "Response lost → refetched → found on the server, reconciled" |
| Two devices | Contract probes | Deprecated key (200 + warning), retired, unknown, out of range, locked |
| Org policy (`admin`) | Enforce Theme = Dark while alice has Preferences open | Her Theme row locks and the page turns dark without a reload; clear it and her own value is back |
| Catalog (`admin`) | Add a setting | Every open Preferences screen shows it with its default |
| Two tabs | Change anything in one | The other tab updates in the same frame (BroadcastChannel) |

## API

```bash
# Sign in and read the effective document (ETag = revision)
curl -c jar -H 'Content-Type: application/json' -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login
curl -b jar -i localhost:3000/api/v1/me/settings

# Set a value (If-Match = the revision you read); null resets to inherited
curl -b jar -X PATCH -H 'Content-Type: application/merge-patch+json' -H 'If-Match: "6"' \
  -d '{"appearance.theme":"dark","regional.language":null}' localhost:3001/api/v1/me/settings

# Per-field errors
curl -b jar -X PATCH -H 'Content-Type: application/json' -H 'If-Match: "8"' \
  -d '{"appearance.colour":"teal","appearance.font_scale":400,"privacy.read_receipts":false}' localhost:3000/api/v1/me/settings

# Live events (run in another terminal; writes on either instance show up)
curl -b jar -N localhost:3001/api/v1/events

# Lose the next PATCH response after commit
curl -b jar -X PUT -H 'Content-Type: application/json' -d '{"dropNextPatchResponses":1}' localhost:3000/api/v1/dev/chaos
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Development

```bash
# Backend
cd backend
npm run type-check && npm run lint && npm test     # 53 tests: resolution, PATCH planner, validation, HTTP contract

# Frontend
cd frontend
npm run type-check && npm run lint && npm test && npm run build   # 13 tests: client sync rules

# Screenshots and smoke tests (from the repository root, stack running)
node scripts/screenshots.mjs settings-service
npm run test:smoke settings-service
```

## Architecture Documentation

- [architecture.md](./architecture.md): production design, trade-offs and implementation notes
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): signal, development phases, decisions, repair log, open questions

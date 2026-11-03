# Design a Multi-Org Dashboard

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 11,429 |
| Source Files | 172 |
| .ts | 6,214 |
| .tsx | 2,634 |
| .md | 1,838 |
| .sql | 202 |
| .json | 178 |

## Overview

The console of a fictitious multi-tenant AI product, **Relay**, a platform for building customer-support agents. A user belongs to several organizations with a different role in each, features are switched on per organization and per role, and plans decide what an organization has paid for. Modules: agents, knowledge base, conversation history, analytics, a prompt library (behind a feature flag, the prompt-sharing variant), exports, billing and settings (members, invitations, share links, audit log, features).

The interesting parts are about access, not the screens:

- **Authorization in the API and inside every query.** Each org route declares an access rule, and a test fails if one doesn't. Queries filter by the org *and* by the projects the caller can access, so a resource from another org is simply "not found": `404`, never `403`.
- **One permission source.** The server returns a manifest per org (role, permissions, flags, entitlements, projects, version), computed by the same code that enforces access. The client's route guards, sidebar and buttons all read it.
- **Revocation that reaches open pages.** Membership, role and flag changes bump a version in the same transaction. The permission cache in Valkey is keyed by that version, writes always re-read PostgreSQL, and a per-tab event stream tells open tabs to refetch. A page the user just lost closes with an explanation; removing a member also revokes their share links, invitations and exports, and ends their sessions if it was their last org.
- **Org switching without mixing data.** The org ID is in the URL and in every cache key. Switching aborts the old org's requests and drops any response that arrives anyway.
- **History and exports at scale.** Cursor pagination over 8,500 seeded conversations, filters in the URL, a virtualized table, a deep-linkable detail pane, and exports as background jobs with progress and a completion notification.

See [architecture.md](./architecture.md) for the design and its trade-offs, and [CLAUDE.md](./CLAUDE.md) for how it was built. All organizations, people and conversations are invented.

## Screenshots

| | |
|---|---|
| ![Conversations with detail pane](./screenshots/04-conversation-detail.png) | ![Org switcher](./screenshots/05-org-switcher.png) |
| Filtered history with a deep-linked detail pane | One user, two orgs, a different role in each |
| ![Viewer in another org](./screenshots/06-viewer-in-other-org.png) | ![Forbidden deep link](./screenshots/07-forbidden-deep-link.png) |
| The same user as a viewer: fewer modules, no export | Deep link to a page the role can't see |
| ![Access changed while open](./screenshots/17-access-changed-while-open.png) | ![Preview as viewer](./screenshots/18-preview-as-viewer.png) |
| Demoted while the page was open: it closes and says why | Admin previewing the console as a viewer (read-only) |
| ![Prompt library](./screenshots/08-prompt-library.png) | ![Audit log](./screenshots/10-audit-log.png) |
| Prompt shared with roles and by revocable link | Audit log with before and after values |
| ![Export in progress](./screenshots/13-export-in-progress.png) | ![Org not found](./screenshots/16-org-not-found.png) |
| Background export: progress in the header | Unknown org or not a member: the same neutral page |

## Architecture

```
Browser (React) ──REST──▶ API ──▶ PostgreSQL (memberships, roles, flags, resources, audit, export jobs)
      ▲                    │  │
      └── SSE: one per tab ┘  └──▶ Valkey: sessions · permission cache (versioned) · pub/sub · rate limits
                                         ▲
                       progress events   │
                     Export worker ──────┘  claims jobs from PostgreSQL (SKIP LOCKED, lease, fencing)
```

| Service | Path | Role |
|---------|------|------|
| API | `backend/src/api/` | REST endpoints and the per-tab event stream; stateless apart from open streams |
| Export worker | `backend/src/worker/` | Claims export jobs, re-checks the creator's access, writes CSV in batches, reports progress |
| Shared | `backend/src/shared/` | Access model (`permissions.ts`), versioned cache (`access.ts`), the org route gate (`org-access.ts`), events, audit |
| Frontend | `frontend/src/` | Console: org-scoped cache and switching (`lib/`), manifest-driven guards (`components/access/`), modules (`routes/`) |

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, TanStack Query, TanStack Virtual, Zustand, Tailwind CSS
- **Backend:** Node.js, Express, TypeScript (tsx), zod, prom-client, Pino
- **Data:** PostgreSQL 16, Valkey 7 (sessions, cache, pub/sub, counters)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (Option 1), or PostgreSQL 16 and Valkey/Redis 7 installed natively (Option 2)

### Option 1: Docker Compose (recommended)

1. **Start PostgreSQL and Valkey:**
   ```bash
   cd multi-org-dashboard
   docker-compose up -d
   ```
   If ports 5432 or 6379 are taken by another project, move them: `POSTGRES_PORT=5442 VALKEY_PORT=6389 docker-compose up -d`, then set `DATABASE_URL` and `REDIS_URL` (below) to match.

2. **Install, migrate and seed the backend:**
   ```bash
   cd backend
   npm install
   npm run db:migrate
   npm run db:seed          # pass -- --reset to wipe and reseed
   ```

3. **Start the API and the export worker together:**
   ```bash
   npm run dev
   ```

4. **Start the frontend (new terminal):**
   ```bash
   cd frontend
   npm install
   npm run dev              # API_TARGET=http://localhost:3010 npm run dev if the API runs elsewhere
   ```

5. **Open http://localhost:5173** and sign in (password `password123` for everyone):

   | User | Lumen Outfitters (pro plan) | Harbor Health Co-op (starter plan) |
   |------|-----------------------------|------------------------------------|
   | `alice@example.com` | admin | viewer |
   | `ben@example.com` | editor (member of the restricted VIP project) | — |
   | `dev@example.com` | viewer | — |
   | `chloe@example.com` | — | admin |
   | `erin@example.com` | — | editor |

   The feature flag `prompt_library` is on in Lumen for admins and editors and off in Harbor. A demo share link is at `/share/demo-lumen-return-policy-link`, and a pending invitation for `farah@example.com` at `/invite/demo-lumen-invite-for-farah`.

Stop with `docker-compose down` (add `-v` to delete the data).

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey     # or: brew install redis
brew services start postgresql@16
brew services start valkey

createuser console
psql postgres -c "ALTER USER console PASSWORD 'console_password'"
createdb -O console multi_org_dashboard

psql -U console -d multi_org_dashboard -c 'SELECT 1'   # verify PostgreSQL
valkey-cli ping                                         # verify Valkey (or redis-cli ping)
```

Then follow steps 2-5 of Option 1.

### Environment variables

All have local defaults; set them only to override.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://console:console_password@localhost:5432/multi_org_dashboard` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `PORT` | `3000` | API port |
| `PERMISSION_CACHE_TTL_SECONDS` | `60` | Upper bound on staleness if a version bump fails to reach Valkey |
| `SSE_HEARTBEAT_MS` | `20000` | Stream heartbeat; each one re-checks the session and memberships |
| `WORKER_ID` / `WORKER_POLL_MS` / `WORKER_PORT` | `worker-<pid>` / `1000` / `3300` | Export worker identity, polling interval, and its own `/health` + `/metrics` port |
| `EXPORT_LEASE_SECONDS` / `EXPORT_MAX_ATTEMPTS` | `30` / `3` | Job lease and retries after a worker dies |
| `EXPORT_BATCH_SIZE` / `EXPORT_BATCH_DELAY_MS` | `250` / `120` | Rows per batch; the delay makes progress visible with seed-sized data |
| `EXPORT_DIR` | `backend/exports` | Where finished CSV files are written |
| `INVITATION_TTL_DAYS` | `7` | Invitation expiry |
| `API_TARGET` (frontend) | `http://localhost:3000` | Where Vite proxies `/api` |

### Running more instances

```bash
cd backend
npm run dev:server1      # extra API instances on :3001, :3002, :3003
npm run dev:server2
npm run dev:server3
npm run dev:worker2      # a second export worker (metrics on :3302): SKIP LOCKED keeps them apart
```

Every instance holds one Valkey subscription and routes events to its own open streams, so a change made through one instance reaches tabs connected to another.

## Things to try

Use two browsers (or a normal and a private window), one as `alice@example.com` and one as `ben@example.com`.

- **Switch orgs.** As Alice, filter Lumen's conversations, then switch to Harbor with the switcher: the filter is dropped, the role badge says Viewer, the sidebar shrinks and the accent turns violet.
- **Turn a feature off under someone.** Ben opens the Prompt library. Alice, in Settings → Features, unticks Editor and saves. Ben's page closes within a second with an explanation, and the sidebar entry disappears.
- **Demote mid-edit.** Ben opens an agent and types new instructions. Alice changes his role to Viewer in Settings → Members. Ben's form turns read-only and keeps his text.
- **Remove a member.** Alice removes Ben. His open page becomes "You no longer have access to Lumen Outfitters", his shared prompt link now answers 410, and since Lumen was his only org he is signed out.
- **Deep links.** As Alice, open `/orgs/org_harbor/billing` (role), `/orgs/org_harbor/prompts` (flag) and `/orgs/org_nope` (not a member). As Chloe, open `/orgs/org_harbor/exports` (plan). Each gets a different, specific page.
- **Preview.** As Alice in Lumen, choose View as → Viewer. The console becomes exactly what a viewer sees, read-only.
- **Export.** As Alice in Lumen, click Export CSV on Conversations and keep working: progress shows in the header and a toast offers the download.

The scripted version of all of this is `scripts/two-user-check.mjs` (see Development).

## API

Base path `/api/v1`. Full list and semantics in [architecture.md](./architecture.md#api-design).

```bash
# Sign in (cookie jar)
curl -c jar -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"password123"}' localhost:3000/api/v1/auth/login

# The manifest that drives the UI (note the X-Authz-Version header)
curl -i -b jar localhost:3000/api/v1/orgs/org_lumen/manifest

# Role vs plan vs membership
curl -b jar localhost:3000/api/v1/orgs/org_harbor/billing     # 403 FORBIDDEN (viewer)
curl -b jar localhost:3000/api/v1/orgs/org_harbor/exports     # 403 FORBIDDEN too: the role is checked before the plan
                                                              # (as chloe, Harbor's admin: 403 ENTITLEMENT_REQUIRED)
curl -b jar localhost:3000/api/v1/orgs/org_nope/manifest      # 404: not a member, existence not revealed

# History by cursor
curl -b jar 'localhost:3000/api/v1/orgs/org_lumen/conversations?status=escalated&limit=50'

# Start an export: one Idempotency-Key per click; repeating it returns the same job
curl -b jar -H 'Content-Type: application/json' -H 'Idempotency-Key: export-2026-11-02-a' \
  -d '{"kind":"conversations","filters":{"status":"escalated"}}' localhost:3000/api/v1/orgs/org_lumen/exports

# The tab's event stream
curl -N -b jar localhost:3000/api/v1/events
```

## Development

```bash
# Backend
cd backend
npm run type-check
npm run lint
npm test                   # vitest: access model over every role x plan x flag, org gate, cache, route inventory, event hub
npm run test:integration   # against the running PostgreSQL + Valkey: cross-org IDOR attempts, revocation, invitations (14 tests)

# Frontend
cd frontend
npm run type-check
npm run lint
npm run build
npm test                   # vitest: module decisions over every combination, org scope, query keys

# From the repository root, with the stack running and freshly seeded
node multi-org-dashboard/scripts/two-user-check.mjs http://localhost:5173   # mutates data: reseed afterwards
npm run screenshots multi-org-dashboard
npm run generate-tests multi-org-dashboard
```

Observability: `GET /metrics` on the API (permission cache hits/misses, authorization denials by code, open streams) and on the worker at :3300 (exports by outcome); `GET /health` on both and `GET /ready` on the API.

## Architecture Documentation

- [architecture.md](./architecture.md): production design, schema, API, trade-offs, and how the local build maps to it
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend-focused interview answer
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend-focused interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): iteration history and decisions made while building

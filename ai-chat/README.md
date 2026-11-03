# Design an AI Chat Client

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 9,417 |
| Source Files | 119 |
| .ts | 5,617 |
| .tsx | 1,867 |
| .md | 1,372 |
| .json | 185 |
| .js | 129 |

## Overview

A chat client for a streaming model, in the shape of ChatGPT or Claude.ai: conversations in a sidebar, answers that stream token by token, Stop, Regenerate, Edit, version navigation (‹ 2/3 ›), the same account on several devices at once, and recent conversations readable offline. The model is a local mock service, so everything runs offline and failure modes can be triggered on demand.

The parts worth studying:

- **An answer is a server-owned generation, not an HTTP response.** A POST creates it (idempotent per click) and an executor produces it into a replayable event log. You can refresh, lose the connection, switch conversations or open a second device mid-answer, and reattach to the same generation without starting a new one.
- **Client live state is keyed by generation ID.** Switching from conversation A to B mid-answer neither cancels A nor leaks A's tokens into B, and A's finished answer lands in A's history wherever you are.
- **Retry, regenerate and edit are different things.** A retry with the same key returns the same generation. Regenerate creates a sibling answer, and edit creates a new branch of the message tree.
- **Stop cancels backend work.** The executor aborts the model request; the partial answer is kept and marked as partial.
- **Model output is untrusted.** Markdown is rendered without any HTML path: raw HTML shows as text, only http(s)/mailto links survive, and images are never fetched.
- **Long histories and offline.** Path pagination, `@tanstack/react-virtual`, follow-scroll only at the bottom, and a per-user IndexedDB cache that is deleted on sign-out.

See [architecture.md](./architecture.md) for the production design and trade-offs, [system-design-answer-frontend.md](./system-design-answer-frontend.md) for the interview answer (including the desktop and assistant-sidebar variants), and [CLAUDE.md](./CLAUDE.md) for how it was built.

## Screenshots

| | |
|---|---|
| ![Streaming answer](./screenshots/06-streaming.png) | ![Branches](./screenshots/03-branches.png) |
| An answer streaming: Stop replaces Send, the sidebar shows it in progress | Answer 3 of 3 after two regenerations, on an edited branch |
| ![Hostile markup rendered inert](./screenshots/05-untrusted-html-inert.png) | ![Failed answer](./screenshots/07-failed-partial-answer.png) |
| Model output containing `<script>`, `onerror`, a `javascript:` link and a tracking image, all inert | A mid-stream model failure: partial answer kept, error shown |
| ![Code and tables](./screenshots/04-code-and-tables.png) | ![Operator dashboard](./screenshots/09-operator-dashboard.png) |
| Code fences and GFM tables | Generation health and the failure/latency knobs |

## Architecture

```
Browser ── REST + SSE ──▶ API (stateless, 3000) ──▶ PostgreSQL (conversations, message tree, generations)
   ▲                          │  ▲                       ▲
   │ device sync (SSE)        │  │ XREAD from Last-Event-ID │ claim / checkpoint / finalize
   │                          ▼  │                       │
   └──────────────────────── Valkey: gen:{id}:events, queue, user:{id} pub/sub, sessions
                                 ▲
                                 │ XADD deltas every 50 ms
                       Executor (3200) ── streaming HTTP (abortable) ──▶ Mock model (3100)
```

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS, `marked` (lexer only), `@tanstack/react-virtual`, `idb`
- **Backend:** Node.js, Express, TypeScript (tsx), PostgreSQL 16, Valkey 7 (streams, pub/sub, sessions), opossum, prom-client, pino, zod
- **Testing:** vitest (backend and frontend), Playwright smoke tests

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop, or PostgreSQL 16 and Valkey/Redis installed natively

### Option 1: Docker Compose (recommended)

```bash
cd ai-chat
docker-compose up -d            # PostgreSQL on 5432, Valkey on 6379

cd backend
npm install
npm run db:migrate
npm run db:seed                 # resets chat data; users alice, bob, admin (password123)
npm run dev                     # API 3000, executor 3200, mock model 3100

cd ../frontend
npm install
npm run dev                     # http://localhost:5173
```

If 5432 or 6379 is already taken by another project, move the host ports:

```bash
AI_CHAT_PG_PORT=5462 AI_CHAT_VALKEY_PORT=6409 docker-compose up -d
export DATABASE_URL=postgresql://aichat:aichat_password@localhost:5462/ai_chat REDIS_URL=redis://localhost:6409
PORT=3030 MODEL_PORT=3130 EXECUTOR_PORT=3230 npm run dev          # backend
API_PROXY_TARGET=http://localhost:3030 npx vite --port 5193      # frontend
```

Stop with `docker-compose down` (add `-v` to delete the data).

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey

psql postgres -c "CREATE USER aichat WITH PASSWORD 'aichat_password';"
psql postgres -c "CREATE DATABASE ai_chat OWNER aichat;"
valkey-cli ping                 # PONG
```

Then run the backend and frontend steps from Option 1.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://aichat:aichat_password@localhost:5432/ai_chat` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey |
| `PORT` / `EXECUTOR_PORT` / `MODEL_PORT` | 3000 / 3200 / 3100 | Service ports |
| `MODEL_BASE_URL` | `http://localhost:$MODEL_PORT` | Where the executor finds the model |
| `MAX_ACTIVE_GENERATIONS_PER_USER` | 4 | In-flight answers per user |
| `GENERATIONS_PER_MINUTE_PER_USER` | 30 | Rate limit |
| `CHECKPOINT_INTERVAL_MS` | 2000 | How often partial output is written to PostgreSQL |
| `GENERATION_LEASE_SECONDS` | 15 | Executor lease |
| `EVENT_STREAM_TTL_SECONDS` | 3600 | How long the live log is kept after an answer ends |
| `API_PROXY_TARGET` (frontend) | `http://localhost:3000` | Vite proxy target |

### Running more instances

```bash
npm run dev:server1             # second API on 3001 (streams resume on any instance)
npm run dev:executor2           # second executor; they coordinate through PostgreSQL leases
```

## Things to try

1. **Switch mid-answer.** Ask something in one chat, click another conversation while it streams. Nothing leaks; a toast and a dot tell you when the first answer finished.
2. **Refresh mid-answer.** The page reloads the checkpoint and resumes the stream right after it.
3. **Stop.** The model's active-slot count on the operator dashboard drops to 0; the partial answer stays, marked "Stopped".
4. **Regenerate and edit.** Watch ‹ 1/2 › appear; flip between versions, then reload: the branch you chose is remembered.
5. **Two devices.** Open the same chat in two windows and send from one: the other shows the answer as it streams. Send from both at once: one gets "An answer is already being written".
6. **Flaky network.** On the operator dashboard (sign in as `admin`) set "Drop browser streams after N events" to 5, and the client silently reconnects with `Last-Event-ID`. Set "Model disconnect rate" or "Failure rate" to 1 to see failed answers keep their partial text.
7. **Offline.** Open a few conversations, stop the backend, reload: the sidebar and those conversations open read-only from IndexedDB.
8. **Hostile output.** Ask "How do I prevent XSS in model output?"; the mock model answers with markup that must render inert.

## API

```bash
# Sign in (cookie jar)
curl -c jar -H 'Content-Type: application/json' -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login

# New chat: one Idempotency-Key per click; repeating it returns the same generation (200)
curl -b jar -H 'Content-Type: application/json' -H 'Idempotency-Key: click-1' \
  -d '{"content":"Explain how tides work"}' localhost:3000/api/v1/conversations

# Follow the answer; resume after a disconnect with Last-Event-ID
curl -N -b jar localhost:3000/api/v1/generations/<generationId>/events
curl -N -b jar -H 'Last-Event-ID: <last id seen>' localhost:3000/api/v1/generations/<generationId>/events

# Stop it
curl -b jar -X POST localhost:3000/api/v1/generations/<generationId>/cancel
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Development

```bash
# Backend
cd backend
npm run test                    # vitest
npm run type-check
npm run lint

# Frontend
cd frontend
npm run test                    # vitest: renderer safety, generation store
npm run build                   # tsc -b && vite build
npm run lint

# Screenshots and smoke tests (from the repository root, stack running)
npm run screenshots ai-chat
npm run test:smoke ai-chat
```

## Architecture Documentation

- [architecture.md](./architecture.md): production design, schema, API, trade-offs, local implementation notes
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer (with desktop and assistant-sidebar variants)
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): build log, decisions and open questions

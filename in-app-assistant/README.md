# Design an In-App Assistant

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 13,035 |
| Source Files | 168 |
| .ts | 8,763 |
| .tsx | 1,835 |
| .md | 1,767 |
| .sql | 306 |
| .json | 180 |

## Overview

Gmail, Docs, Maps, Word and Excel are all adding an LLM chat panel that does things in the app from natural language. They mostly follow one blueprint: the model is wired into operations the app already has (mail search, a drafts API, a document command API), and the new part is a server-side layer that turns a request into calls to those operations and turns the results back into text and UI.

This project builds that layer for **Lumen Workspace**, a small mail, docs and calendar suite. The assistant panel sits beside each app. Ask *"Add a short summary of Dana's thread from last week under the intro"* and it searches your mail, reads the thread, and inserts a tracked suggestion under the Introduction heading, with citations that open the real emails.

The interesting parts are around the model:

- **An agent loop that is bounded and resilient.** Step, token and time budgets with a final "here's what I did and what's left" call; retries, a fallback model, a stream that dies halfway, max_tokens on text or on a tool call, invented tool names, invalid arguments, and repeated calls are all handled.
- **A turn is a saved state machine.** Waiting for your confirmation or for the browser frees the server; whichever API instance receives the answer resumes the turn. Kill an instance mid-turn and another one finishes it, without doing any write twice.
- **Safety enforced in code.** A policy engine allows, confirms or denies every tool call by its effect (read, write, send), reversibility, your settings and taint: once the assistant has read an external email, sending anything outside the org needs your confirmation. The mock model can be made gullible enough to obey instructions inside an email, so you can watch the policy engine catch it.
- **Grounded answers you can check.** An indexing pipeline with ACLs, hybrid keyword + vector search with the permission filter inside the query, fusion and reranking, mail from ten seconds ago still findable, and citations that must resolve to items actually retrieved.
- **Act as you, with your permissions.** Tools derive the user from an on-behalf-of token, never from arguments, and the host app's own visibility rules decide what comes back.

See [architecture.md](./architecture.md) for the design and its trade-offs, and [CLAUDE.md](./CLAUDE.md) for how it was built and what broke along the way.

## Architecture

```
Browser (React, :5173)
  Mail · Docs · Calendar ──REST──▶ API (:3000) ──▶ PostgreSQL + pgvector
  Assistant panel ◀──SSE (resumable)──┤ agent loop    host data · turns · steps · index · outbox
  client tools (selection, open) ─────┤ policy, tools        ▲
                                      │ sweeper              │ outbox events
                                      ├──▶ Valkey: turn event streams · sessions · limits · cancel
                                      └──Anthropic SDK──▶ Mock model (:3100, Messages API format)
                                                          or Claude when ANTHROPIC_API_KEY is set
                           Indexer (:3200): clean · chunk · embed · ACL ──▶ chunks
```

| Process | Path | Role |
|---------|------|------|
| API | `backend/src/api/` | Host app REST, assistant endpoints, SSE turn streams |
| Orchestrator | `backend/src/orchestrator/` | Agent loop, model client, policy engine, context assembly, prefetch, suspension/resume, sweeper (runs inside each API instance) |
| Tools | `backend/src/tools/` | 13 typed tools over mail, docs and calendar, validation, result shaping, idempotent execution |
| Retrieval | `backend/src/retrieval/` | Cleaning, chunking, mock embeddings, hybrid search, fusion and rerank |
| Indexer | `backend/src/indexer/` | Transactional-outbox consumer with priority lanes; backfill |
| Mock model | `backend/src/model/` | Deterministic planner behind a Messages API wire format, prompt cache simulation, failure switches |
| Eval | `backend/src/eval/` | Scenario suite replayed through the real orchestrator |
| Frontend | `frontend/src/` | The suite, the assistant panel, settings and the operations dashboard |

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS
- **Backend:** Node.js, Express, TypeScript (tsx), `@anthropic-ai/sdk`, Ajv, zod, prom-client, Pino
- **Data:** PostgreSQL 16 with pgvector, Valkey 7 (Streams, pub/sub, counters)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (Option 1), or PostgreSQL 16 with the pgvector extension and Valkey/Redis 7 installed natively (Option 2)

### Option 1: Docker Compose (recommended)

1. **Start PostgreSQL (with pgvector) and Valkey:**
   ```bash
   cd in-app-assistant
   docker-compose up -d
   ```

2. **Install, migrate and seed the backend:**
   ```bash
   cd backend
   npm install
   npm run db:migrate
   npm run db:seed          # rerunnable: wipes and reseeds, dates are relative to today
   ```

3. **Start the API, mock model and indexer together:**
   ```bash
   npm run dev
   ```

4. **Start the frontend (new terminal):**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

5. **Open http://localhost:5173** and sign in:

   | User | Password | Notes |
   |------|----------|-------|
   | `alice` | `password123` | Admin (Ops dashboard); owns the offsite plan; on Dana's budget thread |
   | `bob` | `password123` | Engineer; has a private doc and a thread with Dana that Alice can't see |
   | `dana` | `password123` | Finance; owns the FY26 forecast, shared with leads as view-only |

Stop with `docker-compose down` (add `-v` to delete the data).

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 pgvector valkey     # or: brew install redis
brew services start postgresql@16
brew services start valkey

createuser assistant
psql postgres -c "ALTER USER assistant PASSWORD 'assistant_password'"
createdb -O assistant in_app_assistant
psql postgres -d in_app_assistant -c 'CREATE EXTENSION IF NOT EXISTS vector'   # as a superuser

psql -U assistant -d in_app_assistant -c 'SELECT 1'   # verify PostgreSQL
valkey-cli ping                                       # verify Valkey (or redis-cli ping)
```

Then follow steps 2-5 of Option 1.

### Using Claude instead of the mock model

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

The same code path runs against Claude: `claude-opus-5-5` for the loop (adaptive thinking, `medium` effort, server-side refusal fallbacks), `claude-sonnet-5-5` as the overload fallback and `claude-haiku-5-5` for query rewriting. Override with `MODEL_PRIMARY`, `MODEL_FALLBACK` and `MODEL_REWRITE`. Setup, tests, screenshots and evals never need a key.

### Environment variables

All have local defaults; set them only to override.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://assistant:assistant_password@localhost:5432/in_app_assistant` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `PORT` / `INSTANCE_ID` | `3000` / `api-<pid>` | API port and lease owner name |
| `MODEL_PORT` / `INDEXER_PORT` | `3100` / `3200` | Mock model and indexer ports |
| `ANTHROPIC_API_KEY` | unset | Use Claude instead of the mock |
| `MODEL_PRIMARY` / `MODEL_FALLBACK` / `MODEL_REWRITE` | mock names, or Claude models with a key | Model routing |
| `MODEL_MAX_TOKENS` / `MODEL_ATTEMPTS` | `1024` (mock) / `3` | Per-call output cap; attempts on the primary before falling back |
| `TURN_MAX_STEPS` / `TURN_MAX_OUTPUT_TOKENS` / `TURN_DEADLINE_SECONDS` | `15` / `20000` / `120` | Turn budgets (the step limit is also a per-user setting) |
| `TURN_CONTEXT_BUDGET` / `TURN_HISTORY_BUDGET` / `TOOL_RESULT_MAX_TOKENS` | `12000` / `4000` / `2000` | Context trimming thresholds (kept small so trimming is visible) |
| `TURN_LEASE_SECONDS` / `TURN_HEARTBEAT_MS` / `TURN_SWEEP_INTERVAL_MS` | `30` / `10000` / `5000` | Turn ownership and recovery |
| `CLIENT_TOOL_TIMEOUT_SECONDS` / `CONFIRM_TIMEOUT_SECONDS` | `30` / `600` | Outcomes when the browser or the user doesn't answer |
| `INDEX_CONTENT_DELAY_MS` / `INDEX_POLL_MS` | `3000` / `500` | Simulated indexing latency for content (permission changes are never delayed) |
| `OBO_SECRET` | dev value | Signs on-behalf-of tokens |
| `MOCK_TTFT_MS` / `MOCK_TOKENS_PER_SECOND` / `MOCK_FOLLOW_INJECTIONS` | `350` / `80` / `true` | Mock model behavior at startup (also adjustable live on the Ops page) |

### Running more instances

```bash
cd backend
npm run dev:api          # API only on :3000
npm run dev:model        # mock model
npm run dev:indexer      # indexer
npm run dev:server1      # extra API instances on :3001 and :3002
npm run dev:server2
```

Turns live in PostgreSQL and their events in Valkey, so a turn started on one instance can be streamed, confirmed and resumed on another.

## Things to try

- **The headline request.** Open Docs → Q3 Offsite Plan and click *"Add a short summary of Dana's thread from last week under the intro."* Watch the tool rows, then Keep or Undo the suggestion. "What I did" under the answer shows every model call, tool call and policy decision.
- **Prompt injection.** In Mail, ask *"Summarize the latest email from Northwind."* The invoice email contains instructions for AI assistants. The (deliberately gullible) mock model drafts a forward to an outside address; the policy engine stops it with an amber confirmation card. Decline it. Then turn on *Block sending outside my organization after reading outside content* in Settings and try again: the send is denied outright.
- **Draft, then send.** *"Draft a reply to Dana's budget email saying the $48,000 total works for us"*, then *"Send it."* The send always asks.
- **Browser tools.** In a doc, click a paragraph to select it and ask *"Rewrite the selected paragraph to be more concise."* The server asks the browser for the live selection.
- **Hybrid search.** *"Did anything change with my travel plans?"* finds the itinerary email that shares no keywords with the question.
- **Permissions.** As Alice, ask about salary bands: Bob's thread with Dana never appears. In Docs, *"Add a note to the FY26 forecast that offsite spend is $48,000"* fails with "you can view but not edit". Share a doc with Bob and watch the index's permissions lane on the Ops page.
- **Freshness.** Compose an email to yourself and immediately ask about it; it's found before the indexer picks it up.
- **Template vs agent.** Open an email and click *Summarize thread*: one model call, no tools.
- **Budgets.** Set the step limit to 3 in Settings and ask *"Find every email about the offsite and summarize each one."*
- **Break things on purpose.** On the Ops page, arm failures on the mock model (overloads → fallback model, a dropped stream, max_tokens cutoffs, an invented tool name, invalid arguments, a loop, a refusal) and run a request.
- **Kill an instance.** Start `npm run dev:server1`, start a turn against :3001 (for example with `curl`), and kill that process mid-turn. Within about 30 seconds the :3000 instance's sweeper takes it over and finishes it.

## API

Base path `/api/v1`. Full list and semantics in [architecture.md](./architecture.md#api-design).

```bash
# Sign in (cookie jar)
curl -c jar -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login

# Start a turn: one Idempotency-Key per submit; repeating it returns the same turn
curl -b jar -H 'Content-Type: application/json' -H 'Idempotency-Key: 6f1d…' \
  -d '{"app":"mail","text":"What did Dana say about the budget?","clientContext":{}}' \
  localhost:3000/api/v1/assistant/turns

# Follow it; resume after a disconnect with Last-Event-ID
curl -N -b jar localhost:3000/api/v1/assistant/turns/<turnId>/events

# Answer a confirmation card, or stop the turn
curl -b jar -X POST localhost:3000/api/v1/assistant/actions/<actionId>/decline
curl -b jar -X POST localhost:3000/api/v1/assistant/turns/<turnId>/cancel
```

## Development

```bash
# Backend
cd backend
npm run type-check
npm run lint
npm test                 # vitest: policy, context assembly, citations, tools, retrieval, mock planner
npm run eval             # 10 scenarios through the real orchestrator (stack running)

# Frontend
cd frontend
npm run type-check
npm run lint
npm run build
npm test                 # vitest: SSE parser, safe markdown rendering (no HTML, no model-written links)

# Screenshots and smoke tests (from the repository root, stack running)
npm run screenshots in-app-assistant
npm run generate-tests in-app-assistant
```

Observability: `GET /metrics` on the API (:3000), mock model (:3100) and indexer (:3200); `GET /health` and `GET /ready` on the API; the Ops page in the app.

## Architecture Documentation

- [architecture.md](./architecture.md): production design, schema, API, trade-offs, and how the local build maps to it
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend-focused interview answer
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend-focused interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): iteration history and decisions made while building

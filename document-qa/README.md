# Design Document Q&A

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 11,448 |
| Source Files | 168 |
| .ts | 7,063 |
| .tsx | 1,926 |
| .md | 1,731 |
| .sql | 277 |
| .json | 179 |

## Overview

Users upload documents to an assistant and ask questions about them. The system extracts, chunks, embeds and indexes each document, answers with citations that open the exact cited span, and supports new versions, sharing changes and deletion. It is a practice extension ([ROADMAP entry 8](../ROADMAP.md#8-document-qa)); see [CLAUDE.md](./CLAUDE.md).

The key question: **a document becomes inaccessible while its content still sits in the vector index or a cache. How does the design never return it?** The index and the caches are never the authority on access. PostgreSQL is.

- **Access enforced twice.**
  - The pgvector HNSW query and the full-text query filter by tenant and scope *inside* the search, using the index's copy of the metadata.
  - Every candidate is then re-checked against the source of truth in the same snapshot: not tombstoned, its version is current, and the asker can read it right now.
  - The index metadata is synced lazily by a job, and the session's group claims refresh every 5 minutes. The e2e pauses the sync and shows an unshare, and a removal from a group, taking effect on the very next question while the index still says "readable".
- **A cached answer never outlives access.** Each Valkey entry records every document in its prompt, with version and access epoch, and is validated for the reader on every read. Deleted, unshared, newer version or epoch moved: rejected. Past answers in history are redacted on read the same way.
- **Idempotent, redoable pipeline.**
  - RabbitMQ tickets point at leased `processing_jobs` rows, keyed by (version, stage).
  - Chunk ids derive from (version, ordinal), and every write is an upsert.
  - A fault switch kills a worker after it has written half a document's chunks. The other worker takes over the redelivered ticket and the supervisor restarts the dead one, with no duplicate chunks.
  - Three failures poison a job; the document goes `failed` with the reason and a Retry button. The embedder's 429s are absorbed inside the attempt.
- **Versions never mix.** A new version is indexed alongside the old one, then one pointer switches under a row lock, and the old chunks are retired 5 s later. The same-snapshot re-check drops chunks of any non-current version.
- **Delete: tombstone first, then a tracked purge.** The document vanishes at once. The purge removes cached answers, index rows, embeddings, chunks and every version's blob, showing "purged 4/5", retrying through a MinIO outage and recording the completion time.
- **Uploads dedupe safely.** An `Idempotency-Key` makes retries return the first response. The same bytes within a tenant return the existing document, but only if the uploader can read it, so dedupe never reveals a hidden document.
- **Answers are durable runs** (`queued → running → completed | cancelled | failed`) streamed over SSE from a per-run Valkey stream. They can be resumed with `Last-Event-ID` on either API instance and stopped from either. A mid-stream model failure keeps the partial output. Usage is recorded on every run.

![Library: stage pills, a failed upload with its reason, and purge progress](./screenshots/02-library.png)

| | |
|---|---|
| ![A citation opens the exact span](./screenshots/05-citation-highlight.png) | ![Re-check drops after an unshare; an earlier answer redacted](./screenshots/08-carol-not-found.png) |
| ![Streaming answer with citation chips and Stop](./screenshots/04-ask-streaming.png) | ![Operations: jobs by stage, purge backlog, fault switches](./screenshots/11-ops.png) |
| ![Versions: v2 current, v1 retired](./screenshots/06-document-versions.png) | ![A corrupt file, failed with its reason](./screenshots/07-document-failed.png) |

## Architecture

```
upload ──multipart + Idempotency-Key──▶ API ── one txn: document + version + extract job ──▶ PostgreSQL ◀── source of truth
            (×2 instances)               │  blob ──▶ MinIO (one key per version)                │
                                         │                                                       │ job rows = outbox
question ──▶ API: cache (validated) → embed → pre-filtered HNSW + FTS → RE-CHECK → mock model ─┤
             SSE from a Valkey stream, resumable on any instance                                ▼
                                                                         RabbitMQ quorum queue {jobId}
                                                                                     │
                         pipeline workers (supervised ×2) + sweeper ◀────────────────┘
                         extract → chunk → embed (mock embedder) → index (+ version switch)
                         retire · sync_acl (lazy index metadata) · purge (tracked per artifact)
```

| Process | Default port | Command |
|---------|--------------|---------|
| API | 3000 (second instance 3001) | `npm run dev:api`, `npm run dev:server1` |
| Pipeline workers (×2, restarted if they exit) | 3102, 3103 (metrics) | `npm run dev:workers` (single worker: `npm run dev:worker`) |
| Mock embedder | 3100 | `npm run dev:embedder` |
| Mock model (Messages API, SSE) | 3101 | `npm run dev:model` |
| Frontend | 5173 | `cd frontend && npm run dev` |

`npm run dev` in `backend/` starts all of them except the frontend. Details: [architecture.md](./architecture.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, amqplib, ioredis, minio, multer, zod, pino, prom-client, bcryptjs; vitest + supertest
- **Frontend:** React 19, Vite, TanStack Router, Zustand, Tailwind CSS
- **Infrastructure:** PostgreSQL 16 + pgvector 0.8 (HNSW, iterative scan), RabbitMQ 3.13 (quorum queue, management UI), Valkey 7, MinIO

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option 1) or Homebrew (Option 2)

### Option 1: Docker Compose (recommended)

```bash
cd document-qa
docker-compose up -d                 # PostgreSQL+pgvector :5432 (docqa/docqa_password), RabbitMQ :5672 + UI :15672 (guest/guest),
                                     # Valkey :6379, MinIO :9000 + console :9001 (minioadmin/minioadmin)
cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # orgs Acme + Globex, users, groups
npm run dev                          # 2 APIs, 2 supervised workers, mock embedder, mock model
npm run demo:story                   # in another terminal: uploads the sample corpus and drives every state

cd ../frontend                       # in another terminal
npm install
npm run dev                          # http://localhost:5173
```

RabbitMQ takes about a minute to accept connections on a fresh volume; the processes reconnect on their own. Host ports are overridable: `DOCQA_PG_PORT`, `DOCQA_AMQP_PORT`, `DOCQA_AMQP_MGMT_PORT`, `DOCQA_VALKEY_PORT`, `DOCQA_MINIO_PORT`, `DOCQA_MINIO_CONSOLE_PORT`. `docker-compose down` stops the services, and `docker-compose down -v` also deletes the data.

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 pgvector rabbitmq valkey minio/stable/minio   # or: brew install redis
brew services start postgresql@16
brew services start rabbitmq                    # management UI at http://localhost:15672 (guest/guest)
brew services start valkey                      # or: brew services start redis
minio server ~/minio-data --console-address :9001 &   # minioadmin / minioadmin

# Role and database (the migration runs CREATE EXTENSION vector)
psql postgres -c "CREATE ROLE docqa LOGIN PASSWORD 'docqa_password' SUPERUSER;"
psql postgres -c "CREATE DATABASE document_qa OWNER docqa;"

# Verify
pg_isready -h localhost -p 5432
rabbitmq-diagnostics -q ping
valkey-cli ping                                 # or: redis-cli ping → PONG
curl -s localhost:9000/minio/health/live -o /dev/null -w '%{http_code}\n'   # 200
```

The `docqa` role is a superuser locally only so the migration can create the `vector` extension. Alternatively run `CREATE EXTENSION vector;` once as an admin and drop `SUPERUSER`. The API creates the `docqa-documents` bucket on start. Then run the backend and frontend steps from Option 1. On Linux, install `postgresql-16` with `postgresql-16-pgvector`, `rabbitmq-server`, `redis-server` (or `valkey`) and the MinIO server binary.

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://docqa:docqa_password@localhost:5432/document_qa` | PostgreSQL |
| `RABBITMQ_URL` / `RABBITMQ_MGMT_URL` | `amqp://guest:guest@localhost:5672` / `http://guest:guest@localhost:15672` | Broker; queue depth for the ops page |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` | `localhost`, `9000`, `minioadmin`, `minioadmin`, `docqa-documents` | Object storage |
| `PORT` | `3000` | API port |
| `EMBEDDER_PORT` / `EMBEDDER_URL` | `3100` / derived | Mock embedder |
| `MODEL_PORT` / `MODEL_URL` | `3101` / derived | Mock model |
| `WORKER_COUNT`, `WORKER_BASE_PORT`, `WORKER_CONCURRENCY` | `2`, `3102`, `4` | Supervised workers, metrics ports, prefetch |
| `JOB_MAX_ATTEMPTS`, `JOB_LEASE_MS`, `JOB_BACKOFF_BASE_MS` / `JOB_BACKOFF_CAP_MS` | `3`, `15000`, `1000` / `15000` | Poison threshold, lease, retry backoff |
| `CHUNK_TOKENS`, `CHUNK_OVERLAP_TOKENS` | `120`, `24` | Chunk size and overlap (production: 512 / 64) |
| `RETIRE_DELAY_MS`, `ACL_SYNC_DELAY_MS` | `5000`, `3000` | Old-version retirement delay; lazy index-metadata sync delay |
| `CLAIMS_TTL_SECONDS` | `300` | How long session group claims are trusted for the pre-filter |
| `RETRIEVAL_CANDIDATES`, `CONTEXT_CHUNKS`, `MIN_SIMILARITY`, `HNSW_EF_SEARCH` | `24`, `5`, `0.2`, `80` | Retrieval tuning |
| `ANSWER_CACHE_TTL_SECONDS`, `RUN_LEASE_MS` | `600`, `15000` | Cache lifetime (validation, not the TTL, keeps it safe); dead-executor detection |
| `MOCK_TTFT_MS`, `MOCK_TOKENS_PER_SECOND`, `EMBED_LATENCY_MS` | `300`, `40`, `40` | Mock service defaults (changeable live from the ops page) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | unset, `claude-opus-5-5` | Optional real provider (official SDK, low effort, server-side refusal fallbacks) instead of the mock model |
| `VITE_PORT`, `API_TARGET` (frontend) | `5173`, `http://localhost:3000` | Dev server port and API proxy target |

## Demo accounts

All passwords are `password123`.

| User | Who | Sees |
|------|-----|------|
| `alice` | Acme Corp, org admin; Engineering + Finance | Her documents, org-wide ones, Engineering and Finance shares; manages groups |
| `carol` | Acme Corp, member; Engineering only | Org-wide and Engineering shares, her own; not Finance |
| `bob` | Globex Inc, org admin; Operations | Globex only; nothing of Acme's |
| `admin` | Platform operator | Ops page: queue, jobs, purge backlog, fault switches; never titles or text |

## Things to try

`npm run demo:story` leaves behind:

- ready documents (org-wide, group-shared, private), a corrupt file failed with its reason, and a document on v2 with v1 retired;
- a duplicate upload detected by content hash;
- answers with citations, Carol's "not found" for a Finance-only document, Bob's cross-tenant "not found";
- Carol's question right after an unshare with the metadata sync paused: "4 dropped by access re-check: private to its owner (index said readable)". Her earlier answer from that document is now redacted;
- one deletion fully purged, and one stuck at "purged 4/5" behind a simulated blob-store outage. It clears itself after ~40 failed blob calls (about 7 minutes), or set **Blob store outage** to 0 on the ops page.

From the UI you can also:

- drop files on the library, retry an upload (same key → same document), upload the same file again (duplicate notice);
- change sharing and watch "index metadata syncing (N stale index rows)";
- on **Operations**, arm **Kill worker mid-chunk** and upload a long Markdown file, then open its processing timeline: attempt 1 is shown as lost with "wrote 12/17 before exit" and attempt 2 succeeded;
- arm **Next N answer 500** = 3 on the embedder, upload, and watch the document fail; then click Retry;
- set **Hold version switch** to 8000 ms and upload a new version, then ask while both versions sit in the index;
- arm a **mid-stream disconnect** on the model, ask, and see "Failed · partial output kept"; press **Stop** on a slow answer (tokens per second = 4).

## API

```bash
# Sign in, upload (a retry with the same Idempotency-Key → same document, Idempotent-Replayed: true)
curl -c jar -H 'Content-Type: application/json' -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login
curl -b jar -H 'Idempotency-Key: upload-1' -F file=@backend/sample-corpus/acme/expense-policy.md localhost:3000/api/v1/documents

# Share org-wide, ask, stream (resume with -H 'Last-Event-ID: <id>', from either instance)
curl -b jar -X PATCH -H 'Content-Type: application/json' -d '{"scope":"org"}' localhost:3000/api/v1/documents/<doc_id>/sharing
curl -b jar -H 'Content-Type: application/json' -d '{"question":"How long do I have to submit expense receipts?"}' localhost:3000/api/v1/answers
curl -N -b jar localhost:3001/api/v1/answers/<run_id>/stream

# Delete: gone at once (404), then watch the purge
curl -b jar -X DELETE localhost:3000/api/v1/documents/<doc_id>
curl -b jar localhost:3000/api/v1/documents/deleted
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Development

```bash
# Backend
cd backend
npm run type-check && npm run lint && npm test     # 69 tests: chunk offsets, extraction, embedder, access rule, re-check,
                                                   # cache validation, stage redo + version switch, 429 retries, citations, API
# Frontend
cd frontend
npm run type-check && npm run lint && npm run build

# Screenshots and smoke tests (from the repository root, stack running, after `npm run demo:story`)
node scripts/screenshots.mjs document-qa
npm run test:smoke document-qa
```

## Architecture Documentation

- [architecture.md](./architecture.md): production design, trade-offs, failure handling and implementation notes
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): signal, development phases, decisions, repair log, open questions

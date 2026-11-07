# Document Q&A - Development with Claude

## Project Context

**Prompt.** Users upload documents to an assistant. The system extracts, chunks, embeds and indexes them, uses them to answer questions with citations, and supports deletion ([ROADMAP entry 8](../ROADMAP.md#8-document-qa)).

**Signal.** Practice extension: no attributed interview source.

**The key question:** a document becomes inaccessible (deleted, unshared, user removed from a group) while its content still sits in the vector index or a cache. How does the design never return it? **The trap** is treating the index as the authority on access, or treating retrieval-augmented generation as a black box. Neither the docs nor the code does either. The index carries a lazily synced copy of tenant/scope used only as a pre-filter. Every candidate chunk is re-checked against PostgreSQL in the same snapshot, and every cached answer is validated per reader on read. The e2e suite proves revocation is immediate *while* the index and the session claims are deliberately stale.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed when it ran, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| API | 3000 (+3001 via `dev:server1`) | `backend/src/api/index.ts` | Upload, library, sharing, groups, answer runs (executes them), SSE from Valkey streams, ops |
| Pipeline workers ×2 | 3102, 3103 (metrics) | `backend/src/worker/supervisor.ts` → `worker/index.ts` | Supervisor restarts a worker that exits; each worker also runs the sweeper |
| Mock embedder | 3100 | `backend/src/embedder/index.ts` | Deterministic 256-dim hashed bag of terms; latency, failure rate, armed 429/500 |
| Mock model | 3101 | `backend/src/model/index.ts` | Messages-API SSE; extractive answers with `[n]`; TTFT, tps, slots, armed 529/500/mid-stream disconnect |
| Frontend | 5173 | `frontend/` | `VITE_PORT`, `API_TARGET` |
| PostgreSQL 16 + pgvector 0.8.5 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |
| RabbitMQ 3.13 | 5672 / 15672 | — | Quorum queue `docqa.pipeline` (+ `.poison`), tickets `{jobId}` |
| Valkey 7 | 6379 | — | Sessions, answer cache + per-document reverse index, run event streams, cancel channel; named `redis` in compose for the repo scripts |
| MinIO | 9000 / 9001 | — | Bucket `docqa-documents`, one object per version |

Every host port in `docker-compose.yml` is overridable (`DOCQA_PG_PORT`, `DOCQA_AMQP_PORT`, `DOCQA_AMQP_MGMT_PORT`, `DOCQA_VALKEY_PORT`, `DOCQA_MINIO_PORT`, `DOCQA_MINIO_CONSOLE_PORT`).

## Development Phases

1. **Brief and design.** Read the roadmap entry, the shared LLM decisions and the checklist. The exemplars were webhook-platform (queue/lease patterns, `superviseRabbit`), in-app-assistant (pgvector, mock model in Messages-API format, armed chaos counts) and llm-inference-api (durable runs, Valkey-stream SSE). The design was settled before any code: ticket = pointer to a job row, derived chunk ids, index rows as a copy, same-snapshot re-check, answer cache validated on read, tombstone + per-artifact purge.
2. **Pure core with tests first:** chunker with offsets, HTML/Markdown extraction and corrupt-input detection, deterministic embedder, access rule, re-check, cache validation, citations, RRF fusion, the stage cores (chunk write, embed resume, activation decision) against in-memory stores. 62 tests, then 7 supertest API tests.
3. **Schema, jobs, stages, worker, sweeper, API, mock services.** The pipeline and a question with citations worked on the first live run.
4. **Frontend**, built by a forked agent in parallel from the API contract while the backend got its tests, demo story and e2e. Library, document page with highlight, chat with fetch-SSE and reconnect, groups, ops.
5. **Live e2e suite** (scratch, not committed): 15 sections and 95 checks against the real processes. The first run passed 87; the repair log below is what the rest found.
6. **Docs.** architecture.md and the backend answer by hand. The frontend and full-stack answers were written by subagents from architecture.md and the code, then checked for the no-code rule and length. The frontend answer's author found five real client defects while reading the code; all were fixed (repair log 7).
7. **Demo story, screenshots, smoke tests, SLOC.**

## Key Implementation Decisions (and why)

- **One rule module for access** (`shared/access.ts`): the pure `accessDecision` and the same rule as SQL (`readableSql`). Everything that serves content uses one or the other: library, detail, text, chunks, re-check, cache validation, history redaction. One rule means one place to get wrong.
- **The index pre-filter uses session claims, on purpose.** Group ids are snapshotted in the session (refreshed every 5 min, like an ID token's groups claim) and used only to pre-filter. That makes "removed from a group, session still says otherwise" a real state the re-check must handle, instead of an untested one.
- **Re-check in the same `REPEATABLE READ` snapshot as the ANN query.** That gives one read of `current_version_id` per question, so no answer can mix versions even when the switch commits between the two queries.
- **Over-fetch 24 candidates for 5 slots.** During a version overlap, half the candidates of a document are the non-current version; after a revoke, stale rows also compete. Without over-fetch the re-check would starve answers.
- **Dedupe is visibility-scoped.** The same bytes as a document the uploader can't read become a new document; returning the hidden one would confirm its exact contents exist.
- **The cache context list holds every document in the prompt, not just the cited ones.** A real model can repeat uncited context.
- **Purge order: cache, index, embeddings, chunks, blobs.** The most exposed copies go first. Purge waits for live stage leases and verifies afterwards (re-marking stragglers), because a stage that read the document just before the tombstone could still write chunks.
- **Embedding store separate from the index.** It lets the index be rebuilt without re-billing, and keeps "embed" and "index" distinct, redoable stages.
- **429s are retried inside the embed attempt**, with the lease heartbeated. A throttling provider must not poison documents.
- **Answer runs execute on the accepting API instance**, with every event in a Valkey stream, so any instance can stream or resume. Cancel goes over pub/sub, and partial output is flushed by the heartbeat.
- **Kill-mid-chunk is a real `process.exit(1)`**, not a simulated throw. A real exit is the only honest test of "the ticket is unacked, the broker redelivers, the other worker takes over".
- **`purge_paused` (a legal-hold-like switch)** exists so the e2e can prove that cache rejection comes from validation and not from the purge winning a race.
- **The real provider uses the official Anthropic SDK** (`claude-opus-5-5` by default, low effort, server-side refusal fallbacks). The mock path stays plain fetch + SSE parsing against our own service, so the e2e exercises exactly the failure modes the mock can inject.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| `postgres:16` image | `pgvector/pgvector:pg16` | Needs the `vector` extension (HNSW, iterative scan) |
| One API instance | Two (`dev:server1`) | Demonstrates stream resume and cancel across instances |
| `concurrently` per worker | A tiny supervisor forking N workers | The chaos kill exits a worker for real; something has to restart it |
| Polling everywhere (webhook-platform) | Polling plus SSE only while an answer generates | Token streaming is the product; always-open streams stall the screenshot harness |
| Production timings | 1-15 s backoff, 5 s retire delay, 3 s metadata sync | Every story plays out live; all env vars |

## Iteration & Repair Log

Found by running the stack, in order:

1. **RabbitMQ answered `ping` a minute before AMQP worked** on a fresh volume, and the first container start failed reading `.erlang.cookie` (eacces) and was restarted by the next `compose up`. The supervised connections recovered on their own; `start.sh` now waits for both workers' `/ready`.
2. **The mock model cited heading lines** ("Backup and Retention Standard [1]"). Short lines without sentence punctuation are now skipped as headings.
3. **"What is the backup retention period?" returned the wrong sentence**, because `retention` sat in the same concept group as `backup`, collapsing the question to two terms. Removed it from the group, and worded the corpus sentence as a real policy would ("The retention period for nightly backups is 90 days").
4. **Chunks had no overlap with long sentences:** whole-sentence overlap of ~96 chars can't fit a 100-char sentence. Now the last sentence is repeated whenever it is shorter than half a chunk (unit-tested).
5. **Purge errors read "purge blobs: "** with an empty reason: Node's `AggregateError` for ECONNREFUSED on IPv4 and IPv6 has an empty `message`. Added `describeError` (message, inner error, or code), used for every job error. Also added 15 s timeouts on every blob call: without them, a half-dead MinIO could hang a stage forever while its heartbeat kept the lease alive.
6. **History check raced the purge.** The purge scrubs persisted answers within ~100 ms of the delete, so a run was sometimes scrubbed (empty text, no sources) before history redaction saw it, and then wasn't labelled. Scrubbed runs now carry the same "a source document was deleted" redaction.
7. **Client defects found by the frontend answer's author:**
   - `load()` on /ask replaced a still-streaming run with the server's heartbeat-flushed text, so deltas appended to stale text;
   - the SSE reader retried `401`/`404`;
   - a 404 was detected by message text;
   - history never refetched, so redaction never reached an open page;
   - document text re-polled every 5 s.

   All fixed, plus `Cache-Control: no-store` on every API response and a polite live region on the run status.
8. **Usage was missing on cancelled and failed runs.** They now record the prompt's estimated input tokens and the deltas actually streamed.
9. **Test bugs, not product bugs:**
   - two checks assumed every citation pointed at "this run's" document, but earlier runs' org-wide documents legitimately competed;
   - the cache-after-delete check raced the purge until `purge_paused` held it;
   - a stale session-claims check depended on how long the suite had run (re-login first).

## Open Questions

- **Presigned uploads** for large files (quarantine prefix, declared hash verified at extract, sweeper for abandoned uploads).
- **Per-tenant fairness** in ingestion: one queue serves everyone locally; a bulk import should not delay a single upload.
- **Embedding reuse across versions** keyed by chunk-text hash (most of a new version is unchanged text).
- **Cache sharing across users** by access fingerprint (groups + ownership) instead of user id.
- **Re-check against replicas:** requires an LSN wait past the latest access change; today it reads the primary.
- **PDF/Office extraction and OCR** behind the same extract stage, with page-level offsets for citations.
- **Index shards per tenant** and quantization once a single pgvector node stops fitting.
- **Multi-turn conversations:** prior turns become another context that must be validated like the cache.

## Verification Environment Notes

- **Ports used here:**
  - PostgreSQL 5442, RabbitMQ 5652/15652, Valkey 6389, MinIO 9010/9011;
  - APIs 3010/3011, mock embedder 3110, mock model 3111, workers 3112/3113 (`WORKER_BASE_PORT=3112`);
  - frontend 5174 proxied to 3010.

  The defaults follow the repo conventions, and everything is overridable.
- **Stop processes by port or by this project's unique path**, never by a generic name. The supervisor forks `worker/index.ts` children: kill the supervisor first, then the worker ports.
- **The build machine was a laptop on battery** with frequent DarkWake cycles. The e2e extends its waits by detected host stalls; it has no latency assertions, and correctness checks never rerun. The final run reported no stalls.
- **Unit tests:** 69 (backend), all passing; `type-check`, `lint` and `build` clean in backend and frontend.
- **E2E result:** 15 sections (upload, idempotency, dedupe, worker kill, poison/retry, corrupt files, citations + stream resume, cross-tenant, revoke with stale index and stale claims, cache vs delete/unshare, version switch, delete + purge through a real MinIO outage, Stop, mid-stream failure, embedder 429s). The final fresh-stack run passed **95/95**. Earlier runs: 87/91, then 94/95 (see the repair log).
- **Measured:**
  - 6.6 PostgreSQL row writes per chunk: 86 per 13-chunk document over 5 documents, `pg_stat_database` deltas read 12 s after the batch because stats flush lazily;
  - retrieval p50 51 ms / p95 66 ms over 24 questions;
  - the kill-mid-chunk run died at 12 of 17 chunks;
  - the held version switch produced seven v1 answers, then three v2.
- **Screenshots:** taken with `SCREENSHOT_FRONTEND_PORT=5174 node scripts/screenshots.mjs document-qa` (no `--start`) right after `npm run demo:story`, while the demo's simulated blob outage kept one purge at 4/5. All 11 are byte-distinct and were inspected.
- **Smoke tests:** `node scripts/generate-smoke-tests.mjs document-qa`, then run with WebKit through a `NODE_PATH` shim re-exporting `playwright/test` (the root has `playwright` 1.57 but not `@playwright/test`), `SMOKE_BASE_URL=http://localhost:5174`, `SKIP_WEBSERVER=1`: 11/11 passed.

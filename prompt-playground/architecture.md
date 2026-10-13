# Prompt Playground - Architecture

## System Overview

A prompt playground is the product built around an existing model API. Developers write a prompt, pick a model and its parameters, run it, watch the output stream in, compare configurations side by side, keep a version history, and share a result with a link. The model itself is assumed to exist. The design problem is the workflow around it: a data model that makes every result reproducible, and a run lifecycle that survives page refreshes, navigation, concurrent edits, retries, and crashed workers.

**Learning goals:**

- Separate mutable heads from immutable content: a prompt points at content-addressed snapshots, versions are numbered labels on snapshots, and every run pins the exact snapshot and a copy of its config
- Model a run as a durable state machine with leases and fencing, so exactly one outcome is ever recorded
- Make streaming resumable: a per-run event log that any server can replay from any offset (Valkey Streams + SSE `Last-Event-ID`)
- Use idempotency keys for run creation and optimistic concurrency for shared edits
- Draw the client-state boundaries: local draft vs saved versions vs live run state that outlives the page

The sections before **Implementation Notes** describe the proposed production system. Implementation Notes maps that design onto the local Docker + Node.js + React build, including what was simplified and what was left out.

## Requirements

### Functional Requirements

1. **Prompts**: each prompt in a workspace has a system message, a user message template with `{{variable}}` placeholders, a title and a description
2. **Drafts and versions**: edits are a draft that survives a refresh; saving creates an immutable, numbered version with a message; any version can be loaded and restored on top of the current head
3. **Runs**: choose a model, temperature, top-p and max tokens, fill in variables, and run; output streams token by token; a running run can be stopped
4. **Background runs**: several runs can be in flight at once; leaving the page does not cancel them; the user is told when one finishes
5. **Comparisons**: run the same prompt against two or three configs and view the outputs side by side
6. **History**: every run of a prompt is listed with the exact text, variables, config, usage and timings it used
7. **Presets**: workspace-shared model configs that two people can edit without silently overwriting each other
8. **Sharing**: a read-only link to one version or one finished run; links can be revoked; a recipient can copy the prompt into their own workspace
9. **Admin**: run volume and failure rate, latency split into queue time, time to first token (TTFT) and total duration, token usage per user, recent failures, live executors

### Non-Functional Requirements

| Requirement | Target (production) |
|-------------|---------------------|
| API availability | 99.9% (a developer tool; end-to-end availability is capped by the model provider) |
| Run acceptance (`POST /runs`) | p99 < 150 ms |
| Streaming overhead | a token reaches the browser within 100 ms (p95) of the model emitting it |
| Resume | a reconnecting client loses no tokens and never starts a duplicate generation |
| No silent loss | every accepted run ends visibly as completed, cancelled or failed |
| Reproducibility | a run's prompt text, variables and config never change after creation |
| Isolation | no reads across workspaces; a share link exposes only what it names |
| Retention | run records 90 days; live event logs 1 hour after a run ends |

**Out of scope:** model serving and inference infrastructure (see [LLM Inference API](../ROADMAP.md#5-llm-inference-api)), billing, evaluation datasets (see [LLM Eval Dashboard](../ROADMAP.md#10-llm-eval-dashboard)), and real-time co-editing of one draft.

## Capacity Estimation

### Production Scale

| Input | Value |
|-------|-------|
| Daily active developers | 100K |
| Runs per active developer per day | 20 |
| Runs per day | 2M (≈23 runs/s average, ≈120 runs/s at a 5× peak) |
| Average run | 1,500 input tokens (≈6 KB), 500 output tokens (≈2 KB), 10 s of streaming |

**Derived load:**

- **Concurrent generations at peak**: 120 runs/s × 10 s ≈ 1,200
- **Open SSE streams**: ≈1.5 viewers per run (tabs, comparisons, reconnects) ≈ 2,000
- **Event log appends**: deltas are batched every 50 ms, so ≈20 appends/s per run × 1,200 ≈ 24K XADD/s at peak. That is comfortable for a small Valkey cluster; batching is what keeps it there (per-token appends would be 4-5× higher)
- **PostgreSQL writes per run**: insert, claim, first-token timestamp, ~2 lease renewals, finalize ≈ 6 writes; at 120 runs/s ≈ 720 writes/s
- **Run storage**: ≈10 KB per run (rendered input, output, metadata) × 2M/day ≈ 20 GB/day, ≈1.8 TB at 90-day retention
- **Live event logs**: ≈83K runs finish per hour × ≈3 KB of deltas ≈ 250 MB resident with a 1-hour TTL
- **Snapshots and versions**: negligible; identical text is stored once per prompt

### Local Development Scale

| Component | Sizing |
|-----------|--------|
| Seed data | 3 users, 2 workspaces, 6 prompts with 1-3 versions, ~45 historic runs, 3 presets |
| Executor | 1 process, 8 concurrent runs (`EXECUTOR_CONCURRENCY`) |
| Mock model | 16 concurrent generations before it answers 429 |
| API | 1 instance on :3000 (`dev:server1..3` for 3001-3003) |

## High-Level Architecture

```
┌───────────────────┐         ┌──────────────────────────────────────────────────┐
│ Browser (React)   │  HTTPS  │              Load balancer / API gateway          │
│ • draft store     ├────────▶│  TLS · session cookie · per-user rate limits      │
│ • run store       │◀── SSE ─┤                                                  │
└───────────────────┘         └──────────┬────────────────────────┬──────────────┘
                                         │ REST                   │ GET /runs/:id/events
                              ┌──────────▼──────────┐   ┌─────────▼─────────────┐
                              │   Playground API    │   │    Stream service      │
                              │ prompts · versions  │   │ SSE fan-out, replays   │
                              │ runs · presets      │   │ a run's event log from │
                              │ shares · admin      │   │ any offset             │
                              └──┬───────────┬──────┘   └─────────┬─────────────┘
                     source of   │           │ enqueue run id      │ XREAD
                     truth       │           │                     │
                         ┌───────▼──────┐ ┌──▼───────────────────────────────────┐
                         │ PostgreSQL   │ │            Valkey cluster             │
                         │ primary +    │ │ run queue (stream + consumer group)   │
                         │ replicas     │ │ run event logs (one stream per run)   │
                         └───────▲──────┘ │ sessions · rate limits · cancel pub/sub│
                                 │        └──▲────────────────────────▲──────────┘
               claim · lease ·   │           │ pull run ids            │ append deltas,
               finalize          │           │                        │ end event
                         ┌───────┴───────────┴────────────────────────┴──────────┐
                         │                    Run executors (N)                   │
                         │ lease per run · heartbeat · cancel listener · sweeper  │
                         │ retry + circuit breaker in front of the model API      │
                         └──────────────────────────┬────────────────────────────┘
                                                    │ streaming HTTP
                                         ┌──────────▼───────────┐
                                         │  Model API (existing) │
                                         └───────────────────────┘
```

| Component | Responsibility |
|-----------|----------------|
| **Browser SPA** | Keeps the draft locally, follows run streams from an app-level store so they survive navigation, never re-submits a run to "reconnect" |
| **Playground API** | Stateless REST: validation, authorization in every query, idempotent run creation, optimistic concurrency |
| **Stream service** | Long-lived SSE connections, kept separate from request/response capacity in production; reads a run's event log from the client's last event ID |
| **Run executors** | The only callers of the model API. Each owns a run through a PostgreSQL lease, streams output into the event log, and records the single final outcome |
| **PostgreSQL** | Source of truth for prompts, versions, presets, shares and every run's final state |
| **Valkey** | Live event logs, the run queue, sessions, rate-limit counters, cancel signals. Losing it loses live progress, never an accepted run or a final result |
| **Model API** | External. Streams tokens; may be slow, overloaded (429) or fail partway |

## Core Components

### 1. Prompts, snapshots and versions

```
prompts ── mutable head: title, description, head_version
   │
   ├──▶ prompt_snapshots ── immutable, content-addressed: sha256(system, template)
   │          ▲     ▲
   │          │     └────────────── runs ── snapshot_id + copied config + variables
   │          │
   └──▶ prompt_versions ── v1, v2, v3 … append-only labels pointing at snapshots
```

The editor's text is never stored on the prompt row. A **snapshot** is the content address of one exact system + user message pair, unique per prompt. A **version** is a numbered, append-only label on a snapshot. A **run** points at the snapshot it executed and stores its own copy of the config and variable values.

This answers the interview follow-ups directly:

- *A prompt is edited while its previous version is running. Which text belongs to the result?* The run's snapshot, fixed at creation.
- *Can I run an unsaved draft?* Yes. The draft's text becomes (or reuses) a snapshot with no version. If the same text is saved later, the new version points at the same snapshot, and the run list shows "Draft · now v4". That label is computed at read time, so no run row is ever updated.
- *Two people save at once.* Versions are append-only, so nothing can be overwritten. The save carries `baseVersion` (the head the editor started from). If the head moved, the API returns `409 HEAD_MOVED` with the newer version, and the user chooses to load it or keep their edits on top. Saving text that is already the head is a no-op (`200`) even with a stale `baseVersion`, so a save retried after a lost response returns the version the first attempt created.

### 2. Run lifecycle

```
          POST /runs                      claim: UPDATE … WHERE status = 'queued'
 ─────────────▶ queued ───────────────────────────────────▶ running
                 │   │                                       │  │  │  │
  cancel (API)   │   │ no executor in 5 min (sweeper)        │  │  │  └─ model done ──────▶ completed
                 ▼   ▼                                       │  │  └──── model error/idle ─▶ failed
          cancelled   failed (QUEUE_TIMEOUT)                 │  └──── lease expired ─────▶ failed (EXECUTOR_LOST)
                                                             └─────── cancel signal ─────▶ cancelled (partial kept)
```

**Successful run, step by step:**

1. The user clicks Run. The browser generates an `Idempotency-Key` (one UUID per run per click) and sends `POST /api/v1/runs` with the text, variables, config and optional `comparisonId`.
2. The API checks whether this user already sent that key. If so, it returns the original run (200, `Idempotent-Replayed: true`) without applying limits again. Otherwise it authorizes against the workspace, renders the variables (`422 MISSING_VARIABLES` if any are missing), applies the rate limit (30 runs/min) and the active-run cap (6), upserts the snapshot, and inserts the run as `queued`. The insert uses `ON CONFLICT (created_by, idempotency_key) DO NOTHING`, so two concurrent retries create one row.
3. The API appends `status: queued` to the run's event log, adds the run ID to the work queue, and returns `202`.
4. The browser opens `GET /api/v1/runs/:id/events` (SSE).
5. An executor reads the run ID and **claims** it with a conditional update: `queued → running`, `attempt + 1`, a 15 s lease. A duplicate queue entry or an already-cancelled run matches zero rows and is dropped.
6. The executor calls the model and batches tokens into `delta` events every 50 ms. Every 5 s it renews the lease, conditioned on still owning the attempt, and checks the cancel flag.
7. When the model finishes, the executor writes the final status and output with `WHERE attempt = $a AND status = 'running'`, then appends an `end` event. The SSE handler forwards it and closes the connection.

**Failed run: the executor dies partway through:**

1. The lease expires 15 s after the last heartbeat.
2. Every executor runs a sweeper every 10 s. One of them wins the conditional update `running → failed (EXECUTOR_LOST)`, appends the `end` event (closing the log), then rebuilds the partial output from the log and stores it. Closing before reading makes the stored output exactly what viewers saw.
3. If the "dead" executor was only stalled (GC pause, network partition) and wakes up, it is fenced out three ways: its heartbeat matches zero rows and aborts the generation, its finalize matches zero rows, and its late delta appends are refused because the event log is closed.
4. The browser shows the partial output with "EXECUTOR_LOST". The run is **not** retried automatically. The user has already seen part of an answer, a retry would bill the tokens again, and with temperature > 0 it would produce a different answer. Running again is one click and creates a new run.

### 3. Streaming and resume

Each run has an append-only event log, `run:{id}:events`, stored as a Valkey stream. Event types:

| Event | Payload | Written by |
|-------|---------|------------|
| `status` | `queued` or `running`, attempt, timestamp | API, executor |
| `delta` | text appended since the previous delta | executor |
| `end` | final status, finish reason, error, usage (tokens, queue ms, TTFT, duration) | executor, sweeper, API (cancel while queued) |
| `snapshot` | the whole run from PostgreSQL | stream service, when the log has expired |

The stream entry ID is the SSE `id`. A client that reconnects sends `Last-Event-ID` and receives exactly the events after it. A new tab, or the same page after a refresh, starts from the beginning and rebuilds the output so far. Every API instance can serve every run because the log lives in Valkey, not in the process that started the run.

The first `end` closes the log for good. Appends go through a small Lua script that checks a `run:{id}:ended` flag and, for `end`, sets it atomically with the append. That gives two invariants: nothing is appended after the end, and a run has exactly one ending. (The `{id}` hash tag keeps both keys in one cluster slot.) An hour after the end, the log expires and readers get a single `snapshot` event built from PostgreSQL.

### 4. Cancellation

- **Queued run**: the API cancels it directly with a conditional update (`queued → cancelled`) and appends the `end` event. If an executor claims at the same moment, the row lock serializes the two, and the loser matches zero rows.
- **Running run**: the API sets `cancel_requested_at` and publishes the run ID on `runs:cancel`. The executor that owns the run aborts the HTTP request to the model, so the model stops generating and stops spending tokens. The executor then finalizes the run as `cancelled` with the partial output. The heartbeat's cancel-flag check catches a lost pub/sub message within 5 s.
- **Cancel racing completion**: whichever conditional update commits first is the outcome. The cancel endpoint answers `202` with the current state, and the final status arrives on the stream. The browser never lets an older REST copy move a run backwards (running after completed), because the stream's `end` can arrive before the cancel response.

### 5. Comparisons

A comparison is N independent runs sharing a `comparison_id`. Each run has its own idempotency key, executor and event log. If one is rejected (for example, by the active-run cap), the others still start and the UI reports "1 of 2 runs started". Adding comparisons needed no schema change beyond one nullable column, because runs already pinned their own config.

### 6. Client state

| State | Where it lives | Why |
|-------|----------------|-----|
| Draft text, variable values, configs | `localStorage`, one entry per prompt, with the head version it was based on | Survives refresh and navigation; it is not a version until saved |
| Saved prompt, versions, history | Fetched from the API | Shared with the workspace |
| Live runs | App-level store; each run's stream is followed outside React components | Runs keep streaming while the user edits another prompt; a toast links back when one finishes |
| Selected run or comparison | URL search parameter (`?run=`) | A refresh or a pasted URL reopens the same result |

On sign-in or refresh, the app fetches `GET /runs/active` and re-follows each run, so a refreshed tab picks up runs that are still streaming.

### 7. Presets and sharing

- **Presets** carry a `revision`. `PATCH` and `DELETE` need `If-Match: "<revision>"` (`428` without it). A stale revision gets `409 REVISION_CONFLICT` with the current preset, and the editor shows theirs next to yours with "Use theirs" or "Overwrite with mine" (a re-send against the new revision).
- **Share links** use a random 128-bit token and name exactly one immutable thing: a saved version or a *finished* run. `GET /shared/:token` needs no session, is rate-limited per IP, checks revocation on every request, and returns only that snapshot (and run). Fork copies the snapshot into the caller's workspace as a new prompt at v1.

## Database Schema

PostgreSQL (`backend/src/db/init.sql`):

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_workspace_members_user ON workspace_members (user_id);

CREATE TABLE prompts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description  TEXT NOT NULL DEFAULT '',
  head_version INT  NOT NULL DEFAULT 0 CHECK (head_version >= 0),  -- compared on save
  created_by   UUID NOT NULL REFERENCES users(id),
  updated_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prompts_workspace ON prompts (workspace_id, updated_at DESC);

CREATE TABLE prompt_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id     UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  content_hash  CHAR(64) NOT NULL,         -- sha256 of [system, template]
  system_text   TEXT NOT NULL,
  template_text TEXT NOT NULL,
  variables     TEXT[] NOT NULL DEFAULT '{}',
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, content_hash)
);

CREATE TABLE prompt_versions (
  prompt_id   UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version     INT  NOT NULL CHECK (version > 0),
  snapshot_id UUID NOT NULL REFERENCES prompt_snapshots(id),
  message     TEXT NOT NULL DEFAULT '',
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (prompt_id, version)
);
CREATE INDEX idx_prompt_versions_snapshot ON prompt_versions (snapshot_id);

CREATE TABLE model_presets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  config       JSONB NOT NULL,
  revision     INT  NOT NULL DEFAULT 1,    -- If-Match for edits
  created_by   UUID NOT NULL REFERENCES users(id),
  updated_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prompt_id           UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  snapshot_id         UUID NOT NULL REFERENCES prompt_snapshots(id),
  version             INT,              -- saved version matching at creation; NULL = draft
  comparison_id       UUID,             -- shared by side-by-side runs
  model               TEXT NOT NULL,
  config              JSONB NOT NULL,   -- copy, never a preset reference
  variables           JSONB NOT NULL DEFAULT '{}',
  rendered_system     TEXT NOT NULL,
  rendered_input      TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  output              TEXT NOT NULL DEFAULT '',
  output_truncated    BOOLEAN NOT NULL DEFAULT false,   -- partial output of a cancelled/failed run
  finish_reason       TEXT,
  error_code          TEXT,
  error_message       TEXT,
  input_tokens        INT,
  output_tokens       INT,
  attempt             INT NOT NULL DEFAULT 0,           -- fencing token
  lease_owner         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  created_by          UUID NOT NULL REFERENCES users(id),
  idempotency_key     TEXT NOT NULL,
  request_hash        CHAR(64) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- last doorbell, for re-enqueue
  started_at          TIMESTAMPTZ,
  first_token_at      TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  UNIQUE (created_by, idempotency_key)
);
CREATE INDEX idx_runs_prompt ON runs (prompt_id, created_at DESC);
CREATE INDEX idx_runs_created ON runs (created_at DESC);
CREATE INDEX idx_runs_active ON runs (status, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX idx_runs_user_active ON runs (created_by) WHERE status IN ('queued', 'running');
CREATE INDEX idx_runs_comparison ON runs (comparison_id) WHERE comparison_id IS NOT NULL;

CREATE TABLE shares (
  token        TEXT PRIMARY KEY,                 -- 128-bit random, base64url
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prompt_id    UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  snapshot_id  UUID NOT NULL REFERENCES prompt_snapshots(id),
  version      INT,
  run_id       UUID REFERENCES runs(id) ON DELETE CASCADE,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_shares_prompt ON shares (prompt_id, created_at DESC);
```

The partial indexes on `status IN ('queued', 'running')` stay small however large `runs` grows. The sweeper, the active-run cap and `/runs/active` only ever scan in-flight rows.

### Valkey keys

| Key | Type | Purpose | Lifetime |
|-----|------|---------|----------|
| `run:{id}:events` | Stream | A run's event log (status, delta, end) | 1 h after `end` |
| `run:{id}:ended` | String | Closed flag; appends are refused once set | 1 h |
| `runs:queue` | Stream + consumer group `executors` | Run IDs waiting for an executor (a doorbell, read with NOACK) | Trimmed to ~10K entries |
| `runs:cancel` | Pub/sub channel | Cancel signal to the owning executor | - |
| `session:{id}` | String (JSON) | Session user and workspace | 7 days |
| `ratelimit:{bucket}:{window}` | Counter | Fixed-window limits (runs, login, share views) | Window + 1 s |
| `executor:{id}` | String (JSON) | Executor heartbeat for the admin view | 15 s |

## API Design

All routes are under `/api/v1`. Errors are `{ "error": { "code", "message", "details" } }`.

```
POST   /auth/login                     → Session cookie + user
POST   /auth/logout                    → Ends the session
GET    /auth/me                        → Current user and workspace

GET    /models                         → Model catalog
GET    /prompts?q=                     → Workspace prompts with last run
POST   /prompts                        → Create (optionally with v1 text)
GET    /prompts/:id                    → Prompt, head version text, version list
PATCH  /prompts/:id                    → Rename / describe (last write wins)
GET    /prompts/:id/versions/:n        → One version's text
POST   /prompts/:id/versions           → Save next version (baseVersion → 409 HEAD_MOVED)
GET    /prompts/:id/runs?before=       → Run history page (no full output)

POST   /runs                           → Start a run (Idempotency-Key required) → 202 / 200 replay
GET    /runs/active                    → Caller's queued and running runs
GET    /runs/:id                       → Full run
POST   /runs/:id/cancel                → 200 if final, 202 while the executor stops it
GET    /runs/:id/events                → SSE: status, delta, end, snapshot (Last-Event-ID resume)
GET    /comparisons/:id                → All runs of a comparison

GET    /presets                        → Workspace presets
POST   /presets                        → Create (409 NAME_TAKEN)
PATCH  /presets/:id                    → Update (If-Match required → 428 / 409 REVISION_CONFLICT)
DELETE /presets/:id                    → Delete (If-Match required)

POST   /prompts/:id/shares             → Link to a version or a finished run
GET    /prompts/:id/shares             → Active links
DELETE /shares/:token                  → Revoke
GET    /shared/:token                  → Public read (410 when revoked)
POST   /shared/:token/fork             → Copy into the caller's workspace

GET    /admin/overview                 → 24 h run health (admin)
GET    /admin/model-settings           → Mock model knobs (admin, local only)
PUT    /admin/model-settings           → Change failure rate, latency, slots (admin, local only)
```

**Starting a run:**

```http
POST /api/v1/runs
Idempotency-Key: 6c0f2f0e-3f8b-4d4e-9a4e-0b6f0d3f2a11
Content-Type: application/json

{
  "promptId": "1cb1e90a-afe5-465e-9340-41331ff6e80e",
  "system": "You are a support triage assistant for {{product}}.",
  "template": "Ticket from a {{customer_tier}} customer:\n\n{{ticket}}",
  "variables": { "product": "Acme Billing", "customer_tier": "enterprise", "ticket": "Double charges on every seat" },
  "config": { "model": "sim-quality", "temperature": 0.7, "maxTokens": 512, "topP": 1 }
}

HTTP/1.1 202 Accepted
{ "run": { "id": "d307131c-…", "status": "queued", "version": 3, "savedVersion": 3, "comparisonId": null, … } }
```

The same request with the same key returns `200` with `Idempotent-Replayed: true` and the same run. The same key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`.

**The event stream:**

```
GET /api/v1/runs/d307131c-…/events
Last-Event-ID: 1791853769310-0

id: 1791853769361-0
event: delta
data: {"text":"Treat invoices as the primary "}

id: 1791853769941-0
event: end
data: {"status":"cancelled","outputTruncated":true,"finishReason":"cancelled","errorCode":null,
       "errorMessage":null,"usage":{"inputTokens":56,"outputTokens":60,"queueMs":3,"ttftMs":705,"durationMs":2652},
       "at":"2026-10-13T01:09:29.940Z"}
```

**Conflict on save:**

```json
HTTP/1.1 409 Conflict
{ "error": { "code": "HEAD_MOVED",
             "message": "Bob Martinez saved version 3 after you started editing",
             "details": { "head": { "version": 3, "message": "Ask for plain language", "system": "…", "template": "…" } } } }
```

## Key Design Decisions

### 1. Content-addressed snapshots with version labels

**Chosen:** store the text once as a snapshot keyed by its hash; versions and runs both point at snapshots.

**Why it works here:** the product has two kinds of "text that ran": deliberate saved versions, and quick experiments on an unsaved draft. Both need to be reproducible. Pointing runs at snapshots handles both with one foreign key, deduplicates repeated runs of the same text, and lets a draft run discover later that its text became v4 without updating the run.

**Why the alternatives fail:** creating a version for every run floods the history with hundreds of meaningless versions and makes "v12" useless as a label. Copying the full text onto every run works for reproducibility but loses the link to versions ("which runs used v3?" becomes a text comparison) and multiplies storage for long prompts run hundreds of times.

**Cost:** one more table and a hash on the write path, and "which version is this run?" becomes a read-time join (cheap with the `snapshot_id` index).

### 2. Executors own runs, not the HTTP request

**Chosen:** the API only records and enqueues a run. A separate executor calls the model and writes output to an event log that the browser reads.

**Why it works here:** a generation lasts 5-60 s, longer than a user stays on one page. If the API request handling `POST /runs` also streamed the model output, closing the tab, a proxy timeout or a deploy would kill the generation, and a reconnect would have to start a new one: a duplicate run and duplicate tokens. Decoupling makes "leave and come back" and "open in another tab" free, and it gives one place to enforce concurrency and model-capacity limits.

**Why the alternative fails:** streaming inside the request ties the run's life to one TCP connection and one API process. Rolling deploys would cut every in-flight generation.

**Cost:** a queue, an ownership protocol (leases, fencing, sweeper) and one extra hop on the token path (an append plus a blocking read; the 50 ms delta batching dominates it).

### 3. A per-run log in Valkey Streams

**Chosen:** one Valkey stream per run, read with `XREAD BLOCK` from the client's last event ID.

**Why it works here:** the resume requirement needs replay from an arbitrary offset, which pub/sub cannot do (a message published while the client was reconnecting is gone). Streams give ordered entries with IDs that double as SSE IDs, cheap appends, a TTL, and reads from any API instance.

**Why the alternatives fail:** writing each delta to PostgreSQL means ≈20 row writes per second per run, roughly 24K writes/s at peak, to support data that matters for an hour. Kafka gives replay but is built around topic partitions rather than per-run streams; one topic per run is not workable, and a shared topic forces every reader to filter everyone's tokens.

**Cost:** live output is only as durable as Valkey. If Valkey is lost mid-run, connected clients lose the live view of that run, but the final output is still written to PostgreSQL by the executor and served as a `snapshot`.

### 4. Never auto-retry after the first token

**Chosen:** retry only before any output exists (429/5xx/connection refused, up to 3 attempts with backoff). After that, a failure is final and the partial output is kept.

**Why:** the user has already read part of an answer. A transparent retry would replace it with a different answer (sampling), double the token bill, and hide a real reliability problem from the operator. "Run again" is one click and makes the new cost visible.

**Cost:** some transient failures surface to users that a retry would have hidden.

### 5. Optimistic concurrency everywhere it is shared

**Chosen:** versions are append-only and saves carry `baseVersion`; presets use a `revision` with `If-Match`.

**Why:** edits to shared presets and prompts are rare and short. Locks would need lease management for an editor someone left open over lunch. Last-write-wins silently drops a teammate's change, which is the one outcome the requirements forbid. Optimistic checks cost nothing in the common case and turn the rare conflict into an explicit choice.

**Not chosen:** CRDT co-editing of drafts. It solves a problem (two people typing in one prompt at once) that this product does not have. Drafts are personal until saved.

### 6. SSE over fetch, not WebSockets or EventSource

**Chosen:** SSE, read with `fetch` and a stream reader, with manual resume.

**Why:** the data flows one way (server to browser), and the client sends nothing on the stream. SSE goes through ordinary HTTP infrastructure and has resume (`Last-Event-ID`) built into the protocol. Using `fetch` rather than `EventSource` gives explicit control of the cursor, backoff and abort, and keeps the auth model identical to every other request.

**Cost:** one HTTP connection per followed run. HTTP/2 multiplexes them; under HTTP/1.1 a browser's six-connection limit caps how many runs a single tab can follow at once.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Start a run | At most one run per click, even with retries | `UNIQUE (created_by, idempotency_key)` + request hash; replay returns the original |
| Enqueue | At least once | Run row is committed before enqueue; the sweeper re-enqueues queued runs older than 30 s |
| Execute | At most one owner at a time | Conditional claim `queued → running`, lease, `attempt` fencing token |
| Final outcome | Exactly one recorded ending | `UPDATE … WHERE attempt = $a AND status = 'running'`; event log closed by the first `end` |
| Output delivery to a browser | No gaps, no duplicates | Stream entry IDs + `Last-Event-ID` |
| Save a version | No lost saves; retries are idempotent | Append-only versions, `FOR UPDATE` on the prompt row, `baseVersion` check; text equal to the head is a no-op |
| Edit a preset | No silent overwrite | `revision` compare-and-set via `If-Match` |
| Rename a prompt | Last write wins | Accepted: titles are labels and a lost rename is cheap to redo |

The queue is deliberately not the source of truth. Executors read it with `NOACK`, so there are no pending-entry lists to recover. If an executor dies after reading an entry but before claiming, the run is still `queued` in PostgreSQL and the sweeper rings the doorbell again. Duplicate doorbells are harmless because the claim is conditional.

## Security / Auth

- **Sessions**: an opaque 256-bit session ID in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production); session data in Valkey with a 7-day TTL; logout deletes it immediately
- **Authorization**: every query by prompt, run or comparison ID joins `workspace_members` for the current user, and a non-member gets the same `404` as a missing resource, so IDs reveal nothing. Routes that act on the session's workspace (listing prompts, presets) re-check membership and answer `403 NOT_A_MEMBER`. Nothing is trusted from the session beyond who the user is, so removing someone takes effect on their next request
- **Share links**: 128-bit random tokens; revocation is checked on every request; only finished runs can be shared; the public endpoint returns just the named snapshot and run
- **Rate limits** (fixed window in Valkey, shared by all API instances): 30 runs/min/user plus at most 6 active runs; 20 logins/min/IP; 120 share views/min/IP
- **Validation**: zod schemas with `.strict()` on every body (unknown fields rejected); prompt and variable size caps; path IDs validated as UUIDs before reaching SQL
- **Prompt privacy**: request logs record method, URL and status only, never prompt text or output
- **Model credentials**: only executors call the model API, so provider keys live in one service. The mock model's `/admin/settings` has no auth and is for local use only

## Observability

**Prometheus metrics** (`backend/src/shared/metrics.ts`, `/metrics` on the API, executor and mock model):

| Metric | Type | Use |
|--------|------|-----|
| `http_request_duration_seconds{method,route,status}` | Histogram | API latency by route pattern (bounded cardinality) |
| `playground_runs_created_total{model}` | Counter | Demand |
| `playground_runs_finished_total{model,status}` | Counter | Failure and cancel rates |
| `playground_run_queue_seconds` | Histogram | Executor saturation, separate from model speed |
| `playground_run_ttft_seconds{model}` | Histogram | Model responsiveness |
| `playground_runs_in_flight` | Gauge | Executor utilization |
| `playground_sse_connections` | Gauge | Stream capacity per API instance |
| `mock_model_generations_total{model,outcome}` | Counter | Completed, failed, aborted (cancel reached upstream), overloaded |

Queue time and TTFT are separate on purpose: "runs feel slow" has opposite fixes depending on whether runs wait for an executor or wait for the model.

**Logs**: Pino JSON with a `service` field (api, executor, mock-model). Executor lines carry `runId` and `attempt`, so a run's whole life can be followed across processes.

**Health**: `/health` (liveness) and `/ready` (PostgreSQL + Valkey) on the API; `/health` with in-flight count on the executor; executors publish a heartbeat key every 5 s that the admin page lists.

**Suggested alerts**: oldest queued run > 30 s (executors saturated or down); `EXECUTOR_LOST` above 0.5% of runs; p95 TTFT doubled versus the 7-day baseline; failure rate per model > 5%.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Model returns 429/5xx or refuses the connection before the first token | Retry up to 3 attempts, waiting `max(Retry-After, 250 ms × 2^n)` |
| Model keeps failing | Circuit breaker (opossum): opens at ≥50% errors over ≥5 calls, fails runs fast with `MODEL_UNAVAILABLE`, half-opens after 10 s |
| Model fails mid-stream | Run fails with `MODEL_ERROR`; partial output kept and marked partial; no retry |
| Model stalls | No token for 30 s → `MODEL_TIMEOUT` |
| Executor crashes or stalls | Lease expires (15 s) → sweeper fails the run with `EXECUTOR_LOST`, keeping the output rebuilt from the event log; the stalled executor is fenced out |
| Executor shutdown (deploy) | Stops pulling work, waits up to 8 s for in-flight runs, then fails the rest with `EXECUTOR_SHUTDOWN` instead of leaving them to the lease timeout |
| No executor available | Runs wait; after 5 minutes the sweeper fails them with `QUEUE_TIMEOUT` instead of spinning forever |
| Enqueue fails after insert | Logged; the sweeper re-enqueues queued runs whose last doorbell is older than 30 s |
| Valkey restarts without persistence | The executor recreates the consumer group on `NOGROUP`; queued runs are re-enqueued from PostgreSQL; live views of in-flight runs end, and finals are served from PostgreSQL |
| Browser loses its connection | Reconnects with backoff (0.5 s to 8 s) from its last event ID; never re-submits the run |
| Run event lost before the end (Valkey failed during finalize) | A reader idle for 15 s checks PostgreSQL; if the run ended, it sends the `snapshot` |

## Scalability Considerations

- **API and stream service**: stateless and horizontally scalable. Sessions, limits and run logs are in Valkey, so any instance serves any user and any run. In production the SSE endpoint moves to its own fleet so 2,000+ idle-but-open connections do not consume REST capacity.
- **What breaks first**: SSE read fan-out. The local build opens one Valkey connection per open stream because `XREAD BLOCK` holds its connection. At thousands of streams per instance, that becomes a connection-count problem before it is a CPU problem. The fix is a multiplexed reader per instance: one blocking `XREAD` over all followed run keys, dispatching entries to local subscribers. On a Valkey cluster, one `XREAD` can only span keys in the same hash slot, so the reader runs one blocking read per shard (or run keys get bucketed hash tags).
- **Valkey**: run keys are hash-tagged by run ID (`run:{id}:…`), so the event logs shard across a cluster with no hot key. The run queue is a single stream; at ≈120 runs/s that is far from a limit, and it can be split by workspace hash if it ever is.
- **Executors**: scale with concurrent generations, not request rate. Each is I/O-bound on the model stream; at 50-100 runs per process, 1,200 concurrent runs need about 15-25 processes.
- **PostgreSQL**: ≈720 writes/s at peak is one primary's work. History reads go to replicas. `runs` is the only large table: partition it by month on `created_at`, and move outputs older than the retention window to object storage. Partitioning has one catch: a unique constraint on a partitioned table must include the partition key, so `UNIQUE (created_by, idempotency_key)` moves to a small unpartitioned idempotency table that maps the key to the run ID.
- **The real ceiling is model capacity**: once the model provider is the bottleneck, the work is admission control. Keep queue depth bounded, share capacity fairly across workspaces, and prefer `429` with `Retry-After` over a queue that grows without limit.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Prompt history | Content-addressed snapshots + version labels | Version per run / text copied onto runs | Reproducible draft runs without flooding history |
| Run ownership | Executor with PostgreSQL lease + fencing | Stream inside the POST request | Runs outlive tabs, proxies and deploys |
| Live output | Per-run Valkey stream, replayable | Pub/sub / PostgreSQL rows / Kafka | Resume from any offset without write amplification |
| Work queue | Valkey stream as a doorbell (NOACK) | Queue as source of truth | Ownership lives in one place (PostgreSQL) |
| Retries | Only before the first token | Transparent retry | No silently different answers or double billing |
| Run creation | Idempotency-Key + request hash | Client-side debouncing | Survives lost responses and concurrent retries |
| Shared edits | Append-only versions; If-Match presets | Locks / last write wins | No silent overwrite; no stale locks |
| Transport | SSE read with fetch | WebSocket / EventSource | One-way data, built-in resume, explicit control |
| Drafts | localStorage per prompt | Server-side autosave | Private until saved; zero server writes per keystroke |
| Auth | Session cookie + Valkey | JWT | Immediate revocation, simpler |

## Implementation Notes

### Local architecture

```
┌──────────────────┐     ┌─────────────────────┐      ┌──────────────────────┐
│ Vite dev server  │────▶│ API :3000           │◀────▶│ PostgreSQL :5432      │
│ :5173 (/api      │     │ REST + SSE          │      │ (docker or native)    │
│  proxied)        │     └──────────┬──────────┘      └──────────▲───────────┘
└──────────────────┘                │                            │
                          ┌─────────▼──────────┐       ┌─────────┴───────────┐
                          │ Valkey :6379        │◀─────▶│ Executor :3200       │
                          │ queue, run logs,    │       │ (health + metrics)   │
                          │ sessions, limits    │       └─────────┬───────────┘
                          └────────────────────┘                  │
                                                       ┌──────────▼───────────┐
                                                       │ Mock model :3100      │
                                                       └──────────────────────┘
```

`npm run dev` in `backend/` starts the API, executor and mock model together. `dev:server1..3` start extra API instances on 3001-3003, and `dev:executor2` starts a second executor (port 3202) to watch leases and the sweeper coordinate.

### Production-grade patterns actually implemented

**Idempotent run creation** (`backend/src/api/services/runs.ts`): the replay check runs before rate limits, so retrying an accepted request never gets a 429, and the insert is race-safe:

```ts
const existing = await findByIdempotencyKey(user.id, idempotencyKey)
if (existing) return replayOrConflict(existing, hash)   // 200 replay, or 422 if the body differs
// … authorize, render variables, rate-limit, upsert snapshot …
INSERT INTO runs (…) VALUES (…) ON CONFLICT (created_by, idempotency_key) DO NOTHING RETURNING id
```

**Lease and fencing** (`backend/src/executor/run-executor.ts`): every write after the claim is conditioned on the attempt still owning a running row:

```sql
-- claim
UPDATE runs SET status = 'running', attempt = attempt + 1, lease_owner = $2,
       lease_expires_at = now() + make_interval(secs => $3), started_at = now()
 WHERE id = $1 AND status = 'queued' RETURNING attempt, …
-- heartbeat (every 5 s): 0 rows ⇒ lease lost ⇒ abort the model call
UPDATE runs SET lease_expires_at = now() + make_interval(secs => $4)
 WHERE id = $1 AND attempt = $2 AND status = 'running' AND lease_owner = $3
 RETURNING cancel_requested_at
```

**Closed event logs** (`backend/src/shared/run-events.ts`): appends run through a Lua script that refuses anything after the first `end`, so a stalled executor cannot add output to a run the sweeper already failed.

**Sweeper** (`backend/src/executor/sweeper.ts`): fails expired leases (rebuilding partial output from the log), fails runs queued for over 5 minutes, and re-enqueues queued runs whose doorbell is older than 30 s. It runs in every executor; conditional updates make that safe.

**Circuit breaker + retry before first token** (`backend/src/executor/model-client.ts`): opossum wraps only the call that opens the stream, with model rejections (4xx) and aborts excluded from the error count.

**Resumable SSE** (`backend/src/api/services/run-stream.ts`, `frontend/src/services/run-stream.ts`): server replays from `Last-Event-ID`; the client reconnects with backoff from its cursor and never re-POSTs.

**Optimistic concurrency**: version saves lock the prompt row and compare `baseVersion` (`backend/src/api/routes/prompts.ts`); presets use `If-Match` revisions (`backend/src/api/routes/presets.ts`).

**Rate limiting** (`backend/src/shared/rate-limit.ts`), **Prometheus metrics** (`backend/src/shared/metrics.ts`), **structured logging** with prompt text kept out of logs (`backend/src/shared/logger.ts`, `backend/src/api/app.ts`), **health checks** and **graceful shutdown** in each service's `index.ts`.

**Client run store** (`frontend/src/stores/runs-store.ts`): streams are followed outside components, and a REST copy can never move a run backwards. That second rule was added after a browser test caught the Stop button's response, which arrived after the stream's `end`, flipping a cancelled run back to "running" with empty output.

### Simplified or substituted

- **Mock model service instead of a provider API** (`backend/src/model/`): deterministic text built from prompt keywords, realistic TTFT and tokens/s per model, a concurrency limit that answers 429, an injectable mid-stream failure rate, and generation that stops when the caller disconnects. Three models: `sim-fast` (150 ms TTFT, ≈80 tokens/s), `sim-quality` (700 ms, ≈30 tokens/s, structured output), `sim-flaky` (fails partway through about 35% of runs). Temperature 0 is deterministic. The admin page adjusts failure rate, latency and slots at runtime
- **Token counts** are approximate (word-sized tokens for output, four characters per token for input)
- **Stream service** is the same process as the API; one Valkey connection per open SSE stream instead of a multiplexed reader
- **Single PostgreSQL and Valkey** instead of replicas and a cluster (keys are already hash-tagged for one)
- **One workspace per user** at sign-in; memberships support more, but there is no workspace switcher
- **Session auth** with seeded users; no SSO, invitations or roles beyond member and admin
- **Fixed-window rate limits** instead of token buckets

### Omitted

- Real model providers (an adapter behind an environment variable is the intended extension point in `model-client.ts`)
- Billing and per-workspace token budgets
- Partitioning of `runs`, archiving outputs to object storage, and read replicas
- Real-time co-editing of a draft, comments, and diff views between versions
- Evaluation datasets and scoring (planned as a separate project)
- CDN, multi-region, Kubernetes

### Verified locally

Exercised against PostgreSQL 16 and Valkey/Redis 7 with the three services running: streaming and resume from a `Last-Event-ID`; idempotent replay and key reuse with a different body; missing variables; cancel while queued and while running (the mock model logged the upstream abort); forced mid-stream failure; version `HEAD_MOVED` and preset `REVISION_CONFLICT`; share, revoke (`410`) and workspace isolation (`404` for another workspace's IDs). Recovery paths: a SIGSTOPped executor failed by a second executor's sweeper, then fenced out when resumed; a run with a lost queue entry re-enqueued; a deleted consumer group recreated. In the browser, Playwright drove streaming, refresh mid-run, Stop, comparisons, the navigate-away toast, both conflict flows, the admin page and the share page. Unit tests cover template rendering, hashing, SSE parsing, the generator and API validation and idempotency paths.

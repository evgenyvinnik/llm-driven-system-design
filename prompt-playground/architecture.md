# Prompt Playground - Architecture Design

## System Overview

The Prompt Playground is a browser workspace where developers and product teams write prompts, bind template variables, tune model parameters, and run the result against one or more models with streamed output. It keeps an immutable version history for every prompt, compares versions and models side by side, simulates multi-turn conversations as branching threads, lets a team co-edit one prompt with live presence, and enforces per-user cost budgets so that exploration on shared billing stays bounded. The model is a black box behind an inference API. The design work is the product, the editing and versioning model, and the execution and streaming path around the model.

This design covers two reported interview framings. OpenAI's phone-screen version ("Design the OpenAI Playground") asks for wireframes first, then the API layer, then a thread/message schema. Anthropic's on-site version asks for product requirements and UI flow first, then a backend for real-time execution, streaming, user concurrency and global scale. Its collaborative variant centers on version history and running selected versions against a model.

**Learning goals:**
- Scope a product-flavored design from user journeys and wireframes before drawing service boxes
- Separate a mutable, co-edited draft from an immutable, reproducible version history
- Stream several concurrent generations into one page, resumably, through a decoupled execution tier
- Model branching conversations (threads) as a message tree
- Admit work against cost budgets and concurrency limits when the cost is only known after the work finishes
- Place collaborative and streaming workloads across regions

## Requirements

### Functional Requirements

1. **Prompt editor**: system instructions plus a list of message templates (user and assistant turns, used for few-shot examples), with `{{variable}}` placeholders, a generated variable form, and a "rendered prompt" preview.
2. **Parameter panel**: model picker and per-model parameters (temperature, top-p, max output tokens, stop sequences, response format, tools), driven by a model catalog so unsupported parameters are shown as unavailable rather than silently dropped.
3. **Run with streaming**: run the current draft or any saved version, stream tokens into an output pane, stop a run, and show time to first token (TTFT), token counts and cost.
4. **Side-by-side comparison**: 2 to 4 panes, each a (version or draft) × (model, parameters) combination fed the same variables. "Run all" streams every pane concurrently.
5. **Version history**: save named, immutable versions with a commit message. Every run is pinned to an immutable snapshot. Browse history, diff any two versions field by field, restore an old version as a new one, and point aliases (`production`, `staging`) at versions.
6. **Run selected versions**: pick versions in the history list and run them against the same input or test case in a comparison view.
7. **Threads (simulated conversations)**: start a multi-turn conversation from a version. Editing a turn or regenerating a reply creates a branch instead of overwriting. Optionally, a second "simulated user" prompt plays the user for N turns.
8. **Prompt testing**: save variable sets as test cases, and run a matrix of versions × test cases × model configs as an evaluation with an up-front cost estimate.
9. **Collaboration**: several people co-edit the same draft in real time with presence (avatars, colored cursors, focused field) and see each other's runs and saves as they happen.
10. **API integration**: "View code" exports the exact request for the current configuration, and saved prompts are addressable from the inference API by ID plus version or alias.
11. **Cost controls**: per-user daily budgets, per-workspace monthly budgets, per-user concurrency limits, and live spend in the UI.

### Non-Functional Requirements

| Requirement | Target | Why |
|---|---|---|
| Availability | 99.95% for editing, history and threads | A design tool must stay usable while a model is degraded |
| Run error budget | The playground adds < 0.05% failed runs on top of model errors | Model failures are expected; ours shouldn't add to them |
| Run start overhead | p99 < 100 ms from click to upstream request, in-region | Model TTFT is already 300–1,000 ms |
| Chunk relay | p99 < 150 ms from executor to browser, in-region | Streaming should look continuous, not bursty |
| Collaborative edits | Visible to co-editors p95 < 300 ms in-region, < 500 ms cross-region | Presence feels live below ~0.5 s |
| Reproducibility | A version ID resolves to byte-identical content forever; every run records its version and exact parameters | Comparisons and production pins are meaningless otherwise |
| Durability | Committed versions are never lost; an output is persisted before its completion event is sent | "Completed" must mean "saved" |
| Cost safety | A user's or workspace's spend never exceeds its hard budget | Shared billing must be safe to hand to a whole team |
| Scale | 2M MAU, 50K peak concurrent users, ~10.5K concurrent streams | See Capacity Estimation |

### Out of Scope

- Training, fine-tuning, and the inference tier itself (batching, GPU scheduling). The model is a black box with rate limits.
- Model-graded evaluation. v1 supports simple checks (exact match, regex, JSON validity).
- Invoicing and payment. The platform's billing system owns money; the playground meters usage and enforces budgets.
- Review comments and approval workflows on versions (listed under open questions).

## Capacity Estimation

### Production Scale

| Assumption | Value |
|---|---|
| Users | 2M MAU, 500K DAU |
| Peak concurrent users | 50K (10% of DAU) |
| Runs per DAU per day | 40, so 20M runs/day |
| Outputs per run | 1.5 on average (most runs are one pane; comparisons are 2–4), so 30M outputs/day |
| Tokens per output | 1,500 input, 500 output |
| Streaming rate | 50 output tokens/s, so a 500-token output streams for 10 s |
| Peak-to-average ratio | 3× |
| Chunk coalescing | Executors flush every 50 ms: 20 chunk events/s per stream, ~2.5 tokens each, ~200 chunks per output |
| Prices (hypothetical, for budget math only) | $2 per 1M input tokens, $10 per 1M output tokens |

**Throughput**

| Quantity | Calculation | Result |
|---|---|---|
| Average run rate | 20M ÷ 86,400 s | ≈ 230 runs/s |
| Peak run rate | 230 × 3 | ≈ 700 runs/s |
| Peak output starts | 700 × 1.5 | ≈ 1,050 outputs/s |
| Concurrent streams at peak (Little's law) | 1,050/s × 10 s | ≈ 10,500 streams |
| Chunk appends to the stream bus | 10,500 × 20/s | ≈ 210K appends/s |
| SSE egress | 10,500 × 20 events/s × ~100 B | ≈ 21 MB/s ≈ 170 Mbps |
| PostgreSQL writes at peak | 700 run inserts + 1,050 × 2 output writes + 210 snapshot inserts | ≈ 3K writes/s |
| Collaboration | 50K WebSockets; 10% typing at ~5 updates/s | ≈ 25K CRDT updates/s |

**Cost (why budgets exist)**

| Quantity | Calculation | Result |
|---|---|---|
| Average output cost | 1,500 × $2/1M + 500 × $10/1M = $0.003 + $0.005 | $0.008 |
| Worst-case reservation at the default max_tokens of 1,024 | $0.003 + 1,024 × $10/1M | ≈ $0.013 |
| Model spend driven through the playground | 30M × $0.008 | ≈ $240K/day |
| Default per-user daily budget | $5 | ≈ 625 average outputs |

**Storage**

| Data | Calculation | Per day | Hot (90 days) |
|---|---|---|---|
| Output text | 30M × 2 KB | 60 GB | 5.4 TB |
| Run and output metadata | 30M × 0.5 KB | 15 GB | 1.35 TB |
| New content snapshots | 20M runs × 30% with changed content = 6M × 4 KB | 24 GB | 2.16 TB |
| **Total** | | **≈ 100 GB** | **≈ 9 TB** |

Named versions are a small fraction of snapshots and are kept forever. Snapshots, runs and outputs move to object storage after 90 days. Redis keeps each run's chunk log for 2 minutes after completion so late reconnects can replay it: (10,500 in flight + 1,050/s × 120 s) × ~12 KB (200 chunks × 60 B) ≈ 136,500 × 12 KB ≈ 1.6 GB.

**Bandwidth is not the constraint.** 170 Mbps of SSE is trivial. What constrains the system is upstream model capacity (10,500 concurrent generations), the 210K/s chunk-append rate on the stream bus, and run-history storage growth.

### Local Development Scale

| Component | Local sizing |
|---|---|
| Users | 2–5 browser tabs; 10 seeded users across 2 workspaces |
| Runs | < 1 run/s, up to 4 panes per run |
| Mock model | 50 tokens/s, 400 ms TTFT, configurable failure injection |
| Concurrent streams | < 20 |
| Data | Hundreds of versions and runs; one PostgreSQL and one Valkey |

## High-Level Architecture

```
┌──────────────────┐            ┌──────────────────────────┐
│  Browser (SPA)   │◀───────────│ CDN: SPA bundle, assets  │
└────────┬─────────┘            └──────────────────────────┘
         │ HTTPS (REST) · WSS (collab) · SSE (run streams)
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Edge PoP + API Gateway: TLS, session auth, request rate limits, routing to  │
│ the workspace's home region over the provider backbone                      │
└───────┬──────────────────┬──────────────────────┬───────────────────┬───────┘
        │ REST             │ WebSocket            │ SSE               │ REST
        ▼                  ▼                      ▼                   ▼
┌───────────────┐  ┌───────────────┐      ┌───────────────┐   ┌───────────────┐
│ Prompt Svc    │  │ Collab Svc    │      │ Stream        │   │ Run Svc       │
│ prompts,      │  │ CRDT draft    │      │ Gateway       │   │ render,       │
│ versions,     │  │ per prompt,   │      │ SSE fan-out,  │   │ snapshot,     │
│ aliases,      │  │ presence,     │      │ resume by     │   │ admission,    │
│ threads       │  │ sticky        │      │ Last-Event-ID │   │ dispatch      │
└───────┬───────┘  └───────┬───────┘      └───────▲───────┘   └──┬─────────┬──┘
        │                  │                      │ XREAD        │         │ reserve,
        ▼                  ▼                      │              │         │ lease
┌──────────────────────────────────┐      ┌───────┴───────────┐  │  ┌──────▼────────┐
│ PostgreSQL (sharded by           │      │ Redis Cluster     │◀─┼──│ Quota Svc     │
│ workspace_id): prompts, versions,│      │ run streams,      │  │  │ Lua reserve / │
│ runs, outputs, threads, drafts   │      │ quotas, leases    │  │  │ settle        │
└────────────────▲─────────────────┘      └───────▲───────────┘  │  └───────────────┘
                 │ final output + usage           │ XADD chunks  │ dispatch (interactive)
                 │                        ┌───────┴──────────────▼──┐     ┌──────────────────┐
                 └────────────────────────│ Executor Pool           │────▶│ Model Inference  │
                                          │ adapter, breaker per    │◀────│ API (black box)  │
                                          │ model, lease heartbeats │     └──────────────────┘
                                          └───────▲─────────────────┘
                                                  │ batch lane
                                          ┌───────┴─────────────────┐     ┌──────────────────┐
                                          │ Kafka: eval jobs, usage │────▶│ ClickHouse:      │
                                          │ and run events          │     │ usage analytics  │
                                          └─────────────────────────┘     └──────────────────┘
```

The browser holds three kinds of connection, and each has its own backend tier because each scales differently:

- **REST** to the Prompt Service and Run Service for CRUD, history and run creation. These are stateless and scale on CPU.
- **WebSocket** to the Collab Service, which owns one CRDT document per prompt draft. It is sticky: every editor of a prompt must reach the node that owns that prompt, so it scales by consistent hashing on `prompt_id`.
- **SSE** to the Stream Gateway, which tails per-run chunk logs in Redis and fans them out to every viewer of the run. It scales on open connections.

The Run Service never calls the model itself. It validates, pins a version, reserves budget, writes `queued` output rows, and hands the outputs to the Executor Pool. Executors hold the long-lived upstream connections, append coalesced chunks to the run's Redis Stream, and write the final output to PostgreSQL. The Stream Gateway and executors meet only through Redis, so a browser refresh, a gateway deploy or a second viewer never touches the generation itself.

## Core Components / Request Flows

### Component Responsibilities

| Component | Responsibility | State |
|---|---|---|
| Prompt Service | Prompts, versions (named and snapshot), aliases, diff support, threads and messages, test cases | PostgreSQL |
| Collab Service | Yjs document per prompt draft, awareness (presence), compaction, broadcast of activity events (run started, version saved) | In-memory doc + PostgreSQL update log |
| Run Service | Template rendering, snapshot upsert, cost estimate, admission (budget + concurrency), dispatch, cancel | PostgreSQL, Redis |
| Quota Service | Atomic reserve/settle of budgets and concurrency leases (a library around Lua scripts, plus a reconciler) | Redis, PostgreSQL aggregates |
| Executor Pool | Claims outputs, streams from the model, coalesces chunks, persists results, heartbeats leases | Redis Streams, PostgreSQL |
| Stream Gateway | SSE endpoint per run; one Redis reader per run per node shared by all local subscribers; resume | Redis Streams (read-only) |
| Evaluation Scheduler | Expands a matrix into outputs, feeds the batch lane with per-user fair share, pauses on budget | Kafka, PostgreSQL |
| Model Catalog | Models, parameter schemas, context windows, prices; cached by clients and services | PostgreSQL + CDN-cacheable endpoint |

### Flow 1: Run a Prompt (Single Pane or Comparison)

1. The user presses Run. The client generates an `Idempotency-Key`, captures the draft content it is displaying, its ad-hoc variable values, and the pane configs, and sends `POST /api/v1/runs`.
2. The Run Service claims the idempotency key in Redis (`SET NX`). A duplicate request gets the existing run back.
3. It renders the template with the shared template library. An unbound required variable returns 422 with the variable names.
4. It computes the content hash and upserts a `snapshot` version (deduplicated per prompt by hash) whose parent is the draft's base version. The run is now pinned to immutable content.
5. For each pane, it counts input tokens and computes a worst-case reservation (input × input price + `max_tokens` × output price). One Lua call reserves all panes against the user and workspace budgets and takes one concurrency lease per output, all or nothing.
6. In one transaction, it inserts the `runs` row and one `run_outputs` row per pane with status `queued`.
7. It appends the run to the `dispatch:interactive` Redis Stream and returns `202` with the run ID, output IDs and the stream URL. Steps 2–7 take ~15–30 ms.
8. The client opens `GET /api/v1/runs/:id/stream` (SSE). An executor reads the dispatch entry, claims each output with a conditional update (`queued → streaming`), and calls the model.
9. The executor coalesces tokens for 50 ms and appends `output.delta` entries to `stream:{run_id}`. The gateway tails the stream and writes SSE events.
10. On the model's final event, the executor writes the full text and usage to `run_outputs` (`streaming → completed`), settles the reservation with the actual cost, releases the lease, and only then appends `output.completed`.

### Flow 2: Stream Relay, Multiple Viewers, and Reconnect

- Every SSE event carries `id:` set to the Redis Stream entry ID. All panes of a run share one stream, so one cursor resumes everything.
- On reconnect, the browser sends `Last-Event-ID`, and the gateway replays with `XRANGE` from that entry before blocking on `XREAD`.
- If the stream key has expired (more than 2 minutes after completion), the gateway sends a `run.snapshot` event built from PostgreSQL instead.
- A collaborator who opens a teammate's in-progress run attaches to the same stream from the beginning. Each gateway node runs one `XREAD` per run regardless of how many local subscribers it has, and batches many run keys into one blocking call.
- Closing the tab does not stop the generation. The output completes, bounded by its `max_tokens` reservation, and is saved to history.

### Flow 3: Stop a Run

1. `POST /api/v1/runs/:id/cancel` (optionally with `output_id`) sets `cancel_requested` and publishes on `cancel:{run_id}`.
2. The owning executor aborts the upstream HTTP request, which frees model capacity, and persists the partial text with `finish_reason = 'cancelled'`.
3. It settles input tokens plus the output tokens generated so far, releases the lease, and appends `output.cancelled`.
4. Closing the SSE connection alone never cancels, because other viewers may be attached and refresh must be safe.

### Flow 4: Co-edit the Draft and Save a Version

1. Opening a prompt connects a WebSocket to the Collab Service node that owns `prompt_id`. The node loads the latest compacted Yjs state plus subsequent updates and syncs the client by state vector.
2. Keystrokes apply locally first, then travel as small binary updates. The node broadcasts them and appends them to `draft_updates` in batches every 200 ms. It compacts into `draft_snapshots` every 500 updates.
3. "Save version" opens a dialog showing the diff between the head version and the draft, with each change attributed to its author from Yjs metadata. This is where the saver sees a collaborator's half-finished sentence before committing it.
4. The client sends `POST /prompts/:id/versions` with the content it reviewed, `expected_head_version_id`, and a `client_commit_id`.
5. The Prompt Service inserts the blob and version and advances `prompts.head_version_id` with a compare-and-set. If the head moved, it returns `409` with the new head, and the client re-diffs against it. Two people can never both create "v8", and nobody's save is silently overwritten.
6. The Collab Service broadcasts `version.saved` so every open history panel updates.

### Flow 5: A Thread Turn

1. A thread starts from a version, and its system prompt comes from that version.
2. The user appends a message under a parent (`POST /threads/:id/messages`). Editing an earlier turn appends a sibling under the same parent instead of mutating the old turn.
3. `POST /threads/:id/runs` with a `leaf_message_id` assembles the conversation by walking parents to the root. If it exceeds the model's context window, the request is rejected with a token breakdown. The playground never truncates silently, because hidden truncation would mask the behavior the user is testing.
4. The run streams like any other run. On completion, the chosen output is appended as an assistant message whose `source_output_id` links back to the output, and the thread's active leaf moves to it.
5. In simulated-user mode, the Run Service alternates between the thread's version and a simulator version for up to N turns, reserving budget per turn and emitting all turns on the same run stream.

### Flow 6: Evaluation Matrix

1. The client sends `version_ids × test_case_ids × model_configs`. The service returns an estimate (expected and worst case), and the user confirms.
2. The scheduler writes one batch job per output to Kafka, partitioned by user, so one user's 600-output matrix cannot starve other users.
3. Batch executors process at most 4 outputs per user at a time, each with its own reservation. When the budget runs out, the evaluation moves to `paused_budget` and shows how many cells completed.
4. Results stream to the evaluation grid through the same run-stream mechanism. Simple checks (exact match, regex, JSON parse) run on completion.

### Client Architecture

| State | Owner | Persistence | Why |
|---|---|---|---|
| Draft (system text, messages, variable schema, default params) | Yjs document bound to CodeMirror and form controls | Collab Service + IndexedDB | Concurrent edits merge; per-user undo; survives reload |
| Presence (cursor, selection, focused field, "running…") | Yjs awareness | Memory | Ephemeral by design |
| Immutable data (versions, completed outputs) | Query cache keyed by ID | HTTP cache with `immutable` | Never refetched, never invalidated |
| Mutable lists (history, run list, threads, usage) | Query cache | Memory | Invalidated by collab activity events |
| Live token streams | Stream store outside React, one buffer per output | Memory; resumable from the server | 80 events/s must not re-render the app |
| Ad-hoc variable values | Per-user local store | IndexedDB per prompt | A teammate's test input must not overwrite mine |
| Layout, pane configs, selected test case | Zustand + URL search params | URL | A compare view is a shareable link |

The rendering pipeline batches token events per animation frame. SSE events append to a per-output buffer and mark that output dirty. One `requestAnimationFrame` callback notifies only the dirty panes' subscribers, so four panes produce at most 60 DOM commits per second instead of 80 event-driven renders, and a token in pane 2 never re-renders pane 1 or the editor.

Markdown is rendered incrementally. Completed blocks (paragraphs, closed code fences) are parsed once and memoized, and only the trailing open block is re-parsed each frame. Re-parsing a 4K-token (~16 KB) output on every frame in four panes would exceed the 16.7 ms frame budget.

## Database Schema

### PostgreSQL

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  home_region              TEXT NOT NULL DEFAULT 'us',
  monthly_budget_microusd  BIGINT NOT NULL DEFAULT 1000000000,      -- $1,000
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                    TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  daily_budget_microusd   BIGINT NOT NULL DEFAULT 5000000,           -- $5
  max_concurrent_outputs  INT NOT NULL DEFAULT 8,
  joined_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_members_user ON workspace_members(user_id);

CREATE TABLE prompts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id),
  name                 TEXT NOT NULL,
  head_version_id      UUID,                         -- latest named version (FK below)
  next_version_number  INT NOT NULL DEFAULT 1,
  created_by           UUID NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at          TIMESTAMPTZ
);
CREATE INDEX idx_prompts_workspace ON prompts(workspace_id, created_at DESC)
  WHERE archived_at IS NULL;

-- Content-addressed prompt bodies: system, messages, variables, model, params, tools
CREATE TABLE prompt_blobs (
  content_hash  BYTEA PRIMARY KEY,                   -- sha256 of canonical JSON
  content       JSONB NOT NULL,
  size_bytes    INT NOT NULL CHECK (size_bytes <= 262144),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE prompt_versions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id          UUID NOT NULL REFERENCES prompts(id),
  kind               TEXT NOT NULL CHECK (kind IN ('named', 'snapshot')),
  version_number     INT,                            -- v1, v2, ... for named versions only
  parent_version_id  UUID REFERENCES prompt_versions(id),
  restored_from_id   UUID REFERENCES prompt_versions(id),
  content_hash       BYTEA NOT NULL REFERENCES prompt_blobs(content_hash),
  commit_message     TEXT,
  client_commit_id   UUID,                           -- makes commit retries idempotent
  author_id          UUID NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'named') = (version_number IS NOT NULL))
);
CREATE UNIQUE INDEX uq_versions_number   ON prompt_versions(prompt_id, version_number) WHERE kind = 'named';
CREATE UNIQUE INDEX uq_versions_snapshot ON prompt_versions(prompt_id, content_hash)   WHERE kind = 'snapshot';
CREATE UNIQUE INDEX uq_versions_commit   ON prompt_versions(prompt_id, client_commit_id)
  WHERE client_commit_id IS NOT NULL;
CREATE INDEX idx_versions_history ON prompt_versions(prompt_id, created_at DESC);

ALTER TABLE prompts ADD CONSTRAINT fk_prompts_head
  FOREIGN KEY (head_version_id) REFERENCES prompt_versions(id);

-- Immutability is enforced by the database, not only by application code
CREATE FUNCTION forbid_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER versions_immutable BEFORE UPDATE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER blobs_immutable BEFORE UPDATE ON prompt_blobs
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

CREATE TABLE prompt_aliases (
  prompt_id   UUID NOT NULL REFERENCES prompts(id),
  name        TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,31}$'),
  version_id  UUID NOT NULL REFERENCES prompt_versions(id),
  updated_by  UUID NOT NULL REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (prompt_id, name)
);

CREATE TABLE prompt_alias_events (                   -- audit trail for production pins
  id            BIGSERIAL PRIMARY KEY,
  prompt_id     UUID NOT NULL REFERENCES prompts(id),
  name          TEXT NOT NULL,
  from_version  UUID REFERENCES prompt_versions(id),
  to_version    UUID NOT NULL REFERENCES prompt_versions(id),
  actor_id      UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alias_events ON prompt_alias_events(prompt_id, created_at DESC);

-- Collaborative draft persistence (Yjs binary updates + periodic compaction)
CREATE TABLE draft_updates (
  prompt_id    UUID NOT NULL REFERENCES prompts(id),
  seq          BIGINT NOT NULL,
  update_data  BYTEA NOT NULL,
  origin_user  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (prompt_id, seq)
);

CREATE TABLE draft_snapshots (
  prompt_id         UUID PRIMARY KEY REFERENCES prompts(id),
  state             BYTEA NOT NULL,
  upto_seq          BIGINT NOT NULL,
  base_version_id   UUID REFERENCES prompt_versions(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE test_cases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id   UUID NOT NULL REFERENCES prompts(id),
  name        TEXT NOT NULL,
  variables   JSONB NOT NULL,
  checks      JSONB NOT NULL DEFAULT '[]',          -- e.g. [{"type":"regex","pattern":"^Category:"}]
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_test_cases_prompt ON test_cases(prompt_id);

CREATE TABLE evaluations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id           UUID NOT NULL REFERENCES prompts(id),
  user_id             UUID NOT NULL REFERENCES users(id),
  version_ids         UUID[] NOT NULL,
  test_case_ids       UUID[] NOT NULL,
  model_configs       JSONB NOT NULL,
  status              TEXT NOT NULL CHECK (status IN
                        ('queued', 'running', 'paused_budget', 'completed', 'cancelled')),
  total_outputs       INT NOT NULL,
  completed_outputs   INT NOT NULL DEFAULT 0,
  estimated_microusd  BIGINT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evaluations_prompt ON evaluations(prompt_id, created_at DESC);

-- Runs and outputs: high volume, time-partitioned, archived after 90 days.
-- FKs are omitted on partitioned tables; the Run Service writes runs and outputs in one transaction.
CREATE TABLE runs (
  id               UUID NOT NULL,                    -- UUIDv7 (time-ordered)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id     UUID NOT NULL,
  prompt_id        UUID NOT NULL,
  version_id       UUID NOT NULL,                    -- always pinned: named or snapshot
  user_id          UUID NOT NULL,
  thread_id        UUID,
  evaluation_id    UUID,
  test_case_id     UUID,
  variables        JSONB NOT NULL DEFAULT '{}',
  idempotency_key  UUID NOT NULL,
  lane             TEXT NOT NULL CHECK (lane IN ('interactive', 'batch')),
  status           TEXT NOT NULL CHECK (status IN
                     ('running', 'completed', 'partial', 'failed', 'cancelled')),
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_runs_prompt  ON runs(prompt_id, created_at DESC);
CREATE INDEX idx_runs_user    ON runs(user_id, created_at DESC);
CREATE INDEX idx_runs_version ON runs(version_id, created_at DESC);
CREATE UNIQUE INDEX uq_runs_idem ON runs(user_id, idempotency_key, created_at);

CREATE TABLE run_outputs (
  id                 UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id             UUID NOT NULL,
  pane_index         SMALLINT NOT NULL,
  model              TEXT NOT NULL,
  params             JSONB NOT NULL,                 -- effective params after overrides and clamping
  status             TEXT NOT NULL CHECK (status IN
                       ('queued', 'streaming', 'completed', 'failed', 'cancelled')),
  output_text        TEXT,
  finish_reason      TEXT CHECK (finish_reason IN
                       ('stop', 'length', 'cancelled', 'error', 'content_filter')),
  input_tokens       INT,
  output_tokens      INT,
  reserved_microusd  BIGINT NOT NULL,
  cost_microusd      BIGINT,
  ttft_ms            INT,
  duration_ms        INT,
  error_code         TEXT,
  executor_id        TEXT,
  completed_at       TIMESTAMPTZ,
  PRIMARY KEY (id, created_at),
  UNIQUE (run_id, pane_index, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_outputs_run ON run_outputs(run_id);
CREATE INDEX idx_outputs_inflight ON run_outputs(status, created_at)
  WHERE status IN ('queued', 'streaming');

CREATE TABLE runs_2026_10        PARTITION OF runs        FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE run_outputs_2026_10 PARTITION OF run_outputs FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- Threads: a message tree. The system prompt comes from base_version_id, not from a message row.
CREATE TABLE threads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id),
  prompt_id             UUID NOT NULL REFERENCES prompts(id),
  base_version_id       UUID NOT NULL REFERENCES prompt_versions(id),
  simulator_version_id  UUID REFERENCES prompt_versions(id),  -- persona that plays the user
  title                 TEXT NOT NULL DEFAULT 'Untitled thread',
  active_leaf_id        UUID,                                  -- FK below
  created_by            UUID NOT NULL REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at           TIMESTAMPTZ
);
CREATE INDEX idx_threads_prompt ON threads(prompt_id, updated_at DESC) WHERE archived_at IS NULL;

CREATE TABLE messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id         UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id         UUID REFERENCES messages(id),     -- NULL for the first turn
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content           JSONB NOT NULL,                   -- array of parts: text, image ref, tool call/result
  authored_by       TEXT NOT NULL CHECK (authored_by IN ('human', 'model', 'simulator')),
  author_id         UUID REFERENCES users(id),
  source_output_id  UUID,                             -- run output that produced an assistant turn
  depth             INT NOT NULL CHECK (depth >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_thread   ON messages(thread_id, created_at);
CREATE INDEX idx_messages_children ON messages(parent_id, created_at);
ALTER TABLE threads ADD CONSTRAINT fk_threads_leaf
  FOREIGN KEY (active_leaf_id) REFERENCES messages(id);

-- Usage aggregates (live counters are in Redis; these are the durable record)
CREATE TABLE usage_daily (
  workspace_id   UUID NOT NULL,
  user_id        UUID NOT NULL,
  day            DATE NOT NULL,
  input_tokens   BIGINT NOT NULL DEFAULT 0,
  output_tokens  BIGINT NOT NULL DEFAULT 0,
  cost_microusd  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, user_id, day)
);

CREATE TABLE usage_applied (                         -- exactly-once settlement per output
  output_id   UUID PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Redis Keys

```
idem:{user_id}:{key}            STRING   run_id ("pending" while creating)          TTL 24h
dispatch:interactive            STREAM   run_id entries; consumer group "executors"
stream:{run_id}                 STREAM   output.delta / completed / failed events    TTL 2 min after run ends
cancel:{run_id}                 PUBSUB   cancel signal to the owning executor
quota:u:{ws}:{user}:{yyyymmdd}  HASH     spent, reserved (micro-USD)                 TTL 48h
quota:w:{ws}:{yyyymm}           HASH     spent, reserved (micro-USD)                 TTL 40d
leases:{ws}:{user}              ZSET     member = output_id, score = lease expiry ms
settled:{output_id}             STRING   1 (settlement guard)                        TTL 7d
```

All keys for one run share the `{run_id}` hash tag where needed so multi-key scripts stay on one cluster slot. Quota keys for one user share `{ws}:{user}`.

## API Design

### REST Endpoints

```
Prompts and versions
GET    /api/v1/prompts?workspace_id=           → list prompts
POST   /api/v1/prompts                         → create prompt (empty draft)
GET    /api/v1/prompts/:id                     → metadata, head version, aliases
GET    /api/v1/prompts/:id/versions?cursor=    → history (named + collapsed snapshot counts)
POST   /api/v1/prompts/:id/versions            → save named version (CAS on head)
GET    /api/v1/versions/:versionId             → immutable content (Cache-Control: immutable)
POST   /api/v1/versions/:versionId/restore     → new named version with old content
PUT    /api/v1/prompts/:id/aliases/:name       → move alias (CAS on current target)
WS     /api/v1/collab/prompts/:id              → Yjs sync, awareness, activity events

Runs
POST   /api/v1/runs                            → create run (Idempotency-Key header)
GET    /api/v1/runs/:id/stream                 → SSE, all panes multiplexed, Last-Event-ID resume
POST   /api/v1/runs/:id/cancel                 → cancel all outputs or ?output_id=
GET    /api/v1/runs/:id                        → final state of a run and its outputs
GET    /api/v1/prompts/:id/runs?cursor=        → run history for a prompt
GET    /api/v1/runs/:id/code?lang=             → equivalent inference API request

Threads
POST   /api/v1/threads                         → start a thread from a version
GET    /api/v1/threads/:id                     → thread + full message tree
POST   /api/v1/threads/:id/messages            → append a message under parent_id
POST   /api/v1/threads/:id/runs                → generate the next assistant turn at a leaf
PUT    /api/v1/threads/:id/active-leaf         → switch the visible branch

Testing
POST   /api/v1/prompts/:id/test-cases          → save a variable set (+ checks)
POST   /api/v1/evaluations/estimate            → expected and worst-case cost for a matrix
POST   /api/v1/evaluations                     → start a matrix run
GET    /api/v1/evaluations/:id                 → progress + results grid

Catalog and usage
GET    /api/v1/models                          → models, parameter schemas, limits, prices
GET    /api/v1/usage/me?workspace_id=          → today's spend, budget, active leases
```

### Create a Run

```http
POST /api/v1/runs
Idempotency-Key: 4b7d1f0e-6a51-4a7e-9c55-0b1e2a7c9f10

{
  "prompt_id": "pr_8f2…",
  "base_version_id": "pv_v7…",
  "content": { "system": "You are a support agent for {{product}}…",
               "messages": [{ "role": "user", "content": "{{ticket}}" }],
               "model": "model-a", "params": { "temperature": 0.7, "max_tokens": 1024 } },
  "variables": { "product": "Acme CRM", "ticket": "I was charged twice…" },
  "panes": [{ "model": "model-a", "params": {} }, { "model": "model-b", "params": {} }]
}
```

```http
HTTP/1.1 202 Accepted

{
  "run_id": "run_01J9…",
  "version_id": "pv_snap_3c1…",
  "outputs": [{ "id": "out_a…", "pane_index": 0, "reserved_usd": 0.013 },
              { "id": "out_b…", "pane_index": 1, "reserved_usd": 0.013 }],
  "stream_url": "/api/v1/runs/run_01J9…/stream"
}
```

Either `content` (run the draft) or `version_id` (run a saved version) is required. Errors: `422 missing_variables` (names listed), `402 budget_exceeded` (with remaining budget and the largest `max_tokens` that would fit), `429 concurrency_limit` (with active leases), `409 idempotency_conflict` (same key, different body).

### Stream Events

```
id: 1760180000000-0
event: run.started
data: {"run_id":"run_01J9…","outputs":["out_a…","out_b…"]}

id: 1760180000412-3
event: output.delta
data: {"output_id":"out_a…","seq":1,"text":"Category: billing."}

id: 1760180010950-0
event: output.completed
data: {"output_id":"out_a…","finish_reason":"stop","input_tokens":1500,"output_tokens":498,"cost_usd":0.00798}
```

Other events: `output.failed` (`error_code`, `retryable`), `output.cancelled`, `output.snapshot` (full text so far, sent after a stream-log loss), `run.snapshot` (final state from PostgreSQL after the log expired), `run.completed`. A comment line every 15 s keeps proxies from closing idle connections.

## Key Design Decisions

### 1. Immutable, content-addressed versions; every run pinned to one

Every run references a `prompt_versions` row, either a named version or an automatic `snapshot` of the draft as displayed at click time. Version rows and blobs reject `UPDATE` at the database level. A comparison between "v6" and "v7" therefore compares fixed artifacts, a production alias pointing at v7 cannot change under traffic, and "re-run this" reproduces the same input.

The alternative is a single mutable `prompts` row with a version counter. It looks simpler, but a run would then point at content that has since changed, so the history shows outputs next to a prompt that did not produce them. The cost of immutability is storage (6M snapshots/day, 24 GB/day), contained by deduplicating snapshots on `(prompt_id, content_hash)` and expiring unreferenced snapshots with their runs after 90 days. Named versions are kept forever.

### 2. A shared CRDT draft, separate from version history

The live draft is a Yjs document. Version history is append-only rows. Concurrent keystrokes merge character by character in the CRDT, and saving a version is a compare-and-set on `head_version_id`. History stays linear and never contains a merge of two people's half-states that nobody reviewed.

Rejected alternatives:
- **Last-write-wins autosave** (`PATCH` the whole prompt): Alice's save erases Bob's sentence from two seconds earlier.
- **An edit lock**: a teammate who leaves a tab open blocks everyone, and stale-lock recovery becomes a product problem.
- **Git-style branches with merges**: prose merge conflicts are unpleasant to resolve in a browser, and most edits happen within the same minute in the same session.

The costs are sticky routing for the Collab Service, CRDT tombstone growth (handled by compaction), and the fact that a save includes collaborators' in-progress edits. The save dialog's attributed diff makes that last one visible, and "Fork to personal draft" exists for long solo experiments.

### 3. Executors decoupled from client connections through a per-run Redis Stream

The simplest design has the API process call the model and pipe tokens into the HTTP response. It breaks in three ways at this scale:
- **Refresh loses the generation.** The output is gone, or must be cancelled and paid for twice.
- **A deploy kills in-flight work.** Draining a node that holds 10-second streams takes minutes.
- **A second viewer can't attach.** A collaborator can't watch the same run.

Executors append coalesced chunks to `stream:{run_id}`, and gateways tail it. The log doubles as the resume buffer (`Last-Event-ID`) and as the fan-out point for multiple viewers. The cost is one extra hop (~1–2 ms per chunk), 210K appends/s on Redis at peak, and about 1.6 GB of buffered chunks. Coalescing at 50 ms instead of per token keeps the append rate at 20/s per stream instead of 50/s.

### 4. Worst-case cost reservation plus concurrency leases at admission

Cost is known only after generation. Checking "spent < budget" at admission and charging at completion lets every in-flight output pass the same check. A workspace with $1 left and 200 members each running 8 outputs admits 1,600 outputs (≈ $21 worst case at $0.013 each), which is 21× over budget. Instead, admission atomically reserves `input_tokens × input price + max_tokens × output price` against both the user and workspace budgets and takes one lease per output, in a single Lua script. Settlement replaces the reservation with the actual cost.

The cost is over-reservation: $0.013 reserved against $0.008 actually spent on average, about 1.6×. A user near the limit is therefore blocked slightly early. We soften this by offering to clamp `max_tokens` to what the remaining budget covers rather than refusing the run.

### 5. Threads as a message tree

Messages have `parent_id`, and a thread has an `active_leaf_id`. Editing turn 3 or regenerating a reply adds a sibling, so the user can flip between alternatives (`‹2/3›`) and nothing they compared is lost. A flat list with in-place edits destroys exactly the alternatives the user was comparing. Copying the whole thread per edit duplicates O(n) messages and loses the relationship between branches. The cost is that building the context requires walking parents to the root. Threads are small (< a few hundred messages), so the Prompt Service loads the whole tree and walks it in memory.

### 6. Workspace home regions

A workspace's data, draft owner, executors and stream logs live in its home region (US, EU or APAC). Users elsewhere connect through the nearest edge PoP and ride the backbone. That adds ~100–150 ms to chunk delivery for a cross-region collaborator, small next to a 300–1,000 ms TTFT, and keeps data residency, budget counters and version CAS in one region with no cross-region consensus on the hot path.

## Consistency and Idempotency

| Operation | Mechanism | Guarantee |
|---|---|---|
| Create run | `Idempotency-Key` claimed with `SET NX` in Redis (24 h) + unique index on `(user_id, idempotency_key, created_at)` | Double-click or client retry returns the same run, and budget is reserved once |
| Snapshot upsert | `INSERT … ON CONFLICT (prompt_id, content_hash) WHERE kind = 'snapshot' DO NOTHING` | Identical content maps to one snapshot |
| Save version | CAS on `head_version_id` + unique `(prompt_id, client_commit_id)` | No two "v8"s; a retried commit returns the original version |
| Move alias | `UPDATE … WHERE version_id = $expected` + audit row in the same transaction | Promotions never race silently |
| Start an output | Dispatch is at-least-once (consumer group); the executor claims with `UPDATE … SET status = 'streaming' WHERE status = 'queued'` | Exactly one executor calls the model per output |
| Finish an output | `UPDATE … WHERE status = 'streaming'`, then append `output.completed` | "Completed" is only emitted after the row is durable |
| Settle cost | Lua script guarded by `settled:{output_id}`; durable aggregate guarded by `usage_applied` | A replayed settlement never double-charges |
| Stream resume | SSE `id` = Redis Stream entry ID | Gap-free, duplicate-free replay within the 2-minute window |

**Ordering.** Within a run, the Redis Stream totally orders all panes' events. Within an output, `seq` lets the client drop duplicates after a resume. Across collaborators, the CRDT guarantees convergence, not intention preservation. Two people rewriting the same sentence produce a merged sentence, which is why the save dialog shows an attributed diff.

## Security / Auth

- **Authentication**: session cookies backed by Redis (`HttpOnly`, `Secure`, `SameSite=Lax`). The WebSocket upgrade and SSE requests carry the same cookie. API keys exist only for the inference API that production apps call with `prompt_id` + alias.
- **Authorization**: workspace RBAC. Viewers can read, run (against their own budget) and comment; editors can edit drafts and save versions; admins move aliases and set budgets. The Collab Service checks the role at connect time and drops write updates from viewers.
- **Untrusted model output**: outputs are rendered as sanitized Markdown, with no raw HTML, and links are shown with their target. Prompts and outputs are user content and are never interpolated into other users' pages without escaping.
- **Secrets in prompts**: on save, a scanner flags strings that look like API keys and warns before they enter immutable history, since an immutable version cannot be edited afterwards. Purging requires an admin "redact" operation that replaces the blob and records an audit event.
- **Abuse and cost**: request rate limits at the gateway (per session and per IP), cost budgets and concurrency leases in the Quota Service, and a hard cap of 4 panes and 1,000 outputs per evaluation.
- **Audit**: alias moves, budget changes, redactions and role changes are written to append-only audit tables.

## Observability

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `run_admission_duration_seconds` | Histogram | lane, result | The < 100 ms start-overhead SLO |
| `output_ttft_seconds` | Histogram | model, source (upstream / end-to-end) | Separates model latency from our relay latency |
| `chunk_relay_seconds` | Histogram | region | Executor append to SSE write |
| `streams_active` | Gauge | node | Gateway connection load |
| `sse_resumes_total` | Counter | outcome (replayed / snapshot / expired) | Reconnect health |
| `outputs_total` | Counter | model, status, finish_reason | Error and cancellation rates per model |
| `quota_rejections_total` | Counter | reason (user_budget / workspace_budget / concurrency) | Product signal on budget defaults |
| `reservation_ratio` | Histogram | model | Reserved ÷ actual cost; tunes `max_tokens` defaults |
| `circuit_breaker_state` | Gauge | model | Upstream health |
| `collab_connections` / `collab_updates_total` | Gauge / Counter | node | Doc-server load and hot prompts |
| `version_commit_conflicts_total` | Counter | — | How often CAS saves collide |

Logs are structured JSON (Pino) carrying `run_id`, `output_id`, `prompt_id` and `workspace_id`. Prompt and output text are never logged. A trace spans click → admission → dispatch → first upstream byte → first SSE byte, which shows directly whether a slow first token is ours or the model's.

**Alerts**: end-to-end TTFT minus upstream TTFT p99 > 150 ms; any model breaker open > 1 min; `outputs_total{status="failed"}` > 2% over 5 min; dispatch stream pending entries growing for 2 min; Redis memory > 70%.

## Failure Handling

| Failure | Detection | Response |
|---|---|---|
| Model returns 429/5xx before the first token | HTTP status | Retry up to 2 times with jittered backoff (200 ms, 400 ms); the user sees only a longer TTFT |
| Model fails after tokens were streamed | Stream error | Fail the output with `retryable: true` and keep the partial text. No automatic retry: a retry is a different sample and would splice two answers |
| Model persistently failing | Opossum breaker per model (opens at 50% errors over ≥ 20 calls in 30 s; half-open after 15 s) | That pane fails fast with "Model B unavailable"; other panes and the editor continue |
| Executor crashes mid-stream | Lease heartbeat missing for 15 s | Reaper marks the output `failed` (`executor_lost`), saves partial text from the stream log, settles observed tokens, and appends `output.failed`. Batch-lane outputs retry once |
| Redis shard holding `stream:{run_id}` fails over | Executor append error | Executor re-appends an `output.snapshot` with the full text so far to the new primary; clients replace the pane text |
| Stream Gateway node restarts | Client `EventSource` error | Browser reconnects with `Last-Event-ID` to any node; the replay is gap-free |
| Collab node crashes | WebSocket close | Ring reassigns the prompt; the new owner loads snapshot + update log; clients resync by state vector, and IndexedDB keeps their unsynced edits |
| PostgreSQL primary failover | Connection errors (~30 s) | Admission returns 503; in-flight executors buffer final writes and retry; editing continues in the CRDT |
| Redis quota cluster unavailable | Breaker on quota calls | Fail open with a per-node allowance (≤ 2 concurrent outputs and ≤ $0.50 per user per node) and reconcile from usage events afterwards. Never fail open for evaluations |
| Region outage | Health checks | Workspaces homed there fail over to the paired region's async replica (RPO of seconds); in-flight runs are marked failed after recovery |

## Scalability Considerations

### Horizontal Scaling Path

- **Prompt, Run and Stream Gateway services** are stateless and scale on CPU or connection count. At ~10K SSE connections per gateway node, 10,500 peak streams need 2 nodes per region; we run at least 4 for headroom and deploys.
- **Collab Service** scales by consistent hashing on `prompt_id`. At ~10K WebSockets per node, 50K sessions need 5 nodes; we run 8. A hot prompt (a workshop with 200 viewers) promotes extra viewers to a read-only broadcast tier fed by the owner node.
- **Executors** scale with concurrent generations, I/O-bound. At ~1,000 concurrent upstream streams per executor, 10,500 need ~11 executors per peak region.
- **Redis** is sharded by `run_id` for stream logs. 210K appends/s at ~50K appends/s per shard needs 5 shards, so we run 6. Quota keys sit in a separate small cluster so stream bursts cannot slow admission.
- **PostgreSQL** is sharded by `workspace_id` (a workspace and all its prompts, versions, runs and threads on one shard), with monthly partitions for runs and outputs and archival to object storage at 90 days. ~3K writes/s and 9 TB hot fits 8 shards per region with room to grow.

### What Breaks First

1. **Upstream model capacity.** We do not control it. Per-user concurrency leases and the separate batch lane keep a few users' evaluations from consuming the capacity interactive users need, and the interactive lane always dispatches first.
2. **The stream bus.** 210K appends/s at peak is the hottest write path. Coalescing at 100 ms instead of 50 ms halves it, at the cost of chunkier streaming.
3. **Run-history storage.** 100 GB/day. Partition drops and archival keep the hot set at ~9 TB.

### At 10×

At 10× (7,000 runs/s peak, 105,000 concurrent streams, 2.1M chunk appends/s, ~1 TB/day), executors stream directly to the gateway node holding the viewer over gRPC, and Redis keeps only a coarse resume log appended every 500 ms (210K appends/s at 10×, back to today's rate). Output text moves to a wide-column store or object storage, with PostgreSQL keeping only metadata, and each region adds a second cell (its own Redis, executors and gateways) behind the same edge.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Version model | Immutable, content-addressed versions; runs pinned | Mutable prompt row + counter | Reproducible runs and safe production pins |
| Draft editing | Yjs CRDT draft + CAS-committed versions | LWW autosave / edit locks | No lost keystrokes, linear history |
| Snapshot on run | Auto-snapshot of the displayed draft | Run only saved versions | "What ran" is always recoverable without forcing saves |
| Execution path | Executors + per-run Redis Stream | API process proxies the model directly | Refresh-safe, deploy-safe, multi-viewer |
| Run transport | One multiplexed SSE per run | WebSocket / one SSE per pane | One resume cursor; HTTP-native; avoids per-origin connection limits |
| Collab transport | WebSocket | SSE + POST | Bidirectional, high-frequency small updates |
| Cost control | Worst-case reservation + leases | Post-hoc metering | Hard budgets hold under concurrency |
| Retry after first token | Fail with partial, user retries | Automatic retry | A retry is a different sample and would splice outputs |
| Thread model | Message tree with active leaf | Flat list with in-place edits | Branches preserve compared alternatives |
| Context overflow | Reject with token breakdown | Silent truncation | A testing tool must not hide behavior |
| Diffing | Client-side on immutable versions | Server-side diff endpoint | Versions are cacheable forever; diff is cheap in a worker |
| Placement | Workspace home region | Active-active multi-region | No cross-region consensus on CAS or budgets |
| Batch evaluations | Separate lane via Kafka, per-user fair share | Same queue as interactive | Matrix runs can't starve interactive TTFT |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local implementation and how it maps to the production design above.

### Planned Local Architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                               Local Machine                                   │
│                                                                               │
│  ┌──────────────┐     ┌──────────────────┐     ┌──────────────────────────┐   │
│  │ Frontend     │────▶│ Load balancer    │────▶│ API instances            │   │
│  │ Vite :5173   │     │ :3000            │     │ :3001 :3002 :3003        │   │
│  │ React 19     │     │ (round robin)    │     │ prompts, runs, SSE       │   │
│  └──────┬───────┘     └──────────────────┘     └────────────┬─────────────┘   │
│         │ WebSocket                                         │                 │
│  ┌──────▼───────┐     ┌──────────────────┐     ┌────────────▼─────────────┐   │
│  │ Collab       │     │ Executors (×2)   │────▶│ Mock model               │   │
│  │ :3004 (Yjs)  │     │ health :3006-7   │     │ :3005, 50 tok/s          │   │
│  └──────┬───────┘     └────────┬─────────┘     └──────────────────────────┘   │
│         │                      │                                              │
│  ┌──────▼──────────────────────▼──────────────────────────────────────────┐   │
│  │ PostgreSQL :5432    Valkey :6379 (streams, quotas)    RabbitMQ :5672   │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────────┘
```

Running three API instances behind the load balancer is the point of the local setup. The browser's SSE connection usually lands on a different instance than the one that created the run, and executors are separate processes, so the Redis Stream hand-off is exercised on every run, not just in theory.

### Production Patterns Planned

| Pattern | Planned location | Why it matters at scale |
|---|---|---|
| Idempotent run creation | planned: `backend/src/shared/idempotency.ts` | Double-clicks and retries must not reserve budget or call the model twice |
| Exactly-once output claim | planned: `backend/src/executor/claim.ts` | At-least-once dispatch plus a conditional update gives one model call per output |
| Atomic reserve/settle (Lua) | planned: `backend/src/shared/quota.ts` | Budget checks must hold under concurrent admission |
| Circuit breaker per model (Opossum) | planned: `backend/src/shared/circuit-breaker.ts` | A failing model fails its pane fast instead of piling up executor sockets |
| Prometheus metrics (prom-client) | planned: `backend/src/shared/metrics.ts` | The TTFT split (ours vs the model's) is the key operational signal |
| Structured logging (Pino) | planned: `backend/src/shared/logger.ts` | Correlate a run across API, executor and gateway by `run_id`; never log prompt text |
| Health checks | planned: `/health/live`, `/health/ready` on every process | Ready only when PostgreSQL and Valkey are reachable; the LB stops routing during drain |
| Rate limiting | planned: `backend/src/shared/rate-limit.ts` | Request-level limits at the edge, separate from cost budgets |
| Resumable SSE | planned: `backend/src/stream/sse.ts` | `Last-Event-ID` replay from Valkey Streams |

The reservation is one Lua script per admission: drop expired leases, refuse if `leases + n > max_concurrent`, refuse if `spent + reserved + total` exceeds the user or the workspace limit (returning the remaining budget so the client can offer a smaller `max_tokens`), otherwise increment `reserved` on both hashes and add one lease per output. Settlement is a second script guarded by `settled:{output_id}`. In production the user and workspace hashes live in different cluster slots, so the script runs per key in a fixed order (user, then workspace) with compensation if the second step fails. Locally a single Valkey keeps it one call.

### What Will Be Simplified or Simulated

| Production | Local substitute | Impact |
|---|---|---|
| Model inference API | Mock model server (:3005): configurable tokens/s, TTFT, failure rate, fail-after-N-tokens, 429 injection; `MODEL_PROVIDER=http` can point at a real API | Real latency distributions and content quality are not represented |
| Tokenizer per model | Approximate count (characters ÷ 4) | Reservations are estimates locally |
| Kafka (eval jobs, usage events) | RabbitMQ with one queue per lane | No partition-level per-user fairness; fairness done in the scheduler |
| ClickHouse usage analytics | `usage_daily` in PostgreSQL | No OLAP queries over raw events |
| Redis Cluster (stream and quota clusters) | One Valkey instance | No slot constraints; quota script stays single-call |
| Sharded PostgreSQL + archival | One PostgreSQL with monthly partitions | Archival is a manual script |
| Edge PoPs, home regions | One region | Cross-region latency can be simulated with an injected delay on the collab socket |
| OAuth/SSO | Session login with seeded users | Same RBAC model |

### What Will Be Omitted

- CDN, multi-region replication, and regional failover
- Kubernetes and autoscaling of executors and gateways
- The read-only broadcast tier for very hot prompts
- Direct executor-to-gateway gRPC streaming (the 10× design)
- Model-graded evaluation and review/approval workflows
- Secret scanning beyond a simple regex

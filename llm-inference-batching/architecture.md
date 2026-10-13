# LLM Inference Batching - Architecture Design

## System Overview

A synchronous inference service that turns many independent caller requests into GPU batches and routes each result back to the caller that is waiting for it. The model is treated as a black box: a function that accepts up to 100 inputs and returns 100 outputs in about 100 ms, whether the batch holds 1 input or 100. Everything else is the design: an intake tier that holds each caller's connection open, a batcher that decides when a batch is ready to run, a router that spreads load across a GPU fleet, and failure handling for the cases that make batching hard (a partial batch failure, a hung GPU, a GPU that dies mid-batch, a queue that disappears).

This is the most frequently reported Anthropic system design prompt (candidate-reported; see [FUTURE_PROJECTS.md](../FUTURE_PROJECTS.md#sources)). The reported variants fix the batch time at 100 ms and then push on failure modes, fleet scaling, and mixed-model GPUs. One reported format asks the candidate to review a flawed design doc for this system, which is why this document closes its Key Design Decisions with a list of common flaws.

**Learning goals:**
- Derive the flush policy (full batch vs deadline) from throughput and latency math, not intuition
- Map synchronous callers onto asynchronous batch execution (request ID → waiting connection)
- Treat the caller's held connection, not the queue, as the durable copy of a synchronous request
- Track capacity, balance load, and fail over across a GPU fleet
- Understand why continuous batching replaces static batching for autoregressive generation

## Requirements

### Functional Requirements

1. **Synchronous inference** - A caller POSTs an input and blocks until it receives the output, an error, or its deadline passes
2. **Batching** - Concurrent requests for the same model are grouped into batches of up to 100 inputs
3. **Result routing** - Each output returns to exactly the caller that sent the input, even though the batch ran on another machine alongside 99 strangers
4. **Per-item outcomes** - A batch can partially fail; every request gets its own success or error
5. **Fleet routing** - Requests are spread across many GPU workers; the system knows which have capacity and fails over when one dies mid-batch
6. **Multiple models** - Requests are routed by model; low-traffic models can share a GPU with other models
7. **Operator console** - Live batch fill ratio, queue depth, p50/p99 latency, and GPU fleet health, plus drain, failover, and batch-policy controls
8. **Idempotent retries** - Clients may retry with an `Idempotency-Key`; a retry never computes or bills twice for one logical request

### Non-Functional Requirements

| Property | Target | Notes |
|----------|--------|-------|
| Latency | p50 ≈ 160 ms, p99 < 300 ms server-side at planned peak | 100 ms of every request is GPU compute |
| Throughput | 70,000 req/s peak, 35,000 req/s average | ~3.0B requests/day |
| Goodput | 99.9% of accepted requests answered within their deadline | A response after the deadline counts as a failure |
| Efficiency | Mean batch fill ≥ 60% at peak (planned 70%) | Fill ratio, not GPU busy time, is the efficiency metric |
| Failover | A dead GPU affects only its in-flight batch; routing moves away within 300 ms | Affected requests are retried if their deadline allows |
| Overload | Excess requests rejected in < 5 ms with 503 + Retry-After | Never queue a request that cannot finish before its deadline |

### Out of Scope

- Model internals, training, and kernel-level GPU optimization
- Distributing model weights to the fleet (see the planned Model Weight Distribution project)
- Token streaming to the client (discussed under continuous batching as the evolution)
- Billing and invoicing (the planned LLM API Platform project builds on this one)

## Capacity Estimation

### Assumptions

| Assumption | Value | Why it matters |
|------------|-------|----------------|
| Max batch size | 100 inputs | Model/GPU memory limit |
| Batch compute time | 100 ms, roughly constant regardless of fill | A forward pass is bound by reading the weights from GPU memory, so 1 input costs almost as much as 100 |
| Average input / output | 2 KB / 2 KB | Short prompts and short outputs (one forward pass per request) |
| Default client deadline | 1,000 ms | Callers set their own; the server caps it |
| Gather window (`max_wait_ms`) | 20 ms, applied only when the GPU is idle | Derived in Key Design Decisions |
| Network | 10 Gbps NICs | Used for the bandwidth check |
| GPU memory / model weights | 80 GB per GPU / 30 GB per model | Used for mixed-model placement |

### Per-GPU Numbers

| Metric | Calculation | Result |
|--------|-------------|--------|
| Max throughput | 100 inputs / 0.1 s | 1,000 req/s |
| Unbatched throughput | 1 input / 0.1 s | 10 req/s (batching is worth 100x) |
| Planned load | 70% of max | 700 req/s, average batch of 70 |
| Batches per second | 1 / 0.1 s when busy | 10 |
| Queue wait below saturation | arrivals wait for the in-flight batch to finish: uniform 0–100 ms | mean 50 ms, p99 ≈ 99 ms |
| End-to-end latency | wait + 100 ms compute + ~10 ms overhead | p50 ≈ 160 ms, p99 ≈ 210 ms |
| Admission cap | 1,000 ms deadline − 100 ms in-flight batch − 100 ms own compute = 800 ms; a full GPU drains 1 req/ms | 800 queued requests |

Why plan for 70% and not 90%: with Poisson arrivals at 700 req/s, a 100 ms window receives 70 requests on average with a standard deviation of √70 ≈ 8.4, so more than 100 arrivals (3.6σ) happens in about 0.02% of windows. At 900 req/s the mean is 90 with σ ≈ 9.5, and more than 100 arrivals (1.05σ) happens in about 15% of windows. The overflow waits an extra 100 ms, pushes into the next window, and p99 climbs past 300 ms well before the GPU is "full".

### Fleet Numbers (Production)

| Metric | Calculation | Result |
|--------|-------------|--------|
| Peak / average traffic | given | 70,000 / 35,000 req/s |
| Daily requests | 35,000 × 86,400 | ≈ 3.0B/day |
| Lower bound on GPUs | 70,000 / 1,000 | 70 GPUs at 100% fill |
| Planned GPUs at peak | 70,000 / 700 | 100 GPUs |
| GPUs without batching | 70,000 / 10 | 7,000 GPUs |
| Batches per second | 100 GPUs × 10 | 1,000 batches/s, average size 70 at peak |
| In-flight requests (Little's law) | 70,000 req/s × 0.16 s | ≈ 11,200 |
| Intake tier | 10 nodes × 7,000 req/s | ≈ 1,120 held connections per node |
| Pending-request memory | 11,200 × ~3 KB (payload + bookkeeping) | ≈ 34 MB fleet-wide |
| Bandwidth | 70,000 × 2 KB | 140 MB/s ≈ 1.12 Gbps each direction (~11% of one 10 Gbps NIC) |
| Per-GPU bandwidth | 700 × 2 KB | 1.4 MB/s, negligible |
| Losing 10 GPUs | 70,000 / 90 | 778 req/s per GPU (78% fill); remaining ceiling 90,000 req/s = 1.29x peak |

The network and the intake tier are nowhere near their limits. The GPU is the only expensive resource, and every design decision below is about keeping its batches full without making callers wait.

### Storage Estimates

| Data | Calculation | Result |
|------|-------------|--------|
| Request log (ClickHouse, metadata only) | 3.0B rows/day × ~100 B | ≈ 300 GB/day raw, ~30 GB/day compressed (10:1); 30-day TTL ≈ 900 GB |
| Batch log (ClickHouse) | ≤ 1,000 batches/s × 86,400 × ~200 B | ≤ 86.4M rows/day, ≈ 17 GB/day raw |
| Idempotency result cache (Redis) | worst case every request keyed: 70,000 × 30 s × 2 KB | ≈ 4.2 GB |
| Control plane (PostgreSQL) | models, workers, placements, audit | MBs |

Request and response bodies are never persisted. A synchronous request lives in memory for its ~160 ms lifetime and then exists only as a metadata row.

### Latency Budget (p99, below saturation)

| Stage | Budget |
|-------|--------|
| Gateway: TLS, auth, rate limit | 3 ms |
| Intake: admission + routing | 1 ms |
| Network to worker and back | 2 ms |
| Queue wait (worst case: just missed a batch) | 100 ms |
| GPU compute | 100 ms |
| Serialization + response write | 4 ms |
| **Total** | **~210 ms** (SLO 300 ms leaves room for variance) |

### Local Development Scale

Three simulated GPU workers give 3,000 req/s of theoretical capacity. A laptop load generator reaches ~2,000 req/s, which is enough to push one worker past saturation and watch the admission cap, fill ratio, and p99 react.

## High-Level Architecture

```
                         ┌──────────────────────────────────────┐
                         │ Clients: SDK with deadline,          │
                         │ Idempotency-Key, bounded retries     │
                         └──────────────────┬───────────────────┘
                                            │ POST /v1/infer (connection held open)
                         ┌──────────────────▼───────────────────┐
                         │ Global LB ─▶ API Gateway             │
                         │ TLS · API-key auth · tenant limits   │
                         └──────────────────┬───────────────────┘
               ┌────────────────────────────┼─────────────────────────────┐
     ┌─────────▼─────────┐        ┌─────────▼─────────┐         ┌─────────▼─────────┐
     │ Intake node 1     │        │ Intake node 2     │   ...   │ Intake node 10    │
     │ waiter map        │        │ waiter map        │         │ waiter map        │
     │ admission control │        │ admission control │         │ admission control │
     │ router (P2C)      │        │ router (P2C)      │         │ router (P2C)      │
     └─────────┬─────────┘        └─────────┬─────────┘         └─────────┬─────────┘
               └─────── InferItem ─▶ ───────┬────── ◀─ InferResult ───────┘
               ┌────────────────────────────┼─────────────────────────────┐
     ┌─────────▼─────────┐        ┌─────────▼─────────┐         ┌─────────▼─────────┐
     │ GPU worker 001    │        │ GPU worker 002    │   ...   │ GPU worker 100    │
     │ batcher queue     │        │ batcher queue     │         │ batcher queue     │
     │ executor + GPU    │        │ executor + GPU    │         │ executor + GPU    │
     │ model A           │        │ model A           │         │ model B + C       │
     └─────────┬─────────┘        └─────────┬─────────┘         └─────────┬─────────┘
               └───── heartbeats (1 s) ─────┬──── load + queue depth ─────┘
                                            │
     ┌───────────────────┐        ┌─────────▼─────────┐         ┌───────────────────┐
     │ Operator Console  │─admin─▶│ Fleet Manager     │────────▶│ PostgreSQL        │
     │ React SPA         │◀──SSE──│ registry · drain  │         │ models · workers  │
     │                   │        │ placement · scale │         │ placements · audit│
     └───────────────────┘        └─────────┬─────────┘         └───────────────────┘
                                            │ membership snapshots ─▶ intake routers
     ┌───────────────────┐        ┌─────────▼─────────┐         ┌───────────────────┐
     │ Prometheus        │        │ Redis Cluster     │         │ ClickHouse        │
     │ metrics · alerts  │        │ idempotency, load │         │ request/batch logs│
     └───────────────────┘        └───────────────────┘         └───────────────────┘
```

**Data path:** client → gateway → intake node (registers a waiter, runs admission, picks a worker) → GPU worker (queues, batches, executes) → result back over the same gRPC stream → intake resolves the waiter → HTTP response.

**Control path:** workers heartbeat load to the Fleet Manager; the Fleet Manager owns membership (who is active, draining, or dead), model placement, and autoscaling, and pushes versioned membership snapshots to every intake router. The operator console reads aggregated metrics over SSE and issues drain, failover, and policy changes through the Fleet Manager.

**Why batching lives on the worker, not in a central service:** the batcher must know exactly when its GPU is free, how much memory is left, and (with continuous batching) the state of every running sequence. That knowledge exists only on the GPU host. The intake tier decides *which* GPU; the worker decides *when* and *with whom*.

## Core Components / Request Flows

### 1. Intake Service

Stateless apart from in-memory waiters. Responsibilities:
- Assign a request ID (UUIDv7) and compute the absolute deadline: `now + min(timeout_ms, tenant.max_timeout_ms)`
- Validate the input (size, model exists, schema) so malformed inputs never reach a batch
- Deduplicate on `Idempotency-Key` (coalesce onto an in-flight request or return a cached result)
- Run admission control: reject with 503 if no worker can finish the request before its deadline
- Register a waiter in the **pending map** and hand the request to the embedded router
- Resolve the waiter on the first result, timeout, or cancellation, and write the HTTP response

```typescript
// Async-to-sync mapping on an intake node (sketch)
const pending = new Map<string, Waiter>();   // request_id → waiting HTTP response

async function handleInfer(req: Request, res: Response) {
  const id = uuidv7();
  const deadline = Date.now() + Math.min(req.body.timeout_ms ?? 1000, MAX_TIMEOUT_MS);
  const outcome = await new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => settle(id, DEADLINE_EXCEEDED), deadline - Date.now());
    pending.set(id, { resolve, timer, deadline, attempt: 1, workerId: null });
    router.dispatch({ id, model: req.body.model, input: req.body.input, deadline });
  });
  res.status(outcome.status).json(outcome.body);
}

function settle(id: string, outcome: Outcome) {    // first outcome wins
  const waiter = pending.get(id);
  if (!waiter) return metrics.lateResults.inc();      // already timed out, cancelled, or a duplicate
  pending.delete(id);
  clearTimeout(waiter.timer);
  waiter.resolve(outcome);
}
```

The reply comes back on the same gRPC stream that carried the request, so there is no lookup of "which intake node holds request X". When the transport is a broker instead (the local build), each request carries `reply_to = intake_instance_id` and results are published to one channel per intake instance, never one channel per request. At 70,000 req/s, per-request channels would mean 70,000 subscribe/unsubscribe operations per second on the broker for no benefit.

### 2. Router (embedded in each intake node)

A library, not a separate hop. It holds the latest membership snapshot (ready workers per model) and two load signals per worker: its **own** outstanding requests to that worker (exact, updated on every send and result) and the worker's last reported queue depth (piggybacked on every result and on heartbeats). It picks a worker with **power of two choices** and skips workers that are draining, suspect, or have an open circuit breaker.

```typescript
function pickWorker(model: string): Worker | null {
  const pool = membership.ready(model);           // excludes draining / suspect / breaker-open
  if (pool.length === 0) return null;
  const a = pool[randomInt(pool.length)];
  const b = pool[randomInt(pool.length)];
  return estimatedLoad(a) <= estimatedLoad(b) ? a : b;  // my outstanding + last reported queue depth
}
```

### 3. GPU Worker: Batcher and Executor

One process per GPU. The batcher owns a deadline-ordered queue per model it serves and keeps one batch in flight while staging the next one, so there is no idle gap between batches.

```typescript
// Flush policy: dispatch when the GPU is free AND (batch is full OR oldest waited ≥ max_wait)
function shouldDispatch(q: Queue, gpuFree: boolean, now: number): boolean {
  if (!gpuFree || q.length === 0) return false;
  if (q.length >= MAX_BATCH) return true;                  // full
  return now - q.oldest().enqueuedAt >= MAX_WAIT_MS;       // 20 ms gather window
}

function formBatch(q: Queue, now: number): Item[] {
  const batch: Item[] = [];
  while (batch.length < MAX_BATCH && q.length > 0) {
    const item = q.popEarliestDeadline();
    if (item.cancelled) continue;                                    // caller went away
    if (item.deadline - now < EXPECTED_BATCH_MS) { expire(item); continue; } // cannot finish in time
    batch.push(item);
  }
  return batch;
}
```

The executor runs the batch, then returns one result per item with a per-item status (`OK`, `ITEM_ERROR` with a retryable flag). Expired or cancelled items never occupy a batch slot. A watchdog fires if a batch exceeds 300 ms (3x the expected 100 ms), marks the worker suspect, and stops accepting new work.

### 4. Fleet Manager (Control Plane)

- **Membership:** registers workers with an incrementing `epoch`, ingests heartbeats (1 s), and moves workers through `provisioning → active → draining → drained` or `→ suspect → dead`
- **Distribution:** publishes a versioned membership snapshot to every intake router on change and every 5 s. Routers keep the last snapshot if the Fleet Manager is unreachable (static stability)
- **Placement:** decides which models load on which GPUs, and when to co-locate low-traffic models
- **Autoscaling:** scales each model's pool on fill ratio and admission rejections, keeping 30% headroom because a new GPU needs minutes to provision and load weights
- **Operator actions:** drain, undrain, forced failover, batch-policy changes; each is idempotent and audited

### 5. Operator Console and Metrics

A React SPA that subscribes to a 1 Hz SSE stream of pre-aggregated fleet metrics: per-worker fill ratio, queue depth, state, and fleet-wide latency percentiles computed from merged histograms (percentiles from different workers cannot be averaged). Drain and failover buttons call the admin API and show server-confirmed state transitions, never optimistic ones.

### Request Flow: Happy Path

1. Client sends `POST /v1/infer` with `model`, `input`, `timeout_ms: 1000`, and an `Idempotency-Key`
2. Gateway authenticates the API key and checks the tenant's token bucket
3. Intake validates the input, checks the idempotency key in Redis (`SET NX`), and registers a waiter
4. Admission: the router estimates completion time on the best candidate (`queue_depth / 1,000 req/s + 100 ms in-flight + 100 ms compute`); if that exceeds the deadline it rejects with 503 immediately
5. Router picks a worker with P2C and sends `InferItem` (with absolute deadline and attempt number) on its stream
6. The worker enqueues the item; the next time its GPU frees up, the item joins a batch of up to 100
7. After ~100 ms the executor returns per-item results; the worker sends each `InferResult` (with its current queue depth) back on the stream it arrived on
8. Intake settles the waiter, stores the result under the idempotency key for 30 s, logs metadata, and responds 200

### Request Flow: GPU Dies Mid-Batch

1. Worker 017 is running a batch of 70; its process crashes (stream breaks immediately) or its GPU hangs (watchdog fires at 300 ms)
2. Every intake node with outstanding requests on worker 017 learns this from its own stream; the router marks 017 suspect locally and stops sending to it
3. Each intake node walks its pending map for `workerId = 017` and, per request, retries on another worker if the remaining deadline is ≥ 250 ms and the pool's retry budget allows; otherwise it settles the waiter with 503 (retryable)
4. The Fleet Manager confirms via missed heartbeats, marks 017 dead, bumps its epoch, and publishes a new snapshot
5. If 017's results arrive late (a zombie), intake drops them: the waiter is gone or already settled

## Database Schema

### PostgreSQL (Control Plane)

```sql
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  tier            TEXT NOT NULL DEFAULT 'standard'
                  CHECK (tier IN ('standard', 'priority', 'bulk')),
  rate_limit_rps  INTEGER NOT NULL DEFAULT 100 CHECK (rate_limit_rps > 0),
  max_in_flight   INTEGER NOT NULL DEFAULT 200 CHECK (max_in_flight > 0),
  max_timeout_ms  INTEGER NOT NULL DEFAULT 30000 CHECK (max_timeout_ms BETWEEN 200 AND 120000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_prefix  TEXT NOT NULL,                 -- first 8 characters, shown in the console
  key_hash    TEXT NOT NULL UNIQUE,          -- SHA-256 of the full key; the key itself is never stored
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX idx_api_keys_tenant_active ON api_keys(tenant_id) WHERE revoked_at IS NULL;

CREATE TABLE models (
  id                 TEXT PRIMARY KEY,       -- 'model-a', 'model-b'
  version            TEXT NOT NULL,
  weights_uri        TEXT NOT NULL,
  weights_gb         NUMERIC(6,1) NOT NULL CHECK (weights_gb > 0),
  max_batch_size     INTEGER NOT NULL DEFAULT 100 CHECK (max_batch_size BETWEEN 1 AND 1024),
  max_wait_ms        INTEGER NOT NULL DEFAULT 20 CHECK (max_wait_ms BETWEEN 0 AND 1000),
  expected_batch_ms  INTEGER NOT NULL DEFAULT 100 CHECK (expected_batch_ms > 0),
  watchdog_ms        INTEGER NOT NULL DEFAULT 300,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'deprecated', 'disabled')),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (watchdog_ms > expected_batch_ms)
);

CREATE TABLE gpu_workers (
  id                 TEXT PRIMARY KEY,       -- 'gpu-017'
  host               TEXT NOT NULL,
  rpc_endpoint       TEXT NOT NULL UNIQUE,
  zone               TEXT NOT NULL,
  gpu_memory_gb      INTEGER NOT NULL CHECK (gpu_memory_gb > 0),
  status             TEXT NOT NULL DEFAULT 'provisioning'
                     CHECK (status IN ('provisioning', 'active', 'draining', 'drained', 'suspect', 'dead')),
  epoch              BIGINT NOT NULL DEFAULT 1,      -- bumped on every (re)registration; fences zombies
  version            INTEGER NOT NULL DEFAULT 1,     -- optimistic concurrency for operator actions
  last_heartbeat_at  TIMESTAMPTZ,
  status_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_workers_status ON gpu_workers(status);
CREATE INDEX idx_workers_zone_status ON gpu_workers(zone, status);

CREATE TABLE model_placements (
  worker_id   TEXT NOT NULL REFERENCES gpu_workers(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL REFERENCES models(id),
  state       TEXT NOT NULL DEFAULT 'loading' CHECK (state IN ('loading', 'ready', 'unloading')),
  weight      NUMERIC(3,2) NOT NULL DEFAULT 1.00 CHECK (weight > 0 AND weight <= 1),  -- GPU-time share when co-located
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, model_id)
);
CREATE INDEX idx_placements_model_state ON model_placements(model_id, state);

CREATE TABLE operator_actions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT NOT NULL UNIQUE,     -- a double-clicked drain is applied once
  actor            TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN
                   ('drain', 'undrain', 'fail_over', 'set_batch_policy', 'place_model', 'unplace_model')),
  worker_id        TEXT REFERENCES gpu_workers(id),
  model_id         TEXT REFERENCES models(id),
  params           JSONB NOT NULL DEFAULT '{}',
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX idx_actions_worker_time ON operator_actions(worker_id, created_at DESC);

CREATE TABLE fleet_events (
  id          BIGSERIAL PRIMARY KEY,
  worker_id   TEXT NOT NULL REFERENCES gpu_workers(id),
  event_type  TEXT NOT NULL CHECK (event_type IN ('registered', 'heartbeat_lost', 'watchdog_timeout',
              'stream_broken', 'drain_started', 'drained', 'marked_dead', 'recovered')),
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fleet_events_worker_time ON fleet_events(worker_id, created_at DESC);
```

### ClickHouse (Request and Batch Logs)

```sql
CREATE TABLE request_log (
  request_id       UUID,
  tenant_id        UUID,
  model_id         LowCardinality(String),
  idempotency_key  Nullable(String),
  status           LowCardinality(String),   -- ok, rejected, deadline_exceeded, item_failed, cancelled
  attempts         UInt8,
  batch_id         Nullable(UUID),
  worker_id        LowCardinality(String),
  queue_ms         UInt32,
  compute_ms       UInt32,
  total_ms         UInt32,
  input_bytes      UInt32,
  output_bytes     UInt32,
  received_at      DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toDate(received_at)
ORDER BY (model_id, received_at)
TTL toDateTime(received_at) + INTERVAL 30 DAY;

CREATE TABLE batch_log (
  batch_id        UUID,
  worker_id       LowCardinality(String),
  model_id        LowCardinality(String),
  size            UInt16,
  max_size        UInt16,
  flush_reason    Enum8('full' = 1, 'backlog' = 2, 'gather_timeout' = 3, 'drain' = 4),
  oldest_wait_ms  UInt32,
  compute_ms      UInt32,
  status          Enum8('ok' = 1, 'partial' = 2, 'failed' = 3, 'watchdog' = 4, 'worker_lost' = 5),
  failed_items    UInt16,
  dispatched_at   DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toDate(dispatched_at)
ORDER BY (model_id, worker_id, dispatched_at)
TTL toDateTime(dispatched_at) + INTERVAL 14 DAY;
```

`flush_reason` distinguishes a batch that filled (`full`), one that formed while the GPU was busy and dispatched the moment it freed (`backlog`), and one dispatched by the 20 ms gather window on an idle GPU (`gather_timeout`). A pool where most batches are `gather_timeout` is over-provisioned.

### Redis Keys

```
idem:{tenantId}:{key}     STRING   request_id while in flight, then the serialized result    TTL 30 s after completion
ratelimit:{tenantId}      HASH     token bucket: tokens, last_refill                          TTL 60 s idle
worker:{workerId}:load    HASH     queue_depth, in_flight, fill_ratio_1m, epoch, reported_at   TTL 3 s
fleet:membership          STRING   versioned snapshot of ready workers per model              no TTL
results:{intakeId}        PUB/SUB  per-intake result channel (local build only)
queue:{modelId}           STREAM   shared request queue, consumer group "workers" (local build only)
```

## API Design

### Public API

```
POST /v1/infer              → Synchronous inference; blocks until result, rejection, or deadline
GET  /v1/models             → Models available to this tenant, with max batch size and status
```

Request:

```http
POST /v1/infer
Authorization: Bearer sk_live_...
Idempotency-Key: 7f9c2e10-...
Content-Type: application/json

{ "model": "model-a", "input": "Classify: the package arrived late", "timeout_ms": 1000 }
```

Responses:

```json
200 { "request_id": "0192...", "model": "model-a", "output": "complaint",
      "timing": { "queue_ms": 47, "compute_ms": 101, "total_ms": 158 }, "attempts": 1 }
422 { "error": "input_too_large", "limit_bytes": 16384 }
429 { "error": "rate_limited" }                                     (Retry-After: 1)
503 { "error": "overloaded", "retryable": true }                    (Retry-After: 1)
504 { "error": "deadline_exceeded", "stage": "queue" }
500 { "error": "inference_failed", "retryable": false }
```

| Status | Meaning | Client should |
|--------|---------|---------------|
| 200 | Result | Use it |
| 422 | Input can never succeed | Fix the input; never retry |
| 429 | Tenant rate limit | Back off per Retry-After |
| 503 | Admission rejected or worker lost and no retry possible | Retry with the same Idempotency-Key and jittered backoff |
| 504 | Deadline passed | Retry only if the caller still has time |
| 500 | Item failed deterministically after one server retry | Do not retry |

### Internal RPC (gRPC, intake ↔ worker)

```
service GpuWorker {
  rpc Submit(stream InferItem) returns (stream InferResult);  // one long-lived stream per intake node
  rpc Cancel(CancelRequest) returns (Ack);                    // caller disconnected
  rpc Drain(DrainRequest) returns (DrainStatus);              // stop accepting, finish in-flight
}
InferItem   { request_id, model_id, input, deadline_unix_ms, attempt, tenant_tier }
InferResult { request_id, batch_id, status (OK | ITEM_ERROR | EXPIRED | REJECTED),
              output, error_code, retryable, queue_ms, compute_ms, worker_queue_depth, worker_epoch }
```

### Admin API (operator console)

```
GET  /api/v1/admin/fleet                      → Workers with state, models, queue depth, fill ratio
GET  /api/v1/admin/stream                     → SSE: 1 Hz aggregated metrics snapshot
GET  /api/v1/admin/batches?worker=&status=    → Recent batches from ClickHouse
POST /api/v1/admin/workers/:id/drain          → Stop routing to the worker; finish in-flight batches
POST /api/v1/admin/workers/:id/undrain        → Return a drained worker to service
POST /api/v1/admin/workers/:id/fail-over      → Mark dead now; retry its in-flight requests elsewhere
PUT  /api/v1/admin/models/:id/batch-policy    → Change max_batch_size / max_wait_ms
POST /api/v1/admin/placements                 → Load a model onto a worker
GET  /api/v1/admin/actions                    → Audit log of operator actions
```

Mutating admin calls require an `Idempotency-Key` and an `If-Match` header with the worker's `version`, so two operators acting on the same GPU cannot silently overwrite each other.

## Key Design Decisions

### 1. Flush Policy: Work-Conserving with a 20 ms Gather Window

**Chosen:** dispatch when the GPU is free **and** either 100 requests are waiting or the oldest has waited 20 ms.

Because a batch costs 100 ms whether it holds 1 input or 100, the question is never "how long should we wait to fill a batch" in isolation. It is "what else could the GPU be doing". Two regimes fall out:

- **GPU busy (any load above ~8 req/s per GPU):** requests accumulate during the in-flight batch. When the GPU frees, the oldest waiter has already waited longer than 20 ms, so the batch dispatches immediately with everything that arrived. Batch size self-adjusts to `arrival rate × 100 ms`: 70 at 700 req/s, 10 at 100 req/s. The gather window is irrelevant here.
- **GPU idle:** the first request starts a 20 ms window. Traffic is bursty (a client fanning out 50 requests in a loop), and dispatching the first one alone locks the GPU for 100 ms while the other 49 queue behind it, finishing at ~200 ms. Waiting 20 ms puts all 50 in one batch finishing at ~120 ms. The first request pays 20 ms; the other 49 save about 80 ms each.

**Rejected: wait for a full batch.** At 700 req/s a batch fills in 100 ms, which looks fine. At 100 req/s it takes 1 s, which blows the 1 s deadline on its own. At 1 req/s it takes 100 s, and the last request in a trickle waits forever. Full-batch-only couples latency to traffic volume, which is exactly backwards for a synchronous API.

**Rejected: a fixed timer that flushes every T ms regardless of GPU state.** If the GPU is busy when the timer fires, the batch cannot run anyway; if it is idle, a fixed timer adds up to T ms of pointless waiting. Tying the decision to GPU state is strictly better.

**What we give up:** at low load, batches are small and the GPU spends its 100 ms on, say, 10 inputs. That is not waste on a dedicated GPU (it would otherwise idle), but it is a signal: a pool whose fill ratio stays under 30% should shrink or share its GPUs with another model.

### 2. The Caller's Connection Is the Durable Copy

**Chosen:** in-memory queues on workers, in-memory waiters on intake nodes, no durable broker on the data path.

A synchronous request is only useful while its caller is waiting, at most about 1 s. If a worker's queue disappears, the intake node that sent those requests still holds every waiter and knows which worker each one went to, so it can re-dispatch them within the deadline. If an intake node dies, its callers see a dropped connection and retry with the same `Idempotency-Key`. Either way, recovery comes from someone who is still waiting.

**Rejected: a durable broker (Kafka, a persisted Redis Stream) as the request queue.** It adds 2–10 ms of write latency to every request and buys nothing. After a broker outage it replays requests whose callers gave up long ago, so the fleet spends its first post-recovery minutes computing answers nobody will read while live traffic times out behind them. Durability is valuable for async jobs (see the [Job Scheduler](../job-scheduler/) project); for a 1 s synchronous call it is negative.

**What we give up:** a worker crash loses its queued requests, so they must be re-sent, and recovery depends on intake nodes tracking which worker holds which request. That bookkeeping is the pending map we need anyway.

### 3. Push to Per-GPU Batchers with Power-of-Two-Choices Routing

**Chosen:** intake routers push each request to a specific worker, chosen by P2C on estimated load. Each worker batches its own queue.

| Option | Capacity tracking | Batch fill | Failure domain | Path to continuous batching |
|--------|-------------------|-----------|----------------|-----------------------------|
| ✅ Push + P2C, batch on worker | Router-local outstanding counts + piggybacked queue depth | Per-GPU queues | Only the dead worker's in-flight requests | Natural: the worker already owns scheduling |
| ❌ Shared per-model queue, GPUs pull | Implicit: free GPUs pull | Best (fleet-wide pool) | The queue is a single failure domain for the model | Poor: admission needs per-GPU memory state |
| ❌ Round robin | None | Per-GPU | Slow GPUs keep receiving traffic | Same as push |
| ❌ Global least-loaded | Needs fresh global state | Per-GPU | Herding on stale data | Same as push |

Pull from a shared queue is attractive because "which GPU has capacity" answers itself: a free GPU asks for work. It is what the local build uses (Redis Streams consumer groups), and it is a reasonable first version for a small fleet. At production scale it puts 70,000 req/s through one more component per model, makes that component's failure a full-model outage, and cannot express continuous batching, where admission depends on each GPU's free KV-cache memory. P2C needs only two random samples and stays robust when load data is a second stale. Picking the global minimum on stale data sends every router to the same "least loaded" worker at once.

### 4. Deadline-Aware Admission Instead of an Unbounded Queue

A request that cannot finish before its deadline should be rejected in 1 ms, not after holding a connection for 1 s. Each GPU drains 1 request per ms at full batches, so a request that arrives behind 800 others on a GPU with a 1 s deadline will miss it (800 ms of queue + up to 100 ms for the in-flight batch + 100 ms of its own compute). The router computes `estimated_completion = queue_depth / 1,000 + 0.1 + 0.1` seconds for its P2C pick and rejects with 503 + Retry-After if it exceeds the remaining deadline. Without this, overload converts into 100% timeouts: every request waits its full deadline, the GPU computes results for callers that already left, and goodput collapses to near zero while the GPU reports 100% busy.

### 5. Dedicated Model Pools by Default; Co-locate Only Low-Traffic Models

A batch can contain only one model, because every input in a batch runs through the same weights. Mixed-model GPUs therefore keep one queue per model and a scheduler that chooses which model's batch runs next.

- **High-traffic models get dedicated pools.** No contention, and the flush policy stays simple.
- **Low-traffic models are co-located** when their weights fit: two 30 GB models use 60 GB of an 80 GB GPU, leaving 20 GB for activations. The worker scheduler picks the next batch by earliest deadline, weighted by each placement's `weight`. Here the gather window has a real opportunity cost: running a 10%-full batch of model B delays a full batch of model A by 100 ms.
- **Never swap weights per batch.** Loading 30 GB from host memory over a ~25 GB/s link takes ~1.2 s, the time of 12 batches (1,200 requests of capacity at full fill). From object storage at 10 Gbps (1.25 GB/s) it takes ~24 s. Placement changes happen on a minutes timescale, driven by the Fleet Manager.

### 6. Continuous Batching as the Production Evolution

Everything above assumes one forward pass per request. Autoregressive generation runs one forward pass per output token, and outputs differ wildly in length. With **static batching**, a batch runs until its longest sequence finishes: if outputs average 200 tokens with a maximum of 1,000, each slot does useful work for 200 of 1,000 steps, so slot utilization is 20%, and a new request waits for the whole batch to drain.

**Continuous (iteration-level) batching** re-forms the batch at every decode step. Finished sequences leave, and waiting requests join after their prefill. Slots stay full, which is the source of the large throughput gains reported for production LLM servers. The design changes in four ways:

1. **Admission becomes memory-bound, not count-bound.** The limit is free KV-cache blocks (paged attention), so the worker admits a request only if it can hold its prompt plus expected output, and preempts (swap or recompute) when memory runs out.
2. **The scheduler must live on the GPU host.** It decides every ~tens of ms which sequences run, which is why decision 3 puts batching on the worker.
3. **Latency splits into TTFT and inter-token latency.** Long prefills stall everyone's decode step, so prefills are chunked.
4. **The sync response becomes a stream** (SSE), and cancellation now frees real capacity, because a cancelled sequence leaves the batch at the next step.

The intake tier, waiter map, admission control, P2C routing, and failover in this design carry over unchanged; only the worker's batcher is replaced.

### 7. Common Flaws When Reviewing a Batched-Inference Design Doc

One reported interview format is a review of a short design doc. These are the flaws worth checking for, roughly in order of impact:

1. **"Wait until the batch has 100 requests."** No deadline, so it starves at low traffic
2. **Capacity planned at 100% fill** ("10 GPUs × 1,000 req/s = 10,000 req/s"). Queues grow without bound near saturation; plan at ~70% (10,000 / 700 ≈ 14.3, so 15 GPUs before failure headroom)
3. **Unbounded queue, no admission control.** Overload becomes 100% timeouts instead of fast 503s
4. **Durable broker for synchronous requests.** Adds latency, replays stale work after an outage
5. **Results delivered by polling a database or by per-request pub/sub channels.** Wasteful at 70,000 req/s; reply on the request's stream or a per-node channel
6. **One timeout for everything.** A per-request deadline (when to give up on the caller) and a per-batch watchdog (when to declare the GPU unhealthy) are different clocks
7. **Whole-batch retry on failure.** A poison input takes down every batch it is retried in
8. **No deadline propagation.** Workers compute results for callers who already left
9. **Health check is "process is alive."** A hung GPU passes it; use batch progress
10. **Mixed models in one batch, or weight swaps per batch**
11. **Efficiency measured as GPU busy %.** A GPU running 5%-full batches is 100% busy; measure fill ratio and goodput

## Consistency and Idempotency

### Delivery Semantics

Inference is a side-effect-free computation, so the system is **at-least-once on compute and at-most-once on delivery**: a request may run on two GPUs (an original on a presumed-dead worker plus a retry), but its waiter is settled exactly once. The first result wins; later results are dropped and counted as `late_results`. With sampling enabled, two attempts may produce different outputs; the caller sees only one, which is acceptable because either was a valid answer.

### Idempotency Keys

| Situation | Behavior |
|-----------|----------|
| New key | `SET idem:{tenant}:{key} {request_id} NX PX 60000`; proceed |
| Same key, original still in flight on this intake node | Attach a second waiter to the existing request (coalescing); no second computation |
| Same key, original in flight on another node | Wait up to the remaining deadline for the result to appear, polling the key at 20 ms intervals, or return 409 with Retry-After |
| Same key, completed within 30 s | Return the cached result |
| Same key, different request body | 422: an idempotency key cannot be reused for a different input |

Usage is metered once per `request_id` on the first successful settle, never per attempt, so retries and duplicate computations are not billed.

### Server-Side Retry Rules

- At most **one** server-side retry per request, on a different worker
- Only for retryable causes: worker lost, watchdog timeout, transient item error
- Only if the remaining deadline is ≥ 250 ms (up to 100 ms waiting for the in-flight batch + 100 ms compute + overhead)
- Subject to a **retry budget**: retries may not exceed 10% of a pool's requests over a 1-minute window. If a whole pool is failing (a bad rollout), retries stop and requests fail fast instead of doubling load on a sick fleet

### Zombie Fencing

When a worker is marked dead, the Fleet Manager bumps its `epoch`. A worker that comes back must re-register to receive traffic. Results carry `worker_epoch`; the waiter map's first-result-wins rule already makes late results harmless, and the epoch keeps a zombie from re-entering the membership snapshot or reporting stale load.

## Security / Auth

- **API keys:** stored as SHA-256 hashes with a display prefix; checked at the gateway, cached for 60 s
- **Tenant limits:** a token bucket per tenant (requests/s) plus a per-tenant in-flight cap enforced on each intake node (the tenant's cap divided by the number of intake nodes), so one tenant cannot fill the queues and starve others
- **Priority tiers:** batch formation orders by deadline; the `bulk` tier gets longer default deadlines and is shed first under admission pressure
- **Input limits:** max input size enforced at intake (16 KB default) as both DoS protection and poison-input prevention
- **Service-to-service:** mTLS between intake and workers; workers accept streams only from known intake identities
- **Operator console:** SSO with two roles: `viewer` (read metrics) and `operator` (drain, fail over, change policy). Every mutation is written to `operator_actions` with actor and reason
- **Privacy:** request and response bodies are never logged; `request_log` stores sizes and timings only

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `batch_fill_ratio` | Histogram | model, worker | The efficiency metric; drives autoscaling |
| `batch_flush_total` | Counter | model, reason (full / backlog / gather_timeout / drain) | Shows which regime a pool runs in |
| `batch_compute_seconds` | Histogram | model | Detects slow or degrading GPUs |
| `queue_depth` | Gauge | model, worker | Admission and routing input |
| `request_duration_seconds` | Histogram | model, stage (queue / compute / total), status | p50/p99 by stage, merged across workers |
| `requests_total` | Counter | model, status | Success, 4xx, 503, 504 rates |
| `admission_rejections_total` | Counter | model, reason | Fast-fail volume under overload |
| `retries_total` | Counter | model, cause (worker_lost / watchdog / item_error) | Failure visibility and retry budget |
| `late_results_total` | Counter | model | Wasted compute: results with no waiter |
| `goodput_requests_total` | Counter | model | Successes within deadline; the SLO numerator |
| `worker_state` | Gauge | worker, state | Fleet health grid in the console |
| `batch_watchdog_timeouts_total` | Counter | worker | Hung GPU detection |

Percentiles are computed from summed histogram buckets across workers, never by averaging per-worker percentiles.

### Alerts

- p99 total latency > 300 ms for 5 minutes (SLO burn)
- Goodput < 99.9% of accepted requests over 10 minutes
- Mean fill ratio > 85% for 10 minutes (saturating; scale out) or < 30% for 30 minutes (over-provisioned)
- Admission rejections > 1% of requests for 5 minutes
- Any watchdog timeout; > 2 workers suspect in one pool
- `late_results_total` > 5% of results (deadlines too short or retries too aggressive)

### Tracing and Logs

Every request span carries `request_id`, `batch_id`, `worker_id`, and `attempt`, so a slow request can be joined to its batch and to every other request in that batch. Pino JSON logs record batch dispatch and completion with the same IDs.

## Failure Handling

| Failure | Detection | Response |
|---------|-----------|----------|
| **Worker queue lost** (worker process crash) | gRPC stream breaks, within milliseconds | Intake re-dispatches that worker's pending requests elsewhere if ≥ 250 ms remain; else 503 |
| **Intake node crash** | Client sees connection reset | Client retries with the same Idempotency-Key; worker drops queued items whose stream closed (cancellation) |
| **Shared broker down** (local build) | Circuit breaker on enqueue opens | Fail fast with 503; never buffer locally, because buffered work outlives its callers |
| **Compute timeout** (hung GPU) | Batch watchdog at 300 ms | Worker marked suspect, routing stops, in-flight requests retried; worker restarted, then re-registers with a new epoch |
| **Per-request deadline** | Intake timer | 504 to the caller; worker skips the item if not yet batched |
| **Partial batch failure** | Per-item status in the batch result | Successes return immediately; transient item errors retried once; deterministic errors (bad input) returned as 4xx/500 without retry |
| **Poison input** (crashes the whole batch) | Whole batch fails | Survivors retried once, scattered across different batches; a request present in 2 failed batches is quarantined and failed with 500 |
| **GPU dies mid-batch** | Stream break or watchdog, confirmed by 3 missed heartbeats | As above; Fleet Manager marks it dead and may place the model on a spare GPU |
| **Too few requests** | Fill ratio < 30% | Never wait for a full batch; the 20 ms gather window caps the wait; autoscaler shrinks the pool or co-locates the model |
| **Overload** | Estimated completion > deadline | 503 + Retry-After at admission, in < 5 ms |
| **Fleet Manager down** | Snapshot stale | Routers keep the last snapshot and their own load signals; no new placements until it returns |
| **Redis down** | Circuit breaker opens | Idempotency degrades to per-node coalescing only; rate limits fall back to per-node local buckets |

### Circuit Breakers

Each intake node wraps each worker stream in a circuit breaker (Opossum in the local build): it opens after 50% failures over at least 20 requests in 10 s, half-opens after 5 s, and the router excludes open-breaker workers from P2C. This catches a degraded worker before the Fleet Manager's heartbeat logic does.

### Graceful Drain

Draining a worker: (1) Fleet Manager marks it `draining` and publishes a snapshot, so routers stop sending new work within ~1 s; (2) the worker finishes its queue and in-flight batch, about 200 ms at planned load; (3) it reports empty and moves to `drained`. Deploys roll through the fleet by draining a few workers at a time; at 70% planned fill, draining 10 of 100 GPUs raises the others to 78%.

## Scalability Considerations

### Horizontal Scaling Path

1. **GPU workers** scale per model pool on fill ratio and admission rejections. Provisioning plus weight loading takes minutes, so the autoscaler keeps 30% headroom and scales on the trend, not the current value
2. **Intake nodes** are cheap: each holds ~1,120 connections and ~3 MB of pending state at peak. Scale on CPU and connection count
3. **Redis** carries ~70,000 idempotency `SET NX` operations per second at peak if every request is keyed; a small cluster sharded by tenant handles it
4. **ClickHouse** ingests ~70,000 rows/s through batched inserts (intake nodes buffer 1 s of rows)

### What Breaks First

1. **The GPU pool, as a latency cliff, not an error.** Past ~85% fill, overflow windows compound and p99 climbs from ~210 ms toward 300 ms and beyond; admission control converts the excess into 503s
2. **Single-model hot spots in mixed fleets.** A spike on model A cannot use model B's idle GPUs without a weight load. Fix: keep warm standby placements for the top models
3. **Control-plane fan-out at 10,000+ GPUs.** 10,000 heartbeats per second and snapshot pushes to every router; move to hierarchical aggregation (per-zone managers) and delta snapshots
4. **Router load staleness.** With many intake nodes, each sees a small slice of each worker's load. P2C tolerates this; the fix if it degrades is piggybacking queue depth on every result, which this design already does

### Multi-Region

Each region runs an independent stack. The global LB routes to the nearest region; when a region's admission rejects, the gateway may spill to a neighbor if the added RTT (~70 ms cross-continent) still fits the remaining deadline.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Flush policy | GPU-free AND (full OR 20 ms gather) | Wait for full batch | Full-only starves at low load; batch size self-adjusts when busy |
| Request durability | Caller-held, in-memory queues | Durable broker | A 1 s request is worthless after its caller leaves |
| Where batching happens | On each GPU worker | Central batcher | Only the GPU host knows when the GPU is free and its memory state |
| Load balancing | Power of two choices | Round robin / global least-loaded | Robust to stale load data without herding |
| Overload | Deadline-aware admission (503) | Unbounded queue | Prevents goodput collapse into 100% timeouts |
| Result routing | Reply on request stream / per-node channel | Per-request channel or DB polling | No subscription churn at 70,000 req/s |
| Server retries | One, deadline-checked, budgeted | Retry until success | Bounds amplification when a pool is sick |
| Batch failure | Per-item status + scattered retry + 2-strike quarantine | Retry whole batch | Contains poison inputs |
| Multi-model | Dedicated pools; co-locate small models | Swap weights on demand | A swap costs 12+ batches of capacity |
| Capacity target | 70% fill | 90%+ fill | 90% overflows ~15% of windows; p99 cliff |
| Generation workloads | Continuous batching | Static batches | Static slot utilization is mean/max length (20%) |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local implementation, which maps the production design onto Docker + Node.js/Express + TypeScript on the backend and React 19 + Vite + TanStack Router + Zustand + Tailwind on the frontend. GPUs are simulated.

### Planned Local Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                               Local Machine                               │
│                                                                           │
│  ┌──────────────────┐      ┌──────────────────────────────────────────┐   │
│  │ Operator console │─────▶│ Intake API (Express) :3000               │   │
│  │ Vite :5173       │◀─SSE─│ waiter map · admission · idempotency     │   │
│  └──────────────────┘      └──────┬──────────────────────────▲────────┘   │
│                                   │ XADD queue:{model}       │ SUBSCRIBE  │
│                                   ▼                          │ results:*  │
│                       ┌──────────────────────────────────────┴──┐         │
│                       │ Valkey :6379                            │         │
│                       │ streams · pub/sub · idempotency · load  │         │
│                       └──┬───────────────┬───────────────┬──────┘         │
│               XREADGROUP │ COUNT 100     │ BLOCK 20 ms   │                │
│                  ┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼────────┐       │
│                  │ sim worker 1 │ │ sim worker 2 │ │ sim worker 3 │       │
│                  │ :3001        │ │ :3002        │ │ :3003        │       │
│                  └──────────────┘ └──────────────┘ └──────────────┘       │
│                                                                           │
│  PostgreSQL :5432 (control plane)          ClickHouse :8123 (optional)    │
└───────────────────────────────────────────────────────────────────────────┘
```

Two modes are planned. **Single-process mode** runs intake, batcher, and one simulated GPU in one Express process with an in-memory queue, which is the base interview problem in its simplest form. **Fleet mode** runs intake on :3000 and three simulated workers on :3001–3003, connected through Valkey Streams.

### Production-Grade Patterns Planned

| Pattern | Planned location | Why it matters at scale |
|---------|------------------|-------------------------|
| Waiter map (async-to-sync) | `backend/src/intake/` (planned) | The core mapping of request ID → held HTTP response, with first-result-wins settle |
| Flush policy | `backend/src/worker/batcher.ts` (planned) | `MAX_BATCH`, `MAX_WAIT_MS`, `BATCH_LATENCY_MS` env-configurable to reproduce the math |
| Deadline-aware admission | `backend/src/intake/` (planned) | 503 + Retry-After instead of timeouts under overload |
| Idempotency keys | `backend/src/shared/idempotency.ts` (planned) | `SET NX` in Valkey, coalescing, 30 s result cache |
| Circuit breakers (Opossum) | `backend/src/shared/circuit-breaker.ts` (planned) | One breaker per worker and one around Valkey enqueue |
| Prometheus metrics (prom-client) | `backend/src/shared/metrics.ts` (planned) | Fill ratio, flush reason, queue depth, stage latency histograms |
| Structured logging (Pino) | `backend/src/shared/logger.ts` (planned) | request_id / batch_id / worker_id on every line |
| Health checks | `/health` on every process (planned) | Worker health reports batch progress, not just liveness |
| Rate limiting | `backend/src/shared/rate-limit.ts` (planned) | Per-tenant token bucket in Valkey |
| Failure injection | worker env vars (planned) | `FAIL_ITEM_RATE`, `POISON_MARKER`, `HANG_PROBABILITY`, `CRASH_AFTER_BATCHES` |

### Simplified or Substituted

| Production | Planned local substitute | Impact |
|------------|--------------------------|--------|
| GPU executing a model | Worker that sleeps `BATCH_LATENCY_MS` (100 ms) and echoes or transforms inputs | Exercises every batching and failure path without a GPU. An env var may optionally forward batches to a real model API |
| Push routing over gRPC streams with P2C | Valkey Streams consumer group; workers pull with `XREADGROUP COUNT 100 BLOCK 20` | Pull-based batching, which Key Design Decision 3 discusses as the small-fleet alternative. A P2C push router is a later phase |
| Lease-based failover | `XAUTOCLAIM` of pending entries from a dead consumer after 300 ms idle | Same semantics: un-acked work returns to the pool |
| Reply on the request stream | Valkey pub/sub channel per intake instance, messages keyed by request ID | One subscription per intake process |
| Fleet Manager with autoscaling | Express admin routes on the intake service + PostgreSQL tables | Drain and fail-over work; no autoscaling |
| Multi-region, many intake nodes | One intake process on :3000 | Cross-node idempotency and cross-region spillover not exercised |
| Prometheus + Grafana | `/metrics` endpoints + the operator console's own charts | No long-term metric storage |
| SSO + RBAC | Session auth with a seeded operator user | Same two roles, simpler login |

### Omitted

- Real GPUs, model weights, and weight distribution
- Continuous batching and token streaming (documented above as the evolution; a later phase could simulate per-token decode steps)
- Kubernetes, multi-region deployment, and autoscaling
- Billing (the planned LLM API Platform project reuses this batcher and adds metering)

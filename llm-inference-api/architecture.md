# LLM Inference API - Architecture

## System Overview

A multi-tenant developer API that exposes a language model. Customers submit requests with an API key and get the output back in one of three ways: a single JSON response (sync), tokens as they are generated (stream), or a request id to fetch later (async). Behind the API sits a fleet of model-serving replicas with a fixed number of batch slots each, which is the scarce resource the whole design protects.

The design is about the request, not the GPU. Its subject is the product contract around a generation:

- who owns a request when the client goes away;
- how a request is charged, admitted, queued, batched, routed and cancelled;
- how one tenant is kept from taking all the capacity;
- what the caller sees when things fail.

Model internals (kernels, KV cache layout, tensor parallelism) appear only where they change a product decision: prefix-cache reuse makes routing affinity worth having, and iteration-level batching changes what "a batch" means.

**Learning goals**

- Admission control by cost (input tokens + `max_tokens`), not by request count, with a refund of the unused reservation.
- Two different "no" answers: `429` for a tenant over its own limit, `529` when the system is over capacity.
- A durable request record with a state machine where cancellation racing completion is decided by one atomic transition.
- Batching with three dispatch triggers (full, max wait, deadline), and why the accelerator should batch continuously.
- Routing with consistent hashing and bounded load, drains during a rolling model change, and a hard rule that a request never moves once output has started.
- A latency split (queue, time to first token, tokens per second) so a long queue is never mistaken for a slow model.

The signal for this project is several Anthropic candidate reports (self-reported, not verified): an API-focused exercise on sampling, batching and request orchestration; a batching round with one accelerator that processes up to 100 inputs at a time; and a routing round with sticky assignment. The 100-input accelerator is an exercise assumption, not a real serving limit.

## Requirements

### Functional Requirements

1. Authenticate requests with API keys. Keys belong to an organization with a tier, and the tier sets token-per-minute and request-per-minute limits and a share of each queue.
2. Accept a Messages-API-shaped request (`model`, `max_tokens`, `system`, `messages`) in three modes: sync, stream (SSE) and async (202 + id).
3. Assign the request id at the edge. Every response, stream and event refers to it.
4. Let callers fetch an async result later, from any API server, and re-attach to its token stream with resume.
5. Cancel a request explicitly, or implicitly when a sync or streaming client disconnects. An async request survives disconnects.
6. Record usage for every request: input tokens (and how many came from the prefix cache), output tokens, reserved and refunded tokens, and the latency split.
7. Keep interactive traffic and bulk (async) traffic in separate queues with separate dispatch policies.
8. Batch requests onto backends: dispatch when a batch is full, when its oldest request has waited long enough, or when a deadline is close.
9. Route across backends with prefix affinity, drain backends for rollouts, and fail over without moving a request that has started output.
10. Give operators a console with queue depth per class, batch fill, backend state (slots, cache hit rate, version, draining) with drain and chaos controls, and usage per tenant.

### Non-Functional Requirements

| Property | Target (production) | What it forces |
|----------|---------------------|----------------|
| Availability of the API edge | 99.99% | Stateless gateways; request state outside the process |
| Admission decision | p99 < 5 ms | One Valkey round trip in the common case; no database write on rejection |
| Queue time, interactive | p50 < 50 ms, p99 < 1 s at normal load | Separate interactive lane, headroom bulk cannot take |
| Time to first token | p50 < 300 ms on a prefix-cache hit | Prefix affinity in routing |
| Correctness of billing | Every request billed exactly once; refunds never double | Usage row written once; refund keyed on that write |
| Cancellation | Exactly one terminal state; the caller sees which | A single guarded state transition |
| Overload | Bounded memory and bounded wait; shed, never collapse | Bounded queues, deadlines, 529 at the edge |
| Fairness | A tenant at its limit cannot raise another tenant's p99 queue time by more than one batch interval | Per-tenant queue shares plus weighted fair dispatch |

## Capacity Estimation

### Production Scale (assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Requests | 20,000/s average, 60,000/s peak | Large public API; interactive traffic is diurnal |
| Tokens in | ~2,000 per request average (long system prompts) | 40M input tokens/s |
| Tokens out | ~300 per request average | 6M output tokens/s |
| Replica throughput | ~3,000 output tokens/s per replica at full batch | A replica decodes ~100 sequences × ~30 tok/s |
| Replicas | ~2,000 at peak, plus 20-30% headroom | 6M ÷ 3,000 at average; peaks and rollouts need slack |
| Concurrent sequences | ~200,000 | 20,000 req/s × ~10 s average generation |
| Request records | ~1.7 billion/day | One row per request; partitioned by day, kept 30 days hot |
| Event-log traffic | ~6M deltas/s | Coalesced per decode step and per request before publishing |

What the numbers say: admission and queueing are cheap (tens of thousands of decisions a second), and the GPU fleet is everything. Every design choice should therefore keep replicas full (continuous batching, cache reuse) and refuse work early rather than queue it on a replica.

### Local Development Scale

Three mock replicas with 8 slots each (24 concurrent sequences), 40 tokens/s per sequence, 120 ms base time to first token and 0.3 ms of prefill per uncached input token. A long system prompt (1,500 tokens) costs ~450 ms extra on a cache miss, which makes the benefit of affinity visible. Batch size 4, interactive max wait 25 ms, bulk max wait 1.5 s. The load generator peaks at ~40 requests/s.

## High-Level Architecture

```
                  ┌──────────────────────────────────────────────────────────────────┐
 API clients ───▶ │  Edge / load balancer (TLS, per-IP limits, sticky nothing)       │
 Console     ───▶ └───────────────────────────────┬──────────────────────────────────┘
                                                  │
                  ┌───────────────────────────────▼──────────────────────────────────┐
                  │  API gateways (stateless, N instances)                           │
                  │  auth (API key → org, tier) · validation · cost estimate         │
                  │  admission: token bucket + queue bound (one atomic script)       │
                  │  request record (id assigned here) · response modes · cancel     │
                  └──────┬──────────────────────────┬───────────────────────┬────────┘
                         │ enqueue / cancel         │ insert / transition   │ read event log
                         ▼                          ▼                       │
          ┌──────────────────────────────┐  ┌──────────────────────┐        │
          │ Valkey (hot, rebuildable)    │  │ PostgreSQL (truth)   │        │
          │ token buckets per org        │  │ orgs, keys, tiers    │        │
          │ queues: interactive | bulk   │  │ requests (state)     │        │
          │   per tenant FIFO + age/dl   │  │ usage, batches       │        │
          │ in-flight set, job payloads  │  └──────────▲───────────┘        │
          │ per-request event logs ◀─────┼─────────────┼────────────────────┘
          │ routing snapshot, config     │             │ guarded transitions,
          └──────────────▲───────────────┘             │ usage + refund
                         │ claim / requeue / publish   │
          ┌──────────────┴─────────────────────────────┴─────────────────────┐
          │  Dispatcher (one leader per cell, standby takes over on lease)   │
          │  batch policy per class (full · max wait · deadline)             │
          │  weighted fair picking (DRR by cost) · bulk share / headroom     │
          │  router: consistent hash + bounded load on the prefix key        │
          │  stream relay: backend events → state transitions + event log    │
          └──────────────┬───────────────────────┬───────────────────────┬───┘
                         │ group of requests     │                       │
                         ▼                       ▼                       ▼
          ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
          │ Model replica b1     │ │ Model replica b2     │ │ Model replica b3     │
          │ N slots, continuous  │ │ prefix (KV) cache    │ │ version, draining    │
          │ batching per step    │ │ health / admission   │ │ authority on its own │
          └──────────────────────┘ └──────────────────────┘ └──────────────────────┘
```

The request path: gateway → Valkey queue → dispatcher → replica, and back as events: replica → dispatcher → Valkey event log → whichever gateway the client is connected to. PostgreSQL is written at four points: admission (insert), first token (queued → running), the terminal state, and usage. At production scale the box labelled "Dispatcher" is one per *cell*: a cell is a few hundred replicas with its own queues. The edge routes tenants to a home cell and spills to others under load.

## Core Components

### 1. The product contract first

Before any queue or GPU, the contract a caller relies on:

| Mode | Endpoint | Who owns the request | Client disconnects | Result |
|------|----------|----------------------|--------------------|--------|
| sync | `POST /v1/messages` | The connection | Cancelled (nobody is left to read it) | One JSON message |
| stream | `POST /v1/messages` with `"stream": true` | The connection | Cancelled | Messages-API SSE events |
| async | `POST /v1/messages/async` | The request id | Nothing happens; it keeps running | `GET /v1/requests/:id`, or attach to `/events` |

- **The edge assigns the id** (`req_…`) before anything is queued. It is in the `request-id` header, the first SSE event (`message_start.message.id`) and every log line. Queued work is correlated with its caller by this id alone: the queue entry, the backend sequence, the event log key, the usage row and the client's response all carry it.
- **Errors use the Messages-API shape** (`{ type: 'error', error: { type, message } }`), and the `type` is the contract clients branch on:
  - `rate_limit_error` (429 + `Retry-After`): you are over your own limit, and the header says exactly when your bucket refills.
  - `overloaded_error` (529): the service is over capacity. This is not your fault; back off with jitter.
  - `invalid_request_error` (400): for example, a reservation larger than your tier's burst, which no retry would fix.
  - `api_error` (500): for example, a backend failure after output started.
  - `timeout_error` (504): a sync request that hit its deadline, or work that expired in the queue.
- **`Idempotency-Key`**: a retry with the same key returns the same request. A completed one replays its result; one still in progress answers 409 with the id. A cancelled or failed attempt releases the key, so the retry starts fresh (partial unique index, see the schema).
- **Extension event**: streams carry an `inference_status` event (queued → running with backend, queue and TTFT; requeued with reason). Standard clients ignore unknown events.

### 2. Admission control by cost

Requests differ in cost by orders of magnitude, and payload size is a poor proxy for that cost: a 200-byte prompt with `max_tokens: 4096` can cost 50× a 10 KB prompt with `max_tokens: 50`. Execution cost is dominated by *output* tokens, and the output length is unknown until generation ends. So admission charges a **reservation**:

```
cost = estimated input tokens + max_tokens          (input from the tokenizer; ~chars/4 locally)
```

Each org has a token bucket (capacity = one minute of its tier's tokens/min, continuous refill) and a request bucket (requests/min). When the request finishes, the unused part of the reservation is refunded:

```
refund = reserved − (input_tokens + output_tokens)          (never negative, never above capacity)
```

The effect: a tenant is limited by what it actually uses, while the bucket still caps how much *outstanding* work it can have. Two requests with similar payloads but different `max_tokens` are charged differently up front, and their real costs converge after the refund.

Admission is one Valkey Lua script (`backend/src/shared/cache.ts`, `ADMIT`) that checks, in order:

1. reservation larger than the bucket's capacity → **400** (retrying can never succeed);
2. token bucket short → **429** with `Retry-After = ceil((cost − level) / rate)`;
3. request bucket empty → **429**;
4. the tenant already holds its share of this class's queue → **429** (a tenant-level limit, so not a 529);
5. the class queue is at its bound → **529 overloaded_error**;
6. otherwise charge both buckets and enqueue, in the same atomic step.

The gateway runs the script twice. The first run is a read-only **pre-check**, so a tenant hammering past its limit costs Valkey reads only and never writes to PostgreSQL. Then the gateway inserts the durable record, and runs the script again for real. If the second run disagrees (a race with the tenant's own concurrent requests), the record is marked `failed` with the admission reason. Without the pre-check, a noisy tenant's rejected traffic would become a write load on the source-of-truth database.

### 3. Queues, priority classes and per-tenant fairness

Two classes, each with its own bounded queue and its own dispatch policy:

| Class | Default for | Max wait before dispatch | Queue bound | Share of slots |
|-------|-------------|--------------------------|-------------|----------------|
| interactive | sync, stream | 25 ms | 48 (local) | everything bulk is not guaranteed |
| bulk (`batch`) | async | 1.5 s | 400 (local) | guaranteed 25%, at most 50% |

Inside a class, every tenant has its own FIFO list. The class also keeps a sorted set by enqueue time (its size is the depth, and its head is the oldest request) and one by deadline. Three mechanisms keep one customer from taking all the capacity, and each closes a gap the others leave:

1. **Rate limits** cap a tenant's spend, but a tenant within its limits can still flood the queue.
2. **Per-tenant queue shares** (by tier: 4 / 12 / 24 interactive) mean a single tenant can never fill the class queue. If it could, everyone else would get 529s caused by one customer.
3. **Deficit round robin by cost** in the dispatcher (`backend/src/dispatcher/fairness.ts`): each tenant with queued work earns `quantum × tier weight` tokens of credit per round, and dispatches while its credit covers its next request's cost. A quiet tenant's request goes out in the next batch, however long the noisy tenant's backlog is. Credit is dropped when a tenant's queue empties, so idle tenants can't bank it.

The bulk lane's **guaranteed share** keeps bulk from starving under interactive load. Its **ceiling** keeps an interactive burst from queueing behind long bulk generations, because some slots stay free for it. In the live run, a noisy tenant with 60 queued bulk requests had a median queue time of ~1.9 s. A quiet tenant arriving 400 ms later waited at most ~0.55 s and overtook 43 of the noisy requests, while a sync request from a third tenant was served with < 400 ms of queueing.

### 4. Batching: when a batch leaves, and what a batch is

**Dispatch policy** (`backend/src/dispatcher/batch-policy.ts`), evaluated per class every tick (10 ms):

```
size target   = min(batchMaxSize, free slots the class may use)
full          → depth ≥ batchMaxSize and that many slots are free     → dispatch batchMaxSize
max_wait      → oldest queued request has waited ≥ maxWait(class)       → dispatch min(depth, free, max)
deadline      → some request's deadline is within deadlineSlack          → dispatch min(depth, free, max)
no free slots → dispatch nothing; the bounded queue and 529 absorb it
```

- **Low traffic, a batch never fills.** A request waits at most `maxWait` (25 ms interactive, 1.5 s bulk) and then leaves in a batch of one. That bound is the answer to "how long does a request wait when traffic is low": max wait plus one tick, never "until the batch fills".
- **With the exercise's numbers**, one accelerator that takes up to 100 inputs and interactive max wait 50 ms: at 2,000 req/s a batch of 100 fills in 50 ms, so the two triggers coincide. At 200 req/s every batch leaves on max wait at ~10% fill. At 20 req/s each request waits the full 50 ms for nothing. The knob trades latency for accelerator efficiency, and its right value depends on traffic. That is why it is a runtime setting here, and why production systems make the wait adaptive (shorter when the queue is empty, longer when a batch is about to fill).
- **Deadlines.** A request carries a deadline (the sync timeout, or `metadata.deadline_ms` for async). A batch leaves early when a deadline is close, and a request whose deadline passes while it is still queued is failed with `timeout_error` and a full refund. Its caller has given up, so spending a slot on it would be waste.

**Static vs continuous batching.** The accelerator has slots. The question is when a finished sequence's slot can be reused.

| Approach | How it works | Consequence |
|----------|--------------|-------------|
| ❌ Static batches | A batch runs until its longest member finishes; then the next batch is admitted | A 20-token answer holds its slot while a 2,000-token neighbour finishes: slots sit idle and short requests wait for long ones |
| ✅ Continuous (iteration-level) | Every decode step emits one token per running sequence; a finished sequence leaves at once and a waiting one joins at the next step | Slots stay full; a short request's latency depends on its own length |

The mock backends implement both (`backend/src/backend/engine.ts`, switchable per backend from the admin console). Continuous is the default because static batching wastes exactly the resource the system is built around. Continuous batching costs a more complex scheduler (KV-cache memory per sequence, admission at step boundaries, preemption when memory runs out), and that complexity lives inside the model server, not in this API.

**Why the dispatcher still batches.** If the replica batches continuously, why group requests at all? Because admitting a group has a fixed cost: scheduling, KV allocation and launching a prefill pass stall decode for everyone on the replica (the mock models this as `admitOverheadMs` per admitted group). Ten single admissions stall running streams ten times, while one group of ten stalls them once. So the dispatcher's batch is an *admission group*, and its size and wait are the latency-vs-throughput knob. Under saturation, slots free up one at a time, so most groups leave on max wait with one or two requests (the admin console shows ~27% fill for max-wait batches at high load). That is correct: holding three free slots idle to form a group of four would cost more than the stall it saves. Batch fill is a diagnostic. The efficiency metric is slot occupancy.

### 5. Routing: affinity is a preference, not a rule

**Why affinity at all.** Apps resend the same long system prompt with every request. A replica that recently processed that prefix holds its KV cache, and a request with a cached prefix skips most of its prefill. Locally the difference is ~600 ms vs ~140 ms to first token for a 1,500-token prompt. That is purely a performance benefit: any replica can serve any request correctly. So affinity must give way to load, drains and failures, and it never justifies waiting for a specific replica.

**Algorithm** (`backend/src/dispatcher/router.ts`): consistent hashing with bounded load.

1. The prefix key is a hash of the model plus the system prompt (or the start of the first message when there is none).
2. Each backend owns 160 virtual nodes on a 32-bit ring (SHA-256 positions; FNV-1a left the three backends at 25/36/39% of the key space). A key's preference order is the distinct backends met walking clockwise from its hash.
3. Walk the preference list and take the first backend that is routable (healthy, not draining, not cooling down) and has a free slot, and whose load after this request stays within `max(ceil(average × (1 + ε)), floor(slots × 0.5))`, with ε = 0.25.
4. The `floor(slots × 0.5)` term keeps affinity absolute at low load. Above half occupancy the classic bound applies, so one hot prefix spreads over several replicas instead of melting one. Each replica it lands on then caches that prefix too.

**Adding or removing a replica** moves only the keys whose owner changes: about 1/(N+1) when adding, and exactly the leaving replica's keys when removing. The routing page measures this over 10,000 sample keys: adding a fourth backend moves ~23-25% of keys, all of them to the new backend, while `hash mod N` would move ~75%. A moved key costs one cold prefill on its new owner, and nothing fails.

**Rolling model-version change.** One replica at a time: drain it (it refuses new groups, finishes its in-flight streams), switch the version when it is empty (its prefix cache is now cold), undrain. Capacity drops by one replica, never to zero. The router simply sees one backend as not routable and walks past it on the ring. Two versions serve the same model name during the rollout, and every response carries `model_version`, so a caller can tell which one answered.

**Stale routing information.** The dispatcher's view of each replica (health, draining, version, slots in use) comes from polling every 500 ms. It can be wrong in both directions:

- *Too optimistic* (it thinks a draining or full replica can take work): the replica is the authority on its own admission and refuses cheaply. A refused group costs one round trip and its requests go back to the head of their queues for re-routing; nothing was generated, so nothing is lost.
- *Too pessimistic* (a report taken before a burst finished says the replica is busy): this one bit us in testing. The router used `max(local in-flight, reported in-use)`, so an idle replica looked loaded for up to one poll and its prefixes spilled elsewhere, losing cache hits. The fix: the dispatcher's own in-flight count is exact for work it sent, and the reported number only counts if it was taken after the last local completion.

**Once output has started, a request never moves.** Moving it would mean a second backend regenerating from scratch (the client would see the first tokens twice) or continuing from a prefix it didn't produce (a different sampler state, possibly a different model version). Either breaks the stream's integrity. A request is re-routable only while it is `queued`, including "sent to a backend but no token yet". The first token flips it to `running` and pins it.

### 6. The request record, ownership and cancellation

The request is a row in PostgreSQL with a small state machine (`backend/src/shared/state-machine.ts`):

```
queued ──▶ running ──▶ completed
  │           ├──────▶ cancelled
  │           └──────▶ failed
  ├──────────────────▶ cancelled
  └──────────────────▶ failed
```

- `queued` covers "waiting in a queue" and also "sent to a replica, still prefilling". The request can still be re-routed in this state.
- `running` begins at the **first output token**, the moment it becomes pinned to its replica.
- Every transition is one guarded UPDATE whose WHERE clause comes from the table above:

```sql
UPDATE requests SET status = 'cancelled', cancel_reason = $2, finished_at = now()
WHERE id = $1 AND status = ANY('{queued,running}') RETURNING *;      -- cancel

UPDATE requests SET status = 'completed', output_text = $2, stop_reason = $3, finished_at = now()
WHERE id = $1 AND status = ANY('{running}') RETURNING *;             -- completion
```

**Cancellation racing completion.** Both statements lock the same row. Whichever commits first wins, and the other re-evaluates its WHERE clause, matches zero rows and learns it lost. Then:

- **The winner writes the single terminal event** (`done` or `cancelled`) to the request's event log, so every reader (the sync waiter, a stream, someone attached by id) sees the same outcome.
- **The cancel endpoint returns the final record**, `{ status, cancelled: true|false }`. A caller whose cancel lost receives the completed result instead of an error.
- **The loser writes nothing visible.** If completion lost, the dispatcher keeps the partial output on the cancelled row and bills the tokens actually generated.

The live check fires a cancel at staggered times around completion, 24 times. Every request ended in exactly one terminal state, with one terminal event and one usage row, and the cancel response always named the winner. Over the sweep, both outcomes occurred.

**Who cleans up after a cancel.** The canceller also tries to remove the id from its queue atomically (`UNQUEUE`):

- If the id was still queued, the canceller refunds the whole reservation.
- If the dispatcher had already claimed it, the canceller publishes a cancel message. The dispatcher tells the replica to stop (which frees the slot), bills the tokens generated so far and refunds the rest.
- If that message is lost, nothing leaks. The first-token transition fails (the row is already `cancelled`), so the dispatcher stops the sequence then.

**Client disconnect.** For sync and stream requests, the gateway watches the response socket. A close before the terminal event is a cancel with reason `client_disconnected`. The tokens generated so far are billed, and the slot is freed within one decode step. Async requests are not tied to any connection: detaching from `/events` changes nothing.

**The API server times out while the model is still working.** The request id owns the work, not the gateway process. For sync, the gateway's deadline (120 s) cancels the request and answers 504 with the id, because no one can read a sync result later. Long work belongs in async. For async and for streams attached by id, any other gateway can serve `GET /v1/requests/:id` or re-attach to the event log, because both live outside the gateway: PostgreSQL holds the record and Valkey the event log.

### 7. Event log and stream relay

Each request has an event log (a Valkey stream, 1 h TTL) containing `start`, `delta`, `requeued` and one terminal event. The dispatcher writes it, in this order:

1. The first token is published only **after** the `queued → running` transition commits. If a cancel won first, the token is never shown.
2. Deltas from one backend read are written in one pipeline.
3. The terminal event is written only by the winner of the terminal transition.

Gateways read the logs with **one blocking connection per gateway process**. A single `XREAD BLOCK … STREAMS k1 k2 …` covers every request that instance is waiting on, and a new subscription interrupts the block with `CLIENT UNBLOCK`. Because the log is outside the process:

- the gateway that accepted a request need not be the one that streams it;
- a client can resume with `Last-Event-ID`;
- a completed async request can be replayed from the log while the log lives, and from PostgreSQL afterwards.

### 8. Mock model backends

Three processes on separate ports (`backend/src/backend/`). Each behaves like a model server that matters for the design:

- **Slots and admission.** A fixed number of slots (8). It admits a group up to its free slots and rejects the rest per item (`no_slot`). The whole group is refused with 503 while draining or restarting, or with 529 when overloaded.
- **Timing.** Iteration-level decode at a configurable tokens/s. Time to first token = base TTFT + uncached input tokens × prefill cost. Each admitted group stalls decode by `admitOverheadMs`.
- **Prefix cache.** An LRU of prefix keys, reported as `cache_read_input_tokens`, with a hit rate over the last 200 admissions.
- **Versions.** A model version, drain and undrain, and upgrade (drain, then switch the version with a cold cache).
- **Determinism.** The same seed always produces the same text and the same natural output length, so tests can predict tokens.
- **Chaos switches, armed as counts.** Each fires on exactly the next N matching events, so a test can trigger exactly one crash:
  - `crash_mid_stream`: the next admitted sequence crashes the process after K tokens. Every open stream drops, the cache is lost, and the backend restarts in 2.5 s.
  - `refuse`: the next group gets 503.
  - `slow`: the next sequence is held in prefill for 4 s.
  - `overload`: the next group gets 529, and the router cools the backend down for 2 s.

### 9. Latency metrics

Every request records four timestamps: admitted, accepted by a replica, first token, finished. From them:

| Metric | Definition | Answers |
|--------|------------|---------|
| `queue_ms` | accepted − admitted (batching wait, waiting for slots, re-routes) | Is the system short of capacity? |
| `ttft_ms` | first token − accepted (prefill), split by cache hit or miss | Is the model, or the cache, slow? |
| `tokens_per_sec` | (output − 1) ÷ (finished − first token) | Is decode slowed by batch size or admission stalls? |
| `total_ms` | finished − admitted | What did the user experience? |

They are stored on the usage row, returned in headers (`x-inference-queue-ms`, `x-inference-ttft-ms`), in the stream's `message_delta.latency` and in `GET /v1/requests/:id`, and exported by the dispatcher as Prometheus histograms (`inference_queue_seconds{class}`, `inference_ttft_seconds{class,cache}`, `inference_tokens_per_second{class}`, `inference_total_seconds{class,status}`). A latency alert on total time alone cannot tell "add replicas" from "the model got slower". The split can: queue time grows while TTFT stays flat when capacity is short, and the reverse when a model version is slower.

### Worked example: one successful trace (a streamed request with a cache hit)

1. **Client → gateway A.** `POST /v1/messages` with `stream: true`, `max_tokens: 256` and a 1,500-token system prompt.
2. **Gateway A checks and estimates.** It validates the body, resolves the key to Acme (scale tier) from a 30 s cache, and estimates 1,520 input tokens, so the reservation is 1,776. The prefix key is the hash of the model and the system prompt.
3. **Pre-check.** `ADMIT` with dry-run says ok.
4. **Durable record.** Gateway A inserts `req_7Qx…` (status `queued`, deadline now + 120 s), then runs `ADMIT` for real. It charges 1,776 tokens and 1 request, and pushes the id onto `q:interactive:t:acme` plus the age and deadline sets, in one atomic step.
5. **Stream opens.** Gateway A sends `message_start` and `inference_status: queued`, and subscribes to `ev:req_7Qx…` through its shared XREAD loop.
6. **Dispatcher decides.** One tick later, the interactive depth is 1 and no batch is full. At 25 ms the oldest request reaches max wait, and the decision is `max_wait`, size 1.
7. **Claim and route.** DRR picks `req_7Qx…`, and `CLAIM` moves it to the in-flight set. The router hashes the prefix key; owner b2 has 2 of 8 slots in use, so b2 it is (`affinity: primary`).
8. **Record the dispatch.** One UPDATE sets `backend_id`, `batch_id` and `attempts` on rows still `queued`. A `batches` row records size 1 and trigger `max_wait`.
9. **Send to b2.** The dispatcher POSTs the group to b2. b2 admits it (free slot), finds the prefix in its cache (1,500 cached tokens), and starts prefill: 120 ms + 20 tokens × 0.3 ms.
10. **First token.** b2 emits it. The dispatcher runs `UPDATE … SET status='running' WHERE status='queued'`, which wins. Only then does it write `start` (queue 38 ms, TTFT 140 ms, b2, primary) and the first `delta` to the event log.
11. **Tokens flow to the client.** Gateway A's XREAD returns. It sends `inference_status: running`, `content_block_start` and the delta. Subsequent tokens arrive one per decode step, 25 ms apart.
12. **Completion.** b2 emits `done` (60 tokens, `end_turn`). The dispatcher runs `UPDATE … SET status='completed' WHERE status='running'`, which wins. It inserts the usage row and refunds 1,776 − (1,520 + 60) = 196 tokens, because the insert happened. Then it writes the `done` event with usage and latency, and releases the in-flight entry.
13. **Stream ends.** Gateway A sends `content_block_stop`, `message_delta` (stop reason, usage, latency) and `message_stop`, and ends the response.

### Worked example: one failed trace (a replica crashes mid-stream)

1. Request A (stream) is running on b1 and has sent 40 tokens. Requests B and C (same prefix, async) were admitted by b1 a moment ago and are still prefilling. Request D is in the queue.
2. **b1's process dies.** Its open HTTP streams to the dispatcher reset mid-read. Every `admitted` line for A, B and C had been received; A had a first token, B and C did not.
3. **The dispatcher handles the stream error.** It marks b1 as cooling down, so the router stops picking it before the next health poll confirms it is restarting. Then it settles each unfinished request of that group, after waiting for that request's pending event processing:
   - **A** is `running`. Output began on b1, so it cannot move. The dispatcher runs `UPDATE … SET status='failed', error_type='api_error', output_text=<partial> WHERE status='running'`, which wins. It bills the input plus 40 output tokens, refunds the rest of the reservation, and writes the `error` event ("Backend b1 failed after 40 output tokens. Output had started, so the request cannot move to another backend; retry it.").
   - **B and C** are still `queued` (no token). `REQUEUE` puts them back at the head of their tenant queue with their original enqueue time, so they keep their place, and a `requeued` event records the reason `backend_crashed`.
4. **The client of A sees** the deltas it already received, then `event: error` with `api_error`. If it retries with the same `Idempotency-Key`, a new request starts, because a failed attempt releases the key.
5. **Re-routing.** On the next tick, B and C are dispatched again. The router walks past b1 (not routable) to the next backend on their prefix's ring, b3. They complete with `attempts = 2`; that first prefill on b3 was a cache miss.
6. **D is routed to b2 or b3** and never notices.
7. **b1 restarts** after 2.5 s with an empty cache. The next health poll marks it routable, and its prefixes return to it, starting with one cold prefill each.

If the *dispatcher* had died instead, b1's streams would have closed and b1 would have cancelled their sequences. The standby dispatcher takes the lease within 3 s. Its recovery sweep finds in-flight entries that no live process owns: `queued` ones are re-queued, `running` ones are failed with "the dispatcher handling this request stopped after output had started".

### Design Review Checklist

1. **What is the source of truth, and when is a write successful?** The PostgreSQL request row is the truth for a request's existence and state. Admission succeeds when the row is inserted and the atomic `ADMIT` charged the bucket and enqueued the id; only then does the client get a 202 or an open stream. A completion succeeds when the guarded `running → completed` UPDATE commits. Valkey holds rebuildable state (buckets, queues, event logs): losing it loses queue positions and in-progress streams, never a completed result or a usage row.
2. **What happens when a client retries after losing the response?** With an `Idempotency-Key`: a completed request replays its result, an in-flight one answers 409 with its id, and a cancelled or failed one releases the key so the retry starts fresh (a partial unique index on `(org_id, idempotency_key) WHERE status NOT IN ('cancelled','failed')`). Without a key, a sync retry is a new request, and the lost one was cancelled when its connection closed, so it is not billed twice for unread work. An async client that lost the 202 can list its recent requests.
3. **What happens when a worker fails between two important steps?** Each step is recoverable:
   - Gateway dies after the insert, before `ADMIT`: the orphan sweep fails the row after 60 s. Nothing was charged.
   - Dispatcher dies after `CLAIM`, before the replica accepts: the recovery sweep re-queues it after 30 s.
   - Replica dies before the first token: the request is re-routed.
   - Replica dies after the first token: the request fails with a clear error.
   - Dispatcher dies between the terminal UPDATE and the usage insert: the request is terminal without usage, and the sweep finalizes it with a full refund (it under-bills rather than double-bills).
   - Crash between the usage insert and the refund: the refund is lost. The tenant is overcharged for at most one request, and the bucket refills within a minute.
4. **Which ordering or consistency guarantee is required?**
   - Exactly one terminal state per request, which the row lock gives.
   - Per-request event order: one writer per request at a time, with per-request serial processing in the dispatcher.
   - FIFO within a tenant's lane: requeued work goes back to the head with its original timestamp.
   - Nothing stronger. There is no global order across tenants (DRR deliberately reorders), and rate limits are per org, not exact across cells.
5. **How is access enforced with caches, indexes and async jobs?** Every read by id is scoped by org in SQL (`WHERE id = $1 AND org_id = ANY($2)`), so an id from another org is a 404, not a 403. The event log is reachable only through those same scoped endpoints, never by key. The key → org cache lives 30 s, so a revoked key keeps working for up to 30 s, an accepted trade-off. Admin endpoints require an admin session; console members act only through their orgs' keys.
6. **What breaks first at larger scale, and what is the evidence?**
   - **Model capacity breaks first.** Under the local load test, queue time grew to seconds while TTFT stayed at ~140 ms, and admission and dispatch stayed in single-digit milliseconds.
   - **The single dispatcher per cell is next**: it is one process per tick, and its throughput is bounded by Valkey round trips (~5 per dispatch).
   - **PostgreSQL write rate**: four writes per request, 80,000/s at the production estimate. That calls for partitioned request tables and batched usage writes.
   - **Event-log fan-out**: millions of deltas per second need coalescing per decode step and sharding by request id.
   - The cells answer the dispatcher and Valkey limits; the request table is partitioned by day and sharded by org.

## Database Schema

The full schema is `backend/src/db/init.sql` (idempotent; `npm run db:migrate`). PostgreSQL holds what must survive: tenants, keys, the request record and usage.

```sql
CREATE TABLE IF NOT EXISTS tiers (
  name                    TEXT PRIMARY KEY,
  tokens_per_minute       INTEGER NOT NULL CHECK (tokens_per_minute > 0),
  requests_per_minute     INTEGER NOT NULL CHECK (requests_per_minute > 0),
  -- A tenant's share of each class queue; over it the tenant gets 429, not the system 529.
  max_queued_interactive  INTEGER NOT NULL CHECK (max_queued_interactive > 0),
  max_queued_batch        INTEGER NOT NULL CHECK (max_queued_batch > 0),
  -- Deficit-round-robin weight in the dispatcher.
  weight                  INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0)
);

CREATE TABLE IF NOT EXISTS orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  tier        TEXT NOT NULL REFERENCES tiers(name),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_admin       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id   UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (user_id, org_id)
);

-- Only a hash of the secret is stored; the prefix is for display.
CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);

-- One row per inference request. The id is assigned at the edge (gateway)
-- and owns the work. status follows shared/state-machine.ts:
--   queued → running → completed | cancelled | failed   (queued → cancelled | failed too)
CREATE TABLE IF NOT EXISTS requests (
  id                 TEXT PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES orgs(id),
  api_key_id         UUID NOT NULL REFERENCES api_keys(id),
  model              TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('sync', 'stream', 'async')),
  priority_class     TEXT NOT NULL CHECK (priority_class IN ('interactive', 'batch')),
  status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  max_tokens         INTEGER NOT NULL CHECK (max_tokens > 0),
  est_input_tokens   INTEGER NOT NULL,
  -- Reserved against the token bucket at admission; the unused part is refunded.
  est_cost_tokens    INTEGER NOT NULL,
  prefix_key         TEXT NOT NULL,
  prefix_tokens      INTEGER NOT NULL DEFAULT 0,
  idempotency_key    TEXT,
  input              JSONB NOT NULL,
  output_text        TEXT,
  stop_reason        TEXT,
  error_type         TEXT,
  error_message      TEXT,
  cancel_reason      TEXT,
  backend_id         TEXT,
  model_version      TEXT,
  batch_id           UUID,
  attempts           INTEGER NOT NULL DEFAULT 0,
  affinity           TEXT CHECK (affinity IN ('primary', 'spill')),
  deadline_at        TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at      TIMESTAMPTZ,
  first_token_at     TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS requests_org_created_idx ON requests (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_key_created_idx ON requests (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_open_idx ON requests (status, created_at) WHERE status IN ('queued', 'running');
-- An Idempotency-Key maps to at most one live or completed request per org. A
-- cancelled or failed attempt leaves the index, so a retry with the same key
-- starts a fresh request instead of replaying the failure.
CREATE UNIQUE INDEX IF NOT EXISTS requests_idempotency_idx ON requests (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status NOT IN ('cancelled', 'failed');

-- Written once per request when it reaches a terminal state (ON CONFLICT DO
-- NOTHING makes finalization idempotent; the refund happens only on insert).
CREATE TABLE IF NOT EXISTS usage (
  request_id           TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  org_id               UUID NOT NULL REFERENCES orgs(id),
  api_key_id           UUID NOT NULL REFERENCES api_keys(id),
  priority_class       TEXT NOT NULL,
  status               TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  reserved_tokens      INTEGER NOT NULL DEFAULT 0,
  refunded_tokens      INTEGER NOT NULL DEFAULT 0,
  -- Latency split: time waiting for capacity vs time on the model.
  queue_ms             INTEGER,
  ttft_ms              INTEGER,
  exec_ms              INTEGER,
  total_ms             INTEGER,
  tokens_per_sec       REAL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_org_created_idx ON usage (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_created_idx ON usage (created_at DESC);

-- One row per dispatched batch: how full it was and why it left.
CREATE TABLE IF NOT EXISTS batches (
  id              UUID PRIMARY KEY,
  priority_class  TEXT NOT NULL,
  size            INTEGER NOT NULL,
  max_size        INTEGER NOT NULL,
  trigger         TEXT NOT NULL CHECK (trigger IN ('full', 'max_wait', 'deadline')),
  oldest_wait_ms  INTEGER NOT NULL,
  backends        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batches_created_idx ON batches (created_at DESC);
```

At production scale `requests` and `usage` are partitioned by day (they are append-mostly, and old partitions are detached after 30 days), and the open-requests partial index keeps the sweeps cheap.

### Valkey keys (prefix `inf:`)

| Key | Type | Purpose |
|-----|------|---------|
| `bucket:{org}:tok`, `bucket:{org}:req` | hash `{t, ts}` | Token and request buckets (continuous refill, read and written by Lua) |
| `q:{class}:t:{org}` | list | One tenant's FIFO in a class |
| `q:{class}:tenants` | set | Tenants with queued work (the fair picker's round) |
| `q:{class}:age` | sorted set id → enqueue ms | Class depth (ZCARD) and the oldest request (head) |
| `q:{class}:dl` | sorted set id → deadline ms | Deadline dispatch and expiry |
| `job:{id}` | string (JSON) | What the dispatcher needs (cost, prefix key, seed, limits for the refund) |
| `inflight` | sorted set id → claim ms | Claimed but not finished: the recovery sweep's input |
| `ev:{id}` | stream | Per-request event log, 1 h TTL |
| `backends` | hash | The dispatcher's backend snapshot for the admin console |
| `config` | hash | Runtime knobs (batch size, waits, bounds, shares) |
| `dispatcher:leader` | string with PX TTL | Leader lease |
| `stats:{org}:{minute}` | hash | Admission outcomes per minute (429s and 529s are never written to PostgreSQL) |
| `session:{id}` | string | Console sessions |

## API Design

### Public API (API key: `x-api-key` or `Authorization: Bearer`)

```
GET  /v1/models                        → available models
POST /v1/messages                      → sync (JSON message) or stream (SSE) when "stream": true
POST /v1/messages/async                → 202 { id, status, links }
GET  /v1/requests                      → recent requests of the key's org
GET  /v1/requests/:id                  → status, result, usage, latency split
GET  /v1/requests/:id/events           → SSE attach, resumable with Last-Event-ID; leaving never cancels
POST /v1/requests/:id/cancel           → the final record + { cancelled: true|false }
GET  /v1/usage                         → last 24 h usage and tier limits
```

Request body (Messages-API shape):

```json
{
  "model": "mock-large",
  "max_tokens": 256,
  "system": "You are the support assistant for Acme Robotics…",
  "messages": [{ "role": "user", "content": "How do I reset the arm after a torque fault?" }],
  "stream": true,
  "priority": "interactive",
  "metadata": { "deadline_ms": 30000, "mock_output_tokens": 60 }
}
```

`priority` defaults to `interactive` for sync and stream and to `batch` for async. `metadata.deadline_ms` drops the request if it is still queued after that long. `metadata.mock_output_tokens` is a mock-only knob that fixes the output length.

Stream events: `message_start`, `inference_status` (queued / running / requeued), `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta` (stop reason, usage, latency), `message_stop`, or `error`. A cancelled stream ends with `message_delta.stop_reason = "cancelled"`.

Responses carry `request-id`, `x-priority-class`, and for sync, `x-inference-queue-ms`, `x-inference-ttft-ms` and `x-inference-backend`.

### Errors

| Status | `error.type` | When |
|--------|--------------|------|
| 400 | `invalid_request_error` | Bad body, `max_tokens` over the cap, reservation larger than the tier burst |
| 401 | `authentication_error` | Missing or unknown key |
| 404 | `not_found_error` | Unknown model, or a request id of another org |
| 409 | `conflict_error` | `Idempotency-Key` of a request still in progress; a sync request cancelled from elsewhere |
| 429 | `rate_limit_error` + `Retry-After` | Token bucket, request bucket, or the tenant's queue share |
| 504 | `timeout_error` | A sync request past its deadline, or work that expired in the queue |
| 529 | `overloaded_error` + `Retry-After` hint | The class queue is full; no backend accepted the request after 5 attempts |
| 500 | `api_error` | A backend failed after output started, or the dispatcher was lost mid-stream |

### Console and admin API (session cookie)

```
POST /api/v1/auth/login | /logout          GET /api/v1/auth/me
GET  /api/v1/console/orgs                  → your orgs, tiers, keys, tokens available now
POST /api/v1/console/messages              → { keyId, mode, ...body }: same pipeline as /v1
GET  /api/v1/console/requests[?orgId&keyId] → history with usage and latency split
GET  /api/v1/console/requests/:id          | /events | POST /cancel
GET  /api/v1/admin/overview                → queues, backends, batches, usage per tenant, latency, config
GET  /api/v1/admin/routing                 → ring shares, membership-change simulation, observed affinity
PUT  /api/v1/admin/config                  | POST /api/v1/admin/config/reset
POST /api/v1/admin/backends/:id/drain      { draining }
POST /api/v1/admin/backends/:id/upgrade    { version }
PUT  /api/v1/admin/backends/:id/settings   { chaos?, tokensPerSecond?, ttftMs?, slots?, batching?, crashAfterTokens? }
```

## Key Design Decisions

### 1. Charge the reservation (input + max_tokens), refund on completion

Counting requests treats a 10-token answer and a 4,000-token essay as equal, so a tenant can consume 400× its fair share at the same request rate. Charging actual tokens after the fact can't prevent anything: by the time you know, the work is done and the replica time spent. Charging the reservation up front bounds the tenant's outstanding work at the moment it matters, admission, and the refund means the tenant ultimately pays for what it used. The cost: a tenant that always sends `max_tokens: 4096` and uses 50 sees fewer requests admitted than its usage suggests. That pushes clients toward honest `max_tokens`, which is also what the batcher wants. An alternative is to charge a predicted output length per tenant (learned) and correct afterwards. It admits more, but a wrong prediction lets a burst through exactly when the system is busiest.

### 2. 429 and 529 are different contracts

A 429 says "you, specifically, are over your limit; your bucket refills in N seconds". The `Retry-After` is exact, and retrying sooner is pointless. A 529 says "we are over capacity; it isn't about you". The right client response is exponential backoff with jitter, and possibly failover to another region or model. Conflating them (both 429, or both 503) makes well-behaved clients wrong in one of the two cases: they hammer during an outage, or they back off for minutes when a single refill second would do. The per-tenant queue share is deliberately a 429: a tenant that has filled its share is over its own limit, even though the system may have room.

### 3. Fairness in the dispatcher, not only in the rate limiter

Rate limits are per-tenant ceilings, set high for big customers. Within those ceilings a large tenant can still occupy every queue slot and every replica slot at a moment when a small tenant arrives. Only the dispatcher sees who is waiting *now*, so the fairness decision belongs there: deficit round robin by cost, weighted by tier. A strict per-tenant concurrency cap would also work but idles capacity when only one tenant is active. DRR gives the noisy tenant everything nobody else wants, and gives it up the moment someone else asks.

### 4. Continuous batching on the replica; admission groups at the dispatcher

See component 4. Static batching would make the exercise's "batch of 100" literal, but it wastes slots on every short request. The dispatcher's batch is an admission group whose size and wait trade new-request latency for fewer decode stalls, and both are runtime knobs.

### 5. Bounded-load consistent hashing on a prefix key

Pure consistent hashing gives perfect affinity and terrible hot spots: one popular system prompt melts its owner. Least-loaded routing balances perfectly and throws away the cache. Bounded load gets both: affinity until a replica would exceed (1+ε)× the average, then the next replica on the ring, which then also warms that prefix. Rendezvous hashing would serve as well. Ring hashing was chosen because the "what moves when a node joins" story is easy to show and measure.

### 6. A request is pinned at its first token

Re-routing before output is free, because nothing was observed. Re-routing after output would duplicate or splice tokens, so it is forbidden, and a mid-stream replica failure is surfaced as an error the client can retry (idempotently, with a new attempt).

### 7. The edge assigns the id, and the id owns the work

Correlation (queue entry ↔ replica sequence ↔ event log ↔ usage ↔ the caller) needs one identifier minted before any of them exist. Ownership by the id rather than by the connection is what makes async and reconnects possible, and what lets sync be the *special case* that is cancelled when its connection closes.

## Consistency and Idempotency

- **Admission is atomic per tenant and class.** Charge plus enqueue run in one Lua script, so a request is either charged and queued, or neither. The record is inserted between the pre-check and the real admission. If the real admission rejects, the record is marked `failed`, so no `queued` row exists without a queue entry, except after a gateway crash (the orphan sweep).
- **Claims are atomic.** `CLAIM` removes an id from its queue and adds it to the in-flight set only if it is still queued, so a request cancelled a millisecond earlier is never dispatched. The dispatcher also re-checks `status = 'queued'` in the same UPDATE that records the backend.
- **Exactly one terminal state** via guarded transitions. The winner writes the terminal event.
- **Usage exactly once.** `INSERT … ON CONFLICT (request_id) DO NOTHING`, and the refund runs only if the insert happened. Several components may try to finalize the same request (the gateway for a queued cancel, the dispatcher for everything else, the sweeps), and only one refund happens.
- **Idempotency keys** live in the request table under a partial unique index, so the key's lifetime matches the request's.
- **Re-queue keeps order.** A re-routed request returns to the head of its tenant FIFO with its original enqueue time, so neither max wait nor deadline restarts.
- **At-least-once to the replica, at-most-once to the client.** A request may reach two replicas (for example, sent to b1, refused, sent to b3), but tokens reach the client only from the replica whose first token won the `queued → running` transition.

## Security / Auth

- **API keys.** Only the SHA-256 hash and a display prefix are stored. Keys belong to an org, and the tier comes from the org. The key → principal lookup is cached 30 s per gateway, so revocation takes effect within 30 s.
- **Tenant isolation.** Every query by request id is scoped to the caller's orgs. A foreign id is a 404 rather than a 403, so ids don't leak existence. Event logs are never addressable directly.
- **Console.** Session cookies (httpOnly, SameSite=Lax) with sessions in Valkey and bcrypt passwords. Members can use only their orgs' keys; the console path goes through the same admission and limits as the API. Admins (platform operators) see queues, backends and all tenants' usage, and can drain, roll and arm chaos.
- **Abuse.** Rejections cost no database writes. The edge has per-IP limits before authentication (not implemented locally). `max_tokens` is capped at the edge. The request body is limited to 2 MB.
- **Internal traffic.** Gateway ↔ dispatcher ↔ replica traffic runs on a private network with mTLS in production. The admin endpoints of the replicas are reachable only through the gateway's admin API.

## Observability

| Signal | Where | Why |
|--------|-------|-----|
| `inference_admission_total{class,outcome}` | gateway | Admission mix: ok vs 429 kinds vs 529; alert on the 529 rate |
| `inference_queue_seconds{class}` | dispatcher | Waiting for capacity; the "add replicas" signal |
| `inference_ttft_seconds{class,cache}` | dispatcher | Prefill speed and the value of affinity (hit vs miss) |
| `inference_tokens_per_second{class}` | dispatcher | Decode speed; admission stalls and over-full batches show here |
| `inference_total_seconds{class,status}` | dispatcher | What users experience |
| `inference_batch_size{class,trigger}` | dispatcher | Batch fill and why batches leave |
| `inference_queue_depth{class}`, `inference_backend_slots_in_use{backend}` | dispatcher | Saturation |
| `inference_route_total{affinity}`, `inference_reroutes_total{reason}` | dispatcher | Spill rate; refusals, crashes and no-slot re-routes |
| `inference_requests_finished_total{status,error_type}` | dispatcher | Error budget |
| `inference_cancellations_total{reason,won}` | gateway | Disconnect cancels vs explicit cancels, and how often cancels lose the race |

Logs are structured JSON (pino), with the request id on every line. Each process exposes `/health` and `/metrics`, and the gateway also exposes `/ready` (PostgreSQL + Valkey). The admin console shows the same numbers per tenant from PostgreSQL (usage) and Valkey (rejections per minute).

**Alert examples.**

- Interactive queue p95 > 1 s for 5 min while TTFT p95 is flat: a capacity problem. Page, and scale out.
- TTFT on cache hits rising: a model or replica problem.
- 529 rate > 1%: shedding is happening.
- Cancellations that lost the race > 5%: clients are timing out just before completion, so their timeouts are too short.

## Failure Handling

| Failure | Behaviour |
|---------|-----------|
| Replica refuses (draining, restarting) | Group re-queued at the head; the router's view is corrected at once; no client-visible error |
| Replica 529 / refuse switch | Re-queued, and the replica cools down for 2 s |
| Replica unreachable | Same, plus marked unreachable until a health poll succeeds |
| Replica crashes before the first token | Request re-routed (`attempts` + 1); `requeued` event with the reason |
| Replica crashes after the first token | Request failed with `api_error`, partial output kept, tokens billed, rest refunded |
| No backend accepts after 5 attempts | Failed with `overloaded_error`, full refund |
| All capacity gone (every replica drained) | Requests queue until the class bound, then 529; queued work runs when capacity returns |
| Request deadline passes in the queue | Failed with `timeout_error`, full refund |
| Client disconnects (sync/stream) | Cancelled, replica told to stop, generated tokens billed |
| Gateway crashes | Its clients' connections drop, but the process that would have noticed is gone: their sync and stream requests run to completion and are billed, unread (a known gap: see Open Questions in CLAUDE.md). Async requests are unaffected, and any other gateway serves them |
| Dispatcher crashes | Standby takes the lease within 3 s; replicas cancel the dead dispatcher's groups when their connections close; the recovery sweep re-queues claimed-but-unstarted work and fails started work |
| Valkey restarts | Buckets reset (tenants get a fresh burst); queues and event logs are lost (AOF limits the loss); the orphan sweep fails queued rows whose queue entries vanished |
| PostgreSQL unavailable | Admission fails closed (500) after the pre-check; running generations cannot transition, so they stop being published |

## Scalability Considerations

- **Gateways** scale horizontally; they hold only open client connections and one blocking Valkey connection each.
- **Cells.** One dispatcher leader, one Valkey shard and a few hundred replicas form a cell. The edge assigns each tenant a home cell by consistent hashing (with bounded load, again), so a tenant's queues, buckets and fairness state are local to one cell. Big tenants get several cells and a split budget.
- **Replicas** are the cost. Scale on queue time and slot occupancy rather than CPU, keep 20-30% headroom for rollouts, and scale bulk capacity on a schedule (bulk tolerates hours).
- **PostgreSQL.** Partition `requests` and `usage` by day and shard by org at the largest scale. Batch usage inserts. Move rejection counts and per-minute aggregates to an OLAP store (ClickHouse) fed from a log, not from the request table.
- **Event logs.** Coalesce deltas per decode step (one entry per request per step at most, several tokens when the replica runs ahead) and shard by request id.
- **What breaks first** at 10× local traffic: replica slots. Queue time climbs, bulk shares hold, and then the bounded queues shed with 529. At 100×: the single dispatcher's Valkey round trips (~5 per dispatch plus one pipeline per backend read). Batch the claim with the class state, and split into cells.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Admission unit | Reservation: input + max_tokens, refund the rest | Request count; post-hoc token billing | Bounds outstanding work by real cost before it starts |
| Over-limit vs overload | 429 + exact Retry-After vs 529 + jittered hint | One status for both | Clients need to know whose problem it is |
| Rejection path | Lua pre-check, no DB write | Insert then reject | A noisy tenant's rejections must not load the source of truth |
| Fairness | Per-tenant queue share + DRR by cost, tier-weighted | Rate limits only; strict per-tenant concurrency caps | Fair when contended, work-conserving when not |
| Priority | Separate interactive and bulk lanes with min/max bulk share | One queue with priorities | No head-of-line blocking; bulk never starved, interactive keeps headroom |
| Replica batching | Continuous (iteration-level) | Static batches | Slots aren't held by finished short requests |
| Dispatcher batching | Admission groups: full, max wait, deadline | Dispatch each request immediately | Fewer admission stalls; bounded extra latency |
| Routing | Consistent hash + bounded load on the prefix key | Least-loaded; pure hashing | Cache reuse without hot spots; ~1/N keys move on change |
| Pinning | Re-route only before the first token | Resume or restart elsewhere | Streams never duplicate or splice tokens |
| Request state | PostgreSQL row with guarded transitions | State in the gateway or in Valkey only | Durable, any gateway can serve it, races decided by row locks |
| Event delivery | Per-request Valkey stream, one multiplexed XREAD per gateway | Pub/sub; an in-process stream | Resumable, survives gateway changes, replayable |
| Live admin data | 1 s short polling of one snapshot | SSE / WebSocket | Aggregated from several stores; no long-lived connection per operator |
| Dispatcher HA | Leader lease + recovery sweeps | Active-active with shared claims | Simple, single writer per request; failover in ~3 s |

## Implementation Notes

### Local architecture

| Process | Default port | Entry point | Role |
|---------|--------------|-------------|------|
| Gateway | 3000 (second: 3001) | `backend/src/gateway/index.ts` | Public API, console API, admin API, admission, SSE |
| Dispatcher | 3100 (metrics) | `backend/src/dispatcher/index.ts` | Leader lease, batch policy, DRR, router, stream relay, sweeps |
| Mock backends b1, b2, b3 | 3101-3103 | `backend/src/backend/index.ts` | Continuous-batching engine, prefix cache, versions, chaos |
| Frontend | 5173 | `frontend/` | Developer console and admin console (Vite proxy to the gateway) |
| PostgreSQL 16 / Valkey 7 | 5432 / 6379 | `docker-compose.yml` | Source of truth / hot state |

Every port and connection string has a default and an environment override (`PORT`, `DISPATCHER_PORT`, `BACKEND_PORT`, `BACKEND_URLS`, `DATABASE_URL`, `REDIS_URL`, `VITE_PORT`, `API_TARGET`, and `INFERENCE_PG_PORT` / `INFERENCE_VALKEY_PORT` for docker-compose).

### Production-grade patterns actually implemented

- **Atomic cost-based admission** (`shared/cache.ts` `ADMIT`, `gateway/submit.ts`). The token bucket, request bucket, tenant share and class bound are checked, and the charge and enqueue applied, in one Lua script, with a dry-run pre-check before the durable insert. At scale this is what keeps admission at one round trip and keeps rejection traffic off the database.
- **Guarded state transitions** (`shared/state-machine.ts`, `shared/requests.ts` `transition`). The WHERE clause is generated from the transition table, so the code cannot express an illegal move, and races are decided by PostgreSQL row locks. Tested against a real database in `shared/requests.race.test.ts` (50 concurrent cancel/complete pairs, exactly one winner each).
- **Exactly-once usage and refund** (`finalizeUsage`). `INSERT … ON CONFLICT DO NOTHING`, then refund only on insert.
- **Reliable queue with claims and recovery** (`CLAIM`, `REQUEUE`, `dispatcher/loop.ts` sweeps). Claimed work sits in an in-flight set until a terminal state. Expiry, recovery and orphan sweeps cover crashes between steps.
- **Deficit round robin by cost** (`dispatcher/fairness.ts`) and **class capacity with bulk min/max share** (`dispatcher/batch-policy.ts`).
- **Bounded-load consistent hashing** (`dispatcher/router.ts`) with a membership-change simulator that the routing page and tests use.
- **Leader lease** for the dispatcher (`SET NX PX` + compare-and-renew), so a standby (`npm run dev:dispatcher2`) takes over in ~3 s.
- **A multiplexed stream reader** (`gateway/stream-hub.ts`): one blocking XREAD per gateway for all of its waiting requests, interrupted with `CLIENT UNBLOCK` on a new subscription.
- **Prometheus metrics** (`shared/metrics.ts`) with the latency split, and **structured logging** (pino) with the request id.

```ts
// shared/requests.ts: the cancel/complete race in one line each
const row = await transition(pool, id, 'completed', { output_text, stop_reason, finished_at })  // null → a cancel won
const row = await transition(pool, id, 'cancelled', { cancel_reason, finished_at }, orgId)       // null → it had already finished
```

### Simplified or substituted

- **Mock model backends** instead of GPUs. The timing model (per-step decode, prefill cost per uncached token, admission stall per group) is calibrated to make the design's effects visible, not to predict real hardware. A real provider adapter is not included; the gateway speaks the Messages API shape, so one would sit behind the dispatcher in place of a mock.
- **Token estimate** is ~4 characters per token instead of the model's tokenizer. The mocks count input the same way, so input estimates are exact here and only output length is uncertain, which is the realistic case.
- **One cell**: one dispatcher leader, one Valkey and one PostgreSQL, instead of cells with tenant homing.
- **Session auth** for the console. A production console would use SSO; API keys are already the production pattern.
- **Valkey as the queue.** At production scale the queue could stay in Valkey per cell (it is small and hot) or move into the dispatcher's memory with a write-ahead log.
- **Defaults scaled down**: 8 slots per backend, batch size 4, 25 ms interactive wait. The 100-input exercise number is a config value (`BATCH_MAX_SIZE=100 BACKEND_SLOTS=100`).

### Omitted

- Multi-region and failover between cells; tenant homing at the edge.
- Real GPUs, KV-cache memory pressure and preemption; chunked prefill; speculative decoding.
- Sampling parameters (temperature, top-p) beyond the deterministic mock; tool use; images.
- Billing and invoicing (usage rows are the input to it); per-key spend limits.
- An OLAP pipeline for usage analytics; the admin console reads PostgreSQL directly for the last hour.
- Autoscaling of replicas from the queue-time signal.

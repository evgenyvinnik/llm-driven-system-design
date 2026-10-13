# LLM Inference Batching - System Design Answer (Backend Focus)

*45–50 minute system design interview · Backend engineer · The model is a black box: up to 100 inputs per batch, about 100 ms per batch*

## 🎯 Introduction (2 minutes)

> "Let me restate the problem. One GPU can process up to 100 inputs per batch. Users call us synchronously and wait for their own result. I need to design intake, batching, GPU execution, and getting each of the 100 outputs back to the right one of 100 waiting callers. Then I'll scale it to a fleet where GPUs die mid-batch."

> "My one-line framing: the GPU is the only expensive thing in this system, so batches should be as full as possible. But a person is waiting on every request, so no request should ever wait for a batch that isn't coming. Almost every decision today is a trade between those two sentences."

I'll treat the model as a black box and spend the time on queuing, batching, routing, and error handling.

---

## 📋 Requirements Clarification (4 minutes)

### Clarifying Questions

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Does batch time depend on how full the batch is? | Decides whether a small batch is cheap or wasteful | ~100 ms regardless of fill: reading the weights dominates, so 1 input costs almost as much as 100 |
| One forward pass per request, or token-by-token generation? | Static batching works for the first; generation needs continuous batching | One forward pass (classify, embed, short completion); generation is the evolution at the end |
| How long will a caller wait? | Bounds queue depth and retries | Caller sends `timeout_ms`; default 1,000 ms |
| How much traffic? | Fleet size | 70,000 req/s peak, 35,000 average |
| One model or several? | A batch can only hold one model | Several models; big ones get dedicated GPUs |
| Multi-tenant? | Fairness and noisy neighbors | Yes: per-tenant rate and in-flight limits |

### Functional Requirements

1. A caller sends an input and blocks until it gets its output, an error, or its deadline passes
2. Concurrent requests for the same model are grouped into batches of up to 100
3. Each output is returned to exactly the caller that sent the input
4. A batch can partially fail; each request gets its own outcome
5. The system spreads load across a GPU fleet and survives a GPU dying mid-batch
6. Retries with an `Idempotency-Key` never compute or bill twice

### Non-Functional Requirements

| Property | Target |
|----------|--------|
| Latency | p50 ≈ 160 ms, p99 < 300 ms server-side (100 ms of it is compute) |
| Goodput | 99.9% of accepted requests answered within deadline |
| Efficiency | Mean batch fill ≥ 60% at peak; plan for 70% |
| Overload | Excess rejected in < 5 ms with 503 + Retry-After, never left to time out |
| Failover | A dead GPU affects only its in-flight batch; traffic moves away within 300 ms |

---

## 🧮 Back-of-Envelope (5 minutes)

> "I want the numbers before the boxes, because the flush policy falls straight out of them."

**One GPU:**
- Full batches: 100 inputs every 100 ms = **1,000 req/s**. Without batching: 10 req/s. Batching is worth 100x.
- Below saturation, a new request waits for the in-flight batch to finish (uniform 0–100 ms, mean 50 ms), then runs for 100 ms, plus ~10 ms of network and serialization. So **p50 ≈ 160 ms and p99 ≈ 210 ms**.
- I plan each GPU at **70%: 700 req/s, average batch of 70**. I'll justify 70% in deep dive 1.
- **Admission cap:** a busy GPU drains 1 request per ms. With a 1,000 ms deadline, a request also needs up to 100 ms for the in-flight batch and 100 ms for its own batch, so anything behind more than **800 queued requests** is guaranteed to miss its deadline.

**Fleet:**

| Quantity | Math | Result |
|----------|------|--------|
| Lower bound on GPUs | 70,000 / 1,000 | 70 at 100% fill |
| Planned GPUs | 70,000 / 700 | 100 |
| Without batching | 70,000 / 10 | 7,000 GPUs |
| Batches per second | 100 GPUs × 10 | 1,000, average size 70 |
| Requests in flight (Little's law) | 70,000 × 0.16 s | ≈ 11,200 held connections |
| Per intake node (10 nodes) | 11,200 / 10 | ≈ 1,120 connections, ~3 MB of state |
| Bandwidth (2 KB in, 2 KB out) | 70,000 × 2 KB | 140 MB/s ≈ 1.12 Gbps each way; ~11% of one 10 Gbps NIC |
| Daily volume | 35,000 × 86,400 | ≈ 3.0B requests |

> "Holding 11,200 connections and 34 MB of pending requests is trivial. The network is trivial. The only scarce resource is GPU time, so the whole design is about filling batches without making callers wait."

---

## 🏗️ High-Level Architecture (5 minutes)

```
┌────────────┐   POST /v1/infer    ┌──────────────────┐    ┌───────────────────────────┐
│  Clients   │────(held open)─────▶│ LB + API Gateway │───▶│ Intake nodes (×10)        │
│ deadline,  │◀────────────────────│ auth, rate limit │◀───│ waiter map · admission ·  │
│ idem. key  │      result         └──────────────────┘    │ router (power of 2 choices)│
└────────────┘                                             └─────────────┬─────────────┘
                                         gRPC stream per worker:         │  ▲
                                         InferItem down, InferResult up  ▼  │
                ┌──────────────────────────────────────────────────────────────────────┐
                │ GPU workers (×100), one process per GPU                              │
                │ ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   │
                │ │ deadline queue   │──▶│ batcher: ≤100,   │──▶│ executor + GPU   │   │
                │ │ per model        │   │ 20 ms gather     │   │ ~100 ms / batch  │   │
                │ └──────────────────┘   └──────────────────┘   └──────────────────┘   │
                └─────────────────────────────────┬────────────────────────────────────┘
                                                  │ heartbeats, load
┌──────────────────┐   ┌──────────────────┐   ┌───▼──────────────┐   ┌──────────────────┐
│ Redis            │   │ ClickHouse       │   │ Fleet Manager    │──▶│ PostgreSQL       │
│ idempotency keys │   │ request + batch  │   │ membership,      │   │ models, workers, │
│ tenant buckets   │   │ metadata logs    │   │ drain, placement │   │ placements, audit│
└──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘
```

| Component | Responsibility | Why it exists |
|-----------|----------------|---------------|
| Intake node | Holds the HTTP connection, assigns a request ID, validates input, runs admission, keeps the waiter map | The async-to-sync boundary |
| Router (library inside intake) | Picks a worker per request by power of two choices | No extra network hop |
| GPU worker | Per-model deadline queue, batcher, executor, per-item results | Only the GPU host knows when the GPU is free |
| Fleet Manager | Membership (active, draining, dead), placement, autoscaling, operator actions | Control plane, off the request path |
| Redis | Idempotency keys and short-lived results, tenant token buckets | Shared state that must be fast |

> "Notice where batching lives: on the worker, not in a central batcher. The intake tier decides *which* GPU; the worker decides *when* and *with whom*. Only the GPU host knows the exact moment its GPU frees up, and later, with continuous batching, its free memory."

---

## 🔌 API Design (3 minutes)

```
POST /v1/infer                          → Synchronous inference; body: model, input, timeout_ms
GET  /v1/models                         → Models, max batch size, status
POST /api/v1/admin/workers/:id/drain    → Stop routing new work; finish in-flight
POST /api/v1/admin/workers/:id/fail-over→ Mark dead now; retry its in-flight requests elsewhere
PUT  /api/v1/admin/models/:id/batch-policy → Change max batch size / gather window
GRPC GpuWorker.Submit (bidi stream)     → InferItem in, InferResult out, one stream per intake node
GRPC GpuWorker.Cancel                   → Caller disconnected; drop the item if not yet batched
```

| Status | Meaning | Retry? |
|--------|---------|--------|
| 200 | Result, with queue_ms and compute_ms timings | — |
| 422 | Input can never succeed (too large, invalid) | Never |
| 429 | Tenant over its rate limit | After Retry-After |
| 503 | Admission rejected, or worker lost with no time to retry | Yes, same Idempotency-Key, jittered backoff |
| 504 | Deadline passed | Only if the caller still has time |
| 500 | Item failed deterministically after one server retry | No |

> "The request carries an absolute deadline all the way to the worker. That one field lets every stage drop work whose caller has already left."

---

## 💾 Data Model (3 minutes)

The request path holds almost nothing durable. Two in-memory structures do the real work:

| Structure | Lives on | Key | Holds |
|-----------|----------|-----|-------|
| Waiter map | Each intake node | request_id | The held response, deadline timer, attempt number, assigned worker |
| Deadline queue | Each GPU worker, one per model | earliest deadline first | Input, deadline, reply stream, cancelled flag |

The durable tables are control plane and logs:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| models (PostgreSQL) | id, version, max_batch_size, max_wait_ms, expected_batch_ms, watchdog_ms | PK | Batch policy is per model and changeable at runtime |
| gpu_workers | id, rpc_endpoint, zone, status, epoch, version, last_heartbeat_at | status; (zone, status) | Status: provisioning → active → draining → drained, or suspect → dead |
| model_placements | (worker_id, model_id), state, weight | (model_id, state) | Which models are loaded where; weight is the GPU-time share when co-located |
| operator_actions | id, idempotency_key (unique), actor, action, worker_id, reason, status | (worker_id, created_at) | Audit and dedup for drain / fail-over |
| request_log (ClickHouse) | request_id, model_id, status, attempts, batch_id, worker_id, queue_ms, compute_ms | ORDER BY (model_id, received_at) | Metadata only, never bodies; ~30 GB/day compressed |
| batch_log (ClickHouse) | batch_id, worker_id, size, flush_reason, status, failed_items | ORDER BY (model_id, worker_id, dispatched_at) | ≤ 86.4M rows/day |
| idem:{tenant}:{key} (Redis) | request_id, then serialized result | TTL 30 s after completion | Coalesces duplicates, replays results |

---

## 🔧 Deep Dive 1: The Flush Policy and the 100 ms Math (9 minutes)

> "The headline question is 'wait for a full batch, or flush on a timer?' My answer is that the GPU's state decides, not a fixed rule."

**Decision:** a worker dispatches a batch when its GPU is free **and** either 100 requests are waiting or the oldest has waited 20 ms (the gather window). When forming the batch, it skips cancelled requests and expires any whose remaining deadline is shorter than one batch time.

### Why it works: two regimes

Because a batch costs 100 ms whether it holds 1 input or 100, the real question is what else the GPU could be doing.

**When the GPU is busy** (any load above roughly 8 req/s per GPU), requests pile up during the in-flight batch. When the GPU frees, the oldest waiter has already waited longer than 20 ms, so the batch goes immediately with everything that arrived. Batch size self-adjusts to arrival rate × 100 ms: 70 at 700 req/s, 10 at 100 req/s. The gather window doesn't matter here.

**When the GPU is idle**, the first request opens a 20 ms window. That matters because real traffic is bursty: one client fans out 50 requests in a loop.

```
Idle GPU, 50 requests arrive within ~5 ms

No gather window:   [req 1 alone ████ 100 ms][reqs 2–50 ████ 100 ms]     → most finish at ~200 ms
20 ms gather:       [wait 20][all 50 ████ 100 ms]                        → all finish at ~120 ms
```

The first request pays 20 ms; the other 49 each save about 80 ms.

### How "wait for a full batch" breaks

At 700 req/s a batch fills in 100 ms, so it looks fine in a load test. At 100 req/s, filling takes 1 s, which alone blows a 1 s deadline. At 1 req/s it takes 100 s. And the last few requests of a trickle wait forever, because the 100th request never comes. Full-batch-only ties latency to traffic volume, which is backwards for a synchronous API: a quiet night is when the service gets slowest.

A **fixed timer** (flush every T ms no matter what) is the other common answer, and it is also strictly worse. If the GPU is busy when the timer fires, the batch can't run anyway. If it's idle, the timer adds up to T ms of pointless waiting.

| Policy | Low load (10 req/s) | Planned load (700 req/s) | Verdict |
|--------|---------------------|--------------------------|---------|
| ❌ Full batch only | Batches take 10 s to fill; deadlines missed | Fine | Starves at low load |
| ❌ Fixed timer, T = 50 ms | +50 ms on every request | Timer fires while GPU is busy; no effect | Adds latency, buys nothing |
| ❌ Dispatch the instant the GPU is free | Batch-of-1 blocks bursts for 100 ms | Same as chosen | Hurts bursty traffic |
| ✅ GPU free AND (full OR 20 ms gather) | ~120 ms latency | ~160 ms p50, ~210 ms p99 | Fill adapts to load |

### Why plan for 70%, not 95%

> "If one GPU does 1,000 req/s, why not run it at 950?"

With Poisson arrivals at 700 req/s, a 100 ms window gets 70 requests on average with a standard deviation of about 8.4. More than 100 arrivals is 3.6 standard deviations out, about 0.02% of windows. At 900 req/s the mean is 90 and the standard deviation about 9.5, so more than 100 arrivals is only about 1 standard deviation out, roughly 15% of windows. Each overflow waits an extra 100 ms and spills into the next window, so p99 climbs past 300 ms long before the GPU is "full". The 30% headroom is also what absorbs a GPU failure: losing 10 of 100 GPUs moves the rest from 700 to about 778 req/s.

### Admission control

Beyond 800 queued per GPU, the request will miss a 1 s deadline. So the router estimates completion time on its chosen worker (queue depth ÷ 1,000 req/s, plus 100 ms for the in-flight batch, plus 100 ms of compute) and rejects with **503 and Retry-After in about a millisecond** if it won't make the caller's deadline.

> "Without this, overload turns into 100% timeouts. Every request waits its full second, the GPU computes answers for callers who already left, and goodput drops to near zero while the dashboard shows the GPU 100% busy. Fast rejection is what keeps the requests we do accept on time."

**What I give up:** at low load, batches are small: the GPU spends 100 ms on 10 inputs. On a dedicated GPU that's not waste (it would otherwise idle), but it is a signal. A pool whose fill ratio stays under 30% should shrink or share its GPUs with another model. And the 20 ms window costs a lone request at 3 a.m. an extra 20 ms for nothing.

---

## 🔧 Deep Dive 2: Async-to-Sync Mapping and Failure Semantics (9 minutes)

> "The second hard part is that the HTTP request is synchronous but its execution isn't. One caller's input runs on another machine, inside a batch with 99 strangers, and the answer has to find its way home."

### The mapping

1. The intake node assigns a request ID and an absolute deadline, then stores a **waiter** in its in-memory map: the held response, a deadline timer, the attempt number, and which worker it went to.
2. The router sends the item down a long-lived gRPC stream to the chosen worker.
3. The worker returns each result, tagged with the request ID, **on the same stream** it arrived on. Routing back is automatic: there's no global table of which intake node holds which request.
4. The intake node looks up the request ID and settles the waiter. **The first outcome wins**, whether that's a result, a timeout, or a cancellation. Anything that arrives afterward finds no waiter and is counted as wasted compute.

> "If I used a broker instead of direct streams, I'd stamp each request with a reply-to address of its intake node and publish results to one channel per node. I would not use one channel per request: at 70,000 req/s that's 70,000 subscribe/unsubscribe calls a second on the broker for no benefit."

### Decision: the caller's connection is the durable copy

I keep queues in memory and put no durable broker on the request path.

**Why it works:** a synchronous request has value only while its caller waits, about a second. If a worker's queue disappears, every intake node that sent it work still holds those waiters and knows exactly which requests went there, so it can re-send them. If an intake node dies, its callers see a dropped connection and retry with the same idempotency key. Recovery always comes from someone who is still waiting.

**How a durable broker breaks:** Kafka or a persisted stream adds a few milliseconds of write latency to every request and protects work nobody wants. After a 5-minute broker outage it replays 5 minutes of requests whose callers gave up long ago. The fleet spends its first minutes after recovery computing answers nobody will read while live requests time out behind them. Durability is right for async jobs; for a 1 s synchronous call it actively hurts.

**What I give up:** a worker crash loses its queue, so recovery depends on intake nodes tracking which worker holds which request. That's the waiter map, which I need anyway.

### The reported failure follow-ups

**"What happens on queue failure?"** First I'd ask which queue. If a worker's queue dies (process crash), the gRPC stream breaks within milliseconds. Each intake node walks its waiter map for that worker and re-dispatches every request with at least 250 ms of deadline left. The rest get 503, which is retryable. If a shared broker dies (the local build uses one), a circuit breaker opens and intake fails fast with 503. I would never buffer locally, because buffered requests outlive their callers.

**"What about compute timeouts?"** There are two clocks, and conflating them is a classic bug:

| Clock | Owner | Fires at | Action |
|-------|-------|----------|--------|
| Per-request deadline | Intake node | Caller's timeout_ms | 504 to the caller; the worker skips the item if it hasn't been batched |
| Per-batch watchdog | Worker | 300 ms (3x expected) | GPU is presumed hung: mark the worker suspect, stop routing to it, retry its in-flight requests elsewhere, restart it |

The deadline answers "should we keep trying for this caller?" The watchdog answers "is this GPU healthy?" A GPU can be hung while its process still answers a liveness probe, which is why worker health is measured by batch progress, not by a ping.

**"What about partial batch failure?"** Every batch result carries a per-item status. Successes return immediately; a batch never fails as a unit if the runtime can report per-item errors. Failed items are classified:
- **Deterministic** (input too long, invalid encoding): return 422 or 500. Never retry, because it fails the same way every time. Most of these should have been rejected at intake by validation.
- **Transient** (a numerical blip, a lost worker): retry once on a different worker if at least 250 ms of deadline remains.

**The poison pill.** The dangerous case is one input that crashes the whole batch, for example by triggering an out-of-memory error. If I retry the 70 requests together, the poison input kills the next GPU too, and so on across the fleet. So on a whole-batch failure I retry the survivors once, **scattered across different batches**, and any request that has been in two failed batches is quarantined and failed with 500. Innocent requests pay at most one extra batch; the poison input takes down at most two batches.

| Approach | Outcome |
|----------|---------|
| ✅ Per-item status, scattered single retry, two-strike quarantine | Failure contained to two batches; innocent requests usually still succeed |
| ❌ Retry the whole batch together | A poison input crashes every GPU it touches |
| ❌ Fail the whole batch | 69 innocent callers get errors for one bad input |
| ❌ Bisect the batch to find the culprit | log₂(100) ≈ 7 rounds of 100 ms; doesn't fit a 1 s deadline |

### Retries are safe here, within limits

Inference has no side effects, so the system is **at-least-once on compute and at-most-once on delivery**. A request may run twice (on a presumed-dead GPU and on its retry), but the waiter settles once. Usage is metered once per request ID. Server-side retries are capped at one per request and by a **retry budget** of 10% of a pool's traffic per minute. If a bad rollout breaks a whole pool, retrying everything would double the load on a sick fleet, so past the budget we fail fast.

The client's `Idempotency-Key` covers the other direction. A duplicate that arrives while the original is in flight attaches to the same waiter, so nothing is computed twice. A duplicate that arrives after completion gets the cached result from Redis (30 s TTL).

---

## 🔧 Deep Dive 3: Scaling to a GPU Fleet (9 minutes)

> "The fleet extension asks three things: how do we know which GPU has capacity, how do we balance load, and what happens when a GPU dies mid-batch. I'd add a fourth: mixed-model GPUs."

### Knowing which GPU has capacity

Each router combines two signals per worker:
1. **Its own outstanding count** to that worker: incremented on send, decremented on result. It's exact for this router's traffic and costs nothing.
2. **The worker's reported queue depth**, piggybacked on every result and on a 1 s heartbeat. It covers other routers' traffic and is at most a few hundred ms old under load.

Membership (who is active, draining, or suspect) comes from the Fleet Manager as a versioned snapshot. If the Fleet Manager goes down, routers keep their last snapshot, so the data path doesn't depend on the control plane.

### Decision: power of two choices, pushing to per-GPU batchers

For each request, the router samples two random ready workers for that model and sends to the less loaded one.

**Why it works:** P2C needs only two samples and is robust to stale data. Its theoretical guarantee is an exponential improvement in maximum queue length over random assignment.

**How the alternatives break:**
- **Round robin** ignores load. A GPU that is thermally throttled and runs batches in 150 ms keeps getting its equal share, its queue grows, and that GPU's requests become the p99.
- **Global least-loaded** needs fresh global state. With 10 routers looking at the same second-old snapshot, all of them pick the same "emptiest" worker at once and bury it. That's herding.
- **A shared per-model queue that GPUs pull from** is genuinely attractive: capacity tracking disappears, because a free GPU asks for work, and batches fill from the whole fleet's traffic. I'd build that first for a small fleet, and the local build does exactly that with Redis Streams. At 70,000 req/s, though, it puts every request through one more component per model, makes that component a whole-model outage, and can't express continuous batching, where admission depends on each GPU's free memory.

**What I give up:** per-GPU queues fragment traffic, so at low load each GPU's batches are smaller than a fleet-wide queue would make them. I handle that with the autoscaler (shrink pools with low fill) rather than with central batching.

### Failover when a GPU dies mid-batch

```
t=0      request enqueued on worker 017 (deadline t=1,000)
t=60     dispatched in a batch of 70
t=110    GPU hangs mid-batch ─────────────┐ process crash instead? stream breaks now,
t=360    watchdog fires (300 ms)          │ intake reacts within milliseconds
         ├─ worker 017 marked suspect; routers drop it from P2C
         └─ intakes walk waiter maps: 640 ms left ≥ 250 ms → retry on worker 042
t≈570    worker 042 returns the result (≤100 ms wait + 100 ms compute + overhead) → 200 to caller
t=3,060  three missed heartbeats → Fleet Manager marks 017 dead, bumps its epoch
```

Detection is layered from fastest to slowest: a broken stream (crash, milliseconds), the batch watchdog (hang, 300 ms), then missed heartbeats (confirmation, 3 s). If 017 comes back as a zombie and delivers late results, they find no waiter and are dropped. Its bumped epoch means it must re-register before receiving traffic. Losing one GPU of 100 moves the rest from 70% to about 70.7% fill, which is noise.

### Mixed-model GPUs

A batch can only hold one model, because every input in a batch runs through the same weights. So:
- **High-traffic models get dedicated pools.** No contention, simple scheduling.
- **Low-traffic models share GPUs** when their weights fit, for example two 30 GB models on an 80 GB GPU, leaving 20 GB for activations. The worker keeps one queue per model and picks the next batch by earliest deadline, weighted by placement. Here the gather window has a real cost: running a 10%-full batch of model B delays a full batch of model A by 100 ms.
- **Never swap weights per batch.** Loading 30 GB from host memory at ~25 GB/s takes ~1.2 s, the time of 12 batches (1,200 requests of capacity). From object storage at 10 Gbps it takes ~24 s. Placement changes on a timescale of minutes, decided by the Fleet Manager.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Dedicated pools + co-locate small models | Big models never contend; small models stop wasting whole GPUs | Two scheduling modes to operate |
| ❌ Every GPU serves every model | Maximum flexibility | Weights don't fit; or constant swaps at 12 batches each |
| ❌ Dedicated pools for everything | Simplest | A model with 50 req/s holds 2 GPUs (for redundancy) at 2.5% fill |

---

## 🚀 Production Evolution: Continuous Batching (3 minutes)

> "Everything so far assumes one forward pass per request. Real LLM generation runs one forward pass per output token, and output lengths vary wildly."

With static batching, a batch runs until its longest sequence finishes. If outputs average 200 tokens and the longest is 1,000, each slot does useful work for 200 of 1,000 steps: 20% utilization. Meanwhile new requests wait for the whole batch to drain.

**Continuous batching** re-forms the batch at every decode step. Finished sequences leave, new ones join after their prompt is processed, and slots stay full. Four things change:
1. **Admission becomes memory-bound.** The limit is free KV-cache memory, not a count of 100. The worker admits a request only if it can hold its prompt plus expected output, and preempts when memory runs out.
2. **The scheduler must live on the GPU host**, deciding every few tens of milliseconds. That's why I put batching on the worker from the start.
3. **Latency splits** into time to first token and time between tokens. Long prompts stall everyone's next step, so their processing is chunked.
4. **The response becomes a stream**, and cancellation frees real capacity, because a cancelled sequence leaves at the next step.

The intake tier, waiter map, admission control, P2C routing, and failover all carry over. Only the worker's batcher changes.

---

## ❓ Reported Follow-up Questions (2 minutes)

| Follow-up | Short answer | Covered in |
|-----------|--------------|------------|
| Queue failure? | Waiters survive on intake; re-dispatch with ≥ 250 ms left, else 503. Never buffer for callers who left | Deep dive 2 |
| Compute timeout? | Two clocks: per-request deadline (504) vs per-batch watchdog at 300 ms (GPU unhealthy) | Deep dive 2 |
| Partial batch failure? | Per-item status; retry transient items once; poison inputs quarantined after two strikes | Deep dive 2 |
| Too few requests to fill a batch? | Never wait for full; 20 ms gather window on an idle GPU; persistent low fill shrinks the pool | Deep dive 1 |
| Each batch takes 100 ms: throughput and latency? | 1,000 req/s per GPU; p50 ≈ 160 ms, p99 ≈ 210 ms; plan 700 req/s | Back-of-envelope, deep dive 1 |
| Which GPU has capacity? | Router's own outstanding count + piggybacked queue depth | Deep dive 3 |
| Load balancing? | Power of two choices; not round robin, not global least-loaded | Deep dive 3 |
| GPU dies mid-batch? | Stream break or watchdog; retry in-flight requests within deadline; epoch fences zombies | Deep dive 3 |
| Mixed-model GPUs? | One model per batch; dedicated pools for big models, co-location for small; never swap per batch | Deep dive 3 |

---

## 🔍 If I Were Reviewing a Design Doc for This (3 minutes)

> "One format I've heard of is reviewing someone's batched-inference design. Here's what I'd look for, roughly in order of how much damage each causes."

1. **"Collect 100 requests, then run."** No deadline. It works in the load test and starves at night.
2. **Capacity at 100%:** "10 GPUs × 1,000 req/s = 10,000 req/s." Queues blow up near saturation. At 70% that's 10,000 / 700 ≈ 14.3, so 15 GPUs, before failure headroom.
3. **No admission control.** Overload becomes 100% timeouts instead of fast 503s.
4. **A durable queue for synchronous requests.** Slower, and after an outage it replays work for callers who are gone.
5. **Results via database polling or a pub/sub channel per request.** Subscription churn at 70,000 req/s; reply on the request's stream or a per-node channel.
6. **One timeout for everything.** The caller's deadline and the GPU watchdog are different clocks.
7. **Retry the whole batch on failure.** A poison input then kills every GPU it's retried on.
8. **No deadline propagation.** Workers compute results for callers who left.
9. **Health check = "process alive".** A hung GPU passes.
10. **Mixed models in one batch, or a weight swap per batch.**
11. **"GPU utilization 100%" as the success metric.** A GPU running 5%-full batches is 100% busy. Measure fill ratio and goodput.

---

## 📈 Scalability: What Breaks First (2 minutes)

1. **The GPU pool, as a latency cliff rather than errors.** Past ~85% fill, overflow windows compound and p99 climbs from 210 ms toward 300 ms and beyond. Admission control turns the excess into 503s, and the autoscaler adds GPUs, but provisioning plus weight loading takes minutes. That's why I keep 30% headroom and scale on the trend.
2. **Single-model hot spots in a mixed fleet.** A spike on model A can't use model B's idle GPUs without a weight load. I keep warm standby placements for the top models.
3. **Control plane fan-out at 10,000+ GPUs:** 10,000 heartbeats a second and snapshot pushes to every router. I'd move to per-zone aggregators and delta snapshots.
4. **Not the intake tier, Redis, or the network.** Each intake node holds ~1,120 connections; bandwidth is 1.12 Gbps fleet-wide.

---

## 📊 Observability (1 minute)

| Signal | Why |
|--------|-----|
| Batch fill ratio (histogram per model) | The efficiency metric; drives autoscaling. GPU busy % hides a GPU running near-empty batches |
| Flush reason (full / backlog / gather timeout / drain) | Shows which regime a pool is in; mostly gather timeouts means over-provisioned |
| Queue depth per worker | Input to admission and routing |
| Latency by stage (queue, compute, total) | Merged histograms; percentiles are never averaged across workers |
| Goodput (successes within deadline) | The SLO numerator |
| Late results (results with no waiter) | Wasted compute; flags deadlines that are too short or over-eager retries |
| Watchdog timeouts, retries by cause | Hung GPUs and the retry budget |

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| ✅ Flush policy | GPU free AND (full OR 20 ms gather) | ❌ Wait for full batch | Full-only starves at low load; batch size self-adjusts when busy |
| ✅ Durability | Caller-held, in-memory queues | ❌ Durable broker | A 1 s request is worthless once its caller leaves |
| ✅ Batching location | On each GPU worker | ❌ Central batcher | Only the GPU host knows when it's free; path to continuous batching |
| ✅ Load balancing | Power of two choices | ❌ Round robin / global least-loaded | Robust to stale data, no herding |
| ✅ Overload | Deadline-aware admission, 503 | ❌ Unbounded queue | Prevents goodput collapse |
| ✅ Batch failure | Per-item status, scattered retry, two strikes | ❌ Whole-batch retry | Contains poison inputs |
| ✅ Server retries | One, deadline-checked, 10% budget | ❌ Retry until success | Bounds amplification on a sick pool |
| ✅ Capacity target | 70% fill | ❌ 90%+ fill | 90% overflows ~15% of windows |
| ✅ Multi-model | Dedicated pools, co-locate small models | ❌ Swap weights on demand | A swap costs 12+ batches |
| ✅ Generation | Continuous batching | ❌ Static batches | Static slot utilization is 20% at mean 200 / max 1,000 tokens |

---

## 📝 Summary

> "To summarize: a GPU runs 100 inputs in 100 ms, so it does 1,000 req/s at full batches and 10 without batching. Everything else follows from keeping batches full without making anyone wait.
>
> The flush policy dispatches when the GPU is free and the batch is full or 20 ms old. Under load, batches fill during the previous batch's compute; at low load, the gather window catches bursts, and nobody waits for a 100th request that isn't coming. I plan GPUs at 70% because Poisson overflow at 90% puts p99 over budget, and deadline-aware admission rejects in a millisecond what would otherwise time out after a second.
>
> For async-to-sync, each intake node keeps a waiter map from request ID to the held connection, and results come back on the stream the request went out on. The caller's connection is the durable copy, so queues stay in memory and failures are handled by re-dispatching from intake within the deadline: per-item status for partial failures, a scattered retry with a two-strike quarantine for poison inputs, and separate clocks for the caller's deadline and the GPU watchdog.
>
> At fleet scale, routers use power of two choices on their own outstanding counts plus piggybacked queue depth; a dead GPU costs one in-flight batch and a retry; and big models get dedicated pools while small ones share. For generation workloads, continuous batching replaces the worker's batcher, and the rest of the design carries over."

# Text-to-Video Generation - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 🎯 Introduction (2 minutes)

"Thanks. I'll design a Sora-style service: a user types a prompt and gets a video clip back minutes later. I'll treat the model as a black box that takes a prompt and parameters, runs for a fixed number of steps on exactly one GPU, reports progress per step, and can save and restore its intermediate state.

What makes this hard isn't the model. Three things are. First, each job holds a scarce, expensive GPU for anywhere from 40 seconds to 10 minutes, so this is an asynchronous job system, not request/response. Second, GPUs are the bottleneck, which means fairness across users and paid tiers, cancellation, and burst handling are product requirements, not afterthoughts. Third, GPUs fail mid-job, and the job has to survive that without being run twice in ways the user can see.

As a backend engineer I'll focus on the job API and state machine, the fair scheduler, cancellation and failure recovery, admission control during bursts, and the safety and delivery pipeline around the GPUs."

---

## 📋 Requirements Clarification (4 minutes)

### Functional Requirements

1. **Submit a generation**: prompt up to 2,000 characters, duration (5, 10 or 20 s), resolution (480p, 720p, 1080p), and 1–4 variations. Each variation is its own job on its own GPU.
2. **Track it asynchronously**: get a job ID immediately, then status, an ETA while queued, step progress while running, and the video when done.
3. **Cancel** a queued job or a running one. Cancelling a running job must free its GPU.
4. **Fair sharing** across tiers (free, plus, pro) and across users within a tier, with per-user caps.
5. **Admission control** during bursts: show a predicted wait, degrade or refuse with a clear reason.
6. **Safety** checks on the prompt before any GPU time, and on the output before anyone can view it.
7. **Deliver** finished videos through a CDN; gallery, delete, share.

### Non-Functional Requirements

| Property | Target |
|----------|--------|
| Submission acknowledgement | p99 < 500 ms, including the prompt check |
| Durability | No accepted job is ever lost: 202 only after the job row commits |
| Time to start | pro p90 < 1 min, plus p90 < 5 min, free best effort but never admitted above a 20-minute predicted wait |
| Progress freshness | Visible to the client within 3 s |
| Cancel a running job | GPU freed within one step (p99 < 15 s), hard kill at 30 s |
| GPU failure | Detected within 30 s; a 1080p job loses at most 25% of its work |
| Utilization | ≥ 75% averaged over a day |

### Out of Scope

- Model internals and training
- Jobs needing several GPUs at once (I'll mention it as an extension)
- Payment processing: credits already exist

> "I'm going to pin one number early: one GPU per task, minutes per task. Almost every decision today falls out of that."

---

## 📐 Capacity Estimation (4 minutes)

### Load and GPU Fleet

| Metric | Value | How I got it |
|--------|-------|--------------|
| Daily active creators | ~2M | Assumption |
| Jobs per day | 8.64M | ~4.3 per creator |
| Average rate | 100 jobs/s | 8.64M / 86,400 |
| Evening peak | 200 jobs/s | 2× for about an hour |
| Burst (launch, viral trend) | 500 jobs/s | 5× for about 10 minutes |
| Mean GPU time per job | 120 GPU-s | 60% drafts at 40 s, 30% standard at 120 s, 10% HD at 600 s → 24 + 36 + 60 |
| Busy GPUs on average | 12,000 | Little's law: 100 jobs/s × 120 s |
| Fleet | 15,000 GPUs | 80% average utilization; 3 regions × 5,000 |
| Fleet throughput | 125 jobs/s | 15,000 / 120 |
| Fleet cost | $720K/day | Assume $2 per GPU-hour × 15,000 × 24 |

> "I size the fleet for the daily average, not the peak. Provisioning for peak would roughly double the bill for GPUs that idle overnight. So the interesting part of this design is what happens when demand exceeds 125 jobs/s, and it will, every evening."

### What Queueing Can't Absorb

- **Evening peak**: 200 − 125 = 75 jobs/s of excess, so the backlog grows by 75 × 3,600 = **270,000 jobs per peak hour**. At average load the headroom is only 25 jobs/s, so draining takes 270,000 / 25 = 10,800 s = **3 hours**.
- **Burst**: 500 jobs/s × 600 s = 300,000 arrivals; the fleet serves 125 × 600 = 75,000; **225,000 left queued**, 2.5 hours to drain.
- That's why the design needs admission control, not just a bigger queue.

### Control Plane and Storage

| Path | Rate |
|------|------|
| PostgreSQL writes | ~5 state transitions per job → ~500/s average, ~1,000/s during a burst |
| Lease heartbeats | 1 per running job per 5 s → 2,400/s average, 3,000/s with the fleet full |
| Progress updates | 1 per running job per 2 s → 6,000/s average, 7,500/s with the fleet full |
| Output storage | 4 MB mean per video → 34.56 TB/day, ~12.6 PB/year before retention |
| Playback egress | 3 plays per video → 103.68 TB/day ≈ 1.2 GB/s ≈ 9.6 Gbps, through the CDN |

> "The control plane is small. A few thousand small messages a second fit one scheduler process. The scale problem is entirely GPU-seconds."

---

## 🏗️ High-Level Architecture (5 minutes)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Clients: web · mobile · API customers                                      │
└────────────┬───────────────────────────────────────────────▲───────────────┘
             │ REST submit/cancel/list + SSE job events       │ MP4 · poster · preview
             ▼                                                │
┌───────────────────────────┐                     ┌───────────┴──────────────┐
│ API Gateway               │                     │ CDN (signed URLs,        │
│ auth · rate limit · TLS   │                     │ immutable keys)          │
└──────┬─────────────┬──────┘                     └───────────▲──────────────┘
       ▼             ▼                                        │ origin pull
┌─────────────┐ ┌─────────────┐                   ┌───────────┴──────────────┐
│ Job API     │ │ SSE Gateway │◀── Redis pub/sub ─│ Object Storage           │
│ admission · │ │ per-user    │    + progress     │ checkpoints · mezzanine  │
│ idempotency │ │ streams     │         ▲         │ quarantine · serving     │
└─┬───┬────┬──┘ └─────────────┘         │         └──▲──────────────────▲────┘
  │   │    ▼                            │ progress   │ upload           │ publish
  │   │ ┌──────────────┐          ┌─────┴────────────┴──┐               │
  │   │ │Prompt Safety │          │ GPU Workers         │               │
  │   │ └──────────────┘          │ one job per GPU     │               │
  │   ▼                           └─────────▲───────────┘               │
  │ ┌───────────────────────┐  leases ·     │                           │
  │ │ Scheduler (leader per │◀─ heartbeats ─┘                           │
  │ │ GPU pool) fair queue ·│                                           │
  │ │ caps · ETA            │                                           │
  │ └──────────┬────────────┘                                           │
  ▼            ▼                                                        │
┌────────────────────────┐   ┌────────────────┐   ┌─────────────────────┴──┐
│ PostgreSQL jobs ·      │──▶│ Kafka          │──▶│ Post-processor         │
│ attempts · videos ·    │   │ job-events     │   │ transcode · output     │
│ credits · outbox       │   │ (via outbox)   │   │ safety · watermark     │
└────────────────────────┘   └───────┬────────┘   └────────────────────────┘
                                     ▼
                              Notifier · billing
```

> "I separate the control plane, which decides what runs where, from the data plane, which moves bytes. And I separate two kinds of messages. Progress ticks go through Redis pub/sub, which is lossy and fast; dropping one is harmless because the next replaces it. State transitions go through PostgreSQL and an outbox to Kafka, which is durable; dropping a 'succeeded' would strand a user."

### Core Components

| Component | Responsibility |
|-----------|----------------|
| Job API | Validates, runs the prompt check, estimates cost, asks for admission, creates jobs idempotently, cancels |
| Scheduler | One leader per GPU pool: fair queue, per-user caps, leases, heartbeats, pushes cancel and drain, ETA model |
| GPU Worker | One process per GPU; keeps the model loaded; runs one job; checkpoints; encodes a mezzanine file |
| Post-processor | Transcodes delivery renditions, samples frames for the output check, watermarks, publishes |
| SSE Gateway | One stream per user tab, fed from per-user pub/sub channels, snapshot on connect |
| PostgreSQL | Durable job state, attempts, videos, credit ledger, outbox |

---

## 💾 Data Model (4 minutes)

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| tier_policies | tier (PK), weight, max_running, max_queued, max_wait_admit_s | PK | free 1/1/2, plus 3/2/10, pro 6/5/50 (weight / running / queued) |
| generation_jobs | id, user_id, batch_id, idempotency_key, prompt, params, est_gpu_seconds, status, attempt, lease_epoch, worker_id, checkpoint_step, version | unique (user_id, idempotency_key); partial on (pool, created_at) where queued; unique worker_id where dispatched or running | The unique worker index enforces one task per GPU in the database itself |
| job_attempts | (job_id, attempt), lease_epoch, gpu_uuid, resumed_from_step, outcome | (gpu_uuid, started_at) | Finds GPUs that fail every job |
| videos | id, job_id (unique), user_id, renditions, poster_key, safety_status, visibility, expires_at | (user_id, created_at) where passed and not deleted | Unsaved drafts expire after 30 days |
| credit_ledger | user_id, job_id, entry_type (reserve, capture, release), gpu_seconds | unique (job_id, entry_type) | Credits are GPU-seconds, the same unit the scheduler charges |
| outbox | aggregate_id, event_type, payload, published_at | partial on id where unpublished | Same transaction as every state change |

> "I keep the job and the video as separate entities. A job is a process: it can be retried, cancelled or blocked. A video exists only when a job succeeds. And `version` on the job row bumps on every change, so clients can order events without trusting delivery order."

### Job State Machine

```
 submit ─▶ queued ──dispatch──▶ dispatched ──heartbeat──▶ running ──final step──▶ postprocessing
             ▲  │                    │                       │                      │      │
             │  │ cancel             │ lease lost            │ cancel ack           │ pass │ fail
             │  ▼                    │ (attempt < 3)         ▼                      ▼      ▼
             │ cancelled ◀───────────┼─────────────────── cancelled           succeeded  blocked
             └───────────────────────┘
                                    running ── same error on 2 GPUs / attempts exhausted ──▶ failed
```

A prompt that fails the safety check never becomes a job; the request gets a 400 and only a safety event is recorded.

---

## 🔌 API Design (3 minutes)

```
POST   /api/v1/generations                → create 1–4 jobs; Idempotency-Key required; 202
POST   /api/v1/generations/estimate       → cost + predicted wait + admission decision, no side effects
GET    /api/v1/generations?state=active   → caller's jobs
GET    /api/v1/generations/:id            → status, progress, ETA band, video id
POST   /api/v1/generations/:id/cancel     → 200 if it was queued, 202 if a running cancel was requested
GET    /api/v1/events                     → SSE stream of all the caller's job events
GET    /api/v1/videos/:id                 → metadata + signed CDN URLs

Internal, worker ↔ scheduler (mTLS):
POST   /internal/v1/leases                → long-poll for an assignment
POST   /internal/v1/leases/:id/heartbeat  → renew; response may say cancel or drain
POST   /internal/v1/leases/:id/checkpoint → record step + object key (epoch checked)
POST   /internal/v1/leases/:id/complete   → mezzanine key + GPU-seconds used (epoch checked)
```

| Status | Meaning |
|--------|---------|
| 202 | Accepted; body has job IDs and an ETA band |
| 400 prompt_rejected | Safety block, with categories |
| 409 idempotency_conflict | Same key, different body |
| 429 user_queue_full | Per-user queued cap reached |
| 503 high_demand | Predicted wait above the tier's limit; Retry-After plus an offer of draft quality |

> "Why not hold the connection open for 10 minutes? Every load balancer idle timeout, mobile network switch and deploy would kill it, and it ties a client socket to a GPU's lifetime. Why SSE rather than polling? 200,000 online clients polling every 2 seconds is 100,000 requests a second, nearly all 'no change'. The real event rate is about 8,000 a second. Why not WebSocket? Everything the client sends, submit and cancel, is a plain REST call that wants idempotency keys and normal auth. Traffic only needs to flow one way."

---

## 🔧 Deep Dive 1: Fair Scheduling of Minute-Long GPU Jobs (10 minutes)

### The Decision

"I use two-level weighted fair queueing, implemented as stride scheduling, charged in estimated GPU-seconds, with per-user running and queued caps on top."

### How It Works

1. Each tier has a weight: pro 6, plus 3, free 1. When everyone is backlogged, those are the shares: 60%, 30% and 10% of dispatched GPU-seconds.
2. Each tier keeps a "pass" value, its GPU-seconds served divided by its weight. Inside a tier, each user has a pass too, with equal weights.
3. When a GPU asks for work, the scheduler takes the tier with the lowest pass that has an eligible job, then the user in that tier with the lowest pass. Eligible means the user is below their running cap, and the job fits the GPU's class and the model version it has loaded.
4. It charges the job's estimated GPU-seconds to both passes: an HD job costs 600, a draft 40.
5. When the job finishes, the scheduler settles the difference between estimated and actual GPU-seconds.
6. A tier or user returning from idle starts at the current minimum pass, so nobody banks credit while away.
7. Within one user, jobs run first in, first out.

### Why This Works Here

At peak, demand is 24,000 GPUs against 15,000. With the tier split I'm assuming (free 50%, plus 30%, pro 20% of demand), pro needs 4,800 GPUs and plus 7,200. Both fit inside their weighted shares. The leftover redistributes, so the paid tiers are served in full and free gets the remaining 3,000 GPUs: 25 free jobs/s against 100 arriving. Free degrades, but it never drops to zero, which strict priority would do the moment paid demand exceeded the pool.

> "Charging GPU-seconds instead of job count is the part people miss. If I count jobs, a user who only submits HD jobs gets 15 times the GPU time of someone submitting drafts at the same rate. Weighted fair queueing is only fair in the unit you charge."

### Why Fair Queueing Alone Breaks: Non-Preemptive Jobs

Fair queueing assumes you can reorder service quickly. Here, once a job is dispatched it holds the GPU for up to 10 minutes. Picture 4 a.m. with an idle pool: a work-conserving scheduler gives one user's batch of 500 jobs 500 GPUs. A second user arrives a minute later. The scheduler would happily serve them first, but there's nothing free to serve them on until those 500 jobs finish.

So I add caps: free users can hold 1 GPU at a time, plus 2, pro 5. Queued caps are 2, 10 and 50. The scheduler is work-conserving across tiers, so an idle tier's share flows to the others, but never beyond a single user's cap.

### Why Not Preemption Instead of Caps?

Preempting would throw away warm GPU work, or require a checkpoint on every preemption. It also turns out to buy very little. At full load, GPUs free up at 125 per second fleet-wide, so a paid job that is under its tier's share gets one of the next GPUs to free up within seconds. Preemption only helps in a small pool, like a rare GPU class, and I'd add it there if the metrics showed it was needed.

### Why One Scheduler Leader Per Pool

At 125 dispatches/s and 3,000 heartbeats/s, one process handles scheduling easily. Fairness is a global property, and sharding the scheduler would make it approximate. The leader keeps queues, passes and lease timers in memory; PostgreSQL is the durable truth. A hot standby takes over through a coordination lease, rebuilds the queues from a partial index on queued jobs in seconds, and gives running jobs a 60-second grace period to re-heartbeat. Losing the in-memory pass values costs a few seconds of imperfect fairness, never a job.

Workers pull: an idle GPU long-polls for a lease. A dead worker simply stops asking, and the scheduler never has to model which GPUs are free.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Two-level WFQ on GPU-seconds + per-user caps | Weighted shares, no starvation, no monopoly by one user | Needs a cost estimate; fairness is in GPU-seconds, which users don't see directly |
| ❌ FIFO | Simplest | One user's batch of 50 delays everyone behind it |
| ❌ Strict tier priority | Paid always first | Free starves completely when paid demand exceeds the pool |
| ❌ WFQ on job count | No cost model | HD-only users get 15× the GPU time |

**What I give up:** jobs are dispatched against an *estimate*. If the cost model is wrong by 2×, fairness is off until the settlement at completion corrects the pass. And the caps leave GPUs idle in one edge case: when a single user is the only one with work, they still get only 5 GPUs. I accept that. Idle GPUs at 4 a.m. are cheaper than a user locked out for 10 minutes at 4:01.

---

## 🔧 Deep Dive 2: Cancellation, GPU Failure and Checkpoints (9 minutes)

### Cancelling a Queued Job

"A single conditional update is the whole cancel: set status to cancelled where the ID matches, the user matches, and status is still queued. Dispatch uses the same pattern from the other side: set dispatched where status is still queued. PostgreSQL arbitrates the race. Whichever write lands first wins, and the loser sees zero rows updated. If cancel wins, the scheduler drops the job the next time it reaches it in its heap. If dispatch wins, the cancel falls through to the running path."

### Cancelling a Running Job

1. The API sets `cancel_requested` on the job row.
2. The scheduler pushes a cancel to that worker's control channel. The heartbeat response also carries the flag, as a backstop if the push is lost.
3. The worker stops at the next step boundary, frees the GPU's memory, **keeps the model weights loaded**, acknowledges, and long-polls for its next job.
4. If no acknowledgement arrives within 30 s, the node agent kills the process and runs a GPU health check before the slot rejoins the pool.
5. If the job completes before the cancel lands, completion wins. The user gets the video and is told it finished before the cancel.

> "Why cooperative rather than killing the process immediately? Killing frees the GPU in a second or two, but the next job then reloads tens of gigabytes of weights, and that costs more GPU time than waiting out one step. An HD step is about 12 seconds (600 GPU-seconds over 50 steps), which is where my 15-second cancel SLO comes from. The hard kill exists for hung workers, not slow ones."

Credits: cancelling a queued job releases the whole reservation. Cancelling a running job captures the GPU-seconds actually used and releases the rest.

### Detecting a Dead GPU and Not Running Twice

1. A worker heartbeats every 5 s. After 30 s of silence, the scheduler declares the lease lost.
2. It moves the job back to queued with `attempt + 1`, using a conditional update that still checks the old `lease_epoch`. The job keeps its original place at the head of its user's queue.
3. Every dispatch increments `lease_epoch`, and every worker call carries it. If the "dead" worker was only partitioned and comes back, its heartbeat or completion matches zero rows: it is fenced off and told to stop.
4. Each attempt uploads to its own object key, so a zombie upload can't overwrite the real one, and only the attempt whose completion won gets transcoded.

So execution is at-least-once, but every *effect* (the published video, the credit capture, the notification) happens exactly once.

### Should Every Job Checkpoint?

"Let me actually do the math before adding machinery."

Assume one job-killing fault per GPU every 1,000 GPU-hours. At 12,000 busy GPUs, that's 12 failures an hour, 288 a day. A fault lands on a random busy GPU-second, so long jobs are hit more often: HD holds 50% of busy time, standard 30%, drafts 20%. Without checkpoints, the expected work lost per failure is 0.5 × 300 + 0.3 × 60 + 0.2 × 20 = 172 GPU-seconds. Per day, 288 × 172 ≈ 49,500 GPU-seconds ≈ 13.8 GPU-hours out of 288,000 busy GPU-hours. That's about **0.005%**.

> "So checkpointing is not about fleet efficiency at all. It's about the roughly 144 HD users a day who would otherwise lose an average of 5 minutes, and about draining nodes for maintenance without killing 10-minute jobs."

The decision: **only HD jobs checkpoint**, at 25%, 50% and 75% of their steps. A checkpoint is the latent state plus step index and RNG state, about 125 MB. At about 1 GB/s that takes ~0.13 s against a 600-second job, and it caps the loss at 150 s instead of up to 600 s. A drain command asks the worker to checkpoint at the next step and release the lease, so host maintenance doesn't wait 10 minutes per node.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Checkpoint HD only, at 25/50/75% | Caps HD loss at 150 s; cheap drains | Two recovery paths to test |
| ❌ Checkpoint everything | One code path | 3× more checkpoint writes for jobs that lose at most 40–120 s |
| ❌ Never checkpoint, just retry | Simplest | HD users eat 10-minute restarts; draining waits for the slowest job |

**What I give up:** a checkpoint only resumes on the same model version, so a model rollout can't migrate in-flight jobs. The old version's pool stays alive until its jobs finish. And checkpoints aren't replicated across regions, so a region loss restarts its running jobs from scratch.

### Two Failure Modes That Look Like Success

- **Black-hole GPU.** A broken GPU that fails every job in two seconds frees up faster than any healthy one, so it pulls the most work and fails it all. Three failed attempts on one physical GPU within an hour gets it quarantined.
- **Poison prompt.** A prompt that crashes on every GPU would burn three attempts of GPU time. If the same error code shows up on two different GPUs, the job is marked failed and the credits are released.

---

## 🔧 Deep Dive 3: Traffic Bursts, Admission Control and ETA (7 minutes)

### The Decision

"Admission control follows a ladder: degrade free-tier quality first, then refuse free submissions whose predicted wait exceeds 20 minutes. Paid tiers are only ever refused for their own caps. Every accepted job gets an ETA band, not a single number."

### Why Not Just Queue Everything?

From the estimate, a 10-minute burst at 500 jobs/s leaves 225,000 jobs queued and 2.5 hours of draining. Accepting a job you'll start in two hours is a broken promise: users leave, resubmit, and add load. The queue has to be bounded by what the system can deliver within a wait users will accept.

### The Ladder

| Mode | Trigger (free predicted p50 wait) | Effect |
|------|-----------------------------------|--------|
| normal | under 10 min | All qualities admitted within caps |
| free draft-only | 10 min or more | Free jobs capped at draft quality, 40 GPU-s instead of 120 on average: 25 → 75 free jobs/s from the same 3,000 GPUs |
| refuse free | over 20 min | 503 high_demand with Retry-After and a "notify me" option |
| paid only | manual, or region loss | Free submissions refused; paid tiers keep their caps |

The 20-minute cap bounds the free queue at about 25 × 1,200 = 30,000 jobs, or 75 × 1,200 = 90,000 in draft-only mode.

> "Degrading before refusing is the important product call. A free user would rather get a 480p draft in five minutes than a refusal, and the draft costs a third of the GPU time. The pre-flight estimate endpoint shows the user which qualities are available before they hit submit, so the degrade isn't a surprise."

### Computing the ETA

The scheduler estimates a queued job's start time with a fluid fair-share approximation:

1. Count the GPU-seconds of the user's own earlier queued jobs.
2. Every other backlogged user in the same tier will receive, before this job starts, at most that much service plus this job's cost. Users with less queued work finish their share sooner, so take the minimum of each other user's queued GPU-seconds and that amount.
3. Sum the two, and divide by the GPUs the tier has recently been receiving (a moving average of its dispatches).
4. That's the p50. Multiply by the 90th percentile of observed realized-to-predicted ratios for that tier to get the p90.

Admission runs the same estimate as if the job were enqueued now.

> "Why a band instead of a position number? Under fair queueing, position isn't monotonic. A pro user who submits after you, or a free user with no backlog, legitimately enters ahead of a deep queue. Showing 'position 812' and then 'position 1,040' is a promise broken in front of the user. A band like 'starts in 4–9 minutes' that I calibrate against reality is honest, and I alert when the realized/predicted ratio drifts outside 0.5–2."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Degrade, then refuse, with calibrated ETA bands | Queue stays bounded by deliverable waits; users can plan | Some free users are turned away at peak |
| ❌ Unbounded queue | Never says no | 3-hour waits, abandonment, resubmission storms |
| ❌ Static per-tier rate limits | Easy | Refuses work at 3 a.m. when GPUs idle; doesn't track real capacity |

**What I give up:** the free experience at peak is visibly worse, and some users get turned away. The ETA model is also a moving part that can lie; I track its error as a first-class metric.

---

## 🛡️ Safety Pipeline (3 minutes)

1. **Prompt check, synchronous, before admission.** A text classifier (plus a check on any reference image) runs in the submit path with a p99 under 300 ms, so we never spend GPU-seconds on a prompt we'd refuse, and the user gets an immediate, editable error.
2. **Output check, before anyone can view the video.** The post-processor samples one frame per second for an output classifier. Pass: files are published under the serving prefix with a visible watermark and provenance metadata. Block: files go to a quarantine prefix for trust-and-safety review, and the job ends as blocked.
3. **Fail closed at both ends.** If the prompt classifier is down, submissions return 503. If the output classifier is down, finished jobs wait in postprocessing and are released when it recovers.

> "A rate limiter fails open, because briefly under-enforcing is cheaper than an outage. Safety is the opposite: releasing one harmful video is worse than an hour of delayed ones. So the classifiers get their own capacity headroom and circuit breakers, and their breaker opening means 'hold', not 'allow'."

---

## 📦 Output Storage and CDN (2 minutes)

- The GPU worker encodes a high-bitrate mezzanine file on the GPU's hardware encoder and uploads it, so the GPU is released immediately. Transcoding to delivery formats happens on a CPU pool.
- The post-processor writes an H.264 MP4 rendition, a poster frame, and a 2-second low-res looping preview for the gallery.
- Keys are immutable and per video, so the CDN can cache with a one-year max-age and never needs invalidation except on delete.
- Private videos use signed URLs that expire after an hour; the signature is excluded from the CDN cache key so private videos still cache at the edge.
- Retention: unsaved drafts expire after 30 days, which matters at 34.56 TB of new output a day.

---

## 📊 Observability (2 minutes)

| Metric | Why |
|--------|-----|
| Queue wait histogram per tier | The SLOs: pro p90 under 1 min, plus p90 under 5 min |
| Realized ÷ predicted wait | Calibrates the ETA band; alerts when it drifts |
| GPU slots by state (idle, busy, draining, quarantined) | Capacity at a glance |
| Lease-lost rate | Hardware failures or a partition |
| Jain's fairness index per tier | Are backlogged users actually getting equal shares? |
| Admission decisions by tier | How often we degrade or refuse |

> "The single most important alert is 'idle GPUs while the queue is non-empty for more than 60 seconds'. It means the scheduler is stuck or a fit rule excludes everything, and every second of it is money on fire."

---

## 📈 Scalability: What Breaks First (3 minutes)

1. **GPUs, always.** The levers, fastest first: admission modes, product defaults (draft first, upscale only the clips users keep), pricing HD at its real cost, and buying capacity.
2. **The scheduler leader at 10×.** 1,250 dispatches/s and 30,000 heartbeats/s across 150,000 GPUs is too much for one process. Split into more pools (region × GPU class × model version), keep one leader each, and add a global per-user running counter in Redis so caps hold across pools.
3. **PostgreSQL at 10×.** Around 10,000 writes/s during bursts. Shard by user_id so a user's jobs, credits and videos stay together; partition jobs by month for retention.
4. **SSE gateways and the CDN** scale horizontally. They're not design risks.

---

## ❓ Follow-up Questions

**"One GPU per task. What if a job needs eight?"**
That's gang scheduling. The naive approach starves big jobs: every time one GPU frees up, a one-GPU job grabs it, and an 8-GPU job never sees 8 free on one node. I'd add per-node reservations: once a big job is at the head, stop placing small jobs on its target node, and backfill only small jobs predicted to finish before the reservation completes.

**"A data center goes down."**
Three regions of 5,000 GPUs; losing one leaves 10,000. At average load, demand is pro 2,400 + plus 3,600 + free 6,000 = 12,000, which doesn't fit. Flipping free to draft-only cuts free to 50 jobs/s × 40 = 2,000 GPUs, for 8,000 total. That fits at 80% utilization. Job rows replicate asynchronously to a standby region; queued jobs are re-enqueued in surviving regions; running jobs restart from scratch, since I don't replicate checkpoints across regions. A client that never got its 202 resubmits with the same idempotency key.

**"10× more users?"**
That's 120,000 busy GPUs, which nobody can buy next quarter. Product levers first, then the scheduler and database splits from "what breaks first".

**"MVP in two weeks?"**
PostgreSQL as the queue, using row locks that skip locked rows, ordered by tier priority with a per-user running cap checked at claim time. Polling instead of SSE, no checkpoints (retry from scratch), synchronous keyword safety checks. The same job table and state machine, so the real scheduler slots in later.

**"How does the user know their job is still alive while queued for 15 minutes?"**
ETA updates over SSE every 30 seconds at most, and only when the band changes, plus a notification when it finishes so they can leave.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| ✅ Job API | 202 + job ID + SSE | ❌ Held connection or polling | Survives disconnects; ~8,000 events/s vs 100,000 polls/s |
| ✅ Fairness | Two-level WFQ on GPU-seconds | ❌ FIFO or strict priority | No monopoly, no starvation |
| ✅ Monopoly control | Per-user running and queued caps | ❌ Preempting running jobs | Jobs are non-preemptive; preemption wastes warm work |
| ✅ Scheduler | One leader per pool, workers pull | ❌ Sharded scheduler | 125 dispatches/s fits one process; fairness stays exact |
| ✅ Duplicate safety | Fencing epochs + per-attempt output keys | ❌ Trusting lease timeouts | A partitioned worker can't publish twice |
| ✅ Cancel | Cooperative at a step boundary | ❌ Kill the process | Keeps weights loaded; hard kill only as a backstop |
| ✅ Checkpoints | HD only, at 25/50/75% | ❌ Every job, or none | Failures cost 0.005% of fleet time; HD users and drains benefit |
| ✅ Bursts | Degrade free, then refuse, with ETA bands | ❌ Unbounded queue | A 3-hour backlog is a broken promise |
| ✅ Safety | Fail closed, prompt and output | ❌ Fail open | Releasing harmful content is worse than delay |

---

## 📝 Summary

> "To summarize: the model is a black box that holds one GPU for 40 seconds to 10 minutes, and the GPU fleet is sized for the daily average, so the design is about what happens when demand exceeds supply. Submission is asynchronous: an idempotent POST returns 202 once the job row commits, and the client follows every job over one SSE stream. A single scheduler leader per GPU pool runs two-level weighted fair queueing charged in GPU-seconds, with per-user running caps because minute-long jobs can't be taken back once dispatched. Cancellation is a conditional update for queued jobs and a cooperative step-boundary stop for running ones, which keeps the model loaded. Leases with fencing epochs make execution at-least-once but every effect exactly-once, and only HD jobs checkpoint, because the math says failures cost the fleet 0.005% but cost an unlucky HD user five minutes. Bursts hit an admission ladder that degrades free-tier quality before refusing it, and every queued job carries a calibrated ETA band rather than a position that can jump backwards. Prompts are checked before GPU time is spent and outputs before anyone sees them, both failing closed, and finished videos are served from immutable keys behind a CDN. If I had more time, I'd go deeper on gang scheduling for multi-GPU jobs and on making the cost model learn from actual runtimes."

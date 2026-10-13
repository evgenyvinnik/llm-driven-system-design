# Text-to-Video Generation - Architecture Design

## System Overview

A Sora-style service where a user types a prompt, picks a duration and resolution, and gets a video clip back minutes later. Every generation occupies exactly one GPU for 40 seconds to 10 minutes, and GPUs are the scarcest and most expensive resource in the system. The model is treated as a black box that turns `(prompt, params, seed)` into a clip over a fixed number of steps, reports progress after each step, and can save and restore its intermediate state. The design work is everything around it: an asynchronous job API with progress reporting, fair sharing of GPUs across users and paid tiers, cancellation of queued and running jobs, recovery when a GPU dies mid-job, admission control during traffic bursts, safety checks on prompts and outputs, and delivery of finished videos through a CDN.

**Learning goals:**
- Model minute-long work as a durable job with a state machine, not a held HTTP connection
- Apply weighted fair queueing to non-preemptive, variable-cost jobs (charge GPU-seconds, not job counts)
- Separate the liveness of a job (leases, heartbeats, fencing) from its durable state (PostgreSQL)
- Use checkpointing where it pays (long jobs, draining) and plain retry where it doesn't
- Size a GPU fleet with Little's law and reason about what queueing alone cannot absorb
- Treat admission control as a product decision: degrade quality before rejecting, and reject before promising a wait you can't meet

## Requirements

### Functional Requirements

1. **Submit a generation**: prompt (up to 2,000 characters), duration (5, 10 or 20 s), resolution (480p, 720p, 1080p), aspect ratio, optional seed, and 1–4 variations. Each variation is its own job on its own GPU.
2. **Asynchronous lifecycle**: the client gets a job ID immediately and then observes status, an ETA band while queued, step progress while running, and the video when done.
3. **Cancel** a queued job (removed from the queue) or a running job (GPU freed and returned to the pool).
4. **Fair sharing**: tiers (free, plus, pro) receive weighted shares of a saturated GPU pool; users within a tier share equally; per-user caps on running and queued jobs.
5. **Admission control**: predict wait at submission; degrade quality or refuse with a clear reason when the predicted wait exceeds the tier's limit.
6. **Recovery**: a job survives the loss of its GPU, resuming from a checkpoint when it has one.
7. **Safety**: check prompts before any GPU time is spent; check outputs before anyone (including the requester) can view them.
8. **Gallery**: list, play, download, delete and share finished videos.
9. **Notifications**: in-app events, browser push, optional email, and webhooks for API customers.
10. **Admin**: queue depth and wait by tier, tier policies (weights, caps), admission mode, GPU pool status, node drain and quarantine.

### Non-Functional Requirements

| Property | Target |
|----------|--------|
| Submission acknowledgement | p99 < 500 ms, including the prompt safety check |
| Durability | No accepted job is lost: `202 Accepted` only after the job row commits |
| Queue wait (time to start) | pro p90 < 1 min; plus p90 < 5 min; free best effort, never admitted with a predicted wait above 20 min |
| Progress freshness | Worker progress visible in the client within 3 s (p95) |
| Cancellation | Queued: immediate. Running: GPU freed within one step (p99 < 15 s), hard kill at 30 s |
| Failure recovery | Lost GPU detected within 30 s; a 1080p job loses at most 25% of its work |
| GPU utilization | ≥ 75% averaged over a day |
| Availability | Submission API 99.9%; playback 99.95% (served by the CDN) |
| Fairness | Among backlogged users in a tier, Jain's index of GPU-seconds received ≥ 0.9 over 10-minute windows |

### Out of Scope

- Model training, model architecture and GPU kernels
- Jobs that need several GPUs at once (gang scheduling is discussed as an extension)
- Editing features (remix, extend, storyboard), audio generation
- Payment processing: credits are assumed to be purchased elsewhere

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| Daily active creators | ~2M | Assumption |
| Jobs per day | 8.64M | ~4.3 generations per creator |
| Average submission rate | 100 jobs/s | 8.64M / 86,400 s |
| Evening peak | 200 jobs/s | 2× average, lasting about an hour |
| Burst (launch, viral trend) | 500 jobs/s | 5× average, lasting about 10 minutes |
| GPU time per job | 120 GPU-s mean | 60% draft (5 s, 480p) at 40 GPU-s; 30% standard (10 s, 720p) at 120 GPU-s; 10% HD (20 s, 1080p) at 600 GPU-s → 24 + 36 + 60 = 120 |
| Busy GPUs at average load | 12,000 | Little's law: 100 jobs/s × 120 s |
| Fleet size | 15,000 GPUs | 12,000 / 0.8, for 80% average utilization; 3 regions × 5,000 |
| Fleet throughput | 125 jobs/s | 15,000 / 120 |
| Fleet cost | $30,000/hour, $720K/day | Assume $2 per GPU-hour |
| Cost per job | ≈ $0.083 | 120 GPU-s = 1/30 GPU-hour × $2 = $0.067, divided by 0.8 utilization |

The same job mix is assumed across tiers. By GPU demand, free is 50%, plus 30% and pro 20%.

### What Queueing Cannot Absorb

The fleet is sized for the daily average, not the peak, because provisioning for peak would roughly double cost for capacity that idles overnight. The consequences have to be designed for:

- **Evening peak.** 200 jobs/s × 120 s = 24,000 GPUs of demand against 15,000. Arrivals exceed throughput by 200 − 125 = 75 jobs/s, so the backlog grows by 75 × 3,600 = **270,000 jobs per peak hour**. At average load there is only 125 − 100 = 25 jobs/s of headroom, so draining that backlog takes 270,000 / 25 = 10,800 s = **3 hours**.
- **Burst.** 500 jobs/s for 600 s brings 300,000 jobs; the fleet serves 125 × 600 = 75,000 of them, leaving **225,000 queued**, which takes 225,000 / 25 = 9,000 s = 2.5 hours to drain.
- **Who absorbs it.** With tier weights pro 6 : plus 3 : free 1, the paid tiers' peak demand (pro 4,800 GPUs, plus 7,200 GPUs) fits inside the pool, so they are served in full and free receives the remaining 15,000 − 12,000 = 3,000 GPUs: **25 free jobs/s against 100 arriving**.
- **Degrading before rejecting.** Restricting free jobs to draft quality during the peak (40 GPU-s instead of 120) turns the same 3,000 GPUs into **75 free jobs/s**.
- **Admission cap.** Free submissions are refused once the predicted wait exceeds 20 minutes, which bounds the free queue at about 25 × 1,200 = 30,000 jobs (or 75 × 1,200 = 90,000 in draft-only mode).

### Storage and Bandwidth

| Data | Estimate | Notes |
|------|----------|-------|
| Output per job | 4 MB mean | Draft 480p at ~1 Mbps × 5 s = 0.625 MB; standard 720p at ~4 Mbps × 10 s = 5 MB; HD 1080p at ~8 Mbps × 20 s = 20 MB; mix-weighted 3.875 MB plus ~0.125 MB poster and preview |
| New output storage | 34.56 TB/day, ~12.6 PB/year | 8.64M × 4 MB; before retention (unsaved drafts expire after 30 days) |
| Playback egress | 103.68 TB/day ≈ 1.2 GB/s ≈ 9.6 Gbps average | Assume 3 plays per video; served by the CDN |
| HD checkpoint | ~125 MB | Latent state + step index + RNG state; one kept per job |
| Checkpoint writes | 3.75 GB/s fleet-wide (~1.25 GB/s per region) | 10 HD jobs/s × 3 checkpoints × 125 MB |
| Live checkpoint storage | ~750 GB | 6,000 HD jobs running at average load × 125 MB |
| Job rows | ~1 KB each, ~8.6 GB/day | Prompt + params; 30 days hot ≈ 260 GB |

### Control Plane Rates

| Path | Rate | Notes |
|------|------|-------|
| Submissions | 100/s average, 500/s burst | Each runs the prompt classifier (p99 < 300 ms) |
| PostgreSQL writes | ~500/s average, ~1,000/s during a burst | ~5 state transitions per job |
| Lease heartbeats | 2,400/s average, 3,000/s with the fleet full | One per running job every 5 s, to the scheduler (memory only) |
| Progress updates | 6,000/s average, 7,500/s with the fleet full | One per running job every 2 s, to Redis |
| SSE connections | 200,000 at peak | 10% of DAU online; ~50,000 per gateway node → 4 minimum, 8 deployed |
| Polling alternative | 100,000 req/s | 200,000 clients polling every 2 s, almost all answering "no change" |

### GPU Failure Math

Assume one job-killing fault per GPU every 1,000 GPU-hours (driver errors, ECC faults, host and NIC failures). At 12,000 busy GPUs that is **12 failures per hour, 288 per day**.

A fault lands on a random busy GPU-second, so it is length-biased: HD jobs hold 50% of busy time (60 of 120), standard 30% and draft 20%. The expected work lost per failure without checkpoints is 0.5 × 300 + 0.3 × 60 + 0.2 × 20 = **172 GPU-s**. Per day that is 288 × 172 = 49,536 GPU-s ≈ 13.8 GPU-hours out of 288,000 busy GPU-hours, about **0.005%**.

So checkpointing is not about fleet efficiency. It is about the ~144 HD users per day (half of the 288 failures) who would otherwise lose an average of 5 minutes, and about draining nodes for maintenance without killing 10-minute jobs.

### Local Development Scale

| Component | Local sizing |
|-----------|--------------|
| Simulated GPUs | 2 worker processes × 4 GPU slots = 8 slots |
| Simulated runtimes | `SIM_TIME_SCALE=0.2`: draft 8 s, standard 24 s, HD 120 s |
| Users | 6 seeded users, two per tier |
| Load generator | Bursts of 200 jobs across users to show queue growth, fairness and admission |
| Data | Tens of MB of placeholder clips in MinIO |

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Clients: web app · mobile app · API customers (webhooks)                       │
└──────────────┬──────────────────────────────────────────────────▲──────────────┘
               │ REST: submit · estimate · cancel · list           │ MP4 · poster · preview
               │ SSE: one stream of job events per tab             │
               ▼                                                   │
┌──────────────────────────────┐                     ┌─────────────┴──────────────┐
│ API Gateway                  │                     │ CDN                        │
│ TLS · auth · per-user rate   │                     │ signed URLs · immutable    │
│ limits · routing             │                     │ keys · origin shield       │
└───────┬───────────────┬──────┘                     └─────────────▲──────────────┘
        │               │                                          │ origin pull
        ▼               ▼                                          │
┌───────────────┐ ┌──────────────┐                   ┌─────────────┴──────────────┐
│ Job API       │ │ SSE Gateway  │                   │ Object Storage             │
│ admission ·   │ │ per-user     │                   │ serving · quarantine ·     │
│ idempotency · │ │ fan-out      │                   │ mezzanine · checkpoints    │
│ cancel · list │ └──────▲───────┘                   └──────▲──────────────▲──────┘
└─┬─────┬─────┬─┘        │ subscribe                        │ upload       │ publish
  │     │     │   ┌──────┴────────┐                         │              │
  │     │     │   │ Redis         │◀── progress ──────┐     │              │
  │     │     │   │ progress ·    │                   │     │              │
  │     │     │   │ pub/sub       │                   │     │              │
  │     │     │   └───────────────┘                ┌──┴─────┴──────────┐   │
  │     │     ▼                                    │ GPU Workers       │   │
  │     │  ┌────────────────┐                      │ one job per GPU   │   │
  │     │  │ Prompt Safety  │                      │ steps · checkpoint│   │
  │     │  │ classifier     │                      │ mezzanine encode  │   │
  │     │  └────────────────┘                      └────────▲──────────┘   │
  │     ▼                                                   │              │
  │  ┌──────────────────────┐   leases · heartbeats ·       │              │
  │  │ Scheduler            │◀── cancel and drain ──────────┘              │
  │  │ leader per GPU pool  │                                              │
  │  │ fair queue · caps ·  │                                              │
  │  │ ETA model            │                                              │
  │  └──────────┬───────────┘                                              │
  ▼             ▼                                                          │
┌──────────────────────────┐    ┌─────────────────┐    ┌───────────────────┴──┐
│ PostgreSQL               │───▶│ Kafka           │───▶│ Post-processor       │
│ jobs · attempts · videos │    │ job-events      │    │ transcode · output   │
│ credits · outbox         │    │ (from outbox)   │    │ safety · watermark   │
└──────────────────────────┘    └────────┬────────┘    └──────────────────────┘
                                         ▼
                                ┌─────────────────┐
                                │ Notifier ·      │
                                │ billing settle  │
                                └─────────────────┘
```

The control plane (Job API, scheduler, PostgreSQL) decides *what* runs *where*. The data plane (GPU workers, object storage, CDN) moves the bytes. Progress travels a separate, lossy, low-latency path (Redis pub/sub to the SSE gateway) because a dropped progress tick is harmless, while state transitions travel the durable path (PostgreSQL, then the outbox to Kafka) because a dropped "succeeded" is not.

Each region runs a full cell of this diagram. Users are homed to a region; the CDN and the global user directory sit in front.

## Core Components / Request Flows

### Components

| Component | Responsibility | Scaling |
|-----------|----------------|---------|
| API Gateway | TLS, session or API-key auth, per-user request rate limits | Stateless, horizontal |
| Job API | Validation, cost estimate, prompt safety call, admission, idempotent job creation, cancel, listing | Stateless, horizontal |
| Prompt Safety | Text (and reference image) classifier; returns allow / block with categories | Small GPU or CPU pool, horizontal |
| Scheduler | Per-pool leader: fair queue, per-user caps, leases, heartbeats, cancel and drain push, ETA model | One active leader per pool, hot standby |
| GPU Worker | One process per GPU: holds the model warm, runs one job at a time, reports progress, checkpoints, encodes a mezzanine file | One per GPU |
| Post-processor | Transcodes delivery renditions, samples frames for the output classifier, adds watermark and provenance, publishes | CPU pool, horizontal, consumes Kafka |
| SSE Gateway | Holds client streams, subscribes to `user:{id}` channels, sends a snapshot on connect | Horizontal, ~50,000 connections per node |
| Notifier | Web Push, email, webhooks when a job reaches a terminal state | Consumes Kafka |
| PostgreSQL | Durable job state, attempts, videos, credit ledger, outbox | Primary + replicas; shard by user later |
| Redis | Latest progress per job, pub/sub fan-out, sessions, submission rate limits | Primary + replica |
| Object Storage | Checkpoints, mezzanine files, quarantine, serving renditions | Managed, regional |

### Job State Machine

```
                 dispatch (lease epoch +1)       first heartbeat
  ┌────────┐ ─────────────────────────▶ ┌────────────┐ ──────────▶ ┌─────────┐
  │ queued │                            │ dispatched │             │ running │
  └───┬────┘ ◀──── lease lost, attempt < max_attempts ──────────── └──┬───┬──┘
      │                                                               │   │
      │ cancel (conditional update)              cancel acknowledged  │   │ final step
      ▼                                         or hard kill          │   │ + mezzanine uploaded
┌───────────┐ ◀───────────────────────────────────────────────────────┘   ▼
│ cancelled │                                                ┌────────────────┐
└───────────┘    ┌────────┐   attempts exhausted /           │ postprocessing │
                 │ failed │◀─ same error on two GPUs ─────── │ transcode +    │
                 └────────┘                                  │ output safety  │
                                                             └───┬────────┬───┘
                                                       passed    │        │ blocked
                                                                 ▼        ▼
                                                        ┌───────────┐ ┌─────────┐
                                                        │ succeeded │ │ blocked │
                                                        └───────────┘ └─────────┘
```

A prompt that fails the safety check never becomes a job: the submission returns `400` and only a `safety_events` row is written.

### Flow 1: Submission

1. Client sends `POST /api/v1/generations` with an `Idempotency-Key` header and the prompt and parameters.
2. Job API validates parameters against the user's tier policy (resolution, duration, variations).
3. Prompt Safety classifies the prompt (p99 < 300 ms). Block → `400 prompt_rejected` with categories. The classifier is behind a circuit breaker; if it is open, the API returns `503` (fail closed).
4. Cost model estimates GPU-seconds from resolution, duration and step count.
5. Admission controller asks the scheduler for a predicted start time for this tier and user; it may accept, offer draft quality, or refuse (`429 user_queue_full`, `503 high_demand` with `Retry-After`).
6. One transaction: insert one job row per variation, reserve credits in the ledger, write `job.queued` outbox rows. A unique `(user_id, idempotency_key)` makes a retried request return the original jobs.
7. Job API notifies the scheduler (enqueue RPC; the scheduler also reconciles from PostgreSQL every few seconds, so a lost RPC delays the job but never loses it).
8. Response `202 Accepted` with job IDs and an ETA band.

### Flow 2: Dispatch and Execution

1. An idle worker long-polls `POST /internal/v1/leases` with its GPU class and loaded model version.
2. Scheduler picks the next job by fair order (Key Design Decision 2), skipping users at their running cap and jobs that need a different GPU class or model.
3. Scheduler performs the conditional transition `queued → dispatched`, increments `lease_epoch`, and returns the job with the epoch. Zero rows updated means the job was cancelled a moment earlier; the scheduler drops it and picks again.
4. Worker loads the checkpoint if `checkpoint_step` is set, otherwise starts at step 0, and heartbeats every 5 s with `(job_id, epoch)`.
5. Every 2 s the worker writes progress to Redis and publishes on `user:{id}`.
6. HD jobs checkpoint at 25%, 50% and 75% of steps.
7. After the last step, the worker encodes a high-bitrate mezzanine file on the GPU's hardware encoder, uploads it, and calls `complete` with its epoch. The GPU is released immediately; transcoding happens elsewhere.

### Flow 3: Progress to the Client

1. The client opens one SSE stream per tab: `GET /api/v1/events`.
2. The gateway subscribes to `user:{id}`, then sends a snapshot of every active job (from Redis progress hashes plus PostgreSQL status) with per-job `version` numbers.
3. Live events follow. The client applies an event only if its version is newer than what it holds, so the snapshot and live events can overlap safely.
4. Queued jobs receive ETA updates at most every 30 s, and only when the band changes.
5. Comment heartbeats every 15 s keep proxies from closing idle streams.

### Flow 4: Cancellation

1. `POST /api/v1/generations/:id/cancel`.
2. Queued: a conditional update `status = 'queued' → 'cancelled'` is the entire cancel. Credits are released and the scheduler drops the job lazily when it next sees it.
3. Running or dispatched: set `cancel_requested`, then the scheduler pushes a cancel on `worker:{id}:control`. The heartbeat response also carries the flag, as a backstop if the push is lost.
4. The worker stops at the next step boundary, frees GPU memory, keeps the model loaded, and acknowledges. The scheduler records the attempt as `cancelled` and the GPU long-polls for its next job.
5. If no acknowledgement arrives within 30 s, the node agent kills the process and runs a GPU health check before returning the slot to the pool.
6. If the job completes before the cancel lands, completion wins and the user gets the video. The client shows "finished before cancel".

### Flow 5: GPU Failure

1. Heartbeats stop. After 30 s without one, the scheduler declares the lease lost.
2. Conditional update `running → queued` where `lease_epoch` still matches, `attempt + 1`. The job keeps its place at the head of its user's queue.
3. If the checkpoint exists, the next attempt resumes from it on any GPU with the same class and model version.
4. Any late write from the old worker carries a stale epoch and is rejected (fencing).
5. A GPU that fails three jobs within an hour is quarantined so it cannot pull and fail more.

### Flow 6: Output to Playback

1. The `job.rendered` event triggers the post-processor: it reads the mezzanine file and produces an H.264 MP4 rendition, a poster frame, and a 2-second low-resolution looping preview for the gallery.
2. Sampled frames (1 per second) go to the output classifier. Pass → files are written under `videos/{video_id}/` with a visible watermark and provenance metadata. Block → files go to `quarantine/` for trust-and-safety review and the job ends as `blocked`.
3. The job transitions to `succeeded`, credits are captured at actual GPU-seconds, and the outbox emits `job.succeeded`.
4. The SSE gateway pushes the event with the poster URL; the Notifier sends Web Push or email if the user has no live stream.
5. Playback goes through the CDN using signed URLs for private videos and plain immutable URLs for public ones.

## Database Schema

### PostgreSQL

```sql
-- Knobs read by the scheduler and the admission controller.
CREATE TABLE tier_policies (
  tier              TEXT PRIMARY KEY CHECK (tier IN ('free', 'plus', 'pro')),
  weight            INT  NOT NULL CHECK (weight > 0),        -- share of a saturated pool
  max_running       INT  NOT NULL CHECK (max_running > 0),   -- GPUs one user may hold at once
  max_queued        INT  NOT NULL CHECK (max_queued >= 0),   -- jobs one user may have waiting
  max_resolution    TEXT NOT NULL CHECK (max_resolution IN ('480p', '720p', '1080p')),
  max_duration_s    INT  NOT NULL CHECK (max_duration_s IN (5, 10, 20)),
  max_wait_admit_s  INT,                                     -- NULL: admit whenever caps allow
  daily_gpu_seconds INT                                      -- NULL: metered by credits only
);

INSERT INTO tier_policies VALUES
  ('free', 1, 1,  2, '1080p', 20, 1200, 1200),
  ('plus', 3, 2, 10, '1080p', 20, NULL, NULL),
  ('pro',  6, 5, 50, '1080p', 20, NULL, NULL);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  tier          TEXT NOT NULL REFERENCES tier_policies(tier),
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credits are denominated in GPU-seconds so cost and scheduling share one unit.
CREATE TABLE credit_accounts (
  user_id   UUID PRIMARY KEY REFERENCES users(id),
  balance   BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved  BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (reserved <= balance)
);

CREATE TABLE generation_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  batch_id         UUID NOT NULL,                     -- variations submitted together
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,                     -- detects key reuse with a different body
  tier             TEXT NOT NULL,                     -- snapshotted at submission
  prompt           TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2000),
  params           JSONB NOT NULL,                    -- duration_s, resolution, aspect, seed, variation_index
  model_version    TEXT NOT NULL,
  pool             TEXT NOT NULL,                     -- region x GPU class
  est_gpu_seconds  INT  NOT NULL CHECK (est_gpu_seconds > 0),
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                     'queued', 'dispatched', 'running', 'postprocessing',
                     'succeeded', 'failed', 'cancelled', 'blocked')),
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  attempt          INT  NOT NULL DEFAULT 0,
  max_attempts     INT  NOT NULL DEFAULT 3,
  lease_epoch      BIGINT NOT NULL DEFAULT 0,         -- fencing token, +1 on every dispatch
  worker_id        TEXT,
  total_steps      INT  NOT NULL CHECK (total_steps > 0),
  checkpoint_step  INT,
  checkpoint_key   TEXT,
  gpu_seconds_used INT  NOT NULL DEFAULT 0,
  error_code       TEXT,
  version          INT  NOT NULL DEFAULT 0,           -- bumps on every change; clients order events by it
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at    TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key),
  CHECK (checkpoint_step IS NULL OR checkpoint_step < total_steps)
);

-- Scheduler rebuild after failover: all queued jobs of a pool in arrival order.
CREATE INDEX idx_jobs_queued ON generation_jobs (pool, created_at) WHERE status = 'queued';
-- Job history and the "active jobs" panel.
CREATE INDEX idx_jobs_user_recent ON generation_jobs (user_id, created_at DESC);
CREATE INDEX idx_jobs_user_active ON generation_jobs (user_id)
  WHERE status IN ('queued', 'dispatched', 'running', 'postprocessing');
-- One GPU, one task: the database refuses a second in-flight job on the same worker.
CREATE UNIQUE INDEX uq_jobs_one_per_worker ON generation_jobs (worker_id)
  WHERE status IN ('dispatched', 'running');

CREATE TABLE job_attempts (
  job_id            UUID NOT NULL REFERENCES generation_jobs(id),
  attempt           INT  NOT NULL,
  lease_epoch       BIGINT NOT NULL,
  worker_id         TEXT NOT NULL,
  gpu_uuid          TEXT NOT NULL,
  resumed_from_step INT  NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  outcome           TEXT CHECK (outcome IN ('succeeded', 'failed', 'lease_lost', 'cancelled', 'drained')),
  error_code        TEXT,
  PRIMARY KEY (job_id, attempt)
);
-- Black-hole detection: recent failures per physical GPU.
CREATE INDEX idx_attempts_gpu_recent ON job_attempts (gpu_uuid, started_at DESC);

CREATE TABLE videos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL UNIQUE REFERENCES generation_jobs(id),
  user_id        UUID NOT NULL REFERENCES users(id),
  duration_s     NUMERIC(5, 2) NOT NULL,
  width          INT NOT NULL,
  height         INT NOT NULL,
  storage_prefix TEXT NOT NULL,                       -- videos/{id}/ or quarantine/{id}/
  renditions     JSONB NOT NULL,                      -- [{ "name": "720p.mp4", "bytes": 5100000, "codec": "h264" }]
  poster_key     TEXT NOT NULL,
  preview_key    TEXT NOT NULL,
  safety_status  TEXT NOT NULL CHECK (safety_status IN ('pending', 'passed', 'blocked', 'under_review')),
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
  provenance_id  TEXT,                                -- content-credential manifest
  favorited      BOOLEAN NOT NULL DEFAULT false,
  expires_at     TIMESTAMPTZ,                         -- unsaved drafts expire after 30 days
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_videos_gallery ON videos (user_id, created_at DESC)
  WHERE deleted_at IS NULL AND safety_status = 'passed';
CREATE INDEX idx_videos_expiry ON videos (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- Append-only; balance and reserved on credit_accounts are maintained in the same transaction.
CREATE TABLE credit_ledger (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  job_id      UUID REFERENCES generation_jobs(id),
  entry_type  TEXT NOT NULL CHECK (entry_type IN ('grant', 'reserve', 'capture', 'release')),
  gpu_seconds BIGINT NOT NULL CHECK (gpu_seconds >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, entry_type)                         -- a job reserves, captures and releases at most once
);
CREATE INDEX idx_ledger_user ON credit_ledger (user_id, created_at DESC);

CREATE TABLE safety_events (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users(id),
  job_id             UUID REFERENCES generation_jobs(id),
  stage              TEXT NOT NULL CHECK (stage IN ('prompt', 'output')),
  verdict            TEXT NOT NULL CHECK (verdict IN ('allow', 'block', 'review')),
  categories         TEXT[] NOT NULL DEFAULT '{}',
  prompt_hash        TEXT,
  classifier_version TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_safety_user ON safety_events (user_id, created_at DESC);

-- Registry only; liveness (heartbeats) lives in scheduler memory.
CREATE TABLE gpu_workers (
  id             TEXT PRIMARY KEY,                    -- node-id:gpu-index
  pool           TEXT NOT NULL,
  gpu_class      TEXT NOT NULL,
  model_version  TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('idle', 'busy', 'draining', 'quarantined', 'offline')),
  quarantined_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_workers_pool_state ON gpu_workers (pool, state);

-- Transactional outbox: every state transition writes its event in the same transaction.
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

At production scale `generation_jobs` is partitioned by month of `created_at` (the idempotency constraint then moves to a small `idempotency_keys` table with a 24-hour TTL), and the whole schema shards by `user_id` once write volume requires it.

### Redis Keys

| Key | Type | TTL | Purpose |
|-----|------|-----|---------|
| `job:{id}:progress` | Hash `{step, total, epoch, updated_at}` | 1 h | Latest progress; read by the SSE snapshot |
| `user:{id}:events` | Pub/sub channel | — | Live job events for that user's streams |
| `worker:{id}:control` | Pub/sub channel | — | Cancel and drain commands |
| `ratelimit:submit:{userId}` | Sorted set | 60 s | Sliding-window submission rate limit |
| `session:{sid}` | String | 7 days | Session store |

### Object Storage Layout

```
checkpoints/{job_id}/latest.bin              private · overwritten per checkpoint · lifecycle delete after 2 days
mezzanine/{job_id}/attempt-{n}.mp4           private · attempt number keeps zombie uploads apart · delete after 7 days
quarantine/{video_id}/...                    trust-and-safety access only · 90 days
videos/{video_id}/720p.mp4 | poster.jpg | preview.mp4   serving prefix · CDN origin · immutable
```

## API Design

### Public Endpoints

```
POST   /api/v1/generations                 → create 1–4 jobs (Idempotency-Key required) → 202
POST   /api/v1/generations/estimate        → cost, predicted wait band, admission decision (no side effects)
GET    /api/v1/generations?state=active    → caller's jobs, cursor-paginated
GET    /api/v1/generations/:id             → job snapshot (status, progress, ETA, video id)
POST   /api/v1/generations/:id/cancel      → cancel queued (200) or request cancel of running (202)
POST   /api/v1/generations/:id/retry       → new job with the same params after failed or cancelled
GET    /api/v1/events                      → SSE stream of the caller's job events
GET    /api/v1/videos?cursor=              → gallery, newest first
GET    /api/v1/videos/:id                  → metadata + signed playback, poster and preview URLs
PATCH  /api/v1/videos/:id                  → visibility, favorite
DELETE /api/v1/videos/:id                  → soft delete; purge objects and CDN after 10 s undo window
```

### Internal Endpoints (worker ↔ scheduler, mTLS)

```
POST   /internal/v1/leases                       → long-poll up to 20 s for an assignment
POST   /internal/v1/leases/:jobId/heartbeat      → renew lease; response carries cancel / drain
POST   /internal/v1/leases/:jobId/checkpoint     → record checkpoint step + key (epoch checked)
POST   /internal/v1/leases/:jobId/complete       → mezzanine key + GPU-seconds (epoch checked)
POST   /internal/v1/leases/:jobId/fail           → error code; scheduler decides retry
```

### Admin Endpoints

```
GET    /api/v1/admin/queues                → depth, dispatch rate, wait percentiles per tier and pool
PUT    /api/v1/admin/tiers/:tier           → weight, caps, admission threshold
PUT    /api/v1/admin/admission             → mode: normal | free_draft_only | paid_only
GET    /api/v1/admin/workers               → GPU slots by state; recent failures
POST   /api/v1/admin/workers/:id/drain     → checkpoint-and-release, then stop pulling
```

### Submission Example

```http
POST /api/v1/generations
Idempotency-Key: 3f6a1c2e-6a8e-4c0b-9d1e-2b7f5f9e0a11

{ "prompt": "A paper boat drifting down a rainy city gutter, macro lens",
  "duration_s": 10, "resolution": "720p", "aspect_ratio": "16:9", "variations": 2 }
```

```json
{
  "batch_id": "b7c1…",
  "jobs": [
    { "id": "j-01…", "status": "queued", "est_gpu_seconds": 120,
      "eta": { "start_p50_s": 40, "start_p90_s": 95 } },
    { "id": "j-02…", "status": "queued", "est_gpu_seconds": 120,
      "eta": { "start_p50_s": 55, "start_p90_s": 120 } }
  ]
}
```

| Status | Body `error` | Meaning |
|--------|--------------|---------|
| 400 | `prompt_rejected` + categories | Safety block; the prompt stays in the composer for editing |
| 402 | `insufficient_credits` | Reservation failed |
| 409 | `idempotency_conflict` | Same key, different body |
| 429 | `user_queue_full` | Per-user queued cap reached |
| 503 | `high_demand` + `Retry-After` + `alternatives` | Predicted wait above the tier limit; may offer draft quality |

### SSE Event Format

```
id: 18412
event: job.updated
data: {"job_id":"j-01…","version":7,"status":"running","step":18,"total_steps":50,
       "attempt":1,"eta":{"finish_p50_s":70}}

event: job.succeeded
data: {"job_id":"j-01…","version":9,"video_id":"v-9…","poster_url":"https://cdn…/poster.jpg?sig=…"}
```

## Key Design Decisions

### 1. Asynchronous Job API with SSE, Not a Held Connection

A job runs for 40 seconds to 10 minutes after a queue wait that can reach 20 minutes. Holding an HTTP request open that long breaks on every load balancer idle timeout, mobile network change and deploy, and it couples a client's connection to a GPU's lifetime. Instead, `POST` returns `202` with a job ID once the row commits, and the client follows the job through one SSE stream per tab carrying events for all of the user's jobs.

SSE beats polling at this scale: 200,000 online clients polling every 2 s is 100,000 requests/s, nearly all answering "no change", while the actual event rate is ~8,000/s. It also beats WebSocket for this shape of traffic: every client-to-server action (submit, cancel) is a normal REST call that benefits from idempotency keys and standard auth, and SSE gives automatic reconnect with `Last-Event-ID`. The cost is a stateful gateway tier with connection-count limits, and a snapshot-on-connect protocol so that reconnects never miss a terminal event.

### 2. Two-Level Weighted Fair Queueing on GPU-Seconds, Plus Per-User Caps

The scheduler uses stride scheduling, a deterministic form of weighted fair queueing, at two levels: tiers share a saturated pool by weight (pro 6, plus 3, free 1), and users inside a tier share equally. Costs are charged in estimated GPU-seconds, so one HD job (600) counts as fifteen drafts (40). Charging by job count would let a user who only submits HD jobs take 15× the GPU time of a user submitting drafts at the same rate.

```typescript
// "pass" = virtual GPU-seconds consumed / weight. The lowest pass is served next.
interface Flow { userId: string; pass: number; running: number; queue: Job[] }
interface TierQueue { tier: Tier; weight: number; pass: number; flows: FlowHeap }

function pickJob(worker: WorkerInfo): Job | null {
  for (const tq of tiersByAscendingPass()) {            // only tiers with queued work
    for (const flow of tq.flows.eligibleByPass()) {      // users below their running cap
      const job = flow.queue.find((j) => fits(j, worker)); // GPU class + loaded model version
      if (!job) continue;
      tq.pass += job.estGpuSeconds / tq.weight;          // tier-level weighted share
      flow.pass += job.estGpuSeconds;                    // equal shares inside the tier
      flow.running += 1;
      return job;
    }
  }
  return null;                                           // the worker long-polls again
}

function onBecameBacklogged(tq: TierQueue, flow: Flow): void {
  // Idle time is not saved up: a returning tier or user starts at the current minimum.
  tq.pass = Math.max(tq.pass, minPassAmongBackloggedTiers());
  flow.pass = Math.max(flow.pass, tq.flows.minPass());
}

function onFinished(job: Job, actualGpuSeconds: number): void {
  // Settle the estimate so a user whose jobs run long pays for the real time.
  const delta = actualGpuSeconds - job.estGpuSeconds;
  tierQueueOf(job).pass += delta / tierQueueOf(job).weight;
  flowOf(job).pass += delta;
  flowOf(job).running -= 1;
}
```

Fair queueing alone is not enough because the jobs are non-preemptive and long. When the pool is idle at 4 a.m., a work-conserving scheduler happily gives one user 500 GPUs; a user arriving a minute later then waits for those jobs to finish. **Per-user running caps** (free 1, plus 2, pro 5) bound how much capacity any one user can lock up for minutes at a time, and **queued caps** (2, 10, 50) bound how much backlog one user can create. The scheduler is work-conserving across tiers (an idle tier's share goes to the others) but never beyond a user's cap.

Strict priority was rejected because it starves free users completely whenever paid demand exceeds capacity. FIFO was rejected because one user's batch of 50 jobs delays everyone behind it.

### 3. Single-Leader Scheduler per Pool, Workers Pull Leases

At 125 dispatches/s and 3,000 heartbeats/s with the fleet full, one process per pool handles scheduling easily, and fairness is a global property that sharding would make approximate. The leader keeps queues, passes and lease timers in memory; PostgreSQL holds durable state. A hot standby takes over through a lease in the coordination store (etcd in production, a PostgreSQL advisory lock locally), rebuilds queues from `idx_jobs_queued` in seconds, and gives running jobs a 60 s grace period to re-heartbeat before declaring any lease lost. Losing the in-memory pass values costs a few seconds of imperfect fairness, never a job.

Workers pull: an idle GPU long-polls for work, so the scheduler never has to model which GPUs are free, and a dead worker simply stops asking. Push would save the long-poll round trip (milliseconds against a 40-second minimum job) at the cost of the scheduler tracking worker capacity.

### 4. Cooperative Cancellation at Step Boundaries, Hard Kill as Backstop

A running job checks a cancel flag between steps. HD steps take about 12 s (600 GPU-s over 50 steps), so cancellation frees the GPU within one step while keeping the model weights loaded. Killing the process instead would free the GPU in 1–2 s but force a reload of tens of GB of weights, costing more GPU time than it saves. The hard kill after 30 s exists for workers that are hung, not slow.

### 5. Checkpoint Only Long Jobs

From the failure math, fleet-wide work lost to failures is about 0.005% without any checkpoints. Checkpointing every job would add plumbing and 3× more checkpoint writes for nothing. HD jobs (estimated runtime above 300 s) checkpoint at 25%, 50% and 75% of their steps: writing ~125 MB at ~1 GB/s takes ~0.13 s per checkpoint against a 600 s job, and it caps a failed HD job's loss at 150 s instead of up to 600 s. Checkpoints also make node draining cheap: a drain command asks the worker to checkpoint at the next step and release the lease, so host maintenance doesn't wait 10 minutes per node. A checkpoint can only resume on the same model version, so model rollouts keep the old version's pool alive until its jobs finish rather than migrating them.

### 6. Admission Control: Degrade, Then Refuse, Never Over-Promise

Every submission gets a predicted start time from the scheduler's ETA model:

```typescript
// Fluid fair-share estimate of seconds until a queued job starts.
function estimateStart(job: Job): { p50: number; p90: number } {
  const tq = tierQueueOf(job);
  const ownAhead = gpuSecondsQueuedBefore(job);          // the user's own earlier jobs
  // Under equal sharing, before this job is dispatched every other backlogged user in the
  // tier receives at most as much service as this user still needs ahead of it.
  let ahead = ownAhead;
  for (const other of tq.backloggedFlows()) {
    if (other.userId !== job.userId) ahead += Math.min(other.queuedGpuSeconds, ownAhead + job.estGpuSeconds);
  }
  const gpus = tq.recentGpuAllocation();                 // EWMA of GPUs serving this tier
  const p50 = ahead / gpus;
  return { p50, p90: p50 * observedErrorRatioP90(tq) };  // calibrated from realized waits
}
```

The admission ladder, triggered by the free tier's predicted p50 wait:

| Mode | Trigger | Effect |
|------|---------|--------|
| `normal` | Free predicted wait < 10 min | All qualities admitted within caps |
| `free_draft_only` | Free predicted wait ≥ 10 min | Free jobs limited to draft (40 GPU-s); free throughput 25 → 75 jobs/s |
| refuse free | Free predicted wait > 20 min | `503 high_demand` with `Retry-After` and a "notify me when capacity returns" option |
| `paid_only` | Manual, or region loss | Free submissions refused; paid tiers keep their caps |

Paid tiers are never refused for load, only for their own caps. The ETA is shown as a band (p50–p90) because a later-arriving user with no backlog legitimately enters ahead of a deep queue under fair sharing, so a single number would be broken promises.

### 7. Safety Fails Closed at Both Ends

The prompt check runs before admission so no GPU-seconds are spent on a prompt that will be refused, and it is synchronous so the user gets an immediate, editable error. The output check runs on sampled frames before the video is visible to anyone, including the requester. Unlike a rate limiter, which fails open, safety fails closed: if the prompt classifier is down, submissions return `503`; if the output classifier is down, finished jobs wait in `postprocessing` and are released when it recovers. The cost is availability coupling to the classifier fleet, which therefore gets its own capacity headroom and circuit breaker.

## Consistency and Idempotency

### Submission

- `Idempotency-Key` is required. `UNIQUE (user_id, idempotency_key)` makes a retried `POST` return the original jobs. `request_hash` turns key reuse with a different body into `409`.
- The job rows, the credit reservation and the outbox events commit in one transaction, so there is never a job without a reservation or a reservation without a job.

```sql
-- Reserve inside the submission transaction; zero rows → 402 insufficient_credits.
UPDATE credit_accounts
SET reserved = reserved + $2
WHERE user_id = $1 AND balance - reserved >= $2
RETURNING reserved;
```

### Execution: At-Least-Once Running, Exactly-Once Effects

A job may run more than once (lease lost while the worker was actually alive), but its *effects* happen once:

```sql
-- Dispatch: loses cleanly to a concurrent cancel.
UPDATE generation_jobs
SET status = 'dispatched', lease_epoch = lease_epoch + 1, attempt = attempt + 1,
    worker_id = $2, dispatched_at = now(), version = version + 1
WHERE id = $1 AND status = 'queued'
RETURNING lease_epoch;

-- Completion: only the current lease holder can finish the job.
UPDATE generation_jobs
SET status = 'postprocessing', gpu_seconds_used = $3, worker_id = NULL, version = version + 1
WHERE id = $1 AND lease_epoch = $2 AND status = 'running';
```

- **Fencing**: every worker call carries `lease_epoch`. A zombie worker that was presumed dead gets zero rows updated and is told to stop.
- **Separate output keys per attempt** (`attempt-{n}.mp4`) mean two attempts never overwrite each other's files; only the attempt whose `complete` won is transcoded.
- **Credit settlement** is idempotent through `UNIQUE (job_id, entry_type)`: capture at actual GPU-seconds on success; release on cancel, on system failure and on `failed`; a policy block captures the GPU time used.
- **Events** are published from the outbox by a relay with at-least-once delivery; consumers (notifier, billing) dedupe by `(job_id, version)`.

### Client-Visible Ordering

Every job change bumps `version`. SSE events carry it, and clients discard any event older than what they hold. A reconnect sends a full snapshot of active jobs, so a missed pub/sub message (which Redis does not buffer) is corrected on the next connect or the next event for that job.

## Security / Auth

- **Authentication**: session cookies for the web app (Redis-backed), API keys for API customers; OAuth/OIDC sign-in in production.
- **Authorization**: every job and video query is scoped by `user_id`; admin endpoints require `role = 'admin'` and are audit-logged.
- **Rate limiting**: submission requests are rate-limited per user (10/min) at the gateway, separately from queue caps, to stop scripted hammering of the classifier and the admission path.
- **Abuse of the free tier**: account farming is the main threat to free capacity; phone verification and device signals gate the free quota.
- **Worker channel**: workers authenticate to the scheduler with mTLS and per-node identity; workers never receive user credentials.
- **Content access**: private videos are served with signed CDN URLs (1-hour expiry); the signature is excluded from the CDN cache key so private videos still cache at the edge. Quarantined objects are readable only by the trust-and-safety role.
- **Prompt privacy**: prompts are user content; they are encrypted at rest, excluded from logs (hashed for correlation), and retained per policy.
- **Provenance**: outputs carry a visible watermark and content-credential metadata identifying them as generated.

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Why |
|--------|------|--------|-----|
| `t2v_queue_depth` | Gauge | pool, tier | Backlog by tier |
| `t2v_queue_wait_seconds` | Histogram | pool, tier | Wait SLOs (pro p90 < 60 s, plus p90 < 300 s) |
| `t2v_eta_error_ratio` | Histogram | tier | Realized ÷ predicted wait; calibrates the p90 band |
| `t2v_dispatch_total` | Counter | pool, tier | Dispatch rate feeds the ETA model |
| `t2v_gpu_slots` | Gauge | pool, state | idle / busy / draining / quarantined |
| `t2v_job_runtime_seconds` | Histogram | quality | Cost model accuracy |
| `t2v_lease_lost_total` | Counter | pool | Spikes mean failing hardware or a partition |
| `t2v_cancel_latency_seconds` | Histogram | from_state | Cancel SLO for running jobs |
| `t2v_admission_decisions_total` | Counter | tier, decision | accepted / degraded / refused |
| `t2v_fairness_jain_index` | Gauge | pool, tier | Fairness among backlogged users, 10-minute window |
| `t2v_safety_verdicts_total` | Counter | stage, verdict | Block rates; sudden shifts mean classifier drift |
| `t2v_sse_connections` | Gauge | node | Gateway capacity |

### Alerts

- **Idle GPUs with a non-empty queue** for more than 60 s: the scheduler is stuck or a fit rule excludes everything. This is the most important scheduler alert.
- Free predicted wait above 10 minutes (expected to flip admission mode) and above 20 minutes (refusing).
- Lease-lost rate above 3× baseline, or any GPU quarantined twice in a day.
- `t2v_eta_error_ratio` p50 outside 0.5–2.0 for 15 minutes: the ETA model is lying to users.
- Prompt classifier p99 above 300 ms or its breaker open.

### Logging and Tracing

Pino JSON logs carry `job_id`, `attempt` and `lease_epoch` and never the raw prompt. One trace spans API → scheduler → worker → post-processor, so "why did my video take 25 minutes" splits into queue wait, run time, retries and post-processing.

## Failure Handling

| Failure | Detection | Response |
|---------|-----------|----------|
| GPU or node dies mid-job | No heartbeat for 30 s | Requeue at the head of the user's queue; resume from checkpoint if any; attempt ≤ 3 |
| Black-hole GPU (fails every job fast) | 3 failed attempts on one `gpu_uuid` within an hour | Quarantine the slot; it would otherwise pull and fail jobs faster than any healthy GPU |
| Poison prompt (fails on every GPU) | Same error code on two different GPUs | Mark `failed`, release credits; don't burn a third attempt |
| Zombie worker after a partition | Stale `lease_epoch` | Writes rejected; worker told to stop; its mezzanine file is ignored |
| Scheduler leader crash | Coordination lease expires | Standby rebuilds from PostgreSQL; 60 s heartbeat grace; dispatch pauses ~10–15 s |
| PostgreSQL primary failover | Connection errors | Submissions `503` for ~30 s; running jobs continue; worker completions retry with the same epoch (idempotent) |
| Object store errors | Upload failures | Worker keeps the mezzanine on local disk and retries with backoff; if the node dies first, the job resumes from its last checkpoint |
| Prompt classifier down | Breaker open | Fail closed: `503` on submission |
| Output classifier down | Breaker open | Jobs wait in `postprocessing`; released on recovery |
| SSE gateway node dies | Client stream error | `EventSource` reconnects to another node and receives a snapshot |
| Region loss | Health checks | See Scalability; queued jobs re-enqueued elsewhere, running jobs restart from scratch |

Circuit breakers (Opossum locally) wrap the safety classifiers, object storage and the notification providers. Retries use exponential backoff with full jitter, capped at 3 attempts for synchronous paths so a struggling dependency isn't hit by a retry storm.

## Scalability Considerations

### What Breaks First

1. **GPUs.** Always first. Everything in "What Queueing Cannot Absorb" follows from a fleet sized at 125 jobs/s against peaks of 200 and bursts of 500. The levers are admission modes, draft-first product defaults, and buying capacity, in that order of speed.
2. **The scheduler leader at 10×.** 1,250 dispatches/s and 30,000 heartbeats/s (150,000 GPUs) is past a comfortable single process. Split pools further (region × GPU class × model version), keep one leader per pool, and add a global per-user running counter (Redis) so caps hold across pools. Fairness becomes per-pool, which is acceptable because users are homed to a region.
3. **PostgreSQL at 10×.** ~10,000 writes/s at bursts. Shard by `user_id` (all of a user's jobs, credits and videos co-located); partition jobs by month for retention.
4. **SSE gateways and CDN** scale horizontally and are not a design risk.

### Region Loss

Three regions of 5,000 GPUs each. Losing one leaves 10,000 GPUs. At average load the demand is pro 2,400 + plus 3,600 + free 6,000 = 12,000 GPUs, which doesn't fit. Switching free to draft-only cuts free demand to 50 jobs/s × 40 = 2,000 GPUs, for a total of 8,000 GPUs: it fits at 80% utilization. So region loss at average load is survivable with one admission-mode flip; at peak it additionally needs `paid_only`.

Mechanics: job rows replicate asynchronously to a standby region (RPO of seconds; clients that never got a `202` resubmit with the same idempotency key). Queued jobs are re-enqueued in the surviving regions. Running jobs restart from scratch because checkpoints are not replicated across regions: 1.25 GB/s of cross-region checkpoint traffic per region isn't worth paying continuously for a rare event.

### 10× Users

GPU demand becomes 120,000 busy GPUs, which can't be bought quickly. The product levers matter most: default to drafts and upscale only the clips a user keeps (a draft costs a third of a standard clip), cap variations for free users, and price HD to reflect its 15× cost. Infrastructure follows the "what breaks first" list.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Job API | 202 + job ID + SSE | Held connection or polling | Survives disconnects; 8,000 events/s instead of 100,000 polls/s |
| Fairness | Two-level WFQ on GPU-seconds | FIFO or strict priority | No user or tier monopolizes; free tier never starves |
| Cost unit | Estimated GPU-seconds, settled to actual | Job count | An HD job is 15× a draft |
| Monopoly control | Per-user running and queued caps | Preempting long jobs | Non-preemptive jobs need caps; preemption wastes warm GPU work |
| Scheduler | One leader per pool, pull leases | Sharded or decentralized | 125 dispatches/s fits one process; fairness stays exact |
| Liveness | In-memory leases + fencing epochs | Lease rows updated in PostgreSQL | 3,000 heartbeats/s kept off the database |
| Cancellation | Cooperative at step boundary | Kill the process | Keeps weights loaded; hard kill only as backstop |
| Checkpointing | HD jobs at 25/50/75% | Every job, or none | Failures cost 0.005% of fleet time; HD users and drains benefit |
| Bursts | Degrade free to draft, then refuse | Unbounded queue | A 3-hour backlog is a broken promise |
| Safety | Fail closed, prompt and output | Fail open | Releasing a harmful video is worse than a delay |
| Progress path | Redis pub/sub (lossy) + versioned snapshot | Every tick through PostgreSQL | 7,500 updates/s don't need durability |
| Output delivery | Immutable keys behind a CDN, signed URLs | Serving from origin | 9.6 Gbps average egress; private videos still cache |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local implementation: Docker Compose infrastructure, a Node.js + Express + TypeScript backend, and a React 19 + Vite + TanStack Router + Zustand + Tailwind frontend. The goal is to make the scheduler, fairness, cancellation, failure recovery and admission behavior observable on a laptop with no GPU.

### Planned Local Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Local machine                                                            │
│                                                                          │
│  ┌──────────────┐   REST + SSE   ┌──────────────────────────┐            │
│  │ Frontend     │───────────────▶│ API service :3000        │            │
│  │ Vite :5173   │                │ admission · jobs · SSE   │            │
│  └──────────────┘                └──────┬────────────┬──────┘            │
│                                         │ enqueue    │ subscribe          │
│                                         ▼            ▼                    │
│  ┌──────────────────────────┐    ┌──────────────┐ ┌──────────────┐        │
│  │ Scheduler :3001          │    │ PostgreSQL   │ │ Valkey       │        │
│  │ stride WFQ · leases ·    │───▶│ :5432        │ │ :6379        │        │
│  │ advisory-lock leader     │    └──────────────┘ └──────▲───────┘        │
│  └──────────▲───────────────┘                            │ progress       │
│             │ lease long-poll                            │                │
│  ┌──────────┴───────────────┐    ┌──────────────┐        │                │
│  │ GPU simulators           │───▶│ MinIO :9000  │◀───────┼──────┐         │
│  │ :3002, :3003 × 4 slots   │────┼──────────────┼────────┘      │         │
│  └──────────────────────────┘    └──────────────┘               │         │
│                                  ┌──────────────┐   ┌───────────┴──────┐  │
│                                  │ RabbitMQ     │──▶│ Post-processor   │  │
│                                  │ :5672/:15672 │   │ :3004 (metrics)  │  │
│                                  └──────────────┘   └──────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Planned

| Pattern | Planned location | Why it matters at scale |
|---------|------------------|-------------------------|
| Idempotent submission | `backend/src/api/generations.ts` (planned) | `Idempotency-Key` + `UNIQUE (user_id, idempotency_key)`; a client retry after a timeout never creates a second paid job |
| Stride fair queueing | `backend/src/scheduler/stride.ts` (planned) | The two-level algorithm above, unit-tested against a brute-force fair-share simulation |
| Leases and fencing | `backend/src/scheduler/leases.ts` (planned) | Epoch-checked conditional updates; demonstrated by pausing a simulator with `SIGSTOP` |
| Circuit breakers (Opossum) | `backend/src/shared/circuit-breaker.ts` (planned) | Wraps the simulated classifiers and MinIO; safety breakers fail closed |
| Prometheus metrics (prom-client) | `backend/src/shared/metrics.ts` (planned) | Queue depth, wait histograms, ETA error, GPU slot states, Jain's index at `/metrics` |
| Structured logging (Pino) | `backend/src/shared/logger.ts` (planned) | `job_id`, `attempt`, `lease_epoch` on every line; prompts hashed |
| Health checks | each service's `/health` and `/ready` (planned) | Readiness includes PostgreSQL, Valkey and, for the scheduler, whether it holds leadership |
| Rate limiting | `backend/src/shared/rate-limit.ts` (planned) | Valkey sliding window on submissions, 10/min per user |
| Transactional outbox | `backend/src/shared/outbox.ts` (planned) | Relay publishes to RabbitMQ; consumers dedupe by `(job_id, version)` |

Planned code snippet for the dispatch path, mirroring the SQL above:

```typescript
// backend/src/scheduler/dispatch.ts (planned)
const res = await pool.query(
  `UPDATE generation_jobs
     SET status = 'dispatched', lease_epoch = lease_epoch + 1, attempt = attempt + 1,
         worker_id = $2, dispatched_at = now(), version = version + 1
   WHERE id = $1 AND status = 'queued'
   RETURNING lease_epoch`,
  [job.id, worker.id],
);
if (res.rowCount === 0) return pickNext(worker); // cancelled while queued; try the next job
```

### What Will Be Simplified or Simulated

| Production | Local plan | Effect |
|------------|------------|--------|
| GPU fleet running the model | Simulator processes, 4 slots each; each step sleeps `stepMs × SIM_TIME_SCALE` | Real scheduling, leases and progress; no real video |
| Generated video | If `ffmpeg` is on the PATH, render a short test-pattern clip with the prompt drawn on it; otherwise copy one of three bundled sample clips | Playable output, poster and preview without a model |
| Checkpoints | A small JSON blob (step, seed) in MinIO | Resume-from-step behavior is real; the bytes are not |
| GPU failures | `WORKER_FAILURE_RATE`, `kill -9`, `SIGSTOP`, and an admin "fail this slot" button | Exercises lease loss, fencing, quarantine |
| Prompt and output classifiers | Keyword blocklist plus a configurable random block rate and latency | Fail-closed and breaker behavior are real |
| Kafka job-events | RabbitMQ exchange fed by the outbox relay | Same at-least-once semantics |
| etcd leader election | PostgreSQL advisory lock | Run two schedulers to see standby takeover |
| CDN | MinIO presigned URLs (optionally an nginx caching proxy) | Signed-URL expiry and refresh are real |
| Credits and payments | Seeded GPU-second balances | Ledger reserve, capture and release are real |
| Push and email notifications | In-app toasts and the browser Notification API; Web Push only if VAPID keys are configured | Completion while the tab is hidden still notifies |
| OAuth | Session auth with Valkey | Simpler; matches repository conventions |

### What Will Be Omitted

- Real GPUs, model inference, hardware encoding and multi-GPU jobs
- Multi-region cells, cross-region replication and region failover
- Kubernetes, autoscaling and spot capacity
- Watermarking and content-credential signing (fields exist; no cryptography)
- Human trust-and-safety review tooling beyond a quarantine list in the admin view
- Billing integration and invoices

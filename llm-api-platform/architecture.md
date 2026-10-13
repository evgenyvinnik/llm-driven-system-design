# LLM API Platform - Architecture Design

## System Overview

A public, metered API for large language models, in the style of the OpenAI and Anthropic developer platforms. Developers create API keys, send generation requests (streamed or not), and pay per token, either from a prepaid credit balance or on a monthly invoice. The platform sits between millions of developers and a fleet of GPU (and some CPU) model replicas. It owns everything around the model: authentication and the key lifecycle, rate limits on requests *and* tokens, routing each request to the right model version's replica pool, metering every token exactly once, turning usage into credit draws and invoices, and retiring old model versions without breaking clients. The model itself is a black box that accepts a prompt and emits tokens at a measurable rate.

Three things make this harder than a generic API gateway:

1. **The cost of a request is unknown when it is admitted.** Input tokens can be counted up front, but output length is only known after generation ends. Token rate limits and credit holds must be reserved against an estimate and reconciled afterwards.
2. **Every token is money.** At 4.32B requests/day, a 0.1% metering error is about $15.6K/day. Client retries, internal retries, at-least-once queues, and late events all have to collapse into exactly one billed record per generation.
3. **Capacity is GPU-bound and versioned.** Each model snapshot runs in its own replica pools. Routing, load shedding, and deprecation all act on pools that cost far more than the gateway in front of them.

**Learning goals:** two-dimensional rate limiting (RPM and TPM) with reserve-then-reconcile; exactly-once billing effects from at-least-once delivery; holds, captures, and reconciliation on a double-entry ledger; model/version routing and deprecation; and back-of-envelope sizing of a 100K RPS generation service.

## Requirements

### Functional Requirements

1. **Key management**: create, scope (project, endpoints, models), rotate, and revoke API keys. The secret is shown once and never stored. Last-used tracking. Leaked keys reported by secret scanners are revoked automatically.
2. **Inference API**: generation (synchronous or SSE streaming), embeddings, token counting, and a models endpoint that exposes lifecycle dates.
3. **Rate limits**: per-organization limits set by usage tier, per model family, on requests/min (RPM) and tokens/min (TPM). Optional customer-set sub-limits per project and per key. Limit headers on every response, and 429 with `Retry-After` when denied.
4. **Spend controls**: prepaid credit balance with holds; a monthly spend cap for invoiced orgs; budget alert thresholds.
5. **Metering**: each billable request yields exactly one usage record (input, cached input, and output tokens). Usage is queryable by org, project, key, model, and hour within minutes.
6. **Billing**: hourly priced usage, ledger captures, monthly invoices with per-model line items, and daily reconciliation.
7. **Routing**: alias → snapshot → pool → replica, with traffic splits for migrations, GPU and CPU backends, and priority classes (interactive, batch).
8. **Model lifecycle**: preview → GA → deprecated → sunset → retired, with deprecation headers, brownouts, and per-org migration tracking.
9. **Developer console** (keys, usage, limits, billing, model notices) and an **admin console** (tiers, overrides, pools, lifecycle).

### Non-Functional Requirements

| Property | Target |
|----------|--------|
| Throughput | 100K generation RPS at peak; 400K concurrent in-flight requests |
| Gateway overhead | p50 < 5 ms, p99 < 15 ms added before the request reaches a replica (auth, limits, routing) |
| Availability | 99.99% for the inference path; 99.9% for console and billing |
| Metering accuracy | No lost or duplicated billable events; daily reconciliation gap < 0.01% |
| Usage freshness | Dashboards ≤ 2 min behind; billed totals by H+1h15m; invoices final 3 days after month end |
| Limit accuracy | RPM exact; TPM overshoot bounded by in-flight estimation error and repaid as debt |
| Revocation | A revoked key stops working within 1 s (pub/sub), 60 s worst case (cache TTL) |
| Durability | A usage event is never dropped once a response has been sent |

### Out of Scope

- Model internals: batching, KV-cache management, GPU kernels. These are covered by the planned [LLM Inference Batching](../FUTURE_PROJECTS.md#llm-inference-batching) project.
- Fine-tuning, file storage, and stateful assistant/thread APIs.
- Card processing internals. A payment provider handles them (see [Payment System](../payment-system/) and [Stripe](../stripe/)).
- Tax calculation and multi-currency pricing.

## Capacity Estimation

### Assumptions

| Assumption | Value | Note |
|------------|-------|------|
| Peak generation RPS | 100,000 | The reported "100K RPS token-generation service" |
| Average RPS | 50,000 | 50% of peak over a day |
| Average input tokens / request | 1,000 | ≈ 4 KB of text at ~4 bytes/token |
| Average output tokens / request | 200 | ≈ 800 bytes of text |
| Decode speed per stream | 50 tokens/s | So an average generation takes 200 / 50 = 4 s |
| Replica throughput | 200 concurrent sequences × 50 tok/s = 10,000 output tok/s | One replica = one model copy on 8 GPUs, continuous batching |
| Organizations | 3M total, 1M active per day, about half prepaid | |
| Illustrative blended price | $2 per 1M input tokens, $8 per 1M output tokens | Not any real model's price |

### Traffic and Tokens

- Requests/day: 50,000 × 86,400 = **4.32B**
- Peak token rate: 100,000 × 1,000 = **100M input tok/s**; 100,000 × 200 = **20M output tok/s**
- Daily tokens: 4.32B × 1,000 = **4.32T input**; 4.32B × 200 = **864B output**
- In-flight requests at peak (Little's law): 100,000 RPS × 4 s = **400,000 concurrent**

### Serving Fleet (Lower Bound)

- Decode is the binding constraint: 20M output tok/s ÷ 10,000 tok/s per replica = **2,000 replicas** at peak
- Cross-check with concurrency: 400,000 in flight ÷ 200 slots per replica = 2,000 replicas
- At 8 GPUs per replica, that is **16,000 GPUs** before headroom. The fleet costs orders of magnitude more than everything else in this document, so the gateway's main job is to keep it busy with the *right* work.

### Gateway

- Assume one node handles 5,000 RPS of auth/limit/route work and 20,000 open streams
- 100,000 ÷ 5,000 = 20 nodes; 400,000 ÷ 20,000 = 20 nodes. Deploy **40 per region** for 2× headroom and zone loss.
- Egress per node (assume 10 Gbps NICs): 20,000 streams × 50 tok/s × ~100 B per SSE frame = 100 MB/s ≈ 0.8 Gbps. Ingress: 5,000 × 4 KB = 20 MB/s. Nodes are bound by CPU and connection count, not the NIC. Coalescing tokens into one frame per 50 ms cuts frame count by ~2.5×.

### Rate Limiter (Redis)

- Two script calls per request (reserve + reconcile) → **200K Lua calls/s** at peak
- Budget 25K calls/s per primary (about half its ceiling) → **8 primaries**, each with a replica
- Memory: 1M active orgs × ~1 KB of buckets ≈ 1 GB, plus 400K open reservations × ~100 B ≈ 40 MB. CPU is the constraint, not memory.

### Metering and Storage

| Item | Calculation | Result |
|------|-------------|--------|
| Usage events | 1 per request, ~200 B | 100K events/s at peak = 20 MB/s |
| Raw events per day | 4.32B × 200 B | 864 GB/day |
| Kafka (7-day retention, RF 3) | 864 GB × 7 × 3 | ≈ 18 TB |
| Kafka partitions | 64, keyed by org_id | ≈ 1,560 events/s per partition at peak |
| ClickHouse (~10× compression) | 86.4 GB/day × 395 days (13 months) | ≈ 34 TB |
| Idempotency records | 10% of requests carry a key × ~1 KB × 24 h TTL | ≈ 432 GB live |
| Ledger captures | up to 500K prepaid orgs × 24 hourly closes | ≤ 12M rows/day, partitioned monthly |

### Money

- Daily billings: 4.32T input × $2/1M = $8.64M; 864B output × $8/1M = $6.912M → **≈ $15.6M/day**
- Average request: 1,000 × 2 micro-dollars + 200 × 8 micro-dollars = 3,600 micro-dollars = **$0.0036**
- A 0.1% metering error ≈ **$15.6K/day** (≈ $5.7M/year). The 0.01% reconciliation alarm ≈ $1.6K/day.

### Local Development Scale

| Component | Local sizing |
|-----------|--------------|
| Gateway | 1 Express process on :3000, ~50 RPS from a load script |
| Model pools | 3 simulated replicas (:3001–:3003), 8 concurrent slots each, 20–80 tok/s |
| Redis | 1 Valkey instance, all hash tags on one node |
| Kafka | 1 KRaft broker, 4 partitions |
| ClickHouse | 1 node, ~1M events/day |
| Billing close | Every 60 s instead of hourly (time-compressed) |

## High-Level Architecture

### Data Plane: One Generation Request

```
┌─────────────────────────┐
│ SDK / HTTP client       │
└────────────┬────────────┘
             │ POST /v1/generations  (Bearer key · Idempotency-Key · stream)
┌────────────▼───────────────────────────────────────────────────────────────┐
│ Edge: TLS termination · WAF · L7 load balancer (per region)                │
└────────────┬───────────────────────────────────────────────────────────────┘
             │
┌────────────▼──────────────────────────────┐      ┌─────────────────────────┐
│ API GATEWAY (stateless fleet)             │      │ Key cache → PostgreSQL  │
│  1 authenticate key ──────────────────────┼─────▶│ keys · scopes · tiers   │
│  2 idempotency check ─────────────────────┼─────▶├─────────────────────────┤
│  3 resolve alias → snapshot               │      │ Idempotency KV (24 h)   │
│  4 count input tokens                     │      ├─────────────────────────┤
│  5 reserve RPM · TPM · spend ─────────────┼─────▶│ Limiter Redis Cluster   │
│  6 route ──────────────┐                  │      │ hash tag = {org_id}     │
│  7 stream SSE frames   │                  │      └─────────────────────────┘
│  8 reconcile actuals   │                  │
│  9 emit usage event ───┼──────────────────┼─────▶ Kafka: usage-events
└────────────────────────┼──────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────────────────────┐
│ ROUTER / SCHEDULER: snapshot → pool (weights, class) → replica (load)      │
└───────┬──────────────────────────┬─────────────────────────────┬───────────┘
        ▼                          ▼                             ▼
┌────────────────┐        ┌────────────────┐            ┌────────────────┐
│ GPU pool       │        │ GPU pool       │            │ CPU pool       │
│ model-a-v2     │        │ model-a-v3     │            │ embeddings ·   │
│ (deprecated)   │        │ (GA)           │            │ small models   │
└────────────────┘        └────────────────┘            └────────────────┘
```

### Metering and Billing Plane

```
Kafka usage-events (64 partitions, key = org_id)
        │
        ├──────────────────────────────┬──────────────────────────────┐
        ▼                              ▼                              ▼
┌──────────────────┐        ┌──────────────────────┐       ┌────────────────────┐
│ Metering writer  │        │ Spend tracker        │       │ Late-event marker  │
│ batches by offset│        │ budget alerts        │       │ dirty (org, hour)  │
└────────┬─────────┘        └──────────────────────┘       └─────────┬──────────┘
         ▼                                                           │
┌──────────────────────────────────────┐                             │
│ ClickHouse                           │                             │
│ usage_events (ReplacingMergeTree) ───┼──▶ usage_hourly_estimate    │
│                                      │    (MV, dashboards)         │
└────────┬─────────────────────────────┘                             │
         │ dedupe, price, diff against what was already billed       │
┌────────▼───────────────────────────────────────────────────────────▼───┐
│ BILLING CLOSE (hour H at H+1h15m; re-closes dirty hours)               │
│ → usage_billed_hourly (ClickHouse) → capture transfers (PostgreSQL)    │
└────────┬───────────────────────────────────────────────────────────────┘
         ▼
┌──────────────────────┐    ┌────────────────────────┐    ┌──────────────────┐
│ Ledger (PostgreSQL)  │───▶│ Invoicer               │───▶│ Payment provider │
│ holds · captures ·   │    │ month end + 3 days     │    │ cards · ACH      │
│ releases · purchases │    └────────────────────────┘    └──────────────────┘
└──────────▲───────────┘
           │ leases (holds) for prepaid orgs
   Limiter Redis spend buckets
```

The **control plane** (console API, admin API, model lifecycle service) writes to PostgreSQL. Gateways and routers hold its configuration (keys, limits, routes, prices) in memory and refresh it through change notifications, so no PostgreSQL query sits on the inference path.

## Core Components / Request Flows

### 1. API Gateway: Authentication

- Key format: issuer prefix, a 12-character public `key_id`, a 256-bit random secret (base62), and a 6-character checksum. The prefix and checksum let secret scanners recognize leaked keys with few false positives.
- Lookup: parse `key_id`, then check the in-process LRU (60 s TTL, >99% hit rate). On a miss, read Redis, then PostgreSQL. Compare `HMAC-SHA-256(pepper, secret)` against `secret_hmac` in constant time.
- Why HMAC and not bcrypt: the secret has 256 bits of entropy, so brute force is infeasible whatever hash we use. A slow hash would cost about 50 ms of CPU per uncached check, and the pepper means a leaked database cannot even be used to verify guesses.
- Revocation publishes `key_revoked:{key_id}` on Redis pub/sub, and every gateway evicts that entry. The 60 s TTL bounds the damage if a message is missed.
- Scopes: endpoint scopes (`generate`, `embed`, `models:read`), an optional model allowlist, and the project. A mismatch returns 403.
- `last_used_at` is written to Redis (`SET` with a 5-minute coalescing window) and flushed to PostgreSQL in batches, never per request.

### 2. Admission: Two-Dimensional Limits with Reserve-then-Reconcile

Each request is checked against **all** applicable buckets in one atomic Redis script: org RPM and TPM for the model family (from the tier, or an override), any project/key sub-limits, and the org's spend bucket. Buckets are token buckets: capacity = the per-minute limit, refill = limit/60 per second.

The output side of TPM is estimated. The estimate is a high percentile of this key's recent output length for this snapshot (an exponentially weighted mean + 2σ), capped at `max_tokens` and floored at 64. It is reconciled with the actual count when the request finishes, and at checkpoints every 512 output tokens during long streams.

```text
reserve(org, key, family, snapshot, request_id, input_tokens, max_tokens, now):
  est_out   = clamp(est[key,snapshot].mean + 2 * est[key,snapshot].stddev, 64, max_tokens)
  need_tok  = input_tokens + est_out
  need_cost = input_tokens * price_in + est_out * price_out          # micro-dollars
  buckets   = [rpm(org,family), tpm(org,family), tpm(project,family)?, tpm(key,family)?]
  refill every bucket to `now` (Redis TIME, never the gateway clock)
  failing = [b for b in buckets if b.tokens < need(b)]               # need = 1 for RPM
  if failing: return DENY(limit = failing[0], retry_after = max(deficit(b) / b.rate))
  if spend(org).remaining < need_cost: return NEED_LEASE             # nothing consumed
  subtract need from every bucket; spend(org).remaining -= need_cost  # all-or-nothing
  HSET res:{org}:{request_id} tok need_tok cost need_cost  EX 900
  return ALLOW(remaining and reset for the tightest RPM and TPM buckets)

reconcile(org, request_id, actual_in, actual_out, final):
  r = HGETALL res:{org}:{request_id}
  if r is empty: return NOOP                         # already reconciled or expired
  delta_tok  = actual_in + actual_out - r.tok        # negative = refund
  delta_cost = actual_in * price_in + actual_out * price_out - r.cost
  every TPM bucket -= delta_tok                      # may go negative: debt
  spend(org).remaining -= delta_cost
  if final: update est[key,snapshot] with actual_out; DEL res:{org}:{request_id}
  else:     HSET res tok (actual_in + actual_out) cost (actual cost so far)
```

Details that matter:
- **All-or-nothing.** If TPM denies, RPM must not be charged. Otherwise a client stuck behind the token limit also drains its request limit.
- **Debt instead of truncation.** A request that overruns its estimate is never cut off mid-stream. Its bucket goes negative, and new admissions wait until refill repays the debt. The overshoot is bounded by in-flight requests × (`max_tokens` − estimate).
- **Idempotent reconcile.** The reservation hash is deleted on the final reconcile, so a retried reconcile is a no-op.
- **Lost reconcile.** If a gateway dies, the reservation expires after 15 minutes and the estimate stays charged. That is conservative for limiting and has no effect on billing, which comes from usage events.
- **Same hash slot.** Every key carries the `{org_id}` hash tag, so one script call touches one shard.

### 3. Router and Scheduler

1. **Resolve** the alias to a snapshot. An org pin (an opt-out during a migration) wins. Otherwise `alias_routes` weights apply, using a stable hash of `org_id` so an org sees one snapshot consistently during a canary.
2. **Lifecycle gate**: `retired` or `sunset` → 410 `model_retired` with the replacement. Inside a brownout window → the same 410. `deprecated` → serve, with `Deprecation`, `Sunset`, and `Link: rel="successor-version"` headers.
3. **Pick a pool** among the snapshot's active pools in the region whose `serves_classes` include the request's class, by weight.
4. **Pick a replica** with power-of-two-choices on expected completion time (ECT): `queue_wait + prefill(input_tokens, hw) + decode(est_out, hw)`. A prefix-affinity bonus favors the replica that recently served the same prompt prefix (consistent hash of the first 1K tokens), so its prefix cache gets reused.
5. **GPU vs CPU**: interactive generation goes only to GPU pools. Embeddings, token counting, and moderation classifiers go to CPU pools first and overflow to GPU. Batch-class requests for small models go to the cheapest pool, in $ per token, whose ECT still meets the 24 h deadline, which is often CPU.
6. **Shedding**: when every candidate pool's queue wait exceeds the class SLO, shed in priority order (batch, then free trial, then paid) with 503 `overloaded` and `Retry-After`. This protects GPUs independently of customer rate limits.
7. **Replica failure**: if no token has reached the client, retry once on another replica, reusing the same reservation. If tokens were already streamed, send an SSE `error` event (`stream_interrupted`), reconcile what was generated, and mark the event `platform_failed` (not billed).

### 4. Metering Pipeline

- The gateway emits **one usage event per client request** when it reaches a terminal state: `completed`, `client_cancelled` (billed for tokens generated before the cancel reached the replica), or `platform_failed` (not billed).
- Token counts come from the replica's final report, which is authoritative because the replica may add formatting tokens the gateway did not count. Gateway-side counts are used only for admission.
- `event_id` = `uuidv5(org_id, idempotency_key)` when the client sent a key, otherwise the gateway's `request_id`. Every duplicate of the same generation therefore carries the same id.
- Producer: Kafka with `acks=all` and an idempotent producer. If Kafka is unavailable, the gateway appends to a local disk spool (fsync per batch) and replays it later. The client's response never waits on Kafka.
- Metering writer: consumes partitions in offset-aligned batches. A retried insert is byte-identical, so ClickHouse block-level insert deduplication drops it. `ReplacingMergeTree` on `event_id` collapses any remaining duplicates at merge time.
- Late-event marker: if an event's hour has already been closed, it records `(org_id, hour)` in a dirty set so the billing close re-closes just that org-hour.
- Rate-limited (429) requests are not usage events. Gateways aggregate them per (key, model, limit type) per minute into a separate low-volume topic for the console's error charts.

### 5. Billing: Credits, Holds, Captures, Invoices

The ledger is a transfer ledger. Each transfer moves `amount > 0` from a debit account to a credit account, so balances always sum to zero.

| Movement | Debit account → Credit account | When |
|----------|--------------------------------|------|
| Purchase | platform `funding` → org `available` | Card charge or bank transfer succeeds |
| Grant | platform `promo` → org `available` | Free credits, goodwill |
| Hold (lease) | org `available` → org `held` | Gateway needs spend headroom for a prepaid org |
| Capture | org `held` → platform `revenue` | Hourly close prices the org-hour |
| Release | org `held` → org `available` | A lease closes with an unused remainder |
| Accrue (invoiced orgs) | org `receivable` → platform `revenue` | Hourly close; `receivable` goes negative |
| Settle | platform `funding` → org `receivable` | Invoice paid |

**Leases.** Writing the ledger per request would mean 100K PostgreSQL transactions/s. Instead, the billing service grants an org a *lease*: a hold sized at about 5 minutes of the org's recent spend, at least $1 and at most 10% of its available balance. The lease amount is loaded into the org's Redis spend bucket. Requests draw per-request holds against it in the reserve script. When the bucket is nearly empty, the gateway requests the next lease, which means a few lease grants per org-hour and hundreds per second fleet-wide.

**Capture.** The hourly close computes actual priced usage from deduplicated events and moves that amount from `held` to `revenue`. If `held` is short (estimates ran low), the remainder comes from `available`, which may go slightly negative. That overdraft is bounded by in-flight estimation error and nets against the next purchase or auto-recharge.

**Release.** A lease closes when its Redis remainder is exhausted or after 1 hour. Once the close covering its last use has posted, `held` is trued up to the sum of open lease remainders, and any excess returns to `available`.

**Invoices.** Invoiced orgs accrue to `receivable` hourly and have a monthly spend cap, which is enforced through the same Redis spend bucket (budget = cap − month-to-date spend). The invoicer finalizes each period 3 days after month end. Line items come from `usage_billed_hourly` grouped by snapshot, usage type, and price. Totals are rounded to cents once, at finalization. Usage that arrives after finalization goes on the next invoice as a "prior-period usage" line.

### 6. Model Lifecycle Service

- Snapshots are immutable. Aliases move between snapshots only through `alias_routes` changes: 1% → 10% → 50% → 100% over days, watching error rate, latency, and output length (which changes cost).
- Deprecation announces a `sunset_at` at least 6 months out for GA snapshots and sets `replacement_id`. Every response carries `Deprecation` and `Sunset` headers.
- **Migration tracking** reads the metering data: ClickHouse lists each org and key still calling the snapshot, with their volume. That list drives emails, console banners, and account-manager outreach.
- **Brownouts**: scheduled windows (15 minutes, then 1 hour, then 4 hours as sunset approaches) during which the snapshot returns the same 410 it will return after sunset. Unattended integrations surface while there is still time to fix them.
- After sunset, the pool drains (`status = 'draining'`). It scales to zero once the remaining in-flight requests finish.

### End-to-End Flow: One Streamed Generation

1. The SDK sends `POST /v1/generations` with a bearer key, an `Idempotency-Key`, and `stream: true`.
2. The gateway authenticates from its LRU and checks scopes.
3. Idempotency KV: completed → replay the stored response with `Idempotency-Replayed: true`; in progress → 409; body hash differs → 422; otherwise insert `in_progress`.
4. The model resolves to `model-a-v3`. Deprecation headers are added if they apply.
5. The gateway counts 1,000 input tokens and estimates 400 output tokens (`max_tokens` = 4,096).
6. The reserve script takes 1 RPM token, 1,400 TPM tokens, and 1,000 × 2 + 400 × 8 = 5,200 micro-dollars of spend.
7. The router picks a replica. Tokens stream back as SSE frames, coalesced every 50 ms.
8. The replica reports 1,000 input and 200 output tokens. Reconcile refunds 200 TPM tokens and 1,600 micro-dollars.
9. The gateway emits the usage event, sends the final SSE event with `usage`, and stores the idempotency record.
10. Within about 2 minutes the event appears in the console estimate. At H+1h15m it is priced, captured, and becomes part of an invoice line.

## Database Schema

### PostgreSQL (control plane and ledger)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────── Tenancy and access ─────────────
CREATE TABLE usage_tiers (
  tier                       SMALLINT PRIMARY KEY,
  name                       TEXT NOT NULL,
  monthly_spend_cap_micros   BIGINT NOT NULL,
  promote_after_paid_micros  BIGINT NOT NULL,      -- cumulative paid spend to qualify
  promote_after_days         INT NOT NULL
);

CREATE TABLE organizations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  billing_mode           TEXT NOT NULL CHECK (billing_mode IN ('prepaid', 'invoiced')),
  tier                   SMALLINT NOT NULL DEFAULT 1 REFERENCES usage_tiers(tier),
  monthly_budget_micros  BIGINT CHECK (monthly_budget_micros > 0),  -- NULL = tier cap
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'suspended', 'closed')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_users_email ON users (lower(email));

CREATE TABLE org_members (
  org_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'billing_admin', 'developer', 'reader')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  archived_at  TIMESTAMPTZ,
  UNIQUE (org_id, name)
);

CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id          TEXT NOT NULL UNIQUE,              -- public id embedded in the key string
  org_id          UUID NOT NULL REFERENCES organizations(id),
  project_id      UUID NOT NULL REFERENCES projects(id),
  name            TEXT NOT NULL,
  secret_hmac     BYTEA NOT NULL,                    -- HMAC-SHA-256(pepper, secret)
  last_four       CHAR(4) NOT NULL,
  scopes          TEXT[] NOT NULL DEFAULT '{generate,embed,models:read}',
  allowed_models  TEXT[],                            -- NULL = every model the org can use
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT CHECK (revoked_reason IN ('user', 'rotation', 'leak_detected', 'admin')),
  last_used_at    TIMESTAMPTZ                        -- flushed from Redis in batches
);
CREATE INDEX idx_api_keys_project_active ON api_keys (project_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_org ON api_keys (org_id, created_at DESC);

-- ───────────── Models, routing, lifecycle ─────────────
CREATE TABLE models (
  id                   TEXT PRIMARY KEY,             -- public alias, e.g. 'model-a'
  family               TEXT NOT NULL,                -- rate-limit family
  default_snapshot_id  TEXT
);

CREATE TABLE model_snapshots (
  id                 TEXT PRIMARY KEY,               -- immutable, e.g. 'model-a-v3'
  model_id           TEXT NOT NULL REFERENCES models(id),
  lifecycle          TEXT NOT NULL CHECK (lifecycle IN
                       ('preview', 'ga', 'deprecated', 'sunset', 'retired')),
  context_window     INT NOT NULL,
  max_output_tokens  INT NOT NULL,
  released_at        TIMESTAMPTZ,
  deprecated_at      TIMESTAMPTZ,
  sunset_at          TIMESTAMPTZ,
  replacement_id     TEXT REFERENCES model_snapshots(id),
  CHECK (sunset_at IS NULL OR (deprecated_at IS NOT NULL AND sunset_at > deprecated_at))
);
ALTER TABLE models ADD CONSTRAINT fk_models_default_snapshot
  FOREIGN KEY (default_snapshot_id) REFERENCES model_snapshots(id);

CREATE TABLE alias_routes (                          -- weights per alias sum to 100
  alias        TEXT NOT NULL REFERENCES models(id),
  snapshot_id  TEXT NOT NULL REFERENCES model_snapshots(id),
  weight       SMALLINT NOT NULL CHECK (weight BETWEEN 0 AND 100),
  PRIMARY KEY (alias, snapshot_id)
);

CREATE TABLE org_alias_pins (                        -- opt-out window during an alias move
  org_id       UUID NOT NULL REFERENCES organizations(id),
  alias        TEXT NOT NULL REFERENCES models(id),
  snapshot_id  TEXT NOT NULL REFERENCES model_snapshots(id),
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, alias)
);

CREATE TABLE pools (
  id                 TEXT PRIMARY KEY,               -- e.g. 'use1-gpu-model-a-v3'
  snapshot_id        TEXT NOT NULL REFERENCES model_snapshots(id),
  region             TEXT NOT NULL,
  hardware_class     TEXT NOT NULL CHECK (hardware_class IN ('gpu', 'cpu')),
  serves_classes     TEXT[] NOT NULL DEFAULT '{interactive,batch}',
  weight             SMALLINT NOT NULL DEFAULT 100,
  min_replicas       INT NOT NULL,
  max_replicas       INT NOT NULL CHECK (max_replicas >= min_replicas),
  slots_per_replica  INT NOT NULL,                   -- concurrent sequences, e.g. 200
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining', 'off'))
);
CREATE INDEX idx_pools_snapshot ON pools (snapshot_id, region) WHERE status = 'active';

CREATE TABLE brownout_windows (
  snapshot_id  TEXT NOT NULL REFERENCES model_snapshots(id),
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  PRIMARY KEY (snapshot_id, starts_at)
);

-- ───────────── Limits and prices ─────────────
CREATE TABLE tier_limits (
  tier          SMALLINT NOT NULL REFERENCES usage_tiers(tier),
  model_family  TEXT NOT NULL,
  rpm           INT NOT NULL CHECK (rpm > 0),
  tpm           BIGINT NOT NULL CHECK (tpm > 0),
  PRIMARY KEY (tier, model_family)
);

CREATE TABLE limit_overrides (                       -- org raises, or project/key sub-limits
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id),
  scope_type    TEXT NOT NULL CHECK (scope_type IN ('org', 'project', 'key')),
  scope_id      UUID NOT NULL,
  model_family  TEXT NOT NULL,
  rpm           INT CHECK (rpm > 0),
  tpm           BIGINT CHECK (tpm > 0),
  expires_at    TIMESTAMPTZ,
  UNIQUE (scope_type, scope_id, model_family)
);

CREATE TABLE prices (
  id               SERIAL PRIMARY KEY,
  snapshot_id      TEXT NOT NULL REFERENCES model_snapshots(id),
  usage_type       TEXT NOT NULL CHECK (usage_type IN ('input', 'cached_input', 'output')),
  micros_per_mtok  BIGINT NOT NULL CHECK (micros_per_mtok >= 0),  -- $2.00 / 1M = 2,000,000
  effective_from   TIMESTAMPTZ NOT NULL,
  effective_to     TIMESTAMPTZ,
  UNIQUE (snapshot_id, usage_type, effective_from)
);

-- ───────────── Ledger, leases, invoices ─────────────
CREATE TABLE ledger_accounts (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID REFERENCES organizations(id),   -- NULL for platform accounts
  kind            TEXT NOT NULL CHECK (kind IN
                    ('available', 'held', 'receivable', 'revenue', 'funding', 'promo')),
  balance_micros  BIGINT NOT NULL DEFAULT 0,           -- credits minus debits
  version         BIGINT NOT NULL DEFAULT 0,
  UNIQUE NULLS NOT DISTINCT (org_id, kind)
);

CREATE TABLE ledger_transactions (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organizations(id),
  kind             TEXT NOT NULL CHECK (kind IN
                     ('purchase', 'grant', 'hold', 'capture', 'release', 'accrue',
                      'settle', 'adjustment', 'refund')),
  idempotency_key  TEXT NOT NULL UNIQUE,     -- e.g. 'capture:{org}:{hour}:{run_id}'
  lease_id         UUID,
  memo             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_transfers (
  id                 BIGSERIAL,
  transaction_id     BIGINT NOT NULL REFERENCES ledger_transactions(id),
  debit_account_id   BIGINT NOT NULL REFERENCES ledger_accounts(id),   -- money leaves
  credit_account_id  BIGINT NOT NULL REFERENCES ledger_accounts(id),   -- money arrives
  amount_micros      BIGINT NOT NULL CHECK (amount_micros > 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (debit_account_id <> credit_account_id),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_transfers_debit ON ledger_transfers (debit_account_id, created_at);
CREATE INDEX idx_transfers_credit ON ledger_transfers (credit_account_id, created_at);

CREATE TABLE credit_leases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  amount_micros  BIGINT NOT NULL CHECK (amount_micros > 0),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed')),
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  closed_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_one_open_lease ON credit_leases (org_id) WHERE status = 'open';

CREATE TABLE billing_close_runs (
  id           BIGSERIAL PRIMARY KEY,
  hour         TIMESTAMPTZ NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('full', 'dirty')),
  status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  events       BIGINT,
  cost_micros  BIGINT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_close_full_once ON billing_close_runs (hour)
  WHERE scope = 'full' AND status = 'succeeded';

CREATE TABLE billed_org_hours (                      -- what has been captured so far
  org_id         UUID NOT NULL,
  hour           TIMESTAMPTZ NOT NULL,
  billed_micros  BIGINT NOT NULL,
  last_run_id    BIGINT NOT NULL REFERENCES billing_close_runs(id),
  PRIMARY KEY (org_id, hour)
) PARTITION BY RANGE (hour);

CREATE TABLE invoices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id),
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL CHECK (period_end > period_start),
  status                  TEXT NOT NULL CHECK (status IN ('draft', 'finalized', 'paid', 'void')),
  subtotal_micros         BIGINT NOT NULL DEFAULT 0,
  credits_applied_micros  BIGINT NOT NULL DEFAULT 0,
  total_cents             BIGINT,                      -- rounded once, at finalization
  pdf_object_key          TEXT,
  finalized_at            TIMESTAMPTZ,
  UNIQUE (org_id, period_start)
);

CREATE TABLE invoice_line_items (
  id               BIGSERIAL PRIMARY KEY,
  invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  snapshot_id      TEXT NOT NULL,
  usage_type       TEXT NOT NULL,
  tokens           BIGINT NOT NULL,
  micros_per_mtok  BIGINT NOT NULL,
  amount_micros    BIGINT NOT NULL,
  prior_period     BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (invoice_id, snapshot_id, usage_type, micros_per_mtok, prior_period)
);

CREATE TABLE reconciliation_findings (
  id                 BIGSERIAL PRIMARY KEY,
  run_date           DATE NOT NULL,
  check_name         TEXT NOT NULL CHECK (check_name IN
                       ('completeness', 'pricing', 'ledger_balance', 'lease_drift')),
  org_id             UUID,
  expected           BIGINT NOT NULL,
  actual             BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'explained', 'adjusted')),
  adjustment_txn_id  BIGINT REFERENCES ledger_transactions(id)
);
CREATE INDEX idx_findings_open ON reconciliation_findings (run_date) WHERE status = 'open';
```

A posting function inserts a transaction and its transfers and updates both `ledger_accounts` rows in one database transaction (`version` guards concurrent updates). The `UNIQUE` on `idempotency_key` makes a re-run close or a duplicate payment webhook a no-op.

### ClickHouse (usage)

```sql
CREATE TABLE usage_events (
  event_id             UUID,
  org_id               UUID,
  project_id           UUID,
  api_key_id           UUID,
  snapshot_id          LowCardinality(String),
  pool_id              LowCardinality(String),
  region               LowCardinality(String),
  service_class        LowCardinality(String),    -- interactive | batch
  outcome              LowCardinality(String),    -- completed | client_cancelled | platform_failed
  billable             UInt8,
  input_tokens         UInt32,                    -- includes cached_input_tokens
  cached_input_tokens  UInt32,
  output_tokens        UInt32,
  event_time           DateTime64(3, 'UTC'),
  ingested_at          DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(ingested_at)          -- ReplicatedReplacingMergeTree in production
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (org_id, toStartOfHour(event_time), event_id)
TTL toDateTime(event_time) + INTERVAL 13 MONTH;

CREATE TABLE usage_hourly_estimate (
  org_id UUID, project_id UUID, api_key_id UUID,
  snapshot_id LowCardinality(String), hour DateTime('UTC'),
  requests UInt64, input_tokens UInt64, cached_input_tokens UInt64, output_tokens UInt64
) ENGINE = SummingMergeTree
ORDER BY (org_id, hour, project_id, api_key_id, snapshot_id);

CREATE MATERIALIZED VIEW usage_hourly_estimate_mv TO usage_hourly_estimate AS
SELECT org_id, project_id, api_key_id, snapshot_id, toStartOfHour(event_time) AS hour,
       count() AS requests, sum(input_tokens) AS input_tokens,
       sum(cached_input_tokens) AS cached_input_tokens, sum(output_tokens) AS output_tokens
FROM usage_events WHERE billable = 1
GROUP BY org_id, project_id, api_key_id, snapshot_id, hour;

CREATE TABLE usage_billed_hourly (
  org_id UUID, project_id UUID, api_key_id UUID,
  snapshot_id LowCardinality(String), usage_type LowCardinality(String), hour DateTime('UTC'),
  tokens UInt64, requests UInt64, price_id UInt32, cost_micros Int64, close_run_id UInt64
) ENGINE = ReplacingMergeTree(close_run_id)
ORDER BY (org_id, hour, project_id, api_key_id, snapshot_id, usage_type);
```

The materialized view sees every insert, including a duplicate that slipped past block deduplication, so `usage_hourly_estimate` can briefly over-count. Billing therefore never reads it. The close recomputes from `usage_events FINAL` for one hour's partition range, which deduplicates by `event_id`. Pricing happens per aggregated row (`tokens × micros_per_mtok / 1,000,000`, rounded half-even), never per event, so rounding error stays below one micro-dollar per row.

### Redis Key Layout (Limiter Cluster)

| Key | Type | Contents | TTL |
|-----|------|----------|-----|
| `rl:{org}:rpm:{family}` | Hash | tokens, ts | 2 min idle |
| `rl:{org}:tpm:{family}` | Hash | tokens (may be negative), ts | 2 min idle |
| `rl:{org}:tpm:p:{project}:{family}` / `rl:{org}:tpm:k:{key}:{family}` | Hash | optional sub-limit buckets | 2 min idle |
| `est:{org}:{key}:{snapshot}` | Hash | EWMA mean, variance of output tokens | 7 days |
| `spend:{org}` | Hash | lease_id, remaining_micros, budget_remaining_micros | Lease expiry |
| `res:{org}:{request_id}` | Hash | tok, cost (reserved or checkpointed) | 15 min |

The `{org}` hash tag places every key for an org on one shard, which is what makes a single atomic script possible.

## API Design

### Public Inference API (API key)

```
POST   /v1/generations              Generate (stream=true → SSE)
POST   /v1/embeddings               Embeddings (CPU pool first)
POST   /v1/tokens/count             Count tokens without generating
GET    /v1/models                   Models with lifecycle, deprecation and sunset dates
GET    /v1/models/{id}              One model or snapshot, including replacement
POST   /v1/batches                  Submit a batch-class job (24 h deadline, discounted)
```

```json
POST /v1/generations
{ "model": "model-a", "input": [{"role": "user", "content": "..."}], "max_tokens": 4096, "stream": true }

event: delta     data: {"text": "Hel"}
event: delta     data: {"text": "lo"}
event: done      data: {"id": "gen_8f2c", "snapshot": "model-a-v3", "stop_reason": "end",
                        "usage": {"input_tokens": 1000, "cached_input_tokens": 0, "output_tokens": 200}}
```

### Response Headers

| Header | Example | Meaning |
|--------|---------|---------|
| `x-request-id` | `req_01J...` | Support and log correlation |
| `x-ratelimit-limit-requests` / `-remaining-requests` / `-reset-requests` | `5000` / `4999` / `0.012` | Tightest RPM bucket; reset is seconds until full (relative, so client clock skew doesn't matter) |
| `x-ratelimit-limit-tokens` / `-remaining-tokens` / `-reset-tokens` | `800000` / `798600` / `0.105` | Tightest TPM bucket *after* this request's reservation |
| `retry-after` | `2` | On 429 and 503 |
| `idempotency-replayed` | `true` | Response served from the idempotency store |
| `x-model-snapshot` | `model-a-v3` | Which snapshot served an alias |
| `deprecation` / `sunset` / `link` | `@1798761600` / HTTP date / `rel="successor-version"` | Lifecycle signals |

### Errors

| Status | `error.type` | Retry? |
|--------|--------------|--------|
| 400 | `invalid_request`, `context_length_exceeded` | No |
| 401 | `authentication_error` | No |
| 402 | `insufficient_credits`, `spend_limit_reached` | No, until the balance or cap changes |
| 403 | `permission_denied` (scope or model allowlist) | No |
| 409 | `idempotency_in_progress` | Yes, after a delay |
| 410 | `model_retired` (body names the replacement) | No |
| 422 | `idempotency_key_reused` (different body) | No |
| 429 | `rate_limit_exceeded` with `limit_type` (requests/tokens) and `scope` (org/project/key) | Yes, after `Retry-After` |
| 503 | `overloaded` (platform capacity) | Yes, with backoff |
| 500 | `api_error` | Yes, with the same `Idempotency-Key` |

Insufficient credit uses 402, not 429, so generic retry loops don't hammer a request that cannot succeed until someone tops up.

### Console and Admin API (session auth)

```
POST   /api/v1/orgs/:org/keys                   Create key (response carries the secret once)
GET    /api/v1/orgs/:org/keys                   List keys (redacted, last used)
POST   /api/v1/orgs/:org/keys/:id/rotate        New key + scheduled revocation of the old one
DELETE /api/v1/orgs/:org/keys/:id               Revoke
GET    /api/v1/orgs/:org/usage                  ?from&to&granularity&group_by → estimate + final series
GET    /api/v1/orgs/:org/limits                 Tier, per-family limits, live utilization
PUT    /api/v1/orgs/:org/limits/:scope/:id      Customer sub-limit for a project or key
GET    /api/v1/orgs/:org/billing/balance        Available, held, month-to-date
POST   /api/v1/orgs/:org/billing/credits        Purchase credits (Idempotency-Key required)
PUT    /api/v1/orgs/:org/billing/budget         Monthly cap and alert thresholds
GET    /api/v1/orgs/:org/invoices[/:id]         Invoices and line items
GET    /api/v1/orgs/:org/deprecations           Snapshots this org still calls, with volume
PUT    /api/v1/admin/models/:snapshot/lifecycle Deprecate / sunset / retire
PUT    /api/v1/admin/aliases/:alias/routes      Traffic split weights
PUT    /api/v1/admin/orgs/:org/limits           Tier change or override
```

## Key Design Decisions

### 1. Reserve an Estimate, Reconcile the Actual

**Chosen:** reserve input tokens plus a per-key, per-snapshot high-percentile estimate of output tokens. Reconcile at completion and at 512-token checkpoints, and let buckets go into debt.

**Why:** take a Tier 3 org with 800K TPM firing 500 parallel requests (1,000 input, `max_tokens` = 4,096, actual output ≈ 200). Reserving `max_tokens` costs 5,096 tokens per request, so only 156 requests fit (156 × 5,096 = 794,976) and 344 get 429s, even though the real usage of 500 × 1,200 = 600K would have fit. With a 400-token estimate the reservation is 1,400, and all 500 fit in 700K.

**Alternative rejected (count after generation):** if only input tokens are reserved, the limiter admits a burst it cannot see. If those 500 requests each generate the full 4,096 tokens, actual usage is 2.548M tokens, 3.2× the per-minute limit. The limit stops meaning anything.

**What we give up:** bounded overshoot. In the worst case above, actual (2.548M) exceeds reserved (700K) by 1.848M tokens, and at a refill of 13,333 tokens/s the key is blocked for about 139 s while it repays the debt. Customers see this as "my limit felt stricter after a burst of long outputs", so the console explains reservations. GPU protection does not depend on this accuracy: pool-level shedding protects the replicas based on actual load.

### 2. One Atomic Script per Admission, Hash-Tagged by Org

**Chosen:** a single Lua call checks and consumes every bucket (RPM, TPM, sub-limits, spend) on one shard.

**Why:** separate calls per dimension race. Two gateways can each pass the RPM check and then fail TPM, leaving RPM charged for requests that never ran, or both pass TPM with only one request's worth of tokens left. One script on one shard also means one round trip (~1 ms) instead of four.

**What we give up:** a single huge org is pinned to one shard. At 10K RPS that org alone needs 20K script calls/s, most of one primary's 25K budget. Orgs above about 5K RPS get their budget split across N sub-buckets on different shards (see Scalability).

### 3. Bill from Deduplicated Events, Not Running Counters

**Chosen:** one immutable usage event per request, an idempotent sink (`ReplacingMergeTree` on `event_id`), and an hourly close that recomputes, prices, and posts only the *difference* from what was already billed.

**Why:** a running counter (`INCRBY` in Redis or `UPDATE ... SET tokens = tokens + n`) is not idempotent. Every replayed Kafka message adds again, and once it has been added, nobody can find the duplicate. Events with stable ids can be deduplicated, audited per request in a dispute, and recomputed after a pricing bug.

**What we give up:** billing finality lags by up to H+1h15m, and ClickHouse holds about 34 TB. Real-time spend enforcement relies on the Redis spend bucket, which is an estimate, and on reconciliation to catch where the two drift.

### 4. Prepaid Credit through Leases

**Chosen:** the ledger grants holds in chunks (leases) that Redis draws down per request. Captures post hourly from metered truth.

**Why:** a ledger write per request is 100K PostgreSQL transactions/s, all contending on a few hot rows for large orgs. Leases cut that to hundreds of transactions per second, and the request path never touches PostgreSQL.

**What we give up:** an org can overdraw by its in-flight estimation error, and the Redis spend figure is approximate until the hourly capture. If the Redis primary fails, a few milliseconds of unreplicated debits are lost, so the org can overspend by at most that. We accept a small, bounded overdraft rather than turn the ledger into the bottleneck.

### 5. Immutable Snapshots, Explicit Errors at Sunset

**Chosen:** aliases move only with notice. A sunset snapshot returns 410 with its replacement, and brownouts come first.

**Why:** silently upgrading a pinned snapshot changes outputs, output length, and therefore cost, with no deploy on the customer's side to roll back. An explicit error is loud but honest, and brownouts turn "it broke on sunset day" into "it broke for 15 minutes three months ago, and we fixed it".

**What we give up:** we keep paying for old pools until sunset, and some customers do hit errors.

### 6. Expected-Completion-Time Scheduling across Hardware Classes

**Chosen:** the router scores replicas on queue wait + prefill + decode estimates per hardware class, uses power-of-two-choices, and adds a prefix-affinity bonus.

**Why:** round-robin ignores that one 8K-token prompt costs as much prefill as 8 short ones, so queues on some replicas grow while others idle. ECT also gives one comparable number across GPU and CPU pools, which is what lets batch work spill to CPU.

**What we give up:** the router needs fresh load reports (every 100 ms per replica), and the ECT model has to be recalibrated whenever a snapshot or hardware class changes.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Client retry of a generation | Executed and billed once per `Idempotency-Key` within 24 h | KV record: `in_progress` → `completed` (response stored) or `failed` (retry allowed). Same key + different body hash → 422 |
| Gateway → replica retry | Billed once | One `request_id` per client request; failed attempts emit no billable event |
| Usage event publish | At least once | Idempotent Kafka producer + local disk spool |
| Usage event storage | Exactly-once effect | Offset-aligned batches (block dedup) + `ReplacingMergeTree(event_id)` + `FINAL` at close |
| Hourly close | Re-runnable | Recompute, then diff against `billed_org_hours`; capture key `capture:{org}:{hour}:{run_id}` only for nonzero deltas |
| Limiter reconcile | At most once | Reservation hash deleted on final reconcile |
| Lease grant | Once per request id | `ledger_transactions.idempotency_key = 'hold:{lease_id}'` |
| Credit purchase | Once | Console `Idempotency-Key` + payment provider idempotency key + unique ledger key |
| Invoice finalization | Once per org-period | `UNIQUE (org_id, period_start)` and a status transition guard |

**Client disconnect policy.** Without an idempotency key, a dropped connection cancels generation, which frees the GPU slot, and the tokens produced so far are billed as `client_cancelled`. With a key, generation runs to completion and is stored, so the client's retry is served from the store. The customer pays once and gets the full answer.

**Consistency levels.** Key revocation is eventually consistent (bounded at 60 s). Limits are strongly consistent per org on one shard. Console usage is eventually consistent (about 2 min). Billing is exact after the close, and the ledger is serializable per account.

## Security / Auth

- **API keys**: HMAC-SHA-256 with a pepper held in a KMS. Shown once. The prefix and checksum make leaks scannable. Partners such as code hosts report leaked keys to a webhook that auto-revokes them and emails the owner.
- **Scoped keys**: endpoint scopes, a model allowlist, and project binding, so a leaked key used by a CI job can only call one model, and only under its project's sub-limits.
- **Console**: session cookies (HttpOnly, Secure, SameSite=Lax) stored in Redis, CSRF tokens on mutations, step-up re-authentication for key creation and billing changes, and RBAC (`owner`, `billing_admin`, `developer`, `reader`).
- **Tenant isolation**: every console query is scoped by `org_id` from the session, never from the URL alone. ClickHouse queries go through a service that injects the `org_id` predicate.
- **Prompt privacy**: usage events contain token counts and ids only, never prompt or completion text. The idempotency store keeps response bodies for 24 h, encrypted at rest.
- **Abuse**: per-IP limits on unauthenticated endpoints, new orgs start at Tier 1 with a low monthly cap, and card fingerprint checks catch free-credit farming.

## Observability

| Metric | Type | Labels | Why |
|--------|------|--------|-----|
| `gateway_requests_total` | Counter | status, error_type, model_family | Error budget, 429 vs 503 mix |
| `gateway_overhead_seconds` | Histogram | stage (auth, reserve, route) | The 15 ms p99 budget |
| `limiter_script_seconds` | Histogram | script (reserve, reconcile), shard | Hot shard detection |
| `limiter_estimate_ratio` | Histogram | snapshot | actual_out / est_out; tunes the estimator |
| `limiter_debt_tokens` | Gauge | shard | How much overshoot is being repaid |
| `router_queue_wait_seconds` | Histogram | pool, class | Shedding trigger |
| `pool_slot_utilization` | Gauge | pool | Autoscaling and capacity planning |
| `usage_events_spooled` | Gauge | node | Kafka trouble shows here first |
| `metering_consumer_lag` | Gauge | partition | Dashboard freshness |
| `billing_close_delay_seconds` | Gauge | — | Finality SLO (H+1h15m) |
| `reconciliation_gap_ratio` | Gauge | check | Must stay < 0.0001 |
| `deprecated_snapshot_requests_total` | Counter | snapshot | Migration progress |

- **Logs**: Pino JSON with `request_id`, `org_id`, `key_id` (never the secret), snapshot, pool, and outcome. Prompts are never logged.
- **Tracing**: OpenTelemetry spans for gateway stages → router → replica, sampled at 1% plus every error.
- **Alerts**: reconciliation gap > 0.01%; spool non-empty for > 2 min; close delay > 30 min; 503 rate > 1% for any interactive pool; any limiter shard over 80% CPU.

## Failure Handling

| Failure | Behavior | Rationale |
|---------|----------|-----------|
| Limiter shard down | Opossum breaker opens. That shard's orgs get a local per-node limiter (limit ÷ node count) for RPM/TPM, and spend checks use the gateway's cached view of the lease | Fail-open would let one org flood GPUs; fail-closed would take down every org on that shard |
| Kafka unavailable | Events go to the local spool (fsync per batch) and replay in order on recovery | A response was already sent, so the event must survive |
| Spool disk full | Stop admitting new requests on that node (health check fails) and the LB drains it | Serving unbillable traffic is a revenue leak with no ceiling |
| ClickHouse down | Kafka retains 7 days. Dashboards show a stale banner and the close waits | Billing finality slips but nothing is lost |
| PostgreSQL down | Gateways serve from cached keys and config. Key creation and lease grants fail, and gateways extend existing leases by one lease size of grace | Inference stays up and the credit risk is bounded |
| Replica dies before the first token | Retry once on another replica with the same reservation | The client sees only extra latency |
| Replica dies mid-stream | SSE `error` event, reconcile, `platform_failed` (not billed) | Can't resume sampling on another replica without visible discontinuity |
| Pool saturated | 503 `overloaded`, shedding batch then free trial then paid | Protects interactive latency for paying traffic |
| Gateway crash | Clients reconnect. Reservations expire after 15 min, and keyed requests replay from the store | Stateless nodes, bounded leakage |

Retries use exponential backoff with full jitter and a retry budget (≤ 10% extra load) so retries cannot amplify an outage.

## Scalability Considerations

### Horizontal Scaling Path

1. **Gateways**: stateless; scale on CPU and open streams. 40 nodes per region at 100K RPS.
2. **Limiter**: Redis Cluster sharded by `{org_id}`; 8 primaries at peak, add shards as script calls grow.
3. **Model pools**: autoscale per pool on slot utilization and queue wait. GPU capacity is reserved ahead, so autoscaling mostly moves capacity between pools of the same hardware.
4. **Kafka**: 64 partitions keyed by org. Raising partitions remaps keys, which is fine because the close does not depend on per-org ordering.
5. **ClickHouse**: shard by `org_id` and replicate ×2. Hourly closes read one hour's partition range per shard in parallel.
6. **PostgreSQL**: config is small. The ledger is partitioned by month and can be sharded by `org_id` later, because transfers never cross orgs except into platform accounts. Those are split into N sub-accounts to avoid a hot row.

### What Breaks First

1. **GPU capacity**, always. The design's answer is to keep it busy with the right work: shedding by class, batch spill to CPU, prefix affinity, and per-org limits that track real capacity per tier.
2. **A hot org on one limiter shard.** An org at 10K RPS needs 20K script calls/s on one shard. Split its budget into N sub-buckets on N shards (`{org_id:0..N-1}`), route each request to a sub-bucket by `hash(request_id)`, and rebalance unused budget between sub-buckets every second. Accuracy drops slightly, but throughput scales with N.
3. **Hot Kafka partition** for the same org: switch its partition key to `(org_id, request_id mod 8)`.
4. **Close duration** if one hour's `FINAL` scan grows past about 20 minutes: run the close per ClickHouse shard in parallel, or pre-deduplicate in the writer with a short-window seen-set per partition.

### Multi-Region and Data-Center Loss

- Each region runs its own gateways, limiter cluster, pools, and Kafka. An org's limit is split across regions in proportion to its last 10 minutes of traffic, and a rebalancer moves budget every 60 s.
- When a region fails, DNS and anycast move clients to other regions within about 1 minute. The rebalancer gives the dead region's share to the survivors. GPU capacity is not provisioned N+1 per region (too expensive), so batch and free-trial traffic are shed first.
- Usage events are mirrored to the billing region with seconds of lag. A region lost with an unmirrored backlog under-bills; it never double-bills. Replica-side token counters in the surviving telemetry bound the loss.

### 10× Growth (1M RPS)

20,000 replicas (160,000 GPUs), 400 gateway nodes, 2M script calls/s (80 limiter primaries), 200 MB/s into Kafka, and 8.6 TB/day of raw events. Only the GPU fleet is a hard problem. Everything else is more of the same.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Output-token limiting | Reserve estimate, reconcile, allow debt | Reserve `max_tokens` / count after | Burst concurrency 4× higher than max_tokens, overshoot bounded |
| Limit atomicity | One Lua call, `{org}` hash tag | One call per dimension | No partial charges, one round trip |
| Limiter failure | Local per-node fallback limits | Fail-open / fail-closed | GPUs are the scarce resource |
| Metering source | Per-request immutable events | Running counters | Deduplicable, auditable, recomputable |
| Event dedupe | ReplacingMergeTree + FINAL at close | Global seen-set | 4.32B ids/day is too big for a seen-set |
| Prepaid enforcement | Ledger leases drawn in Redis | Ledger write per request | Hundreds of TPS instead of 100K |
| Billing finality | Hourly close with diff | Streaming capture | Idempotent re-runs, late events handled |
| Insufficient credit | 402 | 429 | Retry loops don't hammer it |
| Model versions | Immutable snapshots + 410 at sunset | Silent auto-upgrade | Behavior and cost changes stay explicit |
| Scheduling | ECT + P2C + prefix affinity | Round-robin | Prompt sizes vary by 100× |
| Platform failures | Not billed | Bill delivered tokens | Simple, customer-trusting, cost is small |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local build, which maps the production design onto Docker + Node.js/Express + TypeScript and React 19 + Vite + TanStack Router + Zustand + Tailwind. Paths below are planned, not existing files.

### Planned Local Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Local machine                                                            │
│                                                                          │
│  ┌───────────────┐   ┌──────────────────────────┐   ┌──────────────────┐ │
│  │ Console SPA   │──▶│ Gateway + Console API    │──▶│ model-sim :3001  │ │
│  │ Vite :5173    │   │ Express :3000            │──▶│ model-sim :3002  │ │
│  └───────────────┘   │ /v1/* and /api/v1/*      │──▶│ model-sim :3003  │ │
│                      └──┬────────┬────────┬─────┘   └──────────────────┘ │
│                         │        │        │                              │
│                ┌────────▼──┐ ┌───▼────┐ ┌─▼───────────┐                  │
│                │ Valkey    │ │ Postgres│ │ Kafka :9092 │                  │
│                │ :6379     │ │ :5432   │ │ (KRaft)     │                  │
│                └───────────┘ └───▲─────┘ └──┬──────────┘                  │
│                                  │          ▼                            │
│                       ┌──────────┴──────────────────────┐                │
│                       │ metering-worker → ClickHouse    │                │
│                       │ :8123; billing-worker (close,   │                │
│                       │ invoices, reconciliation)       │                │
│                       └─────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────────────────┘
```

Planned simulated pools: `:3001` serves `model-a-v2` (deprecated, GPU class), `:3002` serves `model-a-v3` (GA, GPU class), and `:3003` serves `model-b-v1` on the "CPU" class (slower tokens/s). Each simulator has configurable slots, tokens/s, an output-length distribution, and a failure-injection endpoint (`POST /admin/fail?mode=before_first_token|mid_stream`). Setting `MODEL_BACKEND_URL` swaps in a real model API. The simulated GPU workers from the planned LLM Inference Batching project can replace them later.

### Production-Grade Patterns Planned

| Pattern | Planned location | Why it matters at scale |
|---------|------------------|-------------------------|
| Reserve/reconcile Lua scripts | `backend/src/shared/limiter/` (planned) | The core of two-dimensional limiting; atomic across gateway instances |
| Idempotency | `backend/src/shared/idempotency.ts` (planned) | Client retries billed once; replays served from Redis with 24 h TTL |
| Circuit breakers (Opossum) | `backend/src/shared/circuit-breaker.ts` (planned) | Around Redis, each model-sim, and Kafka; trips to the local fallback limiter, the next replica, or the spool |
| Prometheus metrics (prom-client) | `backend/src/shared/metrics.ts` (planned) | Overhead histograms, estimate ratio, consumer lag, reconciliation gap |
| Structured logging (Pino) | `backend/src/shared/logger.ts` (planned) | request_id / org_id / key_id on every line; key secrets redacted |
| Health checks | `/health/live`, `/health/ready` (planned) | Ready fails when the spool exceeds its cap, so the LB drains the node |
| Rate limiting | The limiter itself, plus per-IP limits on console login | Same Lua bucket code path |

A brief sketch of how the gateway will call the reserve script:

```typescript
// planned: backend/src/gateway/admission.ts
const result = await limiterBreaker.fire(() =>
  redis.evalsha(RESERVE_SHA, keys(orgId, keyId, family, snapshot, requestId),
    [inputTokens, maxTokens, priceIn, priceOut]))
if (result.kind === 'deny') return reply429(res, result.limit, result.retryAfter)
if (result.kind === 'need_lease') await billing.requestLease(orgId) // then retry once
```

### Planned Simplifications

| Production | Local substitute |
|------------|------------------|
| 2,000 GPU replicas | 3 model simulators emitting fake tokens at 20–80 tok/s |
| Redis Cluster, 8 primaries | One Valkey; hash tags kept so the scripts stay cluster-safe |
| Idempotency KV (432 GB) | The same Valkey, 24 h TTL |
| Kafka, 64 partitions, RF 3 | One KRaft broker, 4 partitions, RF 1 |
| ClickHouse cluster | One ClickHouse node with plain ReplacingMergeTree |
| Hourly close at H+1h15m | Close every 60 s with a 15 s grace (env `BILLING_CLOSE_INTERVAL_SEC`) |
| Exact per-snapshot tokenizer | ≈ 4 characters per token behind a `Tokenizer` interface |
| Payment provider | A stub that approves charges and sends signed webhooks |
| Secret-scanning partner | A script that posts a "leaked key" webhook |
| SSO for admins | Session auth with an `admin` role |

### What Is Omitted

- Multi-region budget splitting, region failover, and cross-region event mirroring
- Real GPU scheduling internals (continuous batching, KV-cache-aware placement), which belong to the batching project
- Kubernetes, autoscaling, and reserved-capacity planning
- Tax, multi-currency, and dunning for failed invoice payments
- Hot-org sub-bucket splitting (documented above; one local Valkey makes it unobservable)
- Fine-tuning, files, and batch-job storage beyond a simulated queue

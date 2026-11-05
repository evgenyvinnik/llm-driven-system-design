# Storage Misconfiguration Remediation - Architecture

## System Overview

An enterprise has tens of thousands of cloud storage accounts spread over thousands of subscriptions. A large share carry insecure settings: anonymous blob access allowed, shared-key and SAS authorization allowed, TLS below 1.2 accepted, network access open to the internet, no blob soft delete, no diagnostic logs. The system finds those settings, works out which ones can be changed without breaking a caller, changes them in controlled waves, proves each change did no harm or undoes it automatically, and then switches on prevention so the fleet does not regress.

The prompt is Azure-shaped (Resource Graph, Azure Policy, ARM throttling, StorageBlobLogs, Entra ID) because that is the platform the review practice targets. The design is portable: inventory, evaluation, evidence, campaigns and prevention map onto AWS Config, S3 Block Public Access, CloudTrail and SCPs with different names.

**"Storage remediation" can mean several kinds of work.** Security configuration (this project), data protection (soft delete, versioning, immutability), resilience (LRS to ZRS or GRS), migration (classic to ARM, region moves), performance or cost (tiering, lifecycle rules). The machinery below (inventory, evidence, waves, verification, rollback, prevention) applies to all of them. What changes is what counts as evidence and what counts as a regression signal. A presenter should say which kind they mean in the first minute.

Learning goals:

- Impact analysis from access logs, and why "no logs" is not "no usage"
- Safe rollout at fleet scale: rings, canaries, bake time, failure budgets, automatic rollback
- Idempotent, crash-safe execution against a throttled, eventually consistent control plane
- Detect-and-remediate versus prevent-at-creation, and the order to do them in
- Exceptions as time-boxed risk acceptance, and an audit trail that satisfies compliance

## Requirements

### Functional Requirements

1. **Inventory** every storage account across management groups and subscriptions, with tags (owner, environment, data classification), account properties and the child resources that matter (blob service soft delete, diagnostic settings).
2. **Evaluate** each account against versioned controls, producing a finding per account per failing control, with severity and a risk score.
3. **Analyze impact** for controls that can break callers: from the last N days of access logs, classify each finding as safe to fix now, needs owner migration (with the callers named), or insufficient evidence.
4. **Remediate** through campaigns: one control, a scope, a wave plan (non-production first, canaries, growth), a bake period and a failure budget. Start, pause, resume and kill. Live progress.
5. **Verify and roll back**: after each change, re-read the property and watch authorization failures for the bake period; roll back automatically on a real regression.
6. **Exceptions**: risk acceptance with owner, justification, an approver who is not the requester, and an expiry after which the finding reopens.
7. **Owner workflow**: notifications with deadlines by severity, self-service "fix it now" and "request exception", escalation when overdue.
8. **Prevention**: once a control is burned down, switch its Azure Policy effect from audit to deny or modify (or deployIfNotExists for additive settings) so new resources cannot regress.
9. **Audit** every change: who, what, when, value before and after, and why.

### Non-Functional Requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Safety | Zero unplanned outages caused by remediation; any regression detected and rolled back within one bake check (minutes, not days) | Evidence before change, bake-time signals, automatic rollback that can't be blocked by the campaign's own state |
| Blast radius | No more than the canary (1-5% of a ring) exposed to an unproven change | Rings and canaries; one breaking change per account at a time so a regression can be attributed |
| Inventory freshness | Config changes visible within 5 minutes p95; full reconciliation daily | Change feed plus periodic full scans; a version guard against stale reads |
| Correctness under failure | No double-apply; no rollback to a wrong value; resume after a crash within one lease (≤ 1 minute) | Durable intent before every write, leases with fences, desired-state writes with If-Match |
| Platform limits | Under 1% of control-plane calls answered 429; never exceed a subscription's write budget | Per-subscription token buckets shared by all workers, Retry-After honored, adaptive slow-down |
| Dashboard | p95 under 2 s; every number labelled with its as-of time and definition | Precomputed snapshots; freshness metadata |
| Audit | 100% of changes with before and after values, kept for 7 years, tamper-evident | Append-only log written in the same transaction as the state change, mirrored to immutable storage |
| Exceptions | 100% have an expiry; findings reopen within one workflow cycle of expiry | A sweeper, not a human, flips exceptions to expired |
| Availability of this system | 99.9% | It is not in any application's data path; downtime delays remediation, it doesn't break apps |

## Capacity Estimation

### Production Scale (illustrative assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Storage accounts | 40,000 | Assumed fleet: 2,000 subscriptions × 20 accounts |
| Subscriptions / owning teams | 2,000 / ~1,200 | Owner tag on the account, falling back to the subscription owner |
| Initial findings | ~110,000 | 2.8 failing controls per account (the simulated fleet's measured mix) × 40,000 |
| Full inventory scan | ~40 Resource Graph pages | 1,000 rows per page; Resource Graph allows about 15 queries per 5 s per user |
| Child-resource reads | ~80,000 GETs per full refresh | Soft delete and diagnostic settings aren't in the main Resource Graph table; spread over a day under read limits |
| Config change events | ~2,000 per day + our own writes | 5% daily churn, each re-read from ARM |
| Evidence queries | ~200 Log Analytics queries per evidence pass | 200 accounts per query; per-user query limits are the constraint, not compute |
| Log volume if every account logged every read | ~20 TB/day | 500,000 requests/day/account × ~1 KB per log record × 40,000. This is why evidence is tiered (below) |
| Remediation writes per control | ~5,000-15,000 | Only accounts classified safe to fix, in the first pass |
| Wall clock per control | ~1-2 weeks | Dominated by bake windows: ~8 waves × 24 h bake, not by write throughput (~6,000 writes take under an hour at 2 writes/s) |

The numbers say where the hard parts are. Write throughput is easy. Bake time dominates the schedule, the cost of evidence dominates the budget, and the number of owners who have to migrate callers (~22% of breaking findings in the simulated mix) dominates the long tail.

### Local Development Scale

| Quantity | Value |
|----------|-------|
| Simulated accounts / subscriptions | 1,500 / 50 (FLEET_ACCOUNTS, FLEET_SUBSCRIPTIONS) |
| Open findings after seeding | 4,176 (2,273 safe to fix, 936 needs owner migration, 965 insufficient evidence) |
| Full scan (Resource Graph pages + evaluation) | ~0.4 s |
| Bake period | 10-20 s instead of 24 h; metrics in 5-second buckets instead of 1 minute |
| Simulated write limit per subscription | 4-token burst, 0.5 writes/s (tightened to 2 / 0.25 for throttling demos) |

## High-Level Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │  Web UI: posture · findings · campaigns ·    │
                         │  exceptions · controls · audit               │
                         └───────────────┬──────────────────────────────┘
                                         │ REST + SSE (campaign progress)
                         ┌───────────────▼──────────────────────────────┐
                         │  API (stateless, Entra SSO, role + scope)    │
                         └───┬───────────────┬──────────────────┬───────┘
                             │               │                  │
          ┌──────────────────▼───┐   ┌───────▼────────┐  ┌──────▼──────────────┐
          │ PostgreSQL           │   │ Redis/Valkey   │  │ Service Bus         │
          │ inventory · findings │   │ token buckets  │  │ task queue          │
          │ evidence · campaigns │   │ live events    │  │ (sessions per sub)  │
          │ step state · audit   │   │ sessions       │  │ change-event topic  │
          └──▲────▲─────▲────▲───┘   └──▲─────▲───────┘  └──▲─────▲─────▲──────┘
             │    │     │    │          │     │             │     │     │
   ┌─────────┴┐ ┌─┴─────┴──┐ │   ┌──────┴─────┴──────┐      │     │     │
   │ Scanners │ │ Evidence │ │   │ Executor workers  │◀─────┘     │     │
   │ sharded  │ │ workers  │ │   │ claim · re-read · │            │     │
   │ by sub   │ │          │ │   │ intent · If-Match │            │     │
   └────┬─────┘ └────┬─────┘ │   │ write · bake ·    │            │     │
        │            │       │   │ rollback          │            │     │
        │            │  ┌────┴───┴──────┐            │            │     │
        │            │  │ Planner /     │  Change    │            │     │
        │            │  │ coordinator / │  consumers ┼────────────┘     │
        │            │  │ owner workflow│  re-read ARM                  │
        │            │  └───────────────┘     │                         │
        ▼            ▼                        ▼                         │
┌──────────────────────────────────────────────────────────────────────┴──┐
│ Azure                                                                    │
│ Resource Graph ─ ARM / Storage RP (GET, PATCH If-Match, 429 Retry-After) │
│ Event Grid subscription events ─ Azure Policy (audit/deny/modify/DINE,   │
│ exemptions) ─ Azure Monitor metrics (Transactions by Authentication)     │
│ ─ Log Analytics (StorageBlobLogs: AuthenticationType, TlsVersion, IP)    │
└──────────────────────────────────────────────────────────────────────────┘
```

Two planes are drawn as one box at the bottom but behave differently. Management-plane calls (Resource Graph, ARM, the Storage resource provider, Azure Policy) are limited per subscription, per tenant and per principal. Data-adjacent calls (Log Analytics queries, Azure Monitor metrics, and any blob reads) have separate quotas and a separate bottleneck. Inventory and execution spend the management budget; evidence spends the data budget. They get separate workers, separate concurrency limits and separate back-off, so an expensive evidence pass never starves the executor's writes, and vice versa.

## Core Components

### 1. Inventory (scanners and change consumers)

- **Full scan**, daily and on demand: Resource Graph queries scoped to a shard of subscriptions (hash of subscription ID), paged with `$skipToken` at 1,000 rows. Rows are upserted with a **version guard**: keep whichever observation has the newer `systemData.lastModifiedAt`, regardless of arrival order. Resource Graph lags ARM, so a page can carry an older version than one the change path just wrote; the guard skips it. Locally a forced scan right after a change skipped exactly that row (`staleSkipped: 1`) and kept the fresher ARM read.
- **Child resources**: soft delete (`blobServices/default`) and diagnostic settings are not in the main Resource Graph table, so they are read with ARM GETs on a slower cadence, within the read budget.
- **Change consumers**: subscription events (Event Grid `ResourceWriteSuccess`) land on a Service Bus topic. Each event is a hint, not data: the consumer re-reads the resource from ARM (consistent for reads after writes) and upserts. Processing is at least once; the cursor advances only past events that were fully handled. If the feed's retention no longer covers the cursor, the consumer records the latest position, runs a full scan, then resumes.
- **Deletion** is inferred conservatively: an account missing from a full scan is marked deleted only if we last saw it well before the scan started, because Resource Graph may not show a just-created account yet.

### 2. Evaluation

Controls are versioned rules in code (`domain/controls.ts`). Each declares the resource kind it reads, how to read and judge the value, whether turning it on can break callers, which usage signal reveals a dependency, the body that makes the resource compliant, and the body that restores a previous value.

| Control | Property | Breaking? | Dependency signal | Policy effects |
|---------|----------|-----------|-------------------|----------------|
| SA-01 Disallow anonymous blob access | `allowBlobPublicAccess = false` | Yes | Anonymous requests | audit, deny, modify |
| SA-02 Disable shared key authorization | `allowSharedKeyAccess = false` | Yes | AccountKey + SAS requests | audit, deny, modify |
| SA-03 Require TLS 1.2 | `minimumTlsVersion = TLS1_2` | Yes | Requests with TlsVersion 1.0/1.1 | audit, deny, modify |
| SA-04 Secure transfer | `supportsHttpsTrafficOnly = true` | Yes | Requests over HTTP | audit, deny, modify |
| SA-05 Restrict network access | `publicNetworkAccess = Disabled` or `networkAcls.defaultAction = Deny` | Yes | Requests from public IPs | audit, deny |
| SA-06 Blob soft delete ≥ 7 days | `deleteRetentionPolicy` | No (cost only) | — | audit, deployIfNotExists |
| SA-07 Diagnostic logs to the central workspace | diagnostic setting | No (cost only) | — | auditIfNotExists, deployIfNotExists |

Findings record the control version that produced them, so a rule change never silently rewrites history. Severity is escalated in context: public access on data tagged confidential or restricted is critical. Risk is `severity × internet exposure × data classification × usage`, where an insecure path in active use scores highest. Risk orders the owner queue and the choice of which campaign to run next. It does not order waves; blast radius does.

In production the evaluation is cross-checked against Azure Policy compliance state for the same controls. The two should agree; a disagreement means a rule bug or a stale read and is itself a finding.

### 3. Impact analysis (evidence)

For every account with an open finding on a breaking control, the evidence worker reads its usage and classifies the finding:

| Class | Rule |
|-------|------|
| needs owner migration | At least one request in the window would fail after the change. The callers (IP, user agent, auth type, `AuthenticationHash` for keys and SAS) are named so the owner knows what to migrate |
| insufficient evidence | No diagnostic setting, or logging started less than 14 days ago. Absence of logs is never treated as absence of usage |
| safe to fix | A full window of logs, and nothing in it depends on the insecure setting |

Evidence is tiered in production because full logs everywhere cost about 20 TB a day:

1. **Platform metrics first.** Storage `Transactions` split by the `Authentication` dimension are free, kept 93 days and need no diagnostic setting. They answer "is shared key or anonymous used at all" for every account, including those with no logs.
2. **Logs for attribution.** StorageBlobLogs in Log Analytics give the caller, TLS version, protocol and IP. They are needed only where metrics show a dependency, or for the controls metrics can't see (TLS, network source).
3. **Temporary logging.** Accounts with no logs get SA-07 first (it is additive and safe), then wait a full window before any breaking change. Turning on diagnostics is both the safest change and the prerequisite for evidence on every other control, so it goes first.

The lookback window has to cover the longest business cycle a caller might have. Thirty days misses quarterly jobs (the incident in [existing-system-review.md](./existing-system-review.md)); metrics at 93 days catch them for auth type.

### 4. Owner workflow and exceptions

- Findings needing the owner (migration or missing evidence) produce **one digest per team and control per day**, not one message per finding, with the earliest due date. SLA by severity: critical 7 days, high 30, medium 60, low 90.
- Overdue findings **escalate** to security and approvers. Accounts with no owner tag fall back to the subscription owner and are flagged.
- **Self-service fix** runs through the same executor path as any campaign (a one-account campaign), so an owner's fix gets the same intent record, If-Match write, bake and rollback.
- **Exceptions**: requested by the owner with a justification and a duration capped by severity (critical 30 days, high 90, medium 180), decided by an approver who is not the requester, and always expiring. Approval flips the finding to exempt in the same transaction. A sweeper flips expired exceptions and reopens the finding, then tells the owner. In production each exception is mirrored as an Azure Policy exemption with the same `expiresOn`, so deny policies don't block an excepted account.

### 5. Campaign planner

A campaign is one control, a scope (environments, subscriptions, owners), the evidence classes it includes (default: safe to fix only), and a wave plan:

- **Rings**: all non-production waves before any production wave.
- **Canary per ring**: `canaryPercent` of the ring, picked round-robin across subscriptions so the canary touches many subscriptions lightly.
- **Growth**: each later wave is `growthFactor` times the previous, capped at `maxWaveSize`.
- **Order inside a ring**: quietest accounts first (requests per minute from evidence). Blast radius, not security risk, decides rollout order.
- **Exclusions** with reasons: exceptions, evidence classes not included, accounts already in another active campaign for the same control.

The target list is frozen at creation, which is the plan a human approved. Everything that may have changed since is re-checked at execution time.

### 6. Executor

Workers take target IDs from a queue (Service Bus with sessions keyed by subscription in production; a Valkey stream with a consumer group locally). The queue only says "look at target N"; PostgreSQL decides whether there is anything to do. For each target:

1. **Claim** with a lease and a fence (a counter incremented on every claim). Every later update matches `(id, fence, expected state)`, so a duplicate message, a second executor or a worker whose lease expired changes nothing.
2. **Check the campaign** (paused: release; killed: cancel) and whether an exception was approved since planning.
3. **Take a write token** for the subscription from a token bucket shared by all workers, honoring any block set by a recent 429.
4. **Re-read the resource from ARM** and revalidate. The scan snapshot may be hours old. If the account moved from dev to prod since planning: escalate. If a caller appeared and the evidence class changed: skip, and the owner workflow takes it. If someone else already fixed it: skip.
5. **Record intent durably before writing**: the before-value, the etag, the account's authorization-failure baseline, and an operation ID.
6. **Write with If-Match** on the etag just read, sending the operation ID as `x-ms-client-request-id`:
   - 200: record applied, start the bake.
   - 412 (the resource changed after our read): re-read and decide again. Fixed by someone else: skip. An unrelated property changed: recompute the write against the new etag. Our property changed to a different insecure value (TLS1_0 to TLS1_1): escalate rather than fight another writer. Three conflicts in a row: escalate.
   - 429: block the subscription for Retry-After for every worker, halve its rate, and defer with growing back-off. Bounded: after 12 throttles the target fails and counts against the wave budget.
   - 5xx or no response: the outcome is unknown. Re-read before any retry. If the desired value is there, record it as applied (`confirmed_after_5xx` or `confirmed_after_timeout`); if not, retry with exponential back-off, longer while the subscription is also throttling, at most 5 times.
   - 403 (policy deny, or a resource lock): fail with the reason; never remove locks automatically.
7. If intent exists from an earlier attempt and the resource is already compliant, that attempt's write landed before a crash: record it as `recovered` without writing again.

### 7. Verifier and rollback

During the bake period each applied target is checked repeatedly:

1. Re-read the property. If it no longer has the desired value, someone reverted it: fail the target as drift.
2. Compare authorization failures since the change with the baseline captured before it. Roll back only if all three hold: at least 5 failures, a rate above 3× the baseline, and at least 2% of requests. One stray 403 on a busy account, or failures that predate the change, don't trigger a rollback.
3. When the bake period passes cleanly, the target is verified.

Rollback writes the before-value recorded at intent time (never a value read later), with If-Match, and is idempotent: if the account already has the original value, nothing is written. A campaign pause or kill never pauses rollbacks. Rollback is bounded too: after three failed rounds it pages a human with the value to restore. If a deny policy is already in force, it blocks the rollback (policy applies to every writer); the target fails loudly so someone adds a policy exemption.

A rollback also marks the account's evidence stale. The failed run is now in the logs, so the next evidence pass reclassifies the account as needs owner migration and the owner is notified with the caller named.

### 8. Coordinator and failure budget

Per running campaign (row-locked with `SKIP LOCKED`, so one coordinator per campaign at a time): when no unfinished wave remains, complete it. When the current wave's failures (rolled back plus failed, minus any a human already acknowledged) exceed `maxFailuresPerWave`, pause the campaign, halt the wave and notify security. When the wave is pending, start it and enqueue its targets. When every target in the wave is terminal, complete the wave; the next starts on the next tick. Resuming a paused campaign records the failures the human has seen, so only new ones count.

A reconciler re-sends anything the queue may have lost: claims whose lease expired go back to queued (keeping their recorded intent), and queued targets nobody picked up are re-enqueued.

### 9. Prevention

Each control maps to an Azure Policy definition. The order matters:

1. **Additive controls** (soft delete, diagnostics) can be enforced on creation at any time with `deployIfNotExists`. They break nothing.
2. **Breaking controls stay on audit until burned down.** A deny assignment evaluates create and update requests, so a team's routine redeploy of an old template that still sets the insecure value is rejected, and so is our own rollback. The API refuses to switch a control to deny below 95% compliance unless forced.
3. **modify** can fix new resources on creation without rejecting them, a softer way to stop the bleeding before burn-down for controls where the insecure value is a template default nobody relies on yet (public access on brand-new accounts).

## Request Flows

### Successful trace: one account in wave 2 of the shared-key campaign

1. Alice creates "Disable shared key (non-prod)" with an Idempotency-Key. The API plans 255 accounts in 3 waves (13, 52, 190), excluding 227 needing migration, 288 with insufficient evidence and 1 exception, and commits campaign, waves and targets in one transaction.
2. She starts it. The coordinator sees wave 1 pending, marks its targets queued and enqueues them after commit; when wave 1 is terminal it starts wave 2.
3. A worker reads a wave-2 target's message and claims it: state `queued → applying`, fence 1, lease 15 s.
4. The campaign is running and no exception exists. The worker takes a token from the subscription's bucket.
5. GET the account from ARM: `allowSharedKeyAccess: true`, etag `"0002…"`, env tag `test` (still the planned ring), evidence still safe to fix.
6. Measure the baseline (0 authorization failures in the last 60 s), then record intent: before-value `true`, etag, baseline, operation ID `rem-<campaign>-<target>-f1-a0`.
7. PATCH `allowSharedKeyAccess: false` with If-Match `"0002…"`: 200, new etag.
8. Record applied: state `baking`, bake until +20 s, audit `remediation.applied` (before `true`, after `false`), event `target.applied` to the live stream.
9. The scanner's change consumer sees the update, re-reads ARM, upserts the account and resolves the finding.
10. The verifier checks every 2 s: the property is still `false`, 0 authorization failures. At +20 s the target is verified and audited.
11. When all 52 targets of wave 2 are terminal and failures are within budget, the wave completes and wave 3 starts.

### Failed trace: the quarter-end job the logs couldn't see

1. Account `stmobilemediw9i0jo` (test) has a batch job that authenticates with the account key, last ran 45 days ago. The 30-day log window shows only OAuth traffic, so the finding is safe to fix and lands in the canary.
2. Steps 3-8 above run normally: intent recorded, PATCH succeeds at 18:27:48.
3. The job runs during the bake (the simulator compresses a quarter into the bake window). Its requests now fail with 403.
4. At 18:28:00 the verifier sees 7 authorization failures since the change, 36 per minute against a baseline of 0, 100% of that caller's requests. All three conditions hold.
5. In one transaction: state `baking → rolling_back`, the rollback reason, evidence marked stale, audit `remediation.rollback_triggered`, notifications to the owning team and to security.
6. Take a token (inline: rollbacks have priority), GET the current etag, PATCH `allowSharedKeyAccess: true` (the recorded before-value) with If-Match: 200 at 18:28:00.34. State `rolled_back`, audit `remediation.rolled_back`.
7. The scanner reopens the finding (`finding.reopened`). The next evidence pass sees the job's AccountKey requests and reclassifies the finding as needs owner migration; the team's digest names the caller.
8. Wave 1 has 1 failure against a budget of 1, so it continues. Wave 2 later hits the two other planted jobs: 2 failures exceed the budget and the campaign pauses itself with the reason. Alice reviews, resumes, and the campaign completes: 252 verified, 3 rolled back.

## Database Schema

PostgreSQL is the source of truth for everything the remediation system decides. Full schema: [`backend/src/db/init.sql`](./backend/src/db/init.sql). The tables that carry the hard guarantees:

```sql
-- Inventory: one row per account; properties_modified_at is the version guard.
CREATE TABLE storage_accounts (
  id                       TEXT PRIMARY KEY,           -- ARM resource ID
  subscription_id          TEXT NOT NULL,
  name                     TEXT NOT NULL UNIQUE,        -- storage account names are globally unique
  tags                     JSONB NOT NULL DEFAULT '{}',
  owner                    TEXT,                        -- owner tag, else subscription owner
  owner_source             TEXT NOT NULL DEFAULT 'tag', -- 'tag' | 'subscription'
  environment              TEXT NOT NULL,
  data_classification      TEXT,
  properties               JSONB NOT NULL,
  properties_modified_at   TIMESTAMPTZ NOT NULL,
  blob_service             JSONB,                       -- NULL until read
  diagnostics              JSONB,
  observed_via             TEXT NOT NULL,               -- graph | arm | event
  observed_at              TIMESTAMPTZ NOT NULL,
  traffic_per_min          NUMERIC NOT NULL DEFAULT 0,
  deleted_at               TIMESTAMPTZ
);

-- Only failures (and resolved history) are stored; compliance = evaluated - open - exempt.
CREATE TABLE findings (
  id              BIGSERIAL PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES storage_accounts(id),
  control_id      TEXT NOT NULL REFERENCES controls(id),
  control_version INT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'exempt')),
  severity        TEXT NOT NULL,
  risk_score      INT NOT NULL DEFAULT 0,
  evidence_class  TEXT CHECK (evidence_class IN ('safe_to_fix', 'needs_owner_migration', 'insufficient_evidence')),
  evidence_reason TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  reopened_count  INT NOT NULL DEFAULT 0,
  due_at          TIMESTAMPTZ,
  UNIQUE (account_id, control_id)
);
CREATE INDEX findings_control_status_idx ON findings (control_id, status);

-- Durable step state: intent is written before the cloud is touched.
CREATE TABLE campaign_targets (
  id              BIGSERIAL PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL REFERENCES storage_accounts(id),
  subscription_id TEXT NOT NULL,
  wave_no         INT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'applying', 'baking', 'rolling_back',
                    'verified', 'rolled_back', 'skipped', 'escalated', 'failed', 'cancelled')),
  attempts        INT NOT NULL DEFAULT 0,   -- 5xx and timeouts, bounded
  throttle_count  INT NOT NULL DEFAULT 0,   -- 429s, bounded separately
  fence           BIGINT NOT NULL DEFAULT 0,
  claimed_by      TEXT,
  lease_until     TIMESTAMPTZ,
  not_before      TIMESTAMPTZ,
  enqueued_at     TIMESTAMPTZ,
  operation_id    TEXT,                     -- sent as x-ms-client-request-id
  before_value    JSONB,                    -- set once, never overwritten
  etag_before     TEXT,
  after_value     JSONB,
  etag_after      TEXT,
  write_outcome   TEXT,                     -- written | recovered | confirmed_after_5xx | confirmed_after_timeout
  baseline        JSONB,                    -- auth-failure baseline before the write
  applied_at      TIMESTAMPTZ,
  bake_until      TIMESTAMPTZ,
  rollback_reason TEXT,
  last_error      TEXT,
  UNIQUE (campaign_id, account_id)
);
CREATE INDEX campaign_targets_active_idx ON campaign_targets (state, lease_until)
  WHERE state IN ('queued', 'applying', 'baking', 'rolling_back');

CREATE TABLE exceptions (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES storage_accounts(id),
  control_id     TEXT NOT NULL REFERENCES controls(id),
  status         TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'revoked')),
  justification  TEXT NOT NULL,
  requested_by   TEXT NOT NULL REFERENCES users(id),
  requested_days INT NOT NULL,
  decided_by     TEXT REFERENCES users(id),
  expires_at     TIMESTAMPTZ
);
-- At most one live exception per account and control.
CREATE UNIQUE INDEX exceptions_one_live_idx ON exceptions (account_id, control_id)
  WHERE status IN ('pending', 'approved');

-- Append-only: a trigger rejects UPDATE and DELETE.
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,     -- user:alice | service:executor-1
  action      TEXT NOT NULL,     -- remediation.applied, remediation.rolled_back, exception.approved, policy.changed, ...
  account_id  TEXT,
  control_id  TEXT,
  campaign_id TEXT,
  before      JSONB,
  after       JSONB,
  details     JSONB NOT NULL DEFAULT '{}'
);
```

Also: `users`, `subscriptions`, `controls` (metadata and current policy effect), `usage_evidence` (latest per account: window, counts by auth type, top callers, stale flag), `campaigns` (config, frozen plan summary, status and reason, unique idempotency key), `campaign_waves` (ring, status, acknowledged failures), `notifications` (with a dedupe key), `posture_snapshots`, `scan_runs`, `scanner_cursors`.

Valkey keys: `session:{id}`; `remediation:tasks` (stream, consumer group `executors`); `bucket:write:{sub}` and `bucket:block:{sub}` (token bucket and 429 block); `campaign:{id}:events` (live progress, capped at about 2,000 entries). All can be rebuilt from PostgreSQL.

## API Design

All endpoints are under `/api/v1`, authenticated with a session cookie.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/login`, `/auth/logout` · GET `/auth/me` | Session |
| GET | `/posture` | Per-control compliance, evidence breakdown, history, freshness (scoped for owners) |
| GET | `/findings?control&subscription&owner&severity&evidence&environment&status&q&page` | Findings explorer |
| GET | `/accounts/:name` | Config vs controls, evidence, change history, remediation attempts, exceptions |
| POST | `/accounts/:name/fix` | Owner self-service: a one-account campaign (Idempotency-Key) |
| POST | `/campaigns/preview` | Wave plan without saving |
| POST | `/campaigns` | Create (security only; Idempotency-Key) |
| GET | `/campaigns/:id` · `/campaigns/:id/events` | Snapshot · SSE (snapshot + progress events, `Last-Event-ID` resume) |
| POST | `/campaigns/:id/{start,pause,resume,kill}` | Conditional transitions; repeating one is a no-op |
| GET/POST | `/exceptions` · POST `/exceptions/:id/{approve,reject,revoke}` | Risk acceptance |
| GET | `/controls` · PUT `/controls/:id/policy` | Policy effect per control (deny guarded by burn-down) |
| GET | `/audit?account&campaign&action&before` · `/notifications` | Audit trail · inbox |
| POST | `/admin/scan` | Request a full scan or evidence refresh |

Example: creating a campaign twice with the same key.

```
POST /api/v1/campaigns   Idempotency-Key: sa02-nonprod-1
→ 201 {"campaignId":"cmp_mw3voryu…","plan":{"eligible":255,"waves":[…]},"replayed":false}
POST /api/v1/campaigns   Idempotency-Key: sa02-nonprod-1
→ 200 {"campaignId":"cmp_mw3voryu…","plan":{…},"replayed":true}
```

Example: the deny guardrail.

```
PUT /api/v1/controls/SA-02/policy {"effect":"deny"}
→ 409 {"error":{"code":"BURN_DOWN_INCOMPLETE","message":"SA-02 is 43.4% compliant. Deny would reject
       redeploys of the 848 non-compliant accounts and block rollbacks; …","details":{"compliancePct":43.4,"open":848}}}
```

## Key Design Decisions

### 1. Evidence before change, and missing evidence is a class of its own

The tempting design is "flip the setting and see who complains". With 40,000 accounts and a 2% hidden-dependency rate that is 800 incidents, each a production outage for some team, and each one spends trust the program needs for the next control. Querying logs first turns most of those into a list of callers to migrate. The subtle part is the third class: an account with no diagnostic setting shows zero shared-key requests, which looks exactly like "safe". Treating no data as "insufficient evidence" (and fixing SA-07 first) is what stops the evidence system from approving the riskiest accounts. The cost is time: an account without logs waits a full window before it can be touched.

### 2. Waves by blast radius, not by risk

Security wants the riskiest accounts fixed first; safety wants the least risky first. I use risk to choose which control to run and whom to chase, and blast radius to order a rollout: non-production before production, quiet accounts before busy ones, a canary spread thinly across subscriptions. A canary of the 13 riskiest accounts would put the first unproven change on the most sensitive, most used data. What I give up: the highest-risk production accounts get fixed last within a campaign, so a critical exposure may sit days longer. For those, the owner workflow and self-service fix are the faster path.

### 3. Durable intent before every write

The executor's dangerous moment is between "the cloud accepted the change" and "we recorded it". A worker that dies there leaves the account changed with no record; a naive retry re-reads the account, sees the new value, and records it as the before-value, so a later rollback would "restore" the secure value and leave the broken app broken. Writing the before-value, etag, baseline and operation ID before the PATCH, and never overwriting them, makes resume safe: an account that is already compliant when intent exists is recorded as recovered, with no second write. Locally, killing the executor right after its 60th write left two targets whose writes had landed unrecorded; after restart both were `recovered` and the simulator counted exactly one write on each.

### 4. Desired-state writes with If-Match, and a decision after every conflict

PATCH `allowSharedKeyAccess: false` is idempotent on its own, but not safe on its own: without a precondition we can overwrite a property someone changed after our read, or "fix" an account whose owner just moved it to a different state on purpose. If-Match with the etag we read gives a 412 instead, and the executor then decides deliberately (skip, recompute, escalate) rather than retrying blindly. Where a resource provider doesn't honor If-Match, the same decision runs on a read-compare-write with a short per-resource lock. The cost is more reads and some escalations a human has to look at.

### 5. Per-subscription token buckets with AIMD, shared across workers

ARM limits are per subscription and per principal, and other automation shares them. Each executor obeying its own limit isn't enough: ten executors each "under the limit" are ten times over it. The bucket lives in Valkey (atomic Lua with the server clock), a 429 blocks the subscription for every worker for the Retry-After, and the rate halves on each 429 and recovers by 2% per granted token. Without the adaptive part, every target deferred by the block becomes due the moment it lifts and they collide again: under a tight limit locally, 643 429s for 729 writes. With AIMD, 220 for 753 writes, and every target still landed once.

### 6. Prevention after burn-down, not before

Turning on deny first sounds like "stop the bleeding". For breaking controls it isn't: deny evaluates update requests too, so every team redeploying an old template is blocked, and our own rollbacks are blocked as well. That turns a security program into an availability incident. Additive controls get deployIfNotExists immediately; breaking controls get modify on creation where that's harmless, and deny only after burn-down, with exceptions mirrored as policy exemptions.

### 7. PostgreSQL as the system of record, the queue as a hint

The queue (Service Bus or a Valkey stream) carries target IDs, not work. Claims, leases, fences, intent and outcomes live in PostgreSQL. A lost message, a duplicate, a redelivery or a dead consumer costs at most a reconciler cycle, and the whole queue can be rebuilt from PostgreSQL. The alternative, making the queue the source of truth with exactly-once delivery, still can't make the cloud write and the queue ack atomic, so it buys complexity without the guarantee.

## Consistency and Idempotency

| Operation | Mechanism |
|-----------|-----------|
| Create campaign | `Idempotency-Key` stored with a unique constraint; a repeat returns the same campaign and plan |
| Start/pause/resume/kill | Conditional UPDATE from allowed states; already in the target state returns `changed: false` |
| Self-service fix | Idempotency-Key on the one-account campaign |
| Exception request | Partial unique index: one pending or approved exception per account and control |
| Executor claim | `UPDATE … WHERE id AND state = 'queued' AND not_before <= now()` (or an expired lease), fence + 1 |
| Every executor transition | `WHERE id AND fence AND state`; zero rows means another worker owns it |
| Cloud write | Desired state + If-Match; before-value recorded first; re-read before any retry |
| Lost response | Operation ID recorded before the call and sent as the client request ID; reconcile by reading actual state |
| Rollback | Restores the recorded before-value; no-op if already restored |
| Inventory | Upsert guarded by `lastModifiedAt`, so arrival order doesn't matter |
| Change feed | At-least-once; re-reading current state makes replays harmless |
| Audit | Written in the same transaction as the state change it describes |

### Design review checklist

1. **Source of truth, and when a write succeeds.** The cloud control plane is the truth for configuration; PostgreSQL is the truth for plans, step state, exceptions and audit. A remediation write counts as applied only when ARM returned 200 (or a re-read shows the desired value) and the step is recorded; it counts as done only when the bake verifies it. A campaign exists when its creation transaction commits.
2. **A client retries after losing the response.** Campaign creation and self-service fixes carry an Idempotency-Key and return the same campaign. Transitions are conditional and repeat as no-ops. On the executor side, a write whose response was lost is reconciled by reading the actual state before any retry, under the same operation ID.
3. **A worker fails between two steps.** Between intent and write: the lease expires, the reconciler requeues, the retry re-reads and writes once. Between write and record: the retry finds the desired state and records `recovered`. Between commit and enqueue: the reconciler re-sends. During a rollback: `rolling_back` is durable and the restore is idempotent.
4. **Which ordering is actually required.** Per account: one in-flight change per control (unique per campaign, and planning excludes accounts in other active campaigns for the same control); in production, one breaking change per account across controls, so a regression can be attributed. Per campaign: wave N+1 starts only when wave N is terminal. Inventory needs "newest version wins", not arrival order. Nothing needs global ordering.
5. **Access when caches, indexes or jobs are involved.** The owner's team filter is inside every SQL query, including the SSE snapshots. The executor acts with its own narrowly scoped identity, so the human's authorization is checked when the campaign or fix is created, and the plan's assumptions (exceptions, ring, evidence) are re-checked by the executor at write time. Sessions in Valkey carry the role; a role change takes effect at session expiry unless sessions are revoked.
6. **What breaks first at larger scale, and the evidence.** Evidence cost and Log Analytics query limits first (the 20 TB/day estimate above). Then finding write amplification: every evaluation pass rewrites every open finding, 4,176 rows locally to change almost none, which would be ~1.1M row versions per scan at 400,000 accounts; the fix is to diff in memory and write only changes. Then human throughput: the needs-owner-migration tail (936 of 4,176 local findings) is engineering work in other teams that no amount of executor capacity speeds up.

## Security / Auth

- **Human access**: SSO in production (session cookie locally), three roles. Security engineers run campaigns and change policy; owners see only their team's accounts (owner tag, else subscription owner), fix them or request exceptions; approvers decide exceptions and can't approve their own requests.
- **Executor identity**: a managed identity with a custom role limited to storage account and blob service writes and diagnostic-setting writes, scoped at management group level. It has no data-plane role, so it can change settings but not read data. The evidence worker has a separate read-only identity for Log Analytics and metrics.
- **Production guardrails**: campaigns that touch the prod ring need a second person to start them (creator ≠ starter); resource locks are respected, never removed; the kill switch is available to on-call without a deploy.
- **Rate limiting**: login attempts per IP; the executor's own budgets protect the shared platform limits.
- **Audit**: append-only table (UPDATE and DELETE rejected by a trigger), mirrored to immutable storage in production; the platform's Activity Log is an independent second record of every write, correlated by the client request ID.

## Observability

Every process exposes Prometheus metrics on `/metrics` and logs JSON with pino.

| Metric | Why |
|--------|-----|
| `remediation_arm_requests_total{op,status}`, `remediation_arm_throttled_total{op}` | 429 rate by operation; the SLO is < 1% |
| `remediation_target_transitions_total{to}` | Throughput and outcome mix (verified, rolled back, escalated) |
| `remediation_rollbacks_total{control,outcome}` | Restored vs denied vs gave up; any `denied` pages |
| `remediation_apply_seconds`, `remediation_token_wait_seconds` | Where time goes: waiting on budget vs the platform |
| `remediation_scan_seconds{kind}`, `remediation_change_events_total{outcome}` | Inventory health: scans, coalesced, throttled, applied |
| `remediation_open_findings{control}` | Burn-down per control |
| `remediation_sse_connections` | Live dashboard load |

Dashboards show posture with its as-of time and a definition of every number; the posture page carries a freshness banner (last full scan, last change-feed poll, last change seen). Alerts: any rollback denied or given up; a campaign auto-paused; full scan older than 26 h; change-feed lag over 10 minutes; 429 rate over 1% for 10 minutes.

## Failure Handling

| Failure | Handling |
|---------|----------|
| 429 from ARM | Block the subscription for Retry-After across workers, halve its rate, defer with growing back-off and jitter; give up after 12 |
| 5xx or timeout on a write | Re-read; confirmed → applied; not applied → exponential back-off (longer while throttled), at most 5 attempts |
| 412 on a write | Re-read and decide: skip, recompute, or escalate |
| 403 policy deny or lock | Fail with the reason; never remove locks; a denied rollback pages |
| Executor crash | Lease expires, reconciler requeues, recorded intent makes resume write-once |
| Queue loss | Reconciler re-sends due targets from PostgreSQL |
| Resource Graph lag | Version guard; deletion inferred only with a margin |
| Change feed gap | Cursor-expired response → full scan, then resume from the recorded position |
| Log Analytics throttling or outage | Evidence pass backs off and retries next cycle; findings keep their last classification; no new "safe" without evidence |
| Bad wave | Failure budget pauses the campaign; kill stops new writes while baking targets can still roll back |
| Rollback can't complete | Bounded rounds, then page with the value to restore |
| Valkey outage | Sessions fail (users sign in again later); buckets and the stream are rebuilt; the executor waits rather than writes without a budget |

## Scalability Considerations

- **Scanners** shard by subscription hash (SHARD_INDEX of SHARD_COUNT); full scans are cheap (~40 Resource Graph pages); child reads spread over the day.
- **Executors** scale horizontally; the shared bucket keeps total writes per subscription bounded however many run. Service Bus sessions keyed by subscription keep one subscription's work on few workers and preserve per-subscription fairness.
- **PostgreSQL**: partition `findings` and `campaign_targets` by control or by campaign; write only changed findings; precompute posture by scope (team, management group) instead of cross-joining controls and accounts on every dashboard load (24 ms locally at 1,500 accounts, linear in fleet size).
- **Evidence**: metrics first, logs only where needed, Basic Logs or archive tiers for the bulk; queries batched per workspace with their own concurrency limit.
- **Multi-tenant or multi-cloud**: a ControlPlane interface per provider; controls and evidence rules per provider; one findings model.
- **The real ceiling is people**: owner migrations and exception reviews. Scale there comes from better evidence (naming the exact caller and key hash), templates for the common migrations (managed identity plus a role assignment), and digests instead of per-finding tickets.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Impact analysis | Logs + metrics, three classes | Flip and watch | Each surprise is a production outage; missing logs must not read as "safe" |
| Rollout order | Blast radius (rings, canaries, quiet first) | Risk order | The first unproven change shouldn't land on the most sensitive data |
| Step durability | Intent in PostgreSQL before the write | Retry from scratch | Resume never double-writes or restores the wrong value |
| Write semantics | Desired state + If-Match + decide on 412 | Blind PATCH | Never overwrite a concurrent change; escalate real conflicts |
| Throttling | Shared per-subscription buckets + AIMD | Per-worker limits | Limits are per subscription; herds after Retry-After collide |
| Lost responses | Operation ID + reconcile by read | Retry the call | The platform doesn't dedupe; actual state is the only truth |
| Queue role | Hint; PostgreSQL decides | Queue as source of truth | Cloud write and ack can't be atomic anyway |
| Prevention timing | After burn-down (deny) | Deny first | Deny blocks redeploys and our own rollbacks |
| Exceptions | Time-boxed, approver ≠ requester | Permanent waivers | Accepted risk must come back for review |
| Evidence source | Metrics first, logs for attribution | Logs everywhere | ~20 TB/day of logs at fleet scale |
| Inventory consistency | Newest version wins | Last arrival wins | Resource Graph lags ARM |
| Live progress | SSE with snapshot + events | Polling | One stream per viewer, resumable, falls back to polling |

## Implementation Notes

The local build runs the production design against a simulated control plane, with the hard parts implemented for real and the scale and duration compressed.

### Local architecture

| Production | Local |
|------------|-------|
| Azure (ARM, Resource Graph, Event Grid, Policy, Monitor, Log Analytics) | `cloud-sim` (port 3100): an Express service with ARM-shaped paths, verbs, headers and status codes, state persisted to `.sim-state/fleet.json` |
| Scanner fleet, change consumers, evidence workers | One `scanner` process (port 3200), shardable with SHARD_INDEX/SHARD_COUNT |
| Executor fleet on Service Bus | `executor` (port 3300), any number of instances on a Valkey stream with a consumer group |
| API behind SSO | `api` (port 3000) with bcrypt passwords and Valkey sessions |
| PostgreSQL cluster, Redis | PostgreSQL 16, Valkey 7 |

### Production-grade patterns actually implemented

- **Durable intent, leases and fences** (`executor/pg-store.ts`, `executor/apply.ts`). Every transition is a conditional UPDATE on `(id, fence, state)`:

  ```sql
  UPDATE campaign_targets SET before_value = $3, etag_before = $4, baseline = $5, operation_id = $6
   WHERE id = $1 AND fence = $2 AND state = 'applying' AND before_value IS NULL
  ```

  Verified by killing the executor right after a write (`EXECUTOR_CRASH_AFTER_WRITES`): the two targets whose writes landed were resumed as `recovered`, one write each.
- **Revalidation after re-read** (`domain/revalidate.ts`): `revalidatePlan` (ring moved → escalate, evidence changed → skip) and `decideAfterRead` (skip, recover, recompute, escalate), unit-tested and exercised against the simulator's real etag semantics.
- **Per-subscription token buckets with AIMD** (`executor/buckets.ts`): one Lua script, mirrored by an in-memory implementation for tests. Measured: 0.88 → 0.29 429s per successful write under a tight limit.
- **Bounded retries**: 5 for server errors and timeouts with exponential back-off (doubled per recent throttle, capped at 60 s), 12 for 429s, 3 rounds for rollbacks.
- **Bake-time rollback** (`domain/bake.ts`, `executor/verify.ts`): three-condition trigger against a per-account baseline; rollbacks happened 9-12 s after the write in the demo and restored within 50 ms of the trigger.
- **Version-guarded inventory** (`store/inventory.ts`): one `INSERT … ON CONFLICT … WHERE properties_modified_at <= EXCLUDED.properties_modified_at`.
- **Idempotency keys, conditional transitions, partial unique index for live exceptions** (`api/services/campaigns.ts`, `api/routes/*`).
- **Append-only audit** with a trigger, written in the same transaction as each transition (`store/audit.ts`).
- **SSE with `Last-Event-ID`** backed by a capped Valkey stream, with snapshots at most once a second (`api/routes/campaigns.ts`).
- **Observability**: prom-client metrics listed above on every process, pino JSON logs, `/health` and `/ready`.

### Simplified or substituted

- **The cloud is simulated.** Rules are evaluated by the same code the simulator uses for Azure Policy, so policy and evaluation can't disagree locally (in production they can, and that's a signal). Policy deny is evaluated only on the properties a PATCH touches. Diagnostic settings are modelled as one object with `enabled` and `createdAt` rather than per-category logs. Every caller failure appears as `AuthorizationError` in metrics.
- **Logs are synthesized** from each account's callers on demand, aggregated per caller; no raw rows. The `Authentication` metric tier is not implemented: evidence is logs only, which is the more conservative choice.
- **Time is compressed**: 20 s bake, 5 s metric buckets, a 30-day window that is real in data but instant in time. Periodic jobs "fire during the bake" (a fault switch) to make the quarter-end incident reproducible.
- **Resource Graph** returns a lagged copy of account properties (10 s by default) and pages by offset.
- **Change feed** is a polled HTTP endpoint with a sequence cursor instead of Event Grid and Service Bus.
- **Session auth** with bcrypt instead of SSO; one PostgreSQL instance instead of a partitioned cluster; one change per account per control rather than per account across controls.

### Omitted

Multi-tenant and multi-cloud support, resource locks in the simulator, Azure Policy exemptions mirrored from exceptions, the two-person rule for production rings, ticketing integration (ServiceNow, Teams), Kubernetes deployment, WORM mirroring of the audit log, and partitioning.

### Verified locally

Native PostgreSQL 16 and Valkey, all four services and the frontend:

- Shared-key campaign over non-production: 255 targets in 3 waves; 252 verified; the 3 planted quarter-end jobs rolled back automatically; wave 2 exceeded its budget and paused itself; 3 ambiguous 5xx writes were confirmed by re-reading; after rollback the 3 accounts were reclassified as needs owner migration.
- Fleet-wide soft-delete campaign under a 0.25 writes/s per subscription limit: 763 targets in 8 waves, all verified, 220 Retry-Afters honored, executor killed after its 60th write and restarted, every in-flight account written exactly once.
- Forced full scan right after an owner's change: the stale Resource Graph row was skipped (`staleSkipped: 1`).
- Policy: deny refused at 43.4% compliance; modify and deployIfNotExists applied to drifted accounts on creation; deny rejected the old template outright.
- Exceptions: a seeded approval expired four minutes after seeding and the finding reopened on its own; self-approval refused; duration over the severity cap refused.
- 89 backend unit and API tests; frontend type-check, lint and build; Playwright flows for all three roles.

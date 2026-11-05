# Storage Misconfiguration Remediation — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → API → Pipeline → Deep dives → Traces → Scale*

> "The prompt is: find and fix security misconfigurations across tens of thousands of cloud storage accounts without breaking the applications that use them. The second half of that sentence is the whole problem. Finding public blob access or shared-key auth is a Resource Graph query. Fixing it is one PATCH. The hard parts are knowing who depends on the insecure setting before I touch it, changing forty thousand accounts against a control plane that throttles me and lags behind itself, proving each change did no harm, undoing it automatically when it did, and surviving my own workers crashing halfway. So I'll design a pipeline: inventory, evaluate, gather evidence, plan waves, execute with verification, and then prevent regressions with policy once the fleet is clean."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | "Without breaking apps" is the core requirement; evidence and rollback are first-class |
| Architecture | ~5 min | Scanners, evidence, planner, executor, verifier; PostgreSQL decides, the queue hints |
| Data model and API | ~5 min | Findings with evidence classes; campaign targets as a durable state machine |
| Pipeline | ~7 min | Version-guarded inventory, versioned controls, three evidence classes, wave planning |
| Deep dives | ~15 min | Safe rollout; impact analysis and the migration path; throttling, lag and crash safety |
| Traces and checklist | ~5 min | One wave-2 account end to end; the quarter-end job that the logs missed |
| Scale and wrap-up | ~3 min | Evidence cost and people break first, not compute |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Which settings? | Some changes break callers, some are additive | Public blob access, shared key, TLS < 1.2, HTTPS only, network access, soft delete, diagnostic logs |
| Is "remediation" security config, or also resilience, migration, cost? | The same machinery, different evidence and regression signals | Security configuration; I'll note where the others differ |
| How big? | Sizes the scanners and the evidence budget | Illustrative: 40,000 accounts, 2,000 subscriptions, ~1,200 owning teams |
| Can I change things directly, or only open tickets? | Decides whether there's an executor at all | Direct changes, by a service identity, under campaigns a security engineer starts |
| Are there access logs? | Impact analysis depends on them | Some accounts send StorageBlobLogs to Log Analytics, many don't |
| What does "don't break apps" mean operationally? | Defines the rollback signal | A rise in authorization failures (403) after a change, against that account's baseline |
| Who accepts risk when an account can't be fixed? | Exceptions need an owner | An approver, not the requester; every exception expires |

### Functional requirements

1. Inventory every storage account with tags (owner, environment, classification), account properties and relevant child resources.
2. Evaluate against versioned controls; one finding per account per failing control, with severity and risk.
3. Before a breaking change, classify each finding from access logs: safe to fix, needs owner migration (callers named), or insufficient evidence.
4. Campaigns per control: waves, canaries, bake time, failure budget; start, pause, resume, kill; live progress.
5. Verify every change and roll back automatically on a regression.
6. Exceptions with approver and expiry; owner notifications, deadlines, escalation, self-service fix.
7. Prevention via policy once a control is burned down; a complete audit trail.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Safety | Zero unplanned outages; regressions rolled back within minutes | Evidence first, bake-time signals, rollback that pause and kill can't stop |
| Blast radius | First unproven change hits ≤ 1-5% of a ring | Rings, canaries, one breaking change per account at a time |
| Correctness under failure | No double-apply, no rollback to a wrong value | Durable intent before writes, leases with fences, If-Match |
| Platform limits | < 1% of calls get 429 | Shared per-subscription budgets, Retry-After, adaptive slow-down |
| Freshness | Changes visible within 5 min p95 | Change feed plus daily full scans, version guard |
| Audit | Every change with before/after, 7 years | Append-only, same transaction as the state change |

### Capacity (illustrative)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Findings to start | ~110,000 | ~2.8 failing controls per account × 40,000 |
| Full inventory scan | ~40 Resource Graph pages | 1,000 rows per page |
| Child-resource reads | ~80,000 per refresh | Soft delete and diagnostic settings need ARM GETs |
| Writes per control | 5,000-15,000 | Only "safe to fix" in the first pass |
| Wall clock per control | 1-2 weeks | ~8 waves × 24 h bake; the writes themselves take under an hour |
| Logs if every account logged everything | ~20 TB/day | 500K requests/day/account × ~1 KB |

> "Two numbers shape the design. The writes are trivial, so throughput isn't my problem; bake time is, and that means I want parallelism across controls and subscriptions, not faster writes. And full logging everywhere would cost more than the program, so evidence has to be tiered: free platform metrics first, logs only where I need to name a caller."

---

## 🏗️ High-Level Architecture (~5 min)

```
┌─────────────────────────────────────────────────────────────────────┐
│  UI · posture · findings · campaigns · exceptions · audit           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ REST + SSE
┌───────────────────────────────▼─────────────────────────────────────┐
│  API (stateless) · role + team scope in every query                 │
└──────┬───────────────────────────┬──────────────────────┬───────────┘
       │                           │                      │
┌──────▼──────────────┐   ┌────────▼────────┐   ┌─────────▼──────────┐
│ PostgreSQL          │   │ Redis           │   │ Queue (Service Bus)│
│ inventory, findings │   │ token buckets   │   │ target IDs only    │
│ evidence, campaigns │   │ live events     │   │ change-event topic │
│ step state, audit   │   │ sessions        │   └───▲──────────┬─────┘
└──▲──────▲──────▲────┘   └──▲──────▲───────┘       │          │
   │      │      │           │      │               │          │
┌──┴────┐ ┌┴──────┴──┐  ┌────┴──────┴─────────┐      │   ┌──────▼──────┐
│Scanner│ │ Evidence │  │ Executor + verifier │◀─────┘   │ Change      │
│shards │ │ workers  │  │ claim, re-read,     │          │ consumers   │
└──┬────┘ └────┬─────┘  │ intent, If-Match,   │          └──────┬──────┘
   │           │        │ bake, rollback      │                 │
   │           │        └──────────┬──────────┘                 │
   ▼           ▼                   ▼                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Resource Graph · ARM / Storage RP · Event Grid · Azure Policy       │
│ Azure Monitor metrics · Log Analytics (StorageBlobLogs)             │
└─────────────────────────────────────────────────────────────────────┘
```

**Walking the diagram:**

- **Scanners** page through Resource Graph for their shard of subscriptions and upsert accounts. **Change consumers** turn subscription write events into fresh ARM reads. Both feed one inventory table guarded by the resource's last-modified time.
- **Evidence workers** query metrics and logs. They spend a different budget from the scanners and executors: management-plane calls (ARM, Resource Graph, Policy) are throttled per subscription and principal; log and metric queries have their own per-user quotas. Separate workers, separate concurrency, separate back-off.
- **Planner** (inside the API) freezes a wave plan when a campaign is created. The **coordinator** advances waves and enforces failure budgets. **Executors** apply one target at a time; the **verifier** bakes and rolls back.
- PostgreSQL is the system of record for every decision. The queue carries target IDs only, as hints; Redis holds shared token buckets and the live event stream.

> "The sentence I'd want the interviewer to remember: the queue says 'look at target N', PostgreSQL says whether there's anything to do. That's what makes duplicates, redeliveries and crashed consumers boring."

---

## 💾 Data Model (~5 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| storage_accounts | id (ARM ID), name (unique), subscription, owner + owner_source, environment, classification, properties, properties_modified_at, blob_service, diagnostics, observed_via | `properties_modified_at` is the version guard; owner falls back to the subscription when the tag is missing |
| findings | (account, control) unique, control_version, status open/exempt/resolved, severity, risk_score, evidence_class, evidence_reason, due_at, reopened_count | Only failures are stored; compliance = evaluated − open − exempt |
| usage_evidence | account, window_days, has_logs, counts by auth type / TLS / protocol / public IP, top callers, stale | `stale` is set by a rollback so the account is reclassified |
| campaigns | id, control, status + reason, config (scope, waves, bake, budget, included evidence classes), frozen plan summary, idempotency_key (unique) | The plan a human approved |
| campaign_waves | (campaign, wave_no), ring, label, status, acknowledged_failures | Resume only counts new failures |
| campaign_targets | (campaign, account) unique, wave, state, fence, lease, not_before, attempts, throttle_count, operation_id, before_value, etag_before, after_value, baseline, write_outcome, bake_until, rollback_reason | The durable state machine: intent is written before the cloud is touched |
| exceptions | account, control, status, justification, requested_by, decided_by, requested_days, expires_at | Partial unique index: one pending or approved per (account, control) |
| audit_log | at, actor, action, account, control, campaign, before, after, details | Append-only (trigger), same transaction as the change |

Target states:

```
pending ─▶ queued ─▶ applying ─▶ baking ─▶ verified
             ▲          │  │        │
             └─deferred─┘  │        └──▶ rolling_back ─▶ rolled_back
                           └──▶ skipped | escalated | failed | cancelled
```

> "I keep `escalated` separate from `failed`. Escalated means the world changed under the plan (the account moved to prod, someone else is editing the same property), so a human looks. Failed means the change itself went wrong, and only failures count against the wave's budget."

---

## 🔌 API (~3 min)

```
GET  /api/v1/posture                          → per-control compliance, evidence mix, history, freshness
GET  /api/v1/findings?control&owner&evidence  → findings explorer (owner scope inside the query)
GET  /api/v1/accounts/:name                   → config vs controls, evidence, history, attempts
POST /api/v1/accounts/:name/fix               → owner self-service (Idempotency-Key)
POST /api/v1/campaigns/preview                → wave plan, not saved
POST /api/v1/campaigns                        → create (Idempotency-Key), security only
POST /api/v1/campaigns/:id/start|pause|resume|kill → conditional transitions
GET  /api/v1/campaigns/:id/events             → SSE: snapshots + progress, Last-Event-ID resume
POST /api/v1/exceptions · /:id/approve|reject|revoke
PUT  /api/v1/controls/:id/policy              → policy effect; deny refused below 95% compliance
GET  /api/v1/audit                            → append-only trail
```

Idempotency: creating a campaign twice with the same key returns the same campaign. Transitions repeat as no-ops. The policy endpoint returns a 409 with the current compliance and open count when deny would be premature.

---

## ⚙️ The Pipeline (~7 min)

### Inventory

Full scans page Resource Graph per shard; change events trigger fresh ARM reads. Resource Graph lags ARM, so the upsert keeps whichever observation has the newer `lastModifiedAt`. In the local build, a full scan forced one second after an owner's change skipped exactly the stale row. Deletion is inferred only for accounts last seen well before the scan started.

### Evaluation

Controls are versioned rules: which resource they read, how to judge it, whether turning them on can break callers, which usage signal shows a dependency, the body that fixes it and the body that restores it. Findings carry the version that produced them. Risk = severity × internet exposure × data classification × "is the insecure path actually used". Public access on confidential data escalates to critical.

### Evidence

| Class | Rule |
|-------|------|
| ✅ safe to fix | A full window of logs and no request depends on the insecure setting |
| ⚠️ needs owner migration | At least one dependent request; the callers are named |
| ❓ insufficient evidence | No diagnostic setting, or under 14 days of logs |

### Planning

Non-production ring before production. A canary per ring, spread across subscriptions. Waves grow by a factor (×4) up to a cap. Quietest accounts first. Exclusions with reasons. The plan is frozen at creation; the executor re-checks its assumptions at write time.

### Prevention, and the order to turn it on

Detect-and-remediate cleans up what exists; prevent-at-creation stops new resources from regressing. The order matters because Azure Policy's deny effect evaluates updates as well as creates.

| Control type | When to prevent | Effect |
|--------------|-----------------|--------|
| Additive (soft delete, diagnostics) | Immediately | deployIfNotExists: new accounts get it on creation |
| Breaking, insecure value is only a template default | Early | modify: new accounts are corrected, not rejected |
| Breaking, existing callers depend on it | After burn-down (≥ 95% compliant) | deny |

> "If I turn on deny for shared key while 850 accounts still need it, every team redeploying an old template gets rejected, and so does my own rollback, because policy applies to every writer. The API refuses that switch below 95% unless forced, and approved exceptions become policy exemptions with the same expiry."

---

## 🔧 Deep Dive 1: Safe Rollout — Waves, Bake Time and Rollback Signals (~5 min)

**Decision:** I roll out by blast radius, verify each change for a bake period against that account's own baseline, and roll back automatically. A failure budget per wave stops the campaign before a bad assumption spreads.

**Why it works here.** The failure mode I'm guarding against is a dependency the evidence didn't see: a job that runs quarterly, a partner that calls once a month, a client on an old SDK that only shows up in a region we didn't sample. Evidence catches most dependencies; waves and bake catch the rest while the exposure is small. A canary of 5% of the non-production ring, spread across subscriptions, touches many teams' environments lightly, so a pattern (say, every account created from one old template) shows up as a few failures in different places, not as one team's outage. The wave grows ×4 only after the previous one is terminal and within budget.

The rollback signal has three conditions, all required: at least 5 authorization failures since the change, a rate above 3× the baseline captured just before the write, and at least 2% of requests. Each condition kills a specific false positive. The minimum count ignores one stray 403. The baseline multiplier ignores accounts that were already failing before we touched them. The percentage ignores a handful of failures on an account doing millions of requests.

**Why the alternatives fail.**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Rings + canary + bake + auto-rollback + wave budget | Exposure bounded; regressions undone in minutes | Slow: days per control |
| ❌ Flip everything that evidence says is safe | Fast | Evidence has blind spots; a 2% miss rate on 15,000 accounts is 300 outages at once |
| ❌ Risk-ordered rollout (riskiest first) | Biggest exposures closed first | The first unproven change lands on the most sensitive, busiest data |
| ❌ Rely on owners to report breakage | No metrics plumbing | Detection in days, not minutes; owners stop trusting the program |
| ❌ Rollback on any 403 | Simple | Busy accounts always have some 403s; constant false rollbacks |

> "Risk decides which control I run and whom I chase first. Blast radius decides rollout order. Mixing those up is how a security program causes the outage that ends it."

**What I give up.** Time. With a 24-hour bake and about eight waves, one control takes one to two weeks. I win some back by running several controls in parallel on disjoint accounts, but never two breaking changes on the same account in one bake window: if both land and 403s appear, I can't tell which one to undo. I also accept that rollbacks are only as good as the signal. A dependency that runs less often than the bake window (a quarterly job, a 24-hour bake) is invisible to it. Platform metrics with 93-day retention, which show authentication type even without diagnostic logs, are the defense there, and the incident below is why.

Two more rules make rollback trustworthy. It restores the before-value recorded before the write, never a value read later. And it can't be paused: pause and kill stop new writes, while targets already changed keep baking and can still roll back.

---

## 🔧 Deep Dive 2: Impact Analysis and the Owner Migration Path (~5 min)

**Decision:** before any breaking change, I classify each finding from access evidence into safe to fix, needs owner migration, or insufficient evidence, and only the first class goes into a default campaign. The other two go to the owner workflow.

**Why "just flip the setting" breaks production.** Disabling shared key access sounds like a security setting, but it's an authentication change for every caller. An AzCopy job using the account key, a partner with a service SAS, a function app on a connection string all start getting 403 the moment the flag flips. Public access has anonymous readers (static assets in emails, marketing images). TLS 1.2 breaks old clients at the handshake. Network deny breaks anything coming from a public IP. Those callers belong to other teams who weren't told.

**How evidence is gathered.** StorageBlobLogs record AuthenticationType (Anonymous, SAS, AccountKey, OAuth), TLS version, protocol, caller IP, user agent and a hash of the key or SAS used. For each account with an open breaking finding, I query the last 30 days, aggregated per caller. A dependency for shared key is any AccountKey or SAS request (service and account SAS are signed with the key). The callers become the owner's to-do list: "this AzCopy job from 10.56.21.109 uses key 1; move it to a managed identity with Storage Blob Data Contributor."

**The trap is missing logs.** An account with no diagnostic setting shows zero shared-key requests, which looks exactly like safe. So no logs, or logs younger than 14 days, is its own class. In the simulated fleet that class is the biggest blocker: 965 of 4,176 open findings, more than the 936 that need migration. That's why diagnostics (SA-07) is the first campaign I run. It's additive, it can't break anything, and it's the prerequisite for evidence on every other control.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Three classes, logs + metrics, missing data is its own class | Honest about blind spots; names callers | Accounts without logs wait a full window |
| ❌ Binary "used / not used" | Simpler UI | Treats no data as not used: approves the riskiest accounts |
| ❌ Brownout (disable for an hour, re-enable) | Real-world test | A planned outage for unknown callers; still misses periodic jobs |
| ❌ Full logs on every account | Complete | ~20 TB/day of ingestion at 40K accounts |

**The migration path for owners.** A finding that needs migration gets a deadline by severity (high: 30 days), a daily digest per team instead of per finding, the callers with their key hashes, and two buttons. "Fix now" runs the same executor path as a campaign, so an owner's own fix still bakes and rolls back. "Request exception" needs a justification and an approver who isn't the requester, and it expires (90 days max for high). Shared-key users migrate to Entra ID: a managed identity with a data-plane role, or a user delegation SAS, which keeps working with shared key disabled.

**What I give up.** Speed and cost. A 30-day window means a month before an account without logs can be touched. Logs cost money, so in production I'd use platform metrics (free, 93-day retention, split by authentication type) to triage everything, and logs only where a dependency shows up and I need the caller's identity, or for TLS and network source, which metrics don't expose.

---

## 🔧 Deep Dive 3: Throttling, Eventual Consistency and Crash-Safe Execution (~5 min)

**Decision:** every write is a desired-state PATCH with If-Match, preceded by a fresh ARM read and a durable intent record, rate-limited by a per-subscription token bucket shared by all workers, and reconciled against actual state whenever its outcome is unknown.

**Throttling.** ARM limits are per subscription and per principal, and other automation in the subscription shares them. Ten executors each obeying their own limit are ten times over it, so the bucket lives in Redis (an atomic script using the server clock). On a 429, the subscription is blocked for the Retry-After for every worker, and its rate halves; each granted token adds back 2%. The adaptive part matters: without it, every target deferred by the block becomes due the moment it lifts and they collide again. In the local build, under a deliberately tight limit, that was 643 429s for 729 writes. With the rate halving it was 220 for 753, and every target still landed once. Retries are bounded: 12 throttles per target, then it fails and counts against the wave budget.

**Eventual consistency.** Resource Graph lags ARM, so inventory uses "newest lastModifiedAt wins", not "last arrival wins". The executor never trusts the scan snapshot: it re-reads from ARM right before writing and revalidates the plan. If the account moved from dev to prod since planning, it escalates; it doesn't get a production change in a non-production wave. If a caller appeared and evidence changed, it skips.

**The resource changed after discovery.** The write carries If-Match with the etag just read. A 412 means someone changed it between my read and my write, and I decide deliberately instead of retrying blindly:

| After a 412, the resource is… | Action |
|-------------------------------|--------|
| Now compliant | Skip: someone else fixed it |
| Same insecure value, other property changed | Recompute the write against the new etag |
| A different insecure value (TLS1_0 → TLS1_1) | Escalate: another writer is managing this property |
| Changing on every attempt (3 conflicts) | Escalate |

**Lost responses.** A 5xx or a timeout means the outcome is unknown; the platform may have applied the change. Each write has an operation ID recorded before the call and sent as the client request ID, so the activity log can tell me later which call made a change. The fast path doesn't wait for that: it re-reads the resource. Desired value present: recorded as applied (`confirmed_after_5xx` or `confirmed_after_timeout`). Absent: retry with exponential back-off, doubled while the subscription is also throttling, at most five times.

**Crashes.** The dangerous moment is after the cloud accepted a change and before I recorded it. A naive retry would read the new value and record it as the before-value, so a later rollback would "restore" the secure value and leave a broken app broken. So intent (before-value, etag, auth-failure baseline, operation ID) is written before the PATCH and never overwritten. On resume, an account already compliant with intent present is recorded as `recovered`, with no second write. Claims carry a lease and a fence; a worker whose lease expired matches zero rows on every update.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Re-read + intent + If-Match + reconcile by read | Write-once under crashes, conflicts and lost responses | More reads; escalations need humans |
| ❌ Blind PATCH with retries | Fewer calls | Overwrites concurrent changes; retries can't tell landed from lost |
| ❌ Exactly-once queue delivery | Familiar pattern | The cloud write and the ack still aren't atomic |
| ❌ Per-worker rate limits | No shared state | Limits are per subscription, not per worker |

**What I give up.** Extra ARM reads (roughly two reads per write, within the read budget, which is far larger), Redis as a dependency for writes (if it's down, executors wait rather than write without a budget), and some escalations that a person has to resolve.

---

## 🧪 Traces (~5 min)

### Successful: an account in wave 2

```
coordinator ─ wave 2 pending → targets queued → enqueue (after commit)
worker      ─ claim (queued → applying, fence+1, lease 15s)
            ─ campaign running? exception approved since? no
            ─ token from subscription bucket
            ─ GET from ARM: allowSharedKeyAccess=true, etag E1, env=test (planned ring), evidence safe
            ─ baseline: 0 auth failures in last 60s
            ─ record intent: before=true, E1, baseline, operation ID
            ─ PATCH false, If-Match E1 → 200, etag E2
            ─ record applied → baking (bake 20s), audit before/after, live event
scanner     ─ change event → GET → upsert → finding resolved
verifier    ─ every 2s: property still false, 0 auth failures
            ─ bake over → verified, audit
coordinator ─ all wave-2 targets terminal, failures ≤ budget → wave 3
```

### Failed: the quarter-end job

```
evidence ─ account stmobilemediw9i0jo: 30 days of logs, OAuth only → safe to fix → canary
executor ─ intent recorded, PATCH false → 200 (18:27:48)
cloud    ─ quarter-end job (account key, last ran 45 days ago) starts → 403s
verifier ─ 18:28:00: 7 failures, 36/min vs baseline 0, 100% of that caller → rollback
         ─ one transaction: baking → rolling_back, evidence stale, audit, notify owner + security
         ─ token (inline, rollback has priority) → GET etag → PATCH true (recorded before-value) → 200
         ─ rolled_back, audit
scanner  ─ finding reopened; next evidence pass sees AccountKey requests → needs owner migration
coordinator ─ wave 1: 1 failure ≤ budget 1 → continue; wave 2: 2 more → pause, reason recorded
```

> "Restore took 50 milliseconds after the trigger. Detection took 12 seconds in the demo because the bake is compressed; in production the bake is a day, and the honest weakness is that a job that runs quarterly won't run inside it. That's the case for metrics with longer retention."

---

## ✅ Design Review Checklist (~2 min)

1. **Source of truth.** ARM for configuration; PostgreSQL for plans, step state, exceptions, audit. A remediation counts as applied when ARM returned 200 or a re-read confirms it, and it's recorded; done when the bake verifies it.
2. **Client retries after losing the response.** Idempotency-Key on campaign creation and self-service fixes; conditional transitions. The executor reconciles lost write responses by reading actual state under the same operation ID.
3. **Worker fails between two steps.** Lease expiry plus reconciler requeue; recorded intent makes the retry write-once or `recovered`; the enqueue happens after commit and the reconciler re-sends what was lost; `rolling_back` is durable and restore is idempotent.
4. **Ordering.** Per account: one in-flight change per control (and in production one breaking change per account across controls). Per campaign: waves strictly in order. Inventory: newest version wins. Nothing global.
5. **Access through caches and jobs.** The owner's team filter is in every query, including SSE snapshots. The executor uses its own narrowly scoped identity; human authorization happens at campaign creation, and the executor re-checks exceptions, ring and evidence at write time.
6. **What breaks first.** Evidence cost and log query limits, then finding write amplification (every evaluation rewrites every open finding; diff and write only changes), then human throughput on migrations.

---

## 📊 What I Alert On

| Signal | Threshold | Why it pages |
|--------|-----------|--------------|
| Rollback denied or gave up | Any | An account may be broken and we can't undo it |
| Campaign auto-paused | Any | A wave exceeded its failure budget; someone decides resume or kill |
| 429 rate | > 1% for 10 min | We're competing with other automation for the subscription budget |
| Change-feed lag | > 10 min | Inventory and evidence are going stale |
| Full scan age | > 26 h | Reconciliation missed a cycle |
| Escalated targets | Daily digest | Plans that reality outran; not urgent, but not ignorable |

---

## 📈 Scalability (~2 min)

| Component | First limit | Fix |
|-----------|-------------|-----|
| Evidence | Log ingestion cost, query quotas | Metrics first, logs for attribution only, archive tiers |
| Findings store | Rewriting every open finding per scan (~1.1M rows at 400K accounts) | Diff in memory, write changes only; partition by control |
| Posture queries | Cross join of controls × accounts per dashboard load | Precomputed rollups per team and management group |
| Executors | None in practice: shared buckets cap writes per subscription | Scale workers; queue sessions per subscription for fairness |
| People | Owners migrating callers, approvers reviewing exceptions | Name the exact caller and key, migration templates, digests |

> "If I had to bet on what breaks first at ten times the size, it's not a machine. It's the long tail of accounts whose owners have to change code before I can change a flag."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Impact analysis | Three evidence classes | Flip and watch | Each surprise is someone's outage |
| Rollout order | Blast radius | Risk order | First change shouldn't hit the most sensitive data |
| Rollback trigger | Count + baseline multiple + rate | Any 403 | Busy accounts always have some 403s |
| Step durability | Intent before write | Retry from scratch | Resume never double-writes or restores the wrong value |
| Concurrency control | If-Match + decide on 412 | Blind PATCH | Don't overwrite another writer |
| Throttling | Shared bucket + AIMD | Per-worker limits | Limits are per subscription; herds collide |
| Queue | Hint; PostgreSQL decides | Queue as truth | Cloud write and ack can't be atomic |
| Prevention | Deny after burn-down | Deny first | Deny blocks redeploys and rollbacks |
| Exceptions | Expiring, approver ≠ requester | Permanent waivers | Accepted risk must come back |

---

## 🎤 Wrap-up

> "The system is a pipeline whose every stage assumes the previous one can be wrong. Inventory assumes Resource Graph is stale and keeps the newest version. Evidence assumes missing logs hide callers. The executor assumes the snapshot is stale and re-reads, assumes the response can be lost and reconciles, assumes it can crash and records intent first. The verifier assumes evidence missed something and watches for 403s. And prevention waits until the fleet is clean, because a deny policy on a dirty fleet blocks everyone, including my own rollbacks."

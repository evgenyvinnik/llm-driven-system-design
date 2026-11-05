# Storage Misconfiguration Remediation — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → Architecture → Data and API → Pipeline → Screens → Deep dives → Traces → Scale*

> "We need to find and fix insecure settings on tens of thousands of storage accounts (public blob access, shared-key auth, old TLS, open networks, no soft delete, no logs) without breaking the apps that depend on them. I'll design it as a pipeline with a product on top. The pipeline inventories the fleet, evaluates controls, gathers evidence of who uses each insecure path, plans waves, applies changes with verification and automatic rollback, and switches on prevention once a control is clean. The product gives three people what they need to decide: a security engineer starting a campaign, an owner fixing or excepting their account, and an approver accepting risk. The thread through both halves is trust: the backend never trusts a stale snapshot or a lost response, and the frontend never shows a number without saying when it was true."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | "Without breaking apps" drives evidence, waves, bake and rollback |
| Architecture | ~5 min | Scanners, evidence, planner, executor, verifier; API with SSE; PostgreSQL decides |
| Data and API | ~5 min | Findings with evidence classes; targets as a durable state machine; idempotent endpoints |
| Pipeline and screens | ~8 min | How each stage shows up on a screen |
| Deep dives | ~15 min | Safe rollout; evidence and the owner path; crash-safe execution with live progress |
| Traces, checklist, scale | ~7 min | One success, one rollback; what breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions

| Question | Assumption |
|----------|------------|
| Which settings? | Public blob access, shared key, TLS < 1.2, HTTPS only, network access, soft delete, diagnostics |
| What kind of "remediation"? | Security configuration. Data protection, resilience (LRS → ZRS), migration and cost work use the same machinery with different evidence |
| Fleet size? | Illustrative: 40,000 accounts, 2,000 subscriptions, ~1,200 teams |
| Direct changes or tickets? | Direct, by a service identity, under campaigns that a security engineer starts |
| Access logs? | Some accounts send StorageBlobLogs to Log Analytics; many don't |
| Rollback signal? | A rise in authorization failures against the account's own baseline |
| Users? | Security engineers, resource owners, approvers |

### Functional

1. Inventory accounts with tags, properties and child resources (soft delete, diagnostics).
2. Versioned controls → findings with severity and risk.
3. Evidence from logs: safe to fix, needs owner migration (callers named), insufficient evidence.
4. Campaigns with waves, canaries, bake, failure budget; start, pause, resume, kill; live progress.
5. Automatic rollback; exceptions with approver and expiry; owner notifications and self-service fix.
6. Prevention via policy after burn-down; audit trail; posture dashboard.

### Non-functional

| Property | Target |
|----------|--------|
| Safety | Zero unplanned outages; regressions rolled back within minutes |
| Correctness | No double-apply or wrong-value rollback, through crashes and lost responses |
| Platform limits | < 1% of control-plane calls throttled |
| Freshness | Config changes visible within 5 min; full reconciliation daily |
| Dashboard | p95 < 2 s; every number with definition and as-of time |
| Liveness | Campaign events on screen within ~1 s |
| Audit | Every change with before/after, 7 years |

### Capacity (illustrative)

| Quantity | Estimate |
|----------|----------|
| Initial findings | ~110,000 (2.8 per account) |
| Full scan | ~40 Resource Graph pages |
| Writes per control | 5,000-15,000; under an hour of writes |
| Wall clock per control | 1-2 weeks, dominated by bake windows |
| Full logging cost | ~20 TB/day if every account logged every request |

> "Writes are cheap; time and evidence are expensive. That pushes me toward parallelism across controls and tiered evidence, and toward a UI built for watching long rollouts rather than for speed."

---

## 🏗️ Architecture (~5 min)

```
┌───────────────────────────────────────────────────────────────────────┐
│ React UI: posture · findings · account · campaigns (live) ·           │
│           exceptions · controls · audit                               │
└──────────────┬───────────────────────────────────────▲────────────────┘
               │ REST (Idempotency-Key on creates)     │ SSE (snapshots + events)
┌──────────────▼───────────────────────────────────────┴────────────────┐
│ API: sessions, role + team scope in every query, planner, transitions │
└───────┬─────────────────────────┬──────────────────────────┬──────────┘
        │                         │                          │
┌───────▼────────────┐   ┌────────▼─────────┐   ┌────────────▼─────────┐
│ PostgreSQL          │   │ Redis            │   │ Queue                │
│ inventory, findings │   │ token buckets,   │   │ target IDs (hints)   │
│ evidence, campaigns │   │ campaign events, │   │ change events        │
│ targets, audit      │   │ sessions         │   └──────▲──────┬────────┘
└──▲──────▲──────▲────┘   └───▲──────▲───────┘          │      │
   │      │      │            │      │                  │      │
┌──┴────┐ ┌┴─────┴───┐  ┌──────┴──────┴────────┐         │  ┌───▼──────┐
│Scanner│ │ Evidence │  │ Executor + verifier  │◀────────┘  │ Change   │
└──┬────┘ └────┬─────┘  │ + coordinator        │            │ consumer │
   │           │        └──────────┬───────────┘            └────┬─────┘
   ▼           ▼                   ▼                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Resource Graph · ARM (GET, PATCH If-Match, 429) · Event Grid ·        │
│ Azure Policy · Monitor metrics · Log Analytics (StorageBlobLogs)      │
└───────────────────────────────────────────────────────────────────────┘
```

- **Management plane vs data plane.** Inventory and execution spend ARM budget (per subscription, per principal). Evidence spends Log Analytics and metrics budget, which has its own quotas. Separate workers and back-off so neither starves the other.
- **PostgreSQL decides, the queue hints.** The queue carries target IDs; claims, leases, intent and outcomes are rows. Duplicates and redeliveries are no-ops.
- **One API, two channels.** REST for reads and idempotent commands; SSE for one-way campaign progress.

---

## 💾 Data Model and API (~5 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| storage_accounts | ARM ID, name, owner + source, environment, classification, properties, modified_at, child resources | Newest `modified_at` wins |
| findings | (account, control) unique, version, status, severity, risk, evidence class + reason, due_at | Only failures stored |
| usage_evidence | window, has_logs, counts by auth type / TLS / protocol / public IP, top callers, stale | Rollback marks it stale |
| campaigns / waves | control, config, frozen plan, status + reason, idempotency key; ring, acknowledged failures | Plan as approved |
| campaign_targets | state, fence, lease, attempts, throttle count, operation ID, before value, etag, baseline, outcome, bake until | Intent written before the cloud is touched |
| exceptions | status, justification, requester, approver, days, expires_at | One live per (account, control) |
| audit_log | actor, action, before, after, details | Append-only, same transaction |

```
GET  /posture                          GET  /findings?control&owner&evidence&page
GET  /accounts/:name                   POST /accounts/:name/fix        (Idempotency-Key)
POST /campaigns/preview                POST /campaigns                 (Idempotency-Key)
POST /campaigns/:id/start|pause|resume|kill
GET  /campaigns/:id/events  (SSE, Last-Event-ID)
POST /exceptions · /exceptions/:id/approve|reject|revoke
PUT  /controls/:id/policy   (409 BURN_DOWN_INCOMPLETE)
GET  /audit
```

---

## ⚙️ Pipeline and Screens (~8 min)

| Stage | Backend | What the user sees |
|-------|---------|--------------------|
| Inventory | Resource Graph pages + change-feed ARM reads, version-guarded | Freshness banner: last full scan, last feed poll, last change |
| Evaluation | Versioned controls; risk = severity × exposure × classification × in-use | Posture table with compliance, sparklines, evidence mix |
| Evidence | Logs per account: three classes, callers named | Account page evidence panel; "no logs is not no usage" |
| Planning | Rings, canary across subscriptions, ×4 growth, quiet first | Campaign form with a debounced plan preview and exclusions |
| Execution | Claim, re-read, intent, If-Match write, bake, rollback | Live campaign page: counters, waves, events, problem rows first |
| Owner workflow | Daily digests, deadlines, escalation | Notification bell; account page with Fix now / Request exception |
| Exceptions | Approver ≠ requester, capped duration, auto-expiry | Exceptions table with expiries in words |
| Prevention | Policy effect per control; deny guarded by burn-down | Controls page; 409 explained with compliance and open count |
| Audit | Append-only rows for every transition | Audit page filterable by action and account |

### Frontend state

| State | Where |
|-------|-------|
| Session and role | Small global store |
| Findings filters | URL search params (shareable links) |
| Posture, account, exceptions | Route-local, refetched on an interval |
| Live campaign | A hook: snapshot + deduped events + stream mode |
| Intended campaign's idempotency key | Created once per form |

---

## 🔧 Deep Dive 1: Safe Rollout, End to End (~5 min)

**Decision:** blast-radius ordering (non-production first, a canary spread across subscriptions, growth ×4), a bake period per change with a baseline-relative rollback signal, and a failure budget per wave that pauses the campaign. The UI makes each of those visible as it happens.

**Why it works.** Evidence catches most dependencies; waves and bake catch the rest while exposure is small. The rollback trigger needs three things together: at least 5 authorization failures since the change, a rate above 3× the pre-change baseline, and at least 2% of requests. That ignores one stray 403, accounts that were already failing, and noise on very busy accounts. When a wave's failures exceed its budget, the coordinator pauses the campaign with a reason; the UI shows an amber banner with that reason and sorts the rolled-back accounts to the top, each with its trigger ("7 authorization failures since change, 36/min vs baseline 0").

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Rings + canary + bake + auto-rollback + budget | Bounded exposure, regressions undone in minutes | Days per control |
| ❌ Flip everything evidence calls safe | Fast | Evidence misses some; hundreds of outages at once |
| ❌ Riskiest first | Biggest exposures first | First unproven change on the most sensitive data |
| ❌ Wait for owners to report | No plumbing | Detection in days |

**What I give up.** Time, and a blind spot: a job that runs less often than the bake window won't show up during it. Longer-retention platform metrics (93 days, split by authentication type) cover that. I also never put two breaking changes on the same account in one bake window, so a 403 can be attributed.

> "Kill stops new writes; it does not stop rollbacks. The confirmation dialog says exactly that, because people reach for kill in a panic and need to know the safety net stays up."

---

## 🔧 Deep Dive 2: Evidence and the Owner Path (~5 min)

**Decision:** classify every breaking finding from access logs before any change, treat missing logs as its own class, and give owners an account page that explains cause and effect with two safe actions.

**Why "just flip it" breaks production.** Disabling shared key fails every AzCopy job, connection string and service SAS on the account. Public access has anonymous readers. TLS 1.2 breaks old clients at the handshake. Network deny breaks public callers. StorageBlobLogs show AuthenticationType, TLS version, protocol, caller IP, user agent and a key hash, so we can name each caller.

| Class | Rule | In the local fleet |
|-------|------|--------------------|
| Safe to fix | Full window, no dependent requests | 2,273 open findings |
| Needs owner migration | At least one dependent request | 936 |
| Insufficient evidence | No logs, or < 14 days of logs | 965 |

The biggest class of blockers is missing logs, so the first campaign is diagnostics (SA-07): additive, can't break anything, and the prerequisite for every other control.

**The owner path.** One daily digest per team and control. The link opens the account page: current vs desired, the finding's due date, the evidence panel naming the callers, and "Fix now" or "Request exception". Fix now creates a one-account campaign, so it bakes and rolls back like any other change, and the owner watches it live. Exceptions need a justification, a duration under the severity cap, an approver who isn't the requester, and they expire; the finding reopens on its own.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Three classes + account page + fix through the executor | Honest about blind spots; owners see why | Accounts without logs wait a window |
| ❌ Binary used / not used | Simple | No data reads as "not used" |
| ❌ Ticket per finding | Fits existing tools | 110K tickets; muted queues |
| ❌ Direct PATCH for owner fixes | Instant | Skips the safety net for the least-informed actor |

**What I give up.** A month's wait for accounts with no logs, and log cost. In production, metrics triage every account for free and logs are used only to name callers.

---

## 🔧 Deep Dive 3: Crash-Safe Execution and Live Progress (~5 min)

**Decision:** the executor re-reads before every write, records intent durably before the write, writes with If-Match, reconciles unknown outcomes by reading actual state, and shares per-subscription rate limits; the UI follows it over SSE with snapshots that repair anything missed.

**Backend half.**

| Situation | Handling |
|-----------|----------|
| Snapshot is stale | Re-read from ARM; ring moved to prod → escalate; evidence changed → skip |
| 412 on write | Re-read: fixed by someone else → skip; unrelated change → recompute; same property now a different insecure value → escalate |
| 429 | Block the subscription for Retry-After for all workers, halve its rate, back off with jitter; give up after 12 |
| 5xx or timeout | Outcome unknown: read; desired value present → applied; else retry with back-off (longer while throttled), max 5 |
| Crash after write, before record | Intent exists and the account is compliant → `recovered`, no second write |
| Stale worker | Fence on every update; zero rows changed |

The local proof points: killing the executor right after its 60th write left two accounts written but unrecorded; after restart both were `recovered` with one write each. Under a tight simulated limit, halving the rate on 429 cut throttles from 0.88 to 0.29 per write.

**Frontend half.** SSE carries snapshots (counts, waves, recent targets) at most once a second and individual progress events. EventSource resumes with `Last-Event-ID`; the client dedupes by event ID; after three failures it polls every 3 s and says so in the header. Transitions are pessimistic: the badge changes only when the server confirms, because a campaign must never look paused while workers are still writing.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Intent + If-Match + reconcile; SSE snapshots + events | Write-once under failure; live and self-healing UI | More reads; one stream per viewer |
| ❌ Blind PATCH + retries | Fewer calls | Overwrites concurrent changes; can't tell landed from lost |
| ❌ Polling the campaign | Simple | Misses the moment of a rollback; load grows with viewers |
| ❌ Events only | Small messages | One missed event corrupts counters forever |

**What I give up.** About two reads per write, Redis on the write path (if it's down, executors wait), and one long-lived connection per viewer until I multiplex per API instance.

---

## 🛡️ Prevention, Security and Operations (~3 min)

### Prevention order

| Control type | Policy effect | When |
|--------------|---------------|------|
| Additive (soft delete, diagnostics) | deployIfNotExists | Immediately |
| Breaking, insecure value is only a template default | modify | Early, corrects new accounts without rejecting them |
| Breaking, existing callers depend on it | deny | After burn-down (≥ 95%), with exceptions mirrored as policy exemptions |

> "Deny evaluates updates too. On a dirty fleet it blocks every team's redeploy and my own rollbacks, so the API refuses it below 95% and the Controls page explains why."

### Roles and identities

| Actor | Can | Enforced by |
|-------|-----|-------------|
| Security engineer | Create and run campaigns, change policy effects | Role check on each endpoint |
| Resource owner | See own team's accounts, fix now, request exceptions | Team filter inside every query |
| Approver | Approve or reject others' exceptions | Role check + requester ≠ approver |
| Executor | Change storage settings only; no data-plane access | Managed identity with a narrow custom role |
| Evidence worker | Read logs and metrics | Separate read-only identity |

### What I alert on

| Signal | Why |
|--------|-----|
| Rollback denied or gave up | An account may be broken and we can't undo it |
| Campaign auto-paused | A person must decide resume or kill |
| 429 rate > 1% for 10 min | We're competing with other automation |
| Change-feed lag > 10 min, full scan > 26 h | Inventory and dashboards going stale |

### Failure handling

| Failure | Backend | Frontend |
|---------|---------|----------|
| Executor crash mid-write | Lease expires, reconciler requeues, recorded intent → `recovered` | Counters pause, then resume; nothing double-counted |
| Queue message lost | Reconciler re-sends from PostgreSQL | Invisible |
| Resource Graph lag | Newest version wins; deletion only with a margin | Freshness banner explains the source |
| Log Analytics throttled | Evidence pass backs off; no new "safe" without evidence | Evidence panel shows its computed-at time |
| Bad wave | Failure budget pauses the campaign | Amber banner with the reason; problem rows first |
| Rollback blocked by deny policy | Target fails loudly, pages a human | Rollback failure shown in red with the value to restore |
| SSE dropped | Server resumes after Last-Event-ID | Auto-reconnect, dedupe, polling after 3 failures |
| Redis down | Executors wait instead of writing without a budget | Sign-in fails clearly; existing pages keep their data |
| Double click on Create | Same Idempotency-Key → same campaign | Button disabled while pending |

---

## 🧪 Traces (~4 min)

### Successful: create, start, one account verified

```
UI        ─ form prefilled (SA-02, non-prod, safe only), one Idempotency-Key
          ─ debounced preview: 255 accounts, 3 waves (13 / 52 / 190), exclusions shown
API       ─ create: campaign + waves + targets in one transaction → 201
UI        ─ navigate; fetch snapshot; open SSE → "live (SSE)"; Start → running
executor  ─ claim → token → GET (true, E1, env test, evidence safe) → intent → PATCH If-Match E1 → 200
          ─ baking; audit; event "applied"
UI        ─ event in the feed; next snapshot moves the wave bar
verifier  ─ 20 s of 0 auth failures → verified; event "verified"
```

### Failed: a rollback while the viewer is offline

```
executor  ─ canary account with a quarter-end job (last ran 45 days ago) → PATCH → 200
cloud     ─ job runs, 403s
verifier  ─ 7 failures, 36/min vs 0 → rolling_back → PATCH restore (recorded value) → rolled_back
scanner   ─ finding reopened; evidence now shows AccountKey caller → needs owner migration
coordinator ─ wave 2 later: 2 more rollbacks > budget 1 → paused with reason
UI        ─ laptop wakes; SSE reconnects with Last-Event-ID; missed events replayed, deduped
          ─ snapshot: "paused", amber reason banner, rolled-back accounts listed first
owner     ─ digest names the job's caller; account page shows it; Fix later or request exception
```

---

## ✅ Design Review Checklist (~2 min)

1. **Source of truth.** ARM for configuration; PostgreSQL for plans, step state, exceptions, audit; the UI shows only server-confirmed state. A change is applied when ARM returned 200 or a re-read confirms it, and done when the bake verifies it.
2. **Retry after a lost response.** Idempotency-Key on campaign creation and owner fixes; conditional transitions; the executor reconciles lost write responses by reading actual state under the same operation ID.
3. **Failure between steps.** Leases, fences and a reconciler on the backend; SSE resume plus snapshots on the frontend.
4. **Ordering.** One in-flight change per account per control; waves in order; inventory by newest version; UI counters only from snapshots.
5. **Access.** Team scope inside every query (including stream snapshots); the executor's own narrow identity; plan assumptions re-checked at write time.
6. **What breaks first.** Evidence cost, then finding write amplification (every evaluation rewrites every open finding), then human throughput on migrations; on the frontend, one stream connection per viewer.

---

## 📈 Scale (~2 min)

| Pressure | Fix |
|----------|-----|
| Evidence cost | Metrics first, logs only to name callers |
| Findings rewrites per scan | Diff and write changes only; partition by control |
| Posture queries | Precomputed rollups per team and management group |
| Many viewers per campaign | One event subscription per campaign per API instance, fan out in process |
| 110K findings in the UI | Server pagination; filters in the URL |
| Owners' migration backlog | Name the exact caller and key; templates for managed identity + role |
| Several clouds or tenants | One control-plane interface per provider; one findings model |
| Several controls at once | Run in parallel on disjoint accounts; never two breaking changes on one account per bake |

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Impact analysis | Three evidence classes | Flip and watch | Each surprise is an outage |
| Rollout order | Blast radius | Risk order | First change shouldn't hit sensitive data |
| Execution | Re-read + intent + If-Match | Blind PATCH | Crash-safe, conflict-aware |
| Lost responses | Reconcile by read | Retry the call | The platform doesn't dedupe |
| Throttling | Shared buckets + AIMD | Per-worker limits | Limits are per subscription |
| Live progress | SSE snapshots + events | Polling | Rollbacks need immediacy; snapshots self-heal |
| UI for cloud changes | Pessimistic | Optimistic | Never show "paused" while writing |
| Prevention | Deny after burn-down | Deny first | Deny blocks redeploys and rollbacks |
| Exceptions | Capped, approver ≠ requester, expiring | Permanent waivers | Risk must come back |

---

## 🎤 Wrap-up

> "Both halves follow the same rule: assume what you're looking at may be stale or partial, and design so that being wrong is cheap. The executor re-reads before writing and reconciles after losing a response; the verifier assumes evidence missed something; the UI labels every number with its age, repairs itself from snapshots, and routes every button that changes the cloud through the same bake and rollback as the campaigns."

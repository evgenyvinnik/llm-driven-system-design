# Existing System Review: Storage Misconfiguration Remediation

In an **existing system review** round, the candidate presents a system they built and the interviewer probes it: architecture, trade-offs, scale, production issues, monitoring, and what they would change. It rewards depth on one real system over breadth. This round has been reported in BNSF Railway interview loops by candidate reports and preparation guides. That attribution has not been verified; treat it as a practice target.

This file is a **template** and a **worked example**: a 10-minute walkthrough of this project as if you had built and run it, followed by a bank of about 30 likely probes with what a strong answer covers. Replace the worked example's numbers with your own. Every number below is labelled **measured** (from this repository's reference implementation against its simulated fleet) or **illustrative** (an assumed production figure). Say which is which out loud; interviewers probe numbers.

---

## 🧭 Define the Work in the First Minute

"Storage remediation" can mean very different projects. Say which one you mean before anything else, or the interviewer will fill the gap with their own assumption.

| Shape of the work | Example change | Evidence before changing | Regression signal |
|-------------------|----------------|--------------------------|-------------------|
| Security configuration (this example) | Disable shared key, public access, old TLS | Access logs by auth type, TLS, caller | Authorization failures (403) |
| Data protection | Soft delete, versioning, immutability | Storage growth, delete rates | Cost spikes, write latency |
| Resilience | LRS → ZRS or GRS | Region and zone support, app tolerance for conversion | Availability, replication lag |
| Migration | Classic → ARM, region moves | Dependency maps, DNS and endpoint usage | Connection failures |
| Performance or cost | Tiering, lifecycle rules | Access recency per container | Rehydration latency, retrieval cost |

> "When I say storage remediation, I mean security configuration: six settings across about forty thousand accounts, changed without breaking the applications that use them."

---

## 🎯 What the Interviewer Is Scoring

| Signal | What they listen for | How this example shows it |
|--------|----------------------|---------------------------|
| Ownership | Which parts you designed, built and ran | The "already in place / built / would propose" table |
| Judgment | Alternatives you rejected and why they fail here | Three decisions, each with the alternative |
| Depth | Can you go two levels down on any box | One traced operation; the probe bank |
| Production sense | Failures, detection, recovery, what changed | The quarter-end job incident |
| Measurement | Results against a baseline, honestly labelled | The results table |
| Growth | What you'd change now | A short, ordered list |

---

## 🗂️ The Template

| Segment | Time | Cover | Avoid |
|---------|------|-------|-------|
| Problem | 1 min | The specific problem, who felt it, the evidence of impact | Starting with the tech stack |
| Context and role | 1.5 min | Goals and non-goals; what existed, what you built, what you'd propose now | "We" for everything |
| Architecture + one trace | 2 min | One diagram; one operation followed end to end | A tour of every component |
| Three decisions | 2 min | Each with the alternative and why it fails here | Decisions without alternatives |
| Scale | 1 min | Numbers that shaped the design | Numbers you can't source |
| Incident | 1.5 min | What broke, detection, response, what changed after | Blame, or a story with no change |
| Results | 0.5 min | Measured against a baseline | Adjectives instead of numbers |
| Next | 0.5 min | What you'd do differently, in priority order | A wish list |

---

## 🎤 Worked Example: The 10-Minute Walkthrough

### 0:00–1:00 · The problem, who felt it, the evidence

> "Our storage accounts didn't meet the security baseline, and the last attempt to fix that caused an outage. Three groups felt it. The security team had an open audit finding with a deadline: in a sample, about a third of accounts allowed anonymous blob access and most still accepted shared-key auth (illustrative). Application teams had been burned: a script that turned off public access in one subscription took down a partner-facing download page for six hours (illustrative), and after that teams stopped trusting security changes. And compliance couldn't show who changed what, because changes were made by hand from laptops. So the problem wasn't finding misconfigurations; that's one query. It was changing forty thousand accounts without breaking anyone, and proving it."

### 1:00–2:30 · Context, goals, and who did what

Goals: remediate six controls fleet-wide, zero unplanned outages, a complete audit trail, and no regression afterward. Non-goals: data-plane security (encryption keys, private endpoints for every app), and anything that needs code changes in application teams, which we enable but don't do.

| Already in place | What I built | What I'd propose now (not built) |
|------------------|--------------|----------------------------------|
| Resource Graph access; Azure Policy in audit mode; a central Log Analytics workspace for some accounts | Inventory with a version guard; versioned controls; evidence classification; the campaign planner, executor, verifier and rollback; exceptions with expiry; the posture and campaign UI | Platform metrics as the first evidence tier (93-day retention, no diagnostic setting needed) |
| Owner tags on most accounts | Owner workflow: digests, deadlines, escalation, self-service fix | A two-person rule for production waves |
| A ticketing system | Prevention sequencing: deny only after burn-down | Exceptions mirrored as policy exemptions |

> "I'll say 'I' for the pieces I designed and built, and 'we' when I mean the security team's decisions, like the control list and the deadlines."

### 2:30–4:30 · Architecture and one operation, end to end

```
 Resource Graph ─┐         ┌─▶ Evidence workers ◀── Log Analytics / metrics
 Change events ──┼─▶ Inventory ─▶ Evaluation ─▶ Findings (PostgreSQL)
                 │                                     │
                 │        Campaign planner ◀───────────┘ (safe-to-fix only)
                 │               │ waves
                 │               ▼
 ARM (GET, PATCH If-Match) ◀── Executor ──▶ Verifier ──▶ rollback if 403s rise
                                 │              │
                                 └── step state, intent, audit (PostgreSQL)
 UI: posture · findings · account · campaigns (live over SSE) · exceptions
```

**One operation: disabling shared key on one test account in wave 2.**

1. The planner had put it in wave 2 because its logs showed 30 days of OAuth-only traffic (safe to fix) and it was among the quietest accounts in the non-production ring.
2. The coordinator starts wave 2 and enqueues the target's ID.
3. A worker claims the row with a lease and a fence, checks the campaign is still running and no exception was approved since planning, and takes a write token from the subscription's shared bucket.
4. It re-reads the account from ARM (not the scan snapshot): still `allowSharedKeyAccess: true`, still tagged test, evidence still clean.
5. It writes intent to PostgreSQL first: the before-value, the etag, the account's 403 baseline, an operation ID.
6. It sends the PATCH with If-Match on that etag and the operation ID as the client request ID: 200.
7. It records "applied", audits before and after, and the account starts a bake period.
8. The verifier re-reads the property and watches 403s against the baseline. Nothing rises; after the bake it's verified.
9. The change feed updates inventory and the finding resolves. The posture dashboard's burn-down moves on the next snapshot.

### 4:30–6:30 · Three decisions, with the alternatives

**1. Evidence before change, with "insufficient evidence" as its own class.** The alternative was "flip it and see who complains", which is what caused the six-hour outage. The subtle part: an account with no logs shows zero shared-key use, which looks safe. So no logs, or under 14 days of logs, is its own class, and enabling diagnostics became the first campaign, because it's additive and it's the prerequisite for evidence on everything else. Cost: accounts without logs waited a month.

**2. Roll out by blast radius, verify every change, roll back automatically.** Non-production before production, a canary spread thinly across subscriptions, waves growing ×4, a bake per change, and a failure budget per wave that pauses the campaign. The alternative was risk order, riskiest first, which puts the first unproven change on the most sensitive, busiest data. Risk still decides which control runs next and whom we chase. Cost: one to two weeks per control.

**3. Durable intent, conditional writes, reconcile by reading.** The dangerous moment is after the cloud accepted a change and before we recorded it. A naive retry reads the new value and stores it as the before-value, so a later rollback would "restore" the secure value and leave the broken app broken. Writing intent first and never overwriting it makes resume write-once. If-Match turns a concurrent edit into a 412 we decide on, instead of silently overwriting someone. A 5xx or a timeout is "outcome unknown": read the resource before retrying. Cost: about two reads per write and some escalations a human has to resolve.

### 6:30–7:30 · Scale

| Number | Value | Label |
|--------|-------|-------|
| Accounts / subscriptions / owning teams | 40,000 / 2,000 / ~1,200 | Illustrative |
| Failing controls per account at the start | ~2.8 (4,176 findings over 1,500 simulated accounts) | Measured in the simulator |
| Full inventory scan | ~40 Resource Graph pages; 0.4 s for 1,500 accounts locally | Illustrative / measured |
| Writes per control | 5,000–15,000; under an hour of writes | Illustrative |
| Wall clock per control | 1–2 weeks (≈8 waves × 24 h bake) | Illustrative |
| Logs if every account logged every request | ~20 TB/day | Illustrative estimate |

> "The writes were never the bottleneck. Bake time set the schedule, log cost set the evidence strategy, and owner migrations set the long tail."

### 7:30–9:00 · The incident: the quarter-end job

> "Three accounts in the first shared-key campaign had a batch job that authenticated with the account key and ran at quarter end. Its last run was 45 days before the campaign, outside our 30-day log window, so all three were classified safe to fix. In the reproduction, the canary account was changed at 18:27:48; the job ran during the bake, its requests got 403s, and at 18:28:00 the verifier saw seven authorization failures against a baseline of zero, 100% of that caller's requests, and rolled it back. The restore landed 50 milliseconds after the trigger. Wave 2 hit the other two, exceeded its failure budget of one and paused itself. Nobody had to notice anything."

**What actually worried us.** The rollback worked here because the job happened to run inside the bake window. In production the bake is a day and the job runs quarterly; usually it would not. That near miss mattered more than the success.

**What changed afterward** (labelled, because the interviewer will ask which of these exist):

1. *Built:* a rollback marks the account's evidence stale, so it is reclassified (needs owner migration, with the caller named) and drops out of future campaigns until the owner migrates.
2. *Built:* the wave failure budget, which turned three separate rollbacks into one paused campaign and one decision.
3. *Proposed:* platform metrics with 93-day retention, split by authentication type, as the first evidence tier. They would catch quarterly jobs for auth-type controls even on accounts without diagnostic logs.
4. *Proposed:* lookback by control. Auth controls look back 93 days through metrics; TLS and network, which metrics can't show, keep logs plus an owner attestation for jobs that run less often than the window.
5. *Proposed:* a recorded restore window, so one click restores the before-value for 90 days, even after a target is verified.

### 9:00–9:30 · Results against a baseline

| Measure | Baseline | After | Label |
|---------|----------|-------|-------|
| Time to undo a bad change | ~6 h, manual (the earlier script incident) | Detected 9–12 s after the write, restored within 50 ms of the trigger (compressed bake) | Illustrative baseline / measured after |
| Platform 429s per successful write under a tight limit | 0.88 (643 for 729 writes, fixed-rate buckets) | 0.29 (220 for 753 writes, rate halved on each 429) | Measured, same limit |
| Accounts written twice after an executor crash mid-write | Possible by design before intent records | 0 of 6 in-flight targets; 2 recovered without a second write | Measured |
| Open findings in the simulated fleet | 4,174 | 3,148 after two campaigns (shared key non-prod, soft delete fleet-wide) | Measured |
| Unplanned outages caused by remediation | 1 (the script) | 0 (3 regressions, all rolled back automatically) | Illustrative / measured |

### 9:30–10:00 · What I'd do differently, and next

1. Start with metrics as the evidence tier, not logs: cheaper, longer retention, and it would have caught the quarterly job before the campaign (proposed item 3 above).
2. Enforce one breaking change per account across controls, not just per control, so every regression is attributable.
3. Write only changed findings on each evaluation pass; today every pass rewrites every open finding.
4. Add a two-person rule for production waves and mirror exceptions as policy exemptions.

> **Bridge question to close on:** "How did you turn an observed problem into a verified resolution, and which of those decisions would transfer to a different domain, such as rolling out a threshold or firmware change to thousands of railroad wayside detectors?"

---

## 🌉 Answering the Bridge Question

The arc, in one sentence each: an outage and an audit finding (observed problem) → evidence of who depends on each setting (diagnosis) → waves, bake and automatic rollback (controlled change) → findings resolved, rollbacks attributed, burn-down measured against a baseline (verified resolution) → policy so it can't regress (prevention).

| Decision | Transfers to wayside detectors? | How it changes |
|----------|-------------------------------|----------------|
| Evidence before change | Yes | What depends on today's threshold: alarm and stop rates, defects caught, per detector and territory |
| Rings and canaries | Yes | A test territory or low-traffic subdivisions first; canaries spread across detector models and vendors, not one corridor |
| Bake against a per-device baseline | Yes | Alarm rate and missed-defect indicators versus that detector's own history; the bake spans traffic cycles (weekday, weekend, season) |
| Automatic rollback | Partly | Restoring a recorded prior config is the same idea, but safety-critical regressions may need human sign-off and a defined fallback state, not just "previous" |
| Durable intent, reconcile by reading | Yes | Devices on unreliable links: record the intended config first, push with a version, and read the device's reported config back before any retry |
| Shared rate limits, back-off | Yes | Link bandwidth and maintenance windows instead of API quotas |
| Exceptions with expiry | Yes | Detectors that can't take the update yet, with an owner and a date |
| Prevention after burn-down | Yes | Provisioning templates and acceptance tests so new installs ship with the new baseline |

What does not transfer directly: rollback speed (field devices may be offline for hours), the evidence sources, and the safety case. A wrong threshold can mean a missed defect, not a 403, so the failure budget is near zero and regulatory review sits in the loop.

---

## 🧪 Probe Bank

Each probe has a one-line note on what a strong answer covers.

### Architecture

1. **Why PostgreSQL for step state and not the queue?** The queue carries IDs as hints; claims, intent and outcomes need conditional updates and transactions with the audit row; the queue can be rebuilt from the table.
2. **How do scanners avoid overwriting fresh data with stale Resource Graph pages?** A version guard on `lastModifiedAt`: newest observation wins regardless of arrival order; one stale row was skipped in a forced test.
3. **Why re-read ARM in the change consumer instead of trusting the event payload?** Events are hints that can arrive late, out of order or twice; reading current state makes replays harmless.
4. **What's the unit of work, and why?** One account and one control per target; small enough to retry, attribute and roll back independently.
5. **Where do soft delete and diagnostics come from if Resource Graph doesn't have them?** Child-resource ARM GETs on a slower cadence within the read budget, plus change events.
6. **How do you keep two campaigns from fighting over one account?** Planning excludes accounts in another active campaign for the same control; production adds one breaking change per account across controls.

### Trade-offs

7. **Why not just turn on deny policy on day one?** Deny evaluates updates too: it blocks every team's redeploy of an old template and your own rollbacks; additive controls get deployIfNotExists early, breaking ones get deny after burn-down.
8. **Why roll out by blast radius rather than by risk?** The first unproven change shouldn't land on the most sensitive, busiest data; risk picks the control and the owner queue.
9. **Why three evidence classes instead of used / not used?** Missing logs look like non-use; that class is where the worst surprises hide.
10. **Why automatic rollback rather than paging a human?** Detection-to-restore in seconds versus hours; humans review after, and the failure budget pauses the campaign for a decision.
11. **What did the rollback trigger cost you in false positives?** Three conditions (count, multiple of baseline, share of requests), each removing a specific false positive; zero false rollbacks in the demo runs.

### Scale

12. **What breaks first at 10× the fleet?** Evidence cost and query quotas, then rewriting every open finding per scan, then people migrating callers; give the evidence for each.
13. **How do management-plane and data-plane limits differ, and how did you separate them?** ARM, Resource Graph and Policy are throttled per subscription and principal; Log Analytics and metrics have their own per-user quotas; separate workers, concurrency and back-off so evidence never starves writes.
14. **How fast can you go, and what sets the pace?** Writes are fast; bake windows and the failure budget set the schedule; parallelize across controls on disjoint accounts.
15. **How does the dashboard stay fast at 40K accounts?** Precomputed rollups per scope; the page renders aggregates, with a freshness timestamp.
16. **How many executors can you run?** Any number: shared buckets cap writes per subscription; leases and fences keep workers apart.

### Reliability and operations

17. **The resource changed after discovery. What happens?** Re-read before writing; If-Match with the observed etag; on 412 decide: someone fixed it (skip), an unrelated change (recompute), the same property changed to another insecure value (escalate), repeated conflicts (escalate).
18. **The operation succeeded but the response was lost. What happens?** Each write has an operation ID recorded before the call and sent as the client request ID; before any retry, reconcile against actual state; retries are bounded and back off further while the API is throttling.
19. **The executor dies between the write and recording it.** Intent was recorded first; on resume the account is already compliant, so it's recorded as recovered with no second write; measured: 0 double writes.
20. **What happens when you get 429s?** Block the subscription for Retry-After across all workers, halve its rate, add jitter, give up after a bound and count it against the wave; measured 0.88 → 0.29 throttles per write.
21. **How do you know the system itself is healthy?** Alerts on denied or abandoned rollbacks, auto-paused campaigns, 429 rate, change-feed lag and scan age; dashboards with freshness.
22. **What if the rollback itself is blocked?** A deny policy or lock returns 403: the target fails loudly and pages with the value to restore; rollbacks are bounded, never silently dropped.

### Security

23. **What can the executor's identity do?** Change storage account settings, blob service settings and diagnostic settings only, at management group scope; no data-plane access.
24. **How do you stop an owner from seeing or changing another team's accounts?** Team scope inside every query, including live-stream snapshots; self-service fixes check ownership at request time.
25. **Can someone approve their own exception?** No: approver ≠ requester, duration capped by severity, every exception expires and the finding reopens.
26. **How do you prove to an auditor what changed?** An append-only log written in the same transaction as each change, with before and after values and the operation ID, correlated with the platform activity log.

### Improvements

27. **What would you build next?** Metrics-first evidence; one breaking change per account across controls; diff-only findings writes; a two-person rule for production waves.
28. **What would you remove or simplify?** A strong answer names something real: for example, logs as the only evidence source, or a UI view nobody used.
29. **What did the incident change?** Evidence lookback per control, metrics tier, stale-evidence reclassification after rollback, a 90-day restore window.
30. **If you had to hand this off tomorrow, what's the riskiest part?** The rollback path under policy changes and the evidence blind spots; say how you'd test them (game days, injected dependencies).

---

## 🔁 Adapting the Template to Your Own System

1. Write the problem sentence first: what was wrong, who felt it, and one number that proves impact.
2. Draw the ownership table before the architecture. If the "what I built" column is thin, choose a different system or a narrower slice of this one.
3. Pick the one operation you know best and trace it in eight to ten steps, naming the store or service at each step.
4. For each key decision, write the alternative and the specific way it fails in your system, not in general.
5. Choose one incident with a timeline you can defend, and at least one change that came out of it.
6. Find a baseline for every result. "Before" can be the previous system, the previous quarter, or the same test with the old algorithm.
7. Rehearse the probe bank aloud; cut anything you can't answer two levels down.

---

## ⚠️ Common Mistakes

| Mistake | Better |
|---------|--------|
| Opening with the stack ("we used Postgres and Redis…") | Open with the problem and the people it hurt |
| Numbers without provenance | "Measured in the reference build" or "illustrative estimate" |
| Every decision presented as obvious | Name the alternative and how it breaks here |
| An incident with no aftermath | Two or three concrete changes it caused |
| Defending every choice | Concede the weak spots and say what you'd change; it reads as judgment |
| Running out the clock on the walkthrough | Stop at 10 minutes; the probes are where the round is decided |

---

## 🗣️ Delivery Notes

- **Open with the problem and the people,** not the stack. The first sentence should make the interviewer care.
- **Label every number** measured or illustrative. If you can't source a number, round it and say it's an estimate.
- **Say "I" for what you did** and "we" for team decisions; interviewers listen for ownership.
- **Trace one operation** instead of touring components; it proves you know where the hard parts are.
- **Tell the incident with what changed afterward.** A story that ends at "we fixed it" is half a story.
- **Keep a time check.** At minute 5 you should be finishing decisions; leave room for probes, where the round is decided.

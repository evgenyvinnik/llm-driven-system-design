# Experimentation Platform — System Design Answer (Backend Focus)

*Backend engineer interview · 45-60 minutes · Requirements → Architecture → Data model → API → Write path → Assignment → Exposure → Deep dives → Traces → Scale*

> "The prompt is feature flags and A/B experiments: assign variants, deliver config, log exposure, attribute conversions, and a kill switch. The CRUD is easy, so I want to name the traps first. One: assignment has to be a pure function, the same on web, iOS and the server, and a ramp from 10% to 20% must never send a treatment user back to control. Two: assignment is not exposure. Everyone gets assigned the moment an SDK evaluates; only some of them ever see the change, and counting the rest dilutes the effect toward zero. Three: the SDK can never wait on the network to render, yet the kill switch has to land within seconds. Four: events arrive twice, late and out of order, and the analysis must still be exact. I'll split the system into three planes with three different consistency models and spend most of my time on those four problems."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Evaluation is free, delivery is a fan-out problem, analysis is a modest OLAP job |
| Architecture | ~5 min | Control, delivery and data planes with different guarantees |
| Data model and API | ~6 min | Config rows plus immutable versions and snapshots; separate exposure and assignment tables |
| Write path, assignment, identity | ~7 min | One transaction per change; a pure bucketing function; alias at first sign-in |
| Key question | ~4 min | Exposure is a render-time fact, analyzed exposed-only with SRM as the alarm |
| Deep dives | ~15 min | Stable bucket ranges; snapshot delivery and the kill switch; idempotent ingest |
| Traces, checklist, scale | ~8 min | One success, one failure, six review questions, what breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Where does evaluation run? | Decides whether the server is on the render path | In every client SDK, locally, from a downloaded ruleset. Servers use the same code |
| What units do we randomize? | Decides the hash input | User, organization or anonymous device, chosen per experiment |
| What happens when an anonymous visitor signs in? | Growth experiments live in the sign-up funnel | They must keep their variant. I'll propose an identity policy |
| How fast must a kill switch land? | Push vs poll, and the delivery bound | Seconds for connected clients; offline clients catch up on reconnect |
| How fresh must results be? | Streaming counters vs read-time queries | Minutes. Experiments run for weeks |
| Do late events count? | Mobile apps flush days later | Yes, up to 30 days old, on the next read |

### Functional requirements

1. Flags and experiments: key, kind, unit type, 2-6 variants, salt, primary metric, attribution window. Per environment: status (`draft → running → paused ⇄ running → stopped`), targeting rules, weights and a version that bumps on every change.
2. Environments (dev, prod), each with a public client key, a secret server key and its own snapshot sequence.
3. Deterministic assignment shared by server and SDK, with stable ranges when weights change.
4. Compiled, immutable snapshots; ETag revalidation; server push of new versions; a kill switch.
5. Render-time exposure logging, conversions, batched events with retries.
6. Exposed-only analysis: rate per arm with intervals, lift, sample ratio mismatch (SRM), assigned vs exposed.
7. Console: editor with a users-moved preview, audit log, results, live SDK clients and the version each holds. Admin edits, viewer reads.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Evaluation latency | < 1 ms, zero network calls on the render path | Local evaluation from a snapshot |
| Evaluation availability | 100% of renders get an answer, platform down or not | Last known good snapshot, then coded defaults |
| Config propagation | p99 < 5 s to connected clients; ≤ 60 s for polling clients | Push version hints; a bounded fallback when push is lost |
| Assignment stability | Deterministic; a weight change moves only buckets that must move | Bucket ranges, not percentages |
| Console writes | Linearizable per flag, audited in the same transaction | Row locks and optimistic versions |
| Ingest | ≥ 99.9% accepted; a retried batch never double counts | Idempotency at every hop |
| Results freshness | < 5 minutes, late events included | Read-time analysis |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Users | 50M monthly, 10M daily | A large consumer product |
| Concurrent SDK clients | ~2M at peak | Web tabs and foregrounded apps |
| Flags per environment | ~2,000, ~150 running experiments | Flags accumulate faster than they are cleaned up |
| Snapshot | ~400 KB raw, ~60 KB gzip | ~200 B of rules and ranges per flag |
| Evaluations | ~25B/day | All local: zero server cost |
| Config changes | ~1,000/day, bursts of a few per second | One change = one new snapshot version |
| Bytes per change without a CDN | 2M × 60 KB = 120 GB | The real delivery problem |
| Events | ~300M/day, ~3.5k/s average, ~20k/s peak | Exposures, conversions, sampled assignments |
| ClickHouse | ~10 GB/day compressed | Small rows, sorted LowCardinality columns |

> "The numbers tell me where to spend effort. Evaluation costs nothing because it runs on the client. Config delivery is a fan-out and caching problem: one 60 KB change becomes 120 GB of downloads if the origin serves it. Ingest at 20k events a second is routine. The expensive part of analysis is joining conversions to each unit's first exposure."

---

## 🏗️ High-Level Architecture (~5 min)

```
                         CONTROL PLANE (small, strongly consistent, audited)
 ┌───────────┐ session ┌────────────────────────────────────────────┐
 │  Console  │────────▶│ Config API: one txn per change             │──▶ PostgreSQL
 └───────────┘         │ lock config row → If-Match → version+1 →   │    (source of truth)
                       │ history + audit → env snapshot_version+1 → │
                       │ compile → INSERT snapshots (immutable)     │
                       └─────────────────────┬──────────────────────┘
                                             │ after COMMIT
                       ┌─────────────────────▼──────────────────────┐
                       │ Valkey: latest body (forward-only CAS)     │
                       │ PUBLISH exp:snapshots {env, version}       │
                       └─────────────────────┬──────────────────────┘
                         DELIVERY PLANE      │ pub/sub hint     reconcile vs PostgreSQL every 5 s
            ┌────────────────┐   ┌──────────▼─────┐   ┌────────────────┐
            │ edge / api-a   │   │ edge / api-b   │   │ edge / api-n   │  latest snapshot
            │ in-memory snap │   │ in-memory snap │   │ in-memory snap │  per env in RAM
            └───────┬────────┘   └───────┬────────┘   └───────┬────────┘
                    │ GET /snapshot (ETag, 304) · GET /snapshots/:v (immutable, CDN) · SSE {version}
                    ▼
        ┌─────────────────────────────────────────────────────────────────┐
        │ SDKs: browser, Node, server. Local evaluate() with ONE shared   │
        │ core module · last known good · coded defaults · <Exposure>     │
        └─────────────────────────────────┬───────────────────────────────┘
                         DATA PLANE        │ {batchId, sentAt, events[]}  (fetch; beacon on unload)
        ┌─────────────────────────┐   ┌───▼──────────────┐   ┌──────────────────────────┐
        │ Ingest endpoint         │──▶│ Valkey stream    │──▶│ Ingest worker            │
        │ validate · skew-correct │   │ exp:events       │   │ XREADGROUP → INSERT with │
        │ Lua: SET NX + XADD      │   │ (prod: Kafka)    │   │ dedup token → XACK       │
        └─────────────────────────┘   └──────────────────┘   └────────────┬─────────────┘
                                                                           ▼
                     ┌──────────────────────────────────────────────────────────────┐
                     │ ClickHouse: exposures · assignments · conversions            │
                     │ (ReplacingMergeTree) ◀── Results API (read-time) ──▶ Console │
                     └──────────────────────────────────────────────────────────────┘
```

> "Each plane gets the guarantee it needs and nothing more. The control plane is tiny, a few changes a second at worst, so I make it linearizable per flag and audited in the same transaction, and it can be down for minutes without any user noticing, because SDKs keep evaluating. The delivery plane is stateless and read-only: it serves immutable documents and version hints, so every layer can cache it. The data plane is append-only and at-least-once, made exact by idempotent inserts and duplicate-insensitive queries. Locally that is two API instances acting as the edge, one ingest worker, PostgreSQL, Valkey and ClickHouse; a CDN in front of the edge is a production addition."

---

## 💾 Data Model (~4 min)

### PostgreSQL (source of truth)

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| environments | key (PK), client_key, server_key, snapshot_version | unique keys | `snapshot_version` is the per-environment sequence, bumped under its row lock |
| flags | id, key, kind, unit_type, salt, variants (jsonb), default_variant, primary_metric, attribution_window_hours | unique key | Global identity. Salt is random at creation and never changes |
| flag_configs | (flag_id, environment) PK, status, allocation (jsonb ranges), rules, fallthrough, version | PK | One row per flag per environment; its row lock serializes edits |
| flag_versions | (flag_id, environment, version) PK, status, allocation, rules, changed_by | PK | Immutable history; the SRM expectation reads each version's allocation |
| audit_log | id, at, actor, action, flag_key, environment, from/to version, summary | (at), (flag_key, at) | Same transaction as the change; kill switches carry a mandatory reason |
| snapshots | (environment, version) PK, etag, body (jsonb), flag_count, bytes, reason | PK | Never updated; serves `/snapshots/:version` on a cache miss |
| identity_aliases | (environment, user_id) PK, stable_id | PK | First link wins |
| identity_links | (environment, anonymous_id, user_id) PK | (environment, user_id) | Every device id seen signing in as a user |

### ClickHouse (events)

| Table | Sorting key | Partition | Notes |
|-------|-------------|-----------|-------|
| exposures | (environment, flag_key, unit_id, event_id) | month of client_ts | Written only from render-time events. flag_version, variant, unit_id, ts (skew-corrected), client_ts, received_at |
| assignments | same | same | Diagnostic only: compared with exposures on the results page |
| conversions | (environment, event_name, stable_id, event_id) | same | value, anonymous_id, stable_id, org_id; not tied to any experiment |

All three are ReplacingMergeTree with `event_id` in the sorting key and a deduplication window for insert tokens. The sorting key puts one experiment's rows together and each unit's rows next to each other, which is exactly the shape of the per-unit first-exposure aggregation.

### Valkey (derived and transient)

| Key | Purpose |
|-----|---------|
| `exp:snapshot:<env>:latest` (+ `:version`) | Latest compiled body; a Lua compare-and-set only moves it forward |
| `exp:snapshot:<env>:published:<v>` | Publish time and reason (1 day), for propagation latency |
| `exp:snapshots` (channel) | Pub/sub hint `{environment, version, reason, publishedAt}` |
| `exp:events` (group `ingest`) | One stream entry per accepted SDK batch |
| `exp:batch:<env>:<batchId>` | 24 h batch dedup key |
| `exp:clients:<env>` | Live SDK clients: held version, transport, last propagation latency |
| `exp:alias:<env>:<userId>` | 1 h stable-id cache for server-side evaluation |

> "Two choices in this model carry most of the design. Exposures and assignments are separate tables written from separate code paths, so 'assigned but never saw it' is a structural fact, not a flag on a row. And everything the analysis or delivery depends on is immutable: flag versions, snapshots, events. Mutable state is only the current config row and the environment's sequence number, both behind row locks."

---

## 🔌 API Design (~2 min)

Console (session cookie; reads need admin or viewer, writes need admin):

```
POST  /api/v1/flags                                   create: draft everywhere, random salt
PUT   /api/v1/flags/:key/environments/:env            weights / rules / fallthrough; If-Match "<version>" → 409 when stale
POST  /api/v1/flags/:key/environments/:env/status     draft → running → paused ⇄ running → stopped
POST  /api/v1/flags/:key/environments/:env/kill       {reason}: flag → paused, experiment → stopped
GET   /api/v1/flags/:key/environments/:env/versions   full config history
GET   /api/v1/flags/:key/results?env=prod             exposed + assigned analysis
GET   /api/v1/audit · /api/v1/clients?env= · /api/v1/system
```

SDK surface (client key public; server key secret):

```
GET   /sdk/v1/snapshot              latest; ETag "prod-v18"; If-None-Match → 304; Cache-Control no-cache
GET   /sdk/v1/snapshots/:version    immutable; public, max-age=31536000, immutable
GET   /sdk/v1/stream                SSE: hello {version}, snapshot {version} on every change
POST  /sdk/v1/events                batch → 202 {accepted, rejected, duplicate}
POST  /sdk/v1/clients/report        version this instance applied → propagation latency
POST  /sdk/v1/identify   (server)   {userId, anonymousId} → {stableId, created}
POST  /sdk/v1/evaluate   (server)   {context, keys?} → evaluations with the same core module
```

Error contract: 409 `VERSION_CONFLICT` with `currentVersion` on a stale If-Match; 409 for an invalid status transition or editing a stopped experiment (final: a rerun is a new key and salt); 422 for weights over 100% or unknown variants; 403 for a viewer's write regardless of what the UI shows.

---

## ✍️ Control-Plane Write Path and Concurrency (~3 min)

Every console mutation, the kill switch included, is one PostgreSQL transaction:

1. `SELECT … FOR UPDATE` the flag's config row in that environment. Check If-Match against its version.
2. Validate (status allows it, variants exist, weights ≤ 100%) and compute the new bucket ranges from the old ones.
3. Write the config with version + 1, copy it into `flag_versions`, and write the audit entry with a human-readable summary ("moves 10% of units: control→treatment 10%").
4. Bump `environments.snapshot_version … RETURNING`. That row lock is the per-environment serialization point.
5. Read every flag of the environment, compile the snapshot, insert it into `snapshots`.
6. Commit. Only then: put it in this instance's memory (its own streams are pushed at once), compare-and-set the Valkey latest, record the publish time, and PUBLISH the version.

| Race | Mechanism |
|------|-----------|
| Two admins edit the same flag | Config row lock: the second waits, then fails If-Match with 409 and reloads |
| An edit retried after its 200 was lost | Same: the retry carries the old version and gets 409 instead of applying twice |
| Two admins edit different flags in one environment | Both bump the environment row; the second compile sees the first's commit. Versions are gap-free and totally ordered |
| Two publishers finish out of order | Valkey CAS only moves forward; edges and SDKs accept only newer versions |
| A change rolls back | Nothing was published: publish happens strictly after commit |

> "Compiling inside the write is what makes 'version N' mean one exact ruleset forever. If an async compiler built snapshots after commit, two quick changes could be compiled in either order, or a crash could leave a committed change that no snapshot contains. Inside the transaction, a committed change and its snapshot are the same fact. Lock order is always config row, then environment row, so writers can't deadlock. The cost is that compiles in one environment are serialized: about 50 ms at 2,000 flags caps an environment at tens of changes a second, which is far above a human release train."

---

## 🎲 Assignment, Evaluation and Identity (~4 min)

**Bucketing.** bucket = MurmurHash3 of "salt.unitId" mod 10,000; one bucket is 0.01% of units. Each variant owns a set of half-open bucket ranges; a bucket nobody owns is "not allocated" and gets the default without being enrolled.

- MurmurHash3 because it is fast, well mixed and writable identically in a few lines of synchronous JavaScript. The browser can't use async WebCrypto on the render path. It hashes UTF-8 bytes, so a non-ASCII id buckets the same in Swift, Kotlin and JavaScript.
- The salt is per flag, so the same user lands in independent buckets of different experiments.
- Modulo bias (2^32 mod 10,000 = 7,296) shifts any bucket's probability by under 0.0003%: noise.

**Evaluation order** is the whole decision, in one function:

1. Status not running → default, reason `inactive`.
2. No id for the unit type → default, `no_unit`.
3. Rules in order; the first full match decides: `force` a variant (not randomized, so never in the experiment), `exclude`, or `enroll`.
4. No rule matched → the fallthrough: enroll or exclude.
5. Bucket → owning variant → `allocated`, `inExperiment = true` for experiments; no owner → `not_allocated`.

Only `inExperiment` evaluations may log exposure. That keeps every non-random path, QA force lists included, out of the analysis by construction.

**Server-side parity.** There is exactly one implementation of hashing, ranges, targeting and evaluation, in the SDK's core folder. The backend re-exports it for `/sdk/v1/evaluate`, the compiler and the editor preview instead of keeping a copy, so parity is structural. A parity test covers what could still drift: the snapshot's JSON round trip and the SDK client's context handling, on 5,000 random units × 3 flags, plus the hash against an independent BigInt implementation.

### Identity: an anonymous visitor signs in

**Policy: the first anonymous id a user signs in from becomes their stable id.** `user` experiments bucket by the stable id.

```
anon_A browsing ──▶ stableId = anon_A ──▶ bucket(anon_A) = treatment
   │ signs in: shop backend calls POST /sdk/v1/identify (server key)
   ▼
identity_links:   INSERT (anon_A, user_42) ON CONFLICT DO NOTHING      every device recorded
identity_aliases: INSERT (user_42 → anon_A) ON CONFLICT DO NOTHING RETURNING stable_id
   ◀── {stableId: anon_A, created: true} ──▶ same bucket, no flip
later: phone anon_B signs in as user_42 ──▶ alias exists ──▶ stableId = anon_A on every device
```

> "I chose the alias over re-bucketing by user id because the funnel is where growth experiments live. Re-bucketing at sign-in flips each visitor with probability equal to the other arm's share: half of them in a 50/50 test, 90% of treatment in a 90/10 test. They see the UI change mid-funnel, and the flipped ones become crossovers I must drop, exactly the users most likely to convert. With the alias, the experience never changes and post-sign-in purchases attribute to the pre-sign-in exposure. `ON CONFLICT DO NOTHING` makes it race-free and idempotent: two devices signing in at once both get the winner's id, and a retried sign-in returns the same answer. The honest gap: a second device's pre-sign-in exposures belong to its own anonymous unit. `identity_links` records the pairing; resolving it in the warehouse, a ClickHouse dictionary at query time, is a production extension. Until the alias comes back, the SDK keeps bucketing by its current id, so a failed identify never flips anyone, and sign-out rotates the anonymous id so the next person on a shared device is a new unit."

---

## 👁️ The Key Question: Assigned but Never Saw It (~4 min)

**"A user was assigned a treatment but never actually saw it. Should that count as exposure, and how does the system tell the two cases apart?"**

**No, it does not count.** Assignment is a pure function the SDK can compute for anyone; exposure is a fact about what was rendered. The system tells them apart by writing them from two different places into two different tables:

- **Assignment** is logged when the app evaluates a flag, deduped per flag, version and unit. It is diagnostic only.
- **Exposure** is logged only by the render path: the `<Exposure>` component when the variant mounts, or when it scrolls at least half into view. It is refused for anything not `inExperiment` and deduped on flag key, flag version and unit.
- **The analysis reads only exposures.** Assignments run through the same query beside them, so the dilution is visible on the results page.

How the exposure table becomes a result:

1. Per unit, ClickHouse takes the **first exposure**: its variant, config version and time (argMin over event time), plus how many distinct variants the unit was ever exposed to.
2. Conversions of the primary metric are left-joined on the id matching the unit type (stable, anonymous or org). A unit converted if any conversion falls in **(first exposure, first exposure + window]**. A purchase before the unit saw the experiment can't have been caused by it.
3. **Crossovers**, units exposed to more than one variant after a ramp or an identity merge, count toward SRM (they were assigned like everyone else) but are excluded from conversion rates.
4. **SRM** is a chi-square of exposed units per arm, flagged at p < 0.001. The expected split is computed **per config version**: each version's exposed units times that version's share of each variant. A 90/10 → 50/50 ramp then doesn't look like a broken split.
5. Per arm: a 95% Wilson interval; versus control: a pooled two-proportion z-test, an unpooled interval on the difference and a delta-method interval on relative lift.

> "The demo shows why this matters. The rewards-tab experiment assigns about 4,000 visitors and exposes about 480. If I analyzed everyone assigned, the other 88% convert identically in both arms, so a real +20% effect reads as roughly +2% and never reaches significance. On `checkout_cta` the same extra purchases read as about +57% among exposed visitors and about +32% among everyone assigned. The price of exposed-only analysis is fragility: if one arm's exposure path is broken, the arms stop being comparable. So the assignment table earns its keep as a diagnostic. The planted `shipping_banner` bug logs treatment exposure from the onLoad of a slow-loading illustration (3.5 s in the demo), so visitors who leave first are never logged. Its assignments are balanced, p ≈ 0.45, while its exposures come out about 58/42, p ≈ 10⁻¹⁰. Balanced assignments with unbalanced exposures say the bucketing is fine and the logging is broken, which tells the analyst exactly where to look."

---

## 🔧 Deep Dive 1: Stable bucket ranges vs re-partitioning or re-hashing (~5 min)

**Decision.** Store each variant's bucket ranges, not percentages, and recompute them on a weight change so only buckets leaving a shrinking variant change hands:

1. A variant whose weight shrinks releases buckets from the top of its ranges.
2. A variant whose weight grows takes the just-released buckets first (those units are moving anyway), then never-allocated buckets, lowest first.
3. A variant whose weight doesn't shrink never loses a bucket.

**Why it works here.** Bucketing stays a pure function of (salt, unit id, ranges), so the SDK, the server and every device agree with no lookup table. A ramp moves the minimum possible set of units, and the only crossovers are those units, which the analysis can identify and exclude. The editor computes the movement before saving, the server recomputes it, and the audit entry records it.

**Why the alternatives fail.** Measured on 20,000 random units in the allocation tests:

| Change | ✅ Stable ranges | ❌ Re-partition from bucket 0 | ❌ Re-hash (new salt or version in hash) |
|--------|-----------------|------------------------------|-----------------------------------------|
| Treatment 10% → 20% | 10% move, all control → treatment; 0% of treatment leaves | Same (a two-way boundary shift happens to be stable) | ~26% move; ~80% of treatment goes back to control |
| Enrolment 20% → 40% at 50/50 | 0 switch; 20% newly enrolled | 100% of treatment switches to control | ~48% change |
| 34/33/33 → 50/25/25 | 16% move | 24% move; variant b loses twice what it must | ~67% change |

Re-hashing is the tempting one ("make each version independent"). On a 10 → 20% ramp, each unit's old and new buckets are independent, so 26% of everyone changes and only 20% of current treatment units stay in treatment. Their earlier exposures now describe an experience they no longer have, both arms are contaminated, and users watch the button change back. Re-partitioning from zero looks fine on the simplest ramp, which is why it survives code review, then breaks the first time someone raises enrolment: control's new range lays over every former treatment bucket.

**What we give up.** A config is a list of ranges, not two numbers. Ranges fragment after many ramps (treatment owning [5000,6000) and [9000,10000)), which costs a few comparisons per evaluation, and the ranges must be validated for overlaps and bounds. Minimum movement is still movement: those units are crossovers, which is why the SRM expectation must be per version. A team that wants a clean read after a big ramp should start a fresh analysis window at the ramp version.

---

## 🔧 Deep Dive 2: Snapshot delivery and the kill switch bound (~6 min)

**Decision.** Compile in the write transaction; publish after commit with a forward-only CAS; push only `{version}` over SSE via Valkey pub/sub to every edge; clients fetch that exact immutable version; a 5 s reconcile loop against PostgreSQL covers lost pub/sub messages.

**How it flows.** Every edge instance subscribes to `exp:snapshots`. A newer version is loaded (Valkey latest, else the `snapshots` table by version), swapped into memory, and written as `snapshot {version}` to every SSE stream of that environment. The client fetches `/snapshots/:version`, applies it only if it is well formed, for its environment and newer than what it holds, persists it as last known good, and reports the version. The server records propagation as report time minus publish time, per client, in a histogram and the live client view. Streams register before reading the latest version, so a publish in between is pushed rather than lost; `hello {version}` on every connect lets a reconnecting client catch up at once.

**The kill switch** is a status change with a fixed target, a flag to `paused` or an experiment to `stopped`, through the same transaction and publish path, audited as `KILL SWITCH: stopped (reason)`. Every unit then evaluates to the default with reason `inactive`, and no further exposures are logged because nothing is `inExperiment`.

| Client state | Bound |
|--------------|-------|
| Connected, pub/sub healthy | Commit → PUBLISH → edge → SSE frame → one cached GET → re-render: typically about a second |
| Connected, pub/sub message lost | ≤ 5 s: the edge's reconcile loop finds the version in PostgreSQL |
| No stream (polling) | The poll interval (60 s in production) |
| Offline | Keeps its last known good until reconnect, then `hello` triggers an immediate fetch; caches older than 7 days are ignored at cold start |

The end-to-end suite measures it: kill/resume cycles with the console on one API instance and the SDK streaming from the other, so every push crosses Valkey.

**Why it works here.** The stream frame is tiny, so pushing to 2M clients costs the origin almost nothing; the payload goes through a cache because every client asks for the same immutable URL. Fetching by exact version is immune to a load balancer routing the fetch to an edge that hasn't processed the message yet: that edge loads the version on demand. Monotonic apply on the client and forward-only CAS in Valkey mean nothing, not an old CDN copy and not a reordered response, can roll a client back past a kill switch.

**Why the alternatives fail.**

| Approach | How it breaks |
|----------|---------------|
| ✅ Version-only push + immutable fetch + reconcile | Bounded by push latency, or the reconcile interval when a message is lost |
| ❌ Polling only | 30 s polling averages a 15 s kill; 1 s polling is 2M requests a second of mostly 304s |
| ❌ Push full rulesets in the stream | 2M × 400 KB per change straight from the origin, bypassing every cache; a client that missed one push has nothing to diff against |
| ❌ Fetch "latest" after a push | A lagging edge returns the old version; the client stays on it until the next hint arrives |
| ❌ Pub/sub alone, no reconcile | A Valkey restart loses the message, and that edge serves the old ruleset until the next change, possibly hours |
| ❌ Publish before commit | A rolled-back change reaches clients |

**What we give up.** Long-lived connections need heartbeats (15 s pings, a 45 s client watchdog), jittered reconnects and connection-aware load balancing. Each edge reads PostgreSQL every 5 s. And the offline case is a real trade-off: last known good keeps a killed feature alive on a device that never reconnects, while discarding caches eagerly would flip every offline user to defaults. For truly dangerous features, the off path is the coded default and the cache age is short.

---

## 🔧 Deep Dive 3: Idempotent ingest — at-least-once made exact (~5 min)

**Decision.** Accept at-least-once delivery everywhere and make the result exact with layered, coordination-free dedup, each layer covering one specific retry.

1. **The SDK retries with the same batch id.** Batches keep their id and events across retries and restarts (the queue persists to storage). The endpoint runs one Lua script: SET the key `exp:batch:<env>:<batchId>` NX with a 24 h expiry, and only if that succeeded, XADD the batch to the stream. A retry gets 202 `duplicate: true` and is not enqueued.
2. **The worker retries an insert.** It reads up to 200 entries per round and inserts each table's rows with `insert_deduplication_token` = SHA-1 of the table name and entry ids. After a crash it re-reads its own pending entries first, in the same order and count, so the token repeats and ClickHouse drops the block. Only then does it XACK.
3. **Something still slips through.** A dead consumer's entries are claimed with XAUTOCLAIM after 30 s and may be regrouped, which changes the token; an SDK can re-batch events under a new id. ReplacingMergeTree with `event_id` in the sorting key collapses those at merge time. Tables are partitioned by `client_ts`, the raw device time, identical on every retry, so two copies always share a partition and can merge.
4. **Queries don't care.** The analysis uses only duplicate-insensitive aggregates: distinct units, earliest exposure, "any conversion in the window". It is exact before merges; raw row counts use FINAL, and the results page shows raw rows next to distinct events.

**Clock skew and late events.** Every batch carries `sentAt` from the device clock. The endpoint shifts each event by receivedAt minus sentAt: device ordering and spacing survive, but times land on the server clock. Events more than 30 days old or a day in the future after correction are rejected, individually, never the whole batch. Late events need no special path: results are computed at read time, so a conversion arriving six hours late counts on the next read if it falls inside its unit's window.

**Why it works here.** Each layer is local to one hop and needs no distributed transaction. The batch key covers the browser's lost-response retry, the token covers the worker's own retry, the merge covers the rare cross-batch duplicate, and the query shape makes any surviving duplicate harmless.

**Why the alternatives fail.**

- **SET NX and XADD as two calls.** A crash between them leaves a batch marked seen but never enqueued: the SDK's retry is acknowledged as a duplicate and the events are lost. In the reverse order, a crash leaves a batch enqueued but not marked, and the retry enqueues it a second time under new entry ids, so even the insert token can't catch it. One script removes the window.
- **"Exactly-once" pipelines.** A browser cannot know whether a timed-out request was processed, so no transactional pipeline saves you from the first hop; Kafka transactions into ClickHouse still need idempotent edges and add weight.
- **ReplacingMergeTree alone.** It dedups only at merge time, so `count()` is wrong until a merge happens, possibly hours.
- **Partitioning by the corrected time.** `sentAt` differs per retry, so the corrected time does too; near a month boundary two copies could land in different partitions and never merge.
- **Streaming counters.** They can't apply "after the first exposure" when the conversion arrives before a late exposure, and can't un-count a unit that later becomes a crossover.

**What we give up.** Three mechanisms to explain and test. A 24 h batch-key window: a retry after a day would double count, but the SDK gives up long before that. The stream's MAXLEN of about a million batches is a documented loss bound if the worker stays down; alert on lag well before it. And every query that touches raw rows needs FINAL or distinct counts.

---

## 🛡️ Failure Handling (~2 min)

| Failure | Behavior |
|---------|----------|
| Whole platform down | SDKs keep evaluating from memory and storage; a new visitor with no cache gets coded defaults within 300 ms; events queue and retry |
| PostgreSQL down | Console writes return 503; delivery continues from edge memory and Valkey |
| Valkey down | Publish fails but the write is committed and reconcile delivers it; ingest returns 5xx and SDKs retry later |
| Edge instance restarts | SSE clients reconnect with jitter to any instance; `hello {version}` tells them whether to fetch |
| ClickHouse down | Inserts fail, entries stay pending, retried with the same token; results return 5xx; nothing lost while the stream holds |
| Worker crash between insert and XACK | Own pending entries re-read in the same grouping, same token, no duplicate |
| Worker gone for good | Another consumer claims its entries after 30 s; ReplacingMergeTree absorbs regrouping duplicates |
| Corrupt, foreign or older snapshot | Rejected by the SDK; the held version stays |

### Observability

Every API instance and the worker expose Prometheus metrics; the ones I'd put on the first dashboard:

| Metric | What it catches |
|--------|-----------------|
| `exp_snapshot_propagation_seconds{reason}` | Publish → client report, per client: the kill-switch SLO itself |
| `exp_snapshot_version{environment}` | Each edge's in-memory version: a lagging instance is visible at once |
| `exp_snapshot_reloads_total{trigger}` | Reloads triggered by `reconcile` mean pub/sub messages are being lost |
| `exp_snapshot_requests_total{result}` | The 200 / 304 / by-version mix: a low 304 ratio means clients aren't revalidating |
| `exp_ingest_events_total{type,outcome}` | Accepted events, duplicate batches, rejections |
| `exp_worker_stream_lag_entries` | Ingest backlog, long before MAXLEN trimming becomes a loss |

Alerts: propagation p99 over 5 s; an edge more than one version behind for 30 s; reconcile reloads for 5 minutes straight; worker lag growing; SRM flagged on any running experiment; exposure volume of a running experiment halving day over day. The results page also shows raw rows next to distinct events and a late-event count, so data quality sits next to the numbers it affects.

---

## 🧪 Execution Traces (~5 min)

### ✅ Success: a guest sees the treatment, signs in and buys

1. The storefront loads with a cached snapshot v18 and renders immediately. In the background `GET /sdk/v1/snapshot` with `If-None-Match: "prod-v18"` returns 304, and the SSE stream to api-b answers `hello {version: 18}`.
2. `checkout_cta` buckets the anonymous id to 8680, owned by treatment. The SDK queues an assignment event, deduped on flag, version 5 and unit.
3. The product page mounts the buy button inside `<Exposure>`; the SDK queues an exposure (version 5, the anonymous unit).
4. The visitor signs in as carol. The shop backend calls identify with the server key: a link row is inserted and, as her first sign-in, the alias row returns the anonymous id as her stable id. The SDK keeps the same bucket: no flip, no new exposure.
5. Checkout tracks `purchase` and flushes. The batch reaches api-b; validation passes, skew is about zero, the Lua script sets the batch key and appends one stream entry: 202 `{accepted: 3}`.
6. The worker reads the entry, inserts one row each into assignments, exposures and conversions with tokens from the entry id, and XACKs.
7. The results read finds carol's first exposure at treatment v5 and the purchase 40 s later, inside the 72 h window: one unit in treatment's numerator and denominator, and one among the assigned.

### ❌ Failure: a kill switch while pub/sub is lost, with one phone offline

1. Checkout errors spike. Alice pulls the kill switch on `checkout_cta` in prod through api-a. The transaction locks the config, moves it to `stopped` (v6), audits the reason, bumps the environment to 19, compiles and stores snapshot v19, and commits.
2. Valkey restarts at that moment: the CAS and the PUBLISH fail. api-a logs a warning; the write is already durable, and api-a's own memory and streams have v19.
3. api-b never hears the message. Within 5 s its reconcile loop reads `snapshot_version = 19`, loads v19 from the `snapshots` table, swaps memory and pushes `snapshot {version: 19}`.
4. The storefront SDK on api-b fetches `/snapshots/19`, checks it is newer and for prod, persists it and re-renders: control everywhere, reason `inactive`, no new exposures. Its report shows a propagation near the reconcile bound instead of the usual sub-second.
5. A phone that was offline keeps serving v18 until it reconnects; `hello {version: 19}` makes it fetch at once. Offline longer than 7 days, it would start on coded defaults.
6. The phone's queued exposures flush later with their device times. They are late but valid, because they happened before the kill, and the analysis simply ends at the stop.

A second failure worth one sentence: if the ingest worker is killed after ClickHouse commits an insert but before XACK, on restart it re-reads its own pending entries in the same grouping, recomputes the same token, ClickHouse skips the block, and the XACK finally lands. Nothing is counted twice.

---

## ✅ Design Review Checklist

| Question | Answer |
|----------|--------|
| What is the source of truth, and when is a write successful? | PostgreSQL for definitions, configs, history, audit, snapshots and aliases: a console write succeeds when its transaction, compiled snapshot included, commits. Valkey's copy and the pub/sub hint are derived. An ingest call succeeds when the batch is in the stream; ClickHouse is the analytical record once the worker inserts |
| What happens when a client retries after losing the response? | Console: If-Match turns a retried edit into a 409 and a reload. Snapshot fetches are idempotent GETs with ETags. Events: the same batch id hits the Valkey key and returns `duplicate: true`; a re-batched event collapses by `event_id`. Sign-in: `ON CONFLICT DO NOTHING` returns the same stable id |
| What happens when a worker or server fails between two important steps? | Between commit and publish: reconcile finds the snapshot within 5 s. Between SET NX and XADD: impossible, one script. Between insert and XACK: same entries, same token, no-op. Dead worker: XAUTOCLAIM plus ReplacingMergeTree. SDK before sending: persisted queue, same batch ids |
| Which ordering or consistency guarantee is actually required? | Per environment, snapshots totally ordered and clients never go backwards: one row lock serializes compiles, Valkey CAS and SDKs accept only newer. Per flag, linearizable edits. Delivery is eventually consistent with a bound: about a second typical, ≤ 5 s with lost pub/sub. Events need no ordering: event times and argMin make arrival order irrelevant |
| How is access enforced when caches, indexes or async jobs are involved? | Console reads need admin or viewer and every write needs admin, checked server-side per route. Client keys are public and only read their environment's snapshots and append its events; server keys (identify, evaluate) never reach browsers or viewers. Snapshots carry no PII, but rules are readable by any visitor, so sensitive id lists belong in server-side evaluation. The worker has no user surface |
| What breaks first at much larger scale, and what evidence supports it? | Snapshot bytes: 2M clients × 60 KB = 120 GB per change from the origin. Locally a push reaches every stream almost instantly and each fetch is one memory lookup, so CPU isn't the limit; bytes are. Second, the analysis join: ~100 ms locally on ~1k conversions, growing linearly with conversion volume |

---

## ❓ Follow-ups

**Why not evaluate on the server per request?** A remote call per render puts the slowest network hop in front of first paint and turns a flag-service outage into a product outage. Local evaluation costs microseconds and works offline. The price is that the ruleset is visible to clients.

**A developer puts `<Exposure>` in the wrong place. Can the backend catch it?** Not directly, which is why every result carries SRM and the assigned-vs-exposed comparison. Unbalanced exposures with balanced assignments point straight at the logging path.

**How do you run 150 experiments without them interfering?** The per-flag salt makes assignments independent, which is fine for most tests. Mutual-exclusion layers and a global holdout, a second hash in front of the same ranges, are a production extension for when interactions matter.

**What about revenue metrics or peeking?** Out of scope here: one conversion metric, fixed-horizon tests. Continuous metrics, sequential testing and variance reduction would plug into the same per-unit aggregation.

---

## 📈 Scalability (~3 min)

| What breaks | When | Evidence | Fix |
|-------------|------|----------|-----|
| Snapshot download fan-out | Every change × 2M clients | 120 GB per change from the origin | Immutable version URLs behind a CDN (one origin fetch per PoP); version-only pushes; jitter non-kill fetches by up to a second; later delta and per-application snapshots |
| Stream connections | ~2M concurrent | One socket per foreground client | 40-100 edges at 20-50k connections each; pub/sub is one message per change per edge, independent of client count; backgrounded mobile apps poll |
| Analysis join | Conversion volume grows | Every results read scans all conversions of the metric | Production: per-unit rollups in materialized views (first exposure and variant set per unit; conversion times per unit and day); cache finished days |
| Identity resolution | Multi-device users | Second-device pre-sign-in units never merge | Production: sync `identity_links` into a ClickHouse dictionary and resolve unit ids at query time |
| Ingest | Beyond one worker | Single consumer on a Valkey stream | Production: Kafka partitioned by environment and unit, several consumers, 10-50k-row blocks; sample assignments at 10% |
| Control plane | Tens of changes/s per environment | Serialized compiles, ~50 ms at 2,000 flags | Split snapshots by application |

> "The order matters: bytes per change break first, not CPU and not the database. Everything in the delivery design, immutable versions, ETags, version-only pushes, exists so a CDN can absorb that fan-out."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| What counts as exposure | Render-time event, separate table | Log at assignment | Unseen units dilute the effect toward zero |
| Weight changes | Stable bucket ranges | Re-partition / re-hash | Re-hash sends ~80% of treatment back on a 10 → 20% ramp |
| Anonymous → signed in | Alias to the first anonymous id | Re-bucket by user id | No mid-funnel flip; keeps converters in the analysis |
| Evaluation | Local, one shared core module | Remote decision per request | No network on the render path; parity by construction |
| Snapshot build | Compiled inside the write transaction | Async compiler | A version is one exact ruleset; nothing rolled back is ever published |
| Delivery | Version-only SSE + immutable fetch | Polling / pushing rulesets | Seconds-level kill switch, CDN-friendly fan-out |
| Lost pub/sub | Reconcile every 5 s | Durable broker for config events | Bounded staleness, no extra infrastructure |
| Ingest dedup | Batch key + insert token + ReplacingMergeTree | Exactly-once pipeline | Exactly-once from a browser doesn't exist |
| Clock skew | Shift by receivedAt − sentAt | Trust device or arrival time | Keeps device ordering, fixes wrong clocks |
| Analysis | Read-time over raw rows | Streaming counters | Late events, windows and crossovers stay correct |
| SRM expectation | Per config version | Current weights only | A ramp would look like a broken split |
| Interval | Wilson score | Normal approximation | Correct at small n and near 0% |

> "To wrap up: assignment is a pure function of salt, unit and bucket ranges, shared by every SDK and the server, and ranges move only the units that must move. Exposure is a separate fact written only when something renders, and the analysis counts first exposures, excludes crossovers, attributes conversions inside the window and checks SRM per config version, with assignments kept beside it to localize logging bugs. Config is compiled inside the write, delivered as immutable versions with tiny push hints, and bounded by a reconcile loop when a hint is lost. Events are at-least-once and made exact by three local dedup layers and queries that don't care about duplicates. The local build runs all of it: two API instances as the edge, an ingest worker, PostgreSQL, Valkey, ClickHouse, a demo storefront and a traffic simulator that replays an offline cohort hours late."

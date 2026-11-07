# Experimentation Platform — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45–60 minutes · Key question → Requirements → Architecture → Assignment → SDK → Identity → Ingest and analysis → Console → Deep dives → Traces → Scale*

> "Product teams define feature flags and A/B experiments in a console. An SDK in every client evaluates them locally from a versioned snapshot of the ruleset, logs an exposure when a variant actually renders, and tracks conversions. An analysis service joins the two and reports conversion rates with confidence intervals, the lift and a sample ratio check. A kill switch turns anything off on every connected client within seconds. The CRUD is easy. Five things are hard. Assignment must be deterministic and survive weight changes without reshuffling anyone. Exposure is not assignment. The SDK must never need the network to render. Events arrive twice, late and out of order. And a visitor's identity changes when they sign in. I'll answer the key question first, because the rest of the design is built around it."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Key question, requirements | ~7 min | Assignment and exposure are separate events; the three traps; production numbers |
| Architecture, assignment, SDK | ~12 min | Control, delivery and data planes; hash buckets with stable ranges; the startup ladder; render-time exposure |
| Identity, ingest, analysis, console | ~10 min | Alias at first sign-in; batch and insert dedup; exposed-only stats with per-version SRM; move preview and kill switch |
| Deep dives | ~15 min | Exposure end to end; stable ranges and the preview; the kill switch across instances and offline clients |
| Traces, checklist, scale | ~8 min | One success, one failure, the six review questions, what breaks first |

---

## 🔑 The Key Question, Answered First (~2 min)

**"A user was assigned a treatment but never actually saw it. Should that count as exposure, and how does the system tell the two cases apart?"**

> "No. Assignment is a pure function: given the ruleset and a unit id, the SDK can compute a variant for anyone, including people who never get near the feature. Exposure is a fact about what was rendered. So I keep them as two different events, written from two different places in the code, landing in two different tables. The analysis reads only one of them."

| | Assignment | Exposure |
|---|---|---|
| Written by | `client.evaluate()` or `useVariant` when the app asks for a variant | `<Exposure>` (or `useExposure`) when the variant mounts, or when ≥ 50% of it scrolls into view |
| Population | Every enrolled visitor, at session start | Only visitors who reached the surface |
| Dedup | Once per flag, config version and unit | Once per flag, config version and unit, persisted on the device |
| Lands in | ClickHouse `assignments` | ClickHouse `exposures` |
| Used for | The "assigned" column; diagnosing SRM | Conversion rates, intervals, lift, SRM |

How the system tells the two cases apart, and keeps them apart:

1. **Different call sites.** `useVariant` evaluates and records an assignment but never an exposure. Only the component that wraps the rendered variant logs exposure.
2. **Only randomized units can be exposed.** `logExposure` refuses anything that isn't `inExperiment`: coded defaults, forced QA users, excluded units, unallocated buckets and plain flags never produce an exposure.
3. **The results page shows both.** Assigned and exposed counts per arm, side by side, with the lift under each. In the demo, the rewards-tab experiment assigns about 4,000 visitors and exposes about 480. `checkout_cta` shows about +57% relative lift among exposed visitors and +32% among everyone assigned. That gap is the dilution, made visible.
4. **SRM catches unequal exposure logging.** If one arm logs exposures less reliably than the other, exposed counts drift from the configured split while assignment counts stay balanced. That contrast points at the logging path, not the bucketing.

**The three traps in this question**

| Trap | What goes wrong | What I do instead |
|------|-----------------|-------------------|
| Logging exposure at assignment time | Every visitor counts as exposed; unaffected units drag the effect toward zero | Render-time `<Exposure>`; exposed-only analysis |
| Reshuffling users when weights change | A 10% → 20% ramp sends treatment users back to control | Stable bucket ranges: only the buckets that must move do |
| An SDK whose render path depends on the network | A flag-service outage becomes a product outage | Local evaluation and a startup ladder that never blocks render |

---

## 🎯 Requirements (~5 min)

**Clarifying questions (and the answers I'll assume)**

| Question | Assumption |
|----------|------------|
| What gets randomized? | A unit per experiment: `user`, `org` or `anonymous` device |
| How many variants? | 2–6 per experiment with weights; flags are on/off rollouts |
| Which clients? | Web (React) and a Node SDK for servers; mobile follows the same contract |
| What must the kill switch do? | Serve the default to everyone, within seconds on connected clients |
| What metric? | One primary conversion metric per experiment, with an attribution window (72 h in the demo) |
| Who uses the console? | Admins edit, viewers read, and every change is audited |

**Functional**

1. Flags and experiments: key, kind, unit type, variants, salt, primary metric, window. Per environment: a status (`draft → running → paused ⇄ running → stopped`), ordered targeting rules, weights and a version that increments on every change.
2. Environments (`dev`, `prod`), each with a public client key, a secret server key and its own snapshot sequence.
3. Deterministic assignment, identical on server and SDK, stable across devices for signed-in users and stable when weights change.
4. Delivery: compiled immutable snapshots, ETag revalidation, server push of new versions, a kill switch measured in seconds.
5. SDK: local evaluation, last-known-good persistence, coded defaults, never blocking render, render-time exposure with dedup, batched events with retries and an unload beacon.
6. Analysis: exposed-only rates with intervals, lift, SRM, assigned vs exposed, attribution only after first exposure and within the window, late events included.
7. Console: flag list, editor with a users-moved preview, kill switch, audit log, results, and a live view of the snapshot version each SDK client holds.

**Non-functional**

| Property | Target |
|----------|--------|
| Evaluation | < 1 ms in the SDK, zero network calls on the render path |
| Evaluation availability | 100% of renders get an answer, even with the platform down |
| Config propagation | p99 < 5 s to connected clients; ≤ 60 s for clients without a stream |
| Snapshot API | 99.99%, served from memory and a CDN |
| Assignment stability | Deterministic; a weight change moves only the buckets that must move |
| Console writes | Linearizable per flag, audited in the same transaction |
| Ingest | ≥ 99.9% accepted; a retried batch never double counts; events up to 30 days late |
| Results freshness | < 5 minutes |

**Scale (assumptions)**

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| DAU / peak concurrent SDK clients | 10M / ~2M | Config delivery is a fan-out problem |
| Flags per environment | ~2,000 (~150 running experiments) | Snapshot ~400 KB raw, ~60 KB gzip |
| Evaluations | ~25B/day | Must be local; any per-evaluation server cost is unaffordable |
| One config change without a CDN | 2M × 60 KB = 120 GB | Immutable versioned URLs behind a CDN |
| Events | ~300M/day ≈ 3.5k/s average, ~20k/s peak | Small rows; modest for an OLAP store |
| ClickHouse | ~10 GB/day compressed | The expensive part is joining conversions to first exposures |

> "The numbers say evaluation is free because it runs on the client, delivery is a caching problem because one small change becomes millions of downloads, and analysis is a modest OLAP job."

---

## 🏗️ End-to-End Architecture (~4 min)

```
 Console (React SPA) ── session · admin / viewer · polls 1-5 s
        │ PUT config + If-Match · POST status / kill
        ▼
 ┌────────────────────────────────────────────────────────────────────────────────┐
 │ CONTROL PLANE · config API                                                     │
 │ one transaction: config v+1 · flag_versions · audit_log ·                      │
 │ environments.snapshot_version+1 · compile · INSERT snapshot (immutable)        │──▶ PostgreSQL
 └───────────────────────────────────────┬────────────────────────────────────────┘    (truth)
                                         │ after commit: Valkey latest (forward-only CAS)
                                         │ + PUBLISH {env, version} · reconcile every 5 s
 ┌───────────────────────────────────────▼────────────────────────────────────────┐
 │ DELIVERY PLANE · edge instances (stateless) · latest snapshot in memory        │
 └──────┬──────────────────────────────┬───────────────────────────────┬──────────┘
        │ GET /snapshot (ETag → 304)   │ GET /snapshots/:v (immutable) │ SSE {version}
 ┌──────▼──────────────────────────────▼───────────────────────────────▼──────────┐
 │ SDK (browser · Node): local evaluate() · startup ladder · <Exposure> · queue   │
 └───────────────────────────────────────┬────────────────────────────────────────┘
                                         │ {batchId, sentAt, events[]} · sendBeacon on unload
 ┌───────────────────────────────────────▼────────────────────────────────────────┐
 │ DATA PLANE · ingest: validate · skew-correct · Lua: batch key if absent + XADD │
 │ ──▶ Valkey stream (prod: Kafka) ──▶ worker: insert + dedup token ──▶ XACK      │
 │ ──▶ ClickHouse: exposures · assignments · conversions (ReplacingMergeTree)     │
 └───────────────────────────────────────┬────────────────────────────────────────┘
                                         ▼
          Results API: first exposure · window · Wilson · z-test · per-version SRM ──▶ Console
```

> "Three planes, three consistency models. The control plane is small, strongly consistent and audited, and it can be down for minutes without a single shopper noticing, because SDKs keep evaluating. The delivery plane is read-only and stateless: it serves immutable documents and version hints, so it caches everywhere. The data plane is append-only and at-least-once, made exact by idempotent inserts and duplicate-insensitive queries."

---

## 🎲 Deterministic Assignment (~3 min)

**The bucket.** MurmurHash3 (x86, 32-bit) over the UTF-8 bytes of the flag's salt, a dot and the unit id, modulo 10,000. One bucket is 0.01% of units. Each variant owns a set of half-open bucket ranges. A bucket nobody owns is "not allocated": the unit gets the default and is not enrolled.

- **Why MurmurHash3:** fast, good avalanche, and a few lines of pure synchronous JavaScript; the browser can't await WebCrypto on the render path. Hashing UTF-8 bytes rather than UTF-16 code units means an accented id buckets the same in Swift, Kotlin and JavaScript.
- **A per-flag salt** makes experiments independent: one user lands in unrelated buckets of `checkout_cta` and `rewards_teaser`. Changing a salt re-randomizes everyone, so it's allowed only while every environment is still a draft.
- **The unit id follows the unit type:** the stable id for `user` experiments (see Identity), the org id for `org` (signed-out visitors aren't enrolled), the device's anonymous id for `anonymous`.
- **One implementation.** Hashing, allocation, targeting and evaluation live in one shared core that the SDK, the backend and the console all import. A parity test runs 5,000 random units × 3 flags through the SDK client and the server path.

**Evaluation order** (the first decisive step wins):

1. Status isn't `running` → default, reason `inactive`.
2. No id for the unit type → default, `no_unit`.
3. Ordered rules; the first whose conditions all match decides: `force` a variant (not randomized), `exclude`, or `enroll`.
4. No rule matched → the fallthrough enrolls or excludes (`not_targeted`).
5. Bucket → owning variant → `allocated`, with `inExperiment = true` for experiments; no owner → default, `not_allocated`.

> "Only step 5 sets `inExperiment`, and only `inExperiment` evaluations can log exposure. A QA user forced into treatment sees it but never enters the analysis, because they weren't randomized. Every non-random path is excluded by construction, not by a filter someone has to remember."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Hash into buckets; ranges ship in the snapshot | No lookup; works offline; identical on every platform | Ranges need care when weights change |
| ❌ Stored assignment table | Arbitrary assignments | A read per evaluation at 25B/day, and the network back on the render path |

---

## 📱 The SDK (~6 min)

**Startup ladder.** The client always evaluates synchronously from whatever it holds, in this order of preference:

1. The network: the latest snapshot revalidated with `If-None-Match`, then versions the stream pushes.
2. A bootstrap snapshot handed in by the host (server rendering).
3. The last known good snapshot from localStorage, if younger than 7 days.
4. Nothing: each key gets its **safe coded default** (reason `default`, never in an experiment).

`ready()` resolves after the first fetch or a short timeout, whichever comes first, and never rejects. `<ExperimentProvider>` renders immediately when a snapshot is held. With nothing cached it waits at most 300 ms, then renders with defaults rather than a blank page.

> "The network is never on the render path. If a page reads 50 flags and each needed a remote call, first paint would wait for the slowest one, and an outage of the flag service would become an outage of the product. The cost is that a device can be stale, so for a dangerous feature I make 'off' the coded default. Then the worst case of staleness is the safe experience."

**Delivery.** `GET /snapshot` carries `ETag: "prod-v18"`, and revalidation is a 304 with no body. The stream is SSE read with `fetch` and a `ReadableStream`, so the client key travels as a header. It sends `hello {version}` on connect and `snapshot {version}` on every change: a version, never a ruleset. The client then fetches `/snapshots/:version`, which is immutable and cacheable for a year. A snapshot is applied only if it is well formed, for the same environment and **newer** than the one held, so a stale CDN copy or a reordered response can never roll a client back to before a kill switch. Each applied version is persisted as the new last known good and reported to `/clients/report`. A 45 s silence watchdog (the server pings every 15 s), full-jitter reconnects capped at 30 s, and `If-None-Match` polling while the stream is down cover the rest.

**Render-time exposure.**

- `useVariant(key)` evaluates locally, re-evaluates when the snapshot or identity changes, and records an assignment. It never logs exposure.
- `<Exposure evaluation>` logs on mount; with `whenVisible` it waits until an IntersectionObserver reports ≥ 50% in view. `<Experiment flag variants>` renders the chosen variant inside `<Exposure>`, so the common case is one component.
- `logExposure` dedupes on flag key, config version and unit id, persisted on the device. StrictMode double mounts and re-renders are harmless. A new config version is deliberately a new exposure, because SRM reads each exposure's version.

**Events.** Exposures, assignments and conversions share one queue. A batch gets its id once, when it's formed. The queue flushes every 2 s or at 50 events, and retries 408, 429, 5xx and network failures with jittered exponential backoff capped at 30 s, **keeping the same batch id and events** so the server recognizes a retry. A permanent 4xx drops the batch. The queue persists to localStorage, so a crash re-sends on the next visit with the same ids. On `pagehide` or `visibilitychange: hidden`, everything unacknowledged goes out through `sendBeacon` as `text/plain` JSON: no CORS preflight, and the client key rides in the body and the query string. Those batches stay queued until acknowledged, so a beacon followed by a normal resend is just a duplicate batch id, which ingest absorbs.

---

## 🪪 Identity: When a Guest Signs In (~3 min)

```
guest (anon_A) ──▶ stableId = anon_A ──▶ bucket(anon_A) = treatment
     │ signs in: POST /api/v1/shop/login {username, password, anonymousId}
     ▼
shop backend (server key) ──▶ identity service
     identity_links:   record (anon_A, user_42)            every device id is kept
     identity_aliases: user_42 → anon_A, if absent         first link wins
     ◀── stableId = anon_A ──▶ SDK identify: userId user_42, stableId anon_A
                               bucket(anon_A) = treatment   ← no flip
later: phone (anon_B) signs in as user_42 ──▶ alias exists ──▶ stableId = anon_A ──▶ same bucket
```

**Policy: the first anonymous id a user signs in from becomes their stable id**, and `user` experiments bucket by it on every device.

> "Growth experiments live in the sign-up funnel. If I re-bucketed by user id at sign-in, each visitor who signs in would flip with probability equal to the other arm's share: half of them in a 50/50 test, 90% of treatment users in a 90/10 test. They'd see the UI change mid-funnel, and they'd become crossovers the analysis has to throw away. Dropping them is unbiased, since the flip is random, but they're exactly the users most likely to convert. With the alias, the pre-sign-in experience continues and post-sign-in conversions attribute to the pre-sign-in exposure."

What it costs, and where it can fail:

- A lookup at sign-in, which rides along with a request that already goes to a server, and an alias table that grows with users.
- **An honest gap:** a second device's *pre*-sign-in exposures belong to its own anonymous unit. If that device saw the other variant first, it isn't merged with the user. Production would sync `identity_links` into ClickHouse as a dictionary and resolve unit ids at query time.
- **Sign-in response lost:** until the alias arrives, `identify` keeps bucketing by the current stable id, so a failed identify never flips anyone. A retried sign-in gets the same stable id back, because first link wins.
- **Shared devices:** sign-out rotates the anonymous id, so the next person is a new unit.

---

## 📥 Ingest (~3 min)

`POST /sdk/v1/events {batchId, sentAt, sdkInstanceId, events[]}`, as JSON or as `text/plain` from a beacon:

1. Resolve the environment from the client key. Validate the envelope, then **each event independently**: one bad event is rejected and counted, not the whole batch. At most 500 events and 512 KB.
2. **Clock skew.** `skew = receivedAt − sentAt`, the device's clock against ours. Shifting every event by it keeps the device's ordering and spacing but puts the times on the server clock. The raw device time is kept as `client_ts`.
3. Reject events more than 30 days old or more than a day in the future after correction, and duplicate event ids within the batch.
4. **One Lua script:** set the batch key if absent (24 h TTL) and, only if that succeeded, append the batch to the Valkey stream. A retry gets `202 {accepted: 0, duplicate: true}`. There is no window where a batch is marked seen but not enqueued.

The **worker** reads up to 200 stream entries (SDK batches) per round through a consumer group. On start it re-reads its own pending entries first, in the same order and count. It inserts each table's rows with an `insert_deduplication_token` derived from the table name and the entry ids, then XACKs. Every 15 s it claims entries that have sat idle for 30 s on a dead consumer.

| Retry | What catches it |
|-------|-----------------|
| SDK re-sends a batch whose 202 was lost | Batch-id key at the edge, atomic with the enqueue |
| Worker re-inserts after a timeout or a crash before XACK | Same entries → same token → ClickHouse skips the block |
| SDK re-batches events, or a dead worker's entries are regrouped (new token) | ReplacingMergeTree with `event_id` in the sorting key; partitioned by `client_ts`, identical on every copy, so duplicates can merge |
| Duplicates not merged yet | Every analysis aggregate is duplicate-insensitive: distinct units, first times, "any conversion in the window" |

**Late events** need no special path. Results are computed at read time from all rows, so a conversion that arrives six hours late shows up on the next read, as long as it falls inside its unit's window. The results page counts events that arrived more than an hour after they happened.

---

## 📊 Analysis (~3 min)

For one experiment and environment, ClickHouse computes per unit the first exposure's variant, config version and time (`argMin`), plus how many variants the unit was ever exposed to. It left-joins primary-metric conversions on the column that matches the unit type (stable id, anonymous id or org id) and marks the unit converted if any conversion falls in **(first exposure, first exposure + window]**. A purchase before the unit saw the experiment can't have been caused by it. The rest happens in TypeScript:

- **Crossovers** (exposed to more than one variant, because a ramp moved them or two identities merged) count toward SRM but are left out of conversion rates.
- **Rates with 95% Wilson intervals,** which behave at small n and near 0%, unlike p ± 1.96·SE.
- **Lift vs control:** a two-proportion z-test with a pooled standard error for the p-value, an unpooled interval for the absolute difference and a delta-method interval for the relative lift. Significant at α = 0.05, two-sided.
- **SRM per config version:** a chi-square of exposed units per arm against the expected split, flagged at p < 0.001. The expectation sums each version's exposed units × that version's share of each variant, so a 90/10 → 50/50 ramp doesn't look like a broken split.
- **Assigned vs exposed:** the same computation over assignment events, shown beside the real one.

---

## 🖥️ The Console (~4 min)

| Page | Shows | Actions (admin only) |
|------|-------|----------------------|
| Flags | Every flag with each environment's allocation drawn as bucket ranges | Create (draft everywhere, random salt) |
| Editor | Status, weights with current and proposed range bars, the users-moved preview, ordered rules with a "try a unit" evaluator, the definition, version history | Change status, save weights or rules, kill switch with a mandatory reason |
| Results | Arms table with Wilson CI bars and excluded crossovers, assigned vs exposed, the SRM banner, event health (rows vs distinct events, unmerged duplicates, late events) | None |
| Audit | Who changed what, from which version to which, with the move summary | None |
| Live SDK clients | Each SDK's held version, source, "SSE via api-b" or polling, and its last update latency | None; the kill switch links here: "Watch it reach clients" |

**Frontend structure.** React with file-based TanStack Router routes. Pages poll the API, every second on the live clients view and every few seconds elsewhere, so the console never holds a long-lived connection. The editor imports the same allocation core as the server, which is what makes the preview exact. Viewers get the same pages with every control disabled, and the server rejects their writes with 403 regardless of the UI.

**The UI/backend contract**

| Field | Backend meaning | UI use |
|-------|-----------------|--------|
| `config.version` | Increments on every change to this flag in this environment | Sent as `If-Match`; a 409 `VERSION_CONFLICT` makes the editor reload |
| `move` (returned on save) | Exact bucket comparison: changed, switched, transitions | "Saved as v6; snapshot v19 pushed. 10% of units moved." |
| `snapshotVersion`, `publishedAt` | The compiled snapshot this write produced | The kill switch's confirmation, then the live clients view |
| `exposed` / `assigned` | The same analysis over the two event tables | The assigned vs exposed table, with lift under both |
| `srm.flagged`, plus the assigned SRM | Exposed split vs expected; the assigned split as a diagnostic | Red banner; when assignments are balanced, it says to look at exposure logging |
| SDK `source`, `connection` | network, bootstrap, cache or defaults; live, polling or offline | The storefront's inspector and the live clients view |

---

## 💾 Data Model (~2 min)

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| flags (PG) | id, key, kind, unit_type, salt, variants, default_variant, primary_metric, attribution_window_hours | unique key | Salt fixed once any environment leaves draft |
| flag_configs (PG) | (flag_id, environment), status, allocation (ranges), rules, fallthrough, version | PK | The row lock serializes edits to one flag |
| flag_versions (PG) | (flag_id, environment, version), status, allocation, rules, changed_by | PK | Immutable history; SRM reads each version's allocation |
| environments (PG) | key, client_key, server_key, snapshot_version | unique client and server keys | Bumped under its row lock: the per-environment sequence |
| snapshots (PG) | (environment, version), etag, body, bytes, reason | PK | Immutable compiled rulesets, never updated |
| audit_log (PG) | actor, action, flag_key, environment, from/to version, summary | (at), (flag_key, at) | Written in the same transaction as the change |
| identity_aliases / identity_links (PG) | (environment, user_id) → stable_id; (environment, anonymous_id, user_id) | PKs; links by (environment, user_id) | First link wins; every device id is recorded |
| exposures, assignments (CH) | event_id, flag_key, flag_version, variant, unit_id, ts, client_ts, received_at | sorting key (environment, flag_key, unit_id, event_id) | ReplacingMergeTree, partitioned by month of `client_ts` |
| conversions (CH) | event_id, event_name, stable_id, anonymous_id, org_id, value, ts | sorting key (environment, event_name, stable_id, event_id) | Joined to first exposures at read time |

> "The ClickHouse sorting key puts one experiment's exposures together and each unit's rows next to each other, which is exactly the shape of the per-unit first-exposure aggregation. Valkey holds only derived or transient state: the latest snapshot, the pub/sub channel, the event stream, batch keys, live clients and sessions."

---

## 🔌 API (~2 min)

```
Console (session cookie; reads: admin or viewer; writes: admin)
POST /api/v1/auth/login · /logout             GET /api/v1/auth/me
GET  /api/v1/flags                            every flag with each environment's config
POST /api/v1/flags                            create: draft everywhere, random salt
PUT  /api/v1/flags/:key/environments/:env     {weights?, rules?, fallthrough?} + If-Match → 409 if stale
POST /api/v1/flags/:key/environments/:env/status   {to}       draft → running → paused ⇄ running → stopped
POST /api/v1/flags/:key/environments/:env/kill     {reason}   flag → paused, experiment → stopped
GET  /api/v1/flags/:key/environments/:env/versions
GET  /api/v1/flags/:key/results?env=prod      exposed and assigned analysis, event health
GET  /api/v1/audit · /api/v1/clients?env= · /api/v1/system

SDK (public client key; secret server key for identify and evaluate)
GET  /sdk/v1/snapshot                 latest; ETag "prod-v18"; If-None-Match → 304
GET  /sdk/v1/snapshots/:version       immutable; cacheable for a year
GET  /sdk/v1/stream                   SSE: hello {version}, snapshot {version, reason, publishedAt}
POST /sdk/v1/events                   {batchId, sentAt, events[]} → 202 {accepted, rejected, duplicate}
POST /sdk/v1/clients/report           {sdkInstanceId, version, source, transport} → {latencyMs}
POST /sdk/v1/identify      (server)   {userId, anonymousId} → {stableId, created}
POST /sdk/v1/evaluate      (server)   {context, keys?} → {snapshotVersion, stableId, evaluations}
```

---

## 🔧 Deep Dives (~15 min)

### Deep dive 1: Exposure vs assignment, from the component to the results page

**Decision.** The UI emits exposure where the variant renders; evaluation emits assignment. Both travel the same pipeline into separate tables, and the analysis runs on exposures while showing assignments beside them.

**Why it works here.** Follow one experiment through the stack. At session start the storefront calls `evaluateAll()`, so every enrolled visitor produces an assignment. `<BuyButton>` reads `useVariant('checkout_cta')` and wraps the button in `<Exposure>`, so only a visitor who opens a product page logs an exposure: about 45% of them. The rewards banner sits on a tab most visitors never open, so it uses `whenVisible`, and only about 12% are exposed. Both event types share batching, retries and dedup; the worker routes them to `assignments` and `exposures`. The results query runs once per table with identical attribution logic, and the console renders the two side by side. An experiment answers "did seeing B instead of A change behavior?", and only units that saw one of them can carry that effect. This is valid because both arms see the same product up to the exposure point, so whether a visitor reaches the surface can't depend on their arm. That's the rule for placing exposure: where the experience first diverges.

**Why the alternative fails.** Log exposure at assignment time and every visitor is "exposed". For the rewards tab that's ~4,000 units, of which ~480 saw anything. The other 88% convert at the same rate in both arms, so the measured lift is the true lift times ~0.12, buried in the noise of 3,500 unaffected units. A real +20% effect reads as about +2% and is never significant. A team that compensates by running longer ships a "flat" result that was never flat. `checkout_cta`, where about half the assigned visitors are exposed, shows the same dilution: about +57% among exposed visitors and about +32% among everyone assigned, because the same extra purchases are spread over twice as many units.

**What I give up.** Exposed-only analysis is more sensitive, and more fragile: exposure must be logged correctly *in every arm*. The demo's deliberately broken `shipping_banner` shows how that breaks. Control logs on mount, but the treatment logs from the `onLoad` of an illustration served by a slow CDN (3.5 s in the demo), so visitors who leave or check out first are never logged. Reaching the logging point now depends on the arm, which is exactly the condition that made exposed-only analysis valid. Its assignments are balanced (p ≈ 0.45) while its exposures come out ~58/42 (p ≈ 10⁻¹⁰). The SRM banner says not to trust the result and, because assignments are balanced, that the bug is in the exposure path. Developers must also place `<Exposure>` where the change is actually visible. `<Experiment>` and `whenVisible` make that easy, but the SDK can't enforce it. That's why I keep assignment events at all, even though they're only diagnostic: they tell a logging bug apart from a bucketing bug.

### Deep dive 2: Stable bucket ranges, and the editor's users-moved preview

**Decision.** Weights are stored as bucket ranges, not percentages. On a change, each shrinking variant releases buckets from the top of its ranges. Each growing variant takes the just-released buckets first, since those units are moving anyway, then never-allocated buckets, lowest first. A variant whose weight doesn't shrink never loses a bucket. The editor runs the same allocator in the browser before saving.

**Why it works here.** Bucketing stays a pure function of salt, unit id and ranges. Ramping treatment from 10% to 20% moves exactly the 10% of units that must move, all from control, and **0% of treatment leaves**. Treatment users' earlier exposures still describe the experience they have. The only crossovers are the moved control units, which the analysis identifies and excludes. On the frontend, the weights editor turns the typed percentages into buckets, runs the shared allocator on the current ranges, and draws current and proposed bars. It prints "This change moves 10% of units, 0% of current treatment units out of treatment", with both naive strategies' numbers in a table below. Saving is a PUT with `If-Match` on the config version. The server recomputes the allocation and the exact move inside the transaction and writes the summary to the audit log.

**Why the alternatives fail** (measured on 20,000 random units):

| Change | ✅ Stable ranges | ❌ Re-partition from bucket 0 | ❌ Re-hash (new salt, or version in the hash) |
|--------|------------------|-------------------------------|-----------------------------------------------|
| Treatment 10% → 20% | 10% move, all control → treatment; 0% of treatment leaves | Same: a two-variant boundary shift happens to be stable | ~26% move; ~80% of treatment goes back to control |
| Enrolment 20% → 40% at 50/50 | Nobody switches; 20% newly enrolled | 100% of treatment switches to control | ~48% change |
| 34/33/33 → 50/25/25 | 16% move | 24% move | ~67% change |

> "Re-hashing is the tempting 'make each version independent' idea, and it's the worst. On a simple ramp, four out of five treatment users see the button change back, and their earlier exposures now describe an experience they no longer have. Both arms are contaminated. Re-partitioning from zero survives the ramp everyone tries first, a two-variant boundary shift. Then it breaks the first time someone raises enrolment or rebalances three arms."

**What I give up.** A config is a list of ranges, not two numbers. It fragments after many ramps, so treatment can end up owning two separate ranges, and it has to be validated: no overlaps, everything inside [0, 10,000). Minimum movement is still movement. The moved units are crossovers, and the SRM expectation must be computed per config version, or a ramp looks like a broken split. A team that wants a clean read after a large ramp should start a fresh analysis from the ramp version. And the preview stays honest only because the console imports the exact allocator the server runs. A separate frontend implementation could drift silently.

### Deep dive 3: The kill switch across two API instances and offline clients

**Decision.** The kill switch is a status change with a fixed target: a flag goes to `paused` (resumable) and an experiment to `stopped` (final). It takes the same path as any edit. One transaction compiles a new snapshot and commits, then the instance publishes the version over Valkey pub/sub. Every edge instance pushes `snapshot {version}` over SSE, clients fetch that exact immutable version, and a reconcile loop against PostgreSQL every 5 s covers lost messages.

**Why it works here.** Locally the console talks to api-a and the storefront streams from api-b, so every push crosses Valkey. After commit, api-a moves Valkey's latest pointer forward with a compare-and-set, records the publish time and publishes. api-b's subscriber loads that version, swaps its in-memory copy and writes the frame to each of its streams. The SDK fetches `/snapshots/19`, applies it because it's newer, persists it, and React re-renders. Every unit now evaluates to the default with reason `inactive`, and because `inExperiment` is false, no new exposures are logged. The client reports the version it holds, and the server computes propagation as report time minus publish time, per client, for the live view and a histogram. The bound I state: about a second for a connected client; at most the 5 s reconcile interval when a pub/sub message is lost; the poll interval for a client without a stream; and "on reconnect" for an offline one. The e2e suite measures this over repeated kill and resume cycles, so it's evidence, not an assertion.

**Why the alternatives fail.**

- **Polling only.** At a 30 s interval the average kill takes 15 s. Polling every second to get seconds-level kills is 2M requests per second, almost all of them 304s.
- **Pushing the full ruleset.** Every change becomes 2M × 60 KB ≈ 120 GB from the origin, bypassing every cache, and a client that missed one push has nothing to diff against.
- **Fetching "latest" after a push.** The load balancer can route the fetch to an instance that hasn't processed the message yet, which returns the old version. Fetching *by version* is immune: any instance loads v19 from Valkey or PostgreSQL on demand.
- **Trusting pub/sub alone.** It's a hint, not a log. A Valkey restart or a subscriber mid-reconnect loses the message. Without reconcile, that instance's clients would keep the killed treatment indefinitely.

**What I give up.** Long-lived connections need heartbeats, a watchdog, reconnect jitter and connection-aware load balancing, and mobile platforms suspend them in the background. The delivery bound becomes "push latency, or the reconcile interval when a message is lost". The hardest cost is offline devices. A phone that's offline keeps serving its last known good snapshot, so a killed feature stays alive there until it reconnects; then `hello {version}` makes it catch up at once. A cache older than 7 days is ignored at the next cold start. Discarding caches more eagerly would flip every briefly offline user to defaults, so for truly dangerous features I ship "off" as the coded default and shorten the cache age.

---

## 📜 Execution Traces (~5 min)

### Successful trace: guest → exposure → sign-in → purchase → attribution

1. **Storefront loads.** The anonymous id `anon_c395…` comes from localStorage. The client finds last-known-good v18 (source `cache`), so the provider renders immediately. In the background, `GET /snapshot` with `If-None-Match: "prod-v18"` returns 304 and the source becomes `network`. The stream to api-b opens with `hello {version: 18}`.
2. **Assignment.** `evaluateAll()` buckets `checkout_cta`: MurmurHash3 of the salt and `anon_c395…`, mod 10,000, is 8680, which treatment owns. One assignment event is queued, deduped on flag, version 5 and unit.
3. **Exposure.** The visitor opens the kettle. `<BuyButton>` renders "Buy now · free shipping" inside `<Exposure>`, and on mount `logExposure` queues an exposure for version 5.
4. **Sign-in.** They sign in as carol. The shop backend links `anon_c395… → carol`. It's her first sign-in, so the stable id stays `anon_c395…` and `identify` keeps bucketing by it. The button stays "Buy now", and no new exposure is logged (same unit, same version).
5. **Purchase.** Checkout calls `track('purchase', {value: 89})` and flushes. The batch reaches api-b: validation passes, skew is ~0, and the Lua script sets the batch key and appends one stream entry. 202 `{accepted: 3}`.
6. **Worker.** It reads the entry, inserts one row each into assignments, exposures and conversions with tokens derived from the entry id, and XACKs.
7. **Results.** Carol's unit's first exposure is treatment at v5. The purchase came 40 s later, inside the 72 h window, so she's converted. She counts once in treatment's numerator and denominator, and once among the assigned.

### Failed trace: a kill switch while pub/sub is lost, with one SDK offline

1. **Kill.** Checkout errors spike. Alice pulls the kill switch on `checkout_cta` in prod through api-a. The transaction moves the config to `stopped` (v6), audits "KILL SWITCH: stopped (checkout errors)", compiles snapshot v19 and commits. The write has succeeded.
2. **Valkey restarts at that moment.** The forward-only set and the publish fail. api-a logs a warning, but its own memory already holds v19, so its local streams get the push immediately. Event batches that SDKs send during the restart get 5xx and are retried later with the same batch ids.
3. **api-b never hears about it.** Within 5 s its reconcile loop reads `snapshot_version = 19` from PostgreSQL, loads v19 from the `snapshots` table, swaps memory and pushes `snapshot {version: 19}`. Its reconcile-reload counter increments, which is the alert that messages are being lost.
4. **The storefront applies it.** Its SDK fetches `/snapshots/19`, applies it (newer, same environment), persists it and re-renders. Everyone gets control with reason `inactive`, and no new exposures are logged. It reports v19 to the live view.
5. **The offline phone doesn't.** It keeps evaluating cached v18 and showing treatment. On reconnect, `hello {version: 19}` makes it fetch v19 at once. Had it been offline longer than 7 days, its next cold start would ignore the stale cache and serve the coded defaults.
6. **Its queued events flush late.** They carry device timestamps; skew correction puts them on the server clock, and the read-time analysis includes them. Exposures the phone logged while offline are true exposures, because it really rendered the treatment, and the event-health panel counts them as late.

---

## ✅ Design Review Checklist (~3 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL holds definitions, configs, version history, audit, snapshots and aliases. A console write succeeds when its single transaction commits: config, history, audit and compiled snapshot together. Valkey's copy and the pub/sub message are derived and may be lost. An ingest call succeeds when the batch is in the Valkey stream (AOF on); ClickHouse is the analytical record once the worker inserts. The UI treats a change as done only after the 2xx, then reloads |
| Client retries after losing the response? | Console: `If-Match` on the version, so an edit retried after a lost 200 gets 409 and reloads instead of applying twice. Snapshot fetches are idempotent GETs. Events: the same batch id hits the key and gets 202 duplicate; a re-batched event collapses by `event_id` and never changes distinct-unit counts. Sign-in: first link wins, so a retry returns the same stable id |
| Failure between two important steps? | Between commit and publish: the snapshot is in PostgreSQL, and every instance's reconcile finds it within 5 s. Between batch key and enqueue: impossible, it's one Lua script. Between insert and XACK: the worker re-reads its own pending entries in the same grouping, gets the same token, and ClickHouse drops the repeat. A dead worker's entries are claimed after 30 s, and ReplacingMergeTree absorbs regrouping duplicates. Between queueing and sending in the SDK: the queue is in localStorage and re-sent with the same batch ids |
| Which ordering or consistency is required? | Per environment, snapshots are totally ordered and clients never go backwards: one row lock serializes compiles, and the Valkey CAS, the edges and the SDKs accept only newer versions. Per flag, edits are linearizable (row lock + If-Match). Delivery is eventually consistent, with a bound. Events need no ordering at all: the analysis uses skew-corrected event times and first-time aggregates |
| Access with caches and async jobs? | Console reads need admin or viewer, and every write needs admin, checked per route on the server. Client keys are public by design and can only read their environment's snapshots and append its events. Server keys (identify, evaluate) never reach browsers or viewers. Caching is safe because a snapshot is identical for every client of an environment: the CDN and edge memory can serve it to anyone holding that environment's client key. It holds no PII, but rules and explicit id lists are readable by any visitor, so sensitive lists belong in server-side evaluation. The alias cache in Valkey is read only behind the server key, and the worker has no user-facing surface |
| What breaks first, and the evidence? | Snapshot bytes per change: 2M clients × 60 KB = 120 GB from the origin, hence immutable version URLs on a CDN and version-only pushes. Locally a kill switch reaches every stream within milliseconds and each fetch is an in-memory lookup, so origin CPU isn't the issue; bytes are. Second, the analysis join: each results read scans every conversion of the metric, about 100 ms locally on ~1k conversions and linear in conversion volume |

---

## 🚨 Failure Handling (~2 min)

| Failure | Backend | UI |
|---------|---------|----|
| Platform API down | SDKs evaluate from memory and storage; events queue and retry | Storefront unaffected; a new visitor with no cache gets defaults after ≤ 300 ms |
| PostgreSQL down | Console writes return 503; delivery continues from memory and Valkey | The editor shows the error; nothing changes for shoppers |
| Valkey down | Publish fails but the write committed, and reconcile covers it; ingest returns 5xx, so SDKs retry | Console sign-in is unavailable while it's down (sessions live there) |
| Edge instance restarts | Its SSE clients reconnect with jittered backoff to any instance; `hello` tells them whether to fetch | Live clients view shows "reconnecting", then SSE via another instance |
| ClickHouse down | Entries stay pending in the stream and are retried with the same token | Results return an error; nothing is lost while the stream holds |
| Corrupt or foreign snapshot | The SDK rejects it and keeps the previous one | Nothing visible |
| Worker down past ~1M queued batches | The stream trims its oldest entries: a documented loss bound | The worker-lag alert fires long before that |

---

## 📈 Scale (~2 min)

None of this is built. It's the path, in the order things break:

| Order | What breaks | Next step |
|-------|-------------|-----------|
| 1 | Snapshot downloads: 2M × 60 KB per change | A CDN on immutable version URLs (one origin fetch per PoP); jitter non-kill fetches by up to a second; later delta and per-application snapshots |
| 2 | ~2M concurrent SSE connections | 40–100 edge instances at 20–50k connections each; pub/sub is one message per instance per change, regardless of client count; backgrounded mobile apps poll or use push notifications |
| 3 | The analysis join scans every conversion | Materialized per-(experiment, unit) and per-(metric, unit, day) rollups; cache finished days and recompute only the open window, so results cost O(units), not O(events) |
| 4 | Identity merging | `identity_links` as a ClickHouse dictionary, resolving unit ids at query time |
| 5 | Ingest | Kafka partitioned by environment and unit, several workers, 10–50k-row inserts; sample assignment events at 10% |
| 6 | Experiment interaction at ~100 concurrent tests | Mutual-exclusion layers and a global holdout: a second hash layer in front of the same allocation |

> "The control plane comes last. Even ten changes a second is tiny for PostgreSQL. Compile time grows with flag count, which is a reason to archive stale flags, not to shard."

---

## ⚖️ Trade-offs Summary

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Render-time exposure, exposed-only analysis | Measures the people who could be affected | Fragile if one arm logs worse; needs SRM and assignment diagnostics |
| ❌ Exposure at assignment | Trivial to log | Dilutes a +20% effect to ~+2% on a rarely visited surface |
| ✅ Stable bucket ranges | A 10% → 20% ramp moves 10%, and no treatment user leaves | Ranges fragment; per-version SRM needed |
| ❌ Re-hash / re-partition | Simpler config | ~80% of treatment leaves / 100% switches on an enrolment ramp |
| ✅ Alias to the first anonymous id | No flip mid-funnel; converters stay analyzable | A lookup at sign-in; a second device's pre-sign-in unit stays unmerged |
| ❌ Re-bucket by user id | No alias table | Flips half of a 50/50 test's sign-ins |
| ✅ Local evaluation + startup ladder | No network on render; survives outages | Rules visible to clients; offline devices go stale |
| ✅ Version-only SSE + immutable fetch + 5 s reconcile | Seconds-level kill; CDN-friendly; lost messages bounded | Long-lived connections to operate |
| ❌ Polling / pushing full rulesets | No connections to manage | 15 s average kill at 30 s polling / 120 GB per change from the origin |
| ✅ Batch key + insert token + ReplacingMergeTree | Exact counts from at-least-once delivery | Three mechanisms; distinct counts or `FINAL` in every raw query |
| ❌ Exactly-once pipeline | One guarantee on paper | Doesn't exist from a browser; the edges still need idempotency |
| ✅ Read-time analysis | Late events, windows and crossovers correct by construction | Cost grows with data; rollups needed at scale |
| ✅ Wilson intervals, per-version SRM | Correct at small n; ramps don't raise false alarms | More to explain on the results page |
| ✅ Console polling | One read path; easy to screenshot and test | Seconds of staleness |

---

## 📝 Wrap-up (~1 min)

> "The design rests on one distinction: assignment is a computation, exposure is a fact. The SDK computes assignment locally from a snapshot, so rendering never waits on us. It logs exposure only where a randomized variant actually appears on screen. The analysis counts exposed units from their first exposure, and the results page puts the assigned numbers beside them, so dilution is visible and SRM catches a broken exposure path. Bucket ranges stay stable through ramps, and the editor shows exactly who moves before anyone saves. A kill switch is just another snapshot version, pushed as a hint, fetched immutably, and reconciled when the hint is lost. Next steps: a CDN, per-unit rollups for the analysis, and identity resolution in the warehouse."

### How the local implementation compares

| Production | Local |
|------------|-------|
| CDN in front of immutable snapshot URLs | The API instances are the edge; cache headers are set as production would use them |
| Kafka and many ingest workers | A Valkey stream and one worker |
| SSO for the console | Session auth with admin, viewer and shopper roles |
| Mobile SDKs with push-notification fallback | Browser and Node SDKs from one client class |
| Rollups, CUPED, sequential testing, many metrics | Read-time analysis of one primary conversion metric |
| identity_links resolved in the warehouse | Links stay in PostgreSQL |

Two API instances (the console on one, the storefront on the other, so every push crosses Valkey), one ingest worker, PostgreSQL, Valkey and ClickHouse run in Docker, with six seeded flags and experiments in two environments. A traffic simulator drives 4,000 virtual visitors through a Node SDK client, producing about 16,000 events plus an offline cohort that replays events hours late. Implemented: the shared evaluation core with parity tests, stable range allocation with movement accounting, compile-in-transaction snapshots with forward-only publish and reconcile, ETag and immutable URLs, SSE fan-out across instances, the SDK's startup ladder, monotonic apply, persisted queue and beacon, render-time exposure, atomic batch dedup, the insert-token worker, and the statistics with per-version SRM.

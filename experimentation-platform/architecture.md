# Experimentation Platform - Architecture

## System Overview

A feature flag and A/B experimentation platform. Product teams define flags and experiments in a console, and an SDK in every client evaluates them locally from a cached, versioned snapshot of the ruleset. When a variant actually renders, the SDK logs an **exposure**; conversions are tracked separately. An analysis service joins the two in ClickHouse and reports, per experiment, conversion rates with confidence intervals, the relative lift and a sample ratio mismatch (SRM) check. A kill switch turns anything off within seconds on every connected client.

The hard parts are not the CRUD:

1. **Assignment must be deterministic and stable.** The same user must get the same variant on the web, on iOS and from the server, without a lookup table. Ramping a treatment from 10% to 20% must move only control users into treatment, never treatment users back.
2. **Exposure is not assignment.** Every visitor is *assigned* a variant the moment the SDK evaluates the experiment. Only some of them ever *see* it. Counting everyone assigned dilutes the measured effect; counting exposure wrongly (one arm logging less than the other) breaks the experiment silently.
3. **The SDK must not depend on the network to render.** Configuration arrives asynchronously; first paint cannot wait for it, and an outage of the flag service must not take the product down.
4. **Events arrive twice, late and out of order.** Mobile devices go offline, browsers retry batches whose response was lost, workers crash mid-insert. The analysis must not double count, and must include an event that arrives six hours late.
5. **Identity changes mid-session.** An anonymous visitor who signs in has two ids. Which one decides their variant?

**The key question: a user was assigned a treatment but never actually saw it. Does that count as exposure, and how does the system tell the two cases apart?** No. Assignment is a pure function the SDK can compute for anyone; exposure is a fact about what was rendered. The platform keeps them as two different events written from two different places: `assignment` is logged when the app evaluates a flag (diagnostic only), `exposure` is logged by the `<Exposure>` component (or `useExposure`) when the variant mounts, or when it scrolls into view, once per unit per experiment per config version. The analysis reads only exposures. The results page shows both counts side by side so the dilution is visible: in the demo, the rewards-tab experiment assigns about 4,000 visitors and exposes about 480 of them.

**Learning goals:** hash-based bucketing and range allocation; snapshot-based config delivery (immutable versions, ETags, push hints, last-known-good); render-time exposure logging; idempotent event ingest into an OLAP store; exposed-only analysis with Wilson intervals, two-proportion tests and SRM.

**Signal.** A practice extension from the repository roadmap, especially useful for growth-engineering roles. See [CLAUDE.md](./CLAUDE.md).

## Requirements

### Functional Requirements

1. **Flags and experiments.** A key, a kind (flag or experiment), an assignment unit (`user`, `org` or `anonymous`), 2-6 variants with values, a salt, a primary metric and an attribution window. Per environment: a status (`draft → running → paused ⇄ running → stopped`), targeting rules, variant weights and a version that increments on every change.
2. **Environments.** At least `dev` and `prod`, each with its own public client key, secret server key and snapshot sequence.
3. **Targeting.** Ordered rules over attributes (country, plan, platform, any custom attribute) and identities (explicit id lists); each rule forces a variant, excludes, or enrolls into the allocation; a fallthrough decides the rest. Percentage rollout is the allocation itself.
4. **Deterministic assignment** shared by server and SDK, stable across devices for signed-in users, with stable ranges when weights change and an editor preview of how many users a change moves.
5. **Delivery.** Compiled, immutable snapshots per environment; fetch with ETag / `If-None-Match`; server push of new versions; a kill switch that reaches connected clients within seconds.
6. **SDK.** Local evaluation, last-known-good persistence, safe coded defaults, never blocking render, render-time exposure with dedup, batched events with retries and an unload beacon, conversion tracking.
7. **Analysis.** Exposed-only results per experiment: units per variant, conversion rate with confidence intervals, lift, SRM, assigned vs exposed, attribution only after first exposure and within the window, late events included.
8. **Console.** List, editor (weights with a users-moved preview, targeting, salt, status, kill switch), audit log, results, live SDK clients with the snapshot version each holds. Roles: admin (edits) and viewer (read-only).

### Non-Functional Requirements

| Property | Target | Why |
|----------|--------|-----|
| Evaluation latency | < 1 ms in the SDK, zero network calls on the render path | Flags guard every screen; a remote call per flag would dominate page latency |
| Evaluation availability | 100% of renders get an answer, even with the platform down | Last known good snapshot, then coded defaults |
| Config propagation | p99 < 5 s to connected clients; ≤ 60 s for clients without a stream | A kill switch that takes minutes is not a kill switch |
| Snapshot API availability | 99.99% | Served from memory and a CDN; the control plane can be down without affecting delivery |
| Assignment stability | 100% deterministic; a weight change moves only the buckets that must move | Reshuffled users contaminate both arms and break the experience |
| Console writes | Linearizable per flag, audited in the same transaction | "Who turned this on in prod?" must always have an answer |
| Ingest | Accept ≥ 99.9% of events; a retried batch never double counts | Analysis is only as good as the exposure log |
| Late events | Accepted up to 30 days old, included on the next read | Mobile apps flush days later |
| Results freshness | < 5 minutes | Experiments run for weeks; nobody needs second-level results, but monitoring a launch needs minutes |

## Capacity Estimation

### Production Scale (assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Monthly / daily active users | 50M / 10M | A large consumer product |
| Concurrent SDK clients at peak | ~2M | Web tabs and foregrounded apps; backgrounded mobile apps poll instead |
| Flags and experiments per environment | ~2,000 (≈ 150 running experiments) | Big product orgs accumulate flags faster than they clean them up |
| Snapshot size | ~400 KB raw, ~60 KB gzip | ~200 B per flag of rules and ranges |
| Config changes | ~1,000/day, bursts of a few per second during release trains | One change ≈ one new snapshot version per environment |
| Evaluations | ~25B/day | 50 flag reads × 500M page views; all local, zero server cost |
| Snapshot bytes per change without a CDN | 2M × 60 KB = 120 GB | Why versioned, immutable snapshot URLs sit behind a CDN |
| Exposures | ~150M/day | 10M DAU × 5 sessions × 3 experiments rendered |
| Conversions | ~50M/day | Purchases, sign-ups and other metric events |
| Assignments | ~100M/day at 10% sampling | Diagnostic only, so sampled |
| Events total | ~300M/day ≈ 3.5k/s average, ~20k/s peak | Small rows; trivial for Kafka and ClickHouse |
| ClickHouse storage | ~10 GB/day compressed, ~4 TB at 400 days | ~300 B raw per event, 8-10× compression on sorted LowCardinality columns |

The numbers say evaluation is free (it runs on the client), config delivery is a fan-out and caching problem (one small change becomes millions of downloads), and analysis is a modest OLAP workload whose expensive part is joining conversions to first exposures.

### Local Development Scale

Two API instances, one ingest worker, PostgreSQL, Valkey and ClickHouse in Docker, six seeded flags and experiments in two environments. The traffic simulator drives 4,000 virtual visitors through one Node SDK client in about a second of wall time, producing ~16,000 events (12,000 assignments, ~3,500 exposures, ~500 conversions) plus an offline cohort replaying events hours late.

## High-Level Architecture

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                   Control plane (writes)                     │
 ┌────────────┐     │  ┌────────────┐   one txn: config v+1, history, audit,       │
 │  Console   │────▶│  │ Config API │── environments.snapshot_version+1, compile ─▶│──▶ PostgreSQL
 │ (React)    │     │  └────────────┘   snapshot, INSERT snapshots (immutable)     │    (source of truth)
 └────────────┘     │        │ after commit                                        │
                    │        ▼                                                     │
                    │  Valkey: latest snapshot (forward-only CAS) + PUBLISH {env, version}
                    └────────┬─────────────────────────────────────────────────────┘
                             │ pub/sub fan-out to every edge instance
                    ┌────────▼─────────────────────────────────────────────────────┐
                    │                 Delivery plane (edge, stateless)             │
                    │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
                    │  │ edge / api-a │  │ edge / api-b │  │ edge / api-n │  in-memory latest snapshot,
                    │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  reconcile with PostgreSQL every 5 s
                    └─────────┼─────────────────┼─────────────────┼────────────────────┘
          GET /snapshot (ETag, 304) · GET /snapshots/:v (immutable, CDN) · SSE {version}
                              │                 │                 │
        ┌─────────────────────▼──────┐   ┌──────▼─────────────────▼─────────┐
        │ Browser SDK (storefront)   │   │ Node SDK (servers, simulator)    │
        │ local evaluate() · LKG in  │   │ local evaluate() · same core     │
        │ localStorage · <Exposure>  │   │ module as the server             │
        └─────────────┬──────────────┘   └────────────────┬─────────────────┘
                      │ batches {batchId, sentAt, events} (fetch; sendBeacon on unload)
                      ▼                                     ▼
                ┌───────────────────────────────────────────────┐
                │ Ingest endpoint: validate, skew-correct,      │
                │ Lua: SET NX batch id + XADD (atomic)          │
                └───────────────────────┬───────────────────────┘
                                        ▼ Valkey stream (production: Kafka)
                ┌───────────────────────────────────────────────┐
                │ Ingest worker: XREADGROUP → INSERT with       │──▶ ClickHouse: exposures, assignments,
                │ insert_deduplication_token → XACK             │    conversions (ReplacingMergeTree)
                └───────────────────────────────────────────────┘                 │
                                                                                  ▼
                              Results API: first exposure per unit, attribution window,
                              Wilson CIs, z-test, lift, SRM per config version ──▶ Console
```

Three planes with different consistency needs:

- **Control plane** (console → PostgreSQL) is small, strongly consistent and audited. It can go down for minutes without any user noticing: SDKs keep evaluating.
- **Delivery plane** (edge instances → SDKs) is read-only, stateless and horizontally scaled. It serves immutable documents and version hints, so it is cacheable everywhere.
- **Data plane** (SDK events → ClickHouse) is append-only, at-least-once and made exact by idempotent inserts and duplicate-insensitive queries.

## Core Components

### 1. Deterministic assignment

`bucket = murmur3_x86_32(salt + "." + unitId) mod 10,000`. Each variant owns a set of half-open bucket ranges; a bucket owned by nobody is "not allocated" and gets the default variant without being enrolled. One bucket is 0.01% of units.

- **MurmurHash3** because it is fast, has a good avalanche, and is implementable identically in a few lines of pure JavaScript (the browser SDK cannot use async WebCrypto on the render path). It hashes UTF-8 bytes, not UTF-16 code units, so `é` buckets the same in Swift, Kotlin and JavaScript. The unit test checks the reference vectors, and the parity test compares it with an independent BigInt implementation on 5,000 ids.
- **Per-flag salt** decorrelates experiments: the same user lands in independent buckets of `checkout_cta` and `rewards_teaser`. The salt is generated at creation and never changes (no API edits it): a new salt would re-randomize everyone, so a rerun is a new experiment with a new key.
- **Modulo bias** of `2^32 mod 10,000 = 7,296` shifts each bucket's probability by under 0.0003%: irrelevant next to sampling noise.
- **The unit id depends on the unit type** (`sdk/src/core/evaluate.ts`, `resolveUnit`): `user` experiments use the stable id (see Identity below), `org` experiments the organization id (signed-out visitors are not enrolled), `anonymous` experiments the device's anonymous id.

There is exactly one implementation of this, in `sdk/src/core/`. The backend imports it through `backend/src/shared/evaluation.ts` instead of keeping a copy, and the console imports it for the editor preview. Parity is then structural, and `backend/src/domain/parity.test.ts` checks the parts that could still drift: the snapshot's JSON round trip and the SDK client's context handling, on 5,000 random units × 3 flags.

### 2. Stable bucket ranges when weights change

Weights are stored as ranges, not percentages. A config change computes the new ranges from the old ones (`allocateStable` in `sdk/src/core/allocation.ts`):

1. Each variant whose weight shrinks releases buckets from the top of its ranges.
2. Each variant whose weight grows takes the buckets just released first (those units are changing anyway), then never-allocated buckets, lowest first.
3. A variant whose weight does not shrink never loses a bucket.

So the minimum possible number of units move. Measured on 20,000 random units in `allocation.test.ts`:

| Change | Stable ranges | Naive: re-partition from bucket 0 | Naive: re-hash (new salt / version in hash) |
|--------|---------------|-----------------------------------|---------------------------------------------|
| Treatment 10% → 20% (control 90 → 80) | 10% move, all control → treatment; **0% of treatment leaves** | Same (a two-variant boundary shift happens to be stable) | ~26% move; **~80% of treatment leaves** |
| Enrolment 20% → 40% at 50/50 | 0 switch; 20% newly enrolled | **100% of treatment switches to control** | ~48% change |
| 34/33/33 → 50/25/25 | 16% move | 24% move (variant b loses twice what it must) | ~67% change |

The editor computes the same thing in the browser before saving and shows "This change moves 10% of units, 0% of current treatment units out of treatment", with both naive strategies' numbers next to it. The server recomputes on save and writes the summary to the audit log (`weights control 90%→80%, treatment 10%→20% (moves 10% of units: control→treatment 10%)`).

Ranges fragment after many ramps (`treatment: [[5000,6000],[9000,10000]]`); that costs a few more comparisons per evaluation and nothing else. Units that do move between variants become **crossovers**; the analysis leaves them out of conversion rates (Component 9).

### 3. Targeting and the evaluation order

`evaluateFlag` (`sdk/src/core/evaluate.ts`) is the whole decision:

1. Status not `running` → default variant, reason `inactive`.
2. No unit id for the unit type → default, `no_unit`.
3. Rules in order; the first whose conditions all match decides: `force` a variant (reason `forced`, not in the experiment), `exclude` (default, `excluded`), or `enroll` (continue).
4. No rule matched → the fallthrough: `enroll` or `exclude` (`not_targeted`).
5. Bucket → owning variant → `allocated` with `inExperiment = true` for experiments; no owner → default, `not_allocated`.

Conditions are `in` / `not_in` over string attributes; a missing attribute never matches `in` and always matches `not_in`. Forced units (a QA list) see the variant but never log exposure: they are not randomized, so including them would bias the arm. Only `inExperiment` evaluations may log exposure, which keeps every non-random path out of the analysis by construction.

### 4. Identity: what happens when an anonymous visitor signs in

**Policy: the first anonymous id a user signs in from becomes their stable id** (an identity alias, first link wins). `user` experiments bucket by the stable id.

```
anonymous visitor ──▶ stableId = anonymousId (anon_A) ──▶ bucket(anon_A) = treatment
     │ signs in (POST /api/v1/shop/login with anonymousId)
     ▼
shop backend (server key) ──▶ identity service:
     INSERT identity_links (anon_A, user_42)              -- every device's id is recorded
     INSERT identity_aliases (user_42 → anon_A) ON CONFLICT DO NOTHING RETURNING stable_id
     ◀── stableId = anon_A (created) ──▶ SDK identify({ userId: user_42, stableId: anon_A })
                                          bucket(anon_A) = treatment   ← no flip
later, a phone (anon_B) signs in as user_42 ──▶ alias exists ──▶ stableId = anon_A
                                          every device converges on the same bucket
```

Why this policy (Key Design Decision 3 has the full argument): growth experiments live in the sign-up funnel. Re-bucketing by user id at sign-in would flip roughly half of the visitors who sign in (a 50/50 experiment) to the other variant mid-funnel: a visible UI change at the worst moment, and a crossover the analysis must throw away, exactly among the users most likely to convert. The alias keeps the pre-sign-in experience and attributes post-sign-in conversions to the pre-sign-in exposure.

What it costs: a lookup at sign-in (the sign-in request already goes to a server), a table that grows with users, and one honest gap: a second device's *pre*-sign-in exposures belong to its own anonymous unit. If that device saw the other variant before signing in, that anonymous unit's exposure is never merged with the user. `identity_links` records the pairing; at scale it would be synced to ClickHouse as a dictionary and unit ids resolved through it at query time (Scalability Considerations). Until the alias is confirmed (sign-in response lost), the SDK keeps bucketing by the current stable id, so a failed identify never flips anyone. Sign-out rotates the anonymous id so the next person on a shared device is a new unit.

### 5. Snapshots: compile, version, deliver

**Compile inside the write.** Every console mutation runs one transaction:

1. `SELECT … FOR UPDATE` the flag's config row in that environment and check `If-Match` (409 on a stale version).
2. Write the new config with `version = version + 1`, append `flag_versions` (the full config of every version) and `audit_log`.
3. `UPDATE environments SET snapshot_version = snapshot_version + 1 … RETURNING` (this row lock serializes all writers of one environment, so versions are gap-free and ordered).
4. Read every flag of the environment, compile the snapshot (`domain/compile.ts`), `INSERT INTO snapshots` (never updated).

After commit: write the body to Valkey as the latest (a Lua compare-and-set that only moves forward), record the publish time, `PUBLISH exp:snapshots {environment, version, reason}`. The snapshot is published only after commit, so no client can see a ruleset whose change rolled back.

**Serve from memory.** Each API (edge) instance holds the latest snapshot per environment in memory and serves:

| Endpoint | Caching | Purpose |
|----------|---------|---------|
| `GET /sdk/v1/snapshot` | `Cache-Control: no-cache`, `ETag: "prod-v18"`; `If-None-Match` → **304** | Startup and polling: one revalidation round trip, no body when unchanged |
| `GET /sdk/v1/snapshots/:version` | `public, max-age=31536000, immutable` | What a client fetches after a push names a version; CDN-cacheable forever |
| `GET /sdk/v1/stream` | SSE | `hello {version}` on connect, `snapshot {version}` on every change |

The ETag is the version, because a version's body never changes. The push carries only the version, not the ruleset: two million clients each fetching the same immutable URL is a CDN cache hit, while two million copies of a 400 KB body pushed from the origin is the thundering herd. The client fetches *that* version, not "latest", so a load balancer that sends the fetch to an instance which hasn't processed the pub/sub message yet still returns the right document (it loads the version from Valkey or PostgreSQL on demand).

**Fan-out across instances.** Every instance subscribes to `exp:snapshots`. When a message arrives with a newer version, the instance loads it, swaps its in-memory copy and writes `snapshot {version}` to each of its SSE streams for that environment. Pub/sub is a hint, not a log: a **reconcile loop** reads `environments.snapshot_version` from PostgreSQL every 5 s, so a lost message (Valkey restart, subscriber reconnecting) delays delivery by at most 5 s instead of forever.

### 6. The kill switch

`POST /api/v1/flags/:key/environments/:env/kill {reason}` (admin only) is a status change with a fixed target: a flag goes to `paused` (forced off, resumable), an experiment to `stopped` (final). It is the same transaction and publish path as any change, with `reason = kill_switch` and an audit entry `KILL SWITCH: stopped (checkout errors)`. Every unit then evaluates to the default variant with reason `inactive`, and no further exposures are logged, because `inExperiment` is false.

Path and bound: commit → PUBLISH (sub-millisecond) → every instance's subscriber → SSE write → the client fetches `/snapshots/:v` → applies → re-renders → reports `{version}` to `/clients/report`. The server computes **propagation = report time − publish time** per client and shows it in the live client view and in the `exp_snapshot_propagation_seconds` histogram. Measured locally by the live e2e suite over 10 kill/resume cycles per run, with the console on api-a and the SDK streaming from api-b, from the kill request being sent to the SDK's evaluation changing: **p50 16-20 ms, max 19-28 ms** across three runs (no samples excluded for host stalls). A publish whose pub/sub message was lost reached the SDK through the reconcile loop in 3.5-4.6 s. The stated bound is 2 s for a connected client; 5 s worst case when a pub/sub message is lost (the reconcile interval); the poll interval (15-30 s, 60 s in production) for a client without a stream; and "on next start" for a client that is offline, which keeps serving its last known good snapshot (Failure Handling discusses the trade-off and the cache-age limit).

### 7. The SDK

One client class (`sdk/src/client/client.ts`) runs in browsers and in Node; storage, `fetch` and the unload beacon are injected (`client/browser.ts` wires localStorage, `sendBeacon` and the anonymous id). React bindings live in `sdk/src/react/`.

**Startup ladder.** The client evaluates synchronously from whatever it holds, in this order of preference:

1. the network (latest, revalidated with `If-None-Match`, then pushed versions);
2. a bootstrap snapshot handed in by the host (server rendering);
3. the last known good snapshot from storage, if younger than `maxCacheAgeMs` (7 days);
4. nothing: every key gets its **safe coded default** (`defaults: { checkout_cta: 'control', … }`), reason `default`, never in an experiment.

`ready()` resolves after the first fetch or `initTimeoutMs`, whichever is first, and never rejects. `<ExperimentProvider>` renders immediately when a snapshot is held; with nothing cached it waits at most `maxWaitMs` (300 ms) and then renders with defaults rather than a blank page. The network is never on the render path.

**Applying snapshots.** A snapshot is accepted only if it is well formed, for the same environment, and newer than the one held: an old CDN copy or a reordered response can never roll a client back to before a kill switch. Accepted snapshots are persisted as the new last known good.

**Transport.** SSE is read with `fetch` and a `ReadableStream` (header auth, the same code in Node), with a 45 s silence watchdog (the server pings every 15 s), reconnect with full-jitter exponential backoff up to 30 s, and polling (`If-None-Match`) while the stream is down. Each applied version is reported to `/clients/report` for the live view.

**Events.** Exposures, assignments and conversions go into a queue that forms batches (`batchId` assigned once), flushes every 2 s or at 50 events, and retries 429/5xx/network failures with jittered exponential backoff capped at 30 s, **keeping the same batch id and events** so the server can recognize a retry. A permanent 4xx drops the batch. The queue persists to localStorage, so a crash re-sends on the next start (same batch ids). On `pagehide` or `visibilitychange: hidden`, everything unacknowledged goes out through `navigator.sendBeacon` as `text/plain` JSON (no CORS preflight; the client key travels in the body and the query string) and stays queued until acknowledged.

### 8. Exposure is not assignment

```
session start:  client.evaluateAll()  ──▶ assignment events (diagnostic, deduped)      every visitor
product page:   <BuyButton> mounts    ──▶ <Exposure evaluation={cta}> ──▶ exposure      ~45% of visitors
rewards tab:    <RewardsBanner> in view ─▶ <Exposure whenVisible> ──▶ exposure          ~12% of visitors
cart (broken):  treatment logs from a slow <img onLoad=…>  ──▶ some never fire        → SRM
```

- `useVariant(key)` evaluates (and records an assignment) but **never** logs exposure.
- `<Exposure evaluation>` logs on mount; `whenVisible` waits for an IntersectionObserver to report ≥ 50% visible; `<Experiment flag variants>` renders the variant's element inside `<Exposure>`.
- `logExposure` refuses anything that is not `inExperiment` (defaults, forced, excluded, not allocated, flags) and dedupes on `flagKey:version:unitId`, persisted. A new config version is a new exposure (the SRM check reads each exposure's version).

The deliberately broken `shipping_banner` treatment logs from the `onLoad` of an illustration served by a slow "CDN" (the shop API answers after 3.5 s); visitors who leave or check out first are never logged. Its assignments are balanced (p ≈ 0.45 in the demo run) while its exposures come out ~58/42 (p ≈ 10⁻¹⁰): that contrast tells the analyst the bug is in the exposure path, not the bucketing.

### 9. Ingest

`POST /sdk/v1/events {batchId, sentAt, sdkInstanceId, events[]}` (JSON, or `text/plain` from a beacon):

1. Resolve the environment from the client key; validate the envelope (zod) and each event independently: one bad event is rejected and counted, not the batch.
2. **Clock skew.** `skew = receivedAt − sentAt` (both from one device clock vs the server clock). Every event's `ts` shifts by it, which keeps the device's ordering and spacing but puts times on the server clock. The raw device time is kept as `client_ts`.
3. Reject events older than 30 days or more than a day in the future after correction; reject duplicate event ids within the batch.
4. **Atomically** (one Lua script): `SET exp:batch:<env>:<batchId> NX EX 86400`, and only if that succeeded, `XADD exp:events MAXLEN ~ 1000000 * b <batch>`. A retried batch (the SDK lost the 202) hits the key and gets `{accepted: 0, duplicate: true}` without being enqueued again; there is no window where a batch is marked seen but not enqueued.

The **ingest worker** (`backend/src/ingest/index.ts`) reads the stream with a consumer group, up to 200 entries (SDK batches) per round:

1. On start, its own pending entries first: after a crash it re-reads exactly the entries it had, in the same order and count.
2. Insert each table's rows with `insert_deduplication_token = sha1(table + entry ids)`. The tables keep `non_replicated_deduplication_window = 1000`, so a repeated insert of the same block (a timeout after ClickHouse committed, or a crash before XACK) is a no-op.
3. `XACK`.
4. Every 15 s, `XAUTOCLAIM` entries idle for 30 s on a consumer that died.

Claimed entries can be regrouped, which changes the token, so duplicates can still reach ClickHouse in that one case. That is what **ReplacingMergeTree with `event_id` in the sorting key** is for: duplicates collapse at merge time. The tables are partitioned by `client_ts` (identical on every retry), so two copies of an event always share a partition and can be merged. The analysis only uses duplicate-insensitive aggregates, so it is exact even before merges; raw row counts use `FINAL`.

**Late events** need no special path: results are computed at read time from all rows, so a conversion that arrives six hours late is included on the next read, as long as it happened within its unit's attribution window. The results page counts events that arrived more than an hour after they happened.

### 10. Analysis

For one experiment and environment (`services/results-service.ts`, `domain/analysis.ts`), ClickHouse computes per unit: the first exposure's variant, config version and time (`argMin`), and how many variants the unit was ever exposed to. It left-joins conversions of the primary metric on the column that matches the unit type (`stable_id`, `anonymous_id` or `org_id`) and marks a unit converted if any conversion falls in **(first exposure, first exposure + window]**: a purchase before the unit saw the experiment cannot have been caused by it. The query returns one row per (first variant, first version).

Then, in TypeScript:

- **Crossovers** (exposed to more than one variant: a ramp moved them, or two identities merged) count toward the SRM check (they were assigned like everyone else) but are left out of conversion rates.
- **Conversion rate per arm with a 95% Wilson score interval.** Wilson rather than p ± 1.96·SE because it behaves at small n and near 0%.
- **Lift vs control**: two-proportion z-test with a pooled standard error for the p-value, an unpooled interval for the absolute difference, and a delta-method interval for the relative lift. Significant at α = 0.05, two-sided.
- **SRM**: Pearson chi-square of exposed units per arm against the expected split, flagged at p < 0.001. The expectation is computed **per config version**: each version's exposed units × that version's share of each variant among enrolled buckets. A 90/10 → 50/50 ramp therefore doesn't look like a broken split, while the same counts tested against the current weights alone would (`analysis.test.ts`).
- **Assigned vs exposed.** The same computation runs over assignment events. The page shows assigned and exposed counts per arm and the lift under both. In the demo, `checkout_cta` shows ≈ +57% relative lift among exposed visitors and ≈ +32% among everyone assigned: the same extra purchases spread over twice as many units, half of whom never saw the button.

### 11. Console, roles and audit

React console polling the API (no long-lived connection, so the screenshot harness never waits on one): flags list with each environment's allocation drawn as bucket ranges; an editor with status transitions, the kill switch, weights with the live move preview, ordered targeting rules with a "try a unit" evaluator running the shared core, the definition (unit, salt, variants, metric) and version history; results; the audit log; and the live SDK client view polling every second. `admin` edits; `viewer` gets the same pages with every control disabled, and the server rejects their writes with 403 regardless of the UI. Every mutation writes `audit_log` in its own transaction.

### Worked example: one successful trace

A guest opens a product, sees the treatment, signs in and buys (from the e2e run and the demo app):

1. The storefront loads. `getAnonymousId()` returns `anon_c395…` from localStorage; the client finds a last known good snapshot v18 in storage (source `cache`) and the provider renders immediately. In the background, `GET /sdk/v1/snapshot` with `If-None-Match: "prod-v18"` returns **304** and the source becomes `network`; the SSE stream to api-b opens and says `hello {version: 18}`.
2. The root calls `client.evaluateAll()`: `checkout_cta` buckets `murmur3("checkout_cta-4861e04c.anon_c395…") mod 10000 = 8680`, owned by treatment → an `assignment` event (deduped on `checkout_cta:5:anon_c395…`).
3. The visitor opens the kettle. `<BuyButton>` renders "Buy now · free shipping" inside `<Exposure>`; on mount `logExposure` queues an `exposure` (version 5, unit `anon_c395…`).
4. They sign in as carol. The shop backend links `anon_c395… → carol` (her first sign-in, so `stableId = anon_c395…`); `client.identify` keeps bucketing by the same id. The button stays "Buy now"; no new exposure (same unit, same version).
5. Checkout calls `client.track('purchase', {value: 89})` and `flush()`. The batch `{batchId: b_…, sentAt, events: [assignment…, exposure, conversion]}` reaches api-b; validation passes, skew is ~0, the Lua script sets the batch key and appends one stream entry; **202 {accepted: 3}**.
6. The worker reads the entry, inserts one row each into `assignments`, `exposures` and `conversions` with tokens derived from the entry id, and XACKs.
7. The results page: carol's unit's first exposure is treatment at v5; the purchase is 40 s later, inside 72 h → converted. She counts once in treatment's numerator and denominator, and once among the assigned.

### Worked example: one failed trace

A kill switch while pub/sub is lost, with one SDK offline:

1. Checkout errors spike. Alice pulls the kill switch on `checkout_cta` in prod through api-a: the transaction moves the config to `stopped` (v6), audits `KILL SWITCH: stopped (checkout errors)`, compiles snapshot v19 and commits.
2. Valkey restarts at that moment: the forward-only SET and the PUBLISH fail. api-a logs a warning; the write already succeeded and api-a's own memory holds v19 (its local streams get the push immediately).
3. api-b never receives the message. Within 5 s its reconcile loop reads `snapshot_version = 19` from PostgreSQL, loads v19 from the `snapshots` table, swaps memory and pushes `snapshot {version: 19}` to its streams.
4. The storefront's SDK (streaming from api-b) fetches `/snapshots/19`, applies it (newer, same environment), persists it as last known good and re-renders: every unit gets control (`inactive`), no new exposures. It reports v19; the live view shows the propagation as ~5 s instead of the usual sub-second.
5. A phone that was offline keeps evaluating from its cached v18 (treatment) until it reconnects. On reconnect, `hello {version: 19}` makes it fetch v19 immediately. If it stayed offline longer than `maxCacheAgeMs`, its next cold start ignores the stale cache and serves coded defaults (control).
6. The phone's queued exposures from the offline period flush later with their original device timestamps, some of them after the kill. They are genuine exposures (the phone really rendered the treatment), so the analysis includes them, and the event-health panel counts them as late. The stopped experiment logs no new exposures from connected clients; the results stay readable after the stop.

### Design Review Checklist

| Question | Answer |
|----------|--------|
| Source of truth, and when is a write successful? | PostgreSQL for definitions, configs, version history, audit, snapshots and aliases: a console write succeeds when its transaction (config, history, audit, compiled snapshot) commits. Valkey's copy and the pub/sub message are derived and can be lost. For events, an ingest call succeeds when the batch is in the Valkey stream (AOF on); ClickHouse is the analytical record once the worker inserts |
| What happens when a client retries after losing the response? | Console: `If-Match` on the version, so a retried edit after a lost 200 gets 409 and reloads instead of double-applying. SDK snapshot fetch: idempotent GETs with ETags. Events: the same `batchId` hits the Valkey key → 202 duplicate, not re-enqueued; a re-batched event (new batch id) collapses by `event_id` in ReplacingMergeTree and never changes distinct-unit counts. Sign-in: alias insert is `ON CONFLICT DO NOTHING`, so a retry returns the same stable id |
| What happens when a worker or server fails between two important steps? | API between commit and publish: the snapshot is in PostgreSQL; every instance's reconcile picks it up within 5 s. Ingest between SET NX and XADD: impossible, one Lua script. Worker between insert and XACK: it re-reads its own pending entries in the same grouping → same token → ClickHouse drops the repeat. Worker dies for good: another claims its entries after 30 s; ReplacingMergeTree absorbs any duplicates from regrouping. SDK between queueing and sending: the queue is in localStorage, re-sent with the same batch ids on next start |
| Which ordering or consistency guarantee is actually required? | Per environment, snapshots must be totally ordered and clients must never go backwards: one row lock serializes compiles, and SDKs and the Valkey CAS accept only newer versions. Per flag, edits are linearizable (row lock + If-Match). Delivery is eventually consistent with a bound (≈1 s typical, 5 s with lost pub/sub). Events need no ordering: analysis uses event times (skew-corrected) and min/argMin, so arrival order is irrelevant |
| How is access enforced when caches, indexes or async jobs are involved? | Console reads need admin or viewer, every write needs admin, checked server-side per route (viewer → 403, shopper → 403). Client keys are public by design and only read rulesets and append events for their own environment; server keys (identify, evaluate) are secret and never sent to browsers or shown to viewers. Snapshots contain only what any visitor's SDK needs (no PII); explicit id lists are the one sensitive part and belong in server-side evaluation in production. The worker has no user-facing surface |
| What breaks first at much larger scale, and what evidence supports it? | Snapshot download fan-out: one change × 2M connected clients × 60 KB = 120 GB if served from the origin, hence immutable version URLs on a CDN and version-only pushes. Locally a kill switch pushes to every stream within milliseconds and each client's fetch is one in-memory lookup, so origin CPU is not the issue; bytes are. Second, the analysis join: every results read scans all conversions of the metric for the environment; locally a full results read (two analyses plus event counts) takes ~30 ms over ~3,300 exposures and ~900 conversions, and the join grows linearly with conversion volume (Scalability Considerations: per-unit daily rollups) |

## Database Schema

The full DDL is in [`backend/src/db/init.sql`](./backend/src/db/init.sql) and [`backend/src/db/clickhouse-init.sql`](./backend/src/db/clickhouse-init.sql).

### PostgreSQL (source of truth)

| Table | Key columns | Notes |
|-------|-------------|-------|
| `users` | id, username (unique), password_hash (bcrypt), role (`admin`/`viewer`/`shopper`), country, plan, org_id | Shoppers' attributes feed targeting in the demo storefront |
| `environments` | key (PK), client_key (unique), server_key (unique), snapshot_version | `snapshot_version` is bumped under the row lock by every compile: the per-environment sequence |
| `flags` | id, key (unique, `^[a-z][a-z0-9_]{1,63}$`), kind, unit_type, salt, variants (jsonb), default_variant, primary_metric, attribution_window_hours, surface | Global identity of a flag; the salt is random at creation and immutable |
| `flag_configs` | (flag_id, environment) PK, status, allocation (jsonb ranges), rules (jsonb), fallthrough, version, started_at, stopped_at, updated_by | One row per flag per environment; the row lock serializes edits |
| `flag_versions` | (flag_id, environment, version) PK, status, allocation, rules, fallthrough, changed_by, changed_at | Immutable history; the SRM expectation reads each version's allocation |
| `audit_log` | id, at, actor, action (`create`, `update_config`, `status`, `kill_switch`, `update_metadata`), flag_key, environment, from_version, to_version, summary, details (jsonb) | Written in the same transaction as the change |
| `snapshots` | (environment, version) PK, etag, body (jsonb), flag_count, bytes, reason | Immutable compiled rulesets; `/snapshots/:version` serves from here on a cache miss |
| `identity_aliases` | (environment, user_id) PK, stable_id | First link wins (`ON CONFLICT DO NOTHING`) |
| `identity_links` | (environment, anonymous_id, user_id) PK | Every device id seen signing in as a user |

```sql
CREATE TABLE IF NOT EXISTS flag_configs (
  flag_id     UUID NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  environment TEXT NOT NULL REFERENCES environments(key),
  status      TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'stopped')),
  allocation  JSONB NOT NULL,          -- {"control": [[0, 9000]], "treatment": [[9000, 10000]]}
  rules       JSONB NOT NULL DEFAULT '[]',
  fallthrough TEXT NOT NULL DEFAULT 'enroll' CHECK (fallthrough IN ('enroll', 'exclude')),
  version     INT NOT NULL DEFAULT 1,
  started_at  TIMESTAMPTZ,
  stopped_at  TIMESTAMPTZ,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, environment)
);
```

### ClickHouse (events)

| Table | Sorting key | Columns of note |
|-------|-------------|-----------------|
| `exposures` | (environment, flag_key, unit_id, event_id) | flag_version, variant, unit_type, unit_id (the bucketing id), anonymous_id, user_id, ts (skew-corrected), client_ts, received_at |
| `assignments` | same | same: diagnostic, compared with exposures on the results page |
| `conversions` | (environment, event_name, stable_id, event_id) | value, anonymous_id, user_id, stable_id, org_id, ts, client_ts, received_at |

```sql
CREATE TABLE IF NOT EXISTS experimentation.exposures
(
    event_id UUID, environment LowCardinality(String), flag_key LowCardinality(String),
    flag_version UInt32, variant LowCardinality(String), unit_type LowCardinality(String),
    unit_id String, anonymous_id String DEFAULT '', user_id String DEFAULT '', sdk_instance String DEFAULT '',
    ts DateTime64(3, 'UTC'), client_ts DateTime64(3, 'UTC'), received_at DateTime64(3, 'UTC'),
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(client_ts)          -- identical on every retry: copies share a partition
ORDER BY (environment, flag_key, unit_id, event_id)
SETTINGS non_replicated_deduplication_window = 1000;   -- insert_deduplication_token works
```

The sorting key puts one experiment's exposures together and each unit's rows next to each other, which is exactly the shape of the per-unit `argMin` aggregation.

### Valkey (derived and transient)

| Key | Type | Purpose |
|-----|------|---------|
| `exp:snapshot:<env>:latest` (+ `:version`) | string | Latest compiled body; Lua CAS only moves it forward |
| `exp:snapshot:<env>:published:<v>` | string (1 day) | Publish time and reason, for propagation latency |
| `exp:snapshots` | pub/sub channel | `{environment, version, etag, reason, publishedAt, origin}` |
| `exp:events` (group `ingest`) | stream | One entry per accepted SDK batch, drained by the worker |
| `exp:batch:<env>:<batchId>` | string (24 h) | Batch dedup window |
| `exp:clients:<env>` | hash | Live SDK clients: held version, transport, last update latency |
| `exp:alias:<env>:<userId>` | string (1 h) | Stable-id cache for server-side evaluation |
| `exp:session:<id>`, `exp:shop-session:<id>` | string | Console and storefront sessions (separate cookies) |

## API Design

Console (session cookie; reads: admin or viewer; writes: admin):

```
POST  /api/v1/auth/login | /logout          GET /api/v1/auth/me
GET   /api/v1/environments                  client keys; server keys only for admins
GET   /api/v1/flags                         every flag with each environment's config
POST  /api/v1/flags                         create (draft in every environment, random salt)
GET   /api/v1/flags/:key                    PATCH /api/v1/flags/:key (metadata)
PUT   /api/v1/flags/:key/environments/:env  {weights?, rules?, fallthrough?}  If-Match: "<version>"  → 409 when stale
POST  /api/v1/flags/:key/environments/:env/status   {to}         draft→running→paused⇄running→stopped
POST  /api/v1/flags/:key/environments/:env/kill     {reason}     flag → paused, experiment → stopped
GET   /api/v1/flags/:key/environments/:env/versions
GET   /api/v1/flags/:key/results?env=prod
GET   /api/v1/audit?flag=&env=&limit=       GET /api/v1/clients?env=   GET /api/v1/system
```

SDK (client key in `X-Client-Key`, `?key=` or the body; server key in `X-Server-Key`):

```
GET   /sdk/v1/snapshot                 latest; ETag "prod-v18"; If-None-Match → 304
GET   /sdk/v1/snapshots/:version       immutable; Cache-Control: public, max-age=31536000, immutable
GET   /sdk/v1/stream?sdk=&label=&version=   SSE: hello {version}, snapshot {version, reason, publishedAt}
POST  /sdk/v1/events                   {batchId, sentAt, sdkInstanceId, events[]} → 202 {accepted, rejected, duplicate}
POST  /sdk/v1/clients/report           {sdkInstanceId, version, source, transport} → {latencyMs}
POST  /sdk/v1/identify      (server)   {userId, anonymousId} → {stableId, created}
POST  /sdk/v1/evaluate      (server)   {context, keys?} → {snapshotVersion, stableId, evaluations}
```

Storefront: `POST /api/v1/shop/login {username, password, anonymousId}` → `{user, stableId}`, `POST /logout`, `GET /me`, `GET /products`.

```bash
# Ramp treatment to 20% (the editor's "Save weights"); a stale version gets 409 VERSION_CONFLICT
curl -b jar -X PUT -H 'Content-Type: application/json' -H 'If-Match: "5"' \
  -d '{"weights":{"control":8000,"treatment":2000}}' localhost:3000/api/v1/flags/checkout_cta/environments/prod
# → {"flag":{…"version":6…},"move":{"changed":1000,"switched":1000,"transitions":[{"from":"control","to":"treatment","buckets":1000}],…},"snapshotVersion":19}

# A retried batch is acknowledged, not enqueued again
curl -H 'X-Client-Key: cli_prod_4f9a2c7e1b3d5a60' -H 'Content-Type: application/json' \
  -d '{"batchId":"b_demo0001","sentAt":1794000000000,"events":[…]}' localhost:3001/sdk/v1/events
# → 202 {"accepted":3,"rejected":0,"duplicate":false}   then again → {"accepted":0,"rejected":0,"duplicate":true}
```

## Key Design Decisions

### 1. Exposure at render time, analyzed exposed-only

**Decision.** Exposure is an event the UI emits when the variant mounts (or is visible), separate from assignment; the analysis uses exposures only, and shows assignments beside them.

**Why it works.** The question an experiment answers is "did seeing B instead of A change behavior?". Only units that saw one of them can carry that effect. Logging at render means the exposure set is exactly that population, in both arms, with the same rule.

**Why the alternative fails.** Logging exposure at assignment (when `evaluate` runs, or for everyone at session start) makes every visitor "exposed". For the rewards-tab experiment that is 4,000 units of which about 480 saw anything; the other 88% convert at the same rate in both arms, so the measured lift is the true lift multiplied by ~0.12, buried in the noise of 3,500 unaffected units. A real +20% effect reads as about +2% and is never significant. Worse, a team that compensates by running longer ships a "flat" result that was never flat.

**What it costs.** Exposure must be logged correctly *in every arm*. If one arm's exposure path breaks (the slow image), the arms are no longer comparable: exposed-only analysis is more sensitive and more fragile. That is why every result carries an SRM check, and why assignment events are kept as a diagnostic: balanced assignments with unbalanced exposures point straight at the logging bug. It also means developers must place `<Exposure>` where the change is actually visible, a convention the SDK can make easy (`<Experiment>`, `whenVisible`) but not enforce.

### 2. Stable bucket ranges instead of re-partitioning or re-hashing

**Decision.** Store each variant's bucket ranges; recompute them on a weight change so that only buckets leaving a shrinking variant change hands.

**Why it works.** Bucketing stays a pure function of (salt, unit id, ranges). A ramp from 10% to 20% treatment moves exactly the 10% of units that must move, all from control, and no treatment unit ever sees control again. Their pre-ramp exposures remain valid, and the only crossovers are the moved control units, which the analysis can identify.

**Why the alternatives fail.** Re-hashing (a new salt, or the config version mixed into the hash input, a common "make each version independent" idea) moves ~26% of units on the same 10 → 20% ramp and sends ~80% of current treatment units back to control: their earlier exposures now describe an experience they no longer have, both arms are contaminated, and users see the button change back. Re-partitioning from bucket 0 looks fine for a two-variant boundary shift but is not stable in general: raising enrolment from 20% to 40% at 50/50 lays control over every former treatment bucket, switching 100% of treatment to control; a three-way rebalance moves 24% instead of 16%. These numbers are measured in `allocation.test.ts`.

**What it costs.** A config is a list of ranges, not two numbers; it fragments over many ramps and must be stored, versioned and validated (no overlaps, within [0, 10000)). And "minimum movement" is still movement: the moved units are crossovers, and per-version SRM expectations are needed so a ramp is not mistaken for a broken split. Teams that want a clean read after a large ramp should start a new analysis window from the ramp version.

### 3. Identity alias at first sign-in instead of re-bucketing by user id

**Decision.** `user` experiments bucket by a stable id: the anonymous id while signed out, then the first anonymous id the user ever signed in from (an alias stored server-side), on every device.

**Why it works.** The visitor's variant does not change at sign-in, so a sign-up funnel experiment measures what users actually experienced, and post-sign-in conversions attribute to the pre-sign-in exposure. Every later device converges on the same bucket after sign-in, which satisfies "stable across devices for signed-in users".

**Why the alternative fails.** Re-bucketing by user id at sign-in flips each signed-in visitor with probability equal to the other arm's share (50% in a 50/50 test, 90% of treatment users in a 90/10 test). The UI changes mid-funnel, and the flipped users are crossovers that must be dropped. They are dropped at random, so there is no bias, but they are precisely the users who signed in, i.e. the ones who convert. A sign-up experiment loses half its converters' signal and shows half of them a jarring change.

**What it costs.** A server round trip at sign-in to create or read the alias (the sign-in request already goes to a server, so it rides along), an alias table, and a residual gap: a second device's pre-sign-in exposures are a different unit until identity links are resolved in the warehouse. A shared device would merge two people, which is why sign-out rotates the anonymous id.

### 4. Local evaluation from compiled snapshots instead of a remote decision per request

**Decision.** SDKs download the environment's whole ruleset and evaluate locally; the server never sits on the render path.

**Why it works.** Evaluation costs microseconds, works offline, and survives a platform outage with the last known good ruleset. 25B evaluations a day cost nothing server-side. One snapshot per environment is also trivially cacheable: it is the same bytes for every client.

**Why the alternative fails.** A remote `/evaluate` per page (or per flag) adds a network round trip to every render, which pushes first paint behind the slowest call, and turns a flag-service outage into a product outage. Caching remote decisions per user brings back the staleness problem without the benefit of a single shared document.

**What it costs.** The ruleset is visible to clients: anyone can read rule conditions, explicit id lists and variant names from the bundle's snapshot. Rules that must stay private (a list of enterprise customer ids, unreleased feature names) belong in server-side evaluation, where the server SDK holds the snapshot. Snapshots also grow with the number of flags, which is a reason to archive stale flags and, at large scale, to split snapshots per client application.

### 5. Version-only SSE pushes plus immutable fetches instead of pushing rulesets or polling

**Decision.** The stream carries `{version}`; the client fetches `/snapshots/:version` (immutable, CDN-cacheable) and polls with `If-None-Match` only while the stream is down.

**Why it works.** A kill switch reaches connected clients in about the time it takes to send one small SSE frame plus one cached GET. The payload fan-out goes through the cache layer, not the origin. Fetching by exact version is immune to "the load balancer sent me to an instance that hasn't caught up". A client that missed pushes catches up from `hello {version}` on reconnect.

**Why the alternatives fail.** Polling every 30 s means a 15 s average kill-switch delay, and polling fast enough for seconds-level kills (every 1 s) is 2M requests per second of mostly 304s. Pushing the full ruleset in the stream makes every change a 2M × 400 KB burst from origin servers, bypassing every cache, and a client that missed one push has nothing to diff against.

**What it costs.** Long-lived connections need heartbeats, idle watchdogs, reconnect jitter and connection-aware load balancing; mobile platforms suspend them in the background (so mobile SDKs fall back to polling and push notifications). Pub/sub is lossy, so a reconcile loop is required, and the delivery bound becomes "push latency, or the reconcile interval when a message is lost".

### 6. At-least-once ingest made exact by two dedup layers instead of exactly-once machinery

**Decision.** Batch-id dedup at the ingest endpoint (atomic with the enqueue), `insert_deduplication_token` per worker block, ReplacingMergeTree on `event_id`, and analysis that only uses duplicate-insensitive aggregates.

**Why it works.** Each layer covers a specific retry: the SDK re-sending a batch whose response was lost (batch key), the worker re-inserting a block after a timeout or crash (token), and anything that slips through, such as an SDK re-batching events or a dead worker's entries being regrouped (ReplacingMergeTree, plus queries that count distinct units and use first times). None needs coordination across systems.

**Why the alternative fails.** Exactly-once delivery from a browser does not exist: the device cannot know whether a timed-out request was processed. A transactional pipeline (Kafka transactions into ClickHouse) still needs idempotent writes at the edges, adds latency and operational weight, and does nothing about the browser retry. Relying on ReplacingMergeTree alone is not enough either: it dedups only at merge time, so `count()` over raw rows is wrong until a merge happens.

**What it costs.** Three mechanisms to explain and test, a 24 h batch-key window (a retry after a day would be double counted: the client gives up long before that), and the discipline of using `FINAL` or distinct counts in every query that touches raw rows.

### 7. Read-time analysis instead of pre-aggregated counters

**Decision.** Results are computed from raw ClickHouse rows on each read.

**Why it works.** Late events, attribution windows, crossover exclusion and per-version SRM are all functions of the full per-unit history; computing at read time makes every one of them correct by construction and makes changes to the analysis retroactive. At local scale a full results read takes about 30 ms.

**Why the alternative fails.** Streaming counters ("increment treatment conversions") cannot apply "only after the unit's first exposure" when the conversion arrives before a late exposure, cannot un-count a unit that later becomes a crossover, and silently diverge from raw data after any bug.

**What it costs.** Cost grows with data volume: the conversion join scans every conversion of the metric. Production adds per-unit daily rollups (materialized views keyed by experiment and unit) and caches finished days, keeping read-time correctness for the open window only.

## Consistency and Idempotency

| Operation | Mechanism |
|-----------|-----------|
| Console edit retried after a lost response | `If-Match: "<version>"`; the retry sees a newer version → 409 `VERSION_CONFLICT` with `currentVersion`; the editor reloads |
| Two admins edit the same flag | `SELECT … FOR UPDATE` on the config row; the second waits, then fails `If-Match` |
| Two admins edit different flags in one environment | Both bump `environments.snapshot_version` under its row lock; each compile sees the other's committed change; versions are gap-free |
| Snapshot published twice or out of order | Valkey CAS only moves forward; edges and SDKs accept only newer versions |
| Snapshot published but pub/sub message lost | Reconcile against PostgreSQL every 5 s |
| SDK fetch races a push | The push names a version; the fetch is for that version; immutable |
| Batch retried with the same id | `SET NX` + `XADD` in one Lua script → 202 `duplicate: true`, not enqueued |
| Events re-sent in a different batch | Same `event_id` → collapsed by ReplacingMergeTree; distinct-unit metrics unaffected meanwhile |
| Worker insert retried | Same entries, same order → same `insert_deduplication_token` → ClickHouse skips the block |
| Exposure rendered twice (StrictMode, remounts, re-renders) | SDK dedup on `flagKey:version:unitId`, persisted in localStorage |
| Sign-in retried | Alias `INSERT … ON CONFLICT DO NOTHING`; the same stable id comes back |

Exactly-once *effects* are claimed only where they hold: one config change per transaction, one snapshot per version, one counted exposure per unit per variant in the analysis. Event delivery itself is at-least-once everywhere.

## Security / Auth

- **Console:** session cookie (httpOnly, SameSite=Lax) with the session in Valkey. Roles are checked per route on the server: reads need `admin` or `viewer`, writes need `admin`; `shopper` accounts cannot use the console at all. Login attempts are rate limited per IP; session checks (`/me`) are not, so browsing never exhausts the limiter.
- **Keys:** each environment has a public client key (ships in the browser bundle; can only read that environment's snapshots and append its events) and a secret server key (identity aliasing, server-side evaluation with alias lookup). Viewers never see server keys. Keys are cached in memory per instance and rotatable in the table.
- **What a snapshot reveals:** rules, variant names and values, and explicit id lists are readable by any visitor. Production keeps sensitive lists server-side (server SDK) or replaces ids with salted hashes in client snapshots.
- **Ingest abuse:** client keys are public, so anyone can send events. The endpoint validates strictly (UUID event ids, bounded strings, ≤ 500 events per batch, 512 KB), rejects implausible timestamps, and production adds per-key and per-IP rate limits and bot filtering. Experiments are robust to random noise but not to targeted pollution; SRM is the alarm.
- **CORS:** the SDK surface allows any origin and uses no cookies; the console and shop APIs are same-origin through the dev proxy.
- **Audit:** every mutation is attributed (`actor`, `actor_id`) in the same transaction, including the kill switch's mandatory reason.

## Observability

Prometheus metrics (`backend/src/shared/metrics.ts`) on each API instance's `/metrics` and the worker's metrics port:

| Metric | Why it matters |
|--------|----------------|
| `exp_snapshot_propagation_seconds{reason}` | Publish → client report, per client; the kill-switch SLO |
| `exp_snapshot_version{environment}` | Each instance's in-memory version: a lagging instance is visible immediately |
| `exp_snapshot_reloads_total{trigger}` | `reconcile` increments mean pub/sub messages are being lost |
| `exp_snapshot_requests_total{result}` | The 200 / 304 / by-version mix: a low 304 ratio means clients aren't revalidating |
| `exp_sse_connections`, `exp_snapshot_pushes_total` | Stream fan-out per instance |
| `exp_ingest_events_total{type,outcome}` | Accepted, duplicate batches, rejected events |
| `exp_worker_stream_lag_entries`, `exp_worker_insert_seconds`, `exp_worker_rows_total{table}` | Ingest backlog and ClickHouse health |
| `exp_snapshot_compile_seconds` | Compile time inside the write transaction (grows with flag count) |

Structured logs (pino) carry the instance id, so a kill switch on api-a and its push on api-b can be followed across processes. The console's live client view is itself an observability tool: every SDK reports the version it holds and how long the last update took to reach it. The results page shows raw rows vs distinct events (unmerged duplicates) and late-event counts, so data quality is visible next to the numbers it affects.

Alerts worth having in production: propagation p99 > 5 s; any edge instance more than one version behind for 30 s; reconcile reloads > 0 for 5 minutes; worker lag growing for 5 minutes; SRM flagged on any running experiment; exposure volume for a running experiment dropping by more than half day over day.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Platform API completely down | SDKs keep evaluating from memory and storage; new visitors with no cache get coded defaults after ≤ 300 ms; events queue and retry; nothing user-facing breaks |
| PostgreSQL down | Console writes fail (503); delivery continues from memory and Valkey; new instances load the latest from Valkey |
| Valkey down | Publish fails (write still committed; reconcile covers it); ingest returns 5xx so SDKs retry later; sessions fail (console sign-in unavailable) |
| Pub/sub message lost | Reconcile loop: ≤ 5 s extra delay |
| An edge instance restarts | Its SSE clients reconnect with jittered backoff to any instance; `hello {version}` tells them whether to fetch |
| ClickHouse down | The worker's inserts fail, entries stay pending in the stream and are retried with the same token; results return 5xx; nothing is lost while the stream (AOF) holds |
| Ingest worker crash mid-block | Own pending entries re-read in the same grouping → same token → no duplicates |
| Ingest worker gone for good | Another consumer claims its entries after 30 s; ReplacingMergeTree absorbs regrouping duplicates |
| Event stream exceeds MAXLEN while the worker is down | Oldest entries are trimmed (documented loss bound, ~1M batches); alert on lag long before that |
| SDK offline at kill time | Serves its last known good snapshot until it reconnects (immediate catch-up via `hello`), and ignores caches older than 7 days at startup. The trade-off: a stale ruleset keeps a killed feature alive on an offline device, while discarding the cache too eagerly would flip every offline user to defaults; for truly dangerous features, ship the "off" path as the coded default and keep the cache age short |
| Corrupt or foreign snapshot | Rejected by the SDK (schema, environment, version checks); the previous one stays |
| Browser closes with unsent events | `sendBeacon` on pagehide; plus persisted queue re-sent on next visit (same batch ids → duplicates rejected) |

## Scalability Considerations

What breaks first, in order:

1. **Snapshot downloads per change.** 2M clients × 60 KB per change. Immutable `/snapshots/:version` URLs on a CDN make each change one origin fetch per PoP; version-only pushes keep the stream frames tiny; jittering the fetch by up to a second for non-kill changes flattens the spike further. Next steps: delta snapshots (`from v18 to v19`) and per-application snapshots so a mobile app doesn't download web-only flags.
2. **Stream connections.** ~2M concurrent SSE connections ≈ 40-100 edge instances at 20-50k connections each with an evented server; pub/sub fan-out is one message per change per instance, independent of client count. Mobile backgrounded apps use push notifications or polling instead of holding a stream.
3. **The analysis join.** Each results read scans all conversions of the metric. Add materialized views that pre-aggregate per (experiment, unit): first exposure, variant set; and per (metric, unit, day): conversion times. Cache finished days; recompute only the open window. Results then cost O(units) instead of O(events).
4. **Identity resolution.** Sync `identity_links` into a ClickHouse dictionary and resolve every unit id through it at query time, which also merges a second device's pre-sign-in exposures.
5. **Ingest.** Replace the Valkey stream with Kafka (partitioned by environment and unit) and run several worker consumers; ClickHouse inserts of 10-50k rows per block keep part counts healthy. Sample assignment events (10%) since they are diagnostic.
6. **Control plane.** Even 10 changes per second is tiny for PostgreSQL; the per-environment row lock serializes compiles, and compile time grows with flag count (~ms locally for six flags; ~50 ms at 2,000), which caps an environment at tens of changes per second. Split by application or environment if ever needed.
7. **Mutual exclusion and holdouts** (layers, so one user is in at most one experiment of a layer; a global holdout to measure cumulative impact) become necessary at ~100 concurrent experiments; they are a second hash layer in front of the same allocation.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| What counts as exposure | Render-time event from `<Exposure>` | Log at assignment / analyze everyone assigned | Assigned-but-unseen units dilute the effect toward zero |
| Weight changes | Stable bucket ranges, minimal movement | Re-partition from 0 / re-hash | Re-hashing sends ~80% of treatment back on a 10 → 20% ramp |
| Anonymous → signed in | Alias to the first anonymous id | Re-bucket by user id, drop switchers | No flip mid-funnel; keeps converters in the analysis |
| Where evaluation runs | Locally in the SDK from a snapshot | Remote decision per request | No network on the render path; survives outages |
| Config delivery | Immutable versions + ETag + SSE version hints | Polling / pushing full rulesets | Seconds-level kill switch, CDN-friendly fan-out |
| Lost pub/sub | Reconcile against PostgreSQL every 5 s | Durable broker for config events | Bounded staleness with no extra infrastructure |
| Ingest dedup | Batch key + insert token + ReplacingMergeTree | Exactly-once pipeline | Exactly-once from a browser doesn't exist |
| Clock skew | Shift by receivedAt − sentAt per batch | Trust device time / use arrival time | Keeps device ordering, fixes wrong clocks |
| Analysis | Read-time from raw rows | Streaming counters | Late events, windows and crossovers stay correct |
| SRM expectation | Per config version | Current weights only | A ramp would otherwise look like a broken split |
| Interval method | Wilson score | Normal approximation | Correct at small n and near 0% |
| Console updates | Polling (1-5 s) | SSE for the console too | Simple; keeps the screenshot harness off long-lived connections |

## Implementation Notes

### Local architecture

| Process | Default port | What it runs |
|---------|--------------|--------------|
| api-a, api-b | 3000, 3001 | `backend/src/api/index.ts`: console API, SDK surface (snapshot, stream, events, report, identify, evaluate), storefront API; snapshot sync (pub/sub + reconcile) |
| Ingest worker | 3100 (metrics) | `backend/src/ingest/index.ts`: Valkey stream → ClickHouse |
| Admin console | 5173 | `frontend/` (Vite proxy → api-a) |
| Demo storefront | 5180 | `demo-app/` (Vite proxy → api-b, so every push crosses Valkey) |
| PostgreSQL / Valkey / ClickHouse | 5432 / 6379 / 8123 + 9000 | `docker-compose.yml` |
| Traffic simulator | n/a | `npm run simulate` (Node SDK client, real time) |

### Production-grade patterns actually implemented

- **One shared evaluation core.** `sdk/src/core/` (hash, allocation, targeting, evaluate, types) is imported by the SDK, the backend (`backend/src/shared/evaluation.ts` re-exports it; `tsconfig` root is the project folder) and the console (Vite alias `@exp/core`). Parity is tested against an independent hash implementation and through the SDK client on random units.
- **Stable range allocation with movement accounting**: `allocateStable`, `compareAllocations`, and the two naive strategies for comparison (`sdk/src/core/allocation.ts`).
- **Compile-in-transaction snapshots with forward-only publish and reconcile** (`backend/src/services/snapshot-service.ts`):

```ts
const bumped = await client.query('UPDATE environments SET snapshot_version = snapshot_version + 1 … RETURNING snapshot_version', [environment])
const body = compileSnapshot(environment, version, await loadCompilable(client, environment))
await client.query('INSERT INTO snapshots (environment, version, etag, body, …) VALUES (…)')
// after COMMIT: Lua CAS latest (only if newer) → SET publishedAt → PUBLISH {environment, version}
```

- **ETag/304 and immutable versioned URLs** (`backend/src/api/routes/sdk.ts`), **SSE fan-out across instances** (`backend/src/api/live.ts`).
- **Atomic batch dedup + enqueue** in one Lua script (`backend/src/services/ingest-service.ts`), **skew correction and validation** (`backend/src/ingest/batch.ts`), **insert-token idempotent worker with own-pending replay and XAUTOCLAIM** (`backend/src/ingest/index.ts`).
- **SDK**: startup ladder, monotonic apply, LKG with max age, fetch-based SSE with watchdog and jittered reconnect, persisted queue with stable batch ids, beacon on unload, exposure dedup, React `useVariant` / `<Exposure>` / `<Experiment>` (`sdk/src/client/`, `sdk/src/react/`).
- **Statistics**: Wilson, pooled z-test, delta-method lift interval, chi-square via the regularized incomplete gamma function (`backend/src/domain/stats.ts`), per-version SRM expectation (`backend/src/domain/analysis.ts`).
- **Optimistic concurrency and audit in the same transaction** (`backend/src/services/flag-service.ts`).
- **Prometheus metrics, pino logs, health and readiness** on every process; the worker survives `EADDRINUSE` on its metrics port.

### Simplified or substituted

- **Valkey stream instead of Kafka** for events; one ingest worker.
- **The API instances are also the edge**: no CDN; `Cache-Control: immutable` is set as production would use it.
- **Session auth** for the console instead of SSO; a static product catalog for the storefront.
- **Read-time analysis** over raw rows, no rollups; one primary metric (conversion) per experiment, no revenue or continuous metrics, no sequential testing or variance reduction (CUPED).
- **Assignment events are not sampled.**
- **Identity links stay in PostgreSQL**; the analysis does not merge a second device's pre-sign-in unit.

### Omitted

CDN, multi-region edges, delta snapshots, mobile SDKs and push-notification fallbacks, mutual-exclusion layers and holdouts, scheduled ramps and automatic guardrail rollbacks, multiple metrics with false-discovery control, sequential or Bayesian analysis, warehouse export, Kubernetes.

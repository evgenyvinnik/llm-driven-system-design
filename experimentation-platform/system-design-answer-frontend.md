# Experimentation Platform — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45-60 minutes · Requirements → Client architecture → Key question → Rendering and state → Deep dives → Console UX → Traces*

> "I'm asked to design feature flags and A/B experiments, and from the frontend there are really two products here. One is an SDK that lives inside someone else's page: it decides which variant to render, it must never slow that page down or break it, and it has to report honestly what the user actually saw. The other is the console where a product team edits weights, pulls the kill switch and reads results. Most of the interesting frontend problems are in the first one. The SDK sits in the render path of every screen, and it is the only component that knows whether a variant was really shown. The backend contract I'll rely on is small: an immutable, versioned snapshot of the ruleset with an ETag, a stream that only says 'version N exists', and an events endpoint that recognizes a retried batch."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Render never waits on the network; exposure is a render-time fact |
| Client architecture and API contract | ~6 min | One SDK client as an external store; snapshot, stream and events contracts |
| The key question | ~4 min | Assignment vs exposure as two APIs, two events, two counts on the results page |
| Rendering and state | ~6 min | Startup ladder, flicker trade-off, useSyncExternalStore, Zustand |
| Deep dives | ~15 min | Render path, exposure placement, getting events off a closing page |
| Console UX | ~6 min | Move preview, kill switch, results, live clients, viewer role |
| Traces, checklist, wrap-up | ~7 min | One success, one failure, six review questions |

---

## 🎯 Requirements (~4 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Does evaluation happen on the client or per request on a server? | Whether the network sits on the render path | On the client, from a downloaded ruleset. A server SDK exists for server rendering and private rules |
| Can the first paint wait for config? | Blank page vs flicker | No. At most a few hundred milliseconds, and only for a first-time visitor |
| How fast must a kill switch land? | Push vs polling | Seconds for an open tab; "on reconnect" for an offline device |
| Do experiments span sign-in? | Identity in the SDK | Yes. Growth experiments live in the sign-up funnel |
| Who uses the console? | Roles and controls | Admins edit; viewers see everything and change nothing |
| Do mobile apps matter? | Offline, backgrounding | The same model, but I'll design the web SDK and storefront in depth |

### Functional requirements

1. **SDK:** synchronous local evaluation, a last-known-good cache, safe coded defaults, live updates, render-time exposure with dedup, conversion tracking, batched events that survive tab close.
2. **React bindings:** a provider, a variant hook, an exposure component (on mount or when visible), and an "experiment" helper that renders one element per variant.
3. **Demo storefront:** three experiments on different surfaces (product page, rarely opened tab, cart) and an inspector showing what the SDK knows.
4. **Console:** flag list, editor (status, kill switch, weights with a live users-moved preview, targeting rules with a try-a-unit evaluator), results, audit log and live SDK clients.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Evaluation cost | < 1 ms, zero network calls on the render path | Local evaluation from an in-memory snapshot |
| First render | 0 ms wait with a cache; ≤ 300 ms without | Startup ladder, bounded provider wait |
| Availability | 100% of renders get an answer, even with the platform down | Last known good, then coded defaults |
| Kill switch | About a second for a connected tab; ≤ 5 s if a pub/sub message is lost; the poll interval without a stream | Version pushes over SSE plus polling fallback |
| Exposure accuracy | One exposure per unit per experiment per config version, same rule in every arm | Exposure component, persisted dedup |
| Event durability | Survive tab close, crash and offline; never double count | Persisted queue, stable batch ids, beacon |
| Console honesty | The preview equals what the server will do | The browser runs the same allocator |

---

## 🏗️ Client Architecture (~4 min)

```
┌───────────────────────────────┐        ┌───────────────────────────────────┐
│ Admin console (React)         │        │ Storefront (React + SDK)          │
│ Zustand: auth/role, env       │        │ Zustand: shopper, cart            │
│ usePoll: flags, flag, results,│        │ ExperimentClient = external store │
│ audit, live clients (1-10 s)  │        │ useVariant, <Exposure>, inspector │
│ @exp/core runs in the browser │        │ localStorage: snapshot, queue,    │
│ (allocator, evaluator)        │        │ dedup keys, anonymous id          │
└──────────────┬────────────────┘        └───────┬────────────────┬──────────┘
               │ REST + session cookie           │ GET snapshot   │ POST events
               │ If-Match on every edit          │ SSE stream     │ sendBeacon
               ▼                                 ▼                ▼
┌───────────────────────────────┐        ┌───────────────────────────────────┐
│ Control plane: commit config, │ pubsub │ Delivery + ingest edge (stateless)│
│ compile immutable snapshot vN │───────▶│ snapshot in memory, SSE fan-out,  │
└───────────────────────────────┘ {env,v}│ batch-id dedup on events          │
                                         └───────────────────────────────────┘
```

> "Locally the console talks to one API instance and the storefront to the other, so every kill switch I demo has to cross the pub/sub hop. That matters because the scary failure isn't the happy path. It's an instance that hasn't heard about version 19 yet."

### Inside the SDK client

```
┌────────────────────────────────────────────────────────────────────┐
│ ExperimentClient (one per page; the same class runs in Node)       │
│                                                                    │
│  snapshot holder ◀── apply(): well formed? same env? newer? ◀──┐   │
│    source: network | bootstrap | cache | defaults              │   │
│        │                                                       │   │
│  peek() / evaluate(): pure, synchronous, shared core module    │   │
│        │                                                       │   │
│  state {version, source, connection, context, revision}        │   │
│        │ subscribe / getState                                  │   │
│        ▼                                                       │   │
│  React: useSyncExternalStore → useVariant, <Exposure>          │   │
│                                                                │   │
│  transport: SSE hello/snapshot {v} → GET /snapshots/v ─────────┘   │
│             poll GET /snapshot + If-None-Match while stream down   │
│  event queue: pending → batches {batchId} → POST, or beacon        │
│  storage: last known good · queue · exposed/assigned keys          │
└────────────────────────────────────────────────────────────────────┘
```

### The API contract the frontend relies on (~2 min)

```
GET  /sdk/v1/snapshot             latest; ETag "prod-v18"; If-None-Match → 304, no body
GET  /sdk/v1/snapshots/:version   one immutable version; Cache-Control: immutable, 1 year
GET  /sdk/v1/stream               SSE: hello {version} on connect, snapshot {version} on change,
                                  comment ping every 15 s
POST /sdk/v1/events               {batchId, sentAt, events[]} → 202 {accepted, rejected, duplicate}
                                  (JSON, or text/plain from a beacon with ?key=)
POST /sdk/v1/clients/report       {sdkInstanceId, version, source, transport} → live client view
PUT  /api/v1/flags/:key/environments/:env   If-Match: "<config version>" → 409 when stale
POST /api/v1/flags/:key/environments/:env/kill   {reason} → {snapshotVersion, publishedAt}
GET  /api/v1/flags/:key/results?env=   assigned and exposed analyses side by side
```

> "Three properties make the client simple. The ETag is the version, so revalidation is one header. A version's body never changes, so the client can fetch exactly what a push names, and a lagging instance still returns the right bytes. And the stream carries only a version (plus a reason and publish time), never the ruleset. A client that missed five pushes doesn't need all five. It needs the latest version, which `hello` gives it on every reconnect."

---

## 🔑 The Key Question: Assigned but Never Seen (~4 min)

**"A user was assigned a treatment but never actually saw it. Should that count as exposure, and how does the system tell the two cases apart?"**

> "No. Assignment is a pure function the SDK can compute for anyone at any time. Exposure is a fact about what was on the screen. So they are two different events, written from two different places in the component tree, and the analysis reads only one of them."

| | Assignment | Exposure |
|---|-----------|----------|
| Written by | useVariant and evaluateAll (whenever the app *asks*) | `<Exposure>` or useExposure (where the variant *renders*) |
| Trigger | Evaluation | Mount, or ≥ 50% in the viewport with whenVisible |
| Dedup | flag : config version : unit, persisted | flag : config version : unit, persisted |
| Used for | Diagnostics: is bucketing balanced? | The analysis denominator |
| Who can log it | In-experiment evaluations only | In-experiment evaluations only |

The SDK makes the distinction structural, so a developer can't blur it by accident:

1. **useVariant never logs exposure.** It evaluates locally and records a diagnostic assignment. Asking is not seeing.
2. **`<Exposure>` logs on mount**, which is right for above-the-fold content like the buy button. **whenVisible** waits for an IntersectionObserver to report ≥ 50% visibility, which is right for a banner on the Rewards tab that most visitors never open.
3. **logExposure refuses anything not in the experiment.** Coded defaults, forced QA users, excluded units, unallocated buckets, inactive experiments and plain flags all return false. Only randomized units can enter the denominator.
4. **The results page shows assigned and exposed side by side**, per arm, with the lift under both. In the demo the rewards experiment assigns about 4,000 visitors and exposes about 480. On checkout_cta the exposed-only lift is about +57% relative, and about +32% among everyone assigned. It's the same extra purchases spread over twice as many units.

```
 useVariant for rewards_teaser ── peek() + recordAssignment (diagnostic, deduped)
            │
            ▼  Evaluation {variant, reason, inExperiment, config version, unit id}
 the component decides where the variant renders
            │
            ├─ <Exposure>              ── on mount ─────────────┐
            └─ <Exposure whenVisible>  ── observer: ≥ 50% seen ─┤
                                                                ▼
                    logExposure: in the experiment? ── no ──▶ nothing (default, forced,
                                    │ yes                     excluded, not allocated,
                                    ▼                         inactive, plain flag)
                    flag:version:unit already logged? ── yes ──▶ nothing (StrictMode,
                                    │ no                         remount, reload)
                                    ▼
                    persist dedup key ──▶ queue exposure event ──▶ batch ──▶ ingest
```

The storefront inspector shows the same distinction per visitor. Each experiment row reads "assigned only" until the surface actually renders, and then "yes". A visitor who never opens the Rewards tab stays "assigned only" for the whole session. That's the two cases told apart, on screen.

---

## 🖼️ Rendering Strategy and State (~6 min)

### The startup ladder

```
page load
   │
   ▼  constructor, synchronous, before the first render
   ├─ bootstrap snapshot handed in by the host? ──▶ hold it        (source: bootstrap)
   ├─ last known good in localStorage, < 7 days? ─▶ hold if newer  (source: cache)
   └─ neither ────────────────────────────────────▶ hold nothing   (source: defaults)
   │
   ▼  <ExperimentProvider>
   ├─ holding a snapshot ─▶ render children immediately
   └─ holding nothing ────▶ render after the first fetch or 300 ms, whichever is first
   │
   ▼  background, never on the render path
   GET /snapshot  If-None-Match: "prod-v18" ─▶ 304: source becomes network
                                            └▶ 200: apply if newer, persist as LKG
   SSE hello {version} ─▶ newer than held? ─▶ GET /snapshots/:version
```

> "The ladder means the network decides what the *next* render shows, never whether *this* render happens. A returning visitor renders from cache in the same frame as the rest of the app. A first-time visitor waits at most 300 ms, then gets the coded defaults rather than a blank page."

### The flicker trade-off

| Approach | First visit | Returning visitor | Platform down |
|----------|-------------|-------------------|---------------|
| ✅ Cache first, bounded 300 ms wait, then defaults | Maybe a late switch from default to variant | No wait, no flicker | Renders from cache or defaults |
| ❌ Block render until the fetch completes | No flicker | Waits a round trip every load | Blank page until the timeout |
| ❌ Render defaults, never wait | Frequent default → variant switches | Fine from cache | Fine |

> "Waiting trades first paint for consistency, and 300 ms is where I draw the line. Past it, a slow flag service costs the product more than a flicker costs the experiment. There's also a safety property here. The defaults path is never in the experiment, so a visitor who briefly saw the default and then the treatment logs only the treatment exposure. The flicker is a UX cost, not a data bug. The real fix for first-visit flicker is the second rung: a server-rendered page hands the snapshot in as bootstrap. The SDK supports that, though the demo storefront is a client-only app and doesn't use it."

### State management

| State | Where it lives | Why |
|-------|----------------|-----|
| Snapshot, source, connection, identity context, revision | The SDK client, read with useSyncExternalStore | Updated from outside React (stream, timers, storage); tearing-free reads under concurrent rendering |
| Evaluation per component | useMemo over (key, revision, context) | Evaluating is microseconds; recomputed only when the snapshot or identity changes |
| Queue size, exposures logged | Client state, patched without bumping revision | The inspector updates without re-evaluating every flag on every queued event |
| Storefront shopper and cart | Zustand (cart persisted to localStorage) | Plain UI state, unrelated to experiments |
| Console role and selected environment | Zustand (environment remembered per browser) | Read by every page; tiny |
| Console server data (flags, results, clients) | usePoll per page, not a global store | Each page owns its refresh interval; no cache invalidation to get wrong |

> "I deliberately didn't put experiment state in Zustand. The SDK client is already a store with subscribe and getSnapshot semantics, and it has to work without React (the Node simulator runs the same class). useSyncExternalStore is the exact bridge for that. A second copy in Zustand would just be two sources of truth that can disagree for a render."

The revision counter is the re-render trigger. Every applied snapshot or context change bumps it, so every useVariant re-evaluates. The kill switch reaches the button through that one counter.

---

## 🔧 Deep Dives (~15 min)

### Deep dive 1: The render path must never depend on the network

**Decision.** Evaluate synchronously from whatever snapshot is held, chosen by the ladder: network, bootstrap, last known good (≤ 7 days old), coded defaults. Accept a new snapshot only if it is well formed, for the same environment and strictly newer, and persist each accepted one as the new last known good.

**Why it works here.** Flags guard every screen. In capacity terms that's about 25 billion evaluations a day, roughly 50 flag reads per page view. Local evaluation makes each one free and offline-proof. The monotonic apply rule is what makes a kill switch stick. Several sources race each other: a poll's 200, a stream-triggered fetch, an old proxy copy, a reordered response. Without the rule, the slowest of them wins. With it, a client that has seen version 19 can never go back to 18, whatever arrives later and from wherever. Persisting on apply means the next cold start begins from the kill, not from before it.

**Why the alternatives fail.** A remote evaluate call per page puts a network round trip in front of first paint. At p99 that's hundreds of milliseconds on mobile, and an outage of the flag service becomes an outage of the product. Blocking the provider until the first fetch has the same failure on a smaller scale: with the API down, every page is blank until the timeout. "Latest wins" without version checks fails more quietly. A kill switch at 12:00:01 can be undone at 12:00:03 by a slow /snapshot response from an instance that hadn't caught up, and nothing in the UI says so.

**What I give up.** The whole ruleset is readable by any visitor: rule conditions, variant names, explicit id lists. Private rules belong in server-side evaluation. A cached ruleset can be stale. An offline device keeps serving a killed treatment until it reconnects, which is why the cache has a 7-day ceiling, and why truly dangerous features should ship "off" as the coded default. And the snapshot grows with flag count, which at scale means per-application snapshots.

### Deep dive 2: Where exposure is logged in the component tree

**Decision.** Exposure is logged by a component wrapped around the variant's rendered element: on mount by default, or once ≥ 50% of it is visible with whenVisible. The rule for developers is that **the exposure trigger belongs to the surface, not the variant**. Both arms log from the same place under the same condition.

**Why it works here.** The experiment asks whether seeing B instead of A changed behavior. A mount-time or visibility-time event in both arms produces exactly that population. React-specific hazards are absorbed by one dedup key, flag : config version : unit, persisted in localStorage:

| Hazard | What happens | Why it's harmless |
|--------|--------------|-------------------|
| StrictMode double effects in dev | Effect runs, cleans up, runs again | Second call hits the dedup key |
| Re-renders (new evaluation object on any revision) | Effect re-runs | Deduped |
| Navigate away and back, reload | Remount | Dedup key persisted (newest 1,000 kept) |
| whenVisible element unmounts before reaching 50% | Observer disconnects in cleanup | No exposure: it was never seen |
| Kill switch re-render | Evaluation becomes inactive | logExposure refuses it |
| Ramp moves this unit | New config version, new variant | A new exposure; the analysis treats the unit as a crossover |

**Why the alternatives fail.** Logging exposure inside useVariant, or for everyone at session start, makes every visitor exposed. The demo root calls evaluateAll at session start, as many apps do for analytics tagging. For the rewards experiment that's 4,000 "exposed" units of which about 480 saw anything. The other 88% convert at the same rate in both arms, so a real +20% effect reads as roughly +2% and never reaches significance. Asymmetric placement fails worse, because it fails silently. The shipping_banner experiment in the demo is deliberately broken. Control logs on mount. Treatment logs from the onLoad of an illustration that comes from a slow CDN (the demo's shop API answers after 3.5 s):

1. Every cart visitor is assigned, and assignments are balanced (p ≈ 0.45).
2. Control visitors are logged as soon as the banner mounts.
3. Treatment visitors who check out or leave before the image finishes loading are never logged, although they saw the banner text.
4. Exposures come out about 58/42 instead of 50/50 (p ≈ 10⁻¹⁰), and the results page shows a rose-colored banner: "Sample ratio mismatch: do not trust these results".
5. The banner compares with the assignment split. Assignments are balanced, so the message says bucketing works and the loss is in exposure logging. That points the developer straight at the component.

**What I give up.** Exposure-only analysis is more sensitive and more fragile. The SDK can make correct placement easy (`<Experiment>` renders each variant inside `<Exposure>` for you), but it can't enforce it. That's why SRM runs on every result and why assignment events are kept at all. Mount is also only a proxy for "seen". I don't measure dwell time, and a component mounted under a modal counts as exposed unless the developer uses whenVisible.

### Deep dive 3: Getting events off a page that is closing

**Decision.** Exposures, assignments and conversions go into a queue persisted to localStorage. It forms batches with an id assigned once, flushes every 2 s or at 50 events, and retries 408, 429, 5xx and network failures with jittered exponential backoff (capped at 30 s, at most 20 attempts), keeping the same batch id and events. Other 4xx responses drop the batch. On pagehide or visibilitychange to hidden, every unacknowledged batch goes out through sendBeacon as text/plain JSON, and stays queued until a 202 comes back.

```
push(event) ─▶ pending (persisted) ─▶ every 2 s or 50 events ─▶ batch {batchId fixed forever}
                                                                   │
        ┌─────────────────────┬──────────────────────┬─────────────┴────────────┐
        ▼                     ▼                      ▼                          ▼
  202 accepted          202 duplicate          408/429/5xx/network          other 4xx
  remove batch          remove batch           same id, backoff ≤ 30 s      drop batch
pagehide / hidden ─▶ beacon every unacked batch (text/plain, ?key=) ─▶ still queued
next page load    ─▶ restore queue ─▶ resend same batch ids ─▶ server: duplicate
```

**Why it works here.** The events that matter most happen right before the page goes away. A purchase is followed by navigation. A mobile tab is backgrounded and killed. Three mechanisms cover three ways to lose an event. The beacon is the browser's only reliable send during unload. The persisted queue covers a crash or a beacon the browser refused. The fixed batch id makes all this redundancy safe: the server records each batch id atomically with enqueueing it, so the same batch arriving by fetch, then beacon, then again on the next visit is counted once. text/plain matters because sendBeacon can't set headers, and a JSON content type cross-origin would need a CORS preflight that an unloading page never completes. So the client key travels in the query string and the body.

**Why the alternatives fail.** A fetch per event during unload is cancelled when the document goes away: the purchase you most wanted is the one you lose. Fire-and-forget batches with no persistence lose everything queued in the last 2 seconds of every session. On a product page that's often the exposure itself. Retrying with a *new* batch id on each attempt means the server can't recognize a retry, so every lost 202 becomes a second copy in the warehouse, and flaky mobile connections lose responses often. Distinct-unit queries and merge-time dedup on event id would absorb those copies eventually, but raw counts and the event-health panel are wrong until a merge. The batch id stops the copy at the door instead of leaning on the last line of defense.

**What I give up.** Redundant sends: every tab switch beacons everything unacknowledged, and the server spends a dedup lookup per copy. The batch dedup window is 24 hours, so a device that comes back after a day would double count, but the client gives up after 20 attempts long before that. And localStorage is synchronous, so the queue persists on every push. That's fine at tens of events per page and would need batching of the writes at hundreds.

---

## 📡 Live Updates in the Browser (~2 min)

The SDK reads SSE with fetch and a ReadableStream rather than EventSource. A 45 s silence watchdog runs against the server's 15 s pings. Reconnects use full-jitter backoff from 1 s up to 30 s, and the client polls with If-None-Match while the stream is down.

| Concern | ✅ fetch + ReadableStream | ❌ EventSource |
|---------|--------------------------|----------------|
| Auth | Client key in a header | Query string only, no custom headers |
| Half-open connections (laptop sleep, proxy) | Watchdog aborts after 45 s of silence | No heartbeat check; looks "open" until TCP notices, often minutes |
| Reconnect timing | Full jitter, so a restarted instance isn't stampeded | Browser-fixed retry delay; every client returns at once |
| Node (simulator, server SDK) | The same code | Not available without a polyfill |
| Cost | Under 100 lines: a frame parser that handles split chunks, a reconnect loop | Free |

> "When an edge instance restarts, all of its clients disconnect at the same instant. With EventSource they all come back after the same fixed retry delay, together, and hit whichever instance the load balancer picks. Full jitter spreads that over the backoff window. A silent half-open stream is worse than a dropped one, because the client believes it's live and stops polling. That's the case the watchdog exists for. The cost is owning the parser and the loop, and both are tested, including frames split across chunks."

A push never carries the ruleset. On `snapshot {19}` the client fetches /snapshots/19, which is immutable and CDN-cacheable in production. If that fetch fails, it falls back to /snapshot. Every applied version, and every 15 s, the client reports what it holds, which is what the console's live view shows.

---

## 👤 Identity on Sign-in (~2 min)

1. On first visit the browser creates an anonymous id in localStorage. User-unit experiments bucket by a **stable id**, which starts out equal to the anonymous id.
2. Sign-in sends the anonymous id with the credentials. The shop's backend, using the secret server key the browser never sees, links that device and returns the user's stable id: the first anonymous id they ever signed in from.
3. The app calls identify with that stable id. On the user's first sign-in it equals the current anonymous id, so the bucket doesn't change: no flip mid-funnel, no new exposure.
4. If the sign-in response is lost, identify is never called with a new id, and **the SDK keeps bucketing by the current stable id**. A failed identify never flips anyone. On the next load the root asks /shop/me and re-identifies if the server knows a different stable id.
5. On a second device, the same user gets the first device's stable id back and converges on the same bucket after sign-in.
6. Sign-out rotates the anonymous id, so the next person on a shared device is a new unit.

> "Re-bucketing by user id at sign-in would flip about half of the people who sign in on a 50/50 test, at the worst moment, and they'd be crossovers thrown out of the analysis. Those are exactly the visitors most likely to convert."

---

## 🛠️ The Console (~6 min)

### Editor: weights with a live move preview

| Element | Behavior |
|---------|----------|
| Weight inputs | Percentages; a flag edits only its "on" share. Shows "N% not enrolled (served the default, never logged as exposed)" |
| Current vs proposed bars | All 10,000 buckets drawn as ranges where they really are. A ramp visibly grows into released or free space |
| Move preview | "This change moves 10% of units, 0% of current treatment units out of treatment", with transitions per pair of variants |
| Strategy comparison | Stable ranges vs re-partition from bucket 0 vs re-hash, on the same weights |
| Save | PUT with If-Match on the config version; then "Saved as v6; snapshot v19 pushed. 10% of units moved." |

> "The preview isn't an estimate. The console imports the same allocation module the server runs on save, so the proposed bars and the moved percentage are exactly what will happen. For a 10% to 20% ramp the comparison row is the teaching moment: re-hashing would move about 26% of units and send about 80% of current treatment users back to control."

Concurrency is optimistic. The editor polls its flag every 4 s and is keyed by config version. When another admin saves, the version moves and the editor remounts from the new current ranges, discarding the draft. If I save against a stale version before the poll catches up, I get a 409, and the next poll brings the new version. I chose that deliberately, because a preview computed against stale ranges would be wrong.

### Targeting and try-a-unit

Rules are ordered, first match wins, with reorder buttons and a fallthrough select (enroll or exclude). Under them, a "try a unit" row evaluates a hypothetical unit (id, country, plan, platform) against the *unsaved* rules with the shared evaluator. It shows the variant, the reason, the bucket and "logs exposure when rendered" only for in-experiment results, so a forced QA rule visibly says it won't count.

### Kill switch

A red panel: "Stop experiment" (or "Force off" for a flag). Clicking it opens a reason field, and Confirm stays disabled until the reason is non-empty. The server also requires it, and it lands in the audit log as "KILL SWITCH: stopped (checkout errors)". The result reads "Snapshot v19 published at 14:02:11" with a link: "Watch it reach clients →". The button is disabled when the experiment isn't running or the user is a viewer, with a tooltip saying why.

### Results and live clients

| Page | Polls | What it shows |
|------|-------|---------------|
| Results | 5 s | SRM banner (OK or "do not trust", with the assigned-split diagnosis); arms with Wilson CI bars, lift interval, p-value; assigned vs exposed; event health (rows vs distinct, unmerged duplicates, late events) |
| Live SDK clients | 1 s | Each SDK: label, SSE via which instance or polling, version held ("current" or "2 behind"), how long the last update took to reach it (kill switches highlighted), last seen |
| Flags list, audit | 5 s | Allocation bars per environment; every change with actor and summary |

**Why polling instead of SSE in the console.** The console is a handful of admins watching state that changes over seconds. A poll every 1-5 s, paused while the tab is hidden, costs nothing at that audience size. Each refetch goes through the same role-checked endpoint as the first load, and there's no reconnect logic and no long-lived connection for the screenshot and smoke harness to wait on. The SDK needs push because it's millions of clients and a kill switch. The console doesn't.

**Viewer role.** Viewers get the same pages with every control disabled and a "Read-only" notice in the shell. The disabled button is convenience. The enforcement is the server returning 403 on every write route, whatever the UI sends.

---

## 🧱 Component Map (~1 min)

| Component | Reads | Notes |
|-----------|-------|-------|
| ExperimentProvider | client.getSnapshot, ready() | Starts the client; renders at once when a snapshot is held, else after ≤ 300 ms |
| BuyButton (checkout_cta) | useVariant | Copy comes from the variant's value; wrapped in `<Exposure>` on mount |
| RewardsBanner (rewards_teaser) | useVariant | Both arms wrapped in `<Exposure whenVisible>`; lives on a tab about 1 in 8 visitors opens |
| ShippingBanner (shipping_banner) | useVariant, client | Deliberately asymmetric exposure: the SRM demo |
| Inspector | useClientState, peek, hasExposed | Ids, snapshot version and source, connection, queue, per-flag "assigned only" vs "yes"; "reload offline" (blocks only SDK traffic) and "clear SDK cache" to demo the ladder |
| WeightsEditor + MovePreview | usePoll(flag), shared allocator | Keyed by config version, so a concurrent edit remounts it |
| RulesEditor + TryUnit | Draft rules, shared evaluator | Evaluates the unsaved draft, not the saved config |
| StatusPanel + KillSwitch | Config status, role | Reason required; links to the live clients page |
| Results page | usePoll(results, 5 s) | SRM banner first, so a broken experiment is flagged before anyone reads a lift |
| Live clients | usePoll(clients, 1 s) | Held version, transport, propagation per client |

> "The SRM banner sits above the numbers on purpose. If exposure logging is broken, the lift underneath is meaningless, and people read top to bottom."

---

## 📜 Execution Traces (~4 min)

### Successful trace: cached load → exposure → sign-in → purchase

1. A guest opens the storefront. The SDK constructor finds a last known good snapshot v18 in localStorage (two days old, under the 7-day limit), so the source is "cache". The provider renders immediately.
2. In the background: GET /snapshot with If-None-Match "prod-v18" returns **304**. The source becomes "network". The SSE stream opens with `hello {version: 18}`, equal to held, so there's nothing to fetch.
3. The root calls evaluateAll. checkout_cta hashes the stable id into bucket 8680, owned by treatment, and an assignment event is queued, deduped on checkout_cta : 5 : anon_c395…. The inspector shows "assigned only".
4. The guest opens a product. BuyButton's useVariant returns treatment, and the button reads "Buy now · free shipping". `<Exposure>` mounts and logExposure queues one exposure at config version 5. (In development, StrictMode's second effect run hits the dedup key.) The inspector now says "yes".
5. The guest signs in as carol. The shop server links the anonymous id and returns stableId = the same anonymous id (her first sign-in). identify keeps the same bucket. The button doesn't change, and no new exposure is logged.
6. In the cart, checkout calls track('purchase') and flush(). A batch with assignment, exposure and conversion goes out by fetch. Carol closes the tab while it's in flight. pagehide beacons the same batch id as text/plain.
7. Whichever copy arrives first gets **202 {accepted: 3}**. The other gets `duplicate: true` and isn't enqueued again. If the page died before the fetch's 202 came back, the batch is still in localStorage. The next visit re-sends it with the same id and gets "duplicate". Every path counts the purchase exactly once.
8. On the results page, carol's unit is exposed to treatment at v5 and converted 40 s later, inside the 72 h window. She counts once in treatment's exposed numerator and denominator, and once among the assigned.

### Failed trace: kill switch with a lost pub/sub message, an open tab and an offline laptop

1. Checkout errors spike. Alice opens checkout_cta in prod, clicks "Stop experiment", types "checkout errors" and confirms. The transaction stops the config (v6), audits it and compiles snapshot v19. The panel shows "Snapshot v19 published at …".
2. Valkey restarts at that moment and the PUBLISH is lost. The instance serving the storefront doesn't hear about it. Within 5 s its reconcile loop reads version 19 from PostgreSQL, loads it, and writes `snapshot {version: 19}` to its streams.
3. The open tab's SDK sees 19 > 18 and fetches /snapshots/19. apply checks it (well formed, same environment, newer), persists it as last known good and bumps the revision. useVariant re-evaluates to control with reason "inactive", and the button re-renders as "Add to cart". The Exposure effect re-runs, but logExposure refuses: not in the experiment.
4. A slow poll response carrying v18 arrives a moment later. apply ignores it as not newer. The tab never rolls back to the treatment.
5. On Alice's live clients page, the next 1 s poll shows that tab at v19 "current", with an update latency near the 5 s reconcile interval instead of the usual push latency of about a second. Alice can see the lost message's cost. She doesn't have to infer it.
6. A shopper's laptop went offline before the kill. It keeps rendering treatment from v18, because that's the newest thing it has. Its stream loop backs off toward 30 s, polls fail, the inspector shows "offline", and events pile up in the persisted queue.
7. When it reconnects, `hello {version: 19}` triggers a fetch of v19, and the button flips to control. Queued batches flush with their original ids and device timestamps. They're late, and the read-time analysis includes them.
8. Had the laptop stayed offline past 7 days, its next cold start would ignore the stale cache and render coded defaults (control). That's why the "off" path is the coded default.

> "The bound I'd quote: about a second for a connected client, up to 5 s when a pub/sub message is lost, the poll interval for a client without a stream, and 'on reconnect' for an offline one. The live end-to-end suite measures it across repeated kill and resume cycles, with the console on one instance and the SDK streaming from the other."

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer, from the frontend's side |
|----------|----------------------------------|
| Source of truth; when is a write successful? | PostgreSQL holds configs, versions and audit. The SDK's snapshot is a derived, versioned copy. The editor says "saved" only after the 200 that carries the new config and snapshot version. The SDK considers events delivered only on a 202 (accepted or duplicate); until then they stay in localStorage |
| Retry after a lost response? | Edits carry If-Match, so a retried save gets 409 and the poll reloads the editor. A retried kill gets 409 "Already stopped", and the effect isn't repeated. Events reuse the batch id, so the server answers `duplicate`. Snapshot GETs are idempotent. A lost sign-in response leaves the SDK on its current stable id, and /me reconciles on the next load |
| Failure between two steps? | Server commits but the publish fails: reconcile pushes within 5 s. Push arrives but the version fetch fails: fall back to /snapshot, and polling covers the rest. Tab dies between queueing and sending: beacon, then the persisted queue on the next visit, with the same batch ids. Apply and persist happen in the same synchronous call |
| Ordering or consistency required? | Snapshots are totally ordered per environment, and a client never moves backwards. Per-flag edits are linearizable via If-Match. Events need no order: the analysis uses event times and first exposure, so a late batch is just late |
| Access with caches and async work? | Console reads need admin or viewer, and writes need admin, checked on every route and every poll, so a disabled button is never the only guard. The client key is public and can only read snapshots and append events. The server key stays on the shop backend. The cached snapshot holds only public rules, which is why private id lists belong in server-side evaluation. Sign-out rotates the anonymous id |
| What breaks first at scale? | Snapshot bytes per change: 2M connected clients × ~60 KB gzip is about 120 GB from origin, so version-only pushes plus immutable URLs behind a CDN (a production extension; locally the API is the edge). On the client: one stream per tab, against HTTP/1.1's six connections per origin. Then snapshot size in localStorage at thousands of flags. Then the live clients page, which lists every SDK and would need aggregation at production scale. Evidence: locally a kill switch reaches every stream within milliseconds and each version fetch is one in-memory lookup, so origin CPU isn't the constraint. Bytes are |

---

## ❓ Follow-ups the Answer Must Handle

| Follow-up | Answer |
|-----------|--------|
| What if a developer forgets `<Exposure>`? | The experiment shows assignments and no exposures, and the results page says there aren't enough exposures yet for a sample ratio check. Nothing is wrongly counted; nothing is counted at all. `<Experiment>` makes the right thing the default |
| Why not log exposure in the hook and let the analysis filter? | The analysis can't know which assigned units saw the surface. Only the component knows, at render time |
| The variant flickers on first visit: is that exposure? | The default rendered first is never in the experiment, so only the variant's exposure is logged. The flicker is a UX cost; bootstrap from server rendering removes it |
| A ramp moves a user mid-session | The new snapshot re-renders them into the new variant at a new config version, and a second exposure is logged. The analysis counts them for SRM but leaves crossovers out of conversion rates. The move preview showed how many before the save |
| Two tabs open | Each tab has its own client, stream and in-memory dedup set, loaded from localStorage at startup. Two tabs open at once can each log the same exposure, which is harmless because the analysis counts distinct units. They also share one queue key, so a new tab can re-send the other's unacknowledged events: same batch id means the server answers duplicate, and a re-batched event collapses by event id. Last writer wins on that key after a crash, which per-tab keys or a leader tab would fix |

---

## 🚨 Client Failure Handling (~1 min)

| Failure | What the user sees |
|---------|--------------------|
| Flag service fully down | Returning visitors: nothing (cache). New visitors: coded defaults after ≤ 300 ms. Events wait in the queue |
| localStorage disabled or full (private window) | Every storage call is wrapped, and the SDK runs from memory. No LKG, no cross-reload dedup, but rendering is unaffected |
| Corrupt or foreign snapshot | Rejected by apply; the previous one stays; the inspector shows the last error |
| Stream half-open | Watchdog aborts after 45 s of silence, jittered reconnect, polling in between |
| Cache older than 7 days | Ignored at startup in favor of defaults, so a week-old ruleset never comes back to life |
| Console save against a stale version | 409 message inline; the editor reloads to the new version on the next poll |

---

## 📈 Scaling the Client Side (~1 min)

1. **Snapshot fan-out.** Version-only pushes already keep stream frames tiny. Production extensions: a CDN in front of /snapshots/:version, delta snapshots ("v18 → v19"), and up to a second of fetch jitter for non-kill changes.
2. **Connections.** One SSE stream per tab. Production extension: a leader tab per browser holds the stream and rebroadcasts. Mobile apps poll in the background and use a push-notification fallback (also an extension; no mobile SDK here).
3. **Snapshot size.** About 400 KB raw at 2,000 flags. That's fine in memory but heavy for localStorage writes and for parse time on low-end phones. Split snapshots per application and archive stale flags.
4. **Console at scale.** The live clients page lists clients one by one. At millions it becomes a histogram of held versions and propagation percentiles, which the backend already exports as metrics.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Where evaluation runs | In the SDK from a snapshot | Remote call per page or flag | No network on the render path; survives outages |
| First render | Cache first, ≤ 300 ms wait, then defaults | Block until fetched | A slow flag service must not cost first paint |
| Snapshot apply | Strictly newer, same env, well formed | Latest response wins | A kill switch can never be rolled back |
| What counts as exposure | `<Exposure>` on mount or ≥ 50% visible | Log in useVariant / at session start | Assigned-but-unseen units dilute the effect toward zero |
| Exposure dedup | flag : version : unit, persisted | Per-render or per-session | Absorbs StrictMode, remounts and reloads; a new version is a new exposure |
| Event delivery | Persisted queue, fixed batch ids, beacon | fetch per event | Survives unload and crashes; retries never double count |
| Live updates | fetch-based SSE + watchdog + jitter | EventSource / polling | Header auth, half-open detection, no reconnect stampede |
| SDK state in React | useSyncExternalStore on the client | Mirror into Zustand | One source of truth; works without React |
| Sign-in | Keep the stable id (alias) | Re-bucket by user id | No flip mid-funnel |
| Console freshness | Polling 1-10 s | SSE | A few admins; simple; role-checked every time |
| Move preview | Shared allocator in the browser | Server dry-run or estimate | Exact before saving, no round trip per keystroke |

---

## 📝 Wrap-up (~2 min)

> "On the frontend, an experimentation platform comes down to two promises. First, the SDK never makes the product worse: it renders from what it has, picks up changes in about a second, and never goes backwards. Second, it tells the truth about what users saw. Exposure is logged where the variant renders, with the same rule in every arm, and deduped. Assignment is kept only as a diagnostic, so when the two disagree the SRM banner can say where the bug is. The console's job is to make consequences visible before they happen (how many users this ramp moves) and after (which clients have the kill switch yet). Next I'd add server-rendered bootstrap to remove first-visit flicker, a leader tab to share one stream per browser, and a lint rule that flags a useVariant result rendered without an `<Exposure>` around it."

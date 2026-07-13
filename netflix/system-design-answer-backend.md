# Design Netflix - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for Netflix: a video streaming platform serving 200M+ subscribers, roughly 15% of downstream internet traffic, with personalized discovery for every profile. The defining property of this system is a **radical asymmetry between two planes**: the video plane moves petabytes through a purpose-built CDN and must basically never touch application servers, while the control plane (browse, personalize, resume, experiment) is a high-QPS metadata business where a full outage should degrade the experience, not end it.

The other defining constraint: almost nothing here needs strong consistency. A viewing position off by ten seconds, a homepage an hour stale, a Top 10 row computed from last night's data — all fine. The design should *spend* that freedom deliberately to buy availability and latency, rather than paying for consistency nobody needs.

## 🎯 Requirements Clarification

Questions I'd ask up front:

- **Are we designing the encoding pipeline and CDN, or just the serving stack?** Both matter, but the CDN strategy shapes everything else, so I'll cover the video path at the architecture level and go deep on the serving-side systems: playback, progress, personalization, experimentation.
- **Live streaming?** No — on-demand only. Live inverts the caching assumptions entirely (nothing is cacheable ahead of time) and deserves its own design.
- **How fresh must recommendations be?** I'll assert hourly batch freshness with lightweight real-time re-ranking, and defend that below.
- **Consistency bar for resume?** "Close enough": resuming within ~30 seconds of where you stopped on another device is acceptable; losing the position entirely is not.

### Functional Requirements

- **Stream**: Start playback in under 2 seconds with adaptive quality up to 4K HDR
- **Resume**: Continue watching across devices — position survives device switches and crashes
- **Browse**: Personalized homepage (40–75 rows per profile), search, title detail
- **Profiles**: Up to 5 per account with independent history, maturity settings, and recommendations
- **Experiment**: Hundreds of concurrent A/B tests with consistent cross-device allocation

### Non-Functional Requirements

- **Playback start**: < 2s from click to first frame; rebuffer ratio < 0.5%
- **Availability**: 99.99% for the streaming path — playback must survive control-plane outages
- **Homepage**: < 100ms server time at ~100K generations/sec
- **Scale**: 200M subscribers, ~10M peak concurrent streams, ~500K API req/sec
- **Kids safety**: maturity filtering enforced server-side, unconditionally — this one is not a soft requirement

### Scale Estimates

- ~15,000 titles × ~1,200 encoded variants each (resolutions × bitrates × codecs × audio) ≈ 10 PB of stored video
- 10M concurrent streams sending a progress beacon every 30s → **~330K progress writes/sec sustained** — the single largest write load in the system
- ~160M viewing hours/day feeding the analytics and recommendation pipelines
- ~100K homepage generations/sec, each assembling 40–75 rows — the largest *read* amplification in the system
- A 4K stream at ~15 Mbps × 10M concurrent ≈ tens of Tbps aggregate — no application tier on earth serves this; it exists to justify the CDN-first architecture
- Catalog metadata is tiny — 15K titles fits in RAM on every serving node. The catalog is a *caching* problem, never a *sharding* problem

That last point is worth saying out loud: this system has one huge write stream (progress), one huge read fan-out (homepage), one huge byte stream (video), and a metadata core that is almost comically small. Each gets a different tool.

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│        Clients: Smart TV │ Mobile │ Web │ Console │ Set-top         │
│        (ABR player + DRM module + UI shell)                         │
└───────────────┬───────────────────────────────────┬─────────────────┘
        video   │ segments (bulk bytes)     API     │ (metadata, tiny)
                ▼                                   ▼
┌───────────────────────────┐        ┌──────────────────────────────┐
│   Open Connect CDN        │        │        API Gateway           │
│   ~16K appliances inside  │        │  auth, rate limits, routing, │
│   ~6K ISP networks        │        │  A/B allocation headers      │
│   (pre-filled off-peak)   │        └──────┬───────┬───────┬───────┘
└───────────▲───────────────┘               ▼       ▼       ▼
            │ nightly push          ┌─────────┐ ┌─────────┐ ┌──────────┐
┌───────────┴───────────────┐       │Playback │ │Personal-│ │ Account/ │
│  Video Pipeline (offline) │       │Service  │ │ization  │ │Experiment│
│  ingest → per-title       │       │manifest,│ │homepage,│ │profiles, │
│  encode → package/DRM →   │       │DRM lic, │ │search,  │ │allocation│
│  distribute               │       │progress │ │rows     │ │          │
└───────────────────────────┘       └──┬───┬──┘ └──┬───┬──┘ └────┬─────┘
                                       ▼   ▼       ▼   ▼         ▼
                                ┌─────────┐ ┌──────────┐ ┌────────────┐
                                │Cassandra│ │ EVCache/ │ │ PostgreSQL │
                                │progress,│ │  Redis   │ │ accounts,  │
                                │history  │ │ hot data │ │ catalog    │
                                └────┬────┘ └──────────┘ └────────────┘
                                     ▼
                            ┌────────────────┐
                            │ Kafka → batch  │
                            │ ML pipelines → │
                            │ precomputed    │
                            │ recommendations│
                            └────────────────┘
```

The load-bearing structural decision: **video bytes never touch the application tier.** The API hands the client a signed manifest; every segment thereafter comes from an Open Connect appliance sitting inside the user's own ISP. The application tier is sized for metadata QPS, which is five orders of magnitude cheaper than the byte stream.

## 💾 Data Model

Split across stores by access pattern, described as prose tables:

| Store | Data | Key Structure | Why this store |
|-------|------|---------------|----------------|
| PostgreSQL | accounts, profiles, subscriptions, billing | account_id PK; profiles FK to account, max 5 enforced | Low write rate, needs ACID (billing), relational integrity |
| PostgreSQL + cache | catalog: videos, seasons, episodes, video_files (variant registry), genres | video_id; video_files rows per (content, resolution, bitrate, codec) | Read-heavy, tiny, cached to near-100% hit rate |
| Cassandra | viewing_progress | partition = profile_id, clustered by last_watched_at DESC | 330K writes/sec; every read is "recent items for one profile" — the partition key *is* the query |
| Cassandra | watch_history | partition = profile_id, time-clustered; title/genres denormalized in | Append-only; denormalization avoids cross-store joins on display |
| Redis/EVCache | sessions, resume positions (hot), precomputed homepage rows, experiment allocation cache | per-profile keys with TTLs | Sub-ms reads on the hot path |
| Elasticsearch | search index: title, cast, description, genres | sharded by language/region | Fuzzy match, prefix autosuggest, faceting |
| Kafka + warehouse | playback QoE events, view events | keyed by profile_id | Feeds ML training and experiment metrics; never read on the request path |

Key modeling decisions:

**viewing_progress is keyed for its one query.** Every access is "give me recent progress for profile X" — Continue Watching, resume lookup, both. Partitioning by profile_id with time-descending clustering makes that a single-partition read. The cost: no ad-hoc queries ("who watched title Y yesterday?") — those go through the Kafka event stream into the warehouse, which is where analytics belongs anyway.

**video_files is a registry, not a blob store.** One row per encoded variant records resolution, bitrate, codec, and the storage key. Manifest generation is a filtered read of this registry (device codec support × subscription tier × licensing region), never a filesystem walk.

**Maturity level lives on both profile and title**, and filtering is a WHERE clause applied in every catalog query path — not a UI concern. A kids profile cannot receive an adult title in any API response no matter how the request is crafted, because the restriction is enforced at the lowest query layer, applied uniformly.

## 🔌 API Design

```
POST /api/auth/login                    → Session (httpOnly cookie, Redis-backed)
GET  /api/profiles                      → Profiles for account
POST /api/profiles/:id/select           → Bind profile to session

GET  /api/browse/homepage               → Personalized rows (precomputed + re-ranked)
GET  /api/browse/continue-watching      → In-progress content (5–95% complete)
GET  /api/browse/search?q=              → Search with personalized ranking
GET  /api/videos/:id                    → Title detail, seasons/episodes

GET  /api/stream/:id/manifest           → Quality ladder + signed segment URLs + resume position
POST /api/stream/:id/progress           → Position beacon (idempotent upsert)
POST /api/stream/:id/events             → QoE beacons: rebuffer, error, bitrate switch

GET  /api/experiments/allocations       → All active variant assignments for profile
```

Contract-level notes:

- **The manifest is the handoff point** between control plane and video plane: quality ladder, per-variant segment URL templates signed with short-TTL HMAC tokens (bound to profile + content + expiry), and the resume position — one response, then the API steps out of the way.
- **Progress is a beacon, not an RPC**: the client fires and forgets every 30 seconds. The server must tolerate loss, duplication, and out-of-order arrival — the design burden is on the write path, not the client.
- **QoE events are the product's sensory system**: rebuffer and error beacons feed both operations (alerting on rebuffer ratio) and the ABR/encoding feedback loop.
- **Profile binding lives in the session, not the URL**: every downstream query inherits the selected profile server-side, which is what makes maturity filtering unforgeable — there is no profile parameter for a crafted request to lie about.

## 🔧 Deep Dive 1: The Video Path — Per-Title Encoding and an ISP-Embedded CDN

**The pipeline**: studios deliver mezzanine masters (4K HDR, 100+ Mbps). The encoding system analyzes each title shot-by-shot for complexity, then produces ~1,200 variants across resolutions (240p–4K), codecs (H.264 for reach, HEVC, VP9, AV1 for efficiency), and audio tracks. Packaging splits each variant into 2–4 second independently decodable segments, applies per-segment DRM encryption (Widevine/FairPlay/PlayReady by platform), and generates DASH/HLS manifests. Distribution pushes content to Open Connect appliances during off-peak hours based on predicted regional popularity.

**Why per-title encoding rather than a fixed bitrate ladder:**

> "A fixed ladder encodes every title at the same bitrates — 720p is always 2,350 kbps whether it's a flat-color cartoon or a rain-soaked action scene. That wastes bits on simple content and starves complex content. Per-title analysis picks the ladder per title: the cartoon looks perfect at 1,500 kbps and the action film gets 3,000. Across a catalog served billions of times, that's roughly 20% bandwidth saved *at identical perceived quality* — and at 15% of internet traffic, 20% is a number visible on national infrastructure charts. The cost is encoding compute: multiple analysis passes make the pipeline 5–10x slower per title. But the asymmetry is total — encode once, serve a million times — so trading offline compute for delivery efficiency is nearly free money. What it really costs is orchestration complexity: thousands of parallel per-shot encoding jobs with dependency tracking, which is why the pipeline is its own substantial system rather than a script around an encoder."

**Why build a CDN instead of buying one:**

> "Commercial CDNs price per GB delivered and optimize for many tenants with unpredictable content. Netflix's workload is the opposite: a small catalog, extreme popularity skew, and *predictable demand* — tonight's top titles are knowable this morning. That predictability means appliances can be pre-filled during off-peak hours rather than cache-filling on demand. Embedding those appliances inside ISP networks means video bytes never cross paid transit or peering links — an estimated ~90% delivery cost reduction at this scale, and better QoE because fewer network hops means less jitter. What breaks with a third-party CDN isn't function, it's economics: at 15% of internet traffic, per-GB pricing is an existential line item. What we give up is enormous: a global hardware fleet across ~6,000 ISP partners, appliance failure handling, fill scheduling, and ISP relationship management. Below Netflix's scale this trade is wrong — the honest answer is that Open Connect is justified only by extreme scale, and a smaller service should buy its CDN."

**Failure behavior on the video path**: if a local appliance dies mid-stream, the client's next segment request fails over to a peer appliance in the same ISP, then a regional tier, then origin. Because segments are independent and the player holds a 30–60 second buffer, a failover costs one slow segment, not a visible interruption. And because the manifest is already in the client's hands, **a total control-plane outage does not stop in-progress playback** — that is the availability story the two-plane split buys.

**The playback-start sequence, against its 2-second budget:**

```
Client                Playback Service          Cassandra/Redis      OCA (CDN)
  │  play(title) ──────────▶ │                        │                 │
  │                          │── resume position ────▶│ (Redis, <1ms)   │
  │                          │── variant registry ───▶│ (cached, <1ms)  │
  │                          │── steering: pick OCA   │                 │
  │ ◀── manifest + DRM ──────│   for user's ISP       │                 │
  │      license + signed    │                        │                 │
  │      segment URLs        │                        │                 │
  │  first segments ────────────────────────────────────────────────▶  │
  │ ◀───────────────────────────────────────────────── segments ──────  │
  │  (decode + render first frame)                                      │
```

Budget allocation for the 2-second promise:

- Manifest generation: < 100ms — every lookup it makes is cache-resident precisely for this reason
- DRM license issuance: runs in parallel with the first segment fetches, off the critical path
- The remaining budget belongs to the network — first segments plus initial buffer fill — which is the CDN's problem, and the reason the CDN sits inside the user's ISP

The backend's whole job on this path is to get out of the way fast.

Two backend details in that flow worth flagging:

- **OCA steering happens at manifest time**: the service maps the client's IP to its ISP and returns URLs pointing at the best appliance *for that user*. Steering is a control-plane decision made once per playback, not per segment — another reason segment traffic never needs the API tier.
- **Segment URLs are HMAC-signed** with the profile, content, and a short expiry baked in. A shared link dies within the hour, and the appliance validates signatures locally with no callback to origin — authorization at the edge without an authorization service in the loop.

## 🔧 Deep Dive 2: Viewing Progress — 330K Writes/Sec That Must Never Block Playback

Every active stream beacons its position every 30 seconds. At 10M concurrent that's ~330K writes/sec sustained, with evening peaks well above. This write stream powers resume-across-devices and the Continue Watching row.

**Why Cassandra and not PostgreSQL:**

> "Postgres *can* absorb heavy writes with batching and partitioning, but this workload fights its architecture: every progress update is logically an overwrite of one (profile, content) row, which in Postgres means index maintenance, MVCC bloat from constant updates to hot rows, and vacuum pressure that grows with exactly the traffic you're trying to serve. You end up hand-sharding Postgres and re-implementing what Cassandra gives natively: LSM-tree writes that are sequential appends (overwrites are cheap by design), partition-key data placement, linear scale-out by adding nodes, and multi-datacenter replication out of the box. The price is real: no joins, no ad-hoc queries, eventual consistency. For a dataset whose only online query is 'recent progress for profile X' and whose correctness bar is 'within 30 seconds,' none of those prices matter. I keep Postgres for the data that *does* need its guarantees — accounts and billing."

**Write-path mechanics:**

1. Beacon arrives → validate session → upsert into Cassandra keyed (profile_id, content_id), clustered by time
2. Server-side batching: a short in-memory buffer coalesces multiple beacons for the same (profile, content) pair and writes only the latest — since only the final position matters, this roughly halves write volume for free
3. Completion detection: crossing 95% flags the title completed, appends to watch_history, and emits a view event to Kafka
4. Hot cache: the latest position is also written to Redis per profile, so manifest generation reads the resume position in sub-milliseconds instead of touching Cassandra on the playback-start critical path

**Idempotency and ordering**: beacons carry the client's playback position and timestamp, and the upsert is last-writer-wins per (profile, content). A duplicated beacon rewrites the same value — harmless. An out-of-order pair (position 300 arriving after 330) could regress the position by one beacon interval; resolving last-write-wins by *client timestamp* rather than arrival time fixes even that. The design deliberately makes the write so semantically forgiving that retries need no coordination at all.

**Continue Watching assembly** (the read side):

1. Query the profile's Cassandra partition time-descending, over-fetching ~2x the display limit
2. Filter to items between 5% and 95% progress (started, not finished)
3. Batch-enrich with catalog metadata from the fully-cached Postgres catalog in one query — never N+1
4. Cache the assembled row in Redis for 5 minutes, invalidated by that profile's own progress writes

The cross-store join cost stays contained because one side of the join — the catalog — is effectively free.

**Why the 5%/95% window matters**: below 5%, the user sampled and bounced — resurfacing it as "continue" is noise that erodes trust in the row. Above 95%, credits are rolling and the right affordance is "next episode," not "resume." These thresholds are product logic enforced in the backend query, because every client platform must agree on them — a TV and a phone disagreeing about what's "in progress" reads as data loss to the user.

## 🔧 Deep Dive 3: Personalization — Precompute the Expensive Thing, Re-Rank the Cheap Thing

A homepage is 40–75 rows assembled per profile: Continue Watching, "Because You Watched X," affinity-ordered genre rows, regional Top 10, new releases — at ~100K homepage generations/sec.

**The decision: precompute row candidates offline; personalize order and freshness at request time.**

1. Batch ML pipelines (hourly) score candidate titles per profile — collaborative filtering on implicit signals (completion rates, watch duration), content similarity, and sequence models predicting the next watch
2. Results land in cache as per-profile row candidate lists
3. At request time, a light re-ranker adjusts: inject just-watched context, drop just-completed titles, apply device and time-of-day context, splice in the always-fresh Continue Watching row
4. Response assembled from cache in well under 100ms

**Why not compute recommendations at request time:**

> "Full inference per request means running model scoring over a profile's history against a 15K-title candidate set — 100ms to 1s of compute — at 100K requests/sec. That's a model-serving fleet dimensioned for peak *browse* traffic, doing work whose inputs have barely changed since the last request for the same profile. The recommendation signal moves on the timescale of watches (hours), not page loads (seconds), so recomputing per load buys almost nothing. Precomputation inverts the cost structure: the heavy compute runs hourly against stable inputs on a batch fleet you can size and schedule freely, and the request path becomes a cache read plus microseconds of re-ranking. What we give up is freshness at the edges — a title you just finished might linger in a recommendation row for up to an hour — and that's exactly what the request-time re-ranker patches, cheaply, for the handful of signals where staleness is user-visible: just watched, just completed. The residual staleness that remains is invisible."

**Degradation ladder** — personalization has the deepest dependency chain in the system, so its failure story is explicit:

| Condition | Homepage served |
|-----------|-----------------|
| Everything healthy | Precomputed rows + real-time re-rank |
| Re-ranker down | Precomputed rows as-is (hour-stale ordering) |
| Per-profile cache miss + pipeline late | Previous batch's rows |
| Personalization fully down | Generic regional rows: Trending, Top 10, New Releases |

Every rung is a complete, playable homepage. A user should never be able to tell from a blank screen that an ML pipeline had a bad day — degraded means *less personal*, never *less functional*.

## 🔧 Deep Dive 4: Experimentation — Allocation Without an Allocation Store

Hundreds of experiments run concurrently, and allocation must be consistent: the same profile sees the same variant on TV, phone, and web, forever, across server restarts.

**Deterministic hash allocation**: variant = hash of (profile_id + experiment_id) mapped onto variant weight ranges, computed at request time.

- **Consistent by construction** — same inputs, same output, on any server, with no lookup anywhere
- **Nothing on the hot path** — no store to replicate or fail over; the "allocation database" is a pure function
- **Orthogonal layering** — salting the hash per experiment makes assignments statistically independent across experiments, so a profile's variant in experiment 1 doesn't correlate with its variant in experiment 2, and hundreds of tests coexist without stratification bias
- **Exposure logging** — assignments are logged to the metrics pipeline at exposure time, not to serve allocation but to record the analysis denominator: who actually saw the variant

> "The alternative — storing an assignment row per (profile, experiment) — means a read on every request that touches a feature flag, a cross-region consistency problem, and a backfill every time an experiment launches to 200M profiles. The hash gives all of that up for one constraint: you can't reassign an individual user. If a variant is broken, you kill or re-salt the *experiment*, not the user. I've never seen a legitimate need to move one specific user between variants that wasn't better served by stopping the test — so the constraint costs approximately nothing, and the operational simplicity it buys is enormous."

Feature rollouts ride the same rail: 1% → 5% → 25% → 100% is just an allocation-percentage change on an experiment layer, with automatic rollback wired to error-rate metrics. Sequential statistical testing on the metrics pipeline allows early stopping without p-hacking.

**Targeting and eligibility** layer on top of the hash cleanly:

1. Load active experiments (a small, heavily cached set)
2. Filter by targeting rules against the request context — country, device class, plan, tenure
3. Run the hash for surviving experiments only
4. Cache the assembled allocation map per profile for an hour — safe, because the hash can't change; the cache only saves the rule evaluation

One subtlety worth naming: **allocation and exposure are different events.** A profile can be *allocated* to a homepage-row experiment but never *exposed* because they only used search that day. Analyzing on allocation dilutes the measured effect toward zero; analyzing on logged exposure is what makes hundreds of small-lift experiments readable at all.

## 🛡️ Consistency, Idempotency, and Failure Handling

**The consistency budget, spent deliberately:**

| Data | Bar | Mechanism |
|------|-----|-----------|
| Billing, subscription state | Strong, ACID | PostgreSQL transactions |
| Kids/maturity filtering | Strong, always | Query-level enforcement; no cached bypass path exists |
| Progress/resume | ~30s convergence | Cassandra last-write-wins upserts + Redis hot copy |
| Homepage content | Up to 1h stale | Hourly batch + request-time patching |
| Experiment allocation | Deterministic (stronger than consistent) | Pure hash function |

**Idempotency**, mutation by mutation:

- Progress beacons: last-writer-wins upserts — retry-safe by construction, no keys needed
- My List add/remove: conflict-ignoring upsert and delete — retries converge
- Experiment allocation: pure function — idempotency is vacuous
- Session login: retried logins create parallel sessions that expire naturally; multiple sessions per account are a feature (multi-device), not a bug
- Billing: the one place needing classic idempotency keys, living in the Postgres/payments world where that discipline is standard

**Failure handling:**

- **Circuit breakers** on every cross-service call, tuned per dependency: recommendation calls trip fast (a rich fallback exists), CDN-adjacent calls trip slow (the fallback is worse than patience)
- **Fallback-first design**: every breaker has a defined degraded response — cached rows, generic rows, last-known resume position. For an entertainment product, availability beats freshness in every single trade.
- **Rate limiting** fails *open* for browse (briefly losing rate limiting beats blocking paying viewers) and fails *closed* for auth (credential stuffing doesn't get a free window when Redis hiccups)
- **Region failure**: stateless services plus Cassandra multi-DC replication allow traffic steering to surviving regions; in-flight playback continues regardless, courtesy of the plane split
- **Chaos discipline**: instance and region kills run continuously in production. A system with this many fallback paths has a specific rot mode — untested fallbacks — and chaos engineering is what keeps the degradation ladder real rather than aspirational.

**Data lifecycle and retention** — often skipped in interviews, but at 330K writes/sec it's a capacity problem, not just a compliance one:

- Completed viewing-progress rows expire after 90 days (TTL-based in Cassandra — expiry is free, no delete jobs against the hot store)
- Watch history retains ~2 years online, then archives to cold storage; the ML pipelines that want deep history read the archive, not the serving store
- GDPR/CCPA deletion is a first-class flow: profile deletion cascades through Postgres relationally, tombstones the Cassandra partitions, and emits a purge event so downstream warehouse copies are scrubbed on their own schedule
- Without TTLs, the progress table grows ~30 billion rows/year — retention policy *is* the sharding policy's silent partner

## 🔐 Security and Content Protection

Content protection is a revenue requirement — studios license content conditional on it — so it's worth its own minute:

- **Multi-DRM licensing**: Widevine (Android/Chrome), FairPlay (Apple), PlayReady (Windows) — one DRM doesn't cover the device matrix, so packaging encrypts once per scheme and a license service issues short-TTL, device-bound decryption keys at playback start, renewed during playback. Short TTLs mean a leaked license is worthless within hours.
- **Device attestation**: the license service verifies the client is a genuine application on registered hardware before issuing keys; account device counts are tier-limited.
- **Concurrent stream limits**: 1/2/4 simultaneous streams by plan, enforced with a distributed counter that is *deliberately eventually consistent* — a brief overage during a network partition is tolerated, because hard-blocking a legitimate viewer on a stale counter is the worse failure. Availability over enforcement, by explicit choice.
- **Forensic watermarking**: invisible per-session marks in the stream let leaked content be traced to the exact account and device — deterrence for the leak paths DRM can't stop (camera-off-screen, decrypted-frame capture).
- **API auth**: session cookies (httpOnly, Redis-backed, 7-day TTL) with device metadata for audit; RBAC separates viewer, account owner, content admin, and experiment admin; kids profiles are a *server-side* capability boundary as covered in the data model.
- **Auth rate limiting**: strict per-IP and per-account limits on login (credential stuffing is the top attack on any subscription service), loose limits elsewhere.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| Rebuffer ratio (per region/device/title) | *The* QoE metric; SLO < 0.5%, page on breach |
| Playback start time p50/p99 | The 2-second promise, measured from client beacons |
| Progress write latency + Cassandra compaction backlog | Leading indicator of the biggest write path degrading |
| Homepage cache hit ratio + generation p99 | The 100K/sec read path's health in two numbers |
| Per-title error spikes | A bad encode ships to millions fast; title-dimension alerting catches it in minutes |
| Circuit breaker states per dependency | The live map of what is degraded right now |
| Experiment exposure counts vs expected split | Allocation skew silently invalidates weeks of results |

Client QoE beacons are the ground truth — server-side metrics can look perfect while one ISP's appliance serves garbage, and only the client knows.

Three alerting rules I'd insist on from day one:

- **Rebuffer ratio > 0.5% in any (region × device) cell** pages — sliced, not global, because a broken appliance in one ISP disappears inside a global average
- **Playback start p99 > 3s** pages — the conversion-critical moment; users abandon at the spinner
- **Homepage fallback-tier counter rising** warns — serving generic rows *works*, which is exactly why nobody notices without a metric that says the ladder has been descended

## 📈 Scalability: What Breaks First

1. **First: homepage generation.** Naive per-request personalization dies earliest — the most expensive computation multiplied by the highest request rate. This is why precompute-plus-cache is a foundational decision rather than an optimization; once made, the browse path scales like a cache tier — near-linearly, by adding nodes.

2. **Second: progress writes.** 330K/sec sustained overwhelms any single-writer relational setup. Cassandra scales by adding ring nodes, and profile_id partitioning spreads load uniformly — there are no hot partitions, because no profile writes faster than one beacon per 30 seconds per stream.

3. **Third: CDN long-tail misses.** Pre-filling covers the popular head; the catalog tail falls back through regional tiers to origin. If tail traffic grows (deeper catalogs, niche regions), the fix is smarter fill prediction and larger regional tiers — an ML-and-hardware problem, not an architecture change.

4. **Fourth: search.** ~50K queries/sec with personalized ranking. Elasticsearch shards by language/region, and personalization runs as a separate re-rank layer over text results, so the search cluster and the ranking fleet scale independently.

5. **What never breaks: catalog metadata.** 15K titles is a rounding error. It gets cached everywhere and sharded nowhere — and recognizing what *doesn't* need scaling machinery is as load-bearing as scaling what does.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| CDN | ✅ Open Connect, ISP-embedded, pre-filled | ❌ Commercial CDN | ~90% delivery cost cut + fewer hops; justified only at extreme scale |
| Encoding | ✅ Per-title ladder, shot-aware | ❌ Fixed bitrate ladder | ~20% bandwidth at equal quality; encode-once, serve-millions asymmetry |
| Progress store | ✅ Cassandra, profile-partitioned | ❌ PostgreSQL | LSM writes fit overwrite-heavy beacons; the one query is the partition key |
| Recommendations | ✅ Hourly precompute + request-time re-rank | ❌ Real-time inference | Cache-read latency at browse QPS; staleness patched only where visible |
| A/B allocation | ✅ Deterministic hash, no store | ❌ Stored assignments | Cross-device consistency with zero hot-path reads; can't move one user (fine) |
| Degradation | ✅ Fallback rows at every rung | ❌ Fail closed | Entertainment product: less personal always beats less functional |
| Rate limiting | ✅ Fail open (browse) / fail closed (auth) | ❌ Uniform policy | Availability for viewers; no free window for credential stuffing |
| Sessions | ✅ Redis + httpOnly cookies | ❌ JWT | Instant revocation and profile-switch rebinding, server-side control |

## 🚀 Closing: What I'd Build Next

The theme running through this design: identify the one hard property each subsystem actually needs — cheap bytes for video, forgiving writes for progress, cached reads for personalization, determinism for experiments — and refuse to pay for any property beyond it. The 99.99% number falls out of that discipline, not out of any single component's reliability.

With more time I'd go deeper on four fronts:

- **The encoding orchestration system** itself — per-shot parallel encoding across thousands of workers with dependency tracking is a distributed scheduling problem worthy of its own interview
- **Concurrent stream-limit enforcement** — a globally distributed counter that deliberately tolerates brief overages, because falsely blocking a paying family's second stream costs more than a password-sharer's extra stream ever will
- **Artwork personalization** — A/B-tested poster selection per user segment, which turns even the images into an experimentation surface with its own metrics loop
- **Predictive prefetch** — using the sequence models to warm the next episode's first segments onto the client during the credits, converting recommendation confidence directly into a zero-latency play button

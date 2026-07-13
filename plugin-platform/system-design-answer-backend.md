# Plugin Platform (Marketplace + Distribution) - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a plugin platform: a marketplace where developers publish versioned plugin bundles and users discover, install, and run them inside a host application. The host itself is deliberately minimal — everything users see is a plugin — so the backend's job is really three jobs: a **registry** (who published what, at which version), a **distribution network** (getting immutable JavaScript bundles to millions of browsers fast), and a **marketplace** (search, browse, reviews, install tracking).

The defining constraints:

- Plugin bundles are **executable third-party code**, so integrity and provenance matter more than in a typical file-hosting system
- Versions must be **immutable once published** — a developer must never be able to silently swap code under a version users already vetted
- The platform must work for **anonymous users** — requiring an account before trying the product kills adoption
- Distribution must survive backend outages — a marketplace being down should never stop already-installed plugins from loading

## 🎯 Requirements Clarification

Questions I would ask the interviewer up front:

- **Trusted or untrusted publishers?** I'll assume semi-trusted: registered developers, automated scanning at publish time, and a suspension mechanism — but no full manual review of every version. That shapes the publish pipeline.
- **Where do plugins execute?** In the user's browser, in-process with the host. The backend doesn't run plugin code — it distributes it. Server-side plugin execution would be a different (much harder) sandboxing problem, and I'd scope it out.
- **Update semantics?** Users pin to an installed version; the platform can offer updates but never force-swaps code. This makes bundles immutable and cache-friendly.
- **Monetization?** Out of scope — free plugins only. Paid plugins would add entitlement checks to the download path and change the CDN strategy (signed URLs instead of public-read).

### Functional Requirements

- **Discover**: Browse and search plugins by name, category, tags; view details, versions, reviews
- **Install/Uninstall**: For both authenticated users and anonymous sessions, with migration on registration
- **Publish**: Developers upload a bundle + manifest; the platform validates, scans, stores, versions, and indexes it
- **Manage**: Enable/disable installed plugins, per-plugin settings stored server-side, version pinning
- **Review**: One rating/review per user per plugin, aggregated into marketplace rankings

### Non-Functional Requirements

- **Bundle delivery**: p99 < 200ms bundle download globally (CDN-cached, immutable)
- **Marketplace availability**: 99.9% for browse/search; distribution should survive even a full API outage
- **Integrity**: A served bundle must byte-for-byte match what was published — checksums verified end to end
- **Publish latency**: A clean publish visible in the marketplace within minutes, including security scan
- **Scale**: 10K+ plugins, 1M+ DAU, 100M+ total installs, 100M API calls/day

### Scale Estimates

- 1M DAU with an average of 8 installed plugins each → ~8M bundle fetches/day worst case; immutable caching pushes >99% of these to CDN edge, so origin sees a trickle
- Marketplace browse/search: ~10M queries/day (~120/sec average, 10x at peak when a plugin goes viral)
- Publishes: perhaps 500/day across 10K plugins — the write path is tiny; the read path is everything
- Bundles average 50–500 KB; 10K plugins × ~10 versions × 500 KB ≈ 50 GB total storage — storage is trivial, **egress is the real cost**

The shape of this system: a **read-heavy, cache-friendly workload with a low-volume but high-stakes write path**. That asymmetry drives every decision below.

## 🏗️ High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│              Clients (Plugin Host in browser, CLI)                │
└──────────────┬──────────────────────────────┬─────────────────────┘
               │ REST (marketplace, auth)     │ GET bundle.js
               ▼                              ▼
┌──────────────────────────┐    ┌──────────────────────────────────┐
│       API Gateway        │    │           CDN (edge)             │
│ (TLS, rate limits, WAF)  │    │  immutable, 1-year cache-control │
└──────────┬───────────────┘    └──────────────┬───────────────────┘
           ▼                                   │ origin pull (miss)
┌──────────────────────────┐                   ▼
│    Marketplace API       │    ┌──────────────────────────────────┐
│ (stateless, xN)          │    │     Object Storage (S3/MinIO)    │
│ browse / install /       │    │  bundles/{id}/{version}/...      │
│ publish / reviews        │    │  public-read, versioned paths    │
└───┬──────┬──────┬────────┘    └──────────────▲───────────────────┘
    │      │      │                            │ upload on publish
    ▼      ▼      ▼                            │
┌──────┐ ┌─────┐ ┌────────────┐    ┌───────────┴──────────────────┐
│ PG   │ │Redis│ │Elasticsearch│   │   Publish Pipeline (async)   │
│users │ │cache│ │ search index│   │ validate → scan → store →    │
│plugins│ │sess │ └────────────┘   │ index → invalidate caches    │
│reviews│ └─────┘                  └──────────────────────────────┘
└──────┘
```

The structural insight: **the metadata plane and the distribution plane are separate systems with separate failure modes.**

- The **metadata plane** (Marketplace API + PostgreSQL + Redis) answers "what exists, what have I installed, what's popular"
- The **distribution plane** (object storage + CDN) serves the actual executable bytes, and bundles never transit the API servers

If the entire API tier goes down, users with cached bundle URLs keep loading plugins — discovery breaks, execution doesn't. That separation is the single most important line in this diagram.

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username, email, password_hash, is_developer | unique on username, email | is_developer gates the publish API; bcrypt hashing |
| plugins | id (slug PK, e.g. 'font-selector'), author_id, name, description, category, status, install_count | status, category, author_id | Status: draft → published → suspended; install_count denormalized |
| plugin_versions | plugin_id (FK), version (semver), bundle_url, manifest (JSONB), checksum (SHA-256), file_size, scan_status, changelog | unique (plugin_id, version) | **Immutable rows** — never updated after publish (scan_status is the one exception) |
| plugin_tags | plugin_id, tag | tag | Feeds search faceting |
| user_plugins | user_id + plugin_id (composite PK), version_installed, is_enabled, settings (JSONB) | user_id | One install per user per plugin by construction |
| anonymous_installs | session_id + plugin_id (composite PK), version_installed, is_enabled, settings | session_id | Mirror of user_plugins keyed by session; migrated on registration |
| plugin_reviews | plugin_id, user_id, rating (1–5 CHECK), title, content | plugin_id; unique (plugin_id, user_id) | One review per user, enforced by constraint not application code |

Three schema choices worth defending:

**Slug primary key for plugins.** `font-selector`, not a UUID. Readable URLs, natural manifest references, matches npm conventions. The cost is that the ID is claimed forever at first publish and needs validation: charset and length rules, a reserved-name blocklist, and typosquat checks against popular names. `font-se1ector` must be rejected at registration — in a plugin registry, a typosquat is a malware delivery vehicle, not a cosmetic issue. npm learned this the hard way.

**Manifest as JSONB alongside the version row.** The manifest (slot contributions, required state keys, min platform version) is extracted from the bundle at publish time and stored in the database. This means the marketplace can answer "which plugins contribute to the toolbar slot?" or "which installed plugins break on platform v2?" with an indexed JSONB query, without ever downloading and parsing a bundle. The bundle stays the artifact; the manifest becomes queryable metadata. The duplication risk (manifest in DB diverging from manifest in bundle) is eliminated by extracting it server-side from the uploaded bundle rather than trusting a separately-uploaded copy.

**Separate anonymous_installs table rather than nullable user_id.** A single table with nullable user_id makes every authenticated query carry null-checks, complicates the composite primary key, and — the real issue — makes TTL cleanup of abandoned anonymous data dangerous: a bad DELETE predicate could hit real users' rows. Two structurally identical tables keep the cleanup job *physically incapable* of touching authenticated data.

## 🔌 API Design

```
POST   /api/v1/auth/register            → Create account (migrates anonymous installs)
POST   /api/v1/auth/login               → Session cookie (Redis-backed)
POST   /api/v1/auth/logout              → Destroy session
GET    /api/v1/plugins?q=&category=     → Browse/search (cached, anonymous OK)
GET    /api/v1/plugins/:id              → Detail: versions, reviews, rating summary
GET    /api/v1/plugins/categories       → Category list
GET    /api/v1/user/plugins             → Installed plugins (user or session)
POST   /api/v1/user/plugins/install     → Install {pluginId, version} — idempotent upsert
DELETE /api/v1/user/plugins/:id         → Uninstall — no-op if not installed
POST   /api/v1/user/plugins/:id/reviews → Create/update review (unique per user)
POST   /api/v1/developer/register       → Upgrade account to developer role
POST   /api/v1/developer/plugins        → Create plugin (claims the slug)
POST   /api/v1/developer/plugins/:id/versions → Publish version (multipart bundle upload)
```

Three contract-level decisions:

- **Optional auth on install/browse**: the same endpoint serves authenticated users (keyed by user_id) and anonymous visitors (keyed by session_id). The handler picks the storage table; the contract is identical. This is what makes the anonymous-first experience possible without a parallel API surface.
- **Bundle downloads are not API endpoints.** The install response returns an immutable CDN URL plus the expected checksum, and the browser fetches the bytes directly from the edge. The API tier never proxies bundle bytes — that would put the egress problem back on the servers.
- **The publish endpoint is multipart and synchronous only through validation.** The developer gets a fast accept/reject on manifest and size problems, then polls (or receives a webhook) for scan completion. Holding the HTTP connection open through a security scan would tie publish UX to scanner queue depth — coupling I don't want.

## 🔧 Deep Dive 1: Immutable Versioned Distribution

This is the decision the whole system leans on, so I'll spend the most time here.

**The design**: every published version gets a content path `bundles/{plugin-id}/{version}/bundle.js`, uploaded exactly once, served with a one-year immutable cache-control header, and recorded with a SHA-256 checksum in plugin_versions. Publishing the same (plugin_id, version) twice is rejected by the unique constraint. There is no "overwrite" operation anywhere in the system — fixing a bug means publishing 1.0.1.

**Why immutability, defended with the failures it prevents:**

> "The alternative — mutable 'latest' bundles at a stable URL — breaks in two ways, one operational and one adversarial. Operationally: with a one-year CDN cache on a mutable URL, every update means either cache purges across all edge locations (slow, unreliable, and if the purge API has an outage users run stale code indefinitely with no way to tell) or short TTLs (which forfeits the >99% edge hit rate and puts 8M daily bundle fetches back on origin). Adversarially it's worse: a compromised developer account could swap malicious code under a version users already vetted and installed — the exact supply-chain attack that has hit browser-extension ecosystems repeatedly, because the attacker inherits every existing install instantly. Immutable versioned paths eliminate both problems at once: the URL *is* the version, caching needs no invalidation ever, and the checksum recorded at publish time lets the client verify that what the CDN delivered is what the developer published. What I give up is convenience — developers can't hotfix in place, and users on 1.0.0 stay on 1.0.0 until an explicit update. I'd add an update-notification channel rather than weaken immutability, because immutability is the property everything else's safety depends on."

**The integrity chain, end to end:**

1. Developer uploads the bundle through the publish API
2. The API computes SHA-256 server-side (never trusting a client-supplied hash) and stores it in the version row
3. The install response includes the checksum alongside the CDN URL
4. The plugin host verifies the downloaded bytes before executing — Subresource Integrity does this natively for script tags

The consequence: the CDN and object store are **untrusted components for integrity purposes**. A compromised edge node can deny service but cannot inject code that executes. That is a meaningfully stronger security posture than "we trust our CDN," and it costs one hash comparison per load.

**What immutability buys operationally**, itemized:

- Zero cache-invalidation machinery for bundles — the hardest problem in CDN operations simply doesn't exist here
- Trivially correct rollback: pointing an install back at 1.0.0 is a metadata update, because 1.0.0's bytes still exist at their original URL
- Reproducible debugging: a bug report against 1.2.3 references exactly one artifact, forever
- Staged rollouts for free later: two versions coexist at stable URLs, so traffic-splitting is pure metadata

## 🔧 Deep Dive 2: The Publish Pipeline as a Supply-Chain Gate

Publishing is ~500 requests/day — a rounding error in traffic — but it is the single door through which all executable code enters the platform. So the pipeline is designed for scrutiny, not throughput.

**The pipeline** — synchronous validation, asynchronous heavy work:

1. Authenticate and verify the caller owns the plugin slug
2. Validate the manifest: required fields, semver format, declared slots against the platform's known slot list, min platform version
3. Enforce a size cap and content-type check before the bundle touches storage — a 200 MB "plugin" is rejected at the door
4. Compute the checksum, upload to object storage under the versioned path
5. Insert the plugin_versions row with scan_status = pending — the unique constraint makes a double-publish a clean 409, so a retried upload can't create two version records
6. Enqueue async work: static-analysis security scan, search-index update, cache invalidation

The version only becomes visible in the marketplace when the scan passes. Users never see a version the scanner hasn't cleared. If the scanner flags it, the version stays quarantined and the developer is notified.

> "I'd rather delay every legitimate publish by two minutes than serve one malicious bundle. Publishes are ~500/day; the scan queue is trivially sized. The asymmetry between the cost of the delay and the cost of the incident makes this the least controversial queue in the system."

**Why quarantine-then-publish rather than publish-then-scan:**

> "Publish-then-scan feels harmless — the scan usually finishes in seconds, so the exposure window is tiny, right? But walk through the worst case: an attacker publishes at peak hours, the scan queue is backed up ten minutes, and in that window the bundle is live, installable, and — because bundles are immutably cached — *already replicated to CDN edges*. Now remediation isn't 'delete a row,' it's 'suspend the plugin, notify every client that fetched it, and explain the incident.' The quarantine ordering means the race between scanner and attacker can't exist: visibility is downstream of the scan verdict by construction, not by timing. What I give up is publish latency and the need for a scan_status state machine — the one mutable field on an otherwise immutable row. That's a bargain."

**What the static scanner actually checks** (no scanner is perfect; the goal is raising attacker cost):

- Obfuscation heuristics — eval-heavy or packed code gets flagged for manual review, since legitimate editor plugins have no reason to hide
- Network-call inventory compared against manifest declarations — a word-count plugin opening WebSockets to an unknown host is an automatic quarantine
- Known-malicious patterns and dependency hashes from prior incidents
- Bundle-size and entropy anomalies versus the plugin's own history — a 40 KB plugin suddenly publishing a 4 MB version is suspicious by default

## 🔧 Deep Dive 3: Anonymous-First Installs and the Migration Problem

Requiring registration before trying the editor is a conversion killer, so anonymous visitors get a real experience: a server session (Redis-backed cookie, 24h TTL), installs tracked in anonymous_installs by session ID, settings included. The plugin host works identically whether or not you have an account.

**The interesting backend problem is the merge at registration.** A visitor installs five plugins anonymously, then creates an account — or, the harder case, *logs into an existing account* that already has three of those five installed with different settings.

```
Anonymous session S                      Account A (existing)
┌─────────────────────────┐              ┌─────────────────────────┐
│ anonymous_installs      │              │ user_plugins            │
│  font-selector  v1.2    │   migrate    │  font-selector  v1.0 ◀── kept (conflict)
│  word-count     v2.0    │ ───────────▶ │  word-count     v2.0 ◀── kept (conflict)
│  paper-bg       v1.1    │  on login    │  theme          v3.1     │
│  spell-check    v0.9    │              │  paper-bg       v1.1 ◀── inserted (new)
│  focus-mode     v1.0    │              │  spell-check    v0.9 ◀── inserted (new)
└──────────┬──────────────┘              │  focus-mode     v1.0 ◀── inserted (new)
           │ rows deleted after merge    └─────────────────────────┘
           ▼
        (empty)                          install_count += 3, not 5
```

My migration procedure, run inside the login/register transaction:

1. Read all anonymous_installs rows for the current session ID
2. Insert each into user_plugins with **conflict-do-nothing** semantics — the account's existing installs and their settings win over the anonymous ones
3. Delete the anonymous rows for that session
4. Adjust install_count only for plugins that were actually newly inserted — not for the conflicts. Otherwise a user who installs anonymously and already had the plugin double-counts, and the marketplace's most-loved metric slowly inflates

**Why account-wins rather than last-write-wins:**

> "Last-write-wins — anonymous state overwrites account state — sounds user-friendly: 'keep what I just did.' But walk through the failure: you log in on a shared or public machine, and the previous stranger's session leftovers silently overwrite *your* plugin settings. You'd have no idea why your editor looks wrong, and there's no undo. Account-wins is the safe default: the account state is the older, deliberate configuration, and the anonymous copy of a *conflicting* plugin is simply discarded. The genuinely new installs — the common case, since most anonymous users are new users — migrate cleanly. I give up a rare 'I reconfigured this plugin right before logging in' edge case to eliminate a silent-data-loss failure mode. When in doubt, lose the five-minute-old data, not the five-month-old data."

**Idempotency across this whole surface** — every mutation a flaky network might retry converges:

- Install is an upsert: re-installing updates version_installed, returns success, and increments the counter only when a row was actually created
- Uninstall of a non-installed plugin is a no-op 204, not an error
- Migration is safe to re-run: conflicts no-op, and the source rows are deleted, so a crashed-then-retried login can't double-migrate
- Version publish retries hit the unique constraint and get the original result

**Bounding the anonymous data**: sessions expire from Redis after 24 hours, and a nightly job deletes anonymous_installs rows whose session no longer exists. Because anonymous data lives in its own table, this job cannot touch authenticated users even if its predicate is buggy — that physical separation is exactly why the two-table design earns its place.

## 🔧 Deep Dive 4: The Read Path — Caching and Search

Browse and search are >95% of API traffic, and the results are highly shareable across users — everyone sees the same marketplace. This is the classic cache-aside setup, but the interesting decisions are in what I *refuse* to invalidate.

**Cache tiers in Redis:**

| Key | TTL | Invalidation |
|-----|-----|--------------|
| plugins:list:{query-hash} | 5 min | Deleted on any publish/suspend (pattern delete) |
| plugins:detail:{id} | 10 min | Deleted on that plugin's publish/update/suspend |
| plugins:categories | 30 min | TTL only — changes approximately never |
| user:{id}:plugins | none / write-through | Invalidated synchronously on install/uninstall |

**The install_count problem** is where I deliberately relax consistency. Every install increments a counter that appears in browse results. If installs invalidated the list caches, a popular plugin's install rate would effectively disable caching platform-wide — each install purging every cached list page, exactly when the plugin is trending and traffic is at its peak. The cache would be weakest at the moment it's needed most. Instead:

- The database counter updates atomically in the install transaction — a single increment UPDATE, no read-modify-write, so concurrent installs can't lose updates
- Cached list and detail pages are allowed to show a count up to one TTL stale

> "An install count of 10,432 versus 10,437 changes nobody's decision. Trading five minutes of counter staleness for a >95% hit rate on the hottest endpoint is the easiest trade in this system. The place I *don't* relax is the user's own installed-plugins list: after you click install, the very next fetch must show it, or the product feels broken. So per-user state is invalidated synchronously on write, while global state rides out its TTL. The rule generalizes: shared data tolerates staleness because no individual owns the expectation; 'my stuff' does not."

**Review aggregates** follow the same philosophy: average rating and review count are stored as summary columns on the plugins row, updated transactionally when a review is written, rather than computed with an aggregate join on every detail read. One write-side update replaces millions of read-side aggregations.

**Search**: PostgreSQL full-text search honestly carries 10K plugins, and I'd start there — I want to be clear that Elasticsearch is not a scale requirement at this size. The reason it enters the picture is **relevance shaping**: boosting name matches over description matches, tag faceting, typo tolerance, and blending text relevance with install_count and rating into one ranking. Those are awkward to express and painful to tune in Postgres FTS. The costs are real: a second indexed copy of the data, another system to operate, and an eventual-consistency window where a freshly published plugin appears in direct lookup seconds before it appears in search. For a marketplace, indexing lag measured in seconds on brand-new listings is invisible. I'd take that over dual-purpose-tuning one Postgres instance for both transactions and relevance.

## 🔒 Consistency and Idempotency

Worth stating as a coherent model rather than scattered remarks, because the consistency requirements here are unusually *tiered*:

| Data | Consistency bar | Mechanism |
|------|-----------------|-----------|
| Version identity (plugin_id, version → bytes) | Absolute — never changes | Immutable rows + unique constraint + checksum |
| My installed plugins | Read-your-writes | Synchronous write + per-user cache invalidation |
| Install counts, ratings in browse | Minutes-stale acceptable | Atomic increments + TTL caches |
| Search index | Seconds-stale acceptable | Async indexing after publish |

**Idempotency guarantees, mutation by mutation:**

- **Install** is an upsert keyed on (user_id, plugin_id): a retried request updates the same row, returns the same success, and the install counter increments only when a row was actually created — the "row created?" signal comes from the database, not from application bookkeeping
- **Uninstall** of a non-installed plugin returns 204, not 404 — the client's goal state is "not installed," and it has been achieved
- **Publish** retries hit the unique (plugin_id, version) constraint and receive the original outcome; a network timeout after upload can never yield two version rows or two stored bundles, because the storage path is deterministic from the key
- **Review submission** is an upsert against the unique (plugin_id, user_id) constraint — resubmitting edits your review rather than duplicating it
- **Anonymous migration** is safe to re-run: conflict-do-nothing inserts no-op, and source-row deletion makes the second run a no-op over an empty set

> "The pattern across all five: idempotency comes from database constraints and deterministic keys, not from remembering request IDs. Where a natural key exists — and in a registry, almost everything has one — leaning on it is simpler and more robust than an idempotency-key cache, because the constraint can't expire, get flushed, or disagree with the data it protects. I'd reserve explicit idempotency keys for operations without a natural key, and this system barely has any."

## 🛡️ Security and Failure Handling

**Threat model first**: the scariest failure isn't downtime — it's serving a malicious bundle to a million browsers. Defenses in layers:

- **Registration-time**: slug validation and typosquat rejection, developer accounts as an explicit upgraded role
- **Publish-time**: automated static analysis — obfuscation heuristics, known-bad patterns, an inventory of network calls compared against what the manifest declares. Quarantine until cleared.
- **Serve-time**: checksum/SRI verification in the client, making CDN compromise a denial-of-service at worst
- **Post-publish**: a suspension switch on the plugins row. Suspending removes the plugin from browse/search/install immediately — suspension is the one write where cache invalidation is synchronous and aggressive — and flags it to installed clients at next host startup
- **Developer account security**: publishing is the highest-privilege operation in the system, so it gets the strictest rate limits and, at production scale, mandatory 2FA. Most registry supply-chain incidents start with a phished maintainer account, not a platform breach — protecting developer accounts *is* protecting users.

**Failure modes, ordered by blast radius:**

| Failure | Behavior | Why it's acceptable |
|---------|----------|---------------------|
| Redis down | Sessions and cache lost; degrade to DB reads, slower browse | Correctness preserved; anonymous installs pause briefly |
| Elasticsearch down | Circuit breaker trips; search falls back to Postgres name-match | Worse relevance, still functional; no timeout tax per query |
| Object storage down | New publishes fail cleanly; existing installs unaffected | Bundles live at CDN edge with year-long TTLs — origin dependency is nearly zero |
| PostgreSQL down | API writes fail; cached browse survives minutes | Running plugin hosts keep working entirely — degrades to "no changes," not "nothing works" |

That last column is the payoff of the split-plane architecture: the system's most valuable behavior — plugins loading and running — has the *shortest* dependency chain.

**Rate limiting**, tiered by cost: publish endpoints strictest (expensive pipeline plus abuse vector), auth endpoints aggressive (credential stuffing), browse generous but capped (scraping deterrence), and bundle downloads not rate-limited at the API at all — they're the CDN's job, and the CDN is built for it.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| CDN hit ratio on bundles | The load-bearing number; a drop means origin is about to melt |
| Publish pipeline duration + scan-flag rate | Developer-experience SLO; a spike in flags means an attack wave or a scanner regression — both need humans |
| Browse cache hit ratio + p99 latency | The user-facing hot path |
| Install success/failure counter per plugin | A plugin whose installs suddenly fail usually has a bad bundle URL or a botched publish |
| Checksum-mismatch reports from clients | Should be exactly zero; any nonzero value is a page-someone-now integrity incident |
| Anonymous session count + migration rate | Conversion-funnel health and Redis memory pressure in one pair of numbers |
| Scan queue depth | The only queue in the system; depth growth silently delays every publish |

Structured logs carry plugin_id, version, and user/session ID on every event, so one publish or one install traces cleanly across API, pipeline, and storage. Two alerting rules I'd insist on from day one:

- **Any client checksum mismatch** pages immediately — it is either an integrity incident or a serving bug, and both are severity-one
- **CDN hit ratio below threshold** warns before origin load does, because by the time origin latency alerts fire, users are already feeling it

## 📈 Scalability: What Breaks First

1. **First: bundle egress from origin.** Without a CDN, 8M daily bundle fetches at ~300 KB average is ~2.4 TB/day flowing through the API tier — that saturates NICs and egress budgets long before any database sweats. This breaks first and fastest, which is why immutable-URLs-plus-CDN is a day-one architectural decision, not a later optimization. With it, origin sees only first-fetch-per-edge misses, and the number that matters becomes the CDN hit ratio.

2. **Second: marketplace browse at peak.** A 10x traffic spike — a popular plugin gets press — hits list queries that join versions and review aggregates. Redis absorbs most of it; the residual fixes are read replicas for browse/search and the precomputed rating-summary columns already described, so the read path never aggregates on demand.

3. **Third: the search index write path** — but only if publishes grow 100x. At 500/day it never matters. I flag it mostly to show where the ceiling *isn't*.

4. **The genuinely large table: user_plugins.** 100M+ total installs means user_plugins is the one table with real row volume. But its access pattern is perfectly partitionable — every query is keyed by user_id (or session_id), never cross-user. So the eventual fix is boring and clean: hash-partition by user_id, no cross-shard queries, no distributed transactions, because no operation in the API ever joins two users' install rows.

5. **What deliberately doesn't scale horizontally: the plugin metadata tables.** At 10K plugins × ~10 versions this is ~100K rows. A single Postgres primary with a replica carries this to a *million* plugins. Sharding here would be complexity theater. The honest statement about this system is that its scale problem is bytes and cache hit rates, not row counts — and knowing which problem you don't have is as important as solving the one you do.

**The scaling sequence, in the order I'd actually execute it:**

1. CDN in front of bundles (day one — this is architecture, not scaling)
2. Redis caching on browse/detail (day one)
3. Read replicas for browse/search queries when primary CPU shows read pressure
4. Elasticsearch when relevance tuning demands it (quality-driven, not load-driven)
5. Partition user_plugins by user_id — the only sharding this system will ever need

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Bundle URLs | ✅ Immutable per version + CDN | ❌ Mutable 'latest' URL | No purge machinery; blocks silent code-swap attacks |
| Integrity | ✅ Checksum at publish, SRI at load | ❌ Trust the CDN | Edge compromise can DoS but never inject code |
| Anonymous installs | ✅ Separate table, account-wins merge | ❌ Nullable user_id, last-write-wins | Cleanup can't touch real users; no silent settings loss |
| Install counts | ✅ Atomic increment, stale-tolerant caches | ❌ Invalidate lists per install | Preserves cache hit rate exactly when a plugin trends |
| Review scores | ✅ Summary columns updated on write | ❌ Aggregate join on read | One write replaces millions of read-side aggregations |
| Search | ✅ Elasticsearch, async indexed | ❌ Postgres FTS only | Relevance tuning + faceting; seconds of lag invisible |
| Publish safety | ✅ Quarantine until scan passes | ❌ Publish then scan | Never serve an unscanned bundle; delay cost is trivial |
| Plugin identity | ✅ Human slug + typosquat checks | ❌ UUID | Readable ecosystem; squat risk handled at registration |

## 🚀 Closing: What I'd Build Next

With more time I'd discuss four extensions:

- **Plugin dependency resolution** — plugin A requires plugin B ≥ 2.0 — a DAG solver with all the version-conflict pain npm knows well, which also changes the install API from single-plugin to transaction-of-plugins
- **Signed publishes**, where developers hold signing keys so even a full platform-database compromise can't forge a version — moving the root of trust from the platform to the author
- **Staged rollouts**: publish a version to 1% of installs, watch client-reported error telemetry, then promote — turning the immutability constraint into a deployment feature, since both versions already coexist at stable URLs
- **Runtime reliability analytics** reported by the plugin host, closing the loop so the marketplace can rank plugins by measured crash rate rather than star ratings alone — because in a platform whose product is other people's code, the ranking function *is* the quality bar

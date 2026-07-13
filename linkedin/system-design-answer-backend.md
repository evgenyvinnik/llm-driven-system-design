# LinkedIn - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for LinkedIn: professional profiles, a mutual-consent connection graph, a ranked feed, People You May Know, and job matching. The defining characteristic of this system is that its hardest queries are **graph queries** — "who are my 2nd-degree connections," "how many mutual connections do we share," "who should I connect with next" — executed against a graph of 900M nodes and 100B edges, at interactive latency, on infrastructure that is mostly a relational database plus caches.

I want to spend the interview on the three problems that dominate the design: connection-degree computation, PYMK, and feed ranking — because each one forces a different answer to the same underlying question: *compute at write time, compute at read time, or precompute in batch?*

Clarifying questions I'd ask before committing to an architecture: Is a connection request a one-sided follow or mutual-consent (mutual — this shapes the whole graph as undirected)? Does the feed need to reflect a brand-new post within seconds, or is "within a minute or two" acceptable (the latter — this is what licenses aggressive caching)? Is PYMK a core growth lever worth dedicated infrastructure, or a nice-to-have (core — LinkedIn's growth is famously network-effect-driven, so PYMK quality is a business metric, not a cosmetic feature)?

## 🎯 Requirements Clarification

### Functional Requirements

- **Profiles**: professional history — experience, education, normalized skills with endorsements
- **Connections**: request → accept/decline lifecycle; mutual consent; view 1st/2nd/3rd degree
- **Feed**: posts from connections, ranked by relevance and engagement, with likes and comments
- **PYMK**: multi-signal recommendations drawn from the 2nd-degree network
- **Jobs**: listings, applications, candidate-job match scoring
- **Search**: people and jobs with fuzzy matching and relevance ranking

### Non-Functional Requirements

- **Latency**: feed < 200ms p99; PYMK < 500ms p99
- **Availability**: 99.9% — a professional network tolerates brief degradation better than data loss
- **Consistency**: strong for connection state (an accepted connection must be immediately symmetric); eventual for feed, PYMK, and search
- **Abuse resistance**: connection-request spam is an existential product threat; rate limiting is a feature, not plumbing

These three requirements sit in tension: strong consistency for connections means the accept path cannot be casually async, low PYMK latency means the recommendation engine cannot be naively real-time, and 99.9% availability means every one of these subsystems needs an explicit degraded mode rather than an implicit crash. The rest of this answer is largely about resolving that tension per subsystem.

### Scale Estimates

| Quantity | Estimate | Implication |
|----------|----------|-------------|
| Users | 900M total, 100M DAU | Graph has ~900M nodes |
| Connections | 100B edges, ~500 avg/active user | ~200 GB as adjacency lists — fits in memory across a modest cluster |
| Feed reads | 1.5B/day → ~17,400 QPS | The dominant read path; must be cache-friendly |
| PYMK views | 200M/day → ~2,300 QPS | Expensive to compute → must be precomputed or cached |
| New posts | 5M/day → ~58/sec | Write volume is trivial; read amplification is the problem |
| Search | 50M/day → ~580 QPS | Dedicated search infrastructure, not the OLTP database |

The asymmetry to notice: post *writes* are 58/sec while feed *reads* are 17,400/sec — a 300:1 read amplification. That ratio drives the feed architecture decision later.

A second asymmetry worth flagging up front: PYMK computation is roughly two orders of magnitude more expensive per request than a feed read (graph expansion versus an indexed query), yet its QPS is nearly an order of magnitude lower. Those two facts together are what make PYMK a batch problem and feed a cache problem, rather than both landing on the same solution.

## 🏗️ High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                      Clients (web / mobile)                       │
└───────────────────────────────┬───────────────────────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │  API Gateway / LB   │
                     │  auth · rate limits │
                     └──────────┬──────────┘
        ┌───────────────┬───────┴───────┬────────────────┐
        │               │               │                │
┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼────────┐ ┌─────▼───────┐
│   Profile    │ │  Connection  │ │    Feed      │ │    Job      │
│   Service    │ │  Service     │ │   Service    │ │   Service   │
│ CRUD, skills │ │ requests,    │ │ posts, rank, │ │ listings,   │
│ experience   │ │ degrees, PYMK│ │ likes, cmts  │ │ match, apply│
└───────┬──────┘ └──────┬───────┘ └─────┬────────┘ └─────┬───────┘
        │               │               │                │
        └───────┬───────┴───────┬───────┴───────┬────────┘
                │               │               │
     ┌──────────▼───┐  ┌────────▼───────┐  ┌────▼─────────────┐
     │  PostgreSQL  │  │  Valkey/Redis  │  │  Elasticsearch   │
     │ users, graph,│  │ sessions, conn │  │ people + job     │
     │ posts, jobs  │  │ cache, PYMK,   │  │ indices          │
     │              │  │ feed, limits   │  │                  │
     └──────────────┘  └────────────────┘  └──────────────────┘
                │
     ┌──────────▼──────────┐        ┌──────────────────────┐
     │ Message queue       │───────▶│ Workers: PYMK batch, │
     │ (RabbitMQ → Kafka   │        │ search indexing,     │
     │  at scale)          │        │ notifications        │
     └─────────────────────┘        └──────────────────────┘
```

At full production scale, the connection store graduates from PostgreSQL to a dedicated in-memory graph service (LinkedIn built LIquid for exactly this), and the queue graduates to Kafka for event streaming. The service decomposition stays the same; the storage under the Connection Service is the piece that gets replaced — which is why it sits behind its own service boundary from day one.

## 💾 Data Model

Described as prose tables — the shapes matter more than DDL.

| Table | Key columns | Notable design points |
|-------|-------------|----------------------|
| users | id, email (unique), name, headline, location, industry, connection_count, role | connection_count is denormalized — it renders on every profile, card, and PYMK suggestion; counting rows in a 100B-edge table per view is a non-starter |
| connections | (user_id, connected_to) composite PK, connected_at | Canonical ordering: smaller ID always first, enforced by a check constraint — each edge stored exactly once |
| connection_requests | from_user, to_user, message, status; unique per pair | Status machine: pending → accepted / declined / withdrawn |
| skills + user_skills | skill catalog; junction with endorsement_count | Normalized so "JavaScript" and "JS" cannot fragment PYMK and job matching |
| experiences / education | user_id FK, company_id FK, dates, is_current | company_id links the employment graph that PYMK and job matching traverse |
| posts | id, user_id, content, like_count, comment_count, created_at | Counts denormalized; indexed (user_id, created_at desc) for feed pulls |
| post_likes | (user_id, post_id) composite PK | PK makes likes naturally idempotent; count derived from rows, not incremented |
| jobs + job_skills | company_id, title, level, years_required; skills flagged required/optional | Required-vs-optional flag feeds the match score |
| job_applications | (job_id, user_id) unique, match_score 0–100 | Score stored at apply time for recruiter-side sorting |

**The canonical-edge decision deserves a beat.** Storing each connection once as (smaller_id, larger_id) instead of two directed rows halves the table — at 100B edges that is 100B rows saved — and eliminates a whole failure class: with paired rows, every accept must write both directions atomically, and a partial failure leaves the graph asymmetric ("I see you as a connection; you don't see me"), which users experience as data corruption. The price is that every lookup queries both columns ("where user_id = me or connected_to = me"), needing an index on each. That is a trivial planner cost against a structural consistency guarantee.

## 🔌 API Design

```
POST   /api/connections/request        → Send invitation (idempotent per pair)
POST   /api/connections/:id/accept     → Accept; creates canonical edge
DELETE /api/connections/:id            → Remove connection
GET    /api/connections                → 1st-degree list
GET    /api/connections/degree/:userId → 1st / 2nd / 3rd / none
GET    /api/connections/mutual/:userId → Mutual connections
GET    /api/connections/pymk           → Ranked PYMK suggestions

GET    /api/feed?cursor=               → Ranked feed page
POST   /api/feed/posts                 → Create post
POST   /api/feed/posts/:id/like        → Like (idempotent)
POST   /api/feed/posts/:id/comments    → Comment

GET    /api/jobs?filters…              → Search/filter listings
POST   /api/jobs/:id/apply             → Apply; computes match_score
GET    /api/jobs/:id/applicants        → Recruiter view, sorted by score

GET    /api/users/search?q=            → People search (Elasticsearch)
GET    /api/jobs/search?q=             → Job search (Elasticsearch)
```

Every write endpoint above is either naturally idempotent (composite-PK inserts, unique constraints) or carries a client-supplied idempotency key the server dedupes on — a design choice that pays off directly in the frontend's ability to retry aggressively without a negotiation protocol.

## 🧩 Service Boundaries: Why Split Now, Even at Modest Scale

Four services — Profile, Connection, Feed, Job — sharing PostgreSQL, Valkey, and Elasticsearch. This is more decomposition than raw request volume strictly demands today, and I want to justify it rather than assume it.

The boundary that matters is Connection Service, and it exists for a reason unrelated to load: **it is the piece of the system whose storage will not survive to production scale unchanged.** Profile and Job are comfortable in PostgreSQL indefinitely — their access patterns are point lookups and small filtered scans. Connections is the one workload that graduates to a specialized graph store at the 100B-edge tier. Drawing the service boundary there now means that migration is an internal storage swap behind a stable API, not a rewrite of every caller that touches connection data.

Feed gets its own service because its read path (17K QPS) and write path (58/sec) have wildly different scaling needs — the read side wants aggressive caching and eventually read replicas; the write side barely needs anything. Coupling it to Profile's CRUD-shaped scaling would mean over-provisioning one to serve the other.

> "I would resist the temptation to draw more boundaries than this. A Skills microservice or an Endorsements microservice would each be defensible in isolation, but they share the users table's write path and don't have distinct scaling profiles from Profile. Splitting them buys a network hop and a deployment unit for no scaling benefit — service boundaries should track where the scaling story diverges, not where the schema happens to have a separate table."

**Inter-service communication** stays REST/JSON over the internal network rather than gRPC at this scale — the four services are called from a shared API gateway, request volumes per hop are modest, and REST's debuggability (curl a service directly, read the payload) outweighs gRPC's serialization efficiency until the East-West traffic between services itself becomes a bottleneck, which is a Feed-Service-calls-Connection-Service-per-request problem this design avoids by having Feed read connection sets from the shared Valkey cache directly rather than round-tripping through Connection Service on every feed request.

## 🔧 Deep Dive 1: Connection Degrees — the Write/Read/Batch Triangle

The query "what degree is user B to user A" runs on every profile view — roughly a billion times a day. Three strategies exist, and the numbers eliminate two of them:

| Approach | Read cost | Storage | Freshness |
|----------|-----------|---------|-----------|
| ❌ Real-time traversal | O(connections²) per view | none extra | perfect |
| ❌ Full precomputation | O(1) | ~45 trillion entries | nightly-stale |
| ✅ Hybrid: cached 1st-degree sets, intersect on demand | O(connections) | moderate | ~1 hour |

**Why real-time traversal fails.** A median user has ~500 connections, each with ~500 of their own. Answering "is B in A's 2nd degree" by expansion touches 250,000 candidate edges; 3rd degree multiplies to 125M. At a billion profile views daily, that is quintillions of edge touches — no database survives it as a per-request query.

**Why full precomputation fails.** Storing every user's 2nd-degree list costs users × average-2nd-degree-size ≈ 900M × 50K = 45 trillion entries. Even at a few bytes each, that is hundreds of terabytes of hot storage holding material where the median entry is *never read* — most users' 2nd-degree lists are consulted for a handful of specific profiles, never enumerated.

**The hybrid.** Cache each user's 1st-degree connection *set* in Valkey (a ~500-member integer set is a few KB; one-hour TTL, invalidated on connection mutations). Then:

1. **Degree(A, B) = 1st?** — one set-membership check on A's cached set
2. **Degree = 2nd?** — intersect A's set with B's set: any common member means a shared neighbor, hence 2nd degree. Set intersection on two ~500-member sets is microseconds in memory
3. **Degree = 3rd?** — check whether any of B's connections is 2nd-degree to A; bounded, and cacheable per (A, B) pair with a short TTL
4. **Mutual connections list** — the same intersection, materialized; cached separately since it is displayed, not just tested

> "The insight that makes the hybrid work is that degree queries are *pairwise*, not *enumerative*. Nobody asks for their full 2nd-degree list on a profile view — they ask about one specific person. Pairwise degree is two cached-set operations. The only consumer that genuinely enumerates the 2nd-degree network is PYMK, and PYMK runs in batch where a 250K-candidate expansion is perfectly acceptable — so I route the expensive shape of the query to the offline path and keep the online path to set intersections."

What we give up: up to an hour of staleness in cached sets (masked by explicit invalidation on the mutating user's own actions, so users always see their own changes) and a Valkey working set of tens of GB for hot users' sets — memory happily spent to keep p99 profile views under 50ms.

At the 100B-edge extreme, even this outgrows PostgreSQL, which is when a partitioned in-memory adjacency service (the LIquid approach) replaces the storage layer behind the same Connection Service API — the service boundary is the migration seam.

## 🔧 Deep Dive 2: PYMK — Batch Precompute Over a Multi-Signal Score

PYMK generates candidates from the 2nd-degree network (already-connected users are excluded by construction) and scores them:

| Signal | Weight | Why this weight |
|--------|--------|----------------|
| Mutual connections | 10 per mutual | Strongest predictor — LinkedIn's published research attributes >60% of successful connection predictions to mutuals alone |
| Same current company | 8 | Colleagues connect; strong but binary |
| Same past company | 5 | Alumni effect, decays with time |
| Same school | 5 | Educational ties |
| Shared skills | 2 each | Professional affinity; weak individually, additive |
| Same location | 2 | Proximity prior |

**Why explicit graph signals and not collaborative filtering?** PYMK predicts *real-world relationships*, not content taste. Latent-factor models excel when preferences are hidden and must be inferred; here the predictive signals are directly observable — a shared employer is not a latent factor, it is a database row. A CF model would spend its capacity rediscovering "mutual connections matter," with worse explainability: "12 mutual connections, both at Acme" is a UI string that measurably drives accept rates; an embedding similarity is not.

**Batch-first execution.** The candidate expansion is the expensive part — the same 250K-row fan-out that Deep Dive 1 banished from the read path:

1. Nightly (or triggered by connection-event bursts through the queue), a worker expands the user's 2nd-degree candidates, scores the top slice (candidate cap ~100 keeps the scoring bounded), and writes the ranked list to Valkey with a 24-hour TTL
2. The online endpoint is a cache read — that is how 2,300 QPS meets the 500ms budget with room to spare
3. Connection events (request accepted, connection removed) enqueue a recompute for both endpoints of the edge, so active networkers see fresh suggestions faster than the nightly cycle

**Why not real-time scoring?** The inputs change slowly — people change jobs yearly, not hourly — so recomputing on every view buys freshness nobody perceives, at roughly 100× the compute. The worst staleness failure is showing someone you connected with an hour ago; that is fixed by post-filtering the cached list against the live 1st-degree set at serve time. That one serve-time filter buys most of the freshness benefit of real-time computation at none of its cost.

What we give up: cold-start users with no connections have an empty 2nd-degree network, so the fallback ladder is company → school → industry cohorts — measurably weaker suggestions, but for a bounded population, briefly.

## 🔧 Deep Dive 3: Feed — Pull Beats Push at LinkedIn's Read/Write Ratio

**Ranking.** A multi-factor score, computable in the database:

- rank = engagement × 0.3 + recency × 0.5 + relationship boost
- engagement = likes + 2 × comments — a comment is a stronger intent signal than a like; discussion is what a professional network optimizes for
- recency = linear decay over ~4 days — professional content (job changes, announcements) is time-relevant, and *linear* decay keeps a high-engagement post alive for days, where exponential decay would bury it in hours

**Delivery: pull, not fanout-on-write.** The scale numbers make this call:

- **✅ Pull**: at read time, fetch the viewer's cached connection ID set (~500), query those authors' recent posts, rank, return. With the (user_id, created_at) index this is one indexed query over a bounded author set — tens of milliseconds — and 58 posts/sec of write volume touches one row per post.
- **❌ Fanout-on-write**: each post is copied to every connection's materialized timeline. Average case: 5M posts × 500 connections = 2.5B timeline writes/day — a 43,000× write amplification over pull's 58 rows/sec. Worst case: an influencer with millions of followers turns one post into millions of writes, and a burst of influencer posts creates queue backlogs where some followers see the post minutes after others — the *inconsistency* is worse than uniform pull latency.

**Why LinkedIn's usage pattern favors pull specifically.** Fanout's payoff is amortizing one write across many cheap reads — it wins when feeds are checked constantly (dozens of sessions a day, Twitter-style). LinkedIn users check 2–3 times daily; each user's materialized timeline would be read only a couple of times between rebuilds. Paying 2.5B daily writes to accelerate reads that a 50ms indexed query already serves under budget is negative-return engineering.

**Caching and invalidation.** Ranked first pages cache in Valkey for minutes. On post creation, the author's first ~50 connections' feed caches are explicitly deleted — closest connections see the post immediately; everyone else within the TTL window. The 50-cap prevents a popular author's post from triggering a mass-invalidation stampede, which would be fanout-on-write sneaking back in through the cache layer.

**The hybrid future**: if session frequency ever grows toward consumer-social patterns, move to fanout for users with <1,000 connections (bounded, cheap) and pull for high-degree hubs — the standard hybrid — behind the same feed API.

## 🔎 Job Discovery vs. Job Matching

Two distinct problems get conflated if I'm not careful: *discovery* (does this job match the searcher's query) and *matching* (does this candidate fit this specific job). They run on different infrastructure for a reason.

Discovery runs on Elasticsearch: title boosted 3×, skills 2×, plus facets (location, remote, level). Fuzzy matching matters more here than for job matching itself — real names and titles have variant spellings ("Sr." vs "Senior"), which PostgreSQL full-text handles poorly and which is a core reason Elasticsearch is in the stack at all.

Matching (covered in the next deep dive) is a scoring function computed once, at apply time, and stored — it answers a narrower question for a narrower audience (this specific candidate, this specific job) and would be wasted work if computed for every job a search returns, since only a fraction of impressions become applications.

## 🔔 Notification Delivery and Audit Trail

Two supporting systems that touch every other service:

**Notifications** are produced, not queried — connection accepted, invitation received, comment/like on my content all enqueue an event at the point of mutation (inside the same transaction where practical, so a notification is never lost to a crash between "connection created" and "notify"). A dedicated delivery path fans these out over server-sent events to connected clients and falls back to a poll-friendly unread-count endpoint for clients that are not actively connected. The backend's job here is narrow: guarantee the event is durable once the mutation commits, and let delivery be best-effort — a missed real-time push is recovered the next time the client asks for its unread count, which is why the count itself, not the stream, is the source of truth.

**Audit logging** records security-relevant events — login attempts, profile changes, connection events, admin actions — as an append-only table indexed by actor, target, and event type. This is not user-facing; it exists for abuse investigation and compliance. It is written asynchronously off the request path (a logging failure must never block a login), and its retention and query patterns (by actor over a date range, by target entity) are different enough from the OLTP tables that at real scale it would move to its own store — a wide-column or log-oriented system suits an append-heavy, range-scanned-by-time workload better than PostgreSQL's general-purpose indexing.

Both systems share a property worth naming: they are write-heavy, read-rarely paths that must never add latency to the request that triggers them. That is precisely the shape async processing exists for, and it's why neither one appears as a synchronous step in any of the three deep dives above — they hang off the side, fire-and-durable, never fire-and-block.

## 🔁 Consistency and Idempotency

- **Connection state is strongly consistent**: accept runs in one transaction — insert canonical edge, update both connection_counts, close the request. The unique pair constraint on requests plus insert-if-absent on the edge makes double-accepts harmless.
- **Likes are structurally idempotent**: composite PK on (user_id, post_id); the denormalized like_count is recomputed from rows rather than incremented, so retries cannot over-count.
- **Queue messages carry idempotency keys**: consumers check a processed-keys set in Valkey (24h TTL) before acting; failed messages reject to a dead-letter queue rather than requeueing, so a poison message cannot loop forever.
- **Search is eventually consistent by design**: profile updates enqueue an index job; a few seconds between "saved" and "searchable" is invisible in this product.

## 📬 Async Processing

Five queues carry work off the request path, each with its own dead-letter queue so a poison message degrades one feature instead of jamming the pipeline:

```
┌────────────┐     ┌──────────────────────────────────────────┐
│ API Server │────▶│                 RabbitMQ                  │
└────────────┘     │  pymk.compute · feed.fanout(future) ·     │
                    │  notifications · search.index ·           │
                    │  profile.update                            │
                    └───────────────────┬────────────────────────┘
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
             ┌────────────┐      ┌────────────┐      ┌────────────┐
             │ PYMK worker│      │Index worker│      │Notif worker│
             └────────────┘      └────────────┘      └────────────┘
```

RabbitMQ over Kafka at this stage because the workload is job-shaped, not stream-shaped: each message is processed once by one worker and discarded, there is no need for multiple independent consumer groups replaying the same log, and RabbitMQ's per-queue DLQ and prefetch-based backpressure map directly onto "retry this specific PYMK job" without building that semantics on top of a log abstraction. The trade I accept is Kafka's superior replay and multi-consumer fan-out — irrelevant today, valuable if search indexing and analytics both need to consume the same profile-update stream independently, which is the trigger for migrating.

## 🛡️ Security, Rate Limiting, Failure Handling

Rate limits are Valkey token buckets, made atomic with server-side scripting (a get-then-set pair would race at exactly the moment it matters — the last token), applied per category:

| Category | Limit | Reason |
|----------|-------|--------|
| Login/register | 10/min | Credential stuffing |
| Reads | 100/min | Scraping — profile data is the product's crown jewels |
| Writes | 30/min | Post spam |
| Connection requests | 20/min | Mass-connect spam is the product's oldest abuse vector |
| Search | 20/min | Each query costs an Elasticsearch round trip |

A single rate-limit check, walked through, shows why the Lua-scripted atomicity matters: (1) construct the key from category and user ID, (2) atomically increment the counter and read the new value in one script execution, (3) if this is the first increment, set a 60-second expiry in the same script, (4) if the returned value exceeds the category's limit, reject with 429 and rate-limit headers telling the client when to retry. Splitting steps 2–3 into separate Redis commands opens a race: two concurrent requests can both read "0 remaining" and both pass, because neither has committed its increment before the other reads. At 30 writes/min per user this race is rare but not theoretical — connection-request spam is exactly the adversarial, high-concurrency case designed to find it.

Failure posture, one line each:

- **Rate limiter fails open** — a Valkey outage briefly weakens abuse protection rather than blocking all traffic; fail-closed turns a cache blip into a full outage
- **PYMK degrades to empty** — a recommendation is an enhancement; erroring the network page over it inverts the feature's value
- **Queue down ≠ API down** — the API keeps serving reads and synchronous writes; async features (indexing, notifications, PYMK refresh) pause and drain on recovery
- **Sessions live in Redis**, keeping API nodes stateless — any node serves any request; node loss is invisible

Observability: latency histograms on feed generation and PYMK computation (the two SLO-bearing paths), queue-depth gauges (the early warning that async processing is falling behind), cache hit-ratio counters (the feed SLO silently depends on >80% connection-set hit rate), and trace IDs propagated through every request and queue message so a slow feed call can be attributed to its specific downstream.

**Authorization** is role-based rather than per-resource: users carry one of `user`, `recruiter`, `admin`. This is a deliberate simplification — with 900M users, per-user permission rows are infeasible to store or reason about, and the actual authorization surface is small (own-data CRUD, recruiter access to applicant pools for their own job postings, admin access to audit logs). A row-level policy ("can recruiter R see applicant A's data") reduces to "is R the poster of the job A applied to," which is a join, not a permissions table. RBAC covers the coarse cases; ownership checks cover the fine ones — that combination avoids building a general-purpose permission system for a product that does not need one yet.

### SLIs and SLOs

| SLI | Target | Consequence of miss |
|-----|--------|---------------------|
| Feed API latency (p99) | < 200ms | Feed cache hit ratio investigated first — this is almost always a cache problem, not a query problem |
| PYMK API latency (p99) | < 500ms | Indicates cache miss storm; check whether batch job completed |
| Connection accept → visible everywhere | < 1s | Strong-consistency requirement; any miss here is a correctness bug, paged immediately |
| API availability | 99.9% | ~43 minutes/month budget; rate-limiter fail-open and PYMK graceful degradation exist specifically to protect this |
| Cache hit ratio (connection sets) | > 80% | Below this, degree queries start hitting PostgreSQL directly and feed latency SLO is at risk |

## 🧮 Job Matching, in More Depth

Candidate-job scoring runs at apply time and is stored, not recomputed on every view — recruiters sort applicant lists by score constantly, and the inputs (candidate profile snapshot, job requirements) are stable once the application exists.

Five weighted factors sum to a 0–100 score:

1. **Required-skill overlap (~40%)** — intersection of required job skills and candidate skills, normalized by total required. This is the dominant weight because skill-job fit is the strongest observed predictor of application success and, unlike the softer signals below, it is unambiguous to compute once skills are normalized.
2. **Experience-level gap (~25%)** — full credit if years meet the requirement, tapering as the gap widens
3. **Location compatibility (~15%)** — full credit for remote roles or same-location candidates
4. **Education match (~10%)** — credit if the candidate meets the stated minimum
5. **Referral signal (~10%)** — credit if the candidate has a 1st-degree connection at the hiring company

That last factor is the one worth explaining: it is binary, not scaled, because the underlying reality is binary — either a referral path exists or it does not. A referral path materially changes response likelihood on this platform specifically, which is why it earns a fixed weight rather than being folded into a continuous score.

Job discovery itself runs on Elasticsearch, not this scoring function — search ranks *relevance to a query*, matching scores rank *fit to a specific job*, and conflating the two would mean re-deriving match scores at search time for every job in the result set, which is wasted work when only a fraction of search results become applications.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Edge storage | ✅ Canonical single row | ❌ Two directed rows | Half of 100B rows; asymmetry structurally impossible |
| Degree queries | ✅ Cached sets + intersection | ❌ Live traversal / full precompute | Pairwise queries need set ops, not expansion |
| PYMK execution | ✅ Batch + 24h cache + serve-time filter | ❌ Real-time scoring | Inputs change slowly; 100× compute for invisible freshness |
| PYMK model | ✅ Explicit graph signals | ❌ Collaborative filtering | Observable signals dominate; explainable "why" strings |
| Feed delivery | ✅ Pull + cache | ❌ Fanout-on-write | 300:1 read/write ratio; 2.5B daily writes avoided |
| Feed decay | ✅ Linear over ~4 days | ❌ Exponential | Professional content has multi-day relevance |
| Comment weight | ✅ 2× likes | ❌ Equal weight | Discussion is the engagement a professional network wants |
| Search | ✅ Elasticsearch | ❌ Postgres full-text | Fuzzy names, field boosting, facets |
| Skills | ✅ Normalized catalog | ❌ Free-text array | Matching breaks on "JS" vs "JavaScript" |
| Match scores | ✅ Computed at apply, stored | ❌ Recomputed per view | Snapshot-stable inputs; recruiters sort constantly |
| Queue | ✅ RabbitMQ → Kafka later | ❌ Kafka day one | Job semantics + DLQs now; streaming when volume demands |
| Auth | ✅ Sessions in Redis | ❌ JWT | Instant revocation matters on an account-takeover target |

## 📈 Scalability — What Breaks First

1. **The connections table breaks first.** At 100B edges, even indexed pair lookups strain a single PostgreSQL instance's buffer pool. Path: read replicas → shard by smaller user ID (co-locating each edge with at least one endpoint) → dedicated in-memory graph service behind the existing Connection Service API. The API boundary means callers never notice the migration.
2. **Feed query fan-in** second: pulling posts for 500 authors across shards becomes scatter-gather. Path: co-shard posts with their authors, add read replicas dedicated to the feed path, and only then consider hybrid fanout.
3. **PYMK batch window** third: nightly recompute for 100M active users must partition across workers by user-ID range; the queue-triggered incremental path already carries urgency, so the nightly batch can tolerate hours.
4. **Elasticsearch indexing lag** under profile-update storms: dedicated indexing consumers with backpressure; split people and job indices so one cannot starve the other.
5. **Valkey memory** for hot users' connection sets: LRU eviction is acceptable precisely because every cached set is rebuildable from PostgreSQL — cache loss is a latency event, never a correctness event.

### Sharding Strategy, When It's Needed

Each table shards on the key that keeps its dominant query pattern local to one shard:

- **Users/profiles**: hash on user_id — profile reads are always single-user, so any hash works and load spreads evenly
- **Connections**: co-located with the *smaller* user_id in the canonical pair — since every edge already has a deterministic smaller endpoint, this piggybacks on a decision already made for storage, and a user's full connection list is always a single-shard scatter-free query in the common direction
- **Posts**: shard by author's user_id — feed pulls query a bounded set of authors, so a query fans out to at most a few dozen shards for a 500-connection user rather than every shard
- **Jobs**: shard by company_id — a company's listings and applicant pools are always accessed together

The common thread: shard keys are chosen so that the *dominant* read (not every read) stays single-shard or low-fanout. Cross-shard queries (search, admin analytics) are explicitly routed to Elasticsearch or a separate analytical store rather than optimized for in the OLTP shard layout.

## 🚀 Closing

The backbone of this design is routing each graph workload to the tier that matches its access shape: pairwise degree checks to cached set intersections (online, microseconds), candidate enumeration to batch workers (offline, minutes), and feed assembly to indexed pulls over a bounded author set (online, tens of milliseconds). The relational core stays simple and consistent — canonical edges, transactional connection state, idempotent engagement — while everything expensive is either cached with an honest staleness budget or pushed off the request path entirely.

If I had another 45 minutes, the next layer I'd design is the write path for connection_count and other denormalized counters under concurrent updates — right now they update inside the same transaction as the mutation, which is correct but means a burst of simultaneous accepts on a popular user's profile briefly serializes on that row. A future iteration would move high-contention counters to an eventually-consistent increment stream, the same pattern already used for post like_count, trading a few seconds of counter staleness for removing a lock contention point entirely.

Future work beyond that: hybrid feed fanout if session frequency rises, ML-learned ranking weights replacing the hand-tuned formula once engagement data accumulates, and the graph-service migration the Connection Service boundary was designed to absorb.

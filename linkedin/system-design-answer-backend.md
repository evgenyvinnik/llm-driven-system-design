# 💼 LinkedIn (Professional Network) — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Profiles, posts and job listings are ordinary CRUD. What makes LinkedIn hard is the connection graph: about 50 billion mutual-consent edges, a 'how are you connected?' question inside every profile view, and PYMK and the feed both walking that graph. So I'll spend most of the time on two things — storing the graph so a connection can never be one-sided, and reading it so we never enumerate someone's 250,000-person second-degree network while a user waits."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the numbers that shape the graph |
| High-level architecture | 10 min | One overview, then accept, degree and PYMK flows |
| Data model & API | 7 min | Pair rows, derived adjacency, idempotent invitation API |
| Deep dive 1: storing the graph | 8 min | Pair row as truth, directed adjacency as an index |
| Deep dive 2: degree of separation | 7 min | Bidirectional search instead of precomputing |
| Deep dive 3: feed fan-out | 5 min | Pull beats push at LinkedIn's read/write ratio |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope, because 'LinkedIn' covers a dozen products."

### Functional requirements

1. **Connections**: send, accept, decline and withdraw invitations; remove a connection; list my connections.
2. **Degree and path**: every profile shows 1st, 2nd or 3rd degree, the number of mutual connections, and one "how you're connected" chain.
3. **People You May Know**: ranked suggestions with reasons ("12 mutual connections", "Both worked at DataFlow").
4. **Feed**: ranked posts from my connections, with likes and comments.
5. **Profiles, search and jobs**: profile CRUD, people and job search, job applications.

Out of scope: messaging, company page administration, ads and the recruiter product.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Degree computation | p99 < 50 ms | It runs inside every profile view |
| Feed first page | p99 < 250 ms | The landing page |
| Invite / accept | p99 < 300 ms; both members see it within 1 s | A connection must never look one-sided |
| PYMK serving | p99 < 100 ms; new connections reflected in minutes | Growth feature; staleness is visible when it suggests existing connections |
| Search freshness | Profile edits searchable within 30 s | People edit, then search themselves |
| Availability | 99.95% reads, 99.9% writes | Reads can degrade; writes can retry |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Members | 900M, 100M daily active | Shard everything by member id |
| Edges | ~50B pairs = 100B adjacency entries | ~800 GB of ids, ~5 TB of RAM with overhead and 3 replicas |
| Average connections | ~500 for active members | Second-degree network ≈ 250K before overlap |
| Profile views | ~1B/day → 12K/s, ~35K/s peak | Degree must be two lookups in the common case |
| Feed loads | 1.5B/day → 17K/s, ~50K/s peak | ~500 authors per load → 8.5M list reads/s |
| Posts | 5M/day → 58/s | Push would be 2.5B timeline writes a day |
| Invitations | ~20M/day → 230/s; accepts ~115/s | Writes are tiny; correctness is the problem |

"Two numbers drive the design. The graph is 100 billion adjacency entries — too big for one machine, small enough for RAM across forty. And a second-degree network is about 250,000 people, which tells me any algorithm that enumerates it per request is dead on arrival."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk the three journeys that carry the design: accepting an invitation, loading the feed, and searching."

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Web and mobile clients (members, recruiters)                                                 │
  └─────────┬───────────────────────────────────┬─────────────────────────────┬──────────────────┘
            │ (1) POST /invitations/{id}/accept │ (2) GET /feed?cursor        │ (3) GET /search?q
            │                                   │                             │
            ▼                                   ▼                             ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ API gateway · TLS · session lookup in Redis · per-member rate limits · routing               │
  └─────────┬───────────────────────────────────┬─────────────────────────────┬──────────────────┘
            ▼                                   ▼                             ▼
  ┌──────────────────────┐            ┌──────────────────────┐        ┌──────────────────────────┐
  │ Graph Service        │ connections│ Feed Service         │        │ Profile & Search API     │
  │ invitations, degree, │◀───────────┤ pull recent posts    │        │ profiles · jobs ·        │
  │ mutuals, PYMK        │            │ from connections,    │        │ applications ·           │
  │ adjacency in RAM     │            │ rank, cursor pages   │        │ people and job search    │
  └───▲─────────────┬────┘            └───────────┬──────────┘        └───┬───────────────┬──────┘
      │             │                             │                       │               │
      │             │                             │ recent post ids       │ search query  │
      │             │ tx: invitation, edge,       │ per author            │               │
      │             │ counters, outbox row        │                       │               │
      │             │                             ▼                       │               ▼
      │ edge        │                   ┌────────────────────────┐        │     ┌────────────────┐
      │ events      │                   │ Redis                  │        │     │ Elasticsearch  │
      │             │                   │ sessions · recent post │        │     │ people · jobs  │
      │             │                   │ ids · PYMK lists       │        │     └─────────▲──────┘
      │             │                   └────────────────────────┘        │ profiles, jobs│
      │             ▼                                                     ▼               │
      │   ┌───────────────────────────────────────────────────────────────────┐           │ index
      │   │ PostgreSQL · sharded by member id                                 │           │ docs
      │   │ profiles, invitations, edges, posts, jobs, outbox                 │           │
      │   └─────────────────────────────┬─────────────────────────────────────┘           │
      │                                 │ outbox relay                                    │
      │                                 ▼                                                 │
      │                     ┌───────────────────────────┐ profile, job events    ┌────────┴──────┐
      └─────────────────────┤ Kafka · change events     ├───────────────────────▶│ Index workers │
                            └───────────────────────────┘                        └───────────────┘
```

1. **Accept (1).** The Graph Service locks the pair's row in PostgreSQL, flips it to connected and writes an outbox row in one transaction, then answers. The outbox relay publishes `pair.connected`; the Graph Service applies it to both members' in-memory adjacency lists.
2. **Feed (2).** The Feed Service gets my connections from the Graph Service, multi-gets each author's recent post ids from Redis, ranks, and returns a page with a cursor.
3. **Search (3).** The Profile & Search API queries Elasticsearch with a boost for my network. Profile and job changes reach the index through the same outbox, rebuilt by index workers.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, sessions, rate limits, routing | Requests | Sessions in Redis, so API instances are stateless |
| Graph Service | Invitations, degree, mutuals, PYMK serving | Graph RAM, profile views | ~40 partitions by member id, 3 replicas |
| Feed Service | Candidate gathering, ranking, cursors | Feed loads | Stateless |
| Profile & Search API | Profiles, jobs, search queries | Edits, searches | Stateless |
| PostgreSQL | Source of truth | Members | Sharded by member id; pairs on the lower id's shard |
| Redis | Sessions, recent post ids, PYMK lists, versioned caches | Hot keys | Cache loss costs latency, not correctness |
| Kafka + index workers | Change events, search documents | Write rate | Replayable; documents rebuilt from rows |
| Elasticsearch | People and job indices | Queries | Derived; rebuildable |

"Why is the graph its own service? Three reasons: its storage is unusual — a partitioned in-memory graph — its latency budget is the tightest in the system, and every other service calls it. With an API in front, I can start on PostgreSQL alone and move to an in-memory graph without touching callers."

### Flow 1: accepting an invitation

```
Member app                      Graph Service                PostgreSQL                   Kafka
     │                                │                           │                         │
     │ 1 POST /invitations/42/accept  │                           │                         │
     │───────────────────────────────▶│                           │                         │
     │                                │ 2 lock pair row           │                         │
     │                                │──────────────────────────▶│                         │
     │                                │ 3 set connected + outbox  │                         │
     │                                │──────────────────────────▶│                         │
     │                                │ 4 COMMIT (or 0 rows)      │                         │
     │                                │◀──────────────────────────│                         │
     │ 5 200 {status: connected}      │                           │                         │
     │◀───────────────────────────────│                           │                         │
     ······························· outbox relay, under 1 s ································
     │                                │                           │ 6 pair.connected {A,B}  │
     │                                │                           │────────────────────────▶│
     │                                │ 7 add edge to both lists                            │
     │                                │◀────────────────────────────────────────────────────│
     │                                │                           │                         │
```

"Step 2 is the important one. Both directions of an invitation between A and B live in one row keyed by (low id, high id), so the questions 'is there an invitation the other way?' and 'are they already connected?' are answered under one lock on one shard. Step 3 is a compare-and-set: it only applies while the state is pending, so a double click or a client retry finds 'connected', changes nothing, and returns 200 with `changed: false`. The counters and the event happen exactly once. Steps 6–7 are asynchronous: adjacency is an index built from the event, so a third person might see the old state for under a second, but A and B never disagree, because the pair row answers for them."

### Flow 2: viewing a profile — degree and path

```
Viewer app                         Router          Shard of A   Shard of B   Shards of F(B)
     │                                │                 │            │              │
     │ 1 GET /members/B/relationship  │                 │            │              │
     │───────────────────────────────▶│                 │            │              │
     │                                │ 2 adjacency(A)  │            │              │
     │                                │────────────────▶│            │              │
     │                                │ 3 adjacency(B)               │              │
     │                                │─────────────────────────────▶│              │
     │                                │ 4 intersect? -> 2nd degree   │              │
     │                                │ 5 adjacency(each id in F(B))                │
     │                                │────────────────────────────────────────────▶│
     │                                │ 6 ~170K ids                                 │
     │                                │◀────────────────────────────────────────────│
     │                                │ 7 hit in F(A)? -> 3rd + path │              │
     │ 8 {degree, status, path}       │                 │            │              │
     │◀───────────────────────────────│                 │            │              │
     │                                │                 │            │              │
```

"This is the hot read, about 35,000 times a second at peak. Two adjacency reads answer 1st and 2nd degree; only when the sets don't meet do I expand one side by one hop and look for a hit. I'll come back to why this beats precomputing in deep dive 2."

### Flow 3: People You May Know

```
Member app                   Graph Service          Redis                       PYMK jobs
     │                             │                  │                             │
     │                             │                 1 nightly: friends of friends  │
     │                             │                  │      2 score, keep top 100  │
     │                             │                  │ 3 SET pymk:{id}, TTL 24 h   │
     │                             │                  │◀────────────────────────────│
     ··························· member opens My Network ····························
     │ 4 GET /pymk?limit=20        │                  │                             │
     │────────────────────────────▶│                  │                             │
     │                             │ 5 GET pymk:{id}  │                             │
     │                             │─────────────────▶│                             │
     │                             │ 6 drop new connections, invites                │
     │ 7 20 suggestions + reasons  │                  │                             │
     │◀────────────────────────────│                  │                             │
     ·························· nearline: A and B connect ···························
     │                             │                  │ 8 recompute pymk:A, pymk:B  │
     │                             │                  │◀────────────────────────────│
     │                             │                  │                             │
```

"The expensive part — a friends-of-friends join with mutual counts — runs offline. Serving is a key-value read plus a filter against live state, so a list computed last night never suggests someone I connected with this morning. A `pair.connected` event triggers a nearline recompute for the two members, which keeps active networkers' suggestions fresh."

| Option | Verdict |
|--------|---------|
| ✅ Nightly batch + nearline recompute + serve-time filter | ~100× cheaper than scoring per view; freshness comes from the filter |
| ❌ Score on every request | A 250K-member walk per page view, to gain freshness nobody notices — jobs and schools change monthly |
| ❌ Collaborative filtering first | Spends model capacity rediscovering "mutual connections matter" and can't explain itself on the card |

"I start with explicit weights — 10 per mutual connection, 8 for the same current company, 5 for a shared past company or school, 2 per shared skill capped at five — because the reasons on the card come from the same features. Once there's acceptance data, a learned ranker replaces the weights without changing the pipeline."

---

## 💾 Data Model (4 min)

"PostgreSQL holds the truth, sharded by member id. Everything graph-shaped that is read in bulk is derived from it."

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `member_pairs` | `(low_id, high_id)` PK, `state` (pending, connected, declined, withdrawn, removed), `requested_by`, `message`, `version` | The source of truth for "connected?"; lives on the lower id's shard |
| PostgreSQL | `adjacency` | `(member_id, other_id)` PK, `connected_at` | Derived, two rows per connection, each on its owner's shard |
| PostgreSQL | `invitations_inbox` | `(recipient_id, created_at, sender_id)` | Derived, so "my invitations" is one shard |
| PostgreSQL | `members` | `id`, `email` (private), `headline`, `location`, `connection_count`, `graph_version` | Counters maintained by the edge consumer |
| PostgreSQL | `posts` | `(author_id, id)` PK with time-ordered ids | An author's recent posts are one range scan |
| PostgreSQL | `outbox` | `id`, `topic`, `key`, `payload`, `published_at` | Same transaction as the change |
| Redis | `posts:recent:{author}` | Last ~100 post ids | Capped list; one append per post |
| Redis | `pymk:{member}` | Top 100 ids + reason codes | 24 h TTL |
| Redis | `rel:{viewer}:{target}:{vA}:{vB}` | Cached relationship | Keyed by both members' graph versions |
| Elasticsearch | `people`, `jobs` | Name, headline, skills, companies, location | Rebuilt from rows by index workers |

"The graph version deserves a sentence. Every committed change to a member's connections bumps their version, and every graph cache key includes it. That is how I invalidate without the classic race where a reader that loaded the old list a millisecond before the change writes it back after the delete."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/invitations                  {to, message?} → 201 sent | 200 already_pending | 200 connected
POST   /api/v1/invitations/{id}/accept      → 200 {status, changed}  (/decline, /withdraw likewise)
DELETE /api/v1/connections/{memberId}       → 200 {removed}
GET    /api/v1/members/{id}/relationship    → {degree, status, request_id, mutual_count, path}
GET    /api/v1/connections?cursor=          → my connections, most recent first
GET    /api/v1/pymk?limit=20                → suggestions with reasons
GET    /api/v1/feed?cursor=                 → ranked page + next_cursor
POST   /api/v1/posts                        Idempotency-Key → 201
GET    /api/v1/search/people?q=&cursor=     → hits + source
```

- **Every graph write says what happened.** `sent`, `already_pending` or `connected` (a crossing invitation), plus the resulting status. Clients can retry blindly; nothing needs an idempotency key because the pair row already is one.
- **`status` is separate from `degree`.** The button depends on invitations (`pending_sent`, `pending_received`), the badge on distance. A 3rd-degree member can have invited you.
- **Cursors name a ranked snapshot**, so feed pages don't repeat or skip when scores move.
- **Errors** are `application/problem+json` with stable codes (`already_connected`, `request_not_pending`); invitation sends are rate-limited per member and return `429` with `Retry-After`.

---

## 🔧 Deep Dive 1: Storing the Graph (8 min)

"The decision: the source of truth is one row per *pair* of members, and the per-member adjacency that everything reads is an index derived from its change events."

**Why it works.** Connections are mutual and the two members must never disagree. With one row per pair there is nothing to disagree about: the row is either connected or not. It also gives me a natural lock for the invitation state machine — none, pending (with a direction), connected, declined, withdrawn, removed. The crossing-invitation case, where A and B invite each other within the same second, becomes trivial: the second sender finds a pending invitation from the other side under the lock and accepts it instead of creating a second invitation. Counters move in the same transaction as the state change, only when it actually changed.

**Why the alternatives fail.**

| Approach | Where it breaks |
|----------|-----------------|
| ✅ Pair row + derived directed adjacency | — (costs a sub-second index lag) |
| ❌ Two directed rows written together | Once sharded by member, A→B and B→A live on different shards; atomicity needs two-phase commit, and without it a crash leaves a one-sided connection |
| ❌ One canonical row, read directly | Symmetric, but "all of X's connections" is a scatter across shards for the half of edges where X is the larger id |
| ❌ Graph database as the source of truth | Fast traversals, but weak at the transactional invitation state machine, and a second source of truth for profiles |

"The canonical row is what I'd ship on a single PostgreSQL — and it's exactly what the local implementation does. It breaks only when I shard, and the fix is not to abandon it but to stop reading it in bulk: adjacency becomes a projection."

**The derived index.** An edge consumer applies `pair.connected` and `pair.removed` events to the two directed rows and to the Graph Service's in-memory lists. The writes are upserts keyed by (member, other), so a replayed event is a no-op, and the event carries the pair version, so an old event arriving late can't undo a newer one. A nightly job compares pair rows with adjacency and repairs any drift; the alert threshold for mismatches is zero.

**What I give up.** For under a second after a change, a third person can see old adjacency — B's feed might not yet include A's posts. The two members themselves never see an inconsistent state, because "are we connected?" and the profile button read the pair row (or the cache versions it bumped), and the accept response carries the new status. I'm trading global freshness for no distributed transactions, and for this product that's the right trade.

---

## 🔧 Deep Dive 2: Degree of Separation (7 min)

"The decision: compute degree per request with a bidirectional search over in-memory adjacency, and never store second-degree sets."

**Why it works.** A profile view asks a pairwise question: how far is this one person from me? Two adjacency reads — mine and theirs, about 500 ids each — answer 1st degree (they're in my list) and 2nd degree (our lists intersect; the intersection is the mutual-connection list). For 3rd degree I expand one side by one hop: fetch the adjacency of each of their ~500 connections, batched per partition, and probe each id against my set. That's about 500 lookups and 250K hash probes — single-digit milliseconds in RAM — and the first hit gives the path, A → x → y → B.

**Why the alternatives fail.**

| Approach | Cost per query | Where it breaks |
|----------|----------------|-----------------|
| ✅ Bidirectional search | 2 lookups (1st/2nd), ~500 (3rd) | Hub members; capped below |
| ❌ BFS from the viewer | 250K at depth 2, 125M at depth 3 | Far over budget at 35K views/s |
| ❌ Precomputed second-degree sets | 1 lookup | ~100K ids × 300M active members ≈ 30 trillion entries, mostly never read, invalidated by every new edge in the neighborhood |
| ❌ SQL self-joins on the edge table | Joins across shards | Works on one node; at 100B rows it's a scatter-gather on every view |

**Hubs.** A member with 30,000 connections turns the one-hop expansion into 30,000 lookups. The router always expands the smaller side and gives up after a budget of about 50K ids, answering "3rd+" without a path. Hubs are rare and their profiles are viewed by strangers who mostly are 3rd degree anyway.

**Caching.** The answer is cached for ten minutes under both members' graph versions. If either member connects or disconnects with anyone, their version bumps and the cache entry is simply never read again.

**What I give up.** Every profile view does real graph work instead of a precomputed lookup, and I need the adjacency in RAM — about 5 TB across ~40 servers. That's the price of exact answers that change the instant a connection is accepted, and the memory is shared with the feed and PYMK serving.

---

## 🔧 Deep Dive 3: Feed Fan-out (5 min)

"The decision: fan-out on read. A post costs one write; a feed load gathers candidates from the authors I'm connected to."

**Why it works.** Each post appends its id to the author's capped list in Redis. A feed load fetches my connections from the Graph Service, multi-gets ~500 recent-post lists (batched by Redis shard), merges the newest few hundred candidates, ranks them — engagement, recency, how often I interact with the author — and stores the ranked ids as a short-lived session snapshot. The cursor names that snapshot and a position in it, so scrolling never repeats or skips posts even though scores keep moving.

**Why fan-out on write fails here.**

| Approach | Writes | Where it breaks |
|----------|--------|-----------------|
| ✅ Fan-out on read | 58 posts/s → 58 appends/s | 8.5M list reads/s, but cheap, cached and parallel |
| ❌ Fan-out on write | 5M posts × 500 = 2.5B timeline writes/day | An influencer post becomes millions of writes; followers see it minutes apart |
| ❌ Hybrid push/pull | Push for small authors | Worth it when members open the feed dozens of times a day; LinkedIn members open it two or three times, so most precomputed timelines are rewritten before they're read |

**What I give up.** Read work on every load and a ranking step on the request path. I keep it within budget by capping candidates, caching the snapshot for the session, and computing author-affinity features offline. If session frequency rose toward consumer-social levels, I'd revisit the hybrid.

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first, in order:** hub members in degree queries (cap and expand the smaller side), feed candidate gathering (batch by shard, cap lists at ~100 ids), the PYMK batch window as the graph grows (partition the join by member; lean on nearline recompute), and adjacency RAM (add partitions; rebuild from snapshots plus the Kafka log, never from live traffic).

| Failure | What members see | Mitigation |
|---------|------------------|------------|
| Graph partition down | Some profiles lack the degree badge | Replicas; the badge has its own timeout and is optional |
| Kafka down | New connections reach feeds late | Outbox rows accumulate and drain; writes still succeed |
| Edge consumer lag | Third parties see old adjacency | Pair row answers for the two members; alert at 5 s |
| Redis down | Slower pages | Caches fall back to the database; graph cache reads fail open |
| Elasticsearch down | Search without typo tolerance | Breaker opens; PostgreSQL full-text fallback; outbox retries |
| Shard primary down | Writes for that shard fail with `503` | Replica promotion; reads from replicas |

**What I'd watch:** degree p99 by outcome and the cap-hit rate; invitation outcomes (a jump in `accepted_reverse` is fine, a jump in `request_not_pending` is a client retry storm); adjacency lag and reconciliation mismatches; PYMK serve-time filter drop rate (high means stale lists); search outbox age against the 30-second freshness target.

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Relationship truth | Pair row, derived adjacency | Two directed rows written together | Symmetry can't break; no 2PC |
| Degree | Bidirectional search in RAM | Precomputed second-degree sets | Two lookups instead of 30T stored ids |
| Cache freshness | Versioned keys | Delete on write | No stale refill after a change |
| PYMK | Batch + nearline + serve-time filter | Score per request | 100× cheaper, fresh where it matters |
| Feed | Fan-out on read + ranked snapshots | Fan-out on write | 2.5B daily writes avoided; stable cursors |
| Search sync | Outbox, rebuild from rows | Dual write | Edits never fail on search |
| Invitation retries | Idempotent outcomes | Client idempotency keys | The pair row is already the key |

"With more time, I'd design the abuse side of invitations — weekly caps, 'I don't know this person' feedback lowering a sender's limits — and the privacy layer: degree and paths must respect members who hide their connections."

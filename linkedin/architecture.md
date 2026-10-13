# LinkedIn (Professional Network) — Architecture

## System Overview

A professional network where members keep a career profile, connect with people they know, read a feed of their connections' posts, get "People You May Know" (PYMK) suggestions, and search for people and jobs. Posts and profiles are ordinary CRUD. What makes LinkedIn a design problem is the **connection graph**: every profile view asks "how am I connected to this person?" (1st, 2nd or 3rd degree, and through whom), PYMK is a ranked walk over friends-of-friends, the feed is assembled from each member's connections, and people search ranks by network distance. The graph has roughly 50 billion edges, and two members must never disagree about whether they are connected.

This document describes the production-scale design first. [Implementation Notes](#implementation-notes) maps it to what this repository runs: Express + PostgreSQL + Valkey, with Elasticsearch and RabbitMQ optional, and a React frontend.

**Learning goals**

- Storing an undirected, mutual-consent graph: one pair row as the source of truth versus two directed rows.
- Degree of separation with a bidirectional (meet-in-the-middle) search instead of enumerating second-degree networks.
- PYMK as candidate generation plus explainable scoring, computed offline and filtered at serve time.
- Feed fan-out on read versus fan-out on write, decided by the read/write ratio.
- Keeping a search index in step with the database through a transactional outbox, and degrading when it is down.

## Requirements

### Functional requirements

1. **Profiles**: experience, education and skills; skills can be endorsed by 1st-degree connections.
2. **Connections**: send, accept, decline and withdraw invitations; remove a connection; list connections.
3. **Degree and path**: every profile shows 1st/2nd/3rd degree, the mutual-connection count and one "how you're connected" chain.
4. **PYMK**: ranked suggestions with human-readable reasons ("12 mutual connections", "Both worked at DataFlow").
5. **Feed**: posts from connections, ranked; likes and comments.
6. **Search and jobs**: people and job search with filters; job applications with a match score.

Out of scope: messaging/InMail, company pages administration, ads, learning, and the recruiter product.

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Profile view, including degree badge | p99 < 200 ms server time; degree computation p99 < 50 ms |
| Feed first page | p99 < 250 ms |
| Invite / accept | p99 < 300 ms; both members see the new state within 1 s |
| PYMK serving | p99 < 100 ms; new connections reflected within 5 minutes, full refresh daily |
| Search | typeahead p99 < 100 ms; a profile edit is searchable within 30 s |
| Availability | 99.95% for reads (profile, feed, search), 99.9% for writes |
| Correctness | A connection is never one-sided; connection counts match the edges they count |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Members | 900M total, 300M monthly, 100M daily active | Every per-member structure is sharded by member id |
| Connections | ~50B pairs, 100B adjacency entries; active members average ~500 | The graph does not fit one machine, but it fits in RAM across a cluster |
| Adjacency in RAM | 100B × 8 B ≈ 800 GB of ids, ~1.6 TB with overhead, ×3 replicas ≈ 5 TB | ~40 servers with 128 GB each, partitioned by member id |
| Second-degree network | 500 × 500 ≈ 250K members (100K+ after overlap) per member | Never enumerate it on a request path |
| Profile views | ~1B/day → ~12K/s average, ~35K/s peak | Degree must be two adjacency lookups in the common case |
| Feed loads | 1.5B/day → ~17K/s average, ~50K/s peak | Cache-first, each load gathers recent posts from ~500 authors |
| New posts | 5M/day → ~58/s | Fan-out on write would be 5M × 500 = 2.5B timeline writes a day |
| Invitations | ~20M/day → ~230/s; accepts ~115/s | Graph writes are tiny; correctness, not throughput, is the problem |
| PYMK lists | 300M members × top 100 × ~16 B ≈ 480 GB | Precomputed nightly into a key-value store |
| Search | 50M queries/day (~580/s), typeahead ~10× that in requests | Dedicated search cluster, not the OLTP database |

### Local Development Scale

Ten seeded members, twelve connections, seven jobs and seven posts. One Express process (optionally three on ports 3001–3003 sharing sessions through Valkey), one PostgreSQL, one Valkey. Elasticsearch and RabbitMQ are optional: search falls back to PostgreSQL full-text and queue publishing is best-effort. Setup and ports are in the [README](./README.md).

## High-Level Architecture

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

1. **Accept an invitation (1).** The Graph Service locks the pair's row in PostgreSQL, flips it from pending to connected and writes an outbox row in the same transaction, then answers. The outbox relay publishes `pair.connected` to Kafka; the Graph Service applies it to both members' in-memory adjacency lists, and a consumer writes the two directed adjacency rows.
2. **Load the feed (2).** The Feed Service asks the Graph Service for the member's connections, reads the recent post ids each of those authors has in Redis, ranks the candidates and returns a page with a cursor. Nothing was written per follower when those posts were created.
3. **Search (3).** The Profile & Search API queries Elasticsearch, boosting people in the searcher's network. Profile and job changes reach Elasticsearch through the same outbox and Kafka path, rebuilt by index workers from the database rows.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, session lookup, rate limits, routing | Requests | Sessions live in Redis so any instance serves any member |
| Graph Service | Invitations, connections, degree and path, mutuals, PYMK serving | Graph size (RAM) and profile views | Adjacency lists partitioned by member id, rebuilt from the edge log |
| Feed Service | Candidate gathering, ranking, cursor pages | Feed loads | Stateless; reads activity lists and asks the Graph Service for connections |
| Profile & Search API | Profiles, jobs, applications, search queries | Profile edits and searches | Stateless |
| PostgreSQL | Source of truth: profiles, pair rows, adjacency rows, posts, jobs, outbox | Members | Sharded by member id (pairs by the lower id) with replicas |
| Redis | Sessions, recent post ids per author, PYMK lists, versioned caches | Hot keys | Losing it is a latency event, not a correctness event |
| Kafka | Change events from the outbox | Write rate | Partitioned by member id; replayable for rebuilds |
| Index workers | Rebuild search documents from PostgreSQL rows | Change rate | Idempotent; a document is always rebuilt from current state |
| Elasticsearch | People and job indices | Documents and queries | Derived; can be rebuilt from PostgreSQL |

The Graph Service is separate from profiles and the feed because it is the one workload whose storage is unusual (a partitioned in-memory graph), whose latency budget is tight (it runs inside every profile view), and which other services call. Putting it behind its own API means the storage can change — PostgreSQL alone for a small network, an in-memory graph at LinkedIn scale — without touching callers.

## Core Components / Request Flows

### Accepting an invitation

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

- **The pair row is the lock and the truth.** Both directions of an invitation for members A and B live in one row keyed by `(low_id, high_id)` on one shard, so "is there an invitation the other way?" and "are they already connected?" are answered under the same row lock. A crossing invitation (B invites A while A's invitation to B is pending) becomes an accept instead of a second invitation.
- **The state change is a compare-and-set.** The update applies only while the state is `pending`; a double click or a retried request finds `connected` and returns `200` with `changed: false`, so the counters and the event are produced exactly once.
- **Adjacency is derived.** Kafka consumers apply `pair.connected` to both members' in-memory lists and upsert the two directed adjacency rows (`A→B` on A's shard, `B→A` on B's), keyed so a replayed event is a no-op. Members can be on different shards; nothing needs a distributed transaction.
- Locally there is one PostgreSQL: the transaction takes an advisory lock on `(low, high)`, claims the request with a conditional `UPDATE`, inserts the single canonical edge row and moves both counters only if that insert happened (see [Implementation Notes](#implementation-notes)).

### Viewing a profile: degree and "how you're connected"

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

- **Bidirectional search.** Steps 2–3 fetch both first-degree sets (~500 ids each). If they intersect, the target is 2nd degree and every member of the intersection is a mutual connection. Otherwise step 5 expands *one* side by one hop — the target's side, or whichever is smaller — and checks the result against the viewer's set. That is about 500 adjacency lookups, batched per partition, instead of the 250K lookups a viewer-side expansion to depth 2 would need, or the 125M of a naive depth-3 walk.
- **Hubs are capped.** Members with tens of thousands of connections make step 5 expensive; the router always expands the smaller set and gives up after a budget (say 50K ids), answering "3rd+" without a path.
- **Caching.** The answer for (viewer, target) is cached for ten minutes under both members' graph versions; any connection change bumps the version, so a stale "2nd" can't outlive the change that made it "1st".

### PYMK: precompute, then filter at serve time

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

- **Candidate generation** (step 1) is a friends-of-friends join over the adjacency table with mutual counts, kept to the top few hundred by mutual count per member. Members with thin networks also get colleagues and classmates (same company or school), the cold-start path.
- **Scoring** (step 2) starts with explicit, explainable weights — 10 per mutual connection, 8 for the same current company, 5 for a shared past company or school, 2 per shared skill (capped at five), 2 for the same location — and is replaced by a learned ranker once acceptance data exists. The reasons shown on the card come from the same features.
- **Serve-time filter** (step 6) drops anyone who became a connection, has a pending invitation either way, or was dismissed since the list was computed, so a day-old list never suggests someone you just connected with.
- **Nearline refresh** (step 8): a `pair.connected` event recomputes the two members' lists within minutes, so a burst of new connections changes suggestions the same day.

## Database Schema

### Production schema

PostgreSQL, sharded by member id. Pair rows live on the shard of the lower id so both directions share one row.

```sql
-- Relationship state between two members: the source of truth for "connected?"
CREATE TABLE member_pairs (
  low_id       BIGINT NOT NULL,
  high_id      BIGINT NOT NULL,
  state        TEXT   NOT NULL CHECK (state IN ('pending', 'connected', 'declined', 'withdrawn', 'removed')),
  requested_by BIGINT,                      -- who sent the current invitation
  message      VARCHAR(300),
  version      BIGINT NOT NULL DEFAULT 1,   -- compare-and-set and cache versions
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (low_id, high_id),
  CHECK (low_id < high_id)
);

-- Derived: one row per direction, on the owner's shard; written by the edge consumer
CREATE TABLE adjacency (
  member_id    BIGINT NOT NULL,
  other_id     BIGINT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (member_id, other_id)
);

-- Derived inbox so "invitations I received" is a single-shard read
CREATE TABLE invitations_inbox (
  recipient_id BIGINT NOT NULL,
  sender_id    BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (recipient_id, created_at, sender_id)
);

CREATE TABLE members (
  id                BIGINT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,      -- never returned on public views
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  headline          VARCHAR(220),
  location          TEXT,
  connection_count  INTEGER NOT NULL DEFAULT 0, -- maintained by the edge consumer
  graph_version     BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE posts (
  author_id   BIGINT NOT NULL,
  id          BIGINT NOT NULL,               -- time-ordered id (Snowflake-style)
  body        TEXT NOT NULL,
  like_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (author_id, id)                -- an author's posts are one range scan
);

CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,                -- pair.connected, member.updated, job.updated
  key          BIGINT NOT NULL,              -- Kafka partition key (member id)
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

Redis keys: `sess:{id}` (sessions), `posts:recent:{authorId}` (the last ~100 post ids, capped list), `pymk:{memberId}` (top 100 with reason codes, 24 h TTL), `rel:{viewer}:{target}:{vA}:{vB}` (relationship cache keyed by both graph versions), `rl:{category}:{memberId}` (token buckets).

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql); it is loaded by `npm run db:migrate` or on a fresh Docker volume, and is safe to run twice. It maps to the production design like this:

| Production | Local | Difference |
|------------|-------|------------|
| `member_pairs` (state machine) | `connections` (one canonical row per connected pair) + `connection_requests` (one row per direction) | Two tables instead of one pair row; the pair is serialized with an advisory lock instead of a row lock |
| `adjacency` (two directed rows) | — | One canonical row; "all connections of X" reads the primary key and `idx_connections_connected_to` |
| `posts`, `members` | `posts`, `users`, `experiences`, `education`, `skills`, `user_skills`, `skill_endorsements` | Same shape, single node |
| Elasticsearch documents fed by the outbox | `search_index_queue` + generated `search_document` columns with GIN indexes | The queue is a per-entity outbox; full-text columns serve the fallback |
| PYMK store | Valkey `pymk:{id}` | Computed on a cache miss instead of nightly |

The edge table and the search outbox, verbatim from `init.sql`:

```sql
CREATE TABLE IF NOT EXISTS connections (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  connected_to INTEGER REFERENCES users(id) ON DELETE CASCADE,
  connected_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, connected_to),
  CONSTRAINT connection_order CHECK (user_id < connected_to)
);
```

```sql
CREATE TABLE IF NOT EXISTS search_index_queue (
  entity_type VARCHAR(10) NOT NULL,     -- 'user' | 'job'
  entity_id INTEGER NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,    -- bumped by every re-enqueue
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  PRIMARY KEY (entity_type, entity_id)
);
```

## API Design

### Production API

```
POST   /api/v1/invitations                     {to, message?} → 201 sent | 200 already_pending | 200 connected
POST   /api/v1/invitations/{id}/accept         → 200 {status, changed}   (also /decline, /withdraw)
DELETE /api/v1/connections/{memberId}          → 200 {removed}
GET    /api/v1/connections?cursor=             → my connections, most recent first
GET    /api/v1/members/{id}/relationship       → {degree, status, request_id, mutual_count, path}
GET    /api/v1/pymk?limit=20                   → suggestions with reasons
GET    /api/v1/feed?cursor=                    → ranked page + next_cursor
POST   /api/v1/posts                           Idempotency-Key → 201
GET    /api/v1/search/people?q=&cursor=        → hits + source
GET    /api/v1/jobs?q=&location=&remote=       → hits + source
POST   /api/v1/jobs/{id}/applications          Idempotency-Key → 201 | 409 closed
```

- **Invitation writes are idempotent by construction.** The response says what happened (`sent`, `already_pending`, `connected`) and the resulting status, so a client can retry blindly and render the server's answer.
- **`status` drives the UI.** `connected`, `pending_sent`, `pending_received` or `none` decides the profile button; `degree` and `path` decide the badge and the "how you're connected" line. Clients never infer one from the other.
- **Cursors, not offsets.** The feed cursor names a ranked snapshot and a position in it, so pages don't repeat or skip when scores change between requests.
- **Errors** are `application/problem+json` with stable codes (`already_connected`, `request_not_pending`, `user_not_found`); rate limits come back as `429` with `Retry-After`.

### Local routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register`, `/login`, `/logout`; GET `/api/auth/me` | Session auth (cookie, sessions in Valkey) |
| GET, PATCH | `/api/users/:id`, `/api/users/me` | Profile (email only on your own); allowlisted edits |
| GET | `/api/users?q=` | People search: `{users, source}` |
| POST | `/api/connections/request` | Invite: `201 sent`, `200 already_pending` or `200 accepted_reverse` |
| POST | `/api/connections/requests/:id/accept`, `/reject`, `/withdraw` | Idempotent transitions with `changed` |
| DELETE | `/api/connections/:userId` | Remove: `{removed}` |
| GET | `/api/connections/degree/:userId` | Relationship: degree, status, request id, mutual count, path |
| GET | `/api/connections`, `/requests`, `/mutual/:userId`, `/second-degree`, `/pymk` | Lists and suggestions |
| GET, POST | `/api/feed`, `/api/feed/:id/like`, `/api/feed/:id/comments` | Feed (offset pages), likes, comments |
| GET, POST | `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/apply`, `/api/jobs/companies` | Jobs, applications, companies |
| GET | `/health`, `/health/live`, `/health/ready`, `/metrics` | Operations |

## Key Design Decisions

### 1. A pair row is the source of truth; directed adjacency is derived

The alternatives fail in specific ways. **Two directed rows written together** (A→B and B→A) are natural once you shard by member, but the two rows land on different shards, so writing both atomically needs a distributed transaction; without one, a crash between the writes leaves a one-sided connection that one member sees and the other doesn't. **One canonical row** keyed by `(low, high)` makes symmetry impossible to break, but "all of X's connections" becomes a scatter across shards for the half of the edges where X is the larger id. The design keeps both: the pair row decides (one shard, one lock, a state machine for invitations), and the directed rows and in-memory lists are an index built from its change events, idempotent and replayable. What it costs is a window of under a second in which a third party can read the old adjacency, and a reconciliation job that compares pairs with adjacency nightly.

### 2. Degree by bidirectional search, not precomputed second-degree sets

Precomputing every member's second-degree set means storing ~100K+ ids for 300M active members — tens of trillions of entries, mostly never read, and invalidated by every new connection anywhere in the neighborhood. A per-request BFS from the viewer touches 250K members at depth 2. Profile views are pairwise questions ("A and B"), so the search meets in the middle: two adjacency reads answer 1st and 2nd degree, and one bounded one-sided expansion answers 3rd. The cost is a hard tail for hub members, handled by expanding the smaller side and capping the budget.

### 3. PYMK precomputed offline, filtered online

Scoring at request time means a friends-of-friends join on every page view: ~100× the cost of reading a list, to gain freshness nobody notices because jobs and schools change on a scale of months. The batch job owns the expensive join; the serving path owns freshness through the filter and nearline recomputation. Explicit features come first because they explain themselves on the card and are easy to debug; a learned model can replace the weights without changing the pipeline.

### 4. Feed: fan-out on read from per-author activity lists

Fan-out on write would turn 5M posts a day into 2.5B timeline writes for an average 500-connection author, and an influencer's post into millions of writes and a queue backlog. LinkedIn members open the feed a few times a day, so materialized timelines would be rewritten far more often than read. Pull instead: each post appends its id to the author's capped list in Redis (one write), and a feed load multi-gets ~500 such lists (batched by shard), merges the newest candidates, ranks them, and stores the ranked ids as a short-lived session snapshot that cursors page through. The cost is read work — about 8.5M list reads a second at average load — which is cheap, cacheable and parallel.

### 5. Search fed through an outbox, with a degraded mode

Writing to PostgreSQL and then calling Elasticsearch in the request is a dual write: when Elasticsearch is slow the profile edit fails after it was committed, and when the second call is lost the index is silently stale. The outbox row commits with the change; workers rebuild the document from current state, so retries and reordering converge. When the cluster is down, search answers from PostgreSQL full-text (exact and prefix matches, no typo tolerance) instead of failing.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Send invitation | At most one pending invitation per pair; crossing invitations connect | Pair row lock (local: advisory lock on `(low, high)`); upsert that re-opens declined or withdrawn invitations |
| Accept / decline / withdraw | Each transition happens once; retries return `changed: false` | Compare-and-set on `state = 'pending'` (local: conditional `UPDATE … RETURNING`) |
| Connection counters | Match the edges | Incremented only when the edge insert actually happened, in the same transaction |
| Adjacency mirrors | Symmetric within ~1 s | Idempotent upserts keyed by `(member_id, other_id)`; nightly reconciliation |
| Graph caches | Never older than the last committed change | Version per member bumped after commit; cache keys include the version |
| PYMK | Never suggests a current connection or pending invitee | Serve-time filter against live state |
| Search index | Converges to the database | Outbox row per change; documents rebuilt from current rows; delete only the claimed version |
| Likes, endorsements | Idempotent per member | Primary keys `(user_id, post_id)` and `(endorser_id, user_id, skill_id)` |
| Post creation, job application | One effect per click | `Idempotency-Key` with a stored response (production); applications are unique per `(job, member)` |

A member always reads their own write: the accept response carries the new status, and the cache versions are bumped before the response returns.

## Security / Auth

- **Sessions** in Redis behind an `HttpOnly`, `SameSite=Strict` cookie, `Secure` in production. Revocation is a key delete; any API instance can serve any member.
- **Authorization**: roles (`user`, `recruiter`, `admin`) for coarse permissions, ownership checks for everything a member edits. Profile updates accept an allowlist of fields; role, email and counters are never writable through the profile API.
- **Privacy**: email and contact details never appear on public profiles, search hits, cards or paths. Search results respect profile visibility settings at query time.
- **Abuse**: invitations are rate-limited per member (token bucket in Redis: 20/min burst 10, plus a weekly cap) because mass-inviting is the platform's oldest spam vector; "I don't know this person" responses lower the sender's limits. Reads are limited per member to slow scraping.
- **Input**: parameterized SQL everywhere, column lists built only from allowlists, ids validated before they reach a query, invitation notes capped at 300 characters.

## Observability

- **Graph**: degree latency by outcome (1st/2nd/3rd/none), expansion size, cap hits; invitation outcomes (`sent`, `already_pending`, `accepted_reverse`); adjacency mirror lag and reconciliation mismatches (should be zero).
- **Caches**: hit ratio per cache (`connections`, `pymk`), version bumps per second.
- **PYMK**: batch duration and coverage, nearline lag, serve-time filter drop rate (a high rate means the lists are stale).
- **Feed**: candidate count per load, ranking time, p99 by shard.
- **Search**: fallback rate, outbox backlog and oldest age (alert above 30 s — that's the freshness SLO), indexing failures.
- Structured logs with a trace id per request, propagated into events; RED metrics per route; liveness separate from readiness, with readiness failing during shutdown so the load balancer drains an instance first.

## Failure Handling

| Failure | What members see | Mitigation |
|---------|------------------|------------|
| Graph partition down | Degree badge and path missing on some profiles; the profile still loads | Replicas per partition; the badge is an enhancement with its own timeout |
| Kafka down | New connections reach adjacency and the feed late; writes still succeed | Outbox rows accumulate and drain on recovery |
| Edge consumer lag | A third party briefly sees the old adjacency | The pair row answers "connected?" for the two members; lag alert at 5 s |
| Redis down | Slower pages; sign-in required again if sessions are lost | Caches fall back to the database; sessions replicated; graph cache reads fail open |
| Elasticsearch down | Search still works without typo tolerance | Breaker opens for 30 s and answers from PostgreSQL full-text; the outbox retries with backoff |
| PostgreSQL shard primary down | Writes for that shard return `503` | Replica promotion; reads from replicas and caches |
| PYMK batch fails | Yesterday's suggestions, still filtered | Lists have a TTL longer than the batch period |

## Scalability Considerations

1. **Hub members break first.** A member with 30K connections makes every 3rd-degree check that touches them expensive; expand the smaller side, cap the budget, and cache answers.
2. **Feed candidate gathering** is ~500 list reads per load; batch by Redis shard, keep the lists capped at ~100 ids, and cache ranked snapshots for the session.
3. **The PYMK batch window** grows with the graph; partition the friends-of-friends join by member id and rely on nearline recomputation for members whose networks changed.
4. **Adjacency RAM** grows with edges; add partitions and rebalance from the Kafka log plus snapshots, never from live traffic.
5. **Search indexing bursts** (bulk imports) go through the same outbox; workers scale horizontally because claiming uses `FOR UPDATE SKIP LOCKED`.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Relationship truth | Pair row + derived directed adjacency | Two directed rows written together | No cross-shard transaction; symmetry can't break |
| Degree queries | Bidirectional search on in-RAM adjacency | Precomputed second-degree sets | Pairwise questions need two lookups, not trillions of stored ids |
| Graph cache freshness | Versioned keys bumped after commit | Delete on write | A racing refill can't resurrect stale data |
| PYMK | Nightly batch + nearline + serve-time filter | Score on every request | 100× cheaper; freshness comes from the filter |
| PYMK model | Explicit weights with reasons | Learned ranker from day one | Explainable cards; swap the model later |
| Feed delivery | Fan-out on read, ranked session snapshot | Fan-out on write | 2.5B writes a day avoided; stable cursors |
| Search sync | Transactional outbox + rebuild from rows | Dual write in the request | Edits never fail on search; index converges |
| Search outage | PostgreSQL full-text fallback | Return an error | Degraded results beat no results |
| Sessions | Redis | JWT | Instant revocation; stateless API instances |
| Invitation retries | Idempotent outcomes in the response | Client-side dedupe | Retries and double clicks are safe by construction |

## Implementation Notes

### What runs locally

[`backend/src/index.ts`](./backend/src/index.ts) starts one Express process serving auth, users, connections, feed and jobs under `/api`. Sessions are stored in Valkey through `connect-redis`, so `dev:server1..3` share logins. On startup the process creates the Elasticsearch indices when it can reach the cluster (queueing a full reindex for a new index), connects to RabbitMQ if available, and starts the search outbox relay. SIGTERM stops accepting connections, fails readiness, lets in-flight requests finish, then closes RabbitMQ, the pool and Valkey (forced exit after 10 s). The frontend is React 19 + TanStack Router + Zustand + Tailwind; it keeps server data in component state.

### Production patterns actually implemented

**Invitation lifecycle in one transaction** — [`connectionService.ts`](./backend/src/services/connectionService.ts). Every lifecycle operation takes `pg_advisory_xact_lock(low, high)` for the pair, which is what turns crossing invitations into an accept. Accepting is a claim:

```sql
UPDATE connection_requests SET status = 'accepted', updated_at = NOW()
WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
RETURNING *
```

The canonical edge is inserted with `ON CONFLICT DO NOTHING`, and both `connection_count`s move only if that insert created a row. A repeated accept returns `changed: false`; declined or withdrawn requests return `409 request_not_pending`. Sending again while pending returns `200 already_pending`; a declined or withdrawn invitation is re-opened by an upsert. Errors are `ApiError`s with stable codes ([`errors.ts`](./backend/src/utils/errors.ts)), so database messages never reach clients.

**Versioned graph cache** — [`graphCache.ts`](./backend/src/utils/graphCache.ts). First-degree lists are cached under `connections:{id}:v{version}`; every graph write bumps `graph:ver:{id}` after commit, so a reader that loaded the old list just before the change writes it under a version nobody reads. Redis errors fall back to PostgreSQL.

**Degree and path** — [`connectionPath.ts`](./backend/src/services/connectionPath.ts) implements the bidirectional search against the two cached lists; the 3rd-degree meeting point is one indexed probe for an edge between the two sets. `GET /api/connections/degree/:userId` returns degree, status (`connected`, `pending_sent`, `pending_received`, `none`), request id, mutual count and the path as public summaries.

**PYMK** — [`pymkService.ts`](./backend/src/services/pymkService.ts) generates second-degree candidates in one SQL statement ordered by mutual count (capped at 100, excluding connections and pending invitations), adds colleagues and classmates when fewer than ten exist, loads features for all candidates in four batched queries, scores them with [`pymkScoring.ts`](./backend/src/services/pymkScoring.ts), caches the top 50 for 24 hours, and filters the cached list against live connections and invitations on every read.

**Search outbox and fallback** — [`searchIndexer.ts`](./backend/src/services/searchIndexer.ts) and [`searchService.ts`](./backend/src/services/searchService.ts). Profile, experience, skill and job writes upsert a `search_index_queue` row in the same transaction. A relay (every 2 s, in each API process) claims due rows with `FOR UPDATE SKIP LOCKED` and a 30 s lease, rebuilds documents from PostgreSQL, indexes them and deletes the row only if its `version` is unchanged; failures back off from 2 s to 5 minutes. [`elasticsearch.ts`](./backend/src/utils/elasticsearch.ts) uses a 3 s timeout and pauses calls for 30 s after a connection failure; people and job search then answer from generated `search_document` columns with GIN indexes and report `source: "postgres"`. `npm run search:reindex` queues everything.

**Safer profile writes** — [`userService.ts`](./backend/src/services/userService.ts) builds `UPDATE` statements only from allowlisted columns (body keys used to become column names, which allowed role escalation and SQL injection), returns public projections without email, and records endorsements in `skill_endorsements` so each connection endorses a skill once.

**Operational patterns**: Prometheus metrics in [`metrics.ts`](./backend/src/utils/metrics.ts) (HTTP RED metrics, invitation and connection counters, PYMK duration by network size, cache hits and misses per cache, `search_index_backlog`, `search_fallbacks_total`, queue depth); Pino logs with a trace id ([`logger.ts`](./backend/src/utils/logger.ts)); a Lua token-bucket rate limiter in Valkey per category with `X-RateLimit-*` headers that fails open ([`rateLimiter.ts`](./backend/src/utils/rateLimiter.ts)); audit rows for logins, profile edits and connection events ([`audit.ts`](./backend/src/utils/audit.ts)); `/health` (PostgreSQL and Valkey required; Elasticsearch and RabbitMQ reported), `/health/live`, `/health/ready`.

**Tests**: 26 vitest tests with mocked shared modules cover the path search, PYMK scoring and ranking, the cache-version race, the outbox relay (success, backoff, deleted rows, breaker), the search fallback and the accept/send state machine (`npm test` in `backend/`).

**Frontend**: the profile header renders from the relationship endpoint — Connect, Pending (withdraw), Accept/Ignore or Connected (remove after confirmation) — applies the expected status optimistically, rolls back with an announced error, and shows the "how you're connected" path ([`ProfileHeader.tsx`](./frontend/src/components/profile/ProfileHeader.tsx), [`ConnectionActions.tsx`](./frontend/src/components/profile/ConnectionActions.tsx)). PYMK cards show the server's reasons and their Connect buttons send invitations; the search page aborts superseded requests.

### Simplified or substituted

| Production | Local |
|------------|-------|
| Pair row + derived directed adjacency, sharded | Canonical `connections` row + `connection_requests`, one PostgreSQL |
| In-memory partitioned graph | Cached first-degree lists in Valkey + SQL bridge probe |
| Nightly PYMK batch + nearline jobs | Computed on a cache miss, 24 h TTL; only the two members' lists are dropped on a change |
| Kafka + index workers | `search_index_queue` + relay inside the API process |
| Fan-out on read from Redis activity lists, ranked snapshots | One SQL query ranks posts from self and connections (`0.3 × engagement + 0.5 × recency + own-post boost`) with `OFFSET` pages |
| Notifications over SSE | Events published to RabbitMQ only |

### Omitted or still limited

- **RabbitMQ has no consumers.** `notifications`, `pymk.compute` and `feed.fanout` receive events (without publisher confirms) that nothing processes; they are dropped when the broker is down.
- **Feed pagination** uses `OFFSET` with a score that depends on `NOW()`, so pages can shift between requests; there is no feed cache or activity list.
- **Hub members**: the bridge probe has no budget, and PYMK lists of members two hops away are not invalidated when an edge forms (the 24 h TTL bounds it).
- **Search fallback** has no typo tolerance and doesn't match skills or companies; only Elasticsearch does.
- **Frontend** has no shared server-state cache, virtualization, infinite scroll or live updates; the feed loads its first page only.
- **Two seeders**: `db-seed/seed.sql` (ten members, used by the screenshot harness) and `npm run seed` (a different eight-member dataset).
- Elasticsearch and RabbitMQ paths were not exercised in the last review (neither was available); everything else was run against PostgreSQL 16 and Valkey/Redis 7.

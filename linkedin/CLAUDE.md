# LinkedIn (Professional Network) — Development with Claude

## Project Context

A professional networking platform whose defining feature isn't posts or messaging but the **connection graph**: connection degrees (1st/2nd/3rd), "People You May Know" recommendations, mutual connections, and job-candidate matching all derive from that graph. The hard problem is answering graph questions ("who's in my 2nd-degree network, ranked by how likely I am to know them") fast enough for an interactive UI without a dedicated graph database — done here with a canonical connections table, aggressive Redis caching, and on-read scoring.

**Learning goals:** connection-degree computation on a relational graph, multi-signal recommendation scoring (PYMK, job matching), multi-factor feed ranking, and decoupling search/notifications/fan-out via a message queue.

## Architecture at a Glance (what actually runs)

Four backing services — this matches `docker-compose.yml` and `backend/package.json`:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** (`pg`) | Source of truth | `users`, `companies`, `skills`/`user_skills`, `experiences`, `education`, `connections`, `connection_requests`, `posts`/`post_likes`/`post_comments`, `jobs`/`job_skills`/`job_applications`, `audit_logs` | Relational integrity for the profile/graph/job data and set-based degree queries |
| **Redis / Valkey 7** (`ioredis`, `connect-redis`) | Sessions + cache-aside | Sessions (`sess:*`, shared by all instances), versioned first-degree lists (`connections:{id}:v{n}`, 1h TTL), PYMK lists (24h TTL), rate-limit buckets | Graph reads are expensive to recompute; version keys stop racing refills from resurrecting stale lists |
| **Elasticsearch 8.11** (`@elastic/elasticsearch`) | Search (optional) | `users` and `jobs` indices with fuzzy/full-text matching, fed by the `search_index_queue` outbox | Typo-tolerant relevance ranking; when unreachable, search falls back to PostgreSQL full-text |
| **RabbitMQ 3.12** (`amqplib`) | Event publishing (optional) | `notifications`, `pymk.compute`, `feed.fanout` receive events | Placeholder for async consumers: nothing consumes these queues yet |

Backend services: `connectionService` (invitation lifecycle, relationship, mutuals), `connectionPath` (bidirectional degree/path search), `pymkService` + `pymkScoring` (PYMK), `searchIndexer` + `searchService` (outbox relay, search with fallback), `feedService` (ranking), `jobService` (candidate matching), `userService`. Routes: `auth`, `users`, `connections`, `feed`, `jobs`. Frontend: React 19 + TanStack Router + Zustand + Tailwind + lucide-react.

## Key Design Decisions

### 1. Connection graph as a canonical relational table, not a graph DB
Connections are stored once with the smaller user id first, so an undirected edge has exactly one row and can never be one-sided. Degree is answered by a bidirectional search over the two members' cached first-degree lists (intersection = 2nd degree), with one indexed probe for an edge between the two sets for 3rd degree; the old code enumerated the viewer's whole second-degree network to answer that. Every lifecycle write runs in one transaction under a per-pair advisory lock. At LinkedIn scale the canonical row becomes a pair-state row with directed adjacency derived from its events (see architecture.md).

### 2. PYMK as on-read weighted multi-signal scoring
Candidates come from one SQL statement (second-degree members ordered by mutual count, capped at 100, excluding connections and pending invitations), plus colleagues/classmates when fewer than ten exist. Weights: **mutual ×10**, **same current company +8**, **shared past company +5**, **same school +5**, **shared skills ×2 (max 5)**, **same location +2**, each producing a reason string. The top 50 are cached 24h and filtered against live connections and invitations on every read. Production would compute the lists offline; here they're computed on a cache miss.

### 3. Multi-factor feed ranking in SQL
`getFeed` ranks posts from self + connections with a scoring expression: **engagement (likes + comments×2) weighted 30%**, **recency with time decay weighted 50%**, plus author-relationship weighting. Doing it in the SQL `ORDER BY` avoids pulling all candidate posts into app memory. Trade-off: the ranking is a fixed heuristic, not a learned model — good enough to demonstrate the recency/engagement/relationship balance, but it can't personalize the way a trained ranker would.

### 4. Search fed by a transactional outbox, not by the request
Profile, experience, skill and job writes upsert a `search_index_queue` row in the same transaction; a relay in each API process rebuilds documents from PostgreSQL and indexes them with backoff. The request never waits on Elasticsearch, and nothing is lost while it is down; search then answers from generated `search_document` columns (GIN). RabbitMQ events are still published for notifications, PYMK and feed fan-out, but no consumer exists.

### 5. Cache invalidation by version, after commit
Graph writes bump `graph:ver:{id}` for both members after the transaction commits, and first-degree lists are cached under the current version, so a reader that loaded the old list just before the change can't write it back where anyone reads it. The feed is not cached (the old "invalidate the first 50 connections' feed keys" loop deleted keys nothing wrote and was removed).

## Current State

Implemented and running end to end: profiles with experience/education/skills, idempotent invitation lifecycle (send, accept, reject, withdraw, remove; crossing invitations connect), degree 1st–3rd with the "how you're connected" path and relationship status, mutual connections, PYMK with reasons, feed with the multi-factor ranking, posts/likes/comments, one-per-connection endorsements, jobs with candidate matching and applications, people/job search through Elasticsearch with a PostgreSQL full-text fallback, Redis-backed sessions shared across instances, rate limiting, Prometheus metrics, `pino` logging, audit logging, and 26 vitest tests (`npm test`). Seed users all log in with `password123`; `db-seed/seed.sql` has ten members (alice, bob, charlie, diana, admin, ethan, fiona, george, hannah, ivan) arranged so 2nd-degree, 3rd-degree, out-of-network and PYMK cases exist for Alice.

Intentionally omitted: precomputed second-degree sets, a nightly PYMK batch, queue consumers, feed caching/cursors, and a learned (ML) feed/PYMK ranker.

## Iteration & Repair Log

- **Async fan-out via RabbitMQ added.** Post/profile/notification events were moved onto `FEED_FANOUT` / `SEARCH_INDEX` / `NOTIFICATIONS` queues so ES reindexing and notifications no longer block the write path.
- **README service-list drift (this pass).** The "Start Infrastructure" step and Tech Stack listed only Postgres/Redis/Elasticsearch and omitted RabbitMQ, which `docker-compose.yml` starts and the routes depend on. Added, and a `db:migrate` step added before `npm run seed` (schema also auto-applies via the `docker-entrypoint-initdb.d` init.sql mount on a fresh volume).
- **CLAUDE.md rewrite (this pass).** Replaced the Phase 1–4 checklist (with a stale "Phase 2: IN PROGRESS") with architecture + decision rationale grounded in `connectionService.ts` and `feedService.ts`. The PYMK weights and feed signals here are taken from the actual scoring code.
- **2026-10-10 — correctness pass, outbox search, docs rewrite.** Reproduced and fixed: `PATCH /api/users/me` built `SET` clauses from raw body keys (Bob could make himself `admin`, set `connection_count`, or inject SQL through a crafted key) — now allowlisted; twenty concurrent accepts of one invitation inflated both `connection_count`s by up to +4 — now a transaction with a conditional-`UPDATE` claim, an advisory lock per pair, and counters that move only when the edge insert happens; crossing invitations created two pending requests — now the second one accepts the first; duplicate sends leaked `duplicate key` / FK messages as 400s — now idempotent outcomes (`sent`, `already_pending`, `accepted_reverse`) and `ApiError` codes; anonymous profile reads and every list returned members' emails — now public projections; registration and profile edits returned 500 when Elasticsearch was down although the row had committed — now a `search_index_queue` outbox and relay, plus PostgreSQL full-text fallback (people search answered in 10 ms instead of a 7.7 s timeout); `GET /api/jobs/companies` was shadowed by `/:id`; keyword job search silently excluded remote jobs; sessions lived in per-process memory so `dev:server1..3` didn't share logins (now `connect-redis`); PYMK made ~400 sequential queries, took the first 100 candidates in arbitrary order and suggested people already invited; endorsements were unlimited per endorser. Added the bidirectional degree/path search, versioned graph cache keys, missing indexes (`connections(connected_to)`, likes/comments by post), graceful shutdown with readiness, a `search:reindex` script, 26 vitest tests, and a richer SQL seed. Frontend: profile actions now come from the server's relationship status (Pending survives reload, incoming invitations can be accepted on the profile) with optimistic rollback and the connection path; PYMK Connect buttons work; search aborts stale requests. Verified with PostgreSQL 16 + Redis (39 scripted checks); Elasticsearch and RabbitMQ paths were not available to exercise. Rewrote architecture.md and the three answers to the diagram standard (pair-row truth with derived adjacency, bidirectional search, PYMK batch + serve-time filter, feed fan-out on read, outbox-fed search).

## Open Questions

1. **Hub members:** the 3rd-degree bridge probe passes both first-degree sets as arrays with no budget. At what set size should it expand only the smaller side and give up (answer "3rd+")?
2. **PYMK freshness vs. cost:** lists are computed on a cache miss and only the two members of a new connection get their list dropped; members two hops away wait for the 24h TTL. Is a nightly batch plus a `pymk.compute` consumer the right next step?
3. **Feed pagination:** `OFFSET` over a score that depends on `NOW()` can repeat or skip posts between pages. Ranked session snapshots with a cursor (as in architecture.md), or keyset on a frozen `as_of`?
4. **Queues without consumers:** `notifications`, `pymk.compute` and `feed.fanout` only accumulate. Build consumers (notifications table + SSE) or stop publishing?
5. **Two seeders:** `npm run seed` and `db-seed/seed.sql` create different datasets. Retire one?

## Resources

- [LinkedIn Graph Processing](https://engineering.linkedin.com/blog/topic/graph-processing)
- [People You May Know (research)](https://dl.acm.org/doi/10.1145/1772690.1772698)
- [Elasticsearch fuzzy search](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-fuzzy-query.html) — user/job search matching

# LinkedIn (Professional Network) — Development with Claude

## Project Context

A professional networking platform whose defining feature isn't posts or messaging but the **connection graph**: connection degrees (1st/2nd/3rd), "People You May Know" recommendations, mutual connections, and job-candidate matching all derive from that graph. The hard problem is answering graph questions ("who's in my 2nd-degree network, ranked by how likely I am to know them") fast enough for an interactive UI without a dedicated graph database — done here with a canonical connections table, aggressive Redis caching, and on-read scoring.

**Learning goals:** connection-degree computation on a relational graph, multi-signal recommendation scoring (PYMK, job matching), multi-factor feed ranking, and decoupling search/notifications/fan-out via a message queue.

## Architecture at a Glance (what actually runs)

Four backing services — this matches `docker-compose.yml` and `backend/package.json`:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** (`pg`) | Source of truth | `users`, `companies`, `skills`/`user_skills`, `experiences`, `education`, `connections`, `connection_requests`, `posts`/`post_likes`/`post_comments`, `jobs`/`job_skills`/`job_applications`, `audit_logs` | Relational integrity for the profile/graph/job data and set-based degree queries |
| **Redis / Valkey 7** (`ioredis`) | Cache-aside | First-degree connections (1h TTL), PYMK results (24h TTL), feed pages, sessions | Graph reads are expensive to recompute; caching turns repeated degree/PYMK lookups into O(1) |
| **Elasticsearch 8.11** (`@elastic/elasticsearch`) | Search | `users` and `jobs` indices with fuzzy/full-text matching | Typo-tolerant relevance ranking PG's `ILIKE` can't do |
| **RabbitMQ 3.12** (`amqplib`) | Async fan-out | `FEED_FANOUT`, `SEARCH_INDEX`, `NOTIFICATIONS` queues | Keeps the write path fast; search reindex and notifications happen off-request |

Backend services: `connectionService` (degrees, mutual, PYMK), `feedService` (ranking), `jobService` (candidate matching), `userService`. Routes: `auth`, `users`, `connections`, `feed`, `jobs`. Frontend: React 19 + TanStack Router + Zustand + Tailwind + lucide-react.

## Key Design Decisions

### 1. Connection graph as a canonical relational table, not a graph DB
Connections are stored once with the smaller user id first (`INSERT … (smallerId, largerId)`), so an undirected edge has exactly one row and lookups never have to check both orderings. First-degree fetch is a single `OR` query cached for an hour; 2nd-degree is a self-join over the cached first-degree set with a mutual-count aggregate; `getConnectionDegree` layers these to answer up to 3rd degree. Trade-off: this is clean and fast at learning scale, but friends-of-friends is a fan-out that grows with degree — at LinkedIn's real scale you precompute 2nd-degree sets or move to a graph engine. The code even flags 3rd-degree/path-finding as "could be optimized with precomputation." We accept the relational approach because it needs no extra datastore and the Redis cache absorbs the repeated reads.

### 2. PYMK as on-read weighted multi-signal scoring
"People You May Know" scores each 2nd-degree candidate: **mutual connections ×10** (strongest), **same company +8**, **same school +5**, **shared skills ×2**, **same location +2**; top results cached 24h. Trade-off: the score is recomputed by pulling each candidate's skills/experience/education, so it's O(candidates × signals) — the code caps candidates at 100 for exactly this reason, trading exhaustive coverage and freshness (24h stale) for tractable compute. A production system precomputes these signals offline; here they're computed live and cached.

### 3. Multi-factor feed ranking in SQL
`getFeed` ranks posts from self + connections with a scoring expression: **engagement (likes + comments×2) weighted 30%**, **recency with time decay weighted 50%**, plus author-relationship weighting. Doing it in the SQL `ORDER BY` avoids pulling all candidate posts into app memory. Trade-off: the ranking is a fixed heuristic, not a learned model — good enough to demonstrate the recency/engagement/relationship balance, but it can't personalize the way a trained ranker would.

### 4. RabbitMQ for everything that can be eventually consistent
A new post publishes to `FEED_FANOUT`; a profile edit publishes to `SEARCH_INDEX` (which reindexes the user in Elasticsearch); likes/comments publish to `NOTIFICATIONS`. Trade-off: search results and notifications lag the write by the queue round-trip, and PostgreSQL — not the queue or ES — remains the source of truth. We accept that lag to keep profile edits and posts feeling instant; the alternative (synchronously reindexing ES and delivering notifications inline) couples the write latency to the slowest downstream.

### 5. Cache invalidation is explicit but bounded
Writes invalidate the relevant Redis keys (accepting a request clears both users' `connections:` and `pymk:` caches; a new post clears connections' `feed:` caches). Trade-off: `createPost` only invalidates the first ~50 connections' feed caches to bound the write cost, so a highly-connected author's more distant connections see a stale feed until TTL expiry — a deliberate cap that trades perfect freshness for a bounded write.

## Current State

Implemented and running end to end: profiles with experience/education/skills, connection requests + accept/reject + removal, connection-degree computation (1st–3rd) and mutual connections, PYMK with the weighted scoring above, feed with the multi-factor ranking, posts/likes/comments, jobs with candidate matching and applications, Elasticsearch user/job search, RabbitMQ fan-out for feed/search/notifications, rate limiting, Prometheus metrics, `pino` logging, and audit logging. Seed users all log in with `password123`.

The earlier checklist called "Graph Queries" **IN PROGRESS** with connection-degree work unchecked — that was stale: degree finding through 3rd degree is implemented. The one genuine TODO it named, an optimized connection **path-finder** (showing the shortest introduction chain), is not built.

Intentionally omitted: precomputed 2nd-degree graph tables, the connection path-finder, and a learned (ML) feed/PYMK ranker.

## Iteration & Repair Log

- **Async fan-out via RabbitMQ added.** Post/profile/notification events were moved onto `FEED_FANOUT` / `SEARCH_INDEX` / `NOTIFICATIONS` queues so ES reindexing and notifications no longer block the write path.
- **README service-list drift (this pass).** The "Start Infrastructure" step and Tech Stack listed only Postgres/Redis/Elasticsearch and omitted RabbitMQ, which `docker-compose.yml` starts and the routes depend on. Added, and a `db:migrate` step added before `npm run seed` (schema also auto-applies via the `docker-entrypoint-initdb.d` init.sql mount on a fresh volume).
- **CLAUDE.md rewrite (this pass).** Replaced the Phase 1–4 checklist (with a stale "Phase 2: IN PROGRESS") with architecture + decision rationale grounded in `connectionService.ts` and `feedService.ts`. The PYMK weights and feed signals here are taken from the actual scoring code.

## Open Questions

1. **2nd-degree at scale:** the self-join fans out with network size. At what connection count does precomputing and caching 2nd-degree sets (or a graph store) become necessary?
2. **PYMK freshness vs. cost:** 24h cache + 100-candidate cap keeps it cheap but stale and incomplete. Is an offline nightly precompute the right middle ground?
3. **Feed invalidation cap:** invalidating only 50 connections' feed caches leaves distant connections stale. Should fan-out be pull-based (compute feed on read) for high-degree authors instead?
4. **Path-finder:** the "how am I connected to X" introduction chain is unbuilt — is a bounded bidirectional BFS over the cached first-degree sets sufficient, or does it need precomputed landmarks?

## Resources

- [LinkedIn Graph Processing](https://engineering.linkedin.com/blog/topic/graph-processing)
- [People You May Know (research)](https://dl.acm.org/doi/10.1145/1772690.1772698)
- [Elasticsearch fuzzy search](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-fuzzy-query.html) — user/job search matching

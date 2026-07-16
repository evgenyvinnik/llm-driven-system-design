# Kindle Community Highlights — Development with Claude

## Project Context

A social reading platform modeled on Kindle's "Popular Highlights": readers highlight passages, sync them across devices, and see aggregated community highlights ("N readers highlighted this") without exposing who highlighted what. Three tensions make it interesting: **cross-device sync** must feel instant (<2s) over flaky mobile links, **community aggregation** must count highlights across millions of readers without a contended write on every save, and **privacy** must let people opt highlights out of the community count entirely.

**Learning goals:** WebSocket sync with offline queueing and last-write-wins conflict resolution, write-optimized aggregation (Redis counters flushed to Postgres), and per-record privacy that gates what enters an aggregate.

## Architecture at a Glance (what actually runs)

Two datastores and four HTTP services plus a worker — this matches `docker-compose.yml` (only Postgres + Redis) and `backend/package.json`:

| Component | Tech | Role |
|-----------|------|------|
| **PostgreSQL 16** (`pg`) | Source of truth | `users`, `books`, `user_books`, `highlights`, `deleted_highlights` (tombstones), `popular_highlights` (aggregates), `follows`, `user_privacy_settings`, `sessions` |
| **Redis / Valkey 7** (`redis` / node-redis v4) | Hot path | Session cache, per-book highlight counters (`book:*:highlights` hashes), offline sync queues, popular-highlights cache |
| **Highlight service** | Express 5 (port 3001*) | CRUD, keyword search, export (Markdown/CSV/JSON), library view |
| **Sync service** | `ws` WebSocket (port 3002) | Device connection registry, real-time push, offline queue, conflict resolution |
| **Aggregation service** | Express 5 (port 3003) | Popular / trending / heatmap read APIs |
| **Social service** | Express 5 (port 3004) | Auth (register/login/session), follow/unfollow, share, privacy settings |
| **Aggregation worker** | Node loop | Every 60s: flush Redis counters → `popular_highlights`; hourly cleanup of zero-count passages |

Frontend: React + TanStack Router (file-based) + Zustand, talking to services through a Vite `/api` proxy. Auth is a session token (`Authorization: Bearer <sessionId>`) hashed with **sha256** (not bcrypt) — fine for a learning build, not production password storage.

> *The highlight service's code default is `HIGHLIGHT_PORT || 3000`, but the frontend Vite proxy and the README both expect **3001**. Run it with `HIGHLIGHT_PORT=3001` (or via the documented env) so `/api/highlights` resolves — see Open Questions.

## Key Design Decisions

### 1. Redis counters flushed to Postgres, not per-save aggregate updates
Creating a highlight does an O(1) Redis increment on a per-book passage counter; a background worker batches those counters into `popular_highlights` every 60 seconds (`ON CONFLICT … DO UPDATE`). Trade-off: popular counts are **eventually consistent** — a passage's community count lags by up to the aggregation interval plus the read-cache TTL. We accept that staleness because the alternative — a contended `UPDATE popular_highlights … SET count = count+1` on every save across millions of readers — serializes the write path on the hottest passages ("the one quote everyone highlights") and turns a fast save into a lock-wait.

### 2. Passage normalization into location windows
Highlights rarely start and end on the exact same character, so raw location ranges would never group. Highlights are bucketed into normalized location windows (a `passage_id` derived from the range) so near-identical selections collapse into one community passage. Trade-off: window size is a precision knob — too wide merges distinct sentences, too narrow fragments the same quote into several low-count passages. The chosen window trades some boundary precision for meaningful grouping.

### 3. WebSocket push + Redis offline queue for sync
Connected devices get an immediate push over a persistent `ws` connection; devices that are offline have events parked in a Redis queue and drained on reconnect. Conflicts use last-write-wins by timestamp, and deletes are propagated via a `deleted_highlights` tombstone table so a delete on one device reaches devices that were offline when it happened. Trade-off vs. HTTP polling: WebSocket hits the <2s target with zero idle-poll traffic, but connections are stateful — they need a connection registry and, at scale, sticky routing or a shared registry. Trade-off of LWW vs. CRDT: LWW can silently drop a concurrent edit (last writer wins), which we accept because a highlight is a small, rarely-co-edited object; a CRDT would be correct but is far more machinery than the payoff here.

### 4. Privacy gates entry into the aggregate
Each highlight has `visibility` (private/friends/public) and each user has `user_privacy_settings.include_in_aggregation`. The worker's sample query only pulls non-private highlights, and only opted-in users contribute to counts. Trade-off: the community view is intentionally incomplete (it under-counts by however many readers opted out) in exchange for never revealing an individual's private highlights.

### 5. ILIKE search locally, Elasticsearch as the production path
Keyword search is a case-insensitive `ILIKE` on `highlighted_text`/`note`. Trade-off: ILIKE needs no extra infrastructure and is fine at local scale, but it's a scan-heavy, index-unfriendly query that would fall over at production volume — the architecture doc names Elasticsearch as the scale-out replacement. There is **no** Elasticsearch container; it's a documented future component, not an "optional" running one.

## Current State

Implemented and running end to end: highlight CRUD + colors + notes, keyword (ILIKE) search, export in three formats, personal library with per-book counts, WebSocket sync with offline queue and tombstone deletes, the Redis→Postgres aggregation worker, popular/trending/heatmap APIs, follow/unfollow and friends'-highlights, share, per-user privacy settings, sha256 session auth, and the React SPA (library, book detail, trending, export, login/register). Seed users: `alice@example.com`, `bob@example.com`, `charlie@example.com`, all `password123`.

Intentionally omitted (production concepts, not built locally): Elasticsearch search, a real on-device local store (the "SQLite" box in the architecture diagram is a client-device concept), CRDT conflict resolution (uses LWW), and request rate limiting.

## Iteration & Repair Log

- **DB migrate/seed scripts added.** `db:migrate` runs `src/db/init.sql` (idempotent `CREATE … IF NOT EXISTS`) and `db:seed` loads the three demo users + sample books/highlights. This was part of the repo-wide "missing schema-apply path" repair.
- **Schema location corrected in docs.** The prior CLAUDE.md listed the schema as `src/db/migrations/001_initial_schema.sql`; the actual file is `src/db/init.sql`. Fixed here.
- **Search description corrected.** Both this file and `architecture.md` described search as "PostgreSQL full-text search" and hinted "Elasticsearch optional." The code uses `ILIKE` substring matching and there is no Elasticsearch. Corrected to reflect ILIKE-now / Elasticsearch-at-scale.
- **CLAUDE.md rewrite (this pass).** Replaced the Phase 1–4 ✅ checklist and "Files Created" inventory with architecture and decision rationale grounded in `aggregation/worker.ts`, `db/init.sql`, and the service entry points.

## Open Questions

1. **Highlight-service port footgun:** the code defaults to 3000 but the frontend proxy targets 3001. Should the default be changed to 3001 (source fix) so `npm run dev` works without setting `HIGHLIGHT_PORT`, or should the proxy move to 3000?
2. **Aggregation cadence vs. freshness:** 60s + cache TTL is fine for "popular," but "trending" implies recency — does trending need a shorter window or a time-decayed counter rather than a raw count?
3. **Tombstone growth:** `deleted_highlights` grows unbounded. When can a tombstone be reaped — after all a user's devices have acknowledged the delete?
4. **Sync scale:** the in-memory connection registry is per-instance. Moving to multiple sync instances needs the registry (and fan-out) in Redis; what's the routing story for a user's devices landing on different instances?

## Resources

- [Amazon Kindle Popular Highlights](https://www.amazon.com/gp/help/customer/display.html?nodeId=201630920)
- [Local-First Software](https://www.inkandswitch.com/local-first/) — offline-first and sync philosophy
- [CRDTs](https://crdt.tech/) — the conflict-resolution path we deliberately did not take
- [RFC 6455 — The WebSocket Protocol](https://tools.ietf.org/html/rfc6455)

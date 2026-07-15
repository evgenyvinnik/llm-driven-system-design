# Confluence Wiki — Development with Claude

## Project Context

A Confluence-style wiki/knowledge base: spaces contain a hierarchical tree of pages, every edit produces an immutable version (with two-version diffing), and pages are discoverable through full-text search. The interesting tension is that a wiki is **read-heavy and search-driven** but every write must fan out to three stores that answer different questions — the relational source of truth, the search index, and the cache — without blocking the editor or losing durability.

**Learning goals:** hierarchical tree modeling in SQL, version control with diffs, decoupling search indexing from the write path via a queue, and a graceful-degradation search design (Elasticsearch with a PostgreSQL fallback).

## Architecture at a Glance (what actually runs)

Four backing services, each chosen for a specific access pattern. This matches `docker-compose.yml` and `backend/package.json` exactly:

| Store | Client lib | Role | Why this one |
|-------|-----------|------|--------------|
| **PostgreSQL 16** | `pg` | Source of truth: users, spaces, pages, `page_versions`, comments, labels, templates, approvals | ACID transactions so a page update and its version row commit atomically; recursive CTEs for the breadcrumb ancestor walk |
| **Valkey (Redis)** | `ioredis` + `connect-redis` | Session store, cache-aside for page/tree/slug reads (120s TTL), rate-limit counters | Sub-ms reads on the hot page-view path; shared across API instances so sessions survive horizontal scaling |
| **Elasticsearch 8.11** | `@elastic/elasticsearch` | `wiki_pages` index with a custom `wiki_analyzer` (lowercase + stop + snowball) | BM25 relevance, field boosting (title^3, labels^2), AUTO fuzziness, and `<mark>` highlighting out of the box |
| **RabbitMQ** | `amqplib` | `page-index` durable queue decoupling writes from ES indexing | The API returns as soon as PG commits; a worker indexes asynchronously so ES latency never blocks editing |

The backend is a **single Express app** (not microservices), routes split by domain: `auth`, `spaces`, `pages`, `versions`, `search`, `templates`, `comments`, `approvals`. A separate long-running process, `workers/search-indexer.ts`, consumes the `page-index` queue. Default API port is **3001** (not 3000). Frontend: React 19 + TanStack Router (file-based routing via `router-plugin`) + Zustand + Tailwind — no charting or virtualization libraries.

## Key Design Decisions

### 1. Adjacency list for the page tree, not nested sets
Pages self-reference via `parent_id`. The whole space (typically < 1000 pages) loads in one query and the tree is built in memory (`buildTree` in `pageService.ts`); ancestor breadcrumbs use a recursive CTE. Trade-off given up: subtree queries are O(n) rather than O(log n). That's the right call because wiki trees are shallow and wide, moves are cheap (a single `parent_id` update plus sibling reorder), and the tree render is cached in Redis — the O(n) load rarely hits PG.

### 2. Full snapshots per version, HTML line-diff on read
Each edit writes a complete `page_versions` row (content_json + content_html + content_text), not a delta. Diffs are computed lazily with the `diff` library's `diffLines()` over `content_html` when a user compares two versions. Trade-off: storage grows linearly with edits (a 50KB page edited 100 times is 5MB of history), and HTML line diffs are noisier than block-level diffs. Accepted because snapshot restore is trivial (copy a row forward) and no diff needs to be replayed to reconstruct a version.

### 3. Async search indexing through RabbitMQ, with a PostgreSQL fallback on read
Writes publish `{action, pageId, spaceId}` to the `page-index` queue and return; the indexer fetches the page + labels from PG and upserts the ES document. Because the indexer always reads the *current* PG state, duplicate messages are idempotent (same document). On the read side, if ES throws, `searchPages()` falls back to a PG `ILIKE` query — results without ranking or highlighting, but search never returns a broken page. Trade-off: search is eventually consistent (a few seconds of staleness after an edit), which is acceptable for a wiki.

### 4. contentEditable editor, not ProseMirror/Tiptap
The editor uses `contentEditable` + `document.execCommand` and stores rendered HTML directly. This avoids a 50-100KB structured-editor dependency and its state model. Trade-off given up: no real-time collaboration, weaker undo/redo, and cross-browser `execCommand` inconsistencies. Adding collaboration later is *not* incremental — it means swapping the editor for a CRDT (Yjs) and changing the persistence model — so the editor is deliberately isolated from the data layer.

### 5. Space-level RBAC, flagged (not enforced page-level) permissions
`space_members` maps users to a space with `admin`/`member`/`viewer` (CHECK-constrained). Authorization is enforced at the space boundary, not per page. Trade-off: no page-level ACLs or group-based roles — production Confluence needs both, plus inheritance down the tree — but space-level roles cover the demo's governance story (who can edit vs view a space).

## Current State

Implemented and working end to end: session auth (bcrypt, Redis-backed sessions); space CRUD with membership; page CRUD with adjacency-list tree, move/reorder, slugs, breadcrumbs; full version history with two-version diff and restore; label tagging; threaded comments with resolve/unresolve; content approval workflow (request → approve/reject); page templates; server- and client-side macro rendering (info/warning/note/code/toc); Elasticsearch indexing via the RabbitMQ worker with PG `ILIKE` fallback; Redis cache-aside on page reads; and the production-pattern set — Opossum circuit breaker, prom-client metrics at `/api/metrics`, Pino structured logs, and Redis-backed rate limiting.

Intentionally omitted (noted as production extensions): real-time collaborative editing (WebSocket + CRDT), file/image attachments (would need MinIO/S3), page-level permissions and group roles, PDF/Word export, SAML/OAuth SSO, and multi-region replication.

## Iteration & Repair Log

- **ESM/named-import fixes (`dabfb716`, `7cb61263`):** several default imports were wrong for the installed major versions — `pino-http` and `ioredis` (`Redis`) were switched to named imports, and `queue.ts` was updated to the `amqplib` 0.10 `ChannelModel` API. Without these the backend failed to boot under `"type": "module"`.
- **Dependency version alignment (`dabfb716`):** `@types/express` was pinned back from `^5.0.0` to `^4.17.25` to match the Express 4.21 runtime, and `@types/opossum` was added so the circuit-breaker service type-checks.
- **Seed password-hash scheme fix (`bde0576a`):** seeded users carried a `$2a$12$` bcrypt hash that didn't verify against the normalized demo password. Replaced with a `$2b$10$` hash so **alice** and **bob** both log in with `password123` (see README Demo Accounts).
- **Doc drift corrected here (2026-07):** `architecture.md` listed the metrics route as `/metrics` and described `DELETE /pages/:id` as "Archive page." The code exposes metrics at `/api/metrics` (`app.ts`) and `deletePage()` performs a hard `DELETE FROM pages` (children reparented by `ON DELETE SET NULL`). Both corrected. This CLAUDE.md was also rewritten from a generic phase-checklist into real decision/iteration history.

## Open Questions

1. Version history stores full HTML snapshots — at what edit count/page size does this need delta compression or content-addressed storage for shared blocks?
2. Cache invalidation is pattern-based (`cacheDelPattern('space:{id}:*')`), which over-invalidates the whole space tree on any single-page content edit. When does the extra PG load from cold trees justify finer-grained keys?
3. The ES fallback returns unranked `ILIKE` results — should the fallback at least use PostgreSQL `tsvector`/`ts_rank` so relevance doesn't fully collapse when ES is down?
4. Approvals are single-reviewer and don't gate publishing. Where should a real approval chain (multi-reviewer, block-publish-until-approved) live — in the page status machine or a separate workflow service?

## Resources

- [Elasticsearch multi_match + fuzziness](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-multi-match-query.html)
- [PostgreSQL Recursive CTEs](https://www.postgresql.org/docs/current/queries-with.html) — used for breadcrumb ancestor walks
- [Yjs](https://github.com/yjs/yjs) — the CRDT path this project deliberately avoids for the editor

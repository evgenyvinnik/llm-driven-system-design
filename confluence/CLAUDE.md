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

The backend is a **single Express app** (not microservices), routes split by domain: `auth`, `spaces`, `pages`, `versions`, `search`, `templates`, `comments`, `approvals`. A separate long-running process, `workers/search-indexer.ts`, consumes the `page-index` queue; `npm run dev` starts it alongside the API with `concurrently`. Authorization lives in one module, `services/accessService.ts`, which every route consults. Default API port is **3001** (not 3000). Frontend: React 19 + TanStack Router (file-based routing via `router-plugin`) + Zustand + Tailwind — no charting or virtualization libraries.

## Key Design Decisions

### 1. Adjacency list for the page tree, not nested sets
Pages self-reference via `parent_id`. The whole space (typically < 1000 pages) loads in one query and the tree is built in memory (`buildTree` in `pageService.ts`); ancestor breadcrumbs use a recursive CTE. Trade-off given up: subtree queries are O(n) rather than O(log n). That's the right call because wiki trees are shallow and wide, moves are cheap (a single `parent_id` update plus sibling reorder), and the space's flat page list is cached in Redis, so the O(n) load rarely hits PG. The tree is built per request from that list, because which drafts appear depends on the caller (decision 5).

### 2. Full snapshots per version, HTML line-diff on read
Each edit writes a complete `page_versions` row (content_json + content_html + content_text), not a delta. Diffs are computed lazily with the `diff` library's `diffLines()` over `content_html` when a user compares two versions. Trade-off: storage grows linearly with edits (a 50KB page edited 100 times is 5MB of history), and HTML line diffs are noisier than block-level diffs. Accepted because snapshot restore is trivial (copy a row forward) and no diff needs to be replayed to reconstruct a version.

### 3. Async search indexing through RabbitMQ: retried, versioned, and reconciled; PostgreSQL fallback on read
Writes publish `{action, pageId, spaceId}` to the `page-index` queue and return; the indexer fetches the page + labels from PG and upserts the ES document. Because it always reads the *current* PG state, duplicate messages are harmless.

"Eventually consistent" needs three supports, which were missing until 2026-10:
- **Messages must not be lost.** The publisher uses a confirm channel and buffers in memory while the broker is unavailable.
- **Failures must not be acknowledged.** The worker retries with backoff, then parks the message on a dead-letter queue.
- **Late writes must not regress the index.** Each document carries the page version as an ES external version.

Above those, the worker reconciles the whole index with Postgres at boot and every 10 minutes. That is what makes the system *eventually* consistent rather than consistent-unless-something-went-wrong: anything the queue still loses, such as a crash with messages buffered, is repaired within one interval.

On the read side, hits are re-checked against PG (status, space visibility, current slug) before being returned, and an ES exception falls back to an authorized, escaped `ILIKE` query flagged `degraded`.

The alternative to reconciliation is a transactional outbox: an outbox row written in the page transaction, relayed after commit. It closes the crash gap but adds a table, a relay loop and its own monitoring. For a wiki where a few minutes of search staleness after a crash is tolerable, a periodic full reconcile over a small corpus is the cheaper guarantee. That stops being true once the corpus is too large to reindex every few minutes.

### 4. contentEditable editor, not ProseMirror/Tiptap
The editor uses `contentEditable` + `document.execCommand` and stores rendered HTML directly. This avoids a 50-100KB structured-editor dependency and its state model. Trade-off given up: no real-time collaboration, weaker undo/redo, and cross-browser `execCommand` inconsistencies. Adding collaboration later is *not* incremental — it means swapping the editor for a CRDT (Yjs) and changing the persistence model — so the editor is deliberately isolated from the data layer.

### 5. Space-level RBAC in one policy module; invisible means 404
`space_members` maps users to a space with `admin`/`member`/`viewer` (CHECK-constrained), and `accessService.ts` turns that into `canView` / `canEdit` / `canAdmin`:
- **Viewing** needs membership or a public space.
- **Drafts** need member access.
- **Writing** pages, labels, moves and restores needs member access.
- **Administering** space settings, membership and approval reviews needs admin.

Every route asks the module rather than deciding inline. The previous version decided inline, and in practice decided nothing: any signed-in user could rename or delete any space and add themselves as admin.

Two choices are worth defending. An invisible space or page returns **404, not 403**: a 403 confirms that the private key or page ID exists, and in a wiki the title in a URL can itself be sensitive. And authorization reads always go to Postgres, never the page cache. The cache holds page rows for 120 s, so judging access from a cached row would let a just-revoked member keep reading for two minutes.

The trade-off is no page-level ACLs or group roles. Production Confluence needs both, with inheritance down the tree, which turns "can I see this page" into an ancestor walk on every read. Space-level roles keep that question to one membership lookup.

### 6. Approvals are bound to the version that was reviewed
An approval request records `page_version`. Approving requires a space admin who is not the requester, and refuses (409) if the page has moved past that version. Without the binding, an author could request review of a harmless draft, rewrite it, and have the approval publish the rewrite. A partial unique index allows only one pending request per page; the old check-then-insert could be raced into duplicates.

What this does not do is keep a separate published revision. Approval flips the page's status, so once published, further edits are live immediately. A real review workflow keeps an authoring head and a published pointer, and approval advances the pointer to a specific revision. That is the next step if approvals are meant to gate every change rather than first publication.

### 7. Page HTML is sanitized on write, not trusted on read
The editor produces HTML and the viewer renders it with `dangerouslySetInnerHTML`, so stored HTML is code that runs for every reader, admins included. `htmlSanitizer.ts` (`sanitize-html`) cleans it on create, update and restore against an allow-list. The list keeps the formatting the editor and macros produce, including the macros' inline styles, and drops scripts, event handlers, iframes and non-http(s) URLs.

Sanitizing on write means the stored value is safe wherever it is used, including search snippets and future exports, and the work is paid once per save rather than once per view. The cost is that rows written outside the API (the SQL seed, or anything predating this change) are trusted as stored. Sanitizing on read as well would close that gap at the price of per-view work.

## Current State

Implemented and working end to end: session auth (bcrypt, Redis-backed sessions regenerated on login); space-level authorization on every route, including search; space CRUD with membership management and a last-admin guard; page CRUD with adjacency-list tree, move/reorder with cycle refusal, per-space unique slugs, breadcrumbs, and version-checked saves (409 on a stale base); full version history with two-version diff and restore; label tagging; threaded comments with resolve/unresolve; a content approval workflow (request → approve/reject) bound to the reviewed version, with no self-review; page templates; server- and client-side macro rendering (info/warning/note/code/toc); Elasticsearch indexing via the RabbitMQ worker (confirm channel, retries, dead-letter queue, versioned writes, periodic reconciliation) with an authorized PG `ILIKE` fallback; server-side HTML sanitization; Redis cache-aside on page reads; prom-client metrics at `/api/metrics`, Pino structured logs, and Redis-backed rate limiting. An Opossum circuit-breaker factory exists in `services/circuitBreaker.ts` but nothing calls it.

Seeded logins (all `password123`): **alice** (global admin; Engineering and Security admin), **bob** (Engineering member, Product admin), **carol** (Engineering viewer). Security (`SEC`) is a private space only alice can see. Engineering has a draft (*Q3 Platform Migration Plan*) with a pending approval from bob.

Intentionally omitted (noted as production extensions): real-time collaborative editing (WebSocket + CRDT), file/image attachments (would need MinIO/S3), page-level permissions and group roles, a published-revision pointer separate from the authoring head, slug redirect history, PDF/Word export, SAML/OAuth SSO, and multi-region replication.

## Iteration & Repair Log

- **ESM/named-import fixes (`dabfb716`, `7cb61263`):** several default imports were wrong for the installed major versions — `pino-http` and `ioredis` (`Redis`) were switched to named imports, and `queue.ts` was updated to the `amqplib` 0.10 `ChannelModel` API. Without these the backend failed to boot under `"type": "module"`.
- **Dependency version alignment (`dabfb716`):** `@types/express` was pinned back from `^5.0.0` to `^4.17.25` to match the Express 4.21 runtime, and `@types/opossum` was added so the circuit-breaker service type-checks.
- **Seed password-hash scheme fix (`bde0576a`):** seeded users carried a `$2a$12$` bcrypt hash that didn't verify against the normalized demo password. Replaced with a `$2b$10$` hash so **alice** and **bob** both log in with `password123` (see README Demo Accounts).
- **Doc drift corrected here (2026-07):** `architecture.md` listed the metrics route as `/metrics` and described `DELETE /pages/:id` as "Archive page." The code exposes metrics at `/api/metrics` (`app.ts`) and `deletePage()` performs a hard `DELETE FROM pages` (children reparented by `ON DELETE SET NULL`). Both corrected. This CLAUDE.md was also rewritten from a generic phase-checklist into real decision/iteration history.

- **2026-11-01: authorization, search integrity, and an unreachable page view.**

  The app's own docs were half right:
  - **Access control.** The architecture review said space roles were "largely unused", while this file said "authorization is enforced at the space boundary". In fact nothing checked roles. Any signed-in user could update or delete any space and `POST /spaces/:key/members` to make themselves admin. Drafts, private pages, versions, comments and approvals were readable by ID, search ignored membership, and any user could resolve any comment.
  - **Broken links and indexing.** Search results linked with the page ID as the slug, so every result opened "Page not found". Restore, approval, label changes and space deletion never reindexed. The indexer acknowledged failed writes, and nothing ran the indexer in `dev`, so ES stayed empty and search returned nothing rather than falling back.
  - **Smaller faults.** Moves to or from the root failed on a missing SQL parameter, approvals could be self-reviewed and published unreviewed edits, and slugs collided.

  Fixed as decisions 3, 5, 6 and 7, plus unique slugs, version-checked saves, cycle-safe moves, session regeneration and the `display_name` key.

  **Two findings came from running it, not reading it:**
  - **The page view was unreachable.** In TanStack flat routing, `space.$spaceKey.tsx` was the parent of the page route, which was the parent of `/edit`, and neither rendered an `<Outlet/>`. Every page URL showed the space overview, confirmed by a screenshot. The parents became `*.index.tsx` siblings, the same bug class as payment-system's `transactions.tsx` and reddit's `r.$subreddit.tsx`.
  - **Index messages were dropped at boot.** A live check failed one run in three because RabbitMQ was still starting and every index message published then was dropped. The publisher now buffers and flushes on reconnect.

  **Verification:**
  - 30 unit tests.
  - 63 live checks across anonymous, viewer, member and admin identities, passing on repeated clean resets.
  - An outage run that stops Elasticsearch mid-session and confirms the escaped, authorized fallback and that an edit made during the outage is indexed after recovery.
  - Seven regenerated screenshots, including the page view, a draft under review, search results, and a viewer's space.

## Open Questions

1. Version history stores full HTML snapshots — at what edit count/page size does this need delta compression or content-addressed storage for shared blocks?
2. Cache invalidation is pattern-based (`cacheDelPattern('space:{id}:*')`), which over-invalidates the whole space tree on any single-page content edit. When does the extra PG load from cold trees justify finer-grained keys?
3. The ES fallback returns unranked `ILIKE` results — should the fallback at least use PostgreSQL `tsvector`/`ts_rank` so relevance doesn't fully collapse when ES is down?
4. Approvals now bind to a version but still flip page status, so a published page's later edits go live unreviewed (decision 6). Should publication become a pointer to an approved revision, and if so, does search index the published revision for readers and the head for editors — two documents per page?
5. Reconciliation reindexes every page every 10 minutes (decision 3). At what corpus size does that stop being cheap, and is the right replacement a transactional outbox, or a reconcile that compares `updated_at` watermarks instead of rewriting everything?
6. Authorization is per request and reads Postgres each time (decision 5). A hot page view now costs a membership query even on a cache hit. Is a short-lived per-session role cache (invalidated by membership changes) worth the revocation-latency risk it reintroduces?

## Resources

- [Elasticsearch multi_match + fuzziness](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-multi-match-query.html)
- [PostgreSQL Recursive CTEs](https://www.postgresql.org/docs/current/queries-with.html) — used for breadcrumb ancestor walks
- [Yjs](https://github.com/yjs/yjs) — the CRDT path this project deliberately avoids for the editor

# Confluence architecture

## System Overview

A team wiki organizes knowledge into spaces and page hierarchies. Authors edit durable revisions, readers follow stable links, reviewers approve identifiable content, and search makes that content discoverable. The difficult boundaries are between an author's draft and the committed revision, a committed revision and the search index, and a visible navigation item and the viewer's actual permission to read it.

This document separates a **proposed production design** from the **current teaching implementation**. The production sections describe intended guarantees, not measured or implemented behavior. The schema and API sections identify what exists today; the final Implementation Notes trace the local paths and defects to source.

## Requirements

### Functional requirements — proposed production system

- Create spaces, manage membership, and browse pages through a hierarchy and stable links.
- Read published revisions; allow authorized authors to edit drafts without silently overwriting a newer revision.
- Keep immutable revision history, compare revisions, and restore an old revision as a new one.
- Publish directly where space policy permits, or approve a specific revision before publication.
- Search authorized published content by text, space, and label.
- Support comments and bounded reply threads, with explicit authorship and moderation rules.
- Offer reusable templates and a small, validated set of content macros.

Live character-level co-editing, arbitrary executable macros, attachments, and offline synchronization are outside the initial design. A disconnected draft can be preserved locally without promising that it will merge automatically.

### Non-functional requirements — proposed targets

| Concern | Initial target or contract |
|---------|----------------------------|
| Availability | 99.9% monthly for authorized page reads and saves |
| Latency | p95 page read <200 ms, save <500 ms, search <500 ms under the agreed workload |
| Persistence | A successful save means its revision and durable mutation receipt committed together |
| Conflicts | A save against an obsolete base returns a conflict, preserving the author's draft |
| Search freshness | 99% of committed searchable changes visible within 5 seconds during normal operation |
| Access control | Newly authorized reads after a completed revocation cannot rely on an obsolete permission cache |
| Recovery | Database backups and restore drills; search reconstructible from authoritative state |

Search lag is permitted; exposing a private or unpublished revision is not. Revocation cannot erase content a user has already read or copied. Page size, hierarchy depth, query cost, and retained revision history need explicit limits.

## Capacity Estimation

These are sizing assumptions, not project benchmarks. Assume one million daily active users, 20 million current pages, 40 million page reads, ten million searches, and 500,000 accepted revisions per day.

| Quantity | Approximate estimate | Design implication |
|----------|----------------------|--------------------|
| Page reads | 463/s average; plan an initial 5,000/s peak | Cache immutable revision payloads; scale read API capacity |
| Searches | 116/s average; plan a 1,000/s peak | Independent search capacity and bounded query budgets |
| Revisions | 5.8/s average; plan a 100/s peak | One relational transaction per accepted edit is reasonable initially |
| Current canonical content | 20 million × 40 KB ≈ 800 GB | Separate large content from frequent navigation queries |
| New revision content | 500,000 × 40 KB ≈ 20 GB/day | About 600 GB/month before compression and retention policies |

HTML, extracted text, indexes, replicas, and backups add to these estimates. Skew matters more than the average: one very large space can dominate tree reads or move operations. Measure that distribution before deciding to shard.

### Local Development Scale

The seed contains nine pages across two spaces. Compose runs one PostgreSQL, one Valkey, one Elasticsearch node with a 256 MB heap, and one RabbitMQ broker. API and worker processes run on the host. This demonstrates boundaries, not the throughput or availability targets above.

## High-Level Architecture

### Proposed production system

```text
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Browser / clients      │       │ Wiki API modules       │       │ PostgreSQL authority   │
│ Page or search request │◀─────▶│ Session + permission   │◀─────▶│ Pages / revisions      │
└────────────────────────┘       │ Revision/tree commands │       │ Receipts, ACL, outbox  │
                                 └────────────────────────┘       └────────────────────────┘
                                              ▲                                │
                                              │                                │
                              search request  │             committed events   │
                                              │                                │
                                              ▼                                ▼
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Derived search index   │       │ Search coordinator     │       │ Outbox relay + queue   │
│ Versioned documents    │◀─────▶│ Bounded candidates     │       │ Retained obligations   │
│ No access authority    │       │ Current access check   │       │ Retries and event IDs  │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘
             ▲                                                                 │
             │                                                                 │
             │                                               indexing work     │
             │                                                                 │
             │                                                                 ▼
             │                                                    ┌────────────────────────┐
             │                                                    │ Index workers          │
             └───────────────────────────────────────────────────▶│ Ordered generations    │
                                                                  │ Updates + tombstones   │
                                                                  └────────────────────────┘

Save/publication commit first; index visibility follows. Logical modules can share one API.
```

A CDN serves versioned application assets. Redis can hold sessions and reusable revision payloads; neither decides the authoritative revision or access policy. The logical Wiki and Search APIs may begin in one deployable application. Separating every feature into a service would add transactions and failure modes without improving the initial workload.

A save returns the committed revision receipt even if derived search work is delayed.
The outbox retains that obligation; workers repeat ordered updates or tombstones and
check projection results without creating another page revision. Search narrows the
candidate set, then validates current access and the allowed published revision before
returning content. Client recovery likewise resolves the existing receipt and keeps
newer local text separate from the accepted or published server snapshot.

## Core Components / Request Flows

### Read a page

Resolve the stable page ID and evaluate current read permission and publication policy. Select an immutable revision, then fetch that payload from cache or PostgreSQL. Return the page ID, revision, canonical URL, breadcrumbs, and permitted actions. Fetch small navigation metadata separately from the document body.

Cache keys include the immutable revision and rendering format version. A cache hit never bypasses authorization. If the access authority is unavailable, private reads fail closed. A page whose latest authoring revision differs from its published revision still presents the approved published content to ordinary readers.

The local implementation checks space access on every page-derived read before serving it, resolves slugs that are unique within a space but change on rename (no redirect history), and caches current page rows for 120 seconds.

### Save an edit

1. The client submits page identity, expected base revision, content, and a mutation ID tied to this exact request.
2. The API validates the canonical document schema and derives safe HTML and plain text. It checks write permission within the transaction's policy boundary.
3. A transaction checks for an existing mutation receipt, conditionally advances the page head from the expected revision, inserts the immutable snapshot, and writes the receipt and outbox event.
4. A base mismatch produces a conflict with current revision metadata. A matching receipt returns the original outcome; reuse with another payload is rejected.
5. After commit, the response identifies the accepted revision. The browser retains any additional typing performed while the request was in flight.
6. Indexing proceeds asynchronously. It does not determine whether the save succeeded.

A receipt is needed for create and restore as well as edit. A timeout after commit is an unknown result, not evidence that no revision exists. A client retries the same immutable request or queries its receipt before submitting a new mutation.

The local update locks the row and accepts an optional expected `version`; a save on a stale base gets a 409 with the current version instead of overwriting. There is no mutation receipt or transactional outbox: the index message is published after commit through a confirm channel, buffered in memory while the broker is unavailable, and backstopped by a periodic reconciliation. A cache invalidation failure after commit is logged, not returned as an error.

### Publish or approve

Keep an authoring head and a published revision pointer. A direct publication, where permitted, advances that pointer in an authorized transaction. An approval request names one immutable revision; reviewing it does not implicitly approve later edits. Publication validates the request's state, reviewer authority, and target revision, then writes its event atomically.

An approval can remain a useful historical decision even when the author has moved on. Product policy determines whether an older approved revision can be published; the UI must name it explicitly. Publication changes are searchable state changes even when the content revision number stays the same.

The prototype defaults new pages to `published`; drafts are opt-in. An approval request records the page version under review. Approving requires a space admin who is not the requester and refuses if the page has moved past that version, so it publishes exactly what was reviewed. There is still no separate published-revision pointer: publication flips the page's status, so a later edit to a published page is live immediately.

### Index and search

Write a durable outbox event with a per-page **search generation** covering content, publication, labels, and deletion. Its immutable payload represents one consistent authoritative state. A publisher retries until the broker confirms acceptance; an indexer acknowledges only after applying the effect or proving an equal/newer generation is already present. Permanent failures enter a repair queue with enough context to replay.

Use the generation for conditional search writes. Elasticsearch's external versioning rejects an index operation whose version is not greater than the stored one; duplicate conflicts need deliberate classification, not blanket error suppression. Keep versioned deletion tombstones until all permitted replay and rebuild paths can no longer resurrect older content. [Elasticsearch Index API](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/docs-index_.html)

Search returns candidate IDs with indexed revision information. Before returning titles, snippets, or counts that could disclose private material, apply current permissions and verify the candidate still represents the allowed published revision. Fetch current safe metadata or discard stale candidates. Limit overfetching; return a continuation cursor rather than pretending a filtered raw hit count is an exact authorized total.

An accepted index write is not immediately visible to search; refresh introduces another delay after transport and worker processing. The freshness target measures the whole path. [Elasticsearch near real-time search](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/near-real-time.html)

### Move a subtree

Use page IDs and adjacency-list parent references. In a transaction, serialize hierarchy changes within the space, validate both nodes' space membership, walk ancestry to reject cycles, and update parent/order plus a hierarchy generation. All parent-changing operations must participate in that protocol. Bound depth and sibling counts so validation and reordering remain predictable.

The space-wide lock is a simple initial choice because moves are uncommon. It serializes independent moves too. If measurements show contention, introduce narrower locks with a defined acquisition order and prove cycle prevention under concurrent moves before removing the coarse boundary.

## Database Schema

### Current local schema

The following is the consolidated schema from [backend/src/db/init.sql](./backend/src/db/init.sql). It documents the implementation; its constraints do **not** establish all production requirements described above.

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  homepage_id UUID,
  is_public BOOLEAN DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS space_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(space_id, user_id)
);

CREATE TABLE IF NOT EXISTS pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES pages(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  content_json JSONB DEFAULT '{}',
  content_html TEXT DEFAULT '',
  content_text TEXT DEFAULT '',
  version INT DEFAULT 1,
  status VARCHAR(20) DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  position INT DEFAULT 0,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Guarded so init.sql is re-runnable: the schema is applied both by the docker
-- initdb mount and by `npm run db:migrate`, so a bare ADD CONSTRAINT fails the
-- second time with "constraint already exists".
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS fk_homepage;
ALTER TABLE spaces ADD CONSTRAINT fk_homepage FOREIGN KEY (homepage_id) REFERENCES pages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS page_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  content_json JSONB NOT NULL,
  content_html TEXT NOT NULL,
  content_text TEXT DEFAULT '',
  change_message TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(page_id, version_number)
);

CREATE TABLE IF NOT EXISTS page_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  label VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(page_id, label)
);

CREATE TABLE IF NOT EXISTS page_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  parent_id UUID REFERENCES page_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  is_resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  content_json JSONB NOT NULL,
  is_global BOOLEAN DEFAULT false,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS page_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  comment TEXT,
  page_version INT,          -- the version under review; approval refuses if the page moved on
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

-- One pending approval per page
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_approvals_one_pending
  ON page_approvals(page_id) WHERE status = 'pending';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(space_id, parent_id, position);
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(space_id, slug);
CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_page_comments_page ON page_comments(page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_page_labels_page ON page_labels(page_id);
CREATE INDEX IF NOT EXISTS idx_page_labels_label ON page_labels(label);
CREATE INDEX IF NOT EXISTS idx_space_members_space ON space_members(space_id);
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_space ON templates(space_id);
CREATE INDEX IF NOT EXISTS idx_page_approvals_page ON page_approvals(page_id, status);
```

### Proposed production additions and invariants

| Record or constraint | Purpose |
|----------------------|---------|
| Tenant/space ownership on authorization paths | Prevent cross-space access through page, history, comment, and search APIs |
| Page head plus published revision pointer | Separate saved drafts from content approved for readers |
| Mutation receipt unique within actor/space scope | Resolve ambiguous retries, with payload digest and committed response |
| Outbox row in the revision/publication transaction | Repairable delivery of every searchable change |
| Monotonic search generation and retained deletion state | Prevent out-of-order jobs from regressing or resurrecting documents |
| Approval target revision and unique pending-policy key | Bind review to content and prevent duplicate active requests |
| Same-space parent relationship plus transactional cycle check | Preserve a valid hierarchy under all mutation paths |
| Canonical stable-ID URL and optional slug aliases | Keep links valid after renames and disambiguate titles |
| Canonical document schema and rendering version | Reproduce safe HTML and text from one authoritative representation |
| Comment same-page parent and bounded reply depth | Make stored discussion topology match the API's supported shape |

The slug index is non-unique; uniqueness within a space is enforced by the service (`title`, `title-2`, ...). Parent foreign keys do not establish same-space membership in the schema; the service rejects cross-space parents and cycles. The stale-editor check is the optional expected `version` on update, not a constraint. There is no mutation receipt, outbox, or search-generation column.

## API Design

### Current routes

Business routes below use `/api/v1`; health and metrics use the absolute paths shown. Every page-derived route checks space access through [accessService.ts](./backend/src/services/accessService.ts). Reads need view access (membership, or a public space; drafts need member access), writes need member access, and space settings and membership need admin. A caller who cannot view the space gets 404.

| Method | Path | Actual purpose |
|--------|------|----------------|
| POST | `/auth/register`, `/auth/login` | Create an account or establish a session |
| POST / GET | `/auth/logout`, `/auth/me` | End session / return authenticated user |
| GET / POST | `/spaces` | List spaces the caller can view / create a space (creator becomes admin) |
| GET / PUT / DELETE | `/spaces/:key` | Read with the caller's `access` / update or delete (space admins) |
| GET / POST / DELETE | `/spaces/:key/members`, `/spaces/:key/members/:userId` | Read members / add or change a role / remove (admins; last admin protected) |
| GET | `/pages/recent` | Twenty recent pages the caller can see |
| GET | `/pages/space/:spaceKey/tree` | Server-built tree of page metadata; drafts only for members |
| GET | `/pages/space/:spaceKey/slug/:slug`, `/pages/:id` | Page with author, labels, breadcrumbs, and the caller's `access` |
| POST / PUT / DELETE | `/pages`, `/pages/:id`, `/pages/:id` | Create, save a new revision (optional expected `version`), or hard-delete |
| POST | `/pages/:id/move` | Change parent and sibling positions within the space; cycles refused |
| GET / POST / DELETE | `/pages/:id/labels`, `/pages/:id/labels`, `/pages/:id/labels/:label` | List, add, or remove labels |
| GET | `/versions/:pageId` | Entire snapshot history without pagination |
| GET | `/versions/:pageId/diff?from=1&to=2` | Line-based difference between stored HTML strings |
| POST | `/versions/:pageId/restore` | Copy an old snapshot into a new revision |
| GET / POST | `/comments/page/:pageId`, `/comments/page/:pageId` | Read roots/direct replies / add a comment |
| PUT / DELETE | `/comments/:id` | Author-only edit or deletion |
| POST | `/comments/:id/resolve` | Toggle resolution (comment author or a space member) |
| GET / POST | `/templates`, `/templates` | List global/space templates / create a template |
| GET / DELETE | `/templates/:id` | Read / delete (creator, space admin, or global admin) |
| POST | `/approvals/request`, `/approvals/:id/review` | Request review / approve or reject |
| GET | `/approvals/page/:pageId`, `/approvals/pending` | Page review records plus `canReview` / requests the caller can review or made |
| GET | `/search?q=...&space=ENG&page=1&pageSize=20` | Published pages in viewable spaces, with `slug` and a `degraded` flag |
| GET | `/api/health`, `/api/metrics` | Constant process status / Prometheus exposition |

For example, the page update takes `title`, `contentJson`, `contentHtml`, `contentText`, optional `changeMessage`, and optional `version` (the base it was edited from), returning `{ page }` or 409 `{ error, currentVersion }`. It accepts no mutation ID. Restore takes `versionNumber` and returns `{ version, slug }`.

### Proposed contract changes

Use stable page IDs for navigation and mutation. Save/create/restore return a durable receipt, accepted revision, and canonical URL. Conflicts use a distinct status and include the current head; permission failures and temporary unavailability remain distinct. History returns paginated metadata, with individual snapshots or bounded comparisons fetched on demand.

Search validates scope and pagination, returns safe snippet segments, and distinguishes empty results from degraded or unavailable search. Unknown space keys do not silently broaden the query. Move requests carry hierarchy context; review requests carry the immutable revision and explicit decision state.

## Key Design Decisions

### Full snapshots with optimistic concurrency

A wiki is read frequently and edited in relatively coarse submissions. Full revision snapshots make historical reading and restore independent of a long chain of changes. An expected-version condition catches the common “two tabs editing the same page” problem at the database boundary. An immutable receipt answers whether a particular submission committed.

A distributed character-operation log could support live co-editing, but introduces editor-specific transformation or merge semantics, reconnect history, and additional recovery state. It does not by itself define publication or approval. Start with explicit conflicts because simultaneous live typing is outside scope; accept extra snapshot storage and occasional manual conflict resolution. Add co-editing only when the product needs it.

### Search as a repairable projection

Separate search capacity when the chosen corpus and relevance requirements justify it. Weighted title/body fields, typo handling, and independent search tuning are useful; the cost is a delayed second representation that needs reliable transport, ordering, deletion handling, and rebuilds.

PostgreSQL full-text search is a credible smaller deployment option: it supports lexical processing, ranking, and highlighting. It is inaccurate to dismiss it as incapable of these features. The current fallback does not use those facilities; it performs `ILIKE` substring matches. [PostgreSQL text search controls](https://www.postgresql.org/docs/16/textsearch-controls.html)

Synchronous dual writes cannot make PostgreSQL and Elasticsearch commit atomically. Returning an error after the database committed makes retries ambiguous; ignoring the error silently loses search updates. The outbox makes the obligation durable without waiting for search in the save path. It adds publisher/consumer operations and a lag budget rather than eliminating distributed failure.

### Adjacency lists and bounded hierarchy operations

One parent reference is easy to understand and moves do not rewrite every descendant's stored path. Index child queries by space, parent, and order; fetch navigation metadata on demand. A space-level serialization point makes initial cycle prevention understandable.

Materialized paths speed some ancestry and subtree reads, but moving a large subtree rewrites descendant paths and requires careful concurrent read semantics. Adjacency lists instead pay for recursive traversal and sibling reordering. The choice follows the expected mix of frequent reads, modest depth, and relatively rare moves; it is not a claim that every move costs one constant-time update.

## Consistency and Idempotency

Proposed strong boundaries are per-page revision acceptance, publication transitions, approval decisions, and serialized hierarchy mutations. The database transaction couples authoritative changes, mutation receipts, and outbox obligations. Cache invalidation and search delivery are recoverable consequences, not part of the browser's definition of an accepted save.

The receipt key is scoped to the caller and resource domain, bound to the exact canonical request, and retained for a documented retry window. A changed request needs a new identity. A restore uses the current head as its expected base; it never rewinds the version counter or deletes later history. Unknown commit outcomes are resolved before a replacement request is sent.

Proposed search workers apply monotonically increasing generations. Content revisions alone are insufficient because labels, publication, permissions, and deletion can change search state without a new content snapshot. Rebuilds use a consistent starting point plus subsequent events, and compare generations before switching the read alias. A rebuild must reconcile deletions as well as index existing rows.

## Security / Auth

Production authorization belongs in shared server policies applied to every page-derived read and write, including trees, history, comments, templates, approvals, and search snippets. UI capability flags help presentation but grant nothing. Permission changes and protected writes need a common transactional policy boundary so a revocation race has a defined ordering.

Use secure session cookies over HTTPS, regenerate session identity on login, validate request origin/CSRF protections for mutations, and limit login attempts and expensive reads. Canonical content validation and a safe renderer prevent stored markup from becoming arbitrary browser code. Search highlighting should be escaped text plus controlled mark segments, not trusted HTML from indexed fields.

The local project implements password hashing, session cookies (regenerated on login), Redis-backed rate limiting, space-level authorization in one shared policy module, and server-side HTML sanitization of page bodies. Search highlights are HTML-escaped by Elasticsearch, with only `<mark>` added. It does not implement page-level ACLs, origin/CSRF validation, or secure cookies outside production.

## Observability

Production signals should follow the user contract: acknowledged saves, conflict rate, uncertain outcomes resolved by receipts, publication errors, unauthorized access denials, outbox age, oldest unindexed generation, discarded/repaired jobs, and search visibility lag. Trace a mutation from request through commit, event, index write, and observed search result.

Separate process liveness from dependency readiness. Report search degradation independently from page availability. Bound metric labels and measure fallback latency through completion, not only the failed primary attempt.

Locally, [metrics.ts](./backend/src/services/metrics.ts) exports HTTP duration/count, page-operation count, search duration, and default process metrics. [logger.ts](./backend/src/services/logger.ts) and `pino-http` provide structured logs. There is no configured dashboard, indexing-lag metric, tracing pipeline, or dependency-aware readiness endpoint.

## Failure Handling

| Failure | Proposed behavior | Current implementation |
|---------|-------------------|------------------------|
| Two editors save an old base | One accepted revision; other author receives a conflict with draft retained | With the expected `version` (the editor sends it), the second save gets 409 and keeps its draft on screen |
| Response lost after commit | Resolve/retry the same durable mutation | No receipt; retry may create another revision |
| Cache invalidation fails | Save remains accepted; repair derived state | Logged; the save is reported as successful and the 120 s TTL bounds staleness |
| Broker unavailable | Outbox accumulates; publisher resumes with confirms | Messages buffer in memory (bounded) and flush in order on reconnect; reconciliation repairs a crash |
| Index write fails | Retry transient failures; retain permanent failures for repair | Retried with backoff (8 attempts, ~90 s), then parked on `page-index.dlq` |
| Delayed old index job | Reject lower generation; preserve tombstone ordering | Index writes carry the page version (`external_gte`); an older write is rejected |
| Search unavailable | Bounded authorized fallback or explicit unavailability | Authorized SQL substring fallback with escaped wildcards and `degraded: true`; still unindexed cost |
| Permission authority unavailable | Deny protected reads and writes | Access checks query Postgres; if it fails the request fails (closed) |
| Client changes page during a request | Discard obsolete response; preserve the correct page's draft | Each store load has a ticket; a response for a superseded load is dropped |

## Scalability Considerations

First reduce avoidable payload and database work: navigation should not transfer every page's body, history should not return every snapshot, and queries need bounded page sizes and depth. Add immutable revision caching after establishing permission checks. Measure large-space behavior separately from average pages.

Scale stateless APIs and workers independently, then partition by tenant or space when one database's measured load requires it. Route an editing session's acknowledged read to a source that has reached its revision; a lagging replica must not make the save appear lost. Monitor hot spaces before choosing a partition key that might concentrate them.

Search may use independent shards and replicas in production, but shard counts follow corpus size and benchmarks. The single-shard, zero-replica local index is a development setting. Historical snapshots can move to lower-cost storage only with a tested retrieval and retention policy; database backups alone do not provide user-visible history retention guarantees.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Editing concurrency | Expected revision + explicit conflict | Live operation merge | Matches asynchronous wiki editing without hiding lost updates |
| History | Immutable full snapshots | Delta-only history | Predictable reads and restores at extra storage cost |
| Save/search coupling | Transactional outbox | Synchronous dual write | Durable repair without making search availability gate saves |
| Search deployment | Separate index at assumed scale | PostgreSQL full-text search | Independent relevance/capacity with added operational cost |
| Hierarchy | Adjacency list + serialized validation | Materialized descendant paths | Simple moves and constraints, with recursive read cost |
| Content authority | Validated document model | Independently trusted HTML/text/JSON | Reproducible rendering and indexing from one source |
| Publication | Revision-bound pointer and review | Approval attached only to page | Readers see the content that was actually approved |

## Implementation Notes

### Local topology and setup

[Compose](./docker-compose.yml) contains PostgreSQL 16, Valkey 7 with AOF, Elasticsearch 8.11.0, and RabbitMQ 3 with management and persistent volumes. It contains no app or monitoring containers. [Configuration](./backend/src/config/index.ts) reads `.env` from the process working directory and individual database/Redis fields, fixes the index and queue names, and defaults the API to 3001. The README gives both Compose and native setup with matching credentials.

`npm run dev` starts the API (`dev:api`, port 3001) and the search indexer together with `concurrently`, so search works out of the box. The API tries the queue connection and index setup before listening and keeps reconnecting to RabbitMQ in the background. The worker waits for Elasticsearch and RabbitMQ, uses prefetch 10, and closes its channel on SIGINT/SIGTERM. There is no API shutdown handler. `dev:server2`/`dev:server3` now bind 3002/3003 (they used to call `dev`, which reset the port to 3001). Compilation emits `dist/src/index.js`, while the package's `main` names `dist/index.js` and there is no `start` script.

The seed is partly guarded and partly append/fail, so it is for one fresh application. Its users (alice, a global admin; bob; carol, an Engineering viewer) share the `password123` hash. It includes a private `SEC` space and a draft with a pending approval, so the access rules are visible. Seeded rows are indexed by the indexer's startup reconciliation; no manual index population is needed.

### Authorization (implemented)

[accessService.ts](./backend/src/services/accessService.ts) is the only place that decides what a caller may do. Routes ask it `requireSpace(key|id, caller, 'view'|'edit'|'admin')` or `requirePage(id, caller, need)` and turn its `AccessError` into the response:

| Role in space | View published | View drafts | Edit pages, labels, restore, move | Space settings, members, review approvals |
|---------------|----------------|-------------|-----------------------------------|-------------------------------------------|
| none (public space) | yes | no | no | no |
| none (private space) | 404 | 404 | 404 | 404 |
| viewer | yes | no | no | no |
| member | yes | yes | yes | no |
| admin | yes | yes | yes | yes |

A global admin (`users.role = 'admin'`) is admin of every space. An invisible space or page is a 404, not a 403, so private keys and IDs cannot be probed for existence. The checks cover every page-derived read: trees (drafts filtered per caller from one cached flat list), breadcrumbs (unpublished ancestors hidden from non-editors), history, diffs, comments, labels, approvals, templates and search. Previously any signed-in user could rename or delete any space and add themselves to it as admin, and every page, comment and version was readable by ID.

Comments are open to anyone who can view the page (viewers included). Resolving needs the comment's author or a space member; it used to be open to any signed-in user, for any comment in any space. Replies must target a comment on the same page and attach to the thread root. Global templates are created only by global admins. Login regenerates the session ID and returns `display_name`, the key the frontend reads.

### Revisions, slugs, hierarchy, and content

[pageService.ts](./backend/src/services/pageService.ts) writes the current row and its history snapshot in one transaction, as before. Updates now lock the row (`FOR UPDATE`) and honour an optional expected `version`. The editor sends the version it loaded, so a stale save is a 409 carrying the current version rather than a silent overwrite (or a 500 on the version-uniqueness constraint). Restore ([versionService.ts](./backend/src/services/versionService.ts)) goes through the same post-write path as an edit: cache invalidation, an index message and the metric. It used to leave search and cached reads on the replaced content.

Slugs are unique per space (`title`, `title-2`, ...). Titles with no ASCII letters fall back to `page` instead of an empty slug, and a rename returns the new slug, which the editor navigates to. Slugs still change on rename with no redirect history. Moves validate that the new parent is in the same space and is neither the page nor one of its descendants: a cycle has no path to the root, so the pages in it disappeared from the tree. Moves to and from the root now work; the old `IS NULL` branch referenced a missing SQL parameter. Breadcrumb recursion is capped at depth 50.

Page HTML is sanitized on every write and restore ([htmlSanitizer.ts](./backend/src/services/htmlSanitizer.ts), `sanitize-html`). It keeps headings, lists, tables, code, links, images and the inline styles the macros use, and drops scripts, event handlers, iframes and non-http(s) URLs. Any member could previously store markup that ran in every reader's session, admins included. Rows seeded directly into SQL are not re-sanitized on read.

### Search pipeline

Every committed change ends in `afterPageWrite(spaceId, pageId)`: create, update, delete, restore, approval, and label add or remove (labels are searchable). Space deletion publishes one `delete-space` message, handled with delete-by-query.

[queue.ts](./backend/src/services/queue.ts) publishes on a **confirm channel**, so a message counts as published only once the broker acknowledges it. If the broker is unavailable, or does not confirm, messages are buffered in memory (bounded at 10,000) and flushed in order on reconnect (reconnect retries every 5 s). This was found live: for the first seconds after boot, RabbitMQ was still starting and every index message was dropped. The buffer does not survive a process crash, so it is not an outbox.

[search-indexer.ts](./backend/src/workers/search-indexer.ts) now runs alongside the API (`npm run dev` starts both). It waits for Elasticsearch and RabbitMQ at boot and reconciles the whole index with Postgres at startup and every 10 minutes (`reindexAll`, bulk writes plus deletion of documents for missing pages); that pass is the backstop for anything the queue lost. Per message:
- Failures propagate and are retried with backoff (1, 2, 4, 8, 16, 30, 30 s), then parked on `page-index.dlq` after 8 attempts. The helpers used to swallow errors, so the worker acknowledged failed writes.
- Writes carry the page's version as an external version (`external_gte`), so an older read that finishes late cannot overwrite a newer document. Equal versions are accepted because label changes do not bump the version.
- A page missing from Postgres is removed from the index.

[searchService.ts](./backend/src/services/searchService.ts) searches only published pages in the caller's viewable spaces (a `terms` filter on `space_id`). A `space=` filter narrows that set and never widens it: an unknown or invisible space is a 404, where it used to fall through to a global search. Hits are re-checked against Postgres, so a document whose page was since deleted, unpublished or made unreachable is dropped. Results carry the real `slug` (the UI had been linking with the page ID, so every result opened "Page not found"). Highlights use the `html` encoder, and `page`/`pageSize` are bounded (≤ 50). The SQL fallback (Elasticsearch exception only) applies the same space and status filters, escapes `%`, `_` and `\`, returns an exact `COUNT(*)` total, and sets `degraded: true`. It is still unranked substring matching.

### Caching and instrumentation

[redis.ts](./backend/src/services/redis.ts) supplies 120-second page and slug caches plus one cached flat page list per space; the tree is built per request after filtering. Authorization reads go to Postgres, never the cache, so a status or membership change cannot be judged against a stale row. Invalidation still uses `KEYS` patterns, and concurrent fills can repopulate old content within the TTL. Rate limiting is Redis-backed fixed windows: 500 API requests and 20 authentication attempts per 15 minutes per IP. Health is a constant response; metrics and logs are as before, and the circuit-breaker helper still has no callers.

### Browser implementation

**Routing.** The page and editor routes were unreachable. In TanStack flat routing, `space.$spaceKey.tsx` was the parent of the page route, which was in turn the parent of `/edit`, and neither parent rendered an `<Outlet/>`. Every page URL therefore showed the space overview, confirmed in a browser screenshot. The parents are now `space.$spaceKey.index.tsx` and `space.$spaceKey.page.$slug.index.tsx`, so all three are siblings.

**Store.** [wikiStore.ts](./frontend/src/stores/wikiStore.ts) gives each space, tree and page load a ticket and drops responses for superseded loads; a failed load clears the stale space or page.

**Access-aware UI.** The UI uses the `access` the server returns: Create page, Edit and Request approval appear only for members, viewers see a view-only note, drafts carry a badge, and Approve/Reject appear only when the server says `canReview` and the user is not the requester. Cancelling the review-comment prompt no longer submits a decision.

**Editor and search page.** The editor sends the base `version` and follows the slug the server returns. Search results link by slug and HTML-escape plain-text fallbacks.

**Unchanged.** The editor is still `contentEditable` with no draft recovery, and there is no dirty-navigation guard.

### Simplifications, omissions, and verification limits

The local system uses one database and shared services rather than tenant sharding, replicas, a CDN, multi-region operation, or orchestration. The following remain design proposals in the earlier sections:
- a transactional outbox and mutation receipts;
- a published-revision pointer separate from the authoring head;
- a canonical document model (pages store sanitized HTML);
- page-level ACLs;
- co-editing and draft recovery.

Tests:
- **Mocked backend tests** (30) cover routes, the role matrix and draft visibility ([accessService.test.ts](./backend/src/services/accessService.test.ts)), HTML sanitization, and ordered delivery of buffered queue messages.
- **Live run.** A scripted run against the full stack checks 63 behaviours across four identities (anonymous, the viewer carol, the member bob, the admin alice): visibility of spaces, pages, drafts, versions, comments and approvals; that search never leaks a private space and returns working slugs; role-gated writes, membership changes, revocation and the last-admin guard; version conflicts; sanitization; unique slugs; moves and cycle refusal; self-review, version-bound approval and reindex on publish; reindex on restore and label changes; comment permissions; and index cleanup on space deletion.
- **Outage run.** A second run stops Elasticsearch and confirms the authorized, escaped SQL fallback and that an edit made during the outage reaches the index after recovery.
- **Screenshots** were regenerated, including the formerly unreachable page view, a draft under review, search results, and a viewer's space.

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
┌─────────────────────┐       ┌────────────────────────────┐
│ Browser editor      │──────▶│ Gateway + session auth     │
│ Reader / search     │       └──────────────┬─────────────┘
└─────────────────────┘                      │
                                 ┌───────────┴──────────────────────┐
                                 ▼                                  ▼
                    ┌─────────────────────────┐        ┌─────────────────────────┐
                    │ Wiki API                │        │ Search API              │
                    │ Pages / policy          │◀───────│ Candidate checks        │
                    └────────────┬────────────┘        └────────────┬────────────┘
                                 │                                  │
                                 ▼                                  ▼
                    ┌─────────────────────────┐        ┌─────────────────────────┐
                    │ PostgreSQL              │        │ Search index            │
                    │ Revisions / outbox      │        │ Derived documents       │
                    └────────────┬────────────┘        └────────────▲────────────┘
                                 │                                  │
                                 ▼                                  │
                    ┌─────────────────────────┐        ┌────────────┴────────────┐
                    │ Outbox publisher        │───────▶│ Queue + indexers        │
                    └─────────────────────────┘        └─────────────────────────┘
```

A CDN serves versioned application assets. Redis can hold sessions and reusable revision payloads; neither decides the authoritative revision or access policy. The logical Wiki and Search APIs may begin in one deployable application. Separating every feature into a service would add transactions and failure modes without improving the initial workload.

## Core Components / Request Flows

### Read a page

Resolve the stable page ID and evaluate current read permission and publication policy. Select an immutable revision, then fetch that payload from cache or PostgreSQL. Return the page ID, revision, canonical URL, breadcrumbs, and permitted actions. Fetch small navigation metadata separately from the document body.

Cache keys include the immutable revision and rendering format version. A cache hit never bypasses authorization. If the access authority is unavailable, private reads fail closed. A page whose latest authoring revision differs from its published revision still presents the approved published content to ordinary readers.

The local implementation instead resolves mutable, non-unique slugs, caches entire current page rows for 120 seconds, and does not enforce space read permissions.

### Save an edit

1. The client submits page identity, expected base revision, content, and a mutation ID tied to this exact request.
2. The API validates the canonical document schema and derives safe HTML and plain text. It checks write permission within the transaction's policy boundary.
3. A transaction checks for an existing mutation receipt, conditionally advances the page head from the expected revision, inserts the immutable snapshot, and writes the receipt and outbox event.
4. A base mismatch produces a conflict with current revision metadata. A matching receipt returns the original outcome; reuse with another payload is rejected.
5. After commit, the response identifies the accepted revision. The browser retains any additional typing performed while the request was in flight.
6. Indexing proceeds asynchronously. It does not determine whether the save succeeded.

A receipt is needed for create and restore as well as edit. A timeout after commit is an unknown result, not evidence that no revision exists. A client retries the same immutable request or queries its receipt before submitting a new mutation.

The local transaction inserts a page revision, but it has neither the expected-base condition nor a receipt/outbox. Its cache invalidation can fail after commit and turn a successful database write into an HTTP error.

### Publish or approve

Keep an authoring head and a published revision pointer. A direct publication, where permitted, advances that pointer in an authorized transaction. An approval request names one immutable revision; reviewing it does not implicitly approve later edits. Publication validates the request's state, reviewer authority, and target revision, then writes its event atomically.

An approval can remain a useful historical decision even when the author has moved on. Product policy determines whether an older approved revision can be published; the UI must name it explicitly. Publication changes are searchable state changes even when the content revision number stays the same.

The prototype defaults new pages to `published`. Approval records name only a page, and approval publishes whatever content that page currently contains.

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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

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

The current slug index is non-unique. Parent and homepage foreign keys do not establish same-space membership. Page version uniqueness prevents duplicate version numbers, but it is not a stale-editor check. There is no mutation receipt, outbox, search-generation, or approval-version column today.

## API Design

### Current routes

Business routes below use `/api/v1`; health and metrics use the absolute paths shown. Unless stated otherwise, reads are public and mutations check login only. These are existing endpoints, not a claim that their authorization is sufficient.

| Method | Path | Actual purpose |
|--------|------|----------------|
| POST | `/auth/register`, `/auth/login` | Create an account or establish a session |
| POST / GET | `/auth/logout`, `/auth/me` | End session / return authenticated user |
| GET / POST | `/spaces` | List public spaces / create space and creator membership |
| GET / PUT / DELETE | `/spaces/:key` | Read, update, or delete a space |
| GET / POST | `/spaces/:key/members` | Read members including email / upsert membership |
| GET | `/pages/recent` | Twenty recently updated published pages |
| GET | `/pages/space/:spaceKey/tree` | Server-built nested tree containing complete page rows |
| GET | `/pages/space/:spaceKey/slug/:slug`, `/pages/:id` | Page with original author, labels, and breadcrumbs |
| POST / PUT / DELETE | `/pages`, `/pages/:id`, `/pages/:id` | Create, save a new revision, or hard-delete |
| POST | `/pages/:id/move` | Change parent and sibling positions; root cases currently fail |
| GET / POST / DELETE | `/pages/:id/labels`, `/pages/:id/labels`, `/pages/:id/labels/:label` | List, add, or remove labels |
| GET | `/versions/:pageId` | Entire snapshot history without pagination |
| GET | `/versions/:pageId/diff?from=1&to=2` | Line-based difference between stored HTML strings |
| POST | `/versions/:pageId/restore` | Copy an old snapshot into a new revision |
| GET / POST | `/comments/page/:pageId`, `/comments/page/:pageId` | Read roots/direct replies / add a comment |
| PUT / DELETE | `/comments/:id` | Author-only edit or deletion |
| POST | `/comments/:id/resolve` | Toggle resolution for any logged-in caller |
| GET / POST | `/templates`, `/templates` | List global/space templates / create a template |
| GET / DELETE | `/templates/:id` | Read / delete a template |
| POST | `/approvals/request`, `/approvals/:id/review` | Request review / approve or reject |
| GET | `/approvals/page/:pageId`, `/approvals/pending` | Public page review records / all pending records for a logged-in user |
| GET | `/search?q=...&space=ENG&page=1&pageSize=20` | Published-content search; no membership filter |
| GET | `/api/health`, `/api/metrics` | Constant process status / Prometheus exposition |

For example, the current page update takes `title`, `contentJson`, `contentHtml`, `contentText`, and optional `changeMessage`, returning `{ page }`. It accepts neither an expected revision nor a mutation ID. Restore takes `versionNumber` and returns a message, so clients must fetch the new page themselves.

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

The local project implements password hashing, session cookies, login checks, and Redis-backed rate limiting. It does not implement this full authorization or rendering boundary. `requireAdmin` is defined but unused; global and space role fields are not evidence that access is enforced.

## Observability

Production signals should follow the user contract: acknowledged saves, conflict rate, uncertain outcomes resolved by receipts, publication errors, unauthorized access denials, outbox age, oldest unindexed generation, discarded/repaired jobs, and search visibility lag. Trace a mutation from request through commit, event, index write, and observed search result.

Separate process liveness from dependency readiness. Report search degradation independently from page availability. Bound metric labels and measure fallback latency through completion, not only the failed primary attempt.

Locally, [metrics.ts](./backend/src/services/metrics.ts) exports HTTP duration/count, page-operation count, search duration, and default process metrics. [logger.ts](./backend/src/services/logger.ts) and `pino-http` provide structured logs. There is no configured dashboard, indexing-lag metric, tracing pipeline, or dependency-aware readiness endpoint.

## Failure Handling

| Failure | Proposed behavior | Current implementation |
|---------|-------------------|------------------------|
| Two editors save an old base | One accepted revision; other author receives a conflict with draft retained | Sequential stale saves overwrite; overlapping saves can hit version uniqueness and return 500 |
| Response lost after commit | Resolve/retry the same durable mutation | No receipt; retry may create another revision |
| Cache invalidation fails | Save remains accepted; repair derived state | Failure after commit can propagate as HTTP failure |
| Broker unavailable | Outbox accumulates; publisher resumes with confirms | Publication skipped or errors logged and swallowed |
| Index write fails | Retry transient failures; retain permanent failures for repair | Helper swallows errors and worker acknowledges |
| Delayed old index job | Reject lower generation; preserve tombstone ordering | Unversioned writes can regress or resurrect content |
| Search unavailable | Bounded authorized fallback or explicit unavailability | Unbounded-cost SQL substring fallback on ES exception; may also fail |
| Permission authority unavailable | Deny protected reads and writes | Space authorization is absent |
| Client changes page during a request | Discard obsolete response; preserve the correct page's draft | Shared state permits stale responses to replace current context |

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

The API awaits queue connection and index setup before listening; helpers catch failures, but their network attempts can still delay startup. There is no API shutdown handler. The worker connects separately, uses prefetch 10, and has a SIGINT queue-close path, not a complete drain of all resources. Queue reconnect/resubscription is absent. The `dev:server2` and `dev:server3` wrappers are overridden by `dev`'s hardcoded port 3001; the README supplies direct commands. Compilation emits `dist/src/index.js`, while the package's `main` names `dist/index.js` and there is no `start` script.

The seed is partly guarded and partly append/fail, so it is for one fresh application. Its users' bcrypt hash was checked with the installed library against `password123`; it has cost 10, while registration uses cost 12. No seed event or automatic index rebuild exists. The README's direct one-time population command addresses a fresh local index only.

### Transaction and history patterns actually implemented

[pageService.ts](./backend/src/services/pageService.ts) stores current page content and a full historical snapshot in the same SQL transaction. This is a useful durability pattern: the current revision and its history record commit together. The core sequence is:

```text
BEGIN → read current row → update current content/version
      → insert snapshot → COMMIT → invalidate cache → publish index message
```

The initial read is not locked and the update has no expected-version condition. Two transactions that both read version 3 can attempt version 4; one may fail the unique history constraint and roll back. A later request with old content can instead read version 4 and successfully overwrite it as version 5. Neither behavior implements an intentional conflict response. Cache errors after `COMMIT` enter the catch block; `ROLLBACK` cannot undo the already committed write. There is no request receipt to disambiguate that HTTP failure.

[versionService.ts](./backend/src/services/versionService.ts) restores an old snapshot into a new numbered revision and computes `diffLines` over HTML. Restore does not invalidate page/tree caches, publish an indexing message, or record the page-operation metric. Its slug normalization also differs from normal saves. History downloads all complete snapshots. This is neither a compact metadata endpoint nor a semantic rich-text diff.

### Hierarchy, labels, and deletion

The tree query retrieves all page columns and statuses, then builds nested nodes on the server. Redis caches that full result. Breadcrumbs use recursive SQL without a visited-node or depth guard. Parents can cross spaces, and cycles can disappear from root-based trees or cause unbounded breadcrumb recursion.

For moves involving a root parent, SQL still references `$3` while the argument array has only two entries. Other move paths have no cycle/same-space validation or shared hierarchy lock and can update many sibling positions. The page lookup inside the move uses the pool/cache outside the transaction client. The frontend has no move request or drag interface.

Deleting a page sets children's parent references to null and cascades dependent records, but does not invalidate each child's cached row. Deleting a space bypasses page cache and search deletion publication entirely. Slugs are non-unique, strip non-ASCII characters, change on rename, and have no redirect history. Label changes invalidate a page-ID cache but do not enqueue reindexing.

### Queue and search behavior

[queue.ts](./backend/src/services/queue.ts) declares a durable queue and marks messages persistent. This demonstrates broker persistence settings, but uses an ordinary channel without publisher confirms and ignores the backpressure return value. Missing-channel and publish errors are swallowed. No outbox, reconnection loop, delayed retry queue, or dead-letter route is configured.

[search-indexer.ts](./backend/src/workers/search-indexer.ts) may process up to ten outstanding deliveries. [searchService.ts](./backend/src/services/searchService.ts) fetches current page data and labels, then sends an unversioned index write. Fetching current data does not enforce order: an earlier read can finish its index write after a later one. The helpers catch database/index errors and return normally, so the worker acknowledges failed effects. Unexpected handler errors are negatively acknowledged without requeue; no configured dead-letter destination retains them. A missing source page during indexing does not remove an older search document.

Create/update/delete attempt queue events; restore, approval, label changes, and space deletion omit relevant events. The index can therefore remain wrong indefinitely. Search boosts title and labels, requests HTML highlights, filters `published`, and optionally filters space. It does not check membership or current publication state. Unknown space keys become global searches. Page and size inputs lack positive bounds. The response has page IDs but no slug, while the UI treats the ID as a slug.

SQL fallback runs only after an Elasticsearch exception. It matches the entire supplied string as an `ILIKE` substring, retains wildcard semantics for `%` and `_`, orders by update time, and reports the returned page's row count as `total`. It is not PostgreSQL full-text search, an exact total, or equivalent relevance. The search timer ends before fallback; a healthy empty index does not cause fallback. The UI receives no degraded-mode flag.

### Authentication, caching, and instrumentation actually wired

[auth.ts](./backend/src/middleware/auth.ts) requires a session for protected mutation routes, and comment edits/deletes check author identity. Space roles and global admin role are otherwise largely unused; direct reads expose private/draft material, and logged-in callers can mutate other spaces or review their own requests through the API. Session cookies are HttpOnly and SameSite=Lax but always `secure: false`; login does not regenerate the session. Login returns `displayName` while the frontend expects `display_name`.

[redis.ts](./backend/src/services/redis.ts) supplies 120-second page/slug/tree caches. Cache failures propagate rather than providing a general fail-open cache layer. Invalidation uses `KEYS` patterns, and concurrent fills can repopulate old content. [rateLimiter.ts](./backend/src/services/rateLimiter.ts) uses Redis-backed fixed windows: 500 API requests and 20 authentication attempts per 15 minutes per IP key. Store errors fail through the error path; this is not a sliding-window or fail-open limiter.

In [app.ts](./backend/src/app.ts), session and API limiter middleware run before HTTP metric collection, including on health/metrics paths. Health returns constant status, not dependency checks. HTTP labels can merge router-local paths or retain unmatched request paths. Page-operation metrics cover only instrumented service paths. Pino provides request/service logs, but does not establish full asynchronous mutation tracing. [circuitBreaker.ts](./backend/src/services/circuitBreaker.ts) defines a factory that has no callers; it does not protect database or search operations.

### Browser implementation and incomplete features

The generated [route tree](./frontend/src/routeTree.gen.ts) makes the page route a child of the space route and the editor a child of the page route. The two parent components lack an `Outlet`. Nested children need an outlet to render, so the current structure blocks page viewing/editing through normal URLs. This finding is based on source and generated routing, not a browser reproduction. [TanStack Router outlets](https://tanstack.com/router/latest/docs/guide/outlets)

[wikiStore.ts](./frontend/src/stores/wikiStore.ts) has one shared loading/error/current-page context. Fetches lack cancellation or context checks; old responses can overwrite another page or space, and failures can retain old content or an indefinite loading view. Logout does not clear wiki state. Editor initialization can copy stale shared content. Rename saves navigate to the previous slug, and in-flight save completion can navigate away from later typing.

[PageEditor.tsx](./frontend/src/components/PageEditor.tsx) uses `contentEditable`, `execCommand`, and HTML replacement during renders, with no explicit selection/IME preservation. Saves are manual and send empty structured JSON alongside HTML/text. There is no dirty-navigation guard, autosave, local draft recovery, or server HTML sanitization. [PageViewer.tsx](./frontend/src/components/PageViewer.tsx) and search results insert raw HTML. These are source-level rendering risks, not browser exploit tests.

[TemplatePicker.tsx](./frontend/src/components/TemplatePicker.tsx) is not wired into a route. [MacroRenderer.tsx](./frontend/src/components/MacroRenderer.tsx) supports simple JSON callouts/code and a table-of-contents placeholder; the editor emits separate HTML callouts. The backend macro helper has no route callers. There is no generated, linked table of contents or syntax-highlighting pipeline.

Version comparison is a unified colored display of HTML-line changes, not side-by-side semantic comparison. Restore refreshes history without refreshing the current page/tree. Comments and approval components have unguarded asynchronous state updates and limited pending-state protection; only roots and direct replies are returned, although the schema permits deeper/cross-page parents. Approval requests can race into duplicates; a conditional pending-state update prevents two successful decisions on one row, but does not authorize the reviewer or bind a version. Approving can publish a current draft or archived page without history, cache, or index updates. Cancelling the review comment prompt still submits a decision in the browser component.

### Simplifications, omissions, and verification limits

The local system uses one database and shared services rather than tenant sharding, replicas, a CDN, multi-region operation, or orchestration. Production outbox/receipts, enforced permissions, canonical safe rendering, revision-bound publication, reliable reindexing, co-editing, and draft recovery are not implemented. They are design proposals in the earlier sections.

The mocked backend tests cover basic health/auth/space/recent-page routes. Existing browser smoke tests depend on `main` selectors absent from current layouts. This documentation review inspected source, configuration, generated routes, and tests, and checked the seed hash in isolation. It did not run builds, the Docker stack, browser interactions, real SQL races, or queue recovery tests. Application code remains unchanged.

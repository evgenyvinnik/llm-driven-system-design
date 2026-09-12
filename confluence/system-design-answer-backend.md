# Design a team wiki — backend interview

## 🎯 Establish the contract — 3 minutes

> “I would build a wiki around durable page revisions, explicit space permissions, and
> search that can be rebuilt from the database. The most important distinction is that
> accepting an edit and making it searchable are separate events.”

Users organize pages into spaces, browse a hierarchy, edit content, inspect history,
restore a revision, comment, and search. Some spaces require approval before
publication. I would clarify that live character-level co-editing is outside this
interview: we use whole-document saves with conflict detection.

A successful save must not silently overwrite a newer edit. Approval must refer to the
content actually reviewed. Search may be briefly stale, but it must not expose content
the caller is no longer allowed to read.

I would start with one relational authority and a few logical modules. Splitting
comments, versions, permissions, and pages across independent databases would turn
ordinary wiki actions into distributed transactions before we have a scaling reason.

This answer describes a proposed production design. The repository's Express/PostgreSQL
implementation illustrates parts of it, but does not yet enforce several of these
contracts.

| Discussion | Time |
|------------|------|
| Scope and guarantees | 3 min |
| Scale, architecture, and data model | 7 min |
| Deep dive: revision acceptance and publication | 11 min |
| Deep dive: reliable and authorized search | 11 min |
| Deep dive: hierarchy and stable identity | 7 min |
| Failure handling, scaling, and verification | 6 min |
| Total | 45 min |

## 🏗️ Scale, architecture, and data model — 7 minutes

Assume one million daily active users and 20 million pages. Forty million reads per day
is about 463 per second on average; I would initially plan for a 5,000-per-second peak.
Half a million accepted edits per day is only about six per second on average, with a
proposed peak budget of 100.

At 40 KB per canonical snapshot, current content is roughly 800 GB. New snapshots add
about 20 GB per day before compression. Rendered HTML, extracted text, indexes,
replicas, and backups increase storage, so history retention deserves a policy, but
these numbers do not force us into a custom distributed database.

I would propose 99.9% availability and p95 targets of 200 ms for page reads and 500 ms
for saves and search under the agreed workload. Searchable changes should normally
appear within five seconds. These are design targets to test, not measured results from
the learning project.

```
┌──────────────┐        ┌─────────────────────────┐
│ Browser      │───────▶│ Wiki / search API       │
└──────────────┘        │ Session + permission    │
                        └────────────┬────────────┘
                                     │
                 ┌───────────────────┴─────────────┐
                 ▼                                 ▼
     ┌───────────────────────┐         ┌───────────────────────┐
     │ PostgreSQL            │         │ Search index          │
     │ Pages / revisions     │         │ Derived results       │
     │ Receipts / outbox     │         └───────────▲───────────┘
     └───────────┬───────────┘                     │
                 │                                 │
                 ▼                                 │
     ┌───────────────────────┐         ┌───────────┴───────────┐
     │ Outbox publisher      │────────▶│ Queue / indexers      │
     └───────────────────────┘         └───────────────────────┘
```

Redis supports sessions and cached immutable content. It is not the source of truth for
a page's current revision. A CDN serves application assets; protected page responses
still pass through an authorization boundary.

### Main records and access patterns

| Record | Important fields | Main access pattern |
|--------|------------------|---------------------|
| User and space membership | User ID, space ID, role | Current permission for a resource |
| Space | ID, key, name, policy, hierarchy generation | Resolve a space and coordinate tree changes |
| Page | ID, space, parent, order, head revision, published revision | Open a page; list children |
| Revision | Page ID, revision number, canonical content, author, timestamp | Read immutable content or compare selected versions |
| Mutation receipt | Scoped mutation ID, request digest, result | Resolve retries and uncertain commit outcomes |
| Outbox event | Event ID, page ID, search generation, payload | Deliver derived-state changes reliably |
| Comment | Page, author, parent, body, resolution state | Read a bounded discussion thread |
| Approval | Page, target revision, requester, reviewer, status | Review an identifiable revision |
| Label and template | Space/page association, validated data | Filter content or initialize a document |

The most important indexes follow these accesses: children by space/parent/order,
revisions by page and descending version, memberships by space/user, and pending outbox
work by delivery state and sequence. Full page content does not belong in a tree
metadata query.

### API surface

I would keep the whiteboard API list small and discuss the contracts behind it.

| Method | Proposed endpoint | Contract |
|--------|-------------------|----------|
| GET | `/pages/:id` | Authorized revision and canonical URL |
| POST | `/spaces/:id/pages` | Identified create request with initial revision |
| PUT | `/pages/:id` | Save only against the expected head |
| GET | `/pages/:id/versions` | Paginated history metadata |
| POST | `/pages/:id/restore` | New revision from an older snapshot |
| POST | `/pages/:id/move` | Validated hierarchy change |
| POST | `/pages/:id/reviews` | Request review of a specific revision |
| GET | `/search` | Authorized results and explicit search status |

The local project uses `/api/v1` routes with somewhat different paths. This proposed
list is about resource contracts, not a route-by-route transcription.

## 🔧 Deep dive 1: accept revisions without losing updates — 11 minutes

### One transaction defines an accepted save

> “I would choose immutable full snapshots and optimistic concurrency. The request names
> the revision the author edited, and the database conditionally advances that head. If
> it changed, we return a conflict rather than inventing a merge the user did not ask
> for.”

Alice and Bob both open revision 8. Bob saves and creates revision 9. Alice submits
content based on 8. A conditional update against 8 cannot succeed, so Alice receives the
current head and keeps her draft for reconciliation.

The transaction does more than increment a number. It checks the caller's current write
authority, reserves or resolves the request identity, advances the expected head,
inserts the immutable snapshot, and records the indexing obligation and receipt. If any
required part fails, none of that save commits.

Permission changes must have a defined ordering with protected writes. I would use a
shared transactional policy boundary initially, so a completed revocation cannot be
bypassed by a later save using an old membership cache. The exact lock granularity can
evolve after measuring contention.

### Version uniqueness is necessary but insufficient

A unique page/version key prevents two history records from sharing a number. It does
not establish that the author edited the latest revision. If an old draft arrives after
another transaction completed, the server can read the new number and still overwrite
the content unless the request supplied an expected base.

Likewise, selecting a row and then updating it in a transaction is not automatically an
optimistic concurrency protocol. The comparison must participate in the write's database
condition or an equivalent serialized check. Otherwise overlapping requests may fail
through incidental constraints rather than a meaningful conflict response.

A conflict is a normal product outcome. Return enough metadata to fetch the current
revision, but avoid automatically returning a large private snapshot before
authorization. The client can show the base, draft, and current content in a deliberate
reconciliation flow.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Full snapshots with expected revision | Simple historical reads; explicit conflict semantics | Extra storage and occasional manual reconciliation |
| ❌ Unconditional last write wins | Minimal save protocol | Quietly destroys a concurrent author's changes |
| ❌ Live operation merge initially | Supports simultaneous typing | Adds editor-specific merge and reconnect protocols beyond scope |

For a wiki where most edits are independent and submissions are relatively infrequent,
snapshot storage is an acceptable cost. Delta-only history reduces repeated content but
makes old reads and restore dependent on applying a chain correctly. Compression or
archival can come later without changing the visible revision contract.

### Give retries their own durable identity

Suppose the database commits revision 9, then the connection drops before Alice receives
the response. A timeout is ambiguous. If she retries as a new save, the system may
produce revision 10 with identical content and a misleading extra history entry.

The original request carries a mutation ID scoped to its actor and resource domain, plus
a canonical payload digest. A committed receipt stores its accepted revision and
response. Retrying the same ID and payload returns that outcome; the same ID with
different content is rejected.

The receipt must commit with the page revision. Putting it only in a short-lived Redis
cache reintroduces ambiguity after eviction or a crash between the two writes. Redis can
accelerate lookup, but the database remains the authority.

We also need a retention contract. Within the retry window, the original receipt is
available. After it expires, the server cannot promise that an arbitrary ancient retry
is new work; clients need an explicit recovery path rather than silently replaying it.

Creates, restores, and publication actions need the same reasoning. A unique
page/version number does not deduplicate a repeated create that generates a different
page ID. A restore should copy the requested historical content into a new revision
against the current expected head.

### Bind publication and approval to immutable content

A page has an authoring head and a published revision pointer. Saving draft revision 10
does not change the version ordinary readers see. A direct publication or successful
review changes the pointer in an authorized transaction and writes its own event.

An approval request names revision 10. If the author creates revision 11 while review is
pending, approving the request does not implicitly approve 11. The reviewer can publish
the reviewed version if policy permits, or require a new request for the changed
content.

A conditional pending-to-approved transition prevents two reviewers from completing the
same request twice. A unique active-request key prevents concurrent duplicate requests.
Neither constraint replaces reviewer authorization or the revision binding.

This model gives up a single convenient “current version” field everywhere. In return,
it can answer a critical question: which exact content did a reviewer approve, and which
content can a reader see? For a knowledge base with approval requirements, that
precision is worth the extra state.

## 🔧 Deep dive 2: make search repairable and permission-aware — 11 minutes

### Choose a search deployment for the workload

At a smaller scale, I would seriously consider PostgreSQL full-text search. It supports
lexical processing, ranking, and highlighting; a separate cluster is not a prerequisite
for useful wiki search. A substring fallback should not be confused with that
capability. [PostgreSQL text search
controls](https://www.postgresql.org/docs/16/textsearch-controls.html)

For the assumed corpus and independent search load, I would choose a separate search
index. It lets us tune title/body relevance and typo handling without competing directly
with revision transactions. The cost is operating and repairing a second representation
of the data.

> “I would not make a page save synchronously depend on Elasticsearch. If the database
> commits and search fails, returning an error cannot undo the saved page. I would
> commit a durable indexing obligation beside the revision instead.”

### Close the database-to-queue gap

The outbox is a table written in the same transaction as the authoritative change. A
publisher sends pending events and marks delivery only after broker confirmation. If it
crashes after sending but before recording delivery, it sends again; duplicates are
expected.

The consumer acknowledges a delivery only after the index effect succeeds or a newer
accepted generation makes it obsolete. Transient errors retry with bounded backoff.
Permanent malformed events enter a repair path, and the oldest outstanding event age
alerts us before the freshness target is missed for long.

A durable queue and a persistent-message flag help broker survival, but they do not make
an unconfirmed publication reliable or prevent a consumer from acknowledging a failed
effect. Each boundary needs an explicit success condition.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Outbox plus repeatable index effects | Database acceptance survives broker outages; changes are repairable | Publisher, retries, lag monitoring, and reconciliation |
| ❌ Synchronous database/index dual write | Appears simple in the happy path | Partial success creates ambiguous saves and inconsistent search |
| ❌ Best-effort queue after commit | Low save latency | A crash or skipped publish can lose an update indefinitely |

### Prevent old work from overwriting new work

An event includes a monotonic search generation and one consistent state representation.
That generation advances for content, labels, publication, and deletion. Content
revision alone is insufficient because a label or publication pointer can change without
a new text snapshot.

Suppose job 20 reads an old title, then stalls. Job 21 indexes the new title. When job
20 resumes, an unconditional write would put the old title back. Fetching the database
when each job starts does not remove this race.

The index accepts only a higher generation. Elasticsearch external versioning provides
that comparison; the consumer still needs to distinguish an obsolete/duplicate
generation from a real failure and ensure that one generation identifies only one
payload. [Elasticsearch Index
API](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/docs-index_.html)

Deletion needs the same ordering rule. Keep a versioned tombstone without the old
searchable body until the supported replay and rebuild windows cannot deliver older
content. Simply removing the document and forgetting its generation can allow a delayed
old index job to recreate it.

A rebuild starts from a consistent database snapshot and catches up subsequent changes.
It compares generations and reconciles deletions before switching the read alias. A
script that only indexes all existing pages is useful for a fresh demo, but is not a
complete live rebuild protocol.

### Keep stale search from becoming an authorization leak

The index narrows candidates by space and publication metadata. Before sending a title
or snippet, the search API checks current permission and the allowed published revision
against authoritative state. A stale index must not return an old private title merely
because React later hides the link.

Batch these checks and bound overfetching. When filtering removes candidates, the raw
index total is not an exact count of authorized results. Prefer an honest continuation
response over leaking a private hit count or running an unlimited scan to fill one page.

If the indexed revision no longer matches the published revision, rebuild the result
from currently permitted content or omit it. A permission check on the page ID alone is
insufficient if the index contains a draft that this reader may not see.

This adds database work to search. We can cache immutable revision payloads, but current
authorization and publication still need a coherent freshness contract. During a
permission-service failure, return unavailability for protected results rather than
trusting stale permission data.

### Degrade within an explicit budget

An Elasticsearch outage need not stop direct page reads. A bounded PostgreSQL search
fallback may be acceptable for selected scopes, with reduced relevance and a visible
degraded status. It needs query timeouts, concurrency limits, and a plan to protect the
write database.

Sending every failed search into an unrestricted SQL scan can turn a search outage into
a page-save outage. For an expensive query or overloaded database, explicit search
unavailability is the correct response. The product should retain navigation and known
links.

Measure freshness from database commit to search visibility, including publication
delay, queue wait, worker time, and refresh. A broker queue depth of zero does not prove
the index contains the latest published content.

## 🔧 Deep dive 3: hierarchy correctness and stable links — 7 minutes

### Choose adjacency lists for a movable wiki tree

> “I would store each page's parent and sibling order, then query children by space and
> parent. Pages move often enough that I would avoid putting their entire ancestor path
> into their identity.”

A stable UUID identifies the page. Human-readable slugs are hints or aliases, with
collision handling and redirects. Renaming or moving a page should not change the target
of a bookmarked link or require rewriting every comment and search reference.

For ordinary browsing, query only child metadata and fetch more as the user expands
branches. A page body is separate. Breadcrumbs use bounded ancestry traversal, and a
deep-link response helps the browser reveal the selected path.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Adjacency list | Simple parent relation; moves avoid rewriting descendant paths | Recursive ancestry/subtree queries and explicit cycle prevention |
| ❌ Materialized ancestor path initially | Efficient prefix/subtree reads | Large moves rewrite descendants and complicate concurrent changes |
| ❌ Nested-set numbering initially | Efficient subtree ranges | Inserts and moves can renumber substantial portions of a space |

Adjacency lists do not make every move constant-time. Sibling positions may need
updates, ancestry must be checked, and caches must learn the new hierarchy generation.
The benefit is a manageable representation for the expected mix of reads and occasional
moves.

### Serialize the mutations that protect the invariant

In a transaction, lock the space's hierarchy coordination row, validate source and
destination membership, reject self/descendant parents, and update the parent and
ordering. Every create, move, and delete that changes hierarchy participates in the same
protocol.

Without a shared boundary, two requests can each pass a cycle check and then create a
cycle together. Locking only the source page does not necessarily protect the
relationship being tested. The simple space-level lock makes the first design easier to
reason about.

It also serializes unrelated moves in the same space. I accept that initially because
moves are much rarer than reads. If a hot space proves this is a bottleneck, we can
introduce finer locks with a defined ordering and repeat the concurrent-cycle tests
before deploying them.

A same-space foreign-key strategy prevents cross-space parent references, while the
transaction enforces acyclicity. Limit hierarchy depth and request size. For deletion,
define whether children become roots, are reparented, or are deleted; do not leave that
product behavior implicit in a database cascade.

The resulting event invalidates or advances navigation metadata and breadcrumbs.
Immutable page content need not be rewritten just because the parent changed. If
permissions inherit through the hierarchy, the move also changes authorization scope and
requires a stronger policy update protocol; I would keep initial permissions at the
space level to avoid that expansion.

## 🛠️ Failure handling, scaling, and verification — 6 minutes

### Read path and caching

Authorize the request, select the permitted revision, and fetch an immutable payload by
page/revision/rendering version. A cache hit speeds the body read but never decides
current permission or publication. After an acknowledged save, direct reads must reach a
source that has observed the accepted revision.

A lagging replica can make a correct save appear to disappear. Route that read to the
primary or use a revision-aware wait/fallback policy. Reads of an explicitly older
immutable revision can use a replica or cache without that ambiguity.

The first scaling work is usually removing overfetching: full page bodies in tree
responses, full snapshots in history lists, and unbounded search inputs. Then scale API
and index workers independently. Partition by tenant or space only after measured
database limits justify it, accounting for unusually large spaces.

### Operational signals and recovery exercises

| Signal or exercise | What it tells us |
|--------------------|------------------|
| Save acknowledgements versus committed receipts | Whether uncertain requests are resolved consistently |
| Conflict rate by workspace size | Whether explicit conflicts still match user behavior |
| Oldest outbox event and index visibility lag | Whether derived state is meeting the freshness contract |
| Retry and repair-queue age | Whether failures are recoverable rather than silently discarded |
| Authorized search checks and rejection counts | Whether index candidates still match current access/publication |
| Database restore and index rebuild drill | Whether recovery procedures work beyond the happy path |

Keep liveness and readiness distinct. Search degradation should be visible without
declaring every page unreadable. Logs carry mutation, page, revision, and event
identities, while metrics avoid arbitrary page IDs as labels.

I would test two simultaneous saves, a stale sequential save, response loss after
commit, approval after another edit, label-only indexing, delayed deletion jobs,
broker/worker restarts, and concurrent moves that could form a cycle. A test that only
asserts HTTP 200 on health cannot establish these properties.

### Trade-offs to defend

| Decision | Benefit | Cost accepted |
|----------|---------|---------------|
| Relational revision transaction | Clear acceptance and history boundary | One authority for a page's writes |
| Durable mutation receipt | Safe resolution of ambiguous retries | Storage and a retention contract |
| Revision-bound publication | Review corresponds to actual content | Separate authoring and reader state |
| Asynchronous search projection | Independent search availability/capacity | Lag, retries, tombstones, and rebuild operations |
| Space-level hierarchy serialization | Understandable cycle prevention | Concurrent moves in one space wait |

### Relationship to the local project

The local code stores page snapshots transactionally, but updates have no expected-base
condition or mutation receipt. Cache failures after commit can surface as save errors.
Approval targets only a page and can publish later content without cache or search
updates.

Its ordinary RabbitMQ publisher is best effort, and index helpers swallow failures
before worker acknowledgement. Some mutations never publish events. Tree queries return
full content, moves involving roots have a parameter-count defect, and membership is not
enforced on page reads/writes. The SQL fallback is substring matching, not full-text
search.

Those findings explain why the production design adds these boundaries; they are not
claims that the local demo already has them.
[architecture.md](./architecture.md#implementation-notes) traces the actual source and
verification limits.

# Facebook Post Search — Backend System Design Answer

A 45-minute interview proposal. I use the local project's search ideas, while
distinguishing production guarantees from what its source currently implements.

## 🎯 Requirements and Scale — 4 minutes

> “The hard part is not finding text. It is finding relevant posts without disclosing content the viewer can no longer read, even while the index and social graph are changing.”

I would start with keyword, exact-phrase, and hashtag search over posts, plus
date/type/author filters. Public search can be anonymous; accepted friends and an author's
private posts require viewer context. Friends-of-friends and custom groups can be later
extensions.

I would clarify when a privacy change takes effect. My contract is that new responses
validated after a completed revocation use the current policy. Indexing can lag, but that
lag cannot authorize old private content. Already delivered bytes cannot be recalled.

| Requirement | Proposed target or contract |
|-------------|-----------------------------|
| Search latency | Healthy-path p95 below 300 ms, p99 below one second |
| Availability | 99.9% regional search serving |
| Index freshness | Ordinary accepted changes searchable within 10 seconds |
| Privacy | Current authoritative access before returning content |
| Pagination | Bounded stable search session with explicit expiry |
| Writes | Accepted operations survive retries and index outages |

For an example workload, assume 100 million daily searchers making five submissions each:
500 million searches per day, about 5,787 per second average and 28,935 at a
five-times-average peak. Suggestions are separate traffic and can outnumber submissions
several times over.

At 100 million new posts per day and 1 KB raw searchable records, the raw growth is 100 GB
per day, or 182.5 TB over five years. Actual indexed storage includes postings, stored
fields, replicas, and merge space. These are sizing assumptions, not Facebook's
measurements or a benchmark of this repository.

## 🏗️ Architecture and Records — 5 minutes

```
┌────────────────────────────┐       ┌────────────────────────────┐
│ Search API + auth          │       │ Post / graph authority     │
│ Rank / current validation  │       │ SQL + receipts + outbox    │
└─────────────┬──────────────┘       └─────────────┬──────────────┘
              ▼                                    ▼
┌────────────────────────────┐       ┌────────────────────────────┐
│ ES retrieval projection    │◀──────│ Versioned index workers    │
│ PIT + visibility tokens    │       │ Bulk / retries / repair    │
└────────────────────────────┘       └────────────────────────────┘
```

The source database owns post content, audience, revisions, relationships, and operation
results. An asynchronous pipeline maintains Elasticsearch as a retrieval projection. Redis
caches graph-derived token sets and explicitly scoped suggestion data.

Search serving combines efficient index filtering with a bounded current authorization
check. The goal is to avoid scoring millions of irrelevant candidates while refusing to
treat stale copied ACLs as final authority.

| Record | Key fields / invariant | Access pattern |
|--------|------------------------|----------------|
| Post | ID, author, content, audience, revision, tombstone | Current hydration and updates |
| Relationship | User pair, accepted state, revision | Viewer friends and reverse lookup |
| Operation receipt | Actor/key unique, payload digest, result | Resolve retried creation/update |
| Outbox event | Post ID and revision, publication progress | Recover index work after a crash |
| Search document | Post/revision, text, author, audience tokens, rank fields | Retrieval and sorting |
| Search session | Viewer, fixed query/ranking context, PIT, expiry | Stable continuation |

I would start with PostgreSQL for the transactional authority. Large deployments can
partition source records and relationship access paths, but sharding by user does not make
both directions of the graph local automatically.

Elasticsearch supplies inverted-index retrieval and text ranking. Redis is a disposable
accelerator when reconstruction and authorization fallback are explicitly defined. A
dependency is not disposable merely because its product category is “cache.”

I would draw only these boundaries initially. A separate ML service, graph database, or
thousand-shard layout needs workload evidence; it should not appear just to make the
diagram look larger.

## 🔍 Deep Dive 1: Fast Retrieval Without Stale Authorization — 10 minutes

### Stable audience tokens reduce write amplification

For a friends post, store FRIENDS:author in the index. A viewer supplies that token for
each accepted friend, plus tokens for public and their own private content. The query can
intersect those tokens with text matches inside Elasticsearch.

If the author gains a friend, the post's token remains the same. The viewer's eligible
token set changes. This avoids storing and rewriting every recipient ID in every
historical post document.

Changing the post itself from public to private is different: its copied audience fields
must change. Conflating these two changes leads either to unnecessary mass reindexing or
to missed privacy updates.

| Approach | Strength | Cost/failure |
|----------|----------|--------------|
| ✅ Stable audience tokens | Small post-side audience representation | Viewer token list and graph freshness |
| ❌ Per-post recipient arrays | Simple membership filter | Friendship changes rewrite many documents |
| ✅ Current batch validation | Handles stale index and cache copies | Additional bounded source/graph reads |
| ❌ Index ACL as sole authority | Cheapest serving path | Failed restrictions/deletions can disclose content |

Token filtering is not O(1) for an arbitrary graph. A viewer with thousands of friends
sends a larger set; posting-list intersections, term lookup, candidate density, and shard
fan-out all affect cost. Measure those distributions.

A Bloom filter can help reject obvious nonmatches, but false positives cannot grant
access. If introduced, it is a preliminary approximation followed by an exact decision,
not a replacement privacy mechanism.

### Why I still validate after retrieval

Consider a public post changed to private. SQL commits, but the index update fails. The
old document still matches anonymous searches. A perfect filter over stale data returns
the wrong answer.

Retrieve a bounded candidate batch, then check current records and accepted relationships
in batches. Require the indexed content revision to match the canonical revision before
exposing the indexed snippet. Otherwise an old snippet can disclose text the author
removed even if the current post is still public.

The final check does not mean retrieving every matching document and issuing a SQL query
for each. It is a small batch at the response boundary, after efficient coarse filtering
has already removed most unsuitable candidates.

If many candidates fail, scan forward with an explicit work budget. A short page with a
continuation or partial-work indication is more honest than an unbounded loop trying to
fill exactly twenty slots.

The continuation must advance through the last examined candidate, including rejected
rows. Advancing only through displayed rows can repeatedly revisit the same inaccessible
boundary.

### Counts and suggestions are also disclosures

An Elasticsearch total computed before current validation is not necessarily the number of
readable posts. A facet or suggested hashtag can reveal a hidden topic even when the
result card is removed.

I would omit exact totals initially and return verified loaded counts plus continuation.
Any later total/facet feature needs the same authorization semantics and a stated
approximation or snapshot boundary.

Shared suggestions should come from a public-safe dictionary or corpus. Personal history
remains viewer-scoped. Directory suggestions use the directory's policy rather than
inheriting whatever user happened to populate a prefix cache first.

Global trends require a deliberate publication policy. Repeated page requests are not
independent user interest, and raw queries may contain private information. A time window
and distinct-user threshold help reduce noise and accidental disclosure, but they do not
alone prove privacy.

### The availability trade-off

If the authoritative privacy dependency is unavailable, I fail protected searches closed
or offer an explicit narrower public mode backed by current trustworthy data. Silently
removing the filter to preserve availability changes the product's security contract.

Newly granted content may be absent until indexing/token refresh catches up. That is a
visible freshness cost, not a reason to tolerate stale revocations. I would make grant lag
and authorization drops separately observable.

> “I use the index to decide what is worth checking. I use current authority to decide what may leave the service. That extra boundary is worth the latency because stale privacy is not an acceptable relevance error.”

## 🔍 Deep Dive 2: Durable Indexing and Safe Rebuilds — 10 minutes

### Acceptance must survive the index being down

A sequential SQL insert followed by an Elasticsearch write has two commits. If the second
operation fails, either the API reports failure after saving a post or it reports success
without durable repair work.

I would commit the post mutation, actor-scoped operation receipt, and outbox event
together. The response confirms the canonical operation; it does not claim that every
search node can already retrieve it.

1. Authenticate and validate the actor's operation and requested audience.
2. Resolve the operation ID against its request digest.
3. Commit source state, monotonic revision, receipt, and outbox work.
4. Return the canonical result.
5. Let workers apply the projection and report index progress separately.

A lost HTTP response is resolved by retrying the same operation. A new UUID generated by
the server for every retry does not deduplicate creation; it simply makes every duplicate
row have a valid unique key.

### Delivery duplication and event reordering are different

Using the post ID as the ES document ID prevents multiple index documents for the same
source post. It does not stop revision 8 from arriving after revision 9 and overwriting a
newer restriction.

The worker applies a monotonic version check. A stale or duplicate event is a no-op after
confirming which source revision is current. Poison records need a visible repair path
instead of retrying forever and blocking unrelated work.

Deletes need retained version state too. If physical deletion removes the only record of
revision 10, a delayed revision 9 can recreate the document. Keep a tombstone or
equivalent durable high-water mark for the supported replay horizon, and define safe
compaction separately.

A post-partitioned stream helps ordering, but it does not eliminate retries, manual
reindex races, or cross-pipeline writes. Revision enforcement belongs at the projection
boundary as well.

### Bulk transport is not batch correctness

Index in bounded batches to reduce round trips and refresh overhead. A successful bulk
HTTP response can contain failed individual items, so inspect every result and retry only
the affected work according to error class.

Do not acknowledge an entire event batch merely because the request returned 200. Keep
enough durable progress to recover after a worker dies between partial success and its
checkpoint.

Refresh is a search-visibility mechanism. Forcing a refresh per write can improve
immediate local testing but costs indexing throughput. Waiting for a refresh does not
bound upstream queue lag or guarantee one second under every configuration.

| Choice | Why it fits | Trade-off |
|--------|-------------|-----------|
| ✅ Transactional outbox and receipt | Saved operation and repair work survive together | Relay/worker operations and storage |
| ✅ Versioned idempotent projection | Retries cannot regress newer state | Revision/tombstone lifecycle |
| ❌ Inline SQL then ES as one implied transaction | Small happy-path implementation | Ambiguous saved-but-failed outcomes |
| ❌ Ignore bulk item status | Easy success reporting | Missing/rejected documents remain invisible |

### Reindexing is a migration, not just a loop

For a new mapping/analyzer, build a new index generation. Backfill from a defined source
boundary, then replay changes and tombstones through a catch-up point. Validate counts,
sampled content/revisions, and representative searches before switching the read alias.

An alias swap is useful because readers move together, but it does not capture writes that
happened during backfill. That requires the change stream/outbox boundary and replay
procedure.

Existing PITs may refer to the old generation. Retain it for a bounded overlap or expire
those sessions explicitly. Deleting it immediately after the swap can break readers midway
through a search.

A bulk upsert of all current SQL rows cannot remove orphaned ES documents whose source
rows were deleted. Reconciliation must compare absence/tombstones as well as overwrite
rows that still exist.

> “I am not promising exactly-once transport. I am making duplicate and delayed delivery harmless, and making accepted work recoverable. Those are the invariants the user actually depends on.”

## 🔍 Deep Dive 3: Ranking and Pagination Share a Contract — 9 minutes

### Start with an understandable relevance baseline

Use analyzed text for prose and exact keyword fields for hashtags/IDs/audience tokens.
Define phrase syntax explicitly. Fuzzy matching can tolerate typos, but it does not make
ordinary keyword queries exact-phrase searches.

The local implementation uses BM25 field boosts and friend/self should clauses within the
same ES query. Those clauses add score contributions; they are not a universal
multiplication of the entire score by two or three.

Engagement is a secondary sort: likes + twice comments + three times shares. It matters
after equal relevance, followed by creation time. There is no time decay or application
reranker in the demo.

For a production baseline, I would measure text relevance first, then calibrate social and
engagement features with judged queries. An old viral post should not win merely because
raw counts are large. Scores are not probabilities and are not directly comparable across
different viewers' queries.

A later reranker can use richer features over a bounded overfetched window. It cannot
promote a relevant post absent from that window, and reranking each independent page does
not create a coherent global order.

### Why an offset string is not enough

Offset paging skips a number of current hits. If refreshed results move between page
requests, items can repeat or disappear. A cursor containing score and ID fixes tie
ordering only; it does not freeze moving scores or changing query context.

For the first in-engine ranking design, I would use a short-lived PIT with search_after.
Keep the query, sort, social ranking context, and any time-based scoring reference fixed
for that session. Bind its opaque cursor to the viewer and contract version.

The server retains the latest PIT identifier and uses the complete returned sort tuple,
including its tie-breaker. A changed filter or ranking context starts a new session.
Expiry yields an explicit reset, not a best-effort reinterpretation of the old cursor.

Permissions remain current. Keep the retrieval context fixed, validate each candidate
against current authority, and expire the session if a graph-context change requires a new
query. Stability cannot mean preserving permission to old private text.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Bounded PIT/search_after session | Stable index view and continuation | Retained index resources and expiry |
| ❌ Offset over refreshed results | Simple shallow-page implementation | Deep-page work and shifting boundaries |
| ❌ ID tie-breaker without fixed context | Deterministic equal-score order | Does not prevent score/index movement |
| ✅ Frozen reranked window if ML is added | Coherent application order | Candidate/window storage and limited horizon |

### What breaks first at scale

Broad queries and long friend lists can dominate search CPU. Time partitioning helps
queries with date bounds, but a query across five years still fans out across many shards.
Replicas spread read load and provide redundancy; they do not erase the number of logical
shards a broad query must visit.

Shard sizing depends on recovery speed, storage expansion, and query distribution. A fixed
thousand-shard recommendation without measurements can create excessive coordination
overhead on a small corpus.

Limit open PITs and their lifetimes. An abandoned search should not retain old segments
indefinitely. Client cancellation and explicit session close help, but expiry is still
required when the browser disappears.

## 🧪 Operations and Failure Tests — 5 minutes

| Interface | Contract |
|-----------|----------|
| POST /api/v1/search | Query/filters, viewer context from auth, bounded page request |
| Search continuation | Same session/query context and opaque cursor |
| Suggestions | Explicit scope/type and safe publication policy |
| Post mutation | Durable operation result plus index-progress distinction |
| Admin rebuild | Observable job/generation status, not an optimistic input count |

Runtime validation must reject malformed enum arrays, invalid dates, oversized queries,
and negative/noninteger limits before constructing ES queries. Shared types alone cannot
validate network data.

A breaker should protect capacity and allow recovery probes. The timeout must also be
connected to underlying cancellation or concurrency bounds; returning early while every
old search continues can still exhaust the dependency.

Useful failure tests include:

1. SQL commits a privacy restriction while ES is unavailable: no old content is returned.
2. A worker dies after partial bulk success: missing items retry without regressing versions.
3. An old event arrives after deletion: it cannot resurrect the post.
4. A friendship is revoked while a PIT remains open: current validation denies the result.
5. A new index catches up during live writes: alias switch preserves acknowledged changes.
6. The breaker cooldown expires: a bounded probe can actually execute.

Observe source-to-search lag, item failures, revision mismatch, authorization drops,
partial results, query fan-out, and PIT resources. Search latency and browser first-result
latency are different measurements.

Search logs and history themselves need a retention/access policy. Ordinary telemetry
should avoid raw private terms; hashing a predictable phrase does not make it anonymous.
Administrative inspection should be explicit and auditable.

## 📝 Close and Local Boundary — 2 minutes

> “My design uses exact tokens to narrow retrieval, current authority to protect disclosure, and a versioned asynchronous projection to keep indexing recoverable. A bounded search session connects ranking with predictable pagination.”

The local app implements one ES query with social boosts, cached visibility sets,
synchronous indexing, bearer sessions, and a Cockatiel wrapper. It has no outbox, creation
receipt, revision guard, PIT, or authoritative result hydration.

Create/update can commit SQL then fail indexing; deletion swallows index errors, and
reindex ignores bulk item failures/orphan documents. Search and health pre-checks can
prevent breaker recovery. Suggestions, author lists, detail, feed, and likes do not share
one privacy rule.

The [architecture](./architecture.md#implementation-notes) records these findings against
source. The [README](./README.md) distinguishes fixtures and setup. The review used
isolated source checks; no full-stack or load benchmark established the targets above.

# GitHub — backend system design interview

This is a 45-minute proposal for a GitHub-inspired code-hosting backend. I would use one
diagram and three deep dives: Git storage ownership, recoverable pull request merges, and
permission-aware code search. The local project is a teaching prototype; the guarantees
below require more than its current Express routes and local bare repositories.

## 🎯 Requirements and assumptions — 3 minutes

> “I will design a system where developers can store Git history, review a change, and publish an approved merge without losing track of what happened after a failure.”

The initial scope is repositories, authenticated Git fetch/push over Smart HTTP, web
browsing of files, issues, pull requests, and default-branch code search. Repository
permissions apply to code, collaboration metadata, and search results. I will start with
same-repository pull requests and merge commits.

Squash/rebase, fork pull requests, SSH transport, and webhook delivery are extensions. A
CI execution platform, browser editor, and semantic code intelligence would each consume
the interview by themselves, so I would leave them outside the core design.

The non-negotiable invariants are that an acknowledged ref update points to durable
objects, a merge publishes the admitted code or reports a conflict, and a stale search
index cannot grant access to private content. Search freshness and star counts can
tolerate lag; shared branch history cannot be guessed after a timeout.

| Assumption | Approximate implication |
|------------|-------------------------|
| 200M repositories at 150 MB mean packed size | 30 PB primary storage, before replication/backups |
| 100M API/browser reads per day | 1,157/s average; about 11,574/s at an assumed 10× peak |
| 10M pushes/day at 1 MB mean new objects | 116/s average and 10 TB/day ingress |
| 1B indexed files at 10 KB mean text | 10 TB raw text; index overhead requires measurement |

These are illustrative workload assumptions. Repository size and activity are skewed, so
average requests per second will not size a worker pool correctly. I would separately
measure pack generation, merge CPU, object bytes, and the hottest repository.

I would target 99.9% metadata-read availability, p95 metadata latency below 200 ms, and
search below 500 ms within an agreed region. Clone latency scales with transfer size.
Durability is defined against a stated replica failure model and backed by restore drills,
not an unconditional “zero data loss” promise.

## 🏗️ Architecture and authority — 5 minutes

```
┌─────────────────────────────┐     ┌──────────────────────────────────────┐
│ Browser / Git transport     │────▶│ Git storage authority                │
│ Auth + repository routing   │     │ Objects / refs / operation journal   │
└─────────────────────────────┘     └──────────────────────────────────────┘
               │                                       │
               ▼                                       ▼
┌─────────────────────────────┐     ┌──────────────────────────────────────┐
│ Collaboration API + SQL     │────▶│ Event processing                     │
│ PRs / intents / receipts    │     │ Reconcile / index / notify           │
└─────────────────────────────┘     └──────────────────────────────────────┘
```

The gateway authenticates the caller and routes by stable repository identity. The
collaboration API owns relational entities such as issues, review records, and merge
intents. The storage service owns immutable Git objects, authoritative ref publication,
and a durable operation history.

These are different authorities. A SQL transaction can atomically save an issue and its
request receipt. It cannot roll back a Git ref that was pushed to another service. That
boundary is why a merge needs a recoverable protocol, which I will explain in the second
deep dive.

Redis caches short-lived metadata and derived immutable artifacts. Search consumes durable
changes and builds an inverted index. Neither cache nor search becomes the authority for
repository permission or the outcome of a code publication.

| Data | Authoritative representation | Important index or identity |
|------|------------------------------|-----------------------------|
| Repository | SQL metadata and access/lifecycle revision | Stable ID; unique owner namespace/name |
| Git content | Immutable object graph | Object ID within a controlled repository/object pool |
| Branch | Storage authority's current ref state | Repository + ref, with conditional update |
| Issue/PR | SQL row and shared repository-number registry | Repository + number |
| Review | Decision and anchors for a comparison | PR + exact comparison/head |
| Merge operation | SQL intent plus storage publication receipt | Scoped client key and storage operation ID |
| Search document | Derived file content and indexed revision | Repository + path + generation/version |

For browsing, resolve a branch to a commit once and return that commit with related
directory/file results. For reviews, identify the base, head, merge base, and diff
options. Stable identities make cache behavior explainable and prevent a response from
quietly describing a different revision.

I would use SQL tables for users, repositories, memberships, issues, PRs, reviews, and
comments. Reviews and permissions have relational invariants and transactions. Git objects
stay in their native representation behind a dedicated service, because storing file text
alone would throw away the history and object connectivity the product needs.

The initial deployment can combine logical services in a few processes while preserving
these boundaries. Splitting every route into a microservice would not solve the hard
consistency problem and would add deployment overhead before there is evidence it helps.

## 🔧 Deep Dive 1: Store immutable objects and coordinate mutable refs — 9 minutes

### What Git gives us

Git represents file contents as blobs, directories as trees, history as commits, and
annotated tags as objects. Objects are content-addressed. A commit describes a snapshot
through its tree and parent links; it does not require copying every unchanged file into a
new independent database row.

Pack files group and often delta-compress objects for storage and transfer. I would use
native Git tooling for these semantics rather than implement pack parsing, history
traversal, and merges from scratch. Pack generation still consumes CPU and I/O,
particularly for large histories and clients with different existing objects.

Identical content can reuse an object inside the same object database. Independent
repositories do not automatically store a single global copy. A fork object pool can share
storage, but then retention and deletion must account for every repository that still
reaches an object.

Object identity is also not authorization. Knowing a hash must not let a caller retrieve
private objects from an unrelated repository. The storage API checks that the caller can
access the repository and that the requested object is reachable under the allowed
retention policy.

### A push has a publication point

A transport gateway receives a bounded pack into quarantine. Before publishing refs, the
service verifies object integrity, graph connectivity, allowed ref updates, and resource
budgets. It must not execute arbitrary hooks or source code supplied by the repository
during these checks.

Objects are durable before any acknowledged ref points at them. If a failure leaves unused
uploaded objects, they can be garbage-collected later. The opposite ordering is dangerous:
publishing the ref first can leave an acknowledged branch pointing to missing history
after a crash.

A repository has one fenced writer. Every push and merge goes through it. A new owner can
take over only after the previous owner is fenced and the durable command history is
recovered. An expired lease in a database is insufficient if the old process can still
write directly to the shared filesystem.

The writer accepts an expected old object ID with a proposed new one. If the ref moved,
the command fails and the client must reconcile. This is a conditional update, not an
unconditional last-writer-wins assignment that could erase another developer's push.

For a multi-ref operation, the service needs an explicitly defined atomic acceptance
contract. Native filesystem primitives help implement it, but a distributed service must
also manage fencing, replication, and recovery. I would not claim that a shared network
folder or a Redis lock alone provides all of those guarantees.

### Durable command history and retries

The storage boundary durably records an accepted operation, its ref preconditions,
publication result, and operation ID in the same authoritative state transition.
Filesystem refs are materialized behind that boundary. Recovery uses this history to
restore them and answer retries; arbitrary writes outside the service are prohibited.

A storage acknowledgement requires the configured replication policy to be satisfied for
the objects and authoritative publication record. For example, a three-replica design can
acknowledge after a quorum under its documented failure model. Independent backups still
protect against operator error or correlated loss that replication faithfully copies.

During a partition, the side without safe writer ownership stops accepting mutations. It
may serve permitted immutable reads at an identified revision. That sacrifices some write
availability to preserve branch history, which is appropriate for code publication.

| Approach | Why it works or fails here |
|----------|----------------------------|
| ✅ Native Git objects with a fenced publication authority | Retains Git semantics while controlling mutation and recovery |
| ❌ Independent writers on a shared directory | File access alone does not prevent stale owners from mutating refs |
| ❌ SQL rows containing only latest file text | Loses Git graph/transport semantics and creates expensive reinvention |

### Scaling the storage path

I would shard repository placement through a lookup map and isolate particularly large
repositories. Hashing helps spread ordinary load, but a single hot repository remains hot.
A placement map lets operations move it or give it dedicated capacity without changing its
identity.

Immutable objects and computed artifacts can be replicated or cached for reads. The small
mutable ref state retains one authority. This makes read scaling easier than write scaling
and avoids imposing a global ordering requirement across unrelated repositories.

Bound concurrent Git jobs by both account and repository. Cap pack bytes, decompressed
object size, process time, output bytes, and temporary workspace. Separate interactive
browsing from expensive merges and indexing so one large job does not starve every
directory read.

The trade-off is operational complexity: placement, fencing, recovery, and backup
coordination need monitoring. At small scale, a single storage node may be a useful first
implementation, but its failure and durability limitations should be explicit rather than
hidden behind a production diagram.

## 🔧 Deep Dive 2: Merge the reviewed code and recover partial completion — 11 minutes

### Start from what the reviewer approved

> “An approval is about a particular change. If the head branch moves, the approval must not silently transfer to code the reviewer never saw.”

A comparison has immutable base/head/merge-base IDs and a diff version. Reviews and inline
comments reference it. Required review policy checks the admitted head and applicable
policy revision. Historic comments remain readable after a force push, with outdated
anchors shown as such.

The merge request supplies the expected PR revision, head, base, strategy, and a stable
client operation key. The server checks current maintain permission and policy before
accepting the operation. This decision point is explicit: later revocation stops new
requests but does not retroactively undo an already accepted publication.

The API durably stores a merge intent and reserves the PR against incompatible close or
duplicate-merge changes. It can return a pending operation identifier. A response should
not claim a successful merge simply because a worker started or a SQL row was marked
`merged` early.

### Build first, publish conditionally

A worker computes a candidate commit from the admitted immutable inputs. I would initially
support a merge commit and require both branch tips to remain the expected values at
publication. More permissive rebasing onto a moving base is a separate product decision
because it changes the candidate the user intended to publish.

The candidate and referenced objects become durable before publication. The storage writer
verifies head and base together and conditionally advances the base to the candidate. It
records the operation result as part of its durable publication command.

Concurrent requests for the same base may compute candidates in parallel, but only one can
publish against a given old base. The loser returns a conflict or enters a separately
authorized new attempt. It cannot overwrite the winner or reuse old review assumptions
against a newly computed tree.

An ordinary non-force push provides useful Git protection, but it does not necessarily
express the application's exact expected base or review policy. The platform must make
those preconditions part of its own storage command. Calling Git through a library does
not supply the missing business invariant.

### The Git/SQL gap is recoverable, not magically atomic

After publication, the coordinator updates SQL with the result and merged commit, releases
the reservation, and adds an outbox event. That final SQL transaction can fail even though
code publication succeeded. The operation therefore remains pending until reconciled.

| Failure point | Durable evidence | Recovery |
|---------------|------------------|----------|
| Before intent acceptance | No accepted operation | A new request may be submitted |
| After intent, before candidate | Pending intent | Resume bounded work under the same operation |
| After candidate, before publication | Candidate plus pending intent | Recheck refs and attempt the same conditional command |
| After publication, before SQL update | Storage receipt | Reconcile SQL without recomputing/publishing again |
| After SQL commit, before HTTP response | Final receipt/result | Return the original result for the same client key |

The storage receipt is essential. Looking only at the branch's current tip is insufficient
because somebody may have pushed again after our merge. Even if the branch no longer
equals our candidate, the durable receipt can establish that our operation published
successfully at its recorded sequence.

Conversely, absence of a SQL `merged` state is not proof that Git remained unchanged.
Retrying a squash or rebase from scratch could create a different commit. The client
should query the existing operation until its result is known, not generate a new merge
request after every transport timeout.

Pending candidates and receipt records need a retention policy. Do not garbage-collect
objects referenced by unresolved operations. Keep storage evidence through reconciliation
and the supported recovery/backup window, and define what an expired client receipt means.
Cleanup is part of correctness, not only disk housekeeping.

### Request deduplication and numbering

For SQL-only operations such as issue creation, a transaction atomically claims a key
scoped to actor, repository, and operation type. A payload digest detects accidental key
reuse for a different request. The mutation, result receipt, and outbox event commit
together.

Concurrent callers cannot both run the mutation and merely ignore a conflicting receipt
insert. The claim happens before the side effect, with a unique constraint and a defined
wait/pending response. A retry returns the same resource identity even when the original
HTTP response was lost.

Issues and pull requests share a number namespace. I would use a locked per-repository
counter and a shared unique number registry in the same transaction. Reading maxima from
two independent tables permits concurrent creators to choose the same number, even if each
table separately has a unique constraint.

There is contention on that counter, but issue/PR creation per repository is generally
much less frequent than reads. It is simpler than inventing a distributed number
allocator. If a measured hotspot exceeds its capacity, the product must decide whether
gaps or a different identifier format are acceptable.

### Why not one large transaction?

Keeping a SQL transaction open while cloning and merging does not make Git writes part of
it. It only holds database resources during potentially slow filesystem work. A rollback
after a push still cannot undo the published ref safely, especially if later commits
depend on it.

I would use short transactions around admission and completion, plus durable work outside
them. That adds a pending state, a recovery worker, and alerts for old unresolved intents.
The user may briefly see reconciliation lag, but the system can explain and recover its
outcome.

| Choice | Benefit | Cost |
|--------|---------|------|
| ✅ Durable intent and storage-side publication receipt | Resolves crashes and lost responses across the Git/SQL boundary | More states, retention, and reconciliation |
| ❌ Push Git then assume the SQL update always succeeds | Straight-line code | Can publish code while leaving the PR open and retryable |
| ❌ Pretend a SQL transaction covers Git | Familiar transaction syntax | Holds locks without adding cross-store atomicity |

## 🔧 Deep Dive 3: Search derived code without leaking stale access — 8 minutes

### Index a revision, not “whatever HEAD means now”

Search is a projection of Git history. A durable ref event carries repository identity,
sequence/generation, and before/after commits. A worker computes affected paths from those
immutable inputs and indexes eligible files with their commit identity.

The worker checks file type and byte limits before expensive decoding or parsing. A
filename extension alone cannot prove that a blob is safe text. Extremely long lines,
generated files, and unsupported encodings get explicit limits or exclusions.

For the first version, an inverted index with identifier-aware tokens supports content
queries and filters. I would test examples such as a camelCase name, underscore-separated
identifier, and punctuation-heavy expression. Token-filter ordering matters: lowercasing
before case splitting destroys the case boundaries we wanted to use.

Symbol search can begin with a limited parser or clearly labeled heuristics. Regex
extraction misses language syntax and is not a semantic reference graph. I would not
promise accurate cross-reference navigation just because the index has a field named
`symbols`.

### Handle deletion and out-of-order work

Events are delivered at least once. The worker records its repository position and applies
writes with sequence/generation guards. A late event must not overwrite a newer file or
recreate content after deletion. Removed paths need tombstones or an equivalent manifest
reconciliation policy.

A default-branch change may require rebuilding that repository's search view. During
catch-up, different documents can temporarily identify different commits. Each result must
identify its own revision; the system should not claim a whole target revision is indexed
until all relevant changes and removals have been applied.

For a global rebuild, populate a new index generation from a known source position,
consume changes that arrived during the rebuild, and only then switch the query alias.
Keep the old generation briefly for rollback. Copying today's files while ignoring
concurrent pushes would start the new index already stale.

### Current access is checked at retrieval

Repository permission can change faster than search indexing. If a public repository
becomes private, the old index document may still say it is public. Using that document
alone to authorize a snippet would disclose code during the lag window.

I would apply access filters in the candidate query and then verify current repository
permission before returning paths, snippets, or other sensitive fields. The second check
protects against stale membership/visibility data. If that authority is unavailable,
private results fail closed rather than relying on stale access hints.

Counts and aggregations need the same care. Hiding a private result while returning a
global exact hit count can still reveal its existence. Either compute counts within the
permitted scope or omit/qualify them. The client cannot repair a leak that has already
occurred in the response.

| Approach | Consequence for this product |
|----------|------------------------------|
| ✅ Derived index with current permission checks | Fast search with explicit freshness and access boundaries |
| ❌ Use indexed visibility as final authorization | Public-to-private changes can expose stale snippets |
| ❌ Scan every Git repository for each query | Avoids an index pipeline but creates unacceptable I/O and latency at this corpus size |

### Result and pagination contracts

A hit returns repository, path, indexed commit, safe snippet text, and match ranges. Its
link opens the indexed commit, not today's `main`. This lets a developer inspect the code
that actually matched, even when the branch has moved since indexing.

For deeper pagination I would use a bounded search context and stable cursor. It preserves
the chosen ranking snapshot while current permission checks still apply. If the context
expires, the API asks the client to restart; it does not promise a permanent frozen result
set.

The trade-off of a separate search system is operational work: event delivery, versioned
updates, index sizing, backfills, and privacy hydration. At smaller scale, relational
full-text indexing of prepared code tokens may be sufficient. The decision depends on the
corpus and query workload, not a claim that SQL is categorically incapable of code search.

## 🔌 APIs and secondary workflows — 4 minutes

I would keep the initial API small and make the important identities explicit:

| Method | Proposed endpoint | Contract |
|--------|-------------------|----------|
| GET | `/repos/:id/tree` | Commit and directory cursor; bounded children |
| GET | `/repos/:id/blob` | Commit/path, encoding, bytes and truncation status |
| GET | `/repos/:id/pulls/:number/comparison` | Explicit comparison revision and file summary |
| POST | `/repos/:id/pulls/:number/reviews` | Comparison-bound review and scoped request key |
| POST | `/repos/:id/pulls/:number/merge` | Expected inputs; pending operation or conflict |
| GET | `/operations/:id` | Authorized recovery of the original result |
| GET | `/search/code` | Permitted snippets, indexed revisions, bounded cursor |

These are proposed contracts; the local routes use a different owner/name `/api` layout. I
would avoid discussing every CRUD field on the whiteboard. The interviewer should be able
to follow the code revision and operation identity across the whole request.

Issue comments can use the ordinary SQL receipt transaction. Stars use a desired-state
membership operation, not a retried toggle. Counts are updated only for actual membership
changes or projected asynchronously with reconciliation. This is a smaller consistency
problem than a Git merge.

If webhooks are required, SQL outbox events and storage events feed durable delivery jobs.
A delivery ID remains stable across retries, and receivers deduplicate it. Sign payload
bytes, limit destination concurrency and response size, validate destinations, and retry
transient failures with bounded backoff. A successful send followed by a lost
acknowledgement still creates possible duplicate delivery.

I would not block code publication on an external webhook destination. Failed deliveries
get a visible history and bounded retry policy. Slow consumers can lag while the durable
event log retains enough data for replay, within an explicitly configured retention
window.

## 🧪 Failure handling and validation — 3 minutes

The most valuable tests interrupt the system at its state boundaries. Kill a merge worker
after storage publication but before SQL completion, then verify that recovery reports the
original commit without publishing again. Move the base or head between candidate
computation and publication and verify a conflict.

Run simultaneous same-key issue requests and simultaneous issue/PR number allocation.
Change repository visibility while search results are cached. Deliver old index events
after deletion. These tests exercise the claimed invariants; a successful homepage
response cannot establish them.

Operationally, I would watch Git admission queues, pending merge age, failed conditional
ref updates, storage/SQL reconciliation lag, index lag, permission-filtered candidates,
and restore results. A timeout must be distinguished from a confirmed failure before
publication. Resource metrics should avoid unbounded repository labels.

The local implementation supplies useful examples but not these guarantees: its merge is
followed by a separate SQL update, its creation-key lookup happens before the transaction,
and its search indexer has no automatic caller. Several Git helpers turn failures into
empty results, so even a breaker success counter can hide a broken read.

## ⚖️ Decisions and closing — 2 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Ref authority | ✅ Fenced repository writer | ❌ Independent shared-folder writers | Prevent conflicting publication |
| Merge recovery | ✅ Intent plus durable storage receipt | ❌ Blind retry after timeout | Preserve the original operation outcome |
| Review identity | ✅ Exact comparison and policy at admission | ❌ Approval attached only to a moving branch | Prevent approval of unseen code |
| Search | ✅ Versioned projection with current access checks | ❌ Index freshness as authorization | Keep lag from disclosing private code |

> “The hard part is not storing a patch or adding a review row. It is preserving the relationship between the code somebody reviewed, the branch update the system accepted, and the result it can prove after a crash.”

That is where I would spend the whiteboard time. Packfile byte layouts, framework
configuration, and a full CI architecture can wait for focused follow-up questions.
[architecture.md](./architecture.md) records the exact local schema and implementation
gaps; [README.md](./README.md) explains setup.

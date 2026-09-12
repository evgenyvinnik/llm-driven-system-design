# App Store — backend system design interview

> “I would treat the catalog as the authority for what is published, search as a
> derived discovery view, and a release as approved metadata bound to immutable
> bytes. Those boundaries let the store grow without making stale search results
> or repeated messages into business decisions.”

This is a proposed design for a 45-minute interview. I would use one diagram and
three deep dives. The local implementation is a smaller teaching system; its
working boundaries and defects are called out at the end.

| Discussion | Minutes |
|------------|---------|
| Requirements and scale | 5 |
| Architecture, data model, and API | 8 |
| Deep dive: discovery and search consistency | 9 |
| Deep dive: review trust and rating effects | 9 |
| Deep dive: publication and artifact delivery | 9 |
| Failure handling and scaling priorities | 3 |
| Trade-offs and local implementation boundary | 2 |
| Total | 45 |

## 🎯 Requirements and scale

I would begin by agreeing on the store's scope.
Users discover apps, read reviews, and request access to a release.
Developers create listings, upload artifacts, submit revisions, and publish approved
releases. We also need to withdraw an unsafe release and correct abusive reviews.

I will keep payment processing and native installation outside this answer.
If the store sells apps, the download-access service asks an entitlement authority
whether the caller may obtain the release. I would not improvise a payment ledger
inside a catalog discussion.

The important invariants are:

- Publication refers to the exact metadata and artifact that were approved.
- Draft or withdrawn state cannot authorize a new release download.
- An account has one current review per app, with revisioned edits.
- Only the current published review contributes to public ratings.
- Retrying a committed operation must not create a second business effect.

Some data can be eventually consistent. A newly published app may take a minute
to appear in search, and a rating badge may trail a recent review.
That is acceptable if detail/access checks remain authoritative and the lag is visible.

### Planning assumptions

Assume 10 million daily users, 20 catalog/detail reads and 5 searches per user.
That gives about 2,315 catalog reads/s and 579 searches/s on average.
A 10× peak suggests roughly 23,000 and 5,800 requests/s.
These are sizing assumptions, not measurements from the repository.

A million apps at 10 KB of searchable metadata is roughly 10 GB of source text,
before index overhead, replicas, and images. One million daily downloads at
100 MB each is about 100 TB/day. Artifact bandwidth dominates metadata storage.

I would target p95 catalog reads below 200 ms and search below 300 ms at the
service boundary, with 99.95% monthly read availability.
I would separately measure publication-to-search lag and pending-review age.
An API latency percentile cannot show whether background work ever completes.

## 🏗️ Architecture, data model, and API

I would start with clear module boundaries, even if several initially run in one
API deployment. Separate services become useful when traffic, ownership, or failure
isolation justifies the operational cost.

```
┌──────────────────────────┐      ┌────────────────────────────┐
│ Browser / installer      │─────▶│ CDN + object storage       │
└────────────┬─────────────┘      │ Approved artifact bytes    │
             │                    └────────────────────────────┘
             │
             │
             ▼
┌──────────────────────────────────────────────────────────────┐
│ API: catalog, reviews, publishing, download access           │
└────────────┬───────────────────────────────────┬─────────────┘
             │                                   │
             │                                   │
             │                                   │
             ▼                                   ▼
┌──────────────────────────┐      ┌────────────────────────────┐
│ Search + read cache      │      │ PostgreSQL                 │
│ Derived public views     │      │ Authority + outbox         │
└──────────────────────────┘      └──────────────┬─────────────┘
             ▲                                   │
             │                                   │
             │                                   ▼
             │                    ┌────────────────────────────┐
             └────────────────────┤ Relay + queue + workers    │
                                  │ Indexing / moderation      │
                                  └────────────────────────────┘
```

PostgreSQL owns accounts, app revisions, release state, reviews, and mutation
results. Elasticsearch serves text retrieval; Redis caches public reads and holds
sessions. A queue carries committed changes to moderation and projection workers.
Large objects bypass the metadata API after authorization.

### Data model

I would explain the relationships rather than write SQL on the whiteboard.
The app is a stable identity, while submitted metadata and releases have revisions.
That distinction is necessary to answer “what exactly did we approve?”

| Record | Identity / important fields | Main rule |
|--------|-----------------------------|-----------|
| App | App ID, bundle ID, developer ID, public-release pointer | Unique bundle identity; owner controls drafts |
| App revision | App ID, revision, metadata, submission state | Submitted contents are immutable |
| Release | Release ID, app revision, object key, digest, approval | Published bytes match reviewed bytes |
| Review | Review ID, account/app, revision, stars, text, status | Unique account/app current review |
| Review decision | Decision ID, review/revision, reason, outcome | Decision applies only to its evaluated revision |
| Rating contribution | Review ID, applied revision, eligible stars | One reversible contribution per review |
| Operation | Caller, action, key, request digest, result | Same logical retry returns the same result |
| Outbox / consumer receipt | Event ID, aggregate sequence / consumer ID | Recover propagation and deduplicate effects |

Useful indexes follow access patterns: public apps by category and sort order,
reviews by app and stable page order, developer drafts by owner, and unpublished
outbox work by age. I would not add every conceivable index before measuring writes.

### Representative API

These are proposed resource contracts, not a transcription of the local router.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/apps/search` | Ranked eligible candidates with continuation |
| GET | `/apps/:id` | Current public metadata and release state |
| POST | `/apps/:id/access-grants` | Authorize access to the current release |
| PUT | `/apps/:id/my-review` | Save a revision of the caller's review |
| GET | `/apps/:id/reviews` | Published review page |
| PUT | `/developer/apps/:id/draft` | Save with expected draft revision |
| POST | `/developer/apps/:id/submissions` | Bind metadata revision and uploaded artifact |
| POST | `/developer/apps/:id/publications` | Publish an approved release |
| GET | `/operations/:id` | Resolve a mutation whose response was lost |

Mutations return the committed revision and operation status.
Validation errors, revision conflicts, and unavailable dependencies have distinct
responses. A caller must be able to distinguish “rejected” from “outcome unknown.”

## 🔧 Deep dive 1: Discovery and search consistency

> “I would use search to find candidates, but never let an index document decide
> whether an app is currently published or whether someone may download it.”

A catalog must support fuzzy text, categories, price filters, and useful ordering.
A relational database can handle a modest catalog, including basic full-text search.
At the assumed scale and retrieval requirements, a dedicated index gives us room
for analyzer tuning and independent search capacity.

### Candidate retrieval and ranking

I would first filter for publication eligibility and requested compatibility,
then retrieve a bounded candidate set using text relevance.
A second stage can blend text relevance with quality signals such as rating
confidence and recent demand. I would start with a small explainable model.

A raw average treats one five-star review as stronger evidence than thousands of
reviews averaging 4.8. A confidence-aware prior can temper low-count ratings,
but its parameters are product choices that need evaluation.
It does not replace review-abuse controls or justify a claim of objective quality.

I would normalize or calibrate signals before combining them.
Adding an arbitrary search score to a value bounded between zero and one does not
produce a meaningful 60/40 influence merely because the coefficients say so.
A small judged query set helps test whether the ranking finds the intended apps.

Retrieval also limits what ranking can improve.
If we fetch exactly page two and rerank only those twenty results, a stronger
candidate excluded from that page can never move into it.
We need to define a larger candidate window or a ranking strategy applied before
pagination, then accept its CPU and latency cost.

### Stable pages

A user should not repeatedly see the same app or miss results while paging.
I would include a deterministic tiebreaker and use a continuation tied to the query
and ranking snapshot. Changing filters starts a new search.
Snapshots expire, so very old continuations may require restarting the search.

Keeping a long snapshot forever would consume resources and freeze stale data.
A bounded session is a practical compromise for a user scanning several pages.
The public detail remains a fresh check of what is actually available.

### Propagating catalog changes

Publishing commits the authoritative revision and an outbox event in one database
transaction. The indexer consumes it and upserts a document carrying that revision.
An older event cannot overwrite a newer document or restore a withdrawn listing.

A relay crash after broker acceptance can produce duplicates.
The consumer compares revision and records progress; repeated delivery has no new
indexing effect. A periodic reconciliation compares current authoritative state
with the search projection and repairs missing or obsolete entries.

For a full rebuild, I would build a new index from a database snapshot, replay
changes after that snapshot, verify coverage, and switch the read alias.
Rebuilding in place could expose a partially empty catalog to users.

### Withdrawal and failure behavior

Search may briefly return a withdrawn app because indexes and caches lag.
Detail and access-grant endpoints recheck current release eligibility.
If immediate disappearance from search is a hard requirement, we can add a small
authoritative withdrawal filter, with an explicit latency and availability cost.

When search is unavailable, return an unavailable state or a deliberately limited
catalog fallback. Returning an empty result list hides the outage as “no matches.”
A fallback must advertise its narrower matching semantics and have bounded load,
otherwise an index outage can overload the primary database.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Database authority plus versioned search projection | Transactional publishing with flexible retrieval | Lag, relay, reconciliation |
| ❌ Index as publication authority | One read-oriented store | Weak fit for revision approval and related transactional changes |
| ❌ Synchronous database/index dual write | Apparently immediate visibility | Partial commits and ambiguous request failures |

For a smaller catalog, I would seriously consider PostgreSQL search first.
The two-store design earns its complexity only when retrieval and scaling needs
outgrow that simpler option.

## 🔧 Deep dive 2: Review trust and rating effects

Reviews influence discovery, so abuse is a correctness problem as well as a
moderation problem. I would separate acceptance of user input from public eligibility.
A pending review can be safely saved without changing the app's public average.

The write path validates ownership, stars, and content bounds, then saves a new
review revision. A uniqueness rule on account/app prevents concurrent duplicate
reviews even when two requests pass the same preliminary existence check.

An initial risk decision may publish low-risk content or hold it pending.
Signals might include account history, unusual submission velocity, evidence of
app use, and coordinated activity. A prior download is evidence of a recorded
action, not necessarily a verified purchase or proof that the reviewer is honest.

### Asynchronous analysis

Expensive analysis runs from a durable event that identifies the review revision.
The result contains its decision ID, evaluated revision, outcome, and reason.
Applying it requires the review still to be at that revision.
A stale result is recorded as obsolete rather than applied to newly edited text.

Suppose a review initially says “Useful camera controls,” then the author replaces
it while revision 1 is being analyzed. Approval of revision 1 must not approve
revision 2. Without revision checks, a slow worker becomes a publication bypass.

Heuristics can make mistakes. I would retain decision reasons and support an
operator correction or appeal path. A queue that only subtracts from a pending
score, with no release decision, is not a complete moderation workflow.

### Correct rating updates

The average is derived from eligible contributions, not from the number of API
calls or moderation events. Each review has zero or one current contribution.
Its value depends on whether its current revision is published.

When an approved four-star review becomes an approved two-star review, replace
four with two while keeping the count unchanged. If it becomes rejected, remove
four and decrement the count. A pending review edit changes neither total.

I would apply the review transition and its contribution change in one transaction,
locking or conditionally updating the current revision. A repeated decision sees
that the relevant revision/effect is already applied and does nothing new.
At first, updating the app's sum and count in that transaction is sufficient.

A review's old state must be read under the same concurrency protocol.
Reading it before the transaction and later subtracting its old stars allows two
concurrent deletions or edits to apply the same adjustment twice.
Wrapping only the final statements in a transaction does not prevent that race.

At hot-app scale, contribution records can feed an asynchronous aggregate view.
That reduces contention on one app row but introduces rating freshness lag.
The contribution ledger remains the source for reconciliation and corrections.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Risk-based pending state with revisioned decisions | Fast ordinary feedback and controlled suspicious publication | Decision operations and correction workflow |
| ❌ Publish all reviews immediately | Lowest submission friction | Abuse affects ratings before detection |
| ❌ Hold all reviews for deep analysis | Uniform gate | Backlog and slow feedback for ordinary users |

For aggregation, I choose replaceable contributions over blind increments.
The extra identity and version information earns its cost when reviews are edited,
rejected, replayed, or restored after a mistake.

> “The strongest guarantee is not that the queue delivers once. It is that a
> review revision changes its public rating contribution at most once under our
> database transaction, even if the queue delivers the decision repeatedly.”

## 🔧 Deep dive 3: Publication and artifact delivery

An app listing and an executable package have different lifecycles.
I would keep drafts editable, but freeze a submitted revision and its artifact.
Approval then refers to something stable that can be audited and served later.

### From upload to publication

1. Create an owned upload session with a generated object key, size bound, and digest.
2. Upload directly to object storage using a short-lived authorization.
3. Verify the completed object and run artifact validation/scanning.
4. Submit the immutable metadata/artifact pair for an approval decision.
5. Publish that approved revision by changing the public pointer transactionally.
6. Append an outbox event in the same transaction for search/cache propagation.

A successful upload is not publication. A successful scan is not necessarily
approval. A signed URL is an access mechanism, not a validation mechanism.
Keeping these meanings distinct prevents a UI shortcut from becoming a release policy.

An old published release can remain available while a new draft is edited.
Changing the draft does not rewrite the approved object or mutate the public
metadata in place. If the new version is rejected, the old release remains intact.

### Recovering after a lost response

A publication request has a caller-scoped idempotency key and request digest.
The durable operation record stores its result together with the committed state.
If the response is lost, the caller queries the operation or retries the same key.
A different payload under that key is a conflict.

A Redis claim taken before the database transaction is insufficient.
The process can die after claiming the key but before publishing, leaving retries
blocked without any committed result. Redis may accelerate lookups, but the durable
operation identity must remain tied to the authoritative transaction.

### Reliable propagation

The relay retries unpublished outbox events and uses broker confirmation.
It cannot eliminate duplicates when it crashes between acceptance and checkpointing.
Consumers deduplicate within their effect transaction and reject stale revisions.

Poison events need a correctly routed dead-letter destination and an inspection
workflow. Reconnecting a broker socket must also restore consumer subscriptions.
Queue durability alone does not prove that a committed app will ever be indexed.

I would expose “published; indexing pending” to the developer.
This acknowledges the durable result while accurately describing a delayed projection.
An index outage should not require the developer to resubmit an approved release.

### Delivering artifacts

The access service reads current publication state and checks caller eligibility,
then issues a short-lived grant for the immutable release object.
The CDN handles large transfers, range requests, and cacheable content.
The API does not carry hundreds of megabytes per catalog user.

Withdrawal stops new grants. Existing grants have a bounded validity window;
urgent revocation may require an additional edge policy and cache invalidation.
I would state that window explicitly rather than promise instantaneous recall.

For analytics, “grant issued,” “file transferred,” and “app installed” are separate
events. Retry-safe grant identity prevents duplicate grant metrics, but installation
requires a trusted client/platform signal. Revenue requires actual transaction data.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Immutable release plus direct storage/CDN transfer | Approval binds to bytes; API stays lightweight | Upload verification, grants, cleanup, revocation policy |
| ❌ Overwrite a mutable package path | Simple file naming | Approved bytes can silently change |
| ❌ Proxy all bytes through catalog servers | Central transfer control | Bandwidth and slow clients compete with metadata traffic |

## 🛠️ Failure handling and scaling priorities

I would first cache popular public metadata and put images/artifacts behind a CDN.
Then scale stateless API instances and the search tier independently.
I would partition review/event work only when measured traffic or hot identities
justify the extra ordering and reconciliation complexity.

Operational signals should expose the user-facing risks: oldest unpublished outbox
entry, search revision lag, pending-review age, dead-letter growth, and disagreement
between rating contributions and aggregates. HTTP success counts are insufficient.

Useful recovery tests include duplicate/out-of-order index events, stale moderation
decisions after an edit, a publication response lost after commit, and a withdrawal
while a user holds a cached result. They verify invariants that a health probe cannot.

## ⚖️ Trade-offs and local implementation boundary

The proposed design accepts bounded staleness in discovery and aggregate displays,
while keeping publication, review contribution changes, and access decisions under
authoritative transactions. That is the consistency boundary I would defend.

The local repository uses one Express API with PostgreSQL, Redis, Elasticsearch,
MinIO, and two RabbitMQ workers. Its search reranks only the fetched page; top lists
use SQL sorts rather than the proposed ranking pipeline. Publishing writes the
index directly, while the outbox and idempotency helpers are unused.

Fresh review creation references a nonexistent `user_apps.id` column. Review
updates and worker decisions do not enforce the proposed revision/contribution
rules. The download endpoint records an action and returns a placeholder URL;
it does not authorize a real artifact or process payments.

These are documented source limitations in the [architecture](./architecture.md).
I would implement the publication/review invariants before adding more ranking
signals or infrastructure, because scale multiplies incorrect effects as readily
as correct ones.

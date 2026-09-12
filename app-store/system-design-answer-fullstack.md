# App Store — fullstack system design interview

> “I would design the store around three journeys: finding an app, publishing a
> release, and contributing a review. For each journey, I want to explain what
> the browser shows, what the server guarantees, and how we recover when a
> response or background job is delayed.”

This is a proposed 45-minute design. It uses one diagram and three deep dives,
with a small enough scope to discuss on a whiteboard. The repository's current
teaching implementation is described separately at the end.

| Discussion | Minutes |
|------------|---------|
| Scope, requirements, and scale | 5 |
| Shared architecture and contracts | 8 |
| Deep dive: discovery from query to detail | 8 |
| Deep dive: developer publication | 10 |
| Deep dive: reviews and rating trust | 9 |
| Performance and verification | 3 |
| Trade-offs and local implementation boundary | 2 |
| Total | 45 |

## 🎯 Scope, requirements, and scale

I would clarify whether we need a native installer, a payment system, or the
marketplace around them. I will focus on a browser marketplace with a developer
console. Native installation and payment processing are separate integrations.

Users browse categories, search, inspect an app, read/write reviews, and request
access to an eligible release. Developers save metadata, upload a package, submit
it for approval, publish it, and respond to reviews.
A moderation role can approve or reject a submission and withdraw a release.

I would distinguish several words before drawing components:

| Word | Meaning in this design |
|------|------------------------|
| Saved | The server durably accepted the user's data |
| Approved | A decision allows a specific revision to proceed |
| Published | The authoritative public release pointer committed |
| Indexed | A search projection reflects that publication |
| Downloaded | A defined transfer event occurred, not merely a button click |

These distinctions influence both APIs and UI copy.
If a developer sees “failed” after publication committed but search indexing timed
out, they may keep retrying a release that is already public.
The system needs a way to report the durable outcome separately from propagation.

My core invariants are that only approved bytes become a public release, a review
revision contributes at most once to ratings, and search never authorizes access.
The browser must preserve unsaved text and recover a mutation whose outcome is unknown.

### Planning assumptions

Assume 10 million daily users with 20 catalog reads and 5 searches each.
That is around 2,315 catalog reads/s and 579 searches/s on average.
A 10× peak gives approximately 23,000 and 5,800 requests/s.
I would target p95 service latency below 200 ms for catalog and 300 ms for search.

At one million downloads/day averaging 100 MB, delivery is about 100 TB/day.
That makes object delivery a different scaling problem from metadata lookup.
The browser's experience also depends on image sizes, JavaScript, and network latency;
server response targets alone do not guarantee a fast page.

I would allow normal publication-to-search lag of up to a minute and measure it.
A current access check must reject a withdrawn release even if the user arrived
through an older search result. These are proposed targets, not repository benchmarks.

## 🏗️ Shared architecture and contracts

I would start with React routes for public discovery and a developer workspace.
A query cache holds server data; local form state holds unsaved drafts.
A typed API client handles sessions, error categories, and operation identity.

The backend can begin as one modular API with separate background workers.
PostgreSQL owns business state, Elasticsearch serves retrieval, Redis caches public
reads and sessions, and object storage/CDN serves media and approved packages.

```
┌──────────────────────────┐      ┌────────────────────────────┐
│ Browser                  │─────▶│ CDN + object storage       │
│ Routes, cache, drafts    │      │ Approved artifact bytes    │
└────────────┬─────────────┘      └────────────────────────────┘
             │
             │
             ▼
┌──────────────────────────────────────────────────────────────┐
│ API: discovery, reviews, developer work                      │
│ Access grants and operation status                           │
└────────────┬───────────────────────────────────┬─────────────┘
             │                                   │
             │                                   │
             ▼                                   ▼
┌──────────────────────────┐      ┌────────────────────────────┐
│ Search + public cache    │      │ PostgreSQL                 │
│ Versioned derived views  │      │ Authority + outbox         │
└──────────────────────────┘      └──────────────┬─────────────┘
             ▲                                   │
             │                                   │
             │                                   ▼
             │                    ┌────────────────────────────┐
             └────────────────────┤ Relay + queue + workers    │
                                  │ Indexing / moderation      │
                                  └────────────────────────────┘
```

I would keep the diagram at this level. Separate services, replicas, and shards
can be added where a measured bottleneck appears, without changing the contracts.
The important distinction is authoritative state versus derived views.

### Shared data vocabulary

| Resource | Key information | Client/server agreement |
|----------|-----------------|-------------------------|
| App | Stable ID, developer, public release | Drafts and public metadata have separate access |
| Draft revision | Editable contents and revision number | Save can conflict with a newer revision |
| Release | Artifact digest, reviewed metadata, approval | Publication cannot refer to changed bytes |
| Review | Account/app, revision, stars, text, status | Pending content does not affect public ratings |
| Operation | ID, requested action, committed result | Retry or reload resolves the same work |
| Search page | Query identity, ordered results, continuation | A page belongs to one search context |

An app version label such as “2.0” is not a concurrency token.
The server needs its own monotonic revision to detect two editors overwriting
each other and to reject outdated worker decisions.

### State ownership

The URL owns query, filters, and navigation position.
A server-data cache owns fetched search pages, app metadata, and saved reviews.
Component state owns unsaved text, validation, and open dialogs.
Session state is restored from the server before protected-route decisions.

These boundaries reduce accidental coupling. One global loading flag should not
make a developer save hide the public app detail or clear search results.
An account switch should also remove private cached data from the prior account.

### Representative API

These are proposed contracts, with exact naming secondary to their semantics.

| Method | Path | Result |
|--------|------|--------|
| GET | `/apps/search` | Ordered results and continuation |
| GET | `/apps/:id` | Public metadata and current eligibility |
| POST | `/apps/:id/access-grants` | Authorized URL for an immutable release |
| PUT | `/apps/:id/my-review` | Saved review revision and moderation state |
| PUT | `/developer/apps/:id/draft` | Saved revision or conflict |
| POST | `/developer/apps/:id/submissions` | Accepted metadata/artifact revision |
| POST | `/developer/apps/:id/publications` | Committed publication operation |
| GET | `/operations/:id` | Existing mutation outcome and progress |

The API returns structured validation errors and distinguishable conflicts,
authorization failures, and unavailable states. The browser can then offer the
right action instead of treating every problem as “try clicking again.”

## 🔧 Deep dive 1: Discovery from query to detail

> “Search has two consistency problems: the index can lag the catalog, and the
> browser can display a late response from an old query. I would solve each at
> its own boundary rather than assuming one cache solves both.”

### The browser request path

A user enters “camera,” selects a category, then changes the sort order.
The URL describes the current search, and a normalized query key identifies its
cached response. A new filter resets the continuation.

Requests can overlap. I would cancel obsolete requests where possible, but also
store responses under the key that produced them. An old response must not replace
current results merely because it finished last.
The same identity rule applies when navigating quickly between two app details.

I would start with explicit search submission and a Load more or page control.
Autocomplete can be a separate debounced request with a small response budget.
Keeping these requests separate prevents every keystroke from triggering a full
search page and creating noisy browser history.

Returning from an app detail restores the query, loaded pages, and a stable scroll
anchor. A bounded cache avoids retaining every page indefinitely.
If a ranking snapshot expires, the UI explains that results need refreshing.

### The server retrieval path

Search retrieves eligible candidates with text relevance and requested filters,
then ranks a bounded candidate set using a few explainable quality signals.
I would not start with a large personalization model before evaluating basic queries.

Raw rating averages can overvalue a single five-star review.
A confidence-aware rating signal can help, but it should be calibrated and tested
alongside abuse controls. A formula with many weights is not automatically insightful.

Ranking must happen before stable pagination over the chosen candidate set.
Reranking only an already selected page cannot bring a better candidate from another
page into view. The candidate budget is a latency-versus-ranking-quality decision.

Search documents carry catalog revision and publication eligibility.
A committed publication event updates the projection asynchronously; older revisions
cannot overwrite newer ones. A reconciler repairs missing or obsolete documents.

### Detail and acquisition

I would load essential app metadata independently of reviews and recommendations.
A slow similar-apps query should not prevent the user from reading the app description.
The browser shows an error only in the failed section where possible.

A search hit is a discovery hint, not a grant to obtain a package.
When the user requests access, the server checks the current public release and
any entitlement requirement. A withdrawn release therefore fails safely even when
a cached detail still showed it as available.

If search is down, the UI must distinguish that from a successful zero-result query.
A bounded catalog fallback is possible, but its narrower behavior should be explicit.
Unbounded fallback queries could turn a search outage into a database outage.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Keyed browser cache plus versioned search projection | Safe navigation and independently scalable retrieval | Two explicit freshness boundaries |
| ❌ One global results slot | Quick initial implementation | Out-of-order responses show unrelated results |
| ❌ Search index as source of release truth | Fewer reads | Stale documents can make incorrect access decisions |

The design accepts bounded discovery lag while keeping the action authoritative.
That is a practical product compromise: a new app can appear slightly later,
but an obsolete result cannot bypass the current release policy.

## 🔧 Deep dive 2: Developer publication

The developer journey combines large data transfer, editable text, background
validation, and a small but consequential publication transaction.
I would make the durable stages reconstructable after the browser closes.

### Draft editing

The browser keeps an editable draft separate from the last saved server revision.
Save sends that expected revision; the server checks ownership and updates only if
it is still current. A conflict preserves the user's text and returns newer data.

For the first version I would choose explicit Save.
Autosave is useful, but needs serialized revisions, saved-state feedback, and
recovery from overlapping writes. A simple debounce does not provide those guarantees.

The submitted metadata revision becomes immutable.
A developer can create a newer draft while an older revision is under review or
published. Changes do not silently inherit approval from the earlier submission.

### Artifact upload

The API creates an owned upload session with a generated object key, expected
size, and digest. The browser uploads directly to storage and displays transfer
progress. After completion, the server verifies the object and starts validation.

The UI labels 100% as “Upload complete,” then shows validation or review progress.
It does not call the app published merely because the file transfer finished.
A failed verification keeps the developer's metadata and explains the next action.

The approved release binds the metadata revision to immutable artifact bytes.
Overwriting a file behind the same published URL would break that relationship.
New contents require a new object/revision, with cleanup for abandoned uploads.

### Publication and propagation

Publishing changes the authoritative public-release pointer and appends an event
in the same PostgreSQL transaction. A durable operation record identifies the
request and stores its committed result.

A relay later sends the outbox event to search/cache workers.
If the broker or index is unavailable, the publication remains committed and the
outbox remains recoverable. The UI can say “Published; search update pending.”

Synchronous database-plus-index writes have a troublesome failure window.
The database may commit and indexing may fail, causing an error response after
the app is already published. Retrying blindly can repeat side effects and leaves
the developer uncertain about which state to trust.

The outbox avoids losing the committed propagation intent, but does not make
message delivery exactly once. A relay can crash after sending and before marking
progress. Consumers compare revisions or record event receipts with their effects.

### A lost browser response

Suppose the server commits publication just as the user's network disconnects.
The browser retains the operation identity and shows that it is checking status.
It retrieves the existing result on reconnection instead of inventing a new publish.

The server binds the idempotency key to caller, action, and request contents.
The same key with changed contents is a conflict; the same request returns its
existing result. Browser button disabling is helpful but cannot replace this rule.

I would use bounded polling while the developer is viewing the operation.
A global WebSocket connection is unnecessary for occasional publication progress.
The server continues processing after the tab closes and exposes the result later.

### Download and withdrawal

Once eligible, an access request returns a short-lived grant for the immutable
release. Storage/CDN handles transfer bytes, keeping catalog servers available.
For paid apps, the entitlement decision comes from a separate authoritative record.

Withdrawal prevents new grants. Previously issued URLs may remain usable until
they expire, so the system needs an explicit revocation window.
An urgent recall policy can require additional edge checks; it should not be
promised by a UI toggle that only changes the database.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Revision-bound releases and durable publication operations | Approval integrity, concurrent editing, recovery after disconnect | More states and background progress |
| ❌ One mutable app object and publish flag | Fewer fields/screens | Approval can apply to changed contents; ambiguous retries |
| ❌ Browser orchestrates critical publication steps | Flexible client implementation | Closing the tab can strand accepted work |

> “The browser should explain the workflow and preserve the developer's work.
> The server should own the workflow once it accepts an operation.”

## 🔧 Deep dive 3: Reviews and rating trust

A review is both a user's contribution and an input to other users' decisions.
That creates a tension between immediate feedback and publication controls.
I would separate saving the review from making it public.

### Submission experience

The browser validates required fields and retains text while sending.
The server enforces one current review per account/app with a database uniqueness
rule, saves the revision, and returns its moderation state.
A pre-insert existence check alone does not prevent concurrent duplicate reviews.

A saved pending review appears in the author's private panel.
It does not immediately increase the public review count or rating average.
The UI can be responsive by confirming saved work without inventing publication.

If the response is lost, the browser resolves the existing operation or current
review. It preserves the draft until there is a confirmed saved result.
A new unrelated request could otherwise create duplicates or overwrite a later edit.

### Moderation and editing

A low-cost initial risk decision can publish ordinary content or hold suspicious
content pending. Deeper analysis runs asynchronously against an identified revision.
Its result must still match the current review revision before being applied.

For example, a user edits pending review text while an older version is being
analyzed. The old approval cannot approve the new text.
The backend rejects that stale decision, and the browser displays the current
review state returned by the server.

Signals such as account age, velocity, and prior app use can help triage.
They are not proof of authenticity. I would keep decision reasons and a correction
path instead of presenting a score as an infallible verdict.

### Rating effects

The public average derives from current published contributions.
An approved review has one contribution; a pending or rejected review has none.
Editing a published review replaces its stars, and rejection removes its contribution.

I would apply the review state change and rating adjustment in one transaction,
using the current revision under a lock or conditional update.
Repeated decisions then have no additional effect, and stale edits cannot subtract
a contribution that a different operation already removed.

At first, app sum/count updates can stay in that same transaction.
If a few popular apps become write bottlenecks, an asynchronous aggregate view can
reduce contention. That adds freshness lag and requires a contribution ledger for
reconciliation; it is a scaling step, not a reason to abandon correctness.

### Refresh and developer responses

The browser updates its confirmed review and refreshes the relevant rating summary
and review pages. If aggregates are asynchronous, show their freshness rather than
forcing an optimistic exact match with newly saved content.
Search cards can trail the detail view during propagation.

Developer responses are owned mutations too.
The response editor should retain text until acknowledgement and show a scoped
error on failure. Closing and clearing the editor immediately can lose work even
when the server rejected the response.

Helpful voting can use a desired state with account/review uniqueness.
That is easier to retry than a toggle whose second identical request reverses the
first. Optimistic feedback is reasonable when rollback and confirmed state are clear.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Immediate saved receipt, controlled public eligibility | Good feedback with trustworthy ratings | Explicit pending/rejected states |
| ❌ Publish optimistically in the public list | Fast apparent completion | Abuse or rejected content affects displayed totals |
| ❌ Block all feedback until deep analysis | Simple public boundary | Long waits and moderation backlog |

The extra review revision and contribution identity make corrections explainable.
They connect the moderation decision, aggregate effect, and user-visible state.
Without those identities, retries and edits can silently change what a rating means.

## ⚡ Performance and verification

For the browser, I would prioritize route-sized bundles, appropriately sized images,
and independent loading of secondary sections. Public metadata can be server-rendered
if discoverability and initial loading justify that complexity.
Short result pages need no automatic virtualization; measured long-list cost can
justify it later, with stable keys and deliberate keyboard focus handling.

For the backend, cache public metadata and move large bytes to a CDN first.
Then scale API/search capacity independently. Sharding and elaborate ranking models
come after measuring the actual bottleneck and verifying recovery behavior.

Core actions need semantic links/buttons, accessible star labels, field-level
errors, and usable mobile navigation. Publication status should be announced without
moving focus, and dialogs should preserve drafts on failures.

I would test complete failure scenarios across the boundary:

- An old search response arrives after the user changes filters.
- An upload completes, but verification fails and the draft must remain recoverable.
- Publication commits, the response is lost, and the same operation is resolved.
- An older moderation decision arrives after the review was edited.
- A release is withdrawn while its old search result remains cached.

Metrics should include projection lag, pending-review age, repeated-event effects,
and mutation recovery failures. A low average API latency can coexist with a
publication that never reaches search; the latter needs its own measurement.

## ⚖️ Trade-offs and local implementation boundary

The design accepts lag for discovery and aggregate displays, while keeping release
eligibility and review contribution changes authoritative. The browser makes those
boundaries visible rather than treating every accepted request as fully completed.

The local demo provides catalog/search pages and a developer metadata console.
It uses React, Zustand, Express, PostgreSQL, Redis, Elasticsearch, RabbitMQ, and
MinIO, but no completed artifact approval, commerce, or native installation flow.
Its Get buttons do nothing, public review submission is absent from the UI, and
search page buttons do not fetch another page.

The backend's review creation queries a missing column; publication/index writes
are not joined by the unused outbox. Drafts can publish without approval, and the
download API returns a placeholder after incrementing counters. Browser session
restoration and request-context guards are also incomplete.

Those are implementation findings, not guarantees of this proposed design.
The [architecture](./architecture.md#implementation-notes) records the source paths.
I would first connect a small number of journeys with truthful states and recovery,
then increase scale and ranking sophistication once those contracts hold.

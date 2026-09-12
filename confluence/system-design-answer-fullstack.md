# Design a team wiki — fullstack interview

## 🎯 Start with the user journey — 3 minutes

> “I would follow one page from discovery to editing, review, publication, and later
> recovery. That gives us a way to connect the browser's status messages to real backend
> guarantees rather than designing the frontend and backend independently.”

A user opens a space, finds a page, makes an edit, and saves it. Another person may edit
the same page or review a proposed revision. Readers need stable links and trustworthy
search, while authors need confidence that their work will not disappear after a timeout
or a navigation change.

I would scope the first version to spaces, hierarchical pages, rich text, revision
history, comments, and text search. Space policy can allow direct publication or require
review. Live typing collaboration, arbitrary executable macros, and attachment
processing are separate extensions.

The initial conflict policy is explicit: a stale editor receives a conflict and keeps
its draft. We can preserve a local recovery copy without promising automatic offline
synchronization. Saved content and published content are distinct when review is
required.

The following is a proposed production design. The local project contains useful
examples of these layers, but the source limitations described at the end mean they are
not all working end to end today.

| Discussion | Time |
|------------|------|
| Scope and user contract | 3 min |
| Architecture, scale, and state | 7 min |
| Deep dive: save, conflict, and publication | 12 min |
| Deep dive: search consistency and access | 9 min |
| Deep dive: navigation and hierarchy | 8 min |
| Recovery, testing, and trade-offs | 6 min |
| Total | 45 min |

## 🏗️ Architecture, scale, and state — 7 minutes

I would draw a browser with two kinds of state: reusable server snapshots and an active
editor draft. Behind the API, PostgreSQL owns page revisions and permissions. Search is
derived asynchronously so an index outage does not decide whether an edit was saved.

```
          ┌─────────────────────────────────┐
          │ Browser                         │
          │ Reader / tree / editor draft    │
          └────────────────┬────────────────┘
                           ▼
          ┌─────────────────────────────────┐
          │ API: sessions and permission    │
          │ Pages / versions / search       │
          └────────────────┬────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│ PostgreSQL           │        │ Search index         │
│ Revisions / outbox   │        │ Derived documents    │
└──────────┬───────────┘        └──────────▲───────────┘
           │                               │
           ▼                               │
┌──────────────────────────────────────────┴───────────┐
│ Outbox publisher → queue → index worker              │
└──────────────────────────────────────────────────────┘
```

The API's modules can share one deployment initially. Redis supports sessions and
immutable content caching, and a CDN serves the application bundle. Adding a network
service for every wiki feature would complicate consistent save and publication
transactions without a demonstrated need.

For scale, assume one million daily active users, 20 million pages, 40 million page
reads, ten million searches, and 500,000 accepted edits per day. That is roughly 463
reads, 116 searches, and six writes per second on average. I would plan initial peaks
around 5,000 reads, 1,000 searches, and 100 writes per second, then validate skew with
load tests.

At 40 KB per canonical revision, current content is about 800 GB and new history adds
about 20 GB daily before compression. These estimates leave room for full snapshots
initially, while reminding us that rendered forms, indexes, replicas, and backups
consume additional storage.

Proposed targets are p95 page reads under 200 ms, saves and search under 500 ms, and
normal search visibility within five seconds for 99% of changes. Typing responsiveness
is a separate browser target. None of these are measured guarantees of the demo.

### Ownership across the stack

| Concern | Browser owns | Server owns |
|---------|--------------|-------------|
| Navigation | Current route, expanded branches, focus | Stable identity, canonical URL, permitted hierarchy |
| Editing | Draft, selection, undo, submitted payload | Validated content and accepted revision |
| Save status | Pending/unknown/conflict presentation | Durable receipt and conflict decision |
| Publication | Clear draft/published indicators | Authorized revision-bound publication |
| Search | Query URL, result state, safe display | Ranking, current access checks, freshness/degradation |
| Recovery | Preserve the correct user's local draft | Durable history and repeatable mutation outcomes |

This table prevents a common mistake: using one global page object for both server truth
and unsaved user work. A background fetch may refresh the resource cache, but it cannot
replace the active draft without an explicit reconciliation step.

### Data and API essentials

The central records are spaces and memberships, pages with stable IDs and parent
references, immutable revisions, mutation receipts, an outbox, and revision-bound
approvals. Comments and labels attach to page identity. A page keeps both an authoring
head and the published revision where review policy requires them.

| Operation | Request needs | Response tells the browser |
|-----------|---------------|----------------------------|
| Read page | Stable page ID and requested view | Permitted revision, canonical URL, capabilities |
| Save | Page ID, expected base, immutable payload, mutation ID | Accepted revision/receipt or explicit conflict |
| Restore | Historical source, current expected head, mutation ID | New revision and current page metadata |
| Move | Page ID, target parent/order, hierarchy context | Confirmed placement and hierarchy generation |
| Request/review publication | Target revision and decision identity | Exact reviewed/published revision |
| Search | Query, validated scope, bounded continuation | Authorized safe results and search status |

I would show this contract on the whiteboard instead of writing JSON bodies for every
endpoint. It makes the interaction between layers easier to assess.

## 🔧 Deep dive 1: make “saved” and “published” mean something — 12 minutes

### Follow a save from keystroke to commit

Alice opens revision 7 and starts editing. The browser records revision 7 as the base
and maintains a separate draft. The editor owns its document and selection state so
unrelated React renders do not replace the active editing surface.

I would use a validated document model for paragraphs, lists, headings, links, and
supported macros. The server derives HTML and plain text from that canonical content.
This avoids trusting unrelated client HTML, text, and JSON fields to describe the same
document.

The editor integration costs more than a basic content-editable prototype. In return,
selection, undo, paste, and composition have a coherent owner. Content validation and
safe rendering remain application responsibilities; using an editor library does not
authorize arbitrary HTML or executable macros.

When Alice saves, the browser captures the exact payload and a mutation ID. It can keep
accepting typing, but additional edits belong to the next submission. The server
validates permission and content, then conditionally advances revision 7 in one database
transaction.

That transaction inserts revision 8, its durable mutation receipt, and an outbox event.
Only after commit does the server acknowledge revision 8. Search indexing can happen
later. Failure to invalidate a cache or contact the broker must not turn that committed
save into an unexplained replacement request.

### Reconcile the response with current browser state

If Alice has not typed since submission, the draft is now clean at revision 8. If she
added another paragraph while waiting, the accepted base advances, but the newer
paragraph remains unsaved. The UI must not clear the dirty flag just because any save
response arrived.

| State shown to the author | What it means |
|--------------------------|---------------|
| Unsaved changes | Current draft differs from the last accepted content |
| Saving | One identified payload is awaiting an outcome |
| Saved as revision 8 | The server committed that payload and receipt |
| Newer changes unsaved | Later local typing was not part of the accepted payload |
| Save outcome unknown | The request may have committed; resolve its identity |
| Conflict | The submitted base is obsolete; local work is retained |
| Awaiting review | A saved revision has not yet become reader-visible |

I would allow one active whole-document save per editor initially. Autosave can coalesce
subsequent edits, but it does not justify overlapping requests with unclear ordering.
Manual Save remains useful as an explicit user action and recovery cue.

### Prevent silent replacement by another author

Bob also opened revision 7. If Alice commits first, Bob's expected-base check fails. The
response names the current head, and Bob's browser retains the original base and draft
while fetching the latest revision for comparison.

A unique history key alone cannot solve this. An old draft arriving later could read
revision 8 and be stored as revision 9, silently replacing Alice's work. The request's
expected base must take part in the authoritative write condition.

> “I would choose explicit conflicts over last write wins because a wiki save represents
> substantial human work. If live concurrent typing becomes a requirement, I would
> revisit the editor and merge protocol together rather than hide the problem behind a
> timestamp.”

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Expected revision with retained conflict draft | Clear correctness boundary; preserves both authors' work | Users sometimes reconcile manually |
| ❌ Last write wins | Very small protocol | A successful request can erase another edit without notice |
| ❌ Live merge in the initial scope | Immediate shared typing | More complex rich-text merge, reconnect, and recovery semantics |

Full snapshots also simplify reading an old revision and restoring it. Delta chains save
repeated content but add reconstruction dependencies. For our initial write volume, I
would accept snapshot storage and improve compression/archival later without changing
the revision contract.

### Resolve a timeout without creating a second edit

Now suppose Alice's connection drops after the commit. Her browser cannot infer failure
from the missing response. It retries the same mutation and payload, or queries the
receipt, and learns that revision 8 already exists.

The receipt lives in the same database transaction as the revision. A cache-only
duplicate flag cannot answer reliably after eviction or a crash between writes. Reusing
the mutation ID with a different payload is rejected, and its retry retention window is
part of the API contract.

The browser retains later typing separately while resolving the original request. It
does not replace the original retry payload with the latest draft. Once the outcome is
known, the next edit can use the right base and a new mutation ID.

Navigation uses similar discipline. A late save response for page A can update A's
cached revision, but cannot navigate the user away from page B. A bounded local draft
can help recover after closing a tab, provided it is scoped to the user and workspace
and handled according to their retention policy.

### Tie review to the content being reviewed

For a reviewed space, revision 8 may be saved while readers still see revision 6. An
approval request names revision 8. If Alice creates revision 9 while review is pending,
approving 8 does not silently publish 9.

The server conditionally completes one pending decision, checks reviewer authority, and
updates the published pointer to the permitted target revision. That transaction emits a
searchable-state event even if it creates no new content revision.

The UI names both states: “Revision 8 awaiting review; readers see revision 6.” A
reviewer opens the exact requested revision and sees if a newer draft exists. Cancelling
a decision dialog submits nothing; disabling a pending button prevents accidental
repeats but is not authorization.

This model costs extra state in both layers. It is justified because “saved,”
“approved,” and “published” answer different user questions. Collapsing them into one
flag would make the interface easier to build and the review history less trustworthy.

## 🔧 Deep dive 2: useful search across a delayed boundary — 9 minutes

### A committed edit becomes searchable asynchronously

The outbox publisher sends committed searchable changes to the queue and records
delivery after broker confirmation. A crash may cause a duplicate, so workers must apply
effects repeatably. They acknowledge only after success or after verifying that a newer
generation already superseded the event.

The event's generation advances for content, labels, publication, and deletion. A
content revision number is not sufficient: publishing an existing revision or removing a
label changes the search document without changing its text history.

Consider an older worker that reads a page and then pauses. A newer worker indexes a
later state before the old worker resumes. The index must reject the older generation or
search can regress even though each worker read valid database data at the time.

Deletion uses a versioned tombstone until the permitted replay/rebuild window has
passed. Otherwise a late old write may resurrect the result. A rebuild also needs a
consistent starting state and subsequent changes, including deletions, before switching
users to the new index.

> “I would choose an outbox because a saved page creates a durable obligation to update
> search. A best-effort send after commit can disappear during a crash, while a
> synchronous search write makes a partial failure look like the page was not saved.”

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Durable outbox and ordered index effects | Save stays available during search outages; repair is possible | Extra workers, lag monitoring, retries, and rebuild operations |
| ❌ Best-effort publication | Fast and easy happy path | Some changes may never reach search |
| ❌ Synchronous dual write | Simple-looking request sequence | No shared transaction; partial success makes retries ambiguous |

### Decide whether a separate search engine is justified

A smaller wiki could use PostgreSQL full-text search and avoid the additional cluster
and transport. At the assumed corpus and query volume, a separate index gives
independent relevance tuning and capacity. That is a workload decision, not a claim that
PostgreSQL lacks ranking or highlighting.

The frontend should not depend on engine-specific response shapes. A stable result
contract gives it page identity, safe title/snippet segments, represented revision, and
continuation information. It can remain the same if the backend search implementation
changes.

### Authorize before content crosses the API boundary

Search first finds candidates. The API then verifies current space permission and
publication state before returning titles or snippets. An index filter is useful for
narrowing, but it may reflect an obsolete permission or an unpublished draft.

If the indexed revision is no longer the reader's permitted published revision, use
current permitted content to rebuild the result or omit the candidate. Checking that the
caller can read the page ID is not enough if the snippet came from a private authoring
revision.

Batch those checks and cap overfetching. A filtered raw hit total may disclose private
matches or overstate available results, so use honest continuation semantics. If current
permission cannot be verified, protected search fails closed.

The browser renders snippets as escaped text with controlled highlighting. It does not
insert arbitrary indexed HTML or download unauthorized results and hide them afterward.
Account changes clear protected result state, although no system can retract text the
user already read.

This adds work to each search response. The alternative saves some latency by making a
stale secondary system the access authority. I would accept bounded verification cost
because confidentiality is stricter than the freshness target.

### Explain freshness and failure in the interface

After a save, the direct page view uses the accepted revision from the response. Search
may not include it yet, so the user still has a stable link to their work. An index
incident should not send them into repeated resaving to “make it stick.”

The URL owns query and scope so browser history reproduces the search. Responses carry
query identity; an older query cannot replace a newer result list. Empty, degraded, and
unavailable results are separate states.

A simple SQL fallback can be useful if it has a bounded query budget and clearly reduced
capabilities. Sending every failed index request into an unrestricted scan can overload
the same database that accepts edits. Under that load, explicit search unavailability is
preferable while tree navigation and known links remain usable.

Measure the time from commit to observable search visibility, not just queue depth or
worker completion. The frontend should only promise a precise freshness status if the
backend can actually support it.

## 🔧 Deep dive 3: keep navigation stable as the wiki grows — 8 minutes

### Page identity is independent of title and placement

A stable page ID anchors links, comments, history, and editor state. A slug is a
readable hint with canonical redirects or aliases. Two equal titles can coexist without
ambiguity, and moving a page does not create a new document identity.

The browser uses the canonical URL returned after a rename. It does not navigate using
the old title. Search links also identify the same resource the page endpoint expects; a
UUID cannot be substituted into a slug-only route unless that route deliberately
supports it.

Nested layouts must render their child view. The space shell owns the sidebar and a
content outlet; the page or editor route owns its main view. Direct-link tests exercise
the generated route hierarchy instead of assuming that the existence of a component
means users can reach it.

### Transfer navigation metadata, then load content

The server stores parent references and sibling order. For a modest space, return a
compact metadata tree. For a large space, load children as the user expands branches.
Neither path needs to send every page's JSON, HTML, text, and revision body.

The client normalizes nodes by ID and derives visible rows from expansion state. It can
virtualize large visible lists, preserve expanded branches across refreshes, and reveal
the active page's ancestry on a deep link.

Virtualization only reduces rendered elements. It does not repair an oversized response
or a slow server query. Separate network payload, tree computation, and DOM rendering in
performance measurements.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Adjacency list with compact/lazy navigation | Modest transfer; moving pages avoids descendant path rewrites | Recursive reads, branch loading, and cycle validation |
| ❌ Full content tree in every response | Convenient for a tiny dataset | Expensive transfer and repeated private content |
| ❌ Materialized paths initially | Fast subtree lookups | Large moves rewrite descendants and complicate concurrent updates |

### A move is one validated domain action

The initial backend serializes parent-changing actions within the space. In a
transaction, it checks source and destination permissions, enforces same-space
membership, rejects cycles, and updates parent and sibling ordering plus the hierarchy
generation.

Two individually valid cycle checks can still race if concurrent moves are not
coordinated. A simple space-level lock is easy to explain and test. It sacrifices
parallel moves in that space, which is acceptable while moves are infrequent; finer
locking is a measured optimization later.

The browser can present a pending placement and restore the old one on failure.
Breadcrumbs and affected branches refresh after confirmation. Page body caches need not
be rewritten simply because the parent changed.

A keyboard-accessible move dialog can be the first interaction, with drag-and-drop added
later as another way to invoke the same action. The interface must not define different
hierarchy rules for different input methods.

I would keep initial access control at space level. Inherited per-page permissions make
moving a subtree an authorization change for many descendants, which requires a larger
policy and invalidation design. That is a useful extension to discuss if the interviewer
makes it a requirement.

### Keep request context and focus intact

When the user opens A then B, A's late response can fill A's resource cache but cannot
become B's view. Cancellation saves work where possible; response identity checks
enforce correctness even if cancellation arrives too late.

Loading and errors belong to individual resources. A failed comment request should not
hide a readable page. A failed page request should not display the previously opened
page under B's URL. Account changes invalidate protected resource context.

The tree needs focus and expand/collapse behavior that works without a mouse. Small
screens use a collapsible navigation panel. Editor composition and selection are tested
during background requests, not assumed to work because ordinary Latin typing succeeds.

## 🛠️ Recovery, testing, and trade-offs — 6 minutes

### History and comments follow the same boundaries

History lists paginated metadata, then fetches selected snapshots or a bounded
comparison. A serialized HTML line diff can be useful internally but is often noisy for
readers; a product comparison should explain content/block changes and disclose what
formatting detail it omits.

Restore copies an old snapshot into a new revision against the current head. It uses an
identified mutation, so an uncertain retry does not create repeated restores. The
response updates the page, history, relevant navigation metadata, and publication
indicators together in the browser's resource model.

Comments have independent drafts and mutation state. A failed post keeps the text; a
late response cannot attach it to a different page's discussion. Begin with a bounded
reply depth and enforce that shape on both sides rather than allowing storage that the
reader cannot display.

### Test failures across layers

| Scenario | Expected end-to-end result |
|----------|----------------------------|
| Two editors save the same base | One revision accepted; other draft retained with a conflict |
| Save commits but response is lost | Same receipt resolves the result without another revision |
| User types during a pending save | Later typing remains marked unsaved |
| User navigates while page/save loads | Late response stays attached to its original page |
| New draft appears during review | Reviewer publishes only the named revision permitted by policy |
| Old index job follows new content/deletion | Search never regresses to the older generation |
| Membership revoked with stale index data | Newly authorized search/read responses disclose no protected content |
| Two moves would form a cycle | The shared hierarchy protocol rejects an invalid final tree |

I would also load a direct editor URL, rename a page and revisit old links, simulate
unavailable local draft storage, and test composition input. These scenarios connect
visible behavior to actual contracts. A login smoke test is useful but covers none of
the hardest save or search failures.

### Scale after removing unnecessary work

Start by bounding page size, history pages, tree metadata, reply depth, and search cost.
Cache immutable revision payloads after authorization, and scale stateless APIs and
index workers independently. Keep acknowledged reads revision-aware when replicas lag.

Observe conflicts, uncertain mutation outcomes, oldest outbox age, repair backlog, and
commit-to-search visibility. Separate search degradation from page availability. A
healthy process endpoint does not prove PostgreSQL, sessions, and indexing are ready.

Backups protect authoritative content; search rebuilds restore the derived view. Both
need exercises. Clearing queues or recreating the index without a replay/reconciliation
procedure can discard the evidence needed to repair a stale system.

| Decision | Benefit | Cost accepted |
|----------|---------|---------------|
| Separate draft and server snapshot | Background work cannot silently replace typing | Explicit edit-session state |
| Snapshot save with expected revision | Clear conflict and history semantics | Snapshot storage and manual reconciliation |
| Receipt and outbox in one transaction | Recoverable save and indexing outcomes | Extra durable records and workers |
| Revision-bound publication | Approval matches visible content | Distinct authoring and published states |
| Stable IDs and metadata navigation | Renames/moves preserve links and avoid body overfetch | Canonical URL and branch coordination |
| Current authorization before snippets | Stale search cannot decide confidentiality | Bounded authoritative checks |

### Relationship to the local project

The repository combines React/TanStack Router/Zustand with Express, PostgreSQL, Valkey,
RabbitMQ, and Elasticsearch. It implements full snapshot history and several UI
components, but generated page/edit routes sit under parents missing child outlets. The
resulting browser flow is incomplete, and search passes page IDs into slug routes.

The current save API lacks expected revisions and mutation receipts; its post-commit
cache failures can become HTTP errors. The worker can acknowledge swallowed index
failures, and labels/restores/approvals omit necessary updates. Space permissions are
not enforced, HTML is unsanitized, and review is not revision-bound.

The production proposal above addresses those specific boundaries without claiming they
were implemented by a documentation change. The source evidence and setup limitations
are recorded in [architecture.md](./architecture.md#implementation-notes) and
[README.md](./README.md).

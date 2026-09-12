# App Store — frontend system design interview

> “I would build two connected experiences: a fast public catalog and a developer
> console that makes publishing state understandable. The difficult part is keeping
> what the browser says aligned with what the server has actually committed.”

This is a proposed 45-minute design, not a claim that the local demo implements
all of it. I would draw one diagram and spend most of the discussion on three
flows: finding an app, writing a review, and publishing a release.

| Discussion | Minutes |
|------------|---------|
| Scope and user journeys | 5 |
| UI architecture and API contracts | 7 |
| Deep dive: search and navigation state | 9 |
| Deep dive: reviews and honest feedback | 8 |
| Deep dive: developer publication | 9 |
| Performance, accessibility, and verification | 5 |
| Trade-offs and local implementation boundary | 2 |
| Total | 45 |

## 🎯 Scope and user journeys

I would clarify whether this is a browser marketplace or a native app store.
I will assume the browser manages discovery, reviews, and developer submission.
A native installer is a separate client with its own completion signals.

The public journey is search → app detail → eligible release access.
The developer journey is draft → upload → submit → approval → publish.
A review has a third lifecycle: saved, pending moderation, published, or rejected.
Those lifecycles should have different labels and different recovery actions.

The first version supports categories, search filters, app details, review reading
and writing, developer editing, and publication status. Payments and subscriptions
are outside this discussion. If paid apps are required, the server supplies price
and entitlement state; the browser does not infer ownership from a download count.

My main product requirements are:

- Search results must belong to the visible query and filters.
- Returning from detail should restore the search position and selected filters.
- A failed request should preserve a user's review or developer draft.
- The UI should distinguish an accepted mutation from completed background work.
- Keyboard and small-screen users should reach every core action.

I would propose a responsive page shell, useful content on a typical mobile
connection, and bounded memory while browsing many results. I would measure real
user experience before assigning ambitious latency numbers to every component.
Backend latency, image transfer, JavaScript execution, and rendering all contribute.

> “A quick spinner is not the outcome I am optimizing for. I want a user to find
> the right app, trust the displayed state, and recover if their network drops.”

## 🏗️ UI architecture and contracts

I would use React with route-level components and a typed API client.
The public catalog and developer console can share cards, media components, and
form controls while keeping their data caches and permissions distinct.

```
┌────────────────────────────────────────────────────────┐
│ Routes: search, app detail, developer workspace        │
└───────────┬───────────────────────────────┬────────────┘
            │                               │
            ▼                               ▼
┌────────────────────────┐      ┌────────────────────────┐
│ Query cache            │      │ Local drafts / UI      │
│ Keyed server results   │      │ Dialogs, edit state    │
└───────────┬────────────┘      └────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────┐
│ Typed API client: auth, errors, request identity       │
└───────────┬────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────┐
│ Catalog / reviews / publishing API                     │
│ Authoritative revisions and operation status           │
└────────────────────────────────────────────────────────┘
```

The URL owns shareable navigation state: query, category, price filter, sort,
and the current page or continuation position when appropriate.
Server results belong in a query cache, keyed by those inputs.
Unsaved review text, open tabs, and form validation belong in component state.
Small global UI preferences can live in Zustand.

Putting all four kinds of state in one global object is initially convenient,
but makes a loading flag for search interfere with a developer save or app detail.
It also makes ownership unclear when two requests finish out of order.

The server contract needs a few fields that directly support the experience:

| Resource | Fields the browser needs | Why |
|----------|--------------------------|-----|
| Search page | Query identity, results, continuation, ranking snapshot | Associate the page with its inputs |
| App detail | App ID, public revision, release state, compatibility | Render an eligible current release |
| My review | Review ID, revision, moderation state, saved contents | Restore and explain pending work |
| Developer draft | App ID, revision, editable fields, allowed actions | Detect concurrent edits |
| Publication operation | Operation ID, committed status, indexing status | Recover after uncertain responses |

Public app metadata and developer drafts use separate endpoints or explicitly
separate response shapes. A draft must not become public merely because the
browser knows its app ID. Authorization remains a server responsibility.

I would use a small consistent error vocabulary: unauthenticated, forbidden,
validation error, revision conflict, unavailable, and unknown operation outcome.
Different outcomes require different actions; one generic red toast loses that meaning.

## 🔧 Deep dive 1: Search and navigation state

> “I would make the URL the description of the search, and the query key the
> identity of its result. Every response must still belong to that identity
> before the browser treats it as the current page.”

Consider a user searching for “camera,” changing the category, and immediately
opening a result. The original search can finish after the filtered search.
Without request identity, the original response replaces the visible list and
makes the selected category appear ineffective.

I would normalize the search inputs once and derive both the request and cache
key from that representation. Changing a filter resets pagination. A response is
stored under the key that created it, not whichever key happens to be current.
Aborting obsolete requests saves work, but correct keying remains necessary:
an aborted request may already have completed at the server.

### Search interaction

I would start with explicit search submission for full results.
Optional autocomplete can use a short debounce and a smaller response budget.
A user selecting a suggestion commits a new URL; typing alone need not rewrite
browser history for every character.

The results panel can keep the previous list visible during a refinement, with a
clear updating indicator. It must not imply that old results satisfy new filters.
For a substantial query change, a scoped skeleton may be less confusing.

A failed search gets an error and retry action for that same query.
“No matches” is reserved for a successful response with zero results.
This distinction matters when search depends on a separate index service.

### Pagination and restoration

For the first release, I would use explicit pages or a Load more control.
They are easy to explain, navigate with a keyboard, and restore after detail.
Infinite scrolling is useful when discovery is the primary interaction, but it
requires more careful history, focus, and memory management.

The server must supply stable ordering with a tiebreaker. If relevance changes
between pages, the browser cannot reliably deduplicate its way to a complete list.
For a long search session, a ranking snapshot plus continuation token provides
more predictable results than offsets over a constantly changing ranking.

On returning from detail, I would restore the prior query key, loaded pages,
and a scroll anchor based on an app ID and offset. That is more robust than an
absolute pixel position when images or responsive columns change height.
If the anchor no longer exists, fall back to the nearest retained page position.

I would bound retained pages and invalidate a continuation when the query changes.
A cache is not an instruction to retain every result a user has ever seen.
The storage budget should follow the expected session length and device class.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ URL plus keyed server cache | Shareable searches, safe overlapping requests, back navigation | Key design and invalidation rules |
| ❌ One global current-results slot | Small initial implementation | Late responses overwrite unrelated pages |
| ❌ URL as storage for all UI state | One apparent source of truth | Draft text and transient controls leak into navigation |

The key distinction is who owns a value. The URL owns the search request,
the server owns its results, and the user owns unsaved input.
Keeping these boundaries costs some coordination but makes races understandable.

### App detail loading

I would load essential metadata first and allow reviews and similar apps to fail
independently. A recommendations timeout should not hide an otherwise valid app.
The detail cache includes app identity; a response for app A must never appear
under app B's heading after rapid navigation.

Public details can remain briefly cached, but the acquisition action revalidates
release eligibility at the server. The browser can display “This release is no
longer available” if a withdrawal occurred since the detail page was loaded.

## 🔧 Deep dive 2: Reviews and honest feedback

A review has user-authored text and server-owned publication state.
I would preserve that distinction throughout submission and moderation.
It allows the UI to feel responsive without claiming that unreviewed content is public.

The user selects a rating, writes text, and presses Submit.
The browser validates basic length and required fields, then sends an identified
operation. It keeps the draft until the server acknowledges a saved review.
Disabling duplicate clicks helps usability but does not provide server idempotency.

### What the user sees

| State | User-visible meaning | Appropriate action |
|-------|----------------------|--------------------|
| Draft | Text exists only in the editor or local draft storage | Continue editing |
| Sending | A request is in progress | Keep text; avoid duplicate submission |
| Outcome unknown | Connection failed after sending | Check the existing operation |
| Pending | Server saved the review for moderation | Show the author's saved review and status |
| Published | Review is eligible for the public list | Show returned revision; refresh related views |
| Rejected | Server made a moderation decision | Explain allowed correction or appeal |

I would not optimistically add a new review to the public rating average.
The server may hold it pending, reject it, or return a previous result for a retry.
Updating the author's private “My review” panel gives immediate feedback without
inventing a public contribution.

If submission times out, I would query the operation or the account's current
review before offering a new submission. Reusing the same operation identity is
necessary when the first attempt may have committed.

### Editing while moderation is running

Suppose review revision 1 is pending and the user changes its text and stars.
The UI sends revision 2 with the expected prior revision.
A later moderation result for revision 1 must not mark revision 2 as approved.
The server owns this check; the browser displays the returned current revision.

The editor should also protect against a background refresh overwriting unsaved
text. I would keep server data and the local draft separately, then show a conflict
when the saved revision changes under the editor.

For helpful votes, I prefer a desired-state operation such as “my vote is helpful”
to an ambiguous toggle. That permits optimistic rendering and safe retry against
a server-enforced account/review uniqueness rule.
A failed request restores the prior confirmed state and leaves a visible retry.

### Refreshing related views

After a confirmed mutation, update the returned review and invalidate the affected
review page and rating summary. The server may return a rating revision or freshness
marker if aggregates update asynchronously. I would not claim exact agreement
between a fresh review and a stale search card during that propagation interval.

Pending decisions can use bounded polling while the relevant panel is open.
A WebSocket connection for every catalog visitor is unnecessary for this workflow.
If moderators need a high-volume live queue, that can justify a separate stream.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Immediate private receipt, server-confirmed public state | Responsive feedback with truthful moderation status | More explicit UI states |
| ❌ Optimistically publish every review | Fast apparent success | Rejected content and false rating totals flash publicly |
| ❌ Wait silently for full moderation | Simple public-state model | Slow or uncertain submission experience |

> “I would make the user's contribution feel safely saved as soon as it is saved.
> I would reserve the word published for the actual publication decision.”

## 🔧 Deep dive 3: Developer publication

The developer console is a workspace for durable work, so failure recovery matters
more than making every button complete instantly. I would separate metadata
editing, artifact upload, review submission, and public publication.

A draft editor starts with a server revision and creates a local editable copy.
Saving sends the expected revision. If another tab or teammate changed the draft,
the server returns a conflict and the UI preserves both the user's input and the
latest saved data for comparison.

For a small console, explicit Save is easier to reason about than continuous
background autosave. Autosave can be added later with serialized revisions and
clear saved/saving/error feedback. A debounce alone does not prevent stale writes.

### Upload and submission

Large package bytes should go directly to object storage under a server-issued
upload session. The browser displays transfer progress and can resume or retry
parts if the upload contract supports it.

Reaching 100% uploaded means bytes were transferred; it does not mean the release
was scanned, approved, or published. After completion, the server verifies the
object and starts validation. The UI should show those stages separately.

The submission binds a metadata revision to an immutable artifact digest.
If the developer edits the description or changes the binary after approval,
the previous approval cannot silently apply to the new contents.
The UI can show a new draft alongside the currently published release.

I would expose allowed actions from server state, while retaining server checks
on every command. Hiding a Publish button is guidance, not access control.

### Recovering an uncertain publication

The developer presses Publish, then loses connectivity.
I keep the operation identity and show “Checking publication status.”
On reconnection, the browser retrieves that operation or the current release.
It does not immediately send an unrelated second publication.

A successful response can say the release is published while search indexing is
pending. The app's direct public detail may work before it appears in search.
Showing both states prevents unnecessary repeat publishing and support confusion.

A withdrawal should be a distinct action with explicit consequences.
The browser refreshes the release state after confirmation and the server rejects
new access grants. Existing signed URLs may remain valid until expiry, so the
product must define the withdrawal window rather than promise instant recall.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Revisioned drafts and tracked publication operations | Safe concurrent editing and recovery after lost responses | Conflict UI and operation status |
| ❌ One mutable app object with a publish boolean | Few screens and fields | Approval can refer to changed contents; retries are ambiguous |
| ❌ Browser-controlled publication steps | Flexible interface | Closing a tab can strand critical work |

The server owns the workflow after acceptance. The browser can close and later
reconstruct its state from saved revisions and operations.
That makes reliability part of the API contract rather than a long-lived tab's job.

## ⚡ Performance, accessibility, and verification

I would prioritize small initial JavaScript, route-level loading, and appropriately
sized images. Public pages benefit from server-rendered metadata or prerendering
when discoverability matters; the authenticated developer workspace can be a SPA.
This adds rendering complexity, so I would choose it based on traffic and indexing needs.

For short pages of 20 results, ordinary rendering is usually sufficient.
If measured long-list cost grows, virtualize the results with stable item keys,
measured heights where needed, and a deliberate focus strategy.
Virtualization reduces DOM work; it does not fix oversized images or slow API queries.

App cards should be real links, and action buttons should have distinct labels.
Star ratings need a numeric accessible name. Review errors should be associated
with their fields, and submission status should be announced without stealing focus.
Developer dialogs need focus management, Escape behavior, and draft preservation.
A small screen needs actual navigation, not merely hidden desktop controls.

My most useful tests would exercise failure and identity boundaries:

- A slow old search cannot replace the current filtered results.
- Returning from detail restores the correct query and scroll anchor.
- A lost review response retains the draft and resolves the existing submission.
- An obsolete moderation result cannot change the displayed newer review revision.
- A developer conflict preserves unsaved text, and reload restores an active operation.

I would measure search-to-result time, detail rendering, failed mutation recovery,
and draft loss separately. Page-shell smoke tests do not establish these behaviors.

## ⚖️ Trade-offs and implementation boundary

The design spends complexity on query identity, review publication state, and
revision-bound developer work. These are the places where an attractive interface
can otherwise tell the user something that never happened.

The local project provides React routes, Zustand stores, search/detail pages, and
a developer metadata console. It does not use a query library, virtualized lists,
server rendering, or a completed release workflow. Get buttons and public review
writing/voting are not connected; search pagination controls do not change pages.

Only the session ID is persisted and no startup caller restores the user.
Shared result slots lack request-context guards, and developer replies clear text
before acknowledgement. The backend also has a new-review schema mismatch and
incomplete publication/indexing semantics, documented in the
[architecture](./architecture.md#implementation-notes).

> “For the first implementation pass, I would make browsing identity-safe and
> developer saves recoverable, then connect reviews and publication through the
> explicit server states we agreed on. That gives each visible action a meaning
> we can test.”

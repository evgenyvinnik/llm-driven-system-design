# Facebook Post Search — Frontend System Design Answer

A 45-minute proposal for a social-post search experience. It extends the local demo; the
final checkpoint identifies the actual implementation boundary.

## 🎯 Start With the Searcher's Intent — 4 minutes

> “The user is trying to find a post they remember, or discover something relevant. My job is to keep their query and results understandable while requests, permissions, and filters change.”

I would start with keyword and hashtag search, date/type/author filters, suggestions,
highlighted snippets, and a way to continue through results. Public posts can be searched
anonymously; signed-in users can also retrieve posts permitted by their relationships.

I would clarify exact-phrase behavior and what Friends means. For this design, it means an
accepted relationship. Friends-of-friends and groups are extensions because they change
the authorization and suggestion contracts, not merely the filter menu.

The first version uses suggestions while typing and submits the full search on Enter,
suggestion selection, or Apply. That keeps expensive result retrieval tied to an explicit
intent. Search-as-you-type can be a later product choice with its own traffic budget.

| Requirement | Meaning in the proposal |
|-------------|-------------------------|
| Typing | Immediate local feedback, independent of requests |
| First results | Target within one second on a defined device/network |
| Correctness | Old requests cannot replace a newer search |
| Privacy | Current server checks; account-scoped client state |
| Pagination | Continue a bounded stable search session |
| Recovery | A page failure preserves already accepted results |
| Accessibility | Keyboard operation, clear labels, useful announcements |
| Resources | Bound pages, snippets, requests, and media work |

These are goals, not measured performance. I would ask whether Back must restore the same
result or merely rerun the query, and whether query URLs should be shareable. A shared
query represents intent; it never grants another viewer access to the same results.

Media previews, post details, and saved searches can follow the core search flow. I would
avoid spending the first interview on a full social-network composer or video platform.

## 🏗️ Architecture and State Ownership — 5 minutes

```
┌────────────────────────────────────────────────────────────┐
│ Query + filter drafts / accessible suggestions             │
│ Committed route intent + account generation                │
└─────────────────────────────┬──────────────────────────────┘
                              ▼
┌────────────────────────────────────────────────────────────┐
│ Request controller: identity / pages / bounded cache       │
│ Safe snippets + result list + reading anchor               │
└─────────────────────────────┬──────────────────────────────┘
                              ▼
┌────────────────────────────────────────────────────────────┐
│ Search API: fixed session / current access / ranking       │
└────────────────────────────────────────────────────────────┘
```

I would use React and TypeScript with a router and a small store or query-cache layer. The
framework choice matters less than identifying who owns draft input, committed intent,
request identity, and result pages.

| State | Owner | Lifetime |
|-------|-------|----------|
| Raw query and filter edits | Controls | Until commit or discard |
| Committed query/filter/sort | Route/controller | One search intent |
| Viewer and auth generation | Auth boundary | One account session |
| Search-session cursor/pages | Result controller | Bounded server/client session |
| Suggestion request/options | Combobox | Current input generation |
| Focus and reading anchor | View state | Current navigation context |

The API owns ranking, authorization, query parsing, and pagination semantics. Cards
display safe snippets and return interaction intent; they do not construct cursors or
decide who may read a post.

A normalized result model can separate post identity from page order. However, a search
snippet is query-specific: two searches for the same post can highlight different text.
Keep match fragments associated with their query/page context rather than overwriting one
global snippet field by post ID.

The URL can hold committed query and filters. Keep access tokens, private result payloads,
and PIT identifiers out of it. Sort multi-select filter values deterministically so
equivalent intent has the same key; do not lowercase or discard punctuation if that
changes the chosen query language.

I would commit browser history for explicit searches and use a deliberate policy for
filter refinements. Every keystroke should not create a Back entry. Raw text stays local
until the user commits.

## 🔍 Deep Dive 1: Request Identity Is the Correctness Boundary — 10 minutes

### Debounce and cancellation solve different problems

Typing “co” then “coffee” can create overlapping requests. If the older response is
slower, it can overwrite the newer suggestions or results. A debounce reduces request
count, but does not decide which response is allowed to update the screen.

I would debounce suggestions by roughly 200 ms, starting with that as a tuning value.
Enter bypasses the suggestion timer and submits the full query. During IME composition,
wait for committed composition rather than treating every intermediate input as a complete
search term.

Cancellation reduces wasted network/server work when supported. It is still possible for a
completed response or application callback to race with abort. Every commit therefore
checks an explicit generation.

| Identity part | Why it is needed |
|---------------|------------------|
| Account generation | A response from the previous viewer must be discarded |
| Committed search key | Query, filters, locale, and ranking mode travel together |
| Search generation | A newer repetition of the same query can supersede an older one |
| Page/session cursor | Continuation belongs to the current search |
| Suggestion generation | Options must match the current draft text |

An account switch increments the generation, aborts pending requests, and clears protected
pages/history. Merely emptying an array is insufficient if an old request can populate it
again a moment later.

### Draft filters must not change an existing page request

Suppose the user searched for coffee, opened Filters, and selected Photos without pressing
Apply. If the store immediately changes the filters used by Load More, page two can use
Photos with the cursor from the old unfiltered search.

The client now has a mixed list even though both responses were individually valid. This
is not a network race; it is an ownership mistake.

I would keep draft filter choices separate. Apply commits a new intent and resets the
search session. Cancel restores the committed selections. Load More always captures the
committed query/filter tuple and its cursor.

The same rule applies to a person suggestion. If it means “posts by this person,” it
should commit a stable author ID filter. Sending only their display name as ordinary query
text expresses a different search.

### Keep request states independent

A new search, the next page, and typeahead have different purposes. One global
isLoading/error pair is too coarse: a failed suggestion should not hide a successful
result list, and a failed next page should not erase page one.

| State | Display |
|-------|---------|
| No committed search | Welcome/recent-search surface |
| First page loading | Query heading and progress state |
| First page empty | No matches for this committed intent |
| First page unavailable | Retry/edit query; not “no results” |
| Next page loading | Existing cards plus inline progress |
| Next page failed | Existing cards plus retry for that cursor |
| Suggestions failed | Full search remains available |

For a new query, I would initially replace the result area with a clearly labeled loading
state. Retaining old results is also possible, but their old query must remain visible;
otherwise the new heading appears to describe unrelated content.

Allow one next-page request per active cursor. Repeated clicks should not launch duplicate
appends. On a definite page error, retry the same cursor within the same valid session; an
expired session requires a new search.

| Choice | Benefit | Cost |
|--------|---------|------|
| ✅ Explicit result submission + debounced suggestions | Predictable intent and request volume | One deliberate action before full results |
| ✅ Identity checks plus cancellation | Correct under reordered responses | More lifecycle state |
| ❌ Cancellation alone | Small implementation | Completed callbacks can still race |
| ❌ Mutable filters shared with pending pagination | Fewer state fields | Pages can belong to different searches |

> “I can change the debounce duration without changing correctness. I cannot remove the account/search identity check and still promise that the visible result belongs to the current intent.”

## 🔍 Deep Dive 2: Search Privacy Includes the Browser and Suggestions — 10 minutes

### A result cache is not an access grant

The backend can use indexed visibility tokens to reduce candidate work, but it must verify
current access before returning protected content. The browser should not infer
authorization from a Friends icon or an old successful response.

I would scope retained state by viewer and search session. On navigation/resume,
revalidate protected cached results before displaying them again. On a known
removal/revocation event, remove affected content immediately and reconcile the active
session.

A server cannot recall bytes the user already downloaded. The useful contract is current
checks for new responses, prompt active-view removal where possible, and no deliberate
replay of stale private data from a persistent offline cache.

This is why I would start with a small in-memory result cache rather than persisting
private result JSON in a service worker or localStorage. Losing instant offline results is
a reasonable cost for a simpler privacy lifecycle in the first version.

### The same boundary applies to suggestions and counts

A hidden post can leak through a suggested hashtag even when its result card is filtered
out. Similarly, turning every user's query into a public trending term can disclose
sensitive search intent.

I would ask the API to label suggestion scope and type. Shared suggestions come from an
explicitly public-safe corpus. Personal history is per viewer; directory results follow a
defined directory policy. A single prefix-only cache is insufficient if signed-in and
anonymous responses differ.

An exact-looking total is also a response about content. If the server excludes
stale/private hits after retrieval, it should not display the earlier candidate count as
the number of posts the viewer can actually read. “20 results loaded” and a continuation
affordance are often enough.

Thresholds and time windows can improve a public trend pipeline, but a simple popularity
threshold is not a proof that private terms are safe to publish. The product needs a
policy for what enters that corpus.

### Highlights are untrusted data

A post author controls the text being highlighted. Wrapping matching terms in em tags does
not sanitize the rest of the snippet. A raw fallback substring can be just as unsafe as
highlighted HTML.

I would prefer a response with text plus typed highlight spans or fragments. The client
validates bounds, ordering, and the agreed offset unit, then renders text nodes with
marked ranges. UTF-16 offsets and Unicode code-point offsets are not interchangeable for
every character.

If ranges are invalid or the content version changed, display escaped plain text without
highlights. Do not apply offsets from an old indexed revision to newly edited canonical
text. The server should keep content and highlights tied to one authorized revision.

An encoded/allowlisted HTML contract is an alternative when integrating an existing search
engine. It requires the encoder, sanitizer policy, and fallback path to be covered
together; “the HTML came from our server” is not a sufficient trust argument.

| Decision | Why it fits | Cost |
|----------|-------------|------|
| ✅ Viewer-scoped in-memory results | Clear invalidation and account boundaries | Less offline reuse |
| ✅ Structured snippets | Untrusted text stays text | Range/version contract and validation |
| ❌ Persistent private stale-while-revalidate cache | Instant redisplay | Can expose content after access changes |
| ❌ Trust search filtering for all suggestions/counts | Simple endpoints | Auxiliary responses can reveal hidden information |

### Accessibility makes the state understandable

The input has a visible label and combobox semantics when suggestions are present. Arrow
keys move an active option, Enter chooses it or submits the draft, Escape closes the
popup, and focus remains in the input while options change.

Use stable option identities rather than array position. A late refresh should not
silently change the meaning of the currently active option. Announce concise
loading/result status politely, not every suggestion arrival or all snippet text.

Filter selections need native checked/pressed semantics and meaningful date labels. A
mobile dialog has a predictable focus return and explicit Apply/Cancel; a visual popover
alone does not establish keyboard behavior.

> “Privacy and accessibility both depend on honest state. The UI should make clear whose query is committed, what is loading, and which content the current response actually permits us to display.”

## 🔍 Deep Dive 3: Stable Continuation and Bounded Rendering — 9 minutes

### A cursor string does not establish stable ranking

An API can call the string “20” a cursor while still implementing offset paging. New index
refreshes can shift the list between requests, causing repeated or omitted posts.

A score-plus-ID cursor resolves equal-score ties but does not freeze a changing ranking.
Client deduplication can hide repeated IDs; it cannot recover a result the server skipped
before sending it.

For this proposal, the server gives a short-lived search session backed by a point in time
and fixed query/ranking context. The browser treats its next cursor as opaque and
preserves returned order. New query, filter, account, or ranking-mode changes start a new
session.

Permissions remain current, so some old candidates may disappear. The server advances
through examined positions and reports explicit expiry/reset or partial work rather than
silently interpreting an old cursor against a new ranking.

The client should distinguish the end of this selected search session from an assertion
that no matching post exists anywhere. Suggest refinement when the result horizon or work
budget is reached.

### Start with a bounded list; virtualize when measured cost warrants it

The first page is twenty text snippets. That is a reasonable ordinary list. As users
accumulate pages or media previews are added, measure DOM/layout cost and introduce
windowing if it materially helps.

Virtualization bounds mounted rows, not stored arrays, decoded images, or every query ever
visited. I would separately cap retained pages, for example five pages near the reading
anchor, with controlled reload within the same valid session.

| Resource | Initial policy to validate |
|----------|----------------------------|
| Working result pages | Five pages around the anchor |
| Query cache | Small viewer-scoped memory budget, no private persistent payloads |
| Mounted rows if virtualized | Viewport plus a small measured overscan |
| Media | Known dimensions, responsive sources, lazy loading |
| Next-page requests | One per active cursor |
| Abandoned search sessions | Close or expire promptly |

If cards vary in height, reserve image aspect ratios and measure actual row heights. Key
measurements by stable post/result identity, not by array index. Keep query-specific
snippets associated with that search even if post metadata is normalized globally.

Windowing removes off-screen content from the DOM, affecting find-in-page and
screen-reader navigation. Retain a focused row within a small explicit budget or
deliberately move focus before disposal. Do not retain every previously focused card
forever.

### Back should return to content, not just a number

When opening a future detail route, save the committed intent, session identity, page
references, anchor result ID, and offset within it. A bare scrollTop value is unreliable
after images load or rows disappear.

On return, restore compatible retained pages after any required access revalidation, then
measure around the anchor. If the server session expired, rerun the query and explain the
reset. A shared URL should rerun under the recipient's identity rather than recover the
sender's private session.

This costs more state than discarding the list on every navigation. It pays off when
readers inspect multiple candidate posts and need to compare them without repeatedly
scrolling from the top.

| Choice | Benefit | Cost |
|--------|---------|------|
| ✅ Server session + opaque cursor | Explainable ranked continuation | Expiry and bounded server resources |
| ✅ Bounded pages with content anchor | Predictable memory and Back behavior | Reload/remeasurement logic |
| ❌ Cursor name alone | Simple API surface | May hide offset instability |
| ❌ Keep every page/card mounted | Easy local state | Unbounded long-session resources |

## 🧪 Contracts, Tests, and Scaling — 5 minutes

| API concept | What the frontend needs |
|-------------|--------------------------|
| Search intent | Canonical query/filter echo and search identity |
| Page | Ordered results, session cursor, expiry, continuation/partial state |
| Result | Stable ID, authorized revision, safe snippet, action hints |
| Suggestion | Stable option ID, type, scope, display text, committed action |
| Error | Unavailable, invalid input, expired session, or permission change |

The client should not need raw ranking features or database schema to render a useful
search result. A raw score is useful in a diagnostic tool, but not a product explanation
of relevance or a probability of correctness.

I would test sequences, not just whether a static result appears:

1. An old query completes after a new one: only the new identity commits.
2. A filter draft changes before Apply: Load More still uses committed filters.
3. Logout occurs during a private search: the response cannot repopulate state.
4. Page two fails: page one remains and retry targets the same cursor.
5. A snippet contains markup or mismatched ranges: text stays safe and readable.
6. A session expires during Back: the UI explains a restart.
7. Keyboard focus sits on a result during page eviction: navigation stays coherent.

Use store-level assertions for request identity and merging, and browser tests for focus,
layout, and navigation. Virtualization tests should control viewport and scroll instead of
assuming every result is mounted.

Measure typing delay, suggestion latency, request-to-result time, commit-to-paint, memory
growth, and page retries separately. Avoid raw queries/snippets in ordinary telemetry;
hashing a predictable search term does not make it anonymous.

At scale, suggestions can outnumber submitted searches. With four suggestion requests per
submission, optimizing the small endpoint can matter as much as optimizing the full result
query. Debounce, coalescing, and scoped cache keys reduce unnecessary work without
weakening correctness.

## 📝 Close and Local Checkpoint — 2 minutes

> “I separate draft input from committed search intent, protect every response with account/search identity, and rely on the server for stable continuation and current access. Rendering stays bounded, and snippets remain untrusted text.”

The local demo has Enter-to-search, per-keystroke suggestions, filters, a Load More list,
and an admin dashboard. It has no debounce/cancellation, query URL state, request
generations, bounded page cache, virtualizer, or structured highlight contract.

Filters mutate the store before Apply, late responses can replace newer results, and
logout leaves search state behind. Snippets enter dangerouslySetInnerHTML directly. User
suggestions submit display-name text, and the recent-history SQL is invalid.

The backend returns an offset string, trusts indexed privacy, and uses inconsistent rules
on other post endpoints. The [architecture](./architecture.md#implementation-notes)
documents those source findings; the [README](./README.md) describes actual setup and
fixtures. This review did not benchmark or run the full application.

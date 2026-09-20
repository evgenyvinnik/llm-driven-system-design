# Google Search: frontend system design interview

A 45-minute spoken outline for a proposed web-search frontend.
The implementation comparison at the end describes this repository separately.

## 🎯 Requirements and scope — 4 minutes

> “I would design the experience around two actions: refining a query and reading its results.
> Typing should remain responsive even when the network is slow.
> A submitted query should have a shareable URL, and the results must belong to that query.”

I would first agree on ordinary text search rather than add image search,
voice input, personalized ranking, or generated answers to the initial scope.
The main screens are a home search box and a results page.

The supported query language includes quoted phrases, excluded terms, and a site filter.
The server owns interpretation of those operators.
The browser can explain them without implementing a second search engine.

| Requirement | User-visible behavior |
|---|---|
| Autocomplete | Suggestions while typing; accepting one is an explicit action |
| Results | Ranked links with readable titles, excerpts, and honest count labels |
| Navigation | Next/Previous, bounded page jumps, Back, Forward, and shareable query URLs |
| Accessibility | Keyboard, screen reader, touch, zoom, and composition input |
| Slow network | Input stays usable; loading, error, and stale results remain distinguishable |
| History | Optional bounded recent searches with a clear removal control |

I would target result paint within 500 ms on a representative connection,
with API latency measured separately from network and rendering.
For suggestions, I would start with a 200 ms debounce and measure the complete delay.
These are proposed budgets, not guarantees that a particular library provides.

The corpus could contain 100 million pages while a result page contains ten items.
That distinction keeps backend scale from unnecessarily complicating the DOM.

## 🏗️ High-level architecture — 6 minutes

> “I would draw the visible components first, then the state each one owns,
> and finally the boundary through which they request server data.”

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                    │
│                                                                                            │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Search box + popup     │     │ Results + pagination   │     │ History controls       │  │
│  │ Keyboard / touch       │     │ Safe text / links      │     │ Clear / opt out        │  │
│  └────────────────────────┘     └────────────────────────┘     └────────────────────────┘  │
│                        ▲                              ▲                              ▲     │
│  type / suggest        │        navigate / render     │        read / clear          │     │
│                        │                              │                              │     │
│                        ▼                              ▼                              ▼     │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Input state            │     │ Search model           │     │ Local preferences      │  │
│  │ Draft, selection, IME  │◀───▶│ URL + active request   │◀───▶│ Bounded recent queries │  │
│  └────────────────────────┘     │ Window / page / expiry │     └────────────────────────┘  │
│                        ▲        └────────────────────────┘                                 │
│                        │                              ▲                                    │
│                        │                              │                                    │
│                        ▼                              ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Data access coordinator                                                              │  │
│  │ Separate suggestion/search keys, cancellation, response guard, bounded cache         │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
│                                              ▲                                             │
│                                              │                                             │
└──────────────────────────────────────────────┼─────────────────────────────────────────────┘
                                               │
                                               │  HTTPS requests / typed responses
                                               │
                                               ▼
   ┌──────────────────────────────────────────────────────────────────────────────────────┐
   │ SEARCH API (server boundary)                                                         │
   │ Search: ranked page + freshness/status | Suggestions: prefix + version               │
   └──────────────────────────────────────────────────────────────────────────────────────┘
```

I would walk through a single interaction before discussing libraries:

1. Typing changes input state and schedules a suggestion request.
2. Enter or a suggestion click commits a query to the URL and resets the page.
3. Navigation derives a new search key and starts a request through data access.
4. Only a response matching the active key can update the result model.
5. The results view renders safe text and exposes navigation for that response.

On Back or a later page, I would reuse a matching, unexpired result window.
If that window is gone, preserve the query and explicitly restart its results rather
than append a different ranking generation. A shared URL preserves search intent;
it does not promise the same results forever. Suggestions and optional local history
keep their own lifetimes and cannot overwrite the submitted search.

The two vertical request paths are intentionally separate.
Suggestion failure should not prevent a submitted search.
History is also separate: it is a browser preference, not authoritative server data.

I would use React components for views, a router for navigation state,
and a small shared store only where state crosses component boundaries.
A server-data library could provide caching and cancellation,
but the state ownership and response guard must be correct regardless of library.

The server side is deliberately one boundary on this whiteboard.
It is responsible for query semantics, ranking, counts, and freshness metadata.
The frontend does not need to know the crawler's partition scheme.

## 💾 State and interface contracts — 5 minutes

### State ownership

| State | Owner | Persistence |
|---|---|---|
| Text being edited | Search input | Local to the active interaction |
| Highlighted suggestion | Popup state | Reset when suggestion context changes |
| Submitted query and requested page | Router | URL / browser history |
| Current results and status | Search model | Memory, keyed by full request context |
| Result window handle | Navigation session | Short-lived; not a permanent bookmark |
| Recent searches | User preference | Optional bounded local storage |
| Crawl progress | Admin feature | Server-owned job status in a production extension |

I would not mirror every keystroke into the URL.
That would fill history with unfinished queries and make Back behave unexpectedly.
The URL changes on submit or page navigation.

A result cache key includes the interpreted search context, page size, and page/window.
If locale or safety filters exist, they belong in that key too.
The server supplies the corpus and ranking version used for a response.

### API contract

| Method | Proposed endpoint | Purpose |
|---|---|---|
| GET | `/api/search` | Query, page size, optional window/page; return one ranked page |
| GET | `/api/search/autocomplete` | Prefix and locale; return bounded suggestion text |

The result response includes safe text fields, destination URLs,
highlight spans, count value and relation, and navigation expiry.
It also distinguishes a complete result from a partial retrieval or service failure.

I would validate response shape at the network boundary.
TypeScript types document expectations but do not validate received JSON.
A malformed response should produce a recoverable error rather than corrupt the store.

For shared links, the guarantee is “run this search.”
The same URL tomorrow may show different documents.
A temporary window handle preserves a browsing session, not permanent search history.

## 🔧 Deep dive: responsive, accessible autocomplete — 8 minutes

### Decision

> “I would keep typing synchronous and make suggestions advisory.
> Debouncing controls work; request identity controls correctness.
> I need both.”

Consider the user typing “java,” then “javascript.”
The second request can finish first.
If the older response arrives later, it must not replace the current suggestions.

### Interaction sequence

1. Update the input text immediately.
2. Clear the selected option when the text or suggestion context changes.
3. Wait for a brief pause before requesting suggestions for a sufficiently long prefix.
4. Associate the request with a generation and normalized prefix.
5. Abort superseded requests where possible.
6. Accept a response only if its generation and prefix remain current.
7. Close the popup on submit or dismissal and invalidate outstanding popup work.

Aborting saves resources but is not proof that a response cannot arrive.
The generation check is the final protection against a stale update.
A late failure must not clear a newer successful suggestion list either.

### Trade-off

| Approach | Benefit | Cost |
|---|---|---|
| ✅ Debounce + response guard | Responsive typing with bounded work and correct suggestions | Timer, cancellation, and lifecycle state |
| ❌ Fetch after every keystroke | Earliest possible request | Many intermediate requests; still needs race protection |
| ❌ Debounce alone | Easy implementation | Already-sent requests can arrive out of order |

I would start at 200 ms, not claim an universal optimal delay.
A pause longer than the debounce interval can still trigger one request per character.
Savings depend on typing rhythm, cache reuse, and network behavior.
I would tune against measured request volume and time to a useful suggestion.

### Keyboard and composition

The input remains the focus owner while a listbox exposes suggestions.
A programmatically associated active option communicates the current selection.
Arrow keys change that option; Enter accepts it or submits the typed query.
Escape dismisses the popup without destroying the user's text.
Tab preserves ordinary navigation to the next control.

This follows the [WAI-ARIA combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
I would test the implementation with keyboard and screen reader combinations,
not equate a few ARIA attributes with conformance.

Composition matters for users entering text through an input method editor.
Enter during composition should confirm the composed text, not submit the form.
Only the completed composition participates in our normal search action.

Mouse, touch, recent-history, and server-suggestion selection should use one action.
That avoids a click selecting a different value from keyboard Enter.
The form also has one submission owner to avoid duplicate requests.

### Failure behavior

If suggestions are unavailable, the user can still type and submit.
I would avoid a large error banner for every failed prefix request.
A small status message or simply closing the unavailable suggestion section is enough.

I would announce meaningful suggestion availability without reading every keystroke.
Loading should not move focus or repeatedly steal the active option.
If history appears, label it as local history rather than server recommendations.

## 🔧 Deep dive: navigation, request races, and expiry — 8 minutes

### Decision

> “The URL owns submitted search intent.
> The result model owns a response for a particular request.
> I would never display an older response as if it answered a newer URL.”

The request key includes query, page/window, page size, and relevant filters.
Every navigation receives a monotonically increasing request generation.
The result, loading flag, and error are committed only for that generation.

This also covers a subtle case: request A fails after request B succeeds.
Ignoring only stale successful responses would still let A overwrite B's status.
The guard applies to every completion path.

### A concrete race to draw

```
┌────────────────────────┐          ┌────────────────────────┐
│ Search A: java         │          │ Search B: python       │
│ generation 41          │          │ generation 42          │
└────────────────────────┘          └────────────────────────┘
            │                                   │
            │                                   │
            │  late                             │  first
            │                                   │
            ▼                                   ▼
┌────────────────────────┐          ┌────────────────────────┐
│ Response arrives       │          │ Response arrives       │
│ 41 is no longer live   │          │ 42 is still current    │
└────────────────────────┘          └────────────────────────┘
            │                                   │
            │                                   │
            │                                   │
            │                                   │
            ▼                                   ▼
┌────────────────────────┐          ┌────────────────────────┐
│ Ignore result / error  │          │ Commit B + status      │
│ Keep B visible         │          │ Render Python page     │
└────────────────────────┘          └────────────────────────┘
```

### Stable pages

The proposed backend returns a short-lived ordered result window.
Next and Previous refer to that window, avoiding repeated or skipped results
when the underlying index changes during navigation.

The frontend can retain visited pages and their scroll positions in a bounded cache.
Back restores the matching page if still valid.
A fresh URL without a valid window asks the server to run the search again.

| Approach | Benefit | Cost |
|---|---|---|
| ✅ URL intent + bounded result window | Shareable queries and stable in-session ordering | Explicit expiry and some server/client cache state |
| ❌ Global unkeyed result object | Smallest amount of state | Races and Back navigation can show mismatched results |
| ❌ Fresh offset query for every page | Simple direct page jumps | Index changes can repeat or skip documents |

The trade-off is a visible expiry case.
I would retain the query and explain that results have changed,
then let the user restart without losing what they typed.
A missing cache entry is not permission to silently attach new results to an old window.

### Loading and errors

For a new query, show a reserved result area and a clear loading state.
For same-query page navigation, retaining the old page briefly may reduce visual churn,
but it must remain labeled as the previous page and must not pretend to be current.

An empty response means the completed search found no matches.
An unavailable response means we do not know the answer.
A partial result needs a visible label and honest count semantics.

On an explicit error, keep the submitted query editable and provide Retry.
Avoid automatic retry loops for every query; they amplify overload.
For rate limits, respect retry timing while continuing to allow local editing.

## 🔧 Deep dive: safe, readable result rendering — 7 minutes

### Decision

> “I would let the server choose passages using its matching context,
> but let the client render ordinary text with permitted highlight spans.
> Crawled markup is not trusted UI.”

The server knows the stemmed terms, phrase matches, and document positions.
Reconstructing highlights from the raw query in the browser can disagree with ranking.
Sending full documents also wastes bandwidth and exposes irrelevant content.

I would request a bounded excerpt and validated highlight offsets or text segments.
The browser renders text and wraps highlighted runs using its own elements.
Invalid spans fall back to plain text.
Destinations are checked against permitted link schemes before being rendered.

### Trade-off

| Approach | Benefit | Cost |
|---|---|---|
| ✅ Server passages + client text rendering | Consistent matching and a small trusted rendering surface | Shared span/segment contract |
| ❌ Insert server highlight HTML directly | Convenient and preserves formatting | Crawled or fallback text can become executable markup |
| ❌ Send full pages and highlight locally | Maximum client flexibility | Bigger responses and duplicated matching logic |

The chosen approach gives up arbitrary rich formatting inside search snippets.
That is acceptable for ordinary text results.
If later result types need rich cards, they get explicit component contracts.

### Keep the list simple

Ten text results do not justify virtualization.
A normal semantic list supports reading order, browser find, selection,
assistive technologies, and stable keyboard navigation with less coordination.

I would use responsive widths, wrapping titles, and bounded excerpts.
Long URLs should not push controls off screen.
Provide visible focus styles and named search/clear/navigation buttons.
The result count should say “about” or “at least” when the backend reports uncertainty.

The age label must describe what it measures.
“Fetched yesterday” is different from “published yesterday” or “indexed yesterday.”
I would avoid presenting internal PageRank numbers as a promise of result quality.

### Rendering strategy

I would begin with a small client-rendered application when that meets the product needs.
A server-rendered initial result page is a valid extension for faster first content
or usable search before JavaScript hydration on constrained devices.

SSR introduces duplicate-fetch and hydration consistency concerns.
It should hydrate the same query key and response that the browser will use.
It does not automatically make autocomplete accessible or solve response races.

I would not stream individual result cards in the initial design.
A small complete page preserves final ordering and simplifies focus and count updates.
Streaming can be revisited for genuinely expensive secondary result modules.

## 📈 Performance, failure tests, and trade-offs — 5 minutes

### What I would measure first

- Time from submit to first usable result, separated by cache hit and connection class.
- Input responsiveness and time from typing pause to current suggestions.
- Response size and scripting/render time on a representative low-end device.
- Stale-response rejection, failed searches, partial results, and navigation restarts.
- Keyboard completion of a search and page navigation without focus loss.

The likely frontend bottleneck is repeated network work or a large initial bundle,
not rendering ten result cards.
Keep the search interaction available while optional admin code loads separately.

I would consider bounded prefetch on navigation intent after measuring benefit.
Hover alone excludes touch and keyboard users; focus or an explicit usage signal may help.
Honor data-saving preferences and avoid prefetching every page.

### Scenarios I would verify

| Scenario | Expected result |
|---|---|
| Older search finishes last | Current URL and results remain matched |
| Suggestions return after Escape | Popup stays dismissed |
| Enter during composition | Composition completes without premature search |
| Storage is blocked or malformed | Search still starts; history can be disabled |
| Window expires on page three | Query survives; restart is explicit |
| Excerpt contains HTML-looking text | It renders as text, not active markup |
| API is down | Error is distinct from “no matches” |

Local history is not automatically private just because it is stored on-device.
Other users of that browser profile and same-origin scripts may access it.
I would offer an off switch, a clear action, and a small retention bound.

### Trade-offs to leave on the board

| Choice | Benefit | Cost accepted |
|---|---|---|
| ✅ Debounce and request identity | Responsive, correct suggestions | More lifecycle state than a timer alone |
| ✅ URL intent and stable windows | Shareability and coherent navigation | Expiry and bounded caches |
| ✅ Safe text excerpts | Relevant highlights without trusted HTML | Limited snippet formatting |
| ✅ Ordinary paginated list | Simple accessible rendering | No endless browsing experience |

## 🧭 Close and repository comparison — 2 minutes

> “The frontend's most important guarantee is that visible results answer the current query.
> I would spend the remaining discussion on the request lifecycle, input accessibility,
> and the boundary between matching text and rendering safe UI.”

The repository already has React, TanStack Router, a shared search store,
a 200 ms autocomplete timer, URL-based searches, ordinary pagination, and local history.
These are useful starting points for the proposed design.

It currently lacks request cancellation/generation guards, stable result windows,
complete combobox semantics, composition handling, clear-history controls,
and safe highlight rendering. Results and suggestions can be overwritten by late responses.
The local API uses offset pagination and can apply filters after pagination.

The production decisions in this answer are therefore proposals.
[architecture.md](./architecture.md) contains the verified source mapping;
[README.md](./README.md) explains how to explore the small local dataset.

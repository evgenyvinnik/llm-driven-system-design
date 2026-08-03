# Facebook Post Search — Frontend System Design Answer

## 45–50 minute interview walkthrough

| Segment | What I cover | Time |
|---|---|---:|
| Opening | Search experience, constraints, success criteria | 2 min |
| Requirements | User flows, ranking assumptions, non-functional goals | 4 min |
| Architecture | Routes, stores, search pipeline, rendering boundaries | 8 min |
| Data model | Query state, result state, filters, pagination, ownership | 6 min |
| Interfaces | API contracts, component contracts, URL state | 8 min |
| Optimizations | Debouncing, cancellation, virtualization, caching, resilience | 18–20 min |
| Wrap-up | Trade-offs, scaling path, risks | 3 min |

## Opening — 2 minutes

I am designing the frontend for searching posts in a large social graph. A user enters a query, selects filters such as author, date, group, or media type, and receives ranked posts with highlighted matches. The page must feel immediate while the search backend handles indexing, ranking, permissions, and pagination.

I will treat ranking and authorization as server responsibilities. My frontend responsibility is to make query intent explicit, prevent stale responses from replacing newer results, render large result sets efficiently, and preserve accessibility when results change.

The main design tension is that search is both an input interaction and a server-state problem. Keystrokes are frequent and disposable; result pages are useful and cacheable. I will separate those lifecycles rather than place everything in one global store.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether search is scoped to the current user, a page, a group, or the whole platform. I would ask which filters are required for the first release and whether filter changes should update results automatically or require an Apply action.

I would clarify whether results are ranked by relevance only or whether the user can switch to newest-first. I would ask whether posts can contain images, videos, links, and comments, and whether snippets must highlight matching terms.

I would ask for the expected query length, supported languages, maximum result count, and whether users need search history or saved searches. I would also clarify whether the URL must be shareable and whether browser back/forward must restore the exact result page.

### Functional requirements

- Search posts by free-text query.
- Apply filters for author, group, date range, post type, and sort order.
- Show highlighted snippets, author identity, timestamps, media previews, and permission-safe actions.
- Support cursor pagination or infinite scrolling without duplicate results.
- Preserve a search in the URL so it can be shared and restored.
- Show loading, empty, partial, and error states independently.
- Allow the user to retry a failed page without losing the successful pages already displayed.
- Support keyboard navigation and screen-reader announcements for result updates.

### Non-functional requirements

- The input should acknowledge local typing immediately.
- A settled query should normally show the first result page within one second on a healthy network.
- A stale response must never overwrite a newer query.
- Initial rendering should stay responsive while result cards contain images or rich text.
- The UI should remain useful when media, a later page, or a suggestion request fails.
- Search state should be observable without logging private post content.
- The frontend must respect server authorization and never infer visibility from cached results.

### Out of scope

I will not design the inverted index, relevance model, crawler, ranking features, permission join, or media transformation service. I will define their client-facing response shape and failure behavior.

## A — Architecture — 8 minutes

### High-level diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         React SPA (Vite + TypeScript)                       │
│ Routes: /search → search page · /search?q=... → shareable query            │
│         /search/people and /search/groups → scoped suggestions             │
│                                                                            │
│ ┌──────────────┐ ┌────────────────┐ ┌────────────────┐ ┌───────────────┐ │
│ │ authStore    │ │ queryStore     │ │ resultStore    │ │ filterStore   │ │
│ │ session and  │ │ raw input,     │ │ pages, cursors,│ │ date, author, │ │
│ │ capabilities │ │ debounced term │ │ snippets       │ │ type, sort    │ │
│ └──────────────┘ └───────▲────────┘ └──────▲─────────┘ └──────▲────────┘ │
│                          │ input            │ response           │ URL      │
│ ┌────────────────────────┴──────────────────┐ ┌───────────────┴─────────┐ │
│ │ Search coordinator                         │ │ Render adapters          │ │
│ │ debounce · cancel · request identity       │ │ virtual list · cards     │ │
│ │ cache · retry · pagination                 │ │ highlights · media       │ │
│ └────────────────────────────────────────────┘ └─────────────────────────┘ │
│ Typed API client: search · suggestions · next page · telemetry             │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ HTTPS
                         ┌───────────▼───────────┐
                         │ Search API boundary    │
                         │ ranking · permissions  │
                         │ cursors · snippets     │
                         └───────────────────────┘
```

### Shell and routes

The shell owns authentication context, theme, global navigation, responsive layout, and shared announcements. The search route owns query parameters, page composition, and the lifetime of the active search session.

The URL is a canonical representation of committed search intent. I keep transient input separate from the URL while the user is typing. After debounce, or after the user presses Enter depending on product choice, the route writes the normalized query and filters to history or replaces the current entry.

This separation prevents every keystroke from creating a browser history entry. It also means opening a shared URL can reconstruct the query without reconstructing ephemeral focus or in-progress composition state.

### Search coordinator

The search coordinator accepts query intent from the route and produces a request identity. The identity includes the normalized query, filters, sort, and page cursor. It debounces only the first-page request; loading the next page is an explicit action and should not be delayed by typing behavior.

The coordinator cancels work that is no longer useful, but cancellation is an optimization rather than a correctness guarantee. The result reducer also checks request identity before committing a response because an HTTP response can race with cancellation.

### Rendering boundary

React renders the search controls and result-card semantics. A virtual list controls which cards are mounted. Media components own lazy loading, aspect-ratio reservation, and failed-preview fallbacks. Highlight rendering consumes trusted structured match ranges rather than injecting server-provided HTML.

### Why not one global store?

A single store is tempting because query, filters, results, and authentication are visible on the same page. It becomes difficult to reason about ownership, however. Search results are disposable server state, input is local interaction state, and auth is session state. Separate slices with explicit transitions make invalidation and testing clearer.

## D — Data Model — 6 minutes

### Server-originated entities

| Entity | Important fields | Owner | Freshness |
|---|---|---|---|
| `SearchResult` | post ID, author, snippet, highlights, media, permission hints | result cache | query session |
| `SearchPage` | result IDs, next cursor, total estimate, received time | result store | cursor page |
| `SearchSuggestion` | label, type, destination, score | suggestion cache | short TTL |
| `FacetCounts` | filter value, count, selected availability | result store | query-specific |
| `ViewerContext` | user ID, capabilities, locale, privacy context | auth store | session |

The server remains authoritative for post visibility and action permissions. A cached result may be displayed, but actions such as opening a private group or deleting a post must still be checked by the destination and mutation API.

### Client-owned entities

| Entity | Important fields | Lifetime |
|---|---|---|
| `SearchDraft` | raw input, focused field, composition status | component/session |
| `CommittedQuery` | normalized term, filters, sort, URL key | route |
| `RequestState` | request ID, status, started time, error kind | coordinator |
| `ResultListState` | ordered IDs, pages, dedupe set, next cursor | route/session |
| `SelectionState` | focused result, keyboard mode, active filter | local UI |
| `MediaLoadState` | image/video status, retry count | result card |

### Ownership rules

The input owns raw text. The route owns committed query parameters. The coordinator owns request lifecycle. The result store owns pages and deduplication. Cards own media loading and presentation state. No card should mutate the canonical query or append directly to the result array.

### State machine

The first-page state transitions from idle to debouncing, loading, success, empty, or error. A new committed query resets the page list but preserves the input and filter controls. Loading the next cursor has an independent state so existing results remain interactive.

For an identical query, a cached success can render immediately while a background refresh marks the result stale. For a different query, the previous results can remain visible with a “refreshing” indicator, or the product can clear them; I would choose the first option when continuity matters and label the content clearly.

## I — Interfaces — 8 minutes

### Server-facing API

```
GET  /api/v1/search/posts?q=&filters=&sort=&limit=       → first page
GET  /api/v1/search/posts?cursor=&q=&filters=&sort=      → next page
GET  /api/v1/search/suggestions?q=&scope=                → suggestions
GET  /api/v1/search/facets?q=&filters=                   → facet counts
GET  /api/v1/posts/:postId                              → canonical post view
POST /api/v1/search/telemetry                            → aggregated interaction events
```

The search response includes a stable result ID, a server-issued next cursor, query echo, normalized filters, highlights as offsets or tokens, and a partial-data indicator. The response does not include arbitrary executable markup.

The cursor is opaque to the client. The client stores it and sends it back unchanged. If the server reports an expired cursor, the UI offers a restart from the first page rather than guessing how to reconstruct a page boundary.

### Client interfaces

| Interface | Inputs | Outputs | Responsibility |
|---|---|---|---|
| Search route | URL state, viewer context | page model | lifecycle and composition |
| Query controls | draft, committed filters | query intent | input and validation |
| Search coordinator | query intent | request states, pages | debounce, cancel, identity |
| Result list | ordered result IDs | visible cards | virtualization and keyboard path |
| Result card | normalized result | accessible post summary | highlighting and media fallback |
| Filter panel | facet data, selected values | filter intent | mobile and desktop controls |

### URL and browser history

The serializer must be deterministic: the same filter set produces the same URL ordering. Unknown filters are ignored or surfaced as unsupported rather than silently changing meaning. Back restores the committed query and starts a request if the cache has expired.

### Request lifecycle

1. The user edits `SearchDraft` without making a network request on every keystroke.
2. The coordinator normalizes whitespace, locale-sensitive text, and filter values.
3. The route commits the query and creates a request identity.
4. The coordinator checks a cache, starts the request, and records loading state.
5. The response is accepted only if its identity matches the active first-page request.
6. Pages are merged by stable post ID while preserving server order.
7. The next cursor is enabled only when the server returns one.

### Component contract details

The result list receives an ordered list and a resolver for result records. It does not receive the full raw API response. This keeps pagination metadata out of card components and allows a virtualizer to render placeholders without changing the server model.

The card exposes a semantic article or list item, a heading, author link, timestamp, snippet, and action menu. The media slot receives a constrained resource descriptor and must provide a fallback label when loading fails.

## O — Optimizations and Deep Dives — 18–20 minutes

### Deep dive 1: Debounce, cancellation, and stale responses

I would use a short debounce for free-text search, but not rely on debounce as the only load-control mechanism. A user may type rapidly, paste a long query, or change filters while a request is in flight.

The coordinator assigns a monotonically increasing request identity. Every response carries the identity it started with. The reducer commits only the active identity, so a slow response for “cat” cannot replace a newer response for “caterpillar.” Abort signals reduce server and browser work, but the identity guard protects correctness even if the transport ignores abort.

The trade-off is that keeping previous results visible can confuse the user if the new query is not visually obvious. I would show the committed query in the heading and a non-blocking refresh state, rather than show unlabelled stale content.

### Deep dive 2: Search-as-you-type versus submit

Search-as-you-type is responsive for short queries and useful for discovery, but it creates request volume and can produce noisy ranking changes. Submit-only search reduces load and makes URL history predictable, but adds a deliberate interaction step.

I would use a hybrid: suggestions can update as the user types, while full post results require a minimum query length and a debounce. Pressing Enter bypasses the remaining debounce. This keeps the high-frequency endpoint lightweight and reserves expensive ranking work for committed intent.

### Deep dive 3: Pagination and virtualization

The API should return cursor pages because relevance ranking and new posts make offset pages unstable. The frontend deduplicates by post ID because a result can move between pages after an index refresh or filter transition.

I would use virtualization after measuring card cost, not as a blanket rule. Variable-height cards require an estimated height, measurement, and overscan. Overscan must be bounded because mounting a dozen video-heavy cards can cost more than rendering a modest non-virtualized page.

Infinite scrolling is convenient but can hide the end of results and make footer actions inaccessible. I would use an intersection sentinel for loading while retaining a visible “load more” control and a keyboard-accessible status region.

### Deep dive 4: Caching and invalidation

The cache key includes normalized query text, filters, sort, locale, and viewer scope. Results are not shared across users unless the server explicitly guarantees that visibility is identical. A short TTL is appropriate because search results may change, but cache reuse should not bypass authorization.

The first page has more value than deep pages, so I would cache it longer and evict old cursor pages first. A successful response can be shown while a refresh runs in the background. A permission change or account switch clears the cache immediately.

### Deep dive 5: Highlighting and safe rendering

The server should return token offsets or typed match fragments. The client validates offsets against the displayed text and renders marked spans. It should not render an HTML snippet from the search service because that creates an unnecessary trust boundary and complicates sanitization.

If stemming or normalization means the match is not a literal substring, the server should return display-ready token ranges. The client can show a fallback snippet without highlights when ranges are invalid.

### Deep dive 6: Media and rich result cards

Card layout reserves media dimensions before the asset loads to avoid layout shift. Images use responsive sources and lazy loading. Video previews are muted, do not autoplay on reduced-motion preferences, and stop when the card leaves the viewport.

A failed image should not fail the result. The card keeps text, author, and timestamp available and exposes a retry action only when retry is useful. Media requests use their own concurrency budget so a search response is not blocked by thumbnails.

### Deep dive 7: Accessibility and mobile behavior

The search field has a visible label, keyboard shortcut only as an enhancement, and a clear button that is reachable by keyboard. Filter controls use native semantics where possible. On mobile, the filter panel becomes a modal or drawer with focus trapping and an explicit Apply action.

When a new result page arrives, I would announce a concise count or status without moving focus. Keyboard users can move through results using normal document order, and a focused result remains stable when virtualization recycles DOM nodes.

### Failure matrix

| Failure | User-visible behavior | Recovery |
|---|---|---|
| First page timeout | Keep query and show retry state | Retry with backoff or edit query |
| Stale response | Ignore response | Active request continues |
| Next page failure | Preserve prior pages | Inline retry for that cursor |
| Cursor expired | Explain page restart | Restart first page |
| Suggestions fail | Keep full search usable | Retry on next edit |
| Thumbnail fails | Text card remains | Lazy retry or placeholder |
| Permission changes | Revalidate destination | Remove unauthorized result |

### Scope growth and extension decisions

I would start with one result type, posts, and a route-scoped search coordinator. People, groups, pages, and media can later become result adapters behind the same query contract. Each adapter should declare its card renderer, accessibility summary, and canonical destination rather than forcing the result list to know every type.

This is a useful module boundary, but it does not require an iframe per result card. Cards share virtualization, keyboard order, query cancellation, and media budgets. A local registry or independently deployed module is sufficient for first-party result families. An iframe is reserved for untrusted third-party content, where hard isolation matters more than shared rendering efficiency.

The result contract should include a stable type, record ID, display text, match ranges, destination, and capability-scoped actions. It should not expose raw ranking features or a broad API client. The shell can render a fallback card when a result family is unavailable.

### Testing and observability

I would test request races, URL round trips, cursor expiry, duplicate pages, filter changes during loading, media failure, keyboard navigation, and permission changes after caching. An end-to-end test should type a query, navigate back, restore it from the URL, and verify that the stale response is ignored.

Telemetry records debounce-to-request time, first-result latency, result commit-to-paint, scroll frame time, cursor retries, media failure rate, and request-race suppression. It should avoid raw query text, snippets, and post content in ordinary analytics.

### Alternative architecture review

The simplest search page fetches in the input handler and renders every result. It is easy to demo, but it creates request races, makes browser history noisy, and lets rich cards dominate the main thread.

A global store for every search query would improve reuse but also risks retaining private result pages and mixing viewer scopes. Route-scoped result state with a disciplined cache is safer. A shared cache can be introduced after its key includes identity, permissions, locale, and query semantics.

Search result families are a natural module boundary. A local registry or independently deployed first-party module can provide a card renderer and accessibility summary. An iframe per card is not appropriate because cards share virtualization, keyboard order, media budgets, and query lifecycle. Hard isolation is reserved for untrusted embeds.

### API semantics worth making explicit

- Search requests echo normalized query, filters, sort, and request identity.
- Cursors are opaque and tied to a query version.
- Results include stable IDs, structured highlights, and capability-scoped actions.
- Facets are query-specific and do not imply that a value is globally visible.
- A next-page failure does not discard successful pages.
- Expired cursors restart from the first page with an explanation.
- Canonical post routes revalidate permission.
- Telemetry omits raw query text and post content.

### Presentation checkpoints

I begin with the user journey: type a query, refine filters, open a result, scroll, navigate back, and retry a failed page.

I trace that journey through draft input, committed URL state, request identity, result pages, virtualized cards, and canonical post navigation.

I pause on stale-response protection because it is the most important correctness rule in a fast search UI.

I close by explaining how result families can grow without coupling the search coordinator to every card implementation.

### Implementation sequence

1. Build the search route, accessible controls, and URL serializer.
2. Add a typed first-page request with request-identity protection.
3. Add filters, suggestions, cursor pagination, and independent retry states.
4. Add normalized result records, deduplication, and bounded card rendering.
5. Add structured highlights, media fallbacks, and keyboard navigation.
6. Add cache policy, telemetry, and permission revalidation.
7. Add new result families through a registry after the core contract is stable.

### Design review questions

The first question is whether a late response can replace the current query. If it can, cancellation is being mistaken for correctness.

The second is whether a next-page failure discards successful results. If it does, page lifecycle is coupled too tightly to the first request.

The third is whether the cache key includes viewer scope and normalized filters. If it does not, private results can leak across sessions.

The fourth is whether a broken card family leaves the result list navigable. If it does not, the rendering boundary is too broad.

### What I would validate first

I would test slow and out-of-order responses, URL back/forward, duplicate cursors, failed thumbnails, and a permission change after caching. The result list should preserve the query contract and remain keyboard navigable.

The success criteria are no stale result replacement, bounded card work, safe structured highlighting, and privacy-safe cache and telemetry behavior.

### Performance and scaling

The first bottleneck is usually not the request itself but the combined cost of parsing, image decoding, DOM layout, and rich cards. I would measure input-to-request, request-to-first-result, result commit-to-paint, and scroll frame time separately.

The result model should avoid copying large arrays for every keystroke. Store records by ID and keep ordered IDs per page. Memoized selectors let a single result update rerender one card rather than the whole list.

If query traffic grows, the server can provide suggestions from a cheaper endpoint, while the frontend coalesces identical requests across tabs only when privacy permits. A SharedWorker is not necessary for the first version because search is user-specific and short-lived; it is more valuable for shared public market data than private search.

### Security and privacy

Search terms may contain sensitive personal information. Telemetry should use hashed or categorized values where possible, and logs should avoid raw query text. The client must not expose hidden filter options based on guessed API fields. Capability flags should come from the authenticated session and remain advisory; the server enforces access.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Query trigger | Debounced hybrid | Every keystroke | Preserves discovery without ranking overload |
| Pagination | Cursor | Offset | Stable under changing ranked results |
| Result state | Route-scoped cache | One global store | Matches disposable search sessions |
| Correctness guard | Request identity | Abort only | Abort is not guaranteed to stop races |
| Rendering | Virtualized cards | Render all | Bounds DOM cost for long result sets |
| Highlighting | Structured ranges | Server HTML | Safer and easier to validate |
| Media | Lazy, isolated | Block on media | Text search remains usable |
| URL state | Committed query | Raw draft | Shareable and history-friendly |

## Closing — 3 minutes

The design separates raw input, committed route state, server search state, and card presentation state. The combined architecture keeps concrete React routes and stores visible while making the important runtime boundaries explicit: a search coordinator owns debounce, cancellation, caching, and cursor lifecycle; render adapters own virtualization and media; the API owns ranking and permissions.

The first production risks I would validate are stale-response handling, variable-height virtualization, privacy-safe telemetry, and the behavior of permission changes after a result is cached. If those are correct, the frontend can scale from a simple search page to scoped search, richer filters, and multiple result types without making every component aware of transport details.

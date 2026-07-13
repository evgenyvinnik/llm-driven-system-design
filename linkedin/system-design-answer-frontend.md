# LinkedIn - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 📋 Problem Statement

Design the web frontend for LinkedIn: a ranked feed, rich professional profiles, a connection graph the user browses and mutates (requests, accepts, People You May Know), job search with match scores, and near-real-time notifications.

What makes this frontend interesting is that almost every screen is a **view over a social graph**:

- Connection degree (1st/2nd/3rd) changes which buttons render on a profile
- Mutual-connection counts appear on profiles, PYMK cards, and search results
- A single user action — accepting a request — invalidates data on four different screens at once
- The same person entity appears as a feed author, a PYMK card, a search hit, and a full profile

So the frontend problem is less "draw the pages" and more "keep a client-side projection of the graph consistent, fast, and optimistic."

## 🎯 Requirements Clarification

Questions I would ask before drawing anything:

- **How fresh must graph data be?** If someone accepts my request on their phone, must my open desktop tab reflect it instantly? Answer: within a few seconds via a notification push is fine — connection state is not chat.
- **Feed depth?** Users scroll tens of posts, occasionally hundreds. Infinite scroll, not numbered pagination.
- **Real-time scope?** Notifications (connection accepted, comment on my post) should feel live. Feed content itself can be pull-on-navigation — professional feeds do not need streaming inserts appearing under the reader.
- **Device mix?** Desktop-heavy for a professional network, but responsive down to mobile web.
- **Scale context?** The backend serves ~17,400 feed QPS at 100M DAU. Every unnecessary refetch the client makes is multiplied by 100 million users — client politeness is a backend capacity feature.

### Functional Requirements

- **Feed**: Ranked posts from connections, like/comment actions, composer at top, infinite scroll
- **Profiles**: Experience, education, skills with endorsements; edit-in-place for own profile; connection degree, mutual connections, and a Connect action for others
- **Network page**: Pending invitations with accept/decline, connection list, PYMK grid with "why" reasons (mutual count, same company)
- **Jobs**: Search with facets (location, remote, employment type, level), recommended jobs with match scores, application flow
- **Search**: People and job results with typeahead
- **Notifications**: Badge count plus a panel; near-real-time delivery for connection events and engagement on my content

### Non-Functional Requirements

- **Interaction latency**: like/comment/connect must feel instant — optimistic, < 50ms perceived
- **Feed load**: first posts visible < 1s on repeat visits (cache-first), < 2.5s LCP cold
- **Scroll performance**: 60fps through hundreds of variable-height posts
- **Consistency**: a connection accepted anywhere converges everywhere in the UI without a manual refresh
- **Resilience**: a dropped notification stream or a failed mutation must never leave the UI lying about graph state

## 🏗️ High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        React SPA (Vite + TS)                       │
│                                                                    │
│  Routes (TanStack Router, code-split per route)                    │
│  ├─ /              → Feed (composer, virtualized posts, PYMK rail) │
│  ├─ /network       → Invitations, connections, PYMK grid           │
│  ├─ /profile/$id   → Profile sections + degree-aware actions       │
│  ├─ /jobs, /jobs/$id → Search, facets, recommended, apply          │
│  └─ /search        → People / job results                          │
│                                                                    │
│  ┌───────────────────┐  ┌─────────────────────────────────────┐   │
│  │ authStore         │  │ Server cache (TanStack Query)       │   │
│  │ (Zustand: session,│  │ feed pages · profiles · connections │   │
│  │  viewer identity) │  │ PYMK · jobs — per-key staleness     │   │
│  └───────────────────┘  └───────────▲────────────┬────────────┘   │
│                                     │ invalidate │ fetch          │
│  ┌──────────────────────┐  ┌────────┴──────┐  ┌──▼─────────────┐  │
│  │ Notification client  │  │ Mutation layer│  │ REST client    │  │
│  │ (SSE, badge + toast, │  │ (optimistic + │  │ (cookie auth,  │  │
│  │  cache invalidation) │  │  rollback)    │  │  retry, trace) │  │
│  └──────────▲───────────┘  └───────────────┘  └──▲─────────────┘  │
└─────────────┼────────────────────────────────────┼────────────────┘
              │ SSE                                │ HTTPS
     ┌────────┴────────────────────────────────────┴────────┐
     │                   LinkedIn API                       │
     └──────────────────────────────────────────────────────┘
```

The organizing idea: **one server-state cache with per-domain staleness rules**, a thin mutation layer that writes optimistically into that cache, and a notification stream whose main job is not showing toasts — it is telling the cache what just became stale.

Global client state is deliberately tiny: the Zustand auth store holds the session user and role, nothing else. Everything the server owns lives in the query cache, where deduplication, background revalidation, and invalidation are first-class. Mirroring server data into a second store is how frontends end up with two sources of truth that disagree.

## 🖥️ Rendering Strategy: SPA Core, Server-Rendered Public Edges

LinkedIn has two very different audiences, and one rendering strategy does not fit both:

- **Logged-in members** live in a session: feed scrolling, connection management, job browsing. This is a classic SPA workload — rich interactivity, heavy client cache reuse, navigation that should never full-page reload.
- **Logged-out visitors** arrive from Google at a public profile or a job posting. These pages are LinkedIn's largest acquisition channel and must be crawlable, fast on first paint, and rendered without a session.

So I split the rendering strategy along that seam:

| Surface | Strategy | Why |
|---------|----------|-----|
| Feed, network, notifications | ✅ Client-rendered SPA | Interaction-heavy, personalized, uncrawlable by design |
| Public profiles, job postings | ✅ Server-rendered (SSR/SSG at the edge) | SEO-critical, anonymous, cacheable per URL |
| Login/registration | Either; static-leaning | Trivial pages, fastest as prerendered shells |

**Why not SSR everything?** Server-rendering the logged-in feed means every navigation pays a server round trip for HTML that the client cache could have produced in milliseconds, and personalization defeats edge caching — every render is a cache miss with a per-user rank computation behind it. The SPA path amortizes: after the first load, navigations cost only data, not markup.

**Why not SPA everything?** A client-rendered public profile serves crawlers an empty div, and even with dynamic-rendering workarounds, first meaningful paint for an anonymous visitor waits on JS download + parse + API fetch — three round trips where SSR needs one. For pages whose entire job is to be found and read, that is the wrong shape.

The seam cost is real: two rendering paths, shared components that must work in both, and hydration discipline on the public pages. I contain it by keeping public pages intentionally shallow (read-only, no graph mutations) so they share display components with the SPA but none of the mutation/cache machinery.

## 💾 Client Data Model and Staleness Policy

Different graph data ages at very different rates, so I set staleness per cache key rather than one global policy:

| Data | Cache key shape | Stale after | Why |
|------|-----------------|-------------|-----|
| Feed pages | feed + cursor | 2 min | Ranked server-side; re-ranking mid-session is jarring |
| Own profile | profile:me | Never (invalidate on edit) | Only I change it |
| Other profiles | profile:{id} | 5 min | Headlines change rarely |
| Connection list | connections | Until mutation or notification | Drives the network page; must be right |
| Connection degree | degree:{id} | Until mutation or notification | Drives which buttons render — load-bearing |
| Mutual connections | mutuals:{id} | 30 min | Expensive to compute, cosmetic to display |
| PYMK | pymk | Session | Backend caches it 24h anyway; churning it wastes both sides |
| Pending invitations | invitations | Until mutation or notification | Badge and accept flow depend on it |
| Jobs / search results | query-string keyed | 1 min | Facet changes re-query the server, not the client |

> "The connection-degree entry is the one I treat as load-bearing. Degree is not decoration — it decides whether a profile shows Connect, Pending, or Message, and whether the mutual-connections badge renders. If I let it go stale, the UI offers actions the server will reject. So degree is invalidated aggressively — on any connect/accept/remove mutation and on any connection notification — while cosmetic data like mutual counts can drift for half an hour without anyone noticing."

**Normalization of the person entity.** The same person appears on four surfaces. I keep a lightweight person summary — name, headline, avatar URL, degree — normalized by user ID, and every surface renders from it. When a connection is accepted:

1. The degree entry for that user flips to 1st
2. The feed author badge, the search-result row, and the profile header all re-render from the same record
3. Nothing needs a refetch; the graph change propagated through one write

Without normalization, four screens hold four copies and converge only when each happens to refetch — the user sees "2nd" in search and "1st" on the profile simultaneously, which reads as a bug.

## 🧭 Route and Component Architecture

| Route | Layout | Data loaded in parallel on entry |
|-------|--------|----------------------------------|
| / | 3-column: profile mini-card, feed, PYMK rail | First feed page, PYMK, unread badge |
| /network | Tabs: invitations, connections, PYMK | All three tabs' data in one parallel batch |
| /profile/$id | Header + stacked sections | Profile, posts; then degree + mutuals for non-own profiles |
| /jobs | Sidebar filters + listing column | Job list, recommended jobs |
| /jobs/$id | Detail + apply panel | Job detail, application status |
| /search | Result list with type tabs | People and job results for the query |

Component principles I hold to:

- **Cards are presentational; mutations live in the layer above.** A post card receives its post and callbacks; the feed container owns optimistic updates. This keeps rollback logic in one place instead of scattered across leaf components.
- **Degree-aware action buttons are one shared component** (Connect / Pending / Connected / Message) fed by the degree cache, used on profiles, PYMK cards, and search rows. One state machine, one rendering, no drift between surfaces.
- **Modals (profile edit, apply flow) are lazy-loaded** on first open — most sessions never open them, so they should cost zero bytes up front.
- **Tab content on /network is loaded eagerly but rendered lazily** — the parallel batch makes tab switching instant, while rendering only the active tab keeps the DOM small.

## 🔌 API Surface the Client Consumes

The client speaks to a REST API with cookie-based sessions. The endpoints that shape frontend behavior:

```
GET    /api/feed?cursor=            → Ranked feed page
POST   /api/feed/posts              → Create post (returns full post)
POST   /api/feed/posts/:id/like     → Like (idempotent)
DELETE /api/feed/posts/:id/like     → Unlike (idempotent)
GET    /api/feed/posts/:id/comments → Lazy-loaded comments
POST   /api/connections/request     → Send invitation
POST   /api/connections/:id/accept  → Accept invitation
GET    /api/connections/pymk        → PYMK (server-cached 24h)
GET    /api/connections/degree/:id  → Degree for a profile
GET    /api/connections/mutual/:id  → Mutual connections
GET    /api/users/:id               → Profile
GET    /api/users/search?q=         → People search (Elasticsearch)
GET    /api/jobs?filters…           → Job search with facets
GET    /api/notifications/stream    → SSE event stream
```

Two client-relevant properties of this API:

- **Write endpoints are idempotent or deduped server-side** (likes insert-if-absent; connection requests are unique per user pair). This is what makes the optimistic layer safe — the client can be aggressive because a duplicate write is harmless.
- **Rate limits are visible to the client** via standard rate-limit headers. The mutation layer reads them and preemptively disables rapid-fire actions (especially Connect, capped at 20/min) with an explanatory tooltip, instead of letting the user hit a raw 429.

## 🔧 Deep Dive 1: The Feed — Virtualized, Variable-Height, Infinite

The feed is the performance-critical surface: variable-height cards, infinite scroll, and interactive children (comments, like animations).

**Virtualization with measured heights.** I render through a windowing layer (the `@tanstack/react-virtual` pattern): only the viewport rows plus a small overscan exist in the DOM. Post heights vary wildly — a two-line text post versus an image post with expanded comments — so I:

1. Estimate ~400px per card for initial layout so the scrollbar is roughly honest immediately
2. Measure each row after render and feed the real height back to the virtualizer
3. Re-measure on expansion events (see-more, comments opened, image loaded)

Without measurement, the scrollbar lies and the list anchor-jumps when estimates are wrong. With it, scroll position stays stable even when an image loads late.

**Why not just render everything?** A LinkedIn post card is heavy — avatar, clamped text, optional image, stats bar, action row, maybe comments. Two hundred mounted cards means tens of thousands of DOM nodes; every scroll frame pays style and layout cost across all of them, and mid-range laptops drop frames. Virtualization caps live DOM at roughly ten cards regardless of scroll depth.

**What I give up:** browser-native Ctrl-F cannot find unmounted posts, screen-reader navigation needs explicit list semantics and counts to compensate, and dynamic-height measurement adds genuine complexity around scroll anchoring. For an infinite feed these are standard, acceptable prices; for a bounded list of 20 items virtualization would be pure overhead and I would not use it.

**Cursor pagination, not offsets.** Pages are fetched keyed by an opaque cursor (effectively rank-score position). Offset pagination breaks under insertion — one new post shifts every offset and the user sees duplicated or skipped posts at page boundaries. With cursors:

- Fetched pages append to the cached list; earlier pages are never disturbed
- The next page prefetches when the user is within ~5 cards of the end, so the spinner is rarely seen
- "New posts" arriving during a session are offered via a "show new posts" pill at the top rather than being injected under the reader — ranked feeds must never reflow while being read

**Expanded state lives outside the row.** Comments-open and see-more flags are kept in a small map keyed by post ID at the feed level, not inside the row component — virtualization unmounts rows, and state stored in them would silently reset when the user scrolls away and back.

**Lazy comments.** Comments load only when opened. At 17K feed QPS, eagerly fetching comments for every rendered post would multiply backend read traffic for content most users never expand. Once loaded, they cache with the post so reopening is free.

## 🔧 Deep Dive 2: Optimistic Graph Mutations — Likes Are Easy, Connections Are Not

Every social action must feel instant, but the rollback story differs by action type, so I treat mutations as two distinct classes rather than one generic "optimistic update" pattern.

**Class 1 — idempotent toggles: like, unlike, endorse.**

1. Flip the UI state and adjust the count immediately
2. Fire the request
3. On failure, flip back and show a quiet toast

The server makes likes idempotent (insert-if-absent, count derived from rows), so a double-tap or a network-layer retry cannot double-count. Rollback is cheap and unambiguous because the action is self-inverse. This is the easy class — the only discipline is that the count shown is *my* delta applied to the server's last known count, not a locally incremented counter that drifts.

**Class 2 — state-machine transitions: connection requests.**

Connect is not a toggle; it is a transition in a small machine:

```
        request              accept
none ────────────▶ pending ────────────▶ connected
  ▲                   │                      │
  └───────────────────┘◀─────────────────────┘
      withdraw/decline         remove
```

Optimism here means advancing the local machine, not flipping a boolean:

1. User clicks Connect on a profile → button instantly becomes "Pending"; the degree cache entry for that user is written to pending-outgoing
2. The request fires, carrying the optional invitation message
3. On failure → revert to none, restore the button, and say *why*: rate-limited (the backend caps connection requests at 20/min for anti-spam) or an already-connected race
4. On success → state confirmed; later, an "accepted" notification transitions pending-outgoing → connected and invalidates degree, the connection list, and PYMK — the person should vanish from PYMK the moment they become a 1st-degree connection

**Accepting an invitation** touches three cached collections: remove from pending invitations, add to connections, patch degree for that user. I apply all three optimistically as one batch — applying them piecemeal creates a frame where the person exists in both lists, which users screenshot and report as a bug. On failure, all three roll back together from a snapshot taken before the batch.

> "The judgment call is what *not* to make optimistic. Posting to the feed I keep pessimistic-but-fast: the composer disables, the request round-trips, and the created post — with its server-assigned ID and timestamp — is prepended to the cached feed. An optimistic phantom post needs temp-ID reconciliation everywhere a post ID flows (likes, comments, permalinks), and a failed publish that silently vanishes a post the user watched appear is a worse experience than a 300ms spinner on the Post button. Optimism buys the most where actions are frequent and low-stakes; posting is neither."

## 🔧 Deep Dive 3: Notifications — A Cache-Invalidation Bus That Happens to Show Toasts

Requirement: connection accepted, new invitation, comment or like on my content — visible within seconds; badge always right.

**Transport choice: SSE over WebSocket or polling.** Notifications are strictly server→client; the client never pushes on this channel. Comparing honestly:

| Approach | Pros | Cons |
|----------|------|------|
| ✅ SSE | Push latency; plain HTTP (cookies, proxies, LB-friendly); built-in auto-reconnect with last-event-ID replay | One-directional only; per-domain connection cap on HTTP/1.1 (fine over HTTP/2) |
| ❌ WebSocket | Bidirectional, lowest overhead | Custom reconnect/heartbeat plumbing; harder through proxies; buys bidirectionality this feature does not use |
| ❌ Polling (5s) | Trivial to build | 0.2 QPS/user → ~20M requests/min at 100M DAU, 99% returning "nothing new"; latency floored at the poll interval |

Polling is the one that breaks structurally: it converts "feels live" into a permanent backend tax proportional to *connected users*, not to *events*. Push costs one idle connection per user; polling costs the backend an entire serving tier for empty responses. SSE's auto-reconnect matters too — after a laptop-sleep gap, the browser reconnects with the last seen event ID and the server replays what was missed, which is exactly the recovery semantics notifications need.

**The real payload is invalidation.** Each event carries a type and entity references. The notification client maps them onto the cache:

```
connection.accepted  ──▶ invalidate degree:{userId}, connections, pymk
connection.request   ──▶ invalidate invitations; badge +1
post.comment / like  ──▶ patch that post's counts in the feed cache
profile.viewed       ──▶ badge only; no cache effect
```

This is how two devices converge without refresh: the phone accepts, the server emits, the desktop's SSE handler invalidates degree and connections, and the next render shows "Connected" — no user action, no polling loop, no full-page refetch.

**Badge integrity.** The badge count is server-authoritative. Events increment it locally as a hint, but opening the panel fetches the true unread count and reconciles. Client-side counters inevitably drift — missed events while offline, double-counting across tabs — and reconciling on open makes the drift self-healing rather than accumulating.

**Multi-tab discipline.** Professionals keep LinkedIn open in several tabs. I elect a leader tab (web locks or a broadcast channel); only the leader holds the SSE connection and rebroadcasts events to follower tabs. Three tabs holding three idle connections per user triples the backend's connection load for zero user benefit, and tab-leader election is a well-trodden, small piece of coordination.

## 🔍 Search and Typeahead

Global search (people, jobs) is a latency-sensitive, race-prone surface:

- **Debounce at ~200ms**, but fire immediately on Enter — debounce protects the backend (search is rate-limited at 20/min because each query hits Elasticsearch), while Enter respects user intent
- **Cancel stale requests**: each keystroke's fetch aborts the previous one. Without cancellation, responses race and a slow response for "jav" can overwrite results for "javascript" — the classic out-of-order bug. Abort-on-supersede makes ordering structurally impossible to get wrong rather than relying on timestamp comparisons
- **Cache by normalized query**: backspacing to a previous query re-renders instantly from cache instead of re-querying
- **Results carry degree badges** from the normalized person store, so a search hit already shows 1st/2nd and the right action button without extra requests per row

For the jobs page, **filter state lives in the URL**, not in component state:

1. Facet changes (location, remote, level) update query params
2. The query cache keys off the full query string, so each filter combination is its own cached result
3. Back/forward navigates filter history naturally, and a filtered search is shareable and bookmarkable — recruiters share filtered job searches constantly

The alternative — filters in local state — makes results unlinkable and turns the back button into a trap that dumps the user out of their refined search. URL-as-state costs a little serialization discipline and pays for itself in every shared link.

## ✏️ Profile Editing and Form Strategy

Own-profile editing is the main form surface: modal edit for the header (name, headline, location), inline add-forms for experience, education, and skills.

- **Controlled inputs with per-field validation** — the forms are moderate-sized; a form library would add weight without earning it here
- **On save, two writes**: the profile cache entry updates from the server response, and the auth store's viewer identity updates too, so the navbar name/headline reflect the edit immediately — forgetting the second write is the classic "edited my profile but the navbar shows my old headline" bug
- **Inline add-forms over modals for skills**: adding several skills in a row is a burst activity; staying in context beats repeated modal open/close cycles
- **Endorsements are Class-1 optimistic**: the count increments locally on click, consistent with the like pattern, since endorsement is idempotent per (user, skill)

## 🛡️ Error Handling and Resilience

- **Failed optimistic mutations roll back loudly**: the state reverts and a toast names the action that failed. Silent rollback makes users distrust every button.
- **SSE stream loss degrades gracefully**: if reconnection fails past a threshold (~30s), the client falls back to a slow 60s poll of the badge endpoint; the UI stays functional, just less live.
- **Retry policy is method-aware**: idempotent GETs retry with backoff automatically; mutations never auto-retry without an idempotency guarantee — a retried connect is safe (the server dedupes by user pair), a retried comment is not, so comments surface a manual "retry" affordance instead.
- **Skeletons over spinners**: profile and feed skeletons match the real layout's geometry, so content pops in with zero layout shift; a centered spinner communicates less and shifts more.
- **Partial failure renders partially**: if degree/mutuals fail but the profile loads, the profile renders with a neutral action button rather than failing the whole page — the profile is the content; the graph adornments are enhancements.

## 📱 Perceived Performance

- **Route-level code splitting**: feed, profile, jobs, network each load their own chunk; the feed bundle never pays for the job-facet UI
- **Cache-first navigation**: returning to the feed renders cached pages instantly, then revalidates in the background if past the 2-minute window — repeat visits feel free
- **Parallel route loading**: profile fires profile + posts + (degree, mutuals) together; the slowest adornment upgrades in place rather than blocking first paint
- **Prefetch on intent**: hovering a person link prefetches their profile summary — the person-card popover then renders instantly, and the summary warms the full profile page too
- **Image discipline**: avatars are sized and dimension-reserved; feed images lazy-load into reserved aspect-ratio boxes so scroll never jumps
- **Font strategy**: system font stack — a professional text-dense product gains nothing from a webfont worth its blocking cost, and system fonts render at first paint on every platform
- **Third-party restraint**: no analytics or tag-manager scripts on the critical path; they load after first interaction, because nothing torpedoes an LCP budget faster than synchronous third-party JS

## ♿ Accessibility

A professional platform gets used with screen readers and keyboards in enterprise settings; this is table stakes, not polish:

- The virtualized feed exposes list semantics with an accurate total count so screen readers announce position ("item 14 of 200") despite most items being unmounted
- Degree-aware action buttons announce their state transition ("Connect, button" → "Pending, button") because the optimistic flip is otherwise invisible to non-visual users
- Notification toasts use a polite live region — announcements queue rather than interrupting the current reading position
- Focus management on modals: focus moves in on open, returns to the trigger on close; the feed's infinite scroll keeps a "skip to navigation" escape hatch since there is no page bottom
- Icon-only buttons (like, comment, share, remove-skill) always carry accessible names; the like button's pressed state is exposed so "liked" versus "not liked" is announced, not just colored
- Color is never the only signal: the green "connected" and blue "pending" states pair with text labels, and engagement deltas announce as text, meeting contrast and non-color-reliance requirements for enterprise WCAG AA procurement

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Feed rendering | ✅ Virtualized, measured heights | ❌ Render-all with pagination | 60fps at unbounded depth; DOM capped at ~10 cards |
| Feed pagination | ✅ Cursor-based | ❌ Offset | No duplicates/skips when new posts land |
| New posts mid-session | ✅ "Show new posts" pill | ❌ Live insertion | Ranked feeds must not reflow under the reader |
| Server state | ✅ Query cache, per-domain staleness | ❌ Zustand mirrors of server data | One source of truth; dedup and revalidation for free |
| Likes/endorse | ✅ Optimistic toggle + rollback | ❌ Await server | Sub-50ms feel; idempotent server makes rollback safe |
| Connect flow | ✅ Optimistic state machine | ❌ Boolean-toggle optimism | Pending/accepted/declined edges need explicit transitions |
| Post creation | ✅ Pessimistic, prepend response | ❌ Optimistic phantom post | Vanishing published posts worse than a brief spinner |
| Notifications | ✅ SSE + leader tab | ❌ Polling / WebSocket per tab | Push latency, HTTP-native reconnect, one connection per user |
| Notification role | ✅ Cache-invalidation bus | ❌ Toast-only | Cross-device convergence without refetch storms |
| Person data | ✅ Normalized summary by ID | ❌ Per-screen copies | Degree change updates every surface at once |
| Modals | ✅ Lazy-loaded on first open | ❌ Bundled with route | Most sessions never open them |
| Rendering | ✅ SPA core + SSR public pages | ❌ One strategy for all | Session UX and SEO have opposite needs |
| Job filters | ✅ URL-as-state | ❌ Component state | Shareable, bookmarkable, back-button-safe |
| Search races | ✅ Abort superseded requests | ❌ Timestamp comparison | Out-of-order results structurally impossible |

## 📈 Scaling the Frontend — What Breaks First

1. **Feed memory on marathon scrolls** — cached pages accumulate without bound. Fix: drop page *data* beyond a window of ~20 pages while keeping cursors, refetching if the user scrolls far back up; virtualization already capped the DOM, this caps the heap.
2. **Notification fan-in on hot posts** — a post going viral generates like/comment events faster than the UI should re-render. Fix: coalesce count patches client-side to at most one update per post per second; exact live counters on a viral post are worthless precision.
3. **Network page at thousands of connections** — the connections tab becomes its own virtualization problem, and client-side filtering of a fully downloaded list stops being viable. Fix: window the grid and move search-within-connections server-side.
4. **Bundle growth** — jobs, search facets, profile editing each accrete UI over time. Fix: keep splitting on route boundaries, lazy-load every modal, and budget-gate the entry chunk in CI.
5. **Localization weight** — a global professional network pays real bytes for locale data and message catalogs. Fix: load locale bundles on demand keyed to the user's language; never ship all locales.
6. **Public-page traffic spikes** — a job posting or profile going viral lands anonymous load on the SSR path. Fix: these pages are per-URL cacheable at the CDN with short TTLs, so virality hits the edge, not the renderer — this is exactly why mutations were kept off the public pages.

Observability closes the loop: real-user monitoring on LCP/INP per route, an error boundary per route reporting with the trace ID the REST client attaches to every request, and a client metric for optimistic-rollback rate — a rising rollback rate is the earliest signal that the backend is degrading before availability alarms fire.

## 🚀 Closing

The through-line of this design: the frontend is a **cached projection of a social graph**, and every choice follows from asking how stale each projection is allowed to be. Degree data: never knowingly stale, because it drives actions the server would reject. Feed ranking: minutes stale, because re-sorting under the reader is worse than mild staleness. Mutual counts: half an hour, because they are decorative. Optimism where actions are cheap to reverse, pessimism where they are not, and a notification stream doing double duty as the invalidation bus that keeps every tab and device honest.

Future work: an offline read cache for the feed (service worker, last N pages), a richer composer with mentions and documents, and hover-prefetched person cards across all surfaces — the highest-leverage perceived-performance win left on the table.

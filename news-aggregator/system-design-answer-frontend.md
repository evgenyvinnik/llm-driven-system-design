# 📰 News Aggregator — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "A news reader is two products in one shell. The public front page and story pages are read by millions of anonymous visitors arriving from search and social links, so they live or die on first paint. The signed-in feed is an endless, personally ranked list that the server keeps re-ranking while you scroll. So I need fast, cacheable public pages, a feed that never shows the same story twice or loses its place, and breaking news that arrives without yanking the page out from under the reader."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, Web Vitals and accessibility targets |
| A — Architecture | 8 min | Rendering strategy, component tree, who owns which state |
| D — Data model | 5 min | Client entities and cache keys |
| I — Interface | 5 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 18 min | Infinite feed, rendering and performance, live breaking news, security |
| Loading, error & empty states | 2 min | What the reader sees when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"First, who reads this and on what, because that sets the performance budget."

### Functional requirements

1. **Front page**: a ranked list of *stories* (one card per event, "12 sources"), personalized when signed in, plus a breaking-news banner.
2. **Topic pages** and **trending**.
3. **Story page**: headline, summary and every outlet's coverage, with links out to the publishers.
4. **Search** with topic and date filters.
5. **Settings**: preferred topics, preferred and blocked sources.
6. **Reading signals**: opening an article teaches the ranking.
7. **Admin** (role-gated, lazy-loaded): sources, crawl health, breaking flags.

Out of scope: comments, notifications, a native app.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP | < 2.5 s on a mid-range Android over 4G (p75) | Most visits are one story from a search or social link |
| INP | < 200 ms, including deep in the feed | Scrolling and tapping are the whole interaction |
| CLS | < 0.1 | Banners and images must not push the text being read |
| JavaScript | < 150 KB gzipped for public pages; admin and settings lazy | Low-end phones parse JS slowly |
| Correctness | No repeated or skipped stories while paging; reads counted once | Duplicates are the most visible bug in a news feed |
| Accessibility | WCAG 2.2 AA; keyboard and screen-reader friendly feed; live updates announced politely | News is a public service |
| SEO / sharing | Public pages server-rendered with title, description and Open Graph tags | Search and social bring most readers |
| Resilience | Usable on flaky networks; cached content stays visible offline | Commuters |

---

## 🏗️ A — Architecture (8 min)

"First, the rendering strategy, because it splits the app. Public pages are SEO-critical and identical for every anonymous reader, so I server-render them and cache them at the CDN for 30 seconds with stale-while-revalidate. Signed-in feeds are personal and must never sit in a shared cache, so they render on the client after a server-rendered shell. A pure SPA would give anonymous readers a blank page until JavaScript arrives, which is the wrong trade for a product whose readers mostly arrive cold from Google."

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ App shell · TanStack Router · BreakingBanner · session user in Zustand                          │
│ URL state: /topics/$topic   /story/$storyId   /search?q=...                                     │
└──────────┬─────────────────────────┬─────────────────────────┬────────────────────────┬─────────┘
           │                         │                         │                        │
           ▼                         ▼                         ▼                        │ (3) live
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐             │
│ / · /topics/$topic  │   │ /story/$storyId     │   │ /search · /settings │             │
│ TopicBar            │   │ StoryHeader         │   │ SearchBox           │             │
│ FeedList (virtual)  │   │ SourceList + reads  │   │ PreferencesForm     │             │
└──────────┬──────────┘   └──────────┬──────────┘   └──────────┬──────────┘             │
           │ (1) pages               │ (2) story, read         │ search, prefs          │
           │                         │                         │                        ▼
           ▼                         ▼                         ▼              ┌───────────────────┐
┌─────────────────────────────────────────────────────────────────────────┐   │ EventSource       │
│ TanStack Query cache (server state)                                     │   │ /breaking/stream  │
│ ['feed', topic] infinite pages · ['story', id] · ['search', q]          │   └─────────┬─────────┘
│ dedupe · retry · abort stale · invalidate after prefs save              │             │
└────────────────────────────────────┬────────────────────────────────────┘             │
                                     │                                                  │
                                     ▼                                                  │
┌─────────────────────────────────────────────────────────────────────────┐             │ SSE
│ API client: fetch + AbortSignal · keepalive for read signals            │             │
│ problem+json errors · 401 → login                                       │             │
└────────────────────────────────────┬────────────────────────────────────┘             │
                                     │ HTTPS · session cookie                           │
                                     ▼                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Feed API · /api/v1/feed?cursor · /stories/:id · /search · /user/* · /breaking                   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Feed (1).** `FeedList` reads `['feed', topic]` as an infinite query. Each page comes with an opaque cursor; scrolling near the end fetches the next page with it. The topic lives in the route path, so back, forward and shared links restore the view.
2. **Story and read (2).** `/story/$storyId` reads `['story', id]`, often already prefetched from the card. When a signed-in reader opens an outlet's article, the page sends a read signal with `keepalive` and dwell time.
3. **Live (3).** The app shell holds the breaking banner, fed by an `EventSource`. Because the banner sits in the shell, it survives route changes and one connection serves every page.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Feed pages, stories, search results, preferences | TanStack Query cache | Caching, dedupe, retries, cancellation and invalidation without hand-written loading flags |
| Topic, search query and filters, story id | URL (router) | Shareable, bookmarkable, back/forward just work |
| Session: user and role | Zustand, filled from `/me` | Needed by every route guard and the header; tiny |
| Breaking items | SSE stream into a small store | Pushed, not requested; shared by the whole shell |
| Dwell timer, open menus, pending "new stories" count | Component state | Local and short-lived |

"My rule: server data never gets copied into Zustand. A hand-copied feed list means owning its staleness, deduplication and invalidation yourself, and that's where 'why did this story appear twice' bugs come from."

### Key interaction: scrolling the feed

```
Reader                       FeedList              Query cache               API client
   │                             │                      │                         │
   │ 1 scrolls near the end      │                      │                         │
   │────────────────────────────▶│                      │                         │
   │                             │ 2 fetchNextPage()    │                         │
   │                             │─────────────────────▶│                         │
   │                             │                      │ 3 GET /feed?cursor=c1   │
   │                             │                      │────────────────────────▶│
   │                             │                      │ 4 page 2 + next cursor  │
   │                             │                      │◀────────────────────────│
   │                          5 skip ids already shown  │                         │
   │                             │ 6 pages[] re-render  │                         │
   │                             │◀─────────────────────│                         │
   │ 7 new rows, aria-live note  │                      │                         │
   │◀────────────────────────────│                      │                         │
   │                             │                      │                         │
```

"The cursor is opaque. The server keeps a ranked snapshot behind it, so pages don't overlap even though the ranking keeps moving. Step 5 is my backstop for the rare case where the snapshot expired and the server re-ranked: anything already on screen is dropped instead of shown twice."

### Key interaction: searching

```
Reader                     SearchPage                Router                        API client
   │                            │                       │                               │
   │ 1 types "port strike"      │                       │                               │
   │───────────────────────────▶│                       │                               │
   │                            │ 2 debounce 250 ms     │                               │
   │                            │ 3 set ?q=port+strike  │                               │
   │                            │──────────────────────▶│                               │
   │                            │                       │ 4 abort old; GET /search      │
   │                            │                       │──────────────────────────────▶│
   │                            │                       │ 5 articles, engine: postgres  │
   │                            │                       │◀──────────────────────────────│
   │                            │ 6 results + notice    │                               │
   │                            │◀──────────────────────│                               │
   │ 7 "3 results" (aria-live)  │                       │                               │
   │◀───────────────────────────│                       │                               │
   │                            │                       │                               │
```

"The query lives in the URL, so a search can be bookmarked or shared, and the route loader owns fetching. Typing faster than the network aborts the previous request through the loader's `AbortSignal`, so an old response can never overwrite a newer one. The response says which engine answered, and when it's the fallback I show 'basic results' instead of pretending relevance is normal."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `Story` | `id`, `title`, `summary`, `topics`, `sourceCount`, `articleCount`, `isBreaking`, `createdAt`, `articles[≤3]` | Inside feed pages; `['story', id]` for detail | Feed: 60 s stale; story: 2 min |
| `FeedPage` | `stories: Story[]`, `nextCursor`, `hasMore` | `['feed', topic]` (infinite) | Refetch on pull-to-refresh or after preferences change |
| `StoryDetail` | `Story` + `articles[]` (all outlets: `sourceName`, `url`, `publishedAt`) | `['story', id]` | 2 min |
| `SearchResult` | `articles[]`, `engine` | `['search', q, topics, from, to]` | 5 min |
| `Preferences` | `preferredTopics`, `preferredSources`, `blockedSources` | `['prefs']` | Invalidated on save |
| `BreakingItem` | `id`, `title`, `flaggedAt`, `sourceCount` | Breaking store, fed by SSE | Server drops items 6 h after flagging |
| `Session` | `id`, `username`, `role` | Zustand | Refreshed on focus and on any `401` |

Two modeling decisions:

- **No normalized entity store.** A story appears in feed pages and in `['story', id]`, and the copies can briefly differ (the feed card says 11 sources, the detail page 12). I accept that: the detail page is always fresh, and a normalized cache would add machinery for three entity types.
- **The cursor is not part of the URL.** Cursors point at a server-side snapshot that belongs to one reader and expires in 15 minutes. Putting one in a shareable URL would hand someone a dead or foreign cursor. Scroll position is restored from the query cache, not the URL.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET  /api/v1/feed?cursor&limit          → {stories[], next_cursor, has_more}
GET  /api/v1/feed/topic/{topic}?cursor  → same shape
GET  /api/v1/stories/{id}               → story + articles[]
GET  /api/v1/search?q&topics&date_from  → {articles[], engine}
GET  /api/v1/breaking/stream            → SSE: story.breaking events, resumable
PUT  /api/v1/user/preferences           → 200 | 400 with field errors
POST /api/v1/user/reading-history       → 200 | 404; safe to retry
```

- **Cursors are opaque strings.** The client never parses or computes them, so the server can change how pagination works.
- **The read signal is idempotent.** The server only learns from the first read of an article, so the client can fire it with `keepalive` and retry without tracking what it already sent.
- **Errors** arrive as `application/problem+json`; field errors map onto form fields, everything else onto a toast.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<FeedList topic>` | Virtualized, `role="feed"` with `aria-setsize`/`aria-posinset`; fetches the next page near the end; restores scroll |
| `<StoryCard story onOpen>` | Fixed-ratio image slot; title is the link; source count and age as text, not only icons |
| `<BreakingBanner>` | Lives in the shell; reads the breaking store; announces new items politely |
| `<SourceList articles onOpenArticle>` | External links with `rel="noopener noreferrer"`; reports opens for read signals |
| `useFeed(topic)` | Wraps the infinite query, cursor handling and dedupe |
| `useRecordRead()` | Fire-and-forget `POST` with `keepalive`; no-op when signed out |

---

## 🔧 O — Optimizations & Deep Dives (18 min)

### Deep dive 1: an infinite feed that doesn't repeat itself or lose your place (6 min)

"Three things go wrong with naive infinite scroll: duplicates, a DOM that grows forever, and losing your place when you come back from a story."

**Duplicates.** The server ranks once per scroll and hands out a cursor into that frozen snapshot, so pages are disjoint by construction. When a snapshot expires mid-scroll, the server re-ranks and continues at the same offset, and the client's merge step skips ids it already shows. Server guarantee plus client backstop, so neither has to be perfect alone.

**DOM size.** `@tanstack/react-virtual` renders only the cards near the viewport. Card heights vary with summary length, so I measure them with `measureElement` and give an estimate (~180 px) for the rest. Fifty pages deep, the DOM still holds ~25 cards. An `IntersectionObserver` on a sentinel row about two screens before the end triggers `fetchNextPage`, so the next page is usually there before the reader gets to it.

**Keeping your place.** The infinite query lives in the TanStack Query cache, not in component state, so pages and the virtualizer's offsets survive navigating into a story and back. I restore scroll on back navigation from the router's scroll restoration, keyed by route.

**Accessibility of a virtual list.** Cards outside the window don't exist for assistive technology, so I use the ARIA `feed` pattern: `role="feed"` on the list, `role="article"` on each card with `aria-posinset` and `aria-setsize` (or `-1` while more pages exist), and `aria-busy` while a page loads. Page Down and Page Up move between cards, and focus stays on the current card while the window shifts.

| Approach | Verdict |
|----------|---------|
| ✅ Snapshot cursor + virtualization + client dedupe | Constant DOM, no repeats, place kept across navigation |
| ❌ Offset pages over a live ranking | Repeats and silent gaps as the ranking moves |
| ❌ Render every loaded card | Thousands of nodes after a long session; INP climbs past 200 ms |
| ❌ Numbered pages | Simple and accessible, but wrong for a stream you skim |

"What I give up: the order within a scroll is up to 15 minutes old. Pull-to-refresh starts a fresh snapshot, and anything urgent arrives through the banner."

### Deep dive 2: rendering and first paint (5 min)

**SSR at the edge for public pages.** The anonymous front page, topic pages and story pages are server-rendered with real HTML, metadata and Open Graph tags, and cached at the CDN with `s-maxage=30, stale-while-revalidate=60`. The CDN absorbs nearly all anonymous traffic, and a reader arriving from a link sees text after one round trip. Signed-in requests skip the shared cache: the shell is server-rendered, but the personalized feed is fetched client-side with `Cache-Control: private`.

**The LCP element is usually the lead image or headline.** Story images get explicit width and height (or an `aspect-ratio` box), `srcset` with AVIF/WebP, and `fetchpriority="high"` on the first card only; the rest are `loading="lazy"`. Fonts are subset and preloaded with `font-display: swap` and fallback metrics matched, so text doesn't reflow.

**JavaScript budget.** Route-level code splitting: admin and settings are separate chunks, and the story page chunk is prefetched when a card scrolls into view or is hovered. Prefetching a card also warms `['story', id]`, so opening a story usually renders from cache.

| Approach | Verdict |
|----------|---------|
| ✅ SSR + CDN for public pages, client feed for signed-in readers | Fast cold visits and SEO; personal data never in a shared cache |
| ❌ Pure SPA | Blank page until JS loads on cold visits; weak for search and sharing |
| ❌ SSR personalized pages at the edge | Per-user rendering cost, no CDN hits, and a cache-key mistake would leak one reader's feed to another |

"What I give up: two rendering paths to maintain, and hydration cost on public pages, which I keep small by shipping little interactivity there."

### Deep dive 3: breaking news without moving the page (4 min)

**Transport.** The banner subscribes once in the shell to an SSE stream. SSE fits a one-way, low-rate stream: it runs over plain HTTP, reconnects on its own and resumes with `Last-Event-ID`, so a reader coming out of a tunnel gets the events they missed. If the stream fails repeatedly, the shell falls back to polling `/breaking` every 60 s, only while the tab is visible. A WebSocket would add a bidirectional channel and heartbeat code for data that only flows one way.

**Stability.** New stories never jump into the list being read. The banner sits in a slot of fixed height, and new feed stories collect behind a "3 new stories" pill that refreshes the snapshot when tapped. CLS stays near zero, and nobody loses the paragraph they were reading.

**Announcements.** New breaking items are announced through `aria-live="polite"`, never `assertive`: interrupting a screen-reader user mid-sentence for every headline is hostile. The banner says why the story is breaking ("4 sources in 30 minutes"), which is the server's actual rule, and items disappear when the server drops them after six hours.

### Deep dive 4: security and the read signal (3 min)

- **Untrusted links.** Every outlet URL comes from third-party feeds. The server accepts only absolute `http:`/`https:` links at ingestion, and the client checks the scheme again before rendering an `href`. A stored `javascript:` URL would run in the reader's session. Outbound links use `rel="noopener noreferrer"`, and a strict CSP (`script-src 'self'`) backs this up.
- **Session.** An `HttpOnly`, `SameSite=Lax` cookie: invisible to scripts, not sent on cross-site POSTs. Mutations also require a JSON content type.
- **The read signal.** Opening an outlet's article sends `POST /reading-history` with `keepalive: true`, because the reader is leaving and a normal `fetch` might be cancelled. It's fire-and-forget: no spinner, no error toast, and retrying is safe because the server only learns from the first read.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the reader sees | How |
|-----------|----------------------|-----|
| First feed load | Skeleton cards at real card height | SSR HTML for public pages; skeletons only for the personalized feed |
| Next page loading | A spinner row at the end; `aria-busy` on the feed | `isFetchingNextPage` |
| End of feed | "You're all caught up", with a refresh button | `has_more: false` |
| Network drops | "You're offline", cached cards stay readable | Query cache keeps data; a service worker serves the shell |
| Search fell back | "Search is degraded; showing basic matches" | `engine: "postgres"` in the response |
| No search results | "No results for 'X' in the last 7 days", with a wider-range shortcut | Filters live in the URL |
| Story no longer exists | "This story was merged or removed", with a link home | `404` from `/stories/{id}` |
| Session expired | Feed falls back to the public ranking; a sign-in prompt in the header | Any `401` clears the session store |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SSR + CDN for public pages; client feed when signed in | Pure SPA, or SSR everything | Fast cold visits without caching personal data |
| Server state | TanStack Query (infinite query) | Copying responses into Zustand | Caching, dedupe, cancellation, invalidation for free |
| Feed paging | Opaque snapshot cursor + client dedupe | Offset pages | No repeats or gaps while the ranking moves |
| Long lists | Virtualization + ARIA `feed` pattern | Render everything | Constant DOM, accessible |
| Breaking news | SSE in the shell + "new stories" pill | WebSocket, or inserting into the list | One-way stream, no layout shift |
| Read signals | `keepalive` fire-and-forget, server-side idempotency | Client-side "already sent" tracking | Simpler and retry-safe |

"With more time I'd add offline reading (cache the last feed and opened stories in IndexedDB and queue read signals), a 'less like this' control on cards, and per-route real-user Web Vitals so I know whether the SSR split actually paid off."

# 🔗 URL Shortener (Bitly) — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The redirect itself never runs our JavaScript — a visitor's browser gets a `302` and moves on. So the frontend problem is the owner's console: a creation form that must never turn one click into two links, a list that may hold 50,000 links, and an analytics view that has to be honest about how fresh its numbers are."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, performance and accessibility targets |
| A — Architecture | 8 min | Component tree, who owns which state, the data layer |
| D — Data model | 5 min | Client entities and cache keys |
| I — Interface | 5 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 20 min | Safe creation, a fast huge list, honest analytics, security |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses this and on what devices, because that sets the performance budget."

### Functional requirements

1. **Create a link**: paste a URL, optionally choose an alias (with availability feedback) and an expiry, get the short URL, copy it in one click.
2. **Browse links**: search, sort and scroll through all of an owner's links — power users have tens of thousands — with status badges.
3. **Link details**: clicks over a selectable range (24 h, 7 d, 30 d, custom), top referrers, devices and countries.
4. **Manage**: deactivate or reactivate a link, change its expiry.
5. **Admin console** (role-gated): review abuse reports and take links down.

Out of scope: the redirect's own interstitial pages, QR rendering, team workspaces.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP | < 2.0 s on a mid-range Android over 4G | Owners often create links from their phones |
| INP | < 200 ms, including typing in search | The list must stay responsive at 50K links |
| CLS | < 0.1 | Charts and tables reserve their space |
| JavaScript | < 170 KB gzipped initial; charts (~60 KB) and admin lazy-loaded | Most sessions never open a chart |
| Accessibility | WCAG 2.2 AA, full keyboard use, async results announced | Forms and tables are the whole product |
| Security | No XSS through user-supplied URLs; CSRF-safe mutations | We render attacker-controlled URLs by design |

---

## 🏗️ A — Architecture (8 min)

"This is an authenticated dashboard with no SEO needs, so I'd build a client-rendered SPA with route-level code splitting rather than server rendering. SSR would buy a faster first paint for pages nobody crawls, at the cost of a rendering tier to run and scale. The cost of the SPA is a slower cold start, which I'll manage with a small initial bundle and immutable caching of hashed assets."

```
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │ App shell · TanStack Router · route guards read session (Zustand)                        │
 │ URL state: /links?q=…&sort=…   /links/$code?range=7d                                     │
 └────────────┬───────────────────────────────┬────────────────────────────────┬────────────┘
              │                               │                                │
              ▼                               ▼                                ▼
 ┌─────────────────────────┐     ┌─────────────────────────┐     ┌──────────────────────────┐
 │ /links                  │     │ /links/$code            │     │ /admin (lazy chunk)      │
 │ CreateLinkForm          │     │ Link header + actions   │     │ Abuse queue · takedown   │
 │ LinkTable (virtualized) │     │ StatsPanel (lazy chart) │     │ User table               │
 └──┬───────────────┬──────┘     └────────────┬────────────┘     └─────────────┬────────────┘
    │ draft + K     │ (1) create              │ (3) stats                      │ admin calls
    │               │ (2) list                │                                │
    │               │                         │                                │
    ▼               ▼                         ▼                                ▼
 ┌────────────┐  ┌──────────────────────────────────────────────────────────────────────────┐
 │ session-   │  │ TanStack Query cache                                                     │
 │ Storage:   │  │ ['links', {q, sort}] · ['link', code] · ['stats', code, range, tz]       │
 │ draft + K  │  │ dedupe · retry · optimistic update + rollback · invalidation             │
 └────────────┘  └─────────────────────────────────────┬────────────────────────────────────┘
                                                       ▼
                 ┌──────────────────────────────────────────────────────────────────────────┐
                 │ API client: fetch + AbortSignal · Idempotency-Key · If-Match             │
                 │ problem+json → typed errors · 401 → back to login                        │
                 └─────────────────────────────────────┬────────────────────────────────────┘
                                                       │ HTTPS · session cookie
                                                       ▼
                 ┌──────────────────────────────────────────────────────────────────────────┐
                 │ Link API  ·  /api/v1/links  ·  /links/{code}/stats  ·  /api/v1/admin     │
                 └──────────────────────────────────────────────────────────────────────────┘
```

1. **Create (1).** `CreateLinkForm` freezes the draft with an idempotency key in `sessionStorage`, then runs a mutation through the query cache. On success the new link is inserted into the cached list, so it appears without a refetch.
2. **Browse (2).** `LinkTable` reads `['links', {q, sort}]` as an infinite query. Search and sort live in the URL, so the back button and shared links restore the same view.
3. **Analyze (3).** `/links/$code` reads `['stats', code, range, tz]`; the chart code is a separate lazy chunk, and the range lives in the URL too.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Server data: links, stats, admin lists | TanStack Query | Caching, request dedupe, retries, cancellation and invalidation, without hand-written loading flags |
| Search, sort, stats range | URL search params (router) | Shareable, bookmarkable, survives reload, works with back/forward |
| Session: user and role | Zustand, filled from `/me` | Needed by every route guard; tiny |
| Create draft + idempotency key | Component state mirrored to `sessionStorage` | Survives a refresh during a pending request |
| Dialogs, menus, toasts | Local component state | Never shared, never persisted |

"The rule I'm applying: server data never lives in Zustand. Once you copy server data into a client store you own its staleness, deduplication and invalidation by hand — and that's where most dashboard bugs come from."

### Key interaction: creating a link

```
 Owner                   CreateLinkForm          Query cache                            Link API
   │                            │                     │                                     │
   │ 1 submit                   │                     │                                     │
   │───────────────────────────▶│                     │                                     │
   │                            │ 2 freeze draft, key K → sessionStorage                    │
   │                            │ 3 mutate(draft, K)  │                                     │
   │                            │────────────────────▶│                                     │
   │                            │                     │ 4 POST /links, Idempotency-Key K    │
   │                            │                     │────────────────────────────────────▶│
   │                            │                     │ 5 201 Link (timeout: retry with K)  │
   │                            │                     │◀────────────────────────────────────│
   │                            │                     │ 6 prepend to ['links'] pages        │
   │                            │ 7 success           │                                     │
   │                            │◀────────────────────│                                     │
   │ 8 short URL + Copy button  │                     │                                     │
   │◀───────────────────────────│                     │                                     │
   │                            │                     │                                     │
```

"The short URL only exists once the server assigns a code, so creation is deliberately *not* optimistic. The form shows a pending state; if the request times out, a Retry button resends with the same key `K`, and the server returns the original link instead of minting a second one."

### Key interaction: deactivating a link

```
 Owner                   LinkTable                   Query cache                           Link API
   │                         │                            │                                    │
   │ 1 Deactivate (confirm)  │                            │                                    │
   │────────────────────────▶│                            │                                    │
   │                         │ 2 mutate({code, version})  │                                    │
   │                         │───────────────────────────▶│                                    │
   │                         │                            │ 3 snapshot; mark row disabled      │
   │                         │ 4 re-render immediately    │                                    │
   │                         │◀───────────────────────────│                                    │
   │                         │                            │ 5 PATCH /links/{code}, If-Match v  │
   │                         │                            │───────────────────────────────────▶│
   │                         │                            │ 6 200 | 412 stale | 5xx            │
   │                         │                            │◀───────────────────────────────────│
   │                         │                            │ 7 error → restore snapshot + toast │
   │                         │                            │ 8 settled → invalidate link + list │
   │                         │                            │                                    │
```

"Deactivation *is* optimistic: it's a single field, it almost always succeeds, and rolling back is trivial. The `version` in `If-Match` means an admin takedown that happened in the meantime produces a `412` rather than being silently overwritten — the UI refetches and explains what changed."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `Link` | `code`, `shortUrl`, `longUrl`, `status`, `expiresAt`, `createdAt`, `clickCount`, `version` | `['link', code]`, and inside list pages | `staleTime` 30 s |
| `LinksPage` | `items: Link[]`, `nextCursor` | `['links', {q, sort}]` (infinite query) | Invalidated after create, deactivate or expiry change |
| `Stats` | `buckets[{t, count}]`, `referrers`, `devices`, `countries`, `asOf`, `partial` | `['stats', code, {range, tz}]` | `staleTime` 60 s; refetched while visible |
| `CreateDraft` | `longUrl`, `alias`, `expiresAt`, `idempotencyKey`, `status` | `sessionStorage['create-draft']` | Cleared on success |
| `Session` | `id`, `email`, `role` | Zustand | Refreshed on window focus and on any `401` |

Two modeling decisions:

- **No normalized entity store.** TanStack Query caches responses, not entities, so a link appears both in `['link', code]` and in a list page. After a mutation I update both with `setQueryData` for instant feedback, then invalidate to reconcile with the server. A normalized store (Apollo-style) would avoid the double write, but it isn't worth a GraphQL-style cache for an app with three entity types.
- **`clickCount` on a link is approximate.** It comes from rollups that lag a minute. I label it "≈" in the table and show exact numbers only in the stats view, which carries its own `asOf`.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
POST  /api/v1/links                       {long_url, alias?, expires_at?} + Idempotency-Key → 201 | 409 | 422
GET   /api/v1/links?q&sort&cursor&limit   → {items, next_cursor}
GET   /api/v1/links/{code}                → Link (includes version)
PATCH /api/v1/links/{code}                {status | expires_at} + If-Match: version → 200 | 412
GET   /api/v1/links/{code}/stats          ?from&to&tz&granularity → {buckets, referrers, as_of, partial}
GET   /api/v1/aliases/{alias}             → {available}   (advisory only)
```

- Errors arrive as `application/problem+json`; the API client maps field errors (for example `alias: taken`) onto form fields and everything else onto a toast.
- The stats request carries the viewer's IANA time zone, because "clicks per day" depends on where the day starts. The server buckets; the client only formats with `Intl.DateTimeFormat`.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<CreateLinkForm onCreated(link)>` | Owns the draft lifecycle: validate → freeze → submit → retry with the same key |
| `<LinkTable query={{q, sort}} onSelect(code)>` | Virtualized rows; keyboard navigation; row actions in a menu |
| `<StatsPanel code range onRangeChange>` | Lazy chart with a fixed-height skeleton and a table fallback |
| `useCreateLink()`, `useSetLinkStatus()` | Wrap the mutation plus every cache update, so components never touch query keys |

---

## 🔧 O — Optimizations & Deep Dives (20 min)

### Deep dive 1: creation that survives double clicks and flaky networks (7 min)

"The failure I'm designing for: the owner clicks Create on a train, the request times out, and they can't tell whether a link was made. If they click again and we create a second link, their analytics split across two codes forever."

**The approach.** When the form is submitted, I freeze the draft and generate an idempotency key with `crypto.randomUUID()`, saving both to `sessionStorage`. Every retry of that draft — the Retry button, an automatic retry on a network error, even a page refresh that finds a pending draft — resends the same key, and the server answers with the original link. Editing the draft creates a new key, because it's now a different request (and the server rejects a reused key with a different body).

**The alias check is advisory.** While the owner types an alias I check availability after a 300 ms pause, abort the previous check with an `AbortController`, and show "available" as a hint. Between the check and the submit, someone else can still claim it, so the authoritative answer is the `409` from the create call, which the form shows on the alias field.

**Validation.** On the client I parse with `new URL()`, allow only `http:` and `https:`, cap the length at 2,048, and trim pasted whitespace. That's for fast feedback; the server re-validates everything.

**Success.** I prepend the link into the cached first page with `setQueryData`, show the short URL with a Copy button (`navigator.clipboard.writeText`, falling back to selecting the text if permission is denied), and announce "Link created" through an `aria-live="polite"` region so screen-reader users hear the result.

| Approach | Verdict |
|----------|---------|
| ✅ Pessimistic create + idempotency key | Correct under retries; the pending state lasts ~200 ms normally |
| ❌ Fully optimistic create | We can't show a short URL before the server assigns the code; client-chosen codes would collide and invite abuse |
| ❌ Disable the button and hope | Prevents double clicks, but not a retry after a timeout or a refresh |

"What I give up is a moment of 'Creating…' instead of instant feedback — fine for an action users do a few times a day, and much better than duplicate links."

### Deep dive 2: a list that stays fast at 50,000 links (7 min)

"Rendering 50,000 table rows would take seconds and blow the INP budget on every keystroke. Three techniques keep it flat."

1. **Server-side search, sort and cursor pagination.** `useInfiniteQuery` loads 50 rows per page using the server's `next_cursor`. Search is debounced by 250 ms, lives in the URL as `q`, and uses `placeholderData: keepPreviousData` so the table doesn't flash empty while new results load.
2. **Virtualization.** `@tanstack/react-virtual` renders only the ~20 rows in view plus a few of overscan, so DOM size is constant whether there are 50 or 50,000 rows. Rows have a fixed 56 px height, so there's no measuring. When the user scrolls near the end I fetch the next page.
3. **Responsive typing.** The search input updates immediately; the filtered query runs inside `startTransition`, so React can interrupt list rendering to handle the next keystroke.

Virtualization has an accessibility cost: rows that aren't rendered don't exist for a screen reader. I set `aria-rowcount` on the table and `aria-rowindex` on each row, use a roving `tabindex` so arrow keys move between rows, and call `scrollToIndex` to keep the focused row rendered.

| Approach | Verdict |
|----------|---------|
| ✅ Cursor pages + virtualization | Constant DOM size; the server does the searching |
| ❌ Load everything, filter client-side | 50K rows is ~10 MB of JSON and a multi-second first render |
| ❌ Numbered pages with OFFSET | Easier to build, but deep pages get slow server-side and rows shift when new links are created |

### Deep dive 3: analytics that are fast and honest (4 min)

- **Prefetch on intent.** Hovering or focusing a row preloads its `/links/$code` route and starts the stats query, so the detail view usually renders from cache.
- **Lazy charts without layout shift.** The chart library is a separate chunk loaded with `React.lazy`; the `Suspense` fallback is a skeleton with the chart's exact height, so CLS stays at zero.
- **Freshness is visible.** The panel shows "Updated 14:05" from the server's `as_of`. If the backend reports `partial` — for example, its event pipeline dropped clicks during an outage — the UI shows a banner for the affected window instead of silently under-reporting.
- **Polling, not push.** The stats query refetches every 60 s, and only while the tab is visible. A WebSocket would make the counter tick in real time, but the backend's numbers are already about a minute behind, so a persistent connection per open dashboard would buy nothing.
- **Accessible charts.** Each chart has a one-sentence text summary ("1,240 clicks in the last 7 days, peak on Tuesday"), a "View as table" toggle, and colors that don't carry meaning alone.

### Deep dive 4: security and performance checklist (2 min)

- **XSS through destinations.** Long URLs are attacker-controlled. I render them as text, and when one becomes an `href` I re-check that the scheme is `http:` or `https:` — a stored `javascript:` URL would otherwise run in the session of whoever clicks it, which in the abuse queue is an administrator. Links open with `rel="noopener noreferrer"`, and a strict Content-Security-Policy (`script-src 'self'`) backs this up.
- **CSRF.** The session cookie is `SameSite=Lax`, mutations require a JSON content type and a custom header, and CORS only allows the app's origin.
- **Performance.** Route-based code splitting, hashed assets with `Cache-Control: immutable`, preloading on hover, subsetted fonts, and real-user Web Vitals reporting segmented by route.

---

## 🧯 Loading, Error and Empty States (2 min)

"Most of the experience of a dashboard is what it does when things aren't perfect, so I design those states up front."

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| First load of the list | Skeleton rows at the real row height | `isPending` on the first page only; later pages show a spinner row at the bottom |
| Network drops mid-session | "You're offline — changes will retry" banner; cached data stays visible | TanStack Query pauses mutations while offline and resumes them on reconnect |
| Session expires during a create | Login dialog over the form; the draft is still there | The pending draft and its key live in `sessionStorage`; after login the form resubmits with the same key |
| `429 Too Many Requests` | "Try again in 42 s" on the Create button | The client reads `Retry-After` and counts down instead of letting the user hammer the button |
| `412` on deactivate | "This link changed — here's the latest version" | Refetch the link, show what changed, let the owner retry |
| No links yet | Empty state with the create form focused | The empty state is the onboarding |
| No clicks in range | "No clicks between Oct 3 and Oct 10" plus a wider-range shortcut | An empty chart with axes looks like a bug |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA with code splitting | SSR | Authenticated dashboard, no SEO |
| Server state | TanStack Query | Zustand or Redux plus hand-written fetching | Caching, dedupe and invalidation without bespoke code |
| Creating links | Pessimistic + idempotency key | Optimistic | The server assigns the code; retries must not duplicate |
| Deactivating | Optimistic + rollback | Wait for the server | One field, almost always succeeds |
| Large lists | Cursor pages + virtualization | Load all and filter | 50K rows would wreck INP |
| Stats refresh | Visible-tab polling every 60 s | WebSocket | The data is a minute behind anyway |

"With more time I'd add a bulk CSV import that parses in a Web Worker, persist the query cache to IndexedDB so the list opens instantly on repeat visits, and track per-route Web Vitals in production."

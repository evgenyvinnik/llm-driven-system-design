# 💼 LinkedIn (Professional Network) — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Almost every LinkedIn screen is a view over the social graph. Whether a profile shows Connect, Pending, Accept or Message depends on relationship state the server owns, and one accepted invitation changes the profile, the invitations list, People You May Know and the feed at once — possibly in another tab. So the frontend problem is keeping a cached projection of the graph honest while every action still feels instant, plus rendering an endless, variable-height feed at 60 fps."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, Web Vitals targets, devices, accessibility |
| A — Architecture | 8 min | Rendering split, component tree, who owns which state |
| D — Data model | 5 min | Cache keys, the relationship entity, staleness per key |
| I — Interface | 5 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 20 min | Graph mutations, the feed, live updates, search |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who's using this and on what, because that sets the budgets."

### Functional requirements

1. **Feed**: ranked posts from connections, a composer, likes and comments, infinite scroll.
2. **Profile**: experience, education, skills; for other people, the degree badge, mutual connections, the "how you're connected" path, and the right connection action.
3. **My Network**: invitations to accept or ignore, my connections, People You May Know with a reason on each card.
4. **Search**: people and jobs with typeahead and filters; job detail and apply.
5. **Notifications**: a badge and a panel; an accepted invitation shows up within seconds on every open tab and device.

Out of scope: messaging, the recruiter product, ads.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP | < 2.5 s cold on a mid-range laptop and 4G phone; < 1 s on repeat visits | The feed is the landing page |
| INP | < 200 ms, including Connect and Like | Social actions must feel instant |
| CLS | < 0.1 | Images, the degree badge and late-loading cards reserve space |
| Scroll | 60 fps through hundreds of variable-height posts | Long sessions on the feed |
| JavaScript | < 200 KB gzipped initial; each route its own chunk | Job search code never loads for feed-only sessions |
| Accessibility | WCAG 2.2 AA, full keyboard use, state changes announced | Enterprise customers require it |
| Convergence | A change made in one tab appears in the others within ~2 s | Members keep LinkedIn open in several tabs |

Devices: desktop-heavy (professionals at work) but responsive down to mobile web; the native apps share the same API.

---

## 🏗️ A — Architecture (8 min)

"First decision: how to render. Logged-in pages are personalized and interactive; public profiles and job posts are LinkedIn's biggest acquisition channel from search engines."

| Surface | Strategy | Why |
|---------|----------|-----|
| ✅ Feed, My Network, notifications | Client-rendered SPA with route-level code splitting | Personalized, uncachable per URL, navigation should cost data, not markup |
| ✅ Public profiles, job posts | Server-rendered at the edge, cached per URL | Crawlers need HTML; anonymous visitors need one round trip to first paint |
| ❌ SSR everything | Server-render every page | Every navigation waits on a server round trip, and personalization defeats the edge cache |
| ❌ SPA everything | Client-render public pages too | Crawlers get an empty page; first paint waits for JavaScript, then an API call |

"The seam costs two rendering paths, so I keep public pages read-only: they share display components with the SPA but none of the mutation or cache machinery."

```
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Routes (TanStack Router, one chunk each): /  ·  /in/$id  ·  /mynetwork  ·  /search  ·  /jobs   │
 │ URL state: search text, job filters, active tab (shareable, back-button safe)                  │
 └────────┬─────────────────────────────┬─────────────────────────────┬─────────────────────┬─────┘
          ▼                             ▼                             ▼                     ▼
 ┌──────────────────────┐     ┌────────────────────────┐   ┌────────────────────────┐  ┌──────────┐
 │ FeedList             │     │ ProfileHeader          │   │ InvitationList · Pymk  │  │ Zustand  │
 │ virtualized, cursor  │     │ ConnectButton · Path   │   │ SearchBox (typeahead)  │  │ session  │
 └────────┬─────────────┘     └─────────┬──────────────┘   └──────────┬─────────────┘  │ badge    │
          │ (2) infinite                │ (1) mutation:               │ queries        └──────────┘
          │ query                       │ connect                     │
          ▼                             ▼                             ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ Query cache: ['feed'] · ['relationship', id] · ['invitations'] · ['pymk']        │
 │ ['profile', id] · ['search', q] · stale time per key · optimistic + rollback     │
 └──────────────────────┬───────────────────────────────────────────▲───────────────┘
                        │ fetch when stale                          │ (3) invalidate keys
                        │                                           │
                        ▼                           ┌───────────────┴───────────────┐
 ┌────────────────────────────────────────────┐     │ SSE client (leader tab)       │
 │ API client: fetch + AbortSignal            │     │ Last-Event-ID resume          │
 │ problem+json errors · retries GETs only    │     │ BroadcastChannel to tabs      │
 └──────────────────────┬─────────────────────┘     └───────────────▲───────────────┘
                        │ HTTPS, session cookie                     │ text/event-stream
                        │                                           │
                        ▼                                           │
 ┌──────────────────────────────────────────────────────────────────┴─────────────────────────────┐
 │ LinkedIn API · /feed · /members/{id}/relationship · /invitations · /pymk · /search · /events   │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Connect (1).** `ConnectButton` runs a mutation through the query cache: it writes the expected status immediately, sends the request, and replaces the guess with the server's answer.
2. **Scroll the feed (2).** `FeedList` is a virtualized infinite query; when the user nears the end it fetches the next page with the server's cursor and appends it.
3. **Live updates (3).** One tab holds the server-sent events stream; each event invalidates the cache keys it affects, and only visible queries refetch.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Server data: feed pages, profiles, relationships, invitations, PYMK, search results | TanStack Query | Dedupe, background refresh, retries, cancellation and invalidation without hand-written loading flags |
| Search text, job filters, active tab | URL search params | Shareable, bookmarkable, back-button safe |
| Session (viewer id, role) and unread badge hint | Zustand | Read by every route guard and the navbar; tiny |
| Composer draft | Component state mirrored to `sessionStorage` | Survives a refresh mid-post |
| Expanded comments, "see more" flags | A map keyed by post id in `FeedList` | Virtualized rows unmount; state inside them would reset |

"My rule: server data never gets copied into Zustand. Once you copy it, you own its staleness and invalidation by hand, and two copies of 'are we connected?' will eventually disagree on screen."

### Key interaction: Connect

```
Member          ConnectButton                              Query cache    Graph API
   │                  │                                         │             │
   │ 1 click Connect  │                                         │             │
   │─────────────────▶│                                         │             │
   │                  │ 2 snapshot; status = pending_sent       │             │
   │                  │────────────────────────────────────────▶│             │
   │                  │ 3 re-render "Pending" at once           │             │
   │                  │◀────────────────────────────────────────│             │
   │                  │ 4 POST /invitations {to}                              │
   │                  │──────────────────────────────────────────────────────▶│
   │                  │ 5 201 sent | 200 already_pending | 200 connected      │
   │                  │◀──────────────────────────────────────────────────────│
   │                  │ 6 write server status; invalidate pymk  │             │
   │                  │────────────────────────────────────────▶│             │
   │                  │ 7 on error: restore snapshot, announce  │             │
   │                  │────────────────────────────────────────▶│             │
   │                  │                                         │             │
```

"Steps 2–3 make the click feel instant. Step 5 is the important one: the server can answer with three different outcomes — a new invitation, one that was already pending, or `connected` because the other person had already invited me — and I render whatever it says rather than my guess."

### Key interaction: scrolling the feed

```
 Feed list                    Virtualizer    Query cache                  Feed API
     │                             │              │                           │
     │ 1 render 20 posts, measure  │              │                           │
     │────────────────────────────▶│              │                           │
     │ 2 near the end              │              │                           │
     │◀────────────────────────────│              │                           │
     │ 3 fetchNextPage(cursor)                    │                           │
     │───────────────────────────────────────────▶│                           │
     │                             │              │ 4 GET /feed?cursor=c2     │
     │                             │              │──────────────────────────▶│
     │                             │              │ 5 20 posts + next cursor  │
     │                             │              │◀──────────────────────────│
     │ 6 append; no reflow                        │                           │
     │◀───────────────────────────────────────────│                           │
     │                             │              │                           │
```

"The cursor names a ranked snapshot on the server, so page two continues the same ordering even though scores changed in the meantime. Offsets would repeat or skip posts at every page boundary."

### Key interaction: a change in another tab or device

```
 Graph API                       SSE (leader tab)                   Query cache   Other tabs
     │                                   │                               │             │
     │ 1 pair.connected id=812           │                               │             │
     │──────────────────────────────────▶│                               │             │
     │                                   │ 2 invalidate relationship(B)  │             │
     │                                   │──────────────────────────────▶│             │
     │                                   │ 3 BroadcastChannel relay                    │
     │                                   │────────────────────────────────────────────▶│
     │ 4 refetch visible queries                                         │             │
     │◀──────────────────────────────────────────────────────────────────│             │
     ······················ connection drops, browser reconnects ·······················
     │ 5 GET /events, Last-Event-ID 812  │                               │             │
     │◀──────────────────────────────────│                               │             │
     │ 6 replay events after 812         │                               │             │
     │──────────────────────────────────▶│                               │             │
     │                                   │                               │             │
```

"Events carry entity ids, not UI instructions. The client maps each to cache keys; `Last-Event-ID` replays anything missed during a sleep or a network change."

---

## 💾 D — Data Model (5 min)

"The cache is keyed by what the server returns. The interesting part is how stale each key is allowed to be."

| Entity | Shape | Cache key | Stale after | Why |
|--------|-------|-----------|-------------|-----|
| `FeedPage` | `posts[]`, `nextCursor` | `['feed']` (infinite) | 2 min | Re-ranking under the reader is jarring |
| `Profile` | Public fields, sections | `['profile', id]` | 5 min; mine never (invalidated on edit) | Headlines change rarely |
| `Relationship` | `degree`, `status`, `requestId`, `mutualCount`, `path[]` | `['relationship', id]` | Until a mutation or an event | Decides which buttons render |
| `Invitations` | Received invitations with sender summaries | `['invitations']` | Until a mutation or an event | Drives the badge and the accept flow |
| `Pymk` | `candidates[]` with `reasons[]` | `['pymk']` | Session | Precomputed daily server-side |
| `SearchResults` | `hits[]`, `source` | `['search', q, filters]` | 1 min | Backspacing re-renders from cache |

**Relationship is the shared entity.** The same person appears as a feed author, a PYMK card, a search hit and a profile. Every Connect button, wherever it renders, reads `['relationship', id]`, so accepting an invitation flips them all in one cache write.

"I treat relationship as load-bearing data and mutual counts as decoration. If the relationship goes stale, the UI offers actions the server will reject; if a mutual count is off by one for half an hour, nobody notices."

**No fully normalized store.** A normalized entity cache (Apollo-style) would deduplicate person summaries across lists, but for five entity types `setQueryData` on the few keys a mutation touches, plus invalidation, is simpler and easier to debug.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET    /api/v1/feed?cursor=                 → {posts, next_cursor}
POST   /api/v1/posts                        Idempotency-Key → 201 Post
POST   /api/v1/posts/{id}/like              → 200 (idempotent; DELETE to unlike)
GET    /api/v1/members/{id}/relationship    → {degree, status, request_id, mutual_count, path}
POST   /api/v1/invitations                  {to} → {outcome: sent|already_pending|connected, status}
POST   /api/v1/invitations/{id}/accept      → {status, changed}   (/decline, /withdraw)
GET    /api/v1/pymk?limit=20                → {candidates[{member, reasons}]}
GET    /api/v1/search/people?q=             → {hits, source}
GET    /api/v1/events                       text/event-stream, resumable with Last-Event-ID
```

- **Graph writes are idempotent and say what happened**, so the client may retry and must render the returned `status`.
- **Errors** arrive as `application/problem+json`; the API client maps `code` (`already_connected`, `request_not_pending`, `rate_limited`) to specific messages, and reads `Retry-After` on `429`.
- **`source: postgres`** on search means the server's search cluster is degraded; the UI says "Results may be incomplete" instead of pretending.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<ConnectButton memberId>` | Reads `['relationship', id]`; renders Connect, Pending (withdraw), Accept/Ignore or Connected; owns no server state |
| `useConnectionMutation(memberId)` | Snapshot, optimistic status, request, reconcile with the server's status, roll back and announce on error |
| `<ConnectionPath relationship>` | "You → Bob → Ethan" with links; nothing for 1st degree; "outside your network" when there's no path |
| `<FeedList>` | Virtualized rows with measured heights; owns expanded-state map; fetches next page near the end |
| `<PostCard post onLike onExpand>` | Presentational; mutations live in the list above |

---

## 🔧 O — Optimizations & Deep Dives (20 min)

### Deep dive 1: graph mutations that feel instant and stay honest (7 min)

"The decision: optimism only where the outcome is predictable, and a state machine — not a boolean — for connections."

**Two kinds of action.** Likes and endorsements are self-inverse toggles on idempotent endpoints: flip the UI, send, flip back on failure. The count I show is the server's last count plus my delta, never a local counter that drifts. Connections are a state machine — none → pending_sent → connected, plus pending_received, withdraw, decline and remove — so optimism means advancing the machine to the state I expect, keeping a snapshot, and accepting whatever the server says.

**Why the server's answer wins.** Three things can happen on Connect that my guess can't know: the other person already invited me (the server connects us, `outcome: connected`), I already had a pending invitation from another tab (`already_pending`), or I hit the invitation rate limit (`429`). Rendering the response instead of the guess handles all three without special cases, and the rollback path restores the snapshot and announces the error through an `aria-live` region so screen-reader users hear it too.

**Accepting touches three caches at once** — invitations, connections and the relationship — so I apply all three updates in one batch from one snapshot. Applying them one by one creates a frame where the person appears in both lists, which users screenshot as a bug.

**What isn't optimistic: posting.** A phantom post needs a temporary id that flows into likes, comments and permalinks, and a failed publish makes a post the user watched appear vanish. A 300 ms "Posting…" state is better.

| Approach | Verdict |
|----------|---------|
| ✅ Optimistic state machine + server status wins | Instant, and correct for crossing invitations, duplicates and rate limits |
| ❌ Wait for the server | Correct, but every Connect shows a spinner on the most frequent action in the product |
| ❌ Optimistic boolean (`connected = true`) | Can't express pending versus connected, and lies when the server connected us via a crossing invite or refused us |

"What I give up is a little complexity — a snapshot per mutation and a mapping from error codes to messages. For the action the whole growth loop depends on, that's worth it."

### Deep dive 2: a feed that stays at 60 fps (7 min)

"The decision: virtualize with measured heights, page with server cursors, and never reflow content under the reader."

1. **Virtualization.** `@tanstack/react-virtual` renders only the rows in view plus a few of overscan. Post heights vary from two lines of text to an image with expanded comments, so rows start at an estimated 400 px and are measured after render; images reserve their aspect ratio so a late image never jumps the scroll position.
2. **Cursor pages.** The infinite query fetches the next page when the user is about five rows from the end, using the server's `next_cursor`. Because the cursor names a ranked snapshot, pages don't duplicate or skip posts.
3. **New posts don't reflow the list.** Posts that arrive during a session are announced with a "New posts" pill at the top; clicking it scrolls up and refetches. Ranked feeds must not shift under someone reading.
4. **State outside rows.** Expanded comments and "see more" live in a map keyed by post id in the list, because virtualized rows unmount and would forget.
5. **Lazy comments.** Comments load only when opened; at 17K feed loads a second, eagerly loading them would multiply backend reads for content most people never expand.

| Approach | Verdict |
|----------|---------|
| ✅ Virtualized rows + cursor pages | DOM stays at ~15 cards no matter how far you scroll |
| ❌ Render every loaded post | 200 heavy cards means tens of thousands of DOM nodes; scroll frames drop on mid-range laptops |
| ❌ Numbered pages | Breaks the reading flow, and offsets shift when ranking changes |

"Virtualization has costs I accept: browser find-in-page can't see unmounted posts, so I expose list semantics with `aria-setsize` and `aria-posinset` and keep a 'skip to navigation' link, since an infinite feed has no bottom. And the cache holds at most ~20 pages; beyond that I drop page data but keep cursors, refetching if the user scrolls back up."

### Deep dive 3: live updates as cache invalidation (4 min)

"The decision: one server-sent events stream per browser, whose main job is telling the cache what became stale."

| Approach | Verdict |
|----------|---------|
| ✅ SSE, one leader tab | Server-to-client only, which is all notifications need; plain HTTP through proxies; built-in reconnect with `Last-Event-ID` replay |
| ❌ WebSocket | Bidirectional, which this feature doesn't use; custom heartbeat and resume logic |
| ❌ Polling every 10 s | 10M open sessions → 1M requests/s, almost all returning nothing; latency floored at the interval |

**Mapping events to keys.** `pair.connected` invalidates `['relationship', id]`, `['invitations']` and `['pymk']`; `invitation.received` invalidates `['invitations']` and bumps the badge hint; `post.liked` patches that post's count in the feed pages if it's loaded. Only queries currently on screen refetch.

**Badge integrity.** Events increment the badge as a hint; opening the panel fetches the real unread count. Hints drift (missed events, two tabs), and reconciling on open makes the drift self-healing.

**One connection per browser.** A leader tab, elected with the Web Locks API, holds the stream and relays events over a `BroadcastChannel`. Three tabs holding three streams triple the server's connection count for nothing.

"What I give up: a long-lived connection per browser and leader-election code. If the stream fails for more than 30 seconds, the client falls back to polling the unread count every minute — less live, still correct."

### Search, accessibility, security and performance (2 min)

- **Typeahead:** debounce 200 ms but submit immediately on Enter; abort the previous request with an `AbortController` so a slow response for "jav" can never overwrite "javascript"; cache by normalized query; keep the query and filters in the URL.
- **Accessibility:** the degree badge has text, not only color; Connect announces "Pending" after the optimistic flip; icon buttons carry names and like buttons expose `aria-pressed`; dialogs trap and return focus.
- **Security:** posts, headlines and comments render as text; links get `rel="noopener noreferrer"` and only `http(s)` schemes; the session cookie is `HttpOnly` and `SameSite=Strict`, so mutations can't be forged cross-site; a CSP with `script-src 'self'` backs this up.
- **Performance:** route chunks, prefetching a profile's data on hover over a name, sized avatars, the system font stack, and third-party scripts after first interaction.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| First feed load | Skeleton cards at real card height | Pending state of the first page only; later pages show a spinner row |
| Relationship still loading | Profile renders; the action area keeps its size with a neutral placeholder | Separate query with its own timeout; the badge is an enhancement |
| Connect fails or is rate-limited | Button returns to Connect; "You've sent a lot of invitations — try again in 3 minutes" | Snapshot rollback; `429` with `Retry-After` |
| Invitation already handled elsewhere | "Already accepted" and the right button | `200 changed: false` renders the returned status |
| Offline | "You're offline" banner; cached feed and profiles stay readable | Mutations pause and resume on reconnect |
| Search cluster degraded | Results plus "Results may be incomplete" | Response has `source: postgres` |
| No connections yet | My Network opens on PYMK with the composer for an invitation note | The empty state is onboarding |
| Outside your network | "Outside your network" instead of a badge; Connect still offered | `degree: null` |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA for members, SSR for public pages | One strategy everywhere | Interactivity and SEO need opposite things |
| Server state | TanStack Query, relationship as shared key | Copies in Zustand | One source of truth per member on screen |
| Connect | Optimistic state machine, server status wins | Boolean optimism or spinners | Instant and correct for crossing invitations |
| Posting | Pessimistic, prepend the server's post | Optimistic phantom post | No temporary ids, no vanishing posts |
| Feed | Virtualized + cursor pages + "New posts" pill | Render all, offsets | 60 fps and no reflow |
| Live updates | SSE in a leader tab, events invalidate keys | Polling or WebSocket per tab | Push latency at one connection per browser |
| Search | Debounce + abort + URL state | Timestamp comparison | Out-of-order results become impossible |

"With more time I'd add an offline read cache for the last few feed pages in a service worker, a richer composer with mentions, and real-user monitoring of INP per route, alerting on the optimistic-rollback rate — it rises before the backend's error alarms do."

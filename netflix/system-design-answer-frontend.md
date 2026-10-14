# 🎬 Netflix — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The Netflix frontend is two very different apps sharing a shell. One is a browse UI — forty rows of artwork that must scroll smoothly on a cheap smart TV and a phone. The other is a video player that has to show the first frame within two seconds, pick a quality for every four-second segment, and never lose your place, even when you close the tab. I'll spend most of my time on the player, because that's where the hard client problems are."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, devices, performance and accessibility targets |
| A — Architecture | 8 min | Component tree, who owns which state, the data layer |
| D — Data model | 5 min | Client entities, cache keys, profile scoping |
| I — Interface | 5 min | The API as the player sees it; component contracts |
| O — Optimizations & deep dives | 18 min | Fast start + ABR, never losing your place, 60 fps browse, safety |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm devices first, because a TV with a remote and 1 GB of RAM sets a very different budget from a laptop."

### Functional requirements

1. **Profile gate**: "Who's watching?" — every screen after it is scoped to one profile; kids profiles get a kids UI.
2. **Browse**: a hero and about 40 horizontal rows (Continue Watching, My List, genres, "Because you watched…"), with hover or focus previews.
3. **Title page**: synopsis, seasons and episodes with per-episode progress, My List toggle, Play/Resume.
4. **Search** as you type.
5. **Player**: play, pause, seek with thumbnails, quality and audio/subtitle menus, next episode, resume from the saved position on any device.

Out of scope: account and billing pages, offline downloads, the TV-specific spatial-navigation framework (I'll mention focus handling, not design the library).

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Time to first frame | p95 < 2 s after pressing Play | The metric that best predicts abandonment |
| Rebuffering | < 0.5% of viewing time | Stalls are what members remember |
| Browse LCP | < 2.5 s on a mid-range TV or Android phone | The hero artwork is the LCP element |
| Scrolling | 60 fps vertically and within rows | Jank on a TV feels broken |
| INP | < 200 ms, including remote key presses | Remote input queues up when the main thread is busy |
| Accessibility | WCAG 2.2 AA; captions on every title; full keyboard/remote control; reduced motion respected | Players are among the most-used accessibility surfaces on the web |
| Safety | A kids profile never receives a restricted title | Enforced by the server; the client must not cache across profiles |

---

## 🏗️ A — Architecture (8 min)

"This is an authenticated, personalized app — nothing to rank in search engines and every page differs per profile — so I'd build a client-rendered SPA with route-level code splitting. The player is the largest chunk and loads only on the watch route; on browse I preload it when a title card gets focus."

```
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ App shell · TanStack Router · session store (Zustand): account, profile, maturity              │
 │ URL state: /browse   /title/$id   /search?q=   /watch/$id?episode=&t=                          │
 └──────────┬────────────────────────────────┬────────────────────────────────┬───────────────────┘
            │ /browse                        │ /title, /search                │ /watch
            ▼                                ▼                                ▼
 ┌────────────────────────────┐   ┌────────────────────────────┐   ┌──────────────────────────────┐
 │ Browse page                │   │ Title + Search pages       │   │ Watch page · player          │
 │ hero · virtualized rows    │   │ episodes · My List toggle  │   │ MSE engine + ABR picker      │
 │ card hover preview         │   │ debounced search           │   │ EME (DRM) · captions         │
 └──────┬─────────────────────┘   └──────────┬─────────────────┘   └─────┬──────────────┬─────────┘
        │ (1) rows query                     │ (2) My List mutation      │ (3) play     │ segments
        │                                    │                           │              │
        ▼                                    ▼                           ▼              │
 ┌──────────────────────────────────────────────────────────┐   ┌────────────────────┐  │
 │ TanStack Query · server state                            │   │ Player store       │  │
 │ ['home', profileId] · ['title', id] · ['search', q]      │   │ session · position │  │
 │ optimistic My List · cleared on profile switch           │   │ lease state        │  │
 └────────────────────────────┬─────────────────────────────┘   └─────────┬──────────┘  │
                              │ GET /homepage · POST /my-list             │ POST /playback
                              ▼                                           ▼             ▼
 ┌──────────────────────────────────────────────────────────────────────────┐  ┌──────────────────┐
 │ API client · fetch + AbortSignal · keepalive exit saves · typed errors   │  │ Open Connect CDN │
 └────────────────────────────────────┬─────────────────────────────────────┘  │ signed URLs      │
                                      │ HTTPS · session cookie                 └──────────────────┘
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Netflix API · gateway → Homepage API, Playback API                       │
 └──────────────────────────────────────────────────────────────────────────┘
```

1. **Browse (1).** The browse page reads `['home', profileId]` from the query cache; rows are virtualized vertically and each row virtualizes its cards horizontally. Focusing a card prefetches the title's details.
2. **My List (2).** The title page toggles My List optimistically through a query-cache mutation, rolling back on failure.
3. **Play (3).** The watch page asks the player store to start a playback session; the API returns a manifest of signed segment URLs and the resume point, and the player streams segments directly from Open Connect through Media Source Extensions.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Rows, titles, search results, My List | TanStack Query, keys include `profileId` | Caching, dedupe, retries, cancellation and invalidation without hand-written loading flags |
| Selected profile, maturity, avatar | Session store (Zustand), filled from `/me` | Every route guard needs it; tiny |
| Title, episode, resume time, search text | URL (`/watch/$id?episode=&t=`, `/search?q=`) | Deep links, refresh and back/forward just work |
| Playback session, position, buffer, rung, lease | Player store (Zustand) | Changes four times a second; components subscribe to the slice they draw |
| Menus, hover state, toasts | Component state | Never shared |

"Two rules. Server data never lives in Zustand — once you copy it there you own its staleness and invalidation by hand. And the player store is separate from everything else, because `currentTime` updates four times a second and must not re-render the page around the player."

### Key interaction: pressing Play

```
User                    WatchPage          Player store                 Playback API    CDN
  │                         │                    │                            │          │
  │ 1 open /watch/$titleId  │                    │                            │          │
  │────────────────────────▶│                    │                            │          │
  │                         │ 2 startSession()   │                            │          │
  │                         │───────────────────▶│                            │          │
  │                         │                    │ 3 POST /playback           │          │
  │                         │                    │───────────────────────────▶│          │
  │                         │                    │ 4 manifest, sid, resumeAt  │          │
  │                         │                    │◀───────────────────────────│          │
  │                         │ 5 rungs, resumeAt  │                            │          │
  │                         │◀───────────────────│                            │          │
  │                         │ 6 MSE: init + segments                                     │
  │                         │───────────────────────────────────────────────────────────▶│
  │                         │ 7 media, seek to resumeAt                                  │
  │                         │◀───────────────────────────────────────────────────────────│
  │ 8 first frame < 2 s     │                    │                            │          │
  │◀────────────────────────│                    │                            │          │
  │                         │                    │                            │          │
```

"Step 3 can also answer `403` (not available on this profile) or `409` (too many screens in use); both render a full-screen message with a single 'Back' action, never a broken player. Step 6 starts at a modest rendition so the first segment is small; ABR climbs from there."

### Key interaction: reporting progress and leaving

```
 Video element           Player store                    Playback API
       │                       │                               │
       │ 1 pause or 10 s tick  │                               │
       │──────────────────────▶│                               │
       │                       │ 2 progress {pos, ts, sid}     │
       │                       │──────────────────────────────▶│
       │                       │ 3 {applied, lease}            │
       │                       │◀──────────────────────────────│
       │ 4 lease lost: pause   │                               │
       │◀──────────────────────│                               │
       ············ user leaves or closes the tab ··············
       │                       │ 5 final progress (keepalive)  │
       │                       │──────────────────────────────▶│
       │                       │ 6 DELETE session              │
       │                       │──────────────────────────────▶│
       │                       │                               │
```

"The store reports on a 10-second tick while playing and on every pause. If the response says the lease is gone — another device took the account's last screen — the player pauses and explains. Leaving the page, in-app or by closing the tab, flushes a final position and ends the session with `keepalive` requests, which the browser completes after the page is gone."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `Profile` | `id`, `name`, `avatar`, `isKids`, `maturityLevel` | Session store | Refreshed on `/me` and on profile switch |
| `HomeRow` | `id`, `title`, `kind`, `items: TitleSummary[]`, `cursor` | `['home', profileId]` | `staleTime` 5 min; invalidated by My List and finished episodes |
| `TitleSummary` | `id`, `name`, `artwork{small, large}`, `maturityRating`, `progress?` | Inside rows | As the row |
| `TitleDetail` | summary + `synopsis`, `seasons[{number, episodes[{id, number, name, durationS, progress}]}]` | `['title', profileId, id]` | `staleTime` 10 min; prefetched on focus |
| `PlaybackSession` | `sid`, `durationS`, `renditions[{quality, bitrate, width, height, url}]`, `resumeAtS`, `lease{ttlS, heartbeatS}` | Player store | One per watch-page visit |
| `ProgressReport` | `positionS`, `durationS`, `ts`, `sid` | Not cached | Fire and forget, retried |

Three modeling decisions:

- **Profile in every key.** Even if an old response arrives after a profile switch, it lands under the previous profile's key and is never rendered. Switching also clears the cache outright.
- **No normalized entity store.** A title appears in several rows and on its detail page; after a My List toggle I update the affected cached rows with `setQueryData` and then invalidate. A normalized store would avoid the double write, but rows are rebuilt by the server anyway.
- **Progress on cards is approximate.** The progress bar on a row card comes from the homepage response (minutes old); the authoritative resume point comes from the playback session.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET    /api/v1/homepage                  → rows for the session's profile
GET    /api/v1/titles/{id}               → TitleDetail | 403 not available on this profile
GET    /api/v1/search?q=&cursor=         → {items, next_cursor}
PUT    /api/v1/my-list/{titleId}         → 204 (idempotent; DELETE removes)
POST   /api/v1/playback                  {titleId, episodeId?} + Idempotency-Key → 201 | 403 | 409
POST   /api/v1/playback/{sid}/progress   {positionS, durationS, ts} → {applied, lease}
DELETE /api/v1/playback/{sid}            → 204 (keepalive on exit)
GET    {segment url}                     → bytes from Open Connect (token in the URL)
```

- **`ts` is the client's clock when the position was read.** The server keeps the newest one, so the client can retry and flush without coordinating; `applied: false` means "already have something newer" and is not an error.
- **The manifest is already capped by plan.** The quality menu renders exactly what the manifest lists; the client never encodes plan rules.
- **Errors are `application/problem+json`** with a `code` (`maturity_restricted`, `stream_limit`), which maps to a specific screen rather than a generic toast.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<Row items onFocusItem onActivate>` | Horizontally virtualized; arrow keys move focus; announces "row 3 of 40, item 2 of 75" |
| `<TitleCard title progress? onFocus>` | Fixed aspect ratio, `srcset` artwork, focus ring; preview after 600 ms of focus |
| `useStartPlayback(titleId, episodeId)` | Creates the session once per visit (idempotency key per click); exposes `status: starting / playing / blocked` |
| `<Player session onExit>` | Owns the media element, MSE pipeline and ABR loop; never sees plan or maturity rules |
| `usePlaybackReporter()` | 10 s tick while playing, on pause, and a `keepalive` flush plus session end on exit |

---

## 🔧 O — Optimizations & Deep Dives (18 min)

### Deep dive 1: first frame in under two seconds, then the right quality (7 min)

"Two seconds is tight once you add a session call, a license request and the first segment. So I overlap everything that doesn't depend on something else."

**Before Play.** When a title card or Play button gets focus, I prefetch the title details, warm a connection to the CDN host (`preconnect`), and load the player chunk. On the title page, the most likely next action is Play, so I can create the session speculatively when the button is focused and release it if the member navigates away — it's cheap, and it removes a round trip from the critical path.

**On Play.** The session response contains the resume point and the renditions. The player initializes MSE, requests the DRM license through EME in parallel with the first segment, and starts at a modest rendition (480p or 720p) chosen from the last session's measured throughput. It seeks to the resume point *before* appending the first media segment, so it never downloads the opening scene it's about to skip.

**ABR loop.** For every 4-second segment the player picks a rendition:

1. Estimate throughput from recent segment downloads with an exponentially weighted moving average; ignore tiny segments that measure latency rather than bandwidth.
2. Pick the highest rendition whose bitrate fits under the estimate with a margin.
3. If the buffer drops below 10 seconds, drop quality aggressively — a stall costs more than a soft minute.
4. If the buffer is above 30 seconds, step up one rung at a time and only after sustained headroom, so quality doesn't oscillate.
5. Cap at the viewport size: a 4K rendition in a 720-pixel-tall window is wasted bandwidth.

| Approach | Verdict |
|----------|---------|
| ✅ MSE player with hybrid throughput + buffer ABR | Quality changes at segment boundaries; stalls are rare |
| ❌ Progressive download of one MP4 per quality | No switching mid-stream; a quality change restarts the download |
| ❌ Pure throughput-based ABR | Oscillates on bursty networks |
| ❌ Pure buffer-based ABR | Slow to ramp up at start |

"What I give up is a startup that is a little softer than it could be — I start mid-ladder and climb, rather than gambling on 4K for the first segment."

### Deep dive 2: never losing your place (5 min)

"There are three ways a resume point goes wrong on the client: it's never sent, it's sent out of order, or the last minutes vanish when the tab closes."

**Send it on a steady cadence.** The reporter is a 10-second interval that runs only while playing. One subtle bug to avoid: if the interval's effect depends on `currentTime`, React restarts it on every `timeupdate` — four times a second — and it never fires. The reporter reads the latest position from the store when it fires instead. It also reports on pause, which is when people usually walk away.

**Stamp it.** Each report carries `ts`, the client clock when the position was read. The server keeps the newest `ts`, so a retry (same `ts`) or a report delayed behind a newer one changes nothing. That's what lets the reporter retry with backoff without any coordination, and it's what makes two devices converge on the right position.

**Flush on exit.** In-app navigation and tab close both send a final report and end the session with `fetch(…, {keepalive: true})` from a snapshot taken before the player store resets — store cleanup order between a page and its player is not something to rely on. I listen to `pagehide` rather than `beforeunload`, which mobile browsers often skip. The final report omits the session id, so it can't renew the screen lease that the following `DELETE` releases.

**Lease lost.** If a heartbeat answers `lease.active: false` — another device took the account's last screen while this one was paused — the player pauses and shows "This account is being used on another device", rather than playing on and getting cut off by the license.

| Approach | Verdict |
|----------|---------|
| ✅ Interval while playing + pause + `keepalive` exit flush, all stamped with `ts` | Survives retries, crashes and closed tabs |
| ❌ Save only on unmount | A crash, dead battery or killed tab loses the session |
| ❌ `navigator.sendBeacon` only | Can't send the cookie-authenticated JSON request or read a response; fine as a fallback |
| ❌ Save every `timeupdate` | Four writes a second per viewer for no extra accuracy |

### Deep dive 3: 60 fps browse on a TV (4 min)

- **Virtualize in two dimensions.** Forty rows of up to 75 cards is 3,000 artwork elements. Rows are virtualized vertically and each row horizontally (`@tanstack/react-virtual`), so the DOM holds only the visible cards plus a small overscan — critical on a TV with 1 GB of RAM.
- **Artwork budget.** Cards use `srcset` with three widths, AVIF or WebP, explicit dimensions to prevent layout shift, `loading="lazy"` beyond the first two rows, and `fetchpriority="high"` on the hero image, which is the LCP element. Artwork ids come from the homepage response, so per-member artwork experiments need no client logic.
- **Focus, not hover.** On TVs, focus is the cursor. The row keeps a roving `tabindex`, scrolls the focused card into view with a transform rather than `scrollLeft` (cheaper to composite), and starts the preview video only after 600 ms of stable focus, so fast scrolling doesn't download clips.
- **Keep the main thread free.** Previews are muted, small, and torn down when focus moves; analytics batch in `requestIdleCallback`.

### Deep dive 4: safety and accessibility checklist (2 min)

- **Maturity is the server's job.** The client never filters titles by maturity; it only renders what the profile's responses contain, and it clears every cache on profile switch. Client-side filtering would mean the restricted titles were already downloaded.
- **DRM through EME.** Keys stay inside the browser's content decryption module; JavaScript never sees them.
- **Captions and audio** are first-class menu items, remember the profile's last choice, and render with user-adjustable size and contrast.
- **Keyboard and remote.** Space or Enter toggles play, arrows seek ±10 s, M mutes, F toggles fullscreen; controls auto-hide but reappear on any input and never hide while focused. Seek and volume sliders expose `aria-valuetext` ("41 minutes 20 seconds of 1 hour 52").
- **Reduced motion** disables autoplaying previews and hero video.

---

## 🧯 Loading, Error and Empty States (2 min)

"Most of what members feel is how the app behaves when something isn't perfect."

| Situation | What the member sees | How |
|-----------|----------------------|-----|
| First homepage load | Hero and row skeletons at real sizes | Skeletons reserve layout, so nothing shifts when artwork arrives |
| Homepage served from fallback rows | A normal-looking homepage | The server returns popular-in-region rows; the client renders them like any other |
| `403` on Play | "This title isn't available on this profile" with Back | `code: maturity_restricted` maps to this screen |
| `409` on Play | "Your plan allows 2 screens at a time" with Back | Shows the limit from the response |
| Network drop while playing | Playback continues from the buffer, then a spinner over the last frame | The player retries segments on the next appliance; reports queue and retry with their original `ts` |
| Lease lost | Paused with "being used on another device" | From `lease.active: false` on a heartbeat |
| No Continue Watching yet | The row is simply absent | An empty row is noise |
| Search with no results | "No results for 'xyz'" plus suggested genres | Never an empty grid |
| My List toggle fails | The button flips back and a toast says why | Optimistic update rolled back |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA with code-split player | SSR | Personalized, authenticated, no SEO |
| Server state | TanStack Query, keys include profile | Copy into a global store | Caching and invalidation without bespoke code; clean profile switches |
| Player state | Separate store, sliced subscriptions | Context or component state | Four updates a second must not re-render the page |
| Playback | MSE + hybrid ABR, start mid-ladder | Progressive MP4 | Per-segment quality switching |
| Progress | 10 s reports + pause + `keepalive` exit, stamped with `ts` | Save on exit only | Survives crashes and closed tabs; retries are safe |
| Browse | Two-dimensional virtualization, focus-driven previews | Render every row | 3,000 cards on a 1 GB TV |
| Safety | Server-side maturity; caches cleared per profile | Client-side filtering | Restricted data never reaches the device |

"With more time I'd add trick-play thumbnails decoded in a worker for seeking, persist the query cache to IndexedDB so the homepage paints instantly on return visits, and report time to first frame and rebuffering per device as real-user metrics."

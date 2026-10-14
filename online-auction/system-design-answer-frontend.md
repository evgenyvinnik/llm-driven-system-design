# 🔨 Online Auction (eBay-style) — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The item page of an auction is a small UI with three ways to lie to the user. The price changes under their cursor, so it must never jump backwards or show a stale number as current. The countdown can be moved by the server in the last seconds, so the timer must follow the server, not the device. And the Bid button spends real money, so a double tap or a retry on a bad connection must never bid twice — and the page must never say 'you're winning' before the server agrees. My design is about keeping the page honest under those three pressures."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, performance and accessibility targets |
| A — Architecture | 8 min | Rendering choice, component tree, who owns which state |
| D — Data model | 5 min | Client entities, the version number, cache keys |
| I — Interface | 5 min | The API and events as the client sees them; component contracts |
| O — Optimizations & deep dives | 20 min | Live price, the moving countdown, a safe Bid button, performance |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses this and on what devices, because auctions end wherever the bidder happens to be — often on a phone, on a train."

### Functional requirements

1. **Browse and search** live auctions with filters (status, ending soon, price) and a countdown on every card.
2. **Item page:** images, description, current price, leader, bid history, minimum next bid, countdown, snipe-protection notice — all updating live.
3. **Bid:** place a manual bid, or set a proxy maximum ("bid for me up to $X"); see immediately whether I'm leading or was outbid by someone's proxy.
4. **Watchlist, my bids, my listings, notifications** (outbid, won, sold, reserve not met).
5. **Create a listing** with image upload; **admin** console to force-close or cancel.

Out of scope: checkout and payment, messaging between buyers and sellers, seller analytics.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP | < 2.0 s on a mid-range Android over 4G for item and browse pages | Item pages arrive from search engines and shared links |
| INP | < 200 ms while prices and timers tick | Typing a bid must never stutter in the last seconds |
| Live freshness | New price on screen < 1 s after the server accepts it | Bidders react to each other |
| Countdown accuracy | Within ±500 ms of the server's clock | A device clock that's 30 s off would make someone miss the end |
| Correctness | One tap = at most one bid; "You're winning" only from the server | Real money, legally binding |
| Accessibility | WCAG 2.2 AA; price changes announced without flooding screen readers | A ticking page is noisy by default |
| JavaScript | < 180 KB gzipped on the item page; create-listing and admin lazy-loaded | Most sessions are browse + bid |

---

## 🏗️ A — Architecture (8 min)

"First, the rendering decision. Item and browse pages are public and arrive from search engines and shared links, so I server-render them. The HTML carries the item, the current price and its version, which gives a fast LCP and real SEO. Then the page hydrates and subscribes to live updates from exactly that version. The account area — my bids, watchlist, notifications, admin — is behind login and has no SEO value, so it's plain client-side navigation inside the same app. The cost of SSR is a rendering tier to run; for a marketplace where search traffic is the business, that's worth it."

```
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ App shell · TanStack Router · item and browse pages server-rendered, then SPA                │
 │ URL state: /?search=&status=&sort=&page=  ·  /auction/$auctionId  ·  session: Zustand        │
 └─────────┬─────────────────────────┬────────────────────────────┬─────────────────────────────┘
           │                         │                            │
           ▼                         ▼                            ▼
 ┌───────────────────┐  ┌─────────────────────────┐  ┌──────────────────────────────────────────┐
 │ / browse          │  │ /my-auctions /watchlist │  │ /auction/$auctionId                      │
 │ AuctionCard grid  │  │ /notifications /admin   │  │ PricePanel · Countdown · snipe notice    │
 │ CountdownTimer    │  │ lists, mark-read        │  │ BidForm · BidHistory (leader first)      │
 └─────────┬─────────┘  └────────────┬────────────┘  └────┬─────────────────────────────────────┘
           │ (3) list                │                    │ (1) bid                 ▲
           │                         │                    │                         │ (2) new_bid
           ▼                         ▼                    ▼                         │
 ┌─────────────────────────────────────────────────────────────┐  ┌─────────────────────────────┐
 │ Server-state cache · TanStack Query                         │  │ Realtime store · Zustand    │
 │ ['auctions', filters] · ['auction', id] · ['notifications'] │  │ one socket, subscriptions,  │
 │ placeBid / setAutoBid mutations, one key per draft          │  │ version gate, resync        │
 └────────────────────────────┬────────────────────────────────┘  └─────────────────────────────┘
                              │                                                  ▲
                              ▼                                                  │
 ┌─────────────────────────────────────────────────────────────┐                 │ WebSocket /ws
 │ API client · fetch + AbortSignal                            │                 │
 │ Idempotency-Key header · {error} → message · 401 → login    │                 │
 └────────────────────────────┬────────────────────────────────┘                 │
                              │ HTTPS, session                                   │
                              ▼                                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Backend · Auction API /api/* · Realtime gateway /ws                                          │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Bid (1).** `BidForm` freezes the draft, generates an idempotency key, and runs a mutation through the query cache. The API client sends the key as a header. The server's answer (price, leading or not, version) updates the cached auction only if it's newer than what's there.
2. **Live update (2).** The realtime store owns one WebSocket for the whole app. It delivers `new_bid` events to the item page, which applies them by version: next version applied, older ignored, a gap triggers one refetch.
3. **Browse (3).** The browse page reads `['auctions', filters]` with the filters in the URL, so back/forward and shared links restore the same view.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Auction snapshots, bid history, lists, notifications | TanStack Query cache | Caching, dedupe, retries, cancellation and invalidation without hand-written loading flags |
| Live connection, subscriptions, listeners | Realtime store (Zustand) | One socket per tab, shared by every component; survives navigation |
| Filters, sort, page, selected auction | URL | Shareable, bookmarkable, back button works |
| Session (user, role) | Zustand, filled from `/me` | Every route guard needs it; tiny |
| Bid draft + idempotency key | `BidForm` state, mirrored to `sessionStorage` | Survives a refresh while a bid is pending |
| Dialogs, toasts, the open image | Local component state | Never shared |

"The rule: server data never gets copied into a client store by hand. The moment I copy an auction into Zustand, I own its staleness and its races with the WebSocket. The query cache owns server state; events are applied to it, never next to it."

### Key interaction: placing a bid

```
Bidder                BidForm            Query cache                       Auction API
   │                     │                    │                                 │
   │ 1 Bid $1,735        │                    │                                 │
   │────────────────────▶│                    │                                 │
   │                     │ 2 freeze draft, key K                                │
   │                     │ 3 mutate(1735, K)  │                                 │
   │                     │───────────────────▶│                                 │
   │                     │                    │ 4 POST /bids/{id}, key K        │
   │                     │                    │────────────────────────────────▶│
   │                     │                    │ 5 201 {1760, winning: no, v43}  │
   │                     │                    │◀────────────────────────────────│
   │                     │                    │ 6 apply only if v43 > cached    │
   │                     │ 7 settled          │                                 │
   │                     │◀───────────────────│                                 │
   │ 8 "Outbid: $1,760"  │                    │                                 │
   │◀────────────────────│                    │                                 │
   │                     │                    │                                 │
```

"Bidding is deliberately **not optimistic**. Whether my bid leads depends on proxies I can't see — someone's hidden maximum might beat me instantly — so only the server can say 'you're winning'. The button shows a pending state for the ~150 ms it takes. Step 6 is the important line: the response carries the auction's new version, and I only apply it if it's newer than what the cache already has. A WebSocket event for a later bid may well have arrived first."

### Key interaction: a live update, and a missed one

```
 Gateway                       WS store         Auction page                      API
    │                              │                  │                            │
    │ 1 new_bid v42 {price, bids}  │                  │                            │
    │─────────────────────────────▶│                  │                            │
    │                              │ 2 listener(msg)  │                            │
    │                              │─────────────────▶│                            │
    │                              │                  │ 3 42 = 41 + 1: apply       │
    │ 4 new_bid v45                │                  │                            │
    │─────────────────────────────▶│                  │                            │
    │                              │ 5 listener(msg)  │                            │
    │                              │─────────────────▶│                            │
    │                              │                  │ 6 gap: GET /auctions/{id}  │
    │                              │                  │───────────────────────────▶│
    │                              │                  │ 7 snapshot v45             │
    │                              │                  │◀───────────────────────────│
    │                    8 keep if version ≥ current  │                            │
    │                              │                  │                            │
```

"The item page applies event 42 because it holds 41. When it sees 45, it knows it missed 43 and 44 — maybe the phone switched networks — so it refetches once. The refetched snapshot replaces the current one only if its version is at least the current one, so a slow response can't roll the price back."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key / home | Freshness |
|--------|-------|------------------|-----------|
| `AuctionSnapshot` | `id`, `title`, `images`, `currentPrice` (decimal string), `increment`, `endTime`, `status`, `version`, `leaderId`, `reserveMet` | `['auction', id]` | Pushed by events; refetched on gap, reconnect, or `auction_ended` |
| `Bid` | `id`, `bidderName`, `amount`, `isAuto`, `seq` | Inside the snapshot, leader first | Merged from events by `id` |
| `ProxyMax` | `maxAmount`, `active` | `['auction', id]` for the signed-in user | Changes only through my own mutations |
| `AuctionCard` | `id`, `title`, `thumb`, `currentPrice`, `endTime`, `bidCount` | `['auctions', filters]` pages | `staleTime` 30 s; no live push on the grid |
| `BidDraft` | `amount`, `kind`, `key`, `status` | `BidForm` + `sessionStorage` | Cleared on success |
| `Notification` | `id`, `type`, `message`, `read` | `['notifications']` | Refetched on focus and on `outbid` events for me |

Four modeling decisions:

- **`version` is the merge rule.** It increases by one on every price change, close and cancel. Every write into `['auction', id]` — from an event, a mutation response or a refetch — goes through one function that compares versions. That's the whole consistency story on the client.
- **Money stays a decimal string.** I format it with `Intl.NumberFormat` and never do float arithmetic. The minimum next bid comes from the server (`minimum_bid`), not from `price + increment` computed in JavaScript, because `0.1 + 0.2` is not `0.3`.
- **Bid history is leader-first** (highest amount, earliest first), the same order the server uses to pick the winner. The top row is always the leader, even when two bids tie at a proxy's maximum.
- **Server time is part of the model.** I keep a `serverOffset` (server time minus device time) updated from responses, and every countdown uses `now + serverOffset`.

---

## 🔌 I — Interface (5 min)

### The API and events as the client sees them

```
GET    /api/v1/auctions?q&status&sort&cursor    → {items, next_cursor}
GET    /api/v1/auctions/{id}                    → {auction (with version), bids (leader first), my_proxy}
POST   /api/v1/auctions/{id}/bids               {amount} + Idempotency-Key → 201 {current_price, is_winning, version, end_time}
PUT    /api/v1/auctions/{id}/proxy              {max_amount} + Idempotency-Key → 200 {...same}
DELETE /api/v1/auctions/{id}/proxy              withdraw my maximum
WS     /ws   → subscribe {auction_id}  ← new_bid {version, current_price, leader_id, end_time, bids}
                                       ← auction_ended {version, outcome, winner_id, final_price}
```

- **Errors carry machine-readable reasons.** `400` with `minimum_bid` (show it next to the input). `409 already_leading` (offer "raise your maximum"). `422` (the same key was reused for a different amount — a bug on my side). `429` with `Retry-After` (count down on the button).
- **Every bid response is a full decision** — price, leading or not, version, end time — so the form can tell the bidder what happened without waiting for the WebSocket.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `useAuction(id)` | Query for the snapshot; exposes `applyEvent(e)` that enforces the version rule |
| `useAuctionEvents(id)` | Subscribes once per mount through the realtime store; refetches on gap, reconnect or `auction_ended` |
| `<PricePanel auction>` | Price, leader badge ("You're winning" only from server data), minimum next bid, reserve met / not met |
| `<Countdown endTime serverOffset onZero>` | One shared ticker; urgent styling under 5 min; "Extended +2:00" when `endTime` moves |
| `<BidForm auction onResult>` | Owns draft → freeze → submit → retry with the same key; manual and proxy modes |
| `<BidHistory bids currentUserId>` | Leader-first list; my bids highlighted; auto-bids badged |

---

## 🔧 O — Optimizations & Deep Dives (20 min)

### Deep dive 1: a live price that never lies (7 min)

"The naive version is what this kind of page usually ships with: on every `new_bid` event, patch the price into state and refetch the whole auction. It has three bugs. Every watcher refetches on every bid, so a hot item's last ten seconds turn into 10,000 watchers × 50 bids of extra API load — at the worst moment. A refetch that started earlier can finish later and roll the price back. And an event missed during a network blip is never noticed."

**The approach.**

1. **Apply events directly.** Each `new_bid` carries the new price, version, end time, leader and the bid rows it created. If its version is exactly one more than mine, I merge it into the cached snapshot. Merging bids is by `id`, re-sorted leader-first. No network request.
2. **Ignore what I already have.** A version at or below mine is a duplicate or a late delivery; I drop it.
3. **Refetch only on a gap.** A version more than one ahead means I missed something, so I refetch once. That's rare: a reconnect, a backgrounded tab.
4. **Resync on reconnect.** The realtime store resubscribes after reconnecting with backoff. The server acknowledges each subscription, and a re-subscription triggers one refetch, because anything could have happened while the socket was down.
5. **Snapshots never go backwards.** A refetched snapshot replaces the cache only if its version is at least the cached one.
6. **One stable subscription.** The event handler must not depend on the data it updates. Otherwise every bid tears down and re-creates the subscription, which opens a window where events are lost.

| Approach | Verdict |
|----------|---------|
| ✅ Versioned events applied in place, refetch on gaps | Constant load per bid, can't go backwards, notices missed events |
| ❌ Refetch on every event | Thundering herd at the busiest moment; races can roll the price back |
| ❌ Poll every second | 200K tabs × 1 request/s, and still up to a second stale |
| ❌ Optimistic "You're winning" on submit | A hidden proxy may outbid me instantly; the UI would lie, then flip |

"What I give up: the server has to include a version and the created rows in every event, which ties the client to that contract. It's one integer and a small array. In exchange, a bid on a hot item costs the backend one push per watcher, not one request per watcher."

### Deep dive 2: the countdown and the moving deadline (6 min)

"The countdown is the most-watched element on the page, and it's the one that can most easily disagree with the server."

- **Server time, not device time.** Device clocks are often off by seconds, sometimes by minutes. I compute `serverOffset` from the server's timestamps and render `endTime − (now + serverOffset)`. If the offset is unknown, I show minutes only, never false-precision seconds.
- **The deadline moves.** A bid in the last two minutes extends the auction, and every `new_bid` carries the new `endTime`. When it moves, the timer jumps forward with a short "Extended +2:00" highlight, so watchers understand why the clock went up.
- **Zero is not "ended".** At 0:00 I show "Closing…" with a spinner and disable the form, but I don't declare a winner. The server decides — a bid may have landed in the final second — and `auction_ended` (or a refetch if it hasn't arrived within a few seconds) switches the page to "You won" or "Sold for $X".
- **One ticker, aligned to second boundaries.** Every countdown on the page (item page, cards, watchlist) subscribes to one shared 1 s ticker started at the next whole second, so digits change together and I don't run a hundred intervals. Hidden tabs pause it; on `visibilitychange` I recompute immediately rather than trusting throttled timers.
- **Accessible, not noisy.** The visual timer is `aria-hidden`. A separate polite live region announces once per minute, then at 30 s and 10 s, and on extensions. Price changes are announced politely and coalesced, so ten bids in five seconds become one announcement.

"The trade-off: the client never knows the result first. Bidders sometimes see 'Closing…' for a second or two. I'd rather show that than briefly announce the wrong winner."

### Deep dive 3: a Bid button that can't double-bid (5 min)

"The failure I design for: the user taps Bid on a train, the request times out, they tap again. Two bids at different prices, or a bid they think failed but didn't."

**Freeze, key, retry with the same key.** On submit, `BidForm` freezes the draft — amount and kind — and generates an idempotency key with `crypto.randomUUID()`, kept with the draft in `sessionStorage`. Every retry of that draft resends the same key: the Retry button, an automatic retry on a network error, or a page reload that finds a pending draft. The server replays the original answer instead of bidding again. Changing the amount is a new draft with a new key. The server rejects a reused key with a different amount (`422`), which catches my own bugs.

**Let the server set the minimum.** The input shows `minimum_bid` from the last snapshot or error response. If someone outbids me while I'm typing, the `400` carries the new minimum and the form updates in place, focus kept, error tied to the input with `aria-describedby`.

**Guard against fat fingers.** A bid more than 3× the current price (or above a set ceiling) gets a confirmation dialog with focus trapped and Escape to cancel. That's the most common real-world bidding mistake.

**Say what happened.** Success and failure messages go to `role="status"` and `role="alert"` regions. "You're the highest bidder at $1,825", "Outbid by an automatic bid — now $1,760", "You're already winning — raise your maximum instead" each match a server outcome, never a guess.

| Approach | Verdict |
|----------|---------|
| ✅ Frozen draft + key per draft + server-decided result | Correct across double taps, timeouts and refreshes |
| ❌ Disable the button while pending | Stops double clicks, not a retry after a timeout or a reload |
| ❌ Client computes the minimum | Floating-point drift and stale prices produce bids the server rejects |

### Deep dive 4: performance checklist (2 min)

- **Browse grid:** server-rendered first page, cursor-paged infinite scroll, virtualized with `@tanstack/react-virtual` past ~100 cards, `srcset` thumbnails with lazy loading and fixed aspect ratios (no layout shift). Cards don't subscribe to live updates; they refresh every 30 s while visible.
- **Item page:** the hero image is preloaded; the gallery and zoom are lazy. Create-listing (image tooling) and admin are separate chunks.
- **Ticking without jank:** price and countdown updates touch two text nodes. They're memoized so a tick never re-renders the gallery or the history.
- **Real-user monitoring:** LCP and INP per route, plus "event-to-paint" time for `new_bid`, which measures the live-update promise directly.

---

## 🧯 Loading, Error and Empty States (2 min)

"Auctions are emotional at the end, so the unhappy paths need as much design as the happy one."

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| First load of an item | Server-rendered page, live within a second | SSR snapshot with version, then hydrate and subscribe |
| Socket reconnecting | "Reconnecting… prices may be behind" badge; Bid still enabled | Bids are plain HTTPS; the badge clears after the resync refetch |
| Bid pending > 3 s | "Still sending… don't worry, retrying won't bid twice" | Same idempotency key on every retry |
| Outbid while typing | Inline "Minimum is now $1,785", value kept | `400` with `minimum_bid` |
| Already leading | "You're winning. Raise your maximum instead?" with a link to the proxy form | `409 already_leading` |
| Rate limited | Button counts down "Try again in 8 s" | `Retry-After` header |
| Countdown hits zero | "Closing…" then the result | Wait for `auction_ended`; refetch after a short timeout |
| No bids yet | "Be the first to bid — starts at $50.00" | Empty history as an invitation |
| Ended, reserve not met | "Ended — reserve not met" (no price shame for the seller) | `outcome` from the event or snapshot |
| No search results | Suggestions to widen filters, plus "ending soon" picks | Empty state as navigation |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SSR item and browse pages, SPA after hydration | Pure SPA | Search traffic and shared links need fast, indexable item pages |
| Server state | TanStack Query with one version-checked writer | Copy into Zustand | One place decides what's newest |
| Live updates | Versioned events applied in place | Refetch on every event, or polling | Constant load per bid; detects gaps; never goes backwards |
| Placing bids | Pessimistic + idempotency key per draft | Optimistic "You're winning" | Hidden proxies decide the outcome; retries must not double-bid |
| Countdown | Server-offset clock, "Closing…" at zero | Device clock, client-declared end | The server owns the deadline and the winner |
| Grid freshness | 30 s refresh while visible | Live push to every card | Hundreds of subscriptions for numbers nobody is bidding on |

"With more time I'd add push notifications for 'outbid' and 'ending in 5 minutes' on watched items, a service worker that caches the shell and the last snapshot for flaky networks, and per-route Web Vitals plus event-to-paint tracking in production."

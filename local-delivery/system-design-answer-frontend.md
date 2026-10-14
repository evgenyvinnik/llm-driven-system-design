# 🛵 Local Delivery (DoorDash / Instacart) — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "There are three apps here — customer, courier and admin — but two moments carry most of the risk. One is a button: 'Place order' on a train, and 'Accept' in a parking garage, where a retry must never create a second order and a late tap must fail clearly. The other is a screen: the tracking page, which lives on a socket that will drop, and must never show a state older than the one it already showed. I'll design the client around those contracts."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, performance, network and accessibility targets |
| A — Architecture | 8 min | Rendering choice, component layers, who owns which state |
| D — Data model | 5 min | Client entities, cache keys, versions |
| I — Interface | 5 min | The API and socket messages as the client sees them |
| O — Optimizations & deep dives | 20 min | Safe checkout, live tracking on bad networks, the courier's offer |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses each app and on what devices, because the courier app's constraints — a phone in a car mount, intermittent signal, a battery that has to last a shift — are very different from the customer's."

### Functional requirements

1. **Customer**: browse nearby merchants by category, open a menu, build a cart from one merchant, see the server's price (subtotal, delivery fee, tip, total), place the order.
2. **Customer, after ordering**: a tracking screen with the status timeline, the courier's name and live position, and an ETA; cancel while the order is still pending; rate the courier and merchant after delivery.
3. **Courier**: go online and offline, receive an offer with a 30-second countdown, accept or decline, then step through picked up → on the way → delivered. While online, the app shares GPS.
4. **Admin** (role-gated, lazy-loaded): order, courier and merchant tables and platform statistics.

Out of scope: payments UI, chat between courier and customer, the merchant tablet.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP | < 2.5 s on a mid-range Android over 4G | Browsing is often on the way home |
| INP | < 200 ms, including while the map animates | The courier taps Accept under time pressure |
| Live updates | On screen < 1 s after the server publishes | A dot that lags looks broken |
| Reconnect | Resynced within 5 s of the network returning | Tunnels and elevators are normal |
| Correctness | One order per checkout attempt; never show an older status | Double charges and "it said delivered, now it says picked up" destroy trust |
| Courier battery | GPS while online only; one ping per 3 s moving, heartbeat per 10 s parked | A shift is 8 hours |
| Accessibility | WCAG 2.2 AA; status changes and countdowns announced | Tracking is mostly glanceable information |
| JavaScript | < 180 KB gzipped for browse; map, courier and admin code lazy | Most sessions are browse and checkout |

---

## 🏗️ A — Architecture (8 min)

"First the rendering choice. Merchant and menu pages are public, change slowly, and benefit from search engines and a fast first paint, so I'd server-render or pre-render them. Checkout, tracking, the courier app and admin are authenticated and live; they are a client-rendered SPA with one bundle split per role, so a customer never downloads the courier's or admin's code."

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │ TanStack Router · /cart · /orders/$id · /driver · role guards · ids live in the URL      │
  └────────────┬───────────────────────────────┬───────────────────────────────┬─────────────┘
               │                               │                               │
               │                               │                               │
               ▼                               ▼                               ▼
  ┌────────────────────────────┐ ┌────────────────────────────┐ ┌────────────────────────────┐
  │ Checkout page              │ │ Order tracking page        │ │ Courier dashboard          │
  │ cart · quote · place order │ │ timeline · map · ETA       │ │ offer modal · deliveries   │
  └─────┬──────────────────┬───┘ └─────────────┬──────────────┘ └───────┬──────────────┬─────┘
        │                  │                   │                        │              │
        │ cart             │ (1) quote,        │ order                  │ offer,       │
        │                  │ create            │                        │ deliveries   │ online
        ▼                  ▼                   ▼                        │              │
  ┌──────────────────┐    ┌──────────────────────────────────┐          │              │
  │ Zustand store    │    │ TanStack Query cache             │◀─────────┘              │
  │ cart · session   │    │ order, quote, offer, deliveries  │                         │
  └──────────────────┘    └───┬─────────────────────┬────────┘                         │
                              │ fetch, mutate       ▲ (2) status, location             │
                              │                     │ (3) offers                       │
                              ▼                     │                                  ▼
  ┌────────────────────────────────┐  ┌──────────────────────────┐  ┌────────────────────────┐
  │ API client · fetch             │  │ Realtime client · WSS    │  │ Geolocation            │
  │ Idempotency-Key · AbortSignal  │  │ resubscribe · versions   │  │ watch · 10 s heartbeat │
  └───────┬────────────────────────┘  └──────────────────────────┘  └───────────┬────────────┘
          │ HTTPS                                   ▲ WSS                       │ POST /location
          │                                         │                           │
          ▼                                         ▼                           ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │ Backend · /api/v1: orders, quote, offers, location · /ws: snapshots and events           │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Checkout (1).** The checkout page reads the cart from the client store, asks the server for a quote, and creates the order through a query-cache mutation. The API client attaches the attempt's idempotency key and cancels superseded quotes.
2. **Live tracking (2).** The tracking page renders the cached order. The realtime client subscribes over WebSocket and writes each status or location event into the same cache, keeping only events newer than what is already there.
3. **Courier offers (3).** Offers arrive on the courier's socket and land in the cache under `['offer', 'pending']`; the dashboard renders the modal from there. Going online also starts the geolocation watcher, which posts positions to the backend.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Server data: order, quote, offer, deliveries, merchants | TanStack Query cache | Dedupe, retries, cancellation and invalidation without hand-written loading flags |
| Realtime events | Written into the query cache by the realtime client | One source for the screen; events and refetches go through the same version check |
| Cart, session | Zustand; the cart persisted to `localStorage` | Survives a reload; needed by every page |
| Order id, merchant id, category filter | URL (router) | Shareable and restorable; the tracking link works from a push notification |
| Modal open, countdown tick, form drafts | Component state | Never shared |

"The rule I'm applying: server data never lives in a client store. If I copy an order into Zustand, I own its staleness and invalidation by hand — and that's exactly where 'the screen says picked up but it was delivered five minutes ago' bugs come from."

### Key interaction: checkout

```
Customer              Checkout page         Query cache                              API
    │                       │                    │                                    │
    │ 1 tap Place order     │                    │                                    │
    │──────────────────────▶│                    │                                    │
    │                       │ 2 key K for this attempt                                │
    │                       │ 3 mutate(cart, K)  │                                    │
    │                       │───────────────────▶│                                    │
    │                       │                    │ 4 POST /orders, Idempotency-Key K  │
    │                       │                    │───────────────────────────────────▶│
    │                       │                    │ 5 no answer (tunnel)               │
    │                       │                    │◀───────────────────────────────────│
    │                       │                    │ 6 retry with the same K            │
    │                       │                    │───────────────────────────────────▶│
    │                       │                    │ 7 201, the first order (replayed)  │
    │                       │                    │◀───────────────────────────────────│
    │                       │ 8 order id         │                                    │
    │                       │◀───────────────────│                                    │
    │ 9 go to /orders/{id}  │                    │                                    │
    │◀──────────────────────│                    │                                    │
    │                       │                    │                                    │
```

"The key is created when the customer taps Place order and lives as long as that attempt. Every retry — the automatic one after a network error, the Retry button, a reload that finds the attempt pending — sends the same key, and the server answers with the first order. Editing the cart starts a new attempt and a new key."

### Key interaction: live tracking through a tunnel

```
 Tracking page        Realtime client                  Gateway
       │                     │                            │
       │ 1 watch order 42    │                            │
       │────────────────────▶│                            │
       │                     │ 2 subscribe_order 42       │
       │                     │───────────────────────────▶│
       │                     │ 3 snapshot v3              │
       │                     │◀───────────────────────────│
       │ 4 render v3         │                            │
       │◀────────────────────│                            │
       │                     │ 5 location, eta            │
       │                     │◀───────────────────────────│
       ············ socket drops in a tunnel ··············
       │                     │ 6 retry in 1, 2, 4 s + jitter
       │                     │ 7 subscribe_order 42       │
       │                     │───────────────────────────▶│
       │                     │ 8 snapshot v5              │
       │                     │◀───────────────────────────│
       │ 9 apply v5 (5 > 3)  │                            │
       │◀────────────────────│                            │
       │                     │ 10 late event v4: dropped  │
       │                     │◀───────────────────────────│
       │                     │                            │
```

"The socket is not a log. When it reconnects, the client resubscribes and the server sends a snapshot, which fills whatever was missed. Every event and snapshot carries the order's `version`, and the cache keeps the higher one, so the late `v4` in step 10 is dropped instead of moving the timeline backwards."

### Key interaction: an offer that was taken

```
 Courier                              Dashboard                  Realtime client    API
    │                                     │                             │            │
    │                                     │ 1 new_offer, expires_in 30  │            │
    │                                     │◀────────────────────────────│            │
    │ 2 modal + countdown                 │                             │            │
    │◀────────────────────────────────────│                             │            │
    │ 3 tap Accept                        │                             │            │
    │────────────────────────────────────▶│                             │            │
    │                                     │ 4 POST /offers/{id}/accept               │
    │                                     │─────────────────────────────────────────▶│
    │                                     │ 5 409 ORDER_UNAVAILABLE                  │
    │                                     │◀─────────────────────────────────────────│
    │ 6 close modal: order was cancelled  │                             │            │
    │◀────────────────────────────────────│                             │            │
    ······························ after any reconnect ·······························
    │                                     │ 7 GET /driver/offers/pending             │
    │                                     │─────────────────────────────────────────▶│
    │                                     │ 8 offer, expires_in_seconds 12           │
    │                                     │◀─────────────────────────────────────────│
    │                                     │                             │            │
```

"Offers race with cancellations. The modal disables Accept on tap, and a `409` is a normal outcome with its own copy, not an error toast. After any reconnect, the dashboard asks the server for its pending offer, so an offer pushed while the courier was in a dead zone still appears — with the server's remaining seconds, not a fresh 30."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `Order` | `id`, `status`, `version`, `items[]`, `merchant`, `driver`, amounts, `estimatedDeliveryTime` | `['order', id]` | Realtime events; refetch on reconnect and after each status event |
| `CourierPosition` | `lat`, `lng`, `etaSeconds`, `receivedAt` | `['order', id, 'position']` | Replaced by each event; "last updated" shown after 30 s |
| `Quote` | `subtotal`, `deliveryFee`, `tip`, `total` (decimal strings) | `['quote', merchantId, items, tip, location]` | Refetched when any input changes; superseded requests aborted |
| `Offer` | `offerId`, `order`, `expiresAt` (local clock + server seconds) | `['offer', 'pending']` | Set by the socket; re-read on every reconnect |
| `ActiveDelivery` | `Order` assigned to me | `['deliveries']` | Invalidated after each courier action |
| `Cart` | `merchantId`, `lines[{menuItemId, quantity, note}]` | Zustand, persisted | Cleared after a successful order |
| `CheckoutAttempt` | `idempotencyKey`, `status` | Component ref, mirrored to `sessionStorage` | New key when the cart changes |

Two modeling decisions:

- **Versions decide, not arrival order.** The merge rule for an order is "keep the copy with the higher `version`". It covers duplicate events, events that arrive before a snapshot, and refetches racing events — with one comparison.
- **The cart stores ids and quantities, never prices.** Prices in the cart are display copies; the number on the button comes from the quote. A client-computed total is a client-editable total.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
POST /api/v1/orders/quote                {merchant_id, items, tip, delivery_lat, delivery_lng} → price
POST /api/v1/orders                      + Idempotency-Key → 201 order | 409 in flight | 422 reused or invalid
GET  /api/v1/orders/{id}                 → order with version
POST /api/v1/orders/{id}/cancel          → 200 | 409 too late (a courier accepted)
GET  /api/v1/driver/offers/pending       → {offer, order, expires_in_seconds} | null
POST /api/v1/driver/offers/{id}/accept   → 200 order | 409 OFFER_UNAVAILABLE | ORDER_UNAVAILABLE
POST /api/v1/driver/location             {lat, lng} → 200
WSS  /ws  → subscribe_order(id)          ← order_snapshot, status_update {status, version}, location_update {lat, lng, eta}
          → subscribe_driver_offers      ← new_offer {offer_id, order, expires_in}
```

- Errors carry a stable `code`; the API client maps it to a typed error so components branch on `ORDER_UNAVAILABLE`, not on message text.
- The server computes ETAs; the client only formats them and shows how old they are.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `useCheckout()` | Owns the attempt: quote → key → create → retry with the same key; exposes `pending`, `error`, `retry()` |
| `useOrderLive(id)` | Snapshot plus events into `['order', id]`; exposes `order`, `position`, `connection` |
| `<TrackingMap position eta>` | Interpolates between positions; never extrapolates past the last fix |
| `<OfferModal offer onAccept onDecline>` | Countdown from `expiresAt`; Accept disabled while pending; focus trapped |
| `useCourierPresence(online)` | Geolocation watch plus heartbeat; sends over the socket, falls back to HTTP |

---

## 🔧 O — Optimizations & Deep Dives (20 min)

### Deep dive 1: a checkout that never double-orders and shows the real price (7 min)

"The scenario: a customer on a train taps Place order, the request times out, and they can't tell whether the order exists. If they tap again and we create a second order, we charge twice and dispatch two couriers."

**The approach.** I keep checkout pessimistic and idempotent. On tap, `useCheckout` creates an idempotency key with `crypto.randomUUID()` and stores it for this attempt. The mutation retries network failures automatically with the same key; a "Retry — it's safe" button does the same; a reload finds the pending attempt in `sessionStorage` and offers to resume it. The server returns the original order for a repeated key. Any edit to the cart, tip or address resets the key, because it is now a different request — and the server would reject the old key with a different body anyway.

**The price comes from the server.** The delivery fee depends on the distance from merchant to customer, so a client-side total is wrong whenever the address changes. The page asks for a quote 250 ms after the last change, aborts the previous request with an `AbortController` so a slow response can't overwrite a newer one, and shows "Calculating…" instead of a stale number. The quote and the order use the same server function, so the total on the button is the total charged.

**Failure copy matters.** If the server answered (`422` merchant closed, item unavailable), the attempt is over and the message names the problem. If the server never answered, the copy says the order may have gone through and that retrying is safe — because it is.

| Approach | Verdict |
|----------|---------|
| ✅ Pessimistic create + idempotency key per attempt | Correct across timeouts, double taps and reloads; ~300 ms of "Placing order…" |
| ❌ Optimistic create | We can't show an order id, an ETA or a courier before the server has them |
| ❌ Disable the button and hope | Stops double taps, not retries after a timeout or a reload |
| ❌ Client-computed total | Wrong whenever distance-based fees or promotions apply |

"What I give up is a moment of 'Placing order…' instead of instant feedback — fine for an action someone takes once per meal."

### Deep dive 2: live tracking on a bad network (7 min)

"Tracking is a subscription, not a request. The question is what the screen shows when the subscription breaks, and how it catches up."

**Transport.** WebSocket, because couriers also push positions and receive offers on the same connection and the server pushes every 3 seconds per active order. Server-Sent Events would serve the customer side well (one-way, automatic reconnect with `Last-Event-ID`), but the courier app needs both directions; polling every 3 seconds per tracking customer would be ~17K requests/second at peak for data that is mostly unchanged.

| Option | Verdict |
|--------|---------|
| ✅ WebSocket, snapshot on (re)subscribe, versioned events | Push latency, both directions, explicit resync |
| ⚠️ SSE | Fine for customers; a second channel for couriers |
| ❌ Polling every 3 s | ~17K requests/s at peak; still 1.5 s average lag |

**Reconnect.** On close, the realtime client retries after 1, 2, 4 … up to 30 seconds, each delay randomized between half and the full value, so a deploy that drops 50,000 sockets doesn't bring them back in the same second. A close code meaning "session invalid" stops retrying and sends the user to log in. On every open it resubscribes to whatever the page is watching.

**Catching up.** The server answers every subscription with a full snapshot. The client merges by version: a snapshot or event with a lower version than the cache is ignored. After each status event the page also refetches the order, which brings in the courier's name and timestamps; that refetch goes through the same version check.

**What the customer sees.** While the socket is reconnecting, a non-blocking banner says "Live updates paused — reconnecting", and the map keeps the last position with "updated 40 s ago" instead of pretending to be live. Positions arrive every 3 seconds; the map animates the marker between the last two fixes over the next interval and never guesses beyond the last fix. Status changes are announced through a polite `aria-live` region ("Your order was picked up"), because the visual timeline alone is invisible to screen readers.

**Battery and background tabs.** When the page is hidden, the socket stays open but the map stops animating; when it becomes visible again, the client refetches the order before resuming.

"What I give up: a persistent connection per tracking customer, and a resync snapshot after every reconnect. Both are cheap compared with a timeline that silently skips 'picked up'."

### Deep dive 3: the courier's offer and the Accept button (5 min)

"The courier sees a 30-second offer while driving. The countdown must be honest, and Accept must either give them the order or tell them clearly that it's gone."

1. **Countdown from server time.** The offer carries seconds remaining, not an absolute timestamp, so a phone whose clock is two minutes off still counts down correctly. The modal computes `expiresAt` once on arrival and renders `expiresAt − now` every second; at zero it closes itself.
2. **Accept is pessimistic.** Tapping disables both buttons and shows a spinner. `200` adds the delivery and closes the modal. `409` closes the modal with "This order is no longer available" — the customer cancelled or the window closed. No optimistic assignment: a courier who starts driving on an optimistic "accepted" is the expensive failure.
3. **Recovering a missed offer.** After any reconnect the dashboard calls `GET /driver/offers/pending`. Pushes are a fast path, not the source of truth.
4. **Presence.** While online the app watches GPS and posts positions; because browsers report only on movement, it re-sends the last position every 10 seconds as a heartbeat, so a parked courier keeps getting offers. Each ping goes over the socket when it's open, otherwise over HTTP — never both, which would double the writes and the events customers receive.
5. **Accessibility in a hurry.** The modal is a real dialog: focus moves to Accept, Escape declines, and the remaining time is announced at 10 seconds — not every second, which would drown out everything else.

| Approach | Verdict |
|----------|---------|
| ✅ Pessimistic Accept, `409` as a normal outcome, pending offer re-read on reconnect | Couriers never drive for an order they don't have |
| ❌ Optimistic Accept | Shows "accepted" for an order that was cancelled a second earlier |
| ❌ Countdown from a server timestamp | Wrong on phones with skewed clocks |

### Performance and security checklist (1 min)

- Route-level code splitting per role; the map library loads only on the tracking page; images are sized and lazy below the fold.
- Long order history is cursor-paginated and virtualized.
- The session token belongs in an `HttpOnly` cookie, not `localStorage`; the socket authenticates with a short-lived ticket fetched over HTTPS rather than a long-lived token in the URL.
- Merchant names and descriptions are rendered as text, never as HTML.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| Quote loading | "Calculating…" for fee and total; Place order shows no amount | Quote query pending; previous request aborted |
| Network drops at checkout | "We couldn't confirm your order. Retry is safe." | Same key on retry; server replays the first order |
| Merchant closed or item unavailable | Message naming the item; cart stays | `422` with field details |
| Socket reconnecting | Yellow banner; map shows "updated N s ago" | Connection state from the realtime client |
| No courier yet | "Finding your courier" with the elapsed time | Order `pending`; the dispatcher keeps trying for 5 minutes |
| Cancel too late | "A courier already accepted — the order can't be cancelled now" | `409`; page refetches |
| Offer taken | "This order is no longer available" | `409` on Accept; modal closes |
| No merchants nearby | Empty state with a wider-radius suggestion | Empty list, not a spinner |
| No orders yet | "Your orders will appear here" with a link to browse | Empty state is onboarding |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SSR for public merchant pages, SPA for the rest | One SPA for everything | SEO and first paint where they matter |
| Server state | TanStack Query, realtime writes into it | Copying server data into Zustand | One cache, one merge rule |
| Checkout | Pessimistic + idempotency key per attempt | Optimistic | The server assigns the order; retries must not duplicate |
| Price | Server quote with abort | Client-computed total | Fees depend on distance |
| Live updates | WebSocket + snapshot + versions | Polling | Push latency; explicit resync |
| Accept | Pessimistic, `409` handled as normal | Optimistic | Never drive for an order you don't have |
| Courier presence | GPS watch + 10 s heartbeat, one channel per ping | Movement-only pings | Parked couriers stay matchable |

"With more time I'd add Web Push so status changes reach a backgrounded tab, persist the query cache to IndexedDB so the tracking page opens instantly from a notification, and measure INP and reconnect time on real courier devices before tuning anything else."

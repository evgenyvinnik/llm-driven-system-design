# 🔔 Notification System — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The frontend of a notification system looks like a bell icon and a settings page. Two things make it hard. The inbox has to be live without being wrong: no duplicates, nothing missed after a dropped connection, and the same unread count in every open tab. And settings that look trivial — a toggle, two times of day — have to mean exactly what the user thinks they mean, in their own time zone, even when they change them on two devices at once."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Users, surfaces, performance and accessibility targets |
| A — Architecture | 8 min | Component layers, who owns which state, the data layer |
| D — Data model | 5 min | Client entities and cache keys |
| I — Interface | 5 min | The API and the event stream as the client sees them |
| O — Optimizations & deep dives | 18 min | Live inbox, preference center, operator console, checklist |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"There are two audiences with different needs, so I'll confirm which surfaces we own before designing any of them."

### Functional requirements

1. **Notification center** for end users, embedded in every page of the product: a bell with an unread badge, a dropdown with the latest items, a full inbox page with filters, mark-as-read and mark-all-read, and deep links to whatever the notification is about. New items appear within seconds.
2. **Preference center**: a channel × category matrix (push, email, SMS × security, orders, social, marketing), quiet hours with a time zone, and a one-click unsubscribe page reached from emails without logging in.
3. **Web push opt-in**: ask for browser permission at a sensible moment, and register the subscription.
4. **Operator console**: compose or test-send a notification, watch its per-channel delivery timeline update live, preview templates, and schedule campaigns.

Out of scope: the providers themselves, native mobile apps (they share the API), template authoring workflows beyond preview.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Bell cost on host pages | < 15 KB gzipped initial; dropdown and inbox lazy-loaded | It ships on every page of someone else's product |
| Live latency | New inbox item visible < 2 s after the server accepts it | Users compare it to their phone |
| INP | < 200 ms, including opening the dropdown and toggling settings | Interactions must feel instant |
| LCP / CLS | Inbox page LCP < 2.0 s on mid-range mobile; CLS < 0.1 | The bell badge must not shift the host header |
| Correctness | No duplicate items, no missed items after reconnect, one unread count across tabs | Trust in the badge is the product |
| Accessibility | WCAG 2.2 AA; new items announced politely; full keyboard use | The dropdown is a menu, the matrix is a form |
| Offline | Inbox readable offline; read marks queued and replayed | Phones on trains |

---

## 🏗️ A — Architecture (8 min)

"This is an authenticated, personalized UI with no SEO value, so a client-rendered SPA for the inbox, preference center and console, plus a tiny standalone bell bundle for host pages. The bell is a web component that lazy-loads the dropdown on first interaction, so host pages pay almost nothing until someone clicks it."

```
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │ Routes · TanStack Router:  /inbox  /preferences  /console/send  /console/n/$id            │
 │ URL state: ?filter=unread   ?channel=sms&status=failed                                    │
 └──────────┬─────────────────────────────────┬────────────────────────────┬─────────────────┘
            ▼                                 ▼                            ▼
 ┌──────────────────────────┐   ┌──────────────────────────┐   ┌─────────────────────────────┐
 │ NotificationBell         │   │ PreferenceCenter         │   │ Console: SendForm           │
 │ InboxList                │   │ ChannelMatrix            │   │ DeliveryTimeline            │
 │ (virtualized)            │   │ QuietHoursPicker         │   │ TemplatePreview (iframe)    │
 └──────────┬───────────────┘   └─────────────┬────────────┘   └──┬──────────────────────────┘
            │ (1) read inbox, live items      │ (2) toggle        │ (3) send
            ▼                                 ▼                   ▼
 ┌────────────────────────────────────────────────────────────────────┐   ┌──────────────────┐
 │ TanStack Query: ['inbox', filter] · ['unread'] · ['prefs']         │   │ Zustand          │
 │ ['notification', id] · optimistic update + rollback                │   │ session · toasts │
 └──────────┬─────────────────────────────────┬───────────────────────┘   └──────────────────┘
            │ subscribe                       │ fetch / mutate
            ▼                                 ▼
 ┌────────────────────────────┐   ┌────────────────────────────┐   ┌─────────────────────────┐
 │ Stream client (leader tab) │   │ API client                 │   │ Service worker          │
 │ SSE + Last-Event-ID        │   │ fetch + AbortSignal        │   │ web push                │
 │ BroadcastChannel to tabs   │   │ Idempotency-Key · If-Match │   │ offline app shell       │
 └──────────┬─────────────────┘   └───────────┬────────────────┘   └─────────────────────────┘
            │ GET /v1/me/stream               │ HTTPS · session cookie          ▲
            ▼                                 ▼                                 │ push event
 ┌──────────────────────────────────────────────────────────────────────────────┴────────────┐
 │ Notification API · /v1/me/notifications · /v1/me/preferences · /v1/notifications          │
 │ Web Push service (FCM, Mozilla) wakes the service worker                                  │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Read and live (1).** The bell and inbox read `['inbox', filter]` and `['unread']` from the query cache. One tab — the leader — holds the server-sent events stream and shares events with the other tabs over `BroadcastChannel`; each event is merged into the cache by item ID.
2. **Change settings (2).** A toggle in the preference center is an optimistic mutation sent with the preferences' `version` in `If-Match`; a conflict or error rolls the cache back.
3. **Send (3).** The console's send form freezes the draft with an idempotency key and submits it through the API client; the delivery timeline for the new notification then updates live from the same stream.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Inbox pages, unread count, preferences, notification details | TanStack Query | Caching, dedupe, retries, invalidation and optimistic updates without hand-written loading flags |
| Live events | Stream client → query cache | One connection per browser, merged into the same cache everything else reads |
| Filters (`?filter=unread`, `?channel=sms`) | URL search params | Shareable, survive reload, work with back/forward |
| Session, toasts, open/closed dropdown | Zustand / component state | Small, client-only, never fetched |
| Send draft + idempotency key | Component state mirrored to `sessionStorage` | Survives a refresh while a send is pending |
| Offline read marks | IndexedDB queue | Replayed in order when the network returns |

"The rule I'm following: server data never gets copied into Zustand by hand. The moment you copy it, you own its staleness, deduplication and invalidation — and the badge showing 3 while the list shows 2 is exactly that bug."

### Key interaction: sending from the console

```
Operator                   SendForm                  Query cache               Notification API
    │                          │                          │                            │
    │ 1 click Send             │                          │                            │
    │─────────────────────────▶│                          │                            │
    │                          │ 2 freeze draft + key K   │                            │
    │                          │ 3 mutate(draft, K)       │                            │
    │                          │─────────────────────────▶│                            │
    │                          │                          │ 4 POST, Idempotency-Key K  │
    │                          │                          │───────────────────────────▶│
    │                          │                          │ 5 202 | 409 | 422 | 429    │
    │                          │                          │◀───────────────────────────│
    │                          │                          │ 6 invalidate list          │
    │                          │ 7 success → clear draft  │                            │
    │                          │◀─────────────────────────│                            │
    │ 8 outcome via aria-live  │                          │                            │
    │◀─────────────────────────│                          │                            │
    │                          │                          │                            │
```

"Sending is deliberately not optimistic: the server decides whether it becomes `queued`, `scheduled` for after the user's quiet hours, `suppressed` by their preferences, or `deduplicated`, and the operator needs to see which. The key `K` means a timeout followed by a retry returns the original result instead of sending twice."

### Key interaction: the live stream across a reconnect

```
Inbox UI                                  Leader tab                       Notification API
    │                                          │                                   │
    │                                          │ 1 GET /stream, Last-Event-ID 812  │
    │                                          │──────────────────────────────────▶│
    │                                          │ 2 replay 813..820, then live      │
    │                                          │◀──────────────────────────────────│
    │ 3 BroadcastChannel: new item, unread +1  │                                   │
    │◀─────────────────────────────────────────│                                   │
    │ 4 insert by id (dedupe), announce politely                                   │
    ······························ connection drops ································
    │                                          │ 5 reconnect, Last-Event-ID 820    │
    │                                          │──────────────────────────────────▶│
    │                                          │ 6 events after 820 only           │
    │                                          │◀──────────────────────────────────│
    │                                          │                                   │
```

"Every event carries a monotonically increasing ID. On reconnect the browser sends `Last-Event-ID` and the server replays what was missed, so a dropped connection never loses an item — and because items are merged by ID, a replayed one never appears twice."

### Key interaction: toggling a preference

```
User                     PreferenceCenter          Query cache            Preferences API
  │                              │                      │                        │
  │ 1 turn off SMS               │                      │                        │
  │─────────────────────────────▶│                      │                        │
  │                              │ 2 optimistic update  │                        │
  │                              │─────────────────────▶│                        │
  │                              │                      │ 3 PATCH, If-Match: v7  │
  │                              │                      │───────────────────────▶│
  │                              │                      │ 4 200 v8 | 412         │
  │                              │                      │◀───────────────────────│
  │                              │                      │ 5 on error: roll back  │
  │ 6 "Saved" or rollback toast  │                      │                        │
  │◀─────────────────────────────│                      │                        │
  │                              │                      │                        │
```

"Toggles are optimistic because they're single fields that almost always succeed. The `If-Match` version catches the one case that matters: the user changed the same setting on their phone a minute ago."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `InboxItem` | `id`, `eventId`, `category`, `title`, `body`, `deepLink`, `createdAt`, `readAt`, `actor` | Inside `['inbox', filter]` pages | Live via stream; refetch on focus after > 60 s hidden |
| `InboxPage` | `items`, `nextCursor` | `['inbox', {filter}]` (infinite query) | Stream inserts at the top; cursor pages below |
| `UnreadCount` | `count`, `asOfEventId` | `['unread']` | Stream increments; server value wins on refetch |
| `Preferences` | `channels`, `categories` matrix, `quietHours {start, end, timeZone}`, `version` | `['prefs']` | Optimistic writes with `If-Match` |
| `NotificationDetail` | `id`, `status`, `deliverAt`, per-channel `deliveries[{channel, status, attempts, updatedAt}]` | `['notification', id]` | Live `delivery.updated` events patch it |
| `SendDraft` | form fields, `idempotencyKey`, `state` | `sessionStorage['send-draft']` | Cleared on success |

Two modeling decisions:

- **The unread count is a server number, not `items.filter(unread).length`.** The client only holds the first few pages; the count covers the whole inbox. The stream sends increments for speed, and every `['unread']` refetch replaces the local value — the server is the source of truth, the stream is a hint.
- **Times travel as UTC instants, quiet hours as local wall-clock times.** A `deliverAt` is an instant and is formatted with `Intl.DateTimeFormat` in the viewer's zone. Quiet hours are "22:00 to 07:00 in Asia/Tokyo" — minutes from local midnight plus an IANA zone — because converting them to UTC would shift them by an hour every DST change.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET   /v1/me/notifications?filter&cursor&limit    → {items, next_cursor}
POST  /v1/me/notifications/{id}/read              → 204  (idempotent)
POST  /v1/me/notifications/read-all?before={id}   → 204  (bounded by the newest item seen)
GET   /v1/me/unread-count                         → {count, as_of_event_id}
GET   /v1/me/preferences                          → Preferences (with version)
PATCH /v1/me/preferences                          If-Match: version → 200 | 412
POST  /v1/notifications                           Idempotency-Key → 202 {id, status, deliver_at} | 409 | 422 | 429
GET   /v1/notifications/{id}                      → status + deliveries
GET   /v1/me/stream                               SSE; Last-Event-ID resume
POST  /v1/me/push-subscriptions                   register a web push subscription
```

- **Stream events:** `inbox.created`, `inbox.read` (from another device), `unread.changed`, and for operators `delivery.updated`. Each has an `id:` line so the browser's `EventSource` can resume.
- **`read-all` takes a `before` cursor**, so "mark all read" can't mark an item that arrived after the user clicked.
- **Errors** are `application/problem+json`; `429` carries `Retry-After`, which the send button turns into a countdown.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<NotificationBell>` | Badge from `['unread']`; opens the dropdown; announces new items through one shared `aria-live` region |
| `<InboxList filter onOpen(item)>` | Virtualized rows, keyboard navigation, marks read on open |
| `<ChannelMatrix value onChange>` | A real table of checkboxes with row and column headers; one mutation per toggle |
| `<QuietHoursPicker start end timeZone>` | Shows the next quiet period in the user's zone ("Tonight 22:00 – tomorrow 07:00") |
| `useInbox()`, `useMarkRead()`, `useUpdatePreferences()`, `useSendNotification()` | Own every cache key and optimistic update so components never touch query keys |

---

## 🔧 O — Optimizations & Deep Dives (18 min)

### Deep dive 1: a live inbox that is never wrong (7 min)

"The requirement is 'new items within two seconds', but the hard part is correctness at the edges: reconnects, many tabs, and the badge."

**Server-sent events, not WebSockets or polling.** Traffic is almost entirely server → client; reads and settings changes are ordinary HTTP requests. SSE gives me automatic reconnection and `Last-Event-ID` resume built into `EventSource`, works through proxies as plain HTTP, and needs no custom protocol. Polling every 30 seconds would miss the 2-second target, and polling every 2 seconds would multiply requests by 15 for no benefit. WebSockets would work, but I'd be rebuilding resume and heartbeats myself.

**One connection per browser, not per tab.** Users keep ten tabs of the product open; ten streams per user multiplies server connections. Tabs elect a leader with the Web Locks API — whoever holds the lock opens the stream — and the leader rebroadcasts events on a `BroadcastChannel`. When the leader tab closes, the lock passes to another tab, which reconnects with the last event ID it saw.

**Merge by ID, treat the server as authoritative.** Every incoming item is inserted into the cached first page only if its ID isn't already there, which makes replays and duplicate broadcasts harmless. The unread badge applies stream increments immediately, but whenever `['unread']` is refetched — on focus, on reconnect — the server's number replaces the local one, so any drift lasts until the next refetch at most.

**Reading.** Opening an item marks it read optimistically and calls an idempotent endpoint; offline, the mark goes into an IndexedDB queue that's replayed when the network returns. A read on another device arrives as `inbox.read` and updates this one.

| Approach | Verdict |
|----------|---------|
| ✅ SSE + `Last-Event-ID`, leader tab + `BroadcastChannel` | Built-in resume, one connection per browser, no duplicates |
| ❌ WebSocket | Works, but resume, heartbeats and auth refresh become our protocol to maintain |
| ❌ Polling | Either misses the latency target or wastes requests |
| ❌ A stream per tab | Connection count scales with tabs, and tabs disagree about the badge |

"What I give up: leader election adds a moving part, and a tab can lag for a moment while the lock changes hands. I'd take that over ten connections per user."

### Deep dive 2: a preference center that means what it says (5 min)

"Preferences are where a UI bug becomes a legal or trust problem: the user turned marketing email off and got one anyway."

**The matrix.** Channel × category is a table of checkboxes — real `<table>` semantics with row and column headers, so a screen reader announces "Marketing, Email, checked". Security notifications are shown but locked on, with an explanation; users can't opt out of password resets.

**Optimistic with a version.** Each toggle updates the cache immediately and sends `PATCH` with `If-Match: version`. On `412` — they changed it on their phone — I refetch and show what changed instead of overwriting it. On any other error I roll back and show a toast. Rapid toggles are serialized per preferences object so responses can't arrive out of order and undo each other.

**Quiet hours and time zones.** The picker shows times in the user's zone and saves the IANA zone with the window — `Intl.DateTimeFormat().resolvedOptions().timeZone`, with a select to change it. If the stored zone differs from the browser's ("You're in New York, your quiet hours use Tokyo time"), I say so, because traveling users are the common case. Under the picker I preview the next quiet period in words, which is where DST surprises surface before they cause a 6 a.m. buzz.

**Unsubscribe without login.** Email links carry a signed, single-purpose token. The landing page shows exactly what will stop, applies it on one click (also supporting one-click `List-Unsubscribe` from the mail client), and offers "less often" before "never".

| Approach | Verdict |
|----------|---------|
| ✅ Optimistic toggle + `If-Match` + rollback | Instant feedback without silently overwriting another device |
| ❌ Save button for the whole form | Users leave without saving; one stale form overwrites newer settings |
| ❌ Last write wins | A stale tab re-enables something the user just turned off |
| ✅ Wall-clock times + IANA zone | Matches what the user typed, DST included |
| ❌ Store quiet hours in UTC | Shifts by an hour twice a year |

### Deep dive 3: the operator console's send and timeline (4 min)

**Send safely.** Submitting freezes the draft and generates an idempotency key, saved with it in `sessionStorage`. Resubmitting the same draft — the Retry button, an automatic retry after a network error, or a reload that finds a pending draft — reuses the key; editing the draft makes a new key. The server returns the original result for a reused key and `422` if the body changed. The response says what happened, and I show it in words: "Queued", "Scheduled for 07:00 the recipient's time (quiet hours)", "Not sent: SMS is turned off for this user".

**Watch it live.** The notification detail page subscribes to `delivery.updated` for that ID and patches `['notification', id]`: a timeline per channel — queued, sending, retry in 10 s, sent, delivered or bounced — with the attempt count. Without the stream it falls back to polling every 5 seconds while any channel is still in flight.

**Preview safely.** Template previews render inside a sandboxed `<iframe srcdoc>` with no scripts and no same-origin access, because operators paste HTML and template variables contain user data. Push and SMS previews render as text, never as HTML.

### Deep dive 4: performance, accessibility and security checklist (2 min)

- **Bell budget:** a web component of under 15 KB; the dropdown, inbox and date formatting load on first interaction; the badge reserves its width so it can't shift the host's header.
- **Long inboxes:** `@tanstack/react-virtual` with cursor pages of 30; `aria-rowcount` and roving focus so keyboard and screen-reader users can still move through unrendered rows.
- **Announcements:** one shared polite `aria-live` region — "2 new notifications" — batched over two seconds so a burst doesn't flood the screen reader.
- **Web push permission:** never on page load; offer it after the user does something that benefits from it, explain first, and remember a "not now" for 30 days. A denied permission can't be asked again.
- **XSS:** notification titles and bodies render as text; deep links must be same-origin or allow-listed and `http(s)` only, so a `javascript:` link from a compromised template can't run in a user's session.
- **CSRF:** `SameSite=Lax` session cookie, JSON-only mutations, and a custom header on every write.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| First inbox load | Skeleton rows at the real row height | First page only; later pages show a spinner row |
| Stream disconnected | Nothing, then "Reconnecting…" after 10 s | `EventSource` retries; the cache keeps showing data |
| Offline | "You're offline — read marks will sync" | Cached inbox stays readable; IndexedDB queue |
| `412` on a preference | "This setting changed on another device" with the current value | Refetch and re-render the matrix |
| `429` on send | "Try again in 42 s" on the button | Countdown from `Retry-After` |
| Send `suppressed` or `deduplicated` | An explanation, not a success message | The response's `status` and `reason` |
| Empty inbox | "You're all caught up" and a link to preferences | The empty state teaches where settings live |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Live updates | SSE with `Last-Event-ID` | WebSocket or polling | Built-in resume; server → client traffic |
| Connections | Leader tab + `BroadcastChannel` | A stream per tab | One connection per browser; one badge |
| Server state | TanStack Query, merge events by ID | Zustand copies of server data | No hand-rolled staleness or duplicate handling |
| Preferences | Optimistic + `If-Match` | Whole-form save, last write wins | Fast and safe across devices |
| Quiet hours | Local times + IANA zone | UTC times | Correct across DST and travel |
| Sending | Idempotency key per draft, not optimistic | Optimistic send | The server decides the outcome; retries can't duplicate |

"With more time I'd add notification grouping in the inbox ('Ana and 11 others liked your photo'), per-category snooze, and real-user monitoring of how long items take from accept to on-screen."

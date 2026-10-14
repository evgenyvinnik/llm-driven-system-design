# 🔔 Notification System — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one notification from the button that sends it to the badge that shows it, and get the contracts between the layers right, so each layer can fail or lag without breaking the others. Three contracts carry most of the weight: an idempotency key that makes sending safe to retry, a `202` whose status the UI can explain — queued, scheduled for after the recipient's quiet hours, suppressed — and an event stream with IDs, so the inbox and the console stay live without duplicates or gaps."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and the targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the browser to the providers, plus the core flows |
| Data model & API contract | 7 min | Server tables, client cache keys, and the fields both sides rely on |
| Deep dive 1: one notification per click | 8 min | Idempotency from the button to the database |
| Deep dive 2: quiet hours end to end | 7 min | Time zones from the picker to the scheduler and back |
| Deep dive 3: from provider receipt to badge | 7 min | Status events, the stream, and the client cache |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Product services and operators send notifications to users over push, email, SMS and an in-app inbox, with a priority and an optional send time. The system honors each user's channel and category opt-outs and quiet hours, drops duplicates and enforces rate limits. Users get a live notification center (bell, unread badge, inbox) and a preference center; operators get a console to compose, send and watch delivery per channel, and to run campaigns. Out of scope: building our own push or SMS transport, content A/B tests.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Accept latency | p99 < 100 ms for `POST /v1/notifications` |
| Backend | Durability / duplicates | An accepted notification is never lost; at most one provider call per channel outside a crash window |
| Backend | Critical latency | Accepted → provider p99 < 2 s, even during a campaign |
| Frontend | Live updates | New inbox items and delivery status on screen < 2 s after the event |
| Frontend | Cost on host pages | Bell bundle < 15 KB gzipped; inbox lazy-loaded |
| Frontend | Responsiveness | INP < 200 ms; settings toggles feel instant |
| Both | Correctness | One click on Send makes at most one notification, even across timeouts and reloads; quiet hours mean the user's local time |

**Scale.** 500M notifications a day (~5,800/s), campaign peaks of 17K/s, ~1.5 channels each. Preferences are read once per notification — 17K reads/s at peak — so they live in Redis. Tens of millions of browsers hold a live stream during the day; each is one long-lived HTTP connection.

"The ratio that matters on the backend is campaign bulk versus a single critical message, which drives queue isolation. On the frontend it's tabs per user: if every tab opened its own stream, our connection count would be ten times the user count."

---

## 🏗️ End-to-End Architecture (8 min)

```
  ┌─────────────────────────────┐                         ┌────────────────────────────┐
  │ Browser SPA                 │                         │ Product services           │
  │ inbox · prefs · console     │                         │ auth · orders · social     │
  └──────────────┬──────────────┘                         └─────────────┬──────────────┘
                 │ (1) POST /v1/notifications                           │ POST /v1/notifications
                 │ (3) GET /v1/me/stream (SSE)                          │
                 ▼                                                      ▼
  ┌────────────────────────────────────────────────────────────────────────────────────┐
  │ API gateway · TLS · session and service auth · quotas                              │
  └──────────────┬─────────────────────────────────────────────────────────────────────┘
                 ▼
  ┌─────────────────────────────┐  GET prefs · SET NX     ┌────────────────────────────┐
  │ Notification API            │────────────────────────▶│ Redis                      │
  │ decide · commit             │                         │ prefs cache · idempotency  │
  │ serves SSE streams          │◀────────────────────────│ pub/sub: user events       │
  └──────────────┬──────────────┘  delivery.updated (sub) └────────────────────────────┘
                 │ 1 tx: notification + outbox                          ▲ publish user events
                 ▼                                                      │
  ┌─────────────────────────────┐  (2) SELECT due rows    ┌─────────────┴──────────────┐
  │ PostgreSQL                  │◀────────────────────────│ Outbox relay               │
  │ notifications · deliveries  │                         │ jobs → RabbitMQ            │
  │ outbox · preferences        │                         │ UI events → Redis          │
  └─────────────────────────────┘                         └─────────────┬──────────────┘
          ▲             ▲                                               │ publish + confirm
          │             │                                               ▼
          │             │                                 ┌────────────────────────────┐
          │ delivered,  │                                 │ RabbitMQ                   │
          │ bounced     │                                 │ 12 queues + dead-letter    │
          │             │                                 └─────────────┬──────────────┘
          │             │                                               │ consume
          │             │ claim · mark sent                             ▼
          │             │ status event                    ┌────────────────────────────┐
          │             └─────────────────────────────────┤ Channel workers            │
          │                                               │ push · email · sms pools   │
          │                                               └─────────────┬──────────────┘
          │                                                             │ send
          │                                                             ▼
  ┌───────┴─────────────────────┐  POST /webhooks/ses     ┌────────────────────────────┐
  │ Webhook receiver            │◀────────────────────────┤ APNs · FCM · SES · Twilio  │
  │ verify · dedupe · advance   │                         │ external providers         │
  └─────────────────────────────┘                         └────────────────────────────┘
```

1. **Send (1).** The operator's console freezes the form with an idempotency key and posts it. The Notification API checks preferences and quiet hours, then commits the notification, its per-channel delivery rows and outbox rows in one PostgreSQL transaction and returns `202` with `status` and `deliver_at`. The console shows what will happen, in words.
2. **Deliver (2).** The outbox relay publishes due rows to RabbitMQ, critical first; channel workers claim each delivery, call the provider and record the result. Every status change also writes a small "user event" row in the same transaction, which the relay publishes to Redis pub/sub.
3. **Watch (3).** Each browser keeps one SSE stream to the Notification API. The API instance holding a user's stream subscribes to that user's Redis channel and forwards events — new inbox items, delivery updates — each with an ID the browser can resume from.

| Layer | Choice | Why |
|-------|--------|-----|
| Browser | React SPA; TanStack Query for server state, URL params for filters; one SSE stream per browser via a leader tab | No SEO; the cache owns staleness, dedupe and optimistic updates |
| Edge | API gateway with session auth for browsers, service auth for product services | One front door, per-caller quotas |
| Notification API | Stateless; decides, commits, serves SSE | Never talks to RabbitMQ; any instance can hold any stream |
| Redis | Preference cache, idempotency records, dedup keys, pub/sub for user events | Losing it slows sends and pauses live updates; it never loses data |
| PostgreSQL | Notifications, deliveries, outbox, preferences, sharded by recipient | The accept transaction stays on one shard |
| Relay → RabbitMQ → workers | Delivery jobs with per-message ack, retries, dead-letter queue | Isolation per channel and priority |

### Flow: sending from the console, across the wire

```
 Console                          Notification API                   Redis   PostgreSQL
    │                                     │                            │          │
    │ 1 freeze draft, key K → sessionStorage                           │          │
    │ 2 POST, Idempotency-Key K           │                            │          │
    │────────────────────────────────────▶│                            │          │
    │                                     │ 3 claim K (SET NX), prefs  │          │
    │                                     │───────────────────────────▶│          │
    │                                     │ 4 quiet hours → deliver_at │          │
    │                                     │ 5 1 tx: notification + outbox         │
    │                                     │──────────────────────────────────────▶│
    │                                     │ 6 store 202 under K        │          │
    │                                     │───────────────────────────▶│          │
    │ 7 202 {status, deliver_at}          │                            │          │
    │◀────────────────────────────────────│                            │          │
    │ 8 "Scheduled 07:00 their time"      │                            │          │
    ···················· the 202 was lost; user clicks Retry ······················
    │ 9 same body, same K                 │                            │          │
    │────────────────────────────────────▶│                            │          │
    │ 10 stored 202, Idempotent-Replayed  │                            │          │
    │◀────────────────────────────────────│                            │          │
    │                                     │                            │          │
```

"Steps 1 and 3 are two halves of one contract. The browser promises to send the same key for the same draft — even after a reload, because the key lives with the draft in `sessionStorage` — and the server promises that a repeated key returns the stored response instead of doing the work again."

### Flow: quiet hours from the picker to the scheduler

```
 Browser                      Preferences API   Notification API               PostgreSQL
    │                                │                  │                           │
    │ 1 PUT 22:00–07:00, Asia/Tokyo  │                  │                           │
    │───────────────────────────────▶│                  │                           │
    │                                │ 2 store; DEL prefs cache                     │
    │                                │─────────────────────────────────────────────▶│
    ································ 23:10 in Tokyo ·································
    │ 3 POST /notifications                             │                           │
    │──────────────────────────────────────────────────▶│                           │
    │                                │                  │ 4 in quiet hours → defer  │
    │                                │                  │ 5 outbox due 07:00 Tokyo  │
    │                                │                  │──────────────────────────▶│
    │ 6 202 scheduledFor (UTC)                          │                           │
    │◀──────────────────────────────────────────────────│                           │
    │ 7 show "tomorrow 07:00"        │                  │                           │
    │                                │                  │                           │
```

"The browser sends wall-clock times plus an IANA zone, the server evaluates them with that zone's rules, and what comes back is an instant in UTC that the browser formats in whatever zone the viewer is in. Neither side converts quiet hours to UTC — that's the bug that shifts them by an hour at every DST change."

### Flow: a provider receipt reaching the console

```
Webhooks            PostgreSQL         Relay        Redis         API           Console
    │                    │               │            │            │               │
    │ 1 advance + event  │               │            │            │               │
    │───────────────────▶│               │            │            │               │
    │                    │ 2 due events  │            │            │               │
    │                    │◀──────────────│            │            │               │
    │                    │               │ 3 PUBLISH  │            │               │
    │                    │               │───────────▶│            │               │
    │                    │               │            │ 4 message  │               │
    │                    │               │            │───────────▶│               │
    │                    │               │            │            │ 5 SSE id 821  │
    │                    │               │            │            │──────────────▶│
    │                    │               │            │            │  6 patch row  │
    │                    │               │            │            │               │
```

"The webhook receiver doesn't publish anything itself: it writes the status change and an event row in one transaction, and the same outbox relay publishes the event. So the UI can never show 'delivered' for something the database doesn't have, and a crash between the two can't lose the update."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `notifications` | `id`, `user_id`, `category`, `content` (rendered), `priority`, `status`, `deliver_at`, `dedupe_key` | Sharded by `user_id`; `(user_id, created_at DESC, id)` serves history and inbox |
| PostgreSQL | `deliveries` | (`notification_id`, `channel`), `status`, `attempts`, `lease_expires_at`, `provider_message_id` | The per-channel state machine the console's timeline shows |
| PostgreSQL | `delivery_outbox`, `user_events` | Due time, published flag; event `seq` per user | Relay publishes jobs to RabbitMQ and events to Redis |
| PostgreSQL | `preferences` | Channel × category matrix, quiet start/end (local minutes), IANA `time_zone`, `version` | `version` backs `If-Match` |
| Redis | `prefs:{user}`, `idempotency:{caller}:{key}`, `dedup:{user}:{hash}` | Cache and claims | Invalidated on write; 24 h for completed keys |
| Redis | `user:{id}` pub/sub channel | Event fan-out | Only to instances holding that user's stream |

### Client side

| Cache key | Holds | Updated by |
|-----------|-------|------------|
| `['inbox', {filter}]` | Pages of items with `nextCursor` | Stream inserts by ID; refetch on focus |
| `['unread']` | `count`, `asOfEventId` | Stream increments; refetch replaces it |
| `['prefs']` | Preferences with `version` | Optimistic toggle; rollback on `412` or error |
| `['notification', id]` | Status, `deliverAt`, per-channel deliveries | `delivery.updated` events |
| `sessionStorage['send-draft']` | Frozen draft + idempotency key | Cleared on success |

### The contract

```
POST  /v1/notifications                 Idempotency-Key → 202 {id, status, deliver_at, reason?} | 409 | 422 | 429
GET   /v1/notifications/{id}            status + deliveries[{channel, status, attempts, updated_at}]
GET   /v1/me/notifications?filter&cursor → {items, next_cursor}
GET   /v1/me/unread-count               → {count, as_of_event_id}
PATCH /v1/me/preferences                If-Match: version → 200 | 412
GET   /v1/me/stream                     SSE: inbox.created, inbox.read, unread.changed, delivery.updated
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `Idempotency-Key` | Same key + same body → the stored response for 24 h; different body → `422`; still running → `409` | Retry after timeouts and reloads without sending twice |
| `202` + `status` + `reason` | Says whether the notification is queued, scheduled (and until when), suppressed or deduplicated | Explain the outcome instead of a generic "Sent!" |
| `deliver_at` | A UTC instant | Format it in the viewer's zone |
| Quiet hours | Wall-clock minutes + IANA zone, evaluated server-side | Show "22:00–07:00 Tokyo time" exactly as entered |
| Event `id` | Strictly increasing per user; replay after `Last-Event-ID` | Resume without gaps; drop duplicates by item ID |
| `as_of_event_id` on the count | Which events the count already includes | Avoid double-counting increments that arrived before the refetch |
| `version` + `If-Match` | Writes apply only to the version the client saw | Detect an edit from another device |

---

## 🔧 Deep Dive 1: One Notification per Click (8 min)

"The scenario: an operator on a flaky connection clicks Send, the request times out, and they click again. Without care, the recipient gets two password-reset emails — or two marketing SMS we pay for. Each layer has a job."

**Browser.** On submit, the console freezes the draft and generates a key with `crypto.randomUUID()`, storing both in `sessionStorage`. Every resend of that draft — the Retry button, TanStack Query's automatic retry on a network error, a reload that finds a pending draft — reuses the key. Editing the draft generates a new key, because it's now a different request. Disabling the button while pending helps, but correctness doesn't depend on it.

**API.** The Notification API claims `idempotency:{caller}:{key}` with `SET NX` and a 60-second processing TTL, storing a SHA-256 fingerprint of the body. If the claim fails and a completed response is stored, it returns that response with `Idempotent-Replayed: true`. If the first request is still running, it returns `409` with `Retry-After: 1`. If the stored fingerprint differs, the client reused a key for a different request: `422`. Only `2xx` responses are stored; a `429` or a validation error releases the key so the same draft can be retried later.

**Database.** The idempotency key prevents a duplicate *request*. Two other mechanisms catch other duplicates: a campaign's per-recipient `dedupe_key` with a unique index stops a rerun of a fan-out from notifying anyone twice, and a short content-hash claim stops two services from sending the same thing to the same user within a minute. And downstream, the worker's claim on each delivery row stops a redelivered message from calling the provider twice.

**UI.** The response is rendered as a sentence: "Queued", "Scheduled for 07:00 the recipient's time (quiet hours)", "Not sent: SMS is off for this user", "Not sent: identical notification a moment ago". `429` becomes a countdown from `Retry-After` on the button.

| Approach | Verdict |
|----------|---------|
| ✅ Client key per draft + server-stored response | Correct across timeouts, reloads and concurrent duplicates |
| ❌ Server dedupe by body hash only | Merges intentional repeats; misses a retry whose timestamp field changed |
| ❌ Disable the button only | Stops double clicks, not retries after a timeout or a reload |
| ❌ Optimistic "Sent!" | The server may schedule, suppress or deduplicate it — the UI would lie |

"What I give up: a Redis round trip on every send and 24 hours of stored responses. If Redis is down I'd rather fail operator sends with `503` than send without the guarantee; for automated callers I'd let them through and alert."

---

## 🔧 Deep Dive 2: Quiet Hours End to End (7 min)

"Quiet hours look like two time pickers. The bug class here is time zones, and it crosses every layer."

**Capture.** The picker shows local times and saves them with the IANA zone, defaulting to the browser's (`Intl.DateTimeFormat().resolvedOptions().timeZone`). If the saved zone differs from the browser's, the page says so — "Your quiet hours use Tokyo time; you're in New York" — because travelers are common, and silently re-zoning their settings would be worse. Underneath, I preview the next quiet period in words ("Tonight 22:00 – tomorrow 07:00"), which surfaces DST surprises before they happen.

**Store.** Start and end are minutes from local midnight plus the zone name, never UTC. "22:00 in Tokyo" stays 22:00 all year; a UTC conversion would be right for half the year in any zone with DST. Writes invalidate the Redis preference cache, so the next send sees them.

**Evaluate.** At accept time the API computes the recipient's local wall-clock time with the zone's rules. A non-critical send inside the window gets `deliver_at` = the next local end time, computed across DST — 07:00 can be 23 or 25 hours away — and the outbox row is written with that `available_at`. Critical messages (login codes, security alerts) ignore quiet hours. A window whose end is before its start, like 22:00–07:00, spans midnight; start equal to end means "off".

**Re-check.** A message deferred eight hours can outlive consent, so the worker re-checks the cached opt-out right before sending.

**Show.** The `202` carries `status: scheduled`, `reason: quiet_hours` and `deliver_at` as a UTC instant. The console formats it twice: in the operator's zone and in the recipient's ("07:00 their time, 00:00 yours").

| Approach | Verdict |
|----------|---------|
| ✅ Wall-clock minutes + IANA zone, evaluated server-side | Matches what the user entered; DST-safe; one implementation |
| ❌ Store quiet hours in UTC | Shifts by an hour twice a year |
| ❌ Use the server's time zone | Wakes Tokyo users at 3 a.m. |
| ❌ Evaluate in the browser | Senders are servers; the recipient's browser isn't involved in a send |

"What I give up: a time zone database on the server that must stay current, and a slightly more complex picker. Both are cheap next to the support tickets from a 6 a.m. buzz."

---

## 🔧 Deep Dive 3: From Provider Receipt to Badge (7 min)

"Two rules: the UI must never show a state the database doesn't have, and a dropped connection must never lose an update."

**Produce.** Every status change that a user or operator can see — a new inbox item, a delivery moving to `sent`, `delivered` or `bounced` — writes an event row in the same transaction as the change, with a per-user sequence number. Provider receipts arrive at the webhook receiver, which verifies the signature, ignores event IDs it has already processed, advances the delivery only forward (`sent → delivered`, never back), and writes the event row in that same transaction.

**Fan out.** The outbox relay publishes event rows to the Redis channel `user:{id}`. Only the API instance holding that user's stream is subscribed, so fan-out cost follows active users, not total users.

**Deliver to the browser.** One tab per browser holds the SSE stream — elected with the Web Locks API — and rebroadcasts events to the other tabs on a `BroadcastChannel`. Each event carries its sequence number as the SSE `id`. On reconnect the browser sends `Last-Event-ID` and the API replays newer rows from PostgreSQL before switching to live, so a gap is impossible as long as the events are retained (7 days).

**Apply.** The query cache merges events by entity ID: an inbox item is inserted only if it isn't already there; a delivery update patches `['notification', id]` only if its `updated_at` is newer. The unread badge applies increments immediately, but a refetch of `['unread']` replaces the value, and its `as_of_event_id` tells the client which pending increments to drop.

| Approach | Verdict |
|----------|---------|
| ✅ Event rows in the same transaction + relay + SSE with resume | No phantom states, no gaps, one connection per browser |
| ❌ Webhook receiver publishes to pub/sub directly | A crash between the write and the publish loses the update |
| ❌ WebSocket per tab | Rebuilds resume ourselves and multiplies connections by tabs |
| ❌ Polling every few seconds | Misses the 2-second target or floods the API |

"What I give up: an event table to retain and prune, and a leader election in the browser. I'd keep both — they're what make the badge trustworthy."

---

## 📈 Failures & Scale (2 min)

| Failure | What the operator sees | What the recipient sees | Mitigation |
|---------|------------------------|-------------------------|------------|
| RabbitMQ down | Sends still `202`; timelines stay "queued" | Late notifications | Outbox absorbs; relay retries; outbox-lag alert |
| Email provider down | "Retrying in 40 s", then "Failed" after the budget | Late or missing email; push unaffected | Circuit breaker, failover provider, dead-letter replay |
| Redis down | Sends fail with `503` (no idempotency); live updates pause | Badge stops updating; inbox still loads | Preferences from PostgreSQL; streams resume from `Last-Event-ID` |
| Stream drops | "Reconnecting…" after 10 s | Nothing missed after reconnect | `EventSource` retry + replay |
| Two devices edit preferences | "This setting changed on another device" | Settings never silently reverted | `If-Match` → `412` |

**What breaks first as we grow:** SMS throughput and cost (provider token buckets and hard per-user caps), concurrent SSE connections (dedicated stream gateways once API instances hold more than ~50K each), and history storage (age out after 30 days).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Send safety | Client key per draft + stored response | Disabled button, body hash | Retries can't duplicate; intentional repeats still possible |
| Send feedback | `202` with status, reason, `deliver_at` | Optimistic "Sent!" | The server decides; the UI explains |
| Accept → delivery | Transactional outbox | API publishes to the queue | No lost notifications; API independent of the broker |
| Quiet hours | Wall-clock + IANA zone, evaluated server-side | UTC times or browser evaluation | Correct across DST and travel |
| Live updates | Event rows → relay → Redis → SSE with resume | Direct publish, WebSocket per tab, polling | No phantom states, no gaps, one connection per browser |
| Client state | TanStack Query merging events by ID | Zustand copies of server data | One source of truth for badge and list |

"With more time: digests for low-priority social notifications, per-category snooze in the preference center, and a dead-letter replay screen in the console that resends through the same idempotent path."

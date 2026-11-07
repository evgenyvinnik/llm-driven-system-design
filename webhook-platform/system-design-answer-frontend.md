# Webhook Platform — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Users → Delivery model → Architecture → State → Live updates → Screens → Deep dives → Traces → Wrap-up*

> "The backend signs and sends HTTP notifications to URLs our customers register, retries them with backoff and keeps every attempt. The console is where a customer answers one question at 2 a.m.: *did you send it, and what did my server say?* The hard part isn't rendering tables. It's telling the truth about a system that delivers at least once. A retry isn't a new event, a lost acknowledgment means 'outcome unknown', not 'failed', and a replay must not make the receiver apply something twice. Three ideas carry the answer. PostgreSQL is the truth, and the console polls it through the same org-scoped endpoints it loaded from. Events, deliveries and attempts are three different things on screen, never blurred into one status. And every action (replay, rotate, disable, toggle) waits for the server, because the server can say no."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Users, requirements, delivery model | ~7 min | Three surfaces; the five delivery states the UI must explain |
| Architecture and state | ~6 min | Per-page polled server state, two tiny global stores |
| Screens | ~5 min | Endpoints, delivery detail, event log, receiver, ops |
| Deep dives | ~15 min | Polling vs push, the attempt timeline, replay UX |
| Traces and follow-ups | ~9 min | Lost ack, dead endpoint, ordering, replay, failure classes |
| Wrap-up | ~3 min | Scale limits and what I'd build next |

---

## 🎯 Requirements (~4 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who uses the console? | Surfaces and permissions | Customer developers per org; platform operators see aggregates only |
| How live must delivery state be? | Push vs poll | A few seconds is fine; this is a debugging tool, not an alarm panel |
| How much history? | Pagination, retention | 30 days searchable; a hot endpoint can have millions of deliveries |
| Do we guarantee order or exactly-once? | What the UI may promise | Neither. At-least-once, receivers dedupe by event id; optional per-key sequence numbers |
| Can customers resend? | Replay semantics | Yes: one delivery, or "all failed since T", always with the same event id |
| Is there a receiver to test against? | Demo and debugging | A bundled mock receiver with fault toggles, scoped to the caller's own paths |

### Users and surfaces

| User | Needs | Constraint |
|------|-------|------------|
| Customer developer | Register endpoints, see health, inspect every attempt, replay, rotate secrets, get told when an endpoint is disabled | Must never see another org's endpoints, payloads or receiver traffic |
| Same developer, testing | Make the mock receiver fail on purpose (500, slow, drop ack, 429, 410) and watch the platform react | Toggles affect only their own paths |
| Platform operator | Queue depth, outbox lag, in-flight per endpoint, success rate per org | Aggregates only, no payloads |

### Functional requirements

1. Endpoints list with health: status, 1 h success rate, p95, in flight against the limit, waiting and failed counts, last success.
2. Endpoint detail: health tiles, settings (event filter, concurrency), signing secret with rotation, bulk replay, delivery log with state filters.
3. Delivery detail: current state, retry window, the full attempt timeline, the exact payload, single replay.
4. Event log: immutable events with per-event delivery counts, a test-event form that uses the real idempotent emit API.
5. Notifications when the platform disables an endpoint, with an unread badge in the nav.
6. Mock receiver page: fault toggles per path and a log of what the "customer server" saw, with duplicates and stale updates flagged.
7. Operator overview.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Freshness | Delivery state visible within ~1.5-3 s | Short polling intervals on detail pages |
| Honesty | Never imply exactly-once, ordering or success that didn't happen | Distinct labels for retry, lost, superseded, replay |
| Tenant isolation | Zero cross-org data in any response | Scoping on the server; the UI filters nothing for security |
| History scale | 30 days, millions of rows for a hot endpoint | Keyset pagination; virtualize long pages |
| Accessibility | Status never by colour alone; keyboard reachable | Every chip and outcome carries a word |

### UI load estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Orgs / endpoints | ~100k / ~300k | From the architecture's capacity plan |
| Concurrent console tabs | ~5,000 at peak | Most customers open the console only when debugging |
| Requests per visible tab | ~1/s | Endpoint page polls two resources every 2 s; delivery page every 1.5 s; badge every 5 s |
| Console read load | ~5,000 req/s | Trivial next to 45k deliveries/s, *if* each poll is cheap |
| Attempts for a hot endpoint | ~18M per hour at 5k events/s | Why health stats can't be computed per poll at scale |

> "The load number alone looks harmless. The trap is what each poll computes: a 1-hour success rate and p95 over a hot endpoint's attempts is far too expensive to run every two seconds per tab. That's where I'd expect the console to break first, and I'll come back to it."

---

## 🔄 The Delivery Model the UI Has to Explain (~3 min)

I keep the backend light, but the UI's states only make sense with three facts:

- **Intake is one transaction.** The event, one delivery per matching active endpoint, and one outbox row per delivery commit together. The publisher turns outbox rows into RabbitMQ tickets, which are pointers, not payloads.
- **Retries wait in PostgreSQL.** A failed attempt sets `next_attempt_at` with full-jitter backoff (production: 30 s base, 6 h cap, 3-day window from the first attempt; locally 1 s, 20 s and 180 s). A scheduler re-queues due work. That's why the console can say "next attempt in 37 s": it's a column, not a message hidden in a broker.
- **Each endpoint has its own in-flight limit** across the fleet. A worker that can't get a slot parks the delivery back in the database. After 5 consecutive failures the limit drops to 1 ("probe mode").

```
                       replay: same delivery, same event id, endpoint must be active
          ┌───────────────────────────────────────────────────────────────────────┐
          ▼                                                                       │
     ┌─────────┐   worker claims    ┌───────────┐    2xx      ┌───────────┐       │
     │ queued  │───────────────────▶│ in_flight │────────────▶│ delivered │───────┤
     └─────────┘                    └─────┬─────┘             └───────────┘       │
          ▲                               │ 5xx · 408 · 429 · timeout · reset ·   │
          │ scheduler: due and            │ DNS  (or no free slot → parked,       │
          │ endpoint has spare capacity   ▼  which is not an attempt)             │
          │                         ┌───────────┐                                 │
          └─────────────────────────│ scheduled │                                 │
                                    └─────┬─────┘                                 │
          410 · 3xx · other 4xx ·         │ next retry would pass the window      │
          blocked URL, straight from      ▼                                       │
          in_flight ───────────────▶┌───────────┐                                 │
                                    │  failed   │─────────────────────────────────┘
                                    └───────────┘
```

| Delivery state | Chip text | What else the UI shows |
|----------------|-----------|------------------------|
| queued | Queued | Waiting for a worker |
| in_flight | In flight | A request is open right now |
| scheduled | Retry scheduled | "Next attempt in 37 s", last status code and error class |
| delivered | Delivered | Delivery time; "replayed ×N" if replayed |
| failed | Failed | Why it stopped: window exhausted, 410, rejected 4xx, endpoint disabled |

---

## 🏗️ High-Level Architecture (~3 min)

```
┌──────────────────────── Browser (React 19 + TanStack Router) ─────────────────────────┐
│  Routes: /endpoints  /endpoints/$endpointId  /events  /events/$eventId                │
│          /deliveries/$deliveryId  /receiver  /notifications  /ops  /login             │
│                                                                                       │
│  ┌──────────────────┐   ┌───────────────────────┐   ┌──────────────────────────────┐  │
│  │ auth store       │   │ notification store    │   │ usePoll(fetcher, interval)   │  │
│  │ user, role, org  │   │ unread count (5 s)    │   │ one per resource per page,   │  │
│  └──────────────────┘   └───────────┬───────────┘   │ skips ticks in hidden tabs   │  │
│                                     │               └──────────────┬───────────────┘  │
│                         typed API client: errors carry the server's code              │
└─────────────────────────────────────┬──────────────────────────────┬──────────────────┘
                                      │ REST + session cookie        │
                                      ▼                              ▼
                ┌──────────────────────────────────────────────────────────┐
                │ Console API (N, stateless): every query scoped by the    │
                │ session's org · operator routes role-checked             │
                └──────────────┬─────────────────────────────┬─────────────┘
                               ▼                             ▼
                ┌──────────────────────────┐   ┌──────────────────────────────┐
                │ PostgreSQL (truth):      │   │ Mock receiver proxy:         │
                │ endpoints · events ·     │   │ only the caller's own        │
                │ deliveries · attempts    │   │ /hooks/ paths                │
                └────────────▲─────────────┘   └──────────────────────────────┘
                             │ outbox → tickets → workers record attempts
```

### Route map

| Route | Who | Polls | Purpose |
|-------|-----|-------|---------|
| /login | Anyone | — | Session sign-in; redirects by role afterwards |
| /endpoints | Customer | 3 s | List with health; create endpoint |
| /endpoints/$endpointId | Customer | 2 s (endpoint) + 2 s (deliveries) | Health, settings, secret, bulk replay, delivery log |
| /deliveries/$deliveryId | Customer | 1.5 s | State, window, attempt timeline, payload, replay |
| /events, /events/$eventId | Customer | 2.5 s / 2 s | Event log, send a test event, deliveries per event |
| /receiver | Customer | 1.5 s | Fault toggles and the received log |
| /notifications | Customer | 3 s | Auto-disable notices, mark all read |
| /ops | Operator | 2 s | Fleet health, in-flight per endpoint |

The root route checks the session once on load. Redirects happen in an effect, once per auth change: signed out goes to /login, an operator lands on /ops, a customer on /endpoints.

### Console API used by the UI

```
GET   /api/v1/endpoints                       list with health
GET   /api/v1/endpoints/:id                   detail + health
PATCH /api/v1/endpoints/:id                   event filter, concurrency, description
POST  /api/v1/endpoints/:id/enable|disable    status change, confirmed by the response
POST  /api/v1/endpoints/:id/rotate-secret     new secret; previous signs until the overlap ends
GET   /api/v1/endpoints/:id/secret            reveal on demand
GET   /api/v1/endpoints/:id/deliveries        delivery log, ?state=pending|delivered|failed
POST  /api/v1/endpoints/:id/replay            all failed since T (409 if disabled)
GET   /api/v1/deliveries/:id                  delivery + every attempt + event
POST  /api/v1/deliveries/:id/replay           202; 409 DELIVERY_PENDING or ENDPOINT_DISABLED
GET   /api/v1/events · /api/v1/events/:id     event log (cursor: before=) and fan-out
POST  /api/v1/events                          test emit with Idempotency-Key
GET   /api/v1/notifications · POST .../read-all
GET   /api/v1/receiver · PUT /api/v1/receiver/paths/:name
GET   /api/v1/ops/overview                    operator only
```

---

## 🗂️ State Management (~3 min)

| State | Where | Why |
|-------|-------|-----|
| Session user, role, org name | Zustand auth store | Needed by the root redirect, the shell and role-specific nav |
| Unread notification count | Zustand notification store, refreshed by the shell every 5 s | The badge lives in the nav, outside any page |
| Endpoints, deliveries, attempts, events, receiver log | Per-page `usePoll` | Each page owns its fetch, interval and reload-after-action |
| Revealed secret | Component state in the secret card | Fetched only on an explicit click; never in a global store |
| Filters (delivery state, event type) | Component state, part of the poll's dependencies | Changing a filter refetches immediately |
| Form drafts, "next N requests" counter | Component state | Local and ephemeral |

> "Server data stays out of global state on purpose. The pages don't share much: the list needs a health summary per endpoint, the delivery page needs one delivery with its attempts. A shared normalized cache would make me reconcile two shapes of the same delivery arriving from two polls at different moments. Each page asks the server for a consistent snapshot and replaces what it had. If the console grew, I'd move to TanStack Query with the same intervals and get request de-duplication for free."

The auth store has one subtle rule: a session probe that fails after a login finished doesn't clear the new user. Without it, a slow initial probe could sign someone out half a second after they signed in.

---

## 🖥️ Screens (~5 min)

**Endpoints list.** One row per endpoint: description and URL; event-type chips; a status chip (Active, Paused (429), Failing · probing, Disabled) plus "N failures in a row"; a success bar *with the percentage and attempt count as text*; p95; "in flight / limit"; waiting and failed; last success.

**Endpoint detail**, top to bottom:

- **Header** with status and a Disable or Re-enable button. Banners explain the non-obvious states:
  - disabled: "Disabled 3m ago: retry window exhausted. New events are not sent here and waiting deliveries were marked failed. Fix the receiver, re-enable, then use Replay failed below";
  - paused: "The receiver answered 429; nothing is sent until its Retry-After passes";
  - probing: "7 failures in a row… probing with one request at a time instead of 4".
- **Health tiles:** success (1 h), latency p50/p95, in flight / limit (with "limit 4 after recovery" while probing), waiting / failed with last success.
- **Settings, signing secret, replay failed** side by side.
- **Delivery log** with All / Pending / Delivered / Failed tabs.

**Delivery detail.** The delivery id and state chip, "Event evt_… → URL", and a Replay button. Fact cards: event type, attempts ("replayed ×2"), next attempt or delivery time, and when the retry window ends. Then the attempt timeline (deep dive 2), and the payload under the heading "same bytes on every attempt".

**Event log.** Events with type, ordering key and sequence, and "3 delivered · 1 pending · 1 failed" in words. The test form has a **Retry last (same key)** button that re-sends with the previous Idempotency-Key and reports "got the original event back, no new event". It's a one-click demonstration of producer idempotency.

**Mock receiver.** Tiles: requests, unique events applied, duplicates caught, bad signatures, stale (out of order). One card per path with toggle buttons (Healthy, 500, Slow, Drop ack, 429, 410), "next N requests" or "until changed", slow delay and Retry-After inputs. The received log shows the Webhook-Id, attempt number, signature verdict (including "2 v1 signatures" during rotation), a verdict chip (Applied, Duplicate, Stale (discarded), Bad signature, Not processed) and the HTTP answer, or "none" when the ack was dropped.

**Operations.** Queue ready / unacked, outbox backlog, success rate (5 min), in flight / waiting and the poison queue. A per-org table with attempt and event-to-delivered latency. A per-endpoint table with slots held against the limit and "at limit" in text. The subtitle states the invariant: retries wait in PostgreSQL, so the queue should stay near zero even while an endpoint is down.

### Component breakdown

| Component | Responsibility | Notes |
|-----------|----------------|-------|
| AppShell | Role-based nav, unread badge, sign-out | Badge has an "N unread" label; operators see only Operations |
| EndpointsTable / HealthTiles | Health at a glance | Numbers carry meaning; bars are decoration |
| EndpointHeader | Status, disable / re-enable, explanatory banners | Disabled banner is an alert; paused and probing are status |
| SecretCard | Hint by default, reveal, rotate with overlap | Shows the rotation countdown from the server's expiry time |
| ReplayCard | "Replay all failed since T" | Disabled unless the endpoint is active; reports the server's count |
| DeliveriesTable + DeliveryFilter | Delivery log with state tabs | Shows replay count and ordering key #sequence per row |
| AttemptTimeline | Every attempt, oldest first, planned backoff between | Deep dive 2 |
| SendEventForm | Test emit through the real API | Same-key retry button |
| PathControls / ReceivedTable | Receiver toggles and log | Toggle buttons expose pressed state |
| OpsEndpointsTable | In flight and slots per endpoint across orgs | The isolation story from the operator's side |
| Chips | State, endpoint status, outcome, error class | Every chip pairs colour with a word |

Every component stays well under 150 lines, icons are their own components, and all calls go through one typed client. It turns error bodies into an `ApiError` carrying the server's code, so the UI can branch on `ENDPOINT_DISABLED` or `DELIVERY_PENDING` instead of parsing messages.

---

## 🔧 Deep Dives (~15 min)

### Deep dive 1: Polling every 1.5-3 s vs SSE vs WebSocket for delivery state

**Decision.** Each page polls its own resources with a small `usePoll` hook: fetch on mount, then every 1.5-3 s depending on the page, skipping ticks while the tab is hidden, plus an immediate reload after any action.

**Why it works for this problem.**

- Delivery state changes on the scale of seconds to hours. Production backoff starts at 30 s and caps at 6 h, so a 1.5-3 s lag is invisible against the thing being watched.
- The console is opened to debug, not watched all day, so few tabs are open at once.
- Every refresh goes through the same org-scoped REST endpoint as the first load. Authorization has exactly one code path, already tested, and a missed update costs at most one interval.
- API instances stay stateless: no sticky connections, no per-org pub/sub fan-out, nothing to drain on deploy. Each poll returns a consistent snapshot of the delivery and all its attempts, so rows never update piecemeal.
- Sampling is safe because history is append-only. A poll can skip a state that lasted 0.6 s, but the attempt that caused it is a row and appears on the next poll. Only the instantaneous chip is sampled; the evidence never is.

**Why SSE fails here (specifically).** To push, workers would publish a change event for each attempt they record, at ~9k deliveries/s average and 45k at peak. A fan-out layer would route each one to the tabs of the right org and endpoint. That is a second access path that must filter per viewer, and a bug there leaks one customer's delivery ids to another. On a hot endpoint receiving 5k events/s, the push channel is a firehose, so I'd coalesce invalidations into a refetch every couple of seconds anyway. At that point I've rebuilt polling with more moving parts. I also still need refetch-on-reconnect, because SSE drops events while disconnected.

**Why WebSocket fails here.** The console has nothing to push upstream in real time. Every action is a REST call with typed errors and org checks. A socket would add a second protocol to authorize and keep alive, and buy bidirectionality nobody uses.

**What I give up.**

- Up to one interval of latency.
- Most polls return unchanged data. Production mitigations: ETag/304 on lists, intervals that stretch when nothing changes, and the hidden-tab pause the hook already has.
- If we ever add a live tail of events at high rates, I'd switch that one view to SSE with server-side sampling, and keep polling everywhere else.

### Deep dive 2: Making attempts read truthfully

**Decision.** The delivery (current state, one chip) and its attempts (append-only history, a timeline) are separate on screen. Each attempt row shows:

- attempt number, trigger, start time, status code (or "—" for no response), error class as words, latency;
- the outcome in words, and "next at 14:02:11" when a retry was scheduled;
- worker id, the IP we actually connected to, "2 signatures (rotation overlap)" when relevant;
- the error message and the first 1 KB of the response body.

Between rows the timeline shows the **planned** backoff: "↓ backoff 0.6 s (full jitter)". It is computed as the previous attempt's `next_attempt_at` minus that attempt's end. The actual start time on the next row is also visible, so a gap longer than planned (scheduler tick, endpoint at its limit, probe mode) can be seen rather than hidden.

The vocabulary is chosen so that nothing overclaims:

| Backend fact | Label | Why this wording |
|--------------|-------|------------------|
| outcome = retry | Will retry | The platform hasn't given up |
| outcome = failed | Stopped | We stopped trying; it doesn't assert what the receiver did |
| outcome = lost | Outcome unknown | The worker died mid-request; the receiver may have processed it |
| outcome = superseded | Superseded | A stalled worker's late write was fenced off by a newer lease |
| trigger = recovered | taken over from a lost worker | Explains why the next attempt exists |
| trigger = replay | manual replay | Explains why a delivered event was sent again |
| connection_error, no status | Connection error · — | We never read an answer, which is exactly the lost-ack case |

**Why it works.** The questions customers actually ask map onto rows. "Did you send it?" Yes, three times, and here are the IPs. "Why did it take 40 minutes?" Here's the planned backoff between each attempt. "Why did my server see it twice?" Attempt 1 has no response: a connection error after we sent it. A worker takeover looks like "Outcome unknown" followed by "taken over from a lost worker", which tells the customer to expect a possible duplicate without us claiming one happened.

**Why the alternatives fail.**

- **One status field overwritten by the latest result** destroys the evidence. The delivery says "Delivered", and the customer who saw two side effects has nothing to reconcile against.
- **Listing each retry as its own delivery or event row** makes one event look like four. Customers then conclude the platform duplicated *events*, when it retried *one* event with one id.
- **Labelling a lost attempt "Failed"** is a lie with consequences. A customer told "failed" may resend manually, with a new id from their own side, and double-apply what the receiver already processed.

**What I give up.** Density and text. A dead endpoint's delivery can collect 10-15 attempts over three days. That's still a short list, so no virtualization is needed here, but the page is long. Parks are deliberately *not* attempts, because no bytes left our network. The delivery row carries a park count I'd surface as "waited for a free slot" if customers asked why a first attempt was late.

### Deep dive 3: Replay, rotate and toggles: same event id, confirmed not optimistic

**Decision.** Replay creates a **new attempt on the same delivery for the same event id**. It is never a new event, and the UI never shows its result before the server confirms it. The same rule applies to secret rotation, enable/disable and receiver toggles.

**Why the same event id.** The receiver's dedupe key is `Webhook-Id`, the event id. With the same id, a receiver that already applied the event answers "duplicate" and does nothing; one that never got it applies it once. A "resend as new event" button would mint a fresh id, defeat dedupe, and ship the order twice. The UI states this where the button is ("Re-sends failed deliveries with the same event id"). The event log's count doesn't change after a replay, so the customer can see that no event was created.

**Why confirmed, not optimistic.** The server can refuse, and does in normal use:

- `DELIVERY_PENDING` when the delivery is already queued, in flight or scheduled: a double click, or a colleague replayed it first;
- `ENDPOINT_DISABLED` when the endpoint is off ("Re-enable the endpoint before replaying to it").

An optimistic "Queued" chip would flip back a moment later, and the customer would have to work out whether anything was sent. Instead the button is enabled only in terminal states (Failed, Delivered). The click waits for the 202, reloads, and the next 1.5 s polls show Queued → In flight → Delivered as real transitions. Bulk replay reports the server's count ("Re-queued 37 failed deliveries"), never a number the client computed from what it happened to have loaded.

- **Rotation** can't be optimistic at all. The new secret only exists once the server generates it, and the "previous secret still signs for 1m 52s" countdown comes from the server's expiry time.
- **Disable / re-enable** has server-side effects the client can't predict: waiting deliveries fail, and the failure streak and pause clear.
- **Receiver toggles** are the one place optimism would be harmless. I still confirm, because the server owns the "next 3 requests" counter, which decrements as traffic arrives, and returns 404 for a path that isn't yours.

**Why the alternative fails at scale.** Bulk replay is where optimism would hurt most. One click re-queues up to 10,000 failed deliveries in a single server transaction. Tickets beyond the endpoint's in-flight limit are parked back in PostgreSQL within milliseconds, and the scheduler drains them at that limit, so other customers aren't flooded. A client that optimistically marked rows "Queued" could only touch the 60 it has loaded. Some of those may fall outside the "since" filter or be locked by a colleague's concurrent replay. Only the server knows which rows moved.

**What I give up.** A few hundred milliseconds of no visible change after a click. I'd add a pending state that disables the button while the request is in flight; today a fast double click is caught by the server's 409. Replaying a *delivered* delivery is allowed and is mostly for a receiver restored from backup. A receiver whose dedupe store still has the id will answer "duplicate", which is correct.

---

## 🔐 Multi-tenant Safety in the UI (~2 min)

- **The server scopes, the UI renders.** Every console query filters on the session's org, and another org's id returns 404, so existence doesn't leak. The UI never receives other orgs' rows and then hides them. Hiding is not security.
- **The mock receiver is shared by both demo orgs**, but the proxy filters its log and toggles to the caller's own endpoint paths on the server. A PUT to someone else's path gets "None of your endpoints use that receiver path".
- **Operators** get a role-checked overview of aggregates and endpoint ids, with no payloads. The operator nav shows only Operations, but that is convenience: the API enforces the role.
- **Secrets** show as a hint by default and are fetched only on an explicit Reveal. They are never kept in a store, a URL or local storage.
- **URLs carry opaque ids** (`dlv_…`, `ep_…`), safe to share inside the org because every fetch is re-authorized.

## 📜 Large Delivery Logs (~2 min)

- **Locally:** the delivery log loads the newest 60 rows per state filter; the events API already takes a `before` cursor.
- **At scale:** keyset pagination on (created_at, id), never OFFSET, which degrades on million-row partitions. Only the first page polls. Older pages hold terminal history that rarely changes, so they're fetched once.
- **No rows shifting under the cursor:** when new deliveries arrive while someone is reading page one, I'd show a "12 new deliveries" pill instead of pushing rows down.
- **Virtualize** a page with more than ~200 rows using `@tanstack/react-virtual`. Fixed row heights make it straightforward.
- **Lookup beats scrolling.** "Did you send evt_…?" is an exact search by event id, idempotency key or delivery id, answered from an index.

## ♿ Accessibility (~1 min)

- Every chip pairs colour with a word: Retry scheduled, Failing · probing, Outcome unknown, Duplicate, Stale (discarded). The success bar is hidden from screen readers; the percentage beside it carries the meaning.
- The disabled banner is an alert, so it is announced once, when it appears. Paused and probing banners are polite status. Polling re-renders don't re-announce them, because the element doesn't change.
- Attempts are an ordered list. Delivery filters are tabs with a selected state, receiver toggles expose a pressed state, and the badge reads "3 unread".
- Status codes and ids are monospace text that can be selected and copied, not icons.

## 🛑 Error and Edge States (~1 min)

| Situation | What the user sees | Why |
|-----------|--------------------|-----|
| Poll fails (network, API restart) | Error note; the next tick retries | Degrade, don't freeze |
| Replay while pending | 409 message "This delivery is scheduled; it will be attempted without a replay" | The platform hasn't given up yet |
| Replay on a disabled endpoint | 409 message; bulk button disabled with "Re-enable the endpoint first" | Disabled means "stop" until a human decides |
| Emit with a reused key, different body | 409 `IDEMPOTENCY_KEY_REUSED` | Surfaces a producer bug instead of hiding it |
| Mock receiver not running | 503 "The mock receiver … is not running" | Distinguishes a dead receiver from a dead platform |
| Event matches no endpoint | "no matching endpoint" in the deliveries column | A filter typo is the common cause |
| Receiver missed a rotation | Received log shows "Bad signature"; deliveries fail as Rejected (4xx) | Fail fast; replay after fixing |

---

## 📜 Execution Traces (~5 min)

### Successful trace: a dropped acknowledgment, shown honestly

1. Alice opens Mock receiver and presses **Drop ack** on `/hooks/acme-orders` with "next 1". The PUT returns, the poll reloads, and the chip reads "Drop ack · next 1".
2. On Event log she emits `order.cancelled`. Intake commits the event, two deliveries (orders and audit endpoints) and two outbox rows in one transaction, and returns 201 in ~10 ms. The form says "Emitted 1 event"; the row shows "0 delivered · 2 pending".
3. The publisher sends two tickets. Worker-2 claims the orders delivery, signs `t.body`, and POSTs attempt 1 with `Webhook-Id: evt_…`.
4. The receiver verifies the signature, records the id as processed, applies it, and closes the socket without answering.
5. Worker-2 sees a reset: connection error, retry. Full jitter draws 0.6 s. Fenced on its lease, it inserts attempt 1 and sets the delivery to scheduled.
6. Alice's delivery page (1.5 s poll) may catch **Retry scheduled** for one tick, or skip it, since it lasts only 0.6 s. Either way attempt 1 stays in the timeline: first attempt · — · Connection error · **Will retry** · next at 14:02:11.
7. The scheduler re-queues it, and worker-1 POSTs attempt 2. The receiver finds the id already processed and answers 200 with a body marking it a duplicate. Worker-1 records it delivered and resets the failure streak.
8. Next poll: **Delivered**. The timeline shows "↓ backoff 0.6 s (full jitter)", then attempt 2 · retry · 200 · OK · **Delivered**, with the duplicate body visible.
9. The receiver page shows two rows for one Webhook-Id: Applied with answer "none", then Duplicate with 200. The tiles read "Unique events applied 1 · Duplicates caught 1". The event log still has one event.

The console never says "exactly once". It shows the event delivered twice and applied once, *because the receiver deduped*.

### Failed trace: retry window exhausted → disabled → badge → re-enable → replay

1. Alice sets `/hooks/acme-audit` to **500 · until changed**. An `invoice.refunded` event creates a delivery to it.
2. Attempts fail with jittered waits under a doubling cap, visible as "↓ backoff 1.4 s", "↓ backoff 3.1 s"… The retry window opened at attempt 1: 3 days in production, compressed to seconds locally.
3. After 5 failures in a row the endpoint shows **Failing · probing**, the banner explains one-at-a-time probing, and the tile reads "In flight 1 / 1". Acme's orders endpoint and Globex's endpoints are unaffected; on the ops page only this endpoint runs against a limit of 1.
4. An attempt whose next retry would land past the window marks the delivery **Failed** (outcome Stopped, "Retry window exhausted"). In the same transaction the server sees the endpoint hasn't succeeded once since the window opened. It disables the endpoint, fails its other waiting deliveries, and writes a notification.
5. Within 5 s the shell's badge shows **1** ("1 unread"). The endpoints list chip reads **Disabled**, and the endpoint page shows the alert banner with the reason and next steps.
6. Alice opens the notification, then the delivery, and clicks Replay. The server answers **409 ENDPOINT_DISABLED**, which shows as an error note. Nothing was queued and nothing flipped optimistically. The bulk Replay button is disabled with "Re-enable the endpoint first".
7. She sets the receiver back to Healthy and clicks **Re-enable**. The POST clears the failure streak and pause, and the reload shows Active.
8. **Replay (N failed)** with "failed since one hour ago" returns "Re-queued N failed deliveries". Each delivery moves to queued with a fresh window. Its next attempt is labelled **manual replay** and is delivered with the original event id. The receiver applies each once, since the 500s came before processing. **Mark all read** clears the badge.

---

## ✅ Design Review Checklist (~2 min)

| Question | Frontend-plus-system answer |
|----------|-----------------------------|
| Source of truth; when is a write successful? | PostgreSQL. An emit succeeds at commit (201), an attempt when its row and the delivery's next state commit, and a console action on its 2xx. The UI never shows an action's result before that |
| Client retries after losing the response? | Producer: same Idempotency-Key returns the original event; the console's "Retry last (same key)" shows it. Our retry to a receiver uses the same Webhook-Id. A double-clicked replay gets 409 DELIVERY_PENDING and the page reloads the truth |
| Worker or server fails between two steps? | Outbox covers commit-then-publish. A worker dying mid-attempt shows as "Outcome unknown" plus "taken over from a lost worker", and the receiver may see a duplicate. The console reloads after every action, so it never assumes the previous step finished |
| Which ordering is required? | None globally, and the UI never implies order. Per-key sequence numbers appear as "order_1042 #7" in every log, and the receiver flags "Stale (discarded)". Each poll returns one consistent snapshot of a delivery and its attempts |
| Access with caches, indexes, async jobs? | Every query is scoped by session org (404 for others); the receiver proxy filters to the caller's paths; the operator API is role-checked and payload-free. The UI holds no cross-org data to leak, and secrets are fetched on demand |
| What breaks first at scale, with evidence? | Console: health aggregates per poll (~18M attempts/hour behind one hot endpoint). Platform: PostgreSQL writes, 6.6 rows per delivery (measured), ~60k/s average and ~300k/s at peak. See Scalability |

---

## ❓ Follow-ups

**A receiver processes an event but the ack is lost.** From our side it's a connection error or timeout, so we retry with the same `Webhook-Id`, and the receiver dedupes. The timeline shows attempt 1 with no status code and "Will retry", then attempt 2 delivered. The receiver log shows Applied, then Duplicate. That is at-least-once working as designed, and I'd never claim exactly-once: no queue can put a transaction around an HTTP hop to someone else's server.

**One endpoint is down for six hours. Can it block others?** No.

- Its in-flight limit caps it at N worker slots, and probe mode drops that to 1.
- Excess work is parked in PostgreSQL, not queued, and the scheduler dispatches per endpoint up to spare capacity, so its backlog never sits in front of anyone in the shared queue.
- Measured locally with one endpoint hanging past the timeout: the other org's p50 stayed at 10-13 ms against a 12-15 ms baseline.
- Six hours is well inside the 3-day window, so the endpoint isn't disabled. The UI shows Failing · probing, a climbing waiting count and per-delivery next-attempt times.
- One honest gap: with a 6 h backoff cap, some deliveries' next attempt may be hours away after the receiver recovers. I'd add an endpoint-level "Retry waiting now" action that pulls scheduled deliveries forward, jittered across a short window.

**Do events need ordering, and what does it cost?** We don't guarantee it. Strict per-endpoint FIFO means one request in flight, so throughput is capped at 1/RTT, about 5 events/s at 200 ms. Worse, one poisoned event blocks everything behind it for the whole retry horizon. After a six-hour outage, every later event would wait the full six hours, then drain serially. Instead, producers can pass an ordering key. The platform assigns a gap-free sequence per (org, key), and receivers drop anything lower than what they've applied. The console shows the key and sequence everywhere, and the receiver page shows "Stale (discarded)" when a retry lands after a newer update.

**What does replay mean?** The same delivery and the same event id get a new attempt, labelled "manual replay", with a fresh retry window. No new event is created, so receiver dedupe and any references to the original event stay valid. Replay is refused while the delivery is pending or the endpoint is disabled.

**Permanent vs transient failures.**

- **Transient, retried with backoff:** 5xx, 408, 429 (honouring Retry-After and pausing the whole endpoint), timeouts, connection and DNS errors. The UI shows "Will retry".
- **410 Gone, an invalid URL or a blocked address:** fail, **disable the endpoint** and notify.
- **3xx** (redirects are never followed) and **other 4xx:** permanent *for that delivery only*. The same bytes would get the same answer, so the endpoint stays active and the customer fixes the handler and replays.

The UI shows "Stopped" with the class in words: Gone (410), Rejected (4xx), Redirect (not followed).

---

## 📈 Scalability: What Breaks First (~2 min)

**Console, first: health aggregates computed per poll.** The list and detail pages show a 1-hour success rate and p50/p95 per endpoint. At 5k events/s one endpoint has ~18M attempts an hour, and each visible tab asks again every 2-3 s.

- Workers maintain per-minute rollups (counts and latency histograms) per endpoint, in partitioned tables or ClickHouse, and the console reads rollups.
- Console reads go to replicas, so a customer staring at a hot endpoint can't slow the primary that records attempts. The page shows the snapshot time if replica lag grows.

**Console, second: unpaginated logs and polling every page.** Keyset pagination, polling only page one, virtualizing long pages, and ETag/304 on unchanged responses. At ~5,000 visible tabs, ~5,000 req/s of cheap reads is fine for stateless API instances.

**Platform, first: PostgreSQL writes.** 6.6 row writes per successful delivery, measured with `pg_stat_database` (delivery, outbox insert and mark, claim, result, attempt, plus the shared event row): ~60k/s at the 9k/s average and ~300k/s at peak. Shard by org, replace the outbox mark with CDC, and move attempts to an append-only store. No-op health and API-key writes are already skipped; that took the count from 8.0 to 6.6.

**Platform, second: the scheduler** scanning 300k endpoints per tick. Replace it with a sorted set of endpoints by next due time, and shard schedulers by endpoint hash.

**Platform, third: sockets to slow receivers.** Per-endpoint caps bound the damage, and a separate worker pool for probe-mode endpoints keeps healthy traffic on fast workers.

---

## ⚖️ Trade-offs Summary

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Per-page polling, 1.5-3 s, paused in hidden tabs | One org-scoped auth path; stateless API; consistent snapshots | Up to one interval of lag; many unchanged responses |
| ❌ SSE invalidations from workers | Lower latency | Per-viewer fan-out at 45k changes/s; second access path; still needs coalescing |
| ❌ WebSocket | Bidirectional | Nothing to push upstream; second protocol to authorize |
| ✅ Delivery chip + append-only attempt timeline | Answers "did you send it, and why twice?" | Long pages, more text |
| ❌ Single overwritten status | Compact | Destroys the evidence; hides duplicates |
| ✅ "Outcome unknown" for lost attempts | Honest about at-least-once | Customers must understand dedupe |
| ✅ Replay = same event id, new attempt | Receiver dedupe still works | Can't "force" a re-apply on a deduping receiver |
| ❌ Replay as a new event | Always re-applied | Double side effects; breaks references |
| ✅ Confirmed actions (replay, rotate, disable, toggle) | Never shows a state the server refused | A moment with no visible change |
| ❌ Optimistic actions | Feels instant | Flip-backs on 409; wrong counts for bulk replay |
| ✅ Server-side org scoping, including the receiver proxy | Nothing to leak from the client | Every query carries the org filter |
| ✅ Keyset pagination + virtualization at scale | Constant cost per page | No "jump to page 4,000" |

---

## 📝 Wrap-up (~1 min)

> "The console's job is to make an at-least-once system legible. A customer trusts it when every attempt is there with its status code and the IP we connected to; when a retry, a takeover and a replay each say what they are; when a dropped ack reads as a connection error with no status code, and a lost worker's attempt as 'outcome unknown', never as plain failures; and when nothing they click shows a result the server didn't confirm. Polling keeps one authorization path and costs at most a couple of seconds, which nobody notices against backoffs measured in seconds to hours. Next I'd add precomputed health rollups, keyset pagination with event-id search, a 'retry waiting now' action for recovered endpoints, and a pending state on action buttons."

### How the local implementation compares

The repo's console is Vite + React 19 + TanStack Router file routes + Zustand (auth and the unread count) + Tailwind. A `usePoll` hook drives every page at 1.5-3 s and skips hidden tabs. The shell refreshes the badge every 5 s. A typed client maps error bodies to server codes. Chips pair colour with words throughout. The mock receiver page and its org-filtered proxy let a customer rehearse 500s, slow responses, dropped acks, 429s and 410s against their own endpoints. The operator page shows queue depth, outbox lag and slots held per endpoint. Retry timing is compressed locally (1 s base, 20 s cap, 180 s window), so the whole retry → disabled → re-enable → replay story plays out in about three minutes.

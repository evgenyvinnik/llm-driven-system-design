# 💳 Payment System — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "A payment platform has two front ends with opposite problems. The checkout, where a customer types a card number into a merchant's page, is about safety: the card number must never touch the merchant's code, and a double click or a flaky train connection must never charge twice. The merchant dashboard is about honesty: 'processing', 'partially refunded' and 'refund pending' are real states with money behind them, and the UI must show what the server knows — never what it hopes."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Two surfaces, their performance, accessibility and security targets |
| A — Architecture | 8 min | Two apps, who owns which state, the data layer, three key interactions |
| D — Data model | 5 min | Client entities, money as integers, cache keys |
| I — Interface | 5 min | The API as the client sees it, component contracts |
| O — Optimizations & deep dives | 18 min | Safe checkout, honest money states, live updates, big tables, security |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses each surface and what 'fast' means for them, because the checkout and the dashboard have very different budgets."

### Functional requirements

1. **Checkout element** — embedded in the merchant's checkout page: card number, expiry and CVC fields, a Pay button, a 3-D Secure challenge when the bank asks for one, and clear success, decline and "processing" outcomes.
2. **Payments list** — a merchant searches and filters payments (status, date range, amount, card last four) across hundreds of thousands of rows.
3. **Payment detail** — status timeline, card summary, fee and net amount, refunds, and the ledger entries behind them; capture or void for manually captured payments.
4. **Refunds** — full or partial, with the refundable amount always visible.
5. **Live updates** — a payment that is processing, or a refund that is pending, updates on its own.
6. **Balance and disputes** — the merchant's balance from the ledger, and open chargebacks with their deadlines.

Out of scope: merchant onboarding and identity verification, payout scheduling, and the BI-style analytics product.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Checkout bundle | < 40 KB gzipped, loaded async | It runs on someone else's page; it must not hurt their LCP |
| Checkout responsiveness | INP < 100 ms on Pay; the button reacts on the same frame | A slow-looking Pay button gets clicked twice |
| Dashboard load | LCP < 2.5 s on a mid-range laptop over 4G; initial JS < 200 KB gzipped | Merchants open it many times a day |
| Dashboard responsiveness | INP < 200 ms with 100,000+ payments loaded | Filtering and scrolling must stay smooth |
| Accessibility | WCAG 2.2 AA; full keyboard use; async results announced | Checkout accessibility is a legal requirement in many markets |
| Security | Card numbers never in the merchant's DOM or our dashboard; no secret API keys in any browser | PCI scope and account takeover |
| Correctness | One Pay or Refund click causes at most one charge or refund, across retries, refreshes and double clicks | The single most expensive bug a payments UI can have |

---

## 🏗️ A — Architecture (8 min)

"These are two separate apps on purpose. The **checkout element** is a small framework-free bundle — I'll call it Checkout.js — that the merchant includes; it mounts an iframe served from our domain for the card fields. It must be tiny and must not care which framework the merchant uses. The **dashboard** is an authenticated React SPA with no SEO needs, so I'd render it on the client with route-level code splitting. Server rendering would buy a faster first paint for pages nobody crawls, at the cost of a rendering tier to run; I'd manage the cold start with a small initial bundle and hashed, immutable assets."

```
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │ Dashboard shell · TanStack Router · route guard reads the session (Zustand)              │
 │ URL state: /payments?status=…&cursor=…    /payments/$id    /balance                      │
 └────────────┬────────────────────────────┬────────────────────────────────┬───────────────┘
              │                            │                                │
              ▼                            ▼                                ▼
 ┌─────────────────────────┐    ┌──────────────────────┐    ┌───────────────────────────────┐
 │ /payments               │    │ /balance, /disputes  │    │ /payments/$id                 │
 │ PaymentsTable           │    │ lazy-loaded chunks   │    │ StatusTimeline, LedgerPanel   │
 │ (virtualized rows)      │    └──────────┬───────────┘    │ RefundDialog                  │
 └────────────┬────────────┘               │                └───┬───────────────────┬───────┘
              │ (1) list + filters         │ balance            │ (2) refund        │ draft
              │                            │                    │                   │
              ▼                            ▼                    ▼                   ▼
 ┌────────────────────────────────────────────────────────────────────┐    ┌────────────────┐
 │ TanStack Query cache (server state)                                │    │ sessionStorage │
 │ ['payments', filters] · ['payment', id] · ['balance']              │    │ draft + key    │
 │ dedupe · retry · invalidate after mutations                        │    └────────────────┘
 └──────────────────────────┬─────────────────────────────────────────┘
                            │ fetch / mutate                    ▲
                            │                                   │ (3) setQueryData(event)
                            ▼                                   │
 ┌──────────────────────────────────────────────────┐    ┌──────────────────────────────────┐
 │ API client: fetch + AbortSignal                  │    │ EventSource /v1/events           │
 │ Idempotency-Key · problem+json → typed errors    │    │ resume with Last-Event-ID        │
 └──────────────────────────┬───────────────────────┘    └──────────────────────────────────┘
                            │ HTTPS · session cookie                        ▲
                            │                                               │ payment.* (SSE)
                            ▼                                               │
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │ Payment API via gateway · /v1/payments · /v1/refunds · /v1/events                        │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Browse (1).** `/payments` reads `['payments', filters]` as an infinite query. Status, date range and cursor live in the URL, so back, forward, refresh and shared links all restore the same view.
2. **Refund (2).** `RefundDialog` freezes the draft with an idempotency key in `sessionStorage`, then runs a mutation through the query cache; on success it invalidates the payment and the balance.
3. **Live status (3).** One `EventSource` per tab receives `payment.*` events for the merchant and writes them into the matching cached payment with `setQueryData`, so a payment that was "Processing" flips to "Succeeded" without a reload.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Payments, refunds, balance, ledger entries | TanStack Query | Caching, deduplication, retries, cancellation and invalidation without hand-written loading flags |
| Filters, sort, cursor, selected payment | URL search params | Shareable, bookmarkable, survives reload |
| Session: user, role, merchant | Zustand, filled from `/me` | Every route guard reads it; tiny |
| Refund draft and its idempotency key | Component state mirrored to `sessionStorage` | Must survive a refresh while a refund is in flight |
| Live-connection status | A small Zustand slice | Drives the "Reconnecting…" banner |
| Dialogs, menus, toasts | Local component state | Never shared |

"The rule I'm applying: server data never gets copied into Zustand. Once you copy a payment into a client store you own its staleness and invalidation by hand — and in a payments UI, a stale 'captured' badge on a refunded payment is how a merchant ends up refunding twice."

### Key interaction: paying in the checkout

```
Customer                         Checkout.js                Card iframe                 Payment API
    │                                 │                          │                           │
    │ 1 Pay (button locks)            │                          │                           │
    │────────────────────────────────▶│                          │                           │
    │                                 │ 2 postMessage: tokenize  │                           │
    │                                 │─────────────────────────▶│                           │
    │                                 │                          │ 3 POST /v1/tokens (PAN)   │
    │                                 │                          │──────────────────────────▶│
    │                                 │                          │ 4 tok_… (PAN stays here)  │
    │                                 │                          │◀──────────────────────────│
    │                                 │ 5 postMessage: tok_…     │                           │
    │                                 │◀─────────────────────────│                           │
    │                                 │ 6 POST confirm, key = session                        │
    │                                 │─────────────────────────────────────────────────────▶│
    │                                 │ 7 succeeded | requires_action | 202                  │
    │                                 │◀─────────────────────────────────────────────────────│
    │ 8 receipt, 3DS or "processing"  │                          │                           │
    │◀────────────────────────────────│                          │                           │
    │                                 │                          │                           │
```

"The card number goes from the iframe straight to our tokenization endpoint (step 3); the merchant's page only ever sees a token. The confirm call (step 6) carries an idempotency key tied to the checkout session, so a retry after a network error, or a second click that slips past the locked button, confirms the same payment instead of a new one. Step 7 has three outcomes the UI must design for: success, a 3-D Secure challenge, and `202` — the processor didn't answer and the payment is still processing."

### Key interaction: refunding from the dashboard

```
Merchant             RefundDialog             Query cache               Payment API
    │                      │                       │                         │
    │ 1 Refund 40.00       │                       │                         │
    │─────────────────────▶│                       │                         │
    │                      │ 2 freeze draft + key R                          │
    │                      │ 3 mutate(draft, R)    │                         │
    │                      │──────────────────────▶│                         │
    │                      │                       │ 4 POST /refunds, key R  │
    │                      │                       │────────────────────────▶│
    │                      │                       │ 5 timeout               │
    │                      │                       │◀────────────────────────│
    │                      │                       │ 6 retry, same key R     │
    │                      │                       │────────────────────────▶│
    │                      │                       │ 7 201 (or 200 replay)   │
    │                      │                       │◀────────────────────────│
    │                      │ 8 invalidate queries  │                         │
    │                      │◀──────────────────────│                         │
    │ 9 aria-live: result  │                       │                         │
    │◀─────────────────────│                       │                         │
    │                      │                       │                         │
```

"Refunds are deliberately *not* optimistic. The money isn't returned until the server says so, and a refund can be rejected — another refund may have used up the refundable amount a second earlier. The key `R` is what makes the automatic retry in step 6 safe: the server returns the refund it already created rather than refunding twice."

### Key interaction: a processing payment resolving itself

```
 PaymentDetail                   Query cache       EventSource                  Payment API
       │                              │                 │                            │
       │ 1 useQuery(['payment', id])  │                 │                            │
       │─────────────────────────────▶│                 │                            │
       │ 2 status: pending            │                 │                            │
       │◀─────────────────────────────│                 │                            │
       │                              │                 │ 3 GET /events, last id 41  │
       │                              │                 │───────────────────────────▶│
       │                              │                 │ 4 42: payment.captured     │
       │                              │                 │◀───────────────────────────│
       │                              │ 5 setQueryData  │                            │
       │                              │◀────────────────│                            │
       │ 6 re-render: captured        │                 │                            │
       │◀─────────────────────────────│                 │                            │
       ···················· connection drops, browser reconnects ·····················
       │                              │                 │ 7 GET /events, last id 42  │
       │                              │                 │───────────────────────────▶│
       │                              │                 │ 8 43… or gap: refetch      │
       │                              │                 │◀───────────────────────────│
       │                              │                 │                            │
```

"Server-Sent Events fit this exactly: one-way, low volume, and the browser reconnects on its own and sends `Last-Event-ID`, so the server can replay what I missed. If the gap is too old to replay, the server says so and I invalidate the payment queries instead."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `Payment` | `id`, `status`, `amount`, `currency`, `refundedAmount`, `refundableAmount`, `card {brand, last4}`, `fee`, `net`, `createdAt`, `timeline[]`, `version` | `['payment', id]`, and inside list pages | Updated by events; `staleTime` 30 s |
| `PaymentsPage` | `items: Payment[]`, `nextCursor` | `['payments', {status, from, to, q}]` (infinite) | Invalidated after mutations; patched by events |
| `Refund` | `id`, `paymentId`, `amount`, `status` (`pending`, `succeeded`, `failed`), `createdAt` | `['refunds', paymentId]` | Invalidated after a refund |
| `LedgerEntry` | `journalId`, `account`, `direction`, `amount`, `createdAt` | `['ledger', paymentId]` | Immutable once loaded (the ledger is append-only) |
| `Balance` | `available`, `pending`, `currency`, `asOf` | `['balance']` | Invalidated by refunds and capture events |
| `RefundDraft` | `amount`, `reason`, `idempotencyKey`, `status` | `sessionStorage['refund-draft:{paymentId}']` | Cleared on success |
| `PaymentEvent` | `id`, `type`, `paymentId`, `data` | Not cached; applied to the entities above | Stream |

Three modeling decisions:

- **Money is an integer in minor units plus an ISO currency**, end to end. The client never adds or multiplies floats. User input is parsed into minor units using the currency's exponent — 2 for USD, 0 for JPY, 3 for BHD — and displayed with `Intl.NumberFormat` in the viewer's locale. "Refund 12.50" becomes 1250, not 1249.9999.
- **`refundableAmount` comes from the server.** The client could compute amount minus refunds, but pending refunds, disputes and fee rules all affect it; one source of truth avoids a UI that promises a refund the server will reject.
- **The ledger view is immutable.** Ledger entries never change after they're written, so once loaded I cache them indefinitely — the only append-only data in the app, and the easiest to cache.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
POST /v1/tokens                      card fields → tok_…   (from the checkout iframe only)
POST /v1/checkout/{session}/confirm  Idempotency-Key → succeeded | requires_action | 202 processing
GET  /v1/payments?status&from&to&q&cursor   → {items, next_cursor}
GET  /v1/payments/{id}               → Payment with timeline and refundable amount
POST /v1/payments/{id}/capture       → 200 (also on repeat) | 409 wrong state
POST /v1/payments/{id}/refunds       {amount, reason} + Idempotency-Key → 201 | 200 replay | 422
GET  /v1/events                      SSE stream of payment.* and refund.*; honors Last-Event-ID
GET  /v1/balance                     → {available, pending, as_of}
```

- **`202` is a first-class outcome**, not an error: the UI shows "Processing" and waits for the event.
- **`409` with `Retry-After`** means the same key is still in flight; the client waits and retries with the same key.
- **`422`** arrives as `application/problem+json` with a `code` (`amount_exceeds_refundable`, `idempotency_key_reused`); the API client maps codes to form fields and everything else to a toast.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<CheckoutElement session onResult>` | Mounts the card iframe; emits `succeeded`, `failed(reason)` or `processing(paymentId)`; owns the Pay button state |
| `<PaymentsTable query onSelect>` | Virtualized rows, keyboard navigation, status badges with text, not color alone |
| `<RefundDialog payment onDone>` | Owns the draft lifecycle: validate → freeze → submit → retry with the same key |
| `<StatusTimeline paymentId>` | Renders server events in order; shows "Processing" honestly while pending |
| `useRefund(paymentId)`, `useCapture(paymentId)` | Wrap the mutation, the idempotency key and every cache update, so components never touch query keys |
| `usePaymentEvents()` | One `EventSource` per tab; applies events to the cache; exposes connection status |

---

## 🔧 O — Optimizations & Deep Dives (18 min)

### Deep dive 1: a checkout that never sees the card and never charges twice (6 min)

"Two requirements pull against each other: the checkout must feel native in the merchant's page, yet the merchant's code must never be able to read a card number — if it can, the merchant is in full PCI scope, and one XSS on their site leaks cards."

**The decision: card fields in an iframe from our domain, tokenized inside it.** The merchant's page hosts Checkout.js, which mounts an iframe from our origin for the card fields. The same-origin policy is the security boundary: scripts on the merchant's page cannot read inside the iframe. When the customer presses Pay, Checkout.js asks the iframe (via `postMessage`, checking `event.origin` on both sides) to tokenize; the iframe posts the card to our tokenization endpoint and hands back only a token. The merchant's page confirms the payment with that token.

**Never charging twice.** The Pay button is a small state machine — idle → submitting → (requires action) → succeeded, failed or processing — and it locks on the same frame as the click. But a locked button is not the guarantee; the network is the problem. The confirm call carries an idempotency key derived from the checkout session, so:

1. A timeout followed by an automatic retry confirms the same payment.
2. A refresh mid-payment reloads the session, sees it is already confirmed or processing, and shows that instead of a fresh Pay button.
3. A `202` shows "Your payment is processing — don't pay again", and the page waits for the result rather than re-enabling Pay.

**3-D Secure** opens the bank's challenge in a modal iframe with a focus trap, a visible title and an Escape-to-cancel path; when it completes, the same confirm call (same key) resumes.

| Approach | Verdict |
|----------|---------|
| ✅ Iframe card fields + token, key per checkout session | Card data never in the merchant's DOM; retries and refreshes can't duplicate |
| ❌ Card inputs in the merchant's page, posted to our API | Any script on the merchant's page — an analytics tag, an injected skimmer — can read the card |
| ❌ Full redirect to a hosted payment page | Simplest and safest, but the customer leaves the merchant's site; conversion drops and styling is limited |
| ❌ Disable the button and hope | Stops double clicks, not retries after a timeout or a refresh |

"What I give up: iframes are awkward to style — I expose a small style API for fonts and colors, and resize the iframe from height messages it posts — and every interaction crosses a frame boundary, which adds a few milliseconds and real complexity to focus management and error display. It's the price of keeping card data out of the merchant's reach."

### Deep dive 2: honest money states in the dashboard (5 min)

"The temptation in a dashboard is to make everything optimistic so it feels instant. For money, that's a lie with consequences: if the UI shows 'Refunded' and the server then rejects the refund, the merchant has already told the customer their money is on the way."

**The decision.** I split mutations by what they touch:

| Mutation | Strategy | Why |
|----------|----------|-----|
| Refund, capture, void | Pessimistic: pending state on the button, then the server's answer | Money moves; the server can refuse |
| Notes, tags, metadata | Optimistic with rollback | No money; failures are rare and harmless |
| Status changes from events | Applied as they arrive | The server already decided |

**How the refund form stays honest.** The dialog shows the server's `refundableAmount` and validates against it on the client for fast feedback, but the authoritative check is the server's: if another refund landed a second earlier, the `422 amount_exceeds_refundable` arrives with the new refundable amount, and the form shows it on the amount field. The draft and its idempotency key are frozen at submit and stored in `sessionStorage`; editing the amount creates a new key, because it is a different request.

**The timeline is server events, not client guesses.** "Authorized 14:02 → Captured 14:02 → Refund of $40.00 pending 14:10 → Refund succeeded 14:11" comes from the payment's event history, so it matches what the merchant's webhooks saw.

**"Processing" is a real state.** A payment the processor didn't answer for is shown as "Processing — we're confirming with the card network" with no Refund or Capture actions, and it resolves when the event arrives. The UI never infers success or failure from a timeout.

"What I give up is snappiness: a refund takes 300–800 ms to confirm, during which the button says 'Refunding…'. For an action a merchant takes a few times a day, correctness is worth that half second."

### Deep dive 3: live updates without a socket per widget (3 min)

| Option | Verdict |
|--------|---------|
| ✅ One `EventSource` per tab, `Last-Event-ID` resume | One-way and low volume; the browser reconnects and replays missed events; works through proxies as plain HTTP |
| ⚠️ Polling only pending payments every 5 s | The fallback when SSE is blocked by a corporate proxy; cheap because few payments are pending |
| ❌ WebSocket | Bidirectional and stateful for a stream that only flows one way; heartbeats and resume logic I'd have to build |
| ❌ Polling the whole list | Thousands of requests per merchant per hour to notice a handful of changes |

Events are applied with `setQueryData` to `['payment', id]` and patched into any list page that contains the payment. If the server reports a gap it can't replay, I invalidate payment queries rather than trusting a partial history. Only one tab holds the connection — the others listen on a `BroadcastChannel` — so ten open tabs don't mean ten streams.

### Deep dive 4: a payments table that stays fast at 100,000 rows (2 min)

1. **Server-side filtering with cursor pagination.** Filters live in the URL; `useInfiniteQuery` loads 50 rows per page from `next_cursor`, with `keepPreviousData` so the table doesn't flash empty while new results load. Cursors stay stable when new payments arrive at the top; `OFFSET` pages would shift.
2. **Virtualization.** Only the ~25 visible rows plus overscan are rendered, at a fixed row height. For accessibility I set `aria-rowcount` and `aria-rowindex`, use a roving `tabindex`, and scroll the focused row into view.
3. **Prefetch on intent.** Hovering or focusing a row prefetches `['payment', id]`, so the detail view usually opens from cache.
4. **Exports are server jobs.** "Export last quarter" starts a job and notifies when the file is ready; generating 200,000 rows of CSV in the browser would freeze the tab.

### Deep dive 5: security checklist (2 min)

- **No secret keys in the browser.** The dashboard authenticates with an `HttpOnly`, `SameSite=Lax` session cookie plus a CSRF header on mutations. A secret API key in `localStorage` would hand any XSS full control of the merchant's money.
- **Merchant-supplied strings are attacker-controlled.** Descriptions, metadata and customer emails are rendered as text, never as HTML.
- **Content-Security-Policy** with `script-src 'self'`; the dashboard sets `frame-ancestors 'none'` against clickjacking, while the card iframe allows framing by registered merchant origins only.
- **`postMessage` discipline:** both sides check `event.origin` and accept only expected message types.

---

## 🧯 Loading, Error and Empty States (2 min)

"In a payments UI, the error states are where trust is won or lost, so I design them first."

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| Checkout confirm times out | "Your payment is processing — don't pay again"; no Pay button | `202` or a timeout with the same key; wait for the result |
| Card declined | Inline message on the card field, focus moved there, announced via `aria-live` | Decline codes mapped to plain language ("Your bank declined this card") |
| 3-D Secure abandoned | "Verification was cancelled" with a Try again button | Same session key; retry resumes rather than creating a payment |
| First load of the payments list | Skeleton rows at the real row height | `isPending` on the first page only |
| Live connection lost | "Reconnecting… some statuses may be out of date" | `EventSource` retries; polling fallback for pending payments |
| Refund exceeds refundable | "Only $30.00 can still be refunded" on the amount field | `422` problem code mapped to the field |
| Session expires mid-refund | Login dialog over the form; the draft is still there | Draft and key in `sessionStorage`; resubmitted with the same key after login |
| No payments yet | "No payments yet" with a link to the test-mode guide | The empty state is onboarding |
| Filter matches nothing | "No payments match these filters" and a Clear filters button | An empty table looks like a bug |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Card entry | Iframe from our domain + tokenization | Inputs in the merchant's page | Card data out of the merchant's reach; minimal PCI scope |
| Double-charge protection | Idempotency key per checkout session and per refund draft | Disabled button only | Survives timeouts, retries and refreshes |
| Money mutations | Pessimistic with honest pending states | Optimistic updates | The server can refuse; a wrong "Refunded" has real consequences |
| Server state | TanStack Query; URL for filters | Copying server data into Zustand | Caching and invalidation without bespoke code |
| Live updates | SSE with `Last-Event-ID`, polling fallback | WebSocket or polling everything | One-way stream with built-in resume |
| Money representation | Integer minor units + currency, `Intl.NumberFormat` | Floats | No rounding drift; correct formatting per locale |
| Large lists | Cursor pages + virtualization | Load all and filter | Constant DOM size at 100K rows |

"With more time I'd add a test-mode toggle that switches the whole dashboard to test data with an unmistakable banner, saved views for the payments table, and real-user monitoring of checkout INP segmented by merchant, because a slow merchant page makes our checkout look slow."

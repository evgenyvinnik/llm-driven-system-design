# Apple Pay: frontend system design interview

> “I would design the wallet around a clear promise: the user can tell which
> card and amount they approved, whether the request is still unresolved,
> and what they can safely do next.”

This is a proposed production design for a wallet experience and merchant
checkout integration. The repository is a React HTTP simulator; its limits
are summarized near the end. I would draw one architecture and discuss the
hard interactions rather than implement components on the whiteboard.

## 🧭 Discussion plan

| Topic | Minutes |
|-------|---------|
| Scope and user expectations | 5 |
| Architecture and state ownership | 7 |
| Deep dive: one payment intent | 10 |
| Deep dive: provisioning and privacy | 8 |
| Deep dive: history and recovery | 8 |
| Accessibility, validation, and boundaries | 7 |
| Total | 45 |

## 🎯 Clarify the experience

I would first ask whether we are building the wallet itself or a merchant's
checkout button. They are different products: a merchant should not receive
the user's entire wallet just to request payment for an order.

For this discussion I would cover the wallet's card list and management,
then follow an app/web checkout through an adapter to the supported payment
platform. Native device authentication remains outside ordinary React state.

I would also distinguish a physical contactless interaction from a web
request. A browser animation cannot provide Secure Element behavior. The
payment platform owns credential release; the merchant owns the order and
its authoritative total.

### Main user journeys

- View available cards and identify the device each belongs to.
- Add a card and complete any required issuer verification.
- Review a checkout, choose an eligible card, and authorize the intent.
- Recover a payment outcome after connectivity loss or page reload.
- Suspend a credential and see whether the change has been confirmed.
- Review recent transactions and refund status.

I would leave loyalty passes, transit express modes, subscriptions, and
camera OCR outside the first discussion. Each has a distinct product or
security contract and can be added once the ordinary purchase is clear.

### Quality targets

| Concern | Target or rule |
|---------|----------------|
| Local interaction | Card selection visibly responds within 100 ms |
| Motion | Smooth on representative devices; reduced-motion alternative |
| Payment feedback | Always distinguish authenticating, submitting, pending, and final |
| Owned API | Illustrative p99 under 200 ms, excluding provider/human time |
| Checkout wait | Two-second illustrative deadline before showing pending recovery |
| Accessibility | Complete keyboard and screen-reader path |
| Privacy | Persist only intentionally selected, account-scoped data |

These are proposed targets. I would measure the complete interaction on real
devices instead of inferring responsiveness from a fast server request.

## 🏗️ Architecture and ownership

```
┌──────────────────────────────────────────────────────────────┐
│ Wallet / checkout UI: cards, review, pending, result         │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Interaction controller: fixed intent + operation ID          │
└────────────┬───────────────────────────────────┬─────────────┘
             ▼                                   ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Platform payment API     │        │ Application API          │
│ Authorize credential     │        │ Order / operation status │
└──────────────────────────┘        └──────────────────────────┘
```

The interaction controller coordinates asynchronous steps and owns the
current checkout identity. A card component only renders metadata and
emits selection intent. It does not call the processor independently.

The application API has separate wallet and merchant responsibilities.
They may be separate services, but the frontend needs stable contracts
rather than knowledge of their deployment topology.

I would use React with a router, a small shared interaction store, and a
query layer for server data. Zustand is adequate for the interaction state.
A dedicated query library can manage caching and invalidation as the product
grows; the important choice is assigning each fact one owner.

### State categories

| State | Owner | Lifetime |
|-------|-------|----------|
| Card metadata and lifecycle version | Server, with a client query cache | Account/session scoped |
| Selected card ID | Current wallet or checkout view | Until selection/context changes |
| Order total and currency | Merchant server | Versioned checkout |
| Payment attempt and final outcome | Durable server operation | Survives reloads/retries |
| Active modal, focus, field errors | Local interaction controller | Current interaction |
| PAN/CVV entry, if this surface handles it | Isolated short-lived form | Removed when no longer needed |
| Platform authorization credential | Supported payment adapter | Only its required handoff lifetime |

I would not copy a card object into several stores. Selecting by ID avoids a
stale copy retaining an “active” badge after the server reports suspension.
The server still checks eligibility before accepting work.

A request carries both account context and an interaction generation. A late
response for a previous user or checkout cannot populate the current view.
Aborting obsolete reads saves work; checking their identity protects state
even when cancellation arrives too late.

## 🔧 Deep dive 1: preserve one payment intent

### Decision

I would model checkout as an explicit interaction with a stable operation
identity, rather than several independent loading flags. The critical
trade-off is a little more state management in exchange for understandable
behavior when the network fails.

> “A loading spinner tells me that something is happening. It does not tell
> me whether a request was sent, whether the bank answered, or whether
> another click would create a second purchase.”

### The state transitions I would explain

1. **Review:** the user sees merchant, amount, currency, and selected card.
2. **Authorizing:** the platform requests confirmation for that fixed intent.
3. **Submitting:** the merchant submits one identified payment attempt.
4. **Pending:** the result is not yet known; the operation is recoverable.
5. **Approved or declined:** the authoritative result is displayed.
6. **Cancelled before submission:** no payment request was dispatched.

A changed amount or order version invalidates the previous review. I would
require confirmation of the new total instead of silently using whatever
happens to be in mutable form state when a callback finishes.

The controller blocks a second confirmation while authorization is active.
It also ignores callbacks belonging to a cancelled or superseded interaction.
A modal unmount cleans up visual timers and listeners, but does not pretend
to cancel external work that may already have been submitted.

### Retry identity crosses the frontend/backend boundary

The client creates or obtains an operation ID before the first submission
and retains it across transport retries. The backend binds it to the actor,
checkout version, and request parameters.

A new transport attempt does not imply a new user intent. Generating a fresh
key inside every fetch call would defeat retry protection. Conversely, two
intentional purchases should not share a key merely because their amounts
and merchants happen to match.

The merchant server may create the checkout ID. Client-generated identities
are also possible; the invariant is stability before the first uncertain
request, not which side happened to generate the random value.

### What the user sees after a lost response

| Evidence | UI response |
|----------|-------------|
| Validation failed before dispatch | Keep review fields and show a correction |
| User cancelled before credential handoff | Return to review |
| Provider conclusively declined | Show decline and permitted next steps |
| HTTP timeout after possible submission | Show pending and check the same operation |
| Approved result recovered after reload | Show the same receipt, without resubmission |

A timeout should not produce “Declined—try another card.” The first card
may already have an authorization hold. Switching payment methods is a
separate decision after the merchant resolves or cancels the prior attempt.

I would store a minimal recoverable reference, then verify account access
and server state on reload. A locally remembered “approved” flag is not an
authoritative receipt, and a missing local flag does not prove failure.

### Why simpler alternatives fail

An optimistic success banner can cause a person to believe a purchase
completed before the merchant accepted it. Disabling the Pay button helps
with double-clicks but cannot protect reloads, multiple tabs, or proxy retries.

Treating every exception as a final error also collapses two very different
situations: “nothing was sent” and “a result was lost.” That simplification
moves ambiguity onto the user, who is least able to resolve it.

### Cost of the chosen design

We need a server status endpoint, resumable client state, and tests for late
callbacks. Pending screens are more work than a single red error banner.
That cost directly supports the product's central requirement: accurate
feedback about a potentially irreversible action.

## 🔧 Deep dive 2: provisioning without confusing display and authority

### Decision

I would isolate card enrollment from the general wallet store and make
activation an explicit server-confirmed step. Card metadata can render
quickly; the presence of a visual card never establishes payment eligibility.

A real integration should use the platform/provider's supported credential
handling. If our form must temporarily handle card input, that data stays out
of persistence, URLs, analytics, ordinary logs, and shared application state.

### Enrollment as a resumable interaction

1. Select an eligible target device.
2. Collect the permitted card input through the integration boundary.
3. Start one enrollment operation and display its progress.
4. Follow issuer verification requirements when returned.
5. Await activation and refresh display-safe metadata.
6. Let the user resume a pending enrollment or cancel according to its state.

A server response of “verification required” is normal product state. It
should not appear as a generic failure that encourages the user to enter
the same card repeatedly and create several enrollment attempts.

If the page closes, the pending operation can be recovered by ID. The PAN
and CVV should not be recovered from a general browser cache. The provider
contract determines whether additional input is needed on resume.

### Device identity matters in the UI

A card provisioned on a phone is not automatically a usable credential on a
watch. I would display the device association and offer explicit enrollment
for another device, instead of copying an “active” card row between devices.

Two cards can have the same last four digits. Labels should include enough
context—network, issuer description if available, and device—to make the
choice understandable, while internal identity uses stable IDs.

A lost-device action should name the device and affected cards. Its result
can say “Suspension requested” and later “Suspended,” rather than treating a
local animation as proof that a network authority has enforced the change.

### Trade-off: optimistic metadata versus confirmed lifecycle state

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Immediate local selection, confirmed activation/revocation | Responsive choice with truthful eligibility | More than one visible state |
| ❌ Optimistically mark every lifecycle action complete | Simpler optimistic UI | Can falsely imply a lost credential is blocked |
| ❌ Wait for a round trip before showing local selection | Straightforward synchronization | Unnecessary input latency |

Choosing a card is local intent and can update instantly. Setting a default
is a preference with recoverable error handling. Activating a credential or
confirming revocation is a server/provider fact and needs stronger evidence.

This does not require freezing the whole wallet during enrollment. Each
operation has its own progress and error, so unrelated card browsing remains
responsive.

### Native authentication is a boundary

For a supported payment flow, the device handles secure authorization and
credential release. React should react to the platform's result rather than
collect biometric samples or manufacture a verification token. [Apple's
component responsibilities](https://support.apple.com/guide/security/apple-pay-component-security-sec2561eb018/web).

The cost is dependence on platform capability, user configuration, and
provider integration. The UI must handle unavailable capability and a user
cancellation gracefully. A simulated Face ID button can teach the sequence,
but it cannot satisfy that production boundary.

## 🔧 Deep dive 3: useful history without stale-account surprises

### Decision

I would load recent history in bounded pages and optionally cache a small,
explicitly account-scoped display snapshot. Persistence is a product privacy
decision, not an automatic consequence of using a state library.

A small wallet does not need a complex virtualized card carousel. History
is the list that grows. Start with a recent page; use virtualization when
retained rows and measurements justify it.

### Pagination and rendering

The server returns a cursor based on creation time and a stable ID. New
transactions appearing at the top should not shift an offset and cause a
later page to skip or repeat entries.

The client deduplicates by transaction ID and keeps the server's ordering.
Grouping labels include the year where needed, while group identity uses a
complete date. “September 9” is not a unique key across multiple years.

A virtualized list must preserve keyboard focus, understandable row labels,
and scroll position when a new record arrives. Variable-height decline or
refund descriptions need measurement; hiding offscreen DOM does not reduce
network payload or memory automatically.

### Recovery and freshness

After approval, show the confirmed receipt immediately and refresh history.
If the history projection lags, retain a clearly identified confirmed item
until the projection includes it, then merge by ID.

Suspension notifications can invalidate card queries. Reconnect and foreground
transitions also trigger refreshes. For a small wallet, that is often enough
without maintaining a permanent WebSocket connection just for card metadata.

Cached cards can remain viewable during a network outage with a last-updated
indicator. That does not authorize an offline browser payment. The payment
platform's offline capabilities and risk policy are a separate contract.

### Why an unrestricted persisted store fails

A store that survives logout can show the previous person's transactions
when another account signs in. An old in-flight request can repopulate it
even after an initial clear unless the response is scoped to its account.

Persisting everything also risks including a field that was added later for
internal processing. I would use a small explicit persistence projection,
version it, and remove it on logout or account change.

Browser storage can fail or be evicted. Failure to read a display cache
should fall back to a fetch, not block login or lose a durable payment result.
The server remains the recovery authority.

### What we give up

We accept occasional loading placeholders and explicit refresh behavior.
An asynchronous IndexedDB read is acceptable if richer cached history is
needed; synchronous localStorage is not a universal first-paint guarantee.
For a small metadata snapshot either can work, after measuring actual cost.

## ♿ Accessibility and interaction quality

The payment review names the merchant, total, currency, and card in text.
Color and motion reinforce those facts rather than carrying them alone.
A screen reader should distinguish “authentication completed” from “payment
approved”; those are different milestones.

A modal needs an accessible name, focus placement, a focus trap, escape/cancel
behavior appropriate to its stage, and focus restoration. Status changes
need announcements without repeatedly interrupting the user.

Use actual buttons for actions and labels associated with inputs. Show
errors near their fields and preserve non-sensitive corrections. Respect
reduced motion, high contrast, zoom, and small screens.

I would start with CSS transitions for a simple card list. A gesture library
is justified when the product actually needs drag and spring behavior, with
bundle size and interaction testing treated as costs rather than assumptions.

## 🧪 Validation I would prioritize

- Lose the response after approval, reload, and recover the same receipt.
- Change order amount while platform authorization is pending.
- Close a modal and then deliver a late success callback.
- Sign out and in as another user while a history request is in flight.
- Deliver duplicate/out-of-order operation updates.
- Navigate review, pending state, decline, and recovery using only a keyboard.

Measure input-to-feedback, usable wallet render, long tasks, modal completion,
and unresolved-payment age. Never include PAN, CVV, authorization credentials,
or raw biometric information in interaction analytics.

## ⚖️ Trade-offs to defend

| Choice | Why I choose it | Cost |
|--------|-----------------|------|
| ✅ Explicit payment state; ❌ independent booleans | Preserves uncertain outcomes and callback identity | More transitions to test |
| ✅ Stable operation; ❌ a new key on every retry | Supports recovery of the same intent | Server status contract |
| ✅ Confirm lifecycle; ❌ optimistic revocation completion | Accurate security feedback | Pending state in the UI |
| ✅ Bounded account cache; ❌ persist the whole store | Limits stale data and privacy exposure | Explicit projection/migration |
| ✅ Paged history; ❌ fetch all records | Bounds transfer and rendering work | Cursor and merge logic |

## 🧩 What the repository actually demonstrates

The current app has React, TanStack Router, four Zustand stores, a vertical
CSS-styled card list, one add-card form, a simulated biometric modal, and
history that refetches a growing prefix. Only the session ID is persisted.
There is no gesture library, virtualized list, issuer verification, offline
cache, native payment API, or complete accessible modal implementation.

The API client omits the idempotency header required by card mutations,
biometric initiation, payments, and merchant-session creation. Those browser
flows therefore stop before the protected handlers. The modal's local
“Authenticated” animation precedes server verification; payment recovery
and fixed-intent handling are absent. Logout does not clear the other stores.

I would use these as concrete reasons for the design above, while keeping
source details in the [architecture](./architecture.md). The interview's main
story is how the interface preserves user intent when asynchronous systems
cannot immediately tell us the result.

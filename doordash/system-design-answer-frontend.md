# DoorDash (Food Delivery) — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

---

## 📋 Opening Statement

"There isn't one frontend here — there are three, and they disagree about almost everything. The customer app is a browse-and-buy experience that goes quiet after checkout and then becomes a live tracker. The restaurant app is a single screen someone glances at across a hot kitchen. The driver app runs in a pocket, on cellular, while its user is driving.

They share a domain and a WebSocket, and almost nothing else — different session lengths, different failure tolerances, different definitions of 'fast'.

I'll focus on the three problems that decide whether this works: keeping a cart correct when prices and availability change underneath it, tracking an order in real time without lying to the customer when the connection drops, and building a driver client that assumes the network is unreliable rather than treating that as an error case."

---

## 🎯 Requirements

### Functional

| Surface | Must do |
|---------|---------|
| **Customer** | Browse restaurants, build a cart, check out, track the order live |
| **Restaurant** | See incoming orders immediately, advance them through preparation states |
| **Driver** | Receive offers, accept, navigate, stream location, mark delivered |

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| New-order visibility (restaurant) | < 2s, impossible to miss | A missed order is a refund and a lost customer |
| Location update cadence | ~5s while active | Faster drains battery for imperceptible gain |
| Cart correctness | Never charge a stale price | Silent price drift is a trust and chargeback problem |
| Customer tracking staleness | Visible when stale | A frozen map that looks live is worse than an honest "reconnecting" |
| Driver app on poor connectivity | Degrades, never blocks | The driver is moving; the network will drop |

### Non-goals

No in-app payments UI, no chat between parties, no route optimization across multiple orders. Each is a substantial product on its own.

I'd also flag one thing the current build doesn't have and a real deployment would need: **push notifications.** Every surface has a moment where the user isn't looking at the app — a restaurant during prep, a driver between deliveries, a customer who switched tabs — and in-app alerts reach none of them. That's a platform capability rather than a UI decision, but designing around it changes how much the in-app alerting has to carry.

---

## 🏗️ Three Clients, One Event Stream

```
   CUSTOMER              RESTAURANT             DRIVER
   browse → cart         order queue            offer → accept
   checkout              advance status         location stream
   live tracking         (single screen)        mark delivered
        │                     │                      │
        └──────────┬──────────┴──────────┬───────────┘
                   │      WebSocket      │
                   ▼                     ▼
        ┌────────────────────────────────────────┐
        │        API  ·  broadcast(orderId)      │
        └───┬────────────────┬───────────────┬───┘
            │                │               │
       PostgreSQL      Redis GEO set      Kafka
      (order truth)   (driver positions)  (event log,
                                           produce-only)
```

The three clients also differ in a way the diagram doesn't show: **only one of them is ever left unattended.** The customer closes the app, the driver puts the phone away, and the restaurant tablet stays on a wall for twelve hours. That asymmetry drives most of the reliability decisions later in this answer.

**One event stream, three subscriptions.** All three clients listen to the same order channel and filter for what concerns them. The alternative — a per-role socket protocol — means three implementations of reconnection and three chances for the party views to disagree about an order's state.

The design consequence worth stating: **the order status enum is a shared vocabulary, and each client renders its own view of the same value.** `READY_FOR_PICKUP` is a green banner to the driver, a "waiting for courier" line to the customer, and a completed row to the restaurant. Nobody derives their own status; they interpret one.

---

## 🔍 Deep Dive 1: A Cart That Can Go Stale Underneath You (11 minutes)

The cart is the most deceptively hard piece of state in the product, because it's client-owned data about server-owned facts.

### Why it's not just a list

A cart holds item IDs, quantities, and prices. All three can be invalidated by things the customer never sees: a price change, an item going out of stock, or the restaurant closing. And carts persist — someone adds items at 11pm and checks out at noon the next day, by which point the cart describes a world that no longer exists.

**The failure isn't a crash, it's a wrong charge or a phantom order.** A cart holding yesterday's price either charges the wrong amount or fails at checkout with an error the customer can't interpret.

### Options

| Approach | Correctness | Cost |
|----------|-------------|------|
| ❌ Store price in the cart, trust it at checkout | Wrong charges | Simplest; a chargeback generator |
| ❌ Store only IDs, re-price on every render | Always correct | A request per render; cart unusable offline |
| ✅ **Store IDs + last-known price, re-validate at checkout** | Correct where it matters | Needs a reconciliation UI when they differ |
| ✅ Server-owned cart | Always correct | Every quantity tap is a round trip |

### What I'd build

**Client-owned cart, server-validated at the boundary.** The cart lives locally so adding items is instant and works while browsing offline. Displayed prices are labeled as last-known. At checkout, the server re-prices from truth and the client compares.

The interesting part is what happens when they differ. **A silent update is the wrong answer** — a customer who reviewed a total and gets charged more has been deceived, even by two dollars. Equally, dumping them back to an empty cart with "something changed" destroys the purchase.

So the reconciliation is explicit and itemized: this item went up, this one is unavailable, here's the new total, confirm or edit. That's more UI than either alternative and it's the only version that's both correct and completable.

**The client-owned choice also decides persistence.** A cart in `localStorage` survives reloads, which is what customers expect — but it must be **scoped per restaurant and invalidated when the restaurant changes**, or someone returns to a cart of items from a restaurant that's now closed. And it must never persist a price it will silently reuse; the stored price is for display continuity only.

> "The rule I'd apply is that the client can *remember* a price but never *assert* one. Money comes from the server at the moment of the charge, and any difference gets shown rather than resolved quietly."

---

## 🔍 Deep Dive 2: Live Tracking That Doesn't Lie (10 minutes)

After checkout the customer app becomes a tracker, and tracking is where real-time UIs most often mislead.

### The core problem

The customer sees a driver position and an ETA. Both come over WebSocket. When that socket drops — a phone sleeps, a network switches — **the last position stays on screen, frozen, looking exactly like a driver who has stopped moving.** The customer draws a conclusion ("my driver is parked") from an absence of data. That's the failure mode: not a crash, a confident wrong impression.

### What the UI owes the user

| Situation | Naive behavior | What it should do |
|-----------|---------------|-------------------|
| Socket connected, driver moving | Position updates | ✅ Correct |
| Socket dropped | Position freezes, looks live | ⚠️ Mark stale, show last-updated time |
| Reconnected, position jumped | Marker teleports | Interpolate, or show the jump honestly |
| Driver genuinely stopped | Position freezes | Same visual as a dropped socket — **must be distinguishable** |

The last row is the crux: **a stopped driver and a broken connection produce identical pixels.** Only the client can tell them apart, and only if it tracks its own connection state rather than inferring liveness from data arrival.

### The design

Two independent signals, always both visible: **connection state** ("live" vs "reconnecting") and **data age** ("updated 4s ago"). Together they disambiguate. Position alone never implies freshness.

For movement, I'd interpolate between updates arriving every ~5 seconds so the marker glides rather than teleporting — but **interpolation must stop when the data goes stale.** A marker that keeps smoothly gliding on extrapolated positions after the connection dropped is actively fabricating information, which is worse than a frozen one. Animation is a presentation of received data, never a substitute for it.

**ETA deserves the same skepticism.** A countdown that keeps ticking during a dropped connection is a lie that gets worse every second. It should freeze and grey out with the rest of the stale data.

> "My test for any real-time UI is: if the backend went away right now, would the screen start lying? For a tracking map the answer is yes by default, and everything here is about making it no."

---

## 🔍 Deep Dive 3: A Driver Client Where the Network Is Expected to Fail (10 minutes)

The driver app inverts the assumptions the other two make. Its user is moving through varying coverage, the screen is often off, and the phone is doing navigation at the same time.

### Location streaming is the whole battery budget

The app streams position while a delivery is active. Cadence is the dominant power decision:

| Interval | Tracking quality | Battery | Verdict |
|----------|-----------------|---------|---------|
| ❌ 1s | Marginally smoother | Heavy GPS + radio | Imperceptible gain, real cost |
| ✅ **~5s while active** | Smooth with interpolation | Acceptable | Client-side interpolation covers the gaps |
| ✅ Adaptive (slower when stationary) | Same | Better | Motion detection to suppress redundant pings |
| ❌ On-demand only | Poor | Best | Customer sees a stale driver |

**Interpolation on the customer side is what buys the driver's battery.** A 5-second cadence looks like 1-second tracking once the receiving client smooths between points — so the optimization lives in a different app than the cost it saves. That's worth calling out because it's easy to tune each client in isolation and miss the trade.

### Offline is normal, not exceptional

The driver will lose signal mid-delivery. If "mark delivered" requires connectivity, the driver stands in a dead zone unable to complete a finished job.

So state-changing actions are **queued locally and replayed** when the connection returns, with clear pending indication. That immediately requires idempotency: a queued "delivered" that gets replayed twice must not double-fire. Each action carries a client-generated ID, minted when the driver taps — the same pattern as an idempotency key, for the same reason.

**What can't be queued is acceptance.** An offer has a timeout and may be reassigned; accepting one offline and syncing later would assign a driver to an order someone else already took. So accept requires connectivity and says so plainly, while delivery confirmation does not. **Queueability follows from whether the action is contended, not from whether it's convenient.**

### Screen and glanceability

The driver reads this while driving. Large targets, high contrast for sunlight, one primary action per screen, and no interaction requiring precision. The app should also assume it's backgrounded most of the time — which means arrival at a state that needs attention has to survive the app not being in the foreground, pushing this toward notifications rather than in-app banners.

---

## 🧭 Questions I'd Ask First

**"Is the customer app primarily mobile web or a native shell?"** It changes the driver app entirely — background location and push notifications are native capabilities, and a pure web driver client can't reliably stream position with the screen off. I'll design the web version and flag that limit rather than pretend it away.

**"How many orders does a busy restaurant handle concurrently?"** Four and forty are different screens. At four, cards work; at forty, the single-screen constraint breaks and I need grouping by state.

**"Do we need to support order modification after placement?"** It sounds small and it reshapes the state machine, the cart, and every party's view — a customer editing an order the kitchen has started is a coordination problem, not a UI one.

> "The one I'd push hardest on is the first. If the driver client must be web, then location streaming with the screen off is unreliable, and that changes what we can promise the customer about tracking."

---

## 🍳 The Restaurant Screen Is a Different Product

Worth its own section because the constraints are unlike the other two: a tablet on a wall or counter, in a loud kitchen, viewed from a distance, by someone with their hands full.

- **A new order must be unmissable** — sound plus a persistent visual state, not a toast. A toast that auto-dismisses while the cook is plating is a lost order.
- **The screen never navigates.** Single view, orders as cards, state advanced by large buttons. Any flow requiring navigation will be abandoned mid-service.
- **Legibility beats density.** Reading distance is a metre or more; showing twelve orders in small type is worse than four in large type with scrolling.
- **Sound needs an unlock affordance.** Browsers block autoplay audio until a user gesture, so an alert that silently never plays is a real and common failure. The UI must verify audio is armed and say so.

The interesting tension: this screen is the one that most needs to never miss a WebSocket message, and it's the one most likely to be left open for twelve hours on cheap hardware. **Reconnection has to be relentless here**, with an unmistakable disconnected state — a kitchen believing it has no orders when it has six is the worst outcome in the system.

---

## ⏱️ ETA Is a Promise, So Present It Like One

The server computes ETA from travel time, prep time, and traffic multipliers. How the client displays that number is a product decision with real consequences.

**A single precise time invites disappointment.** "Arriving 7:42" is wrong by a minute most of the time, and a customer who reads a precise number treats it as a commitment. A range — "7:40–7:50" — communicates the actual confidence and absorbs normal variance without feeling like a failure.

**Precision should narrow as certainty grows.** Before a driver is assigned, the estimate is mostly guesswork about dispatch; once the driver is en route with a known position, it's a real calculation. Showing the same format throughout implies constant confidence the system doesn't have.

**Never let the ETA run backwards silently.** Estimates worsen — traffic, a slow kitchen. A number that jumps from "10 minutes" to "25 minutes" with no acknowledgement reads as a bug or a lie. A brief explanation ("kitchen is running behind") converts a broken promise into an informed wait, and it costs nothing because the server already knows which component of the estimate changed.

This is the clearest example of a broader point: **the client's job is to represent the server's certainty accurately, not to make it look better than it is.** That's the same principle as marking stale tracking data, applied to a number instead of a map.

---

## 🗄️ State: Ownership Decides Placement

| State | Owner | Home | Note |
|-------|-------|------|------|
| Cart | Client | Local, persisted per restaurant | Prices display-only |
| Restaurant/menu data | Server | Fetched, cached briefly | Availability changes underneath |
| Active order status | Server | WebSocket-pushed, never locally advanced | Single source of truth for all three clients |
| Driver location | Server | Pushed; interpolated locally | Interpolation is presentation, not state |
| Connection status | Client | Store | Drives the honesty signals in Deep Dive 2 |
| Queued driver actions | Client | Persisted queue | Must survive app restart |

**No client ever advances an order's status locally**, not even optimistically. Three parties observe one state machine; a client that guesses at a transition can show the restaurant "picked up" while the driver hasn't arrived. Status is displayed, never predicted.

---

## 🛒 Browsing: Where the Customer Actually Spends Time

Most of a customer's session is browsing, so it deserves attention even though it's the least novel part.

**Filtering belongs in the URL.** Cuisine, sort order, and price band are shareable and back-button-able; a filter set held only in a store means "send me that vegan place list" doesn't work and the back button escapes the results entirely. This is the same argument as elsewhere — state a user would want to share is URL state.

**Search results and the restaurant list are the same component under different queries.** Treating "search" as a separate screen duplicates card rendering, pagination and empty states. One list, different parameters.

**Images dominate perceived performance.** A restaurant list is mostly photography, and three things matter more than any framework choice: explicit dimensions so cards don't reflow as images arrive, lazy loading below the fold, and appropriately sized sources rather than full-resolution originals scaled down in CSS. Layout shift while scrolling a list is the single most-felt performance defect in this kind of app, and none of the fixes involve React.

**Availability has to be honest at the item level.** A restaurant that's open with half its menu unavailable is a worse experience than a closed one, because the customer builds a cart before discovering it. Unavailable items should be visibly unavailable in the list, not rejected at checkout.

---

## ♿ Accessibility Across Three Very Different Contexts

Each surface has a distinct dominant need, which is why a single checklist wouldn't serve them:

- **Customer:** menus are long lists with structure — headings, prices, dietary markers — and screen-reader users navigate by heading. Prices must be in the accessible name of the item, not implied by adjacency.
- **Restaurant:** distance legibility, high contrast, and audio alerts that don't depend on hearing them — a persistent visual state is the accessible equivalent of the chime.
- **Driver:** one-handed reach, huge targets, and never requiring sustained attention. The strongest accessibility feature here is not needing to look at the screen at all.

Status must never be conveyed by color alone in any of the three — order states carry text and shape, because a red-green deficiency in a kitchen shouldn't turn "ready" into "preparing".

---

## 🧪 Testing Three Clients Against One Stream

The valuable tests here simulate the network and the clock, not the clicks.

| Scenario | Simulation | Protects |
|----------|-----------|----------|
| Stale price at checkout | Change price between add-to-cart and submit | The reconciliation flow, not a silent charge |
| Cart survives reload | Persist, reload, re-price | Per-restaurant scoping and invalidation |
| Socket drop during tracking | Kill the connection mid-delivery | Marker marked stale; ETA freezes; no extrapolation |
| Driver goes offline then delivers | Queue the action, restore connectivity | Replay happens once, not twice |
| Duplicate replay | Fire the queued action twice | Client action ID makes it idempotent |
| Restaurant misses nothing | Drop and restore the socket with orders arriving | Missed orders appear on reconnect; disconnected state was visible |
| Audio blocked | Load without a user gesture | UI reports that alerts are not armed |

The last one is easy to overlook and operationally severe — an alert that silently fails is indistinguishable from no orders.

I'd drive all of these from **recorded WebSocket event sequences** rather than a live backend. Replaying a real delivery's event stream — placed, confirmed, preparing, assigned, twenty location pings, delivered — exercises all three clients deterministically, including the interleavings that only happen under load.

---

## 📦 Bundle Strategy Across Three Apps

The three surfaces have opposite tolerances, so a single bundle serves none of them well.

| App | Constraint | Approach |
|-----|-----------|----------|
| Customer | First visit on mobile decides conversion | Route-split; browsing loads without tracking or checkout code |
| Restaurant | Loaded once, runs all day | Size barely matters; reliability does |
| Driver | Cellular, frequently reloaded | Smallest possible; no browsing or authoring code |

**Splitting by role at the route boundary is the whole strategy.** A driver should never download restaurant browsing; a kitchen tablet should never download the cart. Because the three apps share a domain module and nothing else, this split is natural rather than something to engineer around.

The one shared cost worth watching is the WebSocket client and the domain module, which every surface needs. Keeping the domain module free of UI dependencies is what stops it dragging component code into all three bundles.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Cart ownership | ✅ Client-owned, server-validated | ❌ Server cart | Instant interaction; correctness enforced where money changes hands |
| Price drift | ✅ Explicit itemized reconciliation | ❌ Silent re-price | A changed total the customer didn't see is deception |
| Cart persistence | ✅ Per restaurant, invalidated on change | ❌ Global cart | Prevents ordering from a closed restaurant |
| Tracking freshness | ✅ Connection state + data age, both shown | ❌ Position alone | A stopped driver and a dead socket look identical otherwise |
| Marker movement | ✅ Interpolate, stop when stale | ❌ Extrapolate | Continued animation fabricates data |
| Location cadence | ✅ ~5s + client interpolation | ❌ 1s | Battery cost with no perceptible gain |
| Driver offline | ✅ Queue non-contended actions | ❌ Require connectivity | A driver in a dead zone must still complete a delivery |
| Accepting offers | ✅ Requires connectivity | ❌ Queue like other actions | Contended resource; stale accept assigns a taken order |
| Status transitions | ✅ Server-pushed only | ❌ Optimistic | Three observers of one machine must not diverge |
| Restaurant alerts | ✅ Persistent state + sound | ❌ Toast | Auto-dismiss loses orders |

---

## 🧱 Component Boundaries That Earn Their Keep

I'd resist a shared component library across the three apps, with two exceptions.

**Share the domain vocabulary, not the widgets.** Status labels, currency formatting, and the order state machine's allowed transitions belong in one place — they're correctness, and divergence means the driver and the customer describe the same order differently. That's a shared *module*, not a shared component.

**Don't share layout components.** An order card for a kitchen tablet and an order card for a phone have different information hierarchies, different densities, and different touch targets. A single configurable card serving both accumulates a prop for every difference until nobody can predict what it renders. Two components that look similar are cheaper than one that's conditionally everything.

The test I'd apply: **if a change for one surface would require a conditional, it shouldn't be shared.** Formatting money never needs a conditional. Rendering an order card always does.

---

## 🚀 What Breaks First

**Restaurant reconnection, before anything else.** A tablet open for a full service day will drop its socket. If reconnection is silent and imperfect, the kitchen misses orders and doesn't know. This is the highest-severity failure in the system and it's a client-side one.

**Then the customer's restaurant list.** Long lists with images are the classic virtualization case — but the first fix is image loading discipline, not windowing: lazy loading and correct dimensions to prevent layout shift buy more than virtualization at realistic list lengths.

**Then location fan-out.** Every active order pushes positions to at least two clients. Fan-out is a server concern, but the client contributes by not subscribing to orders it isn't showing — a customer with the app open shouldn't receive updates for a completed order.

**Then cart complexity**, as modifiers and options multiply. A cart line stops being an ID and quantity and becomes a configured object, and equality — "is this the same line item?" — gets genuinely hard.

---

## 🔌 One Socket, Three Subscription Patterns

The clients share a transport and use it very differently, which shapes the connection layer.

| Client | Subscribes to | Connection lifetime | Reconnect urgency |
|--------|--------------|--------------------|--------------------|
| Customer | One active order | Minutes, during delivery | Moderate — stale tracking is visible |
| Restaurant | All orders for the store | Hours, all service | **Critical** — silence means missed orders |
| Driver | Their assignment + offers | Whole shift | High — a missed offer is lost income |

Two consequences.

**Subscriptions must be scoped, not global.** A customer receiving every order event for a restaurant is a privacy problem before it's a performance one. The client subscribes to what it's authorized to see, and the server enforces that rather than trusting the subscription request.

**Reconnection must reconcile, not just resume.** Every client needs to re-fetch current state on reconnect, because messages sent while disconnected are gone — a WebSocket has no replay. Resuming the socket without re-fetching leaves the UI showing whatever it had before the drop, silently missing every transition in between. This is the same gap described in Deep Dive 2, and it's why connection state and data freshness are tracked separately: reconnecting is the trigger to distrust local state, not to assume it's fine.

---

## 📝 Summary

Three ideas:

1. **The client may remember prices but never assert them.** Local carts for speed, server pricing for truth, and an explicit reconciliation when they disagree — because a silently corrected total is a trust failure, not a UX detail.
2. **Real-time UIs lie by default.** Frozen data looks like stopped movement, and smooth animation over missing data is fabrication. Connection state and data age must be first-class, visible, and independent of the data itself.
3. **Three clients, three sets of assumptions.** A shared event stream and status vocabulary keeps them consistent; everything above that — persistence, cadence, offline behavior, legibility — is decided per surface, because a kitchen tablet and a phone in a moving car have nothing in common but the order.

# Etsy (Handmade Marketplace) — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

---

## 📋 Opening Statement

"A handmade marketplace looks like any e-commerce frontend and has two properties that change almost every UI decision.

**Inventory is usually one.** Not 'low stock' — one, ever, with no restock. So two buyers racing for the same item means one of them gets an error for something that will never exist again. That turns add-to-cart and checkout from bookkeeping into a concurrency problem the interface has to handle gracefully, because the loser is a real person who just lost a thing they wanted.

**A cart spans sellers but an order cannot.** Three items from three shops become three orders that ship, cancel, and refund independently. The cart is a single mental object to the buyer and splits into several the moment they pay, and the UI has to make that transition feel intentional rather than like something went wrong.

I'll go deep on those two, plus search — because with an unnormalized catalog, an empty result set is usually the interface's fault rather than the inventory's."

---

## 🎯 Requirements

### Functional

1. **Browse and search** across an inconsistently-described catalog
2. **Product pages** with images, variations, seller context
3. **Cart** spanning multiple shops, surviving reloads
4. **Checkout** producing per-seller orders, safe under double-submit
5. **Seller tools** — create a shop, list products, view orders
6. **Favorites and reviews**

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| Search feels responsive | < 300ms perceived | Below this, typing feels like filtering rather than querying |
| Never sell the same item twice | Guaranteed | One-of-a-kind items make this a correctness requirement |
| Cart survives sessions | Days | Handmade purchases involve deliberation |
| Losing a race is explained | Always | "Error" for a gone item is the worst moment in the product |
| Search degradation | Never blank | A storefront that looks empty during a search outage loses all traffic |

### Non-goals

No real payment integration, no messaging between buyer and seller, no shipping-rate calculation. Each is a substantial subsystem and none illuminates the two structural problems above.

---

## 🏗️ Architecture

```
        ┌──────────────────────────────────────────────┐
        │                   Browser                     │
        │                                               │
        │  Browse/Search   Product   Cart   Seller      │
        │       │             │        │        │       │
        │       └─────────────┴────┬───┴────────┘       │
        │                     ┌────▼─────┐              │
        │                     │  Stores  │              │
        │                     │ cart │ ui │              │
        │                     └────┬─────┘              │
        └──────────────────────────┼───────────────────┘
                                   │
                        ┌──────────▼──────────┐
                        │    Express API      │
                        └──┬───────┬───────┬──┘
                           │       │       │
                    PostgreSQL  Elastic  Redis
                    (orders,    (search) (cache,
                     inventory)          sessions)
```

**The frontend's central concern is that two of those stores can disagree.** Elasticsearch is updated from the write path with no change-data-capture, so search results can describe a product that Postgres says is sold. The UI cannot treat a search result as authoritative about availability — a lesson that shapes the product page, the cart, and checkout.

---

## 🔍 Deep Dive 1: When Quantity Is One (12 minutes)

This is the defining problem, and it appears at three separate moments.

### Where the race actually happens

| Moment | What the buyer sees | What can be true |
|--------|--------------------|------------------|
| Browsing search results | "Available" | Sold seconds ago; the index is stale |
| Product page | "Add to cart" | Still available, or gone |
| In cart, before checkout | Sitting in their cart | Someone else is checking out with it right now |
| At checkout | Paying | Another transaction commits first |

**A cart is not a hold.** That's the fact everything follows from, and it's the one buyers don't intuit — an item in a cart *feels* claimed. The interface either corrects that belief or sets the buyer up for the worst experience in the product.

### Options

| Approach | Buyer experience | Cost |
|----------|-----------------|------|
| ❌ No reservation; fail at checkout | Worst case — payment intent, then loss | Simplest |
| ✅ **Reserve on add-to-cart, with a visible timer** | Honest, creates urgency | Inventory held by non-buyers; needs expiry |
| ✅ Reserve at checkout entry only | Short hold, less waste | Race window still exists while browsing the cart |
| ❌ Optimistic UI everywhere | Feels fast | Amplifies the failure — the item appears *more* claimed than it is |

### What I'd build

**A short reservation created at checkout entry, plus honest availability signalling before that.** A hold from add-to-cart sounds friendlier and is worse at scale: carts are abandoned constantly, so held inventory for a one-of-a-kind item means the listing is invisible to serious buyers while someone who forgot about it holds it.

Before checkout the UI's job is to avoid *implying* a claim. Concretely:

- **Re-validate availability when the cart is viewed**, not just at checkout. A cart page loaded from stale data is where the false sense of ownership forms.
- **Never render a countdown or "reserved" language before a reservation exists.** Language creates the expectation; if the system isn't holding the item, the UI must not say it is.
- **Show scarcity truthfully.** "Only one available" is accurate and useful. "Selling fast!" is a manufactured urgency pattern, and in a market where losing means losing forever it's actively hostile.

### Losing the race

When it happens, this is the highest-stakes error state in the product, and generic error handling fails it completely. The buyer needs to know **what** they lost, that it's **permanent**, that they were **not charged**, and **what to do next** — the seller's other work, similar items.

The rest of the cart must survive. Dropping a three-item cart because one item sold is a second, self-inflicted loss.

> "The design principle is that the interface must never be more confident about ownership than the system is. Every 'reserved' badge, every countdown, every optimistic add is a promise — and for one-of-a-kind inventory, a broken promise costs a customer, not a retry."

---

### Where this system actually stands

Worth being precise, because it changes what the frontend must do today. The schema has a `reserved_until` column on cart items, written fifteen minutes ahead for quantity-one products — **and nothing reads it.** No checkout path consults it, no sweeper expires it, no availability query filters on it. The reservation the data model advertises does not exist as behavior. Checkout also validates availability with a plain read before opening its transaction, with no row lock, so two concurrent buyers can both pass and both decrement.

That means the frontend is currently the *only* thing standing between a buyer and a confusing failure, and it should be designed accordingly: no reservation language anywhere, availability re-checked at every meaningful step, and a genuinely good "this sold" experience — because until the backend gap closes, that path will be hit.

I'd flag it as the top priority rather than design around it. **A UI that implies a hold the system doesn't take is the worst of both worlds**, and it's an easy thing to ship by accident when the column exists and looks authoritative.

---

## 🔍 Deep Dive 2: One Cart, Many Orders (10 minutes)

The buyer builds one cart. Checkout produces one order per shop. The interface has to make that split feel deliberate.

### Why it isn't cosmetic

Each seller-order ships separately, has its own tracking, can be cancelled independently, and may partially fail — one seller's item is gone while the other two are fine. A UI presenting checkout as a single atomic purchase sets an expectation the system can't meet.

### Where to reveal the split

| Point | Effect |
|-------|--------|
| ❌ Only after purchase | Buyer expects one shipment, gets three; feels like an error |
| ✅ **In the cart, grouped by shop** | Split is established before any money is involved |
| ✅ Reinforced at checkout with per-shop totals | Shipping differences become comprehensible |
| ✅ Confirmation shows N orders | Matches what they'll track |

**Grouping the cart by shop is the single highest-value decision here**, and it costs nothing. It makes shipping-per-seller obvious, makes partial availability failures local to a group, and means the order confirmation isn't a surprise.

### Partial failure at checkout

If one shop's item is gone at the moment of purchase, the options are all-or-nothing or partial success. **Partial success is right, and it must be presented carefully:** succeeded orders are confirmed and charged, the failed group is explained and not charged, and the summary leads with what *did* work. Leading with the failure makes a mostly-successful purchase read as a failed one.

The alternative — failing everything — is worse for a marketplace, because the buyer's other two sellers lose sales over an unrelated third party's inventory.

> "I'd want the word 'orders', plural, to appear before checkout rather than after. Every confusion downstream — 'where's the rest of my package', 'why three tracking numbers' — comes from a cart that presented itself as one purchase."

---

## 🔍 Deep Dive 3: Search Where Nobody Uses the Same Words (10 minutes)

With no canonical vocabulary, one product is a "handmade leather billfold", an "artisan cowhide wallet", or a "hand-made purse". Exact matching returns nothing, and **a buyer who sees zero results concludes the marketplace is empty rather than that their phrasing was unusual.**

The backend addresses this with synonym expansion and fuzzy matching. The frontend's job is everything around that.

### Zero results is a design problem, not an empty state

A blank "No results for 'billfold'" is the worst outcome, because the marketplace almost certainly has matching items. The page should:

- **Say what was searched and how it was interpreted** — if synonyms expanded the query, showing that teaches the buyer the catalog's vocabulary.
- **Always offer a path** — related categories, popular items, relaxed filters. Never a dead end.
- **Distinguish "no matches" from "search is down."** The backend returns a fallback flag when Elasticsearch is unavailable and results come from a degraded path. **Rendering degraded results as if they were normal is dishonest**; rendering an empty page during an outage is catastrophic. The UI should say results are limited and offer browsing.

### Making search feel fast

Perceived speed comes from three things, none of which is server latency:

**Debounce, don't throttle.** A user typing "handmade wallet" produces fifteen keystrokes; querying each is fourteen wasted round trips whose results arrive out of order. Debouncing at ~250ms fires once when they pause.

**Cancel superseded requests.** Without cancellation, a slow response for "hand" can arrive after a fast one for "handmade" and overwrite it — the buyer sees results for a prefix they've moved past. Every search request is cancelled when a newer one starts, and late responses are dropped by comparing against the current query.

**Keep the previous results visible while loading.** Blanking to a spinner on every keystroke makes a fast search feel unstable. Dimming the old results and showing a subtle indicator reads as faster despite identical latency.

### Filters belong in the URL

Category, price band and sort are shareable, back-navigable state. A buyer who filters, opens a product, and hits back must land on their filtered results — the most common navigation in the product. Store-held filters break that and produce the single most-reported e-commerce complaint.

---

## 🧭 Questions I'd Ask First

**"How long does a reservation last, and who decides?"** It's the hinge of Deep Dive 1. Fifteen minutes is generous to a deliberating buyer and hostile to the next one; two minutes is the reverse. The answer also determines whether the countdown is a prominent element or a quiet one.

**"Can a seller edit a listing that's in someone's cart?"** If yes — price, description, photos — the cart holds a snapshot of something that no longer exists, and the reconciliation UI has to cover more than availability.

**"Is search or browse the primary entry point?"** Search-first justifies investing in query understanding and result quality. Browse-first shifts the investment to category structure and recommendation. They pull in different directions and both are expensive.

> "I'd ask the reservation question first, because it's the one where a wrong default is invisible in testing and obvious in the metrics — held inventory that nobody buys just looks like slow sales."

---

## 🏪 The Seller Side Is a Different Kind of Frontend

Worth its own section, because seller tooling is where marketplaces usually under-invest and it's a genuinely different problem.

**Listing creation is a long form with media upload**, which makes draft persistence non-negotiable. A seller who photographs an item, writes a description, and loses it to a reload or a failed upload may not do it again. Drafts belong in local storage from the first keystroke, independent of any server round trip.

**Image upload needs per-file state.** Uploading eight photos where one fails must not discard the other seven — each needs its own progress, retry and removal. A single aggregate "uploading…" state is the version that loses work.

**Validation should be sympathetic to the domain.** Requiring alt text is right (see accessibility below), but a seller listing their first item shouldn't face a wall of rejections on submit. Field-level, as-you-go validation with clear reasons is the difference between a completed listing and an abandoned one.

The asymmetry worth naming: **buyers browse constantly and sellers list rarely.** So the buyer surfaces get optimized for repeat, fast interaction, and the seller surfaces get optimized for one-time, high-stakes completion. Those are different design targets, and treating the seller area as "the same app with more forms" is how it ends up worse than it needs to be.

---

## 🖼️ Images Are the Product

For handmade goods the photograph *is* the merchandise, which changes the usual performance calculus.

**Compressing aggressively is the wrong instinct.** A buyer evaluating craftsmanship needs detail; over-compressed thumbnails suppress conversion in a way that no Lighthouse score will reveal. The right approach is responsive sources — small for grids, large on demand for the product page — rather than one degraded compromise.

Three things matter more than any framework choice:

- **Explicit dimensions on every image**, so a grid doesn't reflow as photos load. Layout shift while scrolling is the most-felt defect in a browse experience.
- **Lazy load below the fold**, eager for the product page's primary image, which is the one being evaluated.
- **A real placeholder** — dominant color or blur — rather than a grey box, because grid cards read as broken before their images arrive.

---

## 🔎 Product Detail: The Page That Has to Be Honest

The product page carries the most consequential decision in the product, and it's where the two structural problems meet.

**Availability is re-checked here, always.** A buyer arriving from a search grid may be looking at an index snapshot minutes old. The product page is the last cheap opportunity to correct that before they invest emotional effort, so it fetches from the source of truth rather than reusing the grid's data.

**Variations complicate scarcity.** A listing with three colors and quantity one per color isn't "one available" — it's one available *per variant*, and selecting a sold-out variant must change the availability message, not just disable a swatch. Getting this wrong produces the worst version of the race: a buyer who selected an option they could never have bought.

**The seller is part of the product.** For handmade goods, buyers evaluate the maker as much as the item — shop, other listings, reviews, response history. That's not decoration; it's the substitute for brand trust that a mass-market catalog gets for free. Treating shop context as a footer link under-serves the actual decision being made.

**Reviews need honest aggregation.** With low review counts per item, a single five-star review shows as "5.0" and means almost nothing. Displaying the count with equal prominence — and resisting the urge to show a rating at all below a threshold — is more useful than a confident number derived from one opinion.

---

## 🗄️ State: What the Client May Own

| State | Owner | Home | Note |
|-------|-------|------|------|
| Cart contents | Client | Persisted locally | Convenience, not a claim on inventory |
| Prices and availability | Server | Re-validated on cart view and checkout | Client may display, never assert |
| Search query, filters, page | URL | — | Shareable and back-navigable |
| Session / auth | Server | Cookie | Marketplace needs immediate revocation |
| Favorites | Server | Fetched | Cross-device by definition |
| Seller drafts | Client | Local until submit | Long forms; losing them to a reload is unacceptable |

**The cart is the interesting row.** Local ownership makes it instant and durable across sessions, which suits deliberate purchasing. But it must store references and last-known display data — never authoritative price or availability. That's the same rule as any commerce client, and here it's load-bearing because the underlying facts change permanently rather than temporarily.

---

## 💰 Money Is Not a Number

A real defect from this codebase, and the most transferable frontend lesson in it.

Postgres `DECIMAL` columns arrive through `pg` as **strings**, deliberately — coercing them to JavaScript numbers would introduce IEEE-754 precision loss on money. The frontend treated them as numbers, so `price.toFixed(2)` threw `TypeError: price.toFixed is not a function` at roughly twenty-five call sites, blanking every component that rendered a price.

Three things this teaches:

**The type annotation was a claim, not a check.** The interface said `price: number`. The API returned a string. Both sides compiled. This is the same class of failure as any client/server contract mismatch — types are erased at runtime, so a declared shape is only as good as what validates it at the boundary.

**Money should never be a bare primitive in the client.** Passing a raw value around and formatting at each call site means twenty-five places to get it wrong. One `formatPrice` helper that accepts string-or-number and coerces safely turns a systemic bug into a single function — and it's the kind of thing worth building before the first price renders, not after.

**The blast radius was multiplied by rendering strategy.** A throw during render doesn't degrade one line of text; it takes out the component and, without a scoped boundary, the page. A missing price should render as a dash, not remove the product from the catalog.

> "The deeper point is that the backend made a correct decision — strings preserve decimal precision — and the frontend inherited a consequence nobody wrote down. That's what an API contract is for, and a shared type that nothing enforces isn't one."

---

## ♿ Accessibility in a Visual Marketplace

A catalog whose value is photographic is exactly where accessibility is most often abandoned.

- **Alt text is seller-supplied and therefore unreliable.** The UI should require it at listing time with a clear explanation, because a marketplace where products are unlabeled is unusable with a screen reader. This is a design decision in the *seller* flow that determines buyer accessibility.
- **Price, availability and shop name must be in the accessible name** of a card, not implied by visual adjacency.
- **Filter changes must be announced** — a screen-reader user who applies a filter and hears nothing has no idea whether it worked.
- **"Only one available" must not be color alone.** Scarcity is the most decision-relevant fact on the page.

---

## 🧪 Testing the Race and the Split

The valuable tests here are the ones that reproduce a concurrent buyer, which never happens in manual testing.

| Scenario | Simulation | Protects |
|----------|-----------|----------|
| Item sold while in cart | Mark unavailable between cart load and checkout | The explanation flow, and that the rest of the cart survives |
| Item sold during payment | Fail one seller-group at submit | Partial success, correct charge, honest summary |
| Double-submit checkout | Fire submit twice | Idempotency; one set of orders |
| Search out-of-order responses | Resolve an older query after a newer one | Cancellation — results match the current input |
| Degraded search | Return the fallback flag | UI says results are limited rather than pretending |
| Stale search availability | Index says available, product page says sold | Product page re-checks rather than trusting the grid |
| Filter back-navigation | Filter, open product, go back | Filters and scroll position restored |

The first two are the highest-value tests in the codebase, because they exercise the moment where the product is most likely to lose a customer and where the code is least likely to have been exercised by hand.

I'd write these against **fixtures rather than a live Elasticsearch**, for the same reason as elsewhere: a test that needs a search cluster is a test that gets skipped.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Inventory holds | ✅ Reserve at checkout entry | ❌ Reserve on add-to-cart | Abandoned carts would hide one-of-a-kind items from real buyers |
| Cart semantics | ✅ Explicitly not a claim | ❌ "Reserved" language | The UI must not be more confident than the system |
| Cart ownership | ✅ Client, re-validated | ❌ Server cart | Instant edits; correctness enforced where it matters |
| Multi-seller | ✅ Grouped by shop in cart | ❌ Reveal after purchase | Sets expectations before money is involved |
| Partial failure | ✅ Partial success, lead with what worked | ❌ Fail everything | Other sellers shouldn't lose sales to an unrelated item |
| Search input | ✅ Debounce + cancel superseded | ❌ Query per keystroke | Out-of-order responses show results for a stale prefix |
| Loading | ✅ Keep previous results, dim | ❌ Spinner | Blanking feels slower at identical latency |
| Degraded search | ✅ Say so explicitly | ❌ Render as normal | Silent degradation misrepresents the catalog |
| Filters | ✅ URL | ❌ Store | Back button and sharing are the dominant navigation |
| Images | ✅ Responsive sources | ❌ One compressed size | The photograph is the product |

---

## 🔭 What I'd Build Next

**Enforce the reservation the schema already describes.** It's the highest-value change in the product and it's mostly backend, but it unlocks a frontend the current one can't honestly build: a visible hold, a countdown, and a cart that means something. Until then the UI is compensating for a missing guarantee.

**Recommendations from view history.** `view_history` is populated and unused. "Because you viewed" and a personalized homepage are the standard lift for a browse-heavy marketplace, and the data is already there — this is pure frontend-plus-a-query work.

**Image upload for sellers.** Products currently carry URLs, which means listing requires hosting images elsewhere — a real barrier for the individual makers this marketplace is for. It's the most impactful gap in the seller experience.

---

## 🚀 What Breaks First

**Stale availability in search results**, before anything performance-related. Elasticsearch is updated from the write path with no CDC, so a failed index write leaves a sold item looking available indefinitely. The client can't fix the index, but it can stop trusting it: availability shown in a grid is a hint, and the product page must re-check. Designing as if search results are authoritative is the mistake.

**Then infinite scroll's interaction with the back button.** Scrolling through 200 results, opening a product, and returning to the top is the most common frustration in marketplace browsing. Restoring scroll position and loaded pages is the fix, and it's the argument for keeping pagination state in the URL.

**Then image weight**, which dominates bytes on every screen and is a delivery problem before it's a code problem.

**Then cart size**, last and least — carts here are small, and a marketplace cart with fifty items isn't a real scenario.

---

## 📝 Summary

Three ideas carry this design:

1. **The interface must never be more confident than the system.** With quantity-one inventory, every "reserved" badge and optimistic add is a promise the backend hasn't made — and a broken promise here costs a permanent loss rather than a retry.
2. **The cart is one object that becomes several.** Revealing that in the cart, before any money moves, converts a post-purchase surprise into an understood structure — and makes partial failure explicable.
3. **An empty result set is usually the interface's fault.** With an unnormalized catalog, zero results means the buyer's vocabulary didn't match the sellers'. Teaching the catalog's language, cancelling superseded queries, and being honest about degraded search matter more than shaving latency.

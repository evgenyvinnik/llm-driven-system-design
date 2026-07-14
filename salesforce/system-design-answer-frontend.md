# Salesforce CRM - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 📋 Problem Statement

Design the web frontend for a CRM: a KPI dashboard, list views for accounts/contacts/leads, a tabbed account detail page, a drag-and-drop opportunity pipeline, a lead-conversion workflow, and reports.

What makes this frontend hard isn't any single screen. It's that **this is the app a salesperson keeps open for eight hours straight.** That one fact reframes everything. It isn't a page you visit; it's a workspace you live in. So the real problems become: a client-side cache that stays coherent across hundreds of navigations and mutations without ever going stale in a way that costs someone a deal; a drag-and-drop board where the optimistic update must be instant *and* must unwind correctly when a colleague moved the same deal thirty seconds ago; forms whose fields the customer defined rather than us; and a tab that must not leak memory into hour seven.

## 🎯 Requirements Clarification

- **How long is a session?** All day, one tab, rarely reloaded. This is the load-bearing answer — it makes cache coherence and memory the primary concerns, not initial page load.
- **Is the data multi-user-live?** Several reps share a pipeline. It doesn't need real-time collaboration, but it absolutely needs **conflict detection** — silently overwriting a colleague's stage change is a business loss, not a cosmetic bug.
- **Custom fields?** Yes. Forms are rendered from a server-supplied schema, not hardcoded. That's a frontend architecture decision, not a backend detail.
- **How big are list views?** Tens of thousands of rows for a large org, filtered down to dozens in practice. So: server-side filtering, plus virtualization for the unfiltered case.

### Functional Requirements

- Dashboard: KPI cards and a pipeline chart
- List views (accounts, contacts, leads): search, filter, paginate
- Account detail: tabbed — contacts, opportunities, activity timeline
- Opportunity pipeline: kanban, drag between stages
- Lead conversion: a modal workflow producing three new entities
- Reports: pipeline, revenue, lead source

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Interaction latency | < 100ms perceived | A drag that lags feels broken. This alone forces optimistic updates |
| Navigation | Instant for already-seen data | Reps bounce between an account and its deals constantly |
| Correctness | Never silently show a stale value for the record being acted on | The record *is* the product |
| Memory | Flat across an 8-hour session | An unboundedly growing tab gets killed by the OS at 4pm |
| Custom fields | Zero deploys to add one | The customer adds fields; we cannot ship code per field |
| Accessibility | Full keyboard path, including drag | Internal enterprise tools have hard a11y requirements |

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     React SPA (Vite + TS)                    │
│                                                              │
│  ┌────────────┐  ┌────────────────────────────────────────┐ │
│  │  Sidebar   │  │  Route Outlet (TanStack Router)         │ │
│  │ persistent │  │  /  ·  /accounts  ·  /accounts/$id      │ │
│  │            │  │  /opportunities (kanban)  ·  /leads     │ │
│  │            │  │  /reports                               │ │
│  └────────────┘  └───────────────────┬────────────────────┘ │
│                                      │                       │
│  ┌───────────────────────────────────▼────────────────────┐ │
│  │      Normalized Entity Cache  ← the center of gravity  │ │
│  │   accounts[id] · contacts[id] · opportunities[id] …    │ │
│  │   + query index:  queryKey ──▶ [ids]                   │ │
│  │   + metadata:  custom-field schema, per entity type    │ │
│  └────────┬──────────────────────────────┬────────────────┘ │
│           │ selectors (by id)            │ mutations        │
│  ┌────────▼─────────┐          ┌─────────▼───────────────┐  │
│  │  Components      │          │  Optimistic mutation    │  │
│  │  subscribe to    │          │  queue: apply → confirm │  │
│  │  one entity      │          │  → rollback / roll-fwd  │  │
│  └──────────────────┘          └─────────┬───────────────┘  │
│                                          │                   │
│  ┌───────────────────────────────────────▼────────────────┐ │
│  │  API client — sends version; maps 409 → conflict path  │ │
│  └───────────────────────────────────────┬────────────────┘ │
└──────────────────────────────────────────┼──────────────────┘
                                           ▼ HTTPS
                                    ┌──────────────┐
                                    │   CRM API    │
                                    └──────────────┘
```

The center of gravity is the **normalized entity cache**. Routing, forms, and the kanban board are all views over it. I'll defend that first, because the tempting alternative — each route fetching its own data into its own array — is what most CRM frontends actually do, and it's exactly why most CRM frontends show you numbers that disagree with each other.

## 🗂️ Routes and Component Structure

```
/                    Dashboard   — KPI cards + pipeline bar chart
/accounts            List        — search, industry filter, paginate
/accounts/$id        Detail      — tabs: Contacts | Opportunities | Activities
/contacts            List
/opportunities       Kanban      — 7 stage columns, drag to move
/leads               List        — + Convert action (modal)
/reports             Charts      — pipeline, revenue, lead source
/login  /register    Unauthed    — rendered without the sidebar
```

The sidebar is persistent and only rendered when authenticated — checked before the first paint, not rendered-then-hidden, which would produce a visible flash of navigation on the login screen.

Two component-design decisions worth stating, because both are cases where the "DRY" instinct gives the wrong answer:

- **The entity form is shared; the entity table is not.** Forms differ only in their *fields* (data), so one modal driven by entity type is right. Tables differ in their *columns, cell formatters, and row actions* — currency here, a status badge there, a Convert button on leads only. A generic table abstracting all that would need so many configuration props it'd be harder to maintain than four honest components. Shared behavior, yes. Shared everything, no.
- **The status badge is one component with per-entity color maps.** Not one giant lookup, because "New" means a new *lead* (blue) in one context and nothing at all in another. Passing the entity type disambiguates, and it keeps "Closed Won is green" true on the kanban, the account page, and the report simultaneously.

## 🔀 Data Flow: One Drag, End to End

```
  user drops card
        │
        ▼
 ┌──────────────────┐   snapshot previous stage
 │ mutation queue   │   → cache.opportunities[id].stage = 'Closed Won'
 └────────┬─────────┘
          │  board re-renders  ◀── ~0ms. This is the whole point.
          ▼
 ┌──────────────────┐
 │ PUT .../stage    │   body: { stage, version }
 └────────┬─────────┘
          │
   ┌──────┴───────┬──────────────────┐
   ▼              ▼                  ▼
 200 OK        409 Conflict       Network error
   │              │                  │
   │              │                  ▼
   │              │            retry w/ backoff;
   │              │            on give-up → rollback
   │              │              to snapshot
   │              ▼
   │      write SERVER's current
   │      state into cache
   │      + "Dana moved this 2m ago"
   │      + do NOT auto-retry
   ▼
 replace optimistic value with
 server response (new version,
 server-derived probability)
```

Three different failure modes, three genuinely different responses. The bug I've seen most often is collapsing all three into one `catch` block that reverts to the snapshot — which is correct for the network error, and actively harmful for the 409.

## 🔧 Deep Dive 1: A Normalized Cache, Not Per-Route Fetching

**The naive design:** each route fetches what it needs into a store slice — `accounts[]`, `opportunities[]`, `leads[]`. Obvious, simple, and it breaks in a specific and damaging way.

**How it concretely breaks.** A rep is on `/accounts/acme`. The Opportunities tab shows "Acme Renewal — $50,000 — Negotiation." They click through to the pipeline board, drag that deal to Closed Won, then navigate back to the account.

- If the account route re-fetches on every mount, they see the right value — but they paid a round-trip and a spinner to display data the app *already knew*. Do that on every navigation, all day, and the tool feels like a website instead of a workspace.
- If the account route caches its earlier fetch, they see **$50,000 in Negotiation** — a deal they personally just closed, rendered as still open.

And it compounds. That opportunity's value feeds the dashboard KPI card, the account's pipeline total, and the board's column sum. Those are three copies of one fact, fetched at three different moments, and they will disagree **on screen simultaneously**. The rep's response isn't to file a bug; it's to stop trusting the numbers — which is fatal for a forecasting tool.

The root cause is **duplication**. The same opportunity lives in three arrays. Every mutation must find and update all of them, and it never will, because the list of places grows every sprint and nothing enforces it.

**The fix: one entity, one copy, referenced by ID.**

- The cache holds `opportunities: { [id]: Opportunity }` — exactly one record per entity.
- Query results store **IDs, not objects**: the query for "opportunities in Negotiation" resolves to a list of IDs.
- Components select by ID. The row on the account page and the card on the kanban board subscribe to *the same object*.
- A mutation writes once, to one place, and every view updates — because there were never separate copies to invalidate.

> "Normalization is the difference between 'I must remember to invalidate the account page when a deal changes' and 'there is no account-page copy to invalidate.' The first is a discipline that decays as the team grows; the second is a property of the data structure. In a CRM specifically, getting this wrong isn't a cosmetic glitch — a rep looks at a stale pipeline number and makes a real decision on it. 'The UI lied to me' is how a tool loses trust permanently, and you don't get it back."

**What we give up — and I'd rather name it than pretend.** Selectors get harder. Rendering the account page means resolving an account, then its contact IDs, then its opportunity IDs: a join, performed on the client. A denormalized blob would just render. There's also a real re-render hazard: a selector that *derives* a list returns a fresh array on every call and will re-render on every store write unless memoized. So the cost is paid in selector discipline, and it must be enforced with memoized selectors rather than hoped for.

**Memory falls out of this for free.** With exactly one copy per entity, the cache grows with *distinct entities viewed*, not with *navigations performed*. Add LRU eviction for entities no mounted view references, cap at a few thousand records, and memory is flat by construction. Under per-route caching, every navigation appends another array, and hour seven is a garbage-collection stall.

## 🔧 Deep Dive 2: The Kanban Board — Optimism, and the Conflict You Can't Ignore

Dragging a deal between stages must feel instant. Waiting for a round-trip — 200ms on a good connection — reads as broken: the card snaps back, sits there, then jumps. So the update is optimistic: move the card immediately, fire the request, reconcile after.

**The straightforward part:**

1. On drag end, write the new stage into the cached opportunity and snapshot the previous value.
2. The board re-renders instantly. The card is in its new column.
3. Fire the stage-change request, including the record's `version`.
4. On success, replace the optimistic value with the server's response — which carries the new version **and the server-derived probability**. The client must *not* compute the stage→probability mapping itself: duplicating that rule means it lives in two codebases and will drift, and a forecast built on a drifted mapping is silently wrong in a way nobody notices until quarter close.
5. On failure, restore and surface.

**The part that actually matters: what "failure" means.** A network error is easy. The interesting failure is a **409 Conflict** — a colleague moved this same deal since we last read it.

Here is where most optimistic-UI implementations quietly do the wrong thing. They roll back to the pre-drag state and show "something went wrong." But that's a lie. The deal *did* change — just not the way this user wanted, and not by them. Rolling back to the local pre-drag value puts a **newly stale** value on screen, and if the user shrugs and drags again, they will obliterate their colleague's change. The optimistic UI has now actively caused the data loss the version check was supposed to prevent.

So the conflict path is:

1. The 409 response carries the **current server state** of the opportunity.
2. We write *that* into the cache — not the snapshot. The card snaps to where the deal actually is now.
3. We show a specific message: "Dana moved this deal to Closed Won two minutes ago." Not "an error occurred."
4. The user decides what to do next. We do **not** auto-retry, because auto-retry here means "silently overwrite my colleague," which is precisely what we were trying to avoid.

> "The rule I'd hold to: **an optimistic update may be rolled back, but never rolled back to a value we already know is stale.** If the server tells us the truth in its error response, the correct rollback target is the truth, not the past. That distinction is the entire difference between an optimistic UI that earns trust and one that feels snappy while quietly corrupting a shared pipeline."

**Why the client must send a version.** Without it, the server cannot distinguish "move this deal to Closed Won" from "move this deal to Closed Won, *based on my belief that it is currently in Negotiation*." Last-write-wins turns a shared board into a race the loser never learns about. Sending the version converts an invisible overwrite into a visible, resolvable conflict. Note what that is: **a frontend requirement driving an API contract.** That's the kind of thing a frontend engineer should be arguing for in the design review, not discovering in production.

**Drag mechanics, briefly.** A drag overlay renders a floating clone under the cursor while the original stays in place, dimmed. If you instead transform or remove the original node, the source column reflows mid-gesture and the drop targets slide out from under the user's cursor. The overlay pattern looks like polish and is actually correctness. And the drag library must support **keyboard drag** — tab to a card, space to lift, arrows to move, space to drop — because "drag-and-drop only" is an accessibility failure that will disqualify the product from enterprise procurement, regardless of how good it feels with a mouse.

## 🔧 Deep Dive 3: Rendering Forms for a Schema We Don't Control

Every customer adds custom fields. So the account form is not a form we wrote — it's a form we *render*, from a schema the server hands us.

**The metadata flow:**

1. On login, fetch the org's field metadata: for each entity type, a list of descriptors — name, type (`text`, `number`, `date`, `boolean`, `select`), options, required-ness.
2. Cache it in the store alongside the entities. It changes rarely (an admin adds a field), so cache for the session and revalidate in the background.
3. A dynamic form component maps each descriptor to an input via a **type → renderer registry**.
4. Validation rules are generated from the same descriptors, so the client's rules and the server's rules derive from one source and cannot drift.

**Why this beats the alternative.** The alternative — hardcoded forms with a "Custom Fields" section bolted onto the bottom — is what a lot of CRMs actually ship, and it fails twice. First, standard and custom fields end up with different validation, layout, and error handling, so the custom ones permanently feel second-class — which is backwards, because the custom ones are the fields the customer cared enough to create. Second, adding a new standard field type means editing every form by hand. With a registry-driven renderer, standard fields are simply custom fields we seed by default: one code path, one set of behaviors, and adding a field type means adding one renderer.

**What we give up: compile-time type safety.** A hand-written form is checked by the compiler. A schema-driven form is an untyped bag at the boundary. Mitigation: generate types for the known fields, and validate the custom bag at runtime against a schema built from the metadata. That moves safety from compile time to runtime rather than deleting it — a genuine loss, and the unavoidable price of a product capability that cannot be built any other way.

**The shared entity form follows from the same logic.** One modal, driven by entity type, renders accounts, contacts, opportunities, and leads. Four separate form components would mean four places to fix a focus-trap bug and four subtly divergent save/cancel behaviors. These forms differ in their *fields*, which is data. They do not differ in their *behavior*, which is code.

## 🔄 Lead Conversion — And Why It Is Deliberately *Not* Optimistic

Kanban is optimistic. Lead conversion isn't, and the reason generalizes into a rule I'd apply everywhere.

**An optimistic update is only affordable when the client can predict the server's answer.** Moving a deal to Closed Won: the client knows exactly what the result looks like — same record, new stage. Converting a lead: the server creates an account, a contact, and an opportunity, each with a **server-generated ID the client cannot know**. There is no optimistic state to apply. You *could* fabricate temporary IDs and rewrite them on confirmation — but every reference to `temp-1` across the entire normalized cache must then be found and rewritten when the real ID lands, which is a lot of machinery for a workflow a rep performs a few times a day and already expects to take a beat.

So conversion is explicit and pessimistic: modal → confirm → button spinner → on success, write the three new entities into the cache, mark the lead converted, and navigate to the new account. The user gets a real progress indicator, because the operation genuinely takes time and pretending otherwise buys nothing.

**The principle, stated plainly:** *optimism is affordable exactly when the client can predict the result.*

| Mutation | Client can predict result? | Treatment |
|----------|---------------------------|-----------|
| Stage change | Yes — same record, known new value | ✅ Optimistic |
| Field edit | Yes | ✅ Optimistic |
| Delete | Yes — the record is gone | ✅ Optimistic, with undo |
| Create entity | No — server generates the ID | ⚠️ Pessimistic, unless the UX justifies temp-ID reconciliation |
| Lead conversion | No — three unpredictable IDs, cross-entity | ❌ Firmly pessimistic |

That single test decides which mutations get which treatment, and it's far more useful than the blanket advice that "optimistic UI is good."

**One UX detail worth defending:** conversion happens in a modal over the lead list, not on a separate page. The rep keeps their place and their context — they can see which leads they've already worked through. And on failure ("this lead was already converted by someone else"), the error appears *inline in the modal* without closing it, so the rep doesn't lose the amount and close date they just typed.

## 🧭 Relationship Navigation: The Account Detail Page

CRM use is relationship-walking. Click an account, see its contacts; click a contact, see their deals. The detail page is where the normalized cache stops being an abstract nicety and starts paying rent.

The account page needs four things: the account, its contacts, its opportunities, and its activity timeline. Three options:

| Loading strategy | Pros | Cons |
|------------------|------|------|
| ❌ Sequential fetches | Simple | Page paints at the *sum* of four latencies — 300ms+ |
| ✅ Parallel fetch, all tabs | Paints at the slowest single call (~200ms); tab switching is then instant | Fetches data for tabs the user may never open |
| ⚠️ Lazy per-tab | Least bandwidth | Every tab click costs a spinner — and reps switch tabs constantly |

I fetch all four in parallel. The bandwidth "waste" is a few dozen rows; the alternative charges the user a loading state on *every tab click*, all day. For a tool people live in, the cost of a spinner is paid hundreds of times and the cost of a few extra rows is paid once.

**But the normalized cache changes what "fetch" even means.** Half of this is usually already in memory — the rep got here by clicking a row in the account list, so the account is cached. The fetches become *revalidation* rather than *acquisition*: render immediately from cache, correct quietly when the responses land. The page has content at 0ms and truth at 200ms, instead of a spinner at 0ms and content at 200ms.

**Prefetch on hover** is the natural next step: when the cursor rests on an account row for 150ms, start fetching its detail. By the time the click registers, the data is usually there. It's cheap because the query index means we know exactly what we'd need, and it's the single highest-leverage perceived-performance trick available in an app whose core loop is "click through to the next record."

**The activity timeline is polymorphic on the client, too.** One timeline component takes `relatedType` and `relatedId` and renders chronologically with type-specific icons. It appears identically on account, contact, opportunity, and lead pages. That mirrors the server's polymorphic activity model exactly — and it's a good example of a backend data-model decision paying off directly in frontend component count. The alternative (a per-entity activity type) would have meant four timeline components.

## 📱 State Management Layout

| Store | Contents | Update source |
|-------|----------|---------------|
| authStore | user, session status, role | REST (login / me / logout) |
| entityStore | normalized entities by ID; query→ID indexes; custom-field metadata | REST fetches + optimistic mutations |
| mutationQueue | in-flight optimistic mutations with rollback snapshots | Local |
| Local component state | form inputs, modal open/closed, drag state, active tab | User interaction |

Zustand over Redux for footprint, and over Context for a concrete reason: **Context re-renders every consumer on any change to its value.** With a normalized cache holding thousands of entities in one object, a Context-based store means editing one contact re-renders every component that reads the store. Zustand's selector subscriptions mean editing one contact re-renders only the components that selected *that contact*. At CRM data volumes that isn't a micro-optimization — it's the difference between a board that drags smoothly and one that stutters.

Tab state on the account detail page stays in local component state, not the URL. Switching between Contacts and Opportunities should not create a browser-history entry — a rep clicking Back expects to return to the account *list*, not to the previous tab.

## 🖼️ Rendering and Perceived Performance

- **List views**: server-side search, filter, and pagination are the primary defense — a rep almost always narrows to dozens of rows. But the unfiltered "all accounts" view for a large org is thousands of rows, so it's virtualized: render only the viewport. Without virtualization the browser constructs 10,000 DOM rows and first paint takes seconds with the main thread blocked.
- **Pagination, not infinite scroll.** A rep needs to jump to a page, and a manager needs to see "247 leads" as a real number. Infinite scroll destroys both. This is one of the few places where the older pattern is simply correct.
- **Debounced search** at ~300ms. Typing "Acme Corporation" without debouncing fires a request per keystroke — 16 requests, 15 of them wasted, and the responses can arrive out of order and render the wrong result set.
- **The kanban board is the deliberate exception to virtualization.** A virtualized column breaks drag-and-drop, because you cannot drop onto a target that isn't mounted. So instead each column is capped (top N by amount, with "show more") — which is also better product, since nobody drags the 400th card in a column.
- **Skeleton screens, not spinners**, on first load. A skeleton matching the final layout means no layout shift when data lands, and it communicates *what* is loading rather than merely *that* something is.
- **Charts built with layout, not a library.** Pipeline and revenue bars are proportional-width elements. A charting library is 40–60KB gzipped to draw rectangles, and that budget is better spent on the data layer. The moment we need tooltips, zoom, and interactive legends the calculus flips — and then I'd code-split the library onto the reports route only, so the dashboard never pays for a dependency it doesn't use.
- **Route-level code splitting**: the drag-and-drop library loads only on the pipeline route. Login and dashboard never download it.

## 🔍 The Search and Filter Contract

Search is where the client/server boundary gets negotiated, and getting it wrong is a common way to build a CRM that's fast in the demo and unusable at a real customer.

**Filtering happens on the server. Always.** The instinct — fetch the accounts once, filter in memory, feel instant — works beautifully for the 200 accounts in a seed database and collapses at the 40,000 accounts a real org has. You cannot filter what you haven't downloaded, and downloading 40,000 accounts to find one is not a strategy.

**What the client owns:**

- **Debounce** (~300ms) so typing "Acme Corporation" fires one or two requests, not sixteen.
- **Request cancellation / last-write-wins on responses.** Without it, the response for "Acm" can land *after* the response for "Acme" and repaint the wrong result set. This is a subtle bug that only shows up on slow connections, which is to say: only for the users who are already suffering.
- **The query index.** A search result is a list of IDs stored under a key derived from the query. Re-running the same search is free; the entities are already in the cache. Going back to a list you just left is instant.

**What the server owns:** the actual matching, the total count (a real number, because a manager asking "how many leads came in this month" needs an answer, not an estimate), and the sort.

The empty state matters more here than people expect. "No results" for a search and "no accounts yet" for a fresh org are completely different situations needing completely different UI — one offers to clear the filters, the other offers to create the first record. Collapsing them into one blank panel is how a new customer's first five minutes go badly.

## ♿ Accessibility

Not a footnote — enterprise procurement checks this, and a CRM that fails an audit doesn't get bought.

- **Keyboard drag-and-drop** is mandatory, which is a primary input to the library choice. If the board can only be operated with a mouse, the pipeline is unusable for a subset of employees.
- **Real labels, not placeholders.** Placeholder-as-label disappears the moment the user types, which is exactly when they most need it.
- **Color is never the only signal.** A "Closed Won" badge is green *and* says "Closed Won." Stage is conveyed by text, not hue.
- **Focus management on modals**: focus moves into the modal on open and returns to the triggering control on close, so keyboard users don't get dumped at the top of the page.

## 🛡️ Resilience and the Eight-Hour Tab

An all-day tab has failure modes a page-per-visit app never encounters:

- **Session expiry mid-action.** The rep returns from lunch, drags a deal, gets a 401. Losing the drag is annoying; losing an unsaved form is enraging. So a 401 on a mutation **preserves the pending change** in the mutation queue, prompts for re-auth inline, and replays on success. Redirecting to `/login` and discarding their work is the single behavior most likely to make someone hate the tool.
- **Staleness after idle.** Data fetched at 9am is still on screen at 4pm. On tab refocus after a long idle, revalidate the *visible* queries in the background — show what we have immediately, correct it quietly. Never blank the screen to reload.
- **Memory.** LRU eviction of unreferenced entities, plus dropping query→ID indexes for routes untouched for an hour. Those indexes are cheap to rebuild and they pin entities in memory that would otherwise be evictable.
- **Flaky network.** Mutations queue and retry with backoff; reads fail soft to cache with a visible "showing data from 3:42pm" indicator. The one thing never permitted is silently presenting stale data as live.

## 📊 What I'd Measure in Production

Frontend performance claims are worthless without real-user data, and the metrics that matter here are not the standard ones.

| Signal | Why it's the right one for *this* app |
|--------|--------------------------------------|
| Time-to-interactive on the **kanban route** | It's the heaviest route and the one with the most expensive dependency. If TTI regresses, someone added to the drag bundle |
| **Drag-to-render latency** (drop event → paint) | The optimistic update's whole justification. If this exceeds ~50ms, the optimism isn't buying anything |
| **409 rate on stage changes** | Rising conflicts mean reps are colliding — which is a *product* signal (the team needs real-time sync) disguised as an error metric |
| Cache hit rate on navigation | Directly measures whether Deep Dive 1 is working. A falling hit rate means someone reintroduced a per-route fetch |
| **Heap size at hour 4 vs. hour 1** | The eight-hour-tab metric. Nothing else catches an eviction bug |
| Mutation-queue depth | Sustained depth means the network is failing and the user's work is piling up unsaved — the most user-hostile state the app can be in |

Note that Largest Contentful Paint, the metric everyone reaches for, is nearly irrelevant here: users load this app once a day. The metrics that matter are all about the *thousandth* interaction, not the first.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Client data layer | ✅ Normalized entity cache | ❌ Per-route fetch into arrays | One deal appears on three screens; duplication guarantees they disagree on screen |
| Kanban update | ✅ Optimistic | ❌ Wait for the server | 200ms of lag on a drag reads as broken |
| Conflict (409) | ✅ Roll *forward* to server truth, name who changed it | ❌ Roll back to pre-drag value | Rolling back to a value we know is stale invites the user to overwrite a colleague |
| Concurrency contract | ✅ Client sends `version` | ❌ Last-write-wins | Turns a silent overwrite into a visible, resolvable conflict |
| Probability mapping | ✅ Server-derived, echoed back | ❌ Computed client-side | Duplicated business rules drift; a drifted forecast is silently wrong |
| Lead conversion | ✅ Pessimistic with progress | ❌ Optimistic with temp IDs | The client cannot predict server-generated IDs |
| Forms | ✅ Schema-driven from metadata | ❌ Hardcoded + custom-field appendix | Customers add fields; we cannot deploy per field |
| Global state | ✅ Zustand selectors | ❌ Context | Context re-renders every consumer on any change |
| List views | ✅ Server filter + virtualize the tail | ❌ Fetch all, filter on the client | 10K DOM rows blocks the main thread for seconds |
| List navigation | ✅ Pagination with a real total | ❌ Infinite scroll | Managers need counts; reps need to jump to a page |
| Kanban columns | ✅ Capped, not virtualized | ❌ Virtualized | You cannot drop onto an unmounted node |
| Charts | ✅ Layout-based bars | ❌ Charting library up front | 60KB to draw rectangles; split it in only when interactivity is needed |

## 📈 Scaling the Frontend: What Breaks First

1. **The unfiltered list view**, at a few thousand rows. Virtualization fixes rendering; server-side pagination fixes transfer. Both are needed — virtualizing 50,000 rows you already downloaded still means you downloaded and parsed 50,000 rows.
2. **Selector cost on a large cache.** As the store grows, unmemoized derived selectors recompute on every write and re-render half the app. Fix: memoized selectors with stable references, and subscribing at the narrowest key that works.
3. **The custom-field explosion.** An org with 100 custom fields on accounts makes the dynamic form enormous and the list view unreadable. The answer is *field sets* — the org configures which fields appear in which context. It looks like a UI feature; it's a performance requirement wearing a costume.
4. **Bundle size** as features accumulate. Route-level splitting is the first line of defense; the drag library, the reports page, and the admin surface are the natural split points.
5. **Real-time, eventually.** Today conflicts are detected on write. The next step is a subscription pushing "this deal changed" so a rep's board updates while they're looking at it — turning conflict *detection* into conflict *avoidance*. That's the biggest UX upgrade still on the table, and it's mostly a transport problem, because the normalized cache already gives us exactly one place to apply an incoming change. That's the payoff of Deep Dive 1 arriving a year later.

6. **The activity timeline on a busy account.** A five-year enterprise account can have thousands of logged calls and emails. The timeline is the one place in the app with genuinely unbounded growth per record. It needs cursor pagination ("load earlier") rather than a full fetch, and it's the first place I'd expect a naive implementation to fall over on a real customer's biggest account — which is, of course, their most important one.

## 🚀 Closing

The through-line is two questions, asked of everything: **can the client predict this mutation's result?** and **is there exactly one copy of this data?** Those two produce nearly every decision above. Optimism where prediction is possible, pessimism where it isn't. One copy of every entity, so no two views can disagree. Everything else — virtualization, code splitting, skeletons, drag overlays — is craft layered on top of a data layer that either tells the truth or doesn't.

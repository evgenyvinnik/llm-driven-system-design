# Distributed Cache — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

---

## 📋 Opening Statement

"This is an operator console for a distributed cache, and that makes it a different frontend problem than a consumer app. Nobody browses this UI — an engineer opens it because something is wrong, or because they're about to change the cluster and want to see what happens. So the design pressure isn't engagement or conversion; it's **whether the operator can trust what's on screen, and whether the UI can hurt the system it's observing.**

Three decisions carry the whole design: how the client learns about a cluster whose topology changes underneath it, how to show a live system without the dashboard itself becoming load, and how to present destructive actions so the console can't cause the outage it's meant to diagnose. I'll go deep on those."

---

## 🎯 Requirements

### Functional

1. **See cluster topology** — which nodes exist, which are healthy, how the keyspace is distributed
2. **Browse and inspect keys** — what's cached, on which node, with what TTL
3. **Exercise the cache live** — set/get/delete against the real cluster to observe routing
4. **Watch a topology change** — add or remove a node and see rebalancing happen
5. **Notice failure fast** — a dead node must be obvious without hunting

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| Staleness of health data | ≤ 5s | Longer and the operator acts on a stale picture during an incident |
| Dashboard's own load | Negligible vs. cache traffic | An observability tool that perturbs the system is worse than none |
| Time to spot a dead node | Immediate on load | This is the primary reason the page gets opened |
| Correctness of "which node owns this key" | Exact | A wrong answer here sends someone debugging the wrong machine |

### Non-goals

No authentication UI beyond an admin API key, no historical time-series, no alerting. Those are real needs at scale, and each one is a different product — a metrics backend, not a console.

---

### Questions I'd ask before designing

Three answers would change the architecture materially:

**"Who opens this, and when?"** If it's two platform engineers during incidents, everything above holds. If it's a self-service tool for dozens of application teams checking their own keys, then multi-tenancy, per-team scoping, and read-only defaults become the dominant concerns, and the shared-polling load problem gets an order of magnitude worse.

**"Is this ever pointed at production?"** A teaching cluster and a production cluster want opposite defaults. Against production I'd make the console read-only by default and put mutations behind an explicit mode switch, because the cost of an accidental flush is unbounded.

**"How many nodes, realistically?"** Three nodes and thirty nodes are different visualizations. The ring diagram stops being readable somewhere around a dozen, and beyond that a sorted distribution histogram communicates the same property better. Designing the ring view without knowing this risks building the wrong picture well.

---

## 🏗️ Architecture

```
        ┌────────────────────────────────────────────────┐
        │              Admin Console (browser)            │
        │                                                 │
        │   ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
        │   │ Cluster  │  │   Keys   │  │  Live test  │  │
        │   │   view   │  │  browser │  │   console   │  │
        │   └────┬─────┘  └────┬─────┘  └──────┬──────┘  │
        │        └─────────────┼───────────────┘         │
        │                 ┌────▼─────┐                    │
        │                 │  Store   │  5s poll           │
        │                 └────┬─────┘                    │
        └──────────────────────┼─────────────────────────┘
                               │ HTTP (admin API key)
                       ┌───────▼────────┐
                       │  Coordinator   │ ◀── owns the hash ring,
                       └───┬────┬───┬───┘     health, breakers
                           │    │   │
                  ┌────────▼─┐ ┌▼──┐ ┌▼────────┐
                  │  node-1  │ │n-2│ │  node-3 │
                  └──────────┘ └───┘ └─────────┘
```

**The console talks only to the coordinator, never to nodes directly.** That mirrors how real clients reach the cache, and it matters for a reason beyond symmetry: the coordinator is the only component that knows the current ring. A dashboard that queried nodes individually would have to reconstruct topology from what it found, and would show a view no actual client ever sees.

---

## 🔍 Deep Dive 1: Rendering a Topology That Changes Underneath You (10 minutes)

This is the defining problem. Every other admin dashboard renders records; this one renders **a distributed system's current belief about itself**, and that belief changes while you're looking at it.

### Why the obvious approach is wrong

The natural implementation fetches nodes, fetches keys, fetches stats, and renders all three. But those are three separate requests against a cluster that may be mid-rebalance. You can easily produce a screen showing four nodes in the topology panel, a key count that sums to three nodes' worth, and a key browser listing keys on a node that was removed between request one and request three.

**Nothing on that screen is wrong individually, and the composite is a lie.** For an operator making a decision during an incident, that's worse than showing less.

### Options

| Approach | Consistency | Cost |
|----------|-------------|------|
| ❌ Independent fetches, render as they arrive | None — panels disagree | Simplest; actively misleading during change |
| ✅ **One snapshot endpoint, render atomically** | Panels always agree | Requires a coordinator endpoint returning topology + stats together |
| ✅ **Version/epoch stamp on every response** | Client can detect and discard mixed data | Needs a ring epoch the coordinator increments |
| ❌ Long-poll or stream per panel | Fresh, still uncoordinated | Most connections, no consistency gain |

### What I'd build

Fetch a **single coordinated snapshot** and render from it as one unit. The client should never assemble a view from independently-timed reads of a system whose whole point is that its topology mutates.

Where that isn't possible — the key browser genuinely is a separate, paginated query — I'd stamp responses with the **ring epoch** and show the key list as belonging to a specific topology version. When the epoch changes, the list is marked stale rather than silently mixed with new data. The operator sees "this listing is from before the rebalance", which is honest and actionable.

The subtler point: **during a rebalance, "which node owns this key" has two answers** — the pre-migration owner and the post-migration one. A UI that shows one number is asserting something the cluster isn't sure about. I'd surface migration explicitly, showing keys in flight as *moving* rather than resolved. That turns the most confusing period into the most informative screen in the console.

> "The thing I want to avoid is a dashboard that's most confident exactly when the system is least stable. Rebalancing is when someone is watching, and it's when naive rendering lies most."

---

## 🔍 Deep Dive 2: An Observer That Doesn't Perturb What It Observes (9 minutes)

The console polls every 5 seconds. That number deserves defending, because both directions are tempting and both are wrong.

### The pull toward faster

An operator watching a failover wants sub-second feedback, and 5 seconds feels sluggish. But every poll is a request the coordinator serves *while it is routing real traffic and monitoring node health*. During an incident — precisely when dashboards get opened, often several at once — that load arrives at the worst moment.

**The pathological case is a dashboard that contributes to the outage it's displaying.** Several tabs left open across a team, each polling aggressively, each triggering a topology fan-out on the coordinator, is a self-inflicted load spike correlated with incidents.

### The pull toward slower or event-driven

| Approach | Freshness | Load | Failure mode |
|----------|-----------|------|--------------|
| ❌ 500ms polling | Excellent | Multiplies per open tab | Dashboards amplify incidents |
| ✅ **5s polling** | Adequate for human decisions | Bounded, predictable | Up to 5s stale — visible via a timestamp |
| ✅ SSE push from coordinator | Best | One connection per viewer, coordinator does the work once | Coordinator must own a broadcast loop |
| ❌ On-demand only (manual refresh) | None | Zero | Operator stares at a frozen screen believing it's live |

**5-second polling is the right default and SSE is the right upgrade.** The reason to prefer polling *now* is that push moves work into the coordinator — it must maintain a client registry and a broadcast timer — and the coordinator is the component whose reliability matters most. Adding responsibilities to it in order to make a dashboard prettier is a bad trade at this scale.

Three things make polling honest:

- **Show the data's age.** A "last updated 3s ago" stamp costs nothing and converts an invisible property into a visible one. Without it, a frozen dashboard and a quiet cluster look identical.
- **Poll only what's visible.** The key browser shouldn't refresh while the operator is on the cluster tab. Per-view polling scales with attention, not with tabs.
- **Back off when hidden.** `visibilitychange` should slow or stop polling in background tabs — this alone removes most of the multi-tab load problem, because the tabs contributing load are the ones nobody is looking at.

> "I'd take a 5-second delay with an honest timestamp over a 500ms refresh that makes the console part of the incident. The operator can wait five seconds; the coordinator can't absorb ten dashboards during a failover."

---

## 🔍 Deep Dive 3: A Console That Can Break Production (9 minutes)

This UI can delete keys, remove nodes, and trigger rebalancing. That makes safety a frontend design problem, not just a permissions one.

### The asymmetry that drives everything

Cache operations are not equally reversible:

| Action | Reversibility | Blast radius |
|--------|--------------|--------------|
| Get / browse keys | Fully | None |
| Set a key | Trivially | One key |
| Delete a key | Recoverable — repopulates from source of truth | One key, one miss |
| **Remove a node** | Triggers rebalance; the shard's keys are gone | ~1/N of the keyspace |
| **Flush** | Not recoverable from the cache | Everything — and a thundering herd on the origin |

The last two aren't "delete" operations in the usual CRUD sense. Removing a node from a cache with **no replication** means that shard's keys cease to exist, and every request for them falls through to the origin database simultaneously. **The dangerous outcome isn't lost cache data — cache data is by definition rebuildable — it's the stampede against the system behind it.**

### How that shapes the UI

I'd separate the controls by consequence rather than grouping them by resource:

- **Reads and single-key writes** are immediate, no friction. Adding a confirmation to a `get` trains people to click through dialogs, which is what makes the dangerous confirmation useless.
- **Node removal and flush** get a confirmation that **states the consequence in the system's own terms** — not "Are you sure?" but "This removes ~1,847 keys (≈33% of the cache). Those requests will hit the origin until repopulated." A dialog that quantifies the blast radius is the only kind anyone actually reads.
- **Destructive actions show what will happen before they happen.** The console already knows the ring; it can compute which keys a node owns. Previewing the affected set turns an irreversible decision into an informed one.

### What I'd give up

This friction is real cost during an incident, when the operator may *need* to remove a node quickly. So the confirmation must be fast to clear — one keystroke, no typing the node name — and the preview must be already-computed rather than triggering a slow query at the worst moment. **Safety that adds latency to emergency actions gets routed around**, usually by someone curling the API directly, which loses the audit trail entirely.

> "The design goal is that nobody ever needs to bypass the console to move fast. The moment the safe path is slower than curl, the safe path stops being used."

---

## 🧪 The Live Test Console Writes to a Real Cluster

The console includes a set/get/delete panel that operates against the actual cache. That's an unusual thing to ship, and it's worth examining rather than glossing over.

**Why it earns its place:** the fastest way to understand consistent hashing is to type a key and watch which node claims it. Change one character, watch it land elsewhere. No diagram teaches that as well as doing it. For a system whose purpose is pedagogical, an interactive probe is the highest-value screen in the product.

**Why it's dangerous:** it is a production write endpoint with a friendly form in front of it. Someone exploring can overwrite a real key, and nothing about a text input suggests consequence.

The reconciliation I'd build:

| Concern | Approach |
|---------|----------|
| Accidental overwrite | Namespace test keys with a visible prefix, and default the input to it |
| Confusion with real traffic | Label results with the node that served them, so the routing lesson stays the point |
| Destructive exploration | Delete is available but never the default action; the panel opens in get/set mode |
| Blast radius | The panel operates on single keys only — no bulk, no patterns, no flush |

The last row is the important one. **The test console deliberately cannot express a dangerous operation.** Bulk and flush live elsewhere, behind the confirmation flow described above. Capability separation by screen is stronger than confirmation dialogs, because it removes the dangerous action from the context where someone is experimenting quickly.

> "I'd rather the exploratory tool be incapable of large damage than be capable and guarded. Guards get clicked through; missing features don't."

---

## 🧩 How Views Map to Questions

The console has four views, and each exists to answer one operator question:

| View | Question | Refresh behavior |
|------|----------|------------------|
| Overview | "Is anything wrong right now?" | Polls; the only view that should be left open |
| Cluster | "How is the keyspace distributed?" | Polls while visible |
| Keys | "What's actually cached, and where?" | On demand + explicit refresh — listings are expensive |
| Test | "Where does *this* key go?" | No polling; purely interactive |

Organizing by question rather than by resource is what keeps this from becoming a CRUD admin panel. A resource-oriented design would give me a Nodes page, a Keys page, and a Stats page — and the operator's actual first question, "is anything wrong", would require visiting all three and synthesizing.

**The overview is therefore the only page designed to be watched**, and it's the only one that polls unconditionally. That single decision resolves most of the load concern from Deep Dive 2: the expensive views are the ones nobody leaves open.

---

## 🚦 Loading, Empty, and Error States Are the Product

In a consumer app these are edge cases. In a monitoring console they're a substantial fraction of what gets displayed, and getting them wrong destroys trust in everything else.

**"No data" and "can't reach the coordinator" must never look the same.** An empty key list means the cache is empty; a failed request means the console doesn't know. Rendering both as an empty table tells the operator the cache is empty during an outage — the most damaging possible confusion in this UI.

| State | Treatment | Why |
|-------|-----------|-----|
| Loading (first) | Skeleton in place | Layout shouldn't jump when data arrives |
| Loading (refresh) | Keep previous data, show a subtle indicator | Blanking a live dashboard on every 5s poll makes it unreadable |
| Empty | Explicit "cache is empty" copy | Distinguishes from failure |
| Coordinator unreachable | Full-width banner, **previous data dimmed and timestamped** | Operator can still read the last known state, clearly marked as stale |
| Partial failure (one node down) | Render the cluster, mark that node | A single dead node must not blank the page — it's the thing they came to see |

The partial-failure row is the one people miss. If the topology request succeeds but one node's stats request fails, the naive implementation throws and shows an error page — hiding the healthy nodes and the very failure being diagnosed. **Per-node error isolation is a requirement, not a refinement.**

---

## 🗄️ State: Server Data Isn't Application State

The store holds cluster snapshot, key listing, and the test console's local form state — and the distinction between them is the organizing idea.

| Data | Owner | Lifetime |
|------|-------|----------|
| Node list, health, distribution | Server | Refetched; never mutated locally |
| Key listing | Server | Refetched; scoped to a ring epoch |
| Test console input/results | Client | Session-local, never persisted |
| Selected node / active tab | Client (URL) | Shareable — an operator pastes a link to a specific node |

**Nothing server-derived is edited locally.** There's no optimistic update anywhere in this console, and that's deliberate: an optimistic "key deleted" that then fails leaves the operator believing they've done something they haven't. In a diagnostic tool, showing the truth slightly later beats showing a hopeful guess immediately.

Selected node and active view live in the **URL**, not the store, because the primary sharing mechanism during an incident is pasting a link into chat. State that isn't in the URL can't be shared, and a console whose views can't be shared gets screenshotted instead.

---

## 🔑 Where the Admin Key Lives

Mutating endpoints require an admin API key, and a browser is a poor place to keep one. Worth addressing directly, because it's the security question this console actually raises.

**Any key the browser can send is a key the user can read.** Storing it in `localStorage`, in a store, or in a bundled env var are all the same thing from an attacker's perspective — an XSS on this page exfiltrates cluster-admin credentials. Vite inlines `VITE_`-prefixed variables into the built JavaScript, so "putting it in the environment" ships it to every visitor.

| Approach | Exposure | Practicality |
|----------|----------|--------------|
| ❌ Key baked into the bundle | Everyone who loads the page | Trivial, and wrong |
| ❌ Key in `localStorage` | Any XSS, persists across sessions | Common, still wrong |
| ✅ **Session cookie, `HttpOnly`** | Not readable by JavaScript | Requires the coordinator to accept a session |
| ✅ **Console behind a reverse proxy that injects the key** | Never reaches the browser | Best for an internal tool; no client changes |

For an internal operator console, the proxy option is the honest answer: the browser authenticates as a *person*, and the infrastructure attaches the cluster credential. The frontend then holds no secret at all, which is the only state that survives an XSS.

Given this project's local-first constraint, the key is supplied at runtime rather than bundled — which keeps it out of the artifact but not out of memory. **I'd call that out as the deliberate gap it is**, rather than describing the console as secure.

---

## 📊 Visualizing the Ring

The hash ring is the concept the console exists to make tangible, and it's the one thing a table can't convey.

Consistent hashing places 150 virtual nodes per physical node around a 2³² circle. The properties an operator needs to see are **whether distribution is even** and **how much moves when topology changes** — and those are spatial facts, not numeric ones.

- **A ring diagram** shows vnode interleaving directly: healthy distribution looks like evenly mixed colors, and a hot node looks like a visible arc.
- **A distribution bar** answers "is it balanced?" faster than the ring does, because comparing lengths is easier than comparing arc coverage.
- **During rebalance**, highlighting only the moving range makes the central claim of consistent hashing — that ~1/N moves, not everything — visible in one glance.

I'd render the ring with **inline SVG rather than a charting library**. It's a circle with colored arcs; a charting dependency would be larger than the code it replaces and would fight me on the one interaction that matters (hovering an arc to see the key range). This is the rare case where hand-drawn beats a library.

The honest limitation: with three nodes and 450 vnodes, an accurate ring is visually dense. I'd sample the render — draw the *distribution* faithfully without drawing all 450 marks — and say so in a caption, because a diagram that silently omits data is its own kind of lie.

---

## ♿ Status Must Not Be Color Alone

Node health is the primary signal on the page, and "green dot / red dot" fails roughly one in twelve men with a red-green deficiency — a population well represented among on-call engineers.

Every status carries a **shape and a word**, not just a hue: healthy, degraded, and unreachable are distinguishable in grayscale. Health changes are announced through a polite live region so a screen-reader user learns a node went down without re-reading the table.

The same principle applies to the distribution bar: relying on color to separate node segments makes it unreadable for the same users, so segments are labeled directly.

---

## 🔬 Testing an Interface to a Moving System

The interesting tests here don't assert that components render — they assert the UI stays truthful while the cluster misbehaves.

| Scenario | Simulation | What it protects |
|----------|-----------|------------------|
| Mid-rebalance render | Snapshot with an in-flight migration | The composite-lie problem from Deep Dive 1 |
| Coordinator unreachable | Reject all requests | Stale data stays visible and marked, not blanked |
| One node down | Partial-failure fixture | Per-node isolation; page still renders |
| Epoch change during browse | Bump the ring version between fetches | Key listing marked stale rather than silently mixed |
| Background tab | Fire `visibilitychange` | Polling actually backs off |
| Destructive confirm | Attempt node removal | Blast-radius preview computed and shown before commit |

The last two are the ones a normal test suite never covers and that matter most operationally — one is the load-amplification bug, the other is the "console caused the outage" bug.

I'd write these against **fixture snapshots rather than a live cluster.** A test that needs three cache nodes running is a test that gets skipped. Serializing a few coordinator responses — healthy, rebalancing, degraded, unreachable — gives full coverage of the states that matter and runs in milliseconds.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Data freshness | ✅ 5s poll + visible timestamp | ❌ Sub-second polling | Dashboards must not amplify the incidents they display |
| Upgrade path | ✅ SSE when needed | ❌ WebSocket | One-way data; no client→server channel required |
| Consistency | ✅ One coordinated snapshot | ❌ Independent panel fetches | Composite views lie during rebalance |
| Stale detection | ✅ Ring epoch on responses | ❌ Timestamps alone | Epoch tells you the *topology* changed, not just the clock |
| Mutations | ✅ Confirm on write, never on read | ❌ Uniform confirmations | Uniform dialogs train people to dismiss them |
| Danger UX | ✅ Quantified blast radius | ❌ "Are you sure?" | Only a specific consequence gets read |
| Optimism | ✅ None | ❌ Optimistic updates | A diagnostic tool must not display hoped-for state |
| Shareable state | ✅ URL | ❌ Store-only | Incident response is collaborative |
| Ring rendering | ✅ Inline SVG | ❌ Charting library | Bigger than the code it replaces; fights the key interaction |

---

## 🚀 What Breaks First

**Polling amplification, before anything visual.** Several open tabs during an incident multiply coordinator load exactly when it's scarce. Visibility-based backoff first, SSE second.

**Then the key browser.** Listing keys is unbounded by nature — a real cache holds millions. The current listing works because the dataset is small; at scale it needs server-side pagination and search, and the UI should refuse to render an unbounded list rather than freezing while it tries.

**Then ring rendering**, at high node counts, where SVG arc count grows and the diagram stops being readable before it stops being fast. That's a design limit, not a performance one — past a certain cluster size a ring diagram is the wrong visualization and a distribution histogram is the right one.

Notably absent from this list: the usual frontend concerns. There's no bundle-size problem, no render-performance problem, and no state-management complexity. **An operator console fails on trustworthiness and safety, not on speed** — which is why those got the deep dives.

---

## 📝 Summary

Three ideas:

1. **Render one coherent snapshot, not several independent truths.** A distributed system's console must never compose a view from reads taken at different moments — that's precisely how it misleads during the topology changes it exists to show.
2. **The observer must not perturb the observed.** Polling interval, per-view fetching, and background backoff are correctness decisions here, not optimizations, because the tool's load lands on the component whose health is in question.
3. **Match friction to blast radius.** Reads are free, single keys are cheap, and node removal is a stampede against the origin — so the UI quantifies consequences rather than asking a generic question, and never makes the safe path slower than bypassing it.

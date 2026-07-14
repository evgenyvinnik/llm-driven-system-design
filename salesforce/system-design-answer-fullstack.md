# Salesforce CRM - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 📋 Problem Statement

Design a multi-tenant CRM end to end: accounts, contacts, opportunities, leads, and activities; a kanban sales pipeline; an atomic lead-conversion workflow; and dashboards over the whole book of business.

Because this is the full-stack framing, I'm going to organize the answer around **the seams** — the places where a client decision forces a server decision, or where a server guarantee determines what the UI is allowed to promise. Those seams are where CRMs actually go wrong, and they're invisible if you design the two halves separately:

- A drag on the board must feel instant, which forces optimistic updates on the client — which forces **optimistic concurrency on the server**, or two reps silently overwrite each other.
- Every read is permission-filtered by a sharing hierarchy, which means the dashboard number is **per-user** — which destroys the obvious server-side cache *and* the obvious client-side cache, at once.
- Customers define their own fields, which means the form is rendered from a **schema the server ships as data** — a contract, not a payload.
- Lead conversion creates entities whose IDs the client cannot predict, which is why it's the one mutation that **can't** be optimistic.

## 🎯 Requirements Clarification

- **Multi-tenant?** Yes. Thousands of orgs on shared infrastructure. This determines the data model, so I want it answered first.
- **Who sees what?** Record-level sharing: ownership plus a role hierarchy (a manager sees their reports' deals). It's a filter on *every* read, client and server.
- **Custom fields?** Yes, per org, up to ~100 on a hot object.
- **Session shape?** Reps keep the app open all day in one tab. That makes client cache coherence and memory first-class concerns, not afterthoughts.
- **Dashboard freshness?** Minutes are fine. Wrong numbers are not.

### Functional Requirements

- CRUD across accounts, contacts, opportunities, leads
- Kanban pipeline with drag-to-move stage transitions
- Atomic lead conversion → account + contact + optional opportunity
- Polymorphic activity logging against any entity
- Dashboard KPIs and reports (pipeline, revenue, lead source)
- Custom fields without a deploy

### Non-Functional Requirements

| Requirement | Target | Consequence |
|-------------|--------|-------------|
| CRUD p99 | < 200ms | Index on `(org_id, …)` for every access path |
| Dashboard p99 | < 500ms | Cannot aggregate 5M rows per request → pre-aggregation |
| Drag feedback | < 100ms perceived | Optimistic client + version-checked server |
| Tenant isolation | Absolute | Row-Level Security, not developer discipline |
| Availability | 99.9% business hours | Reps live here; an outage stops revenue work |
| Memory (client) | Flat over 8 hours | Normalized cache + LRU eviction |

### Scale Estimates

- ~50K orgs, brutally skewed: most have 10 users, a few have 50,000. **The skew is the problem**, not the total.
- 10M+ accounts, ~5M opportunities, **~200M activities** (activities dominate — every call and note is a row)
- Read:write ≈ **20:1**. CRM is overwhelmingly a reading tool.
- Reports: ~2% of requests, each touching millions of rows. The expensive minority.

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    React SPA (all-day tab)                   │
│  Sidebar │ Dashboard │ Kanban │ Lists │ Detail │ Reports     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Normalized entity cache (one copy per record, by id)  │ │
│  │  + query index (queryKey → [ids])                      │ │
│  │  + field metadata (the org's schema, from the server)  │ │
│  └───────────────┬────────────────────┬───────────────────┘ │
│    optimistic    │                    │ pessimistic          │
│    (stage, edit) │                    │ (create, convert)    │
└──────────────────┼────────────────────┼──────────────────────┘
                   │  REST + version headers
                   ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│  API Gateway — authn, per-org rate limits                     │
│  Injects org_id from the SESSION, never from the request      │
└──┬──────────┬──────────┬──────────┬──────────┬───────────────┘
   ▼          ▼          ▼          ▼          ▼
┌───────┐┌───────┐┌────────┐┌───────┐┌──────────┐
│Account││Contact││  Opp   ││ Lead  ││ Activity │  ← every read is
└───┬───┘└───┬───┘└───┬────┘└───┬───┘└────┬─────┘    sharing-filtered
    └────────┴────────┼─────────┴─────────┘
                      ▼
┌────────────────┐ ┌────────┐ ┌────────────────────────┐
│  PostgreSQL    │ │ Redis  │ │  Rollup worker         │
│  org_id + RLS  │ │sessions│ │  (org, owner, stage)   │
│  on every row  │ │ + tree │ │  ← this is the answer  │
└───────┬────────┘ │  cache │ │    to the dashboard    │
        │          └────────┘ └────────▲───────────────┘
        └───────────── CDC ─────────────┘
```

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| orgs | id, name, plan, settings | — | The tenant |
| users | id, **org_id**, email, password_hash, role_id | unique(org_id, email) | Email unique *within* an org — two orgs can both have `sales@acme.com` |
| roles | id, org_id, name, parent_role_id | (org_id) | Self-referencing tree = the sharing hierarchy |
| accounts | id, **org_id**, name, industry, annual_revenue_cents (BIGINT), owner_id, custom (JSONB) | (org_id, owner_id), (org_id, name) | |
| contacts | id, org_id, account_id, name, email, title, owner_id, custom | (org_id, account_id) | No unique on email — a shared `support@` inbox legitimately appears at two companies |
| opportunities | id, org_id, account_id, name, amount_cents, stage, probability, close_date, owner_id, **version**, custom | (org_id, stage), (org_id, owner_id) | `version` is what makes optimistic UI safe |
| leads | id, org_id, name, company, source, status, **converted_account_id / _contact_id / _opportunity_id**, converted_at, owner_id | (org_id, status), (org_id, source) | The three FKs are the conversion audit trail |
| activities | id, org_id, type, subject, **related_type**, **related_id**, owner_id, due_date | (org_id, related_type, related_id) | Polymorphic; no FK |
| custom_fields | id, org_id, entity_type, field_name, field_type, options | unique(org_id, entity_type, field_name) | The org's schema, as data — **and an API contract** |
| report_rollups | org_id, owner_id, report_key, dimension, metric, computed_at | unique(org_id, owner_id, report_key, dimension) | Pre-aggregated per record-*owner* |

**Money is BIGINT cents**, so summing 10,000 deals is exact integer arithmetic. The client formats for display and never computes on floats.

**Leads keep three nullable FKs after conversion** rather than being deleted, because reporting must answer "what fraction of Web leads became closed-won revenue" — which requires the join from lead → opportunity. Deleting the lead destroys the org's ability to measure its own lead-source ROI, which is a core CRM value proposition.

**Activities are polymorphic with no FK.** We lose referential integrity; the payoff is that the unified "everything that happened on this account" timeline is one query, and one client component, for all four entity types. Orphans are harmless on an append-only log, and a nightly reaper cleans them.

## 🔌 API Design

```
GET    /api/accounts?q=&industry=&page=      List (search, filter, paginate)
POST   /api/accounts                         Create
PUT    /api/accounts/:id                     Update
GET    /api/accounts/:id/contacts            Sub-resource
GET    /api/accounts/:id/opportunities       Sub-resource

PUT    /api/opportunities/:id/stage          Kanban move — REQUIRES version
POST   /api/leads/:id/convert                Atomic conversion (Idempotency-Key)

GET    /api/activities?related_type=&related_id=   Polymorphic timeline
POST   /api/activities                       Log a call/email/meeting/note

GET    /api/dashboard                        KPIs for the CALLING USER
GET    /api/reports/pipeline | revenue | leads

GET    /api/metadata/fields?entity=account   The org's field schema
```

Two contract decisions that are really seam decisions:

- **`org_id` never appears in a URL or body.** A tenant identifier the client can supply is one the client can forge. It comes from the session, always.
- **The stage endpoint is separate from the general update, and it requires a version.** That's not REST pedantry — it's the client's optimistic UI reaching back and imposing a requirement on the API, which I'll unpack next.

## 🔧 Deep Dive 1: The Kanban Seam — Optimism on the Client Requires Versioning on the Server

This is the cleanest example of a decision that cannot be made on one side of the stack.

**The client's need.** A drag must feel instant. Waiting for a round-trip — 200ms on a good connection — means the card snaps back, sits there, then jumps. Users read that as broken. So the client applies the change locally, immediately, and reconciles afterward.

**The problem that creates.** Two reps have the board open. Dana drags the Acme deal to Closed Won at 10:00:03. Sam, whose board still shows it in Negotiation, drags it to Proposal at 10:00:07. Both clients applied their change optimistically. Both send an update.

**How last-write-wins concretely breaks.** Sam's write lands second and wins. Dana's Closed Won is gone. Nobody is told. The deal is now in Proposal, the forecast is wrong, and Dana finds out at quarter close. Worse — Dana's UI still shows Closed Won, because *her* optimistic update succeeded and nothing invalidated it. The two reps are now looking at different truths, and the system considers this a completely successful pair of requests.

**The fix has to be on both sides, and it's one contract:**

- **Server**: `opportunities.version` increments on every write. The stage endpoint takes the client's expected version. If it doesn't match, return **409 with the current server state** — not a bare error, the actual current record.
- **Client**: on 409, do *not* roll back to the pre-drag snapshot. Write the **server's state** into the cache and tell the user who changed it: "Dana moved this to Closed Won two minutes ago."

> "The rule I'd hold: an optimistic update may be rolled back, but **never rolled back to a value we already know is stale.** Most implementations catch the error, revert to the snapshot, and show a toast — which is correct for a network failure and actively harmful for a conflict, because it puts a *newly stale* value on screen and invites the user to drag again and overwrite their colleague for real. The optimistic UI would then have caused the exact data loss the version check exists to prevent. So: three failure modes — network, 409, validation — three genuinely different responses. Collapsing them into one `catch` block is the most common bug in optimistic UIs."

**Never auto-retry a 409.** An auto-retry means "silently overwrite my colleague," which is the thing we just built machinery to prevent.

**What we give up:** reps occasionally see a conflict dialog, which is friction. The honest fix is real-time push ("this deal changed") so the board updates while they watch — turning conflict *detection* into conflict *avoidance*. That's the next feature, and it's cheap to add precisely because the client keeps exactly one copy of each entity, so an incoming change has exactly one place to land.

**One more seam detail:** the server returns the derived `probability` with the response, and the client uses it rather than computing the stage→probability mapping itself. Duplicating that rule in the client means it now lives in two codebases and will drift — and a forecast built on a drifted mapping is silently wrong, which is the worst kind of wrong.

## 🔧 Deep Dive 2: The Dashboard Seam — Sharing Rules Break Caching on *Both* Sides

Here's the constraint that makes CRM reporting genuinely hard, and it bites the frontend and the backend in the same way.

**Every user sees a different subset of records.** A rep sees their own deals. Their manager sees the team's, via the role hierarchy. A VP sees several teams. So "pipeline by stage" is not one number per org — **it is one number per user.**

That kills the obvious design on *both* sides of the wire:

| Layer | Naive approach | How it concretely breaks |
|-------|----------------|--------------------------|
| Server | ❌ Cache `dashboard:{org_id}` | Wrong for everyone but the admin. A rep would see the whole company's pipeline — a data leak *and* a wrong number |
| Server | ❌ Cache `dashboard:{user_id}` | Correct, but hit rate collapses: any write in a user's visible set invalidates it, and one closed deal invalidates hundreds of users' entries. You spend more on invalidation than you saved |
| Server | ❌ Compute live per request | `GROUP BY stage` over 5M opportunities joined to the sharing tree, on every load. Fine on average; catastrophic at 9am Monday when the whole sales org opens the app inside ten minutes |
| Client | ❌ Cache the dashboard response | Same problem, shipped to the browser: it's only valid for *this* user, and it's invalidated by any deal move — including one they just did on the kanban board |

**The design: pre-aggregate on the dimension that's viewer-independent; filter on the dimension that isn't.**

The insight: visibility is a property of the record's **owner**, and the role hierarchy is a **tree** — a manager's visible set is exactly their subtree. So:

1. A **rollup worker** consumes a change stream from `opportunities` and maintains `report_rollups` per **(org, owner, stage)**. Note what that is *not*: it's not per-viewer. It's per record-owner, which is a fact about the data, not about who's looking at it.
2. A dashboard request resolves the caller's **visible owner set** — their role subtree — from a Redis cache that only changes when someone's role changes (rare).
3. The response is a **sum over pre-aggregated rows for those owners.** One row for a rep. Two hundred for a VP. Trivially fast, and *completely independent of how many opportunities those reps have.*

We turned "aggregate 5M rows under a permission filter" into "sum 200 integers." The heavy work happens once per write, in a worker, off the request path.

**The client seam.** Now the frontend has an easy job — but only if it respects the same rule: **cache the aggregate, never the entity.** The dashboard response can be cached in the client store; the *individual opportunity* it summarizes must always come from the normalized entity cache, which is kept truthful by mutations. If the client caches a denormalized dashboard blob containing deal details, it will show a stale deal alongside a fresh one, and the two will disagree on screen. The KPI card is a summary. The record is the record. They are different kinds of data and they get different cache lifetimes — which is a rule the client and server have to agree on explicitly, or one of them will get it wrong.

**What we give up: staleness.** Rollups lag by seconds to a minute. That's why I asked about dashboard freshness up front — for an aggregate, a minute is invisible; nobody trades on second-by-second movement in a pipeline total. And a rep who just closed a deal gets a read-your-writes overlay: the server patches their own recent changes on top of the rollup, so *their* action is always reflected even if the aggregate hasn't caught up. Other people's deals can lag; yours can't, because you'd notice.

**The weakness I'd name aloud:** this assumes sharing is a *tree*. Real sharing rules include criteria-based sharing ("everyone in EMEA sees EMEA deals"), which is a **set**, not a subtree, and it breaks the clean "sum over my subtree" trick. Handling that means materializing each user's visible-owner set and accepting a larger, staler cache — the concession real systems make and whiteboard designs pretend not to need.

## 🔧 Deep Dive 3: The Schema Seam — Custom Fields as an API Contract

Customers add fields. That single product requirement reaches through every layer: storage, query, API, form rendering, and validation.

**Storage — why JSONB, not EAV.** The killer case is the report a power user actually runs: "pipeline by Deal Region, filtered to Renewal Risk = High, showing Competitor." Three custom fields. Under EAV, each value is a row in a side table — so that's **three self-joins** onto a table holding, at 5M opportunities × 40 fields, ~200M rows. The planner has no useful statistics, because the table is a bag of unrelated values. What should be an index range scan becomes hundreds of millions of random lookups, and the 500ms budget is blown by an order of magnitude. **EAV degrades in proportion to how many custom fields appear in one query — which is exactly what power users do.** With a JSONB column on the entity, that report is one predicate on one row.

**The contract — `custom_fields` is served to the client as metadata.** The table stays; it just stops holding values and starts being the **schema**. On login, the client fetches the org's field descriptors (name, type, options, required-ness) and caches them for the session.

**The client — forms are rendered, not written.** A dynamic form maps each descriptor to an input via a type→renderer registry, and validation is *generated from the same descriptors*. That's the seam working correctly: the client's validation rules and the server's validation rules come from a single source and therefore cannot drift. The alternative — hardcoding forms and bolting a "Custom Fields" section onto the bottom — gives standard and custom fields different validation, layout, and error handling, so the custom ones (the ones the customer cared enough to create) permanently feel second-class.

**What we give up, on both sides.** The server loses database-level type enforcement: a coercion bug writes `"50000"` where `50000` belongs and PostgreSQL accepts it. The client loses compile-time type safety at the boundary. Mitigations: validate at exactly one server chokepoint (the write path reads `custom_fields` and coerces), run a background auditor for type violations, and generate client types for known fields while validating the custom bag at runtime. Both are genuinely weaker than a static schema — and both are the unavoidable price of a capability that cannot be built any other way. The failure mode of EAV is *the product is too slow to use*; the failure mode of JSONB is *a validation bug we can find and fix.* Those are not equivalent risks.

## 🔄 The Conversion Seam: Why This One Mutation Can't Be Optimistic

Kanban is optimistic. Lead conversion isn't — and the reason is a rule worth stating, because it decides the treatment of every mutation in the app.

**Optimism is affordable exactly when the client can predict the server's answer.**

| Mutation | Predictable? | Treatment |
|----------|-------------|-----------|
| Stage change | Yes — same record, known new value | ✅ Optimistic |
| Field edit | Yes | ✅ Optimistic |
| Delete | Yes — the record is gone | ✅ Optimistic, with undo |
| Create entity | No — the server generates the ID | ⚠️ Pessimistic (temp-ID reconciliation only if the UX demands it) |
| **Lead conversion** | **No — three unpredictable IDs, cross-entity** | ❌ **Firmly pessimistic** |

Conversion creates an account, a contact, and an opportunity, each with a server-generated ID the client cannot know. There's no optimistic state to apply. You could fabricate temp IDs and rewrite every reference across the normalized cache when the real ones arrive — a lot of machinery for a workflow a rep does a few times a day and already expects to take a beat.

**On the server, it's one transaction, and I'd fight for that.** Verify the lead is unconverted, insert account → contact → optional opportunity, update the lead with the three resulting IDs, commit. Any failure rolls back all four writes and the lead is untouched.

**Why not a saga?** A saga is what you build when you *can't* have a transaction — entities in different services, different databases, no shared ACID boundary. Here they're in one database. A saga means an orchestrator, an event per step, and hand-written compensations ("delete the account we just made") that are themselves fallible and must be idempotent. That's an order of magnitude more code to reconstruct — worse — a guarantee the database already gives us. `ROLLBACK` is not a best-effort compensation; it's a guarantee.

**The rule that keeps it safe:** **zero external calls inside the transaction boundary.** The classic failure is someone adding "send a welcome email" inside it; the mail provider hangs for 30 seconds; the conversion now holds row locks for half a minute and the connection pool exhausts. Side effects go into an outbox row written *inside* the transaction and processed *after* commit.

And this is the strongest argument for **keeping these five objects in one service and one database as long as possible**: the transactional boundary should follow the *workflow* boundary, and conversion is the workflow that binds them. Splitting them apart is not a free refactor — it's a decision to take on distributed transactions, and it should be made deliberately, not by an org chart.

## 🔎 End-to-End Trace: One Drag, Both Halves

Worth walking once, because it touches every seam in the design.

```
 rep drops "Acme Renewal" on Closed Won
        │
        ▼  CLIENT
 ┌───────────────────────────┐
 │ snapshot old stage        │
 │ cache.opps[id].stage = …  │  ← board repaints in ~0ms.
 │ push to mutation queue    │     This is the entire reason
 └────────────┬──────────────┘     any of the rest exists.
              ▼
     PUT /opportunities/:id/stage   { stage, version: 7 }
              │
              ▼  SERVER
 ┌───────────────────────────┐
 │ 1. session → org_id       │  never from the request
 │ 2. RLS-bound connection   │  a missing predicate = 0 rows
 │ 3. sharing check: may this│
 │    user edit this record? │
 │ 4. UPDATE … WHERE version │
 │    = 7  → 0 rows? 409.    │
 │ 5. derive probability     │  server owns the mapping
 │ 6. emit change event      │  → CDC
 └────────────┬──────────────┘
      ┌───────┴────────┐
      ▼                ▼
 200 + record     409 + CURRENT record
   (version 8)      (version 9, Closed Won, by Dana)
      │                │
      ▼  CLIENT        ▼  CLIENT
 replace optimistic  write SERVER's state (roll FORWARD)
 value with server   + "Dana moved this 2m ago"
 truth               + do NOT auto-retry
      │
      └──────────▶ meanwhile, async:
                   CDC → rollup worker → report_rollups
                   → every affected user's dashboard is
                     now correct, without anyone recomputing
                     a GROUP BY over 5M rows
```

The thing to notice: the *fast* path (repaint) and the *correct* path (version check) and the *aggregate* path (rollup) are three different timescales — 0ms, 200ms, and up to a minute — and each one is allowed to be exactly as slow as its consumer can tolerate. Collapsing them into one synchronous request is what makes CRMs slow; collapsing them into one *optimistic* fire-and-forget is what makes them wrong.

## 📊 Observability Across the Seam

The metrics that matter here are mostly not the standard ones, and several only make sense when you look at both halves together.

| Signal | Layer | Why it's the right one |
|--------|-------|------------------------|
| p99 latency **per org** | Server | Aggregate p99 hides the one enormous tenant whose queries are dying. In multi-tenant systems, per-tenant SLOs are the only honest ones |
| **Queries run without a tenant predicate** | Server | Must be exactly **zero**. Alarm at one. This is the invariant that ends the company if it breaks |
| Rollup worker lag | Server | Directly bounds dashboard staleness. If it grows, dashboards are quietly lying and nobody can tell |
| **409 rate on stage changes** | Both | A rising conflict rate is a *product* signal wearing an error-metric costume: reps are colliding, and the answer is real-time push, not a better error message |
| Drag-to-repaint latency | Client | The optimistic update's whole justification. Above ~50ms, the optimism is buying nothing |
| Client cache hit rate on navigation | Client | Measures whether the normalized cache is working. A falling rate means someone reintroduced a per-route fetch |
| Mutation-queue depth | Client | Sustained depth means the network is failing and the rep's work is piling up unsaved — the most user-hostile state the app can reach |
| Heap size at hour 4 vs. hour 1 | Client | The eight-hour-tab metric. Nothing else catches an eviction bug |

Largest Contentful Paint, the metric everyone reaches for, is nearly irrelevant here — users load this app once a day. What matters is the *thousandth* interaction, not the first.

## 🧭 Consistency Model

| Data | Guarantee | Client implication |
|------|-----------|--------------------|
| Entity CRUD | Strong, read-your-writes | Safe to render optimistically |
| Kanban stage | Strong + optimistic concurrency | Client must send `version`; must handle 409 by rolling *forward* |
| Lead conversion | Serializable, atomic | Client must be pessimistic; show real progress |
| Dashboard / rollups | Eventual (≤ ~1 min) | Cache the aggregate; never cache the entity inside it |
| Search | Eventual (seconds) | A record appearing in search 2s late is not a bug anyone notices |
| **Sharing / role changes** | **Strong + synchronous cache bust** | A revoked permission lingering in *either* cache is a data leak |

The last row is the one people get wrong. Almost everything about permissions is safe to cache — except **revocation**, which must be immediate, on the server *and* in the browser. That write path is deliberately slow-but-correct.

## 🛡️ Failure Handling

| Failure | Server behavior | What the user sees |
|---------|-----------------|--------------------|
| Rollup worker down | Serve stale rollups with `computed_at` | Dashboard labeled "as of 10:42" — degraded, honest, still useful |
| Elasticsearch down | Fall back to a prefix query in PostgreSQL | Narrower search results; the app works |
| Redis down | Sessions fail | Hard outage. The single biggest fragility — 50K reps logged out at once. First place I'd invest in replication |
| PostgreSQL primary down | Writes fail loudly; reads from replica | Read-only mode with an explicit banner, not silent failures |
| Network flaky (client) | — | Mutations queue and retry with backoff; reads fall back to cache with a "showing data from 3:42pm" label |
| **Session expires mid-drag** | 401 | Client **preserves the pending mutation**, re-auths inline, replays. Redirecting to `/login` and discarding the rep's work is the fastest way to make someone hate the tool |

Circuit breakers wrap Elasticsearch and external integrations so a slow dependency fails fast rather than consuming the connection pool and taking down endpoints that never touch it. The rule: **degrade the fancy features; never degrade the record of truth.**

## 🔐 Security

- **Tenant isolation is structural**: `org_id` on every row, PostgreSQL Row-Level Security keyed on a session variable, a repository layer that owns connection checkout, and **org-namespaced cache keys on both sides of the wire**. A forgotten predicate returns zero rows, not everyone's rows. Isolation cannot depend on remembering.
- **Sharing is enforced in the data layer**, never in the UI. A hidden button is not a permission — and in a CRM, the API is the product's public surface whether you documented it or not.
- **Sessions in Redis, server-side revocable**, not JWTs. Offboarding a rep must revoke access *now*, not in 15 minutes, for a system holding the entire customer list.
- **Rate limits tiered by cost**: generous for CRUD, strict for reports (each is potentially a multi-million-row scan), strictest for auth.

## 📈 Scalability: What Breaks First

1. **Dashboard aggregation** — first by a wide margin, because it's the only thing scanning millions of rows. The rollup worker is the fix, and it's the first thing I'd build after CRUD works.
2. **Search via SQL `LIKE`** — dies past a few hundred thousand rows, because a leading-wildcard match can't use a B-tree and becomes a sequential scan of the whole tenant's data. Elasticsearch fed by CDC, with **tenant-scoped indices** so a query is physically incapable of reaching another org.
3. **The `activities` table** — largest by an order of magnitude, growing fastest, and only ever read by `(related_type, related_id)`. Partition by time; archive cold partitions. Automated logging (email sync, call tracking) gets buffered through a queue and batch-inserted, so an integration burst never reaches the OLTP path where reps are working.
4. **The big-tenant skew** — long before *total* volume hurts, *one* org with 50K users will. That org gets its own shard. This works only because `org_id` is on every row and cross-org queries don't exist. The multi-tenancy decision is what makes the escape hatch exist at all.
5. **On the client**: the unfiltered list view at a few thousand rows (virtualize + server-paginate), and unmemoized selectors over a growing normalized cache (memoize, subscribe narrowly).

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Tenancy | ✅ Shared schema + `org_id` + RLS | ❌ DB/schema per tenant | 50K migrations per deploy is unshippable; RLS makes the risk mechanical |
| Kanban concurrency | ✅ Optimistic client + `version` on server | ❌ Last-write-wins | Silent overwrite of a colleague's deal is a business loss |
| 409 handling | ✅ Roll *forward* to server truth | ❌ Roll back to snapshot | Rolling back to a known-stale value invites a real overwrite |
| Dashboards | ✅ Rollups per (org, owner, stage) + sum over role subtree | ❌ Cache per org / per user / compute live | Sharing rules make results per-viewer, so pre-aggregate per record-*owner* |
| Custom fields | ✅ JSONB + metadata as an API contract | ❌ EAV | EAV needs a self-join per field; three-field reports die |
| Lead conversion | ✅ One DB transaction; outbox for side effects | ❌ Saga | Compensations reimplement, worse, a guarantee we already have |
| Client data layer | ✅ Normalized cache, one copy per entity | ❌ Per-route arrays | The same deal renders on three screens; duplication guarantees they disagree |
| Sessions | ✅ Redis, server-side | ❌ JWT | Offboarding must revoke *now* |
| Activities | ✅ Polymorphic `(related_type, related_id)` | ❌ Join table per entity | One timeline query, one client component; orphans are harmless on a log |
| Money | ✅ BIGINT cents | ❌ float | Forecasts must equal the sum of their deals |

## 🚀 Closing

The unifying idea across all three seams: **decide what each side is allowed to assume about the other, and write it into the contract rather than the comments.** The client may be optimistic only where it can predict the server's answer — so the server must return a version, and the client must handle a conflict as new truth rather than as an error. The dashboard is per-viewer, so neither side may cache it as if it were per-org. The schema belongs to the customer, so the server ships it as data and the client renders from it rather than hardcoding it.

Next, I'd build the **workflow/automation engine** — "when a deal hits Negotiation, notify the manager." Architecturally it's a rules engine consuming the same change stream the rollup worker already uses, which is the real payoff of building CDC for reporting: automation, search indexing, and rollups become three consumers of one event log, and none of them belong on the write path. And I'd add real-time push to the board, which upgrades the conflict story from *detection* to *avoidance* — cheap to do, precisely because the client already keeps exactly one copy of every record.

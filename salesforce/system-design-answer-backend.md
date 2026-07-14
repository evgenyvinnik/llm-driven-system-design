# Salesforce CRM - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a CRM: accounts, contacts, opportunities, and leads moving through a sales pipeline, a kanban board driving stage transitions, a lead-conversion workflow that must never leave data half-written, polymorphic activity logging, and dashboards that sales managers refresh dozens of times a day.

CRM looks like a CRUD app. That framing is the trap. Three things make it genuinely hard, and none of them are CRUD:

1. **It is multi-tenant.** Thousands of companies share the same infrastructure and must never see each other's data — not through a bug, not through a missing predicate, not through a cache-key collision.
2. **The schema is not ours.** Every customer adds custom fields. The data model is *defined by users at runtime*, which means the thing relational databases are best at — a fixed schema with tight indexes — is the thing we can't fully have.
3. **Every read is permission-filtered.** Two reps in the same org running the same report see different numbers, because they can see different records. That single fact destroys the obvious caching strategy, and it is the most interesting constraint in the system.

## 🎯 Requirements Clarification

Questions I'd ask before designing anything:

- **Multi-tenant SaaS, or one deployment per customer?** Multi-tenant. This is the question that determines the data model, so I want it answered first, not at the end.
- **Who can see what?** Record-level sharing: ownership, a role hierarchy (a manager sees their reports' deals), plus explicit shares. This is not an afterthought — it's a filter on every single read.
- **Can customers change the schema?** Yes. Assume up to ~100 custom fields on a hot object for a mature org.
- **How stale can a dashboard be?** Minutes, not seconds. A pipeline number that lags a minute is fine. A pipeline number that's *wrong* is not.
- **Is lead conversion the only multi-entity transaction?** For now, yes — which determines whether a general saga framework is worth building or a targeted transaction suffices.

### Functional Requirements

- CRUD across accounts, contacts, opportunities, leads
- **Lead conversion**: one lead becomes an account + contact + optional opportunity, atomically
- **Pipeline**: opportunities grouped by stage; kanban drag moves a deal between stages
- **Activities**: polymorphic — a call, email, meeting, or note attaches to *any* entity
- **Reports**: pipeline by stage, revenue by month, leads by source
- **Custom fields**: user-defined, per org, queryable and reportable
- Search and filter across all entity types

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Availability | 99.9% during business hours | Reps live in this tool 8 hours a day; an outage stops revenue work |
| Entity CRUD | p99 < 200ms | It's a form. Anything slower feels broken |
| Dashboard / report | p99 < 500ms | Users tolerate a beat on an aggregate; not five seconds |
| Tenant isolation | Absolute | A cross-tenant leak is a company-ending event, not a bug |
| Lead conversion | Atomic; zero partial states | A half-converted lead is unrecoverable *by the user* |
| Scale | 50K concurrent users, 10M+ accounts | Search must stay sub-second at that size |

### Scale Estimates

- ~50K orgs. The distribution is brutally skewed: most have 10 users, a handful have 50,000. **The skew is the design problem**, not the total.
- 10M+ accounts, ~30M contacts, ~5M opportunities, **~200M activities**. Activities dominate — every call, email, and note is a row.
- Read:write ratio around **20:1**. CRM is overwhelmingly a reading tool.
- Reports are the expensive minority: ~2% of requests, but each touches millions of rows.
- Custom fields: 20–100 per object for a mature org. That number is what kills the naive designs below.

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Clients (web, mobile)                     │
└─────────────────────────┬────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────┐
│    API Gateway — TLS, authn, per-org rate limits              │
│    Injects tenant context (org_id) from session, never URL    │
└──┬────────┬─────────┬──────────┬─────────┬───────────────────┘
   ▼        ▼         ▼          ▼         ▼
┌───────┐┌───────┐┌────────┐┌───────┐┌──────────┐
│Account││Contact││  Opp   ││ Lead  ││ Activity │  ← every read is
│Service││Service││Service ││Service││ Service  │    sharing-filtered
└───┬───┘└───┬───┘└───┬────┘└───┬───┘└────┬─────┘
    └────────┴────────┼─────────┴─────────┘
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
┌───────────────┐ ┌────────┐ ┌──────────────────┐
│  PostgreSQL   │ │ Redis  │ │  Elasticsearch   │
│  (primary)    │ │sessions│ │ tenant-scoped    │
│  org_id on    │ │ sharing│ │ indices          │
│  every row +  │ │ tree   │ └────────▲─────────┘
│  RLS policies │ │ cache  │          │
└──────┬────────┘ └────────┘          │ CDC
       │                              │
       ├───────────────┬──────────────┘
       ▼               ▼
┌──────────────┐ ┌──────────────────────────┐
│ Read replica │ │ Rollup worker            │
│ (ad-hoc      │ │ maintains report_rollups │
│  reports)    │ │ per (org, owner, stage)  │
└──────────────┘ └──────────────────────────┘
```

The load-bearing choice: **`org_id` is a mandatory column on every table and a mandatory predicate on every query**, enforced by the database and the data-access layer rather than trusted to individual queries.

A note on the service boxes: they're domain modules, not necessarily six deployables. The boundaries are drawn where the *domain* boundaries are, because lead conversion has to call into account, contact, and opportunity creation, and that logic wants a clean interface either way. Whether those are function calls or network calls is a deployment decision I'd defer — and, as Deep Dive 2 shows, there's a strong argument for keeping these five objects in one database for as long as possible.

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| orgs | id, name, plan, settings (JSONB) | — | The tenant. Everything below hangs off it |
| users | id, **org_id**, email, password_hash, role_id | unique(org_id, email) | Email is unique *within* an org, not globally — two orgs can both have `sales@acme.com` |
| roles | id, org_id, name, parent_role_id | (org_id) | Self-referencing tree — this *is* the sharing hierarchy |
| accounts | id, **org_id**, name, industry, annual_revenue_cents (BIGINT), owner_id, custom (JSONB) | (org_id, owner_id), (org_id, name) | Money in cents, never float |
| contacts | id, org_id, account_id, name, email, title, owner_id, custom | (org_id, account_id) | No unique constraint on email — a shared `support@` inbox legitimately appears on contacts at different companies |
| opportunities | id, org_id, account_id, name, amount_cents, stage, probability, close_date, owner_id, **version**, custom | (org_id, stage), (org_id, owner_id), (org_id, close_date) | `version` drives optimistic concurrency on kanban moves |
| leads | id, org_id, name, company, source, status, **converted_account_id**, **converted_contact_id**, **converted_opportunity_id**, converted_at, owner_id | (org_id, status), (org_id, source) | The three `converted_*` FKs are the permanent audit trail of a conversion |
| activities | id, org_id, type, subject, **related_type**, **related_id**, owner_id, due_date, completed | (org_id, related_type, related_id), (org_id, owner_id, due_date) | Polymorphic. No FK — see below |
| custom_fields | id, org_id, entity_type, field_name, field_type, options (JSONB) | unique(org_id, entity_type, field_name) | The org's schema, stored as data |
| shares | id, org_id, entity_type, entity_id, grantee_id, access_level | (org_id, entity_type, entity_id) | Explicit record shares beyond ownership + hierarchy |
| report_rollups | org_id, owner_id, report_key, dimension, metric, computed_at | unique(org_id, owner_id, report_key, dimension) | Pre-aggregated. The shape of this table is the whole answer to Deep Dive 3 |

**Why leads keep three nullable FKs instead of being deleted on conversion.** Reporting must answer "what fraction of Web-sourced leads became closed-won revenue," which requires joining leads → opportunities *through* the conversion link. Deleting the lead is simpler storage-wise and permanently destroys the org's ability to measure its own lead-source ROI — which is a core CRM value proposition, not a nice-to-have.

**Polymorphic activities**: `(related_type, related_id)` with no foreign key. We lose referential integrity; the database cannot stop an activity pointing at a deleted opportunity. I accept that because activities are an *append-only log* where an orphan is harmless (it simply never appears in any timeline), while the alternative — a join table per entity type — turns the unified "everything that happened on this account" timeline into a five-way UNION that must be rewritten every time we add an object type. A nightly reaper cleans orphans. Losing FK integrity on a log is cheap; needing a schema migration to add an object type is not.

**Money is BIGINT cents.** A float `amount_cents` eventually produces a forecast that doesn't equal the sum of its deals, and a sales VP will notice.

## 🔌 API Design

```
GET    /api/accounts?q=&industry=&page=      → List (search, filter, paginate)
POST   /api/accounts                         → Create (owner from session)
PUT    /api/accounts/:id                     → Update
GET    /api/accounts/:id/contacts            → Sub-resource
GET    /api/accounts/:id/opportunities       → Sub-resource

PUT    /api/opportunities/:id/stage          → Kanban move (version required)
POST   /api/leads/:id/convert                → Atomic conversion (Idempotency-Key)

GET    /api/activities?related_type=&related_id=  → Polymorphic timeline
POST   /api/activities                       → Log a call/email/meeting/note

GET    /api/dashboard                        → KPIs for the *calling user*
GET    /api/reports/pipeline                 → Count + amount by stage
GET    /api/reports/revenue                  → Closed-won by month
GET    /api/reports/leads                    → Leads by source

GET    /api/metadata/fields?entity=account   → The org's custom-field schema
```

Two deliberate choices. **The tenant never appears in the URL** — a tenant identifier the client can supply is a tenant identifier the client can forge; it comes from the session, always. And **the stage-transition endpoint is separate from the general update**: a kanban drag should be a narrow, fast, idempotent operation that changes stage and derives probability, not a general PATCH that happens to also move a card. Narrow endpoints are easier to make safe and easier to add transition rules to later (blocking Prospecting → Closed Won, say).

## 🔧 Deep Dive 1: Multi-Tenancy — Where the Isolation Boundary Goes

Three options. The choice determines everything downstream, so it's the first thing on the whiteboard.

| Approach | How it works | How it concretely breaks |
|----------|--------------|--------------------------|
| ❌ Database per tenant | Each org gets its own database | 50K databases. Each holds a connection pool, a WAL writer, background workers. At even 5 connections per pool that's 250K connections, and PostgreSQL is unhappy past a few thousand. Worse: a schema migration becomes 50K sequential migrations. That takes days, *will* fail partway, and leaves you with orgs on two schema versions and no version of your code that works for both |
| ❌ Schema per tenant | One database, 50K schemas | You've traded connection blowup for catalog blowup: 50K schemas × ~12 tables = 600K catalog entries plus indexes. The query planner reads the catalog, so planning gets slow for *everyone*. And the migration problem is identical — still 50K DDL statements, still no atomic rollback |
| ✅ Shared schema, `org_id` column | One schema; tenant discriminator on every row | Isolation now depends on application correctness — a real and permanent risk |

**Why shared schema wins here, despite the risk.** Migrations decide it. A CRM ships features constantly and nearly every feature is a schema change. Shared schema: adding a column is *one* statement. Schema-per-tenant: it's fifty thousand, run against a live system, with a partial-failure mode you cannot recover from. That's not a close call — one approach lets you deploy on a Tuesday afternoon; the other makes every migration a multi-day project. The tenant skew makes it worse still: paying a fixed per-org infrastructure cost across 50K orgs, most of which have ten users and generate almost no load, is enormous waste.

**What I give up, and how I buy it back.** With shared schema, one forgotten `WHERE org_id = ?` is a cross-tenant data leak. That is far too dangerous to leave to code review, so it doesn't live in the queries at all:

1. **Row-Level Security in PostgreSQL.** Every tenant-scoped table carries an RLS policy keyed on a session variable that the app sets when it checks a connection out of the pool. A query that *forgets* the predicate now returns zero rows instead of everyone's rows. The database enforces the invariant; the developer cannot bypass it.
2. **A repository layer that owns connection checkout.** Nothing gets a raw connection — it gets a tenant-bound one.
3. **`org_id` is the leading column of every index.** Not only for correctness: `(org_id, stage)` makes an opportunity query a tight index range scan instead of a filter over 5M rows.
4. **Cache keys are namespaced by org.** A key like `account:123` is a cross-tenant leak waiting for an ID collision. `org:{org_id}:account:{id}` is not.

> "The honest framing is that shared-schema multi-tenancy converts a *hard operational problem* — fleet-wide migrations — into a *hard correctness problem*, tenant isolation. I take that trade because correctness problems can be solved once, structurally, at a chokepoint: RLS plus a repository layer means the isolation logic lives in two files and is impossible to route around. Operational problems can't be solved once. You pay them on every deploy, forever, and they get worse as you grow. I'd rather have one frightening invariant with a mechanical guard than fifty thousand databases and a migration script I pray over."

**The noisy-neighbour caveat.** Shared infrastructure means one org's 500K-row export can starve everyone else on the box. So: per-org rate limits at the gateway, per-org query-cost budgets (a report that scans too much is *killed*, not queued), and the largest orgs get pinned to dedicated shards. Sharding by `org_id` is natural precisely *because* `org_id` is on every row and there is no such thing as a cross-org query — the same property that makes the schema work is what makes it shardable later. That's the escape hatch, and it exists only because of this decision.

## 🔧 Deep Dive 2: Lead Conversion — Why a Transaction Beats a Saga

Conversion turns one lead into three entities. It's the riskiest operation in the system, because a partial result is **unrecoverable by the user**: they can't un-convert, and they can't finish a conversion that half-happened.

Inside one PostgreSQL transaction:

1. `BEGIN`, then verify the lead exists and `converted_at IS NULL` — the idempotency guard
2. Insert the account, built from the lead's company
3. Insert the contact, linked to that new account
4. If the rep opted in, insert the opportunity, linked to the same account
5. Update the lead: status → Converted, write back the three `converted_*_id` columns, set `converted_at`
6. `COMMIT`

Any failure rolls back all four writes. The lead is untouched; the user retries.

**Why not a saga with compensating transactions?** A saga is what you build when you *cannot* have a transaction — when the entities live in different services with different databases and there is no single ACID boundary to lean on. Here, all four writes hit the same database. Adopting a saga means writing an orchestrator, emitting an event per step, and hand-writing compensations ("delete the account we just created") that are themselves fallible, can partially fail, and must be idempotent. That's an order of magnitude more code to reconstruct — worse — a guarantee the database already provides. `ROLLBACK` is not a best-effort compensation. It's a guarantee.

> "The trade I'll state explicitly: the transaction holds row locks for its full duration, roughly 200ms across four round-trips. If conversions ever became the dominant write pattern, that's real pressure on the connection pool. So I keep the transaction minimal — inserts and one update, and **zero external calls inside the boundary**. That last rule is the one people break: someone adds 'send a welcome email' inside the transaction, the mail provider hangs for 30 seconds, and now a lead conversion holds locks for half a minute and the pool exhausts. Side effects go in an outbox row written inside the transaction and processed after commit. The transaction boundary must contain exactly the things that need to be atomic and nothing else."

**Idempotency.** The `converted_at IS NULL` guard catches a double-click. A client-supplied `Idempotency-Key` in Redis catches a network-level retry, where the client never saw the first response. And the durable backstop is a partial unique index on `leads.converted_account_id` — a lead can only ever point at one account, enforced by the database.

**What we give up.** If accounts/contacts/opportunities ever split into separate services with separate stores, this transaction stops being possible and a saga becomes unavoidable. That's a real future cost — and it's a strong argument for **keeping these five objects in one service and one database for as long as possible**. The transactional boundary should follow the *workflow* boundary, and conversion is the workflow that binds them. Splitting them apart is not a free refactor; it's a decision to take on distributed-transaction complexity, and it should be made on purpose.

## 🔧 Deep Dive 3: Dashboards, Sharing Rules, and Why You Can't Cache the Obvious Thing

Here's the constraint that makes CRM reporting genuinely hard, and it's easy to miss.

**Every user sees a different subset of records.** A rep sees their own opportunities. Their manager sees the whole team's, via the role hierarchy. A regional VP sees several teams. Plus explicit shares. So "pipeline by stage" is not one number per org — it is **one number per user**.

That single fact kills every obvious design:

| Naive approach | The specific bottleneck |
|----------------|-------------------------|
| ❌ Cache `dashboard:{org_id}` | Wrong for everyone but the org admin. A rep would see the whole company's pipeline — simultaneously a data leak *and* a wrong number |
| ❌ Cache `dashboard:{user_id}` | Correct, but the hit rate collapses. 50K users, viewed a few times a day, and invalidated by *any* write inside their visible set. In an active org, one closed deal invalidates hundreds of users' entries. You spend more on invalidation than you saved |
| ❌ Compute live per request | `GROUP BY stage` over 5M opportunities joined to the sharing tree, on every dashboard load. Fine on average; catastrophic at 9am Monday when the entire sales org opens the app inside ten minutes |

**The design: pre-aggregate on the dimension that's shared; filter on the dimension that isn't.**

The insight is that visibility is a property of the *record's owner*, and the role hierarchy is a **tree** — a manager's visible set is exactly their subtree. So:

1. A **rollup worker** consumes a change stream from `opportunities` and maintains `report_rollups` at the finest granularity that is *viewer-independent*: **per (org, owner, stage)**. Note what this is not — it is not per-viewer. It's per record-owner, which is a fact about the data, not about who's looking.
2. A dashboard request for user U resolves U's **visible owner set**: their role subtree. That's cached in Redis and changes only when someone's role changes, which is rare.
3. The dashboard is then a **sum over pre-aggregated rows for those owners.** For a rep, that's one row. For a VP with 200 reports, it's 200 rows summed — trivially fast, and completely independent of how many *opportunities* those reps have.

We've turned "aggregate 5M opportunities under a permission filter" into "sum 200 pre-computed rows." The expensive aggregation happens once per write, in a worker, off the request path. The permission filter runs against a tiny cached tree.

**What we give up: staleness.** Rollups lag writes by the worker's cycle — seconds to a minute. That's exactly why I asked about dashboard freshness up front. For a company pipeline number, a minute is invisible; nobody makes a decision on second-by-second movement in an aggregate. And critically, the *individual opportunity record* a rep is editing is never served from a rollup — it's read live. We cache the **aggregate**, never the **entity**, which is what makes the staleness invisible to the one person who would notice it. If a rep needs their own just-closed deal reflected instantly, the read path overlays their own recent changes on top of the rollup — a small read-your-writes patch, not an architecture change.

**Ad-hoc reports** — arbitrary filters, arbitrary groupings — cannot be pre-aggregated by definition. Those go to a **read replica**, run under a query-cost budget, and go **async for large orgs**: submit, get a job ID, poll or get notified. A report that scans 5M rows must not hold an HTTP connection, and one org running ten of them must not be able to take the primary down for every other tenant on the shard.

**The weakness I'd name out loud:** this design assumes the sharing model is a *tree*. Real sharing rules include criteria-based sharing ("everyone in EMEA sees EMEA deals"), which is a **set**, not a subtree, and it breaks the clean "sum over my subtree" trick. Handling it properly probably means materializing each user's visible-owner set and accepting a bigger, staler cache — which is exactly the concession real systems make and clean whiteboard designs pretend not to need.

## 🧩 Custom Fields: The Schema We Don't Control

Every org adds fields — "Deal Region," "Renewal Risk," "Competitor." Three approaches, each failing a different requirement:

| Approach | Query performance | DB-level constraints | Operational cost |
|----------|-------------------|----------------------|------------------|
| ❌ `ALTER TABLE` per field | Best — native column | ✅ Full | Prohibitive. `ALTER TABLE` takes an exclusive lock; thousands of orgs adding fields means blocking DDL many times a day |
| ❌ EAV (values in a side table) | Poor at the workload that matters | ✅ Strong | Low |
| ✅ JSONB column + metadata table | Good — one row, one read | ⚠️ Application-enforced | Low |

**Why EAV fails, specifically.** The killer is the report a power user actually runs: "pipeline by Deal Region, filtered to Renewal Risk = High, showing Competitor." Three custom fields. In EAV, each is a separate row in the values table — so that's **three self-joins** onto a table holding, at 5M opportunities × 40 fields, roughly 200M rows. The planner has no useful statistics, because the table is a bag of unrelated values with no correlation between field and value. What should be an index range scan becomes hundreds of millions of random lookups, and the 500ms budget is gone by an order of magnitude. **EAV degrades in proportion to how many custom fields appear in one query — which is precisely what power users do.**

**What I'd build: JSONB, with `custom_fields` as the metadata authority.** The `custom_fields` table stays — it defines name, type, options, required-ness, and it's served to clients at `/api/metadata/fields` so they can render forms and validators from it. But *values* live in a `custom` JSONB column on the entity itself. The three-field report becomes one predicate on one row. For fields an org marks as filterable, we create an expression index on that specific key, giving a real B-tree that behaves like a native column.

**What we give up:** the database can no longer type-check a custom field. A bug in the coercion layer writes `"50000"` where `50000` belongs, and PostgreSQL happily accepts it. EAV would have caught that. Mitigation: validation at exactly one chokepoint (the write path reads `custom_fields` and coerces), plus a background auditor scanning for type violations. That is a genuinely weaker guarantee than a database constraint, and I'd say so rather than pretend otherwise. But the failure mode of EAV is *the product is too slow to use*, and the failure mode of JSONB is *a validation bug we can find and fix*. Those are not equivalent risks.

## 📐 Stage–Probability Coupling

A smaller decision, but instructive. The kanban endpoint auto-maps stage to probability (Prospecting 10%, Qualification 20%, Needs Analysis 40%, Proposal 60%, Negotiation 80%, Closed Won 100%, Closed Lost 0%). Weighted pipeline — the number a VP actually cares about — is the sum of amount × probability, and that formula is only trustworthy if stage and probability never disagree.

Decoupling them is more flexible and opens a specific failure: a deal sits in Closed Won showing 50% probability, because a rep edited it early and never touched it again, silently skewing every forecast. So the *drag path* always applies the mapping; the full-update endpoint still permits a deliberate override for a deal the rep is unusually confident or worried about. The guardrail goes on the common path, not on the data.

## 🔎 Request Flow: One Dashboard Load, End to End

Worth tracing once, because it touches every decision above and shows where the cost actually lives.

```
 GET /api/dashboard
      │
      ▼
 ┌─────────────────────────────┐
 │ 1. Session → user_id, org_id │  Redis. ~0.5ms.
 └──────────────┬──────────────┘   org_id NEVER from the request body
                ▼
 ┌─────────────────────────────┐
 │ 2. Resolve visible owner set │  Redis: org:{org}:subtree:{role}
 │    (the role subtree)        │  Cache hit ~99% — roles rarely change
 └──────────────┬──────────────┘   Miss → recursive walk of `roles`, then cache
                ▼
 ┌─────────────────────────────┐
 │ 3. Fetch rollup rows for     │  PostgreSQL, index on
 │    those owners              │  (org_id, owner_id, report_key)
 └──────────────┬──────────────┘   1 row for a rep, ~200 for a VP
                ▼
 ┌─────────────────────────────┐
 │ 4. Sum in the app layer      │  Microseconds. It's 200 integers
 └──────────────┬──────────────┘
                ▼
 ┌─────────────────────────────┐
 │ 5. Overlay the user's own    │  Read-your-writes patch: their own
 │    writes since last rollup  │  changed deals since computed_at
 └──────────────┬──────────────┘
                ▼
         p99 well under 500ms
```

The thing to notice: **no step in this flow touches the `opportunities` table.** The 5M-row aggregation happened asynchronously, once, when the data changed. What's left on the request path is a permission lookup and a sum of a couple hundred integers. That's the entire argument of Deep Dive 3, in one trace.

## 🧭 Consistency Model

| Operation | Guarantee | Why |
|-----------|-----------|-----|
| Entity CRUD | Strong, read-your-writes | You must see the contact you just saved |
| Kanban stage move | Strong + optimistic concurrency (`version`) | Two reps dragging the same deal must not silently overwrite each other — the loser gets a 409, not a surprise |
| Lead conversion | Serializable, atomic | Partial conversion is unrecoverable |
| Dashboard / rollups | Eventual, bounded by worker lag | A minute-stale aggregate is invisible |
| Search (Elasticsearch) | Eventual, seconds | A contact appearing in search 2s late is not a bug anyone notices |
| **Sharing / role changes** | **Strong, with synchronous cache invalidation** | A revoked permission that lingers in cache is a data leak. This one is *not allowed* to be eventual |

The last row is the one people get wrong. Nearly everything about permissions is safe to cache — except **revocation**, which must be immediate. So the role-subtree cache is busted synchronously on any role or share change, and that write path is deliberately slow-but-correct.

## 🛠️ Failure Handling

| Failure | Behavior |
|---------|----------|
| Rollup worker down | Dashboards serve stale rollups with an explicit "as of HH:MM" label. Degraded, honest, still useful |
| Read replica down | Ad-hoc reports fall back to the primary under a tightened cost budget; dashboards keep serving from rollups |
| Elasticsearch down | Search degrades to a prefix query against indexed name columns in PostgreSQL. Narrower results; the app still works |
| Redis down | Sessions fail → hard outage. This is the single biggest fragility, and the first place I'd invest (replication + persistence). A session-store outage logs out 50K reps at once |
| PostgreSQL primary down | Writes fail loudly; reads continue from replica. We don't accept writes we can't durably record |

Circuit breakers wrap Elasticsearch and any external integration, so a slow dependency fails fast instead of consuming the connection pool — without one, a 30-second timeout on a dead dependency exhausts the pool and takes down endpoints that never touch it. The general rule: **degrade the fancy features; never degrade the record of truth.**

## 🔐 Security

- **Tenant isolation is structural** (RLS + repository layer + namespaced cache keys), not procedural.
- **Record-level sharing** is enforced in the data layer on every read — never in the UI. A hidden button is not a permission.
- **Sessions in Redis, server-side revocable**, not JWTs. When a rep is offboarded — a real and non-hypothetical threat for the system holding the entire customer pipeline — "their token expires in 15 minutes" is not an acceptable answer. A JWT blocklist reintroduces the server state JWTs exist to avoid, at which point a plain session is simpler and stronger.
- **Rate limits tiered by cost**: generous for CRUD, strict for reports (each is potentially a multi-million-row scan), strictest for auth.
- **Field-level security** at scale: some fields (deal amount, personal contact details) are role-restricted. Enforced by *projecting columns* at the data layer, not by returning the row and hiding it client-side.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| p99 latency **broken out by org** | Aggregate p99 hides the one enormous tenant whose queries are dying. In multi-tenant systems, per-tenant SLOs are the only honest ones |
| Query cost histogram (rows scanned per request) | The leading indicator of a report about to become a problem — visible long before it shows up as latency |
| Rollup worker lag | Directly bounds dashboard staleness. If it grows, dashboards are quietly lying |
| **Queries executed without a tenant predicate** | Should be exactly **zero**. Alarm at one. This is the invariant that ends the company if it breaks |
| Lead conversion failure rate | The one operation with an unrecoverable partial state |
| Connection pool saturation, per org | Noisy-neighbour detection |

## 📈 Scalability: What Breaks First

1. **Report and dashboard aggregation.** First by a wide margin — it's the only thing scanning millions of rows. The rollup worker is the fix, and it's the first thing I'd build after basic CRUD works.

2. **Search via SQL `LIKE`.** It degrades past a few hundred thousand rows, because a leading-wildcard match cannot use a B-tree and becomes a sequential scan of the entire tenant's data. Fix: Elasticsearch fed by change data capture, with **tenant-scoped indices** — not a shared index with an `org_id` filter. Isolation should be structural here too.

3. **The `activities` table.** Largest by an order of magnitude, growing fastest, only ever appended to and read by `(related_type, related_id)`. Partition by `created_at`; archive cold partitions to object storage. Nobody queries three-year-old call notes, and everybody insists on retaining them. Also: high-volume automated logging (email sync, call tracking) should be buffered through a queue and batch-inserted, so integration bursts never reach the OLTP path where reps are actively working.

4. **The big-tenant skew.** Long before *total* volume is a problem, *one* org with 50K users will be. That org gets its own shard. This works cleanly only because `org_id` is on every row and cross-org queries don't exist — the Deep Dive 1 decision is what makes this escape hatch available at all.

5. **Connection pool at 50K concurrent users.** PgBouncer in transaction mode, sized per shard, with **separate pools per query class** — a small pool for expensive analytics against the replica, a larger one for fast transactional writes against the primary — so a report storm can never starve the write path. This is boring, and it is absolutely the thing that pages you at 3am.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Tenancy | ✅ Shared schema + `org_id` + RLS | ❌ DB or schema per tenant | 50K migrations per deploy is unshippable; RLS makes the correctness risk mechanical |
| Custom fields | ✅ JSONB + metadata table | ❌ EAV / `ALTER TABLE` | EAV needs one self-join per field; reports die at three fields |
| Dashboards | ✅ Pre-aggregate per (org, owner, stage); sum over the role subtree | ❌ Cache per user / compute live | Sharing rules make results per-*viewer*, so cache per record-*owner* instead |
| Ad-hoc reports | ✅ Read replica + cost budget + async for big jobs | ❌ Synchronous on the primary | One report must never take down a shard |
| Lead conversion | ✅ Single DB transaction, side effects via outbox | ❌ Saga | Compensations are fallible reimplementations of a guarantee we already have |
| Kanban moves | ✅ Optimistic concurrency (`version`) | ❌ Last-write-wins | Two reps on one deal must not silently clobber each other |
| Activities | ✅ Polymorphic `(related_type, related_id)` | ❌ Join table per entity | Unified timeline in one query; orphans are harmless on an append-only log |
| Sessions | ✅ Redis, server-side | ❌ JWT | Offboarding must revoke access *now* |
| Search | ✅ Elasticsearch, tenant-scoped indices | ❌ SQL `LIKE` | Leading-wildcard search is a full scan |
| Money | ✅ BIGINT cents | ❌ float | Forecasts must equal the sum of their deals |

## 🚀 Closing: What I'd Build Next

The feature I'd design next is the **workflow/automation engine** — "when an opportunity hits Negotiation, create a task for the manager and notify the deal channel." It's what turns a CRM from a database into a system of record, and architecturally it's just a rules engine consuming the same change stream the rollup worker already uses. That's the real payoff of building CDC for reporting: automation, search indexing, and rollups become three consumers of one event log, and none of them belong on the write path.

Beyond that, a proper **audit trail** — who changed which field, when, from what. CRM data is contested, and "the customer says they never agreed to that discount" is a conversation that happens. And I'd go back and fix the weakness I named in Deep Dive 3: the rollup design assumes sharing is a tree, and real sharing rules are sets. That's the kind of thing that looks like a detail on a whiteboard and turns out to be six months of work.

# Salesforce CRM - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a CRM: accounts, contacts, opportunities, and leads flowing through a sales pipeline, with a lead-conversion workflow that must never leave the data half-written, a kanban board driving stage transitions, and dashboards that sales managers refresh dozens of times a day. The system is not exotic at the infrastructure level — it is a relational schema with well-understood entities — but it concentrates three genuinely hard backend problems: **atomic multi-entity writes** (lead conversion), **read-heavy aggregation at write-light volume** (dashboards, pipeline reports), and **schema extensibility without downtime** (every CRM customer wants fields the vendor didn't anticipate).

## 🎯 Requirements Clarification

Questions I'd ask before designing:

- **Is lead conversion the only multi-entity transaction, or will more appear?** (Answer: for now, yes — this shapes whether a general saga framework is worth building or a targeted transaction suffices.)
- **How stale can dashboard numbers be?** A rep closing a deal wants to see it reflected quickly on their own view; a VP's company-wide pipeline report tolerates minutes of staleness.
- **Single-tenant or multi-tenant SaaS?** I'll assume single-tenant to start and discuss the multi-tenant path at the end, since it changes the sharding story significantly.
- **How often do organizations need custom fields?** This determines whether EAV's query complexity is worth paying for from day one.

### Functional Requirements

- CRUD for accounts, contacts, opportunities, leads
- Kanban-driven opportunity stage transitions with probability auto-mapping
- Atomic lead conversion: lead → account + contact + optional opportunity
- Polymorphic activity logging (calls, emails, meetings, notes) against any entity
- Dashboard KPIs and pipeline/revenue/lead-source reports
- Custom fields per organization without schema migrations

### Non-Functional Requirements

- p99 < 200ms for entity CRUD, p99 < 500ms for dashboard aggregation
- 99.9% uptime — CRM downtime during business hours stalls an entire sales org
- Zero data loss and zero partial state on lead conversion
- Support 50K concurrent users, 10M+ accounts with sub-second search
- Audit trail for entity state changes

### Scale Estimates

| Quantity | Estimate | Implication |
|----------|----------|-------------|
| Accounts | 10M+ | Search must be indexed, not scanned |
| Concurrent users | 50K | Connection pooling and stateless API servers are mandatory |
| Dashboard views | Every rep, multiple times/day | The single most-hit read path in the system |
| Lead conversions | Low volume relative to CRUD, but zero tolerance for partial writes | Correctness trumps throughput here |

The defining asymmetry: this system is read-heavy on aggregation (dashboards, reports) and write-light but write-critical on the one multi-entity operation (lead conversion). That split drives two very different engineering postures within the same service.

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Clients (Web / Mobile)                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │  API Gateway         │
                     │  auth · rate limit   │
                     └──────────┬──────────┘
      ┌─────────┬───────────┬──┴───────┬───────────┬───────────┐
      │         │           │          │           │           │
┌─────▼───┐┌────▼────┐┌─────▼────┐┌────▼────┐┌─────▼────┐┌─────▼───┐
│ Account ││ Contact ││   Opp    ││  Lead   ││ Activity ││ Report  │
│ Service ││ Service ││ Service  ││ Service ││ Service  ││ Service │
└─────┬───┘└────┬────┘└─────┬────┘└────┬────┘└─────┬────┘└─────┬───┘
      │         │           │          │           │           │
      └─────────┴───────────┴────┬─────┴───────────┴───────────┘
                                 │
                    ┌────────────▼────────────┐
                    │       PostgreSQL         │
                    │  (Primary + Read Replica)│
                    └────────────┬─────────────┘
                                 │
                          ┌──────▼──────┐
                          │    Redis    │
                          │ sessions +  │
                          │ dashboard   │
                          │ cache       │
                          └─────────────┘
```

CRM data is inherently relational — accounts have contacts, contacts link to opportunities, opportunities have a close date that drives forecasting — and those are JOIN-heavy access patterns a relational database is built for. A document store would force embedding contacts inside account documents, and the same contact legitimately needs to appear standalone, under an account, and inside an opportunity's context — three access paths that would fight a denormalized document model. Read-heavy reporting routes to a replica; the transactional path (writes, lead conversion) targets the primary.

## 🧩 Why Domain-Scoped Services, Even Inside a Monolith

The diagram shows six services (Account, Contact, Opportunity, Lead, Activity, Report) but they deploy as one Express process today, not six independently scaled ones. That looks contradictory until the reasoning is separated into two different questions: *how is the code organized* versus *how is it deployed*.

Code organization follows domain boundaries from day one because the boundaries are real regardless of deployment topology — lead conversion needs to call into account, contact, and opportunity creation logic, and that logic should live behind a clean interface whether it's an in-process function call or a network call. Deployment stays monolithic because none of these domains currently have a scaling profile that diverges enough to justify the operational cost of running them separately — connection pool management, service discovery, and distributed tracing for six services that all get roughly proportional traffic buys very little.

> "The one domain I'd watch for scaling divergence is Report — aggregation queries are fundamentally more expensive than the CRUD services' point lookups, and they're the ones most likely to need a dedicated read replica and eventually their own resource pool. If Report ever needs to scale independently of Account/Contact/Opportunity, the domain boundary already exists in the code; splitting it out is an extraction, not a redesign."

## 💾 Data Model

| Table | Key columns | Notable design points |
|-------|-------------|----------------------|
| users | id, username (unique), email (unique), password_hash, role | Auth and ownership anchor for every other table |
| accounts | id, name, industry, address fields, annual_revenue_cents, owner_id | Revenue stored as cents — see the money deep dive |
| contacts | id, account_id (FK, ON DELETE SET NULL), name, email, phone, title, owner_id | No unique constraint on email — the same address (e.g., a shared support@ inbox) legitimately appears on contacts at different companies |
| opportunities | id, account_id, name, amount_cents, stage, probability, close_date, owner_id | stage indexed for kanban grouping and pipeline reports |
| leads | id, name, company, source, status, converted_account_id, converted_contact_id, converted_opportunity_id, converted_at, owner_id | Three nullable FKs preserve a permanent link from the historical lead to what it became |
| activities | id, type, subject, due_date, completed, related_type, related_id, owner_id | Polymorphic — composite index on (related_type, related_id) |
| custom_fields | id, entity_type, field_name, field_type, options (JSONB), is_required | Metadata only, unique per (entity_type, field_name) |
| custom_field_values | id, field_id (FK), entity_id, value (TEXT) | EAV values, unique per (field_id, entity_id) |

**Why leads keep three nullable FKs instead of being deleted on conversion.** Reporting needs to answer "what fraction of Web-sourced leads became Closed-Won revenue," which requires joining leads → opportunities through the conversion link. Deleting the lead on conversion is simpler storage-wise but destroys that join permanently — the org loses the ability to measure its own lead-source ROI, which is a core CRM value proposition, not a nice-to-have.

## 🔌 API Design

```
POST   /api/auth/login                  Session login
GET    /api/{entity}                    List (search, filter, pagination) — entity ∈ {accounts, contacts, opportunities, leads}
GET    /api/{entity}/:id                Detail
POST   /api/{entity}                    Create (owner_id from session)
PUT    /api/{entity}/:id                Update
DELETE /api/{entity}/:id                Delete
PUT    /api/opportunities/:id/stage     Kanban stage transition (auto-sets probability)
POST   /api/leads/:id/convert           Transactional lead conversion
GET    /api/accounts/:id/contacts       Sub-resource
GET    /api/accounts/:id/opportunities  Sub-resource
GET    /api/dashboard                   Aggregated KPIs
GET    /api/reports/pipeline            Stage breakdown
GET    /api/reports/revenue             Monthly revenue
GET    /api/reports/leads               Source breakdown
```

The stage-transition endpoint is deliberately separate from the general opportunity update: kanban drag-drop should be a narrow, fast operation that only changes stage and derives probability, not a general-purpose PATCH that happens to also move a card. Narrow endpoints are easier to make idempotent and easier to add transition validation rules to later (e.g., blocking Prospecting → Closed Won).

**Pagination is OFFSET/LIMIT, deliberately, not cursor-based — for now.** List endpoints support search (ILIKE across relevant text columns), page/limit, and entity-specific filters. OFFSET/LIMIT degrades at high page numbers (the database still has to walk past all the skipped rows), but CRM list views are workflow tools, not infinite feeds: a rep filters down to "my open opportunities" and looks at page 2 of 4, never page 400. Cursor pagination would be strictly better at the tail, but it forfeits "jump to page 7" and total-count display, both of which sales managers actually use ("how many leads came in this month" needs a real count, not an estimate). I'd revisit this the moment a customer's default, unfiltered list view routinely exceeds a few thousand rows.

## 🔧 Deep Dive 1: Lead Conversion — Why a Transaction Beats a Saga Here

Lead conversion is the one operation where correctness has zero tolerance for partial failure: converting a lead creates an account, a contact, optionally an opportunity, and marks the lead converted — four writes that must succeed or fail as a unit.

**The chosen approach: a single PostgreSQL transaction**, run on a dedicated connection pool client:

1. BEGIN, then verify the lead exists and is not already converted — the idempotency guard
2. INSERT the account, built from the lead's company name and contact info
3. INSERT the contact, linked to the newly created account
4. If the rep opted in, INSERT the opportunity, linked to the same account
5. UPDATE the lead: status → Converted, populate the three converted_*_id columns, set converted_at
6. COMMIT

Any failure at any step triggers ROLLBACK, and none of the four writes persist.

**Why not a saga with compensating transactions?** A saga makes sense when the entities being created live in different services with different databases — there is no single ACID boundary to lean on, so you build one out of events and undo-handlers instead. Here, all four writes target the same PostgreSQL instance. Reaching for a saga would mean writing an orchestrator, publishing events for each step, and writing compensating logic for account-created-but-contact-failed — roughly an order of magnitude more code to reconstruct a guarantee the database already provides natively. The failure mode a saga is designed to avoid (a stuck orchestrator leaving one entity created without its siblings) is precisely what a transaction makes structurally impossible: ROLLBACK is not a best-effort compensation, it is a guarantee.

> "The trade I'm making explicit: the transaction holds row-level locks for its full duration — roughly 200ms including four round-trips. At 1,000 concurrent conversions that's real pressure on the connection pool, so I keep the transaction minimal (only INSERTs and one UPDATE, zero external calls inside the boundary) and size the pool at 20 connections with a 5-second timeout, which comfortably clears 100 conversions/sec. If conversion volume ever became the dominant write pattern rather than a small, critical minority of writes, I would revisit — but optimizing throughput before it's the bottleneck would be solving a problem this system doesn't have yet."

**Idempotency.** The guard checks `converted_at IS NULL` before proceeding; a retried convert request on an already-converted lead returns an error rather than creating duplicate account/contact/opportunity rows. Production would add a client-supplied idempotency key stored in Redis with a 24-hour TTL, so a network-level retry (not just an application-level double-click) is also caught.

**What we give up.** If the system ever splits into per-entity microservices, this transaction stops being possible — a saga with a transactional outbox becomes necessary, trading immediate consistency for availability across service boundaries. That migration is a real future cost, but paying it now, before microservices exist, would mean carrying saga complexity for no present benefit — the general engineering trap of building for an architecture you don't have yet.

## 🔧 Deep Dive 2: Dashboard Aggregation — Three Tiers as Data Grows

The dashboard is the single most-visited page in the product — every rep starts their day there — so its latency budget is the tightest in the system, and it's the query pattern most likely to degrade silently as the org's data grows.

**Tier 1, under ~1M opportunity rows: direct queries.** The index on `stage` supports an index-only scan for the GROUP BY pipeline report; eight KPI queries (revenue, open count, new leads, activities due, etc.) run in parallel via a fan-out-gather pattern rather than sequentially, cutting wall-clock time from the sum of eight queries to the slowest one. This tier is honest and simple: numbers are always live.

**Tier 2, 1M–10M rows: materialized views, refreshed every 5 minutes.** A materialized view pre-aggregates pipeline totals per owner; `REFRESH MATERIALIZED VIEW CONCURRENTLY` rebuilds it without blocking reads, triggered by a scheduler. The dashboard now reads a pre-computed view instead of scanning the base table — sub-millisecond instead of scanning growing millions of rows.

**Tier 3, 10M+ rows: range-partition opportunities by close_date, materialized views per active partition, Redis-cached KPIs per user refreshed by a background worker every minute.** Reports at this scale query only the current-and-next-quarter partitions rather than the full history, and the dashboard reads from Redis rather than PostgreSQL at all.

| Scale | Strategy | Latency | Freshness |
|-------|----------|---------|-----------|
| < 1M | ✅ Direct queries | < 100ms | Real-time |
| 1–10M | ✅ Materialized views | < 10ms | 5 min stale |
| 10M+ | ✅ Partitioned + mat views + Redis | < 5ms | 1–5 min stale |

**Why staleness is acceptable here specifically.** A rep closing a $500K deal and the aggregate dashboard not reflecting it for 5 minutes sounds alarming until you separate two different questions the product answers: "what does *my* pipeline look like" (always queried live, per-owner, small enough to never need caching) versus "what does the *company's* pipeline look like" (the aggregation that gets cached). Reports are inherently backward-looking summaries; nobody makes a decision based on second-by-second movement in a company-wide total. The individual opportunity record — the one a rep is actually editing — is never served from a stale cache. Caching the aggregate, not the entity, is what makes the staleness invisible to the person who'd actually notice it.

**Why not an OLAP database (ClickHouse) instead?** ClickHouse would outperform materialized views at very large scale, but it introduces a second data store that must stay in sync with PostgreSQL — a CDC pipeline, dual-write risk, and operational surface area the reporting volume here doesn't yet justify. Materialized views get 80% of the latency win with none of the synchronization problem, because they live inside the same database and the same transaction boundary as the source tables.

## 🔧 Deep Dive 3: Custom Fields — EAV, and Why Not the Obvious Alternatives

Every CRM customer wants fields the vendor didn't anticipate — "Number of Beds" for a healthcare account, "ARR Tier" for a SaaS opportunity. Three approaches exist, and each fails a different requirement:

| Approach | Query performance | DB-level constraints | Operational cost |
|----------|-------------------|----------------------|-------------------|
| ✅ EAV (custom_fields + custom_field_values) | Moderate — requires JOIN | ✅ Per-field uniqueness, type, required-ness | Low — no schema changes ever |
| ❌ JSONB column per entity | Good for point lookups | ❌ No per-field constraints; GIN indexes only support containment | Low |
| ❌ ALTER TABLE per custom field | Best — native column | ✅ Full | Prohibitive — DDL in production per field |

**Why not JSONB, which looks simpler?** JSONB avoids the JOIN, but it cannot enforce "only one field named Region per entity type," cannot require a field at the database level, and cannot type-check a value at write time — every one of those becomes an application-layer responsibility that a bug can bypass. For a CRM where a rep entering a malformed custom field costs real money downstream (a report silently excludes a record because its "Region" field is `"west"` in one place and `"West"` in another), EAV's ability to push validation into the database is worth the extra JOIN.

**Why not ALTER TABLE per field, which looks fastest?** It gives native-column performance, but `ALTER TABLE` acquires an ACCESS EXCLUSIVE lock, blocking all reads and writes on that table for its duration. A single-tenant instance might tolerate occasional migrations; a multi-tenant SaaS with thousands of organizations each adding custom fields would mean running blocking DDL potentially thousands of times a day — an operational failure mode, not an edge case.

**Mitigating EAV's real weakness (query complexity) rather than abandoning it:** a partial index that casts numeric custom-field values, letting the planner use an index scan for range queries on numeric fields; and for the 5–10 "hot" custom fields identified by query logging, a denormalized materialized view that pivots EAV rows into columns — native-column performance for the fields that matter, EAV flexibility for the long tail that doesn't. A hard field-count limit (200 per entity type, versus Salesforce's actual 800 on Enterprise) keeps the JOIN fan-out and the value table's row count bounded.

## 📐 Stage-Probability Coupling

A smaller but instructive decision: the kanban stage-update endpoint automatically maps stage to probability (Prospecting → 10%, Qualification → 20%, Needs Analysis → 40%, Proposal → 60%, Negotiation → 80%, Closed Won → 100%, Closed Lost → 0%). Weighted pipeline value — the number a VP actually cares about — is `SUM(amount_cents × probability / 100)`, and that formula is only trustworthy if probability and stage never disagree.

Decoupling them (letting probability be freely edited independent of stage) is more flexible but opens a specific failure mode: a deal sits in "Closed Won" showing 50% probability because a rep edited it during an earlier stage and never touched it again, silently skewing every forecast that sums probability-weighted pipeline. The endpoint used for drag-drop always applies the default mapping; a separate full-update endpoint still allows a rep to deliberately override probability mid-pipeline (a deal at Proposal stage that the rep is unusually confident or unusually worried about) — the guardrail is on the common path, not a hard constraint on the data.

## 🔁 Consistency and Idempotency

- **Lead conversion**: full ACID transaction, idempotency-guarded by `converted_at IS NULL`
- **Stage updates**: naturally idempotent — moving an opportunity to its current stage is a no-op returning the unchanged record
- **Optimistic concurrency**: currently `updated_at`-based; production would enforce a version column with conditional `WHERE version = $expected` updates and a 409 on mismatch, since two reps editing the same deal simultaneously should not silently last-write-wins
- **Activity writes**: append-only, so concurrent writes from multiple reps or an email-sync integration never conflict

## 🛡️ Security, Rate Limiting, Failure Handling

- **Session auth in Redis** — chosen over JWT because CRM accounts hold sensitive customer data; an offboarded employee's access must revoke instantly, not wait out a token's expiry window
- **Rate limits tiered by cost**: 1000 req/15min general API, 50 req/15min auth (brute-force resistance), 30 req/min reports (each one is an expensive aggregation, not a cheap lookup)
- **Circuit breaker (Opossum)** around external calls: after 50% of recent requests fail, the breaker opens and fails fast rather than letting every request wait out a 30-second timeout — without it, one slow dependency exhausts the connection pool and takes down endpoints that never even touch that dependency
- **Health checks** at `/api/health` run `SELECT 1`; load balancers deregister instances that fail it
- **Graceful shutdown** on SIGTERM drains in-flight requests before closing DB and Redis connections, so a rolling deploy never truncates an in-progress lead conversion

**Authorization: RBAC, not per-user permissions.** Users carry a `role` column (`user` or `admin` today). The `requireAuth` middleware confirms a valid session; admin-only endpoints additionally check the role. This is deliberately coarse for a two-role system — the real production version of this problem (Salesforce itself) needs object-level permissions ("can this role see Opportunities at all"), field-level security ("can this role see the amount field specifically"), and sharing rules ("can this rep see deals owned by a colleague on a different territory"). I would not build that generality until a customer's org chart actually needs it: RBAC's value is that adding a permission means changing one role definition, not touching every user row, and that property holds whether the rule set has 2 roles or 20 — the model doesn't need to be pre-built at day one, just chosen so it can grow without a rewrite.

**Why not JWT for auth, expanded.** Beyond instant revocation, a CRM specifically needs the ability to force-logout a compromised or offboarded account mid-session — a departing sales rep who leaves on bad terms is a real, not hypothetical, threat model for a system holding the entire customer pipeline. A JWT's whole design point is statelessness: the server can't invalidate one without a blocklist, which reintroduces the server-side state JWTs exist to avoid, at which point a plain session is simpler and gets the same guarantee.

## 📊 Observability

| Signal | Tool | What it catches |
|--------|------|------------------|
| Request duration histograms | Prometheus (prom-client) | p99 creep on dashboard/report endpoints before it breaches SLO |
| Request count by status | Prometheus | Error-rate spikes, isolated by endpoint |
| DB query timing | Prometheus | Which specific query regressed after a schema or data-volume change |
| Structured request logs | Pino, JSON | `status:500 AND path:/api/leads/*/convert` — finding every failed conversion without grepping gigabytes of text |
| Health check | `/api/health` (`SELECT 1`) | Load balancer deregisters an instance losing its DB connection |

Structured logging matters specifically for lead conversion: a failed conversion is the one error in this system where "did it actually fail cleanly, or did something partially persist" needs to be answerable from logs alone, fast, at 2am. A free-text log line requires a human to reconstruct the transaction; a JSON log with `leadId`, `step`, and `traceId` fields lets an on-call engineer query it directly.

### SLIs and SLOs

| SLI | Target | What breaches it first |
|-----|--------|--------------------------|
| Entity CRUD (p99) | < 200ms | Missing index on a new filter column |
| Dashboard aggregation (p99) | < 500ms | Tier-1 direct queries past ~1M rows — the trigger to move to materialized views |
| Lead conversion success rate | 100% (errors must be clean, not partial) | Never silently tolerated — any partial-state bug pages immediately |
| API availability | 99.9% | Connection pool exhaustion under concurrent report load |

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Lead conversion | ✅ DB transaction | ❌ Saga pattern | Single database; ROLLBACK is a guarantee, not a compensation |
| Custom fields | ✅ EAV | ❌ JSONB column | DB-level per-field constraints matter more than JOIN simplicity |
| Dashboard scaling | ✅ Tiered (direct → mat views → partitioned) | ❌ OLAP database day one | Materialized views get most of the win without a second data store |
| Activity model | ✅ Polymorphic columns | ❌ Per-entity join tables | One query for a unified timeline; orphans are harmless on an append-only log |
| Money | ✅ BIGINT cents | ❌ DECIMAL | Exact integer arithmetic; no rounding drift across large aggregations |
| Session auth | ✅ Redis sessions | ❌ JWT | Instant revocation for an offboarded rep |
| Architecture | ✅ Monolith with domain route modules | ❌ Microservices | Avoids distributed-transaction complexity while lead conversion still needs single-DB atomicity |
| Pipeline stages | ✅ Fixed enum | ❌ Configurable per org | Covers the common case; configurability adds validation surface for marginal benefit today |

## 📈 Scalability — What Breaks First

1. **Dashboard aggregation** breaks first, as covered above — solved by the three-tier caching path before it becomes user-visible.
2. **Cross-entity search** (`ILIKE` across accounts/contacts/leads) degrades past roughly 100K rows since it can't use a standard B-tree index. Fix: Elasticsearch, kept in sync via CDC (Debezium) or a transactional outbox, so search consistency degrades gracefully to "a few seconds behind" rather than the API blocking on a slow write to two stores.
3. **Activity writes** under high-volume automated logging (email sync, call tracking) risk saturating the connection pool. Fix: buffer through a queue and batch-insert, absorbing bursts without let ing write pressure reach the OLTP path where reps are actively working.
4. **Connection pool exhaustion** from concurrent report queries holding connections for seconds. Fix: separate pools per query class — a small pool for expensive analytical queries against a replica, a larger pool for fast transactional writes against the primary — so one class can never starve the other.
5. **Multi-tenant growth**, if this ever becomes SaaS: shard by organization_id, each tenant's data on a dedicated shard, with a lookup table routing requests. This eliminates cross-tenant query interference and lets a large customer get dedicated capacity without penalizing smaller tenants sharing a shard.

## 🚀 Closing

The design leans on one recurring principle: match the consistency and freshness guarantee to what the specific read or write actually needs, not to a uniform policy. Lead conversion gets full ACID because partial state is unacceptable. Company-wide dashboards get minutes of staleness because nobody acts on them second-by-second. Custom fields get database-enforced constraints because bad data costs real revenue, even though it costs a JOIN. None of these are exotic techniques — the discipline is in refusing to apply the same tool everywhere. Future work: a version-column optimistic-concurrency layer for concurrent opportunity edits, an outbox-based path to multi-service lead conversion if the monolith ever splits, and Elasticsearch for search once `ILIKE` stops being sufficient.

# Supabase Dashboard - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a Backend-as-a-Service management dashboard like Supabase Studio: developers register database projects, and the platform introspects those databases' schemas, executes arbitrary SQL against them, generates DDL from structured form inputs, and manages simulated auth users.

The defining backend challenge is the **two-database model**: a metadata database we own and control (users, projects, saved queries), plus dynamic connections to target databases we know nothing about in advance — unknown schemas, unknown sizes, unknown health, owned by users. The backend is effectively a multi-tenant proxy to thousands of foreign PostgreSQL instances.

## 🎯 Requirements Clarification

Questions I would ask up front:

- **Do target databases live on our infrastructure or anywhere on the internet?** Anywhere — the design must tolerate arbitrary latency, flaky networks, and databases that vanish mid-query.
- **How dangerous can user SQL be?** Fully arbitrary, including DDL and destructive statements. We are a console, not a gatekeeper — but we must protect *our* service from *their* queries.
- **Consistency bar?** Metadata operations need ordinary transactional consistency. Introspection must be fresh — a schema browser that shows a dropped table is broken.

### Functional Requirements

- **Project management**: CRUD with per-project target-database connection configuration, membership roles
- **Schema introspection**: discover tables, columns, types, PK/FK constraints, and approximate row counts from any PostgreSQL database at runtime
- **SQL execution**: run arbitrary user SQL against the target database, return rows or affected counts, surface errors verbatim
- **DDL generation**: produce create/alter/drop statements from structured column definitions with identifier sanitization
- **Table data CRUD**: paginated, sorted row reads plus insert/update/delete keyed by primary key
- **Auth user management**: CRUD over simulated auth users scoped per project
- **Connection testing**: verify target connectivity before use

### Non-Functional Requirements

- Metadata API latency p99 < 200ms; SQL execution bounded by a 30s hard timeout
- Schema introspection < 500ms for a 100-table database
- 10,000+ projects per deployment with bounded connection budgets (5 per project, ~1,000 per instance)
- 99.9% availability for the dashboard itself; target-database availability is explicitly *not* our SLO
- One user's hostile or runaway SQL must never degrade other tenants
- Zero data loss on our own metadata (project configs, saved queries, auth-user records) — this is the data we're fully responsible for and back up like any production database

### Scale Estimates

- 10,000 registered projects, ~2,000 active in any given hour (heavy skew: the top 20% of projects drive ~80% of queries)
- A working developer session issues ~5–10 target operations/minute (introspections, page fetches, query runs) — bursty, not streaming
- Peak: ~500 concurrent dashboard sessions → low thousands of requests/minute, trivially small for the HTTP tier; **the scarce resources are database connections and per-query memory, not request throughput**
- Result payloads: median SELECT under 100 rows, tail unbounded — which is why result caps are a correctness feature, not an optimization
- Metadata footprint is tiny (thousands of rows per table); target databases range from empty to hundreds of gigabytes

> "The scale numbers here are unusual for a system design exercise — the request rate is small enough that a single well-tuned instance could technically serve it. The engineering challenge isn't throughput, it's *shape*: bounding the blast radius and resource cost of each of 10,000 independent, unpredictable, foreign databases. I'd rather over-invest in connection governance and under-invest in horizontal API scaling, because that's where this system actually breaks."

## 🏗️ High-Level Architecture

```
┌────────────────────────────────────────────────────────────┐
│                     Clients (browser SPA)                  │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTPS
                     ┌──────┴───────┐
                     │  LB / API GW │  TLS, rate limits
                     └──────┬───────┘
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ API srv 1│  │ API srv 2│  │ API srv 3│   stateless
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │             │             │
   ┌─────────┴─────────────┴─────────────┴──────────┐
   │   Services: introspector · query executor ·    │
   │   DDL generator · auth-user service            │
   │        │                       │               │
   │  ┌─────▼──────┐        ┌───────▼────────────┐  │
   │  │ Metadata DB│        │ Dynamic pool mgr   │  │
   │  │ (PG primary│        │ per-project pools, │  │
   │  │  + replica)│        │ LRU + idle eviction│  │
   │  └────────────┘        └───────┬────────────┘  │
   │                                │ PgBouncer      │
   │                        ┌───────▼────────────┐  │
   │                        │ Target databases   │  │
   │                        │ (user-owned, N×PG) │  │
   │                        └────────────────────┘  │
   │   Redis/Valkey: sessions, introspection cache  │
   └────────────────────────────────────────────────┘
```

The structural split: **every request classifies as a metadata operation or a target operation**. Metadata operations (projects, saved queries, auth users) hit our own PostgreSQL and are boring in the best way. Target operations (introspect, execute, row CRUD) flow through the dynamic pool manager, wrapped in a circuit breaker, because everything past that boundary is somebody else's computer.

## 💾 Data Model

Metadata database, described as prose tables:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username (unique), email (unique), password_hash, role | username, email | Dashboard operators; bcrypt-hashed |
| projects | id (UUID PK), name, db_host, db_port, db_name, db_user, db_password (encrypted), created_by (FK users) | created_by | The pivot table — one row per target database |
| project_members | project_id (FK), user_id (FK), role | unique (project_id, user_id) | editor/viewer authorization per project |
| saved_queries | id, project_id (FK), name, query_text, created_by | project_id | Reusable SQL snippets |
| auth_users | id, project_id (FK), email, encrypted_password, email_confirmed, role, raw_user_metadata (JSONB) | unique (project_id, email) | Simulated GoTrue users, scoped per project |

Three judgment calls in this model:

- **Target credentials live in the projects row, encrypted at rest.** At production scale I'd envelope-encrypt db_password with a KMS-managed key rather than store plaintext: the metadata database becomes a honeypot of credentials to *other people's databases*, which makes its compromise strictly worse than a normal user-table breach. Decryption happens only in the pool manager at connect time, and credentials never appear in logs or API responses.
- **auth_users carries a JSONB metadata column** rather than a widening set of nullable columns. User metadata is read by primary key and never searched, so JSONB's weak indexability costs nothing, and product iteration on user attributes needs zero migrations.
- **The target database has no schema here at all** — that's the point. Anything we believed about target schemas at design time would be wrong by runtime; introspection is the only source of truth.

## 🔌 API Design

```
POST   /api/auth/register | login | logout      session lifecycle
GET    /api/auth/me                              current user

GET/POST        /api/projects                    list / create
PUT/DELETE      /api/projects/:id                update (evicts pool) / delete
POST            /api/projects/:id/test-connection

GET/POST        /api/projects/:pid/tables        introspect / create table
PUT/DELETE      /api/projects/:pid/tables/:name  alter / drop

GET/POST        /api/projects/:pid/tables/:name/rows        page / insert
PUT/DELETE      /api/projects/:pid/tables/:name/rows/:id    update / delete by PK

POST            /api/projects/:pid/sql/execute   arbitrary SQL
GET/POST        /api/projects/:pid/sql/saved     saved queries (+ PUT/DELETE /:id)

GET/POST        /api/projects/:pid/auth-users    auth user CRUD (+ PUT/DELETE /:id)
GET/PUT         /api/projects/:pid/settings      connection settings
```

Design notes on the API surface:

- Everything under a project id is authorized against project_members **before** any target connection is touched — authorization is a metadata-database concern and must not require target connectivity.
- The row endpoints assume a single-column primary key, whose name the client learns from introspection. Composite keys route to the SQL editor — an honest 90/10 boundary rather than a URL-encoding scheme for compound keys that nobody gets right.
- Row reads accept page, sortBy, and sortOrder; sort columns are validated against the introspected column list before being interpolated into an ORDER BY. An allowlist that comes from the database itself is the only injection-safe way to build dynamic ORDER BY.
- Settings updates double as a cache-control signal: a successful PUT evicts the project's connection pool, so credential changes take effect on the next query without a restart.

## 🔄 Request Flow Walkthroughs

**Schema introspection** (GET tables) — the request that touches both databases:

```
Client ──▶ API server ──▶ Metadata DB (authz + connection config)
                │
                ├──▶ Redis (cache hit? return cached schema)
                │
                └──▶ Target DB (fresh connection)
                         │  batched: tables → columns → PKs → FKs → estimates
                         ▼
                  assemble TableInfo[] ──▶ cache (60s TTL) ──▶ client
```

1. Session check (Valkey) and membership check (metadata DB) — both before any target work
2. Cache probe keyed by project id + a schema-version token bumped on our own DDL
3. On miss: decrypt credentials, open a dedicated target connection, run the four batched catalog queries
4. Close the connection, write through to cache, return structured results

**SQL execution** (POST execute) — the request with the widest failure surface:

1. Session + membership checks; per-user rate-limit counter incremented
2. Circuit breaker consulted — if open for this project, fail in milliseconds with "target unavailable"
3. Pool manager returns the cached pool or builds one (decrypt credentials, connect, 5s timeout)
4. Statement runs with the 30s session timeout; rows accumulate up to the result cap
5. Success: rows/fields or affected-count returned; duration recorded in the per-project histogram
6. Failure: PostgreSQL error passed through verbatim; breaker's error window updated; pool evicted if the failure was connection-level rather than statement-level

The distinction in step 6 matters: a syntax error is the *user's* problem and must not open the breaker or evict the pool; a connection refusal is the *target's* problem and must do both. Misclassifying user errors as infrastructure errors would let one user's typos mark a healthy database as down for their whole team. This error-classification split is why the query executor wraps the pg driver's error codes explicitly rather than treating "the query threw" as one undifferentiated failure — the classification is a lookup against PostgreSQL's SQLSTATE class (connection-exception codes evict and trip the breaker; everything else is returned as-is and left alone).

## 🔧 Deep Dive 1: Multi-Tenant Connection Management

The heart of the backend. Each project may point at a different PostgreSQL server; at 10,000 projects we cannot hold persistent connections to all of them.

This is also the deep dive I'd expect the most pushback on, so let me state the constraint precisely before the mechanism: we are not solving "how do we make one connection fast" — TCP setup plus TLS plus auth is a fixed ~50-100ms no matter how cleverly we code it. We are solving "how do we bound total resource consumption across ten thousand *independent* servers we don't operate, each with their own max_connections ceiling we must never trip." That reframing is why the solution is almost entirely about caps, eviction policy, and tiering rather than raw connection-speed optimization.

**Pool lifecycle per API instance:**

1. First target operation for a project creates a pool capped at 5 connections
2. The pool is cached in an in-memory map keyed by project id
3. Idle connections close after 60s; an LRU policy evicts whole pools past ~200 per instance
4. Updating a project's connection settings evicts its pool; in-flight queries drain on the old pool, new queries get fresh credentials
5. Pool-level errors evict the pool immediately so we don't keep retrying into a dead endpoint
6. Graceful shutdown drains and closes every pool before exit

**Why 5 connections per project?** One user browsing tables while a query runs needs 2–3 concurrent connections; 5 covers the realistic ceiling of a single dashboard session. The failure mode this cap prevents is asymmetric: an uncapped pool lets one user's parallel tooling exhaust *their own database's* max_connections — and then we get the support ticket for an outage we caused.

**Why no cross-instance pool coordination?**

> "The tempting design is a shared connection-broker service so all API instances reuse one pool per project. I reject it: a broker is a stateful single point of failure sitting on the hot path of every query, and it turns a local map lookup into a network hop. Pools are cheap, disposable, per-instance resources — if an instance dies, its replacement rebuilds pools lazily with zero recovery protocol. I get pool-reuse efficiency instead through the load balancer: session affinity routes a given user's requests to the same instance, so their project's pool stays warm. The cost is duplicate pools when a project's members land on different instances — at 5 connections a pool, that duplication is noise compared to the operational weight of a broker."

**Scaling tiers as project count grows:**

| Scale | Strategy | Connection budget |
|-------|----------|-------------------|
| ~100 projects/instance | Direct pools, idle timeout | ≤ 500 |
| ~1,000 | LRU eviction at 200 pools | ≤ 1,000 |
| 10,000+ | PgBouncer in transaction mode between API and targets; hot/warm/cold tiers | thousands multiplexed over hundreds |

The tiered model: projects touched in the last few minutes hold persistent pools; warm projects go through PgBouncer's multiplexing; cold projects pay full connection setup (~50–100ms) on first touch. Traffic is heavily skewed — the active 20% of projects generate ~80% of queries — so the hot tier captures most of the reuse benefit within a bounded footprint.

**What we give up**: cold-start latency for dormant projects, and the operational surface of PgBouncer itself — another process to monitor, plus transaction-mode restrictions on session state (prepared statements, session variables). Both are cheaper than the alternative bottleneck: file descriptors and ~10MB of target-side backend memory per idle connection, multiplied by every project anyone ever created.

## 🔧 Deep Dive 2: Schema Introspection — Fresh, Fast, and Not N+1

Introspection powers the table editor: discover every table, its columns, constraints, and approximate size from a database we've never seen.

**The pipeline:**

1. Load and decrypt the project's connection config from metadata
2. Open a **short-lived dedicated connection** to the target (not a pooled one)
3. Query the standard information_schema views: tables (public base tables), columns (name, type, nullable, default, ordinal position), then the constraint joins for primary and foreign keys
4. Read approximate row counts from the planner's statistics (reltuples) instead of counting rows
5. Assemble structured per-table results and return

**Why information_schema over the native catalog tables?** The standard views return human-readable types ("character varying", "integer") rather than type OIDs, and the constraint-join patterns are portable and well-documented. The native catalog is faster (no view overhead) and exposes more — custom types, storage parameters, statistics — but a schema *browser* wants exactly the readable subset the standard views provide. I'd drop to the catalog only for features the views can't express.

**Why estimated counts instead of exact ones?** A real count is a full table scan — seconds to minutes on a 100M-row table, holding a connection the whole time, on a database we don't own. Planner estimates are typically within ~10% once autovacuum's analyze has run, which is exactly right for a "~1.2M rows" badge. Exact counting becomes an explicit user-triggered action with a warning, never a default.

**Why a fresh connection instead of the pool?** Pooled sessions can carry cached catalog state and stale search_path settings; a dedicated connection guarantees the introspection reflects DDL that committed a millisecond ago. The ~50ms setup cost lands on a navigation event (opening the table editor), not in a hot loop.

**The N+1 problem, and when it bites:**

> "The naive pipeline runs three constraint/column queries *per table* — 301 round trips for a 100-table database, and against a target 50ms of network away that's 15 seconds, thirty times over the 500ms budget. The fix is batching: one query for all columns across all tables, one for all primary keys, one for all foreign keys, grouped by table name in application memory — four round trips total, independent of table count. I'd ship the batched form from day one at production scale; the per-table form only survives locally because localhost round trips are free. This is the classic case where the bottleneck is round-trip count, not query cost — each individual query takes milliseconds, there are just three hundred of them."

**Caching at scale**: introspection results cached in Redis with a 60-second TTL, invalidated eagerly on any DDL executed *through us*. External DDL — a teammate's migration hitting the target directly — is covered by the TTL: a bounded 60-second staleness window we accept and document, because the alternative (no cache) re-runs a multi-query pipeline on every sidebar render across thousands of tenants.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ 60s TTL + eager self-invalidation | Zero staleness for our own DDL; bounded for external | A minute of possible external-DDL staleness |
| ❌ No cache | Always perfectly fresh | Introspection pipeline × every render × every tenant |
| ❌ Long TTL + event-based invalidation | Fewest queries | No reliable DDL event source exists on databases we don't own |

## 🔧 Deep Dive 3: Executing Hostile SQL Safely

Users run arbitrary SQL. The threat model isn't just malice — it's the innocent SELECT that joins two 10M-row tables, or the script that hammers the execute endpoint in a loop.

**Decision: resource governance instead of SQL inspection.** Defense in depth, every layer independent:

1. **Least-privilege credentials**: the connection role users configure should hold only the grants they intend; at production scale we provision a scoped role per project. PostgreSQL's own permission system is the real gatekeeper.
2. **Statement timeout**: a 30s hard cap set on the session kills runaway queries server-side; a 5s connect timeout makes dead hosts fail fast.
3. **Rate limiting**: 100 executions/minute per user — an order of magnitude above interactive typing speed, an order of magnitude below scripted abuse. Auth endpoints get a much stricter budget (brute-force protection), the general API a looser one.
4. **Result caps**: rows beyond a configurable limit are truncated with a warning flag; a billion-row SELECT must not materialize in our heap.
5. **Circuit breaker** around all target operations: opens at 50% error rate, half-opens after 30s. When a target dies, requests fail in milliseconds with a clear message instead of stacking 30-second timeouts that consume the event loop.

**Why not parse SQL and block dangerous statements?**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Timeouts + privileges + limits | Catches every case incl. dynamic SQL; simple | Destructive-but-authorized statements run |
| ❌ Statement parsing / blocklists | Feels safe in a demo | Trivially bypassed via DO blocks, functions, CTEs, string-built SQL; permanent cat-and-mouse |
| ❌ Forced read-only mode | Genuinely safe | Breaks the product — a management console must mutate |

> "Parsing user SQL to block scary keywords is security theater against an adversary who has a full programming language on the other end — a DO block or a function call executes anything without the keyword ever appearing in my parser's view. Worse, the blocklist punishes legitimate users who *should* be able to drop their own tables from a database console. The honest boundary is PostgreSQL's privilege system for authorization plus my resource limits for protecting the *service*. What I give up: a user with write credentials can destroy their own data through us. That is the product working as designed — mitigated by confirmation UX upstream and, at production scale, point-in-time backups, not by pretending a regex is a security boundary."

**DDL generation is the one place we construct SQL ourselves** — from structured form inputs, never from user SQL strings. Identifiers are sanitized to alphanumeric-plus-underscore and reserved words are quoted; values never appear in DDL at all, so injection through a table *name* dies in the sanitizer. The generator deliberately supports only the common type-and-constraint set — partial indexes, generated columns, and custom types route to the SQL editor. An 80/20 boundary that keeps the safe path safe and the power path powerful.

**Error passthrough**: PostgreSQL errors return to the client verbatim — code, message, position offset. For a developer console the error *is* the product; sanitizing it would be self-sabotage. This is defensible only because callers are authenticated project members querying their own databases, not anonymous internet traffic.

**A tempting alternative I'd reject explicitly: sandboxing each query in an ephemeral, resource-capped worker.** Running the query executor inside a per-request container with a hard memory cgroup limit sounds like the "really safe" answer, and for a *code execution* product it would be right. Here it's the wrong tool: the thing that needs isolating isn't our process, it's the *target database's* resources, and a container around our client can't cap CPU or I/O on a server we don't own. It adds container cold-start latency (hundreds of ms, blowing the 500ms introspection budget on its own) to defend against a threat model the timeout-and-privilege layers already cover. I'd reconsider this only if we were ever asked to execute arbitrary code, not arbitrary SQL against a permissioned database connection — those are genuinely different problems with different right answers.

## 🔐 Security

Layered, in order of evaluation:

1. **Authentication**: Valkey-backed sessions, httpOnly + sameSite cookies, bcrypt password hashing, aggressive rate limits on auth endpoints (credential stuffing is the cheap attack).
2. **Authorization**: project membership checked from the metadata DB on every project-scoped route — target credentials are never even loaded for a non-member.
3. **Credential handling**: target passwords envelope-encrypted at rest, decrypted only at connect time, redacted from logs, never serialized into API responses (settings reads return host/port/user but mask the password).
4. **SSRF — the attack unique to this product**: users tell *our* servers to open TCP connections to arbitrary host:port pairs. Without controls, "add a project" becomes a port scanner and internal-network probe — pointing the dashboard at our own metadata database, cloud metadata endpoints, or internal services.

> "The SSRF surface is the security question I'd spend interview time on, because it falls out of the core feature rather than an implementation bug. Mitigations: resolve and validate the target host against a denylist of private and link-local ranges before connecting (re-validating post-DNS-resolution to beat DNS rebinding), run target-connection workers in an egress-restricted network segment where internal services simply aren't routable, and rate-limit connection tests so failed probes are slow and noisy. The network-segmentation option is the strong one — policy enforced by routing tables can't be bypassed by a clever hostname."

5. **Injection surfaces**: user *values* go through parameterized queries everywhere we build SQL (row CRUD); user *identifiers* go through the sanitizer (DDL generation); user *SQL* is passed through untouched by design, governed by privileges and resource limits as covered in Deep Dive 3.

## 🛡️ Consistency, Idempotency, and Sessions

- **Metadata writes** are ordinary single-database transactions; project creation plus initial membership commits atomically.
- **User SQL is not wrapped in transactions by us.** Each statement runs standalone; users needing atomic multi-statement DDL write explicit transaction blocks themselves. Auto-wrapping would hold locks across user think-time — a lock held open while someone reads the docs is a denial of service against their own database.
- **Pool eviction on settings change is eventual by design**: in-flight queries finish on old credentials; subsequent queries use new ones. Killing in-flight queries to force instant cutover would turn every settings save into a spray of query failures.
- **SQL execution is not idempotent and must not pretend to be** — we never auto-retry a user statement, because re-running an INSERT after a timeout could double-write. Retry is a human decision, surfaced as an error. Metadata mutations, by contrast, retry safely against their natural keys (unique membership, unique email per project).
- **Sessions** live in Valkey behind httpOnly cookies: immediate revocation on logout, no token-refresh machinery. The right auth model for a console whose users hold database credentials — "log this user out *now*" matters more than stateless verification.
- **Connection-test results are never cached as truth.** A green "connected" indicator on a project card is a point-in-time probe, not a guarantee — the next real query can still fail if the target dropped in between. Treating it as a cache would let a stale green light mask an actual outage.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| Query execution histogram, labeled by project and statement class | The core tenant-health signal — one project going slow means *their* database is sick, not our service; the label makes that diagnosis a single query |
| Active-pool gauge per instance | Capacity planning; approaching the 200-pool cap triggers scale-out before eviction thrash begins |
| Circuit-breaker state transitions | An opened breaker is the "target X is down" event log; many opening at once implicates *our* network, not their databases — opposite pages |
| HTTP latency histograms by route | Separates metadata-path regressions (ours to fix) from target-path noise (theirs) |
| Structured JSON logs with project id on every entry | Multi-tenant debugging is filtering; without the tenant key, logs are write-only |

Health checks probe only the metadata database. Target databases are deliberately excluded — a user's dead database must never mark *our* instance unhealthy and trigger a pointless restart loop.

A liveness check and a readiness check are kept distinct: liveness (is the process alive) never touches the database at all, so a slow metadata query never causes the orchestrator to kill and restart an otherwise-healthy process; readiness (should the load balancer send traffic here) is the one that probes the metadata connection.

**Alerting priorities**, in order of how directly they threaten multi-tenancy: (1) circuit breakers open on more than a handful of projects simultaneously — usually points at our egress network, not their databases; (2) active-pool gauge sustained near the eviction threshold — capacity, not correctness; (3) p99 query-execution duration for the metadata-path routes specifically (never mix target-path latency into this alert, since a slow user query is expected, not an incident); (4) rate-limit rejection rate — a spike is either abuse or a client bug retrying too aggressively.

## 📉 Failure Handling

- **Target unreachable**: breaker opens → fast, explicit failure; pool evicted; metadata features unaffected. The blast radius of a dead target is exactly the data sections of one project.
- **Metadata DB down**: the instance fails health checks and leaves rotation. This is the real outage; replicas and standard PostgreSQL HA apply, because this database is ours to engineer.
- **Valkey down**: sessions unavailable, authenticated requests fail. Mitigation: Redis replication; optionally a short per-instance session cache for degraded reads.
- **Bounded worst case per tenant**: statement timeout × result cap × rate limit gives a computable ceiling on connection-hold time, memory, and request volume per user. That arithmetic being finite *is* the multi-tenancy guarantee.
- **Instance crash**: pools are process state and vanish — nothing to recover. Sessions (Valkey) and data (PostgreSQL) survive; the replacement warms pools lazily on first use.

**Retry semantics by operation class** — the table I'd want reviewers to check first, because getting this wrong is how a console corrupts user data:

| Operation | Safe to auto-retry? | Why |
|-----------|---------------------|-----|
| GET (list projects, introspect, read rows) | Yes | No side effects |
| POST /sql/execute | No | Statement identity is unknown to us — could be an INSERT |
| POST row insert | No, unless client sends an idempotency key | Naive retry double-inserts |
| PUT row update / project settings | Yes | Overwrite semantics — replaying is a no-op if nothing changed since |
| DELETE row / project | Yes | Deleting an already-deleted resource is a no-op, not an error worth surfacing |
| POST create table (DDL) | No | A retried CREATE TABLE fails loudly (relation exists) — which is actually the right outcome: surfaced to the user, not silently swallowed |

The pattern: idempotent-by-nature HTTP verbs (GET, PUT, DELETE) retry safely because their semantics already tolerate replay; POST operations that mutate through arbitrary user SQL cannot be made safe by the framework and are left to explicit user-driven retry.

## 📈 Scalability: What Breaks First

1. **First: connection-pool footprint per instance.** File descriptors and target-side backend memory, not CPU. ~1,000 active projects × 5 connections exceeds any sane budget. Fix in order: LRU pool caps → PgBouncer transaction-mode multiplexing → hot/warm/cold tiering. This is Deep Dive 1's ladder, and it's why the pool manager is an interface, not a bare map.
2. **Second: introspection load.** Every table-editor visit across every tenant re-runs the pipeline. Fix: the batched four-query form plus the 60s Redis cache — together cutting round trips per call and calls per minute by an order of magnitude each.
3. **Third: metadata read traffic** — project lists and saved queries on every dashboard load. Fix: read replicas; textbook read scaling on a database we own end to end.
4. **Fourth: noisy-neighbor SQL on shared API instances.** A tenant saturating executor concurrency starves other tenants' event-loop time. Fix: per-tenant concurrency quotas, then a dedicated query-execution service so the metadata API's latency is fully insulated from query workloads — the first real service split this architecture would undergo.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Data placement | ✅ Separate metadata + target DBs | ❌ One DB, schema-separated | User DDL can't collide with our migrations; external targets are the product |
| Pool strategy | ✅ Per-instance cached pools + LRU | ❌ Central connection broker | No stateful hot-path SPOF; instances recover by rebuilding lazily |
| Pool cap | ✅ 5 per project | ❌ Uncapped | We must never be the reason a user's DB hits max_connections |
| Introspection source | ✅ Standard schema views | ❌ Native catalog | Readable types, portable joins; catalog only when views can't express it |
| Row counts | ✅ Planner estimates | ❌ Exact counts | Seconds-long scans on foreign hardware vs ±10% on a badge |
| SQL safety | ✅ Privileges + timeouts + limits | ❌ Statement parsing | Blocklists lose to dynamic SQL; resource governance can't be bypassed |
| Introspection freshness | ✅ Fresh conn + 60s cache, eager self-invalidation | ❌ Long-lived cache | Zero staleness for our DDL; bounded for external |
| Error surface | ✅ Verbatim PostgreSQL errors | ❌ Sanitized messages | The error text is the product for a developer console |
| Auth | ✅ Valkey sessions | ❌ JWT | Instant revocation for credential-holding users beats stateless verification |
| Query isolation | ✅ Timeouts + privileges on the shared executor | ❌ Per-query sandboxed container | Isolates the wrong resource — target-DB load, not our process |

## 🧪 Testing Strategy

- **Introspection pipeline tests** run against a real ephemeral PostgreSQL container seeded with a known schema (varied types, composite constraints, self-referencing FKs) — mocking information_schema is pointless when the whole point is faithfully reflecting real catalog behavior.
- **Pool manager tests** exercise creation, eviction on settings change, and idle timeout with fake timers, plus a chaos test that kills the target mid-query to verify the pool is evicted rather than retried into.
- **DDL generator tests** are property-based on identifiers: reserved words, embedded quotes, unicode, SQL-injection payloads as table names — asserting the sanitizer always produces a safely quoted identifier and never a syntax error from unescaped input.
- **Circuit breaker tests** assert the state machine directly (closed → open at threshold → half-open after cooldown → closed on success) rather than only checking end-to-end latency, since the failure mode we care about is *when* it trips, not just *that* it eventually helps.
- Route-level tests mock the shared DB/cache/pool modules per the repo's standard pattern, keeping unit tests fast while the introspection and pool-manager suites above cover the parts that only fail against a real PostgreSQL wire protocol.
- **Load testing target operations, not just metadata ones**: the meaningful load test here is hundreds of simulated projects each with their own target database, verifying the pool-eviction and circuit-breaker logic under realistic churn — a load test that only hammers /api/projects would validate the wrong bottleneck entirely, given the scale analysis above.

## 🚀 Closing: What I'd Build Next

With more time I'd cover: KMS envelope encryption and rotation workflows for stored target credentials — the most sensitive data in the system; the dedicated query-execution service with per-tenant concurrency quotas and a query-cancellation endpoint; asynchronous execution for long analytics queries (submit, poll, cancel) so the 30-second cap stops being a product ceiling; and schema-change capture — recording DDL events flowing through us to feed live schema updates to connected dashboards, turning the frontend's poll-and-refetch freshness model into an event-driven one.

I'd also flag the natural next architectural step once this system outgrows a single deployment: per-project database provisioning, where each new project gets its own isolated PostgreSQL instance (container or managed service) rather than pointing at user-supplied connection strings. That's the real production Supabase model — it removes the SSRF surface entirely (we provision the host, we know it's safe), simplifies credential management (we generate and rotate the password, never store a user-typed one), and turns "connection pool per arbitrary external host" into "connection pool per instance we control," which is a fundamentally easier operational problem.

The current design — bring-your-own-database — is the right scope for this exercise because it isolates the interesting distributed-systems problems (dynamic pooling, runtime introspection, safe arbitrary-SQL execution) without the provisioning and billing machinery a real multi-tenant platform would also need. If I were asked to extend this system in a follow-up round, provisioning is where I'd start, because it's the one change that simplifies almost every other component discussed here — connection management, security, and credential handling all get strictly easier once we control the target infrastructure.

# Supabase Dashboard - System Design Answer (Full-Stack)

*45-minute system design interview format - Full-Stack / Generalist Position*

## 📋 Problem Statement

Design a Backend-as-a-Service management dashboard like Supabase Studio: developers register database projects, browse and edit schemas they've never seen before, run arbitrary SQL, and administer authentication users.

The system has two faces that must agree with each other end to end. The backend is a multi-tenant proxy managing dynamic connections to thousands of foreign PostgreSQL databases with unknown schemas. The frontend renders UI it cannot know at build time — every grid column, every form field is shaped by what introspection returns at runtime. The seam between them — what the API promises about freshness, and what the UI assumes as a result — is where this system either feels trustworthy or doesn't.

## 🎯 Requirements Clarification

- **Who is the user, and how fresh must data be?** Developers, desktop, side-by-side with their editor. Freshness is non-negotiable: a developer runs DDL and expects the next screen to reflect it. This single requirement shapes both halves of the stack.
- **How dangerous can user SQL be?** Fully arbitrary, including DDL and destructive statements — we're a console, not a gatekeeper, but must protect our own service from it.
- **Scale?** Thousands of projects, each a small personal or team database. The scale problem isn't request throughput — it's the *shape* of resource consumption across many independent, unpredictable, foreign systems.

### Scale Estimates

- ~10,000 registered projects, ~2,000 active in a given hour, heavily skewed toward a hot 20% driving ~80% of traffic
- A working session issues roughly 5-10 target operations/minute — bursty navigation and query bursts, not a stream
- Peak concurrency around 500 dashboard sessions — a request volume the HTTP tier shrugs off; the scarce resources are target-database connections and per-query memory, not throughput
- Median SELECT returns under 100 rows; the tail is unbounded, which is why result caps are a correctness feature on the backend and a rendering concern on the frontend, not an optimization on either side

### Functional Requirements

- Project CRUD with per-project connection configuration and membership
- Schema introspection: tables, columns, types, PK/FK constraints, approximate row counts
- Spreadsheet-like table data browser: paginated, sortable, inline-editable, insert/delete
- SQL editor: execution, result display, saved queries
- DDL generation from structured forms (create/alter/drop table)
- Simulated auth user management
- Connection testing with live status

### Non-Functional Requirements

- Schema introspection under 500ms for a 100-table database
- SQL execution capped at 30s
- Sub-200ms perceived navigation between dashboard sections
- Session-based auth with immediate revocation
- Dark theme matching Supabase branding, keyboard-first SQL workflow

## 🏗️ High-Level Architecture

```
┌────────────────────────────────────────────┐
│         Client (React SPA, dark theme)       │
│  Tables │ SQL editor │ Auth │ Settings       │
└───────────────────┬──────────────────────────┘
                    │ HTTPS / JSON, credentials included
             ┌──────┴───────┐
             │  Express API  │  stateless, N instances
             └──────┬───────┘
     ┌───────────────┼────────────────┐
     ▼                ▼                ▼
┌─────────┐   ┌───────────────┐  ┌──────────┐
│Metadata │   │ Dynamic pool  │  │  Valkey  │
│   DB    │   │   manager     │  │ sessions,│
│(ours)   │   │ per-project   │  │  cache   │
└─────────┘   └──────┬────────┘  └──────────┘
                     │
              ┌──────┴──────┐
              │ Target DBs  │  user-owned, unknown schema
              └─────────────┘
```

Three data paths, and the frontend never has to know which one it hit: (1) metadata operations — projects, saved queries, auth users — read/write our own PostgreSQL; (2) target operations — introspection, row CRUD, SQL execution — flow through the dynamic pool manager to a database we don't control; (3) session operations hit Valkey. A single route handler resolves which target a request needs by looking up the project's stored connection config, then dispatches — the frontend just calls one consistent API surface.

**Frontend structure**: TanStack Router nested layouts. The root handles a single session check on load; `/project/:id` mounts a persistent sidebar and breadcrumb once, with Tables, SQL, Auth, and Settings as child routes rendering into a shared content outlet. Two Zustand stores — a small auth store, and a single project-scoped store holding tables, row data, query results, saved queries, auth users, and settings. One store rather than several because a project switch has to reset every one of those domains atomically; per-feature stores would need cross-store choreography to avoid flashing project A's data under project B's header.

**Backend structure**: stateless Express instances behind a load balancer, each holding its own in-memory map of per-project connection pools, backed by the metadata database (PostgreSQL), a Redis/Valkey layer for sessions and a short-TTL introspection cache, and a circuit breaker wrapping every target-database call.

## 💾 Data Model

| Table | Key Columns | Notes |
|-------|-------------|-------|
| users | id, username (unique), email (unique), password_hash | Dashboard operators |
| projects | id, name, db_host/port/name/user/password (encrypted), created_by | The pivot — one row per target database |
| project_members | project_id, user_id, role | Authorization scope |
| saved_queries | id, project_id, name, query_text, created_by | Reusable SQL |
| auth_users | id, project_id, email, encrypted_password, role, email_confirmed, raw_user_metadata (JSONB) | Simulated GoTrue, scoped per project |

The target database carries no schema we define — it's discovered, not modeled. That single fact is why this system's frontend and backend are unusually coupled: the backend's introspection response format *is* the frontend's data model, defined nowhere but in that API contract.

## 🔌 API Design

```
POST/GET  /api/auth/{register,login,logout,me}

GET/POST         /api/projects                          list / create
POST              /api/projects/:id/test-connection

GET/POST         /api/projects/:pid/tables              introspect / create table (DDL)
PUT/DELETE       /api/projects/:pid/tables/:name         alter / drop

GET/POST         /api/projects/:pid/tables/:name/rows            page / insert
PUT/DELETE       /api/projects/:pid/tables/:name/rows/:id        update / delete

POST             /api/projects/:pid/sql/execute          run arbitrary SQL
GET/POST         /api/projects/:pid/sql/saved            saved query CRUD

GET/POST         /api/projects/:pid/auth-users           auth user CRUD
GET/PUT          /api/projects/:pid/settings             connection config (PUT evicts pool)
```

## 🔧 Deep Dive 1: The Two-Database Architecture — and the Seam It Creates

**Decision: metadata and target live on completely separate PostgreSQL instances, and every route handler is aware of the split.**

> "If they shared a database, three things break at once. A user could name a table 'saved_queries' and collide with our own schema. Our admin credentials would necessarily have reach into user data, which is a blast radius we don't want. And we couldn't support the actual product — connecting to *external* databases — because there'd be nothing to point at. Two databases costs us a second round trip on every target operation (~50-100ms) and real connection-lifecycle code, but it's the only design where a dashboard bug can't touch a user's data and a user's DDL can't touch ours."

**What this means for the frontend, concretely — the request flow for opening the table editor:**

1. Frontend calls GET `/api/projects/:pid/tables`
2. Backend authorizes against project_members (metadata DB) — before touching anything else
3. Backend loads and decrypts connection config (metadata DB, second query)
4. Backend opens a **fresh, unpooled** connection to the target and runs the introspection queries
5. Backend returns structured TableInfo[]; frontend renders the schema viewer directly from that shape — no client-side interpretation of raw catalog rows, because the wire format *is* the frontend's data model

**Why a fresh connection instead of reusing a pool for step 4?** Pooled sessions can carry stale catalog caches; a dedicated connection guarantees the response reflects DDL that committed a moment ago. This is a backend implementation detail, but it's the mechanism underwriting a frontend promise: *what you see in the schema viewer is current*. If the backend cut this corner for speed, the frontend's entire freshness contract (Deep Dive 2) would be built on sand.

**The seam, stated plainly**: the frontend cannot verify freshness independently — it has no other channel into the target database. It has to *trust* that every introspection response is live. That trust is the API contract, and it's why I treat "fresh connection for introspection" as a correctness requirement, not a performance knob.

## 🔧 Deep Dive 2: One Freshness Contract, Enforced on Both Sides

This is the deep dive that only makes sense told full-stack, because it's a single design decision implemented as two halves that have to agree.

**The contract**: *the UI never shows target-database state that hasn't been confirmed by a fresh server read since the last mutation.* No optimistic rendering of schema or row changes, no client cache with a lifetime, no assumption that a write "probably succeeded."

**Backend half**: introspection uses fresh connections (Deep Dive 1); SQL execution and row writes return the actual server result (rows affected, new values, or a verbatim error) rather than an acknowledgment; a Redis-backed 60-second TTL cache exists purely for *read* traffic reduction and is eagerly invalidated on any DDL executed through us.

**Frontend half**: every mutating action — create table, alter column, insert/update/delete a row, run DDL through the SQL editor — is followed by an explicit refetch of the affected domain, never a local patch of the store. The store holds "last confirmed server state," not a cache with a lifetime.

> "The reason this has to be a two-sided contract and not just a frontend policy: the frontend's honesty is only as good as what the backend actually guarantees. If I built the UI to 'trust the last write' while the backend's introspection could silently serve a stale cached response, the two halves would disagree in exactly the moments that matter — right after a user does something destructive. I designed these together: the backend's 60-second cache is scoped to *unprompted* reads (a page load, a sidebar click with no preceding mutation); it is never in the path immediately following a mutation, because the frontend's refetch call and the backend's self-invalidation are the same event, described from two sides."

**What breaks this contract, and how each side is supposed to catch it:**

- **External DDL** (a teammate's migration, hitting the target directly): invisible to both sides until the next unprompted introspection call, bounded by the 60-second cache TTL. This is the one gap neither layer can close alone — no webhook exists from an arbitrary PostgreSQL server telling us its schema changed. I'd surface this honestly rather than pretend otherwise: a schema-version check the frontend polls at low frequency, comparing against a hash the backend computes per introspection, would shrink this window without claiming perfection.
- **A mutation that returns 200 but didn't actually apply everything** (partial DDL failure inside a non-transactional multi-statement block): the backend's error passthrough surfaces PostgreSQL's actual response; the frontend's refetch-after-mutate means the UI reflects whatever *actually* happened, not what the UI assumed would happen. This is precisely why refetch-after-mutate beats optimistic patching here — the frontend literally cannot predict the DDL generator's output well enough to patch state correctly.

**The trade-off across the stack**: extra round trips, on both sides — the backend's fresh-connection introspection and the frontend's refetch-after-mutate both spend latency to buy correctness. For a database console, that's the right trade. It would be wrong for a social feed, which is exactly why I want to be explicit that this decision is *product-specific*, not a default I reach for everywhere.

## 🔧 Deep Dive 3: DDL Generation — a Form on One Side, a Sanitizer on the Other

Users create and alter tables through structured forms rather than raw SQL. This flow crosses the stack more times than any other feature.

**The full round trip:**

1. Frontend's CreateTableModal pre-seeds an id (serial PK) and created_at (timestamptz, now() default) — the common starting point for any new table
2. User adds columns via repeated ColumnEditor rows: name (text), type (a fixed dropdown of ~16 common PostgreSQL types, not free text), nullable, primary key, default
3. Frontend submits structured column definitions as JSON — never a SQL string — to POST `/api/projects/:pid/tables`
4. Backend's DDL generator builds the CREATE statement from these definitions, sanitizing every identifier (strip to alphanumeric-and-underscore, quote reserved words) before it ever touches a query string
5. Backend executes against the target and returns the generated SQL alongside the result
6. Frontend shows that generated SQL in a confirmation toast — a deliberate transparency feature, not just a debug aid
7. Frontend refetches the schema domain and renders the new table from live introspection

**Why split the responsibility this way instead of either extreme?**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Structured form (frontend) → sanitized generator (backend) | Validated before submission, injection-safe by construction, guided UX | Limited to ~16 types and common constraints |
| ❌ Raw SQL textarea only, no structured path | Full flexibility from day one | No client-side validation; every table-creation typo is a round trip and a cryptic Postgres error |
| ❌ Client-side SQL string building, backend executes as-is | Simple backend | Identifier sanitization now has to happen in the browser, where it can't be trusted — the backend must re-validate anyway, so the frontend's work is redundant *and* the security boundary is in the wrong place |

> "The type dropdown is a frontend UX decision with a backend security consequence, and that pairing is the interesting part. Free-text type input would need backend validation against the real PostgreSQL type catalog anyway — so constraining it in the UI doesn't remove backend work, but it does turn a class of errors (typo'd type name) from a server round trip into instant client-side feedback. Meanwhile the identifier sanitizer is backend-only and non-negotiable regardless of what the frontend sends, because the frontend's dropdown constrains the common path but a malicious client can still POST whatever JSON it wants directly to the API. The frontend UX and the backend security boundary are solving different problems that happen to line up on the same feature."

**The 80/20 boundary is enforced consistently on both sides**: the type dropdown and the alter-table operations (add/drop/rename column only, no type changes) cover common cases; anything beyond — partial indexes, CHECK constraints, custom types, column type changes with USING casts — routes to the SQL editor on the frontend and the unrestricted execute path on the backend. Neither side pretends to support more than it does.

## 🔧 Deep Dive 4: Auth User Simulation — Where We Chose Not to Build a Second Product

Supabase's real auth is GoTrue: JWT issuance, OAuth, email flows, MFA. Building that is a separate system design problem the size of this whole dashboard.

**What we built instead**: auth_users lives in the *metadata* database, not the target, with email, encrypted password, role (authenticated/anon/service_role), confirmation status, and a JSONB metadata bag. The frontend's AuthUserList and AuthUserForm are ordinary CRUD screens — no JWT decoding, no OAuth redirect handling, no token refresh logic anywhere in the client.

**Why metadata DB, not the target?** Writing auth.users into the user's own database would mean running our schema's DDL on infrastructure we don't own, for a feature that's dashboard simulation, not their application's actual auth. Keeping it on our side means zero footprint on the target database and one consistent backup/restore story for all dashboard state.

**The full-stack shape of "simulation, not implementation"**: the backend never issues a JWT — the frontend never expects one. The role field exists because it maps to Supabase's actual row-level-security claim structure, so the *concept* is faithfully represented even though the *enforcement* isn't built. This is a case where being honest about scope on both sides matters more than either side trying to compensate — a frontend building JWT-handling UI against a backend that doesn't issue JWTs would be strictly worse than neither side pretending.

## 🔧 Deep Dive 5: Connection Pooling — a Backend Resource Decision With a Frontend Consequence

**Decision: the backend caches a small pool (max 5 connections) per project, keyed in an in-memory map; pools are evicted on settings change, idle timeout, or error.** This is framed as a backend deep dive everywhere else it's discussed in this system, but the frontend has a real stake in it that's worth surfacing explicitly.

**The mechanism**: first target operation for a project creates the pool; subsequent operations reuse it; a settings PUT evicts it so credential changes take effect without a restart; idle connections close after 60 seconds; pool-level errors evict immediately rather than retrying into a dead endpoint.

**Where this surfaces in the UI**: the settings page's "Test Connection" button and the "Save" action are not the same event, and the frontend has to model that distinction correctly. Testing a connection probes connectivity without touching the cached pool. Saving new settings evicts the pool — meaning the *next* query anywhere in the dashboard (table browser, SQL editor) pays the ~50-100ms cost of establishing a fresh connection with the new credentials. If the frontend didn't understand this, a user could save new settings, immediately jump to the SQL editor, and experience a small unexplained hitch on their first query. Because the backend and frontend agree on this behavior, the settings page can show an explicit "connection will refresh on next use" note instead of the hitch being a mystery.

> "This is a good example of a decision that looks purely backend on paper — pool sizing, eviction policy — but has a UI-visible edge if you don't design for it deliberately. I'd rather the frontend acknowledge the eviction explicitly than have users experience unexplained latency and file it as a bug report."

**Connection budget at scale**, the numbers that justify the cap of 5:

| Scale | Strategy | Connection budget |
|-------|----------|-------------------|
| ~100 projects/instance | Direct pools, 60s idle timeout | ≤ 500 connections |
| ~1,000 | LRU eviction at ~200 pools/instance | ≤ 1,000 connections |
| 10,000+ | PgBouncer multiplexing + hot/warm/cold tiers | Thousands multiplexed over hundreds |

At the low end, this is invisible to the frontend. At the high end, it isn't: a cold project (not touched in hours) pays full connection setup on its first query of the day, which is squarely inside the frontend's job to communicate as a loading state rather than let a user believe the app is frozen.

## 🔐 Deep Dive 6: Executing Arbitrary SQL Is the Product

Every other system I'd design treats "user-supplied SQL reaches the database" as
the thing to prevent. Here it's the feature. That inverts the usual security
posture and it's worth being explicit about what replaces it.

### Why the normal defence doesn't apply

Parameterized queries stop injection by separating code from data. That works
because in a normal application the *code* is ours and only the *data* is the
user's. In a SQL editor the user supplies the code. There is no parameter
boundary to enforce, no allowlist of statements that would leave the feature
intact, and no parser we could write that distinguishes "legitimate `DROP
TABLE`" from "malicious `DROP TABLE`" — because on your own database, dropping
your own table is legitimate.

> "So I stopped trying to make the SQL safe and made the *connection* safe
> instead. The question isn't 'is this query dangerous' — many are, and that's
> allowed. The question is 'can this query affect anything outside the project
> it was submitted against.' That's answerable, and it's answerable in one
> place rather than per-statement."

### Where the boundary actually sits

```
   user's SQL ──▶ [ our API: authz + rate limit + timeout ]
                            │
                            │  connection belongs to exactly one project
                            ▼
                  ┌──────────────────────┐
                  │  target database     │   ← user's own data, their blast radius
                  │  (their credentials) │
                  └──────────────────────┘

   our metadata DB  ← never reachable from this path, separate pool, separate creds
```

Four properties carry the whole model:

| Control | What it prevents |
|---------|------------------|
| **Connection is project-scoped** | A query can only ever touch the database the caller is authorized for — there is no connection object in that path that can reach another tenant |
| **Separate pool and credentials for metadata** | No user SQL can read our `projects`, `users`, or stored connection secrets, because that database isn't on the other end of this socket |
| **Statement timeout** | A runaway or deliberately expensive query burns the user's own database, then gets cut — it can't hold our worker indefinitely |
| **Authorization before execution** | Project membership is checked against metadata before a target connection is even acquired |

### What we're accepting

A user can absolutely destroy their own data through this editor, and I'm
choosing not to prevent that. Adding confirmation dialogs for destructive
statements would mean parsing SQL to classify it, which is both unreliable
(comments, CTEs, `DO` blocks, dynamic SQL) and a false comfort — a tool that
warns on 90% of destructive statements teaches people to trust warnings that
sometimes don't come.

The more subtle acceptance is **resource exhaustion of the target**. A user's
own bad query can lock their tables or exhaust their connections, and our
per-project pool limit means they can only do it to themselves. That's the
containment goal: blast radius equals one tenant, and that tenant is the one who
typed the query.

> "The one thing I would not ship without is the credential-storage story. We
> hold connection passwords for databases we don't own, which makes our
> metadata database a far more attractive target than any single tenant's data.
> Those need envelope encryption with a KMS-held key rather than sitting in a
> column — and notably, that risk is created entirely by the convenience of
> saving connections, not by the SQL editor everyone worries about first."

### The SSRF connection

This is also why the SSRF mitigation noted below matters more than it first
appears. "Add a project" and "run SQL" compose: if an attacker can point a
project at an internal host, the SQL editor becomes an interactive client for
it. Neither feature is dangerous alone; validating the host at connection-add
time is what keeps them from combining.

---


## 🎨 Perceived Performance Details

A handful of UX choices exist specifically to make backend latency (introspection round trips, connection setup, query execution) feel smaller than it measures:

- The project layout's sidebar and breadcrumb never unmount during section navigation — only the content outlet re-renders, so the sub-200ms navigation target is met by doing less work, not by making the network faster
- Loading states are scoped to the affected panel, never a full-page spinner — the shell staying stable is most of what "feels fast" means for a tool this information-dense
- The SQL editor shows elapsed time while a query runs rather than a generic spinner, because a developer running a slow query wants to know *how* slow, not just that something is happening
- Destructive actions confirm with the object's name in the prompt rather than a generic "Are you sure?" — there's no undo against a live foreign database, so the confirmation is the actual safety mechanism, and it has to be specific to do its job

## 🛡️ Security and Failure Handling

- **SSRF is the security question unique to this product**: "add a project" means our servers open a TCP connection to a user-supplied host:port. Mitigation is backend-only (DNS-rebinding-safe validation against private/link-local ranges, network segmentation) — the frontend has no role here beyond not leaking connection details in error messages.
- **Circuit breaker** around all target operations (opens at 50% error rate, half-open after 30s) means a dead target fails in milliseconds. The frontend renders this as a scoped banner in the data sections while metadata screens (project list, settings, saved queries) stay fully functional — failure isolation on the backend becomes failure isolation in the UI, by design, not by accident.
- **Rate limiting** (100 SQL executions/minute, stricter on auth) protects the target-connection resources; the frontend's job is just to not fight it — no client-side retry loop that could turn a transient rejection into a hammering pattern.
- **Sessions** in Valkey with httpOnly cookies; frontend checks auth once at app load, and any 401 from any call clears client auth state and redirects to login — a single reaction to a single backend signal, not per-route logic duplicated across the client.

## 📊 Observability Across the Stack

The two halves need different signals because they're diagnosing different failure classes.

**Backend metrics**: a query-execution duration histogram labeled by project and statement class (the core tenant-health signal — a slow project means *their* database is unwell, not ours), an active-pool gauge for capacity planning, circuit-breaker state transitions (many opening at once implicates *our* egress network, not user databases), and HTTP latency split by route so metadata-path regressions are never confused with target-path noise. Structured JSON logs carry project id on every entry — in a multi-tenant system, debugging is filtering, and a log without a tenant key is close to write-only.

**Frontend signals**: real-user timing on the two SLO paths — section-navigation time and introspection-to-render time — measured as paint marks, not synthetic benchmarks. Errors surfaced to users are reported with their store domain and project id, the same tenant key the backend uses, so a spike in frontend-reported SQL errors and a spike in the backend's per-project error histogram can be correlated by the same field. That shared key is a small design choice that pays for itself the first time someone has to debug a single tenant's bad afternoon.

**Health checks** are backend-only and deliberately narrow: a liveness probe that never touches a database (so a slow metadata query can't get a healthy process killed) and a readiness probe that checks only the metadata connection — target-database health is explicitly excluded, because a user's dead database must never take our instance out of rotation.

## 🧪 Testing Notes

- **Backend**: route tests mock the shared DB/cache/pool modules; the introspection pipeline and pool-manager lifecycle get their own suites against a real ephemeral PostgreSQL container, because the whole point is faithfully reflecting real catalog behavior that a mock can't approximate.
- **Frontend**: component tests assert the schema-driven rendering rules (type → input affordance mapping) against fixture introspection payloads, and the freshness contract itself gets an integration test — mutate, assert a refetch fired, assert the store never rendered from a response older than the mutation.
- **Cross-stack**: a small set of end-to-end tests exercise the full DDL round trip (form submission → generated SQL → execution → refetch → rendered schema) against real Postgres containers on both sides, because this is the flow most likely to silently drift when either side changes its contract independently.

## 📈 Scalability: What Breaks First

1. **Connection pool footprint** (backend): ~1,000 active projects × 5 connections each exceeds sane file-descriptor and target-side memory budgets. Fix ladder: LRU pool eviction → PgBouncer multiplexing → hot/warm/cold tiering by recent activity.
2. **Introspection load** (backend, felt by frontend as latency): the naive per-table query pattern is N+1 — 301 round trips for 100 tables. Batching to four queries total plus the 60s cache absorbs both the backend's database load and the frontend's perceived wait.
3. **Wide result sets** (frontend): a 200-column × 500-row SELECT is 100K DOM cells — this is where the client, not the server, becomes the bottleneck. Fix: capped rendering plus column virtualization scoped to just the results grid.
4. **Metadata read traffic** (backend): project lists and saved queries on every dashboard load scale with read replicas — ordinary, because it's a database we fully own.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Database architecture | ✅ Two PostgreSQL instances | ❌ Single DB, schema separation | No namespace collision, no shared blast radius, external DBs are the product |
| Freshness contract | ✅ Fresh-read backend + refetch-after-mutate frontend | ❌ Cache-and-patch on either side | A one-sided contract fails exactly when correctness matters most |
| DDL path | ✅ Structured form + backend sanitizer | ❌ Raw SQL only, or client-built SQL | Guided UX and the real security boundary land in the right places |
| Auth simulation | ✅ Metadata-DB CRUD, no JWT | ❌ Full GoTrue-equivalent build | Right-sized scope; neither side pretends to support what isn't built |
| Connection pooling | ✅ Cached per-project pools | ❌ Per-request connections | Amortizes 50-100ms setup; frontend never sees the difference |
| Error surface | ✅ Verbatim PostgreSQL errors, both layers | ❌ Sanitized generic errors | For this audience the error text is the product |
| Row edit UX | ✅ Confirm-then-refetch | ❌ Optimistic updates | Target constraints are unknown to the frontend; false data costs more than 100ms |

## 🚀 Closing: What I'd Build Next

With more time I'd cover: a lightweight schema-version signal so the frontend can detect external DDL between polls, closing the one gap the freshness contract can't currently reach; CodeMirror with schema-aware autocomplete, which is only possible because the introspection response already carries the exact data the editor would need; per-project database provisioning as the production evolution of the connection model, removing the SSRF surface entirely by having us provision the target instead of accepting arbitrary connection strings; and a dedicated query-execution service so a busy tenant's SQL workload stops sharing capacity with the metadata API that every other screen depends on.

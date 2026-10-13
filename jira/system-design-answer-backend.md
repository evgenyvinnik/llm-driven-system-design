# 🎫 Issue Tracker (Jira) — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Jira looks like CRUD on one table. Two things make it a real design problem. First, almost nothing is fixed: every project brings its own workflow, its own permission scheme and its own board order, so the server runs user-defined rules on every write. Second, many people act on the same issues at once, so those rules have to hold under races. I'll build one transactional core in PostgreSQL that decides everything, and treat search, notifications and webhooks as derived systems that may lag but never disagree for long."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the 50:1 read/write ratio |
| High-level architecture | 10 min | One overview diagram and the three core flows |
| Data model & API | 7 min | What lives where, and the contract |
| Deep dive 1: the workflow engine | 8 min | Rules as data, applied with a compare-and-swap |
| Deep dive 2: permission schemes | 7 min | A check on every request that is cheap and revokes instantly |
| Deep dive 3: concurrent edits and board order | 6 min | Versions, `412`, and rank keys |
| Scale, failures, wrap-up | 2 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope, because 'Jira' covers a dozen products. I'll design the core: issues, workflows, permissions, boards and search."

### Functional requirements

1. **Issues**: create, edit, comment, delete, with a complete audit trail of who changed what.
2. **Workflows**: each project has statuses and transitions; a transition can have conditions (who may run it), validators (what must be true) and post-functions (side effects such as "assign to me").
3. **Permission schemes**: reusable sets of grants — "edit issues: Developers", "administer: Administrators", "view: anyone" — attached to projects.
4. **Boards**: a column per status, cards in an order the team chooses; dragging across columns runs a transition, dragging within a column reorders.
5. **JQL search**: `project = DEMO AND assignee = currentUser() AND status IN ("To Do", "In Progress") ORDER BY priority DESC`.
6. **Integrations**: an API that automation retries safely, plus webhooks and notifications.

Out of scope: time tracking, dashboards and reports, attachment processing, marketplace apps.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Issue read latency | p99 < 200 ms | Issue views and boards are the bulk of traffic |
| Write latency | p99 < 300 ms | Edits, transitions and drags must confirm quickly |
| JQL latency | p99 < 1 s | Interactive filtering |
| Search freshness | p99 < 5 s behind writes | The filter should agree with the board within seconds |
| Availability | 99.9%; search may degrade on its own | Teams live in it all day |
| Correctness | No lost updates; no transition that breaks the workflow or permissions | The history is a compliance record for many teams |
| Revocation | Removing a member takes effect on their next request | Slow to revoke is a security incident |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Users | 10M registered, 1M daily, 100K concurrent | Stateless APIs; sessions in Redis |
| Issues | 100M across 1M projects, +100K/day | Most projects are small; shard by project when needed |
| Writes | 1M users × 20/day ≈ 230/s, ~1K/s peak | One PostgreSQL primary holds for years |
| Reads | ~50× writes ≈ 50K/s peak | Cache configuration and permissions; search on Elasticsearch |
| Permission checks | One per request ≈ 50K/s | Must be a cache hit, or it becomes the largest query load |
| History | ~15 rows per issue ≈ 1.5B rows, ~225 GB | Append-only, partitioned by month |
| Events | ~1K/s peak, three consumers | RabbitMQ is plenty |

"Two numbers shape the design: 50,000 permission checks a second means authorization must be a Redis lookup that can still revoke instantly, and 1,000 writes a second against user-defined rules means the rules can't hold row locks while they run."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk through the three journeys: changing an issue, searching, and propagating the change."

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Browser SPA: board, backlog, issue view   ·   API clients: CI jobs, scripts                  │
└────────────────┬────────────────────────────────────────────────────┬────────────────────────┘
                 │ (1) PATCH /issues/:id, POST …/transitions/:t       │ (2) GET /search?jql=…
                 ▼                                                    ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Load balancer · TLS · rate limits per user and per API token                                 │
└────────────────┬────────────────────────────────────────────────────┬────────────────────────┘
                 │                                                    │
                 ▼                                                    ▼
┌──────────────────────────────────────┐                ┌──────────────────────────────────────┐
│ Issue API (stateless)                │                │ Search API (stateless)               │
│ permission checks · workflow engine  │                │ JQL parser → Elasticsearch query     │
│ rank moves · idempotency keys        │                │ filter: projects the user may view   │
└───────┬─────────────────────┬────────┘                └─────┬───────────────────────┬────────┘
        │                     │                               │                       │
        │                     │ permissions, keys             │ visible projects      │
        │ one transaction:    │       ┌──────────────────┐    │                       │
        │ UPDATE … WHERE      │       │ Redis            │    │                       │
        │   version = v       └──────▶│ sessions, cached │◀───┘                       │
        │ + history rows              │ permission sets, │                            │
        │ + outbox row                │ idempotency keys │                            │
        │                             └──────────────────┘          bool query + filter
        ▼                                                                             ▼
┌──────────────────────────────────────┐                ┌──────────────────────────────────────┐
│ PostgreSQL · source of truth         │                │ Elasticsearch · issues index         │
│ issues, history, workflows,          │                │ derived, rebuildable from PG         │
│ permission schemes, outbox           │                └──────────────────────────────────────┘
└────────────────┬─────────────────────┘                                    ▲
                 │ (3) relay publishes outbox rows                          │ versioned upsert
                 ▼                                                          │
┌──────────────────────────────────────┐                ┌───────────────────┴──────────────────┐
│ RabbitMQ · issue.events (fanout)     ├───────────────▶│ Index worker                         │
└────────────────┬─────────────────────┘   issue event  │ re-reads the issue from PG           │
                 │                                      └──────────────────────────────────────┘
                 │ issue event
                 ▼
┌──────────────────────────────────────┐
│ Notification and webhook workers     │
└──────────────────────────────────────┘
```

1. **Edit or transition (1).** The Issue API checks permissions (a Redis hit), evaluates the workflow rules, and commits one transaction: the conditional `UPDATE`, the history rows, and an outbox row describing the change.
2. **Search (2).** The Search API parses the JQL, resolves `currentUser()`, adds a filter for the projects the caller may view, and queries Elasticsearch.
3. **Propagate (3).** A relay publishes outbox rows to RabbitMQ after commit; the index worker rebuilds the search document from PostgreSQL, and the notification and webhook workers consume the same events.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, routing, rate limits | Connections | Automation tokens get their own buckets |
| Issue API | Issues, transitions, ranks, comments, permission checks | Writes, issue reads | Stateless; the workflow engine is a library inside it |
| Search API | JQL parsing and compilation, permission filter | Searches | Stateless; can fail without affecting writes |
| Redis | Sessions, permission sets, workflow definitions, idempotency records | Requests | Losing it makes requests slower, never wrong |
| PostgreSQL | Source of truth, including the outbox | Writes, storage | Primary + replicas; shard by project later |
| RabbitMQ | `issue.events` fanout | Events | Dead-letter queue per consumer |
| Index worker | Rebuilds search documents | Event rate | Versioned, idempotent writes |
| Elasticsearch | JQL and text search | Searches | Derived; rebuildable from PostgreSQL |

"Why is the workflow engine a library inside the Issue API instead of its own service? Because a transition is one decision about one row: read the issue, check the rules, write status, history and outbox together. Splitting the engine out would turn that into a distributed transaction for no gain. What I do split out is search: it has a different store, a different failure mode, and a different scaling curve."

### Flow 1: running a transition

```
 Browser                           Issue API                       Redis           PostgreSQL
    │                                  │                             │                  │
    │ 1 POST /issues/42/transitions/7  │                             │                  │
    │─────────────────────────────────▶│                             │                  │
    │                                  │ 2 cached permission set     │                  │
    │                                  │────────────────────────────▶│                  │
    │                                  │ 3 transition_issue granted  │                  │
    │                                  │◀────────────────────────────│                  │
    │                                  │ 4 SELECT issue: status, version 7              │
    │                                  │───────────────────────────────────────────────▶│
    │                                  │ 5 from-status, conditions, validators          │
    │                                  │ 6 UPDATE … WHERE version = 7, history, outbox  │
    │                                  │───────────────────────────────────────────────▶│
    │                                  │ 7 1 row (0 rows: re-read, retry)               │
    │                                  │◀───────────────────────────────────────────────│
    │ 8 200 issue, ETag "8"            │                             │                  │
    │◀─────────────────────────────────│                             │                  │
    ················· after commit, the relay publishes the outbox row ··················
    │                                  │                             │                  │
```

"Steps 4 and 5 read the issue and evaluate the rules without holding any lock. Step 6 is a compare-and-swap: update only if the version is still the one the rules saw. If zero rows match, someone changed the issue in between — maybe reassigned it, which matters for an 'only the assignee' condition — so I re-read and re-evaluate, up to three times. The outbox row commits with the change, so the event exists exactly when the change does."

### Flow 2: searching with JQL

```
 Browser                      Search API                          Redis    Elasticsearch
    │                              │                                │            │
    │ 1 GET /search?jql=…          │                                │            │
    │─────────────────────────────▶│                                │            │
    │                              │ 2 parse; currentUser() → user id            │
    │                              │ 3 visible project ids          │            │
    │                              │───────────────────────────────▶│            │
    │                              │ 4 ids (miss: from PostgreSQL)  │            │
    │                              │◀───────────────────────────────│            │
    │                              │ 5 bool query + terms filter                 │
    │                              │────────────────────────────────────────────▶│
    │                              │ 6 hits, total                               │
    │                              │◀────────────────────────────────────────────│
    │ 7 200 issues, lag p99 < 5 s  │                                │            │
    │◀─────────────────────────────│                                │            │
    │                              │                                │            │
```

"The parser is recursive descent over a small grammar — `field operator value`, `AND` binding tighter than `OR`, `NOT`, parentheses, `IN` lists, `EMPTY`, functions, `ORDER BY`. Anything it can't place is an error with a position: a parser that silently drops a clause returns the wrong issues, which is worse than refusing. The AST compiles to an Elasticsearch `bool` query, and the visible-project list goes into `filter` context so it is mandatory. `currentUser()` resolves to the caller's id and compares against `assignee_id`, never the display name."

### Flow 3: keeping the index in step

```
PostgreSQL                    RabbitMQ                  Index worker                Elasticsearch
     │                            │                           │                           │
     │ 1 relay publishes event    │                           │                           │
     │───────────────────────────▶│                           │                           │
     │ 2 confirm; mark published  │                           │                           │
     │◀───────────────────────────│                           │                           │
     │                            │ 3 deliver {issue_id: 42}  │                           │
     │                            │──────────────────────────▶│                           │
     │ 4 SELECT issue + names                                 │                           │
     │◀───────────────────────────────────────────────────────│                           │
     │ 5 row, version 8                                       │                           │
     │───────────────────────────────────────────────────────▶│                           │
     │                            │                           │ 6 index v8, external_gte  │
     │                            │                           │──────────────────────────▶│
     │                            │                           │ 7 ok, or 409 if newer     │
     │                            │                           │◀──────────────────────────│
     │                            │ 8 ack                     │                           │
     │                            │◀──────────────────────────│                           │
     │                            │                           │                           │
```

"Events carry ids, not issue contents, so the worker always re-reads PostgreSQL — a stale event still produces a current document. Each document is written with the issue's version and `external_gte`, so a redelivered or late event can't overwrite a newer one. A nightly reconciliation compares `updated_at` against indexed versions to catch anything lost to bugs."

---

## 💾 Data Model (4 min)

"PostgreSQL holds everything that decides behaviour; Redis and Elasticsearch hold copies."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `workflows`, `statuses` | status: `workflow_id`, `name`, `category` (todo / in_progress / done) | Category drives board colours without hard-coding names |
| PostgreSQL | `transitions` | `from_status_id` (null = from any), `to_status_id`, `conditions`, `validators`, `post_functions` (JSON lists) | The whole state machine is rows |
| PostgreSQL | `permission_schemes`, `permission_grants` | grant: `scheme_id`, `permission`, `grantee_type` (anyone / user / role / group), `grantee_id` | Index on `(scheme_id, permission)`; no negative grants |
| PostgreSQL | `projects`, `project_members` | project: `key`, `workflow_id`, `permission_scheme_id`; member: `(project_id, user_id)` → role | Schemes and workflows attached by reference |
| PostgreSQL | `issues` | `id`, `key` (DEMO-42, unique), `project_id`, `status_id`, `assignee_id`, `sprint_id`, `custom_fields` (JSONB), `version`, `rank` | `(project_id, status_id)`; unique `(project_id, rank)`; GIN on custom fields |
| PostgreSQL | `issue_history` | `issue_id`, `user_id`, `field`, `old_value`, `new_value`, `created_at` | Append-only, monthly partitions |
| PostgreSQL | `outbox` | `issue_id`, `event_type`, `version`, `published_at` | Partial index on unpublished rows |
| PostgreSQL | `idempotency_keys` | hash of (user, key), request fingerprint, stored response | 24 h expiry |
| Redis | `perms:{project}:{user}`, `perms-gen:{project}` | Permission set tagged with a generation | 60 s TTL as a backstop |
| Elasticsearch | `issues` index | Denormalized names, status, sprint, labels, custom fields, `version` | External versioning |

"Custom fields live in a JSONB column instead of an entity-attribute-value table. EAV turns 'load an issue' into an N-row aggregation and 'filter on two custom fields' into self-joins; JSONB keeps the data on the row and serializes straight into the search document. What I give up is type enforcement in the database, so a field registry validates values on the single write path."

---

## 🔌 API Design (3 min)

```
GET    /api/v1/issues/{key}                     issue + ETag "<version>"
POST   /api/v1/issues                           create; Idempotency-Key → 201 | 403 | 422
PATCH  /api/v1/issues/{id}                      edit; If-Match → 200 | 412 + current issue
GET    /api/v1/issues/{id}/transitions          transitions this user may run now
POST   /api/v1/issues/{id}/transitions/{tid}    → 200 | 403 condition | 409 moved | 422 validator
PUT    /api/v1/issues/{id}/rank                 {afterId} or {beforeId} → 200 {rank}
GET    /api/v1/issues/{id}/history?cursor=…     audit trail, keyset pagination
GET    /api/v1/search?jql=…&cursor=…            → 200 | 400 invalid_jql | 503 unavailable
GET    /api/v1/projects/{key}/permissions       what the caller may do (UI hints)
```

- **Status is not a field.** `PATCH` rejects it; transitions are the only way to change status, so the workflow can't be bypassed through the edit endpoint.
- **Refusals are structured.** `403` with the condition that blocked, `422` with the field a validator wants, `409` when the issue moved. Clients need to explain these, not just display "error".
- **Not visible means not found.** Without `view_issue`, issue and project routes answer `404`, so keys can't be probed.
- **Idempotency-Key** on creates and comments, because automation retries everything; a reused key with a different body is a `422`.
- **Search admits it is down** with `503` rather than returning an empty list, which would read as "no issues match".

---

## 🔧 Deep Dive 1: The Workflow Engine (8 min)

"A transition like 'Resolve' is a row with three rule lists. The engine has to run admin-written rules safely, in the right order, and atomically with respect to the state they examined."

**Order of checks.** The transition must start from the issue's current status (otherwise `409`), then conditions decide *may this user run it* (`403`), then validators decide *is the issue ready* (`422` naming the field). Conditions first means someone who may not resolve issues never learns which fields resolution requires. All checks happen before any write, so a side effect can never fire for a transition that didn't happen.

**Atomicity without locks.** I evaluate rules on a plain read, then commit with `UPDATE issues SET status_id = $to, version = version + 1 WHERE id = $id AND version = $read`, together with the history row, any field changes from post-functions and their history rows, and the outbox row. Zero rows means the issue changed after I evaluated the rules; I re-read and re-evaluate, up to three times, then answer `409`.

| Approach | Behaviour | Verdict |
|----------|-----------|---------|
| ❌ Code-defined workflows | A deploy for every "Blocked" column | Fails the product's premise: self-service configuration |
| ❌ Row lock, then evaluate | `SELECT … FOR UPDATE`, run rules, write | Locks held across rule evaluation; a bulk "close the sprint" serializes behind the slowest rule |
| ❌ Check, then write unconditionally | Read, evaluate, `UPDATE … WHERE id = $id` | Two concurrent transitions both pass and both write; the history shows two moves out of the same status |
| ✅ Evaluate unlocked, compare-and-swap on version | Re-evaluate on conflict | No lock across rules; a race costs one re-read |

**Why it works here.** Contention on a single issue is rare — two humans rarely act on the same issue in the same second — so the compare-and-swap almost always succeeds the first time, and the expensive part (rules, role lookups) never runs under a lock. When a race does happen, the losing request re-evaluates against the new state, which is exactly right: if the issue is no longer in "In Review", "Resolve" should not apply.

**Failing closed.** Rules are admin-authored data, so a typo is a real risk. Unknown condition or validator types block the transition instead of allowing it — a condition is authorization, and authorization must not fail open. I also validate definitions when they're saved: unknown rule types and statuses from another workflow are rejected then, so the typo is caught once instead of blocking every issue later.

**Side effects.** Post-functions that change the issue (assign to the actor, set or clear a field) run inside the transaction and record history. Anything that talks to the outside world — notifications, webhooks — is driven by the committed outbox event. A slow webhook endpoint must never hold a row lock, and an email outage must never roll back a status change people already saw.

**What I give up.** Under real contention — an automation hammering one issue — requests retry and some fail with `409`. That's the honest outcome: the alternative is silently applying a transition against rules that no longer hold.

---

## 🔧 Deep Dive 2: Permission Schemes on Every Request (7 min)

"Every read and write asks 'may this user do this in this project?', 50,000 times a second. It has to be correct, nearly free, and it must revoke immediately."

**The model.** A project points to a scheme; a scheme holds grants mapping a permission to a grantee: anyone, a user, a project role, or a group. A user holds a permission if any grant matches. There are no negative grants. Ten thousand projects share a dozen schemes, so tightening "Restricted" fixes hundreds of projects in one write.

**Evaluation.** Load the project's grants, load the caller's roles in the project, match. It's two indexed queries — cheap once, expensive at 50,000 per second. So I cache the evaluated set per (project, user) in Redis.

**The revocation problem.** A plain TTL cache serves revoked access until the entry expires. Deleting the entry on a membership change isn't enough either: a request that read the old membership a millisecond before the delete can write the stale set back afterwards. So each project has a generation counter. Cache entries record the generation they were computed under; any membership or scheme change bumps the counter; on read, an entry from an older generation is ignored. A racing refill writes an entry that is already obsolete. Revocations and grants both apply on the next request, and the 60-second TTL is only a backstop in case the bump itself fails.

| Approach | Problem | Verdict |
|----------|---------|---------|
| ❌ Per-project ACLs | 10,000 matrices to keep consistent | Unmanageable |
| ❌ Evaluate on every request | Two queries × 50K/s becomes the biggest load on PostgreSQL | Too expensive |
| ❌ TTL cache, delete on change | Revocation can lag the TTL; a racing refill resurrects access | Unsafe |
| ✅ Generation-tagged cache | One counter per project; obsolete entries ignored | Instant revocation at cache speed |

**`404`, not `403`, for invisible projects.** If a caller can't view a project, its issues answer `404`. Otherwise `403` versus `404` tells an attacker which keys exist in confidential projects.

**Search uses the same rule.** The Search API computes the caller's visible projects with the same evaluation function and adds them as a mandatory filter to every JQL query, suggestion and facet count. If search computed access its own way, the two would drift, and the failure mode is confidential issues showing up in someone's filter results.

**Where groups and admins fit.** Instance administration (editing a workflow that many projects share, swapping a project's scheme) is a separate global role, checked before any project scheme. Group grants need a directory service; until there is one, they never match — failing closed again.

**What I give up.** A Redis round trip on every request, and a generation counter that every membership change must remember to bump. If Redis is down, I compute from PostgreSQL: slower, never more permissive.

---

## 🔧 Deep Dive 3: Concurrent Edits and Board Order (6 min)

"Two different races: two people editing the same issue, and two people dragging cards on the same board."

### Edits: versions and `412`

```
 Alice    Bob                                Issue API                                 PostgreSQL
   │       │                                     │                                          │
   │ 1 GET /issues/DEMO-5                        │                                          │
   │────────────────────────────────────────────▶│                                          │
   │ 2 200, ETag "7"                             │                                          │
   │◀────────────────────────────────────────────│                                          │
   │       │ 3 GET /issues/DEMO-5                │                                          │
   │       │────────────────────────────────────▶│                                          │
   │       │ 4 200, ETag "7"                     │                                          │
   │       │◀────────────────────────────────────│                                          │
   │ 5 PATCH priority, If-Match "7"              │                                          │
   │────────────────────────────────────────────▶│                                          │
   │       │                                     │ 6 lock row; UPDATE version 8 + history   │
   │       │                                     │─────────────────────────────────────────▶│
   │ 7 200, ETag "8"                             │                                          │
   │◀────────────────────────────────────────────│                                          │
   │       │ 8 PATCH summary, If-Match "7"       │                                          │
   │       │────────────────────────────────────▶│                                          │
   │       │                                     │ 9 lock row: version is 8, write nothing  │
   │       │                                     │─────────────────────────────────────────▶│
   │       │ 10 412 + current issue (version 8)  │                                          │
   │       │◀────────────────────────────────────│                                          │
   │       │                                     │                                          │
```

Without a version, the last writer silently wins: Bob's summary change erases Alice's ten-minute description edit, and the history shows nothing wrong. Every issue has a `version`, exposed as an `ETag`; an edit sends the version it was based on in `If-Match`. If the row moved on, nothing is written and the response is `412` with the current issue, so the client can show both. Inside the request I lock the row for the few milliseconds of the write, so history records the value actually replaced — optimistic across minutes of think time, pessimistic for milliseconds.

| Approach | Verdict |
|----------|---------|
| ❌ Last write wins | Silent data loss with a clean-looking history |
| ❌ Editing locks | Held across think time; need leases, expiry and "unlock" buttons |
| ✅ Version + `If-Match` → `412` | One integer column; the person with context decides |

### Board order: rank keys

Integer positions make a drag an `UPDATE` of every card below the drop point — a write that grows with the board and conflicts with every concurrent drag. Instead each issue has a short base-36 rank key compared byte-wise, one order per project shared by all columns and the backlog. Moving a card computes a key strictly between its new neighbours — between `i00100i` and `i00200i` the key is `i002` — so exactly one row changes. The client sends "put it after issue 17", and the server reads 17's current key and the next key after it inside the transaction, so a stale board still yields a sensible order. Two drops into the same gap compute the same key; a unique index on `(project_id, rank)` rejects the second, which re-reads and retries. New issues get a key after the project's maximum from a database trigger, so every insert path lands at the bottom.

"What I give up: keys lengthen when many cards are inserted at one spot — about a character per five inserts — so a background job rebalances a project when keys pass ~32 characters, the same idea as Jira's LexoRank buckets. And rank changes don't bump `version`, so reordering the board never makes someone's summary edit fail with `412`."

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first:** permission checks if the cache hit ratio drops (alert under 95%); board reads (replicas, then caching board queries per sprint); `issue_history` growth (monthly partitions, archive old ones); then the write primary around a few thousand writes per second (shard by project — everything that matters is project-scoped, and cross-project queries already go to Elasticsearch).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Elasticsearch down | JQL says "search unavailable"; boards and issues work | Boards read PostgreSQL |
| RabbitMQ down | Nothing immediately; search and notifications lag | Outbox rows wait for the relay |
| Redis down | Slower requests; users may need to log in again | Permissions from PostgreSQL, never "allow" |
| PostgreSQL primary down | Writes fail with `503` | Failover; clients retry with the same idempotency key |
| Poison event | One consumer's queue stops growing | Retries with backoff, then a dead-letter queue |

**What I'd watch:** transition refusals by code (a spike of `422`s after a workflow edit means an admin broke a workflow), `412` and compare-and-swap conflict rates (automation fighting people), permission-cache hit ratio, index lag from commit to searchable (alert above 30 s), outbox backlog, and dead-letter depth per consumer.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Workflows | Data, interpreted at runtime | Code per workflow | Changes without deploys |
| Transition safety | Compare-and-swap on version | Row lock across rule evaluation | No locks held across admin-written rules |
| Unknown rules | Fail closed, validate on save | Fail open | A typo must block, not grant |
| Concurrent edits | `If-Match` → `412` | Last write wins | No silent loss |
| Permissions | Schemes + generation-tagged cache | Per-project ACLs or a TTL cache | Cheap checks, instant revocation |
| Search | Elasticsearch via outbox, versioned writes | PostgreSQL full-text | Arbitrary predicates and facets; lag is bounded and monotonic |
| Board order | Fractional rank keys | Integer positions | One-row moves; no renumbering |

"With more time I'd add bulk operations as background jobs that run the same per-issue transition pipeline, a sandbox with time limits for scripted validators, and a live-update gateway that pushes the same issue events to open boards."

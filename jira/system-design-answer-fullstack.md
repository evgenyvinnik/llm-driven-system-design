# Design Jira - System Design Answer (Fullstack Focus)

*45–60 minute system design interview — Fullstack Engineer position*

## 📋 Problem Statement

"I'm designing Jira: projects containing issues that move through admin-configured workflows, with a Kanban board, a backlog, and a query language for finding things.

As a fullstack engineer I'd argue the defining property of this system is **where authority sits**. The rules that decide whether an issue may move from 'In Review' to 'Done' are data, authored by an admin, evaluated on the server. The client can't know them. But the board is a bulk tool — people drag twenty cards during sprint planning — so the UI has to respond instantly to an action it isn't qualified to approve.

Everything interesting here lives on that seam: what crosses the wire, who owns which decision, and how a rejection travels back without the interface lying in the meantime."

## 🎯 Requirements Clarification

### Functional Requirements

1. **Projects and issues** — CRUD, with issues carrying type, status, priority, assignee, sprint, story points, labels
2. **Configurable workflows** — statuses and transitions defined per project as data, with authorization and validation rules
3. **Board and backlog** — drag to transition; move issues between sprints
4. **Search** — JQL with boolean logic, comparison operators, and functions like `currentUser()`
5. **Audit trail** — every field change recorded with actor and timestamp
6. **Comments** — threaded per issue

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Perceived interaction latency | < 100ms | Board is a bulk tool; serialized confirmation destroys it |
| Read p99 | < 200ms | Board load is the most common request in the system |
| Read:write ratio | ~100:1 | Everyone watches boards; few people change them |
| Durability of the audit trail | No loss | It's a compliance artifact for many teams |
| Search freshness | < 5s p99 | Users tolerate slight lag; they don't tolerate wrong |
| Availability | 99.9% | Internal tool; brief degradation beats inconsistency |

### Questions I'd Ask

> "The one that changes the architecture most is how configurable workflows are. If every project can define its own statuses and rules, nothing about the state machine can be hardcoded on either side of the wire — the client renders whatever it's handed, and the server interprets rules at runtime. That's a very different system from one with four fixed statuses, and it's the assumption I'll design against.

> Second: does search need to be strongly consistent with writes? I'll assume no, because assuming yes rules out a search engine entirely and I think that's the wrong trade for this product."

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  CLIENT                                                             │
│    Board · Backlog · Issue list · Detail panel                     │
│    ├─ one issue record per id, views derived from it               │
│    └─ API client: idempotency keys, error normalization            │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ REST + session cookie
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  API                                                                │
│    auth · projects · issues · search · workflows                   │
│    ├─ permission check on every read and write                     │
│    └─ idempotency middleware on mutations                          │
└──┬───────────────┬────────────────┬───────────────────┬────────────┘
   │               │                │                   │
   ▼               ▼                ▼                   ▼
┌────────┐   ┌──────────┐   ┌──────────────┐   ┌────────────────┐
│Postgres│   │  Redis   │   │Elasticsearch │   │   RabbitMQ     │
│ truth: │   │ sessions │   │ search index │   │ issue events   │
│ issues │   │ cache    │   │ (derived)    │   │      │         │
│ history│   │ idem.    │   │      ▲       │   │      ▼         │
│workflow│   └──────────┘   └──────┼───────┘   │ ┌────────────┐ │
└────────┘                         └───────────┼─│  indexer   │ │
                                               │ │ notifier   │ │
                                               │ │  webhooks  │ │
                                               │ └────────────┘ │
                                               └────────────────┘
```

**PostgreSQL is the only authority.** Elasticsearch is a derived view that can be rebuilt from it; Redis holds nothing that can't be recomputed. That single rule is what makes the async fan-out safe — a dropped event costs freshness, never truth.

## 🔀 The Client/Server Contract

Rather than enumerate types, the useful thing to state is **who owns each decision**, because that's what determines the API shape:

| Decision | Owner | How the other side learns it |
|----------|-------|------------------------------|
| Which statuses exist | Server (workflow data) | Fetched with the project; client renders columns from it |
| Whether a transition is permitted | Server (conditions) | Per-issue available-transitions list; enforced again on execute |
| Whether an issue is ready to transition | Server (validators) | 422 naming the failing field |
| What the user is looking at | Client | Route params |
| Optimistic intent | Client | Applied locally, then reconciled from the write response |
| Field-level audit | Server | History endpoint |

> "The important discipline is that the available-transitions list is a *hint for rendering*, never a substitute for enforcement. The server re-evaluates every rule on execute. If it didn't, the check would be advisory — anyone with a terminal could bypass it, and worse, the legitimate client would still be wrong whenever a rule changed between fetching the list and acting on it. So the same evaluation runs twice on purpose: once to decide what buttons to draw, once to decide what actually happens."

**Errors are part of the contract.** The API returns a discriminated shape — 403 for authorization, 422 with a field name for validation, 409 for conflict, 5xx for transient — because the client's response to each is genuinely different. A single generic error blob would force the UI to string-match messages to decide whether retrying could possibly help.

## 💾 Data Model

Described as prose tables rather than DDL:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| projects | id (UUID PK), key ('DEMO', unique), name, lead_id, workflow_id, permission_scheme_id | key | Workflow and scheme attached by reference — swap without touching issues |
| issues | id, project_id, key ('DEMO-5', unique), summary, description, issue_type, status_id, priority, assignee_id, reporter_id, parent_id, epic_id, sprint_id, story_points, labels, components, custom_fields (JSONB) | (project_id, status_id); GIN on labels and custom_fields | The board's primary read |
| statuses | id, workflow_id, name, category (todo / in_progress / done) | workflow_id | Category drives client colouring without hardcoding names |
| transitions | id, workflow_id, name, from_status_id (NULL = from anywhere), to_status_id, conditions / validators / post_functions (JSONB lists) | workflow_id | The entire state machine is rows, not code |
| issue_history | id, issue_id, user_id, field, old_value, new_value, created_at | (issue_id, created_at) | Append-only; one row per changed field |
| comments | id, issue_id, user_id, body, created_at | (issue_id, created_at) | |
| sprints | id, project_id, name, status (future / active / completed), start/end dates | project_id | Board filters on the active sprint |
| permission_grants | scheme_id, permission, grantee_type (role / user / group / anyone), grantee_id | PK across all four | Deny-by-default: no matching grant = no access |
| idempotency_keys | key (PK), user_id, response_status, response_body (JSONB), expires_at | — | Replays return the stored response verbatim |

Three decisions worth defending:

**Custom fields as JSONB rather than an EAV table.** EAV — one row per (issue, field, value) — turns "load an issue" into an N-row aggregation and "filter on two custom fields" into self-joins the planner handles badly at scale. JSONB keeps the data in the row it describes and serializes cleanly into the search document. The cost is no database-level type enforcement, so the application must validate against a field registry on write; I accept that because the validation lives in one code path while EAV's cost is smeared across every read.

**Workflow rules as interpreted JSONB config.** Conditions, validators, and post-functions are stored as typed objects and evaluated at runtime. Code-defined workflows would mean a deploy every time a team tweaks its process — disqualifying for a product whose premise is self-serve customization. The trade-off is that a workflow can be saved in a broken state, so definitions are statically checked at publish time (every target status exists, no status is a dead end) rather than failing mid-transition.

**Timestamps carry a time zone.** Naive timestamp columns store wall-clock and silently acquire the *reader's* offset on the way back out, so a comment posted seconds ago can render as hours in the future. For a system whose audit trail is the compliance artifact, storing absolute instants isn't a preference — a history whose ordering depends on who's reading it isn't an audit trail.

## 🔌 API Design

```
POST   /api/auth/login                        → Session cookie
GET    /api/projects                          → Projects visible to this user
GET    /api/projects/:key                     → Project + workflow (drives board columns)
GET    /api/issues/project/:id                → Board / issue list data
GET    /api/issues/project/:id/backlog        → Unscheduled issues
GET    /api/issues/:idOrKey                   → Single issue (strong, from Postgres)
POST   /api/issues                            → Create (idempotency key honored)
PATCH  /api/issues/:id                        → Update fields
GET    /api/issues/:id/transitions            → Transitions available to THIS user now
POST   /api/issues/:id/transitions/:tid       → Execute transition
GET    /api/issues/:id/history                → Audit trail
GET    /api/issues/:id/comments               → Comments
POST   /api/search?jql=...                    → JQL search (eventual, from Elasticsearch)
```

The consistency split is deliberate and documented in the API itself: reads by id or key hit Postgres and are strongly consistent, while JQL search hits Elasticsearch and is eventually consistent. Clients that just wrote something read it back from the write response or by key — never from search.

## 🔧 Deep Dive 1: A Transition, End to End

This is the system's signature path. Walk it once and most of the architecture falls out.

```
 user drags DEMO-5 to "Done"
        │
   ┌────▼─────────────────────────────┐
   │ CLIENT: apply move locally       │  ← instant; may be wrong
   │ POST /issues/5/transitions/12    │
   │   X-Idempotency-Key: <uuid>      │
   └────┬─────────────────────────────┘
        ▼
   ┌──────────────────────────────────────────────────┐
   │ SERVER                                            │
   │  1 idempotency: replay cached response if seen    │
   │  2 permission check on the project                │
   │  3 load issue + its project's workflow            │
   │  4 source check: transition.from == current       │
   │  5 CONDITIONS  (may this user?)      fail → 403   │
   │  6 VALIDATORS  (is it ready?)        fail → 422   │
   │  ┌──────────── one transaction ─────────────────┐ │
   │  │ 7 UPDATE issue status                        │ │
   │  │ 8 INSERT one issue_history row per field     │ │
   │  └──────────────────────────────────────────────┘ │
   │  9 POST-FUNCTIONS (side effects, after commit)    │
   │ 10 publish issue.transitioned → RabbitMQ          │
   └────┬──────────────────────────────────────────────┘
        ▼
   ┌──────────────────────────────────────────────────┐
   │ CLIENT: merge returned issue (not a refetch)     │
   │ or revert + explain, by error class               │
   └──────────────────────────────────────────────────┘
        │
        ├──▶ indexer   → Elasticsearch upsert
        ├──▶ notifier  → watchers
        └──▶ webhooks  → external integrations
```

### Why conditions before validators before commit

The ordering is a correctness property, not style:

> "Conditions answer 'may this user attempt this?' and validators answer 'is the issue fit to move?'. Running conditions first means a user who isn't allowed to resolve issues never sees 'fix version is required' — otherwise the error messages leak the workflow configuration to people who can't act on it. And both run before the transaction so side effects can't fire for a transition that never committed. Reorder these and you get either an information leak or notifications about status changes that didn't happen."

### Why post-functions run after commit

> "Post-functions include sending notifications and firing webhooks — I/O against systems I don't control. Inside the transaction they'd hold row locks for the duration of an HTTP call to someone else's server, and a slow webhook endpoint would become database contention. So the transaction covers only the status update and its history rows, and side effects run after. The trade-off is real and I'd state it plainly: a crash between commit and post-functions leaves a transitioned issue with a missing notification. I'd take that over the alternative, which is rolling back a user-visible status change because an email server was down."

### The client's half

The client applies the move immediately and reconciles from the response rather than refetching the board — a refetch would clobber a second drag already in flight. Rejections branch by class: 403 reverts and explains who may act, 422 reverts and surfaces the named field, transient errors retry once under the same idempotency key before reverting.

> "The reason optimistic UI needs this much care here — more than in a typical CRUD app — is that rejection isn't an anomaly, it's a *rule working correctly*. A user without permission to close issues will be rejected every single time they try. That's reproducible, not flaky, so 'apply optimistically and hope' doesn't degrade gracefully; it produces a UI that consistently lies to a specific user until they reload."

## 🔧 Deep Dive 2: Concurrent Edits

Two people act on the same issue. What happens depends on a choice I'd make explicitly.

| Approach | Behaviour | Cost |
|----------|-----------|------|
| ❌ Pessimistic row locks | Serializes; correct | Locks held across rule evaluation and role lookups — tens of ms per write; bulk sprint moves deadlock-prone |
| ❌ Last-write-wins, silent | Never fails | Loses a long description edit with no trace |
| ✅ Version column + compare-and-swap | Fails loudly, only on real collision | Client must handle 409 |

> "I'd put a version column on the issue and make the status update a conditional write — update where id and version match, and if it affects zero rows, someone else won and I return 409. Pessimistic locking is the option that looks safer and isn't: because the workflow engine evaluates admin-authored rules, which means role lookups and condition checks, a lock taken before evaluation is held across all of it. Multiply that by 'move all 800 issues in this sprint to Done' and you've serialized a bulk operation behind per-issue rule evaluation. Optimistic concurrency lets every one of those reads and evaluations proceed in parallel and only collides at the commit, which is a single conditional update.
>
> What I give up is that the loser gets an error instead of a merge. For a status transition I think that's actually correct rather than merely acceptable — silently merging two concurrent transitions would run two contradictory sets of post-functions, so you'd send 'moved to Done' and 'moved to Blocked' notifications for the same issue. A 409 that says 'this moved while you were looking at it, here's where it is now' is the honest outcome."

**Where I'd differentiate by field.** Discrete fields like assignee or priority tolerate last-write-wins fine — small, and the history shows what happened. Long-form description edits don't; losing those is losing real work. So a conflict on description should offer the user both versions rather than a bare error, and the client already holds the original and the edit, so it can.

## 🔧 Deep Dive 3: Keeping Boards In Sync

During sprint planning, several people are on the same board simultaneously — the one moment this system is genuinely multi-user.

| Approach | Fit | Cost |
|----------|-----|------|
| ❌ Poll the board on a timer | Re-requests a large payload forever | Load scales with idle tabs, not activity |
| ❌ CRDTs / collaborative editing | Wrong model — issues are field records, not shared documents | Large complexity, no benefit |
| ✅ Refresh on focus | Covers "come back to the tab" | Divergence during concurrent planning |
| ✅ Server-pushed issue events | Matches the existing event stream | Connection lifecycle and backfill |

> "Jira isn't Google Docs and treating it like one would be a mis-read. Two people rarely edit the same *field* of the same issue — they work on different issues on the same board. So I don't need character-level merge; I need each client to learn that some issue changed and re-render one card. The backend already publishes issue events for indexing and notifications, so the fan-out exists and pushing to clients is mostly a delivery problem.
>
> The genuinely hard part isn't the socket, it's reconnection. A laptop that sleeps for ten minutes wakes up having missed events, and a naive subscription will show a stale board while *looking* live — which is worse than obviously stale, because the user has no cue to refresh. So the connection has to carry a resume point and fall back to a full board refetch when it can't backfill. That's why I'd ship refresh-on-focus first: it's the honest 80% and it never claims to be live when it isn't."

Delivery across multiple API instances goes through Redis pub/sub, since a user's socket may be on a different instance than the one that served the write. And the hub skips the actor — they already applied the change optimistically, so echoing it back only risks re-render churn and races with their own reconciliation.

## 🔧 Deep Dive 4: JQL and the Dual-Store Problem

JQL is a real grammar: field-operator-value clauses, AND/OR with parentheses, and functions like `currentUser()`.

**Server pipeline**: tokenize → parse to an AST by recursive descent → resolve functions against the request context → translate to an Elasticsearch bool query (AND→must, OR→should with minimum-match, IN→terms, comparisons→range) → **inject the user's accessible-project set as a mandatory filter** → execute with pagination caps.

Functions resolve at query time, never at save time — that's what lets a saved filter using `currentUser()` stay correct for whoever runs it.

**Why Elasticsearch rather than translating JQL to SQL:**

> "Postgres would keep search strongly consistent with writes, which is genuinely attractive and is the reason to consider it. It breaks on three things this product actually does. Text relevance — 'login crash' wants stemmed, ranked, typo-tolerant matching. Arbitrary predicate combinations — users compose filters across custom fields freely, and Postgres needs an index per query shape while ES indexes every field by construction. And aggregations for boards and sprint reports, which are group-bys over large result sets. The price is the dual-store problem: search lags writes and can disagree with the database."

**Managing the gap**, which is where the design earns its keep:

- Events carry **ids, not payloads** — the indexer re-reads from Postgres, so the database is always the authority on content and a stale event can't write stale data
- Indexing is idempotent per issue and versioned, so retries and out-of-order redeliveries can't regress a document
- A reconciliation sweep compares `updated_at` against indexed versions to catch lost events
- **The UX seam**: after a create or edit, the client renders from the write response rather than re-querying search — which hides the lag exactly where users would otherwise notice it hardest ("I just made this issue and it's not in my filter")

That last point is the fullstack move: the consistency gap is a backend property, but it's closed on the client, and neither side could have solved it alone.

## 🛡️ Permissions Across the Stack

Projects point to a permission *scheme*; a scheme holds grants mapping a permission to a grantee (role, group, user, or anyone). Checking access resolves the scheme, fetches grants, resolves the user's roles, and grants if any match. There are no negative grants — absence is denial.

Computed permission sets are cached per (user, project) in Redis behind a short TTL, with eager invalidation on membership and scheme changes.

> "The asymmetry is deliberate: being slow to *grant* is a support ticket, being slow to *revoke* is a security incident. So grants may take until the TTL expires to propagate, but revocations invalidate eagerly. And search authorization reuses the identical accessible-project set that the REST layer uses — if search computed its own, the two would eventually disagree, and the failure mode is confidential issues surfacing in someone's filter. One source of truth for authorization, two consumers."

## 🔁 Idempotency and Retries

This is the seam where "the client retries" and "the server is safe" have to be designed together, not separately.

The problem: a transition request times out. The client doesn't know whether the server never received it, processed it and lost the response, or is still working. Retrying risks applying it twice; not retrying risks losing a change the user believes they made.

**The mechanism**: every mutation carries a client-generated `X-Idempotency-Key`. Middleware checks it before the handler runs — a key already seen returns the stored response verbatim instead of re-executing. Keys and their responses live in Redis for fast replay, with a Postgres table as the durable backstop so a cache flush can't turn a replay into a re-execution.

```
  client                          server
    │  POST /transitions  key=K     │
    │──────────────────────────────▶│  no K seen → execute, store (K → response)
    │        ✗ response lost        │
    │  POST /transitions  key=K     │
    │──────────────────────────────▶│  K seen → replay stored response, no re-execute
    │◀──────────────────────────────│
```

> "The key has to be generated at the point of *user intent* — when the drag is released — and reused for every retry of that same action. Generating it per HTTP attempt would make each retry look like a new request, which defeats the entire mechanism while appearing to implement it. That's why I treat the retry policy and key generation as one decision: an automatic retry without a stable key isn't a safety feature, it's a duplicate-transition generator.
>
> The cost is an extra write on every mutation. I'd pay it, because the alternative in a system with an append-only audit trail is duplicate history rows — and unlike a duplicated read, you can't clean those up without corrupting the very record people rely on to reconstruct what happened."

Note the interaction with concurrency control: idempotency handles *the same request arriving twice*, while the version check handles *two different requests colliding*. They solve different problems and you need both — a retried request should replay, but a genuinely concurrent second edit should get a 409.

## 🧯 Failure Handling

| Failure | Behaviour | Why acceptable |
|---------|-----------|----------------|
| Elasticsearch down | Search fails; issue CRUD and boards unaffected | Boards read Postgres directly — the core product still works |
| RabbitMQ down | Writes succeed; publish failure logged | Postgres is authoritative; index catches up via reconciliation |
| Redis down | Sessions lost; permission checks fall back to Postgres | Degraded latency, not incorrect results |
| Postgres down | Writes rejected | Nothing else can substitute for the source of truth |
| Worker crash mid-event | Message redelivered | Consumers are idempotent on event id |

The ordering here is the point: **every dependency except Postgres degrades to reduced functionality rather than wrong answers.**

## 📊 Observability

Beyond standard RED metrics, the signals specific to this system:

- **Transition counter by (workflow, transition, outcome)** — a spike in 422s after a workflow edit means an admin published a rule that blocks real work, and it's otherwise invisible
- **Index lag** — time from commit to searchable, as the SLO backing the freshness target
- **Queue depth per consumer** — separates "indexer is slow" from "RabbitMQ is down"
- **Permission cache hit rate** — a drop signals an invalidation storm, which precedes a Postgres load spike

## 📈 Scalability: What Breaks First

1. **Board queries under read amplification** — at 100:1 reads, board loads dominate. Fix: cache computed board state per (project, sprint), invalidated on issue writes for that project.
2. **The `issues` table** — grows without bound and is hot. Fix: read replicas first, then partition by project; project is in essentially every query, so it's a natural boundary.
3. **`issue_history`** — grows fastest of anything (a row per field per change) and is read rarely. Fix: time-partition and archive cold partitions.
4. **Single indexer consumer** — becomes the bottleneck during bulk operations. Fix: partition the queue by project id so ordering per issue is preserved while throughput scales.
5. **Bulk transitions** — "move 800 issues to Done" can't be a synchronous request. Fix: enqueue as a job, return a job id, report progress.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Workflow definition | Data in Postgres | Code | Admins reconfigure without a deploy |
| Concurrency | Version + 409 | Pessimistic locks | Locks would be held across rule evaluation |
| Post-functions | After commit | Inside transaction | Never hold row locks across third-party I/O |
| Search store | Elasticsearch | Postgres FTS | Relevance, arbitrary predicates, aggregations |
| Event payloads | Ids only | Full issue | DB stays authoritative; stale events can't write stale data |
| Index freshness | Eventual + client-side seam | Synchronous index | Keeps writes fast; hides lag where it's felt |
| Real-time | Focus refresh → pushed events | Polling | Polling scales with idle tabs, not activity |
| Permission cache | Eager revoke, lazy grant | Uniform TTL | Slow revoke is a security incident |
| Custom fields | JSONB column | EAV tables | No join per issue; serializes cleanly to the index |
| Client rejection UX | Branch by error class | Generic toast | 403 and 422 demand different user actions |

## 🚀 Closing

"The spine of this design is that PostgreSQL owns truth and everything else is derived, cached, or advisory. That's what makes the async fan-out safe to be best-effort, what lets Elasticsearch be rebuilt at will, and what lets the client be aggressively optimistic without risking divergence — it always reconciles against something authoritative.

The piece I'd build next is pushed issue events, and the reason is fullstack rather than backend or frontend: the server already publishes exactly the right events for indexing, and the client already merges server-shaped issue records on every optimistic reconcile. The gap between those two facts is a delivery layer, not a redesign — which is mostly a consequence of having drawn the client/server contract around issue records rather than around screens."

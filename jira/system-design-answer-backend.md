# Design Jira - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for Jira: an issue tracking and project management system. What makes this problem interesting from a backend perspective is that almost nothing is fixed — every team customizes its workflows, fields, and permissions. So the real design challenge is building *engines* rather than features: a workflow engine driven by data instead of code, a field system with per-team schemas, a permission system evaluated on every request, and a query language (JQL) that users compose freely. I'll focus on the workflow engine internals, the permission checking pipeline, and how the search path stays consistent with the write path.

## 🎯 Requirements Clarification

Questions I would ask up front:

- **How customizable are workflows?** Fully — admins define statuses, transitions, and rules without deploys. This rules out hard-coded state machines and drives the whole design.
- **Search freshness?** A just-created issue should be findable within a few seconds; I'll take eventual consistency for search but strong consistency for issue reads by key.
- **Integration surface?** Webhooks and API automation are heavy in real Jira usage, which makes idempotent writes non-negotiable — automation retries constantly.
- **Multi-tenancy model?** I'll assume a shared instance hosting many organizations' projects, since that's the harder version of the problem — a single-tenant deployment is a strict simplification of everything below.

I'd also flag up front that I'm treating the workflow engine, permission system, and search pipeline as the three areas deserving deep dives, since they're where "just build CRUD" stops being sufficient and the configurability requirement forces real architecture.

One more clarifying question worth asking early: **is JQL user-facing syntax, or just an internal representation the UI builds through a visual filter builder?** I'll assume both — power users type raw JQL, casual users build the same query through dropdowns that serialize to JQL — because that dual-interface requirement is exactly why JQL needs a real grammar and AST rather than being special-cased per UI control.

And a scope question I'll answer explicitly rather than leave implicit: **custom field scale**. I'll assume dozens of custom fields per project rather than hundreds — enough to stress the JSONB approach's query patterns without needing a fundamentally different storage model, but not so many that the GIN index itself becomes the bottleneck.

### Functional Requirements

- **Issue CRUD**: create, update, comment, attach, link, with validation against per-project configuration
- **Workflow engine**: user-defined state machines; transitions gated by conditions (who may), validators (what must be true), and post-functions (side effects)
- **Custom fields**: admin-defined typed fields per project, queryable
- **JQL**: a query DSL (`project = X AND status = "In Progress" AND assignee = currentUser()`) over all issues
- **Permissions**: scheme-based grants resolved through roles, groups, and users
- **Audit trail**: every change recorded with actor, timestamp, and old/new values

### Non-Functional Requirements

- **Availability**: 99.9% with graceful degradation — search can lag; issue writes cannot fail silently
- **Latency**: < 200ms for issue operations, < 1s for complex JQL
- **Scale**: 1M projects, 100M issues, tens of thousands of concurrent users
- **Consistency**: strong for issue state, eventual (seconds) for search
- **Idempotency**: safe retries for API automation and webhook-driven writes

### Scale Estimates

- 100M issues, growing ~100K/day; issue writes ~1K/sec peak (updates dominate creates ~10:1)
- Reads dominate: board loads and JQL queries run at 50–100x the write rate
- History is the largest table by rows — a busy issue accumulates hundreds of change entries
- Configuration data (workflows, schemes, fields) is tiny but read on *every* write — the perfect cache candidate

Working through the numbers a bit further: 1M projects averaging 100 issues each gives the 100M baseline, but the distribution is heavily skewed — a handful of enterprise instances run projects with tens of thousands of issues, while most small teams have a few dozen. That skew is why per-project sharding (not per-issue hashing) is the right long-term partitioning key: it keeps a project's issues, history, and configuration co-located, and only a few "hot" projects need special handling rather than the whole dataset. At 10 average transitions and 5 comments per issue over its lifetime, issue_history and comments together run 10–15x the row count of the issues table itself — the classic case of a small parent table driving a much larger child table, which is exactly why history gets partitioned separately in the scalability discussion below.

**Local development scale**: for running this locally, a handful of projects with a few hundred issues each is enough to exercise every code path — the workflow engine, permission resolution, and JQL parser all behave identically at 500 issues as at 100M; only the storage and caching *strategy* changes with scale, not the logic.

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway                                 │
│              (Auth, Rate Limiting, Idempotency)                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Issue Service │    │Workflow Engine│    │Search Service │
│               │    │               │    │               │
│ - CRUD        │    │ - Transitions │    │ - JQL Parser  │
│ - Comments    │    │ - Validators  │    │ - ES Queries  │
│ - Attachments │    │ - Post-funcs  │    │ - Aggregation │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Data Layer                               │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │       Redis       │     Elasticsearch          │
│   - Issues      │   - Sessions      │     - Issue search         │
│   - Workflows   │   - Cache         │     - JQL execution        │
│   - History     │   - Idempotency   │     - Aggregations         │
└─────────────────┴───────────────────┴───────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                       RabbitMQ                                   │
│     issue.events (fanout) → Search │ Notifications │ Webhooks    │
└─────────────────────────────────────────────────────────────────┘
```

The load-bearing decision: **PostgreSQL is the source of truth for issue state; Elasticsearch is a derived read model** fed asynchronously through the event bus. Every write path commits to Postgres first, publishes an event, and lets consumers (search indexer, notifications, webhooks) catch up. Nothing user-authoritative ever lives only in Elasticsearch.

## 💾 Data Model

Described as prose tables rather than DDL:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| projects | id (UUID PK), key ('PROJ', unique), name, permission_scheme_id, workflow_id | key | Schemes/workflows attached by reference — swap without touching issues |
| issues | id, project_id, key ('PROJ-123', unique), summary, description, issue_type_id, status_id, priority_id, assignee_id, reporter_id, parent_id (subtasks), sprint_id, story_points, custom_fields (JSONB), version | (project_id, status_id); GIN on custom_fields; unique key | version column drives optimistic locking |
| issue_types / statuses / priorities | id, name; statuses also carry category (todo / in_progress / done) | — | Small reference tables, cached aggressively |
| workflows | id, name, is_default | — | A workflow is a named set of transitions |
| transitions | id, workflow_id, name, from_status_id (NULL = any), to_status_id, conditions (JSONB list), validators (JSONB list), post_functions (JSONB list) | workflow_id | The entire state machine is rows, not code |
| issue_history | id, issue_id, user_id, field, old_value, new_value, created_at | (issue_id, created_at) | Append-only audit trail; one row per changed field |
| permission_schemes | id, name, is_default | — | A scheme is a reusable permission template |
| permission_grants | scheme_id, permission ('edit_issue'…), grantee_type (role / user / group / anyone), grantee_id | PK across all four | Deny-by-default: no matching grant = no access |
| project_members | project_id, user_id, role | PK (project_id, user_id) | Roles are per-project, not global |
| idempotency_keys | key (PK), user_id, request_path, response_status, response_body (JSONB), expires_at (24h) | — | Replays return the stored response verbatim |

Two schema decisions worth defending:

**Custom fields as JSONB, not an EAV table.** The classic alternative — an entity-attribute-value table with one row per (issue, field, value) — turns "load an issue" into an N-row aggregation and "filter by two custom fields" into self-joins that the planner handles badly at 100M issues. JSONB keeps each issue's custom data in the row it belongs to, one read, and a GIN index makes containment queries efficient. What we give up: in-database type enforcement — the application must validate values against the field registry on write, and a bug there means silently corrupt field data. I accept that because the validation lives in exactly one code path (issue write), while EAV's cost is smeared across every read.

**Workflow rules as JSONB configuration interpreted at runtime.** Conditions, validators, and post-functions are stored as typed config objects (e.g. type `user_in_role` with a role parameter) and interpreted by the engine. The alternative — code-defined workflows — would mean a deploy every time any team tweaks a process, which is disqualifying for a product whose selling point is self-serve customization.

**Custom field type validation** deserves a word since it's the sharp edge of the JSONB choice. Each custom field is defined in a field registry (id, name, type: text/number/date/select/user/multi-select) scoped per project. On write, the issue service loads the field definitions for the target project once (cached, since they change rarely) and validates every custom_fields entry against its declared type before the row is written — a select field must match one of its configured options, a user field must reference a real account. This validation is the *only* place type safety exists for custom data, which is precisely the cost called out above: it must be exhaustive and it must run on every write path, including bulk operations, which is why the bulk pipeline deliberately reuses the single-issue write path rather than a bulk-optimized bypass.

## 🔌 API Design

```
POST   /api/v1/projects/:key/issues          → Create issue (idempotency key honored)
GET    /api/v1/issues/:key                   → Read issue (strong, from Postgres)
PUT    /api/v1/issues/:key                   → Update fields (requires expected version)
POST   /api/v1/issues/:key/transitions/:id   → Execute workflow transition
GET    /api/v1/issues/:key/transitions       → Transitions available to THIS user now
GET    /api/v1/issues/:key/history           → Audit trail, paginated
POST   /api/v1/search?jql=...                → JQL search (eventual, from Elasticsearch)
GET    /api/v1/projects/:key/workflows       → Workflow definition for rendering
POST   /api/v1/admin/workflows               → Admin: create/edit workflows
POST   /api/v1/admin/schemes                 → Admin: permission scheme management
```

Note the split baked into the API: reads by issue key hit Postgres and are strongly consistent; JQL search hits Elasticsearch and is documented as eventually consistent. The "available transitions" endpoint exists so clients never guess — the server evaluates conditions per-user and returns only executable transitions, keeping authorization logic in exactly one place.

## 🔧 Deep Dive 1: The Workflow Engine

The heart of Jira. A transition like "Start Progress" is a row with three rule lists, executed in a strict pipeline:

1. **Load** the issue and its project's workflow; find the requested transition
2. **Source check**: the transition's from_status must match the issue's current status (or be NULL = global transition like "Close from anywhere")
3. **Conditions** — authorization: evaluate each condition (user_in_role, issue_assignee, user_in_group, always). Any failure → 403. Conditions answer *"may this user attempt this?"* and are also what the "available transitions" endpoint evaluates
4. **Validators** — data correctness: evaluate against the issue *merged with the fields submitted alongside the transition* (field_required, field_value, custom expressions). Any failure → 422 with the specific field named. Validators answer *"is the issue fit to move?"* — e.g., "cannot resolve without a fix version"
5. **Atomic commit**: in one database transaction — update the status with an optimistic-lock check on the version column, write one issue_history row per changed field. If the version check matches zero rows, another actor won the race: return 409, no partial state
6. **Post-functions** — side effects, after commit: assign-to-current-user, clear/update a field, fire a notification. Field-mutating post-functions run synchronously (users expect to see them immediately); notification-type ones publish to RabbitMQ
7. **Publish** an `issue.transitioned` event with a unique event_id for downstream consumers

**Why optimistic locking instead of row locks?**

> "Two users act on PROJ-123 simultaneously — one transitions it, one edits the summary. With pessimistic row locking, every issue write holds a lock across condition checks and validator evaluation, which can involve rule lookups and role queries — tens of milliseconds of lock-hold. Boards make this worse: bulk operations like moving a whole sprint would serialize behind each other and deadlock risk grows with rule complexity. Optimistic locking lets everyone read and evaluate freely and only collides at commit, where the version check is a single-row conditional update. Conflicts are genuinely rare — two humans editing the same issue in the same second — so the retry cost is negligible, while the lock-hold cost would be paid on *every* write. What we give up: the loser sees a conflict and must refresh. That's the right UX anyway — silently merging concurrent workflow transitions could execute two contradictory sets of post-functions."

**Why the three-phase rule split matters**: conditions before validators before commit means a user who *can't* perform a transition never sees validation errors for it (no information leak about required fields), and side effects can never fire for a transition that didn't commit. The ordering is a correctness property, not a style choice.

**Failure semantics for post-functions**: they run after commit, so a crashed post-function leaves a transitioned issue with a missing side effect — not a half-transitioned issue. Queued post-functions carry the event_id and are retried by the consumer with dedup on event_id. This is deliberate: I'd rather occasionally re-send a notification than ever roll back a user-visible status change because an email failed.

**A worked example** grounds the pipeline: an engineer clicks "Resolve" on PROJ-456, which has a fix_version-required validator and a post-function that clears the assignee's "in review" flag.

1. Load PROJ-456, current status "In Review"; find the "Resolve" transition targeting "Done"
2. Source check: transition's from_status is "In Review" — matches
3. Conditions: transition requires `issue_assignee` — the clicking user is the assignee, passes
4. Validators: `field_required` on fix_version — the submitted fields include a fix_version, passes
5. Commit: status → Done, version 7 → 8, one history row for the status field
6. Post-function: clear the review flag (synchronous, visible immediately)
7. Publish `issue.transitioned` — the search indexer, notification service, and any registered webhook each pick it up independently

If step 4 had failed (no fix_version submitted), the response is a 422 naming the missing field, nothing commits, and no event publishes — the client can prompt for the field and resubmit the exact same transition request.

**Guarding the engine against its own configurability**: because workflows are admin-authored data, the system has to validate *workflow definitions themselves*, not just issues moving through them. Publishing a new workflow version runs a static check — every to_status_id must exist, every from_status_id (when non-null) must be reachable, and every status the workflow's issue types can start in must have at least one outbound transition, or issues get created into a dead end with no way to progress. This validation runs once at publish time, not on every transition, so it costs nothing on the hot path while still preventing an admin's typo from locking issues in place.

## 🔧 Deep Dive 2: The Permission Pipeline

Every single read and write resolves permissions, so this path must be both correct and nearly free.

**The model** is indirection by design: projects point to a permission *scheme*; a scheme holds *grants*; a grant maps a permission (edit_issue, transition_issue…) to a grantee (a role, a group, a specific user, or anyone). Checking whether a user has a permission on a project follows a fixed sequence:

1. Resolve the project's scheme id
2. Fetch grants for (scheme, permission)
3. Resolve the user's project roles and global groups
4. Access granted if any grant matches: anyone-grant, direct user grant, role grant intersecting the user's roles, or group grant intersecting the user's groups
5. No match → deny. There are no negative grants — absence is denial

**Why schemes rather than per-project ACLs?** An organization with 10,000 projects doesn't manage 10,000 permission matrices — it manages perhaps a dozen schemes ("open source", "default", "restricted") shared across projects. Changing "restricted" updates hundreds of projects in one write. The indirection costs one extra lookup, which caching erases.

**Caching and invalidation** — the real engineering here:

- Computed permission sets are cached per (user, project) in Redis with a 10-minute TTL: one cache entry answers every permission question for that user in that project
- Writes that change authorization (scheme edits, role membership changes, group changes) publish invalidation events that delete affected keys eagerly; the TTL is the backstop for missed invalidations
- The asymmetry is deliberate: **granting** access may take up to 10 minutes to propagate through a missed invalidation (annoying, safe), while **revocation** paths are invalidated eagerly and, for the sensitive cases (user removed from project, user deactivated), also checked against the session layer — being slow to grant is a support ticket; being slow to revoke is a security incident

> "The trade-off I'm consciously making is a small window of stale *positive* permissions in exchange for taking permission checks off the database entirely. At 100x read amplification, resolving roles and grants from Postgres on every board load would be the single largest query source in the system. The cache turns it into a Redis hit. The failure mode I refuse to accept is the reverse — caching denials for a user who was just granted access is fine; serving cached access to a user who was just removed from a confidential project is not, so revocations bypass the TTL."

**Search must respect permissions too**: JQL results are filtered by injecting the user's accessible-project set into every Elasticsearch query as a mandatory filter clause. The accessible-project list comes from the same cached permission layer, so search authorization and API authorization can't drift apart.

**A concrete numbers check**: a large enterprise instance might have 50,000 users and 10,000 projects, but any individual user is a member of perhaps 5–20 projects. Caching per (user, project) rather than a single blob per user keeps cache entries small and invalidation targeted — removing a user from one project invalidates one key, not the user's entire permission surface. The alternative, one cache entry per user holding all their accessible projects and permissions, is simpler to read but means every membership change anywhere invalidates the whole entry, causing far more cache churn for power users who touch many projects.

**Global permissions layer beneath the scheme system**: some actions (create project, manage users, view system admin panel) aren't project-scoped at all. These resolve through a small, separate global-role check that runs before the project-scheme pipeline even engages — keeping the two authorization surfaces (instance-level and project-level) independent means a bug in one can't silently widen the other.

## 🔧 Deep Dive 3: JQL — Parsing and the Dual-Store Problem

JQL is a real grammar: clauses of the form field-operator-value, boolean combinators with parentheses, and functions like `currentUser()` and `startOfDay()`.

**Execution pipeline**:

1. **Tokenize** the query string into fields, operators, values, parens, and function calls
2. **Parse** into an AST by recursive descent — clauses at the leaves, AND/OR nodes above, parentheses driving recursion
3. **Resolve functions at query time** against the request context: `currentUser()` becomes the caller's id, `now()` a timestamp — resolution happens at translation, never stored, so saved filters stay correct for whoever runs them
4. **Translate** the AST to an Elasticsearch bool query: AND maps to a must clause, OR to should with a minimum-match constraint, equality to term, contains to a full-text match, IN to terms, comparisons to range, "IS EMPTY" to a must-not-exist check; JQL field names map to index fields through an explicit field registry that also covers custom fields
5. **Inject the permission filter** (accessible projects) as a top-level must clause
6. Execute with pagination caps and a query timeout

The grammar itself is small and worth stating precisely, since it's what the tokenizer and parser implement: a query is one or more clauses joined by AND/OR, with parentheses for grouping; a clause is a field, a comparison operator (equals, not-equals, contains, greater/less-than variants, IN, NOT IN, IS [NOT]), and a value; a value is a quoted string, a number, the literals EMPTY/NULL, or a zero-argument function call. Keeping the grammar this small — no nested functions, no arithmetic, no subqueries — is itself a design choice: it's expressive enough for the filtering users actually do, and small enough that the recursive-descent parser stays a few dozen lines with no ambiguity to resolve.

**Why Elasticsearch instead of translating JQL to SQL?**

> "Postgres full-text search plus indexes could handle simple JQL, and it would keep search strongly consistent — that's the genuine attraction. It breaks on three real usage patterns. First, text relevance: a query for issues containing 'login crash' wants ranked, stemmed, typo-tolerant matching, which is Elasticsearch's core competence and an afterthought in Postgres. Second, arbitrary predicate combinations: users compose filters across custom fields freely; Postgres needs the right index to exist for each shape, while ES indexes every field by construction. Third, aggregations — boards, sprint reports, and dashboards are group-bys over big result sets that ES executes in-memory across shards. The price is the dual-store problem: search lags writes by the indexing pipeline's latency, and can disagree with Postgres."

**Managing the dual-store gap** — this is where the design earns its keep:

- The indexer consumes issue-change events from RabbitMQ, fetches the full issue from Postgres (events carry ids, not payloads — the database is always the authority on content), and upserts the search document
- Indexing is idempotent by issue id and *versioned*: each document carries the issue's version; ES rejects out-of-order updates from a stale event, so retries and redeliveries can't regress a document
- p99 index lag target of ~5 seconds, monitored; if the queue backs up, search returns slightly stale results while writes remain unaffected — the correct degradation direction
- A nightly reconciliation sweep compares Postgres updated_at against indexed versions and re-indexes drift — the safety net for lost events
- UX seam: after a write, the client updates its local view from the write response rather than re-querying search, hiding the lag where users would most notice it (create issue → see it on the board)

**Saved filters** are stored as the raw JQL string plus owner and sharing scope — not as a pre-computed result set. This keeps them trivially cheap to store (one row, one string) and always correct, since `currentUser()` and `now()` re-resolve fresh on every run rather than going stale like a cached result list would. A saved filter used as an email subscription runs on a schedule through the identical query path a human triggers manually — one execution engine, whether the caller is a browser or a cron trigger.

## 🔧 Deep Dive 4: Bulk Operations Without Locking the World

"Move all 800 issues in this sprint to Done" is a routine action in real usage, and it stresses every mechanism above at once.

**The naive approach** — loop over issues, run the full transition pipeline per issue inside one HTTP request — fails in two ways: the request times out well before 800 sequential rule evaluations and commits finish, and a crash partway leaves an ambiguous "some issues moved" state with no way for the client to know which.

**The design**: bulk operations are asynchronous jobs, not synchronous requests.

1. The API validates the request shape and enqueues a bulk job with the issue id list and target transition, returning a job id immediately
2. A worker processes issues in small batches (e.g., 50 at a time), running the *exact same* per-issue pipeline — conditions, validators, atomic commit, post-functions — as a single-issue transition. There is no separate "bulk" code path to keep consistent with the real one
3. Per-issue failures (a permission denial, a failed validator, a version conflict) are recorded individually; the job continues past them rather than aborting the whole batch
4. The client polls job status, which reports counts: succeeded, failed with reasons, still pending
5. Failed issues can be retried individually — because the job stored per-issue outcomes, retry is "run the pipeline again for exactly these 12 issues," which is naturally idempotent since the pipeline itself is idempotent-safe via optimistic locking

> "The key decision is reusing the single-issue pipeline unchanged rather than writing a bulk-optimized version that batches the database writes. A batched UPDATE across 800 rows is tempting for throughput, but it would have to duplicate every rule-evaluation and permission-check code path outside the transaction boundary — and that duplication is exactly where bulk operations historically diverge from single-issue behavior in ways that surprise users, like a bulk transition skipping a validator that the UI enforces everywhere else. I accept the throughput cost of 800 individual commits (they're small and fast) in exchange for a guarantee that bulk and single-issue transitions can never disagree about what's allowed."

At the batch size and concurrency I'd tune for (50 issues per batch, a handful of worker processes per bulk job), 800 issues completes in low single-digit seconds — well within what a user is willing to watch a progress bar for — while still hitting the database as 800 small, index-friendly writes rather than one enormous locking transaction.

**Why per-issue partial success instead of all-or-nothing**: an all-or-nothing bulk transaction across 800 rows, several of which touch different permission checks, means one user without edit rights on one issue blocks 799 legitimate transitions for everyone else in the batch. Partial success with a clear per-issue report is more useful and matches how humans actually think about "move the sprint" — they want progress, not a wall.

This mirrors a broader pattern in the design: wherever an operation spans many issues (bulk transitions, sprint close, project-wide field migrations), it decomposes into independent per-issue operations coordinated by a job rather than a single all-encompassing transaction. That keeps the workflow engine's transactional guarantees scoped to what they were designed for — one issue's state — instead of stretching database transactions across operations that naturally want partial, observable progress.

## 🗂️ Boards, Sprints, and Comments

Three supporting pieces round out the picture, each with a distinct access pattern from the core issue path:

**Boards** (Kanban/Scrum) are not a stored entity so much as a saved JQL filter plus column-to-status mapping. A board's "columns" are configuration (which statuses map to which column), and its contents are a live JQL query re-run on load — this reuses the entire search pipeline instead of building a parallel board-materialization system. The trade-off is that board loads pay Elasticsearch's eventual-consistency lag; I mask this the same way as elsewhere — a card the user just dragged updates optimistically in the client and reconciles against the next board refresh rather than waiting on the index.

**Sprints** are a simple entity (project_id, name, start/end dates, state: future/active/closed) that issues reference by sprint_id. Starting a sprint is a bulk-ish operation — snapshot the committed scope — and closing one runs the same "move incomplete issues" flow as the bulk operations deep dive: incomplete issues transition or move to the next sprint through the standard per-issue pipeline, so sprint close can never leave issues in a state the workflow engine wouldn't otherwise allow. Backlog ordering (the rank users drag issues into) is stored as a lexicographic rank string per issue rather than an integer position — inserting between two issues just computes a string between their two ranks, so reordering never requires renumbering the whole backlog, which matters once a backlog holds thousands of issues and drag-and-drop needs to feel instant.

**Comments** are append-only child rows of an issue, each optionally carrying a visibility restriction (role or group) checked against the commenter and, on read, against the viewer. Comments publish their own lightweight event for notification purposes (watchers, @mentions) without going through the full issue-transition pipeline, since a comment isn't a workflow event — this keeps the workflow engine's scope to state transitions, not general activity.

**Attachments** are the one place large binary content enters the picture, and they're handled outside the relational path entirely: metadata (filename, size, uploader, content hash) lives in Postgres as a child row of the issue, while bytes go to object storage (MinIO/S3) keyed by content hash for natural deduplication — the same attachment dragged onto two issues stores once. Upload is a two-step handshake: the client requests a pre-signed upload URL scoped to the target issue and the permission check happens at URL-issuance time, not at storage time, so the storage layer itself never needs to know about Jira's permission model.

**Watchers**, a small but heavily-read feature, are a simple join table (issue_id, user_id) consulted only by the notification path — deliberately not part of the permission model, since watching an issue is an opt-in convenience, not a grant of access.

**Issue links** (blocks, relates-to, duplicates) are directed edges between two issue ids with a link type — another small join table, but one worth flagging because it's the one place the data model crosses project boundaries casually. A link from a PROJ-1 issue to a PROJ-2 issue must independently respect both projects' permissions on read, which is another argument for permission checks being resolved per-issue rather than assumed to be uniform across a result set.

## 🛡️ Security and Multi-Tenancy

Jira instances host confidential data (security incidents, HR issues, legal matters) inside otherwise-open organizations, so authorization has to be airtight, not just present:

- **Project-level isolation by default**: every query for issues, comments, and attachments is scoped by project_id and passes through the permission pipeline — there is no "list all issues" endpoint that bypasses per-project checks
- **Comment-level visibility**: comments can carry their own restriction (role or group), layered on top of issue-level permission — a support agent might see the issue but not internal-only comments
- **Attachment storage** uses signed, time-limited URLs issued only after the permission check passes, so a leaked direct storage URL doesn't become a durable bypass
- **Admin actions are the highest-risk surface** (workflow edits, permission scheme changes) — audited with actor and diff, and rate-limited separately from normal API traffic so a compromised admin token can't rewrite every workflow in a burst
- **Session and API token auth**: browser sessions via Redis-backed cookies for interactive use; scoped API tokens for automation, each carrying its own rate limit bucket so one runaway integration script can't starve interactive users

**Rate limiting tiers**, since "one bad actor" takes different shapes here: interactive users get generous per-session limits tuned for board polling and rapid clicking; automation tokens get lower per-minute limits but higher burst allowances for legitimate batch jobs (a CI pipeline creating 50 issues at once); webhook *registration* itself is limited per project to prevent an admin mistake from fanning out to thousands of destinations. Each tier is enforced with its own Redis-backed token bucket, keyed so that noisy automation never borrows from the interactive budget.

## 🔁 Consistency and Idempotency

**Idempotent writes**: automation and webhook retries mean the same logical request arrives multiple times. Any mutating request may carry an idempotency key; the gateway checks the idempotency_keys table, replays the stored response on a hit, and stores the status and body after first execution, expiring after 24 hours. Keys are stored in Postgres rather than Redis-only because a replayed *write* must be caught even across a cache flush — the same durability reasoning as the search pipeline: correctness anchors live in the durable store.

**Event delivery**: RabbitMQ gives at-least-once, so every consumer dedups on event_id — the search indexer via versioned upserts, the webhook dispatcher via a delivery log keyed by event and endpoint, notifications via a sent-log. Exactly-once is achieved per-consumer through idempotent handling, not promised by the bus.

**Ordering**: events for a single issue are processed in order (partitioned by issue id at the consumer); cross-issue ordering is unnecessary and not promised.

## 🧯 Failure Handling

Beyond the idempotency and dual-store mechanisms already covered, a few explicit degradation policies:

- **Elasticsearch unreachable**: search returns a clear "search temporarily unavailable" rather than an empty result set — an empty page reads as "no issues match," which for a user hunting a bug is actively misleading. Direct issue-by-key lookups keep working since they never touch ES.
- **RabbitMQ unreachable**: issue writes still commit to Postgres — the queue is downstream of the source of truth, never upstream. Publishing is wrapped in a circuit breaker; on an open breaker, events are held in a local outbox table and drained once the queue recovers, so notifications and search indexing catch up rather than silently losing the event.
- **Permission cache (Redis) unreachable**: falls back to computing permissions directly from Postgres per request. Slower, but correct — the system degrades toward higher latency on the read path rather than toward wrong authorization decisions, which is the one place "fail open" is unacceptable.
- **Webhook endpoint down**: retried with exponential backoff for a bounded window (e.g., 24 hours), then marked failed and surfaced to the admin who registered it — one integration's outage never blocks issue writes, since delivery is fully decoupled through the queue.

The unifying principle: every external dependency (search, queue, cache, webhooks) can degrade the *experience* — slower search, delayed notifications, stale board counts — but none of them can compromise the *correctness* of issue state, which lives in exactly one place.

**Outbox pattern detail**, since it's doing real work above: rather than publishing to RabbitMQ inside the same transaction as the issue commit (which would make the commit's success depend on the queue being reachable — exactly the coupling I'm trying to avoid), the event is written as a row in an outbox table in the *same* transaction as the issue update. A separate relay process tails the outbox and publishes to RabbitMQ, marking rows delivered. This gets transactional guarantees (the event exists if and only if the commit happened) without ever making Postgres availability depend on RabbitMQ availability, or vice versa.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| Issue write latency p50/p99 | The core interactive SLO; regressions usually trace to rule-evaluation or lock contention |
| Transition rate by project and status pair | Business heartbeat; a project whose transitions stop often means a broken workflow config |
| Conflict (version-mismatch) rate | Optimistic-lock health; a spike means some automation is fighting users |
| Search index lag (event timestamp → indexed) | The dual-store gap made visible; alert past 30s |
| Permission cache hit ratio | Below ~95%, Postgres starts feeling the 100x read amplification |
| Queue depth per consumer | Webhook/notification backlogs are invisible to users until they're huge — alert early |
| JQL latency histogram by query complexity | Separates "ES is slow" from "users write monstrous queries" |

Structured logs carry issue key, user id, transition id, and event id so one issue's full lifecycle — API call, rule evaluation, commit, index update, webhook delivery — is traceable end to end.

Dashboards are organized around the three engines rather than raw infrastructure metrics — a "workflow engine health" view (transition latency, conflict rate, post-function failures), a "permission pipeline health" view (cache hit ratio, resolution latency, denial rate anomalies), and a "search consistency" view (index lag, reconciliation drift count). This mirrors the architecture: when something feels wrong to a user, the on-call engineer should be able to name which engine owns the symptom within seconds, not correlate raw CPU and query graphs by hand.

## 📈 Scalability: What Breaks First

1. **First: JQL/board reads.** Reads outnumber writes 50–100x and boards refresh constantly. Fixes in order: permission-set caching (done), board query result caching with event-driven invalidation, then scaling Elasticsearch replicas — ES scales reads horizontally much more gracefully than Postgres.

2. **Second: issue_history growth.** Hundreds of rows per busy issue across 100M issues makes history the biggest table by an order of magnitude. It's append-only and read only on demand (history tab, audits) — time-partition it, keep recent partitions hot, archive old partitions to cold storage. Never let audit reads compete with issue writes.

3. **Third: Postgres write path.** At ~1K writes/sec a single primary holds; growth beyond that shards cleanly by project_id — issues, history, and configuration are all project-scoped, and cross-project operations (issue links, JQL) already flow through Elasticsearch, which is shard-agnostic. The project key prefix even gives humans a natural shard hint.

4. **Fourth: webhook fan-out.** Big instances register thousands of webhooks; one slow endpoint must not delay others — per-endpoint queues with circuit breakers on failing destinations, and delivery isolation so a flapping integration only hurts itself.

5. **Fifth, further out: the single Elasticsearch cluster becomes a noisy-neighbor problem.** One enterprise instance running enormous JQL aggregations can degrade search latency for everyone sharing the cluster. The fix is tenant isolation — dedicated indices per large instance, with routing at the search-service layer, so a heavy customer's query load is contained to their own shards rather than felt cluster-wide.

Notice the pattern across all five: every bottleneck resolves by exploiting the same structural property — the system is fundamentally project-scoped and user-scoped, with cross-cutting concerns (search, permissions cache) built as derived, shardable layers on top. There is no natural "global" operation that would force a coordinator or a single point of contention as the system grows.

## 🧭 A Note on Deep-Dive Selection

I chose the workflow engine, permission pipeline, and JQL/search split as the three deep dives because they're where this system's defining requirement — full user-configurability — actually bites. Issue CRUD, comments, and attachments are straightforward once the data model is right; they don't reveal architectural judgment the way "how do you let 1M projects each define their own state machine without a deploy" does. If there were time for a fourth, I'd go into real-time collaboration on the issue detail view (concurrent editors seeing each other's changes as they type), which would pull in the same optimistic-concurrency ideas from the workflow engine but applied to field-level rather than status-level writes.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Custom fields | ✅ JSONB + GIN | ❌ EAV table | One-row reads; app-level validation in a single write path |
| Workflows | ✅ Data-driven, interpreted | ❌ Code-defined | Self-serve customization without deploys |
| Concurrency | ✅ Optimistic version check | ❌ Row locks | Rare conflicts; no lock-hold across rule evaluation |
| Search | ✅ Elasticsearch, async | ❌ Postgres FTS | Relevance, arbitrary predicates, aggregations |
| Search feed | ✅ Events with id-only + DB fetch | ❌ Full payload events | DB stays the single authority on content |
| Permissions | ✅ Schemes + cached per-user sets | ❌ Per-project ACLs, always-fresh | Manageable at 10K projects; reads off the DB |
| Revocation | ✅ Eager invalidation for denies | ❌ Uniform TTL | Slow-to-grant is a ticket; slow-to-revoke is an incident |
| Idempotency store | ✅ PostgreSQL | ❌ Redis-only | Duplicate writes must be caught across cache loss |
| History | ✅ Append-only change table | ❌ Full event sourcing | UI reads history directly; no projection layer needed |

## 🚀 Closing: What I'd Build Next

With more time I'd cover:

- **A rule sandbox for admin-defined *scripted* validators.** The moment a workflow allows arbitrary expressions ("require story_points > 0 AND priority != Low"), the interpreter needs execution limits, timeouts, and isolation — an admin's typo shouldn't be able to hang the transition pipeline for every user on that project.
- **Board-level real-time updates** via WebSocket fan-out of the same issue events already flowing through RabbitMQ — teammates watching a board should see a card move without a manual refresh, which reuses the event bus rather than adding a new source of truth.
- **Cross-project automation.** The workflow engine already generalizes past single-issue transitions — automation rules ("when issue moves to Done in any project, create a follow-up in another") are naturally just another consumer of the same event stream, evaluated against the same permission model.
- **Archival tiering** for the long tail of dormant projects, which at 1M projects is most of them — old, inactive projects could move to cheaper storage and a slower query path without affecting active-project latency.

The through-line of the design: configuration is data, Postgres is the only authority for issue state, and every derived system — search, notifications, webhooks, boards — is allowed to lag but never allowed to diverge permanently. That single discipline is what lets a highly customizable product stay both fast and correct at 100M issues.

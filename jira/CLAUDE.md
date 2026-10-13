# Jira (Issue Tracking) — Development with Claude

## Project Context

A Jira-style issue tracker built around three hard problems that a simple CRUD app doesn't have: a **database-driven workflow engine** (users define their own statuses and transitions without code changes), a **user-facing query language** (JQL parsed to Elasticsearch), and **schema-flexible issues** (custom fields per project). The interesting tension is that issues must be strongly consistent in PostgreSQL (they drive audit trails and boards) while search must be fast and expressive over the same data — so the same write fans out to two stores with different consistency guarantees.

**Learning goals:** configurable state machines stored as data, parsing a query DSL into an execution plan, JSONB for variable schemas, and decoupling slow downstream work (indexing, notifications, webhooks) from the request path.

## Architecture at a Glance (what actually runs)

Four backing services, each earning its place — this matches `docker-compose.yml` and `backend/package.json` exactly:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** (`pg`) | Source of truth: issues, projects, workflows, statuses/transitions, `issue_history`, comments, `idempotency_keys` | ACID for the audit trail and multi-table issue writes; JSONB columns hold custom fields + workflow rules |
| **Redis / Valkey 7** (`ioredis`) | Session store (`jira:session:` prefix), cache-aside for issues/boards, idempotency response cache | Sub-ms reads on the hot path; `connect-redis` gives distributed sessions so API instances are stateless |
| **Elasticsearch 8.11** (`@elastic/elasticsearch`) | Issue search index; target of the JQL→bool-query translation | JQL's boolean/nested/range logic maps naturally to the ES query DSL; PG full-text can't express it cleanly |
| **RabbitMQ 3.12** (`amqplib`) | Fan-out of issue events to background workers | Decouples slow work (search indexing, notifications, webhooks) from the write path; built-in retry + DLQ |

Backend routes: `auth`, `projects`, `issues`, `search`, `workflows`. Background workers: `search-index-worker`, `notification-worker`, `webhook-worker` (each a separate `dev:worker:*` process). Frontend: React 19 + TanStack Router (file-based routing via the router-vite plugin) + Zustand. The Kanban board uses native HTML5 drag and drop (`components/board/`); `@dnd-kit` is listed in `package.json` but not used.

## Key Design Decisions

### 1. Workflow as data, not code
Statuses and transitions live in tables (`statuses`, `transitions`), and each transition carries `conditions`, `validators`, and `post_functions` as JSONB arrays. A project references a `workflow_id`, so admins reconfigure the state machine without a deploy. Implemented condition types: `always`, `user_in_role`, `issue_assignee`. Validators: `field_required`, `field_value`. Post-functions: `assign_to_current_user`, `clear_field`, `update_field`, plus a `send_notification` placeholder. Trade-off: the engine is an interpreter over JSONB rules, so there's no compile-time guarantee a workflow is well-formed. Unknown rule types are rejected when a transition is created and fail closed at execution time; reachability is still unchecked.

### 2. JQL parsed to an AST, then translated to Elasticsearch
`services/jqlParser.ts` tokenizes the query, parses it by recursive descent (AND binds tighter than OR, `NOT`, parentheses, `ORDER BY`), and emits an ES bool query (`must` for AND, `should`+`minimum_should_match:1` for OR, `must_not` for NOT). It supports `=, !=, ~, !~, >, <, >=, <=, IN, NOT IN, IS, IS NOT`, `EMPTY`, relative dates (`-7d`) and functions (`currentUser()`, `now()`, `startOfDay/endOfDay/startOfWeek/endOfWeek`). Fields come from a registry (`project`→`project_key`, `assignee`→`assignee_name`, but `assignee = currentUser()`→`assignee_id`); keyword matches are case-insensitive; anything unparseable is an error with a position. Every search also carries a filter on the projects the caller may view. Trade-off: search is eventually consistent — a just-created issue lags the index by the worker round-trip, so JQL results can be ~100–500ms stale versus a direct PG read.

### 3. JSONB custom fields over EAV
`issues.custom_fields` is a single JSONB column (GIN-indexable) rather than an entity-attribute-value table. This avoids a multi-join per issue fetch and serializes cleanly into the ES document. Trade-off: no database-level type enforcement — field validity is an application concern, and malformed custom data is caught (if at all) at index or read time, not on write.

### 4. Async fan-out via RabbitMQ, best-effort
Issue create/update/transition/delete publish an event after the transaction commits (`services/issue/afterCommit.ts`); `search-index-worker`, `notification-worker`, and `webhook-worker` consume independently. The publish is fire-and-forget from the request's perspective (`.catch()` logs failures rather than failing the write); there is no outbox, so a crash between commit and publish loses the event. Trade-off: a dropped message means a stale search index or missed notification until the next write — acceptable because PostgreSQL, not the queue, is authoritative. RabbitMQ init is non-blocking on boot, so issue CRUD works even before the queue connects.

### 5. Two-layer idempotency
Mutating `/api` requests may carry `Idempotency-Key` (`X-Idempotency-Key` still accepted). The middleware claims the key with `SET NX`, answers `409` while the first request runs, `422` if the key comes back with a different body, replays the stored response (24h TTL) otherwise, and copies it to the `idempotency_keys` table, which is consulted when Redis has lost the key. Trade-off: an extra write per mutation, paid to make client retries (double-submit, flaky network) safe.

## Current State

Implemented and running end to end: session auth (bcrypt + Redis-backed sessions, session id rotated at login), project/sprint/board CRUD, issue CRUD with per-field `issue_history` rows written in the same transaction, the database-driven workflow engine (conditions/validators/post-functions, compare-and-swap on `issues.version`), permission schemes enforced on every route (`services/permissionService.ts`), optimistic concurrency for edits (`ETag` / `If-Match` → `412`), board ranking with fractional keys (`services/rank.ts`, `PUT /api/issues/:id/rank`), JQL search + quick text search against Elasticsearch with a visible-project filter, the three background workers, idempotency middleware, Prometheus metrics, and `/health` + `/ready` probes. Frontend: Kanban board with optimistic drags (transition across columns, reorder within a column, Alt+Arrow keyboard reorder, live-region announcements), issue detail with conflict handling and comments/history tabs, create-issue modal with idempotency keys.

Backend tests: `npm test` (vitest, 62 tests). Runtime-verified locally against PostgreSQL + Valkey only (no Elasticsearch or RabbitMQ in that environment).

Intentionally omitted (noted as production extensions in `architecture.md`): an outbox (events are published after commit instead), custom-field registry and validation, saved filters, rate limiting, live board updates, workflow editor UI, rank rebalancing, and real webhook delivery. The notification and webhook workers reference tables that the schema doesn't define (see Open Questions).

## Iteration & Repair Log

- **Issue service split.** `services/issue/` was broken into `create.ts`, `update.ts`, `queries.ts`, `transitions.ts`, `comments.ts`, `types.ts`, `index.ts` to keep each file focused; the monolithic issue service had grown past the ~150-line guideline.
- **Doc drift — phantom optimistic locking.** The prior `architecture.md` (and the checklist-style CLAUDE.md) claimed status transitions use "optimistic locking with a `version` column." No `version` column exists in `init.sql` and no `SELECT … FOR UPDATE`/version check exists in `services/issue/update.ts` — updates are sequential writes (UPDATE issue, then INSERT history rows). Corrected the consistency section to describe the actual behavior and reframe optimistic locking as a production hardening step.
- **README script drift.** README referenced `npm run migrate`; the actual script is `npm run db:migrate` (see `backend/package.json`). Fixed.
- **Repo-wide password normalization (partial here).** Seeded regular users log in with `password123`. The **admin** seed (`db/seed.ts`) still hashes `admin123` — the normalization pass didn't reach it. README now reflects the code (admin = `admin123`, users = `password123`) rather than claiming a uniform password. Fixing the seed itself is out of scope for a docs pass.
- **Service-list drift.** README's "This starts:" block and tech-stack line omitted RabbitMQ even though `docker-compose.yml` starts it and workers depend on it. Added.

- **2026-10-10 — permissions, concurrency, rank, docs rewrite.** Verified the old claims against the code and fixed what was broken:
  - *No authorization at all.* Any logged-in user could edit or delete any issue, rename or delete any project, add themselves as Administrator, edit shared workflows, and search every project; `permission_grants` was seeded but never read. Added `services/permissionService.ts` (pure `evaluateGrants`, Redis cache tagged with a per-project generation so revocation is immediate even with a racing refill) and `middleware/authorize.ts`; every route now checks a permission (`404` without `view_issue`, `403` otherwise); workflow edits and scheme swaps are system-admin only; search adds a visible-project filter built from the same rule.
  - *Transitions raced.* The engine checked the status in JS, then ran `UPDATE … WHERE id = $1` with no condition, wrote history and post-functions as separate statements, failed open on unknown or `user_in_group` conditions, returned 400 for every refusal, and never reindexed or published (the transition metric helper was dead code). Rewrote it as `services/issue/transitions.ts`: rules on a plain read, then `UPDATE … WHERE version = $read` with history and post-functions in one transaction, up to three re-evaluations, `403`/`409`/`422`, fail-closed rules, save-time validation in `createTransition`. Verified with two concurrent "Request Review" calls: one `200`, one `409`, exactly one history row.
  - *Lost updates on edit.* Added `issues.version`, `ETag`/`If-Match` → `412` with the current issue, `SELECT … FOR UPDATE` so history old values are exact, zod validation (`PATCH` rejects `status_id`), and checks that sprint/epic/parent belong to the issue's project.
  - *No board order.* Added `issues.rank` (`COLLATE "C"`), `jira_rank_after()` + an insert trigger (kept identical to `rankAfter()`; compared on 11 inputs), a unique `(project_id, rank)` index with retry, and drag/Alt+Arrow reordering. `seed.sql` now inserts issues `ORDER BY key` so the trigger ranks them in key order.
  - *Search defects.* `assignee = currentUser()` compared a UUID with `assignee_name` (never matched); AND/OR had equal precedence; trailing tokens and unclosed parentheses were ignored; `createIssue` indexed and published *before* COMMIT; the index worker selected the nonexistent `users.display_name`, so every indexing event failed. Rewrote the parser, moved side effects after commit with external versioning in ES, made the worker reuse `indexIssueById`, and made search answer `503` instead of `500`/empty results when ES is down.
  - *Idempotency.* The middleware did GET-then-SET (racy), ignored the body, cached 5xx for 24h, applied to GETs, and the frontend never sent a key; the PG table was unused. Fixed all of it and wired keys into create-issue and comments.
  - *RabbitMQ consumers* stopped after any reconnect and reconnects gave up after 5 tries; consumers are now re-registered and reconnects back off indefinitely.
  - Frontend: board split into `components/board/` with optimistic moves that restore only the moved card and explain refusals; issue detail sends `If-Match` and keeps the draft on `412`; comment drafts survive failed posts; the issues page's status/type filters now reach the server.
  - Rewrote `architecture.md` and the three answers to the repository standard (layered overviews, generated sequence diagrams, ~3.4–4.4K words each).

## Open Questions

1. Workflow validation: `createTransition` now rejects unknown rule types and statuses from another workflow, but nothing checks reachability (a status with no way out). Worth a publish step that validates the whole graph?
2. Search consistency: index lag is hidden on the board by rendering write responses, but a JQL filter can still miss an issue for a few seconds. Is that acceptable, or should the creating user's own writes be merged into their search results?
3. Custom-field typing: without DB-level constraints, what's the right layer to enforce field types — a JSON Schema per field definition validated on write?
4. Notification and webhook workers query `issue_watchers`, `project_watchers`, `notifications`, `email_log`, `webhooks`, `webhook_deliveries` and `users.display_name`/`email_notifications`, none of which exist, so their messages dead-letter. Add the tables, or remove the workers until they are designed?
5. Events are published after commit, not through an outbox, so a crash between the two loses the event. Is the outbox (plus a reconciliation sweep) worth adding here, given PostgreSQL is authoritative anyway?
6. Rank keys grow at hot spots (about one character per five inserts at one position). When should a per-project rebalance run, and should it be synchronous above some key length?

## Resources

- [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) — API shape reference
- [Workflow Patterns](https://www.workflowpatterns.com/) — formal transition/condition modeling
- [Elasticsearch bool query DSL](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-bool-query.html) — the JQL translation target
- [PostgreSQL JSONB](https://www.postgresql.org/docs/current/datatype-json.html) — custom-field storage and GIN indexing

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

Backend routes: `auth`, `projects`, `issues`, `search`, `workflows`. Background workers: `search-index-worker`, `notification-worker`, `webhook-worker` (each a separate `dev:worker:*` process). Frontend: React 19 + TanStack Router (file-based routing via the router-vite plugin) + Zustand, with **@dnd-kit** powering the drag-and-drop Kanban board.

## Key Design Decisions

### 1. Workflow as data, not code
Statuses and transitions live in tables (`statuses`, `transitions`), and each transition carries `conditions`, `validators`, and `post_functions` as JSONB arrays. A project references a `workflow_id`, so admins reconfigure the state machine without a deploy. Implemented condition types: `always`, `user_in_role`, `issue_assignee`. Validators: `field_required`, `field_value`. Post-functions: `assign_to_current_user`, `clear_field`, `update_field`, plus a `send_notification` placeholder. Trade-off: the engine is an interpreter over JSONB rules, so there's no compile-time guarantee a workflow is well-formed (no unreachable-status check) — validation is best-effort at execution time.

### 2. JQL parsed to an AST, then translated to Elasticsearch
`services/jqlParser.ts` tokenizes the query, builds a clause/group AST, and emits an ES bool query (`must` for AND, `should`+`minimum_should_match:1` for OR). It supports `=, !=, ~, !~, >, <, >=, <=, IN, NOT IN, IS, IS NOT`, parentheses, and functions (`currentUser()`, `now()`, `startOfDay/endOfDay/startOfWeek/endOfWeek`, `empty/null`). Field names are normalized (`type`→`issue_type`) and mapped to ES field names (`project`→`project_key`, `assignee`→`assignee_name`). Trade-off: search is eventually consistent — a just-created issue lags the index by the worker round-trip, so JQL results can be ~100–500ms stale versus a direct PG read.

### 3. JSONB custom fields over EAV
`issues.custom_fields` is a single JSONB column (GIN-indexable) rather than an entity-attribute-value table. This avoids a multi-join per issue fetch and serializes cleanly into the ES document. Trade-off: no database-level type enforcement — field validity is an application concern, and malformed custom data is caught (if at all) at index or read time, not on write.

### 4. Async fan-out via RabbitMQ, best-effort
Issue create/update/delete publish an event; `search-index-worker`, `notification-worker`, and `webhook-worker` consume independently. The publish is fire-and-forget from the request's perspective (`.catch()` logs failures rather than failing the write). Trade-off: a dropped message means a stale search index or missed notification until the next write — acceptable because PostgreSQL, not the queue, is authoritative. RabbitMQ init is non-blocking on boot, so issue CRUD works even before the queue connects.

### 5. Two-layer idempotency
Mutating `/api` requests carry `X-Idempotency-Key`. The middleware caches the response in Redis (24h TTL) and replays it on retry; an `idempotency_keys` table in PostgreSQL is the durable backstop if Redis is flushed. Trade-off: an extra write per mutation, paid to make client retries (double-submit, flaky network) safe.

## Current State

Implemented and running end to end: session auth (bcrypt + Redis-backed sessions), project/sprint/board CRUD, issue CRUD with `issue_history` audit rows written per changed field, the database-driven workflow engine (conditions/validators/post-functions), JQL search + quick text search against Elasticsearch, the three background workers, idempotency middleware, Prometheus metrics (`/metrics`, including a per-transition counter), and `/health` + `/ready` probes. Frontend has the Kanban board with drag-and-drop, issue detail with tabbed comments/history, and a create-issue modal.

Intentionally omitted (noted as production extensions in `architecture.md`): a custom-field editor UI and field-type validation UI, saved filters, optimistic-locking/version columns on issues, rate-limiting middleware (designed but not wired), and real webhook delivery targets (worker exists, endpoints are simulated).

## Iteration & Repair Log

- **Issue service split.** `services/issue/` was broken into `create.ts`, `update.ts`, `queries.ts`, `transitions.ts`, `comments.ts`, `types.ts`, `index.ts` to keep each file focused; the monolithic issue service had grown past the ~150-line guideline.
- **Doc drift — phantom optimistic locking.** The prior `architecture.md` (and the checklist-style CLAUDE.md) claimed status transitions use "optimistic locking with a `version` column." No `version` column exists in `init.sql` and no `SELECT … FOR UPDATE`/version check exists in `services/issue/update.ts` — updates are sequential writes (UPDATE issue, then INSERT history rows). Corrected the consistency section to describe the actual behavior and reframe optimistic locking as a production hardening step.
- **README script drift.** README referenced `npm run migrate`; the actual script is `npm run db:migrate` (see `backend/package.json`). Fixed.
- **Repo-wide password normalization (partial here).** Seeded regular users log in with `password123`. The **admin** seed (`db/seed.ts`) still hashes `admin123` — the normalization pass didn't reach it. README now reflects the code (admin = `admin123`, users = `password123`) rather than claiming a uniform password. Fixing the seed itself is out of scope for a docs pass.
- **Service-list drift.** README's "This starts:" block and tech-stack line omitted RabbitMQ even though `docker-compose.yml` starts it and workers depend on it. Added.

## Open Questions

1. Workflow validation: should the engine reject a workflow with unreachable statuses or a transition to a status in another workflow at save time, rather than failing at execution?
2. Search consistency: is the ~100–500ms index lag ever user-visible enough (e.g. "I just created it and it's not in my filter") to warrant a synchronous index write for the creating user only?
3. Custom-field typing: without DB-level constraints, what's the right layer to enforce field types — a JSON Schema per field definition validated on write?
4. Concurrent transitions: two users transitioning the same issue simultaneously both succeed today. When does this project need a `version` column and a compare-and-swap update?

## Resources

- [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) — API shape reference
- [Workflow Patterns](https://www.workflowpatterns.com/) — formal transition/condition modeling
- [Elasticsearch bool query DSL](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-bool-query.html) — the JQL translation target
- [PostgreSQL JSONB](https://www.postgresql.org/docs/current/datatype-json.html) — custom-field storage and GIN indexing

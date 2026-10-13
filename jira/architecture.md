# Jira (Issue Tracking) — Architecture

## System Overview

An issue tracker in the style of Jira: projects hold issues that move through workflows, appear on Kanban boards in a team-chosen order, and are found with a small query language (JQL). It looks like CRUD over one `issues` table. What makes it a design problem is that almost nothing is fixed: **every project defines its own workflow** (a state machine stored as data), **its own permission scheme** (who may do what), and **its own board order**, while many people edit the same issues at the same time and expect search to agree with the board a few seconds later.

This document describes the production design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Valkey + Elasticsearch + RabbitMQ + React code actually does.

**Learning goals**

- Running a user-defined state machine safely: rules evaluated without locks, the write applied with a compare-and-swap.
- Evaluating permission schemes on every request, cheaply, without serving revoked access from a cache.
- Optimistic concurrency end to end: a `version` column, `ETag` / `If-Match`, `412 Precondition Failed`.
- Ordering a board with fractional rank keys, so a drag rewrites one row instead of renumbering a column.
- Keeping a search index (a derived read model) in step with the source of truth through an outbox and versioned writes.
- Parsing a query language into an AST and compiling it into a search engine query with a mandatory permission filter.

## Requirements

### Functional requirements

1. **Issues**: create, edit, comment, delete; every change recorded in an audit trail.
2. **Workflows**: per-project statuses and transitions; each transition carries conditions (who may run it), validators (what must be true) and post-functions (side effects).
3. **Permission schemes**: per-project grants of permissions (view, edit, transition, administer…) to roles, users or everyone.
4. **Boards and backlog**: columns per status, cards in a manual rank order; drag between columns to transition, within a column to reorder.
5. **Search**: JQL such as `project = DEMO AND assignee = currentUser() AND status IN ("To Do", "In Progress") ORDER BY priority DESC`.
6. **Integrations**: an API that automation can call and retry safely, plus webhooks and notifications on issue events.

Out of scope: time tracking, reports and dashboards beyond simple counts, attachments' content pipeline, marketplace apps, cross-instance federation.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Issue read latency | p99 < 200 ms | The issue view and board are the most frequent requests |
| Write latency (edit, transition, rank) | p99 < 300 ms | Drags must feel immediate; the UI is optimistic but confirmations matter |
| JQL search latency | p99 < 1 s | Interactive filtering, including large projects |
| Search freshness | Index lag p99 < 5 s | "I just changed it and the filter disagrees" must be rare and short |
| Availability | 99.9% for reads and writes; search may degrade separately | An internal tool many teams depend on all day |
| Correctness | No lost updates; no transition that violates the workflow or permissions | The audit trail is a compliance artifact for many teams |
| Revocation | Removing a member takes effect on their next request | Slow-to-revoke is a security incident, slow-to-grant is a ticket |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Users | 10M registered, 1M daily, 100K concurrent at peak | Stateless API instances behind a load balancer; sessions in Redis |
| Projects / issues | 1M projects, 100M issues, +100K issues per day | Shard by project when one primary is not enough; most projects are small |
| Writes (edits, transitions, comments, ranks) | 1M users × ~20/day ≈ 20M/day ≈ 230/s average, ~1K/s peak | One PostgreSQL primary holds this for years |
| Reads (boards, issue views, JQL) | ~50× writes ≈ 12K/s average, ~50K/s peak | Cache configuration and permissions; boards read replicas; JQL goes to Elasticsearch |
| Permission checks | One per request ≈ 50K/s peak | Must be a Redis hit (≥ 95%), otherwise permissions become the biggest query load |
| History rows | ~15 per issue ≈ 1.5B rows × ~150 B ≈ 225 GB | Append-only, partitioned by month, read only when someone opens the history tab |
| Issue rows + comments | 100M × 2 KB + 500M × 400 B ≈ 400 GB | Fits a handful of shards; custom fields stay in JSONB on the row |
| Search index | ~1.5× issue data ≈ 300 GB plus replicas | A dedicated cluster; large tenants get their own indices |
| Issue events | ~1K/s peak, fanned out to 3 consumers | RabbitMQ is plenty; PostgreSQL stays the system of record for replays |
| Board size | Up to a few thousand cards per project | A rank key is 7–12 characters; a move rewrites one row |

### Local Development Scale

Two projects, nine issues and four users from [`seed.sql`](./backend/db-seed/seed.sql); one API process, optional workers, PostgreSQL and Valkey required, Elasticsearch and RabbitMQ optional (writes succeed without them; search answers `503`). Ports and setup are in the [README](./README.md).

## High-Level Architecture

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

1. **Edit or transition (1).** The Issue API checks the caller's permissions (a Redis hit), evaluates the workflow rules, and commits one transaction: the conditional `UPDATE` (only if the issue's version is the one the rules were evaluated against), the history rows, and an outbox row describing the change.
2. **Search (2).** The Search API parses the JQL, resolves `currentUser()`, adds a filter limiting results to projects the caller may view, and queries Elasticsearch. Search never touches PostgreSQL.
3. **Propagate (3).** A relay publishes outbox rows to RabbitMQ after commit. The index worker re-reads the issue from PostgreSQL and writes it to Elasticsearch with the issue's version; notification and webhook workers consume the same events.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, routing, rate limits per user and per API token | Connections | Automation tokens get their own buckets so scripts can't starve people |
| Issue API | Issues, transitions, ranks, comments, permission checks, idempotency | Writes and issue reads | Stateless; the workflow engine is a library inside it, not a separate hop |
| Search API | JQL parsing, compilation to Elasticsearch, permission filter | Searches | Stateless; can fail without affecting writes |
| Redis | Sessions, cached permission sets, idempotency records, workflow definitions | Requests | Losing it makes requests slower, never wrong |
| PostgreSQL | Source of truth: issues, history, workflows, schemes, outbox | Writes, storage | Primary + replicas; shard by project later |
| RabbitMQ | `issue.events` fanout | Events | Durable queues, dead-letter queues per consumer |
| Index worker | Rebuilds search documents from PostgreSQL | Event rate | Idempotent: versioned writes |
| Elasticsearch | Issue documents for JQL and text search | Searches, data size | Derived; rebuildable from PostgreSQL at any time |
| Notification and webhook workers | Watchers, mentions, external integrations | Event rate | Retries with backoff; one failing endpoint never blocks writes |

The split that matters most is **PostgreSQL decides, everything else follows**. Issue state, workflow position, permissions and order are decided in one database transaction; search, notifications and webhooks are derived from committed changes and may lag, but never diverge permanently.

## Core Components / Request Flows

### Running a workflow transition

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

- The workflow is data: statuses, and transitions with JSON lists of conditions, validators and post-functions. The definition is cached in Redis and invalidated when an administrator edits it.
- Steps 4–5 evaluate the rules **without holding a lock**. Step 6 is the compare-and-swap: `UPDATE issues SET status_id = $to, version = version + 1 WHERE id = $id AND version = $read`. Zero rows means someone changed the issue after step 4 — perhaps reassigned it, which matters for an "only the assignee" condition — so the API re-reads and re-evaluates, up to three times.
- The order of checks is a correctness property: the transition must start from the issue's current status (else `409`), conditions decide *may this user* (`403`), validators decide *is the issue ready* (`422` naming the field). A user who may not run a transition never learns which fields it requires.
- Post-functions that change fields (assign to the actor, clear or set a field) run inside the same transaction and write their own history rows. Notifications are not post-functions here; they are driven by the committed event.
- Unknown rule types fail closed: a typo in a condition blocks the transition instead of allowing it. Definitions are also validated when saved, so the typo is usually caught there.

### Editing an issue that someone else is editing

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

Every issue has a `version`, exposed as a strong `ETag`. An edit carries the version the user was looking at in `If-Match`; if the row moved on, nothing is written and the response is `412` with the current issue so the client can show what changed. Inside the request the row is locked (`SELECT … FOR UPDATE`) for the few milliseconds of the write, so the history rows describe the value actually replaced. Optimistic across the user's think time (minutes), pessimistic for the write itself (milliseconds).

### Reordering the board

Each issue has a `rank`, a short base-36 string compared byte-wise (`COLLATE "C"`). One order per project serves every board column and the backlog. Moving a card computes a key strictly between its new neighbours, so only the moved row changes:

```typescript
// backend/src/services/rank.ts (abridged)
// Keys are base-36 fractions: "i002" sits between "i00100i" and "i00200i".
export function rankBetween(lower: string | null, upper: string | null): string {
  if (upper === null) return rankAfter(lower);   // append: advance a 6-char head by 36^2
  return midpoint(lower ?? '', upper);            // insert: shortest key strictly between
}
```

- The client says where the card went relative to a neighbour (`{"afterId": 17}`), not which key to use. The server reads the neighbour's current key and the next key after it inside the transaction, so a stale board still produces a sensible order.
- Two people dropping cards into the same gap compute the same key; a unique index on `(project_id, rank)` rejects the second, which re-reads and retries.
- New issues get a key after the project's current maximum from a database trigger, so every insert path (API, imports, seeds) lands at the bottom of the backlog.
- Repeated inserts at one spot lengthen keys by about one character per five moves. Production runs a background rebalance per project when keys pass ~32 characters (Jira's LexoRank does the same with buckets); ranking does not bump the issue's `version`, so reordering never makes someone's edit fail with `412`.

### Searching with JQL

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

The parser is a recursive-descent parser over a small grammar: clauses (`field operator value`), `AND` binding tighter than `OR`, `NOT`, parentheses, lists for `IN`, `EMPTY`, functions, and `ORDER BY`. Any token it cannot place is an error with a position — a filter that silently drops a clause returns the wrong issues, which is worse than an error. The AST compiles to an Elasticsearch `bool` query: `AND` → `must`, `OR` → `should` with `minimum_should_match: 1`, `NOT` → `must_not`, keyword equality → case-insensitive `term`, `~` → `match`, comparisons → `range`, `IS EMPTY` → `must_not exists`. `currentUser()` resolves to the caller's id and is compared with `assignee_id`, not the display name. The permission filter goes into `filter` context, so it is mandatory and does not affect scoring.

### Keeping the index in step

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

The outbox row commits with the change, so an event exists if and only if the change committed — no event for a rolled-back write, no lost event when the API crashes after commit. Events carry ids, not issue contents; the worker re-reads PostgreSQL, so even a stale event produces a current document. Each document carries the issue's version and is written with `version_type: external_gte`, so a late or redelivered event cannot replace a newer document. A nightly reconciliation compares `updated_at` with indexed versions to catch anything lost to bugs.

## Database Schema

### Production schema

PostgreSQL holds everything that must be correct. Abridged to the parts that carry the design:

```sql
CREATE TABLE workflows   (id SERIAL PRIMARY KEY, name TEXT NOT NULL, is_default BOOLEAN DEFAULT false);
CREATE TABLE statuses    (id SERIAL PRIMARY KEY, workflow_id INT NOT NULL REFERENCES workflows(id),
                          name TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('todo','in_progress','done')),
                          UNIQUE (workflow_id, name));
CREATE TABLE transitions (id SERIAL PRIMARY KEY, workflow_id INT NOT NULL REFERENCES workflows(id),
                          name TEXT NOT NULL,
                          from_status_id INT REFERENCES statuses(id),       -- NULL = from any status
                          to_status_id   INT NOT NULL REFERENCES statuses(id),
                          conditions JSONB NOT NULL DEFAULT '[]',          -- [{"type":"issue_assignee"}]
                          validators JSONB NOT NULL DEFAULT '[]',          -- [{"type":"field_required","config":{"field":"fix_version"}}]
                          post_functions JSONB NOT NULL DEFAULT '[]');

CREATE TABLE permission_schemes (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE permission_grants  (scheme_id INT NOT NULL REFERENCES permission_schemes(id),
                                 permission TEXT NOT NULL,                 -- view_issue, edit_issue, ...
                                 grantee_type TEXT NOT NULL CHECK (grantee_type IN ('anyone','user','role','group')),
                                 grantee_id TEXT,
                                 UNIQUE (scheme_id, permission, grantee_type, grantee_id));
CREATE TABLE project_members    (project_id UUID, user_id UUID, role_id INT, PRIMARY KEY (project_id, user_id));

CREATE TABLE issues (
  id            BIGSERIAL PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES projects(id),
  key           TEXT NOT NULL UNIQUE,                    -- DEMO-42
  status_id     INT NOT NULL REFERENCES statuses(id),
  summary       TEXT NOT NULL,
  assignee_id   UUID, reporter_id UUID NOT NULL, sprint_id INT, epic_id BIGINT,
  custom_fields JSONB NOT NULL DEFAULT '{}',
  version       INT NOT NULL DEFAULT 1,                  -- optimistic concurrency, exposed as ETag
  rank          TEXT COLLATE "C" NOT NULL,               -- board / backlog order
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX issues_project_rank ON issues (project_id, rank);
CREATE INDEX issues_project_status ON issues (project_id, status_id);
CREATE INDEX issues_custom_fields ON issues USING GIN (custom_fields);

CREATE TABLE issue_history (                             -- append-only audit trail
  id BIGSERIAL, issue_id BIGINT NOT NULL, user_id UUID NOT NULL,
  field TEXT NOT NULL, old_value TEXT, new_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE TABLE outbox (                                     -- written in the same transaction as the change
  id BIGSERIAL PRIMARY KEY, issue_id BIGINT NOT NULL, event_type TEXT NOT NULL,
  version INT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,                                   -- sha256(user id + client key)
  user_id UUID NOT NULL, request_fingerprint TEXT NOT NULL,
  response_status INT NOT NULL, response_body JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
```

Redis keys: `session:{sid}`, `perms:{project}:{user}` (permission set tagged with the project's generation), `perms-gen:{project}` (bumped on membership or scheme changes), `workflow:{id}`, `idem:{user}:{key}`.

At the sharding stage, everything project-scoped (issues, history, comments, members, ranks) shards by `project_id`; workflows and schemes are small and replicated. Cross-project queries already go to Elasticsearch, which is shard-agnostic.

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql), loaded by `npm run db:migrate` and safe to run repeatedly. It maps to the production design like this:

| Production | Local | Difference |
|------------|-------|------------|
| `issues` with `version`, `rank COLLATE "C"`, unique `(project_id, rank)` | Same columns, added with `ADD COLUMN IF NOT EXISTS`; a trigger `issues_default_rank` assigns ranks on insert via `jira_rank_after()` | Same design; existing rows are backfilled oldest first |
| `permission_grants` with a unique constraint | No unique constraint | Re-running `seed.sql` duplicates grants; harmless because evaluation builds a set |
| `issue_history` partitioned by month | One unpartitioned table | Fine at local scale |
| `outbox` + relay | — | Events are published right after commit instead (see Implementation Notes) |
| `idempotency_keys` | Same, plus Redis as the first stop | Written after the response, not in the handler's transaction |
| `custom_fields` with a field registry | JSONB column, no registry | No type validation for custom fields |

## API Design

### Production API

```
GET    /api/v1/issues/{key}                     issue + ETag "<version>"
POST   /api/v1/issues                           create; Idempotency-Key → 201 | 400 | 403 | 422
PATCH  /api/v1/issues/{id}                      edit fields; If-Match → 200 | 412 + current issue | 422
DELETE /api/v1/issues/{id}                      delete (delete_issue permission)
GET    /api/v1/issues/{id}/transitions          transitions this user may run now (a rendering hint)
POST   /api/v1/issues/{id}/transitions/{tid}    run one → 200 | 403 condition | 409 moved | 422 validator
PUT    /api/v1/issues/{id}/rank                 {afterId} or {beforeId} → 200 {rank}
GET    /api/v1/issues/{id}/history?cursor=…     audit trail, newest first, keyset pagination
POST   /api/v1/issues/{id}/comments             add comment; Idempotency-Key
GET    /api/v1/boards/{id}/issues?cursor=…      board cards in rank order
GET    /api/v1/search?jql=…&cursor=…            JQL → 200 | 400 invalid_jql | 503 search unavailable
GET    /api/v1/projects/{key}/permissions       permissions the caller holds (UI hints only)
WS     /api/v1/projects/{key}/events?after=…    live board updates with resume
```

- **Errors** carry a machine-readable `code` alongside the message (`version_conflict`, `condition_failed`, `validation_failed` with `field`, `invalid_from_status`, `forbidden`, `invalid_jql`); in production they follow RFC 9457 `application/problem+json`.
- **Not found and not allowed look the same.** A caller who cannot view a project gets `404` for its issues, so issue keys cannot be probed.
- **Status is not a field.** `PATCH` rejects `status`; the only way to change it is a transition, so the workflow can never be bypassed.

### Local routes

The local API is mounted under `/api` (no version prefix). Behaviour matches the list above except where Implementation Notes say otherwise.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login`, `/logout`, `/register`; GET `/api/auth/me` | Session auth (cookie) |
| GET, POST, PATCH, DELETE | `/api/projects`, `/api/projects/:idOrKey` | Projects (list filtered to visible ones) |
| GET | `/api/projects/:idOrKey/permissions` | Caller's permissions in the project |
| GET, POST, DELETE | `/api/projects/:id/members`, `/sprints`, `/boards`, `/labels`, `/components` | Project configuration |
| GET, POST, PATCH, DELETE | `/api/issues`, `/api/issues/:idOrKey` | Issues (`If-Match`, `Idempotency-Key`) |
| GET, POST | `/api/issues/:id/transitions[/:transitionId]` | Workflow transitions |
| PUT | `/api/issues/:id/rank` | Board order |
| GET, POST, PATCH, DELETE | `/api/issues/:id/comments[/:commentId]`, GET `/history` | Comments, audit trail |
| GET | `/api/issues/project/:projectId[/backlog]`, `/api/issues/sprint/:sprintId` | Lists in rank order |
| GET, POST | `/api/search`, `/quick`, `/suggestions`, `/aggregations`, `/validate` | JQL and text search |
| GET, POST, PATCH | `/api/workflows/...` | Workflows (edits: system administrators), sprint start/complete |
| GET | `/health`, `/ready`, `/metrics` | Operations |

## Key Design Decisions

### 1. Workflows are data, executed with a compare-and-swap

Code-defined workflows would mean a deploy whenever a team adds a "Blocked" column — disqualifying for a product whose point is self-service configuration. So workflows are rows interpreted at runtime, which creates two obligations. First, the engine must be safe against its own configurability: rule types are validated when a workflow is saved, and anything the engine cannot evaluate at runtime blocks the transition rather than allowing it. Second, the transition must be atomic with respect to the state the rules saw. Evaluating rules inside a row lock would hold the lock across rule evaluation and any lookups it needs; with bulk moves ("close this sprint's 800 issues") that serializes everything behind the slowest rule. Evaluating without a lock and committing with `WHERE version = $read` costs nothing when there is no contention — the normal case, since two people rarely act on one issue in the same second — and turns a race into a cheap re-evaluation instead of a corrupted audit trail. What we give up: under heavy contention on one issue (a misbehaving automation) requests retry and eventually fail with `409`, which is the honest outcome.

### 2. Optimistic concurrency for edits, visible to the client

Without a version, the last writer silently wins: a ten-minute description edit can erase a teammate's change and the history shows nothing wrong. Pessimistic "editing locks" would be held across a person's think time and need lease expiry and unlock buttons. A `version` column with `If-Match` → `412` costs one integer and pushes the decision to the person who has the context: the client shows the current version next to the unsaved draft. Discrete fields (assignee, priority) could tolerate last-write-wins, but one rule for every field is easier to reason about, and the client can retry those automatically.

### 3. Permission schemes, cached per user and project with generation-tagged entries

Ten thousand projects do not need ten thousand permission matrices; they need a dozen schemes, each shared by many projects, so changing "Restricted" fixes hundreds of projects in one write. The cost is an evaluation on every request: scheme → grants → the caller's roles in the project. Cached naively, revocation lags by the TTL — and a cache refill racing a revocation can put the old access back. So each cached permission set is tagged with a per-project generation number, and any membership or scheme change bumps the generation: entries from older generations are ignored on read. Grants and revocations both take effect on the next request; the 60-second TTL is only a backstop if the bump itself fails. Search uses the same evaluation to compute the visible-project filter, so the search box and the issue page can never disagree about access.

### 4. Elasticsearch as a derived read model, fed through an outbox

PostgreSQL could answer simple JQL and would be strongly consistent. It breaks on three things Jira users do constantly: free combinations of predicates across custom fields (each shape needs its own index), relevance-ranked text search, and facet counts over large result sets. Elasticsearch indexes every field by construction and aggregates across shards. The price is two stores that can disagree. The outbox makes that disagreement temporary — no lost or phantom events — and versioned writes make it monotonic. The client hides the remaining lag where users notice it most by rendering from write responses rather than re-querying search.

### 5. Fractional rank keys instead of integer positions

Integer positions make a drag an `UPDATE … SET position = position + 1` over every card below the drop point: a write that grows with the board and conflicts with every concurrent drag. A fractional key changes one row; concurrency is handled by a unique index and a retry. The cost is key growth at hot spots and an occasional rebalance, which is a background job rather than part of the user's request.

### 6. Idempotency keys for writes that are not naturally idempotent

Creating an issue or posting a comment twice is not harmless, and automation retries constantly. A client-chosen key, claimed atomically in Redis and stored with a fingerprint of the request, turns a retry into a replay of the original response; a different request with the same key gets `422` instead of the wrong replay.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Edit fields | No lost updates | `version` + `If-Match` → `412`; row lock for the write |
| Transition | Never applied from the wrong status or against stale rules | Compare-and-swap on `version`; re-evaluate on conflict; `409` |
| Audit trail | History rows exist exactly for committed changes | Same transaction as the change |
| Board order | A total order per project, no duplicate positions | Unique `(project_id, rank)`; retry on conflict |
| Create / comment | At most once per client intent | `Idempotency-Key` claimed with `SET NX`; stored response; fingerprint check |
| Search index | Eventually equal to PostgreSQL, never regressing | Outbox; events by id; external versioning; nightly reconciliation |
| Permissions | Changes effective on the next request | Generation-tagged cache entries |

Read-your-writes on the board holds because the client applies the write response; search may lag by seconds and says so.

## Security / Auth

- **Authentication:** session cookie (`HttpOnly`, `SameSite=Lax`, `Secure`) backed by Redis; the session id is regenerated at login. Automation uses scoped API tokens with their own rate limits.
- **Authorization:** every route checks a project permission; system administrators (an instance role) edit shared workflows and swap schemes. Lack of `view_issue` is answered with `404`.
- **Workflow conditions are authorization too:** they fail closed.
- **Input validation:** request bodies are validated at the boundary; `PATCH` rejects unknown fields; references (sprint, epic, parent) must belong to the issue's project, otherwise an issue could be pushed onto another project's board.
- **Search:** the permission filter is part of every Elasticsearch query, including suggestions and facet counts.
- **Rate limiting:** token buckets in Redis per user and per token; stricter limits on JQL and on webhook registration.

## Observability

- **Workflow engine:** transitions by project and status pair, refusals by code (`403`/`409`/`422`), compare-and-swap conflicts.
- **Concurrency:** `412` and rank-collision rates; a spike usually means an automation fighting people.
- **Permissions:** cache hit ratio (alert below 95%), denials by permission.
- **Search consistency:** index lag (commit → searchable; alert above 30 s), outbox backlog, reconciliation drift.
- **Queues:** depth and dead-letter counts per consumer.
- Structured logs carry issue key, user id, transition id and event id, so one change can be followed from request to index to webhook.

## Failure Handling

| Failure | Behavior | Mitigation |
|---------|----------|------------|
| Elasticsearch down | JQL returns `503 search unavailable`; boards and issue pages keep working | Boards read PostgreSQL; an empty result would be misleading |
| RabbitMQ down | Writes keep committing; outbox rows accumulate | Relay drains the backlog when the broker returns |
| Redis down | Slower requests; permissions computed from PostgreSQL | Sessions fail closed (users re-login); never fall back to "allow" |
| PostgreSQL primary down | Writes fail with `503`; replicas serve reads | Failover; clients retry with the same idempotency key |
| Worker crash mid-event | Message redelivered | Idempotent consumers (versioned index writes, delivery logs) |
| Poison message | Retried with backoff, then dead-lettered | Dead-letter queue per consumer, alert on depth |
| Webhook endpoint down | Deliveries retried for up to 24 h | Per-endpoint queues and circuit breakers |

## Scalability Considerations

1. **Reads first.** Boards and issue views dominate: cache workflow and permission data, serve boards from replicas, keep JQL on Elasticsearch replicas.
2. **History growth.** The largest table by rows: monthly partitions, old partitions moved to cheaper storage.
3. **Write primary.** Around ~1K writes/s one primary holds; beyond that shard by `project_id` — issues, history, ranks and members are all project-scoped.
4. **Noisy tenants.** One enterprise's huge JQL aggregations should not slow everyone: dedicated indices for large tenants, routed by the Search API.
5. **Bulk operations.** "Move 800 issues" becomes a background job that runs the same per-issue transition pipeline and reports per-issue outcomes.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Workflow definition | Data in PostgreSQL, interpreted | Code per workflow | Teams change workflows without deploys |
| Transition atomicity | Evaluate unlocked, compare-and-swap on version | Row lock across evaluation | No lock held across rules; conflicts are rare |
| Concurrent edits | `version` + `If-Match` → `412` | Last write wins | No silent loss of a teammate's change |
| Permissions | Schemes + generation-tagged cache | Per-project ACLs, or uncached checks | Manageable at 1M projects; instant revocation |
| Unknown rule types | Fail closed | Fail open | A typo must block, not grant |
| Search | Elasticsearch read model | PostgreSQL full-text | Arbitrary predicates, relevance, facets |
| Index feed | Outbox + versioned writes | Publish in the request | No lost or phantom events; no regressions |
| Board order | Fractional rank keys | Integer positions | One-row moves; no renumbering |
| Retries | Idempotency keys with fingerprints | Disable the button | Covers timeouts and automation retries |
| Event bus | RabbitMQ | Kafka | ~1K events/s; PostgreSQL is the replay source |

## Implementation Notes

### What actually runs

One Express process ([`backend/src/index.ts`](./backend/src/index.ts)) serves the Issue API and the Search API routes together; three optional workers in [`backend/src/workers/`](./backend/src/workers/) consume RabbitMQ. [`docker-compose.yml`](./docker-compose.yml) starts PostgreSQL 16, Valkey 7, Elasticsearch 8.11 and RabbitMQ 3.12. Only PostgreSQL and Valkey are required: without Elasticsearch, search answers `503`; without RabbitMQ, writes still commit and the client reconnects in the background. The React 19 frontend uses TanStack Router and Zustand. Ports, credentials and commands are in the [README](./README.md).

### Production patterns implemented

| Pattern | Where | What it does locally |
|---------|-------|----------------------|
| Permission schemes | [`permissionService.ts`](./backend/src/services/permissionService.ts), [`middleware/authorize.ts`](./backend/src/middleware/authorize.ts) | Every project, issue, sprint, board and workflow route checks a permission; `404` without `view_issue`, `403` otherwise. System administrators (`users.role = 'admin'`) hold every permission and alone edit workflows or swap schemes |
| Generation-tagged permission cache | `permissionService.ts` | Redis entry per (project, user), 60 s TTL, ignored once `jira:perms-gen:{project}` moves on; bumped on membership and scheme changes |
| Search permission filter | [`searchService.ts`](./backend/src/services/searchService.ts) | `terms` filter on visible project ids in JQL, quick search, suggestions and facets; built with the same `evaluateGrants` rule |
| Atomic transitions | [`services/issue/transitions.ts`](./backend/src/services/issue/transitions.ts), [`workflowService.ts`](./backend/src/services/workflowService.ts) | Rules evaluated unlocked, then `UPDATE … WHERE version = $read`; history and post-functions in the same transaction; up to three re-evaluations; `403`/`409`/`422`; unknown rules fail closed and are rejected when a transition is created |
| Optimistic concurrency | [`services/issue/update.ts`](./backend/src/services/issue/update.ts), [`utils/http.ts`](./backend/src/utils/http.ts) | `version` column, `ETag` on reads and writes, `If-Match` → `412` with the current issue; `SELECT … FOR UPDATE` for the write so history old values are exact |
| Rank keys | [`services/rank.ts`](./backend/src/services/rank.ts), [`services/issue/rank.ts`](./backend/src/services/issue/rank.ts), [`init.sql`](./backend/src/db/init.sql) | `PUT /api/issues/:id/rank`; unique `(project_id, rank)` with retry; `jira_rank_after()` trigger for inserts, kept identical to `rankAfter()` |
| JQL parser | [`jqlParser.ts`](./backend/src/services/jqlParser.ts) | Precedence, `NOT`, strict errors with positions, field registry, case-insensitive keyword terms, `currentUser()` against `assignee_id`, relative dates (`-7d`), `ORDER BY` |
| After-commit indexing | [`services/issue/afterCommit.ts`](./backend/src/services/issue/afterCommit.ts), [`config/elasticsearch.ts`](./backend/src/config/elasticsearch.ts) | Index and publish only after `COMMIT`; documents written with `version_type: external_gte`; the index worker reuses the same function |
| Idempotency keys | [`middleware/idempotency.ts`](./backend/src/middleware/idempotency.ts) | `Idempotency-Key` (or `X-Idempotency-Key`) claimed with `SET NX`, `409` while in flight, `422` for a different body, 5xx not stored, durable copy in `idempotency_keys` |
| Consumer recovery | [`config/messageQueue.ts`](./backend/src/config/messageQueue.ts) | Consumers re-registered after every reconnect; reconnect backs off 5 s → 60 s indefinitely; poison messages dead-lettered after three attempts |
| Boundary validation | [`routes/issues.ts`](./backend/src/routes/issues.ts) | zod schemas; `PATCH` rejects unknown fields (including status); sprint, epic and parent must be in the issue's project |
| Session fixation | [`routes/auth.ts`](./backend/src/routes/auth.ts) | Session id regenerated on login and registration |
| Metrics, logs, probes | [`config/metrics.ts`](./backend/src/config/metrics.ts), [`config/logger.ts`](./backend/src/config/logger.ts) | Transitions, permission denials, concurrency conflicts, idempotent replays, search latency; Pino; `/health`, `/ready`, `/metrics` |

The heart of the transition engine is the compare-and-swap:

```typescript
// backend/src/services/issue/transitions.ts (abridged)
const { rows } = await client.query(
  `UPDATE issues SET status_id = $1, version = version + 1, updated_at = NOW()
   WHERE id = $2 AND version = $3 RETURNING *`,
  [transition.to_status_id, issue.id, issue.version]
);
if (rows.length === 0) return null; // changed since the rules were evaluated: re-read, retry
```

On the frontend, [`components/board/`](./frontend/src/components/board/) applies drags optimistically and restores only the moved card on `403`/`409`/`422`, announcing results in an `aria-live` region; `Alt+Arrow` reorders a focused card. [`hooks/useIssueDetail.ts`](./frontend/src/hooks/useIssueDetail.ts) sends `If-Match` on every edit and, on `412`, shows the current issue while keeping the user's draft. Create and comment requests carry idempotency keys from [`utils/idempotency.ts`](./frontend/src/utils/idempotency.ts), reused only after an uncertain failure.

Tests: `npm test` in `backend/` runs 62 vitest tests covering rank keys (including a 2,000-insert fuzz), the JQL parser and compiler, permission evaluation and caching, the transition engine (conflicts, rule failures, post-functions), edit conflicts, the idempotency middleware through Express, and consumer re-registration.

### Simplified or substituted

| Production | Local |
|------------|-------|
| Separate Issue API and Search API services | One Express process with route modules |
| Outbox table + relay | Index and publish right after `COMMIT`; a crash in between loses the event (search lags until the issue changes again) |
| TanStack Query for server state | Zustand stores with hand-written fetching; the board updates the store directly |
| WebSocket live board | None; the board refetches on a `409` conflict |
| Keyset pagination | `LIMIT/OFFSET`, capped at 200; the "All issues" board shows the first 50 issues by rank |
| Rank rebalancing job | None; keys grow at hot spots (about one character per five inserts at one spot) |
| Scoped API tokens, rate limiting | Session cookies only; no rate limiting |
| Field registry for custom fields | JSONB without type checks |
| Groups | Not modeled: group grants and `user_in_group` conditions never match (fail closed) |

### Omitted

CDN, multi-region deployment, sharding and read replicas, history partitioning, the reconciliation job, bulk operations as background jobs, workflow editor UI, transition screens (fields submitted with a transition; validators check the stored issue), saved filters, attachments, OAuth/SSO.

### Known limitations

- The notification and webhook workers query tables and columns that the schema does not define (`issue_watchers`, `project_watchers`, `notifications`, `email_log`, `webhooks`, `webhook_deliveries`, `users.display_name`, `users.email_notifications`), so every message they receive fails and is dead-lettered after three attempts. Webhook delivery and its signature are simulated.
- Issues are indexed twice per change (inline after commit and by the index worker); external versioning makes this harmless but wasteful.
- The idempotency record is written after the response, outside the handler's transaction: a crash between the commit and the record can still let one retry through.
- Routes log with `console.error` rather than the Pino logger.
- The frontend hides drags from users without `transition_issue` or `edit_issue` but not other controls; the server refuses them with a message.
- `npm run seed` (`seed.ts`) and `db-seed/seed.sql` create different demo users; see the README.

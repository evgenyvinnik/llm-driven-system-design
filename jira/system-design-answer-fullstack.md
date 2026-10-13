# 🎫 Issue Tracker (Jira) — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Jira's hard parts sit on the seam between browser and server. The server owns every rule — the workflow, the permissions, the board order — yet the board has to respond instantly to drags it isn't qualified to approve, while other people change the same issues. I'll design the contracts that let both sides do their jobs: a version that makes concurrent edits safe, structured refusals that let the UI explain a rejected drag, an idempotency key that makes retries safe, and a rank contract that keeps every board in the same order."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and the targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the board to the search index, plus two core flows |
| Data model & API contract | 7 min | Server tables, client cache, the fields both sides rely on |
| Deep dive 1: a drag, from pointer to commit | 8 min | Optimistic UI over a compare-and-swap, with honest refusals |
| Deep dive 2: two people, one issue | 7 min | Versions, `If-Match` and a conflict UI that keeps drafts |
| Deep dive 3: order and freshness | 7 min | Rank keys, search lag, live updates |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Projects contain issues that move through per-project workflows (statuses and transitions with conditions, validators and post-functions). Boards show a column per status with cards in a team-chosen order; dragging across columns runs a transition, within a column reorders. An issue panel edits fields and shows comments and history. JQL finds issues across projects. Permission schemes decide who may do what. Out of scope: reports, attachments, the workflow editor.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Issue reads / writes | p99 < 200 ms / < 300 ms |
| Backend | JQL | p99 < 1 s; index lag p99 < 5 s |
| Backend | Correctness | No lost updates; transitions always obey workflow and permissions |
| Backend | Revocation | Effective on the member's next request |
| Frontend | Drag feedback | Applied in < 100 ms; INP < 200 ms on a 500-card board |
| Frontend | Honesty | A refused change is undone within a second and explained |
| Both | Retries | No duplicate issues or comments after a timeout |

**Scale.** 1M daily users, 100M issues across 1M projects. About 1K writes/s at peak against ~50K reads/s — boards and issue views dominate — and one permission check per request. Boards up to a few thousand cards.

"The read ratio tells me permissions and workflow definitions must be cached. The board tells me the client must be optimistic, which in turn tells me the server's refusals must be structured enough for the client to explain."

---

## 🏗️ End-to-End Architecture (8 min)

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Browser SPA: board, issue panel, JQL search · query cache with optimistic updates               │
│ API client: If-Match on edits, Idempotency-Key on creates, errors by class                      │
└───────────────────┬────────────────────────────────────────────────────┬────────────────────────┘
 ▲ (3)              │ (1) PATCH …/:id + If-Match                         │ (2) GET /search?jql=…
 │                  ▼                                                    ▼
 │ ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ │ Load balancer · TLS · rate limits per user and per API token                                 │
 │ └────────────────┬────────────────────────────────────────────────────┬────────────────────────┘
 │                  │                                                    │
 │                  ▼                                                    ▼
 │ ┌──────────────────────────────────────┐                ┌──────────────────────────────────────┐
 │ │ Issue API (stateless)                │                │ Search API (stateless)               │
 │ │ permission checks · workflow engine  │                │ JQL parser → Elasticsearch query     │
 │ │ rank moves · idempotency keys        │                │ filter: projects the user may view   │
 │ └───────┬─────────────────────┬────────┘                └─────┬───────────────────────┬────────┘
 │         │                     │                               │                       │
 │         │                     │ permissions, keys             │ visible projects      │
 │         │ one transaction:    │       ┌──────────────────┐    │                       │
 │         │ UPDATE … WHERE      │       │ Redis            │    │                       │
 │         │   version = v       └──────▶│ sessions, cached │◀───┘                       │
 │         │ + history rows              │ permission sets, │                            │
 │         │ + outbox row                │ idempotency keys │                            │
 │         │                             └──────────────────┘          bool query + filter
 │         ▼                                                                             ▼
 │ ┌──────────────────────────────────────┐                ┌──────────────────────────────────────┐
 │ │ PostgreSQL · source of truth         │                │ Elasticsearch · issues index         │
 │ │ issues, history, workflows,          │                │ derived, rebuildable from PG         │
 │ │ permission schemes, outbox           │                └──────────────────────────────────────┘
 │ └────────────────┬─────────────────────┘                                    ▲
 │                  │ relay publishes outbox rows                              │ versioned upsert
 │                  ▼                                                          │
 │ ┌──────────────────────────────────────┐                ┌───────────────────┴──────────────────┐
 │ │ RabbitMQ · issue.events (fanout)     ├───────────────▶│ Index worker                         │
 │ └────────────────┬─────────────────────┘   issue event  │ re-reads the issue from PG           │
 │                  │                                      └──────────────────────────────────────┘
 │                  │ issue event
 │                  ▼
 │ ┌──────────────────────────────────────┐
 └─┤ Realtime gateway (WebSocket)         │
   │ per-project rooms, resume by event   │
   └──────────────────────────────────────┘
```

1. **Change (1).** The SPA applies the change to its cache at once and sends it with `If-Match` (edits) or `Idempotency-Key` (creates). The Issue API checks permissions, evaluates workflow rules, and commits the update, history and an outbox row in one transaction.
2. **Search (2).** The Search API compiles JQL to an Elasticsearch query with a mandatory filter for the projects the user may view.
3. **Push (3).** After commit, the relay publishes the event; the index worker updates Elasticsearch and the realtime gateway pushes the event to every open board in that project.

| Layer | Choice | Why |
|-------|--------|-----|
| SPA | React, TanStack Query for server state, URL for filters, Zustand for session and permissions | Optimistic updates with rollback without hand-written caching |
| Issue API | Stateless; workflow engine and permission checks in-process | A transition is one transaction about one row |
| Search API | Stateless; JQL compiler | Different store, different failure mode |
| PostgreSQL | Source of truth, including the outbox | Every decision commits in one place |
| Redis | Sessions, permission sets, idempotency records | Checks at cache speed |
| RabbitMQ + workers | Index, realtime and notification consumers | Derived systems lag; they never decide |
| Elasticsearch | JQL and text search | Arbitrary predicates and facets |

### Flow: a drag that becomes a transition

```
User                      SPA                        Issue API                      PostgreSQL
  │                        │                             │                               │
  │ 1 drag DEMO-5 to Done  │                             │                               │
  │───────────────────────▶│                             │                               │
  │                        │ 2 move card now, snapshot   │                               │
  │                        │ 3 POST …/5/transitions/12   │                               │
  │                        │────────────────────────────▶│                               │
  │                        │                             │ 4 permission + rules          │
  │                        │                             │ 5 UPDATE … WHERE version = 7  │
  │                        │                             │──────────────────────────────▶│
  │                        │                             │ 6 1 row; history + outbox     │
  │                        │                             │◀──────────────────────────────│
  │                        │ 7 200 v8 | 403 | 409 | 422  │                               │
  │                        │◀────────────────────────────│                               │
  │                        │ 8 merge v8, or restore + say why                            │
  │                        │                             │                               │
```

"Step 2 is the client's half: move the card, remember the old one. Steps 4–6 are the server's half: evaluate the rules on a plain read, then `UPDATE … WHERE version = 7` so the write only lands if nothing changed since the rules looked. Step 7 is the contract between them: a full issue on success, or a refusal the UI can explain."

### Flow: a create that survives a timeout

```
 SPA                               Issue API                         Redis   PostgreSQL
  │                                    │                               │          │
  │ 1 freeze form with key K           │                               │          │
  │ 2 POST /issues, Idempotency-Key K  │                               │          │
  │───────────────────────────────────▶│                               │          │
  │                                    │ 3 SET idem:{user}:K NX EX 60  │          │
  │                                    │──────────────────────────────▶│          │
  │                                    │ 4 INSERT DEMO-9 + history                │
  │                                    │─────────────────────────────────────────▶│
  │                                    │ 5 store 201 under K (24 h)    │          │
  │                                    │──────────────────────────────▶│          │
  │ 6 201 lost (timeout)               │                               │          │
  │◀───────────────────────────────────│                               │          │
  │ 7 retry: same K, same body         │                               │          │
  │───────────────────────────────────▶│                               │          │
  │ 8 201 DEMO-9, replayed             │                               │          │
  │◀───────────────────────────────────│                               │          │
  │                                    │                               │          │
```

"The key belongs to the user's intent — this submitted form — not to the HTTP attempt. The browser reuses it only when it doesn't know what happened (timeout, `5xx`); a definite answer retires it."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Table | Key columns | Notes |
|-------|-------------|-------|
| `issues` | `id`, `key`, `project_id`, `status_id`, `assignee_id`, `custom_fields` (JSONB), `version`, `rank` | Unique `(project_id, rank)`; `version` is the ETag |
| `transitions` | `from_status_id` (null = any), `to_status_id`, `conditions`, `validators`, `post_functions` | The workflow is data |
| `permission_grants` | `scheme_id`, `permission`, `grantee_type`, `grantee_id` | Shared schemes; no negative grants |
| `issue_history` | `issue_id`, `user_id`, `field`, `old_value`, `new_value` | Same transaction as the change |
| `outbox` | `issue_id`, `event_type`, `version`, `published_at` | Feeds index, realtime and webhooks |
| `idempotency_keys` | hash(user, key), request fingerprint, stored response | 24 h; Redis in front |

### Client side

| Cache key | Holds | Updated by |
|-----------|-------|------------|
| `['board', project, sprint]` | Issues in rank order (columns are derived by status) | Optimistic moves, write responses, live events |
| `['issue', key]` | One issue with `version` | Edits, `412` bodies, live events |
| `['workflow', project]` | Statuses and transitions | Rarely; long stale time |
| `['search', jql]` | Results and total | Refetch; may lag writes by seconds |
| Zustand | Session, permissions in the current project | Login, project switch |

### The contract

```
PATCH /api/v1/issues/{id}                 If-Match: "7" → 200 Issue | 412 {issue}
POST  /api/v1/issues/{id}/transitions/{t}  → 200 Issue | 403 | 409 | 422 {field}
PUT   /api/v1/issues/{id}/rank            {afterId} → 200 {rank}
POST  /api/v1/issues                      Idempotency-Key: K → 201 (replayed on retry)
GET   /api/v1/search?jql=…                → 200 | 400 {position} | 503
WS    /api/v1/projects/{key}/events       ?after=seq → {seq, issueId, version, type}
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `version` / `ETag` / `If-Match` | Writes apply only to the version the user saw; `412` returns the current issue | Never overwrite a teammate's change; show what changed |
| Refusal codes | `403 condition_failed`, `422 validation_failed` + `field`, `409 invalid_from_status` | Undo the drag and explain it, or open the field |
| `Idempotency-Key` | Same key + body → same response; same key + other body → `422` | Retry after timeouts without duplicates |
| `{afterId}` | The issue lands directly after that issue, as of now | Send intent, not positions |
| Event `version` | Monotonic per issue | Ignore events older than the cached copy |
| `503` from search | Search is down, not empty | Say "unavailable", never "no results" |

---

## 🔧 Deep Dive 1: A Drag, From Pointer to Commit (8 min)

"The scenario: Alice drags DEMO-5 from In Review to Done. Whether that is allowed depends on rules the browser doesn't have, and Bob may be changing DEMO-5 at the same moment."

**In the browser.** The card moves on drop. The board asks for the transitions available from the card's status — a rendering hint, already filtered by the user's permissions and conditions — and runs the one into the target column. On success it merges the returned issue into the cache: one card, not a board refetch that would clobber Alice's next drag. On failure it restores that one card and explains by class: `403` names who may do it, `422` opens the panel on the missing field, `409` says the card already moved and refetches the board. Each card's moves are numbered so a slow response to an older drag can't overwrite a newer one.

**On the server.** Permission check from the cached set; then the rule order: the transition must start from the current status, conditions decide *may this user*, validators decide *is the issue ready*. Then one transaction: `UPDATE … SET status_id = …, version = version + 1 WHERE id = … AND version = <read>`, the history row, post-function field changes with their own history, and the outbox row. If the update matches zero rows, the server re-reads and re-evaluates — if Bob reassigned the issue, an "only the assignee" condition now gives a different answer, which is the point.

| Approach | Verdict |
|----------|---------|
| ✅ Optimistic UI + server compare-and-swap + structured refusals | Instant, never wrong for long, always explained |
| ❌ Client evaluates workflow rules | Two implementations of every admin-written rule; the client's drifts |
| ❌ Server locks the row while evaluating rules | Locks held across rule evaluation; bulk moves serialize |
| ❌ Generic error toast | `403` and `422` need different user actions; string matching breaks |

"The available-transitions list and the execution check run the same rules twice, on purpose: once to decide what to draw, once to decide what happens. If the list were authoritative, anyone with a terminal could bypass it — and the honest client would still be wrong whenever a rule changed between fetching the list and acting."

**What I give up.** For a moment the board shows something the server may refuse. Refusals here are reproducible (the same user is refused every time), which is exactly why they must be explained rather than silently reverted.

---

## 🔧 Deep Dive 2: Two People, One Issue (7 min)

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

**Server.** Every issue carries `version`, returned as `ETag`. `PATCH` with `If-Match: "7"` locks the row for the write, compares, and either applies the change with history and `version = 8`, or writes nothing and answers `412` with the current issue. Status can't be changed through `PATCH` at all — only transitions — so the edit path can't bypass the workflow.

**Client.** Every save sends the version on screen. On `412` the panel swaps in the current issue, keeps the user's draft in the editor, and says what happened. Discrete fields save on change; text saves on blur or Enter, never per keystroke, because each save writes audit history.

| Approach | Verdict |
|----------|---------|
| ✅ Version + `If-Match` → `412` with the current issue | No silent loss; the person with context decides |
| ❌ Last write wins | Bob's change erases Alice's, and the history looks normal |
| ❌ Field-level merge on the server | Works for discrete fields, corrupts free text; needs a merge policy per field |
| ❌ Edit locks | Held across think time; need expiry and "unlock" buttons |

"Idempotency and versions solve different problems and I need both. A retried request with the same idempotency key should replay its original result; a genuinely different request based on an old version should get `412`. Without the key, a retry after a lost response would hit `412` against its own first write and confuse the user."

---

## 🔧 Deep Dive 3: Order and Freshness (7 min)

### Board order

Each issue has a short base-36 rank key, compared byte-wise, one order per project. The client sends intent — `PUT /rank {afterId: 17}` — and the server reads 17's key and the next key after it inside the transaction, picks a key between them, and writes one row. Two drops into the same gap compute the same key; a unique index on `(project_id, rank)` rejects one, which re-reads and retries. The client moves the card at once and, on failure, sorts the list by rank, which undoes the move because the card still carries its old key.

| Approach | Verdict |
|----------|---------|
| ✅ Server-computed fractional keys, client sends `afterId` | One-row moves; works from a stale board |
| ❌ Integer positions | A drag rewrites every card below; concurrent drags conflict |
| ❌ Client computes keys | Two implementations of ordering; collisions resolved nowhere |

### Search lag

Search is fed by the outbox, so it lags writes by a few seconds. The UI never re-queries search to confirm a write it just made: the write response updates the board and the panel directly. The lag is a backend property, closed on the client — neither side could hide it alone.

### Live updates

The realtime gateway consumes the same `issue.events` and pushes `{seq, issueId, version}` to open boards. The client applies an event only if its version is newer than the cached issue, so an event that crosses Alice's own write can't regress her card. After a reconnect the socket resumes from its last sequence; if the gateway no longer holds those events, the client refetches the board. The gateway doesn't echo events to the tab that caused them: that tab already has the write response.

"What I give up: a WebSocket connection per open board, and a resume window to operate. Polling would be simpler, but load would scale with idle tabs instead of with changes, and planning sessions are when people notice staleness most."

### Permissions across the stack

The server checks a project permission on every request, from a cache whose entries are tagged with a per-project generation that any membership change bumps, so revocation applies on the next request. The client fetches the user's permissions per project only to hide controls — drag handles for viewers, edit fields — and still handles a `403` gracefully. Search applies the same rule as a mandatory filter, so the search box can't surface an issue the issue page would refuse.

---

## 📈 Failures & Scale (3 min)

| Failure | What the user sees | What the system does |
|---------|--------------------|----------------------|
| Elasticsearch down | "Search is temporarily unavailable"; boards and issues work | `503`; boards read PostgreSQL |
| RabbitMQ down | Teammates' changes stop appearing live; search lags | Outbox rows wait; writes keep committing |
| Redis down | Slower pages; maybe a re-login | Permissions computed from PostgreSQL, never "allow" |
| Transition refused | Card slides back with the reason | `403` / `409` / `422` with code and field |
| Edit conflict | Current values shown; draft kept | `412` with the current issue |
| Timeout on create | Retry button; no duplicate issue | Same idempotency key replays the `201` |

**What breaks first as we grow:** permission checks if the cache hit ratio drops; board reads (replicas, cached board queries); `issue_history` growth (monthly partitions); then the write primary (shard by project — every core table is project-scoped). On the client: very large boards (cap columns, virtualize the backlog) and long-lived tabs (live channel resume).

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Drags | Optimistic UI + server compare-and-swap | Wait for the server, or client-side rules | Instant, correct, explained |
| Refusals | Structured codes with fields | Generic errors | Each needs a different user action |
| Concurrent edits | `If-Match` → `412`, keep drafts | Last write wins | No silent loss |
| Retries | Idempotency key per intent | Disable the button | Covers timeouts and automation |
| Order | Server rank keys, client sends `afterId` | Integer positions | One-row moves, one source of truth |
| Search freshness | Outbox + render from write responses | Synchronous indexing | Writes stay fast; lag hidden where it's felt |
| Live updates | WebSocket events with versions and resume | Polling | Load follows changes, not tabs |

"With more time I'd add bulk moves as background jobs reporting per-issue results, offline queuing of edits with the same idempotency keys, and a workflow editor that validates definitions before they're saved."

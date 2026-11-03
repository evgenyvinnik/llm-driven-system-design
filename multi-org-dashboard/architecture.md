# Multi-Org Dashboard - Architecture

## System Overview

The console of a fictitious multi-tenant AI product, **Relay**, a platform for building customer-support agents. Each organization has modules for agents, a knowledge base, conversation history, analytics, a prompt library, exports, billing and settings. One person can belong to several organizations with a different role in each, features are switched on per organization and per role, and the plan an organization pays for decides what it can use at all. The design problem is not the modules themselves. It is making sure that every screen, cache, background job and link agrees with the user's current access in the organization they are looking at, including while an administrator is changing that access.

**Learning goals:**

- Enforce authorization in the API and inside every query, and treat the UI as a reflection of that enforcement rather than a part of it
- Cache permission sets without serving revoked access: version-keyed entries, a short TTL, and authoritative checks for writes and downloads
- Drive route guards, the sidebar and action buttons from one server-computed manifest
- Scope client caches and in-flight requests to an organization, so switching cannot mix data
- Remove a member completely: sessions, open streams, invitations, share links and running exports
- Paginate and export large histories without losing the access filter on the way

The sections before **Implementation Notes** describe the production design. Implementation Notes maps it onto the local Docker + Node.js + React build, including what was simplified and what was left out.

## Requirements

### Functional Requirements

1. **Organizations and roles**: a user belongs to any number of organizations with one role each (`admin`, `editor`, `viewer`); projects inside an organization can be restricted to admins and named members
2. **Modules**: overview, agents, knowledge base, conversation history, analytics, prompt library (behind the `prompt_library` flag), exports, billing, settings (members, invitations, share links, audit log, features)
3. **Plans**: `starter` and `pro` decide entitlements (exports, cost analytics, seats, audit retention), separately from roles
4. **Organization switching**: the organization is in the URL; switching never shows the old organization's data
5. **Access changes mid-session**: role changes, flag changes and removals reach open tabs within seconds, and an open page the user can no longer use closes with an explanation
6. **Conversation history**: tens of thousands of conversations per organization, filters in the URL, cursor pagination, a virtualized table and a deep-linkable detail pane
7. **Exports**: background CSV export of the filtered history with progress and a notification
8. **Invitations and share links**: expiring, single-use invitations bound to an email address; revocable read-only links to prompts
9. **Audit**: every administrative change records actor, action, target and before/after values
10. **Admin preview**: an administrator can view the console as another role, read-only

### Non-Functional Requirements

| Requirement | Target (production) |
|-------------|---------------------|
| API availability | 99.95% |
| Org-scoped read latency | p99 < 150 ms, including the access check |
| Access check overhead | p99 < 5 ms on a cache hit |
| Revocation, writes and downloads | Effective on the next request after commit |
| Revocation, cached reads | Effective at once after the version mirror updates; never more than 60 s |
| Revocation, open tabs | Pushed within 2 s; at most one heartbeat interval (20 s) if the push is lost |
| Isolation | No request, cache entry, export or event crosses organizations |
| Durability | An administrative change and its audit record commit together or not at all |
| Retention | Audit 30 days (starter) / 365 days (pro); export files 7 days |

**Out of scope:** the agent runtime that produces conversations, model serving, payment processing, SSO/SCIM provisioning and custom roles.

## Capacity Estimation

### Production Scale

| Input | Value |
|-------|-------|
| Organizations | 50K; the largest has 20K members and handles 1M conversations/day |
| Console users | 1M members, 150K daily active, 30K concurrent tabs at peak; 1.4 organizations per user on average |
| Org-scoped requests | 200 per active user per day → 30M/day ≈ 350/s average, ≈1,700/s at a 5× peak; about 5% are writes |
| Conversations (written by the agent runtime) | 20M/day ≈ 230/s, retained 13 months |
| Exports | 5K/day; median 50K rows, largest 5M rows |
| Access changes (role, membership, flag, accepted invitation) | ≈50K/day, under 1/s, bursty during onboarding |

**Derived load:**

- **Authoritative access checks** (writes, downloads): ≈85/s at peak × 3 queries ≈ 250 queries/s on the PostgreSQL primary
- **Cache misses**: each active (user, organization) pair misses at most once per 60 s TTL, so ≤500 misses/s at 30K tabs ≈ 1,500 queries/s, servable from replicas (see Scalability)
- **Version-bump burst**: one flag change in the largest organization, with 15% of members online, makes ≈3K tabs refetch their manifest within a second: 3K misses and ≈9K queries in a burst
- **Event stream heartbeats**: as built, each stream re-checks membership in PostgreSQL every 20 s: 30K / 20 s ≈ 1,500 queries/s, as much as all cache misses combined
- **Permission cache footprint**: ≈2 KB per entry × 30K active pairs ≈ 60 MB
- **Conversation storage**: ≈0.5 KB per conversation row + 8 messages × 0.3 KB ≈ 3 KB × 20M/day ≈ 58 GB/day ≈ 23 TB over 13 months. The largest organization adds 30M conversations a month, which is what makes counting and free-text search expensive
- **Export files**: 5K × ≈12 MB ≈ 60 GB/day, ≈420 GB at 7-day retention

### Local Development Scale

| Component | Sizing |
|-----------|--------|
| Seed data | 5 users, 2 organizations (Lumen Outfitters on pro, Harbor Health Co-op on starter), 5 projects (1 restricted), 8 agents, 8 knowledge documents, 8,500 conversations (≈47K messages), 5 prompts, 2 share links, 2 invitations (1 expired), 1 feature flag |
| API | 1 instance on :3000 (`dev:server1..3` for 3001-3003) |
| Export worker | 1 process (`dev:worker2` adds a second), polls every 1 s, 250-row batches with a 120 ms pause so progress is visible |
| Cache and stream | Permission TTL 60 s, heartbeat 20 s |

## High-Level Architecture

```
┌──────────────────────────┐        ┌──────────────────────┐
│ Browser (React console)  │───────▶│ CDN: SPA bundle      │
│ org-scoped query cache   │        └──────────────────────┘
│ one event stream per tab │
└────────────┬─────────────┘
             │ HTTPS: REST + SSE, session cookie
┌────────────▼──────────────────────────────────────────────────────┐
│                    Load balancer / API gateway                    │
│   TLS · per-IP and per-user rate limits · /events → event gateway │
└────────┬───────────────────────────────────────────┬──────────────┘
         │ REST                                      │ SSE
┌────────▼─────────────────────┐        ┌────────────▼─────────────┐
│ Console API (N, stateless)   │        │ Event gateway (M)        │
│ requireOrg gate · manifest   │        │ one subscription per     │
│ authz library · admin writes │        │ instance · routes events │
│ history reads                │        │ by user and by org       │
└──┬──────────┬────────────┬───┘        └────────────┬─────────────┘
   │          │            │                         │
   │          │   ┌────────▼─────────────────────────▼─────────────┐
   │          │   │ Valkey cluster                                 │
   │          │   │ sessions · permission cache · version mirror   │
   │          │   │ pub/sub (evt:org:*, evt:user:*) · rate limits  │
   │          │   └────────▲───────────────────────────────────────┘
   │          │            │ publish export progress
   │ ┌────────▼─────────┐  │  ┌───────────────────────────────┐
   │ │ PostgreSQL       │◀─┼──│ Export workers (K)            │
   │ │ control plane    │  └──│ SKIP LOCKED claim · lease ·   │
   │ │ primary+replicas │     │ access re-check · fenced rows │
   │ └──────────────────┘     └──────┬─────────────────┬──────┘
   │                                 │ read rows       │ upload CSV
┌──▼──────────────────────────────┐  │      ┌──────────▼─────────┐
│ Conversation store              │◀─┘      │ Object storage     │
│ sharded by org · search · OLAP  │         │ short signed URLs  │
└─────────────────────────────────┘         └────────────────────┘
```

| Component | Responsibility |
|-----------|----------------|
| **Browser SPA** | Reads one manifest per organization for every guard and button; keys all server state by organization; aborts and drops the old organization's requests on a switch |
| **Console API** | Stateless REST. Every org route passes the `requireOrg` gate with a declared rule; every query filters by organization and accessible projects |
| **Authz library** | Pure role/plan/flag evaluation plus a PostgreSQL loader and Valkey cache, linked into the API and the workers, so enforcement and the manifest are the same code |
| **Event gateway** | Long-lived SSE connections, one per tab. One Valkey subscription per instance, routed in memory to connections by user and organization |
| **PostgreSQL (control plane)** | Source of truth for organizations, memberships, roles, flags, the authorization version, invitations, links, audit events and export jobs |
| **Conversation store** | History written by the agent runtime; sharded by organization with a search index and analytics rollups. Every read carries the organization and project filter |
| **Valkey** | Sessions (identity only), permission cache, version mirror, event fan-out, rate limits. Losing it loses sessions and hints, never an access decision |
| **Export workers** | Claim jobs from PostgreSQL, re-check the creator's access against PostgreSQL, write the file, publish progress |
| **Object storage** | Export files, handed out as short-lived signed URLs only after an authoritative access check |

## Core Components

### 1. The authorization model

Effective access for one user in one organization combines four inputs, each owned by a different person and each answering a different question:

| Input | Decided by | Question it answers | Stored in |
|-------|------------|---------------------|-----------|
| Role → permissions | Org admin | *May* this person do it? | `org_memberships.role`; the role table is code |
| Plan → entitlements | Billing | *Can* this organization do it at all? | `orgs.plan`; the plan table is code |
| Flag rules → flags | Org admin | Is the feature switched on for this role here? | `feature_flag_rules` |
| Project visibility | Org admin | Which data may this person see? | `projects.restricted`, `project_memberships` |

| Permissions | viewer | editor | admin |
|-------------|:------:|:------:|:-----:|
| `org.read`, `agents.read`, `knowledge.read`, `conversations.read`, `analytics.read`, `prompts.read` | ✓ | ✓ | ✓ |
| `agents.write`, `knowledge.write`, `conversations.export`, `prompts.write`, `prompts.share`, `members.read` | | ✓ | ✓ |
| `agents.delete`, `analytics.cost`, `billing.read`, `members.manage`, `links.manage`, `audit.read`, `features.manage` | | | ✓ |

| Plan | Exports | Cost analytics | Seats | Audit retention |
|------|:-------:|:--------------:|------:|----------------:|
| starter | no | no | 10 | 30 days |
| pro | yes | yes | 100 | 365 days |

Permissions and entitlements are kept apart on purpose. An admin on the starter plan *may* export but the organization *can't*, so the UI says "upgrade" rather than "ask an admin". A flag rule names an organization and a list of roles (empty means every role); without a rule the flag's default applies. Restricted projects are visible to admins and to explicit project members only.

`computeAccess` (`backend/src/shared/permissions.ts`) is a pure function over these inputs. Because it does no I/O, every role × plan × flag-rule combination is tested exhaustively, and the rest of the system only needs one test persona per rule rather than per combination.

### 2. The org gate

Every route under `/api/v1/orgs/:orgId` is declared through `orgRoutes()`, which forces it to state an access rule (`permission`, optional `flag`, `entitlement`, `authoritative`) and records it in a route inventory. A unit test walks the Express stack and fails if any org route was registered without a rule, or if another router mounts a path under `/orgs`.

| Situation | Status | Code | What the client shows |
|-----------|--------|------|-----------------------|
| No session | 401 | `UNAUTHENTICATED` | Sign-in, then back to the same URL with filters and panes |
| Not a member, organization doesn't exist, or malformed ID | 404 | `NOT_FOUND` | A neutral "Organization not found" that doesn't say which |
| Admin previewing as another role tries to write | 403 | `READ_ONLY` | Buttons are already disabled; the API refuses anyway |
| Member, role lacks the permission | 403 | `FORBIDDEN` + `{permission, role, version}` | "Your role doesn't include this", Request access |
| Flag off for this organization and role | 403 | `FEATURE_DISABLED` | "Isn't turned on here" |
| Plan lacks it | 403 | `ENTITLEMENT_REQUIRED` + `{entitlement, plan}` | "Part of the Pro plan", View plans |
| Resource ID from another organization or an inaccessible project | 404 | `NOT_FOUND` | "Doesn't exist, or it's in a project you can't access" |

The checks run in that order: role before flag before plan, matching the client's `decide()`, so a viewer is told about the role and not about the plan. Every org response that got past the membership check carries `X-Org-Id`, `X-Authz-Version` and `Cache-Control: private, no-store`, including the 403s.

The gate is the first of three layers. The second is the query: every handler filters `org_id = $1 AND project_id = ANY($2)` using the project list from the access result, so an ID swapped in from another organization matches no row. The third is the schema: resource tables reference `projects (org_id, id)` through a composite foreign key, so a row cannot point at another organization's project even through a bug in a handler.

### 3. Permission cache and the authorization version

`orgs.authz_version` is a counter bumped in the same transaction as any membership, role or flag change. Cached access entries carry it in their key.

```
read:   GET authz:ver:{org} ──▶ GET perm:{org}:{user}:v{n} ── hit ──▶ use the entry
              │ (absent)                    │ miss
              └─────────────────────────────┴──▶ 3 PostgreSQL queries ──▶ SET-IF-GREATER authz:ver
                                                                          SET perm:…:v{n} EX 60
write / download / export worker ─────────────▶ 3 PostgreSQL queries (cache not consulted)

change: BEGIN ─ change ─ authz_version + 1 ─ audit row ─ COMMIT
        └─▶ SET-IF-GREATER authz:ver:{org} ─▶ PUBLISH authz.changed (+ user events)
```

Properties that follow from this shape:

1. **Old entries become unreachable at once.** After the mirror moves to `v{n+1}`, lookups build a new key; nothing has to find and delete the old entries.
2. **No stale-label race.** The loader reads `authz_version` and the role in the same statement; the project and flag queries run after it and can only see the same or newer state. An entry is never older than its label. A slow loader that read version 7 cannot roll the mirror back after a change set it to 8, because the Lua script only moves it forward.
3. **Lost mirror writes heal.** If the post-commit mirror write fails, the next miss reads the higher version from PostgreSQL and repairs it. Until then the 60 s TTL bounds staleness, for reads only.
4. **Writes never trust the cache.** Every non-GET request, every download and every export worker step recomputes from PostgreSQL. A demoted admin's next write is refused even while an old entry is still reachable.
5. **Valkey failure degrades to PostgreSQL** for access checks; cache errors are logged and ignored.

Admin previews use a separate key suffix (`:as-{role}`), so they never share an entry with the real role.

### 4. The manifest

`GET /orgs/:orgId/manifest` returns the organization, role, actual role, read-only flag, permissions, entitlements, flags, visible projects and version. It is built from the same `EffectiveAccess` object that `requireOrg` enforces with, so the UI and the API cannot disagree about what a role may do.

On the client, `lib/modules.ts` holds one module registry. Each module declares its requirement (`{permission, flag?, entitlement?}`), and `decide(manifest, requirement)` returns allowed, or denied with a reason:

| Reason | Sidebar | Deep link (`ModuleGate`) | Buttons |
|--------|---------|--------------------------|---------|
| `permission` | Hidden | Forbidden page: role, Request access, other organizations | Hidden |
| `flag` | Hidden | "Isn't turned on here" | Hidden |
| `entitlement` | Shown with a lock | "Part of the Pro plan", View plans | Disabled with an explanation |
| Lost while the page was open | Removed | `AccessChanged`: what changed and when; unsaved text kept where possible | Hidden or read-only |

Some data is shaped by permission on the server rather than hidden in the browser: member emails require `members.manage`, cost series in analytics require `analytics.cost` and the cost-analytics entitlement and are absent, not zero, without them.

### 5. The event stream

Each tab opens one SSE stream, `GET /api/v1/events`, that serves every organization the user belongs to and survives organization switches. Each gateway instance holds one Valkey connection subscribed to `evt:org:*` and `evt:user:*`, plus two in-memory indexes (connections by user and by organization). A connection receives an organization's events only while its user is a member there.

| Event | Channel | Sent when | Client action |
|-------|---------|-----------|---------------|
| `hello` | direct | Connect and every reconnect | Refetch any held manifest whose version is behind |
| `versions` | direct | Every heartbeat (20 s) | Same as `hello` |
| `authz.changed` | org | Any version bump | Record the reason; refetch the manifest if behind |
| `role.changed` | user | Role change | Record from/to for the explanation; refresh the org list; toast |
| `access.revoked` | user | Removal, or the heartbeat found the membership gone | Mark revoked; remove every `['org', id]` query; show "no longer have access" |
| `membership.added` | user | Accepted invitation | Refresh the org list; toast |
| `export.progress` / `completed` / `failed` | user | Export worker | Patch the cached job; toast with Download |
| `session.revoked` | user | Last membership removed, or the session is gone | Sign-in page with the reason |

Events are invalidation hints, never data. The client never applies a permission from an event; it refetches the manifest. That is why frames carry no SSE IDs and nothing is replayed: a client that missed events converges from the `hello` versions on reconnect, from the `versions` heartbeat, from the `X-Authz-Version` header on any response, or from a 403, which also triggers a manifest refetch.

The heartbeat is also the backstop for lost pub/sub messages. Every 20 s each connection checks that its session still exists and reloads the user's memberships from PostgreSQL; organizations the user has left are revoked on that connection.

### 6. Removing a member

Removal takes away everything that could outlive the membership, in one transaction (`backend/src/api/services/membership.ts`):

| What could outlive the membership | Handling |
|-----------------------------------|----------|
| Organization and project memberships | Deleted |
| Pending invitations the member sent, or addressed to their email | `revoked_at = now()` |
| Share links the member created | `revoked_at`, `revoked_by`; the link lookup also refuses links whose creator is no longer a member |
| Export jobs | Queued → `cancelled` (`ACCESS_REVOKED`); running → `cancel_requested_at`, and the worker stops at its next batch |
| Cached permission sets | Version bump in the same transaction |
| Audit trail | `member.removed` with the counts above |
| Sessions (after commit) | If no memberships remain: delete every session in the `usess:{user}` index and send `session.revoked`, which also closes the user's streams |
| Open event streams (after commit) | `access.revoked` to the user's remaining connections, sent after `session.revoked` so a tab being signed out shows that reason; the heartbeat reconcile catches a lost message |

The last admin cannot be removed or demoted. The check locks every admin row of the organization (`FOR UPDATE`), so two admins demoting each other at once cannot both pass it; the loser gets `409 LAST_ADMIN`.

### 7. Invitations and share links

- **Invitations**: a 192-bit random token, stored as a SHA-256 hash; the accept URL is shown once to the admin who created it. It expires after 7 days, is single-use (`accepted_at`, row locked on accept) and only works for a signed-in user whose email matches (`403 INVITATION_EMAIL_MISMATCH`), so a forwarded invitation lets nobody else in. Seats are an entitlement that counts members plus pending invitations; the organization row is locked while counting, so concurrent invitations cannot exceed the limit
- **Share links**: a read-only bearer grant on one prompt. The token is stored as a SHA-256 hash with a 4-character hint for the admin list; the raw token is returned once. Expiry is 1-90 days or none. Revocation is a timestamp, never a delete, so the audit trail and "this link was revoked" both keep working. The public lookup is never cached: unknown tokens are `404`, revoked or expired ones (or ones whose creator left) are `410`
- **Prompt visibility** in the library is a `WHERE` clause (owner, or the caller's role is in `shared_roles`, within accessible projects), so a list can never contain a prompt the caller can't open. Only the owner edits or creates links. Revoking a link needs `prompts.share` but no flag, so switching the library off never stops anyone revoking what was already shared

### 8. Conversation history at scale

- **Keyset pagination** on `(started_at DESC, id DESC)` with an opaque base64url cursor. New conversations arriving at the top never shift later pages, and each page is an index range scan regardless of depth. A tampered cursor is `400 INVALID_CURSOR`
- **Filters in the URL** (`status`, `channel`, `agentId`, `q`, `from`, `to`). The client normalizes them so equal filters always produce equal query keys and malformed values are dropped, not sent
- **Capped count**: only the first page counts matches, and stops at 10,001, so the table says "10,000+" instead of scanning millions of rows to print a number
- **One query builder** (`shared/conversation-query.ts`) used by the list endpoint and the export worker, with the organization and accessible projects always as the first two conditions; an export contains exactly what the table shows, and a `projectId` filter is ANDed with the access list, so it can narrow but never widen
- **Client**: `useInfiniteQuery` plus `@tanstack/react-virtual` keeps only visible rows in the DOM and fetches the next page when the user scrolls within 25 rows of the end. A deep link `/orgs/:id/conversations/:cid?filters` opens the detail pane over the filtered list; the pane fetches its conversation independently, so it opens even when the row is not in the loaded pages

### 9. Exports

```
                        claim (SKIP LOCKED, 30 s lease)
POST /exports ─▶ queued ───────────────────────▶ running ──────────────────────▶ completed
                   │ cancel / removal            ├─ cancel seen at next batch ──▶ cancelled
                   ▼                             ├─ access lost ────────────────▶ failed (ACCESS_REVOKED)
               cancelled                         ├─ lease expired ──────────────▶ re-claimed, restarts (≤ 3 attempts)
                                                 └─ lease expired, 3rd attempt ─▶ failed (WORKER_LOST, by the sweeper)
```

The `export_jobs` row is the queue and the state. Creation is idempotent per (organization, user, `Idempotency-Key`). A worker claims the oldest runnable job with `FOR UPDATE SKIP LOCKED`, renews its lease with every batch, and conditions every write on `worker_id = $me AND status = 'running'`, so a worker whose lease expired cannot overwrite the one that took over. The creator's access is recomputed from PostgreSQL when the job starts and again right before the file is published; a download re-checks a third time. Cells starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` so a customer-written subject cannot run as a spreadsheet formula.

### 10. Organization scoping in the client

| Layer | Mechanism | File |
|-------|-----------|------|
| URL | The organization ID is a path segment; switching is a navigation | `routes/orgs.$orgId.tsx` |
| Query keys | Every key starts with `['org', orgId]` | `lib/keys.ts` |
| In-flight requests | The route's `beforeLoad` cancels the old organization's queries and aborts one `AbortController` per organization visit | `lib/org-switch.ts`, `lib/org-scope.ts` |
| Late responses | After every org request, `assertStillActive` throws `StaleOrgResponse` if the user moved on; it is never retried | `services/api.ts`, `lib/query-client.ts` |
| Server echo | `X-Org-Id` must match the requested organization | `services/api.ts` |
| Placeholder rows | The previous page is shown during a filter change only if it belongs to the same organization | `ConversationTable.tsx` |
| Component state | The organization layout is keyed by organization ID, so no open form or selection survives a switch | `routes/orgs.$orgId.tsx` |
| Revocation | `removeQueries(['org', id])` | `services/events.ts` |
| Sign-in and sign-out | `queryClient.clear()` | `stores/auth-store.ts` |

The switcher keeps the current module and drops filters and resource IDs, which belong to the old organization; if the new role doesn't allow the module, its guard explains.

## Request Flows

### Successful trace: a deep link, the detail pane and an export

Ben (editor in Lumen Outfitters, member of the restricted VIP project) opens a link to an escalated conversation and exports the filtered list.

1. **Router**: `/orgs/org_lumen/conversations/<cid>?status=escalated`. The org route's `beforeLoad` runs `switchOrg('org_lumen')`, which activates a fresh abort scope before any page mounts.
2. **Org layout** requests `['org', 'org_lumen', 'manifest']`.
3. **API gate**: the session (identity only) comes from Valkey; `GET authz:ver:org_lumen` returns 7 and `perm:org_lumen:<ben>:v7` is a hit (on a miss: three PostgreSQL queries, then the entry is written for 60 s). The response carries `X-Org-Id: org_lumen` and `X-Authz-Version: 7`.
4. **ModuleGate** evaluates `conversations.read` against the manifest: allowed. The table and the detail pane fetch in parallel under their own org-scoped keys.
5. **List endpoint**: same gate (cache hit), then the shared builder produces `org_id = $1 AND project_id = ANY($2) AND status = $3` with Ben's three projects; PostgreSQL walks `conversations_org_status_started` for 101 rows and counts up to 10,001 matches. The response has 100 rows, `nextCursor` and `total`.
6. **Detail endpoint**: `id = $1 AND org_id = $2 AND project_id = ANY($3)`, plus the transcript. `costCents` is omitted because editors lack `analytics.cost`.
7. **Browser**: the virtualizer renders about 25 rows; scrolling near the end requests the next page by cursor.
8. **Export**: the button generates an `Idempotency-Key` and keeps it until the request succeeds. `POST /exports` is a write, so the gate recomputes from PostgreSQL, checks `conversations.export` and the `exports` entitlement, then one transaction inserts the job (`ON CONFLICT DO NOTHING`) and the `export.created` audit row. `202`. If that response is lost, the retry with the same key returns `200` with `Idempotent-Replayed: true` and the same job.
9. **Worker** claims the job (lease 30 s, attempt 1), recomputes Ben's access from PostgreSQL, counts the rows, and writes 250-row batches with the shared builder. After each batch a fenced update renews the lease, stores progress and returns `cancel_requested_at`; then it publishes `export.progress` on `evt:user:<ben>`.
10. **Event gateway**: every instance receives the message; the one holding Ben's stream finds it in its user index, confirms the connection still belongs to `org_lumen`, and writes the frame. The client patches the cached job and the header shows "Exporting… 40%".
11. **Completion**: the worker re-checks access, renames the temporary file, and marks the job completed with a fenced update that also requires no cancel request; then `export.completed`. The toast's Download link calls `GET /exports/:id/download`, which re-checks permission and entitlement against PostgreSQL before streaming the file with `Cache-Control: private, no-store`.

### Failed trace: Ben is removed while the conversations page is open and his export is running

1. **Alice** (admin) clicks Remove on Ben in Settings → Members: `DELETE /orgs/org_lumen/members/<ben>`. The gate recomputes Alice's access from PostgreSQL: `members.manage` is present.
2. **Transaction**: lock Ben's membership row; delete his organization and project memberships; revoke pending invitations he sent; revoke his share link; set `cancel_requested_at` on his running export; bump `authz_version` 7 → 8; write `member.removed` with the counts. Commit. From this moment every write and download from Ben is refused (404), because those paths read PostgreSQL.
3. **After commit, on Alice's API instance**: the mirror moves to 8, so Ben's `v7` entry is unreachable and his cached reads also go to PostgreSQL (404). It publishes `authz.changed` to the organization. Ben has no other organization, so every session in `usess:<ben>` is deleted and `session.revoked` is published, then `access.revoked`. Alice gets `{removed: true, linksRevoked: 1, exportsCancelled: 1, sessionsEnded: 1}`.
4. **Ben's event gateway instance** (possibly another one): forwards `authz.changed`; on `session.revoked` it forwards and closes the stream, so the `access.revoked` that follows finds no connection. Had Ben kept another organization, his session and stream would survive, and `access.revoked` would remove `org_lumen` from the connection and be forwarded.
5. **Ben's tab**: `authz.changed` starts a manifest refetch, which may already get a 401 and set a generic "session ended" message; `session.revoked` replaces it with "Your access was removed, so you were signed out." The root layout navigates to sign-in, so nothing renders Lumen's cached rows, and the next sign-in clears the query cache. With Harbor left, `access.revoked` would instead remove every `['org', 'org_lumen']` query and the layout would show "You no longer have access to Lumen Outfitters" with a link to switch to Harbor.
6. **Ben's in-flight next-page request**: either aborted as the page unmounts or answered 401 (no session) or 404 (no membership); nothing on the sign-in page reads it.
7. **Worker**: at the next batch boundary the fenced heartbeat returns `cancel_requested_at`; the worker re-checks Ben's access, finds no membership, deletes its temporary file and records `failed` / `ACCESS_REVOKED` (a cancel the user asked for would end as `cancelled`). Had the loop already finished, the pre-publish access check would have found the same and published no file. Its final event to Ben goes nowhere: his stream is closed (or, with another organization left, no longer subscribed to Lumen's events).
8. **Anyone opening Ben's share link** gets `410 LINK_REVOKED`.
9. **If step 3 partly failed**: a lost mirror write leaves cached reads open for at most 60 s, and only to a session that still exists; a lost `access.revoked` is caught by the heartbeat within 20 s; a failed session deletion leaves a session that can no longer reach Lumen, because every org request checks membership.

## Database Schema

PostgreSQL (`backend/src/db/init.sql`; formatting condensed, every constraint and index kept):

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE orgs (
  id            TEXT PRIMARY KEY CHECK (id ~ '^org_[a-z0-9]{3,32}$'),
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'pro')),
  branding      JSONB NOT NULL DEFAULT '{"accent": "indigo", "initials": "??"}',
  authz_version BIGINT NOT NULL DEFAULT 1,  -- bumped with every membership, role or flag change
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, restricted BOOLEAN NOT NULL DEFAULT false,  -- restricted: admins + project members
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)                       -- target of the composite foreign keys
);
CREATE INDEX projects_org ON projects (org_id);

CREATE TABLE org_memberships (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_memberships_user ON org_memberships (user_id);

CREATE TABLE project_memberships (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, user_id)
);

CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,          -- sha256; the raw token is never stored
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL, expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ, accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_pending ON invitations (org_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE feature_flags (key TEXT PRIMARY KEY, description TEXT NOT NULL, default_enabled BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE feature_flag_rules (
  flag_key TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL, roles TEXT[] NOT NULL DEFAULT '{}',  -- empty roles = every role
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (flag_key, org_id)
);

-- Resources: org_id + project_id + owner, and a composite FK to projects (org_id, id).
-- knowledge_docs (title, source IN ('upload','url','helpdesk'), chunks, status IN ('indexing','indexed','failed'))
-- and prompts (title, body, shared_roles TEXT[] -- empty = private) follow the agents pattern,
-- indexed on (org_id, project_id) and (org_id, updated_at DESC) respectively.
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL, owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL, model TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);
CREATE INDEX agents_org_project ON agents (org_id, project_id);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL, agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('chat', 'email', 'voice')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'escalated')),
  customer_name TEXT NOT NULL, subject TEXT NOT NULL, message_count INT NOT NULL DEFAULT 0,
  csat SMALLINT CHECK (csat BETWEEN 1 AND 5), cost_cents INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);
CREATE INDEX conversations_org_started ON conversations (org_id, started_at DESC, id DESC);
CREATE INDEX conversations_org_status_started ON conversations (org_id, status, started_at DESC, id DESC);

CREATE TABLE conversation_messages (
  id BIGSERIAL PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,                     -- repeated so transcript reads filter by org too
  author TEXT NOT NULL CHECK (author IN ('customer', 'agent', 'human')),
  body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX conversation_messages_conversation ON conversation_messages (conversation_id, created_at);

CREATE TABLE share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('prompt')),
  resource_id UUID NOT NULL,                -- joined together with org_id on lookup
  token_hash TEXT NOT NULL UNIQUE, token_hint TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ, revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX share_links_org ON share_links (org_id, created_at DESC);
CREATE INDEX share_links_creator_active ON share_links (org_id, created_by) WHERE revoked_at IS NULL;

CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL, actor_name TEXT NOT NULL,
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, target_name TEXT,
  before JSONB, after JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org ON audit_events (org_id, id DESC);

CREATE TABLE export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('conversations')), query JSONB NOT NULL, idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
         CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_rows INT, processed_rows INT NOT NULL DEFAULT 0,
  file_path TEXT, file_bytes BIGINT, error_code TEXT, error_message TEXT,
  attempts INT NOT NULL DEFAULT 0, worker_id TEXT, leased_until TIMESTAMPTZ,  -- lease + fencing
  cancel_requested_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  UNIQUE (org_id, created_by, idempotency_key)
);
CREATE INDEX export_jobs_claimable ON export_jobs (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX export_jobs_org_user ON export_jobs (org_id, created_by, created_at DESC);
```

Every tenant-owned table carries `org_id`, and every tenant-owned query filters on it. The partial index on claimable exports stays small however many finished jobs accumulate. `conversations.agent_id` is a plain foreign key: conversations are written by the agent runtime, not the console, so it is not covered by the composite-key guarantee.

### Valkey keys

| Key | Type | Purpose | Lifetime |
|-----|------|---------|----------|
| `session:{id}` | String (JSON) | User identity, plus an admin preview role if set. Never a role or an organization | 7 days |
| `usess:{userId}` | Set | The user's session IDs, so all of them can be ended | 7 days |
| `authz:ver:{orgId}` | String | Mirror of `orgs.authz_version`, moved forward only by a Lua script | 24 h |
| `perm:{orgId}:{userId}:v{n}[:as-{role}]` | String (JSON) | Effective access computed at version `n` | 60 s |
| `evt:org:{orgId}`, `evt:user:{userId}` | Pub/sub channels | Invalidation hints | - |
| `ratelimit:login:{ip}:{window}` | Counter | Fixed-window login limit | Window + 1 s |

## API Design

All routes are under `/api/v1`. Errors are `{ "error": { "code", "message", "details" } }`. Org-scoped routes list their access rule.

```
POST   /auth/login | /auth/logout | GET /auth/me      → Session cookie; user + organizations (20 logins/min/IP)
GET    /events                                         → SSE stream for the tab (all organizations)
GET    /invitations/:token                             → Invitation preview (no session)
POST   /invitations/:token/accept                      → Join; email must match; 410 once used, revoked or expired
GET    /shared/:token                                  → Shared prompt (no session); 404 unknown, 410 revoked/expired

/orgs/:orgId …                                         rule: permission [+ flag] [+ entitlement]
GET    /manifest                                       member
POST   /preview                                        member, allowed while previewing (handler requires admin)
GET    /overview                                       org.read
POST   /access-requests                                member (recorded in the audit log)
GET    /agents, /agents/:id                            agents.read
POST   /agents · PATCH /agents/:id · DELETE …          agents.write · agents.write · agents.delete
GET    /knowledge · POST /knowledge                    knowledge.read · knowledge.write
GET    /conversations?status&channel&agentId&projectId&q&from&to&cursor&limit   conversations.read
GET    /conversations/:id                              conversations.read
GET    /analytics?days                                 analytics.read (cost needs analytics.cost + costAnalytics)
GET    /prompts, /prompts/:id                          prompts.read + prompt_library
POST   /prompts · PATCH /prompts/:id                   prompts.write + prompt_library (sharing needs prompts.share)
POST   /prompts/:id/links                              prompts.share + prompt_library (owner only)
DELETE /links/:id                                      prompts.share (creator, or links.manage)
GET    /links                                          links.manage
GET    /members · PATCH|DELETE /members/:userId        members.read · members.manage (409 LAST_ADMIN)
GET|POST /invitations · DELETE /invitations/:id        members.manage (seats entitlement, 409 ALREADY_MEMBER)
GET    /audit?action&before&limit                      audit.read (window = plan retention)
GET    /features · PUT /features/:flagKey              features.manage
GET    /billing                                        billing.read
GET    /exports, /exports/:id                          conversations.export (admins: all; others: their own)
POST   /exports                                        conversations.export + exports; Idempotency-Key required
POST   /exports/:id/cancel                             conversations.export
GET    /exports/:id/download                           conversations.export + exports; authoritative

GET /health · GET /ready (PostgreSQL + Valkey) · GET /metrics
```

**The manifest** (Ben in Lumen):

```http
GET /api/v1/orgs/org_lumen/manifest

HTTP/1.1 200 OK
X-Org-Id: org_lumen
X-Authz-Version: 7
Cache-Control: no-store

{ "manifest": {
    "org": { "id": "org_lumen", "name": "Lumen Outfitters", "plan": "pro", "branding": { "accent": "teal", "initials": "LO" } },
    "role": "editor", "actualRole": "editor", "readOnly": false,
    "permissions": ["org.read", "agents.read", "knowledge.read", "conversations.read", "analytics.read", "prompts.read",
                    "agents.write", "knowledge.write", "conversations.export", "prompts.write", "prompts.share", "members.read"],
    "entitlements": { "exports": true, "costAnalytics": true, "seats": 100, "auditRetentionDays": 365 },
    "flags": { "prompt_library": true },
    "projects": [ { "id": "…", "name": "Returns desk", "restricted": false }, …,
                  { "id": "…", "name": "VIP concierge", "restricted": true } ], "version": 7 } }
```

**A role denial and a plan denial are different answers:**

```http
POST /api/v1/orgs/org_lumen/agents            (Dev, viewer)
HTTP/1.1 403 Forbidden
{ "error": { "code": "FORBIDDEN", "message": "Your role (viewer) doesn't include this.",
             "details": { "role": "viewer", "version": 7, "permission": "agents.write" } } }

POST /api/v1/orgs/org_harbor/exports          (Chloe, admin on starter)
HTTP/1.1 403 Forbidden
{ "error": { "code": "ENTITLEMENT_REQUIRED", "message": "The starter plan doesn't include this.",
             "details": { "role": "admin", "version": 4, "entitlement": "exports", "plan": "starter" } } }
```

A history page returns `{ items, nextCursor, total }`, where `total` (first page only) is `{ count, capped }` and `nextCursor` is the base64url `[started_at, id]` of the last row.

**The event stream:**

```
retry: 3000

event: hello
data: {"type":"hello","orgs":[{"orgId":"org_lumen","version":7}]}

event: authz.changed
data: {"type":"authz.changed","orgId":"org_lumen","version":8,"reason":"member_removed"}

event: access.revoked
data: {"type":"access.revoked","orgId":"org_lumen","orgName":"Lumen Outfitters","reason":"removed"}
```

Creating an export with a key already used for the same filters returns `200` with `Idempotent-Replayed: true`; the same key with different filters returns `422 IDEMPOTENCY_KEY_REUSED`.

## Key Design Decisions

### 1. Enforce in the gate and in every query, not in the UI or with row-level security

**Chosen:** a declared rule per route (`requireOrg`), an organization and project filter in every query built from the access result, and composite foreign keys underneath.

**Why it works here:** the dangerous bugs in a multi-tenant console are IDORs, where a valid ID from organization B is used in a path for organization A. A gate alone doesn't stop them, because the user really is a member of A. The query filter does, since B's row doesn't match `org_id = A`. Project visibility is per user, so it has to be part of the query anyway, and putting the organization in the same `WHERE` costs nothing. The route inventory test turns "someone forgot the check on a new route" into a failing build.

**Why the alternatives fail:** hiding buttons is not enforcement; any API client bypasses it. PostgreSQL row-level security is a strong backstop for the organization boundary, but it needs a session variable set per transaction (awkward with transaction-pooling proxies), the per-user project list makes policies slow and hard to read, and the export worker and admin queries need a bypass role. That bypass is exactly where a leak would come from.

**Cost:** every handler author must use the access result in the query. The shared query builder and the IDOR integration tests are what keep that true. RLS on `org_id` alone stays a reasonable later hardening step.

### 2. Version-keyed permission cache, short TTL, authoritative writes

**Chosen:** cache effective access under `perm:{org}:{user}:v{authz_version}` for 60 s; bump the version in the same transaction as the change; recompute from PostgreSQL for every write, download and export step.

**Why it works here:** reads are about 95% of traffic, and each needs role, flags, plan and project list: three queries per request without a cache. Changes are rare (under 1/s) but must take effect quickly. A version in the key makes invalidation a single counter increment that commits atomically with the change, and makes old entries unreachable without finding them.

**Why the alternatives fail:** deleting entries on change means enumerating every member's keys, and it races: a reader that loaded the old role just before the commit writes it back just after the delete, and the stale entry lives for a full TTL. A JWT carrying roles is worse: the role is frozen until the token expires, which is exactly the revocation problem. No cache at all puts ≈5K queries/s on PostgreSQL at peak for data that changes a few times a minute.

**Cost:** a lost mirror write leaves reads up to 60 s stale (writes stay correct), and an organization-wide version means one change invalidates every member of that organization, which is the burst in Capacity Estimation.

### 3. One server-computed manifest for routes, sidebar and buttons

**Chosen:** the server returns the effective permissions, flags, entitlements and projects for the current organization; one client function, `decide()`, reads it for every guard, sidebar entry and button.

**Why it works here:** the follow-ups that hurt in practice are inconsistencies: a sidebar link that leads to a 403, a button that appears for a role the API refuses, a deep link that shows a blank page. When the manifest is computed by the enforcement code, they can only disagree if the manifest is stale, and staleness is detectable because the manifest carries the version that every response also carries.

**Why the alternatives fail:** shipping the role table to the client means two copies of the policy, which drift the first time someone adds a permission. Asking the server per button ("can I do X?") multiplies requests and still gives no single version to compare against.

**Cost:** one extra request per organization visit, and the client must handle the manifest changing underneath an open page, which is where `AccessChanged` and the read-only editor come from.

### 4. Events are hints; versions are the truth

**Chosen:** SSE events that say "something changed", a version number in every response, the `hello` frame and every heartbeat, and a manifest refetch whenever the held version is behind.

**Why it works here:** Valkey pub/sub delivers at most once. A dropped message cannot be allowed to leave a removed user looking at data. With hints, a lost event costs one heartbeat interval at worst, and a client that reconnects to another instance converges from `hello` without replay. Revocation also does not depend on the stream: the server refuses on the next request regardless.

**Why the alternatives fail:** events that carry the new permission set make the client trust whatever arrives last, and out-of-order delivery across channels could apply an older set after a newer one. A durable per-user event log (Streams with replay) adds storage and offset tracking for state that a single manifest fetch reproduces. Polling the manifest alone would need a short interval for every tab, all the time, to match the push latency. WebSockets add nothing because the data flows one way.

**Cost:** a refetch per change per open tab (the version-bump burst), and the heartbeat reconcile query per connection.

### 5. Authorization as an in-process library, not a separate policy service

**Chosen:** `permissions.ts` (pure rules) plus `access.ts` (loader and cache) linked into the API and the workers.

**Why it works here:** the model is small: three fixed roles, two plans, one flag dimension, one restriction level. The enforcement point needs more than a yes/no answer; it needs the list of accessible projects to put into SQL. An in-process library returns both with a cache hit and no network hop.

**Why the alternatives fail at this size:** a Zanzibar-style service (relationship tuples, consistency tokens) or a policy engine adds a network call per request and an extra system to keep available, and the console would still need it to return project lists for filtering. It earns its cost when roles become custom per organization, when access is granted per resource on millions of objects, or when several products must share one authorization model. The `authz_version` already plays the part of a consistency token, which keeps that migration open.

**Cost:** the role table is code; changing it means a deploy, and custom roles are not possible.

### 6. The export job row is the queue

**Chosen:** `export_jobs` in PostgreSQL, claimed with `FOR UPDATE SKIP LOCKED`, with a lease and fenced writes.

**Why it works here:** at 5K exports a day the queue sees well under one job per second. Creating the job, its idempotency record and its audit row in one transaction makes "accepted" mean "will run" with no dual write. The same row carries status, progress and the lease, so recovery is a query.

**Why the alternative fails:** a broker such as RabbitMQ or SQS needs the job row anyway (for status, progress and idempotency), so enqueueing becomes a second write that can fail after the commit. That needs an outbox to fix, which is a polling loop over PostgreSQL again.

**Cost:** workers poll (1 s locally). At much higher volume a broker could act as a doorbell in front of the same table, with PostgreSQL still deciding ownership.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Membership, role, flag change | Atomic with the version bump and the audit row | One transaction; notifications only after commit |
| The actor's next read | Sees the change | The mirror is updated and events published before the response returns |
| Last admin | An organization always has one | `FOR UPDATE` on every admin row; `409 LAST_ADMIN` |
| Seat limit | Not exceeded by concurrent invitations | Organization row locked while counting members + pending invitations |
| Version mirror | Never moves backwards | Lua set-if-greater |
| Role change to the current role | No-op | Returns without a bump or audit row |
| Create export | One job per key per (organization, user) | `UNIQUE (org_id, created_by, idempotency_key)`, `ON CONFLICT DO NOTHING`; 200 replay or 422 |
| Run export | One owner at a time; one outcome | `SKIP LOCKED` claim, 30 s lease, writes fenced on `worker_id` and `status = 'running'` |
| Publish export file | Only if access still holds | Authoritative re-check before rename; final update requires no cancel request |
| Accept invitation | Single use | Invitation row locked; `accepted_at`; `ON CONFLICT` on the membership |
| Revoke link or invitation | Idempotent | Timestamp set once; revoking a revoked link returns 204 |
| History pages | No duplicates or gaps as rows arrive | Keyset on `(started_at, id)` |
| Client manifest | Never moves backwards | Refetch only when the held version is lower; the watcher ignores versions not above the last |
| Create invitation | One pending invitation per address; a retry gets `409 INVITATION_PENDING` | Two live tokens for one person can't exist |
| Create agent, prompt or link | Not idempotent; a retry creates a second one | Accepted for low-stakes creates (see Known gaps) |

## Access Changes: What Is Invalidated, What Stays Authoritative

This answers the roadmap's key question directly.

**Cached state that must change when access changes:**

| Cached state | Where | Invalidated by | Worst-case staleness |
|--------------|-------|----------------|----------------------|
| Effective access entries | Valkey `perm:*` | Version bump; mirror moved after commit | 0 after the mirror moves; 60 s if the mirror write is lost |
| Version mirror | Valkey `authz:ver:*` | Set-if-greater after commit; repaired by the next miss | Until the next miss |
| Sessions | Valkey `session:*` | Deleted when the last membership goes | None needed: sessions hold no authorization |
| Stream membership | Event gateway memory | `access.revoked`; heartbeat reconcile from PostgreSQL | 20 s if the event is lost |
| Manifest | Browser query cache | `authz.changed`, `versions`, `hello`, any response with a newer `X-Authz-Version`, any 403 | One heartbeat if every push is lost |
| Organization data | Browser query cache | Removed entirely on `access.revoked`; on `session.revoked` nothing renders it and the next sign-in clears it | None after the event; on any version rise every other query for the org is refetched, so rows and fields the new role doesn't get disappear |
| Open pages and forms | React tree | Guards re-evaluate the new manifest; lost modules show `AccessChanged` | Same as the manifest |
| Issued download URLs | Object storage (production) | Expire on their own | Their lifetime, so it is kept to about a minute |

**Checks that stay authoritative before any of that completes:** every write (any non-GET org request), every file download, the export worker at start and before publishing, invitation acceptance, share-link lookups (never cached, and creator membership checked), and the membership query inside every gate miss. Between the commit and the end of invalidation, a removed or demoted user can at most read for the remaining TTL of an entry that the lost-mirror case left reachable. They can never write, download, export, accept, or keep a share link alive.

## Security / Auth

- **Sessions**: an opaque 256-bit ID in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production), 7-day TTL, stored in Valkey. A session identifies the user only, so no authorization decision can come from a stale session. `SameSite=Lax` plus JSON bodies blocks cross-site form posts
- **Tenant isolation**: the three layers in Core Components §2; malformed organization and resource IDs are 404 before they reach SQL; IDOR attempts across two real organizations are an integration test suite
- **404 versus 403**: a non-member gets the same 404 as for an organization that doesn't exist, so organization IDs reveal nothing. A member gets a 403 that names the missing permission, flag or entitlement, because hiding the reason from someone who belongs there only produces support tickets
- **Server-side shaping**: member emails only with `members.manage`; costs only with `analytics.cost` (and, in analytics, the plan entitlement). Every org-scoped response is `Cache-Control: private, no-store`, so tenant data never sits in a shared or browser cache for the next person at the desk
- **Bearer tokens**: invitations and share links are 192-bit random tokens stored as SHA-256 hashes, shown once; invitations are bound to an email and single-use; share-link responses are `Cache-Control: no-store`
- **Exports**: CSV formula injection defused; downloads are `private, no-store` and re-check access against PostgreSQL
- **Admin preview**: stored on the session, keyed separately in the cache, and every write while it lasts is `403 READ_ONLY`
- **Input**: zod schemas with `.strict()`, 128 KB JSON limit, login limited to 20/min/IP, sign-in redirects limited to same-origin paths
- **Audit**: written in the same transaction as the change, with before/after values; readable for the plan's retention window

## Observability

**Prometheus metrics** (`backend/src/shared/metrics.ts`, `/metrics` on the API):

| Metric | Type | Use |
|--------|------|-----|
| `http_request_duration_seconds{method,route,status}` | Histogram | Latency by route pattern; the organization segment is normalized to `/orgs/:orgId` to bound cardinality |
| `console_permission_cache_total{result}` | Counter | `hit`, `miss`, `authoritative`. Hit ratio, and the miss spike after each version bump |
| `console_authz_denials_total{status,code}` | Counter | 401/403/404 by code. A jump in `FORBIDDEN` after a deploy means the UI offers something the API refuses; a 404 spike from one user suggests ID probing |
| `console_sse_connections` | Gauge | Open streams per instance |
| `console_exports_finished_total{status}` | Counter | Completed, failed, cancelled; served on the worker's own `/metrics` (port 3300) |

**Logs**: Pino JSON with a `service` field (`api`, `worker`). Request logs record method, URL and status only; the event stream, `/health` and `/metrics` are excluded. Worker lines carry `exportId` and `orgId`.

**Health**: `/health` (liveness) and `/ready` (PostgreSQL + Valkey).

**Suggested alerts**: cache hit ratio below 80% for 10 minutes; `FORBIDDEN` rate doubled after a deploy; oldest queued export older than 2 minutes; any `WORKER_LOST`; an instance whose stream count drops to zero while others hold thousands.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Valkey down | Access checks fall back to PostgreSQL, but sessions live in Valkey, so requests fail until it returns; production runs a replicated cluster with persistence |
| Mirror write lost after commit | Reads may use the previous entry for up to 60 s; the next miss repairs the mirror; writes unaffected |
| API crashes between commit and notifications | Same as above, plus no events; the next heartbeat's `versions` frame prompts refetches and the reconcile revokes stream membership |
| Pub/sub message lost | Heartbeat reconcile and `versions` (≤20 s); `X-Authz-Version` on every response; 403 triggers a manifest refetch |
| Event stream drops | `EventSource` reconnects after 3 s to any instance and gets a fresh `hello`; on error the client calls `/auth/me` to tell a network blip from a 401 |
| Export worker crashes | Lease expires after 30 s; another worker re-claims and restarts from the beginning; after 3 attempts the sweeper fails the job (`WORKER_LOST`) |
| Stalled worker resumes after a takeover | Its next fenced update matches zero rows, so it stops and deletes its own temporary file; files are named per attempt, so it never touches the new owner's |
| Worker shutdown | Stops claiming; a job in progress keeps its lease until it expires and is then re-claimed |
| Export file missing at download | `410 EXPORT_EXPIRED`, with a prompt to run it again |
| Lost `export.completed` event | The indicator shows progress until the exports list refetches; the job row is the truth |
| Session expires mid-task | 401 → sign-in → back to the same URL with filters and the open pane |

## Scalability Considerations

- **Console API**: stateless; scale horizontally behind the gateway.
- **What breaks first, for users**: history search in the largest organization. Unfiltered pages and status filters are index range scans on `(org_id, [status,] started_at, id)`, but `q` is `ILIKE '%…%'`, which no B-tree serves. A rare term scans the organization's whole range looking for matches, and at 30M conversations a month the count cap doesn't help when matches are scarce. The fix is a search index whose documents carry `org_id` and `project_id`, queried with those filters and a bounded date range, with results re-validated against the store.
- **What breaks first, for the fleet**: the per-connection heartbeat reconcile, one PostgreSQL query per stream every 20 s (≈1,500 queries/s at 30K tabs, regardless of activity). Batch it per instance (one `user_id = ANY($1)` query per interval) and compare versions from the Valkey mirror first, touching PostgreSQL only when something moved.
- **Version-bump bursts**: one flag change makes every online member of the organization miss at once. Mitigations, in order: client jitter (0-3 s) before refetching; single-flight per cache key; then split the entry into an organization part (plan, flag rules) and a per-membership part (role, projects) with its own version, so a flag change recomputes one shared object instead of thousands.
- **Large project lists**: the entry and every query carry the accessible project IDs as an array. With thousands of projects, express access as `restricted = false OR project_id = ANY(<small list of restricted grants>)` joined to `projects`, or materialize a user-project access table.
- **Event fan-out**: classic pub/sub sends every message to every gateway instance, and on a Valkey cluster to every node. Beyond a few dozen instances, move to sharded pub/sub, subscribing per user and organization channel for the connections an instance actually holds, or route users to gateway shards by consistent hash. Export progress is throttled to about one event per second per job.
- **Control-plane PostgreSQL**: small and write-light; one primary plus replicas. Cache misses may read a replica only if the replica's `authz_version` is at least the mirrored one; otherwise they read the primary. Writes stay on the primary. A manifest request could carry the version the client last saw (`minVersion`) and force a recompute when the cache is behind it.
- **Conversation store**: hash-sharded by organization, with the largest customers on dedicated shards and monthly time partitions; analytics served from per-(organization, project, day) rollups in an OLAP store.
- **Exports**: workers scale horizontally on `SKIP LOCKED`; a per-organization concurrency limit keeps one customer from occupying every worker; files go to object storage with lifecycle deletion after 7 days.
- **Audit**: append-only, partitioned by month, purged per plan retention.

## Design Review Checklist

**1. What is the source of truth, and when is a write successful?** PostgreSQL, for memberships, roles, flags, the authorization version, resources, invitations, links, audit and export jobs. A write succeeds when its transaction commits; the change, the version bump and the audit row commit together. Valkey holds derived or disposable state (cache, mirror, hints) plus sessions. An export is accepted when its row commits (`202`) and has a file only when `status = 'completed'`, which is set after the file exists.

**2. What happens when a client retries after losing the response?** Exports replay by `Idempotency-Key` (200 with the same job, or 422 if the body differs). A role change to the current role is a no-op. A repeated removal answers 404 for a member who is already gone, a repeated invitation acceptance by the person who accepted answers 200 (`alreadyMember`), and revoking a revoked link answers 204. A second invitation to an address with one pending is `409 INVITATION_PENDING`. Creating an agent, prompt or link is not idempotent; a retry makes a second one.

**3. What happens when a worker or server fails between two important steps?** Between commit and notification: the version is already bumped, so writes are correct at once and reads converge within the TTL, while heartbeats repair open streams (Failure Handling). Between export batches: the lease expires and another worker restarts the job, at most three times. Between writing and publishing a file: the publish is a fenced update, so a worker that lost its lease cannot mark the job complete.

**4. Which ordering or consistency guarantee is actually required?** Linearizable decisions for the invariants (last admin, seats, single-use invitations), from row locks in PostgreSQL. A monotonic version per organization, from the counter, the set-if-greater mirror and the client's "only if behind" rule. Read-your-writes for the administrator who made a change. Event order is *not* required: events are hints, and the version orders the state they point to. Exactly-once delivery is not required either.

**5. How is access enforced when caches, indexes or asynchronous jobs are involved?** The cache stores the inputs to decisions, keyed by version, never query results; writes and downloads bypass it. Queries carry the organization and project filter. The export worker re-checks against PostgreSQL at start and before publishing, and the download checks again. Events are filtered by current membership in the gateway, backed by the heartbeat. Client caches are keyed by organization and removed on revocation. A production search index must carry `org_id` and `project_id` and be filtered by them, and is not trusted on its own.

**6. What breaks first at much larger scale, and what evidence supports it?** History search in the largest organization (`ILIKE` cannot use the index, so cost grows with the organization's row count), then the heartbeat reconcile (a query per connection per 20 s, linear in open tabs), then version-bump bursts (misses equal to online members). The evidence is the query plans and code paths cited in Scalability, and the arithmetic in Capacity Estimation; the metrics that would confirm them are route latency for `/conversations` with `q`, PostgreSQL query rate per heartbeat, and `console_permission_cache_total{result="miss"}` after each `authz.changed`.

**Roadmap follow-ups:**

| Follow-up | Answer |
|-----------|--------|
| Switch organizations with a request in flight | Aborted by the visit's `AbortController`; if it lands anyway it is dropped as `StaleOrgResponse` and never retried. Its key belongs to the old organization, and placeholder rows never cross organizations |
| Where are role checks, and why both sides? | The server gate and queries enforce; the client reads the manifest computed by the same code so it never offers what will be refused, and can explain instead of erroring |
| Deep link to a page the role can't see | `Forbidden` with the reason: role → Request access (an audit entry for admins); flag → "not turned on"; plan → View plans; another organization's resource → 404 pane; unknown organization → neutral not-found |
| Admin removes access while the page is open | The failed trace: replaced within milliseconds over SSE, within 20 s if the push is lost, and refused on the next request regardless |
| How are client caches scoped? | `['org', orgId, …]` keys, removal on revocation, `clear()` on sign-in and sign-out, an organization-keyed layout |
| Testing roles and flags without every permutation | Pure functions on both sides: 30 server cases (3 roles × 2 plans × 5 flag-rule shapes) and 12 client cases; then one persona per rule end to end |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Enforcement | Route gate + query filter + composite FK | UI checks / row-level security | Stops IDORs; no bypass role to leak through |
| Permission cache | Version in the key, 60 s TTL | Delete on change / JWT role claims / no cache | Atomic invalidation, no stale-write race |
| Writes and downloads | Always recompute from PostgreSQL | Trust the cache | Revocation is immediate where it matters |
| Client authorization | One server-computed manifest | Role table copied to the client | Guards, sidebar and buttons can't disagree |
| Change propagation | Hints + versions everywhere | Data-carrying or replayable events | Lost or reordered events can't apply stale access |
| Transport | One SSE stream per tab, multiplexed per instance | WebSocket / one stream per organization | One-way data; switching never reconnects |
| Non-member response | 404 | 403 | Organization IDs reveal nothing |
| Policy engine | In-process library | Separate authorization service | Small fixed model; needs project lists for SQL |
| Export queue | PostgreSQL row, `SKIP LOCKED`, lease | Message broker | Transactional enqueue; status in one place |
| Pagination | Keyset + capped count | Offset + exact count | Constant cost per page on large organizations |
| Sessions | Opaque ID, identity only, in Valkey | JWT with roles | Immediate revocation; no stale claims |

## Implementation Notes

### Local architecture

```
┌──────────────────┐     ┌──────────────────────────┐     ┌───────────────────────┐
│ Vite :5173       │────▶│ API :3000                │────▶│ PostgreSQL :5432      │
│ /api proxied     │     │ REST + SSE + event hub   │     │ control plane +       │
└──────────────────┘     └────────────┬─────────────┘     │ history + export jobs │
                                      │                   └───────────▲───────────┘
                         ┌────────────▼─────────────┐                 │ claim, lease,
                         │ Valkey :6379             │◀──────┐         │ fenced updates
                         │ sessions, perm cache,    │       │ publish │
                         │ pub/sub, rate limits     │  ┌────┴─────────┴───────────┐
                         └──────────────────────────┘  │ Export worker (no port)  │
                                                       │ writes backend/exports/  │
                                                       └──────────────────────────┘
```

`npm run dev` in `backend/` runs the API and one worker with `concurrently -k`. `dev:server1..3` start more API instances on 3001-3003 (each with its own event hub and one Valkey subscription), and `dev:worker2` starts a second worker to watch `SKIP LOCKED` and leases. `POSTGRES_PORT`, `VALKEY_PORT` and the frontend's `API_TARGET` move the ports when another project holds them.

### Production-grade patterns actually implemented

**Declared access rules and a route inventory** (`backend/src/shared/org-access.ts`, test in `backend/src/api/app.test.ts`):

```ts
export const agentsRouter = orgRoutes()
agentsRouter.get('/agents', { permission: 'agents.read' }, handler)
exportsRouter.get('/exports/:exportId/download',
  { permission: 'conversations.export', entitlement: 'exports', authoritative: true }, handler)
```

**Version-keyed cache with a forward-only mirror** (`backend/src/shared/access.ts`): `loadAccess` reads `authz:ver:{org}`, then the entry; `bumpAuthzVersion` runs inside the change's transaction and `announceAuthzChange` after commit. The mirror script:

```lua
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) end
```

**Pure policy with exhaustive tests** (`backend/src/shared/permissions.ts`, `permissions.test.ts`; client mirror `frontend/src/lib/modules.ts`, `modules.test.ts`).

**Access inside queries**: `shared/conversation-query.ts` always starts with the organization and project conditions; every handler in `api/routes/*.ts` filters the same way; composite foreign keys in `db/init.sql`.

**Member removal and last-admin protection** (`backend/src/api/services/membership.ts`); session index and mass sign-out (`backend/src/shared/auth.ts`).

**Multiplexed event hub with reconcile** (`backend/src/api/services/event-hub.ts`, `api/routes/events.ts`): one pattern subscription per process; membership-filtered delivery; heartbeat reconcile against PostgreSQL.

**Export job queue** (`backend/src/worker/export-runner.ts`): the claim is one `UPDATE … WHERE id = (SELECT … WHERE status = 'queued' OR (status = 'running' AND leased_until < now()) … FOR UPDATE SKIP LOCKED LIMIT 1)`, skipping cancelled jobs and jobs at 3 attempts; heartbeat and finish are `UPDATE … WHERE id = $1 AND worker_id = $2 AND status = 'running'`; `failAbandonedJobs` is the sweeper.

**Idempotent export creation** (`backend/src/api/routes/exports.ts`), **audit in the same transaction** (`backend/src/shared/audit.ts`), **hashed bearer tokens** (`backend/src/shared/ids.ts`), **rate limiting** (`backend/src/shared/rate-limit.ts`), **Prometheus metrics** and **structured logging** (`backend/src/shared/metrics.ts`, `logger.ts`), **health checks and graceful shutdown** (`backend/src/api/index.ts`, `worker/index.ts`).

**Client organization scoping**: `frontend/src/lib/org-scope.ts`, `lib/org-switch.ts`, `lib/keys.ts`, `services/api.ts`; event handling in `services/events.ts` and `services/wiring.ts`; guards in `components/access/`.

### Simplified or substituted

- **One PostgreSQL** holds the control plane, the conversation history and the export queue; no replicas, no sharding
- **Export files on local disk** (`backend/exports/`), streamed through the authoritative download route and never deleted, instead of object storage with short signed URLs and a 7-day lifecycle rule
- **Event hub inside the API process** instead of a separate gateway fleet
- **Fixed roles and plans in code**, one feature flag (`prompt_library`, on in Lumen for admins and editors, off in Harbor), restricted-project membership set by the seed only (no API to change it)
- **Seeded history** (8,500 conversations) instead of an agent runtime; knowledge-base creation records a document without indexing anything; billing invoices are synthetic
- **Search** is `ILIKE`; **audit retention** is a read-time window, not a purge; **rate limiting** covers sign-in and the public share-link route, with fixed windows
- **Invitations** show the accept link once to the admin; no email is sent

**Omitted:** CDN, API gateway, multi-region, Kubernetes; search index and OLAP store; SSO, SCIM and custom roles; plan upgrades and payments; a request-access workflow beyond the audit entry.

### Known gaps

- **A removed member's private prompts** become invisible to everyone, admins included; they need an ownership-transfer step in the removal flow
- **Creating an agent, prompt or link is not idempotent**: a retried request after a lost response creates a second one
- **The stream heartbeat runs one PostgreSQL query per open stream** every 20 seconds; at scale it should be batched per instance
- **Audit retention** is a read-time window, and **project memberships** have no API (the seed sets them)

Fixed after this document's first review, and described above as fixed: a preview stored on the session applied even after the admin was demoted (now ignored unless the actual role is admin), only the manifest was refetched after a role change, export files were named per job instead of per attempt, the worker served no `/metrics`, conversation cost ignored the plan entitlement, invitations could be duplicated, and the share-link route had no rate limit.

### Verified locally

Backend: 70 unit tests (gate status codes, cache hit/miss/version behavior, route inventory, the 30-case policy matrix, event hub delivery and reconcile, cursor and query building, CSV escaping) and 14 integration tests against real PostgreSQL and Valkey that attempt cross-organization IDORs, restricted-project access, demotion, removal (links, invitations, exports, sessions), last-admin protection and invitation email binding. Frontend: 19 unit tests (12 role × plan × flag combinations, query keys, abort and drop on switch), `tsc` and `vite build`. A scripted two-user browser check (`scripts/two-user-check.mjs`, 29/29) drove the live Docker stack: switching organizations with a held response, a flag turned off, a demotion and two removals while pages were open, deep links, and an export with progress and download. It found two real bugs. The manifest response's own `X-Authz-Version` header triggered an invalidation of the manifest query, which cancelled that same in-flight fetch and looped (about 11K requests); the client now skips the manifest's own header and invalidates with `cancelRefetch: false`. And a member removed from their last org could see the wrong sign-out reason, because `access.revoked` made the tab refresh its org list and hit a 401 before `session.revoked` arrived; the server now publishes `session.revoked` first. Eighteen screenshots and 16 generated smoke tests pass.

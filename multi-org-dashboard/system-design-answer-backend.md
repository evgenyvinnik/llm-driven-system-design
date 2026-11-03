# Multi-Org Dashboard — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Authorization model → Architecture → Data model → API → Deep dives → Traces → Scale*

> "This is the console of a multi-tenant AI product. I'll call it Relay: companies use it to build customer-support agents, and each company is an organization with agents, a knowledge base, conversation history, analytics, billing and settings. One person can belong to several organizations with a different role in each. So the hard part isn't serving pages. It's answering 'may this user do this, in this org, right now?' correctly on every request, cheaply enough to ask it on every request, and changing the answer promptly when an admin changes it. I'll keep three things apart the whole way through: what your role allows, what your org has paid for, and what's switched on. And I'll treat every cache, every background job and every open browser tab as a place where an old answer can survive."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Scope, capacity, and revocation targets with numbers |
| Authorization model | ~4 min | Role, plan and flag as three separate axes; what 401, 403 and 404 each mean |
| Architecture | ~4 min | One gate on every org route; PostgreSQL authoritative; Valkey only for derived state and hints |
| Data model and API | ~6 min | org_id on every row, composite keys, a versioned authz counter, jobs as rows |
| Deep dives | ~13 min | Authorization inside queries; the versioned cache and revocation; exports as jobs |
| Traces, checklist, prompt sharing | ~9 min | One export end to end; one removal while a page is open; the six review questions; links and revocation |
| Scale and wrap-up | ~4 min | What breaks first, and the evidence for it |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Can one user be in several orgs? | Whether a role belongs to the user or to the membership | Yes, with a different role in each. The role lives on the membership |
| Which roles? | Size of the permission model | Admin, editor and viewer, mapped to 19 named permissions. Custom roles later |
| Are features gated by plan as well? | Whether "you can't" has one cause or several | Yes. Plan entitlements (exports, cost analytics, seats, audit retention) are separate from roles and from feature flags |
| Is there access finer than the org? | Whether membership alone is enough | Projects inside an org. A restricted project is visible only to admins and its own members |
| How fast must revocation take effect? | The whole cache design | Writes: on the next request. Reads and open pages: within seconds, with a hard upper bound |
| Is the prompt-sharing variant in scope? | Resource-level sharing and bearer links | Yes: a prompt is private, shared with named roles, or shared by a revocable link |
| How big is history? | Pagination and exports | Millions of conversations in a large org; exports of millions of rows |

### Functional requirements

1. Sign in once, see my organizations, and switch between them. The org ID is part of every URL.
2. Per-org modules: agents, knowledge base, conversation history, analytics, a prompt library behind a feature flag, exports, billing and settings.
3. Admins manage members (change role, remove), invitations, share links and feature flags, and read the audit log.
4. Every permission, flag and entitlement is enforced in the API. The client receives one manifest of effective access per org and renders from it.
5. Role changes, removals and flag changes take effect mid-session, including on pages that are already open.
6. Conversation history with filters, cursor pagination and a detail view, plus CSV export as a background job with progress and a notification.
7. Prompt library: private, role-shared or link-shared prompts. Links are revocable, and removing a member revokes what they shared.
8. Every admin action is audited with before and after values. Retention depends on the plan.

### Non-functional requirements

| Property | Target | Note |
|----------|--------|------|
| Isolation | Zero cross-org reads or writes | The only hard-zero target. Drives 404 semantics and query scoping |
| Revocation for writes | Refused on the first request after the change commits | Writes never consult a cache |
| Revocation for cached reads | Normally under 1 s; at most 60 s if invalidation is lost | A version-keyed cache with a TTL backstop |
| Revocation on open pages | About 1 s through push; at most 20 s if a push is lost | The stream heartbeat carries versions |
| Authorization overhead | p99 < 5 ms on a cache hit | Two Valkey reads |
| List latency | p99 < 200 ms | Keyset pagination, capped counts |
| Exports | Accepted in < 300 ms; a million rows in minutes; progress on every batch | A job, not a request |
| Availability | 99.95% | A failed permission-cache read falls back to PostgreSQL, never to "allow" |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Orgs and console users | 20K orgs, 500K users, 50K daily active | The largest org has 50K members (an outsourced support center) |
| Console API | ≈ 1,000 requests/s at peak | 50K daily users × 300 requests ≈ 175/s average, about 6× at peak |
| Permission lookups | ≈ 1,000/s, ≈ 50/s misses at a 95% hit rate | One per org-scoped request. A miss is three indexed queries |
| Open event streams | ≈ 60K at peak | About 1.2 tabs per user active at the peak |
| Stream heartbeat checks | ≈ 3,000/s | 60K streams ÷ 20 s, each one membership query |
| Conversations | ≈ 10M/day, ≈ 3.6B rows/year | Written by the agent runtime, read by the console |
| Exports | ≈ 20K/day, 200K rows on average | ≈ 0.25 jobs/s. Throughput is measured in rows, not jobs |

> "Two numbers stand out. Authorization itself is cheap: fifty cache misses a second is nothing for PostgreSQL. But the heartbeat that backstops lost events costs 3,000 queries a second, sixty times the miss load, so I already know where the first bottleneck is. The other is the conversation table at billions of rows, which is really the analytics problem leaking into the console."

---

## 🔐 The Authorization Model (~4 min)

Effective access has three independent axes plus a resource scope. Each axis is owned by someone different, and a "no" on each one has a different remedy.

| Axis | Comes from | Changes when | Who can turn a "no" into a "yes" | API answer |
|------|------------|--------------|----------------------------------|------------|
| Role → permissions | The membership's role and a fixed role table | An admin changes the role | An admin | 403 FORBIDDEN, naming the permission and the role |
| Plan → entitlements | The org's plan and a fixed plan table | The org upgrades | Whoever pays | 403 ENTITLEMENT_REQUIRED, naming the plan |
| Flag rules → flags | One rule per (flag, org): enabled, and which roles | Product or an admin flips it | Nobody; it isn't offered | 403 FEATURE_DISABLED |
| Resource scope | Projects, project membership, ownership | Membership or sharing changes | — | 404, exactly as if it didn't exist |

> "An admin on the starter plan *may* export, because the role says so, but the org *can't*, because the plan doesn't include it. If I folded those into one 'can export' boolean, the UI would tell an admin to go ask an admin. Keeping the axes apart is what lets every 'no' come with the right next step."

**The gate.** Every org route runs the same steps in the same order:

1. No session → 401 UNAUTHENTICATED. A session identifies the user and nothing else; it never carries a role.
2. Malformed org ID, unknown org, or not a member → 404 NOT_FOUND, one answer for all three.
3. Load effective access: from the cache for reads, from PostgreSQL for writes and for routes declared sensitive.
4. An admin previewing the console as another role attempts a write → 403 READ_ONLY.
5. Permission, then flag, then entitlement, each with its own 403 code. The role comes first, so a viewer on the starter plan hears about their role, not about pricing.
6. Attach the access to the request: org, role, permissions, accessible project IDs and version. Handlers scope their queries with it.

Every org-scoped response carries `X-Org-Id`, `X-Authz-Version` and `Cache-Control: private, no-store`. A client holding an older manifest notices on its very next response, even with no event stream.

Effective access is computed by one pure function: role, optional preview role, plan, flag definitions and flag rules go in; permissions, entitlements, flags and a read-only bit come out. The same function feeds the gate and the manifest the client renders, so the two can't disagree about what a role may do.

---

## 🏗️ Architecture (~4 min)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Browser tab · REST with a session cookie · one SSE stream for all orgs   │
└──────────────┬────────────────────────────────────────────▲──────────────┘
               │ (1) REST                                   │ (5) SSE hints
┌──────────────▼────────────────────────────────────────────┴──────────────┐
│ Load balancer / API gateway · TLS · /events routed to the stream fleet   │
└──────────────┬────────────────────────────────────────────▲──────────────┘
               │                                            │
┌──────────────▼──────────────────────────┐   ┌─────────────┴──────────────┐
│ Console API (stateless)                 │   │ Event hub (per instance)   │
│ (2) one gate on every org route         │   │ one pattern subscription   │
│ (3) org + projects in every query       │   │ routes hints to local tabs │
│ (4) access change + bump + audit in txn │   │ heartbeat reconcile, 20 s  │
└──────┬────────────────────────┬─────────┘   └─────────────▲──────────────┘
       │ writes, sensitive      │ cached access,            │ pub/sub
       │ reads, transactions    │ version mirror, publish   │
┌──────▼───────────────┐   ┌────▼───────────────────────────┴──────────────┐
│ PostgreSQL           │   │ Valkey                                        │
│ source of truth:     │   │ perm:{org}:{user}:v{n}, 60 s TTL              │
│ orgs.authz_version,  │   │ authz:ver:{org} · session:{id} · usess:{user} │
│ memberships, flags,  │   │ evt:org:* · evt:user:* (hints, never data)    │
│ resources, links,    │   └────────────────────────▲──────────────────────┘
│ export_jobs, audit   │                            │ (6) progress, done
└──────▲───────────────┘                            │
       │ (6) claim, lease, fenced writes,           │
       │     access re-checks                       │
┌──────┴────────────────────────────────────────────┴──────┐   ┌──────────────┐
│ Export workers (N) · poll · 250-row batches · sweeper    ├──▶│ Object store │
└──────────────────────────────────────────────────────────┘   └──────────────┘
```

**Walking the diagram:**

1. The browser calls the API with a session cookie. The session lookup in Valkey yields a user ID and nothing more.
2. Every org route passes the one gate. For a GET it reads the org's version from Valkey, then the cached access under that version. A miss, or any write, reads PostgreSQL.
3. The handler queries with the org ID and the accessible project IDs as its first two conditions.
4. A change to a membership, a role, project access or a flag runs in one transaction with the version bump and the audit row. After commit, the API mirrors the version to Valkey and publishes hints on the org's channel and the affected user's channel.
5. Each API instance holds one pattern subscription and routes hints to the tabs connected to it.
6. Export workers claim job rows in PostgreSQL, write the file, and publish progress on the creator's channel.

**Placement decisions worth stating:**

- **PostgreSQL is the only source of truth for who may do what.** Valkey holds derived state (cached access and the version mirror), sessions (identity only) and hints. Losing Valkey's data signs everyone out and turns cached reads into misses; a failed cache read falls back to PostgreSQL. Nothing in Valkey can grant access.
- **One gate, declared per route.** Routes can only be registered through a helper that demands an access rule and records it in a route inventory. A test walks the framework's route table and fails if any org route bypassed the helper.
- **Event streams are their own fleet in production.** They're long-lived and mostly idle, so they scale with open tabs, not with request rate. Locally the hub lives inside the API process.
- **Exports run in workers.** A million-row export takes minutes, and nothing that long belongs in a request.

---

## 💾 Data Model (~3 min)

```
users ──< org_memberships (role) >── orgs (plan, authz_version)
                                       │
                                       ├──< projects (restricted) ──< project_memberships >── users
                                       │       │
                                       │       └──< agents · knowledge_docs · conversations · prompts
                                       │              each keyed (org_id, project_id) → projects
                                       ├──< feature_flag_rules >── feature_flags
                                       ├──< invitations (token hash, role, expiry)
                                       ├──< share_links (token hash, revoked_at)
                                       ├──< export_jobs (query, status, lease)
                                       └──< audit_events (before, after)
```

| Table | Key columns | Indexes / constraints | Notes |
|-------|-------------|-----------------------|-------|
| orgs | id (pattern-checked `org_…`), name, plan, branding, authz_version | PK | authz_version bumps in the same transaction as any access change |
| org_memberships | (org_id, user_id) PK, role | index on user_id | The role belongs to the membership, never to the user |
| projects | id, org_id, name, restricted | unique (org_id, id) | The composite key every resource references |
| project_memberships | (project_id, user_id) PK | — | Grants visibility of a restricted project |
| agents, knowledge_docs, prompts | id, org_id, project_id, owner_id, content | (org_id, project_id); FK (org_id, project_id) → projects (org_id, id) | A resource in org A pointing at a project in org B can't be stored |
| conversations | id, org_id, project_id, agent_id, channel, status, csat, cost_cents, started_at | (org_id, started_at DESC, id DESC); (org_id, status, started_at DESC, id DESC) | The keyset order. Partitioned by month at scale |
| conversation_messages | id, conversation_id, org_id, author, body | (conversation_id, created_at) | Carries org_id although a join could derive it |
| feature_flags, feature_flag_rules | key, default; (flag_key, org_id) PK, enabled, roles | — | An empty role list means every role |
| invitations | id, org_id, email, role, token_hash (unique), expires_at, accepted_at, revoked_at | partial index on pending | Single use, seven-day expiry, must match the signed-in email |
| share_links | id, org_id, resource, token_hash (unique), token_hint, expires_at, revoked_at, revoked_by, created_by, last_used_at | partial (org_id, created_by) on active links | Revocation is a timestamp, never a delete |
| export_jobs | id, org_id, created_by, query, idempotency_key, status, processed/total rows, attempts, worker_id, leased_until, cancel_requested_at, file | unique (org_id, created_by, idempotency_key); partial on queued/running | The row is the queue |
| audit_events | id, org_id, actor, action, target, before, after, created_at | (org_id, id DESC) | Written in the same transaction as the change it describes |

| Valkey key | Type | Purpose | Lifetime |
|------------|------|---------|----------|
| `perm:{org}:{user}:v{n}` (plus `:as-{role}` in preview) | String | Effective access for one user in one org at one version | 60 s |
| `authz:ver:{org}` | String | Mirror of orgs.authz_version; only ever moves forward | 24 h |
| `session:{id}`, `usess:{user}` | String, set | Session → identity; the index used to end all of a user's sessions | 7 days |
| `evt:org:{org}`, `evt:user:{user}` | Pub/sub | Invalidation hints and progress, never authority | — |

**Data decisions I'd say out loud:**

- **org_id is on every tenant row**, even where a join could derive it. Every query can then filter on it directly, and partitioning by org later is a schema-compatible move.
- **Tokens are stored only as SHA-256 hashes** plus a four-character hint for the admin list. The raw token is shown exactly once. A database leak doesn't leak working links or invitations.
- **Revocation is a timestamp.** "This link was revoked" (410) stays distinguishable from "this link never existed" (404), and the audit trail survives.
- **Role is never cached on the session.** A session that outlives a demotion authorizes nothing, because every request recomputes access for the org in its URL.

---

## 🔌 API Design (~3 min)

```
GET    /api/v1/auth/me                               → User and their orgs (identity only)
GET    /api/v1/events                                → The tab's one SSE stream: hello, versions, hints
GET    /api/v1/orgs/:orgId/manifest                  → Role, permissions, flags, entitlements, projects, version
POST   /api/v1/orgs/:orgId/preview                   → Admin "view as role"; writes refused while it lasts
POST   /api/v1/orgs/:orgId/access-requests           → "Request access" from a 403 page; audited
GET    /api/v1/orgs/:orgId/conversations?…&cursor=   → Keyset page; capped total on the first page only
GET    /api/v1/orgs/:orgId/conversations/:id         → Transcript; cost only with analytics.cost
GET    /api/v1/orgs/:orgId/analytics?days=           → Daily series; cost absent without role and plan
POST   /api/v1/orgs/:orgId/exports                   → Start (Idempotency-Key required) → 202, or 200 replay
POST   /api/v1/orgs/:orgId/exports/:id/cancel        → 202
GET    /api/v1/orgs/:orgId/exports/:id/download      → File, after an authoritative re-check
PATCH  /api/v1/orgs/:orgId/members/:userId           → Change role (last-admin guard)
DELETE /api/v1/orgs/:orgId/members/:userId           → Remove, with the cascade
POST   /api/v1/orgs/:orgId/invitations               → Invite; pending invitations count against seats
PUT    /api/v1/orgs/:orgId/features/:flagKey         → Set this org's rule for a flag
GET    /api/v1/orgs/:orgId/audit?action=&before=     → Audit page within the plan's retention
POST   /api/v1/orgs/:orgId/prompts/:id/links         → Create a share link; raw token returned once
DELETE /api/v1/orgs/:orgId/links/:linkId             → Revoke (creator, or links.manage)
GET    /api/v1/shared/:token                         → Public prompt view, no session
POST   /api/v1/invitations/:token/accept             → Join; the invitation's email must match
```

| Status | When | Why this code |
|--------|------|---------------|
| 401 UNAUTHENTICATED | No session, or it expired | The client signs in and returns to the same URL |
| 404 NOT_FOUND | Not a member, unknown org, malformed ID, or a resource outside your projects | One answer for "doesn't exist" and "not yours" |
| 403 FORBIDDEN | A member whose role lacks the permission | Details name the permission, role and version; the client refetches its manifest |
| 403 FEATURE_DISABLED | The flag is off for this org and role | Applies to admins too |
| 403 ENTITLEMENT_REQUIRED | The plan lacks it, including seats | The remedy is an upgrade, not an admin |
| 403 READ_ONLY | A write during a role preview | A preview is a view, not an impersonation |
| 409 LAST_ADMIN | Demoting or removing the only admin | Row locks make the check race-free |
| 410 LINK_REVOKED / LINK_EXPIRED / INVITATION_… | The token existed and is no longer valid | Distinct from a mistyped token |
| 422 IDEMPOTENCY_KEY_REUSED | Same key, different export filters | A client bug; replaying the wrong job would be worse |

> "Outside an org I return 404, not 403. A 403 says 'this exists, you just can't see it', which turns org IDs and resource IDs into an oracle: anyone could check whether a company is a customer. Inside an org you belong to, I switch to 403, because there the existence of the Billing page isn't a secret, and you deserve to know why you can't open it."

---

## 🔧 Deep Dives (~13 min)

### Deep dive 1: Authorization inside the query, 404 versus 403, and a route inventory

**Decision.** Authorization has two layers and neither is optional. The gate decides whether this user may call this route in this org at all. The query decides which rows they see: every tenant query begins with the org ID and the user's accessible project IDs, taken from the access the gate attached, and a lookup by ID includes both. A resource from another org, or from a restricted project the user isn't in, matches zero rows and returns 404, exactly like an ID that never existed. Malformed IDs become 404 before they reach PostgreSQL. At write time, a composite foreign key from (org_id, project_id) to the project's (org_id, id) makes a cross-org reference impossible to store. And because org routes can only be registered through a helper that demands a rule, a test walks the route table and fails the build when any route lacks one.

**Why it works here.** The threat that matters isn't an outsider. It's a legitimate user carrying a legitimate ID into the wrong context. Alice is an admin at Lumen Outfitters and a viewer at Harbor Health Co-op. "Is Alice an admin?" is true, and if one check forgets to ask "in which org?", she can edit Harbor's agents by pasting a Harbor agent ID into a Lumen URL. With the scope in the WHERE clause, a forgotten check fails safe: the query returns nothing. The conversation list and the export worker build their WHERE clause with the same function, which takes the org and the project list as required arguments. There is no code path that builds a conversation query without them, and an export contains exactly the rows the table would show. A user-supplied project filter is ANDed with the accessible list, so asking for the restricted VIP project returns an empty page, not the project.

**How the alternatives break.**

- *Fetch by ID, then compare the org in code.* That's one comparison per handler, and the one somebody forgets is a cross-tenant leak. It can't work for lists at all: filtering after pagination returns short pages and wrong counts.
- *PostgreSQL row-level security as the primary mechanism.* It's a strong backstop, but every transaction must first set the org and the user's projects on the connection. Behind a transaction-mode pooler, every read has to be wrapped to do that, and the export worker, migrations and seeders each need their own policies or bypass roles. I'd add it at scale for defense in depth, not rely on it for product semantics such as 404 versus 403.
- *403 for non-members.* It tells a stranger that org_harbor exists. IDs become an oracle for "is this company a customer?" and "does this conversation exist?".

| Approach | A forgotten check | Lists and counts | Cost |
|----------|-------------------|------------------|------|
| ✅ Gate per route + scope in every query + composite FK + route inventory | Returns nothing | Correct; the filter is in SQL | Every query carries the project list |
| ❌ Fetch by ID, compare in code | Leaks the row | Short pages, wrong counts | One hand-written comparison per handler |
| ❌ Row-level security only | Fails closed | Correct | Per-transaction session state; awkward for workers |
| ❌ 403 for non-members | — | — | An existence oracle |

**What I give up.** Every query carries the accessible project array. For a user with thousands of projects the array gets large, so past a few hundred I'd join project memberships instead, and give admins an "all projects" short-circuit. The 404 makes support slightly harder ("is it gone, or am I not in it?"), so the client's not-found page names both possibilities. And the inventory proves every route has a rule, not that every query has a scope: a handler behind a correct gate could still run an unscoped query. That gap is what the integration suite targets: thirteen tests against a real database, for a user who belongs to both orgs, that swap IDs across orgs, write into another org's project, and probe restricted projects.

### Deep dive 2: A versioned permission cache, and what stays authoritative while it catches up

**Decision.** For a read, the gate's answer comes from Valkey under `perm:{org}:{user}:v{n}`, where n is orgs.authz_version in PostgreSQL. Every transaction that changes a membership, a role, project access or a flag rule increments that version before it commits, so no access change can commit without a new version. After commit, the API mirrors the number to `authz:ver:{org}` with a set-if-greater script, then publishes a hint. A read looks up the mirrored version, then the entry under it. On a miss it recomputes from PostgreSQL, stores the entry with a 60-second TTL, and repairs the mirror. Writes never read the cache, and neither does anything that creates a copy or grants entry: downloads (declared authoritative on their route), the export worker's checks, share-link reads, invitation acceptance and the event stream's membership load all read PostgreSQL directly.

**Why it works here.** Changing the version invalidates every entry for the org in one write, with no keys to enumerate. A 50K-member org has up to 50K entries plus preview variants, and I never need to find them: they become unreachable and expire. The correctness lives in four ordering details:

- The bump is inside the transaction, so "membership changed but nobody invalidated" can't happen. At worst the *mirror* lags.
- The mirror only moves forward. A slow request that read PostgreSQL at version 41, before the change committed, may finish after the bump to 42. Set-if-greater stops it rolling the mirror back, and the entry it stores lands under the dead key v41.
- The version and the role come from the same statement, and projects and flags are read after it. An entry can be fresher than its key, never staler.
- If the mirror write fails after commit, reads keep hitting the v41 entry until it expires: 60 seconds, the bound I promised. The first miss after that reads 42 from PostgreSQL and repairs the mirror for everyone.

This is the key question for this design: **what cached state must be invalidated when access changes, and which checks stay authoritative before that completes?**

| Cached state | Where | Invalidated by | Worst-case staleness | Authoritative meanwhile |
|--------------|-------|----------------|----------------------|-------------------------|
| Effective access per (org, user) | Valkey | A new version, hence a new key | Milliseconds; 60 s if the mirror write is lost | Every write, downloads, the export worker, share-link reads |
| The version mirror | Valkey | Set-if-greater after commit; repaired by the next miss | Until the next miss or the TTL | orgs.authz_version in PostgreSQL |
| Which orgs a stream may hear | Event hub memory | access.revoked; the heartbeat reconcile | 20 s if the hint is lost | Hints carry no data; data still goes through the gate |
| Sessions | Valkey | Destroyed when the user has no orgs left | — | Sessions carry no roles, so a surviving one authorizes nothing |
| Client manifest and query cache | Browser | A hint, a newer X-Authz-Version on any response, a 403, the heartbeat's versions | About 1 s; 20 s without push | The API refuses regardless of what the client renders |
| Finished export files | Object storage | Queued and running jobs cancelled on removal | — | Publish and download both re-check PostgreSQL |

**How the alternatives break.**

- *TTL only.* A removed member keeps reading for the whole TTL. With five minutes, that's five minutes of reading customer transcripts after being removed for cause. Shortening the TTL to fix it drives the hit rate down until the cache is pointless.
- *Delete keys on change.* You must know every key, including each preview variant, and it races. A request reads PostgreSQL just before the change commits; the change commits and deletes the key; the request then writes its stale result back, and that entry lives for a full TTL. With a versioned key, the late write goes to a key nobody will ever read.
- *Roles in a signed token.* A token issued before a demotion stays valid until it expires, and it would need a role for every org the user belongs to.
- *No cache.* Three indexed queries per request is fine at 1,000 requests a second. The cache pays for the multiples on top: manifests on every tab, and bursts after every bump.

| Approach | Removed member reads for | Invalidation race | Cost |
|----------|--------------------------|-------------------|------|
| ✅ Version in the key, bumped in the transaction, TTL backstop | Milliseconds (60 s worst case) | A late write lands under a dead key | Two Valkey reads; coarse invalidation |
| ❌ TTL only | The full TTL | — | Hit rate versus staleness, with no good setting |
| ❌ Delete on change | Up to a TTL after a lost race | Stale write-back | Enumerating keys |
| ❌ Roles in a token | Until the token expires | — | No revocation |

**What I give up.** One version per org is coarse. Changing one member's role invalidates every member's entry, which in a 50K-member org means a burst of recomputation after a single click. At that scale I'd split it: an org version for plan and flag changes, a per-user version for that user's membership, and a key that carries both. Reads pay two Valkey round trips, version then entry. And for the milliseconds between commit and mirror, a cached read can still use the old role. I accept that, because it can only return what the user could read a moment earlier, while anything that changes state or produces a durable copy goes to PostgreSQL.

> "The question I ask of every cache here is: what's the worst thing it can do while it's stale? For the permission cache, the answer is 'show you, for up to a minute, a page you could see a minute ago'. It can never let you change anything, produce a file or open a link, and that's exactly why writes, downloads, exports and share links all go around it."

### Deep dive 3: Exports as jobs, with idempotent creation, fenced leases and access checked three times

**Decision.** Creating an export with an Idempotency-Key inserts an export_jobs row, writes the audit event in the same transaction, and returns 202. A unique constraint on (org, user, key) means a retry gets the original job back with 200 and Idempotent-Replayed, and the same key with different filters gets 422. Workers poll the table and claim the oldest runnable job with a skip-locked row lock: status becomes running, attempts increments, and a 30-second lease starts. The worker re-checks the creator's access in PostgreSQL, counts the rows, and reads them in 250-row keyset batches through the same WHERE builder the list uses. After each batch it renews the lease with an update conditioned on its own worker ID and running status, and that same update returns the cancel flag. It writes to a temporary file, re-checks access once more, renames the file into place, and marks the job completed with another conditioned update. If that update matches nothing, it deletes the file. Progress goes out on the creator's channel, and every download re-checks access authoritatively.

**Why it works here.** An export is a copy of tenant data that outlives both the request and the permission that created it. So access is checked at the three moments it matters: when the job is created (the gate), when the file is about to exist (the worker), and when it leaves the building (the download). Using the row as the queue keeps the job, its idempotency key, its audit event and its ownership in one transactional store. At a quarter of a job per second, a broker would add a second source of truth and no throughput I need. Leases handle crashes: a dead worker's job is claimable 30 seconds after its last batch, for up to three attempts, after which the sweeper fails it as WORKER_LOST. Fencing handles the subtler case, a worker that only *seemed* dead. When it wakes, its renewals and its completion match zero rows, so it can't overwrite the worker that took over. Cells beginning with =, +, - or @ are prefixed, so a customer who types a formula into a support chat can't execute it in an admin's spreadsheet.

**How the alternatives break.**

- *Stream the CSV in the request.* A million rows take minutes. The proxy times out, the retry starts over, an API worker is pinned the whole time, there's no progress, and leaving the page kills it.
- *A message broker.* The job row must still exist for status, progress and download, so ownership now lives in two places. A visibility-timeout redelivery hands the job to a second worker while the first is merely slow, and I'd still need fencing in the database to keep them apart.
- *Check access only at creation.* An editor removed a minute after clicking Export would still get the file, and the Download link in their notification would still work.

| Approach | Survives a crash | Access checked at | Moving parts |
|----------|------------------|-------------------|--------------|
| ✅ Job row as queue, lease + fencing, three access checks | Yes, re-claimed after 30 s, up to 3 attempts | Create, publish, download | Poller and sweeper |
| ❌ Streamed in the request | No; the retry starts over | Create only | None, until the proxy timeout |
| ❌ Broker message + job row | Yes | Wherever you add it | Two sources of truth; still needs fencing |
| ❌ Check at creation only | Yes | Create | Files for people who've lost access |

**What I give up.** Workers poll, so a job can wait a second before starting. Every batch is a row update, fine at this volume, and the reason I'd move to a real queue only if export volume grew by orders of magnitude. A retried attempt restarts from row zero rather than resuming from a checkpoint; for 10M-row exports I'd store the keyset cursor on the row. And when access is lost at the last check, the work is wasted and the file discarded. That's the right trade: the expensive outcome is a file the user shouldn't have, not some CPU.

---

## 🔁 Execution Traces (~4 min)

### ✅ Successful trace: an export, end to end

Ben is an editor at Lumen Outfitters (pro plan) and a member of its restricted VIP project.

1. **Client.** Ben clicks Export on the history page filtered to escalated conversations. The client generates one Idempotency-Key and keeps it until the request succeeds, so a retry after a network error reuses it.
2. **Gate.** A POST is a write, so access comes from PostgreSQL: his membership (editor), the org's version, his projects (including VIP) and the flag rules. conversations.export passes, and the pro plan's exports entitlement passes.
3. **Accept.** One transaction inserts the job (a no-op on a key conflict), inserts export.created into the audit log, and reads the row back. **The commit is acceptance.** The API returns 202 with the job.
4. **Claim.** Within a second, a worker's poll claims it: queued becomes running, attempt 1, lease 30 s.
5. **First re-check.** The worker recomputes Ben's access from PostgreSQL, not the cache, requires the permission and the entitlement, and takes his project IDs.
6. **Stream rows.** It counts the matching rows, renews the lease with the total, and publishes export.progress on Ben's channel. Then, batch after batch: a keyset read, defused CSV cells, a lease renewal that also reads the cancel flag, a progress event.
7. **Fan-out.** The API instance holding Ben's stream receives each message through its single pattern subscription, checks that his connection still belongs to Lumen, and writes an SSE frame. His export indicator advances.
8. **Publish.** After the last batch the file is closed, access is checked once more, the temporary file is renamed into place, and the job is marked completed by an update conditioned on this worker and a running status. export.completed goes out, and Ben sees a toast with a Download button.
9. **Download.** The download route is declared authoritative: PostgreSQL again, then the owner scope (editors see their own exports, admins see everyone's), then the file streams with caching disabled.

**Lost response.** If the 202 never reaches the browser, the retry carries the same key. The insert does nothing, and the existing job comes back with 200 and Idempotent-Replayed. One click, one job.

### ❌ Failed trace: a member is removed while their page is open and their export is running

Alice, an admin at Lumen, removes Ben while he has the prompt library open, an export running and a share link outstanding.

1. **Request.** Alice sends the removal. The gate reads PostgreSQL, because it's a write: Alice is an admin with members.manage.
2. **Transaction.** Lock Ben's membership row. He isn't an admin, so the last-admin guard (which locks every admin row) doesn't apply. Delete his org membership and his project memberships in Lumen. Revoke pending invitations he sent or that are addressed to him. Set revoked_at on every link he created. Cancel his queued exports outright with ACCESS_REVOKED, and set the cancel flag on the running one. Bump the version from 41 to 42. Write member.removed with the counts as its after-value. Commit.
3. **After commit.** Mirror 42 to Valkey (forward only) and publish authz.changed with version 42 on Lumen's channel. If Ben belongs to no other org, destroy every session in his session index and publish session.revoked *first*, so his tab signs out with the right reason instead of tripping over a 401 while refreshing its org list. Then publish access.revoked on Ben's channel.
4. **Hubs.** Every API instance receives both messages. Lumen's connections get authz.changed, so Alice's tabs refetch their manifest if it's behind. Ben's connections first leave Lumen, so nothing more from Lumen reaches them, and then receive access.revoked.
5. **Ben's tab.** It drops every cached Lumen query and replaces the page with "You no longer have access to Lumen Outfitters", offering his other orgs.
6. **Worker.** Its next lease renewal returns the cancel flag. It re-checks Ben's access, finds no membership, deletes its temporary file and marks the job failed with ACCESS_REVOKED (a cancel the user asked for would end as cancelled). The failure event it publishes is dropped by the hub, because Ben's connection no longer belongs to Lumen.

**What the server refuses meanwhile, even if every message in step 3 were lost:**

- Any write from Ben to Lumen: authoritative, no membership, 404.
- Any read: the mirror says 42, so the v41 entry is unreachable and the miss goes to PostgreSQL, 404. If the mirror write had failed, cached reads could succeed for at most 60 seconds, and only for pages he could already see.
- The export: cancelled at its next batch. Even without the flag, the re-check before publishing fails, and no file ever appears.
- The share link: 410. Even if the revocation update had somehow been skipped, the public read requires the link's creator to still be a member.
- The stream: if the push was lost, the next heartbeat, at most 20 seconds later, finds the missing membership and sends access.revoked. If his session is gone, it closes the stream.

> "Pushes make it fast; checks make it correct. I can lose every message in step 3, and Ben still can't do anything new in Lumen. He just keeps looking at an old page for up to twenty seconds."

---

## ✅ Design Review Checklist (~2 min)

| # | Question | Answer |
|---|----------|--------|
| Q1 | Source of truth, and when is a write successful? | PostgreSQL holds memberships, roles, flags, plans, resources, links, jobs and audit events. An access change succeeds when its transaction commits, and that one transaction contains the change, the version bump and the audit row. An export is accepted when its job row commits. Valkey holds only derived state, identity-only sessions and hints |
| Q2 | A client retries after losing the response? | Export creation replays by Idempotency-Key (200 plus Idempotent-Replayed; 422 if the body differs). A role change to the same role is a no-op with no bump. A repeated removal finds no membership and answers 404: the end state is the one requested, so the retry is safe even though its status code differs. Revoking an already-revoked link returns 204. A repeated invitation accept by the person who accepted returns 200 with alreadyMember; anyone else gets 410. Sending a second invitation to an address with one pending is refused with 409 INVITATION_PENDING, so a double-click can't mint two live tokens |
| Q3 | Failure between two important steps? | Commit, then a crash before the mirror or the publish: PostgreSQL is ahead, cached reads stay stale for at most 60 s, the next miss repairs the mirror, writes were never affected, and clients catch up through the version header or the 20 s heartbeat. A worker dies mid-export: the lease lapses in 30 s and another worker restarts it, up to three attempts, then WORKER_LOST. A stalled worker wakes up: its fenced writes match nothing. A crash after the file rename but before the completion update: the file is never served, because download requires a completed job |
| Q4 | Which ordering is actually required? | Per org, versions only move forward: the row update serializes bumps, the mirror is set-if-greater, and clients refetch only when they're behind. Hints are unordered and lossy by design, because they only trigger refetches. An access change and its audit row are atomic. History pages use a total order (started_at, then id), so pages never skip or repeat |
| Q5 | Access with caches, indexes and async jobs? | The cache is keyed by version and bypassed for writes and sensitive reads. The export worker checks PostgreSQL before starting and before publishing; downloads check again. Share links are never cached and check revocation, expiry and the creator's membership. Streams load membership at connect, follow hints, reconcile every heartbeat, and drop events for orgs they've left. Sessions carry no roles |
| Q6 | What breaks first, and the evidence? | The stream heartbeat's per-connection membership query, then the cache stampede after a bump in a huge org. The table below shows the arithmetic |

---

## 🧩 The Prompt-Sharing Variant (~2 min)

The prompt library is the variant where modules become shared resources. Each prompt is private, shared with named roles, or shared by link.

| Mode | Stored as | Enforced by |
|------|-----------|-------------|
| Private | The owner, with an empty shared-roles list | The visibility condition: same org, an accessible project, and (I'm the owner, or my role is in the list) |
| Shared with roles | The shared-roles list, for example editor and viewer | The same condition. Changing the list requires prompts.share, only the owner may do it, and it's audited with before and after |
| Shared by link | A share_links row: token hash and hint, view-only permission, expiry (30 days by default, at most 90), revoked_at, created_by, last_used_at | A public route that looks the token up by hash: 404 if unknown, 410 if revoked, expired or its creator has left the org. Responses are never cached |

Visibility is a WHERE condition, not a check after the fact, so a list can never contain a prompt you can't open, and opening someone's private prompt by ID returns 404. Editing requires ownership (403 NOT_OWNER), because being able to see a prompt doesn't mean you may change it. Only the owner creates links. The creator or an admin with links.manage can revoke one, and revocation deliberately has no feature-flag check: turning the library off must never stop an admin revoking what was already shared.

**Revoking a link while someone has it open.** Revocation stops the next read; it can't recall bytes already delivered. The public page is a single read with caching disabled, so a refresh shows "This link was revoked". If live closing mattered, the page could hold a stream keyed by link ID, but anyone who saw the text could have copied it. The controls that actually matter are a default expiry, view-only links, last-used timestamps for audit, and rate limits on the public route. Un-sharing a prompt from a role is a change to one resource, not to membership, so I don't bump the org version and make every member refetch their manifest. The viewer's next read of that prompt returns 404. If instant closing were required, I'd publish a per-prompt hint on the org channel.

**Removal cascades to links.** The removal transaction revokes every link the member created. The creator-membership condition on the public read is the backstop for any path that skipped it. Two decisions I'd flag. A *demoted* editor's links stay live, because the creator is still a member, and as a viewer they can no longer revoke those links themselves, because revoking requires prompts.share. Admins can see and revoke every link in Settings. A stricter rule would require the creator to still hold prompts.share at read time, at the cost of one more join. And a removed member's *private* prompts become invisible to everyone, admins included, so production needs ownership transfer on removal.

---

## 🧪 Testing Roles × Flags × Plans Without the Full Matrix (~1 min)

Thirty-six org routes × three roles × two plans × five flag-rule shapes is over a thousand end-to-end cases. I don't write them. The rules are data, a route declares its rule, and one function makes every decision, so I test each layer once:

1. **The decision function, exhaustively.** It's pure, so every role × plan × flag-rule shape (thirty combinations) runs in milliseconds, along with invariants: roles nest, entitlements never grant permissions, and a preview is read-only.
2. **The binding, by inventory.** The route-inventory test proves every org route declares a rule, nothing else is mounted under the org path, and settings writes require a management permission.
3. **One persona per rule, end to end.** One real-database case per rule type: a non-member gets 404, a viewer's write gets 403, a starter-plan admin's export gets ENTITLEMENT_REQUIRED, a cross-org ID swap gets 404, a demotion is enforced on the next write.

---

## 📈 What Breaks First (~3 min)

| Rank | Pressure | Evidence | Fix |
|------|----------|----------|-----|
| 1 | Heartbeat reconcile | Each open stream runs a session lookup and a membership query every 20 s. At 60K streams that's 3,000 queries a second, three times the whole API's request rate | Batch per instance: one query for all locally connected users every interval. Better still, compare mirrored versions first and query PostgreSQL only for orgs whose version moved |
| 2 | Bump stampede in a huge org | One flag change in a 50K-member org: about 15K connected tabs receive the hint within a second, each refetches its manifest, every one misses, three queries each, ≈ 45K queries in one second | Client jitter of 0–5 s, since the hint is advisory and the server enforces anyway. Single-flight recomputation per (org, user). Split org-level and user-level versions so the org part is computed once |
| 3 | Conversation table | ≈ 3.6B rows a year; analytics aggregates scan 14–90 days per request | Monthly partitions; analytics from daily rollups or ClickHouse; history stays keyset on PostgreSQL or moves to a search index |
| 4 | Pattern-subscription fan-in | Every instance receives every org's and every user's events, including per-batch export progress, and discards most of them | Subscribe only to channels with local connections, use sharded pub/sub, and throttle progress to one event per second per job |
| 5 | Export throughput and fairness | Claims take the oldest job first, so one org queueing a hundred exports starves the others; batches read from the primary | Per-org concurrency caps with fair claiming, reads from a replica (access checks stay on the primary), files in object storage behind short-lived signed URLs issued only after the authoritative check |

> "The ranking comes from counting, not guessing. Authorization per request is cheap; it's the backstops that cost: the heartbeat that catches lost events, and the burst of refetches that every successful event causes. That's the general lesson of this design. Correctness comes from checks, the checks have a price, and at scale the price shows up in the safety nets first."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Rationale |
|----------|--------|-------------|-----------|
| Tenant enforcement | Gate per route + scope in every query | Fetch then compare in code | A forgotten check returns nothing instead of leaking |
| Non-member answer | 404 | 403 | IDs reveal nothing about other tenants |
| Access axes | Role, plan, flag kept separate | One combined permission | Each "no" gets the right remedy |
| Permission cache | Version in the key, bump in the transaction, 60 s TTL | TTL only / delete on change | Instant invalidation without enumerating keys or racing |
| Writes and copies | Always authoritative | Trust the cache | A stale cache can never change state or produce a file |
| Revocation push | Hints over one multiplexed stream | Pushing new permissions | A lost or reordered message can't grant anything |
| Export queue | Job row, lease and fencing | Message broker | One source of truth at 0.25 jobs/s |
| Export access | Checked at create, publish and download | Create only | A file is a copy that outlives the permission |
| Share links | Hashed token, revoked_at, creator must be a member | Raw token, delete on revoke | A leak isn't a credential; 410 stays explainable |
| Auth | Session cookie, identity only | JWT with roles | Immediate revocation; no stale roles |

---

## 📝 Wrap-up (~1 min)

| Follow-up | Answer |
|-----------|--------|
| A user switches orgs while a request is in flight. What happens to its response? | The server answered correctly for the org in that request's URL and stamped it with X-Org-Id. The client aborts it, drops it if it arrives anyway, and could only ever file it under the old org's cache key. A long operation such as an export is a job and simply continues |
| Where are role checks enforced, and why in both client and server? | Enforcement is server-side only: the gate and the query scope. The client renders the manifest so users see only what they can use and get the right explanation. A 403 from the server refetches that manifest, so a stale client corrects itself |
| A deep link to a page the role can't see? | The page's API answers 403 with the permission and role, and the manifest already says no, so the client shows why plus "request access" (audited) and the user's other orgs. A disabled flag says "not turned on", a plan limit says "upgrade", another org's resource is 404, and an unknown org gets a neutral not-found page |
| Access removed while the page is open: what do they see, and when? | Writes are refused immediately. The page closes with an explanation in about a second through the stream, within 20 s if the push is lost, and cached reads are bounded by 60 s in the worst case |
| How are client caches scoped so two orgs never mix? | Every query key starts with the org ID, every response echoes X-Org-Id and is checked against it, and losing an org removes its whole key prefix |
| How do you test role and flag combinations? | The pure decision function exhaustively, the route binding by inventory, one persona per rule end to end |
| **Key question:** what must be invalidated, and what stays authoritative? | Permission entries (by version), stream subscriptions, sessions when no org is left, and the client's manifest and cache. Meanwhile, writes, downloads, export publication, share-link reads and invitation acceptance all read PostgreSQL |

> "To sum up: access is three separate questions, role, plan and flag, answered by one pure function that both the gate and the client's manifest use. Every query carries the org and the user's projects, so a forgotten check fails closed and another tenant's data is simply 'not found'. Permissions are cached under a version that bumps in the same transaction as the change, so invalidation is one write, and nothing that changes state or makes a copy ever trusts the cache. Pushes over one multiplexed stream make revocation feel instant; checks make it true. With more time I'd split the version into org-level and user-level counters and batch the heartbeat, because those are the first two things a 50K-member org would break."

### How the local implementation compares

The repo runs this design with an Express API (one instance or three on separate ports), a separate export worker process (add a second one to see skip-locked claiming), PostgreSQL and Valkey. The seed creates two fictitious orgs, Lumen Outfitters on the pro plan and Harbor Health Co-op on starter, five users (Alice is an admin in one and a viewer in the other), about 8,500 conversations and one feature flag, the prompt library, enabled for admins and editors at Lumen. The gate, the route inventory, the version-keyed cache with its 60-second TTL and set-if-greater mirror, the multiplexed event hub with heartbeat reconciliation, the removal cascade, hashed single-use invitations, share links, the job-row export queue with 30-second leases, fencing and three attempts, and same-transaction audit events are implemented as described. Verification: 70 unit tests (including all thirty role × plan × flag-shape combinations and the route inventory), 14 integration tests that attempt cross-org access against a real database, a scripted two-user browser check (29 of 29), and 16 smoke tests. The scripted check found two real bugs: the manifest response's own version header invalidated the manifest while it was still in flight, causing an endless refetch loop; and when a member lost their last org, access.revoked made the tab refresh its org list, which could hit a 401 before session.revoked arrived and show the wrong sign-out reason, which is why session.revoked is now published first. Simplifications: export files go to local disk and are never cleaned up, a single PostgreSQL and Valkey replace replicas and a cluster, the hub runs inside the API process, audit retention is a read filter rather than a purge, and only sign-in and the public share-link route are rate-limited. A review of the finished code also closed four gaps: a preview stored on the session now applies only while the user is still an admin (otherwise a demoted admin previewing a higher role kept that role's reads), export files are named per attempt so a stalled worker can't touch its successor's file, conversation cost now needs the plan entitlement as well as the permission, and invitations are one pending per address. One gap I'd still close before production: a removed member's private prompts are hidden from everyone rather than transferred.

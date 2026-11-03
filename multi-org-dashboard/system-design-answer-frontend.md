# Multi-Org Dashboard — System Design Answer (Frontend Focus)

*Senior frontend / product engineer interview · 45–50 minutes · structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations*

> "This is the console of a multi-tenant AI product: one person belongs to several organizations, has a different role in each, and sees features that are switched on per organization and per role. Drawing the sidebar is easy. The hard part is that the same browser tab holds data from several tenants over its lifetime, and the user's rights can change while a page is open. So I'll spend the time on three things: switching orgs without ever mixing their data, one permission source that the routes, sidebar and buttons all read, and what the user sees when access changes under them. The server enforces everything. The client's job is to never show something it shouldn't, and to explain itself when a door closes."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| R — Requirements | ~5 min | Personas, numeric targets, the trap I'm avoiding |
| A — Architecture | ~7 min | Screen layout, client layers, the server contract the client depends on |
| D — Data model | ~6 min | The manifest, the three kinds of client state, the URL as state |
| I — Interface | ~5 min | Endpoints, the status codes the UI branches on, the event stream |
| O — Optimizations | ~20 min | Three deep dives, plus testing, preview mode, branding, traces |
| Wrap-up | ~2 min | Trade-offs, what breaks first, what I'd do next |

---

## 🎯 R — Requirements Exploration (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Can one user be in several orgs at once? | Cache scoping, switching, URL design | Yes, with a different role in each; most users have 1–3, consultants up to 50 |
| Are roles fixed or custom? | Whether the client can hard-code role names | Three built-in roles today (admin, editor, viewer); custom roles later, so the UI reads permissions, never role names |
| What decides a feature's visibility? | Where flags and plans are evaluated | Three separate things: the role's permissions, the org's feature flags (per org and role), and the plan's entitlements |
| How fast must a revocation take effect? | Push vs poll, cache lifetimes | Writes are refused at once; an open page reflects the change within seconds |
| How big is conversation history? | Pagination and rendering strategy | Millions of conversations per large org; filtered lists of hundreds of thousands |
| Can a support engineer act as a customer? | Impersonation and audit | Admins can preview the console as another role, read-only |
| Is the console white-labelled? | Theming scope | Light branding: an accent color and initials, not custom layouts |

### The personas, and what each does

1. **Admin (Alice in Lumen Outfitters):** manages members, roles, invitations and share links, reads the audit log, toggles beta features for roles, sees billing and cost analytics.
2. **Editor (Ben):** builds agents, edits the knowledge base, exports conversation history, shares prompts with roles or by link.
3. **Viewer (Dev):** reads agents, conversations and analytics. Nothing else.
4. **Multi-org user (Alice again):** admin in Lumen, viewer in Harbor Health Co-op. She switches between them dozens of times a day and must never see a Lumen row while looking at Harbor.

### Non-functional requirements

| Property | Target | Why this number |
|----------|--------|-----------------|
| Org isolation in the UI | Zero renders of org A data under org B's URL | A single leaked row is a security incident in a multi-tenant product |
| Org switch | Shell and first module painted ≤ 400 ms p95 with a warm manifest | Switching is a navigation, used constantly by consultants |
| Revocation, open page | ≤ 5 s p95 to close a view the user lost; writes refused immediately | Admins remove access during incidents; "eventually" isn't acceptable |
| History scroll | 60 fps with 100k loaded rows; first page ≤ 500 ms | Support leads scan thousands of conversations |
| Deep links | Every view reproducible from its URL, including filters and the open detail pane | Links get pasted into tickets and chat |
| Accessibility | WCAG 2.2 AA; access changes announced, not just repainted | A view that silently disappears is disorienting for everyone, worse with a screen reader |

**Out of scope:** the agent runtime itself, payment flows, SSO/SCIM provisioning (I'll mention where it plugs in).

> "The known trap is treating hidden buttons as security. I'll say it once and build on it: the API checks every request, and filters every query by org and by the projects the user can access. Everything the client does with permissions is about honesty and comfort: not offering what will fail, and explaining what changed."

---

## 🏗️ A — Architecture (~7 min)

### Screen layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ (!) Previewing Lumen as Viewer. Read-only.               [Exit preview]      │ ← only in preview
├──────────────────────────────────────────────────────────────────────────────┤
│ Relay  [LO Lumen Outfitters ▾] Admin     Exporting… 42% ▓▓░   View as ▾ Alice│
├──────────────┬───────────────────────────────────────────────────────────────┤
│ Overview     │ Conversations                                 [Export CSV]    │
│ Agents       │ [search____] [escalated ▾] [any channel ▾] [agent ▾] [dates]  │
│ Knowledge    │ ┌──────────────────────────────────┐ ┌──────────────────────┐ │
│ Conversations│ │ Started   Subject        Status  │ │ Promo code not apply…│ │
│ Analytics    │ │ 07:59 PM  Promo code…  escalated │ │ Customer · Agent ·   │ │
│ Prompts Beta │ │ 07:50 PM  Where is my… escalated │ │ CUSTOMER: …          │ │
│ Exports      │ │ … virtualized rows …             │ │ AGENT: …             │ │
│ Billing      │ │ Showing 100 of 736               │ │                      │ │
│ Settings     │ └──────────────────────────────────┘ └──────────────────────┘ │
│ Access v7    │                                         Toasts: "Export ready"│
└──────────────┴───────────────────────────────────────────────────────────────┘
```

The org switcher sits top-left because it changes everything below it. The role badge sits next to it, so "why can't I do this?" has a visible answer before anyone asks. The sidebar is computed from the manifest. Locked modules (on the plan, not the role) show a lock instead of disappearing, so upgrades are discoverable. The detail pane opens beside the list, not over it, so the filtered context survives.

### Client layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ Router: /orgs/$orgId/<module>[/<id>]?filters                         │
│   beforeLoad(org route) ─▶ switchOrg(orgId)                          │
├──────────────────────────────────────────────────────────────────────┤
│ Org layout: fetches the manifest, provides {orgId, manifest},        │
│ applies branding, subtree keyed by orgId                             │
│   ModuleGate / TabGate ─▶ decide(manifest, requirement)              │
├───────────────────────────────┬──────────────────────────────────────┤
│ Query cache (TanStack Query)  │ Session stores (Zustand)             │
│ keys: ['org', orgId, ...]     │ auth: user, org list, end reason     │
│                               │ access: revoked orgs, lost modules   │
├───────────────────────────────┴──────────────────────────────────────┤
│ API client: orgRequest(orgId, path)                                  │
│   signal = this org visit's AbortController                          │
│   after response: drop if org changed; check X-Org-Id;               │
│   report X-Authz-Version; 401 → sign in; 403 → refresh manifest      │
├──────────────────────────────────────────────────────────────────────┤
│ Event stream: one SSE per tab, all orgs, invalidation hints only     │
└──────────────────────────────────────────────────────────────────────┘
```

### Routes and what guards them

| Route | Module | Requirement (read from the manifest) |
|-------|--------|--------------------------------------|
| `/orgs/$orgId` | Overview | org.read (every member) |
| `/orgs/$orgId/agents`, `/knowledge` | Agents, Knowledge base | agents.read, knowledge.read |
| `/orgs/$orgId/conversations[/$id]?filters` | History + detail pane | conversations.read |
| `/orgs/$orgId/analytics` | Analytics | analytics.read; the cost tile also needs analytics.cost and the plan |
| `/orgs/$orgId/prompts?prompt=` | Prompt library | prompts.read **and** flag prompt_library |
| `/orgs/$orgId/exports` | Exports | conversations.export **and** the exports entitlement |
| `/orgs/$orgId/billing` | Billing | billing.read |
| `/orgs/$orgId/settings/{members,invitations,links,audit,features}` | Settings tabs | members.read, then a permission per tab |
| `/login?redirect=`, `/invite/$token`, `/share/$token` | Public | none; the share page needs no session |

The table is data in the client (a module registry), not a set of `if` statements in components. The sidebar renders it, the guards enforce it, and adding a module means adding a row.

### The server contract the client depends on

Three things, and I'd negotiate them with the backend team before writing UI. (1) **A manifest per org**, computed by the same code that enforces access. (2) **Distinct status codes:** `401` (no session), `404` (not a member, or the resource isn't in your org: indistinguishable on purpose), `403` with a machine-readable code (`FORBIDDEN`, `FEATURE_DISABLED`, `ENTITLEMENT_REQUIRED`, `READ_ONLY`). (3) **A version on every org-scoped response** (`X-Authz-Version`), bumped whenever memberships, roles or flags change. That header lets the client notice it's behind even when the event stream is down.

---

## 💾 D — Data Model (~6 min)

### The manifest, as the client sees it

| Field | Example | Used by |
|-------|---------|---------|
| org | id, name, plan, branding (accent key, initials) | Switcher, theme, billing copy |
| role / actualRole / readOnly | viewer / admin / true | Role badge, preview banner, disabling writes |
| permissions | org.read, agents.read, conversations.export, … | Route guards, sidebar, every action button |
| flags | prompt_library: true | Hiding beta modules |
| entitlements | exports: false, seats: 10, auditRetentionDays: 30 | Lock icons and upgrade prompts |
| projects | the projects this user can see | Project pickers, and a hint for empty lists |
| version | 7 | Detecting staleness |

### Three kinds of client state, and where each lives

| State | Where | Lifetime | Why there |
|-------|-------|----------|-----------|
| What the user is looking at: org, module, filters, open conversation | URL | As long as the link | Deep links, back button, sign-in round trips |
| Server data: manifest, lists, details, exports | Query cache keyed `['org', orgId, …]` | Kept 5 min after use, for fast switch-back | Two orgs can never share an entry; dropping an org is one call |
| Session facts: user, org list, revoked orgs, modules lost this session, toasts | Small Zustand stores | The tab | Needed across orgs, and to explain what changed |

The one rule I'd write on the whiteboard: **every query key starts with the org ID.** There is no "current org" global that a fetcher reads at call time. A fetcher that took the org from a global would happily fetch Harbor data into a Lumen key if the global changed mid-flight; a fetcher that takes the org from its own key can't.

### The lifecycle of one org visit

```
  navigate to /orgs/B/...
          │
          ▼
  ┌───────────────┐  abort A's requests,   ┌──────────────────┐   manifest 200   ┌─────────┐
  │  switching    │──cancel A's queries───▶│ loading manifest │─────────────────▶│  ready  │
  └───────────────┘                        └──────────────────┘                  └────┬────┘
                                              │ 404                                   │
                                              ▼                         authz.changed │ / 403 /
                                     ┌──────────────────┐               newer version │
                                     │  org unavailable │◀── access.revoked ──────────┤
                                     │ (other orgs list)│                             ▼
                                     └──────────────────┘                   ┌──────────────────┐
                                                                            │ refetch manifest │
                                                                            │ lost modules →   │
                                                                            │ explanation      │
                                                                            └──────────────────┘
```

Nothing under the org renders until the manifest is ready, and an org the user was removed from never returns to "ready" without a fresh membership.

### Entities

| Entity | Key fields the UI uses | Notes |
|--------|------------------------|-------|
| Org | id (in URL), name, plan, branding | The only tenant boundary |
| Project | id, name, restricted | Restricted projects visible to admins and their members |
| Membership | user, org, role | One per org; the org list shows the role per org |
| Agent, knowledge doc, prompt | id, project, owner | Resources; always within a project |
| Conversation | id, started, status, channel, agent, CSAT | Millions; read by cursor |
| Share link | hint (last 4 chars), expiry, revoked at | The raw token is shown exactly once |
| Invitation | email, role, status, expiry | Accept link shown once to the admin |
| Audit event | actor, action, target, before → after | Admin-only, retention by plan |
| Export job | filters, status, processed/total, file | Progress pushed over the stream |

---

## 🔌 I — Interface Definition (~5 min)

```
POST /api/v1/auth/login                     → session cookie, user, org list
GET  /api/v1/auth/me                        → user + org list (role per org)
GET  /api/v1/events                         → SSE: hello, versions, authz.changed, role.changed,
                                              access.revoked, export.*, session.revoked
GET  /api/v1/orgs/:orgId/manifest           → permissions, flags, entitlements, projects, version
POST /api/v1/orgs/:orgId/preview            → admin "view as role" (stored on the session)
GET  /api/v1/orgs/:orgId/conversations      → ?status&channel&agentId&q&from&to&cursor&limit
GET  /api/v1/orgs/:orgId/conversations/:id  → transcript (cost only for roles allowed to see it)
POST /api/v1/orgs/:orgId/exports            → Idempotency-Key header; 202 queued job
GET  /api/v1/orgs/:orgId/exports/:id/download → re-checks access, streams CSV
POST /api/v1/orgs/:orgId/access-requests    → "Request access" from a 403 page
GET|PATCH|DELETE /api/v1/orgs/:orgId/members[/:userId]   → admin
GET|POST|DELETE  /api/v1/orgs/:orgId/invitations[/:id]   → admin
GET|DELETE       /api/v1/orgs/:orgId/links[/:id]         → admin, or the link's creator
GET  /api/v1/orgs/:orgId/audit              → ?action&before (keyset)
PUT  /api/v1/orgs/:orgId/features/:flagKey  → enabled + roles
GET  /api/v1/shared/:token                  → public prompt by link (404 unknown, 410 revoked)
```

### What the UI branches on

| Response | Meaning | What the user sees |
|----------|---------|--------------------|
| 401 UNAUTHENTICATED | Session ended | Sign-in page with the reason, then back to the exact URL |
| 404 on the manifest | Not a member, or no such org | "Organization not found" plus the user's other orgs; never says which |
| 404 on a resource | Not in this org, or in a project you can't see | "This doesn't exist, or it's in a project you can't access" |
| 403 FORBIDDEN | Role lacks the permission | Explains the role, offers Request access and other orgs; refetches the manifest |
| 403 FEATURE_DISABLED | Flag off for this org and role | "Isn't turned on here" |
| 403 ENTITLEMENT_REQUIRED | Plan doesn't include it | "Part of the Pro plan", with View plans for admins |
| 403 READ_ONLY | Admin is previewing as another role | Buttons were already disabled; this is the backstop |
| 410 on a share link | Revoked or expired | "This link was revoked"; ask the owner for a new one |

### The event stream

One stream per tab, opened after sign-in and kept across org switches; each event names its org and the client routes it.

| Event | Client reaction |
|-------|-----------------|
| hello / versions (on connect, every 20 s) | Refetch any cached manifest older than the version listed |
| authz.changed {org, version, reason} | Refetch that org's manifest if behind; remember the reason |
| role.changed {org, from, to} | Toast "Your role in Lumen is now Viewer"; remember from/to for explanations |
| access.revoked {org} | Remove every cached query for that org; mark it revoked; refresh the org list |
| membership.added {org, role} | Refresh the org list; toast "You joined Harbor as Viewer" |
| export.progress / completed / failed | Patch the exports list in place; toast with Download on completion |
| session.revoked | Go to sign-in with "Your access was removed" |

---

## 🔧 O — Optimizations and Deep Dives (~20 min)

> "Three deep dives: switching orgs with requests in flight, one permission source with mid-session revocation, and history plus export at scale. Each has a tempting alternative that breaks in a specific way."

### Deep dive 1: Switching orgs with requests in flight, and cache scoping (~7 min)

**Decision.** The org ID lives in the URL (`/orgs/org_lumen/conversations?status=escalated`) and is the first element of every query key. A switch is just a navigation. The org route's `beforeLoad` runs before any page of the new org mounts. It cancels every query of the old org through the query cache, then aborts a per-org-visit `AbortController` that every org-scoped request was bound to. A response that still arrives is checked against the active org before it's parsed and is dropped if the org changed. The org layout's subtree is keyed by org ID, so no component state (an open form, a selected row) survives the switch either.

**Follow-up: "A user switches orgs while a request is in flight. What happens to its response?"** Three layers, any one of which would be enough for display safety. (1) The request is aborted: the old org's controller fires, the browser cancels the fetch, and the cache restores that entry's previous state rather than marking an error. (2) If the response had already arrived and is being read, the client compares the request's org with the active org and throws it away. (3) Even if both failed, the data would land in the `['org', 'org_lumen', …]` entry, which nothing on a Harbor page reads. For mutations, the side effects in success callbacks (closing a dialog, navigating) check that their org is still active, because "Agent created" must not close a dialog in the new org.

**Follow-up: "How are client caches scoped so data from two orgs never mixes?"** By construction, not by discipline: keys come from one key factory whose every function starts with the org, and a unit test asserts it. Three subtler leaks I'd call out: "keep previous data while new filters load" must only keep data from the *same* org, or switching shows the old org's rows for a frame under the new URL; filters and resource IDs are dropped on switch, because a Lumen agent ID in a Harbor filter is at best a 404; and the browser's own caches matter too, so every org-scoped response is `private, no-store`.

**Why the alternatives break.**

- *A global "current org" in a store, with keys that omit it.* Every fetcher reads the global at call time. Alice switches while the conversations list is loading: the response for Lumen arrives and is written into the key `['conversations']`, which the Harbor page renders. That's exactly the incident we can't have, and it only shows up under latency, so it passes every local test.
- *Clear the whole cache on every switch.* Safe, but consultants switch constantly and every switch-back becomes a cold load. It also doesn't solve in-flight responses: a response arriving after the clear repopulates the cache under a key without the org.
- *Full page reload on switch.* Bulletproof isolation and simple, but it costs a second of blank screen per switch, kills the event stream and any running export notifications, and loses unsaved drafts in other panels.

| Approach | Mixing possible? | Switch-back cost | In-flight responses | Complexity |
|----------|------------------|------------------|---------------------|------------|
| ✅ Org in URL and every key, abort + drop | No | Instant (cached, still gated by manifest) | Aborted, then dropped | Key factory, scope controller |
| ❌ Global current org | Yes, under latency | Instant | Land in the wrong place | Low, until the incident |
| ❌ Clear cache on switch | Rarely | Cold load | Can repopulate | Low |
| ❌ Reload the page | No | Full reload | Gone | Lowest, worst UX |

**What I give up.** Memory: several orgs' data can sit in the cache at once, so I cap retention at five minutes after last use and remove everything for an org the moment access to it is revoked. And a small amount of ceremony: every hook takes the org from context instead of a global, and every mutation's side effects check the org.

### Deep dive 2: One permission source, and access changing mid-session (~8 min)

**Decision.** The server returns one manifest per org. The router's guards, the sidebar, the settings tabs and every action button call the same pure function, `decide(manifest, requirement)`, which returns allowed or a reason: missing permission, flag off, or plan lacks it. Guards wrap every module route; buttons ask `useCan(permission)`, which also returns false in a read-only preview.

**Follow-up: "Where are role checks enforced, and why in both places?"** The server is the enforcement: a middleware on every org route checks membership, permission, flag and entitlement, and every query is filtered by org and accessible projects, so a forged request gets `404` or `403` no matter what the UI showed. The client checks for honesty and comfort: it doesn't offer actions that will fail, and it explains why something is missing. Because both sides derive from one manifest computed by the server's own access code, they can't drift. Hard-coding "admins see Billing" in the client would drift the first time someone adds a billing role.

**Follow-up: "A user opens a deep link to a page their role can't see. What do they get?"** The guard renders a 403 page instead of the module: "You don't have access to Billing. Your role in Harbor Health Co-op is Viewer, which doesn't include billing." It offers Request access (recorded in the admin audit log) and a list of the user's other orgs, with their roles. If the module is off for the org's plan, it says "Part of the Pro plan" and links admins to Billing. If it's a flag, it says the feature isn't turned on here. If they're signed out, they sign in first and come back to the same deep link. If it's another org's resource, they get the neutral not-found message.

**Follow-up: "An admin removes access while the user has the page open. What do they see, and when?"** Within about a second: the server commits the change and bumps the org's authz version in the same transaction, then publishes a hint. The user's tab receives `authz.changed` (and `role.changed` with from and to) and refetches the manifest. The layout compares the new manifest with the previous version and records which modules were lost. A page the user lost is replaced by "Billing is no longer available to you: your role in Lumen changed from Editor to Viewer at 8:06 PM, so this page was closed. Changes you hadn't saved here were not sent." An edit form whose permission was lost turns read-only *with the user's text still in it*, so they can copy it. If the user is removed from the org entirely, the tab gets `access.revoked`: every cached query for that org is removed, and the page becomes "You no longer have access to Lumen Outfitters" with the orgs they still have. If that was their last org, the server ends all their sessions and the tab goes to sign-in with "Your access was removed."

```
 Admin tab          API + PostgreSQL              Valkey          Ben's tab
    │ PATCH role=viewer │                            │                 │
    │──────────────────▶│ BEGIN; update role;        │                 │
    │                   │ version 6→7; audit; COMMIT │                 │
    │                   │──── mirror v7, publish ───▶│── authz.changed ▶│ manifest v6 < 7
    │◀── 200 ───────────│                            │── role.changed ─▶│ toast
    │                   │◀──────────── GET manifest (cache miss at v7) ──│
    │                   │─────────────── manifest v7: viewer ───────────▶│ lost: exports, settings
    │                   │◀──────── POST agents (stale button) ───────────│ page → explanation
    │                   │ write re-reads membership: viewer → 403 ──────▶│
```

**The key question: what cached state must be invalidated, and what stays authoritative meanwhile?** Client side: the manifest for that org, every query for that org on removal, the org list in the switcher, and any open write UI. Server side: the permission cache entry, which is keyed by version so the bump makes old entries unreachable. Before any of that completes, the server stays authoritative where it matters: **every write re-reads membership from the database**, never the cache, and so do downloads, export workers (at start and before publishing the file) and share-link lookups. A stale tab can therefore *show* a page for a second or two, but it can't change anything or extract a file.

**When the event never arrives.** The stream is a hint, not the mechanism. Three backstops: every org response carries the current version, so the next request of any kind triggers a manifest refetch; any `403` triggers one; and the stream's heartbeat carries versions every 20 seconds. The worst case without the stream is "until the user's next click", and the write is refused regardless.

**A real defect this design produced.** In the build, the manifest response itself carried the version header. When an event made the client refetch the manifest, the response's header said "you're behind", which invalidated the manifest again, cancelling the very fetch that would have caught it up. The scripted test saw over eleven thousand requests in a few seconds. The fix had two parts: the manifest's own response doesn't report its version, and invalidations join a refresh already in flight instead of restarting it. The lesson I'd tell an interviewer: any "refetch when stale" signal must not be emitted by the refetch itself.

**Why the alternatives break.**

- *Permissions in the session or a JWT.* The client is consistent with itself, but a role change waits for token expiry. With 15-minute tokens, a removed contractor keeps reading for 15 minutes; with short tokens, everyone refreshes constantly. It also can't express per-org flags without bloating the token.
- *Per-component permission calls.* Each button asks the API "can I?". Hundreds of requests per page, and the sidebar and the page can disagree mid-change because they asked at different moments.
- *Poll the manifest every N seconds.* At 60 seconds it's too slow for an incident, and at 5 seconds, 50,000 open tabs make 10,000 manifest requests per second for changes that happen a few times a day.

| Approach | Revocation on open page | Consistency of UI parts | Server load | Cost |
|----------|-------------------------|-------------------------|-------------|------|
| ✅ One manifest + version + SSE hints | ~1 s; next request if stream down | One decision function | One fetch per change | Event plumbing, loss tracking |
| ❌ Permissions in JWT | Token lifetime | Consistent but stale | Low | Slow revocation |
| ❌ Ask per component | Next click | Can disagree | Very high | Chatty |
| ❌ Poll manifest | Poll interval | Consistent | High at scale | Waste |

**What I give up.** A persistent connection per tab, and the complexity of explaining losses: the client keeps "modules lost this session" so it can say "no longer available" instead of a generic 403, and it has to forget them when access comes back.

### Deep dive 3: History and export at scale (~5 min)

**Decision.** Conversation history is cursor-paginated (newest first, keyed on start time plus ID), filters live in the URL, and the table is virtualized: only the visible rows plus a dozen of overscan are in the DOM. The next page loads when the user scrolls within 25 rows of the end. The first page also returns a capped count ("Showing 100 of 10,000+"), because counting every match exactly is the slowest part of a filtered list. A deep link `/conversations/<id>?status=escalated` renders the filtered list *and* opens the detail pane, which fetches the conversation on its own: the row may not be in the loaded pages, or may not even match the filter.

**Why cursors and not offsets.** New conversations arrive constantly at the top. With offsets, page 2 shifts down while you read page 1, so rows repeat or vanish at page boundaries, and `OFFSET 200000` makes the database walk 200,000 rows. The cursor is a position, so it's stable under inserts and costs the same at any depth. What I give up is "jump to page 40": the UI offers date filters instead, which is what support leads actually use.

**Why export is a job, not a download link.** Exporting 400,000 rows takes longer than any HTTP timeout and would hold an API worker. The button posts the current filters with an idempotency key, created at click time and reused if the request is retried, so a lost response can't start two exports. The header shows "Exporting… 42%" from progress events on the stream; completion pops a toast with a Download link, even if the user has switched to another org since, because events carry their org. The server checks access again when the job starts, before it publishes the file, and at download, so a user removed mid-export never gets the file.

**What breaks if I skip virtualization.** Each row is about 12 DOM nodes. A support lead who scrolls through 5,000 rows creates 60,000 nodes, and every filter change re-renders all of them: input lag, then memory pressure. Virtualized, the DOM stays around 40 rows whatever they scroll.

### The prompt-sharing variant

The same console, with the modules replaced by a prompt library. A prompt is private to its owner, shared with named roles in the org, or shared by link. I model these as two independent things: role sharing is a list of roles on the prompt (empty means private), and links are separate revocable grants, so a prompt can be shared with editors *and* have a link for an outside reviewer. The sharing panel shows role checkboxes to the owner only; creating a link shows the full URL exactly once ("Copy this link now. It won't be shown again"), because only a hash is stored; the list afterwards shows the last four characters, who created it, and when it was last opened.

**Revoking while someone has it open.** A sharing change is about one resource, so it doesn't bump the org's authz version; bumping it would refetch every member's manifest on every share click. Instead, the next fetch of that prompt returns 404 and the panel says "This prompt doesn't exist or isn't shared with you." For a link, the public page answers 410 on its next load: "This link was revoked. Ask the person who shared it for a new link." If the owner is removed from the org, their links are revoked in the same transaction, and link lookups also refuse any link whose creator is no longer a member, as a second line of defence. If someone must lose an open view instantly (a leaked prompt), I'd add a per-resource event that the viewing tab subscribes to while the panel is open.

### Testing role × flag combinations without testing every permutation

Three roles, two plans and a flag on or off already make 12 combinations, and custom roles make it unbounded. I'd test the **rules**, not the permutations. (1) The decision function is pure, so a unit test iterates every role × plan × flag shape and asserts the sidebar and the guard agree for every module. That runs in milliseconds, on both the server's access computation and the client's `decide`. (2) Each *rule* gets one end-to-end persona: hidden by role, locked by plan, hidden by flag, allowed. That's four browser tests, not 12. (3) A route inventory test on the server fails if any org route was registered without an access rule. (4) The scripted cross-org tests swap IDs between orgs on every resource type. New roles then add rows to the pure tests, not new browser runs.

### Preview and impersonation (read-only mode)

Admins can "View as" another role. The server stores the preview on the session and computes the manifest for that role with `readOnly` set, so the sidebar and buttons change instantly from the same code path that real viewers use; that's the point, the admin sees *exactly* what a viewer sees. A banner says "Previewing Lumen as Viewer. Read-only" with Exit. Every write is refused with `READ_ONLY` server-side, so a stale button can't slip through. For true support impersonation (staff acting as a specific customer user), I'd add a separate, audited impersonation session with the real actor recorded on every audit event, a time limit, and a different banner color, and I'd keep it read-only by default.

### Per-org branding without fragile UI

An org picks an accent from a fixed palette and gets initials for its badge. The org layout maps the palette key to CSS variables whose shades were chosen for contrast with white text; components only ever use the brand variables. Tenants never supply raw colors, CSS, fonts or layout, so a tenant can't break contrast, inject styles, or make a screenshot ambiguous about which org it shows. The badge and accent also help the multi-org user notice at a glance which org they're in, which is a safety feature as much as branding.

### Accessibility

Access changes are announced (`role="alert"` on the "no longer available" panel), and focus moves to its heading. The detail pane moves focus to its title on open and closes on Escape. The virtualized list keeps row semantics so screen readers announce position. Lock icons have text alternatives ("Not on your plan"), and disabled buttons say why in a tooltip and in visible text where space allows.

### Failure and degradation

| Condition | What the user sees |
|-----------|--------------------|
| Event stream down | Nothing visible; access changes are caught on the next request (version header) or the next heartbeat after reconnect |
| Session expired mid-task | Sign-in with the reason, then back to the same URL with filters and the open pane |
| Manifest fetch fails | Shell with an error and retry; no module renders without a manifest |
| Export worker dies | Progress pauses; another worker restarts the job after its lease expires; failure after three attempts shows a toast |
| Access lost during an export | Export fails with "You no longer have permission to export from this organization"; no file is produced |
| Share link revoked while someone has it open | Their next load says "This link was revoked" |

### Two execution traces

**Success: switching mid-request.** (1) Alice, on Lumen's conversations, changes the status filter. The list request for Lumen starts, bound to the Lumen visit's controller. (2) She opens the switcher and picks Harbor. The router navigates to `/orgs/org_harbor/conversations`, dropping the filter. (3) `beforeLoad` cancels Lumen's queries and aborts Lumen's controller; the browser cancels the fetch. (4) The layout fetches Harbor's manifest (role: viewer), brands the shell violet, and renders five modules. (5) Harbor's list loads into `['org', 'org_harbor', 'conversations', {}]`. (6) Had Lumen's response slipped past the abort, the client would have compared its org with the active org and dropped it. In the scripted test, with Lumen's response held for 2.5 seconds, zero Lumen rows appeared.

**Failure: demoted while editing, then removed.** (1) Ben, an editor, has an agent's instructions open with unsaved text. (2) Alice changes his role to viewer. The server updates the role, bumps the version and writes the audit event in one transaction, then publishes. (3) Ben's tab gets `role.changed` (a toast says "Your role in Lumen Outfitters is now viewer") and `authz.changed`; it refetches the manifest. (4) The editor turns read-only and keeps his text; the New agent button disappears; the Exports page, had he been on it, is replaced by an explanation. (5) He tries a stale request anyway: the server re-reads his membership and answers `403`. (6) Alice then removes him. The removal transaction revokes his share links and pending invitations and cancels his exports. His tab gets `access.revoked`, removes every Lumen query, and shows "You no longer have access to Lumen Outfitters" with Harbor, where he's still a member, as the way out. His shared prompt link now answers 410.

### Design review checklist, briefly

| Question | Answer from the client's side |
|----------|-------------------------------|
| Source of truth; when is a write successful? | PostgreSQL; the UI treats a write as done only on the server's response, never optimistically for permission-changing actions |
| Retry after a lost response? | Exports carry an idempotency key reused across retries; role changes and removals are naturally idempotent (setting a role twice is the same state) |
| Failure between two steps? | Server changes and their audit events commit together; the event is published after commit, and the version header covers a lost event |
| Required ordering? | Only that a manifest never moves backwards: the client ignores nothing newer and refetches anything older |
| Access with caches, indexes, jobs? | Server cache keyed by version; writes, downloads, jobs and share links check the database; client caches keyed by org and dropped on revocation |
| What breaks first at scale? | See below: version-bump stampedes and per-tab connections |

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Org identity | Org ID in URL and every query key | Global current-org state | Mixing impossible by construction |
| Switch | Navigation; abort old org's requests, drop late responses | Clear cache / reload page | Isolation without cold reloads |
| Permission source | One server manifest per org | Role names in client code / per-button calls | Guards, sidebar, buttons can't disagree |
| Freshness | Version header + SSE hints + refetch on 403 | Short JWTs / polling | Seconds to reflect, writes refused at once |
| Not a member | 404 | 403 | Doesn't reveal that an org or resource exists |
| Plan vs role | Separate entitlement axis, shown as a lock | Folded into permissions | "Upgrade" and "ask an admin" are different answers |
| Lost access on open page | Replace view with explanation, keep drafts | Redirect home / generic error | User knows what happened and loses no work |
| History | Cursor pages, URL filters, virtualized table | Offset pages / render everything | Stable under inserts, constant DOM |
| Export | Background job, idempotency key, progress events | Synchronous download | No timeouts; access re-checked at every step |
| Branding | Palette key + initials | Tenant-supplied CSS | Can't break contrast or layout |

---

## 📈 What Breaks First, and What I'd Do Next (~2 min)

**What breaks first at scale.**

- **The version bump stampede.** A flag change in a 50,000-member org bumps one version, and every open tab refetches its manifest within a second: up to 50,000 requests, all permission-cache misses at once. I'd add jitter to the client's refetch (0–3 s) and coalesce the server's recomputation per user. The evidence: the permission cache's miss counter spiking right after flag changes.
- **One connection per tab.** Users with ten tabs hold ten streams. A BroadcastChannel with one leader tab owning the stream would cut connections and dedupe toasts.
- **Manifest size with custom roles.** Hundreds of fine-grained permissions and per-project overrides make the manifest large. I'd ship permissions per module on demand, keeping the shell's manifest small.
- **History beyond the cursor.** Free-text search across millions of conversations needs a search index; the list API would stay the same, with the cursor becoming the index's search-after value.

**With more time:** prefetch the manifest when the user hovers an org in the switcher, so switching is instant; a "request access" flow that notifies admins rather than only logging; keyboard navigation of the history table; and saved filter views per user.

---

## 📝 Wrap-up

> "To summarize: the org is part of every URL and every cache key, so switching can abort and drop the old org's work without ever showing it. One manifest, computed by the server's own access code, drives the routes, sidebar and buttons, and the client keeps it fresh with a version header, a hint stream, and a refetch on any 403. When access changes, open views explain themselves and keep the user's text, while the server refuses writes from the first moment because writes never trust a cache. History scales with cursors and virtualization, exports run as jobs that re-check access, and the hardest calls were answering 404 instead of 403 for other orgs, keeping plan entitlements separate from roles, and treating every push event as a hint rather than the truth."

### How the local implementation compares

The repo's `frontend/` implements this answer: org-scoped keys in `lib/keys.ts`, the per-visit abort and late-response drop in `lib/org-scope.ts` and `services/api.ts`, the switch in the org route's `beforeLoad`, `decide()` and the module registry in `lib/modules.ts`, loss tracking and explanations in `hooks/useManifestWatcher.ts` and `components/access/`, the virtualized history with a deep-linked pane, background exports with progress, and admin preview. A scripted two-user check (`scripts/two-user-check.mjs`) drives the real stack through a switch with a held response, a flag turned off, a demotion during an edit, removals with and without another org, deep links, and an export; all 29 checks pass, and it found the manifest refetch loop described above. Gaps: no BroadcastChannel leader tab, no refetch jitter, the org switch shows a loading state instead of prefetching the next org's manifest, Request access only writes an audit event, and the history table has no keyboard row navigation.

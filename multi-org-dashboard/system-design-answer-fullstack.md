# Multi-Org Dashboard — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · the console of a multi-tenant AI product, where one user has a different role in each organization*

> "The screens look like any admin console: an org switcher, a sidebar, some tables. What makes this one hard is that the same person is an admin in one org and a viewer in another, features switch on per org and per role, and an admin can change any of that while the page is open. So I want one rule everywhere: the server decides, from one source of truth, and the client renders that decision quickly, scoped to one org, and honestly when it changes. Most of my time will go to the seams: a request still in flight when you switch orgs, a browser cache holding two tenants' data, and a page that's open when your access goes away."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements and scope | ~4 min | Who uses it, what "access" means, revocation targets |
| Product, entities, authorization model | ~7 min | Role, plan and flag as separate axes; one manifest per org |
| API and architecture | ~5 min | One server gate, version headers, one event stream per tab |
| Client state and org switching | ~4 min | Org ID in the URL and every cache key; aborts and late-response drops |
| Traces | ~6 min | A deep link plus an org switch; a demotion while a page is open |
| Deep dives | ~12 min | One permission source end to end; mid-session revocation; history at scale |
| Variant, testing, checklist, scale, wrap-up | ~7 min | Prompt sharing, the six review questions, what breaks first, the follow-ups |

---

## 🎯 Requirements and Scope (~4 min)

### Clarifying questions (and the answers I'll assume)

| Question | Assumption | Design consequence |
|----------|------------|--------------------|
| What is the product? | Relay, a platform where companies build customer-support agents | Modules: agents, knowledge base, conversation history, analytics, billing, settings |
| Can one user be in several orgs? | Yes, with a different role in each | The role belongs to the membership; the org ID is in every URL and every cache key |
| Which roles? | Admin, editor, viewer | The client decides with named permissions, never with role names |
| What else gates a feature? | The plan (exports, cost analytics, seats) and feature flags per org and role | Three separate reasons for "no", each with its own message |
| How fast must lost access take effect? | Writes refused at once; open pages close within seconds | Server checks plus a push channel plus versions on every response |
| Is prompt sharing in scope? | Yes: prompts private, shared with roles, or shared by revocable link | A resource-level model on top of org roles |
| How big is history? | Millions of conversations in a large org | Cursor pagination, virtualization, exports as background jobs |

### Functional requirements

1. Sign in, see my orgs, switch between them, and land in the last org I used.
2. A sidebar and pages per module, showing only what my role, my org's plan and its flags allow.
3. Deep links work: to a page, to a filtered list, to one conversation's detail pane over that list.
4. Admins manage members, invitations, share links and feature flags, read the audit log, and can preview the console as another role.
5. When my access changes mid-session, the UI updates without a reload, and a page I can no longer use explains why instead of going blank.
6. Conversation history with filters in the URL, infinite scrolling, and CSV export as a background job with progress and a notification.
7. A prompt library behind a flag, with private, role-shared and link-shared prompts.

**Out of scope:** the agent runtime that produces conversations, real billing, and SSO.

### Non-functional requirements

| Property | Target |
|----------|--------|
| Isolation | No data from one org ever rendered or cached under another; cross-org IDs return 404 |
| Revocation | Writes refused on the next request; open pages updated in about 1 s, at most 20 s if a push is lost |
| Org switch | Old org's requests aborted at once; the new org's shell in < 300 ms once its manifest is cached |
| History | First page p99 < 200 ms; smooth scrolling through thousands of rows |
| Exports | Accepted in < 300 ms; progress visible; the user can keep working |
| Accessibility | Access-change and forbidden panels are announced and take focus |

---

## 🧭 The Product (~2 min)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [LO] Lumen Outfitters ▾  Pro               1 export running ▸   Alice ▾  │
├────────────────┬─────────────────────────────────────────────────────────┤
│ Overview       │ Conversations                            [Export CSV]   │
│ Agents         │ Status: escalated ▾   Channel ▾   Agent ▾   Search      │
│ Knowledge base │ 1,148 conversations                                     │
│ Conversations  │ ┌──────────────────────────────┐ ┌────────────────────┐ │
│ Analytics      │ │ 14:02  Return a tent  esc.   │ │ Return a tent      │ │
│ Prompts  Beta  │ │ 13:57  Promo code     esc.   │ │ transcript …       │ │
│ Exports        │ │ 13:41  Gift card      esc.   │ │ cost (admins only) │ │
│ Billing        │ │ … virtualized rows           │ │                    │ │
│ Settings       │ └──────────────────────────────┘ └────────────────────┘ │
└────────────────┴─────────────────────────────────────────────────────────┘
  /orgs/org_lumen/conversations/:conversationId?status=escalated
```

- **Every in-app URL starts with `/orgs/:orgId`.** The URL is the only place the active org lives, so a refresh, a pasted link or a second tab can't disagree about which org they're in.
- **Filters live in the search parameters**, and the detail pane is a child route that keeps them. A deep link reopens the same list with the same conversation open.
- **The sidebar is a projection of the manifest.** Alice sees nine modules at Lumen, where she's an admin on the pro plan. At Harbor Health Co-op, where she's a viewer on the starter plan, she sees five.
- **Public routes** are `/share/:token` for a shared prompt and `/invite/:token` for an invitation. They live outside the org layout.

---

## 💾 Entities (~2 min)

| Entity | Key fields | Why it exists |
|--------|------------|---------------|
| org | id, name, plan, branding, authz_version | The tenant. The version bumps on every access change |
| membership | (org, user), role | The role belongs here, not to the user |
| project, project membership | org, restricted flag; (project, user) | Finer scope: restricted projects are for admins and their own members |
| agent, knowledge doc, prompt | org, project, owner | Resources. Their foreign key includes the org, so a cross-org reference can't be stored |
| conversation | org, project, agent, status, channel, csat, cost, started_at | History, ordered by (started_at, id) for cursor pagination |
| feature flag, flag rule | key and default; (flag, org), enabled, roles | Per-org, per-role switches |
| invitation | token hash, email, role, expiry, accepted/revoked | Single use, tied to the invited email |
| share link | token hash and hint, expiry, revoked_at, creator | A revocable bearer grant on one prompt |
| export job | query, status, progress, lease, idempotency key, file | A background job; the row is the queue |
| audit event | actor, action, target, before, after | Written in the same transaction as the change |

---

## 🔐 One Authorization Model, Rendered Once (~3 min)

The server computes effective access with one pure function. Role, plan and flag rules go in; permissions, entitlements and flags come out. It returns that result as the **manifest** for one org: role, permissions, entitlements, flags, accessible projects, a read-only bit for previews, and a version. The client keeps one module registry, a single list of every module with the requirement it needs, and one decision function that returns either "allowed" or the *reason* it isn't. The sidebar, the route guards, the settings tabs and the action buttons all ask that function. Nothing else in the client decides what a role may see.

| Why it's unavailable | Sidebar | Deep link to the page | The API's answer |
|----------------------|---------|-----------------------|------------------|
| Not a member of the org | Org absent from the switcher | Neutral "not found, or you're not a member" | 404 |
| Role lacks the permission | Hidden | "Your role (Viewer) doesn't include Billing", Request access, your other orgs | 403 FORBIDDEN |
| Flag off for this org and role | Hidden | "Prompt library isn't turned on here" | 403 FEATURE_DISABLED |
| Plan doesn't include it | Shown with a lock | "Exports are part of the Pro plan", with View plans for those who can see billing | 403 ENTITLEMENT_REQUIRED |
| Admin previewing another role | Shown as that role, under a banner | Writes disabled | 403 READ_ONLY |
| A resource in another org or project | — | "Not found, or in a project you can't access" | 404 |
| Session expired | — | Sign in, then back to the same URL | 401 |

> "The decision order is the same on both sides: permission, then flag, then entitlement. A viewer at a starter-plan org who opens Exports is told about their role, because upgrading the plan wouldn't help them. And the client's checks are for rendering only. The server enforces every one of them again, so hiding a button is a courtesy, not security."

---

## 🔌 API Contracts (~3 min)

```
GET    /api/v1/auth/me                            → Identity and the list of my orgs (no roles)
GET    /api/v1/events                             → The tab's one SSE stream for all orgs
GET    /api/v1/orgs/:orgId/manifest               → Effective access for this org, with its version
GET    /api/v1/orgs/:orgId/conversations?…&cursor → Keyset page; capped total on the first page
GET    /api/v1/orgs/:orgId/conversations/:id      → Detail; cost only for roles with analytics.cost
POST   /api/v1/orgs/:orgId/exports                → Background export (Idempotency-Key)
GET    /api/v1/orgs/:orgId/exports/:id/download   → File, after a fresh access check
PATCH  /api/v1/orgs/:orgId/members/:userId        → Change role
DELETE /api/v1/orgs/:orgId/members/:userId        → Remove, cascading to links, invitations, exports
POST   /api/v1/orgs/:orgId/access-requests        → "Request access" from a forbidden page
GET    /api/v1/shared/:token                      → Public read of a shared prompt
```

| Contract | Success | Failure behavior |
|----------|---------|------------------|
| Every org route | `X-Org-Id`, `X-Authz-Version`, `Cache-Control: private, no-store` | 401, 404, or a 403 whose code says which axis said no |
| Manifest | The manifest; computed by the same function the gate uses | 404 for non-members, which the client shows as a neutral not-found page |
| Conversations | items, nextCursor, and on page one a total capped at 10,000 | 400 INVALID_CURSOR, telling the client to start again from the first page |
| Create export | 202 with the job; a retry with the same key gets 200 and the same job | 422 if the key was used with other filters; 403 ENTITLEMENT_REQUIRED on starter |
| Event stream | `hello` with every org's version, then hints, then `versions` on each 20 s heartbeat | Hints are advisory; the client converges even if it misses all of them |
| Shared link | The prompt, never cached | 404 unknown, 410 revoked or expired, including when its creator has left the org |

> "Two headers do a lot of work. X-Org-Id lets the client reject any response that isn't for the org it asked about. X-Authz-Version lets any response, not just the event stream, tell the client its manifest is behind. If the stream is down, the next ordinary request still catches a demotion."

---

## 🏗️ Architecture (~2 min)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser tab: router (org in URL) · manifest per org · query cache   │
│ keyed by org · per-visit abort controller · one EventSource         │
└────────────────┬───────────────────────────────────▲────────────────┘
                 │ REST + session cookie             │ SSE: hello, versions, hints
┌────────────────▼────────────────────┐   ┌──────────┴────────────────┐
│ Console API (stateless)             │   │ Event hub (per instance)  │
│ one gate on every org route         │   │ one pattern subscription  │
│ queries scoped by org + projects    │   │ heartbeat reconcile, 20 s │
└───────┬───────────────────┬─────────┘   └──────────▲────────────────┘
        │ writes, sensitive │ cached access,         │
        │ reads             │ mirror, publish        │
┌───────▼───────────┐ ┌─────▼────────────────────────┴───────┐
│ PostgreSQL        │ │ Valkey: permission cache, version    │
│ source of truth   │ │ mirror, sessions, pub/sub hints      │
└───────▲───────────┘ └───────────────────▲──────────────────┘
        │ claim, lease, fenced writes     │ export progress
┌───────┴─────────────────────────────────┴──────┐
│ Export workers: poll · batch · re-check access │
└────────────────────────────────────────────────┘
```

| Component | Responsibility |
|-----------|----------------|
| Browser SPA | Router with the org in the URL; manifest-driven guards; a query cache whose keys all start with the org; one event stream per tab |
| Console API | The gate on every org route, queries scoped by org and accessible projects, version headers |
| Event hub | One Valkey pattern subscription per instance, routing hints to local tabs and reconciling membership on each heartbeat |
| PostgreSQL | Memberships, roles, flags, plans, resources, links, export jobs and audit events: the only authority |
| Valkey | Cached access keyed by version, the version mirror, identity-only sessions, pub/sub hints |
| Export workers | Claim job rows with a lease, write the file, re-check access before publishing |

---

## 🖥️ Client State and Org Switching (~4 min)

| State | Lives in | Scoped by | Cleared when |
|-------|----------|-----------|--------------|
| Active org | The URL, mirrored in a module-level "active org" plus its abort controller | — | Every navigation to another org |
| Manifest | Query cache, key starts with the org | Org | Refetched on a hint, a newer version header, a 403 or the heartbeat |
| Server data (lists, details, settings) | Query cache, key starts with the org | Org, then module, then filters | Access to the org lost: the whole org prefix is removed |
| Filters and selection | URL search parameters and the child route | Org (part of the path) | Not carried across a switch |
| Forms and drafts | Component state under a subtree keyed by org | Org | Unmounted on switch |
| What changed and when | A small store: revoked orgs, lost modules, last change | Org | Cleared when access returns |
| Last org used | localStorage, per user | User | Only a convenience for the landing page |

**What a switch does, in order.** This is the first follow-up: *a user switches orgs while a request is in flight; what happens to its response?*

1. The org route's `beforeLoad` runs before any page of the new org mounts. An effect would run too late, because React runs child effects before parent effects, so the new pages would already have fired their requests.
2. It cancels every query whose key starts with the old org, which also restores those entries to their previous state.
3. It aborts the old visit's abort controller. Every org request was sent with that signal combined with its own, so mutations and one-off fetches die too.
4. A response that still arrives is checked against the active org and dropped as stale before it touches any state. It's never retried.
5. The response's X-Org-Id must match the org the client asked for, or it's rejected outright.
6. The org layout's subtree is keyed by org ID, so a half-filled "New agent" form, holding a project ID from the old org, can't survive the switch.
7. Placeholder data, which keeps old rows visible while new filters load, is kept only when the previous query belongs to the same org.

That also answers *how are caches scoped so data from two orgs never mixes?* Every key starts with the org; a late response is dropped and could only ever land under its own org's key; the server echoes the org on every response; and losing an org removes its entire key prefix. A 401 is different: the app goes to sign-in, keeps the full URL with its filters as the return address, and the cache is cleared at the next sign-in, so a different person on the same browser never inherits it.

---

## 🔁 Execution Traces (~6 min)

### ✅ Successful trace: a deep link, then a switch mid-load

Alice is an admin at Lumen Outfitters and a viewer at Harbor Health Co-op. A colleague pastes her a link to an escalated conversation at Lumen.

1. **Shell.** The root route confirms her session with `/auth/me` and opens the tab's one EventSource. Its `hello` frame lists both orgs' versions.
2. **Switch in.** The org route's `beforeLoad` activates Lumen and creates a fresh abort controller.
3. **Manifest.** The org layout requests the manifest. On the server, the gate sees a GET, reads Lumen's version from the Valkey mirror (41) and misses the cached entry. It reads PostgreSQL: org, membership and version in one statement, then projects (all of them, since she's an admin) and flag rules. It caches the result for 60 s and returns the manifest with X-Org-Id, X-Authz-Version: 41 and no-store.
4. **Render.** The sidebar comes from the manifest: Exports unlocked (pro plan), Prompts visible (the flag is on for admins at Lumen). The route guard asks the same function about conversations.read: allowed.
5. **List.** The table's infinite query, keyed by org, module and filters, asks for 100 escalated conversations. The gate hits the cache this time. The handler's WHERE clause starts with the org and her projects, then the status filter, ordered by (started_at, id), fetching 101 rows to know whether another page exists, plus a count capped at 10,000.
6. **Client checks.** The response's org is still active, X-Org-Id matches, and version 41 isn't newer than the manifest. The virtualizer renders the twenty or so visible rows, and scrolling within 25 rows of the end fetches the next cursor.
7. **Detail.** The pane's child route loads the conversation with the same org and project scope, and includes cost because admins hold analytics.cost. Had the ID belonged to Harbor, the answer would have been 404 and the pane would say "not found, or in a project you can't access".
8. **Switch out mid-load.** While page two is in flight, Alice picks Harbor in the switcher. `beforeLoad` cancels Lumen's queries and aborts Lumen's controller, so page two's request rejects. Harbor's manifest arrives: viewer, starter plan, flag off. The sidebar shows Overview, Agents, Knowledge base, Conversations and Analytics. Exports is hidden rather than locked, because her *role* lacks the permission there, and that check comes before the plan.

### ❌ Failed trace: a demotion while the editor is open

Ben is an editor at Lumen. One tab has the agent editor open with unsaved instructions; another shows Exports. Alice demotes him to viewer.

1. **Admin request.** Alice changes Ben's role in Settings → Members. It's a write, so the gate reads PostgreSQL: Alice is an admin with members.manage.
2. **Transaction.** Lock Ben's membership row. He isn't an admin, so the last-admin guard doesn't apply. Set the role to viewer, bump the org's version from 41 to 42, and write member.role_changed with before and after. Commit.
3. **After commit.** Mirror 42 to Valkey, forward only. Publish authz.changed with version 42 on Lumen's channel, and role.changed (editor → viewer) on Ben's channel.
4. **Hub.** The API instance holding each of Ben's tabs routes both frames to both tabs.
5. **Client.** role.changed records who changed what and when, and shows a toast: "Your role in Lumen Outfitters is now viewer." authz.changed compares 42 with the cached manifest's 41 and invalidates the manifest, joining a refresh already in flight rather than restarting it.
6. **Manifest.** The refetch misses the cache under v42, reads PostgreSQL, and returns viewer permissions at version 42.
7. **Guard.** A watcher compares the old and new manifests and records the modules Ben just lost: Exports. On that tab, the guard now finds Exports both denied *and* lost, so it renders an explanation instead of a generic forbidden page: "Exports is no longer available to you. Your role in Lumen Outfitters changed from Editor to Viewer at 14:02, so this page was closed." The heading takes focus, so a screen reader announces it.
8. **Editor.** The agent editor can no longer write, so it turns read-only with a banner and keeps his unsaved text on screen to copy. Save and "New agent" disappear.
9. **What the server refuses meanwhile.** If Ben clicks Save before the new manifest lands, the write is authorized against PostgreSQL and gets 403 FORBIDDEN naming agents.write, his role and version 42. The client treats any 403 as "my manifest may be stale" and refetches, reaching the same end state. A read in the milliseconds between commit and mirror might still come from the v41 cache, which is data he could see a moment ago. If both pushes were lost, the next ordinary response carries X-Authz-Version 42, or the heartbeat's `versions` frame arrives within 20 s. His running export, if he had one, would fail its pre-publish check with ACCESS_REVOKED, and downloading would be refused anyway.

> "I don't try to make the push reliable. I make it unnecessary for correctness, and then use it to make the UI fast. The server refuses the write in step 9 whether or not the client has heard anything."

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: One permission source, end to end

**Decision.** The server's gate and the server's manifest come from the same pure function, so what the client renders is literally what the API enforces. The client has one module registry and one decision function, which returns a reason as well as a verdict. Every surface reads the manifest through that function: the sidebar, the guards, the settings tabs and the buttons. The client never branches on role names, only on permissions, flags and entitlements. The server still checks everything, and any 403 makes the client refetch its manifest.

**Why it works here.** The most visible failure of a role-based UI is surfaces that disagree: the sidebar offers Exports, the page says forbidden, or a button appears and then fails with 403. With one registry evaluated against one manifest, a deep link and a sidebar click get the same answer by construction. Reasons matter as much as verdicts. "Ask an admin", "upgrade" and "not turned on here" are three different next steps, and only the reason tells the UI which one to show. Because the manifest is versioned and every response carries the current version, a stale manifest is detected by ordinary traffic.

**How the alternatives break.**

- *Duplicate the role table in the client.* It drifts. The client thinks editors can export on starter, so the button shows and fails. Per-role flag rules are org data that a static client table can't know, and custom roles would break it entirely.
- *Ask the server per action ("can I do X?").* That's dozens of requests per page, buttons that flicker in late, and inconsistent snapshots: the sidebar answered at version 41 and a button at 42.
- *Put roles on the session or in a token.* A user has a different role in each org, and the token is stale the moment an admin demotes them.
- *Gate only in the UI.* Hiding a button isn't enforcement. The scripted browser check forces the hidden write directly and expects 403.

| Approach | Surfaces agree | Stays correct after a change | Cost |
|----------|----------------|------------------------------|------|
| ✅ Server-computed manifest + one client registry + server enforcement | Yes, by construction | Yes; versioned, refetched on change | One request per org visit; refetch storms after bumps |
| ❌ Client-side role table | Until it drifts | No; flag rules are server data | Duplicate logic |
| ❌ Per-action "can I?" calls | Not reliably | Each answer from a different moment | N requests per page |
| ❌ Roles in the session or token | Yes | No; stale until expiry | Hard to revoke |

**What I give up.** The manifest is a round trip before the org's shell can render; prefetching it on hover in the switcher would hide that. Every version bump costs every connected member a refetch, which is the stampede I'll come back to. And versioning has a sharp edge I actually hit: the manifest's own response carried the version header, and the rule "a newer version means refetch the manifest" fired on that response before its body was stored. It invalidated the query, cancelling the very fetch that would have caught up, and started another, forever: eleven thousand requests in a few seconds. The fix had two parts. The manifest's response doesn't report its version, and invalidations join a refresh in flight instead of restarting it. The general lesson is that whatever carries the version must never invalidate itself.

### Deep dive 2: Access changing mid-session, across the server cache, the stream and the client cache

**Decision.** Three layers cache access, each with its own invalidation, and the server trusts none of them for anything that matters. On the server, effective access is cached in Valkey under a key that includes the org's version; the version bumps in the same transaction as the change, and after commit it's mirrored forward-only, with a 60-second TTL as the backstop. Writes, downloads, export publication and share links always read PostgreSQL. In transit, each tab holds one SSE stream for all its orgs, multiplexed on each API instance through one Valkey pattern subscription; the events are hints, never data, and `hello` on connect and `versions` on every heartbeat repeat the current versions. In the client, a hint, a newer version header, a 403 or a heartbeat refetches the manifest. Losing an org removes its whole cache prefix and shows "you no longer have access". A revoked session sends the user to sign in with the reason.

This is the key question: **what cached state must be invalidated, and which checks stay authoritative before that completes?**

| Layer | What it caches | Invalidated by | Stale for at most | Authoritative meanwhile |
|-------|----------------|----------------|-------------------|-------------------------|
| Server permission cache | Effective access per (org, user) | A new version, hence a new key | Milliseconds; 60 s if the mirror write fails | Every write, downloads, export publication, share-link reads, invitation acceptance |
| Event hub | Which orgs each stream may hear | access.revoked; heartbeat reconcile | 20 s | Hints carry no data; data still passes the gate |
| Sessions | Identity only | Destroyed when no org is left | — | No roles in sessions, so nothing to go stale |
| Client manifest | Permissions, flags, entitlements, version | Hint, version header, 403, heartbeat | About 1 s; 20 s without push | The API refuses regardless |
| Client query cache | Pages of org data | Org prefix removed on loss of access | Until the hint or the next failed fetch | Every refetch is re-authorized |

**How the alternatives break.**

- *Poll the manifest every 30 seconds.* With 60K open tabs that's 2,000 requests a second for answers that almost never change, and a page can still be 30 seconds stale.
- *Put the new permissions in the event.* Now the client trusts a push payload, and ordering matters: version 42 can arrive before 41, and a reconnect has gaps. Hints plus a refetch make order irrelevant, since the client asks the authority for the current state whenever anything moves.
- *A WebSocket.* Nothing flows from client to server here. SSE reconnects by itself and rides ordinary HTTP and cookies. Its one blind spot is that EventSource can't see status codes, so on an error the client calls `/auth/me` to tell an expired session from a network blip.
- *One stream per org.* Every switch reconnects, and an export finishing in another org can't notify you.

**What I give up.** If pushes are lost, a page can stay up to 20 seconds after access is gone, still unable to write or load anything new. A big org pays a refetch burst after every bump: a flag change in a 50K-member org sends about 15K tabs to the manifest endpoint at once, all cache misses. I'd add 0–5 s of client jitter, since the hint is advisory and the server enforces anyway, and single-flight recomputation on the server. And there's an honest limit: revocation stops future reads, but it can't unsee what was already rendered. That's why the explanation says "changes you hadn't saved here were not sent" rather than pretending nothing happened.

### Deep dive 3: History at scale, with keyset pages, a virtualized table and an export that matches the table

**Decision.** History is keyset-paginated by (started_at descending, id descending) with an opaque cursor, served by an index that starts with the org. The total is computed only for the first page and capped at 10,000 ("10,000+"). Filters live in the URL. The list endpoint and the export worker build their WHERE clause with the same function, which always starts with the org and the user's projects. On the client, an infinite query keyed by org and filters feeds a virtualized table with fixed 44 px rows and an overscan of 12, fetching the next page when the viewport is within 25 rows of the end. The detail pane is a child route that keeps the filters. Export posts the current filters as a background job.

**Why it works here.** Lumen alone has 6,200 conversations locally, and a large customer has millions. An offset of 5,000 makes the database walk 5,000 rows, and new conversations arriving at the top shift every page, so users see duplicates or skip rows. A keyset cursor seeks straight to its position in the index and is stable under inserts. Counting millions of matching rows on every filter change is usually the slowest part of a list, and nobody needs "1,048,576" over "10,000+". Virtualization keeps about forty rows in the DOM whether two hundred or twenty thousand are loaded. Filters in the URL make a view shareable, and they survive a session expiry: sign-in returns to the exact URL. Because the export uses the list's WHERE builder, the file contains exactly what the table shows, never a row the user couldn't see.

**How the alternatives break.**

- *Page numbers with offsets.* Deep pages get slow, pages drift as data arrives, and an exact total needs a full count.
- *Infinite scroll without virtualization.* After a few thousand rows the DOM is huge, scrolling stutters and memory climbs.
- *Building the CSV in the browser from loaded pages.* It contains only what was loaded, freezes the tab, and skips the server's permission, entitlement and audit trail.
- *A synchronous server download.* A million rows outlast proxy timeouts, and a retry starts from zero.

| Approach | Deep pages | Stable under new data | Export matches view |
|----------|------------|-----------------------|---------------------|
| ✅ Keyset + capped count + virtualized table + shared WHERE builder | Constant cost | Yes | Yes, by construction |
| ❌ Offset pages + exact count | Linear cost | No | Only if both queries are kept in sync by hand |
| ❌ Unvirtualized infinite scroll | Constant cost, growing DOM | Yes | — |
| ❌ Client-side CSV | — | — | Only loaded rows |

**What I give up.** There's no "jump to page 37" and no exact total past 10,000; a date filter covers most of that need. Search is a case-insensitive match on subject and customer name, which won't scale; at production size it moves to a search index whose search-after value becomes the cursor. Fixed row heights constrain the design, a choice I made deliberately so the virtualizer never has to measure rows.

---

## 🧩 The Prompt-Sharing Variant (~2 min)

| Mode | Model | Server enforcement | Client |
|------|-------|--------------------|--------|
| Private | Owner, empty shared-roles list | Visibility is a WHERE condition: same org, an accessible project, and (owner, or my role is listed) | Lists only what the query returns |
| Shared with roles | The list of roles | Changing it requires prompts.share and ownership, and is audited before and after | Role checkboxes for the owner only |
| Shared by link | Token hash and hint, view only, expiry (30 days by default, at most 90), revoked_at, creator | Public read by hash: 404 unknown; 410 revoked, expired or creator no longer a member; never cached | Raw link shown once with Copy; Settings → Share links lists hint, last use and status |

- **Revoking a link someone has open.** Revocation stops the next read; it can't recall what was already shown. The shared page is one uncached read, so a refresh says "This link was revoked." The real controls are a default expiry, view-only links, last-used timestamps and rate limits on the public route.
- **Un-sharing from a role** is a change to one resource, so it doesn't bump the org's version. That would refetch every member's manifest on every share click. The viewer's next read of that prompt is 404.
- **Removal cascades.** Removing a member revokes every link they created in the same transaction, and the public read's creator-membership check backstops it. Revoking never depends on the feature flag, so turning the library off can't stop an admin from revoking.
- **Open edges.** A demoted editor's links stay live; they can still revoke them (revoking never needs a permission beyond membership), and a stricter rule would re-check prompts.share at read time. A removed member's private prompts become invisible to everyone and need ownership transfer.

---

## 🧪 Testing Role × Flag × Plan Combinations (~1 min)

The full matrix of thirty-six org routes × three roles × two plans × five flag-rule shapes runs past a thousand end-to-end cases, so I test each layer once instead:

- **The decision functions, exhaustively.** The server's pure function covers every role × plan × flag-rule shape (thirty cases). The client's decision function covers role × plan × flag on and off for every module, including "role is reported before plan" and "a demotion lists exactly the lost modules".
- **The binding, by inventory.** A test walks the server's route table and fails if any org route lacks a declared rule.
- **One persona per rule, end to end.** Thirteen integration tests against a real database try cross-org access for a user who belongs to both orgs. A scripted two-user browser check (29 checks) covers a switch with a held response, a flag turned off, a demotion and two kinds of removal while pages are open, deep links and an export.

---

## ✅ Design Review Checklist (~2 min)

| # | Question | Answer |
|---|----------|--------|
| Q1 | Source of truth, and when is a write successful? | PostgreSQL. An access change succeeds when its transaction commits, together with the version bump and the audit row. The client's manifest and caches are projections, refetched, never edited optimistically for access |
| Q2 | Retry after a lost response? | Export creation reuses the same Idempotency-Key, which the client keeps until a request succeeds, and gets the original job back; other filters with the same key get 422. Role changes to the same role are no-ops. Revoking a revoked link is 204. Reconnecting the stream only re-reads (`hello`); it never replays writes |
| Q3 | Failure between two steps? | Commit but no publish: version headers and the 20 s heartbeat still deliver the change, and cached reads are bounded at 60 s. A worker dies mid-export: its lease lapses and another worker restarts it, up to three attempts. A stalled worker's late writes are fenced out. On the client, a switch mid-request aborts and drops the old response |
| Q4 | Which ordering is required? | Versions per org only move forward, and the client refetches only when behind, so hint order doesn't matter. History pages need a total order, (started_at, id). Within one org, a late response must never overwrite a newer view; across orgs, the stale-org check drops it |
| Q5 | Access with caches and async work? | The server cache is keyed by version and bypassed for writes and copies. Exports are re-checked before publishing and on download. Share links are never cached. Streams drop events for orgs they've left. Client caches are keyed by org and removed on loss of access |
| Q6 | What breaks first at scale? | The heartbeat's per-connection membership query (3,000/s at 60K tabs), then the refetch burst after a bump in a huge org. Details below |

---

## 📈 What Breaks First (~1 min)

| Rank | Pressure | Evidence | Fix |
|------|----------|----------|-----|
| 1 | Stream heartbeat | One membership query per open stream every 20 s: 60K tabs means 3,000 queries a second, three times the API's whole peak | Batch per instance, and query only orgs whose mirrored version moved |
| 2 | Refetch burst after a bump | A flag change in a 50K-member org sends ≈ 15K manifest refetches in a second, all misses, ≈ 45K queries | Client jitter, single-flight on the server, separate org-level and user-level versions |
| 3 | Conversation volume | ≈ 3.6B rows a year; analytics scan up to 90 days per request | Monthly partitions, daily rollups or ClickHouse for analytics, a search index for history |
| 4 | Duplicate streams per user | Each tab holds its own stream, and toasts repeat in every tab | One leader tab per browser holds the stream and shares it with the others over a BroadcastChannel |

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Permission source | Server-computed manifest, one client registry | Client role tables / per-action checks | Surfaces can't disagree, and stay in sync with enforcement |
| Enforcement | Server gate + scope in every query | UI gating | Hiding a button isn't security |
| Non-member answer | 404 | 403 | IDs reveal nothing about other tenants |
| Active org | In the URL and every cache key | Global "current org" state | Tabs, refreshes and links can't disagree |
| Org switch | `beforeLoad` cancel + abort + stale-org drop | Let late responses land | No cross-org flash of data |
| Revocation push | One SSE per tab, hints only | Polling / payload-carrying events | Fast, order-free, and lossless enough |
| Server cache | Version in the key, 60 s TTL backstop | TTL only / delete on change | Instant, race-free invalidation |
| History | Keyset + capped count + virtualization | Offsets + exact counts | Constant cost, stable under inserts |
| Export | Background job, access re-checked | Client CSV / synchronous download | Matches the view; survives navigation |
| Auth | Session cookie, identity only | JWT carrying roles | Immediate revocation |

---

## 📝 Wrap-up (~1 min)

| Follow-up | Answer |
|-----------|--------|
| A user switches orgs while a request is in flight. What happens to its response? | `beforeLoad` cancels the old org's queries and aborts its controller. A response that still arrives is dropped as stale, checked against X-Org-Id, and could only ever land under the old org's key. Background exports keep running and notify with the org's name |
| Where are role checks enforced, and why in both client and server? | The server enforces, at the gate and inside queries. The client reads the same decision from the manifest so the UI shows only what works, explains every "no" with the right remedy, and refetches the manifest on any 403 |
| A deep link to a page the role can't see? | The guard renders a forbidden page that names the reason: role (with Request access, which is audited), flag ("not turned on") or plan ("upgrade"), plus the user's other orgs. Another org's resource is 404, and an unknown org gets a neutral not-found page |
| An admin removes access while the page is open. What does the user see, and when? | About a second later, the page is replaced by "You no longer have access to Lumen Outfitters", the org's cached data is removed, and other orgs are offered; with no orgs left, sign-in with the reason. Writes are refused from the moment of commit; without push, within 20 s |
| How are client caches scoped so two orgs never mix? | Org ID first in every key, the stale-org drop, X-Org-Id checks, a subtree keyed by org, placeholder data limited to the same org, and the whole prefix removed on loss of access |
| How do you test role and flag combinations? | Both decision functions exhaustively, the route binding by inventory, one persona per rule end to end |
| **Key question:** what must be invalidated, and what stays authoritative meanwhile? | The server's permission entries (by version), the hub's stream subscriptions, sessions when no org is left, and the client's manifest and org cache. Writes, downloads, export publication, share links and invitations read PostgreSQL throughout |

> "To sum up: the org lives in the URL and in every cache key, so switching is an abort and a fresh namespace, never a merge. The server computes one manifest per org with the same function it enforces with, and the client renders every surface from it, while the server checks everything again anyway. Access changes travel as hints over one stream per tab, and versions on every response make sure a missed hint is caught. Pages that lose access close with an explanation, never a blank screen. With more time, I'd add jitter and single-flight to soften the refetch burst after a bump, prefetch manifests from the switcher, and share one stream across tabs."

### How the local implementation compares

The repo builds this with a Vite and React frontend, TanStack Router (the switch happens in the org route's `beforeLoad`), TanStack Query with every key generated from one module and starting with the org, Zustand for the small "what changed" store, and `@tanstack/react-virtual` for history. The backend is an Express API that also serves the event stream, a separate export worker, PostgreSQL and Valkey. Two fictitious orgs are seeded: Lumen Outfitters on pro and Harbor Health Co-op on starter, with five users, about 8,500 conversations and one flag. Everything described above is implemented. It's verified by 70 backend unit tests, 14 integration tests against a real database, 19 frontend unit tests (key scoping, the abort-and-drop logic, the module decisions), a scripted two-user browser check (29 of 29) and 16 smoke tests. The scripted check is what caught the manifest refetch loop described in deep dive 1, and a rerun caught an ordering race at removal: a tab that lost its last org refreshed its org list on access.revoked, got a 401 before session.revoked arrived, and showed "your session has ended" instead of "your access was removed". The server now ends the sessions and announces that first. Compared with this answer, the hub runs inside the API process instead of a separate stream fleet, export files sit on local disk rather than in object storage behind signed URLs, each tab opens its own stream, there's no jitter yet on post-bump refetches, and "Request access" records an audit event without notifying admins.

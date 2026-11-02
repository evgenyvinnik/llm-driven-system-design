# Microsoft Teams — Development with Claude

## Project Context

What separates enterprise chat from consumer chat isn't the messaging — it's the containment hierarchy. Organization → team → channel → message is four levels of nesting where every level carries its own membership table, and "can Alice read this message" is a question about which of those four memberships she holds. Get that wrong and you have a cross-tenant data leak, which in an enterprise product is the failure that ends the product.

The second thing that shapes this system is that real-time chat has an inherent split: a message is a *write* that needs a success/failure answer, and a *broadcast* that needs to reach everyone else. Those are different problems with different failure semantics, and conflating them into one bidirectional socket means your write path inherits the socket's lack of a status code. Here they're deliberately separate — REST for the write, Server-Sent Events for the fan-out.

That split creates the real distributed-systems problem: SSE connections are held by whichever process the client happened to connect to. Alice on instance A and Bob on instance B are in the same channel and cannot see each other, because instance A's in-memory connection map has never heard of Bob. Solving that without making the API stateful is what Redis pub/sub is for here.

**Learning goals:** hierarchical membership modeling and authorization, SSE versus WebSocket for asymmetric traffic, cross-instance fan-out via Redis pub/sub, and presence as a self-expiring key rather than a state machine.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** (`npm run dev` → `PORT=${PORT:-3001} NODE_ENV=development tsx watch`; `dev:server2`/`dev:server3` bind 3002/3003) | Express with SSE endpoints on the same process; `app.ts` is exported without `listen()` so vitest can mount it |
| **PostgreSQL 16** | 5432 (`teams`/`teams123`, db `teams`) | 10 tables: `users`, `organizations`, `org_members`, `teams`, `team_members`, `channels`, `channel_members`, `messages`, `message_reactions`, `files` |
| **Valkey 7** | 6379 | Three distinct jobs: session store (`connect-redis`), **pub/sub fan-out across instances**, and presence keys with TTL |
| **MinIO** | 9000 / console 9001 (`minioadmin`/`minioadmin`) | File attachments; uploaded through the API via `multer` memory storage, served back as presigned URLs |

The two files that carry the real-time design are `backend/src/services/sseService.ts` (per-process connection registry, `Map<channelId, Set<client>>`) and `backend/src/services/pubsub.ts` (the cross-instance bridge, with ref-counted subscriptions). The two that carry authorization are `backend/src/services/accessService.ts` (who can see which org/team/channel/message) and `membershipService.ts` (roles, the last-owner rule, cascading removal). Ten route files under `backend/src/routes/` — `organizations`, `teams`, `channels`, `messages`, `reactions`, `files`, `presence`, `sse`, `users`, `auth`. Frontend is React 19 + TanStack Router with nested file-based routes that mirror the hierarchy (`org.$orgId.team.$teamId.channel.$channelId.tsx`) + Zustand (`authStore`, `chatStore`) + Tailwind in the Teams purple (#5B5FC7).

## Key Design Decisions

### 1. REST to write, SSE to receive — not a bidirectional WebSocket

`POST /api/messages` creates the message and returns it; `GET /api/sse/:channelId` holds an open `text/event-stream` that pushes `new_message`, `message_edited`, `message_deleted`, `reaction_added`, `reaction_removed` and `member_removed` events.

A WebSocket would carry both directions on one connection, which sounds simpler and costs you the request/response contract. Over a socket, "send message" is a frame you write into a pipe — there is no status code, so you have to invent a correlation-ID-plus-ack protocol to know whether the write succeeded, and you have to reimplement error semantics (validation failure, permission denied, rate limited) as application-level message types. All of that already exists in HTTP.

The traffic is also deeply asymmetric. A user in a busy channel receives hundreds of messages and sends a handful; the upstream channel of a bidirectional socket is nearly idle. SSE matches that shape, and it's plain HTTP — it traverses proxies and corporate middleboxes that mangle WebSocket upgrades, and `EventSource` reconnects automatically with backoff, which is a meaningful amount of client code you don't write.

What we give up: SSE is one-way, so genuinely client-pushed signals need another mechanism — which is exactly why presence is a `POST /api/presence/heartbeat` on a timer rather than a frame on the existing connection. Browsers also cap concurrent connections per origin (~6 over HTTP/1.1), so a user with several tabs open can starve themselves; HTTP/2 fixes this and dev-mode Vite does not use it. And there's no delivery guarantee: the stream carries whatever is broadcast while you're connected, with no replay of what you missed.

### 2. Redis pub/sub between instances, because the SSE registry is per-process

`sseService.ts` holds an in-memory `Map` of channel → connected clients. That map only knows about connections terminated by *this* process. So `POST /api/messages` doesn't call `broadcastToChannel` directly — it calls `publishToChannel`, which publishes to `teams:channel:{channelId}`. Every instance's subscriber receives it and calls its *own* `broadcastToChannel`, reaching its own local clients.

Without this indirection the system is silently broken under horizontal scaling in the worst possible way: it works perfectly on one instance, and on two instances messages are delivered to roughly half the people who should see them, depending on which process each browser's connection landed on. Nothing errors. The alternative — sticky sessions pinning all of a channel's members to one instance — doesn't work either, because membership is per-user and users belong to many channels; there's no consistent key to route on.

The costs are the ones pub/sub always has. It's fire-and-forget with no durability: a message published while an instance is restarting is simply not delivered to that instance's clients, and there is no replay, so those clients stay stale until they refetch. Subscriptions are reference-counted per channel per instance: the first local client subscribes and the last one unsubscribes. Unsubscribing on every disconnect would cut off the other local clients on that channel; never unsubscribing was the original slow leak. The same bus carries `member_removed`, which is how a removal on one instance closes the removed user's stream on another.

### 3. Threads are a self-referencing FK, not a threads table

`messages.parent_message_id UUID REFERENCES messages(id)`, with `idx_messages_parent` supporting `GET /api/messages/:messageId/thread`.

A separate `threads` table with a thread ID on each message is the alternative, and it's the better model *if* threads are first-class objects with their own titles, participants, subscriptions, and lifecycle. Teams threads aren't — they're a reply chain hanging off one message, exactly one level deep. Introducing a second table would mean creating a thread row on the first reply, backfilling the root message's thread ID, and joining through it on every channel read, all to represent a relationship a single nullable column already expresses.

The one-level constraint is what makes this safe. A self-referencing FK *permits* arbitrary depth, because nothing in the schema stops a reply to a reply. So `POST /api/messages` enforces it: the parent must exist, be in the *same channel*, be top-level, and not be deleted (400 otherwise). The same-channel rule is a security check, not just tidiness: without it, a member of channel A could hang a reply off a message in channel B and inject content into a thread they can't see. A `CHECK` can't express "the parent's own `parent_message_id` is null", because it can't look at another row; it would take a trigger. If nesting were ever allowed, channel reads would need recursion and this decision would flip to being wrong.

### 4. Presence is a self-expiring Redis key, not a status column

`setUserOnline` is `SETEX presence:{userId} 60 {timestamp}`, refreshed by a client heartbeat every 30 seconds. Online-ness is literally "does this key exist."

Storing presence as a database column means something has to write `offline`, and the hard cases are exactly the ones where nothing can: the browser is force-quit, the laptop lid closes, the network drops. No disconnect handler fires, so the row says "online" forever and you need a reaper job scanning for stale timestamps — a cron whose interval *is* the accuracy of your presence, reimplementing TTL badly. Redis expiry inverts it: absence of a heartbeat is absence of the key, with no cleanup process at all.

The 30s-heartbeat/60s-TTL ratio is a deliberate 2× margin — one dropped heartbeat doesn't flap a user offline, but a genuinely disconnected user disappears within a minute. Batch lookups go through a Redis pipeline (`getOnlineUsers`), so rendering a 50-person member list is one round trip rather than 50.

What we give up: up to 60 seconds of staleness on a hard disconnect, and only a binary online/offline — Teams' away/busy/DND states would need a value-carrying key plus explicit user intent, which the current `EXISTS` check can't express.

### 5. Files go *through* the API, unlike the presign pattern used elsewhere in this repo

Uploads use `multer` memory storage and are relayed by the API into MinIO; downloads are presigned URLs so the bytes come straight from storage.

This is the opposite of the direct-to-storage presigned `PUT` used in the loom project, and the asymmetry is the point: read bandwidth is offloaded, write bandwidth isn't. Routing uploads through the API buys server-side control at the moment of upload — the API can enforce that the uploader is actually a member of the target channel, validate size and content type, and write the `files` row and the object in one code path so there's no orphan state. With a presigned `PUT` the browser talks to storage directly and the API only finds out afterwards, if the client bothers to say so.

The cost is real and is the reason the other project chose differently: an upload occupies an API request and buffers the entire file in the process's heap (memory storage, not disk), so large attachments or many concurrent uploads pressure the API tier for a workload that is pure I/O. For chat attachments — typically screenshots and documents, not 150 MB screen recordings — that's an acceptable trade for the validation guarantees.

### 6. Authorization walks the chain on every request, and invisible means 404

`requireChannel` is one query that joins `channels → teams → org_members → team_members → channel_members` for the caller. Access needs org membership, team membership, and for a private channel a `channel_members` row. Every message, thread, reaction, file, presence and SSE request goes through it, and anything the caller can't see is a **404**, so another tenant's IDs can't be probed. 403 is reserved for "you can see it but may not change it".

The alternative, materializing an effective-permission row per user per channel, makes reads one lookup and turns every missed invalidation into a silent cross-tenant leak. The chain walk costs a few indexed joins on a request that already hits Postgres, and a membership change takes effect on the next request. Public channels do get `channel_members` rows for every team member (written on team join and channel creation), but only because the member list, presence and unread counts read them. Access to a public channel is still decided by team membership.

A stream is authorized once, when it opens, so revocation has to reach open connections explicitly. Removals publish `member_removed` and every instance closes that user's streams. Roles are `owner`/`admin`/`member` at org and team level, and every org and team keeps at least one owner. That invariant is checked under a `FOR UPDATE` lock on the parent row, because two owners leaving at once would otherwise both pass a "2 owners" check.

### 7. Messages are soft-deleted

`DELETE /api/messages/:id` blanks the content and sets `deleted_at`. A deleted thread root that still has replies stays in the channel as a "This message was deleted" tombstone, and one without replies disappears. The hard `DELETE` it replaced failed on any root with replies (the self-referencing FK has no `ON DELETE` action). The obvious repair, `ON DELETE CASCADE`, would let one author erase everyone else's replies.

## Current State

Runs end to end:
- Registration and login (bcryptjs, Redis-backed sessions regenerated on login).
- Organizations, teams and channels with enforced membership at every level (see decision 6).
- Join a public team, create teams and channels, change roles, leave or remove members (last-owner rule enforced).
- Message posting with idempotent client IDs; inline editing; soft deletion; threaded replies (same channel, one level deep).
- Emoji reactions that toggle, broadcast only on real changes.
- File attachments that travel with a message and render under it (presigned downloads, members only).
- Presence with heartbeats.
- Unread badges from `last_read_at`.
- Older-history pagination with a `(created_at, id)` cursor.
- Live updates over SSE fanned out through Redis pub/sub (new/edited/deleted messages, reactions, member removal), with removed members' streams evicted.

Frontend: nested routes that mirror the hierarchy, with team switching that navigates. It also has a join-team panel, a thread panel, a member list that can add people, inline message edit/delete, and access-lost and not-found states. Cross-cutting: Pino logging, Prometheus metrics, and per-process rate limiting.

Seeded from `backend/db-seed/seed.sql` (all passwords **`password123`**):
- **alice**: owner of Acme, Engineering and Leadership; has 2 unread in `#deployments`.
- **bob**: on Engineering, but not in its private `#incident-response`.
- **carol**: owns Design; the only member of a second org, Globex. She is not on Engineering, so she sees the join panel.
- **dave**: in `#incident-response`.

Simplified or omitted:
- Typing indicators have no backend (`TypingIndicator.tsx` is unused).
- No message search, @-mentions, notifications or DMs.
- No missed-event replay on SSE reconnect (a reconnecting client refetches).
- Unread badges for channels other than the open one refresh on the 30-second presence tick, not live.
- The circuit breaker module is still unused.
- Rate limits are per process.
- User search covers every user (that's how people are found to be invited), but profiles hide email except your own.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its Phase 2 listed "Circuit breakers (Opossum)" as delivered — but `backend/src/services/circuitBreaker.ts` exports `createCircuitBreaker` and **nothing imports it**. Every MinIO and Postgres call is unwrapped, so a storage outage surfaces as a raw 500. `opossum` is a declared dependency backing dead scaffolding. (The same unused-breaker pattern exists in this repo's loom project.)
- **Screenshot config backend port (fixed):** the config used to set `"backendPort": 3000` while the backend binds **3001** (the `PORT=3001` prefix in `dev`, matching the Vite proxy target), so the harness waited on a dead port. The override is gone.
- **2026-07-29 — deep links to any channel silently landed on the wrong one.** Both `org.$orgId.tsx` and `org.$orgId.team.$teamId.tsx` had an effect that navigated to `channels[0]` as soon as `channels` loaded, with no check for a channel already in the URL. Clicking a channel worked (the click doesn't change `channels`, so the effect doesn't re-fire), but reloading that page or opening a shared link rewrote the path to the team's first channel. Both now guard on `!channelId` from `useParams({ strict: false })`. **This is the kind of bug you can't find by using the app** — clicking is the one path that works.
- **`/org` rendered a blank pane.** It's a layout route: sidebar rail plus `<Outlet />`, and the outlet is only filled once an `$orgId` is in the path. There was no index route, so navigating to `/org` directly — or backing out of an organization — was a dead end. Added `routes/org.index.tsx`, an organization picker.
- **`init.sql` indexes weren't idempotent.** The schema is applied by both the `docker-entrypoint-initdb.d` mount and `npm run db:migrate`; tables already used `IF NOT EXISTS` but the 8 `CREATE INDEX` statements did not, so migration failed on the second run with `relation "idx_messages_channel" already exists`.
- **Seed had no threads at all**, despite threading being a headline feature with a dedicated panel. It now seeds a five-reply thread on the release announcement in `#deployments`, a fuller conversation in each channel, and varied reactions. Dave was also posting and reacting in `#deployments` without being a member of it — channel membership is what authorizes reads and writes, so he's now seeded as one.
- **Harness fix (repo-wide, `scripts/screenshots.mjs`):** `page.goto` used `waitUntil: 'networkidle'`, which can *never* fire on a page holding an SSE stream open — every channel screenshot failed with a 30s navigation timeout. It now falls back to `domcontentloaded` on timeout; the per-screen `waitFor`/`delay` is what establishes that content rendered.
- **`dev:server2`/`dev:server3` didn't change the port** (fixed 2026-11): the inner `dev` script hard-coded `PORT=3001`, which won. It is now `PORT=${PORT:-3001}`.
- **Pub/sub subscriptions were never released** (fixed 2026-11): `unsubscribeFromChannel` had no callers. Subscriptions are now ref-counted per channel and released by the last local client.
- **SSE needed explicit anti-buffering headers:** the stream sets `X-Accel-Buffering: no` alongside `Cache-Control: no-cache`, because a buffering reverse proxy will hold event chunks and turn a real-time stream into batched delivery. A 30-second `: heartbeat` comment keeps idle connections from being reaped by intermediaries.
- **`app.ts` split from `index.ts`:** the Express app is exported without binding a port so vitest + supertest can exercise routes with `services/db.js` and the storage service mocked, no Docker required.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).
- **2026-11: authorization, integrity and unwired features.** A review against this file's own first paragraph ("get that wrong and you have a cross-tenant data leak") found that almost nothing checked membership.
  - *Authorization holes:*
    - Any signed-in user could read, post to and **stream** any channel, including private channels in other orgs; download any file; and list any org's members.
    - Any user could add anyone, themselves included, to any org, team or private channel, with any role (owner too).
    - Thread replies could hang off a message in another channel, or off another reply.
    - The seed's Acme org had no owner.
    - **Why:** routes checked membership at the level being accessed, often not at all; open question 2 had been left open in the code too.
    - **Fix:** one policy module (`accessService.ts`, decision 6) used by every route; 404 for invisible; a role and last-owner service with row locks; `member_removed` eviction of live streams.
  - *Integrity:*
    - Deleting a thread root 500'd on the self-FK (now soft delete, decision 7).
    - Re-adding a reaction re-broadcast it, so every client's count drifted upward, and clicking a reaction re-added instead of toggling.
    - The `before=<created_at>` cursor skipped messages that shared a millisecond (JSON drops Postgres's microseconds); now `(created_at, id)` resolved from a message id, with `limit` clamped.
    - Client-ID idempotency was documented but not implemented.
    - Same-name orgs, racing registrations and malformed JSON or IDs returned 500s.
    - `server.close()` hung on shutdown behind open SSE streams.
  - *Frontend:*
    - Under React StrictMode the channel stream closed on the dev double-mount and was never reopened, because `setCurrentChannel` returned early on the same id. **Nothing arrived live in dev.**
    - Team switching changed the store but not the URL, so the old channel stayed open and the next click mixed team ids.
    - `/register` redirected to `/login`.
    - No way to create a team (a new user hit a dead end).
    - Unread counts, load-older, edit/delete, add-people and attachments were API-only or uploaded orphans ("[File: x]" with no link).
    - The app rendered no `<main>`, which the harness and smoke tests wait for.
    - `tsc -b` emitted a `vite.config.js` that Vite loads ahead of the `.ts`.
  - *Verified:* 57 vitest tests (there were none; `npm test` exited 1). 83 live checks, run twice from clean resets. 4 cross-instance checks on `:3001` + `:3002`. 4 browser checks (live SSE under StrictMode, team switching). 17 screenshots and 17 smoke tests. Seven new screens (11–17) show the private channel, bob's view without it, the access-denied page, carol's join panel, Globex hidden from alice, inline edit, and the last-owner refusal.

## Open Questions

1. Redis pub/sub has no durability, so an instance restart silently drops in-flight broadcasts with no replay. Should SSE events carry a sequence number per channel so a reconnecting client can request the gap — and does that make the message table the real stream, with pub/sub demoted to a wake-up signal?
2. ~~Walk the chain or materialize permissions?~~ Answered in decision 6: walk it. What remains open is the cheapest safe cache if the join ever shows up on a latency graph. The candidate is the org-membership set per user, which changes on the order of days, with team and channel checks still made per request.
3. `TypingIndicator` has no backend. Typing is high-frequency and worthless the moment it's stale — is a short-TTL Redis key plus an SSE event right, or is that enough traffic to justify the bidirectional socket decision 1 rejected?
4. Unread counts are implemented as a `COUNT(*)` against `last_read_at` per channel on each channel-list load (one cheap write per read). The alternative is a per-member counter incremented on every message write: N writes per message, always fast to read. Which breaks first at this hierarchy's fan-out, and does a 10K-member channel force the counter?

## Resources

- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — `EventSource` reconnection and the event-stream wire format
- [WHATWG HTML: server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) — the `Last-Event-ID` replay mechanism question 1 is about
- [Redis pub/sub](https://redis.io/docs/latest/develop/interact/pubsub/) — including its explicit at-most-once semantics
- [Redis key expiration](https://redis.io/docs/latest/commands/expire/) — the mechanism behind TTL presence
- [MinIO JavaScript client](https://min.io/docs/minio/linux/developers/javascript/API.html) — presigned GET for attachment downloads

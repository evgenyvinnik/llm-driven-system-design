# Microsoft Teams — Development with Claude

## Project Context

What separates enterprise chat from consumer chat isn't the messaging — it's the containment hierarchy. Organization → team → channel → message is four levels of nesting where every level carries its own membership table, and "can Alice read this message" is a question about which of those four memberships she holds. Get that wrong and you have a cross-tenant data leak, which in an enterprise product is the failure that ends the product.

The second thing that shapes this system is that real-time chat has an inherent split: a message is a *write* that needs a success/failure answer, and a *broadcast* that needs to reach everyone else. Those are different problems with different failure semantics, and conflating them into one bidirectional socket means your write path inherits the socket's lack of a status code. Here they're deliberately separate — REST for the write, Server-Sent Events for the fan-out.

That split creates the real distributed-systems problem: SSE connections are held by whichever process the client happened to connect to. Alice on instance A and Bob on instance B are in the same channel and cannot see each other, because instance A's in-memory connection map has never heard of Bob. Solving that without making the API stateful is what Redis pub/sub is for here.

**Learning goals:** hierarchical membership modeling and authorization, SSE versus WebSocket for asymmetric traffic, cross-instance fan-out via Redis pub/sub, and presence as a self-expiring key rather than a state machine.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** (`npm run dev` → `PORT=3001 NODE_ENV=development tsx watch`) | Express with SSE endpoints on the same process; `app.ts` is exported without `listen()` so vitest can mount it |
| **PostgreSQL 16** | 5432 (`teams`/`teams123`, db `teams`) | 10 tables: `users`, `organizations`, `org_members`, `teams`, `team_members`, `channels`, `channel_members`, `messages`, `message_reactions`, `files` |
| **Valkey 7** | 6379 | Three distinct jobs: session store (`connect-redis`), **pub/sub fan-out across instances**, and presence keys with TTL |
| **MinIO** | 9000 / console 9001 (`minioadmin`/`minioadmin`) | File attachments; uploaded through the API via `multer` memory storage, served back as presigned URLs |

The two files that carry the real-time design are `backend/src/services/sseService.ts` (per-process connection registry, `Map<channelId, Set<client>>`) and `backend/src/services/pubsub.ts` (the cross-instance bridge). Ten route files under `backend/src/routes/` — `organizations`, `teams`, `channels`, `messages`, `reactions`, `files`, `presence`, `sse`, `users`, `auth`. Frontend is React 19 + TanStack Router with nested file-based routes that mirror the hierarchy (`org.$orgId.team.$teamId.channel.$channelId.tsx`) + Zustand (`authStore`, `chatStore`) + Tailwind in the Teams purple (#5B5FC7).

## Key Design Decisions

### 1. REST to write, SSE to receive — not a bidirectional WebSocket

`POST /api/messages` creates the message and returns it; `GET /api/sse/:channelId` holds an open `text/event-stream` that pushes `new_message`, `message_edited`, `reaction_added`, and `reaction_removed` events.

A WebSocket would carry both directions on one connection, which sounds simpler and costs you the request/response contract. Over a socket, "send message" is a frame you write into a pipe — there is no status code, so you have to invent a correlation-ID-plus-ack protocol to know whether the write succeeded, and you have to reimplement error semantics (validation failure, permission denied, rate limited) as application-level message types. All of that already exists in HTTP.

The traffic is also deeply asymmetric. A user in a busy channel receives hundreds of messages and sends a handful; the upstream channel of a bidirectional socket is nearly idle. SSE matches that shape, and it's plain HTTP — it traverses proxies and corporate middleboxes that mangle WebSocket upgrades, and `EventSource` reconnects automatically with backoff, which is a meaningful amount of client code you don't write.

What we give up: SSE is one-way, so genuinely client-pushed signals need another mechanism — which is exactly why presence is a `POST /api/presence/heartbeat` on a timer rather than a frame on the existing connection. Browsers also cap concurrent connections per origin (~6 over HTTP/1.1), so a user with several tabs open can starve themselves; HTTP/2 fixes this and dev-mode Vite does not use it. And there's no delivery guarantee: the stream carries whatever is broadcast while you're connected, with no replay of what you missed.

### 2. Redis pub/sub between instances, because the SSE registry is per-process

`sseService.ts` holds an in-memory `Map` of channel → connected clients. That map only knows about connections terminated by *this* process. So `POST /api/messages` doesn't call `broadcastToChannel` directly — it calls `publishToChannel`, which publishes to `teams:channel:{channelId}`. Every instance's subscriber receives it and calls its *own* `broadcastToChannel`, reaching its own local clients.

Without this indirection the system is silently broken under horizontal scaling in the worst possible way: it works perfectly on one instance, and on two instances messages are delivered to roughly half the people who should see them, depending on which process each browser's connection landed on. Nothing errors. The alternative — sticky sessions pinning all of a channel's members to one instance — doesn't work either, because membership is per-user and users belong to many channels; there's no consistent key to route on.

The costs are the ones pub/sub always has. It's fire-and-forget with no durability: a message published while an instance is restarting is simply not delivered to that instance's clients, and there is no replay, so those clients stay stale until they refetch. And `subscribeToChannel` is called on every SSE connect while `unsubscribeFromChannel` — though implemented and exported — is **never called**, so each instance's subscription set only grows for the process lifetime. Harmless at this scale, a slow leak at a real one.

### 3. Threads are a self-referencing FK, not a threads table

`messages.parent_message_id UUID REFERENCES messages(id)`, with `idx_messages_parent` supporting `GET /api/messages/:messageId/thread`.

A separate `threads` table with a thread ID on each message is the alternative, and it's the better model *if* threads are first-class objects with their own titles, participants, subscriptions, and lifecycle. Teams threads aren't — they're a reply chain hanging off one message, exactly one level deep. Introducing a second table would mean creating a thread row on the first reply, backfilling the root message's thread ID, and joining through it on every channel read, all to represent a relationship a single nullable column already expresses.

The one-level constraint is what makes this safe. A self-referencing FK *permits* arbitrary depth — nothing in the schema stops a reply to a reply — so the flatness is a convention enforced by the UI rather than the database. If nesting were ever allowed, channel reads would need recursion and this decision would flip to being wrong. A `CHECK` that the parent's own `parent_message_id` is null would make the constraint real.

### 4. Presence is a self-expiring Redis key, not a status column

`setUserOnline` is `SETEX presence:{userId} 60 {timestamp}`, refreshed by a client heartbeat every 30 seconds. Online-ness is literally "does this key exist."

Storing presence as a database column means something has to write `offline`, and the hard cases are exactly the ones where nothing can: the browser is force-quit, the laptop lid closes, the network drops. No disconnect handler fires, so the row says "online" forever and you need a reaper job scanning for stale timestamps — a cron whose interval *is* the accuracy of your presence, reimplementing TTL badly. Redis expiry inverts it: absence of a heartbeat is absence of the key, with no cleanup process at all.

The 30s-heartbeat/60s-TTL ratio is a deliberate 2× margin — one dropped heartbeat doesn't flap a user offline, but a genuinely disconnected user disappears within a minute. Batch lookups go through a Redis pipeline (`getOnlineUsers`), so rendering a 50-person member list is one round trip rather than 50.

What we give up: up to 60 seconds of staleness on a hard disconnect, and only a binary online/offline — Teams' away/busy/DND states would need a value-carrying key plus explicit user intent, which the current `EXISTS` check can't express.

### 5. Files go *through* the API, unlike the presign pattern used elsewhere in this repo

Uploads use `multer` memory storage and are relayed by the API into MinIO; downloads are presigned URLs so the bytes come straight from storage.

This is the opposite of the direct-to-storage presigned `PUT` used in the loom project, and the asymmetry is the point: read bandwidth is offloaded, write bandwidth isn't. Routing uploads through the API buys server-side control at the moment of upload — the API can enforce that the uploader is actually a member of the target channel, validate size and content type, and write the `files` row and the object in one code path so there's no orphan state. With a presigned `PUT` the browser talks to storage directly and the API only finds out afterwards, if the client bothers to say so.

The cost is real and is the reason the other project chose differently: an upload occupies an API request and buffers the entire file in the process's heap (memory storage, not disk), so large attachments or many concurrent uploads pressure the API tier for a workload that is pure I/O. For chat attachments — typically screenshots and documents, not 150 MB screen recordings — that's an acceptable trade for the validation guarantees.

## Current State

Runs end to end: registration and login (bcryptjs, Redis-backed sessions via `connect-redis`), organizations with members, teams within orgs, channels within teams, and per-channel membership; message posting, editing, and threaded replies; emoji reactions with a `UNIQUE(message_id, user_id, emoji)` constraint and `ON CONFLICT DO NOTHING` so double-tapping is idempotent; file attachments to messages via MinIO; presence with heartbeats and an online/offline member list; and live updates over SSE fanned out through Redis pub/sub for new messages, edits, and reaction add/remove. Frontend has the nested route hierarchy, a slide-in thread panel, a reaction picker, a member list with presence dots, org/team/channel navigation, and user search. Cross-cutting: Pino structured logging via `pino-http`, Prometheus metrics (HTTP requests, SSE connection gauge, message and presence counters), and Redis-backed rate limiting.

Seeded from `backend/db-seed/seed.sql`: users **`alice`**, `bob`, `carol`, `dave` — all with password **`password123`** — plus organizations, teams, channels, messages, and threads.

Simplified or omitted: **typing indicators are frontend-only** — `TypingIndicator.tsx` renders the animation, but no backend endpoint, SSE event, or Redis key exists to drive it, so it never fires from real activity. No unread counts or read receipts. No message search of any kind. No message deletion (edit exists; delete doesn't). No @-mentions or notifications. Message history loads as a flat fetch with no pagination or virtualization. SSE carries no missed-message replay, so a reconnecting client needs a refetch to catch up.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its Phase 2 listed "Circuit breakers (Opossum)" as delivered — but `backend/src/services/circuitBreaker.ts` exports `createCircuitBreaker` and **nothing imports it**. Every MinIO and Postgres call is unwrapped, so a storage outage surfaces as a raw 500. `opossum` is a declared dependency backing dead scaffolding. (The same unused-breaker pattern exists in this repo's loom project.)
- **Screenshot config backend port (fixed):** the config used to set `"backendPort": 3000` while the backend binds **3001** (the `PORT=3001` prefix in `dev`, matching the Vite proxy target), so the harness waited on a dead port. The override is gone.
- **2026-07-29 — deep links to any channel silently landed on the wrong one.** Both `org.$orgId.tsx` and `org.$orgId.team.$teamId.tsx` had an effect that navigated to `channels[0]` as soon as `channels` loaded, with no check for a channel already in the URL. Clicking a channel worked (the click doesn't change `channels`, so the effect doesn't re-fire), but reloading that page or opening a shared link rewrote the path to the team's first channel. Both now guard on `!channelId` from `useParams({ strict: false })`. **This is the kind of bug you can't find by using the app** — clicking is the one path that works.
- **`/org` rendered a blank pane.** It's a layout route: sidebar rail plus `<Outlet />`, and the outlet is only filled once an `$orgId` is in the path. There was no index route, so navigating to `/org` directly — or backing out of an organization — was a dead end. Added `routes/org.index.tsx`, an organization picker.
- **`init.sql` indexes weren't idempotent.** The schema is applied by both the `docker-entrypoint-initdb.d` mount and `npm run db:migrate`; tables already used `IF NOT EXISTS` but the 8 `CREATE INDEX` statements did not, so migration failed on the second run with `relation "idx_messages_channel" already exists`.
- **Seed had no threads at all**, despite threading being a headline feature with a dedicated panel. It now seeds a five-reply thread on the release announcement in `#deployments`, a fuller conversation in each channel, and varied reactions. Dave was also posting and reacting in `#deployments` without being a member of it — channel membership is what authorizes reads and writes, so he's now seeded as one.
- **Harness fix (repo-wide, `scripts/screenshots.mjs`):** `page.goto` used `waitUntil: 'networkidle'`, which can *never* fire on a page holding an SSE stream open — every channel screenshot failed with a 30s navigation timeout. It now falls back to `domcontentloaded` on timeout; the per-screen `waitFor`/`delay` is what establishes that content rendered.
- **`dev:server2`/`dev:server3` don't actually change the port:** they're written as `PORT=3002 npm run dev`, and the inner `dev` script re-exports `PORT=3001`, which wins. All three scripts bind 3001, so the multi-instance setup that Redis pub/sub exists to support can't currently be started this way — use `PORT=3002 tsx watch src/index.ts` directly.
- **Pub/sub subscriptions are never released:** `unsubscribeFromChannel` is implemented and exported but has no callers; `sse.ts` subscribes on every connect and the SSE client-cleanup path in `sseService.ts` only removes the client from the local map. Subscriptions accumulate for the process lifetime.
- **SSE needed explicit anti-buffering headers:** the stream sets `X-Accel-Buffering: no` alongside `Cache-Control: no-cache`, because a buffering reverse proxy will hold event chunks and turn a real-time stream into batched delivery. A 30-second `: heartbeat` comment keeps idle connections from being reaped by intermediaries.
- **`app.ts` split from `index.ts`:** the Express app is exported without binding a port so vitest + supertest can exercise routes with `services/db.js` and the storage service mocked, no Docker required.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. Redis pub/sub has no durability, so an instance restart silently drops in-flight broadcasts with no replay. Should SSE events carry a sequence number per channel so a reconnecting client can request the gap — and does that make the message table the real stream, with pub/sub demoted to a wake-up signal?
2. Authorization currently checks membership at the level being accessed. Should it walk the full org → team → channel chain on every request, or should effective permissions be materialized per user per channel and invalidated on membership change?
3. `TypingIndicator` has no backend. Typing is high-frequency and worthless the moment it's stale — is a short-TTL Redis key plus an SSE event right, or is that enough traffic to justify the bidirectional socket decision 1 rejected?
4. Unread counts are the classic denormalization question here: a per-user-per-channel counter incremented on every message write (N writes per message, always fast to read) versus a `COUNT(*)` against a stored last-read timestamp (one cheap write, a query per channel on every sidebar render). Which breaks first at this hierarchy's fan-out?

## Resources

- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — `EventSource` reconnection and the event-stream wire format
- [WHATWG HTML: server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) — the `Last-Event-ID` replay mechanism question 1 is about
- [Redis pub/sub](https://redis.io/docs/latest/develop/interact/pubsub/) — including its explicit at-most-once semantics
- [Redis key expiration](https://redis.io/docs/latest/commands/expire/) — the mechanism behind TTL presence
- [MinIO JavaScript client](https://min.io/docs/minio/linux/developers/javascript/API.html) — presigned GET for attachment downloads

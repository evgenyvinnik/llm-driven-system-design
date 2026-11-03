# Zoom — Development with Claude

## Project Context

Multi-party video is an upstream bandwidth problem disguised as a video problem. Peer-to-peer works beautifully for two people and collapses at five, for a reason that has nothing to do with code quality: in a mesh, every participant sends their stream separately to every other participant. Ten people means nine outbound encodes and nine outbound streams per person — and residential connections have asymmetric bandwidth, with upstream typically a fraction of downstream. The call doesn't degrade gracefully; the weakest uplink in the room fails and takes its participant with it.

So the whole architecture turns on moving the fan-out to a server. Each client sends *one* stream up and receives N-1 down, which fits the shape of consumer internet connections. That server is an SFU — a Selective Forwarding Unit — and it forwards packets without decoding them, which is what distinguishes it from an MCU that composites streams into one (cheap for clients, brutally expensive in server CPU).

What makes this project interesting to build rather than just read about is that the *signaling* is the actual engineering. Media forwarding is a packet-shoveling problem solved by mediasoup or Janus; the part you have to design is the protocol negotiating who produces what, who consumes whom, and what happens to all of it when someone's laptop lid closes mid-sentence.

**Learning goals:** SFU vs mesh vs MCU trade-offs, the Producer/Consumer signaling model and its lifecycle, WebSocket state management for real-time presence, and unguessable-identifier design for meeting access.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API + WebSocket server** (`backend/src/index.ts` → `app.ts`) | **3001** | `createServer(app)` with a `noServer` `WebSocketServer` handling upgrades on `/ws`, so REST and signaling share one process and one session store. `app.ts` exports the app and `sessionMiddleware` so tests can drive it without binding a port |
| **PostgreSQL 16** | 5432 | `users`, `meetings`, `meeting_participants`, `breakout_rooms`, `breakout_assignments`, `meeting_chat_messages`, `recordings` |
| **Valkey (Redis)** | 6379 | Session store via `connect-redis` (prefix `zoom:session:`), read on every HTTP request and every WebSocket upgrade; also meeting-creation idempotency keys |

`services/sfuService.ts` simulates the media plane: a singleton holding `rooms` (meetingId → Router + participants), `producers`, and `consumers` as in-memory maps. `websocket/meetingRooms.ts` is the heart of the signaling plane: live meetings (participants with role and media state, waiting room, lock, removal list, timers) and every policy decision: who gets in, who may do what, what happens on leave, disconnect and restart. `websocket/handler.ts` is the transport: session auth on upgrade, Origin check, per-connection ordered dispatch, heartbeat. Supporting services: `meetingService.ts` (CRUD, code generation, participant roles), `breakoutService.ts`, `chatService.ts`, `metrics.ts` (prom-client gauges for active meetings, participants, and WebSocket connections), `rateLimiter.ts`, `logger.ts` (Pino + pino-http). Schema applies via `npm run db:migrate`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind in a Zoom-style dark theme. Notable components: `MeetingLobby.tsx` (camera/mic preview and device selection before joining), `VideoGrid.tsx` (layout adapts from 1×1 to 5×5 by participant count), `ControlBar` (host lock and End for all), `ParticipantList` with `WaitingRoomList` and `ParticipantActions` (host controls), `ChatPanel`, `BreakoutRooms`, `MeetingMessageScreen` (waiting/ended/removed), plus the `useMediaDevices` hook and `useMeetingConnection`, which registers every signaling handler once per page and drives produce/consume. Vite proxies `/api` → `localhost:3001` and `/ws` with `ws: true`.

## Key Design Decisions

### 1. SFU, not mesh — and not an MCU

Every participant establishes transports to the server; the server forwards. `sfuService` models this with one Router per meeting.

The mesh math is what rules it out. Each participant uploads one stream per *other* participant, so upstream scales as O(N) per client and O(N²) across the call. At 10 participants and a modest 1.5 Mbps video stream, that's ~13.5 Mbps sustained upstream per person — above what most residential uplinks provide, and that's before screen share. The failure isn't gradual: the client's encoder and uplink saturate, packets drop, and the experience craters for everyone receiving from them. Mesh also means N-1 simultaneous encodes on a laptop CPU.

An MCU fixes bandwidth differently — decode everything, composite into a single stream, re-encode per client — which makes the client's job trivial and the server's job enormous. Transcoding is the most expensive thing a media server can do, it adds a decode/encode round trip to end-to-end latency, and it destroys per-client flexibility: everyone gets the same composited layout, so a participant can't pin a speaker or drop to audio-only to save bandwidth.

The SFU sits between: server bandwidth scales as O(N²) across the room (each of N streams forwarded to N-1 receivers), but server *CPU* stays near zero because packets are routed, not decoded. Bandwidth in a datacenter is cheap; CPU and latency are not. What we give up is that the server now sees every stream, so end-to-end encryption becomes an explicit problem rather than a property you get for free from P2P.

### 2. The SFU is simulated, but the signaling protocol is real

`sfuService.ts` creates Routers, generates send/recv transport options with plausible ICE parameters and DTLS fingerprints, and tracks Producers and Consumers with full lifecycle — while never forwarding a single RTP packet. The header comment maps each simulated concept to its mediasoup equivalent.

This is a deliberate trade about which half of the problem is worth building. Real mediasoup requires a C++ toolchain and platform-specific native builds, which breaks the repo's rule that everything runs anywhere with `docker compose up` and `npm run dev`. More to the point, the media-forwarding half is *the part you'd never write yourself* — you'd use mediasoup, Janus, or LiveKit. The signaling protocol is the part every WebRTC application has to design, and it's where the interesting state machine lives.

So what's real here is the thing worth learning: transport negotiation, producer registration, consumer creation per subscriber, cascade cleanup, and the message protocol tying them together. What's fake is packet routing — which means video tiles show placeholders rather than remote streams, and no amount of correct signaling will change that. The honest cost is that a whole class of bugs (congestion control, simulcast layer selection, packet loss recovery) simply cannot appear in this codebase.

### 3. Producers and Consumers are separate objects, and closing a Producer cascades

`createProducer` registers a track and returns an ID; `createConsumer` creates one Consumer per subscriber of that Producer. `closeProducer` walks the consumer map, removes every Consumer pointing at that Producer, and returns the owning user ID so the handler can broadcast.

Modeling this as one "stream" object per participant is the obvious simplification and it breaks immediately, because the relationship is genuinely one-to-many and asymmetric. One camera Producer feeds N-1 Consumers, each of which may be paused, resumed, or dropped independently — that's how "hide this participant's video" or per-client quality adaptation works at all. Collapsing them means every subscriber-side action becomes a global action.

The cascade is the part that's easy to get wrong. When someone stops their camera, the Producer disappears — and every Consumer downstream of it is now referencing something that no longer exists. Without an explicit cascade you leak consumer entries forever and, worse, clients keep rendering tiles for tracks that will never send another packet. `leaveRoom` composes the same operation: close all the participant's Producers (each cascading), drop their Consumers, then delete the room entirely once the last participant leaves so empty Routers don't accumulate.

### 4. Each participant gets separate send and recv transports

`joinRoom` returns two transport option sets — `sendTransportOptions` and `recvTransportOptions` — with distinct IDs and ICE parameters.

One bidirectional transport would be fewer objects and less negotiation, and it couples the two directions in a way that hurts precisely when things go wrong. Upstream and downstream have independent congestion state: a participant on a weak uplink should be able to keep receiving everyone else at full quality while their own outbound video degrades. Sharing a transport means shared congestion control and shared failure — upstream trouble drags down the receive path, so the person whose connection is struggling also stops being able to *see* the meeting, which is the worst possible time to lose it.

Separate transports also make the lifecycle cleaner: "stop sending video" tears down producers on the send transport without touching anything the participant is receiving. The cost is roughly double the transport state and two ICE negotiations per participant instead of one.

### 5. Meeting codes are ten random lowercase letters, formatted `abc-defg-hij`

`generateMeetingCode()` draws from `a–z` in 3-4-3 groups; the column is `VARCHAR(12) UNIQUE` with an index.

A meeting code is a bearer credential — anyone holding it can join. Sequential or short numeric IDs make the room enumerable, and enumerable meeting rooms is exactly the mechanism behind meeting-bombing: a script walks the ID space and joins whatever it finds. Ten letters gives 26¹⁰ ≈ 1.4 × 10¹⁴ combinations, sparse enough that guessing is not a practical attack against a small population of live meetings.

The 3-4-3 grouping is a usability decision with a real cost/benefit: codes get read aloud on phone calls and typed from memory, and chunking is what makes a ten-character string transferable between humans. Lowercase-only avoids case-confusion when dictating.

Codes come from `crypto.randomInt` (a CSPRNG), with a retry on the rare UNIQUE collision. What we give up: the code is still a bearer credential that works for anyone it is forwarded to. That is why the waiting room, lock, capacity and removal list exist (decision 6): the code decides who may *ask* to join; the host decides who gets in.

### 6. Live meeting state is in-process and authoritative; PostgreSQL is the record

`meetingRooms.ts` holds who is in each meeting with which role and media state, and makes every policy check synchronously on the event loop. Two joins cannot both take the last seat, two people cannot both start presenting, and two hosts cannot exist at once. Each change is then written through to PostgreSQL, queued per meeting so writes commit in order.

The obvious alternative, PostgreSQL rows with locks, would survive a restart but puts a round-trip and lock wait on every mute toggle and admit. Redis would allow multiple signaling servers but turns each check into a Lua script. The price of in-process state is one signaling node per meeting and state lost on restart. Boot-time reconciliation closes stale attendance rows and gives active meetings the normal 30s empty-meeting grace, so reconnecting clients continue and abandoned meetings end instead of staying "active" forever.

### 7. One seat per user, held briefly across disconnects

A user has one seat per meeting (matching the `UNIQUE(meeting_id, user_id)` row). A second tab takes the seat and its role; the first gets `session-replaced` and close code 4002. A dropped socket keeps the seat for 10s (`RECONNECT_GRACE_MS`) so a reconnect resumes silently, and a 30s ping/pong heartbeat finds dead sockets. Allowing several seats per user (one per tab) would avoid kicking the old tab, but it breaks the one-row-per-attendee model and doubles the user in everyone's grid. Leaving immediately on a drop would remove the grace window, but every Wi-Fi blip would then flash "left / joined" to the whole room and cost a non-organizer host their role.

## Current State

Runs end to end:
- API + WebSocket on 3001, with session auth in Redis on both.
- Meeting scheduling with explicit time zones, idempotent creation, join-by-code, and a pre-join lobby.
- Waiting room, lock, capacity, mute-on-entry and screen-share permission, all enforced.
- Host and co-host controls: admit/deny, mute and mute all, remove (no rejoin), lock, transfer host, co-host, end for all. When the host leaves, the role is auto-promoted.
- One seat per user with tab takeover, a reconnect grace window and a heartbeat.
- The full signaling protocol, with the client actually producing and consuming against the simulated SFU.
- In-meeting chat with DMs, and history that hides other people's DMs.
- Breakout rooms: create, assign, open, close, with each participant told their room.
- Meeting history covering attended meetings, now that meetings actually end.
- Prometheus metrics, rate limiting, and pino logging.

Tests: 50 backend tests (`app.test.ts`, `websocket/meetingRooms.test.ts`, `websocket/handler.test.ts`), 9 Playwright smoke tests, and a 72-check live script (see the log below).

Seeded logins (all `password123`): `alice` (Alice Johnson), `bob` (Bob Smith), `charlie` (Charlie Davis). Seeded meetings:
- `abc-defg-hij`: alice hosts, mute on entry. Re-seeding resets it to scheduled.
- `bob-wait-rom`: bob hosts, waiting room on, screen sharing off.
- `xyz-abcd-efg`: an ended review that alice and charlie attended. It includes a charlie→bob DM that alice must never see.

**Known simplifications, all deliberate:**
- Media is never routed between peers. Video tiles render placeholders, and screen share shows a placeholder rather than captured display content.
- Live meeting state is in one process with no Redis pub/sub, so this is strictly single-server. `dev:server1/2/3` exist but cannot share meetings.
- Breakout rooms assign and notify. They do not isolate media or chat per room; that would need a Router per room (open question 4).
- The `recordings` table exists in the schema; nothing reads or writes it.
- `services/circuitBreaker.ts` exports `createCircuitBreaker` but no query is wrapped with it.
- `/api/health` is liveness only. The rate limiter uses an in-memory store.
- Chat has no client message ids: a message whose acknowledgment is lost is not retried.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the previous CLAUDE.md, which was closer than most in this repo but still presented a forward-looking "Development Phases" plan instead of describing the built system, and whose Tech Stack line claimed "Monitoring: Pino (logging), prom-client (metrics), **Opossum (circuit breaker)**" — while `createCircuitBreaker` is never invoked anywhere outside a test mock. It also never explained *why* the SFU choice matters (no mesh bandwidth math), which is the one thing this project exists to teach.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 NODE_ENV=development tsx watch src/index.ts`, matching both Vite proxy entries — `/api` and `/ws` (with `ws: true` so the upgrade is forwarded).
- **Room cleanup on empty:** `leaveRoom` deletes the Router once the last participant leaves, so a long-running process doesn't accumulate one room object per meeting ever held.
- **Producer close cascades to Consumers:** without it, consumer entries leak and clients keep rendering tiles for tracks that will never send again — see decision 3.
- **Host role assigned at join time:** `handleJoinMeeting` compares `meeting.host_id` against the connecting user and calls `setParticipantRole(..., 'host')`, so host privileges survive the host reconnecting rather than being pinned to a socket.
- **Schema applies via `npm run db:migrate`** (`backend/src/db/migrate.ts`) — run it before seeding on a fresh clone.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

- **2026-08-10 — "Meeting History" was empty for everyone who wasn't the organizer, and the in-meeting UI had never been captured.**
  1. **`getUserMeetings` filtered on `host_id` alone.** Alice attended the seeded "Project Review" as a participant — her attendance is recorded in `meeting_participants`, a table nothing read — so her history page showed "No past meetings" while the row sat right there. A history view that only shows meetings you organized is wrong for the common case: most people attend far more meetings than they schedule. Now a `LEFT JOIN` on `meeting_participants` with `DISTINCT` (a host also has a participant row for their own meeting).
  2. **Screenshots 5 → 6, and the two new ones are the point of the project.** The old set was login/register/dashboard/schedule/history — entirely the scheduling shell, with nothing from the meeting itself. Added the **pre-join lobby** (camera/mic preview, device selection, display-name entry) and the **in-meeting view** reached by actually clicking Join: the adaptive video grid with a labeled tile, the full control bar (mute, camera, screen share, raise hand, chat, participant list with count badge, layout toggle), the meeting code, and Leave. Note the device dropdowns read `videoinput (...)` — headless WebKit exposes no real capture devices, so the labels are empty. That is the capture environment, not a defect.
- **Answer docs verified, not rewritten:** 354/363/427 lines, all inside the 350–550 band, no labeled code fences, and the claims match the implementation — including the honest ones (simulated SFU, query-param WebSocket identity, single-server in-process maps).

- **2026-11-02 — Socket identity, meeting access, host controls and attendance bookkeeping.** The project described a signaling server with RBAC, a waiting room and idempotent creation. The code had a socket that trusted whatever user id the client sent, and none of those features.
  1. **The WebSocket took `userId`/`username` from the query string.** Anyone could connect as anyone, and because the host role was assigned by comparing that id with `meetings.host_id`, anyone could be any meeting's host. Fix: the upgrade runs through the exported express-session middleware (the coinbase/excalidraw fix), closing unauthenticated sockets with 4001. An `Origin` allowlist (`ALLOWED_ORIGINS`) closes cross-site socket hijacking, which cookie auth would otherwise open.
  2. **Anyone with the code joined anything.** The waiting room and `maxParticipants` were stored and ignored, there was no lock, and ended meetings could be rejoined. Fix: new `websocket/meetingRooms.ts` enforces them all. The organizer bypasses every gate, since otherwise a host could lock themselves out of their own meeting.
  3. **Host controls did not exist.** The RBAC section of `architecture.md` described them, but there was no mute-others, remove, end, transfer or co-host. A meeting whose host left had nobody able to moderate. Meetings never ended at all (the frontend never called end), so History never showed a real meeting. Fix:
     - ranked roles, where every action needs a target ranked strictly below the caller;
     - auto-promotion when the host leaves, and the organizer reclaims host on return;
     - End for all;
     - meetings end 30s after the room empties;
     - removed users can't rejoin.
  4. **Bookkeeping broke on duplicate tabs and disconnects.** The client map was keyed by user id, so a second tab replaced the first, and closing the first then evicted the second and announced a leave. Leave followed by the socket close ran twice (double `participant-left`, a negative gauge). The rejoin upsert kept the old role and flags, so a former host rejoined as a second host. A restart left attendance rows open forever. Fix:
     - one seat per user, with the newest connection taking over;
     - leave is idempotent;
     - a 10s reconnect grace and a ping/pong heartbeat;
     - fresh state on rejoin;
     - boot-time reconciliation;
     - messages processed in order per connection (`produce` used to race `join`).
  5. **Authorization holes elsewhere.**
     - Chat history returned every message, including other people's DMs, for any meeting, to any user. It now filters DMs in SQL and returns 404 to non-attendees.
     - REST chat POST let anyone write into any meeting. It now requires a live participant and delivers over WebSocket.
     - Breakout routes accepted anyone. They now need the organizer or the live host/co-host, assignments are limited to the same meeting, and a unique index on `participant_id` allows one room per participant.
     - Meeting and participant reads by id now return 404 to strangers.
     - Any participant could close anyone's producer, and producers could be consumed across meetings.
  6. **Scheduling was off by the user's UTC offset.** `datetime-local` values have no zone and were stored as UTC. The API now requires an offset, and the form sends `toISOString()` and shows the zone.
  7. **Smaller fixes:**
     - CSPRNG meeting codes with collision retry;
     - `Idempotency-Key` on create (described in `architecture.md`, never built);
     - session regeneration at login;
     - camelCase register response;
     - mute-on-entry and screen-share permission enforced;
     - one presenter at a time;
     - lobby mute/camera state carried into the meeting;
     - the mute button now disables the real track;
     - a headers-merge bug in `api.ts` that dropped Content-Type;
     - a breakout panel that couldn't assign anyone;
     - chat history that returned the oldest messages instead of the newest;
     - a test suite whose mocks no longer matched the imports, so it didn't load;
     - a `lint` glob that skipped top-level files.
  - **Verified:**
    - 50 backend tests;
    - a 72-check live script (fetch + ws, alice/bob/charlie plus a registered stranger), run twice from a clean reset, 72/72 both times;
    - 9 screenshots (new: host controls, breakout rooms, waiting room), captured while a helper script kept bob and charlie connected;
    - 9/9 smoke tests.

  Runbook note: if port 5173 is taken, run the frontend with `npm run dev -- --port 5199 --strictPort` and start the backend with `ALLOWED_ORIGINS=http://localhost:5199`. The socket's Origin check refuses origins it wasn't told about.

## Open Questions

1. The socket now authenticates by session cookie on the upgrade. With several signaling nodes, should a node hand a client off with a short-lived signed token issued by the REST API, so signaling nodes never read the session store?
2. All meeting state lives in per-process maps, which caps the system at one server. Is Redis pub/sub enough (broadcast signaling messages across instances), or does an SFU fundamentally need participants of one meeting pinned to one node, making this a routing problem rather than a fan-out problem?
3. Codes now come from a CSPRNG, and the waiting room makes admission a host decision. Should meetings with a waiting room off still get a passcode, or are lock plus removal enough for ad-hoc meetings?
4. Breakout rooms move participants between groups, which in a real SFU means tearing down every Consumer and rebuilding against a different Router. The simulation doesn't exercise that. What's the right unit of isolation — one Router per breakout room, or one Router per meeting with consumer-level filtering?

## Resources

- [mediasoup design overview](https://mediasoup.org/documentation/v3/mediasoup/design/) — the Worker/Router/Transport/Producer/Consumer model `sfuService.ts` simulates
- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) — transports, ICE, and DTLS as the signaling payloads describe them
- [RFC 8831: WebRTC data channels](https://datatracker.ietf.org/doc/html/rfc8831) — the transport layer beneath the signaling protocol
- [ws](https://github.com/websockets/ws) — the WebSocket server attached at `/ws`
- [Comparing SFU, MCU and mesh](https://webrtcglossary.com/sfu/) — the three-way architecture trade-off in decision 1

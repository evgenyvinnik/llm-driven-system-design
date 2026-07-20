# Zoom — Development with Claude

## Project Context

Multi-party video is an upstream bandwidth problem disguised as a video problem. Peer-to-peer works beautifully for two people and collapses at five, for a reason that has nothing to do with code quality: in a mesh, every participant sends their stream separately to every other participant. Ten people means nine outbound encodes and nine outbound streams per person — and residential connections have asymmetric bandwidth, with upstream typically a fraction of downstream. The call doesn't degrade gracefully; the weakest uplink in the room fails and takes its participant with it.

So the whole architecture turns on moving the fan-out to a server. Each client sends *one* stream up and receives N-1 down, which fits the shape of consumer internet connections. That server is an SFU — a Selective Forwarding Unit — and it forwards packets without decoding them, which is what distinguishes it from an MCU that composites streams into one (cheap for clients, brutally expensive in server CPU).

What makes this project interesting to build rather than just read about is that the *signaling* is the actual engineering. Media forwarding is a packet-shoveling problem solved by mediasoup or Janus; the part you have to design is the protocol negotiating who produces what, who consumes whom, and what happens to all of it when someone's laptop lid closes mid-sentence.

**Learning goals:** SFU vs mesh vs MCU trade-offs, the Producer/Consumer signaling model and its lifecycle, WebSocket state management for real-time presence, and unguessable-identifier design for meeting access.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API + WebSocket server** (`backend/src/index.ts` → `app.ts`) | **3001** | `createServer(app)` wrapped by a `WebSocketServer` on path `/ws`, so REST and signaling share one process. `app.ts` is exported separately so `app.test.ts` can drive it under vitest without binding a port |
| **PostgreSQL 16** | 5432 | `users`, `meetings`, `meeting_participants`, `breakout_rooms`, `breakout_assignments`, `meeting_chat_messages`, `recordings` |
| **Valkey (Redis)** | 6379 | Session store via `connect-redis` (prefix `zoom:session:`) — sessions only; the WebSocket layer does not use it |

`services/sfuService.ts` is the heart: a singleton holding `rooms` (meetingId → Router + participants), `producers`, and `consumers` as in-memory maps. `websocket/handler.ts` implements the signaling protocol — `join-meeting`, `leave-meeting`, `produce`, `consume`, `producer-close`, `toggle-mute`, `toggle-video`, `start/stop-screen-share`, `raise-hand`, `chat-message` — over its own `clients` and `meetingClients` maps. Supporting services: `meetingService.ts` (CRUD, code generation, participant roles), `breakoutService.ts`, `chatService.ts`, `metrics.ts` (prom-client gauges for active meetings, participants, and WebSocket connections), `rateLimiter.ts`, `logger.ts` (Pino + pino-http). Schema applies via `npm run db:migrate`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind in a Zoom-style dark theme. Notable components: `MeetingLobby.tsx` (camera/mic preview and device selection before joining), `VideoGrid.tsx` (layout adapts from 1×1 to 5×5 by participant count), `ControlBar`, `ParticipantList`, `ChatPanel`, `BreakoutRooms`, `ScreenShareView`, plus a `useMediaDevices` hook. Vite proxies `/api` → `localhost:3001` and `/ws` with `ws: true`.

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

What we give up: `Math.random()` is not a CSPRNG, so the codes are not cryptographically unpredictable — fine against enumeration, not fine against an adversary modeling the PRNG state. And the code is the *only* access control on a running meeting; the waiting-room flag is stored but not enforced.

## Current State

Runs end to end: API + WebSocket on 3001, session auth in Redis, meeting scheduling and CRUD, join-by-code, a pre-join lobby with camera/mic preview and device selection, the full signaling protocol over `/ws`, simulated SFU room/transport/producer/consumer lifecycle, participant state (mute, video off, screen share, hand raise) broadcast in real time, in-meeting chat including DMs, breakout room creation/assignment/activation/close, meeting history, an adaptive video grid, Prometheus metrics on `/api/metrics` (active meetings, active participants, WebSocket connections, HTTP duration), rate limiting on `/api/`, structured logging via pino-http, and a vitest + supertest suite in `backend/src/app.test.ts`.

Seeded logins (all `password123`): `alice` (Alice Johnson), `bob` (Bob Smith), `charlie` (Charlie Davis).

**Known simplifications, all deliberate:**
- Media is never routed between peers — video tiles render placeholders, and screen share shows a placeholder rather than captured display content.
- **WebSocket auth reads `userId` and `username` from query parameters** rather than validating the session cookie. Any client can claim any identity on the socket. This is the single largest gap between this codebase and something deployable.
- The WebSocket layer keeps `clients` and `meetingClients` as in-process maps with no Redis pub/sub, so this is strictly single-server: two API instances would each host meetings the other can't see. Note that `dev:server1/2/3` exist but are misleading here for that reason.
- The `recordings` table exists in the schema; nothing reads or writes it.
- Waiting room is a settings flag with no enforcement.
- `services/circuitBreaker.ts` exports `createCircuitBreaker` but nothing in production code calls it — it appears only as a mock in `app.test.ts`.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the previous CLAUDE.md, which was closer than most in this repo but still presented a forward-looking "Development Phases" plan instead of describing the built system, and whose Tech Stack line claimed "Monitoring: Pino (logging), prom-client (metrics), **Opossum (circuit breaker)**" — while `createCircuitBreaker` is never invoked anywhere outside a test mock. It also never explained *why* the SFU choice matters (no mesh bandwidth math), which is the one thing this project exists to teach.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 NODE_ENV=development tsx watch src/index.ts`, matching both Vite proxy entries — `/api` and `/ws` (with `ws: true` so the upgrade is forwarded).
- **Room cleanup on empty:** `leaveRoom` deletes the Router once the last participant leaves, so a long-running process doesn't accumulate one room object per meeting ever held.
- **Producer close cascades to Consumers:** without it, consumer entries leak and clients keep rendering tiles for tracks that will never send again — see decision 3.
- **Host role assigned at join time:** `handleJoinMeeting` compares `meeting.host_id` against the connecting user and calls `setParticipantRole(..., 'host')`, so host privileges survive the host reconnecting rather than being pinned to a socket.
- **Schema applies via `npm run db:migrate`** (`backend/src/db/migrate.ts`) — run it before seeding on a fresh clone.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. WebSocket identity comes from query params, so the socket trusts whatever the client claims. The session cookie is already sent on the upgrade request — is validating it in the `verifyClient` hook sufficient, or does this need a short-lived signed token issued by the REST API so the WS layer never touches session storage?
2. All meeting state lives in per-process maps, which caps the system at one server. Is Redis pub/sub enough (broadcast signaling messages across instances), or does an SFU fundamentally need participants of one meeting pinned to one node, making this a routing problem rather than a fan-out problem?
3. `generateMeetingCode()` uses `Math.random()`. Switching to `crypto.randomBytes` is a one-line change — but is the code alone ever an acceptable access control, or does any meaningful threat model force a waiting room or per-participant invite tokens regardless of entropy?
4. Breakout rooms move participants between groups, which in a real SFU means tearing down every Consumer and rebuilding against a different Router. The simulation doesn't exercise that. What's the right unit of isolation — one Router per breakout room, or one Router per meeting with consumer-level filtering?

## Resources

- [mediasoup design overview](https://mediasoup.org/documentation/v3/mediasoup/design/) — the Worker/Router/Transport/Producer/Consumer model `sfuService.ts` simulates
- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) — transports, ICE, and DTLS as the signaling payloads describe them
- [RFC 8831: WebRTC data channels](https://datatracker.ietf.org/doc/html/rfc8831) — the transport layer beneath the signaling protocol
- [ws](https://github.com/websockets/ws) — the WebSocket server attached at `/ws`
- [Comparing SFU, MCU and mesh](https://webrtcglossary.com/sfu/) — the three-way architecture trade-off in decision 1

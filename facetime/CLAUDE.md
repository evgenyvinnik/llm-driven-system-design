# FaceTime — Development with Claude

## Project Context

Almost every other project in this repo is about moving data *through* a server. This one is about getting two browsers to stop needing the server. WebRTC media flows peer-to-peer, so the backend here never touches a video frame — it exists purely to solve the bootstrapping problem: two devices that have no idea how to reach each other, both sitting behind NATs that only permit outbound connections, need to exchange enough information to open a direct path. That exchange is *signaling*, and it is the entire job of this backend.

What makes it architecturally interesting is that the signaling server is stateful in an awkward way. A call has a lifecycle — ringing, answered, declined, timed out, ended — and that state has to be consistent across two or more parties who are each connected over a separate, independently-droppable WebSocket. Worse, a user isn't one endpoint: Alice has a laptop and a phone, both registered, and calling "Alice" means ringing *both* and then making sure that when she answers on one, the other stops ringing. The classic bug in every calling system is the phantom ring — a device that keeps ringing for a call that was answered, declined, or abandoned somewhere else.

The third thing is that failure is normal, not exceptional. NAT traversal fails often enough that a relay fallback (TURN) isn't a nicety, it's a required component, and it's the one place where media *does* hit a server.

**Learning goals:** the WebRTC offer/answer/ICE handshake and what the signaling channel must carry, STUN vs TURN and why a relay is mandatory, multi-device fan-out with a single-answer invariant, call state in Redis with TTLs, and idempotent call initiation over an unreliable transport.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **Express + `ws` signaling server** (`backend/src/index.ts`) | **3001** | REST for users/history plus the `/ws` signaling channel. Signaling must be bidirectional and server-initiated — the server has to *push* a ring to a callee who isn't asking for anything |
| **PostgreSQL 16** | 5432 | `calls`, `call_participants`, `call_history`, `users`, `user_devices` — the durable record. Call history must survive a Redis flush; live call state need not |
| **Valkey (Redis)** | 6379 | Presence (`setUserOnline`, 1-hour TTL) and live call state (`call:<id>`, **2-hour TTL**). Both are ephemeral by nature and both need automatic expiry, which is exactly what Redis gives for free |
| **Coturn** | 3478 (UDP/TCP), 5349, 49152–49200/UDP | The TURN relay. This is the one component that carries actual media, and only for peers whose NATs refuse a direct path |

Signaling is decomposed under `backend/src/services/signaling/`: `connection-manager.ts` owns the process-local maps (`clients`, `userClients`, `ringTimeouts`), `registration-handler.ts` handles device registration and disconnect, `call-initiate-handler.ts` creates calls and fans out rings, `call-response-handler.ts` handles answer/decline/end, `signaling-handler.ts` relays the WebRTC offer/answer/ICE payloads, and `room-manager.ts` handles teardown and ring timeout. `GET /turn-credentials` on the API returns the ICE server list. Frontend is React 19 + Zustand + Tailwind (no router — `App.tsx` switches on call state), with all the WebRTC machinery in `frontend/src/hooks/useWebRTC.ts` and the socket in `services/signaling.ts`.

## Key Design Decisions

### 1. The server relays SDP and ICE candidates opaquely and never parses them

`signaling-handler.ts` forwards `offer`, `answer`, and `ice_candidate` messages between clients without inspecting the payloads beyond routing. The server has no SDP parser, no media knowledge, and no notion of codecs.

The alternative is an SFU or MCU — a server that terminates media, decodes it, and re-encodes or re-forwards streams. That's what you need for group calls above ~4 participants, and it's a fundamentally different system: it must run media pipelines, its bandwidth cost scales with participants × streams, and it becomes a latency-adding hop on every frame. For 1:1 calls it's pure loss. Peer-to-peer gives the lowest achievable latency (one network path, no transcoding), costs the server nothing per minute of call, and means media never touches infrastructure we'd have to secure.

What we give up is the scaling ceiling: mesh topology means each participant sends N-1 encoded streams. At 4 participants that's 3 simultaneous uploads each, and consumer upstream bandwidth is where it collapses — not server capacity. So this design is 1:1-shaped by construction, and group calling isn't a feature to add so much as a second architecture to build.

### 2. Ring fan-out targets every registered device, with a process-local `userClients` index

`connection-manager.ts` maintains `clients: Map<clientId, ConnectedClient>` and `userClients: Map<userId, Set<clientId>>`. Call initiation looks up `getUserClientIds(calleeId)` and sends `call_ring` to every connected device.

Ringing one device is what a naive implementation does, and it's wrong in a way users notice immediately: Alice is registered on her laptop and phone, she's holding the phone, and the call rings the laptop in another room. There's no way to know which endpoint the human is at, so the only correct behavior is to ring all of them and let the human choose — which is precisely why the reverse index exists rather than just scanning all clients on every call.

The consequence is that the *answer* path now carries an invariant: the first device to answer wins and every other ringing device must be told to stop. That's the phantom-ring bug, and it's the reason `call-response-handler.ts` and `room-manager.ts` are separate from initiation — teardown has to reach devices that were never going to participate in the call.

The honest limitation: these maps are process-local. `dev:server2` / `dev:server3` (ports 3002/3003) exist, but two signaling instances have disjoint client maps, so a caller on instance A cannot ring a callee connected to instance B. Multi-instance signaling needs the fan-out to go through Redis pub/sub, which isn't implemented.

### 3. Live call state in Redis with a 2-hour TTL, durable history in Postgres

`setCallState(callId, {...})` writes the full live state — participants, type, state, initiator device — to `call:<callId>` with `EX: 7200`. The `calls` and `call_participants` rows in Postgres are written in the same flow but are the *record*, not the working state.

Putting live call state only in Postgres means every ICE candidate relay and every state transition is a database round-trip on a latency-sensitive path, for data whose useful lifetime is minutes. Putting it only in Redis means a Redis restart loses call history permanently, and history is the thing users actually go looking for later. Splitting by lifetime is the natural cut.

The TTL is the interesting part. Calls end in many ways and not all of them run cleanup code — a client crashes, a server restarts mid-call, a network partitions. Without expiry, `call:*` keys accumulate forever as garbage that nothing will ever delete, because the only process that knew about them is gone. A 2-hour TTL means the worst case is a stale key that costs a little memory and expires on its own; presence keys get the same treatment at 1 hour. What we give up is that a genuinely long call would have its live state vanish out from under it at the two-hour mark — a real bug, just one that's out of range for a demo.

### 4. Call initiation is idempotent, with the key stored *before* the call is created

`handleCallInitiate` accepts an optional `idempotencyKey`, checks it via `checkIdempotencyKey`, returns the existing `callId` on a duplicate, and — critically — calls `storeIdempotencyKey(key, callId)` **before** inserting into `calls`.

The ordering is the whole point. WebSockets drop and clients retry, and a user double-tapping the call button on a flaky connection is the common case, not the edge case. If the key were stored *after* the insert, a crash in between leaves a call created with no key recorded, so the retry creates a second call — and now two calls are ringing the same callee simultaneously, which is the worst possible user-visible outcome. Storing the key first means a crash in the gap leaves an orphaned key pointing at a call that doesn't exist: the retry short-circuits and returns a dead call ID, which fails cleanly and visibly instead of duplicating a ring. Given the choice between "fails loudly" and "rings twice", the first is strictly better.

### 5. Ring timeout is a 30-second in-process timer, not a scheduled job

`call-initiate-handler.ts` sets `setTimeout(() => handleRingTimeout(callId), 30000)` and stores the handle in `connection-manager`'s `ringTimeouts` map so it can be cancelled on answer or decline.

A missed-call transition has to happen even when *nobody sends another message* — the callee is asleep, the caller walked away. Client-side timeouts don't work: whichever client was going to fire it is exactly the client that might have disconnected. A durable scheduler (a queue with delayed delivery, or a periodic sweeper over `calls` rows in state `ringing`) would survive a server restart, which the in-process timer does not — restart the backend mid-ring and that call stays `ringing` in Postgres forever, until the Redis key expires two hours later and nothing reconciles the row. That's the accepted cost of not running a scheduler for a 30-second timer.

## Current State

Runs end to end on backend 3001 + Vite 5173 (Vite proxies `/api` and `/ws` to 3001), with Postgres, Valkey, and Coturn from `docker-compose.yml`. Working: WebSocket device registration and presence, contact list showing online status, 1:1 audio and video calls through the full lifecycle (initiate → ring all devices → answer/decline → connected → end), the complete WebRTC handshake relayed through the signaling server (`createOffer`/`createAnswer`/`addIceCandidate` in `useWebRTC.ts`), `getUserMedia` capture with local and remote video elements, in-call controls (mute, video toggle, end), a 30-second ring timeout, idempotent call initiation, ICE server configuration served from `GET /turn-credentials` (Google public STUN plus the local Coturn instance), 30-second heartbeat with 60-second stale-client termination, Opossum circuit breakers around the database writes in the call path, Prometheus metrics (calls initiated, active calls, signaling latency, connection counts), Pino structured logging with a separate audit log for call and credential events, and call history over the REST API.

Seeded users: **`alice`** (Alice Smith), **`bob`** (Bob Johnson), **`charlie`** (Charlie Brown), and **`admin`** (Admin User), with sample devices attached to the first three. **There are no passwords** — `LoginScreen.tsx` presents the user list and you pick an identity. That's deliberate: this project is about the signaling and media path, and adding credentials would only put noise in front of the thing being studied.

Intentionally simplified or absent: group calls (mesh topology and the schema's `max_participants` anticipate them, but there is no SFU and the UI is built for two parties), adaptive bitrate and simulcast, in-call network statistics (`getStats()` is never called, so there's no quality telemetry), audio processing, E2E encryption beyond WebRTC's mandatory DTLS-SRTP, and screen sharing.

**One caveat on TURN credentials:** `/turn-credentials` returns a static username/password from environment variables, and the endpoint itself is unauthenticated. Real deployments issue time-limited HMAC credentials derived from a shared secret, precisely because a static TURN credential is a free bandwidth relay for anyone who finds it. The code comment acknowledges this; it isn't implemented.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md with this structure. The checklist was wrong in the direction that matters most — Phase 4 "Security" listed every item unchecked and said nothing about what *was* built, while idempotent call initiation, audit logging, circuit breakers, and heartbeat-based stale-connection termination were all implemented and unmentioned. Phase 2 "Media Quality" was marked "In Progress" with zero items checked, which is more accurately "not started". The old file also never explained the single-answer invariant or the process-local client maps, which are the two things that actually determine how this system behaves.
- **Signaling split into handlers:** a single monolithic signaling file was decomposed into `services/signaling/{connection-manager,registration-handler,call-initiate-handler,call-response-handler,signaling-handler,room-manager}.ts`. The forcing function was the ring-timeout lifecycle: cancelling a timer set during initiation from within the answer path was unreadable when both lived in one file, and that's exactly the code path where a bug becomes a phantom ring.
- **Idempotency key stored before call creation:** the ordering was reversed to make a crash between the two writes fail closed rather than produce a duplicate ring. See decision 4.
- **TTLs added to all Redis keys:** presence at 1 hour, call state at 2 hours. Before this, abnormal call termination (client crash, server restart) leaked `call:*` and presence keys permanently, and stale presence meant the contact list showed users as online who had been gone for days.
- **Database writes in the call path wrapped in circuit breakers:** `withCircuitBreaker('db-call-create', ...)` and `'db-participant-add'`, so a Postgres stall fails the call attempt fast with a clear error instead of hanging the signaling socket — which would otherwise take the heartbeat down with it and disconnect an otherwise-healthy client.
- **Backend port pinned to 3001:** the `dev` script hardcodes `PORT=3001` to match the Vite proxy targets for both `/api` and `/ws`. Without the pin the UI loaded and the contact list stayed empty with no visible error.
- **CI:** the repo-wide smoke-test workflow was removed — a CI runner can't provide Postgres, Redis, and Coturn, so it failed on every PR without signalling a real defect.

## Open Questions

1. Ring timeouts are in-process `setTimeout` handles. A backend restart during a ring leaves the `calls` row stuck in `ringing` with nothing to reconcile it. Is the right fix a periodic sweeper over `state = 'ringing' AND created_at < now() - 30s` (simple, but polling), or does call state belong in a queue with delayed delivery — and is that justified for a 30-second timer?
2. Multi-device fan-out works within one process only. Moving it to Redis pub/sub makes ringing work across instances, but the *answer* path then has to cancel rings on devices attached to other instances — is a broadcast "call answered" event on a per-call channel sufficient, or does the single-answer invariant need an actual lock to prevent two devices answering simultaneously?
3. `/turn-credentials` hands out static credentials to anyone who asks. Time-limited HMAC credentials are the standard fix, but they require the endpoint to know who's asking — which means this demo would need real auth before it can have real TURN security. Which comes first?
4. There's no `getStats()` polling, so we have no visibility into whether a given call actually established a direct path or fell back to the TURN relay. Since relay usage is the single most important operational metric for a calling system (it's the one that costs money and adds latency), what's the minimum telemetry worth collecting — just the selected candidate pair type, or full per-call quality traces?

## Resources

- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) — the offer/answer and ICE flow implemented in `useWebRTC.ts`
- [RFC 8445: Interactive Connectivity Establishment (ICE)](https://datatracker.ietf.org/doc/html/rfc8445) — candidate gathering and the checks that decide direct vs relayed
- [Coturn](https://github.com/coturn/coturn) — the TURN server in `docker-compose.yml`, including its time-limited credential mechanism
- [Jitsi: a look inside the sausage factory](https://jitsi.org/blog/a-looking-in-the-sausage-factory-of-jitsi/) — what an SFU actually does, i.e. the architecture decision 1 declines to build
- [WebRTC perfect negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation) — handling glare when both peers offer at once

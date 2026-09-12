# FaceTime Calling Architecture

## System Overview

This is a FaceTime-inspired learning project for understanding the boundary between call control and real-time media. A React client captures audio/video and creates a WebRTC peer connection; an Express/WebSocket process coordinates identities, ringing, and negotiation; PostgreSQL and Redis hold call-related records. It is not a description of Apple's deployed system.

This document separates a **proposed production architecture** from **current local behavior**. Requirements, sizing, the main diagram, and design decisions describe the proposal. Database Schema reproduces the local initialization SQL, API Design inventories actual routes/messages, and Implementation Notes traces the source and its limitations. The [README](./README.md) supplies setup; the interview answers present bounded, role-specific designs.

The current implementation does not authenticate users or enforce call membership. It also has a named circuit-breaker closure defect that reuses earlier request values, non-atomic call transitions, and browser signaling/media lifecycle races. Presence, idempotency, or metrics helpers do not by themselves establish a reliable calling service.

## Requirements

### Functional requirements — production proposal

Start with one-to-one audio/video calls, ringing across a user's registered devices, one accepted answering device, mute/video controls, call history, and recovery from short signaling interruptions. Public identity discovery is not permission to impersonate a user or enter their calls. A user has at most one accepted call under the initial busy policy.

The production extension supports bounded group rooms through an SFU with explicit participant admission, selective subscriptions, and encryption appropriate to that topology. Device transfer is a new, authorized endpoint claim with a later generation; it must not leave both old and new devices controlling the same seat. Push notification integration, screen sharing, effects, recording, and shared media experiences are separate features rather than prerequisites for the one-to-one call path.

A call acceptance is a control-plane decision. Media connected is an observed endpoint condition. The interface and metrics distinguish ringing, acceptance, negotiating media, an active media path, and a temporary loss of either signaling or media.

### Non-functional requirements — proposed, unmeasured targets

| Concern | Initial target / invariant | Boundary |
|---------|----------------------------|----------|
| Online ringing | p95 below two seconds from call request to first online-device ring | Excludes offline push delivery and human response |
| Media setup | p95 below three seconds from acceptance to usable media | Supported devices/networks and working relay capacity |
| Media delay | Aim below 200 ms one-way within a region | Includes capture/encode/network/playout; RTT is a different measurement |
| Availability | 99.9% regional call-control availability | Existing direct media may outlive a signaling outage |
| Acceptance | At most one winning device per invited user/seat | Atomic claim, including busy-state and deadline checks |
| Retry behavior | Same actor/operation/body returns one durable outcome | No phantom call ID after partial creation |
| Recovery | Reconcile call state and endpoint generations after reconnect | Do not replay obsolete SDP into a new negotiation |
| Access | Authenticated devices and authorized call membership | Enforced independently of browser controls |
| Group envelope | Evaluate up to 32 participants with bounded subscriptions | No universal mesh cutoff or server-users-per-core promise |

TURN improves connectivity but cannot guarantee it through every firewall or outage. Likewise, no fixed packet-loss percentage defines when all codecs and devices will degrade. Validate these targets against representative network, device, codec, and room profiles.

## Capacity Estimation

These are exercise assumptions, not production measurements:

| Assumption | Consequence |
|------------|-------------|
| 100,000 concurrent one-to-one calls | 200,000 media endpoints |
| Five-minute average duration at steady occupancy | About 333 new calls/second |
| 30 application signaling messages per completed call | About 10,000 signaling messages/second at that steady rate |
| Two million online sockets sending a heartbeat every 30 seconds | About 66,667 heartbeat messages/second, separate from call setup |
| 20% of calls use a relay, each party sends 1.5 Mb/s | 60 Gb/s TURN ingress and 60 Gb/s egress across the fleet |
| 32-person mesh, each sender supplies 1.5 Mb/s per peer | 496 total peer pairs and 46.5 Mb/s upload per endpoint |

A six-person mesh has fifteen total peer pairs, not fifteen uploads per person; each endpoint has five peers. An SFU removes that endpoint connection multiplication, but forwarding every source to every receiver still has quadratic aggregate egress. With one 1.5 Mb/s source and five subscribed remote sources per participant, a 32-person example has 48 Mb/s ingress and 240 Mb/s egress before audio, extra encoding layers, and protocol overhead.

Simulcast can publish several encodings, so “one upload” means one server relationship, not necessarily one encoded layer or fixed bitrate. TURN ratios, bitrates, and subscription counts require measurement. ICE consent and transport keepalives are not automatically application WebSocket messages.

### Local Development Scale

The fixture creates four users and four sample device rows, with no calls. The application maintains one peer connection and one remote stream per browser. One Node process owns its connected clients, user index, and ring timers. PostgreSQL and Valkey are single instances; Coturn exposes a small relay-port range. No load or media-quality benchmark was run for this review.

## High-Level Architecture

The proposed control path is separate from the media path:

```
┌──────────────────────┐     ┌──────────────────────┐
│ Authenticated device │────▶│ HTTPS / WS gateway   │
└──────────────────────┘     └──────────┬───────────┘
                                        ▼
┌──────────────────────┐     ┌──────────────────────┐
│ Device routing / push│◀────│ Call authority       │
└──────────────────────┘     └──────────┬───────────┘
                                        ▼
                             ┌──────────────────────┐
                             │ PostgreSQL + outbox  │
                             │ Claims / receipts    │
                             └──────────────────────┘

┌──────────────────────┐     ┌──────────────────────┐
│ Browser A            │◀───▶│ Browser B            │
└──────────────────────┘     └──────────────────────┘
      Direct encrypted media, or opaque TURN relay

┌──────────────────────┐     ┌──────────────────────┐
│ Group endpoints      │◀───▶│ SFU media forwarding │
└──────────────────────┘     └──────────────────────┘
```

The gateway authenticates a connection and routes commands to the call authority. PostgreSQL commits call transitions, unique claims, retry receipts, and notification outbox records together. Redis holds bounded presence/routing caches and optional delivery hints. A socket itself remains on a particular gateway; Redis does not make that process stateless.

Media takes a direct candidate pair where appropriate, a TURN relay when necessary or selected for address privacy, or an SFU path for groups. STUN discovers candidate addresses and ICE tests connectivity. Neither STUN nor the signaling API is the steady-state video pipeline.

## Core Components / Request Flows

### Device registration and presence — production proposal

Validate the session and origin at upgrade, then bind an authenticated account to a server-verified device identity. Maintain separate connection IDs for several tabs or sockets on the same device. A device identity is not a proof of account ownership merely because it came from localStorage.

Presence is a per-connection lease with a last-seen time and route. Heartbeats refresh that lease; cleanup removes only the matching connection generation. User-level indexes are derived from live connections. Updating an entire user's hash TTL cannot independently expire an abandoned device while another keeps the hash alive.

Fan-out uses this registry to reach each invited user's gateways. Durable call events are delivered at least once with a call revision and expiry; a stale ring is discarded after checking current call state. Offline delivery can use a platform notification service, but the returning client still reauthorizes and synchronizes before showing an actionable invitation.

### Initiation, acceptance, and terminal transitions — production proposal

1. A caller submits an actor-scoped operation ID, intended recipients, and modality. Validate recipients, blocked/busy policy, limits, and the request digest.
2. One SQL transaction creates the call and invitations, reserves the caller's active-call slot, and writes the retry receipt and ring outbox entries. A duplicate returns the original committed outcome.
3. Each invited device receives the same call ID, revision, and absolute ringing deadline. Delivery acknowledgment is separate from human acceptance.
4. An answering device atomically claims its invited seat while the call is still eligible and before the deadline. Its busy slot, participant state, call revision, receipt, and sibling-dismiss events commit together.
5. The winner negotiates media with the caller. Other devices receive the canonical winner and stop ringing. An acceptance does not yet prove a working audio path.
6. End, decline, cancel, and timeout commands use conditional transitions and receipts. A timeout worker checks the durable deadline and state; a stale timer cannot overwrite an accepted or ended call.

For one-to-one calls, define Decline as declining the invitation for that user across their devices. A temporary dismiss on one device would be a separate action. Group invitations claim seats independently; accepting one participant must not close admission for every other invited participant.

Lock active-user slots in a stable order where several are involved, or enforce equivalent uniqueness transactionally. Merely locking one call row would not prevent the same user from accepting two different calls concurrently. For cross-dialing, return an explicit busy/conflict result or reconcile the invitations through a defined product rule.

### Negotiation and media ownership — production proposal

The client call controller owns the peer connection, media tracks, pending descriptions/candidates, timers, and an attempt generation. UI state contains serializable status and participant identity; mutable browser resources live behind that controller. Every asynchronous callback carries a call, endpoint, and negotiation generation.

Obtain current ICE configuration before constructing a peer, or explicitly acknowledge a degraded STUN-only attempt. Request microphone/camera through a user action. If permission resolves after cancellation, stop the returned tracks immediately rather than attaching them to a newer call.

Use offer/answer to negotiate session parameters and trickle candidates as they are discovered. Queue candidates only for their matching peer and negotiation generation until a remote description is installed. A designated initial offerer avoids the first collision; later renegotiations need serialized operations and a glare-resolution policy. Queueing all candidates in one global array is insufficient.

Keep signaling and media status separate. A brief WebSocket outage can leave direct media functioning; reconnect authenticates again and reconciles current call state before renegotiation. A failed media path can require an ICE restart with new generation/credentials, not a replay of the old candidate list. Use bounded retry and a clear failed state.

### Topology, quality, and encryption — production proposal

For one-to-one calls, begin with direct ICE candidates plus reachable TURN fallback. A relay can also deliberately conceal peer addresses. For group rooms, use an SFU with per-receiver subscriptions and suitable encoding layers, preserving audio when bandwidth is constrained. An MCU is an alternative when a mixed stream substantially reduces receiver work, at the cost of server processing and plaintext access for mixing.

Browser WebRTC secures media with DTLS-SRTP; TURN forwarding does not require terminating that browser-to-browser encryption. Secure signaling and verified endpoint identities remain necessary to bind the intended people to those endpoints. See [RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html#section-6.5).

An SFU normally terminates each transport leg. Protecting media from the SFU requires an additional endpoint-controlled frame encryption mechanism and authenticated group-key management. [SFrame](https://www.rfc-editor.org/rfc/rfc9605.html) describes such a media framing layer; it does not itself solve membership or key distribution. Removing a participant requires an appropriate key-epoch change. The local project implements neither an SFU nor this group layer.

Use measured client statistics to distinguish round-trip delay, jitter, loss, actual frame delivery, and selected candidate type. Browser congestion control and requested echo/noise processing exist independently of an application quality dashboard. A fixed capture constraint is a preference, not a promise that every camera supplies that resolution or frame rate.

## Database Schema

### Current local initialization SQL

This is the exact [initialization file](./backend/src/db/init.sql). It creates five tables and seven indexes, and delegates fixtures to a separate seed file.

```sql
-- Database initialization for FaceTime
-- Run this when creating the database

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User devices for multi-device support
CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100),
  device_type VARCHAR(50), -- 'desktop', 'mobile', 'tablet'
  push_token VARCHAR(500),
  is_active BOOLEAN DEFAULT TRUE,
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Active calls
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  initiator_id UUID REFERENCES users(id),
  call_type VARCHAR(20) NOT NULL, -- 'video', 'audio', 'group'
  state VARCHAR(20) NOT NULL, -- 'ringing', 'connected', 'ended', 'missed', 'declined'
  room_id VARCHAR(100),
  max_participants INTEGER DEFAULT 2,
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Call participants
CREATE TABLE IF NOT EXISTS call_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID REFERENCES calls(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  device_id UUID REFERENCES user_devices(id),
  state VARCHAR(20) NOT NULL, -- 'ringing', 'connected', 'left', 'declined'
  is_initiator BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMP WITH TIME ZONE,
  left_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Call history for analytics
CREATE TABLE IF NOT EXISTS call_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID REFERENCES calls(id),
  user_id UUID REFERENCES users(id),
  other_participants JSONB,
  call_type VARCHAR(20),
  duration_seconds INTEGER,
  quality_rating INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_active ON user_devices(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_calls_initiator ON calls(initiator_id);
CREATE INDEX IF NOT EXISTS idx_calls_state ON calls(state);
CREATE INDEX IF NOT EXISTS idx_call_participants_call ON call_participants(call_id);
CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_call_history_user ON call_history(user_id);

-- Seed data is in db-seed/seed.sql
```

The local schema has no password/session model, unique call-operation receipt, transition revision, answer claim, ringing deadline, device-account uniqueness rule beyond device ID, or legal-state CHECK constraints. Participant identity fields are nullable foreign keys; there is no unique call/user/seat constraint. `call_history` is not written or read by the running routes; the history API derives data from `calls` and `call_participants`.

### Proposed extensions — not local tables

| Record / constraint | Purpose |
|---------------------|---------|
| Authenticated device and connection generation | Bind routing to an account and distinguish old sockets |
| Call revision, deadline, terminal reason | Conditional transitions and restart-safe expiration |
| Invitation / seat with winning device | One winner per invited user; independent group admission |
| Active-user slot | Enforce the initial one-accepted-call busy policy across calls |
| Actor + operation ID + body digest receipt | Atomic, durable retry outcome |
| Call-event outbox | Deliver rings, dismissal, and termination after commit |
| Media attempt / endpoint generation | Reject stale SDP and ICE after reconnect or transfer |

History can initially be queried from normalized records with a stable cursor and suitable indexes. A later per-user projection must be idempotent and respect visibility. Caching live routes is useful, but optional cache availability should not decide whether an accepted call transition exists.

## API Design

### Actual HTTP endpoints

| Method | Path | Current behavior |
|--------|------|------------------|
| GET | `/api/users` | All users with display/profile/role fields, no authentication or pagination |
| GET | `/api/users/:id` | Public profile lookup |
| POST | `/api/users/login` | Exact username lookup and returned user; no session creation |
| GET | `/api/calls/history/:userId` | Public call/participant history, default limit 50 and offset 0; no maximum or nonnegative validation |
| GET | `/api/calls/:id` | Public call detail and participant records |
| GET | `/turn-credentials` | Three public STUN URLs and static TURN credentials |
| GET | `/stats` | Process-local registered-user/device counts; resets the connection gauge to the registered count |
| GET | `/metrics` | Prometheus text |
| GET | `/health`, `/health/ready` | PostgreSQL/Redis probes; full health also returns memory and breaker state |
| GET | `/health/live` | Process liveness |

There is no HTTP device-registration endpoint, active-call admin endpoint, registration/password endpoint, or authenticated history filter. Express uses its default JSON parser limit, CORS for one configured origin, and Helmet with CSP disabled. CORS is not authentication and does not authorize `/ws` upgrades.

### Actual WebSocket messages

Messages use underscores, not the hyphenated names formerly shown in this document. The `/ws` connection has no session or origin verification.

| Message | Direction | Current behavior |
|---------|-----------|------------------|
| `register` | Both | Client claims user/device; response returns success/profile under the same type |
| `call_initiate` | Both | Request has calleeIds/callType and optional data.idempotencyKey; response returns call ID |
| `call_ring` | Server → invited devices | Caller profile, modality, group flag |
| `call_answer` | Both | Request accepts by call ID; caller learns answering device and answerer gets confirmation |
| `call_decline` | Both | Decline by call ID; caller receives user and allDeclined flag |
| `call_end` | Both | End by call ID; notifications include reason, including answered_elsewhere |
| `offer`, `answer` | Relayed | SDP payload forwarded to Redis-listed participating devices |
| `ice_candidate` | Relayed | Candidate, sdpMid, sdpMLineIndex; best-effort deduplication |
| `ping`, `pong` | Client / server | JSON heartbeat; updates process-local lastPing only |
| `error` | Server → client | Registration/processing errors; frontend call hook does not handle them |

Registration is required to populate the handler's current client, but does not establish authenticated identity. Signaling checks only that a call cache entry exists; it does not verify sender membership or legal negotiation state. `call_busy`, `user_joined`, and `user_left` appear in backend types without implemented flows. Payloads have TypeScript casts rather than comprehensive runtime validation, application message limits, or rate controls.

## Key Design Decisions

### Atomic control state over independent Redis and SQL writes

A single durable acceptance transaction provides a meaningful winner across devices, retries, and restarts. PostgreSQL is appropriate for the comparatively small number of call lifecycle transitions; every media packet or candidate does not need a SQL transaction. Redis can cache routes and current revisions without becoming a second authority.

Independent read/check/write operations allow two devices to observe ringing and both accept. Writing an idempotency key first creates a different gap: it can identify a call that was never committed. The proposed receipt and outbox close these boundaries in the same transaction. The cost is storage coordination and delivery/recovery machinery, rather than an assumed universal database latency penalty.

### Direct media with TURN fallback over always relaying every one-to-one call

A direct candidate pair can reduce relay bandwidth and avoid a server detour. It is not zero total server cost: signaling, presence, and any fallback relay still require infrastructure. Nor is the direct Internet route always faster than a well-placed relay. Measure selection and quality rather than assuming a fixed 85% direct success rate.

Always relaying simplifies some routing/privacy choices and can conceal endpoint addresses, but spends bandwidth on calls that could connect directly. Either option still requires reachable relay transport, capacity, credential policy, and network tests. The initial choice favors direct paths with operational TURN support and a deliberate relay-only privacy mode when required.

### SFU subscriptions over an unrestricted group mesh

In a mesh, each participant sends to every other participant, putting upload and encoding pressure on the weakest device. An SFU concentrates forwarding in infrastructure and lets each receiver subscribe to useful streams/layers. Connections scale linearly with participants, but total traffic does not become linear if everyone receives everything.

The cost is media-server operations, egress, selective-subscription logic, and additional encryption design if the SFU must not see content. An MCU can lower receiver decode work through a mixed output, but adds server processing and prevents an ordinary plaintext mixer from being outside the media trust boundary. There is no universal four-person cutoff independent of bitrate and device capacity.

## Consistency and Idempotency

In the proposal, commands carry stable actor-scoped IDs and digests. Conditional state transitions, seat/busy claims, receipts, and outbox events commit atomically. Durable deadlines survive process loss. Notification delivery is at least once and receivers ignore superseded revisions; this is not an exactly-once network guarantee.

Negotiation identity is separate from call identity. An ICE restart or endpoint transfer creates a later generation. SDP/candidates are addressed to the authorized endpoint pair and generation, with ordered processing and bounded queues. Deduplicating only the candidate string cannot establish that a candidate belongs to the current negotiation or was delivered successfully.

Locally, the optional initiation key is stored at `idempotency:call:<key>` for 300 seconds, with no actor/body binding. GET and SETEX are separate and fail open. The key is written before SQL and is not removed after failure; duplicate handling echoes the new request's recipients/type alongside the old call ID. The frontend never supplies the key.

ICE uses the first sixteen hex characters of SHA-256 over call ID, device ID, and candidate text. `SETNX` and the one-hour expiry are separate operations; a crash can leave an unexpired key. Marking a candidate before forwarding can suppress a retry after a failed delivery. The key omits media-section and negotiation-generation identity, and errors allow forwarding. It is duplicate suppression, not a reliable signaling protocol.

## Security / Auth

The proposal authenticates account/device claims, checks call membership and endpoint generation, validates socket origins and payload bounds, and limits ringing, credential issuance, connection admission, and message volume. TURN credentials are issued to an authorized caller with an expiry using a supported Coturn credential mechanism; expiry and renewal policy must accommodate allocations and long calls. The [Coturn reference](https://github.com/coturn/coturn/wiki/turnserver) documents its shared-secret mode. It is not a time-limited credential feature defined by the STUN RFC cited in the old answer.

Local HTTP routes are public. `POST /api/users/login` returns a profile without setting a cookie. `handleRegister` verifies the existence of a supplied user ID, then trusts it. It also trusts a supplied device ID; the device upsert conflict branch does not update or verify its stored account owner. Re-registering a connection does not remove its old user index.

Any registered client can answer or end a known call, or inject negotiation data into it. Answer does not require an invitation; its SQL participant update can affect zero rows and still produce success. Decline does not require a ringing call or invited actor. Static TURN credentials are returned to anonymous requests. Role values and installed session packages do not provide RBAC or sessions.

## Observability

[Pino](./backend/src/shared/logger.ts) provides request IDs, scoped socket loggers, call events, and an audit logger. Some database/REST paths still use console logging. Audit actors are claimed identities, and the separate logger is not automatically tamper-evident storage. SDP/media contents are not logged by the signaling event helper.

[Prometheus metrics](./backend/src/shared/metrics.ts) cover call initiation/answer/end, durations, connections, handler latency/errors, idempotency, breakers, and cache helpers. ICE type and gathering latency instruments are declared but never updated; the client does not call `getStats`. Call setup latency measures initiation to acceptance, including human ringing time, not time to ICE/media connection. Duration begins at server acceptance.

Active-call counts can drift with races, failures, expiry, restarts, and inconsistent group labels. Connection gauge increments include unregistered sockets, whereas `/stats` overwrites it with registered-client count. Message-type and call-type labels accept unbounded supplied strings. Health probes check PG/Redis, not TURN allocation, media flow, permissions, or valid call transitions.

Proposed operational signals separate request-to-ring, ring-to-answer, accept-to-first-media, signaling outage, media outage, relay ratio, reconnect outcome, candidate-pair quality, rejected stale generations, and missed deadlines. Summarize client metrics at a bounded interval; do not serialize every video frame through application state or log private candidate addresses indiscriminately.

## Failure Handling

| Failure | Proposed behavior | Current local behavior |
|---------|-------------------|------------------------|
| Lost initiation response | Retry same operation and retrieve durable receipt | No browser key/replay; optional server key may identify nonexistent call |
| Two devices answer | One atomic seat winner; canonical outcome to siblings | Both can pass Redis read and receive success |
| SQL fails after ring timer cleared | Recoverable transition with durable deadline | Separate updates can leave SQL/cache inconsistent and timer absent |
| Signaling disconnect | Reauthenticate and reconcile; preserve healthy media briefly | Re-register only; no call-state resume or reconciliation |
| Media path fails | Bounded ICE restart, generation change, visible failure | Logs failed/disconnected; no restart or user-facing recovery |
| Server restarts during ringing | Deadline worker expires the durable invitation | In-memory timeout disappears; SQL can stay ringing |
| Long accepted call | Refresh live leases independently of retention | Redis call expires two hours after last state write |
| Logout | Stop reconnects and dispose the current call controller | Socket close schedules reconnect with retained identity |
| Slow or abusive client | Bounded admission, input, and output queues | No application socket rate/backpressure policy |

The backend stops accepting HTTP connections and requests socket closure on shutdown, then exits after five seconds. It does not await all asynchronous call/presence work, close the PG pool/Redis client, reconcile calls, or persist ring timers. Startup logs dependency failures and can still listen; Redis connection attempts have no application-level bounded deadline.

## Scalability Considerations

Distribute socket connections across gateways and route call commands to an authority with storage-enforced revisions. Redis pub/sub can assist delivery, but cannot supply durable winner selection, missed-message recovery, or restart-safe timeouts by itself. A global busy policy must coordinate across different call IDs as well as across devices.

Scale TURN by region, reachable allocation ranges, bandwidth, and tested UDP/TCP/TLS paths. Use real selected-pair measurements for capacity estimates. Draining a relay or SFU involves existing media sessions, not merely moving HTTP requests to another server. Group subscriptions and simulcast/SVC should match receiver capabilities and visible tiles rather than forwarding every high-resolution stream.

The current three backend scripts choose distinct ports, but all maps and timers remain process-local. Redis presence readers are not used for cross-server ring routing. More instances can therefore partition users into unreachable islands instead of increasing capacity for a shared calling service.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Call authority | Transactional SQL transitions/receipts | Independent Redis and SQL writes | One durable outcome across concurrent devices |
| Notifications | Outbox with revision-aware delivery | In-process send after partial writes | Retryable rings and dismissals after restart |
| One-to-one media | Direct ICE plus TURN fallback | Always relay | Reduce avoidable relay traffic while supporting difficult networks |
| Group media | SFU with bounded subscriptions | Unrestricted mesh / MCU | Control endpoint upload and receiver workload |
| Presence | Per-connection leases | One user-hash TTL | Expire abandoned connections independently |
| Client ownership | Call controller with attempt generations | Shared mutable refs and unscoped callbacks | Prevent late negotiation/media from affecting another call |

## Implementation Notes

### Actual topology and request path

[index.ts](./backend/src/index.ts) creates Express and `/ws` on one server. [The signaling entry point](./backend/src/services/signaling/index.ts) attaches independent asynchronous message handlers without serialization. [connection-manager.ts](./backend/src/services/signaling/connection-manager.ts) holds clients, user-to-client indexes, ring timers, and creation timestamps in memory. Redis does not transport messages between these maps.

[Registration](./backend/src/services/signaling/registration-handler.ts) reads the user profile cache, falls back to a database lookup, inserts local mappings, writes presence, and launches a device upsert without waiting for it. A subsequent call can race device creation and hit a foreign-key failure. Errors after inserting mappings can leave a registered map entry while the connection handler still has no current client. Repeated registration can also leave old user-index entries or multiple connections sharing one device ID.

[Initiation](./backend/src/services/signaling/call-initiate-handler.ts) stores an optional key before creating a SQL call and caller participant through two breakers. It then stores Redis state, increments metrics, reads caller metadata, inserts each callee participant separately, fans out rings, and finally schedules a thirty-second timer and confirms initiation. There is no transaction, busy guard, recipient/type bound, or rollback of earlier writes when a later step fails.

[Answer/decline/end](./backend/src/services/signaling/call-response-handler.ts) and [room teardown](./backend/src/services/signaling/room-manager.ts) use separate Redis reads and unconditional SQL/cache writes. Answer clears the timer before database success. Concurrent answers both succeed; full-state Redis replacement can lose one participant. Timeout can race an answer and still end the call. End writes left_at but does not change participant state to left; concurrent termination can repeat metrics and notifications. The server does not write the dedicated history table.

### Wired patterns and implementation defects

**Circuit breakers.** The [Opossum helper](./backend/src/shared/circuit-breaker.ts) is actually wired around user lookup, device upsert/offline, call creation, and caller-participant creation. It uses a three-second timeout, 50% failure threshold after five calls, and ten-second reset. Other queries and Redis operations bypass it; a breaker timeout does not cancel the underlying SQL operation.

Its registry stores the first action for each name:

```typescript
if (breakers.has(name)) {
  return breakers.get(name)!;
}
```

Call sites pass fresh zero-argument closures capturing request values. Subsequent executions therefore run the first closure rather than the new request. Isolated execution with the installed Opossum confirmed that a later registration reads the first user and repeats the first device upsert; a second call retries the first call ID and fails a simulated primary-key check. This is a correctness defect, not resilience. A reusable breaker needs a stable action receiving current arguments, or an equivalent correctly parameterized dispatch.

**Caching and presence.** [services/redis.ts](./backend/src/services/redis.ts) stores the full call JSON at `call:<id>` for 7,200 seconds; answer resets this TTL, but heartbeat does not. Profile cache-aside in [shared/cache.ts](./backend/src/shared/cache.ts) uses `user:profile:<id>` for one hour. Registration concurrently invokes two presence writers on `presence:<userId>`: one sets 3,600 seconds, the other sets sixty seconds through a transaction. The last expiry wins, and either expiry is for the whole hash. Ping changes only lastPing in the local client; the TTL-refresh helper is unused. Presence readers and metric-bearing call-cache wrappers are also unused by active routing/call handlers.

**Idempotency and metrics.** [idempotency.ts](./backend/src/shared/idempotency.ts) implements the best-effort key and candidate suppression described above, not durable receipts. Opossum and several cache/metric helpers have real call sites, but metric declarations for ICE do not prove measured media quality. Basic PG/Redis checks are useful for dependency visibility, while end-to-end call and relay checks are omitted.

**Connection cleanup.** Heartbeat checks run every thirty seconds and terminate registered clients whose last ping is over sixty seconds old. Termination calls disconnect cleanup directly, and socket close calls it again. Cleanup removes maps/presence and asynchronously marks a device offline; it does not end calls. Unregistered sockets are absent from that heartbeat map. Old connections sharing a device can remove presence or mark it offline while another remains open.

### Frontend media and state

[App.tsx](./frontend/src/App.tsx) fetches contacts once, performs username lookup, and switches screens without a router. Identity lives only in memory. The socket's deviceId persists in localStorage independently of account; separate profiles avoid sharing it, but do not fix server authorization or closure bugs. The contact list shows no online presence. The connection indicator reads `isConnected()` without a reactive subscription.

[useWebRTC.ts](./frontend/src/hooks/useWebRTC.ts) fetches credentials once at mount; [Vite](./frontend/vite.config.ts) does not proxy `/turn-credentials`. The default request cannot retrieve the backend JSON and falls back to two public STUN servers. The server's third STUN URL and local TURN entry therefore do not reach that normal path. Coturn's container publishes 5349 but passes `--no-tls --no-dtls`; there is no configured secure TURN fallback.

Capture requests ideal 1280×720 at 30 fps for video and requests echo cancellation, noise suppression, and automatic gain control for audio. These are browser constraints/preferences. It is incorrect to say audio processing and transport encryption are entirely absent. The application has no getStats collection, quality policy, simulcast/SVC configuration, ICE restart, or device-change handling.

The caller creates a peer before receiving a call ID. Its onicecandidate callback captures the then-current empty ID, so later trickle candidates are not sent through that callback. An SDP offer may contain candidates already gathered, so this is a concrete loss of trickle signaling rather than proof that every direct connection must fail. The caller creates an initial local offer and another after call acceptance; offer/answer and candidate handlers have no serialized negotiation or glare policy.

Incoming messages do not check the current call ID/generation. A late call_end can terminate another call, a new ring can overwrite an active call, and the shared candidate queue is never cleared on reset. Late getUserMedia results can allocate/attach streams after cancellation. Error/reset paths stop current store tracks but do not consistently close the peer ref, and hook teardown only unsubscribes messages. There is no error/busy handler in the call hook or acceptance retry state.

[signaling.ts](./frontend/src/services/signaling.ts) resolves connect on socket open before registration acknowledgment, sends no initiation idempotency key, drops closed-socket sends, and reconnects after 1/2/4/8/16 seconds without jitter or call-state resume. Disconnect retains user/device identity and triggers the same retry path; timers are not tracked for cancellation. Repeated connect can overlap sockets and heartbeat intervals.

[useStore.ts](./frontend/src/stores/useStore.ts) stops currently stored local/remote tracks on reset, and mute/video toggles change track.enabled. It does not dispose the peer connection or candidate queue. Outgoing initiation clears the callee selected by App, producing an Unknown name. [VideoPlayer.tsx](./frontend/src/components/VideoPlayer.tsx) binds a non-null srcObject and uses autoplay/playsInline, with a muted mirrored local preview; it does not explicitly clear null streams, handle playback rejection, or display audio-only/video-muted state. Incoming-call icon buttons have visible adjacent text but lack explicit accessible names; call-state announcements and focus/reduced-motion handling are absent.

### Local substitutions, omissions, and verification

Compose supplies PostgreSQL 16, Valkey 7, and Coturn with static credentials and a small port range. Schema initialization and seeding are separate; there are no migration/seed scripts or dotenv loading. SQL seed users are skipped on username conflict, while randomly identified devices accumulate on reruns. `npm run build` emits the CommonJS-compatible NodeNext backend to dist, and start runs dist/index.js. The [README](./README.md) documents both infrastructure options and exact environment defaults.

Omitted production mechanisms include real identity/session authorization, atomic invitation/busy claims, durable receipts/outbox/deadline recovery, cross-gateway delivery, short-lived TURN issuance, authenticated endpoint negotiation, group media/key handling, push, handoff, screen sharing, and media-quality telemetry. The browser controls demonstrate one-to-one intent, not a validated mesh or SFU.

The only checked-in browser test asserts that the login container renders; screenshot configuration additionally selects Alice and captures contacts. There is no backend test script or two-party media/relay test. This review executed eight isolated checks with mocked services/sockets/media and the actual circuit-breaker wrapper, confirming the closure, acceptance, membership, logout, and caller-candidate findings. It did not start infrastructure, modify application source, run a build, or claim measured media performance.

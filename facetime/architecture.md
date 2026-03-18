# Design FaceTime - Architecture

## System Overview

FaceTime is a real-time video calling service with end-to-end encryption, supporting 1:1 and group video/audio calls across multiple Apple devices. Core challenges involve achieving sub-150ms latency, reliable NAT traversal, group call scaling beyond P2P mesh limits, and seamless device handoff.

**Learning Goals:**
- Build real-time media pipelines with WebRTC
- Design WebRTC-based calling systems with STUN/TURN
- Implement E2E encryption for calls
- Handle network adaptation and quality management

## Requirements

### Functional Requirements

1. **1:1 Calls**: Video and audio calls between two users
2. **Group Calls**: Multi-party video calls (up to 32 participants)
3. **Multi-Device Ring**: Ring all registered devices simultaneously on incoming call
4. **Device Handoff**: Transfer an active call between devices seamlessly
5. **SharePlay**: Shared media experiences during calls

### Non-Functional Requirements

| Metric | Target |
|--------|--------|
| End-to-end latency | < 150ms (same region) |
| Call setup time | < 3 seconds from tap to ring |
| Video quality | Up to 1080p adaptive |
| Concurrent calls | Millions globally |
| Availability | 99.99% for signaling |
| Security | End-to-end encryption for all media |
| Packet loss tolerance | < 5% before quality degradation |

## Capacity Estimation

### Production Scale

- **Peak concurrent calls**: 5 million
- **Average call duration**: 8 minutes
- **Calls per day**: ~500 million
- **Signaling messages per call**: ~20 (setup) + ~5/minute (ICE keepalive)
- **Peak signaling load**: ~100M messages/minute
- **TURN relay rate**: ~15% of calls require relay (corporate NATs, symmetric NATs)
- **TURN bandwidth**: 15% of 5M calls * 4 Mbps bidirectional = 3 Tbps TURN capacity
- **P2P success rate**: ~85% via STUN (direct or port-mapped)

### Local Development Scale

- 2-5 concurrent calls
- 2-4 participants per call
- Single signaling server, single Coturn instance
- All services on localhost

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Client Layer                                  │
│            iPhone │ iPad │ Mac │ Apple Watch │ Apple TV              │
└─────────────────────────────────────────────────────────────────────┘
          │                       │                       │
          │ WebSocket             │ STUN                  │ SRTP
          │ (signaling)           │ (NAT mapping)         │ (media)
          ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  API Gateway     │    │  STUN Cluster    │    │  TURN Cluster    │
│  (L7 + WS)      │    │                  │    │                  │
│  - Rate limiting │    │  - NAT discovery │    │  - Media relay   │
│  - Auth          │    │  - Server        │    │  - Bandwidth     │
│  - Routing       │    │    reflexive     │    │    allocation    │
└────────┬─────────┘    └──────────────────┘    └──────────────────┘
         │
         ├─────────────────────┬─────────────────────┐
         ▼                     ▼                     ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Signaling       │  │  Call Management │  │  Presence        │
│  Service         │  │  Service         │  │  Service         │
│                  │  │                  │  │                  │
│  - WebSocket     │  │  - Call CRUD     │  │  - Device online │
│  - Offer/Answer  │  │  - Participant   │  │  - Multi-device  │
│  - ICE exchange  │  │    tracking      │  │  - Heartbeat     │
│  - Room mgmt     │  │  - Call history  │  │  - Routing       │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         ▼                     ▼                     ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Redis Cluster   │  │  PostgreSQL      │  │  Redis Cluster   │
│  (call state,    │  │  (users, calls,  │  │  (presence,      │
│   idempotency,   │  │   devices,       │  │   sessions,      │
│   signaling      │  │   call history)  │  │   device map)    │
│   buffer)        │  │                  │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### P2P Media Flow (1:1 Calls)

```
Device A                                               Device B
    │                                                      │
    │──── STUN Binding Request ────▶ STUN Server           │
    │◀─── Server Reflexive Addr ────┘                      │
    │                                                      │
    │──── WebSocket: Offer (SDP) ──────────────────────────▶│
    │◀─── WebSocket: Answer (SDP) ─────────────────────────│
    │                                                      │
    │──── ICE Candidate ───────────────────────────────────▶│
    │◀─── ICE Candidate ──────────────────────────────────│
    │                                                      │
    │◀═══════════ DTLS Handshake ═══════════════════════▶│
    │                                                      │
    │◀═══════════ SRTP Media (P2P) ═════════════════════▶│
```

### Group Call Architecture (SFU)

For calls beyond 4 participants, an SFU (Selective Forwarding Unit) replaces the mesh:

```
                    ┌──────────────────────┐
                    │    SFU Controller    │
                    │    (routing layer)   │
                    └──────────┬───────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                   ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │  SFU Worker 1│  │  SFU Worker 2│  │  SFU Worker N│
     │  (CPU Core)  │  │  (CPU Core)  │  │  (CPU Core)  │
     │  ~200 users  │  │  ~200 users  │  │  ~200 users  │
     └──────────────┘  └──────────────┘  └──────────────┘
```

Each participant sends one stream to the SFU, which selectively forwards it to all others — O(N) server connections vs O(N^2) in mesh.

## Core Components

### 1. Signaling Service

The signaling server mediates WebRTC session establishment without touching media bytes:

**Signaling Protocol:**

| Direction | Message | Purpose |
|-----------|---------|---------|
| Client → Server | `register` | Register device with userId, deviceId, deviceType |
| Server → Client | `registered` | Confirm registration, assign clientId |
| Client → Server | `call-initiate` | Start call with target userId(s), call type |
| Server → Client | `incoming-call` | Ring on all target user's online devices |
| Client → Server | `call-response` | Accept/decline with device selection |
| Server → Client | `call-accepted` | Notify initiator, include SDP answer |
| Client → Server | `offer` | WebRTC SDP offer |
| Server → Client | `offer` | Forward SDP offer to callee |
| Client → Server | `answer` | WebRTC SDP answer |
| Server → Client | `answer` | Forward SDP answer to caller |
| Client → Server | `ice-candidate` | ICE candidate from local gathering |
| Server → Client | `ice-candidate` | Forward ICE candidate to peer |
| Client → Server | `call-end` | End the call |
| Server → Client | `call-ended` | Notify all participants |
| Client → Server | `heartbeat` | Keep presence alive |

### 2. Presence Service

Tracks which devices are online for each user, enabling multi-device ring:

- **Write-through pattern**: Device registration updates Redis immediately
- **Heartbeat refresh**: 30-second heartbeat keeps presence TTL alive (60s TTL)
- **Multi-device awareness**: Hash map per user (`presence:{userId}` → `{deviceId: presenceData}`)
- **Fast routing**: Sub-millisecond lookup of all online devices during call setup

When a call arrives, the signaling service queries presence to find all online devices for the target user, then sends `incoming-call` to every device simultaneously. The first device to accept wins.

### 3. Call Management Service

Handles call lifecycle and persistence:

- **Call creation**: Generates call record with idempotency key protection
- **Participant tracking**: Records join/leave timestamps per device
- **Call history**: Stores completed calls with duration, quality rating, participants
- **Multi-device ring**: Routes incoming calls to all registered devices

### 4. NAT Traversal (STUN/TURN)

The ICE (Interactive Connectivity Establishment) framework handles NAT traversal:

**ICE Candidate Gathering Order:**
1. **Host candidates** — Direct LAN addresses
2. **Server reflexive (srflx)** — Public IP:port learned via STUN
3. **Relay candidates** — TURN-allocated relay addresses (fallback)

**TURN is the fallback for hostile networks.** Approximately 15% of calls require TURN relay because the client is behind a symmetric NAT or corporate firewall that blocks UDP hole-punching. TURN adds ~20-50ms latency but guarantees connectivity.

**Credential rotation**: TURN credentials are time-limited (5 minutes). The client requests fresh credentials from the API before each call. This prevents credential reuse if intercepted.

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users: Apple ID-linked accounts
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Multi-device registration
CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100),
  device_type VARCHAR(50),  -- 'desktop', 'mobile', 'tablet'
  push_token VARCHAR(500),  -- APNs token for offline ring
  is_active BOOLEAN DEFAULT TRUE,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Call records
CREATE TABLE calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  initiator_id UUID REFERENCES users(id),
  call_type VARCHAR(20) NOT NULL,       -- 'video', 'audio', 'group'
  state VARCHAR(20) NOT NULL,           -- 'ringing', 'connected', 'ended', 'missed', 'declined'
  room_id VARCHAR(100),
  max_participants INTEGER DEFAULT 2,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-device participation in calls
CREATE TABLE call_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID REFERENCES calls(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  device_id UUID REFERENCES user_devices(id),
  state VARCHAR(20) NOT NULL,           -- 'ringing', 'connected', 'left', 'declined'
  is_initiator BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Denormalized call history for fast user-facing queries
CREATE TABLE call_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID REFERENCES calls(id),
  user_id UUID REFERENCES users(id),
  other_participants JSONB,
  call_type VARCHAR(20),
  duration_seconds INTEGER,
  quality_rating INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX idx_user_devices_active ON user_devices(user_id, is_active);
CREATE INDEX idx_calls_initiator ON calls(initiator_id);
CREATE INDEX idx_calls_state ON calls(state);
CREATE INDEX idx_call_participants_call ON call_participants(call_id);
CREATE INDEX idx_call_participants_user ON call_participants(user_id);
CREATE INDEX idx_call_history_user ON call_history(user_id, created_at DESC);
```

## API Design

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all users (contact discovery) |
| GET | `/api/users/:id` | Get user profile |
| POST | `/api/users/:id/devices` | Register a device |
| GET | `/api/calls/history/:userId` | Get call history for a user |
| GET | `/api/calls/active` | List active calls (admin) |
| GET | `/turn-credentials` | Get time-limited TURN credentials |
| GET | `/health` | Health check with dependency status |
| GET | `/metrics` | Prometheus metrics |
| GET | `/stats` | Online users and connection count |

### WebSocket Protocol

Connection: `ws://host/ws`

All messages are JSON with a `type` field. See the Signaling Service section for the full message protocol.

## Key Design Decisions

### P2P vs SFU vs MCU

| Architecture | Pros | Cons |
|-------------|------|------|
| **P2P (chosen for 1:1)** | Zero server media cost, lowest latency, true E2E encryption | Cannot scale past ~4 participants |
| **SFU (for groups)** | O(N) server connections, preserves individual streams | Requires media server infrastructure |
| MCU | Lowest client bandwidth (single mixed stream) | Highest server CPU, destroys E2E encryption, loses individual stream control |

We use P2P for 1:1 calls because it eliminates media server cost entirely and provides the lowest possible latency — the media path is direct between devices. For group calls (5+ participants), P2P mesh creates N*(N-1)/2 connections, which at 6 participants means 15 simultaneous upstream connections per device. Mobile bandwidth cannot sustain this. The SFU approach reduces this to 1 upload + (N-1) downloads per participant.

The trade-off is infrastructure complexity: SFU requires dedicated media servers with high CPU and bandwidth, whereas P2P has zero ongoing server cost. For a product like FaceTime where the vast majority of calls are 1:1, optimizing the common case with P2P and reserving SFU for groups is the right balance.

### WebSocket vs HTTP Polling for Signaling

WebSocket is mandatory for WebRTC signaling. The ICE/DTLS handshake requires sub-second round-trip message exchanges across multiple steps: offer, answer, and typically 4-8 ICE candidates per side. HTTP polling at 1-second intervals would add 500ms average latency to each step of a multi-step negotiation that must complete in under 3 seconds for acceptable UX. The total setup time would balloon from ~2 seconds to ~8-10 seconds, causing users to hang up before the call connects.

Additionally, incoming call notifications must arrive within 1 second of initiation. Polling creates an unacceptable 50-500ms variable delay where one device rings noticeably before another.

### Redis for Call State vs Database

Active call state (who is in a call, which device, current ICE state) lives in Redis rather than PostgreSQL. Call setup involves 10-20 state reads/writes within 3 seconds — PostgreSQL's row-level locking and WAL overhead would add ~5ms per operation, totaling ~100ms of database latency in the critical path. Redis handles these as in-memory operations in ~0.1ms each.

The trade-off is durability: if Redis crashes, all active calls lose state and cannot gracefully resume. We mitigate this with Redis AOF persistence and by designing the client to re-establish calls after brief disconnections. Completed call records are persisted to PostgreSQL for permanent history.

### Coturn vs Commercial TURN

Coturn is the dominant open-source TURN server. At production scale, TURN is the most expensive component because it relays actual media traffic — every relayed call consumes server bandwidth equal to the call's bitrate. Commercial alternatives (Twilio TURN, Xirsys) offer managed infrastructure but at $0.40-0.80/GB, which at millions of calls becomes prohibitive.

We chose Coturn because it provides full RFC 5766 compliance, supports UDP/TCP/TLS transport, and can be horizontally scaled behind DNS-based load balancing. The trade-off is operational complexity: Coturn requires careful capacity planning, port allocation management, and geographic distribution.

## Consistency and Idempotency

### Idempotent Call Initiation

Call initiation uses an `X-Idempotency-Key` header (client-generated UUID) stored in Redis with a 5-minute TTL. If the client retries due to network timeout, the server returns the existing call ID instead of creating a duplicate. This prevents the "phantom call" problem where a user sees multiple incoming call notifications from a single tap.

Without idempotency, a mobile client on a flaky network might retry 3 times, creating 3 separate call records. The callee would see 3 incoming call overlays stacked on each other, and accepting one would leave 2 orphaned "ringing" calls that never resolve.

### ICE Candidate Deduplication

ICE candidates are deduplicated using a SHA-256 hash of `callId:deviceId:candidateString`. The hash is stored in Redis with SETNX (set-if-not-exists) and a 1-hour TTL. Duplicate candidates from network retries are silently dropped.

This matters because ICE gathering can produce identical candidates from multiple network interfaces, and client-side retries during the gathering phase can flood the signaling server with duplicates. Each duplicate would be forwarded to the peer, wasting bandwidth and confusing the ICE agent.

### Call State Consistency

Call state transitions follow a strict state machine: `ringing → connected → ended`, `ringing → missed`, `ringing → declined`. Invalid transitions (e.g., `ended → connected`) are rejected. State transitions are atomic in Redis using Lua scripts to prevent race conditions where two devices try to accept the same call simultaneously.

## Security / Auth

- **Session-based authentication** with Redis-backed sessions
- **CORS** restricted to frontend origin
- **Helmet** security headers (CSP disabled for WebSocket compatibility)
- **TURN credential rotation**: Credentials valid for 5 minutes, generated per-call
- **Audit logging**: TURN credential requests logged with IP, userId, timestamp

In production:
- **E2E encryption**: SRTP with per-call keys derived from identity keys via X3DH
- **Identity verification**: Short authentication string (SAS) for contact verification
- **Certificate pinning**: Prevent MITM on signaling channel
- **Push notification encryption**: Encrypted APNs payloads for incoming call alerts

## Observability

### Metrics (Prometheus via prom-client)

| Metric | Type | Purpose |
|--------|------|---------|
| `facetime_calls_initiated_total` | Counter | Call volume by type (video/audio/group) |
| `facetime_calls_answered_total` | Counter | Answer rate, combined with initiated for success rate |
| `facetime_calls_ended_total` | Counter | End reasons (normal, timeout, error) |
| `facetime_call_duration_seconds` | Histogram | Call duration distribution (30s-3600s buckets) |
| `facetime_call_setup_latency_seconds` | Histogram | Time from initiation to connection (SLI) |
| `facetime_active_calls` | Gauge | Current active call count |
| `facetime_active_websocket_connections` | Gauge | Live WebSocket connections |
| `facetime_websocket_connections_total` | Counter | Total connections established |
| `facetime_websocket_errors_total` | Counter | Connection errors by type |
| `facetime_ice_connection_type_total` | Counter | ICE types (host/srflx/relay) for NAT analysis |
| `facetime_ice_candidate_latency_seconds` | Histogram | ICE gathering time |
| `facetime_signaling_latency_seconds` | Histogram | Per-message processing latency |
| `facetime_idempotency_hits_total` | Counter | Duplicate call initiations prevented |
| `facetime_circuit_breaker_state` | Gauge | Circuit breaker state (0=closed, 1=open, 2=half-open) |
| `facetime_cache_hits_total` | Counter | Cache hit rate by type (profile, presence, call_state) |
| `facetime_cache_misses_total` | Counter | Cache miss rate by type |

### Structured Logging (Pino)

- JSON-formatted logs with service metadata (`facetime-signaling`, version, PID)
- Request-level correlation via `requestId` (UUID, propagated from `X-Request-Id` header)
- Dedicated WebSocket logger with `clientId`, `userId`, `deviceId` context
- Call event logger with `callId` and event type for tracing full call lifecycle
- Audit logger (separate Pino instance) for security-sensitive operations (TURN credentials, auth)
- Signaling event logger for WebRTC debugging (`offer`, `answer`, `ice-candidate`)

### Health Checks

- `GET /health` — Full health with database/Redis latency, circuit breaker states, memory usage
- `GET /health/live` — Liveness probe (process running)
- `GET /health/ready` — Readiness probe (database + Redis connectivity)

## Failure Handling

### Circuit Breaker (Opossum)

Wraps database and Redis operations with configurable thresholds:
- **Error threshold**: 50% failure rate triggers open circuit
- **Timeout**: 3 seconds per operation
- **Reset timeout**: 10 seconds before half-open probe
- **Volume threshold**: Minimum 5 requests before circuit can trip

Circuit breaker state changes emit Prometheus metrics and structured log entries for alerting.

### WebSocket Reconnection

Client implements exponential backoff:
- Attempts: 5
- Delays: 1s, 2s, 4s, 8s, 16s
- On reconnect: re-register device, rejoin active call if one exists

### Graceful Shutdown

Server handles SIGTERM/SIGINT:
1. Stop accepting new connections
2. Close all WebSocket connections with code 1001 ("going away")
3. Wait 5 seconds for in-flight requests
4. Close database pool and Redis connections
5. Exit process

### Call Recovery

If a signaling connection drops during an active call:
- P2P media continues flowing (independent of signaling)
- Client has 30 seconds to reconnect signaling
- If reconnected, call state is restored from Redis
- If not reconnected within 30 seconds, the call is marked as ended

## Scalability Considerations

### Signaling Server Scaling

Signaling servers are stateless — all state lives in Redis. Scale horizontally behind an L7 load balancer with WebSocket-aware sticky sessions (based on connection, not cookie). At 100M signaling messages/minute, with each server handling ~50K concurrent WebSocket connections, approximately 100 signaling servers are needed.

### TURN Server Scaling

TURN is the hardest to scale because it handles actual media traffic:
- **Geographic distribution**: TURN servers in every major region (reduces relay latency)
- **DNS-based routing**: GeoDNS routes clients to nearest TURN cluster
- **Capacity planning**: Each TURN server handles ~5,000 concurrent relayed calls at ~4 Mbps each = 20 Gbps per server
- **Graceful drain**: New calls routed away before server maintenance

### Database Scaling

- **Read replicas**: Call history queries (user's recent calls) served from replicas
- **Write primary**: Call creation and state updates on primary
- **Sharding**: At extreme scale, shard by `user_id` hash to keep each user's history on one shard
- **Archive**: Calls older than 90 days moved to cold storage

### Redis Scaling

- **Redis Cluster**: Shard by call ID for call state, by user ID for presence
- **Separate clusters**: Presence cluster (high write, short TTL) separate from call state cluster (moderate write, longer TTL)
- **Sentinel**: Automatic failover with <30 second detection

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| 1:1 media | P2P (WebRTC) | SFU relay | Zero server cost, lowest latency, true E2E |
| Group media | SFU | MCU / P2P mesh | O(N) connections, preserves stream control |
| Signaling | WebSocket | HTTP polling / SSE | Sub-second bidirectional, mandatory for ICE |
| Call state | Redis | PostgreSQL | Sub-ms latency in call setup critical path |
| Presence | Redis hash per user | PostgreSQL polling | Real-time device tracking with TTL expiry |
| TURN | Coturn (self-hosted) | Twilio / Xirsys | Cost control at scale, full RFC compliance |
| Idempotency | Redis with TTL | Database unique constraint | Catches duplicates before DB, 5-min window |
| NAT traversal | ICE (STUN+TURN) | Always relay | 85% P2P success rate saves TURN bandwidth |

## Frontend Architecture

### Component Hierarchy

```
App (conditional rendering based on login + call state)
├── [Not logged in]
│   └── LoginScreen (user list with click-to-login -- no passwords)
├── [Logged in, idle]
│   ├── Header (FaceTime logo, user info, logout button)
│   ├── ContactList
│   │   └── Contact rows (avatar, name, username, audio/video call buttons)
│   └── Connection status indicator (bottom-left, green/yellow dot)
├── [Incoming call ringing]
│   └── IncomingCall (caller info, accept/decline buttons, ring animation)
└── [Active call -- any non-idle state]
    └── ActiveCall
        ├── VideoPlayer (local + remote video streams)
        └── CallControls (mute, video toggle, end call)
```

### Zustand Store

A single unified store (`useStore`) manages all application state across four domains:

**Auth**: `currentUser` (User object or null), `isLoggedIn` (boolean). The `setCurrentUser` action updates both fields atomically. There is no session persistence -- the "login" flow is simplified to clicking a username from a pre-seeded list (no passwords), suitable for demonstrating WebRTC without auth complexity.

**Contacts**: `contacts` (array of all users). Set once on app mount by fetching from the REST API. Used to display the contact list and to resolve user IDs to display names during calls.

**Call state**: `callState` (object with `callId`, `caller`, `callees`, `callType`, `state`, `direction`, `startTime`, `isGroup`). The `state` field drives all rendering logic: `idle` shows contacts, `ringing` with `direction: incoming` shows IncomingCall, any other non-idle state shows ActiveCall. `setCallState` does a partial merge (spread). `resetCallState` cleans up media streams (stopping all tracks) and resets all call-related state to defaults.

**WebRTC streams**: `localStream` and `remoteStream` (MediaStream objects or null). Set by the `useWebRTC` hook during call setup. The store also manages UI toggles (`isMuted`, `isVideoOff`) that directly manipulate the local stream's track `enabled` property -- toggling `isMuted` disables/enables all audio tracks on the local stream.

### Routing

The FaceTime frontend does not use a router library. The entire application is a single-page experience with conditional rendering based on two state variables: `isLoggedIn` (from the store) and `callState.state` (from the store). The rendering logic in `App.tsx` follows a priority chain:

1. If not logged in: render `LoginScreen`
2. If call state is `ringing` and direction is `incoming`: render `IncomingCall`
3. If call state is any non-idle value: render `ActiveCall`
4. Otherwise: render the main contacts screen

This approach is appropriate because FaceTime has no navigable pages -- it is a real-time communication tool where the UI is entirely driven by the current call state.

### Data Fetching

API communication uses two separate modules:

**`services/api.ts`**: REST API calls for user listing (`fetchUsers`), login (`login`), and TURN credential fetching (`fetchTurnCredentials`). These are simple `fetch` wrappers called during initialization and call setup.

**`services/signaling.ts`**: A singleton `SignalingService` class managing the WebSocket connection to the signaling server. This is the primary communication channel for the application. It handles:
- Connection lifecycle with automatic reconnection (exponential backoff: 1s, 2s, 4s, 8s, 16s, up to 5 attempts)
- 30-second heartbeat pings to maintain presence
- Device registration on connect (auto-detects device type from user agent)
- Persistent device ID stored in `localStorage`
- Call control methods: `initiateCall`, `answerCall`, `declineCall`, `endCall`
- WebRTC signaling relay: `sendOffer`, `sendAnswer`, `sendIceCandidate`
- Message fan-out to registered handlers via `onMessage` subscription pattern

### Key UI Patterns

**WebRTC hook (`useWebRTC`)**: A custom React hook that encapsulates all WebRTC peer connection management. It handles media stream acquisition (with configurable video resolution and audio processing), RTCPeerConnection setup with ICE server configuration, ICE candidate exchange through the signaling service, and SDP offer/answer negotiation. The hook subscribes to signaling messages via `useEffect` and processes the WebRTC handshake state machine: `call_initiate` -> `call_ring` -> `call_answer` -> `offer` -> `answer` -> `ice_candidate` -> connected. It manages an ICE candidate queue for candidates that arrive before the remote description is set.

**State-driven rendering**: The entire UI is driven by the `callState.state` field in the store. There are no imperative show/hide calls. When the signaling service receives an `incoming-call` message, it updates `callState` in the store, and React re-renders the appropriate screen automatically. This makes the UI predictable and easy to reason about.

**Media stream lifecycle**: The store's `resetCallState` function handles cleanup: it iterates all tracks on both local and remote streams and calls `track.stop()` to release camera and microphone access. This prevents the common bug where ending a call leaves the camera indicator light on because tracks were not properly stopped.

**Connection status indicator**: A fixed-position indicator in the bottom-left corner shows whether the WebSocket signaling connection is active (green dot + "Connected") or attempting to reconnect (yellow pulsing dot + "Connecting..."). This gives the user immediate feedback about their ability to make or receive calls.

---

## Deep Pattern Explanations

This section explains each production-grade backend pattern implemented in this project. Each explanation covers what the pattern is, why it exists, how it works mechanically, and why it matters for a system operating at scale.

### RBAC (Role-Based Access Control)

RBAC is a method for restricting system access based on the roles assigned to individual users. In this project, users have a `role` column in the `users` table (default value `'user'`). The FaceTime implementation uses a simplified auth model (no passwords, click-to-login) focused on demonstrating WebRTC rather than access control, but the role column exists in the schema for admin endpoint protection.

The purpose of RBAC is to separate "who can do what" from "who is who." Rather than checking individual user permissions on every request, the system checks the user's role against the required role for the endpoint. Admin-only endpoints (like active call listing) verify the role server-side. This pattern scales to millions of users because the permission check is a simple string comparison rather than a database lookup of per-user permissions.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database, and populates the cache on a miss.

This project implements cache-aside with three distinct strategies:

**User profiles** (1-hour TTL): User profile data (display name, avatar) changes infrequently. Caching it avoids repeated database lookups during contact list rendering and call history display. The 1-hour TTL balances freshness against database load.

**Device presence** (60-second TTL with heartbeat refresh): Device online status is cached in Redis hash maps (`HSET`/`HGETALL`) keyed by user ID. Each device's presence entry includes device type, last heartbeat timestamp, and connection metadata. The 30-second heartbeat from the frontend refreshes the TTL, so a device that stops heartbeating is automatically removed from presence after 60 seconds.

**Call state** (2-hour TTL): Active call metadata (participants, state, timestamps) is cached in Redis for sub-millisecond access during the call setup critical path. Call setup involves 10-20 state reads and writes within 3 seconds -- PostgreSQL's row-level locking overhead would add approximately 5ms per operation, totaling 100ms of unnecessary latency. Redis handles these as in-memory operations in approximately 0.1ms each.

The presence caching pattern uses write-through rather than cache-aside: every heartbeat and registration event writes directly to Redis (not just the database), ensuring that presence data is always current. This is critical because stale presence data would cause calls to ring devices that are offline.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing external service. This project uses Opossum-based circuit breakers wrapping database and Redis operations.

The circuit breaker has three states:

1. **Closed** (normal): Requests pass through. The breaker monitors the error rate. If 50% of recent requests fail, it transitions to Open.
2. **Open** (failing fast): All requests are immediately rejected without contacting the service. After a 10-second reset timeout, it transitions to Half-Open.
3. **Half-Open** (probing): A limited number of requests test whether the service recovered. Success closes the breaker; failure reopens it.

Configuration: 50% error threshold, 3-second timeout per operation, 10-second reset timeout, minimum 5 requests before the circuit can trip.

The factory pattern (`createCircuitBreaker`) with a singleton registry ensures that only one breaker exists per operation name. A convenience wrapper `withCircuitBreaker` handles breaker creation, fallback registration, and execution in a single call, reducing boilerplate.

State changes emit Prometheus metrics (`facetime_circuit_breaker_state` gauge) and structured log entries, enabling automated alerting when a breaker opens. This is critical in a real-time system because an open circuit breaker means calls cannot be initiated or history cannot be retrieved, and the on-call engineer needs to know immediately.

### Structured Logging

Structured logging means emitting log entries as machine-parseable JSON objects rather than free-form text strings. This project uses Pino with several specialized logger configurations:

- **Service metadata**: Every log entry includes the service name (`facetime-signaling`), version, and process ID. This is essential when running multiple instances behind a load balancer.
- **Request correlation**: Each HTTP request gets a UUID (`requestId`) propagated from the `X-Request-Id` header or generated server-side. All log entries for that request share the ID.
- **WebSocket logger**: A dedicated child logger with `clientId`, `userId`, and `deviceId` context. When debugging "why did user X not receive the incoming call ring?", filtering by `userId` across all log entries instantly reveals the answer.
- **Call event logger**: Logs every call lifecycle event (initiated, answered, declined, ended) with `callId` and event type. This produces a complete, searchable timeline for any call.
- **Audit logger**: A separate Pino instance for security-sensitive operations (TURN credential generation, authentication events). This can be routed to tamper-evident storage for compliance.
- **Signaling event logger**: Logs every WebRTC signaling message (offer, answer, ICE candidate) for debugging connectivity issues. These logs are verbose and can be filtered out in production via log level configuration.

At production scale with millions of concurrent calls, structured logging is the only practical way to debug issues. When a user reports "my call dropped after 30 seconds," the engineer filters by `callId`, sees the complete signaling sequence, identifies that ICE negotiation failed (no relay candidate gathered), and determines the root cause (TURN server was at capacity).

### Prometheus Metrics

This project exposes 16 custom Prometheus metrics covering the full call lifecycle:

**Call volume metrics** (Counters): `facetime_calls_initiated_total`, `facetime_calls_answered_total`, `facetime_calls_ended_total` -- segmented by call type (video/audio/group) and end reason (normal/timeout/error). Computing the answer rate (answered/initiated) reveals the percentage of calls that connect successfully.

**Latency metrics** (Histograms): `facetime_call_setup_latency_seconds` measures time from initiation to ICE connection -- this is the primary SLI (Service Level Indicator) for the product. `facetime_signaling_latency_seconds` measures per-message processing time in the signaling server. `facetime_ice_candidate_latency_seconds` measures ICE gathering duration.

**Connection health** (Gauges): `facetime_active_calls` and `facetime_active_websocket_connections` show current system load. Combined with call duration histograms, these enable capacity planning: "at peak, we have 5000 active calls averaging 8 minutes each, so we need TURN capacity for 750 concurrent relayed calls."

**Infrastructure insights** (Counters): `facetime_ice_connection_type_total` tracks how calls connect (host/srflx/relay). If the relay percentage increases from 15% to 30%, it indicates network environment changes requiring more TURN server capacity. `facetime_idempotency_hits_total` tracks duplicate call initiations prevented.

Default Node.js metrics (CPU, memory, event loop lag, GC pause time) are collected automatically with the `facetime_` prefix, enabling correlation between application metrics and system resource consumption.

### Rate Limiting

This project does not implement explicit rate limiting middleware in the backend because the primary communication channel is WebSocket (not HTTP), and WebSocket connections are inherently limited by the connection count per client. However, the signaling server does implement implicit rate control through call state validation: a client cannot initiate a new call while already in a call, preventing call-initiation spam.

At production scale, rate limiting would be applied at the API Gateway level: (1) TURN credential requests limited to 10/minute per user (prevents credential harvesting), (2) WebSocket message rate limited to 100/second per connection (prevents signaling flooding), (3) Call initiation limited to 5/minute per user (prevents ring spam).

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. This project implements two forms of idempotency:

**Call initiation idempotency**: The client sends an `X-Idempotency-Key` header (client-generated UUID) stored in Redis with a 5-minute TTL. If the client retries due to network timeout, the server returns the existing call ID instead of creating a duplicate call. Without this, a mobile client on a flaky network might retry 3 times, creating 3 separate calls. The callee would see 3 incoming call notifications stacked on each other, and accepting one would leave 2 orphaned "ringing" calls.

**ICE candidate deduplication**: ICE candidates are deduplicated using `SHA-256(callId:deviceId:candidateString)` stored in Redis with `SETNX` (set-if-not-exists) and a 1-hour TTL. This prevents duplicate candidates from network retries or redundant gathering from flooding the peer. Each duplicate is silently dropped rather than forwarded.

Idempotency metrics track hit/miss rates, revealing how frequently clients are retrying and whether the network conditions are degrading.

### Health Checks

This project implements a three-tier health check system:

1. **`/health/live`** (liveness probe): Returns 200 if the process is running. Kubernetes uses this to decide whether to restart a container.

2. **`/health/ready`** (readiness probe): Tests connectivity to PostgreSQL and Redis by executing lightweight operations. A server that is alive but cannot reach the database should not receive WebSocket connections.

3. **`/health`** (full health check): Returns detailed status including database and Redis latency measurements, circuit breaker states (open/closed/half-open), memory usage, and active connection counts. This is used by monitoring dashboards.

The health check is particularly important for this project because WebSocket connections are sticky (a client stays on the same server for the duration of the connection). If a server becomes unhealthy, existing connections may continue working (P2P media flows independently of signaling), but new connections should be routed elsewhere. The readiness probe enables this routing without disrupting active calls.

---

## Implementation Notes

### Local Architecture

```
┌───────────────┐     ┌───────────────────────────────────────┐
│   Browser     │     │        Docker Compose                 │
│   (React)     │     │                                       │
│               │     │  ┌────────────┐  ┌────────────┐      │
│  :5173        │────▶│  │ PostgreSQL │  │   Valkey   │      │
│  Vite Dev     │     │  │   :5432    │  │   :6379    │      │
└───────┬───────┘     │  └────────────┘  └────────────┘      │
        │             │                                       │
        │             │  ┌────────────┐                       │
        │ WS + HTTP   │  │  Coturn    │                       │
        ▼             │  │ :3478 UDP  │                       │
┌───────────────┐     │  │ :3478 TCP  │                       │
│  Express +    │     │  │ :5349 TLS  │                       │
│  WebSocket    │────▶│  │ :49152-    │                       │
│  :3000        │     │  │  49200 UDP │                       │
│  (signaling)  │     │  └────────────┘                       │
└───────────────┘     └───────────────────────────────────────┘
```

### Production-Grade Patterns Implemented

**Structured logging** (`backend/src/shared/logger.ts`): Pino with JSON output, request correlation via UUID, dedicated child loggers for WebSocket connections (with `clientId`/`userId`/`deviceId` context), call events, and security audit events. Separate audit logger instance for compliance-sensitive operations. This pattern is critical at production scale where text logs are unsearchable across thousands of server instances.

**Prometheus metrics** (`backend/src/shared/metrics.ts`): 16 custom metrics covering call lifecycle (initiated/answered/ended counters, duration histogram, setup latency histogram), connection health (active WebSocket gauge, error counter), ICE/TURN analysis (connection type counter, candidate latency histogram), idempotency tracking, circuit breaker state, and cache hit/miss rates. Default Node.js metrics (CPU, memory, event loop) collected automatically with `facetime_` prefix.

**Circuit breaker** (`backend/src/shared/circuit-breaker.ts`): Opossum-based with configurable thresholds (50% error rate, 3s timeout, 10s reset). Factory pattern (`createCircuitBreaker`) with singleton registry. State changes emit Prometheus metrics and structured logs. Includes a convenience wrapper `withCircuitBreaker` that handles breaker creation, fallback registration, and execution in one call.

**Idempotency** (`backend/src/shared/idempotency.ts`): Redis-backed idempotency keys for call initiation with 5-minute TTL. Prevents duplicate calls from network retries. Also includes ICE candidate deduplication via SHA-256 hashing with SETNX. Metrics track hit/miss rates for monitoring duplicate request frequency.

**Caching** (`backend/src/shared/cache.ts`): Three caching strategies — cache-aside for user profiles (1h TTL), write-through for device presence (60s TTL with heartbeat refresh), and direct cache for call state (2h TTL). Presence uses Redis hash maps (`HSET`/`HGETALL`) for per-user device tracking with pipeline support for batch queries. All cache operations emit hit/miss metrics.

**WebSocket signaling** (`backend/src/services/signaling/`): Full signaling protocol across 6 handler modules — registration, call initiation, call response, signaling relay (offer/answer/ICE), connection management, and room management. Device registration, multi-device ring, and call state machine are implemented.

**Health checks** (`backend/src/index.ts`): Three-tier health system — `/health` (full dependency check with latency), `/health/live` (liveness probe), `/health/ready` (readiness probe). Reports database/Redis connectivity, circuit breaker states, and process memory.

**Graceful shutdown** (`backend/src/index.ts`): SIGTERM/SIGINT handlers that close WebSocket connections with code 1001, drain HTTP server, and allow 5 seconds for in-flight operations before process exit.

### What Was Simplified or Substituted

| Production Component | Local Substitute | Impact |
|---------------------|-----------------|--------|
| Apple Push Notification Service | WebSocket-only ring | Offline devices do not ring |
| STUN cluster (geo-distributed) | Google public STUN + local Coturn | Works for LAN/localhost only |
| Redis Cluster (sharded) | Single Valkey instance | No failover, no sharding |
| E2E encryption (SRTP + key exchange) | Unencrypted WebRTC media | Media not encrypted in transit |
| OAuth / Apple ID | Simple user selection (no passwords) | No real authentication |
| SFU for group calls | P2P only | Group calls limited to ~4 participants |
| CDN for static assets | Vite dev server | No caching, no edge distribution |
| L7 load balancer | Direct connection to single server | No horizontal scaling |

### What Was Omitted

- **SFU implementation** — Group calls beyond 4 participants
- **E2E encryption** — SRTP key exchange, identity verification, SAS
- **Adaptive bitrate** — Network quality detection and codec adjustment
- **Simulcast / SVC** — Multiple quality layers for receivers
- **SharePlay** — Shared media experiences during calls
- **Device handoff** — Transferring active call between devices
- **Push notifications** — APNs for ringing offline devices
- **Multi-region deployment** — Geographic distribution of signaling and TURN
- **Kubernetes orchestration** — Container management and auto-scaling
- **Call recording** — Server-side recording and storage
- **Audio processing** — Echo cancellation, noise suppression, automatic gain control

# System Design: Video Conferencing (Backend Focus)

## 🎯 1. Requirements Clarification

> "Before diving in, let me clarify the scope. We're building a Zoom-like video conferencing system. Key backend concerns are: media routing architecture, signaling protocol, meeting lifecycle, and scaling beyond thousands of concurrent meetings."

**Functional Requirements:**
- Multi-party video calls (up to 100 participants)
- Audio/video mute, camera toggle, hand raise
- Screen sharing
- In-call chat (broadcast + DM)
- Breakout rooms
- Meeting scheduling with human-readable codes

**Non-Functional Requirements:**
- Video latency < 150ms within same region
- Signaling latency < 50ms (p99)
- Support 100K concurrent meetings
- 99.99% availability

---

## 📊 2. Capacity Estimation

> "Let me size the system to understand where the bottlenecks will appear."

- **Peak concurrent meetings**: 100,000
- **Average participants/meeting**: 8
- **Peak concurrent participants**: 800,000
- **SFU worker capacity**: ~500 participants per CPU core
- **Workers needed**: 1,600 SFU processes
- **Signaling messages**: 50 msgs/participant/min = 40M msgs/min
- **Media bandwidth per participant**: ~2 Mbps upload + 2 Mbps * (N-1) streams download

---

## 🏗️ 3. High-Level Architecture

```
┌──────────┐    ┌───────────┐    ┌────────────────┐
│  Client  │───▶│  CDN/Edge │───▶│ Load Balancer  │
│ (Browser)│    │  (static) │    │ (L7 + sticky)  │
└────┬─────┘    └───────────┘    └───────┬────────┘
     │                                   │
     │  WebSocket (signaling)            │
     │  SRTP (media)                     │
     │                                   ▼
     │                        ┌──────────────────┐
     │                        │   API Gateway    │
     │                        │ (auth, rate limit)│
     │                        └────────┬─────────┘
     │                                 │
     ▼                    ┌────────────┼────────────┐
┌──────────┐        ┌─────┴─────┐  ┌──┴──────────┐ │
│SFU Cluster│       │ Signaling │  │  Meeting    │ │
│(mediasoup │◀─────▶│ Service   │  │  Service    │ │
│ Workers)  │       │(WebSocket)│  │ (REST API)  │ │
└─────┬─────┘       └─────┬─────┘  └──────┬──────┘ │
      │                   │               │         │
      ▼                   ▼               ▼         ▼
┌──────────┐      ┌──────────┐    ┌──────────┐  ┌────────┐
│  Redis   │      │  Redis   │    │PostgreSQL│  │Object  │
│ (pub/sub │      │(sessions │    │(meetings │  │Storage │
│  rooms)  │      │  state)  │    │ users)   │  │(record)│
└──────────┘      └──────────┘    └──────────┘  └────────┘
```

---

## 🔧 4. SFU Architecture Deep Dive

> "The SFU is the most critical backend component. Let me explain why we chose it over P2P mesh and MCU."

### SFU vs P2P vs MCU

| Approach | Pros | Cons |
|----------|------|------|
| ✅ **SFU** | O(N) server connections, preserves individual streams, moderate server CPU | Server handles SRTP encryption, still O(N) client download bandwidth |
| ❌ **P2P Mesh** | No server infrastructure, lowest latency for 2 users | O(N^2) connections, impractical beyond 4-5 participants |
| ❌ **MCU** | Lowest client bandwidth (single mixed stream) | Highest server CPU (real-time transcoding), loses individual stream control |

> "We chose SFU because P2P mesh breaks at 5+ participants. With 8 participants in a mesh, each client maintains 7 WebRTC connections, sending 7 copies of their video — that's 14 Mbps upload for a single user at 2 Mbps per stream. Most home connections can't sustain that. SFU reduces this to a single upload stream, with the server forwarding to all recipients. The trade-off is server CPU for SRTP encryption/decryption, but that's linear and predictable. MCU would reduce client bandwidth further by sending a single mixed stream, but it requires real-time transcoding at ~$0.50/participant/hour in compute cost, and users lose the ability to individually pin or spotlight speakers."

### mediasoup Architecture Model

```
┌─────────────────────────────────────────┐
│               Node.js Process           │
│                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐ │
│  │ Worker 1│  │ Worker 2│  │ Worker N│ │
│  │(CPU core)│  │(CPU core)│  │(CPU core)│ │
│  │         │  │         │  │         │ │
│  │ Router A│  │ Router C│  │ Router E│ │
│  │ Router B│  │ Router D│  │ Router F│ │
│  └─────────┘  └─────────┘  └─────────┘ │
└─────────────────────────────────────────┘
```

**Key concepts:**
- **Worker**: OS-level process, one per CPU core. Handles SRTP encryption and media forwarding.
- **Router**: Routing context for a meeting room. Holds codec capabilities (VP8, H264, Opus).
- **WebRtcTransport**: ICE+DTLS connection per participant per direction (send/recv).
- **Producer**: A participant's outbound audio/video track registered on a Router.
- **Consumer**: A participant's inbound copy of another participant's Producer.

**Per-participant resource allocation:**
- 1 send transport, 1 recv transport
- Up to 3 producers (audio, video, screen share)
- N-1 consumers per producer kind (consuming all other participants' tracks)

---

## 🔌 5. Signaling Protocol Deep Dive

> "The signaling protocol is the control plane for WebRTC. Every media stream setup requires a multi-step negotiation."

### WebRTC Connection Flow

```
Client                  Signaling Server              SFU
  │                          │                         │
  │──join-meeting───────────▶│                         │
  │                          │──create Router──────────▶│
  │                          │◀─Router capabilities────│
  │                          │──create Transports──────▶│
  │◀─joined (capabilities,   │◀─Transport options──────│
  │   transport options,     │                         │
  │   existing producers)    │                         │
  │                          │                         │
  │──produce (audio)─────────▶│──create Producer────────▶│
  │◀─produced (producerId)───│◀─Producer created───────│
  │                          │                         │
  │  [other clients]         │                         │
  │◀─new-producer────────────│                         │
  │──consume (producerId)───▶│──create Consumer────────▶│
  │◀─consume-response────────│◀─Consumer created───────│
  │                          │                         │
  │  [ongoing]               │                         │
  │──toggle-mute────────────▶│──broadcast update───────▶│
  │◀─participant-update──────│                         │
```

### Message Types

| Direction | Message | Payload |
|-----------|---------|---------|
| C→S | `join-meeting` | meetingCode, displayName, lobby mute/camera state |
| S→C | `joined` / `waiting` / `join-rejected` | snapshot incl. caller's role / held in waiting room / refused with a reason |
| C→S | `produce` | kind (audio/video/screen), rtpParameters |
| S→C | `produced` | producerId, kind |
| S→C | `new-producer` | userId, producerId, kind |
| C→S | `consume` | producerId |
| S→C | `consume-response` | consumerId, producerId, kind, rtpParameters |
| C→S | `producer-close` | producerId |
| S→C | `producer-closed` | producerId, userId |
| C→S | `toggle-mute` | muted: boolean |
| S→ALL | `participant-update` | userId, isMuted, isVideoOn, isScreenSharing, isHandRaised |
| C→S | `chat-message` | content, recipientId? |
| S→ALL/DM | `chat-message` | senderId, senderName, content, recipientId?, createdAt |
| C→S (host) | `admit-participant`, `mute-participant`, `remove-participant`, `transfer-host`, `lock-meeting`, `end-meeting` | target userId or flag |
| S→ALL | `role-changed`, `meeting-locked`, `meeting-ended` | results of host actions |

> "The sender's identity is never in the payload. The socket is bound to the session at upgrade time, so `mute-participant` from a participant fails on role, not on trust. Every host action also requires the target to rank below the caller, which is why a co-host can mute a participant but not the host."

---

## 💾 6. Data Model

### Core Tables

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username (unique), email (unique), password_hash, display_name | username, email | Standard auth table, passwords hashed with bcrypt |
| meetings | id (UUID PK), meeting_code (unique), title, host_id (FK→users), status, settings (JSONB), scheduled_start, actual_start, actual_end | meeting_code, (host_id, created_at DESC) | Status lifecycle: scheduled → active → ended |
| meeting_participants | id (UUID PK), meeting_id (FK), user_id (FK), display_name, role, is_muted, is_video_on, is_screen_sharing, is_hand_raised, joined_at, left_at | meeting_id, (meeting_id, user_id) UNIQUE | Role values: host, co-host, participant |
| breakout_rooms | id (UUID PK), meeting_id (FK→meetings), name, is_active | meeting_id | Created by host, activated/deactivated as a group |
| breakout_assignments | breakout_room_id (FK), participant_id (FK) | (breakout_room_id, participant_id) UNIQUE | Temporary assignments, deleted when rooms close |
| meeting_chat_messages | id (UUID PK), meeting_id (FK), sender_id (FK→users), content, recipient_id (FK→users, nullable), created_at | (meeting_id, created_at) | recipient_id NULL means broadcast to everyone |

**Meeting codes** use format `abc-defg-hij` (3-4-3 lowercase letters) — human-readable and verbally communicable. Stored with a UNIQUE constraint and indexed for fast lookup.

**Settings as JSONB** instead of normalized columns because settings are always read/written as a unit, the schema evolves frequently (new features like waiting room, E2EE toggle), and we never query across meetings by individual settings.

> "I chose JSONB for meeting settings over a normalized settings table because these settings have two important characteristics: they are always read and written atomically as a group, and they evolve frequently as new features are added. A normalized table would require a schema migration every time we add a toggle for a new feature — waiting room, E2EE, allow reactions, recording consent. With JSONB, the application code handles schema evolution through default values. The trade-off is that we lose the ability to query 'all meetings with waiting room enabled' efficiently, but that is an analytics query better served by a data warehouse, not the transactional database."

---

## 🏠 7. Breakout Rooms

> "Breakout rooms are architecturally interesting because they require dynamic Router allocation and participant migration."

**Flow:**
1. Host creates N breakout rooms via REST API
2. Host assigns participants to rooms
3. Host activates breakout rooms
4. Server creates a new SFU Router per breakout room
5. Assigned participants' transports are migrated from main Router to breakout Router
6. When host closes breakout rooms, participants migrate back to main Router

**Key challenge**: Transport migration. In mediasoup, you cannot move a Transport between Routers. Instead:
1. Close participant's existing consumers on the main Router
2. Create new Transports on the breakout Router
3. Re-negotiate ICE/DTLS (client performs new WebRTC handshake)
4. Recreate Producers and Consumers on the new Router

This causes a 1-2 second interruption during the switch, which is acceptable UX.

---

## 📈 8. Scaling Strategy

### Horizontal SFU Scaling

> "A single SFU worker handles ~500 concurrent participants. For 800K participants, we need ~1,600 workers distributed across machines."

```
┌──────────────────────────────────┐
│        SFU Controller            │
│  (routes meetings to workers)    │
└────────────┬─────────────────────┘
             │
    ┌────────┼────────┐
    ▼        ▼        ▼
┌────────┐┌────────┐┌────────┐
│Server 1││Server 2││Server N│
│ 8 cores││ 8 cores││ 8 cores│
│8 workers│8 workers│8 workers│
│~4K users│~4K users│~4K users│
└────────┘└────────┘└────────┘
```

**Routing strategy**: Consistent hashing by meeting_code determines which server handles a meeting. All participants in the same meeting go to the same server's Workers.

**Large meetings** (100+ participants): Span multiple Workers on the same server using **pipe transports** — internal connections between Workers that forward Producer streams without client involvement.

### SFU Cascading for Large Meetings

> "When a single server cannot host an entire meeting — say a 1,000-person all-hands — we need SFU cascading. This means multiple SFU servers cooperate to serve the same meeting, forwarding media between themselves."

In a cascaded setup, one server is designated the "origin" for a meeting, and additional servers act as "edge" nodes. The origin receives all producer streams and forwards them to edge servers via server-to-server pipe transports. Each edge server then distributes streams to its local participants. This introduces an additional hop of latency (typically 10-30ms for intra-region) but enables meetings to scale beyond single-server capacity.

The trade-off is operational complexity: the SFU Controller must track which servers participate in each meeting, handle edge server failures by reassigning participants to healthy edges, and manage the pipe transport lifecycle. For most meetings (2-20 participants), this complexity is unnecessary — cascading only activates for meetings exceeding a configurable threshold (default: 200 participants).

### What Breaks First at Scale

The bottlenecks emerge in this order as concurrency grows:

1. **SFU CPU** — SRTP encryption is CPU-bound. Each Worker saturates a core at ~500 participants. This is the first limit hit and is solved by adding more machines.
2. **Signaling server memory** — Each WebSocket connection holds participant state in memory. At 800K connections with ~2KB per connection, a single server needs ~1.6GB just for connection state. Horizontal scaling with sticky sessions addresses this.
3. **Redis pub/sub fan-out** — For cross-server participant state synchronization, Redis pub/sub must deliver updates to all signaling servers. At 40M messages/minute, Redis becomes a throughput bottleneck. Sharding pub/sub channels by meeting_code distributes the load.
4. **PostgreSQL write throughput** — Chat message inserts and participant join/leave updates create write pressure. Batching chat inserts (flush every 500ms instead of per-message) and using Redis as the primary store for transient participant state reduces database writes by 90%.

### Bandwidth Optimization

| Technique | How it works | Impact |
|-----------|-------------|--------|
| Simulcast | Client sends 3 quality layers (low/mid/high) | SFU forwards appropriate layer based on viewer's tile size |
| Active speaker detection | Only forward high-quality video for active speakers | Reduces bandwidth by 60-70% in large meetings |
| Last-N | Only forward video for the N most recent speakers | Caps download bandwidth for 50+ participant meetings |

> "Simulcast is the single most impactful optimization. Without it, a 25-person meeting requires each client to download 24 streams at full 720p (48 Mbps). With simulcast and a 5x5 grid, the SFU forwards low-quality layers (180p, ~100kbps) for small tiles and high-quality (720p, ~2Mbps) only for the active speaker — reducing total download to ~5 Mbps."

---

## 🔧 9. Failure Handling Deep Dive

### Failure Scenarios

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| SFU Worker crash | Meeting participants disconnected | Auto-reconnect, reassign to healthy Worker |
| Signaling server down | New joins fail, existing calls continue | Multiple signaling servers behind LB |
| Redis outage | Sessions lost, pub/sub breaks | Redis Sentinel for HA, session re-auth |
| PostgreSQL down | Meeting creation fails, history unavailable | Circuit breaker, cached meeting state in Redis |
| Network partition | Split-brain in distributed SFU | TURN fallback, server-side health monitoring |

> "The most important insight: once a WebRTC media connection is established between client and SFU, it survives signaling server failures. Participants already in a call continue talking even if the signaling server goes down. Only new joins and state changes (mute/unmute) are affected. This is a fundamental advantage of the SFU architecture — the media plane and control plane are decoupled."

### Reconnection Strategy

When a participant's WebSocket connection drops, the server does not immediately broadcast a leave event. Instead, the seat (and the role that comes with it) is held for a 10-second grace period. The reconnection flow works as follows:

1. The server finds dead sockets with a 30-second ping/pong heartbeat; otherwise a closed laptop lid would only be noticed when TCP gives up minutes later.
2. The client detects the close and begins exponential backoff reconnection (1s, 2s, 4s, 8s, 16s, maximum 5 attempts).
3. On reconnecting it re-sends `join-meeting`. Inside the grace window the server resumes the same seat and returns a fresh `joined` snapshot, so there is no replay buffer to keep. Participant state is last-writer-wins, and a snapshot is always correct.
4. The client re-registers its producers on the new transports. The old connection's producers are closed so nobody keeps consuming dead tracks.
5. Other participants see no "X left / X joined" unless the grace period expires.

> "One seat per user per meeting, matching the unique attendance row, also settles duplicate tabs: the newest connection takes the seat, and the old one is told and closed. The alternative, one seat per tab, avoids kicking anybody, but it doubles the user in everyone's grid. Worse, closing the old tab would look like the user leaving."

---

## 📡 10. Observability

### Metrics

Key metrics to track at the backend level, exposed via a Prometheus-compatible endpoint:

- **active_meetings_total** (Gauge) — Number of currently active meetings. Alerts if it drops suddenly (possible infrastructure issue) or exceeds capacity planning thresholds.
- **active_participants_total** (Gauge) — Total connected participants across all meetings. Primary capacity indicator.
- **websocket_connections_total** (Gauge) — Active WebSocket connections. Should correlate closely with participant count; divergence indicates connection leaks.
- **sfu_worker_cpu_percent** (Gauge per worker) — CPU utilization of each SFU Worker process. Alerts at 80% to trigger auto-scaling before quality degrades.
- **http_request_duration_seconds** (Histogram) — REST API latency by route and status code. p99 target: 200ms for meeting CRUD, 50ms for health checks.
- **media_quality_score** (Histogram) — Server-side estimation of media quality based on packet loss and jitter reports from RTCP feedback. Degradation triggers simulcast layer downgrades.

### Structured Logging

All logs are JSON-formatted with correlation fields: meeting_id, user_id, and a request trace_id. This enables tracing a single participant's journey from WebSocket connect through producer creation to eventual disconnect. Critical log events include meeting lifecycle transitions (created, started, ended), SFU resource allocation (Router/Transport/Producer/Consumer creation and teardown), and authentication failures.

### Alerting Priorities

| Priority | Condition | Response |
|----------|-----------|----------|
| P0 (page) | active_meetings drops > 20% in 5 min | Likely infrastructure failure, investigate immediately |
| P0 (page) | SFU worker CPU > 95% for 2 min | Auto-scale, then investigate why scaling policy missed it |
| P1 (ticket) | WebSocket reconnect rate > 10% | Network instability or signaling server issue |
| P2 (review) | p99 API latency > 500ms | Database slow queries or connection pool exhaustion |

---

## 🔒 11. Security

### Authentication and Authorization

Session-based authentication with Redis as the session store. Passwords are hashed with bcrypt (cost factor 10). Rate limiting is applied to auth endpoints (20 requests per 15 minutes per IP) and general API endpoints (100 requests per 15 minutes per IP).

Meeting-level authorization is enforced by role, and the live role is held by the signaling server, not inferred from who created the meeting. Hosts and co-hosts admit from the waiting room, mute, remove, lock and run breakout rooms. Only the host ends the meeting for everyone or transfers host. When the host leaves, the role passes to the longest-present co-host, else the longest-present participant, so a meeting is never left with nobody able to moderate. Meeting details and chat history are visible only to the organizer and attendees, and anyone else gets a 404, so a leaked meeting id reveals nothing. A DM is visible only to its two parties.

> "The meeting code is a bearer credential: unguessable, but it works for anyone it is forwarded to. So I don't treat the code as access control. It only lets someone *ask* to join. The waiting room puts admission with a person, lock closes the door mid-meeting, and removal is sticky for that meeting. Per-invitee tokens would be stronger, but they kill the 'just send me the code' workflow that makes ad-hoc meetings work."

### End-to-End Encryption Trade-off

| Approach | Pros | Cons |
|----------|------|------|
| ✅ **SRTP (SFU-terminated)** | SFU can inspect streams for quality adaptation, simulcast layer selection, active speaker detection | Media is decrypted at SFU, requires trusting the server |
| ❌ **E2EE (Insertable Streams)** | True zero-knowledge privacy, even server operator cannot see/hear content | SFU cannot adapt quality, no server-side recording, limited browser support |

> "We chose SFU-terminated SRTP over full E2EE because the SFU needs to inspect media packets for core functionality: selecting which simulcast layer to forward, detecting the active speaker to prioritize their stream, and measuring packet loss for quality adaptation. With E2EE via Insertable Streams, the SFU forwards opaque encrypted blobs — it cannot distinguish a 720p keyframe from a 180p delta frame, making simulcast impossible. For enterprise customers who require E2EE (healthcare, legal), we would offer it as an opt-in mode that disables simulcast, active speaker detection, and server-side recording, with clear UX messaging about the quality trade-offs."

### WebSocket Security

The WebSocket upgrade is authenticated with the same session cookie as REST, and the client never names itself. Because cookies ride along automatically, the upgrade also checks the `Origin` header against an allowlist; otherwise any page the user visits could open a socket as them (cross-site WebSocket hijacking). Once signaling spans several nodes, I would switch to a short-lived signed token issued by the REST API, so signaling nodes never read the session store.

---

## ⚖️ 12. Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Media architecture | SFU | P2P / MCU | O(N) connections, individual stream control |
| Signaling transport | WebSocket | HTTP polling | Sub-second ICE/DTLS negotiation required |
| Media server | mediasoup | Janus / LiveKit | Node.js native, single-process, lower overhead |
| Meeting code format | 3-4-3 letters | Numeric ID / UUID | Human-readable, verbally communicable |
| Settings storage | JSONB | Normalized table | Co-read/co-written unit, evolving schema |
| Breakout implementation | New Router per room | Single Router with filtering | True isolation, independent quality control |
| Chat delivery | WebSocket (in-band) | Separate service | Already connected for signaling |
| Session management | Redis + cookie | JWT | Immediate revocation, simpler implementation |
| Encryption | SRTP (SFU-terminated) | E2EE (Insertable Streams) | Enables simulcast, active speaker, quality adaptation |
| Participant state store | Redis (primary) + PostgreSQL (persist) | PostgreSQL only | Reduces write pressure for transient state changes |

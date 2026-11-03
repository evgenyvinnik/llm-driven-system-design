# Zoom — Video Conferencing System Architecture

## System Overview

A real-time video conferencing platform supporting multi-party video calls, screen sharing, in-call chat, breakout rooms, and meeting management. The architecture centers on an SFU (Selective Forwarding Unit) model where a media server selectively forwards each participant's media streams to all other participants, avoiding the O(N^2) mesh topology of P2P while maintaining lower latency than an MCU (Multipoint Control Unit).

**Learning goals**: SFU vs P2P vs MCU trade-offs, WebRTC signaling, media routing scalability, real-time state synchronization, breakout room orchestration.

## Requirements

### Functional Requirements
1. Users can create, schedule, and join meetings via a human-readable code (e.g., `abc-defg-hij`)
2. Multi-party video with up to 100 participants per meeting
3. Audio/video mute, camera toggle, hand raise
4. Screen sharing with presenter layout
5. In-call chat (broadcast and direct messages)
6. Breakout rooms (create, assign, activate, close)
7. Meeting lobby with camera/mic preview and device selection
8. Meeting history and participant records

### Non-Functional Requirements (Production Scale)

| Metric | Target |
|--------|--------|
| Concurrent meetings | 100,000+ |
| Participants per meeting | Up to 1,000 (100 video, 900 audio-only) |
| Video latency (p99) | < 150ms (same region) |
| Signaling latency (p99) | < 50ms |
| Availability | 99.99% |
| Audio/video quality | Adaptive bitrate, 720p default, 1080p optional |
| Call setup time | < 5 seconds from join to first frame |

## Capacity Estimation

### Production Scale
- **Peak concurrent meetings**: 100,000
- **Average participants per meeting**: 8
- **Peak concurrent participants**: 800,000
- **Signaling messages**: ~50 messages/participant/minute = 40M messages/minute
- **Media bandwidth per participant**: ~2 Mbps send + ~2 Mbps per received stream
- **SFU worker capacity**: ~500 participants per worker (CPU-bound for SRTP encryption)
- **Workers needed**: 800,000 / 500 = 1,600 SFU workers

### Local Development Scale
- 1-5 concurrent meetings
- 2-10 participants per meeting
- Single-process SFU (simulated)
- All infrastructure on localhost

## High-Level Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│   Clients   │────▶│  CDN/Edge   │────▶│  Load Balancer   │
│  (Browser)  │     │  (static)   │     │  (L7/WebSocket)  │
└──────┬──────┘     └─────────────┘     └────────┬─────────┘
       │                                         │
       │  WebSocket (signaling)                  │
       │  SRTP (media via SFU)                   │
       │                                         ▼
       │                              ┌──────────────────┐
       │                              │   API Gateway     │
       │                              │  (rate limiting,  │
       │                              │   auth, routing)  │
       │                              └────────┬─────────┘
       │                                       │
       ▼                                       ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
│  SFU Cluster │  │  Signaling   │  │  Meeting Service  │
│  (mediasoup  │  │  Service     │  │  (CRUD, lifecycle)│
│   Workers)   │  │  (WebSocket) │  │                  │
└──────┬───────┘  └──────┬───────┘  └────────┬─────────┘
       │                 │                    │
       │                 │         ┌──────────┴──────────┐
       │                 │         │                     │
       ▼                 ▼         ▼                     ▼
┌──────────┐    ┌──────────┐  ┌──────────┐      ┌──────────┐
│  Redis   │    │  Redis   │  │PostgreSQL│      │ Object   │
│ (pub/sub,│    │(sessions,│  │(meetings,│      │ Storage  │
│  rooms)  │    │  state)  │  │ users)   │      │(records) │
└──────────┘    └──────────┘  └──────────┘      └──────────┘
```

## Core Components

### 1. SFU Service (Media Routing)

The SFU is the core differentiator from P2P architectures. Each meeting room gets a **Router** that manages media routing.

**Architecture Concepts (mediasoup model):**

| Concept | Description |
|---------|-------------|
| **Worker** | OS process handling media routing. One per CPU core. |
| **Router** | Media routing context for a room. Holds RTP capabilities. |
| **WebRtcTransport** | ICE+DTLS connection. Each participant gets a send transport and a recv transport. |
| **Producer** | Represents a media track being sent to the SFU (audio, video, or screen). |
| **Consumer** | Represents a media track being forwarded from the SFU to a participant. |

**Media flow:**
```
Participant A                SFU Router              Participant B
    │                           │                         │
    │──[send transport]────────▶│                         │
    │   Producer(audio)         │                         │
    │   Producer(video)         │                         │
    │                           │──[recv transport]──────▶│
    │                           │   Consumer(A.audio)     │
    │                           │   Consumer(A.video)     │
    │                           │                         │
    │◀──[recv transport]────────│                         │
    │   Consumer(B.audio)       │◀──[send transport]──────│
    │   Consumer(B.video)       │   Producer(audio)       │
    │                           │   Producer(video)       │
```

For N participants, the SFU creates:
- N send transports (one per participant)
- N recv transports (one per participant)
- Up to 2N producers (audio + video per participant)
- Up to 2N(N-1) consumers (each participant consumes all other producers)

This is O(N) work on the server vs O(N^2) connections in P2P mesh.

### 2. Signaling Service (WebSocket)

The signaling server handles the WebRTC negotiation handshake between clients and the SFU, plus everything that changes who is in a meeting and what they may do. The socket's identity is the session resolved on the HTTP upgrade request; nothing in a message names the sender.

**Message Protocol:**

| Direction | Message | Purpose |
|-----------|---------|---------|
| Client → Server | `join-meeting` | Join with meeting code, display name, and lobby mute/camera state |
| Server → Client | `joined` | Snapshot: role, settings, lock state, participants, waiting list (hosts only), RTP capabilities, transport options, existing producers |
| Server → Client | `waiting` / `join-rejected` | Held in the waiting room, or refused (`not-found`, `meeting-ended`, `meeting-locked`, `meeting-full`, `removed`) |
| Client → Server | `produce` | Register audio/video/screen track (one per kind; screen only while sharing is granted) |
| Server → Client | `produced` / `new-producer` | Confirm producer creation / notify others about the new track |
| Client → Server | `consume` | Request a producer's media (same meeting only, never one's own) |
| Server → Client | `consume-response` | Consumer parameters for playback |
| Client → Server | `producer-close` | Stop sending a track (owner only) |
| Server → Client | `producer-closed` | Notify track removal |
| Client → Server | `toggle-mute`, `toggle-video`, `raise-hand`, `start/stop-screen-share` | Change the caller's own state |
| Server → Client | `participant-joined` / `participant-left` / `participant-update` | Presence and media state |
| Client → Server | `admit-participant`, `deny-participant`, `mute-participant`, `mute-all`, `remove-participant`, `lock-meeting` | Host and co-host controls |
| Client → Server | `transfer-host`, `set-role`, `end-meeting` | Host-only controls |
| Server → Client | `role-changed`, `waiting-room-update`, `meeting-locked`, `muted-by-host`, `removed`, `denied`, `session-replaced`, `meeting-ended` | Results of host actions and lifecycle events |
| Bidirectional | `chat-message` | In-call chat (broadcast or DM to someone in the meeting) |

### 3. Meeting Service (Lifecycle)

Manages meeting CRUD operations and participant state:

- **Meeting codes**: Generated as `abc-defg-hij` (3-4-3 lowercase letters), stored as VARCHAR(12) with UNIQUE constraint
- **Meeting lifecycle**: scheduled → active → ended (with cancelled as terminal state). The first admitted participant moves a scheduled meeting to active; it ends when the host ends it for everyone, or a grace period (30s) after the last participant leaves. Ended is terminal: joins are refused and REST start cannot reopen it
- **Participant tracking**: Join/leave timestamps, role (host/co-host/participant), media states. One row per user per meeting; a rejoin reopens it with fresh role and state
- **Settings**: JSONB field with waitingRoom, muteOnEntry, allowScreenShare, maxParticipants, all enforced at join or on the relevant action
- **Roles**: the organizer (`meetings.host_id`) is admitted as host and reclaims host whenever they rejoin. The live host can transfer the role or name co-hosts; when the host leaves, the role passes to the longest-present co-host, else the longest-present participant

### 4. Breakout Room Service

Enables hosts to split a meeting into smaller groups:

```
Main Meeting Room (Router A)
    │
    ├── Breakout Room 1 (Router B)
    │   ├── Participant 1
    │   └── Participant 4
    │
    ├── Breakout Room 2 (Router C)
    │   ├── Participant 2
    │   └── Participant 5
    │
    └── Breakout Room 3 (Router D)
        ├── Participant 3
        └── Participant 6
```

Each breakout room gets its own Router. When breakout rooms close, participants are moved back to the main room's Router. At production scale, breakout rooms in a large meeting may span multiple SFU Workers, connected via pipe transports.

### 5. Chat Service

In-meeting chat with persistence:
- Messages stored in PostgreSQL for meeting history
- Real-time delivery via WebSocket (same connection used for signaling)
- Support for broadcast (to everyone) and direct messages (to a participant currently in the meeting)
- Messages include sender display name, content, timestamp, and optional recipient
- History is visible to the organizer and attendees only, and a DM only to its sender and recipient

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users with auth credentials
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meetings with lifecycle tracking
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_code VARCHAR(12) UNIQUE NOT NULL,
  title VARCHAR(255),
  host_id UUID NOT NULL REFERENCES users(id),
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,
  actual_end TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'active', 'ended', 'cancelled')),
  settings JSONB DEFAULT '{"waitingRoom": false, "muteOnEntry": false,
    "allowScreenShare": true, "maxParticipants": 100}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Active participant tracking
CREATE TABLE meeting_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  display_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) DEFAULT 'participant'
    CHECK (role IN ('host', 'co-host', 'participant')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  is_muted BOOLEAN DEFAULT false,
  is_video_on BOOLEAN DEFAULT true,
  is_screen_sharing BOOLEAN DEFAULT false,
  is_hand_raised BOOLEAN DEFAULT false,
  UNIQUE(meeting_id, user_id)
);

-- Breakout rooms
CREATE TABLE breakout_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Breakout room participant assignments
CREATE TABLE breakout_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  breakout_room_id UUID NOT NULL REFERENCES breakout_rooms(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(breakout_room_id, participant_id)
);
-- One breakout room per participant (participant rows are already per meeting)
CREATE UNIQUE INDEX idx_breakout_assignments_participant ON breakout_assignments(participant_id);

-- In-meeting chat with optional DM targeting
CREATE TABLE meeting_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  recipient_id UUID REFERENCES users(id),  -- NULL = broadcast
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meeting recordings
CREATE TABLE recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  storage_key TEXT,
  duration INT,
  file_size BIGINT,
  status VARCHAR(20) DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_meetings_host ON meetings(host_id, created_at DESC);
CREATE INDEX idx_meetings_code ON meetings(meeting_code);
CREATE INDEX idx_meetings_status ON meetings(status);
CREATE INDEX idx_participants_meeting ON meeting_participants(meeting_id);
CREATE INDEX idx_participants_user ON meeting_participants(user_id);
CREATE INDEX idx_breakout_rooms_meeting ON breakout_rooms(meeting_id);
CREATE INDEX idx_breakout_assignments_room ON breakout_assignments(breakout_room_id);
CREATE INDEX idx_chat_messages_meeting ON meeting_chat_messages(meeting_id, created_at);
CREATE INDEX idx_recordings_meeting ON recordings(meeting_id);
```

### Key Indexes

- `idx_meetings_code` — Fast O(1) lookup by meeting code on join
- `idx_meetings_host` with `created_at DESC` — User's meetings ordered by recency for dashboard
- `idx_participants_meeting` — Participant list retrieval for meeting view
- `idx_chat_messages_meeting` with `created_at` — Ordered chat history pagination
- `idx_breakout_assignments_participant` (unique) — Re-assigning a participant is an upsert that moves them, never a second room

## API Design

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account (session id issued) |
| POST | `/api/auth/login` | Sign in (session id regenerated) |
| POST | `/api/auth/logout` | Sign out |
| GET | `/api/auth/me` | Current user |
| POST | `/api/meetings` | Create meeting; optional `Idempotency-Key`; scheduled times must carry a UTC offset |
| GET | `/api/meetings` | Meetings the user organized or attended |
| GET | `/api/meetings/code/:code` | Get meeting by code (the code is the join credential) |
| GET | `/api/meetings/:id` | Get meeting (organizer and attendees; 404 otherwise) |
| POST | `/api/meetings/:id/start` | Start meeting (organizer; scheduled → active only) |
| POST | `/api/meetings/:id/end` | End meeting (organizer); also ends the live session |
| GET | `/api/meetings/:id/participants` | Current participants (organizer and attendees) |
| GET/POST | `/api/rooms/:meetingId/breakout-rooms` | List (attendees) / create (host or co-host) breakout rooms |
| POST | `/api/rooms/breakout-rooms/:roomId/assign` | Assign a participant by `userId` (host or co-host) |
| POST | `/api/rooms/:meetingId/breakout-rooms/activate` | Open breakout rooms; participants are told their room |
| POST | `/api/rooms/:meetingId/breakout-rooms/close` | Close breakout rooms |
| GET | `/api/chat/:meetingId/messages` | Chat history as the caller may see it |
| POST | `/api/chat/:meetingId/messages` | Send chat as a live participant (delivered over WebSocket) |
| GET | `/api/health` | Health check |
| GET | `/api/metrics` | Prometheus metrics |

Resources the caller cannot see return 404 rather than 403, so a meeting id reveals nothing to outsiders; actions on a visible meeting that need a higher role return 403.

### WebSocket Protocol

Connection: `ws://host/ws`. The browser sends its session cookie on the upgrade; the server runs the Express session middleware on that request and closes unauthenticated sockets with code 4001. Upgrades from an `Origin` outside `ALLOWED_ORIGINS` are refused (cookie-authenticated sockets are otherwise open to cross-site hijacking).

All messages are JSON with a `type` field. See the Signaling Service section for the full protocol. Close codes 4001 (not signed in), 4002 (replaced by another window) and 4003 (removed by host) are final; the client does not reconnect after them.

## Key Design Decisions

### SFU vs P2P vs MCU

| Architecture | Pros | Cons |
|-------------|------|------|
| **SFU (chosen)** | O(N) server connections, preserves individual streams, lower latency than MCU | Server CPU for SRTP, still O(N) bandwidth per client |
| P2P Mesh | No server, lowest latency for 2 participants | O(N^2) connections, client CPU/bandwidth scales quadratically |
| MCU | Lowest client bandwidth (receives single mixed stream) | Highest server CPU (transcoding), loses individual stream control |

We chose SFU because video conferencing with 5-100 participants cannot use P2P mesh — quadratic scaling makes it impractical beyond 4-5 participants. At 10 participants, mesh requires 90 bidirectional connections and each client uploads 9 streams simultaneously, exceeding typical upload bandwidth. MCU would reduce client bandwidth to a single mixed stream, but transcoding 100 video streams in real-time demands enormous CPU (roughly 10x the cost of SFU forwarding), and mixing destroys individual stream control — no pinning, no spotlight, no per-participant layout adjustments. SFU preserves individual streams while keeping server work to O(N) SRTP decrypt-encrypt per participant.

The trade-off: SFU still requires each client to download N-1 streams. For 100-participant meetings, this is mitigated by simulcast (sending 3 quality layers) and the SFU forwarding only the appropriate layer based on the receiver's viewport size — a participant in a small tile gets 180p, not 720p.

### WebSocket vs HTTP Polling for Signaling

WebSocket is mandatory for WebRTC signaling. The ICE/DTLS handshake requires sub-second round-trip message exchanges. HTTP polling at 1-second intervals would add 500ms average latency to each step of a multi-step negotiation that must complete in under 2 seconds for acceptable UX. Additionally, ongoing participant state changes (mute, video, hand raise) must propagate to all participants within 100ms — polling creates an unacceptable 50-500ms delay that makes the UI feel disconnected from reality.

### JSONB Settings vs Normalized Settings Table

Meeting settings (waitingRoom, muteOnEntry, allowScreenShare, maxParticipants) are stored as JSONB. These settings are always read and written as a unit, never queried individually, and may evolve over time (e.g., adding a "recordMeeting" flag requires no schema migration). JSONB avoids the join overhead of a normalized settings table and keeps the meeting object self-contained.

The trade-off: we lose the ability to query "all meetings with waiting room enabled" efficiently. But that query pattern does not exist in the product — settings are only accessed when loading a specific meeting. If analytics needed aggregate setting data, a batch job could extract it.

### mediasoup vs Janus vs Jitsi

| Server | Language | Architecture | Trade-off |
|--------|----------|-------------|-----------|
| **mediasoup (chosen)** | C++ core, Node.js API | Single-process, worker threads | Lowest overhead, tightest integration with Node.js backend |
| Janus | C | Plugin-based, multi-process | More mature, but separate process management and C plugin development |
| Jitsi | Java + C | Full-stack (Ocho, Jicofo, JVB) | Most feature-complete, but heaviest runtime, hardest to customize |

mediasoup was chosen because it runs as a Node.js native addon, sharing the same process and event loop as the signaling server. This eliminates IPC latency between signaling and media routing. Janus would require a separate C process with JSON-RPC communication, adding ~2ms per signaling message. At 40M messages/minute, that overhead is measurable.

### Meeting Access: Code, Waiting Room, Lock

The meeting code is a bearer credential: 26^10 combinations make it unguessable, but anyone it is forwarded to can use it. So the code alone decides only who may *ask* to join. The waiting room puts the decision with a person: non-hosts are held in memory, invisible to the meeting, until a host or co-host admits or denies them. Lock closes the meeting to everyone new, removal adds the user to a per-meeting block list, and `maxParticipants` caps the room. The organizer bypasses all of these, because a host locked out of their own meeting by its own settings has no way to fix it.

The alternative, per-participant invite tokens, would make the code useless to an eavesdropper, but every invitee then needs an account-bound link and ad-hoc "send me the code" stops working. A waiting room keeps the code shareable and adds friction only for the host. The cost is that admission waits on a human, and a waiting room with no host present holds people indefinitely.

### Live Meeting State Is In-Process; PostgreSQL Is the Record

Who is in a meeting right now, with which role, mute and screen-share state, lives in one process (`websocket/meetingRooms.ts`). Every policy check (capacity, one host, one presenter, rank-based host actions) is a synchronous read-modify-write on the event loop, so two joins cannot both take the last seat and two people cannot both start presenting. Each change is written through to PostgreSQL afterwards, queued per meeting so writes land in order.

Keeping this state in PostgreSQL with row locks would survive a restart, but it would put a database round-trip and lock wait on every mute toggle and admit, on the path that has a 50ms latency budget. Keeping it in Redis would allow several signaling servers, but every check would become a Lua script or WATCH/MULTI transaction. The cost of the in-process choice is a single signaling server per meeting, and state lost on restart. Startup reconciliation closes stale attendance rows and gives active meetings the empty-meeting grace, so clients that reconnect carry on and abandoned meetings end instead of staying "active" forever. At scale, meetings would be pinned to a signaling node by consistent hashing on the meeting id, which is also what an SFU needs.

## Consistency and Idempotency

### Idempotent Meeting Creation

Meeting creation accepts a client-generated `Idempotency-Key` header. The server claims `zoom:idempotency:create-meeting:{userId}:{key}` in Redis with `SET NX` (value `pending`, 60s TTL), creates the meeting, then stores the meeting id with a 24-hour TTL. A duplicate request returns the first meeting with 200 and `replayed: true`; one that arrives while the first is still running gets 409. The short pending TTL means a request that died mid-flight does not block that key for a day. If Redis is unreachable the claim fails open: losing dedup for one request is better than refusing to create meetings. The dashboard's New Meeting button and the schedule form both send a key and disable themselves while in flight.

Meeting codes are drawn from a CSPRNG; a code collision on the UNIQUE constraint is retried with a new code rather than surfacing as an error.

### WebSocket Message Ordering and Reconnection

Each connection's messages are handled strictly in arrival order (a per-connection promise chain), so a `produce` sent right after `join-meeting` cannot run before the join completes, and a leave cannot interleave with a join. There is no replay buffer: a client that reconnects re-sends `join-meeting` and receives a fresh `joined` snapshot of the current state, which is simpler than sequence numbers and replay, and correct because participant state is last-writer-wins. Receiving "user X is muted" twice produces the same state as receiving it once.

### Chat Message Delivery

Each chat message gets a server-side UUID when it is persisted, before it is broadcast. The client merges live messages and REST history by that id, so history loaded after a (re)join never duplicates messages that already arrived live. A message is sent at most once by the client; there is no client-generated message id or server-side dedup set, so a message whose acknowledgment is lost is not retried. For in-meeting chat that trade is acceptable; a messaging product would add client ids.

### Duplicate Joins, Tabs and Disconnects

There is one seat per user per meeting, backed by the `UNIQUE(meeting_id, user_id)` participant row. A rejoin reopens that row and resets role, hand and screen-share flags, so a former host cannot come back as a second host. If the same user joins from a second tab, the newer connection takes the seat and its role. The older one receives `session-replaced` and is closed with code 4002, and nobody sees a leave/join flicker. When the old tab later closes, it does not evict the new one.

When a socket drops without a leave, the seat is held for a reconnect grace window (10s by default, `RECONNECT_GRACE_MS`). A reconnect inside the window resumes the same seat and role silently. Otherwise `participant-left` is broadcast with reason `disconnected`. Dead connections are found by a 30s ping/pong heartbeat rather than waiting minutes for TCP to give up. An explicit leave frees the seat immediately, and a leave followed by the socket closing counts as one departure.

## Security / Auth

- **Session-based authentication** with Redis session store; the session id is regenerated on login and registration (no session fixation)
- **WebSocket identity from the session**: the upgrade request runs through the same express-session middleware; a client-supplied user id is never trusted. Browser upgrades from origins outside `ALLOWED_ORIGINS` get 403
- **Meeting authorization**: meeting details, participants and chat history are visible to the organizer and attendees (404 for anyone else); breakout rooms are managed by the organizer or the live host/co-host (403 for other attendees); in-meeting host actions require a role strictly above the target's
- **bcrypt** password hashing (cost factor 10)
- **Rate limiting**: 20 *failed* auth attempts / 15 minutes per IP; 100 API requests / 15 minutes per IP (both configurable)
- **CORS** restricted to the configured frontend origins
- **HttpOnly cookies** for session tokens; chat and names are rendered as text, never HTML

In production: OAuth 2.0 (Google, SSO), short-lived signed tokens for socket handoff between nodes, end-to-end encryption for media streams (Insertable Streams API for E2EE through SFU).

## Observability

### Metrics (Prometheus via prom-client)

| Metric | Type | Purpose |
|--------|------|---------|
| `active_meetings_total` | Gauge | Current active meeting count for capacity planning |
| `active_participants_total` | Gauge | Current participant count for SFU worker scaling |
| `websocket_connections_total` | Gauge | Active WebSocket connections for load balancer tuning |
| `http_request_duration_seconds` | Histogram | API latency by route/method/status for SLI dashboards |

Default Node.js metrics (CPU, memory, event loop lag) collected automatically.

### Structured Logging (Pino)

- Request-level logging via pino-http with correlation IDs
- Meeting lifecycle events (created, started, ended) with meeting code and host
- SFU operations (router created, transport created, producer/consumer lifecycle) with participant context
- Participant join/leave events with timestamps and media state
- JSON output in production, human-readable in development

### Health Check

- `GET /api/health` — Returns server status and timestamp. It does not probe PostgreSQL or Redis; in production it would, so a load balancer could drain an instance that lost its database

## Failure Handling

### Circuit Breaker (Opossum)

`services/circuitBreaker.ts` provides an Opossum factory (50% error threshold, 5s timeout, 30s reset), but no database call is wrapped with it yet. In production it would wrap meeting creation and history queries so a slow PostgreSQL fails fast with 503 instead of tying up the event loop the signaling socket shares. Live meetings would keep working regardless, because their state is in memory and database writes are queued per meeting.

### WebSocket Reconnection

Client implements exponential backoff reconnection:
- Max 5 attempts
- Delay: 1s, 2s, 4s, 8s, 16s
- On reconnect: re-sends `join-meeting`; inside the server's 10s grace window this resumes the same seat and role, and the client re-registers its producers from the fresh `joined` snapshot
- No reconnect after a final close code (4001 not signed in, 4002 replaced, 4003 removed) or after `meeting-ended`

### Graceful Shutdown

Server handles SIGTERM/SIGINT (once, even if the signal arrives twice):
1. Close every WebSocket with 1001 and stop the WebSocket server
2. Stop accepting HTTP connections and let in-flight requests finish
3. Exit, or force exit after 3 seconds if connections linger

On the next start, reconciliation closes the attendance rows the old process left open.

## Scalability Considerations

### SFU Worker Scaling

```
                    ┌─────────────────┐
                    │  SFU Controller  │
                    │  (routing layer) │
                    └────────┬────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                   ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  SFU Worker 1│  │  SFU Worker 2│  │  SFU Worker N│
   │  (CPU Core)  │  │  (CPU Core)  │  │  (CPU Core)  │
   │  ~500 users  │  │  ~500 users  │  │  ~500 users  │
   └──────────────┘  └──────────────┘  └──────────────┘
```

- mediasoup Worker per CPU core (Node.js worker_threads)
- Load-balanced by participant count per Router
- Large meetings span multiple Workers with pipe transports

### Horizontal Scaling

- **Signaling**: Stateless WebSocket servers behind L7 load balancer with sticky sessions (by WebSocket connection, not cookie)
- **State synchronization**: Redis pub/sub for cross-server participant state broadcasts
- **Database**: Read replicas for meeting list queries, write primary for state mutations
- **Meeting routing**: Consistent hashing by meeting_code to assign SFU Workers, ensuring all participants in a meeting share the same Router

### Bandwidth Optimization

- **Simulcast**: Clients send 3 spatial layers (low 180p / medium 360p / high 720p). SFU forwards appropriate layer based on viewer's tile size in the grid layout. A participant displayed as a small tile receives the low layer, saving 90% bandwidth compared to forwarding the high layer.
- **SVC (Scalable Video Coding)**: Alternative to simulcast with temporal/spatial layers in a single stream. More bandwidth-efficient but less browser support.
- **Adaptive bitrate**: SFU adjusts forwarded quality based on receiver's bandwidth estimation via REMB/TWCC feedback.
- **Audio-only mode**: For large meetings (50+ participants), only the active speaker and pinned participants transmit video. Others are audio-only by default.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Media routing | SFU | P2P mesh / MCU | O(N) connections, individual stream control |
| Signaling | WebSocket | HTTP polling / SSE | Sub-second round-trip for ICE/DTLS negotiation |
| Media server | mediasoup | Janus / Jitsi | Single-process, Node.js native, lowest overhead |
| Session store | Redis + cookie | JWT | Immediate revocation, simpler session management |
| Meeting settings | JSONB | Normalized table | Co-read/co-written, evolving schema |
| Video codec | VP8 / H264 | VP9 / AV1 | Widest browser support, hardware acceleration |
| Chat delivery | WebSocket (shared) | Separate chat service | Already connected for signaling, minimal overhead |
| Meeting code | 3-4-3 alpha (CSPRNG) | UUID / numeric | Human-readable, typeable, memorable |
| Socket identity | Session cookie on upgrade | Client-sent user id / signed token | No trust in client claims; reuses existing session store |
| Join control | Code + waiting room + lock | Per-invitee tokens | Code stays shareable; host decides admission |
| Live meeting state | In-process, write-through to PG | Redis / PG row locks | Synchronous policy checks; single node per meeting |
| Duplicate tabs | Newest connection takes the seat | Multiple seats per user | One row per user per meeting; no leave/join flicker |
| Dropped sockets | 10s seat hold + heartbeat | Immediate leave | Reconnects resume silently; ghosts clear in seconds |
| Host leaves | Auto-promote co-host, then longest present | Meeting stays hostless | Someone can always admit, mute and end |

## Frontend Architecture

### Routing (TanStack Router, File-Based)

```
frontend/src/routes/
├── __root.tsx           → Root layout (Header + auth check + redirect to /login)
├── index.tsx            → / (dashboard with meeting list, join by code, create meeting)
├── login.tsx            → /login (username + password form)
├── register.tsx         → /register (registration form)
├── schedule.tsx         → /schedule (meeting scheduling form)
├── history.tsx          → /history (past meetings list)
└── meeting.$code.tsx    → /meeting/:code (lobby → in-meeting view)
```

The root component checks authentication on mount via `checkAuth()`. If the user is not authenticated and is not on `/login` or `/register`, they are redirected to `/login`. The `Header` component is always visible with the app logo, navigation links, and user menu.

The meeting route (`meeting.$code.tsx`) is the most complex. Its phases come from the `useMeetingConnection` hook: lobby (camera/mic preview, display name, join button), joining, waiting (held in the waiting room), in-meeting (video grid, control bar, side panels), and closed (refused, denied, removed, replaced by another window, or meeting ended), each with its own screen. An ended or cancelled meeting shows a message instead of a Join button.

### Component Hierarchy

```
RootComponent (__root.tsx)
├── Header                      (logo, nav links, user avatar, logout)
└── Outlet
    ├── Dashboard (/)
    │   ├── JoinByCode          (text input + join button for meeting code)
    │   └── MeetingCard[]       (cards showing upcoming/active meetings)
    │
    ├── LoginPage (/login)
    ├── RegisterPage (/register)
    ├── ScheduleForm (/schedule)
    ├── HistoryPage (/history)
    │
    └── MeetingPage (/meeting/:code)
        ├── MeetingLobby        (pre-join: camera preview, device selection, display name)
        │   └── useMediaDevices (hook for enumerating cameras/mics)
        │
        └── [in-meeting view]
            ├── VideoGrid        (responsive grid of participant tiles)
            │   ├── VideoTile[]  (individual participant: video/avatar, name, status icons)
            │   └── ScreenShareView  (full-width placeholder when someone shares screen)
            ├── ChatPanel        (in-meeting text chat with broadcast/DM support)
            ├── ParticipantList  (sidebar list with status indicators, Mute all)
            │   ├── WaitingRoomList    (host/co-host: Admit / Deny)
            │   └── ParticipantActions (Mute, Make co-host, Make host, Remove)
            ├── BreakoutRooms    (host/co-host: create, assign, open, close)
            ├── ControlBar       (mute, camera, share, hand, chat, participants, lock, End for all, leave)
            └── MeetingNotice    (transient banner: muted by host, role changes, refusals)
        MeetingMessageScreen     (waiting room, ended, removed, refused)
```

### Zustand Stores

Three stores separate concerns for auth, media devices, and meeting state:

**`authStore`** -- Authentication state:

| State | Purpose |
|-------|---------|
| `user` | Authenticated user object (id, username, email, displayName) |
| `loading` | True during initial auth check (blocks rendering) |
| `error` | Last auth error message |

Actions: `login()`, `register()`, `logout()`, `checkAuth()`, `clearError()`. Session-based auth with cookies; no token in localStorage.

**`mediaStore`** -- Local media device state:

| State | Purpose |
|-------|---------|
| `localStream` | MediaStream from getUserMedia (camera + microphone) |
| `isMuted`, `isVideoOn` | Current audio/video toggle states |
| `isScreenSharing` | Whether local user is sharing screen |
| `isHandRaised` | Whether local user has raised hand |
| `selectedCamera`, `selectedMic` | Device IDs for selected camera and microphone |

Actions: Setters for each field (`setIsMuted`/`setIsVideoOn` also enable or disable the real tracks, so "muted" means the microphone is off), plus `reset()` which stops all media tracks and returns to initial state. The `reset()` is called on meeting leave to release camera/mic permissions.

**`meetingStore`** -- Meeting room state:

| State | Purpose |
|-------|---------|
| `meeting` | Current meeting metadata (id, code, title, host, settings, status) |
| `participants` | Array of participants with media states (muted, video, screen share, hand raise) |
| `chatMessages` | Array of in-meeting chat messages |
| `breakoutRooms` | Array of breakout room definitions and assignments |
| `isInMeeting` | True after WebSocket join handshake completes |
| `isChatOpen`, `isParticipantListOpen`, `isBreakoutOpen` | Side panel toggle states (mutually exclusive) |
| `screenSharingUserId` | User ID of the participant currently sharing screen (null if none) |
| `myRole` | The local user's live role from the server (drives host controls; not "am I the organizer") |
| `locked`, `waiting` | Meeting lock state and the waiting-room list (hosts and co-hosts) |
| `breakoutOpen` | Whether breakout rooms are currently open |
| `notice` | Transient banner text |

Actions: `setParticipants()`, `addParticipant()` (idempotent by userId), `removeParticipant()`, `updateParticipant()` (for media state changes), `addChatMessage()` and `mergeChatHistory()` (deduplicated by message id), `setMyRole()`, `setLocked()`, `setWaiting()`, `setNotice()`, panel toggles (opening one closes the others), `reset()`. Participant updates automatically track screen sharing state -- when `isScreenSharing` is set to true, the store records that user's ID as `screenSharingUserId`.

### WebSocket Client (`services/websocket.ts`)

A singleton `WebSocketClient` class manages the real-time connection for meeting signaling and chat. Key design choices:

- **Event-based dispatch:** The client uses a `Map<string, MessageHandler[]>` to register handlers by message type. Components register handlers via `wsClient.on('joined', handler)` and unregister via `wsClient.off()`. A wildcard handler (`'*'`) catches all messages for debugging.

- **Reconnection with exponential backoff:** On an unexpected close the client attempts up to 5 reconnections with delays of 1s, 2s, 4s, 8s, 16s, and re-sends the last `join-meeting` on each reconnect so the server's grace window resumes the same seat. Close codes ≥ 4000 are final (not signed in, replaced, removed); an intentional disconnect or leave clears the remembered join.

- **Signaling methods:** The client exposes typed methods for the WebRTC signaling protocol (`joinMeeting()`, `leaveMeeting()`, `produce()`, `consume()`, `closeProducer()`, `toggleMute()`, `toggleVideo()`, `startScreenShare()`, `stopScreenShare()`, `raiseHand()`, `sendChatMessage()`) and for host controls (`admitParticipant()`, `denyParticipant()`, `muteParticipant()`, `muteAll()`, `removeParticipant()`, `transferHost()`, `setRole()`, `lockMeeting()`, `endMeeting()`). The server checks the caller's role for each.

- **Auth via the session cookie:** The connection URL carries no identity; the browser sends the session cookie on the upgrade, and the Vite dev proxy forwards it to the backend.

### Data Fetching

**REST API (`services/api.ts`):** Used for operations that happen before or after a meeting. Provides auth endpoints (login, register, logout, getMe), meeting CRUD (createMeeting, getMeetings, getMeetingByCode, startMeeting, endMeeting), breakout room management (createBreakoutRooms, activateBreakoutRooms, closeBreakoutRooms), and chat history (getChatMessages). All calls use `fetch()` with `credentials: 'include'` to send session cookies.

**Meeting page data flow:** The `/meeting/:code` route loads meeting metadata via REST on mount (`api.getMeetingByCode(code)`), then establishes the WebSocket connection on join. After the WebSocket `joined` message arrives, the participant list is populated from the message payload, and the UI transitions from lobby to in-meeting view.

### Real-Time Update Patterns

**WebSocket message handling (`hooks/useMeetingConnection.ts`):** The hook registers every handler once when the meeting page mounts and removes them on unmount, so re-joining never stacks duplicate handlers. Closing the tab sends `leave-meeting` from `pagehide` so the seat is not held for the grace window.

| Server Message | Store Action | Effect |
|----------------|-------------|--------|
| `joined` | `setParticipants()`, `setMyRole()`, `setLocked()`, `setWaiting()`, media flags from `self` | Lobby → meeting; produces audio/video, consumes existing producers, loads chat history and breakout rooms |
| `waiting` | phase `waiting` | Waiting-room screen |
| `join-rejected`, `denied`, `removed`, `session-replaced`, `meeting-ended` | phase `closed` | Explanatory screen; no auto-rejoin |
| `participant-joined` / `participant-left` | `addParticipant()` / `removeParticipant()` | Tile appears / disappears |
| `participant-update` | `updateParticipant()`; own updates also sync `mediaStore` | Icons update; own screen share produces or drops the screen track |
| `role-changed` | `updateParticipant()`, `setMyRole()` | Badges and host controls follow the live role |
| `waiting-room-update`, `meeting-locked`, `muted-by-host` | `setWaiting()`, `setLocked()`, `setIsMuted(true)` + notice | Host panels and banners |
| `chat-message` | `addChatMessage()` | New message in chat (deduplicated by id) |
| `new-producer` | `wsClient.consume()` | Subscribes to the new track (no media flows in the simulation) |
| `breakout-rooms-updated/opened/closed` | `setBreakoutRooms()` + notice | Room list; participants learn their room |
| `error` | notice | Refused actions (e.g. someone else is presenting) are shown |

### Key UI Patterns

- **Adaptive video grid:** `VideoGrid` computes CSS grid classes dynamically based on participant count: 1 participant = 1x1, 2 = 2x1, up to 4 = 2x2, up to 9 = 3x3, up to 16 = 4x4, beyond 16 = 5-column auto-rows with scroll. When someone is screen sharing, the layout switches to a presenter view: the screen share fills the main area, and participants appear as small tiles in a vertical strip on the right.

- **Mutually exclusive side panels:** Opening Chat closes Participants and Breakout Rooms, and vice versa. The toggle functions in `meetingStore` enforce this by setting the opened panel to true and all others to false.

- **Meeting lobby with device preview:** Before joining, users see their camera preview and can select audio/video devices via the `useMediaDevices` hook (which calls `navigator.mediaDevices.enumerateDevices()`). The display name field is pre-populated from the auth store.

- **Dark theme (Zoom-inspired):** The UI uses a custom Tailwind color palette with `zoom-bg` (dark background), `zoom-card`, `zoom-surface`, `zoom-primary` (#2D8CFF blue accent), `zoom-text`, and `zoom-secondary`. This matches the recognizable Zoom dark aesthetic.

- **Meeting code format:** Meeting codes use the human-readable `abc-defg-hij` pattern (3-4-3 lowercase letters). Users can join by typing this code in the `JoinByCode` component on the dashboard, or by navigating directly to `/meeting/abc-defg-hij`.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation describes what the pattern is, why it exists, and how it works -- assuming no prior knowledge.

### Circuit Breaker

**What it is:** A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing dependency. It works like an electrical circuit breaker: when failures exceed a threshold, the circuit "opens" and all subsequent calls fail immediately (fast-fail) without attempting the actual operation. After a cooldown period, the circuit enters a "half-open" state where it allows one probe request through. If the probe succeeds, the circuit closes and normal operation resumes.

**Why it matters:** The Zoom backend depends on PostgreSQL for meeting creation, participant tracking, and chat persistence. If PostgreSQL becomes unresponsive (connection pool exhausted, disk full, network partition), every API request would block for the full database timeout (5 seconds). With 100 participants in a meeting, each toggling mute or sending chat messages, the Express request handler pool fills up. More critically, the WebSocket signaling server shares the Node.js event loop with the Express server. Blocked database calls would stall WebSocket message processing, causing all participants to experience frozen video grids and unresponsive controls. The circuit breaker prevents this cascade by failing database calls instantly when PostgreSQL is known to be unhealthy, preserving WebSocket signaling (which uses Redis for state) even during database outages.

**How it works here:** `createCircuitBreaker` builds an Opossum breaker (50% error threshold, 5-second timeout, 30-second reset, state transitions logged), but no query is wrapped with it yet, so today a slow database slows requests rather than failing them fast. Live meetings are already insulated: their state is in memory and database writes are queued per meeting, so a slow write delays the record, not the signaling.

**File:** `backend/src/services/circuitBreaker.ts`

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make within a time window. It protects the system from abuse by ensuring no single client can consume disproportionate resources.

**Why it matters:** Video conferencing endpoints are attractive targets for abuse. A brute-force attack against the login endpoint could try thousands of passwords per minute. A bot could create hundreds of meetings, consuming meeting codes and database resources. Rate limiting caps the damage any single source can cause and provides time for detection and response.

**How it works here:** Two tiers of rate limiting are implemented. Auth endpoints (login, register) have a strict limit of 20 requests per 15 minutes per IP address -- aggressive enough to prevent brute-force attacks while lenient enough for users who mistype their password a few times. General API endpoints have a broader limit of 100 requests per 15 minutes per IP. The auth limiter counts only failed attempts (`skipSuccessfulRequests`), so signing in and out normally never locks anyone out. Both use `express-rate-limit` with its in-memory store, which matches the single-server signaling design; several API instances would share counters through `rate-limit-redis` (already a dependency). Limits are configurable with `API_RATE_LIMIT` and `AUTH_RATE_LIMIT`. When the limit is exceeded, the server returns HTTP 429 (Too Many Requests).

**File:** `backend/src/services/rateLimiter.ts`

### Structured Logging

**What it is:** Structured logging writes log entries as machine-parseable JSON objects rather than free-form text strings. Each log entry includes standardized fields (timestamp, level, message) plus context-specific metadata (meeting code, participant count, SFU operation type).

**Why it matters:** Debugging video conferencing issues requires correlating events across multiple participants in the same meeting. When a user reports "I can't see anyone's video," you need to find their join event, check whether their producers were created, see if consumers were created for other participants, and determine whether the SFU router was healthy. With free-form text logs, this requires manual grep and mental correlation across hundreds of log lines. With structured JSON logs, it is a query: `meetingCode=abc-defg-hij AND event=produce | sort by timestamp`.

**How it works here:** Pino is configured with `pino-http` for request-level logging with correlation IDs. Meeting lifecycle events (created, started, ended) are logged with meeting code and host user. SFU operations (router created, transport created, producer/consumer lifecycle) are logged with participant context. Participant join/leave events include timestamps and media state (muted, video on, screen sharing). In development, Pino outputs human-readable colored text; in production, it outputs JSON for ingestion by log aggregation systems.

**File:** `backend/src/services/logger.ts`

### Prometheus Metrics

**What it is:** Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose an HTTP endpoint (`/metrics`) with metric values in a text format. Prometheus scrapes this endpoint and stores the time-series data for visualization and alerting.

**Why it matters:** Video conferencing has specific operational metrics that are critical for capacity planning and incident response. "How many meetings are active right now?" determines whether to scale up SFU workers. "How many participants are connected?" determines WebSocket server load. "What is the API latency by route?" identifies slow endpoints before users complain. Without metrics, these questions require manual investigation during incidents, when response time is most critical.

**How it works here:** Four custom metrics are defined. `active_meetings_total` (Gauge) tracks live meetings in this process, used for SFU worker capacity planning. `active_participants_total` (Gauge) tracks admitted participants, counted once per seat; a second tab or a leave followed by a socket close does not double-count. `websocket_connections_total` (Gauge) tracks active WebSocket connections for load balancer tuning. `http_request_duration_seconds` (Histogram with method, route, and status labels) records API latency for SLI dashboards. Default Node.js metrics (CPU, memory, event loop lag, GC pause duration) are collected automatically via `collectDefaultMetrics()`.

**File:** `backend/src/services/metrics.ts`

### Health Checks

**What it is:** Health checks are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers, container orchestrators, and monitoring dashboards to detect and respond to failures.

**Why it matters:** A video conferencing server depends on PostgreSQL (meeting persistence) and Redis (sessions, participant state). If PostgreSQL fails, the server cannot create new meetings but active meetings continue. If Redis fails, sessions are lost but in-memory meeting state is preserved. Health checks enable automated systems to make nuanced decisions: remove an instance from the load balancer when PostgreSQL is down (cannot serve new meeting requests) but do not restart it (active meetings are still functional).

**How it works here:** `GET /api/health` returns status and timestamp only; it is a liveness probe. A readiness probe that pings PostgreSQL and Redis is the obvious next step and is not implemented.

### Idempotency

**What it is:** Idempotency means that performing the same operation multiple times produces the same result as performing it once. In distributed systems, network failures cause retries: a client sends a request, the server processes it, but the response is lost. The client retries, and without idempotency, the operation executes twice.

**Why it matters:** Meeting creation is the most important idempotent operation. If a user clicks "New Meeting" and the network drops the response, their client retries. Without idempotency, two meetings are created with different codes, and the user sees a confusing duplicate in their meeting list. Similarly, the meeting code UNIQUE constraint in PostgreSQL provides a secondary safeguard -- but relying on database errors for flow control is fragile and produces poor error messages.

**How it works here:** Meeting creation accepts an `Idempotency-Key` header. The server claims the key in Redis with `SET NX` (pending, 60s), creates the meeting, then stores its id for 24 hours; a repeat returns the same meeting with 200 and `replayed: true` (409 while the first is still running). Breakout assignment is an upsert on a unique `participant_id` index, so repeating it is harmless. Participant state updates are last-writer-wins and idempotent, and `consume` returns the existing Consumer for a repeated (subscriber, producer) pair. Chat has no client message id: the server assigns the id, and clients deduplicate by it when merging history.

### RBAC (Role-Based Access Control)

**What it is:** RBAC is an authorization model where permissions are assigned to roles rather than to individual users. Each user is assigned a role, and the role determines what actions they can perform.

**Why it matters:** In a video conferencing system, different participants have different capabilities within the same meeting. The host can end the meeting, mute other participants, create breakout rooms, and manage settings. Co-hosts share some of these capabilities. Regular participants can only control their own media state. Without RBAC, these permission checks would be ad-hoc conditional statements throughout the WebSocket handler, making them difficult to audit and easy to bypass.

**How it works here:** Three meeting roles are ranked: `host` (end meeting for all, transfer host, name co-hosts), `co-host` (admit/deny, mute, mute all, remove, lock, manage breakout rooms), and `participant` (own audio, video, hand, chat, and screen share unless the host disabled it). Every host action also requires the target to rank strictly below the caller, so a co-host cannot remove the host or another co-host. The live role is held in memory by `websocket/meetingRooms.ts`, checked there for every privileged message, and written through to `meeting_participants.role`. The organizer is admitted as host and reclaims host on rejoining (the interim host becomes co-host); when the host leaves, the role passes to the longest-present co-host, else the longest-present participant. The frontend shows controls from the live role (`myRole`); the server enforces them regardless.

### Redis Cache-Aside

**What it is:** Cache-aside (also called "lazy loading") is a caching strategy where the application checks a fast in-memory cache before querying a slower persistent store. On a cache miss, the application queries the database, stores the result in the cache, and returns it. On a cache hit, the database is skipped entirely.

**Why it matters:** In a video conferencing system, session validation happens on every HTTP request and every WebSocket connection upgrade. With 800,000 concurrent participants, each making signaling requests, validating sessions against PostgreSQL would require hundreds of thousands of queries per second. Redis serves session lookups in sub-millisecond time from memory, reducing database load by orders of magnitude.

**How it works here:** Redis is the session store (via `connect-redis` with `ioredis`) and holds idempotency keys for meeting creation. Sessions expire automatically, and PostgreSQL is not involved in session validation, including the validation of every WebSocket upgrade. Transient meeting state is not in Redis: it lives in the signaling process, and a reconnecting client receives a fresh snapshot instead of a replay of missed events.

## Implementation Notes

### Local Architecture

```
┌───────────────┐        ┌──────────────────────────────────┐
│   Browser     │        │       Docker Compose             │
│   (React)     │        │                                  │
│               │        │  ┌────────────┐  ┌────────────┐ │
│  :5173        │───────▶│  │ PostgreSQL │  │   Valkey   │ │
│  Vite Dev     │        │  │   :5432    │  │   :6379    │ │
│  TanStack     │        │  └────────────┘  └────────────┘ │
│  Router       │        └──────────────────────────────────┘
└───────┬───────┘                     ▲
        │                             │
        │  HTTP + WebSocket           │
        ▼                             │
┌───────────────┐                     │
│  Express +    │─────────────────────┘
│  WebSocket    │
│  :3001        │
│               │
│  ┌──────────┐ │
│  │Simulated │ │
│  │SFU       │ │
│  │Service   │ │
│  └──────────┘ │
└───────────────┘
```

### Production-Grade Patterns Implemented

**Session-authenticated signaling socket** (`backend/src/websocket/handler.ts`): The upgrade request runs through the exported express-session middleware, so a socket belongs to the logged-in user; the old handler took `userId` from the query string, letting anyone connect as anyone, including as a meeting's host. Origins outside `ALLOWED_ORIGINS` are refused. Each connection's messages run in order through a promise chain, a 30s ping/pong heartbeat terminates dead sockets, and payloads are capped at 64KB.

```typescript
server.on('upgrade', (req, socket, head) => {
  sessionMiddleware(req, {} as Response, () => {
    wss.handleUpgrade(req, socket, head, (ws) =>
      onConnection(ws, req.session?.userId ?? null, req.session?.username ?? null));
  });
});
```

**Live meeting state and policy** (`backend/src/websocket/meetingRooms.ts`): One module owns who is in each meeting and enforces the waiting room, lock, capacity, removal list, mute-on-entry, screen-share permission and single presenter, the host/co-host ranks, host promotion and the organizer reclaiming host, one seat per user (newest tab wins, close 4002), the 10s reconnect grace, ending 30s after the room empties, and startup reconciliation. Checks are synchronous on the event loop; database writes are queued per meeting so they commit in order. Covered by `meetingRooms.test.ts` (28 tests) and `handler.test.ts` (socket auth over a real upgrade).

**Simulated SFU service** (`backend/src/services/sfuService.ts`): Models the mediasoup architecture (Routers, WebRtcTransports, Producers, Consumers) in memory. Router per meeting, send/recv transport per participant, one producer per kind, consumers only for producers of the same meeting (never one's own, idempotent per pair), close only by the producer's owner, cascade cleanup on close and leave. The frontend now drives it: it produces audio and video after joining, consumes every advertised producer, and produces a screen track only after the server grants the share. Only SRTP forwarding is simulated.

**Authorization on REST** (`backend/src/routes/*.ts`, `meetingService.getMeetingForViewer`): Meeting details, participants and chat history are visible to the organizer and attendees, and 404 otherwise; DMs are filtered to their two parties in SQL. Breakout management needs the organizer or the live host/co-host (403 for other attendees); assignments must be participants of the same meeting, enforced by a unique index on `participant_id`. Malformed ids return 404 instead of a database error.

**Idempotent meeting creation** (`backend/src/routes/meetings.ts`): `Idempotency-Key` claimed with `SET NX` in Redis; repeats return the first meeting. Meeting codes come from `crypto.randomInt` with collision retry.

**Time zones** (`meetingService.parseCreateMeetingInput`, `ScheduleForm.tsx`): The API accepts only ISO-8601 timestamps with an offset; the form converts the browser's local `datetime-local` value with `toISOString()` and shows the user's zone. Before, the naive value was stored as UTC, moving meetings by the user's offset.

**Structured logging** (`backend/src/services/logger.ts`): Pino with request logging via pino-http; joins, admissions, leaves, meeting ends and SFU operations carry meeting and user ids.

**Prometheus metrics** (`backend/src/services/metrics.ts`): active meetings (now actually set), active participants (counted once per seat), WebSocket connections, HTTP duration histogram, default Node.js metrics.

**Rate limiting** (`backend/src/services/rateLimiter.ts`): 100 API requests and 20 failed auth attempts per 15 minutes per IP, in memory, configurable.

**Session auth** (`backend/src/middleware/auth.ts`, `routes/auth.ts`): Redis-backed sessions, HttpOnly cookies, bcrypt, session id regenerated at login and registration.

**Breakout rooms** (`backend/src/services/breakoutService.ts`, `frontend/src/components/BreakoutRooms.tsx`): Create, assign by user id (re-assigning moves), open, close, delete; open/close and changes are pushed to everyone in the meeting, and each participant is told their room.

### What Was Simplified or Substituted

| Production Component | Local Substitute | Impact |
|---------------------|-----------------|--------|
| mediasoup C++ SFU | In-memory simulation | Signaling works; no actual media forwarding |
| Media streams between peers | Local camera preview only | Video grid shows placeholders for remote streams |
| STUN/TURN servers | None | WebRTC connections not established |
| OAuth 2.0 / SSO | Session auth with bcrypt | Functional but not production-grade |
| Redis Cluster | Single Valkey instance | No failover, no sharding |
| Signaling cluster with meeting pinning | One process holds all live meetings | `dev:server2/3` cannot share meetings; restart drops live state (reconciled at boot) |
| Breakout Routers | Assignment + notification only | Participants learn their room; media and chat are not isolated per room |
| Circuit breaker on DB calls | Factory exists, not wired | Slow database slows requests instead of failing fast |
| Readiness health check | Liveness only | `/api/health` does not probe PostgreSQL or Redis |
| Rate limits across instances | In-memory store | Correct for a single instance only |

### What Was Omitted

- **CDN** for static assets
- **End-to-end encryption (E2EE)** for media via Insertable Streams
- **Kubernetes orchestration** for SFU worker scaling
- **Recording pipeline** (capture, transcode, store to object storage); the `recordings` table is unused
- **Meeting passcodes and per-invitee links** (the code plus waiting room and lock are the access controls)
- **Virtual backgrounds / noise cancellation** (ML processing)
- **TURN/STUN server infrastructure**
- **Multi-region deployment** with geo-routing for lowest-latency SFU selection
- **Simulcast / SVC** encoding on the client
- **Bandwidth estimation** (REMB/TWCC) for adaptive quality
- **Dominant speaker detection** for auto-pinning active speaker

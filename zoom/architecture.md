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

The signaling server handles the WebRTC negotiation handshake between clients and the SFU:

**Message Protocol:**

| Direction | Message | Purpose |
|-----------|---------|---------|
| Client → Server | `join-meeting` | Join with meeting code + display name |
| Server → Client | `joined` | Meeting state, participants, RTP capabilities, transport options |
| Client → Server | `produce` | Register audio/video/screen track |
| Server → Client | `produced` | Confirm producer creation |
| Server → Client | `new-producer` | Notify others about new media track |
| Client → Server | `consume` | Request to receive a producer's media |
| Server → Client | `consume-response` | Consumer parameters for playback |
| Client → Server | `producer-close` | Stop sending a track |
| Server → Client | `producer-closed` | Notify track removal |
| Bidirectional | `participant-update` | Mute, video, screen share, hand raise state |
| Bidirectional | `chat-message` | In-call chat (broadcast or DM) |

### 3. Meeting Service (Lifecycle)

Manages meeting CRUD operations and participant state:

- **Meeting codes**: Generated as `abc-defg-hij` (3-4-3 lowercase letters), stored as VARCHAR(12) with UNIQUE constraint
- **Meeting lifecycle**: scheduled → active → ended (with cancelled as terminal state)
- **Participant tracking**: Join/leave timestamps, role (host/co-host/participant), media states
- **Settings**: JSONB field with waitingRoom, muteOnEntry, allowScreenShare, maxParticipants

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
- Support for broadcast (to everyone) and direct messages (to specific participant)
- Messages include sender display name, content, timestamp, and optional recipient

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

## API Design

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/logout` | Sign out |
| GET | `/api/auth/me` | Current user |
| POST | `/api/meetings` | Create meeting |
| GET | `/api/meetings` | List user's meetings |
| GET | `/api/meetings/code/:code` | Get meeting by code |
| POST | `/api/meetings/:id/start` | Start meeting |
| POST | `/api/meetings/:id/end` | End meeting |
| GET | `/api/meetings/:id/participants` | Get participants |
| POST | `/api/rooms/:meetingId/breakout-rooms` | Create breakout rooms |
| POST | `/api/rooms/:meetingId/breakout-rooms/activate` | Open breakout rooms |
| POST | `/api/rooms/:meetingId/breakout-rooms/close` | Close breakout rooms |
| GET | `/api/chat/:meetingId/messages` | Get chat history |
| GET | `/api/health` | Health check |
| GET | `/metrics` | Prometheus metrics |

### WebSocket Protocol

Connection: `ws://host/ws?userId=<id>&username=<name>`

All messages are JSON with a `type` field. See the Signaling Service section for the full protocol.

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

## Consistency and Idempotency

### Idempotent Meeting Creation

Meeting creation requests include a client-generated idempotency key (UUID) sent in the `Idempotency-Key` header. The server stores completed request outcomes keyed by this value in Redis with a 24-hour TTL. If a duplicate request arrives — due to a network retry or the user double-clicking the "New Meeting" button — the server returns the previously created meeting rather than generating a second one. This prevents orphaned meetings that no one joins, which would pollute the user's meeting history and consume meeting codes unnecessarily.

The meeting code itself provides a secondary uniqueness constraint. Because codes are generated server-side with a UNIQUE database constraint, even without an idempotency key, a duplicate insert would fail at the database level. However, relying on database errors for flow control is fragile — the idempotency key approach catches duplicates before they reach the database.

### WebSocket Message Delivery Semantics

Signaling messages use at-least-once delivery with client-side deduplication. Each WebSocket message includes a monotonically increasing sequence number per connection. When a client reconnects after a brief disconnection, it sends its last received sequence number in the `join-meeting` message, and the server replays any missed state changes from a short-lived buffer stored in Redis (retained for 60 seconds after disconnection).

For participant state updates (mute, video toggle, hand raise), the system uses last-writer-wins semantics. These are inherently idempotent — receiving "user X is muted" twice produces the same state as receiving it once. The server maintains the authoritative participant state in Redis, and any conflicting updates resolve to the most recent timestamp.

### Exactly-Once Chat Message Guarantees

Chat messages require stronger guarantees than signaling messages because users expect every message to appear exactly once in the correct order. Each chat message is assigned a server-side UUID before being persisted to PostgreSQL and broadcast via WebSocket. The client tracks received message IDs in a local Set. If a duplicate arrives during reconnection replay, the client silently drops it.

On the write path, the client includes a client-generated message ID with each chat submission. The server checks for this ID in a Redis set (scoped to the meeting, TTL of 1 hour) before inserting into PostgreSQL. If the ID already exists, the server returns the existing message without creating a duplicate row. This handles the case where the client sends a message, the server persists it, but the acknowledgment is lost — prompting the client to retry.

### Handling Duplicate Join and Leave Events

Join and leave events are idempotent by design. The `meeting_participants` table has a UNIQUE constraint on `(meeting_id, user_id)`, so a duplicate join attempt results in an upsert that updates the `joined_at` timestamp and clears the `left_at` field rather than creating a second row. Similarly, a duplicate leave event sets `left_at` to the current timestamp regardless of whether it was already set.

During network instability, a participant may appear to leave and rejoin rapidly. The server applies a grace period of 5 seconds before broadcasting a `participant-left` event to other participants. If the user reconnects within that window, the departure is never announced, avoiding the disruptive "X left / X joined" notification flicker that degrades the meeting experience. The reconnecting client re-establishes its WebSocket connection, re-registers its producers, and other participants see seamless continuity.

## Security / Auth

- **Session-based authentication** with Redis session store
- **bcrypt** password hashing (cost factor 10)
- **Rate limiting** on auth endpoints (20 requests / 15 minutes)
- **API rate limiting** (100 requests / 15 minutes per IP)
- **CORS** restricted to frontend origin
- **HttpOnly cookies** for session tokens

In production: OAuth 2.0 (Google, SSO), JWT with refresh tokens, end-to-end encryption for media streams (Insertable Streams API for E2EE through SFU).

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

- `GET /api/health` — Returns server status, timestamp, PostgreSQL pool health, Redis connectivity

## Failure Handling

### Circuit Breaker (Opossum)

Applied to database queries to prevent cascade failures when PostgreSQL is unavailable:
- Error threshold: 50%
- Timeout: 5 seconds per query
- Reset timeout: 30 seconds before half-open probe

When the circuit opens, meeting creation and history queries fail fast with a 503 status code rather than hanging for the full database timeout. This preserves WebSocket signaling (which uses Redis) even when PostgreSQL is down — active meetings continue functioning, but new meetings cannot be created.

### WebSocket Reconnection

Client implements exponential backoff reconnection:
- Max 5 attempts
- Delay: 1s, 2s, 4s, 8s, 16s
- On reconnect: rejoin meeting with current state, re-register producers

### Graceful Shutdown

Server handles SIGTERM/SIGINT:
1. Stop accepting new connections
2. Close WebSocket server (sends close frame to all clients)
3. Wait for ongoing requests to complete
4. Close database pool
5. Exit process

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
| Meeting code | 3-4-3 alpha | UUID / numeric | Human-readable, typeable, memorable |

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

The meeting route (`meeting.$code.tsx`) is the most complex -- it implements a two-phase flow within a single route: the meeting lobby (camera/mic preview, display name entry, join button) transitions to the in-meeting view (video grid, control bar, side panels) once the WebSocket join handshake completes.

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
            ├── ParticipantList  (sidebar list with mute/video/hand status indicators)
            ├── BreakoutRooms    (host-only: create, assign, activate, close breakout rooms)
            ├── ControlBar       (bottom bar: mute, camera, screen share, hand raise, chat, leave)
            └── HandRaiseIndicator (animated hand icon overlay)
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

Actions: Setters for each field, plus `reset()` which stops all media tracks and returns to initial state. The `reset()` is called on meeting leave to release camera/mic permissions.

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

Actions: `setParticipants()`, `addParticipant()`, `removeParticipant()`, `updateParticipant()` (for media state changes), `addChatMessage()`, panel toggles (opening one closes the others), `reset()`. Participant updates automatically track screen sharing state -- when `isScreenSharing` is set to true, the store records that user's ID as `screenSharingUserId`.

### WebSocket Client (`services/websocket.ts`)

A singleton `WebSocketClient` class manages the real-time connection for meeting signaling and chat. Key design choices:

- **Event-based dispatch:** The client uses a `Map<string, MessageHandler[]>` to register handlers by message type. Components register handlers via `wsClient.on('joined', handler)` and unregister via `wsClient.off()`. A wildcard handler (`'*'`) catches all messages for debugging.

- **Reconnection with exponential backoff:** On unexpected close (code !== 4001), the client attempts up to 5 reconnections with delays of 1s, 2s, 4s, 8s, 16s. On intentional disconnect, reconnection is suppressed by setting `reconnectAttempts = maxReconnectAttempts`.

- **Signaling methods:** The client exposes typed methods for the WebRTC signaling protocol: `joinMeeting()`, `leaveMeeting()`, `produce()`, `consume()`, `closeProducer()`, `toggleMute()`, `toggleVideo()`, `startScreenShare()`, `stopScreenShare()`, `raiseHand()`, `sendChatMessage()`. Each method wraps `ws.send(JSON.stringify({...}))` with the appropriate message type.

- **Auth via query parameters:** The connection URL includes `userId` and `username` as query parameters. This is a development simplification -- production would validate the session cookie during the WebSocket upgrade handshake.

### Data Fetching

**REST API (`services/api.ts`):** Used for operations that happen before or after a meeting. Provides auth endpoints (login, register, logout, getMe), meeting CRUD (createMeeting, getMeetings, getMeetingByCode, startMeeting, endMeeting), breakout room management (createBreakoutRooms, activateBreakoutRooms, closeBreakoutRooms), and chat history (getChatMessages). All calls use `fetch()` with `credentials: 'include'` to send session cookies.

**Meeting page data flow:** The `/meeting/:code` route loads meeting metadata via REST on mount (`api.getMeetingByCode(code)`), then establishes the WebSocket connection on join. After the WebSocket `joined` message arrives, the participant list is populated from the message payload, and the UI transitions from lobby to in-meeting view.

### Real-Time Update Patterns

**WebSocket message handling in MeetingPage:** The `setupWsHandlers()` callback registers handlers for all meeting events:

| Server Message | Store Action | Effect |
|----------------|-------------|--------|
| `joined` | `setParticipants()`, `setIsInMeeting(true)` | Transitions from lobby to meeting view |
| `participant-joined` | `addParticipant()` | New tile appears in video grid |
| `participant-left` | `removeParticipant()` | Tile removed, screen share cleared if they were sharing |
| `participant-update` | `updateParticipant()` | Mute/video/screen share/hand raise icons update |
| `chat-message` | `addChatMessage()` | New message appears in chat panel |
| `new-producer` | (no-op in simulation) | Would create a consumer to receive media in production |
| `producer-closed` | (no-op in simulation) | Would clean up consumer in production |
| `left` | `setIsInMeeting(false)` | Returns to lobby state |
| `error` | Console error | Logged for debugging |

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

**How it works here:** Opossum wraps database queries with a 50% error threshold, 5-second timeout per query, and 30-second reset before half-open probe. When the circuit opens, meeting creation and history queries fail fast with a 503 status code. Active meetings continue functioning because participant state is managed in memory and via Redis -- only meeting persistence is affected. The `circuit_breaker_state` Prometheus metric tracks state transitions for alerting.

**File:** `backend/src/services/circuitBreaker.ts`

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make within a time window. It protects the system from abuse by ensuring no single client can consume disproportionate resources.

**Why it matters:** Video conferencing endpoints are attractive targets for abuse. A brute-force attack against the login endpoint could try thousands of passwords per minute. A bot could create hundreds of meetings, consuming meeting codes and database resources. Rate limiting caps the damage any single source can cause and provides time for detection and response.

**How it works here:** Two tiers of rate limiting are implemented. Auth endpoints (login, register) have a strict limit of 20 requests per 15 minutes per IP address -- aggressive enough to prevent brute-force attacks while lenient enough for users who mistype their password a few times. General API endpoints have a broader limit of 100 requests per 15 minutes per IP. Both use `express-rate-limit` with `rate-limit-redis` as the store, which ensures rate limits are enforced consistently across multiple server instances (all instances share the same Redis counter). When the limit is exceeded, the server returns HTTP 429 (Too Many Requests).

**File:** `backend/src/services/rateLimiter.ts`

### Structured Logging

**What it is:** Structured logging writes log entries as machine-parseable JSON objects rather than free-form text strings. Each log entry includes standardized fields (timestamp, level, message) plus context-specific metadata (meeting code, participant count, SFU operation type).

**Why it matters:** Debugging video conferencing issues requires correlating events across multiple participants in the same meeting. When a user reports "I can't see anyone's video," you need to find their join event, check whether their producers were created, see if consumers were created for other participants, and determine whether the SFU router was healthy. With free-form text logs, this requires manual grep and mental correlation across hundreds of log lines. With structured JSON logs, it is a query: `meetingCode=abc-defg-hij AND event=produce | sort by timestamp`.

**How it works here:** Pino is configured with `pino-http` for request-level logging with correlation IDs. Meeting lifecycle events (created, started, ended) are logged with meeting code and host user. SFU operations (router created, transport created, producer/consumer lifecycle) are logged with participant context. Participant join/leave events include timestamps and media state (muted, video on, screen sharing). In development, Pino outputs human-readable colored text; in production, it outputs JSON for ingestion by log aggregation systems.

**File:** `backend/src/services/logger.ts`

### Prometheus Metrics

**What it is:** Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose an HTTP endpoint (`/metrics`) with metric values in a text format. Prometheus scrapes this endpoint and stores the time-series data for visualization and alerting.

**Why it matters:** Video conferencing has specific operational metrics that are critical for capacity planning and incident response. "How many meetings are active right now?" determines whether to scale up SFU workers. "How many participants are connected?" determines WebSocket server load. "What is the API latency by route?" identifies slow endpoints before users complain. Without metrics, these questions require manual investigation during incidents, when response time is most critical.

**How it works here:** Four custom metrics are defined. `active_meetings_total` (Gauge) tracks the number of meetings in "active" status -- used for SFU worker capacity planning. `active_participants_total` (Gauge) tracks the total connected participant count. `websocket_connections_total` (Gauge) tracks active WebSocket connections for load balancer tuning. `http_request_duration_seconds` (Histogram with method, route, and status labels) records API latency for SLI dashboards. Default Node.js metrics (CPU, memory, event loop lag, GC pause duration) are collected automatically via `collectDefaultMetrics()`.

**File:** `backend/src/services/metrics.ts`

### Health Checks

**What it is:** Health checks are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers, container orchestrators, and monitoring dashboards to detect and respond to failures.

**Why it matters:** A video conferencing server depends on PostgreSQL (meeting persistence) and Redis (sessions, participant state). If PostgreSQL fails, the server cannot create new meetings but active meetings continue. If Redis fails, sessions are lost but in-memory meeting state is preserved. Health checks enable automated systems to make nuanced decisions: remove an instance from the load balancer when PostgreSQL is down (cannot serve new meeting requests) but do not restart it (active meetings are still functional).

**How it works here:** A single comprehensive endpoint `GET /api/health` returns server status, current timestamp, PostgreSQL pool health (active, idle, and waiting connection counts), and Redis connectivity (ping response). This endpoint is used both by external monitoring and by the frontend to display server status.

### Idempotency

**What it is:** Idempotency means that performing the same operation multiple times produces the same result as performing it once. In distributed systems, network failures cause retries: a client sends a request, the server processes it, but the response is lost. The client retries, and without idempotency, the operation executes twice.

**Why it matters:** Meeting creation is the most important idempotent operation. If a user clicks "New Meeting" and the network drops the response, their client retries. Without idempotency, two meetings are created with different codes, and the user sees a confusing duplicate in their meeting list. Similarly, the meeting code UNIQUE constraint in PostgreSQL provides a secondary safeguard -- but relying on database errors for flow control is fragile and produces poor error messages.

**How it works here:** Meeting creation requests include an `Idempotency-Key` header (a client-generated UUID). The server stores the completed request outcome in Redis keyed by this value with a 24-hour TTL. If a duplicate request arrives, the server returns the previously created meeting without executing any database operations. The meeting code itself provides a secondary deduplication layer via the UNIQUE database constraint. For WebSocket signaling, participant state updates (mute, video toggle, hand raise) use last-writer-wins semantics and are inherently idempotent -- receiving "user X is muted" twice produces the same state as receiving it once. Chat messages use client-generated message IDs checked against a Redis set to prevent duplicate insertion.

### RBAC (Role-Based Access Control)

**What it is:** RBAC is an authorization model where permissions are assigned to roles rather than to individual users. Each user is assigned a role, and the role determines what actions they can perform.

**Why it matters:** In a video conferencing system, different participants have different capabilities within the same meeting. The host can end the meeting, mute other participants, create breakout rooms, and manage settings. Co-hosts share some of these capabilities. Regular participants can only control their own media state. Without RBAC, these permission checks would be ad-hoc conditional statements throughout the WebSocket handler, making them difficult to audit and easy to bypass.

**How it works here:** Three meeting roles are defined: `host` (full control: end meeting, mute all, create/manage breakout rooms, change settings), `co-host` (can mute others and manage breakout rooms but cannot end the meeting), and `participant` (can only control own audio, video, screen share, hand raise, and send chat messages). The role is stored in the `meeting_participants.role` column and checked in the WebSocket message handler before executing privileged operations. The meeting creator is automatically assigned the `host` role. Role checks also gate the breakout room UI in the frontend -- only hosts see the breakout room management panel.

### Redis Cache-Aside

**What it is:** Cache-aside (also called "lazy loading") is a caching strategy where the application checks a fast in-memory cache before querying a slower persistent store. On a cache miss, the application queries the database, stores the result in the cache, and returns it. On a cache hit, the database is skipped entirely.

**Why it matters:** In a video conferencing system, session validation happens on every HTTP request and every WebSocket connection upgrade. With 800,000 concurrent participants, each making signaling requests, validating sessions against PostgreSQL would require hundreds of thousands of queries per second. Redis serves session lookups in sub-millisecond time from memory, reducing database load by orders of magnitude.

**How it works here:** Redis is used as both the session store (via `connect-redis` with `ioredis`) and the primary store for transient meeting state. Sessions are stored in Redis with automatic expiration, and PostgreSQL is not involved in session validation at all. For the WebSocket reconnection buffer, the server stores the last 60 seconds of state changes per meeting in Redis. When a participant reconnects, the server replays missed events from this buffer rather than recomputing state from PostgreSQL.

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
│  :3000        │
│               │
│  ┌──────────┐ │
│  │Simulated │ │
│  │SFU       │ │
│  │Service   │ │
│  └──────────┘ │
└───────────────┘
```

### Production-Grade Patterns Implemented

**Simulated SFU service** (`backend/src/services/sfuService.ts`): Models the complete mediasoup architecture (Workers, Routers, WebRtcTransports, Producers, Consumers) in memory without requiring the native C++ mediasoup module. The signaling protocol is implemented correctly — the same WebSocket messages a real mediasoup application would exchange. Router creation per meeting room, send/recv transport per participant, producer registration on media share, consumer creation for each subscriber, and cleanup on leave/disconnect are all functional. Only the actual SRTP packet forwarding is simulated (logged but not executed).

**Full WebSocket signaling protocol** (`backend/src/websocket/handler.ts`): Complete message protocol for WebRTC negotiation with 11 message types. Handles join-meeting, produce, consume, producer-close, participant-update, and chat-message flows. Participant state (mute, video, screen share, hand raise) is synchronized to all meeting participants in real-time.

**Structured logging** (`backend/src/services/logger.ts`): Pino with JSON output, request-level correlation via pino-http. Meeting lifecycle events, SFU operations, and participant state changes are logged with structured metadata for debugging.

**Prometheus metrics** (`backend/src/services/metrics.ts`): Four custom metrics — active meetings gauge, active participants gauge, WebSocket connections gauge, and HTTP request duration histogram with method/route/status labels. Default Node.js metrics collected automatically.

**Circuit breaker** (`backend/src/services/circuitBreaker.ts`): Opossum wrapping database calls with 50% error threshold and 30-second reset. Prevents cascade failures when PostgreSQL is unavailable while keeping WebSocket signaling operational.

**Rate limiting** (`backend/src/services/rateLimiter.ts`): Two tiers — auth endpoints (20/15min) and general API (100/15min). Uses express-rate-limit with Redis store via rate-limit-redis for cross-instance consistency.

**Session auth** (`backend/src/middleware/auth.ts`): Redis-backed sessions via connect-redis with ioredis client. HttpOnly cookies, bcrypt password hashing, middleware guards for authenticated routes.

**Breakout rooms** (`backend/src/services/breakoutService.ts`): Full CRUD for breakout rooms with participant assignment, activation, and closure. Creates separate SFU routers per breakout room.

**Meeting service** (`backend/src/services/meetingService.ts`): Meeting CRUD with code generation (`abc-defg-hij` format), lifecycle management (scheduled → active → ended), and participant tracking.

**Chat service** (`backend/src/services/chatService.ts`): PostgreSQL-backed chat with broadcast and DM support, retrieved as paginated history.

### What Was Simplified or Substituted

| Production Component | Local Substitute | Impact |
|---------------------|-----------------|--------|
| mediasoup C++ SFU | In-memory simulation | Signaling works; no actual media forwarding |
| Media streams between peers | Local camera preview only | Video grid shows placeholders for remote streams |
| STUN/TURN servers | None | WebRTC connections not established |
| OAuth 2.0 / SSO | Session auth with bcrypt | Functional but not production-grade |
| Redis Cluster | Single Valkey instance | No failover, no sharding |
| L7 load balancer | Direct connection | Single server only |
| Waiting room enforcement | Settings flag only | Join is always allowed |
| Recording pipeline | Database schema only | No capture, transcode, or storage |
| WebSocket auth | Query parameters (userId, username) | No session validation on WS connect |

### What Was Omitted

- **CDN** for static assets
- **End-to-end encryption (E2EE)** for media via Insertable Streams
- **Kubernetes orchestration** for SFU worker scaling
- **Recording pipeline** (capture, transcode, store to object storage)
- **Virtual backgrounds / noise cancellation** (ML processing)
- **TURN/STUN server infrastructure**
- **Multi-region deployment** with geo-routing for lowest-latency SFU selection
- **Simulcast / SVC** encoding on the client
- **Bandwidth estimation** (REMB/TWCC) for adaptive quality
- **Dominant speaker detection** for auto-pinning active speaker

# System Design: Video Conferencing (Full-Stack)

## 🎯 1. Requirements Clarification

> "We're building a Zoom-like video conferencing platform. Let me cover the full stack: SFU media routing, WebSocket signaling, meeting management, and the frontend video grid with device management."

**Functional Requirements:**
- Multi-party video calls (2-100 participants)
- Meeting creation, scheduling, join by human-readable code
- Audio/video toggle, screen sharing, hand raise
- In-call chat (broadcast + DM)
- Breakout rooms
- Meeting lobby with camera/mic preview

**Non-Functional Requirements:**
- Video latency < 150ms (same region)
- Signaling latency < 50ms (p99)
- 100K concurrent meetings, 800K concurrent participants
- 99.99% availability

---

## 🏗️ 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Client (Browser)                                            │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ Video Grid │  │ Control Bar  │  │ Chat / Participants│   │
│  │ (CSS Grid) │  │ (toggles)    │  │ (side panels)     │   │
│  └─────┬──────┘  └──────┬───────┘  └────────┬──────────┘   │
│        │                │                    │               │
│  ┌─────┴────────────────┴────────────────────┴──────────┐   │
│  │  State Layer: AuthStore + MeetingStore + MediaStore   │   │
│  └─────┬────────────────┬────────────────────┬──────────┘   │
│        │                │                    │               │
│  ┌─────┴──────┐  ┌──────┴───────┐  ┌────────┴──────────┐   │
│  │ REST Client│  │  WS Client   │  │ useMediaDevices   │   │
│  │ (fetch)    │  │ (signaling)  │  │ (getUserMedia)    │   │
│  └─────┬──────┘  └──────┬───────┘  └───────────────────┘   │
└────────┼────────────────┼────────────────────────────────────┘
         │                │
         ▼                ▼
┌─────────────────────────────────────────────────────────────┐
│  Backend                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐ │
│  │  REST API    │  │  WS Handler   │  │   SFU Service    │ │
│  │  (Express)   │  │  (signaling)  │  │   (mediasoup)    │ │
│  │  /auth       │  │  join/leave   │  │   Workers        │ │
│  │  /meetings   │  │  produce      │  │   Routers        │ │
│  │  /chat       │  │  consume      │  │   Transports     │ │
│  │  /rooms      │  │  state sync   │  │   Producers      │ │
│  └──────┬───────┘  └───────┬───────┘  │   Consumers      │ │
│         │                  │          └──────────────────┘ │
│         ▼                  ▼                                │
│  ┌──────────┐       ┌──────────┐                           │
│  │PostgreSQL│       │  Redis   │                           │
│  │(persist) │       │(sessions,│                           │
│  └──────────┘       │ pub/sub) │                           │
│                     └──────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 3. SFU Architecture (Backend Core)

> "The SFU is the heart of the system. Let me explain why SFU over P2P or MCU."

### Media Architecture Comparison

| Approach | Pros | Cons |
|----------|------|------|
| **SFU (chosen)** | O(N) server connections, individual stream control, moderate CPU | Server SRTP overhead, O(N) client download |
| **P2P Mesh** | No server, lowest latency for 2 users | O(N^2) connections, breaks at 5+ participants |
| **MCU** | Lowest client bandwidth | Transcoding cost, no individual stream control |

> "P2P mesh fails at scale because bandwidth grows quadratically. With 8 participants, each uploads 7 streams (14 Mbps at 2 Mbps/stream). Home connections can't sustain this. SFU keeps upload at 1 stream per participant. The trade-off: we now need server CPU for SRTP encryption and forwarding, but this is linear and predictable — about 500 participants per CPU core."

### mediasoup Model

```
Node.js Process
├── Worker 1 (CPU core)
│   ├── Router A (Meeting "abc-defg-hij")
│   │   ├── Participant 1: SendTransport + RecvTransport
│   │   │   ├── Producer(audio), Producer(video)
│   │   │   └── Consumer(P2.audio), Consumer(P2.video), ...
│   │   └── Participant 2: SendTransport + RecvTransport
│   │       ├── Producer(audio), Producer(video)
│   │       └── Consumer(P1.audio), Consumer(P1.video), ...
│   └── Router B (Meeting "xyz-abcd-efg")
│       └── ...
└── Worker 2 (CPU core)
    └── ...
```

---

## 🔌 4. Signaling Protocol (Full-Stack)

### WebRTC Connection Flow

```
Client                    Server                      SFU
  │                         │                          │
  │──REST: getMeetingByCode─▶│                          │
  │◀─meeting data────────────│                          │
  │                         │                          │
  │──WS: connect────────────▶│                          │
  │──WS: join-meeting───────▶│──create Router──────────▶│
  │                         │◀─RTP capabilities────────│
  │                         │──create Transports───────▶│
  │◀─WS: joined             │◀─Transport options───────│
  │  (participants,         │                          │
  │   capabilities,         │                          │
  │   transports,           │                          │
  │   existing producers)   │                          │
  │                         │                          │
  │──WS: produce (audio)───▶│──create Producer─────────▶│
  │◀─WS: produced──────────│◀─Producer created─────────│
  │                         │                          │
  │  [broadcast to others]  │                          │
  │  WS: new-producer──────▶│                          │
  │                         │                          │
  │──WS: consume (prodId)──▶│──create Consumer─────────▶│
  │◀─WS: consume-response──│◀─Consumer created─────────│
```

### Message Types (12 client→server, 9 server→client)

**Client to Server:**
- `join-meeting`, `leave-meeting`
- `produce`, `consume`, `producer-close`
- `toggle-mute`, `toggle-video`, `start-screen-share`, `stop-screen-share`
- `raise-hand`, `chat-message`

**Server to Client:**
- `joined`, `left`
- `participant-joined`, `participant-left`, `participant-update`
- `produced`, `new-producer`, `producer-closed`, `consume-response`
- `chat-message`, `breakout-started`, `breakout-ended`

---

## 💾 5. Data Model

```
┌──────────┐     ┌──────────────┐     ┌────────────────┐
│  users   │     │   meetings   │     │ participants   │
│──────────│     │──────────────│     │────────────────│
│ id (PK)  │◀────│ host_id (FK) │     │ meeting_id(FK) │
│ username │     │ meeting_code │◀────│ user_id (FK)   │
│ email    │     │ title        │     │ display_name   │
│ pass_hash│     │ status       │     │ role           │
│ display  │     │ settings     │     │ is_muted       │
│          │     │ sched_start  │     │ is_video_on    │
│          │     │ actual_start │     │ is_screen_share│
│          │     │ actual_end   │     │ is_hand_raised │
└──────────┘     └──────────────┘     │ joined_at      │
                                      │ left_at        │
                                      └────────────────┘

┌──────────────┐     ┌──────────────┐
│breakout_rooms│     │ chat_msgs    │
│──────────────│     │──────────────│
│ meeting_id   │     │ meeting_id   │
│ name         │     │ sender_id    │
│ is_active    │     │ content      │
│              │     │ recipient_id │
└──────────────┘     │ created_at   │
                     └──────────────┘
```

**Meeting codes**: `abc-defg-hij` format (3-4-3 lowercase letters). Human-readable and verbally communicable, unlike UUIDs.

---

## 🎥 6. Frontend: Video Grid

> "The video grid is the most performance-sensitive frontend component."

### Dynamic Grid Layout

```
1 participant: ┌──────────────────┐
               │     Full Screen  │
               └──────────────────┘

2 participants: ┌────────┬────────┐
                │  Alice │  Bob   │
                └────────┴────────┘

4 participants: ┌────────┬────────┐
                │  Alice │  Bob   │
                ├────────┼────────┤
                │ Charlie│ Diana  │
                └────────┴────────┘

Screen share:   ┌──────────────┬────┐
                │              │ A  │
                │  Screen      ├────┤
                │  Content     │ B  │
                │  (75%)       ├────┤
                │              │ C  │
                └──────────────┴────┘
```

**Implementation: CSS Grid with dynamic classes**

| Count | CSS Grid Template |
|-------|------------------|
| 1 | `grid-cols-1 grid-rows-1` |
| 2 | `grid-cols-2 grid-rows-1` |
| 3-4 | `grid-cols-2 grid-rows-2` |
| 5-6 | `grid-cols-3 grid-rows-2` |
| 7-9 | `grid-cols-3 grid-rows-3` |
| 10-16 | `grid-cols-4 grid-rows-4` |
| 17+ | `grid-cols-5 auto-rows-fr` (scrollable) |

> "I use CSS Grid instead of JavaScript-calculated layouts because Grid natively handles the responsive sizing and gap management. Adding a participant just means changing the grid class — no re-measuring or reflowing. The trade-off: less control over exact tile aspect ratios, but CSS `aspect-ratio` or `object-fit: cover` on video elements handles this well enough."

---

## 🚪 7. Frontend: Meeting Lobby

```
┌─────────────────────────────────────┐
│        Weekly Team Standup          │
│        abc-defg-hij                 │
│                                     │
│  ┌───────────────────────────────┐  │
│  │                               │  │
│  │    Camera Preview             │  │
│  │    (mirrored local video)     │  │
│  │                               │  │
│  │     [Mic]  [Cam]              │  │
│  └───────────────────────────────┘  │
│                                     │
│  Camera: [Built-in FaceTime HD ▼]   │
│  Mic:    [Built-in Microphone  ▼]   │
│                                     │
│  Name:   [Alice Johnson        ]    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │        Join Meeting          │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

### useMediaDevices Hook

**Responsibilities:**
1. `enumerateDevices()` — List cameras, mics, speakers
2. `getUserMedia()` — Request stream with device constraints
3. `toggleMute()` — Toggle audio track.enabled (no re-negotiation)
4. `toggleVideo()` — Toggle video track.enabled
5. `selectCamera(deviceId)` — Create new stream with specific camera
6. `selectMic(deviceId)` — Create new stream with specific mic
7. Listen for `devicechange` events (plug/unplug)

> "Toggling mute/video uses `track.enabled = false` instead of stopping the track. This is critical because stopping a track requires re-negotiating the WebRTC connection, which takes 200-500ms and causes a visual flicker. Setting enabled=false keeps the track alive but sends silence/black frames — the toggle is instant from the user's perspective."

---

## 🗂️ 8. State Architecture

### Three Zustand Stores

```
AuthStore (rarely changes)
├── user: { id, username, displayName }
├── login(), logout(), checkAuth()

MeetingStore (changes per participant action)
├── meeting: { id, code, title, hostId, status, settings }
├── participants: Participant[]
├── chatMessages: ChatMessage[]
├── breakoutRooms: BreakoutRoom[]
├── isChatOpen, isParticipantListOpen
├── screenSharingUserId
├── addParticipant(), removeParticipant(), updateParticipant()

MediaStore (changes per local toggle)
├── localStream, isMuted, isVideoOn
├── isScreenSharing, isHandRaised
├── selectedCamera, selectedMic
├── setIsMuted(), setIsVideoOn(), reset()
```

> "Splitting state into three stores is a deliberate performance optimization. When Alice mutes herself, only the ControlBar and Alice's VideoTile re-render — not the entire VideoGrid or ChatPanel. Zustand's selector subscriptions make this automatic: `useMediaStore(s => s.isMuted)` only triggers when isMuted changes."

---

## 🌐 9. API Design

### REST Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/login` | No | Sign in, create session |
| POST | `/api/auth/logout` | Yes | Destroy session |
| GET | `/api/auth/me` | Yes | Current user |
| POST | `/api/meetings` | Yes | Create meeting (returns code) |
| GET | `/api/meetings` | Yes | List user's meetings |
| GET | `/api/meetings/code/:code` | Yes | Get by code |
| POST | `/api/meetings/:id/start` | Yes (host) | Set status=active |
| POST | `/api/meetings/:id/end` | Yes (host) | Set status=ended |
| GET | `/api/chat/:id/messages` | Yes | Chat history |

### WebSocket Endpoint

`ws://host/ws`, authenticated by the session cookie on the upgrade (plus an Origin allowlist), never by a user id the client sends.

All real-time communication (signaling, participant state, host controls, chat) flows through this single WebSocket connection. The server keeps live meeting state in process: who is admitted, who waits, each person's role and media state. It runs every policy check there synchronously (capacity, one presenter, rank-based host actions), then writes through to PostgreSQL in order.

---

## 🏠 10. Breakout Rooms (Full-Stack)

### Backend Flow

```
Host: POST /api/rooms/:meetingId/breakout-rooms
  → Creates breakout_rooms rows in DB

Host: POST /api/rooms/:meetingId/breakout-rooms/activate
  → Sets is_active=true for all rooms
  → Server creates new SFU Router per room
  → Broadcasts breakout-started to all participants
  → Assigned participants switch to breakout Router

Host: POST /api/rooms/:meetingId/breakout-rooms/close
  → Sets is_active=false, deletes assignments
  → Broadcasts breakout-ended
  → Participants switch back to main Router
```

### Frontend Flow

```
┌─────────────────────────┐
│ Breakout Rooms (Host)   │
│                         │
│ Number of rooms: [3]    │
│ [Create Rooms]          │
│                         │
│ Room 1: "Breakout 1"    │
│   0 participants        │
│                         │
│ Room 2: "Breakout 2"    │
│   0 participants        │
│                         │
│ Room 3: "Breakout 3"    │
│   0 participants        │
│                         │
│ [Open All] [Close All]  │
└─────────────────────────┘
```

> "The architectural challenge with breakout rooms is that each room needs its own SFU Router for media isolation. When a participant moves between rooms, their WebRTC transports must be torn down and re-established — causing a 1-2 second interruption. This is acceptable because room transitions are infrequent and user-initiated. The alternative (single Router with server-side filtering) would avoid the interruption but leaks audio between rooms if the filtering has bugs — unacceptable for privacy."

---

## 📈 11. Scaling Strategy

### SFU Horizontal Scaling

```
┌──────────────────────┐
│   SFU Controller     │  ◄── Routes meetings to servers
│ (consistent hashing) │      by meeting_code hash
└──────────┬───────────┘
           │
   ┌───────┼───────┐
   ▼       ▼       ▼
┌──────┐┌──────┐┌──────┐
│Srv 1 ││Srv 2 ││Srv N │   ◄── Each server: 8 cores = 8 Workers
│8 core││8 core││8 core│       ~4,000 concurrent participants
└──────┘└──────┘└──────┘
```

### Bandwidth Optimization: Simulcast

| Without Simulcast | With Simulcast |
|-------------------|----------------|
| Client sends 1 stream (720p, 2Mbps) | Client sends 3 layers (180p/360p/720p) |
| SFU forwards 720p to all viewers | SFU selects layer based on tile size |
| 25 viewers = 50 Mbps server egress | 25 viewers = ~10 Mbps (mostly low layer) |

> "Simulcast is the most impactful optimization. In a 25-person meeting, the active speaker gets high quality (720p) while the other 24 small tiles receive low quality (180p at ~100kbps). This reduces per-participant download from 48 Mbps to ~5 Mbps."

---

## ⚖️ 12. Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Media routing | SFU | P2P / MCU | O(N) connections, individual stream control |
| Signaling | WebSocket | HTTP polling | Sub-second negotiation required |
| State mgmt | Zustand (3 stores) | Redux / single store | Selective subscriptions prevent cascade re-renders |
| Grid layout | CSS Grid | JS calculations | Native responsive, no re-measuring |
| Meeting code | `abc-defg-hij` | UUID / numeric | Human-readable, verbally communicable |
| Video mirror | CSS scaleX(-1) local only | No mirroring | Natural self-view experience |
| Track toggle | track.enabled | Stop/restart track | Instant toggle, no re-negotiation |
| Breakout rooms | Separate Routers | Single Router + filter | True audio/video isolation |
| Session auth | Redis + cookie | JWT | Immediate revocation, simpler |
| Chat delivery | In-band WebSocket | Separate service | Already connected for signaling |

---

## 📡 13. Monitoring and Reliability

### Backend Observability
- **Metrics**: Active meetings, participants, WebSocket connections, HTTP latency
- **Logging**: Structured JSON (Pino) with meeting/user correlation
- **Health**: `/api/health` endpoint, PostgreSQL + Redis checks
- **Circuit breaker**: Database calls wrapped with Opossum (50% threshold, 30s reset)

### Frontend Resilience
- **WebSocket reconnection**: Exponential backoff (1s, 2s, 4s...), auto-rejoin meeting; the server holds the seat and role for 10s, so a blip doesn't announce a leave
- **Device fallback**: If camera fails, join audio-only with avatar
- **Optimistic UI**: Control toggles update instantly, server sync is fire-and-forget
- **Graceful degradation**: If WebSocket disconnects, existing media continues (media plane is independent)

> "The most important reliability insight for video conferencing: the media plane and control plane are decoupled. Once WebRTC media flows are established between client and SFU, they survive signaling server failures. Participants already in a call keep talking even if the WebSocket server goes down. Only new joins and state changes are affected."

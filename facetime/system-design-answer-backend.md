# FaceTime - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## Opening Statement (2 minutes)

"Today I'll design FaceTime, Apple's real-time video calling system, from a backend perspective. The key backend challenges are implementing a scalable signaling server for call setup, handling NAT traversal with STUN/TURN infrastructure, building an SFU (Selective Forwarding Unit) for group calls that scales beyond peer-to-peer mesh topology, and ensuring end-to-end encryption while still enabling server-assisted routing. I'll focus on the WebRTC signaling protocol, ICE candidate exchange, and call state management."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **1:1 Calls**: Video and audio calls between two devices
2. **Group Calls**: Multi-party video calls (up to 32 participants)
3. **Multi-Device Ring**: Incoming calls ring on all user devices
4. **Device Handoff**: Transfer active call between devices
5. **Call History**: Persist call records for later retrieval

### Non-Functional Requirements

- **Latency**: < 150ms end-to-end for real-time communication
- **Availability**: 99.9% for signaling infrastructure
- **Scale**: Millions of concurrent calls globally
- **Security**: End-to-end encryption for all media

### Backend-Specific Concerns

| Component | Responsibility | Scale |
|-----------|----------------|-------|
| Signaling Server | Call setup, SDP exchange | 100K+ concurrent WebSockets |
| STUN Server | NAT mapping, public IP discovery | Stateless, horizontally scalable |
| TURN Server | Media relay for symmetric NAT | Bandwidth-intensive |
| SFU | Group call forwarding | 10K+ concurrent rooms |
| Database | Call history, user devices | ACID for call state |

---

## Step 2: High-Level Architecture (5 minutes)

### Backend Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Client Devices                             │
│              iPhone | iPad | Mac | Apple Watch                  │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
┌───────────────────┐ ┌───────────────┐ ┌───────────────┐
│  Signaling Server │ │  STUN Server  │ │  TURN Server  │
│  (WebSocket)      │ │               │ │               │
│  - Call setup     │ │ - NAT mapping │ │ - Media relay │
│  - SDP exchange   │ │ - ICE cands   │ │ - Fallback    │
│  - Device registry│ │               │ │               │
└───────────────────┘ └───────────────┘ └───────────────┘
         │                                      │
         ▼                                      │
┌───────────────────┐                          │
│   SFU Cluster     │◄─────────────────────────┘
│                   │    (Group calls only)
│ - Media forwarding│
│ - Dominant speaker│
│ - Quality layers  │
└───────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
├─────────────────────┬───────────────────────────────────────────┤
│     PostgreSQL      │              Redis/Valkey                 │
│  - Users            │  - User presence (60s TTL)                │
│  - Devices          │  - Active call state                      │
│  - Call history     │  - Idempotency keys                       │
│                     │  - TURN credentials                       │
└─────────────────────┴───────────────────────────────────────────┘
```

---

## Step 3: Signaling Server Deep Dive (10 minutes)

### WebSocket Connection Management

The signaling server maintains WebSocket connections for all active devices and tracks which devices belong to each user.

```
┌─────────────────────────────────────────────────────────────────┐
│                    SignalingServer Class                        │
├─────────────────────────────────────────────────────────────────┤
│  In-Memory State:                                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ devices: Map<deviceId, ConnectedDevice>                  │  │
│  │   └──▶ { ws, userId, deviceId, lastPing }               │  │
│  │                                                          │  │
│  │ userDevices: Map<userId, Set<deviceId>>                 │  │
│  │   └──▶ Track all devices per user                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Message Handlers:                                              │
│  ┌──────────────────┬───────────────────────────────────────┐  │
│  │ register         │ Device joins, update presence         │  │
│  │ call_initiate    │ Start call, ring callees              │  │
│  │ call_answer      │ Accept call, race condition handling  │  │
│  │ call_decline     │ Reject call                           │  │
│  │ ice_candidate    │ Forward ICE to peers                  │  │
│  │ call_end         │ Terminate call, cleanup               │  │
│  └──────────────────┴───────────────────────────────────────┘  │
│                                                                 │
│  Cleanup: 30s interval removes stale connections               │
└─────────────────────────────────────────────────────────────────┘
```

### Device Registration Flow

```
┌────────┐     register      ┌────────────────┐     SET presence     ┌───────┐
│ Device │ ──────────────▶  │ Signaling      │ ─────────────────▶  │ Redis │
│        │                   │ Server         │                      │       │
└────────┘                   └────────────────┘                      └───────┘
                                    │
                                    │ UPSERT device
                                    ▼
                             ┌────────────────┐
                             │  PostgreSQL    │
                             │  user_devices  │
                             └────────────────┘
                                    │
                                    │ registered ack
                                    ▼
                             ┌────────────────┐
                             │ Device         │
                             └────────────────┘
```

**Presence Storage:**
- Redis hash: `presence:{userId}` with status and lastSeen
- Redis set: `presence:{userId}:devices` for all connected devices
- 60-second TTL with refresh on heartbeat

### Call Initiation with Idempotency

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Call Initiation Flow                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Check Idempotency                                                        │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ Redis GET idempotency:call:{key}                                    │ │
│     │   ├──▶ exists: return cached callId (deduplicated: true)           │ │
│     │   └──▶ not exists: continue with new call                          │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  2. Create Call (Transaction)                                                │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ BEGIN                                                               │ │
│     │   INSERT INTO calls (id, initiator_id, call_type, state='ringing') │ │
│     │   INSERT INTO call_participants (call_id, user_id, state='ringing')│ │
│     │ COMMIT                                                              │ │
│     │                                                                     │ │
│     │ On error: ROLLBACK + delete idempotency key                        │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  3. Store Active Call in Redis                                               │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ HSET call:{callId}                                                  │ │
│     │   initiator: userId                                                 │ │
│     │   callType: video|audio                                             │ │
│     │   state: ringing                                                    │ │
│     │   createdAt: timestamp                                              │ │
│     │ EXPIRE call:{callId} 1800  (30 min TTL)                            │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  4. Ring All Callee Devices                                                  │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ For each callee:                                                    │ │
│     │   For each connected device:                                        │ │
│     │     WebSocket.send({ type: 'incoming_call', callId, caller })      │ │
│     │   Send push notification for offline devices                        │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  5. Set Ring Timeout: 30 seconds                                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Call Answer with Race Condition Handling

> "When multiple devices try to answer, only the first one wins. We use PostgreSQL's `FOR UPDATE SKIP LOCKED` to atomically claim the call."

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Atomic Answer (First Device Wins)                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  SQL Query:                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ WITH locked_call AS (                                                   ││
│  │   SELECT id, state, initiator_id FROM calls                            ││
│  │   WHERE id = $callId                                                    ││
│  │   FOR UPDATE SKIP LOCKED  ◄── Prevents race conditions                 ││
│  │ )                                                                       ││
│  │ UPDATE calls                                                            ││
│  │ SET state = 'connected',                                                ││
│  │     answered_by_device = $deviceId,                                     ││
│  │     connected_at = NOW()                                                ││
│  │ FROM locked_call                                                        ││
│  │ WHERE calls.id = locked_call.id                                         ││
│  │   AND locked_call.state = 'ringing'                                     ││
│  │ RETURNING calls.*, locked_call.initiator_id                             ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Result Handling:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ rowCount = 0:                                                           ││
│  │   ├──▶ state = 'connected': already_answered (tell device who won)    ││
│  │   └──▶ else: call_not_found                                            ││
│  │                                                                         ││
│  │ rowCount = 1:                                                           ││
│  │   ├──▶ Update Redis call state                                         ││
│  │   ├──▶ Stop ringing on other devices                                   ││
│  │   ├──▶ Send SDP answer to caller                                       ││
│  │   └──▶ Confirm call_connected to answerer                              ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 4: ICE Candidate Exchange (8 minutes)

### ICE Candidate Handling with Deduplication

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     ICE Candidate Flow                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────┐  ice_candidate   ┌──────────────┐                               │
│  │ Device │ ───────────────▶ │  Signaling   │                               │
│  │   A    │                   │   Server     │                               │
│  └────────┘                   └──────┬───────┘                               │
│                                      │                                       │
│                                      ▼                                       │
│                         ┌────────────────────────────┐                       │
│                         │ Generate Candidate Hash    │                       │
│                         │ SHA256(callId:deviceId:    │                       │
│                         │        candidate).slice(16)│                       │
│                         └────────────────────────────┘                       │
│                                      │                                       │
│                                      ▼                                       │
│                         ┌────────────────────────────┐                       │
│                         │ SETNX ice:{callId}:{hash}  │                       │
│                         │   └──▶ returns 0: duplicate│──▶ ignore            │
│                         │   └──▶ returns 1: new     │                       │
│                         └────────────────────────────┘                       │
│                                      │                                       │
│                                      ▼                                       │
│                         ┌────────────────────────────┐                       │
│                         │ Forward to All Peers       │                       │
│                         │   - Query call_participants│                       │
│                         │   - Send to connected      │                       │
│                         │     devices via WebSocket  │                       │
│                         └────────────────────────────┘                       │
│                                      │                                       │
│                                      ▼                                       │
│  ┌────────┐  ice_candidate   ┌──────────────┐                               │
│  │ Device │ ◀─────────────── │   Signaling  │                               │
│  │   B    │                   │   Server     │                               │
│  └────────┘                   └──────────────┘                               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### TURN Credential Service

> "TURN credentials are short-lived (5 minutes) for security. We use RFC 5389 time-limited credentials with HMAC-SHA1."

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     TURN Credential Generation                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Credential Format (RFC 5389):                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ username = {expiry_timestamp}:{userId}                                  ││
│  │            │                                                            ││
│  │            └──▶ Unix timestamp when credential expires                  ││
│  │                                                                         ││
│  │ credential = HMAC-SHA1(TURN_SECRET, username).base64()                  ││
│  │                                                                         ││
│  │ TTL = 300 seconds (5 minutes)                                           ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Response:                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ {                                                                       ││
│  │   username: "1674567890:user123",                                       ││
│  │   credential: "abc123...",                                              ││
│  │   urls: [                                                               ││
│  │     "turn:turn.example.com:3478?transport=udp",                         ││
│  │     "turn:turn.example.com:3478?transport=tcp",                         ││
│  │     "turns:turn.example.com:5349?transport=tcp"  (TLS)                  ││
│  │   ],                                                                    ││
│  │   ttl: 300                                                              ││
│  │ }                                                                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Caching:                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Redis SETEX turn:{userId} (TTL - 30) credentials                        ││
│  │                     │                                                   ││
│  │                     └──▶ Cache slightly shorter than validity          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### ICE Server Configuration Endpoint

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     GET /api/ice-servers                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Response:                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ {                                                                       ││
│  │   iceServers: [                                                         ││
│  │     // STUN (no auth needed)                                            ││
│  │     { urls: 'stun:stun.l.google.com:19302' },                          ││
│  │     { urls: 'stun:stun1.l.google.com:19302' },                         ││
│  │                                                                         ││
│  │     // TURN (with short-lived credentials)                              ││
│  │     {                                                                   ││
│  │       urls: ['turn:...', 'turns:...'],                                 ││
│  │       username: 'timestamp:userId',                                     ││
│  │       credential: 'hmac-sha1-signature'                                 ││
│  │     }                                                                   ││
│  │   ],                                                                    ││
│  │   iceTransportPolicy: 'all',  // or 'relay' to force TURN              ││
│  │   ttl: 300                                                              ││
│  │ }                                                                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 5: SFU for Group Calls (8 minutes)

### SFU Architecture

> "For group calls, mesh topology doesn't scale - with 5 participants, each sends 4 streams. The SFU acts as a central hub: each participant sends one stream up, and the SFU selectively forwards to others."

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     SFU (Selective Forwarding Unit)                           │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Room Structure:                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Room {                                                                  ││
│  │   id: string                                                            ││
│  │   participants: Map<userId, Participant>                                ││
│  │   dominantSpeaker: string | null                                        ││
│  │   createdAt: number                                                     ││
│  │ }                                                                       ││
│  │                                                                         ││
│  │ Participant {                                                           ││
│  │   userId: string                                                        ││
│  │   deviceId: string                                                      ││
│  │   peerConnection: RTCPeerConnection                                     ││
│  │   tracks: MediaStreamTrack[]                                            ││
│  │   audioLevel: number  (for speaker detection)                           ││
│  │ }                                                                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Media Flow:                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                                                                         ││
│  │   ┌─────────┐           ┌─────────┐           ┌─────────┐              ││
│  │   │ User A  │           │   SFU   │           │ User B  │              ││
│  │   └────┬────┘           └────┬────┘           └────┬────┘              ││
│  │        │                     │                     │                   ││
│  │        │  ──── video ────▶  │  ──── video ────▶  │                   ││
│  │        │                     │                     │                   ││
│  │        │  ◀──── video ────  │  ◀──── video ────  │                   ││
│  │        │                     │                     │                   ││
│  │   Each participant: 1 upload stream, N-1 download streams              ││
│  │                                                                         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Join Room Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     joinRoom(roomId, userId, deviceId, offer)                 │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Create/Get Room                                                          │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ if (!rooms.has(roomId))                                             │ │
│     │   rooms.set(roomId, new Room())                                     │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  2. Create Peer Connection for Participant                                   │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ pc = new RTCPeerConnection({ sdpSemantics: 'unified-plan' })        │ │
│     │                                                                     │ │
│     │ pc.ontrack = (event) => {                                           │ │
│     │   participant.tracks.push(event.track)                              │ │
│     │   forwardTrackToOtherParticipants(room, userId, event.track)        │ │
│     │ }                                                                   │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  3. Add Existing Tracks from Other Participants                              │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ for (otherParticipant of room.participants.values())                │ │
│     │   for (track of otherParticipant.tracks)                            │ │
│     │     pc.addTrack(track)                                              │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  4. Process SDP Offer/Answer                                                 │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ await pc.setRemoteDescription(offer)                                │ │
│     │ const answer = await pc.createAnswer()                              │ │
│     │ await pc.setLocalDescription(answer)                                │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  5. Store Participant & Notify Others                                        │
│     ┌─────────────────────────────────────────────────────────────────────┐ │
│     │ room.participants.set(userId, { userId, deviceId, pc, tracks: [] })│ │
│     │ notifyParticipantJoined(room, userId)                               │ │
│     └─────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Return: { answer, participants: [...room.participants.keys()] }             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Track Forwarding & Renegotiation

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Track Forwarding                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  When User A publishes a track:                                              │
│                                                                              │
│  ┌────────┐   track    ┌─────┐   addTrack    ┌────────┐                     │
│  │ User A │ ────────▶ │ SFU │ ─────────────▶ │ User B │                     │
│  └────────┘            │     │               │ PC     │                     │
│                        │     │               └────────┘                     │
│                        │     │   addTrack    ┌────────┐                     │
│                        │     │ ─────────────▶ │ User C │                     │
│                        └─────┘               │ PC     │                     │
│                                              └────────┘                     │
│                                                                              │
│  Renegotiation Required:                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 1. SFU creates new offer for affected participant                       ││
│  │ 2. Sends offer via signaling: { type: 'renegotiate', offer }            ││
│  │ 3. Client responds with answer                                          ││
│  │ 4. SFU applies answer                                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Dominant Speaker Detection

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Dominant Speaker Detection                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Algorithm:                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Interval: every 100ms                                                   ││
│  │                                                                         ││
│  │ 1. For each participant:                                                ││
│  │    - Get audio level from RTCPeerConnection stats                       ││
│  │    - Update rolling window (last 5 samples)                             ││
│  │                                                                         ││
│  │ 2. Calculate average audio level per participant                        ││
│  │                                                                         ││
│  │ 3. Find participant with:                                               ││
│  │    - Highest average level                                              ││
│  │    - Level > SILENCE_THRESHOLD (0.01)                                   ││
│  │                                                                         ││
│  │ 4. If dominant speaker changed:                                         ││
│  │    - Update room.dominantSpeaker                                        ││
│  │    - Broadcast to all: { type: 'dominant_speaker_changed', userId }     ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Audio Level Source:                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ pc.getStats() ──▶ find report where type='inbound-rtp' && kind='audio' ││
│  │              ──▶ report.audioLevel (0.0 to 1.0)                         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Smoothing:                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ audioLevelHistory: Map<userId, number[]>                                ││
│  │ SMOOTHING_WINDOW = 5 samples                                            ││
│  │ Average = sum(levels) / levels.length                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 6: Database Schema and Caching (5 minutes)

### PostgreSQL Schema

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Database Tables                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  users                                                                       │
│  ┌─────────────────┬──────────────────┬───────────────────────────────────┐ │
│  │ Column          │ Type             │ Notes                             │ │
│  ├─────────────────┼──────────────────┼───────────────────────────────────┤ │
│  │ id              │ UUID PK          │ gen_random_uuid()                 │ │
│  │ name            │ VARCHAR(100)     │ NOT NULL                          │ │
│  │ avatar_url      │ VARCHAR(500)     │                                   │ │
│  │ created_at      │ TIMESTAMP        │ DEFAULT NOW()                     │ │
│  └─────────────────┴──────────────────┴───────────────────────────────────┘ │
│                                                                              │
│  user_devices (for multi-device ring)                                        │
│  ┌─────────────────┬──────────────────┬───────────────────────────────────┐ │
│  │ Column          │ Type             │ Notes                             │ │
│  ├─────────────────┼──────────────────┼───────────────────────────────────┤ │
│  │ id              │ UUID PK          │                                   │ │
│  │ user_id         │ UUID FK          │ REFERENCES users(id)              │ │
│  │ device_type     │ VARCHAR(50)      │ iPhone, iPad, Mac, Watch          │ │
│  │ push_token      │ VARCHAR(500)     │ For offline notifications         │ │
│  │ is_active       │ BOOLEAN          │ DEFAULT TRUE                      │ │
│  │ last_seen       │ TIMESTAMP        │                                   │ │
│  └─────────────────┴──────────────────┴───────────────────────────────────┘ │
│                                                                              │
│  INDEX: idx_devices_user_active ON user_devices(user_id) WHERE is_active     │
│                                                                              │
│  calls                                                                       │
│  ┌─────────────────┬──────────────────┬───────────────────────────────────┐ │
│  │ Column          │ Type             │ Notes                             │ │
│  ├─────────────────┼──────────────────┼───────────────────────────────────┤ │
│  │ id              │ UUID PK          │                                   │ │
│  │ initiator_id    │ UUID FK          │ REFERENCES users(id)              │ │
│  │ call_type       │ VARCHAR(20)      │ 'video', 'audio', 'group'         │ │
│  │ state           │ VARCHAR(20)      │ 'ringing','connected','ended'     │ │
│  │ answered_by     │ UUID             │ Device that answered              │ │
│  │ connected_at    │ TIMESTAMP        │                                   │ │
│  │ ended_at        │ TIMESTAMP        │                                   │ │
│  │ duration_seconds│ INTEGER          │ Computed on end                   │ │
│  └─────────────────┴──────────────────┴───────────────────────────────────┘ │
│                                                                              │
│  INDEXES:                                                                    │
│    idx_calls_initiator ON calls(initiator_id, created_at DESC)              │
│    idx_calls_state ON calls(state) WHERE state IN ('ringing','connected')   │
│                                                                              │
│  call_participants                                                           │
│  ┌─────────────────┬──────────────────┬───────────────────────────────────┐ │
│  │ Column          │ Type             │ Notes                             │ │
│  ├─────────────────┼──────────────────┼───────────────────────────────────┤ │
│  │ call_id         │ UUID             │ PK with user_id                   │ │
│  │ user_id         │ UUID FK          │ PK with call_id                   │ │
│  │ device_id       │ UUID             │ Device that joined                │ │
│  │ state           │ VARCHAR(20)      │ 'ringing','connected','left'      │ │
│  │ joined_at       │ TIMESTAMP        │                                   │ │
│  │ left_at         │ TIMESTAMP        │                                   │ │
│  └─────────────────┴──────────────────┴───────────────────────────────────┘ │
│                                                                              │
│  INDEX: idx_participants_user ON call_participants(user_id, call_id)        │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Redis Caching Strategy

| Key Pattern | Data | TTL | Usage |
|-------------|------|-----|-------|
| `presence:{userId}` | Online status, lastSeen | 60s | Write-through on heartbeat |
| `presence:{userId}:devices` | Set of device IDs | 60s | Device routing |
| `call:{callId}` | Active call state | 30m | Fast state lookup |
| `idempotency:call:{key}` | Call ID | 5m | Duplicate prevention |
| `turn:{userId}` | TURN credentials | 5m | Credential caching |
| `ice:{callId}:{hash}` | Timestamp | 1h | ICE candidate deduplication |

---

## Step 7: Observability (3 minutes)

### Key Metrics

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Prometheus Metrics                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Counters:                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ facetime_calls_initiated_total{call_type}                               ││
│  │ facetime_calls_answered_total{call_type}                                ││
│  │ facetime_ice_connection_type_total{type}  (host, srflx, relay)          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Histograms:                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ facetime_call_duration_seconds{call_type}                               ││
│  │   buckets: [30, 60, 120, 300, 600, 1800, 3600]                          ││
│  │                                                                         ││
│  │ facetime_call_setup_latency_seconds{call_type}                          ││
│  │   buckets: [0.5, 1, 2, 5, 10, 30]                                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Gauges:                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ facetime_active_websocket_connections                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Health Check Endpoint

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     GET /health                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Response (200 OK / 503 Degraded):                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ {                                                                       ││
│  │   status: 'ok' | 'degraded',                                            ││
│  │   uptime: process.uptime(),                                             ││
│  │   services: {                                                           ││
│  │     postgres: { status: 'healthy' | 'unhealthy' },                      ││
│  │     redis: { status: 'healthy' | 'unhealthy' },                         ││
│  │     websocket: { status: 'healthy' | 'unhealthy' }                      ││
│  │   },                                                                    ││
│  │   activeConnections: 1234,                                              ││
│  │   activeCalls: 567                                                      ││
│  │ }                                                                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 8: Trade-offs and Alternatives (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Signaling transport | WebSocket | HTTP long-poll | Lower latency, bidirectional |
| Call state storage | Redis + PostgreSQL | PostgreSQL only | Fast lookup + durability |
| Group call topology | SFU | MCU | No transcoding, lower latency |
| ICE candidate relay | Trickle ICE | Full gathering | Faster connection establishment |
| NAT traversal | STUN + TURN fallback | Always TURN | Lower latency when P2P possible |

### Why SFU over MCU?

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     MCU vs SFU Comparison                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  MCU (Multipoint Control Unit):                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ [User A] ──▶ ┌─────────┐                                                ││
│  │              │   MCU   │ ──▶ [Mixed stream to all]                      ││
│  │ [User B] ──▶ │ transcode│                                                ││
│  │              └─────────┘                                                ││
│  │                                                                         ││
│  │ - Mixes all streams into one                                            ││
│  │ - HIGH server CPU (transcoding)                                         ││
│  │ - Lower client bandwidth                                                ││
│  │ - Higher latency (transcoding delay)                                    ││
│  │ - Quality loss from re-encoding                                         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  SFU (Selective Forwarding Unit):                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ [User A] ──▶ ┌─────────┐ ──▶ [User B]                                   ││
│  │              │   SFU   │                                                ││
│  │ [User B] ──▶ │ forward │ ──▶ [User A]                                   ││
│  │              └─────────┘                                                ││
│  │                                                                         ││
│  │ - Forwards streams selectively                                          ││
│  │ - LOW server CPU (no transcoding)                                       ││
│  │ - Higher client bandwidth                                               ││
│  │ - Lower latency (just routing)                                          ││
│  │ - Better video quality (no re-encoding)                                 ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  For a quality-focused service like FaceTime, SFU is the right choice.      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Closing Summary

I've designed the backend for a real-time video calling system with four core components:

1. **Signaling Server**: WebSocket-based call setup with idempotency, race condition handling for multi-device answer, and presence management via Redis

2. **ICE/TURN Infrastructure**: STUN for NAT discovery, TURN with short-lived credentials for relay fallback, and trickle ICE with deduplication

3. **SFU for Group Calls**: Selective forwarding with dominant speaker detection, renegotiation on participant changes, no transcoding overhead

4. **Call State Management**: PostgreSQL for durable call history, Redis for real-time state with appropriate TTLs, strong consistency for call transitions

**Key trade-offs:**
- SFU over MCU (quality vs. client bandwidth)
- WebSocket over HTTP polling (latency vs. scalability complexity)
- Prefer P2P with TURN fallback (latency vs. reliability)

**What would I add with more time?**
- Simulcast for adaptive quality based on receiver bandwidth
- Geographic distribution of TURN servers
- Call recording with E2E encryption key escrow
- Rate limiting on call initiation to prevent abuse

# FaceTime - System Design Answer (Full-Stack Focus)

## 45-minute system design interview format - Full-Stack Engineer Position

## Opening Statement (1 minute)

"I'll design FaceTime as a full-stack system, focusing on the integration between the signaling server and the WebRTC-powered frontend. The key challenges span both layers: the backend must handle WebSocket signaling with proper state management and multi-device ringing, while the frontend must manage peer connection lifecycle and render video streams. I'll emphasize the signaling protocol design, call state synchronization, and how ICE candidates flow between peers through the server."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **1:1 Calls**: Video and audio calls between two users
- **Group Calls**: Multi-party video with up to 32 participants
- **Multi-Device Ring**: Incoming calls ring on all user devices
- **Call Transfer**: Hand off active call to another device
- **Call Controls**: Mute, video toggle, speaker selection

### Non-Functional Requirements
- **Latency**: < 150ms end-to-end for media
- **Setup Time**: < 3 seconds from dial to connected
- **Reliability**: 99.9% signaling availability
- **Scale**: Support millions of concurrent calls

### Full-Stack Scope
- WebSocket signaling protocol
- REST API for call history and user management
- React frontend with WebRTC integration
- PostgreSQL for persistence, Redis for presence

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Frontend                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Call Store │  │   WebRTC    │  │    Video Components     │  │
│  │  (Zustand)  │  │    Hook     │  │                         │  │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────────┘  │
│         │                │                                       │
│  ┌──────┴────────────────┴──────────────────────────────────┐   │
│  │              WebSocket Signaling Client                   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  WebSocket Signaling Server                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Connection │  │    Call     │  │    ICE Candidate        │  │
│  │   Manager   │  │   Router    │  │      Relay              │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────────┘  │
│         │                │                     │                 │
│  ┌──────┴────────────────┴─────────────────────┴─────────────┐  │
│  │                    State Manager                           │  │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
          │                │                     │
          ▼                ▼                     ▼
   ┌────────────┐   ┌────────────┐       ┌────────────┐
   │ PostgreSQL │   │   Redis    │       │   Coturn   │
   │            │   │ (Presence) │       │   (TURN)   │
   └────────────┘   └────────────┘       └────────────┘
```

---

## Deep Dive: Signaling Protocol (8 minutes)

### WebSocket Message Schema

The signaling protocol uses a typed union of message types shared between frontend and backend:

```
┌────────────────────────────────────────────────────────────────┐
│                    Signaling Message Types                      │
├────────────────────────────────────────────────────────────────┤
│  register          │ deviceId                                   │
│  initiate_call     │ calleeId, callType, idempotencyKey        │
│  ring              │ callId, caller info, callType             │
│  answer_call       │ callId, SDP payload                       │
│  call_answered     │ callId, SDP payload                       │
│  decline_call      │ callId                                    │
│  ice_candidate     │ callId, candidate                         │
│  end_call          │ callId                                    │
│  call_ended        │ callId, reason                            │
│  offer             │ callId, SDP payload                       │
│  error             │ code, message                             │
└────────────────────────────────────────────────────────────────┘
```

### Backend: WebSocket Handler Architecture

The signaling server manages connections and routes messages between peers:

```
┌─────────────────────────────────────────────────────────────────┐
│                    SignalingServer Class                         │
├─────────────────────────────────────────────────────────────────┤
│  connections: Map<deviceId, Connection>                          │
│  userDevices: Map<userId, Set<deviceId>>                         │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  handleRegister │  │ handleInitiate  │  │  handleAnswer   │
│                 │  │     Call        │  │      Call       │
│ - Store conn    │  │ - Idempotency   │  │ - Atomic state  │
│ - Track devices │  │ - Create call   │  │   transition    │
│ - Redis presence│  │ - Ring all      │  │ - Stop other    │
│                 │  │   devices       │  │   device rings  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ handleIce       │  │   handleEnd     │  │ handleDisconnect│
│ Candidate       │  │     Call        │  │                 │
│ - Deduplicate   │  │ - Update DB     │  │ - Clean up      │
│ - Relay to peer │  │ - Notify all    │  │ - Remove from   │
│                 │  │ - Clean Redis   │  │   presence      │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### Call State Flow

"The server determines call state transitions atomically. When a call is initiated, we use an idempotency key to prevent duplicate calls from network retries."

```
┌─────────┐    initiate    ┌─────────┐    answer     ┌───────────┐
│  idle   │ ─────────────▶ │ ringing │ ────────────▶ │ connected │
└─────────┘                └─────────┘               └───────────┘
     │                          │                          │
     │                          │ timeout/decline          │ end_call
     │                          ▼                          ▼
     │                    ┌───────────┐              ┌─────────┐
     └───────────────────▶│  missed/  │              │  ended  │
                          │ declined  │              └─────────┘
                          └───────────┘
```

### Register Flow

- Store connection in Map with deviceId as key
- Track user's devices in userDevices Map
- Update Redis presence with 60s TTL
- Add device to user's device set in Redis

### Initiate Call Flow

- Check idempotency key in Redis (5 min TTL)
- Create call record in PostgreSQL with state 'ringing'
- Get callee's online devices from Redis
- Send 'ring' message to all callee devices
- Store call state in Redis hash for quick access
- Set 30 second ring timeout

### Answer Call Flow

- Atomic state update: UPDATE calls WHERE state = 'ringing'
- First device to answer wins (concurrent-safe)
- Stop ringing on other devices via 'call_ended' message
- Update Redis call state with answering device
- Send SDP to initiator device

### ICE Candidate Flow

- Hash candidate to detect duplicates
- Use Redis SETNX for atomic dedup check
- Relay to other peer in the call
- 5 minute TTL on dedup keys

---

## Deep Dive: Frontend Integration (7 minutes)

### Signaling Client Hook Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      useSignaling Hook                           │
├─────────────────────────────────────────────────────────────────┤
│  wsRef: WebSocket reference                                      │
│  webRTCRef: WebRTC hook reference                                │
├─────────────────────────────────────────────────────────────────┤
│  connect()       │ Establish WS, register device                 │
│  handleMessage() │ Route incoming messages to handlers           │
│  sendMessage()   │ Send JSON message to server                   │
│  initiateCall()  │ Start outgoing call with idempotency key      │
│  answerCall()    │ Accept incoming call, create offer            │
│  declineCall()   │ Reject incoming call                          │
│  hangup()        │ End active call                               │
│  sendIceCandidate() │ Relay ICE candidate to peer                │
└─────────────────────────────────────────────────────────────────┘
```

### Message Handler Logic

```
┌──────────────────────────────────────────────────────────────┐
│                   Message Handler Switch                      │
├──────────────────────────────────────────────────────────────┤
│  'ring'          ──▶ receiveIncomingCall() in store          │
│  'offer'         ──▶ webRTC.createAnswer() ──▶ answer_call   │
│  'call_answered' ──▶ webRTC.handleAnswer() ──▶ setConnected  │
│  'ice_candidate' ──▶ webRTC.addIceCandidate()                │
│  'call_ended'    ──▶ endCall() in store                      │
│  'error'         ──▶ console.error()                         │
└──────────────────────────────────────────────────────────────┘
```

### Call Manager Component

The CallManager orchestrates WebRTC and signaling:

```
┌─────────────────────────────────────────────────────────────────┐
│                      CallManager Component                       │
├─────────────────────────────────────────────────────────────────┤
│  Reads from:                                                     │
│    - callState (idle/outgoing/connecting/connected)             │
│    - currentCallId                                               │
│    - incomingCall                                                │
├─────────────────────────────────────────────────────────────────┤
│  useWebRTC hook configured with:                                 │
│    - isInitiator: callState === 'outgoing'                      │
│    - onRemoteStream: add to store                               │
│    - onConnectionStateChange: update quality indicator          │
│    - onIceCandidate: send via signaling                         │
├─────────────────────────────────────────────────────────────────┤
│  Renders:                                                        │
│    - IncomingCallOverlay (when incomingCall exists)             │
│    - ActiveCallView (when connecting or connected)              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: TURN Credential Flow (5 minutes)

### Backend: TURN Credential Endpoint

"TURN credentials are time-limited using HMAC-SHA1 signatures. The username includes a timestamp, and the credential is derived from a shared secret with the Coturn server."

```
┌─────────────────────────────────────────────────────────────────┐
│                    GET /api/turn/credentials                     │
├─────────────────────────────────────────────────────────────────┤
│  1. Extract userId from session                                  │
│  2. Calculate expiry = now + 300 seconds                        │
│  3. Create username = "{timestamp}:{userId}"                    │
│  4. Generate credential = HMAC-SHA1(secret, username) → base64  │
│  5. Return:                                                      │
│     - urls: [turn:host:3478?transport=udp, ...tcp]             │
│     - username                                                   │
│     - credential                                                 │
│     - ttl: 300                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend: ICE Server Configuration

```
┌─────────────────────────────────────────────────────────────────┐
│                    getIceServers() Function                      │
├─────────────────────────────────────────────────────────────────┤
│  1. Fetch /api/turn/credentials (with cookies)                  │
│  2. If successful, return:                                       │
│     ┌───────────────────────────────────────────────────────┐   │
│     │ { urls: 'stun:stun.l.google.com:19302' }              │   │
│     │ { urls: turn.urls, username, credential }             │   │
│     └───────────────────────────────────────────────────────┘   │
│  3. If failed, return STUN only (fallback)                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Call History API (5 minutes)

### Backend: Call History Query

The call history endpoint returns paginated calls with computed direction and duration:

```
┌─────────────────────────────────────────────────────────────────┐
│                   GET /api/calls/history                         │
├─────────────────────────────────────────────────────────────────┤
│  Query Parameters:                                               │
│    - limit (default 50, max 100)                                │
│    - offset (default 0)                                          │
├─────────────────────────────────────────────────────────────────┤
│  Returns for each call:                                          │
│    - id, call_type, state, timestamps                           │
│    - direction: 'outgoing' if user is initiator, else 'incoming'│
│    - other_party: { id, name, avatar_url }                      │
│    - duration_seconds: ended_at - connected_at                  │
├─────────────────────────────────────────────────────────────────┤
│  WHERE: initiator_id = userId OR user in call_participants      │
│  ORDER BY: created_at DESC                                       │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend: Call History Component

```
┌─────────────────────────────────────────────────────────────────┐
│                    CallHistory Component                         │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ CallHistoryItem                                           │  │
│  │ ┌─────────┐ ┌───────────────────────────────┐ ┌─────────┐│  │
│  │ │ Avatar  │ │ Name                          │ │ Time    ││  │
│  │ │         │ │ ↗ Video (Missed) - 2:34       │ │ 2h ago  ││  │
│  │ └─────────┘ └───────────────────────────────┘ └─────────┘│  │
│  │                                               ┌─────────┐│  │
│  │                                               │  Call   ││  │
│  │                                               │  Button ││  │
│  │                                               └─────────┘│  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  - Direction indicator: ↗ outgoing, ↙ incoming                  │
│  - Missed/declined calls shown in red                           │
│  - Duration formatted for connected calls                        │
│  - Click phone button to call again                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Signaling Protocol | WebSocket | Socket.io | Less abstraction, smaller bundle, more control |
| Call State Storage | Redis + PostgreSQL | Redis only | Durability for call history, speed for active calls |
| Multi-device Ring | Push to all devices | First-online only | Better UX, user chooses which device |
| ICE Trickle | Immediate relay | Batch candidates | Lower latency, more resilient |
| State Sync | Server authoritative | Client-driven | Prevents race conditions in multi-device scenario |
| TURN Credentials | Time-limited HMAC | Static credentials | Security, prevents credential abuse |

### Error Handling Strategy

| Error | Backend Response | Frontend Behavior |
|-------|------------------|-------------------|
| Call already answered | `CALL_UNAVAILABLE` | Show "Answered on another device" |
| User offline | Empty device list | Show "User unavailable" |
| ICE failure | N/A (client-side) | Retry with TURN-only, then show error |
| WebSocket disconnect | N/A | Auto-reconnect with backoff |
| Invalid state transition | Reject update | Log warning, sync state from server |

### Database Schema

```
┌─────────────────────────────────────────────────────────────────┐
│                         users                                    │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK), name, avatar_url, created_at                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         calls                                    │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK), initiator_id (FK), call_type                      │
│ state: ringing | connected | ended | missed | declined          │
│ answered_by (device_id), created_at, connected_at, ended_at     │
├─────────────────────────────────────────────────────────────────┤
│ INDEX: initiator_id + created_at DESC                           │
│ INDEX: state WHERE state = 'ringing'                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    call_participants                             │
├─────────────────────────────────────────────────────────────────┤
│ call_id (FK), user_id (FK), device_id                           │
│ state, joined_at, left_at                                        │
│ PRIMARY KEY (call_id, user_id, device_id)                       │
├─────────────────────────────────────────────────────────────────┤
│ INDEX: user_id                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Closing Summary (1 minute)

"The FaceTime full-stack system is built around three integration points:

1. **WebSocket Signaling Protocol** - A typed message schema shared between frontend and backend ensures type safety. The server handles call state transitions atomically in PostgreSQL while using Redis for presence and active call lookup. Idempotency keys prevent duplicate call initiations from network retries.

2. **WebRTC Orchestration** - The frontend's `useWebRTC` hook manages peer connection lifecycle, while `useSignaling` handles message routing. ICE candidates are relayed through the server with deduplication, and TURN credentials are generated with time-limited HMAC signatures.

3. **Multi-device Coordination** - When a call comes in, the server rings all registered devices. The first to answer wins via atomic database update, and other devices receive a 'call_ended' message. This pattern ensures consistent state across all user devices.

The main trade-off is complexity vs. reliability. The server-authoritative model requires more round trips but prevents race conditions that would occur with client-driven state."

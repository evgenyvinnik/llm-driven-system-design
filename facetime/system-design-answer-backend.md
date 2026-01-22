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

```typescript
// backend/src/services/signaling.ts
import { WebSocket, WebSocketServer } from 'ws'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'

interface ConnectedDevice {
  ws: WebSocket
  userId: string
  deviceId: string
  lastPing: number
}

class SignalingServer {
  private devices = new Map<string, ConnectedDevice>()
  private userDevices = new Map<string, Set<string>>() // userId -> deviceIds

  constructor(wss: WebSocketServer) {
    wss.on('connection', this.handleConnection.bind(this))

    // Cleanup stale connections every 30 seconds
    setInterval(() => this.cleanupStaleConnections(), 30000)
  }

  private async handleConnection(ws: WebSocket) {
    ws.on('message', async (data) => {
      const message = JSON.parse(data.toString())
      await this.handleMessage(ws, message)
    })

    ws.on('close', () => this.handleDisconnect(ws))
    ws.on('pong', () => this.handlePong(ws))
  }

  private async handleMessage(ws: WebSocket, message: SignalingMessage) {
    switch (message.type) {
      case 'register':
        await this.handleRegister(ws, message)
        break
      case 'call_initiate':
        await this.handleCallInitiate(ws, message)
        break
      case 'call_answer':
        await this.handleCallAnswer(ws, message)
        break
      case 'call_decline':
        await this.handleCallDecline(ws, message)
        break
      case 'ice_candidate':
        await this.handleICECandidate(ws, message)
        break
      case 'call_end':
        await this.handleCallEnd(ws, message)
        break
    }
  }

  private async handleRegister(ws: WebSocket, message: RegisterMessage) {
    const { userId, deviceId } = message

    // Store device connection
    this.devices.set(deviceId, {
      ws,
      userId,
      deviceId,
      lastPing: Date.now()
    })

    // Track user's devices
    if (!this.userDevices.has(userId)) {
      this.userDevices.set(userId, new Set())
    }
    this.userDevices.get(userId)!.add(deviceId)

    // Update presence in Redis
    await redis.hset(`presence:${userId}`, {
      status: 'online',
      lastSeen: Date.now()
    })
    await redis.expire(`presence:${userId}`, 60)
    await redis.sadd(`presence:${userId}:devices`, deviceId)
    await redis.expire(`presence:${userId}:devices`, 60)

    // Update device in PostgreSQL
    await pool.query(`
      INSERT INTO user_devices (id, user_id, is_active, last_seen)
      VALUES ($1, $2, true, NOW())
      ON CONFLICT (id) DO UPDATE
      SET is_active = true, last_seen = NOW()
    `, [deviceId, userId])

    ws.send(JSON.stringify({ type: 'registered', deviceId }))
  }
}
```

### Call Initiation with Idempotency

```typescript
// backend/src/services/signaling.ts (continued)
private async handleCallInitiate(
  ws: WebSocket,
  message: CallInitiateMessage
) {
  const { calleeIds, callType, idempotencyKey } = message
  const caller = this.getDeviceByWs(ws)
  if (!caller) return

  // Check idempotency - prevent duplicate calls on retry
  const existingCallId = await redis.get(`idempotency:call:${idempotencyKey}`)
  if (existingCallId) {
    ws.send(JSON.stringify({
      type: 'call_initiated',
      callId: existingCallId,
      deduplicated: true
    }))
    return
  }

  const callId = crypto.randomUUID()

  // Store idempotency key BEFORE creating call (crash-safe ordering)
  await redis.setex(`idempotency:call:${idempotencyKey}`, 300, callId)

  // Create call record in transaction
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(`
      INSERT INTO calls (id, initiator_id, call_type, state, created_at)
      VALUES ($1, $2, $3, 'ringing', NOW())
    `, [callId, caller.userId, callType])

    for (const calleeId of calleeIds) {
      await client.query(`
        INSERT INTO call_participants (call_id, user_id, state)
        VALUES ($1, $2, 'ringing')
      `, [callId, calleeId])
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    await redis.del(`idempotency:call:${idempotencyKey}`)
    throw error
  } finally {
    client.release()
  }

  // Store active call in Redis for fast lookup
  await redis.hset(`call:${callId}`, {
    initiator: caller.userId,
    callType,
    state: 'ringing',
    createdAt: Date.now()
  })
  await redis.expire(`call:${callId}`, 1800) // 30 min TTL

  // Ring all callee devices
  for (const calleeId of calleeIds) {
    const calleeDeviceIds = this.userDevices.get(calleeId)

    if (calleeDeviceIds) {
      for (const deviceId of calleeDeviceIds) {
        const device = this.devices.get(deviceId)
        if (device) {
          device.ws.send(JSON.stringify({
            type: 'incoming_call',
            callId,
            caller: caller.userId,
            callType
          }))
        }
      }
    }

    // Also send push notification for devices not connected
    await this.sendPushNotification(calleeId, {
      type: 'incoming_call',
      callId,
      caller: caller.userId,
      callType
    })
  }

  // Set ring timeout
  setTimeout(() => this.handleRingTimeout(callId), 30000)

  ws.send(JSON.stringify({
    type: 'call_initiated',
    callId,
    deduplicated: false
  }))
}
```

### Call Answer with Race Condition Handling

```typescript
// backend/src/services/signaling.ts (continued)
private async handleCallAnswer(ws: WebSocket, message: CallAnswerMessage) {
  const { callId, sdpAnswer } = message
  const device = this.getDeviceByWs(ws)
  if (!device) return

  // Atomic check-and-update - only first device to answer wins
  const result = await pool.query(`
    WITH locked_call AS (
      SELECT id, state, initiator_id FROM calls
      WHERE id = $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE calls
    SET state = 'connected',
        answered_by_device = $2,
        connected_at = NOW()
    FROM locked_call
    WHERE calls.id = locked_call.id
      AND locked_call.state = 'ringing'
    RETURNING calls.*, locked_call.initiator_id
  `, [callId, device.deviceId])

  if (result.rowCount === 0) {
    // Call was already answered by another device or doesn't exist
    const call = await pool.query(
      'SELECT state, answered_by_device FROM calls WHERE id = $1',
      [callId]
    )

    if (call.rows[0]?.state === 'connected') {
      ws.send(JSON.stringify({
        type: 'call_answer_rejected',
        callId,
        reason: 'already_answered',
        answeredBy: call.rows[0].answered_by_device
      }))
    } else {
      ws.send(JSON.stringify({
        type: 'call_answer_rejected',
        callId,
        reason: 'call_not_found'
      }))
    }
    return
  }

  // Update Redis state
  await redis.hset(`call:${callId}`, {
    state: 'connected',
    answeredBy: device.deviceId,
    connectedAt: Date.now()
  })

  // Stop ringing on all other devices
  const call = result.rows[0]
  await this.stopRingingOnOtherDevices(callId, device.deviceId)

  // Send answer to caller
  const callerDevices = this.userDevices.get(call.initiator_id)
  if (callerDevices) {
    for (const callerDeviceId of callerDevices) {
      const callerDevice = this.devices.get(callerDeviceId)
      if (callerDevice) {
        callerDevice.ws.send(JSON.stringify({
          type: 'call_answered',
          callId,
          answer: sdpAnswer,
          answeredBy: device.userId
        }))
      }
    }
  }

  ws.send(JSON.stringify({ type: 'call_connected', callId }))
}
```

---

## Step 4: ICE Candidate Exchange (8 minutes)

### ICE Candidate Handling with Deduplication

```typescript
// backend/src/services/signaling.ts (continued)
private async handleICECandidate(
  ws: WebSocket,
  message: ICECandidateMessage
) {
  const { callId, candidate } = message
  const device = this.getDeviceByWs(ws)
  if (!device) return

  // Generate deterministic hash for deduplication
  const candidateHash = crypto
    .createHash('sha256')
    .update(`${callId}:${device.deviceId}:${candidate.candidate}`)
    .digest('hex')
    .slice(0, 16)

  // SETNX returns 1 if key was set (new), 0 if exists (duplicate)
  const isNew = await redis.setnx(
    `ice:${callId}:${candidateHash}`,
    Date.now()
  )

  if (!isNew) {
    // Duplicate candidate - ignore silently
    return
  }

  // Set TTL for cleanup
  await redis.expire(`ice:${callId}:${candidateHash}`, 3600)

  // Get call to find other participants
  const call = await redis.hgetall(`call:${callId}`)
  if (!call || call.state === 'ended') {
    return
  }

  // Forward to all other participants in the call
  const participants = await pool.query(`
    SELECT user_id FROM call_participants
    WHERE call_id = $1 AND user_id != $2
  `, [callId, device.userId])

  for (const participant of participants.rows) {
    const participantDevices = this.userDevices.get(participant.user_id)
    if (participantDevices) {
      for (const participantDeviceId of participantDevices) {
        const participantDevice = this.devices.get(participantDeviceId)
        if (participantDevice) {
          participantDevice.ws.send(JSON.stringify({
            type: 'ice_candidate',
            callId,
            from: device.userId,
            candidate
          }))
        }
      }
    }
  }
}
```

### TURN Credential Service

```typescript
// backend/src/services/turnCredentials.ts
import crypto from 'crypto'
import { redis } from '../shared/cache.js'

const TURN_SECRET = process.env.TURN_SECRET!
const CREDENTIAL_TTL = 300 // 5 minutes

export async function getTURNCredentials(userId: string): Promise<TURNCredentials> {
  const cacheKey = `turn:${userId}`

  // Check cache first
  const cached = await redis.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  // Generate time-limited credentials (RFC 5389)
  const timestamp = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL
  const username = `${timestamp}:${userId}`
  const credential = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64')

  const credentials: TURNCredentials = {
    username,
    credential,
    urls: [
      'turn:turn.example.com:3478?transport=udp',
      'turn:turn.example.com:3478?transport=tcp',
      'turns:turn.example.com:5349?transport=tcp'
    ],
    ttl: CREDENTIAL_TTL
  }

  // Cache with TTL slightly shorter than credential validity
  await redis.setex(cacheKey, CREDENTIAL_TTL - 30, JSON.stringify(credentials))

  return credentials
}
```

### ICE Server Configuration Endpoint

```typescript
// backend/src/routes/ice.ts
import { Router } from 'express'
import { requireAuth } from '../shared/auth.js'
import { getTURNCredentials } from '../services/turnCredentials.js'

const router = Router()

router.get('/ice-servers', requireAuth, async (req, res) => {
  const userId = req.session.userId

  const turnCredentials = await getTURNCredentials(userId)

  const iceServers = [
    // STUN servers (no authentication needed)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // TURN servers (with short-lived credentials)
    {
      urls: turnCredentials.urls,
      username: turnCredentials.username,
      credential: turnCredentials.credential
    }
  ]

  res.json({
    iceServers,
    iceTransportPolicy: 'all', // or 'relay' to force TURN
    ttl: turnCredentials.ttl
  })
})

export default router
```

---

## Step 5: SFU for Group Calls (8 minutes)

### SFU Architecture

```typescript
// backend/src/services/sfu.ts
interface Room {
  id: string
  participants: Map<string, Participant>
  dominantSpeaker: string | null
  createdAt: number
}

interface Participant {
  userId: string
  deviceId: string
  peerConnection: RTCPeerConnection
  tracks: MediaStreamTrack[]
  audioLevel: number
}

class SFU {
  private rooms = new Map<string, Room>()

  async joinRoom(
    roomId: string,
    userId: string,
    deviceId: string,
    offer: RTCSessionDescriptionInit
  ): Promise<{ answer: RTCSessionDescriptionInit; participants: string[] }> {
    let room = this.rooms.get(roomId)

    if (!room) {
      room = {
        id: roomId,
        participants: new Map(),
        dominantSpeaker: null,
        createdAt: Date.now()
      }
      this.rooms.set(roomId, room)
    }

    // Create peer connection for this participant
    const pc = new RTCPeerConnection({
      sdpSemantics: 'unified-plan'
    })

    // Handle incoming tracks from this participant
    pc.ontrack = (event) => {
      const participant = room!.participants.get(userId)
      if (participant) {
        participant.tracks.push(event.track)
      }

      // Forward to all other participants
      this.forwardTrackToParticipants(room!, userId, event.track, event.streams[0])
    }

    // Add existing tracks from other participants
    for (const [otherId, otherParticipant] of room.participants) {
      for (const track of otherParticipant.tracks) {
        pc.addTrack(track)
      }
    }

    // Process offer and create answer
    await pc.setRemoteDescription(offer)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    // Store participant
    room.participants.set(userId, {
      userId,
      deviceId,
      peerConnection: pc,
      tracks: [],
      audioLevel: 0
    })

    // Notify existing participants about new joiner
    this.notifyParticipantJoined(room, userId)

    return {
      answer,
      participants: Array.from(room.participants.keys())
    }
  }

  private forwardTrackToParticipants(
    room: Room,
    fromUserId: string,
    track: MediaStreamTrack,
    stream: MediaStream
  ) {
    for (const [userId, participant] of room.participants) {
      if (userId !== fromUserId) {
        participant.peerConnection.addTrack(track, stream)

        // Trigger renegotiation
        this.renegotiate(participant)
      }
    }
  }

  private async renegotiate(participant: Participant) {
    const pc = participant.peerConnection
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    // Send offer to participant through signaling
    this.signaling.sendToDevice(participant.deviceId, {
      type: 'renegotiate',
      offer
    })
  }
}
```

### Dominant Speaker Detection

```typescript
// backend/src/services/sfu.ts (continued)
class DominantSpeakerDetector {
  private audioLevelHistory = new Map<string, number[]>()
  private readonly SMOOTHING_WINDOW = 5
  private readonly SILENCE_THRESHOLD = 0.01

  constructor(private room: Room) {
    // Run detection every 100ms
    setInterval(() => this.detect(), 100)
  }

  async detect() {
    for (const [userId, participant] of this.room.participants) {
      const stats = await participant.peerConnection.getStats()

      for (const report of stats.values()) {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          const audioLevel = report.audioLevel || 0
          this.updateLevel(userId, audioLevel)
        }
      }
    }

    // Find user with highest average level
    let maxAvg = 0
    let dominant: string | null = null

    for (const [userId, levels] of this.audioLevelHistory) {
      const avg = levels.reduce((a, b) => a + b, 0) / levels.length
      if (avg > maxAvg && avg > this.SILENCE_THRESHOLD) {
        maxAvg = avg
        dominant = userId
      }
    }

    // Notify if dominant speaker changed
    if (dominant !== this.room.dominantSpeaker) {
      this.room.dominantSpeaker = dominant
      this.notifyDominantSpeakerChange(dominant)
    }
  }

  private updateLevel(userId: string, level: number) {
    if (!this.audioLevelHistory.has(userId)) {
      this.audioLevelHistory.set(userId, [])
    }

    const levels = this.audioLevelHistory.get(userId)!
    levels.push(level)

    if (levels.length > this.SMOOTHING_WINDOW) {
      levels.shift()
    }
  }

  private notifyDominantSpeakerChange(userId: string | null) {
    for (const [, participant] of this.room.participants) {
      this.signaling.sendToDevice(participant.deviceId, {
        type: 'dominant_speaker_changed',
        userId
      })
    }
  }
}
```

---

## Step 6: Database Schema and Caching (5 minutes)

### PostgreSQL Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- User Devices (for multi-device ring)
CREATE TABLE user_devices (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) NOT NULL,
  device_type VARCHAR(50),
  push_token VARCHAR(500),
  is_active BOOLEAN DEFAULT TRUE,
  last_seen TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user_active ON user_devices(user_id) WHERE is_active;

-- Calls
CREATE TABLE calls (
  id UUID PRIMARY KEY,
  initiator_id UUID REFERENCES users(id) NOT NULL,
  call_type VARCHAR(20) NOT NULL, -- 'video', 'audio', 'group'
  state VARCHAR(20) NOT NULL,     -- 'ringing', 'connected', 'ended', 'missed'
  answered_by_device UUID,
  connected_at TIMESTAMP,
  ended_at TIMESTAMP,
  duration_seconds INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_calls_initiator ON calls(initiator_id, created_at DESC);
CREATE INDEX idx_calls_state ON calls(state) WHERE state IN ('ringing', 'connected');

-- Call Participants
CREATE TABLE call_participants (
  call_id UUID REFERENCES calls(id),
  user_id UUID REFERENCES users(id) NOT NULL,
  device_id UUID,
  state VARCHAR(20), -- 'ringing', 'connected', 'left', 'declined'
  joined_at TIMESTAMP,
  left_at TIMESTAMP,
  PRIMARY KEY (call_id, user_id)
);

CREATE INDEX idx_participants_user ON call_participants(user_id, call_id);
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

```typescript
// backend/src/shared/metrics.ts
import { Counter, Histogram, Gauge } from 'prom-client'

export const callsInitiated = new Counter({
  name: 'facetime_calls_initiated_total',
  labelNames: ['call_type']
})

export const callsAnswered = new Counter({
  name: 'facetime_calls_answered_total',
  labelNames: ['call_type']
})

export const callDuration = new Histogram({
  name: 'facetime_call_duration_seconds',
  labelNames: ['call_type'],
  buckets: [30, 60, 120, 300, 600, 1800, 3600]
})

export const callSetupLatency = new Histogram({
  name: 'facetime_call_setup_latency_seconds',
  labelNames: ['call_type'],
  buckets: [0.5, 1, 2, 5, 10, 30]
})

export const activeConnections = new Gauge({
  name: 'facetime_active_websocket_connections'
})

export const iceConnectionType = new Counter({
  name: 'facetime_ice_connection_type_total',
  labelNames: ['type'] // 'host', 'srflx', 'relay'
})
```

### Health Check Endpoint

```typescript
// backend/src/routes/health.ts
router.get('/health', async (req, res) => {
  const checks = {
    postgres: await checkPostgres(),
    redis: await checkRedis(),
    websocket: checkWebSocketServer()
  }

  const healthy = Object.values(checks).every(c => c.status === 'healthy')

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptime: process.uptime(),
    services: checks,
    activeConnections: signaling.getConnectionCount(),
    activeCalls: await redis.keys('call:*').then(k => k.length)
  })
})
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

**MCU (Multipoint Control Unit):**
- Mixes all streams into one
- High server CPU (transcoding)
- Lower client bandwidth
- Higher latency

**SFU (Selective Forwarding Unit):**
- Forwards streams selectively
- Low server CPU (no transcoding)
- Higher client bandwidth
- Lower latency
- Better video quality (no re-encoding)

For a quality-focused service like FaceTime, SFU is the right choice.

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

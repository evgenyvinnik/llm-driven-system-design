# Design FaceTime - Architecture

## System Overview

FaceTime is a real-time video calling service with end-to-end encryption. Core challenges involve low latency, NAT traversal, and group call scaling.

**Learning Goals:**
- Build real-time media pipelines
- Design WebRTC-based calling systems
- Implement E2E encryption for calls
- Handle network adaptation

---

## Requirements

### Functional Requirements

1. **Call**: 1:1 video/audio calls
2. **Group**: Multi-party video calls
3. **Ring**: Multi-device incoming calls
4. **Handoff**: Transfer call between devices
5. **Share**: SharePlay for shared experiences

### Non-Functional Requirements

- **Latency**: < 150ms end-to-end
- **Quality**: Up to 1080p video
- **Scale**: Millions of concurrent calls
- **Security**: End-to-end encryption

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│          iPhone │ iPad │ Mac │ Apple Watch │ Apple TV           │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Signaling Server│    │  STUN Server  │    │  TURN Server  │
│               │    │               │    │               │
│ - Call setup  │    │ - NAT mapping │    │ - Media relay │
│ - Presence    │    │ - ICE         │    │ - Fallback    │
│ - Routing     │    │               │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Peer-to-Peer Media                           │
│              (Direct connection when possible)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SFU (Group Calls)                          │
│        (Selective Forwarding Unit for multi-party)             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Call Signaling

**Call Setup Protocol:**
```javascript
class SignalingService {
  async initiateCall(callerId, calleeIds, callType) {
    const callId = uuid()

    // Create call session
    const call = {
      id: callId,
      initiator: callerId,
      participants: calleeIds,
      type: callType, // 'video', 'audio'
      state: 'ringing',
      createdAt: Date.now()
    }

    await this.storeCall(call)

    // Ring all callee devices
    for (const calleeId of calleeIds) {
      const devices = await this.getUserDevices(calleeId)

      for (const device of devices) {
        await this.sendPush(device, {
          type: 'incoming_call',
          callId,
          caller: await this.getUserInfo(callerId),
          callType
        })

        // Also send via WebSocket if connected
        this.sendToDevice(device, {
          type: 'ring',
          callId,
          caller: callerId,
          callType
        })
      }
    }

    // Start ring timeout (30 seconds)
    setTimeout(() => this.handleRingTimeout(callId), 30000)

    return { callId }
  }

  async answerCall(callId, deviceId, answer) {
    const call = await this.getCall(callId)

    if (call.state !== 'ringing') {
      throw new Error('Call not ringing')
    }

    // Stop ringing on all devices
    await this.stopRinging(call.participants)

    // Exchange SDP
    await this.exchangeSDP(callId, deviceId, answer)

    // Update call state
    await this.updateCall(callId, {
      state: 'connected',
      answeredBy: deviceId,
      connectedAt: Date.now()
    })

    // Notify caller
    this.sendToDevice(call.initiatorDevice, {
      type: 'call_answered',
      callId,
      answer
    })
  }

  async exchangeICECandidate(callId, fromDevice, candidate) {
    const call = await this.getCall(callId)
    const otherParticipants = call.devices.filter(d => d !== fromDevice)

    for (const device of otherParticipants) {
      this.sendToDevice(device, {
        type: 'ice_candidate',
        callId,
        from: fromDevice,
        candidate
      })
    }
  }
}
```

### 2. NAT Traversal

**ICE Connectivity:**
```javascript
class ICEManager {
  constructor() {
    this.stunServers = [
      { urls: 'stun:stun.apple.com:3478' },
      { urls: 'stun:stun.apple.com:5349' }
    ]
    this.turnServers = [
      {
        urls: 'turn:turn.apple.com:3478',
        username: 'user',
        credential: 'pass'
      }
    ]
  }

  async gatherCandidates(peerConnection) {
    const candidates = []

    return new Promise((resolve) => {
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          candidates.push({
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            type: this.getCandidateType(event.candidate)
          })
        } else {
          // Gathering complete
          resolve(candidates)
        }
      }

      // Trigger gathering
      peerConnection.setLocalDescription(peerConnection.localDescription)
    })
  }

  getCandidateType(candidate) {
    // Prefer in order: host > srflx > relay
    if (candidate.candidate.includes('typ host')) return 'host'
    if (candidate.candidate.includes('typ srflx')) return 'srflx'
    if (candidate.candidate.includes('typ relay')) return 'relay'
    return 'unknown'
  }

  async checkConnectivity(peerConnection, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('ICE connection timeout'))
      }, timeout)

      peerConnection.oniceconnectionstatechange = () => {
        if (peerConnection.iceConnectionState === 'connected') {
          clearTimeout(timer)
          resolve(true)
        } else if (peerConnection.iceConnectionState === 'failed') {
          clearTimeout(timer)
          reject(new Error('ICE connection failed'))
        }
      }
    })
  }
}
```

### 3. Media Pipeline

**Adaptive Video Encoding:**
```javascript
class MediaPipeline {
  constructor() {
    this.encoderConfig = {
      codec: 'VP8', // or H.264
      maxBitrate: 2500000, // 2.5 Mbps
      maxFramerate: 30,
      width: 1280,
      height: 720
    }
  }

  async startCapture() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    return stream
  }

  adaptToNetwork(stats) {
    const { availableBandwidth, packetLoss, rtt } = stats

    // Reduce quality if bandwidth is low
    if (availableBandwidth < 500000) {
      this.setResolution(640, 360)
      this.setBitrate(400000)
    } else if (availableBandwidth < 1000000) {
      this.setResolution(960, 540)
      this.setBitrate(800000)
    } else {
      this.setResolution(1280, 720)
      this.setBitrate(2500000)
    }

    // Reduce framerate if packet loss is high
    if (packetLoss > 5) {
      this.setFramerate(15)
    } else if (packetLoss > 2) {
      this.setFramerate(24)
    } else {
      this.setFramerate(30)
    }
  }

  async applyPortraitMode(videoTrack) {
    // Use ML model to segment person from background
    const processor = new MediaStreamTrackProcessor({ track: videoTrack })
    const generator = new MediaStreamTrackGenerator({ kind: 'video' })

    const transformer = new TransformStream({
      async transform(frame, controller) {
        // Apply background blur
        const blurredFrame = await this.blurBackground(frame)
        controller.enqueue(blurredFrame)
        frame.close()
      }
    })

    processor.readable.pipeThrough(transformer).pipeTo(generator.writable)

    return generator
  }
}
```

### 4. Group Call (SFU)

**Selective Forwarding:**
```javascript
class SFU {
  constructor() {
    this.rooms = new Map() // roomId -> participants
  }

  async joinRoom(roomId, userId, offer) {
    let room = this.rooms.get(roomId)

    if (!room) {
      room = {
        id: roomId,
        participants: new Map(),
        dominantSpeaker: null
      }
      this.rooms.set(roomId, room)
    }

    // Create peer connection for this participant
    const pc = new RTCPeerConnection({
      sdpSemantics: 'unified-plan'
    })

    // Set up receive tracks from this participant
    pc.ontrack = (event) => {
      // Forward to other participants
      this.forwardTrack(roomId, userId, event.track)
    }

    // Set up send tracks to this participant (from others)
    for (const [otherId, otherParticipant] of room.participants) {
      // Add existing tracks
      for (const track of otherParticipant.tracks) {
        pc.addTrack(track)
      }
    }

    // Process offer
    await pc.setRemoteDescription(offer)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    room.participants.set(userId, {
      pc,
      tracks: [],
      userId
    })

    return { answer, participants: Array.from(room.participants.keys()) }
  }

  forwardTrack(roomId, fromUserId, track) {
    const room = this.rooms.get(roomId)
    if (!room) return

    // Store track
    const participant = room.participants.get(fromUserId)
    participant.tracks.push(track)

    // Forward to all other participants
    for (const [userId, p] of room.participants) {
      if (userId !== fromUserId) {
        p.pc.addTrack(track)

        // Renegotiate
        this.renegotiate(p.pc, userId)
      }
    }
  }

  // Dominant speaker detection
  async detectDominantSpeaker(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) return

    const audioLevels = new Map()

    for (const [userId, participant] of room.participants) {
      const stats = await participant.pc.getStats()

      for (const stat of stats.values()) {
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
          audioLevels.set(userId, stat.audioLevel || 0)
        }
      }
    }

    // Find loudest speaker
    let maxLevel = 0
    let dominant = null

    for (const [userId, level] of audioLevels) {
      if (level > maxLevel) {
        maxLevel = level
        dominant = userId
      }
    }

    if (dominant !== room.dominantSpeaker) {
      room.dominantSpeaker = dominant
      this.notifyDominantSpeakerChange(roomId, dominant)
    }
  }
}
```

### 5. End-to-End Encryption

**SRTP with Key Exchange:**
```javascript
class E2EEncryption {
  async setupEncryption(peerConnection) {
    // Generate key pair for this call
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    )

    // Export public key to share
    const publicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey)

    return { keyPair, publicKey }
  }

  async deriveSessionKey(privateKey, remotePublicKey) {
    // Import remote public key
    const importedPublicKey = await crypto.subtle.importKey(
      'raw',
      remotePublicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    )

    // Derive shared secret
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: importedPublicKey },
      privateKey,
      256
    )

    // Derive encryption key
    const sessionKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    )

    return sessionKey
  }

  // SRTP encryption for media
  async encryptRTPPacket(packet, sessionKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sessionKey,
      packet.payload
    )

    return {
      header: packet.header,
      iv,
      payload: encrypted
    }
  }
}
```

---

## Database Schema

```sql
-- Active Calls
CREATE TABLE calls (
  id UUID PRIMARY KEY,
  initiator_id UUID NOT NULL,
  call_type VARCHAR(20) NOT NULL, -- 'video', 'audio', 'group'
  state VARCHAR(20) NOT NULL,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Call Participants
CREATE TABLE call_participants (
  call_id UUID REFERENCES calls(id),
  user_id UUID NOT NULL,
  device_id UUID NOT NULL,
  state VARCHAR(20), -- 'ringing', 'connected', 'left'
  joined_at TIMESTAMP,
  left_at TIMESTAMP,
  PRIMARY KEY (call_id, user_id, device_id)
);

-- User Devices (for multi-device ring)
CREATE TABLE user_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  device_type VARCHAR(50),
  push_token VARCHAR(500),
  is_active BOOLEAN DEFAULT TRUE,
  last_seen TIMESTAMP
);
```

---

## Key Design Decisions

### 1. SFU for Group Calls

**Decision**: Use SFU instead of MCU or mesh

**Rationale**:
- Lower server CPU (no transcoding)
- Lower latency than MCU
- Scales better than mesh

### 2. Direct P2P When Possible

**Decision**: Prefer direct connection over relay

**Rationale**:
- Lower latency
- No server bandwidth cost
- Fall back to TURN when needed

### 3. ECDH Key Exchange

**Decision**: Per-call key exchange with PFS

**Rationale**:
- Perfect forward secrecy
- No key escrow
- Per-call key isolation

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Group topology | SFU | MCU/Mesh | Scalability, latency |
| Encryption | E2E SRTP | Hop-by-hop | Privacy |
| NAT traversal | ICE with TURN | UPnP only | Reliability |
| Codec | VP8/H.264 | AV1 | Hardware support |

---

## Consistency and Idempotency

### Write Semantics by Operation

| Operation | Consistency | Idempotency | Conflict Resolution |
|-----------|-------------|-------------|---------------------|
| Call initiation | Strong (PostgreSQL) | Idempotency key in request header | First-write-wins; reject duplicates |
| Answer call | Strong | Device-scoped; one answer per call | First device to answer wins |
| ICE candidates | Eventual | Dedupe by (callId, deviceId, candidateHash) | Accept all unique candidates |
| Call state updates | Strong | State machine validation | Reject invalid transitions |
| Device registration | Strong | Upsert by (userId, deviceId) | Last-write-wins for push tokens |

### Idempotency Implementation

**Call Initiation with Idempotency Key:**
```javascript
class SignalingService {
  async initiateCall(callerId, calleeIds, callType, idempotencyKey) {
    // Check for existing call with same idempotency key (Redis, 5-minute TTL)
    const existingCallId = await redis.get(`idempotency:call:${idempotencyKey}`)
    if (existingCallId) {
      // Return existing call instead of creating duplicate
      return { callId: existingCallId, deduplicated: true }
    }

    const callId = uuid()

    // Store idempotency mapping before creating call
    await redis.setex(`idempotency:call:${idempotencyKey}`, 300, callId)

    // Create call in PostgreSQL with transaction
    await db.transaction(async (tx) => {
      await tx.query(`
        INSERT INTO calls (id, initiator_id, call_type, state)
        VALUES ($1, $2, $3, 'ringing')
      `, [callId, callerId, callType])

      for (const calleeId of calleeIds) {
        await tx.query(`
          INSERT INTO call_participants (call_id, user_id, state)
          VALUES ($1, $2, 'ringing')
        `, [callId, calleeId])
      }
    })

    return { callId, deduplicated: false }
  }
}
```

**State Machine for Call Transitions:**
```javascript
const VALID_TRANSITIONS = {
  'ringing':   ['connected', 'cancelled', 'declined', 'missed'],
  'connected': ['ended'],
  'cancelled': [],  // Terminal state
  'declined':  [],  // Terminal state
  'missed':    [],  // Terminal state
  'ended':     []   // Terminal state
}

async function updateCallState(callId, newState) {
  const result = await db.query(`
    UPDATE calls
    SET state = $2, updated_at = NOW()
    WHERE id = $1
      AND state = ANY($3)
    RETURNING state
  `, [callId, newState, Object.keys(VALID_TRANSITIONS).filter(
    s => VALID_TRANSITIONS[s].includes(newState)
  )])

  if (result.rowCount === 0) {
    throw new Error(`Invalid state transition to ${newState}`)
  }
  return result.rows[0]
}
```

### Replay Handling

**ICE Candidate Deduplication:**
```javascript
async function handleICECandidate(callId, deviceId, candidate) {
  // Generate deterministic hash for deduplication
  const candidateHash = crypto
    .createHash('sha256')
    .update(`${callId}:${deviceId}:${candidate.candidate}`)
    .digest('hex')
    .slice(0, 16)

  // SETNX returns 1 if key was set (new candidate), 0 if exists (duplicate)
  const isNew = await redis.setnx(
    `ice:${callId}:${candidateHash}`,
    Date.now()
  )

  if (!isNew) {
    console.log(`Duplicate ICE candidate ignored: ${candidateHash}`)
    return { processed: false, reason: 'duplicate' }
  }

  // Set TTL for cleanup (candidates expire after call ends + buffer)
  await redis.expire(`ice:${callId}:${candidateHash}`, 3600)

  // Forward to peer
  await forwardToPeer(callId, deviceId, candidate)
  return { processed: true }
}
```

### Conflict Resolution for Multi-Device Answer

When multiple devices attempt to answer the same call simultaneously:

```javascript
async function answerCall(callId, deviceId, answer) {
  // Atomic check-and-update using PostgreSQL advisory lock
  const result = await db.query(`
    WITH locked_call AS (
      SELECT id, state FROM calls
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
    RETURNING calls.*
  `, [callId, deviceId])

  if (result.rowCount === 0) {
    // Either call doesn't exist, already answered, or locked by another device
    const call = await db.query('SELECT state, answered_by_device FROM calls WHERE id = $1', [callId])
    if (call.rows[0]?.state === 'connected') {
      return { success: false, reason: 'already_answered', answeredBy: call.rows[0].answered_by_device }
    }
    throw new Error('Call not available')
  }

  // Stop ringing on all other devices
  await notifyOtherDevices(callId, deviceId, { type: 'call_answered_elsewhere' })

  return { success: true }
}
```

---

## Caching and Edge Strategy

### Cache Architecture

For a local development setup, we use Redis/Valkey as the primary cache layer. In production, this would be fronted by a CDN for static assets and edge caching for signaling.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Apps                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              CDN (Static Assets + ICE Server Config)            │
│   - STUN/TURN server lists (TTL: 1 hour)                       │
│   - Client app bundles (TTL: immutable, versioned)              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Redis/Valkey Cache Layer                      │
│   - User presence (TTL: 60s, refresh on heartbeat)             │
│   - Active call state (TTL: 30 min, refresh on activity)       │
│   - Device registry (TTL: 24h, invalidate on logout)            │
│   - TURN credentials (TTL: 5 min, short-lived)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL (Source of Truth)                │
└─────────────────────────────────────────────────────────────────┘
```

### Caching Strategy by Data Type

| Data | Strategy | TTL | Invalidation |
|------|----------|-----|--------------|
| User profile | Cache-aside | 1 hour | On profile update (pub/sub) |
| User presence | Write-through | 60 seconds | Heartbeat refresh |
| Active call state | Write-through | 30 minutes | On state change |
| Device registry | Cache-aside | 24 hours | On device logout/register |
| TURN credentials | Read-through | 5 minutes | None (credentials expire) |
| Contact list | Cache-aside | 10 minutes | On contact change |

### Cache Implementation

**Cache-Aside Pattern (User Profile):**
```javascript
class UserCache {
  constructor(redis, db) {
    this.redis = redis
    this.db = db
    this.TTL = 3600 // 1 hour
  }

  async getUser(userId) {
    const cacheKey = `user:${userId}`

    // Try cache first
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }

    // Cache miss: fetch from DB
    const result = await this.db.query(
      'SELECT id, name, avatar_url, created_at FROM users WHERE id = $1',
      [userId]
    )

    if (result.rows.length === 0) {
      return null
    }

    const user = result.rows[0]

    // Store in cache
    await this.redis.setex(cacheKey, this.TTL, JSON.stringify(user))

    return user
  }

  async invalidateUser(userId) {
    await this.redis.del(`user:${userId}`)
    // Publish invalidation for other instances
    await this.redis.publish('cache:invalidate', JSON.stringify({
      type: 'user',
      id: userId
    }))
  }
}
```

**Write-Through Pattern (Presence):**
```javascript
class PresenceManager {
  constructor(redis) {
    this.redis = redis
    this.TTL = 60 // 60 seconds
  }

  async setOnline(userId, deviceId) {
    const key = `presence:${userId}`
    const deviceKey = `presence:${userId}:devices`

    // Write to cache immediately (no DB for presence - ephemeral data)
    await this.redis
      .multi()
      .hset(key, 'status', 'online', 'lastSeen', Date.now())
      .expire(key, this.TTL)
      .sadd(deviceKey, deviceId)
      .expire(deviceKey, this.TTL)
      .exec()

    return { status: 'online' }
  }

  async heartbeat(userId, deviceId) {
    const key = `presence:${userId}`
    const deviceKey = `presence:${userId}:devices`

    // Refresh TTL on heartbeat
    await this.redis
      .multi()
      .hset(key, 'lastSeen', Date.now())
      .expire(key, this.TTL)
      .expire(deviceKey, this.TTL)
      .exec()
  }

  async getOnlineContacts(userId) {
    const contacts = await this.db.query(
      'SELECT contact_id FROM contacts WHERE user_id = $1',
      [userId]
    )

    const pipeline = this.redis.pipeline()
    for (const { contact_id } of contacts.rows) {
      pipeline.hgetall(`presence:${contact_id}`)
    }

    const results = await pipeline.exec()
    return contacts.rows.map((c, i) => ({
      userId: c.contact_id,
      ...results[i][1]
    })).filter(c => c.status === 'online')
  }
}
```

**TURN Credential Caching:**
```javascript
class TURNCredentialService {
  constructor(redis, turnSecret) {
    this.redis = redis
    this.turnSecret = turnSecret
    this.TTL = 300 // 5 minutes - credentials are short-lived for security
  }

  async getCredentials(userId) {
    const cacheKey = `turn:${userId}`

    // Check cache
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }

    // Generate time-limited TURN credentials (RFC 5389)
    const timestamp = Math.floor(Date.now() / 1000) + this.TTL
    const username = `${timestamp}:${userId}`
    const credential = crypto
      .createHmac('sha1', this.turnSecret)
      .update(username)
      .digest('base64')

    const credentials = {
      username,
      credential,
      urls: [
        'turn:localhost:3478?transport=udp',
        'turn:localhost:3478?transport=tcp'
      ],
      ttl: this.TTL
    }

    // Cache with same TTL as credential validity
    await this.redis.setex(cacheKey, this.TTL - 30, JSON.stringify(credentials))

    return credentials
  }
}
```

### Cache Invalidation Rules

**Event-Driven Invalidation via Redis Pub/Sub:**
```javascript
class CacheInvalidator {
  constructor(redis, caches) {
    this.redis = redis
    this.caches = caches

    // Subscribe to invalidation channel
    this.subscriber = redis.duplicate()
    this.subscriber.subscribe('cache:invalidate')
    this.subscriber.on('message', (channel, message) => {
      this.handleInvalidation(JSON.parse(message))
    })
  }

  async handleInvalidation({ type, id, action }) {
    switch (type) {
      case 'user':
        await this.caches.user.invalidate(id)
        break
      case 'call':
        await this.redis.del(`call:${id}`)
        break
      case 'device':
        await this.redis.del(`devices:${id}`)
        break
    }
  }

  // Triggered by application code after DB writes
  async publishInvalidation(type, id) {
    await this.redis.publish('cache:invalidate', JSON.stringify({ type, id }))
  }
}
```

### Local Development Configuration

**docker-compose.yml additions for caching:**
```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --maxmemory 100mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
```

**Environment variables:**
```bash
REDIS_URL=redis://localhost:6379
CACHE_USER_TTL=3600
CACHE_PRESENCE_TTL=60
CACHE_TURN_CREDENTIAL_TTL=300
```

---

## Observability

### Metrics, Logs, and Traces Stack

For local development, we use a lightweight observability stack:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Application Services                        │
│     (Signaling Server, TURN Server, API Server)                │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
   Prometheus            Structured JSON         OpenTelemetry
    Metrics                  Logs                  Traces
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   Prometheus  │    │    stdout     │    │    Jaeger     │
│   :9090       │    │  (piped to    │    │   :16686      │
│               │    │   file/loki)  │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                      ┌───────────────┐
                      │    Grafana    │
                      │    :3000      │
                      └───────────────┘
```

### Key Metrics (Prometheus)

**Signaling Service Metrics:**
```javascript
const promClient = require('prom-client')

// Call metrics
const callsInitiated = new promClient.Counter({
  name: 'facetime_calls_initiated_total',
  help: 'Total number of calls initiated',
  labelNames: ['call_type'] // 'video', 'audio', 'group'
})

const callsAnswered = new promClient.Counter({
  name: 'facetime_calls_answered_total',
  help: 'Total number of calls answered',
  labelNames: ['call_type']
})

const callDuration = new promClient.Histogram({
  name: 'facetime_call_duration_seconds',
  help: 'Duration of completed calls in seconds',
  labelNames: ['call_type'],
  buckets: [30, 60, 120, 300, 600, 1800, 3600] // 30s to 1h
})

const callSetupLatency = new promClient.Histogram({
  name: 'facetime_call_setup_latency_seconds',
  help: 'Time from initiation to connection',
  labelNames: ['call_type'],
  buckets: [0.5, 1, 2, 5, 10, 30] // 500ms to 30s
})

// Connection metrics
const activeConnections = new promClient.Gauge({
  name: 'facetime_active_websocket_connections',
  help: 'Current number of active WebSocket connections'
})

const activeCalls = new promClient.Gauge({
  name: 'facetime_active_calls',
  help: 'Current number of active calls',
  labelNames: ['call_type']
})

// ICE/TURN metrics
const iceConnectionType = new promClient.Counter({
  name: 'facetime_ice_connection_type_total',
  help: 'ICE connection types used',
  labelNames: ['type'] // 'host', 'srflx', 'relay'
})

const turnBandwidth = new promClient.Counter({
  name: 'facetime_turn_bytes_total',
  help: 'Total bytes relayed through TURN',
  labelNames: ['direction'] // 'in', 'out'
})

// Error metrics
const signalingErrors = new promClient.Counter({
  name: 'facetime_signaling_errors_total',
  help: 'Signaling errors by type',
  labelNames: ['error_type'] // 'timeout', 'invalid_state', 'connection_failed'
})
```

**Metrics Endpoint:**
```javascript
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType)
  res.send(await promClient.register.metrics())
})
```

### SLI Dashboard Metrics

| SLI | Metric | Target | Alert Threshold |
|-----|--------|--------|-----------------|
| Call Success Rate | `calls_answered / calls_initiated` | > 95% | < 90% |
| Call Setup Latency (p95) | `call_setup_latency_seconds` | < 3s | > 5s |
| Connection Failure Rate | `ice_connection_failed / ice_attempts` | < 5% | > 10% |
| WebSocket Availability | `ws_connection_errors / ws_connections` | < 1% | > 5% |
| TURN Relay Fallback Rate | `ice_type_relay / ice_total` | < 20% | > 40% |

### Structured Logging

**Log Format (JSON Lines):**
```javascript
const pino = require('pino')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'facetime-signaling',
    version: process.env.APP_VERSION || 'dev'
  }
})

// Request logging middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || uuid()
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path
  })

  const start = Date.now()
  res.on('finish', () => {
    req.log.info({
      statusCode: res.statusCode,
      durationMs: Date.now() - start
    }, 'request completed')
  })

  next()
})

// Call-specific logging
function logCallEvent(callId, event, details = {}) {
  logger.info({
    callId,
    event,
    ...details
  }, `call:${event}`)
}

// Example usage:
logCallEvent(callId, 'initiated', {
  initiator: callerId,
  participants: calleeIds.length,
  callType: 'video'
})

logCallEvent(callId, 'answered', {
  answeredBy: deviceId,
  ringDurationMs: Date.now() - call.createdAt
})

logCallEvent(callId, 'ice_connected', {
  connectionType: 'srflx',
  candidatePairs: 3,
  setupDurationMs: 1234
})
```

### Distributed Tracing (OpenTelemetry)

```javascript
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express')
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg')
const { RedisInstrumentation } = require('@opentelemetry/instrumentation-redis')

const provider = new NodeTracerProvider()
provider.addSpanProcessor(new BatchSpanProcessor(new JaegerExporter({
  endpoint: 'http://localhost:14268/api/traces'
})))
provider.register()

registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new PgInstrumentation(),
    new RedisInstrumentation()
  ]
})

// Custom spans for call flow
const tracer = provider.getTracer('facetime-signaling')

async function initiateCall(callerId, calleeIds, callType) {
  return tracer.startActiveSpan('call.initiate', async (span) => {
    span.setAttribute('call.type', callType)
    span.setAttribute('call.participant_count', calleeIds.length + 1)

    try {
      const callId = uuid()
      span.setAttribute('call.id', callId)

      await tracer.startActiveSpan('call.persist', async (dbSpan) => {
        await db.query('INSERT INTO calls ...')
        dbSpan.end()
      })

      await tracer.startActiveSpan('call.notify_devices', async (notifySpan) => {
        for (const calleeId of calleeIds) {
          notifySpan.addEvent('notifying_user', { userId: calleeId })
          await sendPushNotification(calleeId)
        }
        notifySpan.end()
      })

      span.setStatus({ code: SpanStatusCode.OK })
      return { callId }
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      span.recordException(error)
      throw error
    } finally {
      span.end()
    }
  })
}
```

### Audit Logging

For security-sensitive operations (useful for debugging and compliance):

```javascript
const auditLogger = pino({
  level: 'info',
  base: { type: 'audit' }
})

// Audit log schema
interface AuditEvent {
  timestamp: string
  action: string
  actor: {
    userId: string
    deviceId: string
    ip: string
  }
  resource: {
    type: string
    id: string
  }
  outcome: 'success' | 'failure'
  details?: Record<string, any>
}

function logAudit(event: AuditEvent) {
  auditLogger.info(event, `audit:${event.action}`)
}

// Example audit events
logAudit({
  timestamp: new Date().toISOString(),
  action: 'call.initiated',
  actor: { userId: callerId, deviceId, ip: req.ip },
  resource: { type: 'call', id: callId },
  outcome: 'success',
  details: { callType: 'video', participants: calleeIds }
})

logAudit({
  timestamp: new Date().toISOString(),
  action: 'device.registered',
  actor: { userId, deviceId: newDeviceId, ip: req.ip },
  resource: { type: 'device', id: newDeviceId },
  outcome: 'success',
  details: { deviceType: 'iphone', pushToken: '***' }
})

logAudit({
  timestamp: new Date().toISOString(),
  action: 'call.answer_rejected',
  actor: { userId, deviceId, ip: req.ip },
  resource: { type: 'call', id: callId },
  outcome: 'failure',
  details: { reason: 'already_answered', answeredBy: otherDeviceId }
})
```

### Alert Thresholds

**Prometheus Alerting Rules (prometheus/alerts.yml):**
```yaml
groups:
  - name: facetime-alerts
    rules:
      # Call success rate too low
      - alert: LowCallSuccessRate
        expr: |
          (sum(rate(facetime_calls_answered_total[5m])) /
           sum(rate(facetime_calls_initiated_total[5m]))) < 0.90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Call success rate below 90%"
          description: "Only {{ $value | humanizePercentage }} of calls are being answered"

      # Call setup latency too high
      - alert: HighCallSetupLatency
        expr: |
          histogram_quantile(0.95, rate(facetime_call_setup_latency_seconds_bucket[5m])) > 5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Call setup latency p95 exceeds 5 seconds"
          description: "p95 call setup latency is {{ $value | humanizeDuration }}"

      # Too many TURN relay connections
      - alert: HighTURNRelayRate
        expr: |
          (sum(rate(facetime_ice_connection_type_total{type="relay"}[10m])) /
           sum(rate(facetime_ice_connection_type_total[10m]))) > 0.40
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "TURN relay rate exceeds 40%"
          description: "{{ $value | humanizePercentage }} of connections using TURN relay"

      # WebSocket connection errors
      - alert: HighWebSocketErrorRate
        expr: |
          rate(facetime_signaling_errors_total{error_type="connection_failed"}[5m]) > 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High WebSocket connection failure rate"
          description: "{{ $value }} connection failures per second"

      # No active calls (potential outage)
      - alert: NoActiveCalls
        expr: sum(facetime_active_calls) == 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "No active calls for 15 minutes"
          description: "This may indicate a signaling or connectivity issue"
```

### Local Development Observability Setup

**docker-compose.yml additions:**
```yaml
services:
  prometheus:
    image: prom/prometheus:v2.47.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
      - ./prometheus/alerts.yml:/etc/prometheus/alerts.yml
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'

  grafana:
    image: grafana/grafana:10.1.0
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - ./grafana/dashboards:/var/lib/grafana/dashboards
      - ./grafana/provisioning:/etc/grafana/provisioning

  jaeger:
    image: jaegertracing/all-in-one:1.50
    ports:
      - "16686:16686"  # UI
      - "14268:14268"  # Collector HTTP
    environment:
      - COLLECTOR_OTLP_ENABLED=true
```

**prometheus/prometheus.yml:**
```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'signaling-server'
    static_configs:
      - targets: ['host.docker.internal:4000']

  - job_name: 'turn-server'
    static_configs:
      - targets: ['coturn:9641']

rule_files:
  - /etc/prometheus/alerts.yml
```

---

## Implementation Notes

This section documents the key implementation decisions and their rationale based on the Codex review feedback.

### Why Idempotency Prevents Duplicate Call Initiations

**Problem:** Network retries, mobile app reconnects, and race conditions can cause the same call initiation request to arrive at the server multiple times. Without idempotency, each request creates a new call, resulting in:
- Multiple ringing notifications to the callee
- Confusing UI state with multiple incoming call dialogs
- Wasted database and Redis resources
- Poor user experience

**Solution:** The signaling server implements idempotency using Redis with a 5-minute TTL:

```typescript
// Client sends: X-Idempotency-Key header (UUID generated once per call attempt)
// Server flow:
1. Check Redis: idempotency:call:{key} -> existingCallId?
2. If exists: Return existing call (deduplicated: true)
3. If not: Store key -> callId BEFORE creating call
4. Create call in database
5. Return new call

// Key insight: Store idempotency mapping BEFORE the write
// This ensures crash-safety: if we crash after Redis write but before
// DB write, retry will find the key but no call exists (acceptable)
// versus crash after DB write: retry creates duplicate (bad)
```

**Implementation files:**
- `/backend/src/shared/idempotency.ts` - Idempotency key checking and storage
- `/backend/src/services/signaling.ts` - Integration in `handleCallInitiate()`

### Why Presence Caching Enables Fast Call Routing

**Problem:** When initiating a call, the server must determine which devices are online to receive the ring notification. Querying PostgreSQL for every call initiation adds:
- 5-20ms latency per device lookup
- Database load during peak calling hours
- Potential timeout if database is slow

**Solution:** Write-through caching in Redis for user presence with 60-second TTL:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────>│   Redis     │────>│ PostgreSQL  │
│  Heartbeat  │     │  (60s TTL)  │     │  (eventual) │
└─────────────┘     └─────────────┘     └─────────────┘
                          │
                          │ < 1ms lookup
                          ▼
                    ┌─────────────┐
                    │ Call Router │
                    └─────────────┘
```

**Key design decisions:**
- **Write-through:** Presence updates go to Redis immediately (not cache-aside)
- **60-second TTL:** Matches heartbeat interval; stale presence auto-expires
- **Heartbeat refresh:** Each ping extends TTL without updating lastSeen timestamp
- **No database for presence:** Presence is ephemeral; PostgreSQL only stores device metadata

**Implementation files:**
- `/backend/src/shared/cache.ts` - `updatePresence()`, `getUserDevicePresence()`, `refreshPresenceTTL()`
- `/backend/src/services/signaling.ts` - Integration in `handleRegister()` and heartbeat handler

### Why Call Quality Metrics Enable Codec Optimization

**Problem:** WebRTC can use multiple codecs (VP8, H.264, AV1) with different trade-offs:
- VP8: Universal support, moderate quality
- H.264: Hardware acceleration, good quality
- AV1: Best compression, limited hardware support

Without metrics, we cannot know:
- Which codec performs best for our user base
- What network conditions users experience
- When to recommend simulcast vs single stream

**Solution:** Prometheus metrics for call quality indicators:

| Metric | Purpose | Optimization Action |
|--------|---------|---------------------|
| `call_setup_latency_seconds` | Time to connect | Optimize ICE candidate gathering |
| `call_duration_seconds` | Engagement indicator | Identify quality issues causing early drops |
| `ice_connection_type_total` | NAT traversal success | Tune STUN/TURN server selection |
| `signaling_latency_seconds` | Server processing time | Identify bottlenecks |

**Example optimization loop:**
```
1. Observe: p95 call_setup_latency > 5s
2. Investigate: High ice_connection_type{type="relay"} rate
3. Hypothesis: Too many users hitting TURN fallback
4. Action: Add STUN servers in user's region
5. Verify: call_setup_latency decreases
```

**Implementation files:**
- `/backend/src/shared/metrics.ts` - Prometheus metric definitions
- `/backend/src/services/signaling.ts` - Metric instrumentation points
- `/backend/src/index.ts` - `/metrics` endpoint for Prometheus scraping

### Why Circuit Breakers Protect Signaling Infrastructure

**Problem:** The signaling server depends on PostgreSQL and Redis. If either becomes slow or unavailable:
- WebSocket handlers block waiting for timeout
- Thread pool exhaustion occurs
- All users experience failures (cascade failure)
- Recovery is slow even after dependency recovers

**Solution:** Circuit breaker pattern using opossum library:

```
Normal Operation (Circuit CLOSED):
  Request ──> Database ──> Response
                 │
                 └── Track success/failure rate

Error Threshold Exceeded (Circuit OPEN):
  Request ──> FAIL FAST ──> Fallback Response
                 │
                 └── No database call (prevents cascade)

Recovery Attempt (Circuit HALF-OPEN):
  Request ──> Database ──> If success, close circuit
                 │
                 └── Limited requests to test recovery
```

**Configuration for signaling:**
```typescript
{
  timeout: 3000,              // 3s max per operation
  errorThresholdPercentage: 50,  // Open at 50% error rate
  resetTimeout: 10000,        // Try recovery after 10s
  volumeThreshold: 5          // Need 5 requests before tripping
}
```

**Protected operations:**
- `db-user-lookup`: User verification during registration
- `db-call-create`: Call record creation
- `db-participant-add`: Adding participants to calls
- `db-device-upsert`: Device registration updates
- `db-device-offline`: Device offline status updates

**Fallback behavior:**
- User lookup: Return cached profile if available, else error
- Device updates: Fire-and-forget (log error, continue)
- Call creation: Error to client (no fallback for writes)

**Implementation files:**
- `/backend/src/shared/circuit-breaker.ts` - Circuit breaker factory and helpers
- `/backend/src/services/signaling.ts` - `withCircuitBreaker()` usage
- `/backend/src/index.ts` - Circuit breaker state in `/health` endpoint

### Shared Module Architecture

The implementation adds these shared modules under `/backend/src/shared/`:

```
shared/
├── logger.ts         # Pino structured logging with request context
├── metrics.ts        # Prometheus metrics for observability
├── cache.ts          # Redis caching with TTL management
├── circuit-breaker.ts # Opossum circuit breaker wrapper
└── idempotency.ts    # Idempotency key handling for call initiation
```

**Design principles:**
1. **Separation of concerns:** Each module handles one aspect
2. **Consistent interfaces:** All modules export typed functions
3. **Fail-open where safe:** Caching failures don't block operations
4. **Metrics everywhere:** Each module tracks its own metrics

### New API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /metrics` | Prometheus metrics for scraping |
| `GET /health` | Detailed health check with dependency status |
| `GET /health/live` | Simple liveness probe for orchestrators |
| `GET /health/ready` | Readiness probe checking dependencies |

### Environment Variables

```bash
# Logging
LOG_LEVEL=info              # pino log level (trace, debug, info, warn, error)
APP_VERSION=dev             # Version tag for logs

# Cache TTLs (seconds)
CACHE_USER_TTL=3600         # User profile cache (1 hour)
CACHE_PRESENCE_TTL=60       # Presence cache (60 seconds)
CACHE_TURN_CREDENTIAL_TTL=300  # TURN credentials (5 minutes)
CACHE_IDEMPOTENCY_TTL=300   # Idempotency keys (5 minutes)
```

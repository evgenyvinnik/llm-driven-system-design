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

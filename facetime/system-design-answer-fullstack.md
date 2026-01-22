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

## Deep Dive: Signaling Protocol (8 minutes)

### WebSocket Message Schema

```typescript
// shared/types.ts - Shared between frontend and backend
type SignalingMessage =
  | { type: 'register'; payload: { deviceId: string } }
  | { type: 'initiate_call'; payload: { calleeId: string; callType: 'video' | 'audio' }; idempotencyKey: string }
  | { type: 'ring'; callId: string; payload: { caller: UserInfo; callType: 'video' | 'audio' } }
  | { type: 'answer_call'; callId: string; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'call_answered'; callId: string; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'decline_call'; callId: string }
  | { type: 'ice_candidate'; callId: string; payload: { candidate: RTCIceCandidateInit } }
  | { type: 'end_call'; callId: string }
  | { type: 'call_ended'; callId: string; payload: { reason: string } }
  | { type: 'offer'; callId: string; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'error'; payload: { code: string; message: string } }

interface UserInfo {
  id: string
  name: string
  avatarUrl: string
}
```

### Backend: WebSocket Handler

```typescript
// backend/src/signaling/websocket.ts
import { WebSocketServer, WebSocket } from 'ws'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'

interface Connection {
  ws: WebSocket
  userId: string
  deviceId: string
}

class SignalingServer {
  private connections = new Map<string, Connection>()  // deviceId -> Connection
  private userDevices = new Map<string, Set<string>>() // userId -> Set<deviceId>

  constructor(private wss: WebSocketServer) {
    wss.on('connection', (ws, req) => this.handleConnection(ws, req))
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage) {
    const userId = this.extractUserId(req)
    if (!userId) {
      ws.close(4001, 'Unauthorized')
      return
    }

    let deviceId: string | null = null

    ws.on('message', async (data) => {
      try {
        const message: SignalingMessage = JSON.parse(data.toString())

        switch (message.type) {
          case 'register':
            deviceId = message.payload.deviceId
            await this.handleRegister(ws, userId, deviceId)
            break

          case 'initiate_call':
            await this.handleInitiateCall(
              userId,
              deviceId!,
              message.payload.calleeId,
              message.payload.callType,
              message.idempotencyKey
            )
            break

          case 'answer_call':
            await this.handleAnswerCall(
              message.callId,
              userId,
              deviceId!,
              message.payload.sdp
            )
            break

          case 'decline_call':
            await this.handleDeclineCall(message.callId, userId, deviceId!)
            break

          case 'ice_candidate':
            await this.handleIceCandidate(
              message.callId,
              deviceId!,
              message.payload.candidate
            )
            break

          case 'end_call':
            await this.handleEndCall(message.callId, userId)
            break
        }
      } catch (error) {
        this.sendToDevice(deviceId!, {
          type: 'error',
          payload: { code: 'INVALID_MESSAGE', message: error.message }
        })
      }
    })

    ws.on('close', () => {
      if (deviceId) {
        this.handleDisconnect(userId, deviceId)
      }
    })
  }

  private async handleRegister(ws: WebSocket, userId: string, deviceId: string) {
    // Store connection
    this.connections.set(deviceId, { ws, userId, deviceId })

    // Track user's devices
    if (!this.userDevices.has(userId)) {
      this.userDevices.set(userId, new Set())
    }
    this.userDevices.get(userId)!.add(deviceId)

    // Update presence in Redis (60s TTL)
    await redis.setex(`presence:${userId}:${deviceId}`, 60, 'online')
    await redis.sadd(`devices:${userId}`, deviceId)
    await redis.expire(`devices:${userId}`, 60)

    console.log(`Device ${deviceId} registered for user ${userId}`)
  }

  private async handleInitiateCall(
    callerId: string,
    callerDeviceId: string,
    calleeId: string,
    callType: 'video' | 'audio',
    idempotencyKey: string
  ) {
    // Idempotency check
    const existingCallId = await redis.get(`idempotency:${idempotencyKey}`)
    if (existingCallId) {
      // Return existing call state
      return
    }

    const callId = crypto.randomUUID()

    // Store idempotency key first
    await redis.setex(`idempotency:${idempotencyKey}`, 300, callId)

    // Create call in database
    await pool.query(`
      INSERT INTO calls (id, initiator_id, call_type, state, created_at)
      VALUES ($1, $2, $3, 'ringing', NOW())
    `, [callId, callerId, callType])

    // Get callee's online devices
    const calleeDevices = await redis.smembers(`devices:${calleeId}`)

    // Get caller info for display
    const callerResult = await pool.query(
      'SELECT id, name, avatar_url FROM users WHERE id = $1',
      [callerId]
    )
    const caller = callerResult.rows[0]

    // Ring all callee devices
    for (const deviceId of calleeDevices) {
      this.sendToDevice(deviceId, {
        type: 'ring',
        callId,
        payload: {
          caller: {
            id: caller.id,
            name: caller.name,
            avatarUrl: caller.avatar_url
          },
          callType
        }
      })
    }

    // Store call state in Redis for quick access
    await redis.hset(`call:${callId}`, {
      initiatorId: callerId,
      initiatorDevice: callerDeviceId,
      calleeId,
      callType,
      state: 'ringing'
    })
    await redis.expire(`call:${callId}`, 300)  // 5 min TTL

    // Set ring timeout (30 seconds)
    setTimeout(() => this.handleRingTimeout(callId), 30000)
  }

  private async handleAnswerCall(
    callId: string,
    userId: string,
    deviceId: string,
    sdp: RTCSessionDescriptionInit
  ) {
    // Atomic state transition - first device to answer wins
    const result = await pool.query(`
      UPDATE calls
      SET state = 'connected', answered_by = $2, connected_at = NOW()
      WHERE id = $1 AND state = 'ringing'
      RETURNING initiator_id
    `, [callId, deviceId])

    if (result.rowCount === 0) {
      // Call already answered or cancelled
      this.sendToDevice(deviceId, {
        type: 'error',
        payload: { code: 'CALL_UNAVAILABLE', message: 'Call already answered' }
      })
      return
    }

    const initiatorId = result.rows[0].initiator_id

    // Stop ringing on other devices
    const calleeDevices = this.userDevices.get(userId) || new Set()
    for (const otherDevice of calleeDevices) {
      if (otherDevice !== deviceId) {
        this.sendToDevice(otherDevice, {
          type: 'call_ended',
          callId,
          payload: { reason: 'answered_elsewhere' }
        })
      }
    }

    // Update Redis state
    await redis.hset(`call:${callId}`, 'state', 'connected', 'answeredBy', deviceId)

    // Get initiator's device and send answer
    const callState = await redis.hgetall(`call:${callId}`)
    const initiatorDevice = callState.initiatorDevice

    this.sendToDevice(initiatorDevice, {
      type: 'call_answered',
      callId,
      payload: { sdp }
    })
  }

  private async handleIceCandidate(
    callId: string,
    fromDeviceId: string,
    candidate: RTCIceCandidateInit
  ) {
    // Deduplicate ICE candidates
    const candidateHash = crypto
      .createHash('sha256')
      .update(`${callId}:${fromDeviceId}:${JSON.stringify(candidate)}`)
      .digest('hex')
      .slice(0, 16)

    const isNew = await redis.setnx(`ice:${callId}:${candidateHash}`, '1')
    if (!isNew) return  // Duplicate, ignore

    await redis.expire(`ice:${callId}:${candidateHash}`, 300)

    // Get the other device in the call
    const callState = await redis.hgetall(`call:${callId}`)
    const targetDevice = fromDeviceId === callState.initiatorDevice
      ? callState.answeredBy
      : callState.initiatorDevice

    if (targetDevice) {
      this.sendToDevice(targetDevice, {
        type: 'ice_candidate',
        callId,
        payload: { candidate }
      })
    }
  }

  private async handleEndCall(callId: string, userId: string) {
    // Update database
    await pool.query(`
      UPDATE calls SET state = 'ended', ended_at = NOW()
      WHERE id = $1
    `, [callId])

    // Get call participants
    const callState = await redis.hgetall(`call:${callId}`)

    // Notify all participants
    const devices = [callState.initiatorDevice, callState.answeredBy].filter(Boolean)
    for (const deviceId of devices) {
      this.sendToDevice(deviceId, {
        type: 'call_ended',
        callId,
        payload: { reason: 'ended' }
      })
    }

    // Clean up Redis
    await redis.del(`call:${callId}`)
  }

  private sendToDevice(deviceId: string, message: SignalingMessage) {
    const connection = this.connections.get(deviceId)
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify(message))
    }
  }

  private async handleRingTimeout(callId: string) {
    const result = await pool.query(`
      UPDATE calls SET state = 'missed', ended_at = NOW()
      WHERE id = $1 AND state = 'ringing'
      RETURNING initiator_id
    `, [callId])

    if (result.rowCount > 0) {
      // Notify caller that call was missed
      const callState = await redis.hgetall(`call:${callId}`)
      this.sendToDevice(callState.initiatorDevice, {
        type: 'call_ended',
        callId,
        payload: { reason: 'no_answer' }
      })
    }
  }

  private handleDisconnect(userId: string, deviceId: string) {
    this.connections.delete(deviceId)
    this.userDevices.get(userId)?.delete(deviceId)

    // Update Redis
    redis.srem(`devices:${userId}`, deviceId)
    redis.del(`presence:${userId}:${deviceId}`)
  }
}
```

## Deep Dive: Frontend Integration (7 minutes)

### Signaling Client Hook

```typescript
// frontend/src/hooks/useSignaling.ts
import { useEffect, useRef, useCallback } from 'react'
import { useCallStore } from '../stores/callStore'

export function useSignaling() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number>()
  const webRTCRef = useRef<ReturnType<typeof useWebRTC> | null>(null)

  const {
    setCallState,
    receiveIncomingCall,
    setCallConnected,
    endCall,
    addRemoteStream
  } = useCallStore()

  const connect = useCallback(() => {
    const deviceId = localStorage.getItem('deviceId') || crypto.randomUUID()
    localStorage.setItem('deviceId', deviceId)

    const ws = new WebSocket(`wss://${window.location.host}/signaling`)
    wsRef.current = ws

    ws.onopen = () => {
      // Register this device
      ws.send(JSON.stringify({
        type: 'register',
        payload: { deviceId }
      }))
    }

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data)
      await handleMessage(message)
    }

    ws.onclose = () => {
      // Reconnect after 1 second
      reconnectTimeoutRef.current = window.setTimeout(connect, 1000)
    }
  }, [])

  const handleMessage = async (message: SignalingMessage) => {
    switch (message.type) {
      case 'ring':
        // Show incoming call UI
        receiveIncomingCall({
          callId: message.callId,
          caller: message.payload.caller,
          callType: message.payload.callType
        })
        break

      case 'offer':
        // Create answer for incoming call
        if (webRTCRef.current) {
          const answer = await webRTCRef.current.createAnswer(message.payload.sdp)
          sendMessage({
            type: 'answer_call',
            callId: message.callId,
            payload: { sdp: answer }
          })
        }
        break

      case 'call_answered':
        // Set remote description from answer
        if (webRTCRef.current) {
          await webRTCRef.current.handleAnswer(message.payload.sdp)
        }
        setCallConnected()
        break

      case 'ice_candidate':
        // Add ICE candidate from peer
        if (webRTCRef.current) {
          await webRTCRef.current.addIceCandidate(message.payload.candidate)
        }
        break

      case 'call_ended':
        endCall()
        break

      case 'error':
        console.error('Signaling error:', message.payload)
        break
    }
  }

  const sendMessage = useCallback((message: SignalingMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    }
  }, [])

  const initiateCall = useCallback(async (calleeId: string, callType: 'video' | 'audio') => {
    const idempotencyKey = crypto.randomUUID()

    setCallState('outgoing')

    sendMessage({
      type: 'initiate_call',
      payload: { calleeId, callType },
      idempotencyKey
    })
  }, [sendMessage, setCallState])

  const answerCall = useCallback(async (callId: string) => {
    if (!webRTCRef.current) return

    // Create offer first
    const offer = await webRTCRef.current.createOffer()

    sendMessage({
      type: 'answer_call',
      callId,
      payload: { sdp: offer }
    })
  }, [sendMessage])

  const declineCall = useCallback((callId: string) => {
    sendMessage({
      type: 'decline_call',
      callId
    })
  }, [sendMessage])

  const hangup = useCallback((callId: string) => {
    sendMessage({
      type: 'end_call',
      callId
    })
    webRTCRef.current?.hangup()
  }, [sendMessage])

  const sendIceCandidate = useCallback((callId: string, candidate: RTCIceCandidate) => {
    sendMessage({
      type: 'ice_candidate',
      callId,
      payload: { candidate: candidate.toJSON() }
    })
  }, [sendMessage])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  return {
    initiateCall,
    answerCall,
    declineCall,
    hangup,
    sendIceCandidate,
    setWebRTCRef: (ref: ReturnType<typeof useWebRTC>) => {
      webRTCRef.current = ref
    }
  }
}
```

### Call Flow Orchestration

```typescript
// frontend/src/components/CallManager.tsx
function CallManager() {
  const { callState, currentCallId, incomingCall } = useCallStore()
  const { answerCall, declineCall, hangup, sendIceCandidate, setWebRTCRef } = useSignaling()

  // Initialize WebRTC when in a call
  const webRTC = useWebRTC({
    callId: currentCallId,
    isInitiator: callState === 'outgoing',
    onRemoteStream: (stream) => {
      useCallStore.getState().addRemoteStream('remote', stream)
    },
    onConnectionStateChange: (state) => {
      if (state === 'connected') {
        useCallStore.getState().setCallConnected()
      } else if (state === 'failed' || state === 'disconnected') {
        useCallStore.getState().updateConnectionQuality('disconnected')
      }
    },
    onIceCandidate: (candidate) => {
      if (currentCallId) {
        sendIceCandidate(currentCallId, candidate)
      }
    }
  })

  // Connect signaling to WebRTC
  useEffect(() => {
    setWebRTCRef(webRTC)
  }, [webRTC, setWebRTCRef])

  // Handle answer button click
  const handleAnswer = async () => {
    if (incomingCall) {
      useCallStore.getState().answerCall()
      await answerCall(incomingCall.callId)
    }
  }

  const handleDecline = () => {
    if (incomingCall) {
      declineCall(incomingCall.callId)
      useCallStore.getState().declineCall()
    }
  }

  const handleHangup = () => {
    if (currentCallId) {
      hangup(currentCallId)
    }
  }

  return (
    <>
      {incomingCall && (
        <IncomingCallOverlay
          caller={incomingCall.caller}
          callType={incomingCall.callType}
          onAnswer={handleAnswer}
          onDecline={handleDecline}
        />
      )}

      {(callState === 'connecting' || callState === 'connected') && (
        <ActiveCallView
          localStream={webRTC.localStream}
          onHangup={handleHangup}
          onToggleMute={webRTC.toggleMute}
          onToggleVideo={webRTC.toggleVideo}
        />
      )}
    </>
  )
}
```

## Deep Dive: TURN Credential Flow (5 minutes)

### Backend: TURN Credential Endpoint

```typescript
// backend/src/routes/turn.ts
import { Router } from 'express'
import crypto from 'crypto'
import { requireAuth } from '../shared/auth.js'

const router = Router()

// TURN secret shared with Coturn server
const TURN_SECRET = process.env.TURN_SECRET || 'turnserver'
const TURN_TTL = 300  // 5 minutes

router.get('/credentials', requireAuth, (req, res) => {
  const userId = req.session.userId
  const timestamp = Math.floor(Date.now() / 1000) + TURN_TTL

  // Username format: timestamp:userId (per RFC 5389)
  const username = `${timestamp}:${userId}`

  // HMAC-SHA1 of username with shared secret
  const credential = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64')

  res.json({
    urls: [
      `turn:${process.env.TURN_HOST || 'localhost'}:3478?transport=udp`,
      `turn:${process.env.TURN_HOST || 'localhost'}:3478?transport=tcp`
    ],
    username,
    credential,
    ttl: TURN_TTL
  })
})

export default router
```

### Frontend: ICE Server Configuration

```typescript
// frontend/src/hooks/useWebRTC.ts (updated)
async function getIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch('/api/turn/credentials', {
      credentials: 'include'
    })

    if (!response.ok) {
      throw new Error('Failed to get TURN credentials')
    }

    const turn = await response.json()

    return [
      // STUN server (free, for NAT discovery)
      { urls: 'stun:stun.l.google.com:19302' },
      // TURN server (relay fallback)
      {
        urls: turn.urls,
        username: turn.username,
        credential: turn.credential
      }
    ]
  } catch (error) {
    console.warn('TURN credentials unavailable, using STUN only')
    return [{ urls: 'stun:stun.l.google.com:19302' }]
  }
}
```

## Deep Dive: Call History API (5 minutes)

### Backend: Call History Endpoint

```typescript
// backend/src/routes/calls.ts
import { Router } from 'express'
import { pool } from '../shared/db.js'
import { requireAuth } from '../shared/auth.js'

const router = Router()

// Get recent calls for the authenticated user
router.get('/history', requireAuth, async (req, res) => {
  const userId = req.session.userId
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
  const offset = parseInt(req.query.offset as string) || 0

  const result = await pool.query(`
    SELECT
      c.id,
      c.call_type,
      c.state,
      c.created_at,
      c.connected_at,
      c.ended_at,
      CASE
        WHEN c.initiator_id = $1 THEN 'outgoing'
        ELSE 'incoming'
      END as direction,
      CASE
        WHEN c.initiator_id = $1 THEN
          (SELECT row_to_json(u) FROM (
            SELECT id, name, avatar_url
            FROM users
            WHERE id = (SELECT user_id FROM call_participants WHERE call_id = c.id AND user_id != $1 LIMIT 1)
          ) u)
        ELSE
          (SELECT row_to_json(u) FROM (SELECT id, name, avatar_url FROM users WHERE id = c.initiator_id) u)
      END as other_party,
      CASE
        WHEN c.ended_at IS NOT NULL AND c.connected_at IS NOT NULL THEN
          EXTRACT(EPOCH FROM (c.ended_at - c.connected_at))::int
        ELSE NULL
      END as duration_seconds
    FROM calls c
    WHERE c.initiator_id = $1
       OR EXISTS (SELECT 1 FROM call_participants WHERE call_id = c.id AND user_id = $1)
    ORDER BY c.created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset])

  res.json({
    calls: result.rows,
    pagination: {
      limit,
      offset,
      hasMore: result.rows.length === limit
    }
  })
})

// Get single call details
router.get('/:callId', requireAuth, async (req, res) => {
  const { callId } = req.params
  const userId = req.session.userId

  const result = await pool.query(`
    SELECT
      c.*,
      json_agg(json_build_object(
        'userId', cp.user_id,
        'deviceId', cp.device_id,
        'state', cp.state,
        'joinedAt', cp.joined_at,
        'leftAt', cp.left_at
      )) as participants
    FROM calls c
    LEFT JOIN call_participants cp ON cp.call_id = c.id
    WHERE c.id = $1
      AND (c.initiator_id = $2 OR EXISTS (
        SELECT 1 FROM call_participants WHERE call_id = c.id AND user_id = $2
      ))
    GROUP BY c.id
  `, [callId, userId])

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Call not found' })
  }

  res.json(result.rows[0])
})

export default router
```

### Frontend: Call History Component

```typescript
// frontend/src/components/CallHistory.tsx
function CallHistory() {
  const [calls, setCalls] = useState<Call[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/calls/history', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setCalls(data.calls)
        setLoading(false)
      })
  }, [])

  if (loading) {
    return <div className="p-4">Loading...</div>
  }

  return (
    <div className="divide-y">
      {calls.map(call => (
        <CallHistoryItem key={call.id} call={call} />
      ))}
    </div>
  )
}

function CallHistoryItem({ call }: { call: Call }) {
  const isOutgoing = call.direction === 'outgoing'
  const isMissed = call.state === 'missed' || call.state === 'declined'

  return (
    <div className="flex items-center gap-3 p-4 hover:bg-gray-50">
      <img
        src={call.other_party.avatar_url}
        alt=""
        className="w-12 h-12 rounded-full"
      />
      <div className="flex-1">
        <div className="font-medium">{call.other_party.name}</div>
        <div className={`text-sm ${isMissed ? 'text-red-500' : 'text-gray-500'}`}>
          {isOutgoing ? (
            <ArrowUpRightIcon className="w-4 h-4 inline" />
          ) : (
            <ArrowDownLeftIcon className="w-4 h-4 inline" />
          )}
          {' '}
          {call.call_type === 'video' ? 'Video' : 'Audio'}
          {isMissed && ' (Missed)'}
          {call.duration_seconds && ` - ${formatDuration(call.duration_seconds)}`}
        </div>
      </div>
      <div className="text-sm text-gray-400">
        {formatRelativeTime(call.created_at)}
      </div>
      <button
        onClick={() => initiateCall(call.other_party.id, call.call_type)}
        className="p-2 hover:bg-gray-100 rounded-full"
      >
        <PhoneIcon className="w-5 h-5 text-green-600" />
      </button>
    </div>
  )
}
```

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

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE calls (
  id UUID PRIMARY KEY,
  initiator_id UUID NOT NULL REFERENCES users(id),
  call_type VARCHAR(10) NOT NULL CHECK (call_type IN ('video', 'audio')),
  state VARCHAR(20) NOT NULL CHECK (state IN ('ringing', 'connected', 'ended', 'missed', 'declined', 'cancelled')),
  answered_by VARCHAR(100),  -- device_id
  created_at TIMESTAMP DEFAULT NOW(),
  connected_at TIMESTAMP,
  ended_at TIMESTAMP
);

CREATE TABLE call_participants (
  call_id UUID REFERENCES calls(id),
  user_id UUID NOT NULL REFERENCES users(id),
  device_id VARCHAR(100),
  state VARCHAR(20),
  joined_at TIMESTAMP,
  left_at TIMESTAMP,
  PRIMARY KEY (call_id, user_id, device_id)
);

CREATE INDEX idx_calls_initiator ON calls(initiator_id, created_at DESC);
CREATE INDEX idx_calls_state ON calls(state) WHERE state = 'ringing';
CREATE INDEX idx_participants_user ON call_participants(user_id);
```

## Closing Summary (1 minute)

"The FaceTime full-stack system is built around three integration points:

1. **WebSocket Signaling Protocol** - A typed message schema shared between frontend and backend ensures type safety. The server handles call state transitions atomically in PostgreSQL while using Redis for presence and active call lookup. Idempotency keys prevent duplicate call initiations from network retries.

2. **WebRTC Orchestration** - The frontend's `useWebRTC` hook manages peer connection lifecycle, while `useSignaling` handles message routing. ICE candidates are relayed through the server with deduplication, and TURN credentials are generated with time-limited HMAC signatures.

3. **Multi-device Coordination** - When a call comes in, the server rings all registered devices. The first to answer wins via atomic database update, and other devices receive a 'call_ended' message. This pattern ensures consistent state across all user devices.

The main trade-off is complexity vs. reliability. The server-authoritative model requires more round trips but prevents race conditions that would occur with client-driven state."
